import { useEffect, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type { McpServerStatus } from '../types/backend';
import { IconPuzzle, IconRefresh, IconTerminal } from './Icons';

const statuses: Record<string, { label: string; tone?: string }> = {
  connecting: { label: '连接中', tone: 'pulse' },
  ready: { label: '已就绪', tone: 'live' },
  degraded: { label: '连接异常', tone: 'warn' },
  disconnected: { label: '未连接' },
  closed: { label: '已关闭' },
};

export function McpStatusPanel({ client, sessionId, onManagePlugins }: {
  client: AgentBackendClient; sessionId?: string; onManagePlugins: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ items: McpServerStatus[] } | { error: string }>();
  const supported = Boolean(client.listMcpStatus);
  useEffect(() => {
    if (!client.listMcpStatus) return;
    const controller = new AbortController();
    setState(undefined);
    void client.listMcpStatus(sessionId, controller.signal).then(
      (items) => { if (!controller.signal.aborted) setState({ items }); },
      (error: unknown) => { if (!controller.signal.aborted) setState({ error: error instanceof Error ? error.message : '加载失败' }); },
    );
    return () => controller.abort();
  }, [client, sessionId, revision]);

  return <section className="evaluation-page" aria-label="MCP 服务状态">
    <header className="evaluation-heading">
      <div><h1><IconTerminal size={20} /> MCP 服务状态</h1><p>显示{sessionId ? '当前会话' : '默认'}工作区中由运行时发现的 MCP 服务。</p></div>
      <div className="autonomous-toolbar">
        <button type="button" className="codex-toolbar-btn" data-variant="outline" onClick={onManagePlugins}><IconPuzzle size={15} /> 管理插件</button>
        <button type="button" className="codex-toolbar-btn" data-variant="outline" disabled={!supported || !state}
          onClick={() => setRevision((value) => value + 1)}><IconRefresh size={15} /> 刷新状态</button>
      </div>
    </header>
    {!supported && <p className="evaluation-state">当前连接未提供 MCP 状态。</p>}
    {supported && !state && <p role="status" className="evaluation-state">正在加载…</p>}
    {state && 'error' in state && <p role="alert" className="evaluation-state autonomous-error">{state.error}</p>}
    {state && 'items' in state && (state.items.length ? <ul className="autonomous-list">
      {state.items.map((item) => <li key={item.server} className="codex-subagent-list-row mcp-status-row">
        <span><IconPuzzle size={15} aria-hidden="true" /> {item.server}</span>
        <span className="swarm-status"><span className="codex-status-dot" data-tone={statuses[item.status]?.tone} aria-hidden="true" />
          {statuses[item.status]?.label ?? item.status} · {item.toolCount} 个工具</span>
        {item.lastCheckedAt > 0 && <small>{new Date(item.lastCheckedAt).toLocaleString()}</small>}
      </li>)}
    </ul> : <p className="evaluation-state">此工作区暂无 MCP 连接记录。运行时发现服务后会在这里显示。</p>)}
  </section>;
}
