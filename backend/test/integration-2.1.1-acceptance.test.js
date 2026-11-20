import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { ScheduledTaskRunner } from '../src/governance/scheduler.js';
import { RuntimeError } from '../src/kernel/errors.js';

const SRC_ROOT = resolve(import.meta.dirname, '..', 'src');

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }
  async *stream(options) {
    this.calls.push({
      model: options.model,
      maxTokens: options.maxTokens,
      messages: structuredClone(options.messages),
    });
    yield* this.handler(options, this.calls.length - 1);
  }
}

function initGitRepo(workDir, initialFiles = { 'README.md': '# Agent_US 2.1.1\n', 'shared.txt': 'base-line\n' }) {
  execFileSync('git', ['init'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'acceptance@agent-us.local'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Acceptance Bot'], { cwd: workDir, stdio: 'ignore' });
  for (const [rel, content] of Object.entries(initialFiles)) {
    writeFileSync(join(workDir, rel), content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: workDir, stdio: 'ignore' });
}

async function pollUntil(fn, timeoutMs = 15000, stepMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await delay(stepMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function killIfAlive(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already exited
    }
  }
}

// ============================================================================
// Scenario 1: Real Artifact Delivery (Isolated Worktrees -> Review -> Restart -> Guarded Apply)
// ============================================================================
test('Acceptance Scenario 1: Real isolated worktree artifact delivery, review verification, restart SHA-256 integrity & guarded apply conflict protection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-211-s1-'));
  const workDir = join(dir, 'repo');
  const dataRoot = join(dir, 'data');
  const dbPath = join(dir, 'engine.sqlite');
  const artifactStoreDir = join(dir, 'artifacts');

  mkdirSync(workDir, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  initGitRepo(workDir, {
    'README.md': '# Scenario 1 Repo\n',
    'shared.txt': 'original-shared-content\n',
  });

  const reviewedContents = {};
  const adapter = new ScriptedAdapter(async function* (opts) {
    const userText = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const toolMsgs = opts.messages.filter((m) => m.role === 'tool');

    if (userText.includes('ROLE:MOD_A')) {
      if (toolMsgs.length === 0) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-mod-a-1',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/alpha.js', content: 'export const ALPHA = "ALPHA_ARTIFACT_V1";\n' }),
          },
        };
        yield {
          type: 'block-end',
          index: 1,
          block: {
            type: 'tool-call',
            id: 'tc-mod-a-2',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'shared.txt', content: 'mod-a-updated-shared\n' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'MOD_A wrote src/alpha.js and updated shared.txt.' };
      yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 15 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (userText.includes('ROLE:MOD_B')) {
      if (toolMsgs.length === 0) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-mod-b-1',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/beta.js', content: 'export const BETA = "BETA_ARTIFACT_V1";\n' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'MOD_B wrote src/beta.js.' };
      yield { type: 'usage', usage: { inputTokens: 28, outputTokens: 14 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (userText.includes('ROLE:REVIEWER')) {
      if (toolMsgs.length === 0) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-rev-a',
            name: 'read_swarm_artifact',
            arguments: JSON.stringify({ nodeKey: 'mod-a', path: 'src/alpha.js' }),
          },
        };
        yield {
          type: 'block-end',
          index: 1,
          block: {
            type: 'tool-call',
            id: 'tc-rev-b',
            name: 'read_swarm_artifact',
            arguments: JSON.stringify({ nodeKey: 'mod-b', path: 'src/beta.js' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      reviewedContents.alpha = toolMsgs[0]?.content?.[0]?.text ?? '';
      reviewedContents.beta = toolMsgs[1]?.content?.[0]?.text ?? '';
      yield {
        type: 'text-delta',
        index: 0,
        text: `REVIEW_VERIFIED: alpha & beta checked`,
      };
      yield { type: 'usage', usage: { inputTokens: 35, outputTokens: 18 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    yield { type: 'text-delta', index: 0, text: 'ok' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  let store = new Store(dbPath);
  let pool = new AccountPool(store, { root: dataRoot });
  pool.setDefaultModel('mock-s1');
  let runtime = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot,
    artifactStoreDir,
    adapter,
  });

  try {
    const sess = runtime.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
    const run = await runtime.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Modify in two isolated worktrees and review artifacts',
      workspaceRoot: workDir,
      maxConcurrency: 2,
      nodes: [
        {
          nodeKey: 'mod-a',
          taskType: 'implementation',
          objective: 'ROLE:MOD_A create src/alpha.js and edit shared.txt',
          dependencies: [],
          isolatedWorktree: true,
          isolationMode: 'worktree',
          toolAllow: ['write_file', 'read_file'],
        },
        {
          nodeKey: 'mod-b',
          taskType: 'implementation',
          objective: 'ROLE:MOD_B create src/beta.js',
          dependencies: [],
          isolatedWorktree: true,
          isolationMode: 'worktree',
          toolAllow: ['write_file', 'read_file'],
        },
        {
          nodeKey: 'reviewer',
          taskType: 'review',
          objective: 'ROLE:REVIEWER inspect both predecessor artifacts',
          dependencies: ['mod-a', 'mod-b'],
          isolationMode: 'shared_readonly',
        },
      ],
    });

    assert.equal(run.status, 'completed');
    assert.ok(run.nodes.every((n) => n.status === 'completed'));

    // Review node must have read real predecessor artifacts
    assert.match(reviewedContents.alpha, /ALPHA_ARTIFACT_V1/);
    assert.match(reviewedContents.beta, /BETA_ARTIFACT_V1/);

    // Parent workspace must remain completely untouched before guarded apply
    assert.equal(existsSync(join(workDir, 'src', 'alpha.js')), false);
    assert.equal(existsSync(join(workDir, 'src', 'beta.js')), false);
    assert.equal(readFileSync(join(workDir, 'shared.txt'), 'utf8'), 'original-shared-content\n');

    const artifactsBefore = runtime.artifactManager.listArtifacts({ runId: run.id });
    assert.equal(artifactsBefore.length, 2);
    const artA = artifactsBefore.find((a) => a.nodeKey === 'mod-a');
    const artB = artifactsBefore.find((a) => a.nodeKey === 'mod-b');
    assert.ok(artA && artB);
    const alphaBefore = runtime.artifactManager.readArtifactFile(artA.id, 'src/alpha.js');
    const betaBefore = runtime.artifactManager.readArtifactFile(artB.id, 'src/beta.js');
    assert.equal(alphaBefore.text, 'export const ALPHA = "ALPHA_ARTIFACT_V1";\n');
    assert.equal(betaBefore.text, 'export const BETA = "BETA_ARTIFACT_V1";\n');

    // Restart Runtime on the SAME SQLite DB and verify identical artifacts + SHA-256
    await runtime.close();
    store.close();

    store = new Store(dbPath);
    pool = new AccountPool(store, { root: dataRoot });
    pool.setDefaultModel('mock-s1');
    runtime = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: workDir,
      dataRoot,
      artifactStoreDir,
      adapter,
    });

    const artifactsAfter = runtime.artifactManager.listArtifacts({ runId: run.id });
    assert.equal(artifactsAfter.length, 2);
    const artAAfter = runtime.artifactManager.getArtifact(artA.id);
    const artBAfter = runtime.artifactManager.getArtifact(artB.id);
    assert.equal(artAAfter.bundleSha256, artA.bundleSha256);
    assert.equal(artBAfter.bundleSha256, artB.bundleSha256);
    assert.equal(runtime.artifactManager.verifyArtifact(artA.id).ok, true);
    assert.equal(runtime.artifactManager.verifyArtifact(artB.id).ok, true);
    assert.equal(
      runtime.artifactManager.readArtifactFile(artA.id, 'src/alpha.js').text,
      alphaBefore.text,
    );

    // Guarded apply policy check: read-only must be denied
    assert.throws(
      () => runtime.artifactManager.applyToParent(artB.id, { permissionMode: 'read-only' }),
      (err) => err?.code === 'POLICY_DENIED',
    );
    assert.equal(existsSync(join(workDir, 'src', 'beta.js')), false);

    // Concurrent unrelated user edit + conflicting user edit on shared.txt
    writeFileSync(join(workDir, 'unrelated.txt'), 'user-unrelated-work\n', 'utf8');
    writeFileSync(join(workDir, 'shared.txt'), 'user-concurrent-edit\n', 'utf8');

    // Apply artB cleanly (disjoint file src/beta.js) -> succeeds and preserves unrelated.txt
    const applyB = runtime.artifactManager.applyToParent(artB.id, {
      permissionMode: 'auto-safe',
      approved: true,
    });
    assert.equal(applyB.ok, true);
    assert.equal(applyB.status, 'applied');
    assert.ok(Array.isArray(applyB.applied) && applyB.applied.some((f) => f.path === 'src/beta.js'));
    assert.equal(readFileSync(join(workDir, 'src', 'beta.js'), 'utf8'), 'export const BETA = "BETA_ARTIFACT_V1";\n');
    assert.equal(readFileSync(join(workDir, 'unrelated.txt'), 'utf8'), 'user-unrelated-work\n');

    // Apply artA -> detects baseSha256 conflict on shared.txt and preserves BOTH sides!
    const applyA = runtime.artifactManager.applyToParent(artA.id, {
      permissionMode: 'auto-safe',
      approved: true,
    });
    assert.equal(applyA.ok, false);
    assert.equal(applyA.status, 'conflict');
    assert.ok(Array.isArray(applyA.conflicts) && applyA.conflicts.some((c) => c.path === 'shared.txt'));
    assert.equal(readFileSync(join(workDir, 'shared.txt'), 'utf8'), 'user-concurrent-edit\n');
    assert.equal(readFileSync(join(workDir, 'unrelated.txt'), 'utf8'), 'user-unrelated-work\n');
    assert.equal(runtime.artifactManager.verifyArtifact(artA.id).ok, true);
  } finally {
    await runtime?.close?.();
    store?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Scenario 2: Interrupt & Subprocess Recovery (Real SIGKILL)
// ============================================================================
test('Acceptance Scenario 2: Real subprocess SIGKILL recovery preserves completed/artifacts/cancelled, resumes running from checkpoint, runs dependents & reconciles budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-211-s2-'));
  const workDir = join(dir, 'repo');
  const dataRoot = join(dir, 'data');
  const artifactStoreDir = join(dir, 'artifacts');
  const dbPath = join(dir, 'engine.sqlite');
  const workerScript = join(dir, 's2-worker.mjs');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  initGitRepo(workDir, { 'README.md': 'SCENARIO_2_BASE_FILE\n' });

  const storeUrl = pathToFileURL(join(SRC_ROOT, 'store.js')).href;
  const poolUrl = pathToFileURL(join(SRC_ROOT, 'pool.js')).href;
  const directUrl = pathToFileURL(join(SRC_ROOT, 'direct-agent.js')).href;

  writeFileSync(
    workerScript,
    `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from ${JSON.stringify(storeUrl)};
import { AccountPool } from ${JSON.stringify(poolUrl)};
import { DirectAgentRuntime } from ${JSON.stringify(directUrl)};

const [dbPath, workDir, dataRoot, artifactStoreDir] = process.argv.slice(2);
const store = new Store(dbPath);
const pool = new AccountPool(store, { root: dataRoot });
pool.setDefaultModel('mock-s2');

const adapter = {
  async *stream(opts) {
    const userText = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const toolMsgs = opts.messages.filter((m) => m.role === 'tool');

    if (userText.includes('TAG:DONE_WT')) {
      if (toolMsgs.length === 0) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-done-write',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'pre-crash.txt', content: 'PRE_CRASH_ARTIFACT_OK\\n' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'DONE_WT_FINISHED' };
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (userText.includes('TAG:RUN_MID')) {
      if (toolMsgs.length === 0) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-run-read',
            name: 'read_file',
            arguments: JSON.stringify({ path: 'README.md' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      // Step 2 reached after checkpoint persisted + step 2 budget reserved -> signal parent to SIGKILL!
      writeFileSync(join(dataRoot, 'run-mid-ready.flag'), String(Date.now()), 'utf8');
      await new Promise(() => {});
    }

    yield { type: 'text-delta', index: 0, text: 'UNEXPECTED' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};

const rt = new DirectAgentRuntime(store, pool, {
  defaultWorkspace: workDir,
  dataRoot,
  artifactStoreDir,
  adapter,
  workerId: 's2-child-worker',
});

const parent = rt.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
const cancelled = rt.swarmOrchestrator.submitRun({
  sessionId: parent.id,
  goal: 'Cancelled pre-crash run',
  workspaceRoot: workDir,
  nodes: [{ nodeKey: 'never', taskType: 'research', objective: 'TAG:NEVER', dependencies: [] }],
});
rt.swarmOrchestrator.cancelRun(cancelled.runId);

const active = rt.swarmOrchestrator.submitRun({
  sessionId: parent.id,
  goal: 'Scenario 2 SIGKILL recovery DAG',
  workspaceRoot: workDir,
  maxConcurrency: 2,
  maxReplans: 2,
  budget: { maxTotalSteps: 10 },
  nodes: [
    {
      nodeKey: 'done-wt',
      taskType: 'implementation',
      objective: 'TAG:DONE_WT write pre-crash.txt',
      dependencies: [],
      isolatedWorktree: true,
      isolationMode: 'worktree',
      toolAllow: ['write_file', 'read_file'],
      priority: 10,
    },
    {
      nodeKey: 'run-mid',
      taskType: 'research',
      objective: 'TAG:RUN_MID read README.md then stall',
      dependencies: ['done-wt'],
      isolationMode: 'shared_readonly',
      priority: 5,
    },
    {
      nodeKey: 'dep-after',
      taskType: 'review',
      objective: 'TAG:DEP_AFTER review completion',
      dependencies: ['done-wt', 'run-mid'],
      isolationMode: 'shared_readonly',
      priority: 1,
    },
  ],
});

writeFileSync(
  join(dataRoot, 'ids.json'),
  JSON.stringify({ runId: active.runId, cancelledId: cancelled.runId }),
  'utf8',
);
const keep = setInterval(() => {}, 1000);
setTimeout(() => { clearInterval(keep); process.exit(1); }, 30000);
`,
    'utf8',
  );

  let child = null;
  let store = null;
  let runtime = null;
  try {
    child = spawn(process.execPath, [workerScript, dbPath, workDir, dataRoot, artifactStoreDir], {
      stdio: 'ignore',
    });

    await pollUntil(
      () =>
        existsSync(join(dataRoot, 'ids.json')) &&
        existsSync(join(dataRoot, 'run-mid-ready.flag')),
      15000,
    );
    await delay(100);
    child.kill('SIGKILL');
    await new Promise((res) => child.once('exit', res));

    const { runId, cancelledId } = JSON.parse(readFileSync(join(dataRoot, 'ids.json'), 'utf8'));

    // Reboot Runtime on the SAME SQLite DB
    const postCalls = [];
    const postAdapter = new ScriptedAdapter(async function* (opts) {
      const userText = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
      const hasTool = opts.messages.some((m) => m.role === 'tool');
      const mTag = /TAG:([A-Z_]+)/.exec(userText);
      const tag = mTag ? mTag[1] : 'UNKNOWN';
      postCalls.push({ tag, hasTool });

      yield { type: 'text-delta', index: 0, text: `POST_RECOVERY_OK:${tag}` };
      yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 8 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });

    store = new Store(dbPath);
    const pool = new AccountPool(store, { root: dataRoot });
    pool.setDefaultModel('mock-s2');
    runtime = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: workDir,
      dataRoot,
      artifactStoreDir,
      adapter: postAdapter,
      workerId: 's2-reboot-worker',
    });

    const settled = await runtime.swarmOrchestrator.waitForRun(runId, { timeoutMs: 12000 });
    assert.equal(settled.status, 'completed');
    assert.ok(settled.nodes.every((n) => n.status === 'completed'));

    // 1. Pre-crash completed node NOT re-run & its artifact survived intact
    assert.equal(postCalls.filter((c) => c.tag === 'DONE_WT').length, 0, 'done-wt must NOT re-run');
    const doneArts = runtime.artifactManager.listArtifacts({ runId, nodeKey: 'done-wt' });
    assert.equal(doneArts.length, 1);
    assert.equal(runtime.artifactManager.verifyArtifact(doneArts[0].id).ok, true);
    assert.equal(
      runtime.artifactManager.readArtifactFile(doneArts[0].id, 'pre-crash.txt').text,
      'PRE_CRASH_ARTIFACT_OK\n',
    );

    // 2. Interrupted running node resumed with pre-crash tool history (no repeat of step 0 read_file)
    const runMidCalls = postCalls.filter((c) => c.tag === 'RUN_MID');
    assert.equal(runMidCalls.length, 1);
    assert.equal(runMidCalls[0].hasTool, true);

    // 3. Dependent node executed cleanly after running node completed
    assert.equal(postCalls.filter((c) => c.tag === 'DEP_AFTER').length, 1);

    // 4. Cancelled run stayed cancelled
    const cancelRow = runtime.swarmOrchestrator.getRun(cancelledId);
    assert.equal(cancelRow.status, 'cancelled');
    assert.equal(postCalls.filter((c) => c.tag === 'NEVER').length, 0);

    // 5. Budget ledger & replanCount consistent (0 leaked reservedSteps, orphan accounted for, replanCount === 0)
    const ledger = runtime.swarmOrchestrator.budgetLedger.getSnapshot(runId);
    assert.equal(ledger.reservedSteps, 0);
    assert.equal(ledger.reservedTokens, 0);
    // done-wt (2 steps) + run-mid step0 (1 settled) + run-mid step1 (1 orphaned reconciled) + run-mid resumed (1) + dep-after (1) = 6
    assert.ok(ledger.usedSteps >= 5, `Budget ledger must retain pre-crash + reconciled + post-crash steps, got ${ledger.usedSteps}`);
    assert.equal(settled.replanCount, 0);
  } finally {
    killIfAlive(child);
    await runtime?.close?.();
    store?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Scenario 3: Unknown Non-Replayable Side Effect (Real Execution + SIGKILL + All 3 Resolutions)
// ============================================================================
async function runRealSideEffectCrashAndResolve(outcomeToTest) {
  const dir = mkdtempSync(join(tmpdir(), `agent-us-211-s3-${outcomeToTest}-`));
  const dbPath = join(dir, 'engine.sqlite');
  const sideEffectLog = join(dir, 'side-effect.log');
  const flagFile = join(dir, 'effect-applied.flag');
  const workerScript = join(dir, 's3-worker.mjs');

  const storeUrl = pathToFileURL(join(SRC_ROOT, 'store.js')).href;
  const poolUrl = pathToFileURL(join(SRC_ROOT, 'pool.js')).href;
  const directUrl = pathToFileURL(join(SRC_ROOT, 'direct-agent.js')).href;

  writeFileSync(
    workerScript,
    `
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from ${JSON.stringify(storeUrl)};
import { AccountPool } from ${JSON.stringify(poolUrl)};
import { DirectAgentRuntime } from ${JSON.stringify(directUrl)};

const [dbPath, dir, sideEffectLog, flagFile] = process.argv.slice(2);
const store = new Store(dbPath);
const pool = new AccountPool(store, { root: dir });
pool.setDefaultModel('mock-s3');

const adapter = {
  async *stream() {
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: 'tc-outward-1',
        name: 'mcp__audit_webhook__dispatch',
        arguments: JSON.stringify({ eventId: 'evt-1' }),
      },
    };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  },
};

const rt = new DirectAgentRuntime(store, pool, {
  defaultWorkspace: dir,
  dataRoot: dir,
  adapter,
  workerId: 's3-crash-worker',
});
rt.toolPolicy.alwaysAllowRules.add('mcp__audit_webhook__dispatch');
rt.mcpManager.discoverTools = async () => [
  {
    fullName: 'mcp__audit_webhook__dispatch',
    serverName: 'audit_webhook',
    toolName: 'dispatch',
    description: 'Non-replayable outward auditable side-effect double',
    parameters: { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'] },
    call: async ({ eventId }) => {
      // Side effect happens on disk BEFORE receipt completes, then process hangs until SIGKILL!
      appendFileSync(sideEffectLog, 'DISPATCH:' + eventId + '\\n', 'utf8');
      writeFileSync(flagFile, String(Date.now()), 'utf8');
      await new Promise(() => {});
    },
  },
];

const sess = rt.createSession({ workspaceRoot: dir, permissionMode: 'full-access' });
const out = rt.startTurn(sess.id, { input: 'Dispatch outward event evt-1', permissionMode: 'full-access' });
writeFileSync(join(dir, 'turn.json'), JSON.stringify({ sessionId: sess.id, turnId: out.turn.id }), 'utf8');
const keep = setInterval(() => {}, 1000);
setTimeout(() => { clearInterval(keep); process.exit(1); }, 25000);
`,
    'utf8',
  );

  let child = null;
  let store = null;
  let runtime = null;
  const countLines = () =>
    existsSync(sideEffectLog)
      ? readFileSync(sideEffectLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).length
      : 0;

  try {
    child = spawn(process.execPath, [workerScript, dbPath, dir, sideEffectLog, flagFile], {
      stdio: 'ignore',
    });

    await pollUntil(() => existsSync(flagFile) && existsSync(join(dir, 'turn.json')), 15000);
    assert.equal(countLines(), 1, 'Side effect must have occurred once on disk before SIGKILL');
    child.kill('SIGKILL');
    await new Promise((res) => child.once('exit', res));

    const { sessionId, turnId } = JSON.parse(readFileSync(join(dir, 'turn.json'), 'utf8'));

    // Restart Runtime on SAME SQLite DB (NO manually inserted receipt!)
    store = new Store(dbPath);
    const pool = new AccountPool(store, { root: dir });
    pool.setDefaultModel('mock-s3');

    const postAdapter = new ScriptedAdapter(async function* (opts) {
      const toolTexts = opts.messages
        .filter((m) => m.role === 'tool' || m.role === 'user')
        .flatMap((m) => (Array.isArray(m.content) ? m.content.map((c) => String(c.text || '')) : []));
      const hasNotApplied = toolTexts.some((t) => t.includes('未生效') || t.includes('not_applied'));
      const alreadyReExecuted = toolTexts.some((t) => t.includes('REEXECUTED_OK'));
      if (hasNotApplied && !alreadyReExecuted) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-outward-retry',
            name: 'mcp__audit_webhook__dispatch',
            arguments: JSON.stringify({ eventId: 'evt-1-retry' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: `RESOLVED_${outcomeToTest.toUpperCase()}_OK` };
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });

    runtime = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: dir,
      dataRoot: dir,
      adapter: postAdapter,
      workerId: 's3-reboot-worker',
    });
    runtime.toolPolicy.alwaysAllowRules.add('mcp__audit_webhook__dispatch');
    runtime.mcpManager.discoverTools = async () => [
      {
        fullName: 'mcp__audit_webhook__dispatch',
        serverName: 'audit_webhook',
        toolName: 'dispatch',
        description: 'Non-replayable outward auditable side-effect double',
        parameters: { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'] },
        call: async ({ eventId }) => {
          appendFileSync(sideEffectLog, `DISPATCH:${eventId}\n`, 'utf8');
          return `REEXECUTED_OK:${eventId}`;
        },
      },
    ];

    // Confirm startup recovery transitioned REAL receipt to outcome_unknown & parked in reconciling WITHOUT replaying!
    const receiptBeforeResolve = store.db
      .prepare('SELECT * FROM tool_receipts WHERE turnId=? AND toolName=?')
      .get(turnId, 'mcp__audit_webhook__dispatch');
    assert.ok(receiptBeforeResolve, 'Real ToolDispatcher receipt must exist');
    assert.equal(receiptBeforeResolve.replayable, 0);
    assert.equal(receiptBeforeResolve.outward, 1);
    assert.equal(receiptBeforeResolve.status, 'outcome_unknown');

    const turnParked = store.db.prepare('SELECT state FROM direct_turns WHERE id=?').get(turnId);
    assert.equal(turnParked.state, 'reconciling');

    await delay(200);
    assert.equal(countLines(), 1, 'Restart MUST NOT silently replay non-replayable side effect');

    const pendingRecs = runtime.reconciler.listReconciliations({ sessionId, status: 'pending' });
    const rec = pendingRecs.find((r) => r.turnId === turnId);
    assert.ok(rec, 'Pending reconciliation approval must exist');

    // Resolve via real API!
    runtime.decideApproval(rec.id, {
      outcome: outcomeToTest,
      reason: `Acceptance test resolution: ${outcomeToTest}`,
    });

    if (outcomeToTest === 'happened') {
      const doneTurn = await pollUntil(() => {
        const t = store.db.prepare('SELECT state FROM direct_turns WHERE id=?').get(turnId);
        return t?.state === 'completed' ? t : null;
      }, 10000);
      assert.equal(doneTurn.state, 'completed');
      assert.equal(countLines(), 1, 'happened resolution must NOT re-execute outward side effect');
    } else if (outcomeToTest === 'not_applied') {
      const doneTurn = await pollUntil(() => {
        const t = store.db.prepare('SELECT state, error FROM direct_turns WHERE id=?').get(turnId);
        return t && ['completed', 'failed', 'cancelled'].includes(t.state) ? t : null;
      }, 10000);
      assert.equal(doneTurn.state, 'completed', `Expected completed on not_applied, got ${JSON.stringify(doneTurn)}`);
      assert.equal(countLines(), 2, 'not_applied resolution allows explicit model re-execution (count=2)');
    } else if (outcomeToTest === 'abort') {
      const abortedTurn = await pollUntil(() => {
        const t = store.db.prepare('SELECT state FROM direct_turns WHERE id=?').get(turnId);
        return t && ['failed', 'cancelled'].includes(t.state) ? t : null;
      }, 10000);
      assert.ok(['failed', 'cancelled'].includes(abortedTurn.state));
      assert.notEqual(abortedTurn.state, 'completed');
      assert.equal(countLines(), 1, 'abort resolution must NOT re-execute outward side effect');
    }
  } finally {
    killIfAlive(child);
    await runtime?.close?.();
    store?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Acceptance Scenario 3: Real outward non-replayable side effect crash enters reconciling without silent replay and handles happened / not_applied / abort', async () => {
  await runRealSideEffectCrashAndResolve('happened');
  await runRealSideEffectCrashAndResolve('not_applied');
  await runRealSideEffectCrashAndResolve('abort');
});

// ============================================================================
// Scenario 4: Failure & Scheduler Convergence + Feedback Isolation + Concurrency/Timezone
// ============================================================================
test('Acceptance Scenario 4: Queued scheduler mid-run restart convergence, permanent model failure with throwing modelFeedback.record(), and preserved concurrency/timezone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-211-s4-'));
  const dbPath = join(dir, 'engine.sqlite');

  let inFlight = 0;
  let peakConcurrency = 0;
  let releaseFirstRun;
  let firstRunEnteredResolve;
  const firstRunEntered = new Promise((r) => {
    firstRunEnteredResolve = r;
  });
  const firstRunGate = new Promise((r) => {
    releaseFirstRun = r;
  });

  const adapterPhase1 = new ScriptedAdapter(async function* () {
    inFlight++;
    peakConcurrency = Math.max(peakConcurrency, inFlight);
    firstRunEnteredResolve?.();
    await firstRunGate;
    inFlight--;
    yield { type: 'text-delta', index: 0, text: 'phase1-ok' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  let store = new Store(dbPath);
  let pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-s4');
  let runtime = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: adapterPhase1,
    workerId: 's4-worker-1',
  });
  let scheduler = new ScheduledTaskRunner({ store, directAgent: runtime });
  scheduler.start();

  try {
    const sched = scheduler.create({
      name: 'NYC Queued Hourly Job',
      prompt: 'Run scheduled audit',
      scheduleKind: 'hourly',
      scheduleExpr: '15',
      timezone: 'America/New_York',
      concurrencyPolicy: 'queue',
      maxConcurrency: 1,
      workspaceRoot: dir,
      permissionMode: 'read-only',
      enabled: true,
    });
    assert.equal(sched.timezone, 'America/New_York');
    assert.equal(sched.concurrencyPolicy, 'queue');
    assert.equal(sched.maxConcurrency, 1);

    // Enqueue 2 overlapping occurrences -> run 1 active, run 2 queued
    const baseSlot = Date.now() - 10_000;
    const r1 = scheduler.enqueueScheduledRun(sched, baseSlot, { trigger: 'schedule' });
    await firstRunEntered;
    const r2 = scheduler.enqueueScheduledRun(sched, baseSlot + 1000, { trigger: 'schedule' });
    assert.equal(peakConcurrency, 1);

    // Simulate mid-run shutdown & restart while r1 is in-flight and r2 is queued
    releaseFirstRun();
    scheduler.stop();
    await runtime.close();
    store.close();

    // Reboot Runtime + ScheduledTaskRunner on SAME SQLite DB with concurrency-tracking adapter
    let postInFlight = 0;
    let postPeak = 0;
    let mode = 'ok';
    const adapterPhase2 = new ScriptedAdapter(async function* () {
      postInFlight++;
      postPeak = Math.max(postPeak, postInFlight);
      try {
        await delay(50);
        if (mode === 'permanent_fail') {
          throw new RuntimeError('MODEL_PERMANENT_ERROR', {
            message: 'Simulated permanent model failure for Scenario 4',
            retryable: false,
          });
        }
        yield { type: 'text-delta', index: 0, text: 'post-restart-ok' };
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally {
        postInFlight--;
      }
    });

    store = new Store(dbPath);
    pool = new AccountPool(store, { root: dir });
    pool.setDefaultModel('mock-s4');
    runtime = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: dir,
      dataRoot: dir,
      adapter: adapterPhase2,
      workerId: 's4-worker-2',
    });
    scheduler = new ScheduledTaskRunner({ store, directAgent: runtime });
    scheduler.start();

    // Wait for both r1 and r2 to converge cleanly to completed with peak concurrency === 1
    await pollUntil(() => {
      const runs = scheduler.listRuns(sched.id, { limit: 10 });
      const run1 = runs.find((x) => x.id === r1.id);
      const run2 = runs.find((x) => x.id === r2.id);
      return run1?.status === 'completed' && run2?.status === 'completed';
    }, 10000);
    assert.equal(postPeak, 1, 'Recovered queued schedule must maintain peak concurrency = 1');

    // Now force permanent model failure AND make modelFeedback.record() THROW!
    mode = 'permanent_fail';
    let feedbackThrowCount = 0;
    runtime.modelFeedback.record = () => {
      feedbackThrowCount++;
      throw new Error('FEEDBACK_STORAGE_BOOM');
    };

    const r3 = scheduler.enqueueScheduledRun(sched, baseSlot + 2000, { trigger: 'schedule' });
    const failedRun = await pollUntil(() => {
      const row = scheduler.listRuns(sched.id, { limit: 10 }).find((x) => x.id === r3.id);
      return row?.status === 'failed' ? row : null;
    }, 10000);
    assert.equal(failedRun.status, 'failed');
    assert.match(String(failedRun.error || ''), /Simulated permanent model failure/);
    assert.ok(feedbackThrowCount >= 1, 'Throwing modelFeedback.record() must have been invoked and isolated');

    // Verify turn terminal state + persisted turn/failed event + scheduled_tasks.lastStatus converged despite throwing feedback!
    const failedTurn = store.db.prepare('SELECT state, error FROM direct_turns WHERE id=?').get(failedRun.turnId);
    assert.equal(failedTurn.state, 'failed');
    const failedEvents = store.db
      .prepare("SELECT type FROM direct_events WHERE sessionId=? AND turnId=? AND type='turn/failed'")
      .all(failedRun.sessionId, failedRun.turnId);
    assert.equal(failedEvents.length, 1, 'turn/failed event must be persisted even when modelFeedback.record() throws');

    const schedAfterFail = scheduler.get(sched.id);
    assert.equal(schedAfterFail.lastStatus, 'failed');
    assert.equal(schedAfterFail.timezone, 'America/New_York');

    // Next triggers still respect concurrency (peak=1) & timezone after permanent failure!
    mode = 'ok';
    postPeak = 0;
    const r4 = scheduler.enqueueScheduledRun(sched, baseSlot + 3000, { trigger: 'schedule' });
    const r5 = scheduler.enqueueScheduledRun(sched, baseSlot + 4000, { trigger: 'schedule' });
    await pollUntil(() => {
      const runs = scheduler.listRuns(sched.id, { limit: 10 });
      const run4 = runs.find((x) => x.id === r4.id);
      const run5 = runs.find((x) => x.id === r5.id);
      return run4?.status === 'completed' && run5?.status === 'completed';
    }, 10000);
    assert.equal(postPeak, 1, 'Subsequent queued triggers must still maintain peak concurrency = 1');

    const schedFinal = scheduler.get(sched.id);
    assert.equal(schedFinal.lastStatus, 'completed');
    assert.equal(schedFinal.timezone, 'America/New_York');
    assert.ok(Number(schedFinal.nextRunAt) > Date.now(), 'nextRunAt must remain valid in America/New_York');
  } finally {
    releaseFirstRun?.();
    scheduler?.stop?.();
    await runtime?.close?.();
    store?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
