import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  GitStatus,
  CodexMode,
  EffortLevel,
  ModelSpec,
  PermissionMode,
  Project,
} from '../types/backend';
import { encodeUtf8Base64 } from '../utils/diff';
import { isImagePath, toImageDataUrl } from './ImageLightbox';
import {
  IconArrowBack,
  IconArrowUp,
  IconBranch,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCircleClose,
  IconClose,
  IconFileDoc,
  IconFolder,
  IconHand,
  IconLaptop,
  IconPlus,
  IconReset,
  IconSearch,
  IconShieldAlert,
  IconShieldTerminal,
  IconStopSquare,
} from './Icons';

interface ComposerProps {
  variant: 'home' | 'thread';
  codexMode: CodexMode;
  projects: Project[];
  selectedProject: Project | null;
  models: ModelSpec[];
  selectedModel: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  gitStatus?: GitStatus | null;
  mentionFiles?: string[];
  mentionPlugins?: string[];
  mentionSkills?: string[];
  draftInjection?: { id: number; text: string; mode: 'replace' | 'append' } | null;
  isRunning?: boolean;
  submitting?: boolean;
  onSelectProject: (projectId: string | null) => void;
  onOpenCreateProject?: () => void;
  onSelectModel: (model: string) => void;
  onChangeEffort: (effort: EffortLevel) => void;
  onChangePermission: (mode: PermissionMode) => void;
  onRefreshGitStatus?: () => Promise<void>;
  onCheckoutGitBranch?: (branch: string, create?: boolean) => Promise<void>;
  onInitGitRepo?: () => Promise<void>;
  onSlashCommand?: (cmd: string) => void;
  onSubmit: (text: string, files: Record<string, string>) => Promise<void> | void;
  onStop?: () => void;
}

const EFFORT_STOPS: Array<{ id: EffortLevel; label: string }> = [
  { id: 'low', label: '轻度' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '极高' },
  { id: 'max', label: 'Max' },
];

const SLASH_COMMANDS = [
  { cmd: '/new', desc: '返回主页开始新对话' },
  { cmd: '/plan', desc: '切换为先规划后执行' },
  { cmd: '/run', desc: '切换为直接执行' },
  { cmd: '/diff', desc: '打开右侧文件变更 Diff 检查器' },
  { cmd: '/agents', desc: '打开右侧子智能体与执行过程面板' },
  { cmd: '/events', desc: '打开实时 SSE 事件流与版本日志' },
  { cmd: '/theme', desc: '立即切换浅色 / 深色主题' },
  { cmd: '/settings', desc: '打开设置与后端连接配置' },
  { cmd: '/compact', desc: '立即语义压缩当前会话上下文，释放窗口预算' },
  { cmd: '/rewind', desc: '精准回退上一轮工作区文件变更与对话状态' },
  { cmd: '/clear', desc: '清空当前输入与附件' },
];

type PopoverKind = null | 'project' | 'env' | 'branch' | 'permission' | 'effort' | 'models';

