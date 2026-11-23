import { summarizePromptCache } from './prompt-cache.js';
import { id as uuid } from '../store.js';
import { classifyTrafficSource, getTraceContext } from './trace.js';

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function round4(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return Number(n.toFixed(4));
}

function summarizeDurations(values) {
  if (!values.length) {
    return { count: 0, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pct = (p) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return Math.round(sorted[idx]);
  };
  return {
    count: sorted.length,
    avgMs: Math.round(sum / sorted.length),
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    maxMs: Math.round(sorted[sorted.length - 1]),
  };
}

/**
 * Production Observability & Truthful Telemetry Collector.
 * - Persists lightweight execution telemetry into `runtime_metrics_events`.
 * - Computes all 10 production KPIs strictly separating production vs synthetic traffic
 *   and relying exclusively on deterministic execution/verifier facts (never model self-eval).
 * - Correlates cross-table execution traces chronologically by any correlation ID.
 */
export class MetricsCollector {
  constructor({ store = null } = {}) {
    this.store = store ?? null;
  }

  #dbReady() {
    try {
      return Boolean(this.store?.db?.isOpen);
    } catch {
      return false;
    }
  }

  /**
   * Appends a structured telemetry record to `runtime_metrics_events`, merging active
   * AsyncLocalStorage trace context. Swallows non-fatal DB errors when closed.
   */
  record(kind, fields = {}) {
    if (!kind || !this.#dbReady()) return null;
    try {
      const ctx = getTraceContext();
      const rawFields = fields && typeof fields === 'object' ? fields : {};
      const merged = { ...ctx, ...rawFields };
      const hasExplicitSource =
        rawFields.trafficSource !== undefined || rawFields.source !== undefined;
      const explicitIsSynthetic =
        rawFields.isSynthetic !== undefined
          ? rawFields.isSynthetic
          : hasExplicitSource
            ? undefined
            : ctx.isSynthetic;
      const classified = classifyTrafficSource(
        {
          trafficSource: merged.trafficSource ?? merged.source,
          isSynthetic: explicitIsSynthetic,
        },
        ctx.trafficSource || 'production',
      );
      const rowId = merged.id ? String(merged.id) : uuid();
      const at = Number.isFinite(Number(merged.at)) ? Math.trunc(Number(merged.at)) : Date.now();
      const attempt =
        merged.attempt !== undefined && merged.attempt !== null && Number.isFinite(Number(merged.attempt))
          ? Math.trunc(Number(merged.attempt))
          : null;
      const ok =
        merged.ok === undefined || merged.ok === null ? null : merged.ok ? 1 : 0;
      const durationMs =
        merged.durationMs !== undefined &&
        merged.durationMs !== null &&
        Number.isFinite(Number(merged.durationMs))
          ? Number(merged.durationMs)
          : null;
      const detailJson =
        merged.detail !== undefined && merged.detail !== null
          ? typeof merged.detail === 'string'
            ? merged.detail
            : JSON.stringify(merged.detail)
          : null;

      this.store.tx(() => {
        this.store.db
          .prepare(
            `INSERT INTO runtime_metrics_events(
              id, kind, at, isSynthetic, trafficSource,
              runId, nodeId, sessionId, turnId, jobId, workerId,
              attempt, fence, model, provider, accountId,
              toolCallId, artifactId, ok, durationMs, code, detailJson
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ${kind === 'provider_usage' ? `ON CONFLICT(id) DO UPDATE SET
              ok=excluded.ok, durationMs=excluded.durationMs, detailJson=excluded.detailJson
              WHERE runtime_metrics_events.kind='provider_usage'` : ''}`,
          )
          .run(
            rowId,
            String(kind),
            at,
            classified.isSynthetic ? 1 : 0,
            classified.trafficSource,
            merged.runId ?? null,
            merged.nodeId ?? null,
            merged.sessionId ?? null,
            merged.turnId ?? null,
            merged.jobId ?? null,
            merged.workerId ?? null,
            attempt,
            merged.fence ?? null,
            merged.model ?? null,
            merged.provider ?? null,
            merged.accountId ?? null,
            merged.toolCallId ?? null,
            merged.artifactId ?? null,
            ok,
            durationMs,
            merged.code ? String(merged.code) : null,
            detailJson,
          );
      });
      return rowId;
    } catch {
      return null;
    }
  }

  getTurnProviderUsage(turnId) {
    if (!this.#dbReady()) return null;
    const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheEligibleInputTokens'];
    const row = this.store.db.prepare(`
      SELECT COUNT(*) AS requests, ${fields.map(field => `SUM(json_extract(detailJson, '$.${field}')) AS ${field}`).join(', ')},
             CASE WHEN COUNT(DISTINCT provider)=1 THEN MAX(provider) ELSE NULL END AS provider,
             CASE WHEN COUNT(DISTINCT model)=1 THEN MAX(model) ELSE NULL END AS model
      FROM runtime_metrics_events WHERE kind='provider_usage' AND turnId=?
    `).get(turnId);
    if (!row?.requests) return null;
    const { requests: _requests, ...usage } = row;
    return usage;
  }

  /**
   * Computes all 10 production KPIs strictly from durable runtime/verifier state.
   * Defaults to real production traffic only (`includeSynthetic = false`).
   */
  getProductionMetrics({ windowHours = 24, includeSynthetic = false, now = Date.now(), view } = {}) {
    const hours = Number(windowHours);
    const winHours = Number.isFinite(hours) ? Math.min(720, Math.max(1 / 60, hours || 24)) : 24;
    const sinceMs = now - winHours * 3_600_000;
    const includeSynth = Boolean(includeSynthetic);

    const ready = this.#dbReady();
    const promptCache = summarizePromptCache(ready ? this.store.db.prepare(
      `SELECT provider, model, detailJson FROM runtime_metrics_events
       WHERE kind = 'provider_usage' AND at >= ? AND at <= ? ${includeSynth ? '' : 'AND isSynthetic = 0'}`,
    ).iterate(sinceMs, now) : [], { windowHours: winHours, sinceMs, now, includeSynthetic: includeSynth });
    if (view === 'prompt-cache') return { promptCache };
    if (!ready) {
      return { ...this.#emptyMetrics({ windowHours: winHours, includeSynthetic: includeSynth, sinceMs, now }), promptCache };
    }

    const db = this.store.db;
    const synthWhere = includeSynth ? '' : 'AND isSynthetic = 0';
    const synthWhereAlias = (alias) => (includeSynth ? '' : `AND COALESCE(${alias}.isSynthetic, 0) = 0`);

    // 1. Agent Task Success Rate (deterministic state + EvidenceVerifier verdict ONLY)
    const turnRows = db
      .prepare(
        `SELECT id, state, verdictJson, evidenceCount
         FROM direct_turns
         WHERE createdAt >= ? AND state IN ('completed','failed','cancelled') ${synthWhere}`,
      )
      .all(sinceMs);
    const swarmRows = db
      .prepare(
        `SELECT id, status, verdictJson, createdAt, updatedAt, finishedAt
         FROM swarm_runs
         WHERE createdAt >= ? AND status IN ('completed','failed','cancelled') ${synthWhere}`,
      )
      .all(sinceMs);

    let dtTotal = 0;
    let dtSuccess = 0;
    let dtCancelled = 0;
    let dtUnverified = 0;
    let evTotal = 0;
    let evSuccess = 0;
    let ptTotal = 0;
    let ptSuccess = 0;
    let ptUnverified = 0;
    let unverifiedTotal = 0;

    for (const t of turnRows) {
      if (t.state === 'cancelled') {
        dtCancelled++;
        continue;
      }
      dtTotal++;
      const verdict = parseJsonSafe(t.verdictJson, null);
      const hasVerdict = verdict !== null;
      const verdictOk =
        hasVerdict && verdict.accepted === true && verdict.verdict === 'pass';
      const succeeded = t.state === 'completed' && verdictOk;
      const unverified = !hasVerdict;
      if (succeeded) dtSuccess++;
      if (unverified) {
        dtUnverified++;
        unverifiedTotal++;
      }

      // Plain-text completion is a deliberate verifier path, never an inference
      // from an old row that merely happens to have zero evidence/tool usage.
      const plainText = verdict?.verificationMode === 'plain_text_no_tools';
      const evidenceBacked = !plainText &&
        (verdict?.evidenceRequired === true ||
          (verdict?.verificationMode && verdict.verificationMode !== 'plain_text_no_tools') ||
          Number(t.evidenceCount || 0) > 0);
      if (evidenceBacked) {
        evTotal++;
        if (succeeded) evSuccess++;
      } else if (plainText) {
        ptTotal++;
        if (succeeded) ptSuccess++;
        if (unverified) ptUnverified++;
      }
    }

    let srTotal = 0;
    let srSuccess = 0;
    let srCancelled = 0;
    let srUnverified = 0;
    const swarmCompletedDurs = [];
    const swarmFailedDurs = [];
    const swarmAllDurs = [];

    for (const r of swarmRows) {
      if (r.status === 'cancelled') {
        srCancelled++;
        continue;
      }
      srTotal++;
      const verdict = parseJsonSafe(r.verdictJson, null);
      const hasVerdict = verdict !== null;
      const verdictOk =
        hasVerdict && verdict.accepted === true && verdict.verdict === 'pass';
      const succeeded = r.status === 'completed' && verdictOk;
      if (succeeded) srSuccess++;
      if (!hasVerdict) {
        srUnverified++;
        unverifiedTotal++;
      } else {
        evTotal++;
        if (succeeded) evSuccess++;
      }

      const endTs = Number(r.finishedAt ?? r.updatedAt ?? r.createdAt);
      const dur = Math.max(0, endTs - Number(r.createdAt ?? endTs));
      swarmAllDurs.push(dur);
      if (r.status === 'completed') swarmCompletedDurs.push(dur);
      else swarmFailedDurs.push(dur);
    }

    const totalTasks = dtTotal + srTotal;
    const totalTaskSuccess = dtSuccess + srSuccess;
    const agentTaskSuccessRate = {
      rate: totalTasks > 0 ? round4(totalTaskSuccess / totalTasks) : null,
      succeeded: totalTaskSuccess,
      failed: totalTasks - totalTaskSuccess,
      cancelled: dtCancelled + srCancelled,
      unverified: unverifiedTotal,
      total: totalTasks,
      evidenceBackedSuccessRate: evTotal > 0 ? round4(evSuccess / evTotal) : null,
      evidenceBackedTotal: evTotal,
      plainTextCompletionRate: ptTotal > 0 ? round4(ptSuccess / ptTotal) : null,
      plainTextTotal: ptTotal,
      plainTextUnverified: ptUnverified,
      directTurns: {
        total: dtTotal,
        succeeded: dtSuccess,
        failed: dtTotal - dtSuccess - dtUnverified,
        cancelled: dtCancelled,
        unverified: dtUnverified,
      },
      swarmRuns: {
        total: srTotal,
        succeeded: srSuccess,
        failed: srTotal - srSuccess - srUnverified,
        cancelled: srCancelled,
        unverified: srUnverified,
      },
    };

    // 2. Verification Pass Rate (verifiedPass IS NOT NULL AND cancelled = 0)
    const verRow = db
      .prepare(
        `SELECT
           SUM(CASE WHEN verifiedPass = 1 THEN 1 ELSE 0 END) AS passed,
           SUM(CASE WHEN verifiedPass = 0 THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN verifiedPass IS NULL THEN 1 ELSE 0 END) AS unverified
         FROM model_feedback
         WHERE createdAt >= ? AND cancelled = 0 ${synthWhere}`,
      )
      .get(sinceMs);
    const verPassed = Number(verRow?.passed ?? 0);
    const verFailed = Number(verRow?.failed ?? 0);
    const verTotal = verPassed + verFailed;
    const verificationPassRate = {
      rate: verTotal > 0 ? round4(verPassed / verTotal) : null,
      passed: verPassed,
      failed: verFailed,
      total: verTotal,
      unverifiedCount: Number(verRow?.unverified ?? 0),
    };

    // 3. Tool Failure Rate (durable tool_receipts joined to sessions)
    const receiptRows = db
      .prepare(
        `SELECT tr.status, tr.errorCode
         FROM tool_receipts tr
         LEFT JOIN direct_sessions s ON s.id = tr.sessionId
         WHERE tr.createdAt >= ? ${synthWhereAlias('s')}`,
      )
      .all(sinceMs);
    let toolFinished = 0;
    let toolFailed = 0;
    let toolUnknown = 0;
    let preEffectRejected = 0;
    const failuresByCode = {};
    const rejectionsByCode = {};
    for (const r of receiptRows) {
      if (r.status === 'finished') {
        toolFinished++;
      } else if (r.status === 'failed') {
        toolFailed++;
        const code = r.errorCode || 'TOOL_EXECUTION_ERROR';
        failuresByCode[code] = (failuresByCode[code] || 0) + 1;
      } else if (r.status === 'outcome_unknown') {
        toolUnknown++;
      } else if (r.status === 'rejected_before_effect') {
        preEffectRejected++;
        const code = r.errorCode || 'POLICY_DENIED';
        rejectionsByCode[code] = (rejectionsByCode[code] || 0) + 1;
      }
    }
    const executedTools = toolFinished + toolFailed + toolUnknown;
    const totalAttempts = executedTools + preEffectRejected;
    const toolFailureRate = {
      rate: executedTools > 0 ? round4(toolFailed / executedTools) : null,
      failed: toolFailed,
      finished: toolFinished,
      unknownOutcome: toolUnknown,
      executedTotal: executedTools,
      preEffectRejected,
      preEffectRejectionRate:
        totalAttempts > 0 ? round4(preEffectRejected / totalAttempts) : null,
      failuresByCode,
      rejectionsByCode,
    };

    // 4. Recovery Success Rate (recovered=1 non-cancelled in model_feedback + recovery_attempt events)
    const recFbRow = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN success = 1 AND (verifiedPass IS NULL OR verifiedPass = 1) THEN 1 ELSE 0 END) AS succeeded
         FROM model_feedback
         WHERE createdAt >= ? AND recovered = 1 AND cancelled = 0 ${synthWhere}`,
      )
      .get(sinceMs);
    const recEvRow = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS succeeded
         FROM runtime_metrics_events
         WHERE kind = 'recovery_attempt' AND ok IS NOT NULL AND at >= ? ${synthWhere}`,
      )
      .get(sinceMs);
    const recFbTotal = Number(recFbRow?.total ?? 0);
    const recFbSucc = Number(recFbRow?.succeeded ?? 0);
    const recEvTotal = Number(recEvRow?.total ?? 0);
    const recEvSucc = Number(recEvRow?.succeeded ?? 0);
    const recTotal = recFbTotal + recEvTotal;
    const recSucc = recFbSucc + recEvSucc;
    const recoverySuccessRate = {
      rate: recTotal > 0 ? round4(recSucc / recTotal) : null,
      succeeded: recSucc,
      failed: recTotal - recSucc,
      total: recTotal,
      fromFeedback: {
        succeeded: recFbSucc,
        total: recFbTotal,
        rate: recFbTotal > 0 ? round4(recFbSucc / recFbTotal) : null,
      },
      fromEvents: {
        succeeded: recEvSucc,
        total: recEvTotal,
        rate: recEvTotal > 0 ? round4(recEvSucc / recEvTotal) : null,
      },
    };

    // 5. Duplicate Execution Count (SQL invariants + prevented dedup/fence telemetry)
    const dupNonReplayRow = db
      .prepare(
        `SELECT COALESCE(SUM(cnt - 1), 0) AS dups FROM (
           SELECT COUNT(*) AS cnt
           FROM tool_receipts tr
           LEFT JOIN direct_sessions s ON s.id = tr.sessionId
           WHERE tr.createdAt >= ?
             AND tr.replayable = 0
             AND tr.status IN ('executing','finished','failed','outcome_unknown')
             AND tr.turnId IS NOT NULL
             ${synthWhereAlias('s')}
           GROUP BY tr.turnId, tr.callId
           HAVING COUNT(*) > 1
         )`,
      )
      .get(sinceMs);
    const dupClientTurnRow = db
      .prepare(
        `SELECT COALESCE(SUM(cnt - 1), 0) AS dups FROM (
           SELECT COUNT(*) AS cnt
           FROM direct_turns
           WHERE createdAt >= ? AND clientTurnId IS NOT NULL ${synthWhere}
           GROUP BY clientTurnId
           HAVING COUNT(*) > 1
         )`,
      )
      .get(sinceMs);
    const dupNonReplayableTools = Number(dupNonReplayRow?.dups ?? 0);
    const dupClientTurns = Number(dupClientTurnRow?.dups ?? 0);

    const preventedRows = db
      .prepare(
        `SELECT kind, COUNT(*) AS n
         FROM runtime_metrics_events
         WHERE at >= ?
           AND kind IN ('lease_lost_fenced','job_idem_dedup','schedule_idem_dedup','turn_idem_dedup')
           ${synthWhere}
         GROUP BY kind`,
      )
      .all(sinceMs);
    const preventedMap = {
      lease_lost_fenced: 0,
      job_idem_dedup: 0,
      schedule_idem_dedup: 0,
      turn_idem_dedup: 0,
    };
    for (const r of preventedRows) {
      preventedMap[r.kind] = Number(r.n ?? 0);
    }
    const preventedTotal =
      preventedMap.lease_lost_fenced +
      preventedMap.job_idem_dedup +
      preventedMap.schedule_idem_dedup +
      preventedMap.turn_idem_dedup;

    const duplicateExecutionCount = {
      actualDuplicateExecutions: dupNonReplayableTools + dupClientTurns,
      duplicateNonReplayableTools: dupNonReplayableTools,
      duplicateClientTurns: dupClientTurns,
      preventedDuplicates: preventedTotal,
      preventedByKind: preventedMap,
    };

    // 6. Reconciliation Count
    const recApprRows = db
      .prepare(
        `SELECT a.status, a.outcome, COUNT(*) AS n
         FROM direct_approvals a
         LEFT JOIN direct_sessions s ON s.id = a.sessionId
         WHERE a.kind = 'reconciliation' AND a.createdAt >= ? ${synthWhereAlias('s')}
         GROUP BY a.status, a.outcome`,
      )
      .all(sinceMs);
    const approvalsRec = {
      total: 0,
      pending: 0,
      happened: 0,
      notApplied: 0,
      abort: 0,
      expired: 0,
    };
    for (const r of recApprRows) {
      const n = Number(r.n ?? 0);
      approvalsRec.total += n;
      if (r.status === 'pending') approvalsRec.pending += n;
      else if (r.status === 'expired') approvalsRec.expired += n;
      else if (r.outcome === 'happened') approvalsRec.happened += n;
      else if (r.outcome === 'not_applied') approvalsRec.notApplied += n;
      else if (r.outcome === 'abort') approvalsRec.abort += n;
    }

    const recReceiptRow = db
      .prepare(
        `SELECT
           SUM(CASE WHEN tr.status = 'outcome_unknown' THEN 1 ELSE 0 END) AS pendingUnknown,
           SUM(CASE WHEN tr.reconciliationOutcome IS NOT NULL THEN 1 ELSE 0 END) AS reconciledTotal
         FROM tool_receipts tr
         LEFT JOIN direct_sessions s ON s.id = tr.sessionId
         WHERE tr.createdAt >= ?
           AND (tr.status = 'outcome_unknown' OR tr.reconciliationOutcome IS NOT NULL)
           ${synthWhereAlias('s')}`,
      )
      .get(sinceMs);

    const budgetRecCount = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM budget_reservations br
           LEFT JOIN budget_ledgers bl ON bl.treeId = br.treeId
           WHERE br.status = 'reconciled' AND br.updatedAt >= ? ${synthWhereAlias('bl')}`,
        )
        .get(sinceMs)?.n ?? 0,
    );

    const schedRecRows = db
      .prepare(
        `SELECT detailJson
         FROM runtime_metrics_events
         WHERE kind = 'scheduler_reconcile' AND at >= ? ${synthWhere}`,
      )
      .all(sinceMs);
    let schedConverged = 0;
    let schedRepaired = 0;
    let schedAttached = 0;
    for (const r of schedRecRows) {
      const d = parseJsonSafe(r.detailJson, {});
      schedConverged += Number(d?.converged ?? 0);
      schedRepaired += Number(d?.repaired ?? 0);
      schedAttached += Number(d?.attached ?? 0);
    }

    const reconciliationCount = {
      total: approvalsRec.total + budgetRecCount + schedRecRows.length,
      approvals: approvalsRec,
      unknownReceipts: {
        pendingUnknown: Number(recReceiptRow?.pendingUnknown ?? 0),
        reconciledTotal: Number(recReceiptRow?.reconciledTotal ?? 0),
      },
      budgetReconciled: budgetRecCount,
      schedulerReconcile: {
        events: schedRecRows.length,
        converged: schedConverged,
        repaired: schedRepaired,
        attached: schedAttached,
      },
    };

    // 7. Swarm Completion Time
    const swarmCompletionTime = {
      ...summarizeDurations(swarmAllDurs),
      completed: summarizeDurations(swarmCompletedDurs),
      failed: summarizeDurations(swarmFailedDurs),
    };

    // 8. Average Token Usage
    const usageRow = db
      .prepare(
        `SELECT
           COUNT(*) AS sampleCount,
           COALESCE(SUM(inputTokens), 0) AS sumIn,
           COALESCE(SUM(outputTokens), 0) AS sumOut,
           COALESCE(SUM(tokens), 0) AS sumTotal
         FROM nexus_usage
         WHERE createdAt >= ? ${synthWhere}`,
      )
      .get(sinceMs);
    const usageSamples = Number(usageRow?.sampleCount ?? 0);
    const sumIn = Number(usageRow?.sumIn ?? 0);
    const sumOut = Number(usageRow?.sumOut ?? 0);
    const sumTotal = Number(usageRow?.sumTotal ?? 0);

    // Retain the old field for historical windows with a recorded positive hit.
    // Unknown legacy samples never participate in the new denominator or UI.
    const legacyCache = promptCache.global.requests ? null : db.prepare(`
      SELECT SUM(CAST(json_extract(de.data, '$.cacheReadTokens') AS INTEGER)) AS reads,
             SUM(CAST(json_extract(de.data, '$.inputTokens') AS INTEGER)) AS inputs
      FROM direct_events de LEFT JOIN direct_sessions s ON s.id = de.sessionId
      WHERE de.type = 'turn/completed' AND de.at >= ? AND de.at <= ?
        AND json_valid(de.data) AND json_extract(de.data, '$.cacheEligibleInputTokens') IS NULL
        AND json_extract(de.data, '$.inputTokens') > 0 AND json_extract(de.data, '$.cacheReadTokens') > 0
        ${synthWhereAlias('s')}
    `).get(sinceMs, now);
    const legacyRatio = legacyCache?.inputs ? round4(Math.min(1, legacyCache.reads / legacyCache.inputs)) : null;
    const averageTokenUsage = {
      sampleCount: usageSamples,
      avgInputTokens: usageSamples > 0 ? Math.round(sumIn / usageSamples) : null,
      avgOutputTokens: usageSamples > 0 ? Math.round(sumOut / usageSamples) : null,
      avgTotalTokens: usageSamples > 0 ? Math.round(sumTotal / usageSamples) : null,
      totalInputTokens: sumIn,
      totalOutputTokens: sumOut,
      totalTokens: sumTotal,
      cacheReadRatio: round4(promptCache.global.hitRate) ?? legacyRatio,
      cacheReadRatioSource: promptCache.global.hitRate != null ? 'provider' : legacyRatio != null ? 'legacy' : null,
    };

    // 9. Budget Overrun
    const budgetRow = db
      .prepare(
        `SELECT
           COUNT(*) AS totalTrees,
           SUM(CASE WHEN overageSteps > 0 OR overageTokens > 0 THEN 1 ELSE 0 END) AS overrunTreeCount,
           COALESCE(SUM(overageTokens), 0) AS totalOverageTokens,
           COALESCE(SUM(overageSteps), 0) AS totalOverageSteps,
           AVG(estimationErrorTokens) AS avgEstimationErrorTokens,
           SUM(CASE WHEN exhausted = 1 THEN 1 ELSE 0 END) AS exhaustedCount
         FROM budget_ledgers
         WHERE createdAt >= ? ${synthWhere}`,
      )
      .get(sinceMs);
    const exhaustedReasonRows = db
      .prepare(
        `SELECT COALESCE(exhaustedReason, 'UNKNOWN') AS reason, COUNT(*) AS n
         FROM budget_ledgers
         WHERE createdAt >= ? AND exhausted = 1 ${synthWhere}
         GROUP BY COALESCE(exhaustedReason, 'UNKNOWN')`,
      )
      .all(sinceMs);
    const exhaustedByReason = {};
    for (const r of exhaustedReasonRows) {
      exhaustedByReason[r.reason] = Number(r.n ?? 0);
    }
    const stepBudgetTurns = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM direct_turns
           WHERE createdAt >= ? AND state = 'failed'
             AND (error LIKE '%STEP_BUDGET%' OR verdictJson LIKE '%STEP_BUDGET_EXHAUSTED%')
             ${synthWhere}`,
        )
        .get(sinceMs)?.n ?? 0,
    );
    const totalTrees = Number(budgetRow?.totalTrees ?? 0);
    const overrunTreeCount = Number(budgetRow?.overrunTreeCount ?? 0);
    const budgetOverrun = {
      totalTrees,
      overrunTreeCount,
      overrunRate: totalTrees > 0 ? round4(overrunTreeCount / totalTrees) : null,
      totalOverageTokens: Number(budgetRow?.totalOverageTokens ?? 0),
      totalOverageSteps: Number(budgetRow?.totalOverageSteps ?? 0),
      avgEstimationErrorTokens:
        totalTrees > 0 && budgetRow?.avgEstimationErrorTokens !== null
          ? Math.round(Number(budgetRow.avgEstimationErrorTokens))
          : null,
      exhaustedCount: Number(budgetRow?.exhaustedCount ?? 0),
      exhaustedByReason,
      stepBudgetExhaustedTurns: stepBudgetTurns,
    };

    // 10. Model Routing Success Rate
    const routeRows = db
      .prepare(
        `SELECT provider, model, attempt, ok, code, detailJson
         FROM runtime_metrics_events
         WHERE kind = 'model_route' AND at >= ? ${synthWhere}`,
      )
      .all(sinceMs);
    let routeTotal = 0;
    let routeOverallOk = 0;
    let routePrimaryOk = 0;
    let routeFailoverOk = 0;
    let cooldownRejections = 0;
    let exhaustedRoutes = 0;
    const byProvider = {};

    for (const r of routeRows) {
      const detail = parseJsonSafe(r.detailJson, {});
      const ok = Number(r.ok ?? 0) === 1;
      const failovers =
        detail?.failovers !== undefined
          ? Math.max(0, Number(detail.failovers || 0))
          : r.attempt !== null && r.attempt !== undefined
            ? Math.max(0, Number(r.attempt) - 1)
            : 0;
      const primaryOk =
        ok && (detail?.primaryOk !== undefined ? Boolean(detail.primaryOk) : failovers === 0);

      routeTotal++;
      if (ok) {
        routeOverallOk++;
        if (primaryOk) routePrimaryOk++;
        else routeFailoverOk++;
      }
      if (
        r.code === 'RATE_LIMITED' ||
        r.code === 'COOLDOWN' ||
        detail?.cooldownRejected === true
      ) {
        cooldownRejections++;
      }
      if (Number(detail?.cooldownSkipped || 0) > 0) {
        cooldownRejections += Number(detail.cooldownSkipped);
      }
      if (
        !ok &&
        (r.code === 'PROVIDER_UNAVAILABLE' ||
          r.code === 'NO_AVAILABLE_PROVIDER' ||
          detail?.exhausted === true)
      ) {
        exhaustedRoutes++;
      }

      const provKey = r.provider || 'unknown';
      if (!byProvider[provKey]) {
        byProvider[provKey] = {
          total: 0,
          succeeded: 0,
          primarySucceeded: 0,
          failovers: 0,
          overallSuccessRate: null,
          primarySuccessRate: null,
        };
      }
      const pStats = byProvider[provKey];
      pStats.total++;
      if (ok) {
        pStats.succeeded++;
        if (primaryOk) pStats.primarySucceeded++;
        else pStats.failovers++;
      }
    }
    for (const pStats of Object.values(byProvider)) {
      pStats.overallSuccessRate =
        pStats.total > 0 ? round4(pStats.succeeded / pStats.total) : null;
      pStats.primarySuccessRate =
        pStats.total > 0 ? round4(pStats.primarySucceeded / pStats.total) : null;
    }

    const modelRoutingSuccessRate = {
      totalRequests: routeTotal,
      primarySuccessRate: routeTotal > 0 ? round4(routePrimaryOk / routeTotal) : null,
      overallSuccessRate: routeTotal > 0 ? round4(routeOverallOk / routeTotal) : null,
      failoverRate: routeTotal > 0 ? round4(routeFailoverOk / routeTotal) : null,
      cooldownRejections,
      exhaustedCount: exhaustedRoutes,
      byProvider,
    };

    // Traffic Breakdown (always reports both production & synthetic counts in the window)
    const countSplit = (table, tsCol) => {
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN isSynthetic = 0 THEN 1 ELSE 0 END) AS prod,
             SUM(CASE WHEN isSynthetic != 0 THEN 1 ELSE 0 END) AS synth
           FROM ${table}
           WHERE ${tsCol} >= ?`,
        )
        .get(sinceMs);
      return { prod: Number(row?.prod ?? 0), synth: Number(row?.synth ?? 0) };
    };
    const tSplit = countSplit('direct_turns', 'createdAt');
    const sSplit = countSplit('swarm_runs', 'createdAt');
    const fSplit = countSplit('model_feedback', 'createdAt');
    const mSplit = countSplit('runtime_metrics_events', 'at');

    const trafficBreakdown = {
      productionCount: tSplit.prod + sSplit.prod + fSplit.prod + mSplit.prod,
      syntheticCount: tSplit.synth + sSplit.synth + fSplit.synth + mSplit.synth,
      includeSynthetic: includeSynth,
      windowHours: winHours,
      sinceMs,
      asOfMs: now,
      byTable: {
        directTurns: tSplit,
        swarmRuns: sSplit,
        modelFeedback: fSplit,
        metricsEvents: mSplit,
      },
    };

    return {
      agentTaskSuccessRate,
      verificationPassRate,
      toolFailureRate,
      recoverySuccessRate,
      duplicateExecutionCount,
      reconciliationCount,
      swarmCompletionTime,
      averageTokenUsage,
      promptCache,
      budgetOverrun,
      modelRoutingSuccessRate,
      trafficBreakdown,
    };
  }

  /**
   * Correlates execution timeline entries chronologically across direct_events,
   * tool_receipts, runtime_checkpoints, runtime_jobs, swarm_artifacts,
   * budget_reservations, and runtime_metrics_events.
   */
  queryTraces({
    runId = null,
    nodeId = null,
    sessionId = null,
    turnId = null,
    jobId = null,
    toolCallId = null,
    artifactId = null,
    limit = 200,
  } = {}) {
    if (!this.#dbReady()) return [];
    const db = this.store.db;
    const cap = Math.min(1000, Math.max(1, Number(limit || 200)));
    const hasFilter = Boolean(
      runId || nodeId || sessionId || turnId || jobId || toolCallId || artifactId,
    );
    const entries = [];

    const matchesFilter = (entry) => {
      if (runId && entry.runId !== runId) return false;
      if (nodeId && entry.nodeId !== nodeId) return false;
      if (sessionId && entry.sessionId !== sessionId) return false;
      if (turnId && entry.turnId !== turnId) return false;
      if (jobId && entry.jobId !== jobId) return false;
      if (toolCallId && entry.toolCallId !== toolCallId) return false;
      if (artifactId && entry.artifactId !== artifactId) return false;
      return true;
    };

    // 1. runtime_metrics_events (indexed on all correlation dimensions)
    {
      const where = [];
      const params = [];
      for (const [col, val] of [
        ['runId', runId],
        ['nodeId', nodeId],
        ['sessionId', sessionId],
        ['turnId', turnId],
        ['jobId', jobId],
        ['toolCallId', toolCallId],
        ['artifactId', artifactId],
      ]) {
        if (val) {
          where.push(`${col} = ?`);
          params.push(String(val));
        }
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM runtime_metrics_events ${clause} ORDER BY at ASC LIMIT ?`)
        .all(...params, cap);
      for (const r of rows) {
        entries.push({
          source: 'runtime_metrics_events',
          id: r.id,
          at: r.at,
          kind: r.kind,
          runId: r.runId ?? null,
          nodeId: r.nodeId ?? null,
          sessionId: r.sessionId ?? null,
          turnId: r.turnId ?? null,
          jobId: r.jobId ?? null,
          workerId: r.workerId ?? null,
          attempt: r.attempt ?? null,
          fence: r.fence ?? null,
          model: r.model ?? null,
          provider: r.provider ?? null,
          toolCallId: r.toolCallId ?? null,
          artifactId: r.artifactId ?? null,
          status: r.ok === 1 ? 'ok' : r.ok === 0 ? 'failed' : null,
          data: {
            code: r.code ?? null,
            durationMs: r.durationMs ?? null,
            isSynthetic: Boolean(r.isSynthetic),
            trafficSource: r.trafficSource,
            detail: parseJsonSafe(r.detailJson, null),
          },
        });
      }
    }

    // Resolve linked turnIds & dedicated child sessionIds for runId/nodeId BEFORE querying
    // direct_events, tool_receipts, runtime_checkpoints & runtime_jobs so SQL predicates stay tight.
    const linkedRunTurnIds = new Set();
    const linkedRunChildSessionIds = new Set();
    if (runId) {
      const runRow = db
        .prepare('SELECT rootTurnId FROM swarm_runs WHERE id = ?')
        .get(String(runId));
      if (runRow?.rootTurnId) linkedRunTurnIds.add(runRow.rootTurnId);
      const nodeRows = db
        .prepare('SELECT childSessionId, childTurnId FROM swarm_nodes WHERE runId = ?')
        .all(String(runId));
      for (const nr of nodeRows) {
        if (nr.childSessionId) linkedRunChildSessionIds.add(nr.childSessionId);
        if (nr.childTurnId) linkedRunTurnIds.add(nr.childTurnId);
      }
    }
    const linkedNodeTurnIds = new Set();
    const linkedNodeChildSessionIds = new Set();
    if (nodeId) {
      const nodeRow = db
        .prepare('SELECT childSessionId, childTurnId FROM swarm_nodes WHERE id = ?')
        .get(String(nodeId));
      if (nodeRow?.childSessionId) linkedNodeChildSessionIds.add(nodeRow.childSessionId);
      if (nodeRow?.childTurnId) linkedNodeTurnIds.add(nodeRow.childTurnId);
    }

    // 2. direct_events
    if (!hasFilter || sessionId || turnId || runId || nodeId || toolCallId || artifactId || jobId) {
      const where = [];
      const params = [];
      if (sessionId) {
        where.push('sessionId = ?');
        params.push(String(sessionId));
      }
      if (turnId) {
        where.push('turnId = ?');
        params.push(String(turnId));
      }
      if (runId) {
        const runOr = ['instr(data, ?) > 0'];
        params.push(String(runId));
        if (linkedRunTurnIds.size > 0) {
          const ph = [...linkedRunTurnIds].map(() => '?').join(',');
          runOr.push(`turnId IN (${ph})`);
          params.push(...linkedRunTurnIds);
        }
        if (linkedRunChildSessionIds.size > 0) {
          const ph = [...linkedRunChildSessionIds].map(() => '?').join(',');
          runOr.push(`sessionId IN (${ph})`);
          params.push(...linkedRunChildSessionIds);
        }
        where.push(`(${runOr.join(' OR ')})`);
      }
      if (nodeId) {
        const nodeOr = ['instr(data, ?) > 0'];
        params.push(String(nodeId));
        if (linkedNodeTurnIds.size > 0) {
          const ph = [...linkedNodeTurnIds].map(() => '?').join(',');
          nodeOr.push(`turnId IN (${ph})`);
          params.push(...linkedNodeTurnIds);
        }
        if (linkedNodeChildSessionIds.size > 0) {
          const ph = [...linkedNodeChildSessionIds].map(() => '?').join(',');
          nodeOr.push(`sessionId IN (${ph})`);
          params.push(...linkedNodeChildSessionIds);
        }
        where.push(`(${nodeOr.join(' OR ')})`);
      }
      for (const jsonNeedle of [jobId, toolCallId, artifactId]) {
        if (jsonNeedle) {
          where.push('instr(data, ?) > 0');
          params.push(String(jsonNeedle));
        }
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM direct_events ${clause} ORDER BY at ASC, seq ASC LIMIT ?`)
        .all(...params, cap * 2);
      for (const r of rows) {
        const data = parseJsonSafe(r.data, {});
        const trace = data?._trace ?? {};
        const inferredRunId =
          data?.runId ??
          trace.runId ??
          (runId &&
          ((r.turnId && linkedRunTurnIds.has(r.turnId)) ||
            (r.sessionId && linkedRunChildSessionIds.has(r.sessionId)))
            ? String(runId)
            : null);
        const inferredNodeId =
          data?.nodeId ??
          trace.nodeId ??
          (nodeId &&
          ((r.turnId && linkedNodeTurnIds.has(r.turnId)) ||
            (r.sessionId && linkedNodeChildSessionIds.has(r.sessionId)))
            ? String(nodeId)
            : null);
        const item = {
          source: 'direct_events',
          id: String(r.seq),
          at: r.at,
          kind: r.type,
          runId: inferredRunId,
          nodeId: inferredNodeId,
          sessionId: r.sessionId ?? trace.sessionId ?? null,
          turnId: r.turnId ?? trace.turnId ?? null,
          jobId: data?.jobId ?? trace.jobId ?? null,
          workerId: data?.workerId ?? trace.workerId ?? null,
          attempt: data?.attempt ?? trace.attempt ?? null,
          fence: data?.fence ?? trace.fence ?? null,
          model: data?.model ?? trace.model ?? null,
          provider: data?.provider ?? trace.provider ?? null,
          toolCallId: data?.callId ?? data?.toolCallId ?? trace.toolCallId ?? null,
          artifactId: data?.artifactId ?? trace.artifactId ?? null,
          status: data?.status ?? null,
          data,
        };
        if (matchesFilter(item)) entries.push(item);
      }
    }

    // 3. tool_receipts
    if (!hasFilter || sessionId || turnId || runId || nodeId || toolCallId) {
      const where = [];
      const params = [];
      if (sessionId) {
        where.push('sessionId = ?');
        params.push(String(sessionId));
      }
      if (turnId) {
        where.push('turnId = ?');
        params.push(String(turnId));
      }
      if (runId) {
        if (linkedRunTurnIds.size > 0) {
          const ph = [...linkedRunTurnIds].map(() => '?').join(',');
          where.push(`(taskId = ? OR turnId IN (${ph}))`);
          params.push(String(runId), ...linkedRunTurnIds);
        } else {
          where.push('taskId = ?');
          params.push(String(runId));
        }
      }
      if (nodeId) {
        if (linkedNodeTurnIds.size > 0) {
          const ph = [...linkedNodeTurnIds].map(() => '?').join(',');
          where.push(`turnId IN (${ph})`);
          params.push(...linkedNodeTurnIds);
        } else {
          where.push('1 = 0');
        }
      }
      if (toolCallId) {
        where.push('callId = ?');
        params.push(String(toolCallId));
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM tool_receipts ${clause} ORDER BY createdAt ASC LIMIT ?`)
        .all(...params, cap);
      for (const r of rows) {
        const inferredRunId =
          r.taskId ?? (runId && linkedRunTurnIds.has(r.turnId) ? String(runId) : null);
        const inferredNodeId =
          nodeId && linkedNodeTurnIds.has(r.turnId) ? String(nodeId) : null;
        const item = {
          source: 'tool_receipts',
          id: r.id,
          at: r.createdAt,
          kind: `tool:${r.toolName}`,
          runId: inferredRunId,
          nodeId: inferredNodeId,
          sessionId: r.sessionId ?? null,
          turnId: r.turnId ?? null,
          jobId: null,
          workerId: null,
          attempt: null,
          fence: null,
          model: null,
          provider: null,
          toolCallId: r.callId ?? null,
          artifactId: null,
          status: r.status,
          data: {
            toolName: r.toolName,
            riskLevel: r.riskLevel,
            effectClass: r.effectClass,
            replayable: Boolean(r.replayable),
            outward: Boolean(r.outward),
            exitCode: r.exitCode,
            durationMs: r.durationMs,
            errorCode: r.errorCode,
            reconciliationOutcome: r.reconciliationOutcome,
          },
        };
        if (matchesFilter(item)) entries.push(item);
      }
    }

    // 4. runtime_checkpoints
    if (!hasFilter || sessionId || turnId || runId || nodeId || jobId) {
      const where = [];
      const params = [];
      if (sessionId) {
        where.push('sessionId = ?');
        params.push(String(sessionId));
      }
      if (turnId) {
        where.push('turnId = ?');
        params.push(String(turnId));
      }
      if (runId) {
        const runOr = ['instr(stateJson, ?) > 0'];
        params.push(String(runId));
        if (linkedRunTurnIds.size > 0) {
          const ph = [...linkedRunTurnIds].map(() => '?').join(',');
          runOr.push(`turnId IN (${ph})`);
          params.push(...linkedRunTurnIds);
        }
        if (linkedRunChildSessionIds.size > 0) {
          const ph = [...linkedRunChildSessionIds].map(() => '?').join(',');
          runOr.push(`sessionId IN (${ph})`);
          params.push(...linkedRunChildSessionIds);
        }
        where.push(`(${runOr.join(' OR ')})`);
      }
      if (nodeId) {
        const nodeOr = ['instr(stateJson, ?) > 0'];
        params.push(String(nodeId));
        if (linkedNodeTurnIds.size > 0) {
          const ph = [...linkedNodeTurnIds].map(() => '?').join(',');
          nodeOr.push(`turnId IN (${ph})`);
          params.push(...linkedNodeTurnIds);
        }
        if (linkedNodeChildSessionIds.size > 0) {
          const ph = [...linkedNodeChildSessionIds].map(() => '?').join(',');
          nodeOr.push(`sessionId IN (${ph})`);
          params.push(...linkedNodeChildSessionIds);
        }
        where.push(`(${nodeOr.join(' OR ')})`);
      }
      if (jobId) {
        where.push('instr(stateJson, ?) > 0');
        params.push(String(jobId));
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM runtime_checkpoints ${clause} ORDER BY createdAt ASC LIMIT ?`)
        .all(...params, cap * 2);
      for (const r of rows) {
        const state = parseJsonSafe(r.stateJson, {});
        const inferredRunId =
          state?.runId ??
          (runId &&
          ((r.turnId && linkedRunTurnIds.has(r.turnId)) ||
            (r.sessionId && linkedRunChildSessionIds.has(r.sessionId)))
            ? String(runId)
            : null);
        const inferredNodeId =
          state?.nodeId ??
          (nodeId &&
          ((r.turnId && linkedNodeTurnIds.has(r.turnId)) ||
            (r.sessionId && linkedNodeChildSessionIds.has(r.sessionId)))
            ? String(nodeId)
            : null);
        const item = {
          source: 'runtime_checkpoints',
          id: r.id,
          at: r.createdAt,
          kind: `checkpoint:${r.phase}`,
          runId: inferredRunId,
          nodeId: inferredNodeId,
          sessionId: r.sessionId ?? null,
          turnId: r.turnId ?? null,
          jobId: state?.jobId ?? null,
          workerId: state?.workerId ?? null,
          attempt: null,
          fence: null,
          model: state?.model ?? null,
          provider: null,
          toolCallId: null,
          artifactId: null,
          status: r.phase,
          data: { step: r.step, phase: r.phase, state },
        };
        if (matchesFilter(item)) entries.push(item);
      }
    }

    // 5. runtime_jobs
    if (!hasFilter || jobId || sessionId || turnId || runId || nodeId) {
      const where = [];
      const params = [];
      if (jobId) {
        where.push('id = ?');
        params.push(String(jobId));
      }
      if (sessionId) {
        where.push('sessionId = ?');
        params.push(String(sessionId));
      }
      if (turnId) {
        where.push('turnId = ?');
        params.push(String(turnId));
      }
      if (runId) {
        const runOr = ['taskId = ?', 'instr(payload, ?) > 0'];
        params.push(String(runId), String(runId));
        if (linkedRunTurnIds.size > 0) {
          const ph = [...linkedRunTurnIds].map(() => '?').join(',');
          runOr.push(`turnId IN (${ph})`);
          params.push(...linkedRunTurnIds);
        }
        where.push(`(${runOr.join(' OR ')})`);
      }
      if (nodeId) {
        const nodeOr = ['instr(payload, ?) > 0'];
        params.push(String(nodeId));
        if (linkedNodeTurnIds.size > 0) {
          const ph = [...linkedNodeTurnIds].map(() => '?').join(',');
          nodeOr.push(`turnId IN (${ph})`);
          params.push(...linkedNodeTurnIds);
        }
        where.push(`(${nodeOr.join(' OR ')})`);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM runtime_jobs ${clause} ORDER BY createdAt ASC LIMIT ?`)
        .all(...params, cap);
      for (const r of rows) {
        const payload = parseJsonSafe(r.payload, {});
        const inferredRunId =
          r.taskId ??
          payload?.runId ??
          (runId && r.turnId && linkedRunTurnIds.has(r.turnId) ? String(runId) : null);
        const inferredNodeId =
          payload?.nodeId ??
          (nodeId && r.turnId && linkedNodeTurnIds.has(r.turnId) ? String(nodeId) : null);
        const item = {
          source: 'runtime_jobs',
          id: r.id,
          at: r.createdAt,
          kind: `job:${r.kind}`,
          runId: inferredRunId,
          nodeId: inferredNodeId,
          sessionId: r.sessionId ?? payload?.sessionId ?? null,
          turnId: r.turnId ?? payload?.turnId ?? null,
          jobId: r.id,
          workerId: r.workerId ?? null,
          attempt: r.attempts ?? null,
          fence: r.fence ?? null,
          model: payload?.model ?? null,
          provider: null,
          toolCallId: null,
          artifactId: null,
          status: r.status,
          data: {
            kind: r.kind,
            attempts: r.attempts,
            maxAttempts: r.maxAttempts,
            errorCode: r.errorCode,
            errorMessage: r.errorMessage,
          },
        };
        if (matchesFilter(item)) entries.push(item);
      }
    }

    // 6. swarm_artifacts
    if (!hasFilter || artifactId || runId || nodeId || sessionId || turnId || jobId) {
      const where = [];
      const params = [];
      if (artifactId) {
        where.push('id = ?');
        params.push(String(artifactId));
      }
      if (runId) {
        where.push('runId = ?');
        params.push(String(runId));
      }
      if (nodeId) {
        where.push('nodeId = ?');
        params.push(String(nodeId));
      }
      if (sessionId) {
        where.push('childSessionId = ?');
        params.push(String(sessionId));
      }
      if (turnId) {
        where.push('childTurnId = ?');
        params.push(String(turnId));
      }
      if (jobId) {
        where.push('jobId = ?');
        params.push(String(jobId));
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM swarm_artifacts ${clause} ORDER BY createdAt ASC LIMIT ?`)
        .all(...params, cap);
      for (const r of rows) {
        const item = {
          source: 'swarm_artifacts',
          id: r.id,
          at: r.createdAt,
          kind: `artifact:${r.status}`,
          runId: r.runId,
          nodeId: r.nodeId,
          sessionId: r.childSessionId ?? null,
          turnId: r.childTurnId ?? null,
          jobId: r.jobId ?? null,
          workerId: null,
          attempt: r.attempt ?? null,
          fence: r.fence ?? null,
          model: null,
          provider: null,
          toolCallId: null,
          artifactId: r.id,
          status: r.status,
          data: {
            uri: r.uri,
            nodeKey: r.nodeKey,
            fileCount: r.fileCount,
            totalBytes: r.totalBytes,
            bundleSha256: r.bundleSha256,
            appliedAt: r.appliedAt,
          },
        };
        if (matchesFilter(item)) entries.push(item);
      }
    }

    // 7. budget_reservations
    if (!hasFilter || runId || nodeId || sessionId || turnId || jobId) {
      const where = [];
      const params = [];
      if (runId) {
        where.push('treeId = ?');
        params.push(String(runId));
      }
      if (nodeId) {
        where.push('nodeId = ?');
        params.push(String(nodeId));
      }
      if (sessionId) {
        where.push('sessionId = ?');
        params.push(String(sessionId));
      }
      if (turnId) {
        where.push('turnId = ?');
        params.push(String(turnId));
      }
      if (jobId) {
        where.push('jobId = ?');
        params.push(String(jobId));
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM budget_reservations ${clause} ORDER BY createdAt ASC LIMIT ?`)
        .all(...params, cap);
      for (const r of rows) {
        const item = {
          source: 'budget_reservations',
          id: r.id,
          at: r.createdAt,
          kind: `budget:${r.scope}`,
          runId: r.treeId ?? null,
          nodeId: r.nodeId ?? null,
          sessionId: r.sessionId ?? null,
          turnId: r.turnId ?? null,
          jobId: r.jobId ?? null,
          workerId: null,
          attempt: r.attempt ?? null,
          fence: r.fence ?? null,
          model: null,
          provider: null,
          toolCallId: null,
          artifactId: null,
          status: r.status,
          data: {
            scope: r.scope,
            nodeKey: r.nodeKey,
            reservedTotalTokens: r.reservedTotalTokens,
            actualInputTokens: r.actualInputTokens,
            actualOutputTokens: r.actualOutputTokens,
            overageTokens: r.overageTokens,
            errorCode: r.errorCode,
          },
        };
        if (matchesFilter(item)) entries.push(item);
      }
    }

    entries.sort(
      (a, b) =>
        Number(a.at ?? 0) - Number(b.at ?? 0) ||
        a.source.localeCompare(b.source) ||
        String(a.id).localeCompare(String(b.id)),
    );
    return entries.slice(0, cap);
  }

  #emptyMetrics({ windowHours, includeSynthetic, sinceMs, now }) {
    return {
      agentTaskSuccessRate: {
        rate: null,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        unverified: 0,
        total: 0,
        evidenceBackedSuccessRate: null,
        evidenceBackedTotal: 0,
        plainTextCompletionRate: null,
        plainTextTotal: 0,
        plainTextUnverified: 0,
        directTurns: { total: 0, succeeded: 0, failed: 0, cancelled: 0, unverified: 0 },
        swarmRuns: { total: 0, succeeded: 0, failed: 0, cancelled: 0, unverified: 0 },
      },
      verificationPassRate: { rate: null, passed: 0, failed: 0, total: 0, unverifiedCount: 0 },
      toolFailureRate: {
        rate: null,
        failed: 0,
        finished: 0,
        unknownOutcome: 0,
        executedTotal: 0,
        preEffectRejected: 0,
        preEffectRejectionRate: null,
        failuresByCode: {},
        rejectionsByCode: {},
      },
      recoverySuccessRate: {
        rate: null,
        succeeded: 0,
        failed: 0,
        total: 0,
        fromFeedback: { succeeded: 0, total: 0, rate: null },
        fromEvents: { succeeded: 0, total: 0, rate: null },
      },
      duplicateExecutionCount: {
        actualDuplicateExecutions: 0,
        duplicateNonReplayableTools: 0,
        duplicateClientTurns: 0,
        preventedDuplicates: 0,
        preventedByKind: {
          lease_lost_fenced: 0,
          job_idem_dedup: 0,
          schedule_idem_dedup: 0,
          turn_idem_dedup: 0,
        },
      },
      reconciliationCount: {
        total: 0,
        approvals: { total: 0, pending: 0, happened: 0, notApplied: 0, abort: 0, expired: 0 },
        unknownReceipts: { pendingUnknown: 0, reconciledTotal: 0 },
        budgetReconciled: 0,
        schedulerReconcile: { events: 0, converged: 0, repaired: 0, attached: 0 },
      },
      swarmCompletionTime: {
        count: 0,
        avgMs: null,
        p50Ms: null,
        p95Ms: null,
        maxMs: null,
        completed: { count: 0, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
        failed: { count: 0, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
      },
      averageTokenUsage: {
        sampleCount: 0,
        avgInputTokens: null,
        avgOutputTokens: null,
        avgTotalTokens: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        cacheReadRatio: null,
      },
      budgetOverrun: {
        totalTrees: 0,
        overrunTreeCount: 0,
        overrunRate: null,
        totalOverageTokens: 0,
        totalOverageSteps: 0,
        avgEstimationErrorTokens: null,
        exhaustedCount: 0,
        exhaustedByReason: {},
        stepBudgetExhaustedTurns: 0,
      },
      modelRoutingSuccessRate: {
        totalRequests: 0,
        primarySuccessRate: null,
        overallSuccessRate: null,
        failoverRate: null,
        cooldownRejections: 0,
        exhaustedCount: 0,
        byProvider: {},
      },
      trafficBreakdown: {
        productionCount: 0,
        syntheticCount: 0,
        includeSynthetic,
        windowHours,
        sinceMs,
        asOfMs: now,
        byTable: {
          directTurns: { prod: 0, synth: 0 },
          swarmRuns: { prod: 0, synth: 0 },
          modelFeedback: { prod: 0, synth: 0 },
          metricsEvents: { prod: 0, synth: 0 },
        },
      },
    };
  }
}
