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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  EXTERNAL_SWEBENCH_ARMS,
  SweBenchMeteringProxy,
  createTestbedShimBinDir,
  deriveUpstreamEndpoints,
  isExternalSweBenchArm,
  rewriteHostArgsForContainer,
  runExternalSweBenchArm,
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

async function startMockDualUpstreamServer({ targetModel = 'deepseek-v4.1-flash' } = {}) {
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
    assert.equal(p1.anthropicMessagesUrl, 'https://api.example.com/v1/messages');

    const p2 = deriveUpstreamEndpoints('https://api.example.com');
    assert.equal(p2.openaiChatUrl, 'https://api.example.com/v1/chat/completions');
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

      // 5. OpenAI /v1/responses compatibility fallback (SSE with tool call translation)
      const r1Res = await fetch(`${proxy.openaiBaseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'codex-mini-latest',
          instructions: 'Be concise.',
          input: 'Run pytest',
          stream: true,
          trigger_tool_call: false,
        }),
      });
      assert.equal(r1Res.status, 200);
      const r1Text = await r1Res.text();
      assert.match(r1Text, /event: response\.completed/);
      assert.match(r1Text, /OpenAI JSON response ok\./);

      const metrics = proxy.getMetrics();
      // Expected totals across 5 steps:
      // m1 (Anthropic JSON): in = 100 + 300 + 100 = 500, out = 45, cr = 300, cw = 100, elig = 500
      // m2 (Anthropic SSE):  in = 120 + 80 + 40 = 240,  out = 35, cr = 80,  cw = 40,  elig = 240
      // c1 (OpenAI JSON):    in = 800,                  out = 50, cr = 600, cw = 0,   elig = 800
      // c2 (OpenAI SSE):     in = 1000,                 out = 60, cr = 750, cw = 0,   elig = 1000
      // r1 (/responses->chat): in = 800,                out = 50, cr = 600, cw = 0,   elig = 800
      assert.equal(metrics.steps, 5);
      assert.equal(metrics.inputTokens, 3340);
      assert.equal(metrics.outputTokens, 240);
      assert.equal(metrics.totalTokens, 3580);
      assert.equal(metrics.cacheReadTokens, 2330);
      assert.equal(metrics.cacheWriteTokens, 140);
      assert.equal(metrics.cacheEligibleInputTokens, 3340);
      assert.equal(metrics.cacheStatus, 'available');
      assert.equal(metrics.cacheHitRate, Number((2330 / 3340).toFixed(4)));
      assert.equal(JSON.stringify(metrics).includes(secretKey), false, 'API key must never appear in metrics');

      // 6. Verify gateway omitting cache_creation_input_tokens still computes Anthropic cacheEligibleInputTokens
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
import { join } from 'node:path';
const args = process.argv.slice(2);
if (!args.includes('exec') || !args.includes('--dangerously-bypass-approvals-and-sandbox') || !args.includes('--skip-git-repo-check')) {
  throw new Error('Unexpected codex args: ' + JSON.stringify(args));
}
const cfgText = readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
if (!cfgText.includes('wire_api = "chat"') || !cfgText.includes('model = "deepseek-v4.1-flash"')) {
  throw new Error('Invalid CODEX_HOME/config.toml: ' + cfgText);
}
const res = await fetch(process.env.OPENAI_BASE_URL + '/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
  body: JSON.stringify({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'fix' }] }),
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
});
