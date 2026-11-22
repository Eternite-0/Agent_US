import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

import {
  allocatePlanBudgets,
  estimateTaskBudget,
  queryHistoricalTaskMetrics,
} from '../../src/planning/budget-estimator.js';
import { AdaptivePlanner } from '../../src/planning/planner.js';
import { AdaptiveReplanner } from '../../src/planning/replanner.js';
import { createRealEngineeringDataset } from '../../src/evaluation/dataset.js';
import { Store } from '../../src/store.js';
import { AccountPool } from '../../src/pool.js';
import { DirectAgentRuntime } from '../../src/direct-agent.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }
  async *stream(options) {
    this.calls.push(structuredClone(options.messages));
    yield* this.handler(options, this.calls.length - 1);
  }
}

test('estimateTaskBudget produces complexity-scaled buckets, verification reserve, and multi-stage hints within user caps', () => {
  const analysis = estimateTaskBudget({
    taskType: 'codebase-analysis',
    fileCount: 5,
    requiredTools: ['read_file', 'glob', 'grep'],
    verificationComplexity: 'medium',
  });
  assert.ok(analysis.researchSteps >= analysis.implementationSteps * 3);
  assert.ok(analysis.finalVerificationReserve >= 2);
  assert.equal(
    analysis.planningSteps +
      analysis.researchSteps +
      analysis.implementationSteps +
      analysis.testingSteps +
      analysis.reviewSteps +
      analysis.repairReserve +
      analysis.finalVerificationReserve,
    analysis.maxSteps,
  );

  const security = estimateTaskBudget({
    taskType: 'security-audit',
    fileCount: 4,
    requiredTools: ['read_file', 'write_file', 'bash'],
    verificationComplexity: 'high',
    recoveryRequirements: true,
  });
  assert.ok(security.maxSteps > analysis.maxSteps && security.maxSteps < 48);
  assert.equal(security.finalVerificationReserve, 3);
  assert.ok(security.suggestedStages.length === 3, 'complex >24 step task emits multi-stage recoverable breakdown');

  const tight = estimateTaskBudget({
    taskType: 'security-audit',
    fileCount: 5,
    verificationComplexity: 'high',
    userBudget: { maxSteps: 3 },
  });
  assert.equal(tight.feasible, false);
  assert.match(tight.insufficientReason, /insufficient|below minimum/i);
  assert.equal(tight.maxSteps, 3);
});

test('real engineering dataset uses complexity-scaled resource budgets instead of flat 16', () => {
  const tasks = createRealEngineeringDataset();
  const bugFix = tasks.find((t) => t.id === 'real-bug-fix-01');
  const secAudit = tasks.find((t) => t.id === 'real-security-audit-01');
  const recovery = tasks.find((t) => t.id === 'real-recovery-01');
  assert.ok(secAudit.metadata.resourceBudget.maxSteps > bugFix.metadata.resourceBudget.maxSteps);
  assert.ok(recovery.metadata.resourceBudget.maxSteps >= 26 && recovery.metadata.resourceBudget.maxSteps <= 40);
  assert.ok(recovery.metadata.resourceBudget.finalVerificationReserve >= 3);
});

test('AdaptivePlanner and AdaptiveReplanner prevent budget inflation past initial user ceiling', () => {
  const planner = new AdaptivePlanner();
  const replanner = new AdaptiveReplanner({ planner });
  const plan = planner.createPlan({
    goal: 'Bounded DAG',
    budget: { maxSteps: 12, maxTotalTokens: 50_000 },
    tasks: [
      { taskKey: 'a', objective: 'A', acceptance: 'OK', dependencies: [], budget: { maxSteps: 6 } },
      { taskKey: 'b', objective: 'B', acceptance: 'OK', dependencies: ['a'], budget: { maxSteps: 6 } },
    ],
  });

  assert.throws(
    () =>
      replanner.replan(plan, {
        budget: { maxSteps: 25, maxTotalTokens: 50_000 },
        tasks: [...plan.tasks, { taskKey: 'c', objective: 'C', acceptance: 'OK', dependencies: ['b'] }],
      }),
    (err) => err.code === 'PLANNER_BUDGET_INFLATION_DENIED',
  );
});

