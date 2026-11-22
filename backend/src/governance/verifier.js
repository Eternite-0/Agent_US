import { existsSync } from 'node:fs';
import { verifyTurn } from '../verifier.js';
import { resolveConfinedPath } from '../tools/sandbox.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import { buildPlainTextPassVerdict } from '../kernel/verdict.js';
import { classifyJobOwnership } from '../durable/lease-guard.js';
import { validateEvidenceManifest } from '../evaluation/schemas.js';
import { listWorkspaceChangedFiles } from '../evaluation/fixtures.js';

const PASS_CLAIM_RE =
  /(?:全部|所有|tests?|suites?|checks?|build|lint|typecheck|npm run check).*?(?:pass(?:ed|es)?|通过|成功|0\s*(?:fail(?:ure)?s?|errors?))|(?:验证通过|测试通过|构建成功|编译通过|0\s*(?:failures|errors))/i;

/**
 * Layer 3/6 EvidenceVerifier & CompletionGate:
 * Prevents hallucinated completion claims by checking durable `tool_receipts`,
 * pending `outcome_unknown` reconciliations, and workspace disk existence.
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
      missingDiskFiles: [],
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

      // Also detect stranded/orphaned 'executing' non-replayable/outward receipts (P0-2)
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
        // Inside the turn(s) currently at idle/final verification, no tool can legitimately still be executing
        if (r.turnId && verifiedTurnSet.has(r.turnId)) {
          strandedExecuting.push(r);
          continue;
        }
        // For receipts from other turns in the same session, check whether a live owner still holds the job
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
            `SELECT * FROM tool_receipts WHERE sessionId IN (${sPh}) AND turnId IN (${tPh}) ORDER BY createdAt ASC`,
          )
          .all(...allSessionIds, ...allTurnIds);
      } else {
        turnReceipts = this.store.db
          .prepare(
            `SELECT * FROM tool_receipts WHERE sessionId IN (${sPh}) ORDER BY createdAt ASC`,
          )
          .all(...allSessionIds);
      }
    }

    // 1. Baseline verifier checks
    const base = verifyTurn({ events, text, node, execution });
    if (base && base.verdict !== 'pass' && Array.isArray(base.reasons)) {
      reasons.push(...base.reasons);
    }

    // 2. Cross-check pass/success claims against real bash / process receipts
    const shellReceipts = turnReceipts.filter((r) =>
      ['bash', 'start_process'].includes(r.toolName),
    );
    const failedShells = shellReceipts.filter(
      (r) => r.status === 'failed' || (typeof r.exitCode === 'number' && r.exitCode !== 0),
    );
    const latestShell = shellReceipts.at(-1);
    const unresolvedShellFailure =
      failedShells.length > 0 &&
      (!latestShell || latestShell.status === 'failed' || (latestShell.exitCode ?? 0) !== 0);
    checks.failedShellReceipts = failedShells.length;

    if (PASS_CLAIM_RE.test(String(text || '')) && unresolvedShellFailure) {
      reasons.push(
        `FABRICATED_PASS_CLAIM: 最近命令执行失败 (exitCode=${latestShell?.exitCode ?? 'non-zero'})，不得声称验证或构建通过`,
      );
    }

    // 3. Verify claimed file mutations exist on disk when workspaceRoot is supplied
    if (workspaceRoot && events.length) {
      const okWritePaths = new Set();
      const succeededWriteCallIds = new Set();
      for (const ev of events) {
        if (ev.type === 'tool/result' && ['write_file', 'edit_file'].includes(ev.data?.name) && !ev.data?.isError) {
          if (ev.data?.receipt?.callId) succeededWriteCallIds.add(ev.data.receipt.callId);
          else okWritePaths.add('*');
        }
      }
      for (const ev of events) {
        if (
          ev.type === 'tool/call' &&
          ['write_file', 'edit_file'].includes(ev.data?.name) &&
          ev.data?.arguments?.path &&
          (succeededWriteCallIds.has(ev.data?.callId) || okWritePaths.has('*'))
        ) {
          try {
            const { full, rel } = resolveConfinedPath(workspaceRoot, ev.data.arguments.path);
            if (!existsSync(full)) {
              checks.missingDiskFiles.push(rel);
            }
          } catch {
            // Path outside workspace was already blocked before execution
          }
        }
      }
      if (checks.missingDiskFiles.length > 0) {
        reasons.push(
          `DISK_FILE_MISSING: 声明写入的工作区文件在磁盘上不存在: ${checks.missingDiskFiles.join(', ')}`,
        );
      }
    }

    const contract = execution?.evidenceContract ?? node?.evidenceContract ?? null;
    let contractValidation = null;
    if (contract) {
      const callCommands = new Map();
      for (const ev of events) {
        if (ev.type === 'tool/call' && ev.data?.callId) {
          const cmd = ev.data?.arguments?.command;
          if (typeof cmd === 'string') callCommands.set(ev.data.callId, cmd);
        }
      }
      if (this.store?.db?.isOpen && allSessionIds.length > 0) {
        try {
          const sPh = allSessionIds.map(() => '?').join(',');
          const msgRows = allTurnIds.length > 0
            ? this.store.db
                .prepare(`SELECT toolCalls FROM direct_messages WHERE sessionId IN (${sPh}) AND turnId IN (${allTurnIds.map(() => '?').join(',')}) AND role='assistant' AND toolCalls IS NOT NULL`)
                .all(...allSessionIds, ...allTurnIds)
            : this.store.db
                .prepare(`SELECT toolCalls FROM direct_messages WHERE sessionId IN (${sPh}) AND role='assistant' AND toolCalls IS NOT NULL`)
                .all(...allSessionIds);
          for (const row of msgRows) {
            try {
              const calls = JSON.parse(row.toolCalls);
              if (!Array.isArray(calls)) continue;
              for (const tc of calls) {
                if (!tc?.id) continue;
                const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
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

      const receiptsForContract = turnReceipts.length > 0
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
      const actualChangedFiles = contractWorkspace ? listWorkspaceChangedFiles(contractWorkspace) : undefined;
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
            ...(contractValidation && !contractValidation.valid ? { status: contractValidation.status, missingFields: contractValidation.missingFields, expectedTestCommand: contract.expectedTestCommand, actualChangedFiles: checks.evidenceContract ? (contract.workspaceRoot || workspaceRoot ? listWorkspaceChangedFiles(contract.workspaceRoot || workspaceRoot) : undefined) : undefined } : {}),
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
