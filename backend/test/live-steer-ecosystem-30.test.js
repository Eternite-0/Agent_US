import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { InferenceEngine } from '../src/kernel/inference.js';
import { mintNonce } from '../src/envelope.js';
import {
  normalizeDiagnosticFile,
  parseAndCompressDiagnosticsOutput,
} from '../src/patch-and-diagnostics.js';
import { createWorkspaceTools } from '../src/workspace-tools.js';
import { ToolDispatcher } from '../src/tools/dispatcher.js';
import { ToolPermissionPolicy } from '../src/tools/policy.js';
import { UnknownOutcomeReconciler } from '../src/durable/reconciliation.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handlers) {
    super();
    this.handlers = handlers;
    this.calls = [];
  }
  async *stream(options) {
    const idx = this.calls.length;
    this.calls.push({
      model: options.model,
      excludeAccountIds: options.excludeAccountIds ? [...options.excludeAccountIds] : null,
      messages: structuredClone(options.messages),
    });
    const fn = this.handlers[idx] ?? this.handlers.at(-1);
    yield* fn(options, idx);
  }
}

async function waitTurnDone(directAgent, sessionId, turnId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = directAgent.listTurns(sessionId).find((x) => x.id === turnId);
    if (t && ['completed', 'failed', 'cancelled'].includes(t.state)) return t;
    await delay(20);
  }
  throw new Error(`Timed out waiting for turn ${turnId}`);
}

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

function sendSseText(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-standby',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-standby',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 18, completion_tokens: 9, total_tokens: 27 },
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

test('Deliverable 1: normalizeDiagnosticFile preserves Linux root / and strips Windows drive leading / across all OSes', () => {
  // Absolute paths without workspaceRoot (or outside workspaceRoot)
  assert.equal(
    normalizeDiagnosticFile('file:///home/dev/a.ts', null),
    '/home/dev/a.ts',
  );
  assert.equal(
    normalizeDiagnosticFile('file:///C:/a.ts', null),
    'C:/a.ts',
  );
  assert.equal(
    normalizeDiagnosticFile('file://C:/a.ts', null),
    'C:/a.ts',
  );
  assert.equal(
    normalizeDiagnosticFile('file:///D:\\\\work\\\\app\\\\index.ts', null),
    'D:/work/app/index.ts',
  );

  // Relative to Linux-style workspaceRoot
  assert.equal(
    normalizeDiagnosticFile('file:///home/dev/src/app.ts', '/home/dev'),
    'src/app.ts',
  );

  // Stack trace parsing preserves Linux path inside TAP/node-test output
  const parsed = parseAndCompressDiagnosticsOutput(
    [
      '✖ linux path test (2.1ms)',
      "  AssertionError [ERR_ASSERTION]: 'a' === 'b'",
      '      at TestContext.<anonymous> (file:///home/dev/test/sample.test.js:12:5)',
    ].join('\n'),
    { kind: 'test', workspaceRoot: '/home/dev' },
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.failingTests[0].file, 'test/sample.test.js');
  assert.equal(parsed.failingTests[0].line, 12);
  assert.equal(parsed.diagnostics[0].file, 'test/sample.test.js');
});

