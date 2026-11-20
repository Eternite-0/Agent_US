import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { api } from '../src/api.js';
import {
  canonicalJson,
  LEDGER_INTEGRITY_ALGORITHM,
} from '../src/integrity.js';

test('RFC 8785 JCS canonicalization normalizes key order and numbers deterministically', () => {
  assert.equal(canonicalJson({ b: 1, a: -0, c: [undefined, true, 'x'] }), '{"a":0,"b":1,"c":[null,true,"x"]}');
  assert.equal(
    canonicalJson({ z: { b: 2, a: 1 }, a: 'hi' }),
    canonicalJson({ a: 'hi', z: { a: 1, b: 2 } }),
  );
  assert.throws(() => canonicalJson(Number.NaN));
});

test('SQLite event ledger chains JCS-SHA256 digests and detects payload tampering or tail deletion', () => {
  const store = new Store(':memory:');
  try {
    const p = store.add('projects', { name: 'audit' });
    store.submit({ projectId: p.id, input: 'hello', idempotencyKey: 'k1' });
    const full = store.verifyIntegrity({ full: true });
    assert.equal(full.ok, true);
    assert.equal(full.algorithm, LEDGER_INTEGRITY_ALGORITHM);
    assert.ok(full.lastSeq >= 2);
    assert.equal(full.verifiedThroughSeq, full.lastSeq);
    assert.match(full.headDigest, /^[0-9a-f]{64}$/);

    // Tamper payload of event 1 -> full verification must fail closed.
    store.db
      .prepare("UPDATE events SET payload='{\"id\":\"tampered\"}' WHERE seq=1")
      .run();
    assert.throws(
      () => store.verifyIntegrity({ full: true }),
      (e) => e.code === 'LEDGER_INTEGRITY_FAILED',
    );
  } finally {
    store.close();
  }

  // Tail deletion must be detected by watermark even on fast check.
  const store2 = new Store(':memory:');
  try {
    const p = store2.add('projects', { name: 'tail' });
    store2.event('custom.one', p.id, null, { n: 1 });
    store2.event('custom.two', p.id, null, { n: 2 });
    store2.db.prepare('DELETE FROM events WHERE seq = (SELECT MAX(seq) FROM events)').run();
    assert.throws(
      () => store2.verifyIntegrity({ full: false }),
      (e) => e.code === 'LEDGER_INTEGRITY_FAILED',
    );
  } finally {
    store2.close();
  }
});

test('v1 database with legacy rows migrates cleanly and chains new events from anchor', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-v1-'));
  const dbPath = join(root, 'engine.sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, projectId TEXT, taskId TEXT, version INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE events(seq INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, type TEXT NOT NULL, projectId TEXT, taskId TEXT, payload TEXT NOT NULL);
    CREATE TABLE jobs(id TEXT PRIMARY KEY, taskId TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', fence TEXT, expires INTEGER, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE revisions(id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,version));
    CREATE TABLE submissions(projectId TEXT, key TEXT, taskId TEXT, PRIMARY KEY(projectId,key));
    INSERT INTO events(seq, timestamp, type, projectId, taskId, payload) VALUES (1, 1000, 'legacy.ev', NULL, NULL, '{"ok":true}');
    PRAGMA user_version=1;
  `);
  raw.close();

  const store = new Store(dbPath);
  try {
    store.event('new.anchor', null, null, { step: 2 });
    store.event('new.chain', null, null, { step: 3 });
    const res = store.verifyIntegrity({ full: true });
    assert.equal(res.ok, true);
    assert.equal(res.legacyThroughSeq, 1);
    assert.equal(res.lastSeq, 3);
  } finally {
    store.close();
  }
});

test('GET /api/v1/integrity exposes fast and full ledger verification over REST', async (t) => {
  const store = new Store(':memory:');
  const token = 't'.repeat(32);
  const app = api(store, token);
  t.after(async () => {
    await app.close();
    store.close();
  });
  store.add('projects', { name: 'rest-integrity' });
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/integrity?full=true',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.lastSeq, 1);
  assert.equal(body.verifiedThroughSeq, 1);
});
