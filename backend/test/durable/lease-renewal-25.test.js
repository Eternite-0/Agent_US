import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

import { Store } from '../../src/store.js';
import { AccountPool } from '../../src/pool.js';
import { DirectAgentRuntime } from '../../src/direct-agent.js';
import { DurableJobQueue } from '../../src/durable/job-queue.js';
import {
  createLeaseGuard,
  registerWorker,
  renewTurnLease,
} from '../../src/durable/lease-guard.js';

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

async function waitUntil(fn, timeoutMs = 15000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

test('renewTurnLease extends runtime_jobs.leaseExpiresAt & runtime_workers.heartbeatAt atomically and rejects fenced/terminal turns', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());

  const queue = new DurableJobQueue(store, { defaultLeaseMs: 1000 });
  const now = Date.now();
  registerWorker(store, { workerId: 'worker-a', pid: process.pid, hostname: 'localhost' });
  store.db
    .prepare('UPDATE runtime_workers SET heartbeatAt=? WHERE workerId=?')
    .run(now - 5000, 'worker-a');
  store.db
    .prepare(
      `INSERT INTO direct_sessions(id, title, model, mode, permissionMode, state, createdAt, updatedAt)
       VALUES(?,?,?,?,?,?,?,?)`,
    )
    .run('sess-1', 'lease', 'm', 'direct', 'auto-safe', 'active', now, now);
  store.db
    .prepare(
      `INSERT INTO direct_turns(id, sessionId, input, state, phase, step, activeFence, activeAttempt, createdAt)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run('turn-1', 'sess-1', 'test input', 'running', 'inference', 1, null, 1, now);

  const job = queue.enqueue({
    kind: 'turn',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    payload: { sessionId: 'sess-1', turnId: 'turn-1' },
  });
  const claimed = queue.claim({ workerId: 'worker-a', leaseMs: 1000 });
  assert.ok(claimed);
  assert.equal(claimed.id, job.id);

  const guard = createLeaseGuard({
    store,
    workerId: 'worker-a',
    jobId: claimed.id,
    fence: claimed.fence,
  });

  const beforeJob = store.db.prepare('SELECT leaseExpiresAt FROM runtime_jobs WHERE id=?').get(claimed.id);
  const beforeWorker = store.db
    .prepare('SELECT heartbeatAt FROM runtime_workers WHERE workerId=?')
    .get('worker-a');

  const res = renewTurnLease(guard, {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    owner: 'worker-a',
    extendMs: 4000,
    nowMs: now + 500,
  });
  assert.equal(res.ok, true);
  assert.equal(res.extended, true);
  assert.equal(res.leaseExpiresAt, now + 4500);
  assert.equal(res.heartbeatAt, now + 500);

  const afterJob = store.db.prepare('SELECT leaseExpiresAt FROM runtime_jobs WHERE id=?').get(claimed.id);
  const afterWorker = store.db
    .prepare('SELECT heartbeatAt FROM runtime_workers WHERE workerId=?')
    .get('worker-a');
  assert.ok(afterJob.leaseExpiresAt > beforeJob.leaseExpiresAt);
  assert.ok(afterWorker.heartbeatAt > beforeWorker.heartbeatAt);

  // Wrong owner fails
  const wrongOwner = renewTurnLease(guard, {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    owner: 'worker-b',
    extendMs: 4000,
  });
  assert.equal(wrongOwner.ok, false);
  assert.equal(wrongOwner.reason, 'owner_mismatch');

  // Terminal turn skips cleanly without modifying job
  store.db.prepare("UPDATE direct_turns SET state='completed' WHERE id='turn-1'").run();
  const termRes = renewTurnLease(guard, {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    owner: 'worker-a',
    extendMs: 4000,
  });
  assert.equal(termRes.ok, false);
  assert.equal(termRes.reason, 'turn_terminal');
});

test('DirectAgentRuntime renews turn lease periodically during slow SSE stream so peer worker cannot steal turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lease-renew-25-'));
  const workDir = join(dir, 'repo');
  const dbPath = join(dir, 'engine.sqlite');
  mkdirSync(workDir, { recursive: true });

  const storeA = new Store(dbPath);
  const poolA = new AccountPool(storeA, { root: dir });
  poolA.createAccount({
    preset: 'deepseek',
    apiKey: 'sk-test-placeholder-1234567890',
    models: ['slow-stream-model'],
  });
  poolA.setDefaultModel('slow-stream-model');

  let releaseStream;
  const streamReady = new Promise((resolve) => {
    releaseStream = resolve;
  });
  let streamEnteredResolve;
  const streamEntered = new Promise((resolve) => {
    streamEnteredResolve = resolve;
  });
  let runtimeAExecs = 0;

  const adapterA = new ScriptedAdapter(async function* () {
    runtimeAExecs += 1;
    streamEnteredResolve();
    await streamReady;
    yield { type: 'text-delta', index: 0, text: 'Slow stream finished cleanly.' };
    yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const runtimeA = new DirectAgentRuntime(storeA, poolA, {
    adapter: adapterA,
    defaultWorkspace: workDir,
    dataRoot: dir,
    workerId: 'worker-slow-a',
    leaseMs: 700,
    leaseRenewalIntervalMs: 120,
  });

  let runtimeBExecs = 0;
  const storeB = new Store(dbPath);
  const poolB = new AccountPool(storeB, { root: dir });
  const adapterB = new ScriptedAdapter(async function* () {
    runtimeBExecs += 1;
    yield { type: 'text-delta', index: 0, text: 'stolen' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const runtimeB = new DirectAgentRuntime(storeB, poolB, {
    adapter: adapterB,
    defaultWorkspace: workDir,
    dataRoot: dir,
    workerId: 'worker-peer-b',
    leaseMs: 700,
    enableHeartbeat: false,
  });

  try {
    const session = runtimeA.createSession({ model: 'slow-stream-model', workspaceRoot: workDir });
    const { turn } = runtimeA.startTurn(session.id, { input: 'Long streaming task' });

    await streamEntered;
    const jobInitial = storeA.db
      .prepare('SELECT id, leaseExpiresAt, workerId FROM runtime_jobs WHERE turnId=?')
      .get(turn.id);
    const workerInitial = storeA.db
      .prepare('SELECT heartbeatAt FROM runtime_workers WHERE workerId=?')
      .get(jobInitial.workerId);

    // Hold SSE stream active beyond initial 700ms lease window while periodic renewal keeps extending lease
    await new Promise((r) => setTimeout(r, 950));
    runtimeB.recoveryWorker.recoverOnStartup();
    await runtimeB.recoveryWorker.tick();

    const jobRenewed = storeA.db
      .prepare('SELECT leaseExpiresAt, workerId FROM runtime_jobs WHERE id=?')
      .get(jobInitial.id);
    const workerRenewed = storeA.db
      .prepare('SELECT heartbeatAt FROM runtime_workers WHERE workerId=?')
      .get(jobInitial.workerId);

    assert.equal(jobRenewed.workerId, 'worker-slow-a', 'peer runtime must not steal actively renewed lease');
    assert.ok(
      jobRenewed.leaseExpiresAt > jobInitial.leaseExpiresAt,
      'periodic streaming renewal must advance runtime_jobs.leaseExpiresAt',
    );
    assert.ok(
      workerRenewed.heartbeatAt > workerInitial.heartbeatAt,
      'periodic streaming renewal must advance runtime_workers.heartbeatAt',
    );
    assert.equal(runtimeBExecs, 0);

    releaseStream();
    const doneRow = await waitUntil(() =>
      storeA.db.prepare("SELECT * FROM direct_turns WHERE id=? AND state='completed'").get(turn.id),
    );
    assert.equal(doneRow.state, 'completed');
    assert.equal(runtimeAExecs, 1);
    assert.equal(runtimeBExecs, 0);
  } finally {
    releaseStream?.();
    await runtimeB.close().catch(() => {});
    await runtimeA.close().catch(() => {});
    if (storeB?.db?.isOpen) storeB.close();
    if (storeA?.db?.isOpen) storeA.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
