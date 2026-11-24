import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import {
  ACI_26_EXTRA_TASK_IDS,
  ACI_GOVERNANCE_25_TASK_IDS,
  ACI_GOVERNANCE_26_DATASET,
  ACI_GOVERNANCE_26_TASK_IDS,
  ACI_GOVERNANCE_TASK_IDS,
  TRAJECTORY_EVICTION_V26_DTOC_POLICY,
  applyWorkspaceFiles,
  buildAciGovernanceEvidenceOutput,
  computeAciGovernanceMetrics,
  createAciGovernanceDataset,
  exportPaperTablesMarkdown,
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
  EvaluationService,
  loadLatestAciAblationSummary,
} from '../../src/evaluation/service.js';
import { registerIntelligenceRoutes } from '../../src/routes/intelligence-routes.js';
import { Store } from '../../src/store.js';
import {
  BenchmarkSandbox,
  DockerBenchmarkSandbox,
  SANDBOX_MODES,
  runHardenedGitSync,
} from '../../src/tools/benchmark-sandbox.js';
import {
  isAciSupervisorWireRequest,
  mergeSupervisorCostTelemetry,
  parseAciCliArgs,
  probeAciRuntimeCapabilities,
  resolveArmProfileConfig,
  resolveBenchmarkTaskMaxTokens,
  runAciGovernanceBenchmark,
} from '../../scripts/benchmark-aci-governance.mjs';
import { authorizeRealBenchmarkApproval } from '../../scripts/benchmark-autonomous-reasoning.mjs';

const DOCKER_AVAILABLE = new DockerBenchmarkSandbox().isAvailable();
const TEST_SANDBOX_OPTIONS = DOCKER_AVAILABLE
  ? { mode: SANDBOX_MODES.STRONG }
  : { mode: SANDBOX_MODES.NODE_PERMISSION, allowProcessHardeningOnly: true };

