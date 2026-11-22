import { extractResultTelemetry, scoreDetailedResults } from './scoring.js';

function round4(value) {
  return Number((Number(value) || 0).toFixed(4));
}

function deltaOrNull(nextVal, baseVal) {
  if (nextVal == null || baseVal == null) return null;
  return round4(Number(nextVal) - Number(baseVal));
}

export function summarizeBenchmarkMetrics(runOrReport = {}) {
  const results = Array.isArray(runOrReport?.results)
    ? runOrReport.results
    : Array.isArray(runOrReport)
      ? runOrReport
      : [];
  const tasks = results.map((r) => extractResultTelemetry(r));
  const scored = scoreDetailedResults(results);
  const total = tasks.length || Number(runOrReport?.score?.total ?? 0);

  const reviewerRows = tasks.filter((t) => t.reviewerValid !== null);
  const reviewerValidityRate = reviewerRows.length
    ? round4(reviewerRows.filter((t) => t.reviewerValid === true).length / reviewerRows.length)
    : null;

  const retriedCount = tasks.filter((t) => t.retries > 0 || t.attempts > 1).length;
  const retryRate = tasks.length ? round4(retriedCount / tasks.length) : 0;

  const recoveryRows = tasks.filter((t) => t.isRecoveryTask);
  const recoverySuccessRate = recoveryRows.length
    ? round4(recoveryRows.filter((t) => t.passed).length / recoveryRows.length)
    : null;

  const failureTaxonomy = {};
  for (const row of tasks) {
    if (row.passed) continue;
    failureTaxonomy[row.failureCategory] = (failureTaxonomy[row.failureCategory] ?? 0) + 1;
  }

  return {
    total,
    passed: scored.passed || Number(runOrReport?.score?.passed ?? 0),
    failed: scored.failed || Number(runOrReport?.score?.failed ?? 0),
    timedOut: scored.timedOut || Number(runOrReport?.score?.timedOut ?? 0),
    cancelled: scored.cancelled || Number(runOrReport?.score?.cancelled ?? 0),
    fullPassRate: scored.total ? scored.passRate : round4(runOrReport?.score?.passRate ?? 0),
    implementationPassRate: scored.implementationPassRate,
    testPassRate: scored.testPassRate,
    evidenceComplianceRate: scored.evidenceComplianceRate,
    reviewerValidityRate,
    stepBudgetExhaustedCount: scored.stepBudgetExhaustedCount,
    stepBudgetExhaustedRate: total ? round4(scored.stepBudgetExhaustedCount / total) : 0,
    averageSteps: scored.meanSteps,
    averageTokens: scored.meanTokens,
    averageDurationMs: Math.round(scored.total ? scored.meanDurationMs : Number(runOrReport?.score?.meanDurationMs ?? 0)),
    retryRate,
    recoverySuccessRate,
    failureTaxonomy,
    tasks,
  };
}

export function compareBenchmarkMetrics(baselineInput = {}, candidateInput = {}) {
  const baseline = summarizeBenchmarkMetrics(baselineInput);
  const candidate = summarizeBenchmarkMetrics(candidateInput);
  const baseById = new Map(baseline.tasks.map((t) => [t.taskId, t]));
  const candById = new Map(candidate.tasks.map((t) => [t.taskId, t]));
  const allIds = [...new Set([...baseById.keys(), ...candById.keys()])];

  const perTaskDiff = [];
  const improvedTasks = [];
  const regressedTasks = [];
  for (const taskId of allIds) {
    const b = baseById.get(taskId) ?? null;
    const c = candById.get(taskId) ?? null;
    const scoreOf = (row) => (!row ? 0 : row.passed ? 3 : row.implementationPassed && row.testsPassed ? 2 : row.implementationPassed ? 1 : 0);
    const prevTier = scoreOf(b);
    const nextTier = scoreOf(c);
    if (nextTier > prevTier) improvedTasks.push(taskId);
    else if (nextTier < prevTier) regressedTasks.push(taskId);

    perTaskDiff.push({
      taskId,
      baseline: b
        ? {
            passed: b.passed,
            implementationPassed: b.implementationPassed,
            testsPassed: b.testsPassed,
            evidenceCompliant: b.evidenceCompliant,
            failureCategory: b.failureCategory,
            steps: b.steps,
            totalTokens: b.totalTokens,
            durationMs: b.durationMs,
          }
        : null,
      candidate: c
        ? {
            passed: c.passed,
            implementationPassed: c.implementationPassed,
            testsPassed: c.testsPassed,
            evidenceCompliant: c.evidenceCompliant,
            failureCategory: c.failureCategory,
            steps: c.steps,
            totalTokens: c.totalTokens,
            durationMs: c.durationMs,
          }
        : null,
      delta: {
        passedChanged: b && c ? b.passed !== c.passed : true,
        tierDelta: nextTier - prevTier,
        durationMsDelta: b && c ? c.durationMs - b.durationMs : null,
        stepsDelta: b?.steps != null && c?.steps != null ? c.steps - b.steps : null,
        tokensDelta: b?.totalTokens != null && c?.totalTokens != null ? c.totalTokens - b.totalTokens : null,
      },
    });
  }

  return {
    baseline,
    candidate,
    deltas: {
      fullPassRateDelta: round4(candidate.fullPassRate - baseline.fullPassRate),
      implementationPassRateDelta: round4(candidate.implementationPassRate - baseline.implementationPassRate),
      testPassRateDelta: round4(candidate.testPassRate - baseline.testPassRate),
      evidenceComplianceRateDelta: round4(candidate.evidenceComplianceRate - baseline.evidenceComplianceRate),
      reviewerValidityRateDelta: deltaOrNull(candidate.reviewerValidityRate, baseline.reviewerValidityRate),
      stepBudgetExhaustedDelta: candidate.stepBudgetExhaustedCount - baseline.stepBudgetExhaustedCount,
      stepBudgetExhaustedRateDelta: round4(candidate.stepBudgetExhaustedRate - baseline.stepBudgetExhaustedRate),
      averageStepsDelta: deltaOrNull(candidate.averageSteps, baseline.averageSteps),
      averageTokensDelta: deltaOrNull(candidate.averageTokens, baseline.averageTokens),
      averageDurationMsDelta: candidate.averageDurationMs - baseline.averageDurationMs,
      retryRateDelta: round4(candidate.retryRate - baseline.retryRate),
      recoverySuccessRateDelta: deltaOrNull(candidate.recoverySuccessRate, baseline.recoverySuccessRate),
    },
    perTaskDiff,
    improvedTasks,
    regressedTasks,
  };
}

export function compareRegression(baseline, candidate, {
  maxPassRateDrop = 0,
  maxTimeoutIncrease = 0,
  maxMeanDurationIncrease = Infinity,
} = {}) {
  const base = baseline?.score ?? baseline ?? {};
  const next = candidate?.score ?? candidate ?? {};
  const passRateDelta = Number(next.passRate ?? 0) - Number(base.passRate ?? 0);
  const timeoutDelta = Number(next.timedOut ?? 0) - Number(base.timedOut ?? 0);
  const durationDelta = Number(next.meanDurationMs ?? 0) - Number(base.meanDurationMs ?? 0);
  const regressions = [];
  if (passRateDelta < -maxPassRateDrop) regressions.push('pass_rate');
  if (timeoutDelta > maxTimeoutIncrease) regressions.push('timeouts');
  if (durationDelta > maxMeanDurationIncrease) regressions.push('duration');
  return {
    passed: regressions.length === 0,
    regressions,
    passRateDelta,
    timeoutDelta,
    durationDelta,
  };
}
