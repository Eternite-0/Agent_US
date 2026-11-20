import React from 'react';
import type { EventEnvelope, Worker } from '../types/backend';
import {
  normalizeFilePath,
  sortEventsChronologically,
  type UnifiedActivityItem,
} from '../utils/activity';
import { fmtDuration } from '../utils/format';
import {
  getWorkerActivityLabel,
  getWorkerDisplayName,
  resolveWorkerForPayload,
  resolveWorkerIdFromPayload,
} from '../utils/worker';
import {
  IconAgent,
  IconArrowUpRight,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconCopy,
  IconFileDoc,
  IconFileEdit,
  IconShieldAlert,
  IconSparkle,
  IconTerminal,
  IconTool,
} from './Icons';

export interface ActivityEventRowProps {
  event: EventEnvelope;
  worker?: Worker;
  defaultOpen?: boolean;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function eventPayload(event: EventEnvelope): Record<string, unknown> {
  return event.payload ?? {};
}

function shortCommand(payload: Record<string, unknown>): string {
  const argv = Array.isArray(payload.argv) ? payload.argv.map(String).join(' ') : '';
  return text(payload.command) || text(payload.cmd) || argv || text(payload.arguments) || text(payload.name) || '运行命令';
}

function conciseMessagePreview(raw: string, maxLen = 120): string {
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function eventTitle(event: EventEnvelope, payload: Record<string, unknown>): string {
  switch (event.type) {
    case 'tool.requested':
    case 'tool.started':
    case 'command.started':
      return text(payload.summary) || (text(payload.name) === 'shell' ? '运行命令' : `调用 ${text(payload.name, '工具')}`);
    case 'tool.completed':
    case 'command.completed':
      return payload.isError || payload.status === 'failed' || (typeof payload.exitCode === 'number' && payload.exitCode !== 0)
        ? '命令执行失败'
        : '命令已完成';
    case 'message.started':
    case 'agent.started':
      return 'Agent 开始处理';
    case 'message.completed':
    case 'agent.message':
      return text(payload.summary) || '已生成回复';
    case 'file.read':
      return '读取文件';
    case 'file.write':
    case 'file.patch':
      return '编辑文件';
    case 'approval.requested':
    case 'approval.required':
    case 'node.awaiting_approval':
      return '等待审批';
    case 'approval.decided':
    case 'approval.resolved':
      return payload.decision === 'allow' || payload.decision === 'approve' ? '已批准操作' : '已拒绝操作';
    case 'turn.completed':
    case 'node.succeeded':
    case 'worker.completed':
      return payload.status === 'failed' || payload.status === 'cancelled' ? '处理失败' : '处理完成';
    case 'turn.failed':
    case 'node.failed':
    case 'plan.failed':
      return '处理失败';
    default:
      return text(payload.summary) || event.type.replaceAll('.', ' ');
  }
}

function eventKind(event: EventEnvelope, payload: Record<string, unknown>): 'running' | 'success' | 'danger' | 'approval' | 'neutral' {
  if (event.type === 'approval.decided' || event.type === 'approval.resolved') {
    return payload.decision === 'allow' || payload.decision === 'approve' ? 'success' : 'danger';
  }
  if (event.type.includes('approval') || event.type.includes('awaiting_approval')) return 'approval';
  if (
    event.type.includes('failed')
    || event.type.includes('error')
    || payload.isError
    || payload.status === 'failed'
    || (typeof payload.exitCode === 'number' && payload.exitCode !== 0)
  ) {
    return 'danger';
  }
  if (event.type.endsWith('.completed') || event.type.endsWith('.succeeded') || event.type === 'node.acceptance') return 'success';
  if (event.type.endsWith('.started') || event.type.endsWith('.requested') || event.type.endsWith('.queued')) return 'running';
  return 'neutral';
}

function elapsed(payload: Record<string, unknown>): string | null {
  const duration = Number(payload.durationMs ?? payload.elapsedMs ?? 0);
  if (Number.isFinite(duration) && duration > 0) return `${(duration / 1000).toFixed(duration >= 10000 ? 0 : 1)}s`;
  return null;
}

function summary(event: EventEnvelope, payload: Record<string, unknown>, worker?: Worker): string {
  const path = text(payload.path) || text(payload.filePath);
  if (path) return path;
  if (event.type === 'command.started' || event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'command.completed') {
    return shortCommand(payload);
  }
  // Never dump full final assistant prose into ActivityEventRow
  if (event.type === 'message.completed' || event.type === 'agent.message') {
    return conciseMessagePreview(text(payload.summary) || '');
  }
  if (event.type.includes('approval')) return text(payload.tool) || text(payload.reason) || '需要人工确认';
  if (event.type.startsWith('node.') || event.type.startsWith('worker.')) {
    return getWorkerActivityLabel(worker, payload) || text(payload.objective) || text(payload.nodeId);
  }
  return text(payload.message) || text(payload.reason) || getWorkerActivityLabel(worker, payload);
}

/**
 * Legacy-compatible single-event row. Never outputs full assistant reply bodies.
 */
export const ActivityEventRow: React.FC<ActivityEventRowProps> = ({ event, worker, defaultOpen = false }) => {
  const payload = eventPayload(event);
  const kind = eventKind(event, payload);
  const [open, setOpen] = React.useState(defaultOpen || kind === 'danger' || kind === 'approval');
  const name = getWorkerDisplayName(worker, { payload });
  const detail = summary(event, payload, worker);
  const duration = elapsed(payload);
  const isCommand = event.type.includes('tool') || event.type.includes('command');
  const isFile = event.type.startsWith('file.') || (event.type === 'tool.completed' && Boolean(payload.path || payload.filePath));
  const isMessage = event.type.includes('message') || event.type.startsWith('agent.');
  const isApproval = kind === 'approval';
  const Icon = isApproval ? IconShieldAlert : isCommand ? IconTerminal : isFile ? IconFileEdit : isMessage ? IconAgent : kind === 'success' ? IconCheck : IconSparkle;
  const title = eventTitle(event, payload);

  return (
    <div className="codex-event-row" data-kind={kind} data-event-type={event.type}>
      <button type="button" className="codex-event-row-main" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="codex-event-row-icon"><Icon size={14} /></span>
        <span className="codex-event-row-copy">
          <span className="codex-event-row-title">{title}</span>
          <span className="codex-event-row-summary">{name}{detail ? ` · ${detail}` : ''}</span>
        </span>
        {duration && <span className="codex-event-row-duration tabular-nums">{duration}</span>}
        <IconChevronDown size={13} className="codex-event-row-chevron" />
      </button>
      {open && (
        <div className="codex-event-row-detail">
          {isCommand && <code className="codex-event-command">$ {shortCommand(payload)}</code>}
          {detail && !isCommand && !isMessage && <div className="codex-event-detail-text">{detail}</div>}
          {Boolean(payload.error || payload.message) && kind === 'danger' && (
            <div className="codex-event-error">{text(payload.error) || text(payload.message)}</div>
          )}
          {isFile && (payload.added !== undefined || payload.deleted !== undefined) && (
            <div className="codex-event-diff">+{Number(payload.added ?? 0)} <span>−{Number(payload.deleted ?? 0)}</span></div>
          )}
          <div className="codex-event-meta">
            {event.type} · {new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
        </div>
      )}
    </div>
  );
};

/* ============================================================================
 * Unified Converged Activity Rows (Command / File / Approval / Error)
 * ========================================================================== */

interface ConvergedCommandRowProps {
  item: Extract<UnifiedActivityItem, { kind: 'command' }>;
  defaultOpen?: boolean;
  onInspectFile?: (path: string) => void;
  onCopy?: (msg: string) => void;
}

export const ConvergedCommandRow: React.FC<ConvergedCommandRowProps> = ({
  item,
  defaultOpen = false,
  onInspectFile,
  onCopy,
}) => {
  const [open, setOpen] = React.useState(defaultOpen || item.status === 'failed');
  const [copied, setCopied] = React.useState(false);

  const kind = item.status === 'failed' ? 'danger' : item.status === 'running' ? 'running' : 'success';
  const statusLabel = item.status === 'running'
    ? '运行中'
    : item.status === 'failed'
      ? `失败${typeof item.exitCode === 'number' ? ` (${item.exitCode})` : ''}`
      : typeof item.exitCode === 'number'
        ? `完成 (exit ${item.exitCode})`
        : '已完成';
  const firstLine = item.command.split('\n')[0];
  const shortCmd = firstLine.length > 78 ? `${firstLine.slice(0, 76)}…` : firstLine;
  const durationText = item.durationMs ? fmtDuration(item.durationMs) : null;
  const Icon = item.toolName === 'mcp' ? IconTool : IconTerminal;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(item.command);
      setCopied(true);
      onCopy?.('已复制命令');
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  return (
    <div className="codex-event-row" data-kind={kind} data-event-type={item.eventType}>
      <button
        type="button"
        className="codex-event-row-main"
        aria-expanded={open}
        title={item.command}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="codex-event-row-icon"><Icon size={14} /></span>
        <span className="codex-event-row-copy">
          <span className="codex-event-row-title">
            {item.status === 'failed' ? `命令执行失败 · ${shortCmd}` : shortCmd}
          </span>
          <span className="codex-event-row-summary">
            {item.workerLabel} · {statusLabel}
          </span>
        </span>
        {durationText && <span className="codex-event-row-duration tabular-nums">{durationText}</span>}
        <IconChevronDown size={13} className="codex-event-row-chevron" />
      </button>

      {open && (
        <div className="codex-event-row-detail">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
            <code className="codex-event-command">$ {item.command}</code>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' }}>
              {item.filePath && onInspectFile && (
                <button
                  type="button"
                  className="codex-inline-link-btn"
                  onClick={() => onInspectFile(item.filePath!)}
                >
                  <span>查看文件</span>
                  <IconArrowUpRight size={12} />
                </button>
              )}
              <button
                type="button"
                className="codex-icon-btn"
                style={{ width: 22, height: 22 }}
                aria-label="复制命令"
                title="复制命令"
                onClick={handleCopy}
              >
                {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
              </button>
            </div>
          </div>
          {item.output && (
            <pre className="codex-command-output vertical-scroll-fade-mask" style={{ margin: '6px 0 0', maxHeight: 200 }}>
              {item.output}
            </pre>
          )}
          {item.error && (
            <div className="codex-event-error">{item.error}</div>
          )}
          <div className="codex-event-meta">
            {item.toolName} · {statusLabel}
            {item.timestamp > 0 && ` · ${new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`}
          </div>
        </div>
      )}
    </div>
  );
};

interface ConvergedFileSummaryRowProps {
  item: Extract<UnifiedActivityItem, { kind: 'file' }>;
  onInspectFile?: (path: string) => void;
}

export const ConvergedFileSummaryRow: React.FC<ConvergedFileSummaryRowProps> = ({ item, onInspectFile }) => {
  const [open, setOpen] = React.useState(false);
  const isRead = item.operation === 'read';
  const kind = item.status === 'failed' ? 'danger' : item.status === 'running' ? 'running' : 'success';
  const verb = item.status === 'failed'
    ? (isRead ? '读取失败' : '编辑失败')
    : item.status === 'running'
      ? (isRead ? '正在读取' : '正在编辑')
      : isRead
        ? '已读取'
        : item.isCreated
          ? '已创建'
          : '已编辑';
  const hasCounts = typeof item.added === 'number' || typeof item.deleted === 'number';
  const hasExpandable = Boolean(item.previewLines?.length || item.summary || item.errorNote);

  return (
    <div className="codex-event-row" data-kind={kind} data-event-type={item.eventType}>
      <button
        type="button"
        className="codex-event-row-main"
        aria-expanded={open}
        title={item.path}
        onClick={() => {
          if (hasExpandable) setOpen((v) => !v);
          else onInspectFile?.(item.path);
        }}
      >
        <span className="codex-event-row-icon">
          {isRead ? <IconFileDoc size={14} /> : <IconFileEdit size={14} />}
        </span>
        <span className="codex-event-row-copy">
          <span className="codex-event-row-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span>{verb}</span>
            <span className="codex-step-file-link">{item.base}</span>
            {hasCounts && (
              <span className="codex-diff-counts tabular-nums" style={{ fontSize: 11.5 }}>
                <span className="codex-git-add">+{item.added ?? 0}</span>
                <span className="codex-git-del">-{item.deleted ?? 0}</span>
              </span>
            )}
          </span>
          <span className="codex-event-row-summary">
            {item.path}{item.summary ? ` · ${item.summary}` : ''}
          </span>
        </span>
        {onInspectFile && (
          <span
            role="button"
            tabIndex={0}
            className="codex-inline-link-btn"
            style={{ flex: 'none' }}
            onClick={(e) => {
              e.stopPropagation();
              onInspectFile(item.path);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onInspectFile(item.path);
              }
            }}
          >
            <IconArrowUpRight size={12} />
          </span>
        )}
        {hasExpandable && <IconChevronDown size={13} className="codex-event-row-chevron" />}
      </button>

      {open && hasExpandable && (
        <div className="codex-event-row-detail">
          {item.summary && <div className="codex-event-detail-text">{item.summary}</div>}
          {item.errorNote && <div className="codex-event-error">{item.errorNote}</div>}
          {item.previewLines && item.previewLines.length > 0 && (
            <div className="codex-inline-diff-body" style={{ marginTop: 6, maxHeight: 180 }}>
              {item.previewLines.map((line, i) => (
                <div key={i} className="codex-inline-diff-row" data-kind="context">
                  <span className="codex-inline-diff-ln">{i + 1}</span>
                  <span>{line || ' '}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface ConvergedApprovalRowProps {
  item: Extract<UnifiedActivityItem, { kind: 'approval' }>;
}

export const ConvergedApprovalRow: React.FC<ConvergedApprovalRowProps> = ({ item }) => {
  const kind = item.status === 'pending' ? 'approval' : item.status === 'approved' ? 'success' : 'danger';
  const title = item.status === 'pending'
    ? '等待审批'
    : item.status === 'approved'
      ? '已批准操作'
      : '已拒绝操作';
  const Icon = item.status === 'pending' ? IconShieldAlert : item.status === 'approved' ? IconCheck : IconClose;

  return (
    <div className="codex-event-row" data-kind={kind} data-event-type={item.eventType}>
      <div className="codex-event-row-main" style={{ cursor: 'default' }}>
        <span className="codex-event-row-icon"><Icon size={14} /></span>
        <span className="codex-event-row-copy">
          <span className="codex-event-row-title">{title} · {item.tool}</span>
          <span className="codex-event-row-summary">
            {item.workerLabel}
            {item.command ? ` · ${item.command}` : item.reason ? ` · ${item.reason}` : ''}
          </span>
        </span>
      </div>
    </div>
  );
};

interface ConvergedErrorRowProps {
  item: Extract<UnifiedActivityItem, { kind: 'error' }>;
}

export const ConvergedErrorRow: React.FC<ConvergedErrorRowProps> = ({ item }) => (
  <div className="codex-event-row" data-kind="danger" data-event-type={item.eventType}>
    <div className="codex-event-row-main" style={{ cursor: 'default' }}>
      <span className="codex-event-row-icon"><IconClose size={14} /></span>
      <span className="codex-event-row-copy">
        <span className="codex-event-row-title">{item.title}</span>
        <span className="codex-event-row-summary">{item.workerLabel} · {item.message}</span>
      </span>
    </div>
  </div>
);

/**
 * Sorted & deduplicated runtime events helper (kept exported for compatibility).
 * Deduplicates by callId, approvalId, workerId/nodeId, and filePath,
 * and omits final assistant reply bodies and plan/node boilerplate.
 */
export function eventRowsForActivity(events: EventEnvelope[], workerById: Map<string, Worker>): EventEnvelope[] {
  const workers = [...workerById.values()];
  const sorted = sortEventsChronologically(events);
  const byKey = new Map<string, EventEnvelope>();
  const order: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    const p = ev.payload ?? {};
    if (!/^(turn\.failed|tool|command|file|approval|node\.failed|worker)\./.test(ev.type)) continue;
    if (ev.type === 'tool.requested' || ev.type === 'message.completed' || ev.type === 'message.started') continue;

    let key = `${ev.type}:${ev.seq || i}`;
    const callId = text(p.callId).trim();
    const approvalId = text(p.approvalId).trim()
      || (p.approval && typeof p.approval === 'object' ? text((p.approval as Record<string, unknown>).id).trim() : '');
    const filePath = text(p.path) || text(p.filePath);
    const worker = resolveWorkerForPayload(p, workers);
    const workerKey = worker?.id || resolveWorkerIdFromPayload(p);

    if (callId && (ev.type.startsWith('tool.') || ev.type.startsWith('command.'))) {
      key = `call:${callId}`;
    } else if (approvalId && ev.type.startsWith('approval.')) {
      key = `approval:${approvalId}`;
    } else if (filePath && ev.type.startsWith('file.')) {
      key = `file:${ev.type}:${normalizeFilePath(filePath)}`;
    } else if (workerKey && (ev.type.startsWith('worker.') || ev.type.startsWith('node.'))) {
      const phase = ev.type.includes('started') ? 'start' : ev.type.includes('completed') || ev.type.includes('failed') ? 'end' : ev.type;
      key = `worker:${phase}:${workerKey}`;
    }

    if (!byKey.has(key)) order.push(key);
    byKey.set(key, ev);
  }

  return order.map((k) => byKey.get(k)!);
}
