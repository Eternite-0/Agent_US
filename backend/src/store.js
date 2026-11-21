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
const REQUIRED_V7_TABLES = Object.freeze([
  'records',
  'events',
  'jobs',
  'revisions',
  'submissions',
  'ledger_meta',
  'blobs',
  'direct_sessions',
  'direct_turns',
  'direct_messages',
  'direct_events',
  'direct_approvals',
  'provider_accounts',
  'provider_priorities',
  'pool_models',
  'model_mappings',
  'checkin_schedules',
  'checkin_records',
  'kv_settings',
  'nexus_memory',
  'nexus_usage',
  'turn_snapshots',
  'runtime_checkpoints',
  'runtime_jobs',
  'tool_receipts',
  'swarm_runs',
  'swarm_nodes',
  'agent_messages',
  'context_compactions',
  'scheduled_tasks',
  'worktree_leases',
  'swarm_replans',
  'child_notifications',
  'model_feedback',
  'scheduled_task_runs',
  'runtime_workers',
  'swarm_artifacts',
  'hook_trust_approvals',
  'budget_ledgers',
  'budget_reservations',
  'runtime_metrics_events',
]);

const REQUIRED_V7_INDEXES = Object.freeze([
  'swarm_replans_run_version',
  'scheduled_task_runs_sched_seq',
  'scheduled_task_runs_turn',
  'scheduled_task_runs_status',
  'scheduled_task_runs_job',
  'direct_turns_client_turn',
  'runtime_jobs_turn',
  'runtime_jobs_session',
  'runtime_jobs_task',
  'tool_receipts_turn_status',
  'scheduled_tasks_enabled_next',
  'direct_approvals_turn_kind_status',
  'direct_sessions_parent',
  'swarm_artifacts_node_fence',
  'runtime_metrics_events_kind_at',
  'runtime_metrics_events_synth_at',
  'runtime_metrics_events_run',
  'runtime_metrics_events_turn',
  'runtime_metrics_events_session',
]);

const REQUIRED_V7_COLUMNS = Object.freeze({
  events: ['integrity_mode', 'integrity_prev', 'integrity_digest'],
  direct_sessions: [
    'nonce',
    'planJson',
    'approvedPrefixes',
    'parentSessionId',
    'rootSessionId',
    'agentProfile',
    'budgetJson',
    'activeCompactionId',
    'toolAllowJson',
    'toolDenyJson',
    'trafficSource',
    'isSynthetic',
  ],
  direct_turns: [
    'jobId',
    'phase',
    'step',
    'agentProfile',
    'verdictJson',
    'evidenceCount',
    'activeFence',
    'activeAttempt',
    'trafficSource',
    'isSynthetic',
  ],
  direct_approvals: [
    'kind',
    'receiptId',
    'riskLevel',
    'effectClass',
    'outcome',
    'argsDigest',
    'consumedAt',
    'revokedAt',
    'revokedReason',
  ],
  tool_receipts: ['approvedArgsDigest', 'hookDigest'],
  swarm_runs: [
    'workspaceRoot',
    'permissionMode',
    'planVersion',
    'currentPhase',
    'replanCount',
    'errorCode',
    'errorMessage',
    'finishedAt',
    'trafficSource',
    'isSynthetic',
  ],
  swarm_nodes: [
    'taskType',
    'isolationMode',
    'allowIsolationFallback',
    'childTurnId',
    'jobId',
    'reconcileApprovalId',
    'planVersion',
    'activeJobId',
    'activeFence',
    'activeAttempt',
    'latestArtifactId',
    'worktreeLeaseId',
  ],
  scheduled_tasks: [
    'timezone',
    'concurrencyPolicy',
    'misfirePolicy',
    'maxConcurrency',
    'lastStatusRunSeq',
    'lastStatusRunId',
  ],
  scheduled_task_runs: ['runSeq', 'trigger', 'updatedAt'],
  worktree_leases: [
    'jobId',
    'fence',
    'attempt',
    'workerId',
    'baseCommit',
    'baseRef',
    'artifactId',
    'cleanupState',
    'dirtyWrites',
    'updatedAt',
  ],
  child_notifications: ['jobId', 'fence', 'attempt'],
  model_feedback: [
    'verificationStatus',
    'failureKind',
    'cancelled',
    'trafficSource',
    'isSynthetic',
  ],
  nexus_usage: ['trafficSource', 'isSynthetic'],
  budget_ledgers: ['trafficSource', 'isSynthetic'],
  budget_reservations: ['jobId', 'fence'],
});

