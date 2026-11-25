import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountPool } from '../../src/pool.js';
import { Store } from '../../src/store.js';
import {
  normalizeSweBenchEndpoint,
  resolveLiveProviderConfig,
} from '../../src/evaluation/swebench-pool.js';

describe('SWE-bench Cloud Endpoint Normalization & AccountPool Routing (3.2c)', () => {
  const tempDirs = [];
  const makeTmp = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normalizeSweBenchEndpoint handles root domains, trailing slashes, and accidental OpenAI/Anthropic suffixes', () => {
    assert.equal(normalizeSweBenchEndpoint(''), '');
    assert.equal(normalizeSweBenchEndpoint('   '), '');
    assert.equal(normalizeSweBenchEndpoint(null), '');

    // OpenAI root domains -> append /v1 (except api.githubcopilot.com)
    assert.equal(normalizeSweBenchEndpoint('https://api.example.com'), 'https://api.example.com/v1');
    assert.equal(normalizeSweBenchEndpoint('https://api.example.com/'), 'https://api.example.com/v1');
    assert.equal(normalizeSweBenchEndpoint('https://api.example.com///'), 'https://api.example.com/v1');
    assert.equal(normalizeSweBenchEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/v1');
    assert.equal(normalizeSweBenchEndpoint('https://api.openai.com/'), 'https://api.openai.com/v1');
    assert.equal(normalizeSweBenchEndpoint('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/v1');
    assert.equal(normalizeSweBenchEndpoint('https://api.githubcopilot.com'), 'https://api.githubcopilot.com');
    assert.equal(normalizeSweBenchEndpoint('https://api.githubcopilot.com/'), 'https://api.githubcopilot.com');

    // OpenAI /v1 and /v1/ preserved
    assert.equal(normalizeSweBenchEndpoint('https://api.example.com/v1'), 'https://api.example.com/v1');
    assert.equal(normalizeSweBenchEndpoint('https://api.example.com/v1/'), 'https://api.example.com/v1');

    // OpenAI accidental full-endpoint suffixes stripped (case-insensitive)
    assert.equal(
      normalizeSweBenchEndpoint('https://api.example.com/chat/completions'),
      'https://api.example.com',
    );
    assert.equal(
      normalizeSweBenchEndpoint('https://api.example.com/v1/chat/completions'),
      'https://api.example.com/v1',
    );
    assert.equal(
      normalizeSweBenchEndpoint('https://api.example.com/v1/CHAT/COMPLETIONS/'),
      'https://api.example.com/v1',
    );
    assert.equal(
      normalizeSweBenchEndpoint('https://api.example.com/v1/completions'),
      'https://api.example.com/v1',
    );
    assert.equal(
      normalizeSweBenchEndpoint('https://api.example.com/v1/responses/'),
      'https://api.example.com/v1',
    );
    assert.equal(
      normalizeSweBenchEndpoint('https://api.example.com/v1/models'),
      'https://api.example.com/v1',
    );

    // Non-standard base paths preserved
    assert.equal(
      normalizeSweBenchEndpoint('https://openrouter.ai/api/v1/chat/completions'),
      'https://openrouter.ai/api/v1',
    );
    assert.equal(
      normalizeSweBenchEndpoint('https://open.bigmodel.cn/api/paas/v4/chat/completions/'),
      'https://open.bigmodel.cn/api/paas/v4',
    );
    assert.equal(
      normalizeSweBenchEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'),
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    assert.equal(
      normalizeSweBenchEndpoint('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'),
      'https://generativelanguage.googleapis.com/v1beta/openai',
    );

    // Anthropic protocol
    assert.equal(
      normalizeSweBenchEndpoint('https://api.anthropic.com', 'anthropic'),
      'https://api.anthropic.com',
    );
    assert.equal(
      normalizeSweBenchEndpoint('https://api.anthropic.com/', 'anthropic'),
      'https://api.anthropic.com',
    );
    assert.equal(
      normalizeSweBenchEndpoint('https://api.anthropic.com/v1/messages', 'anthropic'),
      'https://api.anthropic.com',
    );
    assert.equal(
      normalizeSweBenchEndpoint('https://api.anthropic.com/v1/messages/', 'anthropic'),
      'https://api.anthropic.com',
    );
    assert.equal(
      normalizeSweBenchEndpoint('https://api.anthropic.com/messages', 'anthropic'),
      'https://api.anthropic.com',
    );
    assert.equal(
      normalizeSweBenchEndpoint('https://proxy.example.com/anthropic/v1/messages', 'anthropic'),
      'https://proxy.example.com/anthropic',
    );
    assert.equal(
      normalizeSweBenchEndpoint('https://api.example.com', 'anthropic'),
      'https://api.example.com',
    );
  });

  test('resolveLiveProviderConfig infers protocol before stripping and computes preset after normalization', () => {
    const deepseekBare = resolveLiveProviderConfig(
      { endpoint: 'https://api.deepseek.com', apiKey: 'sk-ds-1' },
      {},
    );
    assert.equal(deepseekBare.endpoint, 'https://api.deepseek.com/v1');
    assert.equal(deepseekBare.protocol, 'openai');
    assert.equal(deepseekBare.preset, 'deepseek');

    const deepseekFull = resolveLiveProviderConfig(
      { endpoint: 'https://api.deepseek.com/v1/chat/completions/', apiKey: 'sk-ds-2' },
      {},
    );
    assert.equal(deepseekFull.endpoint, 'https://api.deepseek.com/v1');
    assert.equal(deepseekFull.protocol, 'openai');
    assert.equal(deepseekFull.preset, 'deepseek');

    const openaiBare = resolveLiveProviderConfig(
      { endpoint: 'https://api.openai.com/', apiKey: 'sk-oa-1', model: 'gpt-4o' },
      {},
    );
    assert.equal(openaiBare.endpoint, 'https://api.openai.com/v1');
    assert.equal(openaiBare.protocol, 'openai');
    assert.equal(openaiBare.preset, 'openai');

    const zhipuFull = resolveLiveProviderConfig(
      {
        endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        apiKey: 'sk-zhipu-1',
        model: 'glm-4.5',
      },
      {},
    );
    assert.equal(zhipuFull.endpoint, 'https://open.bigmodel.cn/api/paas/v4');
    assert.equal(zhipuFull.protocol, 'openai');
    assert.equal(zhipuFull.preset, 'custom-openai');

    // Anthropic inference from /v1/messages suffix even with generic key and non-claude model
    const anthOfficialFull = resolveLiveProviderConfig(
      { endpoint: 'https://api.anthropic.com/v1/messages' },
      { SWEBENCH_API_KEY: 'sk-ant-generic' },
    );
    assert.equal(anthOfficialFull.endpoint, 'https://api.anthropic.com');
    assert.equal(anthOfficialFull.protocol, 'anthropic');
    assert.equal(anthOfficialFull.preset, 'anthropic');

    const anthProxyFull = resolveLiveProviderConfig(
      { endpoint: 'https://proxy.example.com/anthropic/v1/messages/' },
      { SWEBENCH_API_KEY: 'sk-proxy-1' },
    );
    assert.equal(anthProxyFull.endpoint, 'https://proxy.example.com/anthropic');
    assert.equal(anthProxyFull.protocol, 'anthropic');
    assert.equal(anthProxyFull.preset, 'custom-anthropic');

    const anthHostMessages = resolveLiveProviderConfig(
      { endpoint: 'https://my-anthropic-gateway.example.com/messages' },
      { SWEBENCH_API_KEY: 'sk-proxy-2' },
    );
    assert.equal(anthHostMessages.endpoint, 'https://my-anthropic-gateway.example.com');
    assert.equal(anthHostMessages.protocol, 'anthropic');
    assert.equal(anthHostMessages.preset, 'custom-anthropic');

    // Explicit protocol overrides model-based anthropic inference
    const openRouterClaude = resolveLiveProviderConfig(
      {
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        protocol: 'openai',
        model: 'claude-sonnet-4-5',
        apiKey: 'sk-or-1',
      },
      {},
    );
    assert.equal(openRouterClaude.endpoint, 'https://openrouter.ai/api/v1');
    assert.equal(openRouterClaude.protocol, 'openai');
    assert.equal(openRouterClaude.preset, 'custom-openai');
  });

  test('AccountPool + PoolLlmAdapter hits /v1/chat/completions and /v1/messages via resolveLiveProviderConfig outputs', async () => {
    const recordedRequests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const bodyRaw = Buffer.concat(chunks).toString('utf8');
        let parsedBody = null;
        try {
          parsedBody = JSON.parse(bodyRaw);
        } catch {
          parsedBody = null;
        }
        recordedRequests.push({
          method: req.method,
          url: req.url,
          model: parsedBody?.model ?? null,
        });

        if (req.url === '/v1/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: 'ok-openai' }, finish_reason: 'stop' }],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              choices: [],
              usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            })}\n\n`,
          );
          res.end('data: [DONE]\n\n');
          return;
        }

        if (req.url === '/v1/messages') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(
            `event: message_start\ndata: ${JSON.stringify({
              type: 'message_start',
              message: { id: 'msg_1', type: 'message', role: 'assistant', usage: { input_tokens: 8 } },
            })}\n\n`,
          );
          res.write(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            })}\n\n`,
          );
          res.write(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'ok-anthropic' },
            })}\n\n`,
          );
          res.write(
            `event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: 0,
            })}\n\n`,
          );
          res.write(
            `event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 3 },
            })}\n\n`,
          );
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          res.end();
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unexpected path: ${req.url}` }));
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const dir = makeTmp('swe-cloud-url-');
    const store = new Store(join(dir, 'pool.sqlite'));
    const pool = new AccountPool(store, { root: dir });

    try {
      const configs = [
        // Bare root OpenAI endpoint -> normalized to /v1 -> OpenAI SDK hits /v1/chat/completions
        resolveLiveProviderConfig(
          { endpoint: baseUrl, apiKey: 'sk-oa-root', model: 'gpt-4o-mini' },
          {},
        ),
        // Accidental OpenAI full endpoint -> normalized to /v1 -> OpenAI SDK hits /v1/chat/completions
        resolveLiveProviderConfig(
          { endpoint: `${baseUrl}/v1/chat/completions/`, apiKey: 'sk-oa-full', model: 'gpt-4o' },
          {},
        ),
        // Bare root Anthropic endpoint inferred from claude- model -> hits /v1/messages
        resolveLiveProviderConfig(
          { endpoint: baseUrl, apiKey: 'sk-ant-root', model: 'claude-sonnet-4-5' },
          {},
        ),
        // Accidental Anthropic /v1/messages endpoint with non-claude model -> inferred anthropic -> hits /v1/messages
        resolveLiveProviderConfig(
          { endpoint: `${baseUrl}/v1/messages`, apiKey: 'sk-ant-full', model: 'custom-ant-model' },
          {},
        ),
      ];

      for (const [idx, cfg] of configs.entries()) {
        pool.createAccount({
          preset: cfg.preset,
          label: `cloud-test-${idx}`,
          endpoint: cfg.endpoint,
          protocol: cfg.protocol,
          credential: cfg.apiKey,
          models: [cfg.model],
        });
      }

      const streamModelText = async (model) => {
        let out = '';
        for await (const chunk of pool.adapter.stream({
          provider: 'pool',
          model,
          sessionKey: `sess-${model}`,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          maxTokens: 16,
        })) {
          if (chunk.type === 'text-delta') out += chunk.text;
        }
        return out;
      };

      assert.equal(await streamModelText('gpt-4o-mini'), 'ok-openai');
      assert.equal(await streamModelText('gpt-4o'), 'ok-openai');
      assert.equal(await streamModelText('claude-sonnet-4-5'), 'ok-anthropic');
      assert.equal(await streamModelText('custom-ant-model'), 'ok-anthropic');

      assert.deepEqual(recordedRequests, [
        { method: 'POST', url: '/v1/chat/completions', model: 'gpt-4o-mini' },
        { method: 'POST', url: '/v1/chat/completions', model: 'gpt-4o' },
        { method: 'POST', url: '/v1/messages', model: 'claude-sonnet-4-5' },
        { method: 'POST', url: '/v1/messages', model: 'custom-ant-model' },
      ]);
    } finally {
      store.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
