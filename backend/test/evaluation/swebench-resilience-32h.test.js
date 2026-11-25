import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PrefixBlockCacheSimulatorAdapter,
  cleanPythonTestCaches,
  createDryRunRepository,
  extractInstanceGitDiff,
  isFatalBenchmarkConfigError,
  runSweBenchBenchmark,
  runSweBenchInstanceArm,
  safeRmRf,
} from '../../scripts/benchmark-swebench.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = resolve(TEST_DIR, '..', '..');
const SCRIPT_PATH = resolve(BACKEND_DIR, 'scripts', 'benchmark-swebench.mjs');

const tempDirs = [];
function makeTmp(prefix) {
  const dir = (realpathSync.native ?? realpathSync)(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      safeRmRf(dir);
    } catch {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors in test teardown
      }
    }
  }
});

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

function createSampleGitRepo(prefix = 'swe-resilience-repo-') {
  const repoDir = makeTmp(prefix);
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  mkdirSync(join(repoDir, 'tests'), { recursive: true });
  writeFileSync(
    join(repoDir, 'src', 'app.py'),
    'def add(a, b):\n    return a - b\n',
    'utf8',
  );
  writeFileSync(
    join(repoDir, 'tests', 'test_app.py'),
    'from src.app import add\n\ndef test_add():\n    assert add(1, 2) == 3\n',
    'utf8',
  );
  runGit(repoDir, ['init', '-q']);
  runGit(repoDir, ['config', 'user.name', 'Test']);
  runGit(repoDir, ['config', 'user.email', 'test@example.invalid']);
  runGit(repoDir, ['add', '-A']);
  runGit(repoDir, ['commit', '-qm', 'initial']);
  const baseCommit = runGit(repoDir, ['rev-parse', 'HEAD']);
  return { repoDir, baseCommit };
}

