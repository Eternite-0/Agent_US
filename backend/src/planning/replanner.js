import { Fault } from '../store.js';
import { normalizePlan, validatePlan, taskMap } from './validator.js';

function plannerFault(code, detail = undefined) {
  return new Fault(code, 409, detail);
}

function effectMap(task) {
  return new Map((task.sideEffects ?? []).map((effect) => [effect.effectKey, effect]));
}

const BUDGET_LIMIT_KEYS = ['maxInputTokens', 'maxOutputTokens', 'maxSteps', 'maxTotalTokens', 'maxCostUsd'];

function assertBudgetNotInflated(ceilingBudget = {}, nextBudget = {}) {
  for (const key of BUDGET_LIMIT_KEYS) {
    const cap = ceilingBudget?.[key];
    const req = nextBudget?.[key];
    if (cap !== undefined && cap !== null) {
      if (req === undefined || req === null || Number(req) > Number(cap)) {
        throw plannerFault('PLANNER_BUDGET_INFLATION_DENIED', {
          field: key,
          ceiling: Number(cap),
          requested: req ?? null,
        });
      }
    }
  }
}

export class AdaptiveReplanner {
  constructor({ planner, permissionCeiling = 'full' } = {}) {
    this.planner = planner;
    this.permissionCeiling = permissionCeiling;
  }

  replan(currentPlan, proposal, { completedTaskKeys = [], appliedEffectKeys = [] } = {}) {
    const current = validatePlan(normalizePlan(currentPlan), { permissionCeiling: this.permissionCeiling });
    const initialBudget = current.metadata?.initialBudget && typeof current.metadata.initialBudget === 'object'
      ? { ...current.metadata.initialBudget }
      : { ...current.budget };
    const completed = new Set(completedTaskKeys);
    const applied = new Set(appliedEffectKeys);
    const currentTasks = taskMap(current);
    const proposed = proposal?.tasks || proposal?.nodes
      ? normalizePlan({ ...current, ...proposal, planVersion: current.planVersion + 1 })
      : normalizePlan({
          ...current,
          ...(proposal?.budget ? { budget: proposal.budget } : {}),
          tasks: [...current.tasks, ...(proposal?.addTasks ?? proposal?.addNodes ?? [])],
          planVersion: current.planVersion + 1,
        });
    assertBudgetNotInflated(initialBudget, proposed.budget);
    const proposedTasks = taskMap(proposed);

    for (const taskKey of completed) {
      const before = currentTasks.get(taskKey);
      const after = proposedTasks.get(taskKey);
      if (!before) throw plannerFault('PLANNER_COMPLETED_TASK_UNKNOWN', { taskKey });
      if (!after) throw plannerFault('PLANNER_COMPLETED_TASK_REMOVED', { taskKey });
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw plannerFault('PLANNER_COMPLETED_TASK_IMMUTABLE', { taskKey });
      }
    }

    for (const [taskKey, before] of currentTasks) {
      const after = proposedTasks.get(taskKey);
      if (!after) {
        const protectedEffects = (before.sideEffects ?? []).filter((effect) => applied.has(effect.effectKey));
        if (protectedEffects.length) throw plannerFault('PLANNER_SIDE_EFFECT_IMMUTABLE', { taskKey, effectKeys: protectedEffects.map((effect) => effect.effectKey) });
        continue;
      }
      const beforeEffects = effectMap(before);
      const afterEffects = effectMap(after);
      for (const effectKey of applied) {
        if (!beforeEffects.has(effectKey)) continue;
        if (!afterEffects.has(effectKey) || JSON.stringify(beforeEffects.get(effectKey)) !== JSON.stringify(afterEffects.get(effectKey))) {
          throw plannerFault('PLANNER_SIDE_EFFECT_IMMUTABLE', { taskKey, effectKey });
        }
      }
    }

    const next = validatePlan({
      ...proposed,
      metadata: { ...(proposed.metadata ?? {}), initialBudget },
      planVersion: current.planVersion + 1,
    }, { permissionCeiling: this.permissionCeiling });
    if (next.planVersion !== current.planVersion + 1) {
      throw plannerFault('PLANNER_VERSION_INVALID', { expected: current.planVersion + 1, actual: next.planVersion });
    }
    return next;
  }
}
