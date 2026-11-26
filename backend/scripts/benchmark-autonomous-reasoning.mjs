#!/usr/bin/env node
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
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { redactSecrets } from '../src/envelope.js';
import {
  AUTONOMOUS_REASONING_BENCHMARK_ID,
  VERSION,
  applyWorkspaceFiles,
  buildAutonomousReasoningEvidenceOutput,
  computeAutonomousReasoningMetrics,
  createAutonomousReasoningDataset,
  getAutonomousReasoningReferenceFix,
  instantiateAutonomousReasoningWorkspace,
  resolveTaskCriticalContextFiles,
} from '../src/evaluation/autonomous-reasoning-benchmark.js';
import { removeFixtureWorkspace } from '../src/evaluation/fixtures.js';
import { parseCodexPatch, parsePatch } from '../src/patch-and-diagnostics.js';
import { BenchmarkSandbox, SANDBOX_MODES, runHardenedGitSync } from '../src/tools/benchmark-sandbox.js';
import { scanCommandSyntax } from '../src/tools/command-analyzer.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');

function printUsage() {
  console.log([
    `Usage: node backend/scripts/benchmark-autonomous-reasoning.mjs [options]`,
    '',
    'Options:',
    '  --mode <deterministic|real>   Evaluation mode (default: deterministic)',
    '  --baseline <path>             Baseline worktree path (e.g. b50da9b)',
    '  --candidate <path>            Candidate worktree path (default: current repo)',
    '  --output <path>               Output JSONL/JSON report file (mode 0600, redacted)',
    '  --tasks <id1,id2,...>         Filter subset of task IDs',
    '  --repeats <n>                 Paired repeats per task (1..20, default: 1)',
    '  --lane <idx>                  Worker shard index (default: 0)',
    '  --lanes <count>               Total worker shards (default: 1)',
    '  --sandbox <strong|docker|node-permission>  Sandbox mode (default: strong)',
    '  --experience-db <path>        SQLite path for cross-task ExperienceMemory',
    '  --experience-seed <jsonl>     Seed DB ONLY from trusted_server_verifier-passed JSONL runs',
    '  --experience-arm <both|candidate|baseline>  Which arm uses experience DB (default: both)',
    '  --json                        Print JSON summary to stdout',
    '  --help                        Show this help message',
  ].join('\n'));
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const opts = {
    mode: 'deterministic',
    baseline: null,
    candidate: null,
    output: null,
    tasks: null,
    repeats: 1,
    lane: 0,
    lanes: 1,
    sandbox: process.env.AGENT_US_BENCHMARK_SANDBOX_MODE || SANDBOX_MODES.STRONG,
    experienceDb: null,
    experienceSeed: null,
    experienceArm: 'both',
    json: false,
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--mode' && i + 1 < argv.length) opts.mode = String(argv[++i]);
    else if (arg.startsWith('--mode=')) opts.mode = arg.slice('--mode='.length);
    else if (arg === '--baseline' && i + 1 < argv.length) opts.baseline = argv[++i];
    else if (arg.startsWith('--baseline=')) opts.baseline = arg.slice('--baseline='.length);
    else if (arg === '--candidate' && i + 1 < argv.length) opts.candidate = argv[++i];
    else if (arg.startsWith('--candidate=')) opts.candidate = arg.slice('--candidate='.length);
    else if (arg === '--output' && i + 1 < argv.length) opts.output = argv[++i];
    else if (arg.startsWith('--output=')) opts.output = arg.slice('--output='.length);
    else if (arg === '--tasks' && i + 1 < argv.length) opts.tasks = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--tasks=')) opts.tasks = arg.slice('--tasks='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--repeats' && i + 1 < argv.length) opts.repeats = Number(argv[++i]);
    else if (arg.startsWith('--repeats=')) opts.repeats = Number(arg.slice('--repeats='.length));
    else if (arg === '--lane' && i + 1 < argv.length) opts.lane = Number(argv[++i]);
    else if (arg.startsWith('--lane=')) opts.lane = Number(arg.slice('--lane='.length));
    else if (arg === '--lanes' && i + 1 < argv.length) opts.lanes = Number(argv[++i]);
    else if (arg.startsWith('--lanes=')) opts.lanes = Number(arg.slice('--lanes='.length));
    else if (arg === '--sandbox' && i + 1 < argv.length) opts.sandbox = String(argv[++i]);
    else if (arg.startsWith('--sandbox=')) opts.sandbox = arg.slice('--sandbox='.length);
    else if (arg === '--experience-db' && i + 1 < argv.length) opts.experienceDb = argv[++i];
    else if (arg.startsWith('--experience-db=')) opts.experienceDb = arg.slice('--experience-db='.length);
    else if (arg === '--experience-seed' && i + 1 < argv.length) opts.experienceSeed = argv[++i];
    else if (arg.startsWith('--experience-seed=')) opts.experienceSeed = arg.slice('--experience-seed='.length);
    else if (arg === '--experience-arm' && i + 1 < argv.length) opts.experienceArm = String(argv[++i]);
    else if (arg.startsWith('--experience-arm=')) opts.experienceArm = arg.slice('--experience-arm='.length);
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown CLI flag: ${arg}`);
  }
  if (!opts.baseline && positional[0]) opts.baseline = positional[0];
  if (!opts.candidate && positional[1]) opts.candidate = positional[1];
  if (!opts.output && positional[2]) opts.output = positional[2];

  if (!['deterministic', 'real'].includes(opts.mode)) {
    throw new Error(`Unsupported --mode "${opts.mode}"; expected deterministic or real`);
  }
  if (!['both', 'candidate', 'baseline'].includes(opts.experienceArm)) {
    throw new Error(`Unsupported --experience-arm "${opts.experienceArm}"; expected both, candidate, or baseline`);
  }
  if (!Number.isInteger(opts.repeats) || opts.repeats < 1 || opts.repeats > 20) {
    throw new Error('--repeats must be an integer between 1 and 20');
  }
  if (!Number.isInteger(opts.lane) || !Number.isInteger(opts.lanes) || opts.lanes < 1 || opts.lane < 0 || opts.lane >= opts.lanes) {
    throw new Error('Invalid --lane / --lanes values');
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

function getWorktreeRevision(worktreeRoot) {
  const res = runHardenedGitSync(['rev-parse', 'HEAD'], { cwd: worktreeRoot, allowNetwork: false });
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

/**
 * Dynamically probes optional 2.4 runtime enhancements inside a target worktree
 * while falling back gracefully on baseline `b50da9b`.
 */
export async function loadAndProbeWorktreeArm(worktreeRoot) {
  const root = resolve(worktreeRoot);
  if (!existsSync(join(root, 'backend', 'src'))) {
    throw new Error(`Invalid worktree root (missing backend/src): ${root}`);
  }

  const [
    storeMod,
    poolMod,
    directMod,
    agentLoopMod,
    eventsMod,
    inferenceMod,
    verifierMod,
    contextMod,
    compactionMod,
    plannerMod,
    replannerMod,
    feedbackMod,
    memoryMod,
    toolsMod,
    dispatcherMod,
    reconMod,
    checkpointMod,
    sandboxMod,
    execReasoningMod,
    contractReasoningMod,
    aciEngineMod,
    supervisorMod,
    evalServiceMod,
  ] = await Promise.all([
    importRequired(root, 'store.js'),
    importRequired(root, 'pool.js'),
    importRequired(root, 'direct-agent.js'),
    importRequired(root, 'kernel/agent-loop.js'),
    importRequired(root, 'kernel/events.js'),
    importRequired(root, 'kernel/inference.js'),
    importRequired(root, 'governance/verifier.js'),
    importRequired(root, 'context.js'),
    importRequired(root, 'context/compaction.js'),
    importRequired(root, 'planning/planner.js'),
    importRequired(root, 'planning/replanner.js'),
    importRequired(root, 'planning/feedback.js'),
    importRequired(root, 'memory/service.js'),
    importRequired(root, 'workspace-tools.js'),
    importRequired(root, 'tools/dispatcher.js'),
    importRequired(root, 'durable/reconciliation.js'),
    importRequired(root, 'durable/checkpoint.js'),
    importRequired(root, 'tools/benchmark-sandbox.js'),
    importOptional(root, 'kernel/execution-reasoning.js'),
    importOptional(root, 'kernel/contract-reasoning.js'),
    importOptional(root, 'context/aci-engine.js'),
    importOptional(root, 'context/supervisor.js'),
    importOptional(root, 'evaluation/service.js'),
  ]);

  // Probe behavioral capabilities dynamically without assuming fixed file contents.
  const capabilities = {
    executionReasoningTracker: Boolean(execReasoningMod?.ExecutionReasoningTracker),
    contractReasoning: typeof contractReasoningMod?.extractTaskContract === 'function',
    aciEngine: typeof aciEngineMod?.ACIEngine === 'function',
    contextSupervisor: typeof supervisorMod?.ContextSupervisor === 'function',
    postEditStaleVerifier: false,
    unresolvedFailureVerifier: false,
    smartCompactionReadDedup: false,
    richCompactionAnchor: false,
    degenerateReplanGuard: false,
    experienceDistillation: false,
    reasoningMetricsSummary: typeof evalServiceMod?.summarizeReasoningMetrics === 'function',
  };

  try {
    const verifier = new verifierMod.EvidenceVerifier();
    const staleVerdict = verifier.verify({
      events: [
        { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: { command: 'node --test test/app.test.js' } } },
        { type: 'tool/result', data: { callId: 'c1', name: 'bash', isError: false, receipt: { id: 'r1', callId: 'c1', toolName: 'bash', status: 'finished', exitCode: 0 } } },
        { type: 'tool/call', data: { callId: 'c2', name: 'edit_file', arguments: { path: 'src/app.js' } } },
        { type: 'tool/result', data: { callId: 'c2', name: 'edit_file', isError: false, receipt: { id: 'r2', callId: 'c2', toolName: 'edit_file', status: 'finished' } } },
      ],
      text: 'Updated src/app.js.',
    });
    capabilities.postEditStaleVerifier = Boolean(
      staleVerdict?.reasons?.some((r) => /STALE_VERIFICATION_AFTER_EDIT/.test(r)),
    );
    const unresolvedVerdict = verifier.verify({
      events: [
        { type: 'tool/call', data: { callId: 'c1', name: 'write_file', arguments: { path: 'src/app.js' } } },
        { type: 'tool/result', data: { callId: 'c1', name: 'write_file', isError: false, receipt: { id: 'r1', callId: 'c1', toolName: 'write_file', status: 'finished' } } },
        { type: 'tool/call', data: { callId: 'c2', name: 'bash', arguments: { command: 'node --test test/app.test.js' } } },
        { type: 'tool/result', data: { callId: 'c2', name: 'bash', isError: true, receipt: { id: 'r2', callId: 'c2', toolName: 'bash', status: 'failed', exitCode: 1 } } },
      ],
      text: 'Applied changes.',
    });
    capabilities.unresolvedFailureVerifier = Boolean(
      unresolvedVerdict?.reasons?.some((r) => /UNRESOLVED_VERIFICATION_FAILURE/.test(r)),
    );
  } catch {
    // Graceful baseline fallback
  }

  try {
    if (typeof contextMod.compactTwoStage === 'function') {
      const longBody = 'LINE\n'.repeat(1200);
      const msgs = [
        { role: 'user', content: [{ type: 'text', text: 'Inspect src/a.js carefully.' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'r1', name: 'read_file', arguments: JSON.stringify({ path: 'src/a.js' }) }] },
        { role: 'tool', toolCallId: 'r1', content: [{ type: 'text', text: longBody }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'r2', name: 'read_file', arguments: JSON.stringify({ path: 'src/a.js' }) }] },
        { role: 'tool', toolCallId: 'r2', content: [{ type: 'text', text: longBody }] },
        { role: 'user', content: [{ type: 'text', text: 'Recent step ' + 'x'.repeat(300) }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Continue ' + 'y'.repeat(300) }] },
      ];
      const res = await contextMod.compactTwoStage(
        { messages: msgs },
        { contextWindow: 2200, reserveTokens: 256, keepRecentTokens: 120 },
      );
      const compactedText = JSON.stringify(res?.options?.messages ?? []);
      capabilities.smartCompactionReadDedup = /superseded read_file/i.test(compactedText);
    }
  } catch {
    // Graceful baseline fallback
  }

  try {
    const planner = new plannerMod.AdaptivePlanner({ permissionCeiling: 'full' });
    const replanner = new replannerMod.AdaptiveReplanner({ planner, permissionCeiling: 'full' });
    const basePlan = planner.createPlan({
      goal: 'Fix module',
      tasks: [{ taskKey: 'fix-1', objective: 'Fix module bug', taskType: 'bug-fix', permissionMode: 'auto-safe' }],
      budget: { maxSteps: 10 },
    });
    try {
      replanner.replan(basePlan, {}, { failedStrategies: [{ taskKey: 'fix-1', objective: 'Fix module bug', strategy: 'retry_same' }] });
    } catch (err) {
      if (err?.code === 'PLANNER_DEGENERATE_REPLAN_DENIED') {
        capabilities.degenerateReplanGuard = true;
      }
    }
  } catch {
    // Graceful baseline fallback
  }

  capabilities.experienceDistillation =
    typeof memoryMod.ExperienceMemoryService?.prototype?.distillTurnExperience === 'function';
  try {
    if (typeof compactionMod.MultiStageCompactor === 'function') {
      const anchorProbe = new compactionMod.MultiStageCompactor({ store: null });
      const anchor = anchorProbe.extractTaskStateAnchor(null);
      capabilities.richCompactionAnchor = Boolean(
        anchor &&
          typeof anchor === 'object' &&
          'verificationLedger' in anchor &&
          'falsifiedAttempts' in anchor,
      );
    }
  } catch {
    capabilities.richCompactionAnchor = false;
  }

  const modules = {
    Store: storeMod.Store,
    AccountPool: poolMod.AccountPool,
    DirectAgentRuntime: directMod.DirectAgentRuntime,
    BenchmarkSandbox: sandboxMod.BenchmarkSandbox,
    AgentLoop: agentLoopMod.AgentLoop,
    DecisionEngine: agentLoopMod.DecisionEngine,
    EventRouter: eventsMod.EventRouter,
    InferenceEngine: inferenceMod.InferenceEngine,
    EvidenceVerifier: verifierMod.EvidenceVerifier,
    compactTwoStage: contextMod.compactTwoStage,
    MultiStageCompactor: compactionMod.MultiStageCompactor,
    AdaptivePlanner: plannerMod.AdaptivePlanner,
    AdaptiveReplanner: replannerMod.AdaptiveReplanner,
    PlannerFeedbackCollector: feedbackMod.PlannerFeedbackCollector,
    ExperienceMemoryService: memoryMod.ExperienceMemoryService,
    createWorkspaceTools: toolsMod.createWorkspaceTools,
    ToolDispatcher: dispatcherMod.ToolDispatcher,
    UnknownOutcomeReconciler: reconMod.UnknownOutcomeReconciler,
    CheckpointStore: checkpointMod.CheckpointStore,
    ExecutionReasoningTracker: execReasoningMod?.ExecutionReasoningTracker ?? null,
  };
  for (const [name, exported] of Object.entries(modules)) {
    if (name === 'ExecutionReasoningTracker') continue;
    if (typeof exported !== 'function') {
      throw new Error(`Missing required export "${name}" from worktree ${root}`);
    }
  }

  return {
    root,
    revision: getWorktreeRevision(root),
    capabilities,
    modules,
  };
}

class DeterministicProbeAdapter extends LlmAdapter {
  constructor({ task, workspaceRoot, sandbox, requirePostEditVerify }) {
    super();
    this.task = task;
    this.workspaceRoot = workspaceRoot;
    this.sandbox = sandbox;
    this.requirePostEditVerify = requirePostEditVerify;
    this.step = 0;
  }

  async *stream(opts) {
    this.step += 1;
    const msgs = opts.messages ?? [];
    const sawRepair = msgs.some(
      (m) =>
        m.role === 'user' &&
        (m.content ?? []).some((b) =>
          /output_truncated|被截断|验证未通过|复测/i.test(
            String(b?.text ?? ''),
          ),
        ),
    );
    const hasToolResult = (id) => msgs.some((m) => m.role === 'tool' && m.toolCallId === id);

    // Phase 1: For post-edit verification sensitive tasks, first run baseline test -> apply edit AFTER test
    // without re-running verification, letting the arm's EvidenceVerifier catch (or miss) stale verification.
    if (this.requirePostEditVerify && !hasToolResult('initial-test')) {
      const cmd = this.task.fixture.baselineTestCommand.join(' ');
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'initial-test', name: 'bash', arguments: JSON.stringify({ command: cmd }) },
      };
      yield { type: 'usage', usage: { inputTokens: 180, outputTokens: 35 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    if (this.requirePostEditVerify && !hasToolResult('post-test-edit')) {
      // Write a file (on ar-02 write only surface checkout.js first so stale verifier or hidden test exposes gap;
      // on ar-06 write only backoff.js leaving window.js buggy;
      // on repair round after verifier catches STALE_VERIFICATION_AFTER_EDIT / UNRESOLVED_VERIFICATION_FAILURE,
      // apply full root-cause fix + re-run tests).
      const targetFiles = this.task.id === 'ar-02-complex-bug-root-cause'
        ? {
            'src/pricing/checkout.js': [
              "import { applyDiscount } from './discount.js';",
              "import { computeTax } from './tax.js';",
              'export function checkout({ items, coupon = null, region = "US" }) {',
              '  const discounted = applyDiscount(items, coupon);',
              '  const taxCents = computeTax(discounted.lines, region);',
              '  return {',
              '    subtotalCents: discounted.subtotalCents,',
              '    discountedSubtotalCents: discounted.discountedSubtotalCents,',
              '    taxCents,',
              '    totalCents: Math.round(discounted.discountedSubtotalCents + taxCents),',
              '    lines: discounted.lines,',
              '  };',
              '}',
            ].join('\n') + '\n',
          }
        : getAutonomousReasoningReferenceFix(this.task.id, this.workspaceRoot);
      const entries = Object.entries(targetFiles);
      const [firstRel, firstBody] = entries[0];
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'post-test-edit',
          name: 'write_file',
          arguments: JSON.stringify({ path: firstRel, content: firstBody }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 210, outputTokens: 60 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    if (this.requirePostEditVerify && !sawRepair && !hasToolResult('final-verify')) {
      // Simulate an objective truncated turn (max-tokens / output_truncated) so EvidenceVerifier triggers a repair round.
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify(buildAutonomousReasoningEvidenceOutput(this.task).output).slice(0, 80),
      };
      yield { type: 'usage', usage: { inputTokens: 190, outputTokens: 50 } };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
      return;
    }

    if (sawRepair && !hasToolResult('final-verify')) {
      const refFix = getAutonomousReasoningReferenceFix(this.task.id, this.workspaceRoot);
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
          id: 'repair-write',
          name: 'write_file',
          arguments: JSON.stringify({ path: lastRel, content: lastBody }),
        },
      };
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'final-verify',
          name: 'bash',
          arguments: JSON.stringify({ command: this.task.metadata.acceptanceCriteria.testCommand.join(' ') }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 240, outputTokens: 75 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    // Standard deterministic path for remaining tasks: write deliverables & run public verification command
    if (!hasToolResult('apply-ref') && !this.requirePostEditVerify) {
      const refFix = getAutonomousReasoningReferenceFix(this.task.id, this.workspaceRoot);
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
          id: 'apply-ref',
          name: 'write_file',
          arguments: JSON.stringify({ path: lastRel, content: lastBody }),
        },
      };
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'run-tests',
          name: 'bash',
          arguments: JSON.stringify({ command: this.task.metadata.acceptanceCriteria.testCommand.join(' ') }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 220, outputTokens: 80 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    const out = buildAutonomousReasoningEvidenceOutput(this.task);
    yield { type: 'text-delta', index: 0, text: JSON.stringify(out.output) };
    yield { type: 'usage', usage: { inputTokens: 160, outputTokens: 55 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function computeTrialCriticalContextRecall({ task, reasoningMetrics = null } = {}) {
  const criticalFiles = resolveTaskCriticalContextFiles(task);
  const normCritical = [...new Set(
    criticalFiles.map((f) => String(f ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()).filter(Boolean),
  )];
  if (!normCritical.length) return 1;
  const readBeforeEdit = (reasoningMetrics?.rootCauseFilesReadBeforeEdit ?? [])
    .map((f) => String(f ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase())
    .filter(Boolean);
  const hits = normCritical.filter((c) =>
    readBeforeEdit.some((r) => r === c || r.endsWith(`/${c}`) || c.endsWith(`/${r}`)),
  ).length;
  const readRecall = hits / normCritical.length;
  const aciRecall = reasoningMetrics?.aciMetrics?.criticalContextRecall;
  if (
    aciRecall != null &&
    Number.isFinite(Number(aciRecall)) &&
    Number(reasoningMetrics?.aciMetrics?.epochTransitions ?? 0) > 0
  ) {
    return Number(Math.min(readRecall, Math.max(0, Math.min(1, Number(aciRecall)))).toFixed(4));
  }
  return Number(readRecall.toFixed(4));
}

export function computeTrialContractCompliance({ judgment, reasoningMetrics = null } = {}) {
  const ev = judgment?.evidence ?? {};
  const sig = reasoningMetrics?.contractComplianceSignals ?? null;
  const readyOk = sig?.evaluated ? sig.ready === true : true;
  return Boolean(
    judgment?.passed &&
      ev.evidenceCompliant !== false &&
      ev.historyUntouched !== false &&
      ev.baselineTestsUntampered !== false &&
      ev.protectedFilesUntampered !== false &&
      ev.dependencyPolicyPassed !== false &&
      ev.checks?.changedFiles !== false &&
      readyOk,
  );
}

export function seedVerifiedExperienceFromJsonl({ jsonlPath, store, memory, dataset = [] } = {}) {
  const raw = readFileSync(jsonlPath, 'utf8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const taskById = new Map((dataset ?? []).map((t) => [t.id, t]));
  let loadedRows = 0;
  let seededCount = 0;
  let skippedCount = 0;

  for (let idx = 0; idx < lines.length; idx += 1) {
    let row = null;
    try {
      row = JSON.parse(lines[idx]);
    } catch {
      skippedCount += 1;
      continue;
    }
    loadedRows += 1;
    const ev = row?.judge?.evidence ?? row?.evidence ?? null;
    const isTrustedVerifiedPass = Boolean(
      row &&
        typeof row === 'object' &&
        row.taskId &&
        row.passed === true &&
        row.hardVetoed !== true &&
        row.judge?.hardVetoed !== true &&
        (row.status === undefined || row.status === 'passed') &&
        ev?.hiddenAcceptancePassed === true &&
        ev?.baselineTestsUntampered !== false &&
        ev?.historyUntouched !== false &&
        ev?.independentVerdictSource === 'trusted_server_verifier',
    );
    if (!isTrustedVerifiedPass) {
      skippedCount += 1;
      continue;
    }

    const taskId = String(row.taskId);
    const evalRunId = `seed-eval-${idx + 1}-${taskId}`;
    let existing = null;
    if (typeof store?.get === 'function') {
      try {
        existing = store.get('evaluation_runs', evalRunId);
      } catch {
        existing = null;
      }
    }
    if (!existing && typeof store?.add === 'function') {
      store.add(
        'evaluation_runs',
        {
          id: evalRunId,
          benchmarkId: AUTONOMOUS_REASONING_BENCHMARK_ID,
          benchmarkVersion: VERSION,
          status: 'completed',
          projectId: taskId,
          evaluationProjectId: taskId,
          synthetic: true,
          score: { total: 1, passed: 1, failed: 0, cancelled: 0, timedOut: 0 },
          results: [{ taskId, status: 'passed', passed: true }],
          createdAt: Date.now(),
          finishedAt: Date.now(),
        },
        null,
        null,
        evalRunId,
      );
    }

    const taskObj = taskById.get(taskId) ?? null;
    const distilled = memory.distillTurnExperience({
      projectId: taskId,
      input: taskObj?.objective ?? taskObj?.prompt ?? taskId,
      summary: row.assistantExcerpt || `Verified solution for ${taskId}`,
      verdict: { verdict: 'pass', accepted: true },
      reasoningMetrics: row.reasoningMetrics ?? null,
      modifiedFiles: Array.isArray(ev?.actualChangedFiles) ? ev.actualChangedFiles : [],
      source: 'evaluation',
      sourceTaskId: taskId,
      runId: evalRunId,
      sourceArtifact: ev?.artifactDigest ?? null,
      evaluationEvidence: {
        sourceTaskId: taskId,
        evaluationRunId: evalRunId,
        projectId: taskId,
        score: { total: 1, passed: 1, failed: 0, cancelled: 0, timedOut: 0 },
        passed: true,
      },
    });
    if (Array.isArray(distilled) && distilled.length > 0 && distilled.every((d) => d.verified === true)) {
      seededCount += distilled.length;
    } else {
      skippedCount += 1;
    }
  }
  return { loadedRows, seededCount, skippedCount };
}

export function recordArmExperienceMemory({
  store,
  memory,
  task,
  armName,
  rep,
  workspaceRoot,
  verdict,
  reasoningMetrics = null,
  toolReceipts = [],
  modifiedFiles = [],
  passed = false,
  reason = '',
  now = Date.now(),
}) {
  if (typeof memory.distillTurnExperience === 'function') {
    const evaluationRunId = `eval-${armName}-${rep}-${task.id}`;
    if (passed && typeof store?.add === 'function') {
      store.add(
        'evaluation_runs',
        {
          id: evaluationRunId,
          benchmarkId: AUTONOMOUS_REASONING_BENCHMARK_ID,
          benchmarkVersion: VERSION,
          status: 'completed',
          projectId: task.id,
          evaluationProjectId: task.id,
          synthetic: true,
          score: { total: 1, passed: 1, failed: 0, cancelled: 0, timedOut: 0 },
          results: [{ taskId: task.id, status: 'passed', passed: true }],
          createdAt: now,
          finishedAt: Date.now(),
        },
        null,
        null,
        evaluationRunId,
      );
    }
    const distilled = memory.distillTurnExperience({
      projectId: task.id,
      input: task.objective,
      workspaceRoot,
      verdict,
      reasoningMetrics,
      toolReceipts,
      modifiedFiles,
      evaluationEvidence: passed
        ? {
            sourceTaskId: task.id,
            evaluationRunId,
            projectId: task.id,
            score: { total: 1, passed: 1 },
          }
        : null,
    });
    return Array.isArray(distilled) ? distilled.length > 0 : Boolean(distilled);
  }
  const items = memory.extract(`[lesson] ${task.id}: ${passed ? 'passed' : reason}`, {
    projectId: task.id,
    source: 'deterministic_probe',
  });
  return items.length > 0;
}

async function runDeterministicArmTrial({ task, armName, armRuntime, rep, judgeSandbox }) {
  const started = performance.now();
  const stateDir = mkdtempSync(join(tmpdir(), `agent-us-ar-det-${armName}-`));
  const workspaceRoot = await instantiateAutonomousReasoningWorkspace(task, {
    prefix: `agent-us-ar-ws-${armName}-`,
  });
  const {
    Store,
    AgentLoop,
    DecisionEngine,
    EventRouter,
    InferenceEngine,
    EvidenceVerifier,
    MultiStageCompactor,
    compactTwoStage,
    AdaptivePlanner,
    AdaptiveReplanner,
    ExperienceMemoryService,
    createWorkspaceTools,
    ToolDispatcher,
    UnknownOutcomeReconciler,
    CheckpointStore,
  } = armRuntime.modules;

  const store = new Store(join(stateDir, 'eval.sqlite'));
  try {
    const sessionId = `sess-${task.id}-${armName}-${rep}`;
    const turnId = `turn-${task.id}-${armName}-${rep}`;
    const now = Date.now();
    store.db
      .prepare('INSERT INTO direct_sessions(id,title,workspaceRoot,model,permissionMode,state,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)')
      .run(sessionId, task.title, workspaceRoot, 'deterministic-probe', 'auto-safe', 'running', now, now);
    store.db
      .prepare('INSERT INTO direct_turns(id,sessionId,input,model,state,phase,step,createdAt) VALUES(?,?,?,?,?,?,?,?)')
      .run(turnId, sessionId, task.prompt, 'deterministic-probe', 'running', 'init', 0, now);

    // Exercise MultiStageCompactor + compactTwoStage on long-horizon tasks
    let compactionProbe = null;
    if (task.id === 'ar-10-long-horizon-delivery' || task.id === 'ar-01-unfamiliar-codebase') {
      const compactor = new MultiStageCompactor({ store });
      for (let i = 0; i < 8; i++) {
        store.db
          .prepare('INSERT INTO direct_messages(sessionId,turnId,role,content,createdAt) VALUES(?,?,?,?,?)')
          .run(sessionId, turnId, i % 2 === 0 ? 'user' : 'assistant', i === 0 ? task.prompt : `Step ${i} verification note`, now + i);
      }
      const compacted = await compactor.compactSession(sessionId, { keepRecent: 2 });
      const twoStage = await compactTwoStage(
        {
          messages: [
            { role: 'user', content: [{ type: 'text', text: task.objective }] },
            { role: 'assistant', content: [{ type: 'tool-call', id: 'probe-bash-1', name: 'bash', arguments: '{"command":"node --test"}' }] },
            { role: 'tool', toolCallId: 'probe-bash-1', content: [{ type: 'text', text: 'LOG_LINE\n'.repeat(1200) }] },
            { role: 'user', content: [{ type: 'text', text: 'Proceed with verification ' + 'E'.repeat(900) }] },
          ],
        },
        { contextWindow: 3000, reserveTokens: 512, keepRecentTokens: 200 },
      );
      compactionProbe = {
        compacted: Boolean(compacted?.compacted),
        stage: twoStage?.stage ?? 'none',
        twoStageCompacted: Boolean(twoStage?.compacted),
      };
    }

    // Exercise AdaptiveReplanner on recovery/multi-agent tasks
    let replanTriggered = false;
    let replanSucceeded = false;
    let degenerateReplanBlocked = false;
    if (task.id === 'ar-08-mid-task-recovery' || task.id === 'ar-09-multi-agent-collab') {
      replanTriggered = true;
      const planner = new AdaptivePlanner({ permissionCeiling: 'full' });
      const replanner = new AdaptiveReplanner({ planner, permissionCeiling: 'full' });
      const plan = planner.createPlan({
        goal: task.objective,
        tasks: [{ taskKey: 'stage-1', objective: 'Initial attempt', taskType: 'recovery', permissionMode: 'auto-safe' }],
        budget: { maxSteps: 12 },
      });
      try {
        replanner.replan(plan, {}, {
          failedStrategies: [{ taskKey: 'stage-1', objective: 'Initial attempt', strategy: 'retry_same' }],
        });
      } catch (err) {
        degenerateReplanBlocked = err?.code === 'PLANNER_DEGENERATE_REPLAN_DENIED';
      }
      try {
        const nextPlan = replanner.replan(plan, {
          tasks: [{ taskKey: 'stage-1', objective: 'Pivot: checkpoint + fence recovery', taskType: 'recovery', permissionMode: 'auto-safe' }],
        });
        replanSucceeded = nextPlan.planVersion === 2;
      } catch {
        replanSucceeded = false;
      }
    }

    const eventRouter = new EventRouter(store);
    const emittedRepairEvents = [];
    eventRouter.subscribe(sessionId, (ev) => {
      if (ev?.type === 'verifier/repair') emittedRepairEvents.push(ev);
    });
    const reconciler = new UnknownOutcomeReconciler(store, eventRouter);
    const checkpointStore = new CheckpointStore(store);
    const verifier = new EvidenceVerifier({ store, eventRouter });

    // Scope workspace sandbox cleanly for bash execution inside AgentLoop
    const loopSandbox = new BenchmarkSandbox({
      ...buildSandboxOptions(judgeSandbox.mode),
      workspaceRoot,
      allowWorkspaceNodeCli: Boolean(task.metadata?.sandboxIsolation?.allowWorkspaceNodeCli),
      timeoutMs: 30_000,
    });
    const tools = createWorkspaceTools({
      workspaceRoot,
      dataRoot: stateDir,
      store,
      sessionId,
      permissionMode: 'auto-safe',
      nonce: '0123456789abcdef0123456789abcdef',
      sandbox: loopSandbox,
    });
    const dispatcher = new ToolDispatcher({ store, eventRouter, reconciler });

    const requirePostEditVerify = ['ar-02-complex-bug-root-cause', 'ar-06-test-failure-repair'].includes(task.id);
    const adapter = new DeterministicProbeAdapter({
      task,
      workspaceRoot,
      sandbox: loopSandbox,
      requirePostEditVerify,
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
      if (['write_file', 'edit_file', 'apply_patch', 'read_file', 'query_symbol_graph', 'run_diagnostics'].includes(tool)) {
        return { allowed: true, argsDigest };
      }
      return { allowed: false, argsDigest };
    };

    const loopResult = await loop.run({
      sessionId,
      turnId,
      profile: { name: 'eval', defaultMaxSteps: 12, streamDeltas: false, persistTurn: true },
      input: task.prompt,
      model: 'deterministic-probe',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Deterministic autonomous reasoning probe.' }] },
        { role: 'user', content: [{ type: 'text', text: task.prompt }] },
      ],
      tools,
      toolDispatcher: dispatcher,
      permissionMode: 'auto-safe',
      requestApproval,
      budget: { maxSteps: 12 },
      workspaceRoot,
      execution: { requirePostEditVerification: true },
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

    const output = buildAutonomousReasoningEvidenceOutput(task);
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

    // Exercise ExperienceMemoryService distillation/fallback
    const memory = new ExperienceMemoryService({ store, projectId: task.id });
    const memoryRecorded = recordArmExperienceMemory({
      store,
      memory,
      task,
      armName,
      rep,
      workspaceRoot,
      verdict: loopResult.verdict,
      reasoningMetrics: loopResult.reasoningMetrics ?? null,
      toolReceipts: enrichedReceipts,
      modifiedFiles: judgment.evidence.actualChangedFiles,
      passed: Boolean(judgment.passed),
      reason: judgment.reason,
      now,
    });

    const durationMs = Math.round(performance.now() - started);
    const rm = loopResult.reasoningMetrics ?? {};
    const verifierRepairEvents = (loopResult.verifierEvents ?? []).filter((e) => e.type === 'verifier/repair').length;
    const repairRounds = Math.max(
      Number(rm.repairRounds ?? 0),
      verifierRepairEvents,
      emittedRepairEvents.length,
    );

    const inputTok = Number(loopResult.usage?.inputTokens ?? 0);
    const cacheReadTok = Number(loopResult.usage?.cacheReadTokens ?? 0);
    const criticalContextRecall = computeTrialCriticalContextRecall({ task, reasoningMetrics: rm });
    const contractCompliance = computeTrialContractCompliance({ judgment, reasoningMetrics: rm });
    const cacheHitRate = inputTok > 0 ? Number(Math.min(1, cacheReadTok / inputTok).toFixed(4)) : 0;

    return {
      taskId: task.id,
      area: task.area,
      arm: armName,
      revision: armRuntime.revision,
      rep,
      passed: Boolean(judgment.passed),
      status: judgment.passed ? 'passed' : 'failed',
      attempts: 1 + repairRounds,
      repairRounds,
      rootCauseAccurate: Boolean(judgment.evidence.rootCauseMatch),
      firstFixSucceeded: Boolean(judgment.passed && repairRounds === 0 && !rm.selfCorrectionRecovered),
      regressionPassed: Boolean(judgment.evidence.regressionPassed),
      contractCompliance,
      criticalContextRecall,
      cacheHitRate,
      ineffectiveActionCount: Number(rm.ineffectiveActionCount ?? (judgment.passed ? 0 : 1)),
      replanTriggered,
      replanSucceeded: replanTriggered && replanSucceeded && judgment.passed,
      degenerateReplanBlocked,
      isRecoveryTask: Boolean(task.metadata.recoveryRequirements),
      recoverySucceeded: Boolean(task.metadata.recoveryRequirements && judgment.passed),
      tokenUsage: loopResult.usage,
      tokenCost: Number(loopResult.usage?.inputTokens ?? 0) + Number(loopResult.usage?.outputTokens ?? 0),
      durationMs,
      failureCategory: judgment.evidence.failureCategory,
      failureAttribution: judgment.evidence.failureAttribution,
      probedCapabilities: armRuntime.capabilities,
      compactionProbe,
      memoryRecorded,
      judge: judgment,
    };
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    await removeFixtureWorkspace(workspaceRoot).catch(() => {});
  }
}

function parseJsonField(raw, fallback = null) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

function normalizeRelativeRepoPath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  if (rawPath.includes('\0')) return null;
  let trimmed = rawPath.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    return null;
  }
  trimmed = trimmed.replaceAll('\\', '/');
  while (trimmed.startsWith('./')) trimmed = trimmed.slice(2);
  trimmed = trimmed.replace(/\/{2,}/g, '/');
  if (!trimmed || trimmed === '.') return null;
  const parts = [];
  for (const seg of trimmed.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

function buildSafeArgsSummary(toolName, args) {
  if (!args || typeof args !== 'object') return '';
  let raw = '';
  if (toolName === 'bash') {
    raw = String(args.command ?? '');
  } else if (['write_file', 'edit_file', 'read_file'].includes(toolName)) {
    raw = String(args.path ?? args.filePath ?? '');
  } else if (toolName === 'query_symbol_graph' || toolName === 'run_diagnostics') {
    raw = String(args.symbol ?? args.path ?? args.filePath ?? '');
  } else if (toolName === 'apply_patch') {
    const patchText = String(args.patch ?? args.patchText ?? args.input ?? '');
    try {
      const { hunks } = parsePatch(patchText, { format: 'auto' });
      raw = `patch: ${hunks.map((h) => h.path).filter(Boolean).join(', ')}`;
    } catch {
      raw = 'patch: invalid';
    }
  } else {
    try {
      raw = JSON.stringify(args);
    } catch {
      raw = '';
    }
  }
  return redactSecrets(raw).replace(/\s+/g, ' ').trim().slice(0, 160);
}

function buildCallMetaMap(assistantMessageRows = []) {
  const byId = new Map();
  for (const row of Array.isArray(assistantMessageRows) ? assistantMessageRows : []) {
    const calls = parseJsonField(row?.toolCalls ?? row, null);
    if (!Array.isArray(calls)) continue;
    for (const tc of calls) {
      if (!tc?.id) continue;
      const args = parseJsonField(tc.arguments, {});
      const name = String(tc.name ?? '');
      const command = typeof args?.command === 'string' ? args.command.trim() : '';
      byId.set(String(tc.id), {
        name,
        command,
        argsSummary: buildSafeArgsSummary(name, args),
      });
    }
  }
  return byId;
}

export function resolveRealTrialFirstFixSucceeded({
  passed,
  repairRounds = 0,
  reasoningMetrics = null,
} = {}) {
  return Boolean(
    passed &&
    Number(repairRounds || 0) === 0 &&
    reasoningMetrics?.firstFixSucceeded !== false,
  );
}

export function enrichReceiptsWithCommands(receipts = [], assistantMessageRows = []) {
  const callMetaById = buildCallMetaMap(assistantMessageRows);
  return (Array.isArray(receipts) ? receipts : []).map((r) => {
    const meta = r?.callId ? callMetaById.get(String(r.callId)) : null;
    return {
      ...r,
      command: (typeof r?.command === 'string' && r.command.trim()) ? r.command : (meta?.command ?? ''),
    };
  });
}

export function authorizeRealBenchmarkApproval({
  toolName,
  args = {},
  allowedTestCommands = new Set(),
  protectedSet = new Set(),
  allowWorkspaceNodeCli = false,
} = {}) {
  const tool = String(toolName ?? '').trim();
  const normProtected = new Set();
  for (const p of protectedSet ?? []) {
    const norm = normalizeRelativeRepoPath(String(p ?? ''));
    if (norm) normProtected.add(norm);
  }

  if (tool === 'query_symbol_graph' || tool === 'run_diagnostics') {
    return true;
  }

  if (tool === 'write_file' || tool === 'edit_file') {
    const normPath = normalizeRelativeRepoPath(args?.path ?? args?.filePath ?? '');
    return Boolean(normPath) && !normProtected.has(normPath);
  }

  if (tool === 'apply_patch') {
    const patchText =
      typeof args?.patch === 'string'
        ? args.patch
        : typeof args?.patchText === 'string'
          ? args.patchText
          : typeof args?.input === 'string'
            ? args.input
            : '';
    if (!patchText) return false;
    let hunks;
    try {
      hunks = parsePatch(patchText, { format: 'auto' }).hunks;
    } catch {
      return false;
    }
    if (!Array.isArray(hunks) || hunks.length === 0) return false;
    for (const hunk of hunks) {
      if (!hunk || hunk.type === 'delete' || hunk.moveTo) return false;
      const normPath = normalizeRelativeRepoPath(hunk.path ?? '');
      if (!normPath || normProtected.has(normPath)) return false;
    }
    return true;
  }

  if (tool === 'bash') {
    const cmd = String(args?.command ?? '').trim();
    if (!cmd) return false;
    if (/[;&|><`\r\n$]/.test(cmd)) return false;
    const { tokens, hasCompound, hasSubstitution, unbalancedQuotes } = scanCommandSyntax(cmd);
    if (hasCompound || hasSubstitution || unbalancedQuotes || !tokens.length) return false;
    if (tokens.some((tok) => tok === '..' || tok.includes('../') || tok.includes('..\\') || tok.startsWith('/'))) {
      return false;
    }

    const allowedSet = new Set();
    for (const c of allowedTestCommands ?? []) {
      const normalized = String(c ?? '').replace(/\s+/g, ' ').trim();
      if (normalized) allowedSet.add(normalized);
    }
    const collapsed = tokens.join(' ');
    if (allowedSet.has(cmd) || allowedSet.has(collapsed)) return true;
    if (cmd === 'node --test' || cmd === 'npm test' || cmd === 'npm run test') return true;
    if (
      /^node\s+--test(?:\s+[A-Za-z0-9._\/-]+)+$/.test(cmd) &&
      !tokens.slice(2).some((tok) => tok.startsWith('-'))
    ) {
      return true;
    }
    if (
      allowWorkspaceNodeCli === true &&
      /^node\s+(?:bin|src)\/[A-Za-z0-9._\/-]+(?:\s+[A-Za-z0-9._:\/=-]+)*$/.test(cmd)
    ) {
      return true;
    }
    return false;
  }

  return false;
}

