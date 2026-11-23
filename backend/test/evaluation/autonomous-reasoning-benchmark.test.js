import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTONOMOUS_REASONING_BENCHMARK_ID,
  AUTONOMOUS_REASONING_DATASET,
  AUTONOMOUS_REASONING_TASK_IDS,
  FAILURE_ATTRIBUTIONS,
  VERSION,
  applyWorkspaceFiles,
  buildAutonomousReasoningEvidenceOutput,
  classifyAutonomousReasoningAttribution,
  computeAutonomousReasoningMetrics,
  createAutonomousReasoningDataset,
  getAutonomousReasoningReferenceFix,
  instantiateAutonomousReasoningWorkspace,
  materializeAutonomousReasoningRepos,
} from '../../src/evaluation/autonomous-reasoning-benchmark.js';
import {
  createFixtureWorkspace,
  getWorkspaceBaselineCommit,
  listWorkspaceChangedFiles,
  removeFixtureWorkspace,
  verifyWorkspacePinnedBaseline,
} from '../../src/evaluation/fixtures.js';
import { enforceDeterministicHardVeto } from '../../src/evaluation/judge.js';
import { validateTask } from '../../src/evaluation/schemas.js';
import {
  BenchmarkSandbox,
  DockerBenchmarkSandbox,
  SANDBOX_MODES,
  SANDBOX_TIERS,
  SandboxUnavailableError,
  runHardenedGitSync,
} from '../../src/tools/benchmark-sandbox.js';
import {
  loadAndProbeWorktreeArm,
  parseCliArgs,
  runAutonomousReasoningBenchmark,
} from '../../scripts/benchmark-autonomous-reasoning.mjs';

function buildTrustedContext(task, workspaceRoot, sandbox = null) {
  return {
    workspaceRoot,
    ...(sandbox ? { sandbox } : {}),
    attemptId: 'attempt-1',
    planVersion: 1,
    toolReceipts: [
      {
        id: `receipt-${task.id}`,
        toolName: 'bash',
        status: 'finished',
        exitCode: 0,
        command: task.metadata.acceptanceCriteria.testCommand.join(' '),
      },
    ],
    trustedVerdict: {
      status: 'pass',
      source: 'trusted_server_verifier',
      evidenceRefs: [`receipt-${task.id}`],
    },
  };
}

