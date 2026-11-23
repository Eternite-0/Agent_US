import { useEffect, useId, useState, type ReactNode } from 'react';
import { reasoningHeadline, type DirectTimelineBlock, type DirectToolActivity, type DirectTurnTiming } from '../utils/directMessages';
import { IconChevronRight, IconFileDoc, IconFileEdit, IconGlobe, IconSearch, IconTerminal, IconTool } from './Icons';

const labels = {
  command: { icon: IconTerminal, active: '正在运行', done: '已运行', noun: '命令' },
  read: { icon: IconFileDoc, active: '正在读取', done: '已读取', noun: '文件' },
  edit: { icon: IconFileEdit, active: '正在编辑', done: '已编辑', noun: '文件' },
  search: { icon: IconSearch, active: '正在搜索', done: '已搜索', noun: '工作区' },
  web: { icon: IconGlobe, active: '正在访问', done: '已访问', noun: '网页' },
  tool: { icon: IconTool, active: '正在调用', done: '已调用', noun: '工具' },
} as const;

function toolKind(name: string): keyof typeof labels {
  if (/^(bash|shell|pty|exec_command|run_command)$/.test(name)) return 'command';
  if (/^(read_file|read_text_file)$/.test(name)) return 'read';
  if (/^(write_file|edit_file|apply_patch|replace_in_file)$/.test(name)) return 'edit';
  if (/^(glob|grep|inspect_repository|list_directory|search_files)$/.test(name)) return 'search';
  if (/^(web_search|web_fetch|fetch_url|open_url)$/.test(name)) return 'web';
  return 'tool';
}

function toolTarget(row: DirectToolActivity): string {
  let args = row.args;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = undefined; }
  }
  if (args && typeof args === 'object') {
    for (const key of ['command', 'path', 'query', 'pattern', 'url', 'filePath']) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    if (Array.isArray(args.argv)) return args.argv.map(String).join(' ');
  }
  return row.name;
}

function ToolRow({ row }: { row: DirectToolActivity }) {
  const { icon: Icon, active, done } = labels[toolKind(row.name)];
  const target = toolTarget(row);
  const label = row.status === 'running' ? active : row.status === 'completed' ? done
    : row.status === 'waiting' ? '等待批准' : row.status === 'failed' ? '执行失败' : '未完成';
  const heading = (
    <>
      <Icon size={15} aria-hidden="true" />
      <span className="codex-direct-activity-label">{label} {target.replace(/\s+/g, ' ')}</span>
    </>
  );
  const output = row.output || row.liveOutput;
  if (!output && target === row.name) {
    return <div className="codex-direct-tool-row" data-status={row.status}>{heading}</div>;
  }
  return (
    <details className="codex-direct-tool" data-status={row.status}>
      <summary className="codex-direct-tool-row">
        {heading}
        <IconChevronRight className="codex-direct-chevron" size={13} aria-hidden="true" />
      </summary>
      <div className="codex-direct-tool-detail">
        <code>{target}</code>
        {output && <pre className="a2a-tool-output" aria-label={row.liveOutput ? '实时工具输出' : '工具输出'}>{output}</pre>}
      </div>
    </details>
  );
}

export function DirectActivityGroup({ block }: { block: Extract<DirectTimelineBlock, { kind: 'activity' }> }) {
  const tools = block.items.filter((item) => item.kind === 'tool');
  const reasoning = block.items.findLast((item) => item.kind === 'reasoning');
  const running = Boolean(reasoning?.live || tools.some((row) => row.status === 'running') || block.waiting);
  const headline = reasoning ? reasoningHeadline(reasoning.text) : '';
  const current = tools.findLast((row) => row.status === 'running' || row.status === 'waiting');
  const failed = tools.filter((row) => row.status === 'failed').length;
  const interrupted = tools.filter((row) => row.status === 'interrupted').length;
  const counts = new Map<keyof typeof labels, number>();
  for (const row of tools) {
    const kind = toolKind(row.name);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const summary = [...counts].map(([kind, count]) => `${labels[kind].done} ${count} ${kind === 'read' || kind === 'edit' ? '个' : '次'}${labels[kind].noun}`).join(' · ');
  const currentLabel = current && `${current.status === 'waiting' ? '等待批准' : labels[toolKind(current.name)].active} ${toolTarget(current).replace(/\s+/g, ' ')}`;
  const title = reasoning?.live ? (headline || '正在思考…') : currentLabel || headline || summary || '正在思考…';
  const Icon = tools.length ? labels[toolKind(current?.name ?? tools[0].name)].icon : undefined;
  const heading = (
    <>
      {!headline && Icon && <Icon size={15} aria-hidden="true" />}
      <span className="codex-direct-activity-label">{title}</span>
      {(failed > 0 || interrupted > 0) && <span className="codex-direct-issue">{failed > 0 ? `${failed} 项失败` : `${interrupted} 项未完成`}</span>}
    </>
  );
  if (!tools.length) {
    return <div className="codex-direct-activity-row" data-running={running}>{heading}</div>;
  }
  return (
    <details className="codex-direct-activity" data-running={running}>
      <summary className="codex-direct-activity-row">
        {heading}
        <IconChevronRight className="codex-direct-chevron" size={14} aria-hidden="true" />
      </summary>
      <div className="codex-direct-tools">
        {tools.map((row) => <ToolRow key={row.id} row={row} />)}
      </div>
    </details>
  );
}

function shortDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return [hours && `${hours}h`, minutes && `${minutes}m`, `${seconds % 60}s`].filter(Boolean).join(' ');
}

export function DirectTurnProcess({ active, timing, children }: {
  active?: boolean;
  timing?: DirectTurnTiming;
  children?: ReactNode;
}) {
  const [now, setNow] = useState(Date.now);
  const [expanded, setExpanded] = useState<boolean>();
  const processId = useId();
  const startedAt = timing?.startedAt;
  useEffect(() => {
    if (!active || startedAt === undefined) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active, startedAt]);
  const duration = active && startedAt !== undefined ? Math.max(0, now - startedAt) : timing?.durationMs;
  const label = active ? '正在处理' : timing?.end === 'turn/cancelled' ? '已停止'
    : timing?.end === 'turn/failed' ? '处理失败' : timing?.end === 'turn/parked' ? '已暂停'
      : duration !== undefined ? '已处理' : '处理过程';
  const open = expanded ?? Boolean(active);
  const title = <>{label}{duration !== undefined && ` ${shortDuration(duration)}`}</>;
  return (
    <>
      {(active || children || timing?.end) && (
        <div className="codex-direct-status">
          {children ? (
            <button type="button" aria-expanded={open} aria-controls={processId} onClick={() => setExpanded(!open)}>
              {title}<IconChevronRight className="codex-direct-chevron" size={14} aria-hidden="true" />
            </button>
          ) : title}
        </div>
      )}
      <div id={processId} className="codex-direct-process" hidden={!open || !children}>{children}</div>
    </>
  );
}
