import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { fmtDuration } from '../utils/format';
import {
  IconArrowUpRight, IconCheck, IconChevronRight, IconCopy, IconFileDoc, IconFileEdit,
  IconActivity, IconGlobe, IconPuzzle, IconSearch, IconTerminal, IconTool,
} from './Icons';
import './activity-presentation.css';

export type ActivityStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';

export const activityStatusLabel: Record<ActivityStatus, string> = {
  running: '正在处理', waiting: '等待批准', completed: '已完成', failed: '执行失败', interrupted: '未完成',
};

type Disclosure = {
  values: ReadonlyMap<string, boolean>;
  set: (ids: string[], open: boolean) => void;
};
const DisclosureContext = createContext<Disclosure | undefined>(undefined);

/** Keep explicit disclosure choices above any rows that can move between groups. */
export function ActivityDisclosureScope({ children }: { children: ReactNode }) {
  const parent = useContext(DisclosureContext);
  const [values, setValues] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const value = useMemo<Disclosure>(() => ({ values, set: (ids, open) => {
    setValues((previous) => {
      const next = new Map(previous);
      for (const id of ids) next.set(id, open);
      return next;
    });
  } }), [values]);
  return parent ? <>{children}</> : <DisclosureContext.Provider value={value}>{children}</DisclosureContext.Provider>;
}

export const toolDisclosureId = (id: string) => `tool:${id}`;

export function useAnyExplicitActivityOpen(ids: string[]): boolean {
  const scope = useContext(DisclosureContext);
  return ids.some((id) => scope?.values.get(id) === true);
}

export function useActivityDisclosure(id: string, defaultOpen: boolean, memberIds: string[] = [], preferMembers = false) {
  const scope = useContext(DisclosureContext);
  const [local, setLocal] = useState<boolean>();
  const preferences = memberIds.map((key) => scope?.values.get(key));
  const memberOpen = preferences.includes(true) ? true : preferences.includes(false) ? false : undefined;
  const preference = scope ? scope.values.get(id) : local;
  const open = (preferMembers ? memberOpen ?? preference : preference ?? memberOpen) ?? defaultOpen;
  return [open, (next: boolean) => {
    if (scope) scope.set([id, ...memberIds], next);
    else setLocal(next);
  }] as const;
}

export function ActivityCopyButton({ text, label, onCopy }: { text: string; label: string; onCopy?: (msg: string) => void }) {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timeout.current), []);
  return (
    <button type="button" className="codex-icon-btn codex-activity-copy" title={label} aria-label={label} onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return;
      }
      setCopied(true);
      onCopy?.(label.replace(/^复制/, '已复制'));
      window.clearTimeout(timeout.current);
      timeout.current = window.setTimeout(() => setCopied(false), 1200);
    }}>
      {copied ? <IconCheck size={13} aria-hidden="true" /> : <IconCopy size={13} aria-hidden="true" />}
    </button>
  );
}

export function ActivityStatusText({ status, title, durationMs }: { status: ActivityStatus; title?: string; durationMs?: number }) {
  return <span className="codex-activity-status" data-status={status}>
    {title ?? activityStatusLabel[status]}
    {durationMs !== undefined && <span className="tabular-nums"> · {fmtDuration(durationMs) || '0秒'}</span>}
  </span>;
}

export const activityToolLabels = {
  command: { icon: IconTerminal, running: '正在运行', completed: '已运行', unit: '条命令' },
  test: { icon: IconActivity, running: '正在运行测试', completed: '已运行测试', unit: '次' },
  mcp: { icon: IconPuzzle, running: '正在调用 MCP', completed: '已调用 MCP', unit: '次' },
  read: { icon: IconFileDoc, running: '正在读取', completed: '已读取', unit: '次读取' },
  edit: { icon: IconFileEdit, running: '正在编辑', completed: '已编辑', unit: '次编辑' },
  search: { icon: IconSearch, running: '正在搜索', completed: '已搜索', unit: '次搜索' },
  web: { icon: IconGlobe, running: '正在访问', completed: '已访问', unit: '次访问' },
  tool: { icon: IconTool, running: '正在调用', completed: '已调用', unit: '次工具' },
} as const;

