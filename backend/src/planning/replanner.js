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

const normObjective = (s) =>
  String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

function extractRawStrategyMap(planOrProposal, fallbackStrategy = null) {
  const map = new Map();
  const list =
    planOrProposal?.tasks ??
    planOrProposal?.nodes ??
    planOrProposal?.addTasks ??
    planOrProposal?.addNodes ??
    [];
  if (!Array.isArray(list)) return map;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t || typeof t !== 'object') continue;
    const key = String(t.taskKey ?? t.nodeKey ?? t.key ?? `task-${i + 1}`);
    const strat =
      typeof t.strategy === 'string' && t.strategy.trim()
        ? t.strategy.trim()
        : typeof t.metadata?.strategy === 'string' && t.metadata.strategy.trim()
          ? t.metadata.strategy.trim()
          : fallbackStrategy;
    if (strat) map.set(key, strat);
  }
  return map;
}

function normalizeFailureRecords(failedStrategies, failureContext) {
  const globalFailedStrategies = new Set();
  const failedByTask = new Map();

  const addFailure = (taskKey, strategy = null, objective = null) => {
    const k = taskKey ? String(taskKey).trim() : '';
    const s = strategy ? String(strategy).trim() : null;
    const o = objective ? String(objective).trim() : null;
    if (k) {
      const list = failedByTask.get(k) ?? [];
      list.push({ strategy: s, objective: o });
      failedByTask.set(k, list);
    } else if (s) {
      globalFailedStrategies.add(s);
    }
  };

  if (Array.isArray(failedStrategies) || failedStrategies instanceof Set) {
    for (const item of failedStrategies) {
      if (typeof item === 'string' && item.trim()) {
        addFailure(null, item, null);
      } else if (item && typeof item === 'object') {
        addFailure(
          item.taskKey ?? item.failedTaskKey ?? item.nodeKey ?? item.failedNodeKey ?? item.key,
          item.strategy ?? item.replanStrategy ?? item.name,
          item.objective,
        );
      }
    }
  } else if (failedStrategies instanceof Map) {
    for (const [k, v] of failedStrategies.entries()) {
      const arr = Array.isArray(v) || v instanceof Set ? [...v] : [v];
      for (const s of arr) {
        addFailure(k, typeof s === 'string' ? s : s?.strategy, s?.objective ?? null);
      }
    }
  } else if (failedStrategies && typeof failedStrategies === 'object') {
    for (const [k, v] of Object.entries(failedStrategies)) {
      const arr = Array.isArray(v) ? v : [v];
      for (const s of arr) {
        addFailure(k, typeof s === 'string' ? s : s?.strategy, s?.objective ?? null);
      }
    }
  }

  if (failureContext && typeof failureContext === 'object') {
    if (Array.isArray(failureContext.failedTasks)) {
      for (const item of failureContext.failedTasks) {
        if (!item || typeof item !== 'object') continue;
        addFailure(
          item.taskKey ?? item.nodeKey ?? item.key,
          item.strategy ?? item.replanStrategy,
          item.objective,
        );
      }
    }
    if (Array.isArray(failureContext.attempts)) {
      for (const item of failureContext.attempts) {
        if (!item || typeof item !== 'object') continue;
        addFailure(
          item.taskKey ?? item.nodeKey ?? item.key ?? failureContext.taskKey,
          item.strategy ?? item.replanStrategy,
          item.objective ?? failureContext.objective,
        );
      }
    }
    const ctxTaskKey =
      failureContext.taskKey ??
      failureContext.failedTaskKey ??
      failureContext.nodeKey ??
      failureContext.failedNodeKey ??
      null;
    const ctxStrat =
      failureContext.strategy ?? failureContext.lastStrategy ?? failureContext.replanStrategy ?? null;
    const ctxObj = failureContext.objective ?? null;
    if (ctxTaskKey) {
      if (Array.isArray(failureContext.failedStrategies)) {
        for (const s of failureContext.failedStrategies) {
          addFailure(ctxTaskKey, typeof s === 'string' ? s : s?.strategy, ctxObj);
        }
      } else if (ctxStrat || ctxObj || globalFailedStrategies.size > 0) {
        addFailure(ctxTaskKey, ctxStrat, ctxObj);
      }
    } else if (ctxStrat) {
      globalFailedStrategies.add(String(ctxStrat).trim());
    }
  }

  return { globalFailedStrategies, failedByTask };
}

function isToolAllowNarrowed(beforeAllow, afterAllow) {
  if (!Array.isArray(afterAllow)) return false;
  if (beforeAllow === null || beforeAllow === undefined) return true;
  if (Array.isArray(beforeAllow) && afterAllow.length < beforeAllow.length) return true;
  return false;
}

