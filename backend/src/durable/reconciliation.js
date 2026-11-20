import { Fault, id as uuid } from '../store.js';
import { sha256Hex } from '../integrity.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
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
  }) {
    const now = Date.now();
    const argsDigest = sha256Hex(JSON.stringify(args ?? {}));
    this.store.tx(() => {
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
    { status = 'finished', output = '', exitCode = null, durationMs = 0, errorCode = null } = {},
  ) {
    if (!receiptId || !this.store?.db) return null;
    const now = Date.now();
    const outputDigest = output ? sha256Hex(String(output)) : null;
    this.store.tx(() => {
      this.store.db
        .prepare(
          `UPDATE tool_receipts
           SET status=?, outputDigest=?, exitCode=?, durationMs=?, errorCode=?, updatedAt=?
           WHERE id=?`,
        )
        .run(
          status,
          outputDigest,
          exitCode !== undefined && exitCode !== null ? Number(exitCode) : null,
          Math.max(0, Number(durationMs || 0)),
          errorCode,
          now,
          receiptId,
        );
    });
    return this.getReceipt(receiptId);
  }

  getReceipt(receiptId) {
    return this.store.db.prepare('SELECT * FROM tool_receipts WHERE id=?').get(receiptId) ?? null;
  }

  listReceipts({ sessionId = null, turnId = null, status = null, limit = 200 } = {}) {
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
   * Inspects executing tool receipts for an interrupted turn.
   * Replayable tools are marked `interrupted_replayable`; non-replayable side effects
   * transition to `outcome_unknown` and create a durable reconciliation request.
   */
  inspectInterruptedTurn(turnId, { sessionId = null } = {}) {
    const executing = this.store.db
      .prepare("SELECT * FROM tool_receipts WHERE turnId=? AND status='executing' ORDER BY createdAt ASC")
      .all(turnId);
    if (!executing.length) {
      return { needsReconciliation: false, unknownReceipts: [] };
    }

    const now = Date.now();
    const unknown = [];
    let approvalId = null;

    this.store.tx(() => {
      for (const r of executing) {
        if (r.replayable) {
          this.store.db
            .prepare(
              "UPDATE tool_receipts SET status='interrupted_replayable', updatedAt=? WHERE id=?",
            )
            .run(now, r.id);
        } else {
          this.store.db
            .prepare(
              "UPDATE tool_receipts SET status='outcome_unknown', updatedAt=? WHERE id=?",
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
            "SELECT id FROM direct_approvals WHERE turnId=? AND kind='reconciliation' AND status='pending' LIMIT 1",
          )
          .get(turnId);
        if (existingPending) {
          approvalId = existingPending.id;
        } else {
          approvalId = uuid();
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
                  '不可重放工具在进程崩溃时正在执行，系统无法确认外部副作用是否已完成，请核对后选择继续或中止。',
              }),
              first.id,
              first.riskLevel,
              first.effectClass,
              now + 86_400_000,
              now,
            );
        }

        this.store.db
          .prepare("UPDATE direct_turns SET state='reconciling', phase='reconciling' WHERE id=? AND state IN ('running','reconciling')")
          .run(turnId);
        if (sid) {
          this.store.db
            .prepare("UPDATE direct_sessions SET state='reconciling', updatedAt=? WHERE id=? AND state IN ('running','reconciling')")
            .run(now, sid);
        }
        this.store.db
          .prepare(
            "UPDATE runtime_jobs SET status='reconciling', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE turnId=? AND status IN ('pending','active')",
          )
          .run(now, turnId);
      }
    });

    if (unknown.length > 0 && this.eventRouter) {
      const first = unknown[0];
      const sid = sessionId || first.sessionId;
      this.eventRouter.emitPersisted({
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
    if (!sessionId || !this.store?.db?.isOpen) return { approvalId: null, unknownReceipts: [] };
    const unknown = this.store.db
      .prepare(
        "SELECT * FROM tool_receipts WHERE sessionId=? AND status='outcome_unknown' ORDER BY createdAt ASC",
      )
      .all(sessionId);
    if (!unknown.length) return { approvalId: null, unknownReceipts: [] };

    const existingPending = this.store.db
      .prepare(
        "SELECT id FROM direct_approvals WHERE sessionId=? AND kind='reconciliation' AND status='pending' LIMIT 1",
      )
      .get(sessionId);
    if (existingPending) {
      return { approvalId: existingPending.id, unknownReceipts: unknown };
    }

    const first = unknown[0];
    const approvalId = uuid();
    const now = Date.now();
    const targetTurnId = turnId || first.turnId || null;
    this.store.tx(() => {
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
    });

    if (this.eventRouter) {
      this.eventRouter.emitPersisted({
        sessionId,
        turnId: targetTurnId,
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
    return { approvalId, unknownReceipts: unknown };
  }

  listReconciliations({ sessionId = null, status = null, limit = 100 } = {}) {
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

    const result = this.store.tx(() => {
      const row = this.store.db
        .prepare("SELECT * FROM direct_approvals WHERE id=? AND kind='reconciliation'")
        .get(approvalId);
      if (!row) throw new Fault('NOT_FOUND', 404);
      if (row.status !== 'pending') throw new Fault('APPROVAL_INACTIVE', 409);

      const now = Date.now();
      const args = parseJsonSafe(row.arguments, {});
      const receiptIds = Array.isArray(args.unknownReceiptIds) && args.unknownReceiptIds.length
        ? args.unknownReceiptIds
        : row.receiptId
          ? [row.receiptId]
          : [];

      const nextReceiptStatus =
        normalizedOutcome === 'happened'
          ? 'reconciled_succeeded'
          : normalizedOutcome === 'not_applied'
            ? 'reconciled_not_applied'
            : 'reconciled_aborted';

      for (const rid of receiptIds) {
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

      if (normalizedOutcome === 'abort') {
        if (row.turnId) {
          this.store.db
            .prepare(
              "UPDATE direct_turns SET state='failed', phase='failed', error='RECONCILIATION_ABORTED', finishedAt=? WHERE id=?",
            )
            .run(now, row.turnId);
          this.store.db
            .prepare(
              "UPDATE runtime_jobs SET status='failed', fence=NULL, leaseExpiresAt=NULL, errorCode='RECONCILIATION_ABORTED', updatedAt=? WHERE turnId=?",
            )
            .run(now, row.turnId);
        }
        this.store.db
          .prepare("UPDATE direct_sessions SET state='failed', updatedAt=? WHERE id=?")
          .run(now, row.sessionId);
      } else {
        const messageText =
          normalizedOutcome === 'happened'
            ? `[系统核对结论] 工具 ${row.tool} (${row.callId || 'unknown'}) 已由人工确认在崩溃前已实际执行生效${note ? ` (${note})` : ''}。请勿重复执行同一副作用，基于当前状态继续后续步骤。`
            : `[系统核对结论] 工具 ${row.tool} (${row.callId || 'unknown'}) 已由人工确认未生效${note ? ` (${note})` : ''}。请先检查当前工作区状态再决定是否重新执行。`;

        // Preserve strict assistant(tool_call) -> tool(tool_result) adjacency if callId exists in direct_messages
        let hasUnansweredToolCall = false;
        if (row.turnId && row.callId) {
          const hasResult = this.store.db
            .prepare(
              "SELECT 1 FROM direct_messages WHERE sessionId=? AND turnId=? AND role='tool' AND toolCallId=? LIMIT 1",
            )
            .get(row.sessionId, row.turnId, row.callId);
          if (!hasResult) {
            const assistantMsgs = this.store.db
              .prepare(
                "SELECT toolCalls FROM direct_messages WHERE sessionId=? AND turnId=? AND role='assistant' AND toolCalls IS NOT NULL",
              )
              .all(row.sessionId, row.turnId);
            hasUnansweredToolCall = assistantMsgs.some((m) =>
              parseJsonSafe(m.toolCalls, []).some((tc) => tc.id === row.callId),
            );
          }
        }

        if (hasUnansweredToolCall) {
          this.store.db
            .prepare(
              `INSERT INTO direct_messages(
                sessionId, turnId, role, content, toolCallId, toolName, meta, createdAt
              ) VALUES(?,?,'tool',?,?,?,?,?)`,
            )
            .run(
              row.sessionId,
              row.turnId,
              messageText,
              row.callId,
              row.tool,
              JSON.stringify({ reconciled: true, outcome: normalizedOutcome }),
              now,
            );
        } else {
          this.store.db
            .prepare(
              `INSERT INTO direct_messages(
                sessionId, turnId, role, content, meta, createdAt
              ) VALUES(?,?,'user',?,?,?)`,
            )
            .run(
              row.sessionId,
              row.turnId ?? null,
              messageText,
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
          this.store.db
            .prepare(
              "UPDATE runtime_jobs SET status='pending', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE turnId=? AND status IN ('reconciling','parked')",
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
              "UPDATE runtime_jobs SET status='pending', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE sessionId=? AND status IN ('reconciling','parked')",
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
      };
    });

    if (this.eventRouter) {
      this.eventRouter.emitPersisted({
        sessionId: result.sessionId,
        turnId: result.turnId,
        type: RUNTIME_EVENTS.RECONCILIATION_RESOLVED,
        data: result,
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
