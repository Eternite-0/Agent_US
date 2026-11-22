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
import { ScheduledTaskRunner } from '../src/governance/scheduler.js';
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

async function waitTurnDone(direct, sessionId, turnId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = direct.listTurns(sessionId).find((x) => x.id === turnId);
    if (t && ['completed', 'failed', 'cancelled'].includes(t.state)) return t;
    await delay(20);
  }
  throw new Error('Timed out waiting for turn');
}

test('P6 EvidenceVerifier blocks fabricated pass claims, unresolved reconciliations, and missing disk files', () => {
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

    // 1. Fabricated pass claim must FAIL when latest bash receipt exited non-zero
    const fabricated = verifier.verify({
      sessionId: 's1',
      turnId: 't1',
      workspaceRoot: workDir,
      text: '已完成所有改动，测试通过 (0 failures)，构建成功。',
      events: [{ type: 'turn/end', data: {} }],
    });
    assert.equal(fabricated.accepted, false);
    assert.equal(fabricated.verdict, 'fail');
    assert.ok(fabricated.reasons.some((r) => r.includes('FABRICATED_PASS_CLAIM')));

    // 2. Pending outcome_unknown receipt blocks completion unconditionally
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

    // 3. Missing claimed written file on disk fails DISK_FILE_MISSING
    store.tx(() => {
      store.db.prepare("DELETE FROM tool_receipts WHERE sessionId='s1'").run();
    });
    const missingPath = 'ghost.js';
    writeFileSync(join(workDir, missingPath), 'temp', 'utf8');
    unlinkSync(join(workDir, missingPath));
    const missingRes = verifier.verify({
      sessionId: 's1',
      turnId: 't1',
      workspaceRoot: workDir,
      text: '已生成 ghost.js。',
      events: [
        { type: 'tool/call', data: { callId: 'c3', name: 'write_file', arguments: { path: missingPath } } },
        { type: 'tool/result', data: { name: 'write_file', isError: false, receipt: { callId: 'c3' } } },
      ],
    });
    assert.equal(missingRes.accepted, false);
    assert.ok(missingRes.reasons.some((r) => r.includes('DISK_FILE_MISSING')));
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

test('P6 EvidenceVerifier tolerates explicitly cleaned temporary files while keeping required deliverables strict', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p6-cleanup-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-p6-cleanup-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const verifier = new EvidenceVerifier({ store });

  try {
    writeFileSync(join(workDir, 'index.js'), 'export const ok = true;\n', 'utf8');

    // 1. Optional temp file written via write_file then removed via bash passes
    const cleanedRes = verifier.verify({
      sessionId: 's-clean',
      turnId: 't-clean',
      workspaceRoot: workDir,
      text: '已实现 index.js 并清理临时验证脚本。',
      node: { requiredFiles: ['index.js'] },
      execution: { files: { 'index.js': true } },
      events: [
        { type: 'tool/call', data: { callId: 'c1', name: 'write_file', arguments: { path: 'index.js' } } },
        { type: 'tool/result', data: { callId: 'c1', name: 'write_file', isError: false, receipt: { callId: 'c1' } } },
        { type: 'tool/call', data: { callId: 'c2', name: 'write_file', arguments: { path: 'tmp-check.js' } } },
        { type: 'tool/result', data: { callId: 'c2', name: 'write_file', isError: false, receipt: { callId: 'c2' } } },
        { type: 'tool/call', data: { callId: 'c3', name: 'bash', arguments: { command: 'rm -f tmp-check.js' } } },
        { type: 'tool/result', data: { callId: 'c3', name: 'bash', isError: false, receipt: { callId: 'c3', exitCode: 0 } } },
      ],
    });
    assert.equal(cleanedRes.accepted, true, cleanedRes.reasons.join('; '));
    assert.deepEqual(cleanedRes.checks.missingDiskFiles, []);
    assert.deepEqual(cleanedRes.checks.cleanedUpTempFiles, ['tmp-check.js']);

    // 2. Re-writing the file AFTER deletion without another deletion fails DISK_FILE_MISSING
    const rewrittenRes = verifier.verify({
      sessionId: 's-clean',
      turnId: 't-rewrite',
      workspaceRoot: workDir,
      text: '已重写 tmp-check.js。',
      events: [
        { type: 'tool/call', data: { callId: 'd1', name: 'write_file', arguments: { path: 'tmp-check.js' } } },
        { type: 'tool/result', data: { callId: 'd1', name: 'write_file', isError: false, receipt: { callId: 'd1' } } },
        { type: 'tool/call', data: { callId: 'd2', name: 'bash', arguments: { command: 'Remove-Item tmp-check.js' } } },
        { type: 'tool/result', data: { callId: 'd2', name: 'bash', isError: false, receipt: { callId: 'd2', exitCode: 0 } } },
        { type: 'tool/call', data: { callId: 'd3', name: 'write_file', arguments: { path: 'tmp-check.js' } } },
        { type: 'tool/result', data: { callId: 'd3', name: 'write_file', isError: false, receipt: { callId: 'd3' } } },
      ],
    });
    assert.equal(rewrittenRes.accepted, false);
    assert.ok(rewrittenRes.reasons.some((r) => r.includes('DISK_FILE_MISSING')));

    // 3. Required deliverable deleted via bash STILL fails DISK_FILE_MISSING
    const requiredDeletedRes = verifier.verify({
      sessionId: 's-clean',
      turnId: 't-req',
      workspaceRoot: workDir,
      text: '已完成。',
      node: { requiredFiles: ['delivered.js'] },
      execution: { files: { 'delivered.js': true } },
      events: [
        { type: 'tool/call', data: { callId: 'r1', name: 'write_file', arguments: { path: 'delivered.js' } } },
        { type: 'tool/result', data: { callId: 'r1', name: 'write_file', isError: false, receipt: { callId: 'r1' } } },
        { type: 'tool/call', data: { callId: 'r2', name: 'bash', arguments: { command: 'rm -f delivered.js' } } },
        { type: 'tool/result', data: { callId: 'r2', name: 'bash', isError: false, receipt: { callId: 'r2', exitCode: 0 } } },
      ],
    });
    assert.equal(requiredDeletedRes.accepted, false);
    assert.ok(requiredDeletedRes.reasons.some((r) => r.includes('DISK_FILE_MISSING')));

    // 4. Failed delete command STILL fails DISK_FILE_MISSING
    const failedDelRes = verifier.verify({
      sessionId: 's-clean',
      turnId: 't-faildel',
      workspaceRoot: workDir,
      text: '已测试完成。',
      events: [
        { type: 'tool/call', data: { callId: 'f1', name: 'write_file', arguments: { path: 'tmp-fail.js' } } },
        { type: 'tool/result', data: { callId: 'f1', name: 'write_file', isError: false, receipt: { callId: 'f1' } } },
        { type: 'tool/call', data: { callId: 'f2', name: 'bash', arguments: { command: 'rm -f tmp-fail.js' } } },
        { type: 'tool/result', data: { callId: 'f2', name: 'bash', isError: true, receipt: { callId: 'f2', exitCode: 1 } } },
      ],
    });
    assert.equal(failedDelRes.accepted, false);
    assert.ok(failedDelRes.reasons.some((r) => r.includes('DISK_FILE_MISSING')));

    // 5. Programmatic Node unlinkSync cleanup is tolerated for non-required temp files
    const nodeUnlinkRes = verifier.verify({
      sessionId: 's-clean',
      turnId: 't-nodeunlink',
      workspaceRoot: workDir,
      text: '已完成验证并清理 tmp-node.js。',
      events: [
        { type: 'tool/call', data: { callId: 'n1', name: 'write_file', arguments: { path: 'tmp-node.js' } } },
        { type: 'tool/result', data: { callId: 'n1', name: 'write_file', isError: false, receipt: { callId: 'n1' } } },
        {
          type: 'tool/call',
          data: {
            callId: 'n2',
            name: 'bash',
            arguments: { command: "node -e \"require('node:fs').unlinkSync('tmp-node.js')\"" },
          },
        },
        { type: 'tool/result', data: { callId: 'n2', name: 'bash', isError: false, receipt: { callId: 'n2', exitCode: 0 } } },
      ],
    });
    assert.equal(nodeUnlinkRes.accepted, true, nodeUnlinkRes.reasons.join('; '));
    assert.deepEqual(nodeUnlinkRes.checks.cleanedUpTempFiles, ['tmp-node.js']);

    // 6. Parallel-batch bash delete dispatched BEFORE write_file call (callIndex < lastWriteIdx) STILL fails DISK_FILE_MISSING
    const reorderedRes = verifier.verify({
      sessionId: 's-clean',
      turnId: 't-reordered',
      workspaceRoot: workDir,
      text: '并行批处理写入。',
      events: [
        { type: 'tool/call', data: { callId: 'p1', name: 'bash', arguments: { command: 'rm -f tmp-race.js' } } },
        { type: 'tool/call', data: { callId: 'p2', name: 'write_file', arguments: { path: 'tmp-race.js' } } },
        { type: 'tool/result', data: { callId: 'p2', name: 'write_file', isError: false, receipt: { callId: 'p2' } } },
        { type: 'tool/result', data: { callId: 'p1', name: 'bash', isError: false, receipt: { callId: 'p1', exitCode: 0 } } },
      ],
    });
    assert.equal(reorderedRes.accepted, false);
    assert.ok(reorderedRes.reasons.some((r) => r.includes('DISK_FILE_MISSING')));
  } finally {
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});