describe('SWE-bench runner resilience & progress telemetry (3.2h)', () => {
  test('cleanPythonTestCaches ignores EACCES/walk errors and never aborts extractInstanceGitDiff', async () => {
    const { repoDir, baseCommit } = createSampleGitRepo('swe-res-eacces-');

    mkdirSync(join(repoDir, 'src', '__pycache__'), { recursive: true });
    writeFileSync(join(repoDir, 'src', '__pycache__', 'app.cpython-312.pyc'), 'pyc', 'utf8');
    mkdirSync(join(repoDir, '.pytest_cache', 'v', 'cache'), { recursive: true });
    writeFileSync(join(repoDir, '.pytest_cache', 'v', 'cache', 'lastfailed'), '{}', 'utf8');
    writeFileSync(join(repoDir, 'orphan.pyc'), 'pyc', 'utf8');

    writeFileSync(
      join(repoDir, 'src', 'app.py'),
      'def add(a, b):\n    return a + b\n',
      'utf8',
    );

    const attemptedRmPaths = [];
    assert.doesNotThrow(() => {
      cleanPythonTestCaches(repoDir, {
        rmFn: (target) => {
          attemptedRmPaths.push(target);
          throw Object.assign(new Error(`EACCES: permission denied, unlink '${target}'`), {
            code: 'EACCES',
          });
        },
      });
    });
    assert.ok(attemptedRmPaths.length >= 3, 'Expected rmFn to be attempted on cache directories/files');

    assert.doesNotThrow(() => {
      cleanPythonTestCaches(null);
    });

    const { patch, changedFiles } = await extractInstanceGitDiff(repoDir, baseCommit);
    assert.deepEqual(changedFiles, ['src/app.py']);
    assert.match(patch, /diff --git a\/src\/app\.py b\/src\/app\.py/);
    assert.match(patch, /\+    return a \+ b/);
    assert.equal(patch.includes('__pycache__'), false);
    assert.equal(patch.includes('.pytest_cache'), false);
    assert.equal(patch.includes('orphan.pyc'), false);
  });

  test('runSweBenchInstanceArm calls repairHostWorkspacePermissions() before extractInstanceGitDiff() and destroy(), and stubborn files never crash cleanup', async () => {
    const dry = createDryRunRepository({ baseDir: makeTmp('swe-res-order-base-') });
    const repoDir = dry.repoDir;
    const baseCommit = dry.baseCommit;
    const order = [];

    const result = await runSweBenchInstanceArm({
      instance: {
        ...dry.instance,
        instance_id: 'acme__order-1',
        repo: 'acme/order',
      },
      arm: 'raw_full',
      workspaceRoot: repoDir,
      opts: {
        dryRun: false,
        dockerPreset: 'epoch',
        pull: 'missing',
        containerMemory: '2g',
        maxSteps: 10,
        turnTimeoutMs: 10_000,
      },
      adapter: new PrefixBlockCacheSimulatorAdapter(),
      runtimeDeps: {
        scrubAntiCheatGitRefs: async () => {},
        createDockerAdapter: ({ workspaceRoot }) => {
          const obj = {
            isSweBenchContainer: true,
            workspaceRoot,
            start: async () => 'cid-order-1',
            exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }),
            run: async () => ({ exitCode: 0, stdout: '1 passed\n', stderr: '', timedOut: false }),
            repairHostWorkspacePermissions: async () => {
              order.push('repairHostWorkspacePermissions');
              // Simulate a read-only cache file inside workspace that safeRmRf must tolerate
              const roDir = join(workspaceRoot, '__pycache__');
              mkdirSync(roDir, { recursive: true });
              const roFile = join(roDir, 'stubborn.pyc');
              writeFileSync(roFile, 'x', 'utf8');
              chmodSync(roFile, 0o444);
            },
            destroy: async () => {
              order.push('destroy');
            },
          };
          obj.resolveBackend = () => ({ mode: 'docker', tier: 'strong-os-isolation', backend: obj });
          return obj;
        },
        extractInstanceGitDiff: async (ws, base) => {
          order.push('extractInstanceGitDiff');
          return extractInstanceGitDiff(ws, base);
        },
      },
    });

    assert.equal(result.telemetry.status, 'completed');
    assert.deepEqual(order, [
      'repairHostWorkspacePermissions',
      'extractInstanceGitDiff',
      'destroy',
    ]);

    // Also verify read-only nested armWs/evalWs cleanup via safeRmRf does not throw
    const stubbornDir = makeTmp('swe-res-stubborn-');
    const nested = join(stubbornDir, 'nested', '__pycache__');
    mkdirSync(nested, { recursive: true });
    const roFile = join(nested, 'locked.pyc');
    writeFileSync(roFile, 'data', 'utf8');
    chmodSync(roFile, 0o444);
    assert.doesNotThrow(() => safeRmRf(stubbornDir));
    assert.equal(existsSync(stubbornDir), false);
  });

  test('per-instance runtime error and evaluation error isolate to env_error and continue shard while fatal config errors reject', async () => {
    const dry = createDryRunRepository({ baseDir: makeTmp('swe-res-iso-base-') });
    const repoDir = dry.repoDir;
    const baseCommit = dry.baseCommit;
    const dsDir = makeTmp('swe-res-ds-');
    const dsPath = join(dsDir, 'dataset.jsonl');
    const instances = [
      {
        ...dry.instance,
        instance_id: 'acme__iso-01',
        repo: 'acme/iso',
        workspace_path: repoDir,
      },
      {
        ...dry.instance,
        instance_id: 'acme__iso-02',
        repo: 'acme/iso',
        workspace_path: repoDir,
      },
    ];
    writeFileSync(dsPath, instances.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    // 1. Arm runtime crash (TypeError) on instance 1 -> env_error + [INSTANCE-ERROR], instance 2 succeeds
    const out1 = makeTmp('swe-res-out1-');
    const warns1 = [];
    const logs1 = [];
    let callIdx = 0;
    const res1 = await runSweBenchBenchmark(
      {
        dataset: dsPath,
        arms: ['raw_full'],
        outputDir: out1,
        shard: '1/1',
      },
      {
        createAdapter: () => new PrefixBlockCacheSimulatorAdapter(),
        extractInstanceGitDiff: async (ws, base) => {
          callIdx += 1;
          if (callIdx === 1) {
            throw new TypeError('Cannot read properties of undefined (reading patch)');
          }
          return extractInstanceGitDiff(ws, base);
        },
        warn: (msg) => warns1.push(String(msg)),
        log: (msg) => logs1.push(String(msg)),
      },
    );

    assert.equal(res1.telemetryByArm.raw_full.length, 2);
    assert.equal(res1.telemetryByArm.raw_full[0].instance_id, 'acme__iso-01');
    assert.equal(res1.telemetryByArm.raw_full[0].status, 'env_error');
    assert.equal(res1.telemetryByArm.raw_full[1].instance_id, 'acme__iso-02');
    assert.equal(res1.telemetryByArm.raw_full[1].status, 'completed');
    assert.equal(
      warns1.some((w) => w.includes('[INSTANCE-ERROR]') && w.includes('instance=acme__iso-01') && w.includes('arm=raw_full')),
      true,
    );
    assert.equal(
      logs1.some((l) => l.includes('[SWE-PROGRESS] shard=1/1 idx=1/2 instance=acme__iso-01 arm=raw_full status=env_error')),
      true,
    );
    assert.equal(
      logs1.some((l) => l.includes('[SWE-PROGRESS] shard=1/1 idx=2/2 instance=acme__iso-02 arm=raw_full status=completed')),
      true,
    );

    // 2. Evaluation crash (EACCES) on instance 1 -> eval reason=env_error + [INSTANCE-ERROR], instance 2 evaluates & resolves
    const out2 = makeTmp('swe-res-out2-');
    const warns2 = [];
    const logs2 = [];
    const res2 = await runSweBenchBenchmark(
      {
        dataset: dsPath,
        arms: ['raw_full'],
        outputDir: out2,
        evaluate: true,
        dockerPreset: 'epoch',
        cleanupImages: false,
        shard: '1/1',
      },
      {
        extractTestbedFromImage: async ({ targetDir }) => {
          const { cpSync } = await import('node:fs');
          cpSync(repoDir, targetDir, { recursive: true });
          return { targetDir, headCommit: baseCommit };
        },
        createDockerAdapter: ({ workspaceRoot }) => {
          const obj = {
            isSweBenchContainer: true,
            workspaceRoot,
            start: async () => 'cid-eval-iso',
            exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
            run: async () => ({ exitCode: 0, stdout: '1 passed\n', stderr: '' }),
            repairHostWorkspacePermissions: async () => {},
            destroy: async () => {},
          };
          obj.resolveBackend = () => ({ mode: 'docker', tier: 'strong-os-isolation', backend: obj });
          return obj;
        },
        createAdapter: () => new PrefixBlockCacheSimulatorAdapter(),
        evaluateSweBenchPredictions: async ({ instances: evalInsts }) => {
          const inst = evalInsts[0];
          if (inst.instance_id === 'acme__iso-01') {
            throw Object.assign(new Error('EACCES: eval container permission denied'), { code: 'EACCES' });
          }
          return {
            results: [{ instance_id: inst.instance_id, resolved: true, reason: 'passed' }],
          };
        },
        warn: (msg) => warns2.push(String(msg)),
        log: (msg) => logs2.push(String(msg)),
      },
    );

    assert.equal(res2.evalByArm.raw_full.evaluatedCount, 2);
    assert.equal(res2.evalByArm.raw_full.resolvedCount, 1);
    const evalRow1 = res2.evalByArm.raw_full.results.find((r) => r.instance_id === 'acme__iso-01');
    const evalRow2 = res2.evalByArm.raw_full.results.find((r) => r.instance_id === 'acme__iso-02');
    assert.equal(evalRow1?.resolved, false);
    assert.equal(evalRow1?.reason, 'env_error');
    assert.equal(evalRow2?.resolved, true);
    assert.equal(
      warns2.some((w) => w.includes('[INSTANCE-ERROR]') && w.includes('instance=acme__iso-01') && w.includes('stage=evaluate')),
      true,
    );
    assert.equal(
      logs2.some((l) => l.includes('[SWE-EVAL] shard=1/1 idx=1/2 instance=acme__iso-01 arm=raw_full resolved=false reason=env_error')),
      true,
    );
    assert.equal(
      logs2.some((l) => l.includes('[SWE-EVAL] shard=1/1 idx=2/2 instance=acme__iso-02 arm=raw_full resolved=true reason=passed')),
      true,
    );
    const persistedEval = readFileSync(join(out2, 'eval.raw_full.jsonl'), 'utf8');
    assert.match(persistedEval, /"reason":"env_error"/);
    const persistedSummary = readFileSync(join(out2, 'summary.md'), 'utf8');
    assert.match(persistedSummary, /acme__iso-01/);

    // 3. Fatal config error check & missing-API-key rejection
    assert.equal(isFatalBenchmarkConfigError(new TypeError('bad field')), false);
    assert.equal(isFatalBenchmarkConfigError(Object.assign(new Error('anything'), { isFatalConfigError: true })), true);
    assert.equal(isFatalBenchmarkConfigError(new Error('Live SWE-bench execution requires an enabled App Pool account')), true);
    assert.equal(isFatalBenchmarkConfigError(new Error('No App AccountPool database (engine.sqlite) found')), true);
    assert.equal(isFatalBenchmarkConfigError(new Error('All 2 enabled App Pool account(s) matched --exclude-accounts')), true);

    await assert.rejects(
      () =>
        runSweBenchBenchmark(
          {
            dataset: dsPath,
            arms: ['raw_full'],
            outputDir: makeTmp('swe-res-nokey-'),
            useAppPool: false,
          },
          { env: {} },
        ),
      /Live SWE-bench execution requires/,
    );
  });

  test('--json keeps stdout pure JSON while routing [SWE-PROGRESS] to stderr', () => {
    const outDir = makeTmp('swe-res-json-');
    const proc = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--dry-run', '--arms', 'raw_full', '--output-dir', outDir, '--json'],
      { cwd: BACKEND_DIR, encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(proc.status, 0, `dry-run --json failed (${proc.status}): ${proc.stderr}`);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.instancesCount, 1);
    assert.equal(proc.stdout.includes('[SWE-PROGRESS]'), false);
    assert.match(proc.stderr, /\[SWE-PROGRESS\] idx=1\/1 instance=dryrun__discounts-calculator-01 arm=raw_full status=completed/);
  });
});
