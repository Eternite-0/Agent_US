import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  EXTERNAL_SWEBENCH_ARMS,
  SweBenchMeteringProxy,
  convertResponsesRequestToChatCompletions,
  createTestbedShimBinDir,
  deriveUpstreamEndpoints,
  isExternalSweBenchArm,
  rewriteHostArgsForContainer,
  runExternalSweBenchArm,
  runMiniSweAgentCommand,
  sanitizeResponsesBodyForTargetModel,
  summarizeCliFailureOutput,
  validateShimGitArgs,
} from '../../src/evaluation/swebench-external-agents.js';
import {
  VALID_SWEBENCH_ARMS,
  parseSweBenchCliArgs,
  runSweBenchBenchmark,
} from '../../scripts/benchmark-swebench.mjs';

const nativeRealpath = realpathSync.native ?? realpathSync;

function makeRealTempDir(prefix) {
  const raw = mkdtempSync(join(tmpdir(), prefix));
  return nativeRealpath(raw);
}

function runGit(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function createTempPythonRepo(rootDir, bugTag = 'v1') {
  mkdirSync(join(rootDir, 'pkg'), { recursive: true });
  writeFileSync(join(rootDir, 'pkg', '__init__.py'), '', 'utf8');
  writeFileSync(
    join(rootDir, 'pkg', 'calc.py'),
    [
      `def add_capped(a, b, cap=10):`,
      `    # bug-${bugTag}: ignores cap`,
      `    return a + b`,
      '',
    ].join('\n'),
    'utf8',
  );
  runGit(['init', '-q'], rootDir);
  runGit(['config', 'user.email', 'test@agent-us.invalid'], rootDir);
  runGit(['config', 'user.name', 'Test'], rootDir);
  runGit(['config', 'core.autocrlf', 'false'], rootDir);
  runGit(['add', '-A'], rootDir);
  runGit(['commit', '-qm', 'initial buggy baseline'], rootDir);
  const baseCommit = runGit(['rev-parse', 'HEAD'], rootDir).trim();
  return { baseCommit };
}

async function startMockDualUpstreamServer({
  targetModel = 'deepseek-v4.1-flash',
  supportNativeResponses = true,
} = {}) {
  const recordedRequests = [];
  let miniStep = 0;

  const server = createServer(async (req, res) => {
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      body = {};
    }

    recordedRequests.push({
      method: req.method,
      pathname: urlObj.pathname,
      search: urlObj.search,
      headers: { ...req.headers },
      body,
    });

    if (urlObj.pathname === '/v1/messages') {
      if (body.model !== targetModel) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Unknown model ${body.model}` } }));
        return;
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_stream_1',
              type: 'message',
              role: 'assistant',
              model: body.model,
              usage: {
                input_tokens: 120,
                cache_read_input_tokens: 80,
                cache_creation_input_tokens: 40,
                output_tokens: 1,
              },
            },
          })}\n\n`,
        );
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Patched via Claude stream.' },
          })}\n\n`,
        );
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 35 },
          })}\n\n`,
        );
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        res.end();
        return;
      }

      const usage =
        urlObj.searchParams.get('omit_cache_create') === '1'
          ? {
              input_tokens: 100,
              cache_read_input_tokens: 200,
              output_tokens: 25,
            }
          : {
              input_tokens: 100,
              cache_read_input_tokens: 300,
              cache_creation_input_tokens: 100,
              output_tokens: 45,
            };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'Anthropic JSON response ok.' }],
          usage,
        }),
      );
      return;
    }

    if (urlObj.pathname === '/v1/chat/completions') {
      if (body.model !== targetModel) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Unknown model ${body.model}` } }));
        return;
      }
      if (body.reject_stream_options_once && body.stream_options) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unsupported parameter: stream_options' } }));
        return;
      }

      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl_sse_1',
            object: 'chat.completion.chunk',
            model: body.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: 'Patched via ' } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl_sse_1',
            object: 'chat.completion.chunk',
            model: body.model,
            choices: [{ index: 0, delta: { content: 'Codex SSE.' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 60,
              prompt_tokens_details: { cached_tokens: 750 },
            },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Check if called by mini_swe_agent ReAct loop (has `bash` tool)
      const hasBashTool =
        Array.isArray(body.tools) &&
        body.tools.some((t) => t?.function?.name === 'bash');
      if (hasBashTool) {
        miniStep += 1;
        const alreadyHasToolResult =
          Array.isArray(body.messages) && body.messages.some((m) => m?.role === 'tool');
        if (!alreadyHasToolResult) {
          const pyFix = `python3 -c "from pathlib import Path; p = Path('pkg/calc.py'); p.write_text('def add_capped(a, b, cap=10):\\n    return min(cap, a + b)\\n')"`;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: `chat_mini_${miniStep}`,
              object: 'chat.completion',
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: `call_mini_${miniStep}`,
                        type: 'function',
                        function: {
                          name: 'bash',
                          arguments: JSON.stringify({ command: pyFix }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: {
                prompt_tokens: 400,
                completion_tokens: 40,
                prompt_tokens_details: { cached_tokens: 100 },
              },
            }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `chat_mini_done_${miniStep}`,
            object: 'chat.completion',
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\nFixed cap logic.',
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 600,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 450 },
            },
          }),
        );
        return;
      }

      if (body.trigger_tool_call) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl_tc_1',
            object: 'chat.completion',
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Calling shell.',
                  tool_calls: [
                    {
                      id: 'call_resp_1',
                      type: 'function',
                      function: { name: 'shell', arguments: '{"cmd":"pytest -q"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: {
              prompt_tokens: 500,
              completion_tokens: 30,
              prompt_cache_hit_tokens: 400,
            },
          }),
        );
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl_json_1',
          object: 'chat.completion',
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'OpenAI JSON response ok.' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 800,
            completion_tokens: 50,
            prompt_cache_hit_tokens: 600,
          },
        }),
      );
      return;
    }

    if (urlObj.pathname === '/v1/responses') {
      if (!supportNativeResponses) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Responses API not supported' } }));
        return;
      }
      if (body.model !== targetModel) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Unknown model ${body.model}` } }));
        return;
      }
      const nativeUsage = {
        input_tokens: 900,
        output_tokens: 70,
        total_tokens: 970,
        input_tokens_details: { cached_tokens: 650 },
      };
      const nativeResponseObj = {
        id: 'resp_native_1',
        object: 'response',
        status: 'completed',
        model: body.model,
        output: [
          {
            id: 'msg_native_1',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Native Responses API ok.', annotations: [] }],
          },
        ],
        output_text: 'Native Responses API ok.',
        usage: nativeUsage,
      };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(
          `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { ...nativeResponseObj, status: 'in_progress', output: [] } })}\n\n`,
        );
        res.write(
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Native Responses ' })}\n\n`,
        );
        res.write(
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: nativeResponseObj })}\n\n`,
        );
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nativeResponseObj));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Unhandled path ${urlObj.pathname}` } }));
  });

  await new Promise((resolveStart) => server.listen(0, '127.0.0.1', resolveStart));
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    recordedRequests,
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose());
      }),
  };
}

