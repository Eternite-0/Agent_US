import { z } from 'zod';
import { Fault } from './store.js';
import { manageMemory } from './refinement.js';
const live = ['running', 'reviewing', 'planning'];
export function control(db, key, action, version) {
  return db.tx(() => {
    const t = db.get('tasks', key);
    if (t.version !== version) throw new Fault('STALE_VERSION');
    if (action === 'retry') {
      if (t.status !== 'failed') throw new Fault('INVALID_TRANSITION');
      // Keep all previous attempts and their evidence. Retry only incomplete work.
      const jobs = db.db
        .prepare("SELECT * FROM jobs WHERE taskId=? AND status='failed'")
        .all(key);
      for (const j of jobs)
        db.db
          .prepare(
            "UPDATE jobs SET status='pending',fence=NULL,attempts=0 WHERE id=?",
          )
          .run(j.id);
      const status = t.plan
        ? jobs.some((j) => j.kind === 'work')
          ? 'running'
          : 'reviewing'
        : 'planning';
      if (!jobs.length) db.enqueue('review', key);
      return db.update('tasks', t, { status });
    }
    if (action === 'resume') {
      if (t.status !== 'paused') throw new Fault('INVALID_TRANSITION');
      return db.update('tasks', t, { status: t.previousStatus });
    }
    if (
      !live.includes(t.status) &&
      !(action === 'cancel' && t.status === 'paused')
    )
      throw new Fault('INVALID_TRANSITION');
    const status = action === 'pause' ? 'paused' : 'cancelled';
    for (const w of db
      .list('workers', { taskId: key, limit: 500 })
      .filter((w) => w.status === 'running'))
      db.update('workers', w, { status: 'interrupted' });
    for (const s of db
      .list('sessions', { taskId: key, limit: 500 })
      .filter((s) => s.status === 'running'))
      db.update('sessions', s, { status: 'interrupted' });
    for (const a of db
      .list('approvals', { taskId: key, limit: 2000 })
      .filter((a) => ['pending', 'approve'].includes(a.status))) {
      if (status === 'paused' && (a.parked || a.kind === 'reconciliation'))
        continue;
      db.update('approvals', a, { status: 'revoked' });
    }
    db.db
      .prepare(
        "UPDATE jobs SET status=?, fence=NULL,attempts=MAX(0,attempts-1) WHERE taskId=? AND status='active'",
      )
      .run(status === 'paused' ? 'pending' : 'cancelled', key);
    if (status === 'cancelled') {
      db.db
        .prepare(
          "UPDATE jobs SET status='cancelled', fence=NULL WHERE taskId=? AND status IN ('pending','parked','reconciling')",
        )
        .run(key);
    }
    return db.update('tasks', t, { status, previousStatus: t.status });
  });
}
const uuid = z.uuid();
const cursor = z.coerce
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export function publicRoutes(app, db, providers) {
  const base = '/api/v1';
  const streams = new Set();
  app.addHook('preClose', async () => {
    for (const res of streams) res.end();
  });
  app.get(base + '/providers/health', async () => ({
    routerReady: providers.models.length > 0,
    providers: providers.list(),
  }));
  app.get(base + '/integrity', async (req) => {
    const q = z
      .strictObject({
        full: z.enum(['true', 'false']).optional(),
      })
      .parse(req.query);
    return db.verifyIntegrity({ full: q.full === 'true' });
  });
  app.get(base + '/models', async () => providers.models);
  app.get(base + '/providers', async () => providers.list());
  app.get(base + '/router/:id', async (req) => {
    const t = db.get('tasks', uuid.parse(req.params.id));
    return {
      taskId: t.id,
      status: t.status,
      plan: t.plan ?? null,
      verdict: t.verdict ?? null,
    };
  });
  for (const action of ['cancel', 'pause', 'resume', 'retry'])
    app.post(base + `/tasks/:id/${action}`, async (req) =>
      control(
        db,
        uuid.parse(req.params.id),
        action,
        z.strictObject({ version: z.number().int().positive() }).parse(req.body)
          .version,
      ),
    );
  for (const action of ['renew', 'withdraw', 'pin'])
    app.post(base + `/memory/:id/${action}`, async (req) =>
      manageMemory(db, uuid.parse(req.params.id), action, {
        version: z
          .strictObject({ version: z.number().int().positive() })
          .parse(req.body).version,
      }),
    );
  app.get(base + '/sessions/:id/history', async (req) => {
    const key = uuid.parse(req.params.id);
    db.get('sessions', key);
    const { after } = z
      .strictObject({ after: cursor.default(0) })
      .parse(req.query);
    return db.db
      .prepare(
        "SELECT rowid AS cursor,body FROM records WHERE kind='history' AND json_extract(body,'$.sessionId')=? AND rowid>? ORDER BY rowid LIMIT 100",
      )
      .all(key, after)
      .map((r) => ({ cursor: r.cursor, ...JSON.parse(r.body) }));
  });
  app.get(base + '/events', async (req, reply) => {
    const q = z
      .strictObject({
        taskId: uuid.optional(),
        projectId: uuid.optional(),
        after: cursor.optional(),
      })
      .parse(req.query);
    let after = cursor.parse(q.after ?? req.headers['last-event-id'] ?? 0);
    if (!req.headers.accept?.includes('text/event-stream'))
      return db.events(after, q.taskId ?? null, q.projectId ?? null);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    streams.add(res);
    let last = Date.now();
    const send = () => {
      if (res.destroyed || res.writableNeedDrain) return;
      for (const ev of db.events(
        after,
        q.taskId ?? null,
        q.projectId ?? null,
      )) {
        after = ev.seq;
        last = Date.now();
        if (
          !res.write(
            `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`,
          )
        )
          break;
      }
      if (Date.now() - last > 15000) {
        res.write(': heartbeat\n\n');
        last = Date.now();
      }
    };
    const timer = setInterval(send, 200);
    res.on('close', () => {
      clearInterval(timer);
      streams.delete(res);
    });
    send();
  });
}
