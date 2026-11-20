import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Store, id as uuid } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { ControlPlane } from '../src/governance/control-plane.js';
import { ScheduledTaskRunner } from '../src/governance/scheduler.js';
import { computeNextRunAt, validateScheduleConfig } from '../src/governance/cron.js';
import { api } from '../src/api.js';

async function pollUntil(fn, timeoutMs = 8000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await delay(stepMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

class TrackingAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
  }
  async *stream(options) {
    const msgs = options.messages ?? [];
    const lastUser = msgs.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const out = await this.handler({ lastUser, options });
    yield { type: 'text-delta', index: 0, text: out ?? 'OK' };
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

function makeSimpleAdapter(delayMs = 20) {
  return new TrackingAdapter(async () => {
    if (delayMs > 0) await delay(delayMs);
    return 'OK';
  });
}

function cleanupDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 40 });
  } catch {
    // ignore transient Windows handle cleanup
  }
}

test('Part 1.1 & 1.2: atomic occurrence+job creation and queued/jobId=null repair on retry and startup recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-sched-p12-'));
  const dbPath = join(dir, 'engine.sqlite');
  const store = new Store(dbPath);
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-sched');
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: makeSimpleAdapter(15),
  });
  const scheduler = new ScheduledTaskRunner({ store, directAgent: direct });

  try {
    const sched = scheduler.create({
      name: 'repair-test',
      prompt: 'run repair check',
      scheduleKind: 'daily',
      scheduleExpr: '09:00',
      timezone: 'UTC',
      concurrencyPolicy: 'allow',
    });

    // 1) Normal enqueue links jobId immediately
    const slotNormal = Date.now() - 10_000;
    const normalRun = scheduler.enqueueScheduledRun(sched, slotNormal, { trigger: 'schedule' });
    assert.ok(normalRun.jobId, 'normal enqueue must atomically link jobId');
    const linkedJob = store.db.prepare('SELECT * FROM runtime_jobs WHERE id=?').get(normalRun.jobId);
    assert.ok(linkedJob, 'linked runtime_jobs row must exist');
    assert.equal(linkedJob.kind, 'scheduled_task');

    // 2) Broken queued occurrence with jobId=NULL repaired on retry enqueueScheduledRun
    const slotRetry = Date.now() - 20_000;
    const brokenRetryId = uuid();
    const brokenRetryIdem = `sched:${sched.id}:${slotRetry}`;
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO scheduled_task_runs(
            id, scheduleId, scheduledFor, idempotencyKey, jobId, status, createdAt
          ) VALUES(?,?,?,?,NULL,'queued',?)`,
        )
        .run(brokenRetryId, sched.id, slotRetry, brokenRetryIdem, Date.now() - 5000);
    });

    const repairedOnRetry = scheduler.enqueueScheduledRun(sched, slotRetry, { trigger: 'retry' });
    assert.equal(repairedOnRetry.id, brokenRetryId);
    assert.ok(repairedOnRetry.jobId, 'retry enqueueScheduledRun must repair queued run with jobId=NULL');

    await pollUntil(() => {
      const r = store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(brokenRetryId);
      return r?.status === 'completed' ? r : null;
    });

    // 3) Broken queued occurrence with jobId=NULL repaired automatically on startup recovery
    const slotBoot = Date.now() - 30_000;
    const brokenBootId = uuid();
    const brokenBootIdem = `sched:${sched.id}:${slotBoot}`;
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO scheduled_task_runs(
            id, scheduleId, scheduledFor, idempotencyKey, jobId, status, createdAt
          ) VALUES(?,?,?,?,NULL,'queued',?)`,
        )
        .run(brokenBootId, sched.id, slotBoot, brokenBootIdem, Date.now() - 4000);
    });

    scheduler.start();
    const completedBoot = await pollUntil(() => {
      const r = store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(brokenBootId);
      return r?.status === 'completed' ? r : null;
    });
    assert.ok(completedBoot.jobId, 'startup recovery must repair jobId');
    assert.ok(completedBoot.sessionId && completedBoot.turnId, 'startup recovery must execute repaired run');
  } finally {
    scheduler.stop();
    await direct.close();
    store.close();
    cleanupDir(dir);
  }
});

