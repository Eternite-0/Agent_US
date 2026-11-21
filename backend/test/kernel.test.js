import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AgentRuntimeKernel } from '../src/kernel/runtime.js';
import {
  TURN_PHASES,
  TurnStateMachine,
} from '../src/kernel/state-machine.js';
import { CancellationManager } from '../src/kernel/cancellation.js';
import {
  BudgetError,
  CancellationError,
  InferenceError,
  PolicyError,
  RuntimeError,
  classifyError,
} from '../src/kernel/errors.js';

function createTempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-kernel-test-'));
  const store = new Store(join(dir, 'test.sqlite'));
  return {
    dir,
    store,
    cleanup() {
      store.close();
      rmDirSafe(dir);
    },
  };
}

test('P1 Kernel: TurnStateMachine enforces valid transitions and terminal immutability', () => {
  const { store, cleanup } = createTempStore();
  try {
    const sm = new TurnStateMachine({
      store,
      sessionId: 's1',
      turnId: 't1',
      initialPhase: TURN_PHASES.INIT,
    });
    assert.equal(sm.phase, TURN_PHASES.INIT);
    sm.transition(TURN_PHASES.CHECKPOINT, { step: 1, persist: false });
    sm.transition(TURN_PHASES.INFERENCE, { step: 1, persist: false });
    sm.transition(TURN_PHASES.TOOLS, { step: 1, persist: false });
    sm.transition(TURN_PHASES.CHECKPOINT, { step: 2, persist: false });
    sm.transition(TURN_PHASES.INFERENCE, { step: 2, persist: false });
    sm.transition(TURN_PHASES.VERIFYING, { step: 2, persist: false });
    sm.transition(TURN_PHASES.COMPLETED, { step: 2, persist: false });
    assert.equal(sm.isTerminal(), true);

    assert.throws(
      () => sm.transition(TURN_PHASES.INFERENCE, { step: 3, persist: false }),
      (err) => err instanceof RuntimeError && err.code === 'INVALID_TRANSITION',
    );
  } finally {
    cleanup();
  }
});

test('P1 Kernel: CancellationManager cascades parent->child and blocks silent revival', () => {
  const cm = new CancellationManager();
  try {
    const rootSig = cm.createEpoch('root');
    const childSig = cm.createEpoch('child', { parentId: 'root' });
    const grandSig = cm.createEpoch('grand', { parentId: 'child' });
    assert.equal(rootSig.aborted, false);
    assert.equal(childSig.aborted, false);
    assert.equal(grandSig.aborted, false);

    cm.cancel('root', 'user_abort');
    assert.equal(rootSig.aborted, true);
    assert.equal(childSig.aborted, true);
    assert.equal(grandSig.aborted, true);
    assert.equal(cm.isCancelled('grand'), true);

    assert.throws(
      () => cm.createEpoch('child'),
      (err) => err instanceof CancellationError && err.code === 'EPOCH_ALREADY_CANCELLED',
    );
  } finally {
    cm.closeAll();
  }
});

test('P1 Kernel: Error taxonomy classifies transient upstream errors, policy errors, and budgets', () => {
  const rateLimitErr = classifyError(Object.assign(new Error('HTTP 429 rate limit exceeded'), { status: 429 }));
  assert.ok(rateLimitErr instanceof InferenceError);
  assert.equal(rateLimitErr.retryable, true);

  const policyErr = classifyError(new PolicyError('POLICY_HARD_BLOCKED'));
  assert.equal(policyErr.category, 'policy');
  assert.equal(policyErr.retryable, false);

  const budgetErr = classifyError(new BudgetError('COST_BUDGET'));
  assert.equal(budgetErr.category, 'budget');
  assert.equal(budgetErr.retryable, false);
});

