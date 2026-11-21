import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { hostname as osHostname } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Store, id as uuid } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { ScheduledTaskRunner } from '../src/governance/scheduler.js';
import { computeNextRunAt, isSecondDstFold } from '../src/governance/cron.js';

async function pollUntil(fn, timeoutMs = 10_000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await delay(stepMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function cleanupDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  } catch {
    // ignore transient Windows handle cleanup
  }
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

test('Cron DST second-fold detection, 5-field cron fall-back, lagged/second-fold daily/weekly, Lord Howe 30m DST, and leap-day cron', () => {
  // America/New_York 2026-11-01 fall-back: 01:30 EDT = 05:30Z (fold 0), 01:30 EST = 06:30Z (fold 1)
  const nov1_0130_EDT = Date.UTC(2026, 10, 1, 5, 30, 0);
  const nov1_0131_EDT = Date.UTC(2026, 10, 1, 5, 31, 0);
  const nov1_0105_EST = Date.UTC(2026, 10, 1, 6, 5, 0);
  const nov1_0130_EST = Date.UTC(2026, 10, 1, 6, 30, 0);
  const nov2_0130_EST = Date.UTC(2026, 10, 2, 6, 30, 0);
  const nov8_0130_EST = Date.UTC(2026, 10, 8, 6, 30, 0);

  assert.equal(isSecondDstFold(nov1_0130_EDT, 'America/New_York'), false);
  assert.equal(isSecondDstFold(nov1_0130_EST, 'America/New_York'), true);
  assert.equal(isSecondDstFold(nov2_0130_EST, 'America/New_York'), false);

  // 5-field hour-restricted cron MUST NOT double-fire at 01:30 EST (06:30Z)
  for (const from of [nov1_0130_EDT, nov1_0131_EDT, nov1_0105_EST]) {
    assert.equal(
      computeNextRunAt('cron', '30 1 * * *', from, { timezone: 'America/New_York' }),
      nov2_0130_EST,
      `cron 30 1 * * * must skip second fold from ${new Date(from).toISOString()}`,
    );
    assert.equal(
      computeNextRunAt('daily', '01:30', from, { timezone: 'America/New_York' }),
      nov2_0130_EST,
      `daily 01:30 must skip second fold from ${new Date(from).toISOString()}`,
    );
    assert.equal(
      computeNextRunAt('weekly', 'sun 01:30', from, { timezone: 'America/New_York' }),
      nov8_0130_EST,
      `weekly sun 01:30 must skip second fold from ${new Date(from).toISOString()}`,
    );
  }

  // First occurrence BEFORE 01:30 EDT still fires on 01:30 EDT (05:30Z)
  const nov1_0100_EDT = Date.UTC(2026, 10, 1, 5, 0, 0);
  assert.equal(
    computeNextRunAt('cron', '30 1 * * *', nov1_0100_EDT, { timezone: 'America/New_York' }),
    nov1_0130_EDT,
  );

  // Hourly & wildcard-hour cron still fire every real hour across fall-back
  const nov1_0115_EDT = Date.UTC(2026, 10, 1, 5, 15, 0);
  const nov1_0115_EST = Date.UTC(2026, 10, 1, 6, 15, 0);
  assert.equal(
    computeNextRunAt('hourly', '15', nov1_0115_EDT, { timezone: 'America/New_York' }),
    nov1_0115_EST,
  );
  assert.equal(
    computeNextRunAt('cron', '15 * * * *', nov1_0115_EDT, { timezone: 'America/New_York' }),
    nov1_0115_EST,
  );

  // Australia/Lord_Howe 30-min DST fall-back: 2026-04-05 01:59 +11:00 -> 01:30 +10:30
  const lh_first_0145 = Date.UTC(2026, 3, 4, 14, 45, 0); // 2026-04-05 01:45 +11:00
  const lh_second_0145 = Date.UTC(2026, 3, 4, 15, 15, 0); // 2026-04-05 01:45 +10:30
  const lh_nextDay_0145 = Date.UTC(2026, 3, 5, 15, 15, 0); // 2026-04-06 01:45 +10:30
  assert.equal(isSecondDstFold(lh_first_0145, 'Australia/Lord_Howe'), false);
  assert.equal(isSecondDstFold(lh_second_0145, 'Australia/Lord_Howe'), true);
  assert.equal(
    computeNextRunAt('daily', '01:45', lh_first_0145, { timezone: 'Australia/Lord_Howe' }),
    lh_nextDay_0145,
  );
  assert.equal(
    computeNextRunAt('cron', '45 1 * * *', lh_first_0145, { timezone: 'Australia/Lord_Howe' }),
    lh_nextDay_0145,
  );

  // Leap-day cron 0 0 29 2 * from 2026 finds 2028-02-29T00:00:00Z cleanly & fast
  const t0 = performance.now();
  const leapNext = computeNextRunAt('cron', '0 0 29 2 *', Date.UTC(2026, 0, 1, 0, 0, 0), {
    timezone: 'UTC',
  });
  const elapsedMs = performance.now() - t0;
  assert.equal(leapNext, Date.UTC(2028, 1, 29, 0, 0, 0));
  assert.ok(elapsedMs < 500, `leap-day scan should stay fast, took ${elapsedMs.toFixed(1)}ms`);
});

test('Scenario #18: ScheduledTaskRunner recovery & lagged ticks across DST spring-forward and fall-back transitions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-sched-dst-s18-'));
  const dbPath = join(dir, 'engine.sqlite');
  const store = new Store(dbPath);
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-dst');

  let clockMs = Date.UTC(2026, 2, 7, 6, 0, 0); // 2026-03-07 01:00 EST
  const executedPrompts = [];
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: new TrackingAdapter(async ({ lastUser }) => {
      executedPrompts.push(lastUser);
      await delay(10);
      return 'DST_OK';
    }),
  });
  const scheduler = new ScheduledTaskRunner({
    store,
    directAgent: direct,
    nowFn: () => clockMs,
  });

  try {
    scheduler.start();

    // --- 1. Spring-Forward (2026-03-08 America/New_York: 01:59 EST -> 03:00 EDT) ---
    const sfDaily = scheduler.create({
      name: 'sf-nonexistent-0230',
      prompt: 'SF_DAILY_0230',
      scheduleKind: 'daily',
      scheduleExpr: '02:30',
      timezone: 'America/New_York',
      misfirePolicy: 'fire_once',
    });
    assert.equal(sfDaily.nextRunAt, Date.UTC(2026, 2, 7, 7, 30, 0)); // Mar 7 02:30 EST

    // Advance to Mar 7 02:30 EST and tick -> nextRunAt must skip nonexistent Mar 8 02:30 to Mar 9 02:30 EDT (06:30Z)
    clockMs = Date.UTC(2026, 2, 7, 7, 30, 5);
    scheduler.tickDue();
    assert.equal(
      scheduler.get(sfDaily.id).nextRunAt,
      Date.UTC(2026, 2, 9, 6, 30, 0),
      'spring-forward daily 02:30 must skip nonexistent March 8 occurrence',
    );

    // Crash before Mar 8 03:00 EDT (07:00Z), recover at 03:05 EDT (07:05Z)
    clockMs = Date.UTC(2026, 2, 8, 6, 55, 0); // 01:55 EST
    const sfCron = scheduler.create({
      name: 'sf-cron-0300',
      prompt: 'SF_CRON_0300',
      scheduleKind: 'cron',
      scheduleExpr: '0 3 * * *',
      timezone: 'America/New_York',
      misfirePolicy: 'fire_once',
    });
    assert.equal(sfCron.nextRunAt, Date.UTC(2026, 2, 8, 7, 0, 0));
    scheduler.stop();

    clockMs = Date.UTC(2026, 2, 8, 7, 5, 0); // 03:05 EDT
    scheduler.start();
    assert.equal(scheduler.listRuns(sfCron.id).length, 1);
    assert.equal(scheduler.get(sfCron.id).nextRunAt, Date.UTC(2026, 2, 9, 7, 0, 0));

    // Wait for spring-forward runs to converge before jumping clock 8 months to November fall-back
    await pollUntil(() => {
      const r1 = scheduler.listRuns(sfDaily.id);
      const r2 = scheduler.listRuns(sfCron.id);
      return r1[0]?.status === 'completed' && r2[0]?.status === 'completed';
    }, 8000);
    scheduler.update(sfDaily.id, { enabled: false });
    scheduler.update(sfCron.id, { enabled: false });

    // --- 2. Fall-Back (2026-11-01 America/New_York: 01:59 EDT -> 01:00 EST) ---
    clockMs = Date.UTC(2026, 10, 1, 4, 30, 0); // 00:30 EDT

    const fbDailyLag = scheduler.create({
      name: 'fb-daily-lag',
      prompt: 'FB_DAILY_LAG',
      scheduleKind: 'daily',
      scheduleExpr: '01:30',
      timezone: 'America/New_York',
      misfirePolicy: 'fire_once',
    });
    const fbWeeklyLag = scheduler.create({
      name: 'fb-weekly-lag',
      prompt: 'FB_WEEKLY_LAG',
      scheduleKind: 'weekly',
      scheduleExpr: 'sun 01:30',
      timezone: 'America/New_York',
      misfirePolicy: 'fire_once',
    });
    const fbCronCatchUp = scheduler.create({
      name: 'fb-cron-catchup',
      prompt: 'FB_CRON_CATCHUP',
      scheduleKind: 'cron',
      scheduleExpr: '30 1 * * *',
      timezone: 'America/New_York',
      misfirePolicy: 'catch_up',
    });
    const fbDailySkip = scheduler.create({
      name: 'fb-daily-skip',
      prompt: 'FB_DAILY_SKIP',
      scheduleKind: 'daily',
      scheduleExpr: '01:30',
      timezone: 'America/New_York',
      misfirePolicy: 'skip',
    });
    const fbDailyFold2 = scheduler.create({
      name: 'fb-daily-fold2',
      prompt: 'FB_DAILY_FOLD2',
      scheduleKind: 'daily',
      scheduleExpr: '01:30',
      timezone: 'America/New_York',
      misfirePolicy: 'fire_once',
    });
    const fbHourlyCatchUp = scheduler.create({
      name: 'fb-hourly-catchup',
      prompt: 'FB_HOURLY_CATCHUP',
      scheduleKind: 'hourly',
      scheduleExpr: '15',
      timezone: 'America/New_York',
      concurrencyPolicy: 'queue',
      misfirePolicy: 'catch_up',
    });

    const nov1_0530Z = Date.UTC(2026, 10, 1, 5, 30, 0);
    const nov2_0630Z = Date.UTC(2026, 10, 2, 6, 30, 0);
    const nov8_0630Z = Date.UTC(2026, 10, 8, 6, 30, 0);
    assert.equal(fbDailyLag.nextRunAt, nov1_0530Z);
    assert.equal(fbWeeklyLag.nextRunAt, nov1_0530Z);
    assert.equal(fbCronCatchUp.nextRunAt, nov1_0530Z);

    // 2A: Lagged live tick at 05:31Z (01:31 EDT) for fbDailyLag & fbWeeklyLag (pause others temporarily)
    store.tx(() => {
      store.db
        .prepare('UPDATE scheduled_tasks SET enabled=0 WHERE id IN (?,?,?,?)')
        .run(fbCronCatchUp.id, fbDailySkip.id, fbDailyFold2.id, fbHourlyCatchUp.id);
    });
    clockMs = Date.UTC(2026, 10, 1, 5, 31, 0); // 01:31 EDT (1 minute lag)
    scheduler.tickDue();
    assert.equal(scheduler.get(fbDailyLag.id).nextRunAt, nov2_0630Z);
    assert.equal(scheduler.get(fbWeeklyLag.id).nextRunAt, nov8_0630Z);

    // Advance past second 01:30 EST (06:35Z) and tick again -> MUST NOT double-fire!
    clockMs = Date.UTC(2026, 10, 1, 6, 35, 0);
    scheduler.tickDue();
    assert.equal(scheduler.listRuns(fbDailyLag.id).length, 1, 'lagged daily must fire exactly once on fall-back day');
    assert.equal(scheduler.listRuns(fbWeeklyLag.id).length, 1, 'lagged weekly must fire exactly once on fall-back day');

    // 2B: Crash & recovery right INSIDE second fold at 06:05Z (01:05 EST) for fbDailyFold2
    scheduler.stop();
    store.tx(() => {
      store.db
        .prepare('UPDATE scheduled_tasks SET enabled=1, nextRunAt=? WHERE id=?')
        .run(nov1_0530Z, fbDailyFold2.id);
    });
    clockMs = Date.UTC(2026, 10, 1, 6, 5, 0); // 01:05 EST (inside fold 1, before 01:30 EST)
    scheduler.start();
    assert.equal(scheduler.listRuns(fbDailyFold2.id).length, 1, 'recovery inside fold 1 must fire once');
    assert.equal(
      scheduler.get(fbDailyFold2.id).nextRunAt,
      nov2_0630Z,
      'recovery inside fold 1 must skip 01:30 EST and advance to Nov 2',
    );

    // 2C: Crash & recovery AFTER second fold at 06:40Z (01:40 EST) for cron catch_up, daily skip, hourly catch_up
    scheduler.stop();
    const nov1_0515Z = Date.UTC(2026, 10, 1, 5, 15, 0);
    store.tx(() => {
      store.db
        .prepare('UPDATE scheduled_tasks SET enabled=1, nextRunAt=? WHERE id IN (?,?)')
        .run(nov1_0530Z, fbCronCatchUp.id, fbDailySkip.id);
      store.db
        .prepare('UPDATE scheduled_tasks SET enabled=1, nextRunAt=? WHERE id=?')
        .run(nov1_0515Z, fbHourlyCatchUp.id);
    });
    clockMs = Date.UTC(2026, 10, 1, 6, 40, 0); // 01:40 EST
    scheduler.start();

    assert.equal(
      scheduler.listRuns(fbCronCatchUp.id).length,
      1,
      'cron 30 1 * * * catch_up across fall-back must fire exactly once',
    );
    assert.equal(scheduler.get(fbCronCatchUp.id).nextRunAt, nov2_0630Z);
    assert.equal(scheduler.listRuns(fbDailySkip.id).length, 0, 'misfire skip must fire 0 times');
    assert.equal(scheduler.get(fbDailySkip.id).nextRunAt, nov2_0630Z);

    const hourlyRuns = scheduler.listRuns(fbHourlyCatchUp.id);
    assert.equal(hourlyRuns.length, 2, 'hourly catch_up across fall-back must fire 2 real-hour slots (05:15Z & 06:15Z)');
    assert.deepEqual(
      hourlyRuns.map((r) => r.scheduledFor).sort((a, b) => a - b),
      [Date.UTC(2026, 10, 1, 5, 15, 0), Date.UTC(2026, 10, 1, 6, 15, 0)],
    );
    assert.equal(scheduler.get(fbHourlyCatchUp.id).nextRunAt, Date.UTC(2026, 10, 1, 7, 15, 0));

    // Verify all enqueued runs converge cleanly to completed (zero stuck runs)
    await pollUntil(() => {
      const stuck = store.db
        .prepare("SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE status IN ('queued','running')")
        .get().n;
      return stuck === 0;
    }, 10_000);

    const completedCount = store.db
      .prepare("SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE status='completed'")
      .get().n;
    // sfDaily(1) + sfCron(1) + fbDailyLag(1) + fbWeeklyLag(1) + fbDailyFold2(1) + fbCronCatchUp(1) + fbHourlyCatchUp(2) = 8
    assert.equal(completedCount, 8);
  } finally {
    scheduler.stop();
    await direct.close();
    store.close();
    cleanupDir(dir);
  }
});

