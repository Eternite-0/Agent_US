import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, id } from '../src/store.js';
import { toolset } from '../src/tools.js';
import {
  estimateTokens,
  foldRepeatedNumericLines,
  guardToolOutput,
  pairClosed,
  chooseCut,
  compactTwoStage,
  liveContextNotes,
  ContextPolicy,
} from '../src/context.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('estimateTokens weights CJK and ASCII according to unified formula', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('测试中文字符'), Math.ceil(6 / 1.7));
});

test('foldRepeatedNumericLines collapses counter runs and guardToolOutput spills large blobs to artifact://', async (t) => {
  const lines = [];
  for (let i = 1; i <= 30; i++) lines.push(`Processing item ${i}/30 (${i * 3}%)`);
  const folded = foldRepeatedNumericLines(lines.join('\n'));
  assert.match(folded, /Processing item 1\/30/);
  assert.match(folded, /\[\.\.\. 28 similar numeric lines folded \.\.\.\]/);
  assert.match(folded, /Processing item 30\/30/);

  const store = new Store(':memory:');
  t.after(() => store.close());
  const huge = 'HEAD_MARKER_' + 'x'.repeat(25000) + '_TAIL_MARKER';
  const guarded = guardToolOutput('shell', huge, store, { maxChars: 4000 });
  assert.match(guarded, /HEAD_MARKER_/);
  assert.match(guarded, /_TAIL_MARKER/);
  const match = guarded.match(/artifact:\/\/[0-9a-f]{64}/);
  assert.ok(match, 'expected artifact:// URI in spilled tool output');

  // Verify read_blob tool retrieves exact full original payload with pagination.
  const p = store.add('projects', { name: 'blob' });
  const task = store.submit({ projectId: p.id, input: 'x', idempotencyKey: '1' });
  const ctx = {
    store,
    task,
    worker: { id: id() },
    node: { id: id(), role: 'Researcher', dependencies: [] },
    job: { id: id(), fence: 'f' },
    signal: AbortSignal.timeout(5000),
    guard: () => {},
  };
  const readBlob = toolset(ctx, { includeReadBlob: true }).find(
    (x) => x.name === 'read_blob',
  );
  assert.ok(readBlob);
  const page = JSON.parse(
    await readBlob.execute(
      { uri: match[0], offset: huge.length - 12, limit: 100 },
      { signal: ctx.signal, callId: id() },
    ),
  );
  assert.equal(page.content, '_TAIL_MARKER');
  assert.equal(page.hasMore, false);
});

test('pairClosed and chooseCut preserve atomic assistant/tool-result boundaries', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'u1 '.repeat(500) }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{}' }],
    },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'r1 '.repeat(1500) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    { role: 'user', content: [{ type: 'text', text: 'latest question' }] },
  ];

  // Splitting between assistant(idx 2) and tool(idx 3) is forbidden.
  assert.equal(pairClosed(messages, 1, 2), false);
  // Including both assistant(2) and tool(3) is valid.
  assert.equal(pairClosed(messages, 1, 3), true);

  const cut = chooseCut(messages, 200);
  assert.ok(cut);
  assert.equal(pairClosed(messages, cut.start, cut.cut - 1), true);
  assert.notEqual(messages[cut.cut].role, 'tool');
});

test('compactTwoStage prunes oversized tool outputs at Stage 1 without LLM, and invokes Stage 2 summary when needed', async () => {
  const bigTool = 'A'.repeat(24000);
  const baseMsgs = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'start task' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: 'shell', arguments: '{}' }],
    },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: bigTool }] },
    { role: 'assistant', content: [{ type: 'text', text: 'step done' }] },
    { role: 'user', content: [{ type: 'text', text: 'continue' }] },
  ];

  let llmSummaryCalls = 0;
  const stage1 = await compactTwoStage(
    { messages: baseMsgs },
    {
      contextWindow: 6000,
      reserveTokens: 1500,
      keepRecentTokens: 100,
      summarize: async () => {
        llmSummaryCalls++;
        return 'summary';
      },
    },
  );
  assert.equal(stage1.stage, 'prune');
  assert.equal(llmSummaryCalls, 0);
  assert.equal(stage1.options.messages[3].toolCallId, 'c1');
  assert.match(stage1.options.messages[3].content[0].text, /compacted/);
  // Original caller message must remain unmutated.
  assert.equal(baseMsgs[3].content[0].text.length, 24000);

  // Stage 2: many moderate user/assistant messages that Stage 1 cannot prune -> invokes summarize.
  const longConv = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    ...Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `turn ${i} ` + 'word '.repeat(500) }],
    })),
    { role: 'user', content: [{ type: 'text', text: 'final step' }] },
  ];
  const stage2 = await compactTwoStage(
    { messages: longConv },
    {
      contextWindow: 4000,
      reserveTokens: 1000,
      keepRecentTokens: 200,
      summarize: async (span) => {
        llmSummaryCalls++;
        return `Goals: test; Summarized ${span.length} messages.`;
      },
    },
  );
  assert.equal(stage2.stage, 'summary');
  assert.equal(llmSummaryCalls, 1);
  assert.match(stage2.options.messages[1].content[0].text, /\[compacted summary\]/);
  assert.equal(stage2.options.messages.at(-1).content[0].text, 'final step');
});

test('liveContextNotes emits diff-only upserts and CLEARED tombstones', () => {
  const first = liveContextNotes(
    [{ source: 'repo', id: 'AGENTS.md', text: 'Rule A' }],
    [],
  );
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'upsert');

  const history = [
    { role: 'user', content: [{ type: 'text', text: first[0].text }] },
  ];
  // Identical section -> zero delta notes (preserves KV cache).
  const unchanged = liveContextNotes(
    [{ source: 'repo', id: 'AGENTS.md', text: 'Rule A' }],
    history,
  );
  assert.equal(unchanged.length, 0);

  // Removed section -> emits explicit CLEARED tombstone.
  const removed = liveContextNotes([], history);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].kind, 'cleared');
  assert.match(removed[0].text, /This context item no longer applies\./);
});

test('ContextPolicy.observe records cacheReadTokens and structured telemetry.step without payload leakage', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tele-'));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const p = store.add('projects', { name: 'tele' });
  const task = store.submit({ projectId: p.id, input: 'secret-input', idempotencyKey: '1' });
  const policy = new ContextPolicy(root, store);
  const exec = {
    guard: () => {},
    task,
    session: { id: 'sess-1' },
    worker: { role: 'Coder' },
    model: { provider: 'fixture', model: 'm1', inputRate: 1, outputRate: 2 },
  };
  policy.observe('usage', exec, {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 800,
    cacheWriteTokens: 50,
  });
  policy.observe('telemetry.step', exec, {
    step: 1,
    compactionStage: 'none',
    composition: {
      systemTokens: 120,
      toolSchemaTokens: 80,
      historyTokens: 200,
      toolResultTokens: 100,
      totalTokens: 500,
      toolResultCount: 1,
      largestToolResultBytes: 400,
    },
    modelDurationMs: 320,
    toolDurationMs: 45,
  });
  const [u] = store.list('usage', { taskId: task.id });
  assert.equal(u.cacheReadTokens, 800);
  assert.equal(u.cacheWriteTokens, 50);
  const events = store.events(0, task.id);
  const tele = events.find((e) => e.type === 'telemetry.step');
  assert.ok(tele);
  assert.equal(tele.payload.totalTokens, 500);
  assert.equal(tele.payload.modelDurationMs, 320);
  assert.doesNotMatch(JSON.stringify(tele), /secret-input/);
});
