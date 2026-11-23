import { existsSync } from 'node:fs';
import { verifyTurn } from '../verifier.js';
import { resolveConfinedPath } from '../tools/sandbox.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import {
  classifyMutationPath,
  extractFailureFingerprint,
  extractMutatedFilesFromToolCall,
  isVerificationCommand,
  safeParseToolArgs,
} from '../kernel/execution-reasoning.js';
import { buildPlainTextPassVerdict } from '../kernel/verdict.js';
import { classifyJobOwnership } from '../durable/lease-guard.js';
import { validateEvidenceManifest } from '../evaluation/schemas.js';
import { listWorkspaceChangedFiles } from '../evaluation/fixtures.js';

const PASS_CLAIM_RE =
  /(?:全部|所有|tests?|suites?|checks?|build|lint|typecheck|npm run check).*?(?:pass(?:ed|es)?|通过|成功|0\s*(?:fail(?:ure)?s?|errors?))|(?:验证通过|测试通过|构建成功|编译通过|0\s*(?:failures|errors))/i;

const POST_EDIT_FILE_MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch']);

function findUnresolvedVerification(receipts, events, workspaceRoot, callsById = new Map()) {
  const resultsByKey = new Map();
  for (const ev of events) {
    const { receipt, effectiveArgs, callId } = ev.data ?? {};
    if (ev.type === 'tool/result' && effectiveArgs) {
      if (receipt?.id) resultsByKey.set(`id:${receipt.id}`, effectiveArgs);
      const cid = receipt?.callId ?? callId;
      if (cid) resultsByKey.set(`call:${cid}`, effectiveArgs);
    }
  }
  const latestByCommand = new Map();
  for (const receipt of receipts) {
    if (receipt.toolName !== 'bash') continue;
    const args =
      (receipt.id ? resultsByKey.get(`id:${receipt.id}`) : null) ??
      (receipt.callId ? resultsByKey.get(`call:${receipt.callId}`) : null) ??
      (receipt.callId ? callsById.get(receipt.callId)?.args : null) ??
      receipt.args ??
      null;
    if (!isVerificationCommand(args?.command)) continue;
    let cwd = args.cwd || '.';
    if (workspaceRoot) {
      try { cwd = resolveConfinedPath(workspaceRoot, cwd).rel; } catch { /* keep raw cwd */ }
    }
    const key = JSON.stringify([receipt.sessionId ?? null, cwd, args.command.trim()]);
    // Rejections are unsuccessful attempts; they must not turn a failing check green.
    latestByCommand.set(key, { receipt, command: args.command.trim(), cwd });
  }
  const failed = [...latestByCommand.values()].findLast(
    ({ receipt }) => receipt.status !== 'finished' || receipt.exitCode !== 0,
  );
  return failed ?? null;
}

const DELETE_SEGMENT_RE =
  /^\s*(?:sudo\s+|cmd(?:\.exe)?\s+\/[cq]\s+|powershell(?:\.exe)?\s+(?:-\w+\s+)*)?(?:rm|rmdir|unlink|del|erase|remove-item|ri|git\s+rm)\b/i;