describe('Agent_US 3.3 External Agents Benchmark Framework', () => {
  const tempRoots = [];
  const trackTmp = (dir) => {
    tempRoots.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of tempRoots) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deriveUpstreamEndpoints & arm registry validate all external arms', () => {
    assert.deepEqual([...EXTERNAL_SWEBENCH_ARMS], ['claude_code', 'codex_cli', 'mini_swe_agent']);
    assert.equal(isExternalSweBenchArm('claude_code'), true);
    assert.equal(isExternalSweBenchArm('codex_cli'), true);
    assert.equal(isExternalSweBenchArm('mini_swe_agent'), true);
    assert.equal(isExternalSweBenchArm('full_aci'), false);
    for (const arm of EXTERNAL_SWEBENCH_ARMS) {
      assert.equal(VALID_SWEBENCH_ARMS.has(arm), true);
    }

    const p1 = deriveUpstreamEndpoints('https://api.example.com/v1/');
    assert.equal(p1.openaiChatUrl, 'https://api.example.com/v1/chat/completions');
    assert.equal(p1.openaiResponsesUrl, 'https://api.example.com/v1/responses');
    assert.equal(p1.anthropicMessagesUrl, 'https://api.example.com/v1/messages');

    const p2 = deriveUpstreamEndpoints('https://api.example.com');
    assert.equal(p2.openaiChatUrl, 'https://api.example.com/v1/chat/completions');
    assert.equal(p2.openaiResponsesUrl, 'https://api.example.com/v1/responses');
    assert.equal(p2.anthropicMessagesUrl, 'https://api.example.com/v1/messages');

    const p3 = deriveUpstreamEndpoints('https://api.example.com/v1/chat/completions');
    assert.equal(p3.openaiChatUrl, 'https://api.example.com/v1/chat/completions');
    assert.equal(p3.anthropicMessagesUrl, 'https://api.example.com/v1/messages');

    const p4 = deriveUpstreamEndpoints('https://open.bigmodel.cn/api/paas/v4');
    assert.equal(p4.openaiChatUrl, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');

    const p5 = deriveUpstreamEndpoints('https://api.anthropic.com/v1/messages');
    assert.equal(p5.anthropicMessagesUrl, 'https://api.anthropic.com/v1/messages');
  });

  test('SweBenchMeteringProxy locks model, forwards auth, handles count_tokens, and meters SSE + JSON tokens across both protocols + /v1/responses', async () => {
    const upstream = await startMockDualUpstreamServer({ targetModel: 'deepseek-v4.1-flash' });
    const secretKey = 'sk-super-secret-do-not-leak-12345';
    const proxy = new SweBenchMeteringProxy({
      targetModel: 'deepseek-v4.1-flash',
      apiKey: secretKey,
      endpoint: upstream.baseUrl,
    });

    try {
      await proxy.start();

      // 1. /v1/models & /v1/messages/count_tokens do not hit upstream or increment steps
      const modelsRes = await fetch(`${proxy.openaiBaseUrl}/models`);
      assert.equal(modelsRes.status, 200);
      const modelsJson = await modelsRes.json();
      assert.equal(modelsJson.data[0].id, 'deepseek-v4.1-flash');

      const ctRes = await fetch(`${proxy.anthropicBaseUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3-5-haiku', messages: [{ role: 'user', content: 'hello world' }] }),
      });
      assert.equal(ctRes.status, 200);
      const ctJson = await ctRes.json();
      assert.ok(ctJson.input_tokens >= 1);
      assert.equal(proxy.getMetrics().steps, 0);

      // 2. Anthropic /v1/messages?beta=true (non-streaming, model forced from haiku -> deepseek-v4.1-flash)
      const m1Res = await fetch(`${proxy.anthropicBaseUrl}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'client-placeholder' },
        body: JSON.stringify({ model: 'claude-3-5-haiku-20241022', messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(m1Res.status, 200);
      await m1Res.json();

      // Verify upstream received real key & rewritten model
      const up1 = upstream.recordedRequests.at(-1);
      assert.equal(up1.body.model, 'deepseek-v4.1-flash');
      assert.equal(up1.headers['x-api-key'], secretKey);
      assert.equal(up1.search, '?beta=true');

      // 3. Anthropic /v1/messages streaming SSE
      const m2Res = await fetch(`${proxy.anthropicBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', stream: true, messages: [{ role: 'user', content: 'stream' }] }),
      });
      assert.equal(m2Res.status, 200);
      const m2Text = await m2Res.text();
      assert.match(m2Text, /Patched via Claude stream\./);

      // 4. OpenAI /v1/chat/completions non-streaming & streaming SSE
      const c1Res = await fetch(`${proxy.openaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer client-placeholder' },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(c1Res.status, 200);
      await c1Res.json();

      const c2Res = await fetch(`${proxy.openaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5', stream: true, messages: [{ role: 'user', content: 'sse' }] }),
      });
      assert.equal(c2Res.status, 200);
      const c2Text = await c2Res.text();
      assert.match(c2Text, /Codex SSE\./);
      const upC2 = upstream.recordedRequests.at(-1);
      assert.equal(upC2.body.model, 'deepseek-v4.1-flash');
      assert.equal(upC2.body.stream_options?.include_usage, true);
      assert.equal(upC2.headers.authorization, `Bearer ${secretKey}`);

      // 5. Native OpenAI /v1/responses streaming SSE + non-streaming JSON
      const r1Res = await fetch(`${proxy.openaiBaseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer client-placeholder' },
        body: JSON.stringify({
          model: 'codex-mini-latest',
          instructions: 'Be concise.',
          input: 'Run pytest',
          stream: true,
        }),
      });
      assert.equal(r1Res.status, 200);
      const r1Text = await r1Res.text();
      assert.match(r1Text, /event: response\.completed/);
      assert.match(r1Text, /Native Responses /);
      const upR1 = upstream.recordedRequests.at(-1);
      assert.equal(upR1.pathname, '/v1/responses');
      assert.equal(upR1.body.model, 'deepseek-v4.1-flash');
      assert.equal(upR1.headers.authorization, `Bearer ${secretKey}`);

      const metrics = proxy.getMetrics();
      // Expected totals across 5 steps:
      // m1 (Anthropic JSON):     in = 500,  out = 45, cr = 300, cw = 100, elig = 500
      // m2 (Anthropic SSE):      in = 240,  out = 35, cr = 80,  cw = 40,  elig = 240
      // c1 (OpenAI JSON):        in = 800,  out = 50, cr = 600, cw = 0,   elig = 800
      // c2 (OpenAI SSE):         in = 1000, out = 60, cr = 750, cw = 0,   elig = 1000
      // r1 (Native /responses):  in = 900,  out = 70, cr = 650, cw = 0,   elig = 900
      assert.equal(metrics.steps, 5);
      assert.equal(metrics.inputTokens, 3440);
      assert.equal(metrics.outputTokens, 260);
      assert.equal(metrics.totalTokens, 3700);
      assert.equal(metrics.cacheReadTokens, 2380);
      assert.equal(metrics.cacheWriteTokens, 140);
      assert.equal(metrics.cacheEligibleInputTokens, 3440);
      assert.equal(metrics.cacheStatus, 'available');
      assert.equal(metrics.cacheHitRate, Number((2380 / 3440).toFixed(4)));
      assert.equal(JSON.stringify(metrics).includes(secretKey), false, 'API key must never appear in metrics');

      // 6. Verify 404 automatic fallback from /v1/responses -> /v1/chat/completions
      const legacyUpstream = await startMockDualUpstreamServer({
        targetModel: 'deepseek-v4.1-flash',
        supportNativeResponses: false,
      });
      const fallbackProxy = new SweBenchMeteringProxy({
        targetModel: 'deepseek-v4.1-flash',
        apiKey: secretKey,
        endpoint: legacyUpstream.baseUrl,
      });
      try {
        await fallbackProxy.start();
        const fbRes = await fetch(`${fallbackProxy.openaiBaseUrl}/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5-codex', input: 'fallback test', stream: true }),
        });
        assert.equal(fbRes.status, 200);
        const fbText = await fbRes.text();
        assert.match(fbText, /event: response\.completed/);
        assert.match(fbText, /OpenAI JSON response ok\./);
        const fbMetrics = fallbackProxy.getMetrics();
        assert.equal(fbMetrics.steps, 1);
        assert.equal(fbMetrics.inputTokens, 800);
        assert.equal(fbMetrics.cacheReadTokens, 600);
        assert.equal(fbMetrics.cacheStatus, 'available');
      } finally {
        await fallbackProxy.stop();
        await legacyUpstream.close();
      }

      // 7. Verify gateway omitting cache_creation_input_tokens still computes Anthropic cacheEligibleInputTokens
      proxy.resetMetrics();
      const m3Res = await fetch(`${proxy.anthropicBaseUrl}/v1/messages?omit_cache_create=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3-5-haiku', messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(m3Res.status, 200);
      await m3Res.json();
      const partialMetrics = proxy.getMetrics();
      assert.equal(partialMetrics.inputTokens, 300);
      assert.equal(partialMetrics.cacheReadTokens, 200);
      assert.equal(partialMetrics.cacheEligibleInputTokens, 300);
      assert.equal(partialMetrics.cacheStatus, 'available');
    } finally {
      await proxy.stop();
      await upstream.close();
    }
  });

  test('rewriteHostArgsForContainer & createTestbedShimBinDir bridge Python/pytest to /testbed and enforce git anti-cheat rules', () => {
    const tmpRoot = makeRealTempDir('agent-us-swe-shim-test-');
    trackTmp(tmpRoot);
    const ws = join(tmpRoot, 'repo');
    const subDir = join(ws, 'sub', 'nested');
    mkdirSync(subDir, { recursive: true });
    createTempPythonRepo(ws, 'shim');

    // Pure host->container path rewriting
    const mapped = rewriteHostArgsForContainer(
      [join(ws, 'tests', 'test_a.py'), `--junitxml=${join(ws, 'out.xml')}`, `${ws}2/sibling.py`],
      { workspaceRoot: ws, cwd: subDir },
    );
    assert.equal(mapped.containerCwd, '/testbed/sub/nested');
    assert.equal(mapped.rewrittenArgs[0], '/testbed/tests/test_a.py');
    assert.equal(mapped.rewrittenArgs[1], '--junitxml=/testbed/out.xml');
    assert.equal(mapped.rewrittenArgs[2], `${ws}2/sibling.py`, 'Sibling prefix must not be rewritten');

    // Mock docker executable recording argv into capture file
    const dockerCapturePath = join(tmpRoot, 'docker-capture.json');
    const mockDockerJs = join(tmpRoot, 'mock-docker.mjs');
    writeFileSync(
      mockDockerJs,
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(dockerCapturePath)}, JSON.stringify({ argv: process.argv.slice(2) }), 'utf8');
`,
      'utf8',
    );
    let mockDockerBin;
    if (process.platform === 'win32') {
      mockDockerBin = join(tmpRoot, 'mock-docker.cmd');
      writeFileSync(mockDockerBin, `@echo off\r\n"${process.execPath}" "${mockDockerJs}" %*\r\n`, 'utf8');
    } else {
      mockDockerBin = join(tmpRoot, 'mock-docker.sh');
      writeFileSync(mockDockerBin, `#!/usr/bin/env sh\nexec "${process.execPath}" "${mockDockerJs}" "$@"\n`, { mode: 0o755 });
      chmodSync(mockDockerBin, 0o755);
    }

    const shimInfo = createTestbedShimBinDir({
      workspaceRoot: ws,
      containerId: 'cid_test_999',
      dockerBin: mockDockerBin,
    });

    try {
      const shimmedEnv = {
        ...process.env,
        PATH: `${shimInfo.shimBinDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
      };
      const pyTestCmd = join(
        shimInfo.shimBinDir,
        process.platform === 'win32' ? 'pytest.cmd' : 'pytest',
      );
      const pytestRes = spawnSync(pyTestCmd, [join(ws, 'tests', 'test_bug.py'), '-q'], {
        cwd: subDir,
        env: shimmedEnv,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      assert.equal(pytestRes.status, 0, pytestRes.stderr);
      const captured = JSON.parse(readFileSync(dockerCapturePath, 'utf8'));
      assert.equal(captured.argv[0], 'exec');
      assert.equal(captured.argv[1], '-w');
      assert.equal(captured.argv[2], '/testbed/sub/nested');
      assert.ok(captured.argv.includes('cid_test_999'));
      const cmdIdx = captured.argv.indexOf('pytest');
      assert.ok(cmdIdx > 0);
      assert.equal(captured.argv[cmdIdx + 1], '/testbed/tests/test_bug.py');
      assert.equal(captured.argv[cmdIdx + 2], '-q');

      // Validate anti-cheat git shim (both pure helper & live shim process)
      const gitShim = join(
        shimInfo.shimBinDir,
        process.platform === 'win32' ? 'git.cmd' : 'git',
      );
      for (const blockedArgs of [
        ['log', '-n', '5'],
        ['show', 'HEAD'],
        ['fetch', '--all'],
        ['remote', '-v'],
        ['tag', '-l'],
        ['branch', '-a'],
        ['rev-parse', '--all'],
        ['-C', tmpRoot, 'status'],
      ]) {
        const helperCheck = validateShimGitArgs(blockedArgs, { workspaceRoot: ws, cwd: ws });
        assert.equal(helperCheck.allowed, false, `Expected helper to block git ${blockedArgs.join(' ')}`);

        const liveCheck = spawnSync(gitShim, blockedArgs, {
          cwd: ws,
          env: shimmedEnv,
          encoding: 'utf8',
          shell: process.platform === 'win32',
          windowsHide: true,
        });
        assert.equal(liveCheck.status, 126, `Expected live git shim to block: git ${blockedArgs.join(' ')}`);
        assert.match(liveCheck.stderr, /swebench-anti-cheat/);
      }

      const statusRes = spawnSync(gitShim, ['status', '--short'], {
        cwd: ws,
        env: shimmedEnv,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      assert.equal(statusRes.status, 0, `git status should be allowed: ${statusRes.stderr}`);

      const diffRes = spawnSync(gitShim, ['diff'], {
        cwd: ws,
        env: shimmedEnv,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      assert.equal(diffRes.status, 0, `git diff should be allowed: ${diffRes.stderr}`);
    } finally {
      shimInfo.cleanup();
    }
  });

  test('End-to-end claude_code, codex_cli, mini_swe_agent benchmark + summary.md + LaTeX + merge-shards', async () => {
    const tmpRoot = makeRealTempDir('agent-us-swe-e2e33-');
    trackTmp(tmpRoot);
    const upstream = await startMockDualUpstreamServer({ targetModel: 'deepseek-v4.1-flash' });

    const repoDir = join(tmpRoot, 'source-repo');
    mkdirSync(repoDir, { recursive: true });
    const { baseCommit } = createTempPythonRepo(repoDir, 'e2e');

    const datasetPath = join(tmpRoot, 'dataset.jsonl');
    writeFileSync(
      datasetPath,
      JSON.stringify({
        instance_id: 'acme__calc-01',
        repo: 'acme/calc',
        base_commit: baseCommit,
        problem_statement: 'Fix add_capped in pkg/calc.py to respect cap.',
        hints_text: 'Return min(cap, a + b).',
        workspace_path: repoDir,
        test_cmd: 'python3 -c "from pkg.calc import add_capped; assert add_capped(8, 5, 10) == 10"',
        FAIL_TO_PASS: ['tests/test_calc.py::test_cap'],
        PASS_TO_PASS: ['tests/test_calc.py::test_basic'],
      }) + '\n',
      'utf8',
    );

    const mockClaudeBin = join(tmpRoot, 'mock-claude.mjs');
    writeFileSync(
      mockClaudeBin,
      `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: claude -p [prompt] --dangerously-skip-permissions --max-turns');
  process.exit(0);
}
if (process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !== '1') {
  throw new Error('Missing CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');
}
if (!process.env.ANTHROPIC_BASE_URL) {
  throw new Error('Missing ANTHROPIC_BASE_URL');
}
// Hit count_tokens (should not increment steps)
await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages/count_tokens', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'claude-3-5-haiku-20241022', messages: [{ role: 'user', content: 'hi' }] }),
});
// Hit /v1/messages?beta=true with haiku model name to prove proxy locks model to deepseek-v4.1-flash
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '' },
  body: JSON.stringify({ model: 'claude-3-5-haiku-20241022', stream: true, messages: [{ role: 'user', content: 'fix' }] }),
});
if (!res.ok) throw new Error('Proxy returned ' + res.status + ': ' + await res.text());
await res.text();
writeFileSync(join(process.cwd(), 'pkg', 'calc.py'), 'def add_capped(a, b, cap=10):\\n    return min(cap, a + b)\\n', 'utf8');
`,
      'utf8',
    );

    const mockCodexBin = join(tmpRoot, 'mock-codex.mjs');
    writeFileSync(
      mockCodexBin,
      `import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (!args.includes('exec') || !args.includes('--dangerously-bypass-approvals-and-sandbox') || !args.includes('--skip-git-repo-check')) {
  throw new Error('Unexpected codex args: ' + JSON.stringify(args));
}
if (!process.env.CODEX_HOME.startsWith(homedir()) || !process.env.CODEX_HOME.includes('.agent-us-codex-home-')) {
  throw new Error('CODEX_HOME must live under homedir() rather than /tmp: ' + process.env.CODEX_HOME);
}
const cfgText = readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
if (
  !cfgText.includes('wire_api = "responses"') ||
  cfgText.includes('wire_api = "chat"') ||
  !cfgText.includes('model = "deepseek-v4.1-flash"') ||
  !cfgText.includes('[features]') ||
  !cfgText.includes('multi_agent_v2 = true') ||
  !cfgText.includes('web_search_request = false')
) {
  throw new Error('Invalid CODEX_HOME/config.toml: ' + cfgText);
}
const res = await fetch(process.env.OPENAI_BASE_URL + '/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
  body: JSON.stringify({ model: 'gpt-4o', stream: true, input: 'fix' }),
});
if (!res.ok) throw new Error('Proxy returned ' + res.status + ': ' + await res.text());
await res.text();
writeFileSync(join(process.cwd(), 'pkg', 'calc.py'), 'def add_capped(a, b, cap=10):\\n    return min(cap, a + b)\\n', 'utf8');
`,
      'utf8',
    );

    const outDir = join(tmpRoot, 'e2e-out');
    const secretEnvKey = 'sk-e2e-secret-should-not-leak-987654321';
    const result = await runSweBenchBenchmark(
      {
        dataset: datasetPath,
        arms: ['claude_code', 'codex_cli', 'mini_swe_agent'],
        model: 'deepseek-v4.1-flash',
        useAppPool: false,
        maxSteps: 10,
        turnTimeoutMs: 60_000,
        outputDir: outDir,
        exportLatex: true,
      },
      {
        claudeBin: mockClaudeBin,
        codexBin: mockCodexBin,
        forceBuiltinMiniSweAgent: true,
        log: () => {},
        env: {
          ...process.env,
          SWEBENCH_API_KEY: secretEnvKey,
          SWEBENCH_ENDPOINT: upstream.baseUrl,
        },
      },
    );

    assert.equal(result.instancesCount, 1);
    for (const arm of ['claude_code', 'codex_cli', 'mini_swe_agent']) {
      const predPath = join(outDir, `predictions.${arm}.jsonl`);
      const telePath = join(outDir, `telemetry.${arm}.jsonl`);
      assert.ok(existsSync(predPath), `Missing ${predPath}`);
      assert.ok(existsSync(telePath), `Missing ${telePath}`);

      const pred = JSON.parse(readFileSync(predPath, 'utf8').trim());
      const tele = JSON.parse(readFileSync(telePath, 'utf8').trim());
      assert.equal(pred.instance_id, 'acme__calc-01');
      assert.equal(pred.model_name_or_path, 'deepseek-v4.1-flash');
      assert.match(pred.model_patch, /min\(cap, a \+ b\)/, `${arm} must produce valid git diff patch`);

      assert.equal(tele.status, 'completed', `${arm} telemetry status error: ${tele.error}`);
      assert.equal(tele.aciProfile, arm);
      assert.equal(tele.cacheStatus, 'available');
      assert.ok(tele.steps >= 1);
      assert.ok(tele.inputTokens > 0);
      assert.ok(tele.cacheReadTokens > 0);
      assert.ok(tele.cacheHitRate > 0);
    }

    assert.equal(result.telemetryByArm.claude_code[0].steps, 1);
    assert.equal(result.telemetryByArm.codex_cli[0].steps, 1);
    assert.equal(result.telemetryByArm.mini_swe_agent[0].steps, 2);

    const summaryMd = readFileSync(join(outDir, 'summary.md'), 'utf8');
    const latexTex = readFileSync(join(outDir, 'swebench-paper-table.tex'), 'utf8');
    assert.match(summaryMd, /`claude_code`/);
    assert.match(summaryMd, /`codex_cli`/);
    assert.match(summaryMd, /`mini_swe_agent`/);
    assert.ok(latexTex.includes('\\texttt{claude\\_code}'));
    assert.ok(latexTex.includes('\\texttt{codex\\_cli}'));
    assert.ok(latexTex.includes('\\texttt{mini\\_swe\\_agent}'));
    assert.equal(summaryMd.includes(secretEnvKey), false);
    assert.equal(latexTex.includes(secretEnvKey), false);

    // Also verify external minisweagent CLI fallback when external binary exits non-zero with 0 LLM steps
    const failMiniCli = join(tmpRoot, 'fail-mini.mjs');
    writeFileSync(failMiniCli, 'process.stderr.write("flag drift"); process.exit(2);\n', 'utf8');
    const fallbackRepo = join(tmpRoot, 'fallback-repo');
    mkdirSync(fallbackRepo, { recursive: true });
    createTempPythonRepo(fallbackRepo, 'fb');
    let warnedFallback = false;
    const fbRes = await runExternalSweBenchArm({
      arm: 'mini_swe_agent',
      instance: {
        instance_id: 'acme__fb-01',
        repo: 'acme/fb',
        base_commit: 'HEAD',
        problem_statement: 'Fix cap',
      },
      workspaceRoot: fallbackRepo,
      opts: { model: 'deepseek-v4.1-flash', maxSteps: 5, turnTimeoutMs: 30_000 },
      liveConfig: { apiKey: secretEnvKey, endpoint: upstream.baseUrl, protocol: 'openai', model: 'deepseek-v4.1-flash' },
      runtimeDeps: {
        miniSweAgentBin: failMiniCli,
        env: process.env,
        warn: (msg) => {
          if (String(msg).includes('falling back to built-in')) warnedFallback = true;
        },
      },
    });
    assert.equal(fbRes.status, 'completed');
    assert.equal(warnedFallback, true);
    assert.match(readFileSync(join(fallbackRepo, 'pkg', 'calc.py'), 'utf8'), /min\(cap, a \+ b\)/);

    // Also verify runMiniSweAgentCommand & mini_swe_agent loop catch sandbox policy blocks cleanly (exitCode 126) without throwing
    const fakeBlockedSandbox = {
      containerId: 'cid-mini-recover',
      dockerBin: 'docker',
      exec: async (cmd) => {
        if (/git checkout/.test(cmd)) {
          throw new Error(`Blocked unauthorized or anti-cheat SWE-bench command: ${cmd}`);
        }
        return { exitCode: 0, stdout: 'M pkg/calc.py\n', stderr: '' };
      },
    };
    const blockedCmdRes = await runMiniSweAgentCommand({
      command: 'git checkout main',
      workspaceRoot: fallbackRepo,
      sessionSandbox: fakeBlockedSandbox,
      shimBinDir: tmpRoot,
    });
    assert.equal(blockedCmdRes.exitCode, 126);
    assert.match(blockedCmdRes.output, /Blocked unauthorized or anti-cheat/);

    let recoverTurn = 0;
    const recoverServer = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      recoverTurn += 1;
      if (recoverTurn === 1) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'rec_1',
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'git checkout main' }) } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } },
        }));
        return;
      }
      if (recoverTurn === 2) {
        const lastToolMsg = body.messages.at(-1)?.content ?? '';
        assert.match(lastToolMsg, /returncode: 126/);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'rec_2',
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c2', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'cd /testbed && git status --short' }) } }],
            },
          }],
          usage: { prompt_tokens: 150, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'rec_3',
        choices: [{ message: { role: 'assistant', content: 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\nRecovered.' } }],
        usage: { prompt_tokens: 180, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 120 } },
      }));
    });
    await new Promise((r) => recoverServer.listen(0, '127.0.0.1', r));
    try {
      const recPort = recoverServer.address().port;
      const recRes = await runExternalSweBenchArm({
        arm: 'mini_swe_agent',
        instance: { instance_id: 'acme__rec-01', repo: 'acme/rec', base_commit: 'HEAD', problem_statement: 'Recover cleanly' },
        workspaceRoot: fallbackRepo,
        opts: { model: 'deepseek-v4.1-flash', maxSteps: 5, turnTimeoutMs: 30_000 },
        liveConfig: { apiKey: secretEnvKey, endpoint: `http://127.0.0.1:${recPort}/v1`, protocol: 'openai', model: 'deepseek-v4.1-flash' },
        sessionSandbox: fakeBlockedSandbox,
        containerMode: true,
        runtimeDeps: { forceBuiltinMiniSweAgent: true, env: process.env },
      });
      assert.equal(recRes.status, 'completed');
      assert.equal(recRes.metrics.steps, 3);
      assert.equal(recRes.toolCallsCount, 2);
    } finally {
      recoverServer.closeAllConnections?.();
      await new Promise((r) => recoverServer.close(r));
    }

    // Verify --merge-shards merges raw_full/full_aci alongside external arms
    const shardBuiltin = join(tmpRoot, 'shard-builtin');
    mkdirSync(shardBuiltin, { recursive: true });
    writeFileSync(
      join(shardBuiltin, 'telemetry.raw_full.jsonl'),
      JSON.stringify({
        instance_id: 'acme__calc-01',
        arm: 'raw_full',
        model: 'deepseek-v4.1-flash',
        status: 'completed',
        wallClockMs: 1200,
        steps: 3,
        inputTokens: 1200,
        outputTokens: 90,
        totalTokens: 1290,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        cacheEligibleInputTokens: 1200,
        cacheStatus: 'available',
        cacheHitRate: 0.6667,
        nonEmptyPatch: true,
        resolved: true,
        admissionOriginalTokens: 0,
        admissionInjectedTokens: 0,
        admissionSavedTokens: 0,
        admissionTokenReductionRate: 0,
        epochTransitions: 0,
      }) + '\n',
      'utf8',
    );
    writeFileSync(
      join(shardBuiltin, 'predictions.raw_full.jsonl'),
      JSON.stringify({ instance_id: 'acme__calc-01', model_name_or_path: 'deepseek-v4.1-flash', model_patch: 'diff --git a/pkg/calc.py b/pkg/calc.py\n' }) + '\n',
      'utf8',
    );

    const combinedOut = join(tmpRoot, 'combined-out');
    const mergeRes = await runSweBenchBenchmark({
      dataset: datasetPath,
      mergeShards: [shardBuiltin, outDir],
      arms: ['raw_full', 'claude_code', 'codex_cli', 'mini_swe_agent'],
      model: 'deepseek-v4.1-flash',
      outputDir: combinedOut,
      exportLatex: true,
    });
    assert.deepEqual(mergeRes.arms, ['raw_full', 'claude_code', 'codex_cli', 'mini_swe_agent']);
    const mergedTex = readFileSync(mergeRes.latexPath, 'utf8');
    assert.ok(mergedTex.includes('\\texttt{raw\\_full}'));
    assert.ok(mergedTex.includes('\\texttt{claude\\_code}'));
    assert.ok(mergedTex.includes('\\texttt{codex\\_cli}'));
    assert.ok(mergedTex.includes('\\texttt{mini\\_swe\\_agent}'));

    await upstream.close();
  });

  test('sanitizeResponsesBodyForTargetModel & convertResponsesRequestToChatCompletions normalize Codex v0.172 payloads for non-OpenAI models', () => {
    const rawBody = {
      model: 'gpt-5-codex',
      instructions: 'System prompt',
      prompt_cache_key: 'cache-key-123',
      service_tier: 'priority',
      include: ['reasoning.encrypted_content', 'message.output_text.logprobs'],
      tools: [
        {
          type: 'namespace',
          name: 'workspace',
          tools: [
            {
              type: 'function',
              name: 'read_file',
              description: 'Read a file',
              parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            },
            { type: 'web_search_preview' },
          ],
        },
        { type: 'web_search', search_context_size: 'medium' },
        { type: 'file_search' },
        { type: 'code_interpreter' },
        { type: 'image_generation' },
        { type: 'mcp', server_label: 'docs' },
        { type: 'tool_search' },
        { type: 'custom', name: 'apply_patch', description: 'Apply a unified patch' },
        { type: 'local_shell' },
        { type: 'shell', description: 'Run shell cmd' },
      ],
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Dev rule' }] },
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'item_reference', id: 'ir_1' },
        { type: 'custom_tool_call', call_id: 'call_patch_1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
        { type: 'custom_tool_call_output', call_id: 'call_patch_1', output: 'Success. Updated 1 file.' },
        { type: 'local_shell_call', call_id: 'call_sh_1', action: { type: 'exec', command: ['pytest', '-q'] } },
        { type: 'local_shell_call_output', call_id: 'call_sh_1', output: '1 passed' },
      ],
    };

    const rawSnapshot = JSON.stringify(rawBody);

    // 1. OpenAI-native model preserves OpenAI-only fields & tools
    const openaiOut = sanitizeResponsesBodyForTargetModel(rawBody, 'gpt-5-codex');
    assert.equal(openaiOut.prompt_cache_key, 'cache-key-123');
    assert.equal(openaiOut.service_tier, 'priority');
    assert.deepEqual(openaiOut.include, ['reasoning.encrypted_content', 'message.output_text.logprobs']);
    assert.equal(openaiOut.tools.some((t) => t.type === 'namespace'), true);
    assert.equal(JSON.stringify(rawBody), rawSnapshot, 'sanitize must not mutate input body');

    // 2. Non-OpenAI model strips OpenAI-only fields, flattens namespace, drops hosted tools, normalizes custom/shell/input
    const sanitized = sanitizeResponsesBodyForTargetModel(rawBody, 'deepseek-v4.1-flash');
    assert.equal(sanitized.model, 'deepseek-v4.1-flash');
    assert.equal('prompt_cache_key' in sanitized, false);
    assert.equal('service_tier' in sanitized, false);
    assert.deepEqual(sanitized.include, ['message.output_text.logprobs']);
    assert.deepEqual(
      sanitized.tools.map((t) => [t.type, t.name]),
      [
        ['function', 'read_file'],
        ['function', 'apply_patch'],
        ['function', 'local_shell'],
        ['function', 'shell'],
      ],
    );
    const applyPatchSchema = sanitized.tools.find((t) => t.name === 'apply_patch');
    assert.deepEqual(applyPatchSchema, {
      type: 'function',
      name: 'apply_patch',
      description: 'Apply a unified patch',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
        additionalProperties: false,
      },
    });
    assert.equal(sanitized.input.some((it) => it.type === 'reasoning' || it.type === 'item_reference'), false);
    const fcPatch = sanitized.input.find((it) => it.call_id === 'call_patch_1' && it.type === 'function_call');
    assert.ok(fcPatch);
    assert.equal(JSON.parse(fcPatch.arguments).input, '*** Begin Patch\n*** End Patch');
    const fcoPatch = sanitized.input.find((it) => it.call_id === 'call_patch_1' && it.type === 'function_call_output');
    assert.equal(fcoPatch.output, 'Success. Updated 1 file.');

    // If include only had reasoning.encrypted_content, include is removed cleanly
    const onlyEnc = sanitizeResponsesBodyForTargetModel(
      { model: 'gpt-5', include: ['reasoning.encrypted_content'], input: 'hi' },
      'claude-3-5-sonnet',
    );
    assert.equal('include' in onlyEnc, false);

    // 3. convertResponsesRequestToChatCompletions handles all Codex v0.172 input/tool forms
    const chatPayload = convertResponsesRequestToChatCompletions(rawBody, 'deepseek-v4.1-flash');
    assert.equal(chatPayload.model, 'deepseek-v4.1-flash');
    assert.deepEqual(
      chatPayload.tools.map((t) => t.function.name),
      ['read_file', 'apply_patch', 'local_shell', 'shell'],
    );
    assert.equal(chatPayload.messages[0].role, 'system');
    assert.equal(chatPayload.messages[1].role, 'system');
    assert.equal(chatPayload.messages[1].content, 'Dev rule');
    assert.equal(chatPayload.messages[2].role, 'assistant');
    assert.equal(chatPayload.messages[2].tool_calls[0].function.name, 'apply_patch');
    assert.equal(chatPayload.messages[3].role, 'tool');
    assert.equal(chatPayload.messages[3].tool_call_id, 'call_patch_1');
    assert.equal(chatPayload.messages[4].role, 'assistant');
    assert.equal(chatPayload.messages[4].tool_calls[0].function.name, 'local_shell');
    assert.equal(chatPayload.messages[5].role, 'tool');
    assert.equal(chatPayload.messages[5].tool_call_id, 'call_sh_1');
  });

  test('SweBenchMeteringProxy Codex v0.172 HTTP 400 fallback reconstructs custom/local_shell/function calls with monotonic sequence_number', async () => {
    const upstreamRequests = [];
    let responsesStatusToReturn = 400;

    const upstream = createServer(async (req, res) => {
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      const chunks = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      upstreamRequests.push({ pathname: urlObj.pathname, body });

      if (urlObj.pathname === '/v1/responses') {
        res.writeHead(responsesStatusToReturn, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unsupported Responses API parameter' } }));
        return;
      }

      if (urlObj.pathname === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chat_codex_fb_1',
            object: 'chat.completion',
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Applying patch and running test.',
                  tool_calls: [
                    {
                      id: 'call_custom_1',
                      type: 'function',
                      function: {
                        name: 'apply_patch',
                        arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }),
                      },
                    },
                    {
                      id: 'call_ls_1',
                      type: 'function',
                      function: {
                        name: 'local_shell',
                        arguments: JSON.stringify({ command: ['pytest', '-q'], workdir: '/testbed' }),
                      },
                    },
                    {
                      id: 'call_fn_1',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ path: 'pkg/calc.py' }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 80,
              prompt_tokens_details: { cached_tokens: 900 },
            },
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const port = upstream.address().port;
    const proxy = new SweBenchMeteringProxy({
      targetModel: 'deepseek-v4.1-flash',
      apiKey: 'sk-codex-fb-secret',
      endpoint: `http://127.0.0.1:${port}/v1`,
    });

    try {
      await proxy.start();
      const res = await fetch(`${proxy.openaiBaseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4-codex',
          stream: true,
          prompt_cache_key: 'codex-session-1',
          service_tier: 'auto',
          include: ['reasoning.encrypted_content'],
          tools: [
            {
              type: 'namespace',
              name: 'fs',
              tools: [
                { type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } },
              ],
            },
            { type: 'custom', name: 'apply_patch', description: 'Apply patch' },
            { type: 'local_shell' },
            { type: 'web_search' },
          ],
          input: [
            { type: 'reasoning', id: 'rs_prev', summary: [] },
            { type: 'item_reference', id: 'ir_prev' },
            { type: 'message', role: 'user', content: 'Fix bug' },
          ],
        }),
      });
      assert.equal(res.status, 200);
      const sseText = await res.text();

      // Verify /v1/responses received sanitized body before HTTP 400 fallback
      const respReq = upstreamRequests.find((r) => r.pathname === '/v1/responses');
      assert.ok(respReq);
      assert.equal('prompt_cache_key' in respReq.body, false);
      assert.equal('service_tier' in respReq.body, false);
      assert.equal('include' in respReq.body, false);
      assert.equal(respReq.body.tools.some((t) => t.type === 'namespace' || t.type === 'web_search' || t.type === 'custom'), false);

      // Verify /v1/chat/completions fallback received flattened tools & filtered input
      const chatReq = upstreamRequests.find((r) => r.pathname === '/v1/chat/completions');
      assert.ok(chatReq);
      assert.deepEqual(
        chatReq.body.tools.map((t) => t.function.name),
        ['read_file', 'apply_patch', 'local_shell'],
      );
      assert.deepEqual(chatReq.body.messages, [{ role: 'user', content: 'Fix bug' }]);

      // Parse every SSE event and assert monotonic sequence_number 0..N-1 + standard fields
      const events = sseText
        .trim()
        .split(/\n\n+/)
        .map((block) => {
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          return JSON.parse(dataLine.slice(6));
        });
      assert.ok(events.length >= 10);
      events.forEach((ev, idx) => {
        assert.equal(ev.sequence_number, idx, `Event ${idx} (${ev.type}) sequence_number mismatch`);
      });

      const createdEv = events.find((e) => e.type === 'response.created');
      const completedEv = events.find((e) => e.type === 'response.completed');
      assert.ok(createdEv);
      assert.ok(completedEv);
      for (const rObj of [createdEv.response, completedEv.response]) {
        assert.equal(rObj.parallel_tool_calls, true);
        assert.equal(rObj.tool_choice, 'auto');
        assert.deepEqual(rObj.metadata, {});
        assert.equal(rObj.error, null);
        assert.equal(rObj.incomplete_details, null);
      }

      const output = completedEv.response.output;
      assert.equal(output[0].type, 'message');
      assert.equal(output[1].type, 'custom_tool_call');
      assert.equal(output[1].name, 'apply_patch');
      assert.equal(output[1].input, '*** Begin Patch\n*** End Patch');
      assert.equal(output[2].type, 'local_shell_call');
      assert.deepEqual(output[2].action, {
        type: 'exec',
        command: ['pytest', '-q'],
        working_directory: '/testbed',
      });
      assert.equal(output[3].type, 'function_call');
      assert.equal(output[3].name, 'read_file');
      assert.ok(events.some((e) => e.type === 'response.custom_tool_call_input.delta'));
      assert.ok(events.some((e) => e.type === 'response.custom_tool_call_input.done'));

      // Also verify HTTP 422 / 501 trigger fallback
      for (const code of [422, 501]) {
        responsesStatusToReturn = code;
        const fbRes = await fetch(`${proxy.openaiBaseUrl}/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5', stream: false, input: 'hi' }),
        });
        assert.equal(fbRes.status, 200, `Expected HTTP ${code} on /v1/responses to fall back`);
      }
    } finally {
      await proxy.stop();
      upstream.closeAllConnections?.();
      await new Promise((r) => upstream.close(r));
    }
  });

  test('summarizeCliFailureOutput preserves head + tail on long CLI errors and runCodexCliArm uses it', async () => {
    const longStderr = `HEAD_MARKER:${'a'.repeat(600)}:MIDDLE_NOISE:${'b'.repeat(600)}:TAIL_ERROR_ROOT_CAUSE`;
    const summary = summarizeCliFailureOutput(longStderr, 'STDOUT_TAIL_DETAIL', 900);
    assert.ok(summary.startsWith('HEAD_MARKER:'));
    assert.ok(summary.includes('...[truncated '));
    assert.ok(summary.includes('TAIL_ERROR_ROOT_CAUSE'));
    assert.ok(summary.includes('STDOUT_TAIL_DETAIL'));
    assert.ok(summary.length <= 900);

    const tmpRoot = makeRealTempDir('agent-us-codex-err-');
    trackTmp(tmpRoot);
    const repoDir = join(tmpRoot, 'repo');
    mkdirSync(repoDir, { recursive: true });
    createTempPythonRepo(repoDir, 'codex-err');

    const failCodex = join(tmpRoot, 'fail-codex.mjs');
    writeFileSync(
      failCodex,
      `process.stderr.write(${JSON.stringify(longStderr)}); process.exit(1);\n`,
      'utf8',
    );
    const upstream = await startMockDualUpstreamServer({ targetModel: 'deepseek-v4.1-flash' });
    try {
      const res = await runExternalSweBenchArm({
        arm: 'codex_cli',
        instance: { instance_id: 'acme__cerr-01', repo: 'acme/cerr', base_commit: 'HEAD', problem_statement: 'Fix' },
        workspaceRoot: repoDir,
        opts: { model: 'deepseek-v4.1-flash', turnTimeoutMs: 15_000 },
        liveConfig: { apiKey: 'sk-test', endpoint: upstream.baseUrl, protocol: 'openai', model: 'deepseek-v4.1-flash' },
        runtimeDeps: { codexBin: failCodex, env: process.env },
      });
      assert.equal(res.status, 'failed');
      assert.match(res.error, /^codex_cli exited with code 1: HEAD_MARKER:/);
      assert.match(res.error, /TAIL_ERROR_ROOT_CAUSE/);
    } finally {
      await upstream.close();
    }
  });

  test('runBuiltinMiniSweAgentLoop handles fetch timeout without throwing and retries once when >30s remain', async () => {
    const tmpRoot = makeRealTempDir('agent-us-mini-to-');
    trackTmp(tmpRoot);
    const repoDir = join(tmpRoot, 'repo');
    mkdirSync(repoDir, { recursive: true });
    createTempPythonRepo(repoDir, 'mini-to');

    // 1. Short timeout (<= 30s remaining): fetch times out via AbortSignal.timeout, no retry, returns failed gracefully
    const hangingServer = createServer((_req, _res) => {
      // Intentionally hang longer than turnTimeoutMs
    });
    await new Promise((r) => hangingServer.listen(0, '127.0.0.1', r));
    try {
      const hangPort = hangingServer.address().port;
      const timeoutRes = await runExternalSweBenchArm({
        arm: 'mini_swe_agent',
        instance: { instance_id: 'acme__to-01', repo: 'acme/to', base_commit: 'HEAD', problem_statement: 'Fix' },
        workspaceRoot: repoDir,
        opts: { model: 'deepseek-v4.1-flash', maxSteps: 3, turnTimeoutMs: 400 },
        liveConfig: { apiKey: 'sk-test', endpoint: `http://127.0.0.1:${hangPort}/v1`, protocol: 'openai', model: 'deepseek-v4.1-flash' },
        runtimeDeps: { forceBuiltinMiniSweAgent: true, env: process.env },
      });
      assert.equal(timeoutRes.status, 'failed');
      assert.match(timeoutRes.error, /mini_swe_agent (?:LLM request failed|timed out)/);
    } finally {
      hangingServer.closeAllConnections?.();
      await new Promise((r) => hangingServer.close(r));
    }

    // 2. >30s remaining: transient connection failure on attempt 0 retries once and succeeds; persistent failure returns failed
    let retryServerHits = 0;
    const retryServer = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      retryServerHits += 1;
      if (retryServerHits === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'retry_ok',
          choices: [{ message: { role: 'assistant', content: 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\nRecovered after retry.' } }],
          usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 50 } },
        }),
      );
    });
    await new Promise((r) => retryServer.listen(0, '127.0.0.1', r));
    try {
      const retryPort = retryServer.address().port;
      const retryRes = await runExternalSweBenchArm({
        arm: 'mini_swe_agent',
        instance: { instance_id: 'acme__rt-01', repo: 'acme/rt', base_commit: 'HEAD', problem_statement: 'Fix' },
        workspaceRoot: repoDir,
        opts: { model: 'deepseek-v4.1-flash', maxSteps: 3, turnTimeoutMs: 40_000 },
        liveConfig: { apiKey: 'sk-test', endpoint: `http://127.0.0.1:${retryPort}/v1`, protocol: 'openai', model: 'deepseek-v4.1-flash' },
        runtimeDeps: { forceBuiltinMiniSweAgent: true, env: process.env },
      });
      assert.equal(retryRes.status, 'completed');
      assert.equal(retryServerHits, 2);
    } finally {
      retryServer.closeAllConnections?.();
      await new Promise((r) => retryServer.close(r));
    }
  });
});
