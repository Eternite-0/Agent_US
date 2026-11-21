import test from 'node:test';
import assert from 'node:assert/strict';
import { access, rm } from 'node:fs/promises';

import { EvaluationRunner } from '../../src/evaluation/runner.js';
import { EvaluationService } from '../../src/evaluation/service.js';
import { BENCHMARK_DATASET } from '../../src/evaluation/dataset.js';
import { Store } from '../../src/store.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRun(service, runId, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = service.getRun(runId);
    if (predicate(run)) return run;
    await wait(10);
  }
  throw new Error(`evaluation run did not reach the expected state within ${timeoutMs}ms`);
}

function countForRun(store, table, runId) {
  const statements = {
    evaluation_tasks: 'SELECT COUNT(*) AS count FROM evaluation_tasks WHERE runId=?',
    evaluation_attempts: `
      SELECT COUNT(*) AS count
      FROM evaluation_attempts a
      JOIN evaluation_tasks t ON t.id=a.evaluationTaskId
      WHERE t.runId=?`,
    evaluation_checkpoints: `
      SELECT COUNT(*) AS count
      FROM evaluation_checkpoints c
      JOIN evaluation_tasks t ON t.id=c.evaluationTaskId
      WHERE t.runId=?`,
    evaluation_artifacts: `
      SELECT COUNT(*) AS count
      FROM evaluation_artifacts a
      JOIN evaluation_tasks t ON t.id=a.evaluationTaskId
      WHERE t.runId=?`,
    evaluation_judgements: `
      SELECT COUNT(*) AS count
      FROM evaluation_judgements j
      JOIN evaluation_tasks t ON t.id=j.evaluationTaskId
      WHERE t.runId=?`,
    evaluation_budgets: 'SELECT COUNT(*) AS count FROM evaluation_budgets WHERE runId=?',
  };
  const sql = statements[table];
  if (!sql) throw new Error(`unknown evaluation lifecycle table: ${table}`);
  return Number(store.db.prepare(sql).get(runId).count);
}

function createRuntime(task, { onStart = null, drain = null } = {}) {
  return {
    run: async ({ signal, workspaceRoot }) => {
      onStart?.({ signal, workspaceRoot });
      return new Promise((resolve, reject) => {
        const abort = () => {
          const error = Object.assign(new Error('runtime stopped'), { name: 'AbortError' });
          reject(error);
        };
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        // The promise is intentionally held until the runtime is cancelled or timed out.
        void task;
        void resolve;
      });
    },
    waitForStop: async ({ reason } = {}) => drain?.(reason) ?? { drained: true, error: null },
  };
}

test('evaluation service persists the durable task lifecycle for a completed run', async (t) => {
  const store = new Store(':memory:');
  const task = BENCHMARK_DATASET[0];
  const service = new EvaluationService({
    store,
    runtimeFactory: async ({ task: current }) => ({
      output: current.expected.output,
      artifacts: [{ kind: 'result', manifest: { taskId: current.id }, content: { verified: true } }],
    }),
    timeoutMs: 1_000,
  });
  t.after(async () => {
    await service.close({ timeoutMs: 500 });
    store.close();
  });

  const created = service.start({ taskIds: [task.id], maxAttempts: 1, concurrency: 1 });
  const completed = await waitForRun(service, created.id, (run) => run?.status === 'completed');

  assert.equal(completed.results.length, 1);
  assert.equal(completed.results[0].status, 'passed');

  const counts = Object.fromEntries([
    'evaluation_tasks',
    'evaluation_attempts',
    'evaluation_checkpoints',
    'evaluation_artifacts',
    'evaluation_judgements',
    'evaluation_budgets',
  ].map((table) => [table, countForRun(store, table, created.id)]));

  // This is the durable lifecycle contract. The current service only persists
  // evaluation_runs, so this assertion intentionally exposes the missing
  // Task/Attempt/Checkpoint/Artifact/Budget/Judgement integration.
  assert.deepEqual(counts, {
    evaluation_tasks: 1,
    evaluation_attempts: 1,
    evaluation_checkpoints: 1,
    evaluation_artifacts: 1,
    evaluation_judgements: 1,
    evaluation_budgets: 1,
  });
});

test('evaluation cancellation drains the runtime before deleting its temporary workspace', async () => {
  const task = BENCHMARK_DATASET[0];
  const controller = new AbortController();
  let started = null;
  let drainReason = null;
  let drained = false;

  const runner = new EvaluationRunner({
    registry: { list: () => [task], require: () => task },
    concurrency: 1,
    timeoutMs: 1_000,
    runtimeFactory: async () => createRuntime(task, {
      onStart: (details) => {
        started = details;
        setTimeout(() => controller.abort('test cancellation'), 10).unref?.();
      },
      drain: async (reason) => {
        drainReason = reason;
        drained = true;
        return { drained: true, error: null };
      },
    }),
  });

  const report = await runner.run({ signal: controller.signal });
  assert.equal(report.results[0].status, 'cancelled');
  assert.equal(report.results[0].metadata.runtimeDrained, true);
  assert.equal(drainReason, 'cancelled');
  assert.equal(drained, true);
  assert.ok(started?.workspaceRoot);
  await assert.rejects(access(started.workspaceRoot), /ENOENT/);
});

test('evaluation timeout retains the workspace when runtime drain is not confirmed', async () => {
  const task = BENCHMARK_DATASET[0];
  let started = null;
  let drainReason = null;

  const runner = new EvaluationRunner({
    registry: { list: () => [task], require: () => task },
    concurrency: 1,
    timeoutMs: 25,
    drainTimeoutMs: 50,
    runtimeFactory: async () => createRuntime(task, {
      onStart: (details) => { started = details; },
      drain: async (reason) => {
        drainReason = reason;
        return { drained: false, error: 'runtime still owns workspace' };
      },
    }),
  });

  const report = await runner.run();
  assert.equal(report.results[0].status, 'timeout');
  assert.equal(report.results[0].metadata.runtimeDrained, false);
  assert.equal(report.results[0].metadata.runtimeDrainError, 'runtime still owns workspace');
  assert.equal(drainReason, 'timeout');
  assert.ok(started?.workspaceRoot);
  await access(started.workspaceRoot);

  // The retention is deliberate, but this test owns the temporary directory
  // and must clean it after observing the safety behavior.
  await rm(started.workspaceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});
