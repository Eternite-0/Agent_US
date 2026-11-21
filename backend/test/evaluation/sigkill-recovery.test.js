import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Store } from '../../src/store.js';

const storeModuleUrl = new URL('../../src/store.js', import.meta.url).href;
const serviceModuleUrl = new URL('../../src/evaluation/service.js', import.meta.url).href;
const datasetModuleUrl = new URL('../../src/evaluation/dataset.js', import.meta.url).href;
const queueModuleUrl = new URL('../../src/durable/job-queue.js', import.meta.url).href;
const recoveryModuleUrl = new URL('../../src/durable/recovery.js', import.meta.url).href;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readEvents(path) {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForEvent(path, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = readEvents(path).find(predicate);
    if (event) return event;
    await wait(20);
  }
  throw new Error(`evaluation SIGKILL harness did not observe the expected event within ${timeoutMs}ms`);
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`child process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function spawnEvaluationWorker({ mode, dbPath, eventsPath, runId = '', passedTaskId, interruptedTaskId }) {
  const source = `
    import { appendFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    import { Store } from ${JSON.stringify(storeModuleUrl)};
    import { EvaluationService } from ${JSON.stringify(serviceModuleUrl)};
    import { BENCHMARK_DATASET } from ${JSON.stringify(datasetModuleUrl)};
    import { DurableJobQueue } from ${JSON.stringify(queueModuleUrl)};
    import { RecoveryWorker } from ${JSON.stringify(recoveryModuleUrl)};

    const [workerMode, databasePath, eventPath, requestedRunId, passedId, interruptedId] = process.argv.slice(1);
    const write = (type, details = {}) => appendFileSync(eventPath, JSON.stringify({ type, mode: workerMode, pid: process.pid, at: Date.now(), ...details }) + '\\n');
    const taskById = new Map(BENCHMARK_DATASET.map((task) => [task.id, task]));
    const checkpointStore = { loadLatest: () => null };
    const reconciler = { inspectInterruptedTurn: () => ({ needsReconciliation: false }) };
    const keepAlive = setInterval(() => {}, 1_000);

    let store = null;
    let worker = null;
    let service = null;
    try {
      store = new Store(databasePath);
      const jobQueue = new DurableJobQueue(store, { defaultLeaseMs: 5_000 });
      const runtimeFactory = async ({ task, workspaceRoot }) => ({
        run: async () => {
          if (workerMode === 'live' && task.id === passedId) {
            write('task-complete', { taskId: task.id });
            return { output: task.expected.output };
          }
          if (workerMode === 'live' && task.id === interruptedId) {
            write('runtime-start', { taskId: task.id, workspaceRoot });
            return new Promise(() => {});
          }
          write('runtime-invoked', { taskId: task.id, workspaceRoot });
          return { output: task.expected.output };
        },
        waitForStop: async ({ reason } = {}) => {
          write('runtime-drain', { taskId: task.id, reason, drained: true });
          return { drained: true, error: null };
        },
      });
      service = new EvaluationService({
        store,
        runtimeFactory,
        jobQueue,
        timeoutMs: 60_000,
        maxConcurrency: 1,
      });
      worker = new RecoveryWorker({
        store,
        jobQueue,
        checkpointStore,
        reconciler,
        eventRouter: null,
        slots: 1,
        leaseMs: 5_000,
      });
      service.registerOnWorker(worker);
      worker.start({ recover: false });

      if (workerMode === 'live') {
        const run = service.start({
          taskIds: [passedId, interruptedId],
          concurrency: 1,
          maxAttempts: 2,
          timeoutMs: 60_000,
        });
        write('run-created', { runId: run.id, taskIds: run.taskIds });
        // The parent test terminates this process while the second task owns a
        // live runtime. No cleanup path is allowed to run after SIGKILL.
        await new Promise(() => {});
      } else if (workerMode === 'recover') {
        if (!requestedRunId) throw new Error('recovery worker requires a run id');
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const run = service.getRun(requestedRunId);
          if (run && ['completed', 'failed', 'cancelled', 'timeout'].includes(run.status)) {
            write('run-terminal', { runId: requestedRunId, status: run.status, results: run.results });
            break;
          }
          await delay(20);
        }
        const recovered = service.getRun(requestedRunId);
        if (!recovered || recovered.status !== 'completed') {
          throw new Error('evaluation RecoveryWorker did not complete the recovered run');
        }
        write('recovery-complete', { runId: requestedRunId, status: recovered.status });
        await worker.stop();
        await service.close({ timeoutMs: 2_000 });
        clearInterval(keepAlive);
        store.close();
      } else {
        throw new Error('unknown worker mode');
      }
    } catch (error) {
      try { write('worker-error', { message: String(error?.message ?? error) }); } catch {}
      try { await worker?.stop?.(); } catch {}
      try { await service?.close?.({ timeoutMs: 500 }); } catch {}
      try { store?.close?.(); } catch {}
      clearInterval(keepAlive);
      process.exitCode = 1;
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, mode, dbPath, eventsPath, runId, passedTaskId, interruptedTaskId], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.debugStderr = () => stderr;
  return child;
}

