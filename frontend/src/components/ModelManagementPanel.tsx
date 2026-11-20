import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type {
  ModelTestResult,
  PoolModelItem,
  PoolModelsResponse,
  ProviderAccount,
  ProviderAccountInput,
  ProviderPresetCatalog,
} from '../types/backend';
import { AddAccountModal } from './AddAccountModal';
import { IconPlus, IconSearch } from './Icons';
import { ProviderLogo } from './ProviderLogo';

interface ModelManagementPanelProps {
  client: AgentBackendClient;
  presets: ProviderPresetCatalog | null;
  accounts: ProviderAccount[];
  onCreateAccount: (input: ProviderAccountInput, opts?: { autoSync?: boolean }) => Promise<void>;
  onModelsChanged: () => Promise<void>;
  onToast: (msg: string, tone?: 'default' | 'success' | 'warning' | 'danger') => void;
}

function fmtCtx(n: number): string {
  if (!n) return '—';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

export const ModelManagementPanel: React.FC<ModelManagementPanelProps> = ({
  client,
  presets,
  accounts,
  onCreateAccount,
  onModelsChanged,
  onToast,
}) => {
  const [data, setData] = useState<PoolModelsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled' | 'mapped'>('all');
  const [visibilityFilter, setVisibilityFilter] = useState<'all' | 'visible' | 'hidden'>('all');
  const [search, setSearch] = useState('');

  // Inline mapping editor state
  const [mappingTarget, setMappingTarget] = useState<PoolModelItem | null>(null);
  const [newAlias, setNewAlias] = useState('');

  // Manual add model state
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [manualModelId, setManualModelId] = useState('');
  const [manualPreset, setManualPreset] = useState('');
  const [manualCtx, setManualCtx] = useState(128000);
  const [manualOut, setManualOut] = useState(16384);

  // Add custom provider modal
  const [customModalOpen, setCustomModalOpen] = useState(false);

  // Per-model test results
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ModelTestResult>>({});

  const loadPool = useCallback(async () => {
    if (!client.getPoolModels) return;
    setLoading(true);
    try {
      const res = await client.getPoolModels({
        preset: selectedPreset,
        status: statusFilter === 'all' ? undefined : statusFilter,
        visibility: visibilityFilter === 'all' ? undefined : visibilityFilter,
        search: search.trim() || undefined,
      });
      setData(res);
    } catch (err) {
      onToast(err instanceof Error ? err.message : '读取模型列表失败', 'warning');
    } finally {
      setLoading(false);
    }
  }, [client, selectedPreset, statusFilter, visibilityFilter, search, onToast]);

  useEffect(() => {
    void loadPool();
  }, [loadPool]);

  const groupedModels = useMemo(() => {
    const map = new Map<string, { preset: string; name: string; items: PoolModelItem[] }>();
    for (const item of data?.items ?? []) {
      const cur = map.get(item.preset) ?? {
        preset: item.preset,
        name: item.presetName || item.preset,
        items: [],
      };
      cur.items.push(item);
      map.set(item.preset, cur);
    }
    return [...map.values()];
  }, [data]);

  const handleSyncModels = async () => {
    if (!client.syncProviderModels) return;
    setSyncing(true);
    try {
      const res = await client.syncProviderModels(
        selectedPreset === 'all' ? undefined : selectedPreset,
      );
      await loadPool();
      await onModelsChanged();
      onToast(
        `已完成模型同步：成功 ${res.syncedAccounts}/${res.totalAccounts} 个账号，已热接入后端对话！`,
        res.syncedAccounts > 0 ? 'success' : 'warning',
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : '获取模型失败', 'danger');
    } finally {
      setSyncing(false);
    }
  };

  const handleToggleVisible = async (m: PoolModelItem) => {
    if (!client.updatePoolModel) return;
    await client.updatePoolModel(m.id, { visible: !m.visible });
    await loadPool();
    await onModelsChanged();
  };

  const handleToggleEnabled = async (m: PoolModelItem) => {
    if (!client.updatePoolModel) return;
    await client.updatePoolModel(m.id, { enabled: !m.enabled });
    await loadPool();
    await onModelsChanged();
  };

  const handleToggleMapping = async (
    m: PoolModelItem,
    mapping: PoolModelItem['mappings'][number],
  ) => {
    if (!client.upsertModelMapping) return;
    await client.upsertModelMapping({
      id: mapping.id,
      alias: mapping.alias,
      targetPreset: mapping.targetPreset ?? m.preset,
      targetModel: mapping.targetModel,
      enabled: !mapping.enabled,
      isDefault: mapping.isDefault,
      priority: mapping.priority,
    });
    await loadPool();
    await onModelsChanged();
  };

  const handleAddMapping = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mappingTarget || !newAlias.trim() || !client.upsertModelMapping) return;
    try {
      await client.upsertModelMapping({
        alias: newAlias.trim(),
        targetPreset: mappingTarget.preset,
        targetModel: mappingTarget.upstreamModel,
        enabled: true,
        isDefault: false,
      });
      setMappingTarget(null);
      setNewAlias('');
      await loadPool();
      await onModelsChanged();
      onToast(`已添加模型映射 ${newAlias.trim()} → ${mappingTarget.upstreamModel}`, 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : '添加映射失败', 'danger');
    }
  };

  const handleDeleteMapping = async (id: string) => {
    if (!client.deleteModelMapping) return;
    await client.deleteModelMapping(id);
    await loadPool();
    await onModelsChanged();
    onToast('已删除模型映射');
  };

  const handleSetDefault = async (alias: string) => {
    if (!client.setDefaultModel) return;
    await client.setDefaultModel(alias);
    await loadPool();
    await onModelsChanged();
    onToast(`已将默认对话模型设为 ${alias}`, 'success');
  };

  const handleTestModel = async (m: PoolModelItem) => {
    if (!client.testModel) return;
    const key = `${m.preset}::${m.upstreamModel}`;
    setTestingKey(key);
    try {
      const res = await client.testModel({
        model: m.upstreamModel,
        preset: m.preset,
      });
      setTestResults((prev) => ({ ...prev, [key]: res }));
      onToast(
        res.ok
          ? `${m.upstreamModel} 测试通过 (${res.latencyMs}ms): ${res.reply || 'OK'}`
          : `${m.upstreamModel} 测试失败: ${res.error}`,
        res.ok ? 'success' : 'danger',
      );
    } finally {
      setTestingKey(null);
    }
  };

  const handleAddManualModel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client.addManualModel || !manualModelId.trim()) return;
    try {
      await client.addManualModel({
        preset: manualPreset || (selectedPreset !== 'all' ? selectedPreset : undefined),
        upstreamModel: manualModelId.trim(),
        contextWindow: manualCtx,
        maxOutput: manualOut,
      });
      setManualModelId('');
      setAddModelOpen(false);
      await loadPool();
      await onModelsChanged();
      onToast(`已添加模型 ${manualModelId.trim()}`, 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : '添加模型失败', 'danger');
    }
  };

  const providerList = data?.providers ?? [];

  return (
    <div className="a2a-models-layout">
      {/* Left Provider Directory Sidebar (Screenshot 4 left pane) */}
      <aside className="a2a-models-sidebar">
        <div className="a2a-models-sidebar-title">内置提供商</div>
        <button
          type="button"
          className="a2a-models-prov-item"
          data-active={selectedPreset === 'all' ? 'true' : undefined}
          onClick={() => setSelectedPreset('all')}
        >
          <span className="a2a-provider-badge-xs" style={{ background: 'var(--color-accent)' }}>
            全
          </span>
          <span className="a2a-models-prov-name">全部 ({providerList.length} 家)</span>
          <span className="a2a-models-prov-count">{data?.totalCount ?? 0}</span>
        </button>

        <div className="a2a-models-prov-scroll">
          {providerList.map((p) => (
            <button
              key={p.id}
              type="button"
              className="a2a-models-prov-item"
              data-active={selectedPreset === p.id ? 'true' : undefined}
              onClick={() => setSelectedPreset(p.id)}
            >
              <ProviderLogo
                providerId={p.id}
                name={p.name}
                icon={p.icon}
                color={p.color}
                size="xs"
              />
              <span className="a2a-models-prov-name">{p.name}</span>
              <span className="a2a-models-prov-count">{p.modelCount}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          className="a2a-models-new-prov-btn"
          onClick={() => setCustomModalOpen(true)}
        >
          <IconPlus size={14} />
          新建自定义提供商
        </button>
      </aside>

      {/* Right Model Catalog & Alias Mapping Area (Screenshot 4 right pane) */}
      <div className="a2a-models-main">
        <div className="a2a-models-topbar">
          <div className="a2a-models-title-row">
            <strong>
              {selectedPreset === 'all'
                ? '全部'
                : providerList.find((p) => p.id === selectedPreset)?.name || selectedPreset}
            </strong>
            <span className="a2a-muted-meta">
              {data?.totalCount ?? 0} 个模型 · 已启用 {data?.enabledCount ?? 0} · 有映射{' '}
              {data?.mappedCount ?? 0}
              {data?.defaultModel ? ` · 默认模型: ${data.defaultModel}` : ''}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="primary"
              disabled={syncing}
              onClick={() => void handleSyncModels()}
            >
              {syncing ? '获取中…' : '获取模型'}
            </button>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              onClick={() => setAddModelOpen((v) => !v)}
            >
              + 添加模型
            </button>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              disabled={loading}
              onClick={() => void loadPool()}
            >
              刷新
            </button>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="a2a-models-filters">
          <div className="a2a-seg-group">
            {(
              [
                ['all', '全部'],
                ['enabled', '已启用'],
                ['disabled', '已禁用'],
                ['mapped', '有映射'],
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

          <div className="a2a-seg-group">
            {(
              [
                ['all', '全部'],
                ['visible', '可见'],
                ['hidden', '不显示'],
              ] as const
            ).map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                className="a2a-seg-btn"
                data-active={visibilityFilter === val ? 'true' : undefined}
                onClick={() => setVisibilityFilter(val)}
              >
                {lbl}
              </button>
            ))}
          </div>

          <div className="a2a-search-input" style={{ flex: 1, maxWidth: 260 }}>
            <IconSearch size={13} />
            <input
              placeholder="搜索模型名或别名..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Inline Add Manual Model Drawer */}
        {addModelOpen && (
          <form className="a2a-inline-drawer" onSubmit={(e) => void handleAddManualModel(e)}>
            <select
              className="codex-select"
              value={manualPreset}
              onChange={(e) => setManualPreset(e.target.value)}
            >
              <option value="">自动匹配首个提供商</option>
              {Array.from(new Set(accounts.map((a) => a.preset))).map((p) => (
                <option key={p} value={p}>
                  {presets?.items?.[p]?.name || p}
                </option>
              ))}
            </select>
            <input
              className="codex-input"
              placeholder="上游模型 ID（如 deepseek-chat / claude-sonnet-4-5）"
              value={manualModelId}
              onChange={(e) => setManualModelId(e.target.value)}
              style={{ flex: 2 }}
              required
            />
            <input
              className="codex-input"
              type="number"
              style={{ width: 100 }}
              value={manualCtx}
              onChange={(e) => setManualCtx(Number(e.target.value))}
              title="上下文长度"
            />
            <input
              className="codex-input"
              type="number"
              style={{ width: 90 }}
              value={manualOut}
              onChange={(e) => setManualOut(Number(e.target.value))}
              title="最大输出"
            />
            <button type="submit" className="codex-toolbar-btn" data-variant="primary">
              保存模型
            </button>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              onClick={() => setAddModelOpen(false)}
            >
              取消
            </button>
          </form>
        )}

        {/* Inline Add Alias Mapping Form */}
        {mappingTarget && (
          <form className="a2a-inline-drawer" onSubmit={(e) => void handleAddMapping(e)}>
            <span style={{ fontSize: 12.5 }}>
              为 <strong>{mappingTarget.upstreamModel}</strong> ({mappingTarget.presetName}) 添加对外别名：
            </span>
            <input
              className="codex-input"
              style={{ flex: 1, maxWidth: 240 }}
              placeholder="例如：claude-sonnet / fast-coder"
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              autoFocus
              required
            />
            <button type="submit" className="codex-toolbar-btn" data-variant="primary">
              确定映射
            </button>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="outline"
              onClick={() => {
                setMappingTarget(null);
                setNewAlias('');
              }}
            >
              取消
            </button>
          </form>
        )}

        {/* Models Table */}
        <div className="a2a-models-table">
          <div className="a2a-models-thead">
            <span style={{ flex: 2.2 }}>上游模型</span>
            <span style={{ width: 56 }}>倍率</span>
            <span style={{ width: 68 }}>可见性</span>
            <span style={{ width: 58 }}>来源</span>
            <span style={{ width: 105 }}>上下文 / 输出</span>
            <span style={{ width: 96 }}>能力</span>
            <span style={{ flex: 2.3 }}>模型映射</span>
            <span style={{ width: 120, textAlign: 'right' }}>操作</span>
          </div>

          {groupedModels.length === 0 ? (
            <div className="a2a-empty-box" style={{ padding: '42px 20px' }}>
              <div style={{ fontWeight: 500, marginBottom: 6 }}>暂无已同步的模型</div>
              <div style={{ color: 'var(--text-tertiary)', marginBottom: 14 }}>
                请先在「账号号池」中添加至少一个启用账号，然后点击右上角「获取模型」，所有模型会自动挂载为后端 Agent 可用 Provider。
              </div>
              <button
                type="button"
                className="codex-toolbar-btn"
                data-variant="primary"
                disabled={syncing}
                onClick={() => void handleSyncModels()}
              >
                立即获取模型
              </button>
            </div>
          ) : (
            groupedModels.map((grp) => (
              <div key={grp.preset} className="a2a-models-group">
                <div className="a2a-models-group-head">
                  <ProviderLogo providerId={grp.preset} name={grp.name} size="xs" />
                  <strong>{grp.name}</strong>
                  <span>{grp.items.length} 个模型</span>
                </div>
                {grp.items.map((m) => {
                  const testKey = `${m.preset}::${m.upstreamModel}`;
                  const probe = testResults[testKey];
                  const isDefault = data?.defaultModel === m.upstreamModel;
                  return (
                    <div
                      key={m.id}
                      className="a2a-models-row"
                      data-disabled={!m.enabled ? 'true' : undefined}
                    >
                      <div style={{ flex: 2.2, minWidth: 0 }}>
                        <div className="a2a-model-id-line">
                          <span className="a2a-mono-strong">{m.upstreamModel}</span>
                          {isDefault && <span className="a2a-default-tag">默认</span>}
                        </div>
                        <div className="a2a-item-sub">
                          {m.displayName !== m.upstreamModel ? `${m.displayName} · ` : ''}
                          {m.activeAccountCount} 个可用账号
                          {probe && (
                            <span
                              style={{
                                marginLeft: 8,
                                color: probe.ok ? 'var(--color-success)' : 'var(--color-danger)',
                              }}
                            >
                              {probe.ok
                                ? `✓ ${probe.latencyMs}ms (${probe.reply || 'OK'})`
                                : `✗ ${probe.error}`}
                            </span>
                          )}
                        </div>
                      </div>

                      <span style={{ width: 56, fontSize: 12 }} className="tabular-nums">
                        {m.multiplier}x
                      </span>

                      <span style={{ width: 68 }}>
                        <button
                          type="button"
                          className="a2a-vis-btn"
                          data-visible={m.visible ? 'true' : undefined}
                          onClick={() => void handleToggleVisible(m)}
                          title="点击切换是否在对话下拉列表显示"
                        >
                          ● {m.visible ? '可见' : '隐藏'}
                        </button>
                      </span>

                      <span style={{ width: 58, fontSize: 12, color: 'var(--text-secondary)' }}>
                        {m.source === 'manual' ? '手动' : '远程'}
                      </span>

                      <span
                        style={{ width: 105, fontSize: 12, color: 'var(--text-secondary)' }}
                        className="tabular-nums"
                      >
                        {fmtCtx(m.contextWindow)} / {fmtCtx(m.maxOutput)}
                      </span>

                      <div style={{ width: 96, display: 'flex', gap: 4 }}>
                        <span
                          className="a2a-cap-icon"
                          data-on={m.capabilities.tools ? 'true' : undefined}
                          title="支持工具调用 (Function Calling)"
                        >
                          🛠
                        </span>
                        <span
                          className="a2a-cap-icon"
                          data-on={m.capabilities.reasoning ? 'true' : undefined}
                          title="支持推理思考流"
                        >
                          💡
                        </span>
                        <span
                          className="a2a-cap-icon"
                          data-on={m.capabilities.vision ? 'true' : undefined}
                          title="支持图像视觉输入"
                        >
                          👁
                        </span>
                        <span
                          className="a2a-cap-icon"
                          data-on={m.capabilities.cache ? 'true' : undefined}
                          title="支持 Prompt Cache"
                        >
                          ⚡
                        </span>
                      </div>

                      <div style={{ flex: 2.3, display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                        {m.mappings.map((mp) => (
                          <span
                            key={mp.id}
                            className="a2a-mapping-pill"
                            data-enabled={mp.enabled ? 'true' : undefined}
                          >
                            <button
                              type="button"
                              className="a2a-mini-switch"
                              data-on={mp.enabled ? 'true' : undefined}
                              onClick={() => void handleToggleMapping(m, mp)}
                              title={mp.enabled ? '点击禁用此映射' : '点击启用此映射'}
                            />
                            <span>{mp.alias}</span>
                            {mp.isDefault && <span className="a2a-mapping-sub">默认</span>}
                            {!mp.isDefault && (
                              <button
                                type="button"
                                className="a2a-mapping-del"
                                onClick={() => void handleDeleteMapping(mp.id)}
                                title="删除映射"
                              >
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                        <button
                          type="button"
                          className="a2a-mini-btn"
                          onClick={() => {
                            setMappingTarget(m);
                            setNewAlias('');
                          }}
                        >
                          + 映射
                        </button>
                      </div>

                      <div style={{ width: 120, display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          className="a2a-mini-btn"
                          disabled={testingKey === testKey}
                          onClick={() => void handleTestModel(m)}
                        >
                          {testingKey === testKey ? '测中' : '测试'}
                        </button>
                        {!isDefault && m.enabled && (
                          <button
                            type="button"
                            className="a2a-mini-btn"
                            title="设为默认对话模型"
                            onClick={() => void handleSetDefault(m.upstreamModel)}
                          >
                            默认
                          </button>
                        )}
                        <button
                          type="button"
                          className="a2a-mini-btn"
                          onClick={() => void handleToggleEnabled(m)}
                        >
                          {m.enabled ? '停' : '启'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}

          {/* Unmounted Mappings (Screenshot 4 bottom warning block) */}
          {(data?.unmountedMappings?.length ?? 0) > 0 && (
            <div className="a2a-unmounted-box">
              <div className="a2a-unmounted-title">
                未挂载的模型映射 <span>{data!.unmountedMappings.length}</span>
              </div>
              <div className="a2a-unmounted-desc">
                这些映射指向的上游模型已不在当前清单里，不会出现在 /v1/models。删除对应对外名即可重新使用。
              </div>
              {data!.unmountedMappings.map((um) => (
                <div key={um.id} className="a2a-unmounted-row">
                  <span>
                    <strong>{um.targetPreset || '任意'}</strong> · <code>{um.alias}</code> →{' '}
                    <code>{um.targetModel}</code>
                  </span>
                  <button
                    type="button"
                    className="a2a-mini-btn"
                    data-tone="danger"
                    onClick={() => void handleDeleteMapping(um.id)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Bottom Gateway Status Bar (Screenshot 4 footer) */}
        <div className="a2a-gateway-footer">
          <span className="a2a-status-pill" data-tone="success">
            <span className="a2a-dot" />
            内置单进程网关运行中 · {data?.gateway?.endpoint || 'http://127.0.0.1:8787/v1'}
          </span>
          <span className="a2a-muted-meta">
            共 {data?.items.length ?? 0} 项展示 · 原生支持 OpenAI (/v1/chat/completions) 与 Anthropic (/v1/messages) 双向路由反代
          </span>
        </div>
      </div>

      <AddAccountModal
        open={customModalOpen}
        client={client}
        presets={presets}
        accounts={accounts}
        initialCategory="custom"
        onClose={() => setCustomModalOpen(false)}
        onCreate={async (input, opts) => {
          await onCreateAccount(input, opts);
          await loadPool();
        }}
        onAccountSynced={async () => {
          await loadPool();
          await onModelsChanged();
        }}
        onToast={onToast}
      />
    </div>
  );
};
