import { CAPABILITY_DIMENSIONS } from './capabilities.js';

/**
 * Layer 6 AdaptiveModelRouter selects the best (model, provider, profile) tuple
 * for a task/node based on 8-dimensional model capabilities, task features, budget, and health.
 */
export class AdaptiveModelRouter {
  constructor({ modelRegistry, agentRegistry, pool = null }) {
    this.modelRegistry = modelRegistry;
    this.agentRegistry = agentRegistry;
    this.pool = pool;
  }

  select({
    taskType = 'general',
    objective = '',
    requiredTools = [],
    requiresVision = false,
    minContext = 0,
    budget = {},
    preferredModel = null,
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
      };
    }

    const weights = { ...profile.weights };
    if (budget?.preferFast) weights.speed = Math.max(weights.speed, 1.15);
    if (requiresVision) weights.multimodal = 2.0;
    if (minContext >= 120000) weights.contextCapacity = 1.2;

    let best = null;
    for (const c of candidates) {
      // Hard compatibility constraints get steep penalty if alternatives exist
      let penalty = 0;
      if (!c.healthy) penalty += 3.0;
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
      let score = totalWeight > 0 ? rawScore / totalWeight : 0.5;
      if (preferredModel && c.model === preferredModel) score += 0.25;
      score -= penalty;

      if (!best || score > best.score) {
        best = {
          model: c.model,
          provider: c.provider,
          profile,
          score: Number(score.toFixed(4)),
          rationale: `archetype=${profile.archetype}, healthy=${c.healthy}, costWeight=${c.costWeight}`,
        };
      }
    }

    return best;
  }
}
