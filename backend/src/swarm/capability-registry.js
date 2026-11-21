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
  constructor({ priorWeight = DEFAULT_CONFIDENCE_PRIOR } = {}) {
    this.priorWeight = Math.max(1, Number(priorWeight) || DEFAULT_CONFIDENCE_PRIOR);
    this.declared = new Map();
    this.measured = new Map();
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
    return freezeSnapshot({ ...profile, capabilities: { ...profile.capabilities }, toolAllow: [...profile.toolAllow] });
  }

  register(spec = {}) {
    return this.registerDeclared(spec);
  }

  recordMeasured(spec = {}) {
    const id = String(spec.id ?? spec.agentId ?? spec.model ?? '').trim();
    if (!id) throw new TypeError('Capability measurement requires id');
    const sampleCount = Math.max(0, Number(spec.sampleCount ?? spec.samples ?? 0));
    const confidence = clamp(
      spec.confidence ?? (sampleCount > 0 ? sampleCount / (sampleCount + this.priorWeight) : 0),
    );
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
      evidenceRefs: Array.isArray(spec.evidenceRefs) ? [...new Set(spec.evidenceRefs.map(String))] : [],
    };
    this.measured.set(id, measurement);
    return freezeSnapshot({ ...measurement, capabilities: { ...capabilities }, evidenceRefs: [...measurement.evidenceRefs] });
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
