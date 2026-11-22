import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import {
  AgentCapabilityRegistry,
  ModelCapabilityRegistry,
} from '../src/swarm/capabilities.js';
import { AdaptiveModelRouter } from '../src/swarm/router.js';
import { DynamicTaskPlanner } from '../src/swarm/planner.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }
  async *stream(options) {
    this.calls.push({
      model: options.model,
      messages: structuredClone(options.messages),
    });
    yield* this.handler(options, this.calls.length - 1);
  }
}

async function waitTurnDone(direct, sessionId, turnId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = direct.listTurns(sessionId).find((x) => x.id === turnId);
    if (t && ['completed', 'failed', 'cancelled'].includes(t.state)) return t;
    await delay(20);
  }
  throw new Error('Timed out waiting for turn');
}

test('P5 ModelCapabilityRegistry and AdaptiveModelRouter match models to coding, reasoning, vision, and fast budgets', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p5-cap-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, {
    root: dataDir,
    legacyProviders: {
      models: [
        { provider: 'anthropic', model: 'claude-sonnet-4', context: 200000, tools: true, math: 0.8 },
        { provider: 'deepseek', model: 'deepseek-reasoner', context: 128000, tools: true, math: 0.96 },
        { provider: 'gemini', model: 'gemini-2.5-flash', context: 1000000, tools: true, math: 0.72 },
      ],
    },
  });

  try {
    const modelReg = new ModelCapabilityRegistry(pool);
    const agentReg = new AgentCapabilityRegistry();
    const router = new AdaptiveModelRouter({ modelRegistry: modelReg, agentRegistry: agentReg, pool });

    const codingChoice = router.select({
      taskType: 'implementation',
      objective: '重构后端路由模块并修复类型错误',
      requiredTools: ['edit_file', 'write_file'],
    });
    assert.equal(codingChoice.model, 'claude-sonnet-4');
    assert.equal(codingChoice.profile.archetype, 'implementation');
    assert.equal(codingChoice.profile.readOnly, false);

    const reasoningChoice = router.select({
      taskType: 'planning',
      objective: '形式化推导分布式锁续期与状态机不变量',
    });
    assert.equal(reasoningChoice.model, 'deepseek-reasoner');
    assert.equal(reasoningChoice.profile.readOnly, true);

    const visionChoice = router.select({
      taskType: 'research',
      objective: '分析界面截图中的布局异常',
      requiresVision: true,
    });
    assert.notEqual(visionChoice.model, 'deepseek-reasoner');

    const fastChoice = router.select({
      taskType: 'research',
      objective: '快速扫描文件列表',
      budget: { preferFast: true, maxCostUsd: 0.01 },
    });
    assert.equal(fastChoice.model, 'gemini-2.5-flash');
  } finally {
    store.close();
    rmDirSafe(dataDir);
  }
});

