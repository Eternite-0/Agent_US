import { groupDirectMessages } from '../utils/directMessages';
import type { CommandAvailability, MentionExtension, SlashCommand } from './slashCommands';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Approval,
  GitStatus,
  CodexMode,
  EffortLevel,
  InspectorTab,
  ModelSpec,
  PermissionMode,
  WorkspaceEntryKind,
  Project,
  Task,
  TaskBundle,
} from '../types/backend';
import { aggregateFileChanges } from '../utils/diff';
import {
  eventMatchesWorker,
  getWorkerActivityLabel,
  getWorkerDisplayName,
  getWorkerDisplayRole,
  resolveWorkerForPayload,
} from '../utils/worker';
import {
  fmtClock,
  fmtDayDivider,
  fmtDuration,
  fmtStatusLabel,
  fmtTokens,
  fmtUSD,
  taskTitle,
} from '../utils/format';
import { ActivityBlock, ApprovalGateCard } from './ActivityBlock';
import { AgentCompanionCard } from './AgentCompanionCard';
import { SubagentProgress } from './SubagentProgress';
import { Composer } from './Composer';
import { EvidenceBadge } from './EvidenceBadge';
import { FileChangeCard } from './FileChangeCard';
import { ReconciliationCard } from './ReconciliationCard';
import {
  IconArchive,
  IconArrowDown,
  IconBookmark,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconCompose,
  IconCopy,
  IconAgentTeam,
  IconDotsHorizontal,
  IconDownload,
  IconFileDoc,
  IconFolder,
  IconHistory,
  IconImageInspect,
  IconPause,
  IconPlay,
  IconReset,
  IconRightPanelToggle,
  IconSearch,
} from './Icons';
import {
  ImageLightbox,
  isImagePath,
  toImageDataUrl,
  type PreviewImageItem,
} from './ImageLightbox';
import { Markdown } from './Markdown';

/**
 * Keeps the closing assistant reply crisp & concise (like Codex Desktop),
 * while preserving 100% of long multi-section reports behind a 1-click expand toggle.
 */
