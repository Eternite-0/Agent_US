import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACI_25_EXTRA_TASK_IDS,
  ACI_GOVERNANCE_25_DATASET,
  ACI_GOVERNANCE_25_TASK_IDS,
  ACI_GOVERNANCE_DATASET,
  ACI_GOVERNANCE_TASK_IDS,
  applyWorkspaceFiles,
  buildAciGovernanceEvidenceOutput,
  computeAciGovernanceMetrics,
  computeWilson95CI,
  createAciGovernanceDataset,
  exportPaperTablesLatex,
  exportPaperTablesMarkdown,
  getAciGovernanceReferenceFix,
  instantiateAciGovernanceWorkspace,
  materializeAciGovernanceRepos,
  normalizeAciProfileName,
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
  runHardenedGitSync,
} from '../../src/tools/benchmark-sandbox.js';
import {
  buildSummaryOutputPath,
  buildTrialCellKey,
  loadResumeStateFromJsonl,
  parseAciCliArgs,
  probeAciRuntimeCapabilities,
  resolveArmProfileConfig,
  runAciGovernanceBenchmark,
} from '../../scripts/benchmark-aci-governance.mjs';
import { estimateTokens } from '../../src/context.js';

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

describe('Agent_US 2.5 Paper Evaluation & Concurrency Suite', () => {
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

  test('preserves Stage 4 default 4-task exports while exposing 6-task aci25 suite with validated 2.5 tasks', () => {
    assert.equal(ACI_GOVERNANCE_TASK_IDS.length, 4);
    assert.equal(ACI_GOVERNANCE_DATASET.length, 4);
    assert.deepEqual(ACI_25_EXTRA_TASK_IDS, [
      'aci-05-multi-module-patch-refactor',
      'aci-06-swarm-contract-integration',
    ]);
    assert.equal(ACI_GOVERNANCE_25_TASK_IDS.length, 6);
    assert.equal(ACI_GOVERNANCE_25_DATASET.length, 6);

    const dsDefault = createAciGovernanceDataset({ sandbox: activeSandbox });
    const ds25 = createAciGovernanceDataset({ sandbox: activeSandbox, suite: 'aci25' });
    assert.equal(dsDefault.length, 4);
    assert.equal(ds25.length, 6);

    for (const task of ds25.slice(4)) {
      validateTask(task);

      const entries = Object.entries(task.fixture.files);
      assert.ok(entries.length >= 16 && entries.length <= 22, `${task.id} fileCount=${entries.length}`);

      const totalTokens = entries.reduce((sum, [, text]) => sum + estimateTokens(text), 0);
      assert.ok(totalTokens >= 14000 && totalTokens <= 26000, `${task.id} totalTokens=${totalTokens}`);

      const gt = task.metadata.groundTruth;
      assert.ok(gt.criticalFiles.length >= 3);
      assert.ok(gt.noiseFiles.length >= 7, `${task.id} noiseFiles=${gt.noiseFiles.length}`);
      for (const decoy of gt.noiseFiles) {
        assert.ok(
          Buffer.byteLength(task.fixture.files[decoy] || '', 'utf8') > 2500,
          `${task.id} decoy ${decoy} must exceed 2.5 KB`,
        );
        assert.equal(task.prompt.includes(decoy), false, `${task.id} prompt leaked decoy ${decoy}`);
      }
      assert.equal(task.prompt.includes('groundTruth'), false);
      assert.equal(JSON.stringify(task.expected).includes('groundTruth'), false);
    }
  });

  test('aci-05 and aci-06 materialize pinned git repos, pass baseline tests, and pass hidden acceptance with reference fixes', async () => {
    const bareRoot = mkdtempSync(join(tmpdir(), 'eval25-mirrors-'));
    cleanupDirs.push(bareRoot);

    const { repoOverrides, cleanup } = await materializeAciGovernanceRepos(bareRoot, { suite: 'aci25' });
    try {
      const ds25 = createAciGovernanceDataset({ sandbox: activeSandbox, suite: 'aci25', repoOverrides });
      assert.equal(ds25.length, 6);

      for (const task of ds25.slice(4)) {
        assert.match(task.fixture.commit, /^[0-9a-f]{40}$/);
        const ws = await instantiateAciGovernanceWorkspace(task, { prefix: `eval25-ref-${task.id}-` });
        try {
          assert.equal(getWorkspaceBaselineCommit(ws), task.fixture.commit);
          const check = verifyWorkspacePinnedBaseline(ws, task.fixture.commit);
          assert.equal(check.ok, true, check.reason);
          assert.deepEqual(listWorkspaceChangedFiles(ws), []);

          const baseRun = await activeSandbox.execArgv(task.fixture.baselineTestCommand, {
            workspaceRoot: ws,
            cwd: ws,
            allowWorkspaceNodeCli: Boolean(task.metadata.sandboxIsolation.allowWorkspaceNodeCli),
            timeoutMs: 20_000,
          });
          assert.equal(baseRun.exitCode, 0, `${task.id} baseline failed: ${baseRun.stderr || baseRun.stdout}`);

          const fix = getAciGovernanceReferenceFix(task.id, ws);
          applyWorkspaceFiles(ws, fix);

          const judgment = await task.judge({
            task,
            output: buildAciGovernanceEvidenceOutput(task),
            context: buildTrustedContext(task, ws, activeSandbox),
          });
          assert.equal(judgment.passed, true, `${task.id} failed reference judge: ${judgment.reason}`);
          assert.equal(judgment.hardVetoed, false);
        } finally {
          await removeFixtureWorkspace(ws);
        }
      }
    } finally {
      cleanup();
    }
  });

  test('aci-05 and aci-06 judges reject untouched, decoy-only, broken, and tampered fixtures with hard veto', async () => {
    const ds25 = createAciGovernanceDataset({ sandbox: activeSandbox, suite: 'aci25' });
    const aci05 = ds25.find((t) => t.id === 'aci-05-multi-module-patch-refactor');
    const aci06 = ds25.find((t) => t.id === 'aci-06-swarm-contract-integration');
    assert.ok(aci05 && aci06);

    // 1. Untouched aci-05 fails
    {
      const ws = await instantiateAciGovernanceWorkspace(aci05, { prefix: 'eval25-untouched-05-' });
      try {
        const res = await aci05.judge({
          task: aci05,
          output: buildAciGovernanceEvidenceOutput(aci05),
          context: buildTrustedContext(aci05, ws, activeSandbox),
        });
        assert.equal(res.passed, false);
        assert.equal(res.hardVetoed, true);
      } finally {
        await removeFixtureWorkspace(ws);
      }
    }

    // 2. aci-05 decoy-only edit (codes untouched) fails
    {
      const ws = await instantiateAciGovernanceWorkspace(aci05, { prefix: 'eval25-decoy-05-' });
      try {
        applyWorkspaceFiles(ws, { 'docs/legacy/adr-001.md': '# Edited decoy only\n' });
        const res = await aci05.judge({
          task: aci05,
          output: buildAciGovernanceEvidenceOutput(aci05),
          context: buildTrustedContext(aci05, ws, activeSandbox),
        });
        assert.equal(res.passed, false);
        assert.equal(res.hardVetoed, true);
      } finally {
        await removeFixtureWorkspace(ws);
      }
    }

    // 2.5 Broken implementation: partial refactor on aci-05 leaving diagnostics-runner broken fails hidden acceptance
    {
      const ws = await instantiateAciGovernanceWorkspace(aci05, { prefix: 'eval25-broken-05-' });
      try {
        const fix = getAciGovernanceReferenceFix(aci05.id, ws);
        applyWorkspaceFiles(ws, {
          'src/patch/unified-parser.js': fix['src/patch/unified-parser.js'],
          'src/patch/patch-applier.js': fix['src/patch/patch-applier.js'],
        });
        const res = await aci05.judge({
          task: aci05,
          output: buildAciGovernanceEvidenceOutput(aci05),
          context: buildTrustedContext(aci05, ws, activeSandbox),
        });
        assert.equal(res.passed, false);
        assert.equal(res.hardVetoed, true);
        assert.equal(res.evidence.hiddenAcceptancePassed, false);
      } finally {
        await removeFixtureWorkspace(ws);
      }
    }

    // 3. aci-06 protected CONTRACT.json tamper fails fail-fast
    {
      const ws = await instantiateAciGovernanceWorkspace(aci06, { prefix: 'eval25-tamper-06-' });
      try {
        const fix = getAciGovernanceReferenceFix(aci06.id, ws);
        applyWorkspaceFiles(ws, { ...fix, 'CONTRACT.json': '{"tampered":true}\n' });
        const res = await aci06.judge({
          task: aci06,
          output: buildAciGovernanceEvidenceOutput(aci06),
          context: buildTrustedContext(aci06, ws, activeSandbox),
        });
        assert.equal(res.passed, false);
        assert.equal(res.evidence.failureCategory, 'protected_files_tampered');
        assert.equal(enforceDeterministicHardVeto(res, 1.0).passed, false);
      } finally {
        await removeFixtureWorkspace(ws);
      }
    }

    // 4. aci-06 tampered git history fails fail-fast
    {
      const ws = await instantiateAciGovernanceWorkspace(aci06, { prefix: 'eval25-hist-06-' });
      try {
        const fix = getAciGovernanceReferenceFix(aci06.id, ws);
        applyWorkspaceFiles(ws, fix);
        runHardenedGitSync(['add', '-A'], { cwd: ws, allowNetwork: false });
        const commitRes = runHardenedGitSync(['commit', '--amend', '-qm', 'rewrite'], {
          cwd: ws,
          allowNetwork: false,
        });
        assert.equal(commitRes.exitCode, 0, commitRes.stderr || commitRes.stdout);
        const res = await aci06.judge({
          task: aci06,
          output: buildAciGovernanceEvidenceOutput(aci06),
          context: buildTrustedContext(aci06, ws, activeSandbox),
        });
        assert.equal(res.passed, false);
        assert.equal(res.hardVetoed, true);
        assert.equal(res.evidence.historyUntouched, false);
        assert.equal(res.evidence.failureCategory, 'history_tampered');
      } finally {
        await removeFixtureWorkspace(ws);
      }
    }
  });

  test('computes Wilson 95% CI, success-normalized tokens, strict pairedPassTokenReduction, aci_25 profile, and Markdown/LaTeX exports', () => {
    const emptyCi = computeWilson95CI(0, 0);
    assert.deepEqual(emptyCi, { rate: 0, lower: 0, upper: 0, ci95HalfWidth: 0 });

    const ci = computeWilson95CI(8, 10);
    assert.equal(ci.rate, 0.8);
    assert.ok(ci.lower > 0.45 && ci.lower < 0.55);
    assert.ok(ci.upper > 0.92 && ci.upper <= 1);
    assert.ok(ci.ci95HalfWidth > 0.2);

    assert.equal(normalizeAciProfileName('aci_25'), 'aci_25');
    assert.equal(normalizeAciProfileName('full_aci'), 'full_aci');
    const armCfg = resolveArmProfileConfig('D', { aciProfile: 'aci_25', dtocPolicy: 'phase_watermark_v25' });
    assert.equal(armCfg.aciProfile, 'aci_25');
    assert.equal(armCfg.aciOptions.dtocPolicy, 'phase_watermark_v25');

    // Paired check: ONLY (t1, rep 0) passes in both Arm A and Arm D; (t2, 0) & (t3, 0) must be EXCLUDED from pairedPassTokenReduction
    const trials = [
      { taskId: 't1', arm: 'A', rep: 0, passed: true, tokenUsage: { totalTokens: 10000, inputTokens: 8000, outputTokens: 2000, cacheReadTokens: 0 }, groundTruth: { criticalFiles: ['a.js'], relevantFiles: ['a.js'], noiseFiles: ['n.md'] }, readFiles: ['a.js'] },
      { taskId: 't1', arm: 'D', aciProfile: 'aci_25', rep: 0, passed: true, tokenUsage: { totalTokens: 6000, inputTokens: 5000, outputTokens: 1000, cacheReadTokens: 2500 }, sseCacheReported: true, groundTruth: { criticalFiles: ['a.js'], relevantFiles: ['a.js'], noiseFiles: ['n.md'] }, readFiles: ['a.js'], supervisorCost: { calls: 1, totalTokens: 200 }, aciMetrics: { restoredCount: 1, hashVerifiedRestores: 1 } },
      { taskId: 't2', arm: 'A', rep: 0, passed: true, tokenUsage: { totalTokens: 10000, inputTokens: 8000, outputTokens: 2000, cacheReadTokens: 0 }, groundTruth: { criticalFiles: ['b.js'], relevantFiles: ['b.js'], noiseFiles: ['n.md'] }, readFiles: ['b.js'] },
      { taskId: 't2', arm: 'D', aciProfile: 'aci_25', rep: 0, passed: false, tokenUsage: { totalTokens: 1000, inputTokens: 800, outputTokens: 200, cacheReadTokens: 0 }, groundTruth: { criticalFiles: ['b.js'], relevantFiles: ['b.js'], noiseFiles: ['n.md'] }, readFiles: [] },
      { taskId: 't3', arm: 'A', rep: 0, passed: false, tokenUsage: { totalTokens: 50000, inputTokens: 45000, outputTokens: 5000, cacheReadTokens: 0 }, groundTruth: { criticalFiles: ['c.js'], relevantFiles: ['c.js'], noiseFiles: ['n.md'] }, readFiles: [] },
      { taskId: 't3', arm: 'D', aciProfile: 'aci_25', rep: 0, passed: true, tokenUsage: { totalTokens: 4000, inputTokens: 3200, outputTokens: 800, cacheReadTokens: 1600 }, sseCacheReported: true, groundTruth: { criticalFiles: ['c.js'], relevantFiles: ['c.js'], noiseFiles: ['n.md'] }, readFiles: ['c.js'] },
    ];

    const metrics = computeAciGovernanceMetrics(trials, { baselineArm: 'A' });
    const d = metrics.byArm.D;
    assert.equal(d.passedTrials, 2);
    assert.equal(d.totalTrials, 3);
    assert.equal(d.tokensPerCompletedPass, 5500);
    assert.equal(d.meanTokensOnPassedTrials, 5000);
    assert.equal(d.pairedPassCount, 1);
    assert.equal(d.pairedPassTokenReduction, 0.4);
    assert.ok(d.passRateCI.upper > d.passRateCI.lower);

    const summary = {
      benchmarkId: 'aci-governance-benchmark',
      version: '2.5.0',
      mode: 'deterministic',
      suite: 'aci25',
      sandboxBackend: activeSandbox.resolveBackend().mode,
      arms: ['A', 'D'],
      armProfiles: { A: { arm: 'A', aciProfile: 'raw_full' }, D: { arm: 'D', aciProfile: 'aci_25' } },
      metrics,
    };

    const md = exportPaperTablesMarkdown(summary);
    assert.ok(md.includes('| Arm | Profile | Pass (n/N) | Pass Rate (Wilson 95% CI) |'));
    assert.ok(md.includes('5,500'));
    assert.ok(md.includes('40.0%'));
    assert.ok(md.includes('`aci_25`'));

    const tex = exportPaperTablesLatex(summary);
    assert.ok(tex.includes('\\begin{table}'));
    assert.ok(tex.includes('\\toprule'));
    assert.ok(tex.includes('aci\\_25'));
    assert.ok(tex.includes('40.0\\%'));
  });

  test('CLI flags validate --resume, --concurrency 1..16, --suite aci25, and paper exports', () => {
    const parsed = parseAciCliArgs([
      '--mode', 'deterministic',
      '--suite', 'aci25',
      '--arms', 'A,C,D',
      '--repeats', '2',
      '--concurrency', '12',
      '--resume',
      '--aci-profile', 'aci_25',
      '--export-paper', 'out/tables.md',
      '--export-latex', 'out/tables.tex',
    ]);
    assert.equal(parsed.suite, 'aci25');
    assert.deepEqual(parsed.arms, ['A', 'C', 'D']);
    assert.equal(parsed.concurrency, 12);
    assert.equal(parsed.resume, true);
    assert.equal(parsed.aciProfile, 'aci_25');
    assert.equal(parsed.exportPaper, 'out/tables.md');
    assert.equal(parsed.exportLatex, 'out/tables.tex');

    assert.throws(() => parseAciCliArgs(['--concurrency', '0']), /between 1 and 16/);
    assert.throws(() => parseAciCliArgs(['--concurrency', '17']), /between 1 and 16/);
    assert.throws(() => parseAciCliArgs(['--aci-profile', 'bad']), /full_aci or aci_25/);
  });

  test('--resume preserves existing JSONL rows, skips completed cells safely, exports paper tables, and summarizes existing + new', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'eval25-resume-'));
    cleanupDirs.push(outDir);
    const outJsonl = join(outDir, 'run.jsonl');
    const paperMd = join(outDir, 'paper.md');
    const paperTex = join(outDir, 'paper.tex');

    const preA = {
      taskId: 'aci-01-auth-tenant-boundary',
      suite: 'aci',
      arm: 'A',
      aciProfile: 'raw_full',
      rep: 0,
      passed: false,
      status: 'failed',
      durationMs: 12345,
      groundTruth: { criticalFiles: ['src/tenant-context.js'], relevantFiles: ['src/tenant-context.js'], noiseFiles: [] },
      tokenUsage: { inputTokens: 8000, outputTokens: 500, totalTokens: 8500, cacheReadTokens: 0 },
      readFiles: [],
    };
    const preC = {
      taskId: 'aci-01-auth-tenant-boundary',
      suite: 'aci',
      arm: 'C',
      aciProfile: 'retrieval_supervisor',
      rep: 0,
      passed: true,
      status: 'passed',
      durationMs: 23456,
      groundTruth: { criticalFiles: ['src/tenant-context.js'], relevantFiles: ['src/tenant-context.js'], noiseFiles: [] },
      tokenUsage: { inputTokens: 4500, outputTokens: 400, totalTokens: 4900, cacheReadTokens: 1500 },
      sseCacheReported: true,
      readFiles: ['src/tenant-context.js'],
    };
    writeFileSync(
      outJsonl,
      `${JSON.stringify(preA)}\n${JSON.stringify(preC)}\n{"truncated":"corrupt_line_should_be_ignored"`,
      'utf8',
    );

    const state = loadResumeStateFromJsonl(outJsonl);
    assert.equal(state.existingRows.length, 2);
    assert.equal(state.hadCorruptLines, true);
    assert.equal(state.completedKeys.has(buildTrialCellKey('aci-01-auth-tenant-boundary', 'A', 0)), true);
    assert.equal(state.completedKeys.has(buildTrialCellKey('aci-01-auth-tenant-boundary', 'C', 0)), true);

    const summary = await runAciGovernanceBenchmark({
      mode: 'deterministic',
      arms: ['A', 'C', 'D'],
      suite: 'aci',
      tasks: ['aci-01'],
      repeats: 1,
      concurrency: 2,
      resume: true,
      lane: 0,
      lanes: 1,
      output: outJsonl,
      exportPaper: paperMd,
      exportLatex: paperTex,
      aciProfile: 'aci_25',
      dtocPolicy: null,
      maxSteps: null,
      maxTokens: null,
      dtocMinPromptTokens: 24000,
      sandbox: activeSandbox.mode,
    });

    assert.equal(summary.resumed, true);
    assert.equal(summary.resumedExistingCount, 2);
    assert.equal(summary.executedCount, 1);
    assert.equal(summary.armProfiles.D.aciProfile, 'aci_25');
    assert.equal(summary.metrics.byArm.A.totalTrials, 1);
    assert.equal(summary.metrics.byArm.C.totalTrials, 1);
    assert.equal(summary.metrics.byArm.D.totalTrials, 1);

    const validRows = readFileSync(outJsonl, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const obj = JSON.parse(line);
          return obj?.taskId && obj?.arm ? [obj] : [];
        } catch {
          return [];
        }
      });
    assert.equal(validRows.length, 3);
    assert.equal(validRows[0].durationMs, 12345);
    assert.equal(validRows[1].durationMs, 23456);
    assert.equal(validRows[2].arm, 'D');

    const mdOut = readFileSync(paperMd, 'utf8');
    const texOut = readFileSync(paperTex, 'utf8');
    assert.ok(mdOut.includes('| D | `aci_25` |'));
    assert.ok(texOut.includes('\\begin{tabular}'));
    assert.ok(JSON.parse(readFileSync(buildSummaryOutputPath(outJsonl), 'utf8')).executedCount === 1);
  });

  test('deterministic parallel --concurrency 4 --suite aci25 executes aci-05 and aci-06 cleanly', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'eval25-det4-'));
    cleanupDirs.push(outDir);
    const outJsonl = join(outDir, 'det4.jsonl');

    const summary = await runAciGovernanceBenchmark({
      mode: 'deterministic',
      arms: ['A', 'D'],
      suite: 'aci25',
      tasks: ['aci-05', 'aci-06'],
      repeats: 1,
      concurrency: 4,
      resume: false,
      lane: 0,
      lanes: 1,
      output: outJsonl,
      exportPaper: null,
      exportLatex: null,
      aciProfile: 'aci_25',
      dtocPolicy: null,
      maxSteps: null,
      maxTokens: null,
      dtocMinPromptTokens: 24000,
      sandbox: activeSandbox.mode,
    });

    assert.equal(summary.concurrency, 4);
    assert.equal(summary.executedCount, 4);
    assert.equal(summary.metrics.byArm.A.totalTrials, 2);
    assert.equal(summary.metrics.byArm.D.totalTrials, 2);
    assert.ok(summary.metrics.byArm.D.criticalContextRecall >= summary.metrics.byArm.A.criticalContextRecall);
  });

  test('real-mode --concurrency 4 isolates globalThis.fetch wire-capture per trial without leaking tracking headers or corrupting token counts', async () => {
    const origFetch = globalThis.fetch;
    const seenHeaderLeaks = [];
    const server = http.createServer((req, res) => {
      if (req.headers['x-agent-us-bench-trial']) {
        seenHeaderLeaks.push(req.headers['x-agent-us-bench-trial']);
      }
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
        const promptJoined = JSON.stringify(parsed.messages ?? []);
        const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
        const promptTok = !hasTools
          ? 37
          : promptJoined.includes('aci-02-persistence-wal-ledger') || promptJoined.includes('wal-ledger')
            ? 222
            : 111;
        const compTok = !hasTools ? 9 : promptTok === 222 ? 22 : 11;
        const cachedTok = promptTok === 222 ? 80 : 40;

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const payloadChunk = hasTools
          ? {
              id: 'chatcmpl-mock',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant', content: 'Completed mock trial.' }, finish_reason: null }],
            }
          : {
              id: 'chatcmpl-sup',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: '{"action":"keep","reason":"ok"}' },
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
            prompt_tokens_details: { cached_tokens: cachedTok },
          },
        };

        setTimeout(() => {
          res.write(`data: ${JSON.stringify(payloadChunk)}\n\n`);
          res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }, promptTok === 222 ? 15 : 40);
      });
    });

    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const endpointUrl = `http://127.0.0.1:${addr.port}/v1`;

    const prevKey = process.env.TI_BENCH_KEY;
    const prevEndpoint = process.env.TI_BENCH_ENDPOINT;
    const prevModel = process.env.TI_BENCH_MODEL;
    const outDir = mkdtempSync(join(tmpdir(), 'eval25-real4-'));
    cleanupDirs.push(outDir);
    const outJsonl = join(outDir, 'real4.jsonl');

    try {
      process.env.TI_BENCH_KEY = 'sk-test-eval25-synthetic';
      process.env.TI_BENCH_ENDPOINT = endpointUrl;
      process.env.TI_BENCH_MODEL = 'mock-eval-model';

      const summary = await runAciGovernanceBenchmark({
        mode: 'real',
        arms: ['A', 'C'],
        suite: 'aci',
        tasks: ['aci-01', 'aci-02'],
        repeats: 1,
        concurrency: 4,
        resume: false,
        lane: 0,
        lanes: 1,
        output: outJsonl,
        exportPaper: null,
        exportLatex: null,
        aciProfile: null,
        dtocPolicy: null,
        maxSteps: 1,
        maxTokens: null,
        dtocMinPromptTokens: 24000,
        sandbox: activeSandbox.mode,
      });

      assert.equal(summary.concurrency, 4);
      assert.equal(summary.executedCount, 4);
      assert.deepEqual(seenHeaderLeaks, []);
      assert.equal(globalThis.fetch, origFetch);

      const rows = readFileSync(outJsonl, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(rows.length, 4);

      const aci01Rows = rows.filter((r) => r.taskId.startsWith('aci-01'));
      const aci02Rows = rows.filter((r) => r.taskId.startsWith('aci-02'));
      assert.equal(aci01Rows.length, 2);
      assert.equal(aci02Rows.length, 2);

      for (const r of aci01Rows) {
        assert.ok(r.tokenUsage.inputTokens >= 111 && r.tokenUsage.inputTokens < 222, `${r.arm} leaked tokens: ${r.tokenUsage.inputTokens}`);
      }
      for (const r of aci02Rows) {
        assert.ok(r.tokenUsage.inputTokens >= 222, `${r.arm} missing aci-02 tokens: ${r.tokenUsage.inputTokens}`);
      }
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

  test('probeAciRuntimeCapabilities reports structured capabilities', async () => {
    const caps = await probeAciRuntimeCapabilities();
    assert.equal(typeof caps.capabilities.restoreVerified, 'boolean');
    assert.equal(typeof caps.capabilities.phaseWatermarkV25, 'boolean');
  });
});
