import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
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
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { AccountPool } from '../../src/pool.js';
import { Store } from '../../src/store.js';
import { selectSweBenchSubset } from '../../src/evaluation/swebench-dataset-eval.js';
import {
  parseSweBenchCliArgs,
  parseSweBenchShardSpec,
  runSweBenchBenchmark,
  sliceInstancesForShard,
} from '../../scripts/benchmark-swebench.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = resolve(TEST_DIR, '..', '..');
const SCRIPT_PATH = resolve(BACKEND_DIR, 'scripts', 'benchmark-swebench.mjs');

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

function seedSimpleRepo(repoDir) {
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'app.py'), 'def add(a, b):\n    return a - b\n', 'utf8');
  runGit(repoDir, ['init', '-q']);
  runGit(repoDir, ['config', 'user.email', 'shard32@agent-us.invalid']);
  runGit(repoDir, ['config', 'user.name', 'Shard Merge 32']);
  runGit(repoDir, ['config', 'core.autocrlf', 'false']);
  runGit(repoDir, ['add', '-A']);
  runGit(repoDir, ['commit', '-qm', 'init']);
  return runGit(repoDir, ['rev-parse', 'HEAD']);
}

async function startMockOpenAiSseServer(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization ?? null,
      body,
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    await handler(body, req, res, requests);
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const addr = server.address();
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    requests,
    close: () => new Promise((res) => server.close(res)),
  };
}

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

function buildMultiRepoInstances(count = 60, baseCommit = 'abc1234', workspaceRoot = null) {
  const repos = [
    'django/django',
    'sympy/sympy',
    'scikit-learn/scikit-learn',
    'psf/requests',
    'pytest-dev/pytest',
  ];
  const out = [];
  for (let i = 0; i < count; i++) {
    const repo = repos[i % repos.length];
    const slug = repo.replace('/', '__');
    out.push({
      instance_id: `${slug}-${String(i + 1).padStart(3, '0')}`,
      repo,
      base_commit: baseCommit,
      problem_statement: `Fix bug #${i + 1} in ${repo}: ${'detail '.repeat((i % 7) + 1)}`,
      hints_text: '',
      FAIL_TO_PASS: [`tests/test_case_${i}.py::test_fix`],
      PASS_TO_PASS: [`tests/test_case_${i}.py::test_keep`],
      ...(workspaceRoot ? { workspace_path: workspaceRoot } : {}),
    });
  }
  return out;
}

