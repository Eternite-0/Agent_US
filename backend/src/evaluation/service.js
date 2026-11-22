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
import { estimateTaskBudget, queryHistoricalTaskMetrics } from '../planning/budget-estimator.js';

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

function isFullResultPass(result) {
  return Boolean(result && result.status === 'passed' && result.passed === true);
}

function hasEngineeringEvidence(result) {
  const ev = result?.judge?.evidence;
  return Boolean(
    ev &&
      (ev.implementationPassed !== undefined ||
        ev.testsPassed !== undefined ||
        ev.evidenceCompliant !== undefined),
  );
}

function isResultBudgetExhausted(result) {
  return Boolean(
    result?.errorCode === 'STEP_BUDGET_EXHAUSTED' ||
      result?.telemetry?.errorCode === 'STEP_BUDGET_EXHAUSTED' ||
      /STEP_BUDGET/i.test(String(result?.error ?? result?.judge?.reason ?? '')),
  );
}

function roundMetric4(value) {
  return Number(Math.max(0, Math.min(1, Number(value) || 0)).toFixed(4));
}

export function deriveLayeredCapabilities(results = [], score = {}) {
  const valid = results.filter(
    (r) => r?.taskId && ['passed', 'failed', 'timeout', 'cancelled'].includes(r.status),
  );
  const fullAcceptanceRate = Number(
    score?.passRate ?? (valid.length ? valid.filter(isFullResultPass).length / valid.length : 0),
  );
  const implOk = (r) => Boolean(r.judge?.evidence?.implementationPassed ?? isFullResultPass(r));
  const testOk = (r) =>
    Boolean(r.judge?.evidence?.testsPassed ?? r.judge?.evidence?.checks?.tests ?? isFullResultPass(r));
  const evidenceOk = (r) => Boolean(r.judge?.evidence?.evidenceCompliant ?? isFullResultPass(r));

  const implementationRate = valid.length ? valid.filter(implOk).length / valid.length : 0;
  const testPassRate = valid.length ? valid.filter(testOk).length / valid.length : 0;
  const evidenceComplianceRate = valid.length ? valid.filter(evidenceOk).length / valid.length : 0;
  const engineeringScore = roundMetric4(
    0.35 * implementationRate + 0.3 * testPassRate + 0.35 * fullAcceptanceRate,
  );

  const partialRate = (regex) => {
    const subset = valid.filter((r) => regex.test(String(r.taskId)));
    const pool = subset.length ? subset : valid;
    if (!pool.length) return 0;
    const sum = pool.reduce((acc, r) => {
      if (isFullResultPass(r)) return acc + 1;
      if (hasEngineeringEvidence(r)) {
        if (implOk(r) && testOk(r)) return acc + 0.65;
        if (implOk(r)) return acc + 0.35;
      }
      return acc;
    }, 0);
    return sum / pool.length;
  };

  const analysisAuditRate = partialRate(
    /code-generation|unfamiliar-codebase|real-security-audit|real-recovery|real-bug-fix|real-refactor|real-codebase-analysis/i,
  );
  const planningCompletionRate = partialRate(
    /multi-file-refactor|long-task-recovery|multi-agent|real-refactor|real-recovery|real-multi-agent|real-multi-file-feature/i,
  );
  const reasoningScore = roundMetric4(0.6 * analysisAuditRate + 0.4 * planningCompletionRate);

  const toolTotals = valid.reduce((s, r) => s + Number(r.telemetry?.toolReceiptCount ?? 0), 0);
  const toolSuccesses = valid.reduce((s, r) => s + Number(r.telemetry?.toolReceiptSuccessCount ?? 0), 0);
  const toolSuccessRate = toolTotals > 0
    ? Math.min(1, toolSuccesses / toolTotals)
    : valid.some(hasEngineeringEvidence)
      ? testPassRate
      : fullAcceptanceRate;
  const recoveryPool = valid.filter((r) => /recovery/i.test(String(r.taskId)));
  const recoveryRate = (recoveryPool.length ? recoveryPool : valid).length
    ? (recoveryPool.length ? recoveryPool : valid).reduce(
        (s, r) => s + (isFullResultPass(r) ? 1 : hasEngineeringEvidence(r) && implOk(r) ? 0.5 : 0),
        0,
      ) / (recoveryPool.length ? recoveryPool : valid).length
    : 0;
  const budgetCompletionRate = valid.length
    ? valid.filter((r) => !isResultBudgetExhausted(r)).length / valid.length
    : 0;
  const timeoutFreeRate = valid.length
    ? valid.filter((r) => r.status !== 'timeout').length / valid.length
    : 0;
  const executionScore = roundMetric4(
    0.45 * toolSuccessRate + 0.25 * recoveryRate + 0.15 * budgetCompletionRate + 0.15 * timeoutFreeRate,
  );

  const meanDurationMs = Number(
    score?.meanDurationMs ??
      (valid.length ? valid.reduce((sum, r) => sum + Number(r.durationMs || 0), 0) / valid.length : 0),
  );
  const stepSamples = valid.map((r) => Number(r.telemetry?.stepUsage?.steps ?? 0)).filter((s) => s > 0);
  const meanSteps = stepSamples.length
    ? stepSamples.reduce((a, b) => a + b, 0) / stepSamples.length
    : 0;
  const tokenSamples = valid
    .map((r) => {
      const tu = r.telemetry?.tokenUsage;
      if (!tu) return 0;
      return Number(tu.totalTokens ?? Number(tu.inputTokens ?? 0) + Number(tu.outputTokens ?? 0));
    })
    .filter((t) => t > 0);
  const meanTokens = tokenSamples.length
    ? tokenSamples.reduce((a, b) => a + b, 0) / tokenSamples.length
    : 0;
  const latencyScore = valid.length
    ? roundMetric4(Math.max(0.05, Math.min(1, 1 - meanDurationMs / 60_000)))
    : 0;
  const stepEfficiencyScore = meanSteps > 0
    ? roundMetric4(Math.max(0.1, Math.min(1, 1 - meanSteps / 48)))
    : roundMetric4(fullAcceptanceRate > 0 ? latencyScore : 0);
  const efficiencyGate = fullAcceptanceRate > 0 || implementationRate > 0 ? 1 : 0.25;
  const efficiencyScore = roundMetric4(
    valid.length ? (0.6 * latencyScore + 0.4 * stepEfficiencyScore) * efficiencyGate : 0,
  );

  return {
    sampleCount: valid.length,
    engineering: {
      implementationRate: roundMetric4(implementationRate),
      testPassRate: roundMetric4(testPassRate),
      evidenceComplianceRate: roundMetric4(evidenceComplianceRate),
      fullAcceptanceRate: roundMetric4(fullAcceptanceRate),
      score: engineeringScore,
    },
    reasoning: {
      analysisAuditRate: roundMetric4(analysisAuditRate),
      planningCompletionRate: roundMetric4(planningCompletionRate),
      score: reasoningScore,
    },
    execution: {
      toolSuccessRate: roundMetric4(toolSuccessRate),
      recoveryRate: roundMetric4(recoveryRate),
      budgetCompletionRate: roundMetric4(budgetCompletionRate),
      timeoutFreeRate: roundMetric4(timeoutFreeRate),
      score: executionScore,
    },
    efficiency: {
      meanDurationMs: Math.round(meanDurationMs),
      meanSteps: Number(meanSteps.toFixed(2)),
      meanTokens: Math.round(meanTokens),
      latencyScore,
      stepEfficiencyScore,
      score: efficiencyScore,
    },
  };
}

