import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { DirectAgentRuntime } from '../../src/direct-agent.js';
import {
  isThinkingOrReasoningModel,
  loadAppPoolReadOnly,
  resolveSupervisorExecutionConfig,
} from '../../src/evaluation/swebench-pool.js';
import { MetricsCollector } from '../../src/observability/metrics.js';
import { AccountPool } from '../../src/pool.js';
import { Store } from '../../src/store.js';
import {
  DEFAULT_DRY_RUN_TURN_TIMEOUT_MS,
  DEFAULT_LIVE_TURN_TIMEOUT_MS,
  computeArmAggregateMetrics,
  extractTurnTelemetryRow,
  parseSweBenchCliArgs,
  renderSummaryMarkdown,
  runSweBenchBenchmark,
} from '../../scripts/benchmark-swebench.mjs';

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

function seedSimpleRepo(repoDir) {
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'app.py'), 'def add(a, b):\n    return a - b\n', 'utf8');
  runGit(repoDir, ['init', '-q']);
  runGit(repoDir, ['config', 'user.email', 'tele321@agent-us.invalid']);
  runGit(repoDir, ['config', 'user.name', 'Telemetry 321']);
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
    requests.push({ body });

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

describe('SWE-bench Telemetry 3.2.1 (T1, T2, T3, --turn-timeout-ms, Supervisor Decoupling)', () => {
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

  test('T1: verification_failed TURN_FAILED event includes cacheReadTokens, cacheWriteTokens, and cacheEligibleInputTokens', async () => {
    const dataDir = makeTmp('tele-t1-data-');
    const workDir = makeTmp('tele-t1-work-');
    seedSimpleRepo(workDir);

    const store = new Store(join(dataDir, 'engine.sqlite'));
    const metrics = new MetricsCollector({ store });
    const pool = new AccountPool(store, { root: dataDir, metrics });
    pool.createAccount({
      preset: 'custom-openai',
      label: 'sim',
      credential: 'sk-t1',
      endpoint: 'https://t1.invalid/v1',
      models: ['t1-model'],
    });
    pool.setDefaultModel('t1-model');

    let stage = 0;
    let expectedIn = 0;
    let expectedOut = 0;
    let expectedCacheRead = 0;
    let expectedCacheWrite = 0;
    let expectedCacheEligible = 0;
    class VerifyFailAdapter extends LlmAdapter {
      async *stream() {
        if (stage === 0) {
          stage = 1;
          expectedIn += 200;
          expectedOut += 20;
          expectedCacheRead += 64;
          expectedCacheWrite += 136;
          expectedCacheEligible += 200;
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-t1-edit',
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'src/app.py',
                content: 'def add(a, b):\n    return a + b\n',
              }),
            },
          };
          yield {
            type: 'usage',
            usage: {
              inputTokens: 200,
              outputTokens: 20,
              cacheReadTokens: 64,
              cacheWriteTokens: 136,
              cacheEligibleInputTokens: 200,
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        expectedIn += 250;
        expectedOut += 30;
        expectedCacheRead += 192;
        expectedCacheWrite += 58;
        expectedCacheEligible += 250;
        yield { type: 'text-delta', index: 0, text: 'Claiming done without running required verification.' };
        yield {
          type: 'usage',
          usage: {
            inputTokens: 250,
            outputTokens: 30,
            cacheReadTokens: 192,
            cacheWriteTokens: 58,
            cacheEligibleInputTokens: 250,
          },
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }

    const direct = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: workDir,
      dataRoot: dataDir,
      metrics,
      adapter: new VerifyFailAdapter(),
      enableHeartbeat: false,
    });

    try {
      const session = direct.createSession({
        workspaceRoot: workDir,
        permissionMode: 'full-access',
      });
      const { turn } = direct.startTurn(session.id, {
        input: 'Update src/app.py',
        model: 't1-model',
        evidenceContract: {
          requiredChangedFiles: ['src/missing_deliverable.py'],
        },
      });
      const terminal = await direct.waitForTurnTerminal(turn.id, { timeoutMs: 10_000 });
      assert.equal(terminal.state, 'failed');

      const failedEv = store.db
        .prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/failed' ORDER BY seq DESC LIMIT 1")
        .get(turn.id);
      assert.ok(failedEv, 'expected turn/failed event row');
      const parsed = JSON.parse(failedEv.data);
      assert.equal(parsed.inputTokens, expectedIn);
      assert.equal(parsed.outputTokens, expectedOut);
      assert.equal(parsed.cacheReadTokens, expectedCacheRead);
      assert.equal(parsed.cacheWriteTokens, expectedCacheWrite);
      assert.equal(parsed.cacheEligibleInputTokens, expectedCacheEligible);
    } finally {
      await direct.close();
      store.close();
    }
  });

  test('T2: cancelTurn + MetricsCollector + waitForTurnTerminal preserves non-zero tokens, steps, cacheReadTokens, and nexus_usage without race', async () => {
    const dataDir = makeTmp('tele-t2-data-');
    const workDir = makeTmp('tele-t2-work-');
    seedSimpleRepo(workDir);

    let markStep2Entered;
    const step2Entered = new Promise((resolve) => {
      markStep2Entered = resolve;
    });
    let stage = 0;

    const mockHttp = await startMockOpenAiSseServer(async (body, req, res) => {
      if (stage === 0) {
        stage = 1;
        const c1 = {
          id: 'c1',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body?.model ?? 't2-model',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tc-t2-read',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: 'src/app.py' }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        const c2 = {
          id: 'c1',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body?.model ?? 't2-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: {
            prompt_tokens: 320,
            completion_tokens: 28,
            total_tokens: 348,
            prompt_tokens_details: { cached_tokens: 192 },
          },
        };
        res.write(`data: ${JSON.stringify(c1)}\n\n`);
        res.write(`data: ${JSON.stringify(c2)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      markStep2Entered();
      await new Promise((resolve) => {
        req.on('close', resolve);
        res.on('close', resolve);
      });
    });

    const store = new Store(join(dataDir, 'engine.sqlite'));
    const metrics = new MetricsCollector({ store });
    const pool = new AccountPool(store, { root: dataDir, metrics });
    pool.createAccount({
      preset: 'custom-openai',
      label: 't2-mock',
      credential: 'sk-t2-mock',
      endpoint: mockHttp.baseUrl,
      models: ['t2-model'],
    });
    pool.setDefaultModel('t2-model');

    const direct = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: workDir,
      dataRoot: dataDir,
      metrics,
      enableHeartbeat: false,
    });

    try {
      const session = direct.createSession({
        workspaceRoot: workDir,
        permissionMode: 'full-access',
      });
      const { turn } = direct.startTurn(session.id, {
        input: 'Read src/app.py and wait',
        model: 't2-model',
      });

      await step2Entered;
      direct.cancelTurn(turn.id);
      const terminal = await direct.waitForTurnTerminal(turn.id, { timeoutMs: 5_000 });

      assert.equal(terminal.state, 'cancelled');
      assert.ok(terminal.inputTokens >= 320, `expected inputTokens >= 320, got ${terminal.inputTokens}`);
      assert.ok(terminal.outputTokens >= 28, `expected outputTokens >= 28, got ${terminal.outputTokens}`);
      assert.ok(terminal.step >= 1, `expected step >= 1, got ${terminal.step}`);
      assert.ok(terminal.durationMs > 0, `expected durationMs > 0, got ${terminal.durationMs}`);

      const nexusRow = store.db
        .prepare('SELECT * FROM nexus_usage WHERE sessionId=? ORDER BY id DESC LIMIT 1')
        .get(session.id);
      assert.ok(nexusRow, 'expected nexus_usage row for cancelled turn with non-zero tokens');
      assert.ok(nexusRow.inputTokens >= 320);

      const cancelEv = store.db
        .prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/cancelled' ORDER BY seq DESC LIMIT 1")
        .get(turn.id);
      assert.ok(cancelEv);
      const evData = JSON.parse(cancelEv.data);
      assert.ok(evData.steps >= 1, `expected evData.steps >= 1, got ${evData.steps}`);
      assert.ok(evData.inputTokens >= 320);
      assert.ok(evData.outputTokens >= 28);
      assert.ok(evData.cacheReadTokens >= 192);
      assert.ok(evData.cacheEligibleInputTokens >= 320);
      assert.ok(evData.durationMs > 0);
      assert.ok(evData.reasoningMetrics, 'expected reasoningMetrics in final turn/cancelled event');

      const teleRow = extractTurnTelemetryRow({
        store,
        turnId: turn.id,
        sessionId: session.id,
        instance: { instance_id: 'tele__t2-cancel-1' },
        arm: 'raw_full',
        modelName: 't2-model',
        wallClockMs: terminal.durationMs,
        modelPatch: '',
        turnRow: terminal,
      });
      assert.ok(teleRow.steps >= 1);
      assert.ok(teleRow.inputTokens >= 320);
      assert.ok(teleRow.cacheReadTokens >= 192);
      assert.equal(teleRow.cacheStatus, 'available');
      assert.ok(teleRow.cacheHitRate > 0);
    } finally {
      await direct.close();
      store.close();
      await mockHttp.close();
    }
  });

  test('T2 backfill: extractTurnTelemetryRow backfills from runtime_metrics_events provider_usage & tool_receipts when evData has 0 tokens', () => {
    const dir = makeTmp('tele-t2-backfill-');
    const store = new Store(join(dir, 'bf.sqlite'));
    const metrics = new MetricsCollector({ store });
    try {
      const now = Date.now();
      store.db
        .prepare(
          "INSERT INTO direct_sessions(id, title, model, permissionMode, state, createdAt, updatedAt) VALUES('s1','t','m1','auto-safe','cancelled',?,?)",
        )
        .run(now, now);
      store.db
        .prepare(
          "INSERT INTO direct_turns(id, sessionId, input, model, state, phase, step, inputTokens, outputTokens, durationMs, createdAt, finishedAt) VALUES('t1','s1','hi','m1','cancelled','cancelled',0,0,0,12,?,?)",
        )
        .run(now, now);
      store.db
        .prepare(
          "INSERT INTO direct_events(sessionId, turnId, type, data, at) VALUES('s1','t1','turn/cancelled',?,?)",
        )
        .run(JSON.stringify({ turnId: 't1', sessionId: 's1' }), now);
      store.db
        .prepare(
          "INSERT INTO tool_receipts(id, sessionId, turnId, callId, toolName, riskLevel, effectClass, replayable, outward, argsDigest, status, durationMs, createdAt, updatedAt) VALUES('r1','s1','t1','c1','read_file','low','read_only',1,0,'d1','finished',5,?,?),('r2','s1','t1','c2','grep','low','read_only',1,0,'d2','finished',5,?,?)",
        )
        .run(now, now, now, now);

      metrics.record('provider_usage', {
        sessionId: 's1',
        turnId: 't1',
        model: 'm1',
        provider: 'deepseek',
        ok: true,
        detail: {
          outcome: 'completed',
          cacheStatus: 'available',
          inputTokens: 400,
          outputTokens: 40,
          cacheReadTokens: 256,
          cacheWriteTokens: 144,
          cacheEligibleInputTokens: 400,
        },
      });
      metrics.record('provider_usage', {
        sessionId: 's1',
        turnId: 't1',
        model: 'm1',
        provider: 'deepseek',
        ok: false,
        detail: {
          outcome: 'cancelled',
          cacheStatus: 'available',
          inputTokens: 600,
          outputTokens: 20,
          cacheReadTokens: 512,
          cacheWriteTokens: 88,
          cacheEligibleInputTokens: 600,
        },
      });

      const row = extractTurnTelemetryRow({
        store,
        turnId: 't1',
        sessionId: 's1',
        instance: { instance_id: 'inst-backfill' },
        arm: 'full_aci',
        modelName: 'm1',
        wallClockMs: 123,
        modelPatch: '',
        turnRow: store.db.prepare('SELECT * FROM direct_turns WHERE id=?').get('t1'),
      });
      assert.equal(row.inputTokens, 1000);
      assert.equal(row.outputTokens, 60);
      assert.equal(row.cacheReadTokens, 768);
      assert.equal(row.cacheWriteTokens, 232);
      assert.equal(row.cacheEligibleInputTokens, 1000);
      assert.equal(row.cacheStatus, 'available');
      assert.equal(row.cacheHitRate, 0.768);
      assert.equal(row.steps, 2);
    } finally {
      store.close();
    }
  });

  test('T3: cacheStatus=missing excludes missing rows from cacheHitRate denominator while preserving legacy fallback and supervisorCost rollup', () => {
    const dir = makeTmp('tele-t3-');
    const store = new Store(join(dir, 't3.sqlite'));
    try {
      const now = Date.now();
      store.db
        .prepare(
          "INSERT INTO direct_sessions(id, title, model, permissionMode, state, createdAt, updatedAt) VALUES('s-miss','t','m1','auto-safe','completed',?,?)",
        )
        .run(now, now);
      store.db
        .prepare(
          "INSERT INTO direct_turns(id, sessionId, input, model, state, phase, step, inputTokens, outputTokens, durationMs, createdAt, finishedAt) VALUES('t-miss','s-miss','hi','m1','completed','completed',2,5000,100,50,?,?)",
        )
        .run(now, now);
      store.db
        .prepare(
          "INSERT INTO direct_events(sessionId, turnId, type, data, at) VALUES('s-miss','t-miss','turn/completed',?,?)",
        )
        .run(
          JSON.stringify({
            turnId: 't-miss',
            sessionId: 's-miss',
            steps: 2,
            inputTokens: 5000,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cacheEligibleInputTokens: null,
          }),
          now,
        );

      const missingRow = extractTurnTelemetryRow({
        store,
        turnId: 't-miss',
        sessionId: 's-miss',
        instance: { instance_id: 'inst-missing' },
        arm: 'full_aci',
        modelName: 'm1',
        wallClockMs: 50,
        modelPatch: '',
        turnRow: store.db.prepare('SELECT * FROM direct_turns WHERE id=?').get('t-miss'),
      });
      assert.equal(missingRow.inputTokens, 5000);
      assert.equal(missingRow.cacheEligibleInputTokens, null);
      assert.equal(missingRow.cacheStatus, 'missing');
      assert.equal(missingRow.cacheHitRate, null);

      const agg = computeArmAggregateMetrics('full_aci', [
        {
          instance_id: 'inst-reported',
          status: 'completed',
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 800,
          cacheWriteTokens: 200,
          cacheEligibleInputTokens: 1000,
          cacheHitRate: 0.8,
          steps: 3,
          wallClockMs: 200,
          nonEmptyPatch: true,
          supervisorCost: { calls: 2, durationMs: 450, totalTokens: 320 },
        },
        {
          ...missingRow,
          supervisorCost: { calls: 1, durationMs: 150, tokens: 100 },
        },
      ]);

      assert.equal(agg.totalInputTokens, 6000);
      assert.equal(agg.totalCacheEligibleInputTokens, 1000);
      assert.equal(agg.totalCacheReadTokens, 800);
      assert.equal(agg.cacheReportedInstances, 1);
      assert.equal(agg.cacheHitRate, 0.8);
      assert.equal(agg.supervisorCalls, 3);
      assert.equal(agg.supervisorDurationMs, 600);
      assert.equal(agg.supervisorTokens, 420);

      const md = renderSummaryMarkdown({
        arms: ['full_aci'],
        metricsByArm: { full_aci: agg },
        telemetryByArm: {
          full_aci: [
            {
              instance_id: 'inst-reported',
              status: 'completed',
              steps: 3,
              inputTokens: 1000,
              outputTokens: 100,
              cacheHitRate: 0.8,
              cacheStatus: 'available',
              wallClockMs: 200,
              nonEmptyPatch: true,
              admissionTokenReductionRate: 0,
              epochTransitions: 0,
            },
            missingRow,
          ],
        },
        meta: { model: 'm1', maxSteps: 60 },
      });
      assert.match(md, /80\.00% \(800\/1000, n=1\)/);
      assert.match(md, /Supervisor Cost/);
      assert.match(md, /3 calls \/ 420 tok \/ 600 ms/);
      assert.match(md, /`inst-missing` \| completed \| - \| 2 \| 5000 \| 100 \| N\/A \|/);
    } finally {
      store.close();
    }
  });

  test('--turn-timeout-ms CLI defaults (900000 live, 60000 dry-run), overrides, and live timeout cancel path', async () => {
    assert.equal(DEFAULT_LIVE_TURN_TIMEOUT_MS, 900_000);
    assert.equal(DEFAULT_DRY_RUN_TURN_TIMEOUT_MS, 60_000);

    const liveDefault = parseSweBenchCliArgs(['--dataset', './ds.jsonl']);
    assert.equal(liveDefault.turnTimeoutMs, 900_000);

    const dryDefault = parseSweBenchCliArgs(['--dry-run']);
    assert.equal(dryDefault.turnTimeoutMs, 60_000);

    const explicitSpace = parseSweBenchCliArgs(['--dataset', './ds.jsonl', '--turn-timeout-ms', '1200000']);
    assert.equal(explicitSpace.turnTimeoutMs, 1_200_000);

    const explicitEq = parseSweBenchCliArgs(['--dry-run', '--turn-timeout-ms=45000']);
    assert.equal(explicitEq.turnTimeoutMs, 45_000);

    assert.throws(() => parseSweBenchCliArgs(['--dry-run', '--turn-timeout-ms', '0']), /positive integer/);
    assert.throws(() => parseSweBenchCliArgs(['--dry-run', '--turn-timeout-ms', 'abc']), /positive integer/);

    // End-to-end live timeout using --turn-timeout-ms 200 -> cancelTurn + waitForTurnTerminal preserves step 1 tokens!
    const repoDir = makeTmp('tele-timeout-repo-');
    const baseCommit = seedSimpleRepo(repoDir);
    const dsPath = join(makeTmp('tele-timeout-ds-'), 'ds.jsonl');
    writeFileSync(
      dsPath,
      JSON.stringify({
        instance_id: 'acme__timeout-1',
        repo: 'acme/app',
        base_commit: baseCommit,
        problem_statement: 'Fix bug.',
      }) + '\n',
      'utf8',
    );
    const outDir = makeTmp('tele-timeout-out-');

    let step = 0;
    const mockHttp = await startMockOpenAiSseServer(async (body, req, res) => {
      if (step === 0) {
        step = 1;
        res.write(
          `data: ${JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 1,
            model: body?.model ?? 'm1',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tc-to-1',
                      type: 'function',
                      function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/app.py' }) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 1,
            model: body?.model ?? 'm1',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: {
              prompt_tokens: 210,
              completion_tokens: 18,
              total_tokens: 228,
              prompt_tokens_details: { cached_tokens: 128 },
            },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      await new Promise((resolve) => {
        req.on('close', resolve);
        res.on('close', resolve);
      });
    });

    try {
      const res = await runSweBenchBenchmark(
        {
          dataset: dsPath,
          arms: ['raw_full'],
          workspaceRoot: repoDir,
          useAppPool: false,
          model: 'deepseek-chat',
          turnTimeoutMs: 250,
          outputDir: outDir,
        },
        {
          env: {
            DEEPSEEK_API_KEY: 'sk-timeout-test',
            SWEBENCH_ENDPOINT: mockHttp.baseUrl,
          },
        },
      );
      const tele = res.telemetryByArm.raw_full[0];
      assert.equal(tele.status, 'cancelled');
      assert.ok(tele.steps >= 1, `expected timed-out telemetry steps >= 1, got ${tele.steps}`);
      assert.ok(tele.inputTokens >= 210, `expected timed-out inputTokens >= 210, got ${tele.inputTokens}`);
      assert.ok(tele.cacheReadTokens >= 128, `expected timed-out cacheReadTokens >= 128, got ${tele.cacheReadTokens}`);
      assert.equal(tele.cacheStatus, 'available');
    } finally {
      await mockHttp.close();
    }
  });

  test('Supervisor decoupling: deepseek-v4* & capability.reasoning trigger deterministic fallback when no distinct fast model exists', () => {
    assert.equal(isThinkingOrReasoningModel('deepseek-v4'), true);
    assert.equal(isThinkingOrReasoningModel('deepseek-v4.1-flash'), true);
    assert.equal(isThinkingOrReasoningModel('deepseek/deepseek-v4-chat'), true);
    assert.equal(isThinkingOrReasoningModel('custom-model', { reasoning: true }), true);
    assert.equal(isThinkingOrReasoningModel('deepseek-chat'), false);

    assert.deepEqual(
      resolveSupervisorExecutionConfig({
        arm: 'full_aci',
        mainModel: 'deepseek-v4.1-flash',
        availableModels: ['deepseek-v4.1-flash'],
      }),
      {
        enabled: false,
        mode: 'off',
        model: null,
        admissionEnabled: true,
        reason: 'reasoning_main_deterministic_fallback',
      },
    );

    assert.deepEqual(
      resolveSupervisorExecutionConfig({
        arm: 'full_aci',
        mainModel: 'claude-sonnet-4-5',
        availableModels: ['claude-sonnet-4-5'],
      }),
      {
        enabled: false,
        mode: 'off',
        model: null,
        admissionEnabled: true,
        reason: 'no_distinct_fast_model_deterministic_fallback',
      },
    );

    assert.deepEqual(
      resolveSupervisorExecutionConfig({
        arm: 'full_aci',
        mainModel: 'deepseek-v4.1-flash',
        supervisorModel: 'deepseek-chat',
      }),
      {
        enabled: true,
        mode: 'custom',
        model: 'deepseek-chat',
        admissionEnabled: true,
        reason: 'explicit_supervisor_model',
      },
    );

    assert.deepEqual(
      resolveSupervisorExecutionConfig({
        arm: 'full_aci',
        mainModel: 'deepseek-v4.1-flash',
        availableModels: ['deepseek-v4.1-flash', 'deepseek-chat'],
      }),
      {
        enabled: true,
        mode: 'custom',
        model: 'deepseek-chat',
        admissionEnabled: true,
        reason: 'auto_fast_model',
      },
    );
  });

  test('--exclude-accounts CLI flag, loadAppPoolReadOnly exclusion + all-excluded error, and live [CACHE-WARN]', async () => {
    const parsedA = parseSweBenchCliArgs([
      '--dataset',
      'hf:verified-mini',
      '--exclude-accounts',
      'catpaw, Mirror-1 ',
    ]);
    assert.deepEqual(parsedA.excludeAccounts, ['catpaw', 'Mirror-1']);
    const parsedB = parseSweBenchCliArgs([
      '--dry-run',
      '--exclude-accounts=alpha,beta',
    ]);
    assert.deepEqual(parsedB.excludeAccounts, ['alpha', 'beta']);

    const srcDir = makeTmp('swe-excl-src-');
    const dstDir = makeTmp('swe-excl-dst-');
    const srcStore = new Store(join(srcDir, 'engine.sqlite'));
    const srcPool = new AccountPool(srcStore, { root: srcDir });
    const catAcc = srcPool.createAccount({
      preset: 'catpaw',
      label: 'CatPaw Relay',
      priority: 1,
      endpoint: 'https://catpaw.example.invalid/v1',
      credential: 'sk-catpaw-excl',
      models: ['deepseek-v4.1-flash'],
    });
    const dsAcc = srcPool.createAccount({
      preset: 'deepseek',
      label: 'DeepSeek Direct',
      priority: 2,
      endpoint: 'https://api.deepseek.com/v1',
      credential: 'sk-deepseek-keep',
      models: ['deepseek-v4.1-flash'],
    });
    srcPool.addManualModel({ accountId: catAcc.id, upstreamModel: 'deepseek-v4.1-flash' });
    srcPool.addManualModel({ accountId: dsAcc.id, upstreamModel: 'deepseek-v4.1-flash' });
    srcPool.setDefaultModel('deepseek-v4.1-flash');
    srcStore.close();

    const dstStore = new Store(join(dstDir, 'swebench.sqlite'));
    const dstPool = new AccountPool(dstStore, { root: dstDir });
    try {
      const cloned = loadAppPoolReadOnly({
        explicitDir: srcDir,
        targetStore: dstStore,
        targetPool: dstPool,
        excludeAccounts: ['catpaw'],
      });
      assert.equal(cloned.accountsCloned, 1);
      assert.equal(cloned.excludedAccountsCount, 1);
      assert.deepEqual(
        dstPool.listAccounts().map((a) => a.preset),
        ['deepseek'],
      );
    } finally {
      dstStore.close();
    }

    const allExclDir = makeTmp('swe-excl-all-');
    const allExclStore = new Store(join(allExclDir, 'swebench.sqlite'));
    const allExclPool = new AccountPool(allExclStore, { root: allExclDir });
    try {
      assert.throws(
        () =>
          loadAppPoolReadOnly({
            explicitDir: srcDir,
            targetStore: allExclStore,
            targetPool: allExclPool,
            excludeAccounts: ['catpaw', 'deepseek'],
          }),
        /matched --exclude-accounts/i,
      );
    } finally {
      allExclStore.close();
    }

    // Live runSweBenchBenchmark should forward --exclude-accounts to App Pool and emit [CACHE-WARN] when cacheStatus=missing
    const repoDir = makeTmp('swe-cache-warn-repo-');
    const baseCommit = seedSimpleRepo(repoDir);
    const dsPath = join(makeTmp('swe-cache-warn-ds-'), 'mini.jsonl');
    writeFileSync(
      dsPath,
      JSON.stringify({
        instance_id: 'inst-cache-warn-1',
        repo: 'demo/app',
        base_commit: baseCommit,
        problem_statement: 'Fix add() in src/app.py',
        FAIL_TO_PASS: ['tests/test_app.py::test_add'],
        PASS_TO_PASS: [],
      }) + '\n',
      'utf8',
    );
    const outDir = makeTmp('swe-cache-warn-out-');
    const seenEndpoints = [];
    const mockHttp = await startMockOpenAiSseServer(async (body, req, res) => {
      seenEndpoints.push(req.url);
      res.write(
        `data: ${JSON.stringify({
          id: 'cw-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: body?.model ?? 'deepseek-v4.1-flash',
          choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: 'cw-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: body?.model ?? 'deepseek-v4.1-flash',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 180,
            completion_tokens: 12,
            total_tokens: 192,
          },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const appPoolLiveDir = makeTmp('swe-live-excl-pool-');
    const liveSrcStore = new Store(join(appPoolLiveDir, 'engine.sqlite'));
    const liveSrcPool = new AccountPool(liveSrcStore, { root: appPoolLiveDir });
    liveSrcPool.createAccount({
      preset: 'catpaw',
      label: 'CatPaw ZeroCache',
      priority: 1,
      endpoint: 'http://127.0.0.1:9/catpaw/v1',
      credential: 'sk-catpaw-blocked',
      models: ['deepseek-v4.1-flash'],
    });
    liveSrcPool.createAccount({
      preset: 'custom-openai',
      label: 'Mock Live',
      priority: 2,
      endpoint: `${mockHttp.baseUrl}`,
      credential: 'sk-mock-live',
      models: ['deepseek-v4.1-flash'],
    });
    liveSrcPool.setDefaultModel('deepseek-v4.1-flash');
    liveSrcStore.close();

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    try {
      const res = await runSweBenchBenchmark(
        {
          dataset: dsPath,
          arms: ['raw_full'],
          workspaceRoot: repoDir,
          useAppPool: true,
          appDataDir: appPoolLiveDir,
          excludeAccounts: ['catpaw'],
          model: 'deepseek-v4.1-flash',
          outputDir: outDir,
        },
        {},
      );
      assert.equal(res.telemetryByArm.raw_full[0].cacheStatus, 'missing');
      assert.ok(seenEndpoints.length >= 1, 'non-excluded Mock Live endpoint should handle the request');
      assert.ok(
        warnings.some((w) => w.includes('[CACHE-WARN]') && w.includes('inst-cache-warn-1') && w.includes('cacheStatus=missing')),
        `expected [CACHE-WARN] on console.warn, got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      console.warn = origWarn;
      await mockHttp.close();
    }
  });
});
