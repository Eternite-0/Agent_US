import { CAPABILITY_DIMENSIONS } from './capabilities.js';

const DEFAULT_CONFIDENCE_PRIOR = 10;

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
  constructor({ priorWeight = DEFAULT_CONFIDENCE_PRIOR, store = null, kind = 'capability_profiles' } = {}) {
    this.priorWeight = Math.max(1, Number(priorWeight) || DEFAULT_CONFIDENCE_PRIOR);
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
    const sampleCount = Math.max(1, Number(spec.sampleCount ?? source.sampleCount ?? 1));
    const confidence = measuredConfidence({ sampleCount, confidence: undefined });
    const capabilities = normalizeVector(spec.capabilities ?? spec.vector ?? {});
    const measurement = {
      id,
      source: 'measured',
      sampleCount,
      confidence,
      empiricalScore: spec.empiricalScore == null ? null : clamp(spec.empiricalScore),
      capabilities,
      metrics: spec.metrics ? structuredClone(spec.metrics) : {},
      lastMeasuredAt: spec.lastMeasuredAt ?? Date.now(),
      evidenceRefs,
      evaluation: {
        evaluationRunId,
        benchmarkId: source.benchmarkId ?? spec.benchmarkId ?? null,
        benchmarkVersion: source.benchmarkVersion ?? spec.benchmarkVersion ?? null,
        datasetVersion: source.datasetVersion ?? spec.datasetVersion ?? null,
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
    const confidence = measured?.confidence ?? 0;
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
