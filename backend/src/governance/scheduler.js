import { Fault, id as uuid } from '../store.js';
import { computeNextRunAt, validateScheduleConfig } from './cron.js';

export { computeNextRunAt };

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Layer 2/7 Durable ScheduledTaskRunner backed by `scheduled_tasks`,
 * `scheduled_task_runs`, and `DurableJobQueue` (`scheduled_task` jobs).
 * Preserves zero-idle-polling: `timer === null` whenever no enabled tasks exist.
 */
export class ScheduledTaskRunner {
  constructor({ store, directAgent }) {
    this.store = store;
    this.directAgent = directAgent;
    this.running = false;
    this.timer = null;
    this.unsubs = new Set();

    this.directAgent?.recoveryWorker?.registerHandler('scheduled_task', (job) =>
      this.#executeScheduledJob(job),
    );
  }

  #hydrate(row) {
    if (!row) return null;
    return {
      ...row,
      timezone: row.timezone || 'UTC',
      concurrencyPolicy: row.concurrencyPolicy || 'skip',
      misfirePolicy: row.misfirePolicy || 'fire_once',
      maxConcurrency: Number(row.maxConcurrency ?? 1),
      enabled: Boolean(row.enabled),
      runHistory: parseJsonSafe(row.runHistoryJson, []),
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#recoverMisfires();
    this.#rearmTimer();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
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
        'SELECT * FROM scheduled_task_runs WHERE scheduleId=? ORDER BY createdAt DESC LIMIT ?',
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
    if (!cleanPrompt) throw new Fault('EMPTY_PROMPT', 400);

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
    const nextRunAt = enabled
      ? computeNextRunAt(cfg.kind, cfg.expr, now, { timezone: cfg.tz })
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
            enabled, nextRunAt, runHistoryJson, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'[]',?,?)`,
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
    const enabled = patch.enabled !== undefined ? Boolean(patch.enabled) : cur.enabled;
    const scheduleKind = patch.scheduleKind ?? cur.scheduleKind;
    const scheduleExpr = patch.scheduleExpr ?? cur.scheduleExpr;
    const timezone = patch.timezone ?? cur.timezone;
    const concurrencyPolicy = patch.concurrencyPolicy ?? cur.concurrencyPolicy;
    const misfirePolicy = patch.misfirePolicy ?? cur.misfirePolicy;
    const maxConcurrency = patch.maxConcurrency ?? cur.maxConcurrency;

    const cfg = validateScheduleConfig({
      scheduleKind,
      scheduleExpr,
      timezone,
      concurrencyPolicy,
      misfirePolicy,
      maxConcurrency,
    });

    const nextRunAt = enabled
      ? patch.nextRunAt ?? computeNextRunAt(cfg.kind, cfg.expr, now, { timezone: cfg.tz })
      : null;

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
          patch.prompt !== undefined ? String(patch.prompt) : cur.prompt,
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
    });
    this.#rearmTimer();
    return this.get(id);
  }

  delete(id) {
    this.get(id);
    this.store.tx(() => {
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
    if (row.turnId) {
      try {
        this.directAgent?.cancelTurn?.(row.turnId);
      } catch {
        // turn may already be terminal
      }
    }
    const now = Date.now();
    this.store.tx(() => {
      if (row.jobId) {
        this.store.db
          .prepare(
            "UPDATE runtime_jobs SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE id=? AND status IN ('pending','active')",
          )
          .run(now, row.jobId);
      }
      this.store.db
        .prepare(
          "UPDATE scheduled_task_runs SET status='cancelled', finishedAt=? WHERE id=? AND status IN ('queued','running')",
        )
        .run(now, runId);
    });
    return this.store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(runId);
  }

  async runNow(id, { trigger = 'manual', scheduledFor = null } = {}) {
    const sched = this.get(id);
    const now = Date.now();
    const runId = uuid();
    const slotTs = scheduledFor ?? now;
    const idem =
      scheduledFor !== null
        ? `sched:${id}:${scheduledFor}`
        : `sched:${id}:manual:${uuid().slice(0, 8)}`;

    const { sess, turn } = this.#launchSessionAndTurn(sched);
    const nextRunAt = sched.enabled
      ? computeNextRunAt(sched.scheduleKind, sched.scheduleExpr, now, { timezone: sched.timezone })
      : null;

    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO scheduled_task_runs(
            id, scheduleId, scheduledFor, idempotencyKey, sessionId, turnId,
            status, startedAt, createdAt
          ) VALUES(?,?,?,?,?,?,'running',?,?)`,
        )
        .run(runId, id, slotTs, idem, sess.id, turn.id, now, now);

      const history = [
        { runId, sessionId: sess.id, turnId: turn.id, at: now, trigger },
        ...(sched.runHistory ?? []),
      ].slice(0, 20);
      this.store.db
        .prepare(
          `UPDATE scheduled_tasks
           SET lastRunAt=?, nextRunAt=?, lastSessionId=?, lastStatus='running',
               runHistoryJson=?, updatedAt=?
           WHERE id=?`,
        )
        .run(now, nextRunAt, sess.id, JSON.stringify(history), now, id);
    });

    this.#watchTurnSettlement(id, runId, sess.id, turn.id);
    this.#rearmTimer();
    const run = this.store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(runId);
    return { schedule: this.get(id), run, session: sess, turn };
  }

  enqueueScheduledRun(sched, scheduledFor, { trigger = 'schedule' } = {}) {
    const now = Date.now();
    const idem = `sched:${sched.id}:${scheduledFor}`;
    const existing = this.store.db
      .prepare('SELECT * FROM scheduled_task_runs WHERE idempotencyKey=?')
      .get(idem);
    if (existing) return existing;

    const activeCount =
      this.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE scheduleId=? AND status IN ('queued','running')",
        )
        .get(sched.id)?.n ?? 0;

    const runId = uuid();
    if (sched.concurrencyPolicy === 'skip' && activeCount >= sched.maxConcurrency) {
      this.store.tx(() => {
        this.store.db
          .prepare(
            `INSERT OR IGNORE INTO scheduled_task_runs(
              id, scheduleId, scheduledFor, idempotencyKey, status, error, finishedAt, createdAt
            ) VALUES(?,?,?,?,'skipped','concurrencyPolicy=skip',?,?)`,
          )
          .run(runId, sched.id, scheduledFor, idem, now, now);
      });
      return this.store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(runId);
    }

    const jobQueue = this.directAgent?.jobQueue;
    let jobId = null;
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT OR IGNORE INTO scheduled_task_runs(
            id, scheduleId, scheduledFor, idempotencyKey, status, createdAt
          ) VALUES(?,?,?,?,'queued',?)`,
        )
        .run(runId, sched.id, scheduledFor, idem, now);
    });
    const inserted = this.store.db
      .prepare('SELECT * FROM scheduled_task_runs WHERE idempotencyKey=?')
      .get(idem);
    if (!inserted || inserted.id !== runId) return inserted;

    if (jobQueue) {
      const job = jobQueue.enqueue({
        kind: 'scheduled_task',
        taskId: sched.id,
        idempotencyKey: idem,
        payload: {
          scheduleId: sched.id,
          scheduleRunId: runId,
          scheduledFor,
          trigger,
        },
        maxAttempts: 2,
      });
      jobId = job.id;
      this.store.tx(() => {
        this.store.db
          .prepare('UPDATE scheduled_task_runs SET jobId=? WHERE id=?')
          .run(jobId, runId);
      });
    } else {
      void this.runNow(sched.id, { trigger, scheduledFor });
    }
    return this.store.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(runId);
  }

  #executeScheduledJob(job) {
    const { scheduleId, scheduleRunId, trigger = 'schedule' } = job.payload ?? {};
    const runRow = this.store.db
      .prepare('SELECT * FROM scheduled_task_runs WHERE id=?')
      .get(scheduleRunId);
    if (!runRow || runRow.status === 'cancelled' || runRow.status === 'skipped') return;
    if (runRow.sessionId && runRow.turnId) return; // already launched

    const sched = this.store.db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(scheduleId);
    if (!sched) return;

    const hydrated = this.#hydrate(sched);
    const { sess, turn } = this.#launchSessionAndTurn(hydrated);
    const now = Date.now();

    this.store.tx(() => {
      this.store.db
        .prepare(
          `UPDATE scheduled_task_runs
           SET sessionId=?, turnId=?, status='running', startedAt=?
           WHERE id=? AND status='queued'`,
        )
        .run(sess.id, turn.id, now, scheduleRunId);
      const history = [
        { runId: scheduleRunId, sessionId: sess.id, turnId: turn.id, at: now, trigger },
        ...(hydrated.runHistory ?? []),
      ].slice(0, 20);
      this.store.db
        .prepare(
          `UPDATE scheduled_tasks
           SET lastRunAt=?, lastSessionId=?, lastStatus='running', runHistoryJson=?, updatedAt=?
           WHERE id=?`,
        )
        .run(now, sess.id, JSON.stringify(history), now, scheduleId);
    });
    this.#watchTurnSettlement(scheduleId, scheduleRunId, sess.id, turn.id);
  }

  #launchSessionAndTurn(sched) {
    const sess = this.directAgent.createSession({
      title: `[定时] ${sched.name}`,
      model: sched.model,
      workspaceRoot: sched.workspaceRoot,
      permissionMode: sched.permissionMode,
    });
    const { turn } = this.directAgent.startTurn(sess.id, {
      input: sched.prompt,
      model: sched.model,
      permissionMode: sched.permissionMode,
    });
    return { sess, turn };
  }

  #watchTurnSettlement(scheduleId, scheduleRunId, sessionId, turnId) {
    if (!this.directAgent?.subscribe) return;
    const unsub = this.directAgent.subscribe(sessionId, (ev) => {
      if (ev.turnId !== turnId) return;
      if (!['turn/completed', 'turn/failed', 'turn/cancelled'].includes(ev.type)) return;
      unsub();
      this.unsubs.delete(unsub);
      if (!this.store?.db?.isOpen) return;
      const status =
        ev.type === 'turn/completed'
          ? 'completed'
          : ev.type === 'turn/cancelled'
            ? 'cancelled'
            : 'failed';
      const now = Date.now();
      this.store.tx(() => {
        this.store.db
          .prepare(
            "UPDATE scheduled_task_runs SET status=?, error=?, finishedAt=? WHERE id=? AND status IN ('queued','running')",
          )
          .run(status, ev.data?.error ? String(ev.data.error) : null, now, scheduleRunId);
        this.store.db
          .prepare('UPDATE scheduled_tasks SET lastStatus=?, updatedAt=? WHERE id=?')
          .run(status, now, scheduleId);
      });
    });
    this.unsubs.add(unsub);
  }

  #recoverMisfires() {
    if (!this.store?.db?.isOpen) return;
    const now = Date.now();
    const due = this.store.db
      .prepare('SELECT * FROM scheduled_tasks WHERE enabled=1 AND nextRunAt IS NOT NULL AND nextRunAt<=?')
      .all(now)
      .map((r) => this.#hydrate(r));

    for (const sched of due) {
      let cursor = sched.nextRunAt;
      if (sched.misfirePolicy === 'skip') {
        while (cursor <= now) {
          cursor = computeNextRunAt(sched.scheduleKind, sched.scheduleExpr, cursor, {
            timezone: sched.timezone,
          });
        }
      } else if (sched.misfirePolicy === 'catch_up') {
        let count = 0;
        while (cursor <= now && count < 5) {
          this.enqueueScheduledRun(sched, cursor, { trigger: 'misfire_catch_up' });
          cursor = computeNextRunAt(sched.scheduleKind, sched.scheduleExpr, cursor, {
            timezone: sched.timezone,
          });
          count++;
        }
        while (cursor <= now) {
          cursor = computeNextRunAt(sched.scheduleKind, sched.scheduleExpr, cursor, {
            timezone: sched.timezone,
          });
        }
      } else {
        this.enqueueScheduledRun(sched, cursor, { trigger: 'misfire_fire_once' });
        while (cursor <= now) {
          cursor = computeNextRunAt(sched.scheduleKind, sched.scheduleExpr, cursor, {
            timezone: sched.timezone,
          });
        }
      }
      this.store.tx(() => {
        this.store.db
          .prepare('UPDATE scheduled_tasks SET nextRunAt=?, updatedAt=? WHERE id=?')
          .run(cursor, now, sched.id);
      });
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
    if (!next) return; // Zero-idle-polling invariant

    const delayMs = Math.min(2147483647, Math.max(25, next.nextRunAt - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#tickDue();
    }, delayMs);
    this.timer.unref?.();
  }

  #tickDue() {
    if (!this.running || !this.store?.db?.isOpen) return;
    const now = Date.now();
    const due = this.store.db
      .prepare(
        'SELECT * FROM scheduled_tasks WHERE enabled=1 AND nextRunAt IS NOT NULL AND nextRunAt<=?',
      )
      .all(now)
      .map((r) => this.#hydrate(r));

    for (const sched of due) {
      this.enqueueScheduledRun(sched, sched.nextRunAt, { trigger: 'schedule' });
      const nextRunAt = computeNextRunAt(
        sched.scheduleKind,
        sched.scheduleExpr,
        Math.max(now, sched.nextRunAt),
        { timezone: sched.timezone },
      );
      this.store.tx(() => {
        this.store.db
          .prepare('UPDATE scheduled_tasks SET nextRunAt=?, updatedAt=? WHERE id=?')
          .run(nextRunAt, now, sched.id);
      });
    }
    this.#rearmTimer();
  }
}
