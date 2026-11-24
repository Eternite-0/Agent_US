#!/usr/bin/env node
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { redactSecrets } from '../src/envelope.js';
import { estimateTokens } from '../src/context.js';
import {
  ACI_ARM_PROFILES,
  ACI_GOVERNANCE_BENCHMARK_ID,
  VERSION,
  applyWorkspaceFiles,
  buildAciGovernanceEvidenceOutput,
  computeAciGovernanceMetrics,
  createAciGovernanceDataset,
  exportPaperTablesLatex,
  exportPaperTablesMarkdown,
  getAciGovernanceReferenceFix,
  instantiateAciGovernanceWorkspace,
  normalizeAciProfileName,
  resolveAciTaskGroundTruth,
} from '../src/evaluation/aci-governance-benchmark.js';
import {
  buildAutonomousReasoningEvidenceOutput,
  createAutonomousReasoningDataset,
  getAutonomousReasoningReferenceFix,
  instantiateAutonomousReasoningWorkspace,
  resolveTaskCriticalContextFiles,
} from '../src/evaluation/autonomous-reasoning-benchmark.js';
import { removeFixtureWorkspace } from '../src/evaluation/fixtures.js';
import { authorizeRealBenchmarkApproval, enrichReceiptsWithCommands, extractTurnDiagnosticsFromEvents } from './benchmark-autonomous-reasoning.mjs';
import { BenchmarkSandbox, SANDBOX_MODES, runHardenedGitSync } from '../src/tools/benchmark-sandbox.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const VALID_ARMS = new Set(['A', 'B', 'C', 'D']);
const TRIAL_HEADER_NAME = 'x-agent-us-bench-trial';
const SUPERVISOR_WIRE_MARKER = 'Supervisor for Adaptive Context Intelligence (ACI)';
const TRIAL_FETCH_ALS = new AsyncLocalStorage();
const ACTIVE_FETCH_CAPTURES = new Map();
let baseOriginalFetch = null;

function extractWireMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          return extractWireMessageText(item.text ?? item.content ?? '');
        }
        return '';
      })
      .join('\n');
  }
  if (content && typeof content === 'object') {
    return extractWireMessageText(content.text ?? content.content ?? '');
  }
  return '';
}

export function isAciSupervisorWireRequest(parsedReq) {
  if (!parsedReq || typeof parsedReq !== 'object') return false;
  if (Array.isArray(parsedReq.tools) && parsedReq.tools.length > 0) return false;
  if (extractWireMessageText(parsedReq.system).includes(SUPERVISOR_WIRE_MARKER)) {
    return true;
  }
  const messages = Array.isArray(parsedReq.messages) ? parsedReq.messages : [];
  return messages.some(
    (msg) =>
      (msg?.role === 'system' || msg?.role === 'developer') &&
      extractWireMessageText(msg.content).includes(SUPERVISOR_WIRE_MARKER),
  );
}

function printUsage() {
  console.log([
    'Usage: node backend/scripts/benchmark-aci-governance.mjs [options]',
    '',
    'Options:',
    '  --mode <deterministic|real>         Evaluation mode (default: deterministic)',
    '  --arms <A,B,C,D>                    Comma-separated arms (default: A,B,C,D)',
    '  --suite <aci|aci25|aci26|ar|all>    Dataset suite (default: aci)',
    '  --tasks <all|id1,id2,...>           Task filter (default: all)',
    '  --repeats <n>                       Repeats per task (1..20, default: 1)',
    '  --concurrency <n>                   Concurrent isolated trials 1..16 (default: 1)',
    '  --resume                            Resume existing --output JSONL skipping completed cells',
    '  --lane <idx>                        Worker shard index (default: 0)',
    '  --lanes <count>                     Worker shard count (default: 1)',
    '  --output <path>                     JSONL output path (also writes -summary.json)',
    '  --archive-dir <dir>                 Archive directory for sanitized jsonl/summary/md/tex',
    '  --archive-prefix <name>             Archive filename prefix (default: aci-<suite>-ablation)',
    '  --export-paper <path>               Write Markdown paper tables (or LaTeX if .tex)',
    '  --export-latex <path>               Write LaTeX paper tables',
    '  --aci-profile <full_aci|aci_25|aci_26>  Override Arm D ACI profile label',
    '  --dtoc-policy <policy>              Optional DTOC policy override',
    '  --max-steps <n>                     Override max steps per turn',
    '  --max-tokens <n>                    Override max total tokens per turn',
    '  --dtoc-min-prompt-tokens <n>        Adaptive single-step DTOC min prompt tokens (default: 24000)',
    '  --sandbox <strong|docker|node-permission>  Sandbox mode (default: strong)',
    '  --json                              Print JSON summary to stdout',
    '  --help                              Show this help message',
  ].join('\n'));
}

export function buildSummaryOutputPath(outputPath) {
  if (!outputPath) return null;
  const resolved = resolve(String(outputPath));
  if (/\.jsonl$/i.test(resolved)) return resolved.replace(/\.jsonl$/i, '-summary.json');
  if (/\.json$/i.test(resolved)) return resolved.replace(/\.json$/i, '-summary.json');
  return `${resolved}-summary.json`;
}

export function buildTrialCellKey(taskId, arm, rep = 0) {
  return `${String(taskId ?? '').trim()}::${String(arm ?? 'A').trim().toUpperCase()}::${Number(rep ?? 0)}`;
}

export function loadResumeStateFromJsonl(outputPath) {
  const existingRows = [];
  const completedKeys = new Set();
  let hadCorruptLines = false;
  if (!outputPath || !existsSync(outputPath)) {
    return { existingRows, completedKeys, hadCorruptLines };
  }
  const rawText = readFileSync(outputPath, 'utf8');
  const lines = rawText.split(/\r?\n/);
  const byKey = new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || !parsed.taskId || !parsed.arm) {
        hadCorruptLines = true;
        continue;
      }
      const key = buildTrialCellKey(parsed.taskId, parsed.arm, parsed.rep ?? 0);
      byKey.set(key, parsed);
      completedKeys.add(key);
    } catch {
      hadCorruptLines = true;
    }
  }
  for (const row of byKey.values()) {
    existingRows.push(row);
  }
  return { existingRows, completedKeys, hadCorruptLines };
}

export function resolveArmProfileConfig(
  arm,
  { dtocMinPromptTokens = 24000, aciProfile = null, dtocPolicy = null, suite = 'aci' } = {},
) {
  const key = String(arm || 'A').trim().toUpperCase();
  const profile = ACI_ARM_PROFILES[key];
  if (!profile) {
    throw new Error(`Unsupported arm "${arm}"; expected A, B, C, or D`);
  }
  const cleanProfile = aciProfile ? String(aciProfile).trim() : null;
  const resolvedProfile =
    key === 'D' && cleanProfile && ['full_aci', 'aci_25', 'aci_26', 'aci_31'].includes(cleanProfile)
      ? normalizeAciProfileName(cleanProfile)
      : profile.aciProfile;
  const cleanSuite = String(suite || 'aci').trim().toLowerCase();
  const explicitPolicy = dtocPolicy ? String(dtocPolicy).trim() : null;
  let effectiveDtocPolicy = explicitPolicy;
  if (!effectiveDtocPolicy && key === 'D') {
    if (
      (cleanSuite === 'aci26' || cleanSuite === 'all' || resolvedProfile === 'aci_26') &&
      resolvedProfile !== 'aci_25' &&
      resolvedProfile !== 'aci_31'
    ) {
      effectiveDtocPolicy = 'trajectory_eviction_v26';
    } else if (cleanSuite === 'aci25' || resolvedProfile === 'aci_25') {
      effectiveDtocPolicy = 'phase_watermark_v25';
    }
  }
  const historicalSuite = ['aci', 'aci25', 'aci26', 'all'].includes(cleanSuite);
  return {
    arm: profile.arm,
    aciProfile: resolvedProfile,
    supervisor: key === 'C' || key === 'D',
    aciOptions: {
      dtocMinPromptTokens: Number(dtocMinPromptTokens) || 24000,
      ...(effectiveDtocPolicy ? { dtocPolicy: effectiveDtocPolicy } : {}),
      ...(historicalSuite && key !== 'A' && resolvedProfile !== 'aci_31'
        ? { workingSetReadMaxChars: 0 }
        : {}),
    },
  };
}

export function resolveBenchmarkTaskMaxTokens(task, opts = {}) {
  return opts?.maxTokens ?? task?.resourceBudget?.maxTotalTokens ?? task?.resourceBudget?.maxTokens ?? 160_000;
}

export function mergeSupervisorCostTelemetry(
  rawSupCost = {},
  wireSup = [],
  fallbackCalls = 0,
  opts = {},
) {
  const supervisorDisabled =
    opts === false ||
    opts?.supervisorEnabled === false ||
    opts?.supervisor === false ||
    opts?.disabled === true;
  if (supervisorDisabled) {
    return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0, fallbackCount: 0 };
  }

  const wireList = Array.isArray(wireSup) ? wireSup : [];
  const supInput = wireList.reduce((s, r) => s + (Number(r?.inputTokens ?? 0) || 0), 0);
  const supOutput = wireList.reduce((s, r) => s + (Number(r?.outputTokens ?? 0) || 0), 0);
  const supMs = wireList.reduce((s, r) => s + (Number(r?.ms ?? 0) || 0), 0);

  const rawCalls = Number(rawSupCost?.calls ?? fallbackCalls ?? 0) || 0;
  const rawIn = Number(rawSupCost?.inputTokens ?? 0) || 0;
  const rawOut = Number(rawSupCost?.outputTokens ?? 0) || 0;
  const rawTotal = Number(rawSupCost?.totalTokens ?? 0) || 0;
  const rawMs = Number(rawSupCost?.durationMs ?? 0) || 0;

  const calls = Math.max(wireList.length, rawCalls);
  const preferRaw = rawCalls > wireList.length || rawTotal > supInput + supOutput;
  const inputTokens = preferRaw ? rawIn : Math.max(supInput, rawIn);
  const outputTokens = preferRaw ? rawOut : Math.max(supOutput, rawOut);
  const totalTokens = inputTokens + outputTokens;
  const durationMs = preferRaw ? rawMs : Math.max(supMs, rawMs);
  const fallbackCount = Number(rawSupCost?.fallbackCount ?? 0) || 0;

  return { calls, inputTokens, outputTokens, totalTokens, durationMs, fallbackCount };
}

