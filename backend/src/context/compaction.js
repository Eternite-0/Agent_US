import { id as uuid } from '../store.js';
import { compactTwoStage } from '../context.js';
import { TokenBudgetManager } from './budget.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

const CONSTRAINT_RE =
  /(?:必须|不要|禁止|务必|严格|保留|只能|不能|never|must|do not|don't|always|constraint|require)/i;

const ACCEPTANCE_RE =
  /(?:acceptance(?:\s+criteria)?|done\s+when|success\s+criteria|exit\s+criteria|verification\s+criteria|验收标准|完成条件|验收要求|通过条件|must\s+pass|all\s+tests?\s+pass|0\s+fail(?:ures)?|0\s+skips?)/i;

const GENERIC_FAILURE_EXCERPT_RE =
  /(?:\b\w*(?:error|exception)\b|\b(?:fail(?:ed|ure)?|fatal|panic|assert(?:ion)?)\b|参数校验失败|安全策略拦截|错误[:：])/i;

function safeGet(db, sql, ...params) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    return db.prepare(sql).get(...params) ?? null;
  } catch {
    return null;
  }
}

function safeAll(db, sql, ...params) {
  if (!db || typeof db.prepare !== 'function') return [];
  try {
    const rows = db.prepare(sql).all(...params);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function parseExitCode(text) {
  const m = String(text ?? '').match(/(?:exitCode|exit\s+code)[:=\s]+(-?\d+)/i);
  if (!m) return null;
  const code = Number(m[1]);
  return Number.isInteger(code) ? code : null;
}

function extractFailureExcerpt(content, maxLen = 280) {
  const lines = String(content ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const diagLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (GENERIC_FAILURE_EXCERPT_RE.test(lines[i])) {
      diagLines.push(lines[i]);
      if (lines[i + 1] && !diagLines.includes(lines[i + 1])) {
        diagLines.push(lines[i + 1]);
      }
      if (diagLines.length >= 4) break;
    }
  }
  const chosen = diagLines.length
    ? diagLines.join(' | ')
    : lines.filter((l) => !/^exitCode:/i.test(l)).slice(-3).join(' | ');
  return chosen.slice(0, maxLen);
}

function normalizeErrorSignature(excerpt) {
  return String(excerpt ?? '')
    .replace(/\b[0-9a-f]{8,64}\b/gi, '<hex>')
    .replace(/\b\d{4,}\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function extractModifiedFilesFromToolCalls(msgRows, existingPaths) {
  const extra = [];
  const seen = new Set(existingPaths);
  for (const r of msgRows) {
    if (r.role !== 'assistant' || !r.toolCalls) continue;
    const calls = parseJsonSafe(r.toolCalls, []);
    if (!Array.isArray(calls)) continue;
    for (const tc of calls) {
      const name = String(tc?.name || '');
      const args =
        typeof tc?.arguments === 'string'
          ? parseJsonSafe(tc.arguments, {})
          : tc?.arguments ?? {};
      if (name === 'write_file' || name === 'edit_file') {
        const p = String(args?.path ?? args?.filePath ?? '').trim();
        if (p && !seen.has(p)) {
          seen.add(p);
          extra.push({ path: p, action: name === 'write_file' ? 'created' : 'modified' });
        }
      } else if (name === 'apply_patch') {
        const patchText = String(args?.patch ?? args?.input ?? '');
        const matches = patchText.matchAll(/^\*\*\*\s+(Add|Update|Delete)\s+File:\s*(.+)$/gm);
        for (const m of matches) {
          const p = String(m[2] || '').trim();
          if (p && !seen.has(p)) {
            seen.add(p);
            const act = m[1] === 'Add' ? 'created' : m[1] === 'Delete' ? 'deleted' : 'modified';
            extra.push({ path: p, action: act });
          }
        }
      }
    }
  }
  return extra;
}

function mergeReasoningStateIntoAnchor(anchor, reasoningState) {
  if (!reasoningState || typeof reasoningState !== 'object') return anchor;

  const modifiedFiles = Array.isArray(anchor.modifiedFiles) ? [...anchor.modifiedFiles] : [];
  const seenPaths = new Set(modifiedFiles.map((f) => f?.path).filter(Boolean));
  for (const rawPath of Array.isArray(reasoningState.filesMutated) ? reasoningState.filesMutated : []) {
    const p = String(rawPath || '').trim();
    if (p && !seenPaths.has(p)) {
      seenPaths.add(p);
      modifiedFiles.push({ path: p, action: 'modified' });
    }
  }

  const fpBySig = new Map();
  for (const fp of Array.isArray(reasoningState.errorFingerprints) ? reasoningState.errorFingerprints : []) {
    if (fp && typeof fp === 'object' && fp.signature) {
      fpBySig.set(String(fp.signature), fp);
    }
  }

  const verificationLedger = Array.isArray(anchor.verificationLedger)
    ? anchor.verificationLedger.map((v) => ({ ...v }))
    : [];
  const vIdxByCmd = new Map();
  verificationLedger.forEach((v, idx) => {
    if (v?.command) vIdxByCmd.set(String(v.command), idx);
  });
  for (const v of Array.isArray(reasoningState.verifications) ? reasoningState.verifications : []) {
    if (!v || typeof v !== 'object') continue;
    const command = String(v.command || v.toolName || 'verification').trim();
    const status = v.passed ? 'pass' : 'fail';
    const sig = String(v.signature || v.fingerprint?.signature || '').trim();
    const matchedFp = sig ? fpBySig.get(sig) : null;
    const failureExcerpt = v.passed
      ? ''
      : (sig
          ? matchedFp?.assertionExcerpt && !sig.includes(matchedFp.assertionExcerpt)
            ? `${sig} | ${matchedFp.assertionExcerpt}`
            : sig
          : String(v.fingerprint?.assertionExcerpt || '').trim()
        ).slice(0, 280);
    const entry = {
      command,
      tool: String(v.toolName || 'bash'),
      exitCode: v.exitCode ?? null,
      status,
      passed: Boolean(v.passed),
      ...(sig ? { signature: sig } : {}),
      failureExcerpt,
      seq: v.seq ?? null,
    };
    const existingIdx = vIdxByCmd.get(command);
    if (existingIdx !== undefined) {
      verificationLedger[existingIdx] = { ...verificationLedger[existingIdx], ...entry };
    } else {
      vIdxByCmd.set(command, verificationLedger.length);
      verificationLedger.push(entry);
    }
  }

  const falsifiedAttempts = Array.isArray(anchor.falsifiedAttempts)
    ? anchor.falsifiedAttempts.map((f) => ({ ...f }))
    : [];
  const seenFalsified = new Set(
    falsifiedAttempts.map((f) => `${String(f.tool || '')}|${String(f.target || '')}|${String(f.errorSignature || '')}`),
  );
  for (const a of Array.isArray(reasoningState.falsifiedAttempts) ? reasoningState.falsifiedAttempts : []) {
    if (!a || typeof a !== 'object') continue;
    const tool = String(a.toolName || 'unknown');
    const editedFiles = Array.isArray(a.editedFiles) && a.editedFiles.length
      ? a.editedFiles.map((f) => String(f || '').trim()).filter(Boolean)
      : Array.isArray(a.targetFiles) && a.targetFiles.length
        ? a.targetFiles.map((f) => String(f || '').trim()).filter(Boolean)
        : [];
    const targetParts = [];
    if (a.target) targetParts.push(String(a.target).trim());
    for (const ef of editedFiles) {
      if (!targetParts.includes(ef)) targetParts.push(ef);
    }
    const target = (
      targetParts.length ? targetParts.join(', ') : String(a.argsSummary || tool)
    ).slice(0, 160);
    const errorSignature = String(
      a.fingerprint?.signature || a.errorSignature || a.errorType || a.fingerprint?.errorType || '',
    ).slice(0, 160);
    const key = `${tool}|${target}|${errorSignature}`;
    if (seenFalsified.has(key)) continue;
    seenFalsified.add(key);
    falsifiedAttempts.push({
      tool,
      target,
      ...(editedFiles.length ? { editedFiles } : {}),
      errorSignature,
      excerpt: String(
        a.hypothesisSummary || a.fingerprint?.assertionExcerpt || errorSignature,
      ).slice(0, 240),
      exitCode: a.fingerprint?.exitCode ?? null,
      count: 1,
      repeated: false,
      lastSeq: a.seq ?? null,
    });
  }
  for (const fp of Array.isArray(reasoningState.errorFingerprints) ? reasoningState.errorFingerprints : []) {
    if (!fp || typeof fp !== 'object' || Number(fp.count || 0) < 2) continue;
    const sig = String(fp.signature || fp.errorType || '').slice(0, 160);
    const target = String(fp.failingTarget || fp.location || 'execution').slice(0, 160);
    const already = falsifiedAttempts.some(
      (f) => f.errorSignature === sig || (sig && String(f.excerpt || '').includes(sig)),
    );
    if (!already && sig) {
      falsifiedAttempts.push({
        tool: 'tracker',
        target,
        errorSignature: sig,
        excerpt: String(fp.assertionExcerpt || sig).slice(0, 240),
        exitCode: fp.exitCode ?? null,
        count: Number(fp.count),
        repeated: true,
        lastSeq: fp.lastSeq ?? null,
      });
    }
  }

  const stuckDetections = Array.isArray(reasoningState.stuckDetections)
    ? reasoningState.stuckDetections.slice(-5).map((d) => ({
        pattern: String(d?.pattern || ''),
        signature: String(d?.signature || ''),
        summary: String(d?.summary || '').slice(0, 200),
      }))
    : [];

  return {
    ...anchor,
    modifiedFiles: modifiedFiles.slice(0, 40),
    verificationLedger: verificationLedger.slice(-10),
    falsifiedAttempts: falsifiedAttempts.slice(0, 10),
    ...(reasoningState.hasUnverifiedMutationsAfterLastPass
      ? { hasUnverifiedMutationsAfterLastPass: true }
      : {}),
    ...(stuckDetections.length ? { stuckDetections } : {}),
  };
}

/**
 * Layer 5 Non-Destructive MultiStageCompactor.
 * Never deletes rows from `direct_messages`; persists structured compaction records
 * in `context_compactions` with deterministic TaskStateAnchor preservation.
 */
export class MultiStageCompactor {
  constructor({ store, eventRouter = null, budgetManager = new TokenBudgetManager() }) {
    this.store = store;
    this.eventRouter = eventRouter;
    this.budgetManager = budgetManager;
  }

  /**
   * Deterministically extracts critical task goals, acceptance criteria, user constraints,
   * active plan, modified files, verification ledger, falsified attempts, and tool evidence
   * so compaction never loses execution state.
   */
  extractTaskStateAnchor(sessionId, { reasoningState = null } = {}) {
    if (!this.store?.db || typeof this.store.db.prepare !== 'function' || !sessionId) {
      return mergeReasoningStateIntoAnchor(
        {
          goal: '',
          acceptanceCriteria: [],
          constraints: [],
          activePlan: null,
          modifiedFiles: [],
          verificationLedger: [],
          falsifiedAttempts: [],
          evidence: [],
          artifactUris: [],
        },
        reasoningState,
      );
    }

    const db = this.store.db;
    const sess = safeGet(
      db,
      'SELECT title, planJson, workspaceRoot FROM direct_sessions WHERE id=?',
      sessionId,
    );
    const userMsgs = safeAll(
      db,
      "SELECT content FROM direct_messages WHERE sessionId=? AND role='user' ORDER BY seq ASC",
      sessionId,
    );
    const goal = String(userMsgs[0]?.content ?? sess?.title ?? '')
      .trim()
      .slice(0, 1200);

    const activePlan = parseJsonSafe(sess?.planJson, null);
    const constraints = [];
    const acceptanceCriteria = [];
    if (Array.isArray(activePlan?.verificationCriteria)) {
      for (const vc of activePlan.verificationCriteria) {
        const text =
          typeof vc === 'string'
            ? vc.trim()
            : String(vc?.description ?? vc?.title ?? '').trim();
        if (text) acceptanceCriteria.push(text.slice(0, 300));
      }
    }

    for (const m of userMsgs) {
      for (const line of String(m.content || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length < 6) continue;
        if (CONSTRAINT_RE.test(trimmed)) {
          constraints.push(trimmed.slice(0, 300));
        }
        if (ACCEPTANCE_RE.test(trimmed)) {
          acceptanceCriteria.push(trimmed.slice(0, 300));
        }
      }
    }

    const snaps = safeAll(
      db,
      'SELECT DISTINCT path, existed FROM turn_snapshots WHERE sessionId=?',
      sessionId,
    );
    const modifiedFiles = snaps.map((s) => ({
      path: s.path,
      action: s.existed ? 'modified' : 'created',
    }));

    const receipts = safeAll(
      db,
      `SELECT callId, toolName, status, exitCode, errorCode, effectClass
       FROM tool_receipts WHERE sessionId=? ORDER BY createdAt DESC LIMIT 50`,
      sessionId,
    );
    const receiptByCallId = new Map();
    for (const r of receipts) {
      if (r?.callId && !receiptByCallId.has(r.callId)) {
        receiptByCallId.set(r.callId, r);
      }
    }

    const msgRowsDesc = safeAll(
      db,
      `SELECT seq, turnId, role, content, toolCalls, toolCallId, toolName, meta, createdAt
       FROM direct_messages WHERE sessionId=? ORDER BY seq DESC LIMIT 300`,
      sessionId,
    );
    const msgRows = [...msgRowsDesc].reverse();

    const extraFiles = extractModifiedFilesFromToolCalls(
      msgRows,
      modifiedFiles.map((f) => f.path),
    );
    const allModifiedFiles = [...modifiedFiles, ...extraFiles].slice(0, 40);

    const callInfoById = new Map();
    for (const r of msgRows) {
      if (r.role !== 'assistant' || !r.toolCalls) continue;
      const calls = parseJsonSafe(r.toolCalls, []);
      if (!Array.isArray(calls)) continue;
      for (const tc of calls) {
        if (!tc?.id) continue;
        const args =
          typeof tc.arguments === 'string'
            ? parseJsonSafe(tc.arguments, {})
            : tc.arguments ?? {};
        callInfoById.set(tc.id, {
          name: String(tc.name || ''),
          args: args && typeof args === 'object' ? args : {},
        });
      }
    }

    const verificationByCmd = new Map();
    const falsifiedMap = new Map();

    for (const r of msgRows) {
      if (r.role !== 'tool') continue;
      const callInfo = r.toolCallId ? callInfoById.get(r.toolCallId) : null;
      const toolName = String(r.toolName || callInfo?.name || '');
      const args = callInfo?.args ?? {};
      const content = String(r.content || '');
      const meta = parseJsonSafe(r.meta, {});
      const receipt = r.toolCallId ? receiptByCallId.get(r.toolCallId) : null;

      const command = String(
        args.command ??
          (Array.isArray(args.argv) ? args.argv.join(' ') : '') ??
          args.cmd ??
          '',
      ).trim();
      const lowerTool = toolName.toLowerCase();
      const isShell =
        lowerTool === 'bash' ||
        lowerTool === 'shell' ||
        lowerTool === 'pty' ||
        lowerTool === 'read_process_output';

      const parsedExit = parseExitCode(content);
      const exitCode =
        parsedExit !== null
          ? parsedExit
          : receipt?.exitCode !== undefined && receipt?.exitCode !== null
            ? Number(receipt.exitCode)
            : meta?.isError === true
              ? 1
              : receipt?.status === 'finished'
                ? 0
                : null;
      const isFailed =
        (exitCode !== null && exitCode !== 0) ||
        meta?.isError === true ||
        receipt?.status === 'failed' ||
        receipt?.status === 'rejected_before_effect';
      const isPassed =
        !isFailed &&
        (exitCode === 0 || (receipt?.status === 'finished' && meta?.isError !== true));

      const isVerification =
        (isShell && (Boolean(command) || exitCode !== null)) ||
        lowerTool.includes('verify') ||
        lowerTool.includes('test');

      if (isVerification) {
        const key = command || `${toolName}#${r.toolCallId || r.seq}`;
        const status = isFailed ? 'fail' : isPassed ? 'pass' : 'unknown';
        verificationByCmd.set(key, {
          command: command || toolName,
          tool: toolName || 'bash',
          exitCode,
          status,
          passed: status === 'pass',
          failureExcerpt: status === 'fail' ? extractFailureExcerpt(content, 280) : '',
          seq: r.seq ?? null,
        });
      }

      if (isFailed) {
        const excerpt = extractFailureExcerpt(content, 240);
        const target = String(
          command || args.path || args.filePath || args.pattern || toolName || 'tool',
        ).slice(0, 160);
        const signature = normalizeErrorSignature(excerpt || `${toolName}:${exitCode ?? 'err'}`);
        const fKey = `${lowerTool}|${target}|${signature}`;
        const prev = falsifiedMap.get(fKey);
        if (prev) {
          prev.count += 1;
          prev.repeated = true;
          prev.lastSeq = r.seq ?? prev.lastSeq;
          if (excerpt) prev.excerpt = excerpt;
        } else {
          falsifiedMap.set(fKey, {
            tool: toolName || 'unknown',
            target,
            errorSignature: signature,
            excerpt,
            exitCode,
            count: 1,
            repeated: false,
            lastSeq: r.seq ?? null,
          });
        }
      }
    }

    if (Array.isArray(activePlan?.hypotheses)) {
      for (const h of activePlan.hypotheses) {
        if (
          h &&
          typeof h === 'object' &&
          (h.status === 'falsified' || h.status === 'rejected')
        ) {
          const stmt = String(h.statement ?? h.title ?? h.id ?? '').trim();
          if (stmt) {
            const key = `hypothesis|${stmt.slice(0, 120)}`;
            if (!falsifiedMap.has(key)) {
              falsifiedMap.set(key, {
                tool: 'update_plan',
                target: stmt.slice(0, 160),
                errorSignature: String(h.evidence || h.status).slice(0, 160),
                excerpt: String(h.evidence || stmt).slice(0, 240),
                exitCode: null,
                count: 1,
                repeated: false,
                lastSeq: null,
              });
            }
          }
        }
      }
    }

    const verificationLedger = [...verificationByCmd.values()]
      .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))
      .slice(-10);

    const falsifiedAttempts = [...falsifiedMap.values()]
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return Number(b.lastSeq ?? 0) - Number(a.lastSeq ?? 0);
      })
      .slice(0, 10);

    const artifactUris = new Set();
    for (const m of msgRows.slice(-40)) {
      const matches = String(m.content || '').match(/artifact:\/\/[0-9a-f]{64}/g);
      if (matches) matches.forEach((u) => artifactUris.add(u));
    }

    return mergeReasoningStateIntoAnchor(
      {
        goal,
        acceptanceCriteria: [...new Set(acceptanceCriteria)].slice(0, 12),
        constraints: [...new Set(constraints)].slice(0, 16),
        activePlan,
        modifiedFiles: allModifiedFiles,
        verificationLedger,
        falsifiedAttempts,
        evidence: receipts.slice(0, 20).map((r) => ({
          tool: r.toolName,
          status: r.status,
          exitCode: r.exitCode,
          effectClass: r.effectClass,
        })),
        artifactUris: [...artifactUris].slice(0, 16),
      },
      reasoningState,
    );
  }

  getActiveCompaction(sessionId) {
    if (!this.store?.db || typeof this.store.db.prepare !== 'function' || !sessionId) return null;
    const sess = safeGet(
      this.store.db,
      'SELECT activeCompactionId FROM direct_sessions WHERE id=?',
      sessionId,
    );
    if (!sess?.activeCompactionId) return null;
    const row = safeGet(
      this.store.db,
      'SELECT * FROM context_compactions WHERE id=?',
      sess.activeCompactionId,
    );
    if (!row) return null;
    return {
      ...row,
      taskState: parseJsonSafe(row.taskStateJson, {}),
      preservedConstraints: parseJsonSafe(row.preservedConstraintsJson, []),
    };
  }

  listCompactions(sessionId) {
    if (!this.store?.db || typeof this.store.db.prepare !== 'function' || !sessionId) return [];
    return safeAll(
      this.store.db,
      'SELECT * FROM context_compactions WHERE sessionId=? ORDER BY createdAt DESC',
      sessionId,
    ).map((r) => ({
      ...r,
      taskState: parseJsonSafe(r.taskStateJson, {}),
      preservedConstraints: parseJsonSafe(r.preservedConstraintsJson, []),
    }));
  }

  formatAnchorText(summaryText, taskState) {
    const parts = [`[历史上下文摘要]\n${summaryText || '(无额外文本摘要)'}`];
    if (taskState?.goal) parts.push(`任务目标: ${taskState.goal}`);
    if (taskState?.acceptanceCriteria?.length) {
      parts.push(`验收标准:\n- ${taskState.acceptanceCriteria.join('\n- ')}`);
    }
    if (taskState?.constraints?.length) {
      parts.push(`关键约束:\n- ${taskState.constraints.join('\n- ')}`);
    }
    if (taskState?.activePlan?.steps?.length) {
      const planLines = taskState.activePlan.steps.map(
        (s) => `- [${s.status}] ${s.title}`,
      );
      parts.push(`任务计划:\n${planLines.join('\n')}`);
    }
    if (taskState?.activePlan?.hypotheses?.length) {
      const hypLines = taskState.activePlan.hypotheses.map((h) =>
        typeof h === 'string'
          ? `- ${h}`
          : `- [${h.status || 'active'}] ${h.statement || h.title || h.id || ''}${h.evidence ? ` (${h.evidence})` : ''}`,
      );
      parts.push(`当前假设:\n${hypLines.join('\n')}`);
    }
    if (taskState?.activePlan?.blockers?.length) {
      const blkLines = taskState.activePlan.blockers.map((b) =>
        typeof b === 'string'
          ? `- ${b}`
          : `- [${b.severity || 'medium'}] ${b.description || b.title || b.id || ''}`,
      );
      parts.push(`当前阻塞项:\n${blkLines.join('\n')}`);
    }
    if (taskState?.modifiedFiles?.length) {
      parts.push(
        `已改动文件: ${taskState.modifiedFiles.map((f) => `${f.path}(${f.action})`).join(', ')}`,
      );
    }
    if (taskState?.verificationLedger?.length || taskState?.hasUnverifiedMutationsAfterLastPass) {
      const vLines = (taskState.verificationLedger ?? []).map((v) => {
        const badge = String(v.status || 'unknown').toUpperCase();
        const code = v.exitCode !== null && v.exitCode !== undefined ? ` exit=${v.exitCode}` : '';
        const err = v.failureExcerpt ? ` :: ${v.failureExcerpt}` : '';
        return `- [${badge}${code}] ${v.command}${err}`;
      });
      if (taskState?.hasUnverifiedMutationsAfterLastPass) {
        vLines.push('- [PENDING] 存在最近修改后尚未重新验证的文件，完成前必须运行验证命令');
      }
      parts.push(`验证台账:\n${vLines.join('\n')}`);
    }
    if (taskState?.falsifiedAttempts?.length) {
      const fLines = taskState.falsifiedAttempts.map((f) => {
        const repeatTag = f.count > 1 ? ` (repeated ${f.count}x)` : '';
        return `- [${f.tool}] ${f.target}${repeatTag}: ${f.errorSignature || f.excerpt}`;
      });
      parts.push(`已证伪尝试与重复错误:\n${fLines.join('\n')}`);
    }
    if (taskState?.stuckDetections?.length) {
      const sLines = taskState.stuckDetections.map(
        (d) => `- [${d.pattern || 'stuck'}] ${d.summary || d.signature}`,
      );
      parts.push(`停滞诊断提示:\n${sLines.join('\n')}`);
    }
    if (taskState?.evidence?.length) {
      parts.push(
        `近期工具执行回执: ${taskState.evidence
          .slice(0, 8)
          .map((e) => `${e.tool}:${e.status}(exit=${e.exitCode ?? '-'})`)
          .join(', ')}`,
      );
    }
    if (taskState?.artifactUris?.length) {
      parts.push(`保留产物 URI: ${taskState.artifactUris.join(', ')}`);
    }
    return parts.join('\n\n');
  }

  /**
   * Non-destructive manual/scheduled session compaction.
   * Keeps ALL direct_messages rows intact in SQLite while advancing `activeCompactionId`.
   */
  async compactSession(
    sessionId,
    { keepRecent = 4, summarizeFn = null, model = null, signal = undefined } = {},
  ) {
    const rows = this.store.db
      .prepare('SELECT * FROM direct_messages WHERE sessionId=? ORDER BY seq ASC')
      .all(sessionId);
    if (rows.length <= 6) {
      return { compacted: false, reason: '消息数量较少，无需压缩', count: rows.length };
    }

    // Choose cut index without splitting an assistant(toolCalls) + tool(toolCallId) batch
    let cutIdx = rows.length - keepRecent;
    while (cutIdx > 1 && rows[cutIdx]?.role === 'tool') {
      cutIdx--;
    }
    if (cutIdx <= 0) {
      return { compacted: false, reason: '无满足原子边界的可压缩历史前缀', count: rows.length };
    }

    const oldRows = rows.slice(0, cutIdx);
    const oldMsgs = oldRows.map((r) => ({
      role: r.role,
      content: [{ type: 'text', text: r.content }],
    }));
    const tokenBefore = this.budgetManager.estimate(
      oldRows.map((r) => r.content).join('\n'),
    );

    let summary = '';
    if (model && typeof summarizeFn === 'function') {
      try {
        summary = await summarizeFn(oldMsgs, model, signal ?? AbortSignal.timeout(20000));
      } catch {
        summary = '';
      }
    }
    if (!summary) {
      summary = oldRows
        .filter((r) => r.role === 'user' || r.role === 'assistant')
        .slice(-6)
        .map((r) => `- ${r.role}: ${String(r.content).slice(0, 180)}`)
        .join('\n');
    }

    const taskState = this.extractTaskStateAnchor(sessionId);
    const anchoredSummary = this.formatAnchorText(summary, taskState);
    const tokenAfter = this.budgetManager.estimate(anchoredSummary);
    const maxOldSeq = oldRows.at(-1).seq;
    const compactionId = uuid();
    const now = Date.now();

    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO context_compactions(
            id, sessionId, turnId, stage, coveredThroughSeq, summaryText,
            taskStateJson, preservedConstraintsJson, tokenBefore, tokenAfter, createdAt
          ) VALUES(?,?,NULL,'manual',?,?,?,?,?,?,?)`,
        )
        .run(
          compactionId,
          sessionId,
          maxOldSeq,
          summary,
          JSON.stringify(taskState),
          JSON.stringify(taskState.constraints ?? []),
          tokenBefore,
          tokenAfter,
          now,
        );
      this.store.db
        .prepare('UPDATE direct_sessions SET activeCompactionId=?, updatedAt=? WHERE id=?')
        .run(compactionId, now, sessionId);
    });

    this.eventRouter?.emitPersisted({
      sessionId,
      turnId: null,
      type: RUNTIME_EVENTS.SESSION_COMPACTED,
      data: {
        sessionId,
        compactionId,
        coveredThroughSeq: maxOldSeq,
        compressedCount: oldRows.length,
        summaryLength: anchoredSummary.length,
        preservedConstraints: taskState.constraints.length,
      },
      audit: true,
    });

    return {
      compacted: true,
      compactionId,
      coveredThroughSeq: maxOldSeq,
      compressedCount: oldRows.length,
      summary: anchoredSummary,
      preservedState: taskState,
    };
  }

  /**
   * Step-level multi-stage compaction before each LLM request.
   */
  async prepareRequest(
    options,
    { contextWindow = 128000, sessionId = null, turnId = null, summarize = null, reasoningState = null } = {},
  ) {
    const compBefore = this.budgetManager.measure(options);
    const out = await compactTwoStage(options, {
      contextWindow: Math.min(200000, contextWindow),
      summarize,
    });

    if (out.stage === 'summary' && ((sessionId && this.store?.db) || reasoningState)) {
      const taskState = this.extractTaskStateAnchor(sessionId, { reasoningState });
      const summaryMsg = out.options.messages.find(
        (m) =>
          m.role === 'assistant' &&
          m.content?.some((b) => String(b.text || '').startsWith('[compacted summary]')),
      );
      if (summaryMsg) {
        const rawSummary = summaryMsg.content[0].text.replace('[compacted summary]\n', '');
        const anchored = this.formatAnchorText(rawSummary, taskState);
        summaryMsg.content[0].text = anchored;
        if (sessionId && this.store?.db && typeof this.store.db.prepare === 'function') {
          const compactionId = uuid();
          const now = Date.now();
          const maxSeqRow = this.store.db
            .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM direct_messages WHERE sessionId=?')
            .get(sessionId);
          this.store.tx(() => {
            this.store.db
              .prepare(
                `INSERT INTO context_compactions(
                  id, sessionId, turnId, stage, coveredThroughSeq, summaryText,
                  taskStateJson, preservedConstraintsJson, tokenBefore, tokenAfter, createdAt
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                compactionId,
                sessionId,
                turnId,
                'auto-summary',
                maxSeqRow?.m ?? 0,
                rawSummary,
                JSON.stringify(taskState),
                JSON.stringify(taskState.constraints ?? []),
                compBefore.totalTokens,
                out.tokens ?? 0,
                now,
              );
          });
        }
      }
    }
    return out;
  }
}
