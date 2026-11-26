import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  POLYGLOT_DEFAULT_MODEL,
  POLYGLOT_LANGUAGES,
  POLYGLOT_MODES,
  aggregatePolyglotResults,
  createDryRunMeteringFetch,
  createPolyglotDryRunFixture,
  ensurePolyglotBenchmarkRepo,
  gradePolyglotWorkspace,
  loadPolyglotExercises,
  preparePolyglotWorkspace,
  renderPolyglotMarkdownReport,
  resolvePolyglotGradePlan,
  restoreProtectedTestFiles,
  runPolyglotExerciseMode,
  selectPolyglotSubset,
  slicePolyglotShard,
  unlockPolyglotTestContent,
} from '../../src/evaluation/polyglot-eval.js';
import {
  parsePolyglotCliArgs,
  runPolyglotCli,
} from '../../scripts/benchmark-polyglot.mjs';

function makeTempDir(prefix = 'polyglot-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('Aider Polyglot 6-language benchmark evaluation', () => {
  it('deterministically samples smoke-6 (1/lang=6) and polyglot-36 (6/lang=36) stratified subsets', () => {
    const fixture = createPolyglotDryRunFixture({ exercisesPerLanguage: 12 });
    try {
      const loaded = loadPolyglotExercises(fixture.benchmarkDir);
      assert.equal(loaded.length, 72);

      const smokeA = selectPolyglotSubset(loaded, { preset: 'smoke-6', seed: 42 });
      const smokeB = selectPolyglotSubset(loaded, { preset: 'smoke-6', seed: 42 });
      assert.equal(smokeA.exercises.length, 6);
      assert.deepEqual(smokeA.exerciseIds, smokeB.exerciseIds);
      for (const lang of POLYGLOT_LANGUAGES) {
        assert.equal(smokeA.languageDistribution[lang], 1, `smoke-6 must pick 1 exercise for ${lang}`);
      }

      const fullA = selectPolyglotSubset(loaded, { preset: 'polyglot-36', seed: 42 });
      const fullB = selectPolyglotSubset(loaded, { preset: 'polyglot-36', seed: 42 });
      assert.equal(fullA.exercises.length, 36);
      assert.deepEqual(fullA.exerciseIds, fullB.exerciseIds);
      assert.equal(new Set(fullA.exerciseIds).size, 36);
      for (const lang of POLYGLOT_LANGUAGES) {
        assert.equal(fullA.languageDistribution[lang], 6, `polyglot-36 must pick 6 exercises for ${lang}`);
      }

      // Custom language filter and limit
      const pyJs = selectPolyglotSubset(loaded, {
        preset: 'polyglot-36',
        languages: ['python', 'javascript'],
        limit: 5,
        seed: 42,
      });
      assert.equal(pyJs.exercises.length, 5);
      assert.ok(pyJs.exercises.every((e) => e.language === 'python' || e.language === 'javascript'));
    } finally {
      fixture.cleanup();
    }
  });

  it('partitions polyglot-36 cleanly and balances all 6 languages evenly across 3 shards', () => {
    const fixture = createPolyglotDryRunFixture({ exercisesPerLanguage: 8 });
    try {
      const loaded = loadPolyglotExercises(fixture.benchmarkDir);
      const subset = selectPolyglotSubset(loaded, { preset: 'polyglot-36', seed: 42 });

      const shard0 = slicePolyglotShard(subset.exercises, { shardIndex: 0, shardCount: 3 });
      const shard1 = slicePolyglotShard(subset.exercises, { shardIndex: 1, shardCount: 3 });
      const shard2 = slicePolyglotShard(subset.exercises, { shardIndex: 2, shardCount: 3 });

      assert.equal(shard0.length, 12);
      assert.equal(shard1.length, 12);
      assert.equal(shard2.length, 12);

      // Disjoint and complete partition
      const combined = [...shard0, ...shard1, ...shard2].map((e) => e.id);
      assert.equal(new Set(combined).size, 36);
      assert.deepEqual(
        [...combined].sort(),
        [...subset.exerciseIds].sort(),
      );

      // Every shard covers all 6 languages evenly (2 exercises per language per shard)
      for (const [idx, shard] of [shard0, shard1, shard2].entries()) {
        for (const lang of POLYGLOT_LANGUAGES) {
          const cnt = shard.filter((e) => e.language === lang).length;
          assert.equal(cnt, 2, `shard ${idx} should contain 2 ${lang} exercises`);
        }
      }

      assert.throws(() => slicePolyglotShard(subset.exercises, { shardIndex: 3, shardCount: 3 }));
      assert.throws(() => slicePolyglotShard(subset.exercises, { shardIndex: -1, shardCount: 3 }));
    } finally {
      fixture.cleanup();
    }
  });

  it('enforces anti-cheating test integrity: strips .meta/ and restores tampered or deleted test & harness files', () => {
    const fixture = createPolyglotDryRunFixture({ exercisesPerLanguage: 1 });
    try {
      const loaded = loadPolyglotExercises(fixture.benchmarkDir, { languages: ['javascript'] });
      assert.equal(loaded.length, 1);
      const ex = loaded[0];

      const ws = preparePolyglotWorkspace(ex);
      try {
        // 1. `.meta/` and reference proof solution MUST NOT be present in the agent workspace
        assert.equal(existsSync(join(ws.workspaceRoot, '.meta')), false);
        assert.equal(existsSync(join(ws.workspaceRoot, '.meta', 'proof.ci.js')), false);

        // 2. Simulate cheating agent tampering with test file, package.json, and injecting rogue test
        const specPath = join(ws.workspaceRoot, 'adder.spec.js');
        const pkgPath = join(ws.workspaceRoot, 'package.json');
        const pristineSpec = readFileSync(join(ex.exerciseDir, 'adder.spec.js'), 'utf8');
        const pristinePkg = readFileSync(join(ex.exerciseDir, 'package.json'), 'utf8');

        writeFileSync(specPath, "import test from 'node:test'; test('cheat', () => {});\n", 'utf8');
        writeFileSync(pkgPath, JSON.stringify({ name: 'cheat', scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
        writeFileSync(join(ws.workspaceRoot, 'cheat.test.js'), "console.log('rogue');\n", 'utf8');
        mkdirSync(join(ws.workspaceRoot, '.meta'), { recursive: true });
        writeFileSync(join(ws.workspaceRoot, '.meta', 'hack.json'), '{}', 'utf8');

        // Also edit solution file (this MUST be preserved!)
        const solPath = join(ws.workspaceRoot, 'adder.js');
        const customSolution = 'export function add(a, b) {\n  return a + b;\n}\n';
        writeFileSync(solPath, customSolution, 'utf8');

        const integrity = restoreProtectedTestFiles(ex, ws.workspaceRoot);
        assert.equal(integrity.integrityViolation, true);
        assert.ok(integrity.tamperedFiles.includes('adder.spec.js'));
        assert.ok(integrity.tamperedFiles.includes('package.json'));
        assert.ok(integrity.removedRogueTestFiles.includes('cheat.test.js'));
        assert.ok(integrity.removedRogueTestFiles.includes('.meta'));

        // Pristine test & harness files restored byte-for-byte
        assert.equal(readFileSync(specPath, 'utf8'), pristineSpec);
        assert.equal(readFileSync(pkgPath, 'utf8'), pristinePkg);
        assert.equal(existsSync(join(ws.workspaceRoot, 'cheat.test.js')), false);
        assert.equal(existsSync(join(ws.workspaceRoot, '.meta')), false);

        // Solution file untouched
        assert.equal(readFileSync(solPath, 'utf8'), customSolution);

        // Second restore reports clean integrity
        const cleanCheck = restoreProtectedTestFiles(ex, ws.workspaceRoot);
        assert.equal(cleanCheck.integrityViolation, false);
        assert.deepEqual(cleanCheck.tamperedFiles, []);
      } finally {
        ws.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('selects correct native build & test commands for all 6 languages (including Java Gradle vs Maven auto-detection)', () => {
    const tmp = makeTempDir('polyglot-grade-plan-');
    try {
      // Rust
      const rustDir = join(tmp, 'rust');
      mkdirSync(rustDir, { recursive: true });
      const rustPlan = resolvePolyglotGradePlan('rust', rustDir, { platform: 'linux' });
      assert.equal(rustPlan.steps[0].displayCommand, 'cargo test -- --include-ignored');

      // Go
      const goDir = join(tmp, 'go');
      mkdirSync(goDir, { recursive: true });
      const goPlan = resolvePolyglotGradePlan('go', goDir, { platform: 'linux' });
      assert.equal(goPlan.steps[0].displayCommand, 'go test ./...');

      // Java (gradlew vs build.gradle vs pom.xml)
      const javaGradlew = join(tmp, 'java-gradlew');
      mkdirSync(javaGradlew, { recursive: true });
      writeFileSync(join(javaGradlew, 'gradlew'), '#!/bin/sh\n', 'utf8');
      const jgPlan = resolvePolyglotGradePlan('java', javaGradlew, { platform: 'linux' });
      assert.equal(jgPlan.buildSystem, 'gradlew');
      assert.equal(jgPlan.steps[0].displayCommand, './gradlew test');

      const javaGradle = join(tmp, 'java-gradle');
      mkdirSync(javaGradle, { recursive: true });
      writeFileSync(join(javaGradle, 'build.gradle'), '', 'utf8');
      const jGradPlan = resolvePolyglotGradePlan('java', javaGradle, { platform: 'linux' });
      assert.equal(jGradPlan.buildSystem, 'gradle');
      assert.equal(jGradPlan.steps[0].displayCommand, 'gradle test');

      const javaMaven = join(tmp, 'java-maven');
      mkdirSync(javaMaven, { recursive: true });
      writeFileSync(join(javaMaven, 'pom.xml'), '<project/>', 'utf8');
      const jMvnPlan = resolvePolyglotGradePlan('java', javaMaven, { platform: 'linux' });
      assert.equal(jMvnPlan.buildSystem, 'maven');
      assert.equal(jMvnPlan.steps[0].displayCommand, 'mvn test');

      // C++ (cmake configure + build + ctest)
      const cppDir = join(tmp, 'cpp');
      mkdirSync(cppDir, { recursive: true });
      writeFileSync(join(cppDir, 'CMakeLists.txt'), 'enable_testing()\nadd_test(NAME t COMMAND t)\n', 'utf8');
      const cppPlan = resolvePolyglotGradePlan('cpp', cppDir, { platform: 'linux' });
      assert.equal(cppPlan.steps.length, 3);
      assert.ok(cppPlan.steps[0].displayCommand.includes('cmake'));
      assert.ok(cppPlan.steps[1].displayCommand.includes('cmake --build'));
      assert.ok(cppPlan.steps[2].displayCommand.includes('ctest') && cppPlan.steps[2].displayCommand.includes('--output-on-failure'));

      // JavaScript (npm test vs jest)
      const jsNpm = join(tmp, 'js-npm');
      mkdirSync(jsNpm, { recursive: true });
      writeFileSync(join(jsNpm, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }), 'utf8');
      const jsNpmPlan = resolvePolyglotGradePlan('javascript', jsNpm, { platform: 'linux' });
      assert.equal(jsNpmPlan.steps[0].displayCommand, 'npm test');

      const jsJest = join(tmp, 'js-jest');
      mkdirSync(jsJest, { recursive: true });
      writeFileSync(join(jsJest, 'jest.config.js'), 'module.exports = {};\n', 'utf8');
      const jsJestPlan = resolvePolyglotGradePlan('javascript', jsJest, { platform: 'linux' });
      assert.equal(jsJestPlan.steps[0].displayCommand, 'jest');

      // Python (pytest)
      const pyDir = join(tmp, 'py');
      mkdirSync(pyDir, { recursive: true });
      const pyPlan = resolvePolyglotGradePlan('python', pyDir, { platform: 'linux' });
      assert.equal(pyPlan.steps[0].displayCommand, 'pytest');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('executes real native JS (npm test) & Python (pytest) grading and catches tampered failing solutions', async () => {
    const fixture = createPolyglotDryRunFixture({ exercisesPerLanguage: 1 });
    try {
      const jsEx = loadPolyglotExercises(fixture.benchmarkDir, { languages: ['javascript'] })[0];
      const pyEx = loadPolyglotExercises(fixture.benchmarkDir, { languages: ['python'] })[0];

      // 1. JavaScript real execution: failing starter + tampered test MUST still fail!
      const jsWs = preparePolyglotWorkspace(jsEx);
      try {
        writeFileSync(
          join(jsWs.workspaceRoot, 'adder.spec.js'),
          "import test from 'node:test'; test('always passes', () => {});\n",
          'utf8',
        );
        const failGrade = await gradePolyglotWorkspace(jsEx, jsWs.workspaceRoot);
        assert.equal(failGrade.passed, false);
        assert.equal(failGrade.gradeMode, 'native');
        assert.equal(failGrade.integrity.integrityViolation, true);

        // Apply real fix -> native `npm test` passes!
        writeFileSync(
          join(jsWs.workspaceRoot, 'adder.js'),
          'export function add(a, b) {\n  return a + b;\n}\n',
          'utf8',
        );
        const passGrade = await gradePolyglotWorkspace(jsEx, jsWs.workspaceRoot);
        assert.equal(passGrade.passed, true);
        assert.equal(passGrade.exitCode, 0);
        assert.equal(passGrade.gradeMode, 'native');
      } finally {
        jsWs.cleanup();
      }

      // 2. Python real execution with pytest
      const pyWs = preparePolyglotWorkspace(pyEx);
      try {
        const failGrade = await gradePolyglotWorkspace(pyEx, pyWs.workspaceRoot);
        assert.equal(failGrade.passed, false);
        assert.equal(failGrade.gradeMode, 'native');

        writeFileSync(
          join(pyWs.workspaceRoot, 'adder.py'),
          'def add(a: int, b: int) -> int:\n    return a + b\n',
          'utf8',
        );
        const passGrade = await gradePolyglotWorkspace(pyEx, pyWs.workspaceRoot);
        assert.equal(passGrade.passed, true);
        assert.equal(passGrade.exitCode, 0);
        assert.equal(passGrade.gradeMode, 'native');
      } finally {
        pyWs.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('runs all 4 modes end-to-end through unified SweBenchMeteringProxy and solves real JS fixture', async () => {
    const fixture = createPolyglotDryRunFixture({ exercisesPerLanguage: 1 });
    try {
      const jsEx = loadPolyglotExercises(fixture.benchmarkDir, { languages: ['javascript'] })[0];
      for (const mode of POLYGLOT_MODES) {
        const rec = await runPolyglotExerciseMode({
          exercise: jsEx,
          mode,
          opts: {
            dryRun: true,
            model: POLYGLOT_DEFAULT_MODEL,
            maxSteps: 10,
          },
        });
        assert.equal(rec.mode, mode);
        assert.equal(rec.model, POLYGLOT_DEFAULT_MODEL);
        assert.equal(rec.status, 'completed', `mode=${mode} error=${rec.error}`);
        assert.equal(rec.passed, true, `mode=${mode} gradeError=${rec.gradeError}`);
        assert.equal(rec.gradeMode, 'native');
        assert.ok(rec.steps >= 2, `mode=${mode} expected >=2 metered steps, got ${rec.steps}`);
        assert.ok(rec.inputTokens > 0, `mode=${mode} expected inputTokens > 0`);
        assert.ok(rec.outputTokens > 0, `mode=${mode} expected outputTokens > 0`);
        assert.equal(rec.cacheStatus, 'available', `mode=${mode} expected available cache telemetry`);
        assert.ok(rec.cacheReadTokens > 0, `mode=${mode} expected cache_read > 0 across multi-step turn`);
        assert.ok(rec.cacheHitRate > 0 && rec.cacheHitRate <= 1);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('supports ensurePolyglotBenchmarkRepo local cache reuse and mocked shallow clone', async () => {
    const fixture = createPolyglotDryRunFixture({ exercisesPerLanguage: 1 });
    const cloneTarget = join(makeTempDir('polyglot-clone-'), 'cloned-repo');
    try {
      const reused = await ensurePolyglotBenchmarkRepo({
        benchmarkDir: fixture.benchmarkDir,
        allowClone: false,
      });
      assert.equal(reused.cloned, false);
      assert.equal(reused.repoDir, fixture.benchmarkDir);

      let capturedArgs = null;
      const cloned = await ensurePolyglotBenchmarkRepo({
        benchmarkDir: cloneTarget,
        allowClone: true,
        gitRunner: async (args) => {
          capturedArgs = args;
          mkdirSync(join(cloneTarget, 'python'), { recursive: true });
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });
      assert.equal(cloned.cloned, true);
      assert.ok(capturedArgs.includes('--depth'));
      assert.ok(capturedArgs.includes('1'));
    } finally {
      fixture.cleanup();
      rmSync(join(cloneTarget, '..'), { recursive: true, force: true });
    }
  });

  it('supports CLI --dry-run sharded execution and --aggregate report merging (JSON + Markdown)', async () => {
    const outRoot = makeTempDir('polyglot-cli-agg-');
    const shardDir = join(outRoot, 'shards');
    const mergedDir = join(outRoot, 'merged');
    const fixture = createPolyglotDryRunFixture({ exercisesPerLanguage: 1 });
    try {
      // Verify CLI arg parsing defaults and validation
      const parsed = parsePolyglotCliArgs([
        '--preset', 'polyglot-36',
        '--modes', 'raw_full,full_aci,claude_code,mini_swe_agent',
        '--model', 'deepseek-v4.1-flash',
        '--shard-index', '1',
        '--shard-count', '3',
        '--dry-run',
      ]);
      assert.equal(parsed.preset, 'polyglot-36');
      assert.equal(parsed.model, 'deepseek-v4.1-flash');
      assert.equal(parsed.shardIndex, 1);
      assert.equal(parsed.shardCount, 3);
      assert.deepEqual(parsed.modes, [...POLYGLOT_MODES]);

      // Run 3 shards of smoke-6 across raw_full + mini_swe_agent
      for (let s = 0; s < 3; s++) {
        const res = await runPolyglotCli([
          '--preset', 'smoke-6',
          '--modes', 'raw_full,mini_swe_agent',
          '--model', 'deepseek-v4.1-flash',
          '--shard-index', String(s),
          '--shard-count', '3',
          '--benchmark-dir', fixture.benchmarkDir,
          '--output', join(shardDir, `shard-${s}.json`),
          '--dry-run',
          '--json',
        ]);
        assert.equal(res.action, 'run');
        assert.equal(res.shardExercisesCount, 2);
        assert.equal(existsSync(join(shardDir, `shard-${s}.json`)), true);
        assert.equal(existsSync(join(shardDir, `shard-${s}.md`)), true);
      }

      // Aggregate all 3 shards
      const agg = await runPolyglotCli([
        '--aggregate', shardDir,
        '--preset', 'smoke-6',
        '--model', 'deepseek-v4.1-flash',
        '--output', mergedDir,
        '--json',
      ]);
      assert.equal(agg.action, 'aggregate');
      assert.equal(agg.sourceFiles.length, 3);
      assert.equal(agg.report.meta.totalUniqueExercises, 6);
      assert.equal(agg.report.summaryByMode.raw_full.totalExercises, 6);
      assert.equal(agg.report.summaryByMode.raw_full.passedExercises, 6);
      assert.equal(agg.report.summaryByMode.mini_swe_agent.totalExercises, 6);
      assert.equal(agg.report.summaryByMode.mini_swe_agent.passedExercises, 6);
      assert.equal(existsSync(join(mergedDir, 'summary.json')), true);
      assert.equal(existsSync(join(mergedDir, 'summary.md')), true);

      const md = readFileSync(join(mergedDir, 'summary.md'), 'utf8');
      assert.ok(md.includes('Aider Polyglot 6-Language Benchmark Report'));
      assert.ok(md.includes('Per-Language Solve Rate Matrix'));
      assert.ok(md.includes('`raw_full`'));
      assert.ok(md.includes('`mini_swe_agent`'));
      for (const lang of POLYGLOT_LANGUAGES) {
        assert.ok(md.includes(`\`${lang}\``), `Markdown report should include ${lang}`);
      }

      // Direct unit check of aggregatePolyglotResults deduplication & Markdown rendering
      const directAgg = aggregatePolyglotResults(
        [
          { exerciseId: 'python/a', language: 'python', slug: 'a', mode: 'full_aci', model: 'deepseek-v4.1-flash', status: 'env_error', passed: false, steps: 0, inputTokens: 0, outputTokens: 0, wallClockMs: 5 },
          { exerciseId: 'python/a', language: 'python', slug: 'a', mode: 'full_aci', model: 'deepseek-v4.1-flash', status: 'completed', passed: true, steps: 3, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 700, cacheEligibleInputTokens: 1000, cacheStatus: 'available', cacheHitRate: 0.7, wallClockMs: 120 },
        ],
        { modes: ['full_aci'], languages: ['python'] },
      );
      assert.equal(directAgg.summaryByMode.full_aci.passedExercises, 1);
      assert.equal(directAgg.summaryByMode.full_aci.cacheHitRate, 0.7);
      const rendered = renderPolyglotMarkdownReport(directAgg);
      assert.ok(rendered.includes('70.00%'));
    } finally {
      fixture.cleanup();
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  it('unlocks Java @Disabled(...) and JS xtest( in both preparePolyglotWorkspace and restoreProtectedTestFiles', async () => {
    const root = makeTempDir('polyglot-unlock-');
    try {
      // 1. Java exercise with both bare @Disabled and @Disabled("Remove to run test")
      const javaExDir = join(root, 'java', 'exercises', 'practice', 'two-fer');
      mkdirSync(join(javaExDir, '.meta'), { recursive: true });
      mkdirSync(join(javaExDir, 'src', 'main', 'java'), { recursive: true });
      mkdirSync(join(javaExDir, 'src', 'test', 'java'), { recursive: true });
      writeFileSync(
        join(javaExDir, '.meta', 'config.json'),
        JSON.stringify({
          title: 'Two Fer',
          files: {
            solution: ['src/main/java/Twofer.java'],
            test: ['src/test/java/TwoferTest.java'],
          },
        }),
        'utf8',
      );
      writeFileSync(
        join(javaExDir, 'src', 'main', 'java', 'Twofer.java'),
        'public class Twofer { public String twofer(String name) { return name == null ? "One for you, one for me." : "One for " + name + ", one for me."; } }\n',
        'utf8',
      );
      const rawJavaTest = [
        'import org.junit.jupiter.api.Disabled;',
        'import org.junit.jupiter.api.Test;',
        '',
        'public class TwoferTest {',
        '    @Test',
        '    public void noNameGiven() {}',
        '',
        '    @Disabled("Remove to run test")',
        '    @Test',
        '    public void aNameGiven() {}',
        '',
        '    @Disabled',
        '    @Test',
        '    public void anotherNameGiven() {}',
        '}',
        '',
      ].join('\n');
      writeFileSync(join(javaExDir, 'src', 'test', 'java', 'TwoferTest.java'), rawJavaTest, 'utf8');

      // 2. JS exercise with xtest( in both .spec.js and .test.js
      const jsExDir = join(root, 'javascript', 'exercises', 'practice', 'adder-xtest');
      mkdirSync(join(jsExDir, '.meta'), { recursive: true });
      writeFileSync(
        join(jsExDir, '.meta', 'config.json'),
        JSON.stringify({
          title: 'Adder XTest',
          files: {
            solution: ['adder.js'],
            test: ['adder.spec.js', 'extra.test.js'],
          },
        }),
        'utf8',
      );
      writeFileSync(
        join(jsExDir, 'package.json'),
        JSON.stringify({
          name: 'adder-xtest',
          type: 'module',
          scripts: { test: 'node --test adder.spec.js extra.test.js' },
        }),
        'utf8',
      );
      writeFileSync(
        join(jsExDir, 'adder.js'),
        'export function add(a, b) {\n  return a === 2 && b === 3 ? 5 : a - b;\n}\n',
        'utf8',
      );
      writeFileSync(
        join(jsExDir, 'adder.spec.js'),
        [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { add } from './adder.js';",
          '',
          "test('first case enabled', () => {",
          '  assert.equal(add(2, 3), 5);',
          '});',
          '',
          "xtest('second case initially disabled', () => {",
          '  assert.equal(add(10, 25), 35);',
          '});',
          '',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        join(jsExDir, 'extra.test.js'),
        [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { add } from './adder.js';",
          '',
          "xtest ('spaced xtest case', () => {",
          '  assert.equal(add(-4, 9), 5);',
          '});',
          '',
        ].join('\n'),
        'utf8',
      );

      // Pure helper sanity checks
      const unlockedJavaDirect = unlockPolyglotTestContent(rawJavaTest, 'java');
      assert.equal(/@Disabled/.test(unlockedJavaDirect), false);
      assert.ok(unlockedJavaDirect.includes('import org.junit.jupiter.api.Disabled;'));
      assert.ok(unlockedJavaDirect.includes('public void aNameGiven()'));
      assert.ok(unlockedJavaDirect.includes('public void anotherNameGiven()'));

      const javaEx = loadPolyglotExercises(root, { languages: ['java'] })[0];
      const javaWs = preparePolyglotWorkspace(javaEx);
      try {
        const javaTestWsPath = join(javaWs.workspaceRoot, 'src', 'test', 'java', 'TwoferTest.java');
        const preparedJava = readFileSync(javaTestWsPath, 'utf8');
        assert.equal(/@Disabled/.test(preparedJava), false, 'preparePolyglotWorkspace must strip @Disabled and @Disabled(...)');
        assert.ok(preparedJava.includes('import org.junit.jupiter.api.Disabled;'));
        assert.equal((preparedJava.match(/@Test/g) ?? []).length, 3);

        // Untouched unlocked workspace should NOT trigger false integrity violation
        const cleanRestore = restoreProtectedTestFiles(javaEx, javaWs.workspaceRoot);
        assert.equal(cleanRestore.integrityViolation, false);
        assert.equal(/@Disabled/.test(readFileSync(javaTestWsPath, 'utf8')), false);

        // Simulate agent tampering (re-disabling tests) -> restoreProtectedTestFiles catches tamper and re-unlocks
        writeFileSync(javaTestWsPath, rawJavaTest, 'utf8');
        const tamperedRestore = restoreProtectedTestFiles(javaEx, javaWs.workspaceRoot);
        assert.equal(tamperedRestore.integrityViolation, true);
        assert.ok(tamperedRestore.tamperedFiles.includes('src/test/java/TwoferTest.java'));
        const afterRestoreJava = readFileSync(javaTestWsPath, 'utf8');
        assert.equal(/@Disabled/.test(afterRestoreJava), false, 'restoreProtectedTestFiles must unlock @Disabled annotations');
        assert.ok(afterRestoreJava.includes('import org.junit.jupiter.api.Disabled;'));
      } finally {
        javaWs.cleanup();
      }

      const jsEx = loadPolyglotExercises(root, { languages: ['javascript'] })[0];
      const jsWs = preparePolyglotWorkspace(jsEx);
      try {
        const specPath = join(jsWs.workspaceRoot, 'adder.spec.js');
        const extraPath = join(jsWs.workspaceRoot, 'extra.test.js');
        const preparedSpec = readFileSync(specPath, 'utf8');
        const preparedExtra = readFileSync(extraPath, 'utf8');
        assert.equal(/\bxtest\s*\(/.test(preparedSpec), false, 'preparePolyglotWorkspace must unlock xtest( in .spec.js');
        assert.equal(/\bxtest\s*\(/.test(preparedExtra), false, 'preparePolyglotWorkspace must unlock xtest( in .test.js');
        assert.equal((preparedSpec.match(/\btest\(/g) ?? []).length, 2);
        assert.equal((preparedExtra.match(/\btest\(/g) ?? []).length, 1);

        // Partial starter passes only the 1st test -> unlocked xtest( MUST cause real native grading to FAIL!
        const failGrade = await gradePolyglotWorkspace(jsEx, jsWs.workspaceRoot);
        assert.equal(failGrade.passed, false);
        assert.equal(failGrade.gradeMode, 'native');
        assert.equal(failGrade.integrity.integrityViolation, false);

        // Tamper test back to xtest( -> restoreProtectedTestFiles must catch it and re-unlock
        writeFileSync(specPath, readFileSync(join(jsExDir, 'adder.spec.js'), 'utf8'), 'utf8');
        const tamperedJsRestore = restoreProtectedTestFiles(jsEx, jsWs.workspaceRoot);
        assert.equal(tamperedJsRestore.integrityViolation, true);
        assert.ok(tamperedJsRestore.tamperedFiles.includes('adder.spec.js'));
        assert.equal(/\bxtest\s*\(/.test(readFileSync(specPath, 'utf8')), false);

        // Fix solution -> all unlocked tests pass!
        writeFileSync(
          join(jsWs.workspaceRoot, 'adder.js'),
          'export function add(a, b) {\n  return a + b;\n}\n',
          'utf8',
        );
        const passGrade = await gradePolyglotWorkspace(jsEx, jsWs.workspaceRoot);
        assert.equal(passGrade.passed, true);
        assert.equal(passGrade.gradeMode, 'native');
        assert.equal(passGrade.integrity.integrityViolation, false);
      } finally {
        jsWs.cleanup();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('symlinks shared JS node_modules and package-lock.json cleanly, preserves them across restore, and parses --shared-js-node-modules', () => {
    const fixture = createPolyglotDryRunFixture({ exercisesPerLanguage: 1 });
    const sharedRoot = makeTempDir('polyglot-shared-js-');
    const sharedNm = join(sharedRoot, 'node_modules');
    const sharedPkgDir = join(sharedNm, 'fake-exercism-dep');
    const sharedLock = join(sharedRoot, 'package-lock.json');
    try {
      mkdirSync(sharedPkgDir, { recursive: true });
      writeFileSync(join(sharedPkgDir, 'index.js'), 'export const marker = "shared-ok";\n', 'utf8');
      const lockContent = JSON.stringify({ name: 'polyglot-npm-install', lockfileVersion: 3 }, null, 2);
      writeFileSync(sharedLock, lockContent, 'utf8');

      const jsEx = loadPolyglotExercises(fixture.benchmarkDir, { languages: ['javascript'] })[0];
      const ws = preparePolyglotWorkspace(jsEx, { sharedJsNodeModulesDir: sharedNm });
      try {
        const wsNm = join(ws.workspaceRoot, 'node_modules');
        const wsLock = join(ws.workspaceRoot, 'package-lock.json');

        assert.equal(ws.linkedNodeModules, sharedNm);
        assert.equal(existsSync(wsNm), true);
        assert.equal(lstatSync(wsNm).isSymbolicLink(), true, 'workspace node_modules should be a symlink/junction');
        assert.equal(realpathSync(wsNm), realpathSync(sharedNm));
        assert.equal(existsSync(join(wsNm, 'fake-exercism-dep', 'index.js')), true);

        assert.equal(existsSync(wsLock), true, 'package-lock.json from shared parent dir should be linked/present');
        assert.equal(readFileSync(wsLock, 'utf8'), lockContent);
        if (lstatSync(wsLock).isSymbolicLink()) {
          assert.equal(realpathSync(wsLock), realpathSync(sharedLock));
        }

        // restoreProtectedTestFiles must NOT break the symlink or flag false integrity violations
        const integrity = restoreProtectedTestFiles(jsEx, ws.workspaceRoot);
        assert.equal(integrity.integrityViolation, false);
        assert.equal(lstatSync(wsNm).isSymbolicLink(), true, 'restoreProtectedTestFiles must preserve node_modules symlink');
        assert.equal(realpathSync(wsNm), realpathSync(sharedNm));
        assert.equal(existsSync(wsLock), true);
      } finally {
        ws.cleanup();
      }

      // Workspace cleanup must NOT delete contents of the shared node_modules directory
      assert.equal(existsSync(join(sharedPkgDir, 'index.js')), true);
      assert.equal(existsSync(sharedLock), true);

      // Existing exercise package-lock.json must be preserved over shared parent lockfile
      const customLock = JSON.stringify({ name: 'exercise-owned-lock', lockfileVersion: 3 });
      writeFileSync(join(jsEx.exerciseDir, 'package-lock.json'), customLock, 'utf8');
      const jsExWithLock = loadPolyglotExercises(fixture.benchmarkDir, { languages: ['javascript'] })[0];
      const ws2 = preparePolyglotWorkspace(jsExWithLock, { sharedJsNodeModulesDir: sharedNm });
      try {
        assert.equal(readFileSync(join(ws2.workspaceRoot, 'package-lock.json'), 'utf8'), customLock);
        assert.equal(lstatSync(join(ws2.workspaceRoot, 'package-lock.json')).isSymbolicLink(), false);
      } finally {
        ws2.cleanup();
      }

      // CLI parsing for --shared-js-node-modules (both space-separated and =)
      const cliA = parsePolyglotCliArgs(['--shared-js-node-modules', '/tmp/polyglot-npm-install/node_modules']);
      assert.equal(cliA.sharedJsNodeModulesDir, '/tmp/polyglot-npm-install/node_modules');
      const cliB = parsePolyglotCliArgs(['--shared-js-node-modules=/tmp/polyglot-npm-install/node_modules']);
      assert.equal(cliB.sharedJsNodeModulesDir, '/tmp/polyglot-npm-install/node_modules');
    } finally {
      fixture.cleanup();
      rmSync(sharedRoot, { recursive: true, force: true });
    }
  });

  it('uses process.execPath --input-type=commonjs in dry-run bash mode and provides self-contained pure-JDK adder-java-01', async () => {
    const fixture = createPolyglotDryRunFixture({ exercisesPerLanguage: 1 });
    try {
      // 1. Verify createDryRunMeteringFetch isBashOnly emits process.execPath + --input-type=commonjs
      const jsEx = loadPolyglotExercises(fixture.benchmarkDir, { languages: ['javascript'] })[0];
      const jsWs = preparePolyglotWorkspace(jsEx);
      try {
        const dryFetch = createDryRunMeteringFetch({
          exercise: jsEx,
          workspaceRoot: jsWs.workspaceRoot,
          mode: 'mini_swe_agent',
        });
        const bashTools = [
          { type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
        ];
        const expectedPrefix = `${JSON.stringify(process.execPath)} --input-type=commonjs -e `;

        const res1 = await dryFetch('https://dry.invalid/v1/chat/completions', {
          method: 'POST',
          body: JSON.stringify({ model: POLYGLOT_DEFAULT_MODEL, messages: [{ role: 'user', content: 'solve' }], tools: bashTools }),
        });
        const j1 = await res1.json();
        const inspectCmd = JSON.parse(j1.choices[0].message.tool_calls[0].function.arguments).command;
        assert.ok(inspectCmd.startsWith(expectedPrefix), `inspect command must use process.execPath --input-type=commonjs, got: ${inspectCmd}`);

        const res2 = await dryFetch('https://dry.invalid/v1/chat/completions', {
          method: 'POST',
          body: JSON.stringify({
            model: POLYGLOT_DEFAULT_MODEL,
            messages: [
              { role: 'user', content: 'solve' },
              { role: 'tool', tool_call_id: 'poly-dry-inspect', content: 'ok' },
            ],
            tools: bashTools,
          }),
        });
        const j2 = await res2.json();
        const editCmd = JSON.parse(j2.choices[0].message.tool_calls[0].function.arguments).command;
        assert.ok(editCmd.startsWith(expectedPrefix), `edit command must use process.execPath --input-type=commonjs, got: ${editCmd}`);
      } finally {
        jsWs.cleanup();
      }

      // 2. Verify adder-java-01 fixture uses pure-JDK self-contained Gradle task (no Maven Central / JUnit downloads)
      const javaEx = loadPolyglotExercises(fixture.benchmarkDir, { languages: ['java'] })[0];
      const buildGradle = readFileSync(join(javaEx.exerciseDir, 'build.gradle'), 'utf8');
      assert.ok(buildGradle.includes("tasks.register('test')"));
      assert.equal(buildGradle.includes('mavenCentral()'), false);
      assert.equal(buildGradle.includes('useJUnitPlatform()'), false);
      assert.equal(existsSync(join(javaEx.exerciseDir, 'settings.gradle')), true);

      const javaWs = preparePolyglotWorkspace(javaEx);
      try {
        // Honest dry-run fallback when gradle binary is missing
        const missingRunner = async () => ({ exitCode: 127, notFound: true, timedOut: false, stdout: '', stderr: 'not found' });
        const failFallback = await gradePolyglotWorkspace(javaEx, javaWs.workspaceRoot, {
          dryRunFallbackOnMissingToolchain: true,
          commandRunner: missingRunner,
        });
        assert.equal(failFallback.passed, false);
        assert.equal(failFallback.gradeMode, 'dry_run_toolchain_fallback');

        // Verify javac + java compile & execute AdderTest honestly if JDK is installed on host
        const javacCheck = spawnSync('javac', ['-version'], { encoding: 'utf8' });
        const classesDir = join(javaWs.workspaceRoot, 'build', 'classes');
        if (javacCheck.status === 0) {
          mkdirSync(classesDir, { recursive: true });
          const c1 = spawnSync('javac', ['-d', classesDir, 'src/main/java/Adder.java', 'src/test/java/AdderTest.java'], {
            cwd: javaWs.workspaceRoot,
            encoding: 'utf8',
          });
          assert.equal(c1.status, 0, `javac failed: ${c1.stderr}`);
          const r1 = spawnSync('java', ['-cp', classesDir, 'AdderTest'], {
            cwd: javaWs.workspaceRoot,
            encoding: 'utf8',
          });
          assert.notEqual(r1.status, 0, 'buggy Adder.java must fail AdderTest');
        }

        // Apply real fix
        writeFileSync(
          join(javaWs.workspaceRoot, 'src', 'main', 'java', 'Adder.java'),
          'public class Adder {\n    public static int add(int a, int b) {\n        return a + b;\n    }\n}\n',
          'utf8',
        );

        const passFallback = await gradePolyglotWorkspace(javaEx, javaWs.workspaceRoot, {
          dryRunFallbackOnMissingToolchain: true,
          commandRunner: missingRunner,
        });
        assert.equal(passFallback.passed, true);
        assert.equal(passFallback.gradeMode, 'dry_run_toolchain_fallback');

        if (javacCheck.status === 0) {
          const c2 = spawnSync('javac', ['-d', classesDir, 'src/main/java/Adder.java', 'src/test/java/AdderTest.java'], {
            cwd: javaWs.workspaceRoot,
            encoding: 'utf8',
          });
          assert.equal(c2.status, 0, `javac failed: ${c2.stderr}`);
          const r2 = spawnSync('java', ['-cp', classesDir, 'AdderTest'], {
            cwd: javaWs.workspaceRoot,
            encoding: 'utf8',
          });
          assert.equal(r2.status, 0, `fixed Adder.java must pass AdderTest: ${r2.stderr}`);
        }
      } finally {
        javaWs.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });
});
