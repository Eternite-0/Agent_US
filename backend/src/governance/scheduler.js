import { Fault, id as uuid } from '../store.js';
import { classifyJobOwnership } from '../durable/lease-guard.js';
import { advanceIntervalPast, computeNextRunAt, validateScheduleConfig } from './cron.js';

export { computeNextRunAt };

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function mapTurnStateToRunStatus(turnState) {
  if (turnState === 'completed') return 'completed';
  if (turnState === 'cancelled') return 'cancelled';
  if (turnState === 'failed') return 'failed';
  return null;
}

function nextRunSeqTx(db, scheduleId) {
  return (
    Number(
      db
        .prepare('SELECT COALESCE(MAX(runSeq), 0) AS m FROM scheduled_task_runs WHERE scheduleId=?')
        .get(scheduleId)?.m ?? 0,
    ) + 1
  );
}

function ensureRunSeqTx(db, runRow) {
  const existing = Number(runRow?.runSeq ?? 0);
  if (existing > 0) return existing;
  const seq = nextRunSeqTx(db, runRow.scheduleId);
  db.prepare('UPDATE scheduled_task_runs SET runSeq=? WHERE id=?').run(seq, runRow.id);
  runRow.runSeq = seq;
  return seq;
}

function mergeRunHistory(existingJson, entry) {
  const prev = parseJsonSafe(existingJson, []);
  if (!entry) return JSON.stringify(prev);
  const filtered = prev.filter((item) => {
    if (entry.runId && item.runId === entry.runId) return false;
    if (!entry.runId && entry.turnId && item.turnId === entry.turnId) return false;
    return true;
  });
  return JSON.stringify([entry, ...filtered].slice(0, 20));
}

/**
 * Monotonically updates scheduled_tasks.lastStatus (and recency metadata) by runSeq
 * so a late event from an older run can never overwrite a newer run's status.
 * Must be called inside a synchronous store.tx().
 */
export function updateTaskStatusMonotonicTx(
  db,
  scheduleId,
  {
    runId,
    runSeq,
    status,
    lastRunAt = undefined,
    lastSessionId = undefined,
    nextRunAt = undefined,
    historyEntry = null,
    now = Date.now(),
  },
) {
  const task = db
    .prepare(
      `SELECT id, lastStatus, lastStatusRunSeq, lastStatusRunId,
              lastRunAt, lastSessionId, nextRunAt, runHistoryJson
       FROM scheduled_tasks WHERE id=?`,
    )
    .get(scheduleId);
  if (!task) return false;

  const curSeq = Number(task.lastStatusRunSeq ?? 0);
  const seq = Number(runSeq ?? 0);
  const curIsTerminal = TERMINAL_RUN_STATUSES.has(task.lastStatus);

  let nextStatus = task.lastStatus;
  let nextStatusRunSeq = curSeq;
  let nextStatusRunId = task.lastStatusRunId ?? null;

  if (status && (seq > curSeq || (seq === curSeq && !curIsTerminal))) {
    nextStatus = status;
    nextStatusRunSeq = seq;
    nextStatusRunId = runId ?? task.lastStatusRunId ?? null;
  }

  const resolvedLastRunAt =
    lastRunAt !== undefined && seq >= curSeq ? lastRunAt : task.lastRunAt;
  const resolvedLastSessionId =
    lastSessionId !== undefined && seq >= curSeq ? lastSessionId : task.lastSessionId;
  const resolvedNextRunAt = nextRunAt !== undefined ? nextRunAt : task.nextRunAt;
  const resolvedHistory = historyEntry
    ? mergeRunHistory(task.runHistoryJson, historyEntry)
    : task.runHistoryJson;

  db.prepare(
    `UPDATE scheduled_tasks
     SET lastRunAt=?, nextRunAt=?, lastSessionId=?, lastStatus=?,
         lastStatusRunSeq=?, lastStatusRunId=?, runHistoryJson=?, updatedAt=?
     WHERE id=?`,
  ).run(
    resolvedLastRunAt,
    resolvedNextRunAt,
    resolvedLastSessionId,
    nextStatus,
    nextStatusRunSeq,
    nextStatusRunId,
    resolvedHistory,
    now,
    scheduleId,
  );
  return true;
}

function findCorrelatedTurnTx(db, runRow) {
  if (runRow.turnId) {
    const byId = db.prepare('SELECT * FROM direct_turns WHERE id=?').get(runRow.turnId);
    if (byId) return byId;
  }
  if (runRow.idempotencyKey) {
    const byClientKey = db
      .prepare('SELECT * FROM direct_turns WHERE clientTurnId=? ORDER BY createdAt ASC LIMIT 1')
      .get(runRow.idempotencyKey);
    if (byClientKey) return byClientKey;
  }
  return null;
}

function ensureScheduledJobTx(store, runRow, { desiredStatus = 'pending', now = Date.now() } = {}) {
  const db = store.db;
  let job = runRow.jobId
    ? db.prepare('SELECT * FROM runtime_jobs WHERE id=?').get(runRow.jobId)
    : null;
  if (!job && runRow.idempotencyKey) {
    job = db
      .prepare('SELECT * FROM runtime_jobs WHERE idempotencyKey=?')
      .get(runRow.idempotencyKey);
  }

  if (job) {
    if (runRow.jobId !== job.id) {
      db.prepare('UPDATE scheduled_task_runs SET jobId=?, updatedAt=? WHERE id=?').run(
        job.id,
        now,
        runRow.id,
      );
      runRow.jobId = job.id;
    }
    if (job.status === 'pending') {
      if (desiredStatus === 'pending') store.notifyJobWake();
      return job;
    }
    if (job.status === 'active') {
      const ownership = classifyJobOwnership(store, job, { now, markDeadInDb: true });
      if (ownership.reclaimable) store.notifyJobWake();
      return job;
    }
    if (job.status === 'parked') {
      if (desiredStatus === 'pending') {
        db.prepare(
          "UPDATE runtime_jobs SET status='pending', fence=NULL, leaseExpiresAt=NULL, errorMessage=NULL, updatedAt=? WHERE id=?",
        ).run(now, job.id);
        store.notifyJobWake();
        return db.prepare('SELECT * FROM runtime_jobs WHERE id=?').get(job.id);
      }
      return job;
    }
    if (job.status === 'cancelled' || job.status === 'failed') {
      return job;
    }
    // Job is 'done' even though run is still 'queued' with no turn -> mint repair job
  }

  const jobId = uuid();
  const idemKey =
    job && job.idempotencyKey === runRow.idempotencyKey
      ? `sched-repair:${runRow.id}:${uuid().slice(0, 8)}`
      : runRow.idempotencyKey;
  const payload = JSON.stringify({
    scheduleId: runRow.scheduleId,
    scheduleRunId: runRow.id,
    scheduledFor: runRow.scheduledFor,
    trigger: runRow.trigger || 'schedule',
  });
  const errorMessage =
    desiredStatus === 'parked' ? 'waiting_for_concurrency_slot' : null;

  db.prepare(
    `INSERT INTO runtime_jobs(
      id, kind, sessionId, turnId, taskId, parentJobId, payload,
      status, fence, workerId, leaseExpiresAt, attempts, maxAttempts,
      idempotencyKey, errorMessage, createdAt, updatedAt
    ) VALUES(?,'scheduled_task',NULL,NULL,?,NULL,?,?,NULL,NULL,NULL,0,3,?,?,?,?)`,
  ).run(jobId, runRow.scheduleId, payload, desiredStatus, idemKey, errorMessage, now, now);

  db.prepare('UPDATE scheduled_task_runs SET jobId=?, updatedAt=? WHERE id=?').run(
    jobId,
    now,
    runRow.id,
  );
  runRow.jobId = jobId;
  if (desiredStatus === 'pending') store.notifyJobWake();
  return db.prepare('SELECT * FROM runtime_jobs WHERE id=?').get(jobId);
}

