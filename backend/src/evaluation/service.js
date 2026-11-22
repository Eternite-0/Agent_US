import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { EvaluationRunner } from './runner.js';
import { EvaluationRecorder } from './recorder.js';
import { EvaluationRegistry } from './registry.js';
import { createBenchmarkDataset, createRealEngineeringDataset } from './dataset.js';
import { compareRegression } from './regression.js';
import { TRAFFIC_SOURCES, withTraceContext } from '../observability/trace.js';
import { redactSecrets } from '../envelope.js';
import { scoreResults } from './scoring.js';

export const BENCHMARK_ID = 'agent-us-deterministic-core';
export const BENCHMARK_VERSION = '1.0.0';
export const DATASET_VERSION = '1.0.0';
export const REAL_ENGINEERING_BENCHMARK_ID = 'agent-us-real-engineering';
export const REAL_ENGINEERING_BENCHMARK_VERSION = '1.0.0';
export const REAL_ENGINEERING_DATASET_VERSION = '1.0.0';
const TERMINAL_TURN_STATES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_EVALUATION_STATUSES = new Set(['passed', 'failed', 'cancelled', 'timeout']);

function hydrateEvaluationRun(run) {
  if (!run || typeof run !== 'object') return run ?? null;
  return {
    ...run,
    projectId: run.projectId ?? run.evaluationProjectId ?? null,
  };
}

function plainRun(record) {
  return hydrateEvaluationRun(structuredClone(record));
}

function safeError(error) {
  return redactSecrets(String(error?.message ?? error ?? 'evaluation failed')).slice(0, 1000);
}

