import { Fault, id as uuid } from '../store.js';

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function matchCronField(expr, value) {
  if (!expr || expr === '*') return true;
  for (const part of String(expr).split(',')) {
    if (part.startsWith('*/')) {
      const step = Number(part.slice(2));
      if (step > 0 && value % step === 0) return true;
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && value >= a && value <= b) return true;
    } else if (Number(part) === value) {
      return true;
    }
  }
  return false;
}

export function computeNextRunAt(scheduleKind, scheduleExpr, fromMs = Date.now()) {
  const kind = String(scheduleKind || 'daily').toLowerCase();
  const expr = String(scheduleExpr || '').trim();

  if (kind === 'interval') {
    const m = /^(\d+)\s*(ms|s|m|h)?$/i.exec(expr);
    if (m) {
      const n = Number(m[1]);
      const unit = (m[2] || 's').toLowerCase();
      const mult = unit === 'ms' ? 1 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 1000;
      return fromMs + Math.max(1000, n * mult);
    }
    return fromMs + 3600_000;
  }

  if (kind === 'hourly') {
    const d = new Date(fromMs);
    d.setMinutes(0, 0, 0);
    if (d.getTime() <= fromMs) d.setHours(d.getHours() + 1);
    return d.getTime();
  }

  if (kind === 'daily') {
    const [hh = '9', mm = '0'] = expr.split(':');
    const d = new Date(fromMs);
    d.setHours(Number(hh) || 0, Number(mm) || 0, 0, 0);
    if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  if (kind === 'cron') {
    const fields = expr.split(/\s+/);
    if (fields.length === 5) {
      const probe = new Date(fromMs + 60_000);
      probe.setSeconds(0, 0);
      for (let i = 0; i < 2880; i++) {
        if (
          matchCronField(fields[0], probe.getMinutes()) &&
          matchCronField(fields[1], probe.getHours()) &&
          matchCronField(fields[2], probe.getDate()) &&
          matchCronField(fields[3], probe.getMonth() + 1) &&
          matchCronField(fields[4], probe.getDay())
        ) {
          return probe.getTime();
        }
        probe.setMinutes(probe.getMinutes() + 1);
      }
    }
  }

  // Fallback daily/weekly (+1 day or +7 days)
  return fromMs + (kind === 'weekly' ? 7 * 86400_000 : 86400_000);
}

/**
 * Layer 7 ScheduledTaskRunner backed by SQLite `scheduled_tasks`.
 * Enforces zero-idle-polling: `timer === null` whenever no enabled tasks exist.
 */
export class ScheduledTaskRunner {
  constructor({ store, directAgent }) {
    this.store = store;
    this.directAgent = directAgent;
    this.running = false;
    this.timer = null;
  }

  #hydrate(row) {
    if (!row) return null;
    return {
      ...row,
      enabled: Boolean(row.enabled),
      runHistory: parseJsonSafe(row.runHistoryJson, []),
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#rearmTimer();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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

  create({
    id: customId = null,
    name,
    prompt,
    scheduleKind = 'daily',
    scheduleExpr = '09:00',
    workspaceRoot = null,
    model = null,
    permissionMode = 'auto-safe',
    enabled = true,
  }) {
    const cleanPrompt = String(prompt ?? '').trim();
    if (!cleanPrompt) throw new Fault('EMPTY_PROMPT', 400);
    const id = customId || uuid();
    const now = Date.now();
    const nextRunAt = enabled ? computeNextRunAt(scheduleKind, scheduleExpr, now) : null;

    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO scheduled_tasks(
            id, name, prompt, scheduleKind, scheduleExpr, workspaceRoot, model,
            permissionMode, enabled, nextRunAt, runHistoryJson, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,?,?,?,?,'[]',?,?)`,
        )
        .run(
          id,
          String(name || cleanPrompt.slice(0, 60)),
          cleanPrompt,
          String(scheduleKind || 'daily'),
          String(scheduleExpr || '09:00'),
          workspaceRoot || null,
          model || null,
          permissionMode || 'auto-safe',
          enabled ? 1 : 0,
          nextRunAt,
          now,
          now,
        );
    });
    this.#rearmTimer();
    return this.get(id);
  }

  update(id, patch = {}) {
    const cur = this.get(id);
    const now = Date.now();
    const enabled = patch.enabled !== undefined ? Boolean(patch.enabled) : cur.enabled;
    const scheduleKind = patch.scheduleKind ?? cur.scheduleKind;
    const scheduleExpr = patch.scheduleExpr ?? cur.scheduleExpr;
    const nextRunAt = enabled
      ? patch.nextRunAt ?? computeNextRunAt(scheduleKind, scheduleExpr, now)
      : null;

    this.store.tx(() => {
      this.store.db
        .prepare(
          `UPDATE scheduled_tasks
           SET name=?, prompt=?, scheduleKind=?, scheduleExpr=?, workspaceRoot=?,
               model=?, permissionMode=?, enabled=?, nextRunAt=?, updatedAt=?
           WHERE id=?`,
        )
        .run(
          patch.name !== undefined ? String(patch.name) : cur.name,
          patch.prompt !== undefined ? String(patch.prompt) : cur.prompt,
          scheduleKind,
          scheduleExpr,
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

  async runNow(id, { trigger = 'manual' } = {}) {
    const sched = this.get(id);
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
    const now = Date.now();
    const history = [
      { sessionId: sess.id, turnId: turn.id, at: now, trigger },
      ...(sched.runHistory ?? []),
    ].slice(0, 20);
    const nextRunAt = sched.enabled
      ? computeNextRunAt(sched.scheduleKind, sched.scheduleExpr, now)
      : null;

    this.store.tx(() => {
      this.store.db
        .prepare(
          `UPDATE scheduled_tasks
           SET lastRunAt=?, nextRunAt=?, lastSessionId=?, lastStatus='running',
               runHistoryJson=?, updatedAt=?
           WHERE id=?`,
        )
        .run(now, nextRunAt, sess.id, JSON.stringify(history), now, id);
    });
    this.#rearmTimer();
    return { schedule: this.get(id), session: sess, turn };
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
    if (!next) return; // Zero-idle-polling invariant!

    const delayMs = Math.min(2147483647, Math.max(25, next.nextRunAt - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.#tickDue();
    }, delayMs);
    this.timer.unref?.();
  }

  async #tickDue() {
    if (!this.running || !this.store?.db?.isOpen) return;
    const now = Date.now();
    const due = this.store.db
      .prepare(
        'SELECT id FROM scheduled_tasks WHERE enabled=1 AND nextRunAt IS NOT NULL AND nextRunAt<=?',
      )
      .all(now);
    for (const row of due) {
      await this.runNow(row.id, { trigger: 'schedule' }).catch(() => {});
    }
    this.#rearmTimer();
  }
}
