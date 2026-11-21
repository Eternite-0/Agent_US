import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { EvaluationRunner } from './runner.js';
import { EvaluationRecorder } from './recorder.js';
import { EvaluationRegistry } from './registry.js';
import { createBenchmarkDataset } from './dataset.js';
import { compareRegression } from './regression.js';
import { TRAFFIC_SOURCES, withTraceContext } from '../observability/trace.js';
import { redactSecrets } from '../envelope.js';

export const BENCHMARK_ID = 'agent-us-deterministic-core';
export const BENCHMARK_VERSION = '1.0.0';
export const DATASET_VERSION = '1.0.0';
const TERMINAL_TURN_STATES = new Set(['completed', 'failed', 'cancelled']);

function plainRun(record) {
  return structuredClone(record);
}

function safeError(error) {
  return redactSecrets(String(error?.message ?? error ?? 'evaluation failed')).slice(0, 1000);
}

function createDirectRuntimeAdapter(directAgent, { model = null } = {}) {
  if (!directAgent) throw new TypeError('Evaluation requires DirectAgentRuntime');
  return ({ task, workspaceRoot, signal, context }) => {
    let turnId = null;
    const run = withTraceContext({ trafficSource: TRAFFIC_SOURCES.EVAL, isSynthetic: true }, async () => {
      const session = directAgent.createSession({ title: `Evaluation · ${task.id}`, model: model || context.model || undefined, workspaceRoot, mode: 'direct', permissionMode: 'auto-safe', trafficSource: TRAFFIC_SOURCES.EVAL, isSynthetic: true });
      const started = directAgent.startTurn(session.id, { input: task.prompt, model: model || context.model || undefined, permissionMode: 'auto-safe', maxSteps: task.resourceBudget?.maxSteps ?? 12, trafficSource: TRAFFIC_SOURCES.EVAL, isSynthetic: true });
      turnId = started?.turn?.id;
      if (!turnId) throw new Error('DirectAgentRuntime did not create an evaluation turn');
      const cancel = () => { try { directAgent.cancelTurn(turnId); } catch { /* durable runtime records cancellation */ } };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          if (signal?.aborted) {
            cancel();
            try { await directAgent.waitForTurnTerminal?.(turnId, { timeoutMs: 5_000 }); } catch { /* runner records drain state */ }
            const error = new Error('Evaluation cancelled'); error.name = 'AbortError'; error.code = 'E_EVAL_CANCELLED'; throw error;
          }
          const current = directAgent.listTurns(session.id, { limit: 20 }).find((turn) => turn.id === turnId);
          if (current && TERMINAL_TURN_STATES.has(current.state)) {
            const messages = directAgent.listMessages(session.id, { after: 0, limit: 500 });
            const text = messages.filter((message) => message.turnId === turnId && message.role === 'assistant').map((message) => String(message.content ?? '')).filter(Boolean).join('\n');
            if (current.state !== 'completed') { const error = new Error(current.error || `Evaluation turn ${current.state}`); error.code = current.state === 'cancelled' ? 'E_EVAL_CANCELLED' : 'E_RUNTIME_TURN_FAILED'; if (current.state === 'cancelled') error.name = 'AbortError'; throw error; }
            return { output: text, sessionId: session.id, turnId, verdict: current.verdict ?? null, evidenceCount: Number(current.evidenceCount ?? 0) };
          }
          await delay(100, undefined, { signal });
        }
      } finally { signal?.removeEventListener('abort', cancel); }
    });
    return { run: () => run, waitForStop: async ({ reason = 'cancelled' } = {}) => { if (!turnId) return { drained: true, error: null }; try { await directAgent.waitForTurnTerminal?.(turnId, { timeoutMs: 5_000 }); return { drained: true, reason }; } catch (error) { return { drained: false, error: safeError(error) }; } } };
  };
}

export class EvaluationService {
  #controllers = new Map();
  #activeExecutions = new Map();

