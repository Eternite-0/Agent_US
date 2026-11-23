import { liveContextNotes } from '../context.js';
import { buildStaticSystemPrompt } from '../agent-context.js';
import { redactSecrets, sanitize } from '../envelope.js';

/**
 * Layer 5 ContextAssembler.
 * Guarantees byte-identical static system prompt prefix + immutable historical turns
 * for provider Prompt Cache hits, while pushing volatile workspace/git/plan/memory/hooks
 * strictly as diff-only tail notes via `liveContextNotes`.
 */
function formatExperienceMemory(result) {
  return (result?.items ?? []).map((item) => {
    const source = sanitize(redactSecrets(String(item.source ?? 'unknown'))).slice(0, 80);
    const content = sanitize(redactSecrets(String(item.content ?? ''))).slice(0, 1200).trim();
    return content ? `- [source=${source} verified=${item.verified ? 'true' : 'false'}] ${content}` : null;
  }).filter(Boolean).join('\n');
}

export class ContextAssembler {
  constructor({ sessionRepo, compactor, memoryService = null, experienceMemoryService = null, maxCachedSessions = 200 }) {
    this.sessionRepo = sessionRepo;
    this.compactor = compactor;
    this.memoryService = memoryService;
    this.experienceMemoryService = experienceMemoryService;
    this.maxCachedSessions = Math.max(16, Number(maxCachedSessions || 200));
    // Per-session cache of previously emitted live-context note messages per turn boundary
    this.emittedTailHistory = new Map(); // sessionId -> Map<turnId|string, Array<msg>>
  }

