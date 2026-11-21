import { id as uuid } from '../store.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import { assertLeaseInTx } from '../durable/lease-guard.js';
import { CommunicationBus } from '../communication/bus.js';
import { StoreCommunicationAdapter } from '../communication/store-adapter.js';

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
  constructor({ store, eventRouter = null, communication = null }) {
    this.store = store;
    this.eventRouter = eventRouter;
    this.bus = communication ?? new CommunicationBus({ adapter: new StoreCommunicationAdapter({ store }) });
  }

  #dbOpen() {
    return Boolean(this.store?.db?.isOpen);
  }

  setCommunicationBus(bus) {
    if (!bus || typeof bus.send !== 'function' || typeof bus.receive !== 'function') throw new TypeError('CommunicationBus is required');
    this.bus = bus;
    return this.bus;
  }

  send({
    runId = null,
    sessionId = null,
    fromAgentId,
    toAgentId,
    kind = 'note',
    payload,
    conversationId = null,
    idempotencyKey = null,
    artifactManifest = undefined,
    maxAttempts = undefined,
    createdAt = undefined,
    expiresAt = undefined,
  }) {
    if (conversationId) {
      // Unified messages intentionally remain out of the legacy agent_messages table.
      // Preserve the synchronous return shape for legacy callers while returning the
      // CommunicationBus promise for the durable envelope path.
      return this.bus.send({
        conversationId: String(conversationId),
        runId,
        fromAgentId: String(fromAgentId),
        toAgentId: String(toAgentId),
        kind,
        idempotencyKey: idempotencyKey ?? uuid(),
        payload,
        artifactManifest,
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
    }
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
      try {
        this.eventRouter.emitPersisted({
          sessionId,
          turnId: null,
          type: RUNTIME_EVENTS.SWARM_MESSAGE,
          data: { id: msgId, runId, fromAgentId, toAgentId, kind, payload: body },
          audit: false,
        });
      } catch {
        // best-effort event emission after committed send
      }
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

  /**
   * Claim one durable CommunicationBus message. This is the unified counterpart to
   * legacy drainInbox(); it returns a deliveryToken that must be supplied to ack/retry.
   */
  receive(toAgentId, options = {}) {
    return this.bus.receive(String(toAgentId), options);
  }

  claim(toAgentId, options = {}) {
    return this.receive(toAgentId, options);
  }

  ack(messageId, agentId, deliveryToken = undefined) {
    return this.bus.ack(String(messageId), String(agentId), deliveryToken);
  }

  bindClaimToChildInTx(input = {}) {
    if (!this.bus?.bindClaimToChildInTx) throw new TypeError('CommunicationBus child binding is required');
    return this.bus.bindClaimToChildInTx(input);
  }


  retry(messageId, agentId, options = {}) {
    return this.bus.retry(String(messageId), String(agentId), options);
  }

  sweep() {
    return this.bus.sweep();
  }

  getMessage(messageId) {
    return this.bus.get(String(messageId));
  }

  /**
   * Non-destructively peeks queued inbox messages so callers can acknowledge delivery
   * atomically inside the turn-start transaction (preventing lost messages on crash/lease loss).
   */
  peekInbox(toAgentId, { runId = null, limit = 20 } = {}) {
    if (!this.#dbOpen()) return [];
    const cap = Math.min(100, Math.max(1, Number(limit || 20)));
    const rows = runId
      ? this.store.db
          .prepare(
            `SELECT * FROM agent_messages
             WHERE toAgentId=? AND runId=? AND status='queued'
             ORDER BY createdAt ASC, rowid ASC LIMIT ?`,
          )
          .all(String(toAgentId), runId, cap)
      : this.store.db
          .prepare(
            `SELECT * FROM agent_messages
             WHERE toAgentId=? AND status='queued'
             ORDER BY createdAt ASC, rowid ASC LIMIT ?`,
          )
          .all(String(toAgentId), cap);
    return rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      fromAgentId: r.fromAgentId,
      toAgentId: r.toAgentId,
      kind: r.kind,
      payload: parseJsonSafe(r.payloadJson, {}),
      status: r.status,
      createdAt: r.createdAt,
      deliveredAt: r.deliveredAt ?? null,
    }));
  }

  /**
   * Atomically acknowledges queued messages as delivered, guarded by optional leaseGuard.
   */
  ackMessages(ids = [], { leaseGuard = null, runId = null, nodeId = null } = {}) {
    if (!this.#dbOpen() || !Array.isArray(ids) || !ids.length) return 0;
    const now = Date.now();
    return this.store.tx(() => {
      assertLeaseInTx(leaseGuard, { runId, nodeId });
      const upd = this.store.db.prepare(
        "UPDATE agent_messages SET status='delivered', deliveredAt=? WHERE id=? AND status='queued'",
      );
      let count = 0;
      for (const id of ids) {
        if (!id) continue;
        const res = upd.run(now, String(id));
        if (res.changes > 0) count++;
      }
      return count;
    });
  }

  /**
   * Atomically selects and marks queued messages as delivered inside ONE SQLite transaction,
   * returning only rows exclusively claimed by this caller (`changes > 0`).
   */
  drainInbox(toAgentId, { runId = null, limit = 20, leaseGuard = null, nodeId = null } = {}) {
    if (!this.#dbOpen()) return [];
    const cap = Math.min(100, Math.max(1, Number(limit || 20)));
    const now = Date.now();
    return this.store.tx(() => {
      assertLeaseInTx(leaseGuard, { runId, nodeId });
      const rows = runId
        ? this.store.db
            .prepare(
              `SELECT * FROM agent_messages
               WHERE toAgentId=? AND runId=? AND status='queued'
               ORDER BY createdAt ASC, rowid ASC LIMIT ?`,
            )
            .all(String(toAgentId), runId, cap)
        : this.store.db
            .prepare(
              `SELECT * FROM agent_messages
               WHERE toAgentId=? AND status='queued'
               ORDER BY createdAt ASC, rowid ASC LIMIT ?`,
            )
            .all(String(toAgentId), cap);

      if (!rows.length) return [];
      const upd = this.store.db.prepare(
        "UPDATE agent_messages SET status='delivered', deliveredAt=? WHERE id=? AND status='queued'",
      );
      const delivered = [];
      for (const r of rows) {
        const res = upd.run(now, r.id);
        if (res.changes > 0) {
          delivered.push({
            id: r.id,
            runId: r.runId,
            fromAgentId: r.fromAgentId,
            toAgentId: r.toAgentId,
            kind: r.kind,
            payload: parseJsonSafe(r.payloadJson, {}),
            status: 'delivered',
            createdAt: r.createdAt,
            deliveredAt: now,
          });
        }
      }
      return delivered;
    });
  }

  listForRun(runId, { limit = 200 } = {}) {
    if (!this.#dbOpen()) return [];
    return this.store.db
      .prepare('SELECT * FROM agent_messages WHERE runId=? ORDER BY createdAt ASC, rowid ASC LIMIT ?')
      .all(runId, Math.min(500, Math.max(1, Number(limit || 200))))
      .map((r) => ({
        ...r,
        payload: parseJsonSafe(r.payloadJson, {}),
      }));
  }
}
