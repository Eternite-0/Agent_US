import { resolveComposerDraft, type ComposerMode } from '../utils/composerMode';
import { PromptCacheStatus } from './PromptCacheStatus';
import { isSwarmCommand, swarmAttachmentError } from '../utils/swarmCommand';
import type { ComposerDraft, ComposerDraftStore } from '../utils/threadInteraction';
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  GitStatus,
  CodexMode,
  EffortLevel,
  ModelSpec,
  PermissionMode,
  SessionPermissionMode,
  WorkspaceCustomizations,
  WorkspaceEntryKind,
  Project,
} from '../types/backend';
import {
  findSlashCommand,
  matchesSlashCommand,
  mergeSlashCommandGroups,
  type CommandAvailability,
  type MentionExtension,
  type SlashCommand,
} from './slashCommands';
import { usePresence, usePresenceSnapshot } from '../hooks/usePresence';
import { ComposerDialog, SketchDialog } from './ComposerDialog';
import { PresenceDiv } from './PresenceDiv';
import './composer-motion.css';
import { encodeUtf8Base64 } from '../utils/diff';
import { isImagePath, toImageDataUrl } from './ImageLightbox';
import {
  IconArrowBack,
  IconArrowUp,
  IconBranch,
  IconCheck,
  IconChevronRight,
  IconCircleClose,
  IconAgentTeam,
  IconLightbulb,
  IconTarget,
  IconClose,
  IconFileDoc,
  IconFileEdit,
  IconImageInspect,
  IconFolder,
  IconHand,
  IconLaptop,
  IconPlus,
  IconPuzzle,
  IconSkillsNode,
  IconReset,
  IconSearch,
  IconShieldAlert,
  IconShieldTerminal,
  IconStopSquare,
} from './Icons';

interface ComposerProps {
  variant: 'home' | 'thread';
  draftStore: ComposerDraftStore;
  codexMode: CodexMode;
  projects: Project[];
  selectedProject: Project | null;
  models: ModelSpec[];
  selectedModel: string;
  effort: EffortLevel;
  permissionMode: SessionPermissionMode;
  gitStatus?: GitStatus | null;
  gitError?: string;
  permissionPending?: boolean;
  mentionFiles?: string[];
  mentionPlugins?: MentionExtension[];
  mentionSkills?: MentionExtension[];
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
  onStartReview?: (baseBranch?: string) => Promise<void>;
  onSlashCommand?: (command: SlashCommand) => void;
  commandAvailability?: CommandAvailability;
  customizations?: WorkspaceCustomizations | null;
  searchMentionFiles?: (query: string, signal: AbortSignal, kind: WorkspaceEntryKind) => Promise<string[]>;
  onSubmitGoal?: (goal: string, files: Record<string, string>) => Promise<boolean>;
  onSteer?: (text: string, files: Record<string, string>) => Promise<boolean | void> | void;
  onSubmit: (text: string, files: Record<string, string>) => Promise<boolean | void> | void;
  onStop?: () => void;
}

const EFFORT_STOPS: Array<{ id: EffortLevel; label: string }> = [
  { id: 'low', label: '轻度' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '极高' },
  { id: 'max', label: 'Max' },
];

type PopoverKind = null | 'project' | 'env' | 'branch' | 'permission' | 'effort' | 'models';

function updateComposerHeight(input: HTMLTextAreaElement, probe: HTMLTextAreaElement) {
  const { minHeight, maxHeight } = getComputedStyle(input);
  const next = `${Math.max(parseFloat(minHeight), Math.min(probe.scrollHeight, parseFloat(maxHeight)))}px`;
  if (input.style.height !== next) input.style.height = next;
}

function AttachmentChip({ name, data, onRemove, onExited }: {
  name: string;
  data: string | undefined;
  onRemove: () => void;
  onExited: () => void;
}) {
  const open = data !== undefined;
  const ref = useRef<HTMLSpanElement>(null);
  const present = usePresence(open, ref, onExited);
  const visibleData = usePresenceSnapshot(open, data);
  if (!present) return null;
  const imgUrl = visibleData && isImagePath(name) ? toImageDataUrl(name, visibleData) : null;
  return (
    <span ref={ref} className="codex-attach-chip" data-image={imgUrl ? 'true' : undefined}
      data-presence={open ? 'open' : 'exiting'} inert={!open} aria-hidden={!open || undefined}>
      {imgUrl ? <img src={imgUrl} alt={name} className="composer-image-preview" />
        : <IconFileDoc size={13} style={{ color: 'var(--text-tertiary)' }} />}
      <span>{name}</span>
      <button type="button" aria-label={`移除 ${name}`} onClick={open ? onRemove : undefined}><IconClose size={12} /></button>
    </span>
  );
}

function ComposerAttachments({ files, onRemove }: {
  files: ComposerDraft['files'];
  onRemove: (name: string) => void;
}) {
  const [tracked, setTracked] = useState(() => ({ files, keys: Object.keys(files) }));
  if (tracked.files !== files) {
    // Keep removed keys in their existing positions just long enough to paint the exit.
    setTracked({ files, keys: [...new Set([...tracked.keys, ...Object.keys(files)])] });
  }
  if (!tracked.keys.length) return null;
  return (
    <div className="codex-composer-attachments">
      {tracked.keys.map((name) => <AttachmentChip key={name} name={name} data={Object.hasOwn(files, name) ? files[name] : undefined}
        onRemove={() => onRemove(name)} onExited={() => setTracked((before) => Object.hasOwn(before.files, name)
          ? before : { ...before, keys: before.keys.filter((key) => key !== name) })} />)}
    </div>
  );
}

