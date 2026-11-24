import { useId, useMemo, useState } from 'react';
import {
  buildDiffPresentation,
  foldDiffLines,
  type ComputedFileDiff,
  type DiffLine,
  type DiffSpan,
} from '../utils/diff';
import { splitPath } from '../utils/format';
import { ActivityCopyButton } from './ActivityPresentation';
import { Collapsible } from './Collapsible';
import { IconArrowUpRight, IconChevronDown, IconChevronRight, IconFileDoc, IconDiffBox, IconUndo } from './Icons';

interface FileChangeCardProps {
  files: ComputedFileDiff[];
  onInspectFile: (path?: string) => void;
  onUndo?: () => void;
  onRewind?: (scope: 'files' | 'both') => Promise<void> | void;
  rewinding?: boolean;
  onCopy?: (msg: string) => void;
}

const INITIAL_VISIBLE = 3;

function DiffCounts({ added, deleted }: { added: number; deleted: number }) {
  return <span className="codex-diff-counts tabular-nums"><span className="codex-git-add">+{added}</span><span className="codex-git-del">-{deleted}</span></span>;
}

/** Keep code as selectable text; additions and deletions share the same renderer. */
export function DiffLineText({ line, spans }: { line: DiffLine | null; spans?: readonly DiffSpan[] }) {
  const Tag = line?.kind === 'del' ? 'del' : 'ins';
  return <span className="codex-diff-code">{spans ? spans.map((span, index) => span.changed
    ? <Tag key={index} className="codex-diff-changed" data-change={line?.kind}>{span.text}</Tag>
    : span.text) : line?.text}</span>;
}

export function DiffLineSign({ kind }: { kind?: DiffLine['kind'] }) {
  return <span className="codex-diff-sign">{kind === 'add' ? '+' : kind === 'del' ? '-' : ''}</span>;
}

