import { validateRunnerOptions, validateResult } from './schemas.js';
import { createBenchmarkDataset } from './dataset.js';
import { EvaluationRegistry } from './registry.js';
import { createDeterministicJudge } from './judge.js';
import { EvaluationRecorder } from './recorder.js';
import { scoreResults } from './scoring.js';
import { createFixtureWorkspace, removeFixtureWorkspace, retainFixtureWorkspace } from './fixtures.js';

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
  if (!runtimeFactory) return { handle: null, output: args.task.fixture?.output };
  const runtime = await runtimeFactory(args);
  if (typeof runtime === 'function') return { handle: runtime, output: runtime(args) };
  if (runtime?.runTask) return { handle: runtime, output: runtime.runTask(args) };
  if (runtime?.run) return { handle: runtime, output: runtime.run(args) };
  if (runtime?.execute) return { handle: runtime, output: runtime.execute(args) };
  // A runtimeFactory may itself be the injected runtime entry point and return
  // the task result directly. Keep that contract compatible with the method-
  // based adapter form above.
  if (runtime !== null && typeof runtime === 'object') return { handle: null, output: runtime };
  throw new TypeError('runtimeFactory must return a function, a result object, or an object with runTask/run/execute');
}

function normalizeRuntimeOutput(value) {
  if (!value || typeof value !== 'object') return { output: value, sessionId: null, turnId: null, artifacts: [], checkpoint: null };
  return {
    ...value,
    output: Object.hasOwn(value, 'output') ? value.output : value,
    sessionId: value.sessionId ?? null,
    turnId: value.turnId ?? null,
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
    checkpoint: value.checkpoint ?? null,
  };
}

async function drainRuntime(runtime, { reason, timeoutMs = 5_000 } = {}) {
  if (!runtime || typeof runtime !== 'object') return { drained: true, error: null };
  const waitForStop = runtime.waitForStop ?? runtime.drain;
  if (typeof waitForStop !== 'function') return { drained: false, error: 'runtime does not expose waitForStop/drain' };
  const drainPromise = Promise.resolve().then(() => waitForStop.call(runtime, { reason }));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return drainPromise.then(() => ({ drained: true, error: null }));
  let timer;
  try {
    const outcome = await Promise.race([
      drainPromise.then((value) => (value && typeof value === 'object' ? value : { drained: true, error: null })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ drained: false, error: 'runtime drain timeout' }), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return outcome && typeof outcome === 'object' ? outcome : { drained: true, error: null };
  } catch (error) {
    return { drained: false, error: String(error?.message ?? error).slice(0, 500) };
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    drainTimeoutMs = 5_000,
    lifecycle = null,
  } = {}) {
    validateRunnerOptions({ concurrency, timeoutMs, maxAttempts, budget });
    this.registry = registry;
    this.runtimeFactory = runtimeFactory;
    this.judge = judge;
    this.recorder = recorder;
    this.syntheticContextHook = syntheticContextHook;
    this.options = { concurrency, timeoutMs, maxAttempts, budget, retryDelayMs, drainTimeoutMs };
    this.lifecycle = lifecycle;
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
      let runtimeHandle = null;
      let runtimeDrain = null;
      let runtimeStarted = false;
      try {
        workspaceRoot = await createFixtureWorkspace(task);
        await this.lifecycle?.onAttemptStart?.({ task, attempt, workspaceRoot, context });
        const syntheticContext = {
          isSynthetic: true,
          source: 'evaluation',
          ...(await this.syntheticContextHook?.({ task, attempt, workspaceRoot, context, signal }) ?? {}),
        };
         const output = await withTimeout(
           async (runtimeSignal) => {
             const invoked = await invokeRuntime(this.runtimeFactory, {
               task, attempt, workspaceRoot, signal: runtimeSignal, context, syntheticContext,
             });
             runtimeHandle = invoked.handle;
              return normalizeRuntimeOutput(await invoked.output);
           },
          { timeoutMs: task.timeoutMs ?? opts.timeoutMs, signal },
        );
        const judgment = await this.judge({ task, output, context: { ...context, syntheticContext, workspaceRoot, attempt } });
        const result = {
          taskId: task.id, status: judgment.passed ? 'passed' : 'failed', passed: Boolean(judgment.passed),
          attempts: attempt, durationMs: Date.now() - started, output, judge: judgment,
        };
        validateResult(result);
        await this.lifecycle?.onAttemptEnd?.({ task, attempt, workspaceRoot, result });
        await this.recorder.record(result);
        return result;
      } catch (error) {
        lastError = error;
         if (isAbort(error) || signal?.aborted) {
            runtimeDrain = await drainRuntime(runtimeHandle, {
             reason: error?.code === 'E_EVAL_TIMEOUT' ? 'timeout' : 'cancelled',
             timeoutMs: opts.drainTimeoutMs ?? 5_000,
           });
          const status = error?.code === 'E_EVAL_TIMEOUT' || error?.name === 'TimeoutError' ? 'timeout' : 'cancelled';
            const result = { taskId: task.id, status, passed: false, attempts: attempt, durationMs: Date.now() - started, error: error.message, metadata: { runtimeDrained: runtimeDrain.drained, runtimeDrainError: runtimeDrain.error } };
          await this.lifecycle?.onAttemptEnd?.({ task, attempt, workspaceRoot, result });
          await this.recorder.record(result);
          return result;
        }
        if (attempt >= maxAttempts) break;
        await this.lifecycle?.onAttemptEnd?.({
          task,
          attempt,
          workspaceRoot,
          result: { taskId: task.id, status: 'failed', passed: false, attempts: attempt, durationMs: Date.now() - started, error: error?.message ?? 'evaluation attempt failed' },
        });
        await this.lifecycle?.onRetry?.({ task, attempt, nextAttempt: attempt + 1, workspaceRoot, error });
        if (opts.retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, opts.retryDelayMs));
       } finally {
         if (runtimeHandle && typeof runtimeHandle === 'object') {
           runtimeDrain ??= await drainRuntime(runtimeHandle, { reason: 'settled', timeoutMs: opts.drainTimeoutMs ?? 5_000 });
           if (!runtimeDrain.drained) retainFixtureWorkspace(workspaceRoot);
           else await removeFixtureWorkspace(workspaceRoot);
         } else {
           await removeFixtureWorkspace(workspaceRoot);
         }
      }
    }
    const result = { taskId: task.id, status: 'failed', passed: false, attempts: maxAttempts, durationMs: Date.now() - started, error: lastError?.message ?? 'evaluation failed' };
    await this.lifecycle?.onAttemptEnd?.({ task, attempt: maxAttempts, workspaceRoot: null, result });
    await this.recorder.record(result);
    return result;
  }
}

export function createEvaluationRunner(options) {
  return new EvaluationRunner(options);
}

