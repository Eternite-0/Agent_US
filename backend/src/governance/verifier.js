import { verifyTurn } from '../verifier.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import { buildPlainTextPassVerdict } from '../kernel/verdict.js';
import { classifyJobOwnership } from '../durable/lease-guard.js';
import { validateEvidenceManifest } from '../evaluation/schemas.js';
import { listWorkspaceChangedFiles } from '../evaluation/fixtures.js';

function safeParseToolArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object' && !Array.isArray(rawArgs)) return rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Layer 3/6 EvidenceVerifier & Reconciliation Gate:
 * Enforces durable reconciliation locks for `outcome_unknown` / stranded non-replayable
 * external side effects, records factual receipt telemetry, and validates explicit
 * opt-in `evidenceContract` manifests without post-hoc heuristic closing vetoes.
 */
export class EvidenceVerifier {
  constructor({ store = null, eventRouter = null } = {}) {
    this.store = store;
    this.eventRouter = eventRouter;
  }

  verify({
    events = [],
    text = '',
    node = null,
    execution = null,
    sessionId = null,
    turnId = null,
    sessionIds = null,
    turnIds = null,
    workspaceRoot = null,
  } = {}) {
    const reasons = [];
    const checks = {
      pendingReconciliations: 0,
      failedShellReceipts: 0,
    };

    const allSessionIds = [
      ...new Set(
        [sessionId, ...(Array.isArray(sessionIds) ? sessionIds : [])].filter(Boolean),
      ),
    ];
    const allTurnIds = [
      ...new Set(
        [turnId, ...(Array.isArray(turnIds) ? turnIds : [])].filter(Boolean),
      ),
    ];

    let turnReceipts = [];
    if (this.store?.db?.isOpen && allSessionIds.length > 0) {
      const sPh = allSessionIds.map(() => '?').join(',');
      const pendingUnknown = this.store.db
        .prepare(
          `SELECT id, toolName FROM tool_receipts WHERE sessionId IN (${sPh}) AND status='outcome_unknown'`,
        )
        .all(...allSessionIds);
      const pendingAppr = this.store.db
        .prepare(
          `SELECT id, tool FROM direct_approvals WHERE sessionId IN (${sPh}) AND kind='reconciliation' AND status='pending'`,
        )
        .all(...allSessionIds);

      // Detect stranded/orphaned 'executing' non-replayable/outward receipts
      const executingNonReplay = this.store.db
        .prepare(
          `SELECT id, toolName, turnId, sessionId FROM tool_receipts
           WHERE sessionId IN (${sPh}) AND status='executing' AND (replayable = 0 OR outward = 1)`,
        )
        .all(...allSessionIds);
      const verifiedTurnSet = new Set(allTurnIds);
      const strandedExecuting = [];
      const now = Date.now();
      for (const r of executingNonReplay) {
        if (r.turnId && verifiedTurnSet.has(r.turnId)) {
          strandedExecuting.push(r);
          continue;
        }
        let liveOwned = false;
        if (r.turnId) {
          const activeJobs = this.store.db
            .prepare("SELECT * FROM runtime_jobs WHERE turnId=? AND status='active'")
            .all(r.turnId);
          liveOwned = activeJobs.some((j) => classifyJobOwnership(this.store, j, { now }).liveOwner);
        }
        if (!liveOwned) {
          strandedExecuting.push(r);
        }
      }

      checks.pendingReconciliations =
        pendingUnknown.length + pendingAppr.length + strandedExecuting.length;
      if (checks.pendingReconciliations > 0) {
        const blocker = {
          verdict: 'block_reconciliation',
          accepted: false,
          evidenceRequired: true,
          verificationMode: 'reconciliation_gate',
          reasons: [
            `存在 ${checks.pendingReconciliations} 个状态未知或未收敛的外部副作用 (outcome_unknown/executing)，需人工核对后方可完成`,
          ],
          evidenceCount: pendingUnknown.length + strandedExecuting.length,
          checks,
        };
        if (sessionId) this.#emitVerdict(sessionId, turnId, blocker);
        return blocker;
      }

      if (allTurnIds.length > 0) {
        const tPh = allTurnIds.map(() => '?').join(',');
        turnReceipts = this.store.db
          .prepare(
            `SELECT * FROM tool_receipts WHERE sessionId IN (${sPh}) AND turnId IN (${tPh}) ORDER BY createdAt ASC, rowid ASC`,
          )
          .all(...allSessionIds, ...allTurnIds);
      } else {
        turnReceipts = this.store.db
          .prepare(
            `SELECT * FROM tool_receipts WHERE sessionId IN (${sPh}) ORDER BY createdAt ASC, rowid ASC`,
          )
          .all(...allSessionIds);
      }
    }

    // 1. Baseline turn checks
    const base = verifyTurn({ events, text, node, execution });
    if (base && base.verdict !== 'pass' && Array.isArray(base.reasons)) {
      reasons.push(...base.reasons);
    }

    // 2. Observational telemetry for shell receipts (never vetoes normal completion)
    checks.failedShellReceipts = turnReceipts.filter(
      (r) =>
        ['bash', 'start_process'].includes(r.toolName) &&
        (r.status === 'failed' ||
          r.status === 'rejected_before_effect' ||
          (typeof r.exitCode === 'number' && r.exitCode !== 0)),
    ).length;

    // 3. Explicit opt-in evidenceContract manifest validation (when caller requests structured evidence)
    const contract = execution?.evidenceContract ?? node?.evidenceContract ?? null;
    let contractValidation = null;
    let actualChangedFiles = undefined;
    if (contract) {
      const callCommands = new Map();
      if (this.store?.db?.isOpen && allSessionIds.length > 0) {
        try {
          const sPh = allSessionIds.map(() => '?').join(',');
          const msgRows =
            allTurnIds.length > 0
              ? this.store.db
                  .prepare(
                    `SELECT toolCalls FROM direct_messages WHERE sessionId IN (${sPh}) AND turnId IN (${allTurnIds.map(() => '?').join(',')}) AND role='assistant' AND toolCalls IS NOT NULL`,
                  )
                  .all(...allSessionIds, ...allTurnIds)
              : this.store.db
                  .prepare(
                    `SELECT toolCalls FROM direct_messages WHERE sessionId IN (${sPh}) AND role='assistant' AND toolCalls IS NOT NULL`,
                  )
                  .all(...allSessionIds);
          for (const row of msgRows) {
            try {
              const calls = JSON.parse(row.toolCalls);
              if (!Array.isArray(calls)) continue;
              for (const tc of calls) {
                if (!tc?.id) continue;
                const args = safeParseToolArgs(tc.arguments);
                if (typeof args?.command === 'string') callCommands.set(tc.id, args.command);
              }
            } catch {
              // ignore unparseable historical toolCalls
            }
          }
        } catch {
          // table unavailable in minimal store mocks
        }
      }
      for (const ev of events) {
        if (ev.type === 'tool/call' && ev.data?.callId) {
          const args = safeParseToolArgs(ev.data?.arguments);
          if (typeof args?.command === 'string') {
            callCommands.set(ev.data.callId, args.command);
          }
        }
      }

      const receiptsForContract =
        turnReceipts.length > 0
          ? turnReceipts.map((r) => ({ ...r, command: callCommands.get(r.callId) ?? '' }))
          : events
              .filter((ev) => ev.type === 'tool/result')
              .map((ev) => {
                const cid = ev.data?.callId ?? ev.data?.receipt?.callId ?? null;
                const name = ev.data?.name ?? ev.data?.receipt?.toolName ?? '';
                return {
                  id: ev.data?.receipt?.id ?? cid ?? 'event-receipt',
                  callId: cid,
                  toolName: name,
                  status: ev.data?.receipt?.status ?? (ev.data?.isError ? 'failed' : 'finished'),
                  exitCode: ev.data?.receipt?.exitCode ?? (ev.data?.isError ? 1 : 0),
                  command: (cid ? callCommands.get(cid) : '') ?? '',
                };
              });

      const contractWorkspace = contract.workspaceRoot || workspaceRoot || null;
      actualChangedFiles = contractWorkspace ? listWorkspaceChangedFiles(contractWorkspace) : undefined;
      contractValidation = validateEvidenceManifest(text, {
        ...contract,
        workspaceRoot: contractWorkspace,
        actualChangedFiles,
        toolReceipts: receiptsForContract,
        requireIndependentVerdict: contract.requireIndependentVerdict === true,
      });
      checks.manifestStatus = contractValidation.status;
      checks.missingFields = contractValidation.missingFields;
      checks.evidenceContract = contractValidation.checks;
      if (!contractValidation.valid) {
        const detail = contractValidation.missingFields.length
          ? `missing=${contractValidation.missingFields.join(',')}`
          : contractValidation.errors.join('; ');
        reasons.push(`${contractValidation.status}: ${detail}`);
      }
    }

    const hasToolActivity =
      events.some((e) => e.type === 'tool/call' || e.type === 'tool/result') ||
      turnReceipts.length > 0 ||
      Boolean(node?.requiredFiles?.length) ||
      Boolean(contract);

    const out =
      reasons.length === 0 && !hasToolActivity
        ? buildPlainTextPassVerdict(checks)
        : {
            verdict: reasons.length ? 'fail' : 'pass',
            ...(contractValidation && !contractValidation.valid
              ? {
                  status: contractValidation.status,
                  missingFields: contractValidation.missingFields,
                  expectedTestCommand: contract.expectedTestCommand,
                  actualChangedFiles,
                }
              : {}),
            accepted: reasons.length === 0,
            evidenceRequired: true,
            verificationMode: contract ? 'evidence_contract_checked' : 'evidence_checked',
            reasons,
            evidenceCount: turnReceipts.length,
            checks,
          };
    if (sessionId) this.#emitVerdict(sessionId, turnId, out);
    return out;
  }

  #emitVerdict(sessionId, turnId, verdict) {
    this.eventRouter?.emitPersisted({
      sessionId,
      turnId,
      type: RUNTIME_EVENTS.VERIFIER_VERDICT,
      data: verdict,
      audit: true,
    });
  }
}
