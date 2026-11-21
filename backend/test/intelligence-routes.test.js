import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Store } from '../src/store.js';
import { registerIntelligenceRoutes } from '../src/routes/intelligence-routes.js';
import { AdaptivePlanner } from '../src/planning/planner.js';
import { EvaluationService } from '../src/evaluation/service.js';
import { createCapabilityProfileRegistry } from '../src/swarm/capability-registry.js';
import { TeamOptimizer } from '../src/swarm/team-optimizer.js';
import { CommunicationBus, MemoryCommunicationAdapter, StoreCommunicationAdapter } from '../src/communication/index.js';
import { ExperienceMemoryService } from '../src/memory/index.js';
import { BENCHMARK_ID } from '../src/evaluation/service.js';

test('2.2 intelligence routes expose benchmark, plan, capability, communication and memory boundaries', async (t) => {
  const store = new Store(':memory:');
  const evaluation = new EvaluationService({
    store,
    runtimeFactory: async ({ task }) => ({ output: task.expected.output }),
    timeoutMs: 1_000,
  });
  const capabilityRegistry = createCapabilityProfileRegistry();
  capabilityRegistry.registerDeclared({ id: 'fixture-model', capabilities: { coding: 0.9, reasoning: 0.8 } });
  const communication = new CommunicationBus({ adapter: new MemoryCommunicationAdapter() });
  const memory = new ExperienceMemoryService({ store });
  const app = Fastify();
  registerIntelligenceRoutes(app, {
    evaluation,
    planner: new AdaptivePlanner({ permissionCeiling: 'full' }),
    capabilityRegistry,
    teamOptimizer: new TeamOptimizer(),
    communication,
    memory,
  });
  await app.ready();
  t.after(async () => { evaluation.close(); await app.close(); store.close(); });

  const benchmarks = await app.inject({ method: 'GET', url: '/v1/benchmarks' });
  assert.equal(benchmarks.statusCode, 200);
  const benchmarkItems = benchmarks.json().items;
  assert.equal(benchmarkItems.find((item) => item.id === 'agent-us-deterministic-core')?.taskCount, 30);
  assert.equal(benchmarkItems.find((item) => item.id === 'agent-us-real-engineering')?.taskCount, 10);

  const plan = await app.inject({
    method: 'POST', url: '/v1/plans/validate',
    payload: {
      planVersion: 1,
      goal: 'route test',
      permissionMode: 'auto-safe',
      tasks: [{ taskKey: 'one', title: 'one', description: 'one', taskType: 'coding', expectedOutputs: ['x'], acceptance: { description: 'x', requiredEvidence: ['x'] }, dependencies: [], budget: { maxSteps: 1 }, sideEffects: [] }],
      budget: { maxSteps: 1 },
    },
  });
  assert.equal(plan.statusCode, 200);
  assert.equal(plan.json().planVersion, 1);

  const invalidMessage = await app.inject({ method: 'POST', url: '/v1/communication/messages', payload: { fromAgentId: 'a1', toAgentId: 'a2' } });
  assert.equal(invalidMessage.statusCode, 400);

  const sent = await app.inject({
    method: 'POST', url: '/v1/communication/messages',
    payload: { conversationId: 'c1', runId: 'r1', fromAgentId: 'a1', toAgentId: 'a2', kind: 'task_assignment', idempotencyKey: 'm1', payload: { task: 'one' } },
  });
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.json().status, 'created');
  const received = await app.inject({ method: 'POST', url: '/v1/communication/messages/receive', payload: { agentId: 'a2' } });
  assert.equal(received.statusCode, 200);
  assert.equal(received.json().message.status, 'delivered');

  const remembered = await app.inject({ method: 'POST', url: '/v1/memory/experience', payload: { projectId: 'p1', type: 'lesson', content: '[safe] use a bounded retry', key: 'retry', confidence: 0.8, verified: true } });
  assert.equal(remembered.statusCode, 200);
  assert.equal(remembered.json()[0].projectId, 'p1');
  const missingProject = await app.inject({ method: 'GET', url: '/v1/memory/experience' });
  assert.equal(missingProject.statusCode, 400);

  const memories = await app.inject({ method: 'GET', url: '/v1/memory/experience?projectId=p1&query=retry' });
  assert.equal(memories.statusCode, 200);
  assert.equal(memories.json().items.length, 1);

  const started = await app.inject({ method: 'POST', url: '/v1/evaluations', payload: { benchmarkId: BENCHMARK_ID, taskIds: ['code-generation-repair-01'] } });
  assert.equal(started.statusCode, 200);
  const runId = started.json().run.id;
  for (let i = 0; i < 30; i++) {
    const current = await app.inject({ method: 'GET', url: `/v1/evaluations/${runId}` });
    if (current.json().status === 'completed') {
      assert.equal(current.json().score.passed, 1);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const finalRun = await app.inject({ method: 'GET', url: `/v1/evaluations/${runId}` });
  assert.equal(finalRun.json().status, 'completed');
});


test('Store communication adapter persists envelopes, acknowledgements, conflicts, and is idempotent across reopen', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'agent-us-communication-'));
  const path = join(dir, 'store.sqlite');
  let store = new Store(path);
  t.after(async () => {
    try { if (store?.db?.isOpen) store.close(); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  });
  let bus = new CommunicationBus({ adapter: new StoreCommunicationAdapter({ store }), clock: () => 1_000, defaultTtlMs: 100_000 });
  const draft = { conversationId: 'persist-c', runId: 'persist-r', fromAgentId: 'parent', toAgentId: 'child', kind: 'task_assignment', idempotencyKey: 'persist-key', payload: { task: 'keep' } };
  const created = await bus.send(draft);
  const received = await bus.receive('child');
  assert.equal(received.messageId, created.message.messageId);
  const acked = await bus.ack(received.messageId, 'child');
  assert.equal(acked.status, 'acked');
  store.close();
  store = null;

  store = new Store(path);
  bus = new CommunicationBus({ adapter: new StoreCommunicationAdapter({ store }), clock: () => 2_000 });
  assert.equal((await bus.get(created.message.messageId)).status, 'acked');
  assert.equal((await bus.send(draft)).status, 'replayed');
  const conflict = await bus.send({ ...draft, payload: { task: 'different' } });
  assert.equal(conflict.status, 'conflict');
  assert.equal((await bus.listConflicts({ status: 'open' })).length, 1);
  assert.equal(await bus.get('missing-message'), null);
  assert.equal(await bus.ack('missing-message', 'child'), null);
});

test('evaluation traffic is recorded synthetic and excluded from production KPI aggregation', async () => {
  const store = new Store(':memory:');
  const evaluation = new EvaluationService({
    store,
    runtimeFactory: async ({ task, syntheticContext }) => {
      assert.equal(syntheticContext.isSynthetic, true);
      assert.equal(syntheticContext.trafficSource, 'eval');
      return { output: task.expected.output };
    },
    timeoutMs: 1_000,
  });
  try {
    const run = evaluation.start({ benchmarkId: BENCHMARK_ID, taskIds: ['code-generation-repair-01'] });
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = evaluation.getRun(run.id);
      if (current.status === 'completed' || current.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const result = evaluation.getRun(run.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.synthetic, true);
    const turns = store.db.prepare('SELECT trafficSource, isSynthetic FROM direct_turns').all();
    assert.equal(turns.length, 0, 'injected runner must not create production runtime turns');
    const sessions = store.db.prepare('SELECT trafficSource, isSynthetic FROM direct_sessions').all();
    assert.equal(sessions.length, 0);
  } finally {
    evaluation.close();
    store.close();
  }
});
