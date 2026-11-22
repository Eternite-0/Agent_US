const NON_IMPL_CHECK_KEYS = new Set([
  'changedFiles',
  'reportedChangedFiles',
  'tests',
  'testCommand',
  'testReceiptVerified',
  'independentVerdict',
  'artifacts',
  'schemaVersion',
  'binding',
]);

function round4(value) {
  return Number((Number(value) || 0).toFixed(4));
}

export function extractResultTelemetry(result = {}) {
  const passed = result?.status === 'passed' && result?.passed === true;
  const ev = result?.judge?.evidence ?? null;
  const checks = ev?.checks && typeof ev.checks === 'object' ? ev.checks : null;

  let implementationPassed = passed;
  if (ev && ev.implementationPassed !== undefined) {
    implementationPassed = Boolean(ev.implementationPassed);
  } else if (checks) {
    const taskKeys = Object.keys(checks).filter((k) => !NON_IMPL_CHECK_KEYS.has(k));
    const changedOk = checks.changedFiles !== false;
    implementationPassed = taskKeys.length > 0
      ? changedOk && taskKeys.every((k) => Boolean(checks[k]))
      : Boolean(ev.actualChangedFiles?.length > 0 && changedOk);
  }

  let testsPassed = passed;
  if (ev && ev.testsPassed !== undefined) {
    testsPassed = Boolean(ev.testsPassed);
  } else if (ev && ev.actualTestExitCode !== undefined && ev.actualTestExitCode !== null) {
    testsPassed = Number(ev.actualTestExitCode) === 0;
  }

  const evidenceCompliant = ev && ev.evidenceCompliant !== undefined
    ? Boolean(ev.evidenceCompliant)
    : passed;

  const stepBudgetExhausted = Boolean(
    result?.errorCode === 'STEP_BUDGET_EXHAUSTED' ||
      result?.telemetry?.errorCode === 'STEP_BUDGET_EXHAUSTED' ||
      ev?.failureCategory === 'step_budget_exhausted' ||
      /STEP_BUDGET/i.test(String(result?.error ?? '')),
  );

  const rawSteps = result?.telemetry?.stepUsage?.steps ?? result?.telemetry?.steps;
  const steps = rawSteps != null && Number.isFinite(Number(rawSteps)) ? Number(rawSteps) : null;
  const tu = result?.telemetry?.tokenUsage ?? null;
  const totalTokens = tu
    ? Number(tu.totalTokens ?? (Number(tu.inputTokens ?? 0) + Number(tu.outputTokens ?? 0)))
    : null;
  const attempts = Math.max(0, Number(result?.attempts || 0));
  const retries = result?.telemetry?.retries != null
    ? Math.max(0, Number(result.telemetry.retries))
    : Math.max(0, attempts > 0 ? attempts - 1 : 0);

  let reviewerValid = null;
  if (result?.telemetry?.reviewerVerdict && typeof result.telemetry.reviewerVerdict === 'object') {
    reviewerValid = ['pass', 'fail', 'needs_revision'].includes(String(result.telemetry.reviewerVerdict.status ?? ''));
  } else if (ev?.independentVerdictSource === 'independent_reviewer') {
    reviewerValid = true;
  }

  let failureCategory = 'none';
  if (!passed) {
    if (result?.status === 'timeout') failureCategory = 'timeout';
    else if (result?.status === 'cancelled') failureCategory = 'cancelled';
    else if (stepBudgetExhausted) failureCategory = 'step_budget_exhausted';
    else if (ev?.failureCategory && ev.failureCategory !== 'none') failureCategory = String(ev.failureCategory);
    else if (result?.error && !result?.judge) failureCategory = 'runtime_error';
    else if (!implementationPassed) failureCategory = 'implementation_failed';
    else if (!testsPassed) failureCategory = 'test_failed';
    else if (checks?.independentVerdict === false) failureCategory = 'independent_verdict_failed';
    else if (!evidenceCompliant) failureCategory = 'evidence_incomplete';
    else failureCategory = 'failed';
  }

  return {
    taskId: String(result?.taskId ?? ''),
    status: String(result?.status ?? 'failed'),
    passed,
    implementationPassed,
    testsPassed,
    evidenceCompliant,
    stepBudgetExhausted,
    steps,
    totalTokens,
    durationMs: Math.max(0, Number(result?.durationMs || 0)),
    attempts,
    retries,
    reviewerValid,
    failureCategory,
    isRecoveryTask: /recovery/i.test(String(result?.taskId ?? '')),
  };
}

export function scoreResults(results = []) {
  const total = results.length;
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const cancelled = results.filter((r) => r.status === 'cancelled').length;
  const timedOut = results.filter((r) => r.status === 'timeout').length;
  const attempts = results.reduce((sum, r) => sum + Number(r.attempts || 0), 0);
  const durationMs = results.reduce((sum, r) => sum + Number(r.durationMs || 0), 0);
  return {
    total,
    passed,
    failed,
    cancelled,
    timedOut,
    attempts,
    passRate: total ? passed / total : 0,
    meanDurationMs: total ? durationMs / total : 0,
    totalDurationMs: durationMs,
  };
}

export function scoreDetailedResults(results = []) {
  const base = scoreResults(results);
  const rows = results.map((r) => extractResultTelemetry(r));
  const total = rows.length;
  const implPassed = rows.filter((r) => r.implementationPassed).length;
  const testsPassed = rows.filter((r) => r.testsPassed).length;
  const evidencePassed = rows.filter((r) => r.evidenceCompliant).length;
  const stepBudgetExhaustedCount = rows.filter((r) => r.stepBudgetExhausted).length;
  const stepSamples = rows.map((r) => r.steps).filter((v) => v !== null);
  const tokenSamples = rows.map((r) => r.totalTokens).filter((v) => v !== null);
  return {
    ...base,
    implementationPassRate: total ? round4(implPassed / total) : 0,
    testPassRate: total ? round4(testsPassed / total) : 0,
    evidenceComplianceRate: total ? round4(evidencePassed / total) : 0,
    stepBudgetExhaustedCount,
    meanSteps: stepSamples.length ? Number((stepSamples.reduce((a, b) => a + b, 0) / stepSamples.length).toFixed(2)) : null,
    meanTokens: tokenSamples.length ? Math.round(tokenSamples.reduce((a, b) => a + b, 0) / tokenSamples.length) : null,
  };
}

export function scoreRun(report) {
  return { ...report, score: scoreResults(report.results) };
}
