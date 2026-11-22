import { CAPABILITY_DIMENSIONS } from './capabilities.js';

const DEFAULT_CONFIDENCE_PRIOR = 10;
const MIN_RANKING_SAMPLES = 5;
const LOW_SAMPLE_BLEND_CAP = 0.25;

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function normalizeVector(input = {}) {
  const out = {};
  for (const dimension of CAPABILITY_DIMENSIONS) {
    out[dimension] = clamp(input[dimension] ?? 0);
  }
  return out;
}

function declaredVector(spec = {}) {
  return normalizeVector(spec.capabilities ?? spec.vector ?? spec.weights ?? {});
}

function measuredConfidence(measurement = {}) {
  if (measurement.confidence !== undefined) return clamp(measurement.confidence);
  const samples = Math.max(0, Number(measurement.sampleCount ?? measurement.samples ?? 0));
  return samples > 0 ? samples / (samples + DEFAULT_CONFIDENCE_PRIOR) : 0;
}

function freezeSnapshot(value) {
  return Object.freeze(value);
}

/**
 * Stores static capability declarations separately from evidence-backed measurements.
 * The two records intentionally remain visible in every effective profile so callers
 * cannot mistake historical performance for an immutable capability claim.
 */
export class CapabilityProfileRegistry {
  constructor({ priorWeight = DEFAULT_CONFIDENCE_PRIOR, minRankingSamples = MIN_RANKING_SAMPLES, store = null, kind = 'capability_profiles' } = {}) {
    this.priorWeight = Math.max(1, Number(priorWeight) || DEFAULT_CONFIDENCE_PRIOR);
    this.minRankingSamples = Math.max(1, Number(minRankingSamples) || MIN_RANKING_SAMPLES);
    this.store = store;
    this.kind = String(kind || 'capability_profiles');
    this.declared = new Map();
    this.measured = new Map();
    this.#loadPersisted();
  }

