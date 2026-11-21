import { feedbackSchema, parseSchema } from './schemas.js';

export class PlannerFeedbackCollector {
  #entries = [];

  record(input) {
    const feedback = parseSchema(feedbackSchema, input, 'PLANNER_FEEDBACK_INVALID');
    const entry = Object.freeze({ ...feedback, recordedAt: Date.now() });
    this.#entries.push(entry);
    return entry;
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
}
