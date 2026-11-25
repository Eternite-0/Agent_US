import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

import { api } from '../src/api.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { AccountPool } from '../src/pool.js';
import { Store } from '../src/store.js';
import { rmDirSafe } from './fixtures.js';
import {
  AgentUsClient,
  ApprovalCoordinator,
  CLI_VERSION,
  CliError,
  SseRenderer,
  ensureBackendReady,
  formatPipedPrompt,
  parseCliArgs,
  readPipedStdin,
  resolveConnectionConfig,
  runCli,
} from '../src/cli.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(TEST_DIR, '..');
const REPO_ROOT = resolve(BACKEND_ROOT, '..');
const BIN_PATH = join(BACKEND_ROOT, 'bin', 'agent-us.mjs');

function makeBufferWritable() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
    text() {
      return chunks.join('');
    },
  };
}

function runBinProcess(args, { stdinText = '', env = {}, cwd = REPO_ROOT } = {}) {
  return new Promise((resolveProc, rejectProc) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('error', rejectProc);
    child.on('close', (code) => {
      resolveProc({ code, stdout, stderr });
    });
    if (stdinText) {
      child.stdin.end(stdinText);
    } else {
      child.stdin.end();
    }
  });
}

test('parseCliArgs handles one-shot, flags, --resume variants, --swarm, import, and validation errors', () => {
  const p1 = parseCliArgs(['-C', 'my-ws', '-m', 'gpt-5', '-p', 'workspace-write', '--yes', '--no-autostart', '修复报错'], {
    cwd: REPO_ROOT,
  });
  assert.equal(p1.command, 'chat');
  assert.equal(p1.prompt, '修复报错');
  assert.equal(p1.cwd, resolve(REPO_ROOT, 'my-ws'));
  assert.equal(p1.cwdExplicit, true);
  assert.equal(p1.model, 'gpt-5');
  assert.equal(p1.permission, 'workspace-write');
  assert.equal(p1.yes, true);
  assert.equal(p1.autostart, false);

  assert.equal(parseCliArgs(['--resume']).resume, 'latest');
  assert.equal(parseCliArgs(['--resume', 'latest']).resume, 'latest');
  assert.equal(parseCliArgs(['--resume', 'sess-99']).resume, 'sess-99');
  assert.equal(parseCliArgs(['--resume=sess-88']).resume, 'sess-88');

  const pResumeWithPrompt = parseCliArgs(['--resume', 'sess-77', 'continue', 'here']);
  assert.equal(pResumeWithPrompt.resume, 'sess-77');
  assert.equal(pResumeWithPrompt.prompt, 'continue here');

  const pResumeChinesePrompt = parseCliArgs(['--resume', '继续修复']);
  assert.equal(pResumeChinesePrompt.resume, 'latest');
  assert.equal(pResumeChinesePrompt.prompt, '继续修复');

  const pSwarm = parseCliArgs(['--swarm', '重构认证模块', '--permission', 'auto-safe']);
  assert.equal(pSwarm.command, 'swarm');
  assert.equal(pSwarm.swarmGoal, '重构认证模块');
  assert.equal(pSwarm.permission, 'auto-safe');

  const pImportYes = parseCliArgs(['import', '--yes']);
  assert.equal(pImportYes.command, 'import');
  assert.equal(pImportYes.yes, true);
  assert.equal(pImportYes.skip, false);

  const pImportSkip = parseCliArgs(['import', '--skip']);
  assert.equal(pImportSkip.command, 'import');
  assert.equal(pImportSkip.skip, true);

  assert.throws(() => parseCliArgs(['--permission', 'bogus']), CliError);
  assert.throws(() => parseCliArgs(['--swarm', '   ']), CliError);
  assert.throws(() => parseCliArgs(['--unknown-flag']), CliError);
});

