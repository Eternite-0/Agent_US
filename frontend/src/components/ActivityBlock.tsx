import React, { useEffect, useMemo, useState } from 'react';
import type {
  Approval,
  Assignment,
  EventEnvelope,
  Evidence,
  SessionHistoryItem,
  SessionRecord,
  TaskPlan,
  Worker,
} from '../types/backend';
import { type DiffLine } from '../utils/diff';
import { buildUnifiedActivityTimeline } from '../utils/activity';
import { fmtActionCommand, fmtDuration, fmtStatusLabel } from '../utils/format';
import { getWorkerDisplayName, getWorkerDisplayRole } from '../utils/worker';
import { AgentAvatar } from './AgentAvatar';
import { Collapsible } from './Collapsible';
import { Markdown } from './Markdown';
import {
  IconArrowUpRight,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconCopy,
  IconFileEdit,
  IconImageInspect,
  IconShieldAlert,
  IconSparkle,
} from './Icons';
import { isImagePath, toImageDataUrl, type PreviewImageItem } from './ImageLightbox';
import {
  ConvergedApprovalRow,
  ConvergedCommandRow,
  ConvergedErrorRow,
  ConvergedFileSummaryRow,
} from './ActivityEventRow';

/* ============================================================================
 * Command Card — appears ONLY when expanding a shell/git/mcp command step
 * Exact specs: 0.8px border-strong, 12.5px radius, bg-secondary-soft-alpha
 * ========================================================================== */

interface CommandCardProps {
  label: string;
  command: string;
  output?: string;
  exitCode?: number;
  status?: string;
  filePath?: string;
  onInspectFile?: (path: string) => void;
  onCopy?: (msg: string) => void;
}

export const CommandCard: React.FC<CommandCardProps> = ({
  label,
  command,
  output,
  exitCode,
  status,
  filePath,
  onInspectFile,
  onCopy,
}) => {
  const [copied, setCopied] = useState(false);
  const [cmdExpanded, setCmdExpanded] = useState(false);
  const failed = (typeof exitCode === 'number' && exitCode !== 0) || status === 'failed';

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      onCopy?.('已复制命令');
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  return (
    <div className="codex-command-card">
      <div className="codex-command-header">
        <span>{label}</span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {filePath && onInspectFile && (
            <button
              type="button"
              className="codex-inline-link-btn"
              onClick={() => onInspectFile(filePath)}
            >
              <span>查看文件</span>
              <IconArrowUpRight size={12} />
            </button>
          )}
          {failed ? (
            <span style={{ color: 'var(--color-danger)', fontSize: 12 }}>
              failed{typeof exitCode === 'number' ? ` (${exitCode})` : ''}
            </span>
          ) : typeof exitCode === 'number' ? (
            <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }} className="tabular-nums">
              exit {exitCode}
            </span>
          ) : null}
        </div>
      </div>
      <div className="codex-command-cmd-wrap">
        <div
          role="button"
          tabIndex={0}
          className="codex-command-cmd"
          data-expanded={cmdExpanded ? 'true' : undefined}
          title="点击展开/收起完整命令"
          style={{ cursor: 'pointer' }}
          onClick={() => setCmdExpanded((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setCmdExpanded((v) => !v);
            }
          }}
        >
          <span className="codex-command-dollar">$</span>
          <code>{command}</code>
        </div>
        <button
          type="button"
          className="codex-command-copy"
          aria-label="复制"
          onClick={handleCopy}
        >
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        </button>
      </div>
      {output ? (
        <div className="codex-command-output vertical-scroll-fade-mask">{output}</div>
      ) : null}
      <div className="codex-command-footer" data-failed={failed ? 'true' : undefined}>
        {failed ? (
          <>
            <IconClose size={12} />
            <span>失败{typeof exitCode === 'number' ? ` (${exitCode})` : ''}</span>
          </>
        ) : (
          <>
            <IconCheck size={12} />
            <span>成功</span>
          </>
        )}
      </div>
    </div>
  );
};

/* ============================================================================
 * Inline & Above-Composer Approval Gate Card
 * ========================================================================== */

interface ApprovalCardProps {
  approval: Approval;
  worker?: Worker;
  busy?: boolean;
  compact?: boolean;
  onDecide: (approval: Approval, decision: 'approve' | 'deny', scope?: 'once' | 'session') => void;
}

