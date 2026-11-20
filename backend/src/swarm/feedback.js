const CONFIDENCE_PRIOR_WEIGHT = 10;

/**
 * Layer 6/7 Empirical ModelFeedbackTracker backed by SQLite `model_feedback`.
 * Computes 8 empirical execution metrics and Bayesian shrinkage confidence `n / (n + 10)`.
 */
export class ModelFeedbackTracker {
  constructor(store) {
    this.store = store;
  }

  record({
    model,
    provider = 'pool',
    taskType = 'general',
    success = true,
    toolTotal = 0,
    toolSuccess = 0,
    verifiedPass = true,
    latencyMs = 0,
    timedOut = false,
    inputTokens = 0,
    outputTokens = 0,
    contextWindow = 128_000,
    recovered = false,
  }) {
    if (!model || !this.store?.db?.isOpen) return null;
    const now = Date.now();
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO model_feedback(
            model, provider, taskType, success, toolTotal, toolSuccess, verifiedPass,
            latencyMs, timedOut, inputTokens, outputTokens, contextWindow, recovered, createdAt
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          String(model),
          String(provider || 'pool'),
          String(taskType || 'general'),
          success ? 1 : 0,
          Math.max(0, Number(toolTotal || 0)),
          Math.max(0, Number(toolSuccess || 0)),
          verifiedPass ? 1 : 0,
          Math.max(0, Number(latencyMs || 0)),
          timedOut ? 1 : 0,
          Math.max(0, Number(inputTokens || 0)),
          Math.max(0, Number(outputTokens || 0)),
          Math.max(1, Number(contextWindow || 128_000)),
          recovered ? 1 : 0,
          now,
        );
    });
    return true;
  }

  getStats(model, { taskType = null, windowDays = 30 } = {}) {
    if (!model || !this.store?.db?.isOpen) {
      return this.#emptyStats();
    }
    const cutoff = Date.now() - Math.max(1, Number(windowDays || 30)) * 86_400_000;
    let rows = taskType
      ? this.store.db
          .prepare(
            'SELECT * FROM model_feedback WHERE model=? AND taskType=? AND createdAt>=? ORDER BY createdAt DESC LIMIT 200',
          )
          .all(model, taskType, cutoff)
      : [];
    if (rows.length < 3) {
      rows = this.store.db
        .prepare(
          'SELECT * FROM model_feedback WHERE model=? AND createdAt>=? ORDER BY createdAt DESC LIMIT 200',
        )
        .all(model, cutoff);
    }

    const n = rows.length;
    if (!n) return this.#emptyStats();

    let sumSuccess = 0;
    let sumToolTotal = 0;
    let sumToolSuccess = 0;
    let sumVerified = 0;
    let sumLatency = 0;
    let sumTimedOut = 0;
    let sumTokens = 0;
    let sumCtxUtil = 0;
    let sumRecovered = 0;

    for (const r of rows) {
      sumSuccess += Number(r.success || 0);
      sumToolTotal += Number(r.toolTotal || 0);
      sumToolSuccess += Number(r.toolSuccess || 0);
      sumVerified += Number(r.verifiedPass || 0);
      sumLatency += Number(r.latencyMs || 0);
      sumTimedOut += Number(r.timedOut || 0);
      const tok = Number(r.inputTokens || 0) + Number(r.outputTokens || 0);
      sumTokens += tok;
      sumCtxUtil += Math.min(1, tok / Math.max(1, Number(r.contextWindow || 128_000)));
      sumRecovered += Number(r.recovered || 0);
    }

    const successRate = sumSuccess / n;
    const toolSuccessRate = sumToolTotal > 0 ? Math.min(1, sumToolSuccess / sumToolTotal) : 1;
    const verificationPassRate = sumVerified / n;
    const avgLatencyMs = sumLatency / n;
    const timeoutRate = sumTimedOut / n;
    const avgTokens = sumTokens / n;
    const contextUtilization = sumCtxUtil / n;
    const recoveryRate = sumRecovered / n;
    const confidence = Number((n / (n + CONFIDENCE_PRIOR_WEIGHT)).toFixed(4));

    const speedFactor = Math.max(0, 1 - avgLatencyMs / 60_000);
    const empiricalScore = Number(
      Math.max(
        0,
        Math.min(
          1,
          0.35 * successRate +
            0.2 * toolSuccessRate +
            0.2 * verificationPassRate +
            0.15 * (1 - timeoutRate) +
            0.1 * speedFactor,
        ),
      ).toFixed(4),
    );

    return {
      sampleCount: n,
      confidence,
      empiricalScore,
      metrics: {
        successRate: Number(successRate.toFixed(4)),
        toolSuccessRate: Number(toolSuccessRate.toFixed(4)),
        verificationPassRate: Number(verificationPassRate.toFixed(4)),
        avgLatencyMs: Math.round(avgLatencyMs),
        timeoutRate: Number(timeoutRate.toFixed(4)),
        avgTokens: Math.round(avgTokens),
        contextUtilization: Number(contextUtilization.toFixed(4)),
        recoveryRate: Number(recoveryRate.toFixed(4)),
      },
    };
  }

  #emptyStats() {
    return {
      sampleCount: 0,
      confidence: 0,
      empiricalScore: null,
      metrics: {
        successRate: null,
        toolSuccessRate: null,
        verificationPassRate: null,
        avgLatencyMs: 0,
        timeoutRate: 0,
        avgTokens: 0,
        contextUtilization: 0,
        recoveryRate: 0,
      },
    };
  }
}
