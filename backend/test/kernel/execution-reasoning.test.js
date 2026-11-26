import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirSafe } from '../fixtures.js';
import { Store } from '../../src/store.js';
import { pairClosed } from '../../src/context.js';
import { buildStaticSystemPrompt } from '../../src/agent-context.js';
import { BudgetError } from '../../src/kernel/errors.js';
import { AgentRuntimeKernel } from '../../src/kernel/runtime.js';
import { DecisionEngine, TurnManager } from '../../src/kernel/agent-loop.js';
import {
  CONSECUTIVE_DUPLICATE_THRESHOLD,
  DUPLICATE_CALL_REMINDER,
  ExecutionReasoningTracker,
  classifyMutationPath,
  serializeToolCallKey,
} from '../../src/kernel/execution-reasoning.js';
import { resolveTurnOutcome } from '../../src/kernel/verdict.js';
import { EvidenceVerifier } from '../../src/governance/verifier.js';
import { ToolDispatcher } from '../../src/tools/dispatcher.js';
import { createWorkspaceTools } from '../../src/workspace-tools.js';

const tc = (id, name, args = {}) => ({
  id,
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
});

function createTempEnv(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-er-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-er-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => {
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });
  return { dataDir, workDir, store };
}

test('ExecutionReasoningTracker and TurnManager enforce pure byte-level 6x consecutive duplicate dedup without error-signature heuristics', () => {
  assert.equal(CONSECUTIVE_DUPLICATE_THRESHOLD, 6);

  const tracker = new ExecutionReasoningTracker();
  const tm = new TurnManager({ eventRouter: null, sessionId: 's1', turnId: 't1' });

  // Pending non-error polls never accumulate duplicate count
  for (let i = 0; i < 10; i++) {
    const res = tracker.recordToolResult({
      tc: tc(`poll-${i}`, 'read_process_output', { processId: 'p1' }),
      isError: false,
      pending: true,
      step: 1,
    });
    assert.equal(res.duplicateReminder, null);
    assert.equal(
      tm.recordToolSignature(tc(`poll-${i}`, 'read_process_output', { processId: 'p1' }), false, { processId: 'p1' }, true),
      false,
    );
  }

  // Calls 1..5 byte-identical -> no reminder yet
  for (let i = 1; i <= 5; i++) {
    const call = tc(`c-${i}`, 'read_file', '{"path":"a.js"}');
    const res = tracker.recordToolResult({ tc: call, isError: false, step: i });
    assert.equal(res.duplicateReminder, null, `call #${i} must not remind`);
    assert.equal(res.consecutiveDuplicateCount, i);
    assert.equal(tm.recordToolSignature(call, false, { path: 'a.js' }), false);
  }

  // Call 6 byte-identical -> returns single short reminder and resets streak
  const sixth = tc('c-6', 'read_file', '{"path":"a.js"}');
  const res6 = tracker.recordToolResult({ tc: sixth, isError: false, step: 6 });
  assert.equal(res6.duplicateReminder, DUPLICATE_CALL_REMINDER);
  assert.equal(res6.consecutiveDuplicateCount, 6);
  assert.equal(tracker.duplicateReminderCount, 1);
  assert.equal(tm.recordToolSignature(sixth, false, { path: 'a.js' }), true);

  // Call 7 starts fresh streak (no spam immediately after 6th)
  const seventh = tc('c-7', 'read_file', '{"path":"a.js"}');
  const res7 = tracker.recordToolResult({ tc: seventh, isError: false, step: 7 });
  assert.equal(res7.duplicateReminder, null);
  assert.equal(res7.consecutiveDuplicateCount, 1);

  // Pure byte-level comparison: different JSON key order or whitespace resets streak
  assert.notEqual(
    serializeToolCallKey(tc('k1', 'edit_file', '{"a":1,"b":2}')),
    serializeToolCallKey(tc('k2', 'edit_file', '{"b":2,"a":1}')),
  );
  for (let i = 1; i <= 5; i++) {
    tracker.recordToolResult({ tc: tc(`b-${i}`, 'edit_file', '{"a":1,"b":2}'), isError: true, step: 10 + i });
  }
  const diffBytes = tracker.recordToolResult({
    tc: tc('b-6', 'edit_file', '{"b":2,"a":1}'),
    isError: true,
    step: 16,
  });
  assert.equal(diffBytes.duplicateReminder, null, 'different raw JSON byte sequence must reset consecutive count');
  assert.equal(diffBytes.consecutiveDuplicateCount, 1);

  // Varied errors / ping-pong never trigger regex intervention or error fingerprints
  const pingPong = new ExecutionReasoningTracker();
  for (let i = 0; i < 8; i++) {
    const path = i % 2 === 0 ? 'a.js' : 'b.js';
    const r = pingPong.recordToolResult({ tc: tc(`pp-${i}`, 'read_file', { path }), step: i + 1 });
    assert.equal(r.duplicateReminder, null);
  }
  assert.deepEqual(pingPong.getMetrics().errorFingerprints, []);
  assert.deepEqual(pingPong.getMetrics().falsifiedAttempts, []);
  assert.equal(pingPong.getMetrics().circuitBroken, false);
});

