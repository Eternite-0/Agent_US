import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/store.js';
import { BENCHMARK_DATASET } from '../../src/evaluation/dataset.js';
import { EvaluationService } from '../../src/evaluation/service.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRun(service, runId, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = service.getRun(runId);
    if (predicate(run)) return run;
    await wait(10);
  }
  throw new Error(`evaluation run did not reach the expected state within ${timeoutMs}ms`);
}

function setup(options = {}) {
  const store = new Store(':memory:');
  const service = new EvaluationService({
    store,
    runtimeFactory: async ({ task }) => ({ output: task.expected.output }),
    timeoutMs: 1_000,
    ...options,
  });
  return { store, service };
}

test('evaluation service exposes separate deterministic and real-engineering benchmark versions', () => {
  const { store, service } = setup();
  try {
    const benchmarks = service.listBenchmarks();
    assert.equal(benchmarks.find((item) => item.id === 'agent-us-deterministic-core')?.taskCount, 30);
    assert.equal(benchmarks.find((item) => item.id === 'agent-us-real-engineering')?.taskCount, 10);
    assert.throws(() => service.start({ benchmarkId: 'agent-us-real-engineering', taskIds: ['code-generation-repair-01'] }), /belong to the selected benchmark/);
  } finally {
    store.close();
  }
});

test('evaluation service falls back to direct execution if durable enqueue is unavailable', async (t) => {
  const jobQueue = { enqueue: () => null };
  const { store, service } = setup({ jobQueue });
  t.after(async () => { await service.close({ timeoutMs: 500 }); store.close(); });

  const created = service.start({ taskIds: [BENCHMARK_DATASET[0].id] });
  const completed = await waitForRun(service, created.id, (run) => run?.status === 'completed');

  assert.equal(completed.results.length, 1);
  assert.equal(completed.results[0].status, 'passed');
});

test('evaluation worker registration wakes persisted work and executes it through the same service', async (t) => {
  const queued = [];
  const jobQueue = { enqueue: (job) => { queued.push(job); return { id: 'durable-job' }; } };
  const { store, service } = setup({ jobQueue });
  t.after(async () => { await service.close({ timeoutMs: 500 }); store.close(); });

  const created = service.start({ taskIds: [BENCHMARK_DATASET[0].id] });
  assert.equal(service.getRun(created.id).status, 'queued');
  assert.equal(queued.length, 1);

  let handler = null;
  let wakeCalls = 0;
  service.registerOnWorker({
    registerHandler(kind, callback) {
      assert.equal(kind, 'evaluation_run');
      handler = callback;
    },
    wake() { wakeCalls += 1; },
  });
  assert.equal(wakeCalls, 1);
  assert.equal(typeof handler, 'function');
  await handler({ taskId: created.id, payload: { runId: created.id } });

  const completed = service.getRun(created.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.results[0].status, 'passed');
});

test('evaluation close cancels active runtime and waits for its drain confirmation', async (t) => {
  let sawAbort = false;
  let resolveStopped;
  let resolveStarted;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const { store, service } = setup({
    runtimeFactory: ({ task, signal }) => ({
      run: () => {
        resolveStarted();
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            resolveStopped();
            resolve({ output: task.expected.output });
          }, { once: true });
        });
      },
      waitForStop: async () => { await stopped; return { drained: true }; },
    }),
  });
  t.after(async () => { await service.close({ timeoutMs: 500 }); store.close(); });

  const created = service.start({ taskIds: [BENCHMARK_DATASET[0].id] });
  await started;
  const reportPromise = service.close({ timeoutMs: 1_000 });
  await wait(20);
  const report = await reportPromise;

  assert.equal(sawAbort, true);
  assert.equal(report.drained, true);
  assert.equal(service.getRun(created.id).status, 'cancelled');
  assert.equal(service.getRun(created.id).results[0].status, 'cancelled');
});

test('createDirectRuntimeAdapter grants isolated full-access without network for mutating offline benchmarks and auto-safe for smoke tasks', async () => {
  const { createDirectRuntimeAdapter } = await import('../../src/evaluation/service.js');
  const { createRealEngineeringDataset } = await import('../../src/evaluation/dataset.js');

  const recordedCalls = [];
  const fakeDirectAgent = {
    createSession(opts) {
      recordedCalls.push({ kind: 'createSession', opts });
      return { id: `sess-${recordedCalls.length}` };
    },
    startTurn(sessionId, opts) {
      recordedCalls.push({ kind: 'startTurn', sessionId, opts });
      return { turn: { id: `turn-${recordedCalls.length}` } };
    },
    listTurns() {
      return [{ id: 'turn-2', state: 'completed', verdict: null, evidenceCount: 0 }, { id: 'turn-4', state: 'completed', verdict: null, evidenceCount: 0 }];
    },
    listMessages() {
      return [];
    },
    cancelTurn() {},
  };

  const adapter = createDirectRuntimeAdapter(fakeDirectAgent, { model: 'test-model' });
  const engTask = createRealEngineeringDataset()[0];
  const engHandle = adapter({ task: engTask, workspaceRoot: '/tmp/ws-eng', context: {} });
  await engHandle.run();

  assert.equal(recordedCalls[0].opts.permissionMode, 'full-access');
  assert.equal(recordedCalls[0].opts.sandboxProfile, 'benchmark');
  assert.ok(recordedCalls[0].opts.sandbox);
  assert.deepEqual(recordedCalls[0].opts.toolDeny, ['web_fetch', 'web_search', 'start_process']);
  assert.equal(recordedCalls[1].opts.permissionMode, 'full-access');
  assert.equal(recordedCalls[1].opts.maxSteps, engTask.metadata.resourceBudget.maxSteps);
  assert.ok(recordedCalls[1].opts.maxSteps > 16, 'complex engineering tasks should use complexity-derived step budget');
  assert.equal(recordedCalls[1].opts.finalVerificationReserve, engTask.metadata.resourceBudget.finalVerificationReserve);

  const smokeTask = BENCHMARK_DATASET[0];
  const smokeHandle = adapter({ task: smokeTask, workspaceRoot: '/tmp/ws-smoke', context: {} });
  await smokeHandle.run();

  assert.equal(recordedCalls[2].opts.permissionMode, 'auto-safe');
  assert.equal(recordedCalls[2].opts.sandboxProfile, 'benchmark');
  assert.ok(recordedCalls[2].opts.sandbox);
  assert.deepEqual(recordedCalls[2].opts.toolDeny, ['web_fetch', 'web_search', 'start_process']);
  assert.equal(recordedCalls[3].opts.permissionMode, 'auto-safe');
});