describe('SWE-bench 3.2 Sharding, Merging, and Env/Exclude Forwarding', () => {
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

  test('excludeAccounts CSV normalization and runtimeDeps.env + endpoint/protocol forwarding', async () => {
    const repoDir = makeTmp('swe-32-excl-repo-');
    const baseCommit = seedSimpleRepo(repoDir);
    const dsPath = join(makeTmp('swe-32-excl-ds-'), 'ds.jsonl');
    writeJsonl(dsPath, [
      {
        instance_id: 'demo__app-1',
        repo: 'demo/app',
        base_commit: baseCommit,
        problem_statement: 'Fix add() in src/app.py',
        FAIL_TO_PASS: ['tests/test_app.py::test_add'],
        PASS_TO_PASS: [],
      },
    ]);

    const mockHttp = await startMockOpenAiSseServer(async (body, req, res) => {
      res.write(
        `data: ${JSON.stringify({
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: body?.model ?? 'deepseek-chat',
          choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: body?.model ?? 'deepseek-chat',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 10,
            total_tokens: 130,
            prompt_tokens_details: { cached_tokens: 64 },
          },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });

    try {
      // 1. String CSV excludeAccounts forwarded into App Pool mode
      const appDir = makeTmp('swe-32-app-pool-');
      const srcStore = new Store(join(appDir, 'engine.sqlite'));
      const srcPool = new AccountPool(srcStore, { root: appDir });
      srcPool.createAccount({
        preset: 'catpaw',
        label: 'CatPaw Broken',
        priority: 1,
        endpoint: 'http://127.0.0.1:9/unreachable/v1',
        credential: 'sk-blocked',
        models: ['deepseek-chat'],
      });
      srcPool.createAccount({
        preset: 'custom-openai',
        label: 'Good Mock',
        priority: 2,
        endpoint: mockHttp.baseUrl,
        credential: 'sk-good-pool',
        models: ['deepseek-chat'],
      });
      srcPool.setDefaultModel('deepseek-chat');
      srcStore.close();

      const out1 = makeTmp('swe-32-out1-');
      const res1 = await runSweBenchBenchmark({
        dataset: dsPath,
        arms: ['raw_full'],
        workspaceRoot: repoDir,
        useAppPool: true,
        appDataDir: appDir,
        excludeAccounts: 'catpaw, nonexistent-filter ',
        model: 'deepseek-chat',
        outputDir: out1,
      });
      assert.equal(res1.telemetryByArm.raw_full[0].status, 'completed');
      assert.equal(mockHttp.requests.at(-1)?.authorization, 'Bearer sk-good-pool');

      // 2. runtimeDeps.env + endpoint + protocol forwarded into runSweBenchInstanceArm
      // even when providerConfig wasn't pre-resolved or when env key comes only from runtimeDeps.env
      const out2 = makeTmp('swe-32-out2-');
      const res2 = await runSweBenchBenchmark(
        {
          dataset: dsPath,
          arms: ['raw_full'],
          workspaceRoot: repoDir,
          useAppPool: false,
          endpoint: mockHttp.baseUrl,
          protocol: 'openai',
          model: 'deepseek-chat',
          outputDir: out2,
        },
        {
          env: { SWEBENCH_API_KEY: 'sk-runtime-env-only' },
        },
      );
      assert.equal(res2.telemetryByArm.raw_full[0].status, 'completed');
      assert.equal(mockHttp.requests.at(-1)?.authorization, 'Bearer sk-runtime-env-only');
    } finally {
      await mockHttp.close();
    }
  });

  test('parseSweBenchShardSpec validation and parseSweBenchCliArgs --shard / --merge-shards flags', () => {
    assert.deepEqual(parseSweBenchShardSpec('1/5'), { index: 1, total: 5 });
    assert.deepEqual(parseSweBenchShardSpec(' 5 / 5 '), { index: 5, total: 5 });
    assert.deepEqual(parseSweBenchShardSpec({ index: 2, total: 4 }), { index: 2, total: 4 });

    for (const bad of ['0/5', '6/5', '1/0', '-1/5', '1.5/5', 'abc/5', '1/2/3', '', null, undefined, { index: 0, total: 5 }, { index: 6, total: 5 }, { index: 1, total: 0 }]) {
      assert.throws(() => parseSweBenchShardSpec(bad), /Invalid --shard/);
    }

    const cliShardSpace = parseSweBenchCliArgs(['--dataset', 'hf:verified-mini', '--shard', '2/5']);
    assert.deepEqual(cliShardSpace.shard, { index: 2, total: 5 });

    const cliShardEq = parseSweBenchCliArgs(['--dataset=hf:verified-mini', '--shard=4/5']);
    assert.deepEqual(cliShardEq.shard, { index: 4, total: 5 });

    assert.throws(() => parseSweBenchCliArgs(['--dry-run', '--shard', '0/5']), /Invalid --shard/);
    assert.throws(() => parseSweBenchCliArgs(['--dry-run', '--shard=6/5']), /Invalid --shard/);

    // --merge-shards does NOT require --dataset
    const cliMerge = parseSweBenchCliArgs(['--merge-shards', '/tmp/s1, /tmp/s2']);
    assert.deepEqual(cliMerge.mergeShards, ['/tmp/s1', '/tmp/s2']);
    const cliMergeEq = parseSweBenchCliArgs(['--merge-shards=/tmp/all']);
    assert.deepEqual(cliMergeEq.mergeShards, ['/tmp/all']);

    assert.throws(() => parseSweBenchCliArgs(['--merge-shards', '']), /--merge-shards requires/);
  });

  test('50-instance paper-50 interleaved sharding (1/5..5/5 disjoint & complete, repo balance, --limit ordering, shard+resume filtering)', async () => {
    const repoDir = makeTmp('swe-32-shard-repo-');
    const baseCommit = seedSimpleRepo(repoDir);
    const fullInstances = buildMultiRepoInstances(60, baseCommit, repoDir);
    const paper50 = selectSweBenchSubset(fullInstances, { preset: 'paper-50', seed: 42 }).instances;
    assert.equal(paper50.length, 50);

    const shardIdsByIndex = [];
    const unionIds = new Set();
    for (let k = 1; k <= 5; k++) {
      const sliced = sliceInstancesForShard(paper50, { index: k, total: 5 });
      assert.equal(sliced.length, 10, `shard ${k}/5 should have 10 instances`);
      const ids = sliced.map((i) => i.instance_id);
      shardIdsByIndex.push(ids);
      for (const id of ids) {
        assert.equal(unionIds.has(id), false, `duplicate instance_id ${id} across shards`);
        unionIds.add(id);
      }

      // Repo balance: 10 instances per repo in paper-50 => exactly 2 per repo per shard
      const repoCounts = new Map();
      for (const inst of sliced) {
        repoCounts.set(inst.repo, (repoCounts.get(inst.repo) ?? 0) + 1);
      }
      for (const [repo, cnt] of repoCounts.entries()) {
        assert.equal(cnt, 2, `shard ${k}/5 repo ${repo} expected 2 instances, got ${cnt}`);
      }
    }
    assert.equal(unionIds.size, 50);
    for (const inst of paper50) {
      assert.equal(unionIds.has(inst.instance_id), true);
    }

    // Strict ordering: dataset -> instanceIds -> selectSweBenchSubset -> --limit -> --shard
    const dsPath = join(makeTmp('swe-32-shard-ds-'), 'mini60.jsonl');
    writeJsonl(dsPath, fullInstances);

    const calledIds = [];
    class StubStopAdapter extends LlmAdapter {
      async *stream(req) {
        const msg = JSON.stringify(req.messages ?? []);
        const match = /([a-z0-9_-]+__[a-z0-9_-]+-\d{3})/i.exec(msg);
        if (match) calledIds.push(match[1]);
        yield { type: 'text-delta', index: 0, text: 'Completed.' };
        yield {
          type: 'usage',
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 64, cacheWriteTokens: 36, cacheEligibleInputTokens: 100 },
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }

    const limitOutDir = makeTmp('swe-32-limit-shard-');
    const limitRes = await runSweBenchBenchmark(
      {
        dataset: dsPath,
        subset: 'paper-50',
        seed: 42,
        limit: 10,
        shard: '2/5',
        arms: ['raw_full'],
        workspaceRoot: repoDir,
        outputDir: limitOutDir,
      },
      { createAdapter: () => new StubStopAdapter() },
    );
    assert.equal(limitRes.instancesCount, 2);
    assert.deepEqual(
      limitRes.telemetryByArm.raw_full.map((r) => r.instance_id),
      sliceInstancesForShard(paper50.slice(0, 10), '2/5').map((i) => i.instance_id),
    );

    // Shard + resume filtering: pre-seed all 50 instances (one shard-1 completed, one shard-1 env_error, 40 other-shard rows)
    const resumeOutDir = makeTmp('swe-32-shard-resume-');
    const shard1Ids = shardIdsByIndex[0];
    const completedShard1Id = shard1Ids[0];
    const envErrShard1Id = shard1Ids[1];

    const seedPreds = [];
    const seedTele = [];
    const seedEval = [];
    for (const inst of paper50) {
      const id = inst.instance_id;
      if (id === envErrShard1Id) {
        seedTele.push({
          instance_id: id,
          arm: 'raw_full',
          model: 'mock-model',
          status: 'env_error',
          wallClockMs: 5,
          steps: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheEligibleInputTokens: null,
          cacheStatus: 'missing',
          cacheHitRate: null,
          nonEmptyPatch: false,
          admissionOriginalTokens: 0,
          admissionInjectedTokens: 0,
          admissionSavedTokens: 0,
          admissionTokenReductionRate: 0,
          epochTransitions: 0,
          error: 'transient docker error',
          timestamp: '2026-11-25T00:00:00.000Z',
        });
        continue;
      }
      if (id === completedShard1Id || !shard1Ids.includes(id)) {
        seedPreds.push({
          instance_id: id,
          model_name_or_path: 'mock-model',
          model_patch: 'diff --git a/x b/x\n',
        });
        seedTele.push({
          instance_id: id,
          arm: 'raw_full',
          model: 'mock-model',
          status: 'completed',
          wallClockMs: 100,
          steps: 2,
          inputTokens: 200,
          outputTokens: 20,
          totalTokens: 220,
          cacheReadTokens: 128,
          cacheWriteTokens: 72,
          cacheEligibleInputTokens: 200,
          cacheStatus: 'available',
          cacheHitRate: 0.64,
          nonEmptyPatch: true,
          admissionOriginalTokens: 0,
          admissionInjectedTokens: 0,
          admissionSavedTokens: 0,
          admissionTokenReductionRate: 0,
          epochTransitions: 0,
          timestamp: '2026-11-25T00:00:00.000Z',
        });
        seedEval.push({
          instance_id: id,
          resolved: true,
          reason: 'resolved',
          failToPassPassed: 1,
          failToPassTotal: 1,
          passToPassPassed: 1,
          passToPassTotal: 1,
          durationMs: 10,
        });
      }
    }
    writeJsonl(join(resumeOutDir, 'predictions.raw_full.jsonl'), seedPreds);
    writeJsonl(join(resumeOutDir, 'telemetry.raw_full.jsonl'), seedTele);
    writeJsonl(join(resumeOutDir, 'eval.raw_full.jsonl'), seedEval);

    calledIds.length = 0;
    const evalCalledIds = [];
    const resumeRes = await runSweBenchBenchmark(
      {
        dataset: dsPath,
        subset: 'paper-50',
        seed: 42,
        shard: '1/5',
        resume: true,
        evaluate: true,
        arms: ['raw_full'],
        workspaceRoot: repoDir,
        outputDir: resumeOutDir,
        model: 'mock-model',
      },
      {
        createAdapter: () => new StubStopAdapter(),
        evaluateSweBenchPredictions: async ({ instances }) => {
          const results = instances.map((inst) => {
            evalCalledIds.push(inst.instance_id);
            return {
              instance_id: inst.instance_id,
              resolved: true,
              reason: 'resolved',
              failToPassPassed: 1,
              failToPassTotal: 1,
              passToPassPassed: 1,
              passToPassTotal: 1,
              durationMs: 5,
            };
          });
          return { totalInstances: instances.length, evaluatedCount: results.length, resolvedCount: results.length, resolvedRate: 1, results };
        },
      },
    );

    assert.equal(calledIds.includes(completedShard1Id), false, 'completed shard-1 row should be skipped');
    assert.equal(calledIds.includes(envErrShard1Id), true, 'env_error shard-1 row should be retried');
    assert.equal(calledIds.length, 9, '9 pending shard-1 instances should run');
    assert.equal(evalCalledIds.includes(completedShard1Id), false, 'already evaluated shard-1 row should not re-eval');
    assert.equal(evalCalledIds.length, 9);

    const diskPredIds = readJsonl(join(resumeOutDir, 'predictions.raw_full.jsonl')).map((r) => r.instance_id);
    const diskTeleIds = readJsonl(join(resumeOutDir, 'telemetry.raw_full.jsonl')).map((r) => r.instance_id);
    const diskEvalIds = readJsonl(join(resumeOutDir, 'eval.raw_full.jsonl')).map((r) => r.instance_id);
    assert.equal(diskPredIds.length, 10);
    assert.equal(diskTeleIds.length, 10);
    assert.equal(diskEvalIds.length, 10);
    for (const id of diskTeleIds) {
      assert.equal(shard1Ids.includes(id), true, `unexpected cross-shard row ${id} in shard-1 output`);
    }
    assert.equal(resumeRes.telemetryByArm.raw_full.filter((r) => r.status === 'env_error').length, 0);
  });

  test('--merge-shards discovers natural-sorted shard dirs, deduplicates by 6-level priority, preserves canonical order, writes summary.md & .tex, and reports missing/env_error IDs', async () => {
    const baseTmp = makeTmp('swe-32-merge-');
    const dsDir = join(baseTmp, 'ds');
    const dsInstances = buildMultiRepoInstances(6, 'deadbeef');
    const dsPath = join(dsDir, 'ds.jsonl');
    writeJsonl(dsPath, dsInstances);

    const shardsRoot = join(baseTmp, 'shards');
    const dir1 = join(shardsRoot, 'shard-1');
    const dir2 = join(shardsRoot, 'shard-2');
    const dir10 = join(shardsRoot, 'shard-10');
    const outDir = join(baseTmp, 'merged-out');

    const makeTele = (id, arm, overrides = {}) => ({
      instance_id: id,
      arm,
      model: 'deepseek-v4.1-flash',
      status: 'completed',
      wallClockMs: 500,
      steps: 10,
      inputTokens: arm === 'raw_full' ? 2000 : 1000,
      outputTokens: 100,
      totalTokens: arm === 'raw_full' ? 2100 : 1100,
      cacheReadTokens: arm === 'raw_full' ? 1600 : 900,
      cacheWriteTokens: arm === 'raw_full' ? 400 : 100,
      cacheEligibleInputTokens: arm === 'raw_full' ? 2000 : 1000,
      cacheStatus: 'available',
      cacheHitRate: arm === 'raw_full' ? 0.8 : 0.9,
      nonEmptyPatch: true,
      admissionOriginalTokens: 0,
      admissionInjectedTokens: 0,
      admissionSavedTokens: 0,
      admissionTokenReductionRate: 0,
      epochTransitions: arm === 'full_aci' ? 1 : 0,
      timestamp: '2026-11-25T10:00:00.000Z',
      ...overrides,
    });
    const makePred = (id, patch = 'diff --git a/f b/f\n') => ({
      instance_id: id,
      model_name_or_path: 'deepseek-v4.1-flash',
      model_patch: patch,
    });
    const makeEval = (id, resolved = true, reason = resolved ? 'resolved' : 'failed_tests') => ({
      instance_id: id,
      resolved,
      reason,
      failToPassPassed: resolved ? 1 : 0,
      failToPassTotal: 1,
      passToPassPassed: 1,
      passToPassTotal: 1,
      durationMs: 25,
    });

    const ids = dsInstances.map((i) => i.instance_id);
    // ids[0]: shard-1 has good completed+evaluated, shard-10 has newer env_error -> shard-1 MUST win (rule 1)
    // ids[1]: shard-1 has pred-only orphan, shard-2 has tele+pred -> shard-2 MUST win (rule 1b)
    // ids[2]: shard-1 has evaluated good (failed), shard-10 has unevaluated completed -> shard-1 MUST win (rule 2)
    // ids[3]: shard-2 has completed + cacheStatus='missing', shard-10 has completed + cacheStatus='available' -> shard-10 wins (rule 4)
    // ids[4]: shard-2 has empty patch, shard-10 has non-empty patch -> shard-10 wins (rule 5)
    // ids[5]: missing in shard runs for full_aci, and env_error in raw_full

    writeJsonl(join(dir1, 'predictions.raw_full.jsonl'), [
      makePred(ids[0], 'diff-good-0'),
      makePred(ids[1], 'diff-orphan-1'),
      makePred(ids[2], 'diff-eval-2'),
    ]);
    writeJsonl(join(dir1, 'telemetry.raw_full.jsonl'), [
      makeTele(ids[0], 'raw_full', { timestamp: '2026-11-25T09:00:00.000Z' }),
      makeTele(ids[2], 'raw_full', { status: 'failed', timestamp: '2026-11-25T09:00:00.000Z' }),
    ]);
    writeJsonl(join(dir1, 'eval.raw_full.jsonl'), [
      makeEval(ids[0], true, 'resolved'),
      makeEval(ids[2], true, 'resolved'),
    ]);

    writeJsonl(join(dir2, 'predictions.raw_full.jsonl'), [
      makePred(ids[1], 'diff-paired-1'),
      makePred(ids[3], 'diff-miss-cache-3'),
      makePred(ids[4], ''),
    ]);
    writeJsonl(join(dir2, 'telemetry.raw_full.jsonl'), [
      makeTele(ids[1], 'raw_full', { timestamp: '2026-11-25T09:30:00.000Z' }),
      makeTele(ids[3], 'raw_full', { cacheStatus: 'missing', cacheReadTokens: 0, cacheEligibleInputTokens: null, cacheHitRate: null }),
      makeTele(ids[4], 'raw_full', { nonEmptyPatch: false }),
    ]);
    writeJsonl(join(dir2, 'eval.raw_full.jsonl'), [
      makeEval(ids[1], true, 'resolved'),
      makeEval(ids[3], true, 'resolved'),
      makeEval(ids[4], false, 'empty_patch'),
    ]);

    writeJsonl(join(dir10, 'predictions.raw_full.jsonl'), [
      makePred(ids[2], 'diff-uneval-2'),
      makePred(ids[3], 'diff-avail-cache-3'),
      makePred(ids[4], 'diff-nonempty-4'),
    ]);
    writeJsonl(join(dir10, 'telemetry.raw_full.jsonl'), [
      makeTele(ids[0], 'raw_full', { status: 'env_error', nonEmptyPatch: false, timestamp: '2026-11-25T12:00:00.000Z' }),
      makeTele(ids[2], 'raw_full', { status: 'completed', timestamp: '2026-11-25T12:00:00.000Z' }),
      makeTele(ids[3], 'raw_full', { cacheStatus: 'available', timestamp: '2026-11-25T12:00:00.000Z' }),
      makeTele(ids[4], 'raw_full', { nonEmptyPatch: true, timestamp: '2026-11-25T12:00:00.000Z' }),
      makeTele(ids[5], 'raw_full', { status: 'env_error', nonEmptyPatch: false, timestamp: '2026-11-25T12:00:00.000Z' }),
    ]);
    writeJsonl(join(dir10, 'eval.raw_full.jsonl'), [
      makeEval(ids[3], true, 'resolved'),
      makeEval(ids[4], true, 'resolved'),
    ]);

    // full_aci across shard-1, shard-2, shard-10 (note ids[5] omitted -> missingByArm.full_aci)
    writeJsonl(join(dir1, 'predictions.full_aci.jsonl'), [makePred(ids[0]), makePred(ids[1])]);
    writeJsonl(join(dir1, 'telemetry.full_aci.jsonl'), [makeTele(ids[0], 'full_aci'), makeTele(ids[1], 'full_aci')]);
    writeJsonl(join(dir1, 'eval.full_aci.jsonl'), [makeEval(ids[0], true), makeEval(ids[1], true)]);
    writeJsonl(join(dir10, 'predictions.full_aci.jsonl'), [makePred(ids[2]), makePred(ids[3]), makePred(ids[4])]);
    writeJsonl(join(dir10, 'telemetry.full_aci.jsonl'), [makeTele(ids[2], 'full_aci'), makeTele(ids[3], 'full_aci'), makeTele(ids[4], 'full_aci')]);
    writeJsonl(join(dir10, 'eval.full_aci.jsonl'), [makeEval(ids[2], true), makeEval(ids[3], true), makeEval(ids[4], true)]);

    // Also verify natural sort order & CLI execution
    const cliRun = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        '--merge-shards',
        shardsRoot,
        '--dataset',
        dsPath,
        '--arms',
        'raw_full,full_aci',
        '--output-dir',
        outDir,
        '--export-latex',
      ],
      { cwd: BACKEND_DIR, encoding: 'utf8' },
    );
    assert.equal(cliRun.status, 0, `CLI merge failed: ${cliRun.stderr}\n${cliRun.stdout}`);
    assert.match(cliRun.stdout, /action=merge-shards/);
    assert.match(cliRun.stdout, /resolved=/);
    assert.match(cliRun.stdout, /pairedTokRed=/);
    assert.match(cliRun.stdout, /cacheHit=/);
    assert.match(cliRun.stdout, /LaTeX table written/);
    assert.match(cliRun.stdout, new RegExp(`env_error.*${ids[5]}`));
    assert.match(cliRun.stdout, new RegExp(`missing.*${ids[5]}`));

    const mergedPredsRaw = readJsonl(join(outDir, 'predictions.raw_full.jsonl'));
    const mergedTeleRaw = readJsonl(join(outDir, 'telemetry.raw_full.jsonl'));
    const mergedEvalRaw = readJsonl(join(outDir, 'eval.raw_full.jsonl'));

    // Canonical dataset ordering preserved
    assert.deepEqual(
      mergedTeleRaw.map((r) => r.instance_id),
      ids,
    );
    // Rule 1: ids[0] kept shard-1 good run over shard-10 env_error
    assert.equal(mergedTeleRaw[0].status, 'completed');
    assert.equal(mergedPredsRaw.find((p) => p.instance_id === ids[0])?.model_patch, 'diff-good-0');
    // Rule 1b: ids[1] kept tele+pred over orphan
    assert.equal(mergedPredsRaw.find((p) => p.instance_id === ids[1])?.model_patch, 'diff-paired-1');
    // Rule 2: ids[2] kept evaluated over unevaluated
    assert.equal(mergedPredsRaw.find((p) => p.instance_id === ids[2])?.model_patch, 'diff-eval-2');
    assert.equal(mergedTeleRaw[2].resolved, true);
    // Rule 4: ids[3] kept cacheStatus='available' over 'missing'
    assert.equal(mergedTeleRaw[3].cacheStatus, 'available');
    // Rule 5: ids[4] kept non-empty patch over empty patch
    assert.equal(mergedPredsRaw.find((p) => p.instance_id === ids[4])?.model_patch, 'diff-nonempty-4');
    // Eval merged into telemetry
    assert.equal(mergedEvalRaw.length, 5);
    assert.equal(existsSync(join(outDir, 'summary.md')), true);
    assert.equal(existsSync(join(outDir, 'swebench-paper-table.tex')), true);
    const summaryText = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(summaryText, /Paired Resolved Token Reduction/);
    assert.match(summaryText, /`full_aci`/);

    // Programmatic API check: natural sort + missingByArm / envErrorByArm + resume baseline prepending + error on 0 dirs
    const apiOut = join(baseTmp, 'merged-api');
    const apiRes = await runSweBenchBenchmark({
      mergeShards: [shardsRoot],
      dataset: dsPath,
      arms: ['raw_full', 'full_aci'],
      outputDir: apiOut,
    });
    assert.deepEqual(apiRes.sourceDirs, [dir1, dir2, dir10]);
    assert.deepEqual(apiRes.envErrorByArm.raw_full, [ids[5]]);
    assert.deepEqual(apiRes.missingByArm.full_aci, [ids[5]]);

    // Resume baseline in outputDir is prepended, so newer shard-10 / timestamp wins on tie (rule 6)
    const retryDir = join(baseTmp, 'retry-shard');
    writeJsonl(join(retryDir, 'predictions.raw_full.jsonl'), [makePred(ids[5], 'diff-fixed-5')]);
    writeJsonl(join(retryDir, 'telemetry.raw_full.jsonl'), [
      makeTele(ids[5], 'raw_full', { timestamp: '2026-11-25T15:00:00.000Z' }),
    ]);
    writeJsonl(join(retryDir, 'eval.raw_full.jsonl'), [makeEval(ids[5], true)]);

    const resumeMergeRes = await runSweBenchBenchmark({
      mergeShards: [retryDir],
      resume: true,
      outputDir: apiOut,
      arms: ['raw_full', 'full_aci'],
    });
    // Baseline apiOut was prepended before retryDir
    assert.deepEqual(resumeMergeRes.sourceDirs, [apiOut, retryDir]);
    assert.deepEqual(resumeMergeRes.envErrorByArm.raw_full, []);
    // Without dataset/subset, union lexicographical order applies
    const mergedRawIds = resumeMergeRes.telemetryByArm.raw_full.map((r) => r.instance_id);
    assert.deepEqual(mergedRawIds, [...mergedRawIds].sort());

    await assert.rejects(
      () => runSweBenchBenchmark({ mergeShards: [join(baseTmp, 'does-not-exist')] }),
      /No existing shard directories found/,
    );
  });
});
