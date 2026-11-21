import { Fault, id as uuid } from '../store.js';
import { canonicalJson, sha256Hex } from '../integrity.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import { convergeScheduledRunForTurn } from '../governance/scheduler.js';
import { assertLeaseInTx, isLeaseLostError } from './lease-guard.js';

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function safeEmit(eventRouter, payload) {
  if (!eventRouter) return;
  try {
    eventRouter.emitPersisted(payload);
  } catch {
    // Isolate SSE/event listener failures from durable DB commits
  }
}

/**
 * Handles structured `tool_receipts` persistence and Agnes-style unknown-outcome
 * reconciliation for non-replayable side effects interrupted mid-flight.
 */
export class UnknownOutcomeReconciler {
  constructor(store, eventRouter) {
    this.store = store;
    this.eventRouter = eventRouter;
    this.resolvedListeners = [];
  }

  #dbOpen() {
    try {
      return Boolean(this.store?.db?.isOpen);
    } catch {
      return false;
    }
  }

  onResolved(fn) {
    if (typeof fn === 'function') this.resolvedListeners.push(fn);
  }

  recordReceiptStart({
    id = uuid(),
    sessionId = null,
    turnId = null,
    taskId = null,
    callId,
    toolName,
    riskLevel = 'medium',
    effectClass = 'irreversible_side_effect',
    replayable = false,
    outward = false,
    args = {},
    approvalId = null,
    permitEffectId = null,
    approvedArgsDigest = null,
    hookDigest = null,
    leaseGuard = null,
  }) {
    if (!this.#dbOpen()) return null;
    const now = Date.now();
    const argsDigest = sha256Hex(
      canonicalJson({ tool: String(toolName || ''), args: args ?? {} }),
    );
    this.store.tx(() => {
      assertLeaseInTx(leaseGuard, { sessionId, turnId, runId: taskId });
      this.store.db
        .prepare(
          `INSERT INTO tool_receipts(
            id, sessionId, turnId, taskId, callId, toolName, riskLevel, effectClass,
            replayable, outward, argsDigest, approvalId, permitEffectId, approvedArgsDigest, hookDigest,
            status, durationMs, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'executing',0,?,?)`,
        )
        .run(
          id,
          sessionId,
          turnId,
          taskId,
          callId,
          toolName,
          riskLevel,
          effectClass,
          replayable ? 1 : 0,
          outward ? 1 : 0,
          argsDigest,
          approvalId,
          permitEffectId,
          approvedArgsDigest,
          hookDigest,
          now,
          now,
        );
    });
    return {
      id,
      sessionId,
      turnId,
      taskId,
      callId,
      toolName,
      riskLevel,
      effectClass,
      replayable: Boolean(replayable),
      outward: Boolean(outward),
      argsDigest,
      approvalId,
      permitEffectId,
      status: 'executing',
      createdAt: now,
    };
  }

  recordReceiptFinish(
    receiptId,
    {
      status = 'finished',
      output = '',
      exitCode = null,
      durationMs = 0,
      errorCode = null,
      leaseGuard = null,
    } = {},
  ) {
    if (!receiptId || !this.#dbOpen()) return null;
    const now = Date.now();
    const outputDigest = output ? sha256Hex(String(output)) : null;
    this.store.tx(() => {
      const existing = this.store.db
        .prepare('SELECT * FROM tool_receipts WHERE id=?')
        .get(receiptId);
      if (!existing || existing.status !== 'executing') {
        // Never overwrite outcome_unknown, reconciled_*, or already-finished receipts
        return;
      }

      let effectiveStatus = status;
      let effectiveErrorCode = errorCode;

      if (leaseGuard) {
        try {
          assertLeaseInTx(leaseGuard, {
            sessionId: existing.sessionId,
            turnId: existing.turnId,
            runId: existing.taskId,
          });
        } catch (err) {
          if (!isLeaseLostError(err)) throw err;
          // Lease lost mid-tool: never record 'finished'; preserve unknown outcome for non-replayable/outward tools
          if (!existing.replayable || existing.outward) {
            effectiveStatus = 'outcome_unknown';
            effectiveErrorCode = errorCode || 'LEASE_LOST_UNKNOWN_OUTCOME';
          } else {
            effectiveStatus = 'interrupted_replayable';
            effectiveErrorCode = errorCode || 'LEASE_LOST';
          }
        }
      }

      this.store.db
        .prepare(
          `UPDATE tool_receipts
           SET status=?, outputDigest=?, exitCode=?, durationMs=?, errorCode=?, updatedAt=?
           WHERE id=? AND status='executing'`,
        )
        .run(
          effectiveStatus,
          outputDigest,
          exitCode !== undefined && exitCode !== null ? Number(exitCode) : null,
          Math.max(0, Number(durationMs || 0)),
          effectiveErrorCode,
          now,
          receiptId,
        );
    });
    return this.getReceipt(receiptId);
  }

  getReceipt(receiptId) {
    if (!this.#dbOpen() || !receiptId) return null;
    return this.store.db.prepare('SELECT * FROM tool_receipts WHERE id=?').get(receiptId) ?? null;
  }

  listReceipts({ sessionId = null, turnId = null, status = null, limit = 200 } = {}) {
    if (!this.#dbOpen()) return [];
    const where = [];
    const params = [];
    if (sessionId) {
      where.push('sessionId=?');
      params.push(sessionId);
    }
    if (turnId) {
      where.push('turnId=?');
      params.push(turnId);
    }
    if (status) {
      where.push('status=?');
      params.push(status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.store.db
      .prepare(`SELECT * FROM tool_receipts ${clause} ORDER BY createdAt DESC LIMIT ?`)
      .all(...params, Math.min(500, Math.max(1, Number(limit || 200))));
  }

  /**
   * Inspects executing AND already-outcome_unknown tool receipts for an interrupted turn.
   * Replayable tools are marked `interrupted_replayable`; non-replayable side effects
   * transition to `outcome_unknown` and create a durable reconciliation request.
   */
  inspectInterruptedTurn(turnId, { sessionId = null } = {}) {
    if (!this.#dbOpen() || !turnId) {
      return { needsReconciliation: false, approvalId: null, unknownReceipts: [] };
    }

    const now = Date.now();
    const unknown = [];
    let approvalId = null;
    let newlyCreatedApproval = false;

    this.store.tx(() => {
      const rows = this.store.db
        .prepare(
          "SELECT * FROM tool_receipts WHERE turnId=? AND status IN ('executing','outcome_unknown') ORDER BY createdAt ASC, rowid ASC",
        )
        .all(turnId);
      if (!rows.length) return;

      for (const r of rows) {
        if (r.status === 'outcome_unknown') {
          unknown.push(r);
          continue;
        }
        if (r.replayable && !r.outward) {
          this.store.db
            .prepare(
              "UPDATE tool_receipts SET status='interrupted_replayable', updatedAt=? WHERE id=? AND status='executing'",
            )
            .run(now, r.id);
        } else {
          this.store.db
            .prepare(
              "UPDATE tool_receipts SET status='outcome_unknown', updatedAt=? WHERE id=? AND status='executing'",
            )
            .run(now, r.id);
          unknown.push(r);
        }
      }

      if (unknown.length > 0) {
        const first = unknown[0];
        const sid = sessionId || first.sessionId;
        const existingPending = this.store.db
          .prepare(
            "SELECT id, arguments FROM direct_approvals WHERE turnId=? AND kind='reconciliation' AND status='pending' LIMIT 1",
          )
          .get(turnId);
        if (existingPending) {
          approvalId = existingPending.id;
          // Ensure newly discovered unknown receipts are merged into existing pending reconciliation
          const prevArgs = parseJsonSafe(existingPending.arguments, {});
          const mergedIds = [
            ...new Set([
              ...(Array.isArray(prevArgs.unknownReceiptIds) ? prevArgs.unknownReceiptIds : []),
              ...unknown.map((u) => u.id),
            ]),
          ];
          if (mergedIds.length !== (prevArgs.unknownReceiptIds?.length ?? 0)) {
            this.store.db
              .prepare('UPDATE direct_approvals SET arguments=? WHERE id=?')
              .run(JSON.stringify({ ...prevArgs, unknownReceiptIds: mergedIds }), approvalId);
          }
        } else {
          approvalId = uuid();
          newlyCreatedApproval = true;
          this.store.db
            .prepare(
              `INSERT INTO direct_approvals(
                id, sessionId, turnId, callId, tool, arguments, status, kind, receiptId,
                riskLevel, effectClass, expiresAt, createdAt
              ) VALUES(?,?,?,?,?,?,'pending','reconciliation',?,?,?,?,?)`,
            )
            .run(
              approvalId,
              sid,
              turnId,
              first.callId,
              first.toolName,
              JSON.stringify({
                receiptId: first.id,
                unknownReceiptIds: unknown.map((u) => u.id),
                callId: first.callId,
                toolName: first.toolName,
                effectClass: first.effectClass,
                reason:
                  '不可重放工具在进程崩溃或中断时处于未知结果状态，系统无法确认外部副作用是否已完成，请核对后选择继续或中止。',
              }),
              first.id,
              first.riskLevel,
              first.effectClass,
              now + 86_400_000,
              now,
            );
        }

        this.store.db
          .prepare(
            "UPDATE direct_turns SET state='reconciling', phase='reconciling', activeFence=NULL WHERE id=? AND state IN ('running','reconciling')",
          )
          .run(turnId);
        if (sid) {
          this.store.db
            .prepare(
              "UPDATE direct_sessions SET state='reconciling', updatedAt=? WHERE id=? AND state IN ('running','reconciling')",
            )
            .run(now, sid);
        }
        this.store.db
          .prepare(
            "UPDATE runtime_jobs SET status='reconciling', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE turnId=? AND status IN ('pending','active')",
          )
          .run(now, turnId);
      }
    });

    if (unknown.length > 0 && newlyCreatedApproval) {
      const first = unknown[0];
      const sid = sessionId || first.sessionId;
      safeEmit(this.eventRouter, {
        sessionId: sid,
        turnId,
        type: RUNTIME_EVENTS.RECONCILIATION_REQUIRED,
        data: {
          approvalId,
          receiptId: first.id,
          unknownReceiptIds: unknown.map((u) => u.id),
          tool: first.toolName,
          callId: first.callId,
        },
        audit: true,
      });
    }

    return {
      needsReconciliation: unknown.length > 0,
      approvalId,
      unknownReceipts: unknown,
    };
  }

  /**
   * Ensures a pending reconciliation approval exists whenever a session has unresolved
   * `outcome_unknown` receipts (e.g. when `block_reconciliation` parks a turn).
   */
  ensurePendingReconciliationForSession(sessionId, { turnId = null } = {}) {
    if (!sessionId || !this.#dbOpen()) return { approvalId: null, unknownReceipts: [] };

    const now = Date.now();
    const txOut = this.store.tx(() => {
      const unknown = this.store.db
        .prepare(
          "SELECT * FROM tool_receipts WHERE sessionId=? AND status='outcome_unknown' ORDER BY createdAt ASC, rowid ASC",
        )
        .all(sessionId);
      if (!unknown.length) {
        return { approvalId: null, unknownReceipts: [], newlyCreated: false, first: null, targetTurnId: null };
      }

      const existingPending = this.store.db
        .prepare(
          "SELECT id FROM direct_approvals WHERE sessionId=? AND kind='reconciliation' AND status='pending' LIMIT 1",
        )
        .get(sessionId);
      if (existingPending) {
        return {
          approvalId: existingPending.id,
          unknownReceipts: unknown,
          newlyCreated: false,
          first: unknown[0],
          targetTurnId: turnId || unknown[0].turnId || null,
        };
      }

      const first = unknown[0];
      const approvalId = uuid();
      const targetTurnId = turnId || first.turnId || null;
      this.store.db
        .prepare(
          `INSERT INTO direct_approvals(
            id, sessionId, turnId, callId, tool, arguments, status, kind, receiptId,
            riskLevel, effectClass, expiresAt, createdAt
          ) VALUES(?,?,?,?,?,?,'pending','reconciliation',?,?,?,?,?)`,
        )
        .run(
          approvalId,
          sessionId,
          targetTurnId,
          first.callId,
          first.toolName,
          JSON.stringify({
            receiptId: first.id,
            unknownReceiptIds: unknown.map((u) => u.id),
            callId: first.callId,
            toolName: first.toolName,
            effectClass: first.effectClass,
            reason: '存在状态未知的外部副作用 (outcome_unknown)，需人工核对确认后方可继续。',
          }),
          first.id,
          first.riskLevel,
          first.effectClass,
          now + 86_400_000,
          now,
        );
      return { approvalId, unknownReceipts: unknown, newlyCreated: true, first, targetTurnId };
    });

    if (txOut.newlyCreated && txOut.first) {
      safeEmit(this.eventRouter, {
        sessionId,
        turnId: txOut.targetTurnId,
        type: RUNTIME_EVENTS.RECONCILIATION_REQUIRED,
        data: {
          approvalId: txOut.approvalId,
          receiptId: txOut.first.id,
          unknownReceiptIds: txOut.unknownReceipts.map((u) => u.id),
          tool: txOut.first.toolName,
          callId: txOut.first.callId,
        },
        audit: true,
      });
    }
    return { approvalId: txOut.approvalId, unknownReceipts: txOut.unknownReceipts };
  }

  listReconciliations({ sessionId = null, status = null, limit = 100 } = {}) {
    if (!this.#dbOpen()) return [];
    const where = ["kind='reconciliation'"];
    const params = [];
    if (sessionId) {
      where.push('sessionId=?');
      params.push(sessionId);
    }
    if (status) {
      where.push('status=?');
      params.push(status);
    }
    return this.store.db
      .prepare(
        `SELECT * FROM direct_approvals WHERE ${where.join(' AND ')} ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(...params, Math.min(200, Math.max(1, Number(limit || 100))))
      .map((r) => ({
        ...r,
        arguments: parseJsonSafe(r.arguments, {}),
      }));
  }

  /**
   * Resolves an interrupted unknown-outcome reconciliation (`happened` | `not_applied` | `abort`).
   */
  resolveReconciliation(approvalId, { outcome, note = '' } = {}) {
    const normalizedOutcome =
      outcome === 'succeeded' || outcome === 'allow' || outcome === 'approve'
        ? 'happened'
        : outcome === 'deny'
          ? 'abort'
          : outcome;
    if (!['happened', 'not_applied', 'abort'].includes(normalizedOutcome)) {
      throw new Fault('INVALID_RECONCILIATION_OUTCOME', 400, {
        message: 'Reconciliation outcome must be happened, not_applied, or abort',
      });
    }

    const { result, turnAborted } = this.store.tx(() => {
      const row = this.store.db
        .prepare("SELECT * FROM direct_approvals WHERE id=? AND kind='reconciliation'")
        .get(approvalId);
      if (!row) throw new Fault('NOT_FOUND', 404);
      if (row.status !== 'pending') throw new Fault('APPROVAL_INACTIVE', 409);

      const now = Date.now();
      const args = parseJsonSafe(row.arguments, {});
      const receiptIds =
        Array.isArray(args.unknownReceiptIds) && args.unknownReceiptIds.length
          ? [...new Set(args.unknownReceiptIds)]
          : row.receiptId
            ? [row.receiptId]
            : [];

      const nextReceiptStatus =
        normalizedOutcome === 'happened'
          ? 'reconciled_succeeded'
          : normalizedOutcome === 'not_applied'
            ? 'reconciled_not_applied'
            : 'reconciled_aborted';

      const receiptRows = [];
      for (const rid of receiptIds) {
        const recRow = this.store.db
          .prepare('SELECT id, callId, toolName, turnId, sessionId FROM tool_receipts WHERE id=?')
          .get(rid);
        if (recRow) receiptRows.push(recRow);
        this.store.db
          .prepare(
            `UPDATE tool_receipts
             SET status=?, reconciliationOutcome=?, reconciliationNote=?, updatedAt=?
             WHERE id=?`,
          )
          .run(nextReceiptStatus, normalizedOutcome, note || null, now, rid);
      }

      const approvalStatus = normalizedOutcome === 'abort' ? 'denied' : 'allowed';
      this.store.db
        .prepare(
          'UPDATE direct_approvals SET status=?, outcome=?, reason=?, resolvedAt=? WHERE id=?',
        )
        .run(approvalStatus, normalizedOutcome, note || null, now, approvalId);

      let abortedTurnFlag = false;
      if (normalizedOutcome === 'abort') {
        if (row.turnId) {
          const tRes = this.store.db
            .prepare(
              `UPDATE direct_turns
               SET state='failed', phase='failed', error='RECONCILIATION_ABORTED',
                   finishedAt=COALESCE(finishedAt, ?), activeFence=NULL
               WHERE id=? AND state NOT IN ('completed','failed','cancelled')`,
            )
            .run(now, row.turnId);
          abortedTurnFlag = (tRes.changes ?? 0) > 0;
          this.store.db
            .prepare(
              `UPDATE runtime_jobs
               SET status='failed', fence=NULL, leaseExpiresAt=NULL,
                   errorCode='RECONCILIATION_ABORTED', updatedAt=?
               WHERE turnId=? AND status IN ('pending','active','reconciling','parked')`,
            )
            .run(now, row.turnId);
          convergeScheduledRunForTurn(this.store, row.turnId, {
            status: 'failed',
            error: 'RECONCILIATION_ABORTED',
            finishedAt: now,
          });
        }
        this.store.db
          .prepare(
            "UPDATE direct_sessions SET state='failed', updatedAt=? WHERE id=? AND state NOT IN ('completed','cancelled')",
          )
          .run(now, row.sessionId);
      } else {
        const formatNote = (toolName, callId) =>
          normalizedOutcome === 'happened'
            ? `[系统核对结论] 工具 ${toolName} (${callId || 'unknown'}) 已由人工确认在崩溃前已实际执行生效${note ? ` (${note})` : ''}。请勿重复执行同一副作用，基于当前状态继续后续步骤。`
            : `[系统核对结论] 工具 ${toolName} (${callId || 'unknown'}) 已由人工确认未生效${note ? ` (${note})` : ''}。请先检查当前工作区状态再决定是否重新执行。`;

        // Preserve strict assistant(tool_call) -> tool(tool_result) adjacency for EVERY unanswered callId
        let insertedToolMsgs = 0;
        if (row.turnId) {
          const assistantMsgs = this.store.db
            .prepare(
              "SELECT toolCalls FROM direct_messages WHERE sessionId=? AND turnId=? AND role='assistant' AND toolCalls IS NOT NULL",
            )
            .all(row.sessionId, row.turnId);
          const allAssistantToolCalls = new Map();
          for (const m of assistantMsgs) {
            for (const tc of parseJsonSafe(m.toolCalls, [])) {
              if (tc?.id) allAssistantToolCalls.set(tc.id, tc);
            }
          }

          const existingToolResultIds = new Set(
            this.store.db
              .prepare(
                "SELECT toolCallId FROM direct_messages WHERE sessionId=? AND turnId=? AND role='tool' AND toolCallId IS NOT NULL",
              )
              .all(row.sessionId, row.turnId)
              .map((r) => r.toolCallId),
          );

          const candidateCalls = [];
          const seenCallIds = new Set();
          for (const rec of receiptRows) {
            if (rec.callId && !seenCallIds.has(rec.callId)) {
              seenCallIds.add(rec.callId);
              candidateCalls.push({ callId: rec.callId, toolName: rec.toolName || row.tool });
            }
          }
          if (row.callId && !seenCallIds.has(row.callId)) {
            seenCallIds.add(row.callId);
            candidateCalls.push({ callId: row.callId, toolName: row.tool });
          }
          // Also answer any remaining unanswered assistant toolCalls in this turn so provider API never 400s
          for (const [cid, tc] of allAssistantToolCalls.entries()) {
            if (!seenCallIds.has(cid) && !existingToolResultIds.has(cid)) {
              seenCallIds.add(cid);
              candidateCalls.push({ callId: cid, toolName: tc.name || row.tool });
            }
          }

          for (const cand of candidateCalls) {
            if (allAssistantToolCalls.has(cand.callId) && !existingToolResultIds.has(cand.callId)) {
              this.store.db
                .prepare(
                  `INSERT INTO direct_messages(
                    sessionId, turnId, role, content, toolCallId, toolName, meta, createdAt
                  ) VALUES(?,?,'tool',?,?,?,?,?)`,
                )
                .run(
                  row.sessionId,
                  row.turnId,
                  formatNote(cand.toolName, cand.callId),
                  cand.callId,
                  cand.toolName,
                  JSON.stringify({ reconciled: true, outcome: normalizedOutcome }),
                  now,
                );
              existingToolResultIds.add(cand.callId);
              insertedToolMsgs++;
            }
          }
        }

        if (insertedToolMsgs === 0) {
          this.store.db
            .prepare(
              `INSERT INTO direct_messages(
                sessionId, turnId, role, content, meta, createdAt
              ) VALUES(?,?,'user',?,?,?)`,
            )
            .run(
              row.sessionId,
              row.turnId ?? null,
              formatNote(row.tool, row.callId),
              JSON.stringify({ reconciled: true, outcome: normalizedOutcome }),
              now,
            );
        }

        if (row.turnId) {
          this.store.db
            .prepare(
              "UPDATE direct_turns SET state='running', phase='checkpoint' WHERE id=? AND state='reconciling'",
            )
            .run(row.turnId);
          // Narrow unpark strictly to 'reconciling' jobs so APPROVAL_PARKED jobs are never unparked prematurely
          this.store.db
            .prepare(
              "UPDATE runtime_jobs SET status='pending', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE turnId=? AND status='reconciling'",
            )
            .run(now, row.turnId);
        }
        const remainingUnknown =
          this.store.db
            .prepare(
              "SELECT COUNT(*) AS n FROM tool_receipts WHERE sessionId=? AND status='outcome_unknown'",
            )
            .get(row.sessionId)?.n ?? 0;
        if (remainingUnknown === 0) {
          this.store.db
            .prepare(
              "UPDATE direct_turns SET state='running', phase='checkpoint' WHERE sessionId=? AND state='reconciling'",
            )
            .run(row.sessionId);
          this.store.db
            .prepare(
              "UPDATE runtime_jobs SET status='pending', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE sessionId=? AND status='reconciling'",
            )
            .run(now, row.sessionId);
        }
        this.store.db
          .prepare(
            "UPDATE direct_sessions SET state='running', updatedAt=? WHERE id=? AND state='reconciling'",
          )
          .run(now, row.sessionId);
      }

      return {
        turnAborted: abortedTurnFlag,
        result: {
          id: approvalId,
          sessionId: row.sessionId,
          turnId: row.turnId,
          callId: row.callId,
          tool: row.tool,
          kind: 'reconciliation',
          status: approvalStatus,
          outcome: normalizedOutcome,
          reason: note || null,
          resolvedAt: now,
          receiptIds,
        },
      };
    });

    safeEmit(this.eventRouter, {
      sessionId: result.sessionId,
      turnId: result.turnId,
      type: RUNTIME_EVENTS.RECONCILIATION_RESOLVED,
      data: result,
      audit: true,
    });
    if (normalizedOutcome === 'abort' && turnAborted && result.turnId) {
      safeEmit(this.eventRouter, {
        sessionId: result.sessionId,
        turnId: result.turnId,
        type: RUNTIME_EVENTS.TURN_FAILED,
        data: {
          turnId: result.turnId,
          sessionId: result.sessionId,
          code: 'RECONCILIATION_ABORTED',
          error: result.reason || 'RECONCILIATION_ABORTED',
        },
        audit: true,
      });
    }
    for (const listener of this.resolvedListeners) {
      try {
        listener(result);
      } catch {
        // isolate hook failure
      }
    }
    if (normalizedOutcome !== 'abort') {
      this.store.notifyJobWake();
    }
    return result;
  }
}
