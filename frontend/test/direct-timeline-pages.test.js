import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveBackendClient } from '../src/api/client.ts';

function setup(t, { ignoreCursor = false } = {}) {
  const cursors = { messages: [], events: [] };
  const session = { id: 's1', title: 'Long Direct history', state: 'idle' };
  const pages = {
    messages: Array.from({ length: 430 }, (_, i) => ({ seq: i + 1, role: i % 2 ? 'assistant' : 'user', content: `Message ${i + 1}` })),
    events: Array.from({ length: 654 }, (_, i) => ({ seq: 10 + i * 3, at: i, type: 'turn/started', data: { turnId: `t${i}` } })),
  };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/v1/sessions/s1') return Response.json(session);
    for (const kind of ['messages', 'events']) {
      if (pathname !== `/v1/sessions/s1/${kind}`) continue;
      const after = Number(searchParams.get('after'));
      cursors[kind].push(after);
      return Response.json({ items: pages[kind].filter(item => ignoreCursor || item.seq > after).slice(0, Number(searchParams.get('limit'))) });
    }
    return Response.json({ items: [] });
  });
  return { client: new LiveBackendClient({ mode: 'live', token: '', baseUrl: 'http://127.0.0.1:8787' }), cursors };
}

test('a long command-heavy Direct thread reads all messages and events by cursor', async (t) => {
  const { client, cursors } = setup(t);
  const bundle = await client.loadTaskBundle('s1');
  assert.equal(bundle.histories.s1.length, 430);
  assert.equal(bundle.histories.s1.at(-1).text, 'Message 430');
  assert.equal(bundle.events.length, 654);
  assert.deepEqual(cursors, { messages: [0, 300], events: [0, 907, 1807] });
});

test('a proxy returning the same full timeline page fails instead of truncating silently', async (t) => {
  const { client } = setup(t, { ignoreCursor: true });
  await assert.rejects(client.loadTaskBundle('s1'), /cursor did not advance/);
});
