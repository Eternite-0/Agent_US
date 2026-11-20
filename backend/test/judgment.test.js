import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, id } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { toolset } from '../src/tools.js';
import { JudgmentService } from '../src/judgment.js';
import { model, Script } from './fixtures.js';

test('JudgmentService supports native sys1 HTTP API, redacts secrets, caches results, and degrades safely on timeout', async (t) => {
  const receivedBodies = [];
  let slowMode = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (slowMode) {
      await delay(300);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        answers: { unexpected_stop: { type: 'noul', noul: 0.88 } },
        usage: { inputTokens: 40, outputTokens: 1 },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const usageLog = [];
  const judgment = new JudgmentService({
    provider: {
      kind: 'sys1',
      endpoint: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'agnes-sys1-1.0',
      key: 'test-key',
    },
    uses: { stopCheck: true },
    attemptMs: 100,
  });

  // First call hits server and scrubs secrets before sending!
  const r1 = await judgment.detectPrematureStop({
    requestText: 'Check key sk-proj-secret1234567890abcdef and fix bug',
    replyText: 'I will now inspect the test suite and fix it.',
    hasTools: false,
    onUsage: (u) => usageLog.push(u),
  });
  assert.equal(r1.shouldContinue, true);
  assert.equal(r1.prob, 0.88);
  assert.equal(r1.cached, false);
  assert.equal(usageLog[0].caller, 'judgment');
  assert.doesNotMatch(JSON.stringify(receivedBodies[0]), /sk-proj-secret/);
  assert.match(JSON.stringify(receivedBodies[0]), /\[REDACTED_API_KEY\]/);

  // Second identical call hits bounded LRU cache (no extra HTTP call).
  const r2 = await judgment.detectPrematureStop({
    requestText: 'Check key sk-proj-secret1234567890abcdef and fix bug',
    replyText: 'I will now inspect the test suite and fix it.',
    hasTools: false,
  });
  assert.equal(r2.shouldContinue, true);
  assert.equal(r2.cached, true);
  assert.equal(receivedBodies.length, 1);

  // Timeout gracefully degrades to unavailable without throwing!
  slowMode = true;
  const r3 = await judgment.detectPrematureStop({
    requestText: 'Different request',
    replyText: 'I will run tests next.',
    hasTools: false,
  });
  assert.equal(r3.shouldContinue, false);
  assert.equal(r3.status, 'unavailable');
});

test('Auto-review allows low-risk clean calls, escalates tainted/outward/contradictory calls to human', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const p = store.add('projects', { name: 'autoreview' });
  let task = store.submit({
    projectId: p.id,
    input: 'write file',
    idempotencyKey: 'ar-1',
    approvalMode: 'auto-review',
  });
  task = store.update('tasks', task, { status: 'running' });

  let mockReply = { decision: 'allow', risk: 'low', reason: 'safe write' };
  const judgment = new JudgmentService({
    provider: {
      kind: 'custom',
      model: 'fast-verifier',
      decide: async () => ({ answer: mockReply }),
    },
    uses: { autoReview: true },
  });

  // 1. Clean low-risk write_file -> auto-approved with audit!
  const ctx = {
    store,
    task,
    worker: { id: id() },
    node: { id: id(), role: 'Coder', dependencies: [] },
    job: { id: id(), fence: 'f' },
    signal: AbortSignal.timeout(5000),
    guard: () => {},
    autoReview: (params) => judgment.reviewToolApproval({ ...params, reviewCount: 0 }),
  };
  let ran = 0;
  const tools = toolset(ctx, {
    approvalMode: 'auto-review',
    mcp: { demo: ['echo'] },
    runner: async (_argv, files) => {
      ran++;
      return { exitCode: 0, stdout: 'ok', stderr: '', files };
    },
  });
  const writeTool = tools.find((x) => x.name === 'write_file');
  const out = JSON.parse(
    await writeTool.execute(
      { path: 'a.txt', text: 'hi' },
      { signal: ctx.signal, callId: id() },
    ),
  );
  assert.equal(out.exitCode, 0);
  assert.equal(ran, 1);
  const [autoApp] = store.list('approvals', { taskId: task.id });
  assert.equal(autoApp.autoDecision, 'auto-review');
  assert.equal(autoApp.risk, 'low');

  // 2. Contradictory model output (allow + high risk) -> MUST escalate (allow: false).
  mockReply = { decision: 'allow', risk: 'high', reason: 'bad' };
  const badVerdict = await judgment.reviewToolApproval({
    tool: 'shell',
    meta: { outward: false },
    action: { argv: ['ls'] },
    tainted: false,
  });
  assert.equal(badVerdict.allow, false);
  assert.equal(badVerdict.escalated, true);

  // 3. Tainted context -> MUST escalate even when model would allow low risk.
  mockReply = { decision: 'allow', risk: 'low', reason: 'safe' };
  const taintedVerdict = await judgment.reviewToolApproval({
    tool: 'write_file',
    meta: { outward: false },
    action: { path: 'x', text: 'y' },
    tainted: true,
  });
  assert.equal(taintedVerdict.allow, false);

  // 4. Outward tool (mcp) -> MUST escalate without calling side-model.
  const outwardVerdict = await judgment.reviewToolApproval({
    tool: 'mcp',
    meta: { outward: true },
    action: { server: 'demo', name: 'send', argumentsJson: '{}' },
    tainted: false,
  });
  assert.equal(outwardVerdict.allow, false);
  assert.equal(outwardVerdict.risk, 'high');
});

