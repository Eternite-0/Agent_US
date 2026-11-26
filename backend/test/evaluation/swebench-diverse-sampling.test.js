import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIVERSE_SUBSET_TARGETS,
  SWEBENCH_HF_FULL_DATASET_ID,
  SWEBENCH_SUBSET_PRESETS,
  SWEBENCH_VERIFIED_REPOS,
  allocateBalancedRepoQuotas,
  computeSweBenchComplexityScore,
  getRecommendedDatasetForSubset,
  selectSweBenchSubset,
} from '../../src/evaluation/swebench-dataset-eval.js';
import {
  parseSweBenchCliArgs,
  runSweBenchBenchmark,
  sliceInstancesForShard,
} from '../../scripts/benchmark-swebench.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = resolve(TEST_DIR, '..', '..');
const SCRIPT_PATH = resolve(BACKEND_DIR, 'scripts', 'benchmark-swebench.mjs');

/**
 * Exact repo count distribution of princeton-nlp/SWE-bench_Verified (500 tasks across 12 repos).
 */
const VERIFIED_500_REPO_COUNTS = Object.freeze({
  'astropy/astropy': 22,
  'django/django': 231,
  'matplotlib/matplotlib': 34,
  'mwaskom/seaborn': 2,
  'pallets/flask': 1,
  'psf/requests': 8,
  'pydata/xarray': 22,
  'pylint-dev/pylint': 10,
  'pytest-dev/pytest': 19,
  'scikit-learn/scikit-learn': 32,
  'sphinx-doc/sphinx': 44,
  'sympy/sympy': 75,
});

function buildSyntheticVerifiedDataset(repoCounts = VERIFIED_500_REPO_COUNTS) {
  const instances = [];
  const entries = Object.entries(repoCounts);
  for (let rIdx = 0; rIdx < entries.length; rIdx++) {
    const [repo, count] = entries[rIdx];
    const slug = repo.replace('/', '__');
    for (let i = 0; i < count; i++) {
      // Spread complexity scores smoothly across each repository
      const stmtLen = 80 + i * 95 + rIdx * 13;
      const f2pCount = 1 + (i % 4);
      const p2pCount = i * 2 + (rIdx % 3);
      instances.push({
        instance_id: `${slug}-${String(1000 + i).padStart(4, '0')}`,
        repo,
        base_commit: `commit-${rIdx}-${i}`,
        problem_statement: 'p'.repeat(stmtLen),
        FAIL_TO_PASS: Array.from({ length: f2pCount }, (_, k) => `tests/test_f.py::test_f_${k}`),
        PASS_TO_PASS: Array.from({ length: p2pCount }, (_, k) => `tests/test_p.py::test_p_${k}`),
      });
    }
  }
  return instances;
}

function getRepoComplexityStrataIndex(repoPoolSorted, instanceId) {
  const n = repoPoolSorted.length;
  const idx = repoPoolSorted.findIndex((inst) => inst.instance_id === instanceId);
  assert.notEqual(idx, -1, `Instance ${instanceId} not found in repo pool`);
  if (n <= 1) return 'low';
  if (n === 2) return idx === 0 ? 'low' : 'high';
  const cut1 = Math.round(n / 3);
  const cut2 = Math.round((2 * n) / 3);
  if (idx < cut1) return 'low';
  if (idx < cut2) return 'med';
  return 'high';
}

