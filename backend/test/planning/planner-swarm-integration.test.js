import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Store } from '../../src/store.js';
import { AccountPool } from '../../src/pool.js';
import { DirectAgentRuntime } from '../../src/direct-agent.js';
import { rmDirSafe } from '../fixtures.js';

class NoopAdapter extends LlmAdapter {
  async *stream() {
    yield { type: 'text-delta', index: 0, text: 'fixture' };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

test('Adaptive Planner plan is validated and mapped into the durable Swarm run', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-plan-swarm-data-'));
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'agent-us-plan-swarm-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('fixture-model');
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workspaceRoot,
    dataRoot: dataDir,
    adapter: new NoopAdapter(),
    enableHeartbeat: false,
  });

  try {
    const session = direct.createSession({ workspaceRoot });
    const plan = {
      planVersion: 7,
      goal: 'deliver a verified two-step change',
      permissionMode: 'auto-safe',
      budget: { maxSteps: 8 },
      tasks: [
        {
          taskKey: 'inspect', objective: 'Inspect the target module', taskType: 'research',
          acceptance: 'Return the relevant module and dependency evidence', dependencies: [], budget: { maxSteps: 2 },
        },
        {
          taskKey: 'verify', objective: 'Verify the proposed change', taskType: 'verification',
          acceptance: { description: 'Run the focused verification', requiredEvidence: ['test-exit-code'] },
          dependencies: ['inspect'], budget: { maxSteps: 3 },
        },
      ],
    };

    const submitted = direct.swarmOrchestrator.submitPlannedRun({ plan, sessionId: session.id, workspaceRoot, parentPermissionMode: 'auto-safe', maxConcurrency: 2 });
    assert.equal(submitted.status, 'running');
    const run = direct.swarmOrchestrator.getRun(submitted.runId);
    assert.ok(run);
    assert.equal(run.planVersion, 7);
    assert.equal(run.plan.planVersion, plan.planVersion);
    assert.equal(run.plan.goal, plan.goal);
    assert.deepEqual(run.plan.tasks.map((task) => task.taskKey), ['inspect', 'verify']);
    assert.deepEqual(run.nodes.map((node) => node.nodeKey).sort(), ['inspect', 'verify']);
    assert.deepEqual(run.nodes.find((node) => node.nodeKey === 'verify').dependencies, ['inspect']);
    assert.equal(run.nodes.find((node) => node.nodeKey === 'inspect').planVersion, 7);
    assert.equal(run.nodes.find((node) => node.nodeKey === 'verify').planVersion, 7);

    assert.throws(
      () => direct.swarmOrchestrator.submitPlannedRun({ plan: { ...plan, tasks: [{ ...plan.tasks[1], dependencies: ['missing'] }] }, sessionId: session.id, workspaceRoot }),
      (error) => error.code === 'PLANNER_UNKNOWN_DEPENDENCY',
    );
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workspaceRoot);
  }
});

test('DynamicTaskPlanner parses fenced/trailing JSON with reasoning headroom and normalizes nodeKeys for taskSchema', async () => {
  const { DynamicTaskPlanner } = await import('../../src/swarm/planner.js');
  const { taskSchema } = await import('../../src/planning/schemas.js');

  let seenMaxTokens = null;
  class PlannerTestAdapter extends LlmAdapter {
    async *stream(opts) {
      seenMaxTokens = opts.maxTokens;
      const payload = {
        nodes: [
          {
            nodeKey: 'Branch A (Frontmatter)',
            taskType: 'implementation',
            objective: 'Implement frontmatter parser',
            acceptance: 'src/frontmatter.js works',
            dependencies: [],
            isolatedWorktree: true,
            priority: 20,
          },
          {
            nodeKey: 'Branch B (Wikilinks)',
            taskType: 'implementation',
            objective: 'Implement wikilinks parser',
            acceptance: 'src/wikilinks.js works',
            dependencies: [],
            isolatedWorktree: true,
            priority: 20,
          },
          {
            nodeKey: '_review',
            taskType: 'review',
            objective: 'Review artifacts read-only',
            acceptance: 'Review complete',
            dependencies: ['Branch A (Frontmatter)', 'Branch B (Wikilinks)'],
            permissionMode: 'readonly',
            priority: 5,
          },
        ],
      };
      yield {
        type: 'text-delta',
        index: 0,
        text: `Here is the DAG:\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\nAll dependencies are acyclic.`,
      };
      yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 120 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }

  const planner = new DynamicTaskPlanner({ adapter: new PlannerTestAdapter() });
  const nodes = await planner.decompose({
    goal: 'Build parallel markdown modules with review',
    model: 'reasoning-model',
    maxNodes: 6,
  });

  assert.ok(seenMaxTokens >= 4096, `expected maxTokens >= 4096, got ${seenMaxTokens}`);
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].isolatedWorktree, true);
  assert.equal(nodes[1].isolatedWorktree, true);
  assert.equal(nodes[2].dependencies.length, 2);
  assert.deepEqual(nodes[2].dependencies, [nodes[0].nodeKey, nodes[1].nodeKey]);
  for (const node of nodes) {
    const parsed = taskSchema.safeParse({
      taskKey: node.nodeKey,
      objective: node.objective,
      acceptance: node.acceptance,
      taskType: node.taskType,
      dependencies: node.dependencies,
      permissionMode: node.permissionMode === 'readonly' ? 'readonly' : 'auto-safe',
    });
    assert.equal(parsed.success, true, `taskSchema should accept normalized nodeKey ${node.nodeKey}`);
  }
});
