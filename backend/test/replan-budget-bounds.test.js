import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import {
  SWARM_NODE_STATES,
  SWARM_RUN_STATES,
  transitionSwarmNode,
  transitionSwarmRun,
} from '../src/swarm/node-state-machine.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }
  async *stream(options) {
    this.calls.push({
      model: options.model,
      maxTokens: options.maxTokens,
      messages: structuredClone(options.messages),
    });
    yield* this.handler(options, this.calls.length - 1);
  }
}

function createSwarmEnv({ models = null, defaultModel = 'mock-model', adapter }) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-replan-budget-'));
  const dbPath = join(dir, 'engine.sqlite');
  const store = new Store(dbPath);
  const pool = new AccountPool(
    store,
    models
      ? { root: dir, legacyProviders: { models } }
      : { root: dir },
  );
  if (!models && defaultModel) {
    pool.setDefaultModel(defaultModel);
  }
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter,
  });
  return {
    dir,
    dbPath,
    store,
    pool,
    direct,
    async cleanup() {
      await direct.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Part 1.1: node-state-machine supports non-terminal same-state metadata updates while strictly protecting terminal states', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-sm-meta-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  try {
    const now = Date.now();
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO swarm_runs(
            id, sessionId, goal, status, strategyJson, budgetJson, usageJson, planVersion, currentPhase, replanCount, createdAt, updatedAt
          ) VALUES('run-meta', 'sess-1', 'meta test', 'running', '{}', '{}', '{}', 1, 'running', 0, ?, ?)`,
        )
        .run(now, now);
      store.db
        .prepare(
          `INSERT INTO swarm_nodes(
            id, runId, nodeKey, agentProfileId, objective, acceptance, status, planVersion, budgetJson, createdAt, updatedAt
          ) VALUES('node-meta', 'run-meta', 'n1', 'research', 'obj', 'acc', 'running', 1, '{}', ?, ?)`,
        )
        .run(now, now);
    });

    // Same-state metadata update on running run MUST persist planVersion, replanCount, usageJson, budgetJson
    const updatedRun = transitionSwarmRun(store, 'run-meta', SWARM_RUN_STATES.RUNNING, {
      patch: {
        planVersion: 2,
        replanCount: 1,
        usageJson: JSON.stringify({ steps: 1, inputTokens: 10, outputTokens: 5 }),
        budgetJson: JSON.stringify({ maxTotalSteps: 5 }),
      },
    });
    assert.equal(updatedRun.planVersion, 2, 'Same-state running update must persist planVersion');
    assert.equal(updatedRun.replanCount, 1, 'Same-state running update must persist replanCount');
    assert.equal(JSON.parse(updatedRun.budgetJson).maxTotalSteps, 5, 'Same-state update must persist budgetJson');

    // Same-state metadata update on running node MUST persist planVersion & budgetJson
    const updatedNode = transitionSwarmNode(store, null, 'node-meta', SWARM_NODE_STATES.RUNNING, {
      patch: { planVersion: 2, budgetJson: JSON.stringify({ maxSteps: 2 }) },
    });
    assert.equal(updatedNode.planVersion, 2);
    assert.equal(JSON.parse(updatedNode.budgetJson).maxSteps, 2);

    // Transition node & run to terminal 'completed'
    transitionSwarmNode(store, null, 'node-meta', SWARM_NODE_STATES.COMPLETED, {
      patch: { resultText: 'original-result' },
    });
    transitionSwarmRun(store, 'run-meta', SWARM_RUN_STATES.COMPLETED, {
      patch: { verdictJson: JSON.stringify({ verdict: 'pass', accepted: true }) },
    });

    // Terminal state overwrite MUST be rejected (completed cannot be overwritten or reactivated)
    assert.throws(
      () =>
        transitionSwarmNode(store, null, 'node-meta', SWARM_NODE_STATES.COMPLETED, {
          patch: { resultText: 'tampered-result' },
        }),
      (err) => err.code === 'INVALID_SWARM_TRANSITION',
      'Terminal node metadata overwrite must be blocked',
    );
    assert.throws(
      () =>
        transitionSwarmRun(store, 'run-meta', SWARM_RUN_STATES.COMPLETED, {
          patch: { replanCount: 99 },
        }),
      (err) => err.code === 'INVALID_SWARM_TRANSITION',
      'Terminal run metadata overwrite must be blocked',
    );
    assert.throws(
      () => transitionSwarmRun(store, 'run-meta', SWARM_RUN_STATES.RUNNING),
      (err) => err.code === 'INVALID_SWARM_TRANSITION',
    );

    const checkNode = store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get('node-meta');
    assert.equal(checkNode.resultText, 'original-result');
    const checkRun = store.db.prepare('SELECT * FROM swarm_runs WHERE id=?').get('run-meta');
    assert.equal(checkRun.replanCount, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Part 1.2-1.5: two always-failing models with maxReplans=1 perform at most 1 replan, persist replanCount=1, and preserve true failure reason', async () => {
  const adapter = new ScriptedAdapter(async function* (opts) {
    await delay(15);
    throw new Error(`hard-upstream-outage on ${opts.model}`);
  });
  const env = createSwarmEnv({
    models: [
      { provider: 'openai', model: 'bad-model-a', context: 128000, tools: true, math: 0.95 },
      { provider: 'openai', model: 'bad-model-b', context: 128000, tools: true, math: 0.9 },
    ],
    adapter,
  });

  try {
    const sess = env.direct.createSession({ workspaceRoot: env.dir });
    const submitted = env.direct.swarmOrchestrator.submitRun({
      sessionId: sess.id,
      goal: 'Two always-failing models bounded by maxReplans=1',
      workspaceRoot: env.dir,
      maxReplans: 1,
      nodes: [
        { nodeKey: 'work', taskType: 'planning', objective: 'always fail task', dependencies: [] },
      ],
    });
    const out = await env.direct.swarmOrchestrator.waitForRun(submitted.runId, { timeoutMs: 3000 });

    const persistedRun = env.direct.swarmOrchestrator.getRun(out.runId);
    const replans = env.direct.swarmOrchestrator.listReplans(out.runId);

    assert.equal(out.status, 'failed');
    assert.equal(persistedRun.replanCount, 1, 'Persisted replanCount must equal 1');
    assert.equal(persistedRun.planVersion, 2, 'Persisted planVersion must increment to 2');
    assert.equal(replans.length, 1, 'At most 1 replan row must exist when maxReplans=1');
    assert.ok(
      adapter.calls.length <= 2,
      `Expected <= 2 inference attempts (1 initial + 1 replan), got ${adapter.calls.length}`,
    );
    const failedNode = persistedRun.nodes.find((n) => n.nodeKey === 'work');
    assert.equal(failedNode.status, 'failed');
    assert.match(String(failedNode.errorMessage || ''), /hard-upstream-outage/);
    assert.match(String(persistedRun.errorMessage || ''), /hard-upstream-outage/);
  } finally {
    await env.cleanup();
  }
});

test('Part 1.2-1.4: concurrent node failures produce monotonic plan versions, consistent replanCount/swarm_replans, and never exceed maxReplans', async () => {
  const adapter = new ScriptedAdapter(async function* (opts) {
    await delay(25);
    throw new Error(`concurrent-boom-${opts.model}`);
  });
  const env = createSwarmEnv({
    models: [
      { provider: 'openai', model: 'fail-x', context: 128000, tools: true },
      { provider: 'openai', model: 'fail-y', context: 128000, tools: true },
    ],
    adapter,
  });

  try {
    const sess = env.direct.createSession({ workspaceRoot: env.dir });
    const submitted = env.direct.swarmOrchestrator.submitRun({
      sessionId: sess.id,
      goal: 'Concurrent failures respect global maxReplans',
      workspaceRoot: env.dir,
      maxConcurrency: 4,
      maxReplans: 2,
      nodes: [
        { nodeKey: 'f1', taskType: 'research', objective: 'fail 1', dependencies: [] },
        { nodeKey: 'f2', taskType: 'research', objective: 'fail 2', dependencies: [] },
        { nodeKey: 'f3', taskType: 'research', objective: 'fail 3', dependencies: [] },
        { nodeKey: 'f4', taskType: 'research', objective: 'fail 4', dependencies: [] },
      ],
    });
    const out = await env.direct.swarmOrchestrator.waitForRun(submitted.runId, { timeoutMs: 3000 });

    const persistedRun = env.direct.swarmOrchestrator.getRun(out.runId);
    const replans = env.direct.swarmOrchestrator.listReplans(out.runId);

    assert.equal(out.status, 'failed');
    assert.equal(persistedRun.replanCount, 2, 'Global replanCount must not exceed maxReplans=2');
    assert.equal(replans.length, 2, 'swarm_replans rows must match replanCount=2');
    assert.deepEqual(
      replans.map((r) => r.version),
      [2, 3],
      'Plan versions in swarm_replans must be strictly monotonic without reuse',
    );
    assert.equal(persistedRun.planVersion, 3);

    // Direct CAS concurrency check: 3 simultaneous replan calls sharing stale run snapshot with maxReplans=2
    const now = Date.now();
    const casRunId = 'run-cas-concurrent';
    env.store.tx(() => {
      env.store.db
        .prepare(
          `INSERT INTO swarm_runs(
            id, sessionId, goal, status, strategyJson, budgetJson, usageJson, planVersion, currentPhase, replanCount, createdAt, updatedAt
          ) VALUES(?,?, 'cas test', 'running', '{"maxReplans":2}', '{}', '{}', 1, 'running', 0, ?, ?)`,
        )
        .run(casRunId, sess.id, now, now);
      for (const k of ['c1', 'c2', 'c3']) {
        env.store.db
          .prepare(
            `INSERT INTO swarm_nodes(
              id, runId, nodeKey, agentProfileId, model, provider, objective, acceptance, status, attempts, planVersion, budgetJson, createdAt, updatedAt
            ) VALUES(?,?,?,'research','fail-x','openai','obj','acc','running',1,1,'{}',?,?)`,
          )
          .run(`node-${k}`, casRunId, k, now, now);
      }
    });
    const staleRun = env.direct.swarmOrchestrator.getRun(casRunId);
    const results = await Promise.all(
      staleRun.nodes.map((n) =>
        env.direct.swarmReplanner.replan({
          run: staleRun,
          failedNode: n,
          errorCode: 'NODE_FAILED',
          errorMessage: 'simulated concurrent crash',
          maxReplans: 2,
        }),
      ),
    );
    const succeeded = results.filter((r) => r.replanned);
    const rejected = results.filter((r) => !r.replanned);
    assert.equal(succeeded.length, 2);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason, 'MAX_REPLANS_REACHED');

    const casRunAfter = env.direct.swarmOrchestrator.getRun(casRunId);
    const casReplans = env.direct.swarmOrchestrator.listReplans(casRunId);
    assert.equal(casRunAfter.replanCount, 2);
    assert.equal(casRunAfter.planVersion, 3);
    assert.deepEqual(casReplans.map((r) => r.version), [2, 3]);
  } finally {
    await env.cleanup();
  }
});

test('Part 2.1 & 2.2: three parallel nodes with total tree step budget = 1 admit at most 1 inference step combined', async () => {
  const adapter = new ScriptedAdapter(async function* (opts) {
    await delay(50);
    const lastUser = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    yield { type: 'text-delta', index: 0, text: `ok:${lastUser.slice(0, 20)}` };
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const env = createSwarmEnv({ adapter });

  try {
    const sess = env.direct.createSession({ workspaceRoot: env.dir });
    const out = await env.direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Three parallel nodes under tree step budget = 1',
      workspaceRoot: env.dir,
      maxConcurrency: 3,
      budget: { maxTotalSteps: 1 },
      nodes: [
        { nodeKey: 'p1', taskType: 'research', objective: 'parallel task 1', dependencies: [] },
        { nodeKey: 'p2', taskType: 'research', objective: 'parallel task 2', dependencies: [] },
        { nodeKey: 'p3', taskType: 'research', objective: 'parallel task 3', dependencies: [] },
      ],
    });

    assert.equal(
      adapter.calls.length,
      1,
      `At most 1 inference step may be admitted across 3 parallel nodes when maxTotalSteps=1, got ${adapter.calls.length}`,
    );
    const completed = out.nodes.filter((n) => n.status === 'completed');
    const unfinished = out.nodes.filter((n) => n.status !== 'completed');
    assert.equal(completed.length, 1);
    assert.equal(unfinished.length, 2);
    assert.equal(out.status, 'failed', 'Run stopped by budget exhaustion with unfinished nodes must NOT be false completed');
  } finally {
    await env.cleanup();
  }
});

test('Part 2.3 & 2.7: retries, failed attempts, and planning model calls consume shared task-tree budget', async () => {
  // Subcase A: Failed attempts & retries consume tree step budget
  const retryAdapter = new ScriptedAdapter(async function* () {
    await delay(10);
    throw new Error('non-budget transient boom');
  });
  const envA = createSwarmEnv({ adapter: retryAdapter });
  try {
    const sess = envA.direct.createSession({ workspaceRoot: envA.dir });
    const submitted = envA.direct.swarmOrchestrator.submitRun({
      sessionId: sess.id,
      goal: 'Retries consume tree step budget',
      workspaceRoot: envA.dir,
      maxReplans: 3,
      budget: { maxTotalSteps: 2 },
      nodes: [
        { nodeKey: 'flaky', taskType: 'research', objective: 'always fail step', dependencies: [] },
      ],
    });
    const out = await envA.direct.swarmOrchestrator.waitForRun(submitted.runId, { timeoutMs: 3000 });

    assert.equal(out.status, 'failed');
    assert.equal(
      retryAdapter.calls.length,
      2,
      `Failed attempts + retries must stop at maxTotalSteps=2 even with maxReplans=3, got ${retryAdapter.calls.length} calls`,
    );
  } finally {
    await envA.cleanup();
  }

  // Subcase B: Planning LLM call + execution nodes share the same tree step budget
  const planAdapter = new ScriptedAdapter(async function* (opts) {
    const sys = opts.messages.find((m) => m.role === 'system')?.content?.[0]?.text ?? '';
    if (sys.includes('Decompose the engineering goal')) {
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          nodes: [
            { nodeKey: 'n1', taskType: 'research', objective: 'first planned node', dependencies: [] },
            { nodeKey: 'n2', taskType: 'review', objective: 'second planned node', dependencies: ['n1'] },
          ],
        }),
      };
      yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 20 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'node done' };
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const envB = createSwarmEnv({ adapter: planAdapter });
  try {
    const sess = envB.direct.createSession({ workspaceRoot: envB.dir });
    const out = await envB.direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Investigate module with planning + execution budget scope',
      workspaceRoot: envB.dir,
      budget: { maxTotalSteps: 2 }, // 1 step for planning + 1 step for n1 -> n2 must NOT run!
    });

    assert.equal(
      planAdapter.calls.length,
      2,
      `Planning call (1) + first node (1) must exhaust maxTotalSteps=2 and block n2, got ${planAdapter.calls.length} calls`,
    );
    assert.equal(out.status, 'failed', 'Run with unexecuted planned node due to budget must not be false completed');
  } finally {
    await envB.cleanup();
  }
});

test('Part 2.5: explicit 0 budget admits 0 steps (never unlimited), while null/undefined remains unlimited', async () => {
  const adapter = new ScriptedAdapter(async function* () {
    yield { type: 'text-delta', index: 0, text: 'should not execute on 0 budget' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const env = createSwarmEnv({ adapter });

  try {
    const sess = env.direct.createSession({ workspaceRoot: env.dir });

    // Explicit maxTotalSteps = 0
    const zeroSteps = await env.direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Zero step budget test',
      workspaceRoot: env.dir,
      budget: { maxTotalSteps: 0 },
      nodes: [{ nodeKey: 'z1', taskType: 'research', objective: 'must not run', dependencies: [] }],
    });
    assert.equal(adapter.calls.length, 0, 'maxTotalSteps: 0 must admit 0 inference steps');
    assert.equal(zeroSteps.status, 'failed');

    // Explicit maxTotalTokens = 0
    const zeroTokens = await env.direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Zero token budget test',
      workspaceRoot: env.dir,
      budget: { maxTotalTokens: 0 },
      nodes: [{ nodeKey: 'z2', taskType: 'research', objective: 'must not run', dependencies: [] }],
    });
    assert.equal(adapter.calls.length, 0, 'maxTotalTokens: 0 must admit 0 inference steps');
    assert.equal(zeroTokens.status, 'failed');

    // Direct kernel executeTurn with explicit maxSteps: 0
    await assert.rejects(
      () =>
        env.direct.kernel.executeTurn({
          sessionId: sess.id,
          turnId: 'turn-zero-steps',
          profile: 'subagent',
          input: 'zero steps',
          model: 'mock-model',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'zero steps' }] }],
          budget: { maxSteps: 0 },
        }),
      (err) => err.category === 'budget',
      'AgentLoop with maxSteps: 0 must reject with BudgetError instead of running 1 step or completing',
    );
    assert.equal(adapter.calls.length, 0);

    // null / undefined means unlimited
    const unlimited = await env.direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Unlimited null/undefined budget test',
      workspaceRoot: env.dir,
      budget: { maxTotalSteps: null, maxTotalTokens: undefined },
      nodes: [{ nodeKey: 'u1', taskType: 'research', objective: 'should run', dependencies: [] }],
    });
    assert.equal(unlimited.status, 'completed');
    assert.equal(adapter.calls.length, 1);
  } finally {
    await env.cleanup();
  }
});

test('Part 2.6: per-node caps are preserved as min(nodeCap, treeRemaining) and never widened by larger tree remaining', async () => {
  let cappedNodeCalls = 0;
  const adapter = new ScriptedAdapter(async function* (opts) {
    const userText = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    if (userText.includes('TIGHT_NODE')) {
      cappedNodeCalls++;
      // Keep requesting tool calls to attempt consuming multiple steps
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: `tc-loop-${cappedNodeCalls}`,
          name: 'glob',
          arguments: JSON.stringify({ pattern: '*' }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'sibling ok' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const env = createSwarmEnv({ adapter });

  try {
    const sess = env.direct.createSession({ workspaceRoot: env.dir });
    const out = await env.direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Per-node cap must not widen to tree remaining',
      workspaceRoot: env.dir,
      maxReplans: 0,
      budget: { maxTotalSteps: 10 },
      nodes: [
        {
          nodeKey: 'tight',
          taskType: 'research',
          objective: 'TIGHT_NODE should stop after 1 step',
          dependencies: [],
          budget: { maxSteps: 1 },
        },
        {
          nodeKey: 'sibling',
          taskType: 'research',
          objective: 'normal sibling node',
          dependencies: [],
        },
      ],
    });

    assert.equal(
      cappedNodeCalls,
      1,
      `Per-node maxSteps=1 must NOT be widened to tree remaining (10); got ${cappedNodeCalls} calls`,
    );
    assert.equal(out.nodes.find((n) => n.nodeKey === 'sibling').status, 'completed');
    assert.equal(out.nodes.find((n) => n.nodeKey === 'tight').status, 'failed');
  } finally {
    await env.cleanup();
  }
});

test('Part 2.8: token budget constrains provider maxOutputTokens, releases unused balance, rejects oversized prompts pre-inference, and records estimationError & overage', async () => {
  const adapter = new ScriptedAdapter(async function* (opts) {
    const userText = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    if (userText.includes('TINY_ACTUAL')) {
      // Actual usage much smaller than reserved -> releases unused balance for next node
      yield { type: 'text-delta', index: 0, text: 'short' };
      yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 15 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    // Simulate provider reporting higher billing than local estimate (causing overage > 2000)
    yield { type: 'text-delta', index: 0, text: 'overage reply' };
    yield { type: 'usage', usage: { inputTokens: 1700, outputTokens: 300 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const env = createSwarmEnv({ adapter });

  try {
    const sess = env.direct.createSession({ workspaceRoot: env.dir });
    const out = await env.direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Token budget clamping, release, estimation error & overage',
      workspaceRoot: env.dir,
      maxConcurrency: 1,
      budget: { maxTotalTokens: 2000 },
      nodes: [
        { nodeKey: 't1', taskType: 'research', objective: 'TINY_ACTUAL first', toolAllow: ['read_file'], dependencies: [] },
        { nodeKey: 't2', taskType: 'research', objective: 'OVERAGE_TRIGGER second', toolAllow: ['read_file'], dependencies: ['t1'] },
        { nodeKey: 't3', taskType: 'research', objective: 'BLOCKED third', toolAllow: ['read_file'], dependencies: ['t2'] },
      ],
    });

    assert.equal(adapter.calls.length, 2, 't1 releases unused tokens so t2 runs; t2 causes overage so t3 is blocked');
    assert.ok(
      adapter.calls[0].maxTokens < 2000 && adapter.calls[0].maxTokens > 0,
      `Provider maxOutputTokens must be constrained below tree maxTotalTokens (2000), got ${adapter.calls[0].maxTokens}`,
    );
    assert.equal(out.nodes.find((n) => n.nodeKey === 't1').status, 'completed');
    assert.equal(out.nodes.find((n) => n.nodeKey === 't2').status, 'completed');
    assert.equal(out.nodes.find((n) => n.nodeKey === 't3').status, 'cancelled');
    assert.equal(out.nodes.find((n) => n.nodeKey === 't3').errorCode, 'BUDGET_EXCEEDED');
    assert.equal(out.status, 'failed', 'Run with t3 cancelled due to token overage must not be false completed');

    // Verify durable ledger records estimationError and overage
    const ledgerRow = env.store.db.prepare('SELECT * FROM budget_ledgers WHERE treeId=?').get(out.runId);
    assert.ok(ledgerRow, 'budget_ledgers row must exist for swarm run');
    assert.ok(ledgerRow.overageTokens > 0, `Expected positive overageTokens, got ${ledgerRow.overageTokens}`);
    assert.notEqual(ledgerRow.estimationErrorTokens, 0, 'Expected non-zero estimationErrorTokens recorded');

    // Pre-inference rejection when estimated input exceeds maxTotalTokens
    const beforePreReject = adapter.calls.length;
    const rejectedRun = await env.direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Pre-inference token rejection',
      workspaceRoot: env.dir,
      budget: { maxTotalTokens: 50 },
      nodes: [
        { nodeKey: 'too-big', taskType: 'research', objective: 'Prompt exceeds 50 tokens', toolAllow: ['read_file'], dependencies: [] },
      ],
    });
    assert.equal(adapter.calls.length, beforePreReject, 'Pre-inference check must block call before invoking provider');
    assert.equal(rejectedRun.status, 'failed');
    assert.equal(rejectedRun.errorCode, 'BUDGET_EXCEEDED');
  } finally {
    await env.cleanup();
  }
});

test('Part 2.4 & 2.9: restart recovers already-used budget and reconciles orphaned reservations accurately without re-granting original budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-budget-restart-'));
  const dbPath = join(dir, 'engine.sqlite');

  let store = new Store(dbPath);
  let pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-restart');
  let direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: new ScriptedAdapter(async function* () {
      yield { type: 'text-delta', index: 0, text: 'pre-crash' };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }),
  });

  try {
    const sess = direct.createSession({ workspaceRoot: dir });
    const now = Date.now();
    const runId = 'run-restart-budget';

    // Stop worker before inserting simulated crash state
    await direct.close();

    // Seed a crashed running swarm with maxTotalSteps=3, maxTotalTokens=8000:
    // - n1 already completed (usedSteps=1, usedInputTokens=100, usedOutputTokens=50)
    // - n2 crashed mid-inference with an unsettled 'reserved' row (reservedSteps=1, estIn=120, reservedOut=400)
    // - n3 pending dependent on n2 (MUST NOT run because remaining steps after recovery = 3 - 2 = 1!)
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO swarm_runs(
            id, sessionId, goal, status, strategyJson, budgetJson, usageJson, workspaceRoot,
            permissionMode, planVersion, currentPhase, replanCount, createdAt, updatedAt
          ) VALUES(?,?, 'restart budget recovery', 'running', '{"maxConcurrency":1,"maxReplans":0}',
                   '{"maxTotalSteps":3,"maxTotalTokens":8000}',
                   '{"inputTokens":100,"outputTokens":50,"steps":1,"completedNodes":1}',
                   ?, 'auto-safe', 1, 'running', 0, ?, ?)`,
        )
        .run(runId, sess.id, dir, now, now);
      store.db
        .prepare(
          `INSERT INTO swarm_nodes(
            id, runId, nodeKey, agentProfileId, model, provider, objective, acceptance,
            dependenciesJson, toolAllowJson, status, planVersion, budgetJson, resultText, createdAt, updatedAt
          ) VALUES
            ('rn-1', ?, 'n1', 'research', 'mock-restart', 'pool', 'done before crash', 'ok', '[]', '["read_file"]', 'completed', 1, '{}', 'pre-crash', ?, ?),
            ('rn-2', ?, 'n2', 'research', 'mock-restart', 'pool', 'crashed mid-step', 'ok', '["n1"]', '["read_file"]', 'running', 1, '{}', NULL, ?, ?),
            ('rn-3', ?, 'n3', 'research', 'mock-restart', 'pool', 'must be blocked after budget used', 'ok', '["n2"]', '["read_file"]', 'pending', 1, '{}', NULL, ?, ?)`,
        )
        .run(runId, now, now, runId, now, now, runId, now, now);
      store.db
        .prepare(
          `INSERT INTO budget_ledgers(
            treeId, rootSessionId, maxTotalSteps, maxTotalTokens, usedSteps, usedInputTokens, usedOutputTokens,
            reservedSteps, reservedTokens, createdAt, updatedAt
          ) VALUES(?, ?, 3, 8000, 1, 100, 50, 1, 520, ?, ?)`,
        )
        .run(runId, sess.id, now, now);
      store.db
        .prepare(
          `INSERT INTO budget_reservations(
            id, treeId, scope, nodeId, nodeKey, sessionId, status, reservedSteps,
            estimatedInputTokens, reservedOutputTokens, reservedTotalTokens, createdAt, updatedAt
          ) VALUES('orphan-res-1', ?, 'node_execution', 'rn-2', 'n2', ?, 'reserved', 1, 120, 400, 520, ?, ?)`,
        )
        .run(runId, sess.id, now, now);
    });
    store.close();

    // Reboot fresh Store + DirectAgentRuntime on same DB
    store = new Store(dbPath);
    pool = new AccountPool(store, { root: dir });
    pool.setDefaultModel('mock-restart');
    const postAdapter = new ScriptedAdapter(async function* (opts) {
      const txt = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
      yield { type: 'text-delta', index: 0, text: `post-crash:${txt.slice(0, 20)}` };
      yield { type: 'usage', usage: { inputTokens: 80, outputTokens: 20 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    direct = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: dir,
      dataRoot: dir,
      adapter: postAdapter,
    });

    const settled = await direct.swarmOrchestrator.waitForRun(runId, { timeoutMs: 10000 });

    // Orphaned reservation reconciled -> 1 (pre-crash) + 1 (orphan) = 2 used before resume -> only 1 step left!
    assert.equal(
      postAdapter.calls.length,
      1,
      `Restart must only admit 1 remaining step (3 - 1 used - 1 orphan = 1), got ${postAdapter.calls.length}`,
    );
    const orphanRow = store.db.prepare("SELECT * FROM budget_reservations WHERE id='orphan-res-1'").get();
    assert.equal(orphanRow.status, 'reconciled');
    const ledgerAfter = store.db.prepare('SELECT * FROM budget_ledgers WHERE treeId=?').get(runId);
    assert.equal(ledgerAfter.reservedSteps, 0, 'No leaked active reservedSteps after restart');
    assert.equal(ledgerAfter.reservedTokens, 0, 'No leaked active reservedTokens after restart');
    assert.equal(ledgerAfter.usedSteps, 3, 'Total used steps = 1 pre + 1 orphan + 1 post = 3');
    assert.equal(ledgerAfter.usedInputTokens, 300, 'usedInputTokens = 100 pre + 120 orphan + 80 post = 300');
    assert.equal(ledgerAfter.usedOutputTokens, 70, 'usedOutputTokens = 50 pre + 0 orphan (400 released) + 20 post = 70');

    assert.equal(settled.nodes.find((n) => n.nodeKey === 'n2').status, 'completed');
    assert.equal(settled.nodes.find((n) => n.nodeKey === 'n3').status, 'cancelled');
    assert.equal(settled.nodes.find((n) => n.nodeKey === 'n3').errorCode, 'BUDGET_EXCEEDED');
    assert.equal(settled.status, 'failed', 'Exhausted run with unstarted n3 must finish as failed, not completed');
  } finally {
    await direct.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Part 1.4 & 2.2/2.7/2.9: split_subgraph respects maxReplans, replanning diagnosis charges tree budget, parallel child spawns share parent budget, and exact-fit run completes', async () => {
  // 1. split_subgraph cannot bypass maxReplans=1 (solo model fails -> retry_same uses the 1 replan -> 2nd failure stops without split)
  const failAdapter = new ScriptedAdapter(async function* () {
    await delay(10);
    throw new Error('solo-model-failure');
  });
  const envSplit = createSwarmEnv({ defaultModel: 'solo-bad', adapter: failAdapter });
  try {
    const sess = envSplit.direct.createSession({ workspaceRoot: envSplit.dir });
    const out = await envSplit.direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Split subgraph bounded by maxReplans=1',
      workspaceRoot: envSplit.dir,
      maxReplans: 1,
      nodes: [{ nodeKey: 'big', taskType: 'research', objective: 'huge task', dependencies: [] }],
    });
    const replans = envSplit.direct.swarmOrchestrator.listReplans(out.runId);
    assert.equal(out.status, 'failed');
    assert.equal(replans.length, 1);
    assert.equal(replans[0].strategy, 'retry_same');
    assert.equal(out.nodes.some((n) => n.nodeKey.includes('__split')), false, 'split_subgraph must not bypass maxReplans=1');
  } finally {
    await envSplit.cleanup();
  }

  // 2. Parallel childManager.spawn() under parent session budget { maxSteps: 1 } admits at most 1 step + exact-fit 1-step swarm completes + replanning scope charges ledger
  const okAdapter = new ScriptedAdapter(async function* () {
    await delay(30);
    yield { type: 'text-delta', index: 0, text: 'exact ok' };
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const envOk = createSwarmEnv({ defaultModel: 'ok-model', adapter: okAdapter });
  try {
    // 2a. Parent session with budget { maxSteps: 1 } spawning 3 parallel children -> at most 1 admitted
    const budgetedParent = envOk.direct.createSession({
      workspaceRoot: envOk.dir,
      budget: { maxSteps: 1 },
    });
    const settledChildren = await Promise.allSettled([
      envOk.direct.childManager.spawn({ parentSessionId: budgetedParent.id, objective: 'child 1', workspaceRoot: envOk.dir }),
      envOk.direct.childManager.spawn({ parentSessionId: budgetedParent.id, objective: 'child 2', workspaceRoot: envOk.dir }),
      envOk.direct.childManager.spawn({ parentSessionId: budgetedParent.id, objective: 'child 3', workspaceRoot: envOk.dir }),
    ]);
    const okCount = settledChildren.filter((r) => r.status === 'fulfilled').length;
    const budgetFailCount = settledChildren.filter((r) => r.status === 'rejected' && r.reason?.category === 'budget').length;
    assert.equal(okCount, 1);
    assert.equal(budgetFailCount, 2);
    assert.equal(okAdapter.calls.length, 1);

    // 2b. Single node genuinely completing within budget { maxTotalSteps: 1 } finishes as 'completed'
    const plainParent = envOk.direct.createSession({ workspaceRoot: envOk.dir });
    const exactFit = await envOk.direct.swarmOrchestrator.startRun({
      sessionId: plainParent.id,
      goal: 'Single node exact-fit step budget',
      workspaceRoot: envOk.dir,
      budget: { maxTotalSteps: 1 },
      nodes: [{ nodeKey: 'only', taskType: 'research', objective: 'single step', dependencies: [] }],
    });
    assert.equal(exactFit.status, 'completed');
    assert.equal(exactFit.nodes[0].status, 'completed');

    // 2c. Replanning model diagnosis charges BUDGET_SCOPES.REPLANNING against shared tree budget ledger
    envOk.direct.swarmReplanner.adapter = okAdapter;
    const diagRun = envOk.direct.swarmOrchestrator.submitRun({
      sessionId: plainParent.id,
      goal: 'Replan diagnosis scope',
      workspaceRoot: envOk.dir,
      budget: { maxTotalSteps: 5 },
      nodes: [{ nodeKey: 'd1', taskType: 'research', objective: 'diag node', dependencies: [] }],
    });
    await envOk.direct.swarmOrchestrator.waitForRun(diagRun.runId, { timeoutMs: 5000 });
    await envOk.direct.swarmReplanner.diagnoseWithModel({
      run: envOk.direct.swarmOrchestrator.getRun(diagRun.runId),
      failedNode: envOk.direct.swarmOrchestrator.getRun(diagRun.runId).nodes[0],
      errorCode: 'TEST_ERR',
      errorMessage: 'simulated diagnosis',
      budgetLedger: envOk.direct.swarmOrchestrator.budgetLedger,
    });
    const replanResRows = envOk.direct.swarmOrchestrator.budgetLedger
      .listReservations(diagRun.runId)
      .filter((r) => r.scope === 'replanning');
    assert.equal(replanResRows.length, 1);
    assert.equal(replanResRows[0].status, 'settled');
    assert.equal(replanResRows[0].actualSteps, 1);
  } finally {
    await envOk.cleanup();
  }
});

