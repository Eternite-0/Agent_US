import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { BENCHMARK_DATASET, BENCHMARK_TASK_COUNT } from '../../src/evaluation/dataset.js';
import { EvaluationRegistry } from '../../src/evaluation/registry.js';
import { createDeterministicJudge } from '../../src/evaluation/judge.js';
import { EvaluationRecorder } from '../../src/evaluation/recorder.js';
import { createEvaluationRunner } from '../../src/evaluation/runner.js';
import { compareRegression } from '../../src/evaluation/regression.js';
import { scoreResults } from '../../src/evaluation/scoring.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('evaluation dataset exposes 30 deterministic local metadata tasks', () => {
  assert.equal(BENCHMARK_TASK_COUNT, 30);
  assert.equal(new Set(BENCHMARK_DATASET.map((task) => task.id)).size, 30);
  assert.ok(BENCHMARK_DATASET.every((task) => task.metadata.externalNetwork === false));
});

test('registry rejects duplicate ids and filters metadata tasks', () => {
  const registry = new EvaluationRegistry(BENCHMARK_DATASET);
  assert.equal(registry.size, 30);
  assert.equal(registry.list({ category: 'code-generation-repair' }).length, 8);
  assert.throws(() => registry.register(BENCHMARK_DATASET[0]), /Duplicate evaluation task/);
});

test('deterministic judge exact matches structured output before fallback', async () => {
  const judge = createDeterministicJudge({ fallback: () => ({ passed: true, score: 0.1 }) });
  const task = BENCHMARK_DATASET[0];
  const judged = await judge({ task, output: { output: task.expected.output } });
  assert.equal(judged.passed, true);
  assert.equal(judged.deterministic, true);
  const failed = await judge({ task, output: { output: { wrong: true } } });
  assert.equal(failed.passed, true);
  assert.equal(failed.score, 0.1);
});

test('runner injects isolated workspace and synthetic context, records a passing result', async () => {
  let seen = null;
  const recorder = new EvaluationRecorder();
  const task = BENCHMARK_DATASET[0];
  const runner = createEvaluationRunner({
    registry: new EvaluationRegistry([task]),
    recorder,
    syntheticContextHook: async (args) => ({ marker: 'hooked', attempt: args.attempt }),
    runtimeFactory: async ({ workspaceRoot, syntheticContext, task: current, signal }) => {
      seen = { workspaceRoot, syntheticContext, signalAborted: signal.aborted };
      const content = await readFile(`${workspaceRoot}/evaluation/input.json`, 'utf8');
      return { output: { ...current.expected.output }, inputFixturePresent: content.includes(current.expected.output.key) };
    },
  });
  const report = await runner.run();
  assert.equal(report.score.passed, 1);
  assert.equal(recorder.list().length, 1);
  assert.equal(seen.syntheticContext.isSynthetic, true);
  assert.equal(seen.syntheticContext.marker, 'hooked');
  assert.equal(seen.signalAborted, false);
  await assert.rejects(access(seen.workspaceRoot));
});

test('runner retries failures and enforces concurrency budget', async () => {
  let active = 0;
  let peak = 0;
  const calls = new Map();
  const tasks = BENCHMARK_DATASET.slice(0, 4);
  const runner = createEvaluationRunner({
    registry: new EvaluationRegistry(tasks),
    maxAttempts: 2,
    concurrency: 3,
    budget: { maxConcurrent: 2 },
    runtimeFactory: async ({ task }) => {
      active++;
      peak = Math.max(peak, active);
      await wait(8);
      active--;
      const count = (calls.get(task.id) ?? 0) + 1;
      calls.set(task.id, count);
      if (count === 1) throw new Error('retry-me');
      return { output: task.expected.output };
    },
  });
  const report = await runner.run();
  assert.equal(report.score.passed, 4);
  assert.equal(peak, 2);
  assert.deepEqual([...calls.values()], [2, 2, 2, 2]);
});

test('runner distinguishes timeout and cancellation', async () => {
  const task = BENCHMARK_DATASET[0];
  const timeoutRunner = createEvaluationRunner({
    registry: new EvaluationRegistry([task]),
    timeoutMs: 10,
    runtimeFactory: async ({ signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      });
      return { output: task.expected.output };
    },
  });
  assert.equal((await timeoutRunner.run()).results[0].status, 'timeout');

  const controller = new AbortController();
  const cancelRunner = createEvaluationRunner({
    registry: new EvaluationRegistry([task]),
    runtimeFactory: async ({ signal }) => {
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
      return { output: task.expected.output };
    },
  });
  const pending = cancelRunner.run({ signal: controller.signal });
  setTimeout(() => controller.abort('test-cancel'), 5);
  assert.equal((await pending).results[0].status, 'cancelled');
});

test('recorder persistence is injectable and regression scoring is deterministic', async () => {
  const persisted = [];
  const recorder = new EvaluationRecorder({ persist: async (result) => persisted.push(result.taskId) });
  await recorder.record({ taskId: 'abc-task', status: 'passed', passed: true, attempts: 1 });
  assert.deepEqual(persisted, ['abc-task']);
  assert.deepEqual(scoreResults([{ status: 'passed', attempts: 1, durationMs: 10 }, { status: 'timeout', attempts: 2, durationMs: 20 }]), {
    total: 2, passed: 1, failed: 0, cancelled: 0, timedOut: 1, attempts: 3, passRate: 0.5, meanDurationMs: 15, totalDurationMs: 30,
  });
  assert.equal(compareRegression({ passRate: 1, timedOut: 0, meanDurationMs: 1 }, { passRate: 0.5, timedOut: 1, meanDurationMs: 2 }).passed, false);
});
