import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { ShutdownCoordinator } from '../src/runtime/shutdown.js';
import { computeNextRunAt, validateScheduleConfig } from '../src/governance/cron.js';
import { ScheduledTaskRunner } from '../src/governance/scheduler.js';
import { ModelFeedbackTracker } from '../src/swarm/feedback.js';
import { AdaptiveModelRouter } from '../src/swarm/router.js';
import { AgentCapabilityRegistry, ModelCapabilityRegistry } from '../src/swarm/capabilities.js';
import { ControlPlane } from '../src/governance/control-plane.js';
import { api } from '../src/api.js';
import { service } from '../src/service.js';
import { config } from '../src/providers.js';

class EchoAdapter extends LlmAdapter {
  constructor(delayMs = 0) {
    super();
    this.delayMs = delayMs;
  }
  async *stream() {
    if (this.delayMs > 0) await delay(this.delayMs);
    yield { type: 'text-delta', index: 0, text: 'OK' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

test('Phase C.1: cron validator & IANA timezone calculation reject invalid configs and handle TZ offsets', () => {
  assert.throws(
    () => validateScheduleConfig({ scheduleKind: 'cron', scheduleExpr: '99 * * * *' }),
    (e) => e.code === 'INVALID_SCHEDULE_CONFIG' && e.status === 400,
  );
  assert.throws(
    () => validateScheduleConfig({ scheduleKind: 'cron', scheduleExpr: '* * * *' }),
    (e) => e.code === 'INVALID_SCHEDULE_CONFIG',
  );
  assert.throws(
    () => validateScheduleConfig({ scheduleKind: 'daily', scheduleExpr: '09:00', timezone: 'Mars/Olympus' }),
    (e) => e.code === 'INVALID_SCHEDULE_CONFIG',
  );
  assert.throws(
    () => validateScheduleConfig({ scheduleKind: 'interval', scheduleExpr: 'not-a-duration' }),
    (e) => e.code === 'INVALID_SCHEDULE_CONFIG',
  );
  assert.throws(
    () => validateScheduleConfig({ scheduleKind: 'daily', scheduleExpr: '09:00', concurrencyPolicy: 'bad' }),
    (e) => e.code === 'INVALID_SCHEDULE_CONFIG',
  );
  assert.throws(
    () => validateScheduleConfig({ scheduleKind: 'daily', scheduleExpr: '09:00', maxConcurrency: 0 }),
    (e) => e.code === 'INVALID_SCHEDULE_CONFIG',
  );

  // Reference: 2026-06-01T00:00:00Z (Shanghai is 08:00 local, UTC is 00:00 local)
  const ref = Date.UTC(2026, 5, 1, 0, 0, 0);
  const shanghaiNext = computeNextRunAt('daily', '09:30', ref, { timezone: 'Asia/Shanghai' });
  const utcNext = computeNextRunAt('daily', '09:30', ref, { timezone: 'UTC' });
  assert.equal(shanghaiNext, Date.UTC(2026, 5, 1, 1, 30, 0));
  assert.equal(utcNext, Date.UTC(2026, 5, 1, 9, 30, 0));

  const nyCron = computeNextRunAt('cron', '30 9 * * 1-5', ref, { timezone: 'America/New_York' });
  assert.equal(nyCron, Date.UTC(2026, 5, 1, 13, 30, 0)); // EDT is UTC-4 on June 1
});

test('Phase C.2: durable ScheduledTaskRunner enforces misfirePolicy, idempotency, concurrencyPolicy, cancelRun, and zero-idle-polling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-sched-c2-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-sched');
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: new EchoAdapter(120),
  });
  const controlPlane = new ControlPlane({ store, pool, directAgent: direct });
  const token = 'phase-c-scheduler-test-token-1234';
  const app = api(null, token, undefined, { pool, directAgent: direct, controlPlane });
  const auth = { authorization: `Bearer ${token}` };

