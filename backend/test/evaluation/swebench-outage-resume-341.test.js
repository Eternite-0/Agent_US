import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { Store } from '../../src/store.js';
import {
  extractTurnTelemetryRow,
  isRetryableOutageTelemetry,
  loadCompletedInstanceIds,
  runSweBenchBenchmark,
} from '../../scripts/benchmark-swebench.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = resolve(TEST_DIR, '..', '..');
const EVIDENCE_MINI50_DIR = resolve(BACKEND_DIR, 'docs', 'evidence', 'swebench-mini50');

function writeJsonl(filePath, rows) {
  mkdirSync(dirname(filePath), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

function seedSimpleRepo(repoDir) {
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'app.py'), 'def add(a, b):\n    return a - b\n', 'utf8');
  runGit(repoDir, ['init', '-q']);
  runGit(repoDir, ['config', 'user.email', 'outage341@agent-us.invalid']);
  runGit(repoDir, ['config', 'user.name', 'Outage Resume 341']);
  runGit(repoDir, ['config', 'core.autocrlf', 'false']);
  runGit(repoDir, ['add', '-A']);
  runGit(repoDir, ['commit', '-qm', 'init']);
  return runGit(repoDir, ['rev-parse', 'HEAD']);
}

function makeTelemetryRow(id, arm, overrides = {}) {
  return {
    instance_id: id,
    arm,
    model: 'deepseek-v4.1-flash',
    status: 'completed',
    wallClockMs: 500,
    steps: 5,
    inputTokens: 1500,
    outputTokens: 120,
    totalTokens: 1620,
    cacheReadTokens: 1000,
    cacheWriteTokens: 500,
    cacheEligibleInputTokens: 1500,
    cacheStatus: 'available',
    cacheHitRate: 0.6667,
    nonEmptyPatch: true,
    admissionOriginalTokens: 0,
    admissionInjectedTokens: 0,
    admissionSavedTokens: 0,
    admissionTokenReductionRate: 0,
    epochTransitions: 0,
    error: null,
    timestamp: '2026-11-26T00:00:00.000Z',
    ...overrides,
  };
}

function seedTurnInStore(store, { sessionId, turnId, inputTokens, error, state = 'failed' }) {
  const now = Date.now();
  store.db
    .prepare(
      "INSERT INTO direct_sessions(id, title, model, permissionMode, state, createdAt, updatedAt) VALUES(?, 't', 'deepseek-v4.1-flash', 'auto-safe', 'failed', ?, ?)",
    )
    .run(sessionId, now, now);
  store.db
    .prepare(
      "INSERT INTO direct_turns(id, sessionId, input, model, state, phase, step, inputTokens, outputTokens, durationMs, error, createdAt, finishedAt) VALUES(?, ?, 'fix bug', 'deepseek-v4.1-flash', ?, ?, 1, ?, 0, 50, ?, ?, ?)",
    )
    .run(turnId, sessionId, state, state, inputTokens, error, now, now);
  store.db
    .prepare(
      "INSERT INTO direct_events(sessionId, turnId, type, data, at) VALUES(?, ?, 'turn/failed', ?, ?)",
    )
    .run(
      sessionId,
      turnId,
      JSON.stringify({ turnId, sessionId, inputTokens, outputTokens: 0, steps: 1 }),
      now,
    );
}

