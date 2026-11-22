import { useEffect, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type { Task } from '../types/backend';
import { fmtRelative, taskTitle } from '../utils/format';
import { IconArchive, IconSearch } from './Icons';

const PAGE_SIZE = 20;

interface ArchivedChatsProps {
  client: AgentBackendClient;
  busy: ReadonlySet<string>;
  revision: number;
  onOpen: (id: string) => void;
  onRestore: (id: string) => void;
}

export function ArchivedChats({ client, busy, revision, onOpen, onRestore }: ArchivedChatsProps) {
  const [filters, setFilters] = useState({ search: '', page: 0 });
  const [retry, setRetry] = useState(0);
  const [items, setItems] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const { search, page } = filters;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    const timer = window.setTimeout(async () => {
      try {
        const result = await client.listTasks({
          archived: true,
          search: search.trim(),
          limit: PAGE_SIZE + 1,
          offset: page * PAGE_SIZE,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const archived = result.filter((task) => task.archivedAt != null);
        if (page > 0 && archived.length === 0) {
          setFilters((current) => ({ ...current, page: Math.max(0, current.page - 1) }));
          return;
        }
        setItems(archived);
        setLoading(false);
      } catch {
        if (controller.signal.aborted) return;
        setError(true);
        setLoading(false);
      }
    }, search ? 180 : 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [client, search, page, revision, retry]);

  const changePage = (next: number) => {
    setLoading(true);
    setFilters((current) => ({ ...current, page: next }));
  };

  return (
    <section className="chat-archive" aria-labelledby="chat-archive-title">
      <header className="chat-archive-header">
        <div>
          <h1 className="codex-settings-h1" id="chat-archive-title">已归档的聊天</h1>
          <p>归档会从侧栏隐藏聊天。你仍然可以查看记录或随时恢复。</p>
        </div>
        <div className="chat-archive-filter">
          <IconSearch size={16} />
          <input
            type="search"
            aria-label="按标题或工作区筛选归档"
            placeholder="筛选归档…"
            value={search}
            maxLength={200}
            onChange={(event) => {
              setLoading(true);
              setFilters({ search: event.target.value, page: 0 });
            }}
          />
        </div>
      </header>
      <div className="chat-archive-list" aria-busy={loading}>
        {loading ? (
          <div className="chat-archive-state" role="status">正在加载归档…</div>
        ) : error ? (
          <div className="chat-archive-state" role="alert">
            <p>无法加载归档，请检查连接。</p>
            <button type="button" className="codex-toolbar-btn" data-variant="outline" onClick={() => setRetry((value) => value + 1)}>重试</button>
          </div>
        ) : items.length === 0 ? (
          <div className="chat-archive-state" role="status">
            <IconArchive size={24} />
            <strong>{search.trim() ? '没有匹配的聊天' : '暂无归档'}</strong>
            <p>{search.trim() ? '试试其他标题或工作区名称。' : '可在侧栏会话菜单中归档聊天。'}</p>
          </div>
        ) : (
          <ul className="chat-archive-items">
            {items.slice(0, PAGE_SIZE).map((task) => {
              const title = taskTitle(task.input);
              return (
                <li key={task.id} className="chat-archive-row">
                  <button type="button" className="chat-archive-entry" title={title} onClick={() => onOpen(task.id)}>
                    <IconArchive size={16} />
                    <span>
                      <strong>{title}</strong>
                      <small title={task.workspaceRoot}>
                        {`归档于 ${fmtRelative(task.archivedAt ?? undefined)}`}
                        {task.workspaceRoot && ` · ${task.workspaceRoot.split(/[\\/]/).filter(Boolean).pop()}`}
                      </small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="codex-toolbar-btn"
                    data-variant="outline"
                    aria-label={`恢复聊天：${title}`}
                    disabled={busy.has(task.id)}
                    onClick={() => onRestore(task.id)}
                  >
                    {busy.has(task.id) ? '正在恢复…' : '恢复'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {!error && (page > 0 || items.length > PAGE_SIZE) && (
        <nav className="chat-archive-pagination" aria-label="归档分页">
          <button type="button" className="codex-toolbar-btn" disabled={loading || page === 0} onClick={() => changePage(page - 1)}>上一页</button>
          <span>第 {page + 1} 页</span>
          <button type="button" className="codex-toolbar-btn" disabled={loading || items.length <= PAGE_SIZE} onClick={() => changePage(page + 1)}>下一页</button>
        </nav>
      )}
    </section>
  );
}
