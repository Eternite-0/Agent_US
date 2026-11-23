import { feedbackSchema, parseSchema } from './schemas.js';

export class PlannerFeedbackCollector {
  #entries = [];
  #avoidedRepeatEvents = 0;

  record(input) {
    const feedback = parseSchema(feedbackSchema, input, 'PLANNER_FEEDBACK_INVALID');
    const entry = Object.freeze({ ...feedback, recordedAt: Date.now() });
    this.#entries.push(entry);
    return entry;
  }

  recordAvoidedRepeatFailure() {
    this.#avoidedRepeatEvents += 1;
  }

  list({ taskKey = null } = {}) {
    return this.#entries.filter((entry) => !taskKey || entry.taskKey === taskKey).map((entry) => ({ ...entry, effectsApplied: [...entry.effectsApplied], evidence: [...entry.evidence] }));
  }

  summarize() {
    const entries = this.#entries;
    return {
      count: entries.length,
      successCount: entries.filter((entry) => entry.success).length,
      verifiedCount: entries.filter((entry) => entry.verified === true).length,
      failedCount: entries.filter((entry) => entry.status === 'failed').length,
      cancelledCount: entries.filter((entry) => entry.status === 'cancelled').length,
      inputTokens: entries.reduce((sum, entry) => sum + entry.inputTokens, 0),
      outputTokens: entries.reduce((sum, entry) => sum + entry.outputTokens, 0),
      latencyMs: entries.reduce((sum, entry) => sum + entry.latencyMs, 0),
    };
  }

  summarizeReplanEffectiveness() {
    const lastFailureByTask = new Map();
    let totalReplanAttempts = 0;
    let postReplanRecoveries = 0;
    let avoidedRepeatFailures = this.#avoidedRepeatEvents;
    const strategies = {};

    for (const entry of this.#entries) {
      const targetKey = entry.priorFailureTaskKey || entry.taskKey;
      const priorFailure = lastFailureByTask.get(targetKey) ?? null;
      const strat = entry.replanStrategy ?? entry.strategy ?? null;
      const explicitNotReplan = entry.replanAttempt === false || entry.isReplan === false;
      const isReplan =
        !explicitNotReplan &&
        (entry.replanAttempt === true ||
          entry.isReplan === true ||
          entry.recoveredAfterReplan === true ||
          Boolean(entry.priorFailureTaskKey) ||
          (entry.planVersion !== undefined && entry.planVersion > 1) ||
          (Boolean(entry.replanStrategy) && (entry.success === true || entry.status === 'completed')));
      const explicitAvoided =
        entry.avoidedRepeatFailure === true || entry.degenerateReplanBlocked === true;

      if (isReplan) {
        totalReplanAttempts += 1;
        if (strat) strategies[strat] = (strategies[strat] ?? 0) + 1;
        const recovered =
          entry.recoveredAfterReplan === false
            ? false
            : entry.recoveredAfterReplan === true ||
              entry.recovered === true ||
              (entry.success === true && entry.status === 'completed');
        if (recovered) postReplanRecoveries += 1;

        if (explicitAvoided) {
          avoidedRepeatFailures += 1;
        } else if (
          entry.avoidedRepeatFailure !== false &&
          recovered &&
          priorFailure &&
          ((strat && priorFailure.strategy && strat !== priorFailure.strategy) ||
            (entry.failureSignature &&
              priorFailure.failureSignature &&
              entry.failureSignature !== priorFailure.failureSignature) ||
            Boolean(strat && strat !== 'retry_same'))
        ) {
          avoidedRepeatFailures += 1;
        }
      } else if (explicitAvoided) {
        avoidedRepeatFailures += 1;
      }

      if (!entry.success || entry.status === 'failed' || entry.status === 'blocked') {
        lastFailureByTask.set(entry.taskKey, {
          strategy: strat,
          failureSignature: entry.failureSignature ?? null,
          notes: entry.notes,
        });
      }
    }

    return {
      totalReplanAttempts,
      postReplanRecoveries,
      avoidedRepeatFailures,
      recoveryRate:
        totalReplanAttempts > 0
          ? Number((postReplanRecoveries / totalReplanAttempts).toFixed(4))
          : 0,
      strategies,
    };
  }
}
