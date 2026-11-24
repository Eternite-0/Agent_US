import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { directToolOutput, reasoningHeadline, type DirectTimelineBlock, type DirectToolActivity, type DirectTurnTiming } from '../utils/directMessages';
import {
  ActivityDisclosureScope, ActivityStatusText, ActivityToolRow, activityToolKind, activityToolLabels,
  toolActionLabel, toolDisclosureId, useActivityDisclosure, useAnyExplicitActivityOpen, type ActivityStatus,
} from './ActivityPresentation';
import { AnimatedDetails, Collapsible } from './Collapsible';
import { IconChevronRight, IconSparkle } from './Icons';

export { ActivityDisclosureScope } from './ActivityPresentation';

const phaseDisclosureId = (id: string) => `phase:${id}`;
const phaseMemberDisclosureId = (id: string) => `phase-member:${id}`;

function presentTool(row: DirectToolActivity) {
  const kind = activityToolKind(row.name);
  let args = row.args;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = undefined; }
  }
  const fields = args && typeof args === 'object' ? args : {};
  const field = (key: string) => {
    const value = fields[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
  };
  const paths = new Set<string>();
  if (kind === 'read' || kind === 'edit') {
    const path = field('path') ?? field('filePath');
    if (path) paths.add(path);
    if (Array.isArray(fields.paths)) {
      for (const entry of fields.paths) if (typeof entry === 'string' && entry.trim()) paths.add(entry);
    }
    if (row.name === 'apply_patch') {
      for (const match of (field('patch') ?? '').matchAll(/^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gm)) {
        if (match[1].trim()) paths.add(match[1].trim());
      }
    }
  }
  const command = kind === 'command' ? field('command') ?? field('cmd') ?? field('script') : undefined;
  const classifiedKind = command ? activityToolKind(row.name, command) : kind;
  const target = command ?? [...paths][0] ?? field('query') ?? field('pattern') ?? field('url') ?? row.name;
  return { kind: classifiedKind, command, target, paths: [...paths] };
}

