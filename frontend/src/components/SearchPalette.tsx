import React, { useEffect, useRef, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type { ChatHistoryMatch, Project, Task } from '../types/backend';
import { fmtRelative, taskTitle } from '../utils/format';
import {
  IconArchive, IconCircleOutline, IconCompose, IconFileDoc, IconFolder, IconSearch, IconSettingsGear,
} from './Icons';

interface SearchPaletteProps {
  open: boolean;
  projects: Project[];
  tasks: Task[];
  historyClient: AgentBackendClient;
  historyRevision: number;
  knownFiles: Array<{ path: string; taskId: string }>;
  onClose: () => void;
  onSelectTask: (taskId: string) => void;
  onSelectFile: (taskId: string, path: string) => void;
  onSelectProject: (projectId: string) => void;
  onNewChat: () => void;
  onToggleTheme: () => void;
  onOpenSettings: (section?: string) => void;
}

const categories = [
  ['all', '全部'], ['chats', '聊天'], ['text', '正文'], ['files', '文件'], ['actions', '操作'],
] as const;
type Category = typeof categories[number][0];

interface SearchEntry {
  id: string;
  group: string;
  category: Exclude<Category, 'all'>;
  title: string;
  detail: string;
  meta?: string;
  archived?: boolean;
  icon: typeof IconSearch;
  run: () => void;
}

export const SearchPalette: React.FC<SearchPaletteProps> = ({
  open, projects, tasks, historyClient, historyRevision, knownFiles, onClose, onSelectTask, onSelectFile,
  onSelectProject, onNewChat, onToggleTheme, onOpenSettings,
}) => {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('all');
  const [highlight, setHighlight] = useState(0);
  const [titleMatches, setTitleMatches] = useState<{
    query: string;
    client: AgentBackendClient;
    revision: number;
    tasks: Task[];
    failed?: boolean;
  } | null>(null);
  const [history, setHistory] = useState<{ query: string; client: AgentBackendClient; revision: number; items: ChatHistoryMatch[]; failed: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const search = query.trim();
  const showHistory = Boolean(search) && (category === 'all' || category === 'text');
  const searchTitles = Boolean(search) && (category === 'all' || category === 'chats');
  const currentHistory = history?.query === search && history.client === historyClient && history.revision === historyRevision
    ? history : null;

  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement;
    setQuery('');
    setCategory('all');
    setHighlight(0);
    setHistory(null);
    setTitleMatches(null);
    inputRef.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open || !showHistory || !historyClient.searchHistory) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const { items } = await historyClient.searchHistory!(search, 24, controller.signal);
        if (!controller.signal.aborted) {
          setHistory({ query: search, client: historyClient, revision: historyRevision, items, failed: false });
        }
      } catch {
        if (!controller.signal.aborted) {
          setHistory({ query: search, client: historyClient, revision: historyRevision, items: [], failed: true });
        }
      }
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, showHistory, search, historyClient, historyRevision]);

  useEffect(() => {
    if (!open || !searchTitles) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const context = { query: search, client: historyClient, revision: historyRevision };
      try {
        const matched = await historyClient.listTasks({ search, limit: 30, signal: controller.signal });
        if (!controller.signal.aborted) setTitleMatches({ ...context, tasks: matched });
      } catch {
        if (!controller.signal.aborted) setTitleMatches({ ...context, tasks: [], failed: true });
      }
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, searchTitles, search, historyClient, historyRevision]);

  const actions: SearchEntry[] = [
    { id: 'new', group: '操作', category: 'actions', title: '新建聊天', detail: 'Ctrl+N', icon: IconCompose, run: onNewChat },
    { id: 'archive', group: '操作', category: 'actions', title: '打开归档', detail: '查看或恢复归档聊天', icon: IconArchive, run: () => onOpenSettings('archived') },
    { id: 'theme', group: '操作', category: 'actions', title: '切换浅色 / 深色外观', detail: 'Ctrl+Shift+L', icon: IconSettingsGear, run: onToggleTheme },
    { id: 'settings', group: '操作', category: 'actions', title: '打开设置', detail: '外观、权限与账号', icon: IconSettingsGear, run: () => onOpenSettings('general') },
    { id: 'connection', group: '操作', category: 'actions', title: '配置后端连接', detail: '访问地址与身份验证', icon: IconSettingsGear, run: () => onOpenSettings('connection') },
  ];
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const currentTitleMatches = titleMatches?.query === search && titleMatches.client === historyClient && titleMatches.revision === historyRevision
    ? titleMatches : null;
  const matchedTasks = currentTitleMatches && !currentTitleMatches.failed ? currentTitleMatches.tasks : tasks.filter((task) => {
    if (task.archivedAt != null) return false;
    return !search || task.input.toLowerCase().includes(search.toLowerCase());
  });
  const chats: SearchEntry[] = matchedTasks.map((task) => ({
    id: `chat-${task.id}`, group: search ? '聊天标题' : '最近聊天', category: 'chats',
    title: taskTitle(task.input), detail: projectNames.get(task.projectId ?? '') || '', meta: fmtRelative(task.createdAt),
    archived: task.archivedAt != null, icon: task.archivedAt != null ? IconArchive : IconCircleOutline,
    run: () => onSelectTask(task.id),
  }));
  const files: SearchEntry[] = knownFiles.map((file) => ({
    id: `file-${file.taskId}-${file.path}`, group: '文件', category: 'files',
    title: file.path.split(/[\\/]/).pop() || file.path, detail: file.path, icon: IconFileDoc,
    run: () => onSelectFile(file.taskId, file.path),
  }));
  const projectEntries: SearchEntry[] = projects.map((project) => ({
    id: `project-${project.id}`, group: '项目', category: 'actions', title: project.name,
    detail: '切换工作区', icon: IconFolder, run: () => onSelectProject(project.id),
  }));
  const matches: SearchEntry[] = (currentHistory?.items ?? []).map((item) => ({
    id: `message-${item.sessionId}-${item.seq}`, group: '聊天正文', category: 'text',
    title: taskTitle(item.sessionTitle), detail: item.snippet, meta: fmtRelative(item.createdAt),
    archived: item.archivedAt != null, icon: item.archivedAt != null ? IconArchive : IconCircleOutline,
    run: () => onSelectTask(item.sessionId),
  }));
  const needle = search.toLowerCase();
  const filter = (entry: SearchEntry) => (category === 'all' || entry.category === category) && (
    !needle || `${entry.title} ${entry.detail}`.toLowerCase().includes(needle)
  );
  const matchingChats = category === 'all' || category === 'chats' ? chats : [];
  const entries = [
    ...actions.filter(filter),
    ...matchingChats.slice(0, category === 'all' ? (search ? 8 : 6) : 30),
    ...matches,
    ...files.filter(filter).slice(0, category === 'all' && !search ? 5 : 24),
    ...projectEntries.filter(filter),
  ].slice(0, 30);
  const highlighted = Math.min(highlight, entries.length - 1);

  useEffect(() => {
    const row = resultsRef.current?.querySelector('[data-highlighted="true"]');
    row?.scrollIntoView({ block: 'nearest' });
  }, [highlighted, category, search]);

  if (!open) return null;

  const run = (entry: SearchEntry) => {
    entry.run();
    onClose();
  };
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Tab') {
      const stops = modalRef.current?.querySelectorAll<HTMLElement>('input, button');
      if (!stops?.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!entries.length) return;
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight((highlighted + direction + entries.length) % entries.length);
      inputRef.current?.focus();
    } else if (event.key === 'Enter' && event.target === inputRef.current && entries[highlighted]) {
      event.preventDefault();
      run(entries[highlighted]);
    } else if (event.altKey && /^[1-9]$/.test(event.key)) {
      const entry = entries[Number(event.key) - 1];
      if (entry) {
        event.preventDefault();
        run(entry);
      }
    }
  };
  const historyStatus = showHistory && (!historyClient.searchHistory
    ? '当前连接不支持搜索聊天正文。'
    : !currentHistory ? '正在搜索聊天正文…' : currentHistory.failed ? '无法搜索聊天正文，请检查连接。' : null);
  const searchStatus = historyStatus || (searchTitles && (!currentTitleMatches
    ? '正在查找聊天…' : currentTitleMatches.failed ? '无法加载完整的聊天搜索结果。' : null));
  let previousGroup = '';

  return (
    <div className="codex-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={handleKeyDown}>
      <div className="codex-search-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="搜索与快捷操作">
        <div className="codex-search-top">
          <IconSearch size={19} />
          <input ref={inputRef} className="codex-search-input" aria-label="搜索" autoComplete="off"
            placeholder="搜索聊天、正文、文件或操作…" value={query} maxLength={200}
            onChange={(event) => { setQuery(event.target.value); setHighlight(0); }} />
          <button type="button" className="chat-search-key" aria-label="关闭搜索" onClick={onClose}>Esc</button>
        </div>
        <div className="codex-search-tabs" aria-label="搜索范围">
          {categories.map(([id, label]) => (
            <button type="button" key={id} className="codex-search-tab" aria-pressed={category === id} data-active={category === id}
              onClick={() => { setCategory(id); setHighlight(0); inputRef.current?.focus(); }}>{label}</button>
          ))}
        </div>
        <div className="codex-search-results" ref={resultsRef}>
          {entries.map((entry, index) => {
            const showGroup = entry.group !== previousGroup;
            previousGroup = entry.group;
            const Icon = entry.icon;
            return (
              <React.Fragment key={entry.id}>
                {showGroup && <div className="chat-search-group">{entry.group}</div>}
                <button type="button" className="codex-search-row" data-highlighted={index === highlighted ? 'true' : undefined}
                  onMouseEnter={() => setHighlight(index)} onFocus={() => setHighlight(index)} onClick={() => run(entry)}>
                  <span className="chat-search-icon"><Icon size={16} /></span>
                  <span className="chat-search-copy"><strong>{entry.title}</strong>{entry.detail && <small>{entry.detail}</small>}</span>
                  <span className="chat-search-meta">
                    {entry.archived && <span className="chat-search-archived">已归档</span>}
                    {entry.meta && <span>{entry.meta}</span>}
                  </span>
                </button>
              </React.Fragment>
            );
          })}
          {searchStatus && <div className="chat-search-state" data-empty={entries.length === 0} role="status">{searchStatus}</div>}
          {!searchStatus && entries.length === 0 && (
            <div className="chat-search-state" data-empty="true" role="status">
              {category === 'text' && !search ? '输入关键词搜索聊天正文。' : '没有匹配的结果。'}
            </div>
          )}
        </div>
        <footer className="chat-search-footer"><span><kbd>↑</kbd> <kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span className="chat-search-count">{entries.length} 项结果</span></footer>
      </div>
    </div>
  );
};
