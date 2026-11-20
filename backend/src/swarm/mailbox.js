import { id as uuid } from '../store.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Layer 6 InterAgentMailbox persisted in SQLite `agent_messages`.
 * Enables structured asynchronous peer & parent-child handoffs inside a Swarm run.
 */
export class InterAgentMailbox {
  constructor({ store, eventRouter = null }) {
    this.store = store;
    this.eventRouter = eventRouter;
  }

  send({
    runId = null,
    sessionId = null,
    fromAgentId,
    toAgentId,
    kind = 'note',
    payload,
  }) {
    const msgId = uuid();
    const now = Date.now();
    const body = typeof payload === 'string' ? { text: payload } : payload ?? {};
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO agent_messages(
            id, runId, fromAgentId, toAgentId, kind, payloadJson, status, createdAt
          ) VALUES(?,?,?,?,?,?,'queued',?)`,
        )
        .run(msgId, runId, String(fromAgentId), String(toAgentId), String(kind), JSON.stringify(body), now);
    });

    if (sessionId && this.eventRouter) {
      this.eventRouter.emitPersisted({
        sessionId,
        turnId: null,
        type: RUNTIME_EVENTS.SWARM_MESSAGE,
        data: { id: msgId, runId, fromAgentId, toAgentId, kind, payload: body },
        audit: false,
      });
    }

    return {
      id: msgId,
      runId,
      fromAgentId,
      toAgentId,
      kind,
      payload: body,
      status: 'queued',
      createdAt: now,
    };
  }

  drainInbox(toAgentId, { runId = null, limit = 20 } = {}) {
    const cap = Math.min(100, Math.max(1, Number(limit || 20)));
    const rows = runId
      ? this.store.db
          .prepare(
            `SELECT * FROM agent_messages
             WHERE toAgentId=? AND runId=? AND status='queued'
             ORDER BY createdAt ASC LIMIT ?`,
          )
          .all(String(toAgentId), runId, cap)
      : this.store.db
          .prepare(
            `SELECT * FROM agent_messages
             WHERE toAgentId=? AND status='queued'
             ORDER BY createdAt ASC LIMIT ?`,
          )
          .all(String(toAgentId), cap);

    if (!rows.length) return [];
    const now = Date.now();
    this.store.tx(() => {
      const upd = this.store.db.prepare(
        "UPDATE agent_messages SET status='delivered', deliveredAt=? WHERE id=?",
      );
      for (const r of rows) upd.run(now, r.id);
    });

    return rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      fromAgentId: r.fromAgentId,
      toAgentId: r.toAgentId,
      kind: r.kind,
      payload: parseJsonSafe(r.payloadJson, {}),
      status: 'delivered',
      createdAt: r.createdAt,
      deliveredAt: now,
    }));
  }

  listForRun(runId, { limit = 200 } = {}) {
    return this.store.db
      .prepare('SELECT * FROM agent_messages WHERE runId=? ORDER BY createdAt ASC LIMIT ?')
      .all(runId, Math.min(500, Math.max(1, Number(limit || 200))))
      .map((r) => ({
        ...r,
        payload: parseJsonSafe(r.payloadJson, {}),
      }));
  }
}
