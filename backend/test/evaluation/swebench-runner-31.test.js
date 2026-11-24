import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PrefixBlockCacheSimulatorAdapter,
  computeArmAggregateMetrics,
  createDryRunRepository,
  extractInstanceGitDiff,
  loadCompletedInstanceIds,
  loadSweBenchDataset,
  parseSweBenchCliArgs,
  renderSummaryMarkdown,
  runSweBenchBenchmark,
} from '../../scripts/benchmark-swebench.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = resolve(TEST_DIR, '..', '..');
const SCRIPT_PATH = resolve(BACKEND_DIR, 'scripts', 'benchmark-swebench.mjs');

function runGit(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('SWE-bench Verified Runner (WP7)', () => {
  const tempDirs = [];
  const makeTmp = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parseSweBenchCliArgs parses defaults, all options, max-steps cap, and rejects invalid args', () => {
    const dryOpts = parseSweBenchCliArgs(['--dry-run']);
    assert.equal(dryOpts.dryRun, true);
    assert.deepEqual(dryOpts.arms, ['raw_full', 'full_aci']);
    assert.equal(dryOpts.maxSteps, 60);
    assert.equal(dryOpts.concurrency, 1);
    assert.equal(dryOpts.resume, false);

    const fullOpts = parseSweBenchCliArgs([
      '--dataset',
      './data/swe.jsonl',
      '--arms=raw_full,full_aci,aci_26',
      '--model',
      'deepseek-reasoner',
      '--max-steps',
      '120',
      '--output-dir=./out',
      '--workspace-root',
      './repos',
      '--docker-image=swebench/sweb.eval.x86_64.{instance_id}:latest',
      '--instance-ids',
      'django__django-1,sympy__sympy-2',
      '--limit=5',
      '--concurrency',
      '4',
      '--resume',
      '--json',
    ]);
    assert.equal(fullOpts.dataset, './data/swe.jsonl');
    assert.deepEqual(fullOpts.arms, ['raw_full', 'full_aci', 'aci_26']);
    assert.equal(fullOpts.model, 'deepseek-reasoner');
    assert.equal(fullOpts.maxSteps, 80, 'max-steps must cap at 80');
    assert.equal(fullOpts.outputDir, './out');
    assert.equal(fullOpts.workspaceRoot, './repos');
    assert.equal(fullOpts.dockerImage, 'swebench/sweb.eval.x86_64.{instance_id}:latest');
    assert.deepEqual(fullOpts.instanceIds, ['django__django-1', 'sympy__sympy-2']);
    assert.equal(fullOpts.limit, 5);
    assert.equal(fullOpts.concurrency, 4);
    assert.equal(fullOpts.resume, true);
    assert.equal(fullOpts.json, true);

    assert.throws(() => parseSweBenchCliArgs([]), /Provide --dataset <path> or --dry-run/);
    assert.throws(() => parseSweBenchCliArgs(['--dry-run', '--arms', 'invalid_arm']), /Invalid --arms/);
    assert.throws(() => parseSweBenchCliArgs(['--dry-run', '--max-steps', '0']), /positive integer/);
    assert.throws(() => parseSweBenchCliArgs(['--dry-run', '--unknown-flag']), /Unknown CLI flag/);
  });

  test('loadSweBenchDataset loads .jsonl and .json datasets with filtering and validation', () => {
    const dir = makeTmp('swe-dataset-');
    const jsonlPath = join(dir, 'verified.jsonl');
    const jsonArrayPath = join(dir, 'verified.json');
    const jsonWrappedPath = join(dir, 'wrapped.json');

    const rows = [
      {
        instance_id: 'acme__calc-1',
        repo: 'acme/calc',
        base_commit: 'abc1234',
        problem_statement: 'Fix rounding error',
        hints_text: 'Check round()',
        workspace_path: '/tmp/ws1',
        test_cmd: 'pytest -q',
      },
      {
        instance_id: 'acme__calc-2',
        repo: 'acme/calc',
        base_commit: 'def5678',
        problem_statement: 'Fix tax threshold',
        hints_text: '',
      },
      {
        instance_id: 'acme__calc-3',
        repo: 'acme/calc',
        base_commit: '999aaaa',
        problem_statement: 'Fix currency format',
      },
    ];

    writeFileSync(
      jsonlPath,
      `${JSON.stringify(rows[0])}\r\n\r\n${JSON.stringify(rows[1])}\n${JSON.stringify(rows[2])}\n`,
      'utf8',
    );
    writeFileSync(jsonArrayPath, JSON.stringify(rows, null, 2), 'utf8');
    writeFileSync(jsonWrappedPath, JSON.stringify({ instances: rows }), 'utf8');

    const loadedJsonl = loadSweBenchDataset(jsonlPath);
    assert.equal(loadedJsonl.length, 3);
    assert.equal(loadedJsonl[0].workspace_path, '/tmp/ws1');
    assert.equal(loadedJsonl[0].test_cmd, 'pytest -q');
    assert.equal(loadedJsonl[2].hints_text, '');

    const filteredJson = loadSweBenchDataset(jsonArrayPath, {
      instanceIds: ['acme__calc-2', 'acme__calc-3'],
      limit: 1,
    });
    assert.equal(filteredJson.length, 1);
    assert.equal(filteredJson[0].instance_id, 'acme__calc-2');

    const loadedWrapped = loadSweBenchDataset(jsonWrappedPath);
    assert.equal(loadedWrapped.length, 3);

    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, JSON.stringify([{ repo: 'acme/calc' }]), 'utf8');
    assert.throws(() => loadSweBenchDataset(badPath), /missing instance_id/);
    assert.throws(() => loadSweBenchDataset(join(dir, 'missing.jsonl')), /not found/);
  });

  test('PrefixBlockCacheSimulatorAdapter tracks 64-token prefix blocks and extractInstanceGitDiff ignores python caches', async () => {
    const sim = new PrefixBlockCacheSimulatorAdapter();
    const baseSystem = 'System prompt block: '.repeat(40);
    const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }];

    const s1 = sim.simulatePrefixCache({
      system: baseSystem,
      tools,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect bug in calculator.' }] }],
    });
    assert.equal(s1.cacheReadTokens, 0);
    assert.ok(s1.totalBlocks >= 3);
    assert.equal(s1.cacheEligibleInputTokens, s1.inputTokens);

    const s2 = sim.simulatePrefixCache({
      system: baseSystem,
      tools,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Inspect bug in calculator.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Reading src/discounts/calculator.py next.' }] },
      ],
    });
    assert.equal(s2.matchedBlocks, s1.totalBlocks);
    assert.equal(s2.cacheReadTokens, s1.totalBlocks * 64);
    assert.ok(s2.cacheReadTokens > 0);

    const sMutated = sim.simulatePrefixCache({
      system: `${baseSystem} MUTATED`,
      tools,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Inspect bug in calculator.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Reading src/discounts/calculator.py next.' }] },
      ],
    });
    assert.ok(sMutated.matchedBlocks < s2.matchedBlocks, 'Prefix mutation must invalidate downstream KV blocks');

    // Cache hit rate fallback when cacheEligibleInputTokens is null
    const aggFallback = computeArmAggregateMetrics('raw_full', [
      {
        instance_id: 'inst-1',
        status: 'completed',
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 750,
        cacheEligibleInputTokens: null,
        steps: 4,
        wallClockMs: 500,
        nonEmptyPatch: true,
        admissionOriginalTokens: 0,
        admissionInjectedTokens: 0,
        admissionSavedTokens: 0,
        epochTransitions: 0,
      },
    ]);
    assert.equal(aggFallback.totalCacheEligibleInputTokens, 1000);
    assert.equal(aggFallback.cacheHitRate, 0.75);

    // Git diff extraction ignores __pycache__ and .pytest_cache while including real file changes
    const repoDir = makeTmp('swe-diff-repo-');
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'app.py'), 'def add(a, b):\n    return a - b\n', 'utf8');
    runGit(repoDir, ['init', '-q']);
    runGit(repoDir, ['config', 'user.email', 'test@agent-us.invalid']);
    runGit(repoDir, ['config', 'user.name', 'Test']);
    runGit(repoDir, ['config', 'core.autocrlf', 'false']);
    runGit(repoDir, ['add', '-A']);
    runGit(repoDir, ['commit', '-qm', 'base']);

    writeFileSync(join(repoDir, 'src', 'app.py'), 'def add(a, b):\n    return a + b\n', 'utf8');
    mkdirSync(join(repoDir, 'src', '__pycache__'), { recursive: true });
    writeFileSync(join(repoDir, 'src', '__pycache__', 'app.cpython-313.pyc'), 'binary-cache', 'utf8');
    mkdirSync(join(repoDir, '.pytest_cache', 'v', 'cache'), { recursive: true });
    writeFileSync(join(repoDir, '.pytest_cache', 'v', 'cache', 'nodeids'), '[]', 'utf8');

    const { patch, changedFiles } = await extractInstanceGitDiff(repoDir, 'HEAD');
    assert.deepEqual(changedFiles, ['src/app.py']);
    assert.match(patch, /diff --git a\/src\/app\.py b\/src\/app\.py/);
    assert.match(patch, /-    return a - b/);
    assert.match(patch, /\+    return a \+ b/);
    assert.equal(patch.includes('__pycache__'), false);
    assert.equal(patch.includes('.pytest_cache'), false);
  });

  test('subprocess --dry-run produces valid predictions.*.jsonl, telemetry.*.jsonl, summary.md, and --resume is idempotent', () => {
    const outDir = makeTmp('swe-dry-subproc-');

    const firstRun = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--dry-run', '--output-dir', outDir],
      { cwd: BACKEND_DIR, encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(firstRun.status, 0, `dry-run exited ${firstRun.status}: ${firstRun.stderr}\n${firstRun.stdout}`);

    for (const arm of ['raw_full', 'full_aci']) {
      const predPath = join(outDir, `predictions.${arm}.jsonl`);
      const telePath = join(outDir, `telemetry.${arm}.jsonl`);
      assert.equal(existsSync(predPath), true, `missing ${predPath}`);
      assert.equal(existsSync(telePath), true, `missing ${telePath}`);

      const predLines = readFileSync(predPath, 'utf8').trim().split(/\r?\n/);
      assert.equal(predLines.length, 1);
      const pred = JSON.parse(predLines[0]);
      assert.equal(pred.instance_id, 'dryrun__discounts-calculator-01');
      assert.ok(typeof pred.model_name_or_path === 'string' && pred.model_name_or_path.length > 0);
      assert.match(pred.model_patch, /^diff --git a\/src\/discounts\/calculator\.py b\/src\/discounts\/calculator\.py/m);
      assert.match(pred.model_patch, /^--- a\/src\/discounts\/calculator\.py/m);
      assert.match(pred.model_patch, /^\+\+\+ b\/src\/discounts\/calculator\.py/m);
      assert.match(pred.model_patch, /^@@ .+ @@/m);
      assert.match(pred.model_patch, /\+\s*effective_pct = min\(combined_pct, max_discount_pct\)/);
      assert.equal(pred.model_patch.includes('__pycache__'), false);
      assert.equal(pred.model_patch.includes('.pytest_cache'), false);

      const teleLines = readFileSync(telePath, 'utf8').trim().split(/\r?\n/);
      assert.equal(teleLines.length, 1);
      const tele = JSON.parse(teleLines[0]);
      assert.equal(tele.instance_id, 'dryrun__discounts-calculator-01');
      assert.equal(tele.arm, arm);
      assert.equal(tele.status, 'completed');
      assert.ok(tele.inputTokens > 0);
      assert.ok(tele.outputTokens > 0);
      assert.ok(tele.cacheReadTokens > 0);
      assert.ok(tele.cacheEligibleInputTokens >= tele.cacheReadTokens);
      assert.ok(tele.cacheHitRate > 0.5 && tele.cacheHitRate <= 1);
      assert.ok(tele.steps >= 5);
      assert.ok(tele.wallClockMs > 0);
      assert.equal(tele.nonEmptyPatch, true);
      assert.equal(typeof tele.epochTransitions, 'number');
    }

    const rawTele = JSON.parse(readFileSync(join(outDir, 'telemetry.raw_full.jsonl'), 'utf8').trim());
    const aciTele = JSON.parse(readFileSync(join(outDir, 'telemetry.full_aci.jsonl'), 'utf8').trim());
    assert.ok(
      aciTele.admissionTokenReductionRate > 0,
      `Expected full_aci admissionTokenReductionRate > 0, got ${aciTele.admissionTokenReductionRate}`,
    );
    assert.ok(
      aciTele.inputTokens < rawTele.inputTokens,
      `Expected full_aci inputTokens (${aciTele.inputTokens}) < raw_full (${rawTele.inputTokens})`,
    );

    const summaryPath = join(outDir, 'summary.md');
    assert.equal(existsSync(summaryPath), true);
    const summaryMd = readFileSync(summaryPath, 'utf8');
    assert.match(summaryMd, /SWE-bench Verified Benchmark Summary/);
    assert.match(summaryMd, /Total Input Tokens/);
    assert.match(summaryMd, /Total Output Tokens/);
    assert.match(summaryMd, /Real Provider Cache Hit Rate/);
    assert.match(summaryMd, /Non-Empty Patch Rate/);
    assert.match(summaryMd, /ACI Admission Token Reduction Rate/);
    assert.match(summaryMd, /DTOC Epoch Transitions/);
    assert.match(summaryMd, /`raw_full`/);
    assert.match(summaryMd, /`full_aci`/);

    // Re-running with --resume must be strictly idempotent (zero duplicate rows)
    const resumeRun = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--dry-run', '--output-dir', outDir, '--resume'],
      { cwd: BACKEND_DIR, encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(resumeRun.status, 0, `resume exited ${resumeRun.status}: ${resumeRun.stderr}`);

    for (const arm of ['raw_full', 'full_aci']) {
      const predLinesAfter = readFileSync(join(outDir, `predictions.${arm}.jsonl`), 'utf8').trim().split(/\r?\n/);
      const teleLinesAfter = readFileSync(join(outDir, `telemetry.${arm}.jsonl`), 'utf8').trim().split(/\r?\n/);
      assert.equal(predLinesAfter.length, 1, `predictions.${arm}.jsonl must remain 1 line on --resume`);
      assert.equal(teleLinesAfter.length, 1, `telemetry.${arm}.jsonl must remain 1 line on --resume`);
    }
    const resumedSummaryMd = readFileSync(summaryPath, 'utf8');
    assert.match(resumedSummaryMd, /\*\*Resumed\*\*: true/);
  });

  test('dataset execution with --resume skips already completed instance_id and processes remaining instances', async () => {
    const workParent = makeTmp('swe-resume-ds-');
    const drySeed = createDryRunRepository({ baseDir: join(workParent, 'repo-base') });
    const datasetPath = join(workParent, 'dataset.jsonl');
    const outDir = join(workParent, 'out');
    mkdirSync(outDir, { recursive: true });

    const instances = [
      {
        instance_id: 'acme__discounts-01',
        repo: 'acme/discounts',
        base_commit: drySeed.baseCommit,
        problem_statement: drySeed.instance.problem_statement,
        hints_text: drySeed.instance.hints_text,
        workspace_path: drySeed.repoDir,
        test_cmd: 'pytest -q',
      },
      {
        instance_id: 'acme__discounts-02',
        repo: 'acme/discounts',
        base_commit: drySeed.baseCommit,
        problem_statement: drySeed.instance.problem_statement,
        hints_text: drySeed.instance.hints_text,
        workspace_path: drySeed.repoDir,
        test_cmd: 'pytest -q',
      },
    ];
    writeFileSync(
      datasetPath,
      instances.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );

    // Seed instance 01 as already completed for raw_full
    writeFileSync(
      join(outDir, 'predictions.raw_full.jsonl'),
      JSON.stringify({
        instance_id: 'acme__discounts-01',
        model_name_or_path: 'seeded-model',
        model_patch: 'diff --git a/seeded b/seeded\n',
      }) + '\n',
      'utf8',
    );
    writeFileSync(
      join(outDir, 'telemetry.raw_full.jsonl'),
      JSON.stringify({
        instance_id: 'acme__discounts-01',
        arm: 'raw_full',
        model: 'seeded-model',
        status: 'completed',
        wallClockMs: 123,
        steps: 5,
        inputTokens: 2000,
        outputTokens: 100,
        cacheReadTokens: 1500,
        cacheEligibleInputTokens: 2000,
        cacheHitRate: 0.75,
        nonEmptyPatch: true,
        admissionOriginalTokens: 0,
        admissionInjectedTokens: 0,
        admissionSavedTokens: 0,
        admissionTokenReductionRate: 0,
        epochTransitions: 0,
      }) + '\n',
      'utf8',
    );

    const resumedBefore = loadCompletedInstanceIds(outDir, 'raw_full');
    assert.deepEqual([...resumedBefore.completedIds], ['acme__discounts-01']);

    const executedIds = [];
    const result = await runSweBenchBenchmark(
      {
        dataset: datasetPath,
        arms: ['raw_full'],
        outputDir: outDir,
        resume: true,
        model: 'sim-model',
      },
      {
        createAdapter: ({ instance }) => {
          executedIds.push(instance.instance_id);
          return new PrefixBlockCacheSimulatorAdapter();
        },
      },
    );

    assert.deepEqual(executedIds, ['acme__discounts-02']);
    assert.equal(result.predictionsByArm.raw_full.length, 2);
    assert.equal(result.telemetryByArm.raw_full.length, 2);
    assert.equal(result.metricsByArm.raw_full.totalInstances, 2);
    assert.equal(result.metricsByArm.raw_full.nonEmptyPatchRate, 1);

    const summaryText = renderSummaryMarkdown({
      arms: ['raw_full'],
      metricsByArm: result.metricsByArm,
      telemetryByArm: result.telemetryByArm,
      meta: { dryRun: false, resumed: true, model: 'sim-model', maxSteps: 60 },
    });
    assert.match(summaryText, /acme__discounts-01/);
    assert.match(summaryText, /acme__discounts-02/);
  });
});