describe('SWE-bench 3.4.1 Outage Resume Classification & Evidence Pruning', () => {
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

  test('extractTurnTelemetryRow classifies PROVIDER_UNAVAILABLE / RATE_LIMITED with empty patch or 0 inputTokens as env_error while keeping FABRICATED_PASS_CLAIM as failed', () => {
    const dir = makeTmp('swe-341-extract-');
    const store = new Store(join(dir, 'extract.sqlite'));
    try {
      seedTurnInStore(store, {
        sessionId: 's-prov-empty',
        turnId: 't-prov-empty',
        inputTokens: 800,
        error: 'PROVIDER_UNAVAILABLE: upstream 503',
      });
      const rowProvEmpty = extractTurnTelemetryRow({
        store,
        turnId: 't-prov-empty',
        sessionId: 's-prov-empty',
        instance: { instance_id: 'django__django-1' },
        arm: 'raw_full',
        modelName: 'deepseek-v4.1-flash',
        wallClockMs: 50,
        modelPatch: '',
        turnRow: { state: 'failed', inputTokens: 800, outputTokens: 0, error: 'PROVIDER_UNAVAILABLE: upstream 503' },
      });
      assert.equal(rowProvEmpty.status, 'env_error');
      assert.match(rowProvEmpty.error, /PROVIDER_UNAVAILABLE/);

      seedTurnInStore(store, {
        sessionId: 's-rate-zero',
        turnId: 't-rate-zero',
        inputTokens: 0,
        error: 'RATE_LIMITED: 429 too many requests',
      });
      const rowRateZeroTok = extractTurnTelemetryRow({
        store,
        turnId: 't-rate-zero',
        sessionId: 's-rate-zero',
        instance: { instance_id: 'django__django-2' },
        arm: 'full_aci',
        modelName: 'deepseek-v4.1-flash',
        wallClockMs: 40,
        modelPatch: 'diff --git a/a.py b/a.py\n',
        turnRow: { state: 'failed', inputTokens: 0, outputTokens: 0, error: 'RATE_LIMITED: 429 too many requests' },
      });
      assert.equal(rowRateZeroTok.status, 'env_error');

      seedTurnInStore(store, {
        sessionId: 's-prov-partial',
        turnId: 't-prov-partial',
        inputTokens: 1200,
        error: 'PROVIDER_UNAVAILABLE',
      });
      const rowProvWithPatchAndTokens = extractTurnTelemetryRow({
        store,
        turnId: 't-prov-partial',
        sessionId: 's-prov-partial',
        instance: { instance_id: 'django__django-3' },
        arm: 'raw_full',
        modelName: 'deepseek-v4.1-flash',
        wallClockMs: 90,
        modelPatch: 'diff --git a/a.py b/a.py\n',
        turnRow: { state: 'failed', inputTokens: 1200, outputTokens: 50, error: 'PROVIDER_UNAVAILABLE' },
      });
      assert.equal(rowProvWithPatchAndTokens.status, 'failed');

      seedTurnInStore(store, {
        sessionId: 's-fab',
        turnId: 't-fab',
        inputTokens: 0,
        error: 'FABRICATED_PASS_CLAIM: validation failed',
      });
      const rowFabricated = extractTurnTelemetryRow({
        store,
        turnId: 't-fab',
        sessionId: 's-fab',
        instance: { instance_id: 'django__django-4' },
        arm: 'raw_full',
        modelName: 'deepseek-v4.1-flash',
        wallClockMs: 70,
        modelPatch: '',
        turnRow: { state: 'failed', inputTokens: 0, outputTokens: 0, error: 'FABRICATED_PASS_CLAIM: validation failed' },
      });
      assert.equal(rowFabricated.status, 'failed');
    } finally {
      store.close();
    }
  });

  test('isRetryableOutageTelemetry and loadCompletedInstanceIds handle outage rows based on eval.<arm>.jsonl resolved status', () => {
    assert.equal(isRetryableOutageTelemetry(null), false);
    assert.equal(isRetryableOutageTelemetry({ status: 'env_error', error: null }), true);
    assert.equal(isRetryableOutageTelemetry({ status: 'failed', error: 'PROVIDER_UNAVAILABLE' }, null), true);
    assert.equal(isRetryableOutageTelemetry({ status: 'failed', error: 'RATE_LIMITED' }, { resolved: false }), true);
    assert.equal(isRetryableOutageTelemetry({ status: 'failed', error: 'PROVIDER_UNAVAILABLE' }, { resolved: true }), false);
    assert.equal(isRetryableOutageTelemetry({ status: 'failed', error: 'FABRICATED_PASS_CLAIM' }, { resolved: false }), false);

    // 1. eval.<arm>.jsonl missing -> PROVIDER_UNAVAILABLE / RATE_LIMITED excluded even with non-empty model_patch
    const dirMissingEval = makeTmp('swe-341-noeval-');
    writeJsonl(join(dirMissingEval, 'predictions.raw_full.jsonl'), [
      { instance_id: 'id__clean', model_name_or_path: 'm', model_patch: 'diff-1' },
      { instance_id: 'id__prov', model_name_or_path: 'm', model_patch: 'diff-2' },
      { instance_id: 'id__rate', model_name_or_path: 'm', model_patch: 'diff-3' },
    ]);
    writeJsonl(join(dirMissingEval, 'telemetry.raw_full.jsonl'), [
      makeTelemetryRow('id__clean', 'raw_full', { status: 'completed', error: null }),
      makeTelemetryRow('id__prov', 'raw_full', { status: 'failed', error: 'PROVIDER_UNAVAILABLE' }),
      makeTelemetryRow('id__rate', 'raw_full', { status: 'failed', error: 'RATE_LIMITED' }),
    ]);
    const resMissingEval = loadCompletedInstanceIds(dirMissingEval, 'raw_full');
    assert.deepEqual([...resMissingEval.completedIds], ['id__clean']);

    // 2. eval.<arm>.jsonl present: resolved=false excluded, resolved=true included
    writeJsonl(join(dirMissingEval, 'eval.raw_full.jsonl'), [
      { instance_id: 'id__clean', resolved: false, reason: 'failed_tests' },
      { instance_id: 'id__prov', resolved: false, reason: 'failed_tests' },
      { instance_id: 'id__rate', resolved: true, reason: 'resolved' },
    ]);
    const resWithEval = loadCompletedInstanceIds(dirMissingEval, 'raw_full');
    assert.deepEqual([...resWithEval.completedIds].sort(), ['id__clean', 'id__rate']);
  });

  test('Real repo check: loadCompletedInstanceIds on backend/docs/evidence/swebench-mini50 returns 49, 49, 50, 50', () => {
    assert.equal(loadCompletedInstanceIds(EVIDENCE_MINI50_DIR, 'raw_full').completedIds.size, 49);
    assert.equal(loadCompletedInstanceIds(EVIDENCE_MINI50_DIR, 'full_aci').completedIds.size, 49);
    assert.equal(loadCompletedInstanceIds(EVIDENCE_MINI50_DIR, 'claude_code').completedIds.size, 50);
    assert.equal(loadCompletedInstanceIds(EVIDENCE_MINI50_DIR, 'mini_swe_agent').completedIds.size, 50);

    for (const [arm, expectedCompleted, expectedExcluded] of [
      ['raw_full', 49, 1],
      ['full_aci', 49, 1],
    ]) {
      const loaded = loadCompletedInstanceIds(EVIDENCE_MINI50_DIR, arm);
      const predRows = readJsonl(join(EVIDENCE_MINI50_DIR, `predictions.${arm}.jsonl`));
      const teleRows = readJsonl(join(EVIDENCE_MINI50_DIR, `telemetry.${arm}.jsonl`));
      const evalRows = readJsonl(join(EVIDENCE_MINI50_DIR, `eval.${arm}.jsonl`));
      assert.equal(predRows.length, 50, `${arm} predictions row count`);
      assert.equal(teleRows.length, 50, `${arm} telemetry row count`);
      assert.equal(evalRows.length, expectedCompleted, `${arm} eval row count`);
      const excludedRows = teleRows.filter((row) => !loaded.completedIds.has(row.instance_id));
      assert.equal(excludedRows.length, expectedExcluded, `${arm} excluded outage row count`);
      assert.equal(
        excludedRows.every((row) => row.status === 'env_error' && /PROVIDER_UNAVAILABLE/.test(String(row.error || ''))),
        true,
        `${arm} excluded rows must be retryable PROVIDER_UNAVAILABLE env_error tasks`,
      );
    }
  });

  test('--merge-shards prefers a clean completed/non-outage run over a stale unresolved PROVIDER_UNAVAILABLE row', async () => {
    const baseTmp = makeTmp('swe-341-merge-');
    const staleShard = join(baseTmp, 'shard-1');
    const cleanShard = join(baseTmp, 'shard-2');
    const outDir = join(baseTmp, 'merged');

    // Stale shard has newer timestamp, evaluated=false, and non-empty patch, but PROVIDER_UNAVAILABLE error
    writeJsonl(join(staleShard, 'predictions.raw_full.jsonl'), [
      { instance_id: 'django__django-9999', model_name_or_path: 'deepseek-v4.1-flash', model_patch: 'diff-stale' },
      { instance_id: 'django__django-8888', model_name_or_path: 'deepseek-v4.1-flash', model_patch: 'diff-stale-2' },
    ]);
    writeJsonl(join(staleShard, 'telemetry.raw_full.jsonl'), [
      makeTelemetryRow('django__django-9999', 'raw_full', {
        status: 'failed',
        error: 'PROVIDER_UNAVAILABLE',
        nonEmptyPatch: true,
        cacheStatus: 'available',
        timestamp: '2026-11-26T12:00:00.000Z',
      }),
      makeTelemetryRow('django__django-8888', 'raw_full', {
        status: 'failed',
        error: 'RATE_LIMITED',
        nonEmptyPatch: true,
        cacheStatus: 'available',
        timestamp: '2026-11-26T12:00:00.000Z',
      }),
    ]);
    writeJsonl(join(staleShard, 'eval.raw_full.jsonl'), [
      { instance_id: 'django__django-9999', resolved: false, reason: 'failed_tests' },
      { instance_id: 'django__django-8888', resolved: false, reason: 'failed_tests' },
    ]);

    // Clean shard: 9999 is completed (even without eval!), 8888 is non-outage completed + evaluated
    writeJsonl(join(cleanShard, 'predictions.raw_full.jsonl'), [
      { instance_id: 'django__django-9999', model_name_or_path: 'deepseek-v4.1-flash', model_patch: 'diff-clean-uneval' },
      { instance_id: 'django__django-8888', model_name_or_path: 'deepseek-v4.1-flash', model_patch: 'diff-clean-eval' },
    ]);
    writeJsonl(join(cleanShard, 'telemetry.raw_full.jsonl'), [
      makeTelemetryRow('django__django-9999', 'raw_full', {
        status: 'completed',
        error: null,
        cacheStatus: 'missing',
        timestamp: '2026-11-26T10:00:00.000Z',
      }),
      makeTelemetryRow('django__django-8888', 'raw_full', {
        status: 'completed',
        error: null,
        cacheStatus: 'available',
        timestamp: '2026-11-26T10:00:00.000Z',
      }),
    ]);
    writeJsonl(join(cleanShard, 'eval.raw_full.jsonl'), [
      { instance_id: 'django__django-8888', resolved: true, reason: 'resolved' },
    ]);

    const res = await runSweBenchBenchmark({
      mergeShards: [staleShard, cleanShard],
      arms: ['raw_full'],
      outputDir: outDir,
      model: 'deepseek-v4.1-flash',
    });

    const predById = new Map(res.predictionsByArm.raw_full.map((p) => [p.instance_id, p]));
    const teleById = new Map(res.telemetryByArm.raw_full.map((t) => [t.instance_id, t]));
    assert.equal(predById.get('django__django-9999')?.model_patch, 'diff-clean-uneval');
    assert.equal(teleById.get('django__django-9999')?.status, 'completed');
    assert.equal(teleById.get('django__django-9999')?.error, null);
    assert.equal(predById.get('django__django-8888')?.model_patch, 'diff-clean-eval');
    assert.equal(teleById.get('django__django-8888')?.resolved, true);
    assert.deepEqual(res.envErrorByArm.raw_full, []);
  });

  test('--resume retries unresolved PROVIDER_UNAVAILABLE row and replaces stale failed eval row without leaving stale failures behind', async () => {
    const tmpRoot = makeTmp('swe-341-resume-eval-');
    const repoDir = join(tmpRoot, 'repo');
    const baseCommit = seedSimpleRepo(repoDir);
    const dsPath = join(tmpRoot, 'ds.jsonl');
    const outDir = join(tmpRoot, 'out');

    writeJsonl(dsPath, [
      {
        instance_id: 'demo__app-1',
        repo: 'demo/app',
        base_commit: baseCommit,
        problem_statement: 'Fix 1',
        FAIL_TO_PASS: ['t1'],
        PASS_TO_PASS: [],
        workspace_path: repoDir,
      },
      {
        instance_id: 'demo__app-2',
        repo: 'demo/app',
        base_commit: baseCommit,
        problem_statement: 'Fix 2',
        FAIL_TO_PASS: ['t2'],
        PASS_TO_PASS: [],
        workspace_path: repoDir,
      },
    ]);

    // Pre-seed: demo__app-1 has PROVIDER_UNAVAILABLE + resolved=true (should stay completed),
    // demo__app-2 has PROVIDER_UNAVAILABLE + stale failed eval resolved=false (must be retried & re-evaluated)
    writeJsonl(join(outDir, 'predictions.raw_full.jsonl'), [
      { instance_id: 'demo__app-1', model_name_or_path: 'mock-model', model_patch: 'diff-1' },
      { instance_id: 'demo__app-2', model_name_or_path: 'mock-model', model_patch: 'diff-stale-2' },
    ]);
    writeJsonl(join(outDir, 'telemetry.raw_full.jsonl'), [
      makeTelemetryRow('demo__app-1', 'raw_full', { status: 'failed', error: 'PROVIDER_UNAVAILABLE', resolved: true }),
      makeTelemetryRow('demo__app-2', 'raw_full', { status: 'failed', error: 'PROVIDER_UNAVAILABLE', resolved: false }),
    ]);
    writeJsonl(join(outDir, 'eval.raw_full.jsonl'), [
      { instance_id: 'demo__app-1', resolved: true, reason: 'resolved' },
      { instance_id: 'demo__app-2', resolved: false, reason: 'failed_tests' },
    ]);

    const executedIds = [];
    const evaluatedIds = [];

    class StubAdapter {
      async generate({ onDelta }) {
        onDelta?.({ type: 'text_delta', text: 'Done.' });
        return {
          text: 'Done.',
          toolCalls: [],
          usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 64, cacheWriteTokens: 36, cacheEligibleInputTokens: 100 },
          raw: {},
        };
      }
    }

    const res = await runSweBenchBenchmark(
      {
        dataset: dsPath,
        arms: ['raw_full'],
        outputDir: outDir,
        resume: true,
        evaluate: true,
        model: 'mock-model',
      },
      {
        createAdapter: ({ instance }) => {
          executedIds.push(instance.instance_id);
          return new StubAdapter();
        },
        evaluateSweBenchPredictions: async ({ instances }) => {
          const results = instances.map((inst) => {
            evaluatedIds.push(inst.instance_id);
            return { instance_id: inst.instance_id, resolved: true, reason: 'resolved' };
          });
          return { totalInstances: instances.length, evaluatedCount: results.length, resolvedCount: results.length, resolvedRate: 1, results };
        },
      },
    );

    assert.deepEqual(executedIds, ['demo__app-2']);
    assert.deepEqual(evaluatedIds, ['demo__app-2']);
    assert.equal(res.evalByArm.raw_full.resolvedCount, 2);
    const evalOnDisk = readJsonl(join(outDir, 'eval.raw_full.jsonl'));
    assert.equal(evalOnDisk.length, 2);
    assert.equal(evalOnDisk.every((e) => e.resolved === true), true);
  });
});
