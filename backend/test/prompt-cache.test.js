import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountPool } from '../src/pool.js';
import { Store } from '../src/store.js';
import { MetricsCollector } from '../src/observability/metrics.js';
import { normalizeProviderUsage, observeProviderUsage, stableTools, openaiPromptCacheKey } from '../src/observability/prompt-cache.js';
import { withTraceContext } from '../src/observability/trace.js';
import { InferenceEngine } from '../src/kernel/inference.js';
import { anthropicJsonToOpenai, openaiJsonToAnthropic } from '../src/gateway-proxy.js';

const normalize = normalizeProviderUsage;
const usageEvent = usage => ({ type: 'usage', usage });

test('normalizes native and compatible usage without manufacturing missing cache counts', () => {
  assert.deepEqual(normalize('anthropic', { input_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 70, output_tokens: 10 }), {
    inputTokens: 200, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 70, cacheEligibleInputTokens: 200,
  });
  assert.equal(normalize('openai', { prompt_tokens: 150, prompt_tokens_details: { cached_tokens: 80 } }).cacheEligibleInputTokens, 150);
  assert.equal(normalize('openai', { prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 10 }).inputTokens, 60);
  assert.equal(normalize('openai', { prompt_tokens: 20 }).cacheEligibleInputTokens, null);
  assert.equal(normalize('openai', { prompt_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } }).cacheReadTokens, 0);
  assert.equal(normalize('anthropic', { input_tokens: 20, cache_read_input_tokens: 0 }).cacheEligibleInputTokens, null);
  const translated = anthropicJsonToOpenai({ usage: { input_tokens: 4, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 3 } });
  assert.equal(translated.usage.prompt_tokens, 19);
  assert.deepEqual(openaiJsonToAnthropic(translated).usage, { input_tokens: 4, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 3 });
  assert.equal(openaiJsonToAnthropic({ usage: { prompt_tokens: 20 } }).usage.cache_read_input_tokens, undefined);
});

test('physical request snapshots persist once, with cancellation and missing usage separated', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const metrics = new MetricsCollector({ store });
  const openai = { inputTokens: 100, outputTokens: 15, cacheReadTokens: 0, cacheEligibleInputTokens: 100 };
  const anth = { inputTokens: 900, outputTokens: 5, cacheReadTokens: 800, cacheWriteTokens: 75, cacheEligibleInputTokens: 900 };
  const controller = new AbortController();
  await withTraceContext({ sessionId: 's', turnId: 't' }, async () => {
    const step = await new InferenceEngine({ stream: () => observeProviderUsage((async function* () {
      yield usageEvent({ ...openai, outputTokens: 2 });
      yield usageEvent(openai);
      yield usageEvent(openai);
    })(), { metrics, provider: 'openai', model: 'a' }) }).streamStep({ model: 'a' });
    assert.equal(step.usage.inputTokens, 100);
    assert.equal(step.usage.outputTokens, 15);
    await assert.rejects(async () => {
      for await (const _ of observeProviderUsage((async function* () {
        yield usageEvent(anth);
        controller.abort();
        controller.signal.throwIfAborted();
      })(), { metrics, provider: 'anthropic', model: 'b', signal: controller.signal })) { /* consume */ }
    }, { name: 'AbortError' });
    await assert.rejects(async () => {
      for await (const _ of observeProviderUsage((async function* () { throw Error('network'); })(),
        { metrics, provider: 'anthropic', model: 'b' })) { /* consume */ }
    }, /network/);
    for await (const _ of observeProviderUsage((async function* () { yield usageEvent({ inputTokens: 30 }); })(),
      { metrics, provider: 'other', model: 'a', cacheTelemetry: 'unsupported', attempt: 2 })) { /* consume */ }
  });
  metrics.record('provider_usage', { isSynthetic: true, detail: { cacheStatus: 'available', cacheReadTokens: 1, cacheEligibleInputTokens: 1 } });
  const { promptCache } = metrics.getProductionMetrics({ view: 'prompt-cache' });
  assert.equal(promptCache.global.hitRate, 0.8);
  assert.equal(promptCache.global.coverage, 0.5);
  assert.equal(promptCache.global.uncachedInputTokens, 200);
  assert.equal(promptCache.global.cacheWriteTokens, 75);
  assert.equal(promptCache.providers.find(p => p.provider === 'openai').hitRate, 0);
  assert.equal(promptCache.models.find(p => p.model === 'a').coverage, 0.5);
  const rows = store.db.prepare("SELECT * FROM runtime_metrics_events WHERE kind='provider_usage' AND isSynthetic=0 ORDER BY rowid").all();
  assert.equal(rows.length, 4);
  assert.ok(rows.every(row => row.sessionId === 's' && row.turnId === 't'));
  assert.deepEqual(rows.map(row => JSON.parse(row.detailJson).outcome), ['completed', 'cancelled', 'interrupted', 'completed']);
  assert.equal(metrics.getProductionMetrics({ view: 'prompt-cache', now: Date.now() + 90_000_000 }).promptCache.global.hitRate, null);
});

