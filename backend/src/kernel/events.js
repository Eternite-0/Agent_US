import { EventEmitter } from 'node:events';
import { compactTrace } from '../observability/trace.js';
import { logEvent } from '../observability/logger.js';

export const RUNTIME_EVENTS = Object.freeze({
  TURN_STARTED: 'turn/started',
  TURN_PHASE_CHANGED: 'turn/phase_changed',
  TURN_STEERED: 'turn/steered',
  TURN_COMPLETED: 'turn/completed',
  TURN_FAILED: 'turn/failed',
  TURN_CANCELLED: 'turn/cancelled',
  TURN_PARKED: 'turn/parked',
  ASSISTANT_DELTA: 'assistant/delta',
  REASONING_DELTA: 'reasoning/delta',
  ASSISTANT_MESSAGE: 'assistant/message',
  TOOL_CALL: 'tool/call',
  TOOL_OUTPUT: 'tool/output',
  TOOL_RESULT: 'tool/result',
  TOOL_RECEIPT: 'tool/receipt',
  TOOL_APPROVAL_REVIEWED: 'tool/approval_reviewed',
  CONTEXT_COMPACTED: 'context/compacted',
  SESSION_COMPACTED: 'session/compacted',
  SESSION_REWOUND: 'session/rewound',
  SESSION_RECOVERED: 'session/recovered',
  PLAN_UPDATED: 'plan/updated',
  FILE_CHANGED: 'file/changed',
  APPROVAL_REQUESTED: 'approval/requested',
  APPROVAL_RESOLVED: 'approval/resolved',
  RECONCILIATION_REQUIRED: 'reconciliation/required',
  RECONCILIATION_RESOLVED: 'reconciliation/resolved',
  VERIFIER_REPAIR: 'verifier/repair',
  VERIFIER_VERDICT: 'verifier/verdict',
  LOOP_THRASHING_WARNING: 'loop/thrashing_warning',
  SUBAGENT_STARTED: 'subagent/started',
  SUBAGENT_COMPLETED: 'subagent/completed',
  SUBAGENT_FAILED: 'subagent/failed',
  SWARM_RUN_STARTED: 'swarm/run_started',
  SWARM_NODE_UPDATED: 'swarm/node_updated',
  SWARM_REPLANNED: 'swarm/replanned',
  SWARM_MESSAGE: 'swarm/message',
  SWARM_RUN_COMPLETED: 'swarm/run_completed',
});

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Unified event router for persistent direct_events, optional JCS-SHA256 ledger audit entries,
 * and non-persisted live streaming deltas.
 */
export class EventRouter {
  constructor(store = null) {
    this.store = store;
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(200);
    this.ephemeralSeq = 0;
    this.memorySeq = 0;
  }

  #buildPayload(data) {
    const base =
      data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : {};
    const trace = compactTrace();
    if (Object.keys(trace).length > 0 && base._trace === undefined) {
      base._trace = trace;
    }
    return base;
  }

  #dispatchChannel(channel, ev) {
    const listeners = this.bus.rawListeners(channel);
    for (const listener of listeners) {
      try {
        listener.call(this.bus, ev);
      } catch (err) {
        logEvent('warn', 'event_router.listener_error', {
          channel,
          eventType: ev?.type ?? null,
          seq: ev?.seq ?? null,
          sessionId: ev?.sessionId ?? null,
          turnId: ev?.turnId ?? null,
          error: err,
        });
      }
    }
  }

  /**
   * Inserts a persisted `direct_events` row (and optional ledger audit entry) inside an
   * ALREADY-OPEN SQLite transaction without fanning out to in-memory listeners yet.
   * Call `fanoutPersisted(record)` ONLY AFTER the enclosing transaction commits.
   */
  insertPersistedInTx({
    sessionId,
    turnId = null,
    projectId = null,
    taskId = null,
    type,
    data = {},
    audit = true,
    at = Date.now(),
  }) {
    const payload = this.#buildPayload(data);
    let seq;
    if (this.store?.db) {
      const res = this.store.db
        .prepare(
          'INSERT INTO direct_events(sessionId, turnId, type, data, at) VALUES(?,?,?,?,?)',
        )
        .run(sessionId, turnId ?? null, type, JSON.stringify(payload), at);
      if (audit && typeof this.store.event === 'function') {
        this.store.event(`runtime.${type.replace(/\//g, '.')}`, projectId, taskId, {
          sessionId,
          turnId: turnId ?? null,
          ...payload,
        });
      }
      seq = Number(res.lastInsertRowid);
    } else {
      seq = ++this.memorySeq;
    }

    return {
      seq,
      sessionId,
      turnId: turnId ?? null,
      type,
      data: payload,
      at,
    };
  }

  /**
   * Fans out a committed event record to in-memory bus listeners with per-listener
   * error isolation so one broken/throwing listener never aborts turns or starves siblings.
   */
  fanoutPersisted(record) {
    if (!record) return record;
    this.#dispatchChannel('event', record);
    if (record.sessionId) this.#dispatchChannel(`session:${record.sessionId}`, record);
    return record;
  }

  fanoutEvent(record) {
    return this.fanoutPersisted(record);
  }

  emitPersisted({
    sessionId,
    turnId = null,
    projectId = null,
    taskId = null,
    type,
    data = {},
    audit = true,
  }) {
    const opts = {
      sessionId,
      turnId,
      projectId,
      taskId,
      type,
      data,
      audit,
      at: Date.now(),
    };
    const ev = this.store?.db
      ? this.store.tx(() => this.insertPersistedInTx(opts))
      : this.insertPersistedInTx(opts);
    if (this.store?.afterCommit) this.store.afterCommit(() => this.fanoutPersisted(ev));
    else this.fanoutPersisted(ev);
    return ev;
  }

  emitEphemeral({ sessionId, turnId = null, type, data = {} }) {
    const ev = {
      seq: 0,
      ephemeral: true,
      ephemeralId: ++this.ephemeralSeq,
      sessionId,
      turnId: turnId ?? null,
      type,
      data: this.#buildPayload(data),
      at: Date.now(),
    };
    return this.fanoutPersisted(ev);
  }

  subscribe(sessionId, listener) {
    const channel = sessionId ? `session:${sessionId}` : 'event';
    this.bus.on(channel, listener);
    return () => this.bus.off(channel, listener);
  }

  list(sessionId, { after = 0, limit = 300 } = {}) {
    if (!this.store?.db) return [];
    const cap = Math.min(1000, Math.max(1, Number(limit || 300)));
    const rows = sessionId
      ? this.store.db
          .prepare(
            'SELECT * FROM direct_events WHERE sessionId=? AND seq>? ORDER BY seq ASC LIMIT ?',
          )
          .all(sessionId, Number(after || 0), cap)
      : this.store.db
          .prepare('SELECT * FROM direct_events WHERE seq>? ORDER BY seq ASC LIMIT ?')
          .all(Number(after || 0), cap);
    return rows.map((r) => ({
      seq: r.seq,
      sessionId: r.sessionId,
      turnId: r.turnId,
      type: r.type,
      data: parseJsonSafe(r.data, {}),
      at: r.at,
    }));
  }
}