export const Composer: React.FC<ComposerProps> = ({
  variant,
  draftStore,
  codexMode,
  projects,
  selectedProject,
  models,
  selectedModel,
  effort,
  permissionMode,
  gitStatus = null,
  gitError,
  permissionPending = false,
  mentionFiles = [],
  mentionPlugins = [],
  mentionSkills = [],
  draftInjection = null,
  isRunning = false,
  submitting: externalSubmitPending = false,
  onSelectProject,
  onOpenCreateProject,
  onSelectModel,
  onChangeEffort,
  onChangePermission,
  onRefreshGitStatus,
  onCheckoutGitBranch,
  onInitGitRepo,
  onStartReview,
  onSlashCommand,
  commandAvailability,
  customizations = null,
  searchMentionFiles,
  onSubmitGoal,
  onSteer,
  onSubmit,
  onStop,
}) => {
  const snapshot = useSyncExternalStore(draftStore.subscribe, draftStore.read, draftStore.read);
  const sendingDraft = useSyncExternalStore(draftStore.subscribe, draftStore.isSending, draftStore.isSending);
  const submitting = externalSubmitPending || sendingDraft;
  const { text, files, mode: draftMode } = snapshot;
  const setText = (next: React.SetStateAction<ComposerDraft['text']>) => draftStore.update('text', next);
  const setFiles = (next: React.SetStateAction<ComposerDraft['files']>) => draftStore.update('files', next);
  const setDraftMode = (next: ComposerDraft['mode']) => draftStore.update('mode', next);
  const activeMode = draftMode ?? (codexMode === 'Work' ? 'plan' : null);
  const [popover, setPopover] = useState<PopoverKind>(null);
  const [dragging, setDragging] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchError, setBranchError] = useState('');
  const [initGitBusy, setInitGitBusy] = useState(false);
  const [menuHighlight, setMenuHighlight] = useState<number | null>(null);
  const [commandError, setCommandError] = useState('');
  const [dialog, setDialog] = useState<'sketch' | 'files' | 'review' | null>(null);
  const [reviewBranch, setReviewBranch] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const canCaptureWindow = Boolean(typeof window !== 'undefined' && window.codexDesktop?.captureWindow);
  const [caret, setCaret] = useState(0);
  const [addContextOpen, setAddContextOpen] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [searchResult, setSearchResult] = useState<{ query: string; kind: WorkspaceEntryKind; files: string[]; failed?: boolean } | null>(null);
  const menuId = useId();
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const permissionTrigger = useRef<HTMLButtonElement>(null);
  const projectTrigger = useRef<HTMLDivElement>(null);
  const branchTrigger = useRef<HTMLButtonElement>(null);
  const envTrigger = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const heightProbe = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!draftInjection || !draftStore.consumeInjection(draftInjection)) return;
    draftStore.update('text', (prev) =>
      draftInjection.mode === 'replace'
        ? draftInjection.text
        : prev.trim()
          ? `${prev.trimEnd()}

${draftInjection.text}`
          : draftInjection.text,
    );
    const timer = window.setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 10);
    return () => window.clearTimeout(timer);
  }, [draftInjection, draftStore]);

  useLayoutEffect(() => {
    if (textareaRef.current && heightProbe.current) updateComposerHeight(textareaRef.current, heightProbe.current);
  }, [text]);

  useLayoutEffect(() => {
    const input = textareaRef.current;
    const probe = heightProbe.current;
    if (!input || !probe) return;
    const measure = () => updateComposerHeight(input, probe);
    // The probe's width changes with wrapping space; its height never changes during the transition.
    const observer = new ResizeObserver(measure);
    observer.observe(probe);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const allCommandGroups = useMemo(() => mergeSlashCommandGroups(customizations), [customizations]);
  const dynamicCommands = useMemo(
    () => allCommandGroups.find((g) => g.label === '项目命令与技能')?.commands ?? [],
    [allCommandGroups],
  );
  const slashQuery = !menuDismissed && !addContextOpen && onSlashCommand && /^\/[\p{L}\p{N}_?:-]*$/u.test(text.trimStart())
    ? text.trimStart().toLowerCase() : null;
  const slashGroups = useMemo(() => slashQuery === null ? [] : allCommandGroups.map(({ label, commands }) => ({
    label, commands: commands.filter((command) => matchesSlashCommand(command, slashQuery)),
  })).filter(({ commands }) => commands.length), [slashQuery, allCommandGroups]);
  const slashMatches = slashGroups.flatMap(({ commands }) => commands);
  const exactSlash = slashQuery ? findSlashCommand(slashQuery, dynamicCommands) : undefined;
  const firstMatch = exactSlash ? slashMatches.indexOf(exactSlash) : 0;
  const commandBlock = ({ cmd, threadOnly, customCommand }: SlashCommand) => {
    if (customCommand) return undefined;
    if (threadOnly && variant !== 'thread') return '请先打开一个会话';
    if (permissionMode === 'read-only' && ['/swarm', '/goal', '/plan'].includes(cmd)) return '请在普通会话中启动执行任务';
    if (cmd === '/goal' && !onSubmitGoal) return '当前连接未提供自主任务';
    if ((isRunning || submitting) && ['/goal', '/compact', '/rewind'].includes(cmd)) return '请等待当前对话执行结束';
    if (cmd === '/stop' && (!isRunning || !onStop)) return '当前没有运行中的对话任务';
    if (cmd === '/review') return !onStartReview ? '当前连接未提供代码审查'
      : gitError || (!gitStatus ? '正在读取 Git 状态' : !gitStatus.available ? '当前工作区不是 Git 仓库'
        : (isRunning || submitting) ? '请等待当前对话执行结束' : undefined);
    if (cmd === '/branch' && !gitStatus?.available) return '当前项目没有 Git 状态';
    if (cmd === '/folder' && !searchMentionFiles) return '当前连接未提供工作区文件夹搜索';
    if (cmd === '/file' && !searchMentionFiles && !mentionFiles.length) return '当前连接未提供工作区文件搜索';
    if (cmd === '/project' && (variant !== 'home' || codexMode === 'Chat')) return '请在首页的 Codex 或 Work 模式选择项目';
    return commandAvailability?.[cmd];
  };

  const mentionToken = useMemo(() => {
    if (menuDismissed || slashQuery !== null) return null;
    const left = text.slice(0, caret);
    const match = /(?:^|\s)(@(?:(file|folder|skill|plugin):)?(?:"([^"\n]*)|([^\s@"]*)))$/i.exec(left);
    if (!match) return addContextOpen ? { start: caret, end: caret, scope: undefined, query: '' } : null;
    const right = text.slice(caret);
    const tail = match[3] !== undefined ? /^(?:[^"\n]*")/.exec(right)?.[0] : /^[^\s@"]*/.exec(right)?.[0];
    const query = match[3] ?? match[4] ?? '';
    const keyword = !match[2] && !match[3] ? /^(skills?|plugins?)$/i.exec(query)?.[0].toLowerCase() : undefined;
    return {
      start: caret - match[1].length,
      end: caret + (tail?.length ?? 0),
      scope: match[2]?.toLowerCase() ?? keyword?.replace(/s$/, ''),
      query: keyword ? '' : query,
    };
  }, [text, caret, menuDismissed, slashQuery, addContextOpen]);
  const mentionQuery = mentionToken?.query;
  const scope = mentionToken?.scope;
  const entryKind: WorkspaceEntryKind = scope === 'file' || scope === 'folder' ? scope : 'all';
  const canSearchFiles = Boolean(mentionToken && (scope === 'file' || scope === 'folder' || (!scope && mentionQuery)));
  const workspaceResults = searchResult?.query === mentionQuery && searchResult?.kind === entryKind ? searchResult : null;

  useEffect(() => {
    if (!searchMentionFiles || !canSearchFiles || mentionQuery === undefined) return;
    const controller = new AbortController();
    setSearchResult(null);
    const timer = window.setTimeout(async () => {
      try {
        const result = await searchMentionFiles(mentionQuery, controller.signal, entryKind);
        if (!controller.signal.aborted) setSearchResult({ query: mentionQuery, kind: entryKind, files: result });
      } catch {
        if (!controller.signal.aborted) setSearchResult({ query: mentionQuery, kind: entryKind, files: [], failed: true });
      }
    }, 140);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [mentionQuery, searchMentionFiles, canSearchFiles, entryKind]);

  type MentionItem = { id: string; label: string; description?: string; icon: typeof IconFileDoc; iconUrl?: string; color?: string; kind?: 'skill' | 'plugin'; disabled?: boolean; action?: 'files' | 'snapshot' | 'sketch' | 'goal' | 'plan' | 'plugin-details' | 'plugins' | 'skills' };
  const mentionGroups = useMemo<Array<{ label: string; items: MentionItem[] }>>(() => {
    if (!mentionToken) return [];
    const query = mentionToken.query.toLowerCase().replaceAll('\\', '/');
    const matches = (item: MentionItem) => [item.label, item.id, item.description]
      .some((value) => value?.toLowerCase().includes(query));
    const workFiles = searchMentionFiles ? workspaceResults?.files ?? [] : mentionFiles;
    const choices: Array<{ label: string; items: MentionItem[] }> = [];
    const addActions: MentionItem[] = [
      { id: 'files', label: '文件和文件夹', icon: IconFolder, action: 'files' },
      { id: 'snapshot', label: '附加应用快照', description: canCaptureWindow ? '截取当前 Agent_US 窗口' : '在桌面版可用', icon: IconImageInspect, action: 'snapshot', disabled: !canCaptureWindow },
      { id: 'goal', label: '目标', description: onSubmitGoal ? '设置要持续追求的目标' : '当前连接未提供自主任务', icon: IconTarget, action: 'goal', disabled: !onSubmitGoal },
      { id: 'plan', label: '计划模式', description: codexMode === 'Work' ? '退出计划模式' : '先制定计划，再审批执行', icon: IconLightbulb, action: 'plan', disabled: !onSlashCommand },
      { id: 'sketch', label: '绘图', description: '绘制草图并附加到消息', icon: IconFileEdit, action: 'sketch' },
    ];
    if (!mentionToken.scope) choices.push({ label: '添加', items: addActions });
    if (!mentionToken.scope || mentionToken.scope === 'plugin') choices.push({ label: '插件', items: mentionPlugins.map(({ id, name, description, iconUrl, color, installed }) => (
      { id, label: name, description: installed === false ? `${description} · 待安装` : description,
        icon: color ? IconFileDoc : IconPuzzle, iconUrl, color, kind: 'plugin', action: installed === false ? 'plugin-details' : undefined }
    )) });
    if (!mentionToken.scope || mentionToken.scope === 'skill') choices.push({ label: '技能', items: mentionSkills.map(({ id, name, description }) => (
      { id, label: name, description, icon: IconSkillsNode, kind: 'skill' }
    )) });
    if (!query && (!mentionToken.scope || mentionToken.scope === 'plugin')) {
      choices.find(({ label }) => label === '插件')?.items.push({ id: 'manage-plugins', label: '浏览插件', icon: IconPuzzle, action: 'plugins' });
    }
    if (!query && !mentionSkills.length && (!mentionToken.scope || mentionToken.scope === 'skill')) {
      choices.find(({ label }) => label === '技能')?.items.push({ id: 'manage-skills', label: '浏览技能', icon: IconSkillsNode, action: 'skills' });
    }
    if (canSearchFiles) {
      const paths = [...new Set([...Object.keys(files), ...workFiles])];
      const entries = paths.filter((path) => entryKind === 'all' || path.endsWith('/') === (entryKind === 'folder'));
      choices.push({ label: entryKind === 'folder' ? '文件夹' : '工作区', items: entries.map((path) => ({
        id: path, label: path, icon: path.endsWith('/') ? IconFolder : IconFileDoc,
      })) });
    }
    return choices.map(({ label, items }) => ({ label, items: items.filter(matches).slice(0, 20) })).filter(({ items }) => items.length);
  }, [mentionToken, files, mentionFiles, mentionPlugins, mentionSkills, canSearchFiles, entryKind, workspaceResults, searchMentionFiles, onSubmitGoal, canCaptureWindow, codexMode, onSlashCommand]);
  const mentionItems = mentionGroups.flatMap(({ items }) => items);

  const menuCount = slashMatches.length || mentionItems.length;
  const selectedIndex = Math.min(menuHighlight ?? Math.max(0, firstMatch), Math.max(0, menuCount - 1));
  const menuIsOpen = slashQuery !== null || Boolean(mentionToken);
  useEffect(() => { setMenuHighlight(null); }, [text, mentionQuery, workspaceResults]);
  useEffect(() => {
    if (!menuIsOpen) return;
    const row = menuRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    const options = menuRef.current?.querySelector('.composer-picker-options');
    if (!row || !options) return;
    const rowBounds = row.getBoundingClientRect();
    const bounds = options.getBoundingClientRect();
    if (rowBounds.top < bounds.top) options.scrollTop += rowBounds.top - bounds.top;
    if (rowBounds.bottom > bounds.bottom) options.scrollTop += rowBounds.bottom - bounds.bottom;
  }, [menuIsOpen, selectedIndex, slashQuery, menuCount]);

  useEffect(() => {
    if (!popover && !menuIsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setPopover(null);
        setAddContextOpen(false);
        setMenuDismissed(true);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (menuIsOpen) {
        setAddContextOpen(false);
        setMenuDismissed(true);
      }
      if (!popover) return;
      // Preserve Escape dismissal even when a pointer-opened menu did not take focus.
      if (rootRef.current?.contains(document.activeElement)) {
        if (popover === 'effort' || popover === 'models') modelTrigger.current?.focus({ preventScroll: true });
        if (popover === 'permission') permissionTrigger.current?.focus({ preventScroll: true });
        if (popover === 'project') projectTrigger.current?.focus({ preventScroll: true });
        if (popover === 'branch') branchTrigger.current?.focus({ preventScroll: true });
        if (popover === 'env') envTrigger.current?.focus({ preventScroll: true });
      }
      setPopover(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [popover, menuIsOpen]);

  const attachFileList = async (list: FileList | File[]) => {
    const arr = Array.from(list).slice(0, 12);
    if (!arr.length) return;
    const finishRead = draftStore.startFileRead();
    const next: Record<string, string> = {};
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
        setCommandError(`无法读取附件 ${f.name}`);
      }
    }
    finishRead();
    setFiles((previous) => ({ ...previous, ...next }));
  };

  const placeCaret = (position: number) => {
    setCaret(position);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(position, position);
    });
  };


  const setMode = (mode: ComposerMode, draft = '') => {
    const command = findSlashCommand(`/${mode}`);
    const blocked = command && commandBlock(command);
    if (blocked) {
      setCommandError(blocked);
      return;
    }
    if (mode === 'plan') {
      if (codexMode !== 'Work' || !draftMode) {
        if (command) onSlashCommand?.(command);
      }
      setDraftMode(null);
    } else {
      setDraftMode(mode);
    }
    setText(draft);
    setCommandError('');
    setAddContextOpen(false);
    setMenuHighlight(null);
    setMenuDismissed(true);
    setPopover(null);
    placeCaret(draft.length);
  };

  const clearMode = () => {
    if (draftMode) setDraftMode(null);
    else if (activeMode === 'plan') {
      const command = findSlashCommand('/plan');
      if (command) onSlashCommand?.(command);
    }
    setCommandError('');
    placeCaret(caret);
  };

  const clearDraft = () => {
    if (!draftStore.clearIfUnchanged(snapshot)) return;
    setCaret(0);
    setMenuDismissed(true);
  };

  const submitPromptText = async (body: string, attached: Record<string, string>) => {
    if (submitting || permissionPending || draftStore.isSending()) return false;
    if (draftStore.hasPendingFileReads()) {
      setCommandError('请等待附件读取完成。');
      return false;
    }
    setCommandError('');
    draftStore.setSending(true);
    try {
      const ok = isRunning && onSteer && !isSwarmCommand(body) && activeMode !== 'plan'
        ? await onSteer(body, attached)
        : await onSubmit(body, attached);
      if (ok !== false) {
        clearDraft();
        return true;
      }
      return false;
    } finally {
      draftStore.setSending(false);
    }
  };

  const executeSlash = (command: SlashCommand, opts?: { fillOnly?: boolean }) => {
    const blocked = commandBlock(command);
    if (blocked) {
      setCommandError(blocked);
      return;
    }
    setCommandError('');
    setAddContextOpen(false);
    const { cmd } = command;
    if (command.customCommand) {
      const prompt = command.submitText ?? cmd;
      if (opts?.fillOnly) {
        setMenuDismissed(true);
        setText(`${prompt} `);
        placeCaret(prompt.length + 1);
      } else {
        setMenuDismissed(true);
        void submitPromptText(prompt, { ...files });
      }
      return;
    }
    if (cmd === '/swarm' || cmd === '/goal' || cmd === '/plan') {
      setMode(cmd.slice(1) as ComposerMode);
      return;
    }
    if (cmd === '/chat' || cmd === '/run') setDraftMode(null);
    const insertion = cmd === '/file' ? '@file:' : cmd === '/folder' ? '@folder:' : cmd === '/help' ? '/' : '';
    setMenuDismissed(false);
    setText(insertion);
    setCaret(insertion.length);
    if (insertion) {
      setPopover(null);
      setMenuHighlight(null);
      placeCaret(insertion.length);
    } else if (command.popover === 'branch') {
      openBranchPopover(true);
    } else if (command.popover) {
      setPopover(command.popover);
    } else if (cmd === '/attach') {
      fileInputRef.current?.click();
    } else if (cmd === '/review') {
      setReviewBranch('');
      setReviewError('');
      setDialog('review');
    } else if (cmd === '/sketch') {
      setDialog('sketch');
    } else if (cmd === '/clear') {
      setFiles({});
    } else if (cmd === '/stop') {
      onStop?.();
    } else {
      onSlashCommand?.(command);
    }
  };

  const insertMention = (item: (typeof mentionItems)[number]) => {
    if (!mentionToken || item.disabled) return;
    setCommandError('');
    const before = text.slice(0, mentionToken.start);
    const rest = text.slice(mentionToken.end);
    setAddContextOpen(false);
    setMenuDismissed(true);
    if (item.action === 'goal' || item.action === 'plan') {
      setMode(item.action, (before + rest).trim());
    } else if (item.action) {
      setText(before + rest);
      placeCaret(before.length);
      if (item.action === 'files') setDialog('files');
      else if (item.action === 'sketch') setDialog('sketch');
      else if (item.action === 'plugin-details') {
        onSlashCommand?.({ cmd: '/plugins', desc: '', icon: IconPuzzle, view: { kind: 'capabilities', pluginId: item.id } });
      }
      else if (item.action === 'snapshot') {
        void window.codexDesktop?.captureWindow?.().then((image) => {
          if (image) setFiles((previous) => ({ ...previous, [`snapshot-${Date.now()}.png`]: image }));
          else setCommandError('当前窗口无法截取快照。');
        }).catch(() => setCommandError('无法截取当前应用窗口。'));
      } else {
        const command = findSlashCommand('/' + item.action);
        if (command) onSlashCommand?.(command);
      }
    } else {
      const reference = `@${item.kind ? `${item.kind}:` : ''}${/[\s@"]/.test(item.label) ? JSON.stringify(item.label) : item.label}`;
      const inserted = `${reference}${!rest || !/^\s/.test(rest) ? ' ' : ''}`;
      setText(before + inserted + rest);
      placeCaret(before.length + inserted.length + (/^[ \t]/.test(rest) ? 1 : 0));
    }
  };

  const closeDialog = () => {
    setDialog(null);
    placeCaret(caret);
  };

  const openWorkspacePicker = (scope: 'file' | 'folder') => {
    const token = `@${scope}:`;
    const start = caret > 0 && !/\s/.test(text[caret - 1]) ? ` ${token}` : token;
    setText(text.slice(0, caret) + start + text.slice(caret));
    setMenuDismissed(false);
    setDialog(null);
    placeCaret(caret + start.length);
  };

  const applyReview = async () => {
    if (!onStartReview || reviewBusy) return;
    setReviewBusy(true);
    setReviewError('');
    try {
      await onStartReview(reviewBranch || undefined);
      setDialog(null);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : '启动代码审查失败');
    } finally {
      setReviewBusy(false);
    }
  };

  const handleSend = async () => {
    if (submitting || permissionPending || draftStore.isSending()) return;
    const draft = resolveComposerDraft(text, activeMode);
    if (draft.kind === 'empty') return;
    if (slashQuery !== null && slashMatches.length > 0 && !exactSlash) {
      executeSlash(slashMatches[selectedIndex]);
      return;
    }
    if (draft.kind === 'activate') {
      setMode(draft.mode);
      return;
    }
    const [word] = text.trim().split(/\s/, 1);
    const command = onSlashCommand ? findSlashCommand(word, dynamicCommands) : undefined;
    if (command && !command.customCommand && !['/plan', '/swarm', '/goal'].includes(command.cmd)) {
      if (text.trim().length === word.length) executeSlash(command);
      else setCommandError(`${command.cmd} 无需参数，请仅输入命令。`);
      return;
    }
    const swarm = draft.kind === 'submit' && isSwarmCommand(draft.body);
    const blocked = (swarm && (swarmAttachmentError(draft.body, files) || commandAvailability?.['/swarm']))
      || (draft.kind === 'goal' && ((!onSubmitGoal ? '当前连接未提供自主任务' : undefined) || commandAvailability?.['/goal']
        || (isRunning ? '请等待当前对话执行结束' : undefined)));
    if (blocked || draftStore.hasPendingFileReads()) {
      setCommandError(blocked || '请等待附件读取完成。');
      return;
    }
    setCommandError('');
    const attached = { ...files };
    if (draft.kind === 'goal') {
      draftStore.setSending(true);
      try {
        if (await onSubmitGoal?.(draft.body, attached)) clearDraft();
      } finally {
        draftStore.setSending(false);
      }
      return;
    }
    await submitPromptText(draft.body, attached);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (menuIsOpen && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setMenuDismissed(true);
      setAddContextOpen(false);
      return;
    }
    if (menuCount && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setMenuHighlight((selectedIndex + menuCount + direction) % menuCount);
      return;
    }
    if (menuCount && !event.shiftKey && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault();
      if (slashMatches.length) {
        executeSlash(slashMatches[selectedIndex], { fillOnly: event.key === 'Tab' });
      } else insertMention(mentionItems[selectedIndex]);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!canSearchFiles || !searchMentionFiles || workspaceResults) void handleSend();
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

  const modeControl = activeMode && {
    swarm: { label: 'Swarm', icon: IconAgentTeam, placeholder: '描述要交给 Swarm 的任务…' },
    goal: { label: '目标', icon: IconTarget, placeholder: '描述你的目标，定义可衡量的成果…' },
    plan: { label: '计划', icon: IconLightbulb, placeholder: '描述你的任务以生成计划…' },
  }[activeMode];
  const sendLabel = activeMode === 'swarm' || isSwarmCommand(text) ? '发送 Swarm 命令'
    : activeMode === 'goal' ? '提交目标' : activeMode === 'plan' ? '提交计划请求'
      : isRunning ? '实时注入纠偏指令' : '发送消息';
  const displayModel = selectedModel || models[0]?.model || 'Auto Router';
  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(projectSearch.trim().toLowerCase()),
  );

  const hasGitRepo = Boolean(gitStatus?.available);
  const branchText = hasGitRepo ? (gitStatus?.branch?.trim() || 'HEAD') : '无 Git 分支';
  const permissionLabel = permissionMode === 'read-only' ? '只读'
    : permissionMode === 'workspace-write' ? '工作区写入'
    : permissionMode === 'auto-review' ? '替我审查'
    : permissionMode === 'full-access' ? '完全访问'
    : permissionMode === 'auto-safe' ? '智能放行' : '请我批准';
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

  const openBranchPopover = (forceOpen = false) => {
    setPopover((prev) => {
      const next = !forceOpen && prev === 'branch' ? null : 'branch';
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
    if (gitError) return (
      <button type="button" className="codex-composer-pill codex-git-init-btn" title={gitError}
        aria-label={`Git 状态不可用：${gitError}，点击重试`} onClick={() => void onRefreshGitStatus?.()}>
        <IconBranch size={14} /><span>Git 状态不可用</span>
      </button>
    );
    if (!gitStatus) return null;
    if (!hasGitRepo) {
      return (
        <button
          type="button"
          className={
            inFooter
              ? 'codex-composer-pill codex-git-init-btn'
              : 'codex-tray-item codex-git-init-btn'
          }
          disabled={initGitBusy || !onInitGitRepo || permissionMode === 'read-only'}
          title={branchTitle}
          aria-label={initGitBusy ? '正在创建 Git 存储库' : '创建 Git 存储库'}
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
          aria-label={branchTitle}
          aria-expanded={popover === 'branch'}
          aria-haspopup="dialog"
          ref={branchTrigger}
          onClick={() => openBranchPopover()}
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

        <PresenceDiv open={popover === 'branch'} focusOnOpen="[data-composer-autofocus]"
            className="codex-popover codex-branch-popover"
            data-side="top"
            style={{ left: 0 }}
            role="dialog"
            aria-label="切换或创建 Git 分支"
          >
          <div className="codex-project-popover-search">
            <IconSearch size={14} style={{ flex: 'none' }} />
            <input
              data-composer-autofocus={!creatingBranch || undefined}
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
              <>
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
                {onSlashCommand && findSlashCommand('/commit') && (
                  <button
                    type="button"
                    className="codex-popover-item"
                    onClick={() => {
                      setPopover(null);
                      onSlashCommand(findSlashCommand('/commit')!);
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <IconBranch size={14} />
                      <span>Git 暂存与提交...</span>
                    </span>
                  </button>
                )}
              </>
            )}
          </div>
        </PresenceDiv>
      </div>
    );
  };

  return (
    <div className="codex-composer-wrap" data-variant={variant} data-context-tray={showHomeTray || undefined} ref={rootRef}>
      {commandError && <p className="composer-command-error" role="status">{commandError}</p>}
      {/* Slash Command Popover */}
      <PresenceDiv open={menuIsOpen} className="codex-slash-menu" elementRef={menuRef}>
        <div className="composer-picker-heading" aria-hidden="true">
          {slashQuery !== null ? '快捷命令' : '添加上下文'}
          <span className="composer-picker-keys"><kbd>↑</kbd><kbd>↓</kbd><kbd>↵</kbd><kbd>Esc</kbd></span>
        </div>
        <div id={menuId} className="composer-picker-options" role="listbox" aria-label={slashQuery !== null ? '快捷命令' : '添加上下文'}>
          {slashGroups.map(({ label, commands }) => (
            <div key={label} role="group" aria-label={label || '常用命令'} className="composer-command-group">
              {label && <div className="composer-command-label" aria-hidden="true">{label}</div>}
              {commands.map((item) => {
                const index = slashMatches.indexOf(item);
                const blocked = commandBlock(item);
                return <button key={item.cmd} id={`${menuId}-${index}`} type="button" role="option" tabIndex={-1}
                  aria-label={`${item.cmd} ${item.title ?? ''} ${blocked || item.desc}`} aria-disabled={Boolean(blocked)} aria-selected={index === selectedIndex}
                  data-selected={index === selectedIndex ? 'true' : undefined}
                  className="codex-popover-item composer-picker-row composer-command-row"
                  onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setMenuHighlight(index)}
                  onClick={() => executeSlash(item)}>
                  <item.icon size={15} aria-hidden="true" />
                  <span className="composer-command-text">
                    <strong>{item.title ?? item.cmd}</strong>
                    <small>{blocked || (item.cmd === '/effort' ? effortMeta.label : item.cmd === '/model' ? displayModel : item.desc)}</small>
                  </span>
                  {item.title && <small className="composer-command-alias" aria-hidden="true">{item.cmd}</small>}
                  {(item.opensOptions || item.popover) && <IconChevronRight size={13} aria-hidden="true" />}
                </button>;
              })}
            </div>
          ))}
          {mentionGroups.map(({ label, items }) => (
            <div key={label} role="group" aria-label={label} className="composer-command-group">
              {label !== '添加' && <div className="composer-command-label" aria-hidden="true">{label}</div>}
              {items.map((item) => {
                const index = mentionItems.indexOf(item);
                return <button key={item.id} id={`${menuId}-${index}`} type="button" role="option" tabIndex={-1}
                  aria-label={item.description ? `${item.label} ${item.description}` : item.label}
                  aria-disabled={item.disabled || undefined} aria-selected={index === selectedIndex} data-selected={index === selectedIndex ? 'true' : undefined}
                  className="codex-popover-item composer-picker-row composer-command-row"
                  onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setMenuHighlight(index)}
                  onClick={() => insertMention(item)}>
                  {item.iconUrl ? <img className="composer-plugin-icon" src={item.iconUrl} alt="" /> : <item.icon size={15} aria-hidden="true" style={item.color ? { color: item.color } : undefined} />}
                  <span className="composer-command-text"><strong title={item.label}>{item.label}</strong>{item.description && <small title={item.description}>{item.description}</small>}</span>
                  {item.action === 'files' && <IconChevronRight size={13} aria-hidden="true" />}
                </button>;
              })}
            </div>
          ))}
        </div>
        {slashQuery !== null && !slashMatches.length && <div className="composer-picker-state">没有匹配的命令。按 Esc 可继续输入正文。</div>}
        {canSearchFiles && searchMentionFiles && !workspaceResults && <div className="composer-picker-state" role="status">正在查找工作区文件…</div>}
        {canSearchFiles && workspaceResults?.failed && <div className="composer-picker-state" role="status">工作区文件搜索失败。</div>}
        {mentionToken && !mentionItems.length && (!canSearchFiles || !searchMentionFiles || workspaceResults && !workspaceResults.failed) &&
          <div className="composer-picker-state">没有匹配的{mentionToken.scope === 'file' ? '文件' : '引用'}。</div>}
      </PresenceDiv>

        {/* Workspace context controls */}
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
                ref={projectTrigger}
                aria-expanded={popover === 'project'}
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

              <PresenceDiv open={popover === 'project'} focusOnOpen="[data-composer-autofocus]"
                  className="codex-popover codex-project-popover"
                  data-side="top"
                  style={{ left: 0 }}
                >
                <div className="codex-project-popover-search">
                  <IconSearch size={14} style={{ flex: 'none' }} />
                  <input
                    data-composer-autofocus
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
              </PresenceDiv>
            </div>

            {hasGitRepo && (
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="codex-tray-item"
                  ref={envTrigger}
                  aria-expanded={popover === 'env'}
                  onClick={() => setPopover((p) => (p === 'env' ? null : 'env'))}
                >
                  <IconLaptop size={14} />
                  <span>本地</span>
                </button>

                <PresenceDiv open={popover === 'env'} className="codex-popover" data-side="top" style={{ left: 0, width: 268, padding: 10 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 6 }}>
                    Worker 隔离容器
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: '18px' }}>
                    每次写入/命令调用均在独立无网络 Docker 容器（<code>--network=none</code>、非 root、私有 tmpfs）中执行，并记录不可变退出码与 Diff 证据。
                  </div>
                </PresenceDiv>
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

        <ComposerAttachments files={files} onRemove={(name) => {
          textareaRef.current?.focus({ preventScroll: true });
          setFiles((previous) => {
            const next = { ...previous };
            delete next[name];
            return next;
          });
          setCommandError('');
        }} />

        <div className="composer-textarea-size">
          <textarea ref={heightProbe} className="composer-height-probe" rows={1}
            value={text} readOnly inert aria-hidden="true" tabIndex={-1} />
          <textarea
            ref={textareaRef}
            className="codex-composer-textarea"
            rows={1}
            aria-label="消息内容"
            placeholder={
              modeControl?.placeholder ??
              (isRunning && variant === 'thread'
                ? '运行中：输入插话可实时引导，Enter 发送…'
                : variant === 'home'
                  ? '随心输入'
                  : '输入消息')
            }
            value={text}
            aria-controls={menuIsOpen ? menuId : undefined}
            aria-activedescendant={menuIsOpen && menuCount ? `${menuId}-${selectedIndex}` : undefined}
            onChange={(event) => {
              setText(event.target.value);
              setCommandError('');
              setAddContextOpen(false);
              setCaret(event.target.selectionStart);
              setMenuDismissed(false);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              if (e.clipboardData.files?.length) {
                e.preventDefault();
                void attachFileList(e.clipboardData.files);
              }
            }}
          />
        </div>

        <div className="codex-composer-footer">
          <div className="codex-composer-controls">
            <button
              type="button"
              className="codex-icon-btn"
              aria-label="添加上下文" aria-haspopup="listbox" aria-expanded={Boolean(mentionToken)}
              title="添加文件、技能和插件（@）"
              onClick={() => {
                if (addContextOpen) {
                  setAddContextOpen(false);
                  setMenuDismissed(true);
                } else {
                  setPopover(null);
                  setMenuDismissed(false);
                  setAddContextOpen(true);
                  placeCaret(textareaRef.current?.selectionStart ?? text.length);
                }
              }}
            >
              <IconPlus size={16} />
            </button>

            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="codex-composer-pill"
                data-warning={permissionMode === 'full-access' ? 'true' : undefined}
                data-open={popover === 'permission' ? 'true' : undefined}
                ref={permissionTrigger}
                aria-expanded={popover === 'permission'}
                aria-label={permissionLabel}
                disabled={permissionPending || permissionMode === 'read-only'}
                title={permissionMode === 'read-only' ? '审查会话或只读会话不修改文件' : undefined}
                onClick={() => setPopover((p) => (p === 'permission' ? null : 'permission'))}
              >
                {permissionMode === 'full-access' ? (
                  <IconShieldAlert size={15} />
                ) : permissionMode === 'auto-review' || permissionMode === 'auto-safe' ? (
                  <IconShieldTerminal size={15} />
                ) : (
                  <IconHand size={15} />
                )}
                <span>
                  {permissionLabel}
                </span>
              </button>

              <PresenceDiv open={popover === 'permission'} className="codex-popover codex-perm-popover" data-side="top" style={{ left: 0 }}>
                <div className="codex-perm-header">
                  <span>工具操作如何审批？</span>
                  <button
                    type="button"
                    className="codex-perm-learn-link"
                    onClick={() => {
                      setPopover(null);
                      onSlashCommand?.(findSlashCommand('/settings')!);
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
                      <div className="codex-perm-option-title">请我批准</div>
                      <div className="codex-perm-option-desc">
                        修改文件或执行命令前需要批准
                      </div>
                    </div>
                  </div>
                  {permissionMode === 'approval' && <IconCheck size={15} style={{ flex: 'none', marginTop: 2 }} />}
                </button>

                <button
                  type="button"
                  className="codex-perm-option"
                  onClick={() => {
                    onChangePermission('auto-review');
                    setPopover(null);
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <IconShieldTerminal size={16} style={{ marginTop: 2, flex: 'none', color: 'var(--text-secondary)' }} />
                    <div>
                      <div className="codex-perm-option-title">替我审查</div>
                      <div className="codex-perm-option-desc">
                        自动审查低风险的只读命令；修改文件、运行脚本及其他需人工确认的操作仍会询问
                      </div>
                    </div>
                  </div>
                  {permissionMode === 'auto-review' && <IconCheck size={15} style={{ flex: 'none', marginTop: 2 }} />}
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
                        工作区内常规工具自动批准；系统权限、安全规则及外部工具审批仍有效
                      </div>
                    </div>
                  </div>
                  {permissionMode === 'full-access' && <IconCheck size={15} style={{ flex: 'none', marginTop: 2 }} />}
                </button>
              </PresenceDiv>
            </div>

            <PresenceDiv open={Boolean(modeControl)} className="composer-mode-slot">
              {modeControl && <button type="button" className="codex-composer-pill composer-mode-toggle" data-mode={activeMode}
                aria-label={`关闭${modeControl.label}模式`} aria-pressed="true" title={`退出${modeControl.label}模式`} onClick={clearMode}>
                <modeControl.icon size={16} aria-hidden="true" /><span>{modeControl.label}</span>
              </button>}
            </PresenceDiv>
            {!showHomeTray && renderBranchBadge(true)}
          </div>

          <div className="codex-composer-controls">
            <div className="codex-model-control">
              <button
                type="button"
                className="codex-composer-pill codex-model-trigger"
                data-open={popover === 'effort' || popover === 'models' ? 'true' : undefined}
                ref={modelTrigger}
                aria-label="模型与推理强度"
                aria-expanded={popover === 'effort' || popover === 'models'}
                title={`${displayModel} · ${effortMeta.label}`}
                onClick={() =>
                  setPopover((p) => (p === 'effort' || p === 'models' ? null : 'effort'))
                }
              >
                <span className="codex-composer-model-name">{displayModel}</span>
                <span className="codex-effort-label-viewport">
                  <span key={effortMeta.id} className="codex-effort-label-val">{effortMeta.label}</span>
                </span>
              </button>

              {/* Floating Blue Effort Slider Popover (1:1 with live/model_picker.png) */}
              <PresenceDiv open={popover === 'effort'}
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
              </PresenceDiv>

              {/* Drill-down Model Selector Popover with Back header */}
              <PresenceDiv open={popover === 'models'} className="codex-popover" data-side="top" style={{ right: 0, width: 256 }}>
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
                    后端尚未配置模型目录，可在「设置 → 模型与网关」查看配置指引。
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
              </PresenceDiv>
            </div>

            {isRunning && variant === 'thread' ? (
              <div className="codex-composer-running-actions">
                <button
                  type="button"
                  className="codex-toolbar-btn codex-steer-btn"
                  data-variant="primary"
                  aria-label={activeMode ? sendLabel : '插话引导'}
                  title={activeMode ? sendLabel : '实时注入插话引导 (Enter)'}
                  disabled={!text.trim() || submitting || permissionPending}
                  onClick={() => void handleSend()}
                >
                  <IconArrowUp size={13} aria-hidden="true" />
                  <span>{activeMode ? '发送' : '插话引导'}</span>
                </button>
                {onStop && (
                  <button
                    type="button"
                    className="codex-toolbar-btn codex-stop-btn"
                    data-variant="outline"
                    aria-label="停止"
                    title="停止当前任务"
                    onClick={onStop}
                  >
                    <IconStopSquare size={11} aria-hidden="true" />
                    <span>停止</span>
                  </button>
                )}
              </div>
            ) : isRunning && onStop && !text.trim() && !activeMode ? (
              <button
                type="button"
                className="codex-send-btn"
                aria-label="停止"
                title="停止当前任务"
                onClick={onStop}
              >
                <IconStopSquare size={12} />
              </button>
            ) : (
              <button
                type="button"
                className="codex-send-btn"
                aria-label={sendLabel}
                title={sendLabel}
                disabled={!text.trim() || submitting || permissionPending}
                onClick={() => void handleSend()}
              >
                <IconArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
      <PromptCacheStatus />
      <SketchDialog open={dialog === 'sketch'} onClose={closeDialog} onAttach={(image) => {
        void attachFileList([new File([image], `sketch-${Date.now()}.png`, { type: 'image/png' })]);
        closeDialog();
      }} />
      <ComposerDialog open={dialog === 'files'} title="文件和文件夹" onClose={closeDialog}>
        <button type="button" className="composer-dialog-option" onClick={() => {
          closeDialog();
          fileInputRef.current?.click();
        }}><IconPlus />从设备上传文件</button>
        <button type="button" className="composer-dialog-option" disabled={!searchMentionFiles && !mentionFiles.length}
          onClick={() => openWorkspacePicker('file')}><IconFileDoc />引用工作区文件</button>
        <button type="button" className="composer-dialog-option" disabled={!searchMentionFiles}
          onClick={() => openWorkspacePicker('folder')}><IconFolder />引用工作区文件夹</button>
      </ComposerDialog>
      <ComposerDialog open={dialog === 'review'} title="代码审查" onClose={() => { if (!reviewBusy) closeDialog(); }}>
        <label className="composer-dialog-field">审查范围
          <select className="codex-select" disabled={reviewBusy} value={reviewBranch} onChange={(event) => setReviewBranch(event.currentTarget.value)}>
            <option value="">未提交的变更</option>
            {gitStatus?.branches?.filter((branch) => branch !== gitStatus.branch).map((branch) => (
              <option key={branch} value={branch}>与 {branch} 对比</option>
            ))}
          </select>
        </label>
        <p className="composer-dialog-note">变更差异会发送给所选模型。在独立只读会话中审查，不修改工作区文件。</p>
        {reviewError && <p role="alert" className="codex-inline-error">{reviewError}</p>}
        <div className="composer-dialog-actions">
          <button type="button" className="codex-toolbar-btn" data-variant="primary" disabled={reviewBusy} onClick={() => void applyReview()}>{reviewBusy ? '正在启动…' : '开始代码审查'}</button>
        </div>
      </ComposerDialog>
    </div>
  );
};