function deriveMeasuredCapabilities(results = [], score = {}) {
  const valid = results.filter((r) => r?.taskId && ['passed', 'failed', 'timeout', 'cancelled'].includes(r.status));
  const layered = deriveLayeredCapabilities(results, score);
  const partialFor = (regex) => {
    const subset = valid.filter((r) => regex.test(String(r.taskId)));
    const pool = subset.length ? subset : valid;
    if (!pool.length) return 0;
    const sum = pool.reduce((acc, r) => {
      if (isFullResultPass(r)) return acc + 1;
      if (hasEngineeringEvidence(r)) {
        const impl = Boolean(r.judge?.evidence?.implementationPassed);
        const test = Boolean(r.judge?.evidence?.testsPassed ?? r.judge?.evidence?.checks?.tests);
        if (impl && test) return acc + 0.65;
        if (impl) return acc + 0.35;
      }
      return acc;
    }, 0);
    return sum / pool.length;
  };
  const passRate = layered.engineering.fullAcceptanceRate;
  const implRate = layered.engineering.implementationRate;
  const activeSignal = Math.max(passRate, 0.65 * implRate);
  const speedBase = Math.max(0.05, Math.min(1, 1 - layered.efficiency.meanDurationMs / 60_000));
  const speed = Number(((activeSignal > 0 ? 0.2 : 0) + 0.8 * speedBase * Math.max(0.2, activeSignal)).toFixed(4));
  return {
    coding: roundMetric4(partialFor(/code-generation|multi-file-refactor|real-multi-file-feature|real-bug-fix|real-refactor|real-tests|real-api-compat|real-data-processing|real-recovery|real-multi-agent/i)),
    reasoning: roundMetric4(partialFor(/code-generation|unfamiliar-codebase|real-security-audit|real-recovery|real-bug-fix|real-refactor/i)),
    research: roundMetric4(partialFor(/unfamiliar-codebase|network-research|real-codebase-analysis|real-security-audit/i)),
    planning: roundMetric4(partialFor(/multi-file-refactor|long-task-recovery|multi-agent|real-refactor|real-recovery|real-multi-agent/i)),
    speed,
    contextCapacity: roundMetric4(valid.length ? 0.4 + 0.6 * activeSignal : 0),
    multimodal: 0,
    toolCompatibility: roundMetric4(Math.max(layered.execution.toolSuccessRate * (activeSignal > 0 ? 1 : 0.5), partialFor(/real-|multi-agent|recovery/i))),
  };
}

