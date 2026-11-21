import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

test('evaluation worker recovers a crashed run in a new Node process without reusing an attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-us-eval-crash-'));
  const dbPath = join(root, 'engine.sqlite');
  const store = new Store(dbPath);
  const task = BENCHMARK_DATASET[0];
  const service = new EvaluationService({
    store,
    runtimeFactory: async ({ task: current }) => ({ output: current.expected.output }),
    jobQueue: { enqueue: () => ({ id: 'persisted-evaluation-job' }) },
    timeoutMs: 1_000,
  });
  const created = service.start({ taskIds: [task.id], maxAttempts: 2, concurrency: 1 });
  const durableTaskId = `${created.id}:${task.id}`;
  const now = Date.now();
  const runRow = store.get('evaluation_runs', created.id);
  store.update('evaluation_runs', runRow, { status: 'running', startedAt: now, options: { model: null, concurrency: 1, timeoutMs: 1_000, maxAttempts: 2 } });
  store.db.prepare("UPDATE evaluation_tasks SET status='running', attempts=1, startedAt=?, updatedAt=? WHERE id=?")
    .run(now, now, durableTaskId);
  store.db.prepare(`INSERT INTO evaluation_attempts
    (id,evaluationTaskId,attempt,status,workspaceRoot,startedAt)
    VALUES(?,?,1,'running',NULL,?)`).run(`${durableTaskId}:attempt:1`, durableTaskId, now);
  store.db.prepare(`INSERT OR REPLACE INTO evaluation_checkpoints
    (id,evaluationTaskId,attempt,phase,stateJson,createdAt)
    VALUES(?,?,?,?,?,?)`).run(`${durableTaskId}:checkpoint:1`, durableTaskId, 1, 'running', '{}', now);
  store.close();

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Store } from ${JSON.stringify(new URL('../../src/store.js', import.meta.url).href)};
    import { EvaluationService } from ${JSON.stringify(new URL('../../src/evaluation/service.js', import.meta.url).href)};
    const store = new Store(process.argv[1]);
    const service = new EvaluationService({ store, runtimeFactory: async ({ task }) => ({ output: task.expected.output }), timeoutMs: 1000 });
    let handler;
    service.registerOnWorker({ registerHandler(kind, callback) { if (kind === 'evaluation_run') handler = callback; }, wake() {} });
    await handler({ taskId: process.argv[2], payload: { runId: process.argv[2] } });
    await service.close({ timeoutMs: 1000 });
    store.close();
  `, dbPath, created.id], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  try {
    assert.equal(child.status, 0, 'recovery worker process must exit successfully');
    const recoveredStore = new Store(dbPath);
    try {
      const recovered = recoveredStore.get('evaluation_runs', created.id);
      assert.equal(recovered.status, 'completed');
      assert.equal(recovered.results.length, 1);
      assert.equal(recovered.results[0].status, 'passed');
      assert.equal(recoveredStore.db.prepare('SELECT MAX(attempt) AS maxAttempt FROM evaluation_attempts WHERE evaluationTaskId=?').get(durableTaskId).maxAttempt, 2);
    } finally {
      recoveredStore.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

test('evaluation recovery preserves a passed task and resumes only the interrupted task within its attempt cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-us-eval-multi-recovery-'));
  const dbPath = join(root, 'engine.sqlite');
  const invocationPath = join(root, 'invocations.log');
  const store = new Store(dbPath);
  const [passedTask, interruptedTask] = BENCHMARK_DATASET;
  const service = new EvaluationService({
    store,
    runtimeFactory: async ({ task: current }) => ({ output: current.expected.output }),
    jobQueue: { enqueue: () => ({ id: 'persisted-evaluation-job' }) },
    timeoutMs: 1_000,
  });
  const created = service.start({ taskIds: [passedTask.id, interruptedTask.id], maxAttempts: 2, concurrency: 1 });
  const passedDurableId = `${created.id}:${passedTask.id}`;
  const interruptedDurableId = `${created.id}:${interruptedTask.id}`;
  const now = Date.now();
  const passedResult = {
    taskId: passedTask.id,
    status: 'passed',
    passed: true,
    attempts: 1,
    durationMs: 7,
    output: { output: passedTask.expected.output, sessionId: null, turnId: null, artifacts: [], checkpoint: null },
    judge: { passed: true, deterministic: true, reason: 'seeded_durable_result' },
  };
  const runRow = store.get('evaluation_runs', created.id);
  store.update('evaluation_runs', runRow, {
    status: 'running',
    startedAt: now,
    options: { model: null, concurrency: 1, timeoutMs: 1_000, maxAttempts: 2 },
    results: [],
  });
  store.db.prepare(`UPDATE evaluation_tasks
    SET status='passed', attempts=1, resultJson=?, finishedAt=?, updatedAt=? WHERE id=?`)
    .run(JSON.stringify(passedResult), now, now, passedDurableId);
  store.db.prepare(`INSERT INTO evaluation_attempts
    (id,evaluationTaskId,attempt,status,workspaceRoot,startedAt,finishedAt,resultJson)
    VALUES(?,?,1,'passed',NULL,?,?,?)`)
    .run(`${passedDurableId}:attempt:1`, passedDurableId, now, now, JSON.stringify(passedResult));
  store.db.prepare(`INSERT OR REPLACE INTO evaluation_checkpoints
    (id,evaluationTaskId,attempt,phase,stateJson,createdAt)
    VALUES(?,?,?,?,?,?)`).run(`${passedDurableId}:checkpoint:1`, passedDurableId, 1, 'passed', '{}', now);
  store.db.prepare(`UPDATE evaluation_tasks
    SET status='running', attempts=1, startedAt=?, updatedAt=? WHERE id=?`)
    .run(now, now, interruptedDurableId);
  store.db.prepare(`INSERT INTO evaluation_attempts
    (id,evaluationTaskId,attempt,status,workspaceRoot,startedAt)
    VALUES(?,?,1,'running',NULL,?)`)
    .run(`${interruptedDurableId}:attempt:1`, interruptedDurableId, now);
  store.db.prepare(`INSERT OR REPLACE INTO evaluation_checkpoints
    (id,evaluationTaskId,attempt,phase,stateJson,createdAt)
    VALUES(?,?,?,?,?,?)`).run(`${interruptedDurableId}:checkpoint:1`, interruptedDurableId, 1, 'running', '{}', now);
  store.close();

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { appendFileSync } from 'node:fs';
    import { Store } from ${JSON.stringify(new URL('../../src/store.js', import.meta.url).href)};
    import { EvaluationService } from ${JSON.stringify(new URL('../../src/evaluation/service.js', import.meta.url).href)};
    const store = new Store(process.argv[1]);
    const invocationPath = process.argv[3];
    const service = new EvaluationService({
      store,
      runtimeFactory: async ({ task }) => {
        appendFileSync(invocationPath, task.id + '\\n');
        return { output: task.expected.output };
      },
      timeoutMs: 1000,
    });
    let handler;
    service.registerOnWorker({ registerHandler(kind, callback) { if (kind === 'evaluation_run') handler = callback; }, wake() {} });
    await handler({ taskId: process.argv[2], payload: { runId: process.argv[2] } });
    await service.close({ timeoutMs: 1000 });
    store.close();
  `, dbPath, created.id, invocationPath], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  try {
    assert.equal(child.status, 0, `recovery worker process must exit successfully: ${child.stderr}`);
    const recoveredStore = new Store(dbPath);
    try {
      const recovered = recoveredStore.get('evaluation_runs', created.id);
      assert.equal(recovered.status, 'completed');
      assert.equal(recovered.results.length, 2);
      assert.deepEqual(recovered.results.find((result) => result.taskId === passedTask.id), passedResult);
      assert.equal(recovered.results.find((result) => result.taskId === interruptedTask.id)?.status, 'passed');
      assert.equal(recovered.results.find((result) => result.taskId === interruptedTask.id)?.attempts, 2);

      const invocations = readFileSync(invocationPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      assert.deepEqual(invocations, [interruptedTask.id], 'the passed task must not be executed again');
      assert.equal(recoveredStore.db.prepare('SELECT COUNT(*) AS count FROM evaluation_attempts WHERE evaluationTaskId=?').get(passedDurableId).count, 1);
      assert.equal(recoveredStore.db.prepare('SELECT COUNT(*) AS count FROM evaluation_attempts WHERE evaluationTaskId=?').get(interruptedDurableId).count, 2);
      assert.equal(recoveredStore.db.prepare('SELECT MAX(attempt) AS maxAttempt FROM evaluation_attempts WHERE evaluationTaskId=?').get(interruptedDurableId).maxAttempt, 2);
      assert.equal(recoveredStore.db.prepare('SELECT attempts FROM evaluation_tasks WHERE id=?').get(interruptedDurableId).attempts, 2);
      assert.ok(recovered.score);
      assert.equal(recovered.score.total, 2);
      assert.equal(recovered.score.passed, 2);
    } finally {
      recoveredStore.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
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

test('evaluation timeout retains the workspace when the runtime factory never yields a stoppable handle', async () => {
  const task = BENCHMARK_DATASET[0];
  let started = null;
  const runner = new EvaluationRunner({
    registry: { list: () => [task], require: () => task },
    concurrency: 1,
    timeoutMs: 25,
    drainTimeoutMs: 50,
    runtimeFactory: async () => new Promise(() => {}),
    lifecycle: {
      onAttemptStart: ({ workspaceRoot }) => { started = workspaceRoot; },
    },
  });

  const report = await runner.run();
  assert.equal(report.results[0].status, 'timeout');
  assert.equal(report.results[0].metadata.runtimeDrained, false);
  assert.match(report.results[0].metadata.runtimeDrainError, /handle unavailable/);
  assert.ok(started);
  await access(started);
  await rm(started, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});
