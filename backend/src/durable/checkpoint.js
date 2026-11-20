import { id as uuid } from '../store.js';

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Durable CheckpointStore backed by SQLite `runtime_checkpoints`.
 * Stores phase/step boundaries and resumable turn state snapshots.
 */
export class CheckpointStore {
  constructor(store) {
    this.store = store;
  }

  save({ sessionId, turnId, step = 0, phase, state = {}, ledgerSeq = 0 }) {
    if (!this.store?.db || !sessionId || !turnId) return null;
    const id = uuid();
    const now = Date.now();
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO runtime_checkpoints(
            id, sessionId, turnId, step, phase, stateJson, ledgerSeq, createdAt
          ) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          sessionId,
          turnId,
          Number(step || 0),
          String(phase || 'init'),
          JSON.stringify(state ?? {}),
          Number(ledgerSeq || 0),
          now,
        );
    });
    return { id, sessionId, turnId, step, phase, state, ledgerSeq, createdAt: now };
  }

  loadLatest(turnId) {
    if (!this.store?.db || !turnId) return null;
    const row = this.store.db
      .prepare(
        'SELECT * FROM runtime_checkpoints WHERE turnId=? ORDER BY step DESC, createdAt DESC, rowid DESC LIMIT 1',
      )
      .get(turnId);
    if (!row) return null;
    return {
      ...row,
      state: parseJsonSafe(row.stateJson, {}),
    };
  }

  loadLatestForSession(sessionId) {
    if (!this.store?.db || !sessionId) return null;
    const row = this.store.db
      .prepare(
        'SELECT * FROM runtime_checkpoints WHERE sessionId=? ORDER BY createdAt DESC, rowid DESC LIMIT 1',
      )
      .get(sessionId);
    if (!row) return null;
    return {
      ...row,
      state: parseJsonSafe(row.stateJson, {}),
    };
  }

  listByTurn(turnId) {
    if (!this.store?.db || !turnId) return [];
    return this.store.db
      .prepare(
        'SELECT * FROM runtime_checkpoints WHERE turnId=? ORDER BY step ASC, createdAt ASC',
      )
      .all(turnId)
      .map((r) => ({ ...r, state: parseJsonSafe(r.stateJson, {}) }));
  }
}