test('readPipedStdin and formatPipedPrompt wrap non-TTY stdin safely without touching TTY', async () => {
  const ttyStream = new PassThrough();
  const ttyOut = await readPipedStdin(ttyStream, { isTty: true });
  assert.equal(ttyOut, '');

  const pipe = new PassThrough();
  pipe.end('FAIL test/auth.test.js\r\nAssertionError: 500 !== 200\r\n');
  const captured = await readPipedStdin(pipe, { isTty: false });
  assert.match(captured, /FAIL test\/auth\.test\.js/);

  const combined = formatPipedPrompt('定位修复', captured);
  assert.equal(
    combined,
    '<piped_stdin>\nFAIL test/auth.test.js\nAssertionError: 500 !== 200\n</piped_stdin>\n\n定位修复',
  );
  assert.equal(formatPipedPrompt('定位修复', ''), '定位修复');

  const bigPipe = new PassThrough();
  bigPipe.end('x'.repeat(200));
  const truncated = await readPipedStdin(bigPipe, { isTty: false, maxBytes: 50 });
  assert.ok(truncated.includes('truncated at 50 bytes'));
});

test('resolveConnectionConfig reads <dataDir>/.dev-token and ensureBackendReady handles healthy, --no-autostart, and detached spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-conn-'));
  try {
    const devToken = 'a'.repeat(32);
    writeFileSync(join(dir, '.dev-token'), `${devToken}\n`, 'utf8');
    writeFileSync(
      join(dir, '.provider-env.json'),
      JSON.stringify({ OPENAI_API_KEY: 'from-provider-env', EXISTING_KEY: 'ignored' }),
      'utf8',
    );

    const parsed = parseCliArgs(['--data-dir', dir, '--url', 'http://127.0.0.1:9911']);
    const conn = resolveConnectionConfig(parsed, { env: {}, backendRoot: BACKEND_ROOT });
    assert.equal(conn.token, devToken);
    assert.equal(conn.baseUrl, 'http://127.0.0.1:9911');

    const connEnv = resolveConnectionConfig(parsed, {
      env: { BACKEND_TOKEN: 'env-token-override-1234567890' },
      backendRoot: BACKEND_ROOT,
    });
    assert.equal(connEnv.token, 'env-token-override-1234567890');

    // Healthy server skips spawn
    let spawnedCount = 0;
    const readyHealthy = await ensureBackendReady({
      baseUrl: conn.baseUrl,
      dataDir: dir,
      token: devToken,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      spawnImpl: () => {
        spawnedCount++;
        return new EventEmitter();
      },
    });
    assert.equal(readyHealthy.started, false);
    assert.equal(spawnedCount, 0);

    // Unreachable with --no-autostart throws
    await assert.rejects(
      () =>
        ensureBackendReady({
          baseUrl: conn.baseUrl,
          dataDir: dir,
          token: devToken,
          autostart: false,
          fetchImpl: async () => {
            throw new Error('ECONNREFUSED');
          },
        }),
      (err) => err instanceof CliError && err.code === 'BACKEND_UNREACHABLE',
    );

    // Unreachable local backend spawns detached main.js with BACKEND_DATA/BACKEND_TOKEN/PORT and polls /health
    let healthPolls = 0;
    let spawnCall = null;
    const freshDir = join(dir, 'fresh-data');
    mkdirSync(freshDir, { recursive: true });
    writeFileSync(
      join(freshDir, '.provider-env.json'),
      JSON.stringify({ CUSTOM_API_KEY: 'secret-val', PRESET_ENV: 'from-file' }),
      'utf8',
    );

    const started = await ensureBackendReady({
      baseUrl: 'http://127.0.0.1:9922',
      dataDir: freshDir,
      token: '',
      backendRoot: BACKEND_ROOT,
      env: { PRESET_ENV: 'already-set' },
      pollIntervalMs: 10,
      startupTimeoutMs: 2000,
      fetchImpl: async () => {
        healthPolls++;
        if (healthPolls < 3) throw new Error('ECONNREFUSED');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      spawnImpl: (bin, args, opts) => {
        spawnCall = { bin, args, opts };
        const child = new EventEmitter();
        child.pid = 43210;
        child.unref = () => {
          spawnCall.unreffed = true;
        };
        return child;
      },
    });

    assert.equal(started.started, true);
    assert.equal(started.pid, 43210);
    assert.ok(started.token.length >= 24);
    assert.equal(readFileSync(join(freshDir, '.dev-token'), 'utf8'), started.token);
    assert.equal(spawnCall.args[0], resolve(BACKEND_ROOT, 'src', 'main.js'));
    assert.equal(spawnCall.opts.detached, true);
    assert.equal(spawnCall.unreffed, true);
    assert.equal(spawnCall.opts.env.BACKEND_DATA, freshDir);
    assert.equal(spawnCall.opts.env.BACKEND_TOKEN, started.token);
    assert.equal(spawnCall.opts.env.PORT, '9922');
    assert.equal(spawnCall.opts.env.CUSTOM_API_KEY, 'secret-val');
    assert.equal(spawnCall.opts.env.PRESET_ENV, 'already-set');
  } finally {
    rmDirSafe(dir);
  }
});

