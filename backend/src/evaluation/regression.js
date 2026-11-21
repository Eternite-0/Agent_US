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
