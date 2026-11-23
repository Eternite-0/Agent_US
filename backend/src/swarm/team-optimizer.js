import { CAPABILITY_DIMENSIONS } from './capabilities.js';

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function numeric(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function capabilityScore(candidate, task = {}) {
  const caps = candidate.effectiveCapabilities ?? candidate.capabilities ?? candidate.profile?.capabilities ?? {};
  const requirements = task.requiredCapabilities ?? task.capabilityWeights ?? {};
  const dimensions = Object.keys(requirements).length
    ? Object.keys(requirements)
    : CAPABILITY_DIMENSIONS;
  let total = 0;
  let weight = 0;
  for (const dimension of dimensions) {
    const w = Math.max(0, numeric(requirements[dimension], 1));
    total += clamp(caps[dimension] ?? 0.5) * w;
    weight += w;
  }
  return weight ? total / weight : 0.5;
}

function candidateId(candidate, index) {
  return String(candidate.id ?? candidate.agentId ?? candidate.model ?? `candidate-${index}`);
}

function historyScore(candidate, history = {}) {
  const id = candidateId(candidate, 0);
  const record = history instanceof Map ? history.get(id) : history[id];
  if (record == null) return clamp(candidate.empiricalScore ?? candidate.historyScore ?? 0.5);
  if (typeof record === 'number') return clamp(record);
  return clamp(record.empiricalScore ?? record.score ?? record.successRate ?? 0.5);
}

function estimateCost(candidate, task = {}) {
  const tokens = numeric(candidate.estimatedTokens ?? task.estimatedTokens ?? 1000, 1000);
  const unit = numeric(candidate.costPerToken ?? candidate.costWeight ?? 1, 1);
  return Math.max(0, tokens * unit);
}

function evidencePolicy() {
  return Object.freeze({
    retainReplacedMember: true,
    retainArtifacts: true,
    retainReceipts: true,
    requireReviewerForConflict: true,
  });
}

/**
 * Pure planning layer for choosing one worker or a bounded team. It does not
 * spawn children, reserve budget, or mutate durable swarm state.
 */
export class TeamOptimizer {
  constructor({ defaultMaxConcurrency = 6, teamSize = undefined, maxTeamSize = 8, reviewerCost = 1 } = {}) {
    this.defaultMaxConcurrency = Math.max(1, Number(defaultMaxConcurrency) || 6);
    if (teamSize !== undefined && teamSize !== null) {
      this.hasExplicitTeamSize = true;
      this.teamSize = Math.max(2, Number(teamSize) || 2);
      this.maxTeamSize = this.teamSize;
    } else {
      this.hasExplicitTeamSize = false;
      this.maxTeamSize = Math.max(2, Number(maxTeamSize) || 8);
      this.teamSize = this.maxTeamSize;
    }
    this.reviewerCost = Math.max(0, Number(reviewerCost) || 1);
  }

  optimize({
    task = {},
    candidates = [],
    budget = {},
    budgetSnapshot = null,
    maxConcurrency = this.defaultMaxConcurrency,
    history = {},
    reviewerAvailable = false,
  } = {}) {
    const available = candidates
      .map((candidate, index) => ({
        ...candidate,
        id: candidateId(candidate, index),
        capabilityScore: capabilityScore(candidate, task),
        historyScore: historyScore(candidate, history),
      }))
      .filter((candidate) => candidate.healthy !== false && candidate.available !== false)
      .sort((a, b) => (b.capabilityScore + b.historyScore) - (a.capabilityScore + a.historyScore));

    const maxC = Math.max(1, Number(maxConcurrency) || 1);
    const limit = Math.min(maxC, available.length || 1);
    const simple = task.simple === true || (task.complexity ?? 'normal') === 'simple';
    const workstreams = Math.max(1, Number(task.independentWorkstreams ?? 1));
    const highRisk = task.artifactRisk === 'high' || task.requiresIndependentVerification === true;
    const teamRequested = task.mode === 'team' || task.preferTeam === true;
    const teamWanted = !simple && (teamRequested || workstreams > 1 || highRisk);
    const limitOf = (...values) => Math.min(Infinity, ...values.filter((v) => v != null).map(Number).filter(Number.isFinite));
    const costLimit = limitOf(budget.maxCost, budgetSnapshot?.remainingCost, budget.maxCostUsd === 0 ? 0 : null);
    const tokenLimit = limitOf(budget.maxTokens, budget.maxTotalTokens, budgetSnapshot?.remainingTokens, budgetSnapshot?.remaining);
    const stepLimit = limitOf(budget.maxSteps, budget.maxTotalSteps, budgetSnapshot?.remainingSteps);
    const tokens = (c) => Math.max(0, numeric(c.estimatedTokens ?? task.estimatedTokens, 1000));
    const steps = (c) => Math.max(1, numeric(c.estimatedSteps ?? task.estimatedSteps, 1));
    const single = available[0] ?? null;

    if (!single) {
      return {
        mode: 'single', members: [], reviewer: null, estimatedCost: 0, estimatedSteps: 0,
        recommendedTeamSize: 0,
        rationale: 'no healthy candidate is available', evidencePolicy: evidencePolicy(),
        replacementPolicy: 'replace only after preserving evidence',
        budgetDowngraded: false, parallelBudgetAllowed: false,
      };
    }

    const explicitTaskCap =
      task.teamSize !== undefined && task.teamSize !== null
        ? Math.max(1, Number(task.teamSize) || 1)
        : null;
    const effectiveTeamCap = this.hasExplicitTeamSize
      ? this.teamSize
      : explicitTaskCap !== null
        ? Math.min(this.maxTeamSize, explicitTaskCap)
        : Math.min(this.maxTeamSize, Math.max(2, workstreams));

    const targetWorkerCount = Math.min(effectiveTeamCap, limit, Math.max(1, workstreams));
    const requiredWorkerCount = Math.min(effectiveTeamCap, maxC, Math.max(1, workstreams));
    const explicitReviewer = reviewerAvailable && available.length > 1
      ? (available.find((candidate) =>
          candidate.role === 'reviewer' || candidate.role === 'review' || /review|verify|audit/i.test(candidate.id),
        ) ?? null)
      : null;
    const primaryModel = single.model ?? single.id;
    const distinctHighRiskReviewer = !explicitReviewer &&
      reviewerAvailable &&
      highRisk &&
      (task.requireDistinctReviewerModel === true ? available.length > 1 : available.length >= requiredWorkerCount + 1)
      ? (available.find((candidate) => (candidate.model ?? candidate.id) !== primaryModel) ?? null)
      : null;
    const reviewer = explicitReviewer ?? distinctHighRiskReviewer;
    const workerPool = reviewer ? available.filter((candidate) => candidate.id !== reviewer.id) : available;
    const selectWorkers = (count) => {
      if (workerPool.length >= 2 && count > workerPool.length) {
        return Array.from({ length: count }, (_, idx) => workerPool[idx % workerPool.length]);
      }
      return workerPool.slice(0, count);
    };

    let members = selectWorkers(targetWorkerCount);
    const fits = (workers, review = null) => {
      const all = review ? [...workers, review] : workers;
      return all.reduce((sum, c) => sum + tokens(c), 0) <= tokenLimit
        && all.reduce((sum, c) => sum + steps(c), 0) <= stepLimit
        && all.reduce((sum, c) => sum + estimateCost(c, task), review ? this.reviewerCost : 0) <= costLimit;
    };
    let budgetScaledFrom = null;
    while (teamWanted && members.length > 2 && !fits(members, reviewer)) {
      budgetScaledFrom ??= members.length;
      members = members.slice(0, -1);
    }
    const minTeamMembersRequired = budgetScaledFrom !== null ? 2 : requiredWorkerCount;
    const budgetAllowsTeam = fits(members, reviewer);
    const mode =
      teamWanted &&
      members.length >= minTeamMembersRequired &&
      budgetAllowsTeam &&
      maxC > 1
        ? 'team'
        : 'single';
    const parallelSlots = Math.min(effectiveTeamCap, maxC, workstreams);
    const budgetDowngraded = Boolean(teamWanted && !budgetAllowsTeam);
    const parallelBudgetAllowed = mode === 'team' ? budgetAllowsTeam : fits(Array.from({ length: parallelSlots }, () => single));
    const selected = mode === 'team' ? members : [single];
    const estimatedCost = selected.reduce((sum, member) => sum + estimateCost(member, task), 0)
      + (mode === 'team' && reviewer && !selected.some((member) => member.id === reviewer.id) ? this.reviewerCost + estimateCost(reviewer, task) : 0);
    const roleHints = Array.isArray(task.workstreamRoles)
      ? task.workstreamRoles
      : Array.isArray(task.roles)
        ? task.roles
        : [];

    return {
      mode,
      recommendedTeamSize: selected.length,
      ...(budgetScaledFrom !== null ? { budgetScaledFrom } : {}),
      members: selected.map((member, idx) => {
        const hint = roleHints[idx] && typeof roleHints[idx] === 'object' ? roleHints[idx] : null;
        return {
          id: member.id,
          role: hint?.role ?? member.role ?? (member === single ? 'primary' : 'worker'),
          ...(hint?.roleTitle ? { roleTitle: String(hint.roleTitle) } : {}),
          ...(hint?.focus ? { focus: String(hint.focus) } : {}),
          ...(Array.isArray(hint?.ownedPaths) ? { ownedPaths: hint.ownedPaths.map(String) } : {}),
          capabilityScore: Number(member.capabilityScore.toFixed(4)),
          historyScore: Number(member.historyScore.toFixed(4)),
          estimatedCost: estimateCost(member, task),
        };
      }),
      reviewer: mode === 'team' && reviewer
        ? {
            id: reviewer.id,
            model: reviewer.model ?? reviewer.id,
            provider: reviewer.provider ?? null,
            role: reviewer.role ?? 'reviewer',
            capabilityScore: Number(reviewer.capabilityScore.toFixed(4)),
            historyScore: Number(reviewer.historyScore.toFixed(4)),
            required: true,
            reason: 'independent evidence/conclusion review',
          }
        : null,
      estimatedCost,
      estimatedSteps: selected.reduce((sum, member) => sum + steps(member), mode === 'team' && reviewer ? steps(reviewer) : 0),
      parallelSlots,
      rationale: mode === 'team'
        ? budgetScaledFrom !== null
          ? `team scaled dynamically from ${budgetScaledFrom} to ${selected.length} workers to fit remaining budget`
          : `team of ${selected.length} selected for ${workstreams} independent workstreams/risk; budget and concurrency allow it`
        : teamWanted && !budgetAllowsTeam
          ? 'team request downgraded because the available budget is insufficient'
          : teamWanted ? 'one worker selected within the available candidate and concurrency limits' : 'one workstream covers this task without coordination overhead',
      budgetDowngraded,
      parallelBudgetAllowed,
      evidencePolicy: evidencePolicy(),
      replacementPolicy: 'replace only after preserving node identity, artifacts, receipts, and verifier evidence',
    };
  }

  replaceMember({ plan, failedMemberId, candidates = [], reason = 'member unavailable', preservedEvidence = [] } = {}) {
    const oldMember = plan?.members?.find((member) => member.id === failedMemberId);
    if (!oldMember) throw new Error(`Unknown team member: ${failedMemberId}`);
    const used = new Set((plan.members ?? []).map((member) => member.id));
    const replacement = candidates.find((candidate) => {
      const id = candidateId(candidate, 0);
      return !used.has(id) && candidate.healthy !== false && candidate.available !== false;
    });
    if (!replacement) throw new Error('No healthy replacement candidate is available');
    const newMember = { id: candidateId(replacement, 0), role: oldMember.role ?? 'worker', replacementOf: oldMember.id };
    const nextPlan = {
      ...plan,
      members: plan.members.map((member) => member.id === oldMember.id ? newMember : member),
      replacementEvents: [
        ...(plan.replacementEvents ?? []),
        {
          type: 'member_replaced',
          oldMember: { ...oldMember },
          newMember: { ...newMember },
          reason,
          preservedEvidence: structuredClone(preservedEvidence),
        },
      ],
    };
    return nextPlan;
  }
}

export function optimizeTeam(options) {
  return new TeamOptimizer(options).optimize(options);
}


