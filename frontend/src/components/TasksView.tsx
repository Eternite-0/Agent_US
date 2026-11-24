import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project, Task } from '../types/backend';
import { fmtClock, fmtRelative, fmtStatusLabel, taskTitle } from '../utils/format';
import {
  formatNextRunAt,
  getDefaultTimezone,
  getTimezoneOptions,
  normalizeHourlyMinute,
  type ScheduleDraftInput,
  type ScheduledTaskItem,
} from '../utils/schedulePayload';
import {
  IconArrowBack,
  IconBell,
  IconFileDoc,
  IconRailClock,
  IconClose,
  IconFolder,
  IconPause,
  IconPlay,
  IconSearch,
} from './Icons';

export type { ScheduledTaskItem };

interface TasksViewProps {
  toolbarHost: HTMLElement | null;
  scheduledTasks: ScheduledTaskItem[];
  tasks: Task[];
  projects: Project[];
  selectedProjectId: string | null;
  onCreateScheduled: (item: ScheduleDraftInput) => Promise<void> | void;
  onUpdateScheduled: (id: string, patch: Partial<ScheduledTaskItem>) => Promise<void> | void;
  onDeleteScheduled: (id: string) => Promise<void> | void;
  onRunScheduledNow: (item: ScheduledTaskItem) => Promise<void>;
  onSelectTask: (taskId: string) => void;
}

const SCHEDULE_SUGGESTIONS = [
  { title: '每日简报', meta: '工作日 8:00', time: '08:00', cron: '0 8 * * 1-5', icon: IconBell, tone: 'info',
    description: '汇总工作区里的待办、近期更新与优先事项。', prompt: '检查当前工作区可以访问的任务、文档和近期更新，整理一份简明的工作日简报。' },
  { title: '每周回顾', meta: '星期五 16:00', time: '16:00', cron: '0 16 * * 5', icon: IconFileDoc, tone: 'purple',
    description: '每周五把最近的工作整理成简明的状态更新。', prompt: '根据工作区里可用的记录和最近一周的改动，整理本周进展、未解决的问题和下周建议。' },
  { title: '跟进监控', meta: '工作日 9:00', time: '09:00', cron: '0 9 * * 1-5', icon: IconSearch, tone: 'success',
    description: '查看最近的工作区活动，标记需要跟进的事项。', prompt: '查看当前工作区的近期更新，列出需要跟进、复查或等待回复的事项，并说明依据。' },
] as const;

const IconFilterLines: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2.5 4h11M4.5 8h7M6.5 12h3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
  </svg>
);

function fmtScheduleSummary(item: ScheduledTaskItem): string {
  if (item.frequency === 'hourly') {
    const min = normalizeHourlyMinute(item.hourlyMinute);
    return min === 0 ? '每小时整点 (:00)' : `每小时第 ${String(min).padStart(2, '0')} 分`;
  }
  if (item.frequency === 'daily') return `每天 ${item.time}`;
  if (item.frequency === 'weekly') return `每周${item.weekday} ${item.time}`;
  return item.cronExpr || '0 9 * * *';
}

