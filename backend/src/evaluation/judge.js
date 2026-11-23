function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function extractOutput(candidate) {
  if (candidate && typeof candidate === 'object') {
    if (Object.hasOwn(candidate, 'output')) return candidate.output;
    if (Object.hasOwn(candidate, 'result')) return candidate.result;
    if (Object.hasOwn(candidate, 'text')) candidate = candidate.text;
  }
  if (typeof candidate === 'string') {
    try { return JSON.parse(candidate); } catch { return candidate; }
  }
  return candidate;
}

/**
 * Enforces deterministic hard-veto invariants so advisory or LLM judge fallbacks
 * can never override a deterministic failure, hidden acceptance bypass/failure,
 * git history/baseline test tampering, or unisolated execution.
 */
export function enforceDeterministicHardVeto(judged, advisory = null) {
  const base = judged && typeof judged === 'object' ? { ...judged } : { passed: false, score: 0 };
  const ev = base.evidence && typeof base.evidence === 'object' ? base.evidence : null;
  const checks = ev?.checks && typeof ev.checks === 'object' ? ev.checks : null;

  const vetoReasons = [];
  if (base.passed !== true) {
    vetoReasons.push(base.reason || 'deterministic_check_failed');
  }
  if (ev) {
    if (ev.historyUntouched === false || checks?.historyUntouched === false) {
      vetoReasons.push('history_tampered');
    }
    if (ev.baselineTestsUntampered === false || checks?.baselineTestsUntampered === false) {
      vetoReasons.push('baseline_tests_tampered');
    }
    if (ev.sandboxIsolated === false || checks?.sandboxIsolated === false) {
      vetoReasons.push('sandbox_not_isolated');
    }
    if (ev.hiddenAcceptanceTamperingDetected === true || checks?.hiddenAcceptanceTamperingDetected === true) {
      vetoReasons.push('hidden_acceptance_tampered');
    }
    if (
      ev.hiddenAcceptancePassed === false ||
      checks?.hiddenAcceptancePassed === false ||
      ev.hiddenAcceptanceVerified === false ||
      checks?.hiddenAcceptanceVerified === false
    ) {
      vetoReasons.push('hidden_acceptance_failed');
    }
  }

  const hardPassed = vetoReasons.length === 0 && base.passed === true;
  const normalizedAdvisory =
    advisory !== null && advisory !== undefined
      ? advisory && typeof advisory === 'object'
        ? advisory
        : { result: advisory }
      : undefined;

  if (!hardPassed) {
    return {
      ...base,
      deterministic: true,
      passed: false,
      score: 0,
      hardVetoed: true,
      vetoReasons,
      ...(normalizedAdvisory !== undefined ? { advisory: normalizedAdvisory } : {}),
    };
  }
  return {
    ...base,
    deterministic: true,
    passed: true,
    score: Number.isFinite(base.score) && base.score > 0 ? Math.min(1, base.score) : 1,
    hardVetoed: false,
    ...(normalizedAdvisory !== undefined ? { advisory: normalizedAdvisory } : {}),
  };
}

export function createDeterministicJudge({ fallback = null } = {}) {
  return async function judge({ task, output, context = {} }) {
    if (typeof task.judge === 'function') {
      const judged = await task.judge({ task, output, context });
      const advisory =
        !judged?.passed && fallback
          ? await fallback({ task, output, context, judged })
          : null;
      return enforceDeterministicHardVeto({ deterministic: true, ...judged }, advisory);
    }
    const actual = extractOutput(output);
    const expected = task.expected?.output ?? task.expected;
    const passed = stable(actual) === stable(expected);
    if (passed) {
      return enforceDeterministicHardVeto({
        passed: true,
        score: 1,
        deterministic: true,
        reason: 'exact_match',
        actual,
        expected,
      });
    }
    if (fallback) {
      const advisory = await fallback({ task, output, context, actual, expected });
      return enforceDeterministicHardVeto(
        {
          passed: false,
          score: 0,
          deterministic: true,
          reason: 'deterministic_failure',
          actual,
          expected,
        },
        advisory,
      );
    }
    return enforceDeterministicHardVeto({
      passed: false,
      score: 0,
      deterministic: true,
      reason: 'exact_mismatch',
      actual,
      expected,
    });
  };
}

export { extractOutput, stable };
