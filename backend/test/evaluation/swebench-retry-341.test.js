import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, describe } from 'node:test';
import { InferenceEngine } from '../../src/kernel/inference.js';
import { AccountPool, PoolLlmAdapter } from '../../src/pool.js';
import { Store } from '../../src/store.js';

const tempDirs = [];

function makeTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});

async function startOpenAiMockServer(handler) {
  const server = createServer((req, res) => {
    req.resume();
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function sendOpenAiSuccess(res, content = 'recovered-ok') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  };
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
  res.end('data: [DONE]\n\n');
}

function createSingleAccountHarness(endpoint) {
  const dir = makeTmp('swe-retry-341-');
  const store = new Store(':memory:');
  const pool = new AccountPool(store, { root: dir });
  const account = pool.createAccount({
    preset: 'openai',
    label: 'Single Benchmark Account',
    priority: 10,
    endpoint,
    credential: 'sk-test-341',
    models: ['gpt-test'],
  });
  const adapter = new PoolLlmAdapter(pool);
  return { store, pool, account, adapter };
}

describe('Single-Account Benchmark Exponential Backoff (3.4.1)', () => {
  test('Test A: single-account pool recovers from 2 consecutive HTTP 502/429 errors in benchmark mode and clears cooldown', async (t) => {
    let requests = 0;
    const srv = await startOpenAiMockServer((_req, res) => {
      requests++;
      if (requests === 1) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Bad Gateway' } }));
        return;
      }
      if (requests === 2) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Too Many Requests' } }));
        return;
      }
      sendOpenAiSuccess(res, 'recovered-on-attempt-3');
    });
    const { store, pool, account, adapter } = createSingleAccountHarness(srv.baseUrl);
    t.after(async () => {
      await srv.close();
      store.close();
    });

    const failoverEvents = [];
    const engine = new InferenceEngine(adapter, {
      pool,
      trafficSource: 'benchmark',
      benchmarkRetryBaseMs: 5,
    });

    const result = await engine.streamStep({
      provider: 'pool',
      model: 'gpt-test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      onRouteFailover: (ev) => failoverEvents.push(ev),
    });

    assert.equal(requests, 3);
    assert.equal(result.text, 'recovered-on-attempt-3');
    assert.equal(result.route?.accountId, account.id);
    assert.equal(failoverEvents.length, 2);
    assert.equal(failoverEvents[0].statusCode, 502);
    assert.equal(failoverEvents[1].statusCode, 429);

    const accAfter = pool.getAccount(account.id);
    assert.equal(accAfter.status, 'healthy');
    assert.equal(Number(accAfter.cooldownUntil), 0);
  });

  test('Test B: non-benchmark regression guard fast-fails after 1 attempt when exhausted: true', async (t) => {
    let requests = 0;
    const srv = await startOpenAiMockServer((_req, res) => {
      requests++;
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Bad Gateway' } }));
    });
    const { store, pool, account, adapter } = createSingleAccountHarness(srv.baseUrl);
    t.after(async () => {
      await srv.close();
      store.close();
    });

    const engine = new InferenceEngine(adapter, {
      pool,
      retryDelayMs: 25,
      benchmarkRetryBaseMs: 5,
    });

    await assert.rejects(
      () =>
        engine.streamStep({
          provider: 'pool',
          model: 'gpt-test',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        }),
      (err) =>
        err.code === 'INFERENCE_STREAM_FAILED' &&
        err.cause?.code === 'PROVIDER_UNAVAILABLE' &&
        err.cause?.detail?.exhausted === true,
    );

    assert.equal(requests, 1);
    assert.equal(pool.getAccount(account.id).status, 'cooldown');
  });

  test('Test C: HTTP 401 auth error in benchmark mode fast-fails on attempt 1 and clearTransientCooldowns preserves unhealthy/disabled accounts', async (t) => {
    let requests = 0;
    const srv = await startOpenAiMockServer((_req, res) => {
      requests++;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    });
    const { store, pool, account, adapter } = createSingleAccountHarness(srv.baseUrl);
    const disabledCooldown = pool.createAccount({
      preset: 'openai',
      label: 'Disabled Cooling',
      priority: 50,
      enabled: false,
      endpoint: srv.baseUrl,
      credential: 'sk-disabled',
      models: ['gpt-test'],
    });
    store.db
      .prepare("UPDATE provider_accounts SET status='cooldown', cooldownUntil=? WHERE id=?")
      .run(Date.now() + 60_000, disabledCooldown.id);

    t.after(async () => {
      await srv.close();
      store.close();
    });

    const engine = new InferenceEngine(adapter, {
      pool,
      trafficSource: 'benchmark',
      benchmarkRetryBaseMs: 5,
    });

    await assert.rejects(
      () =>
        engine.streamStep({
          provider: 'pool',
          model: 'gpt-test',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        }),
      (err) =>
        err.code === 'INFERENCE_STREAM_FAILED' &&
        err.cause?.code === 'PROVIDER_UNAVAILABLE' &&
        err.cause?.detail?.statusCode === 401,
    );

    assert.equal(requests, 1);
    assert.equal(pool.getAccount(account.id).status, 'unhealthy');

    // Even if an unhealthy account has a non-zero cooldownUntil, clearTransientCooldowns must never clear it or disabled accounts
    const futureCooldown = Date.now() + 60_000;
    store.db
      .prepare('UPDATE provider_accounts SET cooldownUntil=? WHERE id=?')
      .run(futureCooldown, account.id);
    pool.clearTransientCooldowns(['legacy:openai', account.id, disabledCooldown.id]);

    const rawUnhealthy = pool.getAccountRaw(account.id);
    assert.equal(rawUnhealthy.status, 'unhealthy');
    assert.equal(Number(rawUnhealthy.cooldownUntil), futureCooldown);
    assert.equal(pool.getAccount(disabledCooldown.id).status, 'cooldown');
  });

  test('Test D: initial excludeAccountIds remains excluded across transient retry cycles', async (t) => {
    let excludedHits = 0;
    let activeHits = 0;
    const srv = await startOpenAiMockServer((req, res) => {
      if (req.url.startsWith('/excluded/v1')) {
        excludedHits++;
        sendOpenAiSuccess(res, 'should-never-hit-excluded');
        return;
      }
      if (req.url.startsWith('/active/v1')) {
        activeHits++;
        if (activeHits === 1) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Service Unavailable' } }));
          return;
        }
        if (activeHits === 2) {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Rate limited' } }));
          return;
        }
        sendOpenAiSuccess(res, 'active-recovered');
        return;
      }
      res.writeHead(404).end();
    });

    const dir = makeTmp('swe-retry-excl-');
    const store = new Store(':memory:');
    const pool = new AccountPool(store, { root: dir });
    const basePort = new URL(srv.baseUrl).port;
    const excludedAcc = pool.createAccount({
      preset: 'openai',
      label: 'Excluded Primary',
      priority: 10,
      endpoint: `http://127.0.0.1:${basePort}/excluded/v1`,
      credential: 'sk-excl',
      models: ['gpt-test'],
    });
    const activeAcc = pool.createAccount({
      preset: 'openai',
      label: 'Active Secondary',
      priority: 20,
      endpoint: `http://127.0.0.1:${basePort}/active/v1`,
      credential: 'sk-act',
      models: ['gpt-test'],
    });
    const adapter = new PoolLlmAdapter(pool);

    t.after(async () => {
      await srv.close();
      store.close();
    });

    const engine = new InferenceEngine(adapter, { pool });
    const result = await engine.streamStep({
      provider: 'pool',
      model: 'gpt-test',
      trafficSource: 'benchmark',
      benchmarkRetryBaseMs: 5,
      excludeAccountIds: [excludedAcc.id],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });

    assert.equal(excludedHits, 0);
    assert.equal(activeHits, 3);
    assert.equal(result.text, 'active-recovered');
    assert.equal(result.route?.accountId, activeAcc.id);
    assert.equal(pool.getAccount(activeAcc.id).status, 'healthy');
    assert.equal(Number(pool.getAccount(activeAcc.id).cooldownUntil), 0);
  });

  test('hasTransientCooldownRoutes detects pool cooldowns while ignoring healthy/unhealthy routes', () => {
    const dir = makeTmp('swe-retry-has-cd-');
    const store = new Store(':memory:');
    const pool = new AccountPool(store, { root: dir });
    try {
      const acc = pool.createAccount({
        preset: 'openai',
        label: 'Test Acc',
        priority: 10,
        endpoint: 'http://127.0.0.1:1/v1',
        credential: 'sk-1',
        models: ['gpt-test'],
      });
      assert.equal(pool.hasTransientCooldownRoutes('gpt-test'), false);

      pool.markRouteFailure(
        { source: 'pool', accountId: acc.id },
        Object.assign(new Error('502 Bad Gateway'), { status: 502 }),
      );
      assert.equal(pool.hasTransientCooldownRoutes('gpt-test'), true);
      assert.equal(
        pool.hasTransientCooldownRoutes('gpt-test', { excludeAccountIds: [acc.id] }),
        false,
      );

      pool.clearTransientCooldowns([acc.id]);
      assert.equal(pool.hasTransientCooldownRoutes('gpt-test'), false);
    } finally {
      store.close();
    }
  });
});
