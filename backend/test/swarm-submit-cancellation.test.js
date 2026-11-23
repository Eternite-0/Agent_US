import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { DirectSessionRepo } from '../src/runtime/session-repo.js';
import { DurableJobQueue } from '../src/durable/job-queue.js';
import { createLeaseGuard } from '../src/durable/lease-guard.js';
import { AdaptiveSwarmOrchestrator } from '../src/swarm/orchestrator.js';
import { ChildAgentManager } from '../src/swarm/child-lifecycle.js';
import { DynamicReplanner } from '../src/swarm/replan.js';
import { DynamicTaskPlanner } from '../src/swarm/planner.js';
import { SWARM_JOB_KINDS as jobs } from '../src/swarm/jobs.js';

function fixture(t, { adapter, worktreeIsolator } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const queue = new DurableJobQueue(store);
  const repo = new DirectSessionRepo({ store, getDefaultModel: () => 'worker', getWorkspaceRoot: () => null });
  const parent = repo.createSession();
  const candidates = Array.from({ length: 8 }, (_, i) => ({ id: `worker${i}`, model: `worker${i}`, estimatedTokens: 400 }));
  const router = { select: () => ({ model: 'worker0', provider: 'pool', profile: { id: 'worker', toolAllow: [] } }), modelRegistry: { list: () => candidates } };
  const childManager = new ChildAgentManager({ store, sessionRepo: repo, jobQueue: queue, worktreeIsolator, getDefaultModel: () => 'worker' });
  const runtime = new AdaptiveSwarmOrchestrator({ store, jobQueue: queue, childManager, router, planner: new DynamicTaskPlanner({ router, adapter }) });
  const handlers = {};
  runtime.registerOnWorker({ registerHandler: (kind, fn) => { handlers[kind] = fn; } });
  function execute(kind) {
    const job = queue.claim({ workerId: 'local-test', kinds: [kind] });
    assert.ok(job, kind);
    const leaseGuard = createLeaseGuard({ store, jobId: job.id, workerId: job.workerId, fence: job.fence, attempt: job.attempts, runId: job.taskId, nodeId: job.payload.nodeId });
    return Promise.resolve(handlers[kind](job, { signal: new AbortController().signal, leaseGuard })).then(() => queue.complete(job.id, job.fence));
  }
  const submit = (goal, opts = {}) => runtime.submitRun({ sessionId: parent.id, goal, maxConcurrency: 8, ...opts });
  return { store, queue, repo, childManager, runtime, execute, submit };
}

function planned(count, taskType = 'research') {
  return { async *stream() {
    const nodes = Array.from({ length: count }, (_, i) => ({ nodeKey: `part${i}`, objective: `Inspect part ${i}`, taskType, isolatedWorktree: taskType === 'implementation' }));
    yield { type: 'text-delta', text: JSON.stringify({ nodes, teamRationale: 'One lookup gives the requested source location.' }) };
    yield { type: 'usage', usage: { inputTokens: 300, outputTokens: 200 } };
  } };
}

test('submitRun without nodes persists one worker and the planner explanation', async (t) => {
  const { runtime, submit, execute } = fixture(t, { adapter: planned(1) });
  const { runId } = submit('Locate the entry point');
  assert.equal(runtime.getRun(runId).status, 'planning');
  assert.equal(runtime.getRun(runId).nodes.length, 0);
  await execute(jobs.PLAN);
  await execute(jobs.DEPENDENCY_RESOLVE);
  const run = runtime.getRun(runId);
  assert.equal(run.strategy.maxConcurrency, 8);
  assert.equal(run.nodes.length, 1);
  assert.equal(run.nodes[0].status, 'queued');
  assert.equal(run.strategy.plan.metadata.teamRationale, 'One lookup gives the requested source location.');
});

