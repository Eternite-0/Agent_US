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
  authorizeRealBenchmarkApproval,
  enrichReceiptsWithCommands,
  loadAndProbeWorktreeArm,
  parseCliArgs,
  recordArmExperienceMemory,
  resolveRealTrialFirstFixSucceeded,
  runAutonomousReasoningBenchmark,
} from '../../scripts/benchmark-autonomous-reasoning.mjs';
import { Store } from '../../src/store.js';
import { compactTwoStage } from '../../src/context.js';
import { ExperienceMemoryService } from '../../src/memory/service.js';
import { ExecutionReasoningTracker } from '../../src/kernel/execution-reasoning.js';

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
    assert.equal(typeof probed.capabilities.richCompactionAnchor, 'boolean');
    assert.equal(typeof probed.capabilities.degenerateReplanGuard, 'boolean');
    assert.equal(typeof probed.capabilities.experienceDistillation, 'boolean');

    // Regression: compactTwoStage is async and expects { messages } returning { options: { messages }, stage }
    const compacted = await compactTwoStage(
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Inspect constraints carefully' }] },
          { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"node --test"}' }] },
          { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'LOG_LINE\n'.repeat(1200) }] },
          { role: 'user', content: [{ type: 'text', text: 'Finish ' + 'C'.repeat(900) }] },
        ],
      },
      { contextWindow: 3000, reserveTokens: 512, keepRecentTokens: 200 },
    );
    assert.equal(compacted.compacted, true);
    assert.notEqual(compacted.stage, 'none');
    assert.ok(Array.isArray(compacted.options?.messages));

    // Regression: recordArmExperienceMemory seeds evaluation_runs (synthetic: true, status: 'completed')
    // before calling distillTurnExperience when available, and falls back cleanly on baseline.
    const memDir = mkdtempSync(join(tmpdir(), 'agent-us-ar-mem-'));
    const memStore = new Store(join(memDir, 'mem.sqlite'));
    try {
      const task = AUTONOMOUS_REASONING_DATASET[0];
      const baselineMem = new ExperienceMemoryService({ store: memStore, projectId: task.id });
      if (typeof baselineMem.distillTurnExperience !== 'function') {
        assert.equal(
          recordArmExperienceMemory({
            store: memStore,
            memory: baselineMem,
            task,
            armName: 'baseline',
            rep: 0,
            workspaceRoot: memDir,
            verdict: { verdict: 'pass', accepted: true },
            passed: true,
          }),
          true,
        );
      }
      const strictCandidateMem = {
        distillTurnExperience({ projectId, evaluationEvidence }) {
          assert.ok(evaluationEvidence?.evaluationRunId);
          const run = memStore.get('evaluation_runs', evaluationEvidence.evaluationRunId);
          assert.ok(run, 'evaluation_runs row must be seeded prior to distillTurnExperience');
          assert.equal(run.status, 'completed');
          assert.equal(run.synthetic, true);
          assert.equal(run.projectId ?? run.evaluationProjectId, projectId);
          assert.ok(
            run.results.some((r) => r.taskId === evaluationEvidence.sourceTaskId && r.status === 'passed' && r.passed === true),
          );
          return [{ id: 'distilled-1', verified: true }];
        },
      };
      assert.equal(
        recordArmExperienceMemory({
          store: memStore,
          memory: strictCandidateMem,
          task,
          armName: 'candidate',
          rep: 0,
          workspaceRoot: memDir,
          verdict: { verdict: 'pass', accepted: true },
          passed: true,
        }),
        true,
      );
    } finally {
      memStore.close();
      rmSync(memDir, { recursive: true, force: true });
    }

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
      assert.ok(summary.baseline.metrics.tokenCost > 0, 'baseline deterministic tokenCost must be > 0');
      assert.ok(summary.candidate.metrics.tokenCost > 0, 'candidate deterministic tokenCost must be > 0');
      assert.equal(summary.candidate.probes?.degenerateReplanGuard?.blocked, true);
      assert.equal(summary.candidate.probes?.degenerateReplanGuard?.code, 'PLANNER_DEGENERATE_REPLAN_DENIED');
      assert.equal(summary.candidate.probes?.stuckLoopSelfCorrection?.detected, true);
      assert.equal(summary.candidate.probes?.stuckLoopSelfCorrection?.recovered, true);
      assert.equal(summary.candidate.probes?.stuckLoopSelfCorrection?.pattern, 'edit_test_fail_loop');
      const lines = readFileSync(outPath, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
      assert.equal(lines.length, 4);
      const ar01Trial = lines.find((r) => r.taskId === 'ar-01-unfamiliar-codebase');
      assert.equal(ar01Trial?.compactionProbe?.twoStageCompacted, true);
      assert.notEqual(ar01Trial?.compactionProbe?.stage, 'none');
      assert.equal(ar01Trial?.memoryRecorded, true);
      const ar02Candidate = lines.find((r) => r.taskId === 'ar-02-complex-bug-root-cause' && r.arm === 'candidate');
      assert.ok(ar02Candidate, 'ar-02 candidate trial must be present');
      assert.ok(ar02Candidate.repairRounds >= 1, 'ar-02 candidate must record repairRounds >= 1');
      assert.ok(ar02Candidate.attempts >= 2, 'ar-02 candidate must record attempts >= 2');
      assert.equal(ar02Candidate.firstFixSucceeded, false);
      assert.ok(ar02Candidate.tokenCost > 0, 'ar-02 candidate trial tokenCost must be > 0');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('real-mode helpers: enrichReceiptsWithCommands maps assistant toolCalls and authorizeRealBenchmarkApproval enforces patch/bash boundaries', () => {
    const receipts = [
      { id: 'rec-1', callId: 'call-w', toolName: 'write_file', status: 'finished', exitCode: null },
      { id: 'rec-2', callId: 'call-b1', toolName: 'bash', status: 'finished', exitCode: 0 },
      { id: 'rec-3', callId: 'call-b2', toolName: 'bash', status: 'failed', exitCode: 1 },
      { id: 'rec-4', callId: 'call-missing', toolName: 'bash', status: 'finished', exitCode: 0 },
    ];
    const assistantRows = [
      {
        toolCalls: JSON.stringify([
          { id: 'call-w', name: 'write_file', arguments: JSON.stringify({ path: 'src/app.js', content: 'ok' }) },
          { id: 'call-b1', name: 'bash', arguments: JSON.stringify({ command: 'node --test test/checkout.test.js test/root-cause.test.js' }) },
        ]),
      },
      { toolCalls: '{malformed json' },
      {
        toolCalls: [
          { id: 'call-b2', name: 'bash', arguments: { command: 'npm test' } },
        ],
      },
    ];
    const enriched = enrichReceiptsWithCommands(receipts, assistantRows);
    assert.equal(enriched[0].command, '');
    assert.equal(enriched[1].command, 'node --test test/checkout.test.js test/root-cause.test.js');
    assert.equal(enriched[2].command, 'npm test');
    assert.equal(enriched[3].command, '');

    const allowedTestCommands = new Set(['node --test test/checkout.test.js test/root-cause.test.js']);
    const protectedSet = new Set(['test/checkout.test.js', 'CONSTRAINTS.md', 'src/index.js']);

    // write_file / edit_file checks
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'write_file',
        args: { path: './src\\pricing\\tax.js' },
        allowedTestCommands,
        protectedSet,
      }),
      true,
    );
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'edit_file',
        args: { path: './test/checkout.test.js' },
        allowedTestCommands,
        protectedSet,
      }),
      false,
    );
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'write_file',
        args: { path: '../outside.js' },
        allowedTestCommands,
        protectedSet,
      }),
      false,
    );
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'write_file',
        args: { path: '.' },
        allowedTestCommands,
        protectedSet,
      }),
      false,
    );

    // apply_patch checks
    const safePatch = [
      '*** Begin Patch',
      '*** Update File: src/pricing/tax.js',
      '@@',
      '-return 0;',
      '+return 1;',
      '*** Add File: test/root-cause.test.js',
      '+export const ok = true;',
      '*** End Patch',
    ].join('\n');
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'apply_patch',
        args: { patch: safePatch },
        allowedTestCommands,
        protectedSet,
      }),
      true,
    );

    const protectedPatch = [
      '*** Begin Patch',
      '*** Update File: ./CONSTRAINTS.md',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'apply_patch',
        args: { patch: protectedPatch },
        allowedTestCommands,
        protectedSet,
      }),
      false,
    );

    const deletePatch = [
      '*** Begin Patch',
      '*** Delete File: src/pricing/tax.js',
      '*** End Patch',
    ].join('\n');
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'apply_patch',
        args: { patch: deletePatch },
        allowedTestCommands,
        protectedSet,
      }),
      false,
    );

    const movePatch = [
      '*** Begin Patch',
      '*** Update File: src/pricing/tax.js',
      '*** Move to: src/pricing/tax2.js',
      '@@',
      '-a',
      '+b',
      '*** End Patch',
    ].join('\n');
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'apply_patch',
        args: { patch: movePatch },
        allowedTestCommands,
        protectedSet,
      }),
      false,
    );

    const traversalPatch = [
      '*** Begin Patch',
      '*** Add File: ../escape.js',
      '+evil',
      '*** End Patch',
    ].join('\n');
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'apply_patch',
        args: { patch: traversalPatch },
        allowedTestCommands,
        protectedSet,
      }),
      false,
    );

    // bash checks
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'bash',
        args: { command: 'node --test test/root-cause.test.js' },
        allowedTestCommands,
        protectedSet,
      }),
      true,
    );
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'bash',
        args: { command: 'npm test' },
        allowedTestCommands,
        protectedSet,
      }),
      true,
    );
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'bash',
        args: { command: 'node --test && echo pwn' },
        allowedTestCommands,
        protectedSet,
      }),
      false,
    );
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'bash',
        args: { command: 'node --test $(whoami)' },
        allowedTestCommands,
        protectedSet,
      }),
      false,
    );
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'bash',
        args: { command: 'node --test test/a.test.js > out.txt' },
        allowedTestCommands,
        protectedSet,
      }),
      false,
    );
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'bash',
        args: { command: 'node --test --eval "process.exit(0)"' },
        allowedTestCommands,
        protectedSet,
      }),
      false,
    );
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'bash',
        args: { command: 'node bin/policy-cli.js --format json --strict' },
        allowedTestCommands,
        protectedSet,
        allowWorkspaceNodeCli: false,
      }),
      false,
    );
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'bash',
        args: { command: 'node bin/policy-cli.js --format json --strict' },
        allowedTestCommands,
        protectedSet,
        allowWorkspaceNodeCli: true,
      }),
      true,
    );
    assert.equal(
      authorizeRealBenchmarkApproval({
        toolName: 'bash',
        args: { command: 'node src/cli/audit.js --input entries.json' },
        allowedTestCommands,
        protectedSet,
        allowWorkspaceNodeCli: true,
      }),
      true,
    );
  });

  test('loadAndProbeWorktreeArm exposes constructors for real and deterministic arms including BenchmarkSandbox', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..');
    const probed = await loadAndProbeWorktreeArm(repoRoot);

    const requiredConstructors = [
      'Store',
      'AccountPool',
      'DirectAgentRuntime',
      'BenchmarkSandbox',
      'AgentLoop',
      'DecisionEngine',
      'EventRouter',
      'InferenceEngine',
      'EvidenceVerifier',
      'compactTwoStage',
      'MultiStageCompactor',
      'AdaptivePlanner',
      'AdaptiveReplanner',
      'PlannerFeedbackCollector',
      'ExperienceMemoryService',
      'createWorkspaceTools',
      'ToolDispatcher',
      'UnknownOutcomeReconciler',
      'CheckpointStore',
    ];
    for (const key of requiredConstructors) {
      assert.equal(typeof probed.modules[key], 'function', `Expected module ${key} to be a function`);
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'ar-probe-constructors-'));
    let store = null;
    let direct = null;
    try {
      const { Store: ArmStore, AccountPool, DirectAgentRuntime, BenchmarkSandbox } = probed.modules;
      store = new ArmStore(join(tempDir, 'eval.sqlite'));
      const pool = new AccountPool(store, { root: tempDir });
      direct = new DirectAgentRuntime(store, pool, {
        dataRoot: tempDir,
        defaultWorkspace: repoRoot,
      });
      const sandbox = new BenchmarkSandbox({
        mode: 'docker',
        workspaceRoot: repoRoot,
        allowProcessHardeningOnly: false,
      });

      assert.ok(store instanceof ArmStore);
      assert.ok(pool instanceof AccountPool);
      assert.ok(direct instanceof DirectAgentRuntime);
      assert.ok(sandbox instanceof BenchmarkSandbox);
    } finally {
      if (direct) await direct.close();
      if (store) store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('resolveRealTrialFirstFixSucceeded scores ar-06 policy-blocked clean fix accurately without false-negative penalty', () => {
    const tracker = new ExecutionReasoningTracker();
    tracker.recordToolResult({
      tc: { id: 'p1', name: 'bash', arguments: JSON.stringify({ command: 'node -e "1"' }) },
      output: '[APPROVAL_DENIED]',
      isError: true,
      receipt: { status: 'rejected_before_effect', errorCode: 'APPROVAL_DENIED' },
      step: 1,
    });
    tracker.recordToolResult({
      tc: { id: 'v0', name: 'bash', arguments: JSON.stringify({ command: 'node --test' }) },
      output: 'AssertionError: 1 !== 2',
      isError: true,
      receipt: { status: 'failed', exitCode: 1 },
      step: 2,
    });
    tracker.recordToolResult({
      tc: { id: 'e1', name: 'edit_file', arguments: JSON.stringify({ path: 'src/fix.js', target: 'a', replacement: 'b' }) },
      output: 'ok',
      step: 3,
    });
    tracker.recordToolResult({
      tc: { id: 'v1', name: 'bash', arguments: JSON.stringify({ command: 'node --test' }) },
      output: 'pass 1',
      isError: false,
      receipt: { status: 'finished', exitCode: 0 },
      step: 4,
    });

    const ar06Metrics = tracker.getMetrics({ finalOutcomePassed: true, stopReason: 'completed' });
    assert.equal(ar06Metrics.firstFixSucceeded, true);
    assert.equal(ar06Metrics.selfCorrectionRecovered, false);

    assert.equal(
      resolveRealTrialFirstFixSucceeded({ passed: true, repairRounds: 0, reasoningMetrics: ar06Metrics }),
      true,
    );
    assert.equal(
      resolveRealTrialFirstFixSucceeded({ passed: true, repairRounds: 0, reasoningMetrics: null }),
      true,
    );
    assert.equal(
      resolveRealTrialFirstFixSucceeded({
        passed: true,
        repairRounds: 0,
        reasoningMetrics: { firstFixSucceeded: false, selfCorrectionRecovered: true },
      }),
      false,
    );
    assert.equal(
      resolveRealTrialFirstFixSucceeded({
        passed: true,
        repairRounds: 1,
        reasoningMetrics: { firstFixSucceeded: true },
      }),
      false,
    );
    assert.equal(
      resolveRealTrialFirstFixSucceeded({
        passed: false,
        repairRounds: 0,
        reasoningMetrics: { firstFixSucceeded: true },
      }),
      false,
    );
  });
});
