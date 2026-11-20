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
   * Deterministically extracts critical task goals, user constraints, active plan,
   * modified files, and tool evidence URIs so compaction never loses execution state.
   */
  extractTaskStateAnchor(sessionId) {
    if (!this.store?.db || !sessionId) {
      return {
        goal: '',
        constraints: [],
        activePlan: null,
        modifiedFiles: [],
        evidence: [],
      };
    }

    const sess = this.store.db
      .prepare('SELECT title, planJson, workspaceRoot FROM direct_sessions WHERE id=?')
      .get(sessionId);
    const userMsgs = this.store.db
      .prepare("SELECT content FROM direct_messages WHERE sessionId=? AND role='user' ORDER BY seq ASC")
      .all(sessionId);
    const goal = userMsgs[0]?.content?.slice(0, 600) ?? sess?.title ?? '';

    const constraints = [];
    for (const m of userMsgs) {
      for (const line of String(m.content || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length >= 6 && CONSTRAINT_RE.test(trimmed)) {
          constraints.push(trimmed.slice(0, 240));
        }
      }
    }

    const snaps = this.store.db
      .prepare('SELECT DISTINCT path, existed FROM turn_snapshots WHERE sessionId=?')
      .all(sessionId);
    const modifiedFiles = snaps.map((s) => ({
      path: s.path,
      action: s.existed ? 'modified' : 'created',
    }));

    const receipts = this.store.db
      .prepare(
        `SELECT toolName, status, exitCode, effectClass
         FROM tool_receipts WHERE sessionId=? ORDER BY createdAt DESC LIMIT 20`,
      )
      .all(sessionId);

    const msgTexts = this.store.db
      .prepare('SELECT content FROM direct_messages WHERE sessionId=? ORDER BY seq DESC LIMIT 30')
      .all(sessionId);
    const artifactUris = new Set();
    for (const m of msgTexts) {
      const matches = String(m.content || '').match(/artifact:\/\/[0-9a-f]{64}/g);
      if (matches) matches.forEach((u) => artifactUris.add(u));
    }

    return {
      goal,
      constraints: [...new Set(constraints)].slice(0, 12),
      activePlan: parseJsonSafe(sess?.planJson, null),
      modifiedFiles: modifiedFiles.slice(0, 30),
      evidence: receipts.map((r) => ({
        tool: r.toolName,
        status: r.status,
        exitCode: r.exitCode,
        effectClass: r.effectClass,
      })),
      artifactUris: [...artifactUris].slice(0, 16),
    };
  }

  getActiveCompaction(sessionId) {
    if (!this.store?.db || !sessionId) return null;
    const sess = this.store.db
      .prepare('SELECT activeCompactionId FROM direct_sessions WHERE id=?')
      .get(sessionId);
    if (!sess?.activeCompactionId) return null;
    const row = this.store.db
      .prepare('SELECT * FROM context_compactions WHERE id=?')
      .get(sess.activeCompactionId);
    if (!row) return null;
    return {
      ...row,
      taskState: parseJsonSafe(row.taskStateJson, {}),
      preservedConstraints: parseJsonSafe(row.preservedConstraintsJson, []),
    };
  }

  listCompactions(sessionId) {
    if (!this.store?.db || !sessionId) return [];
    return this.store.db
      .prepare('SELECT * FROM context_compactions WHERE sessionId=? ORDER BY createdAt DESC')
      .all(sessionId)
      .map((r) => ({
        ...r,
        taskState: parseJsonSafe(r.taskStateJson, {}),
        preservedConstraints: parseJsonSafe(r.preservedConstraintsJson, []),
      }));
  }

  formatAnchorText(summaryText, taskState) {
    const parts = [`[历史上下文摘要]\n${summaryText || '(无额外文本摘要)'}`];
    if (taskState?.goal) parts.push(`任务目标: ${taskState.goal}`);
    if (taskState?.constraints?.length) {
      parts.push(`关键约束:\n- ${taskState.constraints.join('\n- ')}`);
    }
    if (taskState?.activePlan?.steps?.length) {
      const planLines = taskState.activePlan.steps.map(
        (s) => `- [${s.status}] ${s.title}`,
      );
      parts.push(`任务计划:\n${planLines.join('\n')}`);
    }
    if (taskState?.modifiedFiles?.length) {
      parts.push(
        `已改动文件: ${taskState.modifiedFiles.map((f) => `${f.path}(${f.action})`).join(', ')}`,
      );
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
    { contextWindow = 128000, sessionId = null, turnId = null, summarize = null } = {},
  ) {
    const compBefore = this.budgetManager.measure(options);
    const out = await compactTwoStage(options, {
      contextWindow: Math.min(200000, contextWindow),
      summarize,
    });

    if (out.stage === 'summary' && sessionId && this.store?.db) {
      const taskState = this.extractTaskStateAnchor(sessionId);
      const summaryMsg = out.options.messages.find(
        (m) =>
          m.role === 'assistant' &&
          m.content?.some((b) => String(b.text || '').startsWith('[compacted summary]')),
      );
      if (summaryMsg) {
        const rawSummary = summaryMsg.content[0].text.replace('[compacted summary]\n', '');
        const anchored = this.formatAnchorText(rawSummary, taskState);
        summaryMsg.content[0].text = anchored;
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
    return out;
  }
}
