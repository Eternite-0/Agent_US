import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Task } from '../types/backend';
import { fmtRelative, taskTitle } from '../utils/format';
import {
  IconCircleOutline,
  IconCompose,
  IconFileDoc,
  IconFolder,
  IconSettingsGear,
} from './Icons';

interface SearchPaletteProps {
  open: boolean;
  projects: Project[];
  tasks: Task[];
  knownFiles: Array<{ path: string; taskId: string }>;
  onClose: () => void;
  onSelectTask: (taskId: string) => void;
  onSelectFile: (taskId: string, path: string) => void;
  onSelectProject: (projectId: string) => void;
  onNewChat: () => void;
  onToggleTheme: () => void;
  onOpenSettings: (section?: string) => void;
}

type Category = 'all' | 'actions' | 'chats' | 'files' | 'text';

interface SearchEntry {
  id: string;
  group: string;
  category: Exclude<Category, 'all'>;
  title: string;
  snippet: string;
  rightMeta?: string;
  run: () => void;
}

export const SearchPalette: React.FC<SearchPaletteProps> = ({
  open,
  projects,
  tasks,
  knownFiles,
  onClose,
  onSelectTask,
  onSelectFile,
  onSelectProject,
  onNewChat,
  onToggleTheme,
  onOpenSettings,
}) => {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('all');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCategory('all');
      setHighlight(0);
      window.setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const projectNameById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects],
  );

  const entries = useMemo<SearchEntry[]>(() => {
    const actions: SearchEntry[] = [
      {
        id: 'act-new',
        group: '操作',
        category: 'actions',
        title: '新建聊天 / 发起任务',
        snippet: 'Ctrl+N · 返回主工作区发起新任务',
        rightMeta: '操作',
        run: () => onNewChat(),
      },
      {
        id: 'act-theme',
        group: '操作',
        category: 'actions',
        title: '切换浅色 / 深色外观',
        snippet: 'Ctrl+Shift+L · 切换主题',
        rightMeta: '外观',
        run: () => onToggleTheme(),
      },
      {
        id: 'act-settings',
        group: '操作',
        category: 'actions',
        title: '打开设置',
        snippet: 'Ctrl+, · 外观、连接、审批策略与记忆',
        rightMeta: '设置',
        run: () => onOpenSettings('general'),
      },
      {
        id: 'act-conn',
        group: '操作',
        category: 'actions',
        title: '配置后端连接与 BACKEND_TOKEN',
        snippet: '实时对接 D:\\Agent_US\\backend (127.0.0.1:8787)',
        rightMeta: '连接',
        run: () => onOpenSettings('connection'),
      },
    ];

    const chatEntries: SearchEntry[] = tasks.map((t) => ({
      id: `task-${t.id}`,
      group: '聊天',
      category: 'chats',
      title: taskTitle(t.input),
      snippet: t.verdict?.reason || t.input,
      rightMeta: (t.projectId && projectNameById.get(t.projectId)) || fmtRelative(t.createdAt),
      run: () => onSelectTask(t.id),
    }));

    const fileEntries: SearchEntry[] = knownFiles.map((f) => ({
      id: `file-${f.taskId}-${f.path}`,
      group: '文件',
      category: 'files',
      title: f.path.split('/').pop() || f.path,
      snippet: f.path,
      rightMeta: '文件',
      run: () => onSelectFile(f.taskId, f.path),
    }));

    const projectEntries: SearchEntry[] = projects.map((p) => ({
      id: `proj-${p.id}`,
      group: '项目',
      category: 'actions',
      title: p.name,
      snippet: '切换到此项目并开始构建',
      rightMeta: '项目',
      run: () => onSelectProject(p.id),
    }));

    const all = [...chatEntries, ...fileEntries, ...projectEntries, ...actions];
    const needle = query.trim().toLowerCase();

    return all.filter((item) => {
      if (category === 'text') {
        if (!needle) return item.category === 'chats';
        return item.snippet.toLowerCase().includes(needle) || item.title.toLowerCase().includes(needle);
      }
      if (category !== 'all' && item.category !== category) return false;
      if (!needle) return true;
      return (
        item.title.toLowerCase().includes(needle) ||
        item.snippet.toLowerCase().includes(needle) ||
        (item.rightMeta || '').toLowerCase().includes(needle)
      );
    });
  }, [
    projects,
    tasks,
    knownFiles,
    projectNameById,
    query,
    category,
    onNewChat,
    onToggleTheme,
    onOpenSettings,
    onSelectTask,
    onSelectFile,
    onSelectProject,
  ]);

  useEffect(() => {
    setHighlight(0);
  }, [query, category]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (entries.length ? (h + 1) % entries.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (entries.length ? (h - 1 + entries.length) % entries.length : 0));
    } else if (e.key === 'Enter' && entries[highlight]) {
      e.preventDefault();
      entries[highlight].run();
      onClose();
    } else if (e.altKey && /^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      if (entries[idx]) {
        e.preventDefault();
        entries[idx].run();
        onClose();
      }
    }
  };

  // Group entries while keeping flat index for Alt+N & highlight
  let lastGroup = '';

  return (
    <div
      className="codex-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="codex-search-modal" role="dialog" aria-label="命令面板">
        {/* Exact frameless top input matching live/s1.png */}
        <div className="codex-search-top">
          <input
            ref={inputRef}
            className="codex-search-input"
            placeholder="搜索聊天、文件、文本或快捷操作…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="codex-search-results">
          {entries.length === 0 ? (
            <div
              style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-tertiary)',
                fontSize: 14,
              }}
            >
              无匹配项
            </div>
          ) : (
            entries.slice(0, 30).map((entry, idx) => {
              const showGroupHeader = entry.group !== lastGroup;
              lastGroup = entry.group;
              return (
                <React.Fragment key={entry.id}>
                  {showGroupHeader && (
                    <div
                      style={{
                        padding: '6px 10px 4px',
                        fontSize: 12,
                        fontWeight: 500,
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      {entry.group}
                    </div>
                  )}
                  <button
                    type="button"
                    className="codex-search-row"
                    data-highlighted={idx === highlight ? 'true' : undefined}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => {
                      entry.run();
                      onClose();
                    }}
                  >
                    <span style={{ color: 'var(--text-tertiary)', display: 'inline-flex', flex: 'none' }}>
                      {entry.group === '项目' ? (
                        <IconFolder size={15} />
                      ) : entry.category === 'files' ? (
                        <IconFileDoc size={15} />
                      ) : entry.category === 'actions' ? (
                        entry.id === 'act-settings' ? (
                          <IconSettingsGear size={15} />
                        ) : (
                          <IconCompose size={15} />
                        )
                      ) : (
                        <IconCircleOutline size={15} />
                      )}
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          display: 'block',
                          fontSize: 13.5,
                          color: 'var(--text-default)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {entry.title}
                      </span>
                      <span
                        style={{
                          display: 'block',
                          fontSize: 12,
                          color: 'var(--text-tertiary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {entry.snippet}
                      </span>
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
                      {entry.rightMeta && (
                        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                          {entry.rightMeta}
                        </span>
                      )}
                      {idx < 9 && <span className="codex-alt-chip">Alt+{idx + 1}</span>}
                    </span>
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>

        {/* Exact 5 Codex filter pills matching live/s1.png */}
        <div className="codex-search-tabs">
          {(
            [
              ['all', '全部'],
              ['actions', '操作'],
              ['chats', '聊天'],
              ['files', '文件'],
              ['text', '文本'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="codex-search-tab"
              data-active={category === id ? 'true' : undefined}
              onClick={() => setCategory(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
