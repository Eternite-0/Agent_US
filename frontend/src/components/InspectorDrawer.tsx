import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AciBudgetWatermarks, Approval, InspectorTab, Task, TaskBundle, Worker, SwarmCommandReceipt } from '../types/backend';
import { aggregateFileChanges, decodeBase64Utf8, type ComputedFileDiff } from '../utils/diff';
import { fmtClock, fmtStatusLabel, fmtTokens, fmtUSD } from '../utils/format';
import {
  eventMatchesWorker,
  getWorkerActivityLabel,
  getWorkerDisplayName as resolveWorkerName,
  getWorkerDisplayRole,
  subtaskTitle,
} from '../utils/worker';
import { ActivityBlock } from './ActivityBlock';
import { subagentOverview, workerStatusLabels } from '../utils/subagentProgress';
import { WorkerStatusMark } from './WorkerStatusMark';
import { AgentAvatar } from './AgentAvatar';
import {
  IconAgentTeam,
  IconArrowBack,
  IconBranch,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconColumns,
  IconCopy,
  IconDagNodes,
  IconDiffBox,
  IconDownload,
  IconFileDoc,
  IconFolder,
  IconHistory,
  IconPlus,
  IconRightPanelToggle,
  IconSearch,
} from './Icons';
import { ImageLightbox, isImagePath, toImageDataUrl, type PreviewImageItem } from './ImageLightbox';
import { Markdown } from './Markdown';
import type { AgentBackendClient } from '../api/client';
import { AutonomousRunPanel } from './AutonomousRunPanel';
import type { SwarmSection } from './slashCommands';

export const DEFAULT_INSPECTOR_WIDTH = 400;
const TASK_PREVIEW_LIMIT = 10;
interface InspectorDrawerProps {
  open: boolean;
  width: number;
  tab: InspectorTab;
  selectedFile: string | null;
  selectedSubagentId: string | null;
  projectName?: string;
  bundle: TaskBundle | null;
  client: AgentBackendClient;
  sessionId: string | null;
  preferredRunId?: string;
  swarmReceipt?: SwarmCommandReceipt;
  swarmEventSeq?: number;
  swarmApprovals?: Approval[];
  tabRequest?: number;
  swarmSectionRequest?: { section: SwarmSection };
  onResize: (width: number) => void;
  onChangeTab: (tab: InspectorTab) => void;
  onSelectFile: (path: string) => void;
  onSelectSubagent: (workerId: string | null) => void;
  onFetchVersion?: (taskId: string, version: number) => Promise<Task | null>;
  onClose: () => void;
  onToast: (msg: string) => void;
}

type OpenPaneTab =
  | { id: 'subagents'; kind: 'subagents'; label: string }
  | { id: 'events'; kind: 'events'; label: string }
  | { id: 'autonomous'; kind: 'autonomous'; label: string }
  | { id: `file:${string}`; kind: 'file'; path: string; label: string };

interface TreeDirNode {
  kind: 'dir';
  name: string;
  fullPath: string;
  children: TreeNode[];
}

interface TreeFileNode {
  kind: 'file';
  name: string;
  path: string;
  diff: ComputedFileDiff;
}

type TreeNode = TreeDirNode | TreeFileNode;

function buildFileTree(diffs: ComputedFileDiff[]): TreeNode[] {
  const root: TreeDirNode = { kind: 'dir', name: '', fullPath: '', children: [] };

  for (const diff of diffs) {
    const parts = diff.path.replace(/\\/g, '/').split('/').filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      if (isLast) {
        cur.children.push({ kind: 'file', name: part, path: diff.path, diff });
      } else {
        const nextPath = cur.fullPath ? `${cur.fullPath}/${part}` : part;
        let sub = cur.children.find(
          (c): c is TreeDirNode => c.kind === 'dir' && c.name === part,
        );
        if (!sub) {
          sub = { kind: 'dir', name: part, fullPath: nextPath, children: [] };
          cur.children.push(sub);
        }
        cur = sub;
      }
    }
  }

  const sortNodes = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((n) => (n.kind === 'dir' ? { ...n, children: sortNodes(n.children) } : n));

  return sortNodes(root.children);
}

/** Lightweight safe React tokenizer for code preview (no dangerouslySetInnerHTML!) */
function highlightCodeLine(line: string): React.ReactNode {
  if (!line) return ' ';
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return <span className="tok-com">{line}</span>;
  }
  const regex =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:import|export|from|const|let|var|function|return|async|await|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|class|extends|interface|type|default|true|false|null|undefined|def|class|self|None|True|False)\b|\b\d+(?:\.\d+)?\b)/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith('`')) {
      parts.push(<span key={k++} className="tok-str">{tok}</span>);
    } else if (/^\d/.test(tok)) {
      parts.push(<span key={k++} className="tok-num">{tok}</span>);
    } else {
      parts.push(<span key={k++} className="tok-kw">{tok}</span>);
    }
    last = regex.lastIndex;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

