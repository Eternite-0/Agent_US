import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../../src/store.js';
import { AccountPool } from '../../src/pool.js';
import { ModelCapabilityRegistry, AgentCapabilityRegistry } from '../../src/swarm/capabilities.js';
import { AdaptiveModelRouter } from '../../src/swarm/router.js';
import { CapabilityProfileRegistry } from '../../src/swarm/capability-registry.js';
import { BENCHMARK_ID, deriveLayeredCapabilities, EvaluationService } from '../../src/evaluation/service.js';
import { createBenchmarkDataset } from '../../src/evaluation/dataset.js';

function rmSafe(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup lock on Windows
  }
}

test('deriveLayeredCapabilities preserves engineering/execution signal separately from strict manifest compliance', () => {
  const realTaskIds = [
    'real-multi-file-feature-01',
    'real-bug-fix-01',
    'real-codebase-analysis-01',
    'real-refactor-01',
    'real-tests-01',
    'real-api-compat-01',
    'real-security-audit-01',
    'real-data-processing-01',
    'real-recovery-01',
    'real-multi-agent-01',
  ];
  const eightImplZeroManifest = realTaskIds.map((taskId, idx) => ({
    taskId,
    status: 'failed',
    passed: false,
    durationMs: 12_000,
    telemetry: {
      toolReceiptCount: 4,
      toolReceiptSuccessCount: idx < 8 ? 4 : 2,
      stepUsage: { steps: idx < 8 ? 10 : 16 },
      tokenUsage: { inputTokens: 2000, outputTokens: 800 },
    },
    judge: {
      passed: false,
      deterministic: true,
      evidence: {
        implementationPassed: idx < 8,
        testsPassed: idx < 8,
        evidenceCompliant: false,
      },
    },
  }));

  const partialLayered = deriveLayeredCapabilities(eightImplZeroManifest, {
    passRate: 0,
    meanDurationMs: 12_000,
  });
  assert.equal(partialLayered.engineering.fullAcceptanceRate, 0);
  assert.equal(partialLayered.engineering.evidenceComplianceRate, 0);
  assert.equal(partialLayered.engineering.implementationRate, 0.8);
  assert.equal(partialLayered.engineering.testPassRate, 0.8);
  assert.ok(partialLayered.engineering.score > 0.4, 'working code + tests must remain visible in engineering score');
  assert.ok(partialLayered.execution.toolSuccessRate >= 0.8);

  const totalZeroResults = realTaskIds.map((taskId) => ({
    taskId,
    status: 'failed',
    passed: false,
    durationMs: 12_000,
    errorCode: 'STEP_BUDGET_EXHAUSTED',
    telemetry: { toolReceiptCount: 2, toolReceiptSuccessCount: 0, stepUsage: { steps: 16 } },
    judge: {
      passed: false,
      deterministic: true,
      evidence: {
        implementationPassed: false,
        testsPassed: false,
        evidenceCompliant: false,
      },
    },
  }));
  const zeroLayered = deriveLayeredCapabilities(totalZeroResults, { passRate: 0, meanDurationMs: 12_000 });
  assert.equal(zeroLayered.engineering.score, 0);
  assert.equal(zeroLayered.execution.budgetCompletionRate, 0);
  assert.ok(partialLayered.engineering.score > zeroLayered.engineering.score);
});

test('CapabilityProfileRegistry enforces evaluation binding and low-sample confidence gating without tainting provider health', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-cap-layered-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  pool.createAccount({
    preset: 'custom-openai',
    label: 'Primary',
    endpoint: 'https://api.example.invalid/v1',
    credential: 'sk-test-layered',
    models: ['layered-model'],
  });
  pool.setDefaultModel('layered-model');

  const registry = new CapabilityProfileRegistry({ store, minRankingSamples: 5 });
  assert.throws(
    () => registry.recordMeasured({ id: 'layered-model', capabilities: { coding: 1 } }),
    /recordMeasuredFromEvaluation/,
  );

  let mode = 'low-sample-partial';
  const evalService = new EvaluationService({
    store,
    capabilityRegistry: registry,
    runtimeFactory: async ({ task }) => ({
      output: JSON.stringify({ taskId: task.id, ok: false }),
      telemetry: { toolReceipts: [], stepUsage: { steps: 6 } },
    }),
    judge: async ({ task }) => ({
      passed: mode === 'full-pass',
      score: mode === 'full-pass' ? 1 : 0,
      deterministic: true,
      evidence: {
        implementationPassed: mode !== 'all-fail',
        testsPassed: mode !== 'all-fail',
        evidenceCompliant: mode === 'full-pass',
      },
    }),
    timeoutMs: 2_000,
  });

  t.after(async () => {
    await evalService.close({ timeoutMs: 500 });
    store.close();
    rmSafe(dir);
  });

  registry.registerDeclared({
    id: 'layered-model',
    capabilities: { coding: 0.9, reasoning: 0.9, research: 0.9, planning: 0.9 },
  });

  // Run 2 tasks (< minRankingSamples=5) -> provisional_low_sample and capped blend confidence <= 0.25
  const smallRun = evalService.start({
    benchmarkId: BENCHMARK_ID,
    taskIds: ['code-generation-repair-01', 'unfamiliar-codebase-analysis-01'],
    model: 'layered-model',
    concurrency: 1,
  });
  for (let i = 0; i < 80; i++) {
    if (evalService.getRun(smallRun.id)?.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 15));
  }
  const smallMeasured = registry.getMeasured('layered-model');
  assert.equal(smallMeasured.evaluation.evaluationRunId, smallRun.id);
  assert.equal(smallMeasured.empiricalScore, 0);
  assert.equal(smallMeasured.rankingEligible, false);
  assert.equal(smallMeasured.rankingStatus, 'provisional_low_sample');
  assert.ok(smallMeasured.layered.engineering.implementationRate === 1);
  assert.ok(smallMeasured.capabilities.coding > 0.5, 'coding retains implementation+test signal');

  const smallEffective = registry.getEffectiveCapability('layered-model');
  assert.ok(smallEffective.effective.confidence <= 0.25, 'low-sample blend must be capped');
  assert.equal(smallEffective.effective.empiricalScore, 0);
  assert.equal(smallEffective.effective.rankingStatus, 'provisional_low_sample');

  const router = new AdaptiveModelRouter({
    modelRegistry: new ModelCapabilityRegistry(pool),
    agentRegistry: new AgentCapabilityRegistry(),
    pool,
    capabilityRegistry: registry,
  });
  const routed = router.select({ taskType: 'implementation' });
  const cand = routed.explanation.candidates[0];
  assert.equal(cand.providerHealthy, true);
  assert.equal(cand.rankingStatus, 'provisional_low_sample');
  assert.equal(cand.layeredCapability.engineering.evidenceComplianceRate, 0);

  // Full 5-sample passing run unlocks eligible ranking
  mode = 'full-pass';
  const fiveIds = createBenchmarkDataset().slice(0, 5).map((item) => item.id);
  const bigRun = evalService.start({
    benchmarkId: BENCHMARK_ID,
    taskIds: fiveIds,
    model: 'layered-model',
    concurrency: 1,
  });
  for (let i = 0; i < 100; i++) {
    if (evalService.getRun(bigRun.id)?.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 15));
  }
  const fullEffective = registry.getEffectiveCapability('layered-model');
  assert.equal(fullEffective.measured.empiricalScore, 1);
  assert.equal(fullEffective.effective.rankingEligible, true);
  assert.equal(fullEffective.effective.rankingStatus, 'eligible');
  assert.equal(fullEffective.measured.layered.engineering.fullAcceptanceRate, 1);
});