test('Group 2 + Group 3 integration: reconcileAfterRestart skips live worker reservations while reconciling orphaned ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-live-budget-'));
  const dbPath = join(dir, 'live-budget.sqlite');
  const storeA = new Store(dbPath);
  const storeB = new Store(dbPath);
  const poolA = new AccountPool(storeA, { root: dir });
  const poolB = new AccountPool(storeB, { root: dir });
  poolA.setDefaultModel('live-model');
  poolB.setDefaultModel('live-model');

  let releaseA;
  let aEnteredResolve;
  const aEntered = new Promise((r) => {
    aEnteredResolve = r;
  });
  const aGate = new Promise((r) => {
    releaseA = r;
  });

  const adapterA = new ScriptedAdapter(async function* () {
    aEnteredResolve();
    await aGate;
    yield { type: 'text-delta', index: 0, text: 'live-worker-a-done' };
    yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 15 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const adapterB = new ScriptedAdapter(async function* () {
    yield { type: 'text-delta', index: 0, text: 'worker-b' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const rtA = new DirectAgentRuntime(storeA, poolA, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter: adapterA,
    workerId: 'worker-live-a',
    leaseMs: 30000,
  });
  let rtB = null;
  try {
    const sess = rtA.createSession({ workspaceRoot: dir });
    const submitted = rtA.swarmOrchestrator.submitRun({
      sessionId: sess.id,
      goal: 'Protect live reservation when Runtime B joins',
      workspaceRoot: dir,
      budget: { maxTotalSteps: 3, maxTotalTokens: 5000 },
      nodes: [{ nodeKey: 'live-node', taskType: 'research', objective: 'hold live reservation', dependencies: [] }],
    });

    // Wait until Runtime A has atomically reserved budget and is mid-inference
    await aEntered;
    const beforeRows = storeA.db
      .prepare("SELECT * FROM budget_reservations WHERE treeId=? AND status='reserved'")
      .all(submitted.runId);
    assert.equal(beforeRows.length, 1, 'Runtime A must hold 1 active reserved budget row');
    const liveResId = beforeRows[0].id;

    // Also insert a genuinely orphaned reservation on a separate dead tree to confirm orphans STILL reconcile
    const now = Date.now();
    storeA.tx(() => {
      storeA.db
        .prepare(
          `INSERT INTO budget_ledgers(
            treeId, rootSessionId, maxTotalSteps, maxTotalTokens, maxOutputTokens,
            usedSteps, usedInputTokens, usedOutputTokens, reservedSteps, reservedTokens,
            estimationErrorTokens, overageSteps, overageTokens, exhausted, exhaustedReason, createdAt, updatedAt
          ) VALUES('orphan-tree',?,2,2000,NULL,0,0,0,1,300,0,0,0,0,NULL,?,?)`,
        )
        .run(sess.id, now, now);
      storeA.db
        .prepare(
          `INSERT INTO budget_reservations(
            id, treeId, scope, nodeId, nodeKey, sessionId, turnId, attempt, status,
            reservedSteps, estimatedInputTokens, reservedOutputTokens, reservedTotalTokens,
            actualSteps, actualInputTokens, actualOutputTokens, estimationErrorTokens, overageTokens,
            createdAt, updatedAt
          ) VALUES('dead-orphan-res','orphan-tree','node_execution','dead-node','dead-key',?,'dead-turn',1,'reserved',1,100,200,300,0,0,0,0,0,?,?)`,
        )
        .run(sess.id, now, now);
    });

    // Runtime B joins the same SQLite DB and runs startup recovery!
    rtB = new DirectAgentRuntime(storeB, poolB, {
      defaultWorkspace: dir,
      dataRoot: dir,
      adapter: adapterB,
      workerId: 'worker-join-b',
      leaseMs: 30000,
    });
    const recReport = rtB.swarmOrchestrator.budgetLedger.reconcileAfterRestart();
    assert.ok(recReport.skippedLiveCount >= 1, 'Runtime B must skip Runtime A live reservation');

    // Runtime A's live reservation MUST still be 'reserved' (NOT reconciled by Runtime B!)
    const liveRowAfterB = storeB.db
      .prepare('SELECT status FROM budget_reservations WHERE id=?')
      .get(liveResId);
    assert.equal(liveRowAfterB.status, 'reserved', 'Live worker reservation must remain reserved');

    // Truly orphaned reservation MUST be reconciled
    const orphanAfterB = storeB.db
      .prepare("SELECT status FROM budget_reservations WHERE id='dead-orphan-res'")
      .get();
    assert.equal(orphanAfterB.status, 'reconciled', 'Dead orphan reservation must still be reconciled');

    // Now release Runtime A and confirm clean settlement to 'settled' with exact usage
    releaseA();
    const settled = await rtA.swarmOrchestrator.waitForRun(submitted.runId, { timeoutMs: 10000 });
    assert.equal(settled.status, 'completed');
    const liveRowFinal = storeA.db
      .prepare('SELECT status, actualSteps, actualInputTokens, actualOutputTokens FROM budget_reservations WHERE id=?')
      .get(liveResId);
    assert.equal(liveRowFinal.status, 'settled');
    assert.equal(liveRowFinal.actualSteps, 1);
    assert.equal(liveRowFinal.actualInputTokens, 40);
    assert.equal(liveRowFinal.actualOutputTokens, 15);
  } finally {
    releaseA?.();
    await rtB?.close?.();
    await rtA.close();
    storeB.close();
    storeA.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