test('P5 DynamicTaskPlanner rejects cycles and supports live addNode, reprioritize, and cancel', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p5-plan-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const planner = new DynamicTaskPlanner();

  try {
    assert.throws(
      () =>
        planner.validateDag([
          { nodeKey: 'a', dependencies: ['b'] },
          { nodeKey: 'b', dependencies: ['a'] },
        ]),
      (err) => err.code === 'SWARM_DAG_CYCLE',
    );
    assert.throws(
      () => planner.validateDag([{ nodeKey: 'a', dependencies: ['missing'] }]),
      (err) => err.code === 'UNKNOWN_SWARM_DEPENDENCY',
    );

    const runId = 'run-live-edit';
    const now = Date.now();
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO swarm_runs(id, sessionId, goal, status, strategyJson, budgetJson, createdAt, updatedAt)
           VALUES(?,'sess-1','测试动态改图','running','{}','{}',?,?)`,
        )
        .run(runId, now, now);
    });

    const n1 = planner.addNode(store, runId, {
      nodeKey: 'scan',
      taskType: 'research',
      objective: '扫描工作区',
      dependencies: [],
      priority: 5,
    });
    assert.equal(n1.priority, 5);
    const repri = planner.reprioritizeNode(store, runId, 'scan', 99);
    assert.equal(repri.priority, 99);
    const cancelled = planner.cancelNode(store, runId, 'scan', 'no longer needed');
    assert.equal(cancelled.status, 'cancelled');
  } finally {
    store.close();
    rmDirSafe(dataDir);
  }
});

test('P5 ChildAgentManager supports cache-safe fork, recursive fork guard, permission ceiling, and pause/resume/cancel', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p5-child-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-p5-child-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-coder');

  const adapter = new ScriptedAdapter(async function* (opts) {
    const lastUser = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    yield { type: 'text-delta', index: 0, text: `Reply for: ${lastUser.slice(0, 40)}` };
    yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    const parent = direct.createSession({
      title: '父会话',
      workspaceRoot: workDir,
      permissionMode: 'read-only',
    });
    const t1 = direct.startTurn(parent.id, { input: '记住项目规范：核心模块禁止裸 SQL' });
    assert.equal((await waitTurnDone(direct, parent.id, t1.turn.id)).state, 'completed');

    // Fork inheriting parent's nonce and immutable prefix
    const fork1 = await direct.childManager.fork({
      parentSessionId: parent.id,
      parentTurnId: t1.turn.id,
      objective: '在分支会话继续调研规范',
      permissionMode: 'full-access', // Attempt escalation -> must clamp to parent read-only!
      parentPermissionMode: 'read-only',
    });
    const fork1Sess = direct.getSession(fork1.childSessionId);
    assert.equal(fork1Sess.nonce, parent.nonce || direct.getSession(parent.id).nonce);
    assert.equal(fork1Sess.permissionMode, 'read-only'); // Permission ceiling enforced!

    const parentMsgs = adapter.calls[0].messages;
    const fork1Msgs = adapter.calls[1].messages;
    assert.equal(
      JSON.stringify(fork1Msgs.slice(0, parentMsgs.length)),
      JSON.stringify(parentMsgs),
      'Forked child must preserve byte-identical Prompt Cache prefix',
    );

    // Depth 2 fork succeeds
    const fork2 = await direct.childManager.fork({
      parentSessionId: fork1.childSessionId,
      objective: '第二层分支',
    });
    // Depth 3 (from fork2) MUST be blocked with RECURSIVE_FORK_BLOCKED
    await assert.rejects(
      () =>
        direct.childManager.fork({
          parentSessionId: fork2.childSessionId,
          objective: '过深递归分支',
        }),
      (err) => err.code === 'RECURSIVE_FORK_BLOCKED',
    );

    // Pause -> Resume -> Collect -> Cancel cascade
    direct.childManager.pause(fork1.childSessionId);
    assert.equal(direct.getSession(fork1.childSessionId).state, 'paused');
    const resumed = await direct.childManager.resume(fork1.childSessionId, {
      objective: '恢复并补充总结',
    });
    assert.match(resumed.text, /恢复并补充总结/);
    assert.equal(direct.getSession(fork1.childSessionId).state, 'completed');

    direct.childManager.cancel(fork1.childSessionId);
    assert.equal(direct.getSession(fork1.childSessionId).state, 'cancelled');
    assert.equal(direct.getSession(fork2.childSessionId).state, 'cancelled');
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('P5 AdaptiveSwarmOrchestrator executes diamond DAG concurrently with mailbox, budget limit, and tool integration', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p5-orch-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-p5-orch-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-coder');

  let active = 0;
  let peak = 0;
  let toolTriggeredSwarm = false;
  let swarmToolCalls = 0;

  const adapter = new ScriptedAdapter(async function* (opts) {
    const lastUser = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    if (opts.messages.some((m) => m.role === 'tool')) {
      toolTriggeredSwarm = true;
      yield { type: 'text-delta', index: 0, text: '群体编排已通过工具执行完成。' };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (lastUser === '启动主任务并调用群体编排' && opts.tools?.some((t) => t.name === 'swarm_orchestrate')) {
      swarmToolCalls++;
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-swarm',
          name: 'swarm_orchestrate',
          arguments: JSON.stringify({ goal: '实现并验证缓存层', maxConcurrency: 2 }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    active++;
    peak = Math.max(peak, active);
    await delay(40);
    active--;
    yield { type: 'text-delta', index: 0, text: `Done: ${lastUser.slice(0, 60)}` };
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 15 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    const s = direct.createSession({ workspaceRoot: workDir });

    // Send an inter-agent mailbox message and verify queued -> delivered lifecycle
    const mbOut = direct.mailbox.send({
      runId: 'mb-check',
      sessionId: s.id,
      fromAgentId: 'coordinator',
      toAgentId: 'impl-a',
      kind: 'handoff',
      payload: { rule: 'must use WAL' },
    });
    assert.equal(mbOut.status, 'queued');
    assert.equal(direct.mailbox.drainInbox('impl-a', { runId: 'mb-check' }).length, 1);
    assert.equal(direct.mailbox.drainInbox('impl-a', { runId: 'mb-check' }).length, 0);

    const runPromise = direct.swarmOrchestrator.startRun({
      sessionId: s.id,
      goal: 'Diamond DAG test',
      workspaceRoot: workDir,
      maxConcurrency: 2,
      nodes: [
        { nodeKey: 'research', taskType: 'research', objective: '调研代码结构', dependencies: [] },
        { nodeKey: 'impl-a', taskType: 'implementation', objective: '实现分支 A', dependencies: ['research'], priority: 10 },
        { nodeKey: 'impl-b', taskType: 'implementation', objective: '实现分支 B', dependencies: ['research'], priority: 10 },
        { nodeKey: 'verify', taskType: 'verification', objective: '汇总验证', dependencies: ['impl-a', 'impl-b'] },
      ],
    });

    const out = await runPromise;
    assert.equal(out.status, 'completed', `Swarm failed: ${out.summary}`);
    assert.equal(peak, 2, 'Parallel branches impl-a and impl-b must execute concurrently');
    assert.equal(out.nodes.length, 4);
    assert.ok(out.nodes.every((n) => n.status === 'completed'));
    const verifyNode = out.nodes.find((n) => n.nodeKey === 'verify');
    assert.ok(verifyNode.childSessionId);

    // Budget cap enforcement across nodes
    const budgetRun = await direct.swarmOrchestrator.startRun({
      sessionId: s.id,
      goal: 'Budget capped DAG',
      workspaceRoot: workDir,
      budget: { maxTotalTokens: 10 }, // Exceeded after first node (35 tokens >= 10)
      nodes: [
        { nodeKey: 'step1', taskType: 'research', objective: '第一步', dependencies: [] },
        { nodeKey: 'step2', taskType: 'implementation', objective: '第二步不应启动', dependencies: ['step1'] },
      ],
    });
    const step2 = budgetRun.nodes.find((n) => n.nodeKey === 'step2');
    assert.equal(step2.status, 'cancelled');
    assert.equal(step2.errorCode, 'BUDGET_EXCEEDED');

    // End-to-end tool call via `swarm_orchestrate` inside DirectAgentRuntime
    const turn = direct.startTurn(s.id, { input: '启动主任务并调用群体编排' });
    const done = await waitTurnDone(direct, s.id, turn.turn.id);
    assert.equal(done.state, 'completed');
    assert.equal(toolTriggeredSwarm, true);
    assert.equal(swarmToolCalls, 1);
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});