export class Store {
  #wakeListeners = new Set();
  #wakePending = false;
  #savepointSeq = 0;
  constructor(path) {
    this.dbPath = path;
    this.db = new DatabaseSync(path);
    this.ftsEnabled = false;
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const userVersion = this.db.prepare('PRAGMA user_version').get().user_version;
      if (userVersion > 7) {
        throw new Fault('UNSUPPORTED_DATABASE_SCHEMA');
      }
      const journalMode = String(
        this.db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '',
      ).toLowerCase();
      if (journalMode !== 'wal' && path !== ':memory:') {
        this.db.exec('PRAGMA journal_mode=WAL;');
      }
      if (userVersion === 7 && this.#isSchemaV7ReadyReadOnly()) {
        this.ftsEnabled = Boolean(
          this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='direct_messages_fts'")
            .get(),
        );
      } else {
        this.#migrateSchema();
      }
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // ignore close error on failed init
      }
      throw error;
    }
  }
  #isSchemaV7ReadyReadOnly() {
    const masterRows = this.db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index','trigger')")
      .all();
    const tables = new Set();
    const indexes = new Map();
    const triggers = new Set();
    for (const row of masterRows) {
      if (row.type === 'table') tables.add(row.name);
      else if (row.type === 'index') indexes.set(row.name, String(row.sql || ''));
      else if (row.type === 'trigger') triggers.add(row.name);
    }
    for (const t of REQUIRED_V7_TABLES) {
      if (!tables.has(t)) return false;
    }
    for (const idx of REQUIRED_V7_INDEXES) {
      if (!indexes.has(idx)) return false;
    }
    if (!/\bUNIQUE\b/i.test(indexes.get('scheduled_task_runs_sched_seq') || '')) {
      return false;
    }
    if (tables.has('direct_messages_fts') && !triggers.has('direct_messages_au')) {
      return false;
    }
    for (const [table, requiredCols] of Object.entries(REQUIRED_V7_COLUMNS)) {
      const info = this.db.prepare(`PRAGMA table_info(${table})`).all();
      const colMap = new Map(info.map((c) => [c.name, c]));
      for (const col of requiredCols) {
        if (!colMap.has(col)) return false;
      }
      if (table === 'model_feedback') {
        const vp = colMap.get('verifiedPass');
        if (vp && vp.notnull === 1) return false;
      }
    }
    const hasLedgerMeta = this.db.prepare('SELECT 1 FROM ledger_meta WHERE id=1').get();
    if (!hasLedgerMeta) return false;
    return true;
  }
  #migrateSchema() {
    this.tx(() => {
      const currentVersion = this.db.prepare('PRAGMA user_version').get().user_version;
      if (currentVersion > 7) {
        throw new Fault('UNSUPPORTED_DATABASE_SCHEMA');
      }
      if (currentVersion === 7 && this.#isSchemaV7ReadyReadOnly()) {
        this.ftsEnabled = Boolean(
          this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='direct_messages_fts'")
            .get(),
        );
        return;
      }
      this.db.exec(`
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
        CREATE TABLE IF NOT EXISTS scheduled_tasks(id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, scheduleKind TEXT NOT NULL, scheduleExpr TEXT NOT NULL, workspaceRoot TEXT, model TEXT, permissionMode TEXT NOT NULL DEFAULT 'auto-safe', enabled INTEGER NOT NULL DEFAULT 1, lastRunAt INTEGER, nextRunAt INTEGER, lastSessionId TEXT, lastStatus TEXT, runHistoryJson TEXT NOT NULL DEFAULT '[]', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS worktree_leases(id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, sessionId TEXT, runId TEXT, nodeKey TEXT, workspaceRoot TEXT NOT NULL, worktreePath TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', createdAt INTEGER NOT NULL, cleanedAt INTEGER);
        CREATE INDEX IF NOT EXISTS worktree_leases_status ON worktree_leases(status, createdAt);
        CREATE TABLE IF NOT EXISTS swarm_replans(id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE, version INTEGER NOT NULL, failedNodeKey TEXT, strategy TEXT NOT NULL, reason TEXT, diffJson TEXT NOT NULL, createdAt INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS swarm_replans_run ON swarm_replans(runId, version);
        CREATE TABLE IF NOT EXISTS child_notifications(id TEXT PRIMARY KEY, idempotencyKey TEXT NOT NULL UNIQUE, parentSessionId TEXT NOT NULL, childSessionId TEXT NOT NULL, runId TEXT, nodeKey TEXT, status TEXT NOT NULL, payloadJson TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, deliveredAt INTEGER);
        CREATE INDEX IF NOT EXISTS child_notifications_parent ON child_notifications(parentSessionId, delivered, createdAt);
        CREATE TABLE IF NOT EXISTS model_feedback(id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, provider TEXT NOT NULL, taskType TEXT NOT NULL, success INTEGER NOT NULL, toolTotal INTEGER NOT NULL DEFAULT 0, toolSuccess INTEGER NOT NULL DEFAULT 0, verifiedPass INTEGER, latencyMs INTEGER NOT NULL DEFAULT 0, timedOut INTEGER NOT NULL DEFAULT 0, inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0, contextWindow INTEGER NOT NULL DEFAULT 128000, recovered INTEGER NOT NULL DEFAULT 0, verificationStatus TEXT, failureKind TEXT, cancelled INTEGER NOT NULL DEFAULT 0, trafficSource TEXT NOT NULL DEFAULT 'production', isSynthetic INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS model_feedback_model ON model_feedback(model, createdAt);
        CREATE TABLE IF NOT EXISTS scheduled_task_runs(id TEXT PRIMARY KEY, scheduleId TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE, scheduledFor INTEGER NOT NULL, idempotencyKey TEXT NOT NULL UNIQUE, jobId TEXT, sessionId TEXT, turnId TEXT, status TEXT NOT NULL DEFAULT 'queued', error TEXT, startedAt INTEGER, finishedAt INTEGER, createdAt INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS scheduled_task_runs_sched ON scheduled_task_runs(scheduleId, createdAt);
      `);
      const ensureColumns = (table, colDefs) => {
        const existing = new Set(
          this.db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .map((c) => c.name),
        );
        for (const [col, def] of colDefs) {
          if (!existing.has(col)) {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
          }
        }
      };
      ensureColumns('events', [
        ['integrity_mode', 'TEXT'],
        ['integrity_prev', 'TEXT'],
        ['integrity_digest', 'TEXT'],
      ]);
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
      ensureColumns('direct_sessions', [
        ['nonce', 'TEXT'],
        ['planJson', 'TEXT'],
        ['approvedPrefixes', "TEXT NOT NULL DEFAULT '[]'"],
        ['parentSessionId', 'TEXT'],
        ['rootSessionId', 'TEXT'],
        ['agentProfile', "TEXT NOT NULL DEFAULT 'default'"],
        ['budgetJson', 'TEXT'],
        ['activeCompactionId', 'TEXT'],
        ['toolAllowJson', 'TEXT'],
        ['toolDenyJson', 'TEXT'],
        ['trafficSource', "TEXT NOT NULL DEFAULT 'production'"],
        ['isSynthetic', 'INTEGER NOT NULL DEFAULT 0'],
      ]);
      ensureColumns('direct_turns', [
        ['jobId', 'TEXT'],
        ['phase', "TEXT NOT NULL DEFAULT 'init'"],
        ['step', 'INTEGER NOT NULL DEFAULT 0'],
        ['agentProfile', "TEXT NOT NULL DEFAULT 'default'"],
        ['verdictJson', 'TEXT'],
        ['evidenceCount', 'INTEGER NOT NULL DEFAULT 0'],
        ['activeFence', 'TEXT'],
        ['activeAttempt', 'INTEGER NOT NULL DEFAULT 0'],
        ['trafficSource', "TEXT NOT NULL DEFAULT 'production'"],
        ['isSynthetic', 'INTEGER NOT NULL DEFAULT 0'],
      ]);
      ensureColumns('direct_approvals', [
        ['kind', "TEXT NOT NULL DEFAULT 'tool'"],
        ['receiptId', 'TEXT'],
        ['riskLevel', 'TEXT'],
        ['effectClass', 'TEXT'],
        ['outcome', 'TEXT'],
        ['argsDigest', 'TEXT'],
        ['consumedAt', 'INTEGER'],
        ['revokedAt', 'INTEGER'],
        ['revokedReason', 'TEXT'],
      ]);
      ensureColumns('tool_receipts', [
        ['approvedArgsDigest', 'TEXT'],
        ['hookDigest', 'TEXT'],
      ]);
      ensureColumns('swarm_runs', [
        ['workspaceRoot', 'TEXT'],
        ['permissionMode', "TEXT NOT NULL DEFAULT 'auto-safe'"],
        ['planVersion', 'INTEGER NOT NULL DEFAULT 1'],
        ['currentPhase', "TEXT NOT NULL DEFAULT 'init'"],
        ['replanCount', 'INTEGER NOT NULL DEFAULT 0'],
        ['errorCode', 'TEXT'],
        ['errorMessage', 'TEXT'],
        ['finishedAt', 'INTEGER'],
        ['trafficSource', "TEXT NOT NULL DEFAULT 'production'"],
        ['isSynthetic', 'INTEGER NOT NULL DEFAULT 0'],
      ]);
      ensureColumns('swarm_nodes', [
        ['taskType', "TEXT NOT NULL DEFAULT 'research'"],
        ['isolationMode', "TEXT NOT NULL DEFAULT 'shared_readonly'"],
        ['allowIsolationFallback', 'INTEGER NOT NULL DEFAULT 0'],
        ['childTurnId', 'TEXT'],
        ['jobId', 'TEXT'],
        ['reconcileApprovalId', 'TEXT'],
        ['planVersion', 'INTEGER NOT NULL DEFAULT 1'],
        ['activeJobId', 'TEXT'],
        ['activeFence', 'TEXT'],
        ['activeAttempt', 'INTEGER NOT NULL DEFAULT 0'],
        ['latestArtifactId', 'TEXT'],
        ['worktreeLeaseId', 'TEXT'],
      ]);
      ensureColumns('scheduled_tasks', [
        ['timezone', "TEXT NOT NULL DEFAULT 'UTC'"],
        ['concurrencyPolicy', "TEXT NOT NULL DEFAULT 'skip'"],
        ['misfirePolicy', "TEXT NOT NULL DEFAULT 'fire_once'"],
        ['maxConcurrency', 'INTEGER NOT NULL DEFAULT 1'],
        ['lastStatusRunSeq', 'INTEGER NOT NULL DEFAULT 0'],
        ['lastStatusRunId', 'TEXT'],
      ]);
      // --- 2.1.1 Group 2: Artifacts & Leases ---
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_workers(
          workerId TEXT PRIMARY KEY,
          pid INTEGER NOT NULL,
          hostname TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          startedAt INTEGER NOT NULL,
          heartbeatAt INTEGER NOT NULL,
          stoppedAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS runtime_workers_status ON runtime_workers(status, heartbeatAt);
        CREATE TABLE IF NOT EXISTS swarm_artifacts(
          id TEXT PRIMARY KEY,
          uri TEXT NOT NULL UNIQUE,
          runId TEXT NOT NULL,
          nodeId TEXT NOT NULL,
          nodeKey TEXT NOT NULL,
          childSessionId TEXT,
          childTurnId TEXT,
          jobId TEXT,
          attempt INTEGER NOT NULL DEFAULT 1,
          ownerId TEXT NOT NULL,
          fence TEXT,
          workspaceRoot TEXT NOT NULL,
          worktreePath TEXT,
          baseCommit TEXT,
          baseRef TEXT,
          storagePath TEXT NOT NULL,
          bundleSha256 TEXT NOT NULL,
          manifestJson TEXT NOT NULL,
          fileCount INTEGER NOT NULL DEFAULT 0,
          totalBytes INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'archived',
          appliedAt INTEGER,
          applyResultJson TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS swarm_artifacts_run ON swarm_artifacts(runId, nodeKey, attempt);
        CREATE INDEX IF NOT EXISTS swarm_artifacts_node ON swarm_artifacts(nodeId, attempt);
      `);
      ensureColumns('worktree_leases', [
        ['jobId', 'TEXT'],
        ['fence', 'TEXT'],
        ['attempt', 'INTEGER NOT NULL DEFAULT 1'],
        ['workerId', 'TEXT'],
        ['baseCommit', 'TEXT'],
        ['baseRef', 'TEXT'],
        ['artifactId', 'TEXT'],
        ['cleanupState', "TEXT NOT NULL DEFAULT 'active'"],
        ['dirtyWrites', 'INTEGER NOT NULL DEFAULT 0'],
        ['updatedAt', 'INTEGER'],
      ]);
      ensureColumns('child_notifications', [
        ['jobId', 'TEXT'],
        ['fence', 'TEXT'],
        ['attempt', 'INTEGER NOT NULL DEFAULT 0'],
      ]);
      ensureColumns('nexus_usage', [
        ['trafficSource', "TEXT NOT NULL DEFAULT 'production'"],
        ['isSynthetic', 'INTEGER NOT NULL DEFAULT 0'],
      ]);
      try {
        const ftsExisted = Boolean(
          this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='direct_messages_fts'")
            .get(),
        );
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
          CREATE TRIGGER IF NOT EXISTS direct_messages_au AFTER UPDATE ON direct_messages BEGIN
            INSERT INTO direct_messages_fts(direct_messages_fts, rowid, content, sessionId, turnId, role)
            VALUES ('delete', old.seq, old.content, old.sessionId, old.turnId, old.role);
            INSERT INTO direct_messages_fts(rowid, content, sessionId, turnId, role)
            VALUES (new.seq, new.content, new.sessionId, new.turnId, new.role);
          END;
        `);
        if (!ftsExisted) {
          const hasLegacyMessages = this.db
            .prepare('SELECT 1 FROM direct_messages LIMIT 1')
            .get();
          if (hasLegacyMessages) {
            this.db.exec("INSERT INTO direct_messages_fts(direct_messages_fts) VALUES('rebuild');");
          }
        }
        this.ftsEnabled = true;
      } catch {
        this.ftsEnabled = false;
      }
      // --- 2.1.1 Group 1: Hook Trust ---
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS hook_trust_approvals(
          id TEXT PRIMARY KEY,
          configPath TEXT NOT NULL,
          workspaceRoot TEXT,
          contentDigest TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'trusted',
          approvedBy TEXT,
          note TEXT,
          approvedAt INTEGER NOT NULL,
          revokedAt INTEGER,
          updatedAt INTEGER NOT NULL,
          UNIQUE(configPath, contentDigest)
        );
        CREATE INDEX IF NOT EXISTS hook_trust_path ON hook_trust_approvals(configPath, status);
      `);
      ensureColumns('model_feedback', [
        ['verificationStatus', 'TEXT'],
        ['failureKind', 'TEXT'],
        ['cancelled', 'INTEGER NOT NULL DEFAULT 0'],
        ['trafficSource', "TEXT NOT NULL DEFAULT 'production'"],
        ['isSynthetic', 'INTEGER NOT NULL DEFAULT 0'],
      ]);
      const mfCols = this.db.prepare('PRAGMA table_info(model_feedback)').all();
      const vpCol = mfCols.find((c) => c.name === 'verifiedPass');
      if (vpCol && vpCol.notnull === 1) {
        this.db.exec(`
          DROP TABLE IF EXISTS model_feedback_v7;
          CREATE TABLE model_feedback_v7(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            model TEXT NOT NULL,
            provider TEXT NOT NULL,
            taskType TEXT NOT NULL,
            success INTEGER NOT NULL,
            toolTotal INTEGER NOT NULL DEFAULT 0,
            toolSuccess INTEGER NOT NULL DEFAULT 0,
            verifiedPass INTEGER,
            latencyMs INTEGER NOT NULL DEFAULT 0,
            timedOut INTEGER NOT NULL DEFAULT 0,
            inputTokens INTEGER NOT NULL DEFAULT 0,
            outputTokens INTEGER NOT NULL DEFAULT 0,
            contextWindow INTEGER NOT NULL DEFAULT 128000,
            recovered INTEGER NOT NULL DEFAULT 0,
            verificationStatus TEXT,
            failureKind TEXT,
            cancelled INTEGER NOT NULL DEFAULT 0,
            trafficSource TEXT NOT NULL DEFAULT 'production',
            isSynthetic INTEGER NOT NULL DEFAULT 0,
            createdAt INTEGER NOT NULL
          );
          INSERT INTO model_feedback_v7(
            id, model, provider, taskType, success, toolTotal, toolSuccess, verifiedPass,
            latencyMs, timedOut, inputTokens, outputTokens, contextWindow, recovered,
            verificationStatus, failureKind, cancelled, trafficSource, isSynthetic, createdAt
          )
          SELECT id, model, provider, taskType, success, toolTotal, toolSuccess, verifiedPass,
                 latencyMs, timedOut, inputTokens, outputTokens, contextWindow, recovered,
                 COALESCE(
                   verificationStatus,
                   CASE
                     WHEN verifiedPass = 1 THEN 'passed'
                     WHEN verifiedPass = 0 THEN 'failed'
                     ELSE 'unverified'
                   END
                 ),
                 COALESCE(
                   failureKind,
                   CASE
                     WHEN cancelled = 1 THEN 'cancelled'
                     WHEN timedOut = 1 THEN 'timeout'
                     WHEN success = 0 AND verifiedPass = 0 THEN 'verification_failure'
                     WHEN success = 0 THEN 'task_failure'
                     ELSE NULL
                   END
                 ),
                 COALESCE(cancelled, 0),
                 COALESCE(trafficSource, 'production'),
                 COALESCE(isSynthetic, 0),
                 createdAt
          FROM model_feedback;
          DROP TABLE model_feedback;
          ALTER TABLE model_feedback_v7 RENAME TO model_feedback;
          CREATE INDEX IF NOT EXISTS model_feedback_model ON model_feedback(model, createdAt);
        `);
      } else {
        this.db.exec(`
          UPDATE model_feedback
          SET verificationStatus = CASE
            WHEN verifiedPass = 1 THEN 'passed'
            WHEN verifiedPass = 0 THEN 'failed'
            ELSE 'unverified'
          END
          WHERE verificationStatus IS NULL;
          UPDATE model_feedback
          SET failureKind = CASE
            WHEN cancelled = 1 THEN 'cancelled'
            WHEN timedOut = 1 THEN 'timeout'
            WHEN verifiedPass = 0 THEN 'verification_failure'
            ELSE 'task_failure'
          END
          WHERE success = 0 AND failureKind IS NULL;
        `);
      }
      // --- 2.1.1 Group 3: Budget Ledger ---
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS budget_ledgers(
          treeId TEXT PRIMARY KEY,
          rootSessionId TEXT,
          maxTotalSteps INTEGER,
          maxTotalTokens INTEGER,
          maxOutputTokens INTEGER,
          usedSteps INTEGER NOT NULL DEFAULT 0,
          usedInputTokens INTEGER NOT NULL DEFAULT 0,
          usedOutputTokens INTEGER NOT NULL DEFAULT 0,
          reservedSteps INTEGER NOT NULL DEFAULT 0,
          reservedTokens INTEGER NOT NULL DEFAULT 0,
          estimationErrorTokens INTEGER NOT NULL DEFAULT 0,
          overageSteps INTEGER NOT NULL DEFAULT 0,
          overageTokens INTEGER NOT NULL DEFAULT 0,
          exhausted INTEGER NOT NULL DEFAULT 0,
          exhaustedReason TEXT,
          trafficSource TEXT NOT NULL DEFAULT 'production',
          isSynthetic INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS budget_reservations(
          id TEXT PRIMARY KEY,
          treeId TEXT NOT NULL REFERENCES budget_ledgers(treeId) ON DELETE CASCADE,
          scope TEXT NOT NULL,
          nodeId TEXT,
          nodeKey TEXT,
          sessionId TEXT,
          turnId TEXT,
          jobId TEXT,
          fence TEXT,
          attempt INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'reserved',
          reservedSteps INTEGER NOT NULL DEFAULT 1,
          estimatedInputTokens INTEGER NOT NULL DEFAULT 0,
          reservedOutputTokens INTEGER NOT NULL DEFAULT 0,
          reservedTotalTokens INTEGER NOT NULL DEFAULT 0,
          actualSteps INTEGER NOT NULL DEFAULT 0,
          actualInputTokens INTEGER NOT NULL DEFAULT 0,
          actualOutputTokens INTEGER NOT NULL DEFAULT 0,
          estimationErrorTokens INTEGER NOT NULL DEFAULT 0,
          overageTokens INTEGER NOT NULL DEFAULT 0,
          errorCode TEXT,
          createdAt INTEGER NOT NULL,
          settledAt INTEGER,
          updatedAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS budget_reservations_tree_status ON budget_reservations(treeId, status);
        CREATE INDEX IF NOT EXISTS budget_reservations_turn ON budget_reservations(turnId, status);
      `);
      ensureColumns('budget_ledgers', [
        ['trafficSource', "TEXT NOT NULL DEFAULT 'production'"],
        ['isSynthetic', 'INTEGER NOT NULL DEFAULT 0'],
      ]);
      ensureColumns('budget_reservations', [
        ['jobId', 'TEXT'],
        ['fence', 'TEXT'],
      ]);
      // Deduplicate conflicting legacy swarm_replans(runId, version) deterministically before creating UNIQUE index
      const dupReplanRuns = this.db
        .prepare(
          'SELECT DISTINCT runId FROM swarm_replans GROUP BY runId, version HAVING COUNT(*) > 1',
        )
        .all();
      for (const { runId } of dupReplanRuns) {
        const rows = this.db
          .prepare(
            'SELECT id FROM swarm_replans WHERE runId=? ORDER BY version ASC, createdAt ASC, rowid ASC',
          )
          .all(runId);
        rows.forEach((r, idx) => {
          this.db
            .prepare('UPDATE swarm_replans SET version=? WHERE id=?')
            .run(-(idx + 1), r.id);
        });
        rows.forEach((r, idx) => {
          this.db
            .prepare('UPDATE swarm_replans SET version=? WHERE id=?')
            .run(idx + 1, r.id);
        });
        this.db
          .prepare('UPDATE swarm_runs SET replanCount=MAX(replanCount, ?) WHERE id=?')
          .run(rows.length, runId);
      }
      this.db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS swarm_replans_run_version ON swarm_replans(runId, version)',
      );
      // --- End 2.1.1 Group 3: Budget Ledger ---
      // --- 2.1.1 Group 4: Scheduler Durability ---
      ensureColumns('scheduled_task_runs', [
        ['runSeq', 'INTEGER NOT NULL DEFAULT 0'],
        ['trigger', "TEXT NOT NULL DEFAULT 'schedule'"],
        ['updatedAt', 'INTEGER'],
      ]);
      // Normalize legacy v5 hourly scheduleExpr (e.g. '0 * * * *') to integer minute string
      const legacyHourlyRows = this.db
        .prepare("SELECT id, scheduleExpr FROM scheduled_tasks WHERE LOWER(scheduleKind)='hourly'")
        .all();
      for (const row of legacyHourlyRows) {
        const expr = String(row.scheduleExpr ?? '').trim();
        if (!expr) {
          this.db
            .prepare("UPDATE scheduled_tasks SET scheduleExpr='0' WHERE id=?")
            .run(row.id);
          continue;
        }
        if (/^:?(\d{1,2})$/.test(expr)) {
          const n = Number(expr.replace(/^:/, ''));
          if (Number.isInteger(n) && n >= 0 && n <= 59) continue;
        }
        const cronMatch = /^(\d{1,2})\s+\*\s+\*\s+\*\s+\*$/.exec(expr);
        const minute =
          cronMatch && Number(cronMatch[1]) >= 0 && Number(cronMatch[1]) <= 59
            ? String(Number(cronMatch[1]))
            : '0';
        this.db
          .prepare('UPDATE scheduled_tasks SET scheduleExpr=? WHERE id=?')
          .run(minute, row.id);
      }
      const unsequencedSchedules = this.db
        .prepare(
          'SELECT DISTINCT scheduleId FROM scheduled_task_runs WHERE runSeq IS NULL OR runSeq <= 0',
        )
        .all();
      for (const { scheduleId } of unsequencedSchedules) {
        let nextSeq =
          Number(
            this.db
              .prepare(
                'SELECT COALESCE(MAX(runSeq), 0) AS m FROM scheduled_task_runs WHERE scheduleId=? AND runSeq > 0',
              )
              .get(scheduleId)?.m ?? 0,
          ) + 1;
        const rows = this.db
          .prepare(
            'SELECT id FROM scheduled_task_runs WHERE scheduleId=? AND (runSeq IS NULL OR runSeq <= 0) ORDER BY createdAt ASC, rowid ASC',
          )
          .all(scheduleId);
        for (const r of rows) {
          this.db
            .prepare(
              'UPDATE scheduled_task_runs SET runSeq=?, updatedAt=COALESCE(updatedAt, finishedAt, startedAt, createdAt) WHERE id=?',
            )
            .run(nextSeq++, r.id);
        }
      }
      const dupSeqSchedules = this.db
        .prepare(
          'SELECT DISTINCT scheduleId FROM scheduled_task_runs WHERE runSeq > 0 GROUP BY scheduleId, runSeq HAVING COUNT(*) > 1',
        )
        .all();
      for (const { scheduleId } of dupSeqSchedules) {
        const rows = this.db
          .prepare(
            'SELECT id FROM scheduled_task_runs WHERE scheduleId=? AND runSeq > 0 ORDER BY runSeq ASC, createdAt ASC, rowid ASC',
          )
          .all(scheduleId);
        rows.forEach((r, idx) => {
          this.db
            .prepare('UPDATE scheduled_task_runs SET runSeq=? WHERE id=?')
            .run(-(idx + 1), r.id);
        });
        rows.forEach((r, idx) => {
          this.db
            .prepare('UPDATE scheduled_task_runs SET runSeq=? WHERE id=?')
            .run(idx + 1, r.id);
        });
      }
      const existingSeqIdx = this.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND name='scheduled_task_runs_sched_seq'",
        )
        .get();
      if (existingSeqIdx && !/\bUNIQUE\b/i.test(String(existingSeqIdx.sql || ''))) {
        this.db.exec('DROP INDEX scheduled_task_runs_sched_seq');
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS scheduled_task_runs_sched_seq ON scheduled_task_runs(scheduleId, runSeq) WHERE runSeq > 0;
        CREATE INDEX IF NOT EXISTS scheduled_task_runs_turn ON scheduled_task_runs(turnId);
        CREATE INDEX IF NOT EXISTS scheduled_task_runs_status ON scheduled_task_runs(status, scheduleId);
        CREATE INDEX IF NOT EXISTS scheduled_task_runs_job ON scheduled_task_runs(jobId);
        CREATE INDEX IF NOT EXISTS direct_turns_client_turn ON direct_turns(clientTurnId) WHERE clientTurnId IS NOT NULL;
      `);
      const tasksToBackfill = this.db
        .prepare('SELECT id FROM scheduled_tasks WHERE lastStatusRunSeq = 0')
        .all();
      for (const t of tasksToBackfill) {
        const latestRun = this.db
          .prepare(
            "SELECT id, runSeq, status FROM scheduled_task_runs WHERE scheduleId=? AND status IN ('running','completed','failed','cancelled') ORDER BY runSeq DESC, createdAt DESC, rowid DESC LIMIT 1",
          )
          .get(t.id);
        if (latestRun) {
          this.db
            .prepare(
              'UPDATE scheduled_tasks SET lastStatus=?, lastStatusRunSeq=?, lastStatusRunId=? WHERE id=?',
            )
            .run(latestRun.status, latestRun.runSeq, latestRun.id, t.id);
        }
      }
      // --- End 2.1.1 Group 4: Scheduler Durability ---
      // --- Phase 4 Observability & Hot-Path Indexes ---
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_metrics_events(
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          at INTEGER NOT NULL,
          isSynthetic INTEGER NOT NULL DEFAULT 0,
          trafficSource TEXT NOT NULL DEFAULT 'production',
          runId TEXT,
          nodeId TEXT,
          sessionId TEXT,
          turnId TEXT,
          jobId TEXT,
          workerId TEXT,
          attempt INTEGER,
          fence TEXT,
          model TEXT,
          provider TEXT,
          accountId TEXT,
          toolCallId TEXT,
          artifactId TEXT,
          ok INTEGER,
          durationMs REAL,
          code TEXT,
          detailJson TEXT
        );
        CREATE INDEX IF NOT EXISTS runtime_metrics_events_kind_at ON runtime_metrics_events(kind, at);
        CREATE INDEX IF NOT EXISTS runtime_metrics_events_synth_at ON runtime_metrics_events(isSynthetic, at);
        CREATE INDEX IF NOT EXISTS runtime_metrics_events_run ON runtime_metrics_events(runId);
        CREATE INDEX IF NOT EXISTS runtime_metrics_events_turn ON runtime_metrics_events(turnId);
        CREATE INDEX IF NOT EXISTS runtime_metrics_events_session ON runtime_metrics_events(sessionId);
        CREATE INDEX IF NOT EXISTS runtime_jobs_turn ON runtime_jobs(turnId);
        CREATE INDEX IF NOT EXISTS runtime_jobs_session ON runtime_jobs(sessionId);
        CREATE INDEX IF NOT EXISTS runtime_jobs_task ON runtime_jobs(taskId);
        CREATE INDEX IF NOT EXISTS tool_receipts_turn_status ON tool_receipts(turnId, status);
        CREATE INDEX IF NOT EXISTS scheduled_tasks_enabled_next ON scheduled_tasks(enabled, nextRunAt);
        CREATE INDEX IF NOT EXISTS direct_approvals_turn_kind_status ON direct_approvals(turnId, kind, status);
        CREATE INDEX IF NOT EXISTS direct_sessions_parent ON direct_sessions(parentSessionId);
      `);
      const dupArtFences = this.db
        .prepare(
          'SELECT nodeId, fence FROM swarm_artifacts WHERE fence IS NOT NULL GROUP BY nodeId, fence HAVING COUNT(*) > 1',
        )
        .all();
      for (const { nodeId, fence } of dupArtFences) {
        const rows = this.db
          .prepare(
            'SELECT id FROM swarm_artifacts WHERE nodeId=? AND fence=? ORDER BY createdAt DESC, rowid DESC',
          )
          .all(nodeId, fence);
        for (const stale of rows.slice(1)) {
          this.db.prepare('UPDATE swarm_artifacts SET fence=NULL WHERE id=?').run(stale.id);
        }
      }
      this.db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS swarm_artifacts_node_fence ON swarm_artifacts(nodeId, fence) WHERE fence IS NOT NULL',
      );
      this.db.exec('PRAGMA user_version=7');
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
    if (this.db.isTransaction) {
      const sp = `sp_${++this.#savepointSeq}`;
      const prevWakePending = this.#wakePending;
      this.db.exec(`SAVEPOINT ${sp}`);
      try {
        const result = fn();
        if (result instanceof Promise) throw Error('async transaction');
        if (this.db.isTransaction) {
          this.db.exec(`RELEASE SAVEPOINT ${sp}`);
        }
        return result;
      } catch (error) {
        this.#wakePending = prevWakePending;
        if (this.db.isTransaction) {
          try {
            this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp};`);
          } catch {
            // outer transaction may have been rolled back by SQLite
          }
        }
        throw error;
      }
    }
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
      if (this.db.isTransaction) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // transaction already rolled back by SQLite
        }
      }
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
