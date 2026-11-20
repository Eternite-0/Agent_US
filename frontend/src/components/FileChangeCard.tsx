import React, { useState } from 'react';
import type { ComputedFileDiff } from '../utils/diff';
import { splitPath } from '../utils/format';
import { Collapsible } from './Collapsible';
import {
  IconArrowUpRight,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconDiffBox,
  IconUndo,
} from './Icons';

interface FileChangeCardProps {
  files: ComputedFileDiff[];
  onInspectFile: (path?: string) => void;
  onUndo?: () => void;
  onCopy?: (msg: string) => void;
}

const INITIAL_VISIBLE = 3;

export const FileChangeCard: React.FC<FileChangeCardProps> = ({
  files,
  onInspectFile,
  onUndo,
  onCopy,
}) => {
  const [expandedList, setExpandedList] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  if (!files.length) return null;

  const totalAdd = files.reduce((s, f) => s + f.added, 0);
  const totalDel = files.reduce((s, f) => s + f.deleted, 0);
  const primary = files.slice(0, INITIAL_VISIBLE);
  const rest = files.slice(INITIAL_VISIBLE);

  const toggleFile = (path: string) => {
    setExpandedFiles((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const handleCopyFile = async (f: ComputedFileDiff, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(f.afterText);
      setCopiedPath(f.path);
      onCopy?.(`已复制 ${f.path}`);
      window.setTimeout(() => setCopiedPath((cur) => (cur === f.path ? null : cur)), 1200);
    } catch {
      // ignore
    }
  };

  const renderRow = (f: ComputedFileDiff) => {
    const { dir, name } = splitPath(f.path);
    const isOpen = Boolean(expandedFiles[f.path]);
    // Compute compact hunk preview (changed lines + 2 context lines around each change)
    const keep = new Set<number>();
    f.lines.forEach((l, idx) => {
      if (l.kind !== 'context') {
        for (let k = Math.max(0, idx - 2); k <= Math.min(f.lines.length - 1, idx + 2); k++) {
          keep.add(k);
        }
      }
    });
    const visibleLines = keep.size
      ? f.lines.filter((_, idx) => keep.has(idx)).slice(0, 120)
      : f.lines.slice(0, 60);

    return (
      <div key={f.path} className="codex-file-row-wrap">
        <div
          role="button"
          tabIndex={0}
          className="codex-file-row"
          aria-expanded={isOpen}
          title={isOpen ? '点击收起变更预览' : '点击展开内联变更预览'}
          onClick={() => toggleFile(f.path)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleFile(f.path);
            }
          }}
        >
          <span className="codex-file-path" style={{ gap: 6 }}>
            <IconChevronRight
              size={13}
              style={{
                flex: 'none',
                color: 'var(--text-tertiary)',
                transition: 'transform var(--duration-basic) var(--ease-out)',
                transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              }}
            />
            {dir && <span className="codex-file-dir">{dir}</span>}
            <span className="codex-file-name">{name}</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none' }}>
            <span className="codex-diff-counts tabular-nums">
              <span className="codex-git-add">+{f.added}</span>
              <span className="codex-git-del">-{f.deleted}</span>
            </span>
            <button
              type="button"
              className="codex-icon-btn"
              style={{ width: 22, height: 22 }}
              title="在右侧分屏打开"
              aria-label={`在右侧分屏打开 ${f.path}`}
              onClick={(e) => {
                e.stopPropagation();
                onInspectFile(f.path);
              }}
            >
              <IconArrowUpRight size={13} />
            </button>
          </span>
        </div>

        <Collapsible open={isOpen}>
          <div className="codex-file-inline-diff">
            <div className="codex-inline-diff-head">
              <button
                type="button"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  color: 'var(--text-default)',
                  fontWeight: 500,
                  fontSize: 12,
                }}
                onClick={() => onInspectFile(f.path)}
              >
                <span>{f.path}</span>
                <span className="codex-diff-counts tabular-nums" style={{ fontSize: 11.5 }}>
                  <span className="codex-git-add">+{f.added}</span>
                  <span className="codex-git-del">-{f.deleted}</span>
                </span>
              </button>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <button
                  type="button"
                  className="codex-icon-btn"
                  style={{ width: 22, height: 22 }}
                  title="复制文件内容"
                  onClick={(e) => void handleCopyFile(f, e)}
                >
                  {copiedPath === f.path ? <IconCheck size={13} /> : <IconCopy size={13} />}
                </button>
                <button
                  type="button"
                  className="codex-icon-btn"
                  style={{ width: 22, height: 22 }}
                  title="在右侧完整视图打开"
                  onClick={() => onInspectFile(f.path)}
                >
                  <IconArrowUpRight size={13} />
                </button>
              </div>
            </div>
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
        </Collapsible>
      </div>
    );
  };

  return (
    <div className="codex-file-card">
      <div
        className="codex-file-card-head"
        role="button"
        tabIndex={0}
        aria-label="查看已更改的文件"
        onClick={() => onInspectFile(files[0]?.path)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onInspectFile(files[0]?.path);
          }
        }}
      >
        <span className="codex-file-card-icon">
          <IconDiffBox size={20} />
        </span>
        <div className="codex-file-card-meta">
          <span className="codex-file-card-title">已编辑 {files.length} 个文件</span>
          <span className="codex-file-card-sub">
            <span className="codex-diff-default-sub codex-diff-counts tabular-nums">
              <span className="codex-git-add">+{totalAdd}</span>
              <span className="codex-git-del">-{totalDel}</span>
            </span>
            <span className="codex-diff-hover-sub">
              <span>查看变更</span>
              <IconArrowUpRight size={13} />
            </span>
          </span>
        </div>
        <div
          className="codex-file-card-actions"
          onClick={(e) => e.stopPropagation()}
        >
          {onUndo && (
            <button type="button" className="codex-toolbar-btn" onClick={onUndo}>
              <span>撤销</span>
              <IconUndo size={13} />
            </button>
          )}
          <button
            type="button"
            className="codex-toolbar-btn"
            data-variant="outline"
            onClick={() => onInspectFile(files[0]?.path)}
          >
            查看变更
          </button>
        </div>
      </div>

      <div>{primary.map(renderRow)}</div>

      {rest.length > 0 && (
        <>
          <Collapsible open={expandedList}>
            <div>{rest.map(renderRow)}</div>
          </Collapsible>
          <button
            type="button"
            className="codex-file-more-btn"
            aria-expanded={expandedList}
            onClick={() => setExpandedList((v) => !v)}
          >
            <span>{expandedList ? '收起文件列表' : `再显示 ${rest.length} 个文件`}</span>
            <IconChevronDown
              size={15}
              style={{
                transition: 'transform var(--duration-basic) var(--ease-out)',
                transform: expandedList ? 'rotate(180deg)' : 'rotate(0deg)',
              }}
            />
          </button>
        </>
      )}
    </div>
  );
};
