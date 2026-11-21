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

export function createDeterministicJudge({ fallback = null } = {}) {
  return async function judge({ task, output, context = {} }) {
    if (typeof task.judge === 'function') {
      const judged = await task.judge({ task, output, context });
      return { deterministic: true, ...judged };
    }
    const actual = extractOutput(output);
    const expected = task.expected?.output ?? task.expected;
    const passed = stable(actual) === stable(expected);
    if (passed) {
      return { passed: true, score: 1, deterministic: true, reason: 'exact_match', actual, expected };
    }
    if (fallback) {
      const advisory = await fallback({ task, output, context, actual, expected });
      return {
        passed: false,
        score: 0,
        deterministic: true,
        reason: 'deterministic_failure',
        actual,
        expected,
        advisory: advisory && typeof advisory === 'object' ? advisory : { result: advisory },
      };
    }
    return { passed: false, score: 0, deterministic: true, reason: 'exact_mismatch', actual, expected };
  };
}

export { extractOutput, stable };
