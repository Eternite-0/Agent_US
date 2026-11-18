import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class Fault extends Error {
  constructor(code, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
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
  constructor(path) {
    this.db = new DatabaseSync(path);
    if (this.db.prepare('PRAGMA user_version').get().user_version > 1) {
      this.db.close();
      throw new Fault('UNSUPPORTED_DATABASE_SCHEMA');
    }
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, projectId TEXT REFERENCES records(id), taskId TEXT REFERENCES records(id), version INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)));
      CREATE INDEX IF NOT EXISTS children ON records(kind, taskId,projectId);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, type TEXT NOT NULL, projectId TEXT, taskId TEXT, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_events ON events(taskId,seq);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES records(id), kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', fence TEXT, expires INTEGER, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TRIGGER IF NOT EXISTS preserve_revision AFTER UPDATE ON records BEGIN INSERT INTO revisions(id,version,body) VALUES(OLD.id,OLD.version,OLD.body); END;
      CREATE TABLE IF NOT EXISTS submissions(projectId TEXT, key TEXT, taskId TEXT REFERENCES records(id), PRIMARY KEY(projectId,key)); PRAGMA user_version=1;`);
  }
  tx(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result instanceof Promise) throw Error('async transaction');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
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
      return this.get(kind, key);
    });
  }
  event(type, projectId, taskId, payload) {
    this.db
      .prepare(
        'INSERT INTO events(timestamp,type,projectId,taskId,payload) VALUES(?,?,?,?,?)',
      )
      .run(Date.now(), type, projectId, taskId, JSON.stringify(payload));
  }
  events(after = 0, task = null, project = null) {
    return this.db
      .prepare(
        'SELECT * FROM events WHERE seq>? AND (? IS NULL OR taskId=?) AND (? IS NULL OR projectId=?) ORDER BY seq LIMIT 100',
      )
      .all(after, task, task, project, project)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  enqueue(kind, taskId, payload = {}) {
    this.db
      .prepare('INSERT INTO jobs(id,taskId,kind,payload) VALUES(?,?,?,?)')
      .run(id(), taskId, kind, JSON.stringify(payload));
  }
  submit({ projectId, input, idempotencyKey, budget = {}, files = {} }) {
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
          JSON.stringify(task.files ?? {}) !== JSON.stringify(files)
        )
          throw new Fault('KEY_REUSED');
        return task;
      }
      const task = this.add(
        'tasks',
        { input, status: 'planning', budget, files, createdAt: Date.now() },
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
