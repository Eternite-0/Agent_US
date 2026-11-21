import { Fault } from '../store.js';
import {
  PERMISSION_LEVELS,
  planSchema,
  taskSchema,
  parseSchema,
} from './schemas.js';

function plannerFault(code, detail = undefined) {
  return new Fault(code, 400, detail);
}

function normalizeAcceptance(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    return {
      description: String(value.description ?? '').trim(),
      requiredEvidence: Array.isArray(value.requiredEvidence)
        ? value.requiredEvidence.map(String)
        : [],
      ...(value.minConfidence === undefined ? {} : { minConfidence: Number(value.minConfidence) }),
    };
  }
  return value;
}

export function normalizeTask(input, index = 0) {
  const raw = input ?? {};
  return {
    taskKey: String(raw.taskKey ?? raw.nodeKey ?? raw.key ?? `task-${index + 1}`),
    objective: String(raw.objective ?? '').trim() || `Task ${index + 1}`,
    acceptance: normalizeAcceptance(raw.acceptance ?? 'Provide concrete verified output'),
    taskType: String(raw.taskType ?? 'general'),
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String) : [],
    permissionMode: raw.permissionMode ?? 'auto-safe',
    toolAllow: raw.toolAllow === undefined ? null : raw.toolAllow,
    budget: raw.budget && typeof raw.budget === 'object' ? { ...raw.budget } : {},
    sideEffects: Array.isArray(raw.sideEffects) ? raw.sideEffects.map((effect) => ({ ...effect })) : [],
    metadata: raw.metadata && typeof raw.metadata === 'object' ? { ...raw.metadata } : {},
  };
}

export function normalizePlan(input) {
  const raw = input ?? {};
  return {
    planVersion: Number(raw.planVersion ?? 1),
    goal: String(raw.goal ?? '').trim(),
    permissionMode: raw.permissionMode ?? 'auto-safe',
    budget: raw.budget && typeof raw.budget === 'object' ? { ...raw.budget } : {},
    tasks: Array.isArray(raw.tasks ?? raw.nodes)
      ? (raw.tasks ?? raw.nodes).map(normalizeTask)
      : [],
    ...(raw.acceptance === undefined ? {} : { acceptance: normalizeAcceptance(raw.acceptance) }),
    metadata: raw.metadata && typeof raw.metadata === 'object' ? { ...raw.metadata } : {},
  };
}

function assertBudgetWithin(parent, child, taskKey) {
  const checks = [
    ['maxInputTokens', '<='],
    ['maxOutputTokens', '<='],
    ['maxSteps', '<='],
    ['maxCostUsd', '<='],
  ];
  for (const [key] of checks) {
    if (parent[key] !== undefined && child[key] !== undefined && child[key] > parent[key]) {
      throw plannerFault('PLANNER_BUDGET_EXCEEDED', { taskKey, field: key, parent: parent[key], requested: child[key] });
    }
  }
}

