import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { api } from '../src/api.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handlers) {
    super();
    this.handlers = handlers;
    this.calls = [];
  }
  async *stream(options) {
    const idx = this.calls.length;
    this.calls.push(options);
    const fn = this.handlers[idx] ?? this.handlers.at(-1);
    yield* fn(options);
  }
}

async function waitTurnDone(directAgent, sessionId, turnId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = directAgent.listTurns(sessionId).find((x) => x.id === turnId);
    if (t && ['completed', 'failed', 'cancelled'].includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Timed out waiting for turn');
}

test('DirectAgent handles direct multi-turn chat, real workspace tools, and interactive approvals without DAG', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-direct-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-direct-work-'));
  writeFileSync(join(workDir, 'hello.txt'), 'line1\nhello world\nline3\n', 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-coder');

  const scripted = new ScriptedAdapter([
    // Turn 1: simple direct chat reply with streaming deltas (no DAG!)
    async function* () {
      yield { type: 'text-delta', index: 0, text: '你好！' };
      yield { type: 'text-delta', index: 0, text: '直接对话已就绪。' };
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    // Turn 2 step 1: read_file + edit_file on real workspace file
    async function* (opts) {
      // Verify multi-turn memory includes Turn 1!
      const userTexts = opts.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content[0].text);
      assert.ok(userTexts.some((t) => t.includes('你好')));
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-read',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'hello.txt' }),
        },
      };
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'tc-edit',
          name: 'edit_file',
          arguments: JSON.stringify({
            path: 'hello.txt',
            target: 'hello world',
            replacement: 'hello Claude Code',
          }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Turn 2 step 2: final concise reply after tool execution
    async function* () {
      yield { type: 'text-delta', index: 0, text: '已将 hello.txt 修改完成。' };
      yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 12 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  ]);

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    adapter: scripted,
  });
  const token = 'test-token-with-more-than-24-chars-123456';
  const app = api(store, token, { models: [], list: () => [] }, {
    pool,
    directAgent: direct,
  });

  try {
    // Health endpoint works without auth
    const h = await app.inject({ method: 'GET', url: '/v1/health' });
    assert.equal(h.statusCode, 200);
    assert.equal(h.json().ok, true);

    const headers = { authorization: `Bearer ${token}` };

    // Create direct session
    const sRes = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: { title: 'Direct Test', permissionMode: 'approval' },
    });
    assert.equal(sRes.statusCode, 200);
    const session = sRes.json();

    // Capture live ephemeral streaming deltas
    const deltas = [];
    const unsub = direct.subscribe(session.id, (ev) => {
      if (ev.type === 'assistant/delta') deltas.push(ev.data.delta);
    });

    // Turn 1: simple greeting
    const t1Res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/turns`,
      headers,
      payload: { input: '你好，测试一下直接对话' },
    });
    assert.equal(t1Res.statusCode, 200);
    const t1 = await waitTurnDone(direct, session.id, t1Res.json().turn.id);
    assert.equal(t1.state, 'completed');
    assert.deepEqual(deltas, ['你好！', '直接对话已就绪。']);

    // Turn 2: edit_file requires approval in 'approval' mode
    const t2Res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/turns`,
      headers,
      payload: { input: '把 hello.txt 里的 hello world 改成 hello Claude Code' },
    });
    const t2Id = t2Res.json().turn.id;

    // Wait for approval request
    let pending = [];
    for (let i = 0; i < 40; i++) {
      const aRes = await app.inject({
        method: 'GET',
        url: `/v1/approvals?sessionId=${session.id}&status=pending`,
        headers,
      });
      pending = aRes.json().items;
      if (pending.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(pending.length, 1);
    assert.equal(pending[0].tool, 'edit_file');

    // Approve via /v1/approvals/:id/decision
    const decRes = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${pending[0].id}/decision`,
      headers,
      payload: { decision: 'allow', scope: 'once' },
    });
    assert.equal(decRes.statusCode, 200);

    const t2 = await waitTurnDone(direct, session.id, t2Id);
    assert.equal(t2.state, 'completed');
    assert.equal(
      readFileSync(join(workDir, 'hello.txt'), 'utf8'),
      'line1\nhello Claude Code\nline3\n',
    );

    // Verify ledger integrity remains 100% valid
    assert.equal(store.verifyIntegrity({ full: true }).ok, true);

    unsub();
  } finally {
    await app.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