export const TasksView: React.FC<TasksViewProps> = ({
  toolbarHost,
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
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'active' | 'paused'>('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const systemTimezone = useMemo(() => getDefaultTimezone(), []);

  // Create / Edit form state
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [projectId, setProjectId] = useState<string>(selectedProjectId || projects[0]?.id || '');
  const [frequency, setFrequency] = useState<ScheduledTaskItem['frequency']>('daily');
  const [hourlyMinute, setHourlyMinute] = useState<number>(0);
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState('一');
  const [cronExpr, setCronExpr] = useState('0 9 * * 1-5');
  const [timezone, setTimezone] = useState<string>(systemTimezone);

  const timezoneOptions = useMemo(() => getTimezoneOptions(timezone), [timezone]);

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
        item.prompt.toLowerCase().includes(q) ||
        item.timezone.toLowerCase().includes(q)
      );
    });
  }, [scheduledTasks, search, filterMode]);

  const activeItems = filtered.filter((i) => !i.paused);
  const pausedItems = filtered.filter((i) => i.paused);
  const selectedItem = scheduledTasks.find((i) => i.id === selectedId) ?? null;

  const openNewModal = (suggestion?: typeof SCHEDULE_SUGGESTIONS[number]) => {
    setEditingId(null);
    setTitle(suggestion?.title ?? '');
    setPrompt(suggestion?.prompt ?? '');
    setProjectId(selectedProjectId || projects[0]?.id || '');
    setFrequency(suggestion ? 'cron' : 'daily');
    setHourlyMinute(0);
    setTime(suggestion?.time ?? '09:00');
    setWeekday('一');
    setCronExpr(suggestion?.cron ?? '0 9 * * 1-5');
    setTimezone(getDefaultTimezone());
    setFormError(null);
    setModalOpen(true);
  };

  const openEditModal = (item: ScheduledTaskItem) => {
    setEditingId(item.id);
    setTitle(item.title);
    setPrompt(item.prompt);
    setProjectId(item.projectId || '');
    setFrequency(item.frequency);
    setHourlyMinute(normalizeHourlyMinute(item.hourlyMinute));
    setTime(item.time || '09:00');
    setWeekday(item.weekday || '一');
    setCronExpr(item.cronExpr || '0 9 * * 1-5');
    // Strictly preserve the schedule's explicitly saved timezone — never overwrite with browser default
    setTimezone(item.timezone || 'UTC');
    setFormError(null);
    setModalOpen(true);
  };

  const handleSaveModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || saving) return;
    setSaving(true);
    setFormError(null);
    try {
      const cleanPrompt = prompt.trim();
      const cleanTitle = title.trim() || taskTitle(cleanPrompt);
      const cleanTz = timezone.trim() || getDefaultTimezone();

      if (editingId) {
        await onUpdateScheduled(editingId, {
          title: cleanTitle,
          prompt: cleanPrompt,
          projectId: projectId || null,
          frequency,
          hourlyMinute: normalizeHourlyMinute(hourlyMinute),
          time,
          weekday,
          cronExpr,
          timezone: cleanTz,
        });
      } else {
        await onCreateScheduled({
          title: cleanTitle,
          prompt: cleanPrompt,
          projectId: projectId || null,
          frequency,
          hourlyMinute: normalizeHourlyMinute(hourlyMinute),
          time,
          weekday,
          cronExpr,
          timezone: cleanTz,
          paused: false,
        });
      }
      setModalOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存定时任务失败，请检查配置');
    } finally {
      setSaving(false);
    }
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
    <div className="codex-library-page">
      {toolbarHost && createPortal(
        <div className="codex-library-toolbar">
          {selectedItem && (
            <button type="button" className="codex-toolbar-btn" onClick={() => setSelectedId(null)}>
              <IconArrowBack size={15} /> 返回任务列表
            </button>
          )}
          <div className="codex-library-actions">
            <button type="button" className="codex-toolbar-btn" data-variant="primary"
              aria-label="新建任务" onClick={() => openNewModal()}>创建</button>
          </div>
        </div>, toolbarHost)}
      <div className="codex-library-scroll">
        {!selectedItem ? (
          <div className="codex-library-inner codex-library-detail-enter">
            <header className="codex-library-heading">
              <h1>已安排的任务</h1>
              <p>安排重复任务、设置提醒或监测工作区更新</p>
            </header>
            <div className="codex-library-filters codex-schedule-search-row">
              <label className="codex-library-search">
                <IconSearch size={16} />
                <input type="search" aria-label="搜索已安排任务" placeholder="搜索已安排任务"
                  value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
              {scheduledTasks.length > 0 && (
                <button type="button" className="codex-icon-btn" data-active={filterMode !== 'all' || undefined}
                  aria-label={`筛选定时任务：${filterMode === 'all' ? '全部' : filterMode === 'active' ? '仅启用' : '仅已暂停'}`}
                  title="切换任务状态筛选" onClick={cycleFilter}><IconFilterLines /></button>
              )}
            </div>
            {([['已启用', activeItems], ['已暂停', pausedItems]] as const).map(([label, entries]) => entries.length > 0 && (
                <section key={label} className="codex-library-group">
                  <h2 className="codex-custom-cat-heading">{label}</h2>
                  {entries.map((item) => (
                    <button key={item.id} type="button" className="codex-schedule-row" onClick={() => setSelectedId(item.id)}>
                      <IconRailClock size={17} color={item.paused ? 'var(--text-tertiary)' : 'var(--color-success)'} />
                      <span className="codex-schedule-row-copy">
                        <span><strong>{item.title}</strong> <small>{fmtScheduleSummary(item)}</small></span>
                        <span className="codex-schedule-row-description">{item.prompt}</span>
                      </span>
                    </button>
                  ))}
                </section>
            ))}
            {(search.trim() || filterMode !== 'all') && filtered.length === 0 && (
              <p className="codex-library-source" role="status">没有匹配的任务。</p>
            )}
            {!search.trim() && filterMode === 'all' && (
              <section className="codex-library-group codex-schedule-suggestions" aria-labelledby="schedule-suggestions">
                <h2 id="schedule-suggestions" className="codex-schedule-suggestion-heading">建议</h2>
                {SCHEDULE_SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion.title} type="button" className="codex-schedule-row" data-tone={suggestion.tone}
                    onClick={() => openNewModal(suggestion)}>
                    <suggestion.icon size={17} />
                    <span className="codex-schedule-row-copy">
                      <span><strong>{suggestion.title}</strong> <small>{suggestion.meta}</small></span>
                      <span className="codex-schedule-row-description">{suggestion.description}</span>
                    </span>
                  </button>
                ))}
              </section>
            )}
          </div>
        ) : (
          <div className="codex-library-inner codex-library-detail-enter" key={selectedItem.id}>
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
                    flexWrap: 'wrap',
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
                  <span>·</span>
                  <span>{selectedItem.timezone}</span>
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
                  onClick={() => openEditModal(selectedItem)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="outline"
                  onClick={() =>
                    void Promise.resolve(
                      onUpdateScheduled(selectedItem.id, { paused: !selectedItem.paused }),
                    ).catch(() => {})
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
                    void Promise.resolve(onDeleteScheduled(selectedItem.id))
                      .then(() => setSelectedId(null))
                      .catch(() => {});
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
              <div className="codex-settings-row">
                <div className="codex-settings-row-meta">
                  <div className="codex-settings-label">执行时区</div>
                  <div className="codex-settings-desc">后端按此 IANA 时区计算触发时刻</div>
                </div>
                <span className="codex-status-chip" style={{ fontFamily: 'var(--font-mono)' }}>
                  {selectedItem.timezone}
                </span>
              </div>
              <div className="codex-settings-row">
                <div className="codex-settings-row-meta">
                  <div className="codex-settings-label">下次执行</div>
                  <div className="codex-settings-desc">
                    {selectedItem.paused
                      ? '任务已暂停，恢复后重新计算触发时间'
                      : `按 ${selectedItem.timezone} 时区显示的下一次计划触发时间`}
                  </div>
                </div>
                <span className="codex-status-chip tabular-nums">
                  {selectedItem.paused
                    ? '已暂停'
                    : formatNextRunAt(selectedItem.nextRunAt, selectedItem.timezone)}
                </span>
              </div>
              {selectedItem.lastStatus && (
                <div className="codex-settings-row">
                  <div className="codex-settings-row-meta">
                    <div className="codex-settings-label">最近状态</div>
                    <div className="codex-settings-desc">
                      {selectedItem.lastRunAt
                        ? `上次触发于 ${formatNextRunAt(selectedItem.lastRunAt, selectedItem.timezone)}`
                        : '最近一次运行的最终收敛状态'}
                    </div>
                  </div>
                  <span className="codex-status-chip">{fmtStatusLabel(selectedItem.lastStatus)}</span>
                </div>
              )}
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

      {/* Create / Edit Scheduled Task Modal */}
      {modalOpen && (
        <div
          className="codex-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={editingId ? '编辑定时任务' : '新建定时任务'}
          onClick={(e) => {
            if (e.target === e.currentTarget && !saving) setModalOpen(false);
          }}
        >
          <form
            className="codex-modal-card"
            style={{ width: 'min(480px, 100%)' }}
            onSubmit={(e) => void handleSaveModal(e)}
          >
            <div className="codex-modal-header">
              <h2 className="codex-modal-title">{editingId ? '编辑定时任务' : '新建定时任务'}</h2>
              <button
                type="button"
                className="codex-icon-btn"
                style={{ width: 26, height: 26 }}
                aria-label="关闭"
                disabled={saving}
                onClick={() => setModalOpen(false)}
              >
                <IconClose size={15} />
              </button>
            </div>

            {formError && (
              <div
                role="alert"
                style={{
                  marginBottom: 12,
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-danger)',
                  color: 'var(--color-danger)',
                  fontSize: 12.5,
                  lineHeight: '18px',
                  background: 'color-mix(in srgb, var(--color-danger) 8%, transparent)',
                }}
              >
                {formError}
              </div>
            )}

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

            {frequency === 'hourly' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                  每小时触发分钟 (0-59)
                </span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  className="codex-input"
                  style={{ height: 34, width: 96 }}
                  value={hourlyMinute}
                  onChange={(e) => setHourlyMinute(normalizeHourlyMinute(e.target.value))}
                />
              </div>
            )}

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

            <div style={{ marginTop: 12 }}>
              <div className="codex-modal-section-label" style={{ marginTop: 0 }}>
                执行时区 (IANA)
              </div>
              <select
                className="codex-select"
                style={{ width: '100%', height: 34, fontFamily: 'var(--font-mono)' }}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              >
                {timezoneOptions.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz === systemTimezone ? `${tz} (系统默认)` : tz}
                  </option>
                ))}
              </select>
            </div>

            <div className="codex-modal-footer">
              <button
                type="button"
                className="codex-modal-cancel-btn"
                disabled={saving}
                onClick={() => setModalOpen(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className="codex-modal-primary-btn"
                disabled={!prompt.trim() || saving}
              >
                {saving ? '保存中…' : editingId ? '保存修改' : '保存定时任务'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
