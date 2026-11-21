import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityProfileRegistry } from '../src/swarm/capability-registry.js';
import { TeamOptimizer } from '../src/swarm/team-optimizer.js';
import { ResultAggregator } from '../src/swarm/result-aggregator.js';

test('Swarm capability profiles keep declared and measured evidence distinct', () => {
  const registry = new CapabilityProfileRegistry();
  registry.registerDeclared({
    id: 'agent-impl',
    archetype: 'implementation',
    readOnly: false,
    toolAllow: ['read_file', 'edit_file'],
    capabilities: { coding: 0.9, reasoning: 0.7, speed: 0.5 },
  });
  registry.recordMeasured({
    id: 'agent-impl',
    sampleCount: 10,
    capabilities: { coding: 0.6, reasoning: 0.8, speed: 0.9 },
    empiricalScore: 0.78,
    metrics: { successRate: 0.8, avgLatencyMs: 1200 },
    evidenceRefs: ['receipt:1', 'verdict:1'],
  });

  const profile = registry.getEffectiveCapability('agent-impl');
  assert.equal(profile.declared.source, 'declared');
  assert.equal(profile.measured.source, 'measured');
  assert.equal(profile.declared.capabilities.coding, 0.9);
  assert.equal(profile.measured.capabilities.coding, 0.6);
  assert.equal(profile.measured.empiricalScore, 0.78);
  assert.deepEqual(profile.measured.evidenceRefs, ['receipt:1', 'verdict:1']);
  assert.ok(profile.effective.coding < 0.9 && profile.effective.coding > 0.6);
  assert.equal(registry.getDeclared('agent-impl').readOnly, false);
  assert.equal(registry.getMeasured('agent-impl').metrics.successRate, 0.8);
});

test('TeamOptimizer chooses one agent for simple work and bounds teams by concurrency', () => {
  const optimizer = new TeamOptimizer({ defaultMaxConcurrency: 4, teamSize: 3 });
  const candidates = [
    { id: 'fast', capabilities: { coding: 1, reasoning: 1, research: 1, planning: 1, speed: 1, contextCapacity: 1, multimodal: 1, toolCompatibility: 1 }, historyScore: 0.99, estimatedTokens: 100 },
    { id: 'deep', capabilities: { coding: 0.8, reasoning: 0.8, research: 0.2, planning: 0.2, speed: 0.2, contextCapacity: 0.2, multimodal: 0.1, toolCompatibility: 0.2 }, historyScore: 0.5, estimatedTokens: 200 },
    { id: 'review', role: 'reviewer', capabilities: { reasoning: 1, planning: 1 }, historyScore: 0.9, estimatedTokens: 120 },
  ];

  const simple = optimizer.optimize({
    task: { simple: true, requiredCapabilities: { coding: 1 } },
    candidates,
    maxConcurrency: 3,
  });
  assert.equal(simple.mode, 'single');
  assert.equal(simple.members.length, 1);
  assert.equal(simple.members[0].id, 'fast');

  const team = optimizer.optimize({
    task: {
      complexity: 'complex',
      independentWorkstreams: 3,
      requiredCapabilities: { coding: 1, reasoning: 1 },
      artifactRisk: 'high',
      estimatedTokens: 100,
    },
    candidates,
    maxConcurrency: 2,
    reviewerAvailable: true,
    budget: { maxCost: 1000 },
  });
  assert.equal(team.mode, 'team');
  assert.equal(team.members.length, 2);
  assert.ok(team.reviewer);
  assert.equal(team.reviewer.id, 'review');
  assert.ok(team.evidencePolicy.retainArtifacts);
  assert.equal(team.evidencePolicy.requireReviewerForConflict, true);
});

test('TeamOptimizer downgrades a requested team when budget is insufficient', () => {
  const optimizer = new TeamOptimizer({ teamSize: 3 });
  const plan = optimizer.optimize({
    task: { mode: 'team', independentWorkstreams: 2, estimatedTokens: 100 },
    candidates: [
      { id: 'a', capabilities: { coding: 0.9 }, estimatedTokens: 100, costWeight: 1 },
      { id: 'b', capabilities: { reasoning: 0.9 }, estimatedTokens: 100, costWeight: 1 },
    ],
    maxConcurrency: 2,
    budget: { maxCost: 100 },
  });
  assert.equal(plan.mode, 'single');
  assert.equal(plan.members.length, 1);
  assert.match(plan.rationale, /budget/i);
});