test('Premature-stop detector triggers single warm continuation in Engine when Coder promises action without tool call', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stop-check-'));
  const store = new Store(join(root, 'engine.sqlite'));
  const p = store.add('projects', { name: 'stop' });
  const task = store.submit({
    projectId: p.id,
    input: 'create note.txt',
    idempotencyKey: 'stop-1',
  });
  const plan = {
    type: 'coding',
    complexity: 'simple',
    risk: 'low',
    nodes: [
      {
        key: 'n1',
        role: 'Researcher',
        objective: 'deliver final summary',
        acceptance: 'contains final summary',
        dependencies: [],
      },
    ],
  };
  let workerReplies = 0;
  const adapter = new Script(async (o) => {
    const sys = o.messages
      .filter((m) => m.role === 'system')
      .flatMap((m) => m.content)
      .map((b) => b.text)
      .join('\n');
    if (sys.includes('You dispatch')) return JSON.stringify(plan);
    if (sys.includes('Evaluate the original'))
      return JSON.stringify({ accepted: true, reason: 'ok' });
    workerReplies++;
    return workerReplies === 1
      ? 'I will now analyze the details and write the final summary.'
      : 'Final summary: all details analyzed and complete.';
  });
  let judgeCalls = 0;
  const judgment = new JudgmentService({
    provider: {
      kind: 'custom',
      model: 'sys1-mock',
      decide: async ({ state }) => {
        judgeCalls++;
        return {
          answer: {
            prob: state.reply.includes('I will now') ? 0.92 : 0.05,
          },
        };
      },
    },
    uses: { stopCheck: true, routeTriage: true },
  });
  const engine = new Engine({
    store,
    root,
    models: [model],
    adapter,
    judgment,
  });
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  engine.start();
  for (let i = 0; i < 120; i++) {
    if (['completed', 'failed'].includes(store.get('tasks', task.id).status))
      break;
    await delay(50);
  }
  assert.equal(store.get('tasks', task.id).status, 'completed');
  assert.equal(workerReplies, 2);
  const [art] = store.list('artifacts', { taskId: task.id });
  assert.match(art.text, /Final summary: all details analyzed/);
  assert.ok(
    store.events(0, task.id).some((e) => e.type === 'judgment.stop_continued'),
  );
  assert.ok(judgeCalls >= 1);
});
