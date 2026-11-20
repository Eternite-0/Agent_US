import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { ProjectMemoryService } from '../src/context/memory.js';
import { MultiStageCompactor } from '../src/context/compaction.js';
import { TokenBudgetManager } from '../src/context/budget.js';

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
      messages: structuredClone(options.messages),
    });
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

test('P4 ContextAssembler preserves KV Prompt Cache prefix across turns and appends volatile diffs at tail', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p4-cache-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-p4-cache-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-coder');

  const scripted = new ScriptedAdapter([
    // Turn 1
    async function* () {
      yield { type: 'text-delta', index: 0, text: '第一轮完成。' };
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    // Turn 2
    async function* () {
      yield { type: 'text-delta', index: 0, text: '收到更新记忆与图像。' };
      yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 12 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  ]);

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: scripted,
  });

  try {
    direct.memoryService.remember({
      scopeType: 'workspace',
      scopeId: workDir,
      key: 'arch_rule',
      value: '认证层必须使用 WAL 持久化。',
    });

    const s = direct.createSession({ title: 'P4 缓存稳定性测试', workspaceRoot: workDir });
    const t1 = direct.startTurn(s.id, { input: '查看架构约定' });
    assert.equal((await waitTurnDone(direct, s.id, t1.turn.id)).state, 'completed');

    // Mutate workspace memory + plan BEFORE Turn 2
    direct.memoryService.remember({
      scopeType: 'workspace',
      scopeId: workDir,
      key: 'hotfix_note',
      value: '新增约束：禁止修改旧路由兼容层。',
    });
    store.tx(() => {
      store.db
        .prepare('UPDATE direct_sessions SET planJson=? WHERE id=?')
        .run(
          JSON.stringify({ steps: [{ title: '校验热修约束', status: 'in_progress' }] }),
          s.id,
        );
    });

    const pngB64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const t2 = direct.startTurn(s.id, {
      input: '请根据新增约束检查截图',
      files: { 'diagram.png': pngB64 },
    });
    assert.equal((await waitTurnDone(direct, s.id, t2.turn.id)).state, 'completed');

    const call1Msgs = scripted.calls[0].messages;
    const call2Msgs = scripted.calls[1].messages;

    // Exact byte-for-byte prefix preservation (KV Prompt Cache guarantee!)
    assert.equal(
      JSON.stringify(call2Msgs.slice(0, call1Msgs.length)),
      JSON.stringify(call1Msgs),
      'Turn 2 prompt prefix up to prior Turn 1 messages must remain byte-identical',
    );

    // Volatile diffs appear ONLY in tail notes before Turn 2 user message
    const tailText = call2Msgs
      .slice(call1Msgs.length, -1)
      .map((m) => m.content?.map((b) => b.text || '').join('\n'))
      .join('\n');
    assert.match(tailText, /禁止修改旧路由兼容层/);
    assert.match(tailText, /校验热修约束/);

    // Multimodal attachment stays on the last user message
    const lastUser = call2Msgs.findLast((m) => m.role === 'user');
    assert.ok(lastUser.content.some((b) => b.type === 'image'));
  } finally {
    direct.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('P4 MultiStageCompactor performs non-destructive compaction retaining TaskStateAnchor across turns', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p4-comp-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-p4-comp-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-coder');

  const artifactHash = 'a'.repeat(64);
  const scripted = new ScriptedAdapter([
    // Turn 1: edits file + emits artifact URI
    async function* () {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-write-1',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'auth.js', content: 'export const ok = true;\n' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    async function* () {
      yield { type: 'text-delta', index: 0, text: `已生成 artifact://${artifactHash}` };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    // Turns 2 & 3 to build up >6 messages
    async function* () {
      yield { type: 'text-delta', index: 0, text: '第二轮回复完成。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    async function* () {
      yield { type: 'text-delta', index: 0, text: '第三轮回复完成。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    // Compaction LLM summary
    async function* () {
      yield { type: 'text-delta', index: 0, text: '前期已完成 auth.js 初步搭建。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    // Turn 4 post-compaction check
    async function* () {
      yield { type: 'text-delta', index: 0, text: '基于压缩锚点继续工作。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  ]);

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: scripted,
  });

  try {
    const s = direct.createSession({ workspaceRoot: workDir });
    const t1 = direct.startTurn(s.id, {
      input:
        '请重构认证模块。\n必须保留旧版 /api/v1 兼容路由。\n禁止修改 backend/var/ 目录。',
    });
    assert.equal((await waitTurnDone(direct, s.id, t1.turn.id)).state, 'completed');

    const t2 = direct.startTurn(s.id, { input: '继续添加单元测试' });
    assert.equal((await waitTurnDone(direct, s.id, t2.turn.id)).state, 'completed');

    const t3 = direct.startTurn(s.id, { input: '检查边界异常分支' });
    assert.equal((await waitTurnDone(direct, s.id, t3.turn.id)).state, 'completed');

    const msgCountBefore = store.db
      .prepare('SELECT COUNT(*) AS n FROM direct_messages WHERE sessionId=?')
      .get(s.id).n;
    assert.ok(msgCountBefore > 6);

    const compactRes = await direct.compactSession(s.id);
    assert.equal(compactRes.compacted, true);
    assert.ok(compactRes.compactionId);

    // CRITICAL: Non-destructive — ALL direct_messages rows remain in SQLite!
    const msgCountAfter = store.db
      .prepare('SELECT COUNT(*) AS n FROM direct_messages WHERE sessionId=?')
      .get(s.id).n;
    assert.equal(msgCountAfter, msgCountBefore);

    const updatedSess = direct.getSession(s.id);
    assert.equal(updatedSess.activeCompactionId, compactRes.compactionId);

    // Run Turn 4 and inspect prompt seen by model
    const t4 = direct.startTurn(s.id, { input: '汇报当前状态' });
    assert.equal((await waitTurnDone(direct, s.id, t4.turn.id)).state, 'completed');

    const postCompactCall = scripted.calls.at(-1);
    const fullPromptText = postCompactCall.messages
      .map((m) => m.content?.map((b) => b.text || '').join('\n'))
      .join('\n');
    assert.match(fullPromptText, /\[历史上下文摘要\]/);
    assert.match(fullPromptText, /必须保留旧版 \/api\/v1 兼容路由/);
    assert.match(fullPromptText, /禁止修改 backend\/var\//);
    assert.match(fullPromptText, /auth\.js\(created\)/);
    assert.match(fullPromptText, new RegExp(`artifact://${artifactHash}`));

    // Also test Stage-2 auto-summary recording in MultiStageCompactor.prepareRequest
    const longMessages = [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      ...Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `Msg ${i}: ` + 'x'.repeat(1800) }],
      })),
    ];
    const autoOut = await direct.compactor.prepareRequest(
      { messages: longMessages, maxTokens: 1024 },
      {
        contextWindow: 4096,
        sessionId: s.id,
        turnId: t4.turn.id,
        summarize: async () => '自动阶段二摘要内容。',
      },
    );
    assert.equal(autoOut.stage, 'summary');
    const compactions = direct.compactor.listCompactions(s.id);
    assert.ok(compactions.some((c) => c.stage === 'auto-summary'));
  } finally {
    direct.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('P4 ProjectMemoryService redacts secrets, filters withdrawn lessons, and ranks CJK+English matches', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p4-mem-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-p4-mem-work-'));
  mkdirSync(join(workDir, '.agent-us'), { recursive: true });
  writeFileSync(
    join(workDir, '.agent-us', 'MEMORY.md'),
    '# 项目备忘\n认证系统使用 SQLite WAL 与 Fencing Token。\n',
    'utf8',
  );

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const mem = new ProjectMemoryService(store);

  try {
    const saved = mem.remember({
      scopeType: 'workspace',
      scopeId: workDir,
      key: 'auth_token_policy',
      value: '不要泄露 sk-proj-supersecretkey1234567890abcd 或 Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig 密钥',
      kind: 'constraint',
    });
    assert.ok(!saved.value.includes('supersecretkey1234567890abcd'));
    assert.ok(!saved.value.includes('eyJhbGciOiJIUzI1NiJ9'));

    const now = Date.now();
    // Active lesson vs Withdrawn lesson in governed records table
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO records(id, kind, projectId, taskId, version, body)
           VALUES(?, 'memory', NULL, NULL, 1, ?)`,
        )
        .run(
          'rec-active',
          JSON.stringify({
            status: 'active',
            title: '租赁安全经验',
            lesson: '认证令牌轮换后需要清理失效租赁',
            createdAt: now,
          }),
        );
      store.db
        .prepare(
          `INSERT INTO records(id, kind, projectId, taskId, version, body)
           VALUES(?, 'memory', NULL, NULL, 1, ?)`,
        )
        .run(
          'rec-withdrawn',
          JSON.stringify({
            status: 'withdrawn',
            title: '已撤回经验',
            lesson: '认证过时经验 SHOULD_NOT_APPEAR',
            createdAt: now,
          }),
        );
    });

    const out = mem.retrieve({
      query: '认证 令牌 租赁 auth',
      workspaceRoot: workDir,
      limit: 10,
      maxChars: 4000,
    });

    assert.ok(out.text.includes('SQLite WAL'));
    assert.ok(out.text.includes('认证令牌轮换后需要清理失效租赁'));
    assert.ok(!out.text.includes('SHOULD_NOT_APPEAR'));
    assert.ok(!out.text.includes('supersecretkey1234567890abcd'));

    const budget = new TokenBudgetManager();
    const tracker = budget.createContinuationTracker(10000);
    assert.equal(tracker.check(3000).action, 'continue');
    assert.equal(tracker.check(3200).action, 'continue');
    assert.equal(tracker.check(3300).action, 'continue');
    // 4th low-delta check triggers diminishing-returns stop
    assert.equal(tracker.check(3350).action, 'stop');
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