test('TeamOptimizer replacement preserves old member identity and evidence', () => {
  const optimizer = new TeamOptimizer();
  const plan = {
    mode: 'team',
    members: [
      { id: 'worker-a', role: 'implementation', capabilityScore: 0.8, historyScore: 0.7 },
      { id: 'worker-b', role: 'verification', capabilityScore: 0.7, historyScore: 0.8 },
    ],
    evidencePolicy: { retainArtifacts: true },
  };
  const next = optimizer.replaceMember({
    plan,
    failedMemberId: 'worker-a',
    candidates: [{ id: 'worker-c', healthy: true }],
    reason: 'lease expired',
    preservedEvidence: [
      { artifactUri: 'swarm-artifact://run-1/a', receiptId: 'receipt-a', verifierVerdict: 'fail' },
    ],
  });

  assert.equal(next.members.find((member) => member.id === 'worker-a'), undefined);
  assert.equal(next.members[0].id, 'worker-c');
  assert.equal(next.members[0].replacementOf, 'worker-a');
  assert.equal(next.replacementEvents.length, 1);
  assert.equal(next.replacementEvents[0].oldMember.id, 'worker-a');
  assert.equal(next.replacementEvents[0].preservedEvidence[0].artifactUri, 'swarm-artifact://run-1/a');
});

test('ResultAggregator blocks conflicting conclusions and artifact digests for reviewer', () => {
  const aggregator = new ResultAggregator();
  const aggregate = aggregator.aggregate({
    reviewerAvailable: true,
    results: [
      {
        id: 'node-a',
        nodeKey: 'implement',
        conclusion: 'use cache-v1',
        evidence: ['receipt:a', 'verdict:a'],
        artifacts: [{ path: 'src/cache.js', sha256: 'hash-a', uri: 'swarm-artifact://a' }],
      },
      {
        id: 'node-b',
        nodeKey: 'implement',
        conclusion: 'use cache-v2',
        evidence: ['receipt:b', 'verdict:b'],
        artifacts: [{ path: 'src/cache.js', sha256: 'hash-b', uri: 'swarm-artifact://b' }],
      },
    ],
  });

  assert.equal(aggregate.status, 'review_required');
  assert.equal(aggregate.conflicts.length, 2);
  assert.ok(aggregate.conflicts.some((conflict) => conflict.type === 'conclusion'));
  assert.ok(aggregate.conflicts.some((conflict) => conflict.type === 'artifact'));
  assert.equal(aggregate.candidates.length, 2);
  assert.equal(aggregate.artifacts.length, 2);
  assert.deepEqual(aggregate.evidence.map((item) => item.ref), ['receipt:a', 'verdict:a', 'receipt:b', 'verdict:b']);
});

test('ResultAggregator requires and audits an explicit reviewer decision', () => {
  const aggregator = new ResultAggregator();
  let aggregate = aggregator.aggregate({
    results: [
      { id: 'left', taskKey: 'task-1', conclusion: 'A' },
      { id: 'right', taskKey: 'task-1', conclusion: 'B' },
    ],
  });
  const conflict = aggregate.conflicts[0];
  assert.throws(
    () => aggregator.resolveConflict({ aggregate, conflictId: conflict.id, decision: 'accept_left' }),
    /reviewerId is required/,
  );

  aggregate = aggregator.resolveConflict({
    aggregate,
    conflictId: conflict.id,
    decision: 'accept_left',
    reviewerId: 'reviewer-1',
    rationale: 'left has the passing verification receipt',
    evidenceRefs: ['verdict:left'],
  });
  assert.equal(aggregate.status, 'resolved');
  assert.equal(aggregate.resolved, true);
  assert.equal(aggregate.reviewerDecision.reviewerId, 'reviewer-1');
  assert.equal(aggregate.conflicts[0].resolution.decision, 'accept_left');
  assert.deepEqual(aggregate.conflicts[0].resolution.evidenceRefs, ['verdict:left']);
});



