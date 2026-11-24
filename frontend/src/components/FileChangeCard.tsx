import { useId, useMemo, useState } from 'react';
import type { ComputedFileDiff } from '../utils/diff';
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
  const visibleLines = useMemo(() => {
    const keep = new Set<number>();
    lines.forEach((line, index) => {
      if (line.kind === 'context') return;
      for (let i = Math.max(0, index - 2); i <= Math.min(lines.length - 1, index + 2); i++) keep.add(i);
    });
    return keep.size ? lines.filter((_, index) => keep.has(index)).slice(0, 120) : lines.slice(0, 60);
  }, [lines]);

  const visibleHunks = useMemo(() => {
    if (!hunks?.length) return null;
    let remaining = 120;
    const out: Array<{ header: string; lines: typeof lines }> = [];
    for (const hunk of hunks) {
      if (remaining <= 0) break;
      const sliced = hunk.lines.slice(0, remaining);
      remaining -= sliced.length;
      out.push({ header: hunk.header, lines: sliced });
    }
    return out;
  }, [hunks]);

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
          <div className="codex-inline-diff-body">
            {visibleHunks ? (
              visibleHunks.map((hunk, hIdx) => (
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
                  {hunk.lines.map((line, lIdx) => (
                    <div key={`${hIdx}:${lIdx}:${line.kind}:${line.oldLine ?? ''}:${line.newLine ?? ''}`} className="codex-inline-diff-row" data-kind={line.kind}>
                      <span className="codex-inline-diff-ln">{line.newLine ?? line.oldLine ?? ''}</span>
                      <span>{line.text || ' '}</span>
                    </div>
                  ))}
                </div>
              ))
            ) : visibleLines.length === 0 ? (
              <div style={{ padding: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>无文本行差异</div>
            ) : visibleLines.map((line, lIdx) => (
              <div key={`${lIdx}:${line.kind}:${line.oldLine ?? ''}:${line.newLine ?? ''}`} className="codex-inline-diff-row" data-kind={line.kind}>
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
