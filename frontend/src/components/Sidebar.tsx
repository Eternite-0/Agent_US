import React, { useEffect, useRef, useState } from 'react';
import type { Approval, AppView, CodexMode, Project, Task, Worker } from '../types/backend';
import { fmtActionCommand, taskTitle } from '../utils/format';
import { Collapsible } from './Collapsible';
import {
  CodexWordmark,
  IconArchive,
  IconBell,
  IconCheck,
  IconChevronRight,
  IconDotsHorizontal,
  IconCompose,
  IconHelpCircle,
  IconPin,
  IconPlus,
  IconRailClock,
  IconRailHome,
  IconRailPlugins,
  IconSearch,
  IconSettingsGear,
  IconSidebarFolder,
} from './Icons';

interface SidebarProps {
  view: AppView;
  collapsed: boolean;
  hidePanel?: boolean;
  width: number;
  codexMode: CodexMode;
  projects: Project[];
  tasks: Task[];
  pinnedIds: string[];
  archiveBusy: ReadonlySet<string>;
  selectedProjectId: string | null;
  activeWorkers: Worker[];
  pendingApprovals: Approval[];
  onResize: (width: number) => void;
  onChangeCodexMode: (mode: CodexMode) => void;
  onSelectHome: (projectId?: string) => void;
  onSelectTask: (taskId: string, focusWorkerId?: string) => void;
  onSelectArchived: () => void;
  onSelectTasksView: () => void;
  onSelectCapabilities: () => void;
  onOpenSettings: (section?: string) => void;
  onOpenSearch: () => void;
  onOpenCreateProject: () => void;
  onRenameProject: (project: Project, newName: string) => Promise<void>;
  onDeleteProject?: (project: Project) => void;
  onTogglePin: (taskId: string) => void;
  onArchiveTask: (taskId: string) => void;
  onDecideApproval: (approval: Approval, decision: 'approve' | 'deny') => Promise<void>;
  onToast: (msg: string) => void;
}

type ContextMenuState =
  | { kind: 'task'; x: number; y: number; task: Task }
  | { kind: 'project'; x: number; y: number; project: Project }
  | null;

