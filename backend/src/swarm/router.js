import { CAPABILITY_DIMENSIONS } from './capabilities.js';

/**
 * Layer 6 AdaptiveModelRouter selects the best (model, provider, profile) tuple
 * by blending static 8-dimensional priors with confidence-weighted empirical feedback.
 */
export class AdaptiveModelRouter {
  constructor({ modelRegistry, agentRegistry, pool = null, feedbackTracker = null, capabilityRegistry = null }) {
    this.modelRegistry = modelRegistry;
    this.agentRegistry = agentRegistry;
    this.pool = pool;
    this.feedbackTracker = feedbackTracker;
    this.capabilityRegistry = capabilityRegistry;
  }

  select({
    taskType = 'general',
    objective = '',
    requiredTools = [],
    requiresVision = false,
    minContext = 0,
    budget = {},
    preferredModel = null,
    excludeModels = [],
    readOnly = undefined,
    maxSteps = undefined,
  } = {}) {
    const profile = this.agentRegistry.synthesizeProfile({
      taskType,
      objective,
      requiredTools,
      readOnly,
      maxSteps,
    });

    const candidates = this.modelRegistry.syncFromPool();
    const defaultModel = this.pool?.getDefaultModel?.() || '';
    if (!candidates.length) {
      return {
        model: defaultModel,
        provider: 'pool',
        profile,
        score: 0,
        rationale: defaultModel ? 'fallback to default model' : 'no model configured',
        explanation: {
          priorScore: 0,
          empiricalScore: null,
          confidence: 0,
          sampleCount: 0,
          metrics: null,
          penalty: 0,
          finalScore: 0,
          candidates: [],
        },
      };
    }

    const weights = { ...profile.weights };
    if (budget?.preferFast) weights.speed = Math.max(weights.speed, 1.15);
    if (requiresVision) weights.multimodal = 2.0;
    if (minContext >= 120000) weights.contextCapacity = 1.2;

    const excludedSet = new Set(Array.isArray(excludeModels) ? excludeModels.map(String).filter(Boolean) : []);
    const hasNonExcludedHealthy = candidates.some((item) => item.healthy !== false && !excludedSet.has(item.model));
    const evaluated = [];
    let best = null;

    for (const baseCandidate of candidates) {
      const persisted = this.capabilityRegistry?.getEffectiveCapability?.(baseCandidate.model) ?? null;
      const c = persisted?.effective
        ? { ...baseCandidate, capabilities: { ...baseCandidate.capabilities, ...Object.fromEntries(CAPABILITY_DIMENSIONS.map((dim) => [dim, persisted.effective[dim]])) }, persistedCapability: persisted }
        : baseCandidate;
      let penalty = 0;
      if (!c.healthy) penalty += 3.0;
      if (hasNonExcludedHealthy && excludedSet.has(c.model)) penalty += 1.5;
      if (requiresVision && !c.capabilities.multimodal) penalty += 5.0;
      if (requiredTools?.length && c.capabilities.toolCompatibility < 0.5) penalty += 4.0;
      if (minContext > 0 && c.contextWindow < minContext) penalty += 2.5;
      if (budget?.maxCostUsd !== undefined && budget.maxCostUsd < 0.05) {
        penalty += Math.max(0, c.costWeight - 0.8) * 1.2;
      }

      let rawScore = 0;
      let totalWeight = 0;
      for (const dim of CAPABILITY_DIMENSIONS) {
        const w = weights[dim] ?? 0.3;
        rawScore += (c.capabilities[dim] ?? 0.5) * w;
        totalWeight += w;
      }
      const priorScore = Number((totalWeight > 0 ? rawScore / totalWeight : 0.5).toFixed(4));
      const reviewStats = taskType === 'review' ? (this.feedbackTracker?.getReviewerStats?.(c.model) ?? null) : null;
      const generalStats = this.feedbackTracker?.getStats?.(c.model, { taskType }) ?? null;
      const fb = reviewStats && reviewStats.sampleCount > 0 ? reviewStats : generalStats;
      const conf = fb?.sampleCount > 0 ? fb.confidence : 0;
      const emp = fb?.empiricalScore ?? null;
      const blended = emp !== null ? (1 - conf) * priorScore + conf * emp : priorScore;
      let finalScore = blended;
      if (preferredModel && c.model === preferredModel) finalScore += 0.25;
      finalScore = Number((finalScore - penalty).toFixed(4));

      const candidateInfo = {
        model: c.model,
        provider: c.provider,
        healthy: c.healthy,
        providerHealthy: c.healthy,
        costWeight: c.costWeight,
        priorScore,
        empiricalScore: emp ?? c.persistedCapability?.effective?.empiricalScore ?? null,
        measuredCapability: c.persistedCapability?.measured ?? null,
        reviewerStats: reviewStats && reviewStats.sampleCount > 0 ? reviewStats : null,
        confidence: Math.max(conf, c.persistedCapability?.effective?.confidence ?? 0),
        sampleCount: fb?.sampleCount ?? 0,
        metrics: fb?.metrics ?? c.persistedCapability?.measured?.metrics ?? null,
        penalty: Number(penalty.toFixed(4)),
        finalScore,
      };
      evaluated.push(candidateInfo);

      if (!best || candidateInfo.finalScore > best.finalScore) {
        best = candidateInfo;
      }
    }

    return {
      model: best.model,
      provider: best.provider,
      profile,
      score: best.finalScore,
      rationale: `archetype=${profile.archetype}, healthy=${best.healthy}, costWeight=${best.costWeight}, confidence=${best.confidence}`,
      explanation: {
        priorScore: best.priorScore,
        empiricalScore: best.empiricalScore,
        confidence: best.confidence,
        sampleCount: best.sampleCount,
        metrics: best.metrics,
        penalty: best.penalty,
        finalScore: best.finalScore,
        candidates: evaluated,
      },
    };
  }
}
