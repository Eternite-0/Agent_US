import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVIDENCE_MANIFEST_SCHEMA_VERSION,
  EVIDENCE_STATUSES,
  formatEvidenceManifestContract,
  normalizeEvidencePath,
  validateEvidenceManifest,
} from './schemas.js';
import { listWorkspaceChangedFiles, verifyWorkspacePinnedBaseline } from './fixtures.js';
import {
  BenchmarkSandbox,
  isPathInsideRoot,
  runHardenedGit,
} from '../tools/benchmark-sandbox.js';
import { DEFAULT_DEPENDENCY_POLICY, validatePackageDependencies } from './dependency-policy.js';
import { estimateTaskBudget } from '../planning/budget-estimator.js';

export const OSS_BENCHMARK_ID = 'agent-us-oss-benchmark';
export const OSS_BENCHMARK_VERSION = '1.0.0';
export const OSS_DATASET_VERSION = '1.0.0';

const DEFAULT_SANDBOX_BY_MODE = new Map();

function getDefaultBenchmarkSandbox() {
  const modeKey = process.env.AGENT_US_BENCHMARK_SANDBOX_MODE || 'auto';
  let sbx = DEFAULT_SANDBOX_BY_MODE.get(modeKey);
  if (!sbx) {
    sbx = new BenchmarkSandbox();
    DEFAULT_SANDBOX_BY_MODE.set(modeKey, sbx);
  }
  return sbx;
}

async function checkFilesUnmodifiedSince(workspaceRoot, baselineCommit, protectedFiles = []) {
  if (!protectedFiles.length) return { ok: true, modified: [] };
  try {
    const res = await runHardenedGit(
      ['diff', '--no-ext-diff', '--name-only', baselineCommit, '--', ...protectedFiles],
      { cwd: workspaceRoot, allowNetwork: false },
    );
    if (res.error || res.exitCode !== 0) {
      return { ok: false, modified: [...protectedFiles] };
    }
    const modified = res.stdout
      .split(/\r?\n/)
      .map(normalizeEvidencePath)
      .filter(Boolean);
    return { ok: modified.length === 0, modified };
  } catch {
    return { ok: false, modified: [...protectedFiles] };
  }
}