test('durable planner usage reduces the next wave and duplicate resolve cannot spend the balance again', async (t) => {
  const { runtime, execute, submit, queue } = fixture(t, { adapter: planned(4) });
  const { runId } = submit('Inspect four independent modules', { budget: { maxTotalTokens: 1600 } });
  await execute(jobs.PLAN);
  assert.equal(runtime.budgetLedger.getSnapshot(runId).remainingTokens, 1100);
  await execute(jobs.DEPENDENCY_RESOLVE);
  const run = runtime.getRun(runId);
  queue.enqueue({ kind: jobs.DEPENDENCY_RESOLVE, taskId: runId, sessionId: run.sessionId, payload: { runId } });
  await execute(jobs.DEPENDENCY_RESOLVE);
  assert.deepEqual(runtime.getRun(runId).nodes.map(n => n.status).sort(), ['queued', 'queued', 'ready', 'ready']);
});

test('cancelling the planner fences its reservation, late result and successor jobs across recovery', async (t) => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const { runtime, submit, execute, queue } = fixture(t, { adapter: { async *stream({ signal }) {
    entered.resolve(signal);
    await finish.promise;
    yield { type: 'text-delta', text: '{"nodes":[{"objective":"late"}]}' };
  } } });
  const { runId } = submit('Plan a change');
  const pending = execute(jobs.PLAN);
  const signal = await entered.promise;
  const result = await runtime.waitForRun(runId, { signal: AbortSignal.abort() });
  assert.equal(result.status, 'cancelled');
  assert.equal(signal.aborted, true);
  finish.resolve();
  await assert.rejects(pending);
  assert.equal(runtime.getRun(runId).nodes.length, 0);
  assert.equal(runtime.budgetLedger.getSnapshot(runId).reservedSteps, 0);
  assert.equal(queue.enqueue({ kind: jobs.DISPATCH, taskId: runId }), null);
  assert.deepEqual(runtime.recoverInterruptedRuns().errors, []);
  assert.equal(queue.claim(), null);
});

test('cancel during worktree acquisition finds the bound child and leaves a replacement handle intact', async (t) => {
  const acquiring = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const active = new Map();
  const worktreeIsolator = { active, acquire: async (_, opts) => { acquiring.resolve(opts); return finish.promise; } };
  const { runtime, submit, execute, repo, store, queue, childManager } = fixture(t, { worktreeIsolator, adapter: planned(1, 'implementation') });
  const { runId } = submit('Implement a change');
  await execute(jobs.PLAN);
  await execute(jobs.DEPENDENCY_RESOLVE);
  await execute(jobs.DISPATCH);
  const executing = execute(jobs.NODE_EXECUTE);
  const { sessionId } = await Promise.race([acquiring.promise, executing.then(() => assert.fail('child never acquired worktree'))]);
  assert.equal(runtime.getRun(runId).nodes[0].childSessionId, sessionId);
  runtime.cancelRun(runId);
  assert.equal(repo.getSession(sessionId).state, 'cancelled');
  const replacement = { leaseId: 'wt', path: 'replacement' };
  active.set('wt', replacement);
  let staleReleased = false;
  finish.resolve({ leaseId: 'wt', path: 'stale', release() { staleReleased = true; } });
  await assert.rejects(executing, { code: 'LEASE_LOST' });
  assert.equal(staleReleased, false);
  assert.equal(active.get('wt'), replacement);
  assert.equal(childManager.activeChildren.size, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM direct_turns WHERE sessionId=?').get(sessionId).n, 0);
  assert.deepEqual(runtime.recoverInterruptedRuns().errors, []);
  assert.equal(queue.claim(), null);
});

test('elapsed queue time survives recovery and prevents an expired job from starting', async (t) => {
  let calls = 0;
  const { runtime, submit, execute, store, queue } = fixture(t, { adapter: { async *stream() { calls++; } } });
  const zero = submit('No time left', { budget: { maxDurationMs: 0 } });
  assert.equal(zero.run.errorCode, 'BUDGET_DURATION_EXCEEDED');
  for (const recovery of [false, true]) {
    const { runId } = submit('Queued plan', { budget: { maxDurationMs: 60_000 } });
    store.db.prepare('UPDATE swarm_runs SET createdAt=createdAt-61000, updatedAt=? WHERE id=?').run(Date.now(), runId);
    if (recovery) {
      runtime.closeAll();
      assert.deepEqual(runtime.recoverInterruptedRuns().errors, []);
    } else {
      await assert.rejects(execute(jobs.PLAN), { code: 'LEASE_LOST' });
    }
    assert.equal(runtime.getRun(runId).errorCode, 'BUDGET_DURATION_EXCEEDED');
    assert.equal(queue.claim(), null);
    assert.throws(() => runtime.resumeRun(runId), { code: 'SWARM_RUN_CANCELLED' });
  }
  assert.equal(calls, 0);
});

test('deadline aborts an in-flight planner using time counted from submission', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const { runtime, submit, execute } = fixture(t, { adapter: { async *stream({ signal }) {
    entered.resolve(signal);
    await finish.promise;
  } } });
  const { runId } = submit('Plan slowly', { budget: { maxDurationMs: 1000 } });
  t.mock.timers.tick(850);
  const pending = execute(jobs.PLAN);
  const signal = await entered.promise;
  t.mock.timers.tick(149);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  assert.equal(runtime.getRun(runId).errorCode, 'BUDGET_DURATION_EXCEEDED');
  finish.resolve();
  await assert.rejects(pending);
});