/**
 * Reconciles any running scheduled_task_runs for a schedule whose direct_turns row
 * has already reached a terminal state (or been deleted).
 * Must be called inside store.tx().
 */
function reconcileRunningRunsForScheduleTx(store, scheduleId, now = Date.now()) {
  const db = store.db;
  const runningRows = db
    .prepare(
      "SELECT * FROM scheduled_task_runs WHERE scheduleId=? AND status='running' ORDER BY runSeq ASC, createdAt ASC",
    )
    .all(scheduleId);

  let converged = 0;
  for (const run of runningRows) {
    const seq = ensureRunSeqTx(db, run);
    const turn = findCorrelatedTurnTx(db, run);
    if (turn) {
      const terminal = mapTurnStateToRunStatus(turn.state);
      if (terminal) {
        const finishedAt = turn.finishedAt ?? now;
        db.prepare(
          `UPDATE scheduled_task_runs
           SET sessionId=COALESCE(sessionId, ?), turnId=COALESCE(turnId, ?),
               status=?, error=?, finishedAt=COALESCE(finishedAt, ?), updatedAt=?
           WHERE id=? AND status IN ('queued','running')`,
        ).run(
          turn.sessionId,
          turn.id,
          terminal,
          turn.error ? String(turn.error) : null,
          finishedAt,
          now,
          run.id,
        );
        updateTaskStatusMonotonicTx(db, scheduleId, {
          runId: run.id,
          runSeq: seq,
          status: terminal,
          now: finishedAt,
        });
        converged++;
      }
    } else if (run.turnId) {
      db.prepare(
        `UPDATE scheduled_task_runs
         SET status='cancelled', error='Linked turn no longer exists', finishedAt=COALESCE(finishedAt, ?), updatedAt=?
         WHERE id=? AND status='running'`,
      ).run(now, now, run.id);
      updateTaskStatusMonotonicTx(db, scheduleId, {
        runId: run.id,
        runSeq: seq,
        status: 'cancelled',
        now,
      });
      converged++;
    }
  }
  return converged;
}

/**
 * Promotes oldest queued scheduled_task_runs into pending runtime_jobs whenever
 * concurrency slots are available. Must be called inside store.tx().
 */
export function advanceQueuedRunsForScheduleTx(store, scheduleId, now = Date.now()) {
  const db = store.db;
  const sched = db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(scheduleId);
  if (!sched) return 0;

  reconcileRunningRunsForScheduleTx(store, scheduleId, now);

  const runningCount =
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE scheduleId=? AND status='running'",
      )
      .get(scheduleId)?.n ?? 0;

  const policy = sched.concurrencyPolicy || 'skip';
  const maxConc = Math.max(1, Number(sched.maxConcurrency ?? 1));
  const availableSlots = policy === 'allow' ? 32 : Math.max(0, maxConc - runningCount);
  if (availableSlots <= 0) return 0;

  const queuedRows = db
    .prepare(
      `SELECT * FROM scheduled_task_runs
       WHERE scheduleId=? AND status='queued'
       ORDER BY CASE WHEN runSeq > 0 THEN runSeq ELSE 2147483647 END ASC, createdAt ASC, rowid ASC
       LIMIT ?`,
    )
    .all(scheduleId, availableSlots);

  let promoted = 0;
  for (const run of queuedRows) {
    ensureRunSeqTx(db, run);
    const job = ensureScheduledJobTx(store, run, { desiredStatus: 'pending', now });
    if (job && (job.status === 'pending' || job.status === 'active')) {
      promoted++;
    }
  }
  return promoted;
}

/**
 * Converges durable scheduled_task_runs and scheduled_tasks atomically whenever a
 * direct_turn reaches a terminal state (completed, failed, cancelled) — regardless
 * of whether an in-process event listener is attached.
 */
export function convergeScheduledRunForTurn(
  store,
  turnId,
  { status, error = null, finishedAt = Date.now() } = {},
) {
  if (!store?.db?.isOpen || !turnId || !TERMINAL_RUN_STATUSES.has(status)) return 0;
  return store.tx(() => {
    const db = store.db;
    let runs = db.prepare('SELECT * FROM scheduled_task_runs WHERE turnId=?').all(turnId);
    let turn = null;
    if (!runs.length) {
      turn = db.prepare('SELECT * FROM direct_turns WHERE id=?').get(turnId);
      if (turn?.clientTurnId) {
        const byIdem = db
          .prepare('SELECT * FROM scheduled_task_runs WHERE idempotencyKey=?')
          .get(turn.clientTurnId);
        if (byIdem) runs = [byIdem];
      }
    }
    if (!runs.length) return 0;

    let updated = 0;
    const touchedSchedules = new Set();
    for (const run of runs) {
      const seq = ensureRunSeqTx(db, run);
      if (!TERMINAL_RUN_STATUSES.has(run.status)) {
        const sessionId = run.sessionId || turn?.sessionId || null;
        db.prepare(
          `UPDATE scheduled_task_runs
           SET sessionId=COALESCE(sessionId, ?),
               turnId=COALESCE(turnId, ?),
               status=?,
               error=?,
               finishedAt=COALESCE(finishedAt, ?),
               updatedAt=?
           WHERE id=? AND status IN ('queued','running')`,
        ).run(
          sessionId,
          turnId,
          status,
          error ? String(error).slice(0, 1000) : null,
          finishedAt,
          finishedAt,
          run.id,
        );
        if (run.jobId) {
          db.prepare(
            "UPDATE runtime_jobs SET status='done', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE id=? AND status IN ('pending','parked')",
          ).run(finishedAt, run.jobId);
        }
        updated++;
      }
      updateTaskStatusMonotonicTx(db, run.scheduleId, {
        runId: run.id,
        runSeq: seq,
        status,
        now: finishedAt,
      });
      touchedSchedules.add(run.scheduleId);
    }

    for (const scheduleId of touchedSchedules) {
      advanceQueuedRunsForScheduleTx(store, scheduleId, finishedAt);
    }
    return updated;
  });
}

/**
 * Layer 2/7 Durable ScheduledTaskRunner backed by `scheduled_tasks`,
 * `scheduled_task_runs`, and `DurableJobQueue` (`scheduled_task` jobs).
 * Preserves zero-idle-polling: `timer === null` whenever no enabled tasks exist.
 */
export class ScheduledTaskRunner {
  constructor({ store, directAgent, nowFn = null }) {
    this.store = store;
    this.directAgent = directAgent;
    this.nowFn = typeof nowFn === 'function' ? nowFn : null;
    this.running = false;
    this.timer = null;
    this.unsubs = new Set();
    this.turnWatchers = new Map(); // turnId -> { scheduleId, runId, unsub }

    this.directAgent?.recoveryWorker?.registerHandler('scheduled_task', (job, ctx) =>
      this.#executeScheduledJob(job, ctx),
    );
  }

