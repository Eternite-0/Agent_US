// createdAt is the original durable submission time, including all time in the queue.
export function remainingRunMs(run, now = Date.now()) {
  if (!run) return null;
  const limit = run.budget?.maxDurationMs ?? run.maxDurationMs;
  if (limit == null || limit === '' || !Number.isFinite(Number(limit))) return null;
  return Math.max(0, Number(run.createdAt) + Math.max(0, Math.floor(Number(limit))) - now);
}