test('SseRenderer and ApprovalCoordinator handle all SSE events, interactive prompt, external resolution, and --yes', async () => {
  const stdout = makeBufferWritable();
  const stderr = makeBufferWritable();
  const decisions = [];

  const mockClient = {
    async decideApproval(id, payload) {
      decisions.push({ id, ...payload });
      return { id, ...payload };
    },
    async listApprovals() {
      return {
        items: [
          {
            id: 'apr-poll-1',
            sessionId: 's1',
            tool: 'bash',
            riskLevel: 'high',
            arguments: { command: 'rm -rf tmp' },
          },
        ],
      };
    },
  };

  const answers = ['a', 'n'];
  const renderer = new SseRenderer({
    stdout,
    stderr,
    onApprovalRequested: (a) => approvals.enqueue(a),
    onApprovalResolved: (a) => approvals.markResolved(a),
  });
  const approvals = new ApprovalCoordinator({
    client: mockClient,
    sessionId: 's1',
    autoApprove: false,
    promptFn: async () => answers.shift() ?? 'n',
    stdout,
    stderr,
    renderer,
  });

  renderer.render({ type: 'reasoning/delta', turnId: 't1', data: { delta: 'checking...' } });
  renderer.render({ type: 'assistant/delta', turnId: 't1', data: { delta: 'Hello ' } });
  renderer.render({ type: 'assistant/delta', turnId: 't1', data: { delta: 'world' } });
  renderer.render({ type: 'tool/call', turnId: 't1', data: { name: 'bash', arguments: { command: 'npm test' } } });
  renderer.render({ type: 'tool/output', turnId: 't1', data: { stream: 'stdout', chunk: '1 pass\n' } });
  renderer.render({ type: 'turn/steered', turnId: 't1', data: { text: 'check edge cases' } });
  renderer.render({
    type: 'turn/steer_injected',
    turnId: 't1',
    data: { step: 2, count: 1, texts: ['check edge cases'] },
  });
  renderer.render({
    type: 'turn/route_failover',
    turnId: 't1',
    data: { attempt: 1, statusCode: 429, fromAccountId: 'acc-1', toAccountId: 'acc-2', reason: 'rate_limit' },
  });
  renderer.render({
    type: 'file/changed',
    turnId: 't1',
    data: { action: 'modified', path: 'src/app.js', additions: 3, deletions: 1 },
  });
  renderer.render({
    type: 'approval/requested',
    turnId: 't1',
    data: { approvalId: 'apr-sse-1', tool: 'write_file', riskLevel: 'medium', arguments: { path: 'a.txt' } },
  });
  await approvals.pollOnce();
  await approvals.flush();
  await approvals.stop();

  renderer.render({
    type: 'turn/completed',
    turnId: 't1',
    data: { model: 'gpt-5', steps: 2, inputTokens: 100, outputTokens: 20, durationMs: 50, text: 'Hello world' },
  });

  const outText = stdout.text();
  assert.ok(outText.includes('[thinking] checking...'));
  assert.equal(outText.match(/Hello world/g)?.length, 1, 'should not duplicate streamed deltas');
  assert.ok(outText.includes('[tool] bash'));
  assert.ok(outText.includes('1 pass'));
  assert.ok(outText.includes('[steered] queued: check edge cases'));
  assert.ok(outText.includes('[steer_injected] step=2 count=1: check edge cases'));
  assert.ok(outText.includes('[route_failover] attempt=1 status=429 acc-1 -> acc-2'));
  assert.ok(outText.includes('[file] modified src/app.js (+3/-1)'));
  assert.ok(outText.includes('[completed] turn=t1 model=gpt-5'));

  assert.deepEqual(decisions, [
    { id: 'apr-sse-1', decision: 'allow', scope: 'session' },
    { id: 'apr-poll-1', decision: 'deny', scope: 'once' },
  ]);

  // Verify --yes auto-approve
  const autoDecisions = [];
  const autoApprovals = new ApprovalCoordinator({
    client: {
      async decideApproval(id, payload) {
        autoDecisions.push({ id, ...payload });
      },
    },
    sessionId: 's1',
    autoApprove: true,
    stdout: makeBufferWritable(),
    stderr: makeBufferWritable(),
  });
  autoApprovals.enqueue({ approvalId: 'apr-auto-1', tool: 'bash', arguments: { command: 'ls' } });
  await autoApprovals.flush();
  await autoApprovals.stop();
  assert.equal(autoDecisions.length, 1);
  assert.equal(autoDecisions[0].decision, 'allow');
  assert.equal(autoDecisions[0].scope, 'once');
});