export function extractTurnDiagnosticsFromEvents(eventRows = [], receipts = [], assistantMessageRows = [], benchKey = '') {
  const callMetaById = buildCallMetaMap(assistantMessageRows);
  const stepByCallId = new Map();
  let reasoningMetrics = null;
  let experienceMemory = null;
  const thrashingWarnings = [];
  let repairRounds = 0;
  let turnErrorCode = null;

  for (const ev of Array.isArray(eventRows) ? eventRows : []) {
    const type = String(ev?.type ?? '');
    const data = parseJsonField(ev?.data, null);
    if (!data || typeof data !== 'object') continue;

    if (type === 'tool/call' && data.callId && data.step != null) {
      stepByCallId.set(String(data.callId), Number(data.step));
    } else if (type === 'loop/thrashing_warning') {
      thrashingWarnings.push(safeRedactValue(data, benchKey));
    } else if (type === 'verifier/repair') {
      repairRounds += 1;
    } else if (type === 'turn/completed' || type === 'turn/failed' || type === 'turn/cancelled') {
      if (data.reasoningMetrics && typeof data.reasoningMetrics === 'object') {
        reasoningMetrics = safeRedactValue(data.reasoningMetrics, benchKey);
      }
      if (data.experienceMemory && typeof data.experienceMemory === 'object') {
        experienceMemory = safeRedactValue(data.experienceMemory, benchKey);
      }
      if (type === 'turn/failed' && data.code) {
        turnErrorCode = String(data.code);
      }
    }
  }

  const toolCallTrace = (Array.isArray(receipts) ? receipts : []).map((r, idx) => {
    const callId = r?.callId ? String(r.callId) : null;
    const meta = callId ? callMetaById.get(callId) : null;
    const rawArgsSummary = meta?.argsSummary || (r?.command ? redactSecrets(String(r.command)).slice(0, 160) : '');
    return {
      step: callId && stepByCallId.has(callId) ? stepByCallId.get(callId) : idx + 1,
      callId,
      name: String(r?.toolName ?? meta?.name ?? ''),
      status: String(r?.status ?? 'unknown'),
      exitCode: r?.exitCode ?? null,
      errorCode: r?.errorCode ?? null,
      argsSummary: safeRedactValue(rawArgsSummary, benchKey),
    };
  });

  if (reasoningMetrics && Number.isFinite(Number(reasoningMetrics.repairRounds))) {
    repairRounds = Math.max(repairRounds, Number(reasoningMetrics.repairRounds));
  }

  return {
    reasoningMetrics,
    experienceMemory,
    thrashingWarnings,
    repairRounds,
    turnErrorCode,
    toolCallTrace,
  };
}

