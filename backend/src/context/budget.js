import { estimateTokens, measureRequestComposition } from '../context.js';

const DIMINISHING_DELTA_TOKENS = 500;

/**
 * Layer 5 TokenBudgetManager: CJK-aware token estimation, window reservation,
 * composition telemetry, and diminishing-returns continuation guard.
 */
export class TokenBudgetManager {
  constructor({ defaultReserveTokens = 16384 } = {}) {
    this.defaultReserveTokens = defaultReserveTokens;
  }

  estimate(text) {
    return estimateTokens(text);
  }

  measure(options) {
    return measureRequestComposition(options);
  }

  computeTrigger(contextWindow = 128000, reserveTokens = undefined) {
    const win = Math.max(4096, Number(contextWindow || 128000));
    const reserve =
      reserveTokens ?? Math.min(this.defaultReserveTokens, Math.floor(win / 4));
    return Math.max(1024, win - reserve);
  }

  needsCompaction(options, contextWindow = 128000) {
    const trigger = this.computeTrigger(contextWindow);
    const comp = this.measure(options);
    return {
      needed: comp.totalTokens > trigger,
      trigger,
      composition: comp,
    };
  }

  /**
   * Claude Code tokenBudget.ts style continuation tracker preventing endless
   * low-delta loops near budget exhaustion.
   */
  createContinuationTracker(budgetTokens = null) {
    return {
      budgetTokens,
      continuations: 0,
      lastTokens: 0,
      lastDelta: 0,
      check(currentTokens) {
        if (!budgetTokens || budgetTokens <= 0) {
          return { action: 'stop', diminishing: false };
        }
        const delta = currentTokens - this.lastTokens;
        const diminishing =
          this.continuations >= 3 &&
          delta < DIMINISHING_DELTA_TOKENS &&
          this.lastDelta < DIMINISHING_DELTA_TOKENS;
        if (!diminishing && currentTokens < budgetTokens * 0.9) {
          this.continuations++;
          this.lastDelta = delta;
          this.lastTokens = currentTokens;
          return {
            action: 'continue',
            pct: Math.round((currentTokens / budgetTokens) * 100),
            continuations: this.continuations,
          };
        }
        return {
          action: 'stop',
          diminishing,
          pct: Math.round((currentTokens / budgetTokens) * 100),
        };
      },
    };
  }
}
