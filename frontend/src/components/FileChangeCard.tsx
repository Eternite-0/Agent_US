import { useId, useMemo, useState } from 'react';
import { buildDiffPresentation, type ComputedFileDiff, type DiffLine, type DiffSpan } from '../utils/diff';
import { splitPath } from '../utils/format';
import { ActivityCopyButton } from './ActivityPresentation';
import { Collapsible } from './Collapsible';
import { IconArrowUpRight, IconChevronDown, IconChevronRight, IconFileDoc, IconDiffBox, IconUndo } from './Icons';

interface FileChangeCardProps {
  files: ComputedFileDiff[];
  onInspectFile: (path?: string) => void;
  onUndo?: () => void;
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

function InlineDiff({ lines }: { lines: readonly DiffLine[] }) {
  const { spansByLine } = useMemo(() => buildDiffPresentation(lines), [lines]);
  const visibleLines = useMemo(() => {
    const keep = new Set<number>();
    lines.forEach((line, index) => {
      if (line.kind === 'context') return;
      for (let i = Math.max(0, index - 2); i <= Math.min(lines.length - 1, index + 2); i++) keep.add(i);
    });
    return keep.size ? lines.filter((_, index) => keep.has(index)).slice(0, 120) : lines.slice(0, 60);
  }, [lines]);

  return (
    <div className="codex-inline-diff-body" role="region" aria-label="内联文件差异" tabIndex={0}>
      {visibleLines.length === 0 ? (
        <div style={{ padding: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>无文本行差异</div>
      ) : visibleLines.map((line) => (
        <div key={`${line.kind}:${line.oldLine ?? ''}:${line.newLine ?? ''}`} className="codex-inline-diff-row" data-kind={line.kind}>
          <span className="codex-inline-diff-ln">{line.newLine ?? line.oldLine ?? ''}</span>
          <DiffLineSign kind={line.kind} />
          <DiffLineText line={line} spans={spansByLine.get(line)} />
        </div>
      ))}
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
  const { path, added, deleted, afterText } = file;
  const { dir, name } = splitPath(path);
  const status = file.isNew ? { kind: 'add', label: '新增' } : file.isDeleted ? { kind: 'del', label: '删除' } : { kind: 'edit', label: '修改' };

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
            <ActivityCopyButton text={afterText} label="复制文件内容" onCopy={onCopy} />
          </div>
          <InlineDiff lines={file.lines} />
        </div>
      </Collapsible>
    </div>
  );
}

export function FileChangeCard({ files, onInspectFile, onUndo, onCopy }: FileChangeCardProps) {
  const [expandedList, setExpandedList] = useState(false);
  const listId = useId();
  const uniqueFiles = useMemo(() => [...new Map(files.map((file) => [file.path, file])).values()], [files]);
  if (!uniqueFiles.length) return null;

  const totalAdd = uniqueFiles.reduce((sum, file) => sum + file.added, 0);
  const totalDel = uniqueFiles.reduce((sum, file) => sum + file.deleted, 0);
  const moreCount = uniqueFiles.length - INITIAL_VISIBLE;
  const inspectFirst = () => onInspectFile(uniqueFiles[0].path);
  return (
    <div className="codex-file-card" data-status="completed">
      <div className="codex-file-card-head">
        <button className="codex-file-card-trigger" type="button" onClick={inspectFirst} aria-label="查看已更改的文件">
          <span className="codex-file-card-icon"><IconDiffBox size={14} aria-hidden="true" /></span>
          <span>已编辑 {uniqueFiles.length} 个文件</span>
          <DiffCounts added={totalAdd} deleted={totalDel} />
        </button>
        <div className="codex-file-card-actions">
          {onUndo && <button type="button" className="codex-toolbar-btn" onClick={onUndo}><span>撤销</span><IconUndo size={13} aria-hidden="true" /></button>}
          <button type="button" className="codex-toolbar-btn" onClick={inspectFirst}>查看变更<IconArrowUpRight size={12} aria-hidden="true" /></button>
        </div>
      </div>

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
