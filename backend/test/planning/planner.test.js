import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePlanner } from '../../src/planning/planner.js';
import { AdaptiveReplanner } from '../../src/planning/replanner.js';
import { PlannerFeedbackCollector } from '../../src/planning/feedback.js';

const task = (taskKey, dependencies = [], extra = {}) => ({
  taskKey,
  objective: `Do ${taskKey}`,
  acceptance: `Verify ${taskKey}`,
  dependencies,
  ...extra,
});

test('Adaptive Planner validates structured task schema, DAG, budget, permission, and acceptance', () => {
  const planner = new AdaptivePlanner({ permissionCeiling: 'auto-safe' });
  const plan = planner.createPlan({
    goal: 'ship feature',
    permissionMode: 'auto-safe',
    budget: { maxSteps: 5 },
    tasks: [
      task('research'),
      task('implement', ['research'], { budget: { maxSteps: 3 }, sideEffects: [{ effectKey: 'repo-write', kind: 'write', replayable: false, idempotencyKey: 'run:1' }] }),
      task('verify', ['implement'], { acceptance: { description: 'check output', requiredEvidence: ['test-log'] } }),
    ],
  });
  assert.equal(plan.planVersion, 1);
  assert.equal(plan.tasks.length, 3);

  assert.throws(() => planner.createPlan({ goal: 'cycle', tasks: [task('a', ['b']), task('b', ['a'])] }), (error) => error.code === 'PLANNER_DAG_CYCLE');
  assert.throws(() => planner.createPlan({ goal: 'budget', budget: { maxSteps: 1 }, tasks: [task('a', [], { budget: { maxSteps: 2 } })] }), (error) => error.code === 'PLANNER_BUDGET_EXCEEDED');
  assert.throws(() => planner.createPlan({ goal: 'permission', permissionMode: 'full', tasks: [task('a')] }), (error) => error.code === 'PLANNER_PERMISSION_ESCALATION');
  assert.throws(() => planner.createPlan({ goal: 'acceptance', tasks: [task('a', [], { acceptance: { description: 'missing evidence', requiredEvidence: [] } })] }), (error) => error.code === 'PLANNER_ACCEPTANCE_INCOMPLETE');
});

test('Adaptive Replanner increments planVersion and protects completed tasks and applied side effects', () => {
  const planner = new AdaptivePlanner();
  const replanner = new AdaptiveReplanner({ planner });
  const current = planner.createPlan({
    goal: 'ship',
    tasks: [
      task('done', [], { sideEffects: [{ effectKey: 'publish', kind: 'external', replayable: false, idempotencyKey: 'publish:1' }] }),
      task('pending', ['done']),
    ],
  });
  const next = replanner.replan(current, { tasks: [...current.tasks, task('new', ['pending'])] }, { completedTaskKeys: ['done'], appliedEffectKeys: ['publish'] });
  assert.equal(next.planVersion, 2);
  assert.equal(next.tasks.length, 3);

  assert.throws(() => replanner.replan(current, { tasks: current.tasks.map((item) => item.taskKey === 'done' ? { ...item, objective: 'tamper' } : item) }, { completedTaskKeys: ['done'] }), (error) => error.code === 'PLANNER_COMPLETED_TASK_IMMUTABLE');
  assert.throws(() => replanner.replan(current, { tasks: current.tasks.filter((item) => item.taskKey !== 'done') }, { completedTaskKeys: ['done'], appliedEffectKeys: ['publish'] }), (error) => error.code === 'PLANNER_COMPLETED_TASK_REMOVED');
});

test('Planner feedback collector validates, stores, filters, and summarizes execution feedback', () => {
  const feedback = new PlannerFeedbackCollector();
  feedback.record({ taskKey: 'research', status: 'completed', success: true, verified: true, inputTokens: 10, outputTokens: 5, latencyMs: 20, evidence: ['report'] });
  feedback.record({ taskKey: 'implement', status: 'failed', success: false, notes: 'compile failure' });
  assert.equal(feedback.list({ taskKey: 'research' }).length, 1);
  assert.deepEqual(feedback.summarize(), { count: 2, successCount: 1, verifiedCount: 1, failedCount: 1, cancelledCount: 0, inputTokens: 10, outputTokens: 5, latencyMs: 20 });
  assert.throws(() => feedback.record({ taskKey: 'x', status: 'completed', success: 'yes' }), (error) => error.code === 'PLANNER_FEEDBACK_INVALID');
});