test('evaluation survives a real child-process SIGKILL with RecoveryWorker fencing and workspace retention', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-us-eval-sigkill-'));
  const dbPath = join(root, 'evaluation.sqlite');
  const eventsPath = join(root, 'events.ndjson');
  const [passedTask, interruptedTask] = [
    'code-generation-repair-01',
    'code-generation-repair-02',
  ];
  let live = null;
  let recovery = null;

  t.after(async () => {
    for (const child of [live, recovery]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch {}
        try { await waitForExit(child, 2_000); } catch {}
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });

  live = spawnEvaluationWorker({
    mode: 'live',
    dbPath,
    eventsPath,
    passedTaskId: passedTask,
    interruptedTaskId: interruptedTask,
  });
  const started = await waitForEvent(eventsPath, (event) => event.mode === 'live' && event.type === 'runtime-start' && event.taskId === interruptedTask);
  const runCreated = await waitForEvent(eventsPath, (event) => event.mode === 'live' && event.type === 'run-created');

  const runningStore = new Store(dbPath);
  let interruptedAttempt;
  let passedRow;
  let evaluationJob;
  try {
    const taskRows = runningStore.db.prepare('SELECT * FROM evaluation_tasks WHERE runId=? ORDER BY taskId').all(runCreated.runId);
    passedRow = taskRows.find((row) => row.taskId === passedTask);
    const interruptedRow = taskRows.find((row) => row.taskId === interruptedTask);
    interruptedAttempt = runningStore.db.prepare('SELECT * FROM evaluation_attempts WHERE evaluationTaskId=? AND attempt=1').get(interruptedRow.id);
    evaluationJob = runningStore.db.prepare("SELECT * FROM runtime_jobs WHERE kind='evaluation_run' AND taskId=?").get(runCreated.runId);
    assert.equal(passedRow.status, 'passed', 'the task completed before the crash must already be durable');
    assert.equal(passedRow.attempts, 1);
    assert.equal(interruptedRow.status, 'running');
    assert.equal(interruptedRow.attempts, 1);
    assert.equal(interruptedAttempt.status, 'running');
    assert.equal(evaluationJob.status, 'active');
    assert.equal(evaluationJob.attempts, 1);
    assert.ok(interruptedAttempt.workspaceRoot);
    await access(interruptedAttempt.workspaceRoot);
  } finally {
    runningStore.close();
  }

  const killed = live.kill('SIGKILL');
  assert.equal(killed, true, 'the live evaluation worker must accept SIGKILL');
  const liveExit = await waitForExit(live, 10_000);
  assert.ok(liveExit.code !== null || liveExit.signal !== null, 'the live worker must actually exit after SIGKILL');
  assert.equal(readEvents(eventsPath).some((event) => event.mode === 'live' && event.type === 'runtime-drain' && event.taskId === interruptedTask), false, 'SIGKILL must not claim that the interrupted runtime drained');
  await access(interruptedAttempt.workspaceRoot);

  recovery = spawnEvaluationWorker({
    mode: 'recover',
    dbPath,
    eventsPath,
    runId: runCreated.runId,
    passedTaskId: passedTask,
    interruptedTaskId: interruptedTask,
  });
  const recoveryExit = await waitForExit(recovery, 20_000);
  assert.equal(recoveryExit.code, 0, `RecoveryWorker child failed: ${recovery.debugStderr()}`);

  const events = readEvents(eventsPath);
  const recoveryInvocations = events.filter((event) => event.mode === 'recover' && event.type === 'runtime-invoked');
  assert.deepEqual(recoveryInvocations.map((event) => event.taskId), [interruptedTask], 'the completed task must not be executed again after SIGKILL');
  assert.ok(events.some((event) => event.mode === 'recover' && event.type === 'runtime-drain' && event.drained === true), 'the recovered runtime must confirm drain before its workspace is deleted');

  const recoveredStore = new Store(dbPath);
  try {
    const recovered = recoveredStore.get('evaluation_runs', runCreated.runId);
    const durableTasks = recoveredStore.db.prepare('SELECT * FROM evaluation_tasks WHERE runId=? ORDER BY taskId').all(runCreated.runId);
    const interruptedRow = durableTasks.find((row) => row.taskId === interruptedTask);
    const attempts = recoveredStore.db.prepare('SELECT attempt,status,workspaceRoot FROM evaluation_attempts WHERE evaluationTaskId=? ORDER BY attempt').all(interruptedRow.id);
    const job = recoveredStore.db.prepare("SELECT status,attempts FROM runtime_jobs WHERE kind='evaluation_run' AND taskId=?").get(runCreated.runId);
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.results.length, 2);
    assert.equal(recovered.results.find((result) => result.taskId === passedTask).status, 'passed');
    assert.equal(recovered.results.find((result) => result.taskId === interruptedTask).status, 'passed');
    assert.deepEqual(attempts.map(({ attempt, status }) => ({ attempt, status })), [
      { attempt: 1, status: 'running' },
      { attempt: 2, status: 'passed' },
    ], 'recovery must advance the attempt fence instead of reusing attempt 1');
    assert.equal(job.status, 'done');
    assert.equal(job.attempts, 2, 'the durable evaluation job must be reclaimed under a new lease attempt');
    assert.equal(interruptedRow.attempts, 2);
    await access(interruptedAttempt.workspaceRoot);
    await assert.rejects(access(attempts[1].workspaceRoot), /ENOENT/, 'a drained recovery runtime may delete only its own workspace');
  } finally {
    recoveredStore.close();
  }
});
