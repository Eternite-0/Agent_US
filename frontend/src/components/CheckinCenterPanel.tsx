import React, { useCallback, useEffect, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type { CheckinCenterResponse, CheckinRecordRow } from '../types/backend';
import { IconChevronDown, IconChevronRight } from './Icons';
import { ProviderLogo } from './ProviderLogo';

interface CheckinCenterPanelProps {
  client: AgentBackendClient;
  onToast: (msg: string, tone?: 'default' | 'success' | 'warning' | 'danger') => void;
}

type TopTab = 'center' | 'schedule' | 'makeup' | 'records';
type SectionTab = 'daily' | 'onboarding' | 'plans' | 'growth';

function fmtTime(ts?: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const CheckinCenterPanel: React.FC<CheckinCenterPanelProps> = ({
  client,
  onToast,
}) => {
  const [topTab, setTopTab] = useState<TopTab>('center');
  const [section, setSection] = useState<SectionTab>('daily');
  const [center, setCenter] = useState<CheckinCenterResponse | null>(null);
  const [records, setRecords] = useState<CheckinRecordRow[]>([]);
  const [recordsTotal, setRecordsTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Bridge settings drawer
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [bridgeMode, setBridgeMode] = useState<'auto' | 'bridge' | 'local'>('auto');
  const [bridgeUrl, setBridgeUrl] = useState('http://127.0.0.1:3065');
  const [bridgeApiKey, setBridgeApiKey] = useState('');
  const [bridgePanelToken, setBridgePanelToken] = useState('');
  const [testingBridge, setTestingBridge] = useState(false);

  // Schedule form
  const [schedLabel, setSchedLabel] = useState('每日自动签到');
  const [schedTime, setSchedTime] = useState('09:05');
  const [schedTimeEnd, setSchedTimeEnd] = useState('09:30');
  const [schedRetryTime, setSchedRetryTime] = useState('21:00');
  const [schedRetryGap, setSchedRetryGap] = useState(30);
  const [schedRetryLimit, setSchedRetryLimit] = useState(2);

  // Records filters
  const [recOutcome, setRecOutcome] = useState('');
  const [recKeyword, setRecKeyword] = useState('');

  const loadCenter = useCallback(async () => {
    if (!client.getCheckinCenter) return;
    setLoading(true);
    try {
      const res = await client.getCheckinCenter();
      setCenter(res);
      setBridgeMode(res.bridge.mode);
      if (res.bridge.baseUrl) setBridgeUrl(res.bridge.baseUrl);
    } catch (err) {
      onToast(err instanceof Error ? err.message : '加载签到中心失败', 'warning');
    } finally {
      setLoading(false);
    }
  }, [client, onToast]);

  const loadRecords = useCallback(async () => {
    if (!client.getCheckinRecords) return;
    try {
      const res = await client.getCheckinRecords({
        outcome: recOutcome || undefined,
        keyword: recKeyword.trim() || undefined,
        limit: 80,
        offset: 0,
      });
      setRecords(res.records ?? []);
      setRecordsTotal(res.total ?? 0);
    } catch {
      // ignore
    }
  }, [client, recOutcome, recKeyword]);

  useEffect(() => {
    void loadCenter();
  }, [loadCenter]);

  useEffect(() => {
    if (topTab === 'records') void loadRecords();
  }, [topTab, loadRecords]);

  const handleRunAll = async () => {
    if (!client.runCheckin) return;
    setRunningAll(true);
    try {
      const res = await client.runCheckin({ section });
      await loadCenter();
      onToast(
        `签到执行完成：成功 ${String(res.succeeded ?? 0)} / 共 ${String(res.total ?? 0)}`,
        Number(res.succeeded ?? 0) > 0 ? 'success' : 'default',
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : '全部签到失败', 'danger');
    } finally {
      setRunningAll(false);
    }
  };

  const handleRunSingle = async (accountId: string) => {
    if (!client.runCheckin) return;
    setRunningId(accountId);
    try {
      await client.runCheckin({ accountId, section });
      await loadCenter();
      onToast('单账号签到执行完成', 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : '单账号签到失败', 'danger');
    } finally {
      setRunningId(null);
    }
  };

  const handleToggleAuto = async () => {
    if (!client.setAutoCheckin || !center) return;
    const next = !center.auto.enabled;
    await client.setAutoCheckin(next);
    await loadCenter();
    onToast(next ? '已开启自动定时签到' : '已暂停自动定时签到', next ? 'success' : 'default');
  };

  const handleSaveSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client.saveCheckinSchedule) return;
    await client.saveCheckinSchedule({
      label: schedLabel.trim() || '每日自动签到',
      enabled: true,
      time: schedTime,
      timeEnd: schedTimeEnd || undefined,
      providers: [],
      retryTime: schedRetryTime,
      retryGapMinutes: schedRetryGap,
      retryLimit: schedRetryLimit,
    });
    await loadCenter();
    onToast('已保存签到计划', 'success');
  };

  const handleSaveBridge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client.saveCheckinBridge) return;
    await client.saveCheckinBridge({
      mode: bridgeMode,
      baseUrl: bridgeUrl.trim(),
      ...(bridgeApiKey.trim() ? { apiKey: bridgeApiKey.trim() } : {}),
      ...(bridgePanelToken.trim() ? { panelToken: bridgePanelToken.trim() } : {}),
    });
    setBridgeApiKey('');
    setBridgePanelToken('');
    await loadCenter();
    onToast('已保存签到协议桥接配置', 'success');
  };

  const handleTestBridge = async () => {
    if (!client.testCheckinBridge) return;
    setTestingBridge(true);
    try {
      const res = await client.testCheckinBridge();
      onToast(
        res.ok
          ? `已连接 Agent2API (${res.latencyMs}ms · ${res.providersCount ?? 0} 家提供商)`
          : `连接失败：${res.error || '请检查 Agent2API 服务与 Key'}`,
        res.ok ? 'success' : 'danger',
      );
      await loadCenter();
    } finally {
      setTestingBridge(false);
    }
  };

  const todayDone = center?.daily.todayDone ?? 0;
  const todayEligible = center?.daily.todayEligible ?? 0;
  const progressPct = todayEligible > 0 ? Math.round((todayDone / todayEligible) * 100) : 0;
  const outOfScopeCount =
    center?.daily.outOfScope.reduce((s, x) => s + (x.count ?? 1), 0) ?? 0;
  const onboardingPending = center?.extras.onboarding.length ?? 0;

  return (
    <div className="a2a-page">
      {/* Top Tabs + Right Status Pill (Screenshot 2 header) */}
      <div className="a2a-checkin-top">
        <div className="a2a-pill-tabs">
          {(
            [
              ['center', '签到中心'],
              ['schedule', '定时签到'],
              ['makeup', '定时补签'],
              ['records', '签到记录'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="a2a-pill-tab"
              data-active={topTab === id ? 'true' : undefined}
              onClick={() => setTopTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span
            className="a2a-status-pill"
            data-tone={center?.bridge.connected ? 'success' : 'neutral'}
          >
            <span className="a2a-dot" />
            {center?.mode === 'bridge'
              ? `Agent2API 桥接在线 (${center.bridge.baseUrl})`
              : '本地插件 / 调度模式'}
          </span>
          <button
            type="button"
            className="codex-toolbar-btn"
            data-variant="outline"
            onClick={() => void handleToggleAuto()}
          >
            {center?.auto.enabled ? '自动执行已开启' : '自动执行已暂停'}
          </button>
          <button
            type="button"
            className="codex-toolbar-btn"
            data-variant="outline"
            onClick={() => setBridgeOpen((v) => !v)}
          >
            协议桥接设置
          </button>
          <button
            type="button"
            className="codex-toolbar-btn"
            data-variant="outline"
            disabled={loading}
            onClick={() => void loadCenter()}
          >
            刷新
          </button>
        </div>
      </div>

      {/* Collapsible Agent2API Bridge Config Drawer */}
      {bridgeOpen && (
        <form className="a2a-bridge-card" onSubmit={(e) => void handleSaveBridge(e)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div>
              <strong>Agent2API 签到协议桥接 / 本地插件设置</strong>
              <div className="a2a-item-sub">
                直连你本机运行的 Agent2API 管理接口（<code>/api/checkin-center</code>、<code>/api/accounts/checkin</code> 等），或使用本地 <code>backend/var/checkin-plugins/</code> 适配器。
              </div>
            </div>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              disabled={testingBridge}
              onClick={() => void handleTestBridge()}
            >
              {testingBridge ? '探测中…' : '测试桥接连通性'}
            </button>
          </div>
          <div className="a2a-form-grid-3">
            <label className="a2a-field">
              <span className="a2a-field-label">模式</span>
              <select
                className="codex-select"
                value={bridgeMode}
                onChange={(e) => setBridgeMode(e.target.value as 'auto' | 'bridge' | 'local')}
              >
                <option value="auto">自动（优先桥接 Agent2API，离线回退本地）</option>
                <option value="bridge">强制桥接 Agent2API</option>
                <option value="local">仅本地插件与定时调度</option>
              </select>
            </label>
            <label className="a2a-field">
              <span className="a2a-field-label">Agent2API 地址</span>
              <input
                className="codex-input"
                value={bridgeUrl}
                onChange={(e) => setBridgeUrl(e.target.value)}
                placeholder="http://127.0.0.1:3065"
              />
            </label>
            <label className="a2a-field">
              <span className="a2a-field-label">网关 Key (x-api-key，可选)</span>
              <input
                className="codex-input"
                type="password"
                value={bridgeApiKey}
                onChange={(e) => setBridgeApiKey(e.target.value)}
                placeholder={center?.bridge.hasApiKey ? '已保存（留空保持不变）' : '填写网关 Key'}
              />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <input
              className="codex-input"
              type="password"
              style={{ flex: 1, maxWidth: 320 }}
              value={bridgePanelToken}
              onChange={(e) => setBridgePanelToken(e.target.value)}
              placeholder={
                center?.bridge.hasPanelToken
                  ? '面板令牌已保存（留空不变）'
                  : '面板令牌 x-panel-token（开启面板登录时选填）'
              }
            />
            <button type="submit" className="codex-toolbar-btn" data-variant="primary">
              保存桥接配置
            </button>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              onClick={() => setBridgeOpen(false)}
            >
              收起
            </button>
          </div>
          {center?.bridge.error && (
            <div className="a2a-error-banner" style={{ marginTop: 8 }}>
              上次桥接错误：{center.bridge.error}
            </div>
          )}
        </form>
      )}

      {/* 4 KPI Summary Cards (Screenshot 2) */}
      <div className="a2a-kpi-grid">
        <div className="a2a-kpi-card">
          <div className="a2a-kpi-label">今日签到</div>
          <div className="a2a-kpi-value tabular-nums">
            {todayDone} <span className="a2a-kpi-sub">/ {todayEligible}</span>
          </div>
          <div className="a2a-kpi-hint">
            {outOfScopeCount > 0 ? `另有 ${outOfScopeCount} 个账号不参与每日签到` : '所有支持签到的账号'}
          </div>
          <div className="a2a-progress-track">
            <div className="a2a-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
        </div>

        <div className="a2a-kpi-card" onClick={() => setTopTab('schedule')} style={{ cursor: 'pointer' }}>
          <div className="a2a-kpi-label">定时签到</div>
          <div className="a2a-kpi-value">
            {center?.auto.enabled ? '已启用' : '—'}
          </div>
          <div className="a2a-kpi-hint">
            {center?.auto.enabled
              ? `已配置 ${center.auto.schedules.length} 条计划`
              : '总开关已关闭 · 在「定时签到」页打开'}
          </div>
        </div>

        <div
          className="a2a-kpi-card"
          onClick={() => {
            setTopTab('center');
            setSection('onboarding');
          }}
          style={{ cursor: 'pointer' }}
        >
          <div className="a2a-kpi-label">待领新手福利</div>
          <div className="a2a-kpi-value tabular-nums">
            {onboardingPending} <span className="a2a-kpi-sub">项</span>
          </div>
          <div className="a2a-kpi-hint">
            支持一键同步 Agent2API 新手与活动福利
          </div>
        </div>

        <div className="a2a-kpi-card" onClick={() => setTopTab('records')} style={{ cursor: 'pointer' }}>
          <div className="a2a-kpi-label">累计签到记录</div>
          <div className="a2a-kpi-value tabular-nums">{center?.recordsTotal ?? recordsTotal}</div>
          <div className="a2a-kpi-hint">每账号一条明细 · 点此查看「签到记录」</div>
        </div>
      </div>

      {/* Main Content per Top Tab */}
      {topTab === 'center' && (
        <>
          <div className="a2a-pill-tabs" style={{ alignSelf: 'flex-start' }}>
            {(
              [
                ['daily', '每日签到'],
                ['onboarding', '新手福利'],
                ['plans', '活动福利'],
                ['growth', '成长任务'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="a2a-pill-tab"
                data-active={section === id ? 'true' : undefined}
                onClick={() => setSection(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {section === 'daily' && (
            <div className="a2a-checkin-card">
              <div className="a2a-checkin-card-head">
                <div>
                  <strong>每日签到</strong>
                  <span className="a2a-muted-meta" style={{ marginLeft: 10 }}>
                    点击行展开账号明细 · 单账号签到不受范围限制
                  </span>
                </div>
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="primary"
                  disabled={runningAll}
                  onClick={() => void handleRunAll()}
                >
                  {runningAll ? '签到中…' : '立即全部签到'}
                </button>
              </div>

              {(center?.daily.providers.length ?? 0) === 0 ? (
                <div className="a2a-empty-box" style={{ padding: '36px 20px' }}>
                  <div style={{ fontWeight: 500, marginBottom: 6 }}>暂无待签到的提供商分组</div>
                  <div style={{ color: 'var(--text-tertiary)', marginBottom: 14 }}>
                    点击上方「协议桥接设置」连接本机运行的 Agent2API（如 <code>http://127.0.0.1:3065</code>），或在 <code>backend/var/checkin-plugins/</code> 放置自定义 Webhook 签到插件。
                  </div>
                  <button
                    type="button"
                    className="codex-toolbar-btn"
                    data-variant="primary"
                    onClick={() => setBridgeOpen(true)}
                  >
                    配置 Agent2API 协议桥接
                  </button>
                </div>
              ) : (
                center!.daily.providers.map((grp) => {
                  const isOpen = Boolean(expanded[grp.id]);
                  const badge =
                    grp.totalCount > 0 && grp.doneCount === grp.totalCount
                      ? { label: '已签', tone: 'success' }
                      : grp.doneCount > 0
                        ? { label: '部分', tone: 'warning' }
                        : { label: '待签', tone: 'info' };
                  return (
                    <div key={grp.id} className="a2a-checkin-group">
                      <div
                        className="a2a-checkin-group-row"
                        onClick={() =>
                          setExpanded((prev) => ({ ...prev, [grp.id]: !isOpen }))
                        }
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <ProviderLogo
                            providerId={grp.id}
                            name={grp.label}
                            color="#0ea5e9"
                            size="sm"
                          />
                          <div>
                            <div style={{ fontWeight: 550 }}>{grp.label}</div>
                            {grp.description && (
                              <div className="a2a-item-sub">{grp.description}</div>
                            )}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <span className="a2a-muted-meta tabular-nums">
                            {grp.totalCount} 账号 · {grp.doneCount} 已签
                          </span>
                          <span className="a2a-badge" data-tone={badge.tone}>
                            {badge.label}
                          </span>
                          <span style={{ color: 'var(--text-tertiary)' }}>
                            {isOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                          </span>
                        </div>
                      </div>

                      {isOpen && (
                        <div className="a2a-checkin-sublist">
                          {grp.accounts.map((acc) => (
                            <div key={acc.id} className="a2a-checkin-acc-row">
                              <div>
                                <strong>{acc.name}</strong>
                                <span className="a2a-item-sub" style={{ marginLeft: 10 }}>
                                  {acc.checkedInToday
                                    ? `今日已签 (${fmtTime(acc.checkinAt)})`
                                    : acc.dailyCheckin?.message || '今日尚未签到'}
                                  {acc.streakDays > 0 ? ` · 连续 ${acc.streakDays} 天` : ''}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="a2a-mini-btn"
                                disabled={runningId === acc.id}
                                onClick={() => void handleRunSingle(acc.id)}
                              >
                                {runningId === acc.id
                                  ? '执行中…'
                                  : acc.checkedInToday
                                    ? '重新签到'
                                    : '立即签到'}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}

          {section !== 'daily' && (
            <div className="a2a-checkin-card">
              <div className="a2a-empty-box" style={{ padding: '34px 20px' }}>
                {section === 'onboarding' &&
                  `当前共有 ${center?.extras.onboarding.length ?? 0} 个账号可同步新手福利。连接本机 Agent2API 桥接后可直接在此一键领取。`}
                {section === 'plans' &&
                  `当前共有 ${center?.extras.plans.length ?? 0} 个活动福利条目。`}
                {section === 'growth' &&
                  `当前共有 ${center?.extras.growth.length ?? 0} 个成长任务条目。`}
              </div>
            </div>
          )}
        </>
      )}

      {(topTab === 'schedule' || topTab === 'makeup') && (
        <div className="a2a-checkin-card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div>
              <strong>{topTab === 'schedule' ? '定时签到计划' : '定时补签策略'}</strong>
              <div className="a2a-item-sub">
                主签到时段后自动按补签时刻与重试间隔补齐未成功账号；桥接 Agent2API 时自动同步至远端计划。
              </div>
            </div>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant={center?.auto.enabled ? 'primary' : 'outline'}
              onClick={() => void handleToggleAuto()}
            >
              {center?.auto.enabled ? '总开关：已开启' : '总开关：已关闭'}
            </button>
          </div>

          <form className="a2a-form-grid-3" onSubmit={(e) => void handleSaveSchedule(e)}>
            <label className="a2a-field">
              <span className="a2a-field-label">计划名称</span>
              <input
                className="codex-input"
                value={schedLabel}
                onChange={(e) => setSchedLabel(e.target.value)}
              />
            </label>
            <label className="a2a-field">
              <span className="a2a-field-label">每日主签到时间 (HH:MM)</span>
              <input
                className="codex-input"
                type="time"
                value={schedTime}
                onChange={(e) => setSchedTime(e.target.value)}
              />
            </label>
            <label className="a2a-field">
              <span className="a2a-field-label">随机窗口结束时间</span>
              <input
                className="codex-input"
                type="time"
                value={schedTimeEnd}
                onChange={(e) => setSchedTimeEnd(e.target.value)}
              />
            </label>
            <label className="a2a-field">
              <span className="a2a-field-label">每日补签时刻</span>
              <input
                className="codex-input"
                type="time"
                value={schedRetryTime}
                onChange={(e) => setSchedRetryTime(e.target.value)}
              />
            </label>
            <label className="a2a-field">
              <span className="a2a-field-label">失败重试间隔（分钟）</span>
              <input
                className="codex-input"
                type="number"
                min={0}
                value={schedRetryGap}
                onChange={(e) => setSchedRetryGap(Number(e.target.value))}
              />
            </label>
            <label className="a2a-field">
              <span className="a2a-field-label">每账号每日补签上限</span>
              <input
                className="codex-input"
                type="number"
                min={0}
                max={10}
                value={schedRetryLimit}
                onChange={(e) => setSchedRetryLimit(Number(e.target.value))}
              />
            </label>
            <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
              <button type="submit" className="codex-toolbar-btn" data-variant="primary">
                保存并启用计划
              </button>
            </div>
          </form>

          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(center?.auto.schedules ?? []).map((s) => (
              <div key={s.id} className="a2a-checkin-acc-row">
                <div>
                  <strong>{s.displayLabel || s.label}</strong>
                  <span className="a2a-item-sub" style={{ marginLeft: 10 }}>
                    主签到 {s.time}
                    {s.timeEnd ? ` ~ ${s.timeEnd}` : ''} · 补签 {s.retryTime || '关闭'} · 间隔{' '}
                    {s.retryGapMinutes}m · 上限 {s.retryLimit} 次
                    {s.lastFiredToday ? ' · 今日已执行' : ''}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="a2a-mini-btn"
                    onClick={async () => {
                      await client.runCheckinSchedule?.(s.id);
                      await loadCenter();
                      onToast('已立即执行该签到计划', 'success');
                    }}
                  >
                    立即执行
                  </button>
                  <button
                    type="button"
                    className="a2a-mini-btn"
                    data-tone="danger"
                    onClick={async () => {
                      await client.deleteCheckinSchedule?.(s.id);
                      await loadCenter();
                      onToast('已删除签到计划');
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {topTab === 'records' && (
        <div className="a2a-checkin-card">
          <div className="a2a-checkin-card-head">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select
                className="codex-select"
                value={recOutcome}
                onChange={(e) => setRecOutcome(e.target.value)}
              >
                <option value="">全部结果</option>
                <option value="succeeded">成功</option>
                <option value="already_done">已签</option>
                <option value="failed">失败</option>
                <option value="skipped">跳过</option>
              </select>
              <input
                className="codex-input"
                placeholder="筛选账号或日志内容..."
                value={recKeyword}
                onChange={(e) => setRecKeyword(e.target.value)}
              />
              <button
                type="button"
                className="codex-toolbar-btn"
                data-variant="outline"
                onClick={() => void loadRecords()}
              >
                查询
              </button>
            </div>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              onClick={async () => {
                if (!window.confirm('确认清空全部签到记录？')) return;
                await client.clearCheckinRecords?.(true);
                await loadRecords();
                await loadCenter();
                onToast('已清空签到记录');
              }}
            >
              清空记录
            </button>
          </div>

          {records.length === 0 ? (
            <div className="a2a-empty-box" style={{ padding: 32 }}>
              暂无签到记录。
            </div>
          ) : (
            records.map((r, i) => (
              <div key={r.rowId ?? `${r.ts}-${i}`} className="a2a-checkin-acc-row">
                <div>
                  <strong>{r.provider || r.providerId || '未知提供商'}</strong>
                  <span style={{ marginLeft: 8 }}>{r.accountName || r.accountId || ''}</span>
                  <span className="a2a-item-sub" style={{ marginLeft: 10 }}>
                    {r.message || r.error || r.outcome}
                    {r.points ? ` (+${r.points})` : ''}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span
                    className="a2a-badge"
                    data-tone={
                      r.outcome === 'succeeded' || r.outcome === 'already_done'
                        ? 'success'
                        : r.outcome === 'failed'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {r.outcome || 'recorded'}
                  </span>
                  <span className="a2a-item-sub tabular-nums">{fmtTime(r.ts)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