test('P1 Kernel: Unified AgentLoop runs multiple profiles, emits compaction & ordered tool events, and retries transient inference failures', async () => {
  const { store, cleanup } = createTempStore();
  let streamAttempts = 0;
  const mockAdapter = {
    async *stream({ messages }) {
      streamAttempts++;
      if (streamAttempts === 1) {
        throw Object.assign(new Error('503 temporarily unavailable'), { status: 503 });
      }
      const last = messages.at(-1);
      if (last?.role === 'user') {
        yield {
          type: 'block-end',
          block: {
            type: 'tool-call',
            id: 'call-1',
            name: 'echo_tool',
            arguments: JSON.stringify({ msg: 'hello-kernel' }),
          },
        };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        return;
      }
      yield { type: 'text-delta', text: 'Done: ' };
      yield { type: 'text-delta', text: 'hello-kernel' };
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } };
    },
  };

  const kernel = new AgentRuntimeKernel({ store, adapter: mockAdapter });
  kernel.registerProfile({
    id: 'custom_auditor',
    name: 'Custom Auditor Profile',
    defaultMaxSteps: 5,
    streamDeltas: true,
    emitAssistantMessage: true,
    emitToolEvents: true,
    persistTurn: false,
  });

  const events = [];
  kernel.eventRouter.subscribe('sess-kernel-1', (ev) => events.push(ev));

  const tools = [
    {
      name: 'echo_tool',
      meta: {
        readOnly: true,
        effectClass: 'read_only',
        riskLevel: 'low',
        replayable: true,
        outward: false,
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        return `echo:${args.msg}`;
      },
    },
    {
      name: 'danger_tool',
      meta: {
        readOnly: false,
        effectClass: 'irreversible_side_effect',
        riskLevel: 'high',
        replayable: false,
        outward: false,
      },
      async execute() {
        throw new Error('SHOULD_NEVER_EXECUTE_WITHOUT_APPROVAL');
      },
    },
  ];

  try {
    const res1 = await kernel.executeTurn({
      sessionId: 'sess-kernel-1',
      turnId: 'turn-k1',
      profile: 'custom_auditor',
      input: 'run echo',
      model: 'mock-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'run echo' }] }],
      tools,
      contextManager: {
        async prepareRequest(opts, { step }) {
          return {
            options: opts,
            stage: step === 1 ? 'prune' : 'none',
            tokens: 120,
          };
        },
      },
    });

    assert.equal(res1.status, 'completed');
    assert.equal(res1.text, 'Done: hello-kernel');
    assert.equal(res1.steps, 2);
    assert.equal(streamAttempts, 3); // 1 transient failure + 1 tool step + 1 final text step
    assert.equal(res1.usage.inputTokens, 22);
    assert.equal(res1.usage.outputTokens, 13);

    const types = events.filter((e) => !e.ephemeral).map((e) => e.type);
    assert.ok(types.includes('context/compacted'), 'context/compacted must fire when stage !== none');
    assert.ok(types.indexOf('tool/call') < types.indexOf('tool/result'));
    assert.ok(types.indexOf('tool/result') < types.indexOf('assistant/message'));

    // Run second profile ('subagent') using exact same Kernel & tool contract
    const res2 = await kernel.executeTurn({
      sessionId: 'sess-kernel-2',
      turnId: 'turn-k2',
      profile: 'subagent',
      input: 'subagent check',
      model: 'mock-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'subagent check' }] }],
      tools,
    });
    assert.equal(res2.status, 'completed');
    assert.equal(res2.text, 'Done: hello-kernel');

    // Verify Kernel default ToolDispatcher fails closed when non-readonly tool lacks approval callback
    const failClosedOut = await kernel.toolDispatcher.dispatchBatch({
      sessionId: 'sess-kernel-2',
      turnId: 'turn-k2',
      toolCalls: [{ id: 'tc-danger', name: 'danger_tool', arguments: '{}' }],
      tools,
      permissionMode: 'approval',
    });
    assert.equal(failClosedOut[0].isError, true);
    assert.match(failClosedOut[0].output, /Fail-Closed/);
  } finally {
    kernel.close();
    cleanup();
  }
});
