import { Fault } from './store.js';

/**
 * Offline 3-split (train / eval / sealed) multi-run deterministic evaluation harness
 * modeled on Agnes Harness Tier-2 release gates:
 * - Zero case ID overlap across splits (fail-closed E_EVAL_SPLIT_LEAK).
 * - Multi-run repeatability evaluation (default n = 3) to quantify variance.
 * - Lexicographic safety-first promotion gate: safety failures > pass rate > efficiency.
 */

export function validateSplits({ train = [], evalSet = [], sealed = [] }) {
  const seen = new Map();
  for (const [split, items] of [
    ['train', train],
    ['eval', evalSet],
    ['sealed', sealed],
  ]) {
    for (const item of items) {
      if (!item?.id) {
        throw new Fault('E_EVAL_INVALID_CASE', 400, { split });
      }
      if (seen.has(item.id)) {
        throw new Fault('E_EVAL_SPLIT_LEAK', 400, {
          caseId: item.id,
          splits: [seen.get(item.id), split],
        });
      }
      seen.set(item.id, split);
    }
  }
  return {
    train: train.length,
    eval: evalSet.length,
    sealed: sealed.length,
  };
}

export async function runSplit(cases, runner, { repeats = 3 } = {}) {
  const perCase = [];
  let totalRuns = 0;
  let totalPassed = 0;
  let safetyFailures = 0;
  let totalDurationMs = 0;
  let totalCostUSD = 0;

  for (const testCase of cases) {
    let casePassed = 0;
    let caseSafetyFails = 0;
    for (let r = 0; r < repeats; r++) {
      const started = Date.now();
      const out = await runner(testCase, r);
      const durationMs = out?.durationMs ?? Date.now() - started;
      totalRuns++;
      totalDurationMs += durationMs;
      totalCostUSD += out?.costUSD ?? 0;
      if (out?.safetyViolation) {
        safetyFailures++;
        caseSafetyFails++;
      } else if (out?.passed) {
        totalPassed++;
        casePassed++;
      }
    }
    perCase.push({
      id: testCase.id,
      passed: casePassed,
      repeats,
      passRate: repeats ? casePassed / repeats : 0,
      safetyFailures: caseSafetyFails,
    });
  }

  return {
    totalCases: cases.length,
    repeats,
    totalRuns,
    passedRuns: totalPassed,
    passRate: totalRuns ? totalPassed / totalRuns : 0,
    safetyFailures,
    meanDurationMs: totalRuns ? totalDurationMs / totalRuns : 0,
    meanCostUSD: totalRuns ? totalCostUSD / totalRuns : 0,
    perCase,
  };
}

/**
 * Lexicographic release gate comparing candidate Playbook/skill config against champion:
 * 1. Safety: candidate must have ZERO increase in safety failures on eval AND sealed.
 * 2. Quality: candidate must preserve or improve both eval AND sealed pass rates,
 *    with eval - sealed overfitting gap within maxOverfitGap (default 0.15).
 * 3. Efficiency: if pass rates tie, prefer lower latency or cost.
 */
export function evaluateCandidate({
  champion,
  candidate,
  maxOverfitGap = 0.15,
}) {
  if (
    candidate.eval.safetyFailures > champion.eval.safetyFailures ||
    candidate.sealed.safetyFailures > champion.sealed.safetyFailures
  ) {
    return {
      promoted: false,
      reason: 'safety_regression',
      evalSealedGap: candidate.eval.passRate - candidate.sealed.passRate,
    };
  }
  const evalSealedGap = candidate.eval.passRate - candidate.sealed.passRate;
  if (evalSealedGap > maxOverfitGap) {
    return {
      promoted: false,
      reason: 'overfit_gap_exceeded',
      evalSealedGap,
    };
  }
  if (
    candidate.eval.passRate < champion.eval.passRate ||
    candidate.sealed.passRate < champion.sealed.passRate
  ) {
    return {
      promoted: false,
      reason: 'pass_rate_regression',
      evalSealedGap,
    };
  }
  const improvedPass =
    candidate.eval.passRate > champion.eval.passRate ||
    candidate.sealed.passRate > champion.sealed.passRate;
  const improvedEfficiency =
    candidate.eval.meanDurationMs < champion.eval.meanDurationMs ||
    candidate.eval.meanCostUSD < champion.eval.meanCostUSD;

  return {
    promoted: improvedPass || improvedEfficiency,
    reason: improvedPass
      ? 'pass_rate_improved'
      : improvedEfficiency
        ? 'efficiency_improved'
        : 'no_improvement',
    evalSealedGap,
  };
}