export function InlineDiff({ lines, hunks }: { lines: readonly DiffLine[]; hunks?: ComputedFileDiff['hunks'] }) {
  const [expandedFolds, setExpandedFolds] = useState<ReadonlySet<string>>(() => new Set());
  const toggleFold = (foldId: string) => {
    setExpandedFolds((prev) => {
      const next = new Set(prev);
      next.add(foldId);
      return next;
    });
  };
  const { spansByLine } = useMemo(() => buildDiffPresentation(lines), [lines]);
  const visibleHunks = useMemo(() => {
    if (!hunks?.length) return null;
    let remaining = 180;
    const out: Array<{ header: string; lines: readonly DiffLine[]; spansByLine: ReturnType<typeof buildDiffPresentation>['spansByLine'] }> = [];
    for (const hunk of hunks) {
      if (remaining <= 0) break;
      const sliced = hunk.lines.slice(0, remaining);
      remaining -= sliced.length;
      out.push({ header: hunk.header, lines: sliced, spansByLine: buildDiffPresentation(sliced).spansByLine });
    }
    return out;
  }, [hunks]);
  const foldedLines = useMemo(() => {
    if (visibleHunks) return [];
    const base = lines.length > 400 ? lines.slice(0, 400) : lines;
    return foldDiffLines(base, expandedFolds);
  }, [lines, visibleHunks, expandedFolds]);

  return (
    <div className="codex-inline-diff-body" role="region" aria-label="内联文件差异" tabIndex={0}>
      {visibleHunks ? (
        visibleHunks.map((hunk, hIdx) => {
          const hunkScopedExpanded = new Set(
            [...expandedFolds]
              .filter((id) => id.startsWith(`h${hIdx}:`))
              .map((id) => id.slice(`h${hIdx}:`.length)),
          );
          const entries = foldDiffLines(hunk.lines, hunkScopedExpanded);
          return (
            <div key={`${hunk.header}-${hIdx}`} className="codex-inline-diff-hunk">
              <div
                className="codex-inline-diff-row"
                data-kind="hunk"
                style={{
                  color: 'var(--text-tertiary)',
                  background: 'var(--bg-surface-secondary)',
                  borderTop: hIdx > 0 ? '1px solid var(--border-subtle)' : undefined,
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <span className="codex-inline-diff-ln">@@</span>
                <span>{hunk.header}</span>
              </div>
              {entries.map((entry) =>
                entry.kind === 'fold' ? (
                  <button
                    key={entry.id}
                    type="button"
                    className="codex-diff-fold-btn"
                    aria-expanded={false}
                    onClick={() => toggleFold(`h${hIdx}:${entry.id}`)}
                  >
                    展开 {entry.count} 行上下文
                  </button>
                ) : (
                  <div
                    key={`${hIdx}:${entry.index}:${entry.item.kind}:${entry.item.oldLine ?? ''}:${entry.item.newLine ?? ''}`}
                    className="codex-inline-diff-row"
                    data-kind={entry.item.kind}
                  >
                    <span className="codex-inline-diff-ln">{entry.item.newLine ?? entry.item.oldLine ?? ''}</span>
                    <DiffLineSign kind={entry.item.kind} />
                    <DiffLineText line={entry.item} spans={hunk.spansByLine.get(entry.item)} />
                  </div>
                ),
              )}
            </div>
          );
        })
      ) : foldedLines.length === 0 ? (
        <div style={{ padding: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>无文本行差异</div>
      ) : (
        foldedLines.map((entry) =>
          entry.kind === 'fold' ? (
            <button
              key={entry.id}
              type="button"
              className="codex-diff-fold-btn"
              aria-expanded={false}
              onClick={() => toggleFold(entry.id)}
            >
              展开 {entry.count} 行上下文
            </button>
          ) : (
            <div
              key={`${entry.index}:${entry.item.kind}:${entry.item.oldLine ?? ''}:${entry.item.newLine ?? ''}`}
              className="codex-inline-diff-row"
              data-kind={entry.item.kind}
            >
              <span className="codex-inline-diff-ln">{entry.item.newLine ?? entry.item.oldLine ?? ''}</span>
              <DiffLineSign kind={entry.item.kind} />
              <DiffLineText line={entry.item} spans={spansByLine.get(entry.item)} />
            </div>
          ),
        )
      )}
    </div>
  );
}

function FileChangeRow({ file, hidden, listId, onInspectFile, onCopy }: {
  file: ComputedFileDiff;
  hidden: boolean;
  listId: string;
  onInspectFile: FileChangeCardProps['onInspectFile'];
  onCopy?: FileChangeCardProps['onCopy'];
}) {
  const [open, setOpen] = useState(false);
  const previewId = useId();
  const { path, added, deleted, lines, afterText, hunks, sha256After } = file;
  const { dir, name } = splitPath(path);
  const status =
    file.isNew || file.action === 'create'
      ? { kind: 'add', label: '新增' }
      : file.isDeleted || file.action === 'delete'
        ? { kind: 'del', label: '删除' }
        : { kind: 'edit', label: '修改' };

  return (
    <div className="codex-file-row-wrap" hidden={hidden} data-scroll-anchor={`file:${listId}:${path}`}>
      <div className="codex-file-row">
        <button type="button" className="codex-file-path" title={path} aria-label={`在右侧分屏打开 ${path}`} onClick={() => onInspectFile(path)}>
          <IconFileDoc size={14} aria-hidden="true" />
          <span className="codex-file-path-text">
            {dir && <span className="codex-file-dir">{dir}</span>}{name}
          </span>
        </button>
        <span className="codex-file-state" data-kind={status.kind}>{status.label}</span>
        <DiffCounts added={added} deleted={deleted} />
        <button type="button" className="codex-icon-btn codex-activity-copy codex-file-row-trigger codex-activity-disclosure"
          aria-expanded={open} aria-controls={previewId} aria-label={`${open ? '收起' : '预览'}差异 ${path}`} data-scroll-disclosure onClick={() => setOpen(!open)}>
          <IconChevronRight className="codex-direct-chevron" size={13} aria-hidden="true" />
        </button>
      </div>
      <Collapsible id={previewId} open={open}>
        <div className="codex-file-inline-diff">
          <div className="codex-inline-diff-head">
            <button type="button" className="codex-inline-link-btn" onClick={() => onInspectFile(path)}><span>{path}</span></button>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {sha256After && (
                <span
                  className="tabular-nums"
                  title={`SHA-256: ${sha256After}`}
                  style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}
                >
                  #{sha256After.slice(0, 8)}
                </span>
              )}
              <ActivityCopyButton text={afterText || file.unifiedDiff || ''} label="复制文件内容" onCopy={onCopy} />
            </div>
          </div>
          <InlineDiff lines={lines} hunks={hunks} />
        </div>
      </Collapsible>
    </div>
  );
}

export function FileChangeCard({ files, onInspectFile, onUndo, onRewind, rewinding = false, onCopy }: FileChangeCardProps) {
  const [expandedList, setExpandedList] = useState(false);
  const [rewindOpen, setRewindOpen] = useState(false);
  const [localRewinding, setLocalRewinding] = useState(false);
  const listId = useId();
  const uniqueFiles = useMemo(() => [...new Map(files.map((file) => [file.path, file])).values()], [files]);
  if (!uniqueFiles.length) return null;

  const totalAdd = uniqueFiles.reduce((sum, file) => sum + file.added, 0);
  const totalDel = uniqueFiles.reduce((sum, file) => sum + file.deleted, 0);
  const moreCount = uniqueFiles.length - INITIAL_VISIBLE;
  const inspectFirst = () => onInspectFile(uniqueFiles[0].path);
  const rewindBusy = rewinding || localRewinding;
  const triggerRewind = async (scope: 'files' | 'both') => {
    if (!onRewind || rewindBusy) return;
    setLocalRewinding(true);
    try {
      await onRewind(scope);
      setRewindOpen(false);
    } finally {
      setLocalRewinding(false);
    }
  };
  return (
    <div className="codex-file-card" data-status="completed">
      <div className="codex-file-card-head">
        <button className="codex-file-card-trigger" type="button" onClick={inspectFirst} aria-label="查看已更改的文件">
          <span className="codex-file-card-icon"><IconDiffBox size={14} aria-hidden="true" /></span>
          <span>已编辑 {uniqueFiles.length} 个文件</span>
          <DiffCounts added={totalAdd} deleted={totalDel} />
        </button>
        <div className="codex-file-card-actions">
          {(onRewind || onUndo) && (
            <button
              type="button"
              className="codex-toolbar-btn"
              aria-expanded={onRewind ? rewindOpen : undefined}
              disabled={rewindBusy}
              onClick={() => {
                if (onRewind) setRewindOpen((cur) => !cur);
                else onUndo?.();
              }}
            >
              <span>撤销</span>
              <IconUndo size={13} aria-hidden="true" />
            </button>
          )}
          <button type="button" className="codex-toolbar-btn" onClick={inspectFirst}>查看变更<IconArrowUpRight size={12} aria-hidden="true" /></button>
        </div>
      </div>

      {onRewind && rewindOpen && (
        <div className="codex-rewind-choice-bar" role="group" aria-label="选择回退范围">
          <span className="codex-rewind-choice-label">回退范围：</span>
          <button
            type="button"
            className="codex-toolbar-btn"
            data-variant="outline"
            disabled={rewindBusy}
            onClick={() => void triggerRewind('files')}
          >
            仅还原文件
          </button>
          <button
            type="button"
            className="codex-toolbar-btn"
            data-variant="primary"
            disabled={rewindBusy}
            onClick={() => void triggerRewind('both')}
          >
            文件 + 对话回退
          </button>
          <button
            type="button"
            className="codex-toolbar-btn"
            disabled={rewindBusy}
            onClick={() => setRewindOpen(false)}
          >
            取消
          </button>
        </div>
      )}

      <div id={listId}>
        {uniqueFiles.map((file, index) => <FileChangeRow key={file.path} file={file} listId={listId}
          hidden={!expandedList && index >= INITIAL_VISIBLE} onInspectFile={onInspectFile} onCopy={onCopy} />)}
      </div>
      {moreCount > 0 && <button type="button" className="codex-file-more-btn codex-activity-disclosure" aria-expanded={expandedList}
        aria-controls={listId} data-scroll-disclosure onClick={() => setExpandedList(!expandedList)}>
        <span>{expandedList ? '收起文件列表' : `再显示 ${moreCount} 个文件`}</span>
        <IconChevronDown className="codex-direct-chevron" size={15} aria-hidden="true" />
      </button>}
    </div>
  );
}
