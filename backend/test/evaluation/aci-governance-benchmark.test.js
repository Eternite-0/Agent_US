import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACI_ARM_PROFILES,
  ACI_GOVERNANCE_BENCHMARK_ID,
  ACI_GOVERNANCE_DATASET,
  ACI_GOVERNANCE_TASK_IDS,
  FAILURE_ATTRIBUTIONS,
  VERSION,
  applyWorkspaceFiles,
  buildAciGovernanceEvidenceOutput,
  computeAciGovernanceMetrics,
  createAciGovernanceDataset,
  getAciGovernanceReferenceFix,
  instantiateAciGovernanceWorkspace,
  materializeAciGovernanceRepos,
} from '../../src/evaluation/aci-governance-benchmark.js';
import {
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
  buildSummaryOutputPath,
  parseAciCliArgs,
  probeAciRuntimeCapabilities,
  resolveArmProfileConfig,
  runAciGovernanceBenchmark,
} from '../../scripts/benchmark-aci-governance.mjs';

const DOCKER_AVAILABLE = new DockerBenchmarkSandbox().isAvailable();
const TEST_SANDBOX_OPTIONS = DOCKER_AVAILABLE
  ? { mode: SANDBOX_MODES.STRONG }
  : { mode: SANDBOX_MODES.NODE_PERMISSION, allowProcessHardeningOnly: true };

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
  if (!DOCKER_AVAILABLE) return [];
  const res = spawnSync(
    'docker',
    ['ps', '-a', '--filter', 'name=agent-us-bench-', '--format', '{{.Names}}'],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000, shell: false },
  );
  if (res.error || res.status !== 0) return [];
  return String(res.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('Agent_US 2.4 Stage 4 ACI Governance Benchmark Suite', () => {
  const activeSandbox = new BenchmarkSandbox(TEST_SANDBOX_OPTIONS);

  after(() => {
    const leftover = listBenchmarkContainers();
    assert.deepEqual(
      leftover,
      [],
      `Expected 0 leftover agent-us-bench-* containers, found: ${leftover.join(', ')}`,
    );
  });

  test('Docker strong OS isolation is active (or node-permission fallback when Docker unavailable)', () => {
    const dockerProbe = new DockerBenchmarkSandbox().probe();
    const resolved = activeSandbox.resolveBackend();
    if (DOCKER_AVAILABLE) {
      assert.equal(dockerProbe.available, true, `Docker sandbox must be available: ${dockerProbe.reason}`);
      assert.equal(resolved.mode, SANDBOX_MODES.DOCKER);
      assert.equal(resolved.isolationTier, SANDBOX_TIERS.STRONG_OS_ISOLATION);
      assert.equal(resolved.strongOsIsolation, true);
    } else {
      assert.equal(dockerProbe.available, false);
      assert.equal(resolved.mode, SANDBOX_MODES.NODE_PERMISSION);
      assert.equal(resolved.isolationTier, SANDBOX_TIERS.PROCESS_HARDENING_ONLY);
      assert.equal(resolved.strongOsIsolation, false);
    }
  });

  test('BenchmarkSandbox fails closed with SandboxUnavailableError when Docker is unavailable under STRONG mode', () => {
    const unavailableSandbox = new BenchmarkSandbox({
      mode: SANDBOX_MODES.STRONG,
      probes: {
        docker: { available: false, reason: 'simulated_docker_unavailable' },
        nodePermission: { available: true },
      },
    });
    assert.throws(() => unavailableSandbox.resolveBackend(), SandboxUnavailableError);
  });

  test('dataset exports exact ID/version, 16-22 files (~14k-24k tokens), large decoys, and zero groundTruth prompt leakage', () => {
    assert.equal(ACI_GOVERNANCE_BENCHMARK_ID, 'agent-us-aci-governance-2.4-s4');
    assert.equal(VERSION, '1.0.0');
    assert.deepEqual(
      [...ACI_GOVERNANCE_TASK_IDS],
      [
        'aci-01-auth-tenant-boundary',
        'aci-02-persistence-wal-ledger',
        'aci-03-contract-pipeline-refactor',
        'aci-04-long-horizon-security-audit',
      ],
    );
    assert.equal(ACI_GOVERNANCE_DATASET.length, 4);

    const dataset = createAciGovernanceDataset({ sandbox: activeSandbox });
    for (const task of dataset) {
      validateTask(task);
      assert.equal(task.metadata.requiresGitDiff, true);
      assert.equal(task.metadata.externalNetwork, false);
      assert.equal(task.metadata.sandboxIsolation.required, true);
      assert.equal(task.metadata.sandboxIsolation.failClosed, true);

      const files = Object.keys(task.fixture.files);
      assert.ok(files.length >= 16 && files.length <= 22, `${task.id} file count=${files.length}`);
      assert.ok(
        task.metadata.totalWorkspaceTokens >= 14_000 && task.metadata.totalWorkspaceTokens <= 24_000,
        `${task.id} tokens=${task.metadata.totalWorkspaceTokens}`,
      );

      const gt = task.metadata.groundTruth;
      assert.ok(gt && gt.criticalFiles.length >= 4);
      assert.ok(gt.relevantFiles.length >= gt.criticalFiles.length);
      assert.ok(gt.noiseFiles.length >= 6);
      for (const decoy of gt.noiseFiles) {
        assert.ok(
          Buffer.byteLength(task.fixture.files[decoy] || '', 'utf8') > 2500,
          `${task.id} decoy ${decoy} must exceed 2.5 KB`,
        );
      }

      // Strict separation: groundTruth and noise file lists must NEVER leak into prompt or expected
      assert.equal(task.prompt.includes('groundTruth'), false);
      assert.equal(task.prompt.includes('noiseFiles'), false);
      for (const decoy of gt.noiseFiles) {
        assert.equal(task.prompt.includes(decoy), false, `${task.id} prompt leaked noise file ${decoy}`);
      }
      assert.equal(JSON.stringify(task.expected).includes('groundTruth'), false);
    }
  });

  test('all 4 tasks instantiate frozen git workspaces (inline and pinned bare mirrors) and pass baseline tests initially', async () => {
    const bareRoot = mkdtempSync(join(tmpdir(), 'agent-us-aci-mirrors-'));
    try {
      const { repoOverrides, cleanup } = await materializeAciGovernanceRepos(bareRoot);
      const pinnedDataset = createAciGovernanceDataset({ sandbox: activeSandbox, repoOverrides });
      assert.equal(pinnedDataset.length, 4);

      await Promise.all(
        pinnedDataset.map(async (task) => {
          assert.match(task.fixture.commit, /^[0-9a-f]{40}$/);
          const ws = await instantiateAciGovernanceWorkspace(task, { prefix: `aci-pin-${task.id}-` });
          try {
            const baseCommit = getWorkspaceBaselineCommit(ws);
            assert.equal(baseCommit, task.fixture.commit);
            const check = verifyWorkspacePinnedBaseline(ws, task.fixture.commit);
            assert.equal(check.ok, true, `${task.id} pinned baseline check failed: ${check.reason}`);
            assert.deepEqual(listWorkspaceChangedFiles(ws), []);

            // Verify baseline tests run and pass initially inside sandbox
            const baseRun = await activeSandbox.execArgv(task.fixture.baselineTestCommand, {
              workspaceRoot: ws,
              cwd: ws,
              allowWorkspaceNodeCli: Boolean(task.metadata.sandboxIsolation.allowWorkspaceNodeCli),
              timeoutMs: 20_000,
            });
            assert.equal(baseRun.exitCode, 0, `${task.id} baseline test failed: ${baseRun.stderr || baseRun.stdout}`);
          } finally {
            await removeFixtureWorkspace(ws);
          }
        }),
      );
      cleanup();
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });

  test('all 4 reference fixes pass inside active BenchmarkSandbox isolation', { concurrency: 4 }, async (t) => {
    const dataset = createAciGovernanceDataset({ sandbox: activeSandbox });
    await Promise.all(
      dataset.map((task) =>
        t.test(task.id, async (subT) => {
          const ws = await instantiateAciGovernanceWorkspace(task, { prefix: `aci-ref-${task.id}-` });
          subT.after(async () => {
            await removeFixtureWorkspace(ws);
          });
          applyWorkspaceFiles(ws, getAciGovernanceReferenceFix(task.id, ws));
          const output = buildAciGovernanceEvidenceOutput(task);
          const ctx = buildTrustedContext(task, ws, activeSandbox);
          const judgment = await task.judge({ task, output, context: ctx });

          assert.equal(
            judgment.passed,
            true,
            `${task.id} failed: ${JSON.stringify(judgment.evidence.errors)} checks=${JSON.stringify(judgment.evidence.checks)}`,
          );
          assert.equal(judgment.score, 1);
          assert.equal(judgment.hardVetoed, false);
          assert.equal(judgment.evidence.sandboxIsolated, true);
          if (DOCKER_AVAILABLE) {
            assert.equal(judgment.evidence.sandboxBackend, SANDBOX_MODES.DOCKER);
            assert.equal(judgment.evidence.strongOsIsolation, true);
            assert.equal(judgment.evidence.isolationTier, SANDBOX_TIERS.STRONG_OS_ISOLATION);
          } else {
            assert.equal(judgment.evidence.sandboxBackend, SANDBOX_MODES.NODE_PERMISSION);
            assert.equal(judgment.evidence.strongOsIsolation, false);
            assert.equal(judgment.evidence.isolationTier, SANDBOX_TIERS.PROCESS_HARDENING_ONLY);
          }
          assert.equal(judgment.evidence.hiddenAcceptancePassed, true);
          assert.equal(judgment.evidence.hiddenAcceptanceVerified, true);
          assert.equal(judgment.evidence.hiddenAcceptanceTamperingDetected, false);
          assert.equal(judgment.evidence.historyUntouched, true);
          assert.equal(judgment.evidence.baselineTestsUntampered, true);
          assert.equal(judgment.evidence.protectedFilesUntampered, true);
          assert.equal(judgment.evidence.failureAttribution, FAILURE_ATTRIBUTIONS.NONE);
        }),
      ),
    );
  });

  test('judges reject broken, untouched, decoy-only, tampered-baseline, tampered-contract, and tampered-history fixtures with hard veto', { concurrency: 4 }, async (t) => {
    const dataset = createAciGovernanceDataset({ sandbox: activeSandbox });
    const byId = Object.fromEntries(dataset.map((item) => [item.id, item]));

    await Promise.all([
      t.test('rejects untouched aci-01 workspace', async (subT) => {
        const task = byId['aci-01-auth-tenant-boundary'];
        const ws = await instantiateAciGovernanceWorkspace(task);
        subT.after(() => removeFixtureWorkspace(ws));
        const judgment = await task.judge({
          task,
          output: buildAciGovernanceEvidenceOutput(task),
          context: buildTrustedContext(task, ws, activeSandbox),
        });
        assert.equal(judgment.passed, false);
        assert.equal(judgment.hardVetoed, true);
        assert.equal(judgment.evidence.checks.changedFiles, false);
      }),

      t.test('aci-01 rejects decoy-only edit leaving tenant-context & rbac-guard broken', async (subT) => {
        const task = byId['aci-01-auth-tenant-boundary'];
        const ws = await instantiateAciGovernanceWorkspace(task);
        subT.after(() => removeFixtureWorkspace(ws));
        applyWorkspaceFiles(ws, {
          'src/legacy/v1-auth-compat.js': '// touched decoy only\nexport function verifyV1Token() { return { ok: true }; }\n',
        });
        const judgment = await task.judge({
          task,
          output: buildAciGovernanceEvidenceOutput(task, ['src/legacy/v1-auth-compat.js']),
          context: buildTrustedContext(task, ws, activeSandbox),
        });
        assert.equal(judgment.passed, false);
        assert.equal(judgment.hardVetoed, true);
        assert.equal(judgment.evidence.hiddenAcceptancePassed, false);
        assert.ok(judgment.vetoReasons.includes('hidden_acceptance_failed'));
      }),

      t.test('aci-02 rejects broken WAL corrupt-tail and C1..C4 constraint violation', async (subT) => {
        const task = byId['aci-02-persistence-wal-ledger'];
        const ws = await instantiateAciGovernanceWorkspace(task);
        subT.after(() => removeFixtureWorkspace(ws));
        const ref = getAciGovernanceReferenceFix(task.id, ws);
        applyWorkspaceFiles(ws, {
          ...ref,
          'src/persistence/wal-store.js': ref['src/persistence/wal-store.js'].replace('verifyWalChecksum', 'verifyBrokenChecksum'),
        });
        const judgment = await task.judge({
          task,
          output: buildAciGovernanceEvidenceOutput(task),
          context: buildTrustedContext(task, ws, activeSandbox),
        });
        assert.equal(judgment.passed, false);
        assert.equal(judgment.hardVetoed, true);
        assert.equal(judgment.evidence.checks.constraintsPreserved, false);
        assert.equal(judgment.evidence.failureCategory, 'constraint_dropped');
      }),

      t.test('aci-03 rejects reversed precedence order via Docker hidden acceptance', async (subT) => {
        const task = byId['aci-03-contract-pipeline-refactor'];
        const ws = await instantiateAciGovernanceWorkspace(task);
        subT.after(() => removeFixtureWorkspace(ws));
        const ref = getAciGovernanceReferenceFix(task.id, ws);
        applyWorkspaceFiles(ws, {
          ...ref,
          'src/pipeline/precedence-resolver.js': ref['src/pipeline/precedence-resolver.js'].replace(
            '["cli", "env", "workspace", "defaults"]',
            '["defaults", "workspace", "env", "cli"]',
          ),
        });
        const judgment = await task.judge({
          task,
          output: buildAciGovernanceEvidenceOutput(task),
          context: buildTrustedContext(task, ws, activeSandbox),
        });
        assert.equal(judgment.passed, false);
        assert.equal(judgment.hardVetoed, true);
        assert.equal(judgment.evidence.hiddenAcceptancePassed, false);
      }),

      t.test('aci-04 rejects naive path-guard and forged AUDIT_REPORT.json digest', async (subT) => {
        const task = byId['aci-04-long-horizon-security-audit'];
        const ws = await instantiateAciGovernanceWorkspace(task);
        subT.after(() => removeFixtureWorkspace(ws));
        const ref = getAciGovernanceReferenceFix(task.id, ws);
        applyWorkspaceFiles(ws, {
          ...ref,
          'AUDIT_REPORT.json': JSON.stringify({
            schemaVersion: '1.0.0',
            chainValid: true,
            eventCount: 3,
            chainHeadHash: '0'.repeat(64),
            artifactDigests: [],
            rootDigestSha256: '0'.repeat(64),
            entries: [],
          }),
        });
        const judgment = await task.judge({
          task,
          output: buildAciGovernanceEvidenceOutput(task),
          context: buildTrustedContext(task, ws, activeSandbox),
        });
        assert.equal(judgment.passed, false);
        assert.equal(judgment.hardVetoed, true);
        assert.equal(judgment.evidence.checks.auditReportDigestValid, false);
      }),

      t.test('rejects weakened baseline test fail-fast', async (subT) => {
        const task = byId['aci-01-auth-tenant-boundary'];
        const ws = await instantiateAciGovernanceWorkspace(task);
        subT.after(() => removeFixtureWorkspace(ws));
        applyWorkspaceFiles(ws, {
          ...getAciGovernanceReferenceFix(task.id, ws),
          'test/auth-baseline.test.js': "import test from 'node:test'; import assert from 'node:assert/strict'; test('weakened', () => assert.ok(true));\n",
        });
        const judgment = await task.judge({
          task,
          output: buildAciGovernanceEvidenceOutput(task),
          context: buildTrustedContext(task, ws, activeSandbox),
        });
        assert.equal(judgment.passed, false);
        assert.equal(judgment.hardVetoed, true);
        assert.equal(judgment.evidence.baselineTestsUntampered, false);
        assert.deepEqual(judgment.evidence.tamperedBaselineTestFiles, ['test/auth-baseline.test.js']);
        assert.ok(judgment.vetoReasons.includes('baseline_tests_tampered'));
      }),

      t.test('rejects modified protected contract file (CONTRACT.json)', async (subT) => {
        const task = byId['aci-03-contract-pipeline-refactor'];
        const ws = await instantiateAciGovernanceWorkspace(task);
        subT.after(() => removeFixtureWorkspace(ws));
        applyWorkspaceFiles(ws, {
          ...getAciGovernanceReferenceFix(task.id, ws),
          'CONTRACT.json': '{"tampered":true}\n',
        });
        const judgment = await task.judge({
          task,
          output: buildAciGovernanceEvidenceOutput(task),
          context: buildTrustedContext(task, ws, activeSandbox),
        });
        assert.equal(judgment.passed, false);
        assert.equal(judgment.hardVetoed, true);
        assert.equal(judgment.evidence.protectedFilesUntampered, false);
        assert.equal(judgment.evidence.failureCategory, 'protected_files_tampered');
      }),

      t.test('rejects tampered git history fail-fast', async (subT) => {
        const task = byId['aci-02-persistence-wal-ledger'];
        const ws = await instantiateAciGovernanceWorkspace(task);
        subT.after(() => removeFixtureWorkspace(ws));
        applyWorkspaceFiles(ws, getAciGovernanceReferenceFix(task.id, ws));
        runHardenedGitSync(['add', '-A'], { cwd: ws, allowNetwork: false });
        runHardenedGitSync(['commit', '--amend', '-qm', 'tampered history'], { cwd: ws, allowNetwork: false });
        const judgment = await task.judge({
          task,
          output: buildAciGovernanceEvidenceOutput(task),
          context: buildTrustedContext(task, ws, activeSandbox),
        });
        assert.equal(judgment.passed, false);
        assert.equal(judgment.hardVetoed, true);
        assert.equal(judgment.evidence.historyUntouched, false);
        assert.ok(judgment.vetoReasons.includes('history_tampered'));
      }),
    ]);
  });

  test('enforceDeterministicHardVeto prevents advisory override on governance failures', () => {
    const vetoed = enforceDeterministicHardVeto(
      {
        passed: true,
        score: 1,
        evidence: {
          hiddenAcceptancePassed: false,
          baselineTestsUntampered: false,
          historyUntouched: false,
        },
      },
      { passed: true, score: 1, note: 'LLM advisory override attempt' },
    );
    assert.equal(vetoed.passed, false);
    assert.equal(vetoed.score, 0);
    assert.equal(vetoed.hardVetoed, true);
    assert.ok(vetoed.vetoReasons.includes('history_tampered'));
    assert.ok(vetoed.vetoReasons.includes('baseline_tests_tampered'));
    assert.ok(vetoed.vetoReasons.includes('hidden_acceptance_failed'));
  });

  test('computeAciGovernanceMetrics calculates all 9 metrics accurately and retains failed/timeout trials', () => {
    const customGt = {
      criticalFiles: ['src/a.js', 'src/b.js'],
      relevantFiles: ['src/a.js', 'src/b.js', 'src/helper.js'],
      noiseFiles: ['legacy/v0.js', 'fixtures/dump.csv'],
    };

    const trials = [
      // Arm A (raw_full): reads everything including both noise files; passes 1/2 (1 failed retained)
      {
        taskId: 'aci-01-auth-tenant-boundary',
        arm: 'A',
        passed: true,
        status: 'passed',
        groundTruth: customGt,
        tokenUsage: { inputTokens: 8000, outputTokens: 1000, cacheReadTokens: 4000 },
        sseCacheReported: true,
        durationMs: 2000,
        aciMetrics: {
          ledger: {
            admissions: [
              { path: 'src/a.js', decision: 'DIRECT', originalTokens: 500, injectedTokens: 500 },
              { path: 'src/b.js', decision: 'DIRECT', originalTokens: 500, injectedTokens: 500 },
              { path: 'legacy/v0.js', decision: 'DIRECT', originalTokens: 1500, injectedTokens: 1500 },
              { path: 'fixtures/dump.csv', decision: 'DIRECT', originalTokens: 1500, injectedTokens: 1500 },
            ],
          },
        },
      },
      {
        taskId: 'aci-02-persistence-wal-ledger',
        arm: 'A',
        passed: false,
        status: 'timeout',
        groundTruth: customGt,
        tokenUsage: { inputTokens: 9000, outputTokens: 2000, cacheReadTokens: 0 },
        sseCacheReported: false,
        durationMs: 4000,
        aciMetrics: {
          ledger: {
            admissions: [
              { path: 'src/a.js', decision: 'DIRECT', originalTokens: 500, injectedTokens: 500 },
              { path: 'legacy/v0.js', decision: 'DIRECT', originalTokens: 1500, injectedTokens: 1500 },
            ],
          },
        },
      },
      // Arm B: falsely marks src/b.js as IRRELEVANT -> falseNegativeRate > 0 & falselyMarkedIrrelevantCount = 1
      {
        taskId: 'aci-01-auth-tenant-boundary',
        arm: 'B',
        passed: false,
        status: 'failed',
        groundTruth: customGt,
        tokenUsage: { inputTokens: 5000, outputTokens: 1000, cacheReadTokens: 2500 },
        sseCacheReported: true,
        durationMs: 2200,
        aciMetrics: {
          ledger: {
            admissions: [
              { path: 'src/a.js', decision: 'DIRECT', originalTokens: 500, injectedTokens: 500 },
              { path: 'src/b.js', decision: 'IRRELEVANT', originalTokens: 500, injectedTokens: 20 },
              { path: 'legacy/v0.js', decision: 'IRRELEVANT', originalTokens: 1500, injectedTokens: 20 },
            ],
          },
        },
      },
      // Arm D: full ACI with Supervisor + DEFER + verified expand_context recovery -> passes with 100% precision & recall
      {
        taskId: 'aci-01-auth-tenant-boundary',
        arm: 'D',
        passed: true,
        status: 'passed',
        groundTruth: customGt,
        tokenUsage: { inputTokens: 4000, outputTokens: 1000, cacheReadTokens: 3200 },
        sseCacheReported: true,
        durationMs: 1800,
        aciMetrics: {
          restoredCount: 1,
          hashVerifiedRestores: 1,
          ledger: {
            admissions: [
              { path: 'src/a.js', decision: 'DIRECT', originalTokens: 500, injectedTokens: 500 },
              { path: 'src/b.js', decision: 'DEFER', originalTokens: 500, injectedTokens: 30 },
              { path: 'legacy/v0.js', decision: 'IRRELEVANT', originalTokens: 1500, injectedTokens: 20 },
              { path: 'fixtures/dump.csv', decision: 'IRRELEVANT', originalTokens: 1500, injectedTokens: 20 },
            ],
            supervisorCalls: [
              { stage: 'admission', inputTokens: 300, outputTokens: 50, totalTokens: 350, durationMs: 45, ok: true },
            ],
            recoveries: [
              { path: 'src/b.js', level: 'verbatim', verified: true, tokensRestored: 450, step: 2 },
            ],
          },
        },
      },
    ];

    const summary = computeAciGovernanceMetrics(trials, { baselineArm: 'A' });
    assert.equal(summary.totalTrials, 4);
    assert.equal(summary.passedTrials, 2);
    assert.equal(summary.failedTrials, 2);
    assert.equal(summary.trials.length, 4, 'must retain 100% of failed & timeout trials');
    assert.deepEqual(summary.arms, ['A', 'B', 'D']);

    const armA = summary.byArm.A;
    assert.equal(armA.finalTaskSuccessRate, 0.5);
    assert.equal(armA.criticalContextRecall, 0.75); // (1.0 + 0.5) / 2
    assert.equal(armA.contextPrecision, 0.5); // (2/4 + 1/2) / 2
    assert.equal(armA.falseNegativeRate, 0.25);
    assert.equal(armA.usefulTokenRatio, 0.25); // (500+500+500) / (4000+2000) = 1500/6000
    assert.equal(armA.tokenReduction, 0);
    assert.equal(armA.cacheHitRate, 0.2353); // 4000 / 17000
    assert.equal(armA.cacheHitRateDetail.sseReportedRate, 0.5); // 4000 / 8000
    assert.equal(armA.supervisorCost.calls, 0);
    assert.equal(armA.recoverySuccessRate, 0);

    const armB = summary.byArm.B;
    assert.equal(armB.finalTaskSuccessRate, 0);
    assert.equal(armB.criticalContextRecall, 0.5);
    assert.equal(armB.falseNegativeRate, 0.5);
    assert.equal(armB.falselyMarkedIrrelevantCount, 1);

    const armD = summary.byArm.D;
    assert.equal(armD.finalTaskSuccessRate, 1);
    assert.equal(armD.criticalContextRecall, 1);
    assert.equal(armD.contextPrecision, 1);
    assert.equal(armD.falseNegativeRate, 0);
    assert.equal(armD.falselyMarkedIrrelevantCount, 0);
    assert.equal(armD.usefulTokenRatio, 0.9608); // (500+30+450)/(500+30+20+20+450) = 980/1020
    assert.equal(armD.tokenReduction, 0.5); // (10000 - 5000) / 10000
    assert.equal(armD.cacheHitRate, 0.8); // 3200 / 4000
    assert.equal(armD.supervisorCost.calls, 1);
    assert.equal(armD.supervisorCost.totalTokens, 350);
    assert.equal(armD.supervisorCost.tokenShareOfTotal, 0.07); // 350 / 5000
    assert.equal(armD.recoverySuccessRate, 1);
    assert.equal(armD.recoveryStats.trialsWithRecovery, 1);
    assert.equal(armD.recoveryStats.recoveryAssistedPassRate, 1);
    assert.ok(summary.byTask['aci-01-auth-tenant-boundary'].byArm.D);
  });

  test('CLI argument parsing, arm profile mapping, capability probe, and real-mode fail-closed guard', async () => {
    const parsed = parseAciCliArgs([
      '--mode', 'deterministic',
      '--arms', 'A,B,C,D',
      '--suite', 'aci',
      '--tasks', 'aci-01-auth-tenant-boundary,aci-04-long-horizon-security-audit',
      '--repeats', '1',
      '--dtoc-min-prompt-tokens', '28000',
      '--max-steps', '16',
      '--max-tokens', '120000',
      '--sandbox', 'node-permission',
      '--json',
    ]);
    assert.equal(parsed.mode, 'deterministic');
    assert.deepEqual(parsed.arms, ['A', 'B', 'C', 'D']);
    assert.equal(parsed.suite, 'aci');
    assert.deepEqual(parsed.tasks, ['aci-01-auth-tenant-boundary', 'aci-04-long-horizon-security-audit']);
    assert.equal(parsed.dtocMinPromptTokens, 28000);
    assert.equal(parsed.maxSteps, 16);
    assert.equal(parsed.maxTokens, 120000);
    assert.equal(parsed.sandbox, 'node-permission');
    assert.equal(parsed.json, true);

    assert.equal(resolveArmProfileConfig('A').aciProfile, ACI_ARM_PROFILES.A.aciProfile);
    assert.equal(resolveArmProfileConfig('B').aciProfile, ACI_ARM_PROFILES.B.aciProfile);
    assert.equal(resolveArmProfileConfig('C').aciProfile, ACI_ARM_PROFILES.C.aciProfile);
    assert.equal(resolveArmProfileConfig('D', { dtocMinPromptTokens: 24000 }).aciProfile, ACI_ARM_PROFILES.D.aciProfile);
    assert.equal(resolveArmProfileConfig('D', { dtocMinPromptTokens: 24000 }).aciOptions.dtocMinPromptTokens, 24000);

    const probed = await probeAciRuntimeCapabilities();
    assert.equal(typeof probed.capabilities.aciAdmission, 'boolean');
    assert.equal(typeof probed.modules.ACIEngine, 'function');

    const prevKey = process.env.TI_BENCH_KEY;
    const prevAltKey = process.env.AGENT_US_BENCH_KEY;
    const prevHardeningEnv = process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY;
    delete process.env.TI_BENCH_KEY;
    delete process.env.AGENT_US_BENCH_KEY;
    if (!DOCKER_AVAILABLE) {
      process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY = '1';
    }
    try {
      await assert.rejects(
        () =>
          runAciGovernanceBenchmark({
            ...parseAciCliArgs(['--mode', 'real', '--arms', 'A', '--tasks', 'aci-01']),
            sandbox: DOCKER_AVAILABLE ? SANDBOX_MODES.STRONG : SANDBOX_MODES.NODE_PERMISSION,
          }),
        /TI_BENCH_KEY/i,
      );
    } finally {
      if (prevKey !== undefined) process.env.TI_BENCH_KEY = prevKey;
      if (prevAltKey !== undefined) process.env.AGENT_US_BENCH_KEY = prevAltKey;
      if (!DOCKER_AVAILABLE) {
        if (prevHardeningEnv === undefined) {
          delete process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY;
        } else {
          process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY = prevHardeningEnv;
        }
      }
    }
  });

  test('deterministic 4-arm A/B/C/D CLI smoke executes cleanly in active sandbox and separates governance arms', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'agent-us-aci-cli-out-'));
    const outPath = join(outDir, 'aci-bench.jsonl');
    const summaryPath = buildSummaryOutputPath(outPath);
    const prevHardeningEnv = process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY;
    try {
      if (!DOCKER_AVAILABLE) {
        process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY = '1';
      }
      const opts = {
        ...parseAciCliArgs([
          '--mode', 'deterministic',
          '--arms', 'A,B,C,D',
          '--suite', 'aci',
          '--tasks', 'aci-01-auth-tenant-boundary,aci-04-long-horizon-security-audit',
          '--repeats', '1',
          '--dtoc-min-prompt-tokens', '24000',
          '--output', outPath,
        ]),
        sandbox: DOCKER_AVAILABLE ? SANDBOX_MODES.STRONG : SANDBOX_MODES.NODE_PERMISSION,
      };
      const summary = await runAciGovernanceBenchmark(opts);
      assert.equal(summary.benchmarkId, ACI_GOVERNANCE_BENCHMARK_ID);
      assert.equal(
        summary.sandboxBackend,
        DOCKER_AVAILABLE ? SANDBOX_MODES.DOCKER : SANDBOX_MODES.NODE_PERMISSION,
      );
      assert.equal(summary.metrics.totalTrials, 8);
      assert.equal(summary.metrics.passedTrials, 8);
      assert.equal(summary.metrics.failedTrials, 0);

      const { A, B, C, D } = summary.metrics.byArm;
      assert.equal(A.finalTaskSuccessRate, 1);
      assert.equal(B.finalTaskSuccessRate, 1);
      assert.equal(C.finalTaskSuccessRate, 1);
      assert.equal(D.finalTaskSuccessRate, 1);

      assert.ok(C.contextPrecision > B.contextPrecision, `Expected Arm C precision (${C.contextPrecision}) > Arm B (${B.contextPrecision})`);
      assert.ok(B.contextPrecision > A.contextPrecision, `Expected Arm B precision (${B.contextPrecision}) > Arm A (${A.contextPrecision})`);
      assert.ok(D.usefulTokenRatio > A.usefulTokenRatio);
      assert.ok(D.tokenReduction > 0);
      assert.equal(A.supervisorCost.calls, 0);
      assert.equal(B.supervisorCost.calls, 0);
      assert.ok(C.supervisorCost.calls > 0);
      assert.ok(D.supervisorCost.calls > 0);
      assert.equal(D.recoverySuccessRate, 1);
      assert.ok(D.recoveryStats.hashVerified >= 2);

      const jsonlLines = readFileSync(outPath, 'utf8').trim().split(/\r?\n/);
      assert.equal(jsonlLines.length, 8);
      assert.equal(existsSync(summaryPath), true);
      const savedSummary = JSON.parse(readFileSync(summaryPath, 'utf8'));
      assert.equal(savedSummary.metrics.totalTrials, 8);
    } finally {
      if (!DOCKER_AVAILABLE) {
        if (prevHardeningEnv === undefined) {
          delete process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY;
        } else {
          process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY = prevHardeningEnv;
        }
      }
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('supports AR suite short-task KV check (Arms A vs D preserve 0 mid-task DTOC transitions below dtocMinPromptTokens)', async () => {
    const prevHardeningEnv = process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY;
    try {
      if (!DOCKER_AVAILABLE) {
        process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY = '1';
      }
      const summary = await runAciGovernanceBenchmark({
        ...parseAciCliArgs([
          '--mode', 'deterministic',
          '--arms', 'A,D',
          '--suite', 'ar',
          '--tasks', 'ar-06-test-failure-repair',
          '--repeats', '1',
          '--dtoc-min-prompt-tokens', '24000',
        ]),
        sandbox: DOCKER_AVAILABLE ? SANDBOX_MODES.STRONG : SANDBOX_MODES.NODE_PERMISSION,
      });
      assert.equal(summary.suite, 'ar');
      assert.equal(summary.metrics.totalTrials, 2);
      assert.equal(summary.metrics.passedTrials, 2);
      assert.equal(summary.metrics.byArm.D.dtocStats.epochTransitions, 0);
      assert.ok(summary.metrics.byArm.D.cacheHitRate >= summary.metrics.byArm.A.cacheHitRate);
    } finally {
      if (!DOCKER_AVAILABLE) {
        if (prevHardeningEnv === undefined) {
          delete process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY;
        } else {
          process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY = prevHardeningEnv;
        }
      }
    }
  });
});
