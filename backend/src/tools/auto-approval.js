// Auto-review is stricter than auto-safe: the agent cannot have a side model
// bless arbitrary shell programs or writes. Only these exact, non-mutating
// commands can enter review. In particular, Git status/diff can invoke helpers
// from repository configuration, so they are not on this list.
const READ_ONLY_PROBES = new Set([
  'pwd', 'get-location', 'node -v', 'node --version', 'npm -v', 'npm --version',
  'git branch --show-current', 'git rev-parse --show-toplevel',
]);

export function createDirectAutoReviewer(judgment) {
  const turnReviewCounts = new WeakMap();
  return async ({ tool, args, signal }) => {
    const command = typeof args?.command === 'string' ? args.command.trim() : '';
    if (tool !== 'bash' || args?.cwd || !READ_ONLY_PROBES.has(command)) return null;

    // The built-in reviewer is usable without an optional side model. If a
    // configured model is invoked and cannot decide, never override its result.
    if (!judgment?.uses?.autoReview) return { allow: true, source: 'local_policy' };
    if (!judgment.available || !signal) return { allow: false, source: 'review_model' };
    const reviewCount = turnReviewCounts.get(signal) ?? 0;
    turnReviewCounts.set(signal, reviewCount + 1);
    const result = await judgment.reviewToolApproval({
      tool,
      action: { command }, // Exact allowlisted command; no paths, files or conversation data.
      executionContext: 'direct_read_only_probe',
      reviewCount,
      signal,
    });
    return { allow: result?.allow === true && result.risk === 'low', source: 'review_model' };
  };
}
