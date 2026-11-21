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

export function scoreRun(report) {
  return { ...report, score: scoreResults(report.results) };
}
