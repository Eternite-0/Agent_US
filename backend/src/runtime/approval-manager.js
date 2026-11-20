import { id as uuid } from '../store.js';
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

/**
 * Manages interactive tool approval requests, Codex session command-prefix caching,
 * and reconciliation approval delegation.
 */
export class DirectApprovalManager {
  constructor({ store, eventRouter, reconciler }) {
    this.store = store;
    this.eventRouter = eventRouter;
    this.reconciler = reconciler;
    this.pendingApprovals = new Map();
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
      .map((r) => ({
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
        arguments: parseJsonSafe(r.arguments, {}),
        status: r.status,
        scope: r.scope,
        reason: r.reason,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
      }));
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

    this.store.tx(() => {
      this.store.db
        .prepare(
          'UPDATE direct_approvals SET status=?, scope=?, reason=?, resolvedAt=? WHERE id=?',
        )
        .run(normalized, scope, reason || null, now, approvalId);

      if (
        normalized === 'allowed' &&
        (scope === 'session' || scope === 'session-prefix') &&
        (row.tool === 'bash' || row.tool === 'start_process')
      ) {
        const prefix = args.commandPrefix || canonicalizeCommandPrefix(args.command);
        if (prefix) {
          const sessRow = this.store.db
            .prepare('SELECT approvedPrefixes FROM direct_sessions WHERE id=?')
            .get(row.sessionId);
          const cur = parseJsonSafe(sessRow?.approvedPrefixes, []);
          if (!cur.includes(prefix)) {
            cur.push(prefix);
            this.store.db
              .prepare(
                'UPDATE direct_sessions SET approvedPrefixes=?, updatedAt=? WHERE id=?',
              )
              .run(JSON.stringify(cur), now, row.sessionId);
          }
        }
      }
    });

    const waiter = this.pendingApprovals.get(approvalId);
    if (waiter) {
      this.pendingApprovals.delete(approvalId);
      waiter.resolve(normalized === 'allowed');
    }

    const updated = {
      id: row.id,
      sessionId: row.sessionId,
      turnId: row.turnId,
      callId: row.callId,
      tool: row.tool,
      kind: row.kind || 'tool',
      arguments: args,
      status: normalized,
      scope,
      reason: reason || null,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      resolvedAt: now,
    };
    this.eventRouter.emitPersisted({
      sessionId: row.sessionId,
      turnId: row.turnId,
      type: RUNTIME_EVENTS.APPROVAL_RESOLVED,
      data: {
        approvalId: row.id,
        status: normalized,
        scope,
        tool: row.tool,
      },
      audit: true,
    });
    return updated;
  }

  requestApproval({
    sessionId,
    turnId,
    callId,
    tool,
    args,
    riskLevel = null,
    effectClass = null,
    signal,
  }) {
    const approvalId = uuid();
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000;
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO direct_approvals(
            id, sessionId, turnId, callId, tool, arguments, status, kind, riskLevel, effectClass, expiresAt, createdAt
          ) VALUES(?,?,?,?,?,?,'pending','tool',?,?,?,?)`,
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
          expiresAt,
          now,
        );
    });
    this.eventRouter.emitPersisted({
      sessionId,
      turnId,
      type: RUNTIME_EVENTS.APPROVAL_REQUESTED,
      data: {
        approvalId,
        callId,
        tool,
        riskLevel,
        effectClass,
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
        resolveDecision(false);
      }, 10 * 60 * 1000);
      timer.unref?.();

      this.pendingApprovals.set(approvalId, {
        resolve: (allowed) => {
          cleanup();
          resolveDecision(allowed);
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