test('Scenario #6: Dual-runtime CAS contention on same occurrence, concurrent pause, cross-instance watcher pruning, capacity expansion & delete turn cancel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-sched-dual-s6-'));
  const dbPath = join(dir, 'shared.sqlite');
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  let execCount = 0;
  let gateActive = false;
  let releaseGate = null;
  let gateEnteredCount = 0;
  const makeAdapter = () =>
    new TrackingAdapter(async () => {
      execCount++;
      if (gateActive) {
        gateEnteredCount++;
        await new Promise((r) => {
          const prev = releaseGate;
          releaseGate = () => {
            prev?.();
            r();
          };
        });
      } else {
        await delay(25);
      }
      return 'DUAL_OK';
    });

  const storeA = new Store(dbPath);
  const poolA = new AccountPool(storeA, { root: dir });
  poolA.setDefaultModel('mock-dual');
  const directA = new DirectAgentRuntime(storeA, poolA, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: makeAdapter(),
    workerId: 'dual-worker-A',
  });
  const schedA = new ScheduledTaskRunner({ store: storeA, directAgent: directA });

  const storeB = new Store(dbPath);
  const poolB = new AccountPool(storeB, { root: dir });
  poolB.setDefaultModel('mock-dual');
  const directB = new DirectAgentRuntime(storeB, poolB, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: makeAdapter(),
    workerId: 'dual-worker-B',
  });
  const schedB = new ScheduledTaskRunner({ store: storeB, directAgent: directB });

  try {
    schedA.start();
    schedB.start();

    // 1. Concurrent dual-runtime ticks & misfire recovery on the SAME due interval & daily schedules
    const intervalSched = schedA.create({
      name: 'dual-interval',
      prompt: 'dual interval work',
      scheduleKind: 'interval',
      scheduleExpr: '5000ms',
      timezone: 'UTC',
      concurrencyPolicy: 'queue',
      maxConcurrency: 1,
    });
    const dailySched = schedA.create({
      name: 'dual-daily',
      prompt: 'dual daily work',
      scheduleKind: 'daily',
      scheduleExpr: '09:00',
      timezone: 'UTC',
      concurrencyPolicy: 'skip',
      maxConcurrency: 1,
    });

    const dueTs = Date.now() - 100;
    storeA.tx(() => {
      storeA.db
        .prepare('UPDATE scheduled_tasks SET nextRunAt=? WHERE id IN (?,?)')
        .run(dueTs, intervalSched.id, dailySched.id);
    });

    const tickNow = Date.now();
    const [hA, hB, mA, mB] = await Promise.all([
      Promise.resolve().then(() => schedA.tickDue({ now: tickNow })),
      Promise.resolve().then(() => schedB.tickDue({ now: tickNow })),
      Promise.resolve().then(() => schedA.recoverMisfires({ now: tickNow })),
      Promise.resolve().then(() => schedB.recoverMisfires({ now: tickNow })),
    ]);
    assert.equal(hA + hB + mA + mB, 2, 'exactly one runtime wins CAS per due schedule');

    directA.recoveryWorker.wake();
    directB.recoveryWorker.wake();

    await pollUntil(() => {
      const r1 = schedA.listRuns(intervalSched.id);
      const r2 = schedA.listRuns(dailySched.id);
      return (
        r1.length === 1 &&
        r1[0].status === 'completed' &&
        r2.length === 1 &&
        r2[0].status === 'completed'
      );
    }, 10_000);

    assert.equal(execCount, 2, 'each occurrence must execute exactly once across both runtimes');
    assert.equal(schedA.listRuns(intervalSched.id).length, 1);
    assert.equal(schedA.listRuns(dailySched.id).length, 1);
    assert.ok(schedA.get(intervalSched.id).nextRunAt > tickNow, 'interval nextRunAt must advance monotonically');
    assert.ok(schedA.get(dailySched.id).nextRunAt > tickNow, 'daily nextRunAt must advance monotonically');

    // 2. Concurrent pause (enabled=false) prevents nextRunAt revival & cancels unlaunched queued non-manual runs
    const pauseSched = schedA.create({
      name: 'dual-pause',
      prompt: 'should not run when paused',
      scheduleKind: 'interval',
      scheduleExpr: '5000ms',
      timezone: 'UTC',
      concurrencyPolicy: 'queue',
      maxConcurrency: 1,
    });
    const pauseDue = Date.now() - 50;
    storeA.tx(() => {
      storeA.db.prepare('UPDATE scheduled_tasks SET nextRunAt=? WHERE id=?').run(pauseDue, pauseSched.id);
    });
    // Pause on A right before B ticks
    schedA.update(pauseSched.id, { enabled: false });
    const pausedHandled = schedB.tickDue({ now: Date.now() });
    assert.equal(pausedHandled, 0, 'paused schedule must not be claimed by peer runtime');
    assert.equal(schedB.get(pauseSched.id).nextRunAt, null, 'paused schedule nextRunAt must remain null');
    assert.equal(schedB.listRuns(pauseSched.id).length, 0);

    // Queued non-manual run on a disabled schedule is cancelled on job execution (never launches LLM)
    const beforeDisabledExecs = execCount;
    const disabledQueuedRun = schedA.enqueueScheduledRun(pauseSched, Date.now() + 999, {
      trigger: 'schedule',
    });
    directA.recoveryWorker.wake();
    directB.recoveryWorker.wake();
    const cancelledDisabled = await pollUntil(() => {
      const r = storeA.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(disabledQueuedRun.id);
      return r?.status === 'cancelled' ? r : null;
    }, 8000);
    assert.equal(cancelledDisabled.error, 'schedule_disabled');
    assert.equal(execCount, beforeDisabledExecs, 'disabled schedule queued run must never invoke model');

    // 3. Cross-instance watcher cleanup (no listener leak when Runtime B settles turn started on Runtime A)
    const watchSched = schedA.create({
      name: 'cross-watch',
      prompt: 'watch test',
      scheduleKind: 'daily',
      scheduleExpr: '12:00',
      timezone: 'UTC',
    });
    const fakeSess = directA.createSession({ title: 'cross-sess', workspaceRoot: dir, model: 'mock-dual' });
    const fakeTurnId = uuid();
    const fakeRunId = uuid();
    const tNow = Date.now();
    storeA.tx(() => {
      storeA.db
        .prepare(
          "INSERT INTO direct_turns(id, sessionId, clientTurnId, input, model, state, createdAt) VALUES(?,?,?,?,?,'running',?)",
        )
        .run(fakeTurnId, fakeSess.id, `sched:${watchSched.id}:${tNow}`, 'watch test', 'mock-dual', tNow);
      storeA.db
        .prepare(
          "INSERT INTO scheduled_task_runs(id, scheduleId, scheduledFor, idempotencyKey, sessionId, turnId, status, runSeq, startedAt, createdAt, updatedAt) VALUES(?,?,?,?,?,?,'running',1,?,?,?)",
        )
        .run(fakeRunId, watchSched.id, tNow, `sched:${watchSched.id}:${tNow}`, fakeSess.id, fakeTurnId, tNow, tNow, tNow);
    });
    schedA.reconcileRuns();
    assert.ok(schedA.turnWatchers.has(fakeTurnId), 'Runtime A attaches watcher for running turn');

    // Runtime B settles the turn directly in SQLite (no EventRouter event emitted on Runtime A!)
    storeB.tx(() => {
      storeB.db
        .prepare("UPDATE direct_turns SET state='completed', finishedAt=? WHERE id=?")
        .run(Date.now(), fakeTurnId);
    });
    schedA.reconcileRuns();
    assert.equal(schedA.turnWatchers.has(fakeTurnId), false, 'Runtime A must prune watcher after peer settlement');
    assert.equal(
      storeA.db.prepare('SELECT status FROM scheduled_task_runs WHERE id=?').get(fakeRunId).status,
      'completed',
    );

    // 4. Raising maxConcurrency in update() wakes parked runs; delete() cancels active direct_turns
    gateActive = true;
    gateEnteredCount = 0;
    const expandSched = schedA.create({
      name: 'expand-conc',
      prompt: 'expand concurrency work',
      scheduleKind: 'daily',
      scheduleExpr: '15:00',
      timezone: 'UTC',
      concurrencyPolicy: 'queue',
      maxConcurrency: 1,
    });
    const exp1 = schedA.enqueueScheduledRun(expandSched, Date.now() + 10_001);
    await pollUntil(() => gateEnteredCount === 1, 8000);
    const exp2 = schedA.enqueueScheduledRun(expandSched, Date.now() + 10_002);
    await delay(100);
    assert.equal(gateEnteredCount, 1, 'second run stays parked at maxConcurrency=1');

    // Expand maxConcurrency to 2 -> parked run2 must immediately wake & start concurrently!
    schedA.update(expandSched.id, { maxConcurrency: 2 });
    directA.recoveryWorker.wake();
    directB.recoveryWorker.wake();
    await pollUntil(() => gateEnteredCount === 2, 8000);

    // Deleting schedule while turns are active must cancel their direct_turns
    const activeTurnIds = storeA.db
      .prepare('SELECT turnId FROM scheduled_task_runs WHERE scheduleId=? AND turnId IS NOT NULL')
      .all(expandSched.id)
      .map((r) => r.turnId);
    assert.equal(activeTurnIds.length, 2);
    schedA.delete(expandSched.id);
    for (const tid of activeTurnIds) {
      const tRow = storeA.db.prepare('SELECT state FROM direct_turns WHERE id=?').get(tid);
      assert.equal(tRow.state, 'cancelled', 'delete(scheduleId) must cancel active direct_turns');
    }
    releaseGate?.();
    gateActive = false;

    // Clean up remaining schedules & verify zero-idle-polling invariant
    for (const s of [intervalSched, dailySched, pauseSched, watchSched]) {
      schedA.delete(s.id);
    }
    assert.equal(schedA.timer, null, 'timer must return to null when no schedules or active runs exist');
    assert.equal(unhandled.length, 0, `expected zero unhandled rejections, got ${unhandled}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    releaseGate?.();
    schedA.stop();
    schedB.stop();
    await directA.close();
    await directB.close();
    storeA.close();
    storeB.close();
    cleanupDir(dir);
  }
});

test('Fallback !jobQueue execution, O(1) 24h-offline 50ms misfire recovery, manual runNow() cadence preservation, dead-PID reclaim & corrupt-row isolation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-sched-edge-'));
  const dbPath = join(dir, 'engine.sqlite');
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  const store = new Store(dbPath);
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-edge');

  try {
    // --- 1. Fallback !jobQueue execution (no UNIQUE crash, converges cleanly) ---
    const listeners = new Map();
    const emitSession = (sessionId, ev) => {
      for (const fn of [...(listeners.get(sessionId) ?? [])]) fn(ev);
    };
    let mockTurnCalls = 0;
    const noQueueAgent = {
      // Intentionally NO jobQueue!
      createSession({ title, model, workspaceRoot, permissionMode }) {
        const sid = uuid();
        const now = Date.now();
        store.tx(() => {
          store.db
            .prepare(
              "INSERT INTO direct_sessions(id, title, workspaceRoot, model, mode, permissionMode, state, createdAt, updatedAt) VALUES(?,?,?,?,'direct',?,'idle',?,?)",
            )
            .run(sid, title, workspaceRoot || dir, model || 'mock-edge', permissionMode || 'auto-safe', now, now);
        });
        return { id: sid, title };
      },
      getSession(sid) {
        return store.db.prepare('SELECT * FROM direct_sessions WHERE id=?').get(sid);
      },
      startTurn(sessionId, { input, clientTurnId, model }) {
        mockTurnCalls++;
        const turnId = uuid();
        const now = Date.now();
        store.tx(() => {
          store.db
            .prepare(
              "INSERT INTO direct_turns(id, sessionId, clientTurnId, input, model, state, createdAt) VALUES(?,?,?,?,?,'running',?)",
            )
            .run(turnId, sessionId, clientTurnId, input, model || 'mock-edge', now);
        });
        setTimeout(() => {
          if (!store.db.isOpen) return;
          store.tx(() => {
            store.db
              .prepare("UPDATE direct_turns SET state='completed', finishedAt=? WHERE id=?")
              .run(Date.now(), turnId);
          });
          emitSession(sessionId, { turnId, type: 'turn/completed', data: {} });
        }, 25);
        return { turn: { id: turnId, sessionId, state: 'running' } };
      },
      subscribe(sessionId, fn) {
        if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
        listeners.get(sessionId).add(fn);
        return () => listeners.get(sessionId)?.delete(fn);
      },
    };

    const fallbackScheduler = new ScheduledTaskRunner({ store, directAgent: noQueueAgent });
    const fbSched = fallbackScheduler.create({
      name: 'no-queue-sched',
      prompt: 'run without jobQueue',
      scheduleKind: 'daily',
      scheduleExpr: '09:00',
      timezone: 'UTC',
    });
    const fbSlot = Date.now() - 1000;
    const fbRun1 = fallbackScheduler.enqueueScheduledRun(fbSched, fbSlot, { trigger: 'schedule' });
    // Retry same slot -> must deduplicate cleanly, never hit UNIQUE constraint!
    const fbRunDup = fallbackScheduler.enqueueScheduledRun(fbSched, fbSlot, { trigger: 'retry' });
    assert.equal(fbRunDup.id, fbRun1.id);

    const fbCompleted = await pollUntil(() => {
      const r = store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(fbRun1.id);
      return r?.status === 'completed' ? r : null;
    }, 5000);
    assert.equal(fbCompleted.status, 'completed');
    assert.equal(mockTurnCalls, 1, '!jobQueue fallback must execute turn exactly once');
    assert.equal(unhandled.length, 0, 'no unhandled UNIQUE rejection in !jobQueue fallback');
    fallbackScheduler.delete(fbSched.id);
    fallbackScheduler.stop();

    // --- 2. Real DirectAgentRuntime for O(1) misfire, runNow cadence, corrupt isolation, dead-PID reclaim ---
    const direct = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: dir,
      dataRoot: dir,
      adapter: new TrackingAdapter(async () => {
        await delay(10);
        return 'EDGE_OK';
      }),
    });
    const scheduler = new ScheduledTaskRunner({ store, directAgent: direct });

    try {
      // 2A: O(1) misfire recovery on 24h-offline 50ms interval (< 100ms)
      const now = Date.now();
      const dayAgo = now - 86_400_000; // 1,728,000 x 50ms intervals!
      const sFire = scheduler.create({
        name: '50ms-fire-once',
        prompt: 'fast fire once',
        scheduleKind: 'interval',
        scheduleExpr: '50ms',
        misfirePolicy: 'fire_once',
      });
      const sSkip = scheduler.create({
        name: '50ms-skip',
        prompt: 'fast skip',
        scheduleKind: 'interval',
        scheduleExpr: '50ms',
        misfirePolicy: 'skip',
      });
      const sCatch = scheduler.create({
        name: '50ms-catch-up',
        prompt: 'fast catch up',
        scheduleKind: 'interval',
        scheduleExpr: '50ms',
        misfirePolicy: 'catch_up',
        concurrencyPolicy: 'queue',
      });
      store.tx(() => {
        store.db
          .prepare('UPDATE scheduled_tasks SET nextRunAt=? WHERE id IN (?,?,?)')
          .run(dayAgo, sFire.id, sSkip.id, sCatch.id);
      });

      const t0 = performance.now();
      scheduler.recoverMisfires({ now });
      const misfireMs = performance.now() - t0;
      assert.ok(misfireMs < 100, `24h-offline 50ms misfire recovery must be O(1) (<100ms), took ${misfireMs.toFixed(1)}ms`);
      assert.equal(scheduler.listRuns(sFire.id).length, 1);
      assert.equal(scheduler.listRuns(sSkip.id).length, 0);
      assert.equal(scheduler.listRuns(sCatch.id).length, 5);
      assert.ok(scheduler.get(sFire.id).nextRunAt > now);
      assert.ok(scheduler.get(sSkip.id).nextRunAt > now);
      assert.ok(scheduler.get(sCatch.id).nextRunAt > now);

      // Pause fast 50ms schedules so they don't keep ticking during remaining assertions
      scheduler.update(sFire.id, { enabled: false });
      scheduler.update(sSkip.id, { enabled: false });
      scheduler.update(sCatch.id, { enabled: false });

      // 2B: Manual runNow() preserves periodic nextRunAt cadence
      const cadenceSched = scheduler.create({
        name: 'cadence-hourly',
        prompt: 'cadence check',
        scheduleKind: 'interval',
        scheduleExpr: '1h',
      });
      const pinnedNext = Date.now() + 1_800_000;
      store.tx(() => {
        store.db.prepare('UPDATE scheduled_tasks SET nextRunAt=? WHERE id=?').run(pinnedNext, cadenceSched.id);
      });
      const manualRes = await scheduler.runNow(cadenceSched.id);
      assert.equal(
        scheduler.get(cadenceSched.id).nextRunAt,
        pinnedNext,
        'manual runNow() must preserve existing periodic nextRunAt cadence',
      );
      await pollUntil(() => {
        const r = store.db.prepare('SELECT status FROM scheduled_task_runs WHERE id=?').get(manualRes.run.id);
        return r?.status === 'completed';
      }, 5000);

      // 2C: Corrupt legacy schedule row isolation (must not crash start() or block healthy schedule)
      const corruptId = uuid();
      const healthySched = scheduler.create({
        name: 'healthy-peer',
        prompt: 'healthy peer work',
        scheduleKind: 'daily',
        scheduleExpr: '09:00',
        timezone: 'UTC',
        misfirePolicy: 'fire_once',
      });
      const past = Date.now() - 5000;
      store.tx(() => {
        store.db
          .prepare(
            `INSERT INTO scheduled_tasks(
              id, name, prompt, scheduleKind, scheduleExpr, timezone, concurrencyPolicy,
              misfirePolicy, maxConcurrency, permissionMode, enabled, nextRunAt,
              lastStatusRunSeq, runHistoryJson, createdAt, updatedAt
            ) VALUES(?,'corrupt-v5','bad','hourly','0 * * * *','UTC','skip','fire_once',1,'auto-safe',1,?,0,'[]',?,?)`,
          )
          .run(corruptId, past, past, past);
        store.db.prepare('UPDATE scheduled_tasks SET nextRunAt=? WHERE id=?').run(past, healthySched.id);
      });

      assert.doesNotThrow(() => scheduler.start(), 'corrupt legacy schedule row must not crash boot');
      const corruptAfter = scheduler.get(corruptId);
      assert.equal(corruptAfter.enabled, false, 'corrupt schedule is quarantined as disabled');
      assert.equal(corruptAfter.nextRunAt, null);
      assert.equal(corruptAfter.lastStatus, 'failed');
      await pollUntil(() => {
        const runs = scheduler.listRuns(healthySched.id);
        return runs.length === 1 && runs[0].status === 'completed';
      }, 8000);
      assert.ok(scheduler.timer !== null, 'healthy schedules remain armed after corrupt-row isolation');

      // 2D: Dead-PID active job with unexpired lease is detected via classifyJobOwnership & reclaimed
      const deadSched = scheduler.create({
        name: 'dead-pid-reclaim',
        prompt: 'reclaim dead worker job',
        scheduleKind: 'daily',
        scheduleExpr: '10:00',
        timezone: 'UTC',
      });
      const deadWorkerId = `dead-worker-${uuid().slice(0, 8)}`;
      const deadJobId = uuid();
      const deadRunId = uuid();
      const deadSlot = Date.now() - 2000;
      const deadIdem = `sched:${deadSched.id}:${deadSlot}`;
      store.tx(() => {
        store.db
          .prepare(
            "INSERT INTO runtime_workers(workerId, pid, hostname, status, startedAt, heartbeatAt) VALUES(?,?,?,'active',?,?)",
          )
          .run(deadWorkerId, 999_999, osHostname(), deadSlot, deadSlot);
        store.db
          .prepare(
            `INSERT INTO runtime_jobs(
              id, kind, taskId, payload, status, fence, workerId, leaseExpiresAt,
              attempts, maxAttempts, idempotencyKey, createdAt, updatedAt
            ) VALUES(?,'scheduled_task',?,?,'active','dead-fence',?,?,1,3,?,?,?)`,
          )
          .run(
            deadJobId,
            deadSched.id,
            JSON.stringify({ scheduleId: deadSched.id, scheduleRunId: deadRunId, scheduledFor: deadSlot, trigger: 'schedule' }),
            deadWorkerId,
            Date.now() + 60_000, // Lease still 60s in the future, but owner PID is dead!
            deadIdem,
            deadSlot,
            deadSlot,
          );
        store.db
          .prepare(
            `INSERT INTO scheduled_task_runs(
              id, scheduleId, scheduledFor, idempotencyKey, jobId, status, runSeq, createdAt, updatedAt
            ) VALUES(?,?,?,?,?,'queued',1,?,?)`,
          )
          .run(deadRunId, deadSched.id, deadSlot, deadIdem, deadJobId, deadSlot, deadSlot);
      });

      const recStats = scheduler.reconcileRuns();
      assert.ok(recStats.woken >= 1, 'reconcileRuns must wake worker for dead-PID active job');
      const deadWorkerRow = store.db.prepare('SELECT status FROM runtime_workers WHERE workerId=?').get(deadWorkerId);
      assert.equal(deadWorkerRow.status, 'dead');
      await pollUntil(() => {
        const r = store.db.prepare('SELECT status FROM scheduled_task_runs WHERE id=?').get(deadRunId);
        return r?.status === 'completed';
      }, 8000);
      assert.equal(unhandled.length, 0);
    } finally {
      scheduler.stop();
      await direct.close();
    }
  } finally {
    process.off('unhandledRejection', onUnhandled);
    store.close();
    cleanupDir(dir);
  }
});
