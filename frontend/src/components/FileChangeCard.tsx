import { useId, useMemo, useState } from 'react';
import type { ComputedFileDiff } from '../utils/diff';
import { splitPath } from '../utils/format';
import { ActivityCopyButton } from './ActivityPresentation';
import { Collapsible } from './Collapsible';
import { IconArrowUpRight, IconChevronDown, IconChevronRight, IconDiffBox, IconUndo } from './Icons';

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

function FileChangeRow({ file, hidden, listId, onInspectFile, onCopy }: {
  file: ComputedFileDiff;
  hidden: boolean;
  listId: string;
  onInspectFile: FileChangeCardProps['onInspectFile'];
  onCopy?: FileChangeCardProps['onCopy'];
}) {
  const [open, setOpen] = useState(false);
  const previewId = useId();
  const { path, added, deleted, lines, afterText } = file;
  const { dir, name } = splitPath(path);
  const visibleLines = useMemo(() => {
    const keep = new Set<number>();
    lines.forEach((line, index) => {
      if (line.kind === 'context') return;
      for (let i = Math.max(0, index - 2); i <= Math.min(lines.length - 1, index + 2); i++) keep.add(i);
    });
    return keep.size ? lines.filter((_, index) => keep.has(index)).slice(0, 120) : lines.slice(0, 60);
  }, [lines]);

  return (
    <div className="codex-file-row-wrap" hidden={hidden} data-scroll-anchor={`file:${listId}:${path}`}>
      <div className="codex-file-row">
        <button type="button" className="codex-file-row-trigger codex-activity-disclosure" aria-expanded={open}
          aria-controls={previewId} data-scroll-disclosure title={path} onClick={() => setOpen(!open)}>
          <span className="codex-file-path" style={{ gap: 6 }}>
            <IconChevronRight className="codex-direct-chevron" size={13} aria-hidden="true" />
            {dir && <span className="codex-file-dir">{dir}</span>}
            <span className="codex-file-name">{name}</span>
          </span>
          <DiffCounts added={added} deleted={deleted} />
        </button>
        <button type="button" className="codex-icon-btn codex-activity-copy"
          title="在右侧分屏打开" aria-label={`在右侧分屏打开 ${path}`} onClick={() => onInspectFile(path)}>
          <IconArrowUpRight size={13} aria-hidden="true" />
        </button>
      </div>
      <Collapsible id={previewId} open={open}>
        <div className="codex-file-inline-diff">
          <div className="codex-inline-diff-head">
            <button type="button" className="codex-inline-link-btn" onClick={() => onInspectFile(path)}><span>{path}</span></button>
            <ActivityCopyButton text={afterText} label="复制文件内容" onCopy={onCopy} />
          </div>
          <div className="codex-inline-diff-body">
            {visibleLines.length === 0 ? (
              <div style={{ padding: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>无文本行差异</div>
            ) : visibleLines.map((line) => (
              <div key={`${line.kind}:${line.oldLine ?? ''}:${line.newLine ?? ''}`} className="codex-inline-diff-row" data-kind={line.kind}>
                <span className="codex-inline-diff-ln">{line.newLine ?? line.oldLine ?? ''}</span>
                <span>{line.text || ' '}</span>
              </div>
            ))}
          </div>
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
          <span className="codex-file-card-icon"><IconDiffBox size={20} aria-hidden="true" /></span>
          <span className="codex-file-card-meta">
            <span className="codex-file-card-title">已编辑 {uniqueFiles.length} 个文件</span>
            <span className="codex-file-card-sub">
              <span className="codex-diff-default-sub"><DiffCounts added={totalAdd} deleted={totalDel} /></span>
              <span className="codex-diff-hover-sub"><span>查看变更</span><IconArrowUpRight size={13} aria-hidden="true" /></span>
            </span>
          </span>
        </button>
        <div className="codex-file-card-actions">
          {onUndo && <button type="button" className="codex-toolbar-btn" onClick={onUndo}><span>撤销</span><IconUndo size={13} aria-hidden="true" /></button>}
          <button type="button" className="codex-toolbar-btn" data-variant="outline" onClick={inspectFirst}>查看变更</button>
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