test('Part 1.3: deterministic turn correlation re-attaches existing turn without launching a duplicate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-sched-p13-'));
  const dbPath = join(dir, 'engine.sqlite');
  const store = new Store(dbPath);
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-sched');
  let adapterCalls = 0;
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: new TrackingAdapter(async () => {
      adapterCalls++;
      await delay(20);
      return 'REATTACHED_OK';
    }),
  });
  const scheduler = new ScheduledTaskRunner({ store, directAgent: direct });

  try {
    const sched = scheduler.create({
      name: 'reattach-test',
      prompt: 'do deterministic work',
      scheduleKind: 'daily',
      scheduleExpr: '10:00',
      timezone: 'UTC',
    });

    const slot = Date.now() - 5000;
    const idem = `sched:${sched.id}:${slot}`;
    const runId = uuid();

    // Simulate a turn that already started (and even completed) using deterministic clientTurnId = idem,
    // while scheduled_task_runs crashed BEFORE persisting sessionId and turnId.
    const existingSess = direct.createSession({
      title: `[定时] ${sched.name}`,
      model: 'mock-sched',
      workspaceRoot: dir,
    });
    const { turn: existingTurn } = direct.startTurn(existingSess.id, {
      input: sched.prompt,
      clientTurnId: idem,
      model: 'mock-sched',
    });

    await pollUntil(() => {
      const t = store.db.prepare('SELECT state FROM direct_turns WHERE id=?').get(existingTurn.id);
      return t?.state === 'completed';
    });
    assert.equal(adapterCalls, 1, 'initial turn ran once');

    // Insert scheduled_task_runs with NULL sessionId/turnId and a pending scheduled_task job
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO scheduled_task_runs(
            id, scheduleId, scheduledFor, idempotencyKey, jobId, sessionId, turnId, status, createdAt
          ) VALUES(?,?,?,?,NULL,NULL,NULL,'queued',?)`,
        )
        .run(runId, sched.id, slot, idem, Date.now());
    });

    scheduler.start();

    const attached = await pollUntil(() => {
      const r = store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(runId);
      return r?.status === 'completed' ? r : null;
    });

    assert.equal(attached.sessionId, existingSess.id, 'must re-attach existing sessionId');
    assert.equal(attached.turnId, existingTurn.id, 'must re-attach existing turnId');
    assert.equal(adapterCalls, 1, 'must NOT start a duplicate turn when deterministic turn already exists');
    const turnsForIdem = store.db
      .prepare('SELECT COUNT(*) AS n FROM direct_turns WHERE clientTurnId=?')
      .get(idem).n;
    assert.equal(turnsForIdem, 1, 'must have exactly 1 direct_turns row for idempotencyKey');

    // Also test deterministic re-attach when the pre-existing turn is STILL RUNNING
    const runningSlot = Date.now() - 2500;
    const runningIdem = `sched:${sched.id}:${runningSlot}`;
    const runningRunId = uuid();
    let releaseSlowTurn;
    const slowGate = new Promise((r) => {
      releaseSlowTurn = r;
    });
    const prevHandler = direct.adapter.handler;
    direct.adapter.handler = async () => {
      adapterCalls++;
      await slowGate;
      return 'SLOW_REATTACH_OK';
    };

    const sess2 = direct.createSession({
      title: `[定时] ${sched.name}`,
      model: 'mock-sched',
      workspaceRoot: dir,
    });
    const { turn: runningTurn } = direct.startTurn(sess2.id, {
      input: sched.prompt,
      clientTurnId: runningIdem,
      model: 'mock-sched',
    });
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO scheduled_task_runs(
            id, scheduleId, scheduledFor, idempotencyKey, jobId, sessionId, turnId, status, createdAt
          ) VALUES(?,?,?,?,NULL,NULL,NULL,'queued',?)`,
        )
        .run(runningRunId, sched.id, runningSlot, runningIdem, Date.now());
    });

    scheduler.reconcileRuns();
    const attachedRunning = store.db
      .prepare('SELECT * FROM scheduled_task_runs WHERE id=?')
      .get(runningRunId);
    assert.equal(attachedRunning.status, 'running');
    assert.equal(attachedRunning.sessionId, sess2.id);
    assert.equal(attachedRunning.turnId, runningTurn.id);

    releaseSlowTurn();
    await pollUntil(() => {
      const r = store.db.prepare('SELECT status FROM scheduled_task_runs WHERE id=?').get(runningRunId);
      return r?.status === 'completed';
    });
    assert.equal(adapterCalls, 2, 're-attaching a still-running turn must not start a duplicate');
    direct.adapter.handler = prevHandler;
  } finally {
    scheduler.stop();
    await direct.close();
    store.close();
    cleanupDir(dir);
  }
});

