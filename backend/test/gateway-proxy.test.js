import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { Engine } from '../src/engine.js';
import { Providers } from '../src/providers.js';
import { CheckinService } from '../src/checkin.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { api } from '../src/api.js';

function listenServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('Single-process gateway reverse-proxies OpenAI <-> Anthropic (streaming & JSON) and native GitHub Copilot token exchange', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-gw-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
  });
  const token = 'gateway-proxy-test-token-24-chars-ok';
  const app = api(store, token, { models: [], list: () => [] }, {
    pool,
    directAgent: direct,
  });

  // Mock Anthropic upstream
  const anthUpstream = await listenServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.url === '/v1/messages') {
      assert.equal(req.headers['x-api-key'], 'sk-ant-mock-123');
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: { id: 'msg_1', usage: { input_tokens: 12 } },
          })}\n\n`,
        );
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Hello from Claude!' },
          })}\n\n`,
        );
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 5 },
          })}\n\n`,
        );
        res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_json_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'JSON Claude reply' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  // Mock OpenAI upstream (also handles exchanged Copilot requests!)
  let copilotExchangeCalls = 0;
  let copilotSeenBearer = '';
  const oaiUpstream = await listenServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};

    if (req.url === '/copilot_internal/v2/token') {
      copilotExchangeCalls++;
      assert.equal(req.headers.authorization, 'token ghu_test_oauth_abc');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          token: 'tid=short-lived-copilot-bearer',
          expires_at: Math.floor(Date.now() / 1000) + 1800,
          endpoints: { api: oaiUpstream.baseUrl },
        }),
      );
      return;
    }

    if (req.url === '/chat/completions' || req.url === '/v1/chat/completions') {
      if (req.headers['copilot-integration-id']) {
        copilotSeenBearer = String(req.headers.authorization || '');
      }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl_1',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'Stream via OpenAI' }, finish_reason: null }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl_1',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl_json_1',
          object: 'chat.completion',
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'OpenAI JSON reply' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  const prevCopilotUrl = process.env.GITHUB_COPILOT_TOKEN_URL;
  process.env.GITHUB_COPILOT_TOKEN_URL = `${oaiUpstream.baseUrl}/copilot_internal/v2/token`;

  const gatewayServer = await app.listen({ host: '127.0.0.1', port: 0 });
  const gwUrl = gatewayServer;

  try {
    // Register 3 heterogeneous accounts: Anthropic, OpenAI (DeepSeek), and GitHub Copilot
    const anthAcc = pool.createAccount({
      preset: 'anthropic',
      label: 'Direct Claude',
      endpoint: anthUpstream.baseUrl,
      credential: 'sk-ant-mock-123',
      models: ['claude-sonnet-4-5'],
    });
    pool.createAccount({
      preset: 'deepseek',
      label: 'Direct DeepSeek',
      endpoint: `${oaiUpstream.baseUrl}/v1`,
      credential: 'sk-ds-mock-456',
      models: ['deepseek-chat'],
    });
    pool.createAccount({
      preset: 'github-copilot',
      label: 'Native Copilot',
      endpoint: oaiUpstream.baseUrl,
      credential: 'ghu_test_oauth_abc',
      models: ['gpt-4.1'],
    });

    // 1. OpenAI client -> /v1/chat/completions (JSON) -> Anthropic upstream!
    const r1 = await fetch(`${gwUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.equal(j1.object, 'chat.completion');
    assert.equal(j1.choices[0].message.content, 'JSON Claude reply');
    assert.equal(pool.activeConns.get(anthAcc.id) ?? 0, 0);

    // 2. OpenAI client -> /v1/chat/completions (SSE Stream) -> Anthropic upstream!
    const r2 = await fetch(`${gwUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        stream: true,
        messages: [{ role: 'user', content: 'hi stream' }],
      }),
    });
    assert.equal(r2.status, 200);
    const sse2 = await r2.text();
    assert.ok(sse2.includes('Hello from Claude!'));
    assert.ok(sse2.includes('data: [DONE]'));
    assert.equal(pool.activeConns.get(anthAcc.id) ?? 0, 0);

    // 3. Anthropic client (x-api-key header!) -> /v1/messages (JSON) -> OpenAI (DeepSeek) upstream!
    const r3 = await fetch(`${gwUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello via anthropic api' }],
      }),
    });
    assert.equal(r3.status, 200);
    const j3 = await r3.json();
    assert.equal(j3.type, 'message');
    assert.equal(j3.content[0].text, 'OpenAI JSON reply');

    // 4. Anthropic client -> /v1/messages (SSE Stream) -> OpenAI upstream!
    const r4 = await fetch(`${gwUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'stream anthropic' }],
      }),
    });
    assert.equal(r4.status, 200);
    const sse4 = await r4.text();
    assert.ok(sse4.includes('event: message_start'));
    assert.ok(sse4.includes('Stream via OpenAI'));
    assert.ok(sse4.includes('event: message_stop'));

    // 5. Native GitHub Copilot token exchange & in-memory caching (2 requests -> only 1 token exchange!)
    for (let i = 0; i < 2; i++) {
      const rCp = await fetch(`${gwUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: `ping ${i}` }],
        }),
      });
      assert.equal(rCp.status, 200);
      const jCp = await rCp.json();
      assert.equal(jCp.choices[0].message.content, 'OpenAI JSON reply');
    }
    assert.equal(copilotExchangeCalls, 1);
    assert.equal(copilotSeenBearer, 'Bearer tid=short-lived-copilot-bearer');
  } finally {
    if (prevCopilotUrl === undefined) delete process.env.GITHUB_COPILOT_TOKEN_URL;
    else process.env.GITHUB_COPILOT_TOKEN_URL = prevCopilotUrl;
    await direct.close();
    await app.close();
    store.close();
    await anthUpstream.close();
    await oaiUpstream.close();
    rmDirSafe(dir);
  }
});

test('Zero idle polling: Engine, Providers, and CheckinService arm zero background timers when idle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-idle-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  const providers = new Providers({ providers: [], models: [], magpie: false, mcp: {} }, store);
  const checkin = new CheckinService(store, pool, { root: dir });
  const engine = new Engine({
    store,
    root: dir,
    models: [],
    adapter: pool.adapter,
  });

  try {
    await providers.start();
    checkin.start();
    engine.start();

    assert.equal(providers.timer ?? null, null, 'Providers should have no timer when empty');
    assert.equal(checkin.timer, null, 'CheckinService should have no timer when autoCheckin disabled');
    assert.equal(engine.timer ?? null, null, 'Engine should have no 100ms timer when jobs table is empty');

    // Enabling autoCheckin + schedule arms CheckinService timer; disabling clears it
    await checkin.saveSchedule({ label: 'Daily', enabled: true, time: '09:00', providers: [] });
    assert.equal(checkin.timer, null); // autoCheckin still false
    await checkin.setAutoCheckin(true);
    assert.ok(checkin.timer !== null, 'CheckinService timer arms when autoCheckin + schedule enabled');
    await checkin.setAutoCheckin(false);
    assert.equal(checkin.timer, null, 'CheckinService timer clears immediately when disabled');
  } finally {
    checkin.stop();
    await engine.stop();
    await providers.stop();
    store.close();
    rmDirSafe(dir);
  }
});