test('offline fallback admits a scoped edit as one isolated writable worker within parent permissions', async (t) => {
  const { runtime, submit, execute } = fixture(t);
  for (const parentPermissionMode of ['auto-safe', 'read-only']) {
    const { runId } = submit('把 README.md 的标题改成 Demo', { parentPermissionMode });
    await execute(jobs.PLAN);
    await execute(jobs.DEPENDENCY_RESOLVE);
    const run = runtime.getRun(runId);
    assert.equal(run.nodes.length, 1);
    const [node] = run.nodes;
    assert.equal(node.taskType, 'implementation');
    assert.equal(node.isolationMode, 'worktree');
    assert.equal(node.permissionMode, parentPermissionMode);
    assert.equal(node.allowIsolationFallback, false);
    assert.ok(run.plan.metadata.teamRationale);
  }
});

test('explicit run shares eight admission slots between the initial DAG, materialized review and split replan', async (t) => {
  const { runtime, submit, execute, store, queue } = fixture(t);
  const listWorkers = runtime.router.modelRegistry.list;
  runtime.router.modelRegistry.list = () => [...listWorkers(), { id: 'reviewer', model: 'reviewer', role: 'reviewer' }];
  const { runId } = submit('Eight independent edits', { nodes: Array.from({ length: 8 }, (_, i) => ({
    nodeKey: `worker${i}`, taskType: 'implementation', isolatedWorktree: true, objective: `Edit module ${i}`,
  })) });
  const active = run => run.nodes.filter(n => ['queued', 'running'].includes(n.status)).length;
  await execute(jobs.DEPENDENCY_RESOLVE);
  let run = runtime.getRun(runId);
  assert.equal(run.nodes.length, 9);
  assert.equal(active(run), 8);
  assert.equal(run.nodes.find(n => n.taskType === 'review').status, 'pending');
  const failedNode = run.nodes.find(n => n.nodeKey === 'worker0');
  store.db.prepare("UPDATE swarm_nodes SET status='failed', attempts=2 WHERE id=?").run(failedNode.id);
  const replanner = new DynamicReplanner({ store, planner: runtime.planner, router: runtime.router, budgetLedger: runtime.budgetLedger });
  const outcome = await replanner.replan({ run, failedNode, errorCode: 'TEST_FAILURE' });
  assert.equal(outcome.strategy, 'split_subgraph');
  queue.enqueue({ kind: jobs.DEPENDENCY_RESOLVE, taskId: runId, sessionId: run.sessionId, payload: { runId } });
  await execute(jobs.DEPENDENCY_RESOLVE);
  run = runtime.getRun(runId);
  assert.equal(run.nodes.length, 11);
  assert.equal(active(run), 8);
  assert.ok(run.nodes.some(n => n.nodeKey.includes('__split') && n.status === 'queued'));
});