export function parseAciCliArgs(argv = process.argv.slice(2)) {
  const opts = {
    mode: 'deterministic',
    arms: ['A', 'B', 'C', 'D'],
    suite: 'aci',
    tasks: null,
    repeats: 1,
    concurrency: 1,
    resume: false,
    lane: 0,
    lanes: 1,
    output: null,
    archiveDir: null,
    archivePrefix: null,
    exportPaper: null,
    exportLatex: null,
    aciProfile: null,
    dtocPolicy: null,
    maxSteps: null,
    maxTokens: null,
    dtocMinPromptTokens: 24000,
    sandbox: process.env.AGENT_US_BENCHMARK_SANDBOX_MODE || SANDBOX_MODES.STRONG,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const nextVal = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--resume') opts.resume = true;
    else if (arg === '--mode') opts.mode = String(nextVal());
    else if (arg.startsWith('--mode=')) opts.mode = arg.slice('--mode='.length);
    else if (arg === '--arms') opts.arms = String(nextVal()).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (arg.startsWith('--arms=')) opts.arms = arg.slice('--arms='.length).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (arg === '--suite') opts.suite = String(nextVal()).toLowerCase();
    else if (arg.startsWith('--suite=')) opts.suite = arg.slice('--suite='.length).toLowerCase();
    else if (arg === '--tasks') {
      const val = String(nextVal()).trim();
      opts.tasks = val.toLowerCase() === 'all' ? null : val.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--tasks=')) {
      const val = arg.slice('--tasks='.length).trim();
      opts.tasks = val.toLowerCase() === 'all' ? null : val.split(',').map((s) => s.trim()).filter(Boolean);
    }
    else if (arg === '--repeats') opts.repeats = Number(nextVal());
    else if (arg.startsWith('--repeats=')) opts.repeats = Number(arg.slice('--repeats='.length));
    else if (arg === '--concurrency') opts.concurrency = Number(nextVal());
    else if (arg.startsWith('--concurrency=')) opts.concurrency = Number(arg.slice('--concurrency='.length));
    else if (arg === '--lane') opts.lane = Number(nextVal());
    else if (arg.startsWith('--lane=')) opts.lane = Number(arg.slice('--lane='.length));
    else if (arg === '--lanes') opts.lanes = Number(nextVal());
    else if (arg.startsWith('--lanes=')) opts.lanes = Number(arg.slice('--lanes='.length));
    else if (arg === '--output') opts.output = String(nextVal());
    else if (arg.startsWith('--output=')) opts.output = arg.slice('--output='.length);
    else if (arg === '--archive-dir') opts.archiveDir = String(nextVal());
    else if (arg.startsWith('--archive-dir=')) opts.archiveDir = arg.slice('--archive-dir='.length);
    else if (arg === '--archive-prefix') opts.archivePrefix = String(nextVal());
    else if (arg.startsWith('--archive-prefix=')) opts.archivePrefix = arg.slice('--archive-prefix='.length);
    else if (arg === '--export-paper') opts.exportPaper = String(nextVal());
    else if (arg.startsWith('--export-paper=')) opts.exportPaper = arg.slice('--export-paper='.length);
    else if (arg === '--export-latex') opts.exportLatex = String(nextVal());
    else if (arg.startsWith('--export-latex=')) opts.exportLatex = arg.slice('--export-latex='.length);
    else if (arg === '--aci-profile') opts.aciProfile = String(nextVal());
    else if (arg.startsWith('--aci-profile=')) opts.aciProfile = arg.slice('--aci-profile='.length);
    else if (arg === '--dtoc-policy') opts.dtocPolicy = String(nextVal());
    else if (arg.startsWith('--dtoc-policy=')) opts.dtocPolicy = arg.slice('--dtoc-policy='.length);
    else if (arg === '--max-steps') opts.maxSteps = Number(nextVal());
    else if (arg.startsWith('--max-steps=')) opts.maxSteps = Number(arg.slice('--max-steps='.length));
    else if (arg === '--max-tokens') opts.maxTokens = Number(nextVal());
    else if (arg.startsWith('--max-tokens=')) opts.maxTokens = Number(arg.slice('--max-tokens='.length));
    else if (arg === '--dtoc-min-prompt-tokens') opts.dtocMinPromptTokens = Number(nextVal());
    else if (arg.startsWith('--dtoc-min-prompt-tokens=')) opts.dtocMinPromptTokens = Number(arg.slice('--dtoc-min-prompt-tokens='.length));
    else if (arg === '--sandbox') opts.sandbox = String(nextVal());
    else if (arg.startsWith('--sandbox=')) opts.sandbox = arg.slice('--sandbox='.length);
    else throw new Error(`Unknown CLI flag: ${arg}`);
  }

  if (!['deterministic', 'real'].includes(opts.mode)) {
    throw new Error(`Unsupported --mode "${opts.mode}"; expected deterministic or real`);
  }
  if (!['aci', 'aci25', 'aci26', 'ar', 'all'].includes(opts.suite)) {
    throw new Error(`Unsupported --suite "${opts.suite}"; expected aci, aci25, aci26, ar, or all`);
  }
  if (!opts.arms.length || opts.arms.some((a) => !VALID_ARMS.has(a))) {
    throw new Error(`Invalid --arms "${opts.arms.join(',')}"; expected subset of A,B,C,D`);
  }
  opts.arms = [...new Set(opts.arms)];
  if (!Number.isInteger(opts.repeats) || opts.repeats < 1 || opts.repeats > 20) {
    throw new Error('--repeats must be an integer between 1 and 20');
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 16) {
    throw new Error('--concurrency must be an integer between 1 and 16');
  }
  if (!Number.isInteger(opts.lane) || !Number.isInteger(opts.lanes) || opts.lanes < 1 || opts.lane < 0 || opts.lane >= opts.lanes) {
    throw new Error('Invalid --lane / --lanes values');
  }
  if (!Number.isFinite(opts.dtocMinPromptTokens) || opts.dtocMinPromptTokens < 0) {
    throw new Error('--dtoc-min-prompt-tokens must be a non-negative number');
  }
  if (opts.maxSteps !== null && (!Number.isInteger(opts.maxSteps) || opts.maxSteps < 1)) {
    throw new Error('--max-steps must be a positive integer');
  }
  if (opts.maxTokens !== null && (!Number.isInteger(opts.maxTokens) || opts.maxTokens < 1024)) {
    throw new Error('--max-tokens must be an integer >= 1024');
  }
  if (opts.aciProfile !== null && !['full_aci', 'aci_25', 'aci_26'].includes(opts.aciProfile.trim())) {
    throw new Error('--aci-profile must be full_aci or aci_25 (or aci_26)');
  }
  if (opts.archivePrefix !== null) {
    const cleanPrefix = opts.archivePrefix.trim();
    if (!cleanPrefix || cleanPrefix.includes('..') || !/^[A-Za-z0-9._-]+$/.test(cleanPrefix)) {
      throw new Error('--archive-prefix must be a safe filename prefix matching /^[A-Za-z0-9._-]+$/');
    }
    opts.archivePrefix = cleanPrefix;
  }
  return opts;
}

function buildSandboxOptions(sandboxMode) {
  if (sandboxMode === SANDBOX_MODES.NODE_PERMISSION) {
    return {
      mode: SANDBOX_MODES.NODE_PERMISSION,
      allowProcessHardeningOnly: process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY === '1',
    };
  }
  return { mode: sandboxMode };
}

function safeRedactValue(value, extraSecret = '') {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v !== 'string') return v;
      const scrubbed = extraSecret ? v.split(extraSecret).join('[REDACTED]') : v;
      return redactSecrets(scrubbed);
    }),
  );
}

function writeJsonlRow(outputPath, row, extraSecret = '') {
  if (!outputPath) return;
  mkdirSync(dirname(outputPath), { recursive: true });
  const safe = JSON.stringify(safeRedactValue(row, extraSecret));
  appendFileSync(outputPath, safe + '\n', { encoding: 'utf8', mode: 0o600 });
}

async function importOptional(worktreeRoot, relPath) {
  const full = join(worktreeRoot, 'backend', 'src', relPath);
  if (!existsSync(full)) return null;
  try {
    return await import(pathToFileURL(full).href);
  } catch {
    return null;
  }
}

async function importRequired(worktreeRoot, relPath) {
  const full = join(worktreeRoot, 'backend', 'src', relPath);
  if (!existsSync(full)) {
    throw new Error(`Required module missing in worktree ${worktreeRoot}: ${relPath}`);
  }
  return import(pathToFileURL(full).href);
}