async function runRealArmTrial({ task, armName, armRuntime, rep, position, benchKey, endpoint, requestedModel, judgeSandbox, experienceDbPath = null, experienceArm = 'both' }) {
  const started = performance.now();
  const stateDir = mkdtempSync(join(tmpdir(), `agent-us-ar-real-${armName}-`));
  const workspaceRoot = await instantiateAutonomousReasoningWorkspace(task, {
    prefix: `agent-us-ar-realws-${armName}-`,
  });
  const { Store, AccountPool, DirectAgentRuntime, BenchmarkSandbox: ArmSandbox, ExperienceMemoryService } = armRuntime.modules;
  const store = new Store(join(stateDir, 'eval.sqlite'));
  const pool = new AccountPool(store, { root: stateDir });
  pool.createAccount({
    preset: 'workbuddy',
    label: 'paired-ar-benchmark',
    credential: benchKey,
    protocol: 'openai',
    endpoint: endpoint.href,
    models: [requestedModel],
  });
  pool.setDefaultModel(requestedModel);

  const direct = new DirectAgentRuntime(store, pool, {
    dataRoot: stateDir,
    defaultWorkspace: workspaceRoot,
  });
  const useExperience = Boolean(experienceDbPath) && (experienceArm === 'both' || experienceArm === armName);
  let expStore = null;
  let expMemory = null;
  if (useExperience) {
    expStore = new Store(experienceDbPath);
    expMemory = new ExperienceMemoryService({ store: expStore });
    direct.attachIntelligenceServices?.({ memory: expMemory });
  }
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
  const repairEvents = [];
  let unsub = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== endpoint.origin || !url.pathname.endsWith('/chat/completions')) {
      return originalFetch(input, init);
    }
    const rec = { http: null, ms: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const t0 = performance.now();
    wireRecords.push(rec);
    const res = await originalFetch(input, init);
    rec.http = res.status;
    const wirePromise = res.clone().text().then((body) => {
      for (const line of body.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.usage) {
            const u = parsed.usage;
            rec.inputTokens = Number(u.prompt_tokens ?? u.input_tokens ?? rec.inputTokens ?? 0);
            rec.outputTokens = Number(u.completion_tokens ?? u.output_tokens ?? rec.outputTokens ?? 0);
            const cr = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? u.prompt_cache_hit_tokens;
            const cw = u.cache_creation_input_tokens ?? u.prompt_tokens_details?.cache_creation_tokens;
            if (cr != null && Number.isFinite(Number(cr))) rec.cacheReadTokens = Number(cr);
            if (cw != null && Number.isFinite(Number(cw))) rec.cacheWriteTokens = Number(cw);
          }
        } catch {
          // ignore non-json SSE lines
        }
      }
    }).catch(() => {}).finally(() => {
      rec.ms = Math.round(performance.now() - t0);
    });
    pendingWirePromises.push(wirePromise);
    return res;
  };

  try {
    const session = direct.createSession({
      workspaceRoot,
      projectId: task.id,
      model: requestedModel,
      permissionMode: 'auto-safe',
      budget: { maxSteps: task.resourceBudget?.maxSteps ?? 20, maxOutputTokens: 8192, maxTotalTokens: 160_000 },
      sandbox: sessionSandbox,
      disableWorkspaceHooks: true,
      disableWorkspaceMcp: true,
      trafficSource: 'benchmark',
      isSynthetic: true,
    });
    const allowedTestCommands = new Set([
      task.fixture.baselineTestCommand.join(' '),
      task.metadata.acceptanceCriteria.testCommand.join(' '),
    ]);
    const protectedSet = new Set([
      ...(task.fixture.baselineTestFiles ?? []),
      ...(task.id === 'ar-10-long-horizon-delivery' ? ['CONSTRAINTS.md'] : []),
      ...(task.id === 'ar-07-multi-stage-dev' ? ['SPEC.md'] : []),
      ...(task.id === 'ar-01-unfamiliar-codebase'
        ? Object.keys(task.fixture.files ?? {}).filter((p) => p.startsWith('src/'))
        : []),
    ]);
    unsub = direct.subscribe(session.id, (evt) => {
      if (evt.type === 'verifier/repair') repairEvents.push(evt.data);
      if (evt.type === 'approval/requested') {
        const a = evt.data;
        const allow = authorizeRealBenchmarkApproval({
          toolName: a.tool,
          args: a.arguments,
          allowedTestCommands,
          protectedSet,
          allowWorkspaceNodeCli,
        });
        queueMicrotask(() => direct.decideApproval(a.approvalId, { decision: allow ? 'allow' : 'deny', scope: 'once', reason: 'Frozen AR benchmark policy' }));
      }
    });

    const deadlineMs = 300_000;
    const { turn } = direct.startTurn(session.id, {
      input: task.prompt,
      model: requestedModel,
      maxSteps: task.resourceBudget?.maxSteps ?? 20,
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
    const totalRepairRounds = Math.max(repairEvents.length, diagnostics.repairRounds);
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
        trustedVerdict: row?.state === 'completed'
          ? { status: 'pass', source: 'trusted_server_verifier', evidenceRefs: enrichedReceipts.map((r) => r.id) }
          : null,
        trialMeta: {
          status: timedOut ? 'timeout' : row?.state === 'completed' ? 'passed' : 'failed',
          errorCode: turnErrorCode,
        },
      },
    });

    let inputTokens = wireRecords.reduce((s, r) => s + r.inputTokens, 0);
    let outputTokens = wireRecords.reduce((s, r) => s + r.outputTokens, 0);
    const cacheReadTokens = wireRecords.reduce((s, r) => s + r.cacheReadTokens, 0);
    const cacheWriteTokens = wireRecords.reduce((s, r) => s + r.cacheWriteTokens, 0);
    if (inputTokens === 0 && outputTokens === 0 && row) {
      inputTokens = Number(row.inputTokens ?? 0);
      outputTokens = Number(row.outputTokens ?? 0);
    }
    const durationMs = Math.round(performance.now() - started);
    const assistantExcerpt = safeRedactValue(String(assistantMsgs?.content ?? '').slice(0, 600), benchKey);
    const criticalContextRecall = computeTrialCriticalContextRecall({
      task,
      reasoningMetrics: diagnostics.reasoningMetrics,
    });
    const contractCompliance = computeTrialContractCompliance({
      judgment,
      reasoningMetrics: diagnostics.reasoningMetrics,
    });
    const cacheHitRate = inputTokens > 0 ? Number(Math.min(1, cacheReadTokens / inputTokens).toFixed(4)) : 0;

    if (
      expStore &&
      expMemory &&
      judgment.passed &&
      !timedOut &&
      judgment.evidence?.independentVerdictSource === 'trusted_server_verifier'
    ) {
      try {
        recordArmExperienceMemory({
          store: expStore,
          memory: expMemory,
          task,
          armName,
          rep,
          workspaceRoot,
          verdict: { verdict: 'pass', accepted: true },
          reasoningMetrics: diagnostics.reasoningMetrics,
          toolReceipts: enrichedReceipts,
          modifiedFiles: judgment.evidence.actualChangedFiles ?? [],
          passed: true,
          reason: judgment.reason,
        });
      } catch {
        // Never allow optional experience persistence to disturb trial reporting
      }
    }

    return {
      taskId: task.id,
      area: task.area,
      arm: armName,
      revision: armRuntime.revision,
      rep,
      position,
      passed: Boolean(judgment.passed && !timedOut),
      status: timedOut ? 'timeout' : judgment.passed ? 'passed' : 'failed',
      turnState: row?.state ?? null,
      turnErrorCode,
      attempts: 1 + totalRepairRounds,
      repairRounds: totalRepairRounds,
      rootCauseAccurate: Boolean(judgment.evidence.rootCauseMatch),
      firstFixSucceeded: resolveRealTrialFirstFixSucceeded({
        passed: judgment.passed,
        repairRounds: totalRepairRounds,
        reasoningMetrics: diagnostics.reasoningMetrics,
      }),
      regressionPassed: Boolean(judgment.evidence.regressionPassed),
      contractCompliance,
      criticalContextRecall,
      cacheHitRate,
      ineffectiveActionCount: enrichedReceipts.filter((r) => r.status === 'failed' || r.status === 'rejected_before_effect').length,
      replanTriggered: totalRepairRounds > 0,
      replanSucceeded: totalRepairRounds > 0 && judgment.passed,
      isRecoveryTask: Boolean(task.metadata.recoveryRequirements),
      recoverySucceeded: Boolean(task.metadata.recoveryRequirements && judgment.passed),
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
      },
      tokenCost: inputTokens + outputTokens,
      durationMs,
      failureCategory: timedOut ? 'timeout' : judgment.evidence.failureCategory,
      failureAttribution: judgment.evidence.failureAttribution,
      toolCallTrace: diagnostics.toolCallTrace,
      thrashingWarnings: diagnostics.thrashingWarnings,
      reasoningMetrics: diagnostics.reasoningMetrics,
      experienceMemory: diagnostics.experienceMemory,
      assistantExcerpt,
      judge: judgment,
    };
  } finally {
    globalThis.fetch = originalFetch;
    unsub?.();
    await direct.close();
    expStore?.close();
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    await removeFixtureWorkspace(workspaceRoot).catch(() => {});
  }
}