function extractCallCommandsFromMessages(db, sessionId, turnId) {
  const map = new Map();
  if (!db?.isOpen || !sessionId || !turnId) return map;
  try {
    const rows = db
      .prepare("SELECT toolCalls FROM direct_messages WHERE sessionId=? AND turnId=? AND role='assistant' AND toolCalls IS NOT NULL")
      .all(sessionId, turnId);
    for (const row of rows) {
      try {
        const calls = JSON.parse(row.toolCalls);
        if (!Array.isArray(calls)) continue;
        for (const tc of calls) {
          if (!tc?.id) continue;
          const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
          if (typeof args?.command === 'string') map.set(tc.id, args.command);
        }
      } catch {
        // ignore malformed historical toolCalls
      }
    }
  } catch {
    // ignore in minimal DB mocks
  }
  return map;
}

function collectTurnTelemetry(directAgent, sessionId, turnId, currentTurn) {
  const db = directAgent?.store?.db;
  let toolReceipts = null;
  let parsedVerdict = parseJson(currentTurn?.verdict ?? currentTurn?.verdictJson, null);
  let stepUsage = currentTurn?.step != null ? { steps: Number(currentTurn.step) } : null;
  let tokenUsage = currentTurn?.inputTokens != null || currentTurn?.outputTokens != null
    ? {
        inputTokens: Number(currentTurn.inputTokens ?? 0),
        outputTokens: Number(currentTurn.outputTokens ?? 0),
        totalTokens: Number(currentTurn.inputTokens ?? 0) + Number(currentTurn.outputTokens ?? 0),
      }
    : null;
  if (db?.isOpen && sessionId && turnId) {
    try {
      const cmdMap = extractCallCommandsFromMessages(db, sessionId, turnId);
      const rawReceipts = db
        .prepare('SELECT id, sessionId, turnId, callId, toolName, status, exitCode, outputDigest, errorCode FROM tool_receipts WHERE sessionId=? AND turnId=? ORDER BY createdAt ASC')
        .all(sessionId, turnId);
      toolReceipts = rawReceipts.map((r) => ({ ...r, command: cmdMap.get(r.callId) ?? '' }));
      const turnRow = db.prepare('SELECT step, inputTokens, outputTokens, verdictJson FROM direct_turns WHERE id=?').get(turnId);
      if (turnRow) {
        if (turnRow.step != null) stepUsage = { steps: Number(turnRow.step) };
        tokenUsage = {
          inputTokens: Number(turnRow.inputTokens ?? 0),
          outputTokens: Number(turnRow.outputTokens ?? 0),
          totalTokens: Number(turnRow.inputTokens ?? 0) + Number(turnRow.outputTokens ?? 0),
        };
        if (!parsedVerdict && turnRow.verdictJson) {
          parsedVerdict = parseJson(turnRow.verdictJson, null);
        }
      }
    } catch {
      // minimal store mock fallback
    }
  }
  return { toolReceipts, parsedVerdict, stepUsage, tokenUsage };
}

