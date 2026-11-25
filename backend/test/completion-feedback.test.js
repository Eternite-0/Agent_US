import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmDirSafe } from './fixtures.js';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { ControlPlane } from '../src/governance/control-plane.js';
import { api } from '../src/api.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }
  async *stream(options) {
    const idx = this.calls.length;
    this.calls.push({
      model: options.model,
      messages: structuredClone(options.messages),
    });
    yield* this.handler(options, idx);
  }
}

async function waitTurnState(direct, sessionId, turnId, states, timeoutMs = 20_000) {
  const target = new Set(states);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = direct.listTurns(sessionId).find((x) => x.id === turnId);
    if (t && target.has(t.state)) return t;
    await delay(25);
  }
  const cur = direct.listTurns(sessionId).find((x) => x.id === turnId);
  throw new Error(`Timed out waiting for turn ${turnId} in [${[...target]}], got ${cur?.state}`);
}

test('Fix B1-B3: fail -> repair -> still fail MUST fail across DB, REST, and SSE (never completed)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-repfail-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-repfail-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-model');

  const adapter = new ScriptedAdapter(async function* (opts, idx) {
    if (idx === 0) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-fail-bash',
          name: 'bash',
          arguments: JSON.stringify({ command: 'node -e "process.exit(1)"' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    // Both initial reply AND repair reply fabricate passing tests!
    yield { type: 'text-delta', index: 0, text: `第 ${idx} 次回复：全部测试通过，0 failures，构建成功。` };
    yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });
  const controlPlane = new ControlPlane({ store, pool, directAgent: direct });
  const token = 'fixb-test-token-1234567890abcdef';
  const app = api(null, token, undefined, { pool, directAgent: direct, controlPlane });
  const auth = { authorization: `Bearer ${token}` };

  try {
    const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });
    const liveEvents = [];
    const unsub = direct.subscribe(sess.id, (ev) => liveEvents.push(ev));

    const started = direct.startTurn(sess.id, { input: '运行测试并汇报' });
    const settled = await waitTurnState(direct, sess.id, started.turn.id, ['completed', 'failed', 'cancelled']);
    unsub();

    assert.equal(settled.state, 'failed', 'Reached repair cap with failing verification MUST NOT complete');
    assert.equal(settled.verdict?.verdict, 'fail');
    assert.equal(settled.verdict?.accepted, false);

    // Consistency across REST & SSE/events
    const turnsRes = await app.inject({ method: 'GET', url: `/v1/sessions/${sess.id}/turns`, headers: auth });
    assert.equal(turnsRes.statusCode, 200);
    const restTurn = turnsRes.json().items.find((x) => x.id === started.turn.id);
    assert.equal(restTurn.state, 'failed');

    const persisted = direct.listEvents(sess.id, { after: 0, limit: 200 });
    assert.ok(persisted.some((e) => e.type === 'verifier/repair'), 'repair round should have run');
    assert.ok(persisted.some((e) => e.type === 'turn/failed' && e.turnId === started.turn.id));
    assert.equal(
      persisted.some((e) => e.type === 'turn/completed' && e.turnId === started.turn.id),
      false,
      'must never emit turn/completed on failed verification',
    );
    assert.ok(liveEvents.some((e) => e.type === 'turn/failed'));
    assert.equal(liveEvents.some((e) => e.type === 'turn/completed'), false);

    // Truthful feedback: verification failure != pass
    const fbRow = store.db.prepare('SELECT * FROM model_feedback ORDER BY id DESC LIMIT 1').get();
    assert.ok(fbRow);
    assert.equal(fbRow.success, 0);
    assert.equal(fbRow.verifiedPass, 0);
  } finally {
    controlPlane.close();
    await direct.close();
    await app.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('Fix B3: fail -> repair -> pass re-verifies after repair and completes cleanly', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-reppass-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-reppass-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-model');

  const adapter = new ScriptedAdapter(async function* (_opts, idx) {
    if (idx === 0) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-bash-1',
          name: 'bash',
          arguments: JSON.stringify({ command: 'node -e "process.exit(1)"' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (idx === 1) {
      // Fabricated claim triggers repair
      yield { type: 'text-delta', index: 0, text: '测试全部通过，构建成功。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    // Repair round runs a passing command or reports truthfully
    if (idx === 2) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-bash-2',
          name: 'bash',
          arguments: JSON.stringify({ command: 'node -e "console.log(\'fixed\')"' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: '已修复并重新运行命令，测试通过。' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });
    const started = direct.startTurn(sess.id, { input: '运行并修复测试' });
    const settled = await waitTurnState(direct, sess.id, started.turn.id, ['completed', 'failed']);
    const events = direct.listEvents(sess.id, { after: 0, limit: 100 });

    assert.ok(events.some((e) => e.type === 'verifier/repair'), 'must trigger repair round first');
    assert.equal(settled.state, 'completed');
    assert.equal(settled.verdict?.verdict, 'pass', 'final verdict MUST be refreshed after repair round');
    assert.equal(settled.verdict?.accepted, true);
    const verdicts = events.filter((e) => e.type === 'verifier/verdict');
    assert.ok(verdicts.length >= 2, 'must re-verify after repair round (at least 2 verdict events)');
    assert.equal(verdicts.at(-1).data.verdict, 'pass');
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('Fix B5-B6: block_reconciliation parks turn in reconciling state (never completed) and recovers after resolution', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-rec-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-rec-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-model');

  const adapter = new ScriptedAdapter(async function* () {
    yield { type: 'text-delta', index: 0, text: '外部操作已完成。' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });
    // Pre-insert an unresolved outcome_unknown receipt for this session
    const now = Date.now();
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO tool_receipts(
            id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
            replayable, outward, argsDigest, status, durationMs, createdAt, updatedAt
          ) VALUES('r-unk-b5',?,'prev-turn','c-unk','mcp__deploy','high','external_network',0,1,'dig','outcome_unknown',0,?,?)`,
        )
        .run(sess.id, now, now);
    });

    const started = direct.startTurn(sess.id, { input: '确认部署状态' });
    const parked = await waitTurnState(direct, sess.id, started.turn.id, [
      'reconciling',
      'parked',
      'completed',
      'failed',
    ]);

    assert.equal(parked.state, 'reconciling', 'block_reconciliation MUST park in reconciling, never completed');
    assert.equal(direct.getSession(sess.id).state, 'reconciling');
    assert.equal(parked.verdict?.verdict, 'block_reconciliation');

    const events = direct.listEvents(sess.id, { after: 0, limit: 100 });
    assert.equal(
      events.some((e) => e.type === 'turn/completed' && e.turnId === started.turn.id),
      false,
      'block_reconciliation MUST NOT emit turn/completed',
    );
    assert.ok(events.some((e) => e.type === 'turn/parked' && e.turnId === started.turn.id));

    // Resolve the pending reconciliation and verify the turn recovers and completes cleanly
    const recs = direct.reconciler.listReconciliations({ sessionId: sess.id, status: 'pending' });
    assert.ok(recs.length >= 1, 'reconciliation approval must exist for operator recovery');
    direct.reconciler.resolveReconciliation(recs[0].id, { outcome: 'happened', note: 'confirmed' });

    const done = await waitTurnState(direct, sess.id, started.turn.id, ['completed', 'failed']);
    assert.equal(done.state, 'completed');
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('Fix B4 & B7: Final step still runs verification (pass completes, fail fails); step-limit and thrashing abort fail', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-steps-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-steps-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-model');

  const adapter = new ScriptedAdapter(async function* (opts) {
    const lastUser = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const hasTool = opts.messages.some((m) => m.role === 'tool');

    if (lastUser.includes('CASE:FINAL_PASS')) {
      if (!hasTool) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-final-ok',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'ok.txt', content: 'hi\n' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'ok.txt 已成功写入。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (lastUser.includes('CASE:FINAL_FAIL')) {
      if (!hasTool) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-final-fail',
            name: 'bash',
            arguments: JSON.stringify({ command: 'node -e "process.exit(1)"' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: '测试全部通过，构建成功！' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (lastUser.includes('CASE:STEP_EXHAUSTED')) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: `tc-loop-${Date.now()}`,
          name: 'glob',
          arguments: JSON.stringify({ pattern: '*' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    // CASE:THRASHING - repeat same failing tool call endlessly
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: `tc-thrash-${Math.random().toString(36).slice(2, 6)}`,
        name: 'nonexistent_x',
        arguments: '{}',
      },
    };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    // 1. Final step passes verification -> completes WITH non-null passing verdict
    const s1 = direct.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });
    const t1 = direct.startTurn(s1.id, { input: 'CASE:FINAL_PASS', maxSteps: 2 });
    const d1 = await waitTurnState(direct, s1.id, t1.turn.id, ['completed', 'failed']);
    assert.equal(d1.state, 'completed');
    assert.equal(d1.verdict?.verdict, 'pass', 'final step MUST still run verification');
    assert.equal(d1.verdict?.accepted, true);

    // 2. Final step fails verification -> MUST NOT skip verification to claim completed!
    const s2 = direct.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });
    const t2 = direct.startTurn(s2.id, { input: 'CASE:FINAL_FAIL', maxSteps: 2 });
    const d2 = await waitTurnState(direct, s2.id, t2.turn.id, ['completed', 'failed']);
    assert.equal(d2.state, 'failed', 'final step failing verification MUST fail');
    assert.equal(d2.verdict?.verdict, 'fail');

    // 3. Step limit exhausted mid-tools -> MUST fail (never completed)
    const s3 = direct.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });
    const t3 = direct.startTurn(s3.id, { input: 'CASE:STEP_EXHAUSTED', maxSteps: 1 });
    const d3 = await waitTurnState(direct, s3.id, t3.turn.id, ['completed', 'failed']);
    assert.equal(d3.state, 'failed', 'exhausting step budget without finishing MUST fail');

    // 4. Thrashing anti-loop break -> MUST fail (never completed)
    const s4 = direct.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });
    const t4 = direct.startTurn(s4.id, { input: 'CASE:THRASHING', maxSteps: 8 });
    const d4 = await waitTurnState(direct, s4.id, t4.turn.id, ['completed', 'failed']);
    assert.equal(d4.state, 'failed', 'thrashing circuit breaker stop MUST fail');
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('Fix B8 & B12: Plain-text chat succeeds without tools and feedback never fakes verifiedPass=1 or toolSuccessRate=1 on 0-tool samples', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-plain-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-plain-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('plain-model');

  const adapter = new ScriptedAdapter(async function* () {
    yield { type: 'text-delta', index: 0, text: '快速排序的平均时间复杂度是 O(n log n)。' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir });
    const started = direct.startTurn(sess.id, { input: '什么是快速排序的时间复杂度？' });
    const done = await waitTurnState(direct, sess.id, started.turn.id, ['completed', 'failed']);

    assert.equal(done.state, 'completed');
    assert.equal(done.verdict?.accepted, true);
    assert.equal(done.verdict?.evidenceRequired, false, 'plain-text chat must mark evidenceRequired=false');
    assert.equal(done.evidenceCount, 0);

    const fbRow = store.db
      .prepare("SELECT * FROM model_feedback WHERE model='plain-model' ORDER BY id DESC LIMIT 1")
      .get();
    assert.ok(fbRow);
    assert.equal(fbRow.success, 1);
    assert.equal(fbRow.toolTotal, 0);
    assert.equal(
      fbRow.verifiedPass,
      null,
      '0-tool unverified plain-text sample MUST NOT default verifiedPass to 1',
    );

    const stats = direct.modelFeedback.getStats('plain-model');
    assert.equal(stats.sampleCount, 1);
    assert.equal(stats.metrics.toolSuccessRate, null, '0-tool sample MUST NOT fake toolSuccessRate=1');
    assert.equal(
      stats.metrics.verificationPassRate,
      null,
      'unverified samples MUST NOT fake verificationPassRate=1',
    );

    // Truthful failure taxonomy: distinguish timeout, tool_failure, verification_failure, cancelled, recovery
    direct.modelFeedback.record({
      model: 'taxonomy-model',
      success: false,
      toolTotal: 2,
      toolSuccess: 1,
      verifiedPass: false,
      timedOut: true,
      failureKind: 'timeout',
    });
    direct.modelFeedback.record({
      model: 'taxonomy-model',
      success: false,
      cancelled: true,
      failureKind: 'cancelled',
    });
    direct.modelFeedback.record({
      model: 'taxonomy-model',
      success: true,
      toolTotal: 2,
      toolSuccess: 2,
      verifiedPass: true,
      recovered: true,
    });
    const taxStats = direct.modelFeedback.getStats('taxonomy-model');
    assert.equal(taxStats.sampleCount, 3);
    assert.equal(taxStats.metrics.successRate, 0.5, 'cancelled run must not distort non-cancelled success rate');
    assert.equal(taxStats.metrics.toolSuccessRate, 0.75);
    assert.equal(taxStats.metrics.verificationPassRate, 0.5);
    assert.equal(taxStats.metrics.failureBreakdown.timeout, 1);
    assert.equal(taxStats.metrics.failureBreakdown.cancelled, 1);
    assert.ok(taxStats.metrics.recoveryRate > 0);
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('Fix B10-B11: Pre-model-resolution error, non-retryable error, and modelFeedback.record() throwing never cause ReferenceError or block DB/SSE', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-err-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-err-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  // Intentionally NO default model first!

  let mode = 'bad_request';
  const adapter = new ScriptedAdapter(async function* () {
    if (mode === 'bad_request') {
      throw Object.assign(new Error('HTTP 400 invalid_request_error: bad schema'), { status: 400 });
    }
    yield { type: 'text-delta', index: 0, text: '正常完成回复。' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    // 1. Pre-model-resolution failure (NO_MODEL_CONFIGURED) must NOT throw ReferenceError and MUST emit turn/failed
    const s0 = direct.createSession({ workspaceRoot: workDir, model: '' });
    const t0 = direct.startTurn(s0.id, { input: 'hello without model' });
    const d0 = await waitTurnState(direct, s0.id, t0.turn.id, ['completed', 'failed']);
    assert.equal(d0.state, 'failed');
    assert.match(d0.error || '', /模型|NO_MODEL_CONFIGURED/);
    const ev0 = direct.listEvents(s0.id, { after: 0, limit: 50 });
    assert.ok(ev0.some((e) => e.type === 'turn/failed' && e.turnId === t0.turn.id));

    // Configure model now
    pool.setDefaultModel('mock-err-model');

    // 2. Non-retryable model error + modelFeedback.record() throwing MUST isolate feedback error & emit original turn/failed
    direct.modelFeedback.record = () => {
      throw new Error('TELEMETRY_STORE_EXPLODED');
    };

    const s1 = direct.createSession({ workspaceRoot: workDir, model: 'mock-err-model' });
    const t1 = direct.startTurn(s1.id, { input: 'trigger 400 error' });
    const d1 = await waitTurnState(direct, s1.id, t1.turn.id, ['completed', 'failed']);
    assert.equal(d1.state, 'failed');
    assert.match(d1.error || '', /invalid_request_error/, 'original error must not be overwritten');
    assert.doesNotMatch(d1.error || '', /TELEMETRY_STORE_EXPLODED|effectiveModel/);
    const ev1 = direct.listEvents(s1.id, { after: 0, limit: 50 });
    const failedEv = ev1.find((e) => e.type === 'turn/failed' && e.turnId === t1.turn.id);
    assert.ok(failedEv, 'turn/failed SSE event must be emitted even when modelFeedback.record throws');
    assert.match(failedEv.data.error || '', /invalid_request_error/);

    // 3. Succeeding turn when modelFeedback.record() throws MUST STILL persist completed & emit turn/completed
    mode = 'ok';
    const s2 = direct.createSession({ workspaceRoot: workDir, model: 'mock-err-model' });
    const t2 = direct.startTurn(s2.id, { input: 'succeed despite broken feedback' });
    const d2 = await waitTurnState(direct, s2.id, t2.turn.id, ['completed', 'failed']);
    assert.equal(d2.state, 'completed');
    const ev2 = direct.listEvents(s2.id, { after: 0, limit: 50 });
    assert.ok(
      ev2.some((e) => e.type === 'turn/completed' && e.turnId === t2.turn.id),
      'turn/completed must be emitted even when modelFeedback.record throws',
    );
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('Fix B6, B9, B13: Child verification fail, Swarm verify fail, Swarm budget stop, and idempotent terminal events', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-swarm-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-swarm-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-swarm');

  const adapter = new ScriptedAdapter(async function* (opts) {
    const lastUser = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const isChildFabricate = opts.messages.some(
      (m) => m.role === 'user' && String(m.content?.[0]?.text ?? '').includes('CHILD_FABRICATE'),
    );
    const hasTool = opts.messages.some((m) => m.role === 'tool');

    if (isChildFabricate) {
      if (!hasTool) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-child-fail',
            name: 'bash',
            arguments: JSON.stringify({ command: 'node -e "process.exit(1)"' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: '子代理声称全部测试通过 (0 failures)。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    yield { type: 'text-delta', index: 0, text: `completed:${lastUser.slice(0, 30)}` };
    yield { type: 'usage', usage: { inputTokens: 25, outputTokens: 15 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    const parent = direct.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });

    // 1. Child failing verification MUST reject and persist child session/turn as failed (never completed)
    await assert.rejects(
      () =>
        direct.childManager.spawn({
          parentSessionId: parent.id,
          objective: 'CHILD_FABRICATE run failing bash then lie',
          permissionMode: 'full-access',
          parentPermissionMode: 'full-access',
          isolationMode: 'shared_workspace',
          workspaceRoot: workDir,
        }),
      (err) => /VERIFICATION_FAILED|FABRICATED_PASS_CLAIM|fail/i.test(`${err.code}:${err.message}`),
    );
    const children = direct.sessionRepo.listChildSessions(parent.id);
    assert.equal(children[0].state, 'failed');

    // 2. Swarm budget stop (step2 cancelled due to BUDGET_EXCEEDED) MUST NOT mark Swarm run as completed!
    const budgetRun = await direct.swarmOrchestrator.startRun({
      sessionId: parent.id,
      goal: 'Budget limited run',
      workspaceRoot: workDir,
      budget: { maxTotalTokens: 10 },
      nodes: [
        { nodeKey: 'step1', taskType: 'research', objective: 'first step', dependencies: [] },
        { nodeKey: 'step2', taskType: 'research', objective: 'second step', dependencies: ['step1'] },
      ],
    });
    assert.equal(budgetRun.status, 'failed', 'Swarm run with incomplete budget-cancelled nodes MUST NOT complete');

    // 3. Swarm verify failure: when evidenceVerifier returns fail even if all nodes finished, Swarm MUST fail!
    const origVerify = direct.evidenceVerifier.verify.bind(direct.evidenceVerifier);
    let forceSwarmVerdict = { verdict: 'fail', accepted: false, reasons: ['SYNTHETIC_VERIFY_FAIL'] };
    direct.evidenceVerifier.verify = (args) => {
      if (args?.text?.includes('[ok-node]')) return forceSwarmVerdict;
      return origVerify(args);
    };

    const verifyFailRun = await direct.swarmOrchestrator.startRun({
      sessionId: parent.id,
      goal: 'Swarm verify fail test',
      workspaceRoot: workDir,
      nodes: [{ nodeKey: 'ok-node', taskType: 'research', objective: 'simple ok', dependencies: [] }],
    });
    assert.equal(
      verifyFailRun.status,
      'failed',
      'Swarm verify MUST honor evidenceVerifier fail verdict even when anyFailed===false',
    );
    assert.equal(verifyFailRun.verdict?.verdict, 'fail');

    // 4. Swarm verify block_reconciliation -> parks in reconciling (never completed)
    forceSwarmVerdict = {
      verdict: 'block_reconciliation',
      accepted: false,
      reasons: ['PENDING_RECONCILIATION'],
    };
    const submittedRec = direct.swarmOrchestrator.submitRun({
      sessionId: parent.id,
      goal: 'Swarm verify reconcile test',
      workspaceRoot: workDir,
      nodes: [{ nodeKey: 'ok-node', taskType: 'research', objective: 'simple ok', dependencies: [] }],
    });
    const recDeadline = Date.now() + 5000;
    let recRun = null;
    while (Date.now() < recDeadline) {
      const r = direct.swarmOrchestrator.getRun(submittedRec.runId);
      if (r && ['reconciling', 'completed', 'failed'].includes(r.status)) {
        recRun = r;
        break;
      }
      await delay(25);
    }
    assert.equal(recRun?.status, 'reconciling', 'Swarm verify block_reconciliation MUST enter reconciling');
    direct.evidenceVerifier.verify = origVerify;

    // 5. Idempotent terminal event publishing: cancelling after completion emits NO conflicting terminal events
    const sIdem = direct.createSession({ workspaceRoot: workDir });
    const tIdem = direct.startTurn(sIdem.id, { input: 'simple idempotent test' });
    const dIdem = await waitTurnState(direct, sIdem.id, tIdem.turn.id, ['completed', 'failed']);
    assert.equal(dIdem.state, 'completed');
    direct.cancelTurn(tIdem.turn.id);
    const evIdem = direct.listEvents(sIdem.id, { after: 0, limit: 100 });
    const terminalEvs = evIdem.filter(
      (e) => e.turnId === tIdem.turn.id && ['turn/completed', 'turn/failed', 'turn/cancelled'].includes(e.type),
    );
    assert.equal(terminalEvs.length, 1, 'must emit exactly one terminal event per turn');
    assert.equal(terminalEvs[0].type, 'turn/completed');

    // 6. Swarm node feedback throw isolation: throwing modelFeedback.record must NOT block Swarm DAG completion
    const origRecord = direct.modelFeedback.record.bind(direct.modelFeedback);
    direct.modelFeedback.record = () => {
      throw new Error('SWARM_FEEDBACK_BOOM');
    };
    const isoRun = await direct.swarmOrchestrator.startRun({
      sessionId: parent.id,
      goal: 'Feedback isolation in swarm',
      workspaceRoot: workDir,
      nodes: [
        { nodeKey: 'n1', taskType: 'research', objective: 'first node', dependencies: [] },
        { nodeKey: 'n2', taskType: 'review', objective: 'second node', dependencies: ['n1'] },
      ],
    });
    direct.modelFeedback.record = origRecord;
    assert.equal(isoRun.status, 'completed', 'Swarm DAG must complete even when modelFeedback.record throws');
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('Fix B4 & Schema v6->v7: Resumed execution still runs final verification and legacy v6 DB migrates cleanly', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-resume-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fixb-resume-work-'));
  const dbPath = join(dataDir, 'engine.sqlite');

  // 1. Verify genuine legacy v6 DB with NOT NULL verifiedPass migrates cleanly to v7
  const rawV6 = new DatabaseSync(dbPath);
  rawV6.exec(`
    CREATE TABLE model_feedback(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL, provider TEXT NOT NULL, taskType TEXT NOT NULL,
      success INTEGER NOT NULL, toolTotal INTEGER NOT NULL DEFAULT 0, toolSuccess INTEGER NOT NULL DEFAULT 0,
      verifiedPass INTEGER NOT NULL DEFAULT 1, latencyMs INTEGER NOT NULL DEFAULT 0,
      timedOut INTEGER NOT NULL DEFAULT 0, inputTokens INTEGER NOT NULL DEFAULT 0,
      outputTokens INTEGER NOT NULL DEFAULT 0, contextWindow INTEGER NOT NULL DEFAULT 128000,
      recovered INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL
    );
    INSERT INTO model_feedback(model, provider, taskType, success, verifiedPass, createdAt)
      VALUES('legacy-m', 'pool', 'direct', 1, 1, 1000);
    PRAGMA user_version=6;
  `);
  rawV6.close();

  let store = new Store(dbPath);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
  const migratedRow = store.db.prepare("SELECT * FROM model_feedback WHERE model='legacy-m'").get();
  assert.equal(migratedRow.verifiedPass, 1);
  const mfInfo = store.db.prepare('PRAGMA table_info(model_feedback)').all();
  assert.equal(mfInfo.find((c) => c.name === 'verifiedPass').notnull, 0, 'verifiedPass must allow NULL in v7');
  assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hook_trust_approvals'").get());

  // Seed a session + interrupted running turn that already had a failed bash receipt before crash
  const now = Date.now();
  const sessId = 'sess-resume-verify';
  const turnId = 'turn-resume-verify';
  store.tx(() => {
    store.db
      .prepare(
        "INSERT INTO direct_sessions(id, title, workspaceRoot, model, permissionMode, state, createdAt, updatedAt) VALUES(?, 'Resume Ver', ?, 'mock-res', 'full-access', 'running', ?, ?)",
      )
      .run(sessId, workDir, now, now);
    store.db
      .prepare(
        "INSERT INTO direct_turns(id, sessionId, input, model, state, phase, step, createdAt) VALUES(?, ?, 'run tests', 'mock-res', 'running', 'tools', 1, ?)",
      )
      .run(turnId, sessId, now);
    store.db
      .prepare(
        "INSERT INTO direct_messages(sessionId, turnId, role, content, createdAt) VALUES(?, ?, 'user', 'run tests', ?)",
      )
      .run(sessId, turnId, now);
    store.db
      .prepare(
        `INSERT INTO tool_receipts(
          id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
          replayable, outward, argsDigest, status, exitCode, durationMs, createdAt, updatedAt
        ) VALUES('r-res-fail', ?, ?, 'c-res-1', 'bash', 'high', 'irreversible_side_effect', 0, 0, 'abc', 'failed', 1, 20, ?, ?)`,
      )
      .run(sessId, turnId, now, now);
  });
  store.close();

  // Reopen DB on reboot; resumed turn fabricates pass claim without fixing failed bash -> MUST FAIL!
  store = new Store(dbPath);
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-res');
  const adapter = new ScriptedAdapter(async function* () {
    yield { type: 'text-delta', index: 0, text: '恢复后确认：全部测试通过，0 failures。' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    const settled = await waitTurnState(direct, sessId, turnId, ['completed', 'failed', 'cancelled']);
    assert.equal(settled.state, 'failed', 'Resumed turn MUST NOT skip verification to claim completed');
    assert.equal(settled.verdict?.verdict, 'fail');
    assert.ok(settled.verdict?.reasons?.some((r) => r.includes('FABRICATED_PASS_CLAIM')));
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});