  #now() {
    return this.nowFn ? Number(this.nowFn()) : Date.now();
  }

  #unwatchTurn(turnId) {
    const entry = this.turnWatchers.get(turnId);
    if (!entry) return;
    this.turnWatchers.delete(turnId);
    this.unsubs.delete(entry.unsub);
    try {
      entry.unsub();
    } catch {
      // ignore listener cleanup
    }
  }

  #unwatchSchedule(scheduleId) {
    for (const [turnId, entry] of [...this.turnWatchers.entries()]) {
      if (entry.scheduleId === scheduleId) {
        this.#unwatchTurn(turnId);
      }
    }
  }

  #unwatchRun(runId) {
    for (const [turnId, entry] of [...this.turnWatchers.entries()]) {
      if (entry.runId === runId) {
        this.#unwatchTurn(turnId);
      }
    }
  }

  #pruneSettledWatchers() {
    if (!this.turnWatchers.size || !this.store?.db?.isOpen) return 0;
    let pruned = 0;
    for (const [turnId] of [...this.turnWatchers.entries()]) {
      const turn = this.store.db
        .prepare('SELECT state, error, finishedAt FROM direct_turns WHERE id=?')
        .get(turnId);
      if (!turn) {
        this.#unwatchTurn(turnId);
        pruned++;
        continue;
      }
      const terminal = mapTurnStateToRunStatus(turn.state);
      if (terminal) {
        this.#unwatchTurn(turnId);
        convergeScheduledRunForTurn(this.store, turnId, {
          status: terminal,
          error: turn.error ?? null,
          finishedAt: turn.finishedAt ?? Date.now(),
        });
        pruned++;
      }
    }
    return pruned;
  }

  #hydrate(row) {
    if (!row) return null;
    return {
      ...row,
      timezone: row.timezone || 'UTC',
      concurrencyPolicy: row.concurrencyPolicy || 'skip',
      misfirePolicy: row.misfirePolicy || 'fire_once',
      maxConcurrency: Number(row.maxConcurrency ?? 1),
      lastStatus: row.lastStatus ?? null,
      lastStatusRunSeq: Number(row.lastStatusRunSeq ?? 0),
      lastStatusRunId: row.lastStatusRunId ?? null,
      enabled: Boolean(row.enabled),
      runHistory: parseJsonSafe(row.runHistoryJson, []),
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    try {
      this.reconcileRuns();
      this.recoverMisfires();
    } finally {
      this.#rearmTimer();
    }
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const turnId of [...this.turnWatchers.keys()]) {
      this.#unwatchTurn(turnId);
    }
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {
        // ignore listener cleanup
      }
    }
    this.unsubs.clear();
  }

  list() {
    return this.store.db
      .prepare('SELECT * FROM scheduled_tasks ORDER BY createdAt DESC')
      .all()
      .map((r) => this.#hydrate(r));
  }

  get(id) {
    const row = this.store.db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(id);
    if (!row) throw new Fault('SCHEDULE_NOT_FOUND', 404);
    return this.#hydrate(row);
  }

  listRuns(scheduleId, { limit = 50 } = {}) {
    this.get(scheduleId);
    const cap = Math.min(200, Math.max(1, Number(limit || 50)));
    return this.store.db
      .prepare(
        'SELECT * FROM scheduled_task_runs WHERE scheduleId=? ORDER BY runSeq DESC, createdAt DESC LIMIT ?',
      )
      .all(scheduleId, cap);
  }

  create({
    id: customId = null,
    name,
    prompt,
    scheduleKind = 'daily',
    scheduleExpr = '09:00',
    timezone = 'UTC',
    concurrencyPolicy = 'skip',
    misfirePolicy = 'fire_once',
    maxConcurrency = 1,
    workspaceRoot = null,
    model = null,
    permissionMode = 'auto-safe',
    enabled = true,
  }) {
    const cleanPrompt = String(prompt ?? '').trim();
    if (!cleanPrompt) {
      throw new Fault('EMPTY_PROMPT', 400, {
        message: 'Schedule prompt cannot be empty',
      });
    }

    const cfg = validateScheduleConfig({
      scheduleKind,
      scheduleExpr,
      timezone,
      concurrencyPolicy,
      misfirePolicy,
      maxConcurrency,
    });

    const id = customId || uuid();
    const now = Date.now();
    const scheduleNow = this.#now();
    const nextRunAt = enabled
      ? computeNextRunAt(cfg.kind, cfg.expr, scheduleNow, { timezone: cfg.tz })
      : null;

    return this.#insertTask({
      id,
      name: String(name || cleanPrompt.slice(0, 60)),
      prompt: cleanPrompt,
      scheduleKind: cfg.kind,
      scheduleExpr: cfg.expr,
      timezone: cfg.tz,
      concurrencyPolicy: String(concurrencyPolicy),
      misfirePolicy: String(misfirePolicy),
      maxConcurrency: cfg.maxConc,
      workspaceRoot: workspaceRoot || null,
      model: model || null,
      permissionMode: permissionMode || 'auto-safe',
      enabled,
      nextRunAt,
      now,
    });
  }

  #insertTask(t) {
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO scheduled_tasks(
            id, name, prompt, scheduleKind, scheduleExpr, timezone, concurrencyPolicy,
            misfirePolicy, maxConcurrency, workspaceRoot, model, permissionMode,
            enabled, nextRunAt, lastStatusRunSeq, lastStatusRunId, runHistoryJson, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,'[]',?,?)`,
        )
        .run(
          t.id,
          t.name,
          t.prompt,
          t.scheduleKind,
          t.scheduleExpr,
          t.timezone,
          t.concurrencyPolicy,
          t.misfirePolicy,
          t.maxConcurrency,
          t.workspaceRoot,
          t.model,
          t.permissionMode,
          t.enabled ? 1 : 0,
          t.nextRunAt,
          t.now,
          t.now,
        );
    });
    this.#rearmTimer();
    return this.get(t.id);
  }

  update(id, patch = {}) {
    const cur = this.get(id);
    const now = Date.now();
    const scheduleNow = this.#now();
    const enabled = patch.enabled !== undefined ? Boolean(patch.enabled) : cur.enabled;
    const scheduleKind = patch.scheduleKind ?? cur.scheduleKind;
    const scheduleExpr = patch.scheduleExpr ?? cur.scheduleExpr;
    const timezone = patch.timezone ?? cur.timezone;
    const concurrencyPolicy = patch.concurrencyPolicy ?? cur.concurrencyPolicy;
    const misfirePolicy = patch.misfirePolicy ?? cur.misfirePolicy;
    const maxConcurrency = patch.maxConcurrency ?? cur.maxConcurrency;

    if (patch.prompt !== undefined && !String(patch.prompt ?? '').trim()) {
      throw new Fault('EMPTY_PROMPT', 400, {
        message: 'Schedule prompt cannot be empty',
      });
    }

    const cfg = validateScheduleConfig({
      scheduleKind,
      scheduleExpr,
      timezone,
      concurrencyPolicy,
      misfirePolicy,
      maxConcurrency,
    });

    const nextRunAt = enabled
      ? patch.nextRunAt ?? computeNextRunAt(cfg.kind, cfg.expr, scheduleNow, { timezone: cfg.tz })
      : null;

    const capacityExpanded =
      enabled &&
      (cfg.maxConc > cur.maxConcurrency ||
        (cur.concurrencyPolicy === 'queue' && String(concurrencyPolicy) === 'allow'));

    this.store.tx(() => {
      this.store.db
        .prepare(
          `UPDATE scheduled_tasks
           SET name=?, prompt=?, scheduleKind=?, scheduleExpr=?, timezone=?,
               concurrencyPolicy=?, misfirePolicy=?, maxConcurrency=?, workspaceRoot=?,
               model=?, permissionMode=?, enabled=?, nextRunAt=?, updatedAt=?
           WHERE id=?`,
        )
        .run(
          patch.name !== undefined ? String(patch.name) : cur.name,
          patch.prompt !== undefined ? String(patch.prompt).trim() : cur.prompt,
          cfg.kind,
          cfg.expr,
          cfg.tz,
          String(concurrencyPolicy),
          String(misfirePolicy),
          cfg.maxConc,
          patch.workspaceRoot !== undefined ? patch.workspaceRoot : cur.workspaceRoot,
          patch.model !== undefined ? patch.model : cur.model,
          patch.permissionMode !== undefined ? patch.permissionMode : cur.permissionMode,
          enabled ? 1 : 0,
          nextRunAt,
          now,
          id,
        );
      if (capacityExpanded) {
        advanceQueuedRunsForScheduleTx(this.store, id, now);
      }
    });
    this.#rearmTimer();
    return this.get(id);
  }

  delete(id) {
    this.get(id);
    const activeTurnIds = this.store.db
      .prepare(
        "SELECT DISTINCT turnId FROM scheduled_task_runs WHERE scheduleId=? AND status IN ('queued','running') AND turnId IS NOT NULL",
      )
      .all(id)
      .map((r) => r.turnId);

    for (const turnId of activeTurnIds) {
      try {
        this.directAgent?.cancelTurn?.(turnId);
      } catch {
        // turn may already be terminal or missing
      }
    }

    this.#unwatchSchedule(id);
    this.store.tx(() => {
      const now = Date.now();
      this.store.db
        .prepare(
          "UPDATE runtime_jobs SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE kind='scheduled_task' AND taskId=? AND status IN ('pending','active','parked','reconciling')",
        )
        .run(now, id);
      for (const turnId of activeTurnIds) {
        this.store.db
          .prepare(
            "UPDATE runtime_jobs SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE turnId=? AND status IN ('pending','active','parked','reconciling')",
          )
          .run(now, turnId);
        this.store.db
          .prepare(
            "UPDATE direct_turns SET state='cancelled', phase='cancelled', finishedAt=COALESCE(finishedAt, ?) WHERE id=? AND state IN ('running','reconciling','parked')",
          )
          .run(now, turnId);
      }
      this.store.db.prepare('DELETE FROM scheduled_tasks WHERE id=?').run(id);
    });
    this.#rearmTimer();
    return { id, deleted: true };
  }

  cancelRun(scheduleId, runId) {
    const row = this.store.db
      .prepare('SELECT * FROM scheduled_task_runs WHERE id=? AND scheduleId=?')
      .get(runId, scheduleId);
    if (!row) throw new Fault('SCHEDULE_RUN_NOT_FOUND', 404);
    this.#unwatchRun(runId);
    if (row.turnId) {
      try {
        this.directAgent?.cancelTurn?.(row.turnId);
      } catch {
        // turn may already be terminal
      }
    }
    const now = Date.now();
    this.store.tx(() => {
      const cur = this.store.db
        .prepare('SELECT * FROM scheduled_task_runs WHERE id=? AND scheduleId=?')
        .get(runId, scheduleId);
      if (!cur) return;
      const seq = ensureRunSeqTx(this.store.db, cur);
      if (cur.jobId) {
        this.store.db
          .prepare(
            "UPDATE runtime_jobs SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE id=? AND status IN ('pending','active','parked','reconciling')",
          )
          .run(now, cur.jobId);
      }
      this.store.db
        .prepare(
          "UPDATE scheduled_task_runs SET status='cancelled', finishedAt=COALESCE(finishedAt, ?), updatedAt=? WHERE id=? AND status IN ('queued','running')",
        )
        .run(now, now, runId);
      const after = this.store.db
        .prepare('SELECT * FROM scheduled_task_runs WHERE id=?')
        .get(runId);
      if (after?.status === 'cancelled') {
        updateTaskStatusMonotonicTx(this.store.db, scheduleId, {
          runId,
          runSeq: seq,
          status: 'cancelled',
          now,
        });
      }
      advanceQueuedRunsForScheduleTx(this.store, scheduleId, now);
    });
    return this.store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(runId);
  }

  /**
   * Reconciles all queued/running scheduled_task_runs against durable direct_turns
   * and runtime_jobs facts on startup (or on demand):
   * - Repairs queued runs missing a jobId (creation-to-linkage crash recovery)
   * - Re-attaches deterministic turns without duplicating execution
   * - Converges completed/failed/cancelled turns & jobs to both scheduled_task_runs and scheduled_tasks
   * - Advances queued waiting runs when concurrency slots are free
   */
  reconcileRuns() {
    if (!this.store?.db?.isOpen) return { converged: 0, repaired: 0, attached: 0, woken: 0 };
    const now = Date.now();
    const runsToWatch = [];
    const stats = { converged: 0, repaired: 0, attached: 0, woken: 0 };

    this.store.tx(() => {
      const db = this.store.db;
      const activeRuns = db
        .prepare(
          `SELECT * FROM scheduled_task_runs
           WHERE status IN ('queued','running')
           ORDER BY CASE WHEN runSeq > 0 THEN runSeq ELSE 2147483647 END ASC, createdAt ASC, rowid ASC`,
        )
        .all();

      const schedulesToAdvance = new Set();

      for (const run of activeRuns) {
        const seq = ensureRunSeqTx(db, run);
        const turn = findCorrelatedTurnTx(db, run);

        if (turn) {
          const wasUnattached = !run.turnId || !run.sessionId;
          const terminal = mapTurnStateToRunStatus(turn.state);
          if (terminal) {
            const finishedAt = turn.finishedAt ?? now;
            db.prepare(
              `UPDATE scheduled_task_runs
               SET sessionId=COALESCE(sessionId, ?), turnId=COALESCE(turnId, ?),
                   status=?, error=?, startedAt=COALESCE(startedAt, ?),
                   finishedAt=COALESCE(finishedAt, ?), updatedAt=?
               WHERE id=? AND status IN ('queued','running')`,
            ).run(
              turn.sessionId,
              turn.id,
              terminal,
              turn.error ? String(turn.error) : null,
              turn.createdAt ?? now,
              finishedAt,
              now,
              run.id,
            );
            if (run.jobId) {
              db.prepare(
                "UPDATE runtime_jobs SET status='done', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE id=? AND status IN ('pending','parked')",
              ).run(now, run.jobId);
            }
            updateTaskStatusMonotonicTx(db, run.scheduleId, {
              runId: run.id,
              runSeq: seq,
              status: terminal,
              lastRunAt: turn.createdAt ?? now,
              lastSessionId: turn.sessionId,
              historyEntry: {
                runId: run.id,
                sessionId: turn.sessionId,
                turnId: turn.id,
                at: turn.createdAt ?? now,
                trigger: run.trigger || 'schedule',
              },
              now: finishedAt,
            });
            schedulesToAdvance.add(run.scheduleId);
            stats.converged++;
            if (wasUnattached) stats.attached++;
          } else {
            if (run.status !== 'running' || wasUnattached) {
              db.prepare(
                `UPDATE scheduled_task_runs
                 SET sessionId=?, turnId=?, status='running',
                     startedAt=COALESCE(startedAt, ?), updatedAt=?
                 WHERE id=? AND status IN ('queued','running')`,
              ).run(turn.sessionId, turn.id, turn.createdAt ?? now, now, run.id);
              updateTaskStatusMonotonicTx(db, run.scheduleId, {
                runId: run.id,
                runSeq: seq,
                status: 'running',
                lastRunAt: turn.createdAt ?? now,
                lastSessionId: turn.sessionId,
                historyEntry: {
                  runId: run.id,
                  sessionId: turn.sessionId,
                  turnId: turn.id,
                  at: turn.createdAt ?? now,
                  trigger: run.trigger || 'schedule',
                },
                now,
              });
              if (wasUnattached) stats.attached++;
            }
            if (run.jobId) {
              db.prepare(
                "UPDATE runtime_jobs SET status='done', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE id=? AND status IN ('pending','parked')",
              ).run(now, run.jobId);
            }
            runsToWatch.push({
              scheduleId: run.scheduleId,
              runId: run.id,
              sessionId: turn.sessionId,
              turnId: turn.id,
            });
          }
          continue;
        }

        // No direct_turns row found
        if (run.status === 'running') {
          if (run.turnId) {
            db.prepare(
              `UPDATE scheduled_task_runs
               SET status='cancelled', error='Linked turn no longer exists',
                   finishedAt=COALESCE(finishedAt, ?), updatedAt=?
               WHERE id=? AND status='running'`,
            ).run(now, now, run.id);
            updateTaskStatusMonotonicTx(db, run.scheduleId, {
              runId: run.id,
              runSeq: seq,
              status: 'cancelled',
              now,
            });
            schedulesToAdvance.add(run.scheduleId);
            stats.converged++;
            continue;
          }
          // Marked running without any turnId -> restore to queued and repair job below
          db.prepare(
            "UPDATE scheduled_task_runs SET status='queued', updatedAt=? WHERE id=?",
          ).run(now, run.id);
          run.status = 'queued';
        }

        // status === 'queued' and no turn yet
        let job = run.jobId
          ? db.prepare('SELECT * FROM runtime_jobs WHERE id=?').get(run.jobId)
          : null;
        if (!job && run.idempotencyKey) {
          job = db
            .prepare('SELECT * FROM runtime_jobs WHERE idempotencyKey=?')
            .get(run.idempotencyKey);
        }

        if (job && job.status === 'cancelled') {
          db.prepare(
            "UPDATE scheduled_task_runs SET jobId=?, status='cancelled', finishedAt=COALESCE(finishedAt, ?), updatedAt=? WHERE id=? AND status='queued'",
          ).run(job.id, now, now, run.id);
          updateTaskStatusMonotonicTx(db, run.scheduleId, {
            runId: run.id,
            runSeq: seq,
            status: 'cancelled',
            now,
          });
          schedulesToAdvance.add(run.scheduleId);
          stats.converged++;
          continue;
        }

        if (job && job.status === 'failed') {
          db.prepare(
            "UPDATE scheduled_task_runs SET jobId=?, status='failed', error=?, finishedAt=COALESCE(finishedAt, ?), updatedAt=? WHERE id=? AND status='queued'",
          ).run(
            job.id,
            job.errorMessage || job.errorCode || 'Scheduled job failed',
            now,
            now,
            run.id,
          );
          updateTaskStatusMonotonicTx(db, run.scheduleId, {
            runId: run.id,
            runSeq: seq,
            status: 'failed',
            now,
          });
          schedulesToAdvance.add(run.scheduleId);
          stats.converged++;
          continue;
        }

        if (!job || job.status === 'done') {
          // Repair missing/unlinked job (park initially; advanceQueuedRunsForScheduleTx promotes within concurrency limits)
          ensureScheduledJobTx(this.store, run, { desiredStatus: 'parked', now });
          schedulesToAdvance.add(run.scheduleId);
          stats.repaired++;
          continue;
        }

        if (run.jobId !== job.id) {
          db.prepare('UPDATE scheduled_task_runs SET jobId=?, updatedAt=? WHERE id=?').run(
            job.id,
            now,
            run.id,
          );
          stats.repaired++;
        }

        if (job.status === 'parked') {
          schedulesToAdvance.add(run.scheduleId);
        } else if (job.status === 'pending') {
          this.store.notifyJobWake();
          stats.woken++;
        } else if (job.status === 'active') {
          const ownership = classifyJobOwnership(this.store, job, { now, markDeadInDb: true });
          if (ownership.reclaimable) {
            this.store.notifyJobWake();
            stats.woken++;
          }
        }
      }

      for (const scheduleId of schedulesToAdvance) {
        stats.woken += advanceQueuedRunsForScheduleTx(this.store, scheduleId, now);
      }
    });

    this.#pruneSettledWatchers();
    for (const w of runsToWatch) {
      this.#watchTurnSettlement(w.scheduleId, w.runId, w.sessionId, w.turnId);
    }

    return stats;
  }

  async runNow(id, { trigger = 'manual', scheduledFor = null, existingRunId = null } = {}) {
    const sched = this.get(id);
    const now = Date.now();
    const isManual = trigger === 'manual' || String(trigger).startsWith('manual');
    const slotTs = scheduledFor ?? now;

    const launched = this.store.tx(() => {
      const db = this.store.db;
      if (existingRunId) {
        const existingRow = db
          .prepare('SELECT * FROM scheduled_task_runs WHERE id=? AND scheduleId=?')
          .get(existingRunId, id);
        if (!existingRow || TERMINAL_RUN_STATUSES.has(existingRow.status)) {
          return { noop: true, runId: existingRunId, sess: null, turn: null };
        }
        const seq = ensureRunSeqTx(db, existingRow);
        const existingTurn = findCorrelatedTurnTx(db, existingRow);
        if (existingTurn) {
          const terminal = mapTurnStateToRunStatus(existingTurn.state);
          const nextStatus = terminal ?? 'running';
          db.prepare(
            `UPDATE scheduled_task_runs
             SET sessionId=COALESCE(sessionId, ?), turnId=COALESCE(turnId, ?),
                 status=?, error=?, startedAt=COALESCE(startedAt, ?),
                 finishedAt=COALESCE(finishedAt, ?), updatedAt=?
             WHERE id=? AND status='queued'`,
          ).run(
            existingTurn.sessionId,
            existingTurn.id,
            nextStatus,
            terminal ? (existingTurn.error ? String(existingTurn.error) : null) : null,
            existingTurn.createdAt ?? now,
            terminal ? (existingTurn.finishedAt ?? now) : null,
            now,
            existingRow.id,
          );
          updateTaskStatusMonotonicTx(db, id, {
            runId: existingRow.id,
            runSeq: seq,
            status: nextStatus,
            lastRunAt: existingTurn.createdAt ?? now,
            lastSessionId: existingTurn.sessionId,
            historyEntry: {
              runId: existingRow.id,
              sessionId: existingTurn.sessionId,
              turnId: existingTurn.id,
              at: existingTurn.createdAt ?? now,
              trigger: existingRow.trigger || trigger,
            },
            now: terminal ? (existingTurn.finishedAt ?? now) : now,
          });
          let sess = null;
          try {
            sess = this.directAgent?.getSession?.(existingTurn.sessionId) ?? null;
          } catch {
            sess = null;
          }
          return { noop: Boolean(terminal), runId: existingRow.id, sess, turn: existingTurn };
        }

        const started = this.#launchSessionAndTurn(sched, {
          clientTurnId: existingRow.idempotencyKey,
          existingSessionId: existingRow.sessionId || null,
        });
        db.prepare(
          `UPDATE scheduled_task_runs
           SET sessionId=?, turnId=?, status='running', startedAt=COALESCE(startedAt, ?), updatedAt=?
           WHERE id=? AND status='queued'`,
        ).run(started.sess.id, started.turn.id, now, now, existingRow.id);

        updateTaskStatusMonotonicTx(db, id, {
          runId: existingRow.id,
          runSeq: seq,
          status: 'running',
          lastRunAt: now,
          lastSessionId: started.sess.id,
          historyEntry: {
            runId: existingRow.id,
            sessionId: started.sess.id,
            turnId: started.turn.id,
            at: now,
            trigger: existingRow.trigger || trigger,
          },
          now,
        });
        return { noop: false, runId: existingRow.id, sess: started.sess, turn: started.turn };
      }

      const runId = uuid();
      const idem =
        scheduledFor !== null
          ? `sched:${id}:${scheduledFor}`
          : `sched:${id}:manual:${runId}`;
      const runSeq = nextRunSeqTx(db, id);
      const started = this.#launchSessionAndTurn(sched, { clientTurnId: idem });
      db.prepare(
        `INSERT INTO scheduled_task_runs(
          id, scheduleId, scheduledFor, idempotencyKey, sessionId, turnId,
          status, runSeq, trigger, startedAt, createdAt, updatedAt
        ) VALUES(?,?,?,?,?,?,'running',?,?,?,?,?)`,
      ).run(
        runId,
        id,
        slotTs,
        idem,
        started.sess.id,
        started.turn.id,
        runSeq,
        trigger,
        now,
        now,
        now,
      );

      // Preserve periodic nextRunAt cadence on manual runNow()
      const nextRunAt = isManual
        ? undefined
        : sched.enabled
          ? computeNextRunAt(sched.scheduleKind, sched.scheduleExpr, this.#now(), {
              timezone: sched.timezone,
            })
          : null;

      updateTaskStatusMonotonicTx(db, id, {
        runId,
        runSeq,
        status: 'running',
        lastRunAt: now,
        lastSessionId: started.sess.id,
        nextRunAt,
        historyEntry: {
          runId,
          sessionId: started.sess.id,
          turnId: started.turn.id,
          at: now,
          trigger,
        },
        now,
      });
      return { noop: false, runId, sess: started.sess, turn: started.turn };
    });

    if (!launched.noop && launched.sess && launched.turn) {
      this.#watchTurnSettlement(id, launched.runId, launched.sess.id, launched.turn.id);
    }
    this.#rearmTimer();
    const run = this.store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(launched.runId);
    return { schedule: this.get(id), run, session: launched.sess, turn: launched.turn };
  }

  enqueueScheduledRun(sched, scheduledFor, { trigger = 'schedule' } = {}) {
    const now = Date.now();
    const idem = `sched:${sched.id}:${scheduledFor}`;
    const jobQueue = this.directAgent?.jobQueue;
    let watchAfterCommit = null;
    let fallbackRunId = null;

    const run = this.store.tx(() => {
      const db = this.store.db;
      const freshRow = db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(sched.id);
      if (!freshRow) return null;
      const hydrated = this.#hydrate(freshRow);

      reconcileRunningRunsForScheduleTx(this.store, hydrated.id, now);

      const existing = db
        .prepare('SELECT * FROM scheduled_task_runs WHERE idempotencyKey=?')
        .get(idem);
      if (existing) {
        const seq = ensureRunSeqTx(db, existing);
        if (existing.status === 'queued') {
          // Check deterministic turn first before repairing job
          const turn = findCorrelatedTurnTx(db, existing);
          if (turn) {
            const terminal = mapTurnStateToRunStatus(turn.state);
            const nextStatus = terminal ?? 'running';
            db.prepare(
              `UPDATE scheduled_task_runs
               SET sessionId=COALESCE(sessionId, ?), turnId=COALESCE(turnId, ?),
                   status=?, error=?, startedAt=COALESCE(startedAt, ?),
                   finishedAt=COALESCE(finishedAt, ?), updatedAt=?
               WHERE id=? AND status='queued'`,
            ).run(
              turn.sessionId,
              turn.id,
              nextStatus,
              terminal ? (turn.error ? String(turn.error) : null) : null,
              turn.createdAt ?? now,
              terminal ? (turn.finishedAt ?? now) : null,
              now,
              existing.id,
            );
            updateTaskStatusMonotonicTx(db, hydrated.id, {
              runId: existing.id,
              runSeq: seq,
              status: nextStatus,
              lastRunAt: turn.createdAt ?? now,
              lastSessionId: turn.sessionId,
              historyEntry: {
                runId: existing.id,
                sessionId: turn.sessionId,
                turnId: turn.id,
                at: turn.createdAt ?? now,
                trigger: existing.trigger || trigger,
              },
              now,
            });
            if (terminal) {
              advanceQueuedRunsForScheduleTx(this.store, hydrated.id, now);
            } else {
              watchAfterCommit = {
                scheduleId: hydrated.id,
                runId: existing.id,
                sessionId: turn.sessionId,
                turnId: turn.id,
              };
            }
            return db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(existing.id);
          }

          // Repair missing/broken jobId on retry (never stay permanently stuck queued!)
          if (jobQueue) {
            const runningCount =
              db
                .prepare(
                  "SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE scheduleId=? AND status='running'",
                )
                .get(hydrated.id)?.n ?? 0;
            const desiredStatus =
              hydrated.concurrencyPolicy === 'queue' && runningCount >= hydrated.maxConcurrency
                ? 'parked'
                : 'pending';
            ensureScheduledJobTx(this.store, existing, { desiredStatus, now });
          } else {
            fallbackRunId = existing.id;
          }
          return db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(existing.id);
        }
        return existing;
      }

      const runSeq = nextRunSeqTx(db, hydrated.id);
      const runningCount =
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE scheduleId=? AND status='running'",
          )
          .get(hydrated.id)?.n ?? 0;
      const activeCount =
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE scheduleId=? AND status IN ('queued','running')",
          )
          .get(hydrated.id)?.n ?? 0;

      const runId = uuid();
      if (hydrated.concurrencyPolicy === 'skip' && activeCount >= hydrated.maxConcurrency) {
        db.prepare(
          `INSERT INTO scheduled_task_runs(
            id, scheduleId, scheduledFor, idempotencyKey, status, error,
            runSeq, trigger, finishedAt, createdAt, updatedAt
          ) VALUES(?,?,?,?,'skipped','concurrencyPolicy=skip',?,?,?,?,?)`,
        ).run(runId, hydrated.id, scheduledFor, idem, runSeq, trigger, now, now, now);
        return db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(runId);
      }

      // Single atomic transaction: insert occurrence + linked runtime_jobs row together
      db.prepare(
        `INSERT INTO scheduled_task_runs(
          id, scheduleId, scheduledFor, idempotencyKey, status, runSeq, trigger, createdAt, updatedAt
        ) VALUES(?,?,?,?,'queued',?,?,?,?)`,
      ).run(runId, hydrated.id, scheduledFor, idem, runSeq, trigger, now, now);

      const inserted = db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(runId);
      if (jobQueue) {
        const desiredStatus =
          hydrated.concurrencyPolicy === 'queue' && runningCount >= hydrated.maxConcurrency
            ? 'parked'
            : 'pending';
        ensureScheduledJobTx(this.store, inserted, { desiredStatus, now });
      } else {
        fallbackRunId = runId;
      }
      return db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(runId);
    });

    if (watchAfterCommit) {
      this.#watchTurnSettlement(
        watchAfterCommit.scheduleId,
        watchAfterCommit.runId,
        watchAfterCommit.sessionId,
        watchAfterCommit.turnId,
      );
    }
    if (fallbackRunId) {
      void this.runNow(sched.id, {
        trigger,
        scheduledFor,
        existingRunId: fallbackRunId,
      }).catch(() => {});
      return this.store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(fallbackRunId) ?? run;
    }
    return run;
  }

  #executeScheduledJob(job, ctx = {}) {
    const { scheduleId, scheduleRunId, trigger = 'schedule' } = job.payload ?? {};
    const now = Date.now();

    const outcome = this.store.tx(() => {
      if (typeof ctx.leaseGuard === 'function') {
        ctx.leaseGuard();
      }
      const db = this.store.db;
      let runRow = db
        .prepare('SELECT * FROM scheduled_task_runs WHERE id=?')
        .get(scheduleRunId);
      if (!runRow || TERMINAL_RUN_STATUSES.has(runRow.status)) {
        return { action: 'noop' };
      }

      const schedRow = db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(scheduleId);
      if (!schedRow) {
        db.prepare(
          "UPDATE scheduled_task_runs SET status='cancelled', finishedAt=?, updatedAt=? WHERE id=? AND status IN ('queued','running')",
        ).run(now, now, scheduleRunId);
        return { action: 'noop' };
      }
      const hydrated = this.#hydrate(schedRow);
      const seq = ensureRunSeqTx(db, runRow);

      // Reconcile any stale running runs on this schedule first so freed slots are visible immediately
      reconcileRunningRunsForScheduleTx(this.store, scheduleId, now);
      runRow = db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(scheduleRunId);
      if (!runRow || TERMINAL_RUN_STATUSES.has(runRow.status)) {
        return { action: 'noop' };
      }

      // Deterministic correlation check: re-attach existing turn without starting a duplicate!
      const existingTurn = findCorrelatedTurnTx(db, runRow);
      if (existingTurn) {
        const terminal = mapTurnStateToRunStatus(existingTurn.state);
        const nextStatus = terminal ?? 'running';
        db.prepare(
          `UPDATE scheduled_task_runs
           SET sessionId=COALESCE(sessionId, ?), turnId=COALESCE(turnId, ?),
               status=?, error=?, startedAt=COALESCE(startedAt, ?),
               finishedAt=COALESCE(finishedAt, ?), updatedAt=?
           WHERE id=? AND status IN ('queued','running')`,
        ).run(
          existingTurn.sessionId,
          existingTurn.id,
          nextStatus,
          terminal ? (existingTurn.error ? String(existingTurn.error) : null) : null,
          existingTurn.createdAt ?? now,
          terminal ? (existingTurn.finishedAt ?? now) : null,
          now,
          scheduleRunId,
        );
        updateTaskStatusMonotonicTx(db, scheduleId, {
          runId: scheduleRunId,
          runSeq: seq,
          status: nextStatus,
          lastRunAt: existingTurn.createdAt ?? now,
          lastSessionId: existingTurn.sessionId,
          historyEntry: {
            runId: scheduleRunId,
            sessionId: existingTurn.sessionId,
            turnId: existingTurn.id,
            at: existingTurn.createdAt ?? now,
            trigger: runRow.trigger || trigger,
          },
          now: terminal ? (existingTurn.finishedAt ?? now) : now,
        });
        if (terminal) {
          advanceQueuedRunsForScheduleTx(this.store, scheduleId, now);
          return { action: 'converged' };
        }
        return {
          action: 'watch',
          scheduleId,
          runId: scheduleRunId,
          sessionId: existingTurn.sessionId,
          turnId: existingTurn.id,
        };
      }

      if (runRow.status !== 'queued') {
        return { action: 'noop' };
      }

      const isManual = String(runRow.trigger || trigger || '').startsWith('manual');
      if (!hydrated.enabled && !isManual) {
        db.prepare(
          `UPDATE scheduled_task_runs
           SET status='cancelled', error='schedule_disabled', finishedAt=COALESCE(finishedAt, ?), updatedAt=?
           WHERE id=? AND status='queued'`,
        ).run(now, now, scheduleRunId);
        updateTaskStatusMonotonicTx(db, scheduleId, {
          runId: scheduleRunId,
          runSeq: seq,
          status: 'cancelled',
          now,
        });
        return { action: 'noop' };
      }

      // Atomic claim/start-time concurrency enforcement across all Runtime instances sharing one DB
      const runningCount =
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE scheduleId=? AND id!=? AND status='running'",
          )
          .get(scheduleId, scheduleRunId)?.n ?? 0;
      const maxConc = Math.max(1, Number(hydrated.maxConcurrency ?? 1));

      if (hydrated.concurrencyPolicy === 'skip' && runningCount >= maxConc) {
        db.prepare(
          `UPDATE scheduled_task_runs
           SET status='skipped', error='concurrencyPolicy=skip', finishedAt=?, updatedAt=?
           WHERE id=? AND status='queued'`,
        ).run(now, now, scheduleRunId);
        return { action: 'skipped' };
      }

      if (hydrated.concurrencyPolicy === 'queue') {
        const olderQueued =
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM scheduled_task_runs r
               LEFT JOIN runtime_jobs j ON j.id = r.jobId
               WHERE r.scheduleId=? AND r.status='queued' AND r.id!=?
                 AND (r.runSeq > 0 AND r.runSeq < ?)
                 AND (j.status IS NULL OR j.status NOT IN ('failed','cancelled'))`,
            )
            .get(scheduleId, scheduleRunId, seq)?.n ?? 0;

        if (runningCount >= maxConc || runningCount + olderQueued >= maxConc) {
          // Park job without burning an attempt; advance oldest queued run if slot is free
          db.prepare(
            `UPDATE runtime_jobs
             SET status='parked', fence=NULL, leaseExpiresAt=NULL,
                 attempts=MAX(0, attempts - 1),
                 errorMessage='waiting_for_concurrency_slot', updatedAt=?
             WHERE id=? AND fence=? AND status='active'`,
          ).run(now, job.id, job.fence);
          if (runningCount < maxConc && olderQueued > 0) {
            advanceQueuedRunsForScheduleTx(this.store, scheduleId, now);
          }
          return { action: 'parked' };
        }
      }

      // Atomic launch: session + turn + scheduled_task_runs + scheduled_tasks in ONE SQLite tx
      const { sess, turn } = this.#launchSessionAndTurn(hydrated, {
        clientTurnId: runRow.idempotencyKey,
        existingSessionId: runRow.sessionId || null,
      });

      db.prepare(
        `UPDATE scheduled_task_runs
         SET sessionId=?, turnId=?, status='running', startedAt=?, updatedAt=?
         WHERE id=? AND status='queued'`,
      ).run(sess.id, turn.id, now, now, scheduleRunId);

      updateTaskStatusMonotonicTx(db, scheduleId, {
        runId: scheduleRunId,
        runSeq: seq,
        status: 'running',
        lastRunAt: now,
        lastSessionId: sess.id,
        historyEntry: {
          runId: scheduleRunId,
          sessionId: sess.id,
          turnId: turn.id,
          at: now,
          trigger: runRow.trigger || trigger,
        },
        now,
      });

      return {
        action: 'watch',
        scheduleId,
        runId: scheduleRunId,
        sessionId: sess.id,
        turnId: turn.id,
      };
    });

    if (outcome?.action === 'watch') {
      this.#watchTurnSettlement(
        outcome.scheduleId,
        outcome.runId,
        outcome.sessionId,
        outcome.turnId,
      );
    }
  }

  #launchSessionAndTurn(sched, { clientTurnId = null, existingSessionId = null } = {}) {
    let sess = null;
    if (existingSessionId) {
      try {
        sess = this.directAgent.getSession(existingSessionId);
      } catch {
        sess = null;
      }
    }
    if (!sess) {
      sess = this.directAgent.createSession({
        title: `[定时] ${sched.name}`,
        model: sched.model,
        workspaceRoot: sched.workspaceRoot,
        permissionMode: sched.permissionMode,
      });
    }
    const { turn } = this.directAgent.startTurn(sess.id, {
      input: sched.prompt,
      clientTurnId,
      model: sched.model,
      permissionMode: sched.permissionMode,
    });
    return { sess, turn };
  }

  #watchTurnSettlement(scheduleId, scheduleRunId, sessionId, turnId) {
    if (!this.directAgent?.subscribe || !turnId) return;
    if (this.turnWatchers.has(turnId)) return;

    // Fast durable DB check in case the turn already converged before subscribing
    if (this.store?.db?.isOpen) {
      const turn = this.store.db
        .prepare('SELECT state, error, finishedAt FROM direct_turns WHERE id=?')
        .get(turnId);
      const terminal = turn ? mapTurnStateToRunStatus(turn.state) : null;
      if (terminal) {
        convergeScheduledRunForTurn(this.store, turnId, {
          status: terminal,
          error: turn.error ?? null,
          finishedAt: turn.finishedAt ?? Date.now(),
        });
        return;
      }
    }

    const unsub = this.directAgent.subscribe(sessionId, (ev) => {
      if (ev.turnId !== turnId) return;
      if (!['turn/completed', 'turn/failed', 'turn/cancelled'].includes(ev.type)) return;
      this.#unwatchTurn(turnId);
      if (!this.store?.db?.isOpen) return;
      const status =
        ev.type === 'turn/completed'
          ? 'completed'
          : ev.type === 'turn/cancelled'
            ? 'cancelled'
            : 'failed';
      convergeScheduledRunForTurn(this.store, turnId, {
        status,
        error: ev.data?.error ? String(ev.data.error) : null,
        finishedAt: Date.now(),
      });
    });
    this.unsubs.add(unsub);
    this.turnWatchers.set(turnId, { scheduleId, runId: scheduleRunId, unsub });
    if (this.running) this.#rearmTimer();
  }

  #planDueSchedule(sched, expectedNextRunAt, now, { mode = 'tick' } = {}) {
    const cfg = validateScheduleConfig({
      scheduleKind: sched.scheduleKind,
      scheduleExpr: sched.scheduleExpr,
      timezone: sched.timezone,
      concurrencyPolicy: sched.concurrencyPolicy,
      misfirePolicy: sched.misfirePolicy,
      maxConcurrency: sched.maxConcurrency,
    });

    const advancePastNow = (cursor) => {
      if (cursor > now) return cursor;
      if (cfg.kind === 'interval') {
        return advanceIntervalPast(cursor, cfg.intervalMs, now);
      }
      const next = computeNextRunAt(cfg.kind, cfg.expr, cursor, { timezone: cfg.tz });
      if (next > now) return next;
      return computeNextRunAt(cfg.kind, cfg.expr, now, { timezone: cfg.tz });
    };

    const slotsToEnqueue = [];
    let cursor = expectedNextRunAt;

    if (mode === 'misfire') {
      if (sched.misfirePolicy === 'skip') {
        cursor = advancePastNow(cursor);
      } else if (sched.misfirePolicy === 'catch_up') {
        let count = 0;
        while (cursor <= now && count < 5) {
          slotsToEnqueue.push({ slot: cursor, trigger: 'misfire_catch_up' });
          cursor = computeNextRunAt(cfg.kind, cfg.expr, cursor, { timezone: cfg.tz });
          count++;
        }
        cursor = advancePastNow(cursor);
      } else {
        slotsToEnqueue.push({ slot: cursor, trigger: 'misfire_fire_once' });
        cursor = advancePastNow(cursor);
      }
      return { slotsToEnqueue, nextRunAt: cursor };
    }

    // Live tick: advance from fresh.nextRunAt (not Math.max(now, nextRunAt)) so
    // DST fall-back lag or process sleep never double-fires ambiguous wall times.
    if (sched.misfirePolicy === 'catch_up') {
      let count = 0;
      while (cursor <= now && count < 5) {
        slotsToEnqueue.push({
          slot: cursor,
          trigger: count === 0 ? 'schedule' : 'misfire_catch_up',
        });
        cursor = computeNextRunAt(cfg.kind, cfg.expr, cursor, { timezone: cfg.tz });
        count++;
      }
      cursor = advancePastNow(cursor);
    } else {
      slotsToEnqueue.push({ slot: cursor, trigger: 'schedule' });
      cursor = advancePastNow(cursor);
    }
    return { slotsToEnqueue, nextRunAt: cursor };
  }

  #processDueSchedule(scheduleId, expectedNextRunAt, now, { mode = 'tick' } = {}) {
    try {
      let processed = false;
      this.store.tx(() => {
        const db = this.store.db;
        const freshRow = db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(scheduleId);
        if (
          !freshRow ||
          !freshRow.enabled ||
          freshRow.nextRunAt === null ||
          freshRow.nextRunAt === undefined ||
          freshRow.nextRunAt > now ||
          freshRow.nextRunAt !== expectedNextRunAt
        ) {
          return;
        }
        const sched = this.#hydrate(freshRow);
        const { slotsToEnqueue, nextRunAt } = this.#planDueSchedule(
          sched,
          freshRow.nextRunAt,
          now,
          { mode },
        );

        const wallNow = Date.now();
        const cas = db
          .prepare(
            'UPDATE scheduled_tasks SET nextRunAt=?, updatedAt=? WHERE id=? AND enabled=1 AND nextRunAt=?',
          )
          .run(nextRunAt, wallNow, sched.id, expectedNextRunAt);
        if ((cas.changes ?? 0) !== 1) {
          return;
        }
        processed = true;
        for (const item of slotsToEnqueue) {
          this.enqueueScheduledRun(sched, item.slot, { trigger: item.trigger });
        }
      });
      return processed;
    } catch (err) {
      // Isolate corrupt/legacy schedule config so one bad row never blocks boot or other schedules
      if (err?.code === 'INVALID_SCHEDULE_CONFIG' && this.store?.db?.isOpen) {
        try {
          this.store.tx(() => {
            this.store.db
              .prepare(
                "UPDATE scheduled_tasks SET enabled=0, nextRunAt=NULL, lastStatus='failed', updatedAt=? WHERE id=? AND nextRunAt=?",
              )
              .run(Date.now(), scheduleId, expectedNextRunAt);
          });
        } catch {
          // best-effort quarantine
        }
      }
      return false;
    }
  }

  recoverMisfires({ now = this.#now() } = {}) {
    if (!this.store?.db?.isOpen) return 0;
    const due = this.store.db
      .prepare(
        'SELECT id, nextRunAt FROM scheduled_tasks WHERE enabled=1 AND nextRunAt IS NOT NULL AND nextRunAt<=?',
      )
      .all(now);

    let handled = 0;
    for (const row of due) {
      if (this.#processDueSchedule(row.id, row.nextRunAt, now, { mode: 'misfire' })) {
        handled++;
      }
    }
    return handled;
  }

  #hasReconcilableWork() {
    if (!this.store?.db?.isOpen) return false;
    const db = this.store.db;
    const needsRunReconcile = db
      .prepare(
        `SELECT 1 FROM scheduled_task_runs r
         LEFT JOIN direct_turns t ON t.id = r.turnId
         WHERE r.status = 'queued'
            OR (r.status = 'running' AND (r.turnId IS NULL OR t.id IS NULL OR t.state IN ('completed','failed','cancelled')))
         LIMIT 1`,
      )
      .get();
    return Boolean(needsRunReconcile);
  }

  #onTimerWake() {
    if (!this.running || !this.store?.db?.isOpen) return;
    try {
      this.#pruneSettledWatchers();
      if (this.#hasReconcilableWork()) {
        this.reconcileRuns();
      }
      this.tickDue({ rearm: false });
    } finally {
      this.#rearmTimer();
    }
  }

  #rearmTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.running || !this.store?.db?.isOpen) return;
    const next = this.store.db
      .prepare(
        'SELECT id, nextRunAt FROM scheduled_tasks WHERE enabled=1 AND nextRunAt IS NOT NULL ORDER BY nextRunAt ASC LIMIT 1',
      )
      .get();
    const hasActiveRunsOrJobs = Boolean(
      this.turnWatchers.size > 0 ||
        this.store.db
          .prepare("SELECT 1 FROM scheduled_task_runs WHERE status IN ('queued','running') LIMIT 1")
          .get() ||
        this.store.db
          .prepare(
            "SELECT 1 FROM runtime_jobs WHERE kind='scheduled_task' AND status IN ('pending','active','parked') LIMIT 1",
          )
          .get(),
    );
    if (!next && !hasActiveRunsOrJobs) return; // Zero-idle-polling invariant

    const now = this.#now();
    let delayMs;
    if (next) {
      const untilNext = Math.max(25, next.nextRunAt - now);
      const syncCapMs = hasActiveRunsOrJobs ? 500 : 30_000;
      delayMs = Math.min(2147483647, untilNext, syncCapMs);
    } else {
      delayMs = 500;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#onTimerWake();
    }, delayMs);
    this.timer.unref?.();
  }

  tickDue({ now = this.#now(), rearm = true } = {}) {
    if (!this.running || !this.store?.db?.isOpen) return 0;
    let handled = 0;
    try {
      const due = this.store.db
        .prepare(
          'SELECT id, nextRunAt FROM scheduled_tasks WHERE enabled=1 AND nextRunAt IS NOT NULL AND nextRunAt<=?',
        )
        .all(now);

      for (const row of due) {
        if (this.#processDueSchedule(row.id, row.nextRunAt, now, { mode: 'tick' })) {
          handled++;
        }
      }
    } finally {
      if (rearm) this.#rearmTimer();
    }
    return handled;
  }
}