  try {
    assert.equal(controlPlane.scheduler.timer, null);

    // Reject invalid schedule via HTTP with 400 INVALID_SCHEDULE_CONFIG
    const badRes = await app.inject({
      method: 'POST',
      url: '/v1/schedules',
      headers: auth,
      payload: { name: 'bad', prompt: 'x', scheduleKind: 'cron', scheduleExpr: '61 * * * *', timezone: 'UTC' },
    });
    assert.equal(badRes.statusCode, 400);
    assert.equal(badRes.json().error.code, 'INVALID_SCHEDULE_CONFIG');

    // Create two past-due tasks: one misfirePolicy='skip', one misfirePolicy='fire_once'
    const skipSched = controlPlane.scheduler.create({
      name: 'skip-misfire',
      prompt: 'skip',
      scheduleKind: 'daily',
      scheduleExpr: '09:00',
      timezone: 'UTC',
      misfirePolicy: 'skip',
      concurrencyPolicy: 'skip',
    });
    const fireSched = controlPlane.scheduler.create({
      name: 'fire-misfire',
      prompt: 'fire once',
      scheduleKind: 'daily',
      scheduleExpr: '09:00',
      timezone: 'Asia/Shanghai',
      misfirePolicy: 'fire_once',
      concurrencyPolicy: 'skip',
      maxConcurrency: 1,
    });
    const pastSlot = Date.now() - 60_000;
    store.tx(() => {
      store.db.prepare('UPDATE scheduled_tasks SET nextRunAt=? WHERE id IN (?,?)').run(pastSlot, skipSched.id, fireSched.id);
    });

    controlPlane.scheduler.start();
    assert.ok(controlPlane.scheduler.listRuns(skipSched.id).length === 0, 'misfirePolicy=skip must not fire');

    // Wait briefly for durable job to launch & confirm idempotency against duplicate slot enqueue
    controlPlane.scheduler.enqueueScheduledRun(fireSched, pastSlot, { trigger: 'duplicate_check' });
    const runsAfterDup = controlPlane.scheduler.listRuns(fireSched.id);
    assert.equal(runsAfterDup.length, 1, 'idempotencyKey sched:<id>:<slot> prevents duplicates');

    // ConcurrencyPolicy=skip while active run is in running/queued state
    controlPlane.scheduler.enqueueScheduledRun(fireSched, Date.now() + 1000, { trigger: 'overlap' });
    const skippedRow = controlPlane.scheduler.listRuns(fireSched.id).find((r) => r.status === 'skipped');
    assert.ok(skippedRow, 'overlapping trigger must record status=skipped under concurrencyPolicy=skip');

    // Manual slow run + HTTP list runs + cancel run
    const launched = await app.inject({ method: 'POST', url: `/v1/schedules/${skipSched.id}/run`, headers: auth });
    assert.equal(launched.statusCode, 200);
    const manualRunId = launched.json().run.id;

    const runsHttp = await app.inject({ method: 'GET', url: `/v1/schedules/${skipSched.id}/runs`, headers: auth });
    assert.equal(runsHttp.statusCode, 200);
    assert.ok(runsHttp.json().items.some((r) => r.id === manualRunId));

    const cancelHttp = await app.inject({
      method: 'POST',
      url: `/v1/schedules/${skipSched.id}/runs/${manualRunId}/cancel`,
      headers: auth,
    });
    assert.equal(cancelHttp.statusCode, 200);
    assert.equal(cancelHttp.json().status, 'cancelled');

    controlPlane.scheduler.delete(skipSched.id);
    controlPlane.scheduler.delete(fireSched.id);
    assert.equal(controlPlane.scheduler.timer, null, 'zero-idle-polling invariant restored');
  } finally {
    controlPlane.close();
    await direct.close();
    await app.close();
    store.close();
    rmDirSafe(dir);
  }
});

