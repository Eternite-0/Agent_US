import React, { useMemo, useState } from 'react';
import type { Project, Task } from '../types/backend';
import { fmtClock, fmtRelative, fmtStatusLabel, taskTitle } from '../utils/format';
import { Collapsible } from './Collapsible';
import {
  IconChevronRight,
  IconClose,
  IconFolder,
  IconPause,
  IconPlay,
  IconPlus,
  IconSearch,
} from './Icons';

export interface ScheduledTaskItem {
  id: string;
  title: string;
  prompt: string;
  projectId: string | null;
  frequency: 'daily' | 'weekly' | 'hourly' | 'cron';
  time: string;
  weekday: string;
  cronExpr: string;
  paused: boolean;
  lastRunTaskIds: string[];
  createdAt: number;
}

interface TasksViewProps {
  scheduledTasks: ScheduledTaskItem[];
  tasks: Task[];
  projects: Project[];
  selectedProjectId: string | null;
  onCreateScheduled: (item: Omit<ScheduledTaskItem, 'id' | 'lastRunTaskIds' | 'createdAt'>) => void;
  onUpdateScheduled: (id: string, patch: Partial<ScheduledTaskItem>) => void;
  onDeleteScheduled: (id: string) => void;
  onRunScheduledNow: (item: ScheduledTaskItem) => Promise<void>;
  onSelectTask: (taskId: string) => void;
}

const ClockIllustration: React.FC = () => (
  <svg width="46" height="46" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="24" cy="24" r="21" fill="var(--bg-surface-elevated)" stroke="var(--border-strong)" strokeWidth="2.5" />
    <circle cx="24" cy="24" r="17.5" fill="var(--bg-surface-secondary)" />
    <circle cx="24" cy="9.5" r="1.1" fill="var(--text-tertiary)" />
    <circle cx="38.5" cy="24" r="1.1" fill="var(--text-tertiary)" />
    <circle cx="24" cy="38.5" r="1.1" fill="var(--text-tertiary)" />
    <circle cx="9.5" cy="24" r="1.1" fill="var(--text-tertiary)" />
    <path d="M24 14.5V24" stroke="var(--text-default)" strokeWidth="2.2" strokeLinecap="round" />
    <path d="M24 24L30.5 27.5" stroke="var(--text-default)" strokeWidth="2" strokeLinecap="round" />
    <path d="M24 24L18.5 31.5" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="24" cy="24" r="2.2" fill="#ef4444" />
  </svg>
);

const IconFilterLines: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2.5 4h11M4.5 8h7M6.5 12h3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
  </svg>
);

function fmtScheduleSummary(item: ScheduledTaskItem): string {
  if (item.frequency === 'hourly') return '每小时执行';
  if (item.frequency === 'daily') return `每天 ${item.time}`;
  if (item.frequency === 'weekly') return `每周${item.weekday} ${item.time}`;
  return item.cronExpr || '0 9 * * *';
}