export const InspectorDrawer: React.FC<InspectorDrawerProps> = ({
  open,
  width,
  tab,
  selectedFile,
  selectedSubagentId,
  projectName = 'Agent_US',
  bundle,
  client,
  sessionId,
  preferredRunId,
  swarmReceipt,
  swarmEventSeq,
  swarmApprovals,
  tabRequest,
  swarmSectionRequest,
  onResize,
  onChangeTab,
  onSelectFile,
  onSelectSubagent,
  onFetchVersion,
  onClose,
  onToast,
}) => {
  const [resizing, setResizing] = useState(false);
  const [openTabs, setOpenTabs] = useState<OpenPaneTab[]>([
    { id: 'subagents', kind: 'subagents', label: '子智能体' },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('subagents');
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);

  // File IDE tab states
  const [showChanges, setShowChanges] = useState(false);
  const [diffMode, setDiffMode] = useState<'unified' | 'split'>('unified');
  const [treeFilter, setTreeFilter] = useState('');
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const [copiedFile, setCopiedFile] = useState(false);
  const [showAllSubagents, setShowAllSubagents] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [lightbox, setLightbox] = useState<{ images: PreviewImageItem[]; index: number } | null>(null);

  // Version snapshot state
  const [loadedVersion, setLoadedVersion] = useState<Task | null>(null);
  const [loadingVersion, setLoadingVersion] = useState(false);

  const panelBodyId = useId();
  const tabDomId = (id: string) => `${panelBodyId}-tab-${encodeURIComponent(id)}`;
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingTabFocus = useRef<string | null>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const closePanelRef = useRef<HTMLButtonElement>(null);
  const backToWorkersRef = useRef<HTMLButtonElement>(null);
  const previousWorkerRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true });
      openerRef.current = null;
      return;
    }
    const opener = document.activeElement;
    if (opener instanceof HTMLElement && opener !== document.body && !panelRef.current?.contains(opener)) {
      openerRef.current = opener;
      closePanelRef.current?.focus({ preventScroll: true });
    }
  }, [open, tabRequest]);

  useEffect(() => {
    if (!plusMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setPlusMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [plusMenuOpen]);

  const diffs = useMemo(() => {
    if (!bundle) return [];
    const changes = bundle.evidence.flatMap((e) => e.changes ?? []);
    const artFiles: Record<string, string> = {};
    for (const a of bundle.artifacts) {
      if (a.published) Object.assign(artFiles, a.files ?? {});
    }
    const baseDiffs = aggregateFileChanges(changes, artFiles, bundle.task.files);
    // Also expose user-attached task files so clicking any attachment opens cleanly in the IDE pane
    const existing = new Set(baseDiffs.map((d) => d.path));
    const extras: ComputedFileDiff[] = [];
    for (const [k, v] of Object.entries(bundle.task.files ?? {})) {
      if (existing.has(k)) continue;
      const txt = decodeBase64Utf8(v);
      extras.push({
        path: k,
        added: 0,
        deleted: 0,
        isNew: false,
        isDeleted: false,
        beforeText: txt,
        afterText: txt,
        lines: txt
          .replace(/\r\n/g, '\n')
          .split('\n')
          .map((line, i) => ({ kind: 'context', oldLine: i + 1, newLine: i + 1, text: line })),
      });
    }
    return [...baseDiffs, ...extras];
  }, [bundle]);

  const ensureTab = (next: OpenPaneTab) => {
    setOpenTabs((prev) => (prev.some((t) => t.id === next.id) ? prev : [...prev, next]));
    setActiveTabId(next.id);
  };

  // Sync external tab/file/subagent triggers cleanly into our multi-tab bar
  useEffect(() => {
    if (!open) return;
    if (tab === 'subagents') {
      ensureTab({ id: 'subagents', kind: 'subagents', label: '子智能体' });
    } else if (tab === 'autonomous') {
      ensureTab({ id: 'autonomous', kind: 'autonomous', label: '自主任务' });
    } else if (tab === 'events') {
      ensureTab({ id: 'events', kind: 'events', label: '事件与版本' });
    } else if (tab === 'diff' || tab === 'artifacts') {
      const targetPath = selectedFile || diffs[0]?.path;
      const targetDiff = diffs.find((d) => d.path === targetPath) ?? diffs[0];
      if (tab === 'diff' && targetDiff && (targetDiff.added > 0 || targetDiff.deleted > 0)) {
        setShowChanges(true);
      } else if (tab === 'artifacts') {
        setShowChanges(false);
      }
      if (targetPath) {
        const base = targetPath.replace(/\\/g, '/').split('/').pop() || targetPath;
        ensureTab({ id: `file:${targetPath}`, kind: 'file', path: targetPath, label: base });
      } else {
        ensureTab({ id: 'file:__all__', kind: 'file', path: '__all__', label: '变更' });
      }
    }
  }, [open, tab, tabRequest, selectedFile, diffs.length]);

  const activePaneTab = openTabs.find((t) => t.id === activeTabId) ?? openTabs[0] ?? null;

  useEffect(() => {
    const previousWorker = previousWorkerRef.current;
    previousWorkerRef.current = selectedSubagentId;
    if (!open || activePaneTab?.kind !== 'subagents') return;
    if (selectedSubagentId) {
      backToWorkersRef.current?.focus({ preventScroll: true });
    } else if (previousWorker) {
      panelRef.current?.querySelector<HTMLButtonElement>(`[data-worker-id="${CSS.escape(previousWorker)}"]`)?.focus();
    }
  }, [open, activePaneTab?.kind, selectedSubagentId]);

  const activeFileDiff = useMemo(() => {
    if (activePaneTab?.kind === 'file' && activePaneTab.path !== '__all__') {
      return diffs.find((d) => d.path === activePaneTab.path) ?? diffs[0] ?? null;
    }
    return diffs.find((d) => d.path === selectedFile) ?? diffs[0] ?? null;
  }, [activePaneTab, diffs, selectedFile]);

  const filteredDiffs = useMemo(() => {
    const q = treeFilter.trim().toLowerCase();
    if (!q) return diffs;
    return diffs.filter((d) => d.path.toLowerCase().includes(q));
  }, [diffs, treeFilter]);

  const fileTree = useMemo(() => buildFileTree(filteredDiffs), [filteredDiffs]);

  const addedLineNumbers = useMemo(() => {
    const s = new Set<number>();
    if (!activeFileDiff) return s;
    for (const ln of activeFileDiff.lines) {
      if (ln.kind === 'add' && ln.newLine !== null) s.add(ln.newLine);
    }
    return s;
  }, [activeFileDiff]);

  const latestAciWatermarks = useMemo<AciBudgetWatermarks | null>(() => {
    const events = bundle?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const p = (events[i]?.payload ?? {}) as Record<string, unknown>;
      const nested = (
        p.budgetWatermarks && typeof p.budgetWatermarks === 'object'
          ? p.budgetWatermarks
          : p.watermarks && typeof p.watermarks === 'object'
            ? p.watermarks
            : null
      ) as Record<string, unknown> | null;
      const src = nested ?? p;
      const usedTokens = typeof src.usedTokens === 'number' ? src.usedTokens : undefined;
      const maxTokens = typeof src.maxTokens === 'number' ? src.maxTokens : undefined;
      const dtocWatermark =
        typeof src.dtocWatermark === 'number'
          ? src.dtocWatermark
          : typeof src.dtocMinPromptTokens === 'number'
            ? src.dtocMinPromptTokens
            : undefined;
      const postTestReserveActive =
        typeof src.postTestReserveActive === 'boolean' ? src.postTestReserveActive : undefined;
      const supervisorCircuitOpen =
        typeof src.supervisorCircuitOpen === 'boolean'
          ? src.supervisorCircuitOpen
          : typeof src.circuitOpen === 'boolean'
            ? src.circuitOpen
            : undefined;
      if (
        nested ||
        usedTokens !== undefined ||
        maxTokens !== undefined ||
        dtocWatermark !== undefined ||
        postTestReserveActive !== undefined ||
        supervisorCircuitOpen !== undefined
      ) {
        return {
          usedTokens,
          maxTokens,
          utilizationRatio: typeof src.utilizationRatio === 'number' ? src.utilizationRatio : undefined,
          reserveTokens: typeof src.reserveTokens === 'number' ? src.reserveTokens : undefined,
          postTestReserveActive,
          dtocWatermark,
          dtocMinPromptTokens: typeof src.dtocMinPromptTokens === 'number' ? src.dtocMinPromptTokens : undefined,
          dtocPolicy: typeof src.dtocPolicy === 'string' ? src.dtocPolicy : null,
          supervisorCircuitOpen,
        };
      }
    }
    return null;
  }, [bundle?.events]);

  const splitRows = useMemo(() => {
    if (!activeFileDiff) return [];
    const pairs: Array<{
      left: { ln: number | null; kind: 'context' | 'del' | 'empty'; text: string };
      right: { ln: number | null; kind: 'context' | 'add' | 'empty'; text: string };
    }> = [];
    const lines = activeFileDiff.lines;
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind === 'context') {
        pairs.push({
          left: { ln: lines[i].oldLine, kind: 'context', text: lines[i].text },
          right: { ln: lines[i].newLine, kind: 'context', text: lines[i].text },
        });
        i++;
      } else {
        const dels: typeof lines = [];
        const adds: typeof lines = [];
        while (i < lines.length && lines[i].kind !== 'context') {
          if (lines[i].kind === 'del') dels.push(lines[i]);
          else adds.push(lines[i]);
          i++;
        }
        const maxLen = Math.max(dels.length, adds.length);
        for (let j = 0; j < maxLen; j++) {
          pairs.push({
            left: dels[j]
              ? { ln: dels[j].oldLine, kind: 'del', text: dels[j].text }
              : { ln: null, kind: 'empty', text: '' },
            right: adds[j]
              ? { ln: adds[j].newLine, kind: 'add', text: adds[j].text }
              : { ln: null, kind: 'empty', text: '' },
          });
        }
      }
    }
    return pairs;
  }, [activeFileDiff]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setResizing(true);
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(380, Math.min(980, startW - (ev.clientX - startX)));
      onResize(next);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const selectTab = (next: OpenPaneTab) => {
    setActiveTabId(next.id);
    if (next.kind === 'file') {
      onChangeTab('diff');
      if (next.path !== '__all__') onSelectFile(next.path);
    } else onChangeTab(next.kind);
  };

  const closeTab = (id: string) => {
    const remaining = openTabs.filter((t) => t.id !== id);
    if (remaining.length === 0) {
      onClose();
      return;
    }
    const next = remaining[Math.min(openTabs.findIndex(tab => tab.id === id), remaining.length - 1)];
    setOpenTabs(remaining);
    pendingTabFocus.current = next.id;
    if (activePaneTab?.id === id) selectTab(next);
  };

  useEffect(() => {
    const next = pendingTabFocus.current;
    if (next) tabRefs.current.get(next)?.focus();
    pendingTabFocus.current = null;
  }, [openTabs]);

  const openFileInPane = (path: string) => {
    const base = path.replace(/\\/g, '/').split('/').pop() || path;
    onSelectFile(path);
    onChangeTab('diff');
    ensureTab({ id: `file:${path}`, kind: 'file', path, label: base });
  };

  const copyActiveFile = async () => {
    if (!activeFileDiff) return;
    try {
      await navigator.clipboard.writeText(activeFileDiff.afterText);
      setCopiedFile(true);
      onToast(`已复制 ${activeFileDiff.path}`);
      window.setTimeout(() => setCopiedFile(false), 1200);
    } catch {
      // ignore
    }
  };

  const downloadTextFile = (filename: string, text: string) => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.split('/').pop() || 'file.txt';
    a.click();
    URL.revokeObjectURL(url);
    onToast(`已下载 ${filename}`);
  };

  const handleLoadVersion = async (v: number) => {
    if (!bundle || !onFetchVersion) return;
    setLoadingVersion(true);
    try {
      const res = await onFetchVersion(bundle.task.id, v);
      setLoadedVersion(res);
    } finally {
      setLoadingVersion(false);
    }
  };

  const renderTreeNodes = (nodes: TreeNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => {
      if (node.kind === 'dir') {
        const collapsed = Boolean(collapsedDirs[node.fullPath]);
        return (
          <div key={node.fullPath}>
            <button
              type="button"
              className="codex-tree-node"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() =>
                setCollapsedDirs((prev) => ({ ...prev, [node.fullPath]: !prev[node.fullPath] }))
              }
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                {collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
                <IconFolder size={13} style={{ color: 'var(--text-tertiary)', flex: 'none' }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {node.name}
                </span>
              </span>
            </button>
            {!collapsed && renderTreeNodes(node.children, depth + 1)}
          </div>
        );
      }

      const isCreated = !node.diff.beforeText.trim();
      const isSelected = activeFileDiff?.path === node.path;
      return (
        <button
          key={node.path}
          type="button"
          className="codex-tree-node"
          data-active={isSelected ? 'true' : undefined}
          style={{ paddingLeft: 18 + depth * 12 }}
          title={node.path}
          onClick={() => openFileInPane(node.path)}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <IconFileDoc size={13} style={{ color: 'var(--text-tertiary)', flex: 'none' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {node.name}
            </span>
          </span>
          <span className="codex-tree-badge" data-kind={isCreated ? 'add' : 'mod'}>
            {isCreated ? '+' : 'M'}
          </span>
        </button>
      );
    });

  // Subagent helper
  const assignmentById = useMemo(
    () => new Map((bundle?.assignments ?? []).map((a) => [a.id, a])),
    [bundle?.assignments],
  );
  const getTaskLabel = (w: Worker) => {
    const asgn = w.assignmentId ? assignmentById.get(w.assignmentId) : undefined;
    return subtaskTitle(asgn?.objective, resolveWorkerName(w, { assignment: asgn }));
  };

  const { tasks, history } = useMemo(() => subagentOverview(bundle?.workers ?? []), [bundle?.workers]);
  useEffect(() => {
    setShowAllSubagents(false);
    setHistoryOpen(false);
  }, [bundle?.task.id]);
  const focusedSubagent = selectedSubagentId
    ? tasks.find(worker => worker.id === selectedSubagentId) ?? history.find(worker => worker.id === selectedSubagentId)
    : null;

  const focusedAssignment = focusedSubagent?.assignmentId ? assignmentById.get(focusedSubagent.assignmentId) : undefined;

  function renderWorkerRow(worker: Worker) {
    const name = getTaskLabel(worker);
    return (
      <button key={worker.id} type="button" className="codex-subagent-list-row" data-worker-id={worker.id}
        data-status={worker.status} onClick={() => onSelectSubagent(worker.id)}>
        <AgentAvatar role={getWorkerDisplayRole(worker)} />
        <span className="subagent-row-name" title={name}>{name}</span>
        <span className="subagent-row-meta"><WorkerStatusMark status={worker.status} />{workerStatusLabels[worker.status] ?? workerStatusLabels.unknown}</span>
      </button>
    );
  }

  return (
    <aside
      id="workspace-inspector"
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && !lightbox) {
          event.stopPropagation();
          if (plusMenuOpen) {
            setPlusMenuOpen(false);
            plusMenuRef.current?.querySelector('button')?.focus({ preventScroll: true });
          } else onClose();
        }
      }}
      className="codex-drawer"
      data-open={open ? 'true' : undefined}
      data-resizing={resizing ? 'true' : undefined}
      style={{ width: open ? width : 0 }}
      aria-label="右侧工作区面板"
      inert={!open}
    >
      {open && <div className="codex-drawer-resizer" onMouseDown={startResize} title="拖拽调整右侧工作区宽度" />}

      <div className="codex-drawer-inner" style={{ width }}>
        {/* Multi-Tab Bar (1:1 with User Screenshots 3, 4, 5!) */}
        <div className="codex-split-tabbar">
          <div className="codex-split-tabs">
            <div className="codex-split-tablist" role="tablist" aria-label="工作区标签页">
              {openTabs.map((t, index) => {
                const active = activePaneTab?.id === t.id;
                return (
                  <div key={t.id} className="codex-split-tab" data-active={active ? 'true' : undefined}>
                    <button type="button" role="tab" id={tabDomId(t.id)} aria-controls={panelBodyId}
                      aria-selected={active} tabIndex={active ? 0 : -1} className="codex-split-tab-trigger"
                      ref={node => { if (node) tabRefs.current.set(t.id, node); else tabRefs.current.delete(t.id); }}
                      onClick={() => selectTab(t)}
                      onKeyDown={event => {
                        if (event.key === 'Delete') { event.preventDefault(); closeTab(t.id); return; }
                        const n = openTabs.length;
                        const nextIndex = event.key === 'ArrowRight' ? (index + 1) % n
                          : event.key === 'ArrowLeft' ? (index + n - 1) % n
                          : event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : -1;
                        if (nextIndex < 0) return;
                        event.preventDefault();
                        selectTab(openTabs[nextIndex]);
                        tabRefs.current.get(openTabs[nextIndex].id)?.focus();
                      }}>
                      {t.kind === 'subagents' ? <IconAgentTeam size={13} />
                        : t.kind === 'autonomous' ? <IconDagNodes size={13} />
                        : t.kind === 'events' ? <IconHistory size={13} /> : <IconFileDoc size={13} />}
                      <span className="codex-split-tab-label">{t.label}</span>
                    </button>
                    <button type="button" className="codex-split-tab-close" tabIndex={-1}
                      aria-label={`关闭 ${t.label}`} onClick={() => closeTab(t.id)}><IconClose size={11} /></button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="codex-split-actions">
            <div className="codex-split-add" ref={plusMenuRef}>
              <button
                type="button"
                className="codex-icon-btn"
                style={{ width: 26, height: 26 }}
                aria-label="打开面板标签页"
                aria-expanded={plusMenuOpen}
                title="打开面板标签页"
                onClick={() => setPlusMenuOpen((v) => !v)}
              >
                <IconPlus size={14} />
              </button>
              {plusMenuOpen && (
                <div className="codex-popover" data-side="bottom">
                  <button
                    type="button"
                    className="codex-popover-item"
                    onClick={() => {
                      setPlusMenuOpen(false);
                      onChangeTab('subagents');
                      ensureTab({ id: 'subagents', kind: 'subagents', label: '子智能体' });
                    }}
                  >
                    <span>子智能体</span>
                  </button>
                  <button type="button" className="codex-popover-item" onClick={() => {
                    setPlusMenuOpen(false);
                    onChangeTab('autonomous');
                    ensureTab({ id: 'autonomous', kind: 'autonomous', label: '自主任务' });
                  }}>
                    <span><IconDagNodes size={14} /> 自主任务</span>
                  </button>
                  <button
                    type="button"
                    className="codex-popover-item"
                    onClick={() => {
                      setPlusMenuOpen(false);
                      const firstPath = diffs[0]?.path;
                      if (firstPath) openFileInPane(firstPath);
                      else {
                        onChangeTab('diff');
                        ensureTab({ id: 'file:__all__', kind: 'file', path: '__all__', label: '变更' });
                      }
                    }}
                  >
                    <span>文件与变更 Diff</span>
                  </button>
                  <button
                    type="button"
                    className="codex-popover-item"
                    onClick={() => {
                      setPlusMenuOpen(false);
                      onChangeTab('events');
                      ensureTab({ id: 'events', kind: 'events', label: '事件与版本' });
                    }}
                  >
                    <span>SSE 事件与版本</span>
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="codex-icon-btn"
              style={{ width: 26, height: 26 }}
              title={width > 700 ? '还原分屏宽度' : '加宽分屏视图'}
              onClick={() => onResize(width > 700 ? DEFAULT_INSPECTOR_WIDTH : 860)}
            >
              <IconColumns size={14} />
            </button>
            <button
              type="button"
              className="codex-icon-btn"
              style={{ width: 26, height: 26 }}
              aria-label="关闭右侧面板"
              ref={closePanelRef}
              title="关闭右侧面板"
              onClick={onClose}
            >
              <IconRightPanelToggle size={15} />
            </button>
          </div>
        </div>

        <div className="codex-split-panel" id={panelBodyId} role="tabpanel"
          aria-labelledby={activePaneTab ? tabDomId(activePaneTab.id) : undefined}>
        {/* Empty state if no active task */}
        {activePaneTab?.kind === 'autonomous' ? (
          open && <AutonomousRunPanel key={sessionId ?? 'no-session'} client={client} sessionId={sessionId} preferredRunId={preferredRunId} receipt={swarmReceipt} eventSeq={swarmEventSeq} approvals={swarmApprovals} sectionRequest={swarmSectionRequest} />
        ) : !bundle ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              color: 'var(--text-tertiary)',
              fontSize: 13,
              textAlign: 'center',
            }}
          >
            打开任意会话或提交任务后，可在此查看子智能体过程、文件变更、DAG 与实时事件。
          </div>
        ) : activePaneTab?.kind === 'subagents' ? (
          /* ================================================================
           * TAB A: 子智能体 (List View <-> Drill-down Detail View — Screenshots 3 & 4!)
           * ============================================================== */
          focusedSubagent ? (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <div className="codex-subagent-detail-head">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <button
                    type="button"
                    className="codex-icon-btn"
                    style={{ width: 26, height: 26 }}
                    aria-label="返回子智能体列表"
                    ref={backToWorkersRef}
                    onClick={() => onSelectSubagent(null)}
                  >
                    <IconArrowBack size={15} />
                  </button>
                  <AgentAvatar
                    role={getWorkerDisplayRole(focusedSubagent)}
                    size={16}
                  />
                  <span
                    style={{
                      fontSize: 13.5,
                      fontWeight: 500,
                      color: 'var(--text-default)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {getTaskLabel(focusedSubagent)}
                  </span>
                </div>
                <span className="subagent-detail-status"><WorkerStatusMark status={focusedSubagent.status} />{workerStatusLabels[focusedSubagent.status] ?? workerStatusLabels.unknown}
                </span>
              </div>

              <div className="codex-subagent-panel">
                {focusedAssignment?.objective && (
                  <details className="subagent-objective-card" open>
                    <summary>子任务目标</summary>
                    <p className="subagent-objective">{focusedAssignment.objective}</p>
                  </details>
                )}
                <div className="subagent-detail-meta">
                  {[getWorkerDisplayRole(focusedSubagent), focusedSubagent.model,
                    focusedSubagent.attempt > 1 && `第 ${focusedSubagent.attempt} 次尝试`].filter(Boolean).join(' · ')}
                </div>
                {(() => {
                  const wEvidence = bundle.evidence.filter((e) => e.workerId === focusedSubagent.id);
                  const wApprovals = bundle.approvals.filter((a) => a.workerId === focusedSubagent.id);
                  const wSessions = bundle.sessions.filter((s) => s.workerId === focusedSubagent.id);
                  const wEvents = bundle.events.filter((ev) => eventMatchesWorker(ev, focusedSubagent.id, bundle.workers));
                  const wArtifacts = bundle.artifacts.filter(
                    (a) => a.workerId === focusedSubagent.id && a.text?.trim(),
                  );
                  const wMessages = wSessions.flatMap((s) =>
                    (bundle.histories[s.id] ?? [])
                      .filter((h) => h.type === 'assistant/message' && h.text?.trim())
                      .map((h) => ({ id: `${s.id}-${h.cursor}`, text: h.text! })),
                  );
                  const finalBlocks = wArtifacts.length
                    ? wArtifacts.map((a) => ({ id: a.id, text: a.text! }))
                    : wMessages.slice(-1);
                  const wRunning = focusedSubagent.status === 'running';

                  const wArtifactFiles: Record<string, string> = {};
                  for (const a of bundle.artifacts) {
                    if (a.published) Object.assign(wArtifactFiles, a.files ?? {});
                  }

                  return (
                    <>
                      <ActivityBlock
                        assignments={bundle.assignments}
                        workers={[focusedSubagent]}
                        sessions={wSessions}
                        histories={bundle.histories}
                        evidence={wEvidence}
                        approvals={wApprovals}
                        taskFiles={bundle.task.files}
                        artifactFiles={wArtifactFiles}
                        events={wEvents}
                        durationMs={!wRunning && wEvents.length > 1
                          ? Math.max(0, wEvents.at(-1)!.timestamp - wEvents[0].timestamp) : undefined}
                        isLive={wRunning}
                        liveText={getWorkerActivityLabel(focusedSubagent) || "正在执行子任务…"}
                        finalProseTexts={finalBlocks.map((b) => b.text)}
                        defaultOpen
                        subagentMode
                        onInspectFile={openFileInPane}
                        onOpenImage={(imgs, idx) => setLightbox({ images: imgs, index: idx })}
                        onCopy={onToast}
                      />

                      {finalBlocks.map((blk) => (
                        <div key={blk.id} className="codex-assistant-turn" style={{ fontSize: 14.5 }}>
                          <Markdown
                            text={blk.text}
                            onOpenFile={openFileInPane}
                            onCopy={onToast}
                          />
                        </div>
                      ))}

                      {!wEvidence.length && !finalBlocks.length && (
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
                          暂无工具执行或输出记录。
                        </div>
                      )}

                      {finalBlocks.length > 0 && (
                        <div>
                          <button
                            type="button"
                            className="codex-icon-btn"
                            style={{ width: 26, height: 26 }}
                            title="复制子智能体输出"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(
                                  finalBlocks.map((b) => b.text).join('\n\n'),
                                );
                                onToast('已复制子智能体输出');
                              } catch {
                                // ignore
                              }
                            }}
                          >
                            <IconCopy size={14} />
                          </button>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          ) : (
            <div className="codex-subagent-panel subagent-list">
              {tasks.length ? (
                <section aria-label="子任务列表">
                  <div className="subagent-list-heading"><span>任务 · {tasks.length}</span><span>状态</span></div>
                  {(showAllSubagents ? tasks : tasks.slice(0, TASK_PREVIEW_LIMIT)).map(renderWorkerRow)}
                </section>
              ) : <p className="subagent-empty">暂无子任务记录</p>}
              {history.length > 0 && (
                <section className="subagent-history">
                  <button type="button" className="subagent-history-toggle" aria-expanded={historyOpen}
                    onClick={() => setHistoryOpen(open => !open)}>
                    {historyOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                    执行历史 · {history.length}
                  </button>
                  {historyOpen && (showAllSubagents ? history : history.slice(0, TASK_PREVIEW_LIMIT)).map(renderWorkerRow)}
                </section>
              )}
              {!showAllSubagents && (tasks.length > TASK_PREVIEW_LIMIT || (historyOpen && history.length > TASK_PREVIEW_LIMIT)) && (
                <button type="button" className="codex-sidebar-more-btn" onClick={() => setShowAllSubagents(true)}>显示全部记录</button>
              )}
            </div>
          )
        ) : activePaneTab?.kind === 'file' ? (
          /* ================================================================
           * TAB B: IDE File Code + Diff + Right Changed Files Tree (Screenshot 5!)
           * ============================================================== */
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {/* Breadcrumb & 显示更改 Toolbar */}
            <div className="codex-ide-toolbar">
              <div className="codex-ide-breadcrumb" title={activeFileDiff?.path}>
                <span>{projectName}</span>
                {activeFileDiff?.path
                  .replace(/\\/g, '/')
                  .split('/')
                  .filter(Boolean)
                  .map((seg, idx, arr) => (
                    <React.Fragment key={`${seg}-${idx}`}>
                      <IconChevronRight size={11} style={{ flex: 'none', opacity: 0.6 }} />
                      <span
                        style={{
                          color: idx === arr.length - 1 ? 'var(--text-default)' : 'var(--text-tertiary)',
                          fontWeight: idx === arr.length - 1 ? 500 : 400,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {seg}
                      </span>
                    </React.Fragment>
                  ))}
              </div>

              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
                {activeFileDiff && (
                  <>
                    {showChanges && (
                      <span className="codex-ide-branch-pill" title="当前对比基准">
                        <IconBranch size={12} />
                        <span>分支</span>
                        <span style={{ opacity: 0.45 }}>|</span>
                        <span style={{ color: 'var(--text-default)' }}>main</span>
                        {(activeFileDiff.added > 0 || activeFileDiff.deleted > 0) && (
                          <span className="codex-diff-counts tabular-nums" style={{ fontSize: 11, marginLeft: 2 }}>
                            <span className="codex-git-add">+{activeFileDiff.added}</span>
                            <span className="codex-git-del">-{activeFileDiff.deleted}</span>
                          </span>
                        )}
                      </span>
                    )}
                    <button
                      type="button"
                      className="codex-toolbar-btn"
                      data-variant={showChanges ? 'primary' : 'outline'}
                      style={{ height: 26, fontSize: 12 }}
                      onClick={() => setShowChanges((v) => !v)}
                    >
                      <IconDiffBox size={13} />
                      <span>{showChanges ? '查看源码' : '显示更改'}</span>
                    </button>
                    {showChanges && (
                      <button
                        type="button"
                        className="codex-toolbar-btn"
                        data-variant="outline"
                        style={{ height: 26, fontSize: 12 }}
                        onClick={() => setDiffMode((m) => (m === 'unified' ? 'split' : 'unified'))}
                      >
                        <IconColumns size={12} />
                        <span>{diffMode === 'unified' ? '双栏' : '单栏'}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="codex-icon-btn"
                      style={{ width: 26, height: 26 }}
                      title="复制文件内容"
                      onClick={() => void copyActiveFile()}
                    >
                      {copiedFile ? <IconCheck size={13} /> : <IconCopy size={13} />}
                    </button>
                    <button
                      type="button"
                      className="codex-icon-btn"
                      style={{ width: 26, height: 26 }}
                      title="下载文件"
                      onClick={() => downloadTextFile(activeFileDiff.path, activeFileDiff.afterText)}
                    >
                      <IconDownload size={13} />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Split Body: Left Code/Diff Viewer + Right Changed Files Tree */}
            <div className="codex-ide-body">
              <div className="codex-ide-editor">
                {!activeFileDiff ? (
                  <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>
                    当前任务暂无文件变更或产物。
                  </div>
                ) : isImagePath(activeFileDiff.path) ? (
                  (() => {
                    const raw =
                      bundle.artifacts.find((a) => a.files?.[activeFileDiff.path])?.files?.[
                        activeFileDiff.path
                      ] ?? bundle.task.files?.[activeFileDiff.path];
                    const imgSrc = toImageDataUrl(activeFileDiff.path, raw);
                    return (
                      <div
                        style={{
                          padding: 24,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          minHeight: 240,
                          gap: 10,
                          fontFamily: 'var(--font-sans)',
                        }}
                      >
                        {imgSrc ? (
                          <img
                            src={imgSrc}
                            alt={activeFileDiff.path}
                            style={{
                              maxWidth: '100%',
                              maxHeight: 520,
                              borderRadius: 10,
                              border: '1px solid var(--border-default)',
                              boxShadow: 'var(--shadow-sm)',
                            }}
                          />
                        ) : (
                          <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
                            无法预览此图像文件
                          </span>
                        )}
                        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                          {activeFileDiff.path}
                        </span>
                      </div>
                    );
                  })()
                ) : !showChanges ? (
                  /* Syntax-Highlighted Line-Numbered Code View (Screenshot 5 default!) */
                  <div>
                    {activeFileDiff.afterText.replace(/\r\n/g, '\n').split('\n').map((line, i) => {
                      const ln = i + 1;
                      return (
                        <div
                          key={ln}
                          className="codex-code-line"
                          data-change={addedLineNumbers.has(ln) ? 'add' : undefined}
                        >
                          <span className="codex-code-ln">{ln}</span>
                          <span className="codex-code-src">{highlightCodeLine(line)}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : diffMode === 'unified' ? (
                  <div className="codex-diff-table">
                    {activeFileDiff.lines.map((line, idx) => (
                      <div key={idx} className="codex-diff-line" data-kind={line.kind}>
                        <span className="codex-diff-ln">{line.oldLine ?? ''}</span>
                        <span className="codex-diff-ln">{line.newLine ?? ''}</span>
                        <span className="codex-diff-sign">
                          {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                        </span>
                        <span className="codex-diff-code">{line.text}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="codex-diff-split">
                    {splitRows.map((row, idx) => (
                      <React.Fragment key={idx}>
                        <div className="codex-diff-split-cell" data-kind={row.left.kind}>
                          <span className="codex-diff-ln">{row.left.ln ?? ''}</span>
                          <span className="codex-diff-sign">
                            {row.left.kind === 'del' ? '-' : ' '}
                          </span>
                          <span>{row.left.text}</span>
                        </div>
                        <div className="codex-diff-split-cell" data-kind={row.right.kind}>
                          <span className="codex-diff-ln">{row.right.ln ?? ''}</span>
                          <span className="codex-diff-sign">
                            {row.right.kind === 'add' ? '+' : ' '}
                          </span>
                          <span>{row.right.text}</span>
                        </div>
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>

              {/* Right Collapsible Changed Files Tree (Exact Screenshot 5!) */}
              {diffs.length > 0 && (
                <div className="codex-ide-tree">
                  <div className="codex-ide-tree-search">
                    <IconSearch size={12} style={{ flex: 'none' }} />
                    <input
                      value={treeFilter}
                      onChange={(e) => setTreeFilter(e.target.value)}
                      placeholder="筛选文件…"
                    />
                  </div>
                  <div
                    style={{
                      padding: '4px 10px',
                      fontSize: 11.5,
                      fontWeight: 500,
                      color: 'var(--text-tertiary)',
                      display: 'flex',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>已更改的文件</span>
                    <span className="tabular-nums">{filteredDiffs.length}</span>
                  </div>
                  <div className="codex-ide-tree-list">{renderTreeNodes(fileTree)}</div>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ================================================================
           * TAB C: Live SSE Events + Task Version Snapshots
           * ============================================================== */
          <div className="codex-drawer-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: 'var(--text-tertiary)',
                    marginBottom: 8,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <IconHistory size={14} />
                  <span>任务版本历史（当前 v{bundle.task.version}）</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {Array.from({ length: Math.min(bundle.task.version, 12) }, (_, i) => i + 1).map((v) => (
                    <button
                      key={v}
                      type="button"
                      className="codex-toolbar-btn tabular-nums"
                      data-variant={loadedVersion?.version === v ? 'primary' : 'outline'}
                      disabled={loadingVersion}
                      onClick={() => void handleLoadVersion(v)}
                    >
                      v{v}
                    </button>
                  ))}
                </div>
                {loadedVersion && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: 10,
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-default)',
                      background: 'var(--bg-surface-secondary)',
                      fontSize: 12,
                    }}
                  >
                    <div style={{ fontWeight: 500, marginBottom: 4 }}>
                      快照 v{loadedVersion.version} · 状态：{fmtStatusLabel(loadedVersion.status)}
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        color: 'var(--text-secondary)',
                        whiteSpace: 'pre-wrap',
                        maxHeight: 160,
                        overflow: 'auto',
                      }}
                    >
                      {JSON.stringify(
                        {
                          status: loadedVersion.status,
                          version: loadedVersion.version,
                          planNodes: loadedVersion.plan?.nodes.length ?? 0,
                          verdict: loadedVersion.verdict ?? null,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                )}
              </div>

              {/* Token Usage Breakdown */}
              {bundle.usage.length > 0 && (
                <div
                  style={{
                    padding: 10,
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-surface-secondary)',
                    fontSize: 12,
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <span style={{ color: 'var(--text-secondary)' }}>累计用量</span>
                  <span className="tabular-nums" style={{ fontWeight: 500 }}>
                    {fmtTokens(bundle.usage.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0))} tokens ·{' '}
                    {fmtUSD(bundle.usage.reduce((s, u) => s + u.estimatedUSD, 0))}
                  </span>
                </div>
              )}

              {/* ACI 2.5 Budget Watermarks & 8s Breaker */}
              {latestAciWatermarks && (
                <div
                  aria-label="ACI 2.5 预算水位"
                  style={{
                    padding: 10,
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-surface-secondary)',
                    fontSize: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>ACI 2.5 预算水位</span>
                    {latestAciWatermarks.usedTokens !== undefined && latestAciWatermarks.maxTokens !== undefined && (
                      <span className="tabular-nums" style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
                        {fmtTokens(latestAciWatermarks.usedTokens)} / {fmtTokens(latestAciWatermarks.maxTokens)} tokens
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    {latestAciWatermarks.dtocWatermark !== undefined && (
                      <span className="codex-status-chip tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
                        单步 DTOC 水位{' '}
                        {latestAciWatermarks.dtocWatermark <= 2
                          ? `${Math.round(latestAciWatermarks.dtocWatermark * 100)}%`
                          : `${fmtTokens(latestAciWatermarks.dtocWatermark)} tok`}
                      </span>
                    )}
                    {latestAciWatermarks.postTestReserveActive !== undefined && (
                      <span
                        className="codex-status-chip"
                        data-tone={latestAciWatermarks.postTestReserveActive ? 'warning' : undefined}
                      >
                        {latestAciWatermarks.postTestReserveActive ? '完工保留金已激活' : '完工保留就绪'}
                      </span>
                    )}
                    {latestAciWatermarks.supervisorCircuitOpen !== undefined && (
                      <span
                        className="codex-status-chip"
                        data-tone={latestAciWatermarks.supervisorCircuitOpen ? 'warning' : 'success'}
                      >
                        {latestAciWatermarks.supervisorCircuitOpen ? 'Supervisor 8s 熔断已开启' : 'Supervisor 8s 熔断正常'}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Live SSE Events Log */}
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: 'var(--text-tertiary)',
                    marginBottom: 8,
                  }}
                >
                  实时 SSE 事件流 ({bundle.events.length})
                </div>
                {bundle.events.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                    当前任务暂无事件记录。
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {[...bundle.events].reverse().map((ev) => (
                      <div
                        key={ev.seq}
                        style={{
                          padding: '7px 10px',
                          borderRadius: 'var(--radius-md)',
                          border: '1px solid var(--border-subtle)',
                          background: 'var(--bg-surface)',
                          fontSize: 12,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
                            #{ev.seq} {ev.type}
                          </span>
                          <span className="tabular-nums" style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
                            {fmtClock(ev.timestamp)}
                          </span>
                        </div>
                        {Object.keys(ev.payload ?? {}).length > 0 && (
                          <div
                            style={{
                              marginTop: 4,
                              fontFamily: 'var(--font-mono)',
                              fontSize: 11,
                              color: 'var(--text-secondary)',
                              wordBreak: 'break-all',
                            }}
                          >
                            {JSON.stringify(ev.payload)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Artifacts summary */}
              {bundle.artifacts.some((a) => Object.keys(a.files ?? {}).length > 0) && (
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: 'var(--text-tertiary)',
                      marginBottom: 6,
                    }}
                  >
                    已发布产物文件
                  </div>
                  {bundle.artifacts.map((art) =>
                    Object.entries(art.files ?? {}).map(([path, b64]) => (
                      <button
                        key={`${art.id}-${path}`}
                        type="button"
                        className="codex-agent-source-row"
                        onClick={() => openFileInPane(path)}
                      >
                        <IconFileDoc size={13} />
                        <span className="codex-agent-source-name">{path}</span>
                        <span className="tabular-nums" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                          {decodeBase64Utf8(b64).length} B
                        </span>
                      </button>
                    )),
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        </div>
      </div>

      <ImageLightbox
        images={lightbox?.images ?? []}
        index={lightbox?.index ?? null}
        onChangeIndex={(next) =>
          setLightbox((cur) => (next === null || !cur ? null : { ...cur, index: next }))
        }
      />
    </aside>
  );
};