function assertDag(tasks) {
  const byKey = new Map();
  for (const task of tasks) {
    if (byKey.has(task.taskKey)) throw plannerFault('PLANNER_DUPLICATE_TASK', { taskKey: task.taskKey });
    byKey.set(task.taskKey, task);
  }
  const indegree = new Map([...byKey.keys()].map((key) => [key, 0]));
  const dependents = new Map([...byKey.keys()].map((key) => [key, []]));
  for (const task of tasks) {
    const seen = new Set();
    for (const dependency of task.dependencies) {
      if (dependency === task.taskKey) throw plannerFault('PLANNER_SELF_DEPENDENCY', { taskKey: task.taskKey });
      if (seen.has(dependency)) throw plannerFault('PLANNER_DUPLICATE_DEPENDENCY', { taskKey: task.taskKey, dependency });
      seen.add(dependency);
      if (!byKey.has(dependency)) throw plannerFault('PLANNER_UNKNOWN_DEPENDENCY', { taskKey: task.taskKey, dependency });
      indegree.set(task.taskKey, indegree.get(task.taskKey) + 1);
      dependents.get(dependency).push(task.taskKey);
    }
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([key]) => key);
  let visited = 0;
  while (queue.length) {
    const key = queue.shift();
    visited++;
    for (const dependent of dependents.get(key)) {
      const next = indegree.get(dependent) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (visited !== tasks.length) throw plannerFault('PLANNER_DAG_CYCLE', { message: 'task dependencies contain a cycle' });
  return { byKey, dependents };
}

export function validatePlan(input, { permissionCeiling = 'full' } = {}) {
  const plan = input?.tasks ? input : normalizePlan(input);
  let parsed;
  try {
    parsed = parseSchema(planSchema, plan);
  } catch (error) {
    if (error?.code === 'PLANNER_SCHEMA_INVALID') throw plannerFault(error.code, { issues: error.issues });
    throw error;
  }
  const { byKey } = assertDag(parsed.tasks);
  const ceiling = PERMISSION_LEVELS[permissionCeiling];
  if (ceiling === undefined) throw plannerFault('PLANNER_PERMISSION_INVALID', { permissionCeiling });
  if (PERMISSION_LEVELS[parsed.permissionMode] > ceiling) {
    throw plannerFault('PLANNER_PERMISSION_ESCALATION', { requested: parsed.permissionMode, ceiling: permissionCeiling });
  }
  let totalSteps = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  for (const task of parsed.tasks) {
    if (PERMISSION_LEVELS[task.permissionMode] > PERMISSION_LEVELS[parsed.permissionMode]) {
      throw plannerFault('PLANNER_PERMISSION_ESCALATION', { taskKey: task.taskKey, requested: task.permissionMode, ceiling: parsed.permissionMode });
    }
    assertBudgetWithin(parsed.budget, task.budget, task.taskKey);
    totalSteps += task.budget.maxSteps ?? 0;
    totalInput += task.budget.maxInputTokens ?? 0;
    totalOutput += task.budget.maxOutputTokens ?? 0;
    totalCost += task.budget.maxCostUsd ?? 0;
    const effectKeys = new Set();
    for (const effect of task.sideEffects) {
      if (effectKeys.has(effect.effectKey)) throw plannerFault('PLANNER_DUPLICATE_EFFECT', { taskKey: task.taskKey, effectKey: effect.effectKey });
      effectKeys.add(effect.effectKey);
    }
    if (task.acceptance && typeof task.acceptance === 'object' && task.acceptance.requiredEvidence.length === 0) {
      throw plannerFault('PLANNER_ACCEPTANCE_INCOMPLETE', { taskKey: task.taskKey });
    }
    if (!byKey.has(task.taskKey)) throw plannerFault('PLANNER_INVALID_TASK', { taskKey: task.taskKey });
  }
  if (parsed.budget.maxSteps !== undefined && totalSteps > parsed.budget.maxSteps) {
    throw plannerFault('PLANNER_BUDGET_EXCEEDED', { field: 'maxSteps', requested: totalSteps, limit: parsed.budget.maxSteps });
  }
  if (parsed.budget.maxInputTokens !== undefined && totalInput > parsed.budget.maxInputTokens) {
    throw plannerFault('PLANNER_BUDGET_EXCEEDED', { field: 'maxInputTokens', requested: totalInput, limit: parsed.budget.maxInputTokens });
  }
  if (parsed.budget.maxOutputTokens !== undefined && totalOutput > parsed.budget.maxOutputTokens) {
    throw plannerFault('PLANNER_BUDGET_EXCEEDED', { field: 'maxOutputTokens', requested: totalOutput, limit: parsed.budget.maxOutputTokens });
  }
  if (parsed.budget.maxCostUsd !== undefined && totalCost > parsed.budget.maxCostUsd) {
    throw plannerFault('PLANNER_BUDGET_EXCEEDED', { field: 'maxCostUsd', requested: totalCost, limit: parsed.budget.maxCostUsd });
  }
  return parsed;
}

export function taskMap(plan) {
  return new Map(plan.tasks.map((task) => [task.taskKey, task]));
}
