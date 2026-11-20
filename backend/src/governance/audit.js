function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Layer 7 AuditLedgerService providing unified read/verification views across:
 * - Hash-chained JCS-SHA256 `events` ledger (`store.verifyIntegrity()`)
 * - Tool execution receipts (`tool_receipts`)
 * - Durable checkpoints (`runtime_checkpoints`)
 * - Compaction history (`context_compactions`)
 */
export class AuditLedgerService {
  constructor(store) {
    this.store = store;
  }

  verifyIntegrity() {
    return this.store.verifyIntegrity();
  }

  listAuditEvents({ after = 0, limit = 200, type = null } = {}) {
    const cap = Math.min(1000, Math.max(1, Number(limit || 200)));
    const rows = type
      ? this.store.db
          .prepare(
            'SELECT * FROM events WHERE seq>? AND type=? ORDER BY seq ASC LIMIT ?',
          )
          .all(Number(after || 0), String(type), cap)
      : this.store.db
          .prepare('SELECT * FROM events WHERE seq>? ORDER BY seq ASC LIMIT ?')
          .all(Number(after || 0), cap);
    return rows.map((r) => ({
      seq: r.seq,
      timestamp: r.timestamp,
      type: r.type,
      projectId: r.projectId,
      taskId: r.taskId,
      payload: parseJsonSafe(r.payload, {}),
      integrityMode: r.integrity_mode,
      integrityPrev: r.integrity_prev,
      integrityDigest: r.integrity_digest,
    }));
  }

  listReceipts({ sessionId = null, turnId = null, status = null, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (sessionId) {
      where.push('sessionId=?');
      params.push(sessionId);
    }
    if (turnId) {
      where.push('turnId=?');
      params.push(turnId);
    }
    if (status) {
      where.push('status=?');
      params.push(status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const cap = Math.min(500, Math.max(1, Number(limit || 200)));
    return this.store.db
      .prepare(`SELECT * FROM tool_receipts ${clause} ORDER BY createdAt DESC LIMIT ?`)
      .all(...params, cap);
  }

  listCheckpoints({ sessionId = null, turnId = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (sessionId) {
      where.push('sessionId=?');
      params.push(sessionId);
    }
    if (turnId) {
      where.push('turnId=?');
      params.push(turnId);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const cap = Math.min(500, Math.max(1, Number(limit || 100)));
    return this.store.db
      .prepare(`SELECT * FROM runtime_checkpoints ${clause} ORDER BY createdAt DESC LIMIT ?`)
      .all(...params, cap)
      .map((r) => ({
        ...r,
        state: parseJsonSafe(r.stateJson, {}),
      }));
  }
}
