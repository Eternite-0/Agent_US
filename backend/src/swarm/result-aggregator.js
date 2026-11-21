function stableText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  return JSON.stringify(value);
}

function digest(value) {
  return stableText(value).replace(/\s+/g, ' ').trim();
}

function conflictId(type, key, left, right) {
  return `${type}:${key}:${digest(left)}:${digest(right)}`;
}

function artifactEntries(result) {
  const artifacts = result?.artifacts ?? result?.artifact ?? [];
  return (Array.isArray(artifacts) ? artifacts : [artifacts]).filter(Boolean).map((artifact) => ({
    path: String(artifact.path ?? artifact.targetPath ?? artifact.uri ?? artifact.id ?? ''),
    digest: String(artifact.sha256 ?? artifact.hash ?? artifact.bundleSha256 ?? artifact.contentHash ?? artifact.digest ?? ''),
    uri: artifact.uri ?? null,
    source: result.id ?? result.nodeKey ?? result.agentId ?? null,
  })).filter((artifact) => artifact.path && artifact.digest);
}

/**
 * Aggregates worker outputs without silently picking a winner. Any conclusion or
 * artifact disagreement becomes an explicit reviewer decision with all evidence
 * retained for audit and later reconciliation.
 */
export class ResultAggregator {
  constructor({ reviewerRequired = true } = {}) {
    this.reviewerRequired = reviewerRequired;
    this.resolutions = new Map();
  }

  aggregate({ results = [], artifacts = [], reviewerAvailable = false } = {}) {
    const entries = results.map((result, index) => ({
      ...result,
      id: String(result.id ?? result.nodeKey ?? result.agentId ?? `result-${index}`),
      evidence: Array.isArray(result.evidence) ? [...result.evidence] : [],
      artifacts: result.artifacts ?? [],
    }));
    const allArtifacts = [...entries.flatMap(artifactEntries), ...artifactEntries({ id: 'external', artifacts })];
    const conflicts = [];

    const byConclusion = new Map();
    for (const entry of entries) {
      const key = String(entry.taskKey ?? entry.objective ?? entry.nodeKey ?? 'default');
      const conclusion = entry.conclusion ?? entry.result ?? entry.output ?? entry.status ?? null;
      const text = digest(conclusion);
      if (!text) continue;
      const bucket = byConclusion.get(key) ?? [];
      bucket.push({ entry, conclusion, text });
      byConclusion.set(key, bucket);
    }
    for (const [key, bucket] of byConclusion) {
      const distinct = [...new Map(bucket.map((item) => [item.text, item])).values()];
      if (distinct.length > 1) {
        conflicts.push({
          id: conflictId('conclusion', key, distinct[0].text, distinct[1].text),
          type: 'conclusion', key,
          candidates: distinct.map((item) => ({ sourceId: item.entry.id, value: item.conclusion, evidence: item.entry.evidence })),
        });
      }
    }

    const byPath = new Map();
    for (const artifact of allArtifacts) {
      const bucket = byPath.get(artifact.path) ?? [];
      bucket.push(artifact);
      byPath.set(artifact.path, bucket);
    }
    for (const [path, bucket] of byPath) {
      const distinct = [...new Map(bucket.map((item) => [item.digest, item])).values()];
      if (distinct.length > 1) {
        conflicts.push({
          id: conflictId('artifact', path, distinct[0].digest, distinct[1].digest),
          type: 'artifact', key: path,
          candidates: distinct.map((item) => ({ sourceId: item.source, digest: item.digest, uri: item.uri })),
        });
      }
    }

    const evidence = entries.flatMap((entry) => entry.evidence.map((ref) => ({ sourceId: entry.id, ref })));
    const status = conflicts.length
      ? (reviewerAvailable || this.reviewerRequired ? 'review_required' : 'review_unavailable')
      : entries.length ? 'consensus' : 'insufficient_evidence';
    return {
      status,
      conflicts,
      candidates: entries.map((entry) => ({ id: entry.id, conclusion: entry.conclusion ?? entry.result ?? entry.output ?? null, evidence: entry.evidence })),
      artifacts: allArtifacts,
      evidence,
      reviewerDecision: null,
      resolved: false,
    };
  }

  resolveConflict({ aggregate, conflictId: id, decision, reviewerId, rationale = '', evidenceRefs = [] } = {}) {
    if (!aggregate || !Array.isArray(aggregate.conflicts)) throw new TypeError('aggregate is required');
    const conflict = aggregate.conflicts.find((item) => item.id === id);
    if (!conflict) throw new Error(`Unknown conflict: ${id}`);
    const allowed = new Set(['accept_left', 'accept_right', 'merge', 'reject']);
    if (!allowed.has(decision)) throw new Error(`Unsupported reviewer decision: ${decision}`);
    if (!reviewerId) throw new Error('reviewerId is required');
    const resolution = {
      conflictId: id, decision, reviewerId: String(reviewerId), rationale: String(rationale), evidenceRefs: [...evidenceRefs], decidedAt: Date.now(),
    };
    this.resolutions.set(id, resolution);
    const next = {
      ...aggregate,
      conflicts: aggregate.conflicts.map((item) => item.id === id ? { ...item, resolution: { ...resolution } } : item),
      reviewerDecision: resolution,
    };
    next.resolved = next.conflicts.every((item) => item.resolution);
    next.status = next.resolved ? 'resolved' : 'review_required';
    return next;
  }
}

export function aggregateResults(options) {
  return new ResultAggregator(options).aggregate(options);
}