async function hasRealSourceDiff(workspaceRoot, baselineCommit, sourceFiles = [], changedFiles = null) {
  if (!sourceFiles.length) return true;
  const changed = new Set(changedFiles ?? listWorkspaceChangedFiles(workspaceRoot));
  const normalized = sourceFiles.map(normalizeEvidencePath);
  for (const rel of normalized) {
    if (!changed.has(rel)) return false;
    if (!existsSync(join(workspaceRoot, rel))) return false;
  }
  try {
    const lsRes = await runHardenedGit(['ls-files', '-z', '--', ...normalized], {
      cwd: workspaceRoot,
      allowNetwork: false,
    });
    if (lsRes.error || lsRes.exitCode !== 0) return false;
    const trackedSet = new Set(lsRes.stdout.split('\0').map(normalizeEvidencePath).filter(Boolean));
    const trackedFiles = [];
    for (const rel of normalized) {
      if (trackedSet.has(rel)) {
        trackedFiles.push(rel);
      } else if (readFileSync(join(workspaceRoot, rel), 'utf8').trim().length === 0) {
        return false;
      }
    }
    if (trackedFiles.length > 0) {
      const diffRes = await runHardenedGit(
        ['diff', '--no-ext-diff', '--name-only', '-z', baselineCommit, '--', ...trackedFiles],
        { cwd: workspaceRoot, allowNetwork: false },
      );
      if (diffRes.error || diffRes.exitCode !== 0) return false;
      const diffSet = new Set(diffRes.stdout.split('\0').map(normalizeEvidencePath).filter(Boolean));
      for (const rel of trackedFiles) {
        if (!diffSet.has(rel)) return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

function classifyOssJudgeFailure({ historyUntouched, baselineTestsUntampered, implementationPassed, testsPassed, validation }) {
  if (historyUntouched && baselineTestsUntampered && implementationPassed && testsPassed && validation.valid) {
    return 'none';
  }
  if (!historyUntouched || !baselineTestsUntampered) return 'history_tampered';
  if (!implementationPassed || !validation.checks.changedFiles) return 'implementation_failed';
  if (!testsPassed || !validation.checks.testReceiptVerified) return 'test_failed';
  if (validation.status === EVIDENCE_STATUSES.INCOMPLETE) return 'evidence_incomplete';
  if (!validation.checks.independentVerdict) return 'independent_verdict_failed';
  return 'evidence_invalid';
}

function makeOssJudge({ sourceFiles, hiddenAcceptanceScript, extraCheck = null }) {
  return async function ossTaskJudge({ task, output, context = {} }) {
    const workspaceRoot = context.workspaceRoot;
    const pinnedCommit = task.fixture?.commit;
    const acceptance = task.metadata.acceptanceCriteria;
    const baselineTestFiles = task.fixture?.baselineTestFiles ?? [];
    const baselineTestCommand = task.fixture?.baselineTestCommand ?? ['node', '--test', ...baselineTestFiles];

    const activeSandbox = context.sandbox ?? getDefaultBenchmarkSandbox();
    const resolvedBackend = activeSandbox.resolveBackend();
    const sandboxBackend = resolvedBackend?.mode ?? activeSandbox.mode ?? null;

    const isolationMeta = task.metadata?.sandboxIsolation ?? {};
    const allowWorkspaceNodeCli = Boolean(isolationMeta.allowWorkspaceNodeCli);
    const memoryLimitMb = isolationMeta.memoryLimitMb ?? 512;
    const cpuLimitSec = isolationMeta.cpuLimitSec ?? 20;
    const timeoutMs = isolationMeta.timeoutMs ?? 30_000;
    const dependencyPolicy = task.metadata?.dependencyPolicy ?? DEFAULT_DEPENDENCY_POLICY;

    let depCheck = { ok: true, violations: [], dependencyCount: 0, hasLifecycleScripts: false };
    const pkgPath = join(workspaceRoot, 'package.json');
    if (existsSync(pkgPath)) {
      if (!isPathInsideRoot(workspaceRoot, pkgPath, { allowEqual: false })) {
        depCheck = {
          ok: false,
          violations: [{ type: 'symlink_escape', message: 'package.json escapes workspaceRoot' }],
          dependencyCount: 0,
          hasLifecycleScripts: false,
        };
      } else {
        try {
          const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
          depCheck = validatePackageDependencies(pkgJson, dependencyPolicy);
        } catch (err) {
          depCheck = {
            ok: false,
            violations: [{ type: 'invalid_package_json', message: String(err?.message ?? err) }],
            dependencyCount: 0,
            hasLifecycleScripts: false,
          };
        }
      }
    }

    const historyCheck = verifyWorkspacePinnedBaseline(workspaceRoot, pinnedCommit);
    const actualFiles = listWorkspaceChangedFiles(workspaceRoot);
    const [baselineFileCheck, sourceDiffPresent] = await Promise.all([
      checkFilesUnmodifiedSince(workspaceRoot, pinnedCommit, baselineTestFiles),
      historyCheck.ok
        ? hasRealSourceDiff(workspaceRoot, pinnedCommit, sourceFiles, actualFiles)
        : Promise.resolve(false),
    ]);

    let baselineTestExitCode = 1;
    let actualTestExitCode = 1;
    let hiddenResult = {
      passed: false,
      exitCode: 1,
      error: 'skipped_due_to_integrity_or_policy_failure',
    };

    if (historyCheck.ok && baselineFileCheck.ok && depCheck.ok) {
      const [baselineRun, actualRun, hiddenRun] = await Promise.all([
        activeSandbox.execArgv(baselineTestCommand, {
          workspaceRoot,
          cwd: workspaceRoot,
          allowWorkspaceNodeCli,
          dependencyPolicy,
          memoryLimitMb,
          cpuLimitSec,
          timeoutMs,
        }),
        activeSandbox.execArgv(acceptance.testCommand, {
          workspaceRoot,
          cwd: workspaceRoot,
          allowWorkspaceNodeCli,
          dependencyPolicy,
          memoryLimitMb,
          cpuLimitSec,
          timeoutMs,
        }),
        activeSandbox.runHiddenAcceptance({
          workspaceRoot,
          scriptSource: hiddenAcceptanceScript,
          allowWorkspaceNodeCli,
          memoryLimitMb,
          cpuLimitSec,
          timeoutMs,
          extraEnv: { AGENT_US_EVAL_WORKSPACE: workspaceRoot },
        }),
      ]);
      baselineTestExitCode = baselineRun.timedOut ? 124 : baselineRun.exitCode;
      actualTestExitCode = actualRun.timedOut ? 124 : actualRun.exitCode;
      hiddenResult = {
        passed: Boolean(hiddenRun.passed),
        exitCode: hiddenRun.exitCode,
        error: hiddenRun.passed
          ? null
          : String(hiddenRun.stderr || hiddenRun.stdout || 'hidden acceptance test failed').slice(0, 1000),
      };
    }
    const extraChecks = extraCheck ? extraCheck({ workspaceRoot, actualFiles }) : {};
    const extraPassed = Object.values(extraChecks).every(Boolean);

    const validation = validateEvidenceManifest(output, {
      taskId: task.id,
      attemptId: context.attemptId ?? output?.attemptId ?? (context.attempt != null ? `attempt-${context.attempt}` : null),
      planVersion: context.planVersion ?? output?.planVersion ?? 1,
      expectedTestCommand: acceptance.testCommand,
      requiredChangedFiles: acceptance.requiredChangedFiles,
      actualChangedFiles: actualFiles,
      actualTestExitCode,
      toolReceipts: context.toolReceipts ?? output?.toolReceipts ?? null,
      workspaceRoot,
      artifactVerifier: context.artifactVerifier ?? output?.artifactVerifier ?? null,
      trustedVerdict: context.trustedVerdict ?? output?.trustedVerdict ?? null,
      requireIndependentVerdict: true,
    });

    const evidence = validation.manifest ?? {};
    const checks = {
      ...validation.checks,
      historyUntouched: historyCheck.ok,
      baselineTestsUntampered: baselineFileCheck.ok,
      sourceDiffPresent,
      baselineTestsPassed: baselineTestExitCode === 0,
      hiddenAcceptancePassed: hiddenResult.passed,
      sandboxIsolated: true,
      dependencyPolicyPassed: depCheck.ok,
      ...extraChecks,
    };

    const historyUntouched = historyCheck.ok;
    const baselineTestsUntampered = baselineFileCheck.ok;
    const implementationPassed =
      historyUntouched &&
      baselineTestsUntampered &&
      depCheck.ok &&
      sourceDiffPresent &&
      hiddenResult.passed &&
      extraPassed &&
      Boolean(checks.changedFiles);
    const testsPassed =
      baselineTestExitCode === 0 &&
      actualTestExitCode === 0 &&
      hiddenResult.passed &&
      Boolean(checks.testReceiptVerified);
    const evidenceCompliant = Boolean(validation.valid);
    const passed = implementationPassed && testsPassed && evidenceCompliant;
    const failureCategory = classifyOssJudgeFailure({
      historyUntouched,
      baselineTestsUntampered,
      implementationPassed,
      testsPassed,
      validation,
    });

    const errorMessages = [
      ...validation.errors,
      ...(hiddenResult.error ? [hiddenResult.error] : []),
      ...depCheck.violations.map((v) => v.message),
    ];

    return {
      passed,
      score: passed ? 1 : 0,
      deterministic: true,
      reason: passed
        ? 'oss_engineering_acceptance_complete'
        : validation.status === EVIDENCE_STATUSES.INCOMPLETE && implementationPassed && testsPassed
          ? EVIDENCE_STATUSES.INCOMPLETE
          : failureCategory,
      evidence: {
        taskId: task.id,
        schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
        repoUrl: task.fixture?.repoUrl ?? null,
        pinnedCommit,
        baselineCommitObserved: historyCheck.headCommit,
        historyReason: historyCheck.reason,
        tamperedBaselineTestFiles: baselineFileCheck.modified,
        attemptId: evidence.attemptId ?? context.attemptId ?? null,
        planVersion: evidence.planVersion ?? context.planVersion ?? 1,
        manifestStatus: validation.status,
        missingFields: validation.missingFields,
        errors: errorMessages,
        actualChangedFiles: actualFiles,
        reportedChangedFiles: Array.isArray(evidence.changedFiles) ? evidence.changedFiles.map(normalizeEvidencePath) : [],
        actualTestExitCode,
        baselineTestExitCode,
        hiddenAcceptanceExitCode: hiddenResult.exitCode,
        reportedTestExitCode: Number.isInteger(evidence.testExitCode) ? evidence.testExitCode : null,
        expectedTestCommand: acceptance.testCommand,
        reportedTestCommand: evidence.testCommand ?? null,
        implementationPassed,
        testsPassed,
        evidenceCompliant,
        sandboxIsolated: true,
        sandboxBackend,
        dependencyPolicyPassed: depCheck.ok,
        ...(depCheck.violations.length ? { dependencyPolicyViolations: depCheck.violations } : {}),
        independentVerdictSource: validation.independentVerdictSource,
        failureCategory,
        checks,
      },
    };
  };
}

const NANOID_HIDDEN_TEST = `
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: nanoidBatch in index.js and index.browser.js', async () => {
  const nodeMod = await import(pathToFileURL(join(ws, 'index.js')).href);
  const browserMod = await import(pathToFileURL(join(ws, 'index.browser.js')).href);

  for (const mod of [nodeMod, browserMod]) {
    assert.equal(typeof mod.nanoidBatch, 'function');
    assert.deepEqual(mod.nanoidBatch(0), []);
    assert.deepEqual(mod.nanoidBatch(3, 0), ['', '', '']);

    const ids = mod.nanoidBatch(6, 12);
    assert.equal(ids.length, 6);
    assert.equal(new Set(ids).size, 6);
    for (const id of ids) {
      assert.equal(id.length, 12);
      for (const ch of id) assert.ok(mod.urlAlphabet.includes(ch));
    }

    for (const badCount of [-1, 1.5, NaN, '4', 10001]) {
      assert.throws(() => mod.nanoidBatch(badCount), RangeError);
    }
    for (const badSize of [-1, 1.5, '5']) {
      assert.throws(() => mod.nanoidBatch(0, badSize), RangeError);
      assert.throws(() => mod.nanoidBatch(2, badSize), RangeError);
    }
  }
});

test('hidden acceptance: nanoid CLI --count and strict flag validation', () => {
  const bin = join(ws, 'bin', 'nanoid.js');
  const runCli = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: ws, encoding: 'utf8' });

  const batch = runCli(['-c', '4', '-s', '8']);
  assert.equal(batch.status, 0, batch.stderr);
  const lines = batch.stdout.trim().split(/\\r?\\n/);
  assert.equal(lines.length, 4);
  assert.equal(new Set(lines).size, 4);
  for (const line of lines) assert.match(line, /^[A-Za-z0-9_-]{8}$/);

  const custom = runCli(['--count=3', '--alphabet=ab', '--size=6']);
  assert.equal(custom.status, 0, custom.stderr);
  const customLines = custom.stdout.trim().split(/\\r?\\n/);
  assert.equal(customLines.length, 3);
  for (const line of customLines) assert.match(line, /^[ab]{6}$/);

  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage/);
  assert.match(help.stdout, /--count/);

  for (const invalidArgs of [
    ['--count', '0'],
    ['--count', '-2'],
    ['--count', '10001'],
    ['--count', 'abc'],
    ['--count'],
    ['--size'],
    ['--alphabet'],
    ['--alphabet', ''],
  ]) {
    const res = runCli(invalidArgs);
    assert.notEqual(res.status, 0, 'expected non-zero exit for ' + invalidArgs.join(' '));
    assert.ok(res.stderr.trim().length > 0, 'expected stderr message for ' + invalidArgs.join(' '));
  }
});
`;

const TROUGH_HIDDEN_TEST = `
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: trough preserves exports and implements clone, prepend, runAsync', async () => {
  const mod = await import(pathToFileURL(join(ws, 'index.js')).href);
  assert.deepEqual(Object.keys(mod).sort(), ['trough', 'wrap']);

  const base = mod.trough().use((value) => value + 1);
  const branched = base.clone().use((value) => value * 10);

  assert.equal(base.prepend((value) => value * 2), base);
  assert.throws(() => base.prepend('not-a-function'), TypeError);

  assert.equal(await base.runAsync(3), 7);
  assert.equal(await branched.runAsync(3), 40);

  const empty = mod.trough();
  assert.equal(await empty.runAsync(), undefined);
  assert.equal(await empty.runAsync('ok'), 'ok');

  const multi = mod.trough()
    .use((a, b, next) => setTimeout(() => next(null, a + '!', undefined), 5))
    .use(async (a, b) => a + ':' + b);
  assert.deepEqual(await multi.runAsync('hi', 'world'), ['hi!:world', 'world']);

  const syncThrow = mod.trough().use(() => { throw new Error('boom-sync'); });
  await assert.rejects(() => syncThrow.runAsync(1), /boom-sync/);

  const returnedErr = mod.trough().use(() => new Error('boom-ret'));
  await assert.rejects(() => returnedErr.runAsync(1), /boom-ret/);

  const rejectedPromise = mod.trough().use(async () => { throw new Error('boom-async'); });
  await assert.rejects(() => rejectedPromise.runAsync(1), /boom-async/);

  const callbackErr = mod.trough().use((_v, next) => setTimeout(() => next(new Error('boom-cb')), 5));
  await assert.rejects(() => callbackErr.runAsync(1), /boom-cb/);
});
`;

const CONTENT_TYPE_HIDDEN_TEST = `
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;
const require = createRequire(import.meta.url);

test('hidden acceptance: fast-content-type-parse format round-trip and validation', () => {
  const pkg = require(join(ws, 'index.js'));
  assert.equal(typeof pkg.format, 'function');
  assert.equal(typeof pkg.default?.format, 'function');

  assert.equal(pkg.format({ type: 'Text/HTML' }), 'text/html');
  assert.equal(pkg.format({ type: 'application/json', parameters: {} }), 'application/json');

  const sample = 'Text/HTML; Charset="UTF-8"; empty=""; q="a\\\\\\"b"; spaced="foo; bar"';
  const parsed = pkg.parse(sample);
  const formatted = pkg.format(parsed);
  assert.deepEqual(pkg.parse(formatted), parsed);

  const nullProtoParams = Object.create(null);
  nullProtoParams['__proto__'] = 'x';
  nullProtoParams.constructor = 'y';
  nullProtoParams.charset = 'utf-8';
  const npOut = pkg.format({ type: 'text/plain', parameters: nullProtoParams });
  const npParsed = pkg.parse(npOut);
  assert.equal(npParsed.type, 'text/plain');
  assert.equal(Object.getOwnPropertyDescriptor(npParsed.parameters, '__proto__').value, 'x');
  assert.equal(npParsed.parameters.constructor, 'y');
  assert.equal(npParsed.parameters.charset, 'utf-8');

  for (const invalidInput of [
    undefined,
    null,
    'text/plain',
    {},
    pkg.defaultContentType,
    { type: 'text' },
    { type: 'text/html; charset=utf-8' },
    { type: 'text / html' },
    { type: 'text/html', parameters: null },
    { type: 'text/plain', parameters: [] },
    { type: 'text/plain', parameters: { '': '1' } },
    { type: 'text/plain', parameters: { 'bad name': '1' } },
    { type: 'text/plain', parameters: { a: undefined } },
    { type: 'text/plain', parameters: { a: null } },
    { type: 'text/plain', parameters: { a: {} } },
    { type: 'text/plain', parameters: { a: 'bad\\r\\nX-Inject: 1' } },
    { type: 'text/plain', parameters: { a: 'bad\\nval' } },
    { type: 'text/plain', parameters: { a: 'bad\\x7fval' } },
    { type: 'text/plain', parameters: { a: 'bad\\u0100val' } },
  ]) {
    assert.throws(() => pkg.format(invalidInput), TypeError);
  }
});
`;

const NANOEVENTS_HIDDEN_TEST = `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ws = process.env.WORKSPACE_ROOT || process.env.AGENT_US_EVAL_WORKSPACE;

test('hidden acceptance: nanoevents prototype safety, once, and clear', async () => {
  const { createNanoEvents } = await import(pathToFileURL(join(ws, 'index.js')).href);
  const ee = createNanoEvents();
  assert.deepStrictEqual(ee.events, {});

  assert.doesNotThrow(() => ee.emit('toString'));
  assert.doesNotThrow(() => ee.emit('constructor'));
  assert.doesNotThrow(() => ee.emit('__proto__'));

  const seen = [];
  const offProto = ee.on('__proto__', (v) => seen.push('proto:' + v));
  const offToString = ee.on('toString', (v) => seen.push('toString:' + v));
  ee.emit('__proto__', 1);
  ee.emit('toString', 2);
  offProto();
  offToString();
  ee.emit('__proto__', 3);
  ee.emit('toString', 4);
  assert.deepEqual(seen, ['proto:1', 'toString:2']);

  assert.throws(() => ee.on('tick', null), TypeError);
  assert.throws(() => ee.once('tick', 123), TypeError);

  let onceCount = 0;
  ee.once('reenter', (n) => {
    onceCount += n;
    ee.emit('reenter', 100);
  });
  ee.emit('reenter', 5);
  ee.emit('reenter', 7);
  assert.equal(onceCount, 5);

  let canceled = 0;
  const offOnce = ee.once('cancel', () => { canceled += 1; });
  offOnce();
  ee.emit('cancel');
  assert.equal(canceled, 0);

  let a = 0;
  let b = 0;
  ee.on('a', () => { a += 1; });
  ee.on('b', () => { b += 1; });
  ee.clear('a');
  ee.emit('a');
  ee.emit('b');
  assert.equal(a, 0);
  assert.equal(b, 1);

  ee.clear();
  assert.deepStrictEqual(ee.events, {});
  assert.doesNotThrow(() => offOnce());
  ee.emit('b');
  assert.equal(b, 1);

  const dts = readFileSync(join(ws, 'index.d.ts'), 'utf8');
  assert.match(dts, /\\bonce\\b/);
  assert.match(dts, /\\bclear\\b/);
});
`;

function ossMetadata({ id, requiredChangedFiles, testFiles, testCommand, repoFileCount }) {
  return {
    source: OSS_BENCHMARK_ID,
    adapter: 'direct-agent-runtime',
    synthetic: true,
    externalNetwork: false,
    requiresWorkspaceMutation: true,
    requiresGitDiff: true,
    requiresIndependentVerification: true,
    sandboxIsolation: {
      required: true,
      failClosed: true,
      allowWorkspaceNodeCli: id === 'oss-nanoid-batch-cli-01',
      memoryLimitMb: 512,
      cpuLimitSec: 20,
      timeoutMs: 30000,
    },
    dependencyPolicy: { ...DEFAULT_DEPENDENCY_POLICY },
    repoFileCount,
    acceptance: [
      'pinned_commit_history_untouched',
      'baseline_tests_untampered',
      'workspace_changed',
      'baseline_tests_pass',
      'hidden_acceptance_tests_pass',
      'git_diff_captured',
      'independent_verdict',
    ],
    verificationStrategy: 'pinned-oss-repo-and-hidden-behavioral-judge',
    expectedArtifacts: requiredChangedFiles,
    acceptanceCriteria: {
      requiredFiles: requiredChangedFiles,
      requiredChangedFiles,
      testFiles,
      testCommand,
      checks: ['pinned_history_untouched', 'baseline_tests_pass', 'hidden_acceptance_pass'],
    },
  };
}

const RAW_OSS_TASKS = [
  {
    id: 'oss-nanoid-batch-cli-01',
    title: 'ai/nanoid: Batch ID Generation & Strict CLI Flag Validation',
    objective: 'Add validated nanoidBatch(count, size) across Node/browser entrypoints and harden the CLI with --count and missing-argument checks.',
    prompt: [
      'You are working inside a pinned commit of the open-source repository ai/nanoid.',
      'Implement the following changes cleanly without breaking any existing tests:',
      '1. Export `nanoidBatch(count, size = 21)` from both `index.js` and `index.browser.js`:',
      '   - Validate `count` is a finite integer between 0 and 10000 inclusive; throw a `RangeError` otherwise.',
      '   - Validate `size` (default 21) is a non-negative integer (`Number.isInteger(size) && size >= 0`); throw a `RangeError` otherwise (even when `count === 0`).',
      '   - Return an array of `count` IDs generated via `nanoid(size)` using `urlAlphabet`.',
      '2. Update `bin/nanoid.js`:',
      '   - Support `-c, --count <n>` (and `--count=<n>`, `--size=<n>`, `--alphabet=<chars>`) to output `n` newline-separated IDs (default 1; must be integer 1..10000).',
      '   - Reject missing or empty option values (e.g., `--size`, `--alphabet`, `--alphabet ""`, `--count`) and invalid counts with a message on stderr and exit code 1.',
      '   - Update `--help` output to document `-c, --count` while keeping existing Usage header and `--version` output intact.',
      '3. Add unit and CLI tests in `test/batch.test.js` using `node:test` and `node:assert`. Do NOT modify existing `test/*.test.js` files.',
      '4. Run `node --test test/index.test.js test/non-secure.test.js test/pool.test.js test/bin.test.js test/batch.test.js` and return the JSON evidence manifest.',
    ].join('\n'),
    fixture: {
      repoUrl: 'https://github.com/ai/nanoid.git',
      commit: '055d1700cc67ac843e3efb5235d806b419ec7b2b',
      license: 'MIT',
      repoSlug: 'ai/nanoid',
      baselineTestFiles: ['test/index.test.js', 'test/non-secure.test.js', 'test/pool.test.js', 'test/bin.test.js'],
      baselineTestCommand: ['node', '--test', 'test/index.test.js', 'test/non-secure.test.js', 'test/pool.test.js', 'test/bin.test.js'],
    },
    judge: makeOssJudge({
      sourceFiles: ['index.js', 'index.browser.js', 'bin/nanoid.js', 'test/batch.test.js'],
      hiddenAcceptanceScript: NANOID_HIDDEN_TEST,
    }),
    metadata: ossMetadata({
      id: 'oss-nanoid-batch-cli-01',
      requiredChangedFiles: ['index.js', 'index.browser.js', 'bin/nanoid.js', 'test/batch.test.js'],
      testFiles: ['test/index.test.js', 'test/non-secure.test.js', 'test/pool.test.js', 'test/bin.test.js', 'test/batch.test.js'],
      testCommand: ['node', '--test', 'test/index.test.js', 'test/non-secure.test.js', 'test/pool.test.js', 'test/bin.test.js', 'test/batch.test.js'],
      repoFileCount: 16,
    }),
  },
  {
    id: 'oss-trough-pipeline-01',
    title: 'wooorm/trough: Pipeline clone, prepend, and runAsync',
    objective: 'Extend trough() pipelines with independent cloning, middleware prepending, and Promise-based runAsync execution while keeping top-level exports unchanged.',
    prompt: [
      'You are working inside a pinned commit of the open-source repository wooorm/trough.',
      'Implement the following features in `lib/index.js` while keeping top-level module exports of `index.js` strictly `[\'trough\', \'wrap\']` and keeping all baseline tests green:',
      '1. `pipeline.clone()`: return a new independent pipeline initialized with a shallow copy of the current middleware chain so subsequent `.use()` or `.prepend()` calls do not mutate the other pipeline.',
      '2. `pipeline.prepend(fn)`: validate `typeof fn === \'function\'` (throwing `TypeError` otherwise), insert `fn` at the front of the middleware chain, and return `pipeline` for chaining.',
      '3. `pipeline.runAsync(...values)`: run the pipeline without a callback and return a `Promise` that rejects on any thrown/returned/rejected/callback error, resolves to the primary output value (`output[0]`) when `values.length <= 1`, and resolves to the full output array when `values.length > 1`, preserving `trough` non-nullish value merging semantics.',
      '4. Add tests in `test/extensions.test.js` using `node:test` and `node:assert/strict`. Do NOT modify `test.js`.',
      '5. Run `node --test test.js test/extensions.test.js` and return the JSON evidence manifest.',
    ].join('\n'),
    fixture: {
      repoUrl: 'https://github.com/wooorm/trough.git',
      commit: 'f5b7dbf722a7df379d0247a6ab07bd41d0db376d',
      license: 'MIT',
      repoSlug: 'wooorm/trough',
      baselineTestFiles: ['test.js'],
      baselineTestCommand: ['node', '--test', 'test.js'],
    },
    judge: makeOssJudge({
      sourceFiles: ['lib/index.js', 'test/extensions.test.js'],
      hiddenAcceptanceScript: TROUGH_HIDDEN_TEST,
    }),
    metadata: ossMetadata({
      id: 'oss-trough-pipeline-01',
      requiredChangedFiles: ['lib/index.js', 'test/extensions.test.js'],
      testFiles: ['test.js', 'test/extensions.test.js'],
      testCommand: ['node', '--test', 'test.js', 'test/extensions.test.js'],
      repoFileCount: 6,
    }),
  },
  {
    id: 'oss-content-type-format-01',
    title: 'fastify/fast-content-type-parse: RFC 9110 Content-Type Formatter',
    objective: 'Implement strict RFC 9110 format({ type, parameters }) serialization with quoted-string escaping, token validation, and null-prototype safety.',
    prompt: [
      'You are working inside a pinned commit of the open-source repository fastify/fast-content-type-parse.',
      'Implement and export `format(contentType)` on both `module.exports.format` and `module.exports.default.format` in `index.js`:',
      '1. Validate `contentType` is a non-null non-array object with a valid RFC 9110 `type` (`token "/" token`, no OWS or extra slashes), normalizing `type` to lowercase. Throw `TypeError` otherwise.',
      '2. When `contentType.parameters` is provided (not `undefined`), validate it is a non-null non-array object (supporting `Object.create(null)` objects without `Object.prototype` methods); throw `TypeError` otherwise.',
      '3. Iterate own enumerable parameter keys, lowercase and validate each parameter name as a non-empty RFC 9110 `token` (`tchar+`), keeping the first occurrence on case-insensitive duplicates.',
      '4. Validate each parameter value is a string, number, or boolean; convert to string and verify every character conforms to RFC 9110 `qdtext` / `quoted-pair` octets (rejecting CR, LF, DEL, invalid control chars, and code points > 0xff with `TypeError`).',
      '5. Emit `name=value` unquoted when `value` is a non-empty RFC 9110 `token`; otherwise emit a properly escaped `quoted-string` (`\\\\` and `\\"`) joined with `; `.',
      '6. Add tests in `test/format.test.js` using `node:test`. Do NOT modify `test/index.test.js`.',
      '7. Run `node --test test/index.test.js test/format.test.js` and return the JSON evidence manifest.',
    ].join('\n'),
    fixture: {
      repoUrl: 'https://github.com/fastify/fast-content-type-parse.git',
      commit: '12db742b88a4e8ca6ceb26c8dce3acd828a27868',
      license: 'MIT',
      repoSlug: 'fastify/fast-content-type-parse',
      baselineTestFiles: ['test/index.test.js'],
      baselineTestCommand: ['node', '--test', 'test/index.test.js'],
    },
    judge: makeOssJudge({
      sourceFiles: ['index.js', 'test/format.test.js'],
      hiddenAcceptanceScript: CONTENT_TYPE_HIDDEN_TEST,
    }),
    metadata: ossMetadata({
      id: 'oss-content-type-format-01',
      requiredChangedFiles: ['index.js', 'test/format.test.js'],
      testFiles: ['test/index.test.js', 'test/format.test.js'],
      testCommand: ['node', '--test', 'test/index.test.js', 'test/format.test.js'],
      repoFileCount: 6,
    }),
  },
  {
    id: 'oss-nanoevents-hardening-01',
    title: 'ai/nanoevents: Prototype Collision Guard, once(), and clear()',
    objective: 'Fix Object.prototype collision bugs in createNanoEvents() and add callback validation, once(), and clear() with updated TypeScript definitions.',
    prompt: [
      'You are working inside a pinned commit of the open-source repository ai/nanoevents.',
      'Implement the following fixes and features in `index.js` and `index.d.ts` while preserving `events: {}` plain-object semantics and dynamic `this.events` lookup:',
      '1. Fix prototype property collisions so event names such as `toString`, `constructor`, `valueOf`, `hasOwnProperty`, and `__proto__` work safely via own-property checks without invoking or mutating `Object.prototype`.',
      '2. Validate that listener arguments passed to `on(event, cb)` and `once(event, cb)` are functions (throw `TypeError` otherwise).',
      '3. Add `once(event, cb)` (invokes at most once even under re-entrant `emit`, returns an idempotent `unbind()` safe to call even after `events` is cleared) and `clear(event?)` (clears a single own event when provided, or resets `this.events = {}` when omitted).',
      '4. Update `index.d.ts` to declare `once` and `clear` on `Emitter`.',
      '5. Add tests in `test/hardening.test.ts` using `node:test` and `node:assert`. Do NOT modify `test/index.test.ts`.',
      '6. Run `node --test test/index.test.ts test/hardening.test.ts` and return the JSON evidence manifest.',
    ].join('\n'),
    fixture: {
      repoUrl: 'https://github.com/ai/nanoevents.git',
      commit: '081aa8995d82321b8d5d4bb64f97d63cb04380d7',
      license: 'MIT',
      repoSlug: 'ai/nanoevents',
      baselineTestFiles: ['test/index.test.ts'],
      baselineTestCommand: ['node', '--test', 'test/index.test.ts'],
    },
    judge: makeOssJudge({
      sourceFiles: ['index.js', 'index.d.ts', 'test/hardening.test.ts'],
      hiddenAcceptanceScript: NANOEVENTS_HIDDEN_TEST,
    }),
    metadata: ossMetadata({
      id: 'oss-nanoevents-hardening-01',
      requiredChangedFiles: ['index.js', 'index.d.ts', 'test/hardening.test.ts'],
      testFiles: ['test/index.test.ts', 'test/hardening.test.ts'],
      testCommand: ['node', '--test', 'test/index.test.ts', 'test/hardening.test.ts'],
      repoFileCount: 8,
    }),
  },
];

function finalizeOssTask(rawTask, override = null, datasetSandbox = null) {
  const budgetPlan = estimateTaskBudget({
    taskType: rawTask.id,
    fileCount: rawTask.metadata.repoFileCount ?? 8,
    requiredTools: ['read_file', 'write_file', 'edit_file', 'bash'],
    expectedArtifacts: rawTask.metadata.expectedArtifacts,
    verificationComplexity: 'high',
    recoveryRequirements: false,
  });
  const resourceBudget = {
    maxSteps: Math.max(20, budgetPlan.maxSteps),
    maxTokens: budgetPlan.estimatedTokens,
    finalVerificationReserve: budgetPlan.finalVerificationReserve,
    maxDurationMs: Math.max(60_000, budgetPlan.maxSteps * 5_000),
    breakdown: {
      planningSteps: budgetPlan.planningSteps,
      researchSteps: budgetPlan.researchSteps,
      implementationSteps: budgetPlan.implementationSteps,
      testingSteps: budgetPlan.testingSteps,
      reviewSteps: budgetPlan.reviewSteps,
      repairReserve: budgetPlan.repairReserve,
      finalVerificationReserve: budgetPlan.finalVerificationReserve,
    },
    suggestedStages: budgetPlan.suggestedStages,
  };
  const baseFixture = structuredClone(rawTask.fixture);
  const baseMetadata = structuredClone(rawTask.metadata);
  const fixture = {
    ...baseFixture,
    ...(override?.repoUrl ? { repoUrl: override.repoUrl } : {}),
    ...(override?.commit ? { commit: override.commit } : {}),
    ...(override?.cacheDir ? { cacheDir: override.cacheDir } : {}),
  };
  return {
    ...rawTask,
    judge: ({ task, output, context = {} }) =>
      rawTask.judge({
        task,
        output,
        context: context?.sandbox || !datasetSandbox ? context : { ...context, sandbox: datasetSandbox },
      }),
    fixture,
    prompt: `${rawTask.prompt}\n\n${formatEvidenceManifestContract({
      taskId: rawTask.id,
      attemptId: 'attempt-1',
      planVersion: 1,
      testCommand: baseMetadata.acceptanceCriteria.testCommand,
      requiredChangedFiles: baseMetadata.acceptanceCriteria.requiredChangedFiles,
    })}`,
    resourceBudget,
    metadata: {
      ...baseMetadata,
      resourceBudget,
    },
    category: 'real-oss-engineering',
    difficulty: 'hard',
    tags: ['benchmark', 'oss', rawTask.fixture.repoSlug.replace('/', '-')],
    expected: {
      output: {
        taskId: rawTask.id,
        evidenceRequired: true,
        schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
      },
    },
  };
}

export function createOssBenchmarkDataset({
  repoOverrides = null,
  sandbox = null,
  sandboxOptions = null,
} = {}) {
  const datasetSandbox =
    sandbox ?? (sandboxOptions ? new BenchmarkSandbox(sandboxOptions) : getDefaultBenchmarkSandbox());
  return RAW_OSS_TASKS.map((task) => {
    const override = repoOverrides && typeof repoOverrides === 'object' ? repoOverrides[task.id] ?? null : null;
    return finalizeOssTask(task, override, datasetSandbox);
  });
}

export const OSS_BENCHMARK_DATASET = Object.freeze(createOssBenchmarkDataset());
