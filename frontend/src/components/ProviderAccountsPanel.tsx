import React, { useMemo, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type {
  ProviderAccount,
  ProviderAccountInput,
  ProviderPresetCatalog,
} from '../types/backend';
import { AddAccountModal } from './AddAccountModal';
import { IconChevronDown, IconChevronRight, IconPlus, IconSearch } from './Icons';
import { ProviderLogo } from './ProviderLogo';

interface ProviderAccountsPanelProps {
  client?: AgentBackendClient;
  presets: ProviderPresetCatalog | null;
  accounts: ProviderAccount[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onCreate: (input: ProviderAccountInput, opts?: { autoSync?: boolean }) => Promise<void>;
  onUpdate: (id: string, patch: Partial<ProviderAccountInput>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onBatch?: (ids: string[], action: 'enable' | 'disable' | 'delete' | 'clear-cooldown') => Promise<void>;
  onReorderProviders?: (order: string[]) => Promise<void>;
  onTest: (id: string) => Promise<void>;
  onSync: (id: string) => Promise<void>;
  onQueryBalance?: (id: string) => Promise<void>;
  onQueryAllBalances?: () => Promise<void>;
  onImportLocal: () => Promise<void>;
  onNavigateModels?: () => void;
  onToast?: (msg: string, tone?: 'default' | 'success' | 'warning' | 'danger') => void;
}

function fmtCooldown(ms?: number): string {
  if (!ms || ms <= 0) return '正常';
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `限流 ${sec}s`;
  const min = Math.ceil(sec / 60);
  return `限流 ${min}m`;
}

function fmtExpiry(ts?: number | null): string {
  if (!ts) return '—';
  const diffDays = Math.ceil((ts - Date.now()) / (24 * 3600 * 1000));
  if (diffDays <= 0) return '已到期';
  if (diffDays <= 3) return `${diffDays}天后到期`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const ProviderAccountsPanel: React.FC<ProviderAccountsPanelProps> = ({
  client,
  presets,
  accounts,
  loading,
  onRefresh,
  onCreate,
  onUpdate,
  onDelete,
  onBatch,
  onReorderProviders,
  onTest,
  onSync,
  onQueryBalance,
  onQueryAllBalances,
  onImportLocal,
  onNavigateModels,
  onToast,
}) => {
  const [filterPreset, setFilterPreset] = useState('all');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [rateFilter, setRateFilter] = useState<'all' | 'normal' | 'limited'>('all');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [queryingBalances, setQueryingBalances] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalPreset, setModalPreset] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(() => {
    const enabled = accounts.filter((a) => a.enabled).length;
    const disabled = accounts.length - enabled;
    const rateLimited = accounts.filter((a) => a.rateLimited).length;
    const normal = accounts.length - rateLimited;
    return { total: accounts.length, enabled, disabled, rateLimited, normal };
  }, [accounts]);

  const providerChoices = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const a of accounts) {
      const cur = map.get(a.preset) ?? {
        id: a.preset,
        name: a.presetName || presets?.items?.[a.preset]?.name || a.preset,
        count: 0,
      };
      cur.count += 1;
      map.set(a.preset, cur);
    }
    return [...map.values()];
  }, [accounts, presets]);

  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return accounts.filter((a) => {
      if (filterPreset !== 'all' && a.preset !== filterPreset) return false;
      if (statusFilter === 'enabled' && !a.enabled) return false;
      if (statusFilter === 'disabled' && a.enabled) return false;
      if (rateFilter === 'normal' && a.rateLimited) return false;
      if (rateFilter === 'limited' && !a.rateLimited) return false;
      if (!q) return true;
      return (
        (a.label || '').toLowerCase().includes(q) ||
        a.preset.toLowerCase().includes(q) ||
        (a.presetName || '').toLowerCase().includes(q) ||
        (a.endpoint || '').toLowerCase().includes(q)
      );
    });
  }, [accounts, filterPreset, statusFilter, rateFilter, search]);

  const groups = useMemo(() => {
    const map = new Map<
      string,
      {
        preset: string;
        name: string;
        icon: string;
        color: string;
        rank: number;
        items: ProviderAccount[];
      }
    >();
    for (const a of filteredAccounts) {
      const spec = presets?.items?.[a.preset];
      const existing = map.get(a.preset) ?? {
        preset: a.preset,
        name: a.presetName || spec?.name || a.preset,
        icon: spec?.icon || a.preset.slice(0, 2).toUpperCase(),
        color: spec?.color || '#2563eb',
        rank: a.providerRank ?? 999,
        items: [],
      };
      existing.items.push(a);
      map.set(a.preset, existing);
    }
    return [...map.values()].sort(
      (a, b) => a.rank - b.rank || a.name.localeCompare(b.name),
    );
  }, [filteredAccounts, presets]);

  const allExpanded = useMemo(
    () => groups.length > 0 && groups.every((g) => expandedGroups[g.preset] !== false),
    [groups, expandedGroups],
  );

  const toggleExpandAll = () => {
    const nextVal = !allExpanded;
    const next: Record<string, boolean> = {};
    for (const g of groups) next[g.preset] = nextVal;
    setExpandedGroups(next);
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === filteredAccounts.length && filteredAccounts.length > 0) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredAccounts.map((a) => a.id));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const runAction = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  const moveGroup = async (index: number, delta: -1 | 1) => {
    if (!onReorderProviders) return;
    const nextIdx = index + delta;
    if (nextIdx < 0 || nextIdx >= groups.length) return;
    const order = groups.map((g) => g.preset);
    const [moved] = order.splice(index, 1);
    order.splice(nextIdx, 0, moved);
    await onReorderProviders(order);
  };

  const handleBatch = async (action: 'enable' | 'disable' | 'delete' | 'clear-cooldown') => {
    if (!onBatch || !selectedIds.length) return;
    if (action === 'delete' && !window.confirm(`确定批量删除已选的 ${selectedIds.length} 个账号？`)) {
      return;
    }
    setError(null);
    try {
      await onBatch(selectedIds, action);
      setSelectedIds([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量操作失败');
    }
  };

  const handleQueryAllBalances = async () => {
    if (!onQueryAllBalances) return;
    setQueryingBalances(true);
    try {
      await onQueryAllBalances();
    } finally {
      setQueryingBalances(false);
    }
  };

  return (
    <div className="a2a-page">
      {/* Header Status Badges (Screenshot 3 top-right pills) */}
      <div className="a2a-page-header">
        <div>
          <h1 className="codex-settings-h1" style={{ marginBottom: 4 }}>账号池</h1>
          <p className="codex-settings-lede" style={{ margin: 0 }}>
            按顺位调度多账号、自动限流冷却切号、会话粘性保缓存，添加账号获取模型后即刻热接入后端 Agent。
          </p>
        </div>
        <div className="a2a-header-pills">
          <span className="a2a-status-pill" data-tone="success">
            <span className="a2a-dot" />
            {summary.enabled} 个启用
          </span>
          <span
            className="a2a-status-pill"
            data-tone={summary.rateLimited > 0 ? 'warning' : 'neutral'}
          >
            <span className="a2a-dot" />
            {summary.rateLimited} 个已限流
          </span>
          {onNavigateModels && (
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              onClick={onNavigateModels}
            >
              前往模型管理 →
            </button>
          )}
        </div>
      </div>

      {/* Filter & Primary Actions Bar (Screenshot 3 row 1) */}
      <div className="a2a-filter-bar">
        <div className="a2a-filter-left">
          <label className="a2a-inline-select">
            <span className="a2a-inline-label">提供商</span>
            <select
              className="codex-select"
              value={filterPreset}
              onChange={(e) => setFilterPreset(e.target.value)}
            >
              <option value="all">全部 ({accounts.length})</option>
              {providerChoices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.count})
                </option>
              ))}
            </select>
          </label>

          <div className="a2a-search-input" style={{ minWidth: 190 }}>
            <IconSearch size={13} />
            <input
              placeholder="账号名 / 地址 / 备注"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="a2a-seg-group" role="group" aria-label="状态筛选">
            <span className="a2a-seg-prefix">状态</span>
            {(
              [
                ['all', `全部 ${summary.total}`],
                ['enabled', `启用 ${summary.enabled}`],
                ['disabled', `禁用 ${summary.disabled}`],
              ] as const
            ).map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                className="a2a-seg-btn"
                data-active={statusFilter === val ? 'true' : undefined}
                onClick={() => setStatusFilter(val)}
              >
                {lbl}
              </button>
            ))}
          </div>

          <div className="a2a-seg-group" role="group" aria-label="限流筛选">
            <span className="a2a-seg-prefix">限流</span>
            {(
              [
                ['all', `全部 ${summary.total}`],
                ['normal', `正常 ${summary.normal}`],
                ['limited', `已限流 ${summary.rateLimited}`],
              ] as const
            ).map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                className="a2a-seg-btn"
                data-active={rateFilter === val ? 'true' : undefined}
                onClick={() => setRateFilter(val)}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div className="a2a-filter-actions">
          <button
            type="button"
            className="codex-toolbar-btn"
            data-variant="outline"
            disabled={loading}
            onClick={() => void onRefresh()}
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
          <button
            type="button"
            className="codex-toolbar-btn"
            data-variant="outline"
            onClick={toggleExpandAll}
          >
            {allExpanded ? '收起' : '展开'}
          </button>
          <button
            type="button"
            className="codex-toolbar-btn"
            data-variant="primary"
            onClick={() => {
              setModalPreset(null);
              setModalOpen(true);
            }}
          >
            <IconPlus size={14} />
            添加账号
          </button>
          {onQueryAllBalances && (
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              disabled={queryingBalances}
              onClick={() => void handleQueryAllBalances()}
            >
              {queryingBalances ? '查询中…' : '查询余额'}
            </button>
          )}
          <button
            type="button"
            className="codex-toolbar-btn"
            data-variant="outline"
            onClick={() => void onImportLocal()}
          >
            探测本机网关
          </button>
        </div>
      </div>

      {/* Bulk Selection Toolbar (Screenshot 3 row 2) */}
      <div className="a2a-bulk-bar">
        <label className="a2a-checkbox-row" style={{ margin: 0 }}>
          <input
            type="checkbox"
            checked={filteredAccounts.length > 0 && selectedIds.length === filteredAccounts.length}
            onChange={toggleSelectAll}
          />
          <span>
            全选当前筛选结果 ({filteredAccounts.length} 个) · 已选 <strong>{selectedIds.length}</strong> 个 · 共{' '}
            {groups.length} 家
          </span>
        </label>

        {selectedIds.length > 0 && onBatch && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              onClick={() => void handleBatch('enable')}
            >
              批量启用
            </button>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              onClick={() => void handleBatch('disable')}
            >
              批量禁用
            </button>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              onClick={() => void handleBatch('clear-cooldown')}
            >
              解除限流
            </button>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="danger"
              onClick={() => void handleBatch('delete')}
            >
              批量删除
            </button>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              onClick={() => setSelectedIds([])}
            >
              取消选择
            </button>
          </div>
        )}
      </div>

      {error && <div className="a2a-error-banner">{error}</div>}

      {/* Priority-Grouped Account Pool Table (Screenshot 3 main table) */}
      <div className="a2a-pool-table">
        <div className="a2a-pool-thead">
          <span />
          <span>顺位</span>
          <span>账号</span>
          <span>代理</span>
          <span>连接数</span>
          <span>状态</span>
          <span>限流</span>
          <span>有效期</span>
          <span>余额</span>
          <span>操作</span>
        </div>

        {groups.length === 0 ? (
          <div className="a2a-empty-box" style={{ padding: '40px 20px' }}>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>号池中还没有账号</div>
            <div style={{ color: 'var(--text-tertiary)', marginBottom: 14 }}>
              点击「添加账号」选择本机 Agent2API / DeepSeek / OpenAI / Anthropic / 自定义网关，或点击「探测本机网关」一键接入。
            </div>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="primary"
              onClick={() => {
                setModalPreset(null);
                setModalOpen(true);
              }}
            >
              <IconPlus size={14} />
              立即添加第一个账号
            </button>
          </div>
        ) : (
          groups.map((group, groupIdx) => {
            const isExpanded = expandedGroups[group.preset] !== false;
            const enabledCnt = group.items.filter((a) => a.enabled).length;
            const disabledCnt = group.items.length - enabledCnt;
            const limitedCnt = group.items.filter((a) => a.rateLimited).length;
            const balanceItems = group.items
              .map((a) => a.balance)
              .filter((b) => b && b.supported && b.display);

            return (
              <div key={group.preset} className="a2a-pool-group">
                <div
                  className="a2a-pool-group-row"
                  onClick={() =>
                    setExpandedGroups((prev) => ({
                      ...prev,
                      [group.preset]: !isExpanded,
                    }))
                  }
                >
                  <span style={{ width: 24, display: 'inline-flex', color: 'var(--text-tertiary)' }}>
                    {isExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                  </span>

                  <span className="a2a-rank-badge" style={{ width: 64 }}>
                    第 {groupIdx + 1} 顺位
                  </span>

                  <div className="a2a-pool-group-summary">
                    <ProviderLogo
                      providerId={group.preset}
                      name={group.name}
                      icon={group.icon}
                      color={group.color}
                      size="sm"
                    />
                    <strong>{group.name}</strong>
                    <span className="a2a-muted-meta">
                      {group.items.length} 个账号 · 启用 {enabledCnt} · 禁用 {disabledCnt}
                      {limitedCnt > 0 ? ` · 限流 ${limitedCnt}` : ''}
                    </span>
                    {balanceItems.length > 0 && (
                      <span className="a2a-balance-chip">
                        可用 {balanceItems[0]!.display}
                      </span>
                    )}
                  </div>

                  <div
                    className="a2a-pool-group-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {onReorderProviders && groups.length > 1 && (
                      <>
                        <button
                          type="button"
                          className="a2a-mini-btn"
                          title="提高顺位"
                          disabled={groupIdx === 0}
                          onClick={() => void moveGroup(groupIdx, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="a2a-mini-btn"
                          title="降低顺位"
                          disabled={groupIdx === groups.length - 1}
                          onClick={() => void moveGroup(groupIdx, 1)}
                        >
                          ↓
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="a2a-mini-btn"
                      title={`新增 ${group.name} 账号`}
                      onClick={() => {
                        setModalPreset(group.preset);
                        setModalOpen(true);
                      }}
                    >
                      +
                    </button>
                  </div>
                </div>

                {isExpanded &&
                  group.items.map((acc, idx) => {
                    const isBusy = busyId === acc.id;
                    const checked = selectedIds.includes(acc.id);
                    const statusLabel = !acc.enabled
                      ? '已禁用'
                      : acc.rateLimited
                        ? '已限流'
                        : acc.status === 'healthy'
                          ? '健康'
                          : acc.status === 'unhealthy'
                            ? '异常'
                            : '待检测';
                    const statusTone = !acc.enabled
                      ? 'neutral'
                      : acc.rateLimited
                        ? 'warning'
                        : acc.status === 'healthy'
                          ? 'success'
                          : acc.status === 'unhealthy'
                            ? 'danger'
                            : 'neutral';

                    return (
                      <div key={acc.id} className="a2a-pool-item-row">
                        <span>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleSelectOne(acc.id)}
                          />
                        </span>
                        <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
                          #{idx + 1} · P{acc.priority}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div className="a2a-item-title">
                            <span className="a2a-cell-label" title={acc.label || acc.id}>{acc.label || acc.id}</span>
                            <span className="a2a-model-count-tag">{acc.modelCount} 模型</span>
                          </div>
                          <div className="a2a-item-sub">
                            {acc.endpoint || '默认端点'}
                            {acc.credential ? ` · ${acc.credential}` : ''}
                            {acc.lastError ? (
                              <span style={{ color: 'var(--color-danger)' }}> · {acc.lastError}</span>
                            ) : null}
                          </div>
                        </div>
                        <span className="a2a-cell-label" title={acc.proxyUrl || '直连'} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                          {acc.proxyUrl || '直连'}
                        </span>
                        <span style={{ fontSize: 12 }} className="tabular-nums">
                          {acc.activeConns ?? 0}
                        </span>
                        <span>
                          <span className="a2a-badge" data-tone={statusTone}>
                            {statusLabel}
                          </span>
                        </span>
                        <span style={{ fontSize: 12, color: acc.rateLimited ? 'var(--color-warning)' : 'var(--text-tertiary)' }}>
                          {fmtCooldown(acc.cooldownRemainingMs)}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                          {fmtExpiry(acc.expiresAt)}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                          {acc.balance?.display || '—'}
                        </span>
                        <div
                          style={{
                            display: 'flex',
                            gap: 4,
                            justifyContent: 'flex-end',
                            flexWrap: 'wrap',
                          }}
                        >
                          <button
                            type="button"
                            className="a2a-mini-btn"
                            disabled={isBusy}
                            onClick={() =>
                              void runAction(acc.id, () =>
                                onUpdate(acc.id, { enabled: !acc.enabled }),
                              )
                            }
                          >
                            {acc.enabled ? '禁用' : '启用'}
                          </button>
                          <button
                            type="button"
                            className="a2a-mini-btn"
                            disabled={isBusy}
                            onClick={() => void runAction(acc.id, () => onTest(acc.id))}
                          >
                            测试
                          </button>
                          <button
                            type="button"
                            className="a2a-mini-btn"
                            disabled={isBusy}
                            onClick={() => void runAction(acc.id, () => onSync(acc.id))}
                          >
                            获取模型
                          </button>
                          {onQueryBalance && (
                            <button
                              type="button"
                              className="a2a-mini-btn"
                              disabled={isBusy}
                              onClick={() =>
                                void runAction(acc.id, () => onQueryBalance(acc.id))
                              }
                            >
                              余额
                            </button>
                          )}
                          {acc.rateLimited && (
                            <button
                              type="button"
                              className="a2a-mini-btn"
                              disabled={isBusy}
                              onClick={() =>
                                void runAction(acc.id, () =>
                                  onUpdate(acc.id, { clearCooldown: true }),
                                )
                              }
                            >
                              解限
                            </button>
                          )}
                          <button
                            type="button"
                            className="a2a-mini-btn"
                            data-tone="danger"
                            disabled={isBusy}
                            onClick={() => {
                              if (window.confirm(`确定删除账号「${acc.label || acc.id}」？`)) {
                                void runAction(acc.id, () => onDelete(acc.id));
                              }
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            );
          })
        )}
      </div>

      <AddAccountModal
        open={modalOpen}
        client={client}
        presets={presets}
        accounts={accounts}
        initialPresetId={modalPreset}
        onClose={() => setModalOpen(false)}
        onCreate={onCreate}
        onAccountSynced={onRefresh}
        onToast={onToast}
      />
    </div>
  );
};