export function DirectActivityGroup({ block, onInspectFile, onCopy }: {
  block: Extract<DirectTimelineBlock, { kind: 'activity' }>;
  onInspectFile?: (path: string) => void;
  onCopy?: (msg: string) => void;
}) {
  const panelId = useId();
  const tools = block.items.filter((item) => item.kind === 'tool');
  const reasoning = block.items.findLast((item) => item.kind === 'reasoning');
  const current = tools.findLast((row) => row.status === 'waiting') ?? tools.findLast((row) => row.status === 'running');
  const failed = tools.filter((row) => row.status === 'failed').length;
  const interrupted = tools.filter((row) => row.status === 'interrupted').length;
  const status: ActivityStatus = current?.status ?? (reasoning?.live || block.waiting ? 'running'
    : failed ? 'failed' : interrupted ? 'interrupted' : 'completed');
  const [open, setOpen] = useActivityDisclosure(phaseDisclosureId(block.id), status === 'failed', tools.map((row) => phaseMemberDisclosureId(row.id)), true);
  const counts = new Map<keyof typeof activityToolLabels, number>();
  for (const row of tools) {
    if (row.status !== 'completed') continue;
    const { kind } = presentTool(row);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const summary = [...counts].map(([kind, count]) => `${activityToolLabels[kind].completed} ${count} ${activityToolLabels[kind].unit}`).join(' · ');
  const headline = reasoning ? reasoningHeadline(reasoning.text) : '';
  const currentTool = current && presentTool(current);
  const currentLabel = current && currentTool && `${toolActionLabel(currentTool.kind, current.status)} ${currentTool.target.replace(/\s+/g, ' ')}`;
  const label = (reasoning?.live && headline) || currentLabel || summary || headline || (status === 'running' ? '正在思考…' : undefined);
  const Icon = tools.length ? activityToolLabels[currentTool?.kind ?? presentTool(tools[0]).kind].icon : IconSparkle;
  const heading = <>
    <Icon size={15} aria-hidden="true" />
    <span className="codex-direct-activity-label" title={label}><ActivityStatusText status={status} title={label} /></span>
    {failed > 0 && <span className="codex-direct-issue">{failed} 项失败</span>}
    {interrupted > 0 && <span className="codex-direct-issue" data-status="interrupted">{interrupted} 项未完成</span>}
  </>;
  if (!tools.length) {
    return <div className="codex-direct-activity-row" data-status={status} data-running={status === 'running'}>{heading}</div>;
  }
  return (
    <AnimatedDetails className="codex-direct-activity codex-activity-disclosure" data-status={status} data-running={status === 'running'} open={open} panelId={panelId} summary={
      <summary className="codex-direct-activity-row" aria-expanded={open} aria-controls={panelId} data-scroll-disclosure onClick={(event) => {
        event.preventDefault();
        setOpen(!open);
      }}>
        {heading}<IconChevronRight className="codex-direct-chevron" size={14} aria-hidden="true" />
      </summary>
    }>
      <div className="codex-direct-tools">
        {tools.map((row) => <ActivityToolRow key={row.id} id={row.id} name={row.name} {...presentTool(row)}
          status={row.status} {...directToolOutput(row)} liveOutput={row.liveOutput} durationMs={row.durationMs}
          defaultOpen={row.status === 'failed'} onInspectFile={onInspectFile} onCopy={onCopy} />)}
      </div>
    </AnimatedDetails>
  );
}

interface DirectTurnProcessProps {
  activityId?: string;
  active?: boolean;
  timing?: DirectTurnTiming;
  children?: ReactNode;
  blocks?: readonly DirectTimelineBlock[];
  finalBlockId?: string;
  renderBlock?: (block: DirectTimelineBlock) => ReactNode;
}

export function DirectTurnProcess(props: DirectTurnProcessProps) {
  return <ActivityDisclosureScope key={props.activityId}><DirectProcessPanel {...props} /></ActivityDisclosureScope>;
}

function DirectProcessPanel({ activityId, active, timing, children, blocks, finalBlockId, renderBlock }: DirectTurnProcessProps) {
  const [now, setNow] = useState(Date.now);
  const wasRunning = useRef(false);
  useEffect(() => { if (active) wasRunning.current = true; }, [active]);
  const processId = useId();
  const hasOpenChild = useAnyExplicitActivityOpen((blocks ?? []).flatMap((block) => {
    if (block.kind !== 'activity') return [];
    const tools = block.items.filter((item) => item.kind === 'tool');
    if (!tools.length) return [];
    return [phaseDisclosureId(block.id), ...tools.flatMap(({ id }) => [phaseMemberDisclosureId(id), toolDisclosureId(id)])];
  }));
  // Do not collapse content out from under the reader on completion. History
  // still starts compact; a user-selected open/closed state always wins.
  const [open, setOpen] = useActivityDisclosure(`process:${activityId ?? processId}`, Boolean(active) || wasRunning.current || hasOpenChild);
  const startedAt = timing?.startedAt;
  useEffect(() => {
    if (!active || startedAt === undefined) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active, startedAt]);
  const duration = active && startedAt !== undefined ? Math.max(0, now - startedAt) : timing?.durationMs;
  const waiting = active && blocks?.some((block) => block.kind === 'activity' && block.items.some((item) => item.kind === 'tool' && item.status === 'waiting'));
  const status = waiting ? 'waiting' : active ? 'running' : timing?.end === 'turn/failed' ? 'failed'
    : timing?.end === 'turn/parked' || timing?.end === 'turn/cancelled' ? 'interrupted' : 'completed';
  const label = timing?.end === 'turn/cancelled' ? '已停止' : timing?.end === 'turn/parked' ? '已暂停'
    : !active && !timing?.end ? '处理过程' : undefined;
  const title = <ActivityStatusText status={status} title={label} durationMs={duration} />;
  const hasProcess = blocks ? blocks.some((block) => block.id !== finalBlockId) : Boolean(children);
  return (
    <>
      {(active || hasProcess || timing?.end) && (
        <div className="codex-direct-status" data-status={status} data-settled={wasRunning.current && !active && !!timing?.end || undefined}>
          {hasProcess ? (
            <button className="codex-activity-disclosure" type="button" aria-expanded={open} aria-controls={processId} data-scroll-disclosure onClick={() => setOpen(!open)}>
              {title}<IconChevronRight className="codex-direct-chevron" size={14} aria-hidden="true" />
            </button>
          ) : title}
        </div>
      )}
      <div id={processId} className="codex-direct-process">
        {blocks ? blocks.map((block) => (
          <Collapsible key={block.id} anchor={block.id} open={open || block.id === finalBlockId} keepMounted>
            {renderBlock?.(block)}
          </Collapsible>
        )) : <Collapsible open={open && hasProcess} keepMounted>{children}</Collapsible>}
      </div>
    </>
  );
}
