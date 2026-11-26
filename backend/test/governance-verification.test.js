import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { EvidenceVerifier } from '../src/governance/verifier.js';
import { buildRepairNote } from '../src/verifier.js';
import { ControlPlane } from '../src/governance/control-plane.js';
import { api } from '../src/api.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handlers) {
    super();
    this.handlers = handlers;
    this.idx = 0;
  }
  async *stream(options) {
    const fn = this.handlers[this.idx++] ?? this.handlers.at(-1);
    yield* fn(options);
  }
}

async function waitTurnDone(direct, sessionId, turnId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = direct.listTurns(sessionId).find((x) => x.id === turnId);
    if (t && ['completed', 'failed', 'cancelled'].includes(t.state)) return t;
    await delay(20);
  }
  throw new Error('Timed out waiting for turn');
}

test('P6 EvidenceVerifier enforces reconciliation locks and explicit contracts without post-hoc heuristic closing vetoes', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p6-ver-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-p6-ver-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const verifier = new EvidenceVerifier({ store });

  try {
    const now = Date.now();
    store.tx(() => {
      store.db
        .prepare(
          "INSERT INTO direct_sessions(id, title, workspaceRoot, state, createdAt, updatedAt) VALUES('s1','v',?,'running',?,?)",
        )
        .run(workDir, now, now);
      store.db
        .prepare(
          `INSERT INTO tool_receipts(
            id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
            replayable, outward, argsDigest, status, exitCode, durationMs, createdAt, updatedAt
          ) VALUES('r1','s1','t1','c1','bash','high','irreversible_side_effect',0,0,'abc','failed',1,50,?,?)`,
        )
        .run(now, now);
    });

    // 1. Normal completion after a failed bash receipt is NOT vetoed; failedShellReceipts stays observational
    const afterFailedBash = verifier.verify({
      sessionId: 's1',
      turnId: 't1',
      workspaceRoot: workDir,
      text: '已完成所有改动，测试通过 (0 failures)，构建成功。',
      events: [{ type: 'turn/end', data: { reason: 'completed' } }],
    });
    assert.equal(afterFailedBash.accepted, true);
    assert.equal(afterFailedBash.verdict, 'pass');
    assert.equal(afterFailedBash.checks.failedShellReceipts, 1);
    assert.deepEqual(afterFailedBash.reasons, []);

    // 2. Pending outcome_unknown receipt blocks completion unconditionally (durable reconciliation lock)
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO tool_receipts(
            id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
            replayable, outward, argsDigest, status, durationMs, createdAt, updatedAt
          ) VALUES('r2','s1','t1','c2','mcp__gh','high','external_network',0,1,'def','outcome_unknown',0,?,?)`,
        )
        .run(now + 10, now + 10);
    });
    const blocked = verifier.verify({
      sessionId: 's1',
      turnId: 't1',
      workspaceRoot: workDir,
      text: '我已完成任务。',
      events: [],
    });
    assert.equal(blocked.verdict, 'block_reconciliation');
    assert.equal(blocked.accepted, false);

    // 3. Previously written file later removed from disk does NOT veto normal completion
    store.tx(() => {
      store.db.prepare("DELETE FROM tool_receipts WHERE sessionId='s1'").run();
    });
    const tempPath = 'tmp-helper.js';
    writeFileSync(join(workDir, tempPath), 'temp', 'utf8');
    unlinkSync(join(workDir, tempPath));
    const removedRes = verifier.verify({
      sessionId: 's1',
      turnId: 't1',
      workspaceRoot: workDir,
      text: '已验证并清理临时脚本。',
      events: [
        { type: 'tool/call', data: { callId: 'c3', name: 'write_file', arguments: { path: tempPath } } },
        { type: 'tool/result', data: { name: 'write_file', isError: false, receipt: { callId: 'c3' } } },
      ],
    });
    assert.equal(removedRes.accepted, true);
    assert.equal(removedRes.verdict, 'pass');
    assert.deepEqual(removedRes.reasons, []);

    // 4. Editing a file after a passing bash command does NOT veto normal completion
    const postPassEdit = verifier.verify({
      sessionId: 's1',
      turnId: 't2',
      workspaceRoot: workDir,
      text: '已更新注释并完成任务。',
      events: [
        { type: 'tool/call', data: { callId: 'b1', name: 'bash', arguments: { command: 'npm test' } } },
        { type: 'tool/result', data: { callId: 'b1', name: 'bash', isError: false, receipt: { callId: 'b1', exitCode: 0 } } },
        { type: 'tool/call', data: { callId: 'e1', name: 'edit_file', arguments: { path: 'app.js' } } },
        { type: 'tool/result', data: { callId: 'e1', name: 'edit_file', isError: false, receipt: { callId: 'e1' } } },
      ],
    });
    assert.equal(postPassEdit.accepted, true);
    assert.equal(postPassEdit.verdict, 'pass');

    // 5. Explicit opt-in evidenceContract still validates structured evidence manifests
    const missingManifest = verifier.verify({
      sessionId: 's1',
      turnId: 't3',
      workspaceRoot: workDir,
      text: 'Done without JSON manifest.',
      execution: {
        evidenceContract: {
          requiredChangedFiles: ['app.js'],
          expectedTestCommand: 'npm test',
        },
      },
      events: [],
    });
    assert.equal(missingManifest.accepted, false);
    assert.equal(missingManifest.verdict, 'fail');
    assert.equal(missingManifest.status, 'EVIDENCE_INCOMPLETE');
  } finally {
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('P6 DirectAgentRuntime persists verdictJson and evidenceCount and HTTP control plane routes work end-to-end', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p6-http-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-p6-http-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-coder');

  const adapter = new ScriptedAdapter([
    async function* () {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-w',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'verified.txt', content: 'proof=ok\n' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    async function* () {
      yield { type: 'text-delta', index: 0, text: 'verified.txt 已真实写入磁盘。' };
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    async function* () {
      yield { type: 'text-delta', index: 0, text: '定时任务执行完毕。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  ]);

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });
  const controlPlane = new ControlPlane({ store, pool, directAgent: direct });
  const token = 'test-bearer-token-1234567890abcdef';
  const app = api(null, token, undefined, { pool, directAgent: direct, controlPlane });

  try {
    // Zero-idle-polling invariant for ScheduledTaskRunner
    controlPlane.scheduler.start();
    assert.equal(controlPlane.scheduler.timer, null, 'Idle scheduler with 0 tasks must hold zero timers');

    const sess = direct.createSession({ workspaceRoot: workDir });
    const started = direct.startTurn(sess.id, { input: '写入 verified.txt 并核验' });
    const done = await waitTurnDone(direct, sess.id, started.turn.id);
    assert.equal(done.state, 'completed');
    assert.equal(done.evidenceCount, 1);
    assert.equal(done.verdict.accepted, true);

    const auth = { authorization: `Bearer ${token}` };

    // Overview & Receipts & Integrity & Swarm & Plans routes
    const ovRes = await app.inject({ method: 'GET', url: '/v1/runtime/overview', headers: auth });
    assert.equal(ovRes.statusCode, 200);
    assert.equal(ovRes.json().ok, true);

    const rcRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sess.id}/receipts`,
      headers: auth,
    });
    assert.equal(rcRes.statusCode, 200);
    assert.equal(rcRes.json().items.length, 1);
    assert.equal(rcRes.json().items[0].toolName, 'write_file');

    const cpRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sess.id}/checkpoints`,
      headers: auth,
    });
    assert.equal(cpRes.statusCode, 200);
    assert.ok(cpRes.json().items.length >= 1);

    const recRes = await app.inject({ method: 'GET', url: '/v1/reconciliations', headers: auth });
    assert.equal(recRes.statusCode, 200);

    const capRes = await app.inject({ method: 'GET', url: '/v1/swarm/capabilities', headers: auth });
    assert.equal(capRes.statusCode, 200);
    assert.ok(capRes.json().archetypes.length >= 5);

    const intRes = await app.inject({ method: 'GET', url: '/v1/audit/integrity', headers: auth });
    assert.equal(intRes.statusCode, 200);
    assert.equal(intRes.json().ok, true);

    // Schedules CRUD + runNow + clearing timer back to null when deleted
    const crSched = await app.inject({
      method: 'POST',
      url: '/v1/schedules',
      headers: auth,
      payload: {
        name: '每日巡检',
        prompt: '检查工作区状态',
        scheduleKind: 'daily',
        scheduleExpr: '09:00',
        enabled: true,
      },
    });
    assert.equal(crSched.statusCode, 201);
    const schedId = crSched.json().id;
    assert.ok(controlPlane.scheduler.timer !== null);

    const runSched = await app.inject({
      method: 'POST',
      url: `/v1/schedules/${schedId}/run`,
      headers: auth,
    });
    assert.equal(runSched.statusCode, 200);
    const runData = runSched.json();
    assert.equal(runData.schedule.runHistory.length, 1);
    await waitTurnDone(direct, runData.session.id, runData.turn.id);

    const delSched = await app.inject({
      method: 'DELETE',
      url: `/v1/schedules/${schedId}`,
      headers: auth,
    });
    assert.equal(delSched.statusCode, 200);
    assert.equal(controlPlane.scheduler.timer, null, 'Deleting last enabled schedule must clear timer');
  } finally {
    controlPlane.close();
    await direct.close();
    await app.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('P6 AccountPool.getModelMaxOutput and DirectAgentRuntime honor model output capacity and concise truncation repair hints', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p6-maxout-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-p6-maxout-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('deepseek-v4.1-flash');

  const seenMaxTokens = [];
  const adapter = new ScriptedAdapter([
    async function* (options) {
      seenMaxTokens.push(options.maxTokens);
      yield { type: 'text-delta', index: 0, text: 'Done.' };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    async function* (options) {
      seenMaxTokens.push(options.maxTokens);
      yield { type: 'text-delta', index: 0, text: 'Capped.' };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  ]);

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });

  try {
    assert.equal(pool.getModelMaxOutput('deepseek-v4.1-flash'), 32768);

    const sDefault = direct.createSession({ title: 'default maxOutput', model: 'deepseek-v4.1-flash' });
    const t1 = direct.startTurn(sDefault.id, { input: 'hello' });
    await waitTurnDone(direct, sDefault.id, t1.turn.id);
    assert.equal(seenMaxTokens[0], 16384);

    const sCapped = direct.createSession({
      title: 'capped maxOutput',
      model: 'deepseek-v4.1-flash',
      budget: { maxOutputTokens: 2048 },
    });
    const t2 = direct.startTurn(sCapped.id, { input: 'hello capped' });
    await waitTurnDone(direct, sCapped.id, t2.turn.id);
    assert.equal(seenMaxTokens[1], 2048);

    const note = buildRepairNote({ verdict: 'fail', reasons: ['output_truncated'] });
    assert.match(note, /split large file writes/i);
    assert.match(note, /concise/i);
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});