function listBenchmarkContainers() {
  const res = spawnSync(
    'docker',
    ['ps', '-a', '--filter', 'name=agent-us-bench-', '--format', '{{.Names}}'],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000, shell: false },
  );
  if (res.status !== 0) return [];
  return String(res.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('Agent_US 2.4 Autonomous Reasoning Benchmark Suite', () => {
  const strongSandbox = new BenchmarkSandbox({ mode: SANDBOX_MODES.STRONG });

  after(() => {
    const leftover = listBenchmarkContainers();
    assert.deepEqual(leftover, [], `Expected 0 leftover agent-us-bench-* containers, found: ${leftover.join(', ')}`);
  });

  test('Docker strong OS isolation is active and BenchmarkSandbox fails closed when unavailable', () => {
    const dockerProbe = new DockerBenchmarkSandbox().probe();
    assert.equal(dockerProbe.available, true, `Docker sandbox must be available: ${dockerProbe.reason}`);
    const resolved = strongSandbox.resolveBackend();
    assert.equal(resolved.mode, SANDBOX_MODES.DOCKER);
    assert.equal(resolved.isolationTier, SANDBOX_TIERS.STRONG_OS_ISOLATION);
    assert.equal(resolved.strongOsIsolation, true);

    const unavailableSandbox = new BenchmarkSandbox({
      mode: SANDBOX_MODES.STRONG,
      probes: {
        docker: { available: false, reason: 'simulated_docker_unavailable' },
        nodePermission: { available: true },
      },
    });
    assert.throws(() => unavailableSandbox.resolveBackend(), SandboxUnavailableError);
  });

  test('dataset exports exact benchmark ID, version, and all 10 valid task categories without prompt leakage', () => {
    assert.equal(AUTONOMOUS_REASONING_BENCHMARK_ID, 'agent-us-autonomous-reasoning-2.4');
    assert.equal(VERSION, '1.0.0');
    assert.equal(AUTONOMOUS_REASONING_DATASET.length, 10);

    const dataset = createAutonomousReasoningDataset({ sandbox: strongSandbox });
    assert.deepEqual(
      dataset.map((t) => t.id),
      [
        'ar-01-unfamiliar-codebase',
        'ar-02-complex-bug-root-cause',
        'ar-03-multi-file-feature',
        'ar-04-cross-module-refactor',
        'ar-05-security-vuln-fix',
        'ar-06-test-failure-repair',
        'ar-07-multi-stage-dev',
        'ar-08-mid-task-recovery',
        'ar-09-multi-agent-collab',
        'ar-10-long-horizon-delivery',
      ],
    );

    for (const task of dataset) {
      validateTask(task);
      assert.equal(task.metadata.requiresGitDiff, true);
      assert.equal(task.metadata.externalNetwork, false);
      assert.equal(task.metadata.sandboxIsolation.required, true);
      assert.equal(task.metadata.sandboxIsolation.failClosed, true);
      assert.ok(Array.isArray(task.fixture.baselineTestFiles) && task.fixture.baselineTestFiles.length >= 1);
      assert.ok(Object.keys(task.fixture.baselineFileHashes).length >= 1);
      assert.ok(task.metadata.acceptanceCriteria.requiredChangedFiles.length >= 1);
      assert.ok(!task.prompt.includes('CRASH_INTERRUPTED') || task.id === 'ar-08-mid-task-recovery');
      assert.ok(!task.prompt.includes('allocateProportional(totalCents, weights) {\n'));
    }
  });

  test('all 10 tasks instantiate frozen git workspaces (inline and pinned bare mirrors)', async () => {
    const bareRoot = mkdtempSync(join(tmpdir(), 'agent-us-ar-mirrors-'));
    try {
      const { repoOverrides, cleanup } = await materializeAutonomousReasoningRepos(bareRoot);
      const pinnedDataset = createAutonomousReasoningDataset({ sandbox: strongSandbox, repoOverrides });
      assert.equal(pinnedDataset.length, 10);

      await Promise.all(
        pinnedDataset.map(async (task) => {
          assert.match(task.fixture.commit, /^[0-9a-f]{40}$/);
          const ws = await instantiateAutonomousReasoningWorkspace(task, { prefix: `ar-pin-${task.id}-` });
          try {
            const baseCommit = getWorkspaceBaselineCommit(ws);
            assert.equal(baseCommit, task.fixture.commit);
            const check = verifyWorkspacePinnedBaseline(ws, task.fixture.commit);
            assert.equal(check.ok, true, `${task.id} pinned baseline check failed: ${check.reason}`);
            assert.deepEqual(listWorkspaceChangedFiles(ws), []);
          } finally {
            await removeFixtureWorkspace(ws);
          }
        }),
      );

      const inlineDataset = createAutonomousReasoningDataset({ sandbox: strongSandbox });
      const inlineWs = await createFixtureWorkspace(inlineDataset[0]);
      try {
        const base = getWorkspaceBaselineCommit(inlineWs);
        assert.match(base, /^[0-9a-f]{40}$/);
        assert.equal(verifyWorkspacePinnedBaseline(inlineWs, base).ok, true);
      } finally {
        await removeFixtureWorkspace(inlineWs);
      }

      cleanup();
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });

  test('all 10 reference fixes pass inside real Docker BenchmarkSandbox isolation', { concurrency: 4 }, async (t) => {
    const dataset = createAutonomousReasoningDataset({ sandbox: strongSandbox });
    await Promise.all(
      dataset.map((task) =>
        t.test(task.id, async (subT) => {
          const ws = await instantiateAutonomousReasoningWorkspace(task, { prefix: `ar-ref-${task.id}-` });
          subT.after(async () => {
            await removeFixtureWorkspace(ws);
          });
          applyWorkspaceFiles(ws, getAutonomousReasoningReferenceFix(task.id, ws));
          const output = buildAutonomousReasoningEvidenceOutput(task);
          const ctx = buildTrustedContext(task, ws, strongSandbox);
          const judgment = await task.judge({ task, output, context: ctx });

          assert.equal(judgment.passed, true, `${task.id} failed: ${JSON.stringify(judgment.evidence.errors)} checks=${JSON.stringify(judgment.evidence.checks)}`);
          assert.equal(judgment.score, 1);
          assert.equal(judgment.hardVetoed, false);
          assert.equal(judgment.evidence.sandboxIsolated, true);
          assert.equal(judgment.evidence.sandboxBackend, SANDBOX_MODES.DOCKER);
          assert.equal(judgment.evidence.strongOsIsolation, true);
          assert.equal(judgment.evidence.isolationTier, SANDBOX_TIERS.STRONG_OS_ISOLATION);
          assert.equal(judgment.evidence.hiddenAcceptancePassed, true);
          assert.equal(judgment.evidence.hiddenAcceptanceVerified, true);
          assert.equal(judgment.evidence.hiddenAcceptanceTamperingDetected, false);
          assert.equal(judgment.evidence.historyUntouched, true);
          assert.equal(judgment.evidence.baselineTestsUntampered, true);
          assert.equal(judgment.evidence.failureAttribution, FAILURE_ATTRIBUTIONS.NONE);
        }),
      ),
    );
  });

  test('judges reject broken, surface-only, incomplete, and tampered fixes', { concurrency: 4 }, async (t) => {
    const dataset = createAutonomousReasoningDataset({ sandbox: strongSandbox });
    const byId = Object.fromEntries(dataset.map((item) => [item.id, item]));

    await Promise.all([
      t.test('rejects untouched workspace', async (subT) => {
      const task = byId['ar-01-unfamiliar-codebase'];
      const ws = await instantiateAutonomousReasoningWorkspace(task);
      subT.after(() => removeFixtureWorkspace(ws));
      const judgment = await task.judge({
        task,
        output: buildAutonomousReasoningEvidenceOutput(task),
        context: buildTrustedContext(task, ws, strongSandbox),
      });
      assert.equal(judgment.passed, false);
      assert.equal(judgment.hardVetoed, true);
      assert.equal(judgment.evidence.checks.changedFiles, false);
    }),

    t.test('ar-02 rejects surface-symptom-only patch in checkout.js via Docker hidden acceptance', async (subT) => {
      const task = byId['ar-02-complex-bug-root-cause'];
      const ws = await instantiateAutonomousReasoningWorkspace(task);
      subT.after(() => removeFixtureWorkspace(ws));
      applyWorkspaceFiles(ws, {
        'src/pricing/checkout.js': [
          "import { applyDiscount } from './discount.js';",
          "import { computeTax } from './tax.js';",
          'export function checkout({ items, coupon = null, region = "US" }) {',
          '  const discounted = applyDiscount(items, coupon);',
          '  const taxCents = computeTax(discounted.lines, region);',
          '  return { subtotalCents: discounted.subtotalCents, discountedSubtotalCents: discounted.discountedSubtotalCents, taxCents, totalCents: Math.round(discounted.discountedSubtotalCents + taxCents), lines: discounted.lines };',
          '}',
        ].join('\n'),
      });
      const judgment = await task.judge({
        task,
        output: buildAutonomousReasoningEvidenceOutput(task, ['src/pricing/checkout.js']),
        context: buildTrustedContext(task, ws, strongSandbox),
      });
      assert.equal(judgment.passed, false);
      assert.equal(judgment.hardVetoed, true);
      assert.equal(judgment.evidence.hiddenAcceptancePassed, false);
      assert.equal(judgment.evidence.rootCauseMatch, false);
      assert.equal(judgment.evidence.failureCategory, 'surface_symptom_patch');
      assert.equal(judgment.evidence.failureAttribution, FAILURE_ATTRIBUTIONS.MODEL_CAPABILITY);
    }),

    t.test('ar-05 rejects partial security fix via Docker hidden exploit suite', async (subT) => {
      const task = byId['ar-05-security-vuln-fix'];
      const ws = await instantiateAutonomousReasoningWorkspace(task);
      subT.after(() => removeFixtureWorkspace(ws));
      applyWorkspaceFiles(ws, {
        'src/fs/safe-bundle.js': [
          "import { join } from 'node:path';",
          'export function resolveBundlePath(rootDir, entryPath) {',
          '  if (String(entryPath).includes("..")) throw new Error("blocked");',
          '  return join(rootDir, entryPath);',
          '}',
        ].join('\n'),
        'src/config/deep-merge.js': [
          'export function mergeConfig(target, source) {',
          '  const out = { ...target };',
          '  for (const k of Object.keys(source || {})) {',
          '    if (k === "__proto__") continue;',
          '    out[k] = source[k] && typeof source[k] === "object" ? mergeConfig(out[k] || {}, source[k]) : source[k];',
          '  }',
          '  return out;',
          '}',
        ].join('\n'),
        'SECURITY.md': 'Blocked .. and __proto__.',
        'test/security-regression.test.js': "import test from 'node:test'; import assert from 'node:assert/strict'; test('ok', () => assert.ok(true));",
      });
      const judgment = await task.judge({
        task,
        output: buildAutonomousReasoningEvidenceOutput(task),
        context: buildTrustedContext(task, ws, strongSandbox),
      });
      assert.equal(judgment.passed, false);
      assert.equal(judgment.evidence.hiddenAcceptancePassed, false);
      assert.ok(judgment.vetoReasons.includes('hidden_acceptance_failed'));
    }),

    t.test('ar-06 rejects weakened/modified baseline test fail-fast', async (subT) => {
      const task = byId['ar-06-test-failure-repair'];
      const ws = await instantiateAutonomousReasoningWorkspace(task);
      subT.after(() => removeFixtureWorkspace(ws));
      applyWorkspaceFiles(ws, {
        'test/backoff.test.js': "import test from 'node:test'; import assert from 'node:assert/strict'; test('weakened', () => assert.ok(true));\n",
      });
      const judgment = await task.judge({
        task,
        output: buildAutonomousReasoningEvidenceOutput(task, ['test/backoff.test.js']),
        context: buildTrustedContext(task, ws, strongSandbox),
      });
      assert.equal(judgment.passed, false);
      assert.equal(judgment.hardVetoed, true);
      assert.equal(judgment.evidence.baselineTestsUntampered, false);
      assert.deepEqual(judgment.evidence.tamperedBaselineTestFiles, ['test/backoff.test.js']);
      assert.ok(judgment.vetoReasons.includes('baseline_tests_tampered'));
    }),

    t.test('ar-03 rejects tampered git history fail-fast', async (subT) => {
      const task = byId['ar-03-multi-file-feature'];
      const ws = await instantiateAutonomousReasoningWorkspace(task);
      subT.after(() => removeFixtureWorkspace(ws));
      applyWorkspaceFiles(ws, getAutonomousReasoningReferenceFix(task.id, ws));
      // Corrupt baseline commit pointer & amend commit
      runHardenedGitSync(['add', '-A'], { cwd: ws, allowNetwork: false });
      runHardenedGitSync(['commit', '--amend', '-qm', 'tampered history'], { cwd: ws, allowNetwork: false });
      const judgment = await task.judge({
        task,
        output: buildAutonomousReasoningEvidenceOutput(task),
        context: buildTrustedContext(task, ws, strongSandbox),
      });
      assert.equal(judgment.passed, false);
      assert.equal(judgment.hardVetoed, true);
      assert.equal(judgment.evidence.historyUntouched, false);
      assert.ok(judgment.vetoReasons.includes('history_tampered'));
    }),

    t.test('ar-01 rejects forbidden mutation to src/ files', async (subT) => {
      const task = byId['ar-01-unfamiliar-codebase'];
      const ws = await instantiateAutonomousReasoningWorkspace(task);
      subT.after(() => removeFixtureWorkspace(ws));
      applyWorkspaceFiles(ws, {
        ...getAutonomousReasoningReferenceFix(task.id, ws),
        'src/config/defaults.js': 'export const DEFAULTS = Object.freeze({ port: 3000, rateLimit: 100, authHeader: "x-api-key" });\n',
      });
      const judgment = await task.judge({
        task,
        output: buildAutonomousReasoningEvidenceOutput(task),
        context: buildTrustedContext(task, ws, strongSandbox),
      });
      assert.equal(judgment.passed, false);
      assert.equal(judgment.evidence.protectedFilesUntampered, false);
    }),

    t.test('ar-04 rejects incomplete refactor leaving inline cleanVal duplicated', async (subT) => {
      const task = byId['ar-04-cross-module-refactor'];
      const ws = await instantiateAutonomousReasoningWorkspace(task);
      subT.after(() => removeFixtureWorkspace(ws));
      const ref = getAutonomousReasoningReferenceFix(task.id, ws);
      applyWorkspaceFiles(ws, {
        ...ref,
        // Leave csv-reader untouched with duplicated cleanVal
        'src/ingest/csv-reader.js': task.fixture.files['src/ingest/csv-reader.js'],
      });
      const judgment = await task.judge({
        task,
        output: buildAutonomousReasoningEvidenceOutput(task),
        context: buildTrustedContext(task, ws, strongSandbox),
      });
      assert.equal(judgment.passed, false);
      assert.equal(judgment.evidence.hiddenAcceptancePassed, false);
    }),

    t.test('ar-09 rejects forged reviewer JSON with mismatched artifact digest', async (subT) => {
      const task = byId['ar-09-multi-agent-collab'];
      const ws = await instantiateAutonomousReasoningWorkspace(task);
      subT.after(() => removeFixtureWorkspace(ws));
      const ref = getAutonomousReasoningReferenceFix(task.id, ws);
      applyWorkspaceFiles(ws, {
        ...ref,
        'handoff/reviewer-verdict.json': JSON.stringify({
          schemaVersion: '1.0.0',
          verdict: 'pass',
          summary: 'Forged digest',
          evidenceDigest: '0'.repeat(64),
          checkedArtifacts: ['src/index.js', 'src/modules/evaluator.js', 'src/modules/tokenizer.js'],
          findings: [],
          readOnlyVerified: true,
        }),
      });
      const judgment = await task.judge({
        task,
        output: buildAutonomousReasoningEvidenceOutput(task),
        context: buildTrustedContext(task, ws, strongSandbox),
      });
      assert.equal(judgment.passed, false);
      assert.equal(judgment.evidence.checks.reviewerSchemaValid, false);
    }),

    t.test('ar-10 rejects constraint violation dropping legacySummary', async (subT) => {
      const task = byId['ar-10-long-horizon-delivery'];
      const ws = await instantiateAutonomousReasoningWorkspace(task);
      subT.after(() => removeFixtureWorkspace(ws));
      const ref = getAutonomousReasoningReferenceFix(task.id, ws);
      applyWorkspaceFiles(ws, {
        ...ref,
        'src/core/ledger.js': ref['src/core/ledger.js'].replace('legacySummary', 'removedLegacy'),
      });
      const judgment = await task.judge({
        task,
        output: buildAutonomousReasoningEvidenceOutput(task),
        context: buildTrustedContext(task, ws, strongSandbox),
      });
      assert.equal(judgment.passed, false);
      assert.equal(judgment.evidence.checks.constraintsPreserved, false);
    }),

    t.test('enforceDeterministicHardVeto prevents advisory/premature-exit override', () => {
      const vetoed = enforceDeterministicHardVeto(
        {
          passed: true,
          score: 1,
          evidence: {
            hiddenAcceptancePassed: false,
            baselineTestsUntampered: false,
            sandboxIsolated: false,
          },
        },
        { passed: true, score: 1, note: 'LLM advisory tried to force pass' },
      );
      assert.equal(vetoed.passed, false);
      assert.equal(vetoed.score, 0);
      assert.equal(vetoed.hardVetoed, true);
      assert.ok(vetoed.vetoReasons.includes('baseline_tests_tampered'));
      assert.ok(vetoed.vetoReasons.includes('sandbox_not_isolated'));
      assert.ok(vetoed.vetoReasons.includes('hidden_acceptance_failed'));
    }),
    ]);
  });

  test('computeAutonomousReasoningMetrics computes all 9 metrics, 3-way attribution, and retains all failed trials', () => {
    const trials = [
      {
        taskId: 'ar-01-unfamiliar-codebase',
        status: 'passed',
        passed: true,
        attempts: 1,
        rootCauseAccurate: true,
        firstFixSucceeded: true,
        regressionPassed: true,
        ineffectiveActionCount: 0,
        replanTriggered: false,
        tokenUsage: { inputTokens: 800, outputTokens: 200 },
        durationMs: 1000,
      },
      {
        taskId: 'ar-02-complex-bug-root-cause',
        status: 'failed',
        passed: false,
        attempts: 2,
        rootCauseAccurate: false,
        firstFixSucceeded: false,
        regressionPassed: true,
        ineffectiveActionCount: 3,
        replanTriggered: true,
        replanSucceeded: false,
        failureCategory: 'surface_symptom_patch',
        tokenUsage: { inputTokens: 1200, outputTokens: 300 },
        durationMs: 3000,
      },
      {
        taskId: 'ar-05-security-vuln-fix',
        status: 'failed',
        passed: false,
        attempts: 1,
        rootCauseAccurate: true,
        firstFixSucceeded: false,
        regressionPassed: false,
        ineffectiveActionCount: 2,
        errorCode: 'POLICY_DENIED',
        failureKind: 'tool_failure',
        tokenUsage: { inputTokens: 600, outputTokens: 150 },
        durationMs: 1500,
      },
      {
        taskId: 'ar-08-mid-task-recovery',
        status: 'passed',
        passed: true,
        attempts: 2,
        repairRounds: 1,
        rootCauseAccurate: true,
        firstFixSucceeded: false,
        regressionPassed: true,
        ineffectiveActionCount: 1,
        replanTriggered: true,
        replanSucceeded: true,
        isRecoveryTask: true,
        recoverySucceeded: true,
        tokenUsage: { inputTokens: 1000, outputTokens: 250 },
        durationMs: 2500,
      },
      {
        taskId: 'ar-10-long-horizon-delivery',
        status: 'timeout',
        passed: false,
        attempts: 1,
        rootCauseAccurate: false,
        firstFixSucceeded: false,
        regressionPassed: false,
        ineffectiveActionCount: 4,
        errorCode: 'STEP_BUDGET_EXHAUSTED',
        tokenUsage: { inputTokens: 1400, outputTokens: 100 },
        durationMs: 2000,
      },
    ];

    const metrics = computeAutonomousReasoningMetrics(trials);
    assert.equal(metrics.totalTrials, 5);
    assert.equal(metrics.passedTrials, 2);
    assert.equal(metrics.failedTrials, 3);
    assert.equal(metrics.trials.length, 5, 'must retain ALL failed trials');

    // Verify all 9 metrics
    assert.equal(metrics.finalTaskSuccessRate, 0.4);
    assert.equal(metrics.rootCauseAccuracy, 0.6);
    assert.equal(metrics.firstFixSuccessRate, 0.2);
    assert.equal(metrics.regressionTestPassRate, 0.6);
    assert.equal(metrics.ineffectiveActionCount, 10);
    assert.equal(metrics.replanEffectivenessRate, 0.5);
    assert.equal(metrics.tokenCost, 6000);
    assert.equal(metrics.meanDurationMs, 2000);
    assert.equal(metrics.recoverySuccessRate, 1);

    // Verify 3-way attribution
    assert.equal(metrics.attributionCounts.none, 2);
    assert.equal(metrics.attributionCounts.model_capability, 1);
    assert.equal(metrics.attributionCounts.tool_mechanism, 1);
    assert.equal(metrics.attributionCounts.runtime_reliability, 1);
    assert.equal(
      classifyAutonomousReasoningAttribution({ passed: false, errorCode: 'STALE_VERIFICATION_AFTER_EDIT' }),
      FAILURE_ATTRIBUTIONS.RUNTIME_RELIABILITY,
    );
    assert.equal(
      classifyAutonomousReasoningAttribution({ passed: false, errorCode: 'TOOL_SCHEMA_INVALID' }),
      FAILURE_ATTRIBUTIONS.TOOL_MECHANISM,
    );
  });

  test('CLI arg parsing, dynamic worktree probing, and deterministic Docker A/B smoke run cleanly', async () => {
    const parsed = parseCliArgs(['--mode', 'deterministic', '--tasks', 'ar-01-unfamiliar-codebase', '--repeats', '1', '--json']);
    assert.equal(parsed.mode, 'deterministic');
    assert.deepEqual(parsed.tasks, ['ar-01-unfamiliar-codebase']);
    assert.equal(parsed.json, true);

    const repoRoot = join(import.meta.dirname, '..', '..', '..');
    const probed = await loadAndProbeWorktreeArm(repoRoot);
    assert.equal(typeof probed.capabilities.executionReasoningTracker, 'boolean');
    assert.equal(typeof probed.capabilities.postEditStaleVerifier, 'boolean');
    assert.equal(typeof probed.capabilities.smartCompactionReadDedup, 'boolean');
    assert.equal(typeof probed.capabilities.degenerateReplanGuard, 'boolean');
    assert.equal(typeof probed.capabilities.experienceDistillation, 'boolean');

    const outDir = mkdtempSync(join(tmpdir(), 'agent-us-ar-cli-out-'));
    const outPath = join(outDir, 'results.jsonl');
    try {
      const summary = await runAutonomousReasoningBenchmark({
        mode: 'deterministic',
        baseline: repoRoot,
        candidate: repoRoot,
        output: outPath,
        tasks: ['ar-01-unfamiliar-codebase', 'ar-02-complex-bug-root-cause'],
        repeats: 1,
        lane: 0,
        lanes: 1,
        sandbox: SANDBOX_MODES.STRONG,
      });
      assert.equal(summary.benchmarkId, AUTONOMOUS_REASONING_BENCHMARK_ID);
      assert.equal(summary.sandboxBackend, SANDBOX_MODES.DOCKER);
      assert.equal(summary.baseline.metrics.totalTrials, 2);
      assert.equal(summary.candidate.metrics.totalTrials, 2);
      assert.equal(summary.baseline.metrics.trials.length, 2);
      const lines = readFileSync(outPath, 'utf8').trim().split(/\r?\n/);
      assert.equal(lines.length, 4);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