export const TasksView: React.FC<TasksViewProps> = ({
  scheduledTasks,
  tasks,
  projects,
  selectedProjectId,
  onCreateScheduled,
  onUpdateScheduled,
  onDeleteScheduled,
  onRunScheduledNow,
  onSelectTask,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pausedOpen, setPausedOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'active' | 'paused'>('all');
  const [creating, setCreating] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);

  // Create form state
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [projectId, setProjectId] = useState<string>(selectedProjectId || projects[0]?.id || '');
  const [frequency, setFrequency] = useState<ScheduledTaskItem['frequency']>('daily');
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState('一');
  const [cronExpr, setCronExpr] = useState('0 9 * * 1-5');

  const projectNameById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects],
  );
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scheduledTasks.filter((item) => {
      if (filterMode === 'active' && item.paused) return false;
      if (filterMode === 'paused' && !item.paused) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.prompt.toLowerCase().includes(q)
      );
    });
  }, [scheduledTasks, search, filterMode]);

  const activeItems = filtered.filter((i) => !i.paused);
  const pausedItems = filtered.filter((i) => i.paused);
  const selectedItem = scheduledTasks.find((i) => i.id === selectedId) ?? null;

  const openNewModal = () => {
    setTitle('');
    setPrompt('');
    setProjectId(selectedProjectId || projects[0]?.id || '');
    setFrequency('daily');
    setTime('09:00');
    setWeekday('一');
    setCronExpr('0 9 * * 1-5');
    setCreating(true);
  };

  const handleSaveNew = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    onCreateScheduled({
      title: title.trim() || taskTitle(prompt.trim()),
      prompt: prompt.trim(),
      projectId: projectId || null,
      frequency,
      time,
      weekday,
      cronExpr,
      paused: false,
    });
    setCreating(false);
  };

  const handleRunNow = async (item: ScheduledTaskItem) => {
    setRunningId(item.id);
    try {
      await onRunScheduledNow(item);
    } finally {
      setRunningId(null);
    }
  };

  const cycleFilter = () => {
    setFilterMode((cur) => (cur === 'all' ? 'active' : cur === 'active' ? 'paused' : 'all'));
  };

  return (
    <div className="codex-settings">
      {/* Left 288px 定时任务 Nav Panel (1:1 with User Screenshot) */}
      <nav className="codex-settings-nav" aria-label="定时任务">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 8px 10px 10px',
          }}
        >
          <span
            style={{
              fontSize: 15,
              lineHeight: '21px',
              fontWeight: 600,
              color: 'var(--text-default)',
            }}
          >
            定时任务
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <button
              type="button"
              className="codex-icon-btn"
              style={{ width: 26, height: 26 }}
              data-active={filterMode !== 'all' ? 'true' : undefined}
              title={`筛选：${filterMode === 'all' ? '全部' : filterMode === 'active' ? '仅启用' : '仅已暂停'}`}
              aria-label="筛选定时任务"
              onClick={cycleFilter}
            >
              <IconFilterLines />
            </button>
            <button
              type="button"
              className="codex-icon-btn"
              style={{ width: 26, height: 26 }}
              data-active={searchOpen ? 'true' : undefined}
              title="搜索定时任务"
              aria-label="搜索定时任务"
              onClick={() => {
                setSearchOpen((v) => !v);
                if (searchOpen) setSearch('');
              }}
            >
              <IconSearch size={15} />
            </button>
          </div>
        </div>

        {searchOpen && (
          <div className="codex-settings-search" style={{ marginBottom: 8 }}>
            <IconSearch size={14} style={{ color: 'var(--text-tertiary)', flex: 'none' }} />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索定时任务"
            />
          </div>
        )}

        <div style={{ padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button
            type="button"
            className="codex-sidebar-row"
            onClick={openNewModal}
          >
            <IconPlus size={15} style={{ color: 'var(--text-secondary)', flex: 'none' }} />
            <span className="codex-sidebar-row-text">新建任务</span>
          </button>

          {activeItems.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 6 }}>
              {activeItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="codex-sidebar-row"
                  data-selected={selectedId === item.id ? 'true' : undefined}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="codex-status-dot" data-tone="live" />
                  <span className="codex-sidebar-row-text">{item.title}</span>
                </button>
              ))}
            </div>
          )}

          {/* Collapsible 「已暂停 >」 Section (1:1 with User Screenshot) */}
          <div className="codex-section-header" style={{ paddingTop: 10 }}>
            <button
              type="button"
              className="codex-section-toggle"
              aria-expanded={pausedOpen}
              onClick={() => setPausedOpen((v) => !v)}
            >
              <span>已暂停</span>
              {pausedItems.length > 0 && (
                <span className="tabular-nums" style={{ fontSize: 11.5 }}>
                  ({pausedItems.length})
                </span>
              )}
              <span className="codex-section-chevron" style={{ opacity: 1 }}>
                <IconChevronRight size={13} />
              </span>
            </button>
          </div>

          <Collapsible open={pausedOpen}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {pausedItems.length === 0 ? (
                <div className="codex-sidebar-empty-hint" style={{ paddingLeft: 10 }}>
                  暂无已暂停的任务
                </div>
              ) : (
                pausedItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="codex-sidebar-row"
                    data-selected={selectedId === item.id ? 'true' : undefined}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className="codex-sidebar-row-text" style={{ color: 'var(--text-secondary)' }}>
                      {item.title}
                    </span>
                  </button>
                ))
              )}
            </div>
          </Collapsible>
        </div>
      </nav>

      {/* Main Rounded Card Surface (Exact Codex Canvas) */}
      <div className="codex-settings-content">
        {!selectedItem ? (
          /* Centered Empty State — 1:1 with User Screenshot */
          <div
            style={{
              height: '100%',
              minHeight: 'calc(100vh - 96px)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              gap: 10,
            }}
          >
            <ClockIllustration />
            <h2
              style={{
                margin: '4px 0 0',
                fontSize: 16,
                lineHeight: '22px',
                fontWeight: 600,
                color: 'var(--text-default)',
              }}
            >
              安排任务
            </h2>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                lineHeight: '19px',
                color: 'var(--text-tertiary)',
                maxWidth: 340,
              }}
            >
              Codex 可以帮你处理持续性任务，让你不必亲自动手。
            </p>
            <button
              type="button"
              className="codex-modal-primary-btn"
              style={{ marginTop: 10, height: 34, padding: '0 18px' }}
              onClick={openNewModal}
            >
              新建任务
            </button>
          </div>
        ) : (
          /* Selected Scheduled Task Detail */
          <div className="codex-settings-content-inner" style={{ maxWidth: 680 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 16,
                marginBottom: 18,
              }}
            >
              <div>
                <h1 className="codex-settings-title" style={{ fontSize: 22, marginBottom: 4 }}>
                  {selectedItem.title}
                </h1>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12.5,
                    color: 'var(--text-tertiary)',
                  }}
                >
                  <span
                    className="codex-status-dot"
                    data-tone={selectedItem.paused ? undefined : 'live'}
                  />
                  <span>{selectedItem.paused ? '已暂停' : '已启用'}</span>
                  <span>·</span>
                  <span>{fmtScheduleSummary(selectedItem)}</span>
                  {selectedItem.projectId && (
                    <>
                      <span>·</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <IconFolder size={13} />
                        {projectNameById.get(selectedItem.projectId) ?? '项目'}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="primary"
                  disabled={runningId === selectedItem.id}
                  onClick={() => void handleRunNow(selectedItem)}
                >
                  <IconPlay size={13} />
                  <span>{runningId === selectedItem.id ? '触发中…' : '立即运行'}</span>
                </button>
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="outline"
                  onClick={() =>
                    onUpdateScheduled(selectedItem.id, { paused: !selectedItem.paused })
                  }
                >
                  {selectedItem.paused ? <IconPlay size={13} /> : <IconPause size={13} />}
                  <span>{selectedItem.paused ? '恢复' : '暂停'}</span>
                </button>
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="outline"
                  style={{ color: 'var(--color-danger)' }}
                  onClick={() => {
                    onDeleteScheduled(selectedItem.id);
                    setSelectedId(null);
                  }}
                >
                  删除
                </button>
              </div>
            </div>

            <div className="codex-settings-group">
              <div className="codex-settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <div className="codex-settings-label">任务指令</div>
                <div
                  style={{
                    fontSize: 13.5,
                    lineHeight: '21px',
                    color: 'var(--text-default)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {selectedItem.prompt}
                </div>
              </div>
              <div className="codex-settings-row">
                <div className="codex-settings-row-meta">
                  <div className="codex-settings-label">触发周期</div>
                  <div className="codex-settings-desc">按此计划自动向后端提交任务</div>
                </div>
                <span className="codex-status-chip">{fmtScheduleSummary(selectedItem)}</span>
              </div>
            </div>

            <div className="codex-modal-section-label" style={{ marginTop: 22 }}>
              运行记录 ({selectedItem.lastRunTaskIds.length})
            </div>
            {selectedItem.lastRunTaskIds.length === 0 ? (
              <div
                style={{
                  padding: '24px 16px',
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid var(--border-subtle)',
                  textAlign: 'center',
                  fontSize: 13,
                  color: 'var(--text-tertiary)',
                }}
              >
                尚未触发过运行，点击右上角「立即运行」可立刻测试向实时后端提交任务
              </div>
            ) : (
              <div className="codex-settings-group">
                {selectedItem.lastRunTaskIds.map((tid) => {
                  const t = taskById.get(tid);
                  return (
                    <button
                      key={tid}
                      type="button"
                      className="codex-settings-row"
                      style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
                      onClick={() => onSelectTask(tid)}
                    >
                      <div className="codex-settings-row-meta">
                        <div className="codex-settings-label">
                          {t ? taskTitle(t.input) : `任务 ${tid.slice(0, 8)}`}
                        </div>
                        <div className="codex-settings-desc">
                          {t?.createdAt ? `${fmtClock(t.createdAt)} · ${fmtRelative(t.createdAt)}` : tid}
                        </div>
                      </div>
                      <span className="codex-status-chip">
                        {t ? fmtStatusLabel(t.status) : '查看会话'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create Scheduled Task Modal */}
      {creating && (
        <div
          className="codex-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="新建定时任务"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCreating(false);
          }}
        >
          <form className="codex-modal-card" style={{ width: 'min(480px, 100%)' }} onSubmit={handleSaveNew}>
            <div className="codex-modal-header">
              <h2 className="codex-modal-title">新建定时任务</h2>
              <button
                type="button"
                className="codex-icon-btn"
                style={{ width: 26, height: 26 }}
                aria-label="关闭"
                onClick={() => setCreating(false)}
              >
                <IconClose size={15} />
              </button>
            </div>

            <div className="codex-modal-input-box" style={{ marginBottom: 12 }}>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="任务名称（如：每日代码健康检查）"
              />
            </div>

            <div className="codex-modal-section-label" style={{ marginTop: 4 }}>
              执行指令
            </div>
            <textarea
              className="codex-input"
              rows={3}
              style={{
                width: '100%',
                height: 'auto',
                padding: '9px 12px',
                resize: 'vertical',
                lineHeight: '20px',
              }}
              placeholder="描述每次触发时让 Agent 自动执行的任务…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
              <div>
                <div className="codex-modal-section-label" style={{ marginTop: 0 }}>
                  所属项目
                </div>
                <select
                  className="codex-select"
                  style={{ width: '100%', height: 34 }}
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">不限定项目</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="codex-modal-section-label" style={{ marginTop: 0 }}>
                  重复频率
                </div>
                <select
                  className="codex-select"
                  style={{ width: '100%', height: 34 }}
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value as ScheduledTaskItem['frequency'])}
                >
                  <option value="daily">每天</option>
                  <option value="weekly">每周</option>
                  <option value="hourly">每小时</option>
                  <option value="cron">自定义 Cron</option>
                </select>
              </div>
            </div>

            {(frequency === 'daily' || frequency === 'weekly') && (
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                {frequency === 'weekly' && (
                  <select
                    className="codex-select"
                    style={{ height: 34 }}
                    value={weekday}
                    onChange={(e) => setWeekday(e.target.value)}
                  >
                    {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
                      <option key={d} value={d}>
                        每周{d}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  type="time"
                  className="codex-input"
                  style={{ height: 34, flex: 1 }}
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </div>
            )}

            {frequency === 'cron' && (
              <input
                className="codex-input"
                style={{ width: '100%', height: 34, marginTop: 10, fontFamily: 'var(--font-mono)' }}
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                placeholder="0 9 * * 1-5"
              />
            )}

            <div className="codex-modal-footer">
              <button
                type="button"
                className="codex-modal-cancel-btn"
                onClick={() => setCreating(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className="codex-modal-primary-btn"
                disabled={!prompt.trim()}
              >
                保存定时任务
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