  constructor({ store, directAgent, runtimeFactory = null, jobQueue = null, maxConcurrency = 2, timeoutMs = 120_000 } = {}) {
    if (!store || typeof store.add !== 'function' || typeof store.list !== 'function') {
      throw new TypeError('EvaluationService requires Store');
    }
    this.store = store;
    this.directAgent = directAgent ?? null;
    this.registry = new EvaluationRegistry(createBenchmarkDataset());
    this.runtimeFactory = runtimeFactory;
    this.jobQueue = jobQueue;
    this.maxConcurrency = Math.min(4, Math.max(1, Number(maxConcurrency) || 2));
    this.timeoutMs = Math.min(600_000, Math.max(1_000, Number(timeoutMs) || 120_000));
  }

  registerOnWorker(recoveryWorker) {
    recoveryWorker?.registerHandler?.('evaluation_run', (job) => {
      const runId = String(job.taskId || job.payload?.runId || '');
      const run = this.getRun(runId);
      if (!run || ['completed', 'failed', 'cancelled', 'timeout'].includes(run.status)) return { skipped: true };
      const controller = this.#controllers.get(runId) ?? new AbortController();
      this.#controllers.set(runId, controller);
      const tasks = (run.taskIds ?? []).map((id) => this.registry.require(String(id)));
      const execution = this.execute(runId, tasks, run.options ?? {}, controller);
      this.#activeExecutions.set(runId, execution);
      void execution.then(() => {}, () => {}).finally(() => this.#activeExecutions.delete(runId));
      return execution;
    });
    recoveryWorker?.wake?.();
  }

  listBenchmarks() {
    const tasks = this.registry.list();
    return [{
      id: BENCHMARK_ID,
      title: 'Agent_US Deterministic Core Benchmark',
      version: BENCHMARK_VERSION,
      datasetVersion: DATASET_VERSION,
      taskCount: tasks.length,
      categories: [...new Set(tasks.map((task) => task.category))],
      description: 'Local, deterministic benchmark tasks. No network snapshots are used.',
      tasks: tasks.map(({ id, title, category, difficulty, tags }) => ({ id, title, category, difficulty, tags })),
    }];
  }

  listRuns({ benchmarkId = null, limit = 50 } = {}) {
    const rows = this.store.list('evaluation_runs', { limit: Math.min(200, Math.max(1, Number(limit) || 50)) });
    return rows
      .filter((run) => !benchmarkId || run.benchmarkId === benchmarkId)
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  }

  getRun(id) {
    return this.store.get('evaluation_runs', String(id));
  }

  start({ benchmarkId = BENCHMARK_ID, taskIds = null, model = null, concurrency = this.maxConcurrency, timeoutMs = this.timeoutMs, maxAttempts = 1 } = {}) {
    if (benchmarkId !== BENCHMARK_ID) {
      const error = new Error('Unknown benchmark');
      error.code = 'E_BENCHMARK_NOT_FOUND';
      error.status = 404;
      throw error;
    }
    if (!this.directAgent && !this.runtimeFactory) {
      const error = new Error('DirectAgentRuntime is unavailable');
      error.code = 'E_EVALUATION_RUNTIME_UNAVAILABLE';
      error.status = 503;
      throw error;
    }
    if (taskIds !== null && (!Array.isArray(taskIds) || taskIds.length < 1 || taskIds.length > 30)) {
      const error = new Error('taskIds must contain between 1 and 30 task IDs');
      error.code = 'E_EVALUATION_INVALID_REQUEST';
      error.status = 400;
      throw error;
    }
    const tasks = taskIds ? taskIds.map((id) => this.registry.require(String(id))) : this.registry.list();
    const runId = randomUUID();
    const now = Date.now();
    const run = this.store.add('evaluation_runs', {
      id: runId,
      benchmarkId,
      benchmarkVersion: BENCHMARK_VERSION,
      datasetVersion: DATASET_VERSION,
      status: 'queued',
      model: model ? String(model).slice(0, 200) : null,
      agentVersion: process.env.AGENT_US_VERSION || 'unknown',
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      score: null,
      results: [],
      error: null,
      taskIds: tasks.map((task) => task.id),
      synthetic: true,
      options: { model, concurrency, timeoutMs, maxAttempts },
    }, null, null, runId);
    const controller = new AbortController();
    this.#controllers.set(run.id, controller);
    const options = { model, concurrency, timeoutMs, maxAttempts };
    this.#update(run.id, { options });
    if (this.jobQueue?.enqueue) {
      const queued = this.jobQueue.enqueue({ kind: 'evaluation_run', taskId: run.id, payload: { runId: run.id }, idempotencyKey: `evaluation:${run.id}`, maxAttempts: 3 });
      if (!queued) {
        const execution = this.execute(run.id, tasks, options, controller);
        this.#activeExecutions.set(run.id, execution);
        void execution.then(() => {}, () => {}).finally(() => this.#activeExecutions.delete(run.id));
      }
    } else {
      const execution = this.execute(run.id, tasks, options, controller);
      this.#activeExecutions.set(run.id, execution);
      void execution.then(() => {}, () => {}).finally(() => this.#activeExecutions.delete(run.id));
    }
    return plainRun(run);
  }

  cancel(id) {
    const key = String(id);
    const run = this.getRun(key);
    if (!run || ['completed', 'failed', 'cancelled', 'timeout'].includes(run.status)) return run ?? null;
    const controller = this.#controllers.get(key);
    controller?.abort('cancelled by user');
    this.jobQueue?.cancelByTask?.(key);
    if (run.status === 'queued') return this.#update(key, { status: 'cancelled', finishedAt: Date.now() });
    return this.#update(key, { cancelRequestedAt: Date.now() });
  }

  async execute(runId, tasks, options, controller) {
    try {
      this.#update(runId, { status: 'running', startedAt: Date.now() });
      const run = this.getRun(runId);
      const recorder = new EvaluationRecorder({
        persist: async (result) => {
          const latest = this.getRun(runId);
          this.#update(runId, { results: [...(latest.results ?? []), result] });
        },
      });
      const runtimeFactory = this.runtimeFactory ?? createDirectRuntimeAdapter(this.directAgent, { model: options.model });
      const runner = new EvaluationRunner({
        runtimeFactory,
        recorder,
        concurrency: Math.min(this.maxConcurrency, Math.max(1, Number(options.concurrency) || this.maxConcurrency)),
        timeoutMs: Math.min(this.timeoutMs, Math.max(1_000, Number(options.timeoutMs) || this.timeoutMs)),
        maxAttempts: Math.min(3, Math.max(1, Number(options.maxAttempts) || 1)),
        budget: { maxConcurrent: this.maxConcurrency, maxTasks: tasks.length },
        syntheticContextHook: async () => ({
          trafficSource: TRAFFIC_SOURCES.EVAL,
          isSynthetic: true,
          benchmarkId: run.benchmarkId,
          evaluationRunId: run.id,
        }),
      });
      const report = await runner.run({ tasks, signal: controller.signal, context: { model: options.model, runId } });
      const terminalStatus = controller.signal.aborted
        ? 'cancelled'
        : report.results.some((result) => result.status === 'timeout') && report.results.every((result) => result.status === 'timeout' || result.status === 'cancelled')
          ? 'timeout'
          : 'completed';
      this.#update(runId, {
        status: terminalStatus,
        finishedAt: Date.now(),
        score: report.score,
        results: report.results,
        error: null,
      });
    } catch (error) {
      this.#update(runId, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        finishedAt: Date.now(),
        error: safeError(error),
      });
    } finally {
      this.#controllers.delete(runId);
    }
  }

  #update(id, patch) {
    const current = this.store.get('evaluation_runs', id);
    return this.store.update('evaluation_runs', current, patch);
  }

  async close({ timeoutMs = 30_000 } = {}) {
    if (!this.store?.db?.isOpen) return { drained: this.#activeExecutions.size === 0 };
    const activeRuns = this.listRuns({ limit: 200 }).filter((run) => ['queued', 'running'].includes(run.status));
    for (const run of activeRuns) {
      this.#controllers.get(run.id)?.abort('service shutdown');
      this.jobQueue?.cancelByTask?.(run.id);
      if (run.status === 'queued') this.#update(run.id, { status: 'cancelled', finishedAt: Date.now(), cancelRequestedAt: Date.now() });
    }
    const pending = [...this.#activeExecutions.values()];
    if (pending.length) await Promise.race([Promise.allSettled(pending), delay(Math.max(1, Number(timeoutMs) || 30_000))]);
    this.#controllers.clear();
    return { drained: this.#activeExecutions.size === 0 };
  }
}

export { createDirectRuntimeAdapter };





