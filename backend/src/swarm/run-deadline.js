// createdAt is the original durable submission time, including all time in the queue.
export function remainingRunMs(run, now = Date.now()) {
  if (!run) return null;
  const limit = run.budget?.maxDurationMs ?? run.maxDurationMs;
  if (limit == null || limit === '' || !Number.isFinite(Number(limit))) return null;
  return Math.max(0, Number(run.createdAt) + Math.max(0, Math.floor(Number(limit))) - now);
}

export function isRunDeadlineExpired(run, now = Date.now()) {
  const rem = remainingRunMs(run, now);
  return rem !== null && rem <= 0;
}

/**
 * Builds a structured graceful degradation partial delivery summary when a Swarm run
 * exceeds its wall-clock deadline while preserving verified completed upstream nodes
 * and artifacts.
 */
export function buildDeadlineDegradationSummary({
  run = null,
  activeNodes = [],
  verifiedArtifacts = [],
  cancelledNodeKeys = [],
  reason = 'BUDGET_DURATION_EXCEEDED',
} = {}) {
  const completedNodes = activeNodes.filter((n) => n.status === 'completed');
  const completedNodeKeys = completedNodes.map((n) => n.nodeKey);
  const completedSet = new Set(completedNodeKeys);
  const preservedArtifacts = verifiedArtifacts
    .filter((a) => a && a.status !== 'superseded' && (!a.nodeKey || completedSet.has(a.nodeKey)))
    .map((a) => ({
      artifactId: a.id ?? a.artifactId,
      uri: a.uri ?? null,
      nodeId: a.nodeId ?? null,
      nodeKey: a.nodeKey ?? null,
      bundleSha256: a.bundleSha256 ?? null,
      fileCount: Number(a.fileCount ?? (a.files?.length ?? 0)),
      files: Array.isArray(a.files)
        ? a.files.map((f) => ({
            path: f.path,
            changeType: f.changeType,
            mode: f.mode ?? '100644',
            sha256: f.sha256 ?? null,
          }))
        : [],
      status: a.status ?? 'archived',
    }));

  const lines = [
    `[Deadline Graceful Degradation] Run ${run?.id ?? ''} reached wall-clock deadline (${reason}).`,
    `Preserved completed nodes (${completedNodeKeys.length}): ${completedNodeKeys.length ? completedNodeKeys.join(', ') : 'none'}`,
    `Preserved verified artifacts (${preservedArtifacts.length}): ${preservedArtifacts.length ? preservedArtifacts.map((a) => `${a.nodeKey}:${a.uri || a.artifactId} (${a.fileCount} files)`).join(', ') : 'none'}`,
  ];
  if (cancelledNodeKeys.length > 0) {
    lines.push(`Cancelled incomplete nodes (${cancelledNodeKeys.length}): ${cancelledNodeKeys.join(', ')}`);
  }
  for (const n of completedNodes) {
    if (n.resultText) {
      lines.push(`### [${n.nodeKey}] (completed, preserved)\n${String(n.resultText).slice(0, 600)}`);
    }
  }

  return {
    degradedTimeout: true,
    partialDelivery: completedNodeKeys.length > 0 || preservedArtifacts.length > 0,
    errorCode: reason,
    completedNodeKeys,
    cancelledNodeKeys: [...new Set(cancelledNodeKeys)],
    preservedArtifacts,
    preservedArtifactCount: preservedArtifacts.length,
    summary: lines.join('\n'),
  };
}