export const Sidebar: React.FC<SidebarProps> = ({
  view,
  collapsed,
  hidePanel = false,
  width,
  codexMode,
  projects,
  tasks,
  pinnedIds,
  archiveBusy,
  selectedProjectId,
  pendingApprovals,
  onResize,
  onChangeCodexMode,
  onSelectHome,
  onSelectTask,
  onSelectArchived,
  onSelectTasksView,
  onSelectCapabilities,
  onOpenSettings,
  onOpenSearch,
  onOpenCreateProject,
  onRenameProject,
  onDeleteProject,
  onTogglePin,
  onArchiveTask,
  onDecideApproval,
  onToast,
}) => {
  const [resizing, setResizing] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [recentsExpanded, setRecentsExpanded] = useState<boolean | null>(null);
  const recentsOpen = recentsExpanded ?? projects.length === 0;
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [bellOpen, setBellOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [expandedProjectLists, setExpandedProjectLists] = useState<Record<string, boolean>>({});
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);

  const popoverRef = useRef<HTMLDivElement>(null);
  const peekLeaveTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!collapsed) setPeeking(false);
  }, [collapsed]);

  useEffect(() => {
    if (!bellOpen && !modeOpen && !contextMenu) return;
    const close = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setBellOpen(false);
        setModeOpen(false);
        setContextMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setBellOpen(false);
        setModeOpen(false);
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [bellOpen, modeOpen, contextMenu]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    setResizing(true);

    const onMove = (ev: MouseEvent) => {
      const next = Math.max(220, Math.min(420, startWidth + (ev.clientX - startX)));
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

  const enterPeek = () => {
    if (!collapsed || hidePanel) return;
    if (peekLeaveTimer.current) {
      window.clearTimeout(peekLeaveTimer.current);
      peekLeaveTimer.current = null;
    }
    setPeeking(true);
  };

  const leavePeek = () => {
    if (!peeking) return;
    peekLeaveTimer.current = window.setTimeout(() => setPeeking(false), 180);
  };

  const activeTaskId = view.kind === 'thread' ? view.taskId : null;
  const isHomeRail = view.kind === 'home' || view.kind === 'thread';
  const showRail = hidePanel || collapsed;
  const pinnedSet = new Set(pinnedIds);

  const visibleTasks = tasks.filter((t) => t.archivedAt == null);
  const pinnedTasks = visibleTasks.filter((t) => pinnedSet.has(t.id));

  const tasksByProject = new Map<string, Task[]>();
  for (const t of visibleTasks) {
    if (!t.projectId) continue;
    const list = tasksByProject.get(t.projectId) ?? [];
    list.push(t);
    tasksByProject.set(t.projectId, list);
  }

  const handleRenameSubmit = async (p: Project, e: React.FormEvent) => {
    e.preventDefault();
    if (editingName.trim() && editingName.trim() !== p.name) {
      await onRenameProject(p, editingName.trim());
    }
    setEditingProjectId(null);
  };

  const taskRunningState = (t: Task): 'running' | 'approval' | null => {
    if (pendingApprovals.some((a) => a.taskId === t.id)) return 'approval';
    if (t.status === 'planning' || t.status === 'running' || t.status === 'reviewing') return 'running';
    return null;
  };

  const openTaskContext = (e: React.MouseEvent, task: Task) => {
    e.preventDefault();
    setContextMenu({
      kind: 'task',
      x: Math.min(e.clientX, window.innerWidth - 210),
      y: Math.min(e.clientY, window.innerHeight - 210),
      task,
    });
  };

  const openProjectContext = (e: React.MouseEvent, project: Project) => {
    e.preventDefault();
    setContextMenu({
      kind: 'project',
      x: Math.min(e.clientX, window.innerWidth - 210),
      y: Math.min(e.clientY, window.innerHeight - 180),
      project,
    });
  };

  const renderThreadRow = (t: Task, keyPrefix: string, indented = false) => {
    const liveState = taskRunningState(t);
    const isPinned = pinnedSet.has(t.id);
    return (
      <div
        key={`${keyPrefix}-${t.id}`}
        role="button"
        tabIndex={0}
        className={`codex-sidebar-row ${indented ? 'codex-sidebar-row-indented' : ''}`}
        data-selected={activeTaskId === t.id ? 'true' : undefined}
        onClick={() => {
          setPeeking(false);
          onSelectTask(t.id);
        }}
        onContextMenu={(e) => openTaskContext(e, t)}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setPeeking(false);
            onSelectTask(t.id);
          }
        }}
      >
        <span className="codex-sidebar-row-text">{taskTitle(t.input)}</span>
        {liveState === 'running' && (
          <span className="codex-sidebar-spinner" aria-label="运行中" title="运行中" />
        )}
        {liveState === 'approval' && (
          <span className="codex-status-dot" data-tone="warn" title="待审批" />
        )}
        <div
          className="codex-sidebar-row-actions"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="codex-sidebar-mini-btn"
            title={isPinned ? '取消固定' : '固定到顶部'}
            aria-label={isPinned ? '取消固定' : '固定'}
            style={isPinned ? { color: 'var(--text-default)' } : undefined}
            onClick={() => onTogglePin(t.id)}
          >
            <IconPin size={13} />
          </button>
          <button
            type="button"
            className="codex-sidebar-mini-btn"
            title="归档聊天"
            aria-label="归档聊天"
            disabled={archiveBusy.has(t.id)}
            onClick={() => onArchiveTask(t.id)}
          >
            <IconArchive size={13} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flex: 'none', minHeight: 0 }} ref={popoverRef}>
      {/* Far-left Codex navigation rail */}
      {showRail && <nav className="codex-rail" aria-label="主导航">
        <div className="codex-rail-group">
          <button
            type="button"
            className="codex-rail-btn"
            data-active={isHomeRail ? 'true' : undefined}
            aria-label="主页"
            title="主页与会话"
            onClick={() => onSelectHome()}
          >
            <IconRailHome size={20} active={isHomeRail} />
          </button>
          <button type="button" className="codex-rail-btn" aria-label="已归档" title="已归档"
            data-active={view.kind === 'archived' || undefined} aria-current={view.kind === 'archived' ? 'page' : undefined}
            onClick={onSelectArchived}>
            <IconArchive size={18} />
          </button>
          <button
            type="button"
            className="codex-rail-btn"
            data-active={view.kind === 'tasks' ? 'true' : undefined}
            aria-label="定时任务"
            title="定时任务"
            onClick={onSelectTasksView}
          >
            <IconRailClock size={20} />
          </button>
          <button
            type="button"
            className="codex-rail-btn"
            data-active={view.kind === 'capabilities' ? 'true' : undefined}
            aria-label="插件"
            title="插件与技能"
            onClick={onSelectCapabilities}
          >
            <IconRailPlugins size={20} />
          </button>
        </div>
        <div className="codex-rail-group">
          <button
            type="button"
            className="codex-rail-btn"
            data-active={view.kind === 'settings' ? 'true' : undefined}
            aria-label="设置"
            title="设置 (Ctrl+,)"
            onClick={() => onOpenSettings('general')}
          >
            <IconSettingsGear size={20} />
          </button>
        </div>
      </nav>}
      {/* Left-edge Hover Peek Trigger when sidebar is collapsed */}
      {collapsed && !hidePanel && !peeking && (
        <div
          className="codex-peek-hotzone"
          onMouseEnter={enterPeek}
        />
      )}

      {/* Resizable conversation and project sidebar */}
      {!hidePanel && (
        <aside
          className="codex-sidebar-wrap"
          style={{ width }}
          data-collapsed={collapsed && !peeking ? 'true' : undefined}
          data-peeking={collapsed && peeking ? 'true' : undefined}
          data-resizing={resizing ? 'true' : undefined}
          aria-label="对话历史"
          onMouseEnter={enterPeek}
          onMouseLeave={leavePeek}
        >
          <div className="codex-sidebar">
            {/* Header: Codex wordmark + Search + Bell */}
            <div className="codex-sidebar-head">
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="codex-brand-trigger"
                  aria-label="切换模式"
                  onClick={() => setModeOpen((v) => !v)}
                >
                  {codexMode === 'Codex' ? (
                    <CodexWordmark className="codex-sidebar-wordmark" />
                  ) : (
                    <span style={{ fontSize: 15, fontWeight: 600 }}>{codexMode}</span>
                  )}
                  <svg className="codex-brand-disclosure" width="16" height="16" viewBox="0 0 16 16"
                    fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
                    strokeLinejoin="round" aria-hidden="true">
                    <path d="m4 6.25 4 4 4-4" />
                  </svg>
                </button>

                {modeOpen && (
                  <div className="codex-popover" data-side="bottom" style={{ left: 0, minWidth: 210 }}>
                    {(
                      [
                        ['Codex', '代码构建与沙箱任务'],
                        ['Work', '多节点协同自动化'],
                        ['Chat', '快速问答与分析'],
                      ] as const
                    ).map(([m, desc]) => (
                      <button
                        key={m}
                        type="button"
                        className="codex-popover-item"
                        data-selected={codexMode === m ? 'true' : undefined}
                        onClick={() => {
                          onChangeCodexMode(m);
                          setModeOpen(false);
                        }}
                      >
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                          <span style={{ fontWeight: 500 }}>{m}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{desc}</span>
                        </span>
                        {codexMode === m && <IconCheck size={14} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="codex-sidebar-head-actions">
                <button
                  type="button"
                  className="codex-icon-btn"
                  aria-label="搜索"
                  title="搜索 (Ctrl+K)"
                  onClick={onOpenSearch}
                >
                  <IconSearch size={16} />
                </button>
                <div className="codex-bell-wrap" style={{ position: 'relative' }}>
                  <button
                    type="button"
                    className="codex-icon-btn"
                    aria-label="查看待审批活动"
                    title="待审批与活动通知"
                    data-open={bellOpen ? 'true' : undefined}
                    onClick={() => setBellOpen((v) => !v)}
                  >
                    <IconBell size={16} />
                  </button>
                  {pendingApprovals.length > 0 && (
                    <span className="codex-bell-count">{pendingApprovals.length}</span>
                  )}

                  {bellOpen && (
                    <div
                      className="codex-popover"
                      data-side="bottom"
                      style={{ left: -120, width: 320, padding: 8 }}
                    >
                      <div
                        style={{
                          padding: '4px 6px 8px',
                          fontSize: 12.5,
                          fontWeight: 500,
                          color: 'var(--text-secondary)',
                          display: 'flex',
                          justifyContent: 'space-between',
                        }}
                      >
                        <span>待处理审批</span>
                        <span className="tabular-nums">{pendingApprovals.length}</span>
                      </div>
                      {pendingApprovals.length === 0 ? (
                        <div
                          style={{
                            padding: '18px 8px',
                            textAlign: 'center',
                            fontSize: 12.5,
                            color: 'var(--text-tertiary)',
                          }}
                        >
                          当前没有待审批的工具调用
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {pendingApprovals.map((a) => (
                            <div
                              key={a.id}
                              style={{
                                padding: 8,
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--border-subtle)',
                                background: 'var(--bg-surface-secondary)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 6,
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  fontSize: 12.5,
                                  fontWeight: 500,
                                  cursor: 'pointer',
                                }}
                                onClick={() => {
                                  setBellOpen(false);
                                  if (a.taskId) onSelectTask(a.taskId);
                                }}
                              >
                                <span>{a.tool} · 待授权</span>
                                <span style={{ fontSize: 11, color: 'var(--color-link)' }}>查看 →</span>
                              </div>
                              <div
                                style={{
                                  fontSize: 11.5,
                                  color: 'var(--text-secondary)',
                                  fontFamily: 'var(--font-mono)',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                $ {fmtActionCommand(a.tool, a.action)}
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                                <button
                                  type="button"
                                  className="codex-toolbar-btn"
                                  data-variant="outline"
                                  style={{ height: 24, fontSize: 12 }}
                                  onClick={() => void onDecideApproval(a, 'deny')}
                                >
                                  拒绝
                                </button>
                                <button
                                  type="button"
                                  className="codex-toolbar-btn"
                                  data-variant="primary"
                                  style={{ height: 24, fontSize: 12 }}
                                  onClick={() => void onDecideApproval(a, 'approve')}
                                >
                                  批准
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <nav className="codex-sidebar-nav" aria-label={showRail ? '会话操作' : '主导航'}>
              <button type="button" className="codex-sidebar-row" onClick={() => { setPeeking(false); onSelectHome(); }}>
                <IconCompose size={16} />
                <span className="codex-sidebar-row-text">新聊天</span>
              </button>
              <button type="button" className="codex-sidebar-row"
                aria-current={view.kind === 'archived' ? 'page' : undefined}
                data-selected={view.kind === 'archived' || undefined}
                onClick={() => { setPeeking(false); onSelectArchived(); }}>
                <IconArchive size={16} />
                <span className="codex-sidebar-row-text">已归档</span>
              </button>
              <button type="button" className="codex-sidebar-row" aria-label="定时任务"
                aria-current={view.kind === 'tasks' ? 'page' : undefined}
                data-selected={view.kind === 'tasks' || undefined}
                onClick={() => { setPeeking(false); onSelectTasksView(); }}>
                <IconRailClock size={16} />
                <span className="codex-sidebar-row-text">已安排</span>
              </button>
              <button type="button" className="codex-sidebar-row"
                aria-current={view.kind === 'capabilities' ? 'page' : undefined}
                data-selected={view.kind === 'capabilities' || undefined}
                onClick={() => { setPeeking(false); onSelectCapabilities(); }}>
                <IconRailPlugins size={16} />
                <span className="codex-sidebar-row-text">插件</span>
              </button>
            </nav>

            {/* Scrollable Sections */}
            <div className="codex-sidebar-scroll vertical-scroll-fade-mask">
              {/* Pinned Threads (置顶 — exact User Screenshot 3) */}
              {pinnedTasks.length > 0 && (
                <>
                  <div className="codex-section-header">
                    <span className="codex-section-toggle" style={{ cursor: 'default' }}>
                      置顶
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {pinnedTasks.map((t) => renderThreadRow(t, 'pin'))}
                  </div>
                </>
              )}

              {/* Projects Section */}
              <div className="codex-section-header">
                <button
                  type="button"
                  className="codex-section-toggle"
                  aria-expanded={projectsOpen}
                  onClick={() => setProjectsOpen((v) => !v)}
                >
                  <span>项目</span>
                  <span className="codex-section-chevron">
                    <IconChevronRight size={13} />
                  </span>
                </button>
                <button
                  type="button"
                  className="codex-sidebar-mini-btn"
                  title="新建项目"
                  aria-label="新建项目"
                  onClick={() => {
                    setProjectsOpen(true);
                    onOpenCreateProject();
                  }}
                >
                  <IconPlus size={14} />
                </button>
              </div>

              <Collapsible open={projectsOpen}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {projects.length === 0 && (
                    <button
                      type="button"
                      className="codex-sidebar-row"
                      style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}
                      onClick={onOpenCreateProject}
                    >
                      <IconPlus size={14} />
                      <span>创建第一个项目…</span>
                    </button>
                  )}

                  {projects.map((p) => {
                    const pTasks = tasksByProject.get(p.id) ?? [];
                    const isExpanded = !collapsedProjects[p.id];
                    const isActiveProject = view.kind === 'home' && selectedProjectId === p.id;

                    return (
                      <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        {editingProjectId === p.id ? (
                          <form
                            onSubmit={(e) => handleRenameSubmit(p, e)}
                            style={{ padding: '2px 6px' }}
                          >
                            <input
                              autoFocus
                              className="codex-input"
                              style={{ width: '100%', height: 28, fontSize: 13 }}
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              onBlur={() => setEditingProjectId(null)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') setEditingProjectId(null);
                              }}
                            />
                          </form>
                        ) : (
                          <div
                            className="codex-sidebar-row"
                            data-selected={isActiveProject ? 'true' : undefined}
                            role="button"
                            tabIndex={0}
                            onClick={() =>
                              setCollapsedProjects((prev) => ({ ...prev, [p.id]: !prev[p.id] }))
                            }
                            onContextMenu={(e) => openProjectContext(e, p)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                setCollapsedProjects((prev) => ({ ...prev, [p.id]: !prev[p.id] }));
                              }
                            }}
                          >
                            <IconSidebarFolder className="codex-sidebar-project-icon" />
                            <span className="codex-sidebar-row-text">{p.name}</span>
                            <div
                              className="codex-sidebar-row-actions"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                className="codex-sidebar-mini-btn"
                                title="项目操作"
                                onClick={(e) => openProjectContext(e, p)}
                              >
                                <IconDotsHorizontal size={14} />
                              </button>
                              <button
                                type="button"
                                className="codex-sidebar-mini-btn"
                                title={`在 ${p.name} 中新聊天`}
                                onClick={() => {
                                  setPeeking(false);
                                  onSelectHome(p.id);
                                }}
                              >
                                <IconCompose size={14} />
                              </button>
                            </div>
                          </div>
                        )}

                        <Collapsible open={isExpanded}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                            {pTasks.length === 0 ? (
                              <div className="codex-sidebar-empty-hint">暂无聊天</div>
                            ) : (
                              <>
                                {(expandedProjectLists[p.id] ? pTasks : pTasks.slice(0, 4)).map((t) =>
                                  renderThreadRow(t, `proj-${p.id}`, true),
                                )}
                                {pTasks.length > 4 && (
                                  <button
                                    type="button"
                                    className="codex-sidebar-more-btn"
                                    onClick={() =>
                                      setExpandedProjectLists((prev) => ({
                                        ...prev,
                                        [p.id]: !prev[p.id],
                                      }))
                                    }
                                  >
                                    {expandedProjectLists[p.id] ? '收起' : '展开显示'}
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </Collapsible>
                      </div>
                    );
                  })}
                </div>
              </Collapsible>

              {/* Recent Section */}
              <div className="codex-section-header">
                <button
                  type="button"
                  className="codex-section-toggle"
                  aria-expanded={recentsOpen}
                  onClick={() => setRecentsExpanded(!recentsOpen)}
                >
                  <span>最近</span>
                  <span className="codex-section-chevron">
                    <IconChevronRight size={13} />
                  </span>
                </button>
              </div>

              <Collapsible open={recentsOpen}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {visibleTasks.length === 0 ? (
                    <div
                      style={{
                        padding: '8px 10px',
                        fontSize: 12.5,
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      暂无会话，输入任意任务立即开始
                    </div>
                  ) : (
                    visibleTasks.slice(0, 24).map((t) => renderThreadRow(t, 'recent', false))
                  )}
                </div>
              </Collapsible>
            </div>
            <div className="codex-sidebar-footer">
              <button type="button" className="codex-sidebar-row" onClick={() => onOpenSettings('general')}>
                <IconSettingsGear size={16} />
                <span>设置</span>
              </button>
              <button type="button" className="codex-icon-btn" aria-label="快捷键与帮助" title="快捷键与帮助"
                onClick={() => onOpenSettings('shortcuts')}>
                <IconHelpCircle />
              </button>
            </div>
          </div>

          {!peeking && (
            <div
              className="codex-sidebar-resizer"
              role="separator"
              aria-orientation="vertical"
              onMouseDown={startResize}
            />
          )}
        </aside>
      )}

      {/* Right-Click Floating Context Menu */}
      {contextMenu && (
        <div
          className="codex-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          {contextMenu.kind === 'task' ? (
            <>
              <button
                type="button"
                className="codex-popover-item"
                onClick={() => {
                  onSelectTask(contextMenu.task.id);
                  setContextMenu(null);
                }}
              >
                <span>打开对话</span>
              </button>
              <button
                type="button"
                className="codex-popover-item"
                onClick={() => {
                  onTogglePin(contextMenu.task.id);
                  setContextMenu(null);
                }}
              >
                <span>{pinnedSet.has(contextMenu.task.id) ? '取消固定' : '固定到顶部'}</span>
              </button>
              <button
                type="button"
                className="codex-popover-item"
                onClick={() => {
                  void navigator.clipboard.writeText(contextMenu.task.id).catch(() => {});
                  onToast('已复制任务 ID');
                  setContextMenu(null);
                }}
              >
                <span>复制任务 ID</span>
              </button>
              <div className="codex-popover-divider" />
              <button
                type="button"
                className="codex-popover-item"
                disabled={archiveBusy.has(contextMenu.task.id)}
                onClick={() => {
                  onArchiveTask(contextMenu.task.id);
                  setContextMenu(null);
                }}
              >
                <span>归档聊天</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="codex-popover-item"
                onClick={() => {
                  onSelectHome(contextMenu.project.id);
                  setContextMenu(null);
                }}
              >
                <span>在此项目新建聊天</span>
              </button>
              <button
                type="button"
                className="codex-popover-item"
                onClick={() => {
                  setEditingProjectId(contextMenu.project.id);
                  setEditingName(contextMenu.project.name);
                  setContextMenu(null);
                }}
              >
                <span>重命名项目</span>
              </button>
              <button
                type="button"
                className="codex-popover-item"
                onClick={() => {
                  void navigator.clipboard.writeText(contextMenu.project.id).catch(() => {});
                  onToast('已复制项目 ID');
                  setContextMenu(null);
                }}
              >
                <span>复制项目 ID</span>
              </button>
              {onDeleteProject && (
                <>
                  <div className="codex-popover-divider" />
                  <button
                    type="button"
                    className="codex-popover-item"
                    data-tone="danger"
                    onClick={() => {
                      onDeleteProject(contextMenu.project);
                      setContextMenu(null);
                    }}
                  >
                    <span>移除项目</span>
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