test('Part 1.4, 1.5, 1.6: startup reconciliation converges completed/failed/cancelled turns from DB facts and updates scheduled_tasks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-sched-p14-'));
  const dbPath = join(dir, 'engine.sqlite');
  const store = new Store(dbPath);
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-sched');
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: makeSimpleAdapter(10),
  });
  const scheduler = new ScheduledTaskRunner({ store, directAgent: direct });

  try {
    const now = Date.now();
    const cases = [
      { name: 'sched-done', turnState: 'completed', turnErr: null, expected: 'completed' },
      { name: 'sched-fail', turnState: 'failed', turnErr: 'upstream-500-boom', expected: 'failed' },
      { name: 'sched-cancel', turnState: 'cancelled', turnErr: null, expected: 'cancelled' },
    ];

    const records = [];
    for (const c of cases) {
      const s = scheduler.create({
        name: c.name,
        prompt: `prompt for ${c.name}`,
        scheduleKind: 'daily',
        scheduleExpr: '12:00',
        timezone: 'UTC',
      });
      const sess = direct.createSession({ title: c.name, model: 'mock-sched', workspaceRoot: dir });
      const turnId = uuid();
      const runId = uuid();
      store.tx(() => {
        store.db
          .prepare(
            `INSERT INTO direct_turns(
              id, sessionId, clientTurnId, input, model, state, error, createdAt, finishedAt
            ) VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(turnId, sess.id, `sched:${s.id}:${now}`, s.prompt, 'mock-sched', c.turnState, c.turnErr, now - 1000, now);
        store.db
          .prepare(
            `INSERT INTO scheduled_task_runs(
              id, scheduleId, scheduledFor, idempotencyKey, sessionId, turnId, status, startedAt, createdAt
            ) VALUES(?,?,?,?,?,?,'running',?,?)`,
          )
          .run(runId, s.id, now, `sched:${s.id}:${now}`, sess.id, turnId, now - 1000, now - 1000);
        store.db
          .prepare("UPDATE scheduled_tasks SET lastStatus='running', lastSessionId=? WHERE id=?")
          .run(sess.id, s.id);
      });
      records.push({ ...c, scheduleId: s.id, runId, turnId });
    }

    // Startup reconciliation must converge all 3 WITHOUT any in-process events!
    scheduler.start();

    for (const rec of records) {
      const runRow = store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(rec.runId);
      const taskRow = scheduler.get(rec.scheduleId);
      assert.equal(runRow.status, rec.expected, `${rec.name}: run status must converge to ${rec.expected}`);
      assert.ok(runRow.finishedAt, `${rec.name}: finishedAt must be populated`);
      if (rec.turnErr) {
        assert.match(String(runRow.error ?? ''), /upstream-500-boom/);
      }
      assert.equal(taskRow.lastStatus, rec.expected, `${rec.name}: scheduled_tasks.lastStatus must converge to ${rec.expected}`);
    }

    // Live cancelRun must also update BOTH scheduled_task_runs AND scheduled_tasks.lastStatus
    const cancelSched = scheduler.create({
      name: 'sched-live-cancel',
      prompt: 'cancel me',
      scheduleKind: 'daily',
      scheduleExpr: '13:00',
      timezone: 'UTC',
    });
    const qRunId = uuid();
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO scheduled_task_runs(
            id, scheduleId, scheduledFor, idempotencyKey, status, createdAt
          ) VALUES(?,?,?,?,'queued',?)`,
        )
        .run(qRunId, cancelSched.id, now + 5000, `sched:${cancelSched.id}:${now + 5000}`, now);
    });
    const cancelled = scheduler.cancelRun(cancelSched.id, qRunId);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(
      scheduler.get(cancelSched.id).lastStatus,
      'cancelled',
      'cancelRun must update scheduled_tasks.lastStatus to cancelled',
    );

    // Direct cancelTurn(turnId) (bypassing scheduler.cancelRun) must converge BOTH scheduled_task_runs & scheduled_tasks AND advance queued runs!
    const directCancelSched = scheduler.create({
      name: 'sched-direct-cancel-turn',
      prompt: 'cancel via directAgent',
      scheduleKind: 'daily',
      scheduleExpr: '14:00',
      timezone: 'UTC',
      concurrencyPolicy: 'queue',
      maxConcurrency: 1,
    });
    let releaseFirst;
    const firstStarted = new Promise((res) => {
      let call = 0;
      direct.adapter.handler = async () => {
        call++;
        if (call === 1) {
          res();
          await new Promise((r) => {
            releaseFirst = r;
          });
          return 'CANCELLED_BEFORE_FINISH';
        }
        await delay(15);
        return 'SECOND_ADVANCED_OK';
      };
    });
    const dcRun1 = scheduler.enqueueScheduledRun(directCancelSched, now + 6001);
    const dcRun2 = scheduler.enqueueScheduledRun(directCancelSched, now + 6002);
    await firstStarted;
    const dcRun1Row = store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(dcRun1.id);
    assert.ok(dcRun1Row.turnId, 'first queued run must have started with turnId');
    direct.cancelTurn(dcRun1Row.turnId);
    releaseFirst?.();
    const afterCancel1 = store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(dcRun1.id);
    assert.equal(afterCancel1.status, 'cancelled', 'direct cancelTurn must converge scheduled_task_runs');
    // And dcRun2 must automatically advance and complete!
    await pollUntil(() => {
      const r2 = store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(dcRun2.id);
      return r2?.status === 'completed';
    });
    assert.equal(scheduler.get(directCancelSched.id).lastStatus, 'completed');

    // Queued runs whose durable job reached failed/cancelled converge on startup reconciliation
    const jobTermSched = scheduler.create({
      name: 'sched-job-terminal',
      prompt: 'job terminal check',
      scheduleKind: 'daily',
      scheduleExpr: '15:00',
      timezone: 'UTC',
    });
    const failedJobId = uuid();
    const failedRunId = uuid();
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO runtime_jobs(
            id, kind, taskId, payload, status, attempts, maxAttempts, idempotencyKey, errorCode, errorMessage, createdAt, updatedAt
          ) VALUES(?,'scheduled_task',?,?,'failed',3,3,?,'ATTEMPTS_EXHAUSTED','Max attempts exhausted',?,?)`,
        )
        .run(failedJobId, jobTermSched.id, '{}', `sched:${jobTermSched.id}:${now + 7001}`, now, now);
      store.db
        .prepare(
          `INSERT INTO scheduled_task_runs(
            id, scheduleId, scheduledFor, idempotencyKey, jobId, status, createdAt
          ) VALUES(?,?,?,?,?,'queued',?)`,
        )
        .run(failedRunId, jobTermSched.id, now + 7001, `sched:${jobTermSched.id}:${now + 7001}`, failedJobId, now);
    });
    scheduler.reconcileRuns();
    assert.equal(
      store.db.prepare('SELECT status FROM scheduled_task_runs WHERE id=?').get(failedRunId).status,
      'failed',
    );
    assert.equal(scheduler.get(jobTermSched.id).lastStatus, 'failed');
  } finally {
    scheduler.stop();
    await direct.close();
    store.close();
    cleanupDir(dir);
  }
});

test('Part 1.7: scheduled_tasks.lastStatus updates monotonically so a late older run cannot overwrite a newer run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-sched-p17-'));
  const dbPath = join(dir, 'engine.sqlite');
  const store = new Store(dbPath);
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-sched');

  let invocation = 0;
  let r1EnteredResolve;
  let releaseR1;
  const r1Entered = new Promise((r) => {
    r1EnteredResolve = r;
  });
  const r1Gate = new Promise((r) => {
    releaseR1 = r;
  });
  let s1EnteredResolve;
  let releaseS1;
  const s1Entered = new Promise((r) => {
    s1EnteredResolve = r;
  });
  const s1Gate = new Promise((r) => {
    releaseS1 = r;
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: new TrackingAdapter(async () => {
      const idx = ++invocation;
      if (idx === 1) {
        // Older run finishes LATE (deterministically gated until newer run settles) and FAILS
        r1EnteredResolve();
        await r1Gate;
        throw new Error('older-run-late-failure');
      }
      // Newer run finishes FAST and SUCCEEDS
      return 'NEWER_OK';
    }),
  });
  const scheduler = new ScheduledTaskRunner({ store, directAgent: direct });

  try {
    scheduler.start();
    const sched = scheduler.create({
      name: 'monotonic-status',
      prompt: 'test monotonic status',
      scheduleKind: 'daily',
      scheduleExpr: '09:00',
      timezone: 'UTC',
      concurrencyPolicy: 'allow',
    });

    const r1 = await scheduler.runNow(sched.id, { trigger: 'manual-1' });
    await r1Entered;
    const r2 = await scheduler.runNow(sched.id, { trigger: 'manual-2' });

    // Wait for newer run r2 to complete FIRST, then unleash older run r1 to fail late
    await pollUntil(() => {
      const row2 = store.db.prepare('SELECT status FROM scheduled_task_runs WHERE id=?').get(r2.run.id);
      return row2?.status === 'completed';
    });
    releaseR1();
    await pollUntil(() => {
      const row1 = store.db.prepare('SELECT status FROM scheduled_task_runs WHERE id=?').get(r1.run.id);
      return row1?.status === 'failed';
    });

    const finalTask = scheduler.get(sched.id);
    assert.equal(
      finalTask.lastStatus,
      'completed',
      'older run late failure must NOT overwrite newer run completed status',
    );

    // Symmetric check: older run finishes LATE and SUCCEEDS after newer run fails fast -> lastStatus stays 'failed'
    invocation = 0;
    direct.adapter.handler = async () => {
      const idx = ++invocation;
      if (idx === 1) {
        s1EnteredResolve();
        await s1Gate;
        return 'OLDER_LATE_SUCCESS';
      }
      throw new Error('newer-run-fast-failure');
    };
    const sched2 = scheduler.create({
      name: 'monotonic-status-sym',
      prompt: 'test symmetric monotonic status',
      scheduleKind: 'daily',
      scheduleExpr: '09:00',
      timezone: 'UTC',
      concurrencyPolicy: 'allow',
    });
    const s1 = await scheduler.runNow(sched2.id, { trigger: 'manual-sym-1' });
    await s1Entered;
    const s2 = await scheduler.runNow(sched2.id, { trigger: 'manual-sym-2' });
    await pollUntil(() => {
      const row2 = store.db.prepare('SELECT status FROM scheduled_task_runs WHERE id=?').get(s2.run.id);
      return row2?.status === 'failed';
    });
    releaseS1();
    await pollUntil(() => {
      const row1 = store.db.prepare('SELECT status FROM scheduled_task_runs WHERE id=?').get(s1.run.id);
      return row1?.status === 'completed';
    });
    assert.equal(
      scheduler.get(sched2.id).lastStatus,
      'failed',
      'older run late completion must NOT overwrite newer run failed status',
    );
  } finally {
    releaseR1?.();
    releaseS1?.();
    scheduler.stop();
    await direct.close();
    store.close();
    cleanupDir(dir);
  }
});

test('Part 2.1 & 2.2: queue + maxConcurrency=1 enforces real peak concurrency = 1 across single and dual Runtime instances and auto-advances queued runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-sched-p2-'));
  const dbPath = join(dir, 'shared.sqlite');

  let inFlight = 0;
  let peakInFlight = 0;
  let completedExecs = 0;
  const makeTrackedAdapter = () =>
    new TrackingAdapter(async () => {
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      try {
        await delay(140);
        completedExecs++;
        return `exec-${completedExecs}`;
      } finally {
        inFlight--;
      }
    });

  // Two distinct Runtime instances sharing the SAME SQLite DB!
  const storeA = new Store(dbPath);
  const poolA = new AccountPool(storeA, { root: dir });
  poolA.setDefaultModel('mock-sched');
  const directA = new DirectAgentRuntime(storeA, poolA, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: makeTrackedAdapter(),
  });
  const schedA = new ScheduledTaskRunner({ store: storeA, directAgent: directA });

  const storeB = new Store(dbPath);
  const poolB = new AccountPool(storeB, { root: dir });
  poolB.setDefaultModel('mock-sched');
  const directB = new DirectAgentRuntime(storeB, poolB, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: makeTrackedAdapter(),
  });
  const schedB = new ScheduledTaskRunner({ store: storeB, directAgent: directB });

  try {
    schedA.start();
    schedB.start();

    const queueSched = schedA.create({
      name: 'queue-serial',
      prompt: 'serial work',
      scheduleKind: 'daily',
      scheduleExpr: '09:00',
      timezone: 'UTC',
      concurrencyPolicy: 'queue',
      maxConcurrency: 1,
    });

    const base = Date.now();
    // Enqueue 3 slots rapidly across both runtimes
    schedA.enqueueScheduledRun(queueSched, base + 1, { trigger: 'schedule' });
    schedB.enqueueScheduledRun(queueSched, base + 2, { trigger: 'schedule' });
    schedA.enqueueScheduledRun(queueSched, base + 3, { trigger: 'schedule' });
    directA.recoveryWorker.wake();
    directB.recoveryWorker.wake();

    // Wait for all 3 queued runs to complete automatically
    const allRuns = await pollUntil(() => {
      const runs = schedA.listRuns(queueSched.id);
      return runs.length === 3 && runs.every((r) => r.status === 'completed') ? runs : null;
    }, 12000);

    assert.equal(allRuns.length, 3);
    assert.equal(completedExecs, 3, 'all 3 queued runs must execute exactly once');
    assert.equal(
      peakInFlight,
      1,
      `real execution concurrency peak must be 1 under queue+maxConcurrency=1, got ${peakInFlight}`,
    );

    // Claim-time skip enforcement across two runtimes: insert 2 pre-queued runs + jobs on skip+maxConcurrency=1
    inFlight = 0;
    peakInFlight = 0;
    const skipSched = schedA.create({
      name: 'claim-skip',
      prompt: 'skip overlap at claim time',
      scheduleKind: 'daily',
      scheduleExpr: '10:00',
      timezone: 'UTC',
      concurrencyPolicy: 'skip',
      maxConcurrency: 1,
    });
    const r1Id = uuid();
    const r2Id = uuid();
    const j1Id = uuid();
    const j2Id = uuid();
    const now = Date.now();
    storeA.tx(() => {
      for (const [rid, jid, slot] of [
        [r1Id, j1Id, now + 101],
        [r2Id, j2Id, now + 102],
      ]) {
        const idem = `sched:${skipSched.id}:${slot}`;
        storeA.db
          .prepare(
            `INSERT INTO runtime_jobs(
              id, kind, taskId, payload, status, attempts, maxAttempts, idempotencyKey, createdAt, updatedAt
            ) VALUES(?,'scheduled_task',?,?,'pending',0,2,?,?,?)`,
          )
          .run(
            jid,
            skipSched.id,
            JSON.stringify({ scheduleId: skipSched.id, scheduleRunId: rid, scheduledFor: slot, trigger: 'schedule' }),
            idem,
            now,
            now,
          );
        storeA.db
          .prepare(
            `INSERT INTO scheduled_task_runs(
              id, scheduleId, scheduledFor, idempotencyKey, jobId, status, createdAt
            ) VALUES(?,?,?,?,?,'queued',?)`,
          )
          .run(rid, skipSched.id, slot, idem, jid, now);
      }
    });
    directA.recoveryWorker.wake();
    directB.recoveryWorker.wake();

    const skipRuns = await pollUntil(() => {
      const runs = schedA.listRuns(skipSched.id);
      return runs.length === 2 && runs.every((r) => ['completed', 'skipped'].includes(r.status))
        ? runs
        : null;
    }, 8000);
    assert.equal(peakInFlight, 1, 'skip+maxConcurrency=1 must never exceed peak concurrency 1');
    assert.equal(
      skipRuns.filter((r) => r.status === 'completed').length,
      1,
      'exactly 1 run must complete',
    );
    assert.equal(
      skipRuns.filter((r) => r.status === 'skipped').length,
      1,
      'overlapping run at claim time must be marked skipped',
    );

    // concurrencyPolicy=allow permits overlapping executions (peakInFlight === 2)
    inFlight = 0;
    peakInFlight = 0;
    const allowSched = schedA.create({
      name: 'allow-overlap',
      prompt: 'allow concurrent',
      scheduleKind: 'daily',
      scheduleExpr: '11:00',
      timezone: 'UTC',
      concurrencyPolicy: 'allow',
      maxConcurrency: 1,
    });
    schedA.enqueueScheduledRun(allowSched, now + 201);
    schedB.enqueueScheduledRun(allowSched, now + 202);
    directA.recoveryWorker.wake();
    directB.recoveryWorker.wake();
    await pollUntil(() => {
      const runs = schedA.listRuns(allowSched.id);
      return runs.length === 2 && runs.every((r) => r.status === 'completed');
    }, 8000);
    assert.equal(peakInFlight, 2, 'concurrencyPolicy=allow must allow overlapping concurrent runs');

    // misfirePolicy=catch_up fires missed occurrences (capped at 5) and advances nextRunAt past now
    const catchUpSched = schedA.create({
      name: 'catch-up-misfire',
      prompt: 'catch up work',
      scheduleKind: 'interval',
      scheduleExpr: '1000ms',
      timezone: 'UTC',
      concurrencyPolicy: 'queue',
      misfirePolicy: 'catch_up',
      maxConcurrency: 2,
    });
    storeA.tx(() => {
      storeA.db
        .prepare('UPDATE scheduled_tasks SET nextRunAt=? WHERE id=?')
        .run(Date.now() - 8_000, catchUpSched.id);
    });
    schedA.stop();
    schedA.start();
    const catchUpRuns = schedA.listRuns(catchUpSched.id);
    assert.equal(catchUpRuns.length, 5, 'misfirePolicy=catch_up must cap missed slots at 5');
    assert.ok(schedA.get(catchUpSched.id).nextRunAt > Date.now(), 'nextRunAt must advance strictly past now');

    // Zero-idle-polling check after deleting schedules
    schedA.delete(queueSched.id);
    schedA.delete(skipSched.id);
    schedA.delete(allowSched.id);
    schedA.delete(catchUpSched.id);
    assert.equal(schedA.timer, null, 'scheduler timer must be null when no enabled schedules exist');
  } finally {
    schedA.stop();
    schedB.stop();
    await directA.close();
    await directB.close();
    storeA.close();
    storeB.close();
    cleanupDir(dir);
  }
});

test('Part 3.7: cron calculation handles UTC, Asia/Shanghai, and America/New_York DST spring-forward and fall-back transitions', () => {
  // UTC vs Asia/Shanghai
  const ref = Date.UTC(2026, 5, 1, 0, 0, 0);
  assert.equal(
    computeNextRunAt('hourly', '15', ref, { timezone: 'UTC' }),
    Date.UTC(2026, 5, 1, 0, 15, 0),
  );
  assert.equal(
    computeNextRunAt('daily', '09:00', ref, { timezone: 'Asia/Shanghai' }),
    Date.UTC(2026, 5, 1, 1, 0, 0),
  );

  // America/New_York 2026 Spring-Forward: Sunday March 8, 2026 (01:59 EST -> 03:00 EDT)
  // Day before 09:00 EST is 14:00Z; spring-forward day 09:00 EDT is 13:00Z (23 hours later)
  const mar7_0900_EST = Date.UTC(2026, 2, 7, 14, 0, 0);
  const mar8_0900_EDT = computeNextRunAt('daily', '09:00', mar7_0900_EST, {
    timezone: 'America/New_York',
  });
  assert.equal(mar8_0900_EDT, Date.UTC(2026, 2, 8, 13, 0, 0));
  assert.equal((mar8_0900_EDT - mar7_0900_EST) / 3_600_000, 23);

  // Nonexistent wall time 02:30 on March 8, 2026 -> skips to March 9 02:30 EDT (06:30Z)
  const mar8_0000_EST = Date.UTC(2026, 2, 8, 5, 0, 0);
  const next0230 = computeNextRunAt('daily', '02:30', mar8_0000_EST, {
    timezone: 'America/New_York',
  });
  assert.equal(next0230, Date.UTC(2026, 2, 9, 6, 30, 0));

  // Hourly across spring-forward: 01:15 EST (06:15Z) -> 03:15 EDT (07:15Z), 1 real hour later
  const mar8_0115_EST = Date.UTC(2026, 2, 8, 6, 15, 0);
  assert.equal(
    computeNextRunAt('hourly', '15', mar8_0115_EST, { timezone: 'America/New_York' }),
    Date.UTC(2026, 2, 8, 7, 15, 0),
  );

  // America/New_York 2026 Fall-Back: Sunday November 1, 2026 (01:59 EDT -> 01:00 EST)
  // Day before 09:00 EDT is 13:00Z; fall-back day 09:00 EST is 14:00Z (25 hours later)
  const oct31_0900_EDT = Date.UTC(2026, 9, 31, 13, 0, 0);
  const nov1_0900_EST = computeNextRunAt('daily', '09:00', oct31_0900_EDT, {
    timezone: 'America/New_York',
  });
  assert.equal(nov1_0900_EST, Date.UTC(2026, 10, 1, 14, 0, 0));
  assert.equal((nov1_0900_EST - oct31_0900_EDT) / 3_600_000, 25);

  // Ambiguous wall time 01:30 on Nov 1: after firing at 01:30 EDT (05:30Z), a daily schedule must NOT double-fire at 01:30 EST (06:30Z)!
  const nov1_0130_EDT = Date.UTC(2026, 10, 1, 5, 30, 0);
  const nextAfterFallBack = computeNextRunAt('daily', '01:30', nov1_0130_EDT, {
    timezone: 'America/New_York',
  });
  assert.equal(
    nextAfterFallBack,
    Date.UTC(2026, 10, 2, 6, 30, 0),
    'daily schedule must not double-fire on DST fall-back ambiguous hour',
  );

  // Hourly across fall-back: 01:15 EDT (05:15Z) -> 01:15 EST (06:15Z), 1 real hour later
  const nov1_0115_EDT = Date.UTC(2026, 10, 1, 5, 15, 0);
  assert.equal(
    computeNextRunAt('hourly', '15', nov1_0115_EDT, { timezone: 'America/New_York' }),
    Date.UTC(2026, 10, 1, 6, 15, 0),
  );
});

test('Part 3.8: legacy schema v6 database migrates cleanly to v7 and existing schedules read, run, and recover', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-sched-v6-'));
  const dbPath = join(dir, 'legacy-v6.sqlite');

  // Create a genuine legacy schema v6 DB first, then drop v7-only columns if needed and pin PRAGMA user_version=6
  const seedStore = new Store(dbPath);
  const now = Date.now();
  const legacySchedId = uuid();
  const legacySessId = uuid();
  const legacyTurnId = uuid();
  const legacyRunningRunId = uuid();
  const legacyStuckRunId = uuid();

  seedStore.tx(() => {
    seedStore.db
      .prepare(
        `INSERT INTO scheduled_tasks(
          id, name, prompt, scheduleKind, scheduleExpr, timezone, concurrencyPolicy,
          misfirePolicy, maxConcurrency, permissionMode, enabled, nextRunAt, lastStatus,
          runHistoryJson, createdAt, updatedAt
        ) VALUES(?,?,?,?,?,'America/New_York','queue','fire_once',1,'auto-safe',1,?,'running','[]',?,?)`,
      )
      .run(legacySchedId, 'legacy-v6-job', 'legacy prompt', 'hourly', '0', now + 3_600_000, now - 60_000, now - 60_000);

    seedStore.db
      .prepare(
        `INSERT INTO direct_sessions(
          id, title, workspaceRoot, model, mode, permissionMode, state, createdAt, updatedAt
        ) VALUES(?,?,?,'mock-v6','direct','auto-safe','completed',?,?)`,
      )
      .run(legacySessId, '[定时] legacy-v6-job', dir, now - 50_000, now - 40_000);

    seedStore.db
      .prepare(
        `INSERT INTO direct_turns(
          id, sessionId, input, model, state, createdAt, finishedAt
        ) VALUES(?,?,?,'mock-v6','completed',?,?)`,
      )
      .run(legacyTurnId, legacySessId, 'legacy prompt', now - 50_000, now - 40_000);

    seedStore.db
      .prepare(
        `INSERT INTO scheduled_task_runs(
          id, scheduleId, scheduledFor, idempotencyKey, sessionId, turnId, status, startedAt, createdAt
        ) VALUES(?,?,?,?,?,?,'running',?,?)`,
      )
      .run(
        legacyRunningRunId,
        legacySchedId,
        now - 50_000,
        `sched:${legacySchedId}:${now - 50_000}`,
        legacySessId,
        legacyTurnId,
        now - 50_000,
        now - 50_000,
      );

    seedStore.db
      .prepare(
        `INSERT INTO scheduled_task_runs(
          id, scheduleId, scheduledFor, idempotencyKey, jobId, status, createdAt
        ) VALUES(?,?,?,?,NULL,'queued',?)`,
      )
      .run(
        legacyStuckRunId,
        legacySchedId,
        now - 20_000,
        `sched:${legacySchedId}:${now - 20_000}`,
        now - 20_000,
      );
  });
  seedStore.close();

  // Force the SQLite file back to pure v6 schema (user_version=6, without any v7 columns)
  const rawDb = new DatabaseSync(dbPath);
  rawDb.exec('PRAGMA foreign_keys=OFF;');
  rawDb.exec(`
    CREATE TABLE scheduled_tasks_v6(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL,
      scheduleKind TEXT NOT NULL, scheduleExpr TEXT NOT NULL, workspaceRoot TEXT,
      model TEXT, permissionMode TEXT NOT NULL DEFAULT 'auto-safe',
      enabled INTEGER NOT NULL DEFAULT 1, lastRunAt INTEGER, nextRunAt INTEGER,
      lastSessionId TEXT, lastStatus TEXT, runHistoryJson TEXT NOT NULL DEFAULT '[]',
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      concurrencyPolicy TEXT NOT NULL DEFAULT 'skip',
      misfirePolicy TEXT NOT NULL DEFAULT 'fire_once',
      maxConcurrency INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO scheduled_tasks_v6
      SELECT id, name, prompt, scheduleKind, scheduleExpr, workspaceRoot, model, permissionMode,
             enabled, lastRunAt, nextRunAt, lastSessionId, lastStatus, runHistoryJson,
             createdAt, updatedAt, timezone, concurrencyPolicy, misfirePolicy, maxConcurrency
      FROM scheduled_tasks;
    DROP TABLE scheduled_tasks;
    ALTER TABLE scheduled_tasks_v6 RENAME TO scheduled_tasks;

    CREATE TABLE scheduled_task_runs_v6(
      id TEXT PRIMARY KEY,
      scheduleId TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      scheduledFor INTEGER NOT NULL, idempotencyKey TEXT NOT NULL UNIQUE,
      jobId TEXT, sessionId TEXT, turnId TEXT,
      status TEXT NOT NULL DEFAULT 'queued', error TEXT,
      startedAt INTEGER, finishedAt INTEGER, createdAt INTEGER NOT NULL
    );
    INSERT INTO scheduled_task_runs_v6
      SELECT id, scheduleId, scheduledFor, idempotencyKey, jobId, sessionId, turnId,
             status, error, startedAt, finishedAt, createdAt
      FROM scheduled_task_runs;
    DROP TABLE scheduled_task_runs;
    ALTER TABLE scheduled_task_runs_v6 RENAME TO scheduled_task_runs;
    PRAGMA user_version=6;
  `);
  rawDb.close();

  // Re-open with Store -> must migrate cleanly to user_version=7
  const migrated = new Store(dbPath);
  const pool = new AccountPool(migrated, { root: dir });
  pool.setDefaultModel('mock-v6');
  const direct = new DirectAgentRuntime(migrated, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: makeSimpleAdapter(15),
  });
  const scheduler = new ScheduledTaskRunner({ store: migrated, directAgent: direct });

  try {
    const version = migrated.db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(version, 7, 'v6 database must migrate cleanly to user_version=7');

    const loaded = scheduler.get(legacySchedId);
    assert.equal(loaded.timezone, 'America/New_York', 'migrated schedule preserves saved timezone');
    assert.equal(loaded.scheduleKind, 'hourly');

    scheduler.start();

    // Both the previously completed turn AND the stuck queued/jobId=null run must converge & finish!
    await pollUntil(() => {
      const r1 = migrated.db.prepare('SELECT status FROM scheduled_task_runs WHERE id=?').get(legacyRunningRunId);
      const r2 = migrated.db.prepare('SELECT status FROM scheduled_task_runs WHERE id=?').get(legacyStuckRunId);
      return r1?.status === 'completed' && r2?.status === 'completed';
    });

    assert.equal(scheduler.get(legacySchedId).lastStatus, 'completed');

    // Manual run on migrated schedule also works
    const manual = await scheduler.runNow(legacySchedId);
    await pollUntil(() => {
      const r = migrated.db.prepare('SELECT status FROM scheduled_task_runs WHERE id=?').get(manual.run.id);
      return r?.status === 'completed';
    });
  } finally {
    scheduler.stop();
    await direct.close();
    migrated.close();
    cleanupDir(dir);
  }
});

test('Part 3.1-3.6: actual frontend schedule payload builder & SDK match real backend HTTP validation for hourly, daily, weekly, cron and preserve saved timezone', async () => {
  const payloadPath = resolve(import.meta.dirname, '../../frontend/src/utils/schedulePayload.ts');
  let mod;
  try {
    mod = await import(`file://${payloadPath.replace(/\\/g, '/')}`);
  } catch (err) {
    assert.fail(
      `Expected frontend payload builder module at frontend/src/utils/schedulePayload.ts to exist and export buildCreateSchedulePayload/buildUpdateSchedulePayload/hydrateScheduleItem/getDefaultTimezone: ${err.message}`,
    );
  }

  const {
    buildCreateSchedulePayload,
    buildUpdateSchedulePayload,
    hydrateScheduleItem,
    getDefaultTimezone,
    formatNextRunAt,
  } = mod;

  assert.equal(typeof buildCreateSchedulePayload, 'function');
  assert.equal(typeof buildUpdateSchedulePayload, 'function');
  assert.equal(typeof hydrateScheduleItem, 'function');
  assert.equal(typeof getDefaultTimezone, 'function');
  assert.equal(typeof formatNextRunAt, 'function');

  // Default timezone must match system IANA timezone (or UTC), never blindly hardcoded
  const sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  assert.equal(getDefaultTimezone(), sysTz);
  assert.doesNotThrow(() => validateScheduleConfig({ scheduleKind: 'hourly', scheduleExpr: '0', timezone: getDefaultTimezone() }));

  // Spin up real HTTP Fastify server
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-sched-fe-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-fe');
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: makeSimpleAdapter(10),
  });
  const controlPlane = new ControlPlane({ store, pool, directAgent: direct });
  const token = 'frontend-schedule-contract-token-2026';
  const app = api(store, token, undefined, { pool, directAgent: direct, controlPlane });
  const auth = { authorization: `Bearer ${token}` };

  try {
    const scenarios = [
      {
        label: 'hourly',
        form: {
          title: 'Hourly Audit',
          prompt: 'check hourly health',
          projectId: null,
          frequency: 'hourly',
          hourlyMinute: 15,
          time: '09:00',
          weekday: '一',
          cronExpr: '0 9 * * 1-5',
          timezone: 'America/New_York',
          paused: false,
        },
        expectKind: 'hourly',
        expectExpr: '15',
        expectTz: 'America/New_York',
      },
      {
        label: 'daily',
        form: {
          title: 'Daily Sync',
          prompt: 'sync daily report',
          projectId: null,
          frequency: 'daily',
          hourlyMinute: 0,
          time: '08:30',
          weekday: '一',
          cronExpr: '0 9 * * 1-5',
          timezone: 'UTC',
          paused: false,
        },
        expectKind: 'daily',
        expectExpr: '08:30',
        expectTz: 'UTC',
      },
      {
        label: 'weekly',
        form: {
          title: 'Weekly Review',
          prompt: 'weekly repo audit',
          projectId: null,
          frequency: 'weekly',
          hourlyMinute: 0,
          time: '14:45',
          weekday: '三',
          cronExpr: '0 9 * * 1-5',
          timezone: 'Asia/Shanghai',
          paused: false,
        },
        expectKind: 'weekly',
        expectExpr: 'wed 14:45',
        expectTz: 'Asia/Shanghai',
      },
      {
        label: 'cron',
        form: {
          title: 'Cron Pipeline',
          prompt: 'run cron check',
          projectId: null,
          frequency: 'cron',
          hourlyMinute: 0,
          time: '09:00',
          weekday: '一',
          cronExpr: '30 10 * * 1-5',
          timezone: 'Europe/London',
          paused: false,
        },
        expectKind: 'cron',
        expectExpr: '30 10 * * 1-5',
        expectTz: 'Europe/London',
      },
    ];

    const createdRecords = [];
    for (const sc of scenarios) {
      const payload = buildCreateSchedulePayload(sc.form, {
        workspaceRoot: dir,
        model: 'mock-fe',
        permissionMode: 'auto-safe',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/schedules',
        headers: auth,
        payload,
      });
      assert.equal(
        res.statusCode,
        201,
        `${sc.label} payload from frontend builder must pass real backend validation, got ${res.statusCode}: ${res.body}`,
      );
      const saved = res.json();
      assert.equal(saved.scheduleKind, sc.expectKind);
      assert.equal(saved.scheduleExpr, sc.expectExpr);
      assert.equal(saved.timezone, sc.expectTz);
      assert.ok(typeof saved.nextRunAt === 'number' && saved.nextRunAt > Date.now());
      createdRecords.push({ sc, saved });

      // Hydrate back into frontend UI model and assert zero loss of timezone / schedule details
      const hydrated = hydrateScheduleItem(saved);
      assert.equal(hydrated.timezone, sc.expectTz, `${sc.label} hydration must preserve saved timezone`);
      assert.equal(hydrated.nextRunAt, saved.nextRunAt);
      if (sc.label === 'hourly') assert.equal(hydrated.hourlyMinute, 15);
      if (sc.label === 'weekly') {
        assert.equal(hydrated.weekday, '三');
        assert.equal(hydrated.time, '14:45');
      }
      assert.ok(formatNextRunAt(hydrated.nextRunAt, hydrated.timezone).length > 0);
    }

    // Pausing an existing schedule with America/New_York must NOT silently overwrite its saved timezone!
    const nySaved = createdRecords[0].saved;
    const pausePatch = buildUpdateSchedulePayload({ paused: true });
    assert.equal('timezone' in pausePatch, false, 'pause toggle patch must not inject/overwrite timezone');
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/schedules/${nySaved.id}`,
      headers: auth,
      payload: pausePatch,
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().timezone, 'America/New_York', 'saved timezone must remain untouched on pause');

    // Editing explicit fields with saved timezone preserves it; changing timezone updates it
    const editPatch = buildUpdateSchedulePayload({
      title: 'Hourly Audit v2',
      frequency: 'hourly',
      hourlyMinute: 45,
      timezone: 'Europe/Berlin',
      paused: false,
    });
    const edited = await app.inject({
      method: 'PATCH',
      url: `/v1/schedules/${nySaved.id}`,
      headers: auth,
      payload: editPatch,
    });
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.json().scheduleExpr, '45');
    assert.equal(edited.json().timezone, 'Europe/Berlin');

    // Verify App.tsx actually uses buildCreateSchedulePayload (no legacy broken '0 * * * *' hourly payload)
    const appSource = readFileSync(
      resolve(import.meta.dirname, '../../frontend/src/App.tsx'),
      'utf8',
    );
    assert.ok(
      appSource.includes('buildCreateSchedulePayload'),
      'App.tsx must use the tested buildCreateSchedulePayload helper',
    );
    assert.equal(
      appSource.includes("'0 * * * *'"),
      false,
      'App.tsx must not retain broken hourly 0 * * * * payload',
    );

    // Invalid hourly legacy payload '0 * * * *', bad cron, and invalid timezone surface clear 400 validation errors
    const badHourly = await app.inject({
      method: 'POST',
      url: '/v1/schedules',
      headers: auth,
      payload: {
        name: 'Bad Hourly',
        prompt: 'x',
        scheduleKind: 'hourly',
        scheduleExpr: '0 * * * *',
        timezone: 'UTC',
      },
    });
    assert.equal(badHourly.statusCode, 400);
    assert.equal(badHourly.json().error.code, 'INVALID_SCHEDULE_CONFIG');
    assert.match(String(badHourly.json().error.message ?? ''), /Invalid hourly minute/);

    // Verify backend SDK connectRuntime exposes full schedule lifecycle and surfaces error messages
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const sdkMod = await import('../client/index.ts');
    const rt = sdkMod.connectRuntime(baseUrl, token);
    assert.equal(typeof rt.updateSchedule, 'function', 'SDK must expose updateSchedule');
    assert.equal(typeof rt.deleteSchedule, 'function', 'SDK must expose deleteSchedule');
    await assert.rejects(
      () =>
        rt.createSchedule({
          name: 'Bad SDK',
          prompt: 'x',
          scheduleKind: 'daily',
          scheduleExpr: '09:00',
          timezone: 'Invalid/Zone',
        }),
      /INVALID_SCHEDULE_CONFIG.*Invalid IANA timezone/,
    );
    const sdkCreated = await rt.createSchedule({
      name: 'SDK Hourly',
      prompt: 'sdk check',
      scheduleKind: 'hourly',
      scheduleExpr: '5',
      timezone: 'America/New_York',
    });
    assert.equal(sdkCreated.timezone, 'America/New_York');
    const sdkUpdated = await rt.updateSchedule(sdkCreated.id, { enabled: false });
    assert.equal(sdkUpdated.enabled, false);
    assert.equal(sdkUpdated.timezone, 'America/New_York');
    const sdkDel = await rt.deleteSchedule(sdkCreated.id);
    assert.equal(sdkDel.deleted, true);

    // Part 4: Verify .github/workflows/ci.yml contract
    const ciYml = readFileSync(
      resolve(import.meta.dirname, '../../.github/workflows/ci.yml'),
      'utf8',
    );
    assert.match(ciYml, /push:/);
    assert.match(ciYml, /pull_request:/);
    assert.match(ciYml, /ubuntu-latest/);
    assert.match(ciYml, /windows-latest/);
    assert.match(ciYml, /node-version:\s*\['24'\]/);
    assert.match(ciYml, /npm run check/);
    assert.match(ciYml, /npx tsc --noEmit/);
    assert.match(ciYml, /npm run build/);
    assert.match(ciYml, /node --check desktop\/main\.mjs/);
    assert.match(ciYml, /set -euo pipefail/);
    assert.match(ciYml, /LASTEXITCODE/);
    assert.match(ciYml, /\[SKIP\].*security\.test\.js.*Docker/);
    assert.match(ciYml, /\[SKIP\].*providers\.test\.js.*Magpie/);
    assert.match(ciYml, /\[SKIP\].*integration\.test\.js.*Magpie/);
  } finally {
    controlPlane.close();
    await direct.close();
    await app.close();
    store.close();
    cleanupDir(dir);
  }
});