export const ApprovalGateCard: React.FC<ApprovalCardProps> = ({
  approval,
  worker,
  busy = false,
  compact = false,
  onDecide,
}) => {
  const [now, setNow] = useState(Date.now());
  const [payloadOpen, setPayloadOpen] = useState(false);

  useEffect(() => {
    if (approval.status !== 'pending') return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [approval.status]);

  const remainingMs = Math.max(0, approval.expires - now);
  const remainingSec = Math.ceil(remainingMs / 1000);
  const totalWindowMs = 120000;
  const pct = Math.max(0, Math.min(100, (remainingMs / totalWindowMs) * 100));
  const cmdPreview = fmtActionCommand(approval.tool, approval.action);
  const writeText =
    approval.tool === 'write_file' && typeof approval.action.text === 'string'
      ? approval.action.text
      : '';
  const isApproved = approval.status === 'approve' || approval.status === 'consumed';

  return (
    <div className="codex-approval-card" data-status={approval.status}>
      {approval.status === 'pending' && (
        <div className="codex-approval-progress">
          <div className="codex-approval-progress-bar" style={{ width: `${pct}%` }} />
        </div>
      )}

      <div className="codex-approval-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <IconShieldAlert size={16} style={{ color: 'var(--color-warning)', flex: 'none' }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-default)' }}>
              {approval.status === 'pending'
                ? '正在等待你的批准'
                : isApproved
                  ? '已批准此操作'
                  : '已拒绝此操作'}
              <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, marginLeft: 6 }}>
                {approval.tool}
                {worker ? ` · ${getWorkerDisplayName(worker)}` : ''}
              </span>
            </div>
            {compact && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  marginTop: 2,
                }}
              >
                $ {cmdPreview}
              </div>
            )}
          </div>
        </div>

        {approval.status === 'pending' && !compact ? (
          <span className="codex-status-chip tabular-nums" data-tone="warning">
            剩余 {remainingSec}s
          </span>
        ) : approval.status === 'pending' && compact ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
            <span className="tabular-nums" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              {remainingSec}s
            </span>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              disabled={busy}
              onClick={() => onDecide(approval, 'deny')}
            >
              拒绝
            </button>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="primary"
              disabled={busy}
              onClick={() => onDecide(approval, 'approve')}
            >
              {busy ? '提交中…' : '批准执行'}
            </button>
          </div>
        ) : (
          <span
            className="codex-status-chip"
            data-tone={isApproved ? 'success' : 'danger'}
          >
            {fmtStatusLabel(approval.status)}
          </span>
        )}
      </div>

      {!compact && (
        <>
          <div className="codex-approval-body">
            <span style={{ color: 'var(--text-tertiary)' }}>$ </span>
            {cmdPreview}
          </div>

          {writeText && (
            <div style={{ padding: '6px 12px', borderTop: '1px solid var(--border-subtle)' }}>
              <button
                type="button"
                className="codex-activity-row"
                aria-expanded={payloadOpen}
                onClick={() => setPayloadOpen((v) => !v)}
              >
                <span className="codex-activity-row-label" style={{ fontSize: 12.5 }}>
                  {payloadOpen ? '收起写入内容预览' : `查看待写入内容 (${writeText.length} 字符)`}
                </span>
                <span className="codex-activity-chevron">
                  <IconChevronRight size={13} />
                </span>
              </button>
              <Collapsible open={payloadOpen}>
                <pre
                  style={{
                    margin: '8px 0 2px',
                    padding: 8,
                    borderRadius: 8,
                    background: 'var(--bg-surface-secondary)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    maxHeight: 160,
                    overflow: 'auto',
                  }}
                >
                  {writeText}
                </pre>
              </Collapsible>
            </div>
          )}

          {approval.status === 'pending' && (
            <div className="codex-approval-footer">
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                在本地工作区受控执行（已通过高危命令红线预检）
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="outline"
                  disabled={busy}
                  onClick={() => onDecide(approval, 'deny')}
                >
                  拒绝
                </button>
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="primary"
                  disabled={busy}
                  onClick={() => onDecide(approval, 'approve', 'once')}
                >
                  {busy ? '提交中…' : '批准一次'}
                </button>
                {typeof approval.action?.commandPrefix === 'string' && approval.action.commandPrefix && (
                  <button
                    type="button"
                    className="codex-toolbar-btn"
                    data-variant="outline"
                    disabled={busy}
                    title={`本会话后续匹配「${String(approval.action.commandPrefix)}」的命令自动放行`}
                    onClick={() => onDecide(approval, 'approve', 'session')}
                  >
                    本会话允许 {String(approval.action.commandPrefix)}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

/* ============================================================================
 * Per-Step Inline File Diff Row
 *   - Created file: [✏️] 已创建 AgentPanel.tsx +57 -0 •
 *   - Edited file:  [✏️] 已编辑 ConversationWorkspace.tsx +48 -5
 * ========================================================================== */

interface InlineFileStepProps {
  path: string;
  base: string;
  added: number;
  deleted: number;
  isCreated: boolean;
  failed?: boolean;
  errorNote?: string;
  afterText: string;
  lines: DiffLine[];
  onInspectFile?: (path: string) => void;
  onCopy?: (msg: string) => void;
}

const InlineFileStepRow: React.FC<InlineFileStepProps> = ({
  path,
  base,
  added,
  deleted,
  isCreated,
  failed = false,
  errorNote,
  afterText,
  lines,
  onInspectFile,
  onCopy,
}) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const visibleLines = useMemo(() => {
    if (isCreated) return lines.slice(0, 120);
    // Show changed hunks with 2 context lines around each change (exact Screenshot 3 style)
    const keep = new Set<number>();
    lines.forEach((l, idx) => {
      if (l.kind !== 'context') {
        for (let k = Math.max(0, idx - 2); k <= Math.min(lines.length - 1, idx + 2); k++) {
          keep.add(k);
        }
      }
    });
    const out = lines.filter((_, idx) => keep.has(idx));
    return out.length ? out.slice(0, 120) : lines.slice(0, 40);
  }, [isCreated, lines]);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(afterText);
      setCopied(true);
      onCopy?.(`已复制 ${base}`);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  return (
    <div className="codex-activity-group">
      <div className="codex-activity-row" style={{ gap: 6 }}>
        <button
          type="button"
          className="codex-activity-row"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={open ? '收起内联变更' : '点击展开内联代码变更'}
        >
          <span className="codex-activity-row-icon">
            <IconFileEdit size={15} />
          </span>
          {open ? (
            <span className="codex-activity-row-label">
              {isCreated ? '文件已创建' : '已编辑的文件'}
            </span>
          ) : (
            <span
              className="codex-activity-row-label"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <span>{failed ? '尝试编辑' : isCreated ? '已创建' : '已编辑'}</span>
              <span className="codex-step-file-link">{base}</span>
              {(added > 0 || deleted > 0 || isCreated) && (
                <span className="codex-diff-counts tabular-nums" style={{ fontSize: 12 }}>
                  <span className="codex-git-add">+{added}</span>
                  <span className="codex-git-del">-{deleted}</span>
                </span>
              )}
              {isCreated && !failed && <span className="codex-new-file-dot" />}
              {failed && (
                <span style={{ fontSize: 11.5, color: 'var(--color-danger)' }}>未写入</span>
              )}
            </span>
          )}
          <span className="codex-activity-chevron">
            <IconChevronRight size={14} />
          </span>
        </button>
      </div>

      <Collapsible open={open}>
        <div className="codex-activity-detail-nested">
          <div className="codex-inline-diff-card">
            <div className="codex-inline-diff-head">
              <button
                type="button"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  color: 'var(--text-default)',
                  fontWeight: 500,
                }}
                title={`在右侧工作区打开 ${path}`}
                onClick={() => onInspectFile?.(path)}
              >
                <span>{base}</span>
                <span className="codex-diff-counts tabular-nums" style={{ fontSize: 12 }}>
                  <span className="codex-git-add">+{added}</span>
                  <span className="codex-git-del">-{deleted}</span>
                </span>
              </button>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {onInspectFile && (
                  <button
                    type="button"
                    className="codex-icon-btn"
                    style={{ width: 22, height: 22 }}
                    aria-label="在右侧打开文件"
                    title="在右侧分屏打开"
                    onClick={() => onInspectFile(path)}
                  >
                    <IconArrowUpRight size={13} />
                  </button>
                )}
                <button
                  type="button"
                  className="codex-icon-btn"
                  style={{ width: 22, height: 22 }}
                  aria-label="复制文件内容"
                  title="复制文件内容"
                  onClick={handleCopy}
                >
                  {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                </button>
              </div>
            </div>

            {errorNote && (
              <div
                style={{
                  padding: '6px 10px',
                  fontSize: 11.5,
                  color: 'var(--color-danger)',
                  borderBottom: '1px solid var(--border-subtle)',
                  background: 'var(--color-danger-soft)',
                }}
              >
                {errorNote}
              </div>
            )}

            <div className="codex-inline-diff-body">
              {visibleLines.length === 0 ? (
                <div style={{ padding: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>
                  无文本行差异
                </div>
              ) : (
                visibleLines.map((ln, i) => (
                  <div key={i} className="codex-inline-diff-row" data-kind={ln.kind}>
                    <span className="codex-inline-diff-ln">{ln.newLine ?? ln.oldLine ?? ''}</span>
                    <span>{ln.text || ' '}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </Collapsible>
    </div>
  );
};

/* ============================================================================
 * Image View Row — Exact 1:1 with Codex Desktop (`🖼 已查看 N 张图像 v`)
 * Expands to a crisp horizontal thumbnail strip; clicking any thumbnail opens Lightbox!
 * ========================================================================== */

interface ImageViewRowProps {
  images: PreviewImageItem[];
  defaultOpen?: boolean;
  onOpenImage?: (images: PreviewImageItem[], index: number) => void;
}

const ImageViewRow: React.FC<ImageViewRowProps> = ({
  images,
  defaultOpen = false,
  onOpenImage,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  if (!images.length) return null;

  return (
    <div className="codex-activity-group">
      <button
        type="button"
        className="codex-activity-row"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="codex-activity-row-icon">
          <IconImageInspect size={15} />
        </span>
        <span className="codex-activity-row-label">
          已查看 {images.length} 张图像
        </span>
        <span className="codex-activity-chevron">
          <IconChevronRight size={14} />
        </span>
      </button>

      <Collapsible open={open}>
        <div className="codex-image-strip">
          {images.map((img, idx) => (
            <button
              key={img.id}
              type="button"
              className="codex-image-thumb-card"
              title={`点击放大查看 ${img.name}`}
              onClick={() => onOpenImage?.(images, idx)}
            >
              <img src={img.src} alt={img.name} className="codex-image-thumb-img" />
            </button>
          ))}
        </div>
      </Collapsible>
    </div>
  );
};

/* ============================================================================
 * Main Turn Process Block (1:1 with User Screenshots 1, 2, 4, 5!)
 * ========================================================================== */

interface ActivityBlockProps {
  plan?: TaskPlan;
  assignments: Assignment[];
  workers: Worker[];
  sessions?: SessionRecord[];
  histories?: Record<string, SessionHistoryItem[]>;
  evidence: Evidence[];
  approvals: Approval[];
  taskFiles?: Record<string, string>;
  artifactFiles?: Record<string, string>;
  events?: EventEnvelope[];
  startedAt?: number;
  durationMs?: number;
  isLive?: boolean;
  liveText?: string;
  finalProseTexts?: string[];
  defaultOpen?: boolean;
  subagentMode?: boolean;
  onOpenSubagent?: (workerId: string) => void;
  onInspectFile?: (path: string) => void;
  onOpenImage?: (images: PreviewImageItem[], index: number) => void;
  onCopy?: (msg: string) => void;
}

export const ActivityBlock: React.FC<ActivityBlockProps> = ({
  plan,
  assignments,
  workers,
  sessions = [],
  histories = {},
  evidence,
  approvals,
  taskFiles,
  artifactFiles,
  events = [],
  startedAt,
  durationMs,
  isLive = false,
  liveText,
  finalProseTexts = [],
  defaultOpen = false,
  subagentMode = false,
  onOpenSubagent,
  onInspectFile,
  onOpenImage,
  onCopy,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const [planOpen, setPlanOpen] = useState(false);
  const [liveNow, setLiveNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isLive) return;
    const t = window.setInterval(() => setLiveNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [isLive]);

  const timeline = useMemo(
    () =>
      buildUnifiedActivityTimeline({
        plan,
        assignments,
        workers,
        sessions,
        histories,
        evidence,
        approvals,
        taskFiles,
        artifactFiles,
        events,
        startedAt,
        isLive,
        finalProseTexts,
        subagentMode,
        isImagePath,
      }),
    [
      plan,
      assignments,
      workers,
      sessions,
      histories,
      evidence,
      approvals,
      taskFiles,
      artifactFiles,
      events,
      startedAt,
      isLive,
      finalProseTexts,
      subagentMode,
    ],
  );

  const { planSummary, items } = timeline;
  const hasDetail = Boolean(planSummary || items.length > 0);

  const liveElapsedMs = startedAt ? Math.max(1000, liveNow - startedAt) : undefined;
  const displayDuration = durationMs ?? liveElapsedMs;

  const renderProcessSteps = () => (
    <div className="codex-process-timeline" aria-label="运行活动">
      {/* Single Converged Plan Summary (shown once; node statuses updated by events) */}
      {planSummary && (
        <div className="codex-activity-group">
          <button
            type="button"
            className="codex-activity-row"
            aria-expanded={planOpen}
            onClick={() => setPlanOpen((v) => !v)}
          >
            <span className="codex-activity-row-icon">
              <IconSparkle size={15} />
            </span>
            <span className="codex-activity-row-label">
              已规划 {planSummary.nodes.length} 个工作节点 ·{' '}
              {planSummary.nodes.filter((n) => n.status === 'done').length}/{planSummary.nodes.length} 已完成
              {planSummary.complexity && planSummary.risk
                ? ` · ${planSummary.complexity} / 风险 ${planSummary.risk}`
                : planSummary.title
                  ? ` · ${planSummary.title}`
                  : ''}
            </span>
            <span className="codex-activity-chevron">
              <IconChevronRight size={14} />
            </span>
          </button>
          <Collapsible open={planOpen}>
            <div className="codex-activity-detail-nested">
              {planSummary.nodes.map((node) => (
                <div key={node.nodeId} className="codex-plan-node-row">
                  <span
                    className="codex-status-dot"
                    data-tone={
                      node.status === 'done'
                        ? 'live'
                        : node.status === 'running'
                          ? 'pulse'
                          : node.status === 'awaiting_approval'
                            ? 'warn'
                            : node.status === 'failed'
                              ? 'danger'
                              : undefined
                    }
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong style={{ color: 'var(--text-default)', fontWeight: 500 }}>
                      {node.displayName}
                    </strong>
                    {node.displayRole && (
                      <span style={{ color: 'var(--text-tertiary)' }}> ({node.displayRole})</span>
                    )}
                    {node.activityLabel && node.activityLabel !== node.displayName && (
                      <span> — {node.activityLabel}</span>
                    )}
                  </span>
                  {node.workerId && onOpenSubagent && (
                    <button
                      type="button"
                      className="codex-inline-link-btn"
                      onClick={() => onOpenSubagent(node.workerId!)}
                    >
                      查看过程
                    </button>
                  )}
                </div>
              ))}
            </div>
          </Collapsible>
        </div>
      )}

      {/* Single Converged Chronological Activity Timeline (sorted by seq/timestamp) */}
      {items.map((item, idx) => {
        if (item.kind === 'worker') {
          const targetWorkerId = item.worker?.id ?? item.workers?.[0]?.worker.id;
          const phaseSuffix =
            item.phase === 'started'
              ? '开始工作'
              : item.phase === 'resumed'
                ? '已恢复执行'
                : item.phase === 'failed'
                  ? '执行失败'
                  : '已完成';
          return (
            <button
              key={item.id}
              type="button"
              className="codex-activity-row"
              title={item.activityLabel || '点击在右侧子智能体面板查看执行过程'}
              onClick={() => targetWorkerId && onOpenSubagent?.(targetWorkerId)}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' }}>
                {item.workers?.length ? (
                  item.workers.map((x) => (
                    <AgentAvatar
                      key={x.worker.id}
                      role={getWorkerDisplayRole(x.worker)}
                      size={15}
                    />
                  ))
                ) : (
                  <AgentAvatar
                    role={item.role || getWorkerDisplayRole(item.worker)}
                    size={15}
                  />
                )}
              </span>
              <span className="codex-activity-row-label">
                {item.label} {phaseSuffix}
              </span>
            </button>
          );
        }

        if (item.kind === 'file') {
          if (item.operation !== 'read' && item.diffLines && item.afterText !== undefined) {
            return (
              <InlineFileStepRow
                key={item.id}
                path={item.path}
                base={item.base}
                added={item.added ?? 0}
                deleted={item.deleted ?? 0}
                isCreated={Boolean(item.isCreated)}
                failed={item.status === 'failed'}
                errorNote={item.errorNote}
                afterText={item.afterText}
                lines={item.diffLines}
                onInspectFile={onInspectFile}
                onCopy={onCopy}
              />
            );
          }
          return (
            <ConvergedFileSummaryRow
              key={item.id}
              item={item}
              onInspectFile={onInspectFile}
            />
          );
        }

        if (item.kind === 'command') {
          return (
            <ConvergedCommandRow
              key={item.id}
              item={item}
              defaultOpen={subagentMode || (isLive && idx === items.length - 1)}
              onInspectFile={onInspectFile}
              onCopy={onCopy}
            />
          );
        }

        if (item.kind === 'approval') {
          return <ConvergedApprovalRow key={item.id} item={item} />;
        }

        if (item.kind === 'error') {
          return <ConvergedErrorRow key={item.id} item={item} />;
        }

        if (item.kind === 'image-view') {
          const previewImages: PreviewImageItem[] = [];
          for (const img of item.images) {
            const src = toImageDataUrl(img.path, img.rawBase64);
            if (src) {
              previewImages.push({
                id: img.id,
                src,
                name: img.name,
                caption: img.path,
              });
            }
          }
          if (!previewImages.length) return null;
          return (
            <ImageViewRow
              key={item.id}
              images={previewImages}
              defaultOpen={isLive}
              onOpenImage={onOpenImage}
            />
          );
        }

        if (item.kind === 'compaction') {
          return (
            <div key={item.id} className="codex-activity-row" style={{ cursor: 'default' }}>
              <span className="codex-activity-row-label">上下文已自动压缩</span>
            </div>
          );
        }

        return (
          <div key={item.id} className="codex-process-commentary">
            <Markdown
              text={item.text}
              imageFiles={{ ...(taskFiles ?? {}), ...(artifactFiles ?? {}) }}
              onOpenFile={onInspectFile}
              onOpenImage={onOpenImage}
              onCopy={onCopy}
            />
          </div>
        );
      })}
    </div>
  );

  // LIVE EXECUTION MODE: stream interleaved steps inline + ticking shimmer status line
  if (isLive) {
    return (
      <div className="codex-activity-group" style={{ gap: 10 }}>
        {hasDetail && renderProcessSteps()}
        <div className="codex-activity-row" style={{ cursor: 'default' }}>
          <span className="codex-activity-row-icon">
            <IconSparkle size={15} />
          </span>
          <span className="codex-shimmer-text">{liveText || '正在思考与规划任务…'}</span>
          {liveElapsedMs !== undefined && (
            <span
              className="tabular-nums"
              style={{ fontSize: 12.5, color: 'var(--text-tertiary)', marginLeft: 4 }}
            >
              · {fmtDuration(liveElapsedMs)}
            </span>
          )}
        </div>
      </div>
    );
  }

  if (!hasDetail) return null;

  // COMPLETED MODE: exact `用时 X >` collapsible header (1:1 with User Screenshots 1, 2, 4!)
  return (
    <div className="codex-activity-group">
      <button
        type="button"
        className="codex-activity-row codex-duration-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="codex-activity-row-label tabular-nums">
          {displayDuration ? `用时 ${fmtDuration(displayDuration)}` : '查看执行过程'}
        </span>
        <span className="codex-activity-chevron">
          <IconChevronRight size={14} />
        </span>
      </button>

      <Collapsible open={open}>
        <div className="codex-duration-body">{renderProcessSteps()}</div>
      </Collapsible>
    </div>
  );
};