test('Swarm planner fails explicitly with BUDGET_INSUFFICIENT when user step budget cannot cover DAG', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-budget-insuf-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-model');
  const adapter = new ScriptedAdapter(async function* () {
    yield { type: 'text-delta', index: 0, text: '{"nodes":[{"nodeKey":"a","objective":"A"},{"nodeKey":"b","objective":"B"},{"nodeKey":"c","objective":"C"}]}' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const direct = new DirectAgentRuntime(store, pool, { defaultWorkspace: dataDir, dataRoot: dataDir, adapter });
  try {
    const sess = direct.createSession({ workspaceRoot: dataDir });
    const res = await direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Too tiny budget',
      workspaceRoot: dataDir,
      budget: { maxSteps: 2 },
    });
    assert.equal(res.status, 'failed');
    assert.equal(res.errorCode, 'BUDGET_INSUFFICIENT');
  } finally {
    await direct.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('historical budget exhaustion metrics adapt future estimates and AgentLoop injects final verification reserve advisory', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-hist-budget-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-hist-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-model');
  const now = Date.now();
  for (let i = 0; i < 4; i++) {
    store.db
      .prepare(
        `INSERT INTO model_feedback(model, provider, taskType, success, toolTotal, toolSuccess, latencyMs, inputTokens, outputTokens, failureKind, trafficSource, isSynthetic, createdAt)
         VALUES('mock-model','pool','security-audit',0,2,2,1000,15000,3000,'budget','evaluation',1,?)`,
      )
      .run(now - i);
  }
  const hist = queryHistoricalTaskMetrics(store, { taskType: 'security-audit', model: 'mock-model' });
  assert.equal(hist.sampleCount, 4);
  assert.ok(hist.adjustmentFactor > 1.2);

  let sawReserveReminder = false;
  let stepIdx = 0;
  const adapter = new ScriptedAdapter(async function* (opts) {
    stepIdx++;
    if (opts.messages.some((m) => m.role === 'user' && m.content?.[0]?.text?.includes('预算收尾提醒'))) {
      sawReserveReminder = true;
    }
    if (stepIdx <= 2) {
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: `tc-${stepIdx}`, name: 'glob', arguments: JSON.stringify({ pattern: '*' }) },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'Completed within verification reserve.' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, { defaultWorkspace: workDir, dataRoot: dataDir, adapter });
  try {
    const s = direct.createSession({ workspaceRoot: workDir });
    const t = direct.startTurn(s.id, { input: 'Run bounded check', maxSteps: 4, finalVerificationReserve: 2 });
    const done = await direct.waitForTurnTerminal(t.turn.id, { timeoutMs: 5_000 });
    assert.equal(done.state, 'completed');
    assert.equal(sawReserveReminder, true);

    const alloc = allocatePlanBudgets({
      tasks: [{ taskKey: 'audit', taskType: 'security-audit', dependencies: [], objective: 'Audit repo' }],
      store,
      model: 'mock-model',
    });
    assert.equal(alloc.feasible, true);
    assert.ok(alloc.tasks[0].allocatedSteps >= 22);

    const largeRepoCtx = {
      filesScanned: 120,
      relevantFiles: Array.from({ length: 20 }, (_, i) => `lib/mod-${i}.js`),
    };
    const largePlanTasks = [
      { taskKey: 'impl-core', taskType: 'implementation', ownedPaths: ['lib/option.js', 'lib/command.js'], dependencies: [], objective: 'Implement core feature' },
      { taskKey: 'impl-types', taskType: 'implementation', ownedPaths: ['typings/index.d.ts'], dependencies: [], objective: 'Update types' },
      { taskKey: 'impl-tests', taskType: 'tests', ownedPaths: ['tests/option.summary.test.js'], dependencies: ['impl-core'], objective: 'Write tests' },
      { taskKey: 'verify', taskType: 'verification', dependencies: ['impl-core', 'impl-types', 'impl-tests'], objective: 'Run tests' },
      { taskKey: 'review', taskType: 'review', dependencies: ['verify'], objective: 'Review changes' },
    ];
    const scaledAlloc = allocatePlanBudgets({
      tasks: largePlanTasks,
      userBudget: { maxSteps: 180 },
      repoContext: largeRepoCtx,
      store,
      model: 'mock-model',
    });
    assert.equal(scaledAlloc.feasible, true);
    const byKey = new Map(scaledAlloc.tasks.map((t) => [t.taskKey, t.allocatedSteps]));
    assert.ok(byKey.get('impl-core') >= 25, `expected impl-core >= 25, got ${byKey.get('impl-core')}`);
    assert.ok(byKey.get('verify') >= 20, `expected verify >= 20, got ${byKey.get('verify')}`);
    assert.ok(scaledAlloc.totalAllocatedSteps <= 180);

    const trimmedAlloc = allocatePlanBudgets({
      tasks: largePlanTasks,
      userBudget: { maxSteps: 50 },
      repoContext: largeRepoCtx,
      store,
      model: 'mock-model',
    });
    assert.equal(trimmedAlloc.feasible, true);
    assert.ok(trimmedAlloc.totalAllocatedSteps <= 50, `expected <= 50, got ${trimmedAlloc.totalAllocatedSteps}`);
  } finally {
    await direct.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
