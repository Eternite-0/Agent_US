import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { ControlPlane } from '../src/governance/control-plane.js';
import { api } from '../src/api.js';
import { service } from '../src/service.js';
import { config } from '../src/providers.js';
import { AgentRuntimeKernel } from '../src/kernel/runtime.js';
import { InferenceEngine } from '../src/kernel/inference.js';
import { CancellationError } from '../src/kernel/errors.js';
import { verifyTurn } from '../src/verifier.js';
import { compactTwoStage, liveContextNotes } from '../src/context.js';
import { MetricsCollector } from '../src/observability/metrics.js';
import { withTraceContext } from '../src/observability/trace.js';
import { logEvent } from '../src/observability/logger.js';

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
      provider: options.provider,
      messages: structuredClone(options.messages ?? []),
      maxTokens: options.maxTokens,
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
  throw new Error(
    `Timed out waiting for turn ${turnId} in [${[...target]}], got state=${cur?.state} phase=${cur?.phase}`,
  );
}

async function pollUntil(fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await delay(25);
  }
  throw new Error('Timed out waiting for condition');
}

/**
 * Wraps `store.db.prepare` to deterministically inject SQLite commit faults matching `predicate(sql, args)`.
 */
function installSqlFault(store, { predicate, maxThrows = 1, errorFactory = null, onBeforeThrow = null }) {
  const origPrepare = store.db.prepare.bind(store.db);
  let thrown = 0;
  store.db.prepare = (sql) => {
    const stmt = origPrepare(sql);
    const origRun = stmt.run.bind(stmt);
    stmt.run = (...args) => {
      if (thrown < maxThrows && predicate(String(sql), args)) {
        thrown++;
        onBeforeThrow?.(String(sql), args, thrown);
        const err = errorFactory
          ? errorFactory(String(sql), args, thrown)
          : Object.assign(new Error(`SQLITE_IOERR: injected fault #${thrown}`), {
              code: 'SQLITE_IOERR',
            });
        throw err;
      }
      return origRun(...args);
    };
    return stmt;
  };
  return {
    get count() {
      return thrown;
    },
    restore() {
      store.db.prepare = origPrepare;
    },
  };
}

// =============================================================================
// Phase 3 Scenario #1: Model call succeeds -> DB commit fails
// =============================================================================