test('Phase C.3: ShutdownCoordinator orders stages, isolates timeouts, and is idempotent under concurrent close()', async () => {
  const order = [];
  const coord = new ShutdownCoordinator();
  coord.registerStage('last', () => order.push('last'), { order: 30 });
  coord.registerStage('timeout', () => new Promise(() => {}), { order: 15, timeoutMs: 120 });
  coord.registerStage('fail', () => {
    order.push('fail');
    throw new Error('boom');
  }, { order: 20 });
  coord.registerStage('first', () => order.push('first'), { order: 10 });

  const [r1, r2] = await Promise.all([coord.shutdown(), coord.shutdown()]);
  assert.equal(r1, r2);
  assert.deepEqual(order, ['first', 'fail', 'last']);
  assert.equal(r1.ok, false);
  assert.equal(r1.stages.find((s) => s.name === 'timeout').ok, false);

  // Full service() concurrent close test with active turn in flight
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-svc-close-'));
  const svc = await service({
    root: dir,
    token: 'service-shutdown-test-token-24chars',
    configuration: config({ env: {} }),
    workspaceRoot: dir,
  });
  svc.pool.setDefaultModel('slow-close-model');
  const slowAdapter = new EchoAdapter(250);
  svc.pool.adapter = slowAdapter;
  svc.directAgent.adapter = slowAdapter;
  svc.directAgent.kernel.inference.adapter = slowAdapter;
  const sess = svc.directAgent.createSession({ workspaceRoot: dir });
  svc.directAgent.startTurn(sess.id, { input: 'slow turn during shutdown' });
  await delay(30);

  try {
    const [c1, c2, c3] = await Promise.all([svc.close(), svc.close(), svc.close()]);
    assert.equal(c1, c2);
    assert.equal(c2, c3);
    assert.equal(c1.ok, true);
    assert.equal(svc.store.db.isOpen, false);
  } finally {
    rmDirSafe(dir);
  }
});

test('Phase C.4: ModelFeedbackTracker + AdaptiveModelRouter shift empirical selection with Bayesian confidence and explanation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-feedback-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, {
    root: dir,
    legacyProviders: {
      models: [
        { provider: 'deepseek', model: 'deepseek-reasoner', context: 128000, tools: true, math: 0.96 },
        { provider: 'anthropic', model: 'claude-sonnet-4', context: 200000, tools: true, math: 0.8 },
      ],
    },
  });

  try {
    const feedback = new ModelFeedbackTracker(store);
    const router = new AdaptiveModelRouter({
      modelRegistry: new ModelCapabilityRegistry(pool),
      agentRegistry: new AgentCapabilityRegistry(),
      pool,
      feedbackTracker: feedback,
    });

    // Cold-start prior picks deepseek-reasoner for planning
    const cold = router.select({ taskType: 'planning', objective: '推导分布式状态机与依赖排序' });
    assert.equal(cold.model, 'deepseek-reasoner');
    assert.equal(cold.explanation.confidence, 0);
    assert.equal(cold.explanation.sampleCount, 0);
    assert.equal(cold.explanation.empiricalScore, null);

    // Record 15 bad outcomes on deepseek-reasoner & 15 strong outcomes on claude-sonnet-4
    for (let i = 0; i < 15; i++) {
      feedback.record({
        model: 'deepseek-reasoner',
        provider: 'deepseek',
        taskType: 'planning',
        success: false,
        toolTotal: 2,
        toolSuccess: 0,
        verifiedPass: false,
        latencyMs: 55_000,
        timedOut: true,
        inputTokens: 2000,
        outputTokens: 500,
        contextWindow: 128_000,
      });
      feedback.record({
        model: 'claude-sonnet-4',
        provider: 'anthropic',
        taskType: 'planning',
        success: true,
        toolTotal: 4,
        toolSuccess: 4,
        verifiedPass: true,
        latencyMs: 600,
        timedOut: false,
        inputTokens: 1000,
        outputTokens: 400,
        contextWindow: 200_000,
      });
    }

    const warm = router.select({ taskType: 'planning', objective: '推导分布式状态机与依赖排序' });
    assert.equal(warm.model, 'claude-sonnet-4');
    assert.equal(warm.explanation.sampleCount, 15);
    assert.equal(warm.explanation.confidence, 0.6);
    assert.ok(warm.explanation.empiricalScore > 0.9);
    assert.equal(warm.explanation.metrics.toolSuccessRate, 1);
    assert.equal(warm.explanation.metrics.verificationPassRate, 1);
    assert.equal(warm.explanation.candidates.length, 2);
  } finally {
    store.close();
    rmDirSafe(dir);
  }
});
