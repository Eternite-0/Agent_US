import { normalizePlan, normalizeTask, validatePlan } from './validator.js';

export class AdaptivePlanner {
  constructor({ permissionCeiling = 'full' } = {}) {
    this.permissionCeiling = permissionCeiling;
  }

  createPlan({ goal, tasks, budget = {}, permissionMode = 'auto-safe', acceptance, metadata = {} }) {
    return validatePlan({
      planVersion: 1,
      goal,
      tasks: (tasks ?? []).map(normalizeTask),
      budget,
      permissionMode,
      ...(acceptance === undefined ? {} : { acceptance }),
      metadata,
    }, { permissionCeiling: this.permissionCeiling });
  }

  validate(plan) {
    return validatePlan(normalizePlan(plan), { permissionCeiling: this.permissionCeiling });
  }

  nextVersion(plan, changes = {}) {
    const current = this.validate(plan);
    const candidate = normalizePlan({ ...current, ...changes, planVersion: current.planVersion + 1 });
    return this.validate(candidate);
  }
}