function extractConciseClosing(raw: string): { shortText: string; isTruncated: boolean } {
  const trimmed = raw.trim();
  const nonEmptyLines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (trimmed.length <= 520 && nonEmptyLines.length <= 9) {
    return { shortText: trimmed, isTruncated: false };
  }

  // Prefer an explicit concluding/summary section if the model wrote one
  const lines = trimmed.replace(/\r\n/g, '\n').split('\n');
  const summaryHeadingIdx = lines.findIndex((l) =>
    /^(?:#{1,4}\s*|[一二三四五六七八九十]+[、.]\s*|\*\*)(?:.*(?:总结|结论|简短说明|修复内容|修复说明|最终结果|核心要点|摘要|Summary|Conclusion|TL;DR))/i.test(
      l.trim(),
    ),
  );
  if (summaryHeadingIdx >= 0) {
    const tail: string[] = [];
    let chars = 0;
    for (let i = summaryHeadingIdx; i < lines.length; i++) {
      const ln = lines[i];
      if (i > summaryHeadingIdx && /^#{1,3}\s/.test(ln.trim()) && tail.length >= 3) break;
      tail.push(ln);
      chars += ln.length;
      if (chars > 560 && tail.length >= 4) break;
    }
    const candidate = tail.join('\n').trim();
    if (candidate.length >= 40 && candidate.length < trimmed.length - 60) {
      return { shortText: candidate, isTruncated: true };
    }
  }

  // Otherwise keep the opening executive paragraph / bullet items without slicing a code fence
  const head: string[] = [];
  let inFence = false;
  let chars = 0;
  let count = 0;
  for (const ln of lines) {
    if (/^```/.test(ln.trim())) inFence = !inFence;
    head.push(ln);
    if (ln.trim()) {
      count++;
      chars += ln.length;
    }
    if (!inFence && (count >= 7 || chars >= 380)) break;
  }
  if (inFence) head.push('```');
  const candidate = head.join('\n').trim();
  return {
    shortText: candidate,
    isTruncated: candidate.length < trimmed.length - 30,
  };
}

interface ThreadViewProps {
  bundles: TaskBundle[];
  onOpenSwarmRun?: (sessionId: string, runId: string) => void;
  loading: boolean;
  focusWorkerId?: string;
  liveStreams?: Record<string, { text: string; reasoning: string }>;
  liveToolOutputs?: Record<string, { callId: string; name: string; text: string }>;
  onRewindSession?: (sessionId: string, scope: 'code' | 'conversation' | 'both', turnId?: string) => Promise<void>;
  onCompactSession?: (sessionId: string) => Promise<void>;
  codexMode: CodexMode;
  projects: Project[];
  selectedProject: Project | null;
  models: ModelSpec[];
  selectedModel: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  gitStatus?: GitStatus | null;
  mentionFiles: string[];
  mentionPlugins?: MentionExtension[];
  mentionSkills?: MentionExtension[];
  submitting: boolean;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  decidingApprovalId: string | null;
  routerReady: boolean;
  isLiveBackend: boolean;
  onSelectProject: (projectId: string | null) => void;
  onOpenCreateProject: () => void;
  onSelectModel: (model: string) => void;
  onChangeEffort: (effort: EffortLevel) => void;
  onChangePermission: (mode: PermissionMode) => void;
  onRefreshGitStatus?: () => Promise<void>;
  onCheckoutGitBranch?: (branch: string, create?: boolean) => Promise<void>;
  onInitGitRepo?: () => Promise<void>;
  onSlashCommand: (command: SlashCommand) => void;
  commandAvailability?: CommandAvailability;
  searchMentionFiles?: (query: string, signal: AbortSignal, kind: WorkspaceEntryKind) => Promise<string[]>;
  onSubmitGoal: (goal: string, files: Record<string, string>) => Promise<boolean>;
  onSubmitFollowup: (text: string, files: Record<string, string>) => Promise<void>;
  onControlTask: (task: Task, action: 'pause' | 'resume' | 'cancel' | 'retry') => Promise<void>;
  archiving: boolean;
  onToggleArchive: (task: Task) => void;
  onDecideApproval: (
    approval: Approval,
    decision: 'approve' | 'deny',
    scope?: 'once' | 'session',
    outcome?: 'happened' | 'not_applied' | 'abort',
  ) => Promise<void>;
  onOpenInspector: (tab: InspectorTab, filePath?: string, targetTaskId?: string) => void;
  onOpenSubagent: (workerId: string | null, targetTaskId?: string) => void;
  onToggleInspector: () => void;
  onClearFocusWorker: () => void;
  onFocusWorker: (workerId: string) => void;
  onOpenSettings: (section?: string) => void;
  onSwitchToDemo?: () => void;
  onToast: (msg: string) => void;
}

interface MinimapEntry {
  taskId: string;
  anchorKey: string;
  userTitle: string;
  replySnippet: string;
}

interface SelectionOverlay {
  text: string;
  x: number;
  y: number;
}

export const ThreadView: React.FC<ThreadViewProps> = ({
  bundles,
  onOpenSwarmRun,
  loading,
  focusWorkerId,
  liveStreams = {},
  liveToolOutputs = {},
  onRewindSession,
  onCompactSession,
  codexMode,
  projects,
  selectedProject,
  models,
  selectedModel,
  effort,
  permissionMode,
  gitStatus = null,
  mentionFiles,
  mentionPlugins = [],
  mentionSkills = [],
  submitting,
  inspectorOpen,
  inspectorTab,
  decidingApprovalId,
  routerReady,
  isLiveBackend,
  onSelectProject,
  onOpenCreateProject,
  onSelectModel,
  onChangeEffort,
  onChangePermission,
  onRefreshGitStatus,
  onCheckoutGitBranch,
  onInitGitRepo,
  onSlashCommand,
  commandAvailability,
  searchMentionFiles,
  onSubmitGoal,
  onSubmitFollowup,
  onControlTask,
  archiving,
  onToggleArchive,
  onDecideApproval,
  onOpenInspector,
  onOpenSubagent,
  onToggleInspector,
  onClearFocusWorker,
  onOpenSettings,
  onSwitchToDemo,
  onToast,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const titleMenuRef = useRef<HTMLDivElement>(null);
  const turnMenuRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const nearBottomRef = useRef(true);

  const [titleMenuOpen, setTitleMenuOpen] = useState(false);
  const [openTurnMenuId, setOpenTurnMenuId] = useState<string | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [expandedUsers, setExpandedUsers] = useState<Record<string, boolean>>({});
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({});
  const [lightbox, setLightbox] = useState<{ images: PreviewImageItem[]; index: number } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [activeTurnIdx, setActiveTurnIdx] = useState(0);
  const [hoveredTurnIdx, setHoveredTurnIdx] = useState<number | null>(null);
  const [bookmarkedTurns, setBookmarkedTurns] = useState<Record<string, boolean>>({});
  const [flashedKey, setFlashedKey] = useState<string | null>(null);

  // In-thread Ctrl+F find bar
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIdx, setFindIdx] = useState(0);

  // Selection quote-to-reply popover
  const [selectionOverlay, setSelectionOverlay] = useState<SelectionOverlay | null>(null);

  // Composer draft injection (Quote-to-Reply or Edit & Resend)
  const [companionVisible, setCompanionVisible] = useState(false);
  const [draftInjection, setDraftInjection] = useState<{
    id: number;
    text: string;
    mode: 'replace' | 'append';
  } | null>(null);

  const primaryBundle = bundles[0] ?? null;
  const latestBundle = bundles[bundles.length - 1] ?? null;

  // Close popovers on outside click / Escape
  useEffect(() => {
    if (!titleMenuOpen && !openTurnMenuId) return;
    const onDown = (e: MouseEvent) => {
      if (titleMenuOpen && titleMenuRef.current && !titleMenuRef.current.contains(e.target as Node)) {
        setTitleMenuOpen(false);
      }
      if (openTurnMenuId && turnMenuRef.current && !turnMenuRef.current.contains(e.target as Node)) {
        setOpenTurnMenuId(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (turnMenuRef.current?.contains(document.activeElement)) turnMenuRef.current.querySelector('button')?.focus();
        setTitleMenuOpen(false);
        setOpenTurnMenuId(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [titleMenuOpen, openTurnMenuId]);

  // Intercept Ctrl+F inside thread for Codex in-thread Find Bar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
        window.setTimeout(() => findInputRef.current?.focus(), 10);
      } else if (e.key === 'Escape' && findOpen) {
        setFindOpen(false);
        setFindQuery('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findOpen]);

  // Dismiss selection popover when clicking elsewhere
  useEffect(() => {
    if (!selectionOverlay) return;
    const clear = () => setSelectionOverlay(null);
    document.addEventListener('mousedown', clear);
    return () => document.removeEventListener('mousedown', clear);
  }, [selectionOverlay]);

  // Precompute per-turn derived view models
  const turnModels = useMemo(() => {
    return bundles.map((b, turnIndex) => {
      const { task, workers, sessions, histories, approvals, evidence, artifacts, usage, events } =
        b;
      const isLive =
        task.status === 'planning' || task.status === 'running' || task.status === 'reviewing';
      const visibleEvidence = focusWorkerId
        ? evidence.filter((e) => e.workerId === focusWorkerId)
        : evidence;
      const visibleApprovals = focusWorkerId
        ? approvals.filter((a) => a.workerId === focusWorkerId)
        : approvals;
      const visibleEvents = focusWorkerId
        ? events.filter((ev) => eventMatchesWorker(ev, focusWorkerId, workers))
        : events;
      const publishedArtifacts = artifacts.filter(
        (a) => a.published && (!focusWorkerId || !a.workerId || a.workerId === focusWorkerId),
      );

      const isJsonBlob = (txt: string) => {
        const s = txt.trim();
        if (!(s.startsWith('{') && s.endsWith('}')) && !(s.startsWith('[') && s.endsWith(']'))) {
          return false;
        }
        try {
          return typeof JSON.parse(s) === 'object';
        } catch {
          return false;
        }
      };

      const isDirectSession = sessions[0]?.assignmentId === 'direct';
      const liveStream = liveStreams[task.id] ?? null;
      const directExchanges = groupDirectMessages(task.id, task.input, isDirectSession ? histories[task.id] ?? [] : []);

      const assistantBlocks: Array<{ id: string; title?: string; text: string }> = [];
      // Only show the final assistant prose once the turn completes (or when scoped to a worker),
      // so intermediate subagent handoffs (like Researcher/Planner) stay inside Subagents instead of
      // prematurely appearing as the final answer while the task is still executing!
      if (!isLive || focusWorkerId) {
        const nonJsonArtifacts = publishedArtifacts.filter(
          (a) => a.text?.trim() && !isJsonBlob(a.text),
        );
        if (nonJsonArtifacts.length > 0) {
          // Prefer the final synthesis artifact (last published non-JSON artifact)
          const finalArt = nonJsonArtifacts[nonJsonArtifacts.length - 1];
          assistantBlocks.push({ id: finalArt.id, title: finalArt.key, text: finalArt.text });
        } else {
          for (const sess of [...sessions].reverse()) {
            if (focusWorkerId && sess.workerId !== focusWorkerId) continue;
            if (!focusWorkerId && sess.assignmentId === null) continue;
            const msgs = (histories[sess.id] ?? []).filter(
              (h) => h.type === 'assistant/message' && h.text?.trim() && !isJsonBlob(h.text),
            );
            const last = msgs.at(-1);
            if (last?.text) {
              assistantBlocks.push({
                id: `${sess.id}-${last.cursor}`,
                title: sess.role,
                text: last.text,
              });
              break;
            }
          }
        }
      }

      const changes = visibleEvidence.flatMap((e) => e.changes ?? []);
      const artFiles: Record<string, string> = {};
      for (const a of publishedArtifacts) {
        Object.assign(artFiles, a.files ?? {});
      }
      const computedFiles = aggregateFileChanges(changes, artFiles, task.files);

      // Published image artifacts (outside internal inputs/ handoffs) for inline closing preview
      const artifactImages: PreviewImageItem[] = [];
      for (const [p, b64] of Object.entries(artFiles)) {
        if (/^inputs\//i.test(p.replace(/\\/g, '/'))) continue;
        if (!isImagePath(p)) continue;
        const src = toImageDataUrl(p, b64);
        if (src) {
          artifactImages.push({
            id: `${task.id}-artimg-${p}`,
            src,
            name: p.replace(/\\/g, '/').split('/').pop() || p,
            caption: p,
          });
        }
      }

      const pendingApprovals = visibleApprovals.filter((a) => a.status === 'pending');
      const runningWorker = workers.find((w) => w.status === 'running');
      const runningWorkerName = runningWorker ? getWorkerDisplayName(runningWorker) : '';
      const runningActivity = runningWorker ? getWorkerActivityLabel(runningWorker) : '';
      const latestEv = visibleEvidence.at(-1);

      const liveStatusText = pendingApprovals.length
        ? `正在等待你的批准 · ${pendingApprovals[0].tool}`
        : task.status === 'planning'
          ? isLiveBackend && !routerReady
            ? '任务已存入后端数据库，等待模型配置…'
            : task.plan ? '正在思考并生成 DAG 计划…' : '正在思考并回复…'
          : task.status === 'reviewing'
            ? '正在进行独立验收与证据核验…'
            : runningWorker
              ? runningActivity
                ? `${runningActivity}…`
                : latestEv?.tool === 'write_file'
                  ? `正在编辑文件 (${runningWorkerName})…`
                  : latestEv?.tool === 'shell'
                    ? `正在运行命令 (${runningWorkerName})…`
                    : `正在运行 ${runningWorkerName}${runningWorker.model ? ` (${runningWorker.model})` : ''}…`
              : isDirectSession ? '正在思考并执行…' : '正在调度工作节点…';

      const totalTokens = usage.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0);
      const totalUSD = usage.reduce((s, u) => s + u.estimatedUSD, 0);

      const durationMs =
        events.length >= 2
          ? Math.max(1000, events.at(-1)!.timestamp - events[0].timestamp)
          : !isLive && task.createdAt
            ? 1000 * 60 * 2 + 18000
            : undefined;

      const hasRuntimeActivity = visibleEvents.some((ev) =>
        /^(tool|command|file|plan|node|worker|approval|turn\.failed|message\.failed)/.test(ev.type)
        || ev.type.includes('compact'),
      );
      const hasProcess = Boolean(
        visibleEvidence.length || task.plan || isLive || workers.length > 0 || hasRuntimeActivity,
      );

      return {
        bundle: b,
        turnIndex,
        isLive,
        visibleEvidence,
        visibleApprovals,
        visibleEvents,
        pendingApprovals,
        assistantBlocks,
        artFiles,
        artifactImages,
        computedFiles,
        liveStatusText,
        totalTokens,
        totalUSD,
        durationMs,
        hasProcess,
        isDirectSession,
        directExchanges,
        liveStream,
      };
    });
  }, [bundles, focusWorkerId, isLiveBackend, routerReady, liveStreams]);

  // Exact Codex Turn Minimap: 1 tick per User Turn (prompt title + 3-line assistant snippet)
  const minimapEntries = useMemo<MinimapEntry[]>(() => {
    return turnModels.map((tm) => {
      const tid = tm.bundle.task.id;
      const rawReply =
        tm.assistantBlocks[0]?.text ||
        tm.bundle.task.verdict?.reason ||
        (tm.isLive ? tm.liveStatusText : '') ||
        (tm.durationMs ? `用时 ${fmtDuration(tm.durationMs)}` : '等待回复…');
      const replySnippet = rawReply
        .replace(/```[\s\S]*?```/g, '[代码块]')
        .replace(/[#*`>_]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        taskId: tid,
        anchorKey: `${tid}:user`,
        userTitle: tm.bundle.task.input.replace(/\s+/g, ' ').trim(),
        replySnippet,
      };
    });
  }, [turnModels]);

  // In-thread Ctrl+F search matches
  const findMatches = useMemo(() => {
    const q = findQuery.trim().toLowerCase();
    if (!q) return [];
    const hits: Array<{ anchorKey: string; snippet: string }> = [];
    for (const tm of turnModels) {
      const tid = tm.bundle.task.id;
      if (tm.bundle.task.input.toLowerCase().includes(q)) {
        hits.push({ anchorKey: `${tid}:user`, snippet: taskTitle(tm.bundle.task.input) });
      }
      if (
        tm.visibleEvidence.some(
          (e) =>
            (e.path ?? '').toLowerCase().includes(q) ||
            (e.stdout ?? '').toLowerCase().includes(q) ||
            (e.tool ?? '').toLowerCase().includes(q),
        )
      ) {
        hits.push({ anchorKey: `${tid}:process`, snippet: '执行过程匹配' });
      }
      if (tm.assistantBlocks.some((blk) => blk.text.toLowerCase().includes(q))) {
        hits.push({ anchorKey: `${tid}:assistant`, snippet: '回复正文匹配' });
      }
      if (tm.computedFiles.some((f) => f.path.toLowerCase().includes(q))) {
        hits.push({ anchorKey: `${tid}:files`, snippet: '文件改动匹配' });
      }
    }
    return hits;
  }, [findQuery, turnModels]);

  useEffect(() => {
    setFindIdx(0);
  }, [findQuery]);

  const jumpToAnchorKey = useCallback((anchorKey: string) => {
    const el = scrollRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(`[data-anchor-key="${CSS.escape(anchorKey)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashedKey(anchorKey);
    window.setTimeout(() => setFlashedKey((cur) => (cur === anchorKey ? null : cur)), 900);
  }, []);

  const stepFind = (delta: number) => {
    if (!findMatches.length) return;
    const next = (findIdx + delta + findMatches.length) % findMatches.length;
    setFindIdx(next);
    jumpToAnchorKey(findMatches[next].anchorKey);
  };

  // Preserve scroll position when user scrolled up; auto-follow only when near bottom
  const prevTurnCountRef = useRef(bundles.length);
  const prevEvidenceCountRef = useRef(0);
  const totalEvidenceCount = bundles.reduce((s, b) => s + b.evidence.length + b.artifacts.length + b.events.length, 0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const addedTurn = bundles.length > prevTurnCountRef.current;
    const addedStream = totalEvidenceCount > prevEvidenceCountRef.current;
    prevTurnCountRef.current = bundles.length;
    prevEvidenceCountRef.current = totalEvidenceCount;
    if (addedTurn || (addedStream && nearBottomRef.current)) {
      el.scrollTo({ top: el.scrollHeight, behavior: addedTurn ? 'smooth' : 'auto' });
    }
  }, [bundles.length, totalEvidenceCount]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottomRef.current = distFromBottom <= 110;
    setShowScrollBottom(distFromBottom > 110);

    const turns = el.querySelectorAll<HTMLElement>('[data-turn-anchor="true"]');
    if (!turns.length) return;
    let best = 0;
    const topEdge = el.getBoundingClientRect().top + 110;
    turns.forEach((sec, idx) => {
      if (sec.getBoundingClientRect().top <= topEdge) best = idx;
    });
    setActiveTurnIdx(best);
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const copyText = async (key: string, value: string, toastMsg: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      onToast(toastMsg);
      window.setTimeout(() => setCopiedKey(null), 1200);
    } catch {
      // ignore
    }
  };

  const exportThreadMarkdown = () => {
    const md = turnModels
      .map((tm, idx) => {
        const reply = tm.assistantBlocks.map((b) => b.text).join('\n\n') || tm.bundle.task.verdict?.reason || '';
        const filesNote = tm.computedFiles.length
          ? `\n\n### 文件变更\n${tm.computedFiles.map((f) => `- \`${f.path}\` (+${f.added} / -${f.deleted})`).join('\n')}`
          : '';
        return `## Turn ${idx + 1}\n\n### 用户\n${tm.bundle.task.input}\n\n### 助手\n${reply}${filesNote}`;
      })
      .join('\n\n---\n\n');
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${taskTitle(primaryBundle?.task.input || 'conversation').slice(0, 32)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    onToast('已导出对话为 Markdown');
  };

  // Detect text selection inside assistant prose for Quote-to-Reply popover
  const handleTranscriptMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setSelectionOverlay(null);
      return;
    }
    const text = sel.toString().trim();
    if (text.length < 2 || text.length > 1200) {
      setSelectionOverlay(null);
      return;
    }
    const anchorEl =
      sel.anchorNode instanceof HTMLElement ? sel.anchorNode : sel.anchorNode?.parentElement;
    if (!anchorEl?.closest('.codex-assistant-turn, .codex-process-commentary')) {
      setSelectionOverlay(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    setSelectionOverlay({
      text,
      x: Math.max(96, Math.min(window.innerWidth - 96, rect.left + rect.width / 2)),
      y: Math.max(64, rect.top),
    });
  };

  const injectDraft = (text: string, mode: 'replace' | 'append') => {
    setDraftInjection({ id: Date.now(), text, mode });
  };

  if (loading && !bundles.length) {
    return (
      <div className="codex-thread">
        <div className="codex-thread-header">
          <span className="codex-shimmer-text">正在加载会话…</span>
        </div>
      </div>
    );
  }

  if (!primaryBundle || !latestBundle) {
    return (
      <div className="codex-thread" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: 'var(--text-tertiary)' }}>未找到该任务记录</span>
      </div>
    );
  }

  const activeTask = latestBundle.task;
  const anyLive = turnModels.some((tm) => tm.isLive);
  const companionDiffs = turnModels.at(-1)?.computedFiles ?? [];
  const allSourceFiles = Array.from(
    new Set([
      ...Object.keys(activeTask.files ?? {}),
      ...latestBundle.evidence.flatMap((e) => e.path ? [e.path] : []),
      ...companionDiffs.map((d) => d.path),
    ]),
  ).filter((p) => !/^inputs\//i.test(p.replace(/\\/g, '/')));
  const allPendingApprovals = turnModels.flatMap((tm) =>
    tm.pendingApprovals.map((a) => ({
      approval: a,
      worker: tm.bundle.workers.find((w) => w.id === a.workerId),
    })),
  );
  const focusedWorker = focusWorkerId
    ? bundles.flatMap((b) => b.workers).find((w) => w.id === focusWorkerId)
    : undefined;

  const grandTokens = turnModels.reduce((s, tm) => s + tm.totalTokens, 0);
  const grandUSD = turnModels.reduce((s, tm) => s + tm.totalUSD, 0);

  const statusTone =
    allPendingApprovals.length > 0
      ? 'warning'
      : activeTask.status === 'completed'
        ? 'success'
        : activeTask.status === 'failed'
          ? 'danger'
          : undefined;

  let lastDateLabel = '';

  return (
    <div className="codex-thread">
      {/* 52px Thread Header */}
      <div className="codex-thread-header">
        <div style={{ position: 'relative', minWidth: 0, flex: 1 }} ref={titleMenuRef}>
          <button
            type="button"
            className="codex-thread-title-btn"
            onClick={() => setTitleMenuOpen((v) => !v)}
          >
            <IconFolder size={15} style={{ color: 'var(--text-secondary)', flex: 'none' }} />
            <span className="codex-thread-title-text">{taskTitle(primaryBundle.task.input)}</span>
            {bundles.length > 1 && (
              <span
                className="tabular-nums"
                style={{ fontSize: 11.5, color: 'var(--text-tertiary)', flex: 'none' }}
              >
                · {bundles.length} 轮
              </span>
            )}
            <IconChevronDown size={14} style={{ color: 'var(--text-tertiary)', flex: 'none' }} />
          </button>

          {titleMenuOpen && (
            <div className="codex-popover" data-side="bottom" style={{ left: 0, width: 256 }}>
              <div
                style={{
                  padding: '6px 10px',
                  fontSize: 11.5,
                  color: 'var(--text-tertiary)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <span>
                  状态：{fmtStatusLabel(activeTask.status)} · v{activeTask.version}
                </span>
                {grandTokens > 0 && (
                  <span className="tabular-nums">
                    累计用量：{fmtTokens(grandTokens)} tokens · {fmtUSD(grandUSD)}
                  </span>
                )}
              </div>
              <div className="codex-popover-divider" />
              {anyLive && (
                <button
                  type="button"
                  className="codex-popover-item"
                  onClick={() => {
                    setTitleMenuOpen(false);
                    void onControlTask(activeTask, 'pause');
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <IconPause size={14} />
                    <span>暂停当前任务</span>
                  </span>
                </button>
              )}
              {activeTask.status === 'paused' && (
                <button
                  type="button"
                  className="codex-popover-item"
                  onClick={() => {
                    setTitleMenuOpen(false);
                    void onControlTask(activeTask, 'resume');
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <IconPlay size={14} />
                    <span>恢复任务</span>
                  </span>
                </button>
              )}
              {activeTask.status === 'failed' && (
                <button
                  type="button"
                  className="codex-popover-item"
                  onClick={() => {
                    setTitleMenuOpen(false);
                    void onControlTask(activeTask, 'retry');
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <IconReset size={14} />
                    <span>使用原请求重试</span>
                  </span>
                </button>
              )}
              {(anyLive || activeTask.status === 'paused') && (
                <button
                  type="button"
                  className="codex-popover-item"
                  style={{ color: 'var(--color-danger)' }}
                  onClick={() => {
                    setTitleMenuOpen(false);
                    void onControlTask(activeTask, 'cancel');
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <IconClose size={14} />
                    <span>取消任务</span>
                  </span>
                </button>
              )}
              <div className="codex-popover-divider" />
              <button
                type="button"
                className="codex-popover-item"
                onClick={() => {
                  setTitleMenuOpen(false);
                  setFindOpen(true);
                  window.setTimeout(() => findInputRef.current?.focus(), 10);
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <IconSearch size={14} />
                  <span>在对话中查找</span>
                </span>
                <span className="codex-kbd">Ctrl+F</span>
              </button>
              <button
                type="button"
                className="codex-popover-item"
                onClick={() => {
                  setTitleMenuOpen(false);
                  exportThreadMarkdown();
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <IconDownload size={14} />
                  <span>导出对话 (.md)</span>
                </span>
              </button>
              <button
                type="button"
                className="codex-popover-item"
                onClick={() => {
                  setTitleMenuOpen(false);
                  void copyText('task-id', activeTask.id, '已复制任务 ID');
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <IconCopy size={14} />
                  <span>复制任务 ID</span>
                </span>
              </button>
              <button
                type="button"
                className="codex-popover-item"
                disabled={archiving}
                onClick={() => {
                  setTitleMenuOpen(false);
                  onToggleArchive(primaryBundle.task);
                }}
              >
                <span className="chat-archive-menu-label">
                  <IconArchive size={14} />
                  <span>{primaryBundle.task.archivedAt != null ? '恢复到聊天列表' : '归档聊天'}</span>
                </span>
              </button>
              <div className="codex-popover-divider" />
              <button
                type="button"
                className="codex-popover-item"
                onClick={() => {
                  setTitleMenuOpen(false);
                  onOpenSubagent(null, activeTask.id);
                }}
              >
                <span>查看子智能体列表</span>
              </button>
              <button type="button" className="codex-popover-item" onClick={() => {
                setTitleMenuOpen(false);
                onOpenInspector('autonomous');
              }}>
                <span>查看自主任务</span>
              </button>
              <button
                type="button"
                className="codex-popover-item"
                onClick={() => {
                  setTitleMenuOpen(false);
                  onOpenInspector('events', undefined, activeTask.id);
                }}
              >
                <span>查看 SSE 事件与版本历史</span>
              </button>
            </div>
          )}
        </div>

        <div className="codex-thread-actions">
          {(anyLive ||
            allPendingApprovals.length > 0 ||
            activeTask.status === 'failed' ||
            activeTask.status === 'paused') && (
            <span className="codex-status-chip" data-tone={statusTone}>
              <span
                className="codex-status-dot"
                data-tone={
                  allPendingApprovals.length > 0
                    ? 'warn'
                    : anyLive
                      ? 'pulse'
                      : activeTask.status === 'failed'
                        ? 'danger'
                        : undefined
                }
              />
              <span>
                {allPendingApprovals.length > 0
                  ? `${allPendingApprovals.length} 项待审批`
                  : fmtStatusLabel(activeTask.status)}
              </span>
            </span>
          )}

          {activeTask.status === 'paused' && (
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              onClick={() => void onControlTask(activeTask, 'resume')}
            >
              <IconPlay size={13} />
              <span>恢复</span>
            </button>
          )}

          {activeTask.status === 'failed' && (
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              onClick={() => void onControlTask(activeTask, 'retry')}
            >
              <IconReset size={13} />
              <span>使用原请求重试</span>
            </button>
          )}

          <button
            type="button"
            className="codex-icon-btn"
            data-active={findOpen ? 'true' : undefined}
            aria-label="在对话中查找"
            title="在对话中查找 (Ctrl+F)"
            onClick={() => {
              setFindOpen((v) => !v);
              window.setTimeout(() => findInputRef.current?.focus(), 10);
            }}
          >
            <IconSearch size={15} />
          </button>

          <button
            type="button"
            className="codex-icon-btn"
            data-active={inspectorOpen && inspectorTab === 'subagents' ? 'true' : undefined}
            aria-label="查看子智能体"
            title="子智能体"
            onClick={() => onOpenSubagent(null, activeTask.id)}
          >
            <IconAgentTeam size={16} />
          </button>

          <button
            type="button"
            className="codex-icon-btn"
            data-active={inspectorOpen && inspectorTab !== 'subagents' ? 'true' : undefined}
            aria-label="切换右侧变更面板"
            title="变更与产物检查器"
            onClick={onToggleInspector}
          >
            <IconRightPanelToggle size={16} />
          </button>
        </div>
      </div>

      {/* In-Thread Ctrl+F Find Bar */}
      {findOpen && (
        <div className="codex-find-bar" role="search" aria-label="对话内查找">
          <IconSearch size={14} style={{ color: 'var(--text-tertiary)', flex: 'none' }} />
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            placeholder="查找消息、命令或文件…"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stepFind(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                setFindOpen(false);
                setFindQuery('');
              }
            }}
          />
          {findQuery.trim() && (
            <span className="tabular-nums" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              {findMatches.length ? `${findIdx + 1}/${findMatches.length}` : '0/0'}
            </span>
          )}
          <button
            type="button"
            className="codex-icon-btn"
            style={{ width: 22, height: 22 }}
            disabled={!findMatches.length}
            title="上一处 (Shift+Enter)"
            onClick={() => stepFind(-1)}
          >
            <IconChevronDown size={13} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button
            type="button"
            className="codex-icon-btn"
            style={{ width: 22, height: 22 }}
            disabled={!findMatches.length}
            title="下一处 (Enter)"
            onClick={() => stepFind(1)}
          >
            <IconChevronDown size={13} />
          </button>
          <button
            type="button"
            className="codex-icon-btn"
            style={{ width: 22, height: 22 }}
            aria-label="关闭查找"
            onClick={() => {
              setFindOpen(false);
              setFindQuery('');
            }}
          >
            <IconClose size={13} />
          </button>
        </div>
      )}

      {/* Floating Top-Right "Agent" Companion Card (1:1 with User Screenshots 1 & 2, shown when right split pane is closed) */}
      {!inspectorOpen && companionVisible && (
        <AgentCompanionCard
          workers={latestBundle.workers}
          diffs={companionDiffs}
          sourceFiles={allSourceFiles}
          onOpenChanges={() => onOpenInspector('diff', companionDiffs[0]?.path, activeTask.id)}
          onOpenSubagents={() => onOpenSubagent(null, activeTask.id)}
          onOpenFile={(path) => onOpenInspector('diff', path, activeTask.id)}
          onOpenEvents={() => onOpenInspector('events', undefined, activeTask.id)}
        />
      )}

      {/* Left-edge Turn Minimap — 1 tick per User Turn + Fish-Eye Widths + Opaque Preview Card (1:1 with User Image 2) */}
      {minimapEntries.length > 1 && (
        <div
          className="codex-minimap-wrap"
          onMouseLeave={() => setHoveredTurnIdx(null)}
        >
          <div className="codex-minimap-ticks" aria-label="对话轮次定位条">
            {minimapEntries.map((entry, idx) => {
              const focusIdx = hoveredTurnIdx ?? activeTurnIdx;
              const dist = Math.abs(idx - focusIdx);
              const barWidth = dist === 0 ? 24 : dist === 1 ? 15 : dist === 2 ? 10 : 6;
              return (
                <button
                  key={entry.anchorKey}
                  type="button"
                  className="codex-minimap-tick-bar"
                  style={{ width: barWidth }}
                  data-active={activeTurnIdx === idx ? 'true' : undefined}
                  data-hovered={hoveredTurnIdx === idx ? 'true' : undefined}
                  data-bookmarked={bookmarkedTurns[entry.taskId] ? 'true' : undefined}
                  aria-label={`跳转到第 ${idx + 1} 轮：${entry.userTitle}`}
                  onMouseEnter={() => setHoveredTurnIdx(idx)}
                  onClick={() => jumpToAnchorKey(entry.anchorKey)}
                />
              );
            })}
          </div>

          {hoveredTurnIdx !== null && minimapEntries[hoveredTurnIdx] && (
            <div
              className="codex-minimap-card"
              role="button"
              tabIndex={0}
              onClick={() => {
                jumpToAnchorKey(minimapEntries[hoveredTurnIdx].anchorKey);
                setHoveredTurnIdx(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  jumpToAnchorKey(minimapEntries[hoveredTurnIdx].anchorKey);
                  setHoveredTurnIdx(null);
                }
              }}
            >
              <div className="codex-minimap-card-head">
                <span className="codex-minimap-card-title">
                  {minimapEntries[hoveredTurnIdx].userTitle}
                </span>
                <button
                  type="button"
                  className="codex-icon-btn"
                  style={{ width: 22, height: 22, flex: 'none' }}
                  aria-label="书签标记此轮对话"
                  title="标记此轮对话"
                  onClick={(e) => {
                    e.stopPropagation();
                    const tid = minimapEntries[hoveredTurnIdx].taskId;
                    setBookmarkedTurns((prev) => ({ ...prev, [tid]: !prev[tid] }));
                  }}
                >
                  <IconBookmark
                    size={14}
                    filled={Boolean(bookmarkedTurns[minimapEntries[hoveredTurnIdx].taskId])}
                  />
                </button>
              </div>
              <div className="codex-minimap-card-snippet">
                {minimapEntries[hoveredTurnIdx].replySnippet}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Selection Quote-to-Reply Popover */}
      {selectionOverlay && (
        <div
          className="codex-selection-popover"
          style={{ left: selectionOverlay.x, top: selectionOverlay.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              const quoted = selectionOverlay.text
                .split('\n')
                .map((l) => `> ${l}`)
                .join('\n');
              injectDraft(`${quoted}\n\n`, 'append');
              setSelectionOverlay(null);
              window.getSelection()?.removeAllRanges();
            }}
          >
            <IconCompose size={13} />
            <span>引用回复</span>
          </button>
          <button
            type="button"
            onClick={() => {
              void copyText('sel', selectionOverlay.text, '已复制选中文本');
              setSelectionOverlay(null);
              window.getSelection()?.removeAllRanges();
            }}
          >
            <IconCopy size={13} />
            <span>复制</span>
          </button>
        </div>
      )}

      {/* Centered 736px Scrollable Transcript */}
      <div
        ref={scrollRef}
        className="codex-transcript vertical-scroll-fade-mask"
        onScroll={handleScroll}
        onMouseUp={handleTranscriptMouseUp}
      >
        <div className="codex-transcript-inner">
          {focusedWorker && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-default)',
                background: 'var(--bg-surface-secondary)',
                fontSize: 13,
              }}
            >
              <span>
                正在查看子代理：<strong>{getWorkerDisplayName(focusedWorker)}</strong>
                {getWorkerDisplayRole(focusedWorker) ? ` (${getWorkerDisplayRole(focusedWorker)})` : ''}
                {focusedWorker.model ? ` · ${focusedWorker.model}` : ''}（
                {fmtStatusLabel(focusedWorker.status)}）
              </span>
              <button
                type="button"
                className="codex-toolbar-btn"
                data-variant="outline"
                onClick={onClearFocusWorker}
              >
                返回主线程
              </button>
            </div>
          )}

          {turnModels.map((tm) => {
            const { bundle, isLive, visibleEvidence, visibleApprovals, visibleEvents, assistantBlocks, computedFiles, isDirectSession, directExchanges, liveStream } =
              tm;
            const { task, assignments, workers, sessions, histories } = bundle;
            const tid = task.id;
            const progress = <SubagentProgress workers={workers} onOpen={() => onOpenSubagent(null, tid)} />;
            const longUserInput = task.input.length > 360 || task.input.split('\n').length > 6;
            const userExpanded = Boolean(expandedUsers[tid]);
            const inputFiles = Object.keys(task.files ?? {});

            const dateLabel = task.createdAt ? fmtDayDivider(task.createdAt) : '';
            const showDateSep = Boolean(dateLabel && dateLabel !== lastDateLabel);
            if (showDateSep) lastDateLabel = dateLabel;

            const userKey = `${tid}:user`;
            const procKey = `${tid}:process`;
            const apprKey = `${tid}:approval`;
            const asstKey = `${tid}:assistant`;
            const filesKey = `${tid}:files`;

            if (isDirectSession) {
              const exchanges =
                directExchanges.length > 0
                  ? directExchanges
                  : [{ key: `${tid}-init`, userText: task.input, command: false, swarmRunId: undefined, assistantTexts: [], tools: [] }];
              const liveExchangeIndex = exchanges.findLastIndex((exchange) => !exchange.command);
              return (
                <React.Fragment key={tid}>
                  {showDateSep && <div className="codex-date-sep">{dateLabel}</div>}
                  <div className="codex-turn" data-turn-anchor="true" data-anchor-key={userKey}>
                    {task.livePlan && task.livePlan.steps && task.livePlan.steps.length > 0 && (() => {
                      const doneCount = task.livePlan.steps.filter((s) => s.status === 'completed').length;
                      const pct = Math.round((doneCount / task.livePlan.steps.length) * 100);
                      return (
                        <div className="a2a-plan-banner">
                          <div className="a2a-plan-header">
                            <span className="a2a-plan-title">
                              执行计划 · {doneCount}/{task.livePlan.steps.length}
                            </span>
                            {task.livePlan.explanation && (
                              <span className="a2a-plan-expl">{task.livePlan.explanation}</span>
                            )}
                          </div>
                          <div className="a2a-plan-bar">
                            <div className="a2a-plan-bar-fill" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="a2a-plan-steps">
                            {task.livePlan.steps.map((step) => (
                              <div key={step.id} className="a2a-plan-step" data-status={step.status}>
                                <span className="a2a-plan-icon">
                                  {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '◌' : '○'}
                                </span>
                                <span className="a2a-plan-step-text">{step.title}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                    {exchanges.map((ex, exIdx) => {
                      const showLiveStream = exIdx === liveExchangeIndex && isLive && Boolean(liveStream?.text || liveStream?.reasoning);
                      return (
                        <div key={ex.key} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                          {ex.userText && (
                            <div className="codex-user-turn">
                              <div className="codex-user-bubble">
                                <div className="codex-user-bubble-text">{ex.userText}</div>
                              </div>
                            </div>
                          )}

                          {ex.swarmRunId && onOpenSwarmRun && (
                            <div className="codex-assistant-turn">
                              <button type="button" className="codex-select" onClick={() => onOpenSwarmRun(tid, ex.swarmRunId!)}>
                                <IconAgentTeam size={14} aria-hidden="true" /> 查看 Swarm 进度
                              </button>
                            </div>
                          )}

                          {ex.tools.length > 0 && (
                            <div className="a2a-tool-pills">
                              {ex.tools.map((t) => (
                                <details key={t.id} className="a2a-tool-pill" data-error={t.isError ? 'true' : undefined}>
                                  <summary>
                                    <span>{t.isError ? '✗' : '✓'}</span>
                                    <code>{t.name}</code>
                                  </summary>
                                  {t.output && (
                                    <pre className="a2a-tool-output">{t.output.slice(0, 2400)}</pre>
                                  )}
                                </details>
                              ))}
                            </div>
                          )}

                          {ex.assistantTexts.map((m) => (
                            <div key={m.id} className="codex-assistant-turn">
                              {m.reasoning && (
                                <details className="a2a-reasoning-box">
                                  <summary>思考过程</summary>
                                  <div className="a2a-reasoning-body">{m.reasoning}</div>
                                </details>
                              )}
                              {m.text && (
                                <Markdown
                                  text={m.text}
                                  imageFiles={{ ...(task.files ?? {}), ...tm.artFiles }}
                                  onOpenFile={(path) => onOpenInspector('diff', path, tid)}
                                  onOpenImage={(imgs, idx) => setLightbox({ images: imgs, index: idx })}
                                  onCopy={onToast}
                                />
                              )}
                            </div>
                          ))}

                          {showLiveStream && (
                            <div className="codex-assistant-turn">
                              {liveStream?.reasoning && (
                                <details className="a2a-reasoning-box" open>
                                  <summary>正在思考…</summary>
                                  <div className="a2a-reasoning-body">{liveStream.reasoning}</div>
                                </details>
                              )}
                              {liveStream?.text && (
                                <div className="a2a-live-stream">
                                  <Markdown
                                    text={liveStream.text}
                                    imageFiles={{ ...(task.files ?? {}), ...tm.artFiles }}
                                    onOpenFile={(path) => onOpenInspector('diff', path, tid)}
                                    onOpenImage={(imgs, idx) => setLightbox({ images: imgs, index: idx })}
                                    onCopy={onToast}
                                  />
                                  <span className="a2a-stream-cursor" />
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {isLive && liveToolOutputs[tid]?.text && (
                      <div className="a2a-live-terminal">
                        <div className="a2a-live-terminal-head">
                          <span className="codex-sidebar-spinner" />
                          <code>{liveToolOutputs[tid].name || 'bash'}</code>
                          <span className="a2a-muted-meta">实时输出</span>
                        </div>
                        <pre className="a2a-live-terminal-body">{liveToolOutputs[tid].text}</pre>
                      </div>
                    )}

                    {isLive && !liveStream?.text && !liveStream?.reasoning && !liveToolOutputs[tid]?.text && visibleApprovals.filter((a) => a.status === 'pending').length === 0 && (
                      <div className="a2a-live-thinking">
                        <span className="codex-sidebar-spinner" />
                        <span>{tm.liveStatusText}</span>
                      </div>
                    )}

                    {visibleApprovals
                      .filter((a) => a.status === 'pending')
                      .map((appr) => (
                        <div key={appr.id} data-anchor-key={apprKey}>
                          {appr.kind === 'reconciliation' ? (
                            <ReconciliationCard
                              approval={appr}
                              busy={decidingApprovalId === appr.id}
                              onResolve={(a, outcome) =>
                                void onDecideApproval(
                                  a,
                                  outcome === 'abort' ? 'deny' : 'approve',
                                  'once',
                                  outcome,
                                )
                              }
                            />
                          ) : (
                            <ApprovalGateCard
                              approval={appr}
                              worker={undefined}
                              busy={decidingApprovalId === appr.id}
                              onDecide={(a, d, scope) => void onDecideApproval(a, d, scope)}
                            />
                          )}
                        </div>
                      ))}

                    {task.status === 'failed' && task.verdict?.reason && (
                      <div className="a2a-error-banner" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                        <span>{task.verdict.reason}</span>
                        <button
                          type="button"
                          className="codex-toolbar-btn"
                          data-variant="outline"
                          onClick={() => onOpenSettings('providers')}
                        >
                          配置账号池
                        </button>
                      </div>
                    )}

                    {computedFiles.length > 0 && (
                      <div data-anchor-key={filesKey}>
                        <FileChangeCard
                          files={computedFiles}
                          onInspectFile={(path) => onOpenInspector('diff', path, tid)}
                          onCopy={onToast}
                          onUndo={() => {
                            if (onRewindSession) {
                              void onRewindSession(tid, 'code');
                              return;
                            }
                            const fileList = computedFiles.map((f) => f.path).join(', ');
                            injectDraft(
                              `请撤销上一轮对以下文件的改动并恢复至修改前状态：${fileList}`,
                              'replace',
                            );
                          }}
                        />
                      </div>
                    )}
                    <div className="a2a-direct-actions">
                      {!isLive && <EvidenceBadge verdict={task.verdict} evidenceCount={task.evidenceCount} />}
                      {progress}
                      {!isLive && (onRewindSession || onCompactSession) && (
                        <div className="codex-turn-menu-wrap" ref={openTurnMenuId === tid ? turnMenuRef : undefined}
                          onBlur={event => {
                            if (openTurnMenuId === tid && !event.currentTarget.contains(event.relatedTarget)) setOpenTurnMenuId(null);
                          }}>
                          <button type="button" className="codex-icon-btn" title="更多操作" aria-label="更多操作"
                            aria-expanded={openTurnMenuId === tid}
                            onClick={() => setOpenTurnMenuId(current => current === tid ? null : tid)}>
                            <IconDotsHorizontal size={16} />
                          </button>
                          {openTurnMenuId === tid && (
                            <div className="codex-popover direct-turn-options" data-side="top">
                              {onCompactSession && <button type="button" className="codex-popover-item" onClick={() => {
                                turnMenuRef.current?.querySelector('button')?.focus();
                                setOpenTurnMenuId(null);
                                void onCompactSession(tid);
                              }}>压缩上下文</button>}
                              {onRewindSession && <button type="button" className="codex-popover-item" onClick={() => {
                                turnMenuRef.current?.querySelector('button')?.focus();
                                setOpenTurnMenuId(null);
                                void onRewindSession(tid, 'code');
                              }}>回退代码</button>}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </React.Fragment>
              );
            }

            return (
              <React.Fragment key={tid}>
                {showDateSep && <div className="codex-date-sep">{dateLabel}</div>}

                <div className="codex-turn">
                  {/* 1. User Prompt Bubble */}
                  <div
                    className={`codex-user-turn ${flashedKey === userKey ? 'codex-turn-flash' : ''}`}
                    data-anchor-key={userKey}
                    data-turn-anchor="true"
                  >
                    <div className="codex-user-bubble">
                      {inputFiles.length > 0 && (() => {
                        const userImgs: PreviewImageItem[] = [];
                        const nonImgFiles: string[] = [];
                        for (const f of inputFiles) {
                          const src = isImagePath(f) ? toImageDataUrl(f, task.files?.[f]) : null;
                          if (src) {
                            userImgs.push({
                              id: `${tid}-uimg-${f}`,
                              src,
                              name: f.replace(/\\/g, '/').split('/').pop() || f,
                              caption: f,
                            });
                          } else {
                            nonImgFiles.push(f);
                          }
                        }
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 }}>
                            {userImgs.length > 0 && (
                              <div className="codex-image-strip" style={{ paddingLeft: 0 }}>
                                {userImgs.map((img, idx) => (
                                  <button
                                    key={img.id}
                                    type="button"
                                    className="codex-image-thumb-card"
                                    title={`点击查看大图 ${img.name}`}
                                    onClick={() => setLightbox({ images: userImgs, index: idx })}
                                  >
                                    <img src={img.src} alt={img.name} className="codex-image-thumb-img" />
                                  </button>
                                ))}
                              </div>
                            )}
                            {nonImgFiles.length > 0 && (
                              <div className="codex-composer-attachments">
                                {nonImgFiles.map((f) => (
                                  <button
                                    key={f}
                                    type="button"
                                    className="codex-attach-chip"
                                    style={{ cursor: 'pointer' }}
                                    onClick={() => onOpenInspector('artifacts', f, tid)}
                                  >
                                    <IconFileDoc size={12} />
                                    <span>{f}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      <div
                        className={`codex-user-bubble-text ${
                          longUserInput && !userExpanded ? 'codex-user-bubble-clamped' : ''
                        }`}
                      >
                        {task.input}
                      </div>
                      {longUserInput && (
                        <button
                          type="button"
                          className="codex-show-more-btn"
                          onClick={() =>
                            setExpandedUsers((prev) => ({ ...prev, [tid]: !prev[tid] }))
                          }
                        >
                          <span>{userExpanded ? '收起' : '显示更多'}</span>
                          <IconChevronDown
                            size={14}
                            style={{
                              transform: userExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                              transition: 'transform var(--duration-basic) var(--ease-out)',
                            }}
                          />
                        </button>
                      )}
                    </div>

                    <div className="codex-msg-meta">
                      {task.createdAt && <span>{fmtClock(task.createdAt)}</span>}
                      <button
                        type="button"
                        className="codex-icon-btn"
                        style={{ width: 24, height: 24 }}
                        aria-label="编辑并重发"
                        title="编辑并重发"
                        onClick={() => {
                          injectDraft(task.input, 'replace');
                          onToast('已载入输入框，可直接修改后重发');
                        }}
                      >
                        <IconCompose size={13} />
                      </button>
                      <button
                        type="button"
                        className="codex-icon-btn"
                        style={{ width: 24, height: 24 }}
                        aria-label="复制消息"
                        title="复制消息"
                        onClick={() => void copyText(`u-${tid}`, task.input, '已复制提示词')}
                      >
                        {copiedKey === `u-${tid}` ? <IconCheck size={14} /> : <IconCopy size={14} />}
                      </button>
                    </div>
                  </div>

                  {/* 2. Turn Process Timeline (Live interleaved stream OR exact `用时 X >` collapsible!) */}
                  {tm.hasProcess && (
                    <div
                      className={flashedKey === procKey ? 'codex-turn-flash' : undefined}
                      data-anchor-key={procKey}
                    >
                      <ActivityBlock
                        plan={task.plan}
                        assignments={assignments}
                        workers={workers}
                        sessions={sessions}
                        histories={histories}
                        evidence={visibleEvidence}
                        approvals={visibleApprovals}
                        taskFiles={task.files}
                        artifactFiles={tm.artFiles}
                        events={visibleEvents}
                        startedAt={task.createdAt}
                        durationMs={tm.durationMs}
                        isLive={isLive}
                        liveText={tm.liveStatusText}
                        finalProseTexts={assistantBlocks.map((b) => b.text)}
                        onOpenSubagent={(wId) => onOpenSubagent(wId, tid)}
                        onInspectFile={(path) => onOpenInspector('diff', path, tid)}
                        onOpenImage={(imgs, idx) => setLightbox({ images: imgs, index: idx })}
                        onCopy={onToast}
                      />
                    </div>
                  )}

                  {/* Live Backend Waiting-for-Model Notice (only when live backend has empty model catalog) */}
                  {isLiveBackend && !routerReady && task.status === 'planning' && (
                    <div className="codex-live-backend-banner">
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <strong style={{ color: 'var(--text-default)', fontWeight: 500 }}>
                          已持久化至实时后端 SQLite
                        </strong>{' '}
                        <span className="tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                          ({tid.slice(0, 8)} · v{task.version})
                        </span>
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                          当前尚未在号池中启用模型，请点击右侧「账号号池」添加账号并获取模型后即可立刻对话。
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
                        <button
                          type="button"
                          className="codex-toolbar-btn"
                          data-variant="outline"
                          onClick={() => onOpenSettings('providers')}
                        >
                          模型与供应商
                        </button>
                        <button
                          type="button"
                          className="codex-toolbar-btn"
                          data-variant="outline"
                          onClick={() => void onControlTask(task, 'pause')}
                        >
                          暂停
                        </button>
                        {onSwitchToDemo && (
                          <button
                            type="button"
                            className="codex-toolbar-btn"
                            onClick={onSwitchToDemo}
                          >
                            本地演示流
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 3. Single Clear Approval Entry Point per pending approval */}
                  {visibleApprovals
                    .filter((a) => a.status === 'pending')
                    .map((appr) => {
                      const apprWorker =
                        workers.find((w) => w.id === appr.workerId)
                        ?? resolveWorkerForPayload(appr.nexus, workers);
                      return (
                        <div
                          key={appr.id}
                          className={flashedKey === apprKey ? 'codex-turn-flash' : undefined}
                          data-anchor-key={apprKey}
                        >
                          {appr.kind === 'reconciliation' ? (
                            <ReconciliationCard
                              approval={appr}
                              busy={decidingApprovalId === appr.id}
                              onResolve={(a, outcome) =>
                                void onDecideApproval(
                                  a,
                                  outcome === 'abort' ? 'deny' : 'approve',
                                  'once',
                                  outcome,
                                )
                              }
                            />
                          ) : (
                            <ApprovalGateCard
                              approval={appr}
                              worker={apprWorker}
                              busy={decidingApprovalId === appr.id}
                              onDecide={(a, d, scope) => void onDecideApproval(a, d, scope)}
                            />
                          )}
                        </div>
                      );
                    })}

                  {/* 4. Assistant Closing Response (concise by default, full report 1 click away!) */}
                  {(assistantBlocks.length > 0 || tm.artifactImages.length > 0) && (
                    <div
                      className={`codex-assistant-turn ${flashedKey === asstKey ? 'codex-turn-flash' : ''}`}
                      data-anchor-key={asstKey}
                    >
                      {assistantBlocks.map((block) => {
                        const { shortText, isTruncated } = extractConciseClosing(block.text);
                        const isReplyExpanded = Boolean(expandedReplies[block.id]);
                        const displayText = isTruncated && !isReplyExpanded ? shortText : block.text;
                        return (
                          <div key={block.id}>
                            <Markdown
                              text={displayText}
                              imageFiles={{ ...(task.files ?? {}), ...tm.artFiles }}
                              onOpenFile={(path) => onOpenInspector('diff', path, tid)}
                              onOpenImage={(imgs, idx) => setLightbox({ images: imgs, index: idx })}
                              onCopy={onToast}
                            />
                            {isTruncated && (
                              <button
                                type="button"
                                className="codex-reply-expand-btn"
                                onClick={() =>
                                  setExpandedReplies((prev) => ({
                                    ...prev,
                                    [block.id]: !prev[block.id],
                                  }))
                                }
                              >
                                <span>
                                  {isReplyExpanded
                                    ? '收起为简短总结'
                                    : `展开完整回复（共 ${block.text.length} 字）`}
                                </span>
                                <IconChevronDown
                                  size={13}
                                  style={{
                                    transform: isReplyExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                                    transition: 'transform var(--duration-basic) var(--ease-out)',
                                  }}
                                />
                              </button>
                            )}
                          </div>
                        );
                      })}

                      {tm.artifactImages.length > 0 && (
                        <div className="codex-md-image-block" style={{ marginTop: 8 }}>
                          <div className="codex-image-strip" style={{ paddingLeft: 0 }}>
                            {tm.artifactImages.map((img, idx) => (
                              <button
                                key={img.id}
                                type="button"
                                className="codex-md-image-thumb-btn"
                                title={`点击查看 ${img.name}`}
                                onClick={() => setLightbox({ images: tm.artifactImages, index: idx })}
                              >
                                <img src={img.src} alt={img.name} className="codex-md-image-thumb" />
                              </button>
                            ))}
                          </div>
                          <button
                            type="button"
                            className="codex-md-image-link"
                            onClick={() => setLightbox({ images: tm.artifactImages, index: 0 })}
                          >
                            <IconImageInspect size={14} />
                            <span>
                              {tm.artifactImages.length === 1
                                ? `查看图像 · ${tm.artifactImages[0].name}`
                                : `查看全部 ${tm.artifactImages.length} 张图像`}
                            </span>
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Task Failure / Cancelled / Paused inline prose when no artifact exists */}
                  {!assistantBlocks.length &&
                    (task.status === 'failed' ||
                      task.status === 'cancelled' ||
                      task.status === 'paused') && (
                      <div className="codex-assistant-turn">
                        <p
                          style={{
                            margin: 0,
                            color:
                              task.status === 'failed'
                                ? 'var(--color-danger)'
                                : 'var(--text-secondary)',
                            fontSize: 15,
                          }}
                        >
                          {task.status === 'paused'
                            ? '任务已暂停，点击顶部「恢复」可从当前检查点继续执行。'
                            : task.status === 'cancelled'
                              ? '任务已取消。'
                              : `任务执行未完成${task.code ? `（${task.code}）` : ''}。`}
                          {task.verdict?.reason ? ` ${task.verdict.reason}` : ''}
                        </p>
                      </div>
                    )}

                  {task.verdict && (
                    <div
                      style={{
                        fontSize: 13,
                        lineHeight: '19px',
                        color: 'var(--text-tertiary)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <span
                        className="codex-status-dot"
                        data-tone={task.verdict.accepted ? 'live' : 'danger'}
                      />
                      <span>
                        Reviewer {task.verdict.accepted ? '验收通过' : '验收未通过'}：
                        {task.verdict.reason}
                      </span>
                    </div>
                  )}

                  {/* 5. File Change / Diff Resource Card (1:1 with live/conversation.png) */}
                  {computedFiles.length > 0 && (
                    <div
                      className={flashedKey === filesKey ? 'codex-turn-flash' : undefined}
                      data-anchor-key={filesKey}
                    >
                      <FileChangeCard
                        files={computedFiles}
                        onInspectFile={(path) => onOpenInspector('diff', path, tid)}
                        onCopy={onToast}
                        onUndo={() => {
                          const fileList = computedFiles.map((f) => f.path).join(', ');
                          injectDraft(
                            `请撤销上一轮对以下文件的改动并恢复至修改前状态：${fileList}`,
                            'replace',
                          );
                          onToast('已生成撤销变更指令，确认后按 Enter 提交');
                        }}
                      />
                    </div>
                  )}

                  {/* 6. Turn Action Footer (Copy + `...` Dropdown Menu + Usage) */}
                  {(assistantBlocks.length > 0 || !isLive) && (
                    <div className="codex-msg-meta" data-always="true">
                      <button
                        type="button"
                        className="codex-icon-btn"
                        style={{ width: 26, height: 26 }}
                        aria-label="复制"
                        title="复制回复"
                        onClick={() =>
                          void copyText(
                            `a-${tid}`,
                            assistantBlocks.map((b) => b.text).join('\n\n') ||
                              task.verdict?.reason ||
                              task.input,
                            '已复制回复',
                          )
                        }
                      >
                        {copiedKey === `a-${tid}` ? <IconCheck size={14} /> : <IconCopy size={14} />}
                      </button>

                      <div
                        className="codex-turn-menu-wrap"
                        ref={openTurnMenuId === tid ? turnMenuRef : undefined}
                      >
                        <button
                          type="button"
                          className="codex-icon-btn"
                          style={{ width: 26, height: 26 }}
                          aria-label="更多操作"
                          title="更多操作"
                          onClick={() => setOpenTurnMenuId((cur) => (cur === tid ? null : tid))}
                        >
                          <IconDotsHorizontal size={15} />
                        </button>

                        {openTurnMenuId === tid && (
                          <div
                            className="codex-popover"
                            data-side="top"
                            style={{ left: 0, width: 224 }}
                          >
                            <button
                              type="button"
                              className="codex-popover-item"
                              onClick={() => {
                                setOpenTurnMenuId(null);
                                void copyText(
                                  `md-${tid}`,
                                  assistantBlocks.map((b) => b.text).join('\n\n') || task.input,
                                  '已复制 Markdown 原文',
                                );
                              }}
                            >
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                                <IconCopy size={13} />
                                <span>复制 Markdown 原文</span>
                              </span>
                            </button>
                            <button
                              type="button"
                              className="codex-popover-item"
                              onClick={() => {
                                setOpenTurnMenuId(null);
                                exportThreadMarkdown();
                              }}
                            >
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                                <IconDownload size={13} />
                                <span>导出完整对话 (.md)</span>
                              </span>
                            </button>
                            <button
                              type="button"
                              className="codex-popover-item"
                              onClick={() => {
                                setOpenTurnMenuId(null);
                                void onSubmitFollowup(task.input, task.files ?? {});
                              }}
                            >
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                                <IconReset size={13} />
                                <span>使用此提示词重新运行</span>
                              </span>
                            </button>
                            <div className="codex-popover-divider" />
                            <button
                              type="button"
                              className="codex-popover-item"
                              onClick={() => {
                                setOpenTurnMenuId(null);
                                onOpenInspector('artifacts', undefined, tid);
                              }}
                            >
                              <span>查看产物与文件</span>
                            </button>
                            <button
                              type="button"
                              className="codex-popover-item"
                              onClick={() => {
                                setOpenTurnMenuId(null);
                                onOpenInspector('events', undefined, tid);
                              }}
                            >
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                                <IconHistory size={13} />
                                <span>查看版本快照与 SSE 流</span>
                              </span>
                            </button>
                          </div>
                        )}
                      </div>

                      {tm.totalTokens > 0 && (
                        <span style={{ fontSize: 12, marginLeft: 4 }} className="tabular-nums">
                          {fmtTokens(tm.totalTokens)} tokens · {fmtUSD(tm.totalUSD)}
                        </span>
                      )}
                    </div>
                  )}
                  {progress}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Floating Scroll-to-Bottom Pill (exact 32px circle) */}
      <button
        type="button"
        className="codex-scroll-bottom-btn"
        data-visible={showScrollBottom ? 'true' : undefined}
        aria-label="滚动到底部"
        title="最新一条回复"
        onClick={scrollToBottom}
      >
        <IconArrowDown size={15} />
      </button>

      {/* Bottom Floating Composer */}
      <div className="codex-thread-composer-dock">
        <Composer
          variant="thread"
          codexMode={codexMode}
          projects={projects}
          selectedProject={selectedProject}
          models={models}
          selectedModel={selectedModel}
          effort={effort}
          permissionMode={permissionMode}
          gitStatus={gitStatus}
          mentionFiles={mentionFiles}
          mentionPlugins={mentionPlugins}
          mentionSkills={mentionSkills}
          draftInjection={draftInjection}
          isRunning={anyLive}
          submitting={submitting}
          onSelectProject={onSelectProject}
          onOpenCreateProject={onOpenCreateProject}
          onSelectModel={onSelectModel}
          onChangeEffort={onChangeEffort}
          onChangePermission={onChangePermission}
          onRefreshGitStatus={onRefreshGitStatus}
          onCheckoutGitBranch={onCheckoutGitBranch}
          onInitGitRepo={onInitGitRepo}
          onSlashCommand={(command) => {
            if (command.cmd === '/companion') {
              if (inspectorOpen) onToggleInspector();
              setCompanionVisible(inspectorOpen || !companionVisible);
            } else onSlashCommand(command);
          }}
          commandAvailability={commandAvailability}
          searchMentionFiles={searchMentionFiles}
          onSubmitGoal={onSubmitGoal}
          onSubmit={onSubmitFollowup}
          onStop={anyLive ? () => void onControlTask(activeTask, 'pause') : undefined}
        />
      </div>

      <ImageLightbox
        images={lightbox?.images ?? []}
        index={lightbox?.index ?? null}
        onChangeIndex={(next) =>
          setLightbox((cur) => (next === null || !cur ? null : { ...cur, index: next }))
        }
      />
    </div>
  );
};
