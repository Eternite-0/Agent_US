import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  SMOKE5_PREFERRED_REPOS,
  SWEBENCH_HF_DATASET_ID,
  buildSweBenchEvalCommands,
  computePairedResolutionMetrics,
  computeSweBenchComplexityScore,
  djangoTestNodeToLabel,
  evaluateSweBenchPredictions,
  fetchSweBenchVerifiedDataset,
  getDefaultSweBenchCachePath,
  mergeEvalResultsIntoTelemetry,
  normalizeSweBenchExtendedFields,
  parseEvalTestResults,
  parseTestTargetList,
  renderPaperLatexTable,
  selectSweBenchSubset,
} from '../../src/evaluation/swebench-dataset-eval.js';

describe('SWE-bench Dataset Fetcher, Stratified Sampler & Evaluator (WP4 + WP5)', () => {
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

  test('constants, cache path, parseTestTargetList, and normalizeSweBenchExtendedFields handle all input variants', () => {
    assert.equal(SWEBENCH_HF_DATASET_ID, 'princeton-nlp/SWE-bench_Verified');
    assert.deepEqual(SMOKE5_PREFERRED_REPOS, [
      'psf/requests',
      'pytest-dev/pytest',
      'django/django',
      'sympy/sympy',
      'scikit-learn/scikit-learn',
    ]);

    const defaultCache = getDefaultSweBenchCachePath();
    assert.equal(
      defaultCache.endsWith(join('backend', 'data', 'benchmarks', 'swebench_verified.jsonl')),
      true,
    );
    assert.equal(
      getDefaultSweBenchCachePath('/tmp/custom-root'),
      join(resolve('/tmp/custom-root'), 'backend', 'data', 'benchmarks', 'swebench_verified.jsonl'),
    );

    // JSON array string with duplicates and whitespace
    assert.deepEqual(
      parseTestTargetList('["tests/a.py::test_1", " tests/b.py::test_2 ", "tests/a.py::test_1"]'),
      ['tests/a.py::test_1', 'tests/b.py::test_2'],
    );
    // Parametrized pytest node containing comma inside [...]
    assert.deepEqual(
      parseTestTargetList('["tests/a.py::test_p[1,2]", "tests/a.py::test_q"]'),
      ['tests/a.py::test_p[1,2]', 'tests/a.py::test_q'],
    );
    // Raw JS string array
    assert.deepEqual(parseTestTargetList(['  test_a ', '', 'test_b', 'test_a']), [
      'test_a',
      'test_b',
    ]);
    // Comma / newline fallback preserving parametrized brackets
    assert.deepEqual(
      parseTestTargetList('tests/a.py::test_p[1,2], tests/a.py::test_q\ntests/b.py::test_r\n'),
      ['tests/a.py::test_p[1,2]', 'tests/a.py::test_q', 'tests/b.py::test_r'],
    );
    assert.deepEqual(parseTestTargetList(null), []);
    assert.deepEqual(parseTestTargetList('   '), []);

    const rawPatch = 'diff --git a/tests/test_x.py b/tests/test_x.py\n+    assert True\n';
    const ext = normalizeSweBenchExtendedFields({
      test_patch: rawPatch,
      FAIL_TO_PASS: '["tests/test_x.py::test_fix"]',
      PASS_TO_PASS: ['tests/test_x.py::test_keep', 'tests/test_x.py::test_keep'],
      version: '2.31',
      environment_setup_commit: 'deadbeef1234',
    });
    assert.equal(ext.test_patch, rawPatch, 'test_patch trailing newline must be preserved verbatim');
    assert.deepEqual(ext.FAIL_TO_PASS, ['tests/test_x.py::test_fix']);
    assert.deepEqual(ext.PASS_TO_PASS, ['tests/test_x.py::test_keep']);
    assert.equal(ext.version, '2.31');
    assert.equal(ext.environment_setup_commit, 'deadbeef1234');
  });

  test('fetchSweBenchVerifiedDataset paginates HuggingFace API, strips gold patch by default, and writes JSONL atomically', async () => {
    const dir = makeTmp('swe-hf-');
    const outPath = join(dir, 'nested', 'swebench_verified.jsonl');

    const mockRows = [
      {
        instance_id: 'psf__requests-1',
        repo: 'psf/requests',
        base_commit: 'aaa111',
        problem_statement: 'Handle chunked header edge case',
        hints_text: 'Inspect adapters.py',
        patch: 'SECRET_GOLD_PATCH_1',
        test_patch: 'diff --git a/tests/test_req.py b/tests/test_req.py\n',
        FAIL_TO_PASS: '["tests/test_req.py::test_chunked"]',
        PASS_TO_PASS: '["tests/test_req.py::test_get"]',
        version: '2.30',
        environment_setup_commit: 'eee111',
      },
      {
        instance_id: 'django__django-2',
        repo: 'django/django',
        base_commit: 'bbb222',
        problem_statement: 'Fix QuerySet annotation alias',
        hints_text: '',
        patch: 'SECRET_GOLD_PATCH_2',
        test_patch: 'diff --git a/tests/queries/tests.py b/tests/queries/tests.py\n',
        FAIL_TO_PASS: '["test_alias (queries.tests.AnnotationTests)"]',
        PASS_TO_PASS: '["test_basic (queries.tests.AnnotationTests)"]',
        version: '4.2',
        environment_setup_commit: 'fff222',
      },
      {
        instance_id: 'sympy__sympy-3',
        repo: 'sympy/sympy',
        base_commit: 'ccc333',
        problem_statement: 'Fix simplify crash on Zero',
        hints_text: 'Look at sympy/simplify/simplify.py',
        patch: 'SECRET_GOLD_PATCH_3',
        test_patch: 'diff --git a/sympy/simplify/tests/test_simplify.py b/sympy/simplify/tests/test_simplify.py\n',
        FAIL_TO_PASS: ['sympy/simplify/tests/test_simplify.py::test_zero'],
        PASS_TO_PASS: [],
        version: '1.12',
        environment_setup_commit: 'ggg333',
      },
    ];

    const seenUrls = [];
    const mockFetch = async (url) => {
      seenUrls.push(url);
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://datasets-server.huggingface.co');
      assert.equal(parsed.pathname, '/rows');
      assert.equal(parsed.searchParams.get('dataset'), 'princeton-nlp/SWE-bench_Verified');
      assert.equal(parsed.searchParams.get('config'), 'default');
      assert.equal(parsed.searchParams.get('split'), 'test');

      const offset = Number(parsed.searchParams.get('offset'));
      const length = Number(parsed.searchParams.get('length'));
      const slice = mockRows.slice(offset, offset + length).map((row) => ({ row }));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return { rows: slice, num_rows_total: mockRows.length };
        },
      };
    };

    const result = await fetchSweBenchVerifiedDataset({
      outputPath: outPath,
      fetchImpl: mockFetch,
      pageSize: 2,
    });

    assert.equal(seenUrls.length, 2);
    assert.match(seenUrls[0], /offset=0&length=2/);
    assert.match(seenUrls[1], /offset=2&length=2/);
    assert.equal(result.count, 3);
    assert.equal(result.outputPath, resolve(outPath));
    assert.equal(existsSync(outPath), true);

    const lines = readFileSync(outPath, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    for (const item of lines) {
      assert.equal('patch' in item, false, 'Gold solution patch must NOT be leaked by default');
    }
    assert.deepEqual(lines[0].FAIL_TO_PASS, ['tests/test_req.py::test_chunked']);
    assert.deepEqual(lines[1].FAIL_TO_PASS, ['test_alias (queries.tests.AnnotationTests)']);
    assert.equal(lines[2].version, '1.12');

    // Error handling: HTTP 500 & malformed shape
    await assert.rejects(
      () =>
        fetchSweBenchVerifiedDataset({
          outputPath: outPath,
          fetchImpl: async () => ({ ok: false, status: 503, statusText: 'Unavailable', text: async () => 'busy' }),
        }),
      /HTTP 503/,
    );
    await assert.rejects(
      () =>
        fetchSweBenchVerifiedDataset({
          outputPath: outPath,
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ bad: true }),
          }),
        }),
      /missing rows array/,
    );
  });

  test('selectSweBenchSubset supports smoke-5 repo prioritization/median selection and reproducible paper-50 stratified sampling', () => {
    const outDir = makeTmp('swe-subset-');
    const repos = [
      'psf/requests',
      'pytest-dev/pytest',
      'django/django',
      'sympy/sympy',
      'scikit-learn/scikit-learn',
      'matplotlib/matplotlib',
      'astropy/astropy',
      'pallets/flask',
    ];

    // Build 120 heterogeneous instances across 8 repos
    const instances = [];
    for (let rIdx = 0; rIdx < repos.length; rIdx++) {
      const repo = repos[rIdx];
      const countForRepo = rIdx === 2 ? 36 : rIdx === 3 ? 28 : rIdx === 7 ? 2 : 11;
      for (let i = 0; i < countForRepo; i++) {
        const stmtLen = 40 + i * 75 + rIdx * 11;
        const f2pCount = 1 + (i % 3);
        const p2pCount = i * 2;
        instances.push({
          instance_id: `${repo.replace('/', '__')}-${String(i + 1).padStart(3, '0')}`,
          repo,
          base_commit: `commit-${rIdx}-${i}`,
          problem_statement: 'x'.repeat(stmtLen),
          FAIL_TO_PASS: Array.from({ length: f2pCount }, (_, k) => `test_f_${k}`),
          PASS_TO_PASS: Array.from({ length: p2pCount }, (_, k) => `test_p_${k}`),
        });
      }
    }

    assert.throws(() => selectSweBenchSubset(instances, { preset: 'unknown' }), /Invalid SWE-bench subset preset/);

    // smoke-5: picks 5 instances spanning the 5 preferred repos in order, median complexity per repo
    const smoke5 = selectSweBenchSubset(instances, { preset: 'smoke-5', outputDir: outDir });
    assert.equal(smoke5.instances.length, 5);
    assert.deepEqual(
      smoke5.instances.map((i) => i.repo),
      SMOKE5_PREFERRED_REPOS,
    );
    assert.equal(existsSync(smoke5.manifestPath), true);
    const smokeManifest = JSON.parse(readFileSync(smoke5.manifestPath, 'utf8'));
    assert.equal(smokeManifest.preset, 'smoke-5');
    assert.equal(smokeManifest.count, 5);
    assert.deepEqual(smokeManifest.instanceIds, smoke5.instanceIds);

    // Check median pick for django/django (36 items sorted by complexity -> index 17)
    const djangoSorted = instances
      .filter((i) => i.repo === 'django/django')
      .sort((a, b) => computeSweBenchComplexityScore(a) - computeSweBenchComplexityScore(b));
    assert.equal(smoke5.instances[2].instance_id, djangoSorted[Math.floor((36 - 1) / 2)].instance_id);

    // smoke-5 fallback when < 5 repos exist
    const twoRepoInstances = instances.filter((i) => i.repo === 'psf/requests' || i.repo === 'pallets/flask');
    const smokeTwoRepo = selectSweBenchSubset(twoRepoInstances, { preset: 'smoke-5' });
    assert.equal(smokeTwoRepo.instances.length, 5);
    assert.equal(new Set(smokeTwoRepo.instanceIds).size, 5);

    // paper-50: deterministic under fixed seed even when input array order is reversed/shuffled
    const paperSeed42A = selectSweBenchSubset(instances, {
      preset: 'paper-50',
      seed: 42,
      outputDir: outDir,
    });
    const paperSeed42B = selectSweBenchSubset([...instances].reverse(), {
      preset: 'paper-50',
      seed: 42,
    });
    const paperSeed99 = selectSweBenchSubset(instances, {
      preset: 'paper-50',
      seed: 99,
    });

    assert.equal(paperSeed42A.instances.length, 50);
    assert.deepEqual(paperSeed42A.instanceIds, paperSeed42B.instanceIds);
    assert.notDeepEqual(paperSeed42A.instanceIds, paperSeed99.instanceIds);
    assert.equal(new Set(paperSeed42A.instanceIds).size, 50);

    // Every repo with instances gets >= 1 slot when 50 >= 8 repos
    for (const repo of repos) {
      assert.ok(
        (paperSeed42A.repoDistribution[repo] ?? 0) >= 1,
        `Expected repo ${repo} to be represented in paper-50`,
      );
    }

    // Within largest repo (django/django), verify all 3 complexity strata (low, med, high) are represented
    const djangoSelected = paperSeed42A.instances.filter((i) => i.repo === 'django/django');
    const djangoIndices = djangoSelected.map((inst) =>
      djangoSorted.findIndex((s) => s.instance_id === inst.instance_id),
    );
    assert.ok(djangoIndices.some((idx) => idx < 12), 'Expected low-complexity stratum');
    assert.ok(djangoIndices.some((idx) => idx >= 12 && idx < 24), 'Expected med-complexity stratum');
    assert.ok(djangoIndices.some((idx) => idx >= 24), 'Expected high-complexity stratum');

    assert.equal(existsSync(paperSeed42A.manifestPath), true);
  });

  test('djangoTestNodeToLabel and buildSweBenchEvalCommands generate official Django, SymPy, and Pytest commands with chunking', () => {
    assert.equal(
      djangoTestNodeToLabel('test_foo (auth_tests.test_forms.LoginTest)'),
      'auth_tests.test_forms.LoginTest.test_foo',
    );
    assert.equal(
      djangoTestNodeToLabel('test_foo (auth_tests.test_forms.LoginTest.test_foo)'),
      'auth_tests.test_forms.LoginTest.test_foo',
    );
    assert.equal(
      djangoTestNodeToLabel('tests/auth_tests/test_forms.py::LoginTest::test_foo'),
      'auth_tests.test_forms.LoginTest.test_foo',
    );
    assert.equal(
      djangoTestNodeToLabel('Validates empty form submission (auth_tests.test_forms.LoginTest)'),
      'auth_tests.test_forms.LoginTest',
    );

    const djangoCmds = buildSweBenchEvalCommands({
      repo: 'django/django',
      FAIL_TO_PASS: ['test_fix (queries.tests.QueryTests)'],
      PASS_TO_PASS: ['tests/queries/tests.py::QueryTests::test_ok'],
    });
    assert.equal(djangoCmds.framework, 'django');
    assert.equal(djangoCmds.commands.length, 1);
    assert.match(djangoCmds.commands[0], /^\.\/tests\/runtests\.py --verbosity 2 --parallel 1 /);
    assert.match(djangoCmds.commands[0], /queries\.tests\.QueryTests\.test_fix/);
    assert.match(djangoCmds.commands[0], /queries\.tests\.QueryTests\.test_ok/);

    const sympyCmds = buildSweBenchEvalCommands({
      repo: 'sympy/sympy',
      FAIL_TO_PASS: ['sympy/core/tests/test_expr.py::test_issue_1'],
      PASS_TO_PASS: [
        'sympy/core/tests/test_expr.py::test_add',
        'sympy/core/tests/test_symbol.py::test_symbol',
      ],
    });
    assert.equal(sympyCmds.framework, 'sympy');
    assert.equal(sympyCmds.commands.length, 1);
    assert.match(
      sympyCmds.commands[0],
      /^PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin\/test -C --verbose /,
    );
    assert.match(sympyCmds.commands[0], /'sympy\/core\/tests\/test_expr\.py' 'sympy\/core\/tests\/test_symbol\.py'/);

    // Pytest chunking when > 60 targets
    const manyTargets = Array.from({ length: 125 }, (_, i) => `tests/test_suite.py::test_case_${i}`);
    const pytestCmds = buildSweBenchEvalCommands({
      repo: 'psf/requests',
      FAIL_TO_PASS: manyTargets.slice(0, 2),
      PASS_TO_PASS: manyTargets.slice(2),
    });
    assert.equal(pytestCmds.framework, 'pytest');
    assert.equal(pytestCmds.commands.length, 3, '125 targets should chunk into 60 + 60 + 5');
    assert.match(pytestCmds.commands[0], /^pytest -rA --tb=short /);

    // Django chunking when > 80 targets & SymPy test_patch file extraction fallback
    const manyDjango = Array.from({ length: 85 }, (_, i) => `test_m${i} (app.tests.TestSuite)`);
    const djangoChunked = buildSweBenchEvalCommands({
      repo: 'django/django',
      FAIL_TO_PASS: manyDjango,
      PASS_TO_PASS: [],
    });
    assert.equal(djangoChunked.commands.length, 2);

    const sympyFallback = buildSweBenchEvalCommands({
      repo: 'sympy/sympy',
      FAIL_TO_PASS: ['test_bare_name'],
      PASS_TO_PASS: [],
      test_patch:
        'diff --git a/sympy/solvers/tests/test_solveset.py b/sympy/solvers/tests/test_solveset.py\n+def test_bare_name(): pass\n',
    });
    assert.equal(sympyFallback.framework, 'sympy');
    assert.match(sympyFallback.commands[0], /sympy\/solvers\/tests\/test_solveset\.py/);
  });

  test('parseEvalTestResults parses pytest -rA, Django/unittest verbose, and SymPy bin/test outputs accurately', () => {
    // 1. Pytest -rA exact + stripped params + unique method matching
    const pytestOut = [
      '=========================== short test summary info ============================',
      'PASSED tests/test_req.py::TestAuth::test_bearer[utf8]',
      'PASSED tests/test_req.py::TestAuth::test_basic',
      'FAILED tests/test_other.py::test_unrelated - AssertionError: boom',
    ].join('\n');
    const pytestParsed = parseEvalTestResults(pytestOut, {
      repo: 'psf/requests',
      failToPass: ['tests/test_req.py::TestAuth::test_bearer'],
      passToPass: ['tests/test_req.py::TestAuth::test_basic', 'tests/test_other.py::test_unrelated'],
      exitCode: 1,
    });
    assert.equal(pytestParsed.failToPassPassed, 1);
    assert.equal(pytestParsed.passToPassPassed, 1);
    assert.equal(pytestParsed.passToPassFailed, 1);
    assert.equal(pytestParsed.resolved, false);
    assert.equal(pytestParsed.reason, 'failed_tests');

    // Unique method name match when node format differs, while non-unique method does not cross-match
    const uniqueMethodOut = [
      'PASSED tests/sub/test_unique.py::test_only_here',
      'PASSED tests/a.py::test_dup',
      'FAILED tests/b.py::test_dup - AssertionError',
    ].join('\n');
    const uniqueParsed = parseEvalTestResults(uniqueMethodOut, {
      repo: 'pytest-dev/pytest',
      failToPass: ['test_only_here'],
      passToPass: ['tests/a.py::test_dup'],
      exitCode: 1,
    });
    assert.equal(uniqueParsed.failToPassPassed, 1);
    assert.equal(uniqueParsed.passToPassPassed, 1);
    assert.equal(uniqueParsed.passToPassFailed, 0);

    // 2. Django/unittest verbose output
    const djangoOut = [
      'test_login (auth_tests.test_forms.LoginTest) ... ok',
      'test_logout (auth_tests.test_forms.LoginTest)',
      'Logs out the current user cleanly. ... ok',
      'Ran 2 tests in 0.012s',
      'OK',
    ].join('\n');
    const djangoParsed = parseEvalTestResults(djangoOut, {
      repo: 'django/django',
      failToPass: ['tests/auth_tests/test_forms.py::LoginTest::test_login'],
      passToPass: ['test_logout (auth_tests.test_forms.LoginTest)'],
      exitCode: 0,
    });
    assert.equal(djangoParsed.resolved, true);
    assert.equal(djangoParsed.failToPassPassed, 1);
    assert.equal(djangoParsed.passToPassPassed, 1);

    // 3. SymPy bin/test output
    const sympyOut = [
      'sympy/core/tests/test_expr.py[3]',
      '  test_issue_1 ... [OK]',
      '  test_add ok',
      '  test_mul F',
    ].join('\n');
    const sympyParsed = parseEvalTestResults(sympyOut, {
      repo: 'sympy/sympy',
      failToPass: ['sympy/core/tests/test_expr.py::test_issue_1'],
      passToPass: ['sympy/core/tests/test_expr.py::test_add', 'sympy/core/tests/test_expr.py::test_mul'],
      exitCode: 1,
    });
    assert.equal(sympyParsed.failToPassPassed, 1);
    assert.equal(sympyParsed.passToPassPassed, 1);
    assert.equal(sympyParsed.passToPassFailed, 1);
    assert.equal(sympyParsed.resolved, false);
  });

  test('evaluateSweBenchPredictions grades resolved, empty_patch, patch_apply_failed, test_patch_apply_failed, FAIL_TO_PASS fail, and PASS_TO_PASS regression while always destroying sessions', async () => {
    const dir = makeTmp('swe-eval-');
    const predPath = join(dir, 'predictions.full_aci.jsonl');
    const evalOutPath = join(dir, 'eval.full_aci.jsonl');

    const instances = [
      {
        instance_id: 'inst-resolved',
        repo: 'psf/requests',
        base_commit: 'c1',
        problem_statement: 'Fix bug 1',
        test_patch: [
          'diff --git a/tests/test_existing.py b/tests/test_existing.py',
          '--- a/tests/test_existing.py',
          '+++ b/tests/test_existing.py',
          '@@ -1 +1 @@',
          '+def test_new_fix(): assert True',
          'diff --git a/tests/test_brand_new.py b/tests/test_brand_new.py',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/tests/test_brand_new.py',
          '@@ -0,0 +1 @@',
          '+def test_brand_new(): assert True',
          '',
        ].join('\n'),
        FAIL_TO_PASS: ['tests/test_existing.py::test_new_fix'],
        PASS_TO_PASS: ['tests/test_existing.py::test_keep'],
      },
      {
        instance_id: 'inst-empty',
        repo: 'psf/requests',
        base_commit: 'c2',
        problem_statement: 'Fix bug 2',
        test_patch: '',
        FAIL_TO_PASS: ['tests/test_2.py::test_f'],
        PASS_TO_PASS: [],
      },
      {
        instance_id: 'inst-patch-fail',
        repo: 'psf/requests',
        base_commit: 'c3',
        problem_statement: 'Fix bug 3',
        test_patch: 'diff --git a/tests/t3.py b/tests/t3.py\n--- a/tests/t3.py\n+++ b/tests/t3.py\n',
        FAIL_TO_PASS: ['tests/t3.py::test_f'],
        PASS_TO_PASS: [],
      },
      {
        instance_id: 'inst-test-patch-fail',
        repo: 'psf/requests',
        base_commit: 'c4',
        problem_statement: 'Fix bug 4',
        test_patch: 'diff --git a/tests/t4.py b/tests/t4.py\n--- a/tests/t4.py\n+++ b/tests/t4.py\n',
        FAIL_TO_PASS: ['tests/t4.py::test_f'],
        PASS_TO_PASS: [],
      },
      {
        instance_id: 'inst-f2p-fail',
        repo: 'psf/requests',
        base_commit: 'c5',
        problem_statement: 'Fix bug 5',
        test_patch: 'diff --git a/tests/t5.py b/tests/t5.py\n--- a/tests/t5.py\n+++ b/tests/t5.py\n',
        FAIL_TO_PASS: ['tests/t5.py::test_f'],
        PASS_TO_PASS: ['tests/t5.py::test_p'],
      },
      {
        instance_id: 'inst-p2p-regress',
        repo: 'psf/requests',
        base_commit: 'c6',
        problem_statement: 'Fix bug 6',
        test_patch: 'diff --git a/tests/t6.py b/tests/t6.py\n--- a/tests/t6.py\n+++ b/tests/t6.py\n',
        FAIL_TO_PASS: ['tests/t6.py::test_f'],
        PASS_TO_PASS: ['tests/t6.py::test_p'],
      },
    ];

    const predictions = [
      {
        instance_id: 'inst-resolved',
        model_name_or_path: 'agent-us-full_aci',
        model_patch: "diff --git a/src/req.py b/src/req.py\n+msg = '$HOME `cmd`'\n",
      },
      {
        instance_id: 'inst-empty',
        model_name_or_path: 'agent-us-full_aci',
        model_patch: '   \n',
      },
      {
        instance_id: 'inst-patch-fail',
        model_name_or_path: 'agent-us-full_aci',
        model_patch: 'diff --git a/bad b/bad\n',
      },
      {
        instance_id: 'inst-test-patch-fail',
        model_name_or_path: 'agent-us-full_aci',
        model_patch: 'diff --git a/src/ok.py b/src/ok.py\n',
      },
      {
        instance_id: 'inst-f2p-fail',
        model_name_or_path: 'agent-us-full_aci',
        model_patch: 'diff --git a/src/ok5.py b/src/ok5.py\n',
      },
      {
        instance_id: 'inst-p2p-regress',
        model_name_or_path: 'agent-us-full_aci',
        model_patch: 'diff --git a/src/ok6.py b/src/ok6.py\n',
      },
    ];
    writeFileSync(
      predPath,
      `${predictions.map((p) => JSON.stringify(p)).join('\n')}\n`,
      'utf8',
    );

    const sessionLog = [];
    const destroyedIds = [];
    const resolvedCommands = [];

    const createDockerSession = async ({ instance }) => {
      const id = instance.instance_id;
      sessionLog.push(id);
      let applyCount = 0;
      return {
        workspaceRoot: `/tmp/${id}`,
        async exec(cmd, opts) {
          assert.equal(opts?.skipAntiCheatGuard, true);
          if (id === 'inst-resolved') {
            resolvedCommands.push(cmd);
          }
          if (cmd.startsWith('git apply -v -')) {
            applyCount += 1;
            if (id === 'inst-resolved' && applyCount === 1) {
              assert.match(cmd, /<<'__AGENT_US_PATCH_[0-9a-f]+__'/);
              assert.match(cmd, /\$HOME `cmd`/);
            }
            if (id === 'inst-patch-fail' && applyCount === 1) {
              return { exitCode: 1, stdout: '', stderr: 'patch failed', timedOut: false };
            }
            if (id === 'inst-test-patch-fail' && applyCount === 2) {
              return { exitCode: 1, stdout: '', stderr: 'test patch failed', timedOut: false };
            }
            return { exitCode: 0, stdout: 'Applied patch cleanly.', stderr: '', timedOut: false };
          }
          if (cmd.startsWith('git checkout -- ') || cmd.startsWith('rm -f -- ')) {
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
          }
          if (cmd.startsWith('pytest -rA')) {
            if (id === 'inst-resolved') {
              return {
                exitCode: 0,
                stdout:
                  'PASSED tests/test_existing.py::test_new_fix\nPASSED tests/test_existing.py::test_keep\n',
                stderr: '',
                timedOut: false,
              };
            }
            if (id === 'inst-f2p-fail') {
              return {
                exitCode: 1,
                stdout: 'FAILED tests/t5.py::test_f - AssertionError\nPASSED tests/t5.py::test_p\n',
                stderr: '',
                timedOut: false,
              };
            }
            if (id === 'inst-p2p-regress') {
              return {
                exitCode: 1,
                stdout: 'PASSED tests/t6.py::test_f\nFAILED tests/t6.py::test_p - Regression\n',
                stderr: '',
                timedOut: false,
              };
            }
          }
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        },
        async destroy() {
          destroyedIds.push(id);
        },
      };
    };

    const evalOut = await evaluateSweBenchPredictions({
      instances,
      predictionsPath: predPath,
      imageResolver: (inst) => `ghcr.io/epoch-research/swe-bench.eval.x86_64.${inst.instance_id}:latest`,
      createDockerSession,
      concurrency: 2,
      outputPath: evalOutPath,
    });

    assert.equal(evalOut.totalInstances, 6);
    assert.equal(evalOut.evaluatedCount, 6);
    assert.equal(evalOut.resolvedCount, 1);
    assert.equal(evalOut.resolvedRate, Number((1 / 6).toFixed(4)));
    assert.equal(existsSync(evalOutPath), true);

    // Empty patch must skip Docker session creation; all opened sessions must be destroyed
    assert.equal(sessionLog.includes('inst-empty'), false);
    assert.deepEqual([...sessionLog].sort(), [...destroyedIds].sort());

    // inst-resolved must reset existing test files and remove newly created test files before applying test_patch
    assert.equal(
      resolvedCommands.some((c) => c === "git checkout -- 'tests/test_existing.py'"),
      true,
    );
    assert.equal(
      resolvedCommands.some((c) => c === "rm -f -- 'tests/test_brand_new.py'"),
      true,
    );

    const byId = Object.fromEntries(evalOut.results.map((r) => [r.instance_id, r]));
    assert.equal(byId['inst-resolved'].resolved, true);
    assert.equal(byId['inst-resolved'].reason, 'resolved');
    assert.equal(byId['inst-empty'].resolved, false);
    assert.equal(byId['inst-empty'].reason, 'empty_patch');
    assert.equal(byId['inst-patch-fail'].resolved, false);
    assert.equal(byId['inst-patch-fail'].reason, 'patch_apply_failed');
    assert.equal(byId['inst-test-patch-fail'].resolved, false);
    assert.equal(byId['inst-test-patch-fail'].reason, 'test_patch_apply_failed');
    assert.equal(byId['inst-f2p-fail'].resolved, false);
    assert.equal(byId['inst-f2p-fail'].reason, 'failed_tests');
    assert.equal(byId['inst-p2p-regress'].resolved, false);
    assert.equal(byId['inst-p2p-regress'].passToPassFailed, 1);

    // Ensure session.destroy() is always called even when exec throws mid-evaluation
    let thrownDestroyed = false;
    const errEval = await evaluateSweBenchPredictions({
      instances: [instances[0]],
      predictions: [predictions[0]],
      logger: { warn() {} },
      createDockerSession: async () => ({
        workspaceRoot: '/tmp/err',
        async exec() {
          throw new Error('simulated container crash');
        },
        async destroy() {
          thrownDestroyed = true;
        },
      }),
    });
    assert.equal(thrownDestroyed, true, 'destroy() must always run in finally');
    assert.equal(errEval.results[0].resolved, false);
    assert.equal(errEval.results[0].reason, 'eval_error');
  });

  test('mergeEvalResultsIntoTelemetry, computePairedResolutionMetrics, and renderPaperLatexTable compute paired savings and clean booktabs LaTeX', () => {
    const rawTelemetry = [
      {
        instance_id: 'inst-1',
        arm: 'raw_full',
        steps: 10,
        wallClockMs: 4000,
        inputTokens: 45000,
        outputTokens: 5000,
        totalTokens: 50000,
        cacheReadTokens: 40000,
        cacheEligibleInputTokens: 45000,
      },
      {
        instance_id: 'inst-2',
        arm: 'raw_full',
        steps: 12,
        wallClockMs: 5000,
        inputTokens: 28000,
        outputTokens: 2000,
        totalTokens: 30000,
        cacheReadTokens: 24000,
        cacheEligibleInputTokens: 28000,
      },
    ];
    const aciTelemetry = [
      {
        instance_id: 'inst-1',
        arm: 'full_aci',
        steps: 8,
        wallClockMs: 3000,
        inputTokens: 27000,
        outputTokens: 3000,
        totalTokens: 30000,
        cacheReadTokens: 25000,
        cacheEligibleInputTokens: 27000,
      },
      {
        instance_id: 'inst-2',
        arm: 'full_aci',
        steps: 7,
        wallClockMs: 2500,
        inputTokens: 18000,
        outputTokens: 2000,
        totalTokens: 20000,
        cacheReadTokens: 16500,
        cacheEligibleInputTokens: 18000,
      },
    ];

    const rawEval = [
      { instance_id: 'inst-1', resolved: true, reason: 'resolved', failToPassPassed: 1, failToPassTotal: 1, passToPassPassed: 2, passToPassFailed: 0, passToPassTotal: 2 },
      { instance_id: 'inst-2', resolved: false, reason: 'failed_tests', failToPassPassed: 0, failToPassTotal: 1, passToPassPassed: 1, passToPassFailed: 0, passToPassTotal: 1 },
    ];
    const aciEval = [
      { instance_id: 'inst-1', resolved: true, reason: 'resolved', failToPassPassed: 1, failToPassTotal: 1, passToPassPassed: 2, passToPassFailed: 0, passToPassTotal: 2 },
      { instance_id: 'inst-2', resolved: true, reason: 'resolved', failToPassPassed: 1, failToPassTotal: 1, passToPassPassed: 1, passToPassFailed: 0, passToPassTotal: 1 },
    ];

    const mergedByArm = {
      raw_full: mergeEvalResultsIntoTelemetry(rawTelemetry, rawEval),
      full_aci: mergeEvalResultsIntoTelemetry(aciTelemetry, aciEval),
    };

    assert.equal(mergedByArm.raw_full[0].resolved, true);
    assert.equal(mergedByArm.raw_full[1].resolved, false);
    assert.equal(mergedByArm.full_aci[1].resolved, true);

    const paired = computePairedResolutionMetrics(['raw_full', 'full_aci'], mergedByArm, 'raw_full');
    assert.equal(paired.raw_full.resolvedCount, 1);
    assert.equal(paired.raw_full.resolvedRate, 0.5);
    assert.equal(paired.raw_full.tokensPerResolved, 80000);
    assert.equal(paired.raw_full.pairedResolvedCount, 1);
    assert.equal(paired.raw_full.pairedResolvedTokenReduction, 0);

    assert.equal(paired.full_aci.resolvedCount, 2);
    assert.equal(paired.full_aci.resolvedRate, 1);
    assert.equal(paired.full_aci.tokensPerResolved, 25000);
    assert.equal(paired.full_aci.pairedBaselineArm, 'raw_full');
    assert.deepEqual(paired.full_aci.pairedResolvedIds, ['inst-1']);
    assert.equal(paired.full_aci.pairedResolvedCount, 1);
    assert.equal(
      paired.full_aci.pairedResolvedTokenReduction,
      0.4,
      '(50000 - 30000) / 50000 = 0.40 on jointly resolved inst-1',
    );
    assert.equal(paired.full_aci.meanSteps, 7.5);
    assert.equal(paired.full_aci.meanWallClockMs, 2750);
    assert.ok(paired.full_aci.cacheHitRate > 0.9);

    const tex = renderPaperLatexTable({
      arms: ['raw_full', 'full_aci'],
      metricsByArm: paired,
      pairedByArm: paired,
      meta: { subset: 'smoke-5', model: 'deepseek-chat', seed: 42 },
    });
    assert.match(tex, /\\begin\{table\}/);
    assert.match(tex, /\\toprule/);
    assert.match(tex, /\\midrule/);
    assert.match(tex, /\\bottomrule/);
    assert.match(tex, /\\end\{table\}/);
    assert.match(tex, /\\texttt\{raw\\_full\}/);
    assert.match(tex, /\\texttt\{full\\_aci\}/);
    assert.match(tex, /1\/2 & 50\.00\\%/);
    assert.match(tex, /2\/2 & 100\.00\\%/);
    assert.match(tex, /40\.00\\% \(n=1\)/);
  });
});
