import assert from 'node:assert/strict';
import test from 'node:test';
import { cachePercent, cacheRefreshEvent } from '../src/utils/promptCache.ts';
import { LiveBackendClient } from '../src/api/client.ts';

test('unknown, measured zero and near-perfect cache hits stay distinct', () => {
  assert.equal(cachePercent(null), '—');
  assert.equal(cachePercent(0), '0%');
  assert.equal(cachePercent(0.9999), '99.99%');
  assert.equal(cachePercent(1), '100%');
  assert.equal(cacheRefreshEvent('turn/completed'), true);
  assert.equal(cacheRefreshEvent('swarm/run_completed'), true);
  assert.equal(cacheRefreshEvent('assistant/delta'), false);
});

test('the Composer asks the existing metrics route for 24-hour production telemetry', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /\/v1\/observability\/metrics\?/);
    const query = new URL(url).searchParams;
    assert.equal(query.get('windowHours'), '24');
    assert.equal(query.get('view'), 'prompt-cache');
    assert.equal(query.has('includeSynthetic'), false);
    return Response.json({}); // older backends must not display fabricated percentages
  });
  const client = new LiveBackendClient({ baseUrl: 'http://127.0.0.1:8787', token: '' });
  assert.equal(await client.getPromptCacheStats(), null);
});