test('schema order is deterministic; native OpenAI cache routing keys are isolated by session', () => {
  const a = { name: 'a', parameters: { type: 'object', properties: { z: { type: 'number' }, a: { type: 'string' } } } };
  const b = { name: 'b', parameters: { required: ['z', 'a'], type: 'object' } };
  assert.equal(JSON.stringify(stableTools([a, b])), JSON.stringify(stableTools([b, a])));
  assert.deepEqual(stableTools([b])[0].parameters.required, ['z', 'a']);
  assert.equal(openaiPromptCacheKey('http://localhost/v1', 's'), undefined);
  assert.notEqual(openaiPromptCacheKey('https://api.openai.com/v1', 's'), openaiPromptCacheKey('https://api.openai.com/v1', 't'));
});


test('pool accounts preserve Anthropic partial usage during failover, retry and cancellation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cache-pool-'));
  const store = new Store(':memory:');
  const metrics = new MetricsCollector({ store });
  const pool = new AccountPool(store, { root: dir, metrics });
  let primaryCalls = 0;
  let backupCalls = 0;
  const send = (res, frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`);
  const upstream = createServer((req, res) => {
    req.resume();
    if (req.url === '/primary/v1/messages') {
      primaryCalls++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      send(res, { type: 'message_start', message: { usage: {
        input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 70, cache_creation_input_tokens: 30,
      } } });
      if (primaryCalls === 1) {
        send(res, { type: 'error', error: { type: 'overloaded_error' } });
        res.end();
      }
    } else if (req.url === '/backup/v1/chat/completions') {
      backupCalls++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      send(res, { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 300, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 250 } } });
      res.end('data: [DONE]\n\n');
    } else res.writeHead(404).end();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${upstream.address().port}`;
  const primary = pool.createAccount({ preset: 'workbuddy', protocol: 'anthropic', priority: 10,
    credential: 'test-only', endpoint: `${endpoint}/primary/v1`, models: ['test-model'] });
  const backup = pool.createAccount({ preset: 'workbuddy', protocol: 'openai', priority: 20,
    credential: 'test-only', endpoint: `${endpoint}/backup/v1`, models: ['test-model'] });
  const options = { model: 'test-model', sessionKey: 's', maxTokens: 32,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
  const trace = { sessionId: 's', turnId: 'failover' };
  const result = await withTraceContext(trace, () => new InferenceEngine(pool.adapter).streamStep(options));
  assert.equal(result.text, 'ok');
  assert.equal(result.route.accountId, backup.id);
  assert.equal(result.route.failovers, 1);
  assert.equal(result.usage.inputTokens, 500);
  assert.equal(result.usage.cacheReadTokens, 320);
  assert.equal(result.usage.cacheWriteTokens, 30);
  assert.equal(result.usage.cacheEligibleInputTokens, 500);
  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 1);

  const controller = new AbortController();
  const primaryRoute = pool.resolveRoutes('test-model').find(r => r.accountId === primary.id);
  await assert.rejects(withTraceContext({ ...trace, turnId: 'cancelled' }, async () => {
    for await (const chunk of pool.adapter.streamRoute(primaryRoute, { ...options, signal: controller.signal })) {
      if (chunk.type === 'usage') {
        const row = store.db.prepare("SELECT detailJson FROM runtime_metrics_events WHERE kind='provider_usage' AND turnId='cancelled'").get();
        assert.equal(JSON.parse(row.detailJson).outcome, 'streaming');
        assert.equal(JSON.parse(row.detailJson).cacheWriteTokens, 30);
        controller.abort();
      }
    }
  }), { name: 'AbortError' });

  let attempts = 0;
  const failedAttempt = { inputTokens: 11, cacheReadTokens: 1, cacheEligibleInputTokens: 11 };
  const engine = new InferenceEngine({ stream: () => observeProviderUsage((async function* () {
    if (++attempts === 1) {
      yield usageEvent(failedAttempt);
      throw Object.assign(new Error('upstream timeout'), { status: 503 });
    }
    yield usageEvent({ inputTokens: 13, outputTokens: 2, cacheReadTokens: 0, cacheEligibleInputTokens: 13 });
  })(), { metrics, provider: 'openai', model: 'retry-model' }) }, { retryDelayMs: 50 });
  let retryUsage;
  const retry = await withTraceContext({ ...trace, turnId: 'retry' }, () => engine.streamStep({
    ...options, onRetryBudget: ({ usage }) => { retryUsage = usage; },
  }));
  assert.equal(attempts, 2);
  assert.equal(retryUsage.inputTokens, 11);
  assert.equal(retry.usage.inputTokens, 13);

  const rows = store.db.prepare("SELECT turnId, detailJson FROM runtime_metrics_events WHERE kind='provider_usage' ORDER BY rowid").all();
  assert.deepEqual(rows.map(row => [row.turnId, JSON.parse(row.detailJson).outcome]), [
    ['failover', 'interrupted'], ['failover', 'completed'], ['cancelled', 'cancelled'],
    ['retry', 'interrupted'], ['retry', 'completed'],
  ]);
  assert.equal(JSON.parse(rows[2].detailJson).cacheWriteTokens, 30);
});
