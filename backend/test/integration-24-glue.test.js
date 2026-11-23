import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { MultiStageCompactor } from '../src/context/compaction.js';
import { AgentRuntimeKernel } from '../src/kernel/runtime.js';
import { ExecutionReasoningTracker } from '../src/kernel/execution-reasoning.js';
import { buildStaticSystemPrompt } from '../src/agent-context.js';
import { pairClosed } from '../src/context.js';
import { ExperienceMemoryService } from '../src/memory/index.js';
import {
  EvaluationService,
  createDirectRuntimeAdapter,
  summarizeReasoningMetrics,
} from '../src/evaluation/service.js';
import { ToolDispatcher } from '../src/tools/dispatcher.js';
import { WORKSPACE_TOOL_META, createWorkspaceTools, needsApproval } from '../src/workspace-tools.js';
import { sha256Hex } from '../src/integrity.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }
  async *stream(options) {
    const idx = this.calls.length;
    this.calls.push({
      model: options.model,
      messages: structuredClone(options.messages),
    });
    yield* this.handler(options, idx);
  }
}

test('glue: AgentLoop forwards reasoningState to MultiStageCompactor preserving verification/falsified/stuck state and static system prompt', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-glue-comp-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-glue-comp-work-'));
  writeFileSync(join(workDir, 'calc.js'), 'export const add = (a, b) => a - b;\n', 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => {
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  const staticPrompt = buildStaticSystemPrompt('fixed-nonce-24');
  let stepIdx = 0;
  const adapter = new ScriptedAdapter(async function* () {
    stepIdx += 1;
    if (stepIdx === 1) {
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc-fail-1',
          name: 'bash',
          arguments: JSON.stringify({ command: 'node --test test/calc.test.js' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (stepIdx === 2) {
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc-edit-1',
          name: 'write_file',
          arguments: JSON.stringify({
            path: 'calc.js',
            content: 'export const add = (a, b) => a + b;\n',
          }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (stepIdx === 3) {
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc-pass-2',
          name: 'bash',
          arguments: JSON.stringify({ command: 'node --test test/calc.test.js' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'text-delta', text: 'Fixed calc.js and verified tests pass.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const kernel = new AgentRuntimeKernel({
    store,
    adapter,
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => kernel.close());

  const tools = createWorkspaceTools({
    workspaceRoot: workDir,
    store,
    permissionMode: 'full-access',
    sandbox: {
      async run({ command }) {
        if (stepIdx <= 2) {
          return {
            exitCode: 1,
            stderr: `AssertionError [ERR_ASSERTION]: expected 3 got -1 (${command})`,
            stdout: '',
          };
        }
        return { exitCode: 0, stdout: 'pass 1\nfail 0', stderr: '' };
      },
    },
  });

  const compactor = new MultiStageCompactor({ store: null });
  const observedMeta = [];
  const contextManager = {
    async prepareRequest(opts, meta) {
      observedMeta.push(meta);
      // Force Stage 2 summary on step 3 (after failed test + write_file, before post-edit verify)
      if (meta?.step === 3) {
        return compactor.prepareRequest(opts, {
          contextWindow: 10000,
          reasoningState: meta.reasoningState,
          summarize: async () => 'Compacted prior attempt summary.',
        });
      }
      return { options: opts, stage: 'none', compacted: false, tokens: 100 };
    },
  };

  const filler = 'long-context-padding '.repeat(900); // ~4700 tokens in prior user/assistant messages
  const res = await kernel.executeTurn({
    sessionId: 'sess-glue-comp',
    turnId: 'turn-glue-comp',
    profile: { id: 'default', defaultMaxSteps: 8, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Fix add in calc.js',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    messages: [
      { role: 'system', content: [{ type: 'text', text: staticPrompt }] },
      { role: 'user', content: [{ type: 'text', text: `Earlier investigation A: ${filler}` }] },
      { role: 'assistant', content: [{ type: 'text', text: `Earlier summary A: ${filler}` }] },
      { role: 'user', content: [{ type: 'text', text: 'Fix add in calc.js' }] },
    ],
    tools,
    contextManager,
  });

  assert.equal(res.status, 'completed');
  assert.ok(observedMeta.length >= 3);
  assert.equal(observedMeta[2].reasoningState.hasUnverifiedMutationsAfterLastPass, true);
  assert.deepEqual(observedMeta[2].reasoningState.filesMutated, ['calc.js']);

  // Verify step 3 model call received static system prompt byte-identical + enriched summary anchor
  const step3CallMsgs = adapter.calls[2].messages;
  assert.equal(step3CallMsgs[0].role, 'system');
  assert.equal(step3CallMsgs[0].content[0].text, staticPrompt);
  const summaryAssistantMsg = step3CallMsgs.find(
    (m) => m.role === 'assistant' && m.content?.[0]?.text?.includes('[历史上下文摘要]'),
  );
  assert.ok(summaryAssistantMsg, 'Stage 2 summary anchor should be injected');
  const summaryText = summaryAssistantMsg.content[0].text;
  assert.match(summaryText, /已改动文件: calc\.js\(modified\)/);
  assert.match(summaryText, /验证台账:/);
  assert.match(summaryText, /\[FAIL exit=1\] node --test test\/calc\.test\.js/);
  assert.match(summaryText, /\[PENDING\] 存在最近修改后尚未重新验证的文件/);
});

test('glue: DirectAgent catch path persists reasoningMetrics to turn/failed event, EvaluationService summarizes stuckDetections, and ExperienceMemory consumes ExecutionReasoningTracker metrics', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-glue-eval-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-glue-eval-work-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  writeFileSync(join(workDir, 'src', 'a.js'), 'export const a = 1;\n', 'utf8');
  writeFileSync(join(workDir, 'src', 'b.js'), 'export const b = 2;\n', 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('glue-model');
  const memory = new ExperienceMemoryService({ store, projectId: 'glue-eval-proj' });

  let callCount = 0;
  const adapter = new ScriptedAdapter(async function* () {
    callCount += 1;
    // Ping-pong or write_file so step budget exhausts with real ExecutionReasoningTracker metrics
    if (callCount === 1) {
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc-w1',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'src/a.js', content: 'export const a = 2;\n' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield {
      type: 'block-end',
      block: {
        type: 'tool-call',
        id: 'tc-w2',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'src/b.js', content: 'export const b = 3;\n' }),
      },
    };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });
  direct.attachIntelligenceServices({ memory });

  t.after(async () => {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  // Exercise createDirectRuntimeAdapter when AgentLoop throws STEP_BUDGET_EXHAUSTED (catch path)
  const runtimeFactory = createDirectRuntimeAdapter(direct, { model: 'glue-model' });
  const handle = await runtimeFactory({
    task: {
      id: 'glue-budget-task',
      prompt: 'Edit src/a.js and src/b.js',
      resourceBudget: { maxSteps: 1 },
    },
    workspaceRoot: workDir,
    context: {},
  });

  let caughtErr = null;
  try {
    await handle.run();
  } catch (err) {
    caughtErr = err;
  }
  assert.ok(caughtErr, 'expected maxSteps=1 turn to throw STEP_BUDGET_EXHAUSTED');
  assert.equal(caughtErr.code, 'STEP_BUDGET_EXHAUSTED');
  assert.ok(caughtErr.telemetry?.reasoningMetrics, 'catch-path turn/failed event must carry reasoningMetrics');
  assert.deepEqual(caughtErr.telemetry.reasoningMetrics.filesMutated, ['src/a.js']);

  // Verify summarizeReasoningMetrics aggregates real ExecutionReasoningTracker stuckDetections & circuitBroken
  const realShapeSummary = summarizeReasoningMetrics([
    {
      telemetry: {
        reasoningMetrics: {
          ineffectiveActionCount: 3,
          firstFixSucceeded: false,
          reproducedFailureBeforeEdit: false,
          selfCorrectionRecovered: false,
          hasUnverifiedMutationsAfterLastPass: true,
          rootCauseFilesReadBeforeEdit: [],
          stuckDetections: [
            { pattern: 'ping_pong', step: 4, seq: 4, signature: 'ping_pong:read_file<->read_file' },
          ],
          falsifiedAttempts: [
            {
              step: 2,
              toolName: 'edit_file',
              targetFiles: ['src/a.js'],
              errorSignature: 'EDIT_TARGET_NOT_FOUND',
              hypothesisSummary: 'edit_file failed on src/a.js',
            },
          ],
          errorFingerprints: [
            {
              signature: 'AssertionError@src/a.js:10',
              errorType: 'AssertionError',
              location: 'src/a.js:10',
              assertionExcerpt: 'expected 2 to equal 1',
            },
          ],
          circuitBroken: true,
        },
      },
    },
  ]);
  assert.equal(realShapeSummary.selfCorrectionAttempts, 1);
  assert.equal(realShapeSummary.selfCorrectionRecoveryRate, 0);
  assert.deepEqual(realShapeSummary.stuckTriggerCounts, { ping_pong: 1 });
  assert.equal(realShapeSummary.uniqueErrorFingerprintsCount, 1);

  // Verify ExperienceMemoryService consumes real ExecutionReasoningTracker metrics fields cleanly (verified stays false)
  const distilled = memory.distillTurnExperience({
    projectId: 'glue-eval-proj',
    input: 'Fix src/a.js regression',
    workspaceRoot: workDir,
    verdict: { verdict: 'pass', accepted: true },
    reasoningMetrics: {
      filesMutated: ['src/a.js'],
      ineffectiveActionCount: 1,
      selfCorrectionRecovered: false,
      circuitBroken: true,
      stuckDetections: [{ pattern: 'edit_test_fail_loop', signature: 'sig-1' }],
      errorFingerprints: [
        {
          signature: 'AssertionError@src/a.js:10',
          errorType: 'AssertionError',
          location: 'src/a.js:10',
          assertionExcerpt: 'expected 2 to equal 1',
        },
      ],
      falsifiedAttempts: [
        {
          step: 2,
          toolName: 'edit_file',
          targetFiles: ['src/a.js'],
          errorSignature: 'EDIT_TARGET_NOT_FOUND',
          location: 'src/a.js:10',
          hypothesisSummary: 'Tried replacing line 10 before reading file',
        },
      ],
    },
  });
  assert.equal(distilled.length, 1);
  assert.equal(distilled[0].verified, false);
  assert.equal(distilled[0].memoryClass, 'failure_trap_pattern');
  assert.deepEqual(distilled[0].metadata.modifiedFiles, ['src/a.js']);
  assert.ok(distilled[0].metadata.errorFingerprints.includes('src/a.js:10'));
});

test('glue: ExecutionReasoningTracker.getState() preserves v.signature, a.target, a.editedFiles, and a.fingerprint.signature across MultiStageCompactor.prepareRequest', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-glue-r2-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-glue-r2-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => {
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  const now = Date.now();
  const sessId = 'sess-r2-anchor';
  const turnId = 'turn-r2-anchor';
  store.db
    .prepare('INSERT INTO direct_sessions(id,title,workspaceRoot,model,permissionMode,state,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)')
    .run(sessId, 'R2 Anchor Mapping', workDir, 'mock', 'auto-safe', 'running', now, now);

  const tracker = new ExecutionReasoningTracker({ workspaceRoot: workDir });
  tracker.recordToolResult({
    tc: { id: 'tc-e1', name: 'write_file', arguments: JSON.stringify({ path: 'src/tax.js', content: 'export const tax = 0;' }) },
    args: { path: 'src/tax.js', content: 'export const tax = 0;' },
    output: 'Wrote src/tax.js',
    isError: false,
    step: 1,
  });
  tracker.recordToolResult({
    tc: { id: 'tc-v1', name: 'bash', arguments: JSON.stringify({ command: 'node --test test/tax.test.js' }) },
    args: { command: 'node --test test/tax.test.js' },
    output: [
      '✖ computes regional tax correctly (14.2ms)',
      '  AssertionError [ERR_ASSERTION]: Expected 108 to strictly equal 100',
      '      at computeTax (src/tax.js:18:5)',
      'exitCode: 1',
    ].join('\n'),
    isError: true,
    receipt: { exitCode: 1, status: 'failed' },
    step: 2,
  });

  const reasoningState = tracker.getState();
  const v0 = reasoningState.verifications[0];
  const a0 = reasoningState.falsifiedAttempts[0];
  assert.ok(v0?.signature, 'ExecutionReasoningTracker must record v.signature');
  assert.ok(a0?.target, 'ExecutionReasoningTracker must record a.target');
  assert.deepEqual(a0?.editedFiles, ['src/tax.js']);
  assert.equal(a0?.fingerprint?.signature, v0.signature);

  const compactor = new MultiStageCompactor({ store });
  const filler = 'long-history '.repeat(750);
  const out = await compactor.prepareRequest(
    {
      messages: [
        { role: 'system', content: [{ type: 'text', text: buildStaticSystemPrompt('nonce-r2') }] },
        { role: 'user', content: [{ type: 'text', text: `History 1 ${filler}` }] },
        { role: 'assistant', content: [{ type: 'text', text: `Summary 1 ${filler}` }] },
        { role: 'user', content: [{ type: 'text', text: 'Continue fixing src/tax.js' }] },
      ],
    },
    {
      contextWindow: 6000,
      sessionId: sessId,
      turnId,
      reasoningState,
      summarize: async () => 'Prior tax debugging step.',
    },
  );

  assert.equal(out.stage, 'summary');
  const summaryText = out.options.messages.find(
    (m) => m.role === 'assistant' && m.content?.[0]?.text?.includes('[历史上下文摘要]'),
  )?.content?.[0]?.text ?? '';

  assert.ok(summaryText.includes(v0.signature), 'Stage-2 summary anchor must preserve v.signature verbatim');
  assert.ok(summaryText.includes(a0.target), 'Stage-2 summary anchor must preserve a.target verbatim');
  assert.ok(summaryText.includes('src/tax.js'), 'Stage-2 summary anchor must preserve a.editedFiles verbatim');
  assert.ok(summaryText.includes(a0.fingerprint.signature), 'Stage-2 summary anchor must preserve a.fingerprint.signature verbatim');

  const persisted = compactor.listCompactions(sessId)[0];
  assert.ok(persisted, 'compaction record should be persisted');
  assert.equal(persisted.taskState.verificationLedger[0].signature, v0.signature);
  assert.ok(persisted.taskState.verificationLedger[0].failureExcerpt.includes(v0.signature));
  assert.equal(persisted.taskState.falsifiedAttempts[0].errorSignature, a0.fingerprint.signature);
  assert.deepEqual(persisted.taskState.falsifiedAttempts[0].editedFiles, ['src/tax.js']);
  assert.ok(persisted.taskState.falsifiedAttempts[0].target.includes(a0.target));
});

test('glue: DirectAgent catch path persists reasoningMetrics on TURN_CANCELLED event', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-glue-cancel-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-glue-cancel-work-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  writeFileSync(join(workDir, 'src', 'cancel-me.js'), 'export const x = 1;\n', 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('glue-cancel-model');

  let stepCall = 0;
  const adapter = new ScriptedAdapter(async function* () {
    stepCall += 1;
    if (stepCall === 1) {
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc-cancel-w1',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'src/cancel-me.js', content: 'export const x = 2;\n' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    throw Object.assign(new Error('Request aborted by upstream cancellation'), { name: 'AbortError' });
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });

  t.after(async () => {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  const session = direct.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });
  const observedCancelEvents = [];
  const unsub = direct.subscribe(session.id, (evt) => {
    if (evt.type === 'turn/cancelled') observedCancelEvents.push(evt.data);
  });
  t.after(() => unsub());

  const { turn } = direct.startTurn(session.id, {
    input: 'Edit src/cancel-me.js',
    model: 'glue-cancel-model',
  });

  const terminal = await direct.waitForTurnTerminal(turn.id, { timeoutMs: 5000 });
  assert.equal(terminal.state, 'cancelled');

  const cancelEv = store.db
    .prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/cancelled' ORDER BY seq DESC LIMIT 1")
    .get(turn.id);
  assert.ok(cancelEv, 'expected turn/cancelled event row in direct_events');
  const parsed = JSON.parse(cancelEv.data);
  assert.ok(parsed.reasoningMetrics, 'turn/cancelled event must include reasoningMetrics');
  assert.deepEqual(parsed.reasoningMetrics.filesMutated, ['src/cancel-me.js']);
  assert.equal(parsed.reasoningMetrics.selfCorrectionRecovered, false);
  assert.ok(observedCancelEvents[0]?.reasoningMetrics, 'live SSE turn/cancelled event must include reasoningMetrics');
});

test('glue: direct.cancelTurn + waitForTurnTerminal drains worker and backfills reasoningMetrics on turn/cancelled event', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-glue-cancel-backfill-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-glue-cancel-backfill-work-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  writeFileSync(join(workDir, 'src', 'cancel-backfill.js'), 'export const v = 1;\n', 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('glue-cancel-backfill-model');

  let stepCall = 0;
  let markStep2Entered;
  const enteredStep2 = new Promise((resolve) => {
    markStep2Entered = resolve;
  });

  const adapter = new ScriptedAdapter(async function* (opts) {
    stepCall += 1;
    if (stepCall === 1) {
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc-cancel-bf-w1',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'src/cancel-backfill.js', content: 'export const v = 2;\n' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    markStep2Entered();
    await new Promise((_, reject) => {
      const rejectAfterDelay = () =>
        setTimeout(() => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), 30);
      if (opts.signal?.aborted) {
        rejectAfterDelay();
        return;
      }
      opts.signal?.addEventListener('abort', rejectAfterDelay, { once: true });
    });
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });

  t.after(async () => {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  const session = direct.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });
  const { turn } = direct.startTurn(session.id, {
    input: 'Edit src/cancel-backfill.js',
    model: 'glue-cancel-backfill-model',
  });

  await enteredStep2;
  direct.cancelTurn(turn.id);
  const terminal = await direct.waitForTurnTerminal(turn.id, { timeoutMs: 5000 });
  assert.equal(terminal.state, 'cancelled');

  const cancelEv = store.db
    .prepare("SELECT seq, data FROM direct_events WHERE turnId=? AND type='turn/cancelled' ORDER BY seq DESC LIMIT 1")
    .get(turn.id);
  assert.ok(cancelEv, 'expected turn/cancelled event row in direct_events');
  const parsed = JSON.parse(cancelEv.data);
  assert.ok(parsed.reasoningMetrics, 'waitForTurnTerminal must drain worker backfill of turn/cancelled reasoningMetrics');
  assert.deepEqual(parsed.reasoningMetrics.filesMutated, ['src/cancel-backfill.js']);
  assert.equal(parsed.reasoningMetrics.selfCorrectionRecovered, false);
});

test('glue: DirectAgent with sessionBudget triggers early wrap-up and recovers from reserveInference TOKEN_BUDGET via emergency Stage-1 budget_prune', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-glue-r4-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-glue-r4-work-'));
  const alphaTag = (n) => [12, 8, 4, 0].map((s) => String.fromCharCode(97 + ((n >> s) & 15))).join('');
  const bigLines = Array.from(
    { length: 240 },
    (_, i) => `export const mod_${alphaTag(i)} = "segment_${alphaTag(i)}_token_payload_abcdef";`,
  ).join('\n');
  writeFileSync(join(workDir, 'a.js'), `${bigLines}\n`, 'utf8');
  writeFileSync(join(workDir, 'b.js'), `${bigLines}\n`, 'utf8');
  writeFileSync(join(workDir, 'c.js'), `${bigLines}\n`, 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('glue-r4-model');

  let stepCall = 0;
  let sawWrapUp = false;
  let prunedStepMessages = null;
  let firstSystemText = null;
  const adapter = new ScriptedAdapter(async function* (opts) {
    stepCall += 1;
    const sysText = opts.messages?.[0]?.content?.[0]?.text ?? '';
    if (firstSystemText === null) firstSystemText = sysText;
    assert.equal(sysText, firstSystemText, 'static system prompt must stay byte-identical across Round 4 budget prune');

    const userText = opts.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content ?? [])
      .map((b) => b.text ?? '')
      .join('\n');

    if (stepCall === 1) {
      yield {
        type: 'block-end',
        block: { type: 'tool-call', id: 'tc-g4-1', name: 'read_file', arguments: JSON.stringify({ path: 'a.js' }) },
      };
      yield { type: 'usage', usage: { inputTokens: 45_000, outputTokens: 200 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (stepCall === 2) {
      yield {
        type: 'block-end',
        block: { type: 'tool-call', id: 'tc-g4-2', name: 'read_file', arguments: JSON.stringify({ path: 'b.js' }) },
      };
      yield { type: 'usage', usage: { inputTokens: 45_000, outputTokens: 200 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (stepCall === 3) {
      yield {
        type: 'block-end',
        block: { type: 'tool-call', id: 'tc-g4-3', name: 'read_file', arguments: JSON.stringify({ path: 'c.js' }) },
      };
      // Remaining after step 3: 160k - (45.2k + 45.2k + 30.2k) = 39.4k <= 41.6k (26%)
      yield { type: 'usage', usage: { inputTokens: 29_900, outputTokens: 300 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (stepCall === 4) {
      assert.match(userText, /\[预算收尾提醒\]/);
      assert.match(userText, /次模型调用/);
      assert.match(userText, /update_plan/);
      sawWrapUp = true;
      yield {
        type: 'block-end',
        block: { type: 'tool-call', id: 'tc-g4-4', name: 'read_file', arguments: JSON.stringify({ path: 'a.js' }) },
      };
      // Remaining after step 4: ~12,400 (< ~15k accumulated across 3 distinct files + catalog/system -> reserveInference TOKEN_BUDGET -> budget_prune!)
      yield { type: 'usage', usage: { inputTokens: 26_700, outputTokens: 300 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    prunedStepMessages = opts.messages;
    yield { type: 'text-delta', text: 'Completed within DirectAgent sessionBudget via Stage-1 budget_prune.' };
    yield { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 100 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });

  t.after(async () => {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  const session = direct.createSession({
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    budget: { maxSteps: 10, maxTotalTokens: 160_000, maxOutputTokens: 4096 },
  });
  const { turn } = direct.startTurn(session.id, {
    input: 'Read a.js and b.js then finish cleanly',
    model: 'glue-r4-model',
    maxSteps: 10,
  });

  const terminal = await direct.waitForTurnTerminal(turn.id, { timeoutMs: 8000 });
  assert.equal(terminal.state, 'completed');
  assert.equal(sawWrapUp, true);
  assert.ok(prunedStepMessages && pairClosed(prunedStepMessages, 1, prunedStepMessages.length - 1));

  const compactEvs = store.db
    .prepare("SELECT data FROM direct_events WHERE turnId=? AND type='context/compacted'")
    .all(turn.id)
    .map((r) => JSON.parse(r.data));
  assert.ok(compactEvs.some((d) => d.stage === 'budget_prune'), 'DirectAgent budgetLedger reserveInference failure must recover via budget_prune');

  const doneEv = store.db
    .prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/completed' ORDER BY seq DESC LIMIT 1")
    .get(turn.id);
  const doneData = JSON.parse(doneEv.data);
  assert.equal(doneData.reasoningMetrics?.budgetReserveAdvised, true);
  assert.equal(doneData.reasoningMetrics?.budgetPruneCount, 1);

  // Also verify DirectAgent triggers Tier-2 [最终预算警告 — 预算极度紧张] when unverified mutations remain
  let t2Step = 0;
  let sawTier2MutationWarning = false;
  const t2Adapter = new ScriptedAdapter(async function* (opts) {
    t2Step += 1;
    const userText = opts.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content ?? [])
      .map((b) => b.text ?? '')
      .join('\n');
    if (t2Step === 1) {
      yield {
        type: 'block-end',
        block: { type: 'tool-call', id: 'tc-t2g-1', name: 'read_file', arguments: JSON.stringify({ path: 'a.js' }) },
      };
      yield { type: 'usage', usage: { inputTokens: 10_000, outputTokens: 200 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (t2Step === 2) {
      yield {
        type: 'block-end',
        block: { type: 'tool-call', id: 'tc-t2g-2', name: 'read_file', arguments: JSON.stringify({ path: 'b.js' }) },
      };
      yield { type: 'usage', usage: { inputTokens: 10_000, outputTokens: 200 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (t2Step === 3) {
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc-t2g-3',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'c.js', content: 'export const ok = true;\n' }),
        },
      };
      // Used: 20,400 + 22,200 = 42,600 out of 60,000 => remaining = 17,400 (between ~10.7k estIn and ~24.5k Tier-2 limit)
      yield { type: 'usage', usage: { inputTokens: 22_000, outputTokens: 200 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    assert.match(userText, /\[最终预算警告 — 预算极度紧张\]/);
    sawTier2MutationWarning = true;
    yield { type: 'text-delta', text: 'Completed within final budget warning.' };
    yield { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 100 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const store2 = new Store(join(dataDir, 'engine-t2.sqlite'));
  const pool2 = new AccountPool(store2, { root: dataDir });
  pool2.setDefaultModel('glue-r4-model');
  const directT2 = new DirectAgentRuntime(store2, pool2, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: t2Adapter,
    enableHeartbeat: false,
  });
  try {
    const s2 = directT2.createSession({
      workspaceRoot: workDir,
      permissionMode: 'full-access',
      budget: { maxSteps: 8, maxTotalTokens: 60_000, maxOutputTokens: 2048 },
    });
    const t2 = directT2.startTurn(s2.id, {
      input: 'Update c.js cleanly',
      model: 'glue-r4-model',
      maxSteps: 8,
    });
    const t2Done = await directT2.waitForTurnTerminal(t2.turn.id, { timeoutMs: 8000 });
    assert.equal(t2Done.state, 'completed');
    assert.equal(sawTier2MutationWarning, true);

    const t2DoneEv = store2.db
      .prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/completed' ORDER BY seq DESC LIMIT 1")
      .get(t2.turn.id);
    const t2DoneData = JSON.parse(t2DoneEv.data);
    assert.equal(t2DoneData.reasoningMetrics?.budgetReserveAdvised, true);
    assert.equal(t2DoneData.reasoningMetrics?.budgetFinalCallAdvised, true);
  } finally {
    await directT2.close();
    store2.close();
  }
});

test('glue: Wave 2 compute_file_digest confinement, expand_context lossless restore, and AgentLoop contract pre-completion check', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-glue-w2-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-glue-w2-work-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  mkdirSync(join(workDir, 'handoff'), { recursive: true });
  writeFileSync(join(workDir, 'src', 'a.js'), 'export const alpha = 1;\n', 'utf8');
  writeFileSync(join(workDir, 'src', 'b.js'), 'export const beta = 2;\n', 'utf8');
  writeFileSync(join(workDir, 'handoff', 'cfg.json'), '{"b":2,"a":1}', 'utf8');
  writeFileSync(join(workDir, '.env.local'), 'SECRET=nope\n', 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => {
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  // 1. Metadata & zero-approval read-only classification
  assert.equal(WORKSPACE_TOOL_META.compute_file_digest?.readOnly, true);
  assert.equal(WORKSPACE_TOOL_META.compute_file_digest?.effectClass, 'read_only');
  assert.equal(WORKSPACE_TOOL_META.expand_context?.readOnly, true);
  assert.equal(WORKSPACE_TOOL_META.expand_context?.effectClass, 'read_only');
  assert.equal(needsApproval('compute_file_digest', { paths: ['src/a.js'] }, 'auto-safe'), false);
  assert.equal(needsApproval('expand_context', { ref: 'artifact://abc' }, 'auto-safe'), false);

  const tools = createWorkspaceTools({
    workspaceRoot: workDir,
    store,
    permissionMode: 'auto-safe',
  });
  const digestTool = tools.find((tool) => tool.name === 'compute_file_digest');
  const expandTool = tools.find((tool) => tool.name === 'expand_context');
  assert.ok(digestTool);
  assert.ok(expandTool);

  const digestRaw = await digestTool.execute({ paths: ['src/b.js', 'src/a.js', 'handoff/cfg.json'] }, {});
  const digestJsonText = String(digestRaw).replace(/^<tool_result[^>]*>\n?/, '').replace(/\n?<\/tool_result>$/, '');
  const digestParsed = JSON.parse(digestJsonText);
  assert.equal(digestParsed.files.length, 3);
  assert.equal(digestParsed.files[1].path, 'src/a.js');
  assert.equal(digestParsed.files[1].sha256, sha256Hex('export const alpha = 1;\n'));
  assert.equal(digestParsed.files[2].canonicalJsonSha256, sha256Hex('{"a":1,"b":2}'));
  assert.equal(digestParsed.sortedArtifactsSha256.length, 64);

  // Confinement & secret blocks on compute_file_digest
  await assert.rejects(() => digestTool.execute({ paths: ['../outside.txt'] }, {}), /超出/);
  await assert.rejects(() => digestTool.execute({ paths: ['.env.local'] }, {}), /受保护/);
  await assert.rejects(() => digestTool.execute({ paths: ['upstream/secret.txt'] }, {}), /受保护/);

  // 2. expand_context lossless line-range & refId restoration
  const rawBlobText = ['line-one-alpha', 'line-two-beta', 'line-three-gamma', 'line-four-delta'].join('\n');
  const put = store.putBlob(rawBlobText);
  store.setSetting('aci.ref:ctx-ref-1', { uri: put.uri });

  const expandedUri = await expandTool.execute({ ref: put.uri, startLine: 2, endLine: 3 }, {});
  assert.match(expandedUri, /line-two-beta\nline-three-gamma/);
  const expandedRef = await expandTool.execute({ ref: 'ctx-ref-1', offset: 0, limit: 100 }, {});
  const restoredBody = String(expandedRef)
    .replace(/^<tool_result[^>]*>\n?/, '')
    .replace(/\n?<\/tool_result>$/, '');
  assert.equal(restoredBody.slice(restoredBody.indexOf('\n') + 1), rawBlobText);

  // 3. AgentLoop ContractReasoningEngine pre-completion deliverable check without breaking static system prompt
  const staticSys = buildStaticSystemPrompt('fixed-nonce-w2');
  let loopStep = 0;
  let sawContractNudge = false;
  const kernel = new AgentRuntimeKernel({
    store,
    adapter: {
      async *stream({ messages }) {
        loopStep += 1;
        assert.equal(messages[0]?.content?.[0]?.text, staticSys);
        const userText = messages
          .filter((m) => m.role === 'user')
          .flatMap((m) => m.content ?? [])
          .map((b) => b.text ?? '')
          .join('\n');
        if (loopStep === 1) {
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: 'tc-c1', name: 'read_file', arguments: JSON.stringify({ path: 'src/a.js' }) },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (loopStep === 2) {
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: 'tc-c2', name: 'write_file', arguments: JSON.stringify({ path: 'src/a.js', content: 'export const alpha = 42;\n' }) },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (loopStep === 3) {
          // Attempts early stop BEFORE creating required handoff/digest.txt!
          yield { type: 'text-delta', text: 'Updated src/a.js.' };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        if (loopStep === 4) {
          assert.match(userText, /\[契约与根因核对\]/);
          assert.match(userText, /handoff\/digest\.txt/);
          sawContractNudge = true;
          yield {
            type: 'block-end',
            block: {
              type: 'tool-call',
              id: 'tc-c3',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'handoff/digest.txt', content: digestParsed.sortedArtifactsSha256 }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (loopStep === 5) {
          yield {
            type: 'block-end',
            block: {
              type: 'tool-call',
              id: 'tc-c4',
              name: 'bash',
              arguments: JSON.stringify({ command: 'node --test' }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield { type: 'text-delta', text: 'Completed src/a.js and handoff/digest.txt.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => kernel.close());

  const contractTurn = await kernel.executeTurn({
    sessionId: 'sess-w2-contract',
    turnId: 'turn-w2-contract',
    profile: { id: 'default', defaultMaxSteps: 8, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Update src/a.js and emit handoff/digest.txt.',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    messages: [
      { role: 'system', content: [{ type: 'text', text: staticSys }] },
      { role: 'user', content: [{ type: 'text', text: 'Update src/a.js and emit handoff/digest.txt.' }] },
    ],
    tools: createWorkspaceTools({
      workspaceRoot: workDir,
      store,
      permissionMode: 'full-access',
      sandbox: { async run() { return { exitCode: 0, stdout: 'pass 1\nfail 0', stderr: '' }; } },
    }),
  });
  assert.equal(contractTurn.status, 'completed');
  assert.equal(sawContractNudge, true);
  assert.equal(contractTurn.reasoningMetrics?.contractComplianceSignals?.ready, true);
});