export async function probeAciRuntimeCapabilities(repoRoot = DEFAULT_REPO_ROOT) {
  const root = resolve(repoRoot);
  const [
    storeMod,
    poolMod,
    directMod,
    agentLoopMod,
    eventsMod,
    inferenceMod,
    verifierMod,
    toolsMod,
    dispatcherMod,
    reconMod,
    checkpointMod,
    sandboxMod,
    aciStoreMod,
    aciEngineMod,
    supervisorMod,
    aciAdmissionMod,
  ] = await Promise.all([
    importRequired(root, 'store.js'),
    importRequired(root, 'pool.js'),
    importRequired(root, 'direct-agent.js'),
    importRequired(root, 'kernel/agent-loop.js'),
    importRequired(root, 'kernel/events.js'),
    importRequired(root, 'kernel/inference.js'),
    importRequired(root, 'governance/verifier.js'),
    importRequired(root, 'workspace-tools.js'),
    importRequired(root, 'tools/dispatcher.js'),
    importRequired(root, 'durable/reconciliation.js'),
    importRequired(root, 'durable/checkpoint.js'),
    importRequired(root, 'tools/benchmark-sandbox.js'),
    importRequired(root, 'context/aci-store.js'),
    importRequired(root, 'context/aci-engine.js'),
    importRequired(root, 'context/supervisor.js'),
    importOptional(root, 'context/aci-admission.js'),
  ]);

  const revisionRes = runHardenedGitSync(['rev-parse', 'HEAD'], { cwd: root, allowNetwork: false });
  const revision = revisionRes.exitCode === 0 ? revisionRes.stdout.trim() : null;

  const capabilities = {
    aciAdmission: Boolean(aciAdmissionMod?.ADMISSION_DECISIONS),
    restoreVerified: typeof aciStoreMod.ReversibleContextStore?.prototype?.restoreVerified === 'function',
    ledgerGovernance: typeof aciStoreMod.ContextEvidenceLedger?.prototype?.recordAdmission === 'function',
    supervisorAdmission: typeof supervisorMod.ContextSupervisor?.prototype?.admitCandidates === 'function',
    engineAdmitBatch: typeof aciEngineMod.ACIEngine?.prototype?.admitToolBatch === 'function',
    phaseWatermarkV25: Boolean(
      aciEngineMod?.PHASE_WATERMARK_V25_DTOC_POLICY ||
        aciEngineMod?.DTOC_POLICIES?.phase_watermark_v25 ||
        aciEngineMod?.DTOC_POLICIES?.PHASE_WATERMARK_V25 ||
        aciEngineMod?.PHASE_WATERMARK_V25 ||
        aciEngineMod?.ACI_25_VERSION,
    ),
    trajectoryEvictionV26: Boolean(
      aciEngineMod?.TRAJECTORY_EVICTION_V26_DTOC_POLICY ||
        aciEngineMod?.DTOC_POLICIES?.trajectory_eviction_v26 ||
        aciEngineMod?.VALID_DTOC_POLICIES?.includes?.('trajectory_eviction_v26'),
    ),
  };

  return {
    root,
    revision,
    capabilities,
    modules: {
      Store: storeMod.Store,
      AccountPool: poolMod.AccountPool,
      DirectAgentRuntime: directMod.DirectAgentRuntime,
      BenchmarkSandbox: sandboxMod.BenchmarkSandbox,
      AgentLoop: agentLoopMod.AgentLoop,
      DecisionEngine: agentLoopMod.DecisionEngine,
      EventRouter: eventsMod.EventRouter,
      InferenceEngine: inferenceMod.InferenceEngine,
      EvidenceVerifier: verifierMod.EvidenceVerifier,
      createWorkspaceTools: toolsMod.createWorkspaceTools,
      ToolDispatcher: dispatcherMod.ToolDispatcher,
      UnknownOutcomeReconciler: reconMod.UnknownOutcomeReconciler,
      CheckpointStore: checkpointMod.CheckpointStore,
      ReversibleContextStore: aciStoreMod.ReversibleContextStore,
      ContextEvidenceLedger: aciStoreMod.ContextEvidenceLedger,
      ACIEngine: aciEngineMod.ACIEngine,
      ContextSupervisor: supervisorMod.ContextSupervisor,
      aciAdmissionMod,
    },
  };
}

function getTaskDataset(opts) {
  const aciTasks =
    opts.suite === 'ar'
      ? []
      : createAciGovernanceDataset({
          sandboxOptions: buildSandboxOptions(opts.sandbox),
          suite: opts.suite,
        });
  const arTasks =
    opts.suite === 'aci' || opts.suite === 'aci25' || opts.suite === 'aci26'
      ? []
      : createAutonomousReasoningDataset({ sandboxOptions: buildSandboxOptions(opts.sandbox) });
  const fallbackSuite =
    opts.suite === 'aci26' ? 'aci26' : opts.suite === 'aci25' ? 'aci25' : 'aci';
  const combined = [
    ...aciTasks.map((t) => ({ ...t, _suite: t.suite || fallbackSuite })),
    ...arTasks.map((t) => ({ ...t, _suite: 'ar' })),
  ];
  if (!opts.tasks) return combined;
  const filtered = combined.filter((t) =>
    opts.tasks.some((f) => t.id === f || t.id.startsWith(`${f}-`)),
  );
  if (filtered.length === 0) {
    throw new Error(`No benchmark tasks matched --tasks filter: ${opts.tasks.join(',')}`);
  }
  return filtered;
}

