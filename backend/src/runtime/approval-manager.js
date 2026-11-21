import { Fault, id as uuid } from '../store.js';
import { canonicalizeCommandPrefix } from '../patch-and-diagnostics.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function hydrateApprovalRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    sessionId: r.sessionId,
    turnId: r.turnId,
    callId: r.callId,
    tool: r.tool,
    kind: r.kind || 'tool',
    receiptId: r.receiptId || undefined,
    riskLevel: r.riskLevel || undefined,
    effectClass: r.effectClass || undefined,
    outcome: r.outcome || undefined,
    argsDigest: r.argsDigest || undefined,
    arguments: parseJsonSafe(r.arguments, {}),
    status: r.status,
    scope: r.scope,
    reason: r.reason,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
    consumedAt: r.consumedAt ?? undefined,
    revokedAt: r.revokedAt ?? undefined,
    revokedReason: r.revokedReason ?? undefined,
  };
}

/**
 * Manages interactive tool approval requests, Codex session command-prefix caching,
 * atomic single-use consumption (`consumeApproval`), pre-execution revocation (`revokeApproval`),
 * and reconciliation approval delegation.
 */
export class DirectApprovalManager {
  constructor({ store, eventRouter, reconciler }) {
    this.store = store;
    this.eventRouter = eventRouter;
    this.reconciler = reconciler;
    this.pendingApprovals = new Map();
  }