type ToolKind = keyof typeof activityToolLabels;
export function activityToolKind(name: string, command = ''): ToolKind {
  if (name === 'mcp' || name.startsWith('mcp__')) return 'mcp';
  if (/^(bash|shell|pty|exec_command|run_command|start_process|command|git)$/.test(name)) {
    // Only classify recognizable test invocations at the start of a shell command.
    const test = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:[:\w-]+)?|node\s+--test|(?:go|cargo|dotnet)\s+test|(?:npx\s+)?(?:pytest|vitest|jest)|python3?\s+-m\s+pytest)(?:\s|$)/;
    return test.test(command.trimStart()) ? 'test' : 'command';
  }
  if (/^(read_file|read_text_file|read_blob)$/.test(name)) return 'read';
  if (/^(write_file|edit_file|apply_patch|replace_in_file)$/.test(name)) return 'edit';
  if (/^(glob|grep|inspect_repository|list_directory|search_files|search_history)$/.test(name)) return 'search';
  if (/^(web_search|web_fetch|fetch_url|open_url)$/.test(name)) return 'web';
  return 'tool';
}

export function toolActionLabel(kind: ToolKind, status: ActivityStatus) {
  if (status === 'running' || status === 'completed') return activityToolLabels[kind][status];
  return activityStatusLabel[status];
}

export function ActivityToolRow({ id, name, kind, target, command, output, liveOutput, error, exitCode, durationMs, status,
  paths = [], meta, eventType, defaultOpen = false, onInspectFile, onCopy }: {
  id: string;
  name: string;
  kind: ToolKind;
  target: string;
  command?: string;
  output?: string;
  liveOutput?: string;
  error?: string;
  exitCode?: number;
  durationMs?: number;
  status: ActivityStatus;
  paths?: string[];
  meta?: string;
  eventType?: string;
  defaultOpen?: boolean;
  onInspectFile?: (path: string) => void;
  onCopy?: (msg: string) => void;
}) {
  const panelId = useId();
  const [open, setOpen] = useActivityDisclosure(toolDisclosureId(id), defaultOpen);
  const Icon = activityToolLabels[kind].icon;
  const displayOutput = output ?? liveOutput;
  const isShell = kind === 'command' || kind === 'test';
  const outputLabel = output === undefined && liveOutput !== undefined ? '实时工具输出' : '工具输出';
  const summary = target.replace(/\s+/g, ' ');
  return (
    <details className="codex-direct-tool codex-activity-disclosure" data-status={status} data-tool-kind={kind} data-event-type={eventType} data-scroll-anchor={`tool:${id}`} open={open}>
      <summary className="codex-direct-tool-row" aria-controls={panelId} data-scroll-disclosure title={summary} onClick={(event) => {
        event.preventDefault();
        setOpen(!open);
      }}>
        <Icon size={15} aria-hidden="true" />
        <span className="codex-direct-activity-label">{toolActionLabel(kind, status)} {summary}</span>
        <IconChevronRight className="codex-direct-chevron" size={13} aria-hidden="true" />
      </summary>
      <div id={panelId} hidden={!open} className="codex-direct-tool-detail codex-command-card">
        <div className="codex-command-header">
          <span>{meta ? `${meta} · ${name}` : name}</span>
        </div>
        {command !== undefined && <div className="codex-activity-raw-line">
          {isShell && <span className="codex-activity-shell-prompt" aria-hidden="true">$</span>}
          <code>{command}</code>
          <ActivityCopyButton label="复制命令" text={command} onCopy={onCopy} />
        </div>}
        {paths.length > 0 && <div className="codex-activity-file-links">
          {paths.map((path) => onInspectFile
            ? <button key={path} type="button" className="codex-inline-link-btn" title={path} onClick={() => onInspectFile(path)}>
                <span>{path}</span><IconArrowUpRight size={12} aria-hidden="true" />
              </button>
            : <code key={path}>{path}</code>)}
        </div>}
        {displayOutput && <pre className="codex-command-output codex-activity-output" aria-label={outputLabel} tabIndex={0}>{displayOutput}</pre>}
        {error && error !== displayOutput && <div className="codex-event-error">{error}</div>}
        <div className="codex-command-footer" data-failed={status === 'failed' || undefined}>
          {status === 'completed' && <IconCheck size={12} aria-hidden="true" />}
          <ActivityStatusText status={status} durationMs={durationMs} />
          {isShell && exitCode !== undefined && <span className="tabular-nums">· exit {exitCode}</span>}
          {displayOutput && <ActivityCopyButton label="复制输出" text={displayOutput} onCopy={onCopy} />}
        </div>
      </div>
    </details>
  );
}
