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