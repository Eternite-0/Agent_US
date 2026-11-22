import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { api } from '../src/api.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { Store } from '../src/store.js';
import { rmDirSafe } from './fixtures.js';

const createRuntime = (dir, auth) => {
  const store = new Store(join(dir, 'chat.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  const direct = new DirectAgentRuntime(store, pool, { defaultWorkspace: dir });
  const app = api(store, auth, { models: [], list: () => [] }, { pool, directAgent: direct });
  return {
    store,
    direct,
    async request(method, url, payload, status = 200) {
      const res = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${auth}` } });
      assert.equal(res.statusCode, status, res.payload);
      return res.json();
    },
    async close() {
      try {
        await app.close();
      } finally {
        try { await direct.close(); } finally { store.close(); }
      }
    },
  };
};

test('session archive is idempotent, filterable, reversible, and persists across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-chat-archive-'));
  const auth = randomUUID();
  let runtime = createRuntime(dir, auth);
  try {
    const create = (id, title) => runtime.request('POST', '/v1/sessions', { id, title });
    const target = await create('archive-me', 'Notes about 零售');
    await create('keep-me', 'Keep in sidebar');
    await create('archive-other', 'Other notes');
    assert.equal(target.archivedAt, null);
    await runtime.request('PATCH', '/v1/sessions/archive-me', { archived: 'true' }, 400);
    const archived = await runtime.request('PATCH', '/v1/sessions/archive-me', { archived: true });
    assert.ok(Number.isSafeInteger(archived.archivedAt));
    assert.equal(archived.state, target.state);
    assert.equal(archived.updatedAt, target.updatedAt);
    const duplicate = await runtime.request('PATCH', '/v1/sessions/archive-me', { archived: true });
    assert.equal(duplicate.archivedAt, archived.archivedAt);
    await runtime.request('PATCH', '/v1/sessions/archive-other', { archived: true });

    await runtime.close();
    runtime = null;
    runtime = createRuntime(dir, auth);
    const list = async (query) => (await runtime.request('GET', `/v1/sessions${query}`)).items.map((item) => item.id);
    assert.deepEqual(await list('?archived=false'), ['keep-me']);
    assert.deepEqual((await list('')).sort(), ['archive-me', 'archive-other', 'keep-me']);
    assert.deepEqual(await list(`?archived=true&search=${encodeURIComponent('零售')}`), ['archive-me']);
    const pageOne = await list('?archived=true&limit=1');
    const pageTwo = await list('?archived=true&limit=1&offset=1');
    assert.deepEqual([...pageOne, ...pageTwo].sort(), ['archive-me', 'archive-other']);
    assert.equal((await runtime.request('GET', '/v1/sessions/archive-me')).archivedAt, archived.archivedAt);
    await runtime.request('PATCH', '/v1/sessions/archive-me', { title: 'Updated archived title' });
    const restored = await runtime.request('PATCH', '/v1/sessions/archive-me', { archived: false });
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.title, 'Updated archived title');
    assert.deepEqual(await list('?archived=true'), ['archive-other']);
    assert.deepEqual((await list('?archived=false')).sort(), ['archive-me', 'keep-me']);
  } finally {
    try { await runtime?.close(); } finally { rmDirSafe(dir); }
  }
});

test('chat body search finds archived top-level chat messages without including internal records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-chat-search-'));
  const runtime = createRuntime(dir, randomUUID());
  try {
    runtime.direct.createSession({ id: 'regular', title: 'Customer notes' });
    runtime.direct.createSession({ id: 'child', parentSessionId: 'regular' });
    runtime.direct.createSession({ id: 'synthetic', trafficSource: 'evaluation', isSynthetic: true });
    const insert = runtime.store.db.prepare('INSERT INTO direct_messages(sessionId, role, content, createdAt) VALUES (?, ?, ?, ?)');
    insert.run('regular', 'assistant', 'historyneedle in an archived chat', Date.now());
    insert.run('regular', 'tool', 'historyneedle internal tool result', Date.now());
    insert.run('child', 'assistant', 'historyneedle internal child output', Date.now());
    insert.run('synthetic', 'assistant', 'historyneedle benchmark output', Date.now());
    const { archivedAt } = await runtime.request('PATCH', '/v1/sessions/regular', { archived: true });
    const visible = await runtime.request('GET', '/v1/history/search?q=historyneedle&scope=chats');
    assert.equal(visible.items.length, 1);
    assert.equal(visible.items[0].sessionId, 'regular');
    assert.equal(visible.items[0].archivedAt, archivedAt);
    assert.equal(visible.items[0].role, 'assistant');
    assert.deepEqual((await runtime.request('GET', '/v1/sessions?scope=chats')).items.map((item) => item.id), ['regular']);
    assert.ok(visible.items[0].snippet.includes('historyneedle'));
    assert.equal((await runtime.request('GET', '/v1/history/search?q=historyneedle')).items.length, 4);
    insert.run('regular', 'user', '项目交接工作已完成。', Date.now());
    const cjk = await runtime.request('GET', `/v1/history/search?scope=chats&q=${encodeURIComponent('交接')}`);
    assert.equal(cjk.items.length, 1);
    assert.ok(cjk.items[0].snippet.includes('交接'));
    const literal = await runtime.request('GET', '/v1/history/search?scope=chats&q=%25');
    assert.deepEqual(literal.items, []);
  } finally {
    try { await runtime.close(); } finally { rmDirSafe(dir); }
  }
});

test('workspace mention results are scoped to the session and exclude protected entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-chat-mentions-'));
  const runtime = createRuntime(dir, randomUUID());
  try {
    const project = join(dir, 'project');
    for (const name of ['docs', 'upstream', 'backend/var', '.github/workflows']) {
      mkdirSync(join(project, name), { recursive: true });
    }
    for (const name of ['docs/Project Notes.md', 'upstream/notes.md', 'backend/var/notes.md', '.env.notes', '.github/workflows/check.yml']) {
      writeFileSync(join(project, name), 'test fixture');
    }
    runtime.direct.createSession({ id: 'scoped', workspaceRoot: project });
    const find = async (query) => (await runtime.request('GET', `/v1/workspace/files?sessionId=scoped&q=${encodeURIComponent(query)}`)).items;
    assert.deepEqual(await find('NOTES'), ['docs/Project Notes.md']);
    assert.deepEqual(await find('docs\\project'), ['docs/Project Notes.md']);
    assert.deepEqual(await find('check'), ['.github/workflows/check.yml']);
    assert.deepEqual(await find('../'), []);
    await runtime.request('GET', '/v1/workspace/files?sessionId=missing', undefined, 404);
  } finally {
    try { await runtime.close(); } finally { rmDirSafe(dir); }
  }
});
