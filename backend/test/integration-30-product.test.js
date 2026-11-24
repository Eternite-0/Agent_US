import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { api } from '../src/api.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { runGit } from '../src/routes/workspace-git.js';
import { rmDirSafe, withTimeout } from './fixtures.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(TEST_DIR, '..');
const BIN_PATH = join(BACKEND_ROOT, 'bin', 'agent-us.mjs');

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function startHttpServer(handler) {
  return new Promise((resolveListen) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveListen({
        url: `http://127.0.0.1:${port}/v1`,
        port,
        close: () =>
          new Promise((resolveClose) => {
            server.closeAllConnections?.();
            server.close(resolveClose);
          }),
      });
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

function sendOpenAiSseText(res, text, { promptTokens = 20, completionTokens = 8 } = {}) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  res.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-${randomUUID().slice(0, 8)}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-${randomUUID().slice(0, 8)}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendOpenAiSseToolCalls(res, toolCalls, { promptTokens = 24, completionTokens = 16 } = {}) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  toolCalls.forEach((tc, index) => {
    res.write(
      `data: ${JSON.stringify({
        id: `chatcmpl-${randomUUID().slice(0, 8)}`,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              ...(index === 0 ? { role: 'assistant' } : {}),
              tool_calls: [
                {
                  index,
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
  });
  res.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-${randomUUID().slice(0, 8)}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

function flattenMessagesText(messages = []) {
  return messages
    .map((m) => {
      if (typeof m?.content === 'string') return m.content;
      if (Array.isArray(m?.content)) {
        return m.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
      }
      return '';
    })
    .join('\n');
}

function extractSystemText(messages = []) {
  const first = messages[0];
  if (!first || first.role !== 'system') return '';
  if (typeof first.content === 'string') return first.content;
  if (Array.isArray(first.content)) {
    return first.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
  }
  return '';
}

async function apiJson(baseUrl, token, method, path, body = undefined) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

async function waitTurnTerminal(baseUrl, token, sessionId, turnId, timeoutMs = 10000) {
  return withTimeout(
    (async () => {
      while (true) {
        const res = await apiJson(baseUrl, token, 'GET', `/v1/sessions/${sessionId}/turns?limit=20`);
        const turn = (res.json?.items ?? []).find((t) => t.id === turnId);
        if (turn && ['completed', 'failed', 'cancelled'].includes(turn.state)) {
          return turn;
        }
        await delay(25);
      }
    })(),
    timeoutMs,
    `turn ${turnId} terminal`,
  );
}

async function subscribeSessionEvents(baseUrl, token, sessionId, onEvent, abortController) {
  const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/stream?after=0`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal: abortController.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let currentEvent = '';
  let dataLines = [];

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nlIdx;
        while ((nlIdx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nlIdx).replace(/\r$/, '');
          buf = buf.slice(nlIdx + 1);
          if (line === '') {
            if (dataLines.length > 0) {
              const raw = dataLines.join('\n');
              dataLines = [];
              const evtType = currentEvent || 'message';
              currentEvent = '';
              try {
                onEvent(evtType, JSON.parse(raw));
              } catch {
                // ignore keepalive comments/non-json lines
              }
            } else {
              currentEvent = '';
            }
          } else if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      }
    } catch {
      // expected on abortController.abort()
    }
  })();
}

function runCliSubprocess(args, { stdinText = '', cwd, env = {} }) {
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
    child.on('close', (code) => resolveProc({ code, stdout, stderr }));
    if (stdinText) child.stdin.end(stdinText);
    else child.stdin.end();
  });
}