  #getOrCreateTailCache(sessionId) {
    let tailCache = this.emittedTailHistory.get(sessionId);
    if (tailCache) {
      // Refresh LRU ordering
      this.emittedTailHistory.delete(sessionId);
      this.emittedTailHistory.set(sessionId, tailCache);
      return tailCache;
    }
    tailCache = new Map();
    this.emittedTailHistory.set(sessionId, tailCache);
    while (this.emittedTailHistory.size > this.maxCachedSessions) {
      const oldestKey = this.emittedTailHistory.keys().next().value;
      if (oldestKey === undefined || oldestKey === sessionId) break;
      this.emittedTailHistory.delete(oldestKey);
    }
    return tailCache;
  }

  #persistTailNotes(sessionId, turnId, firstUserMsg, turnNotes) {
    const store = this.sessionRepo?.store;
    if (!store?.db?.isOpen || !firstUserMsg?.seq || !Array.isArray(turnNotes) || !turnNotes.length) {
      return;
    }
    try {
      const row = store.db
        .prepare('SELECT meta FROM direct_messages WHERE seq=? AND sessionId=? AND turnId=?')
        .get(firstUserMsg.seq, sessionId, turnId);
      if (!row) return;
      let meta = {};
      if (row.meta) {
        try {
          const parsed = JSON.parse(row.meta);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            meta = parsed;
          }
        } catch {
          meta = {};
        }
      }
      if (Array.isArray(meta._liveContextTail)) return;
      meta._liveContextTail = turnNotes;
      store.tx(() => {
        store.db
          .prepare('UPDATE direct_messages SET meta=? WHERE seq=?')
          .run(JSON.stringify(meta), firstUserMsg.seq);
      });
    } catch {
      // Best-effort cache persistence; in-memory tailCache remains authoritative for live turn
    }
  }

  clearSession(sessionId) {
    this.emittedTailHistory.delete(sessionId);
  }

  forkTailFrom(fromSessionId, toSessionId) {
    const src = this.emittedTailHistory.get(fromSessionId);
    if (!src) return;
    const cloned = new Map();
    for (const [k, v] of src.entries()) {
      cloned.set(k, structuredClone(v));
    }
    this.emittedTailHistory.set(toSessionId, cloned);
  }

  assemble({
    session,
    turnId,
    nonce,
    profile = null,
    workspaceRoot,
    gitBranch = null,
    mode = 'direct',
    permissionMode = 'auto-safe',
    projectInstructions = null,
    memoryQuery = '',
    projectId = null,
    memoryTokenBudget = 1000,
    legacyMemoryText = '',
    skillsText = '',
    planState = null,
    hookContexts = [],
  }) {
    // 1. Static system prompt (byte-identical across turns and context changes!)
    const staticBase = buildStaticSystemPrompt(nonce);
    const staticSystemText = profile?.staticSystemInstruction
      ? `${staticBase}\n\n${profile.staticSystemInstruction}`
      : staticBase;
    const messages = [
      { role: 'system', content: [{ type: 'text', text: staticSystemText }] },
    ];

    // 2. Active non-destructive compaction anchor (if any) + verbatim post-compaction messages
    const activeCompaction = this.compactor?.getActiveCompaction(session.id) ?? null;
    const afterSeq = activeCompaction ? activeCompaction.coveredThroughSeq : 0;
    if (activeCompaction) {
      const anchorText = this.compactor.formatAnchorText(
        activeCompaction.summaryText,
        activeCompaction.taskState,
      );
      messages.push(
        { role: 'user', content: [{ type: 'text', text: anchorText }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '已确认历史上下文摘要与任务关键约束。' }],
        },
      );
    }

    const rawHistory = this.sessionRepo.buildConversationMessages(session.id, { afterSeq });
    const priorHistory = [];
    const currentTurnMsgs = [];
    for (const msg of rawHistory) {
      if (turnId && msg.turnId === turnId) {
        currentTurnMsgs.push(msg);
      } else {
        priorHistory.push(msg);
      }
    }

    // Re-attach previously emitted diff notes at their exact historical turn boundaries
    // so prefix bytes across Turn 1..k-1 remain byte-identical (including across process restarts)!
    const tailCache = this.#getOrCreateTailCache(session.id);

    // Group priorHistory by turnId preserving order and injecting cached/persisted notes before each turn's first msg
    const priorNotes = [];
    const seenTurns = new Set();
    for (const m of priorHistory) {
      const tid = m.turnId || '__pre__';
      if (!seenTurns.has(tid)) {
        seenTurns.add(tid);
        let cachedNotes = tailCache.get(tid);
        if (!cachedNotes && Array.isArray(m.liveContextTail) && m.liveContextTail.length) {
          cachedNotes = m.liveContextTail;
          tailCache.set(tid, cachedNotes);
        }
        if (cachedNotes?.length) {
          messages.push(...cachedNotes);
          priorNotes.push(...cachedNotes);
        }
      }
      messages.push({ role: m.role, toolCallId: m.toolCallId, content: m.content });
    }

    // 3. Build current volatile sections and compute diff-only tail notes against messages so far
    const experienceMemory = this.experienceMemoryService && projectId
      ? formatExperienceMemory(this.experienceMemoryService.retrieve({ projectId, query: memoryQuery, limit: 8, tokenBudget: memoryTokenBudget }))
      : '';
    const retrievedMem = experienceMemory || this.memoryService?.retrieve({
      query: memoryQuery,
      workspaceRoot,
      sessionId: session.id,
      limit: 8,
      maxChars: 3500,
    })?.text || sanitize(redactSecrets(legacyMemoryText));

    const planText = planState?.steps?.length
      ? planState.steps
          .map(
            (s) =>
              `- [${s.status === 'completed' ? 'x' : s.status === 'in_progress' ? '/' : ' '}] ${s.title}`,
          )
          .join('\n')
      : '';

    const runtimeBody = [
      `workspaceRoot: ${workspaceRoot}`,
      `platform: ${process.platform} (${process.arch})`,
      `permissionMode: ${permissionMode}`,
      `mode: ${mode}`,
      ...(gitBranch ? [`gitBranch: ${gitBranch}`] : []),
      ...(mode === 'plan'
        ? [
            '[PLAN 模式] 当前处于 `/plan` 规划模式：先只读调研关键代码并输出清晰的分步实施计划，等待用户确认后再修改文件或运行破坏性命令。',
          ]
        : []),
    ].join('\n');

    const sections = [
      { id: 'runtime_env', source: 'runtime', text: runtimeBody },
      ...(projectInstructions?.text
        ? [{ id: 'project_instructions', source: 'workspace', text: projectInstructions.text }]
        : []),
      ...(retrievedMem
        ? [{ id: 'workspace_memory', source: 'memory', text: retrievedMem }]
        : []),
      ...(skillsText
        ? [
            {
              id: 'available_skills',
              source: 'skills',
              text: `当任务匹配以下技能时，可先用 read_file 阅读对应 SKILL.md：\n${skillsText}`,
            },
          ]
        : []),
      ...(planText ? [{ id: 'active_plan', source: 'plan', text: planText }] : []),
      ...(hookContexts?.filter(Boolean).length
        ? [{ id: 'hook_context', source: 'hooks', text: hookContexts.filter(Boolean).join('\n\n') }]
        : []),
    ];

    // Only the runtime-generated notes may establish which sections are already sent.
    const deltas = liveContextNotes(sections, priorNotes);
    const turnNoteKey = turnId || '__current__';
    const firstCurrentUser = currentTurnMsgs.find((m) => m.role === 'user') ?? null;
    let turnNotes =
      tailCache.get(turnNoteKey) ??
      (Array.isArray(firstCurrentUser?.liveContextTail) && firstCurrentUser.liveContextTail.length
        ? firstCurrentUser.liveContextTail
        : null);
    if (turnNotes && !tailCache.has(turnNoteKey)) {
      tailCache.set(turnNoteKey, turnNotes);
    }
    if (!turnNotes && deltas.length > 0) {
      turnNotes = [
        {
          role: 'user',
          content: [{ type: 'text', text: deltas.map((d) => d.text).join('\n\n') }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '已了解当前工作区与项目规范。' }],
        },
      ];
      tailCache.set(turnNoteKey, turnNotes);
      if (turnId && firstCurrentUser) {
        this.#persistTailNotes(session.id, turnId, firstCurrentUser, turnNotes);
      }
    }
    if (turnNotes?.length) {
      messages.push(...turnNotes);
    }

    for (const m of currentTurnMsgs) {
      messages.push({ role: m.role, toolCallId: m.toolCallId, content: m.content });
    }

    return {
      messages,
      sections,
      deltaCount: deltas.length,
      activeCompactionId: activeCompaction?.id ?? null,
    };
  }
}
