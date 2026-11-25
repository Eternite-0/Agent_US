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
import { EvidenceVerifier, isExplicitFileDeleteCommand } from '../src/governance/verifier.js';
import { buildRepairNote } from '../src/verifier.js';
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

async function waitTurnDone(direct, sessionId, turnId, timeoutMs = 20_000) {
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

test('P6 EvidenceVerifier recognizes container /testbed/ paths, git clean -f*, and Python inline deletions', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p6-container-del-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-p6-container-del-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const verifier = new EvidenceVerifier({ store });

  try {
    writeFileSync(join(workDir, 'keep.py'), 'ok = True\n', 'utf8');

    // 1. Container /testbed/ rm -f deletion matches workspace-relative write_file path
    const containerRmRes = verifier.verify({
      sessionId: 's-container',
      turnId: 't-rm-testbed',
      workspaceRoot: workDir,
      text: '已修复并清理临时测试文件。',
      node: { requiredFiles: ['keep.py'] },
      execution: { files: { 'keep.py': true } },
      events: [
        { type: 'tool/call', data: { callId: 'w1', name: 'write_file', arguments: { path: 'keep.py' } } },
        { type: 'tool/result', data: { callId: 'w1', name: 'write_file', isError: false, receipt: { callId: 'w1' } } },
        {
          type: 'tool/call',
          data: { callId: 'w2', name: 'write_file', arguments: { path: 'tests/test_tmp_env_versions.py' } },
        },
        { type: 'tool/result', data: { callId: 'w2', name: 'write_file', isError: false, receipt: { callId: 'w2' } } },
        {
          type: 'tool/call',
          data: {
            callId: 'b1',
            name: 'bash',
            arguments: { command: 'rm -f /testbed/tests/test_tmp_env_versions.py' },
          },
        },
        { type: 'tool/result', data: { callId: 'b1', name: 'bash', isError: false, receipt: { callId: 'b1', exitCode: 0 } } },
      ],
    });
    assert.equal(containerRmRes.accepted, true, containerRmRes.reasons.join('; '));
    assert.deepEqual(containerRmRes.checks.cleanedUpTempFiles, ['tests/test_tmp_env_versions.py']);

    // 2. write_file with /testbed/ prefix aligns with delete_file using relative path (and vice versa)
    const alignedDeleteToolRes = verifier.verify({
      sessionId: 's-container',
      turnId: 't-align-del',
      workspaceRoot: workDir,
      text: '已清理临时脚本。',
      events: [
        {
          type: 'tool/call',
          data: { callId: 'a1', name: 'write_file', arguments: { path: '/testbed/tests/test_tmp_align.py' } },
        },
        { type: 'tool/result', data: { callId: 'a1', name: 'write_file', isError: false, receipt: { callId: 'a1' } } },
        {
          type: 'tool/call',
          data: { callId: 'a2', name: 'delete_file', arguments: { path: 'tests/test_tmp_align.py' } },
        },
        { type: 'tool/result', data: { callId: 'a2', name: 'delete_file', isError: false, receipt: { callId: 'a2' } } },
        {
          type: 'tool/call',
          data: { callId: 'a3', name: 'write_file', arguments: { path: 'tests/test_tmp_work.py' } },
        },
        { type: 'tool/result', data: { callId: 'a3', name: 'write_file', isError: false, receipt: { callId: 'a3' } } },
        {
          type: 'tool/call',
          data: { callId: 'a4', name: 'delete_file', arguments: { path: '/work/tests/test_tmp_work.py' } },
        },
        { type: 'tool/result', data: { callId: 'a4', name: 'delete_file', isError: false, receipt: { callId: 'a4' } } },
      ],
    });
    assert.equal(alignedDeleteToolRes.accepted, true, alignedDeleteToolRes.reasons.join('; '));
    assert.deepEqual(alignedDeleteToolRes.checks.cleanedUpTempFiles, [
      'tests/test_tmp_align.py',
      'tests/test_tmp_work.py',
    ]);

    // 3. Confinement check: delete_file with path traversal outside /testbed/ must NOT match
    const escapeDelRes = verifier.verify({
      sessionId: 's-container',
      turnId: 't-escape-del',
      workspaceRoot: workDir,
      text: '已清理。',
      events: [
        {
          type: 'tool/call',
          data: { callId: 'e1', name: 'write_file', arguments: { path: 'tests/test_tmp_safe.py' } },
        },
        { type: 'tool/result', data: { callId: 'e1', name: 'write_file', isError: false, receipt: { callId: 'e1' } } },
        {
          type: 'tool/call',
          data: { callId: 'e2', name: 'delete_file', arguments: { path: '/testbed/../outside/test_tmp_safe.py' } },
        },
        { type: 'tool/result', data: { callId: 'e2', name: 'delete_file', isError: false, receipt: { callId: 'e2' } } },
      ],
    });
    assert.equal(escapeDelRes.accepted, false);
    assert.ok(escapeDelRes.reasons.some((r) => r.includes('DISK_FILE_MISSING')));

    // 4. git clean -fd and git clean -fdx -- tests/test_tmp_env_versions.py
    for (const [idx, cmd] of [
      'git clean -fd',
      'git clean -fdx -- tests/test_tmp_env_versions.py',
      'git clean -fd tests',
      'git clean -f',
    ].entries()) {
      const res = verifier.verify({
        sessionId: 's-container',
        turnId: `t-git-clean-${idx}`,
        workspaceRoot: workDir,
        text: '已清理工作区。',
        events: [
          {
            type: 'tool/call',
            data: { callId: `gc-w-${idx}`, name: 'write_file', arguments: { path: 'tests/test_tmp_env_versions.py' } },
          },
          { type: 'tool/result', data: { callId: `gc-w-${idx}`, name: 'write_file', isError: false, receipt: { callId: `gc-w-${idx}` } } },
          { type: 'tool/call', data: { callId: `gc-b-${idx}`, name: 'bash', arguments: { command: cmd } } },
          { type: 'tool/result', data: { callId: `gc-b-${idx}`, name: 'bash', isError: false, receipt: { callId: `gc-b-${idx}`, exitCode: 0 } } },
        ],
      });
      assert.equal(res.accepted, true, `${cmd} failed: ${res.reasons.join('; ')}`);
      assert.deepEqual(res.checks.cleanedUpTempFiles, ['tests/test_tmp_env_versions.py']);
    }

    // 5. git clean dry-run / non-matching pathspec / required file / failed exitCode / pre-write STILL fail DISK_FILE_MISSING
    for (const [idx, badCase] of [
      { cmd: 'git clean -fdn', exitCode: 0 },
      { cmd: 'git clean -n tests/test_tmp_env_versions.py', exitCode: 0 },
      { cmd: 'git clean -fd other_dir', exitCode: 0 },
      { cmd: 'git clean -fd', exitCode: 1 },
    ].entries()) {
      const res = verifier.verify({
        sessionId: 's-container',
        turnId: `t-git-clean-bad-${idx}`,
        workspaceRoot: workDir,
        text: '已清理。',
        events: [
          {
            type: 'tool/call',
            data: { callId: `gcb-w-${idx}`, name: 'write_file', arguments: { path: 'tests/test_tmp_env_versions.py' } },
          },
          { type: 'tool/result', data: { callId: `gcb-w-${idx}`, name: 'write_file', isError: false, receipt: { callId: `gcb-w-${idx}` } } },
          { type: 'tool/call', data: { callId: `gcb-b-${idx}`, name: 'bash', arguments: { command: badCase.cmd } } },
          {
            type: 'tool/result',
            data: {
              callId: `gcb-b-${idx}`,
              name: 'bash',
              isError: badCase.exitCode !== 0,
              receipt: { callId: `gcb-b-${idx}`, exitCode: badCase.exitCode },
            },
          },
        ],
      });
      assert.equal(res.accepted, false, `${badCase.cmd} should not excuse missing disk file`);
      assert.ok(res.reasons.some((r) => r.includes('DISK_FILE_MISSING')));
    }

    const reqGitCleanRes = verifier.verify({
      sessionId: 's-container',
      turnId: 't-git-clean-req',
      workspaceRoot: workDir,
      text: '完成。',
      node: { requiredFiles: ['delivered_tmp.py'] },
      events: [
        { type: 'tool/call', data: { callId: 'gcr-w', name: 'write_file', arguments: { path: 'delivered_tmp.py' } } },
        { type: 'tool/result', data: { callId: 'gcr-w', name: 'write_file', isError: false, receipt: { callId: 'gcr-w' } } },
        { type: 'tool/call', data: { callId: 'gcr-b', name: 'bash', arguments: { command: 'git clean -fd' } } },
        { type: 'tool/result', data: { callId: 'gcr-b', name: 'bash', isError: false, receipt: { callId: 'gcr-b', exitCode: 0 } } },
      ],
    });
    assert.equal(reqGitCleanRes.accepted, false);
    assert.ok(reqGitCleanRes.reasons.some((r) => r.includes('DISK_FILE_MISSING')));

    // 6. Python inline/script deletions: Path(...).unlink(), pathlib.Path(...).unlink(), os.unlink(...), os.remove(...), shutil.rmtree(...)
    for (const [idx, pyCase] of [
      {
        rel: 'tests/test_tmp_env_versions.py',
        cmd: `python3 -c "from pathlib import Path; Path('/testbed/tests/test_tmp_env_versions.py').unlink()"`,
      },
      {
        rel: 'tests/test_tmp_env_versions.py',
        cmd: `python3 -c "import pathlib; pathlib.Path('/work/tests/test_tmp_env_versions.py').unlink(missing_ok=True)"`,
      },
      {
        rel: 'tests/test_tmp_x.py',
        cmd: `python3 -c "import os; os.unlink('tests/test_tmp_x.py')"`,
      },
      {
        rel: 'tests/test_tmp_x.py',
        cmd: `python3 -c "import os; os.remove('/testbed/tests/test_tmp_x.py')"`,
      },
      {
        rel: 'tests/tmp_dir/helper.py',
        cmd: `python3 -c "import shutil; shutil.rmtree('/testbed/tests/tmp_dir')"`,
      },
    ].entries()) {
      const res = verifier.verify({
        sessionId: 's-container',
        turnId: `t-py-del-${idx}`,
        workspaceRoot: workDir,
        text: '已清理 Python 临时文件。',
        events: [
          { type: 'tool/call', data: { callId: `py-w-${idx}`, name: 'write_file', arguments: { path: pyCase.rel } } },
          { type: 'tool/result', data: { callId: `py-w-${idx}`, name: 'write_file', isError: false, receipt: { callId: `py-w-${idx}` } } },
          { type: 'tool/call', data: { callId: `py-b-${idx}`, name: 'bash', arguments: { command: pyCase.cmd } } },
          { type: 'tool/result', data: { callId: `py-b-${idx}`, name: 'bash', isError: false, receipt: { callId: `py-b-${idx}`, exitCode: 0 } } },
        ],
      });
      assert.equal(res.accepted, true, `${pyCase.cmd} failed: ${res.reasons.join('; ')}`);
      assert.deepEqual(res.checks.cleanedUpTempFiles, [pyCase.rel]);
    }

    // 7. Direct helper checks for workspaceRoot prefix matching & negative non-delete Python commands
    const hostAbs = join(workDir, 'tests', 'test_tmp_x.py');
    assert.equal(
      isExplicitFileDeleteCommand(`rm -f "${hostAbs}"`, 'tests/test_tmp_x.py', { workspaceRoot: workDir }),
      true,
    );
    assert.equal(
      isExplicitFileDeleteCommand(
        `python3 -c "from pathlib import Path; Path('/testbed/tests/test_tmp_env_versions.py').read_text()"`,
        'tests/test_tmp_env_versions.py',
        { workspaceRoot: workDir },
      ),
      false,
    );
  } finally {
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
