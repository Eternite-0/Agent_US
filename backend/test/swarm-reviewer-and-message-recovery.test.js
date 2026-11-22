import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { InterAgentMailbox } from '../src/swarm/mailbox.js';
import { CommunicationBus, StoreCommunicationAdapter } from '../src/communication/index.js';
import { rmDirSafe } from './fixtures.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
  }
  async *stream(opts) {
    yield* this.handler(opts);
  }
}

function initGitWorkspace(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Repo\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@agent-us.invalid'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Agent_US Test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir, stdio: 'ignore' });
}

async function pollUntil(fn, timeoutMs = 15_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await wait(intervalMs);
  }
  throw new Error(`Timed out polling after ${timeoutMs}ms`);
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child ${child.pid} did not exit within ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test('real read-only child reviewer verifies upstream artifacts, receipts, and rejects write escalation', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-real-rev-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-real-rev-work-'));
  initGitWorkspace(workDir);

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'custom-openai',
    label: 'Test Workers',
    endpoint: 'https://api.example.invalid/v1',
    credential: 'sk-test-reviewer-fixture',
    models: ['worker-alpha', 'worker-beta', 'reviewer-model'],
  });
  pool.setDefaultModel('worker-alpha');

  let reviewerObservedWriteDenied = false;
  let reviewerReadArtifacts = [];

  const adapter = new ScriptedAdapter(async function* (opts) {
    const messages = opts.messages ?? [];
    const userText = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content?.[0]?.text ?? '')
      .join('\n');
    const lastRole = messages.at(-1)?.role;
    const toolMsgs = messages.filter((m) => m.role === 'tool');

    if (opts.model === 'reviewer-model') {
      if (toolMsgs.length === 0) {
        // Attempt a forbidden write first to prove read-only tool policy blocks it,
        // while also reading the first predecessor artifact manifest.
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'rev-write-attempt',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'README.md', content: '# Hijacked by reviewer\n' }),
          },
        };
        yield {
          type: 'block-end',
          index: 1,
          block: {
            type: 'tool-call',
            id: 'rev-read-a-manifest',
            name: 'read_swarm_artifact',
            arguments: JSON.stringify({ nodeKey: 'impl-a' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }

      if (toolMsgs.length === 2) {
        const writeResp = String(toolMsgs[0]?.content?.[0]?.text ?? '');
        if (/安全策略拦截|allowlist|denied|not allowed|policy/i.test(writeResp)) {
          reviewerObservedWriteDenied = true;
        }
        reviewerReadArtifacts.push(String(toolMsgs[1]?.content?.[0]?.text ?? ''));
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'rev-read-a-file',
            name: 'read_swarm_artifact',
            arguments: JSON.stringify({ nodeKey: 'impl-a', path: 'src/a.js' }),
          },
        };
        yield {
          type: 'block-end',
          index: 1,
          block: {
            type: 'tool-call',
            id: 'rev-read-b-file',
            name: 'read_swarm_artifact',
            arguments: JSON.stringify({ nodeKey: 'impl-b', path: 'src/b.js' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }

      for (const tm of toolMsgs.slice(2)) {
        reviewerReadArtifacts.push(String(tm?.content?.[0]?.text ?? ''));
      }
      const manifestMarker = '[Durable evidence manifest]\n';
      const idx = userText.indexOf(manifestMarker);
      const parsedManifest = idx >= 0 ? JSON.parse(userText.slice(idx + manifestMarker.length).trim()) : {};
      const artifactUris = (parsedManifest.artifacts ?? []).map((a) => a.uri);
      const receiptIds = (parsedManifest.receipts ?? []).map((r) => r.receiptId);
      const verdictStates = (parsedManifest.turnVerdicts ?? []).map((v) => `${v.turnId}:${v.state}`);
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          decision: 'approved',
          writeBlocked: reviewerObservedWriteDenied,
          artifactUris,
          receiptIds,
          verdictStates,
        }),
      };
      yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 20 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    // Worker nodes write disjoint files in isolated git worktrees
    if (lastRole !== 'tool') {
      const isA = userText.includes('WORK_A');
      const targetPath = isA ? 'src/a.js' : 'src/b.js';
      const content = isA ? 'export const a = 1;\n' : 'export const b = 2;\n';
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: `tc-write-${isA ? 'a' : 'b'}`,
          name: 'write_file',
          arguments: JSON.stringify({ path: targetPath, content }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    yield {
      type: 'text-delta',
      index: 0,
      text: userText.includes('WORK_A') ? 'impl-a wrote src/a.js' : 'impl-b wrote src/b.js',
    };
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });

  try {
    const parent = direct.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
    const runResult = await direct.swarmOrchestrator.startRun({
      sessionId: parent.id,
      goal: 'Parallel worktrees with independent child reviewer',
      workspaceRoot: workDir,
      maxConcurrency: 2,
      nodes: [
        {
          nodeKey: 'impl-a',
          taskType: 'implementation',
          objective: 'WORK_A: create src/a.js',
          isolationMode: 'worktree',
          priority: 10,
        },
        {
          nodeKey: 'impl-b',
          taskType: 'implementation',
          objective: 'WORK_B: create src/b.js',
          isolationMode: 'worktree',
          priority: 10,
        },
      ],
    });

    assert.equal(runResult.status, 'completed', `Swarm failed: ${runResult.summary}`);
    const reviewerNode = runResult.nodes.find((n) => n.taskType === 'review');
    assert.ok(reviewerNode, 'TeamOptimizer must materialize a durable review node');
    assert.equal(reviewerNode.status, 'completed');
    assert.equal(reviewerNode.model, 'reviewer-model');
    assert.equal(reviewerNode.isolationMode, 'shared_readonly');
    assert.deepEqual(
      [...reviewerNode.toolAllow].sort(),
      ['glob', 'grep', 'read_blob', 'read_file', 'read_swarm_artifact'],
    );
    assert.equal(reviewerObservedWriteDenied, true, 'Reviewer must be blocked from write_file');
    assert.ok(reviewerReadArtifacts.some((txt) => txt.includes('export const a = 1;')));
    assert.ok(reviewerReadArtifacts.some((txt) => txt.includes('export const b = 2;')));

    const reviewJson = JSON.parse(reviewerNode.resultText);
    assert.equal(reviewJson.decision, 'approved');
    assert.equal(reviewJson.writeBlocked, true);
    assert.equal(reviewJson.artifactUris.length, 2);
    assert.ok(reviewJson.receiptIds.length >= 2);
    assert.equal(reviewJson.verdictStates.length, 2);

    // Check reviewer's own tool receipts in SQLite
    const reviewerReceipts = store.db
      .prepare('SELECT toolName, status, errorCode FROM tool_receipts WHERE sessionId=? AND turnId=? ORDER BY createdAt ASC')
      .all(reviewerNode.childSessionId, reviewerNode.childTurnId);
    assert.ok(
      reviewerReceipts.some(
        (r) => r.toolName === 'write_file' && r.status === 'rejected_before_effect' && r.errorCode === 'POLICY_DENIED',
      ),
    );
    assert.ok(reviewerReceipts.filter((r) => r.toolName === 'read_swarm_artifact' && r.status === 'finished').length >= 3);

    // Parent workspace must remain unmodified
    const statusOut = execFileSync('git', ['status', '--porcelain'], { cwd: workDir, encoding: 'utf8' }).trim();
    assert.equal(statusOut, '', 'Reviewer and worktree workers must not mutate parent workspace');
    assert.equal(existsSync(join(workDir, 'src', 'a.js')), false);
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('SIGKILL in post-turn-commit / pre-ACK window reuses original turn without duplicate injection or side effects and rejects stale deliveryToken', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-ack-window-sigkill-'));
  const workDir = join(dir, 'work');
  initGitWorkspace(workDir);
  const dbPath = join(dir, 'engine.sqlite');
  const markerPath = join(dir, 'ack-window-marker.json');
  const effectLogPath = join(dir, 'side-effects.log');

  const storeUrl = pathToFileURL(join(process.cwd(), 'src', 'store.js')).href;
  const poolUrl = pathToFileURL(join(process.cwd(), 'src', 'pool.js')).href;
  const agentUrl = pathToFileURL(join(process.cwd(), 'src', 'direct-agent.js')).href;

  const crashWorkerScript = join(dir, 'crash-before-ack.mjs');
  writeFileSync(
    crashWorkerScript,
    `
import { appendFileSync, writeFileSync } from 'node:fs';
import { Store } from ${JSON.stringify(storeUrl)};
import { AccountPool } from ${JSON.stringify(poolUrl)};
import { DirectAgentRuntime } from ${JSON.stringify(agentUrl)};

const [dbPath, workDir, markerPath, effectLogPath] = process.argv.slice(2);
const store = new Store(dbPath);
const pool = new AccountPool(store, { root: workDir });
pool.setDefaultModel('mock-ack-window');

const adapter = {
  async *stream({ messages }) {
    appendFileSync(effectLogPath, 'invoked-in-crash-process\\n', 'utf8');
    yield { type: 'text-delta', index: 0, text: 'CRASH_PROCESS_SHOULD_NOT_RUN_TURN' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};

const direct = new DirectAgentRuntime(store, pool, {
  defaultWorkspace: workDir,
  dataRoot: workDir,
  adapter,
  enableHeartbeat: false,
});
direct.swarmOrchestrator.communicationVisibilityTimeoutMs = 120;
direct.childManager.onBeforeCommunicationAck = async ({ runId, nodeId, nodeKey, childSessionId, childTurnId, message }) => {
  writeFileSync(markerPath, JSON.stringify({
    runId,
    nodeId,
    nodeKey,
    childSessionId,
    childTurnId,
    messageId: message.messageId,
    staleToken: message.deliveryToken,
  }), 'utf8');
  await new Promise(() => {}); // Hang in the post-commit / pre-ACK crash window until SIGKILL
};

const parent = direct.createSession({ title: 'ACK Window Parent', workspaceRoot: workDir });
const sent = await direct.mailbox.send({
  conversationId: 'ack-window-conv',
  runId: 'ack-window-run',
  fromAgentId: 'coordinator',
  toAgentId: 'worker-a',
  kind: 'task_assignment',
  idempotencyKey: 'ack-window-assign-1',
  payload: { instruction: 'UNIQUE_ASSIGNMENT_MARKER_771' },
});
const submitted = direct.swarmOrchestrator.submitRun({
  sessionId: parent.id,
  goal: 'ACK window SIGKILL test',
  workspaceRoot: workDir,
  nodes: [{ nodeKey: 'worker-a', taskType: 'research', objective: 'Complete bound assignment', dependencies: [] }],
});
// Match the message runId to the actual swarm runId if needed: re-send bound to actual runId!
await direct.mailbox.send({
  conversationId: 'ack-window-conv',
  runId: submitted.runId,
  fromAgentId: 'coordinator',
  toAgentId: 'worker-a',
  kind: 'task_assignment',
  idempotencyKey: 'ack-window-assign-real',
  payload: { instruction: 'UNIQUE_ASSIGNMENT_MARKER_771' },
});
// Re-trigger resolve only if needed; submitRun already enqueued DEPENDENCY_RESOLVE asynchronously.
const keep = setInterval(() => {}, 1000);
setTimeout(() => { clearInterval(keep); process.exit(1); }, 25_000);
`,
    'utf8',
  );

  // Wait — ensure the message for submitted.runId exists BEFORE DEPENDENCY_RESOLVE dispatches worker-a!
  // Let's create the parent session + message + submitted run cleanly in parent or send before submitRun?
  // Note: runId is generated inside submitRun; if we set a small delay or create via worker BEFORE recoveryWorker starts,
  // there is zero race condition! Let's update the worker script to enqueue/send before starting worker OR cancel/use mailbox on a paused queue,
  // or simpler: pass pre-created run/message OR construct Store before DirectAgentRuntime, OR send with `nextAttemptAt` / pause RecoveryWorker until message is sent!
  // Actually, DirectAgentRuntime constructor starts recoveryWorker immediately; better yet, submitRun in a 2nd step? Wait:
  // If we use a helper in crashWorkerScript that pauses recoveryWorker or calls CommunicationBus directly on store, OR even cleaner:
  // submit the run in parent, OR pause `direct.recoveryWorker.stopping = true`? No, `swarmOrchestrator` has no dependency on `runId` pre-generation unless we insert message after pausing!
  // Actually: `submitRun` inserts into `swarm_runs` and `runtime_jobs`. If `RecoveryWorker` hasn't picked up `DEPENDENCY_RESOLVE` yet (microtask), sending synchronously or awaiting before `wake`?
  //Wait: `bus.send` is async and `submitRun` is synchronous! So if `submitRun()` runs BEFORE `await mailbox.send(...)`, `RecoveryWorker` might wake on the next tick!
  // Let's prevent that race cleanly: in `crashWorkerScript`, create `DirectAgentRuntime` with `enableHeartbeat: false`, send the `CommunicationBus` message AFTER `submitRun`? No — send `submitted` while `direct.recoveryWorker.stopping = true`, OR simply don't run `submitRun` until message is sent? Wait: `CommunicationBus` requires `runId === submitted.runId`!
  // Let's pause `recoveryWorker` during setup by setting `direct.recoveryWorker.stop()`? Even simpler: create `store`, `pool`, `direct` with `enableHeartbeat: false`; call `await direct.recoveryWorker.stop()`, call `submitRun()`, call `await direct.mailbox.send({ ..., runId: submitted.runId })`, then call `direct.recoveryWorker.start({ recover: false })`! ZERO race condition!

  writeFileSync(
    crashWorkerScript,
    `
import { appendFileSync, writeFileSync } from 'node:fs';
import { Store } from ${JSON.stringify(storeUrl)};
import { AccountPool } from ${JSON.stringify(poolUrl)};
import { DirectAgentRuntime } from ${JSON.stringify(agentUrl)};

const [dbPath, workDir, markerPath, effectLogPath] = process.argv.slice(2);
const store = new Store(dbPath);
const pool = new AccountPool(store, { root: workDir });
pool.setDefaultModel('mock-ack-window');

const adapter = {
  async *stream() {
    appendFileSync(effectLogPath, 'invoked-in-crash-process\\n', 'utf8');
    yield { type: 'text-delta', index: 0, text: 'CRASH_PROCESS_SHOULD_NOT_RUN_TURN' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};

const direct = new DirectAgentRuntime(store, pool, {
  defaultWorkspace: workDir,
  dataRoot: workDir,
  adapter,
  enableHeartbeat: false,
});
direct.swarmOrchestrator.communicationVisibilityTimeoutMs = 120;
await direct.recoveryWorker.stop();

direct.childManager.onBeforeCommunicationAck = async ({ runId, nodeId, nodeKey, childSessionId, childTurnId, message }) => {
  writeFileSync(markerPath, JSON.stringify({
    runId,
    nodeId,
    nodeKey,
    childSessionId,
    childTurnId,
    messageId: message.messageId,
    staleToken: message.deliveryToken,
  }), 'utf8');
  await new Promise(() => {});
};

const parent = direct.createSession({ title: 'ACK Window Parent', workspaceRoot: workDir });
const submitted = direct.swarmOrchestrator.submitRun({
  sessionId: parent.id,
  goal: 'ACK window SIGKILL test',
  workspaceRoot: workDir,
  nodes: [{ nodeKey: 'worker-a', taskType: 'research', objective: 'Complete bound assignment', dependencies: [] }],
});
await direct.mailbox.send({
  conversationId: 'ack-window-conv',
  runId: submitted.runId,
  fromAgentId: 'coordinator',
  toAgentId: 'worker-a',
  kind: 'task_assignment',
  idempotencyKey: 'ack-window-assign-real',
  payload: { instruction: 'UNIQUE_ASSIGNMENT_MARKER_771' },
});
direct.recoveryWorker.stopping = false;
direct.recoveryWorker.start({ recover: false });

const keep = setInterval(() => {}, 1000);
setTimeout(() => { clearInterval(keep); process.exit(1); }, 25_000);
`,
    'utf8',
  );

  let child1 = null;
  let direct2 = null;
  let store2 = null;
  t.after(async () => {
    if (child1 && child1.exitCode === null && child1.signalCode === null) {
      try { child1.kill('SIGKILL'); } catch {}
      try { await waitForExit(child1, 2_000); } catch {}
    }
    try { await direct2?.close(); } catch {}
    try { if (store2?.db?.isOpen) store2.close(); } catch {}
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  child1 = spawn(process.execPath, [crashWorkerScript, dbPath, workDir, markerPath, effectLogPath], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr1 = '';
  child1.stderr.setEncoding('utf8');
  child1.stderr.on('data', (chunk) => { stderr1 += chunk; });

  await pollUntil(() => existsSync(markerPath), 12_000);
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));

  // Inspect pre-SIGKILL durable state while Process 1 is frozen before ACK
  const checkStore = new Store(dbPath);
  try {
    const checkMailbox = new InterAgentMailbox({ store: checkStore });
    const msgBeforeKill = await checkMailbox.getMessage(marker.messageId);
    assert.equal(msgBeforeKill.status, 'delivered');
    assert.equal(msgBeforeKill.deliveryToken, marker.staleToken);
    assert.equal(msgBeforeKill.deliveryBinding.childTurnId, marker.childTurnId);
    assert.equal(msgBeforeKill.deliveryBinding.childSessionId, marker.childSessionId);
    const turnBeforeKill = checkStore.db.prepare('SELECT state FROM direct_turns WHERE id=?').get(marker.childTurnId);
    assert.equal(turnBeforeKill.state, 'running');
  } finally {
    checkStore.close();
  }

  child1.kill('SIGKILL');
  const exit1 = await waitForExit(child1, 10_000);
  assert.ok(exit1.code !== null || exit1.signal !== null, `Child 1 must die on SIGKILL (${stderr1})`);
  assert.equal(existsSync(effectLogPath), false, 'Crash before ACK must not have executed tools yet');

  // Wait past visibility timeout so the unclaimed delivery lease can be reclaimed safely
  await wait(200);

  // Also test that reclaiming with a second bus immediately invalidates staleToken,
  // or boot Recovery Runtime directly with communicationVisibilityTimeoutMs=120
  store2 = new Store(dbPath);
  const pool2 = new AccountPool(store2, { root: workDir });
  pool2.setDefaultModel('mock-ack-window');

  const observedPrompts = [];
  const postAdapter = new ScriptedAdapter(async function* (opts) {
    const texts = (opts.messages ?? [])
      .filter((m) => m.role === 'user')
      .map((m) => m.content?.map((c) => c.text).join('') ?? '')
      .join('\n');
    observedPrompts.push(texts);
    // Simulate a non-idempotent side effect once the recovered turn executes
    const { appendFileSync } = await import('node:fs');
    appendFileSync(effectLogPath, `recovered-effect:${marker.childTurnId}\n`, 'utf8');
    yield { type: 'text-delta', index: 0, text: 'RECOVERED_ONCE_OK' };
    yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 8 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  direct2 = new DirectAgentRuntime(store2, pool2, {
    defaultWorkspace: workDir,
    dataRoot: workDir,
    adapter: postAdapter,
    enableHeartbeat: false,
  });
  direct2.swarmOrchestrator.communicationVisibilityTimeoutMs = 120;

  const finished = await direct2.swarmOrchestrator.waitForRun(marker.runId, { timeoutMs: 12_000 });
  assert.equal(finished.status, 'completed');
  const workerNode = finished.nodes.find((n) => n.nodeKey === 'worker-a');
  assert.equal(workerNode.status, 'completed');
  assert.equal(workerNode.childSessionId, marker.childSessionId, 'must reuse original childSessionId');
  assert.equal(workerNode.childTurnId, marker.childTurnId, 'must reuse original childTurnId');

  // Verify zero duplicate turns, zero duplicate user message injections, and zero duplicate side effects
  const turnRows = store2.db.prepare('SELECT id, state FROM direct_turns WHERE sessionId=?').all(marker.childSessionId);
  assert.equal(turnRows.length, 1, 'must not spawn a second child turn');
  assert.equal(turnRows[0].state, 'completed');

  const userMsgRows = store2.db
    .prepare("SELECT content FROM direct_messages WHERE turnId=? AND role='user'")
    .all(marker.childTurnId);
  assert.equal(userMsgRows.length, 1, 'must not inject duplicate user message into direct_messages');
  assert.equal(
    userMsgRows[0].content.match(/UNIQUE_ASSIGNMENT_MARKER_771/g)?.length ?? 0,
    1,
    'assignment payload must appear exactly once',
  );
  assert.equal(observedPrompts.length, 1);

  const effectLines = readFileSync(effectLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(effectLines, [`recovered-effect:${marker.childTurnId}`]);

  const msgAfter = await direct2.mailbox.getMessage(marker.messageId);
  assert.equal(msgAfter.status, 'acked');
  await assert.rejects(
    () => direct2.mailbox.ack(marker.messageId, 'worker-a', marker.staleToken),
    (error) => error.code === 'DELIVERY_TOKEN_MISMATCH',
    'stale deliveryToken from crashed process must be rejected',
  );
});

test('multi-runtime concurrent receive grants exactly one active lease while keeping legacy mailbox compatible', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-comm-lease-'));
  const dbPath = join(dir, 'comm.sqlite');
  const storeA = new Store(dbPath);
  const storeB = new Store(dbPath);
  t.after(async () => {
    try { if (storeA.db.isOpen) storeA.close(); } catch {}
    try { if (storeB.db.isOpen) storeB.close(); } catch {}
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  let clockNow = 50_000;
  const busA = new CommunicationBus({
    adapter: new StoreCommunicationAdapter({ store: storeA }),
    clock: () => clockNow,
    visibilityTimeoutMs: 100,
  });
  const busB = new CommunicationBus({
    adapter: new StoreCommunicationAdapter({ store: storeB }),
    clock: () => clockNow,
    visibilityTimeoutMs: 100,
  });
  const mailboxA = new InterAgentMailbox({ store: storeA, communication: busA });
  const mailboxB = new InterAgentMailbox({ store: storeB, communication: busB });

  const sent = await mailboxA.send({
    conversationId: 'multi-lease-conv',
    runId: 'multi-lease-run',
    fromAgentId: 'coordinator',
    toAgentId: 'target-worker',
    kind: 'handoff',
    idempotencyKey: 'single-lease-only',
    payload: { work: 'exclusive' },
  });
  assert.equal(sent.status, 'created');

  // Race 6 concurrent claims across both runtimes
  const claims = (
    await Promise.all([
      mailboxA.receive('target-worker'),
      mailboxB.receive('target-worker'),
      mailboxA.receive('target-worker'),
      mailboxB.receive('target-worker'),
      mailboxA.receive('target-worker'),
      mailboxB.receive('target-worker'),
    ])
  ).filter(Boolean);
  assert.equal(claims.length, 1, 'strictly one execution lease may be active across competing runtimes');
  const firstClaim = claims[0];

  // After visibility timeout expires, competing runtime may reclaim with a fresh delivery token
  clockNow += 150;
  const secondClaim = await mailboxB.receive('target-worker');
  assert.ok(secondClaim);
  assert.equal(secondClaim.messageId, firstClaim.messageId);
  assert.notEqual(secondClaim.deliveryToken, firstClaim.deliveryToken);

  await assert.rejects(
    () => mailboxA.ack(firstClaim.messageId, 'target-worker', firstClaim.deliveryToken),
    (err) => err.code === 'DELIVERY_TOKEN_MISMATCH',
  );
  const acked = await mailboxB.ack(secondClaim.messageId, 'target-worker', secondClaim.deliveryToken);
  assert.equal(acked.status, 'acked');

  // Legacy InterAgentMailbox path (no conversationId) continues to work independently
  const legacy = mailboxA.send({
    runId: 'legacy-compat-run',
    fromAgentId: 'parent',
    toAgentId: 'target-worker',
    kind: 'note',
    payload: { legacy: true },
  });
  assert.equal(legacy.status, 'queued');
  assert.equal(mailboxB.peekInbox('target-worker', { runId: 'legacy-compat-run' }).length, 1);
  const drained = mailboxB.drainInbox('target-worker', { runId: 'legacy-compat-run' });
  assert.equal(drained.length, 1);
  assert.equal(mailboxA.drainInbox('target-worker', { runId: 'legacy-compat-run' }).length, 0);
});

test('upstream Swarm node publishes idempotent CommunicationBus handoffs that downstream acks, and review nodes normalize to shared_readonly', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-swarm-handoff-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-swarm-handoff-work-'));
  initGitWorkspace(workDir);

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('handoff-model');

  const adapter = new ScriptedAdapter(async function* (opts) {
    const userText = (opts.messages ?? [])
      .filter((m) => m.role === 'user')
      .map((m) => m.content?.[0]?.text ?? '')
      .join('\n');
    if (userText.includes('Implement part A')) {
      yield { type: 'text-delta', index: 0, text: 'PART_A_DONE' };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (userText.includes('Implement part B')) {
      yield { type: 'text-delta', index: 0, text: 'PART_B_DONE' };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'DOWNSTREAM_ACKED' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });

  t.after(async () => {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });
  const submitted = direct.swarmOrchestrator.submitPlannedRun({
    sessionId: sess.id,
    workspaceRoot: workDir,
    parentPermissionMode: 'full-access',
    maxConcurrency: 2,
    plan: {
      planVersion: 1,
      goal: 'Verify automatic handoff messages and reviewer isolation normalization',
      permissionMode: 'full',
      budget: { maxSteps: 20 },
      tasks: [
        {
          taskKey: 'part-a',
          taskType: 'research',
          objective: 'Implement part A',
          acceptance: 'Part A ready',
          dependencies: [],
          permissionMode: 'readonly',
        },
        {
          taskKey: 'part-b',
          taskType: 'research',
          objective: 'Implement part B',
          acceptance: 'Part B ready',
          dependencies: [],
          permissionMode: 'readonly',
        },
        {
          taskKey: 'reviewer-node',
          taskType: 'review',
          objective: 'Review both parts',
          acceptance: 'Review complete',
          dependencies: ['part-a', 'part-b'],
          permissionMode: 'full',
          metadata: { isolatedWorktree: true },
        },
      ],
    },
  });

  const settled = await direct.swarmOrchestrator.waitForRun(submitted.runId, { timeoutMs: 20_000 });
  assert.equal(settled.status, 'completed');

  const reviewRow = store.db
    .prepare('SELECT isolationMode, permissionMode, status FROM swarm_nodes WHERE runId=? AND nodeKey=?')
    .get(submitted.runId, 'reviewer-node');
  assert.equal(reviewRow.status, 'completed');
  assert.equal(reviewRow.isolationMode, 'shared_readonly');
  assert.equal(reviewRow.permissionMode, 'read-only');

  const handoffs = store
    .list('communication_messages', { limit: 100 })
    .filter((m) => m.runId === submitted.runId && m.kind === 'handoff');
  assert.equal(handoffs.length, 2);
  assert.deepEqual(
    handoffs.map((m) => m.fromAgentId).sort(),
    ['part-a', 'part-b'],
  );
  for (const msg of handoffs) {
    assert.equal(msg.toAgentId, 'reviewer-node');
    assert.equal(msg.status, 'acked');
    assert.equal(msg.conversationId, `swarm:${submitted.runId}`);
  }
});
