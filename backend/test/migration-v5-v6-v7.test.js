import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store, id as uuid } from '../src/store.js';
import { computeNextRunAt } from '../src/governance/cron.js';
import { updateTaskStatusMonotonicTx } from '../src/governance/scheduler.js';
import {
  classifyTrafficSource,
  compactTrace,
  getTraceContext,
  withTraceContext,
} from '../src/observability/trace.js';
import { getLogLevel, logEvent } from '../src/observability/logger.js';
import { MetricsCollector } from '../src/observability/metrics.js';

const SRC_ROOT = resolve(import.meta.dirname, '..', 'src');

function cleanupDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  } catch {
    // ignore transient Windows cleanup races
  }
}

function getColumnMap(db, table) {
  return new Map(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => [c.name, c]));
}

function getIndexMap(db) {
  return new Map(
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='index'")
      .all()
      .map((r) => [r.name, String(r.sql || '')]),
  );
}

/**
 * Builds a genuine historical Schema v5 SQLite database matching commit 5b41a04,
 * optionally omitting direct_messages_fts to also cover pre-FTS5 legacy DBs.
 */
function createRealV5Database(dbPath, { includeFts = false } = {}) {
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, projectId TEXT REFERENCES records(id), taskId TEXT REFERENCES records(id), version INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE INDEX children ON records(kind, taskId, projectId);
    CREATE TABLE events(seq INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, type TEXT NOT NULL, projectId TEXT, taskId TEXT, payload TEXT NOT NULL, integrity_mode TEXT, integrity_prev TEXT, integrity_digest TEXT);
    CREATE INDEX task_events ON events(taskId, seq);
    CREATE TABLE jobs(id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES records(id), kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', fence TEXT, expires INTEGER, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE revisions(id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id, version));
    CREATE TRIGGER preserve_revision AFTER UPDATE ON records BEGIN INSERT INTO revisions(id, version, body) VALUES(OLD.id, OLD.version, OLD.body); END;
    CREATE TABLE submissions(projectId TEXT, key TEXT, taskId TEXT REFERENCES records(id), PRIMARY KEY(projectId, key));
    CREATE TABLE ledger_meta(id INTEGER PRIMARY KEY CHECK(id=1), lastSeq INTEGER NOT NULL, legacyThroughSeq INTEGER NOT NULL, headDigest TEXT, verifiedThroughSeq INTEGER NOT NULL);
    CREATE TABLE blobs(sha256 TEXT PRIMARY KEY, content TEXT NOT NULL, bytes INTEGER NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE direct_sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL, workspaceRoot TEXT, model TEXT, mode TEXT NOT NULL DEFAULT 'direct', permissionMode TEXT NOT NULL DEFAULT 'auto-safe', state TEXT NOT NULL DEFAULT 'idle', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, nonce TEXT, planJson TEXT, approvedPrefixes TEXT NOT NULL DEFAULT '[]', parentSessionId TEXT, rootSessionId TEXT, agentProfile TEXT NOT NULL DEFAULT 'default', budgetJson TEXT, activeCompactionId TEXT);
    CREATE TABLE direct_turns(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES direct_sessions(id) ON DELETE CASCADE, clientTurnId TEXT, input TEXT NOT NULL, model TEXT, state TEXT NOT NULL DEFAULT 'running', error TEXT, inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0, costUsd REAL NOT NULL DEFAULT 0, durationMs INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, finishedAt INTEGER, jobId TEXT, phase TEXT NOT NULL DEFAULT 'init', step INTEGER NOT NULL DEFAULT 0, agentProfile TEXT NOT NULL DEFAULT 'default', verdictJson TEXT, evidenceCount INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX direct_turns_session ON direct_turns(sessionId, createdAt);
    CREATE TABLE direct_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT NOT NULL REFERENCES direct_sessions(id) ON DELETE CASCADE, turnId TEXT, role TEXT NOT NULL, content TEXT NOT NULL, reasoning TEXT, toolCalls TEXT, toolCallId TEXT, toolName TEXT, meta TEXT, createdAt INTEGER NOT NULL);
    CREATE INDEX direct_messages_session ON direct_messages(sessionId, seq);
    CREATE TABLE direct_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT NOT NULL, turnId TEXT, type TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX direct_events_session ON direct_events(sessionId, seq);
    CREATE TABLE direct_approvals(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, turnId TEXT, callId TEXT, tool TEXT NOT NULL, arguments TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', scope TEXT, reason TEXT, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, resolvedAt INTEGER, kind TEXT NOT NULL DEFAULT 'tool', receiptId TEXT, riskLevel TEXT, effectClass TEXT, outcome TEXT);
    CREATE INDEX direct_approvals_session ON direct_approvals(sessionId, status);
    CREATE TABLE provider_accounts(id TEXT PRIMARY KEY, preset TEXT NOT NULL, label TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'official', priority INTEGER NOT NULL DEFAULT 100, enabled INTEGER NOT NULL DEFAULT 1, endpoint TEXT, proxyUrl TEXT, headers TEXT NOT NULL DEFAULT '{}', models TEXT NOT NULL DEFAULT '[]', modelProfiles TEXT NOT NULL DEFAULT '{}', credentialEnc TEXT, credentialMask TEXT, status TEXT NOT NULL DEFAULT 'unknown', lastError TEXT, lastErrorAt INTEGER, cooldownUntil INTEGER NOT NULL DEFAULT 0, lastSuccessAt INTEGER, balanceJson TEXT, expiresAt INTEGER, activeConns INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE provider_priorities(preset TEXT PRIMARY KEY, rank INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE pool_models(id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE, preset TEXT NOT NULL, upstreamModel TEXT NOT NULL, displayName TEXT, enabled INTEGER NOT NULL DEFAULT 1, visible INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'remote', multiplier REAL NOT NULL DEFAULT 1.0, contextWindow INTEGER NOT NULL DEFAULT 128000, maxOutput INTEGER NOT NULL DEFAULT 16384, capabilities TEXT NOT NULL DEFAULT '{}', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, UNIQUE(accountId, upstreamModel));
    CREATE INDEX pool_models_preset ON pool_models(preset, enabled);
    CREATE TABLE model_mappings(id TEXT PRIMARY KEY, alias TEXT NOT NULL, targetPreset TEXT, targetAccountId TEXT, targetModel TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, isDefault INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 100, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE INDEX model_mappings_alias ON model_mappings(alias, enabled);
    CREATE TABLE checkin_schedules(id TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, time TEXT NOT NULL DEFAULT '09:00', timeEnd TEXT, providers TEXT NOT NULL DEFAULT '[]', providerTimes TEXT NOT NULL DEFAULT '{}', retryTime TEXT DEFAULT '21:00', retryGapMinutes INTEGER NOT NULL DEFAULT 30, retryLimit INTEGER NOT NULL DEFAULT 2, lastFiredDate TEXT, lastResultJson TEXT, updatedAt INTEGER NOT NULL);
    CREATE TABLE checkin_records(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, date TEXT NOT NULL, accountId TEXT, accountName TEXT, providerId TEXT NOT NULL, providerLabel TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'manual', section TEXT NOT NULL DEFAULT 'daily', outcome TEXT NOT NULL, message TEXT, error TEXT, points INTEGER NOT NULL DEFAULT 0, meta TEXT);
    CREATE INDEX checkin_records_date ON checkin_records(date, providerId);
    CREATE TABLE kv_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE nexus_memory(id TEXT PRIMARY KEY, scopeType TEXT NOT NULL, scopeId TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note', tags TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL DEFAULT 1.0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, lastAccessedAt INTEGER, UNIQUE(scopeType, scopeId, key));
    CREATE TABLE nexus_usage(id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT, planId TEXT, provider TEXT, model TEXT, accountId TEXT, day TEXT NOT NULL, inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, costUsd REAL NOT NULL DEFAULT 0, durationMs INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
    CREATE INDEX nexus_usage_day ON nexus_usage(day, sessionId);
    CREATE TABLE turn_snapshots(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES direct_sessions(id) ON DELETE CASCADE, turnId TEXT NOT NULL, path TEXT NOT NULL, existed INTEGER NOT NULL, beforeSha256 TEXT, afterSha256 TEXT, createdAt INTEGER NOT NULL, UNIQUE(turnId, path));
    CREATE INDEX turn_snapshots_session ON turn_snapshots(sessionId, createdAt);
    CREATE TABLE runtime_checkpoints(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, turnId TEXT NOT NULL, step INTEGER NOT NULL, phase TEXT NOT NULL, stateJson TEXT NOT NULL, ledgerSeq INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
    CREATE INDEX runtime_checkpoints_session ON runtime_checkpoints(sessionId, createdAt);
    CREATE INDEX runtime_checkpoints_turn ON runtime_checkpoints(turnId, step);
    CREATE TABLE runtime_jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, sessionId TEXT, turnId TEXT, taskId TEXT, parentJobId TEXT, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', fence TEXT, workerId TEXT, leaseExpiresAt INTEGER, attempts INTEGER NOT NULL DEFAULT 0, maxAttempts INTEGER NOT NULL DEFAULT 3, idempotencyKey TEXT, errorCode TEXT, errorMessage TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE INDEX runtime_jobs_status ON runtime_jobs(status, leaseExpiresAt);
    CREATE UNIQUE INDEX runtime_jobs_idem ON runtime_jobs(idempotencyKey) WHERE idempotencyKey IS NOT NULL;
    CREATE TABLE tool_receipts(id TEXT PRIMARY KEY, sessionId TEXT, turnId TEXT, taskId TEXT, callId TEXT NOT NULL, toolName TEXT NOT NULL, riskLevel TEXT NOT NULL, effectClass TEXT NOT NULL, replayable INTEGER NOT NULL, outward INTEGER NOT NULL, argsDigest TEXT NOT NULL, approvalId TEXT, permitEffectId TEXT, status TEXT NOT NULL, outputDigest TEXT, exitCode INTEGER, durationMs INTEGER NOT NULL DEFAULT 0, errorCode TEXT, reconciliationOutcome TEXT, reconciliationNote TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE INDEX tool_receipts_turn ON tool_receipts(sessionId, turnId);
    CREATE INDEX tool_receipts_status ON tool_receipts(status);
    CREATE TABLE swarm_runs(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, rootTurnId TEXT, goal TEXT NOT NULL, status TEXT NOT NULL, strategyJson TEXT NOT NULL, budgetJson TEXT NOT NULL, usageJson TEXT NOT NULL DEFAULT '{}', verdictJson TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE INDEX swarm_runs_session ON swarm_runs(sessionId, createdAt);
    CREATE TABLE swarm_nodes(id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE, nodeKey TEXT NOT NULL, parentNodeId TEXT, agentProfileId TEXT NOT NULL, childSessionId TEXT, model TEXT, provider TEXT, objective TEXT NOT NULL, acceptance TEXT NOT NULL, dependenciesJson TEXT NOT NULL DEFAULT '[]', toolAllowJson TEXT, permissionMode TEXT NOT NULL DEFAULT 'auto-safe', worktreePath TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER NOT NULL DEFAULT 0, budgetJson TEXT NOT NULL DEFAULT '{}', resultText TEXT, artifactUrisJson TEXT NOT NULL DEFAULT '[]', errorCode TEXT, errorMessage TEXT, attempts INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, UNIQUE(runId, nodeKey));
    CREATE INDEX swarm_nodes_run ON swarm_nodes(runId, status);
    CREATE TABLE agent_messages(id TEXT PRIMARY KEY, runId TEXT, fromAgentId TEXT NOT NULL, toAgentId TEXT NOT NULL, kind TEXT NOT NULL, payloadJson TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', createdAt INTEGER NOT NULL, deliveredAt INTEGER);
    CREATE INDEX agent_messages_recipient ON agent_messages(toAgentId, status, createdAt);
    CREATE TABLE context_compactions(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, turnId TEXT, stage TEXT NOT NULL, coveredThroughSeq INTEGER NOT NULL, summaryText TEXT NOT NULL, taskStateJson TEXT NOT NULL, preservedConstraintsJson TEXT NOT NULL, tokenBefore INTEGER NOT NULL, tokenAfter INTEGER NOT NULL, createdAt INTEGER NOT NULL);
    CREATE INDEX context_compactions_session ON context_compactions(sessionId, createdAt);
    CREATE TABLE scheduled_tasks(id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, scheduleKind TEXT NOT NULL, scheduleExpr TEXT NOT NULL, workspaceRoot TEXT, model TEXT, permissionMode TEXT NOT NULL DEFAULT 'auto-safe', enabled INTEGER NOT NULL DEFAULT 1, lastRunAt INTEGER, nextRunAt INTEGER, lastSessionId TEXT, lastStatus TEXT, runHistoryJson TEXT NOT NULL DEFAULT '[]', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);

    INSERT INTO events(seq, timestamp, type, projectId, taskId, payload) VALUES (1, 1000, 'legacy.v5.event', NULL, NULL, '{"v":5}');
    INSERT INTO ledger_meta(id, lastSeq, legacyThroughSeq, headDigest, verifiedThroughSeq) VALUES (1, 1, 1, NULL, 0);
    INSERT INTO direct_sessions(id, title, workspaceRoot, model, state, createdAt, updatedAt) VALUES ('sess-v5', 'V5 Session', '/tmp/v5', 'mock-v5', 'completed', 1000, 2000);
    INSERT INTO direct_turns(id, sessionId, input, model, state, createdAt, finishedAt) VALUES ('turn-v5', 'sess-v5', 'hello v5', 'mock-v5', 'completed', 1000, 2000);
    INSERT INTO direct_messages(sessionId, turnId, role, content, createdAt) VALUES ('sess-v5', 'turn-v5', 'user', 'legacy v5 searchable needle alpha', 1000);
    INSERT INTO direct_messages(sessionId, turnId, role, content, createdAt) VALUES ('sess-v5', 'turn-v5', 'assistant', 'legacy v5 response beta', 1500);
    INSERT INTO direct_approvals(id, sessionId, turnId, callId, tool, arguments, status, expiresAt, createdAt) VALUES ('appr-v5', 'sess-v5', 'turn-v5', 'call-v5', 'bash', '{"command":"ls"}', 'allowed', 9000, 1000);
    INSERT INTO tool_receipts(id, sessionId, turnId, callId, toolName, riskLevel, effectClass, replayable, outward, argsDigest, status, durationMs, createdAt, updatedAt) VALUES ('rec-v5', 'sess-v5', 'turn-v5', 'call-v5', 'bash', 'medium', 'workspace_write', 0, 0, 'dig-v5', 'finished', 15, 1000, 1015);
    INSERT INTO swarm_runs(id, sessionId, rootTurnId, goal, status, strategyJson, budgetJson, usageJson, createdAt, updatedAt) VALUES ('run-v5', 'sess-v5', 'turn-v5', 'v5 goal', 'completed', '{}', '{}', '{}', 1000, 2000);
    INSERT INTO swarm_nodes(id, runId, nodeKey, agentProfileId, objective, acceptance, status, createdAt, updatedAt) VALUES ('node-v5', 'run-v5', 'n1', 'default', 'do v5 work', 'done', 'completed', 1000, 2000);
    INSERT INTO scheduled_tasks(id, name, prompt, scheduleKind, scheduleExpr, enabled, nextRunAt, createdAt, updatedAt) VALUES ('sched-v5-hourly-0', 'Legacy Hourly 0', 'run hourly', 'hourly', '0 * * * *', 1, 5000, 1000, 1000);
    INSERT INTO scheduled_tasks(id, name, prompt, scheduleKind, scheduleExpr, enabled, nextRunAt, createdAt, updatedAt) VALUES ('sched-v5-hourly-15', 'Legacy Hourly 15', 'run hourly 15', 'hourly', '15 * * * *', 1, 5000, 1000, 1000);
    INSERT INTO scheduled_tasks(id, name, prompt, scheduleKind, scheduleExpr, enabled, nextRunAt, createdAt, updatedAt) VALUES ('sched-v5-hourly-bad', 'Legacy Hourly Bad', 'run bad', 'hourly', 'every-hour', 1, 5000, 1000, 1000);
  `);
  if (includeFts) {
    raw.exec(`
      CREATE VIRTUAL TABLE direct_messages_fts USING fts5(content, sessionId UNINDEXED, turnId UNINDEXED, role UNINDEXED, content='direct_messages', content_rowid='seq');
      INSERT INTO direct_messages_fts(direct_messages_fts) VALUES('rebuild');
      CREATE TRIGGER direct_messages_ai AFTER INSERT ON direct_messages BEGIN INSERT INTO direct_messages_fts(rowid, content, sessionId, turnId, role) VALUES (new.seq, new.content, new.sessionId, new.turnId, new.role); END;
      CREATE TRIGGER direct_messages_ad AFTER DELETE ON direct_messages BEGIN INSERT INTO direct_messages_fts(direct_messages_fts, rowid, content, sessionId, turnId, role) VALUES ('delete', old.seq, old.content, old.sessionId, old.turnId, old.role); END;
    `);
  }
  raw.exec('PRAGMA user_version=5;');
  raw.close();
}

/**
 * Applies the exact Schema v6 upgrade (commit 753f3f1) on top of a v5 database,
 * populating v6 tables with realistic rows including edge cases (NOT NULL verifiedPass,
 * duplicate swarm_replans(runId, version), stale scheduled_tasks.lastStatus).
 */
function upgradeV5ToRealV6(dbPath) {
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    PRAGMA foreign_keys=ON;
    ALTER TABLE direct_approvals ADD COLUMN argsDigest TEXT;
    ALTER TABLE tool_receipts ADD COLUMN approvedArgsDigest TEXT;
    ALTER TABLE tool_receipts ADD COLUMN hookDigest TEXT;
    ALTER TABLE swarm_runs ADD COLUMN workspaceRoot TEXT;
    ALTER TABLE swarm_runs ADD COLUMN permissionMode TEXT NOT NULL DEFAULT 'auto-safe';
    ALTER TABLE swarm_runs ADD COLUMN planVersion INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE swarm_runs ADD COLUMN currentPhase TEXT NOT NULL DEFAULT 'init';
    ALTER TABLE swarm_runs ADD COLUMN replanCount INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE swarm_runs ADD COLUMN errorCode TEXT;
    ALTER TABLE swarm_runs ADD COLUMN errorMessage TEXT;
    ALTER TABLE swarm_nodes ADD COLUMN taskType TEXT NOT NULL DEFAULT 'research';
    ALTER TABLE swarm_nodes ADD COLUMN isolationMode TEXT NOT NULL DEFAULT 'shared_readonly';
    ALTER TABLE swarm_nodes ADD COLUMN allowIsolationFallback INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE swarm_nodes ADD COLUMN childTurnId TEXT;
    ALTER TABLE swarm_nodes ADD COLUMN jobId TEXT;
    ALTER TABLE swarm_nodes ADD COLUMN reconcileApprovalId TEXT;
    ALTER TABLE swarm_nodes ADD COLUMN planVersion INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE scheduled_tasks ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
    ALTER TABLE scheduled_tasks ADD COLUMN concurrencyPolicy TEXT NOT NULL DEFAULT 'skip';
    ALTER TABLE scheduled_tasks ADD COLUMN misfirePolicy TEXT NOT NULL DEFAULT 'fire_once';
    ALTER TABLE scheduled_tasks ADD COLUMN maxConcurrency INTEGER NOT NULL DEFAULT 1;

    CREATE TABLE worktree_leases(id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, sessionId TEXT, runId TEXT, nodeKey TEXT, workspaceRoot TEXT NOT NULL, worktreePath TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', createdAt INTEGER NOT NULL, cleanedAt INTEGER);
    CREATE INDEX worktree_leases_status ON worktree_leases(status, createdAt);
    CREATE TABLE swarm_replans(id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE, version INTEGER NOT NULL, failedNodeKey TEXT, strategy TEXT NOT NULL, reason TEXT, diffJson TEXT NOT NULL, createdAt INTEGER NOT NULL);
    CREATE INDEX swarm_replans_run ON swarm_replans(runId, version);
    CREATE TABLE child_notifications(id TEXT PRIMARY KEY, idempotencyKey TEXT NOT NULL UNIQUE, parentSessionId TEXT NOT NULL, childSessionId TEXT NOT NULL, runId TEXT, nodeKey TEXT, status TEXT NOT NULL, payloadJson TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, deliveredAt INTEGER);
    CREATE INDEX child_notifications_parent ON child_notifications(parentSessionId, delivered, createdAt);
    CREATE TABLE model_feedback(id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, provider TEXT NOT NULL, taskType TEXT NOT NULL, success INTEGER NOT NULL, toolTotal INTEGER NOT NULL DEFAULT 0, toolSuccess INTEGER NOT NULL DEFAULT 0, verifiedPass INTEGER NOT NULL DEFAULT 1, latencyMs INTEGER NOT NULL DEFAULT 0, timedOut INTEGER NOT NULL DEFAULT 0, inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0, contextWindow INTEGER NOT NULL DEFAULT 128000, recovered INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
    CREATE INDEX model_feedback_model ON model_feedback(model, createdAt);
    CREATE TABLE scheduled_task_runs(id TEXT PRIMARY KEY, scheduleId TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE, scheduledFor INTEGER NOT NULL, idempotencyKey TEXT NOT NULL UNIQUE, jobId TEXT, sessionId TEXT, turnId TEXT, status TEXT NOT NULL DEFAULT 'queued', error TEXT, startedAt INTEGER, finishedAt INTEGER, createdAt INTEGER NOT NULL);
    CREATE INDEX scheduled_task_runs_sched ON scheduled_task_runs(scheduleId, createdAt);

    INSERT INTO worktree_leases(id, ownerId, sessionId, runId, nodeKey, workspaceRoot, worktreePath, status, createdAt)
      VALUES('wt-v6', 'sess-v5', 'sess-v5', 'run-v5', 'n1', '/tmp/v5', '/tmp/v5-wt', 'active', 2100);
    INSERT INTO child_notifications(id, idempotencyKey, parentSessionId, childSessionId, runId, nodeKey, status, payloadJson, delivered, createdAt)
      VALUES('notif-v6', 'notify:v6:1', 'sess-v5', 'child-v6', 'run-v5', 'n1', 'completed', '{"ok":true}', 0, 2200);
    INSERT INTO swarm_replans(id, runId, version, failedNodeKey, strategy, reason, diffJson, createdAt)
      VALUES('rep-v6-a', 'run-v5', 1, 'n1', 'retry_alt', 'first collision', '{}', 2300);
    INSERT INTO swarm_replans(id, runId, version, failedNodeKey, strategy, reason, diffJson, createdAt)
      VALUES('rep-v6-b', 'run-v5', 1, 'n1', 'split', 'duplicate v1 in v6', '{}', 2400);
    INSERT INTO swarm_replans(id, runId, version, failedNodeKey, strategy, reason, diffJson, createdAt)
      VALUES('rep-v6-c', 'run-v5', 2, 'n1', 'fallback', 'v2 row', '{}', 2500);
    INSERT INTO model_feedback(model, provider, taskType, success, toolTotal, toolSuccess, verifiedPass, latencyMs, timedOut, inputTokens, outputTokens, createdAt)
      VALUES('v6-ok-model', 'openai', 'direct', 1, 2, 2, 1, 500, 0, 100, 50, 2600);
    INSERT INTO model_feedback(model, provider, taskType, success, toolTotal, toolSuccess, verifiedPass, latencyMs, timedOut, inputTokens, outputTokens, createdAt)
      VALUES('v6-fail-model', 'openai', 'direct', 0, 1, 0, 0, 900, 1, 80, 10, 2700);

    INSERT INTO scheduled_tasks(id, name, prompt, scheduleKind, scheduleExpr, timezone, concurrencyPolicy, misfirePolicy, maxConcurrency, enabled, lastStatus, createdAt, updatedAt)
      VALUES('sched-v6-stale', 'Stale Status Schedule', 'check drift', 'daily', '09:00', 'America/New_York', 'queue', 'fire_once', 1, 1, 'completed', 2000, 2000);
    INSERT INTO scheduled_task_runs(id, scheduleId, scheduledFor, idempotencyKey, status, createdAt)
      VALUES('run-v6-1', 'sched-v6-stale', 2100, 'sched:sched-v6-stale:2100', 'completed', 2100);
    INSERT INTO scheduled_task_runs(id, scheduleId, scheduledFor, idempotencyKey, status, createdAt)
      VALUES('run-v6-2', 'sched-v6-stale', 2200, 'sched:sched-v6-stale:2200', 'running', 2200);

    PRAGMA user_version=6;
  `);
  raw.close();
}

test('1. Fresh DB init reaches user_version=7 with all tables, additive columns, indexes, and FTS5 triggers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-mig-fresh-'));
  const dbPath = join(dir, 'fresh.sqlite');
  let store;
  try {
    store = new Store(dbPath);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(store.ftsEnabled, true);
    assert.equal(
      String(store.db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(),
      'wal',
    );

    const indexes = getIndexMap(store.db);
    for (const idxName of [
      'runtime_jobs_turn',
      'runtime_jobs_session',
      'runtime_jobs_task',
      'tool_receipts_turn_status',
      'scheduled_tasks_enabled_next',
      'direct_approvals_turn_kind_status',
      'direct_sessions_parent',
      'scheduled_task_runs_job',
      'scheduled_task_runs_sched_seq',
      'swarm_artifacts_node_fence',
      'swarm_replans_run_version',
      'runtime_metrics_events_kind_at',
      'runtime_metrics_events_synth_at',
      'runtime_metrics_events_run',
      'runtime_metrics_events_turn',
      'runtime_metrics_events_session',
    ]) {
      assert.ok(indexes.has(idxName), `Expected index ${idxName} to exist`);
    }
    assert.match(indexes.get('scheduled_task_runs_sched_seq'), /\bUNIQUE\b/i);
    assert.match(indexes.get('swarm_artifacts_node_fence'), /\bUNIQUE\b/i);

    assert.ok(getColumnMap(store.db, 'budget_reservations').has('jobId'));
    assert.ok(getColumnMap(store.db, 'budget_reservations').has('fence'));
    assert.ok(getColumnMap(store.db, 'direct_approvals').has('consumedAt'));
    assert.ok(getColumnMap(store.db, 'direct_approvals').has('revokedAt'));
    assert.ok(getColumnMap(store.db, 'direct_approvals').has('revokedReason'));
    assert.ok(getColumnMap(store.db, 'swarm_runs').has('finishedAt'));
    for (const tbl of [
      'direct_sessions',
      'direct_turns',
      'swarm_runs',
      'model_feedback',
      'nexus_usage',
      'budget_ledgers',
    ]) {
      const cols = getColumnMap(store.db, tbl);
      assert.ok(cols.has('trafficSource'), `${tbl} must have trafficSource`);
      assert.ok(cols.has('isSynthetic'), `${tbl} must have isSynthetic`);
    }
    assert.equal(getColumnMap(store.db, 'model_feedback').get('verifiedPass').notnull, 0);

    // Verify FTS5 insert, update, delete, and integrity-check
    const now = Date.now();
    store.tx(() => {
      store.db
        .prepare(
          "INSERT INTO direct_sessions(id, title, createdAt, updatedAt) VALUES('s1','Fresh',?,?)",
        )
        .run(now, now);
      store.db
        .prepare(
          "INSERT INTO direct_messages(sessionId, turnId, role, content, createdAt) VALUES('s1','t1','user','unique fresh needle',?)",
        )
        .run(now);
    });
    assert.equal(store.searchDirectHistory('needle').length, 1);
    store.db
      .prepare("UPDATE direct_messages SET content='updated fresh quartz' WHERE sessionId='s1'")
      .run();
    assert.equal(store.searchDirectHistory('needle').length, 0);
    assert.equal(store.searchDirectHistory('quartz').length, 1);
    store.db.prepare("DELETE FROM direct_messages WHERE sessionId='s1'").run();
    store.db.exec("INSERT INTO direct_messages_fts(direct_messages_fts) VALUES('integrity-check')");
  } finally {
    store?.close?.();
    cleanupDir(dir);
  }
});

test('2. Real v5->v7 and v5->v6->v7 migrations normalize legacy hourly schedules, rebuild FTS5 cleanly, and preserve ledger integrity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-mig-v5-'));
  const dbDirectV7 = join(dir, 'v5-direct-to-v7.sqlite');
  const dbSteppedV7 = join(dir, 'v5-to-v6-to-v7.sqlite');
  let s1;
  let s2;
  try {
    // 2A: Direct v5 (pre-FTS5 messages) -> v7
    createRealV5Database(dbDirectV7, { includeFts: false });
    s1 = new Store(dbDirectV7);
    assert.equal(s1.db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(s1.ftsEnabled, true);

    // Legacy v5 hourly schedule expressions normalized and valid for cron evaluation
    const h0 = s1.db.prepare("SELECT scheduleExpr FROM scheduled_tasks WHERE id='sched-v5-hourly-0'").get();
    const h15 = s1.db.prepare("SELECT scheduleExpr FROM scheduled_tasks WHERE id='sched-v5-hourly-15'").get();
    const hBad = s1.db.prepare("SELECT scheduleExpr FROM scheduled_tasks WHERE id='sched-v5-hourly-bad'").get();
    assert.equal(h0.scheduleExpr, '0');
    assert.equal(h15.scheduleExpr, '15');
    assert.equal(hBad.scheduleExpr, '0');
    assert.ok(computeNextRunAt('hourly', h0.scheduleExpr, Date.now(), { timezone: 'UTC' }) > 0);
    assert.ok(computeNextRunAt('hourly', h15.scheduleExpr, Date.now(), { timezone: 'UTC' }) > 0);
    assert.ok(computeNextRunAt('hourly', hBad.scheduleExpr, Date.now(), { timezone: 'UTC' }) > 0);

    // Pre-FTS5 legacy direct_messages are searchable AND safe to update/delete without corruption!
    const hits = s1.searchDirectHistory('needle');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sessionId, 'sess-v5');
    s1.db.prepare("UPDATE direct_messages SET content='rewritten v5 msg' WHERE sessionId='sess-v5' AND role='user'").run();
    assert.equal(s1.searchDirectHistory('rewritten').length, 1);
    s1.db.prepare("DELETE FROM direct_messages WHERE sessionId='sess-v5'").run();
    s1.db.exec("INSERT INTO direct_messages_fts(direct_messages_fts) VALUES('integrity-check')");

    // Hash-chained ledger integrity survives v5 -> v7 and chains new events from anchor
    s1.event('post.v7.event', null, null, { migrated: true });
    const integ1 = s1.verifyIntegrity({ full: true });
    assert.equal(integ1.ok, true);
    assert.equal(integ1.legacyThroughSeq, 1);
    assert.equal(integ1.lastSeq, 2);

    // 2B: Stepped v5 -> v6 -> v7
    createRealV5Database(dbSteppedV7, { includeFts: true });
    upgradeV5ToRealV6(dbSteppedV7);
    s2 = new Store(dbSteppedV7);
    assert.equal(s2.db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(
      s2.db.prepare("SELECT scheduleExpr FROM scheduled_tasks WHERE id='sched-v5-hourly-15'").get().scheduleExpr,
      '15',
    );
    s2.event('post.stepped.v7', null, null, { stepped: true });
    const integ2 = s2.verifyIntegrity({ full: true });
    assert.equal(integ2.ok, true);
    assert.equal(integ2.lastSeq, 2);
  } finally {
    s1?.close?.();
    s2?.close?.();
    cleanupDir(dir);
  }
});

test('3. Real full v6->v7 migration fixes model_feedback, stale scheduled_tasks.lastStatus, duplicate swarm_replans, and upgrades unique indexes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-mig-v6-'));
  const dbPath = join(dir, 'full-v6.sqlite');
  let store;
  try {
    createRealV5Database(dbPath, { includeFts: true });
    upgradeV5ToRealV6(dbPath);

    // Also add an older non-unique scheduled_task_runs_sched_seq index to verify upgrade to UNIQUE
    const rawPre = new DatabaseSync(dbPath);
    rawPre.exec(
      'CREATE INDEX IF NOT EXISTS scheduled_task_runs_sched_seq ON scheduled_task_runs(scheduleId, createdAt);',
    );
    rawPre.close();

    store = new Store(dbPath);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);

    // model_feedback rebuilt with nullable verifiedPass & backfilled verificationStatus/failureKind
    const mfCols = getColumnMap(store.db, 'model_feedback');
    assert.equal(mfCols.get('verifiedPass').notnull, 0);
    const okFb = store.db.prepare("SELECT * FROM model_feedback WHERE model='v6-ok-model'").get();
    const failFb = store.db.prepare("SELECT * FROM model_feedback WHERE model='v6-fail-model'").get();
    assert.equal(okFb.verifiedPass, 1);
    assert.equal(okFb.verificationStatus, 'passed');
    assert.equal(okFb.trafficSource, 'production');
    assert.equal(okFb.isSynthetic, 0);
    assert.equal(failFb.verifiedPass, 0);
    assert.equal(failFb.verificationStatus, 'failed');
    assert.equal(failFb.failureKind, 'timeout');

    // scheduled_tasks stale lastStatus='completed' synchronized to latest run ('running', seq=2),
    // so subsequent failure of run2 updates lastStatus monotonically instead of staying frozen!
    const taskBefore = store.db
      .prepare("SELECT lastStatus, lastStatusRunSeq, lastStatusRunId FROM scheduled_tasks WHERE id='sched-v6-stale'")
      .get();
    assert.equal(taskBefore.lastStatus, 'running');
    assert.equal(taskBefore.lastStatusRunSeq, 2);
    assert.equal(taskBefore.lastStatusRunId, 'run-v6-2');

    store.tx(() => {
      updateTaskStatusMonotonicTx(store.db, 'sched-v6-stale', {
        runId: 'run-v6-2',
        runSeq: 2,
        status: 'failed',
        now: 9999,
      });
    });
    const taskAfter = store.db
      .prepare("SELECT lastStatus, lastStatusRunSeq FROM scheduled_tasks WHERE id='sched-v6-stale'")
      .get();
    assert.equal(taskAfter.lastStatus, 'failed');
    assert.equal(taskAfter.lastStatusRunSeq, 2);

    // Duplicate swarm_replans(runId, version) deduplicated deterministically and UNIQUE index enforced
    const replans = store.db
      .prepare("SELECT id, version FROM swarm_replans WHERE runId='run-v5' ORDER BY version ASC")
      .all();
    assert.deepEqual(
      replans.map((r) => [r.id, r.version]),
      [
        ['rep-v6-a', 1],
        ['rep-v6-b', 2],
        ['rep-v6-c', 3],
      ],
    );
    assert.throws(
      () =>
        store.db
          .prepare(
            "INSERT INTO swarm_replans(id, runId, version, strategy, diffJson, createdAt) VALUES('rep-dup','run-v5',1,'x','{}',3000)",
          )
          .run(),
      /UNIQUE/i,
    );

    // scheduled_task_runs_sched_seq upgraded to UNIQUE
    const indexes = getIndexMap(store.db);
    assert.match(indexes.get('scheduled_task_runs_sched_seq'), /\bUNIQUE\b/i);

    // worktree_leases & child_notifications preserved with additive v7 columns
    const wt = store.db.prepare("SELECT * FROM worktree_leases WHERE id='wt-v6'").get();
    assert.equal(wt.ownerId, 'sess-v5');
    assert.equal(wt.attempt, 1);
    assert.equal(wt.cleanupState, 'active');
    const notif = store.db.prepare("SELECT * FROM child_notifications WHERE id='notif-v6'").get();
    assert.equal(notif.childSessionId, 'child-v6');
    assert.equal(notif.attempt, 0);
  } finally {
    store?.close?.();
    cleanupDir(dir);
  }
});

test('4. Interrupted migration rolls back atomically, closes DB handle cleanly, and recovers from leftover model_feedback_v7', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-mig-interrupt-'));
  const dbPath = join(dir, 'interrupted.sqlite');
  let store;
  try {
    createRealV5Database(dbPath, { includeFts: true });
    upgradeV5ToRealV6(dbPath);

    // Inject a deterministic failure mid-migration (during scheduled_task_runs backfill) AND a leftover model_feedback_v7 table
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE model_feedback_v7(id INTEGER);
      CREATE TRIGGER fail_mid_migration BEFORE UPDATE ON scheduled_task_runs
      BEGIN
        SELECT RAISE(ABORT, 'INJECTED_MID_MIGRATION_CRASH');
      END;
    `);
    raw.close();

    assert.throws(() => new Store(dbPath), /INJECTED_MID_MIGRATION_CRASH/);

    // Verify atomic rollback: user_version is still 6, model_feedback still untouched (NOT NULL verifiedPass),
    // and Store closed its handle cleanly so we can reopen & inspect immediately!
    const inspect = new DatabaseSync(dbPath);
    assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 6);
    assert.equal(getColumnMap(inspect, 'model_feedback').get('verifiedPass').notnull, 1);
    assert.equal(
      inspect.prepare("SELECT COUNT(*) AS n FROM model_feedback").get().n,
      2,
    );
    // Remove fault trigger while KEEPING leftover model_feedback_v7 to test cleanup on retry
    inspect.exec('DROP TRIGGER fail_mid_migration;');
    inspect.close();

    store = new Store(dbPath);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(getColumnMap(store.db, 'model_feedback').get('verifiedPass').notnull, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM model_feedback').get().n, 2);
  } finally {
    store?.close?.();
    cleanupDir(dir);
  }
});

test('5. Repeated migration idempotency preserves rows/sequences and skips write tx on already-v7 opens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-mig-repeat-'));
  const dbPath = join(dir, 'idempotent.sqlite');
  let s1;
  let s2;
  let s3;
  try {
    createRealV5Database(dbPath, { includeFts: false });
    upgradeV5ToRealV6(dbPath);

    s1 = new Store(dbPath);
    const snap1 = {
      userVersion: s1.db.prepare('PRAGMA user_version').get().user_version,
      runs: s1.db.prepare('SELECT id, runSeq, status FROM scheduled_task_runs ORDER BY id').all(),
      replans: s1.db.prepare('SELECT id, version FROM swarm_replans ORDER BY id').all(),
      feedbackCount: s1.db.prepare('SELECT COUNT(*) AS n FROM model_feedback').get().n,
      dataVersion: s1.db.prepare('PRAGMA data_version').get().data_version,
    };
    s1.close();
    s1 = null;

    // Reopen #2 and #3 while holding a read-only watcher to prove zero unnecessary write tx on v7 open
    const watcher = new DatabaseSync(dbPath);
    const dvBefore = watcher.prepare('PRAGMA data_version').get().data_version;

    s2 = new Store(dbPath);
    assert.equal(s2.ftsEnabled, true);
    s2.close();
    s2 = null;

    s3 = new Store(dbPath);
    assert.equal(s3.ftsEnabled, true);
    const dvAfter = watcher.prepare('PRAGMA data_version').get().data_version;
    watcher.close();

    assert.equal(dvAfter, dvBefore, 'Already-v7 open must skip unnecessary write transactions');

    const snap3 = {
      userVersion: s3.db.prepare('PRAGMA user_version').get().user_version,
      runs: s3.db.prepare('SELECT id, runSeq, status FROM scheduled_task_runs ORDER BY id').all(),
      replans: s3.db.prepare('SELECT id, version FROM swarm_replans ORDER BY id').all(),
      feedbackCount: s3.db.prepare('SELECT COUNT(*) AS n FROM model_feedback').get().n,
    };
    assert.equal(snap3.userVersion, 7);
    assert.deepEqual(snap3.runs, snap1.runs);
    assert.deepEqual(snap3.replans, snap1.replans);
    assert.equal(snap3.feedbackCount, snap1.feedbackCount);
  } finally {
    s1?.close?.();
    s2?.close?.();
    s3?.close?.();
    cleanupDir(dir);
  }
});

test('6. Store.tx() supports nested SAVEPOINT rollback and guarded outer ROLLBACK without masking root errors', () => {
  const store = new Store(':memory:');
  try {
    // 6A: Caught inner tx failure rolls back ONLY inner writes while preserving outer writes
    store.tx(() => {
      store.db
        .prepare("INSERT INTO kv_settings(key, value, updatedAt) VALUES('outer_before', '\"ok\"', 1)")
        .run();

      assert.throws(() => {
        store.tx(() => {
          store.db
            .prepare("INSERT INTO kv_settings(key, value, updatedAt) VALUES('inner_aborted', '\"bad\"', 2)")
            .run();
          throw new Error('INNER_BOOM');
        });
      }, /INNER_BOOM/);

      store.db
        .prepare("INSERT INTO kv_settings(key, value, updatedAt) VALUES('outer_after', '\"ok\"', 3)")
        .run();
    });

    assert.equal(store.getSetting('outer_before'), 'ok');
    assert.equal(store.getSetting('outer_after'), 'ok');
    assert.equal(store.getSetting('inner_aborted'), null, 'caught inner throw must roll back via SAVEPOINT');

    // 6B: Uncaught inner failure rolls back both inner and outer writes
    assert.throws(() => {
      store.tx(() => {
        store.db
          .prepare("INSERT INTO kv_settings(key, value, updatedAt) VALUES('outer_rolled', '\"nope\"', 4)")
          .run();
        store.tx(() => {
          store.db
            .prepare("INSERT INTO kv_settings(key, value, updatedAt) VALUES('inner_rolled', '\"nope\"', 5)")
            .run();
          throw new Error('FATAL_INNER');
        });
      });
    }, /FATAL_INNER/);

    assert.equal(store.getSetting('outer_rolled'), null);
    assert.equal(store.getSetting('inner_rolled'), null);

    // 6C: If SQLite already ended the transaction before catch runs, tx() preserves the original error
    assert.throws(() => {
      store.tx(() => {
        store.db.exec('ROLLBACK');
        throw new Error('ROOT_CAUSE_PRESERVED');
      });
    }, /ROOT_CAUSE_PRESERVED/);
  } finally {
    store.close();
  }
});

test('7. Unsupported future schema (user_version=8) throws UNSUPPORTED_DATABASE_SCHEMA and closes DB handle cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-mig-v8-'));
  const dbPath = join(dir, 'future-v8.sqlite');
  try {
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA user_version=8;');
    raw.close();

    assert.throws(
      () => new Store(dbPath),
      (err) => err?.code === 'UNSUPPORTED_DATABASE_SCHEMA',
    );

    // Immediate deletion proves no leaked SQLite handle (critical on Windows!)
    rmSync(dbPath, { force: true });
  } finally {
    cleanupDir(dir);
  }
});

test('8. Concurrent dual-runtime new Store(dbPath) migrates an unmigrated v6 DB simultaneously with zero SQLITE_BUSY', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-mig-dual-'));
  const dbPath = join(dir, 'dual-v6.sqlite');
  const storeUrl = pathToFileURL(join(SRC_ROOT, 'store.js')).href;

  try {
    createRealV5Database(dbPath, { includeFts: false });
    upgradeV5ToRealV6(dbPath);
    // Force rollback journal mode so both processes also race PRAGMA journal_mode=WAL!
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA journal_mode=DELETE;');
    raw.close();

    const workerCode = `
      import { Store } from ${JSON.stringify(storeUrl)};
      const dbPath = process.argv[1];
      const store = new Store(dbPath);
      const ver = store.db.prepare('PRAGMA user_version').get().user_version;
      store.setSetting('worker_' + process.pid, ver);
      store.close();
      process.stdout.write(JSON.stringify({ ok: true, ver }));
    `;

    const spawnWorker = () =>
      new Promise((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', workerCode, dbPath], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.once('error', rejectRun);
        child.once('exit', (code) => {
          resolveRun({ code, stdout, stderr });
        });
      });

    const results = await Promise.all([spawnWorker(), spawnWorker(), spawnWorker()]);
    for (const res of results) {
      assert.equal(res.code, 0, `Concurrent Store worker failed: stderr=${res.stderr}`);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.ver, 7);
    }

    const verify = new Store(dbPath);
    assert.equal(verify.db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(verify.ftsEnabled, true);
    verify.close();
  } finally {
    cleanupDir(dir);
  }
});

test('9. Observability primitives: trace context, redacted NDJSON logger, 10 production KPIs (strict real vs synthetic), and cross-table queryTraces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-obs-'));
  const store = new Store(join(dir, 'obs.sqlite'));
  const metrics = new MetricsCollector({ store });
  try {
    // 9A: Trace context propagation & traffic classification
    assert.equal(getLogLevel(), 'silent', 'Default log level under node --test must be silent');
    assert.deepEqual(classifyTrafficSource({ 'x-agent-traffic-source': 'eval' }), {
      trafficSource: 'eval',
      isSynthetic: true,
    });
    assert.deepEqual(classifyTrafficSource({ 'x-agent-synthetic': 'true' }), {
      trafficSource: 'synthetic',
      isSynthetic: true,
    });
    assert.deepEqual(classifyTrafficSource({ trafficSource: 'probe', isSynthetic: false }), {
      trafficSource: 'probe',
      isSynthetic: true,
    });
    assert.deepEqual(classifyTrafficSource({}), {
      trafficSource: 'production',
      isSynthetic: false,
    });

    const lines = [];
    const memStream = { write: (line) => lines.push(line) };

    const traceIds = await withTraceContext(
      {
        traceId: 'tr-1',
        runId: 'run-obs-1',
        nodeId: 'node-obs-1',
        sessionId: 'sess-obs-1',
        turnId: 'turn-obs-1',
        jobId: 'job-obs-1',
        workerId: 'worker-obs-1',
        attempt: 2,
        fence: 'fence-obs-1',
        model: 'gpt-5',
        provider: 'openai',
        accountId: 'acc-1',
        toolCallId: 'tc-obs-1',
        artifactId: 'art-obs-1',
        trafficSource: 'production',
      },
      async () => {
        await Promise.resolve();
        const rec = logEvent(
          'info',
          'tool.executed',
          {
            apiKey: 'sk-proj-secret1234567890abcdef',
            note: 'Authorization Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9_secret',
          },
          { level: 'info', stream: memStream },
        );
        assert.ok(rec);
        metrics.record('model_route', { ok: true, durationMs: 120, detail: { failovers: 0 } });
        return compactTrace();
      },
    );

    assert.equal(traceIds.runId, 'run-obs-1');
    assert.equal(traceIds.artifactId, 'art-obs-1');
    assert.equal(traceIds.attempt, 2);
    assert.equal(lines.length, 1);
    const parsedLog = JSON.parse(lines[0]);
    assert.equal(parsedLog.runId, 'run-obs-1');
    assert.equal(parsedLog.toolCallId, 'tc-obs-1');
    assert.equal(parsedLog.apiKey, '[REDACTED]');
    assert.doesNotMatch(lines[0], /sk-proj-secret|eyJhbGciOi/);

    // 9B: Populate production AND synthetic records across all tables to verify all 10 KPIs & strict separation
    const now = Date.now();
    store.tx(() => {
      // Production session + turns (1 evidence pass, 1 plain-text pass, 1 failed even though state='completed' has accepted:false verdict check, 1 cancelled)
      store.db
        .prepare(
          "INSERT INTO direct_sessions(id, title, state, trafficSource, isSynthetic, createdAt, updatedAt) VALUES('sess-obs-1','Prod','completed','production',0,?,?)",
        )
        .run(now - 5000, now);
      store.db
        .prepare(
          "INSERT INTO direct_sessions(id, title, state, trafficSource, isSynthetic, createdAt, updatedAt) VALUES('sess-synth-1','Eval','completed','eval',1,?,?)",
        )
        .run(now - 5000, now);

      store.db
        .prepare(
          `INSERT INTO direct_turns(id, sessionId, clientTurnId, input, model, state, verdictJson, evidenceCount, trafficSource, isSynthetic, createdAt, finishedAt)
           VALUES('turn-obs-1','sess-obs-1','ct-1','fix bug','gpt-5','completed','{"verdict":"pass","accepted":true,"evidenceRequired":true}',2,'production',0,?,?)`,
        )
        .run(now - 4000, now - 3000);
      store.db
        .prepare(
          `INSERT INTO direct_turns(id, sessionId, clientTurnId, input, model, state, verdictJson, evidenceCount, trafficSource, isSynthetic, createdAt, finishedAt)
           VALUES('turn-obs-2','sess-obs-1','ct-2','explain','gpt-5','completed','{"verdict":"pass","accepted":true,"evidenceRequired":false,"verificationMode":"plain_text_no_tools"}',0,'production',0,?,?)`,
        )
        .run(now - 3500, now - 3200);
      store.db
        .prepare(
          `INSERT INTO direct_turns(id, sessionId, clientTurnId, input, model, state, error, verdictJson, evidenceCount, trafficSource, isSynthetic, createdAt, finishedAt)
           VALUES('turn-obs-3','sess-obs-1','ct-3','build','gpt-5','failed','STEP_BUDGET_EXHAUSTED','{"verdict":"fail","accepted":false,"evidenceRequired":true}',1,'production',0,?,?)`,
        )
        .run(now - 3000, now - 2500);
      store.db
        .prepare(
          `INSERT INTO direct_turns(id, sessionId, input, model, state, trafficSource, isSynthetic, createdAt, finishedAt)
           VALUES('turn-obs-cancel','sess-obs-1','cancel','gpt-5','cancelled','production',0,?,?)`,
        )
        .run(now - 2400, now - 2300);
      // Synthetic failing turns that MUST NOT pollute production metrics
      for (let i = 0; i < 5; i++) {
        store.db
          .prepare(
            `INSERT INTO direct_turns(id, sessionId, input, model, state, verdictJson, evidenceCount, trafficSource, isSynthetic, createdAt, finishedAt)
             VALUES(?,'sess-synth-1','eval','gpt-5','failed','{"verdict":"fail","accepted":false,"evidenceRequired":true}',1,'eval',1,?,?)`,
          )
          .run(`turn-synth-${i}`, now - 2000, now - 1900);
      }

      // Swarm runs (2 prod: 1 completed 1000ms, 1 failed 3000ms; 1 synth)
      store.db
        .prepare(
          `INSERT INTO swarm_runs(id, sessionId, rootTurnId, goal, status, strategyJson, budgetJson, verdictJson, trafficSource, isSynthetic, createdAt, updatedAt, finishedAt)
           VALUES('run-obs-1','sess-obs-1','turn-obs-1','prod swarm','completed','{}','{}','{"verdict":"pass","accepted":true}','production',0,?,?,?)`,
        )
        .run(now - 5000, now - 3000, now - 4000);
      store.db
        .prepare(
          `INSERT INTO swarm_runs(id, sessionId, rootTurnId, goal, status, strategyJson, budgetJson, verdictJson, trafficSource, isSynthetic, createdAt, updatedAt, finishedAt)
           VALUES('run-obs-2','sess-obs-1','turn-obs-3','prod swarm 2','failed','{}','{}','{"verdict":"fail","accepted":false}','production',0,?,?,?)`,
        )
        .run(now - 5000, now - 2000, now - 2000);
      store.db
        .prepare(
          `INSERT INTO swarm_runs(id, sessionId, goal, status, strategyJson, budgetJson, trafficSource, isSynthetic, createdAt, updatedAt, finishedAt)
           VALUES('run-synth-1','sess-synth-1','eval swarm','failed','{}','{}','eval',1,?,?,?)`,
        )
        .run(now - 10000, now - 1000, now - 1000);

      // model_feedback (prod + synth)
      store.db
        .prepare(
          `INSERT INTO model_feedback(model, provider, taskType, success, verifiedPass, recovered, cancelled, trafficSource, isSynthetic, createdAt)
           VALUES('gpt-5','openai','direct',1,1,1,0,'production',0,?)`,
        )
        .run(now - 1000);
      store.db
        .prepare(
          `INSERT INTO model_feedback(model, provider, taskType, success, verifiedPass, recovered, cancelled, trafficSource, isSynthetic, createdAt)
           VALUES('gpt-5','openai','direct',0,0,1,0,'production',0,?)`,
        )
        .run(now - 900);
      store.db
        .prepare(
          `INSERT INTO model_feedback(model, provider, taskType, success, verifiedPass, recovered, cancelled, trafficSource, isSynthetic, createdAt)
           VALUES('gpt-5','openai','direct',0,0,0,0,'eval',1,?)`,
        )
        .run(now - 800);

      // tool_receipts (2 finished, 1 failed, 1 rejected_before_effect on prod; 2 failed on synth)
      for (const [id, sid, tid, cid, st, err] of [
        ['tr-1', 'sess-obs-1', 'turn-obs-1', 'tc-obs-1', 'finished', null],
        ['tr-2', 'sess-obs-1', 'turn-obs-1', 'tc-obs-2', 'finished', null],
        ['tr-3', 'sess-obs-1', 'turn-obs-3', 'tc-obs-3', 'failed', 'NON_ZERO_EXIT'],
        ['tr-4', 'sess-obs-1', 'turn-obs-3', 'tc-obs-4', 'rejected_before_effect', 'POLICY_DENIED'],
        ['tr-s1', 'sess-synth-1', 'turn-synth-0', 'tc-s1', 'failed', 'TOOL_EXECUTION_ERROR'],
      ]) {
        store.db
          .prepare(
            `INSERT INTO tool_receipts(id, sessionId, turnId, taskId, callId, toolName, riskLevel, effectClass, replayable, outward, argsDigest, status, errorCode, durationMs, createdAt, updatedAt)
             VALUES(?,?,?,'run-obs-1',?,'bash','high','workspace_write',0,0,'d',?,?,10,?,?)`,
          )
          .run(id, sid, tid, cid, st, err, now - 1000, now - 990);
      }

      // Reconciliation approval
      store.db
        .prepare(
          `INSERT INTO direct_approvals(id, sessionId, turnId, callId, tool, arguments, status, kind, outcome, expiresAt, createdAt, resolvedAt)
           VALUES('rec-appr-1','sess-obs-1','turn-obs-1','tc-obs-1','mcp__deploy','{}','allowed','reconciliation','happened',?,?,?)`,
        )
        .run(now + 60_000, now - 1500, now - 1200);

      // Budget ledger + reservation
      store.db
        .prepare(
          `INSERT INTO budget_ledgers(treeId, rootSessionId, maxTotalSteps, maxTotalTokens, usedSteps, usedInputTokens, usedOutputTokens, estimationErrorTokens, overageSteps, overageTokens, exhausted, exhaustedReason, trafficSource, isSynthetic, createdAt, updatedAt)
           VALUES('run-obs-1','sess-obs-1',5,1000,6,800,350,50,1,150,1,'TOKEN_BUDGET','production',0,?,?)`,
        )
        .run(now - 4500, now - 1000);
      store.db
        .prepare(
          `INSERT INTO budget_reservations(id, treeId, scope, nodeId, sessionId, turnId, jobId, fence, status, reservedTotalTokens, actualInputTokens, actualOutputTokens, overageTokens, createdAt, updatedAt)
           VALUES('bres-1','run-obs-1','node_execution','node-obs-1','sess-obs-1','turn-obs-1','job-obs-1','fence-obs-1','reconciled',500,400,100,0,?,?)`,
        )
        .run(now - 4200, now - 1000);

      // Usage + turn/completed cache event
      store.db
        .prepare(
          `INSERT INTO nexus_usage(sessionId, provider, model, day, inputTokens, outputTokens, tokens, costUsd, durationMs, trafficSource, isSynthetic, createdAt)
           VALUES('sess-obs-1','openai','gpt-5','2026-11-21',1000,200,1200,0,500,'production',0,?)`,
        )
        .run(now - 1000);
      store.db
        .prepare(
          `INSERT INTO direct_events(sessionId, turnId, type, data, at)
           VALUES('sess-obs-1','turn-obs-1','turn/completed','{"inputTokens":1000,"cacheReadTokens":400,"_trace":{"runId":"run-obs-1","nodeId":"node-obs-1","jobId":"job-obs-1"}}',?)`,
        )
        .run(now - 3000);

      // Checkpoint + job + artifact for trace correlation
      store.db
        .prepare(
          `INSERT INTO runtime_checkpoints(id, sessionId, turnId, step, phase, stateJson, createdAt)
           VALUES('cp-1','sess-obs-1','turn-obs-1',1,'inference','{"runId":"run-obs-1","nodeId":"node-obs-1","jobId":"job-obs-1"}',?)`,
        )
        .run(now - 3800);
      store.db
        .prepare(
          `INSERT INTO runtime_jobs(id, kind, sessionId, turnId, taskId, payload, status, fence, workerId, attempts, createdAt, updatedAt)
           VALUES('job-obs-1','swarm_node_execute','sess-obs-1','turn-obs-1','run-obs-1','{"runId":"run-obs-1","nodeId":"node-obs-1"}','done','fence-obs-1','worker-obs-1',2,?,?)`,
        )
        .run(now - 4900, now - 3000);
      store.db
        .prepare(
          `INSERT INTO swarm_artifacts(id, uri, runId, nodeId, nodeKey, childSessionId, childTurnId, jobId, attempt, ownerId, fence, workspaceRoot, storagePath, bundleSha256, manifestJson, status, createdAt, updatedAt)
           VALUES('art-obs-1','swarm-artifact://run-obs-1/n1/1','run-obs-1','node-obs-1','n1','sess-obs-1','turn-obs-1','job-obs-1',2,'sess-obs-1','fence-obs-1','/tmp','/tmp/a','sha','{}','archived',?,?)`,
        )
        .run(now - 3100, now - 3100);
    });

    // Additional telemetry events (failover route + prevented duplicate + scheduler reconcile + synthetic route)
    metrics.record('model_route', {
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      ok: true,
      attempt: 2,
      detail: { failovers: 1, cooldownSkipped: 1 },
    });
    metrics.record('model_route', {
      provider: 'openai',
      model: 'gpt-5',
      ok: false,
      code: 'PROVIDER_UNAVAILABLE',
      detail: { exhausted: true },
    });
    metrics.record('model_route', {
      provider: 'openai',
      model: 'gpt-5',
      ok: false,
      isSynthetic: true,
      trafficSource: 'probe',
      code: 'PROVIDER_UNAVAILABLE',
    });
    metrics.record('lease_lost_fenced', { runId: 'run-obs-1', jobId: 'job-obs-1', ok: false });
    metrics.record('scheduler_reconcile', { detail: { converged: 2, repaired: 1, attached: 1 } });

    // Regression #25-1: Recording synthetic trafficSource inside an active production context MUST NOT leak into production KPIs
    withTraceContext({ trafficSource: 'production', isSynthetic: false, sessionId: 'sess-obs-1' }, () => {
      const probeId = metrics.record('model_route', {
        provider: 'openai',
        model: 'gpt-5',
        trafficSource: 'probe',
        ok: false,
        code: 'PROVIDER_UNAVAILABLE',
      });
      const probeRow = store.db
        .prepare('SELECT isSynthetic, trafficSource FROM runtime_metrics_events WHERE id=?')
        .get(probeId);
      assert.equal(probeRow.isSynthetic, 1, 'probe trafficSource must fail closed to isSynthetic=1');
      assert.equal(probeRow.trafficSource, 'probe');
    });

    const prod = metrics.getProductionMetrics({ windowHours: 24, includeSynthetic: false });
    assert.equal(prod.agentTaskSuccessRate.total, 5); // 3 prod turns + 2 prod swarms (cancelled excluded)
    assert.equal(prod.agentTaskSuccessRate.succeeded, 3); // 2 prod turns + 1 prod swarm
    assert.equal(prod.agentTaskSuccessRate.rate, 0.6);
    assert.equal(prod.agentTaskSuccessRate.evidenceBackedTotal, 4);
    assert.equal(prod.agentTaskSuccessRate.evidenceBackedSuccessRate, 0.5);
    assert.equal(prod.agentTaskSuccessRate.plainTextTotal, 1);
    assert.equal(prod.agentTaskSuccessRate.plainTextCompletionRate, 1);

    assert.equal(prod.verificationPassRate.total, 2);
    assert.equal(prod.verificationPassRate.rate, 0.5);

    assert.equal(prod.toolFailureRate.executedTotal, 3);
    assert.equal(prod.toolFailureRate.failed, 1);
    assert.equal(prod.toolFailureRate.preEffectRejected, 1);

    assert.equal(prod.recoverySuccessRate.total, 2);
    assert.equal(prod.recoverySuccessRate.rate, 0.5);

    assert.equal(prod.duplicateExecutionCount.actualDuplicateExecutions, 0);
    assert.equal(prod.duplicateExecutionCount.preventedDuplicates, 1);
    assert.equal(prod.duplicateExecutionCount.preventedByKind.lease_lost_fenced, 1);

    assert.equal(prod.reconciliationCount.approvals.happened, 1);
    assert.equal(prod.reconciliationCount.budgetReconciled, 1);
    assert.equal(prod.reconciliationCount.schedulerReconcile.converged, 2);

    assert.equal(prod.swarmCompletionTime.count, 2);
    assert.equal(prod.swarmCompletionTime.completed.avgMs, 1000);
    assert.equal(prod.swarmCompletionTime.failed.avgMs, 3000);

    assert.equal(prod.averageTokenUsage.avgTotalTokens, 1200);
    assert.equal(prod.averageTokenUsage.cacheReadRatio, 0.4);

    assert.equal(prod.budgetOverrun.overrunTreeCount, 1);
    assert.equal(prod.budgetOverrun.totalOverageTokens, 150);
    assert.equal(prod.budgetOverrun.exhaustedByReason.TOKEN_BUDGET, 1);
    assert.equal(prod.budgetOverrun.stepBudgetExhaustedTurns, 1);

    assert.equal(prod.modelRoutingSuccessRate.totalRequests, 3);
    assert.equal(prod.modelRoutingSuccessRate.primarySuccessRate, 0.3333);
    assert.equal(prod.modelRoutingSuccessRate.overallSuccessRate, 0.6667);
    assert.equal(prod.modelRoutingSuccessRate.failoverRate, 0.3333);
    assert.equal(prod.modelRoutingSuccessRate.cooldownRejections, 1);
    assert.equal(prod.modelRoutingSuccessRate.exhaustedCount, 1);

    assert.ok(prod.trafficBreakdown.syntheticCount >= 8);
    assert.equal(prod.trafficBreakdown.includeSynthetic, false);

    // With includeSynthetic=true, synthetic failures appear
    const withSynth = metrics.getProductionMetrics({ windowHours: 24, includeSynthetic: true });
    assert.equal(withSynth.agentTaskSuccessRate.total, 11); // +5 synth turns +1 synth swarm
    assert.equal(withSynth.modelRoutingSuccessRate.totalRequests, 5); // 3 prod + 2 synthetic probes

    // Regression #25-2: Populate >120 older noise rows across direct_events, runtime_checkpoints, runtime_jobs
    // and assert queryTraces(runId / nodeId, { limit: 20 }) does NOT silently truncate recent runs!
    store.tx(() => {
      const evIns = store.db.prepare(
        "INSERT INTO direct_events(sessionId, turnId, type, data, at) VALUES('sess-old','turn-old','assistant/message','{\"runId\":\"run-old\"}',?)",
      );
      const cpIns = store.db.prepare(
        "INSERT INTO runtime_checkpoints(id, sessionId, turnId, step, phase, stateJson, createdAt) VALUES(?,'sess-old','turn-old',1,'inference','{\"runId\":\"run-old\"}',?)",
      );
      const jobIns = store.db.prepare(
        "INSERT INTO runtime_jobs(id, kind, sessionId, turnId, taskId, payload, status, createdAt, updatedAt) VALUES(?,'swarm_node_execute','sess-old','turn-old','run-old','{\"runId\":\"run-old\",\"nodeId\":\"node-old\"}','done',?,?)",
      );
      for (let i = 0; i < 120; i++) {
        const oldAt = now - 200_000 + i;
        evIns.run(oldAt);
        cpIns.run(`cp-old-${i}`, oldAt);
        jobIns.run(`job-old-${i}`, oldAt, oldAt);
      }
    });

    // 9C: Cross-table chronological queryTraces with small limit on populated DB
    const runTrace = metrics.queryTraces({ runId: 'run-obs-1', limit: 20 });
    const sources = new Set(runTrace.map((e) => e.source));
    for (const expectedSource of [
      'runtime_metrics_events',
      'direct_events',
      'tool_receipts',
      'runtime_checkpoints',
      'runtime_jobs',
      'swarm_artifacts',
      'budget_reservations',
    ]) {
      assert.ok(sources.has(expectedSource), `queryTraces(runId) must correlate ${expectedSource}`);
    }
    for (let i = 1; i < runTrace.length; i++) {
      assert.ok(runTrace[i].at >= runTrace[i - 1].at, 'Trace entries must be sorted chronologically');
    }
    const nodeTrace = metrics.queryTraces({ nodeId: 'node-obs-1', limit: 20 });
    const nodeSources = new Set(nodeTrace.map((e) => e.source));
    assert.ok(nodeSources.has('direct_events'), 'queryTraces(nodeId) must not truncate direct_events');
    assert.ok(nodeSources.has('runtime_checkpoints'), 'queryTraces(nodeId) must not truncate runtime_checkpoints');
    assert.ok(nodeSources.has('runtime_jobs'), 'queryTraces(nodeId) must not truncate runtime_jobs');
    const artTrace = metrics.queryTraces({ artifactId: 'art-obs-1' });
    assert.ok(artTrace.some((e) => e.source === 'swarm_artifacts' && e.artifactId === 'art-obs-1'));
  } finally {
    store.close();
    cleanupDir(dir);
  }
});