function safeJson(value, fallback = null) {
  try {
    const text = redactSecrets(JSON.stringify(value ?? null));
    return text.length > 200_000 ? text.slice(0, 200_000) : text;
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function positiveAttemptLimit(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function terminalEvaluationStatus(status) {
  return TERMINAL_EVALUATION_STATUSES.has(String(status));
}

function durableTaskId(runId, taskId) {
  return `${String(runId)}:${String(taskId)}`;
}

function deriveMeasuredCapabilities(results = [], score = {}) {
  const valid = results.filter((r) => r?.taskId && ['passed', 'failed', 'timeout', 'cancelled'].includes(r.status));
  const passRate = Number(
    score?.passRate ??
      (valid.length
        ? valid.filter((r) => r.status === 'passed' && r.passed === true).length / valid.length
        : 0),
  );
  const rateFor = (regex) => {
    const subset = valid.filter((r) => regex.test(String(r.taskId)));
    if (!subset.length) return passRate;
    return subset.filter((r) => r.status === 'passed' && r.passed === true).length / subset.length;
  };
  const avgLatencyMs = Number(
    score?.meanDurationMs ??
      (valid.length ? valid.reduce((sum, r) => sum + Number(r.durationMs || 0), 0) / valid.length : 0),
  );
  const speedBase = Math.max(0.05, Math.min(1, 1 - avgLatencyMs / 60_000));
  const speed = Number(((passRate > 0 ? 0.2 : 0) + 0.8 * speedBase * Math.max(0.2, passRate)).toFixed(4));
  const round4 = (v) => Number(Math.max(0, Math.min(1, Number(v) || 0)).toFixed(4));
  return {
    coding: round4(rateFor(/code-generation|multi-file-refactor|real-multi-file-feature|real-bug-fix|real-refactor|real-tests|real-api-compat|real-data-processing|real-recovery|real-multi-agent/i)),
    reasoning: round4(rateFor(/code-generation|unfamiliar-codebase|real-security-audit|real-recovery|real-bug-fix|real-refactor/i)),
    research: round4(rateFor(/unfamiliar-codebase|network-research|real-codebase-analysis|real-security-audit/i)),
    planning: round4(rateFor(/multi-file-refactor|long-task-recovery|multi-agent|real-refactor|real-recovery|real-multi-agent/i)),
    speed,
    contextCapacity: round4(valid.length ? 0.4 + 0.6 * passRate : 0),
    multimodal: 0,
    toolCompatibility: round4(rateFor(/real-|multi-agent|recovery/i)),
  };
}

function createDirectRuntimeAdapter(directAgent, { model = null } = {}) {
  if (!directAgent) throw new TypeError('Evaluation requires DirectAgentRuntime');
  return ({ task, workspaceRoot, signal, context }) => {
    let turnId = null;
    const evalPermissionMode =
      task.metadata?.requiresWorkspaceMutation === true ? 'full-access' : 'auto-safe';
    const evalToolDeny =
      task.metadata?.externalNetwork === false ? ['web_fetch', 'web_search'] : null;
    const run = withTraceContext({ trafficSource: TRAFFIC_SOURCES.EVAL, isSynthetic: true }, async () => {
      const session = directAgent.createSession({
        title: `Evaluation · ${task.id}`,
        model: model || context.model || undefined,
        workspaceRoot,
        mode: 'direct',
        permissionMode: evalPermissionMode,
        ...(evalToolDeny ? { toolDeny: evalToolDeny } : {}),
        trafficSource: TRAFFIC_SOURCES.EVAL,
        isSynthetic: true,
      });
      const started = directAgent.startTurn(session.id, {
        input: task.prompt,
        model: model || context.model || undefined,
        permissionMode: evalPermissionMode,
        maxSteps: task.resourceBudget?.maxSteps ?? task.metadata?.resourceBudget?.maxSteps ?? 16,
        trafficSource: TRAFFIC_SOURCES.EVAL,
        isSynthetic: true,
      });
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

  constructor({ store, directAgent, runtimeFactory = null, jobQueue = null, judge = null, maxConcurrency = 2, timeoutMs = 120_000, memory = null, capabilityRegistry = null } = {}) {
    if (!store || typeof store.add !== 'function' || typeof store.list !== 'function') {
      throw new TypeError('EvaluationService requires Store');
    }
    this.store = store;
    this.directAgent = directAgent ?? null;
    this.registry = new EvaluationRegistry([
      ...createBenchmarkDataset(),
      ...createRealEngineeringDataset(),
    ]);
    this.runtimeFactory = runtimeFactory;
    this.jobQueue = jobQueue;
    this.judge = typeof judge === 'function' ? judge : null;
    this.memory = memory;
    this.capabilityRegistry = capabilityRegistry;
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
      const durableTasks = this.#listDurableTasks(runId);
      const durableByTask = new Map(durableTasks.map((task) => [String(task.taskId), task]));
      const taskPlans = (run.taskIds ?? []).map((id) => {
        const taskId = String(id);
        const durable = durableByTask.get(taskId);
        const evaluationTaskId = durable?.id ?? durableTaskId(runId, taskId);
        const attemptRow = this.store.db.prepare(`
          SELECT MAX(attempt) AS maxAttempt
          FROM evaluation_attempts
          WHERE evaluationTaskId=?
        `).get(evaluationTaskId);
        const existingAttempts = Math.max(
          Number(durable?.attempts ?? 0),
          Number(attemptRow?.maxAttempt ?? 0),
        );
        const maxAttempts = positiveAttemptLimit(
          durable?.maxAttempts,
          positiveAttemptLimit(run.options?.maxAttempts, 1),
        );
        const storedResult = terminalEvaluationStatus(durable?.status)
          ? parseJson(durable?.resultJson)
          : null;
        const task = this.registry.require(taskId);

        // A passed durable task is authoritative. It is deliberately excluded
        // from the recovery queue, even when the process died before the run
        // row was updated with its result.
        if (durable?.status === 'passed') {
          return { taskId, durable, storedResult, task, runnable: false };
        }

        // Timeout and cancellation are terminal task outcomes in the runner;
        // they must not be silently retried by a worker restart. Ordinary
        // failures may still have remaining attempts.
        if (durable?.status === 'timeout' || durable?.status === 'cancelled') {
          return { taskId, durable, storedResult, task, runnable: false };
        }

        const remainingAttempts = Math.max(0, maxAttempts - existingAttempts);
        if (remainingAttempts === 0) {
          return { taskId, durable, storedResult, task, runnable: false, exhausted: true };
        }
        return {
          taskId,
          durable,
          storedResult,
          task: {
            ...task,
            // EvaluationRunner treats maxAttempts as the number of attempts
            // available in this execution. The offset keeps attempt IDs
            // monotonic while the remaining count enforces the durable cap.
            maxAttempts: remainingAttempts,
            attemptOffset: existingAttempts,
          },
          runnable: true,
        };
      });
      const tasks = taskPlans.filter((plan) => plan.runnable).map((plan) => plan.task);
      const recoveredResults = taskPlans
        .filter((plan) => plan.storedResult)
        .map((plan) => plan.storedResult);
      if (recoveredResults.length) {
        const merged = this.#mergeResults(runId, recoveredResults);
        this.#update(runId, { results: merged, score: scoreResults(merged) });
      }
      if (!tasks.length) {
        const latest = this.getRun(runId);
        const results = this.#mergeResults(runId, latest?.results ?? []);
        const complete = (run.taskIds ?? []).every((id) => results.some((result) => String(result.taskId) === String(id)));
        this.#update(runId, {
          status: complete ? 'completed' : 'failed',
          finishedAt: Date.now(),
          score: scoreResults(results),
          results,
          error: complete ? null : 'evaluation recovery has no durable result for an exhausted task',
        });
        return { skipped: true, completed: true };
      }
      const execution = this.execute(runId, tasks, run.options ?? {}, controller);
      this.#activeExecutions.set(runId, execution);
      void execution.then(() => {}, () => {}).finally(() => this.#activeExecutions.delete(runId));
      return execution;
    });
    recoveryWorker?.wake?.();
  }

  listBenchmarks() {
    const benchmarks = [
      {
        id: BENCHMARK_ID,
        title: 'Agent_US Deterministic Core Benchmark',
        version: BENCHMARK_VERSION,
        datasetVersion: DATASET_VERSION,
        tasks: createBenchmarkDataset(),
        description: 'Local deterministic smoke tasks. No network snapshots are used.',
      },
      {
        id: REAL_ENGINEERING_BENCHMARK_ID,
        title: 'Agent_US Real Software Engineering Benchmark',
        version: REAL_ENGINEERING_BENCHMARK_VERSION,
        datasetVersion: REAL_ENGINEERING_DATASET_VERSION,
        tasks: createRealEngineeringDataset(),
        description: 'Isolated multi-file engineering fixtures with real file edits, tests, Git diff evidence, and deterministic independent verification.',
      },
    ];
    return benchmarks.map(({ tasks, ...benchmark }) => ({
      ...benchmark,
      taskCount: tasks.length,
      categories: [...new Set(tasks.map((task) => task.category))],
      tasks: tasks.map(({ id, title, category, difficulty, tags }) => ({ id, title, category, difficulty, tags })),
    }));
  }

  listRuns({ benchmarkId = null, limit = 50 } = {}) {
    const rows = this.store.list('evaluation_runs', { limit: Math.min(200, Math.max(1, Number(limit) || 50)) });
    return rows
      .map(hydrateEvaluationRun)
      .filter((run) => !benchmarkId || run.benchmarkId === benchmarkId)
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  }

  getRun(id) {
    return hydrateEvaluationRun(this.store.get('evaluation_runs', String(id)));
  }

  start({ benchmarkId = BENCHMARK_ID, taskIds = null, model = null, projectId = null, concurrency = this.maxConcurrency, timeoutMs = this.timeoutMs, maxAttempts = 1 } = {}) {
    const benchmark = this.listBenchmarks().find((item) => item.id === benchmarkId);
    if (!benchmark) {
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
    const benchmarkTaskIds = new Set(benchmark.tasks.map((task) => task.id));
    const selectedTaskIds = taskIds ?? [...benchmarkTaskIds];
    if (selectedTaskIds.some((id) => !benchmarkTaskIds.has(String(id)))) {
      const error = new Error('taskIds must belong to the selected benchmark');
      error.code = 'E_EVALUATION_TASK_NOT_IN_BENCHMARK';
      error.status = 400;
      throw error;
    }
    const tasks = selectedTaskIds.map((id) => this.registry.require(String(id)));
    const runId = randomUUID();
    const now = Date.now();
    const resolvedProjectId = String(projectId ?? benchmarkId).slice(0, 500);
    const run = this.store.add('evaluation_runs', {
      id: runId,
      benchmarkId,
      benchmarkVersion: benchmark.version,
      datasetVersion: benchmark.datasetVersion,
      status: 'queued',
      model: model ? String(model).slice(0, 200) : null,
      projectId: resolvedProjectId,
      evaluationProjectId: resolvedProjectId,
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
    this.#ensureDurableRun(this.getRun(run.id), tasks, options);
    if (this.jobQueue?.enqueue) {
      let queued = null;
      try {
        queued = this.jobQueue.enqueue({ kind: 'evaluation_run', taskId: run.id, payload: { runId: run.id }, idempotencyKey: `evaluation:${run.id}`, maxAttempts: 3 });
      } catch (error) {
        this.#update(run.id, { status: 'failed', finishedAt: Date.now(), error: safeError(error), errorCode: 'E_EVALUATION_ENQUEUE_FAILED' });
      }
      if (!queued && this.getRun(run.id).status === 'queued') {
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
      this.#ensureDurableRun(run, tasks, options);
      const runtimeFactory = this.runtimeFactory ?? createDirectRuntimeAdapter(this.directAgent, { model: options.model });
      const runner = new EvaluationRunner({
        runtimeFactory,
        ...(this.judge ? { judge: this.judge } : {}),
        recorder,
        concurrency: Math.min(this.maxConcurrency, Math.max(1, Number(options.concurrency) || this.maxConcurrency)),
        timeoutMs: Math.min(this.timeoutMs, Math.max(1_000, Number(options.timeoutMs) || this.timeoutMs)),
        maxAttempts: Math.min(3, Math.max(1, Number(options.maxAttempts) || 1)),
        budget: { maxConcurrent: this.maxConcurrency, maxTasks: tasks.length },
        lifecycle: {
          onAttemptStart: async ({ task, attempt, workspaceRoot }) => {
            this.#recordAttemptStart(runId, task, attempt, workspaceRoot);
          },
          onAttemptEnd: async ({ task, attempt, workspaceRoot, result }) => {
            this.#recordAttemptEnd(runId, task, attempt, workspaceRoot, result);
          },
        },
        syntheticContextHook: async () => ({
          trafficSource: TRAFFIC_SOURCES.EVAL,
          isSynthetic: true,
          benchmarkId: run.benchmarkId,
          evaluationRunId: run.id,
        }),
      });
      const report = await runner.run({ tasks, signal: controller.signal, context: { model: options.model, runId } });
      const previousResults = Array.isArray(run.results) ? run.results : [];
      const mergedByTask = new Map(previousResults.map((result) => [String(result.taskId), result]));
      for (const result of report.results) mergedByTask.set(String(result.taskId), result);
      const mergedResults = [...mergedByTask.values()];
      const mergedReport = { ...report, results: mergedResults, score: scoreResults(mergedResults) };
      const terminalStatus = controller.signal.aborted
        ? 'cancelled'
        : report.results.some((result) => result.status === 'timeout') && mergedReport.results.every((result) => result.status === 'timeout' || result.status === 'cancelled')
          ? 'timeout'
          : 'completed';
      this.#update(runId, {
        status: terminalStatus,
        finishedAt: Date.now(),
        score: mergedReport.score,
        results: mergedReport.results,
        error: null,
      });
      const finalRun = this.getRun(runId);
      this.#recordTrustedOutcomes(finalRun, mergedReport);
      if (finalRun.model && finalRun.status === 'completed' && mergedReport.score?.total > 0) {
        try {
          const measuredCaps = deriveMeasuredCapabilities(mergedReport.results, mergedReport.score);
          const avgLatencyMs = Math.round(Number(mergedReport.score.meanDurationMs ?? 0));
          const evidenceRefs = mergedReport.results
            .filter((result) => result?.taskId && ['passed', 'failed', 'timeout', 'cancelled'].includes(result.status))
            .map((result) => `evaluation:${finalRun.id}:${result.taskId}`);
          if (evidenceRefs.length > 0) {
            this.capabilityRegistry?.recordMeasuredFromEvaluation?.(
              {
                id: finalRun.model,
                capabilities: measuredCaps,
                metrics: {
                  passRate: mergedReport.score.passRate,
                  passed: mergedReport.score.passed,
                  failed: mergedReport.score.failed,
                  total: mergedReport.score.total,
                  avgLatencyMs,
                },
              },
              {
                evaluationRunId: finalRun.id,
                evidenceRefs,
                taskIds: mergedReport.results.map((result) => result.taskId),
              },
            );
          }
        } catch {
          // Capability updates are advisory and cannot alter the durable evaluation result.
        }
      }
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

  #mergeResults(runId, incomingResults = []) {
    const run = this.getRun(runId);
    const mergedByTask = new Map();
    for (const result of Array.isArray(run?.results) ? run.results : []) {
      if (result?.taskId) mergedByTask.set(String(result.taskId), result);
    }
    for (const result of Array.isArray(incomingResults) ? incomingResults : []) {
      if (result?.taskId) mergedByTask.set(String(result.taskId), result);
    }
    const order = Array.isArray(run?.taskIds) ? run.taskIds.map(String) : [];
    return [
      ...order.filter((taskId) => mergedByTask.has(taskId)).map((taskId) => mergedByTask.get(taskId)),
      ...[...mergedByTask.entries()]
        .filter(([taskId]) => !order.includes(taskId))
        .map(([, result]) => result),
    ];
  }

  #listDurableTasks(runId) {
    return this.store.db.prepare('SELECT * FROM evaluation_tasks WHERE runId=? ORDER BY createdAt ASC').all(String(runId));
  }

  #ensureDurableRun(run, tasks, options) {
    const now = Date.now();
    this.store.tx(() => {
      this.store.db.prepare(`INSERT OR IGNORE INTO evaluation_budgets(runId,maxTasks,maxAttempts,maxConcurrent,maxDurationMs,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?)`).run(run.id, tasks.length, options.maxAttempts, options.concurrency, options.timeoutMs, now, now);
      for (const task of tasks) {
        this.store.db.prepare(`INSERT OR IGNORE INTO evaluation_tasks
          (id,runId,taskId,status,attempts,maxAttempts,createdAt,updatedAt)
          VALUES(?,?,?,'queued',0,?,?,?)`).run(durableTaskId(run.id, task.id), run.id, task.id, task.maxAttempts ?? options.maxAttempts, now, now);
      }
    });
  }

  #recordAttemptStart(runId, task, attempt, workspaceRoot) {
    const taskId = durableTaskId(runId, task.id);
    const now = Date.now();
    this.store.tx(() => {
      this.store.db.prepare(`UPDATE evaluation_tasks SET status='running', attempts=?, workspaceRoot=?, startedAt=COALESCE(startedAt,?), updatedAt=? WHERE id=?`)
        .run(attempt, workspaceRoot, now, now, taskId);
      this.store.db.prepare(`INSERT OR IGNORE INTO evaluation_attempts
        (id,evaluationTaskId,attempt,status,workspaceRoot,startedAt)
        VALUES(?,?,?,'running',?,?)`).run(`${taskId}:attempt:${attempt}`, taskId, attempt, workspaceRoot, now);
      this.store.db.prepare(`INSERT OR REPLACE INTO evaluation_checkpoints(id,evaluationTaskId,attempt,phase,stateJson,createdAt)
        VALUES(?,?,?,?,?,?)`).run(`${taskId}:checkpoint:${attempt}`, taskId, attempt, 'started', JSON.stringify({ workspaceRoot }), now);
    });
  }

  #recordAttemptEnd(runId, task, attempt, workspaceRoot, result) {
    const taskId = durableTaskId(runId, task.id);
    const status = String(result.status);
    const now = Date.now();
    const output = result.output ?? null;
    const judge = result.judge ?? null;
    const artifacts = Array.isArray(output?.artifacts) ? output.artifacts : [];
    this.store.tx(() => {
      this.store.db.prepare(`UPDATE evaluation_tasks SET status=?, finishedAt=?, resultJson=?, errorCode=?, errorMessage=?, updatedAt=? WHERE id=?`)
        .run(status, now, safeJson(result), result.error?.code ?? null, safeError(result.error ?? result.errorMessage ?? ''), now, taskId);
      this.store.db.prepare(`UPDATE evaluation_attempts SET status=?, finishedAt=?, resultJson=?, runtimeSessionId=?, runtimeTurnId=?, errorCode=?, errorMessage=? WHERE evaluationTaskId=? AND attempt=?`)
        .run(status, now, safeJson(result), output?.sessionId ?? null, output?.turnId ?? null, result.error?.code ?? null, safeError(result.error ?? result.errorMessage ?? ''), taskId, attempt);
      this.store.db.prepare(`INSERT OR REPLACE INTO evaluation_checkpoints(id,evaluationTaskId,attempt,phase,stateJson,createdAt)
        VALUES(?,?,?,?,?,?)`).run(`${taskId}:checkpoint:${attempt}`, taskId, attempt, status, safeJson({ status, workspaceRoot, runtimeDrained: result.metadata?.runtimeDrained ?? null }), now);
      if (judge) this.store.db.prepare(`INSERT OR REPLACE INTO evaluation_judgements(id,evaluationTaskId,attempt,judgeType,rubricVersion,passed,confidence,evidenceJson,rationale,createdAt)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(`${taskId}:judgement:${attempt}`, taskId, attempt, judge.deterministic ? 'deterministic' : 'model', judge.rubricVersion ?? null, judge.passed == null ? null : (judge.passed ? 1 : 0), judge.confidence ?? null, safeJson(judge.evidence ?? judge), String(judge.reason ?? '').slice(0, 2000), now);
      for (let index = 0; index < artifacts.length; index += 1) {
        const artifact = artifacts[index];
        this.store.db.prepare(`INSERT OR REPLACE INTO evaluation_artifacts(id,evaluationTaskId,attempt,kind,sha256,manifestJson,contentJson,createdAt)
          VALUES(?,?,?,?,?,?,?,?)`).run(`${taskId}:artifact:${attempt}:${index}`, taskId, attempt, String(artifact.kind ?? 'result'), artifact.sha256 ?? null, safeJson(artifact.manifest ?? null), safeJson(artifact.content ?? null), now);
      }
    });
  }

  #recordTrustedOutcomes(run, report) {
    if (run.status !== 'completed' || !report?.score || report.score.passed !== report.score.total || !this.memory) return;
    const verifier = this.memory.createTrustedVerifier?.();
    const runProjectId = run.projectId ?? run.evaluationProjectId ?? run.benchmarkId;
    for (const result of report.results ?? []) {
      if (result.status !== 'passed' || !result.judge?.deterministic) continue;
      let memory;
      try {
        memory = this.memory.remember({
          projectId: runProjectId,
          type: 'lesson',
          content: `Evaluation task ${result.taskId} passed deterministic verification.`,
          source: 'evaluation',
        }, { projectId: runProjectId, source: 'evaluation' });
      } catch {
        continue;
      }
      const item = Array.isArray(memory) ? memory[0] : memory;
      if (!item || !verifier) continue;
      try {
        verifier({
          projectId: runProjectId,
          id: item.id,
          sourceTaskId: result.taskId,
          evaluationRunId: run.id,
          evidence: { projectId: runProjectId, sourceTaskId: result.taskId, evaluationRunId: run.id, score: report.score, evidenceRef: `evaluation:${run.id}:${result.taskId}` },
        });
      } catch {
        // A failed trust grant must not change the evaluation terminal state.
      }
    }
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