function createDirectRuntimeAdapter(directAgent, { model = null } = {}) {
  if (!directAgent) throw new TypeError('Evaluation requires DirectAgentRuntime');
  return ({ task, attempt = 1, workspaceRoot, signal, context }) => {
    let turnId = null;
    const attemptId = `attempt-${Number(attempt || 1)}`;
    const planVersion = Number(task.metadata?.planVersion ?? 1);
    const evalPermissionMode =
      task.metadata?.requiresWorkspaceMutation === true ? 'full-access' : 'auto-safe';
    const evalToolDeny =
      task.metadata?.externalNetwork === false ? ['web_fetch', 'web_search'] : null;
    const hasAcceptanceCriteria = Boolean(task.metadata?.acceptanceCriteria);
    const evidenceContract = hasAcceptanceCriteria
      ? {
          taskId: task.id,
          attemptId,
          planVersion,
          expectedTestCommand: task.metadata.acceptanceCriteria.testCommand,
          requiredChangedFiles: task.metadata.acceptanceCriteria.requiredChangedFiles,
          workspaceRoot,
          requireIndependentVerdict: false,
        }
      : null;
    const turnInput =
      hasAcceptanceCriteria && Number(attempt) > 1
        ? `${task.prompt}\n\n[Execution Binding] taskId=${task.id}, attemptId=${attemptId}, planVersion=${planVersion}`
        : task.prompt;
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
      const baseBudgetSteps = task.resourceBudget?.maxSteps ?? task.metadata?.resourceBudget?.maxSteps ?? 16;
      const resolvedModel = model || context.model || undefined;
      const histStats = directAgent?.store
        ? queryHistoricalTaskMetrics(directAgent.store, { taskType: task.id, model: resolvedModel })
        : null;
      const adaptiveBudget = histStats && histStats.sampleCount > 0 && hasAcceptanceCriteria
        ? estimateTaskBudget({
            taskType: task.id,
            fileCount: Object.keys(task.fixture?.files ?? {}).length || 1,
            requiredTools: ['read_file', 'write_file', 'edit_file', 'bash'],
            expectedArtifacts: task.metadata?.expectedArtifacts ?? [],
            verificationComplexity: /security-audit|recovery|multi-agent/.test(task.id) ? 'high' : 'medium',
            recoveryRequirements: /recovery/.test(task.id),
            historicalStats: histStats,
            userBudget: context.maxSteps ? { maxSteps: context.maxSteps } : {},
          })
        : null;
      const effectiveMaxSteps = adaptiveBudget
        ? Math.min(40, Math.max(baseBudgetSteps, adaptiveBudget.maxSteps))
        : baseBudgetSteps;
      const finalVerificationReserve =
        adaptiveBudget?.finalVerificationReserve ??
        task.resourceBudget?.finalVerificationReserve ??
        task.metadata?.resourceBudget?.finalVerificationReserve ??
        null;

      const started = directAgent.startTurn(session.id, {
        input: turnInput,
        model: resolvedModel,
        permissionMode: evalPermissionMode,
        maxSteps: effectiveMaxSteps,
        ...(finalVerificationReserve != null ? { finalVerificationReserve } : {}),
        ...(evidenceContract ? { evidenceContract } : {}),
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
            const telemetry = collectTurnTelemetry(directAgent, session.id, turnId, current);
            const shellReceipts = Array.isArray(telemetry.toolReceipts)
              ? telemetry.toolReceipts.filter((r) => ['bash', 'start_process'].includes(String(r.toolName)))
              : [];
            const latestShell = shellReceipts.at(-1) ?? null;
            const shellHealthy =
              shellReceipts.length === 0 ||
              (latestShell?.status === 'finished' && (latestShell.exitCode == null || Number(latestShell.exitCode) === 0));
            const serverPassed =
              current.state === 'completed' &&
              (!telemetry.parsedVerdict || (telemetry.parsedVerdict.verdict === 'pass' && telemetry.parsedVerdict.accepted !== false)) &&
              Number(telemetry.parsedVerdict?.checks?.pendingReconciliations ?? 0) === 0 &&
              shellHealthy;
            const evidenceRefs = [
              `turn:${session.id}:${turnId}`,
              ...(Array.isArray(telemetry.toolReceipts) ? telemetry.toolReceipts.map((r) => `receipt:${r.id}`) : []),
            ];
            const trustedVerdict = serverPassed
              ? { status: 'pass', source: 'trusted_server_verifier', evidenceRefs }
              : { status: 'fail', source: 'trusted_server_verifier', evidenceRefs, reasons: telemetry.parsedVerdict?.reasons ?? [current.error || current.state] };

            const isSoftEvidenceFailure =
              current.state === 'failed' &&
              (telemetry.parsedVerdict?.status === 'EVIDENCE_INCOMPLETE' ||
                /EVIDENCE_INCOMPLETE|VERIFICATION_FAILED/i.test(String(current.error ?? '')));

            if (current.state !== 'completed' && !isSoftEvidenceFailure) {
              const error = new Error(current.error || `Evaluation turn ${current.state}`);
              error.code = current.state === 'cancelled'
                ? 'E_EVAL_CANCELLED'
                : /STEP_BUDGET/i.test(String(current.error ?? ''))
                  ? 'STEP_BUDGET_EXHAUSTED'
                  : 'E_RUNTIME_TURN_FAILED';
              if (current.state === 'cancelled') error.name = 'AbortError';
              error.telemetry = {
                attemptId,
                planVersion,
                runtimeStatus: current.state,
                errorCode: error.code,
                stepUsage: telemetry.stepUsage,
                tokenUsage: telemetry.tokenUsage,
                toolReceiptCount: telemetry.toolReceipts?.length ?? 0,
                trustedVerdict,
              };
              throw error;
            }
            return {
              output: text,
              sessionId: session.id,
              turnId,
              attemptId,
              planVersion,
              turnState: current.state,
              verdict: telemetry.parsedVerdict ?? current.verdict ?? null,
              evidenceCount: Number(current.evidenceCount ?? 0),
              toolReceipts: telemetry.toolReceipts,
              trustedVerdict,
              stepUsage: telemetry.stepUsage,
              tokenUsage: telemetry.tokenUsage,
            };
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
          const layered = deriveLayeredCapabilities(mergedReport.results, mergedReport.score);
          const avgLatencyMs = Math.round(Number(mergedReport.score.meanDurationMs ?? 0));
          const evidenceRefs = mergedReport.results
            .filter((result) => result?.taskId && ['passed', 'failed', 'timeout', 'cancelled'].includes(result.status))
            .map((result) => `evaluation:${finalRun.id}:${result.taskId}`);
          if (evidenceRefs.length > 0) {
            this.capabilityRegistry?.recordMeasuredFromEvaluation?.(
              {
                id: finalRun.model,
                capabilities: measuredCaps,
                layered,
                metrics: {
                  passRate: mergedReport.score.passRate,
                  passed: mergedReport.score.passed,
                  failed: mergedReport.score.failed,
                  total: mergedReport.score.total,
                  avgLatencyMs,
                  implementationRate: layered.engineering.implementationRate,
                  testPassRate: layered.engineering.testPassRate,
                  evidenceComplianceRate: layered.engineering.evidenceComplianceRate,
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





