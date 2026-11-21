import { validateRunnerOptions, validateResult } from './schemas.js';
import { createBenchmarkDataset } from './dataset.js';
import { EvaluationRegistry } from './registry.js';
import { createDeterministicJudge } from './judge.js';
import { EvaluationRecorder } from './recorder.js';
import { scoreResults } from './scoring.js';
import { createFixtureWorkspace, removeFixtureWorkspace } from './fixtures.js';

function abortError(reason = 'cancelled') {
  const error = new Error(String(reason));
  error.name = reason === 'timeout' ? 'TimeoutError' : 'AbortError';
  error.code = reason === 'timeout' ? 'E_EVAL_TIMEOUT' : 'E_EVAL_CANCELLED';
  return error;
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'E_EVAL_CANCELLED' || error?.code === 'E_EVAL_TIMEOUT' || error?.code === 'ABORT_ERR';
}

async function invokeRuntime(runtimeFactory, args) {
  if (!runtimeFactory) return { output: args.task.fixture?.output };
  const runtime = await runtimeFactory(args);
  if (typeof runtime === 'function') return runtime(args);
  if (runtime?.runTask) return runtime.runTask(args);
  if (runtime?.run) return runtime.run(args);
  if (runtime?.execute) return runtime.execute(args);
  // A runtimeFactory may itself be the injected runtime entry point and return
  // the task result directly. Keep that contract compatible with the method-
  // based adapter form above.
  if (runtime !== null && typeof runtime === 'object') return runtime;
  throw new TypeError('runtimeFactory must return a function, a result object, or an object with runTask/run/execute');
}

async function withTimeout(fn, { timeoutMs, signal }) {
  const controller = new AbortController();
  const signals = [controller.signal];
  if (signal) signals.push(signal);
  const combined = AbortSignal.any(signals);
  let timer = null;
  const work = Promise.resolve().then(() => fn(combined));
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Reject the timeout race before aborting the injected runtime. Some
      // runtimes reject synchronously from their abort handler; ordering the
      // rejection first preserves the externally observable timeout status.
      reject(abortError('timeout'));
      controller.abort('timeout');
    }, timeoutMs);
    timer.unref?.();
  });
  const cancelled = signal
    ? new Promise((_, reject) => {
        if (signal.aborted) return reject(abortError('cancelled'));
        signal.addEventListener('abort', () => reject(abortError('cancelled')), { once: true });
      })
    : null;
  try {
    return await Promise.race([work, timeout, ...(cancelled ? [cancelled] : [])]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort('settled');
  }
}

export class EvaluationRunner {
  constructor({
    registry = new EvaluationRegistry(createBenchmarkDataset()),
    runtimeFactory = null,
    judge = createDeterministicJudge(),
    recorder = new EvaluationRecorder(),
    syntheticContextHook = null,
    concurrency = 2,
    timeoutMs = 5_000,
    maxAttempts = 1,
    budget = {},
    retryDelayMs = 0,
  } = {}) {
    validateRunnerOptions({ concurrency, timeoutMs, maxAttempts, budget });
    this.registry = registry;
    this.runtimeFactory = runtimeFactory;
    this.judge = judge;
    this.recorder = recorder;
    this.syntheticContextHook = syntheticContextHook;
    this.options = { concurrency, timeoutMs, maxAttempts, budget, retryDelayMs };
  }

  async run({ ids = null, tasks = null, signal = undefined, context = {}, ...overrides } = {}) {
    const selected = tasks ?? (ids ? ids.map((id) => this.registry.require(id)) : this.registry.list());
    const opts = { ...this.options, ...overrides, budget: { ...this.options.budget, ...(overrides.budget ?? {}) } };
    const concurrency = Math.min(opts.concurrency, opts.budget.maxConcurrent ?? opts.concurrency, Math.max(1, selected.length || 1));
    const maxTasks = opts.budget.maxTasks ?? selected.length;
    const queue = selected.slice(0, maxTasks);
    const results = new Array(queue.length);
    let cursor = 0;
    const take = () => cursor < queue.length ? queue[cursor++] : null;

    const worker = async () => {
      while (true) {
        const task = take();
        if (!task) return;
        if (signal?.aborted) {
          results[queue.indexOf(task)] = this.#cancelled(task, 0, 'cancelled_before_start');
          continue;
        }
        const index = queue.indexOf(task);
        results[index] = await this.#runTask(task, { signal, context, opts });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    const finalResults = results.filter(Boolean);
    const report = { version: 1, results: finalResults, score: scoreResults(finalResults), startedAt: Date.now() };
    return report;
  }

  #cancelled(task, attempts, reason) {
    return {
      taskId: task.id, status: 'cancelled', passed: false, attempts: Math.max(1, attempts),
      durationMs: 0, judge: { passed: false, deterministic: true, reason }, error: reason,
    };
  }

  async #runTask(task, { signal, context, opts }) {
    const started = Date.now();
    const maxAttempts = Math.min(task.maxAttempts ?? opts.maxAttempts, opts.budget.maxAttempts ?? Infinity);
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) return this.#cancelled(task, attempt - 1, 'cancelled');
      let workspaceRoot = null;
      try {
        workspaceRoot = await createFixtureWorkspace(task);
        const syntheticContext = {
          isSynthetic: true,
          source: 'evaluation',
          ...(await this.syntheticContextHook?.({ task, attempt, workspaceRoot, context, signal }) ?? {}),
        };
        const output = await withTimeout(
          (runtimeSignal) => invokeRuntime(this.runtimeFactory, {
            task, attempt, workspaceRoot, signal: runtimeSignal, context, syntheticContext,
          }),
          { timeoutMs: task.timeoutMs ?? opts.timeoutMs, signal },
        );
        const judgment = await this.judge({ task, output, context: { ...context, syntheticContext, workspaceRoot, attempt } });
        const result = {
          taskId: task.id, status: judgment.passed ? 'passed' : 'failed', passed: Boolean(judgment.passed),
          attempts: attempt, durationMs: Date.now() - started, output, judge: judgment,
        };
        validateResult(result);
        await this.recorder.record(result);
        return result;
      } catch (error) {
        lastError = error;
        if (isAbort(error) || signal?.aborted) {
          const status = error?.code === 'E_EVAL_TIMEOUT' || error?.name === 'TimeoutError' ? 'timeout' : 'cancelled';
          const result = { taskId: task.id, status, passed: false, attempts: attempt, durationMs: Date.now() - started, error: error.message };
          await this.recorder.record(result);
          return result;
        }
        if (attempt >= maxAttempts) break;
        if (opts.retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, opts.retryDelayMs));
      } finally {
        await removeFixtureWorkspace(workspaceRoot);
      }
    }
    const result = { taskId: task.id, status: 'failed', passed: false, attempts: maxAttempts, durationMs: Date.now() - started, error: lastError?.message ?? 'evaluation failed' };
    await this.recorder.record(result);
    return result;
  }
}

export function createEvaluationRunner(options) {
  return new EvaluationRunner(options);
}