test('Scenario #1a: SQLite commit failure on onAssistantMessage converges cleanly, persists partial usage, and sets verifiedPass=null', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-s1a-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-s1a-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-s1a');

  const adapter = new ScriptedAdapter(async function* () {
    yield {
      type: 'route',
      route: { provider: 'openai', accountId: 'acc-s1a', wireModel: 'gpt-5', attempts: 1, failovers: 0 },
    };
    yield { type: 'text-delta', index: 0, text: 'Model reply succeeded before DB commit failed.' };
    yield { type: 'usage', usage: { inputTokens: 88, outputTokens: 34, cacheReadTokens: 12 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  const fault = installSqlFault(store, {
    predicate: (sql) =>
      sql.includes('INSERT INTO direct_messages') && sql.includes("'assistant'"),
    maxThrows: 5,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir });
    const started = direct.startTurn(sess.id, { input: 'trigger assistant msg commit failure' });
    const settled = await waitTurnState(direct, sess.id, started.turn.id, ['completed', 'failed', 'cancelled']);

    assert.equal(fault.count, 1, 'injected fault should fire on onAssistantMessage');
    assert.equal(settled.state, 'failed', 'turn must converge to failed (never wedged running)');
    assert.equal(settled.phase, 'failed', 'phase and state must match with zero divergence');
    assert.equal(direct.getSession(sess.id).state, 'failed');
    assert.equal(settled.inputTokens, 88, 'partial input tokens must be persisted');
    assert.equal(settled.outputTokens, 34, 'partial output tokens must be persisted');

    const usageRow = store.db
      .prepare('SELECT * FROM nexus_usage WHERE sessionId=? ORDER BY id DESC LIMIT 1')
      .get(sess.id);
    assert.ok(usageRow, 'partial token usage must be recorded in nexus_usage on failed turn');
    assert.equal(usageRow.inputTokens, 88);
    assert.equal(usageRow.outputTokens, 34);
    assert.equal(usageRow.provider, 'openai');
    assert.equal(usageRow.accountId, 'acc-s1a');

    const fbRow = store.db
      .prepare("SELECT * FROM model_feedback WHERE model='mock-s1a' ORDER BY id DESC LIMIT 1")
      .get();
    assert.ok(fbRow);
    assert.equal(fbRow.success, 0);
    assert.equal(
      fbRow.verifiedPass,
      null,
      'pre-verification DB crash must record verifiedPass=null (NOT false)',
    );

    const events = direct.listEvents(sess.id, { after: 0, limit: 100 });
    assert.ok(events.some((e) => e.type === 'turn/failed' && e.turnId === started.turn.id));
    assert.equal(
      events.some((e) => e.type === 'turn/completed' && e.turnId === started.turn.id),
      false,
    );
  } finally {
    fault.restore();
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('Scenario #1b: SQLite failure on onToolResult after mutating tool receipt finishes never leaves orphaned tool_calls poisoning Turn 2', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-s1b-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-s1b-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-s1b');

  const adapter = new ScriptedAdapter(async function* (opts, idx) {
    if (idx === 0) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-orphan-write-1',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'created-before-crash.txt', content: 'persisted-on-disk\n' }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 60, outputTokens: 25 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    // Turn 2: strictly validate every assistant(tool-call) has an immediately adjacent tool result!
    for (let i = 0; i < opts.messages.length; i++) {
      const m = opts.messages[i];
      if (m.role !== 'assistant') continue;
      const calls = (m.content ?? []).filter((b) => b.type === 'tool-call');
      if (!calls.length) continue;
      for (let k = 0; k < calls.length; k++) {
        const next = opts.messages[i + 1 + k];
        assert.equal(
          next?.role,
          'tool',
          `assistant tool-call ${calls[k].id} MUST be immediately followed by role='tool'`,
        );
        assert.equal(next?.toolCallId, calls[k].id);
      }
    }
    yield { type: 'text-delta', index: 0, text: 'Turn 2 succeeded cleanly with repaired tool adjacency.' };
    yield { type: 'usage', usage: { inputTokens: 70, outputTokens: 18 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  const fault = installSqlFault(store, {
    predicate: (sql) =>
      sql.includes('INSERT INTO direct_messages') && sql.includes("'tool'"),
    maxThrows: 1,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });
    const t1 = direct.startTurn(sess.id, { input: 'write created-before-crash.txt' });
    const d1 = await waitTurnState(direct, sess.id, t1.turn.id, ['completed', 'failed', 'cancelled']);

    assert.equal(fault.count, 1);
    assert.equal(d1.state, 'failed');
    assert.equal(d1.phase, 'failed');
    assert.equal(d1.inputTokens, 60);
    assert.equal(d1.outputTokens, 25);
    assert.equal(existsSync(join(workDir, 'created-before-crash.txt')), true);

    const receipt = store.db
      .prepare("SELECT * FROM tool_receipts WHERE turnId=? AND callId='tc-orphan-write-1'")
      .get(t1.turn.id);
    assert.equal(receipt?.status, 'finished');

    // Verify Turn 1 left assistant(tool_calls) in direct_messages without the crashed role='tool' row
    const rawToolMsgs = store.db
      .prepare("SELECT * FROM direct_messages WHERE sessionId=? AND role='tool'")
      .all(sess.id);
    assert.equal(rawToolMsgs.length, 0);

    // Now start Turn 2 on the SAME session: must repair/splice adjacent tool result from tool_receipts!
    fault.restore();
    const t2 = direct.startTurn(sess.id, { input: 'continue after tool result DB crash' });
    const d2 = await waitTurnState(direct, sess.id, t2.turn.id, ['completed', 'failed', 'cancelled']);
    assert.equal(d2.state, 'completed', 'Turn 2 must succeed without HTTP 400 orphaned tool_calls');
    assert.equal(adapter.calls.length, 2);

    const turn2Msgs = adapter.calls[1].messages;
    const orphanAssistantIdx = turn2Msgs.findIndex(
      (m) => m.role === 'assistant' && m.content?.some((b) => b.id === 'tc-orphan-write-1'),
    );
    assert.ok(orphanAssistantIdx >= 0);
    const repairedToolMsg = turn2Msgs[orphanAssistantIdx + 1];
    assert.equal(repairedToolMsg?.role, 'tool');
    assert.equal(repairedToolMsg?.toolCallId, 'tc-orphan-write-1');
    assert.match(repairedToolMsg?.content?.[0]?.text ?? '', /tool_receipt/);
  } finally {
    fault.restore();
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('Scenario #1c: Terminal UPDATE direct_turns SQLite failure (one-shot & persistent) has ZERO phase/state divergence and no premature turn/completed', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-s1c-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-s1c-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-s1c');

  const adapter = new ScriptedAdapter(async function* () {
    yield { type: 'text-delta', index: 0, text: 'Completed answer before terminal DB commit.' };
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 42 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  let phaseAtTerminalFault = null;
  let completedEventsAtFault = null;
  const fault = installSqlFault(store, {
    predicate: (sql) =>
      sql.includes('UPDATE direct_turns') && sql.includes("state='completed'"),
    maxThrows: 5,
    onBeforeThrow: (_sql, args) => {
      const tid = args.at(-1);
      const row = store.db.prepare('SELECT state, phase FROM direct_turns WHERE id=?').get(tid);
      phaseAtTerminalFault = row;
      completedEventsAtFault = store.db
        .prepare(
          "SELECT type, data FROM direct_events WHERE turnId=? AND (type='turn/completed' OR (type='turn/phase_changed' AND data LIKE '%\"to\":\"completed\"%'))",
        )
        .all(tid);
    },
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir });
    const liveEvents = [];
    const unsub = direct.subscribe(sess.id, (ev) => liveEvents.push(ev));

    const started = direct.startTurn(sess.id, { input: 'fail terminal completed commit' });
    const settled = await waitTurnState(direct, sess.id, started.turn.id, ['completed', 'failed', 'cancelled']);
    unsub();

    assert.equal(fault.count, 1);
    assert.equal(
      phaseAtTerminalFault?.phase,
      'verifying',
      'deferTerminalPhase MUST prevent direct_turns.phase=completed from committing in a separate tx beforehand',
    );
    assert.equal(phaseAtTerminalFault?.state, 'running');
    assert.equal(
      completedEventsAtFault?.length,
      0,
      'ZERO turn/completed or phase=completed events may exist before atomic terminal commit succeeds',
    );

    assert.equal(settled.state, 'failed');
    assert.equal(settled.phase, 'failed');
    assert.equal(settled.inputTokens, 120);
    assert.equal(settled.outputTokens, 42);
    assert.equal(direct.getSession(sess.id).state, 'failed');

    const persisted = direct.listEvents(sess.id, { after: 0, limit: 100 });
    assert.equal(
      persisted.some((e) => e.type === 'turn/completed'),
      false,
      'rolled-back terminal commit must never leak turn/completed into direct_events',
    );
    assert.equal(
      liveEvents.some((e) => e.type === 'turn/completed'),
      false,
      'rolled-back terminal commit must never fan out turn/completed to SSE',
    );
    assert.ok(persisted.some((e) => e.type === 'turn/failed' && e.turnId === started.turn.id));

    const fbRow = store.db
      .prepare("SELECT * FROM model_feedback WHERE model='mock-s1c' ORDER BY id DESC LIMIT 1")
      .get();
    assert.equal(fbRow?.verifiedPass, null, 'terminal DB commit exception must record verifiedPass=null');
  } finally {
    fault.restore();
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

// =============================================================================
// Phase 3 Scenario #2: DB commit succeeds -> SSE publish fails
// =============================================================================

test('Scenario #2a: Poisoned SSE listener throwing EPIPE on every event never aborts turns, starves healthy listeners, breaks approvals, or skips Stop/feedback, and HTTP Last-Event-ID replays cleanly', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-s2a-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-s2a-work-'));
  writeFileSync(join(workDir, 'note.txt'), 'before\n', 'utf8');
  const token = 's2a-sse-isolation-token-1234567890';
  const svc = await service({
    root: dataDir,
    token,
    configuration: config({ env: {} }),
    workspaceRoot: workDir,
  });

  const adapter = new ScriptedAdapter(async function* (_opts, idx) {
    if (idx === 0) {
      yield { type: 'text-delta', index: 0, text: 'Preparing edit...' };
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'tc-sse-edit',
          name: 'edit_file',
          arguments: JSON.stringify({ path: 'note.txt', target: 'before', replacement: 'after' }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 15 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'Edit complete.' };
    yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 12 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  svc.pool.setDefaultModel('mock-s2a');
  svc.pool.adapter = adapter;
  svc.directAgent.adapter = adapter;
  svc.directAgent.kernel.inference.adapter = adapter;

  const baseUrl = await svc.app.listen({ port: 0, host: '127.0.0.1' });
  const auth = { Authorization: `Bearer ${token}` };

  const poisonedTypes = new Set();
  const healthyEvents = [];

  // Register poisoned listener BEFORE healthy listener on BOTH global and session buses!
  const unsubPoisonGlobal = svc.directAgent.subscribe(null, (ev) => {
    poisonedTypes.add(ev.type);
    throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  });

  try {
    const sess = svc.directAgent.createSession({ workspaceRoot: workDir, permissionMode: 'approval' });
    const unsubPoisonSess = svc.directAgent.subscribe(sess.id, (ev) => {
      poisonedTypes.add(ev.type);
      throw Object.assign(new Error('write EPIPE session'), { code: 'EPIPE' });
    });
    const unsubHealthy = svc.directAgent.subscribe(sess.id, (ev) => {
      healthyEvents.push(ev);
    });

    // Note seq before starting turn for Last-Event-ID reconnect replay check
    const started = svc.directAgent.startTurn(sess.id, { input: 'edit note.txt' });

    // Wait for pending approval despite poisoned listeners throwing on approval/requested!
    const pending = await pollUntil(() => {
      const list = svc.directAgent.listApprovals({ sessionId: sess.id, status: 'pending' });
      return list.length > 0 ? list[0] : null;
    });

    // Approve via HTTP -> MUST return 200 even though poisoned listener throws on approval/resolved!
    const decRes = await fetch(`${baseUrl}/v1/approvals/${pending.id}/decision`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', scope: 'once' }),
    });
    assert.equal(decRes.status, 200, 'approval decision HTTP endpoint must not return 500 when SSE listener throws');

    const settled = await waitTurnState(svc.directAgent, sess.id, started.turn.id, [
      'completed',
      'failed',
      'cancelled',
    ]);
    unsubPoisonSess();
    unsubHealthy();

    assert.equal(settled.state, 'completed');
    assert.equal(settled.phase, 'completed');
    assert.equal(readFileSync(join(workDir, 'note.txt'), 'utf8'), 'after\n');

    // Poisoned listener threw across all event types, yet healthy listener received EVERY one of them!
    for (const expectedType of [
      'assistant/delta',
      'turn/phase_changed',
      'tool/receipt',
      'approval/resolved',
      'turn/completed',
    ]) {
      assert.ok(poisonedTypes.has(expectedType), `poisoned listener should have thrown on ${expectedType}`);
      assert.ok(
        healthyEvents.some((e) => e.type === expectedType),
        `healthy listener must still receive ${expectedType}`,
      );
    }

    // Post-commit side effects (model_feedback) still ran!
    const fb = svc.store.db
      .prepare("SELECT * FROM model_feedback WHERE model='mock-s2a' ORDER BY id DESC LIMIT 1")
      .get();
    assert.ok(fb && fb.success === 1, 'post-commit model_feedback must not be skipped by SSE failure');

    // Reconnecting HTTP client with Last-Event-ID replays turn/completed cleanly
    const firstSeq = healthyEvents.find((e) => e.seq > 0)?.seq ?? 0;
    const sseAbort = new AbortController();
    const sseRes = await fetch(`${baseUrl}/v1/sessions/${sess.id}/stream`, {
      headers: { ...auth, 'Last-Event-ID': String(Math.max(0, firstSeq - 1)) },
      signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const dec = new TextDecoder();
    let replayed = '';
    try {
      while (!replayed.includes('event: turn/completed')) {
        const { done, value } = await reader.read();
        if (done) break;
        replayed += dec.decode(value, { stream: true });
      }
    } finally {
      sseAbort.abort();
      reader.releaseLock();
    }
    assert.match(replayed, /event: turn\/completed/);
  } finally {
    unsubPoisonGlobal();
    await svc.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('Scenario #2b & #2c: Poisoned listener on reconciliation/resolved never blocks resume, and SSE paginated backlog replays >350 events without truncation', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-s2bc-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-s2bc-work-'));
  const token = 's2bc-reconcile-backlog-token-1234567';
  const svc = await service({
    root: dataDir,
    token,
    configuration: config({ env: {} }),
    workspaceRoot: workDir,
  });

  const adapter = new ScriptedAdapter(async function* () {
    yield { type: 'text-delta', index: 0, text: 'Resumed cleanly after reconciliation.' };
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  svc.pool.setDefaultModel('mock-s2bc');
  svc.pool.adapter = adapter;
  svc.directAgent.adapter = adapter;
  svc.directAgent.kernel.inference.adapter = adapter;

  const baseUrl = await svc.app.listen({ port: 0, host: '127.0.0.1' });
  const auth = { Authorization: `Bearer ${token}` };

  try {
    const sess = svc.directAgent.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });

    // Seed an outcome_unknown receipt so turn enters reconciling
    const now = Date.now();
    svc.store.tx(() => {
      svc.store.db
        .prepare(
          `INSERT INTO tool_receipts(
            id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
            replayable, outward, argsDigest, status, durationMs, createdAt, updatedAt
          ) VALUES('rcpt-s2b',?,'prev-turn','c-s2b','mcp__ext','high','external_network',0,1,'dig','outcome_unknown',0,?,?)`,
        )
        .run(sess.id, now, now);
    });

    const started = svc.directAgent.startTurn(sess.id, { input: 'verify external deploy' });
    const parked = await waitTurnState(svc.directAgent, sess.id, started.turn.id, ['reconciling', 'completed', 'failed']);
    assert.equal(parked.state, 'reconciling');

    // Poisoned listener throws on reconciliation/resolved BEFORE healthy listener
    let poisonedRec = false;
    let healthyRec = false;
    const unsubPoison = svc.directAgent.subscribe(sess.id, (ev) => {
      if (ev.type === 'reconciliation/resolved') {
        poisonedRec = true;
        throw Object.assign(new Error('EPIPE on reconciliation/resolved'), { code: 'EPIPE' });
      }
    });
    const unsubHealthy = svc.directAgent.subscribe(sess.id, (ev) => {
      if (ev.type === 'reconciliation/resolved') healthyRec = true;
    });

    const pendingRecs = svc.directAgent.reconciler.listReconciliations({ sessionId: sess.id, status: 'pending' });
    assert.equal(pendingRecs.length, 1);

    const resolved = svc.directAgent.reconciler.resolveReconciliation(pendingRecs[0].id, {
      outcome: 'happened',
      note: 'verified externally',
    });
    assert.ok(resolved);
    assert.equal(poisonedRec, true);
    assert.equal(healthyRec, true);

    const completed = await waitTurnState(svc.directAgent, sess.id, started.turn.id, ['completed', 'failed']);
    unsubPoison();
    unsubHealthy();
    assert.equal(completed.state, 'completed', 'turn must resume and complete despite poisoned reconciliation/resolved listener');

    // #2c: Paginated SSE backlog replay > 350 events (must NOT silently truncate at 300!)
    const sBacklog = svc.directAgent.createSession({ workspaceRoot: workDir });
    const firstEv = svc.directAgent.eventRouter.emitPersisted({
      sessionId: sBacklog.id,
      type: 'turn/started',
      data: { idx: 0 },
      audit: false,
    });
    svc.store.tx(() => {
      const stmt = svc.store.db.prepare(
        'INSERT INTO direct_events(sessionId, turnId, type, data, at) VALUES(?,?,?,?,?)',
      );
      for (let i = 1; i <= 360; i++) {
        stmt.run(sBacklog.id, null, 'file/changed', JSON.stringify({ idx: i }), now + i);
      }
      stmt.run(
        sBacklog.id,
        'turn-tail',
        'turn/completed',
        JSON.stringify({ idx: 361, marker: 'FINAL_EVENT_361' }),
        now + 400,
      );
    });

    const sseAbort = new AbortController();
    const sseRes = await fetch(`${baseUrl}/v1/sessions/${sBacklog.id}/stream`, {
      headers: { ...auth, 'Last-Event-ID': String(firstEv.seq) },
      signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const dec = new TextDecoder();
    let body = '';
    try {
      while (!body.includes('FINAL_EVENT_361')) {
        const { done, value } = await reader.read();
        if (done) break;
        body += dec.decode(value, { stream: true });
      }
    } finally {
      sseAbort.abort();
      reader.releaseLock();
    }
    const replayedEvents = body
      .split(/\r?\n\r?\n/)
      .filter((f) => f.includes('data: '))
      .map((f) => JSON.parse(f.match(/^data:\s*(.+)$/m)[1]));
    assert.equal(replayedEvents.length, 361, 'all 361 events past Last-Event-ID must replay without 300-event truncation');
    assert.equal(replayedEvents.at(-1).type, 'turn/completed');
  } finally {
    await svc.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

// =============================================================================
// P1 Verifier output_truncated, Inference cancellation, Prompt Cache, Compaction,
// Late Steering, Concurrency/Idempotency, Session Repo & Route Hardening
// =============================================================================

test('P1 Verifier output_truncated gate works end-to-end and aborted InferenceEngine stream throws CancellationError', async () => {
  // Unit verifyTurn check for both object and string reasons
  assert.ok(
    verifyTurn({ events: [{ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }], text: 'cut' }).reasons.includes(
      'output_truncated',
    ),
  );
  assert.ok(
    verifyTurn({ events: [{ type: 'turn/end', data: { reason: 'length' } }], text: 'cut' }).reasons.includes(
      'output_truncated',
    ),
  );

  // InferenceEngine preserves finishReason kind from object AND maps ECONNRESET during abort to CancellationError
  const abortCtrl = new AbortController();
  const infEngine = new InferenceEngine({
    async *stream() {
      abortCtrl.abort('user_stop');
      throw Object.assign(new Error('socket ECONNRESET'), { code: 'ECONNRESET' });
    },
  });
  await assert.rejects(
    () => infEngine.streamStep({ model: 'm1', messages: [], signal: abortCtrl.signal }),
    (err) => err instanceof CancellationError && err.retryable === false,
  );

  // End-to-end DirectAgent: truncated output triggers verifier repair -> if still truncated, turn FAILS
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-trunc-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-trunc-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-trunc');

  const adapter = new ScriptedAdapter(async function* () {
    yield { type: 'text-delta', index: 0, text: 'Half-written answer that got cut off...' };
    yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 4096 } };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  });
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir });
    const started = direct.startTurn(sess.id, { input: 'write full essay' });
    const settled = await waitTurnState(direct, sess.id, started.turn.id, ['completed', 'failed']);
    assert.equal(settled.state, 'failed', 'persistently max-tokens truncated output MUST fail verification');
    assert.ok(settled.verdict?.reasons?.includes('output_truncated'));
    assert.equal(adapter.calls.length, 2, 'must attempt 1 repair round before failing');
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('P1 Prompt Cache static system prompt, multi-section liveContextNotes non-duplication, restart stability, and Stage-2 role alternation', async () => {
  // 1. Multi-section liveContextNotes unit check (combined single user message)
  const s1 = [
    { source: 'runtime', id: 'runtime_env', text: 'workspaceRoot: /repo\nmode: direct' },
    { source: 'workspace', id: 'project_instructions', text: '# AGENTS.md\n\nRule 1\n\nRule 2\n' },
    { source: 'memory', id: 'workspace_memory', text: 'fact-v1' },
  ];
  const d1 = liveContextNotes(s1, []);
  assert.equal(d1.length, 3);
  const combinedHistory = [
    { role: 'user', content: [{ type: 'text', text: d1.map((d) => d.text).join('\n\n') }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ack' }] },
  ];
  // Identical sections -> ZERO deltas!
  assert.equal(liveContextNotes(s1, combinedHistory).length, 0);
  // Only workspace_memory changes -> ONLY 1 delta (runtime_env & project_instructions NOT re-emitted!)
  const s2 = [s1[0], s1[1], { source: 'memory', id: 'workspace_memory', text: 'fact-v2' }];
  const d2 = liveContextNotes(s2, combinedHistory);
  assert.equal(d2.length, 1);
  assert.match(d2[0].text, /fact-v2/);
  assert.doesNotMatch(d2[0].text, /AGENTS\.md/);

  // 2. Stage-2 compaction never places role:'assistant' directly after role:'system'
  const longConv = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    ...Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `msg ${i} ` + 'token '.repeat(450) }],
    })),
    { role: 'user', content: [{ type: 'text', text: 'latest' }] },
  ];
  const comp = await compactTwoStage(
    { messages: longConv },
    {
      contextWindow: 4000,
      reserveTokens: 1000,
      keepRecentTokens: 200,
      summarize: async () => 'Structured summary of earlier turns.',
    },
  );
  assert.equal(comp.stage, 'summary');
  assert.equal(comp.options.messages[0].role, 'system');
  assert.equal(comp.options.messages[1].role, 'user', 'must wrap summary with user message right after system');
  assert.equal(comp.options.messages[2].role, 'assistant');

  // 3. Multi-turn DirectAgent + simulated restart (clearing RAM emittedTailHistory)
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-pcache-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-pcache-work-'));
  writeFileSync(join(workDir, 'AGENTS.md'), '# Project Rules\nSTATIC_AGENTS_MARKER_XYZ\n', 'utf8');
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-cache');

  const adapter = new ScriptedAdapter(async function* (_opts, idx) {
    yield { type: 'text-delta', index: 0, text: `reply-${idx}` };
    yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10, cacheReadTokens: 20 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir });
    const t1 = direct.startTurn(sess.id, { input: 'turn 1' });
    assert.equal((await waitTurnState(direct, sess.id, t1.turn.id, ['completed', 'failed'])).state, 'completed');

    // Mutate only memory before Turn 2
    direct.memoryService.remember({
      scopeType: 'workspace',
      scopeId: workDir,
      key: 'delta_only',
      value: 'ONLY_THIS_CHANGED_V2',
    });
    const t2 = direct.startTurn(sess.id, { input: 'turn 2' });
    assert.equal((await waitTurnState(direct, sess.id, t2.turn.id, ['completed', 'failed'])).state, 'completed');

    // Simulate process restart by wiping RAM emittedTailHistory before Turn 3 (no context changes!)
    direct.contextAssembler.emittedTailHistory.clear();
    const t3 = direct.startTurn(sess.id, { input: 'turn 3 after restart' });
    assert.equal((await waitTurnState(direct, sess.id, t3.turn.id, ['completed', 'failed'])).state, 'completed');

    const m1 = adapter.calls[0].messages;
    const m2 = adapter.calls[1].messages;
    const m3 = adapter.calls[2].messages;

    // Static system prompt is 100% byte-identical across all 3 turns
    assert.equal(JSON.stringify(m1[0]), JSON.stringify(m2[0]));
    assert.equal(JSON.stringify(m2[0]), JSON.stringify(m3[0]));

    // KV prefix byte-identical from Turn 1 -> Turn 2 -> Turn 3 (even after RAM cache wipe!)
    assert.equal(JSON.stringify(m2.slice(0, m1.length)), JSON.stringify(m1));
    assert.equal(JSON.stringify(m3.slice(0, m2.length)), JSON.stringify(m2));

    // AGENTS.md appears ONLY ONCE across the entire Turn 2 & Turn 3 prompts (zero re-emission!)
    const countOccurrences = (msgs, needle) =>
      JSON.stringify(msgs).split(needle).length - 1;
    assert.equal(countOccurrences(m2, 'STATIC_AGENTS_MARKER_XYZ'), 1, 'AGENTS.md must NOT be re-emitted on Turn 2');
    assert.equal(countOccurrences(m3, 'STATIC_AGENTS_MARKER_XYZ'), 1, 'AGENTS.md must NOT be re-emitted after restart on Turn 3');
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('P1 AgentLoop preserves compaction across steps, drains lateSteers after earlier steer, and keeps shutdown turn phase recoverable', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-loopfix-data-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  let compactCalls = 0;
  let steerStep = 0;
  const steerQueue = ['initial steer'];

  const mockAdapter = {
    async *stream({ messages }) {
      steerStep++;
      if (steerStep === 1) {
        // Push a late steer WHILE inference is running (even though initial steer was already drained!)
        steerQueue.push('late steer during inference');
        yield { type: 'text-delta', text: 'first idle reply' };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      // Step 2 must see BOTH compacted message AND the late steer!
      const allText = messages.map((m) => m.content?.map((b) => b.text || '').join('')).join('\n');
      assert.match(allText, /COMPACTED_MARKER/);
      assert.match(allText, /late steer during inference/);
      yield { type: 'text-delta', text: 'final reply honoring late steer' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const kernel = new AgentRuntimeKernel({ store, adapter: mockAdapter });
  try {
    const res = await kernel.executeTurn({
      sessionId: 'sess-loopfix',
      turnId: 'turn-loopfix-1',
      profile: {
        id: 'test',
        defaultMaxSteps: 5,
        streamDeltas: false,
        emitAssistantMessage: false,
        emitToolEvents: false,
        persistTurn: false,
      },
      input: 'start',
      model: 'mock',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: 'HUGE_UNCOMPACTED_PAYLOAD' }] },
      ],
      drainSteering: () => steerQueue.splice(0),
      contextManager: {
        async prepareRequest(opts) {
          const hasUncompacted = opts.messages.some((m) =>
            m.content?.some((b) => String(b.text || '').includes('HUGE_UNCOMPACTED_PAYLOAD')),
          );
          if (!hasUncompacted) return { options: opts, stage: 'none' };
          compactCalls++;
          return {
            stage: 'summary',
            tokens: 50,
            options: {
              ...opts,
              messages: [
                opts.messages[0],
                { role: 'user', content: [{ type: 'text', text: 'COMPACTED_MARKER' }] },
                ...opts.messages.slice(2),
              ],
            },
          };
        },
      },
    });
    assert.equal(res.status, 'completed');
    assert.equal(res.steps, 2);
    assert.equal(compactCalls, 1, 'compaction must persist across steps without re-triggering on step 2');

    // Shutdown abort must NOT transition direct_turns.phase to 'cancelled'
    const now = Date.now();
    store.tx(() => {
      store.db
        .prepare(
          "INSERT INTO direct_sessions(id, title, workspaceRoot, model, state, createdAt, updatedAt) VALUES('s-shut','Shut','/tmp','m','running',?,?)",
        )
        .run(now, now);
      store.db
        .prepare(
          "INSERT INTO direct_turns(id, sessionId, input, model, state, phase, step, createdAt) VALUES('t-shut','s-shut','hi','m','running','init',0,?)",
        )
        .run(now);
    });
    const shutCtrl = new AbortController();
    const shutKernel = new AgentRuntimeKernel({
      store,
      adapter: {
        async *stream() {
          shutCtrl.abort('shutdown');
          await delay(10);
          yield { type: 'text-delta', text: 'never' };
        },
      },
    });
    await assert.rejects(() =>
      shutKernel.executeTurn({
        sessionId: 's-shut',
        turnId: 't-shut',
        profile: 'default',
        input: 'hi',
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: shutCtrl.signal,
      }),
    );
    const turnRow = store.db.prepare("SELECT state, phase FROM direct_turns WHERE id='t-shut'").get();
    assert.equal(turnRow.state, 'running');
    assert.notEqual(turnRow.phase, 'cancelled', 'shutdown abort must keep turn phase recoverable (not cancelled)');
    shutKernel.close();
  } finally {
    kernel.close();
    store.close();
    rmDirSafe(dataDir);
  }
});

test('P1/P2 Concurrency, idempotent clientTurnId, cancelTurn->Swarm, rewindSession rowid/cleanup, deleteSession cascade, and Route hardening', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-hard-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-hard-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const metrics = new MetricsCollector({ store });
  const pool = new AccountPool(store, { root: dataDir, metrics });
  pool.setDefaultModel('mock-hard');

  let releaseTurn1;
  const turn1Blocked = new Promise((r) => {
    releaseTurn1 = r;
  });

  const adapter = new ScriptedAdapter(async function* (opts) {
    const lastText = opts.messages.at(-1)?.content?.[0]?.text ?? '';
    if (lastText.includes('HOLD_TURN')) {
      await Promise.race([
        turn1Blocked,
        new Promise((r) => opts.signal?.addEventListener('abort', r, { once: true })),
      ]);
      opts.signal?.throwIfAborted?.();
    }
    yield { type: 'text-delta', index: 0, text: 'ok' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    metrics,
  });

  // Mount api() WITHOUT controlPlane to verify GET /v1/runtime/overview fallback never crashes!
  const token = 'hardening-test-token-1234567890abcd';
  const app = api(store, token, { models: [], list: () => [] }, {
    pool,
    directAgent: direct,
    metrics,
  });
  const headers = { authorization: `Bearer ${token}` };

  try {
    // 1. GET /v1/runtime/overview without controlPlane -> 200 (no TypeError crash!)
    const ovRes = await app.inject({ method: 'GET', url: '/v1/runtime/overview', headers });
    assert.equal(ovRes.statusCode, 200);
    assert.equal(ovRes.json().ok, true);

    // 2. Concurrent startTurn with fresh clientTurnId rejected (409 SESSION_BUSY), same clientTurnId deduped!
    const sess = direct.createSession({ workspaceRoot: workDir });
    const first = direct.startTurn(sess.id, { input: 'HOLD_TURN', clientTurnId: 'cid-1' });
    const dup = direct.startTurn(sess.id, { input: 'HOLD_TURN', clientTurnId: 'cid-1' });
    assert.equal(dup.turn.id, first.turn.id, 'same clientTurnId must return idempotent turn');
    assert.throws(
      () => direct.startTurn(sess.id, { input: 'second concurrent', clientTurnId: 'cid-fresh-2' }),
      (err) => err.code === 'SESSION_BUSY' && err.status === 409,
    );

    // 3. cancelTurn also cancels active Swarm runs belonging to the session
    const submitted = direct.swarmOrchestrator.submitRun({
      sessionId: sess.id,
      rootTurnId: first.turn.id,
      goal: 'HOLD_TURN swarm',
      workspaceRoot: workDir,
      nodes: [{ nodeKey: 'n1', taskType: 'research', objective: 'HOLD_TURN node', dependencies: [] }],
    });
    direct.cancelTurn(first.turn.id);
    releaseTurn1();
    const cancelledSwarm = direct.swarmOrchestrator.getRun(submitted.runId);
    assert.equal(cancelledSwarm.status, 'cancelled', 'cancelTurn must cancel active swarm_runs on that session');

    // 4. rewindSession uses rowid tiebreaker (same-ms turns) & deletes orphaned tool_receipts / checkpoints
    const sRew = direct.createSession({ workspaceRoot: workDir });
    const sameTs = Date.now();
    store.tx(() => {
      store.db
        .prepare(
          "INSERT INTO direct_turns(id, sessionId, input, model, state, phase, createdAt) VALUES('t-rew-1',?,'m1','mock','completed','completed',?)",
        )
        .run(sRew.id, sameTs);
      store.db
        .prepare(
          "INSERT INTO direct_turns(id, sessionId, input, model, state, phase, createdAt) VALUES('t-rew-2',?,'m2','mock','completed','completed',?)",
        )
        .run(sRew.id, sameTs);
      store.db
        .prepare(
          "INSERT INTO direct_messages(sessionId, turnId, role, content, createdAt) VALUES(?,'t-rew-1','user','m1',?)",
        )
        .run(sRew.id, sameTs);
      store.db
        .prepare(
          "INSERT INTO direct_messages(sessionId, turnId, role, content, createdAt) VALUES(?,'t-rew-2','user','m2',?)",
        )
        .run(sRew.id, sameTs);
      store.db
        .prepare(
          `INSERT INTO tool_receipts(
            id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
            replayable, outward, argsDigest, status, durationMs, createdAt, updatedAt
          ) VALUES('r-rew-2',?,'t-rew-2','c2','bash','high','irreversible_side_effect',0,0,'d','outcome_unknown',0,?,?)`,
        )
        .run(sRew.id, sameTs, sameTs);
      store.db
        .prepare(
          "INSERT INTO runtime_checkpoints(id, sessionId, turnId, step, phase, stateJson, createdAt) VALUES('cp-rew-2',?,'t-rew-2',1,'tools','{}',?)",
        )
        .run(sRew.id, sameTs);
    });
    const rewRes = await direct.rewindSession(sRew.id, { turnId: 't-rew-2', scope: 'both' });
    assert.equal(rewRes.ok, true);
    assert.ok(store.db.prepare("SELECT id FROM direct_turns WHERE id='t-rew-1'").get(), 'earlier same-ms turn must NOT be deleted');
    assert.equal(store.db.prepare("SELECT id FROM direct_turns WHERE id='t-rew-2'").get(), undefined);
    assert.equal(store.db.prepare("SELECT id FROM tool_receipts WHERE id='r-rew-2'").get(), undefined);
    assert.equal(store.db.prepare("SELECT id FROM runtime_checkpoints WHERE id='cp-rew-2'").get(), undefined);

    // 5. deleteSession cascades tool_receipts, runtime_checkpoints, runtime_jobs, child_notifications, worktree_leases
    const sDel = direct.createSession({ workspaceRoot: workDir });
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO tool_receipts(
            id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
            replayable, outward, argsDigest, status, durationMs, createdAt, updatedAt
          ) VALUES('r-del',?,'t-del','c','read_file','low','read_only',1,0,'d','finished',1,?,?)`,
        )
        .run(sDel.id, sameTs, sameTs);
      store.db
        .prepare(
          "INSERT INTO runtime_checkpoints(id, sessionId, turnId, step, phase, stateJson, createdAt) VALUES('cp-del',?,'t-del',1,'init','{}',?)",
        )
        .run(sDel.id, sameTs);
      store.db
        .prepare(
          "INSERT INTO runtime_jobs(id, kind, sessionId, turnId, payload, status, idempotencyKey, createdAt, updatedAt) VALUES('j-del','direct_turn',?,'t-del','{}','done','idem-del',?,?)",
        )
        .run(sDel.id, sameTs, sameTs);
      store.db
        .prepare(
          "INSERT INTO child_notifications(id, idempotencyKey, parentSessionId, childSessionId, status, payloadJson, createdAt) VALUES('cn-del','cn-idem',?,'child-x','completed','{}',?)",
        )
        .run(sDel.id, sameTs);
      store.db
        .prepare(
          "INSERT INTO worktree_leases(id, ownerId, sessionId, workspaceRoot, worktreePath, status, createdAt) VALUES('wl-del','own',?,?,'/tmp/wt','cleaned',?)",
        )
        .run(sDel.id, workDir, sameTs);
    });
    direct.deleteSession(sDel.id);
    for (const [tbl, col] of [
      ['tool_receipts', 'sessionId'],
      ['runtime_checkpoints', 'sessionId'],
      ['runtime_jobs', 'sessionId'],
      ['child_notifications', 'parentSessionId'],
      ['worktree_leases', 'sessionId'],
    ]) {
      assert.equal(
        store.db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE ${col}=?`).get(sDel.id).n,
        0,
        `deleteSession must cascade delete ${tbl}`,
      );
    }

    // 6. Route security hardening: git option injection, memory secret redaction, hooks/approve expectedDigest
    const badCheckout = await app.inject({
      method: 'POST',
      url: '/v1/git/checkout',
      headers,
      payload: { branch: '--help' },
    });
    assert.equal(badCheckout.statusCode, 400);

    const badInit = await app.inject({
      method: 'POST',
      url: '/v1/git/init',
      headers,
      payload: { initialBranch: '-bad-flag' },
    });
    assert.equal(badInit.statusCode, 400);

    const memRes = await app.inject({
      method: 'PUT',
      url: '/v1/memory?scope=global',
      headers,
      payload: {
        key: 'secret_note',
        value: 'Leaked key sk-proj-supersecret1234567890abcdef and Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb',
      },
    });
    assert.equal(memRes.statusCode, 200);
    assert.ok(!memRes.json().value.includes('supersecret1234567890abcdef'));
    assert.ok(!memRes.json().value.includes('eyJhbGciOiJIUzI1NiJ9'));

    const badHookApprove = await app.inject({
      method: 'POST',
      url: '/v1/hooks/approve',
      headers,
      payload: { filePath: join(workDir, '.agent-us', 'hooks.json') },
    });
    assert.equal(badHookApprove.statusCode, 400);
    assert.equal(badHookApprove.json().error.code, 'EXPECTED_DIGEST_REQUIRED');
  } finally {
    await direct.close();
    await app.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

// =============================================================================
// Phase 4 Production Observability End-to-End (12 Trace Fields + 10 Truthful KPIs
// + Strict Real vs Synthetic Traffic Separation + Pool Routing Failover Telemetry)
// =============================================================================

test('Phase 4 Observability E2E: all 10 KPIs, all 12 trace fields, pool routing failover, truthful verifier success rate, and strict synthetic separation', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-obs-e2e-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-obs-e2e-work-'));
  const token = 'obs-e2e-bearer-token-1234567890abcd';
  const svc = await service({
    root: dataDir,
    token,
    configuration: config({ env: {} }),
    workspaceRoot: workDir,
  });

  // Configure 2 pool accounts to exercise PoolLlmAdapter.stream failover & model_route metrics
  const accPrimary = svc.pool.createAccount({
    preset: 'openai',
    label: 'primary-429',
    apiKey: 'sk-test-primary-111111111111',
    endpoint: 'http://127.0.0.1:1/v1',
    priority: 1,
  });
  const accBackup = svc.pool.createAccount({
    preset: 'deepseek',
    label: 'backup-ok',
    apiKey: 'sk-test-backup-222222222222',
    endpoint: 'http://127.0.0.1:2/v1',
    priority: 2,
  });
  svc.pool.setDefaultModel('obs-model');

  // Script PoolLlmAdapter.streamRoute directly so real PoolLlmAdapter.stream runs route selection,
  // 429 cooldown failover, { type: 'route' } emission, and model_route metric recording!
  let routeCallIdx = 0;
  svc.pool.adapter.streamRoute = async function* (route, opts) {
    routeCallIdx++;
    const lastUser = opts.messages?.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const hasTool = opts.messages?.some((m) => m.role === 'tool');

    // First call hits primary -> 429 rate-limit -> fails over to backup!
    if (routeCallIdx === 1 && route.accountId === accPrimary.id) {
      throw Object.assign(new Error('HTTP 429 rate limit exceeded'), { status: 429 });
    }

    if (lastUser.includes('PROD_VERIFIED_TOOL') && !hasTool) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-obs-write-1',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'obs-proof.txt', content: 'verified\n' }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    const isSelfClaimScenario = opts.messages?.some(
      (m) => m.role === 'user' && String(m.content?.[0]?.text ?? '').includes('PROD_SELF_CLAIM_LIE'),
    );
    const hasFailedBashCall = opts.messages?.some(
      (m) => m.role === 'tool' && m.toolCallId === 'tc-obs-fail-bash',
    );
    if (isSelfClaimScenario) {
      if (!hasFailedBashCall) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-obs-fail-bash',
            name: 'bash',
            arguments: JSON.stringify({ command: 'node -e "process.exit(1)"' }),
          },
        };
        yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 10 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      // Model falsely claims all tests passed (both initially AND on repair)! Deterministic EvidenceVerifier MUST reject!
      yield { type: 'text-delta', index: 0, text: 'All tests passed with 0 failures! Build succeeded.' };
      yield { type: 'usage', usage: { inputTokens: 60, outputTokens: 15 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    yield { type: 'text-delta', index: 0, text: `Done for: ${lastUser.slice(0, 40)}` };
    yield { type: 'usage', usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 40 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };

  const auth = { authorization: `Bearer ${token}` };

  try {
    // 1. Production verified tool-backed turn (exercises primary 429 failover -> backup deepseek)
    const prodSessRes = await svc.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth,
      payload: { title: 'Prod Verified', workspaceRoot: workDir, permissionMode: 'full-access' },
    });
    assert.equal(prodSessRes.statusCode, 200);
    const prodSess = prodSessRes.json();
    assert.equal(prodSess.isSynthetic, false);
    assert.equal(prodSess.trafficSource, 'production');

    const prodT1Res = await svc.app.inject({
      method: 'POST',
      url: `/v1/sessions/${prodSess.id}/turns`,
      headers: auth,
      payload: { input: 'PROD_VERIFIED_TOOL write obs-proof.txt' },
    });
    assert.equal(prodT1Res.statusCode, 200);
    const prodT1 = await waitTurnState(svc.directAgent, prodSess.id, prodT1Res.json().turn.id, [
      'completed',
      'failed',
    ]);
    assert.equal(prodT1.state, 'completed');

    // Verify actual routed provider & accountId were recorded (NOT hardcoded 'pool' / null!)
    const prodUsage = svc.store.db
      .prepare('SELECT * FROM nexus_usage WHERE sessionId=? ORDER BY id DESC LIMIT 1')
      .get(prodSess.id);
    assert.equal(prodUsage.provider, 'deepseek');
    assert.equal(prodUsage.accountId, accBackup.id);
    assert.equal(prodUsage.isSynthetic, 0);

    const prodFb = svc.store.db
      .prepare("SELECT * FROM model_feedback WHERE provider='deepseek' ORDER BY id DESC LIMIT 1")
      .get();
    assert.ok(prodFb);
    assert.equal(prodFb.isSynthetic, 0);

    // 2. Production turn where model lies ("All tests passed") -> deterministic verdict rejects it!
    const prodT2Res = await svc.app.inject({
      method: 'POST',
      url: `/v1/sessions/${prodSess.id}/turns`,
      headers: auth,
      payload: { input: 'PROD_SELF_CLAIM_LIE run failing test' },
    });
    const prodT2 = await waitTurnState(svc.directAgent, prodSess.id, prodT2Res.json().turn.id, [
      'completed',
      'failed',
    ]);
    assert.equal(prodT2.state, 'failed');

    // 3. Client provenance spoofing is ignored; only the server-side probe path is synthetic.
    const synthSessRes = await svc.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { ...auth, 'x-agent-traffic-source': 'synthetic' },
      payload: { title: 'Synthetic Eval', workspaceRoot: workDir, permissionMode: 'full-access' },
    });
    assert.equal(synthSessRes.statusCode, 200);
    const synthSess = synthSessRes.json();
    assert.equal(synthSess.isSynthetic, false, 'client header must not mark a session synthetic');
    assert.equal(synthSess.trafficSource, 'production');

    const synthTurnRes = await svc.app.inject({
      method: 'POST',
      url: `/v1/sessions/${synthSess.id}/turns`,
      headers: { ...auth, 'x-agent-traffic-source': 'synthetic' },
      payload: { input: 'synthetic probe question' },
    });
    const synthTurn = await waitTurnState(svc.directAgent, synthSess.id, synthTurnRes.json().turn.id, [
      'completed',
      'failed',
    ]);
    assert.equal(synthTurn.state, 'completed');

    // /v1/models/test MUST be tagged as probe/synthetic
    const probeRes = await svc.app.inject({
      method: 'POST',
      url: '/v1/models/test',
      headers: auth,
      payload: { model: 'obs-model' },
    });
    assert.equal(probeRes.statusCode, 200);
    assert.equal(probeRes.json().ok, true);

    // 4. Seed a correlated Swarm run + artifact + metrics record to verify all 12 trace fields end-to-end
    const now = Date.now();
    svc.metrics.record('swarm_node_settled', {
      runId: 'run-obs-12',
      nodeId: 'node-obs-12',
      sessionId: prodSess.id,
      turnId: prodT1.id,
      jobId: prodT1.jobId,
      workerId: svc.directAgent.recoveryWorker.workerId,
      attempt: 1,
      fence: 'fence-obs-12',
      model: 'obs-model',
      provider: 'deepseek',
      accountId: accBackup.id,
      toolCallId: 'tc-obs-write-1',
      artifactId: 'art-obs-12',
      ok: true,
      durationMs: 42,
      at: now,
    });

    // 5. Query GET /v1/observability/metrics?windowHours=24&includeSynthetic=false (DEFAULT)
    const prodMetricsRes = await svc.app.inject({
      method: 'GET',
      url: '/v1/observability/metrics?windowHours=24&includeSynthetic=false',
      headers: auth,
    });
    assert.equal(prodMetricsRes.statusCode, 200);
    const pm = prodMetricsRes.json();

    // Assert ALL 10 KPIs exist
    for (const kpi of [
      'agentTaskSuccessRate',
      'verificationPassRate',
      'toolFailureRate',
      'recoverySuccessRate',
      'duplicateExecutionCount',
      'reconciliationCount',
      'swarmCompletionTime',
      'averageTokenUsage',
      'budgetOverrun',
      'modelRoutingSuccessRate',
      'trafficBreakdown',
    ]) {
      assert.ok(Object.hasOwn(pm, kpi), `metrics response missing KPI: ${kpi}`);
    }

    // Strict real vs synthetic separation: ONLY the 2 production turns (1 pass, 1 verifier fail -> 0.5)!
    // The synthetic completed turn MUST NOT inflate production success rate!
    assert.equal(pm.agentTaskSuccessRate.directTurns.total, 3);
    assert.equal(pm.agentTaskSuccessRate.directTurns.succeeded, 2);
    assert.equal(pm.agentTaskSuccessRate.directTurns.failed, 1);
    assert.equal(pm.agentTaskSuccessRate.rate, 0.6667);
    assert.ok(pm.trafficBreakdown.syntheticCount > 0, 'synthetic traffic must be tracked separately');

    // Model routing KPI reflects real failover & cooldown rejection (and excludes /v1/models/test probe!)
    assert.ok(pm.modelRoutingSuccessRate.totalRequests >= 1);
    assert.equal(pm.modelRoutingSuccessRate.overallSuccessRate, 1);
    assert.ok(pm.modelRoutingSuccessRate.failoverRate > 0, 'failover from primary 429 must be reflected');
    assert.ok(pm.modelRoutingSuccessRate.cooldownRejections >= 1, '429 cooldown rejection must be counted');

    // Client-spoofed traffic remains production; the internal model probe is synthetic.
    const allMetricsRes = await svc.app.inject({
      method: 'GET',
      url: '/v1/observability/metrics?windowHours=24&includeSynthetic=true',
      headers: auth,
    });
    assert.equal(allMetricsRes.statusCode, 200);
    const am = allMetricsRes.json();
    assert.equal(am.agentTaskSuccessRate.directTurns.total, 3);
    assert.equal(am.agentTaskSuccessRate.directTurns.succeeded, 2);
    assert.ok(am.modelRoutingSuccessRate.totalRequests > pm.modelRoutingSuccessRate.totalRequests);

    // 6. GET /v1/runtime/overview remains backward-compatible and adds metricsSummary
    const ovRes = await svc.app.inject({ method: 'GET', url: '/v1/runtime/overview', headers: auth });
    assert.equal(ovRes.statusCode, 200);
    const ov = ovRes.json();
    assert.equal(ov.ok, true);
    assert.ok(ov.metricsSummary);
    assert.equal(ov.metricsSummary.agentTaskSuccessRate, 0.6667);

    // 7. Query GET /v1/observability/traces -> verify ALL 12 canonical correlation fields + _trace on direct_events!
    const traceRes = await svc.app.inject({
      method: 'GET',
      url: `/v1/observability/traces?turnId=${encodeURIComponent(prodT1.id)}&limit=200`,
      headers: auth,
    });
    assert.equal(traceRes.statusCode, 200);
    const items = traceRes.json().items;
    assert.ok(items.length >= 4);

    // Verify chronological ordering
    for (let i = 1; i < items.length; i++) {
      assert.ok(items[i].at >= items[i - 1].at);
    }

    // Verify all 12 canonical correlation fields are present across the correlated timeline
    const correlatedMetric = items.find(
      (e) => e.source === 'runtime_metrics_events' && e.kind === 'swarm_node_settled',
    );
    assert.ok(correlatedMetric);
    for (const field of [
      'runId',
      'nodeId',
      'sessionId',
      'turnId',
      'jobId',
      'workerId',
      'attempt',
      'fence',
      'model',
      'provider',
      'toolCallId',
      'artifactId',
    ]) {
      assert.notEqual(correlatedMetric[field], null, `trace item missing canonical field ${field}`);
    }

    // Verify persisted direct_events carry non-breaking compact _trace metadata
    const completedEvItem = items.find(
      (e) => e.source === 'direct_events' && e.kind === 'turn/completed',
    );
    assert.ok(completedEvItem);
    assert.equal(completedEvItem.data?._trace?.sessionId, prodSess.id);
    assert.equal(completedEvItem.data?._trace?.turnId, prodT1.id);
    assert.equal(completedEvItem.data?._trace?.jobId, prodT1.jobId);

    // 8. Structured NDJSON logger redacts secrets and auto-attaches AsyncLocalStorage trace fields
    const logLines = [];
    const fakeStream = { write: (s) => logLines.push(s) };
    withTraceContext({ traceId: 'req-obs-99', sessionId: prodSess.id, turnId: prodT1.id }, () => {
      logEvent(
        'info',
        'obs.redaction_check',
        { apiKey: 'sk-proj-secret1234567890abcdef', note: 'Bearer eyJhbGciOiJIUzI1NiJ9.xx.yy' },
        { level: 'info', stream: fakeStream },
      );
    });
    assert.equal(logLines.length, 1);
    const parsedLog = JSON.parse(logLines[0]);
    assert.equal(parsedLog.traceId, 'req-obs-99');
    assert.equal(parsedLog.sessionId, prodSess.id);
    assert.equal(parsedLog.apiKey, '[REDACTED]');
    assert.ok(!parsedLog.note.includes('eyJhbGciOiJIUzI1NiJ9'));
  } finally {
    await svc.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});