function assertNotDegenerateReplan({
  current,
  proposed,
  proposal,
  completed,
  currentTasks,
  proposedTasks,
  rawCurrentStrategies,
  rawProposalTaskOnlyStrategies,
  proposalStrategy,
  failedStrategies,
  failureContext,
}) {
  const { globalFailedStrategies, failedByTask } = normalizeFailureRecords(
    failedStrategies,
    failureContext,
  );
  if (failedByTask.size === 0 && globalFailedStrategies.size === 0 && !failureContext) {
    return;
  }

  const hasNewTasks = [...proposedTasks.keys()].some((k) => !currentTasks.has(k));

  const resolveAfterStrategy = (taskKey, beforeTask, afterTask, beforeStrat) => {
    const taskProp = rawProposalTaskOnlyStrategies.get(taskKey);
    if (taskProp && taskProp !== beforeStrat) return taskProp;
    if (afterTask?.metadata?.strategy && afterTask.metadata.strategy !== beforeStrat) {
      return String(afterTask.metadata.strategy);
    }
    if (proposalStrategy) return proposalStrategy;
    return taskProp ?? afterTask?.metadata?.strategy ?? null;
  };

  const evaluateTaskDelta = (beforeTask, afterTask, taskFailedStrats, afterStrat, beforeStrat) => {
    const depsChanged =
      JSON.stringify(beforeTask?.dependencies ?? []) !==
      JSON.stringify(afterTask.dependencies ?? []);
    const narrowed =
      isToolAllowNarrowed(beforeTask?.toolAllow ?? null, afterTask.toolAllow ?? null) ||
      afterTask.metadata?.narrowed === true ||
      afterTask.metadata?.splitFrom === afterTask.taskKey ||
      proposal?.split === true ||
      (beforeTask?.acceptance &&
        JSON.stringify(beforeTask.acceptance) !== JSON.stringify(afterTask.acceptance));
    const typeChanged = Boolean(
      beforeTask &&
        afterTask.taskType !== beforeTask.taskType &&
        !taskFailedStrats.has(afterTask.taskType),
    );
    const stratChangedAway =
      afterStrat !== null &&
      afterStrat !== undefined &&
      !taskFailedStrats.has(afterStrat) &&
      afterStrat !== beforeStrat;
    return { depsChanged, narrowed, typeChanged, stratChangedAway };
  };

  if (failedByTask.size > 0) {
    for (const [failedKey, records] of failedByTask.entries()) {
      if (completed.has(failedKey)) continue;
      const beforeTask = currentTasks.get(failedKey);
      const afterTask = proposedTasks.get(failedKey);
      if (!afterTask) {
        if (hasNewTasks || proposedTasks.size > currentTasks.size) {
          continue;
        }
        continue;
      }

      const priorObjectives = records.map((r) => r.objective).filter(Boolean);
      if (!priorObjectives.length && beforeTask?.objective) {
        priorObjectives.push(beforeTask.objective);
      }
      const afterObjNorm = normObjective(afterTask.objective);
      const sameObjective =
        priorObjectives.length === 0
          ? Boolean(beforeTask && normObjective(beforeTask.objective) === afterObjNorm)
          : priorObjectives.some((o) => normObjective(o) === afterObjNorm);
      if (!sameObjective) continue;

      const taskFailedStrats = new Set([
        ...globalFailedStrategies,
        ...records.map((r) => r.strategy).filter(Boolean),
      ]);
      const beforeStrat = rawCurrentStrategies.get(failedKey) ?? beforeTask?.metadata?.strategy ?? null;
      const afterStrat = resolveAfterStrategy(failedKey, beforeTask, afterTask, beforeStrat);
      const fallbackStrat = records.at(-1)?.strategy ?? beforeStrat ?? 'retry_same';
      const effectiveStrat = afterStrat ?? fallbackStrat;
      const sameFailedStrat =
        taskFailedStrats.has(effectiveStrat) ||
        (afterStrat === null &&
          (taskFailedStrats.size > 0 || records.some((r) => !r.strategy || r.strategy === effectiveStrat)));

      const state = evaluateTaskDelta(
        beforeTask,
        afterTask,
        taskFailedStrats,
        afterStrat,
        beforeStrat,
      );
      if (
        sameFailedStrat &&
        !state.depsChanged &&
        !state.narrowed &&
        !state.typeChanged &&
        !state.stratChangedAway
      ) {
        throw plannerFault('PLANNER_DEGENERATE_REPLAN_DENIED', {
          taskKey: failedKey,
          strategy: effectiveStrat,
          objective: afterTask.objective,
          reason:
            'Failed task keeps the exact same objective and previously failed strategy without narrowing, splitting, or changing strategy',
        });
      }
    }
    return;
  }

  // Fallback when caller supplied failedStrategies / failureContext without an explicit taskKey
  const targetObjNorm = failureContext?.objective ? normObjective(failureContext.objective) : null;
  const ctxStrat = failureContext?.strategy ?? failureContext?.lastStrategy ?? null;
  const effectiveFailedSet = new Set([
    ...globalFailedStrategies,
    ...(ctxStrat ? [String(ctxStrat).trim()] : []),
  ]);

  const isTaskRepeatingUnchanged = (afterTask) => {
    const beforeTask = currentTasks.get(afterTask.taskKey);
    const beforeStrat =
      rawCurrentStrategies.get(afterTask.taskKey) ?? beforeTask?.metadata?.strategy ?? null;
    const afterStrat = resolveAfterStrategy(afterTask.taskKey, beforeTask, afterTask, beforeStrat);
    const effectiveStrat = afterStrat ?? beforeStrat ?? ctxStrat ?? 'retry_same';
    const state = evaluateTaskDelta(
      beforeTask,
      afterTask,
      effectiveFailedSet,
      afterStrat,
      beforeStrat,
    );
    const degenerate =
      (effectiveFailedSet.has(effectiveStrat) || afterStrat === null) &&
      !state.depsChanged &&
      !state.narrowed &&
      !state.typeChanged &&
      !state.stratChangedAway;
    return { degenerate, effectiveStrat };
  };

  if (targetObjNorm) {
    for (const afterTask of proposed.tasks) {
      if (completed.has(afterTask.taskKey)) continue;
      if (normObjective(afterTask.objective) !== targetObjNorm) continue;
      const check = isTaskRepeatingUnchanged(afterTask);
      if (check.degenerate) {
        throw plannerFault('PLANNER_DEGENERATE_REPLAN_DENIED', {
          taskKey: afterTask.taskKey,
          strategy: check.effectiveStrat,
          objective: afterTask.objective,
        });
      }
    }
    return;
  }

  if (effectiveFailedSet.size > 0 && current.tasks.length === proposed.tasks.length) {
    const nonCompletedBefore = current.tasks.filter((t) => !completed.has(t.taskKey));
    const allUnchanged =
      nonCompletedBefore.length > 0 &&
      nonCompletedBefore.every((beforeTask) => {
        const afterTask = proposedTasks.get(beforeTask.taskKey);
        if (!afterTask) return false;
        if (normObjective(afterTask.objective) !== normObjective(beforeTask.objective)) return false;
        return isTaskRepeatingUnchanged(afterTask).degenerate;
      });
    if (allUnchanged) {
      throw plannerFault('PLANNER_DEGENERATE_REPLAN_DENIED', {
        strategy: proposalStrategy ?? [...effectiveFailedSet][0] ?? 'retry_same',
        reason: 'Replan proposal repeats all non-completed tasks unchanged with a failed strategy',
      });
    }
  }
}

