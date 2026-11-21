import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';

function startMockUpstream(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function sendSseCompletion(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk1 = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  };
  const chunk2 = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  };
  res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
  res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

test('AccountPool encrypts credentials, syncs models, maps aliases, and fails over on 429', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-pool-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });

  const calls = [];
  const upstream1 = await startMockUpstream((req, res) => {
    calls.push({ server: 1, url: req.url, auth: req.headers.authorization });
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
      return;
    }
    res.writeHead(404).end();
  });

  const upstream2 = await startMockUpstream((req, res) => {
    calls.push({ server: 2, url: req.url, auth: req.headers.authorization });
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      sendSseCompletion(res, 'OK from backup');
      return;
    }
    res.writeHead(404).end();
  });

  try {
    // 1. Add two accounts with encrypted secrets; verify masking
    const acc1 = pool.createAccount({
      preset: 'deepseek',
      label: 'Primary DeepSeek',
      priority: 10,
      endpoint: upstream1.url,
      credential: 'sk-secret-primary-123456',
    });
    const acc2 = pool.createAccount({
      preset: 'deepseek',
      label: 'Backup DeepSeek',
      priority: 20,
      endpoint: upstream2.url,
      credential: 'sk-secret-backup-999999',
    });
    assert.equal(acc1.credential, 'sk-s****3456');
    assert.ok(!JSON.stringify(acc1).includes('sk-secret-primary-123456'));

    // 2. Sync models from both accounts -> live catalog updates immediately with zero restart
    const syncRes = await pool.syncProviderModels('deepseek');
    assert.equal(syncRes.syncedAccounts, 2);
    const catalog = pool.getActiveCatalog();
    assert.ok(catalog.items.some((i) => i.alias === 'deepseek-chat'));
    assert.ok(catalog.data.some((d) => d.id === 'deepseek-reasoner'));

    // 3. Add custom alias mapping
    pool.upsertMapping({
      alias: 'my-fast-coder',
      targetPreset: 'deepseek',
      targetModel: 'deepseek-chat',
      enabled: true,
    });
    const updatedCatalog = pool.getActiveCatalog();
    assert.ok(updatedCatalog.items.some((i) => i.alias === 'my-fast-coder'));

    // 4. Stream through PoolLlmAdapter: acc1 hits 429 -> auto-cooldown -> seamless failover to acc2!
    let text = '';
    for await (const chunk of pool.adapter.stream({
      provider: 'pool',
      model: 'my-fast-coder',
      sessionKey: 'sess-failover',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      maxTokens: 32,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text;
    }
    assert.equal(text, 'OK from backup');

    const refreshed1 = pool.getAccount(acc1.id);
    const refreshed2 = pool.getAccount(acc2.id);
    assert.equal(refreshed1.rateLimited, true);
    assert.equal(refreshed1.status, 'cooldown');
    assert.equal(refreshed2.status, 'healthy');

    // 5. Provider priority ordering & batch clear-cooldown
    pool.setProviderPriorities(['openai', 'deepseek']);
    const cleared = pool.batchAccounts({ ids: [acc1.id], action: 'clear-cooldown' });
    assert.equal(cleared.count, 1);
    assert.equal(pool.getAccount(acc1.id).rateLimited, false);
  } finally {
    await upstream1.close();
    await upstream2.close();
    store.close();
    rmDirSafe(dir);
  }
});
