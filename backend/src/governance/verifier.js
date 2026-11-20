import { existsSync } from 'node:fs';
import { verifyTurn } from '../verifier.js';
import { resolveConfinedPath } from '../tools/sandbox.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';

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
    workspaceRoot = null,
  } = {}) {
    const reasons = [];
    const checks = {
      pendingReconciliations: 0,
      failedShellReceipts: 0,
      missingDiskFiles: [],
    };

    let turnReceipts = [];
    if (this.store?.db && sessionId) {
      const pendingUnknown = this.store.db
        .prepare(
          "SELECT id, toolName FROM tool_receipts WHERE sessionId=? AND status='outcome_unknown'",
        )
        .all(sessionId);
      const pendingAppr = this.store.db
        .prepare(
          "SELECT id, tool FROM direct_approvals WHERE sessionId=? AND kind='reconciliation' AND status='pending'",
        )
        .all(sessionId);
      checks.pendingReconciliations = pendingUnknown.length + pendingAppr.length;
      if (checks.pendingReconciliations > 0) {
        const blocker = {
          verdict: 'block_reconciliation',
          accepted: false,
          reasons: [
            `存在 ${checks.pendingReconciliations} 个状态未知的外部副作用 (outcome_unknown)，需人工核对后方可完成`,
          ],
          evidenceCount: pendingUnknown.length,
          checks,
        };
        this.#emitVerdict(sessionId, turnId, blocker);
        return blocker;
      }

      turnReceipts = turnId
        ? this.store.db
            .prepare(
              'SELECT * FROM tool_receipts WHERE sessionId=? AND turnId=? ORDER BY createdAt ASC',
            )
            .all(sessionId, turnId)
        : this.store.db
            .prepare('SELECT * FROM tool_receipts WHERE sessionId=? ORDER BY createdAt ASC')
            .all(sessionId);
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

    const out = {
      verdict: reasons.length ? 'fail' : 'pass',
      accepted: reasons.length === 0,
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