const PROGRAMMATIC_DELETE_RE =
  /\b(?:fs\.(?:promises\.)?)?(?:unlink|rm)(?:Sync)?\s*\(|\bos\.(?:remove|unlink)\s*\(/;

function safeToolArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object') return rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function commandMentionsPath(text, rel) {
  const posix = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!posix) return false;
  const win = posix.replace(/\//g, '\\');
  const escaped = [...new Set([posix, win])].map((p) =>
    p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const prefix = '(?:^|[\\s"\'`=(,;]|\\.[\\\\/])';
  const suffix = '(?=$|[\\s"\'`),;])';
  const exactRe = new RegExp(`${prefix}(?:${escaped.join('|')})${suffix}`);
  if (exactRe.test(text)) return true;
  const slashIdx = posix.lastIndexOf('/');
  if (slashIdx > 0) {
    const dir = posix.slice(0, slashIdx);
    const base = posix.slice(slashIdx + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dirMentioned = text.includes(dir) || text.includes(dir.replace(/\//g, '\\'));
    const baseRe = new RegExp(`${prefix}${base}${suffix}`);
    return dirMentioned && baseRe.test(text);
  }
  return false;
}

function isExplicitFileDeleteCommand(command, rel) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const segments = command.split(/(?:&&|\|\||[;\n|{}])+/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    if (
      (DELETE_SEGMENT_RE.test(trimmed) || PROGRAMMATIC_DELETE_RE.test(trimmed)) &&
      commandMentionsPath(trimmed, rel)
    ) {
      return true;
    }
  }
  return false;
}

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
    reasoningState = null,
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

    // 1. Baseline verifier checks
    const base = verifyTurn({ events, text, node, execution });
    if (base && base.verdict !== 'pass' && Array.isArray(base.reasons)) {
      reasons.push(...base.reasons);
    }

    // Collect tool call arguments from DB messages + live events so verification and mutation
    // timeline checks work identically with or without a live Store/event pair.
    const callsById = new Map();
    const callCommands = new Map();
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
              const args = safeParseToolArgs(tc.arguments);
              callsById.set(tc.id, { index: -1, name: tc.name ?? '', args });
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
    for (let idx = 0; idx < events.length; idx += 1) {
      const ev = events[idx];
      if (ev.type === 'tool/call' && ev.data?.callId) {
        const args = safeToolArgs(ev.data?.arguments);
        callsById.set(ev.data.callId, {
          index: idx,
          name: ev.data?.name ?? '',
          args,
        });
        if (typeof args?.command === 'string') {
          callCommands.set(ev.data.callId, args.command);
        }
      }
    }

    const receiptById = new Map();
    const receiptByCallId = new Map();
    for (const r of turnReceipts) {
      if (r.id) receiptById.set(r.id, r);
      if (r.callId) receiptByCallId.set(r.callId, r);
    }

    const seenReceiptIds = new Set();
    const seenCallIds = new Set();
    const orderedToolRuns = [];
    for (const ev of events) {
      if (ev.type !== 'tool/result') continue;
      const cid = ev.data?.receipt?.callId ?? ev.data?.callId ?? null;
      const callInfo = cid ? callsById.get(cid) : null;
      const dbReceipt =
        (ev.data?.receipt?.id ? receiptById.get(ev.data.receipt.id) : null) ??
        (cid ? receiptByCallId.get(cid) : null);
      const receipt = dbReceipt ?? ev.data?.receipt ?? null;
      if (dbReceipt?.id) seenReceiptIds.add(dbReceipt.id);
      if (cid) seenCallIds.add(cid);

      const toolName = ev.data?.name ?? receipt?.toolName ?? callInfo?.name ?? '';
      const args = ev.data?.effectiveArgs ?? callInfo?.args ?? safeToolArgs(ev.data?.arguments);
      const status = receipt?.status ?? (ev.data?.isError ? 'failed' : 'finished');
      const exitCode =
        receipt?.exitCode !== undefined && receipt?.exitCode !== null
          ? receipt.exitCode
          : ev.data?.isError
            ? 1
            : 0;
      const isError =
        Boolean(ev.data?.isError) ||
        status === 'failed' ||
        status === 'rejected_before_effect' ||
        (typeof exitCode === 'number' && exitCode !== 0);
      const output = typeof ev.data?.content === 'string' ? ev.data.content : '';
      orderedToolRuns.push({
        toolName,
        args,
        status,
        exitCode,
        isError,
        receipt,
        callId: cid ?? receipt?.callId ?? null,
        output,
      });
    }
    for (const r of turnReceipts) {
      if ((r.id && seenReceiptIds.has(r.id)) || (r.callId && seenCallIds.has(r.callId))) {
        continue;
      }
      const callInfo = r.callId ? callsById.get(r.callId) : null;
      const isError = r.status === 'failed' || (typeof r.exitCode === 'number' && r.exitCode !== 0);
      orderedToolRuns.push({
        toolName: r.toolName,
        args: callInfo?.args ?? {},
        status: r.status,
        exitCode: r.exitCode,
        isError,
        receipt: r,
        callId: r.callId ?? null,
        output: '',
      });
    }

    // 2. Cross-check pass/success claims and post-edit verification against real receipts/timeline
    const shellReceipts = turnReceipts.filter((r) =>
      ['bash', 'start_process'].includes(r.toolName),
    );
    const effectiveShellReceipts =
      shellReceipts.length > 0
        ? shellReceipts
        : orderedToolRuns
            .filter((run) => ['bash', 'start_process'].includes(run.toolName))
            .map((run, idx) => ({
              id: run.receipt?.id ?? run.callId ?? `event-shell-${idx}`,
              callId: run.callId ?? run.receipt?.callId ?? `event-shell-${idx}`,
              sessionId: sessionId ?? 'event-session',
              toolName: run.toolName,
              status: run.status,
              exitCode: run.exitCode,
              args: run.args,
            }));

    const failedShells = effectiveShellReceipts.filter(
      (r) => r.status === 'failed' || (typeof r.exitCode === 'number' && r.exitCode !== 0),
    );
    const latestShell = effectiveShellReceipts.at(-1);
    const unresolvedShellFailure =
      failedShells.length > 0 &&
      (!latestShell || latestShell.status === 'failed' || (latestShell.exitCode ?? 0) !== 0);
    checks.failedShellReceipts = failedShells.length;

    const allMutatedFiles = [];
    const allMutatedSet = new Set();
    let lastPassingVerification = null;
    let mutatedAfterLastPass = [];
    let mutatedAfterLastPassSet = new Set();
    let mutatedDocAfterLastPass = [];
    let mutatedDocAfterLastPassSet = new Set();
    let verificationRunsCount = 0;
    let latestFailureRun = null;
    const failureRunByCallId = new Map();
    const baselineTestFiles =
      execution?.baselineTestFiles ?? node?.baselineTestFiles ?? [];

    for (let idx = 0; idx < orderedToolRuns.length; idx += 1) {
      const run = orderedToolRuns[idx];
      if (
        POST_EDIT_FILE_MUTATION_TOOLS.has(run.toolName) &&
        !run.isError &&
        run.status !== 'rejected_before_effect' &&
        run.status !== 'outcome_unknown'
      ) {
        const files = extractMutatedFilesFromToolCall(run.toolName, run.args, workspaceRoot);
        for (const f of files) {
          if (!allMutatedSet.has(f)) {
            allMutatedSet.add(f);
            allMutatedFiles.push(f);
          }
          if (lastPassingVerification) {
            const mutKind = classifyMutationPath(f, {
              workspaceRoot,
              baselineTestFiles,
            });
            if (mutKind === 'doc') {
              if (!mutatedDocAfterLastPassSet.has(f)) {
                mutatedDocAfterLastPassSet.add(f);
                mutatedDocAfterLastPass.push(f);
              }
            } else if (!mutatedAfterLastPassSet.has(f)) {
              mutatedAfterLastPassSet.add(f);
              mutatedAfterLastPass.push(f);
            }
          }
        }
      } else if (run.toolName === 'bash' && isVerificationCommand(run.args?.command)) {
        verificationRunsCount += 1;
        const passed =
          run.status === 'finished' &&
          !run.isError &&
          (run.exitCode === 0 || run.exitCode === null || run.exitCode === undefined);
        if (passed) {
          lastPassingVerification = {
            index: idx,
            command: run.args.command.trim(),
            callId: run.callId,
          };
          mutatedAfterLastPass = [];
          mutatedAfterLastPassSet = new Set();
          mutatedDocAfterLastPass = [];
          mutatedDocAfterLastPassSet = new Set();
        } else {
          const fp = run.output
            ? extractFailureFingerprint({
                toolName: run.toolName,
                args: run.args,
                output: run.output,
                receipt: run.receipt,
                workspaceRoot,
              })
            : null;
          const failInfo = {
            command: run.args.command.trim(),
            exitCode: run.exitCode,
            output: run.output,
            callId: run.callId,
            fingerprint: fp,
          };
          latestFailureRun = failInfo;
          if (run.callId) failureRunByCallId.set(run.callId, failInfo);
        }
      }
    }

    const unresolvedEntry = findUnresolvedVerification(
      effectiveShellReceipts,
      events,
      workspaceRoot,
      callsById,
    );
    const unresolvedCheck = unresolvedEntry?.receipt ?? null;
    const unresolvedCommand = unresolvedEntry?.command ?? null;
    const hasPassClaim = PASS_CLAIM_RE.test(String(text || ''));
    if (hasPassClaim && (unresolvedCheck || unresolvedShellFailure)) {
      if (unresolvedCheck) {
        reasons.push(
          `FABRICATED_PASS_CLAIM: 验证命令未成功 (callId=${unresolvedCheck.callId}, exitCode=${unresolvedCheck.exitCode ?? 'unknown'})。请修复后在同一目录重跑原验证命令，或如实报告未通过。`,
        );
      } else {
        reasons.push(
          `FABRICATED_PASS_CLAIM: 最近命令执行失败 (exitCode=${latestShell?.exitCode ?? 'non-zero'})，不得声称验证或构建通过`,
        );
      }
    }

    const contract = execution?.evidenceContract ?? node?.evidenceContract ?? null;
    const requirePostEditVerification = Boolean(execution?.requirePostEditVerification);
    checks.mutatedFiles = [...allMutatedFiles];

    const staleAfterEdit = Boolean(lastPassingVerification && mutatedAfterLastPass.length > 0);
    checks.staleVerificationAfterEdit = staleAfterEdit;
    checks.mutatedFilesAfterVerification = [...mutatedAfterLastPass];
    checks.mutatedDocFilesAfterVerification = [...mutatedDocAfterLastPass];
    if (staleAfterEdit) {
      checks.lastPassingVerificationCommand = lastPassingVerification.command;
      reasons.push(
        `STALE_VERIFICATION_AFTER_EDIT: 文件 (${mutatedAfterLastPass.join(', ')}) 在上次验证通过 (${lastPassingVerification.command}) 之后被修改，且修改后未重新运行通过的验证命令。`,
      );
    }

    let diagnosticExcerpt = null;
    let failureFingerprint = null;
    const hasActivePostEditGate =
      allMutatedFiles.length > 0 || Boolean(contract) || requirePostEditVerification;
    if (unresolvedCheck && hasActivePostEditGate) {
      const matchingFailure =
        (unresolvedCheck.callId ? failureRunByCallId.get(unresolvedCheck.callId) : null) ??
        latestFailureRun;
      failureFingerprint =
        matchingFailure?.fingerprint ??
        reasoningState?.errorFingerprints?.at(-1) ??
        null;
      diagnosticExcerpt =
        failureFingerprint?.summary ??
        (matchingFailure?.output ? matchingFailure.output.slice(0, 200).trim() : null);
      checks.unresolvedVerificationFailure = true;
      if (unresolvedCommand) checks.unresolvedVerificationCommand = unresolvedCommand;
      if (diagnosticExcerpt) checks.diagnosticExcerpt = diagnosticExcerpt;
      reasons.push(
        `UNRESOLVED_VERIFICATION_FAILURE: 最新验证命令 (${unresolvedCommand || 'verification'}, callId=${unresolvedCheck.callId ?? 'unknown'}, exitCode=${unresolvedCheck.exitCode ?? 'unknown'}) 仍未通过${diagnosticExcerpt ? ` (${diagnosticExcerpt})` : ''}。请先定位根因修复后再重跑验证。`,
      );
    } else {
      checks.unresolvedVerificationFailure = false;
    }

    if (requirePostEditVerification && allMutatedFiles.length > 0 && verificationRunsCount === 0 && !contract) {
      checks.postEditVerificationMissing = true;
      reasons.push(
        `POST_EDIT_VERIFICATION_MISSING: 文件 (${allMutatedFiles.join(', ')}) 已修改，但本轮尚未运行任何验证命令。`,
      );
    }

    // 3. Verify claimed file mutations exist on disk when workspaceRoot is supplied
    if (workspaceRoot && events.length) {
      const okWritePaths = new Set();
      const succeededWriteCallIds = new Set();
      const callsById = new Map();
      const latestWriteIndex = new Map();
      const resolvedPaths = new Map();
      const deletionEvents = [];

      for (let idx = 0; idx < events.length; idx += 1) {
        const ev = events[idx];
        if (ev.type === 'tool/call' && ev.data?.callId) {
          callsById.set(ev.data.callId, {
            index: idx,
            name: ev.data?.name,
            args: safeToolArgs(ev.data?.arguments),
          });
        }
        if (ev.type === 'tool/result' && !ev.data?.isError) {
          const cid = ev.data?.receipt?.callId ?? ev.data?.callId ?? null;
          if (['write_file', 'edit_file'].includes(ev.data?.name)) {
            if (cid) succeededWriteCallIds.add(cid);
            else okWritePaths.add('*');
          } else if (['bash', 'delete_file'].includes(ev.data?.name)) {
            const exitCode = ev.data?.receipt?.exitCode ?? ev.data?.exitCode;
            if (typeof exitCode === 'number' && exitCode !== 0) continue;
            const call = cid ? callsById.get(cid) : null;
            const args = call?.args ?? safeToolArgs(ev.data?.arguments);
            deletionEvents.push({
              index: idx,
              callIndex: call?.index ?? idx,
              name: ev.data?.name,
              args,
            });
          }
        }
      }

      for (let idx = 0; idx < events.length; idx += 1) {
        const ev = events[idx];
        if (
          ev.type === 'tool/call' &&
          ['write_file', 'edit_file'].includes(ev.data?.name) &&
          (succeededWriteCallIds.has(ev.data?.callId) || okWritePaths.has('*'))
        ) {
          const args = safeToolArgs(ev.data?.arguments);
          if (!args.path) continue;
          try {
            const { full, rel } = resolveConfinedPath(workspaceRoot, args.path);
            resolvedPaths.set(rel, full);
            latestWriteIndex.set(rel, Math.max(latestWriteIndex.get(rel) ?? -1, idx));
          } catch {
            // Path outside workspace was already blocked before execution
          }
        }
      }

      const requiredPaths = new Set();
      for (const reqPath of [
        ...(Array.isArray(node?.requiredFiles) ? node.requiredFiles : []),
        ...(Array.isArray(contract?.requiredChangedFiles) ? contract.requiredChangedFiles : []),
      ]) {
        try {
          const { rel } = resolveConfinedPath(workspaceRoot, reqPath);
          requiredPaths.add(rel);
        } catch {
          // ignore unresolvable requirement path here
        }
      }

      const cleanedUpFiles = [];
      for (const [rel, full] of resolvedPaths.entries()) {
        if (existsSync(full)) continue;
        const lastWriteIdx = latestWriteIndex.get(rel) ?? -1;
        let explicitlyDeleted = false;
        if (!requiredPaths.has(rel)) {
          for (const delEv of deletionEvents) {
            if (delEv.callIndex <= lastWriteIdx) continue;
            if (delEv.name === 'delete_file' && delEv.args?.path) {
              try {
                if (resolveConfinedPath(workspaceRoot, delEv.args.path).rel === rel) {
                  explicitlyDeleted = true;
                  break;
                }
              } catch {
                // ignore invalid path
              }
            } else if (
              delEv.name === 'bash' &&
              isExplicitFileDeleteCommand(delEv.args?.command, rel)
            ) {
              explicitlyDeleted = true;
              break;
            }
          }
        }
        if (explicitlyDeleted) {
          cleanedUpFiles.push(rel);
        } else {
          checks.missingDiskFiles.push(rel);
        }
      }
      if (cleanedUpFiles.length > 0) {
        checks.cleanedUpTempFiles = cleanedUpFiles;
      }
      if (checks.missingDiskFiles.length > 0) {
        reasons.push(
          `DISK_FILE_MISSING: 声明写入的工作区文件在磁盘上不存在: ${checks.missingDiskFiles.join(', ')}`,
        );
      }
    }
    let contractValidation = null;
    if (contract) {
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
            ...(diagnosticExcerpt ? { diagnosticExcerpt } : {}),
            ...(failureFingerprint ? { failureFingerprint } : {}),
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