export class AdaptiveReplanner {
  constructor({ planner, permissionCeiling = 'full' } = {}) {
    this.planner = planner;
    this.permissionCeiling = permissionCeiling;
  }

  replan(
    currentPlan,
    proposal,
    {
      completedTaskKeys = [],
      appliedEffectKeys = [],
      failedStrategies = [],
      failureContext = null,
    } = {},
  ) {
    const proposalStrategy =
      typeof proposal?.strategy === 'string' && proposal.strategy.trim()
        ? proposal.strategy.trim()
        : null;
    const rawCurrentStrategies = extractRawStrategyMap(currentPlan);
    const rawProposalTaskOnlyStrategies = extractRawStrategyMap(proposal, null);

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

    for (const t of proposed.tasks) {
      if (completed.has(t.taskKey)) continue;
      const explicitStrat = rawProposalTaskOnlyStrategies.get(t.taskKey);
      if (explicitStrat && !t.metadata?.strategy) {
        t.metadata = { ...(t.metadata ?? {}), strategy: explicitStrat };
      }
    }

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

    assertNotDegenerateReplan({
      current,
      proposed,
      proposal,
      completed,
      currentTasks,
      proposedTasks,
      rawCurrentStrategies,
      rawProposalTaskOnlyStrategies,
      proposalStrategy,
      failedStrategies,
      failureContext,
    });

    const next = validatePlan({
      ...proposed,
      metadata: {
        ...(proposed.metadata ?? {}),
        initialBudget,
        ...(proposalStrategy ? { lastReplanStrategy: proposalStrategy } : {}),
      },
      planVersion: current.planVersion + 1,
    }, { permissionCeiling: this.permissionCeiling });
    if (next.planVersion !== current.planVersion + 1) {
      throw plannerFault('PLANNER_VERSION_INVALID', { expected: current.planVersion + 1, actual: next.planVersion });
    }
    return next;
  }
}
