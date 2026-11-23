#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
} from '../src/evaluation/autonomous-reasoning-benchmark.js';
import { removeFixtureWorkspace } from '../src/evaluation/fixtures.js';
import { BenchmarkSandbox, SANDBOX_MODES, runHardenedGitSync } from '../src/tools/benchmark-sandbox.js';

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
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown CLI flag: ${arg}`);
  }
  if (!opts.baseline && positional[0]) opts.baseline = positional[0];
  if (!opts.candidate && positional[1]) opts.candidate = positional[1];
  if (!opts.output && positional[2]) opts.output = positional[2];

  if (!['deterministic', 'real'].includes(opts.mode)) {
    throw new Error(`Unsupported --mode "${opts.mode}"; expected deterministic or real`);
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
    execReasoningMod,
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
    importOptional(root, 'kernel/execution-reasoning.js'),
    importOptional(root, 'evaluation/service.js'),
  ]);

  // Probe behavioral capabilities dynamically without assuming fixed file contents.
  const capabilities = {
    executionReasoningTracker: Boolean(execReasoningMod?.ExecutionReasoningTracker),
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
        { role: 'assistant', content: [{ type: 'text', text: 'Recent step' }] },
        { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
      ];
      const res = contextMod.compactTwoStage(msgs, { softLimitTokens: 200, hardLimitTokens: 500, keepRecent: 2 });
      const compactedText = JSON.stringify(res?.messages ?? []);
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
  capabilities.richCompactionAnchor =
    typeof compactionMod.MultiStageCompactor?.prototype?.extractTaskStateAnchor === 'function';

  return {
    root,
    revision: getWorktreeRevision(root),
    capabilities,
    modules: {
      Store: storeMod.Store,
      AccountPool: poolMod.AccountPool,
      DirectAgentRuntime: directMod.DirectAgentRuntime,
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
    },
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
          /STALE_VERIFICATION_AFTER_EDIT|UNRESOLVED_VERIFICATION_FAILURE|FABRICATED_PASS_CLAIM|验证未通过|复测/.test(
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
      yield { type: 'finish', reason: { kind: 'tool-calls' }, usage: { inputTokens: 180, outputTokens: 35 } };
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
      yield { type: 'finish', reason: { kind: 'tool-calls' }, usage: { inputTokens: 210, outputTokens: 60 } };
      return;
    }

    if (this.requirePostEditVerify && !sawRepair && !hasToolResult('final-verify')) {
      // Attempt to stop immediately after editing without post-edit test verification.
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify(buildAutonomousReasoningEvidenceOutput(this.task).output),
      };
      yield { type: 'finish', reason: { kind: 'stop' }, usage: { inputTokens: 190, outputTokens: 50 } };
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
      yield { type: 'finish', reason: { kind: 'tool-calls' }, usage: { inputTokens: 240, outputTokens: 75 } };
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
      yield { type: 'finish', reason: { kind: 'tool-calls' }, usage: { inputTokens: 220, outputTokens: 80 } };
      return;
    }

    const out = buildAutonomousReasoningEvidenceOutput(this.task);
    yield { type: 'text-delta', index: 0, text: JSON.stringify(out.output) };
    yield { type: 'finish', reason: { kind: 'stop' }, usage: { inputTokens: 160, outputTokens: 55 } };
  }
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
      const twoStage = compactTwoStage(
        [
          { role: 'user', content: [{ type: 'text', text: task.prompt }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Tracing constraints' }] },
          { role: 'user', content: [{ type: 'text', text: 'Proceed' }] },
        ],
        { keepRecent: 1 },
      );
      compactionProbe = { compacted: Boolean(compacted?.compacted), stage: twoStage?.stage ?? 'none' };
    }

    // Exercise AdaptiveReplanner on recovery/multi-agent tasks
    let replanTriggered = false;
    let replanSucceeded = false;
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
        const nextPlan = replanner.replan(plan, {
          tasks: [{ taskKey: 'stage-1', objective: 'Pivot: checkpoint + fence recovery', taskType: 'recovery', permissionMode: 'auto-safe' }],
        });
        replanSucceeded = nextPlan.planVersion === 2;
      } catch {
        replanSucceeded = false;
      }
    }

    const eventRouter = new EventRouter(store);
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
      if (['write_file', 'edit_file', 'apply_patch'].includes(tool)) {
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
    let memoryRecorded = false;
    if (typeof memory.distillTurnExperience === 'function') {
      const distilled = memory.distillTurnExperience({
        projectId: task.id,
        input: task.objective,
        workspaceRoot,
        verdict: loopResult.verdict,
        reasoningMetrics: loopResult.reasoningMetrics ?? null,
        toolReceipts: enrichedReceipts,
        modifiedFiles: judgment.evidence.actualChangedFiles,
        evaluationEvidence: judgment.passed
          ? { sourceTaskId: task.id, evaluationRunId: `eval-${armName}-${rep}`, projectId: task.id, score: { total: 1, passed: 1 } }
          : null,
      });
      memoryRecorded = Boolean(distilled);
    } else {
      const items = memory.extract(`[lesson] ${task.id}: ${judgment.passed ? 'passed' : judgment.reason}`, {
        projectId: task.id,
        source: 'deterministic_probe',
      });
      memoryRecorded = items.length > 0;
    }

    const durationMs = Math.round(performance.now() - started);
    const rm = loopResult.reasoningMetrics ?? {};
    const repairEvents = (loopResult.verifierEvents ?? []).filter((e) => e.type === 'verifier/repair').length;

    return {
      taskId: task.id,
      area: task.area,
      arm: armName,
      revision: armRuntime.revision,
      rep,
      passed: Boolean(judgment.passed),
      status: judgment.passed ? 'passed' : 'failed',
      attempts: 1 + repairEvents,
      repairRounds: repairEvents,
      rootCauseAccurate: Boolean(judgment.evidence.rootCauseMatch),
      firstFixSucceeded: Boolean(judgment.passed && repairEvents === 0 && !rm.selfCorrectionRecovered),
      regressionPassed: Boolean(judgment.evidence.regressionPassed),
      ineffectiveActionCount: Number(rm.ineffectiveActionCount ?? (judgment.passed ? 0 : 1)),
      replanTriggered,
      replanSucceeded: replanTriggered && replanSucceeded && judgment.passed,
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

async function runRealArmTrial({ task, armName, armRuntime, rep, position, benchKey, endpoint, requestedModel, judgeSandbox }) {
  const started = performance.now();
  const stateDir = mkdtempSync(join(tmpdir(), `agent-us-ar-real-${armName}-`));
  const workspaceRoot = await instantiateAutonomousReasoningWorkspace(task, {
    prefix: `agent-us-ar-realws-${armName}-`,
  });
  const { Store, AccountPool, DirectAgentRuntime, BenchmarkSandbox: ArmSandbox } = armRuntime.modules;
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
  const sessionSandbox = new ArmSandbox({
    ...buildSandboxOptions(judgeSandbox.mode),
    workspaceRoot,
    allowWorkspaceNodeCli: Boolean(task.metadata?.sandboxIsolation?.allowWorkspaceNodeCli),
    timeoutMs: 30_000,
    cpuLimitSec: 20,
    memoryLimitMb: 512,
  });

  const wireRecords = [];
  const repairEvents = [];
  let unsub = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== endpoint.origin || !url.pathname.endsWith('/chat/completions')) {
      return originalFetch(input, init);
    }
    const rec = { http: null, ms: null, inputTokens: 0, outputTokens: 0 };
    const t0 = performance.now();
    wireRecords.push(rec);
    const res = await originalFetch(input, init);
    rec.http = res.status;
    res.clone().text().then((body) => {
      for (const line of body.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.usage) {
            rec.inputTokens = Number(parsed.usage.prompt_tokens ?? 0);
            rec.outputTokens = Number(parsed.usage.completion_tokens ?? 0);
          }
        } catch {
          // ignore non-json SSE lines
        }
      }
    }).catch(() => {}).finally(() => {
      rec.ms = Math.round(performance.now() - t0);
    });
    return res;
  };

  try {
    const session = direct.createSession({
      workspaceRoot,
      model: requestedModel,
      permissionMode: 'auto-safe',
      budget: { maxSteps: task.resourceBudget?.maxSteps ?? 20, maxOutputTokens: 4096, maxTotalTokens: 110_000 },
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
    ]);
    unsub = direct.subscribe(session.id, (evt) => {
      if (evt.type === 'verifier/repair') repairEvents.push(evt.data);
      if (evt.type === 'approval/requested') {
        const a = evt.data;
        let allow = false;
        if (a.tool === 'bash') {
          allow = allowedTestCommands.has(String(a.arguments?.command ?? '').trim());
        } else if (['write_file', 'edit_file'].includes(a.tool)) {
          const p = String(a.arguments?.path ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
          allow = Boolean(p) && !protectedSet.has(p);
        }
        queueMicrotask(() => direct.decideApproval(a.approvalId, { decision: allow ? 'allow' : 'deny', scope: 'once', reason: 'Frozen AR benchmark policy' }));
      }
    });

    const deadlineMs = 110_000;
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
    }

    const assistantMsgs = store.db
      .prepare("SELECT content FROM direct_messages WHERE turnId=? AND role='assistant' ORDER BY seq DESC LIMIT 1")
      .get(turn.id);
    const receipts = store.db
      .prepare('SELECT id, callId, toolName, status, exitCode, errorCode FROM tool_receipts WHERE turnId=? ORDER BY rowid')
      .all(turn.id);

    const judgment = await task.judge({
      task,
      output: assistantMsgs?.content ?? '',
      context: {
        workspaceRoot,
        sandbox: judgeSandbox,
        attemptId: 'attempt-1',
        planVersion: 1,
        toolReceipts: receipts,
        trustedVerdict: row?.state === 'completed'
          ? { status: 'pass', source: 'trusted_server_verifier', evidenceRefs: receipts.map((r) => r.id) }
          : null,
        trialMeta: {
          status: timedOut ? 'timeout' : row?.state === 'completed' ? 'passed' : 'failed',
          errorCode: row?.errorCode ?? null,
        },
      },
    });

    const inputTokens = wireRecords.reduce((s, r) => s + r.inputTokens, 0);
    const outputTokens = wireRecords.reduce((s, r) => s + r.outputTokens, 0);
    const durationMs = Math.round(performance.now() - started);

    return {
      taskId: task.id,
      area: task.area,
      arm: armName,
      revision: armRuntime.revision,
      rep,
      position,
      passed: Boolean(judgment.passed && !timedOut),
      status: timedOut ? 'timeout' : judgment.passed ? 'passed' : 'failed',
      attempts: 1 + repairEvents.length,
      repairRounds: repairEvents.length,
      rootCauseAccurate: Boolean(judgment.evidence.rootCauseMatch),
      firstFixSucceeded: Boolean(judgment.passed && repairEvents.length === 0),
      regressionPassed: Boolean(judgment.evidence.regressionPassed),
      ineffectiveActionCount: receipts.filter((r) => r.status === 'failed' || r.status === 'rejected_before_effect').length,
      replanTriggered: repairEvents.length > 0,
      replanSucceeded: repairEvents.length > 0 && judgment.passed,
      isRecoveryTask: Boolean(task.metadata.recoveryRequirements),
      recoverySucceeded: Boolean(task.metadata.recoveryRequirements && judgment.passed),
      tokenUsage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      tokenCost: inputTokens + outputTokens,
      durationMs,
      failureCategory: timedOut ? 'timeout' : judgment.evidence.failureCategory,
      failureAttribution: judgment.evidence.failureAttribution,
      judge: judgment,
    };
  } finally {
    globalThis.fetch = originalFetch;
    unsub?.();
    await direct.close();
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    await removeFixtureWorkspace(workspaceRoot).catch(() => {});
  }
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

  if (opts.output) {
    mkdirSync(dirname(opts.output), { recursive: true });
    writeFileSync(opts.output, '', { encoding: 'utf8', mode: 0o600 });
  }

  const baselineTrials = [];
  const candidateTrials = [];

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

  const baselineMetrics = computeAutonomousReasoningMetrics(baselineTrials);
  const candidateMetrics = computeAutonomousReasoningMetrics(candidateTrials);
  const summary = {
    benchmarkId: AUTONOMOUS_REASONING_BENCHMARK_ID,
    version: VERSION,
    mode: opts.mode,
    sandboxBackend: judgeSandbox.resolveBackend().mode,
    baseline: {
      root: baselineRuntime.root,
      revision: baselineRuntime.revision,
      capabilities: baselineRuntime.capabilities,
      metrics: baselineMetrics,
    },
    candidate: {
      root: candidateRuntime.root,
      revision: candidateRuntime.revision,
      capabilities: candidateRuntime.capabilities,
      metrics: candidateMetrics,
    },
    deltas: {
      finalTaskSuccessRateDelta: Number((candidateMetrics.finalTaskSuccessRate - baselineMetrics.finalTaskSuccessRate).toFixed(4)),
      rootCauseAccuracyDelta: Number((candidateMetrics.rootCauseAccuracy - baselineMetrics.rootCauseAccuracy).toFixed(4)),
      firstFixSuccessRateDelta: Number((candidateMetrics.firstFixSuccessRate - baselineMetrics.firstFixSuccessRate).toFixed(4)),
      regressionTestPassRateDelta: Number((candidateMetrics.regressionTestPassRate - baselineMetrics.regressionTestPassRate).toFixed(4)),
      ineffectiveActionCountDelta: candidateMetrics.ineffectiveActionCount - baselineMetrics.ineffectiveActionCount,
      replanEffectivenessRateDelta: Number((candidateMetrics.replanEffectivenessRate - baselineMetrics.replanEffectivenessRate).toFixed(4)),
      tokenCostDelta: candidateMetrics.tokenCost - baselineMetrics.tokenCost,
      meanDurationMsDelta: candidateMetrics.meanDurationMs - baselineMetrics.meanDurationMs,
      recoverySuccessRateDelta: Number((candidateMetrics.recoverySuccessRate - baselineMetrics.recoverySuccessRate).toFixed(4)),
    },
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
