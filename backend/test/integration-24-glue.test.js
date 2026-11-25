import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { v1Routes } from '../src/v1-routes.js';
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

async function waitTurnDone(directAgent, sessionId, turnId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const turn = directAgent.listTurns(sessionId).find((item) => item.id === turnId);
    if (turn && ['completed', 'failed', 'cancelled'].includes(turn.state)) return turn;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for turn ${turnId}`);
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

  // This test exercises a write_file-only step-budget failure, not shell isolation.
  // Inject a test sandbox so it can reach the catch path without a Docker dependency.
  let sandboxResolveCalls = 0;
  let sandboxRunCalls = 0;
  const rejectShellTestSandbox = {
    resolveBackend() {
      sandboxResolveCalls += 1;
    },
    async run() {
      sandboxRunCalls += 1;
      throw new Error('The glue test sandbox does not execute shell commands');
    },
  };
  const runtimeFactory = createDirectRuntimeAdapter(direct, {
    model: 'glue-model',
    sandbox: rejectShellTestSandbox,
  });
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
  assert.ok(sandboxResolveCalls > 0, 'the injected test sandbox must be resolved');
  assert.equal(sandboxRunCalls, 0, 'the write_file-only turn must not invoke shell execution');
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
    aciProfile: 'raw_full',
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
      aciProfile: 'raw_full',
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

test('Step 3: DirectAgent + AgentLoop ACI Epoch DTOC, read-only Supervisor via v1Routes, KV cache invariance, and expand_context roundtrip', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-step3-aci-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-step3-aci-ws-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  const adjA = ['fast', 'safe', 'clean', 'strict', 'pure', 'lazy', 'async', 'sync', 'cold', 'warm', 'deep', 'flat'];
  const nounB = ['Parser', 'Router', 'Ledger', 'Cache', 'Codec', 'Guard', 'Planner', 'Store', 'Broker', 'Bridge', 'Filter', 'Sorter', 'Worker', 'Client', 'Server'];
  const verbC = ['validate', 'normalize', 'resolve', 'compute', 'dispatch', 'serialize', 'reconcile', 'compact'];
  const linesList = [];
  for (let i = 0; i < 125; i += 1) {
    const fnName = `${verbC[i % verbC.length]}${nounB[Math.floor(i / verbC.length) % nounB.length]}${adjA[(i * 7) % adjA.length]}`;
    linesList.push(`export function ${fnName}(inputPayload) { return inputPayload?.status === '${adjA[(i * 3) % adjA.length]}' ? '${nounB[(i * 5) % nounB.length]}' : null; }`);
  }
  const paddingBlock = linesList.join('\n');
  const criticalSource = `${paddingBlock}\nexport function computeRate(x) { return x * 2; }\n`;
  writeFileSync(join(workDir, 'src', 'target.js'), criticalSource, 'utf8');
  writeFileSync(join(workDir, 'src', 'notes.txt'), `REFERENCE_NOTES\n${paddingBlock}\n`, 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'workbuddy',
    label: 'aci-test-pool',
    credential: 'sk-test-aci-pool-0001',
    protocol: 'openai',
    endpoint: 'https://api.example.invalid/v1',
    models: ['main-model', 'fast-supervisor'],
  });
  pool.setDefaultModel('main-model');

  const mainSystemPrefixes = [];
  const supervisorCalls = [];
  let mainTurnIdx = 0;
  let capturedRefId = null;

  class AciDualAdapter extends LlmAdapter {
    async *stream(opts) {
      // Read-only ContextSupervisor call (`tools: []` enforced)
      if (opts.model === 'fast-supervisor' || (Array.isArray(opts.tools) && opts.tools.length === 0 && /ContextSupervisor/i.test(String(opts.system ?? '')))) {
        assert.deepEqual(opts.tools, [], 'Supervisor MUST execute with zero tools');
        const payload = JSON.parse(opts.messages[0].content[0].text);
        supervisorCalls.push(payload);
        const notesCand = payload.candidates.find((c) => /notes\.txt/.test(c.path));
        const targetCand = payload.candidates.find((c) => /target\.js/.test(c.path));
        yield {
          type: 'text-delta',
          index: 0,
          text: JSON.stringify({
            keepRefs: [],
            compressRefs: [targetCand?.id, notesCand?.id].filter(Boolean),
            rationale: 'Offload large older read outputs into lossless stubs',
          }),
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      mainTurnIdx += 1;
      const sysText = opts.messages?.[0]?.content?.[0]?.text ?? '';
      mainSystemPrefixes.push(sysText);

      if (mainTurnIdx === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'tc-r1', name: 'read_file', arguments: JSON.stringify({ path: 'src/target.js' }) } };
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'tc-r2', name: 'read_file', arguments: JSON.stringify({ path: 'src/notes.txt' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (mainTurnIdx === 2) {
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-r3', name: 'glob', arguments: JSON.stringify({ pattern: 'src/*' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (mainTurnIdx === 3) {
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-r4', name: 'glob', arguments: JSON.stringify({ pattern: '*.txt' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (mainTurnIdx === 4) {
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-r5', name: 'glob', arguments: JSON.stringify({ pattern: 'src/*.js' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (mainTurnIdx === 5) {
        // Both src/target.js & src/notes.txt (step 1) now have age = 4 - 1 = 3 >= 3 -> Supervisor + DTOC offload both!
        const stubMsg = (opts.messages ?? []).find(
          (m) => m.role === 'tool' && /\[ACI-REF\s+(artifact:\/\/[a-f0-9]+|aci_\d+_[a-f0-9]+)/.test(m.content?.[0]?.text ?? ''),
        );
        const match = stubMsg?.content?.[0]?.text?.match(/\[ACI-REF\s+(artifact:\/\/[a-f0-9]+|aci_\d+_[a-f0-9]+)/);
        assert.ok(match, 'Expected epoch DTOC compression to replace old read output with [ACI-REF ...]');
        capturedRefId = match[1];
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-exp', name: 'expand_context', arguments: JSON.stringify({ uri: capturedRefId, startLine: 124, endLine: 130 }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (mainTurnIdx === 6) {
        const expMsg = (opts.messages ?? []).find((m) => m.toolCallId === 'tc-exp');
        const expText = expMsg?.content?.[0]?.text ?? '';
        assert.match(expText, /computeRate\(x\)/, 'expand_context must restore lossless verbatim slice from ReversibleContextStore');
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-w1', name: 'write_file', arguments: JSON.stringify({ path: 'src/target.js', content: 'export function computeRate(x) { return x * 3; }\n' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (mainTurnIdx === 7) {
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-b1', name: 'bash', arguments: JSON.stringify({ command: 'node --test' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'Fixed computeRate in src/target.js and verified.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }

  const adapter = new AciDualAdapter();
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });

  const app = Fastify();
  v1Routes(app, { store, providers: { models: [] }, pool, directAgent: direct });
  await app.ready();

  t.after(async () => {
    await app.close();
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  // Configure live ContextSupervisor through v1Routes endpoints
  const patchRes = await app.inject({
    method: 'PATCH',
    url: '/v1/context/supervisor',
    payload: {
      enabled: true,
      mode: 'custom',
      model: 'fast-supervisor',
      epochWatermarks: [0.45, 0.70, 0.85],
    },
  });
  assert.equal(patchRes.statusCode, 200);
  const statusRes = await app.inject({ method: 'GET', url: '/v1/context/supervisor' });
  assert.equal(statusRes.statusCode, 200);
  assert.equal(statusRes.json().effectiveModel, 'fast-supervisor');
  assert.equal(statusRes.json().toolsAllowed.length, 0);

  direct.sandbox = {
    async run() {
      return { exitCode: 0, stdout: 'pass 1\nfail 0', stderr: '' };
    },
  };
  const session = direct.createSession({
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    budget: { maxTokens: 19000, maxSteps: 12 },
    aciOptions: { dtocPolicy: 'cumulative', admissionEnabled: false },
  });
  const { turn } = direct.startTurn(session.id, { input: 'Update computeRate in src/target.js', maxSteps: 12 });
  const settled = await waitTurnDone(direct, session.id, turn.id, 20_000);
  assert.equal(settled.state, 'completed');

  // Verify static system prompt byte-identity across all steps (KV Prompt Cache invariant)
  assert.ok(mainSystemPrefixes.length >= 6);
  for (const prefix of mainSystemPrefixes) {
    assert.equal(prefix, mainSystemPrefixes[0], 'Static system prompt prefix must remain byte-identical across ACI epochs');
  }

  // Verify Supervisor was only invoked at epoch crossing, not every step
  assert.ok(supervisorCalls.length >= 1 && supervisorCalls.length <= 2);

  // Verify CONTEXT_COMPACTED with stage: 'aci_dtoc' and pairClosedValid: true
  const compactedEv = store.db
    .prepare("SELECT data FROM direct_events WHERE turnId=? AND type='context/compacted' ORDER BY seq ASC")
    .all(turn.id)
    .map((r) => JSON.parse(r.data));
  const aciEv = compactedEv.find((d) => d.stage === 'aci_dtoc');
  assert.ok(aciEv, 'Expected context/compacted event with stage: aci_dtoc');
  assert.equal(aciEv.pairClosedValid, true);

  // Verify ACI metrics inside turn/completed reasoningMetrics
  const completedEv = JSON.parse(
    store.db.prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/completed'").get(turn.id).data,
  );
  const aciMetrics = completedEv.reasoningMetrics?.aciMetrics;
  assert.ok(aciMetrics);
  assert.ok(aciMetrics.offloadedCount >= 1);
  assert.ok(aciMetrics.savedTokens > 0);
  assert.ok(aciMetrics.restoredCount >= 1);
  assert.ok(aciMetrics.epochTransitions >= 1);
  assert.equal(aciMetrics.supervisorCalls, supervisorCalls.length);
  assert.equal(aciMetrics.supervisorMode, 'custom');
  assert.equal(aciMetrics.supervisorModel, 'fast-supervisor');
  assert.equal(aciMetrics.criticalContextRecall, 1);
});

test('Step 3: ContextAssembler & DirectAgent admit ONLY verified experience memory and record retrieval telemetry', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-step3-exp-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-step3-exp-ws-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  writeFileSync(join(workDir, 'src', 'index.js'), 'export const port = 8420;\n', 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('exp-gate-model');
  const memory = new ExperienceMemoryService({ store });

  // 1. Seed unverified and forged items
  memory.remember(
    {
      type: 'lesson',
      key: 'unverified-trap',
      content: 'UNVERIFIED_TRAP_DO_NOT_INJECT_THIS',
      confidence: 0.99,
      verified: true, // stripped to false because remember() is untrusted
    },
    { projectId: 'ar-01-proj' },
  );

  // 2. Seed one genuine trusted_server_verifier item
  store.add(
    'evaluation_runs',
    {
      id: 'eval-trusted-run-1',
      projectId: 'ar-01-proj',
      synthetic: true,
      status: 'completed',
      score: { total: 1, passed: 1, failed: 0, cancelled: 0, timedOut: 0 },
      results: [{ taskId: 'ar-01-unfamiliar-codebase', status: 'passed', passed: true }],
    },
    null,
    null,
    'eval-trusted-run-1',
  );
  memory.distillTurnExperience({
    projectId: 'ar-01-proj',
    input: 'Keep server port 8420',
    summary: 'VERIFIED_TRUSTED_SERVER_LESSON_PORT_8420',
    verdict: { verdict: 'pass', accepted: true },
    modifiedFiles: ['src/index.js'],
    evaluationEvidence: {
      sourceTaskId: 'ar-01-unfamiliar-codebase',
      evaluationRunId: 'eval-trusted-run-1',
      projectId: 'ar-01-proj',
      score: { total: 1, passed: 1, failed: 0, cancelled: 0, timedOut: 0 },
      passed: true,
    },
  });

  const capturedPrompts = [];
  const adapter = new ScriptedAdapter(async function* (opts) {
    capturedPrompts.push(JSON.stringify(opts.messages ?? []));
    yield { type: 'text-delta', index: 0, text: 'Checked port 8420.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
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

  const session = direct.createSession({
    workspaceRoot: workDir,
    projectId: 'ar-01-proj',
    permissionMode: 'full-access',
  });
  const { turn } = direct.startTurn(session.id, { input: 'Verify port setting in src/index.js' });
  const done = await waitTurnDone(direct, session.id, turn.id, 20_000);
  assert.equal(done.state, 'completed');

  const promptText = capturedPrompts[0] ?? '';
  assert.ok(promptText.includes('VERIFIED_TRUSTED_SERVER_LESSON_PORT_8420'));
  assert.equal(promptText.includes('UNVERIFIED_TRAP_DO_NOT_INJECT_THIS'), false);

  const completedEv = JSON.parse(
    store.db.prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/completed'").get(turn.id).data,
  );
  assert.deepEqual(completedEv.experienceMemory, {
    queried: true,
    verifiedOnly: true,
    retrievedCount: 1,
    verifiedCount: 1,
    usedTokens: completedEv.experienceMemory.usedTokens,
    sources: ['evaluation'],
  });
  assert.ok(completedEv.experienceMemory.usedTokens > 0);
});

test('Round 2: Cumulative 160k session budget triggers ACI Epoch DTOC + read-only Supervisor while single-step tokens stay ~5k, plus ordering_precedence pre-completion check', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-r2-cumul-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-r2-cumul-ws-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  const adj = ['fast', 'safe', 'clean', 'strict', 'pure', 'lazy', 'async', 'sync'];
  const noun = ['Parser', 'Router', 'Ledger', 'Cache', 'Codec', 'Guard', 'Planner', 'Store'];
  const bigModule = Array.from({ length: 65 }, (_, i) => `export function fn_${noun[i % noun.length]}_${adj[(i * 3) % adj.length]}(v) { return v; }`).join('\n');
  writeFileSync(join(workDir, 'src', 'index.js'), `${bigModule}\nexport const port = 8420;\n`, 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'workbuddy',
    label: 'cumul-test-pool',
    credential: 'sk-test-cumul-pool-0001',
    protocol: 'openai',
    endpoint: 'https://api.example.invalid/v1',
    models: ['main-model', 'fast-supervisor'],
  });
  pool.setDefaultModel('main-model');

  const sysPrefixes = [];
  let supCalls = 0;
  let stepIdx = 0;
  let sawOrderingReminder = false;

  class CumulativeAciAdapter extends LlmAdapter {
    async *stream(opts) {
      if (opts.model === 'fast-supervisor' || (Array.isArray(opts.tools) && opts.tools.length === 0 && /ContextSupervisor/i.test(String(opts.system ?? '')))) {
        assert.deepEqual(opts.tools, []);
        supCalls += 1;
        const payload = JSON.parse(opts.messages[0].content[0].text);
        const idxCand = payload.candidates.find((c) => /index\.js/.test(c.path));
        yield {
          type: 'text-delta',
          index: 0,
          text: JSON.stringify({
            keepRefs: [],
            compressRefs: [idxCand?.id].filter(Boolean),
            rationale: 'Compress older index.js read at cumulative 45% epoch',
          }),
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      stepIdx += 1;
      sysPrefixes.push(opts.messages?.[0]?.content?.[0]?.text ?? '');

      if (stepIdx === 1) {
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-read-idx', name: 'read_file', arguments: JSON.stringify({ path: 'src/index.js' }) } };
        yield { type: 'usage', usage: { inputTokens: 25000, outputTokens: 1000 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepIdx === 2) {
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-glob-1', name: 'glob', arguments: JSON.stringify({ pattern: 'src/*' }) } };
        yield { type: 'usage', usage: { inputTokens: 25000, outputTokens: 1000 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepIdx === 3) {
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-glob-2', name: 'glob', arguments: JSON.stringify({ pattern: 'src/*.js' }) } };
        yield { type: 'usage', usage: { inputTokens: 20000, outputTokens: 1000 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepIdx === 4) {
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-write-contract', name: 'write_file', arguments: JSON.stringify({ path: 'CONTRACT.json', content: JSON.stringify({ precedence: ['env', 'profile', 'defaults'] }) }) } };
        yield { type: 'usage', usage: { inputTokens: 15000, outputTokens: 1000 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepIdx === 5) {
        // Cumulative totalIn+totalOut = 88k + ~5k >= 0.45 * 160000 (72k) and src/index.js age = 4 - 1 = 3 >= 3 -> offloaded deterministically with Supervisor abstaining (only 1 candidate)
        const stubMsg = (opts.messages ?? []).find((m) => m.role === 'tool' && /\[ACI-REF\s+artifact:\/\//.test(m.content?.[0]?.text ?? ''));
        assert.ok(stubMsg, 'Cumulative budget crossing 45% of 160k must trigger Epoch DTOC compression');
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-bash-ok', name: 'bash', arguments: JSON.stringify({ command: 'node --test' }) } };
        yield { type: 'usage', usage: { inputTokens: 4000, outputTokens: 500 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepIdx === 6) {
        yield { type: 'text-delta', index: 0, text: 'Produced CONTRACT.json.' };
        yield { type: 'usage', usage: { inputTokens: 4000, outputTokens: 200 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const lastUser = [...(opts.messages ?? [])].reverse().find((m) => m.role === 'user')?.content?.[0]?.text ?? '';
      if (/highest-to-lowest/i.test(lastUser)) sawOrderingReminder = true;
      yield { type: 'text-delta', index: 0, text: 'Verified highest-to-lowest precedence in CONTRACT.json.' };
      yield { type: 'usage', usage: { inputTokens: 4000, outputTokens: 200 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }

  const adapter = new CumulativeAciAdapter();
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });
  const app = Fastify();
  v1Routes(app, { store, providers: { models: [] }, pool, directAgent: direct });
  await app.ready();

  t.after(async () => {
    await app.close();
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  await app.inject({
    method: 'PATCH',
    url: '/v1/context/supervisor',
    payload: { enabled: true, mode: 'custom', model: 'fast-supervisor', epochWatermarks: [0.45, 0.70, 0.85] },
  });
  direct.sandbox = {
    async run() { return { exitCode: 0, stdout: 'pass 1\nfail 0', stderr: '' }; },
  };
  const session = direct.createSession({
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    budget: { maxTokens: 160000, maxSteps: 12 },
    aciOptions: { dtocPolicy: 'cumulative', admissionEnabled: false },
  });
  const { turn } = direct.startTurn(session.id, {
    input: 'Inspect src/index.js precedence rules and write CONTRACT.json (`precedence`).',
    maxSteps: 12,
  });
  const settled = await waitTurnDone(direct, session.id, turn.id, 20_000);
  assert.equal(settled.state, 'completed');
  assert.equal(supCalls, 0, 'Repoformer abstention gate must skip Supervisor when fewer than 2 eligible candidates exist');
  assert.equal(sawOrderingReminder, true, 'Expected highest-to-lowest ordering_precedence pre-completion check');
  for (const p of sysPrefixes) assert.equal(p, sysPrefixes[0]);

  const completedEv = JSON.parse(
    store.db.prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/completed'").get(turn.id).data,
  );
  const am = completedEv.reasoningMetrics?.aciMetrics;
  assert.ok(am.offloadedCount >= 1);
  assert.ok(am.savedTokens > 0);
  assert.equal(am.supervisorCalls, 0);
  const compactedEvs = store.db
    .prepare("SELECT data FROM direct_events WHERE turnId=? AND type='context/compacted'")
    .all(turn.id)
    .map((r) => JSON.parse(r.data));
  assert.equal(compactedEvs.find((d) => d.stage === 'aci_dtoc')?.pairClosedValid, true);
});

test('Round 3: Repoformer abstains when 0 eligible (< 2 / < 2400 chars), while superseded pre-edit read_file offloads cleanly with >= 2 candidates and restores verbatim', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-r3-sup-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-r3-sup-ws-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  const preReadContent = Array.from({ length: 24 }, (_, i) => `export const modA_item_${['a','b','c','d'][i % 4]}_${i * 13} = () => '${['x','y','z'][i % 3]}';`).join('\n');
  const helperContent = Array.from({ length: 30 }, (_, i) => `export const modB_item_${['p','q','r','s'][i % 4]}_${i * 17} = () => '${['m','n','k'][i % 3]}';`).join('\n');
  writeFileSync(join(workDir, 'src', 'a.js'), preReadContent, 'utf8');
  writeFileSync(join(workDir, 'src', 'b.js'), helperContent, 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'workbuddy',
    label: 'r3-sup-pool',
    credential: 'sk-test-r3-pool-0001',
    protocol: 'openai',
    endpoint: 'https://api.example.invalid/v1',
    models: ['main-model', 'fast-supervisor'],
  });
  pool.setDefaultModel('main-model');

  let supCalls = 0;
  let stepIdx = 0;
  let restoredStubText = '';

  class R3SupervisorAdapter extends LlmAdapter {
    async *stream(opts) {
      if (opts.model === 'fast-supervisor' || (Array.isArray(opts.tools) && opts.tools.length === 0 && /ContextSupervisor/i.test(String(opts.system ?? '')))) {
        assert.deepEqual(opts.tools, []);
        supCalls += 1;
        const payload = JSON.parse(opts.messages[0].content[0].text);
        assert.ok(payload.candidates.length >= 2, 'Supervisor only fires with >= 2 eligible candidates');
        const totalChars = payload.candidates.reduce((s, c) => s + Number(c.chars || 0), 0);
        assert.ok(totalChars >= 2400, 'Supervisor only fires when totalEligibleChars >= 2400');
        yield {
          type: 'text-delta',
          index: 0,
          text: JSON.stringify({
            keepRefs: [],
            compressRefs: payload.candidates.map((c) => c.id),
            rationale: 'Offload superseded pre-edit src/a.js and old src/b.js reads',
          }),
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      stepIdx += 1;
      if (stepIdx === 1) {
        // Step 1: read src/b.js (age reaches 3 at step 4!)
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-r3-b1', name: 'read_file', arguments: JSON.stringify({ path: 'src/b.js' }) } };
        yield { type: 'usage', usage: { inputTokens: 49000, outputTokens: 1000 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepIdx === 2) {
        // Step 2: read src/a.js (superseded by write_file at step 3, age reaches 2 at step 4!)
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-r3-a1', name: 'read_file', arguments: JSON.stringify({ path: 'src/a.js' }) } };
        yield { type: 'usage', usage: { inputTokens: 49000, outputTokens: 1000 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepIdx === 3) {
        // Cumulative 100k >= 0.60 * 160000 (96k), BUT at steps=2 neither b1 (age=1) nor a1 (age=0) is eligible -> skips cleanly (supCalls=0)
        assert.equal(supCalls, 0, 'Must abstain completely when eligibleCandidates.length === 0');
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-r3-wa', name: 'write_file', arguments: JSON.stringify({ path: 'src/a.js', content: 'export const updatedA = true;\n' }) } };
        yield { type: 'usage', usage: { inputTokens: 4000, outputTokens: 200 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepIdx === 4) {
        // At steps=3: b1 age=2 (<3), a1 age=1 (<2) -> STILL 0 eligible, 0 wasted supervisor calls, 0.60 stays armed!
        assert.equal(supCalls, 0, 'Must keep abstaining while age thresholds are unmet');
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-r3-g', name: 'glob', arguments: JSON.stringify({ pattern: 'src/*' }) } };
        yield { type: 'usage', usage: { inputTokens: 4000, outputTokens: 200 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepIdx === 5) {
        // Now steps=4: b1 (step 1, age=3 >= 3) AND superseded a1 (step 2, age=2 >= 2) are BOTH eligible -> Supervisor runs ONCE and DTOC offloads BOTH!
        const stubs = (opts.messages ?? []).filter((m) => m.role === 'tool' && /\[ACI-REF\s+artifact:\/\//.test(m.content?.[0]?.text ?? ''));
        assert.ok(stubs.length >= 2, `Expected >= 2 compressed [ACI-REF] stubs including superseded pre-edit src/a.js; got ${stubs.length}`);
        const refUriA = stubs.find((m) => m.toolCallId === 'tc-r3-a1')?.content?.[0]?.text?.match(/\[ACI-REF\s+(artifact:\/\/[a-f0-9]+)/)?.[1]
          ?? stubs[0].content[0].text.match(/\[ACI-REF\s+(artifact:\/\/[a-f0-9]+)/)[1];
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-r3-exp', name: 'expand_context', arguments: JSON.stringify({ uri: refUriA, startLine: 1, endLine: 6 }) } };
        yield { type: 'usage', usage: { inputTokens: 4000, outputTokens: 200 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepIdx === 6) {
        restoredStubText = (opts.messages ?? []).find((m) => m.toolCallId === 'tc-r3-exp')?.content?.[0]?.text ?? '';
        assert.match(restoredStubText, /modA_item_/, 'expand_context must restore superseded pre-edit src/a.js verbatim');
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-r3-bash', name: 'bash', arguments: JSON.stringify({ command: 'node --test' }) } };
        yield { type: 'usage', usage: { inputTokens: 3000, outputTokens: 100 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'Completed Round 3 verification.' };
      yield { type: 'usage', usage: { inputTokens: 3000, outputTokens: 100 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }

  const adapter = new R3SupervisorAdapter();
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });
  const app = Fastify();
  v1Routes(app, { store, providers: { models: [] }, pool, directAgent: direct });
  await app.ready();

  t.after(async () => {
    await app.close();
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  await app.inject({
    method: 'PATCH',
    url: '/v1/context/supervisor',
    payload: { enabled: true, mode: 'custom', model: 'fast-supervisor', epochWatermarks: [0.6, 0.82] },
  });
  direct.sandbox = {
    async run() { return { exitCode: 0, stdout: 'pass 1\nfail 0', stderr: '' }; },
  };
  const session = direct.createSession({
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    budget: { maxTokens: 160000, maxSteps: 14 },
    aciOptions: { dtocPolicy: 'cumulative', admissionEnabled: false },
  });
  const { turn } = direct.startTurn(session.id, { input: 'Update src/a.js after inspecting src/b.js', maxSteps: 14 });
  const settled = await waitTurnDone(direct, session.id, turn.id, 20_000);
  assert.equal(settled.state, 'completed');
  assert.equal(supCalls, 1, 'Supervisor should run exactly once when >= 2 eligible candidates reach >= 2400 chars');

  const completedEv = JSON.parse(
    store.db.prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/completed'").get(turn.id).data,
  );
  const am = completedEv.reasoningMetrics?.aciMetrics;
  assert.ok(am.offloadedCount >= 2);
  assert.ok(am.savedTokens > 0);
  assert.ok(am.restoredCount >= 1);
  assert.equal(am.supervisorCalls, 1);
});

test('Stage 4: expand_context verifies SHA-256 across outline/hunk/verbatim and rejects tampered SQLite blobs', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-s4-expand-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-s4-expand-ws-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => {
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  const tools = createWorkspaceTools({
    workspaceRoot: workDir,
    store,
    permissionMode: 'auto-safe',
  });
  const expandTool = tools.find((tool) => tool.name === 'expand_context');
  assert.ok(expandTool);

  const sampleCode = [
    'import { verifyHash } from "./crypto.js";',
    '',
    'export function processOrder(order) {',
    '  return verifyHash(order.id);',
    '}',
    '',
    'export function auditPersistence(db) {',
    '  return db.prepare("SELECT 1");',
    '}',
  ].join('\n');
  const put = store.putBlob(sampleCode);

  const outlineOut = await expandTool.execute({ ref: put.uri, level: 'outline' }, {});
  assert.match(outlineOut, /\[expand_context sha256:[a-f0-9]{12} verified=true outline/);
  assert.match(outlineOut, /Imports:/);
  assert.match(outlineOut, /processOrder/);

  const hunkOut = await expandTool.execute({ ref: put.uri, level: 'hunk', symbols: ['auditPersistence'] }, {});
  assert.match(hunkOut, /\[expand_context sha256:[a-f0-9]{12} verified=true hunk/);
  assert.match(hunkOut, /auditPersistence/);

  const verbatimOut = await expandTool.execute({ ref: put.uri, level: 'verbatim', startLine: 3, endLine: 5 }, {});
  assert.match(verbatimOut, /\[expand_context sha256:[a-f0-9]{12} verified=true lines 3-5\/9\]/);
  assert.match(verbatimOut, /export function processOrder/);

  // Tamper SQLite blob content -> ARTIFACT_HASH_MISMATCH
  store.db.prepare('UPDATE blobs SET content=? WHERE sha256=?').run('tampered blob!', put.sha256);
  await assert.rejects(
    () => expandTool.execute({ ref: put.uri, level: 'verbatim' }, {}),
    (err) => err?.code === 'ARTIFACT_HASH_MISMATCH',
  );
});

test('Stage 4: DirectAgent supports all 4 aciProfiles, short-task DTOC KV preservation, pre-injection admission, and hash-verified expand_context', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-s4-profiles-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-s4-profiles-ws-'));
  mkdirSync(join(workDir, 'src', 'auth'), { recursive: true });
  mkdirSync(join(workDir, 'src', 'noise'), { recursive: true });

  const adj = ['fast', 'safe', 'clean', 'strict', 'pure', 'lazy', 'async', 'sync', 'cold', 'warm', 'deep', 'flat'];
  const noun = ['Parser', 'Router', 'Ledger', 'Cache', 'Codec', 'Guard', 'Planner', 'Store', 'Broker', 'Bridge', 'Filter', 'Sorter'];
  const verb = ['validate', 'normalize', 'resolve', 'compute', 'dispatch', 'serialize', 'reconcile', 'compact'];
  const tagWord = (i) => [0, 4, 8].map((s) => String.fromCharCode(97 + ((i * 7 + s) % 26))).join('');
  const authFile =
    Array.from({ length: 50 }, (_, i) => `export function auth${verb[i % verb.length]}${noun[i % noun.length]}_${tagWord(i)}(v) { return v ? '${adj[i % adj.length]}' : null; }`).join('\n') +
    '\nexport function verifySessionToken(tok) {\n  return typeof tok === "string" && tok.startsWith("valid_");\n}\n';
  const noiseFile = Array.from(
    { length: 80 },
    (_, i) => `export const banner_${adj[i % adj.length]}_${noun[i % noun.length]}_${tagWord(i)} = "static marketing blurb ${verb[i % verb.length]} ${adj[(i * 3) % adj.length]}";`,
  ).join('\n');
  const largeHelperFile =
    'import { authvalidateParser_aei } from "../auth/token.js";\n' +
    Array.from({ length: 85 }, (_, i) => `export function helper${verb[i % verb.length]}${noun[(i * 3) % noun.length]}_${tagWord(i)}(x) { return authvalidateParser_aei(x) ? '${adj[i % adj.length]}' : ''; }`).join('\n') +
    '\nexport function extraHelper80(x) { return authvalidateParser_aei(x); }\n';

  writeFileSync(join(workDir, 'src', 'auth', 'token.js'), authFile, 'utf8');
  writeFileSync(join(workDir, 'src', 'noise', 'marketing.js'), noiseFile, 'utf8');
  writeFileSync(join(workDir, 'src', 'extra.js'), largeHelperFile, 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'workbuddy',
    label: 's4-test-pool',
    credential: 'sk-test-s4-pool-0001',
    protocol: 'openai',
    endpoint: 'https://api.example.invalid/v1',
    models: ['main-model', 'fast-supervisor'],
  });
  pool.setDefaultModel('main-model');

  let stepCounter = 0;
  let supAdmissionCalls = 0;
  let capturedToolMessages = [];
  let sysPrefixes = [];

  class Stage4Adapter extends LlmAdapter {
    async *stream(opts) {
      const sysText = String(opts.system ?? opts.messages?.[0]?.content?.[0]?.text ?? '');
      if (
        opts.model === 'fast-supervisor' ||
        (Array.isArray(opts.tools) && opts.tools.length === 0 && /Pre-Injection Context Admission Supervisor/i.test(sysText))
      ) {
        assert.deepEqual(opts.tools, []);
        supAdmissionCalls += 1;
        const payload = JSON.parse(opts.messages[0].content[0].text);
        const decisions = payload.candidates.map((c) => {
          if (c.path.includes('auth/token.js')) {
            return { id: c.id, decision: 'IRRELEVANT', focusSymbols: ['verifySessionToken'], reason: 'test guardrail' };
          }
          return { id: c.id, decision: 'DEFER', reason: 'defer large extra helper' };
        });
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ decisions, contractHints: [] }) };
        yield { type: 'usage', usage: { inputTokens: 250, outputTokens: 50 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      stepCounter += 1;
      sysPrefixes.push(opts.messages?.[0]?.content?.[0]?.text ?? '');

      if (stepCounter === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 's4-r-auth', name: 'read_file', arguments: JSON.stringify({ path: 'src/auth/token.js' }) } };
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 's4-r-noise', name: 'read_file', arguments: JSON.stringify({ path: 'src/noise/marketing.js' }) } };
        yield { type: 'block-end', index: 2, block: { type: 'tool-call', id: 's4-r-extra', name: 'read_file', arguments: JSON.stringify({ path: 'src/extra.js' }) } };
        yield { type: 'usage', usage: { inputTokens: 52000, outputTokens: 200 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepCounter === 2) {
        capturedToolMessages = (opts.messages ?? []).filter((m) => m.role === 'tool');
        const extraMsg = capturedToolMessages.find((m) => m.toolCallId === 's4-r-extra')?.content?.[0]?.text ?? '';
        const match = extraMsg.match(/artifact:\/\/[a-f0-9]{64}/);
        if (match) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 's4-exp',
              name: 'expand_context',
              arguments: JSON.stringify({ ref: match[0], level: 'hunk', symbols: ['extraHelper80'] }),
            },
          };
          yield { type: 'usage', usage: { inputTokens: 52000, outputTokens: 200 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
      }
      if (stepCounter === 3) {
        const expToolMsg = (opts.messages ?? []).find((m) => m.toolCallId === 's4-exp')?.content?.[0]?.text ?? '';
        assert.match(expToolMsg, /verified=true/);
        assert.match(expToolMsg, /extraHelper80/);
      }
      yield { type: 'text-delta', index: 0, text: 'Completed Stage 4 check.' };
      yield { type: 'usage', usage: { inputTokens: 4000, outputTokens: 100 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }

  const adapter = new Stage4Adapter();
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

  const runProfile = async (aciProfile) => {
    stepCounter = 0;
    supAdmissionCalls = 0;
    capturedToolMessages = [];
    sysPrefixes = [];
    const sess = direct.createSession({
      workspaceRoot: workDir,
      permissionMode: 'full-access',
      aciProfile,
      aciOptions: { workingSetReadMaxChars: 2600 },
      budget: { maxTokens: 160000, maxSteps: 10 },
    });
    const { turn } = direct.startTurn(sess.id, {
      input: 'Check verifySessionToken and extraHelper80',
      maxSteps: 10,
    });
    const settled = await waitTurnDone(direct, sess.id, turn.id, 20_000);
    assert.equal(settled.state, 'completed');
    const ev = JSON.parse(
      store.db.prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/completed'").get(turn.id).data,
    );
    return {
      aciMetrics: ev.reasoningMetrics?.aciMetrics,
      supAdmissionCalls,
      capturedToolMessages,
      sysPrefixes,
    };
  };

  // 1. raw_full: admission=false, dtoc=false, supervisor=0, saved=0
  const rawRes = await runProfile('raw_full');
  assert.equal(rawRes.aciMetrics.aciProfile, 'raw_full');
  assert.equal(rawRes.aciMetrics.admissionEnabled, false);
  assert.equal(rawRes.aciMetrics.dtocEnabled, false);
  assert.equal(rawRes.supAdmissionCalls, 0);
  assert.equal(rawRes.aciMetrics.admissionSavedTokens, 0);
  assert.equal(rawRes.aciMetrics.epochTransitions, 0);
  const rawNoiseText = rawRes.capturedToolMessages.find((m) => m.toolCallId === 's4-r-noise')?.content?.[0]?.text ?? '';
  assert.match(rawNoiseText, /banner_sync_Store_hlp/, 'raw_full must inject full un-stubbed noise');

  // 2. deterministic_progressive: admission=true, supervisor=0, dtoc=false, admissionSavedTokens > 0
  const detRes = await runProfile('deterministic_progressive');
  assert.equal(detRes.aciMetrics.aciProfile, 'deterministic_progressive');
  assert.equal(detRes.aciMetrics.admissionEnabled, true);
  assert.equal(detRes.aciMetrics.dtocEnabled, false);
  assert.equal(detRes.supAdmissionCalls, 0);
  assert.ok(detRes.aciMetrics.admissionSavedTokens > 0);
  assert.equal(detRes.aciMetrics.epochTransitions, 0);

  // 3. retrieval_supervisor: admission=true, supervisor >= 1, dtoc=false
  const retRes = await runProfile('retrieval_supervisor');
  assert.equal(retRes.aciMetrics.aciProfile, 'retrieval_supervisor');
  assert.equal(retRes.aciMetrics.admissionEnabled, true);
  assert.equal(retRes.aciMetrics.dtocEnabled, false);
  assert.ok(retRes.supAdmissionCalls >= 1);
  assert.ok(retRes.aciMetrics.supervisorCalls >= 1);
  assert.ok(retRes.aciMetrics.supervisorCost.totalTokens > 0);
  assert.ok(retRes.aciMetrics.admissionSavedTokens > 0);
  assert.ok(retRes.aciMetrics.hashVerifiedRestores >= 1);

  // 4. full_aci: admission=true, dtoc=true (cache_aware_v31 default in 3.1), short task cumulative ~104k SKIPS DTOC (epochTransitions === 0)!
  const fullRes = await runProfile('full_aci');
  assert.equal(fullRes.aciMetrics.aciProfile, 'full_aci');
  assert.equal(fullRes.aciMetrics.admissionEnabled, true);
  assert.equal(fullRes.aciMetrics.dtocEnabled, true);
  assert.equal(fullRes.aciMetrics.dtocPolicy, 'cache_aware_v31');
  assert.equal(fullRes.aciMetrics.epochTransitions, 0, 'Short task (~5k prompt tokens) must skip DTOC even at 104k cumulative');
  assert.ok(fullRes.aciMetrics.admissionSavedTokens > 0);
  assert.ok(fullRes.aciMetrics.totalAciSavedTokens >= fullRes.aciMetrics.admissionSavedTokens);
  assert.ok(fullRes.aciMetrics.hashVerifiedRestores >= 1);
  assert.ok(fullRes.aciMetrics.recoveryStats.hashVerifiedCount >= 1);
  assert.ok(fullRes.aciMetrics.ledger?.admissions?.length >= 3);
  assert.equal(fullRes.aciMetrics.admissionDecisions.IRRELEVANT >= 1, true);
  assert.equal(fullRes.aciMetrics.admissionDecisions.SUPPORTING >= 1, true);
  for (const p of fullRes.sysPrefixes) {
    assert.equal(p, fullRes.sysPrefixes[0], 'System prompt prefix must stay byte-identical');
  }
});
