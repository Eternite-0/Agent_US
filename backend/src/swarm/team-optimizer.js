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
  constructor({ defaultMaxConcurrency = 4, teamSize = 2, reviewerCost = 1 } = {}) {
    this.defaultMaxConcurrency = Math.max(1, Number(defaultMaxConcurrency) || 4);
    this.teamSize = Math.max(2, Number(teamSize) || 2);
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
    const maxBudget = numeric(budget.maxCost ?? budget.maxTokens ?? budgetSnapshot?.remaining ?? Infinity, Infinity);
    const single = available[0] ?? null;
    const singleCost = single ? estimateCost(single, task) : Infinity;

    if (!single) {
      return {
        mode: 'single', members: [], reviewer: null, estimatedCost: 0, estimatedSteps: 0,
        rationale: 'no healthy candidate is available', evidencePolicy: evidencePolicy(),
        replacementPolicy: 'replace only after preserving evidence',
      };
    }

    const memberCount = Math.min(this.teamSize, limit, Math.max(1, workstreams));
    const reviewer = reviewerAvailable && available.length > 1
      ? (available.find((candidate) =>
          candidate.role === 'reviewer' || candidate.role === 'review' || /review|verify|audit/i.test(candidate.id),
        ) ?? null)
      : null;
    const workerPool = reviewer ? available.filter((candidate) => candidate.id !== reviewer.id) : available;
    const members = workerPool.slice(0, memberCount);
    const teamCost = members.reduce((sum, member) => sum + estimateCost(member, task), 0)
      + (reviewer ? this.reviewerCost : 0);
    const budgetAllowsTeam = teamCost <= maxBudget;
    const mode = teamWanted && members.length > 1 && budgetAllowsTeam && maxC > 1 ? 'team' : 'single';
    const selected = mode === 'team' ? members : [single];
    const estimatedCost = selected.reduce((sum, member) => sum + estimateCost(member, task), 0)
      + (mode === 'team' && reviewer && !selected.some((member) => member.id === reviewer.id) ? this.reviewerCost : 0);

    return {
      mode,
      members: selected.map((member) => ({
        id: member.id,
        role: member.role ?? (member === single ? 'primary' : 'worker'),
        capabilityScore: Number(member.capabilityScore.toFixed(4)),
        historyScore: Number(member.historyScore.toFixed(4)),
        estimatedCost: estimateCost(member, task),
      })),
      reviewer: mode === 'team' && reviewer
        ? { id: reviewer.id, required: true, reason: 'independent evidence/conclusion review' }
        : null,
      estimatedCost,
      estimatedSteps: selected.reduce((sum, member) => sum + numeric(member.estimatedSteps ?? task.estimatedSteps ?? 1, 1), 0),
      rationale: mode === 'team'
        ? `team selected for ${workstreams} independent workstreams/risk; budget and concurrency allow it`
        : teamWanted && !budgetAllowsTeam
          ? 'team request downgraded because the available budget is insufficient'
          : 'single agent is sufficient for this task shape',
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