  #safeEmit(payload) {
    try {
      this.eventRouter?.emitPersisted?.(payload);
    } catch {
      // Isolate SSE/event listener failures so committed DB mutations never fail
    }
  }

  listApprovals({ sessionId = null, status = null, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (sessionId) {
      where.push('sessionId=?');
      params.push(sessionId);
    }
    if (status) {
      where.push('status=?');
      params.push(status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.store.db
      .prepare(`SELECT * FROM direct_approvals ${clause} ORDER BY createdAt DESC LIMIT ?`)
      .all(...params, Math.min(500, Math.max(1, Number(limit))))
      .map(hydrateApprovalRow);
  }

  decideApproval(
    approvalId,
    { decision, scope = 'once', reason = '', outcome = undefined } = {},
  ) {
    const row = this.store.db
      .prepare('SELECT * FROM direct_approvals WHERE id=?')
      .get(approvalId);
    if (!row) return null;
    if (row.kind === 'reconciliation') {
      return this.reconciler.resolveReconciliation(approvalId, {
        outcome: outcome ?? decision,
        note: reason,
      });
    }

    const normalized =
      decision === 'allow' || decision === 'approve' ? 'allowed' : 'denied';
    const now = Date.now();
    const args = parseJsonSafe(row.arguments, {});

    const txOutcome = this.store.tx(() => {
      const fresh = this.store.db
        .prepare('SELECT * FROM direct_approvals WHERE id=?')
        .get(approvalId);
      if (!fresh) return null;
      if (fresh.status !== 'pending') {
        throw new Fault('APPROVAL_INACTIVE', 409, {
          message: `Approval ${approvalId} cannot be decided because status is "${fresh.status}"`,
          status: fresh.status,
        });
      }
      if (fresh.expiresAt && Number(fresh.expiresAt) < now) {
        this.store.db
          .prepare(
            "UPDATE direct_approvals SET status='expired', resolvedAt=COALESCE(resolvedAt, ?) WHERE id=? AND status='pending'",
          )
          .run(now, approvalId);
        const expiredRow = this.store.db
          .prepare('SELECT * FROM direct_approvals WHERE id=?')
          .get(approvalId);
        return { expired: true, row: expiredRow };
      }

      const res = this.store.db
        .prepare(
          "UPDATE direct_approvals SET status=?, scope=?, reason=?, resolvedAt=? WHERE id=? AND status='pending'",
        )
        .run(normalized, scope, reason || null, now, approvalId);
      if ((res.changes ?? 0) !== 1) {
        throw new Fault('APPROVAL_INACTIVE', 409, {
          message: `Approval ${approvalId} was concurrently modified`,
        });
      }

      if (
        normalized === 'allowed' &&
        (scope === 'session' || scope === 'session-prefix') &&
        (fresh.tool === 'bash' || fresh.tool === 'start_process')
      ) {
        const prefix = canonicalizeCommandPrefix(args.command);
        if (prefix) {
          const sessRow = this.store.db
            .prepare('SELECT approvedPrefixes FROM direct_sessions WHERE id=?')
            .get(fresh.sessionId);
          const cur = parseJsonSafe(sessRow?.approvedPrefixes, []);
          if (!cur.includes(prefix)) {
            cur.push(prefix);
            this.store.db
              .prepare(
                'UPDATE direct_sessions SET approvedPrefixes=?, updatedAt=? WHERE id=?',
              )
              .run(JSON.stringify(cur), now, fresh.sessionId);
          }
        }
      }

      return {
        expired: false,
        row: this.store.db
          .prepare('SELECT * FROM direct_approvals WHERE id=?')
          .get(approvalId),
      };
    });

    if (!txOutcome || !txOutcome.row) return null;

    if (txOutcome.expired) {
      const expiredRow = txOutcome.row;
      const waiter = this.pendingApprovals.get(approvalId);
      if (waiter) {
        this.pendingApprovals.delete(approvalId);
        waiter.resolve({
          allowed: false,
          expired: true,
          approvalId: expiredRow.id,
          argsDigest: expiredRow.argsDigest ?? waiter.argsDigest ?? null,
          reason: 'Approval has expired',
        });
      }
      this.#safeEmit({
        sessionId: expiredRow.sessionId,
        turnId: expiredRow.turnId,
        type: RUNTIME_EVENTS.APPROVAL_RESOLVED,
        data: {
          approvalId: expiredRow.id,
          status: 'expired',
          expired: true,
          tool: expiredRow.tool,
        },
        audit: true,
      });
      throw new Fault('APPROVAL_EXPIRED', 409, {
        message: `Approval ${approvalId} has expired`,
      });
    }

    const updatedRow = txOutcome.row;

    const waiter = this.pendingApprovals.get(approvalId);
    if (waiter) {
      this.pendingApprovals.delete(approvalId);
      waiter.resolve({
        allowed: normalized === 'allowed',
        approvalId: updatedRow.id,
        argsDigest: updatedRow.argsDigest ?? waiter.argsDigest ?? null,
        reason: reason || (normalized === 'allowed' ? 'approved' : 'denied'),
      });
    }

    const updated = hydrateApprovalRow(updatedRow);
    this.#safeEmit({
      sessionId: updatedRow.sessionId,
      turnId: updatedRow.turnId,
      type: RUNTIME_EVENTS.APPROVAL_RESOLVED,
      data: {
        approvalId: updatedRow.id,
        status: normalized,
        scope,
        tool: updatedRow.tool,
      },
      audit: true,
    });
    return updated;
  }

  /**
   * Revokes a pending or already-allowed (but not yet consumed) approval before tool execution starts.
   */
  revokeApproval(approvalId, { reason = 'revoked' } = {}) {
    const cleanReason = String(reason || 'revoked').slice(0, 500);
    const now = Date.now();
    const outcome = this.store.tx(() => {
      const existing = this.store.db
        .prepare('SELECT * FROM direct_approvals WHERE id=?')
        .get(approvalId);
      if (!existing) {
        return { ok: false, changed: false, code: 'APPROVAL_NOT_FOUND', approval: null };
      }
      const res = this.store.db
        .prepare(
          `UPDATE direct_approvals
           SET status='revoked', revokedAt=?, revokedReason=?, resolvedAt=COALESCE(resolvedAt, ?)
           WHERE id=? AND status IN ('pending','allowed')`,
        )
        .run(now, cleanReason, now, approvalId);
      const fresh = this.store.db
        .prepare('SELECT * FROM direct_approvals WHERE id=?')
        .get(approvalId);
      return {
        ok: true,
        changed: (res.changes ?? 0) > 0,
        approval: hydrateApprovalRow(fresh),
      };
    });

    const waiter = this.pendingApprovals.get(approvalId);
    if (waiter) {
      this.pendingApprovals.delete(approvalId);
      waiter.resolve({
        allowed: false,
        revoked: true,
        approvalId,
        argsDigest: outcome.approval?.argsDigest ?? waiter.argsDigest ?? null,
        reason: cleanReason,
      });
    }

    if (outcome.changed && outcome.approval) {
      this.#safeEmit({
        sessionId: outcome.approval.sessionId,
        turnId: outcome.approval.turnId,
        type: RUNTIME_EVENTS.APPROVAL_RESOLVED,
        data: {
          approvalId: outcome.approval.id,
          status: 'revoked',
          revoked: true,
          reason: cleanReason,
          tool: outcome.approval.tool,
        },
        audit: true,
      });
    }

    return outcome;
  }

  /**
   * Atomically verifies and consumes an allowed approval immediately before tool execution.
   * Rejects revoked, denied, expired, already-consumed, session/turn-mismatched, or digest-mismatched approvals.
   */
  consumeApproval(approvalId, { expectedArgsDigest = null, sessionId = null, turnId = null } = {}) {
    if (!approvalId) {
      return { ok: false, code: 'APPROVAL_ID_REQUIRED', reason: 'approvalId is required' };
    }
    if (!expectedArgsDigest || typeof expectedArgsDigest !== 'string') {
      return { ok: false, code: 'ARGS_DIGEST_MISMATCH', reason: 'expectedArgsDigest is required' };
    }
    const now = Date.now();
    return this.store.tx(() => {
      const row = this.store.db
        .prepare('SELECT * FROM direct_approvals WHERE id=?')
        .get(approvalId);
      if (!row) {
        return { ok: false, code: 'APPROVAL_NOT_FOUND', reason: `Approval ${approvalId} not found` };
      }
      if (sessionId && row.sessionId && row.sessionId !== sessionId) {
        return {
          ok: false,
          code: 'APPROVAL_SCOPE_MISMATCH',
          reason: 'Approval does not belong to this session',
        };
      }
      if (turnId && row.turnId && row.turnId !== turnId) {
        return {
          ok: false,
          code: 'APPROVAL_SCOPE_MISMATCH',
          reason: 'Approval does not belong to this turn',
        };
      }
      if (row.status === 'revoked') {
        return {
          ok: false,
          code: 'APPROVAL_REVOKED',
          reason: row.revokedReason || 'Approval was revoked before execution',
        };
      }
      if (row.status === 'consumed') {
        return {
          ok: false,
          code: 'APPROVAL_ALREADY_CONSUMED',
          reason: 'Approval has already been consumed',
        };
      }
      if (row.status !== 'allowed') {
        return {
          ok: false,
          code: 'APPROVAL_NOT_ALLOWED',
          reason: `Approval status is "${row.status}"`,
        };
      }
      if (row.expiresAt && Number(row.expiresAt) < now) {
        this.store.db
          .prepare(
            "UPDATE direct_approvals SET status='expired', resolvedAt=COALESCE(resolvedAt, ?) WHERE id=? AND status='allowed'",
          )
          .run(now, approvalId);
        return {
          ok: false,
          code: 'APPROVAL_EXPIRED',
          reason: 'Approval expired before execution',
        };
      }
      if (!row.argsDigest || row.argsDigest !== expectedArgsDigest) {
        return {
          ok: false,
          code: 'ARGS_DIGEST_MISMATCH',
          reason: 'Approval argsDigest does not match execution arguments',
        };
      }
      const res = this.store.db
        .prepare(
          "UPDATE direct_approvals SET status='consumed', consumedAt=? WHERE id=? AND status='allowed' AND argsDigest=?",
        )
        .run(now, approvalId, expectedArgsDigest);
      if ((res.changes ?? 0) !== 1) {
        return {
          ok: false,
          code: 'APPROVAL_ALREADY_CONSUMED',
          reason: 'Approval was concurrently consumed or modified',
        };
      }
      const fresh = this.store.db
        .prepare('SELECT * FROM direct_approvals WHERE id=?')
        .get(approvalId);
      return { ok: true, approval: hydrateApprovalRow(fresh) };
    });
  }

  requestApproval({
    sessionId,
    turnId,
    callId,
    tool,
    args,
    riskLevel = null,
    effectClass = null,
    argsDigest = null,
    signal,
  }) {
    const approvalId = uuid();
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000;
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO direct_approvals(
            id, sessionId, turnId, callId, tool, arguments, status, kind, riskLevel, effectClass, argsDigest, expiresAt, createdAt
          ) VALUES(?,?,?,?,?,?,'pending','tool',?,?,?,?,?)`,
        )
        .run(
          approvalId,
          sessionId,
          turnId,
          callId ?? null,
          tool,
          JSON.stringify(args ?? {}),
          riskLevel,
          effectClass,
          argsDigest,
          expiresAt,
          now,
        );
    });
    this.#safeEmit({
      sessionId,
      turnId,
      type: RUNTIME_EVENTS.APPROVAL_REQUESTED,
      data: {
        approvalId,
        callId,
        tool,
        riskLevel,
        effectClass,
        argsDigest,
        arguments: args ?? {},
        expiresAt,
      },
      audit: true,
    });

    return new Promise((resolveDecision, rejectDecision) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pendingApprovals.delete(approvalId);
      };
      const onAbort = () => {
        cleanup();
        if (this.store?.db?.isOpen) {
          this.store.tx(() => {
            this.store.db
              .prepare(
                "UPDATE direct_approvals SET status='expired', resolvedAt=? WHERE id=? AND status='pending'",
              )
              .run(Date.now(), approvalId);
          });
        }
        rejectDecision(new Error('对话轮次已取消'));
      };
      const timer = setTimeout(() => {
        cleanup();
        if (this.store?.db?.isOpen) {
          this.store.tx(() => {
            this.store.db
              .prepare(
                "UPDATE direct_approvals SET status='expired', resolvedAt=? WHERE id=? AND status='pending'",
              )
              .run(Date.now(), approvalId);
          });
        }
        resolveDecision({
          allowed: false,
          approvalId,
          argsDigest,
          reason: 'timeout',
        });
      }, 10 * 60 * 1000);
      timer.unref?.();

      this.pendingApprovals.set(approvalId, {
        argsDigest,
        resolve: (result) => {
          cleanup();
          resolveDecision(result);
        },
        reject: (err) => {
          cleanup();
          rejectDecision(err);
        },
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