test('AgentLoop appends short reminder line to 6th consecutive duplicate tool result tail and NEVER aborts session', async (t) => {
  const { workDir, store } = createTempEnv(t);
  writeFileSync(join(workDir, 'app.js'), 'export const v = 1;\n', 'utf8');

  let stepIdx = 0;
  let observedToolMessagesOnStep7 = [];
  let observedUserMessagesOnStep7 = [];

  const kernel = new AgentRuntimeKernel({
    store,
    adapter: {
      async *stream({ messages }) {
        stepIdx += 1;
        if (stepIdx <= 6) {
          yield {
            type: 'block-end',
            block: {
              type: 'tool-call',
              id: `dup-${stepIdx}`,
              name: 'read_file',
              arguments: '{"path":"app.js"}',
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        observedToolMessagesOnStep7 = messages
          .filter((m) => m.role === 'tool')
          .map((m) => m.content?.[0]?.text ?? '');
        observedUserMessagesOnStep7 = messages
          .filter((m) => m.role === 'user')
          .map((m) => m.content?.[0]?.text ?? '');
        yield { type: 'text-delta', text: 'Finished inspecting app.js cleanly.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => kernel.close());

  const res = await kernel.executeTurn({
    sessionId: 'sess-dup-tail',
    turnId: 'turn-dup-tail',
    profile: { id: 'default', defaultMaxSteps: 10, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Inspect app.js',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect app.js' }] }],
    tools: createWorkspaceTools({ workspaceRoot: workDir, store, permissionMode: 'full-access' }),
  });

  assert.equal(res.status, 'completed', '6 consecutive duplicate calls must NEVER abort/fail the turn');
  assert.equal(res.stopReason, 'completed');
  assert.equal(res.errorCode, null);
  assert.equal(res.reasoningMetrics.circuitBroken, false);
  assert.equal(res.reasoningMetrics.duplicateReminderCount, 1);

  // Calls 1..5 have NO reminder; Call 6 has the single short reminder line appended to its tail
  assert.equal(observedToolMessagesOnStep7.length, 6);
  for (let i = 0; i < 5; i++) {
    assert.equal(observedToolMessagesOnStep7[i].includes(DUPLICATE_CALL_REMINDER), false);
  }
  assert.ok(observedToolMessagesOnStep7[5].endsWith(`\n${DUPLICATE_CALL_REMINDER}`));

  // No synthetic scolding user messages injected
  assert.equal(observedUserMessagesOnStep7.length, 1);
  assert.equal(observedUserMessagesOnStep7[0], 'Inspect app.js');
});

test('DecisionEngine and AgentLoop never call detectPrematureStop and never apply post-hoc heuristic closing vetoes', async (t) => {
  const { workDir, store } = createTempEnv(t);
  writeFileSync(join(workDir, 'mod.js'), 'export const val = 1;\n', 'utf8');

  let prematureStopCalls = 0;
  const mockJudgment = {
    async detectPrematureStop() {
      prematureStopCalls += 1;
      return { shouldContinue: true, note: 'should never be injected' };
    },
  };

  const verifier = new EvidenceVerifier({ store });
  let stepCount = 0;
  const kernel = new AgentRuntimeKernel({
    store,
    judgment: mockJudgment,
    verifier: (args) => verifier.verify(args),
    adapter: {
      async *stream() {
        stepCount += 1;
        if (stepCount === 1) {
          yield {
            type: 'block-end',
            block: {
              type: 'tool-call',
              id: 'tc-e1',
              name: 'edit_file',
              arguments: JSON.stringify({ path: 'mod.js', target: '1', replacement: '2' }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (stepCount === 2) {
          yield {
            type: 'block-end',
            block: {
              type: 'tool-call',
              id: 'tc-b1',
              name: 'bash',
              arguments: JSON.stringify({ command: 'node --test test/mod.test.js' }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield { type: 'text-delta', text: 'Updated mod.js and reported test output.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => kernel.close());

  const res = await kernel.executeTurn({
    sessionId: 'sess-no-veto',
    turnId: 'turn-no-veto',
    profile: { id: 'default', defaultMaxSteps: 10, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Update mod.js',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Update mod.js' }] }],
    tools: createWorkspaceTools({
      workspaceRoot: workDir,
      store,
      permissionMode: 'full-access',
      sandbox: {
        async run() {
          return { exitCode: 1, stdout: '', stderr: 'AssertionError: test failed' };
        },
      },
    }),
  });

  assert.equal(prematureStopCalls, 0, 'detectPrematureStop must never be called');
  assert.equal(res.status, 'completed', 'normal turn completion must not be vetoed by heuristic interceptors');
  assert.equal(stepCount, 3);
  assert.equal(res.reasoningMetrics.repairRounds, 0);

  // Explicit DecisionEngine still honors block_reconciliation and explicit evidenceContract
  const de = new DecisionEngine({
    judgment: mockJudgment,
    verifier: () => ({ verdict: 'block_reconciliation', accepted: false, reasons: ['outcome_unknown'] }),
  });
  const recDecision = await de.shouldContinueOnIdle({
    stepText: 'done',
    steps: 1,
    maxSteps: 5,
    repairRound: 0,
    verifierEvents: [],
  });
  assert.equal(recDecision.action, 'reconcile');
  assert.equal(prematureStopCalls, 0);

  const maxStepsOutcome = resolveTurnOutcome({ loopStopReason: 'max_steps', evidenceRequired: true });
  assert.equal(maxStepsOutcome.status, 'failed');
  assert.equal(maxStepsOutcome.errorCode, 'STEP_BUDGET_EXHAUSTED');
});

test('AgentLoop preserves token-budget advisories and zero-LLM Stage-1 budget_prune with pairClosed', async (t) => {
  const { workDir, store } = createTempEnv(t);
  const alphaTag = (n) => [12, 8, 4, 0].map((s) => String.fromCharCode(97 + ((n >> s) & 15))).join('');
  const largeSource = Array.from(
    { length: 240 },
    (_, i) => `export const entry_${alphaTag(i)} = "payload_${alphaTag(i)}_data_segment_abcdefghij";`,
  ).join('\n');
  writeFileSync(join(workDir, 'large.js'), `${largeSource}\n`, 'utf8');
  writeFileSync(join(workDir, 'side.js'), `${largeSource}\n`, 'utf8');

  const staticSysPrompt = buildStaticSystemPrompt('fixed-nonce-kernel-test');
  let stepCall = 0;
  let sawEarlyReserve = false;
  let observedMaxTokensAtPrunedStep = null;
  let observedMessagesAtPrunedStep = null;
  const maxTokens = 160_000;

  const kernel = new AgentRuntimeKernel({
    store,
    adapter: {
      async *stream({ messages, maxTokens: stepMaxOut }) {
        stepCall += 1;
        assert.equal(messages[0]?.content?.[0]?.text, staticSysPrompt);
        const userText = messages
          .filter((m) => m.role === 'user')
          .flatMap((m) => m.content ?? [])
          .map((b) => b.text ?? '')
          .join('\n');

        if (stepCall === 1) {
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: 'tc-r4-1', name: 'read_file', arguments: JSON.stringify({ path: 'large.js' }) },
          };
          yield { type: 'usage', usage: { inputTokens: 40_000, outputTokens: 200 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (stepCall === 2) {
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: 'tc-r4-2', name: 'read_file', arguments: JSON.stringify({ path: 'side.js' }) },
          };
          yield { type: 'usage', usage: { inputTokens: 40_000, outputTokens: 200 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (stepCall === 3) {
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: 'tc-r4-3', name: 'read_file', arguments: JSON.stringify({ path: 'large.js' }) },
          };
          yield { type: 'usage', usage: { inputTokens: 38_400, outputTokens: 400 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (stepCall === 4) {
          assert.match(userText, /\[预算收尾提醒\]/);
          sawEarlyReserve = true;
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: 'tc-r4-4', name: 'read_file', arguments: JSON.stringify({ path: 'large.js' }) },
          };
          yield { type: 'usage', usage: { inputTokens: 28_500, outputTokens: 300 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }

        observedMaxTokensAtPrunedStep = stepMaxOut;
        observedMessagesAtPrunedStep = messages;
        yield { type: 'text-delta', text: 'Completed cleanly after emergency budget_prune.' };
        yield { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 100 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => kernel.close());

  const res = await kernel.executeTurn({
    sessionId: 'sess-r4-prune',
    turnId: 'turn-r4-prune',
    profile: { id: 'default', defaultMaxSteps: 10, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Analyze large.js within token budget',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    budget: { maxSteps: 10, maxTokens, maxOutputTokens: 8192 },
    messages: [
      { role: 'system', content: [{ type: 'text', text: staticSysPrompt }] },
      { role: 'user', content: [{ type: 'text', text: 'Analyze large.js within token budget' }] },
    ],
    tools: createWorkspaceTools({ workspaceRoot: workDir, store, permissionMode: 'full-access' }),
  });

  assert.equal(res.status, 'completed');
  assert.equal(sawEarlyReserve, true);
  assert.equal(res.reasoningMetrics.budgetReserveAdvised, true);
  assert.equal(res.reasoningMetrics.budgetPruneCount, 1);
  assert.ok(
    observedMessagesAtPrunedStep && pairClosed(observedMessagesAtPrunedStep, 1, observedMessagesAtPrunedStep.length - 1),
    'emergency budget prune must preserve pairClosed',
  );
  assert.ok(observedMaxTokensAtPrunedStep > 0 && observedMaxTokensAtPrunedStep <= 18_000);

  // Genuine budget exhaustion still throws BudgetError('TOKEN_BUDGET')
  const exhaustedKernel = new AgentRuntimeKernel({
    store,
    adapter: {
      async *stream() {
        yield {
          type: 'block-end',
          block: { type: 'tool-call', id: 'tc-exh-1', name: 'read_file', arguments: JSON.stringify({ path: 'large.js' }) },
        };
        yield { type: 'usage', usage: { inputTokens: 3_500, outputTokens: 200 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      },
    },
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => exhaustedKernel.close());

  await assert.rejects(
    () =>
      exhaustedKernel.executeTurn({
        sessionId: 'sess-r4-exhaust',
        turnId: 'turn-r4-exhaust',
        profile: { id: 'default', defaultMaxSteps: 8, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
        input: 'Exhaust budget',
        model: 'mock',
        workspaceRoot: workDir,
        permissionMode: 'full-access',
        budget: { maxSteps: 8, maxTokens: 5_000, maxOutputTokens: 1024 },
        messages: [
          { role: 'system', content: [{ type: 'text', text: staticSysPrompt }] },
          { role: 'user', content: [{ type: 'text', text: 'Exhaust budget' }] },
        ],
        tools: createWorkspaceTools({ workspaceRoot: workDir, store, permissionMode: 'full-access' }),
      }),
    (err) => err instanceof BudgetError && err.code === 'TOKEN_BUDGET',
  );
});

test('buildStaticSystemPrompt is byte-static, language-agnostic, and free of non-core tool dogma', () => {
  const promptA = buildStaticSystemPrompt('nonce-fixed-40');
  const promptB = buildStaticSystemPrompt('nonce-fixed-40');
  assert.equal(promptA, promptB);

  for (const coreTool of ['glob', 'grep', 'read_file', 'edit_file', 'write_file', 'bash']) {
    assert.ok(promptA.includes(coreTool), `static system prompt should reference core tool ${coreTool}`);
  }
  for (const removed of [
    'inspect_repository',
    'query_symbol_graph',
    'run_diagnostics',
    'update_plan',
    'git diff',
    'git status',
  ]) {
    assert.equal(promptA.includes(removed), false, `static system prompt must not reference ${removed}`);
  }
  assert.equal(classifyMutationPath('README.md'), 'doc');
  assert.equal(classifyMutationPath('src/app.js'), 'src');
});
