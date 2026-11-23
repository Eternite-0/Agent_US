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
import { ExperienceMemoryService } from '../src/memory/index.js';
import {
  EvaluationService,
  createDirectRuntimeAdapter,
  summarizeReasoningMetrics,
} from '../src/evaluation/service.js';
import { ToolDispatcher } from '../src/tools/dispatcher.js';
import { createWorkspaceTools } from '../src/workspace-tools.js';

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