function buildTrustedContext(task, workspaceRoot, sandbox) {
  return {
    workspaceRoot,
    sandbox,
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

describe('Agent_US 2.6 Paper Evaluation, Wire Telemetry & Evidence API Suite', () => {
  const activeSandbox = new BenchmarkSandbox(TEST_SANDBOX_OPTIONS);
  const cleanupDirs = [];
  const prevProcessHardening = process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY;
  if (!DOCKER_AVAILABLE) {
    process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY = '1';
  }

  after(() => {
    if (prevProcessHardening === undefined) {
      delete process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY;
    } else {
      process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY = prevProcessHardening;
    }
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('isAciSupervisorWireRequest rejects compaction/grace tools:[] calls and matches only genuine ACI supervisor prompts', () => {
    assert.equal(
      isAciSupervisorWireRequest({
        tools: [],
        messages: [
          {
            role: 'system',
            content:
              'You are a strictly read-only Context Supervisor for Adaptive Context Intelligence (ACI).',
          },
          { role: 'user', content: '{}' },
        ],
      }),
      true,
    );

    assert.equal(
      isAciSupervisorWireRequest({
        tools: [],
        messages: [
          {
            role: 'developer',
            content: [
              {
                type: 'text',
                text: 'You are a strictly read-only Pre-Injection Context Admission Supervisor for Adaptive Context Intelligence (ACI).',
              },
            ],
          },
        ],
      }),
      true,
    );

    assert.equal(
      isAciSupervisorWireRequest({
        system: [
          {
            type: 'text',
            text: 'You are a strictly read-only Context Supervisor for Adaptive Context Intelligence (ACI).',
          },
        ],
        messages: [{ role: 'user', content: '{}' }],
      }),
      true,
    );

    // Compaction & grace-step calls have tools: [] without the Supervisor prompt marker
    assert.equal(
      isAciSupervisorWireRequest({
        tools: [],
        messages: [
          { role: 'system', content: 'Summarize conversation history compactly.' },
          { role: 'user', content: 'Compaction input' },
        ],
      }),
      false,
    );
    assert.equal(
      isAciSupervisorWireRequest({
        tools: [],
        messages: [
          { role: 'system', content: 'Agent_US main coding runtime static prompt.' },
          { role: 'user', content: 'Budget exhausted after tests passed; wrap up without tools.' },
        ],
      }),
      false,
    );

    // Non-empty tools array or user-only mention must never match
    assert.equal(
      isAciSupervisorWireRequest({
        tools: [{ type: 'function', function: { name: 'read_file' } }],
        messages: [
          {
            role: 'system',
            content: 'Context Supervisor for Adaptive Context Intelligence (ACI).',
          },
        ],
      }),
      false,
    );
    assert.equal(
      isAciSupervisorWireRequest({
        tools: [],
        messages: [
          { role: 'system', content: 'Main agent prompt.' },
          {
            role: 'user',
            content: 'Supervisor for Adaptive Context Intelligence (ACI)',
          },
        ],
      }),
      false,
    );
    assert.equal(isAciSupervisorWireRequest(null), false);

    // Disabled supervisor arm forces zero telemetry
    assert.deepEqual(
      mergeSupervisorCostTelemetry(
        { calls: 3, inputTokens: 900, outputTokens: 200, totalTokens: 1100, durationMs: 500 },
        [{ inputTokens: 100, outputTokens: 50, ms: 25 }],
        3,
        { supervisorEnabled: false },
      ),
      { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0, fallbackCount: 0 },
    );
  });

  test('real-mode wire capture keeps Arm A/B Sup Tok strictly 0 even when tools:[] grace/compaction calls happen, and excludes non-supervisor tools:[] on Arm C', async () => {
    const origFetch = globalThis.fetch;
    let supReqCount = 0;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = {};
        }
        const sysText = JSON.stringify(parsed.messages?.filter((m) => m.role === 'system' || m.role === 'developer') ?? []);
        const isSup = sysText.includes('Supervisor for Adaptive Context Intelligence (ACI)');
        if (isSup) supReqCount += 1;

        const promptTok = isSup ? 300 : 120;
        const compTok = isSup ? 40 : 15;

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const payloadChunk = {
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: isSup ? '{"decisions":[],"contractHints":[]}' : 'Completed mock trial.',
              },
              finish_reason: null,
            },
          ],
        };
        const usageChunk = {
          id: 'chatcmpl-usage',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: promptTok,
            completion_tokens: compTok,
            total_tokens: promptTok + compTok,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        };
        res.write(`data: ${JSON.stringify(payloadChunk)}\n\n`);
        res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });

    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const addr = server.address();
    const endpointUrl = `http://127.0.0.1:${addr.port}/v1`;

    const prevKey = process.env.TI_BENCH_KEY;
    const prevEndpoint = process.env.TI_BENCH_ENDPOINT;
    const prevModel = process.env.TI_BENCH_MODEL;
    const outDir = mkdtempSync(join(tmpdir(), 'eval26-wiresup-'));
    cleanupDirs.push(outDir);

    try {
      process.env.TI_BENCH_KEY = 'sk-test-eval26-wiresup';
      process.env.TI_BENCH_ENDPOINT = endpointUrl;
      process.env.TI_BENCH_MODEL = 'mock-eval-26';

      const summary = await runAciGovernanceBenchmark({
        mode: 'real',
        arms: ['A', 'B', 'C'],
        suite: 'aci',
        tasks: ['aci-01'],
        repeats: 1,
        concurrency: 3,
        resume: false,
        lane: 0,
        lanes: 1,
        output: join(outDir, 'wiresup.jsonl'),
        archiveDir: null,
        archivePrefix: null,
        exportPaper: null,
        exportLatex: null,
        aciProfile: null,
        dtocPolicy: null,
        maxSteps: 1,
        maxTokens: null,
        dtocMinPromptTokens: 24000,
        sandbox: activeSandbox.mode,
      });

      assert.equal(globalThis.fetch, origFetch);
      assert.equal(summary.metrics.byArm.A.supervisorCost.calls, 0);
      assert.equal(summary.metrics.byArm.A.supervisorCost.totalTokens, 0);
      assert.equal(summary.metrics.byArm.B.supervisorCost.calls, 0);
      assert.equal(summary.metrics.byArm.B.supervisorCost.totalTokens, 0);
      assert.equal(supReqCount, 0);
      assert.equal(summary.metrics.byArm.C.supervisorCost.totalTokens, 0);
    } finally {
      globalThis.fetch = origFetch;
      if (prevKey === undefined) delete process.env.TI_BENCH_KEY;
      else process.env.TI_BENCH_KEY = prevKey;
      if (prevEndpoint === undefined) delete process.env.TI_BENCH_ENDPOINT;
      else process.env.TI_BENCH_ENDPOINT = prevEndpoint;
      if (prevModel === undefined) delete process.env.TI_BENCH_MODEL;
      else process.env.TI_BENCH_MODEL = prevModel;
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

  test('calibrates aci-06 to 240k, exposes 7-task ACI_GOVERNANCE_26_TASK_IDS with aci-07 (220k, 20+ files, 8 decoys), and maps aci26 full_aci -> trajectory_eviction_v26', () => {
    assert.equal(ACI_GOVERNANCE_TASK_IDS.length, 4);
    assert.equal(ACI_GOVERNANCE_25_TASK_IDS.length, 6);
    assert.deepEqual(ACI_26_EXTRA_TASK_IDS, ['aci-07-cross-module-evolution']);
    assert.equal(ACI_GOVERNANCE_26_TASK_IDS.length, 7);
    assert.equal(ACI_GOVERNANCE_26_DATASET.length, 7);
    assert.equal(TRAJECTORY_EVICTION_V26_DTOC_POLICY, 'trajectory_eviction_v26');

    const dsDefault = createAciGovernanceDataset({ sandbox: activeSandbox });
    const ds25 = createAciGovernanceDataset({ sandbox: activeSandbox, suite: 'aci25' });
    const ds26 = createAciGovernanceDataset({ sandbox: activeSandbox, suite: 'aci26' });
    assert.equal(dsDefault.length, 4);
    assert.equal(ds25.length, 6);
    assert.equal(ds26.length, 7);

    const aci06 = ds26.find((t) => t.id === 'aci-06-swarm-contract-integration');
    const aci07 = ds26.find((t) => t.id === 'aci-07-cross-module-evolution');
    assert.ok(aci06 && aci07);
    assert.equal(aci06.resourceBudget.maxTokens, 240_000);
    assert.equal(aci06.resourceBudget.maxTotalTokens, 240_000);
    assert.equal(resolveBenchmarkTaskMaxTokens(aci06, parseAciCliArgs([])), 240_000);

    validateTask(aci07);
    assert.equal(aci07.resourceBudget.maxTokens, 220_000);
    assert.equal(aci07.resourceBudget.maxTotalTokens, 220_000);
    assert.equal(resolveBenchmarkTaskMaxTokens(aci07, parseAciCliArgs([])), 220_000);

    const files = Object.keys(aci07.fixture.files);
    assert.ok(files.length >= 20, `Expected >= 20 files for aci-07, got ${files.length}`);
    assert.equal(aci07.metadata.groundTruth.noiseFiles.length, 8);
    for (const decoy of aci07.metadata.groundTruth.noiseFiles) {
      assert.ok(
        Buffer.byteLength(aci07.fixture.files[decoy] || '', 'utf8') > 2500,
        `aci-07 decoy ${decoy} must exceed 2.5 KB`,
      );
      assert.equal(aci07.prompt.includes(decoy), false, `aci-07 prompt leaked decoy ${decoy}`);
    }
    assert.equal(aci07.prompt.includes('groundTruth'), false);
    assert.equal(JSON.stringify(aci07.expected).includes('groundTruth'), false);

    // Suite policy mapping & overrides
    const parsed26 = parseAciCliArgs([
      '--suite', 'aci26',
      '--arms', 'A,C,D',
      '--archive-dir', 'docs/evidence',
      '--archive-prefix', 'aci-26-ablation',
    ]);
    assert.equal(parsed26.suite, 'aci26');
    assert.equal(parsed26.archiveDir, 'docs/evidence');
    assert.equal(parsed26.archivePrefix, 'aci-26-ablation');

    const cfg26 = resolveArmProfileConfig('D', { suite: 'aci26' });
    assert.equal(cfg26.aciProfile, 'full_aci');
    assert.equal(cfg26.aciOptions.dtocPolicy, 'trajectory_eviction_v26');

    const cfg26Override = resolveArmProfileConfig('D', {
      suite: 'aci26',
      dtocPolicy: 'phase_watermark_v25',
    });
    assert.equal(cfg26Override.aciOptions.dtocPolicy, 'phase_watermark_v25');

    const cfg25Compat = resolveArmProfileConfig('D', { suite: 'aci25' });
    assert.equal(cfg25Compat.aciOptions.dtocPolicy, 'phase_watermark_v25');

    const cfgStage4 = resolveArmProfileConfig('D', { suite: 'aci' });
    assert.equal(cfgStage4.aciOptions.dtocPolicy, undefined);

    assert.equal(
      authorizeRealBenchmarkApproval({ toolName: 'query_symbol_graph', args: { symbol: 'run' } }),
      true,
    );
  });

  test('aci-07 materializes pinned repo, exposes caller-fix requirement after pipeline evolution, passes hidden acceptance with fix, and rejects broken/tampered variants', async () => {
    const bareRoot = mkdtempSync(join(tmpdir(), 'eval26-mirrors-'));
    cleanupDirs.push(bareRoot);

    const { repoOverrides, cleanup } = await materializeAciGovernanceRepos(bareRoot, {
      suite: 'aci26',
    });
    try {
      const ds26 = createAciGovernanceDataset({
        sandbox: activeSandbox,
        suite: 'aci26',
        repoOverrides,
      });
      const aci07 = ds26.find((t) => t.id === 'aci-07-cross-module-evolution');
      assert.ok(aci07);
      assert.match(aci07.fixture.commit, /^[0-9a-f]{40}$/);

      // 1. Pinned baseline passes initially, reference fix passes full hidden acceptance
      {
        const ws = await instantiateAciGovernanceWorkspace(aci07, { prefix: 'eval26-ref-07-' });
        try {
          assert.equal(getWorkspaceBaselineCommit(ws), aci07.fixture.commit);
          assert.equal(verifyWorkspacePinnedBaseline(ws, aci07.fixture.commit).ok, true);
          assert.deepEqual(listWorkspaceChangedFiles(ws), []);

          const baseRun = await activeSandbox.execArgv(aci07.fixture.baselineTestCommand, {
            workspaceRoot: ws,
            cwd: ws,
            timeoutMs: 20_000,
          });
          assert.equal(baseRun.exitCode, 0, baseRun.stderr || baseRun.stdout);

          const fix = getAciGovernanceReferenceFix(aci07.id, ws);
          // Evolving transformer without fixing caller pipeline-runner breaks baseline test!
          applyWorkspaceFiles(ws, {
            'src/validators/state-validator.js': fix['src/validators/state-validator.js'],
            'src/adapters/v2-envelope-adapter.js': fix['src/adapters/v2-envelope-adapter.js'],
            'src/pipeline/event-transformer.js': fix['src/pipeline/event-transformer.js'],
          });
          const unfixedCallerRun = await activeSandbox.execArgv(aci07.fixture.baselineTestCommand, {
            workspaceRoot: ws,
            cwd: ws,
            timeoutMs: 20_000,
          });
          assert.notEqual(
            unfixedCallerRun.exitCode,
            0,
            'Expected baseline test to fail until pipeline-runner caller is updated to pass contract',
          );

          // Apply remaining caller fix -> passes both baseline and hidden acceptance
          applyWorkspaceFiles(ws, {
            'src/cli/pipeline-runner.js': fix['src/cli/pipeline-runner.js'],
          });
          const judgment = await aci07.judge({
            task: aci07,
            output: buildAciGovernanceEvidenceOutput(aci07),
            context: buildTrustedContext(aci07, ws, activeSandbox),
          });
          assert.equal(judgment.passed, true, `${judgment.reason}: ${JSON.stringify(judgment.evidence.errors)}`);
          assert.equal(judgment.hardVetoed, false);
        } finally {
          await removeFixtureWorkspace(ws);
        }
      }

      // 2. Untouched and protected CONTRACT.json tamper fail closed
      {
        const ws = await instantiateAciGovernanceWorkspace(aci07, { prefix: 'eval26-tamper-07-' });
        try {
          const untouched = await aci07.judge({
            task: aci07,
            output: buildAciGovernanceEvidenceOutput(aci07),
            context: buildTrustedContext(aci07, ws, activeSandbox),
          });
          assert.equal(untouched.passed, false);
          assert.equal(untouched.hardVetoed, true);

          const fix = getAciGovernanceReferenceFix(aci07.id, ws);
          applyWorkspaceFiles(ws, { ...fix, 'CONTRACT.json': '{"tampered":true}\n' });
          const tampered = await aci07.judge({
            task: aci07,
            output: buildAciGovernanceEvidenceOutput(aci07),
            context: buildTrustedContext(aci07, ws, activeSandbox),
          });
          assert.equal(tampered.passed, false);
          assert.equal(tampered.evidence.failureCategory, 'protected_files_tampered');
          assert.equal(enforceDeterministicHardVeto(tampered, 1.0).passed, false);
        } finally {
          await removeFixtureWorkspace(ws);
        }
      }

      // 3. Git history rewrite fails closed
      {
        const ws = await instantiateAciGovernanceWorkspace(aci07, { prefix: 'eval26-hist-07-' });
        try {
          const fix = getAciGovernanceReferenceFix(aci07.id, ws);
          applyWorkspaceFiles(ws, fix);
          runHardenedGitSync(['add', '-A'], { cwd: ws, allowNetwork: false });
          runHardenedGitSync(['commit', '--amend', '-qm', 'rewrite'], {
            cwd: ws,
            allowNetwork: false,
          });
          const histRes = await aci07.judge({
            task: aci07,
            output: buildAciGovernanceEvidenceOutput(aci07),
            context: buildTrustedContext(aci07, ws, activeSandbox),
          });
          assert.equal(histRes.passed, false);
          assert.equal(histRes.hardVetoed, true);
          assert.equal(histRes.evidence.historyUntouched, false);
        } finally {
          await removeFixtureWorkspace(ws);
        }
      }
    } finally {
      cleanup();
    }
  });

  test('ignores query_symbol_graph non-file admissions and aggregates 2.6 metrics in trials and arm summaries', () => {
    const gt = {
      criticalFiles: ['src/a.js'],
      relevantFiles: ['src/a.js', 'src/b.js'],
      noiseFiles: ['src/legacy/old.js'],
    };

    const metrics = computeAciGovernanceMetrics(
      [
        {
          taskId: 'aci-07-cross-module-evolution',
          arm: 'D',
          rep: 0,
          passed: true,
          status: 'passed',
          groundTruth: gt,
          tokenUsage: { inputTokens: 4000, outputTokens: 800, cacheReadTokens: 2000 },
          reasoningMetrics: { antiThrashingTriggered: 1 },
          aciMetrics: {
            supersededEvictions: 2,
            supersededTokensSaved: 1450,
            partialRecoveries: 1,
            recoveryTokensSaved: 920,
            admissionDecisions: { DIRECT: 2, SUPPORTING: 1, DEFER: 1, DUPLICATE: 1, IRRELEVANT: 2 },
            ledger: {
              admissions: [
                { path: 'src/a.js', toolName: 'read_file', decision: 'DIRECT', originalTokens: 500, injectedTokens: 500 },
                { path: 'query_symbol_graph', toolName: 'query_symbol_graph', decision: 'DIRECT', originalTokens: 400, injectedTokens: 400 },
                { path: 'src/b.js', toolName: 'query_symbol_graph', decision: 'DIRECT', originalTokens: 300, injectedTokens: 300 },
                { path: 'src/legacy/old.js', toolName: 'read_file', decision: 'IRRELEVANT', originalTokens: 900, injectedTokens: 20 },
              ],
            },
          },
        },
        {
          taskId: 'aci-07-cross-module-evolution',
          arm: 'D',
          rep: 1,
          passed: true,
          status: 'passed',
          groundTruth: gt,
          tokenUsage: { inputTokens: 3800, outputTokens: 700, cacheReadTokens: 2100 },
          aciMetrics: {
            ledger: {
              admissions: [
                { path: 'src/a.js', toolName: 'read_file', decision: 'DIRECT', originalTokens: 500, injectedTokens: 500 },
              ],
              compressed: [
                { path: 'src/b.js', superseded: true, tokensSaved: 650 },
              ],
              recoveries: [
                { path: 'src/b.js', mode: 'symbol', verified: true, tokensRestored: 180, tokensSaved: 420 },
              ],
            },
          },
        },
      ],
      { baselineArm: 'A' },
    );

    const armD = metrics.byArm.D;
    // query_symbol_graph must NOT count as non-relevant pollution -> precision remains 1
    assert.equal(armD.contextPrecision, 1);
    assert.equal(armD.supersededEvictions, 3);
    assert.equal(armD.supersededTokensSaved, 2100);
    assert.equal(armD.partialRecoveries, 2);
    assert.equal(armD.recoveryTokensSaved, 1340);
    assert.equal(armD.antiThrashingTriggered, 1);
    assert.deepEqual(armD.decisions, {
      DIRECT: 3,
      SUPPORTING: 1,
      DEFER: 1,
      DUPLICATE: 1,
      IRRELEVANT: 2,
    });

    assert.equal(metrics.trials[0].supersededEvictions, 2);
    assert.equal(metrics.trials[0].antiThrashingTriggered, 1);
    assert.equal(metrics.trials[1].partialRecoveries, 1);

    const md = exportPaperTablesMarkdown({ suite: 'aci26', mode: 'deterministic', metrics });
    assert.ok(md.includes('Table 3: ACI 2.6 Trajectory Eviction'));
    assert.ok(md.includes('2,100'));
    assert.ok(md.includes('3/1/1/1/2'));
  });

  test('archives sanitized 4 files with --archive-dir/--archive-prefix and exposes GET /v1/evaluations/aci-ablation', async (t) => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'eval26-empty-ev-'));
    const archiveDir = mkdtempSync(join(tmpdir(), 'eval26-archive-'));
    cleanupDirs.push(emptyDir, archiveDir);

    assert.deepEqual(loadLatestAciAblationSummary({ evidenceDir: emptyDir }), { available: false });

    const summary = await runAciGovernanceBenchmark({
      ...parseAciCliArgs([
        '--mode', 'deterministic',
        '--suite', 'aci26',
        '--arms', 'A,C,D',
        '--tasks', 'aci-07',
        '--repeats', '1',
        '--concurrency', '3',
        '--archive-dir', archiveDir,
        '--archive-prefix', 'aci-26-smoke',
      ]),
      sandbox: activeSandbox.mode,
    });

    assert.equal(summary.suite, 'aci26');
    assert.equal(summary.executedCount, 3);
    assert.equal(summary.armProfiles.D.aciOptions.dtocPolicy, 'trajectory_eviction_v26');

    const jsonlFile = join(archiveDir, 'aci-26-smoke.jsonl');
    const summaryFile = join(archiveDir, 'aci-26-smoke-summary.json');
    const mdFile = join(archiveDir, 'aci-26-smoke-paper-tables.md');
    const texFile = join(archiveDir, 'aci-26-smoke-paper-tables.tex');
    for (const p of [jsonlFile, summaryFile, mdFile, texFile]) {
      assert.equal(existsSync(p), true, `Missing archived file ${p}`);
    }

    // Write an older summary in the same dir to verify latest selection picks aci-26-smoke
    const olderSummary = {
      ...JSON.parse(readFileSync(summaryFile, 'utf8')),
      suite: 'aci25',
      createdAt: '2025-01-01T00:00:00.000Z',
    };
    writeFileSync(join(archiveDir, 'aci-25-old-summary.json'), JSON.stringify(olderSummary), 'utf8');

    const store = new Store(':memory:');
    const appEmpty = Fastify();
    registerIntelligenceRoutes(appEmpty, {
      evaluation: new EvaluationService({ store, aciEvidenceDir: emptyDir }),
      aciEvidenceDir: emptyDir,
    });
    await appEmpty.ready();

    const appPopulated = Fastify();
    registerIntelligenceRoutes(appPopulated, {
      evaluation: new EvaluationService({ store, aciEvidenceDir: archiveDir }),
      aciEvidenceDir: archiveDir,
    });
    await appPopulated.ready();
    t.after(async () => {
      await appEmpty.close();
      await appPopulated.close();
      store.close();
    });

    const emptyRes = await appEmpty.inject({ method: 'GET', url: '/v1/evaluations/aci-ablation' });
    assert.equal(emptyRes.statusCode, 200);
    assert.deepEqual(emptyRes.json(), { available: false });

    const res = await appPopulated.inject({ method: 'GET', url: '/v1/evaluations/aci-ablation' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.available, true);
    assert.equal(body.suite, 'aci26');
    assert.equal(body.model, 'deterministic-probe');
    assert.ok(typeof body.createdAt === 'string' && body.createdAt.length > 0);
    assert.deepEqual(body.armOrder, ['A', 'C', 'D']);
    assert.equal(body.summaryByArm.A.supervisorCost.totalTokens, 0);
    assert.equal(body.summaryByArm.D.passedTrials, 1);
    assert.equal(body.summaryByArm.D.totalTrials, 1);
    assert.ok(typeof body.summaryByArm.D.passRateCI.rate === 'number');
    assert.ok('pairedPassTokenReduction' in body.summaryByArm.D);
    assert.ok('tokensPerCompletedPass' in body.summaryByArm.D);
    assert.ok(body.latexTable.includes('\\begin{table}'));
    assert.ok(body.markdownTable.includes('Table 1: Overall Arm Comparison'));
  });

  test('probeAciRuntimeCapabilities checks trajectoryEvictionV26 flag cleanly', async () => {
    const caps = await probeAciRuntimeCapabilities();
    assert.equal(typeof caps.capabilities.trajectoryEvictionV26, 'boolean');
  });
});
