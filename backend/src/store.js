import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  LEDGER_INTEGRITY_ALGORITHM,
  COLD_TAIL_ROWS,
  INTEGRITY_PAGE_SIZE,
  computeEventDigest,
  sameDigest,
  sha256Hex,
  verifyIntegrityRows,
} from './integrity.js';

export class Fault extends Error {
  constructor(code, status = 409, detail = undefined) {
    super(code);
    this.code = code;
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}
export const id = () => randomUUID();
const unpack = (row) =>
  row && {
    ...JSON.parse(row.body),
    id: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    version: row.version,
  };

// All writes, including events and pending effects, share the caller's transaction.
export class Store {
  #wakeListeners = new Set();
  #wakePending = false;
  constructor(path) {
    this.db = new DatabaseSync(path);
    const userVersion = this.db.prepare('PRAGMA user_version').get().user_version;
    if (userVersion > 5) {
      this.db.close();
      throw new Fault('UNSUPPORTED_DATABASE_SCHEMA');
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, projectId TEXT REFERENCES records(id), taskId TEXT REFERENCES records(id), version INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)));
      CREATE INDEX IF NOT EXISTS children ON records(kind, taskId,projectId);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, type TEXT NOT NULL, projectId TEXT, taskId TEXT, payload TEXT NOT NULL, integrity_mode TEXT, integrity_prev TEXT, integrity_digest TEXT);
      CREATE INDEX IF NOT EXISTS task_events ON events(taskId,seq);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES records(id), kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', fence TEXT, expires INTEGER, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TRIGGER IF NOT EXISTS preserve_revision AFTER UPDATE ON records BEGIN INSERT INTO revisions(id,version,body) VALUES(OLD.id,OLD.version,OLD.body); END;
      CREATE TABLE IF NOT EXISTS submissions(projectId TEXT, key TEXT, taskId TEXT REFERENCES records(id), PRIMARY KEY(projectId,key));
      CREATE TABLE IF NOT EXISTS ledger_meta(id INTEGER PRIMARY KEY CHECK(id=1), lastSeq INTEGER NOT NULL, legacyThroughSeq INTEGER NOT NULL, headDigest TEXT, verifiedThroughSeq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs(sha256 TEXT PRIMARY KEY, content TEXT NOT NULL, bytes INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS direct_sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL, workspaceRoot TEXT, model TEXT, mode TEXT NOT NULL DEFAULT 'direct', permissionMode TEXT NOT NULL DEFAULT 'auto-safe', state TEXT NOT NULL DEFAULT 'idle', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS direct_turns(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES direct_sessions(id) ON DELETE CASCADE, clientTurnId TEXT, input TEXT NOT NULL, model TEXT, state TEXT NOT NULL DEFAULT 'running', error TEXT, inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0, costUsd REAL NOT NULL DEFAULT 0, durationMs INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, finishedAt INTEGER);
      CREATE INDEX IF NOT EXISTS direct_turns_session ON direct_turns(sessionId, createdAt);
      CREATE TABLE IF NOT EXISTS direct_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT NOT NULL REFERENCES direct_sessions(id) ON DELETE CASCADE, turnId TEXT, role TEXT NOT NULL, content TEXT NOT NULL, reasoning TEXT, toolCalls TEXT, toolCallId TEXT, toolName TEXT, meta TEXT, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS direct_messages_session ON direct_messages(sessionId, seq);
      CREATE TABLE IF NOT EXISTS direct_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT NOT NULL, turnId TEXT, type TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS direct_events_session ON direct_events(sessionId, seq);
      CREATE TABLE IF NOT EXISTS direct_approvals(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, turnId TEXT, callId TEXT, tool TEXT NOT NULL, arguments TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', scope TEXT, reason TEXT, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, resolvedAt INTEGER);
      CREATE INDEX IF NOT EXISTS direct_approvals_session ON direct_approvals(sessionId, status);
      CREATE TABLE IF NOT EXISTS provider_accounts(id TEXT PRIMARY KEY, preset TEXT NOT NULL, label TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'official', priority INTEGER NOT NULL DEFAULT 100, enabled INTEGER NOT NULL DEFAULT 1, endpoint TEXT, proxyUrl TEXT, headers TEXT NOT NULL DEFAULT '{}', models TEXT NOT NULL DEFAULT '[]', modelProfiles TEXT NOT NULL DEFAULT '{}', credentialEnc TEXT, credentialMask TEXT, status TEXT NOT NULL DEFAULT 'unknown', lastError TEXT, lastErrorAt INTEGER, cooldownUntil INTEGER NOT NULL DEFAULT 0, lastSuccessAt INTEGER, balanceJson TEXT, expiresAt INTEGER, activeConns INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_priorities(preset TEXT PRIMARY KEY, rank INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pool_models(id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE, preset TEXT NOT NULL, upstreamModel TEXT NOT NULL, displayName TEXT, enabled INTEGER NOT NULL DEFAULT 1, visible INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'remote', multiplier REAL NOT NULL DEFAULT 1.0, contextWindow INTEGER NOT NULL DEFAULT 128000, maxOutput INTEGER NOT NULL DEFAULT 16384, capabilities TEXT NOT NULL DEFAULT '{}', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, UNIQUE(accountId, upstreamModel));
      CREATE INDEX IF NOT EXISTS pool_models_preset ON pool_models(preset, enabled);
      CREATE TABLE IF NOT EXISTS model_mappings(id TEXT PRIMARY KEY, alias TEXT NOT NULL, targetPreset TEXT, targetAccountId TEXT, targetModel TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, isDefault INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 100, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS model_mappings_alias ON model_mappings(alias, enabled);
      CREATE TABLE IF NOT EXISTS checkin_schedules(id TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, time TEXT NOT NULL DEFAULT '09:00', timeEnd TEXT, providers TEXT NOT NULL DEFAULT '[]', providerTimes TEXT NOT NULL DEFAULT '{}', retryTime TEXT DEFAULT '21:00', retryGapMinutes INTEGER NOT NULL DEFAULT 30, retryLimit INTEGER NOT NULL DEFAULT 2, lastFiredDate TEXT, lastResultJson TEXT, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS checkin_records(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, date TEXT NOT NULL, accountId TEXT, accountName TEXT, providerId TEXT NOT NULL, providerLabel TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'manual', section TEXT NOT NULL DEFAULT 'daily', outcome TEXT NOT NULL, message TEXT, error TEXT, points INTEGER NOT NULL DEFAULT 0, meta TEXT);
      CREATE INDEX IF NOT EXISTS checkin_records_date ON checkin_records(date, providerId);
      CREATE TABLE IF NOT EXISTS kv_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS nexus_memory(id TEXT PRIMARY KEY, scopeType TEXT NOT NULL, scopeId TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note', tags TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL DEFAULT 1.0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, lastAccessedAt INTEGER, UNIQUE(scopeType, scopeId, key));
      CREATE TABLE IF NOT EXISTS nexus_usage(id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT, planId TEXT, provider TEXT, model TEXT, accountId TEXT, day TEXT NOT NULL, inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, costUsd REAL NOT NULL DEFAULT 0, durationMs INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS nexus_usage_day ON nexus_usage(day, sessionId);
      CREATE TABLE IF NOT EXISTS turn_snapshots(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES direct_sessions(id) ON DELETE CASCADE, turnId TEXT NOT NULL, path TEXT NOT NULL, existed INTEGER NOT NULL, beforeSha256 TEXT, afterSha256 TEXT, createdAt INTEGER NOT NULL, UNIQUE(turnId, path));
      CREATE INDEX IF NOT EXISTS turn_snapshots_session ON turn_snapshots(sessionId, createdAt);
      CREATE TABLE IF NOT EXISTS runtime_checkpoints(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, turnId TEXT NOT NULL, step INTEGER NOT NULL, phase TEXT NOT NULL, stateJson TEXT NOT NULL, ledgerSeq INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS runtime_checkpoints_session ON runtime_checkpoints(sessionId, createdAt);
      CREATE INDEX IF NOT EXISTS runtime_checkpoints_turn ON runtime_checkpoints(turnId, step);
      CREATE TABLE IF NOT EXISTS runtime_jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, sessionId TEXT, turnId TEXT, taskId TEXT, parentJobId TEXT, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', fence TEXT, workerId TEXT, leaseExpiresAt INTEGER, attempts INTEGER NOT NULL DEFAULT 0, maxAttempts INTEGER NOT NULL DEFAULT 3, idempotencyKey TEXT, errorCode TEXT, errorMessage TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS runtime_jobs_status ON runtime_jobs(status, leaseExpiresAt);
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_jobs_idem ON runtime_jobs(idempotencyKey) WHERE idempotencyKey IS NOT NULL;
      CREATE TABLE IF NOT EXISTS tool_receipts(id TEXT PRIMARY KEY, sessionId TEXT, turnId TEXT, taskId TEXT, callId TEXT NOT NULL, toolName TEXT NOT NULL, riskLevel TEXT NOT NULL, effectClass TEXT NOT NULL, replayable INTEGER NOT NULL, outward INTEGER NOT NULL, argsDigest TEXT NOT NULL, approvalId TEXT, permitEffectId TEXT, status TEXT NOT NULL, outputDigest TEXT, exitCode INTEGER, durationMs INTEGER NOT NULL DEFAULT 0, errorCode TEXT, reconciliationOutcome TEXT, reconciliationNote TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tool_receipts_turn ON tool_receipts(sessionId, turnId);
      CREATE INDEX IF NOT EXISTS tool_receipts_status ON tool_receipts(status);
      CREATE TABLE IF NOT EXISTS swarm_runs(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, rootTurnId TEXT, goal TEXT NOT NULL, status TEXT NOT NULL, strategyJson TEXT NOT NULL, budgetJson TEXT NOT NULL, usageJson TEXT NOT NULL DEFAULT '{}', verdictJson TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS swarm_runs_session ON swarm_runs(sessionId, createdAt);
      CREATE TABLE IF NOT EXISTS swarm_nodes(id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE, nodeKey TEXT NOT NULL, parentNodeId TEXT, agentProfileId TEXT NOT NULL, childSessionId TEXT, model TEXT, provider TEXT, objective TEXT NOT NULL, acceptance TEXT NOT NULL, dependenciesJson TEXT NOT NULL DEFAULT '[]', toolAllowJson TEXT, permissionMode TEXT NOT NULL DEFAULT 'auto-safe', worktreePath TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER NOT NULL DEFAULT 0, budgetJson TEXT NOT NULL DEFAULT '{}', resultText TEXT, artifactUrisJson TEXT NOT NULL DEFAULT '[]', errorCode TEXT, errorMessage TEXT, attempts INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, UNIQUE(runId, nodeKey));
      CREATE INDEX IF NOT EXISTS swarm_nodes_run ON swarm_nodes(runId, status);
      CREATE TABLE IF NOT EXISTS agent_messages(id TEXT PRIMARY KEY, runId TEXT, fromAgentId TEXT NOT NULL, toAgentId TEXT NOT NULL, kind TEXT NOT NULL, payloadJson TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', createdAt INTEGER NOT NULL, deliveredAt INTEGER);
      CREATE INDEX IF NOT EXISTS agent_messages_recipient ON agent_messages(toAgentId, status, createdAt);
      CREATE TABLE IF NOT EXISTS context_compactions(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, turnId TEXT, stage TEXT NOT NULL, coveredThroughSeq INTEGER NOT NULL, summaryText TEXT NOT NULL, taskStateJson TEXT NOT NULL, preservedConstraintsJson TEXT NOT NULL, tokenBefore INTEGER NOT NULL, tokenAfter INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS context_compactions_session ON context_compactions(sessionId, createdAt);
      CREATE TABLE IF NOT EXISTS scheduled_tasks(id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, scheduleKind TEXT NOT NULL, scheduleExpr TEXT NOT NULL, workspaceRoot TEXT, model TEXT, permissionMode TEXT NOT NULL DEFAULT 'auto-safe', enabled INTEGER NOT NULL DEFAULT 1, lastRunAt INTEGER, nextRunAt INTEGER, lastSessionId TEXT, lastStatus TEXT, runHistoryJson TEXT NOT NULL DEFAULT '[]', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);`);
    this.#migrateSchema();
  }
  #migrateSchema() {
    this.tx(() => {
      const cols = new Set(
        this.db.prepare('PRAGMA table_info(events)').all().map((c) => c.name),
      );
      if (!cols.has('integrity_mode')) {
        this.db.exec('ALTER TABLE events ADD COLUMN integrity_mode TEXT');
      }
      if (!cols.has('integrity_prev')) {
        this.db.exec('ALTER TABLE events ADD COLUMN integrity_prev TEXT');
      }
      if (!cols.has('integrity_digest')) {
        this.db.exec('ALTER TABLE events ADD COLUMN integrity_digest TEXT');
      }
      const meta = this.db
        .prepare('SELECT * FROM ledger_meta WHERE id=1')
        .get();
      if (!meta) {
        const last = this.db
          .prepare(
            'SELECT seq, integrity_mode, integrity_digest FROM events ORDER BY seq DESC LIMIT 1',
          )
          .get();
        const legacyMax =
          this.db
            .prepare(
              'SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE integrity_mode IS NULL',
            )
            .get().n ?? 0;
        this.db
          .prepare(
            'INSERT INTO ledger_meta(id, lastSeq, legacyThroughSeq, headDigest, verifiedThroughSeq) VALUES(1, ?, ?, ?, 0)',
          )
          .run(
            last?.seq ?? 0,
            legacyMax,
            last?.integrity_mode ? last.integrity_digest : null,
          );
      }
      const sessCols = new Set(
        this.db
          .prepare('PRAGMA table_info(direct_sessions)')
          .all()
          .map((c) => c.name),
      );
      if (!sessCols.has('nonce')) {
        this.db.exec('ALTER TABLE direct_sessions ADD COLUMN nonce TEXT');
      }
      if (!sessCols.has('planJson')) {
        this.db.exec('ALTER TABLE direct_sessions ADD COLUMN planJson TEXT');
      }
      if (!sessCols.has('approvedPrefixes')) {
        this.db.exec(
          "ALTER TABLE direct_sessions ADD COLUMN approvedPrefixes TEXT NOT NULL DEFAULT '[]'",
        );
      }
      if (!sessCols.has('parentSessionId')) {
        this.db.exec('ALTER TABLE direct_sessions ADD COLUMN parentSessionId TEXT');
      }
      if (!sessCols.has('rootSessionId')) {
        this.db.exec('ALTER TABLE direct_sessions ADD COLUMN rootSessionId TEXT');
      }
      if (!sessCols.has('agentProfile')) {
        this.db.exec(
          "ALTER TABLE direct_sessions ADD COLUMN agentProfile TEXT NOT NULL DEFAULT 'default'",
        );
      }
      if (!sessCols.has('budgetJson')) {
        this.db.exec('ALTER TABLE direct_sessions ADD COLUMN budgetJson TEXT');
      }
      if (!sessCols.has('activeCompactionId')) {
        this.db.exec('ALTER TABLE direct_sessions ADD COLUMN activeCompactionId TEXT');
      }
      const turnCols = new Set(
        this.db
          .prepare('PRAGMA table_info(direct_turns)')
          .all()
          .map((c) => c.name),
      );
      if (!turnCols.has('jobId')) {
        this.db.exec('ALTER TABLE direct_turns ADD COLUMN jobId TEXT');
      }
      if (!turnCols.has('phase')) {
        this.db.exec(
          "ALTER TABLE direct_turns ADD COLUMN phase TEXT NOT NULL DEFAULT 'init'",
        );
      }
      if (!turnCols.has('step')) {
        this.db.exec(
          'ALTER TABLE direct_turns ADD COLUMN step INTEGER NOT NULL DEFAULT 0',
        );
      }
      if (!turnCols.has('agentProfile')) {
        this.db.exec(
          "ALTER TABLE direct_turns ADD COLUMN agentProfile TEXT NOT NULL DEFAULT 'default'",
        );
      }
      if (!turnCols.has('verdictJson')) {
        this.db.exec('ALTER TABLE direct_turns ADD COLUMN verdictJson TEXT');
      }
      if (!turnCols.has('evidenceCount')) {
        this.db.exec(
          'ALTER TABLE direct_turns ADD COLUMN evidenceCount INTEGER NOT NULL DEFAULT 0',
        );
      }
      const apprCols = new Set(
        this.db
          .prepare('PRAGMA table_info(direct_approvals)')
          .all()
          .map((c) => c.name),
      );
      if (!apprCols.has('kind')) {
        this.db.exec(
          "ALTER TABLE direct_approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'tool'",
        );
      }
      if (!apprCols.has('receiptId')) {
        this.db.exec('ALTER TABLE direct_approvals ADD COLUMN receiptId TEXT');
      }
      if (!apprCols.has('riskLevel')) {
        this.db.exec('ALTER TABLE direct_approvals ADD COLUMN riskLevel TEXT');
      }
      if (!apprCols.has('effectClass')) {
        this.db.exec('ALTER TABLE direct_approvals ADD COLUMN effectClass TEXT');
      }
      if (!apprCols.has('outcome')) {
        this.db.exec('ALTER TABLE direct_approvals ADD COLUMN outcome TEXT');
      }
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS direct_messages_fts USING fts5(
            content,
            sessionId UNINDEXED,
            turnId UNINDEXED,
            role UNINDEXED,
            content='direct_messages',
            content_rowid='seq'
          );
          CREATE TRIGGER IF NOT EXISTS direct_messages_ai AFTER INSERT ON direct_messages BEGIN
            INSERT INTO direct_messages_fts(rowid, content, sessionId, turnId, role)
            VALUES (new.seq, new.content, new.sessionId, new.turnId, new.role);
          END;
          CREATE TRIGGER IF NOT EXISTS direct_messages_ad AFTER DELETE ON direct_messages BEGIN
            INSERT INTO direct_messages_fts(direct_messages_fts, rowid, content, sessionId, turnId, role)
            VALUES ('delete', old.seq, old.content, old.sessionId, old.turnId, old.role);
          END;
        `);
        this.ftsEnabled = true;
      } catch {
        this.ftsEnabled = false;
      }
      this.db.exec('PRAGMA user_version=5');
    });
  }
  searchDirectHistory(
    query,
    { excludeSessionId = null, workspaceRoot = null, limit = 12 } = {},
  ) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const cap = Math.min(50, Math.max(1, Number(limit || 12)));
    if (this.ftsEnabled) {
      try {
        // Escape FTS5 syntax safely into phrase terms
        const terms = q
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 8)
          .map((t) => `"${t.replace(/"/g, '""')}"`)
          .join(' ');
        if (terms) {
          return this.db
            .prepare(
              `SELECT m.seq, m.sessionId, m.turnId, m.role, m.createdAt,
                      s.title AS sessionTitle, s.workspaceRoot,
                      snippet(direct_messages_fts, 0, '[', ']', '…', 24) AS snippet
               FROM direct_messages_fts
               JOIN direct_messages m ON m.seq = direct_messages_fts.rowid
               JOIN direct_sessions s ON s.id = m.sessionId
               WHERE direct_messages_fts MATCH ?
                 AND (? IS NULL OR m.sessionId != ?)
                 AND (? IS NULL OR s.workspaceRoot = ?)
               ORDER BY bm25(direct_messages_fts), m.createdAt DESC
               LIMIT ?`,
            )
            .all(
              terms,
              excludeSessionId,
              excludeSessionId,
              workspaceRoot,
              workspaceRoot,
              cap,
            );
        }
      } catch {
        // fallback to LIKE below
      }
    }
    const pat = `%${q}%`;
    return this.db
      .prepare(
        `SELECT m.seq, m.sessionId, m.turnId, m.role, m.createdAt,
                s.title AS sessionTitle, s.workspaceRoot,
                substr(m.content, 1, 240) AS snippet
         FROM direct_messages m
         JOIN direct_sessions s ON s.id = m.sessionId
         WHERE m.content LIKE ?
           AND (? IS NULL OR m.sessionId != ?)
           AND (? IS NULL OR s.workspaceRoot = ?)
         ORDER BY m.createdAt DESC
         LIMIT ?`,
      )
      .all(
        pat,
        excludeSessionId,
        excludeSessionId,
        workspaceRoot,
        workspaceRoot,
        cap,
      );
  }
  getSetting(key, fallback = null) {
    const row = this.db
      .prepare('SELECT value FROM kv_settings WHERE key=?')
      .get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }
  setSetting(key, value) {
    return this.tx(() => {
      this.db
        .prepare(
          'INSERT INTO kv_settings(key, value, updatedAt) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt',
        )
        .run(key, JSON.stringify(value), Date.now());
      return value;
    });
  }
  onJobWake(fn) {
    this.#wakeListeners.add(fn);
    return () => this.#wakeListeners.delete(fn);
  }
  notifyJobWake() {
    if (!this.#wakeListeners.size) return;
    if (this.db.isTransaction) {
      this.#wakePending = true;
      return;
    }
    queueMicrotask(() => {
      for (const fn of this.#wakeListeners) {
        try {
          fn();
        } catch {}
      }
    });
  }
  tx(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result instanceof Promise) throw Error('async transaction');
      this.db.exec('COMMIT');
      if (this.#wakePending) {
        this.#wakePending = false;
        this.notifyJobWake();
      }
      return result;
    } catch (error) {
      this.#wakePending = false;
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  get(kind, key) {
    const row = this.db
      .prepare('SELECT * FROM records WHERE id=? AND kind=?')
      .get(key, kind);
    if (!row) throw new Fault('NOT_FOUND', 404);
    return unpack(row);
  }
  list(
    kind,
    { taskId = null, projectId = null, limit = 100, offset = 0 } = {},
  ) {
    return this.db
      .prepare(
        'SELECT * FROM records WHERE kind=? AND (? IS NULL OR taskId=?) AND (? IS NULL OR projectId=?) ORDER BY rowid LIMIT ? OFFSET ?',
      )
      .all(kind, taskId, taskId, projectId, projectId, limit, offset)
      .map(unpack);
  }
  add(kind, body, projectId = null, taskId = null, key = id()) {
    return this.tx(() => {
      this.db
        .prepare('INSERT INTO records VALUES(?,?,?,?,1,?)')
        .run(key, kind, projectId, taskId, JSON.stringify(body));
      this.event(
        `${kind}.created`,
        projectId ?? key,
        taskId ?? (kind === 'tasks' ? key : null),
        { id: key },
      );
      return this.get(kind, key);
    });
  }
  update(kind, record, patch) {
    return this.tx(() => {
      const { id: key, projectId, taskId, version, ...body } = record;
      const res = this.db
        .prepare(
          'UPDATE records SET version=version+1,body=? WHERE id=? AND kind=? AND version=?',
        )
        .run(JSON.stringify({ ...body, ...patch }), key, kind, version);
      if (!res.changes) throw new Fault('STALE_VERSION');
      this.event(
        `${kind}.updated`,
        projectId,
        taskId ?? (kind === 'tasks' ? key : null),
        {
          id: key,
          version: version + 1,
          ...(patch.status ? { status: patch.status } : {}),
        },
      );
      if (
        (kind === 'tasks' && ['planning', 'running', 'reviewing'].includes(patch.status)) ||
        kind === 'approvals'
      ) {
        this.notifyJobWake();
      }
      return this.get(kind, key);
    });
  }
  event(type, projectId, taskId, payload) {
    return this.tx(() => {
      const meta = this.db
        .prepare('SELECT * FROM ledger_meta WHERE id=1')
        .get();
      const seq = meta.lastSeq + 1;
      const timestamp = Date.now();
      const payloadJson = JSON.stringify(payload);
      const normalizedPayload = JSON.parse(payloadJson);
      const mode = meta.headDigest === null ? 'anchor' : 'chain';
      const previousDigest = meta.headDigest;
      const digest = computeEventDigest({
        mode,
        legacyThroughSeq: meta.legacyThroughSeq,
        previousDigest,
        event: {
          seq,
          timestamp,
          type,
          projectId: projectId ?? null,
          taskId: taskId ?? null,
          payload: normalizedPayload,
        },
      });
      this.db
        .prepare(
          'INSERT INTO events(seq,timestamp,type,projectId,taskId,payload,integrity_mode,integrity_prev,integrity_digest) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          seq,
          timestamp,
          type,
          projectId ?? null,
          taskId ?? null,
          payloadJson,
          mode,
          previousDigest,
          digest,
        );
      const nextVerified =
        meta.verifiedThroughSeq === meta.lastSeq ? seq : meta.verifiedThroughSeq;
      this.db
        .prepare(
          'UPDATE ledger_meta SET lastSeq=?, headDigest=?, verifiedThroughSeq=? WHERE id=1',
        )
        .run(seq, digest, nextVerified);
      return seq;
    });
  }
  verifyIntegrity({ full = false, tailRows = COLD_TAIL_ROWS } = {}) {
    const meta = this.db.prepare('SELECT * FROM ledger_meta WHERE id=1').get();
    const stats = this.db
      .prepare('SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS maxSeq FROM events')
      .get();
    if (stats.maxSeq < meta.lastSeq || stats.count < meta.lastSeq) {
      throw new Fault('LEDGER_INTEGRITY_FAILED', 500, {
        reason: 'ledger truncated or missing rows compared to watermark',
        expectedLastSeq: meta.lastSeq,
        actualMaxSeq: stats.maxSeq,
        actualCount: stats.count,
      });
    }
    if (stats.maxSeq > meta.lastSeq) {
      throw new Fault('LEDGER_INTEGRITY_FAILED', 500, {
        reason: 'ledger contains rows beyond watermark',
        expectedLastSeq: meta.lastSeq,
        actualMaxSeq: stats.maxSeq,
      });
    }
    if (meta.lastSeq === 0) {
      return {
        ok: true,
        algorithm: LEDGER_INTEGRITY_ALGORITHM,
        lastSeq: 0,
        legacyThroughSeq: 0,
        verifiedThroughSeq: 0,
        headDigest: null,
        checkedRows: 0,
        hashedRows: 0,
      };
    }
    const hashFromSeq = full
      ? 1
      : Math.max(
          1,
          meta.verifiedThroughSeq > 0
            ? Math.min(meta.verifiedThroughSeq + 1, meta.lastSeq - tailRows + 1)
            : meta.lastSeq - tailRows + 1,
        );
    const onError = (reason, seq) => {
      throw new Fault('LEDGER_INTEGRITY_FAILED', 500, { reason, seq });
    };
    let state = { lastSeq: 0, legacyThroughSeq: 0, headDigest: null };
    let checkedRows = 0;
    let hashedRows = 0;
    const scanRange = (fromSeq, toSeq, hash) => {
      let cursor = fromSeq;
      while (cursor <= toSeq) {
        const end = Math.min(toSeq, cursor + INTEGRITY_PAGE_SIZE - 1);
        const rows = this.db
          .prepare(
            'SELECT seq,timestamp,type,projectId,taskId,payload,integrity_mode,integrity_prev,integrity_digest FROM events WHERE seq BETWEEN ? AND ? ORDER BY seq ASC',
          )
          .all(cursor, end);
        if (!rows.length) {
          onError('ledger ended before watermark sequence', cursor);
        }
        state = verifyIntegrityRows(rows, state, { hash, onError });
        checkedRows += rows.length;
        if (hash) hashedRows += rows.length;
        cursor = state.lastSeq + 1;
      }
    };
    if (hashFromSeq > 1) {
      scanRange(1, hashFromSeq - 1, false);
    }
    scanRange(hashFromSeq, meta.lastSeq, true);
    const headOk =
      (state.headDigest === null && meta.headDigest === null) ||
      (state.headDigest !== null &&
        meta.headDigest !== null &&
        sameDigest(state.headDigest, meta.headDigest));
    if (!headOk) {
      onError('ledger head digest disagrees with watermark', state.lastSeq);
    }
    let verifiedThroughSeq = meta.verifiedThroughSeq;
    if (full) {
      verifiedThroughSeq = state.lastSeq;
      this.tx(() => {
        this.db
          .prepare('UPDATE ledger_meta SET verifiedThroughSeq=? WHERE id=1')
          .run(verifiedThroughSeq);
      });
    }
    return {
      ok: true,
      algorithm: LEDGER_INTEGRITY_ALGORITHM,
      lastSeq: state.lastSeq,
      legacyThroughSeq: state.legacyThroughSeq,
      verifiedThroughSeq,
      headDigest: state.headDigest,
      checkedRows,
      hashedRows,
    };
  }
  putBlob(text) {
    const content = String(text);
    const sha256 = sha256Hex(content);
    const bytes = Buffer.byteLength(content, 'utf8');
    this.tx(() => {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO blobs(sha256, content, bytes, createdAt) VALUES(?,?,?,?)',
        )
        .run(sha256, content, bytes, Date.now());
    });
    return { sha256, uri: `artifact://${sha256}`, bytes };
  }
  getBlob(sha256OrUri) {
    const key = String(sha256OrUri).replace(/^artifact:\/\//, '');
    const row = this.db
      .prepare('SELECT sha256, content, bytes, createdAt FROM blobs WHERE sha256=?')
      .get(key);
    if (!row) throw new Fault('ARTIFACT_NOT_FOUND', 404);
    return row;
  }
  events(after = 0, task = null, project = null) {
    return this.db
      .prepare(
        'SELECT seq,timestamp,type,projectId,taskId,payload FROM events WHERE seq>? AND (? IS NULL OR taskId=?) AND (? IS NULL OR projectId=?) ORDER BY seq LIMIT 100',
      )
      .all(after, task, task, project, project)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  enqueue(kind, taskId, payload = {}) {
    this.db
      .prepare('INSERT INTO jobs(id,taskId,kind,payload) VALUES(?,?,?,?)')
      .run(id(), taskId, kind, JSON.stringify(payload));
    this.notifyJobWake();
  }
  submit({
    projectId,
    input,
    idempotencyKey,
    budget = {},
    files = {},
    approvalMode,
    pin,
  }) {
    return this.tx(() => {
      this.get('projects', projectId);
      const prev = this.db
        .prepare('SELECT taskId FROM submissions WHERE projectId=? AND key=?')
        .get(projectId, idempotencyKey);
      if (prev) {
        const task = this.get('tasks', prev.taskId);
        if (
          task.input !== input ||
          JSON.stringify(task.budget ?? {}) !== JSON.stringify(budget) ||
          JSON.stringify(task.files ?? {}) !== JSON.stringify(files) ||
          (task.approvalMode ?? undefined) !== approvalMode
        )
          throw new Fault('KEY_REUSED');
        return task;
      }
      const task = this.add(
        'tasks',
        {
          input,
          status: 'planning',
          budget,
          files,
          ...(approvalMode ? { approvalMode } : {}),
          ...(pin ? { pin } : {}),
          createdAt: Date.now(),
        },
        projectId,
      );
      this.db
        .prepare('INSERT INTO submissions VALUES(?,?,?)')
        .run(projectId, idempotencyKey, task.id);
      this.enqueue('plan', task.id);
      return task;
    });
  }
  close() {
    this.db.close();
  }
}
