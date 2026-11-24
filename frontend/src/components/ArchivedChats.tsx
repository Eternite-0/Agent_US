import { useEffect, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type { Task } from '../types/backend';
import { fmtRelative, taskTitle } from '../utils/format';
import { IconArchive, IconSearch } from './Icons';
import './archived-chats.css';

const PAGE_SIZE = 20;

interface ArchivedChatsProps {
  client: AgentBackendClient;
  busy: ReadonlySet<string>;
  deleting: ReadonlySet<string>;
  /** Confirmed removals for this client, not pending mutations. */
  removedTaskIds?: ReadonlySet<string>;
  revision: number;
  onOpen: (id: string) => void;
  onRestore: (id: string) => void;
  onDelete?: (task: Task) => void;
}

interface ArchivePage {
  client: AgentBackendClient;
  search: string;
  page: number;
  items: Task[];
}

export function ArchivedChats({ client, busy, deleting, removedTaskIds, revision, onOpen, onRestore, onDelete }: ArchivedChatsProps) {
  const [filters, setFilters] = useState({ search: '', page: 0 });
  const [retry, setRetry] = useState(0);
  const [snapshot, setSnapshot] = useState<ArchivePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const { search, page } = filters;
  // Keep the current page mounted on refresh, but never show rows from other filters or connections.
  const cachedItems = snapshot?.client === client && snapshot.search === search && snapshot.page === page
    ? snapshot.items : [];
  const items = cachedItems.slice(0, PAGE_SIZE).filter((task) => !removedTaskIds?.has(task.id));
  const hasNextPage = cachedItems.length > PAGE_SIZE;

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
        setSnapshot({ client, search, page, items: archived });
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
      <header className="chat-archive-header codex-library-detail-enter">
        <div className="codex-library-heading">
          <h1 id="chat-archive-title">已归档的聊天</h1>
          <p>归档会从侧栏隐藏聊天。你仍然可以查看记录或随时恢复。</p>
        </div>
        <label className="codex-library-search">
          <IconSearch size={16} />
          <input
            type="search"
            aria-label="按标题或工作区筛选归档"
            placeholder="搜索已归档的聊天"
            value={search}
            maxLength={200}
            onChange={(event) => {
              setLoading(true);
              setFilters({ search: event.target.value, page: 0 });
            }}
          />
        </label>
      </header>
      <div className="chat-archive-list" aria-busy={loading}>
        {items.length > 0 && (
          <ul className="chat-archive-items">
            {items.map((task) => {
              const title = taskTitle(task.input);
              const isRestoring = busy.has(task.id);
              const isDeleting = deleting.has(task.id);
              const isBusy = isRestoring || isDeleting;
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
                  <div className="chat-archive-actions">
                    <button
                      type="button"
                      className="codex-toolbar-btn"
                      data-variant="outline"
                      aria-label={`恢复聊天：${title}`}
                      aria-busy={isRestoring}
                      disabled={isBusy}
                      onClick={() => onRestore(task.id)}
                    >
                      {isRestoring ? '正在恢复…' : '恢复'}
                    </button>
                    {onDelete && (
                      <button
                        type="button"
                        className="codex-toolbar-btn chat-archive-delete"
                        aria-label={`删除聊天：${title}`}
                        aria-busy={isDeleting}
                        disabled={isBusy}
                        onClick={() => onDelete(task)}
                      >
                        {isDeleting ? '正在删除…' : '删除'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {!loading && error ? (
          <div className={items.length > 0 ? 'chat-archive-refresh-error' : 'chat-archive-state'}>
            <p role="alert">{items.length > 0 ? '无法刷新归档，仍显示上次加载的记录。' : '无法加载归档，请检查连接。'}</p>
            <button type="button" className="codex-toolbar-btn" data-variant="outline" onClick={() => setRetry((value) => value + 1)}>重试</button>
          </div>
        ) : items.length === 0 && (
          loading ? (
            <div className="chat-archive-state" role="status">正在加载归档…</div>
          ) : (
            <div className="chat-archive-state" role="status">
              <IconArchive size={24} />
              <strong>{search.trim() ? '没有匹配的聊天' : '暂无归档'}</strong>
              <p>{search.trim() ? '试试其他标题或工作区名称。' : '可在侧栏会话菜单中归档聊天。'}</p>
            </div>
          )
        )}
      </div>
      {(page > 0 || hasNextPage) && (
        <nav className="chat-archive-pagination" aria-label="归档分页">
          <button type="button" className="codex-toolbar-btn" disabled={loading || page === 0} onClick={() => changePage(page - 1)}>上一页</button>
          <span>第 {page + 1} 页</span>
          <button type="button" className="codex-toolbar-btn" disabled={loading || !hasNextPage} onClick={() => changePage(page + 1)}>下一页</button>
        </nav>
      )}
    </section>
  );
}