test('Deliverable 2: Live mid-turn steering injects tail user message, supports files + /cmd expansion, preserves KV prefix, and handles late mid-generation steer', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-30-steer-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-30-steer-work-'));
  mkdirSync(join(workDir, '.agent-us', 'commands'), { recursive: true });
  writeFileSync(
    join(workDir, '.agent-us', 'commands', 'focus.md'),
    'Focus exclusively on $ARGUMENTS and verify.',
    'utf8',
  );
  writeFileSync(join(workDir, 'a.txt'), 'initial\n', 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-steer');

  const b64Txt = Buffer.from('attached extra spec\n', 'utf8').toString('base64');
  const png1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  let direct;
  let sessionId = '';
  let stepIndex = 0;

  const scripted = new ScriptedAdapter([
    // Step 1: emits tool call
    async function* () {
      stepIndex++;
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-read-1',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'a.txt' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Step 2: must see tool-batch steer injected with expanded /focus + files; also inject late steer mid-generation!
    async function* (opts) {
      stepIndex++;
      assert.equal(
        opts.messages[0].content[0].text,
        scripted.calls[0].messages[0].content[0].text,
        'Static system prompt messages[0] must remain byte-identical',
      );
      const tailMsg = opts.messages.at(-1);
      assert.equal(tailMsg.role, 'user');
      const tailText = tailMsg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      assert.match(tailText, /Focus exclusively on auth\.js and verify\./);
      assert.match(tailText, /attached extra spec/);
      assert.ok(tailMsg.content.some((b) => b.type === 'image' && b.mimeType === 'image/png'));

      // Queue a late steer DURING final text generation (no tool calls!)
      direct.steerSession(sessionId, 'Wait, also summarize edge cases.');
      yield { type: 'text-delta', index: 0, text: 'Draft reply before late steer.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    // Step 3: triggered seamlessly by late steer right before turn completion!
    async function* (opts) {
      stepIndex++;
      assert.equal(
        opts.messages[0].content[0].text,
        scripted.calls[0].messages[0].content[0].text,
      );
      const tailText = opts.messages
        .at(-1)
        .content.filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      assert.match(tailText, /Wait, also summarize edge cases\./);
      yield { type: 'text-delta', index: 0, text: 'Final answer honoring auth.js and edge cases.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  ]);

  direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: scripted,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
    sessionId = sess.id;

    // Intercept tool/call event so we queue mid-turn steer while tool batch is executing
    let steeredDuringToolBatch = false;
    const unsub = direct.subscribe(sessionId, (ev) => {
      if (ev.type === 'tool/call' && !steeredDuringToolBatch) {
        steeredDuringToolBatch = true;
        const steerRes = direct.steerSession(sessionId, '/focus auth.js', {
          files: { 'note.txt': b64Txt, 'snap.png': png1x1 },
        });
        assert.equal(steerRes.steered, true);
      }
    });

    const started = direct.startTurn(sessionId, { input: 'Inspect a.txt' });
    const done = await waitTurnDone(direct, sessionId, started.turn.id);
    unsub();

    assert.equal(done.state, 'completed');
    assert.equal(stepIndex, 3);

    const events = direct.listEvents(sessionId);
    const injectedEvents = events.filter((e) => e.type === 'turn/steer_injected');
    assert.equal(injectedEvents.length, 2);
    assert.equal(injectedEvents[0].data.sessionId, sessionId);
    assert.equal(injectedEvents[0].data.turnId, started.turn.id);
    assert.equal(injectedEvents[0].data.count, 1);
    assert.match(injectedEvents[0].data.texts[0], /Focus exclusively on auth\.js/);
    assert.match(injectedEvents[1].data.texts[0], /Wait, also summarize edge cases\./);
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('Deliverable 3A: Hot-standby pool failover switches across 429, 503, and socket reset without failing turn and emits turn/route_failover', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-30-failover-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-30-failover-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });

  // Upstream 1: HTTP 429
  const up1 = await startMockUpstream((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '45' });
      res.end(JSON.stringify({ error: { message: 'Rate limited 429' } }));
      return;
    }
    res.writeHead(404).end();
  });
  // Upstream 2: HTTP 503
  const up2 = await startMockUpstream((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Service Unavailable 503' } }));
      return;
    }
    res.writeHead(404).end();
  });
  // Upstream 3: Transient socket reset on 1st call, healthy on 2nd? No, let's make up3 fail with socket destroy and up4 succeed (3 failovers!)
  const up3 = await startMockUpstream((req) => {
    req.socket.destroy();
  });
  // Upstream 4: Healthy standby!
  const up4 = await startMockUpstream((req, res) => {
    if (req.url === '/v1/chat/completions') {
      sendSseText(res, 'Standby account 4 completed seamlessly.');
      return;
    }
    res.writeHead(404).end();
  });

  const acc1 = pool.createAccount({
    preset: 'deepseek',
    label: 'Acc1-429',
    priority: 10,
    endpoint: up1.url,
    credential: 'sk-test-111111111',
    models: ['mock-standby'],
  });
  const acc2 = pool.createAccount({
    preset: 'deepseek',
    label: 'Acc2-503',
    priority: 20,
    endpoint: up2.url,
    credential: 'sk-test-222222222',
    models: ['mock-standby'],
  });
  const acc3 = pool.createAccount({
    preset: 'deepseek',
    label: 'Acc3-reset',
    priority: 30,
    endpoint: up3.url,
    credential: 'sk-test-333333333',
    models: ['mock-standby'],
  });
  const acc4 = pool.createAccount({
    preset: 'deepseek',
    label: 'Acc4-healthy',
    priority: 40,
    endpoint: up4.url,
    credential: 'sk-test-444444444',
    models: ['mock-standby'],
  });
  for (const a of [acc1, acc2, acc3, acc4]) {
    pool.addManualModel({ accountId: a.id, upstreamModel: 'mock-standby' });
  }
  pool.setDefaultModel('mock-standby');

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir, model: 'mock-standby' });
    const started = direct.startTurn(sess.id, { input: 'Test standby failover' });
    const done = await waitTurnDone(direct, sess.id, started.turn.id, 12000);

    assert.equal(done.state, 'completed');
    const events = direct.listEvents(sess.id);
    const failovers = events.filter((e) => e.type === 'turn/route_failover');
    assert.equal(failovers.length, 3);
    assert.deepEqual(
      failovers.map((e) => ({
        attempt: e.data.attempt,
        fromAccountId: e.data.fromAccountId,
        toAccountId: e.data.toAccountId,
      })),
      [
        { attempt: 1, fromAccountId: acc1.id, toAccountId: acc2.id },
        { attempt: 2, fromAccountId: acc2.id, toAccountId: acc3.id },
        { attempt: 3, fromAccountId: acc3.id, toAccountId: acc4.id },
      ],
    );
    assert.equal(failovers[0].data.statusCode, 429);
    assert.equal(failovers[1].data.statusCode, 503);

    const completedEv = events.find((e) => e.type === 'turn/completed');
    assert.equal(completedEv.data.accountId, acc4.id);
    assert.match(completedEv.data.text, /Standby account 4/);

    assert.equal(pool.getAccount(acc1.id).status, 'cooldown');
    assert.equal(pool.getAccount(acc2.id).status, 'cooldown');
    assert.equal(pool.getAccount(acc3.id).status, 'cooldown');
    assert.equal(pool.getAccount(acc4.id).status, 'healthy');
  } finally {
    await direct.close();
    await Promise.all([up1.close(), up2.close(), up3.close(), up4.close()]);
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('Deliverable 3B: InferenceEngine passes excludeAccountIds and marks AccountPool cooldown before visible deltas, while never retrying after partial delta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-30-inf-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  const a1 = pool.createAccount({
    preset: 'openai',
    label: 'Primary',
    priority: 10,
    endpoint: 'http://127.0.0.1:1/v1',
    credential: 'sk-a1',
  });
  const a2 = pool.createAccount({
    preset: 'openai',
    label: 'Standby',
    priority: 20,
    endpoint: 'http://127.0.0.1:2/v1',
    credential: 'sk-a2',
  });
  pool.addManualModel({ accountId: a1.id, upstreamModel: 'gpt-test' });
  pool.addManualModel({ accountId: a2.id, upstreamModel: 'gpt-test' });

  const failoverEvents = [];
  const seenExcludes = [];
  let callNum = 0;
  const mockAdapter = {
    async *stream(opts) {
      callNum++;
      seenExcludes.push(opts.excludeAccountIds ? [...opts.excludeAccountIds] : []);
      if (callNum === 1) {
        throw Object.assign(new Error('HTTP 500 Internal Server Error'), { status: 500 });
      }
      yield { type: 'route', route: { provider: 'openai', accountId: a2.id, wireModel: 'gpt-test' } };
      yield { type: 'text-delta', text: 'Standby ok' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  try {
    const inf = new InferenceEngine(mockAdapter, { pool, retryDelayMs: 25 });
    const step = await inf.streamStep({
      provider: 'pool',
      model: 'gpt-test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      onRouteFailover: (ev) => failoverEvents.push(ev),
    });

    assert.equal(step.text, 'Standby ok');
    assert.deepEqual(seenExcludes, [[], [a1.id]]);
    assert.equal(failoverEvents.length, 1);
    assert.equal(failoverEvents[0].fromAccountId, a1.id);
    assert.equal(failoverEvents[0].toAccountId, a2.id);
    assert.equal(failoverEvents[0].statusCode, 500);
    assert.equal(pool.getAccount(a1.id).status, 'cooldown');

    // Partial delta followed by 502 MUST NOT retry
    let partialCalls = 0;
    const partialInf = new InferenceEngine(
      {
        async *stream() {
          partialCalls++;
          yield { type: 'text-delta', text: 'partial-' };
          throw Object.assign(new Error('502 Bad Gateway'), { status: 502 });
        },
      },
      { pool, retryDelayMs: 25 },
    );
    await assert.rejects(
      () =>
        partialInf.streamStep({
          provider: 'pool',
          model: 'gpt-test',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        }),
      (err) => err.retryable === true,
    );
    assert.equal(partialCalls, 1);
  } finally {
    store.close();
    rmDirSafe(dir);
  }
});

test('Deliverable 4: Shell tool streams incremental ctx.onOutput and fails fast with INTERACTIVE_INPUT_REQUIRED on prompt hangs without false-positive on slow non-interactive commands', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-30-shell-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-30-shell-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const streamedChunks = [];
  const tools = createWorkspaceTools({
    workspaceRoot: workDir,
    store,
    nonce: mintNonce(),
    permissionMode: 'full-access',
    onToolOutput: (chunk) => streamedChunks.push({ via: 'toolOutput', ...chunk }),
  });
  const bashTool = tools.find((t) => t.name === 'bash');
  assert.ok(bashTool);

  const dispatcher = new ToolDispatcher({
    store,
    reconciler: new UnknownOutcomeReconciler(store),
    policy: new ToolPermissionPolicy({ permissionMode: 'full-access' }),
  });

  try {
    // 1. Direct bash.execute streams chunks via ctx.onOutput & detects [y/N] prompt hang quickly
    const ctxChunks = [];
    const t0 = Date.now();
    await assert.rejects(
      () =>
        bashTool.execute(
          {
            command: `node -e "process.stdout.write('Delete all files? [y/N] '); setTimeout(() => {}, 10000);"`,
            timeoutMs: 15000,
            interactiveTimeoutMs: 180,
          },
          {
            callId: 'tc-hang-1',
            onOutput: (chunk) => ctxChunks.push(chunk),
          },
        ),
      (err) => err.code === 'INTERACTIVE_INPUT_REQUIRED' && /INTERACTIVE_INPUT_REQUIRED/.test(err.message),
    );
    const elapsedMs = Date.now() - t0;
    assert.ok(elapsedMs < 4000, `Expected fast hang kill, took ${elapsedMs}ms`);
    assert.ok(ctxChunks.some((c) => c.stream === 'stdout' && c.chunk.includes('[y/N]')));
    assert.ok(streamedChunks.some((c) => c.callId === 'tc-hang-1' && c.chunk.includes('[y/N]')));

    // 2. Env override AGENT_US_SHELL_INTERACTIVE_TIMEOUT_MS + Password: prompt via ToolDispatcher
    const prevEnvTimeout = process.env.AGENT_US_SHELL_INTERACTIVE_TIMEOUT_MS;
    process.env.AGENT_US_SHELL_INTERACTIVE_TIMEOUT_MS = '150';
    try {
      const [dispatchedHang] = await dispatcher.dispatchBatch({
        sessionId: 'sess-shell-hang',
        turnId: 'turn-shell-hang',
        permissionMode: 'full-access',
        tools,
        toolCalls: [
          {
            id: 'tc-hang-pass',
            name: 'bash',
            arguments: JSON.stringify({
              command: `node -e "process.stderr.write('Password: '); setTimeout(() => {}, 10000);"`,
              timeoutMs: 15000,
            }),
          },
        ],
      });
      assert.equal(dispatchedHang.isError, true);
      assert.match(dispatchedHang.output, /INTERACTIVE_INPUT_REQUIRED/);
      assert.equal(dispatchedHang.receipt?.errorCode, 'INTERACTIVE_INPUT_REQUIRED');
    } finally {
      if (prevEnvTimeout === undefined) delete process.env.AGENT_US_SHELL_INTERACTIVE_TIMEOUT_MS;
      else process.env.AGENT_US_SHELL_INTERACTIVE_TIMEOUT_MS = prevEnvTimeout;
    }

    // 3. Slow non-interactive command MUST NOT false-positive
    const slowChunks = [];
    const okOut = await bashTool.execute(
      {
        command: `node -e "console.log('Running build...'); setTimeout(() => console.log('Build finished'), 300);"`,
        timeoutMs: 10000,
        interactiveTimeoutMs: 120,
      },
      {
        callId: 'tc-slow-ok',
        onOutput: (c) => slowChunks.push(c),
      },
    );
    assert.match(okOut, /exitCode: 0/);
    assert.match(okOut, /Build finished/);
    assert.ok(slowChunks.length >= 1);
  } finally {
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('Deliverable 5: Explicit onboarding scan/import/skip, zero silent .claude/.codex injection, secret redaction, untrusted MCP, and native /cmd expansion', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-30-onboard-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-30-onboard-ws1-'));
  const workDir2 = mkdtempSync(join(tmpdir(), 'agent-us-30-onboard-ws2-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'agent-us-30-fakehome-'));

  // Populate isolated fakeHome (~/.claude & ~/.codex)
  mkdirSync(join(fakeHome, '.claude', 'commands'), { recursive: true });
  mkdirSync(join(fakeHome, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(fakeHome, '.claude', 'skills', 'perf-check'), { recursive: true });
  writeFileSync(
    join(fakeHome, '.claude', 'CLAUDE.md'),
    '# User Claude Rules\nUSER_CLAUDE_SECRET_MARKER_XYZ\n',
    'utf8',
  );
  writeFileSync(
    join(fakeHome, '.claude', 'commands', 'review.md'),
    '---\ndescription: Code review command\n---\nReview $ARGUMENTS carefully.\n',
    'utf8',
  );
  writeFileSync(
    join(fakeHome, '.claude', 'agents', 'auditor.md'),
    '---\nname: auditor\ndescription: Security auditor\n---\nCheck security issues.\n',
    'utf8',
  );
  writeFileSync(
    join(fakeHome, '.claude', 'skills', 'perf-check', 'SKILL.md'),
    '---\nname: perf-check\ndescription: Profile hot paths\n---\nInspect hotspots.\n',
    'utf8',
  );
  const claudeJsonBefore = JSON.stringify(
    {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'ghp_1234567890supersecretuser' },
        },
      },
    },
    null,
    2,
  );
  writeFileSync(join(fakeHome, '.claude.json'), claudeJsonBefore, 'utf8');

  mkdirSync(join(fakeHome, '.codex', 'skills', 'codex-helper'), { recursive: true });
  writeFileSync(
    join(fakeHome, '.codex', 'AGENTS.md'),
    'CODEX_HOME_AGENTS_MARKER\n',
    'utf8',
  );
  writeFileSync(
    join(fakeHome, '.codex', 'instructions.md'),
    'CODEX_HOME_INSTRUCTIONS_MARKER\n',
    'utf8',
  );
  writeFileSync(
    join(fakeHome, '.codex', 'skills', 'codex-helper', 'SKILL.md'),
    '---\nname: codex-helper\ndescription: Codex skill\n---\nAssist cleanly.\n',
    'utf8',
  );
  const codexTomlBefore = [
    '[mcp_servers.codex_fs]',
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-filesystem"]',
    '[mcp_servers.codex_fs.env]',
    'OPENAI_API_KEY = "sk-codex-secret-999999999"',
    '',
  ].join('\n');
  writeFileSync(join(fakeHome, '.codex', 'config.toml'), codexTomlBefore, 'utf8');

  // Populate workspace 1 (with native AGENTS.md + external .claude/.agents/.mcp.json)
  writeFileSync(join(workDir, 'AGENTS.md'), 'NATIVE_AGENTS_MD_MARKER\n', 'utf8');
  writeFileSync(
    join(workDir, 'CLAUDE.md'),
    'WORKSPACE_CLAUDE_MD_NO_SILENT_INJECT\n',
    'utf8',
  );
  mkdirSync(join(workDir, '.claude', 'commands', 'ops'), { recursive: true });
  mkdirSync(join(workDir, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(workDir, '.claude', 'skills', 'ws-lint'), { recursive: true });
  writeFileSync(
    join(workDir, '.claude', 'CLAUDE.md'),
    'DOT_CLAUDE_MD_NO_SILENT_INJECT\n',
    'utf8',
  );
  writeFileSync(
    join(workDir, '.claude', 'commands', 'ops', 'deploy.md'),
    'Deploy target: $ARGUMENTS safely.',
    'utf8',
  );
  writeFileSync(
    join(workDir, '.claude', 'agents', 'migrator.md'),
    'Migrate carefully.',
    'utf8',
  );
  writeFileSync(
    join(workDir, '.claude', 'skills', 'ws-lint', 'SKILL.md'),
    '---\nname: ws-lint\ndescription: Lint workspace\n---\nRun lint checks.\n',
    'utf8',
  );
  mkdirSync(join(workDir, '.agents', 'skills', 'shared-skill'), { recursive: true });
  writeFileSync(
    join(workDir, '.agents', 'skills', 'shared-skill', 'SKILL.md'),
    '---\nname: shared-skill\ndescription: Shared agent skill\n---\nShared body.\n',
    'utf8',
  );
  const wsMcpBefore = JSON.stringify(
    {
      mcpServers: {
        ws_stdio: {
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          env: { API_SECRET: 'sk-workspace-secret-8888888' },
        },
      },
    },
    null,
    2,
  );
  writeFileSync(join(workDir, '.mcp.json'), wsMcpBefore, 'utf8');

  // Workspace 2 has its own external command
  mkdirSync(join(workDir2, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(workDir2, '.claude', 'commands', 'ws2.md'), 'WS2 $ARGUMENTS', 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-onboard');

  const scripted = new ScriptedAdapter([
    // Turn 1 (BEFORE import): verify ZERO silent external injection
    async function* () {
      yield { type: 'text-delta', text: 'Turn 1 clean.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    // Turn 2 (AFTER import): verify /ops:deploy expanded & native rules loaded & KV prefix identical
    async function* () {
      yield { type: 'text-delta', text: 'Turn 2 deployed.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  ]);

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: scripted,
  });

  const prevTestHome = process.env.AGENT_US_TEST_HOMEDIR;
  process.env.AGENT_US_TEST_HOMEDIR = fakeHome;

  try {
    const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });

    // 1. Before import: Turn 1 must see AGENTS.md ONLY, never CLAUDE.md / ~/.claude / ~/.codex / .agents
    const t1 = direct.startTurn(sess.id, { input: 'Hello runtime' });
    assert.equal((await waitTurnDone(direct, sess.id, t1.turn.id)).state, 'completed');
    const promptBefore = scripted.calls[0].messages
      .map((m) => m.content?.map((b) => b.text || '').join('\n'))
      .join('\n');
    assert.match(promptBefore, /NATIVE_AGENTS_MD_MARKER/);
    assert.ok(!promptBefore.includes('WORKSPACE_CLAUDE_MD_NO_SILENT_INJECT'));
    assert.ok(!promptBefore.includes('DOT_CLAUDE_MD_NO_SILENT_INJECT'));
    assert.ok(!promptBefore.includes('USER_CLAUDE_SECRET_MARKER_XYZ'));
    assert.ok(!promptBefore.includes('CODEX_HOME_AGENTS_MARKER'));
    assert.ok(!promptBefore.includes('CODEX_HOME_INSTRUCTIONS_MARKER'));
    assert.ok(!promptBefore.includes('shared-skill'));

    const emptyCustom = await direct.getWorkspaceCustomizations(workDir);
    assert.equal(emptyCustom.commands.length, 0);
    assert.equal(emptyCustom.skills.length, 0);
    assert.equal(emptyCustom.mcpServers.length, 0);

    // 2. detectExternalConfigs scans read-only and redacts all secrets
    const detected = await direct.detectExternalConfigs({
      workspaceRoot: workDir,
      homeDir: fakeHome,
    });
    assert.equal(detected.promptNeeded, true);
    assert.ok(detected.counts.rules >= 5);
    assert.ok(detected.counts.commands >= 2);
    assert.ok(detected.counts.skills >= 4);
    assert.ok(detected.counts.agents >= 2);
    assert.ok(detected.counts.mcp >= 3);
    assert.equal(detected.counts.total, detected.items.length);
    assert.ok(detected.providers.includes('claude'));
    assert.ok(detected.providers.includes('codex'));
    assert.ok(detected.providers.includes('agents'));
    const detectedJson = JSON.stringify(detected);
    assert.ok(!detectedJson.includes('1234567890supersecretuser'));
    assert.ok(!detectedJson.includes('sk-codex-secret-999999999'));
    assert.ok(!detectedJson.includes('sk-workspace-secret-8888888'));

    // 3. Skip flow writes 0 files and suppresses prompt for this user + workspace unless force=true
    const skipped = await direct.importExternalConfigs({
      workspaceRoot: workDir,
      homeDir: fakeHome,
      action: 'skip',
    });
    assert.equal(skipped.ok, true);
    assert.equal(skipped.action, 'skip');
    assert.equal(skipped.importedCount, 0);
    assert.equal(skipped.promptNeeded, false);
    assert.equal(existsSync(join(workDir, '.agent-us', 'commands')), false);
    assert.equal(existsSync(join(dataDir, 'commands')), false);

    const afterSkip = await direct.detectExternalConfigs({
      workspaceRoot: workDir,
      homeDir: fakeHome,
    });
    assert.equal(afterSkip.promptNeeded, false);
    const forced = await direct.detectExternalConfigs({
      workspaceRoot: workDir,
      homeDir: fakeHome,
      force: true,
    });
    assert.equal(forced.promptNeeded, true);

    // New workspace with external config still triggers promptNeeded!
    const ws2Detect = await direct.detectExternalConfigs({
      workspaceRoot: workDir2,
      homeDir: fakeHome,
    });
    assert.equal(ws2Detect.promptNeeded, true);

    // 4. Import flow converts to Agent_US native storage without modifying source files
    const importedEvents = [];
    const unsubGlobal = direct.subscribe(null, (ev) => {
      if (ev.type === 'onboarding/imported') importedEvents.push(ev);
    });
    const imported = await direct.importExternalConfigs({
      workspaceRoot: workDir,
      homeDir: fakeHome,
      action: 'import',
    });
    unsubGlobal();

    assert.equal(imported.ok, true);
    assert.equal(imported.action, 'import');
    assert.equal(imported.promptNeeded, false);
    assert.equal(imported.importedCount, detected.items.length);
    assert.equal(importedEvents.length, 1);

    // Source files remain untouched!
    assert.equal(readFileSync(join(fakeHome, '.claude.json'), 'utf8'), claudeJsonBefore);
    assert.equal(readFileSync(join(fakeHome, '.codex', 'config.toml'), 'utf8'), codexTomlBefore);
    assert.equal(readFileSync(join(workDir, '.mcp.json'), 'utf8'), wsMcpBefore);

    // Native destination files exist & MCP entries are disabled/untrusted + redacted
    assert.ok(existsSync(join(dataDir, 'rules', 'claude-user.md')));
    assert.ok(existsSync(join(dataDir, 'rules', 'codex-agents.md')));
    assert.ok(existsSync(join(dataDir, 'commands', 'review.md')));
    assert.ok(existsSync(join(dataDir, 'agents', 'auditor.md')));
    assert.ok(existsSync(join(dataDir, 'skills', 'perf-check', 'SKILL.md')));
    assert.ok(existsSync(join(dataDir, 'mcp-imported.json')));

    assert.ok(existsSync(join(workDir, '.agent-us', 'rules', 'claude-project.md')));
    assert.ok(existsSync(join(workDir, '.agent-us', 'commands', 'ops', 'deploy.md')));
    assert.ok(existsSync(join(workDir, '.agent-us', 'agents', 'migrator.md')));
    assert.ok(existsSync(join(workDir, '.agent-us', 'skills', 'shared-skill', 'SKILL.md')));
    assert.ok(existsSync(join(workDir, '.agent-us', 'mcp.json')));

    const userMcpJson = JSON.parse(readFileSync(join(dataDir, 'mcp-imported.json'), 'utf8'));
    assert.equal(userMcpJson.mcpServers.github.disabled, true);
    assert.equal(userMcpJson.mcpServers.github.trusted, false);
    assert.equal(userMcpJson.mcpServers.github.env.GITHUB_TOKEN, '[REDACTED]');
    assert.equal(userMcpJson.mcpServers.codex_fs.disabled, true);
    assert.equal(userMcpJson.mcpServers.codex_fs.trusted, false);

    const wsMcpJson = JSON.parse(readFileSync(join(workDir, '.agent-us', 'mcp.json'), 'utf8'));
    assert.equal(wsMcpJson.mcpServers.ws_stdio.disabled, true);
    assert.equal(wsMcpJson.mcpServers.ws_stdio.trusted, false);
    assert.equal(wsMcpJson.mcpServers.ws_stdio.env.API_SECRET, '[REDACTED]');

    // Untrusted workspace MCP must NOT spawn or discover tools automatically
    const discoveredMcpTools = await direct.mcpManager.discoverTools(workDir);
    assert.equal(discoveredMcpTools.length, 0);

    // Customizations API lists all imported native assets cleanly
    const customs = imported.customizations;
    assert.ok(customs.commands.some((c) => c.name === 'review'));
    assert.ok(customs.commands.some((c) => c.name === 'ops:deploy'));
    assert.ok(customs.agents.some((a) => a.name === 'auditor'));
    assert.ok(customs.skills.some((s) => s.name === 'shared-skill'));
    assert.ok(customs.rules.some((r) => r.name === 'claude-project'));
    assert.ok(customs.mcpServers.every((m) => m.disabled === true && m.trusted === false));

    // After import, promptNeeded is false
    const afterImport = await direct.detectExternalConfigs({
      workspaceRoot: workDir,
      homeDir: fakeHome,
    });
    assert.equal(afterImport.promptNeeded, false);

    // 5. Turn 2 expands native /ops:deploy and injects native rules while keeping static system prompt byte-identical!
    const t2 = direct.startTurn(sess.id, { input: '/ops:deploy staging-eu' });
    assert.equal((await waitTurnDone(direct, sess.id, t2.turn.id)).state, 'completed');
    assert.equal(
      scripted.calls[1].messages[0].content[0].text,
      scripted.calls[0].messages[0].content[0].text,
      'Static system prompt messages[0] must remain byte-identical after import',
    );
    const promptAfter = scripted.calls[1].messages
      .map((m) => m.content?.map((b) => b.text || '').join('\n'))
      .join('\n');
    assert.match(promptAfter, /Deploy target: staging-eu safely\./);
    assert.match(promptAfter, /WORKSPACE_CLAUDE_MD_NO_SILENT_INJECT/);
    assert.match(promptAfter, /USER_CLAUDE_SECRET_MARKER_XYZ/);
    assert.match(promptAfter, /CODEX_HOME_AGENTS_MARKER/);
  } finally {
    if (prevTestHome === undefined) delete process.env.AGENT_US_TEST_HOMEDIR;
    else process.env.AGENT_US_TEST_HOMEDIR = prevTestHome;
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
    rmDirSafe(workDir2);
    rmDirSafe(fakeHome);
  }
});
