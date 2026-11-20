import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }
  async *stream(options) {
    this.calls.push({ model: options.model, messages: structuredClone(options.messages) });
    yield* this.handler(options, this.calls.length - 1);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(fn, timeoutMs = 10000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@agent-us.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Agent US Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'lease test repo\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

test('Fix D1-D4/D9: Runtime A active with valid lease (Direct & Swarm) is NOT taken over when Runtime B starts, and repeated recovery is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-fixd-live-'));
  const workDir = join(dir, 'repo');
  const dbPath = join(dir, 'engine.sqlite');
  mkdirSync(workDir, { recursive: true });
  initGitRepo(workDir);

  const directEntered = deferred();
  const directRelease = deferred();
  const swarmEntered = deferred();
  const swarmRelease = deferred();
  let directExecCount = 0;
  let swarmExecCount = 0;

  const adapterA = new ScriptedAdapter(async function* (opts) {
    const userText = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    if (userText.includes('DIRECT_LIVE_TASK')) {
      directExecCount++;
      directEntered.resolve();
      await directRelease.promise;
      yield { type: 'text-delta', index: 0, text: 'DIRECT_DONE_BY_A' };
      yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (userText.includes('SWARM_LIVE_NODE')) {
      swarmExecCount++;
      swarmEntered.resolve();
      await swarmRelease.promise;
      yield { type: 'text-delta', index: 0, text: 'SWARM_DONE_BY_A' };
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'ok' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const adapterB = new ScriptedAdapter(async function* (opts) {
    const userText = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    if (userText.includes('DIRECT_LIVE_TASK')) directExecCount++;
    if (userText.includes('SWARM_LIVE_NODE')) swarmExecCount++;
    yield { type: 'text-delta', index: 0, text: 'STOLEN_BY_B' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const storeA = new Store(dbPath);
  const storeB = new Store(dbPath);
  const poolA = new AccountPool(storeA, { root: dir });
  const poolB = new AccountPool(storeB, { root: dir });
  poolA.setDefaultModel('mock-d');
  poolB.setDefaultModel('mock-d');

  const runtimeA = new DirectAgentRuntime(storeA, poolA, {
    defaultWorkspace: workDir,
    dataRoot: dir,
    adapter: adapterA,
    leaseMs: 15000,
  });

  let runtimeB = null;
  try {
    const sessDirect = runtimeA.createSession({ workspaceRoot: workDir, title: 'Live Direct' });
    const turnOut = runtimeA.startTurn(sessDirect.id, { input: 'DIRECT_LIVE_TASK' });

    const sessSwarm = runtimeA.createSession({ workspaceRoot: workDir, title: 'Live Swarm', permissionMode: 'auto-safe' });
    const swarmOut = runtimeA.swarmOrchestrator.submitRun({
      sessionId: sessSwarm.id,
      goal: 'Live Swarm Run',
      workspaceRoot: workDir,
      nodes: [
        {
          nodeKey: 'live-wt',
          taskType: 'implementation',
          objective: 'SWARM_LIVE_NODE',
          dependencies: [],
          isolatedWorktree: true,
          isolationMode: 'worktree',
          toolAllow: ['write_file', 'read_file'],
        },
      ],
    });

    // Wait deterministically until Runtime A holds active leases for BOTH Direct turn and Swarm isolated worktree node
    await Promise.all([directEntered.promise, swarmEntered.promise]);

    const wtRowBefore = storeA.db
      .prepare("SELECT * FROM worktree_leases WHERE runId=? AND status='active'")
      .get(swarmOut.runId);
    assert.ok(wtRowBefore && existsSync(wtRowBefore.worktreePath), 'Runtime A must hold an active worktree');

    const directJobBefore = storeA.db
      .prepare('SELECT id, status, fence, workerId FROM runtime_jobs WHERE turnId=?')
      .get(turnOut.turn.id);
    const swarmJobBefore = storeA.db
      .prepare("SELECT id, status, fence, workerId FROM runtime_jobs WHERE taskId=? AND kind='swarm_node_execute'")
      .get(swarmOut.runId);
    assert.equal(directJobBefore.status, 'active');
    assert.equal(swarmJobBefore.status, 'active');

    // Start Runtime B sharing the same SQLite DB!
    runtimeB = new DirectAgentRuntime(storeB, poolB, {
      defaultWorkspace: workDir,
      dataRoot: dir,
      adapter: adapterB,
      leaseMs: 15000,
    });

    // Also invoke recovery repeatedly on Runtime B -> must be completely idempotent & non-destructive
    runtimeB.recoveryWorker.recoverOnStartup();
    runtimeB.swarmOrchestrator.recoverInterruptedRuns();
    runtimeB.recoveryWorker.recoverOnStartup();
    runtimeB.swarmOrchestrator.recoverInterruptedRuns();
    await runtimeB.worktreeIsolator.cleanupOrphans();

    // Runtime A's jobs, fences, and active worktree MUST remain completely untouched!
    assert.equal(runtimeB.lastRecoveryReport.recoveredTurns.length, 0, 'Runtime B must NOT steal live direct turn');
    const directJobAfter = storeA.db
      .prepare('SELECT id, status, fence, workerId FROM runtime_jobs WHERE id=?')
      .get(directJobBefore.id);
    const swarmJobAfter = storeA.db
      .prepare('SELECT id, status, fence, workerId FROM runtime_jobs WHERE id=?')
      .get(swarmJobBefore.id);
    assert.equal(directJobAfter.status, 'active');
    assert.equal(directJobAfter.fence, directJobBefore.fence, 'Direct job fence must NOT be cleared');
    assert.equal(swarmJobAfter.status, 'active');
    assert.equal(swarmJobAfter.fence, swarmJobBefore.fence, 'Swarm job fence must NOT be cleared or cancelled');
    assert.equal(existsSync(wtRowBefore.worktreePath), true, 'Runtime B must NOT delete Runtime A active worktree');

    // Release barriers -> Runtime A finishes cleanly; total execution count is strictly 1
    directRelease.resolve();
    swarmRelease.resolve();

    const finishedTurn = await waitUntil(() => {
      const t = storeA.db.prepare('SELECT * FROM direct_turns WHERE id=?').get(turnOut.turn.id);
      return t?.state === 'completed' ? t : null;
    });
    assert.equal(finishedTurn.state, 'completed');

    const finishedSwarm = await runtimeA.swarmOrchestrator.waitForRun(swarmOut.runId, { timeoutMs: 10000 });
    assert.equal(finishedSwarm.status, 'completed');
    assert.equal(finishedSwarm.nodes[0].resultText, 'SWARM_DONE_BY_A');
    assert.equal(directExecCount, 1, 'Direct turn must execute exactly once');
    assert.equal(swarmExecCount, 1, 'Swarm node must execute exactly once');
    assert.equal(adapterB.calls.length, 0, 'Runtime B must NOT have executed Runtime A live tasks');
  } finally {
    directRelease.resolve();
    swarmRelease.resolve();
    if (runtimeB) await runtimeB.close();
    await runtimeA.close();
    storeB.close();
    storeA.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fix D3/D5/D6/D7/C10: expired Runtime A is taken over by Runtime B; A late success, late error, notification, usage, and worktree cleanup cannot corrupt B', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-fixd-takeover-'));
  const workDir = join(dir, 'repo');
  const dbPath = join(dir, 'engine.sqlite');
  mkdirSync(workDir, { recursive: true });
  initGitRepo(workDir);

  // Scenario 1: Swarm node takeover + A late success + A late worktree release while B is active
  const aSwarmEntered = deferred();
  const aSwarmRelease = deferred();
  const bSwarmEntered = deferred();
  const bSwarmRelease = deferred();

  // Scenario 2: Swarm node takeover + A late ERROR after B took over
  const aErrEntered = deferred();
  const aErrRelease = deferred();
  const bErrEntered = deferred();
  const bErrRelease = deferred();

  // Scenario 3: Direct turn takeover + A late success with inflated usage
  const aDirectEntered = deferred();
  const aDirectRelease = deferred();

  const adapterA = new ScriptedAdapter(async function* (opts) {
    const userText = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    if (userText.includes('TAKEOVER_SUCCESS_NODE')) {
      aSwarmEntered.resolve();
      await aSwarmRelease.promise;
      yield { type: 'text-delta', index: 0, text: 'STALE_RESULT_FROM_A' };
      yield { type: 'usage', usage: { inputTokens: 999, outputTokens: 999 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (userText.includes('TAKEOVER_ERROR_NODE')) {
      aErrEntered.resolve();
      await aErrRelease.promise;
      throw new Error('LATE_CRASH_FROM_STALE_A');
    }
    if (userText.includes('TAKEOVER_DIRECT_TURN')) {
      aDirectEntered.resolve();
      await aDirectRelease.promise;
      yield { type: 'text-delta', index: 0, text: 'STALE_DIRECT_FROM_A' };
      yield { type: 'usage', usage: { inputTokens: 888, outputTokens: 888 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'ok' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const adapterB = new ScriptedAdapter(async function* (opts) {
    const userText = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const hasTool = opts.messages.some((m) => m.role === 'tool');
    if (userText.includes('TAKEOVER_SUCCESS_NODE')) {
      if (!hasTool) {
        bSwarmEntered.resolve();
        await bSwarmRelease.promise;
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-b-write',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'from-b.txt', content: 'owned-by-B\n' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'AUTHORITATIVE_RESULT_FROM_B' };
      yield { type: 'usage', usage: { inputTokens: 25, outputTokens: 15 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (userText.includes('TAKEOVER_ERROR_NODE')) {
      bErrEntered.resolve();
      await bErrRelease.promise;
      yield { type: 'text-delta', index: 0, text: 'CLEAN_SUCCESS_BY_B' };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (userText.includes('TAKEOVER_DIRECT_TURN')) {
      yield { type: 'text-delta', index: 0, text: 'DIRECT_AUTHORITATIVE_B' };
      yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 12 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'ok' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const storeA = new Store(dbPath);
  const storeB = new Store(dbPath);
  const poolA = new AccountPool(storeA, { root: dir });
  const poolB = new AccountPool(storeB, { root: dir });
  poolA.setDefaultModel('mock-takeover');
  poolB.setDefaultModel('mock-takeover');

  // Disable heartbeat on Runtime A so we deterministically expire its lease without timer races
  const runtimeA = new DirectAgentRuntime(storeA, poolA, {
    defaultWorkspace: workDir,
    dataRoot: dir,
    adapter: adapterA,
    leaseMs: 15000,
    enableHeartbeat: false,
  });

  let runtimeB = null;
  try {
    const sess = runtimeA.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
    const runSuccess = runtimeA.swarmOrchestrator.submitRun({
      sessionId: sess.id,
      goal: 'Takeover late success',
      workspaceRoot: workDir,
      nodes: [
        {
          nodeKey: 'n-succ',
          taskType: 'implementation',
          objective: 'TAKEOVER_SUCCESS_NODE',
          dependencies: [],
          isolatedWorktree: true,
          isolationMode: 'worktree',
          toolAllow: ['write_file', 'read_file'],
        },
      ],
    });
    const runErr = runtimeA.swarmOrchestrator.submitRun({
      sessionId: sess.id,
      goal: 'Takeover late error',
      workspaceRoot: workDir,
      maxReplans: 0,
      nodes: [
        {
          nodeKey: 'n-err',
          taskType: 'research',
          objective: 'TAKEOVER_ERROR_NODE',
          dependencies: [],
        },
      ],
    });
    const directSess = runtimeA.createSession({ workspaceRoot: workDir, title: 'Direct Takeover' });
    const directOut = runtimeA.startTurn(directSess.id, { input: 'TAKEOVER_DIRECT_TURN' });

    await Promise.all([aSwarmEntered.promise, aErrEntered.promise, aDirectEntered.promise]);

    // Expire all 3 leases held by Runtime A in SQLite
    storeA.tx(() => {
      storeA.db
        .prepare("UPDATE runtime_jobs SET leaseExpiresAt=? WHERE status='active'")
        .run(Date.now() - 5000);
    });

    // Boot Runtime B -> reclaims all 3 expired jobs!
    runtimeB = new DirectAgentRuntime(storeB, poolB, {
      defaultWorkspace: workDir,
      dataRoot: dir,
      adapter: adapterB,
      leaseMs: 15000,
    });

    // Wait until B is actively running BOTH swarm nodes and has finished the direct turn
    await Promise.all([
      bSwarmEntered.promise,
      bErrEntered.promise,
      waitUntil(() => {
        const t = storeB.db.prepare('SELECT state FROM direct_turns WHERE id=?').get(directOut.turn.id);
        return t?.state === 'completed' ? t : null;
      }),
    ]);

    const bWorktree = storeB.db
      .prepare("SELECT * FROM worktree_leases WHERE runId=? AND status='active' ORDER BY createdAt DESC LIMIT 1")
      .get(runSuccess.runId);
    assert.ok(bWorktree && existsSync(bWorktree.worktreePath), 'Runtime B must have an active worktree');

    // Now unleash ALL stale Runtime A workers while B is STILL running swarm nodes (and after B finished direct turn)!
    aSwarmRelease.resolve();
    aErrRelease.resolve();
    aDirectRelease.resolve();

    // Wait until Runtime A's active job slots drain cleanly (A encountered LEASE_LOST and exited)
    await waitUntil(() => runtimeA.recoveryWorker.active.size === 0, 8000);

    // CRITICAL CHECKS BEFORE B EVEN FINISHES:
    // 1. A's finally block MUST NOT have deleted B's active worktree!
    assert.equal(existsSync(bWorktree.worktreePath), true, 'Stale Runtime A MUST NOT delete Runtime B active worktree');
    // 2. A's late error MUST NOT have marked B's active node/childTurn/childSession as failed!
    const errRunMid = runtimeB.swarmOrchestrator.getRun(runErr.runId);
    assert.equal(errRunMid.nodes[0].status, 'running', 'Stale A error must NOT mark B node failed');
    const errChildSess = storeB.db
      .prepare('SELECT state FROM direct_sessions WHERE id=?')
      .get(errRunMid.nodes[0].childSessionId);
    assert.notEqual(errChildSess?.state, 'failed', 'Stale A error must NOT mark B child session failed');
    // 3. A's late success MUST NOT have corrupted B's active node or settled 999 tokens!
    const succRunMid = runtimeB.swarmOrchestrator.getRun(runSuccess.runId);
    assert.equal(succRunMid.nodes[0].status, 'running', 'Stale A success must NOT prematurely complete B node');
    assert.equal(Number(succRunMid.usage?.inputTokens ?? 0), 0, 'Stale A usage must NOT settle into swarm_runs');

    // Now release B -> B writes from-b.txt, archives artifact, and completes both swarm runs cleanly!
    bSwarmRelease.resolve();
    bErrRelease.resolve();

    const [doneSucc, doneErr] = await Promise.all([
      runtimeB.swarmOrchestrator.waitForRun(runSuccess.runId, { timeoutMs: 10000 }),
      runtimeB.swarmOrchestrator.waitForRun(runErr.runId, { timeoutMs: 10000 }),
    ]);

    assert.equal(doneSucc.status, 'completed');
    assert.equal(doneSucc.nodes[0].resultText, 'AUTHORITATIVE_RESULT_FROM_B');
    assert.equal(doneSucc.usage.inputTokens, 25, 'Swarm usage must reflect ONLY B, never stale A (999)');
    assert.equal(doneSucc.usage.outputTokens, 15);
    const succNotes = runtimeB.childManager.collectNotifications(sess.id, { unreadOnly: false }).filter((n) => n.runId === runSuccess.runId);
    assert.equal(succNotes.length, 1, 'Stale A must NOT persist duplicate/stale child_notification');
    assert.equal(succNotes[0].payload.text, 'AUTHORITATIVE_RESULT_FROM_B');

    assert.equal(doneErr.status, 'completed');
    assert.equal(doneErr.nodes[0].resultText, 'CLEAN_SUCCESS_BY_B');
    const errNotes = runtimeB.childManager.collectNotifications(sess.id, { unreadOnly: false }).filter((n) => n.runId === runErr.runId);
    assert.equal(errNotes.some((n) => n.status === 'failed'), false, 'Stale A late error must NOT persist failed notification');

    // Verify Direct turn & nexus_usage were NOT corrupted by stale A's 888 tokens or late message
    const directTurnFinal = storeB.db.prepare('SELECT * FROM direct_turns WHERE id=?').get(directOut.turn.id);
    assert.equal(directTurnFinal.state, 'completed');
    assert.equal(directTurnFinal.inputTokens, 30);
    assert.equal(directTurnFinal.outputTokens, 12);
    const usageRows = storeB.db
      .prepare('SELECT inputTokens, outputTokens FROM nexus_usage WHERE sessionId=?')
      .all(directSess.id);
    assert.equal(usageRows.length, 1, 'Stale A must NOT insert duplicate nexus_usage');
    assert.equal(usageRows[0].inputTokens, 30);
    const directMsgs = storeB.db
      .prepare("SELECT content FROM direct_messages WHERE turnId=? AND role='assistant'")
      .all(directOut.turn.id);
    assert.equal(directMsgs.some((m) => m.content.includes('STALE_DIRECT_FROM_A')), false);
  } finally {
    aSwarmRelease.resolve();
    aErrRelease.resolve();
    aDirectRelease.resolve();
    bSwarmRelease.resolve();
    bErrRelease.resolve();
    if (runtimeB) await runtimeB.close();
    await runtimeA.close();
    storeB.close();
    storeA.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fix D7: user-cancelled Direct turn and Swarm run stay cancelled across late write-backs and restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-fixd-cancel-'));
  const dbPath = join(dir, 'engine.sqlite');

  const enteredDirect = deferred();
  const releaseDirect = deferred();
  const enteredSwarm = deferred();
  const releaseSwarm = deferred();

  const adapter = new ScriptedAdapter(async function* (opts) {
    const userText = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    if (userText.includes('CANCEL_ME_DIRECT')) {
      enteredDirect.resolve();
      await releaseDirect.promise;
      yield { type: 'text-delta', index: 0, text: 'ZOMBIE_DIRECT' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (userText.includes('CANCEL_ME_SWARM')) {
      enteredSwarm.resolve();
      await releaseSwarm.promise;
      yield { type: 'text-delta', index: 0, text: 'ZOMBIE_SWARM' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'ok' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  let store = new Store(dbPath);
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-cancel');
  let runtime = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter,
  });

  try {
    const sDirect = runtime.createSession({ workspaceRoot: dir });
    const tOut = runtime.startTurn(sDirect.id, { input: 'CANCEL_ME_DIRECT' });

    const sSwarm = runtime.createSession({ workspaceRoot: dir });
    const swOut = runtime.swarmOrchestrator.submitRun({
      sessionId: sSwarm.id,
      goal: 'Cancel safety',
      workspaceRoot: dir,
      nodes: [{ nodeKey: 'n1', taskType: 'research', objective: 'CANCEL_ME_SWARM', dependencies: [] }],
    });

    await Promise.all([enteredDirect.promise, enteredSwarm.promise]);

    runtime.cancelTurn(tOut.turn.id);
    runtime.swarmOrchestrator.cancelRun(swOut.runId);

    // Let aborted workers finish unwinding
    releaseDirect.resolve();
    releaseSwarm.resolve();
    await waitUntil(() => runtime.recoveryWorker.active.size === 0, 8000);

    // Reboot fresh runtime on same DB
    await runtime.close();
    store.close();

    store = new Store(dbPath);
    const pool2 = new AccountPool(store, { root: dir });
    pool2.setDefaultModel('mock-cancel');
    const postAdapter = new ScriptedAdapter(async function* () {
      yield { type: 'text-delta', index: 0, text: 'SHOULD_NEVER_RUN' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    runtime = new DirectAgentRuntime(store, pool2, {
      defaultWorkspace: dir,
      dataRoot: dir,
      adapter: postAdapter,
    });

    assert.equal(store.db.prepare('SELECT state FROM direct_turns WHERE id=?').get(tOut.turn.id).state, 'cancelled');
    assert.equal(store.db.prepare('SELECT state FROM direct_sessions WHERE id=?').get(sDirect.id).state, 'cancelled');
    assert.equal(runtime.swarmOrchestrator.getRun(swOut.runId).status, 'cancelled');
    assert.equal(runtime.swarmOrchestrator.getRun(swOut.runId).nodes[0].status, 'cancelled');
    assert.equal(postAdapter.calls.length, 0);
  } finally {
    releaseDirect.resolve();
    releaseSwarm.resolve();
    await runtime.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fix D8: unresolved outcome_unknown non-replayable side effect enters reconciliation instead of auto-replay, while live owner tool is not falsely flagged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-fixd-reconcile-'));
  const dbPath = join(dir, 'engine.sqlite');

  let store = new Store(dbPath);
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-d8');
  let replayed = 0;

  const adapter = new ScriptedAdapter(async function* () {
    replayed++;
    yield { type: 'text-delta', index: 0, text: 'REPLAYED_UNSAFELY' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  let runtime = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter,
  });

  try {
    const sess = runtime.createSession({ workspaceRoot: dir, model: 'mock-d8' });
    const now = Date.now();
    // Pre-existing outcome_unknown receipt (e.g. aborted mid-flight before crash) with pending/expired job
    store.tx(() => {
      store.db.prepare("UPDATE direct_sessions SET state='running' WHERE id=?").run(sess.id);
      store.db
        .prepare(
          "INSERT INTO direct_turns(id, sessionId, input, model, state, jobId, phase, step, createdAt) VALUES('t-unk-1',?,'deploy','mock-d8','running','j-unk-1','tools',1,?)",
        )
        .run(sess.id, now);
      store.db
        .prepare(
          "INSERT INTO runtime_jobs(id, kind, sessionId, turnId, payload, status, leaseExpiresAt, createdAt, updatedAt) VALUES('j-unk-1','direct_turn',?,'t-unk-1',?,'active',?,?,?)",
        )
        .run(sess.id, JSON.stringify({ sessionId: sess.id, turnId: 't-unk-1', input: 'deploy', model: 'mock-d8' }), now - 5000, now, now);
      store.db
        .prepare(
          `INSERT INTO tool_receipts(
            id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
            replayable, outward, argsDigest, status, createdAt, updatedAt
          ) VALUES('rcpt-unk-1',?,'t-unk-1','tc-unk','bash','high','irreversible_side_effect',0,0,'abc','outcome_unknown',?,?)`,
        )
        .run(sess.id, now, now);
    });

    await runtime.close();
    store.close();

    store = new Store(dbPath);
    const pool2 = new AccountPool(store, { root: dir });
    pool2.setDefaultModel('mock-d8');
    runtime = new DirectAgentRuntime(store, pool2, {
      defaultWorkspace: dir,
      dataRoot: dir,
      adapter,
    });

    assert.equal(runtime.lastRecoveryReport.reconciliationRequired.length, 1, 'outcome_unknown receipt MUST park turn in reconciliation');
    assert.equal(store.db.prepare("SELECT state FROM direct_turns WHERE id='t-unk-1'").get().state, 'reconciling');
    assert.equal(replayed, 0, 'Non-replayable outcome_unknown turn MUST NOT auto-replay');
  } finally {
    await runtime.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fix D8/D9: live worker executing non-replayable receipt is NOT falsely flagged by Runtime B, and repeated dead-owner recovery is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-fixd-idem-'));
  const dbPath = join(dir, 'engine.sqlite');

  const storeA = new Store(dbPath);
  const storeB = new Store(dbPath);
  const poolA = new AccountPool(storeA, { root: dir });
  const poolB = new AccountPool(storeB, { root: dir });
  poolA.setDefaultModel('mock-idem');
  poolB.setDefaultModel('mock-idem');

  const adapter = new ScriptedAdapter(async function* () {
    yield { type: 'text-delta', index: 0, text: 'recovered-once' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const runtimeA = new DirectAgentRuntime(storeA, poolA, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter,
  });

  let runtimeB = null;
  try {
    const sess = runtimeA.createSession({ workspaceRoot: dir, model: 'mock-idem' });
    const now = Date.now();
    // Simulate a LIVE worker A executing a non-replayable tool with a valid active lease
    storeA.tx(() => {
      storeA.db.prepare("UPDATE direct_sessions SET state='running' WHERE id=?").run(sess.id);
      storeA.db
        .prepare(
          "INSERT INTO direct_turns(id, sessionId, input, model, state, jobId, phase, step, createdAt) VALUES('t-live-tool',?,'run cmd','mock-idem','running','j-live-tool','tools',1,?)",
        )
        .run(sess.id, now);
      storeA.db
        .prepare(
          "INSERT INTO runtime_jobs(id, kind, sessionId, turnId, payload, status, fence, workerId, leaseExpiresAt, createdAt, updatedAt) VALUES('j-live-tool','direct_turn',?,'t-live-tool',?,'active','live-fence-A',?,?,?,?)",
        )
        .run(
          sess.id,
          JSON.stringify({ sessionId: sess.id, turnId: 't-live-tool', input: 'run cmd', model: 'mock-idem' }),
          runtimeA.recoveryWorker.workerId,
          now + 30_000,
          now,
          now,
        );
      storeA.db
        .prepare(
          `INSERT INTO tool_receipts(
            id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
            replayable, outward, argsDigest, status, createdAt, updatedAt
          ) VALUES('rcpt-live-1',?,'t-live-tool','tc-live','bash','high','irreversible_side_effect',0,0,'abc','executing',?,?)`,
        )
        .run(sess.id, now, now);
    });

    // Also simulate a dead-owner stranded swarm run whose recovery will be called 3x
    const sessDead = runtimeA.createSession({ workspaceRoot: dir, model: 'mock-idem' });
    const deadRunId = 'run-dead-idem';
    storeA.tx(() => {
      storeA.db
        .prepare(
          `INSERT INTO swarm_runs(
            id, sessionId, goal, status, strategyJson, budgetJson, usageJson, workspaceRoot, permissionMode, createdAt, updatedAt
          ) VALUES(?,?,?,'running','{"maxConcurrency":2}','{}','{}',?,'auto-safe',?,?)`,
        )
        .run(deadRunId, sessDead.id, 'Idempotent recovery run', dir, now, now);
      storeA.db
        .prepare(
          `INSERT INTO swarm_nodes(
            id, runId, nodeKey, agentProfileId, model, provider, objective, acceptance,
            dependenciesJson, toolAllowJson, permissionMode, taskType, isolationMode,
            planVersion, status, priority, budgetJson, createdAt, updatedAt
          ) VALUES('node-dead-1',?,'n1','research','mock-idem','pool','do work','ok','[]','["read_file"]','auto-safe','research','shared_readonly',1,'running',0,'{}',?,?)`,
        )
        .run(deadRunId, now, now);
      storeA.db
        .prepare(
          "INSERT INTO runtime_jobs(id, kind, sessionId, turnId, taskId, payload, status, fence, workerId, leaseExpiresAt, createdAt, updatedAt) VALUES('j-dead-swarm', 'swarm_node_execute', ?, 'swarm:run-dead-idem:n1', ?, ?, 'active', 'dead-fence', 'dead-worker', ?, ?, ?)",
        )
        .run(
          sessDead.id,
          deadRunId,
          JSON.stringify({ runId: deadRunId, nodeId: 'node-dead-1', nodeKey: 'n1', sessionId: sessDead.id, planVersion: 1, attemptSeq: 1 }),
          now - 10_000,
          now,
          now,
        );
    });

    // Boot Runtime B WITHOUT starting auto-claiming on deadRunId first? Let's stop worker tick or inspect immediately
    runtimeB = new DirectAgentRuntime(storeB, poolB, {
      defaultWorkspace: dir,
      dataRoot: dir,
      adapter,
    });

    // Live worker's executing receipt MUST STILL be 'executing' (NOT hijacked to 'outcome_unknown'!)
    const liveReceipt = storeB.db.prepare("SELECT status FROM tool_receipts WHERE id='rcpt-live-1'").get();
    assert.equal(liveReceipt.status, 'executing', 'Runtime B must NOT mark live worker executing tool as outcome_unknown');
    const liveTurn = storeB.db.prepare("SELECT state FROM direct_turns WHERE id='t-live-tool'").get();
    assert.equal(liveTurn.state, 'running');

    // Call recovery repeatedly on Runtime B -> must NOT cancel pending jobs or create duplicates
    await runtimeB.recoveryWorker.stop();
    const jobsBeforeRepeat = storeB.db
      .prepare('SELECT COUNT(*) AS n FROM runtime_jobs WHERE taskId=?')
      .get(deadRunId).n;
    runtimeB.swarmOrchestrator.recoverInterruptedRuns();
    runtimeB.swarmOrchestrator.recoverInterruptedRuns();
    const jobsAfterRepeat = storeB.db
      .prepare('SELECT COUNT(*) AS n FROM runtime_jobs WHERE taskId=?')
      .get(deadRunId).n;
    assert.equal(jobsAfterRepeat, jobsBeforeRepeat, 'Repeated recovery must be strictly idempotent (no duplicate jobs)');
  } finally {
    if (runtimeB) await runtimeB.close();
    await runtimeA.close();
    storeB.close();
    storeA.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