describe('SWE-bench Verified Balanced 12-Repo Stratified Sampling (Module 3.1)', () => {
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

  test('exports all 12 canonical Verified repos, subset preset constants, and dataset recommendations', () => {
    assert.equal(SWEBENCH_VERIFIED_REPOS.length, 12);
    assert.deepEqual([...SWEBENCH_VERIFIED_REPOS], Object.keys(VERIFIED_500_REPO_COUNTS).sort());
    assert.deepEqual(
      [...SWEBENCH_SUBSET_PRESETS],
      ['smoke-5', 'paper-50', 'diverse-12', 'diverse-36', 'diverse-60'],
    );
    assert.deepEqual(DIVERSE_SUBSET_TARGETS, {
      'diverse-12': 12,
      'diverse-36': 36,
      'diverse-60': 60,
    });
    assert.equal(getRecommendedDatasetForSubset('diverse-12'), 'hf:verified-full');
    assert.equal(getRecommendedDatasetForSubset('diverse-36'), 'hf:verified-full');
    assert.equal(getRecommendedDatasetForSubset('diverse-60'), 'hf:verified-full');
    assert.equal(getRecommendedDatasetForSubset('smoke-5'), 'hf:verified-mini');
    assert.equal(getRecommendedDatasetForSubset('paper-50'), 'hf:verified-mini');
    assert.equal(getRecommendedDatasetForSubset('unknown'), null);
  });

  test('diverse-12 deterministically selects exactly 1 representative task from every one of all 12 repos', () => {
    const outDir = makeTmp('swe-diverse12-');
    const dataset = buildSyntheticVerifiedDataset();
    assert.equal(dataset.length, 500);

    const runA = selectSweBenchSubset(dataset, { preset: 'diverse-12', seed: 42, outputDir: outDir });
    const runB = selectSweBenchSubset([...dataset].reverse(), { preset: 'diverse-12', seed: 42 });
    const runOtherSeed = selectSweBenchSubset(dataset, { preset: 'diverse-12', seed: 99 });

    // Exact size & uniqueness
    assert.equal(runA.instances.length, 12);
    assert.equal(new Set(runA.instanceIds).size, 12);

    // Deterministic reproducibility & input-order invariance
    assert.deepEqual(runA.instanceIds, runB.instanceIds);
    assert.notDeepEqual(runA.instanceIds, runOtherSeed.instanceIds);

    // Every single one of all 12 repos has exact quota = 1 (non-Django dominance)
    assert.equal(Object.keys(runA.repoDistribution).length, 12);
    for (const repo of SWEBENCH_VERIFIED_REPOS) {
      assert.equal(runA.repoDistribution[repo], 1, `diverse-12 must select exactly 1 task from ${repo}`);
    }
    assert.equal(runA.repoDistribution['django/django'], 1);

    // Every repo with >= 3 tasks selects from its median complexity stratum
    for (const inst of runA.instances) {
      const repoPool = dataset
        .filter((r) => r.repo === inst.repo)
        .sort(
          (a, b) =>
            computeSweBenchComplexityScore(a) - computeSweBenchComplexityScore(b) ||
            a.instance_id.localeCompare(b.instance_id),
        );
      if (repoPool.length >= 3) {
        assert.equal(
          getRepoComplexityStrataIndex(repoPool, inst.instance_id),
          'med',
          `diverse-12 pick for ${inst.repo} should come from median complexity stratum`,
        );
      }
    }

    // Manifest written cleanly
    assert.ok(runA.manifestPath && existsSync(runA.manifestPath));
    const manifest = JSON.parse(readFileSync(runA.manifestPath, 'utf8'));
    assert.equal(manifest.preset, 'diverse-12');
    assert.equal(manifest.count, 12);
    assert.deepEqual(manifest.instanceIds, runA.instanceIds);
  });

  test('diverse-36 enforces balanced cross-repo quotas, prevents Django dominance, and stratifies complexity', () => {
    const outDir = makeTmp('swe-diverse36-');
    const dataset = buildSyntheticVerifiedDataset();

    const d36A = selectSweBenchSubset(dataset, { preset: 'diverse-36', seed: 42, outputDir: outDir });
    const d36B = selectSweBenchSubset([...dataset].reverse(), { preset: 'diverse-36', seed: 42 });
    const d36Seed7 = selectSweBenchSubset(dataset, { preset: 'diverse-36', seed: 7 });
    const paper50 = selectSweBenchSubset(dataset, { preset: 'paper-50', seed: 42 });

    // Exact size, uniqueness, and determinism
    assert.equal(d36A.instances.length, 36);
    assert.equal(new Set(d36A.instanceIds).size, 36);
    assert.deepEqual(d36A.instanceIds, d36B.instanceIds);
    assert.notDeepEqual(d36A.instanceIds, d36Seed7.instanceIds);

    // All 12 repos covered
    assert.equal(Object.keys(d36A.repoDistribution).length, 12);
    for (const repo of SWEBENCH_VERIFIED_REPOS) {
      assert.ok(d36A.repoDistribution[repo] >= 1, `Repo ${repo} must be covered in diverse-36`);
    }

    // Small repos get full/fair coverage instead of being drowned out
    assert.equal(d36A.repoDistribution['pallets/flask'], 1, 'flask (1 available) capped at 1');
    assert.equal(d36A.repoDistribution['mwaskom/seaborn'], 2, 'seaborn (2 available) capped at 2');
    assert.equal(d36A.repoDistribution['psf/requests'], 3, 'requests gets fair balanced share');
    assert.equal(d36A.repoDistribution['pylint-dev/pylint'], 3, 'pylint gets fair balanced share');

    // Non-Django dominance: Django share in diverse-36 (4/36 = 11.1%) vs proportional paper-50 (~46%)
    const djangoCount = d36A.repoDistribution['django/django'];
    assert.equal(djangoCount, 4);
    assert.ok(djangoCount / 36 <= 0.15, `Django share ${djangoCount}/36 must remain balanced (<=15%)`);
    assert.ok(
      paper50.repoDistribution['django/django'] / 50 > 0.4,
      'Sanity check: proportional paper-50 is Django-heavy on 500-task Verified',
    );

    // Uncapped repos remain tightly balanced (max - min <= 1)
    const uncappedCounts = SWEBENCH_VERIFIED_REPOS
      .filter((r) => VERIFIED_500_REPO_COUNTS[r] > 3)
      .map((r) => d36A.repoDistribution[r]);
    assert.ok(Math.max(...uncappedCounts) - Math.min(...uncappedCounts) <= 1);

    // Complexity stratification: every repo with quota >= 3 covers low, med, and high strata
    for (const repo of SWEBENCH_VERIFIED_REPOS) {
      const picks = d36A.instances.filter((i) => i.repo === repo);
      if (picks.length < 3) continue;
      const repoPool = dataset
        .filter((r) => r.repo === repo)
        .sort(
          (a, b) =>
            computeSweBenchComplexityScore(a) - computeSweBenchComplexityScore(b) ||
            a.instance_id.localeCompare(b.instance_id),
        );
      const strata = new Set(picks.map((p) => getRepoComplexityStrataIndex(repoPool, p.instance_id)));
      assert.deepEqual(
        [...strata].sort(),
        ['high', 'low', 'med'],
        `Repo ${repo} in diverse-36 must cover all 3 complexity strata`,
      );
    }

    // Contiguous repo grouping pairs with interleaved modulo sharding so each 1/3..3/3 shard spans >= 10 repos
    for (let s = 1; s <= 3; s++) {
      const shard = sliceInstancesForShard(d36A.instances, { index: s, total: 3 });
      assert.equal(shard.length, 12);
      const distinctRepos = new Set(shard.map((i) => i.repo));
      assert.ok(distinctRepos.size >= 10, `Shard ${s}/3 should span >=10 distinct repos, got ${distinctRepos.size}`);
    }
  });

  test('diverse-60 caps small repos gracefully, redistributes surplus deterministically, and stratifies complexity', () => {
    const dataset = buildSyntheticVerifiedDataset();

    const d60A = selectSweBenchSubset(dataset, { preset: 'diverse-60', seed: 42 });
    const d60B = selectSweBenchSubset([...dataset].reverse(), { preset: 'diverse-60', seed: 42 });
    const d60Seed123 = selectSweBenchSubset(dataset, { preset: 'diverse-60', seed: 123 });

    // Exact size, uniqueness, determinism
    assert.equal(d60A.instances.length, 60);
    assert.equal(new Set(d60A.instanceIds).size, 60);
    assert.deepEqual(d60A.instanceIds, d60B.instanceIds);
    assert.notDeepEqual(d60A.instanceIds, d60Seed123.instanceIds);

    // All 12 repos covered; flask (1) and seaborn (2) capped at repo size
    assert.equal(Object.keys(d60A.repoDistribution).length, 12);
    assert.equal(d60A.repoDistribution['pallets/flask'], 1);
    assert.equal(d60A.repoDistribution['mwaskom/seaborn'], 2);

    // Remaining 57 tasks redistributed evenly across the 10 uncapped repos (5 or 6 each)
    const uncappedCounts = SWEBENCH_VERIFIED_REPOS
      .filter((r) => VERIFIED_500_REPO_COUNTS[r] >= 5)
      .map((r) => d60A.repoDistribution[r]);
    assert.equal(Math.min(...uncappedCounts), 5);
    assert.equal(Math.max(...uncappedCounts), 6);
    assert.equal(d60A.repoDistribution['django/django'], 6, 'Django capped at 6/60 (10%)');

    // Every repo with >= 3 picks covers all 3 complexity strata
    for (const repo of SWEBENCH_VERIFIED_REPOS) {
      const picks = d60A.instances.filter((i) => i.repo === repo);
      if (picks.length < 3) continue;
      const repoPool = dataset
        .filter((r) => r.repo === repo)
        .sort(
          (a, b) =>
            computeSweBenchComplexityScore(a) - computeSweBenchComplexityScore(b) ||
            a.instance_id.localeCompare(b.instance_id),
        );
      const strata = new Set(picks.map((p) => getRepoComplexityStrataIndex(repoPool, p.instance_id)));
      assert.deepEqual(
        [...strata].sort(),
        ['high', 'low', 'med'],
        `Repo ${repo} in diverse-60 must cover all 3 complexity strata`,
      );
    }

    // Extreme small-repo skew test: 4 repos with < 5 tasks (1, 2, 3, 4) -> surplus redistributed cleanly to reach 60
    const skewedCounts = {
      'astropy/astropy': 20,
      'django/django': 220,
      'matplotlib/matplotlib': 30,
      'mwaskom/seaborn': 2,
      'pallets/flask': 1,
      'psf/requests': 3,
      'pydata/xarray': 25,
      'pylint-dev/pylint': 4,
      'pytest-dev/pytest': 18,
      'scikit-learn/scikit-learn': 30,
      'sphinx-doc/sphinx': 42,
      'sympy/sympy': 65,
    };
    const skewedDataset = buildSyntheticVerifiedDataset(skewedCounts);
    const skewed60 = selectSweBenchSubset(skewedDataset, { preset: 'diverse-60', seed: 42 });
    assert.equal(skewed60.instances.length, 60);
    assert.equal(Object.keys(skewed60.repoDistribution).length, 12);
    assert.equal(skewed60.repoDistribution['pallets/flask'], 1);
    assert.equal(skewed60.repoDistribution['mwaskom/seaborn'], 2);
    assert.equal(skewed60.repoDistribution['psf/requests'], 3);
    assert.equal(skewed60.repoDistribution['pylint-dev/pylint'], 4);
    const remainingEight = Object.entries(skewedCounts)
      .filter(([, count]) => count >= 5)
      .map(([repo]) => skewed60.repoDistribution[repo]);
    assert.equal(remainingEight.reduce((a, b) => a + b, 0), 50);
    assert.ok(Math.max(...remainingEight) - Math.min(...remainingEight) <= 1);
    assert.ok(skewed60.repoDistribution['django/django'] <= 7);

    // Direct water-filling edge case: totalQuota >= available returns exact repo counts
    const smallQuotas = allocateBalancedRepoQuotas(
      [
        { key: 'a', count: 2 },
        { key: 'b', count: 3 },
      ],
      10,
    );
    assert.equal(smallQuotas.get('a'), 2);
    assert.equal(smallQuotas.get('b'), 3);
  });

  test('benchmark-swebench.mjs CLI parses diverse-12/36/60, preserves existing presets, and fetches verified-full for diverse presets', async () => {
    for (const preset of ['smoke-5', 'paper-50', 'diverse-12', 'diverse-36', 'diverse-60']) {
      const parsed = parseSweBenchCliArgs(['--dataset', 'hf:verified-full', '--subset', preset]);
      assert.equal(parsed.subset, preset);
    }
    assert.throws(
      () => parseSweBenchCliArgs(['--dataset', 'hf:verified-full', '--subset', 'diverse-99']),
      /Invalid --subset/,
    );

    const helpProc = spawnSync(process.execPath, [SCRIPT_PATH, '--help'], {
      cwd: BACKEND_DIR,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(helpProc.status, 0, helpProc.stderr);
    assert.match(helpProc.stdout, /diverse-12/);
    assert.match(helpProc.stdout, /diverse-36/);
    assert.match(helpProc.stdout, /diverse-60/);
    assert.match(helpProc.stdout, /hf:verified-full/);

    // Standalone --fetch-dataset --subset diverse-36 targets princeton-nlp/SWE-bench_Verified
    const fetchDir = makeTmp('swe-diverse-fetch-');
    const fetchedCalls = [];
    const fetchOutPath = join(fetchDir, 'verified_full.jsonl');
    const fetchRes = await runSweBenchBenchmark(
      {
        fetchDataset: true,
        fetchDatasetPath: fetchOutPath,
        subset: 'diverse-36',
      },
      {
        fetchSweBenchVerifiedDataset: async ({ outputPath, datasetId }) => {
          fetchedCalls.push({ outputPath, datasetId });
          writeFileSync(outputPath, '', 'utf8');
          return { outputPath, count: 500, instances: [] };
        },
      },
    );
    assert.equal(fetchRes.action, 'fetch-dataset');
    assert.equal(fetchedCalls.length, 1);
    assert.equal(fetchedCalls[0].datasetId, SWEBENCH_HF_FULL_DATASET_ID);
  });
});