export const Composer: React.FC<ComposerProps> = ({
  variant,
  codexMode,
  projects,
  selectedProject,
  models,
  selectedModel,
  effort,
  permissionMode,
  gitStatus = null,
  mentionFiles = [],
  mentionPlugins = [],
  mentionSkills = [],
  draftInjection = null,
  isRunning = false,
  submitting = false,
  onSelectProject,
  onOpenCreateProject,
  onSelectModel,
  onChangeEffort,
  onChangePermission,
  onRefreshGitStatus,
  onCheckoutGitBranch,
  onInitGitRepo,
  onSlashCommand,
  onSubmit,
  onStop,
}) => {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Record<string, string>>({});
  const [popover, setPopover] = useState<PopoverKind>(null);
  const [dragging, setDragging] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchError, setBranchError] = useState('');
  const [initGitBusy, setInitGitBusy] = useState(false);
  const [menuHighlight, setMenuHighlight] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!popover) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setPopover(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopover(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [popover]);

  useEffect(() => {
    if (!draftInjection) return;
    setText((prev) =>
      draftInjection.mode === 'replace'
        ? draftInjection.text
        : prev.trim()
          ? `${prev.trimEnd()}

${draftInjection.text}`
          : draftInjection.text,
    );
    window.setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 10);
  }, [draftInjection]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.25)}px`;
  }, [text]);

  // Detect "/" slash menu or "@" file/project mention
  const slashMatches = useMemo(() => {
    if (!text.startsWith('/') || text.includes(' ') || text.includes('\n')) return [];
    const q = text.toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q));
  }, [text]);

  const mentionMatch = useMemo(() => {
    const m = text.match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) return null;
    const q = m[1].toLowerCase();
    const candidates = [
      ...mentionPlugins.map((p) => ({ label: p, kind: '已安装插件' })),
      ...mentionSkills.map((s) => ({ label: s, kind: '已启用技能' })),
      ...Object.keys(files).map((f) => ({ label: f, kind: '已附加文件' })),
      ...mentionFiles.map((f) => ({ label: f, kind: '工作区文件' })),
      ...projects.map((p) => ({ label: p.name, kind: '项目' })),
    ];
    const unique = candidates.filter(
      (item, idx, arr) => arr.findIndex((x) => x.label === item.label) === idx,
    );
    const matched = unique.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 10);
    return matched.length ? { raw: m[0], query: m[1], items: matched } : null;
  }, [text, files, mentionFiles, mentionPlugins, mentionSkills, projects]);

  useEffect(() => {
    setMenuHighlight(0);
  }, [slashMatches.length, mentionMatch?.query]);

  const attachFileList = async (list: FileList | File[]) => {
    const arr = Array.from(list).slice(0, 12);
    if (!arr.length) return;
    const next = { ...files };
    for (const f of arr) {
      try {
        const isImg = f.type.startsWith('image/') || isImagePath(f.name);
        const fallbackExt = f.type.startsWith('image/') ? `.${f.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'}` : '';
        const rawName = f.name || `image_${Date.now()}${fallbackExt}`;
        const safeName = rawName.replace(/[^a-zA-Z0-9_.-]/g, '_');
        if (isImg) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ''));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(f);
          });
          const comma = dataUrl.indexOf(',');
          if (comma >= 0) {
            next[safeName] = dataUrl.slice(comma + 1);
          }
        } else {
          const content = await f.text();
          next[safeName] = encodeUtf8Base64(content.slice(0, 60000));
        }
      } catch {
        // skip unreadable file
      }
    }
    setFiles(next);
  };

  const executeSlash = (cmd: string) => {
    setText('');
    if (cmd === '/clear') {
      setFiles({});
      return;
    }
    onSlashCommand?.(cmd);
  };

  const insertMention = (label: string) => {
    setText((prev) => prev.replace(/@[^\s@]*$/, `@${label} `));
    textareaRef.current?.focus();
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    if (slashMatches.length === 1 && trimmed === slashMatches[0].cmd) {
      executeSlash(slashMatches[0].cmd);
      return;
    }
    const attached = { ...files };
    setText('');
    setFiles({});
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    await onSubmit(trimmed, attached);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuHighlight((h) => (h + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuHighlight((h) => (h - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) {
        e.preventDefault();
        executeSlash(slashMatches[menuHighlight]?.cmd || slashMatches[0].cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText('');
        return;
      }
    }

    if (mentionMatch && mentionMatch.items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuHighlight((h) => (h + 1) % mentionMatch.items.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuHighlight((h) => (h - 1 + mentionMatch.items.length) % mentionMatch.items.length);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) {
        e.preventDefault();
        insertMention(mentionMatch.items[menuHighlight]?.label || mentionMatch.items[0].label);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSend();
    }
  };

  const effortIdx = Math.max(
    0,
    EFFORT_STOPS.findIndex((s) => s.id === effort),
  );
  const effortMeta = EFFORT_STOPS[effortIdx];
  const thumbPercent = 7 + (effortIdx / (EFFORT_STOPS.length - 1)) * 86;

  const setEffortByIndex = (idx: number) => {
    const clamped = Math.max(0, Math.min(EFFORT_STOPS.length - 1, idx));
    const chosen = EFFORT_STOPS[clamped];
    if (chosen) {
      onChangeEffort(chosen.id);
    }
  };

  const updateEffortFromPointer = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setEffortByIndex(Math.round(ratio * (EFFORT_STOPS.length - 1)));
  };

  const displayModel = selectedModel || models[0]?.model || 'Auto Router';
  const attachedKeys = Object.keys(files);
  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(projectSearch.trim().toLowerCase()),
  );

  const hasGitRepo = Boolean(gitStatus?.available);
  const branchText = hasGitRepo ? (gitStatus?.branch?.trim() || 'HEAD') : '无 Git 分支';
  const isDirty = Boolean(hasGitRepo && gitStatus?.dirty);
  const uncommittedCount =
    typeof gitStatus?.uncommittedCount === 'number' ? gitStatus.uncommittedCount : undefined;
  const availableBranches = useMemo(() => {
    const raw = Array.isArray(gitStatus?.branches) ? gitStatus.branches : [];
    const unique = Array.from(new Set(raw.filter(Boolean)));
    if (hasGitRepo && branchText && !unique.includes(branchText)) {
      unique.unshift(branchText);
    }
    return unique;
  }, [gitStatus?.branches, hasGitRepo, branchText]);

  const filteredBranches = useMemo(() => {
    const q = branchSearch.trim().toLowerCase();
    if (!q) return availableBranches;
    return availableBranches.filter((b) => b.toLowerCase().includes(q));
  }, [availableBranches, branchSearch]);

  const branchTitle = hasGitRepo
    ? `当前 Git 分支：${branchText}${
        isDirty
          ? uncommittedCount
            ? `（未提交：${uncommittedCount} 个文件）`
            : '（工作区有未提交修改）'
          : ''
      } · 点击切换或新建分支`
    : '当前目录尚无 Git 存储库，点击创建';
  const showHomeTray = variant === 'home' && codexMode !== 'Chat';

  const openBranchPopover = () => {
    setPopover((prev) => {
      const next = prev === 'branch' ? null : 'branch';
      if (next === 'branch') {
        setBranchSearch('');
        setCreatingBranch(false);
        setNewBranchName('');
        setBranchError('');
        void onRefreshGitStatus?.();
      }
      return next;
    });
  };

  const handleBranchCheckout = async (targetBranch: string, create: boolean) => {
    const clean = targetBranch.trim();
    if (!clean || branchBusy) return;
    if (!create && clean === branchText) {
      setPopover(null);
      return;
    }
    setBranchBusy(true);
    setBranchError('');
    try {
      await onCheckoutGitBranch?.(clean, create);
      setCreatingBranch(false);
      setNewBranchName('');
      setBranchSearch('');
      setPopover(null);
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : '操作分支失败');
    } finally {
      setBranchBusy(false);
    }
  };

  const handleInitGit = async () => {
    if (initGitBusy || !onInitGitRepo) return;
    setInitGitBusy(true);
    try {
      await onInitGitRepo();
    } finally {
      setInitGitBusy(false);
    }
  };

  const renderBranchBadge = (inFooter = false) => {
    if (!hasGitRepo) {
      return (
        <button
          type="button"
          className={
            inFooter
              ? 'codex-composer-pill codex-git-init-btn'
              : 'codex-tray-item codex-git-init-btn'
          }
          disabled={initGitBusy}
          title={branchTitle}
          onClick={() => void handleInitGit()}
        >
          <IconBranch size={14} style={{ flex: 'none' }} />
          <span>{initGitBusy ? '正在创建...' : '创建 Git 存储库'}</span>
        </button>
      );
    }

    return (
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          className={
            inFooter
              ? 'codex-composer-pill codex-branch-status'
              : 'codex-tray-item codex-branch-status'
          }
          data-dirty={isDirty ? 'true' : undefined}
          data-open={popover === 'branch' ? 'true' : undefined}
          title={branchTitle}
          aria-expanded={popover === 'branch'}
          aria-haspopup="dialog"
          onClick={openBranchPopover}
        >
          <IconBranch size={14} style={{ flex: 'none' }} />
          <span className="codex-branch-name">{branchText}</span>
          {isDirty && (
            <span
              className="codex-branch-dirty"
              aria-label="工作区有未提交修改"
              title={uncommittedCount ? `未提交：${uncommittedCount} 个文件` : '工作区有未提交修改'}
            />
          )}
        </button>

        {popover === 'branch' && (
          <div
            className="codex-popover codex-branch-popover"
            data-side="top"
            style={{ left: 0 }}
            role="dialog"
            aria-label="切换或创建 Git 分支"
          >
            <div className="codex-project-popover-search">
              <IconSearch size={14} style={{ flex: 'none' }} />
              <input
                autoFocus={!creatingBranch}
                placeholder={selectedProject ? `搜索${selectedProject.name}分支` : '搜索分支'}
                value={branchSearch}
                onChange={(e) => {
                  setBranchSearch(e.target.value);
                  setBranchError('');
                }}
              />
            </div>

            <div className="codex-branch-section-label">分支</div>

            <div className="codex-branch-list">
              {filteredBranches.map((b) => {
                const isCurrent = b === branchText;
                return (
                  <button
                    key={b}
                    type="button"
                    className="codex-branch-item"
                    data-selected={isCurrent ? 'true' : undefined}
                    disabled={branchBusy}
                    onClick={() => void handleBranchCheckout(b, false)}
                  >
                    <span className="codex-branch-item-left">
                      <IconBranch size={14} style={{ flex: 'none', marginTop: 2, color: 'var(--text-secondary)' }} />
                      <span className="codex-branch-item-copy">
                        <span className="codex-branch-item-name">{b}</span>
                        {isCurrent && isDirty && (
                          <span className="codex-branch-item-sub">
                            {uncommittedCount !== undefined
                              ? `未提交: ${uncommittedCount} 个文件`
                              : '工作区有未提交修改'}
                          </span>
                        )}
                      </span>
                    </span>
                    {isCurrent && <IconCheck size={14} style={{ flex: 'none', color: 'var(--text-default)' }} />}
                  </button>
                );
              })}

              {!filteredBranches.length && (
                <div className="codex-branch-empty">未找到匹配分支</div>
              )}
            </div>

            {branchError && (
              <div className="codex-branch-error" role="alert">
                {branchError}
              </div>
            )}

            <div className="codex-project-popover-footer">
              {creatingBranch ? (
                <form
                  className="codex-branch-create-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleBranchCheckout(newBranchName, true);
                  }}
                >
                  <input
                    autoFocus
                    className="codex-branch-create-input"
                    placeholder="输入新分支名称，如 feat/new-ui"
                    value={newBranchName}
                    disabled={branchBusy}
                    onChange={(e) => {
                      setNewBranchName(e.target.value);
                      setBranchError('');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setCreatingBranch(false);
                        setBranchError('');
                      }
                    }}
                  />
                  <div className="codex-branch-create-actions">
                    <button
                      type="button"
                      className="codex-branch-cancel-btn"
                      disabled={branchBusy}
                      onClick={() => {
                        setCreatingBranch(false);
                        setBranchError('');
                      }}
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      className="codex-branch-submit-btn"
                      disabled={!newBranchName.trim() || branchBusy}
                    >
                      {branchBusy ? '创建中...' : '创建并检出'}
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  className="codex-popover-item"
                  disabled={branchBusy}
                  onClick={() => {
                    setCreatingBranch(true);
                    setBranchError('');
                    setNewBranchName(branchSearch.trim());
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <IconPlus size={14} />
                    <span>创建并检出新分支...</span>
                  </span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const placeholder =
    variant === 'home'
      ? codexMode === 'Chat'
        ? '随心输入'
        : '随心输入'
      : `和 ${codexMode} 一起工作`;

  return (
    <div className="codex-composer-wrap" ref={rootRef}>
      {/* Slash Command Popover */}
      {slashMatches.length > 0 && (
        <div className="codex-slash-menu" role="listbox" aria-label="快捷命令">
          {slashMatches.map((item, idx) => (
            <button
              key={item.cmd}
              type="button"
              className="codex-popover-item"
              data-selected={idx === menuHighlight ? 'true' : undefined}
              onMouseEnter={() => setMenuHighlight(idx)}
              onClick={() => executeSlash(item.cmd)}
            >
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{item.cmd}</span>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{item.desc}</span>
            </button>
          ))}
        </div>
      )}

      {/* @ Mention Popover */}
      {slashMatches.length === 0 && mentionMatch && (
        <div className="codex-slash-menu" role="listbox" aria-label="引用文件或项目">
          {mentionMatch.items.map((item, idx) => (
            <button
              key={`${item.kind}-${item.label}`}
              type="button"
              className="codex-popover-item"
              data-selected={idx === menuHighlight ? 'true' : undefined}
              onMouseEnter={() => setMenuHighlight(idx)}
              onClick={() => insertMention(item.label)}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <IconFileDoc size={14} style={{ color: 'var(--text-tertiary)' }} />
                <span>{item.label}</span>
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{item.kind}</span>
            </button>
          ))}
        </div>
      )}

      {/* Stacked Context Tray (1:1 with User Screenshots 1 & 2) */}
      {showHomeTray && (
        <div className="codex-composer-tray">
          <div
            className="codex-project-pill-wrap"
            data-open={popover === 'project' ? 'true' : undefined}
          >
            <div className="codex-pill-tooltip">更改此聊天的项目</div>
            <div
              role="button"
              tabIndex={0}
              className="codex-project-pill"
              data-open={popover === 'project' ? 'true' : undefined}
              data-has-project={selectedProject ? 'true' : undefined}
              onClick={() => {
                setProjectSearch('');
                setPopover((p) => (p === 'project' ? null : 'project'));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setProjectSearch('');
                  setPopover((p) => (p === 'project' ? null : 'project'));
                }
              }}
            >
              <span className="codex-project-icon-slot">
                <span className="codex-project-icon-folder">
                  <IconFolder size={14} />
                </span>
                {selectedProject && (
                  <button
                    type="button"
                    className="codex-project-clear-btn"
                    aria-label="不在项目中工作"
                    title="移除项目"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectProject(null);
                      setPopover(null);
                    }}
                  >
                    <IconCircleClose size={14} />
                  </button>
                )}
              </span>
              <span>{selectedProject?.name || '选择项目'}</span>
            </div>

            {popover === 'project' && (
              <div
                className="codex-popover codex-project-popover"
                data-side="top"
                style={{ left: 0 }}
              >
                <div className="codex-project-popover-search">
                  <IconSearch size={14} style={{ flex: 'none' }} />
                  <input
                    autoFocus
                    placeholder="搜索项目"
                    value={projectSearch}
                    onChange={(e) => setProjectSearch(e.target.value)}
                  />
                </div>
                <div className="codex-project-popover-list">
                  {filteredProjects.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="codex-popover-item"
                      data-selected={selectedProject?.id === p.id ? 'true' : undefined}
                      onClick={() => {
                        onSelectProject(p.id);
                        setPopover(null);
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <IconFolder size={14} style={{ color: 'var(--text-secondary)', flex: 'none' }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.name}
                        </span>
                      </span>
                      {selectedProject?.id === p.id && <IconCheck size={14} />}
                    </button>
                  ))}
                  {!filteredProjects.length && (
                    <div
                      style={{
                        padding: '10px 10px',
                        fontSize: 12.5,
                        color: 'var(--text-tertiary)',
                        textAlign: 'center',
                      }}
                    >
                      未找到匹配项目
                    </div>
                  )}
                </div>
                <div className="codex-project-popover-footer">
                  {onOpenCreateProject && (
                    <button
                      type="button"
                      className="codex-popover-item"
                      onClick={() => {
                        setPopover(null);
                        onOpenCreateProject();
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <IconPlus size={14} />
                        <span>新建项目</span>
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="codex-popover-item"
                    style={{ color: 'var(--text-secondary)' }}
                    onClick={() => {
                      onSelectProject(null);
                      setPopover(null);
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <IconClose size={14} />
                      <span>不在项目中工作</span>
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {hasGitRepo && (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="codex-tray-item"
                onClick={() => setPopover((p) => (p === 'env' ? null : 'env'))}
              >
                <IconLaptop size={14} />
                <span>本地</span>
              </button>

              {popover === 'env' && (
                <div className="codex-popover" data-side="top" style={{ left: 0, width: 268, padding: 10 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 6 }}>
                    Worker 隔离容器
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: '18px' }}>
                    每次写入/命令调用均在独立无网络 Docker 容器（<code>--network=none</code>、非 root、私有 tmpfs）中执行，并记录不可变退出码与 Diff 证据。
                  </div>
                </div>
              )}
            </div>
          )}

          {renderBranchBadge(false)}
        </div>
      )}

      {/* Main Rounded Composer Surface with Drag & Drop */}
      <div
        className="codex-composer-card"
        data-dragging={dragging ? 'true' : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setDragging(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files?.length) {
            void attachFileList(e.dataTransfer.files);
          }
        }}
      >
        {dragging && <div className="codex-drop-overlay">松开即可附加文件到工作区</div>}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) void attachFileList(e.target.files);
            e.target.value = '';
          }}
        />

        {attachedKeys.length > 0 && (
          <div className="codex-composer-attachments">
            {attachedKeys.map((name) => {
              const imgUrl = isImagePath(name) ? toImageDataUrl(name, files[name]) : null;
              return (
                <span key={name} className="codex-attach-chip">
                  {imgUrl ? (
                    <img
                      src={imgUrl}
                      alt={name}
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        objectFit: 'cover',
                        flex: 'none',
                      }}
                    />
                  ) : (
                    <IconFileDoc size={13} style={{ color: 'var(--text-tertiary)' }} />
                  )}
                  <span>{name}</span>
                  <button
                    type="button"
                    aria-label={`移除 ${name}`}
                    onClick={() => {
                      const copy = { ...files };
                      delete copy[name];
                      setFiles(copy);
                    }}
                  >
                    <IconClose size={12} />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="codex-composer-textarea"
          rows={1}
          aria-label="消息内容"
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={(e) => {
            if (e.clipboardData.files?.length) {
              e.preventDefault();
              void attachFileList(e.clipboardData.files);
            }
          }}
        />

        <div className="codex-composer-footer">
          <div className="codex-composer-controls">
            <button
              type="button"
              className="codex-icon-btn"
              aria-label="附加输入文件"
              title="附加输入文件到任务工作区（也支持拖拽）"
              onClick={() => fileInputRef.current?.click()}
            >
              <IconPlus size={16} />
            </button>

            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="codex-composer-pill"
                data-warning={permissionMode === 'full-access' ? 'true' : undefined}
                data-open={popover === 'permission' ? 'true' : undefined}
                aria-label={
                  permissionMode === 'full-access'
                    ? '完全访问'
                    : permissionMode === 'auto-safe'
                      ? '帮我批准'
                      : '请求批准'
                }
                onClick={() => setPopover((p) => (p === 'permission' ? null : 'permission'))}
              >
                {permissionMode === 'full-access' ? (
                  <IconShieldAlert size={15} />
                ) : permissionMode === 'auto-safe' ? (
                  <IconShieldTerminal size={15} />
                ) : (
                  <IconHand size={15} />
                )}
                <span>
                  {permissionMode === 'full-access'
                    ? '完全访问'
                    : permissionMode === 'auto-safe'
                      ? '帮我批准'
                      : '请求批准'}
                </span>
              </button>

              {popover === 'permission' && (
                <div className="codex-popover codex-perm-popover" data-side="top" style={{ left: 0 }}>
                  <div className="codex-perm-header">
                    <span>应如何批准 Codex 操作?</span>
                    <button
                      type="button"
                      className="codex-perm-learn-link"
                      onClick={() => {
                        setPopover(null);
                        onSlashCommand?.('/settings');
                      }}
                    >
                      了解更多
                    </button>
                  </div>

                  <button
                    type="button"
                    className="codex-perm-option"
                    onClick={() => {
                      onChangePermission('approval');
                      setPopover(null);
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <IconHand size={16} style={{ marginTop: 2, flex: 'none', color: 'var(--text-secondary)' }} />
                      <div>
                        <div className="codex-perm-option-title">请求批准</div>
                        <div className="codex-perm-option-desc">
                          编辑外部文件和使用互联网时始终询问
                        </div>
                      </div>
                    </div>
                    {permissionMode === 'approval' && <IconCheck size={15} style={{ flex: 'none', marginTop: 2 }} />}
                  </button>

                  <button
                    type="button"
                    className="codex-perm-option"
                    onClick={() => {
                      onChangePermission('auto-safe');
                      setPopover(null);
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <IconShieldTerminal size={16} style={{ marginTop: 2, flex: 'none', color: 'var(--text-secondary)' }} />
                      <div>
                        <div className="codex-perm-option-title">帮我批准</div>
                        <div className="codex-perm-option-desc">
                          仅对检测到的风险操作请求批准
                        </div>
                      </div>
                    </div>
                    {permissionMode === 'auto-safe' && <IconCheck size={15} style={{ flex: 'none', marginTop: 2 }} />}
                  </button>

                  <button
                    type="button"
                    className="codex-perm-option"
                    data-danger="true"
                    onClick={() => {
                      onChangePermission('full-access');
                      setPopover(null);
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <IconShieldAlert size={16} style={{ marginTop: 2, flex: 'none' }} />
                      <div>
                        <div className="codex-perm-option-title">完全访问权限</div>
                        <div className="codex-perm-option-desc">
                          可不受限制地访问互联网和你电脑上的任何文件
                        </div>
                      </div>
                    </div>
                    {permissionMode === 'full-access' && <IconCheck size={15} style={{ flex: 'none', marginTop: 2 }} />}
                  </button>
                </div>
              )}
            </div>

            {!showHomeTray && renderBranchBadge(true)}
          </div>

          <div className="codex-composer-controls">
            {/* Exact Codex Model & Effort Slider Trigger */}
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="codex-composer-pill"
                data-open={popover === 'effort' || popover === 'models' ? 'true' : undefined}
                onClick={() =>
                  setPopover((p) => (p === 'effort' || p === 'models' ? null : 'effort'))
                }
              >
                {popover === 'effort' ? (
                  <span>选择推理强度</span>
                ) : (
                  <>
                    <span className="codex-composer-model-name">{displayModel}</span>
                    <span className="codex-effort-label-viewport">
                      <span key={effortMeta.id} className="codex-effort-label-val">
                        {effortMeta.label}
                      </span>
                    </span>
                  </>
                )}
                <IconChevronDown size={14} />
              </button>

              {/* Floating Blue Effort Slider Popover (1:1 with live/model_picker.png) */}
              {popover === 'effort' && (
                <div
                  className="codex-popover codex-effort-popover"
                  data-side="top"
                  style={{ right: 0 }}
                >
                  <div className="codex-effort-header">
                    <span key={effortMeta.id} className="codex-effort-level codex-effort-label-val">
                      {effortMeta.label}
                    </span>
                    <button
                      type="button"
                      className="codex-effort-model-btn"
                      onClick={() => setPopover('models')}
                    >
                      <span>{displayModel}</span>
                      <IconChevronRight size={13} />
                    </button>
                    <button
                      type="button"
                      className="codex-effort-reset"
                      title="重置默认推理强度"
                      onClick={() => {
                        onChangeEffort('xhigh');
                      }}
                    >
                      <IconReset size={14} />
                    </button>
                  </div>

                  <div
                    ref={trackRef}
                    className="codex-effort-track"
                    role="slider"
                    aria-label="推理强度"
                    aria-valuemin={0}
                    aria-valuemax={EFFORT_STOPS.length - 1}
                    aria-valuenow={effortIdx}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowLeft') {
                        e.preventDefault();
                        setEffortByIndex(effortIdx - 1);
                      } else if (e.key === 'ArrowRight') {
                        e.preventDefault();
                        setEffortByIndex(effortIdx + 1);
                      }
                    }}
                    onMouseDown={(e) => {
                      updateEffortFromPointer(e.clientX);
                      const onMove = (ev: MouseEvent) => updateEffortFromPointer(ev.clientX);
                      const onUp = () => {
                        window.removeEventListener('mousemove', onMove);
                        window.removeEventListener('mouseup', onUp);
                      };
                      window.addEventListener('mousemove', onMove);
                      window.addEventListener('mouseup', onUp);
                    }}
                  >
                    <div
                      className="codex-effort-fill"
                      style={{ width: `calc(${thumbPercent}% + 10px)` }}
                    />
                    <div className="codex-effort-stops">
                      {EFFORT_STOPS.map((stop, idx) => (
                        <span
                          key={stop.id}
                          className="codex-effort-pip"
                          data-beyond={idx > effortIdx ? 'true' : undefined}
                        />
                      ))}
                    </div>
                    <div className="codex-effort-thumb" style={{ left: `${thumbPercent}%` }} />
                  </div>
                </div>
              )}

              {/* Drill-down Model Selector Popover with Back header */}
              {popover === 'models' && (
                <div className="codex-popover" data-side="top" style={{ right: 0, width: 256 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 6px 6px',
                      fontSize: 12.5,
                      fontWeight: 500,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <button
                      type="button"
                      className="codex-icon-btn"
                      style={{ width: 22, height: 22 }}
                      onClick={() => setPopover('effort')}
                      aria-label="返回推理强度"
                    >
                      <IconArrowBack size={13} />
                    </button>
                    <span>选择模型</span>
                  </div>
                  <div className="codex-popover-divider" />
                  <button
                    type="button"
                    className="codex-popover-item"
                    data-selected={selectedModel === '' ? 'true' : undefined}
                    onClick={() => {
                      onSelectModel('');
                      setPopover('effort');
                    }}
                  >
                    <span>自动路由（Router 按角色最优）</span>
                    {selectedModel === '' && <IconCheck size={14} />}
                  </button>
                  {models.length === 0 ? (
                    <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-tertiary)' }}>
                      后端尚未配置模型目录，可在「设置 → 供应商与网关」查看配置指引。
                    </div>
                  ) : (
                    models.map((m) => (
                      <button
                        key={`${m.provider}/${m.model}`}
                        type="button"
                        className="codex-popover-item"
                        data-selected={selectedModel === m.model ? 'true' : undefined}
                        onClick={() => {
                          onSelectModel(m.model);
                          setPopover('effort');
                        }}
                      >
                        <span style={{ display: 'flex', flexDirection: 'column' }}>
                          <span>{m.model}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                            {m.provider} · {Math.round(m.context / 1000)}k ctx
                          </span>
                        </span>
                        {selectedModel === m.model && <IconCheck size={14} />}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {isRunning && onStop && !text.trim() ? (
              <button
                type="button"
                className="codex-send-btn"
                aria-label="暂停任务"
                title="暂停当前任务"
                onClick={onStop}
              >
                <IconStopSquare size={12} />
              </button>
            ) : (
              <button
                type="button"
                className="codex-send-btn"
                aria-label={isRunning ? '实时注入纠偏指令' : '发送消息'}
                title={isRunning ? 'Agent 运行中：发送实时纠偏指令 (Steer)' : '发送消息'}
                disabled={!text.trim() || submitting}
                onClick={() => void handleSend()}
              >
                <IconArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