test('CLI supports --swarm, import --yes/--skip, and interactive REPL (/steer, /undo, /git, /import, /commands, /exit)', async (t) => {
  const token = 'mock-cli-30-test-token-123456';
  const calls = {
    turns: [],
    steers: [],
    rewinds: [],
    gitChanges: 0,
    gitStatus: 0,
    imports: [],
    approvals: [],
  };
  let gitChangesMode = 'changes';
  let nextSeq = 1;
  const sseClients = new Set();

  const emitSse = (ev) => {
    const seq = ev.ephemeral ? 0 : (ev.seq ?? nextSeq++);
    const frameEv = { ...ev, seq };
    const payload = `id: ${seq}\nevent: ${frameEv.type}\ndata: ${JSON.stringify(frameEv)}\n\n`;
    for (const res of sseClients) {
      if (!res.writableEnded) res.write(payload);
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }));
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) : {};

    const sendJson = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
      return sendJson(200, {
        items: [{ id: 'sess-mock-1', title: 'Mock Session', workspaceRoot: REPO_ROOT, state: 'idle' }],
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/sessions') {
      return sendJson(200, {
        id: 'sess-mock-1',
        title: body.title || 'Mock Session',
        workspaceRoot: body.workspaceRoot || REPO_ROOT,
        state: 'idle',
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/sessions/sess-mock-1') {
      return sendJson(200, {
        id: 'sess-mock-1',
        title: 'Mock Session',
        workspaceRoot: REPO_ROOT,
        model: 'gpt-5',
        permissionMode: 'auto-safe',
        state: 'idle',
      });
    }
    if (req.method === 'GET' && url.pathname.endsWith('/turns')) {
      return sendJson(200, { items: [] });
    }
    if (req.method === 'GET' && url.pathname.endsWith('/messages')) {
      return sendJson(200, { items: [] });
    }
    if (req.method === 'GET' && url.pathname.endsWith('/events')) {
      return sendJson(200, { items: [] });
    }
    if (req.method === 'GET' && url.pathname.endsWith('/children')) {
      return sendJson(200, { items: [] });
    }
    if (req.method === 'GET' && url.pathname === '/v1/approvals') {
      return sendJson(200, { items: [] });
    }
    if (req.method === 'GET' && url.pathname === '/v1/sessions/sess-mock-1/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/sessions/sess-mock-1/turns') {
      calls.turns.push(body);
      if (String(body.input || '').startsWith('/swarm ')) {
        const runId = 'run-mock-1';
        sendJson(200, {
          mode: 'swarm',
          action: 'start',
          runId,
          run: { id: runId, status: 'planning', nodes: [] },
          message: `Swarm ${runId} · planning`,
        });
        setTimeout(() => {
          emitSse({
            type: 'swarm/run_started',
            data: { runId, goal: body.input.slice(7), nodeCount: 2 },
          });
          emitSse({
            type: 'swarm/node_updated',
            data: { runId, nodeKey: 'worker-1', status: 'completed' },
          });
          emitSse({
            type: 'verifier/verdict',
            data: { passed: true, summary: 'All checks passed' },
          });
          emitSse({
            type: 'swarm/run_completed',
            data: { runId, status: 'completed' },
          });
        }, 20);
        return;
      }

      const turnId = `turn-mock-${calls.turns.length}`;
      sendJson(200, {
        mode: 'direct',
        turn: { id: turnId, state: 'running' },
      });
      setTimeout(() => {
        emitSse({ type: 'turn/started', turnId, data: { turnId } });
        emitSse({ ephemeral: true, type: 'assistant/delta', turnId, data: { turnId, delta: 'Working...' } });
      }, 15);
      setTimeout(() => {
        emitSse({
          type: 'turn/completed',
          turnId,
          data: { turnId, model: 'gpt-5', steps: 1, inputTokens: 12, outputTokens: 5, durationMs: 40 },
        });
      }, 120);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/sessions/sess-mock-1/steer') {
      calls.steers.push(body);
      emitSse({ type: 'turn/steered', data: { text: body.input } });
      return sendJson(200, { steered: true, sessionId: 'sess-mock-1', queued: 1 });
    }
    if (req.method === 'POST' && url.pathname === '/v1/sessions/sess-mock-1/rewind') {
      calls.rewinds.push(body);
      emitSse({
        type: 'session/rewound',
        data: { scope: body.scope || 'both', restoredFiles: ['a.txt'], removedMessages: 2 },
      });
      return sendJson(200, {
        ok: true,
        scope: body.scope || 'both',
        restoredFiles: ['a.txt'],
        deletedFiles: [],
        removedMessages: 2,
        redoId: 'redo-1',
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/git/changes') {
      calls.gitChanges++;
      if (gitChangesMode === '404') {
        return sendJson(404, { error: { code: 'NOT_FOUND' } });
      }
      return sendJson(200, {
        available: true,
        branch: 'feat/3.0',
        ahead: 1,
        behind: 0,
        workspaceRoot: REPO_ROOT,
        staged: [{ path: 'package.json', status: 'M' }],
        unstaged: [],
        untracked: [{ path: 'start-dev.sh' }],
        blockedSensitive: ['.env'],
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/git/status') {
      calls.gitStatus++;
      return sendJson(200, {
        available: true,
        branch: 'main',
        uncommittedCount: 2,
        workspaceRoot: REPO_ROOT,
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/onboarding/detect-external') {
      assert.equal(url.searchParams.get('force'), '1');
      return sendJson(200, {
        promptNeeded: true,
        counts: { rules: 1, commands: 1, skills: 0, agents: 0, mcp: 0, total: 2 },
        providers: ['claude', 'codex'],
        items: [
          { id: 'claude:user:rule:CLAUDE.md', provider: 'claude', scope: 'user', kind: 'rule', name: 'CLAUDE.md', displayPath: '~/.claude/CLAUDE.md' },
          { id: 'claude:ws:cmd:review', provider: 'claude', scope: 'workspace', kind: 'command', name: 'review', displayPath: '.claude/commands/review.md' },
        ],
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/onboarding/import-external') {
      calls.imports.push(body);
      return sendJson(200, {
        ok: true,
        action: body.action,
        importedCount: body.action === 'import' ? (body.itemIds?.length ?? 0) : 0,
        promptNeeded: false,
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/workspace/customizations') {
      return sendJson(200, {
        workspaceRoot: REPO_ROOT,
        commands: [{ id: 'review', name: 'review', description: 'Review diff' }],
        skills: [{ id: 'tdd', name: 'tdd', description: 'Test-first workflow' }],
        agents: [],
      });
    }
    return sendJson(404, { error: { code: 'NOT_FOUND' } });
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => {
    for (const res of sseClients) res.end();
    server.closeAllConnections?.();
    server.close();
  });

  try {
    // 1. --swarm mode
    const closedStdin = () => {
      const s = new PassThrough();
      s.end();
      return s;
    };
    const swarmOut = makeBufferWritable();
    const swarmCode = await runCli(
      ['--url', baseUrl, '--token', token, '--no-autostart', '--swarm', 'Build API tests'],
      {
        stdin: closedStdin(),
        stdout: swarmOut,
        stderr: makeBufferWritable(),
        isTty: false,
        approvalPollMs: 50,
        swarmPollMs: 50,
      },
    );
    assert.equal(swarmCode, 0);
    assert.equal(calls.turns[0].input, '/swarm Build API tests');
    assert.ok(swarmOut.text().includes('[swarm] started run=run-mock-1'));
    assert.ok(swarmOut.text().includes('[swarm:node] worker-1 -> completed'));
    assert.ok(swarmOut.text().includes('[verifier] passed=true All checks passed'));
    assert.ok(swarmOut.text().includes('[swarm] run=run-mock-1 status=completed'));

    // 2. import --yes and import --skip
    const importYesOut = makeBufferWritable();
    assert.equal(
      await runCli(['import', '--yes', '--url', baseUrl, '--token', token, '--no-autostart'], {
        stdin: closedStdin(),
        stdout: importYesOut,
        stderr: makeBufferWritable(),
        isTty: false,
      }),
      0,
    );
    assert.ok(importYesOut.text().includes('Imported 2 asset(s)'));
    assert.equal(calls.imports[0].action, 'import');
    assert.equal(calls.imports[0].itemIds.length, 2);

    const importSkipOut = makeBufferWritable();
    assert.equal(
      await runCli(['import', '--skip', '--url', baseUrl, '--token', token, '--no-autostart'], {
        stdin: closedStdin(),
        stdout: importSkipOut,
        stderr: makeBufferWritable(),
        isTty: false,
      }),
      0,
    );
    assert.ok(importSkipOut.text().includes('skipped'));
    assert.equal(calls.imports[1].action, 'skip');

    // 3. Interactive REPL: mid-turn /steer, /commands, /git, /undo, /import, /exit
    const replIn = new PassThrough();
    const replOut = makeBufferWritable();
    const replErr = makeBufferWritable();
    const replPromise = runCli(
      ['--resume', 'sess-mock-1', '--url', baseUrl, '--token', token, '--no-autostart', '--yes'],
      {
        stdin: replIn,
        stdout: replOut,
        stderr: replErr,
        isTty: false,
        approvalPollMs: 100,
      },
    );

    const waitUntil = async (pred, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await new Promise((r) => setTimeout(r, 40));
    replIn.write('start refactor\n');
    await waitUntil(() => calls.turns.length >= 2);
    replIn.write('/steer prioritize tests\n');
    await waitUntil(() => calls.steers.length >= 1);
    await new Promise((r) => setTimeout(r, 140));
    replIn.write('/commands\n');
    replIn.write('/git\n');
    await waitUntil(() => calls.gitChanges >= 1);
    gitChangesMode = '404';
    replIn.write('/git\n');
    await waitUntil(() => calls.gitStatus >= 1);
    replIn.write('/undo files\n');
    replIn.write('/import --yes\n');
    await waitUntil(() => calls.rewinds.length >= 1 && calls.imports.length >= 3);
    replIn.write('/exit\n');
    replIn.end();

    const replCode = await replPromise;
    assert.equal(replCode, 0, replErr.text());
    const rText = replOut.text();
    assert.equal(calls.steers[0].input, 'prioritize tests');
    assert.equal(calls.rewinds[0].scope, 'files');
    assert.equal(calls.gitChanges, 2);
    assert.equal(calls.gitStatus, 1);
    assert.ok(rText.includes('/review — Review diff'));
    assert.ok(rText.includes('skill:tdd'));
    assert.ok(rText.includes('[git] branch=feat/3.0'));
    assert.ok(rText.includes('blockedSensitive: .env'));
    assert.ok(rText.includes('[undo] ok=true scope=files restored=1'));
  } finally {
    for (const res of sseClients) res.end();
    server.closeAllConnections?.();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('Real Fastify /v1/* server + agent-us.mjs subprocess syncs piped stdin, approvals, and --resume across GUI store', async () => {
  const realTmp = realpathSync.native ?? realpathSync;
  const dir = realTmp(mkdtempSync(join(tmpdir(), 'cli-real-v1-')));
  const ws = realTmp(mkdtempSync(join(tmpdir(), 'cli-real-ws-')));
  writeFileSync(join(ws, 'hello.txt'), 'original\n', 'utf8');
  const token = 'real-cli-sync-token-1234567890';
  writeFileSync(join(dir, '.dev-token'), token, 'utf8');

  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('scripted-cli');

  let stepCount = 0;
  class ScriptedCliAdapter extends LlmAdapter {
    async *stream({ messages }) {
      stepCount++;
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const lastText = lastUser?.content?.find((b) => b.type === 'text')?.text ?? '';
      if (stepCount === 1 && lastText.includes('<piped_stdin>')) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield {
          type: 'tool-call-delta',
          index: 0,
          id: 'call_cli_write_1',
          name: 'write_file',
          argumentsDelta: JSON.stringify({ path: 'hello.txt', content: 'fixed by cli\n' }),
        };
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'call_cli_write_1',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'hello.txt', content: 'fixed by cli\n' }),
          },
        };
        yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 10 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }

      const replyText =
        stepCount === 2 ? 'Fixed hello.txt from piped diagnostics.' : 'Resumed follow-up complete.';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: replyText };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: replyText } };
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 12 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }

  const direct = new DirectAgentRuntime(store, pool, {
    dataRoot: dir,
    defaultWorkspace: ws,
    adapter: new ScriptedCliAdapter(),
  });
  const app = api(store, token, { models: [], list: () => [] }, { directAgent: direct, pool });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  try {
    // 1. Subprocess piped stdin + one-shot prompt (using .dev-token from --data-dir!)
    const proc1 = await runBinProcess(
      ['--url', address, '--data-dir', dir, '--cwd', ws, '--permission', 'approval', '--yes', '--no-autostart', '定位修复'],
      { stdinText: 'Error: expected fixed\n' },
    );
    assert.equal(proc1.code, 0, proc1.stderr);
    assert.ok(proc1.stdout.includes('[auto-approve] write_file'));
    assert.ok(proc1.stdout.includes('Fixed hello.txt from piped diagnostics.'));
    assert.ok(proc1.stdout.includes('[completed]'));
    assert.equal(readFileSync(join(ws, 'hello.txt'), 'utf8'), 'fixed by cli\n');

    // Verify GUI /v1/sessions?scope=chats sees the CLI session & piped prompt
    const client = new AgentUsClient({ baseUrl: address, token });
    const listRes = await client.listSessions({ scope: 'chats' });
    assert.equal(listRes.items.length, 1);
    const cliSession = listRes.items[0];
    assert.equal(cliSession.workspaceRoot, ws);
    const msgsRes = await client.listMessages(cliSession.id);
    assert.ok(msgsRes.items[0].content.includes('<piped_stdin>\nError: expected fixed\n</piped_stdin>\n\n定位修复'));

    // 2. Subprocess --resume latest with interactive REPL follow-up + /git + /undo (rewinds turn 2, then turn 1) + /exit
    const proc2 = await runBinProcess(
      ['--resume', 'latest', '--url', address, '--data-dir', dir, '--cwd', ws, '--yes', '--no-autostart'],
      { stdinText: '继续验证\n/git\n/undo\n/undo\n/exit\n' },
    );
    assert.equal(proc2.code, 0, proc2.stderr);
    assert.ok(proc2.stdout.includes(`[session] resumed ${cliSession.id}`));
    assert.ok(proc2.stdout.includes('Resumed follow-up complete.'));
    assert.ok(proc2.stdout.includes('[git]'));
    assert.ok(proc2.stdout.includes('[undo] ok=true'));
    assert.equal(readFileSync(join(ws, 'hello.txt'), 'utf8'), 'original\n');
  } finally {
    await direct.close();
    await app.close();
    store.close();
    rmDirSafe(dir);
    rmDirSafe(ws);
  }
});

test('Root package.json, start-dev.sh, and backend/bin/agent-us.mjs metadata and LF hygiene are valid', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, CLI_VERSION);
  assert.equal(pkg.bin['agent-us'], './backend/bin/agent-us.mjs');
  assert.equal(pkg.scripts['agent-us'], 'node backend/bin/agent-us.mjs');
  assert.equal(pkg.scripts['start:backend'], 'node backend/src/main.js');
  assert.equal(pkg.scripts.serve, 'node backend/src/main.js');
  assert.equal(pkg.scripts.test, 'node --test backend/test/*.test.js');
  assert.equal(pkg.dependencies['@openai/codex-sdk'], '0.170.0');

  const shBuf = readFileSync(join(REPO_ROOT, 'start-dev.sh'));
  const shText = shBuf.toString('utf8');
  assert.equal(shText.includes('\r'), false, 'start-dev.sh must have strict LF line endings');
  assert.ok(shText.startsWith('#!/usr/bin/env bash\n'));
  assert.ok(shText.includes('.dev-token'));
  assert.ok(shText.includes('.provider-env.json'));
  assert.ok(shText.includes('BACKEND_DATA'));
  assert.ok(shText.includes('trap '));

  const binText = readFileSync(BIN_PATH, 'utf8');
  assert.equal(binText.includes('\r'), false, 'agent-us.mjs must have strict LF line endings');
  assert.ok(binText.startsWith('#!/usr/bin/env node\n'));

  if (process.platform !== 'win32') {
    const syntax = spawnSync('bash', ['-n', join(REPO_ROOT, 'start-dev.sh')], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});
