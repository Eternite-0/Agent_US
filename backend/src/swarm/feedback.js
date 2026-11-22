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
    verifiedPass = null,
    verificationStatus = null,
    failureKind = null,
    cancelled = false,
    latencyMs = 0,
    timedOut = false,
    inputTokens = 0,
    outputTokens = 0,
    contextWindow = 128_000,
    recovered = false,
    trafficSource = 'production',
    isSynthetic = 0,
  }) {
    if (!model || !this.store?.db?.isOpen) return null;
    const now = Date.now();
    const isCancelled = Boolean(cancelled || failureKind === 'cancelled');
    const isTimedOut = Boolean(timedOut || failureKind === 'timeout');
    const normVerifiedPass =
      verifiedPass === true ? 1 : verifiedPass === false ? 0 : null;
    const normVerStatus =
      verificationStatus ||
      (normVerifiedPass === 1
        ? 'passed'
        : normVerifiedPass === 0
          ? 'failed'
          : 'unverified');
    const normFailureKind =
      failureKind ||
      (isCancelled
        ? 'cancelled'
        : isTimedOut
          ? 'timeout'
          : !success
            ? normVerifiedPass === 0
              ? 'verification_failure'
              : 'task_failure'
            : null);

    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO model_feedback(
            model, provider, taskType, success, toolTotal, toolSuccess, verifiedPass,
            latencyMs, timedOut, inputTokens, outputTokens, contextWindow, recovered,
            verificationStatus, failureKind, cancelled, trafficSource, isSynthetic, createdAt
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          String(model),
          String(provider || 'pool'),
          String(taskType || 'general'),
          success ? 1 : 0,
          Math.max(0, Number(toolTotal || 0)),
          Math.max(0, Number(toolSuccess || 0)),
          normVerifiedPass,
          Math.max(0, Number(latencyMs || 0)),
          isTimedOut ? 1 : 0,
          Math.max(0, Number(inputTokens || 0)),
          Math.max(0, Number(outputTokens || 0)),
          Math.max(1, Number(contextWindow || 128_000)),
          recovered ? 1 : 0,
          normVerStatus,
          normFailureKind,
          isCancelled ? 1 : 0,
          String(trafficSource || 'production'),
          isSynthetic ? 1 : 0,
          now,
        );
    });
    return true;
  }

  getReviewerStats(model, { windowDays = 30, includeSynthetic = false } = {}) {
    if (!model || !this.store?.db?.isOpen) {
      return this.#emptyStats();
    }
    const cutoff = Date.now() - Math.max(1, Number(windowDays || 30)) * 86_400_000;
    const synthClause = includeSynthetic ? '' : ' AND isSynthetic = 0';
    const rows = this.store.db
      .prepare(
        `SELECT * FROM model_feedback WHERE model=? AND taskType='review' AND createdAt>=?${synthClause} ORDER BY createdAt DESC LIMIT 200`,
      )
      .all(model, cutoff);
    return this.#summarizeRows(rows);
  }

  getStats(model, { taskType = null, windowDays = 30, includeSynthetic = false } = {}) {
    if (!model || !this.store?.db?.isOpen) {
      return this.#emptyStats();
    }
    const cutoff = Date.now() - Math.max(1, Number(windowDays || 30)) * 86_400_000;
    const synthClause = includeSynthetic ? '' : ' AND isSynthetic = 0';
    let rows = taskType
      ? this.store.db
          .prepare(
            `SELECT * FROM model_feedback WHERE model=? AND taskType=? AND createdAt>=?${synthClause} ORDER BY createdAt DESC LIMIT 200`,
          )
          .all(model, taskType, cutoff)
      : [];
    if (rows.length < 3) {
      rows = this.store.db
        .prepare(
          `SELECT * FROM model_feedback WHERE model=? AND createdAt>=?${synthClause} ORDER BY createdAt DESC LIMIT 200`,
        )
        .all(model, cutoff);
    }
    return this.#summarizeRows(rows);
  }

  #summarizeRows(rows) {
    const n = rows.length;
    if (!n) return this.#emptyStats();

    let sumSuccess = 0;
    let nonCancelledCount = 0;
    let sumToolTotal = 0;
    let sumToolSuccess = 0;
    let toolSampleCount = 0;
    let sumVerified = 0;
    let verifiedSampleCount = 0;
    let sumLatency = 0;
    let sumTimedOut = 0;
    let sumTokens = 0;
    let sumCtxUtil = 0;
    let sumRecoveredTotal = 0;
    let sumRecoveredSucceeded = 0;
    let sumCancelled = 0;
    const failureBreakdown = {
      task_failure: 0,
      tool_failure: 0,
      verification_failure: 0,
      timeout: 0,
      cancelled: 0,
      budget: 0,
    };

    for (const r of rows) {
      const rowCancelled = Number(r.cancelled || 0) === 1 || r.failureKind === 'cancelled';
      if (rowCancelled) {
        sumCancelled++;
      } else {
        nonCancelledCount++;
        sumSuccess += Number(r.success || 0);
        sumTimedOut += Number(r.timedOut || 0);
      }

      const tt = Number(r.toolTotal || 0);
      const ts = Number(r.toolSuccess || 0);
      if (tt > 0) {
        toolSampleCount++;
        sumToolTotal += tt;
        sumToolSuccess += ts;
      }

      const isUnverified =
        r.verifiedPass === null ||
        r.verifiedPass === undefined ||
        r.verificationStatus === 'unverified';
      if (!isUnverified && !rowCancelled) {
        verifiedSampleCount++;
        sumVerified += Number(r.verifiedPass || 0) ? 1 : 0;
      }

      sumLatency += Number(r.latencyMs || 0);
      const tok = Number(r.inputTokens || 0) + Number(r.outputTokens || 0);
      sumTokens += tok;
      sumCtxUtil += Math.min(1, tok / Math.max(1, Number(r.contextWindow || 128_000)));
      if (Number(r.recovered || 0) === 1 && !rowCancelled) {
        sumRecoveredTotal++;
        if (Number(r.success || 0) === 1) {
          sumRecoveredSucceeded++;
        }
      }

      if (r.failureKind && Object.hasOwn(failureBreakdown, r.failureKind)) {
        failureBreakdown[r.failureKind]++;
      }
    }

    const successRate = nonCancelledCount > 0 ? sumSuccess / nonCancelledCount : null;
    const toolSuccessRate = sumToolTotal > 0 ? Math.min(1, sumToolSuccess / sumToolTotal) : null;
    const verificationPassRate = verifiedSampleCount > 0 ? sumVerified / verifiedSampleCount : null;
    const avgLatencyMs = sumLatency / n;
    const timeoutRate = nonCancelledCount > 0 ? sumTimedOut / nonCancelledCount : 0;
    const avgTokens = sumTokens / n;
    const contextUtilization = sumCtxUtil / n;
    const recoveryRate = sumRecoveredTotal > 0 ? sumRecoveredSucceeded / sumRecoveredTotal : 0;
    const cancellationRate = sumCancelled / n;
    const confidence = Number((n / (n + CONFIDENCE_PRIOR_WEIGHT)).toFixed(4));

    const speedFactor = Math.max(0, 1 - avgLatencyMs / 60_000);
    let weightedSum = 0;
    let totalWeight = 0;
    if (successRate !== null) {
      weightedSum += 0.35 * successRate;
      totalWeight += 0.35;
    }
    if (toolSuccessRate !== null) {
      weightedSum += 0.2 * toolSuccessRate;
      totalWeight += 0.2;
    }
    if (verificationPassRate !== null) {
      weightedSum += 0.2 * verificationPassRate;
      totalWeight += 0.2;
    }
    if (nonCancelledCount > 0) {
      weightedSum += 0.15 * (1 - timeoutRate) + 0.1 * speedFactor;
      totalWeight += 0.25;
    }

    const empiricalScore =
      totalWeight > 0
        ? Number(Math.max(0, Math.min(1, weightedSum / totalWeight)).toFixed(4))
        : null;

    return {
      sampleCount: n,
      confidence,
      empiricalScore,
      metrics: {
        successRate: successRate !== null ? Number(successRate.toFixed(4)) : null,
        toolSuccessRate: toolSuccessRate !== null ? Number(toolSuccessRate.toFixed(4)) : null,
        verificationPassRate:
          verificationPassRate !== null ? Number(verificationPassRate.toFixed(4)) : null,
        verifiedSampleCount,
        toolSampleCount,
        avgLatencyMs: Math.round(avgLatencyMs),
        timeoutRate: Number(timeoutRate.toFixed(4)),
        avgTokens: Math.round(avgTokens),
        contextUtilization: Number(contextUtilization.toFixed(4)),
        recoveryRate: Number(recoveryRate.toFixed(4)),
        cancellationRate: Number(cancellationRate.toFixed(4)),
        failureBreakdown,
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
        verifiedSampleCount: 0,
        toolSampleCount: 0,
        avgLatencyMs: 0,
        timeoutRate: 0,
        avgTokens: 0,
        contextUtilization: 0,
        recoveryRate: 0,
        cancellationRate: 0,
        failureBreakdown: {
          task_failure: 0,
          tool_failure: 0,
          verification_failure: 0,
          timeout: 0,
          cancelled: 0,
          budget: 0,
        },
      },
    };
  }
}