export async function runArmDiagnosticProbes(armRuntime) {
  const {
    Store,
    AgentLoop,
    DecisionEngine,
    EventRouter,
    InferenceEngine,
    EvidenceVerifier,
    AdaptivePlanner,
    AdaptiveReplanner,
    createWorkspaceTools,
    ToolDispatcher,
    UnknownOutcomeReconciler,
    CheckpointStore,
  } = armRuntime.modules;

  // Probe 1: Degenerate replan guard (PLANNER_DEGENERATE_REPLAN_DENIED / 409)
  let degenerateReplanGuard = { blocked: false, code: null, status: null };
  try {
    const planner = new AdaptivePlanner({ permissionCeiling: 'full' });
    const replanner = new AdaptiveReplanner({ planner, permissionCeiling: 'full' });
    const basePlan = planner.createPlan({
      goal: 'Repair tax module',
      tasks: [{ taskKey: 'fix-1', objective: 'Patch tax module', taskType: 'bug-fix', permissionMode: 'auto-safe' }],
      budget: { maxSteps: 10 },
    });
    replanner.replan(basePlan, {}, {
      failedStrategies: [{ taskKey: 'fix-1', objective: 'Patch tax module', strategy: 'retry_same' }],
    });
  } catch (err) {
    degenerateReplanGuard = {
      blocked: err?.code === 'PLANNER_DEGENERATE_REPLAN_DENIED',
      code: err?.code ?? null,
      status: err?.status ?? null,
    };
  }

  // Probe 2: Stuck-loop self-correction (6x consecutive identical tool calls -> byte-level tail dedup reminder -> read_file pivot -> recovery)
  const probeDir = mkdtempSync(join(tmpdir(), 'agent-us-ar-probe-'));
  const probeWork = join(probeDir, 'ws');
  mkdirSync(join(probeWork, 'src'), { recursive: true });
  writeFileSync(join(probeWork, 'src', 'bug.js'), 'export const val = 0;\n', 'utf8');
  const store = new Store(join(probeDir, 'probe.sqlite'));

  let stuckLoopSelfCorrection = {
    detected: false,
    recovered: false,
    pattern: null,
    status: 'failed',
    selfCorrectionRecovered: false,
  };
  try {
    const sessionId = 'sess-probe-stuck';
    const turnId = 'turn-probe-stuck';
    const now = Date.now();
    store.db
      .prepare('INSERT INTO direct_sessions(id,title,workspaceRoot,model,permissionMode,state,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)')
      .run(sessionId, 'Stuck Probe', probeWork, 'probe-model', 'full-access', 'running', now, now);
    store.db
      .prepare('INSERT INTO direct_turns(id,sessionId,input,model,state,phase,step,createdAt) VALUES(?,?,?,?,?,?,?,?)')
      .run(turnId, sessionId, 'Fix src/bug.js so val equals 42', 'probe-model', 'running', 'init', 0, now);

    const eventRouter = new EventRouter(store);
    const reconciler = new UnknownOutcomeReconciler(store, eventRouter);
    const checkpointStore = new CheckpointStore(store);
    const verifier = new EvidenceVerifier({ store, eventRouter });

    const tools = createWorkspaceTools({
      workspaceRoot: probeWork,
      dataRoot: probeDir,
      store,
      sessionId,
      permissionMode: 'full-access',
      nonce: '0123456789abcdef0123456789abcdef',
      sandbox: {
        async run() {
          const body = readFileSync(join(probeWork, 'src', 'bug.js'), 'utf8');
          if (body.includes('42')) {
            return { exitCode: 0, stdout: 'pass 1\nfail 0', stderr: '' };
          }
          return { exitCode: 1, stdout: '', stderr: 'AssertionError: expected 42 at src/bug.js:1' };
        },
      },
    });
    const dispatcher = new ToolDispatcher({ store, eventRouter, reconciler });

    let probeStep = 0;
    const probeAdapter = new (class extends LlmAdapter {
      async *stream(opts) {
        probeStep += 1;
        const msgs = opts.messages ?? [];
        const sawDedupReminder = msgs.some(
          (m) =>
            m.role === 'tool' &&
            (m.content ?? []).some((b) =>
              String(b?.text ?? '').includes('repeated 6 consecutive times'),
            ),
        );
        const hasReadBug = msgs.some(
          (m) =>
            m.role === 'assistant' &&
            (m.content ?? []).some((b) => b?.type === 'tool-call' && b?.name === 'read_file'),
        );
        const fixedBug = readFileSync(join(probeWork, 'src', 'bug.js'), 'utf8').includes('42');
        const lastToolMsg = [...msgs].reverse().find((m) => m.role === 'tool');
        const lastPassed = String(lastToolMsg?.content?.[0]?.text ?? '').includes('pass 1');

        if (!sawDedupReminder) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: `probe-repeat-${probeStep}`,
              name: 'bash',
              arguments: JSON.stringify({ command: 'node --test test/bug.test.js' }),
            },
          };
          yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 20 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }

        if (!hasReadBug) {
          yield {
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call', id: 'probe-read', name: 'read_file', arguments: JSON.stringify({ path: 'src/bug.js' }) },
          };
          yield { type: 'usage', usage: { inputTokens: 60, outputTokens: 20 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (!fixedBug) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'probe-fix',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'src/bug.js', content: 'export const val = 42;\n' }),
            },
          };
          yield { type: 'usage', usage: { inputTokens: 60, outputTokens: 25 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (!lastPassed) {
          yield {
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call', id: 'probe-verify', name: 'bash', arguments: JSON.stringify({ command: 'node --test test/bug.test.js' }) },
          };
          yield { type: 'usage', usage: { inputTokens: 60, outputTokens: 20 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield { type: 'text-delta', index: 0, text: 'Recovered from exact_repeat after inspecting src/bug.js.' };
        yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 20 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    })();

    const loop = new AgentLoop({
      store,
      eventRouter,
      inferenceEngine: new InferenceEngine(probeAdapter),
      decisionEngine: new DecisionEngine({ verifier: (args) => verifier.verify(args), maxRepairRounds: 2 }),
      checkpointStore,
    });
    const loopRes = await loop.run({
      sessionId,
      turnId,
      profile: { name: 'eval', defaultMaxSteps: 12, streamDeltas: false, persistTurn: true },
      input: 'Fix src/bug.js so val equals 42',
      model: 'probe-model',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Diagnostic probe' }] },
        { role: 'user', content: [{ type: 'text', text: 'Fix src/bug.js so val equals 42' }] },
      ],
      tools,
      toolDispatcher: dispatcher,
      permissionMode: 'full-access',
      budget: { maxSteps: 12 },
      workspaceRoot: probeWork,
    });

    const rm = loopRes.reasoningMetrics ?? {};
    const detectedPattern = rm.stuckDetections?.[0]?.pattern ?? null;
    stuckLoopSelfCorrection = {
      detected:
        Array.isArray(rm.stuckDetections) &&
        rm.stuckDetections.length > 0 &&
        Number(rm.duplicateReminderCount ?? 0) >= 1,
      recovered: loopRes.status === 'completed' && Boolean(rm.selfCorrectionRecovered),
      pattern: detectedPattern,
      status: loopRes.status,
      selfCorrectionRecovered: Boolean(rm.selfCorrectionRecovered),
    };
  } catch {
    // Baseline fallback
  } finally {
    store.close();
    rmSync(probeDir, { recursive: true, force: true });
  }

  return { degenerateReplanGuard, stuckLoopSelfCorrection };
}

export async function runAutonomousReasoningBenchmark(opts) {
  const baselineRoot = resolve(opts.baseline || DEFAULT_REPO_ROOT);
  const candidateRoot = resolve(opts.candidate || DEFAULT_REPO_ROOT);
  const sandboxOpts = buildSandboxOptions(opts.sandbox);
  const judgeSandbox = new BenchmarkSandbox(sandboxOpts);
  judgeSandbox.resolveBackend();

  const dataset = createAutonomousReasoningDataset({ sandbox: judgeSandbox }).filter(
    (t) => !opts.tasks || opts.tasks.includes(t.id),
  );
  if (dataset.length === 0) {
    throw new Error('No benchmark tasks matched --tasks filter');
  }

  let benchKey = '';
  let endpoint = null;
  let requestedModel = null;
  if (opts.mode === 'real') {
    benchKey = process.env.TI_BENCH_KEY || process.env.AGENT_US_BENCH_KEY || '';
    delete process.env.TI_BENCH_KEY;
    delete process.env.AGENT_US_BENCH_KEY;
    endpoint = new URL(process.env.TI_BENCH_ENDPOINT || process.env.AGENT_US_BENCH_ENDPOINT || 'http://127.0.0.1:7863/v1');
    requestedModel = process.env.TI_BENCH_MODEL || process.env.AGENT_US_BENCH_MODEL || 'cn:deepseek-v4.1-flash';
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

  const [baselineRuntime, candidateRuntime] = await Promise.all([
    loadAndProbeWorktreeArm(baselineRoot),
    loadAndProbeWorktreeArm(candidateRoot),
  ]);

  let tempExperienceDir = null;
  let effectiveExperienceDb = opts.experienceDb ? resolve(opts.experienceDb) : null;
  let experienceSeeding = null;
  if (!effectiveExperienceDb && opts.experienceSeed) {
    tempExperienceDir = mkdtempSync(join(tmpdir(), 'agent-us-ar-expdb-'));
    effectiveExperienceDb = join(tempExperienceDir, 'experience.sqlite');
  }
  if (effectiveExperienceDb) {
    mkdirSync(dirname(effectiveExperienceDb), { recursive: true });
    if (opts.experienceSeed) {
      const seedRuntime = candidateRuntime;
      const seedStore = new seedRuntime.modules.Store(effectiveExperienceDb);
      try {
        const seedMemory = new seedRuntime.modules.ExperienceMemoryService({ store: seedStore });
        experienceSeeding = seedVerifiedExperienceFromJsonl({
          jsonlPath: resolve(opts.experienceSeed),
          store: seedStore,
          memory: seedMemory,
          dataset,
        });
      } finally {
        seedStore.close();
      }
    }
  }

  if (opts.output) {
    mkdirSync(dirname(opts.output), { recursive: true });
    writeFileSync(opts.output, '', { encoding: 'utf8', mode: 0o600 });
  }

  const baselineTrials = [];
  const candidateTrials = [];

  try {
    for (let rep = 0; rep < opts.repeats; rep++) {
      for (const [idx, task] of dataset.entries()) {
        if (idx % opts.lanes !== opts.lane) continue;
        const order = (rep + idx) % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
        for (const [position, armName] of order.entries()) {
          const armRuntime = armName === 'baseline' ? baselineRuntime : candidateRuntime;
          const trial =
            opts.mode === 'real'
              ? await runRealArmTrial({
                  task,
                  armName,
                  armRuntime,
                  rep,
                  position,
                  benchKey,
                  endpoint,
                  requestedModel,
                  judgeSandbox,
                  experienceDbPath: effectiveExperienceDb,
                  experienceArm: opts.experienceArm ?? 'both',
                })
              : await runDeterministicArmTrial({
                  task,
                  armName,
                  armRuntime,
                  rep,
                  judgeSandbox,
                });
          if (armName === 'baseline') baselineTrials.push(trial);
          else candidateTrials.push(trial);
          writeJsonlRow(opts.output, trial, benchKey);
        }
      }
    }
  } finally {
    if (tempExperienceDir) {
      rmSync(tempExperienceDir, { recursive: true, force: true });
    }
  }

  const baselineMetrics = computeAutonomousReasoningMetrics(baselineTrials);
  const candidateMetrics = computeAutonomousReasoningMetrics(candidateTrials);
  const [baselineProbes, candidateProbes] =
    opts.mode === 'deterministic'
      ? await Promise.all([
          runArmDiagnosticProbes(baselineRuntime),
          runArmDiagnosticProbes(candidateRuntime),
        ])
      : [null, null];

  const summary = {
    benchmarkId: AUTONOMOUS_REASONING_BENCHMARK_ID,
    version: VERSION,
    mode: opts.mode,
    sandboxBackend: judgeSandbox.resolveBackend().mode,
    baseline: {
      root: baselineRuntime.root,
      revision: baselineRuntime.revision,
      capabilities: baselineRuntime.capabilities,
      ...(baselineProbes ? { probes: baselineProbes } : {}),
      metrics: baselineMetrics,
    },
    candidate: {
      root: candidateRuntime.root,
      revision: candidateRuntime.revision,
      capabilities: candidateRuntime.capabilities,
      ...(candidateProbes ? { probes: candidateProbes } : {}),
      metrics: candidateMetrics,
    },
    deltas: {
      finalTaskSuccessRateDelta: Number((candidateMetrics.finalTaskSuccessRate - baselineMetrics.finalTaskSuccessRate).toFixed(4)),
      rootCauseAccuracyDelta: Number((candidateMetrics.rootCauseAccuracy - baselineMetrics.rootCauseAccuracy).toFixed(4)),
      firstFixSuccessRateDelta: Number((candidateMetrics.firstFixSuccessRate - baselineMetrics.firstFixSuccessRate).toFixed(4)),
      regressionTestPassRateDelta: Number((candidateMetrics.regressionTestPassRate - baselineMetrics.regressionTestPassRate).toFixed(4)),
      contractComplianceDelta: Number((candidateMetrics.contractCompliance - baselineMetrics.contractCompliance).toFixed(4)),
      criticalContextRecallDelta: Number((candidateMetrics.criticalContextRecall - baselineMetrics.criticalContextRecall).toFixed(4)),
      ineffectiveActionCountDelta: candidateMetrics.ineffectiveActionCount - baselineMetrics.ineffectiveActionCount,
      replanEffectivenessRateDelta: Number((candidateMetrics.replanEffectivenessRate - baselineMetrics.replanEffectivenessRate).toFixed(4)),
      tokenCostDelta: candidateMetrics.tokenCost - baselineMetrics.tokenCost,
      cacheHitRateDelta: Number((candidateMetrics.cacheHitRate - baselineMetrics.cacheHitRate).toFixed(4)),
      meanDurationMsDelta: candidateMetrics.meanDurationMs - baselineMetrics.meanDurationMs,
      recoverySuccessRateDelta: Number((candidateMetrics.recoverySuccessRate - baselineMetrics.recoverySuccessRate).toFixed(4)),
    },
    ...(experienceSeeding ? { experienceSeeding } : {}),
  };

  return safeRedactValue(summary, benchKey);
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    process.exit(0);
  }
  const summary = await runAutonomousReasoningBenchmark(opts);
  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const b = summary.baseline.metrics;
    const c = summary.candidate.metrics;
    console.log(`[${summary.benchmarkId} v${summary.version}] mode=${summary.mode} sandbox=${summary.sandboxBackend}`);
    console.log(`Baseline (${summary.baseline.revision?.slice(0, 7) ?? 'unknown'}): pass=${b.passedTrials}/${b.totalTrials} successRate=${b.finalTaskSuccessRate} rootCause=${b.rootCauseAccuracy} ineffective=${b.ineffectiveActionCount}`);
    console.log(`Candidate (${summary.candidate.revision?.slice(0, 7) ?? 'unknown'}): pass=${c.passedTrials}/${c.totalTrials} successRate=${c.finalTaskSuccessRate} rootCause=${c.rootCauseAccuracy} ineffective=${c.ineffectiveActionCount}`);
    console.log(`Deltas: success=${summary.deltas.finalTaskSuccessRateDelta} rootCause=${summary.deltas.rootCauseAccuracyDelta} ineffective=${summary.deltas.ineffectiveActionCountDelta}`);
  }
}