function getTaskGroundTruthForScoring(task) {
  if (task?.metadata?.groundTruth) return task.metadata.groundTruth;
  const gt = resolveAciTaskGroundTruth(task?.id);
  if (gt.criticalFiles.length > 0) return gt;
  const critical = resolveTaskCriticalContextFiles(task);
  const allFiles = Object.keys(task?.fixture?.files ?? {});
  const relevant = [...new Set([...critical, ...allFiles.filter((f) => /^(?:src|test)\//i.test(f) || /^(?:package\.json|README\.md|SPEC\.md|CONSTRAINTS\.md|CONTRACT\.json)$/i.test(f))])];
  const relSet = new Set(relevant);
  const noise = allFiles.filter((f) => !relSet.has(f));
  return { criticalFiles: critical, relevantFiles: relevant, noiseFiles: noise };
}

function getReferenceFixForTask(task, workspaceRoot) {
  if (task._suite === 'ar') {
    return getAutonomousReasoningReferenceFix(task.id, workspaceRoot);
  }
  return getAciGovernanceReferenceFix(task.id, workspaceRoot);
}

function buildEvidenceOutputForTask(task) {
  if (task._suite === 'ar') {
    return buildAutonomousReasoningEvidenceOutput(task);
  }
  return buildAciGovernanceEvidenceOutput(task);
}

async function instantiateWorkspaceForTask(task, prefixOrOpts) {
  const options = typeof prefixOrOpts === 'string' ? { prefix: prefixOrOpts } : (prefixOrOpts ?? {});
  if (task._suite === 'ar') {
    return instantiateAutonomousReasoningWorkspace(task, options);
  }
  return instantiateAciGovernanceWorkspace(task, options);
}

function buildProbeReadPlan(task, armName) {
  const allFiles = Object.keys(task?.fixture?.files ?? {});
  const specFiles = allFiles.filter((f) => /^(?:SPEC\.md|CONSTRAINTS\.md|CONTRACT\.json)$/i.test(f));
  const activeSrc = allFiles.filter(
    (f) => /^src\//i.test(f) && !/legacy|compat|telemetry/i.test(f),
  );
  const requiredExisting = (task?.metadata?.acceptanceCriteria?.requiredChangedFiles ?? []).filter((f) =>
    Object.hasOwn(task?.fixture?.files ?? {}, f),
  );
  const extraInputs = Object.hasOwn(task?.fixture?.files ?? {}, 'fixtures/baseline-events.json')
    ? ['fixtures/baseline-events.json']
    : [];
  const obviousDecoys = allFiles.filter((f) => /^(?:fixtures\/|docs\/|templates\/|plugins\/|scripts\/)/i.test(f) && f !== 'fixtures/baseline-events.json');
  const semanticDecoys = allFiles.filter((f) => /^src\/.*(?:legacy|compat|telemetry)/i.test(f));
  const inspectFiles = [...new Set([...specFiles, ...requiredExisting, ...extraInputs, ...activeSrc])];
  const criticalTarget = [...inspectFiles].sort(
    (a, b) => (task?.fixture?.files?.[b]?.length ?? 0) - (task?.fixture?.files?.[a]?.length ?? 0),
  )[0] ?? allFiles[0];

  return {
    armName,
    criticalTarget,
    inspectFiles,
    obviousDecoys: obviousDecoys.slice(0, 3),
    semanticDecoys: semanticDecoys.slice(0, 2),
  };
}

class DeterministicAciProbeAdapter extends LlmAdapter {
  constructor({ task, workspaceRoot, readPlan, fallbackArtifactUri = null }) {
    super();
    this.task = task;
    this.workspaceRoot = workspaceRoot;
    this.readPlan = readPlan;
    this.fallbackArtifactUri = fallbackArtifactUri;
    this.step = 0;
  }

  async *stream(opts) {
    this.step += 1;
    const msgs = opts.messages ?? [];
    const hasCall = (id) => msgs.some((m) => m.role === 'tool' && m.toolCallId === id);

    // Step 1: Read active files + decoys (Arm B/C/D exercise pre-injection admission on decoys)
    if (!hasCall('probe-read-0')) {
      const filesToRead = [
        ...this.readPlan.inspectFiles,
        ...this.readPlan.obviousDecoys,
        ...this.readPlan.semanticDecoys,
      ];
      for (let i = 0; i < filesToRead.length; i++) {
        yield {
          type: 'block-end',
          index: i,
          block: {
            type: 'tool-call',
            id: `probe-read-${i}`,
            name: 'read_file',
            arguments: JSON.stringify({ path: filesToRead[i] }),
          },
        };
      }
      const inTok = filesToRead.reduce(
        (s, f) => s + estimateTokens(this.task.fixture?.files?.[f] ?? ''),
        450,
      );
      yield {
        type: 'usage',
        usage: {
          inputTokens: inTok,
          outputTokens: 90,
          cacheReadTokens: 0,
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    // Step 2 for Arm D: recover deferred/supporting active context via expand_context lossless SHA-256 restore (never restore IRRELEVANT decoys)
    if (this.readPlan.armName === 'D' && !hasCall('probe-expand-0')) {
      let artifactRef = null;
      let secondaryRef = null;
      for (const m of msgs) {
        if (m.role !== 'tool') continue;
        const txt = String(m.content?.[0]?.text ?? '');
        if (/\bIRRELEVANT\b/i.test(txt)) continue;
        const match = txt.match(/artifact:\/\/[0-9a-f]{64}/i);
        if (!match) continue;
        if (this.readPlan.criticalTarget && txt.includes(this.readPlan.criticalTarget)) {
          artifactRef = match[0];
          break;
        }
        if (!secondaryRef && /\b(?:DEFER|SUPPORTING)\b/i.test(txt)) {
          secondaryRef = match[0];
        }
      }
      artifactRef = artifactRef ?? this.fallbackArtifactUri ?? secondaryRef;
      if (artifactRef) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'probe-expand-0',
            name: 'expand_context',
            arguments: JSON.stringify({ ref: artifactRef, startLine: 1, endLine: 120 }),
          },
        };
        yield {
          type: 'usage',
          usage: { inputTokens: 1100, outputTokens: 35, cacheReadTokens: 850 },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
    }

    // Step 3: Apply reference fix and run baseline test command
    if (!hasCall('probe-verify')) {
      const refFix = getReferenceFixForTask(this.task, this.workspaceRoot);
      const entries = Object.entries(refFix);
      for (const [rel, body] of entries.slice(0, -1)) {
        applyWorkspaceFiles(this.workspaceRoot, { [rel]: body });
      }
      const [lastRel, lastBody] = entries.at(-1);
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'probe-write-last',
          name: 'write_file',
          arguments: JSON.stringify({ path: lastRel, content: lastBody }),
        },
      };
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'probe-verify',
          name: 'bash',
          arguments: JSON.stringify({ command: this.task.metadata.acceptanceCriteria.testCommand.join(' ') }),
        },
      };
      const basePromptTok =
        this.readPlan.armName === 'A' ? 5400 : this.readPlan.armName === 'B' ? 2800 : 1950;
      const cacheHitTok =
        this.readPlan.armName === 'A'
          ? 2400
          : this.readPlan.armName === 'D'
            ? 1650
            : 1450;
      yield {
        type: 'usage',
        usage: { inputTokens: basePromptTok, outputTokens: 110, cacheReadTokens: cacheHitTok },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    const out = buildEvidenceOutputForTask(this.task);
    yield { type: 'text-delta', index: 0, text: JSON.stringify(out.output) };
    yield {
      type: 'usage',
      usage: {
        inputTokens: this.readPlan.armName === 'A' ? 5600 : 2100,
        outputTokens: 60,
        cacheReadTokens: this.readPlan.armName === 'A' ? 2600 : 1750,
      },
    };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

class DeterministicMockSupervisorAdapter extends LlmAdapter {
  constructor() {
    super();
    this.calls = [];
  }

  async *stream(opts) {
    // Enforce read-only Supervisor boundary: tools must always be absent/empty
    if (Array.isArray(opts?.tools) && opts.tools.length > 0) {
      throw new Error('Supervisor security boundary violated: tools must be empty');
    }
    const promptText = String(opts?.messages?.at(-1)?.content?.[0]?.text ?? '');
    this.calls.push({ at: Date.now(), promptLen: promptText.length });
    const decisions = [];
    try {
      const parsedPrompt = JSON.parse(promptText);
      const candidates = Array.isArray(parsedPrompt?.candidates) ? parsedPrompt.candidates : [];
      for (const c of candidates) {
        const path = String(c?.path ?? '');
        const isDecoy = /(?:legacy|compat|telemetry|fixtures\/(?!baseline-events)|docs\/(?!SPEC|CONSTRAINTS)|templates\/|plugins\/|scripts\/)/i.test(path);
        decisions.push({
          id: c.id,
          decision: isDecoy ? 'IRRELEVANT' : 'SUPPORTING',
          focusSymbols: Array.isArray(c?.symbols) ? c.symbols.slice(0, 4) : [],
          reason: isDecoy ? 'Unreferenced legacy/fixture decoy' : 'Active pipeline artifact',
        });
      }
    } catch {
      // Non-JSON prompt format
    }
    const responseJson = JSON.stringify({
      decisions,
      keepRefs: [],
      compressRefs: [],
      expandSuggestions: [],
      contractHints: ['Focus strictly on active src/ modules and SPEC/CONTRACT invariants; reject legacy/fixture decoys.'],
      summary: 'Retain active modules and contracts; exclude legacy/fixture noise.',
    });
    yield { type: 'text-delta', index: 0, text: responseJson };
    yield { type: 'usage', usage: { inputTokens: 320, outputTokens: 55 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

function normalizeTrialRelPath(workspaceRoot, rawPath) {
  const raw = String(rawPath ?? '').trim();
  if (!raw) return '';
  if (workspaceRoot && (/^[A-Za-z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\'))) {
    try {
      const rel = relative(resolve(workspaceRoot), resolve(raw)).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..') && !/^[A-Za-z]:/.test(rel)) return rel;
    } catch {
      // fall through
    }
  }
  return raw.replace(/\\/g, '/').replace(/^\.\//, '');
}

function extractReadAdmissionsFromTurnData({
  workspaceRoot,
  verifierEvents = null,
  eventRows = null,
  assistantMessageRows = null,
  filesRead = null,
}) {
  const admissions = [];
  const fileTokensMap = {};
  const seenKey = new Set();

  if (Array.isArray(verifierEvents) && verifierEvents.length > 0) {
    for (const ev of verifierEvents) {
      if (ev?.type !== 'tool/result') continue;
      const d = ev.data ?? {};
      if (d.name !== 'read_file' || d.isError) continue;
      const rawPath = d.effectiveArgs?.path ?? d.effectiveArgs?.filePath ?? '';
      const rel = normalizeTrialRelPath(workspaceRoot, rawPath);
      if (!rel) continue;
      const tok = Math.max(1, estimateTokens(String(d.content ?? '')));
      fileTokensMap[rel] = Math.max(fileTokensMap[rel] ?? 0, tok);
      admissions.push({
        path: rel,
        toolName: 'read_file',
        decision: 'DIRECT',
        originalTokens: tok,
        injectedTokens: tok,
        tokensSaved: 0,
        step: 1,
      });
      seenKey.add(`${d.callId ?? rel}`);
    }
  }

  if (admissions.length === 0 && (Array.isArray(assistantMessageRows) || Array.isArray(eventRows))) {
    const callPathById = new Map();
    for (const row of Array.isArray(assistantMessageRows) ? assistantMessageRows : []) {
      let calls = row?.toolCalls ?? row;
      if (typeof calls === 'string') {
        try { calls = JSON.parse(calls); } catch { calls = null; }
      }
      if (!Array.isArray(calls)) continue;
      for (const tc of calls) {
        if (!tc?.id || tc.name !== 'read_file') continue;
        let args = tc.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        const rel = normalizeTrialRelPath(workspaceRoot, args?.path ?? args?.filePath ?? '');
        if (rel) callPathById.set(String(tc.id), rel);
      }
    }

    const resultByCallId = new Map();
    for (const ev of Array.isArray(eventRows) ? eventRows : []) {
      if (ev?.type !== 'tool/result') continue;
      let d = ev.data;
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch { d = null; }
      }
      if (!d || d.isError) continue;
      if (d.callId) resultByCallId.set(String(d.callId), d);
    }

    for (const [callId, rel] of callPathById.entries()) {
      const evData = resultByCallId.get(callId);
      let tok = evData?.output ? Math.max(1, estimateTokens(String(evData.output))) : 0;
      if (workspaceRoot) {
        try {
          const abs = join(workspaceRoot, rel);
          if (existsSync(abs)) {
            const diskTok = Math.max(1, estimateTokens(readFileSync(abs, 'utf8')));
            tok = Math.max(tok, diskTok);
          }
        } catch {
          // ignore read error
        }
      }
      tok = Math.max(1, tok || 100);
      fileTokensMap[rel] = Math.max(fileTokensMap[rel] ?? 0, tok);
      admissions.push({
        path: rel,
        toolName: 'read_file',
        decision: 'DIRECT',
        originalTokens: tok,
        injectedTokens: tok,
        tokensSaved: 0,
        step: 1,
      });
      seenKey.add(rel);
    }

    for (const rawFile of Array.isArray(filesRead) ? filesRead : []) {
      const rel = normalizeTrialRelPath(workspaceRoot, rawFile);
      if (!rel || seenKey.has(rel)) continue;
      let tok = 100;
      if (workspaceRoot) {
        try {
          const abs = join(workspaceRoot, rel);
          if (existsSync(abs)) tok = Math.max(1, estimateTokens(readFileSync(abs, 'utf8')));
        } catch {
          // ignore
        }
      }
      fileTokensMap[rel] = Math.max(fileTokensMap[rel] ?? 0, tok);
      admissions.push({
        path: rel,
        toolName: 'read_file',
        decision: 'DIRECT',
        originalTokens: tok,
        injectedTokens: tok,
        tokensSaved: 0,
        step: 1,
      });
    }
  }

  return { admissions, fileTokensMap };
}

function buildArmAdmissionTelemetry({
  task,
  armName,
  readPlan,
  workspaceRoot,
  verifierEvents,
  aciStore,
  ledger,
  capabilities,
}) {
  // If Stream A's ContextEvidenceLedger already populated admissions, honor them directly
  if (Array.isArray(ledger?.admissions) && ledger.admissions.length > 0) {
    return {
      admissions: ledger.admissions,
      supervisorCalls: ledger.supervisorCalls ?? [],
      recoveries: ledger.recoveries ?? [],
    };
  }

  // For Arm A (raw_full), extract apples-to-apples wrapped read_file tokens directly from AgentLoop verifierEvents
  const extracted = extractReadAdmissionsFromTurnData({ workspaceRoot, verifierEvents });
  if (extracted.admissions.length > 0) {
    return {
      admissions: extracted.admissions,
      supervisorCalls: ledger?.supervisorCalls ?? [],
      recoveries: ledger?.recoveries ?? [],
    };
  }

  const fixtureFiles = task.fixture?.files ?? {};
  const admissions = [];
  const supervisorCalls = [];
  const recoveries = [];

  const allRead = [
    ...readPlan.inspectFiles,
    ...readPlan.obviousDecoys,
    ...readPlan.semanticDecoys,
  ];
  for (const rel of allRead) {
    const content = fixtureFiles[rel] ?? '';
    const origTok = Math.max(1, estimateTokens(content));
    let decision = 'DIRECT';
    let injTok = origTok;

    if (armName === 'B') {
      if (readPlan.obviousDecoys.includes(rel)) {
        decision = 'IRRELEVANT';
        injTok = 22;
      } else if (readPlan.semanticDecoys.includes(rel)) {
        decision = 'SUPPORTING';
        injTok = Math.min(origTok, 180);
      } else if (origTok > 900) {
        decision = 'SUPPORTING';
        injTok = Math.min(origTok, 380);
      }
    } else if (armName === 'C') {
      if (readPlan.obviousDecoys.includes(rel) || readPlan.semanticDecoys.includes(rel)) {
        decision = 'IRRELEVANT';
        injTok = 22;
      } else if (origTok > 900) {
        decision = 'SUPPORTING';
        injTok = Math.min(origTok, 340);
      }
    } else if (armName === 'D') {
      if (readPlan.obviousDecoys.includes(rel) || readPlan.semanticDecoys.includes(rel)) {
        decision = 'IRRELEVANT';
        injTok = 22;
      } else if (rel === readPlan.criticalTarget && origTok >= 300) {
        const ref = aciStore.put(content, {
          path: rel,
          toolName: 'read_file',
          originalTokens: origTok,
          step: 1,
        });
        decision = 'DEFER';
        injTok = ref.stubTokens;
        const restored = aciStore.restore(ref.uri);
        const restoredSha = createHash('sha256').update(String(restored), 'utf8').digest('hex');
        recoveries.push({
          refId: ref.refId,
          uri: ref.uri,
          sha256: ref.sha256,
          path: rel,
          level: 'verbatim',
          verified: restoredSha === ref.sha256 && restored === content,
          tokensRestored: Math.min(origTok, 420),
          triggeredBy: 'expand_context',
          step: 2,
        });
      } else if (origTok > 900) {
        decision = 'SUPPORTING';
        injTok = Math.min(origTok, 340);
      }
    }

    admissions.push({
      path: rel,
      toolName: 'read_file',
      decision,
      originalTokens: origTok,
      injectedTokens: injTok,
      tokensSaved: Math.max(0, origTok - injTok),
      step: 1,
    });
  }

  if (armName === 'C' || armName === 'D') {
    const supTokIn = 320;
    const supTokOut = 55;
    supervisorCalls.push({
      stage: 'admission',
      model: 'mock-supervisor-flash',
      candidateCount: readPlan.semanticDecoys.length + 1,
      inputTokens: supTokIn,
      outputTokens: supTokOut,
      totalTokens: supTokIn + supTokOut,
      durationMs: 12,
      ok: true,
      step: 1,
    });
  }

  if (!capabilities.ledgerGovernance) {
    ledger.admissions = admissions;
    ledger.supervisorCalls = supervisorCalls;
    ledger.recoveries = recoveries;
  }

  return { admissions, supervisorCalls, recoveries };
}

function extractTrial26Telemetry({ aciMetrics = {}, reasoningMetrics = {}, ledger = null } = {}) {
  const rawDecisions =
    aciMetrics?.admissionDecisions ?? aciMetrics?.decisions ?? ledger?.decisionCounts ?? null;
  const decisions = { DIRECT: 0, SUPPORTING: 0, DEFER: 0, DUPLICATE: 0, IRRELEVANT: 0 };
  const hasExplicit =
    rawDecisions &&
    typeof rawDecisions === 'object' &&
    ['DIRECT', 'SUPPORTING', 'DEFER', 'DUPLICATE', 'IRRELEVANT'].some(
      (k) => Number(rawDecisions[k] || 0) > 0,
    );
  if (hasExplicit) {
    for (const k of Object.keys(decisions)) {
      decisions[k] = Math.max(0, Math.trunc(Number(rawDecisions[k] ?? 0) || 0));
    }
  } else if (Array.isArray(ledger?.admissions)) {
    for (const adm of ledger.admissions) {
      const k = String(adm?.decision || '').toUpperCase();
      if (Object.hasOwn(decisions, k)) decisions[k] += 1;
    }
  }
  const rawAnti =
    reasoningMetrics?.antiThrashingTriggered ?? aciMetrics?.antiThrashingTriggered ?? 0;
  const antiThrashingTriggered =
    typeof rawAnti === 'boolean'
      ? rawAnti
        ? 1
        : 0
      : Math.max(0, Math.trunc(Number(rawAnti) || 0));

  return {
    supersededEvictions: Math.max(
      0,
      Math.trunc(Number(aciMetrics?.supersededEvictions ?? ledger?.supersededEvictions ?? 0) || 0),
    ),
    supersededTokensSaved: Math.max(
      0,
      Math.trunc(Number(aciMetrics?.supersededTokensSaved ?? ledger?.supersededTokensSaved ?? 0) || 0),
    ),
    partialRecoveries: Math.max(
      0,
      Math.trunc(
        Number(
          aciMetrics?.partialRecoveries ??
            aciMetrics?.recoveryStats?.partialRecoveries ??
            ledger?.partialRecoveries ??
            0,
        ) || 0,
      ),
    ),
    recoveryTokensSaved: Math.max(
      0,
      Math.trunc(
        Number(
          aciMetrics?.recoveryTokensSaved ??
            aciMetrics?.recoveryStats?.recoveryTokensSaved ??
            ledger?.recoveryTokensSaved ??
            0,
        ) || 0,
      ),
    ),
    antiThrashingTriggered,
    decisions,
  };
}

async function runDeterministicAciTrial({ task, armName, armRuntime, rep, opts, judgeSandbox }) {
  const started = performance.now();
  const armCfg = resolveArmProfileConfig(armName, {
    dtocMinPromptTokens: opts.dtocMinPromptTokens,
    aciProfile: opts.aciProfile,
    dtocPolicy: opts.dtocPolicy,
    suite: opts.suite,
  });
  const trialNonce = randomUUID().slice(0, 8);
  const stateDir = mkdtempSync(join(tmpdir(), `agent-us-aci-det-${armName}-${trialNonce}-`));
  const workspaceRoot = await instantiateWorkspaceForTask(task, {
    prefix: `agent-us-aci-ws-${armName}-${trialNonce}-`,
  });
  const {
    Store,
    AccountPool,
    AgentLoop,
    DecisionEngine,
    EventRouter,
    InferenceEngine,
    EvidenceVerifier,
    createWorkspaceTools,
    ToolDispatcher,
    UnknownOutcomeReconciler,
    CheckpointStore,
    ReversibleContextStore,
    ContextEvidenceLedger,
    ACIEngine,
    ContextSupervisor,
  } = armRuntime.modules;

  const store = new Store(join(stateDir, 'eval.sqlite'));
  try {
    const pool = new AccountPool(store, { root: stateDir });
    pool.createAccount({
      preset: 'custom-openai',
      label: 'deterministic-aci-supervisor',
      credential: 'det-sup-key',
      endpoint: 'https://det-supervisor.invalid/v1',
      models: ['mock-supervisor-flash'],
    });
    pool.setDefaultModel('mock-supervisor-flash');

    const sessionId = `sess-${task.id}-${armName}-${rep}-${trialNonce}`;
    const turnId = `turn-${task.id}-${armName}-${rep}-${trialNonce}`;
    const now = Date.now();
    store.db
      .prepare('INSERT INTO direct_sessions(id,title,workspaceRoot,model,permissionMode,state,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)')
      .run(sessionId, task.title, workspaceRoot, 'deterministic-probe', 'auto-safe', 'running', now, now);
    store.db
      .prepare('INSERT INTO direct_turns(id,sessionId,input,model,state,phase,step,createdAt) VALUES(?,?,?,?,?,?,?,?)')
      .run(turnId, sessionId, task.prompt, 'deterministic-probe', 'running', 'init', 0, now);

    const aciStore = new ReversibleContextStore(store);
    const aciLedger = new ContextEvidenceLedger();
    const mockSupAdapter = new DeterministicMockSupervisorAdapter();
    const supervisor = new ContextSupervisor({ store, pool, adapter: mockSupAdapter });
    if (armName === 'A' || armName === 'B') {
      store.setSetting?.('aci.config', { enabled: false, mode: 'off', admissionEnabled: armName === 'B' });
    } else {
      store.setSetting?.('aci.config', {
        enabled: true,
        mode: 'auto',
        admissionEnabled: true,
        dtocMinPromptTokens: opts.dtocMinPromptTokens,
      });
    }

    const aciEngine = new ACIEngine({
      store,
      aciStore,
      ledger: aciLedger,
      supervisor,
      contextWindow: 128_000,
      maxTotalTokens: resolveBenchmarkTaskMaxTokens(task, opts),
      dtocPolicy: armCfg.aciOptions?.dtocPolicy || opts.dtocPolicy || 'adaptive_single_step',
      dtocMinPromptTokens: opts.dtocMinPromptTokens,
      ...(armCfg.aciOptions?.workingSetReadMaxChars !== undefined
        ? { workingSetReadMaxChars: armCfg.aciOptions.workingSetReadMaxChars }
        : {}),
    });

    const readPlan = buildProbeReadPlan(task, armName);
    const eventRouter = new EventRouter(store);
    const reconciler = new UnknownOutcomeReconciler(store, eventRouter);
    const checkpointStore = new CheckpointStore(store);
    const verifier = new EvidenceVerifier({ store, eventRouter });

    const loopSandbox = new BenchmarkSandbox({
      ...buildSandboxOptions(judgeSandbox.mode),
      workspaceRoot,
      allowWorkspaceNodeCli: Boolean(task.metadata?.sandboxIsolation?.allowWorkspaceNodeCli),
      timeoutMs: 30_000,
    });

    const resolveContextRef = (rawRef) => {
      try {
        const clean = String(rawRef ?? '').trim().replace(/^ref:/i, '').replace(/^aci:\/\//i, '');
        if (typeof aciEngine.restoreVerified === 'function') {
          return aciEngine.restoreVerified(clean);
        }
        const meta = aciStore.getRef(clean);
        const content = aciStore.restore(clean);
        return { content, sha256: meta?.sha256 ?? null };
      } catch {
        return null;
      }
    };

    let fallbackArtifactUri = null;
    // For Arm D, pre-seed a deferred artifact ref in aciStore so deterministic expand_context exercises SHA-256 restore
    if (armName === 'D' && readPlan.criticalTarget && task.fixture?.files?.[readPlan.criticalTarget]) {
      const seededRef = aciStore.put(task.fixture.files[readPlan.criticalTarget], {
        path: readPlan.criticalTarget,
        toolName: 'read_file',
        step: 1,
      });
      fallbackArtifactUri = seededRef.uri;
    }

    const tools = createWorkspaceTools({
      workspaceRoot,
      dataRoot: stateDir,
      store,
      sessionId,
      permissionMode: 'auto-safe',
      nonce: '0123456789abcdef0123456789abcdef',
      sandbox: loopSandbox,
      resolveContextRef,
    });
    const dispatcher = new ToolDispatcher({ store, eventRouter, reconciler });
    const adapter = new DeterministicAciProbeAdapter({
      task,
      workspaceRoot,
      readPlan,
      fallbackArtifactUri,
    });
    const inferenceEngine = new InferenceEngine(adapter);
    const decisionEngine = new DecisionEngine({ verifier: (args) => verifier.verify(args), maxRepairRounds: 2 });
    const loop = new AgentLoop({ store, eventRouter, inferenceEngine, decisionEngine, checkpointStore });

    const allowedBashCmds = new Set([
      task.fixture.baselineTestCommand.join(' '),
      task.metadata.acceptanceCriteria.testCommand.join(' '),
    ]);
    const requestApproval = async ({ tool, arguments: args, argsDigest }) => {
      if (tool === 'bash') {
        return { allowed: allowedBashCmds.has(String(args?.command ?? '').trim()), argsDigest };
      }
      if (['write_file', 'edit_file', 'apply_patch', 'read_file', 'expand_context', 'query_symbol_graph', 'run_diagnostics'].includes(tool)) {
        return { allowed: true, argsDigest };
      }
      return { allowed: false, argsDigest };
    };

    const maxSteps = opts.maxSteps ?? 12;
    const loopResult = await loop.run({
      sessionId,
      turnId,
      profile: { name: 'eval', defaultMaxSteps: maxSteps, streamDeltas: false, persistTurn: true },
      input: task.prompt,
      model: 'deterministic-probe',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Deterministic ACI governance probe.' }] },
        { role: 'user', content: [{ type: 'text', text: task.prompt }] },
      ],
      tools,
      toolDispatcher: dispatcher,
      permissionMode: 'auto-safe',
      requestApproval,
      budget: { maxSteps },
      workspaceRoot,
      execution: { requirePostEditVerification: true },
      aci: {
        engine: aciEngine,
        aciStore,
        ledger: aciLedger,
        supervisor,
        aciProfile: armCfg.aciProfile,
        aciOptions: armCfg.aciOptions,
        admissionEnabled: armName !== 'A',
        supervisorEnabled: armName === 'C' || armName === 'D',
        dtocEnabled: armName === 'D',
      },
    });

    const receipts = store.db
      .prepare('SELECT id, callId, toolName, status, exitCode FROM tool_receipts WHERE turnId=? ORDER BY rowid')
      .all(turnId);
    const commandMap = new Map();
    for (const ev of loopResult.verifierEvents ?? []) {
      if (ev.type === 'tool/call' && ev.data?.callId) {
        commandMap.set(ev.data.callId, ev.data?.arguments?.command ?? '');
      }
    }
    const enrichedReceipts = receipts.map((r) => ({ ...r, command: commandMap.get(r.callId) ?? '' }));

    const output = buildEvidenceOutputForTask(task);
    const judgment = await task.judge({
      task,
      output,
      context: {
        workspaceRoot,
        sandbox: judgeSandbox,
        attemptId: 'attempt-1',
        planVersion: 1,
        toolReceipts: enrichedReceipts,
        trustedVerdict: {
          status: loopResult.status === 'completed' ? 'pass' : 'fail',
          source: 'trusted_server_verifier',
          evidenceRefs: enrichedReceipts.map((r) => r.id),
        },
        trialMeta: {
          status: loopResult.status === 'completed' ? 'passed' : 'failed',
          errorCode: loopResult.errorCode,
        },
      },
    });

    const telemetry = buildArmAdmissionTelemetry({
      task,
      armName,
      readPlan,
      workspaceRoot,
      verifierEvents: loopResult.verifierEvents,
      aciStore,
      ledger: aciLedger,
      capabilities: armRuntime.capabilities,
    });
    const existingRm = loopResult.reasoningMetrics ?? {};
    const existingAci = existingRm.aciMetrics ?? {};
    const supervisorDisabled = armName === 'A' || armName === 'B' || armCfg?.supervisor === false;
    const supCallsArr = supervisorDisabled ? [] : telemetry.supervisorCalls;
    const supTokensIn = supCallsArr.reduce((s, c) => s + Number(c.inputTokens || 0), 0);
    const supTokensOut = supCallsArr.reduce((s, c) => s + Number(c.outputTokens || 0), 0);
    const supDurMs = supCallsArr.reduce((s, c) => s + Number(c.durationMs || 0), 0);
    const supervisorCost = supervisorDisabled
      ? { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0, fallbackCount: 0 }
      : existingAci.supervisorCost && Number(existingAci.supervisorCost.calls ?? 0) >= supCallsArr.length
        ? existingAci.supervisorCost
        : {
            calls: supCallsArr.length,
            inputTokens: supTokensIn,
            outputTokens: supTokensOut,
            totalTokens: supTokensIn + supTokensOut,
            durationMs: supDurMs,
            fallbackCount: 0,
          };

    const ledgerSnapshot = {
      ...(existingAci.ledger ?? {}),
      admissions: telemetry.admissions,
      supervisorCalls: supCallsArr,
      recoveries: telemetry.recoveries,
    };
    const v26Telemetry = extractTrial26Telemetry({
      aciMetrics: existingAci,
      reasoningMetrics: existingRm,
      ledger: ledgerSnapshot,
    });

    const baseIn = Number(loopResult.usage?.inputTokens ?? 0);
    const baseOut = Number(loopResult.usage?.outputTokens ?? 0);
    const baseCacheRead = Number(loopResult.usage?.cacheReadTokens ?? 0);
    const totalIn = baseIn + Number(supervisorCost.inputTokens || 0);
    const totalOut = baseOut + Number(supervisorCost.outputTokens || 0);
    const durationMs = Math.round(performance.now() - started);

    return {
      taskId: task.id,
      suite: task._suite,
      area: task.area,
      arm: armName,
      aciProfile: armCfg.aciProfile,
      aciOptions: armCfg.aciOptions,
      revision: armRuntime.revision,
      rep,
      passed: Boolean(judgment.passed),
      status: judgment.passed ? 'passed' : 'failed',
      groundTruth: getTaskGroundTruthForScoring(task),
      tokenUsage: {
        inputTokens: totalIn,
        outputTokens: totalOut,
        totalTokens: totalIn + totalOut,
        cacheReadTokens: baseCacheRead,
      },
      tokenCost: totalIn + totalOut,
      sseCacheReported: baseCacheRead > 0,
      durationMs,
      supervisorCost,
      ...v26Telemetry,
      aciMetrics: {
        ...existingAci,
        aciProfile: armCfg.aciProfile,
        dtocMinPromptTokens: opts.dtocMinPromptTokens,
        epochTransitions:
          task._suite === 'ar'
            ? 0
            : Number(existingAci.epochTransitions ?? 0),
        restoredCount: Math.max(
          Number(existingAci.restoredCount ?? 0),
          telemetry.recoveries.length,
        ),
        hashVerifiedRestores: Math.max(
          Number(existingAci.hashVerifiedRestores ?? 0),
          telemetry.recoveries.filter((r) => r.verified !== false).length,
        ),
        ...v26Telemetry,
        supervisorCost,
        ledger: ledgerSnapshot,
      },
      failureCategory: judgment.evidence.failureCategory,
      failureAttribution: judgment.evidence.failureAttribution,
      judge: judgment,
    };
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    await removeFixtureWorkspace(workspaceRoot).catch(() => {});
  }
}

function readHeaderValue(headers, targetName) {
  if (!headers) return null;
  const lower = targetName.toLowerCase();
  if (typeof headers.get === 'function') {
    return headers.get(targetName) || headers.get(lower) || null;
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (Array.isArray(entry) && String(entry[0] || '').toLowerCase() === lower) {
        return String(entry[1] ?? '');
      }
    }
    return null;
  }
  if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) return String(v ?? '');
    }
  }
  return null;
}

function stripTrialHeaderFromFetch(input, init) {
  let nextInput = input;
  let nextInit = init;
  if (init?.headers && readHeaderValue(init.headers, TRIAL_HEADER_NAME) != null) {
    const cleaned = new Headers(init.headers);
    cleaned.delete(TRIAL_HEADER_NAME);
    nextInit = { ...init, headers: cleaned };
  }
  if (typeof Request !== 'undefined' && input instanceof Request && input.headers?.has(TRIAL_HEADER_NAME)) {
    const cleaned = new Headers(input.headers);
    cleaned.delete(TRIAL_HEADER_NAME);
    nextInput = new Request(input, { headers: cleaned });
  }
  return [nextInput, nextInit];
}

function resolveFetchTrialCapture(input, init) {
  const headerTrialId =
    readHeaderValue(init?.headers, TRIAL_HEADER_NAME) ||
    (typeof input === 'object' ? readHeaderValue(input?.headers, TRIAL_HEADER_NAME) : null);
  const alsTrialId = TRIAL_FETCH_ALS.getStore() || null;
  const resolvedId = headerTrialId || alsTrialId;
  if (resolvedId && ACTIVE_FETCH_CAPTURES.has(resolvedId)) {
    return ACTIVE_FETCH_CAPTURES.get(resolvedId);
  }
  if (!resolvedId && ACTIVE_FETCH_CAPTURES.size === 1) {
    return ACTIVE_FETCH_CAPTURES.values().next().value;
  }
  return null;
}

function acquireFetchWireCapture(trialId, endpoint, wireRecords, pendingWirePromises) {
  if (ACTIVE_FETCH_CAPTURES.size === 0) {
    baseOriginalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const ctx = resolveFetchTrialCapture(input, init);
      const [cleanInput, cleanInit] = stripTrialHeaderFromFetch(input, init);
      const url = new URL(
        typeof cleanInput === 'string' || cleanInput instanceof URL ? cleanInput : cleanInput.url,
      );
      const isTrackedPath =
        url.pathname.endsWith('/chat/completions') || url.pathname.endsWith('/messages');
      if (!ctx || url.origin !== ctx.endpoint.origin || !isTrackedPath) {
        return baseOriginalFetch(cleanInput, cleanInit);
      }

      let isSupervisorCall = false;
      if (typeof cleanInit?.body === 'string') {
        try {
          const parsedReq = JSON.parse(cleanInit.body);
          isSupervisorCall = isAciSupervisorWireRequest(parsedReq);
        } catch {
          isSupervisorCall = false;
        }
      }
      const rec = {
        http: null,
        ms: null,
        isSupervisorCall,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheReported: false,
      };
      const t0 = performance.now();
      ctx.wireRecords.push(rec);
      const res = await baseOriginalFetch(cleanInput, cleanInit);
      rec.http = res.status;
      const wirePromise = res
        .clone()
        .text()
        .then((body) => {
          for (const line of body.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload);
              const u = parsed.usage || parsed.message?.usage || null;
              if (u) {
                rec.inputTokens = Number(u.prompt_tokens ?? u.input_tokens ?? rec.inputTokens ?? 0);
                rec.outputTokens = Number(u.completion_tokens ?? u.output_tokens ?? rec.outputTokens ?? 0);
                const cr =
                  u.prompt_tokens_details?.cached_tokens ??
                  u.cache_read_input_tokens ??
                  u.prompt_cache_hit_tokens;
                const cw =
                  u.cache_creation_input_tokens ?? u.prompt_tokens_details?.cache_creation_tokens;
                if (cr != null && Number.isFinite(Number(cr))) {
                  rec.cacheReadTokens = Number(cr);
                  rec.cacheReported = true;
                }
                if (cw != null && Number.isFinite(Number(cw))) {
                  rec.cacheWriteTokens = Number(cw);
                }
              }
            } catch {
              // ignore non-JSON SSE chunks
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          rec.ms = Math.round(performance.now() - t0);
        });
      ctx.pendingWirePromises.push(wirePromise);
      return res;
    };
  }

  ACTIVE_FETCH_CAPTURES.set(trialId, { endpoint, wireRecords, pendingWirePromises });
  return () => {
    ACTIVE_FETCH_CAPTURES.delete(trialId);
    if (ACTIVE_FETCH_CAPTURES.size === 0 && baseOriginalFetch) {
      globalThis.fetch = baseOriginalFetch;
      baseOriginalFetch = null;
    }
  };
}

function authorizeAciBenchmarkApproval({
  toolName,
  args,
  allowedTestCommands,
  protectedSet,
  allowWorkspaceNodeCli,
}) {
  if (toolName === 'run_diagnostics' || toolName === 'query_symbol_graph') return true;
  if (
    authorizeRealBenchmarkApproval({
      toolName,
      args,
      allowedTestCommands,
      protectedSet,
      allowWorkspaceNodeCli,
    })
  ) {
    return true;
  }
  if (toolName === 'apply_patch') {
    const patch = String(args?.patch ?? '');
    if (!patch.trim()) return false;
    const unifiedPaths = [];
    for (const line of patch.split(/\r?\n/)) {
      const m = /^(?:\+\+\+|---)\s+(?:a\/|b\/)?(.+?)(?:\t.*)?$/.exec(line);
      if (m) {
        const rawPath = m[1].trim();
        if (rawPath && rawPath !== '/dev/null') unifiedPaths.push(rawPath);
      }
    }
    if (unifiedPaths.length > 0) {
      return unifiedPaths.every((p) => {
        const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
        if (norm.startsWith('/') || norm.includes('..')) return false;
        return !protectedSet.has(norm);
      });
    }
  }
  return false;
}

async function runTasksWithConcurrency(items, concurrency, workerFn) {
  const results = new Array(items.length);
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await workerFn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runRealAciTrial({
  task,
  armName,
  armRuntime,
  rep,
  opts,
  benchKey,
  endpoint,
  requestedModel,
  judgeSandbox,
}) {
  const started = performance.now();
  const armCfg = resolveArmProfileConfig(armName, {
    dtocMinPromptTokens: opts.dtocMinPromptTokens,
    aciProfile: opts.aciProfile,
    dtocPolicy: opts.dtocPolicy,
    suite: opts.suite,
  });
  const trialId = `${task.id}--${armName}--${rep}--${randomUUID().slice(0, 8)}`;
  const stateDir = mkdtempSync(join(tmpdir(), `agent-us-aci-real-${armName}-${trialId.slice(-8)}-`));
  const workspaceRoot = await instantiateWorkspaceForTask(task, {
    prefix: `agent-us-aci-realws-${armName}-${trialId.slice(-8)}-`,
  });
  const { Store, AccountPool, DirectAgentRuntime, BenchmarkSandbox: ArmSandbox } = armRuntime.modules;
  const store = new Store(join(stateDir, 'eval.sqlite'));
  const pool = new AccountPool(store, { root: stateDir });
  pool.createAccount({
    preset: 'workbuddy',
    label: 'aci-governance-benchmark',
    credential: benchKey,
    protocol: 'openai',
    endpoint: endpoint.href,
    models: [requestedModel],
    headers: { [TRIAL_HEADER_NAME]: trialId },
  });
  pool.setDefaultModel(requestedModel);

  if (armName === 'A' || armName === 'B') {
    store.setSetting?.('aci.config', { enabled: false, mode: 'off', admissionEnabled: armName === 'B' });
  } else {
    store.setSetting?.('aci.config', {
      enabled: true,
      mode: 'auto',
      admissionEnabled: true,
      dtocMinPromptTokens: opts.dtocMinPromptTokens,
    });
  }

  const direct = new DirectAgentRuntime(store, pool, {
    dataRoot: stateDir,
    defaultWorkspace: workspaceRoot,
  });
  const allowWorkspaceNodeCli = Boolean(task.metadata?.sandboxIsolation?.allowWorkspaceNodeCli);
  const sessionSandbox = new ArmSandbox({
    ...buildSandboxOptions(judgeSandbox.mode),
    workspaceRoot,
    allowWorkspaceNodeCli,
    timeoutMs: 30_000,
    cpuLimitSec: 20,
    memoryLimitMb: 512,
  });

  const wireRecords = [];
  const pendingWirePromises = [];
  let unsub = null;
  const releaseWireCapture = acquireFetchWireCapture(trialId, endpoint, wireRecords, pendingWirePromises);

  try {
    return await TRIAL_FETCH_ALS.run(trialId, async () => {
      const maxSteps = opts.maxSteps ?? task.resourceBudget?.maxSteps ?? 22;
      const maxTokens = resolveBenchmarkTaskMaxTokens(task, opts);
      const session = direct.createSession({
        workspaceRoot,
        projectId: task.id,
        model: requestedModel,
        permissionMode: 'auto-safe',
        budget: { maxSteps, maxOutputTokens: 8192, maxTotalTokens: maxTokens },
        sandbox: sessionSandbox,
        disableWorkspaceHooks: true,
        disableWorkspaceMcp: true,
        trafficSource: 'benchmark',
        isSynthetic: true,
        aciProfile: armCfg.aciProfile,
        aciOptions: armCfg.aciOptions,
      });

      const allowedTestCommands = new Set([
        task.fixture.baselineTestCommand.join(' '),
        task.metadata.acceptanceCriteria.testCommand.join(' '),
      ]);
      const protectedSet = new Set([
        ...(task.fixture.baselineTestFiles ?? []),
        ...Object.keys(task.fixture.baselineFileHashes ?? {}),
      ]);
      unsub = direct.subscribe(session.id, (evt) => {
        if (evt.type === 'approval/requested') {
          const a = evt.data;
          const allow = authorizeAciBenchmarkApproval({
            toolName: a.tool,
            args: a.arguments,
            allowedTestCommands,
            protectedSet,
            allowWorkspaceNodeCli,
          });
          queueMicrotask(() =>
            direct.decideApproval(a.approvalId, {
              decision: allow ? 'allow' : 'deny',
              scope: 'once',
              reason: 'Frozen ACI governance benchmark policy',
            }),
          );
        }
      });

      const deadlineMs = 300_000;
      const { turn } = direct.startTurn(session.id, {
        input: task.prompt,
        model: requestedModel,
        maxSteps,
        aciProfile: armCfg.aciProfile,
        aciOptions: armCfg.aciOptions,
        evidenceContract: {
          taskId: task.id,
          attemptId: 'attempt-1',
          planVersion: 1,
          expectedTestCommand: task.metadata.acceptanceCriteria.testCommand,
          requiredChangedFiles: task.metadata.acceptanceCriteria.requiredChangedFiles,
          workspaceRoot,
        },
      });

      let row;
      const tTurn = performance.now();
      while (performance.now() - tTurn < deadlineMs) {
        row = direct.listTurns(session.id).find((r) => r.id === turn.id);
        if (['completed', 'failed', 'cancelled', 'reconciling'].includes(row?.state)) break;
        await delay(50);
      }
      const timedOut = !['completed', 'failed', 'cancelled', 'reconciling'].includes(row?.state);
      if (timedOut) {
        direct.cancelTurn(turn.id);
        await direct.waitForTurnTerminal(turn.id, { timeoutMs: 5000 }).catch(() => {});
        row = direct.listTurns(session.id).find((r) => r.id === turn.id) ?? row;
      }

      await Promise.race([Promise.allSettled(pendingWirePromises), delay(2000)]);

      const assistantMsgs = store.db
        .prepare("SELECT content FROM direct_messages WHERE turnId=? AND role='assistant' ORDER BY seq DESC LIMIT 1")
        .get(turn.id);
      const assistantMessageRows = store.db
        .prepare("SELECT toolCalls FROM direct_messages WHERE turnId=? AND role='assistant' AND toolCalls IS NOT NULL ORDER BY seq ASC")
        .all(turn.id);
      const receipts = store.db
        .prepare('SELECT id, callId, toolName, status, exitCode, errorCode FROM tool_receipts WHERE turnId=? ORDER BY rowid')
        .all(turn.id);
      const enrichedReceipts = enrichReceiptsWithCommands(receipts, assistantMessageRows);
      const eventRows = store.db
        .prepare('SELECT type, data FROM direct_events WHERE turnId=? ORDER BY seq ASC')
        .all(turn.id);
      const diagnostics = extractTurnDiagnosticsFromEvents(eventRows, enrichedReceipts, assistantMessageRows, benchKey);
      const turnErrorCode = diagnostics.turnErrorCode ?? row?.errorCode ?? (timedOut ? 'TURN_DEADLINE_EXCEEDED' : null);

      const judgment = await task.judge({
        task,
        output: assistantMsgs?.content ?? '',
        context: {
          workspaceRoot,
          sandbox: judgeSandbox,
          attemptId: 'attempt-1',
          planVersion: 1,
          toolReceipts: enrichedReceipts,
          trustedVerdict:
            row?.state === 'completed'
              ? { status: 'pass', source: 'trusted_server_verifier', evidenceRefs: enrichedReceipts.map((r) => r.id) }
              : null,
          trialMeta: {
            status: timedOut ? 'timeout' : row?.state === 'completed' ? 'passed' : 'failed',
            errorCode: turnErrorCode,
          },
        },
      });

      const supervisorDisabled =
        armName === 'A' || armName === 'B' || armCfg?.supervisor === false;
      const wireSup = supervisorDisabled
        ? []
        : wireRecords.filter((r) => r.isSupervisorCall);

      let inputTokens = wireRecords.reduce((s, r) => s + r.inputTokens, 0);
      let outputTokens = wireRecords.reduce((s, r) => s + r.outputTokens, 0);
      const cacheReadTokens = wireRecords.reduce((s, r) => s + r.cacheReadTokens, 0);
      const cacheWriteTokens = wireRecords.reduce((s, r) => s + r.cacheWriteTokens, 0);
      const sseCacheReported = wireRecords.some((r) => r.cacheReported);
      if (inputTokens === 0 && outputTokens === 0 && row) {
        inputTokens = Number(row.inputTokens ?? 0);
        outputTokens = Number(row.outputTokens ?? 0);
      }

      const durationMs = Math.round(performance.now() - started);
      const rm = diagnostics.reasoningMetrics ?? {};
      const aciMetrics = rm.aciMetrics ?? {};
      const rawSupCost = aciMetrics.supervisorCost ?? {};
      const supervisorCost = mergeSupervisorCostTelemetry(
        supervisorDisabled ? {} : rawSupCost,
        wireSup,
        supervisorDisabled ? 0 : aciMetrics.supervisorCalls,
        { supervisorEnabled: !supervisorDisabled },
      );
      const hasLedgerAdmissions = Array.isArray(aciMetrics?.ledger?.admissions) && aciMetrics.ledger.admissions.length > 0;
      const readFallback = extractReadAdmissionsFromTurnData({
        workspaceRoot,
        eventRows,
        assistantMessageRows,
        filesRead: rm.filesRead ?? [],
      });
      const v26Telemetry = extractTrial26Telemetry({
        aciMetrics,
        reasoningMetrics: rm,
        ledger: aciMetrics.ledger ?? null,
      });

      return {
        taskId: task.id,
        suite: task._suite,
        area: task.area,
        arm: armName,
        aciProfile: armCfg.aciProfile,
        aciOptions: armCfg.aciOptions,
        revision: armRuntime.revision,
        rep,
        passed: Boolean(judgment.passed && !timedOut),
        status: timedOut ? 'timeout' : judgment.passed ? 'passed' : 'failed',
        turnState: row?.state ?? null,
        turnErrorCode,
        groundTruth: getTaskGroundTruthForScoring(task),
        tokenUsage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        },
        tokenCost: inputTokens + outputTokens,
        sseCacheReported,
        durationMs,
        supervisorCost,
        ...v26Telemetry,
        recoveryStats: aciMetrics.recoveryStats ?? null,
        readFiles: Array.isArray(rm.filesRead) ? rm.filesRead : [],
        fileTokensMap: readFallback.fileTokensMap,
        ...(hasLedgerAdmissions ? {} : { admissions: readFallback.admissions }),
        toolCallTrace: diagnostics.toolCallTrace,
        reasoningMetrics: rm,
        aciMetrics: {
          ...aciMetrics,
          ...v26Telemetry,
          supervisorCost,
        },
        assistantExcerpt: safeRedactValue(String(assistantMsgs?.content ?? '').slice(0, 600), benchKey),
        failureCategory: timedOut ? 'timeout' : judgment.evidence.failureCategory,
        failureAttribution: judgment.evidence.failureAttribution,
        judge: judgment,
      };
    });
  } finally {
    releaseWireCapture();
    unsub?.();
    await direct.close();
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    await removeFixtureWorkspace(workspaceRoot).catch(() => {});
  }
}

export async function runAciGovernanceBenchmark(opts) {
  let benchKey = '';
  let endpoint = null;
  let requestedModel = null;
  if (opts.mode === 'real') {
    benchKey = process.env.TI_BENCH_KEY || process.env.AGENT_US_BENCH_KEY || '';
    delete process.env.TI_BENCH_KEY;
    delete process.env.AGENT_US_BENCH_KEY;
    endpoint = new URL(process.env.TI_BENCH_ENDPOINT || process.env.AGENT_US_BENCH_ENDPOINT || 'http://127.0.0.1:7863/v1');
    requestedModel = process.env.TI_BENCH_MODEL || process.env.AGENT_US_BENCH_MODEL || 'deepseek-v4.1-flash';
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname);
    if (
      !benchKey ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !(endpoint.protocol === 'https:' || (loopback && endpoint.protocol === 'http:'))
    ) {
      throw new Error('Real mode requires TI_BENCH_KEY/AGENT_US_BENCH_KEY and an authorized HTTPS or loopback endpoint.');
    }
  }

  const sandboxOpts = buildSandboxOptions(opts.sandbox);
  const judgeSandbox = new BenchmarkSandbox(sandboxOpts);
  judgeSandbox.resolveBackend();

  const dataset = getTaskDataset(opts);
  const armRuntime = await probeAciRuntimeCapabilities(DEFAULT_REPO_ROOT);

  const archiveDir = opts.archiveDir ? resolve(String(opts.archiveDir)) : null;
  const archivePrefix = archiveDir
    ? String(opts.archivePrefix || `aci-${opts.suite}-ablation`).trim()
    : null;
  const archiveJsonlPath = archiveDir ? join(archiveDir, `${archivePrefix}.jsonl`) : null;
  const effectiveOutputPath = opts.output ? resolve(String(opts.output)) : archiveJsonlPath;

  const resumeEnabled = Boolean(opts.resume && effectiveOutputPath);
  const resumeState = resumeEnabled
    ? loadResumeStateFromJsonl(effectiveOutputPath)
    : { existingRows: [], completedKeys: new Set(), hadCorruptLines: false };

  if (effectiveOutputPath) {
    mkdirSync(dirname(effectiveOutputPath), { recursive: true });
    if (!resumeEnabled || !existsSync(effectiveOutputPath)) {
      writeFileSync(effectiveOutputPath, '', { encoding: 'utf8', mode: 0o600 });
    } else {
      const existingRaw = readFileSync(effectiveOutputPath, 'utf8');
      if (existingRaw.length > 0 && !existingRaw.endsWith('\n')) {
        appendFileSync(effectiveOutputPath, '\n', { encoding: 'utf8', mode: 0o600 });
      }
    }
  }

  const plannedCells = [];
  for (let rep = 0; rep < opts.repeats; rep++) {
    for (const [idx, task] of dataset.entries()) {
      if (idx % opts.lanes !== opts.lane) continue;
      // Rotate arm execution order across tasks/repeats to eliminate cache/order bias
      const rotated = opts.arms.map((_, j) => opts.arms[(j + idx + rep) % opts.arms.length]);
      for (const armName of rotated) {
        const key = buildTrialCellKey(task.id, armName, rep);
        if (resumeState.completedKeys.has(key)) continue;
        plannedCells.push({ task, armName, rep });
      }
    }
  }

  const newlyCompleted = await runTasksWithConcurrency(
    plannedCells,
    opts.concurrency ?? 1,
    async ({ task, armName, rep }) => {
      const trial =
        opts.mode === 'real'
          ? await runRealAciTrial({
              task,
              armName,
              armRuntime,
              rep,
              opts,
              benchKey,
              endpoint,
              requestedModel,
              judgeSandbox,
            })
          : await runDeterministicAciTrial({
              task,
              armName,
              armRuntime,
              rep,
              opts,
              judgeSandbox,
            });
      writeJsonlRow(effectiveOutputPath, trial, benchKey);
      return trial;
    },
  );

  const allTrials = [...resumeState.existingRows, ...newlyCompleted];
  const baselineArm = opts.arms.includes('A') ? 'A' : opts.arms[0];
  const metrics = computeAciGovernanceMetrics(allTrials, { baselineArm });
  const createdAt = new Date().toISOString();
  const effectiveModel =
    requestedModel || (opts.mode === 'deterministic' ? 'deterministic-probe' : null);
  const summary = safeRedactValue(
    {
      benchmarkId: ACI_GOVERNANCE_BENCHMARK_ID,
      version: VERSION,
      mode: opts.mode,
      suite: opts.suite,
      model: effectiveModel,
      createdAt,
      sandboxBackend: judgeSandbox.resolveBackend().mode,
      concurrency: opts.concurrency ?? 1,
      resumed: resumeEnabled,
      resumedExistingCount: resumeState.existingRows.length,
      executedCount: newlyCompleted.length,
      arms: opts.arms,
      armProfiles: Object.fromEntries(
        opts.arms.map((a) => [
          a,
          resolveArmProfileConfig(a, {
            dtocMinPromptTokens: opts.dtocMinPromptTokens,
            aciProfile: opts.aciProfile,
            dtocPolicy: opts.dtocPolicy,
            suite: opts.suite,
          }),
        ]),
      ),
      revision: armRuntime.revision,
      capabilities: armRuntime.capabilities,
      metrics,
    },
    benchKey,
  );

  const scrubText = (txt) => {
    const clean = benchKey ? String(txt ?? '').split(benchKey).join('[REDACTED]') : String(txt ?? '');
    return redactSecrets(clean);
  };
  const markdownTable = scrubText(exportPaperTablesMarkdown(summary));
  const latexTable = scrubText(exportPaperTablesLatex(summary));

  const summaryPath = buildSummaryOutputPath(opts.output);
  if (summaryPath) {
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  if (opts.exportPaper) {
    const outPath = resolve(String(opts.exportPaper));
    mkdirSync(dirname(outPath), { recursive: true });
    const content = /\.tex$/i.test(outPath) ? latexTable : markdownTable;
    writeFileSync(outPath, content, { encoding: 'utf8', mode: 0o600 });
  }
  if (opts.exportLatex) {
    const texPath = resolve(String(opts.exportLatex));
    mkdirSync(dirname(texPath), { recursive: true });
    writeFileSync(texPath, latexTable, { encoding: 'utf8', mode: 0o600 });
  }

  if (archiveDir && archivePrefix) {
    mkdirSync(archiveDir, { recursive: true });
    const sanitizedJsonl =
      allTrials.map((row) => JSON.stringify(safeRedactValue(row, benchKey))).join('\n') +
      (allTrials.length > 0 ? '\n' : '');
    writeFileSync(join(archiveDir, `${archivePrefix}.jsonl`), sanitizedJsonl, {
      encoding: 'utf8',
      mode: 0o600,
    });
    writeFileSync(
      join(archiveDir, `${archivePrefix}-summary.json`),
      JSON.stringify(summary, null, 2) + '\n',
      { encoding: 'utf8', mode: 0o600 },
    );
    writeFileSync(join(archiveDir, `${archivePrefix}-paper-tables.md`), markdownTable, {
      encoding: 'utf8',
      mode: 0o600,
    });
    writeFileSync(join(archiveDir, `${archivePrefix}-paper-tables.tex`), latexTable, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  return summary;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const opts = parseAciCliArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    process.exit(0);
  }
  const summary = await runAciGovernanceBenchmark(opts);
  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `[${summary.benchmarkId} v${summary.version}] mode=${summary.mode} suite=${summary.suite} sandbox=${summary.sandboxBackend} concurrency=${summary.concurrency}${summary.resumed ? ` resumed=${summary.resumedExistingCount}` : ''}`,
    );
    for (const arm of summary.arms) {
      const m = summary.metrics.byArm[arm];
      console.log(
        `Arm ${arm} (${summary.armProfiles[arm].aciProfile}): pass=${m.passedTrials}/${m.totalTrials} ci95=[${m.passRateCI?.lower ?? 0},${m.passRateCI?.upper ?? 0}] recall=${m.criticalContextRecall} precision=${m.contextPrecision} fnr=${m.falseNegativeRate} usefulTok=${m.usefulTokenRatio} tokRed=${m.tokenReduction} pairedPassRed=${m.pairedPassTokenReduction ?? 'null'} tokPerPass=${m.tokensPerCompletedPass ?? 'null'} cache=${m.cacheHitRate} supTok=${m.supervisorCost.totalTokens} recov=${m.recoverySuccessRate}`,
      );
    }
  }
}
