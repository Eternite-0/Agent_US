import React, { useEffect, useRef, useState } from 'react';
import type { Worker } from '../types/backend';
import type { ComputedFileDiff } from '../utils/diff';
import { getWorkerActivityLabel, getWorkerDisplayName } from '../utils/worker';
import { AgentAvatar } from './AgentAvatar';
import {
  IconDiffBox,
  IconDotsHorizontal,
  IconFileDoc,
  IconPlus,
  IconChevronDown,
} from './Icons';

interface AgentCompanionCardProps {
  workers: Worker[];
  diffs: ComputedFileDiff[];
  sourceFiles: string[];
  onOpenChanges: () => void;
  onOpenSubagents: () => void;
  onOpenFile: (path: string) => void;
  onOpenEvents: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

/**
 * Floating top-right "Agent" Companion Card (1:1 with Codex Desktop screenshots 1 & 2).
 * Shows live diff totals, colorful subagent identity stack, and clickable source files.
 */
export const AgentCompanionCard: React.FC<AgentCompanionCardProps> = ({
  workers,
  diffs,
  sourceFiles,
  onOpenChanges,
  onOpenSubagents,
  onOpenFile,
  onOpenEvents,
  collapsed = false,
  onToggleCollapsed,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const isCollapsed = collapsed || localCollapsed;
  const [showAllSources, setShowAllSources] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const totalAdd = diffs.reduce((s, d) => s + d.added, 0);
  const totalDel = diffs.reduce((s, d) => s + d.deleted, 0);

  // Deduplicate retries by assignmentId and exclude internal control-plane (assignmentId === null)
  const displayWorkers = React.useMemo(() => {
    const subWorkers = workers.filter((w) => w.assignmentId !== null);
    const pool = subWorkers.length > 0 ? subWorkers : workers;
    const byAsgn = new Map<string, Worker>();
    for (const w of pool) {
      const k = w.assignmentId || w.id;
      const prev = byAsgn.get(k);
      if (!prev || (w.attempt ?? 1) >= (prev.attempt ?? 1)) {
        byAsgn.set(k, w);
      }
    }
    return [...byAsgn.values()];
  }, [workers]);

  const activeCount = displayWorkers.filter((w) => w.status === 'running').length;
  const doneCount = displayWorkers.filter((w) => w.status === 'done').length;
  const failedCount = displayWorkers.filter((w) => w.status === 'failed').length;

  const allSources = Array.from(
    new Set([...sourceFiles, ...diffs.map((d) => d.path)]),
  );
  const visibleSources = showAllSources ? allSources : allSources.slice(0, 3);
  const hasMoreSources = allSources.length > visibleSources.length;

  return (
    <aside className="codex-agent-card" data-collapsed={isCollapsed ? 'true' : undefined} aria-label="Agent 汇总面板">
      <button
        type="button"
        className="codex-agent-collapse"
        aria-label={isCollapsed ? '展开 Agent 面板' : '收起 Agent 面板'}
        aria-expanded={!isCollapsed}
        title={isCollapsed ? '展开 Agent' : '收起 Agent'}
        onClick={() => { onToggleCollapsed?.(); if (!onToggleCollapsed) setLocalCollapsed((value) => !value); }}
      >
        <IconChevronDown size={14} />
      </button>
      {/* Header */}
      <div className="codex-agent-card-head">
        <div className="codex-agent-presence">
          <AgentAvatar seed={displayWorkers[0] ? `${displayWorkers[0].id}-${displayWorkers[0].role}` : 'main-agent'} size={17} />
          <span className="codex-agent-presence-copy">
            <strong>{getWorkerDisplayName(displayWorkers[0])}</strong>
            <small>
              {activeCount > 0
                ? getWorkerActivityLabel(displayWorkers.find((w) => w.status === 'running')) || '正在工作'
                : failedCount > 0
                  ? '需要关注'
                  : '就绪'}
            </small>
          </span>
        </div>
        <div style={{ position: 'relative' }} ref={menuRef}>
          <button
            type="button"
            className="codex-icon-btn"
            style={{ width: 22, height: 22 }}
            aria-label="Agent 面板选项"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <IconDotsHorizontal size={14} />
          </button>
          {menuOpen && (
            <div className="codex-popover" data-side="bottom" style={{ right: 0, width: 184 }}>
              <button
                type="button"
                className="codex-popover-item"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSubagents();
                }}
              >
                <span>打开子智能体面板</span>
              </button>
              <button
                type="button"
                className="codex-popover-item"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenChanges();
                }}
              >
                <span>打开文件变更</span>
              </button>
              <button
                type="button"
                className="codex-popover-item"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenEvents();
                }}
              >
                <span>查看 SSE 与版本历史</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {!isCollapsed && (
        <>
      {/* Row 1: 变更 (+N -M) */}
      <button
        type="button"
        className="codex-agent-card-row"
        onClick={onOpenChanges}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--text-default)', fontWeight: 500 }}>
          <IconDiffBox size={15} style={{ color: 'var(--text-secondary)' }} />
          <span>变更</span>
        </span>
        {diffs.length > 0 ? (
          <span className="codex-diff-counts tabular-nums" style={{ fontSize: 12 }}>
            <span className="codex-git-add">+{totalAdd.toLocaleString()}</span>
            <span className="codex-git-del">-{totalDel.toLocaleString()}</span>
          </span>
        ) : (
          <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>0 文件</span>
        )}
      </button>

      {/* Section 2: 子智能体 */}
      <div className="codex-agent-card-section">
        <div className="codex-agent-card-label">子智能体</div>
        <button
          type="button"
          className="codex-agent-card-row"
          onClick={onOpenSubagents}
        >
          <span className="codex-agent-avatar-strip">
            {displayWorkers.length > 0 ? (
              displayWorkers.slice(0, 4).map((w) => (
                <AgentAvatar key={w.id} seed={`${w.id}-${w.role}`} size={15} />
              ))
            ) : (
              <AgentAvatar seed="main-agent" size={15} />
            )}
          </span>
          <span className="tabular-nums" style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            {displayWorkers.length === 0
              ? '等待调度'
              : activeCount > 0
                ? `${activeCount} 运行中 · ${doneCount} 完成`
                : failedCount > 0 && doneCount > 0
                  ? `${doneCount} 完成 · ${failedCount} 未完`
                  : `${doneCount || displayWorkers.length} 完成`}
          </span>
        </button>
      </div>

      {/* Section 3: 来源 */}
      <div className="codex-agent-card-section">
        <div className="codex-agent-card-label-row">
          <span className="codex-agent-card-label">来源</span>
          <button
            type="button"
            className="codex-icon-btn"
            style={{ width: 20, height: 20 }}
            title="打开所有变更与产物"
            onClick={onOpenChanges}
          >
            <IconPlus size={13} />
          </button>
        </div>

        {visibleSources.length === 0 ? (
          <div style={{ padding: '3px 6px', fontSize: 12, color: 'var(--text-tertiary)' }}>
            暂无关联文件
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {visibleSources.map((path) => (
              <button
                key={path}
                type="button"
                className="codex-agent-source-row"
                title={path}
                onClick={() => onOpenFile(path)}
              >
                <IconFileDoc size={13} style={{ color: 'var(--text-tertiary)', flex: 'none' }} />
                <span className="codex-agent-source-name">{path}</span>
              </button>
            ))}
            {(hasMoreSources || showAllSources) && allSources.length > 3 && (
              <button
                type="button"
                className="codex-agent-source-row"
                style={{ color: 'var(--text-tertiary)' }}
                onClick={() => setShowAllSources((v) => !v)}
              >
                <span>{showAllSources ? '收起' : `查看全部 (${allSources.length})`}</span>
              </button>
            )}
          </div>
        )}
      </div>
        </>
      )}
    </aside>
  );
};