  #loadPersisted() {
    if (!this.store?.list) return;
    for (const row of this.store.list(this.kind, { limit: 10_000 })) {
      const body = row?.profile ?? row;
      if (!body?.id) continue;
      if (body.declared) this.declared.set(body.id, structuredClone(body.declared));
      if (body.measured) this.measured.set(body.id, structuredClone(body.measured));
    }
  }

  #persist(id) {
    if (!this.store?.list || !this.store?.add || !this.store?.update) return;
    const body = {
      id,
      profile: {
        id,
        declared: this.declared.get(id) ? structuredClone(this.declared.get(id)) : null,
        measured: this.measured.get(id) ? structuredClone(this.measured.get(id)) : null,
        updatedAt: Date.now(),
      },
    };
    const existing = this.store.list(this.kind, { limit: 10_000 }).find((row) => (row?.profile?.id ?? row?.id) === id);
    if (existing) this.store.update(this.kind, existing, body);
    else this.store.add(this.kind, body, null, null, id);
  }

  registerDeclared(spec = {}) {
    const id = String(spec.id ?? spec.agentId ?? spec.model ?? '').trim();
    if (!id) throw new TypeError('Capability declaration requires id');
    const profile = {
      id,
      label: spec.label ?? id,
      archetype: spec.archetype ?? spec.profile ?? null,
      source: 'declared',
      readOnly: spec.readOnly === true,
      defaultMaxSteps: spec.defaultMaxSteps ?? null,
      toolAllow: Array.isArray(spec.toolAllow) ? [...new Set(spec.toolAllow.map(String))] : [],
      capabilities: declaredVector(spec),
      metadata: spec.metadata ? structuredClone(spec.metadata) : {},
      registeredAt: spec.registeredAt ?? Date.now(),
    };
    this.declared.set(id, profile);
    this.#persist(id);
    return freezeSnapshot({ ...profile, capabilities: { ...profile.capabilities }, toolAllow: [...profile.toolAllow] });
  }

  register(spec = {}) {
    return this.registerDeclared(spec);
  }

  /**
   * Evidence-backed capability updates are intentionally not accepted through the
   * generic recordMeasured name. Callers must provide a durable evaluation result.
   */
  recordMeasured(spec = {}) {
    throw new TypeError('Measured capabilities require recordMeasuredFromEvaluation()');
  }

  recordMeasuredFromEvaluation(spec = {}, evidence = {}) {
    const id = String(spec.id ?? spec.agentId ?? spec.model ?? '').trim();
    if (!id) throw new TypeError('Capability measurement requires id');
    const source = evidence && typeof evidence === 'object' ? evidence : {};
    const evaluationRunId = String(source.evaluationRunId ?? spec.evaluationRunId ?? '').trim();
    const evidenceRefs = [...new Set((source.evidenceRefs ?? spec.evidenceRefs ?? []).map(String).filter(Boolean))];
    if (!evaluationRunId || evidenceRefs.length === 0) {
      throw new TypeError('Capability measurement requires evaluationRunId and evidenceRefs');
    }
    const run = this.store?.get ? (() => { try { return this.store.get('evaluation_runs', evaluationRunId); } catch { return null; } })() : null;
    const taskIds = [...new Set((source.taskIds ?? spec.taskIds ?? []).map(String).filter(Boolean))];
    if (this.store && (!run || run.status !== 'completed' || run.synthetic !== true || !run.score)) {
      throw new TypeError('Capability measurement requires a persisted completed evaluation run');
    }
    if (run && source.benchmarkId && source.benchmarkId !== run.benchmarkId) throw new TypeError('Benchmark evidence does not match evaluation run');
    if (run && source.benchmarkVersion && source.benchmarkVersion !== run.benchmarkVersion) throw new TypeError('Benchmark version does not match evaluation run');
    if (run && source.datasetVersion && source.datasetVersion !== run.datasetVersion) throw new TypeError('Dataset version does not match evaluation run');
    const resultEvidence = (run?.results ?? []).filter((result) =>
      result && (taskIds.length === 0 || taskIds.includes(String(result.taskId))) &&
      (evidenceRefs.includes(String(result.artifactId ?? '')) || evidenceRefs.includes(String(result.evidenceRef ?? '')) || evidenceRefs.includes(`evaluation:${evaluationRunId}:${result.taskId}`)),
    );
    if (this.store && !resultEvidence.length) throw new TypeError('Capability measurement evidence must reference evaluation results from the run');
    const verifiedResults = this.store
      ? resultEvidence.filter((result) => result.status === 'passed' && result.passed === true)
      : [{ taskId: taskIds[0] ?? 'external-evidence', status: 'passed', passed: true }];
    const failedResults = resultEvidence.filter((result) => result.status === 'failed' || result.status === 'timeout' || result.status === 'cancelled');
    const sampleCount = verifiedResults.length + failedResults.length;
    if (sampleCount < 1) throw new TypeError('Capability measurement requires completed judged task evidence');
    const empirical = verifiedResults.length / sampleCount;
    const confidence = measuredConfidence({ sampleCount, confidence: undefined });
    const capabilities = normalizeVector(spec.capabilities ?? spec.vector ?? {});
    const rankingEligible = sampleCount >= this.minRankingSamples;
    const rankingStatus = rankingEligible ? 'eligible' : 'provisional_low_sample';
    const layered = spec.layered ? structuredClone(spec.layered) : null;
    const measurement = {
      id,
      source: 'measured',
      sampleCount,
      confidence,
      rankingEligible,
      rankingStatus,
      empiricalScore: run ? Number(empirical.toFixed(4)) : (spec.empiricalScore == null ? Number(empirical.toFixed(4)) : clamp(spec.empiricalScore)),
      capabilities,
      layered,
      metrics: { ...(spec.metrics ? structuredClone(spec.metrics) : {}), passedSamples: verifiedResults.length, failedSamples: failedResults.length },
      lastMeasuredAt: spec.lastMeasuredAt ?? Date.now(),
      evidenceRefs,
      evaluation: {
        evaluationRunId,
        benchmarkId: run?.benchmarkId ?? source.benchmarkId ?? spec.benchmarkId ?? null,
        benchmarkVersion: run?.benchmarkVersion ?? source.benchmarkVersion ?? spec.benchmarkVersion ?? null,
        datasetVersion: run?.datasetVersion ?? source.datasetVersion ?? spec.datasetVersion ?? null,
        sampleTaskIds: resultEvidence.map((result) => result.taskId),
      },
    };
    this.measured.set(id, measurement);
    this.#persist(id);
    return freezeSnapshot({ ...measurement, capabilities: { ...capabilities }, evidenceRefs: [...evidenceRefs] });
  }

  getDeclared(id) {
    const value = this.declared.get(String(id));
    return value ? freezeSnapshot({ ...value, capabilities: { ...value.capabilities }, toolAllow: [...value.toolAllow] }) : null;
  }

  getMeasured(id) {
    const value = this.measured.get(String(id));
    return value ? freezeSnapshot({ ...value, capabilities: { ...value.capabilities }, evidenceRefs: [...value.evidenceRefs] }) : null;
  }

  getEffectiveCapability(id) {
    const key = String(id);
    const declared = this.declared.get(key) ?? null;
    const measured = this.measured.get(key) ?? null;
    const rawConfidence = measured?.confidence ?? 0;
    const rankingEligible = measured
      ? (measured.rankingEligible ?? (Number(measured.sampleCount ?? 0) >= this.minRankingSamples))
      : false;
    const rankingStatus = measured
      ? (measured.rankingStatus ?? (rankingEligible ? 'eligible' : 'provisional_low_sample'))
      : 'unmeasured';
    const confidence = measured && !rankingEligible
      ? Math.min(rawConfidence, LOW_SAMPLE_BLEND_CAP)
      : rawConfidence;
    const effective = {};
    for (const dimension of CAPABILITY_DIMENSIONS) {
      const d = declared?.capabilities?.[dimension] ?? 0;
      const m = measured?.capabilities?.[dimension] ?? d;
      effective[dimension] = Number(((1 - confidence) * d + confidence * m).toFixed(4));
    }
    return {
      id: key,
      declared: declared ? { ...declared, capabilities: { ...declared.capabilities } } : null,
      measured: measured ? { ...measured, capabilities: { ...measured.capabilities } } : null,
      effective: {
        ...effective,
        confidence,
        rawConfidence,
        rankingEligible,
        rankingStatus,
        layered: measured?.layered ?? null,
        empiricalScore: measured?.empiricalScore ?? null,
      },
    };
  }

  getEffective(id) {
    return this.getEffectiveCapability(id);
  }

  list() {
    const ids = new Set([...this.declared.keys(), ...this.measured.keys()]);
    return [...ids].map((id) => this.getEffectiveCapability(id));
  }

  snapshot() {
    return this.list().map((entry) => structuredClone(entry));
  }
}
export function createCapabilityProfileRegistry(options) {
  return new CapabilityProfileRegistry(options);
}

export { normalizeVector as normalizeCapabilityVector, measuredConfidence };