test('Agent_US 3.0 full-product E2E: onboarding import -> /cmd + live steer + 429 failover -> file revert + <50ms rewind/redo -> git stage/secret-block/commit/merge -> CLI pipe + --resume sync', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-us-30-e2e-')));
  const dataDir = join(root, 'data');
  const workDir = join(root, 'repo');
  const fakeHome = join(root, 'home');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });

  const prevTestHome = process.env.AGENT_US_TEST_HOMEDIR;
  process.env.AGENT_US_TEST_HOMEDIR = fakeHome;
  t.after(() => {
    if (prevTestHome === undefined) delete process.env.AGENT_US_TEST_HOMEDIR;
    else process.env.AGENT_US_TEST_HOMEDIR = prevTestHome;
    rmDirSafe(root);
  });

  // 1. Initialize temp Git repo with main + feat/release-notes branch, pre-existing dirty edit & untracked file
  await runGit(workDir, ['init', '-b', 'main']);
  await runGit(workDir, ['config', 'user.name', 'Integration Verifier']);
  await runGit(workDir, ['config', 'user.email', 'verify@agent-us.local']);
  writeFileSync(join(workDir, 'app.js'), 'export const version = 1;\n', 'utf8');
  writeFileSync(join(workDir, 'notes.txt'), 'base note\n', 'utf8');
  await runGit(workDir, ['add', '.']);
  await runGit(workDir, ['commit', '-m', 'chore: baseline repo']);

  await runGit(workDir, ['checkout', '-b', 'feat/release-notes']);
  writeFileSync(join(workDir, 'RELEASE.md'), '# Release 3.0\nMerged cleanly.\n', 'utf8');
  await runGit(workDir, ['add', 'RELEASE.md']);
  await runGit(workDir, ['commit', '-m', 'docs: add release notes']);
  await runGit(workDir, ['checkout', 'main']);

  // Pre-existing dirty user edit + untouched user untracked file + sensitive fixtures
  writeFileSync(join(workDir, 'notes.txt'), 'dirty user note — preserve me\n', 'utf8');
  const scratchPath = join(workDir, 'user-scratch.txt');
  writeFileSync(scratchPath, 'keep untouched\n', 'utf8');
  const untouchedTime = new Date('2024-02-02T00:00:00Z');
  utimesSync(scratchPath, untouchedTime, untouchedTime);
  writeFileSync(join(workDir, '.env'), 'SECRET_KEY=super_secret_env_value\n', 'utf8');
  writeFileSync(join(workDir, '.env.example'), 'SECRET_KEY=changeme\n', 'utf8');
  writeFileSync(join(workDir, 'priv.key'), '-----BEGIN PRIVATE KEY-----\nDUMMY\n', 'utf8');

  // 2. Populate isolated ~/.claude and ~/.codex fixtures inside AGENT_US_TEST_HOMEDIR
  mkdirSync(join(fakeHome, '.claude', 'commands'), { recursive: true });
  mkdirSync(join(fakeHome, '.claude', 'skills', 'perf-check'), { recursive: true });
  mkdirSync(join(fakeHome, '.codex', 'skills', 'codex-lint'), { recursive: true });

  const claudeMdPath = join(fakeHome, '.claude', 'CLAUDE.md');
  const claudeCmdPath = join(fakeHome, '.claude', 'commands', 'audit-fix.md');
  const claudeSkillPath = join(fakeHome, '.claude', 'skills', 'perf-check', 'SKILL.md');
  const claudeJsonPath = join(fakeHome, '.claude.json');
  const codexAgentsPath = join(fakeHome, '.codex', 'AGENTS.md');
  const codexSkillPath = join(fakeHome, '.codex', 'skills', 'codex-lint', 'SKILL.md');

  writeFileSync(claudeMdPath, '# Claude Global\nUSER_CLAUDE_RULE_MARKER\n', 'utf8');
  writeFileSync(
    claudeCmdPath,
    '---\ndescription: Audit and patch target\n---\nAudit and patch $ARGUMENTS cleanly.\n',
    'utf8',
  );
  writeFileSync(
    claudeSkillPath,
    '---\nname: perf-check\ndescription: Profile hot path\n---\nInspect bottlenecks.\n',
    'utf8',
  );
  writeFileSync(
    claudeJsonPath,
    JSON.stringify(
      {
        mcpServers: {
          ext_github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_TOKEN: 'ghp_TestSecretIntegration999999' },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(codexAgentsPath, '# Codex Global\nUSER_CODEX_AGENTS_MARKER\n', 'utf8');
  writeFileSync(
    codexSkillPath,
    '---\nname: codex-lint\ndescription: Codex linter\n---\nLint files cleanly.\n',
    'utf8',
  );

  const externalSourcePaths = [
    claudeMdPath,
    claudeCmdPath,
    claudeSkillPath,
    claudeJsonPath,
    codexAgentsPath,
    codexSkillPath,
  ];
  const initialHashes = new Map(externalSourcePaths.map((p) => [p, sha256File(p)]));

  // 3. Start two scripted OpenAI-compatible HTTP upstream servers
  const primaryRequests = [];
  const standbyRequests = [];
  let forcePrimary429 = false;
  let standbyStep = 0;

  const upstreamPrimary = await startHttpServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    const body = await readJsonBody(req);
    primaryRequests.push(body);
    if (forcePrimary429) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: { message: 'Primary upstream rate limited (429)' } }));
      return;
    }
    sendOpenAiSseText(res, 'Baseline turn complete.');
  });

  const upstreamStandby = await startHttpServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    const body = await readJsonBody(req);
    standbyRequests.push(body);
    standbyStep += 1;

    if (standbyStep === 1) {
      // Turn 2 step 1 (after 429 failover): modify app.js and create gen/side.txt via bash
      sendOpenAiSseToolCalls(res, [
        {
          id: 'tc-write-app-1',
          name: 'write_file',
          arguments: { path: 'app.js', content: 'export const version = 2;\n' },
        },
        {
          id: 'tc-bash-gen-1',
          name: 'bash',
          arguments: {
            command:
              'node -e "const fs=require(\'fs\');fs.mkdirSync(\'gen\',{recursive:true});fs.writeFileSync(\'gen/side.txt\',\'from bash\\n\');"',
          },
        },
      ]);
      return;
    }

    if (standbyStep === 2) {
      // Turn 2 step 2 (after live steer injection): apply steered flag & verify syntax with bash
      sendOpenAiSseToolCalls(res, [
        {
          id: 'tc-write-app-2',
          name: 'write_file',
          arguments: { path: 'app.js', content: 'export const version = 2;\nexport const steered = true;\n' },
        },
        {
          id: 'tc-bash-verify-2',
          name: 'bash',
          arguments: { command: 'node --check app.js' },
        },
      ]);
      return;
    }

    if (standbyStep === 3) {
      sendOpenAiSseText(res, 'Patched app.js with steered flag and verified.');
      return;
    }

    if (standbyStep === 4) {
      sendOpenAiSseText(res, 'CLI piped summary ok.');
      return;
    }

    sendOpenAiSseText(res, 'CLI resumed turn ok.');
  });

  // 4. Boot Store, AccountPool, DirectAgentRuntime, and live Fastify /v1/* HTTP server
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  const accPrimary = pool.createAccount({
    preset: 'openai',
    label: 'Primary-429',
    priority: 10,
    endpoint: upstreamPrimary.url,
    credential: 'sk-primary-e2e-1111111111',
  });
  const accStandby = pool.createAccount({
    preset: 'openai',
    label: 'Standby-Healthy',
    priority: 20,
    endpoint: upstreamStandby.url,
    credential: 'sk-standby-e2e-2222222222',
  });
  pool.addManualModel({ accountId: accPrimary.id, upstreamModel: 'gpt-30-e2e' });
  pool.addManualModel({ accountId: accStandby.id, upstreamModel: 'gpt-30-e2e' });
  pool.setDefaultModel('gpt-30-e2e');

  const token = 'integration-30-dev-token-1234567890';
  writeFileSync(join(dataDir, '.dev-token'), token, 'utf8');

  const directAgent = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
  });
  const app = api(store, token, { models: [], list: () => [] }, { pool, directAgent });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

  t.after(async () => {
    await directAgent.close();
    await app.close();
    await Promise.all([upstreamPrimary.close(), upstreamStandby.close()]);
    store.close();
  });

  // ---- Stage A: Zero silent injection before import -> Detect -> Selective Import ----
  const sessRes = await apiJson(baseUrl, token, 'POST', '/v1/sessions', {
    title: 'E2E 3.0 Product Session',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
  });
  assert.equal(sessRes.status, 200);
  const sessionId = sessRes.json.id;

  const customBefore = await apiJson(baseUrl, token, 'GET', `/v1/workspace/customizations?sessionId=${sessionId}`);
  assert.equal(customBefore.status, 200);
  assert.equal(customBefore.json.commands.length, 0);
  assert.equal(customBefore.json.skills.length, 0);
  assert.equal(customBefore.json.mcpServers.length, 0);

  const t1Res = await apiJson(baseUrl, token, 'POST', `/v1/sessions/${sessionId}/turns`, {
    input: 'Baseline status check',
  });
  assert.equal(t1Res.status, 200);
  const t1Done = await waitTurnTerminal(baseUrl, token, sessionId, t1Res.json.turn.id);
  assert.equal(t1Done.state, 'completed');
  assert.equal(primaryRequests.length, 1);

  const staticSystemPrompt = extractSystemText(primaryRequests[0].messages);
  assert.ok(staticSystemPrompt.length > 50, 'static system prompt should be populated');
  const t1PromptText = flattenMessagesText(primaryRequests[0].messages);
  assert.equal(t1PromptText.includes('USER_CLAUDE_RULE_MARKER'), false, 'zero silent ~/.claude injection before import');
  assert.equal(t1PromptText.includes('USER_CODEX_AGENTS_MARKER'), false, 'zero silent ~/.codex injection before import');

  const detectRes = await apiJson(baseUrl, token, 'GET', `/v1/onboarding/detect-external?sessionId=${sessionId}`);
  assert.equal(detectRes.status, 200);
  assert.equal(detectRes.json.promptNeeded, true);
  assert.ok(detectRes.json.providers.includes('claude'));
  assert.ok(detectRes.json.providers.includes('codex'));
  assert.equal(detectRes.text.includes('ghp_TestSecretIntegration999999'), false, 'secrets must be redacted');

  const selectedIds = detectRes.json.items
    .filter((item) => item.name !== 'perf-check')
    .map((item) => item.id);
  assert.ok(selectedIds.length >= 5, 'should select claude rule/cmd/mcp and codex rule/skill while omitting perf-check');

  const importRes = await apiJson(baseUrl, token, 'POST', '/v1/onboarding/import-external', {
    sessionId,
    action: 'import',
    itemIds: selectedIds,
    targetScope: 'auto',
  });
  assert.equal(importRes.status, 200);
  assert.equal(importRes.json.ok, true);
  assert.equal(importRes.json.action, 'import');
  assert.equal(importRes.json.promptNeeded, false);
  assert.equal(importRes.json.importedCount, selectedIds.length);

  assert.ok(existsSync(join(dataDir, 'rules', 'claude-user.md')));
  assert.ok(existsSync(join(dataDir, 'commands', 'audit-fix.md')));
  assert.ok(existsSync(join(dataDir, 'rules', 'codex-agents.md')));
  assert.ok(existsSync(join(dataDir, 'skills', 'codex-lint', 'SKILL.md')));
  assert.ok(existsSync(join(dataDir, 'mcp-imported.json')));
  assert.equal(existsSync(join(dataDir, 'skills', 'perf-check', 'SKILL.md')), false, 'unselected item must not be imported');

  const importedMcp = JSON.parse(readFileSync(join(dataDir, 'mcp-imported.json'), 'utf8'));
  assert.equal(importedMcp.mcpServers.ext_github.disabled, true);
  assert.equal(importedMcp.mcpServers.ext_github.trusted, false);
  assert.equal(importedMcp.mcpServers.ext_github.env.GITHUB_TOKEN, '[REDACTED]');

  const detectAfter = await apiJson(baseUrl, token, 'GET', `/v1/onboarding/detect-external?sessionId=${sessionId}`);
  assert.equal(detectAfter.status, 200);
  assert.equal(detectAfter.json.promptNeeded, false);

  const customAfter = await apiJson(baseUrl, token, 'GET', `/v1/workspace/customizations?sessionId=${sessionId}`);
  assert.equal(customAfter.status, 200);
  assert.ok(customAfter.json.commands.some((c) => c.name === 'audit-fix'));
  assert.ok(customAfter.json.skills.some((s) => s.name === 'codex-lint'));

  for (const srcPath of externalSourcePaths) {
    assert.equal(sha256File(srcPath), initialHashes.get(srcPath), `external source must remain byte-identical: ${srcPath}`);
  }

  // ---- Stage B: Imported /cmd + Live Mid-Turn Steer + Upstream 429 Hot-Standby Failover ----
  forcePrimary429 = true;
  const sseAbort = new AbortController();
  const observedSse = [];
  let steerTriggered = false;
  let steerRespPromise = null;

  await subscribeSessionEvents(
    baseUrl,
    token,
    sessionId,
    (evtType, payload) => {
      observedSse.push({ type: payload?.type ?? evtType, data: payload?.data ?? payload });
      const effectiveType = payload?.type ?? evtType;
      if (effectiveType === 'tool/call' && !steerTriggered) {
        steerTriggered = true;
        steerRespPromise = apiJson(baseUrl, token, 'POST', `/v1/sessions/${sessionId}/steer`, {
          input: 'Also set export const steered = true in app.js and verify',
        });
      }
    },
    sseAbort,
  );

  const t2Res = await apiJson(baseUrl, token, 'POST', `/v1/sessions/${sessionId}/turns`, {
    input: '/audit-fix app.js',
  });
  assert.equal(t2Res.status, 200);
  const turn2Id = t2Res.json.turn.id;
  const t2Done = await waitTurnTerminal(baseUrl, token, sessionId, turn2Id, 12000);
  assert.equal(t2Done.state, 'completed');
  if (steerRespPromise) {
    const steerAck = await steerRespPromise;
    assert.equal(steerAck.status, 200);
    assert.equal(steerAck.json.steered, true);
  } else {
    assert.fail('Live steer was never triggered during tool/call');
  }
  await delay(50);
  sseAbort.abort();

  assert.ok(standbyRequests.length >= 3, `expected standby to handle all Turn 2 steps, got ${standbyRequests.length}`);
  assert.equal(
    extractSystemText(standbyRequests[0].messages),
    staticSystemPrompt,
    'static system prompt prefix must stay byte-identical across import and failover',
  );
  assert.equal(
    extractSystemText(standbyRequests[1].messages),
    staticSystemPrompt,
    'static system prompt prefix must stay byte-identical after live steer injection',
  );

  const step1Text = flattenMessagesText(standbyRequests[0].messages);
  assert.match(step1Text, /Audit and patch app\.js cleanly\./);
  assert.match(step1Text, /USER_CLAUDE_RULE_MARKER/);
  assert.match(step1Text, /USER_CODEX_AGENTS_MARKER/);

  const step2Tail = standbyRequests[1].messages.at(-1);
  assert.equal(step2Tail.role, 'user');
  assert.match(flattenMessagesText([step2Tail]), /Also set export const steered = true in app\.js and verify/);

  const failoverEvents = observedSse.filter((e) => e.type === 'turn/route_failover');
  assert.equal(failoverEvents.length, 1);
  assert.equal(failoverEvents[0].data.statusCode, 429);
  assert.equal(failoverEvents[0].data.fromAccountId, accPrimary.id);
  assert.equal(failoverEvents[0].data.toAccountId, accStandby.id);

  const steerEvents = observedSse.filter((e) => e.type === 'turn/steer_injected');
  assert.equal(steerEvents.length, 1);
  assert.equal(pool.getAccount(accPrimary.id).status, 'cooldown');
  assert.equal(pool.getAccount(accStandby.id).status, 'healthy');

  assert.equal(readFileSync(join(workDir, 'app.js'), 'utf8'), 'export const version = 2;\nexport const steered = true;\n');
  assert.equal(readFileSync(join(workDir, 'gen/side.txt'), 'utf8'), 'from bash\n');

  // ---- Stage C: Single-file revert + <50ms zero-token Instant Rewind & Redo ----
  const callsBeforeRewind = primaryRequests.length + standbyRequests.length;
  const revertFileRes = await apiJson(baseUrl, token, 'POST', `/v1/sessions/${sessionId}/rewind/file`, {
    path: 'gen/side.txt',
    turnId: turn2Id,
  });
  assert.equal(revertFileRes.status, 200);
  assert.equal(revertFileRes.json.ok, true);
  assert.equal(revertFileRes.json.action, 'deleted');
  assert.equal(existsSync(join(workDir, 'gen/side.txt')), false);
  assert.equal(existsSync(join(workDir, 'gen')), false, 'newly created empty dir should be pruned');
  assert.equal(
    readFileSync(join(workDir, 'app.js'), 'utf8'),
    'export const version = 2;\nexport const steered = true;\n',
    'single-file revert must preserve other edited files',
  );

  const rewindRes = await apiJson(baseUrl, token, 'POST', `/v1/sessions/${sessionId}/rewind`, {
    turnId: turn2Id,
    scope: 'files',
  });
  assert.equal(rewindRes.status, 200);
  assert.equal(rewindRes.json.ok, true);
  assert.ok(rewindRes.json.durationMs < 50, `expected <50ms rewind, got ${rewindRes.json.durationMs}ms`);
  assert.equal(primaryRequests.length + standbyRequests.length, callsBeforeRewind, 'rewind must use zero LLM calls');
  assert.equal(readFileSync(join(workDir, 'app.js'), 'utf8').replace(/\r\n/g, '\n'), 'export const version = 1;\n');
  assert.equal(readFileSync(join(workDir, 'notes.txt'), 'utf8'), 'dirty user note — preserve me\n');
  assert.equal(readFileSync(scratchPath, 'utf8'), 'keep untouched\n');
  assert.equal(statSync(scratchPath).mtimeMs, untouchedTime.getTime());

  const redoRes = await apiJson(baseUrl, token, 'POST', `/v1/sessions/${sessionId}/rewind/redo`, {
    redoId: rewindRes.json.redoId,
  });
  assert.equal(redoRes.status, 200);
  assert.equal(redoRes.json.ok, true);
  assert.ok(redoRes.json.durationMs < 50, `expected <50ms redo, got ${redoRes.json.durationMs}ms`);
  assert.equal(primaryRequests.length + standbyRequests.length, callsBeforeRewind, 'redo must use zero LLM calls');
  assert.equal(
    readFileSync(join(workDir, 'app.js'), 'utf8'),
    'export const version = 2;\nexport const steered = true;\n',
  );

  // ---- Stage D: Git Stage, Sensitive-file Block, Unstage, Commit & Branch Merge ----
  const changesRes = await apiJson(baseUrl, token, 'GET', `/v1/git/changes?sessionId=${sessionId}`);
  assert.equal(changesRes.status, 200);
  assert.equal(changesRes.json.available, true);
  assert.equal(changesRes.json.branch, 'main');
  assert.ok(changesRes.json.blockedSensitive.includes('.env'));
  assert.ok(changesRes.json.blockedSensitive.includes('priv.key'));
  assert.equal(changesRes.json.blockedSensitive.includes('.env.example'), false);

  const blockStageRes = await apiJson(baseUrl, token, 'POST', '/v1/git/stage', {
    sessionId,
    paths: ['.env'],
  });
  assert.equal(blockStageRes.status, 400);
  assert.equal(blockStageRes.json.error.code, 'GIT_SENSITIVE_FILE_BLOCKED');

  const stageRes = await apiJson(baseUrl, token, 'POST', '/v1/git/stage', {
    sessionId,
    paths: ['app.js', '.env.example'],
  });
  assert.equal(stageRes.status, 200);
  assert.ok(stageRes.json.staged.some((s) => s.path === 'app.js'));
  assert.ok(stageRes.json.staged.some((s) => s.path === '.env.example'));

  const unstageRes = await apiJson(baseUrl, token, 'POST', '/v1/git/unstage', {
    sessionId,
    paths: ['.env.example'],
  });
  assert.equal(unstageRes.status, 200);
  assert.equal(unstageRes.json.staged.some((s) => s.path === '.env.example'), false);
  assert.ok(existsSync(join(workDir, '.env.example')));

  const commitRes = await apiJson(baseUrl, token, 'POST', '/v1/git/commit', {
    sessionId,
    message: 'feat(3.0): commit steered audit fix',
  });
  assert.equal(commitRes.status, 200);
  assert.equal(commitRes.json.ok, true);
  assert.equal(commitRes.json.commitSha.length, 40);
  assert.deepEqual(commitRes.json.filesCommitted, ['app.js']);

  const mergeRes = await apiJson(baseUrl, token, 'POST', '/v1/git/merge', {
    sessionId,
    sourceBranch: 'feat/release-notes',
    noFf: true,
    message: 'merge release notes',
  });
  assert.equal(mergeRes.status, 200);
  assert.equal(mergeRes.json.ok, true);
  assert.equal(readFileSync(join(workDir, 'RELEASE.md'), 'utf8').replace(/\r\n/g, '\n'), '# Release 3.0\nMerged cleanly.\n');

  // ---- Stage E: agent-us CLI stdin pipe + --resume syncing via shared /v1/sessions store ----
  const cliProc1 = await runCliSubprocess(
    ['--url', baseUrl, '--data-dir', dataDir, '--cwd', workDir, '--yes', '--no-autostart', 'Inspect and summarize'],
    { cwd: workDir, stdinText: 'FAIL: smoke check\n' },
  );
  assert.equal(cliProc1.code, 0, cliProc1.stderr);
  assert.match(cliProc1.stdout, /CLI piped summary ok\./);
  assert.match(cliProc1.stdout, /\[completed\]/);

  const sessionsRes = await apiJson(baseUrl, token, 'GET', '/v1/sessions?scope=chats');
  assert.equal(sessionsRes.status, 200);
  assert.equal(sessionsRes.json.items.length, 2);
  const cliSession = sessionsRes.json.items.find((s) => s.id !== sessionId);
  assert.ok(cliSession, 'CLI session must appear in shared /v1/sessions store');

  const cliMsgsRes = await apiJson(baseUrl, token, 'GET', `/v1/sessions/${cliSession.id}/messages?after=0&limit=50`);
  assert.equal(cliMsgsRes.status, 200);
  assert.ok(
    cliMsgsRes.json.items.some((m) => String(m.content || '').includes('<piped_stdin>\nFAIL: smoke check\n</piped_stdin>')),
  );

  const cliProc2 = await runCliSubprocess(
    ['--resume', cliSession.id, '--url', baseUrl, '--data-dir', dataDir, '--cwd', workDir, '--yes', '--no-autostart'],
    { cwd: workDir, stdinText: '/commands\nFollow-up after resume\n' },
  );
  assert.equal(cliProc2.code, 0, cliProc2.stderr);
  assert.match(cliProc2.stdout, new RegExp(`\\[session\\] resumed ${cliSession.id}`));
  assert.match(cliProc2.stdout, /\/audit-fix/);
  assert.match(cliProc2.stdout, /CLI resumed turn ok\./);

  const cliTurnsRes = await apiJson(baseUrl, token, 'GET', `/v1/sessions/${cliSession.id}/turns?limit=20`);
  assert.equal(cliTurnsRes.status, 200);
  assert.equal(cliTurnsRes.json.items.length, 2);

  for (const srcPath of externalSourcePaths) {
    assert.equal(sha256File(srcPath), initialHashes.get(srcPath), `external source unchanged after full E2E: ${srcPath}`);
  }
});
