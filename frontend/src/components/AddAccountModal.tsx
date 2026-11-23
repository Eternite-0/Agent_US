import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentBackendClient } from '../api/client';
import type {
  ProviderAccount,
  ProviderAccountInput,
  ProviderPreset,
  ProviderPresetCatalog,
} from '../types/backend';
import { mergeProviderPresetCatalog } from '../data/providerPresets';
import { IconClose, IconSearch } from './Icons';
import { ProviderLogo } from './ProviderLogo';

interface AddAccountModalProps {
  open: boolean;
  client?: AgentBackendClient;
  presets: ProviderPresetCatalog | null;
  accounts: ProviderAccount[];
  initialPresetId?: string | null;
  initialCategory?: string | null;
  onClose: () => void;
  onCreate: (input: ProviderAccountInput, opts?: { autoSync?: boolean }) => Promise<void>;
  onAccountSynced?: () => Promise<void>;
  onToast?: (msg: string, tone?: 'default' | 'success' | 'warning' | 'danger') => void;
}

type AddMethod = 'web' | 'file' | 'manual';

interface EditionGroup {
  baseName: string;
  note: string;
  options: Array<{ presetId: string; label: string }>;
}

const EDITION_GROUPS: EditionGroup[] = [
  {
    baseName: 'GLM / 智谱',
    note: '国内 BigModel (OpenAI 协议) 与国际 z.ai Coding (Anthropic 协议) 可分别接入，网关自动完成协议转换。',
    options: [
      { presetId: 'zhipu', label: '国内版 (智谱 BigModel)' },
      { presetId: 'glm-coding', label: '国际版 (GLM Coding)' },
    ],
  },
  {
    baseName: 'MiniMax',
    note: 'MiniMax 国际站与国内站 Coding 套餐可分别配置。',
    options: [
      { presetId: 'minimax', label: '国际版 (MiniMax)' },
      { presetId: 'minimax-cn', label: '国内版 (MiniMax 中国)' },
    ],
  },
];

function findEditionGroup(presetId: string): EditionGroup | null {
  return EDITION_GROUPS.find((g) => g.options.some((o) => o.presetId === presetId)) ?? null;
}


type ProviderLoginGroupId = 'ready' | 'manual';

const PROVIDER_LOGIN_GROUPS: Record<
  ProviderLoginGroupId,
  { label: string; description: string }
> = {
  ready: {
    label: '可直接登录 / 导入',
    description: '可通过内置网关授权或导入本机凭证接入，具体方式见卡片。',
  },
  manual: {
    label: '需手动获取 Token / 配置网关',
    description: '请从官方控制台、客户端或兼容网关获取 Token / API Key 与 Base URL。',
  },
};

function defaultMethodForPreset(p: ProviderPreset): AddMethod {
  if (p.loginMode) return p.loginMode;
  if (p.id === 'openrouter' || p.id === 'github-copilot') return 'web';
  if (p.id === 'claude-code' || p.id === 'openai-codex' || p.id === 'gemini-cli') return 'file';
  return 'manual';
}

function providerLoginMode(p: ProviderPreset): AddMethod {
  return defaultMethodForPreset(p);
}

function providerLoginGroup(p: ProviderPreset): ProviderLoginGroupId {
  return providerLoginMode(p) === 'manual' ? 'manual' : 'ready';
}

function providerLoginBadge(p: ProviderPreset): string {
  if (p.nativeLogin) return '内置网关网页登录';
  switch (providerLoginMode(p)) {
    case 'web':
      return '一键网页登录';
    case 'file':
      return '一键导入本机凭证';
    default:
      return p.protocol === 'anthropic' ? '手动 Token / Anthropic 网关' : '手动 Token / 兼容网关';
  }
}

export const AddAccountModal: React.FC<AddAccountModalProps> = ({
  open,
  client,
  presets,
  accounts,
  initialPresetId = null,
  initialCategory = null,
  onClose,
  onCreate,
  onAccountSynced,
  onToast,
}) => {
  const [category, setCategory] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selectedPreset, setSelectedPreset] = useState<ProviderPreset | null>(null);
  const [method, setMethod] = useState<AddMethod>('manual');

  // Manual API Key / Reverse Proxy form
  const [label, setLabel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [credential, setCredential] = useState('');
  const [priority, setPriority] = useState('100');
  const [autoSync, setAutoSync] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Native Web Login (OpenRouter PKCE / GitHub Copilot Device Flow / Official Portal)
  const [webFlowId, setWebFlowId] = useState<string | null>(null);
  const [webEngine, setWebEngine] = useState<'openrouter-pkce' | 'github-device' | 'provider-native' | 'portal-token' | null>(null);
  const [webAuthUrl, setWebAuthUrl] = useState<string | null>(null);
  const [webUserCode, setWebUserCode] = useState<string | null>(null);
  const [webHint, setWebHint] = useState<string | null>(null);
  const [webStarting, setWebStarting] = useState(false);
  const [webCallbackInput, setWebCallbackInput] = useState('');
  const [webSubmittingCb, setWebSubmittingCb] = useState(false);
  const flowGeneration = useRef(0);
  const pollTimerRef = useRef<number | null>(null);

  // Local CLI auto-scan & Credential File Import
  const [credFileName, setCredFileName] = useState('');
  const [credContent, setCredContent] = useState('');
  const [localCreds, setLocalCreds] = useState<
    Array<{
      id: string;
      preset: string;
      label: string;
      filePath: string;
      extractedKey: string;
      maskedToken: string | null;
    }>
  >([]);
  const [scanningLocal, setScanningLocal] = useState(false);
  const [importingLocalId, setImportingLocalId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const mergedCatalog = useMemo<ProviderPresetCatalog>(
    () => mergeProviderPresetCatalog(presets),
    [presets],
  );

  const allPresets = useMemo<ProviderPreset[]>(
    () => Object.values(mergedCatalog.items),
    [mergedCatalog],
  );

  const accountCountsByPreset = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of accounts) {
      map.set(a.preset, (map.get(a.preset) ?? 0) + 1);
    }
    return map;
  }, [accounts]);

  const stopPolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const resetFlowState = () => {
    flowGeneration.current++;
    if (webFlowId) void client?.cancelWebLogin?.(webFlowId).catch(() => {});
    setWebStarting(false);
    stopPolling();
    setWebFlowId(null);
    setWebEngine(null);
    setWebAuthUrl(null);
    setWebUserCode(null);
    setWebHint(null);
    setWebCallbackInput('');
    setError(null);
  };

  const selectPresetForStep2 = (p: ProviderPreset) => {
    resetFlowState();
    setSelectedPreset(p);
    setMethod(defaultMethodForPreset(p));
    setLabel('');
    setEndpoint(p.defaultEndpoint ?? '');
    setCredential('');
    setPriority('100');
    setCredFileName('');
    setCredContent('');
  };

  useEffect(() => {
    if (!open) {
      stopPolling();
      return;
    }
    setSearch('');
    setError(null);
    setCategory(initialCategory || 'all');
    if (initialPresetId && mergedCatalog.items[initialPresetId]) {
      selectPresetForStep2(mergedCatalog.items[initialPresetId]);
    } else {
      resetFlowState();
      setSelectedPreset(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPresetId, initialCategory]);

  useEffect(() => () => { flowGeneration.current++; stopPolling(); }, []);

  // Poll active OAuth / Device Flow login status
  useEffect(() => {
    if (!open || !webFlowId || !client?.getWebLoginStatus) return;
    if (webEngine === 'portal-token') return;
    stopPolling();
    let active = true;
    let polling = false;
    const generation = flowGeneration.current;
    pollTimerRef.current = window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const st = await client.getWebLoginStatus!(webFlowId);
        if (!active || generation !== flowGeneration.current) return;
        if (st.hint) setWebHint(st.hint);
        if (st.status === 'done') {
          stopPolling();
          const syncedCount = st.syncedModelsCount ?? 0;
          onToast?.(
            st.hint || `已登录「${st.account?.label || selectedPreset?.name}」${syncedCount ? `，同步 ${syncedCount} 个模型` : ''}`,
            st.hint ? 'warning' : 'success',
          );
          await onAccountSynced?.();
          onClose();
        } else if (st.status === 'failed' || st.status === 'canceled') {
          stopPolling();
          if (st.status === 'failed') {
            setError(st.error || '登录失败，请重试');
          }
          setWebFlowId(null);
        }
      } catch {
        // transient poll error
      } finally { polling = false; }
    }, 2500);
    return () => { active = false; stopPolling(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, webFlowId, webEngine]);

  // Auto-scan local CLI credentials when switching to 'file' tab
  useEffect(() => {
    if (!open || !selectedPreset || method !== 'file' || !client?.scanLocalCredentials) return;
    let active = true;
    setScanningLocal(true);
    client
      .scanLocalCredentials()
      .then((res) => {
        if (active) setLocalCreds(res.items ?? []);
      })
      .catch(() => {
        if (active) setLocalCreds([]);
      })
      .finally(() => {
        if (active) setScanningLocal(false);
      });
    return () => {
      active = false;
    };
  }, [open, selectedPreset, method, client]);

  const categories = mergedCatalog.categories ?? [];

  const filteredPresets = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allPresets.filter((p) => {
      if (category !== 'all' && p.category !== category) return false;
      if (!q) return true;
      return (
        p.id.toLowerCase().includes(q) ||
        (p.name ?? '').toLowerCase().includes(q) ||
        (p.ownedBy ?? '').toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q)
      );
    });
  }, [allPresets, category, search]);

  const groupedPresets = useMemo(() => {
    const groups: Array<{
      id: ProviderLoginGroupId;
      label: string;
      description: string;
      items: ProviderPreset[];
    }> = [];
    (['ready', 'manual'] as ProviderLoginGroupId[]).forEach((groupId) => {
      const items = filteredPresets.filter((p) => providerLoginGroup(p) === groupId);
      if (items.length > 0) {
        groups.push({
          id: groupId,
          label: PROVIDER_LOGIN_GROUPS[groupId].label,
          description: PROVIDER_LOGIN_GROUPS[groupId].description,
          items,
        });
      }
    });
    return groups;
  }, [filteredPresets]);

  const handleClose = () => {
    resetFlowState();
    onClose();
  };

  const handleBackToGrid = () => {
    resetFlowState();
    setSelectedPreset(null);
  };

  const handleStartWebLogin = async () => {
    if (!selectedPreset || !client?.startWebLogin) return;
    setError(null);
    setWebStarting(true);
    const generation = flowGeneration.current;
    try {
      const res = await client.startWebLogin({
        preset: selectedPreset.id,
        autoSync,
      });
      if (generation !== flowGeneration.current) {
        if (res.flowId) void client.cancelWebLogin?.(res.flowId).catch(() => {});
        return;
      }
      if (!res.ok) {
        setError(res.message || '发起网页登录失败');
        return;
      }
      setWebFlowId(res.flowId ?? null);
      setWebEngine(res.engine ?? null);
      setWebAuthUrl(res.authUrl ?? null);
      setWebUserCode(res.userCode ?? null);
      setWebHint(res.instructions || '请在新打开的浏览器标签页中完成授权…');
      if (res.authUrl) {
        window.open(res.authUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === flowGeneration.current) setWebStarting(false);
    }
  };

  const handleSubmitWebCallback = async () => {
    if (!webFlowId || !client?.submitWebLoginCallback) return;
    const raw = webCallbackInput.trim();
    if (!raw) {
      setError('请粘贴授权页返回的 Token、API Key 或回调 URL');
      return;
    }
    setError(null);
    setWebSubmittingCb(true);
    try {
      const isUrl = /^https?:\/\//i.test(raw);
      const res = await client.submitWebLoginCallback(webFlowId, {
        ...(isUrl ? { callbackUrl: raw } : { token: raw }),
        label: label.trim() || undefined,
        endpoint: endpoint.trim() || undefined,
      });
      if (res.status === 'done' || res.account) {
        stopPolling();
        const syncedCount = res.syncedModelsCount ?? 0;
        onToast?.(
          `已添加「${res.account?.label || selectedPreset?.name}」${syncedCount ? `，同步 ${syncedCount} 个模型` : ''}`,
          'success',
        );
        await onAccountSynced?.();
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWebSubmittingCb(false);
    }
  };

  const handleImportLocal = async (candId: string) => {
    if (!client?.importLocalCredential) return;
    setError(null);
    setImportingLocalId(candId);
    try {
      const res = await client.importLocalCredential({ id: candId, autoSync });
      onToast?.(
        `已一键导入「${res.account.label}」${res.syncedModelsCount ? `，同步 ${res.syncedModelsCount} 个模型` : ''}`,
        'success',
      );
      await onAccountSynced?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportingLocalId(null);
    }
  };

  const handleFileChosen = (file: File | null) => {
    if (!file) return;
    setCredFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setCredContent(String(reader.result ?? ''));
    reader.readAsText(file, 'utf-8');
  };

  const handleImportFileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPreset || !client?.importCredentialFile) return;
    if (!credContent.trim()) {
      setError('请选择凭证文件或粘贴 JSON / .env / Token 内容');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await client.importCredentialFile({
        preset: selectedPreset.id,
        label: label.trim() || undefined,
        endpoint: endpoint.trim() || undefined,
        fileName: credFileName || undefined,
        content: credContent,
        autoSync,
      });
      onToast?.(
        `已导入「${res.account.label}」(${res.extractedKey})${res.syncedModelsCount ? `，同步 ${res.syncedModelsCount} 个模型` : ''}`,
        'success',
      );
      await onAccountSynced?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPreset) return;
    const keyRequired = selectedPreset.fields.some((f) => f.name === 'apiKey' && f.required);
    const endpointRequired = selectedPreset.fields.some((f) => f.name === 'endpoint' && f.required);
    if (keyRequired && !credential.trim()) {
      setError('请填写 API Key / 访问令牌');
      return;
    }
    if (endpointRequired && !endpoint.trim()) {
      setError('请填写 Base URL / 反代地址');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(
        {
          preset: selectedPreset.id,
          label: label.trim() || `${selectedPreset.name} 账号`,
          endpoint: endpoint.trim() || undefined,
          credential: credential.trim() || undefined,
          priority: Number(priority) || 100,
          enabled: true,
        },
        { autoSync },
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      onToast?.(`已复制设备码 ${code}`, 'success');
    } catch {
      // ignore
    }
  };

  if (!open) return null;

  const editionGroup = selectedPreset ? findEditionGroup(selectedPreset.id) : null;
  const isProviderLogin = selectedPreset?.nativeLogin === true;
  const isNativeOAuth =
    selectedPreset?.id === 'openrouter' || selectedPreset?.id === 'github-copilot';

  return (
    <div className="a2a-modal-backdrop" onClick={handleClose}>
      <div
        className="a2a-modal-shell"
        data-dimmed={selectedPreset ? 'true' : undefined}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="添加账号"
      >
        <div className="a2a-modal-header">
          <div>
            <h3 className="a2a-modal-title">添加账号</h3>
            <div className="a2a-modal-subtitle">
              纯内置单进程网关 · 支持官方 API 直连、原生 OAuth 网页登录及任意反代中转
            </div>
          </div>
          <button
            type="button"
            className="a2a-icon-close"
            onClick={handleClose}
            aria-label="关闭"
          >
            <IconClose size={16} />
          </button>
        </div>

        <div className="a2a-modal-toolbar">
          <div className="a2a-pill-tabs">
            {categories.map((c) => {
              const count =
                c.id === 'all'
                  ? allPresets.length
                  : allPresets.filter((p) => p.category === c.id).length;
              return (
                <button
                  key={c.id}
                  type="button"
                  className="a2a-pill-tab"
                  data-active={category === c.id ? 'true' : undefined}
                  onClick={() => setCategory(c.id)}
                >
                  <span>{c.label}</span>
                  <span className="a2a-pill-count">{count}</span>
                </button>
              );
            })}
          </div>
          <label className="a2a-search-input">
            <IconSearch size={14} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索平台名称或协议..."
            />
          </label>
        </div>

        <div className="a2a-modal-body">
          {groupedPresets.length === 0 ? (
            <div className="a2a-muted-meta" style={{ padding: '24px 0', textAlign: 'center' }}>
              未找到匹配的平台，试试其他关键词
            </div>
          ) : (
            groupedPresets.map((group) => (
              <section key={group.id}>
                <div className="a2a-provider-section-head a2a-provider-login-group-head">
                  <div>
                    <div>
                      <span className="a2a-provider-section-title">{group.label}</span>
                      <span className="a2a-provider-section-count">{group.items.length} 项</span>
                    </div>
                    <div className="a2a-provider-section-description">{group.description}</div>
                  </div>
                </div>
                <div className="a2a-provider-grid">
                  {group.items.map((p) => {
                    const existingCount = accountCountsByPreset.get(p.id) ?? 0;
                    const loginMode = providerLoginMode(p);
                    const badge = providerLoginBadge(p);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className="a2a-provider-card"
                        onClick={() => selectPresetForStep2(p)}
                      >
                        <ProviderLogo
                          providerId={p.id}
                          name={p.name || p.id}
                          icon={p.icon}
                          color={p.color}
                          size="md"
                        />
                        <div className="a2a-provider-card-info">
                          <div className="a2a-provider-card-name">{p.name || p.id}</div>
                          <div
                            className="a2a-provider-card-meta"
                            data-has-accounts={existingCount > 0 ? 'true' : undefined}
                          >
                            {existingCount > 0 ? `${existingCount} 个账号 · ` : ''}
                            <span
                              className="a2a-provider-mode-badge"
                              data-mode={loginMode}
                            >
                              {badge}
                            </span>
                          </div>
                        </div>
                        <span className="a2a-provider-card-arrow">›</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      {/* Layered Floating Step-2 Login / Connect Dialog */}
      {selectedPreset && (
        <div className="a2a-login-layer" onClick={handleBackToGrid}>
          <div className="a2a-login-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="a2a-login-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ProviderLogo
                  providerId={selectedPreset.id}
                  name={selectedPreset.name || selectedPreset.id}
                  icon={selectedPreset.icon}
                  color={selectedPreset.color}
                  size="sm"
                />
                <h4 className="a2a-login-title">
                  登录 / 添加 {editionGroup ? editionGroup.baseName : selectedPreset.name} 账号
                </h4>
              </div>
              <button
                type="button"
                className="a2a-icon-close"
                onClick={handleBackToGrid}
                aria-label="返回平台列表"
              >
                <IconClose size={15} />
              </button>
            </div>

            <div className="a2a-login-body">
              {editionGroup && (
                <div className="a2a-login-section">
                  <div className="a2a-login-section-label">账号版本</div>
                  <div className="a2a-login-card">
                    <div className="a2a-login-card-note">{editionGroup.note}</div>
                    <div className="a2a-segment-group">
                      {editionGroup.options.map((opt) => {
                        const active = selectedPreset.id === opt.presetId;
                        return (
                          <button
                            key={opt.presetId}
                            type="button"
                            className="a2a-segment-btn"
                            data-active={active ? 'true' : undefined}
                            onClick={() => {
                              const target = mergedCatalog.items[opt.presetId];
                              if (target) {
                                resetFlowState();
                                setSelectedPreset(target);
                                setEndpoint(target.defaultEndpoint ?? '');
                              }
                            }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              <div className="a2a-login-section">
                <div className="a2a-login-section-label">添加方式</div>
                <div className="a2a-segment-group">
                  <button
                    type="button"
                    className="a2a-segment-btn"
                    data-active={method === 'manual' ? 'true' : undefined}
                    onClick={() => {
                      if (method === 'web') resetFlowState();
                      setError(null);
                      setMethod('manual');
                    }}
                  >
                    API Key / 反代地址
                  </button>
                  {(isProviderLogin || isNativeOAuth || selectedPreset.category !== 'custom' || selectedPreset.officialUrl) && (
                    <button
                      type="button"
                      className="a2a-segment-btn"
                      data-active={method === 'web' ? 'true' : undefined}
                      onClick={() => {
                        setError(null);
                        setMethod('web');
                      }}
                    >
                      {isProviderLogin ? '通过内置网关登录' : isNativeOAuth ? '网页登录 (原生 OAuth)' : '打开官网获取 Key'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="a2a-segment-btn"
                    data-active={method === 'file' ? 'true' : undefined}
                    onClick={() => {
                      if (method === 'web') resetFlowState();
                      setError(null);
                      setMethod('file');
                    }}
                  >
                    导入本地凭证
                  </button>
                </div>
              </div>

              {/* Method 1: Direct API Key / Reverse Proxy */}
              {method === 'manual' && (
                <form id="a2a-manual-form" onSubmit={handleManualSubmit} className="a2a-login-card">
                  <div className="a2a-login-card-note">{selectedPreset.description}</div>
                  <div className="a2a-field">
                    <label className="a2a-field-label">账号名称</label>
                    <input
                      type="text"
                      className="codex-input"
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder={`例如：${selectedPreset.name} 主力号`}
                    />
                  </div>
                  <div className="a2a-field">
                    <label className="a2a-field-label">
                      API Key / 令牌
                      {selectedPreset.fields.some((f) => f.name === 'apiKey' && f.required) && (
                        <span style={{ color: 'var(--color-danger)', marginLeft: 4 }}>*</span>
                      )}
                    </label>
                    <input
                      type="password"
                      className="codex-input"
                      value={credential}
                      onChange={(e) => setCredential(e.target.value)}
                      placeholder="sk-... / ghu_...（AES-256-GCM 本地加密保存）"
                      autoComplete="off"
                    />
                  </div>
                  <div className="a2a-form-grid-2">
                    <div className="a2a-field">
                      <label className="a2a-field-label">API Base URL / 反代地址</label>
                      <input
                        type="text"
                        className="codex-input"
                        value={endpoint}
                        onChange={(e) => setEndpoint(e.target.value)}
                        placeholder={selectedPreset.defaultEndpoint || 'https://api.example.com/v1'}
                      />
                    </div>
                    <div className="a2a-field">
                      <label className="a2a-field-label">路由优先级（越小越优先）</label>
                      <input
                        type="number"
                        className="codex-input"
                        min={1}
                        max={999}
                        value={priority}
                        onChange={(e) => setPriority(e.target.value)}
                      />
                    </div>
                  </div>
                  <label className="a2a-checkbox-row">
                    <input
                      type="checkbox"
                      checked={autoSync}
                      onChange={(e) => setAutoSync(e.target.checked)}
                    />
                    <span>添加后立即拉取上游模型列表并挂载到本地路由网关</span>
                  </label>
                </form>
              )}

              {/* Method 2: Native Self-Contained Web Login */}
              {method === 'web' && (
                <div className="a2a-login-section">
                  <div className="a2a-login-section-label">网页登录</div>
                  <div className="a2a-login-card">
                    {!webFlowId ? (
                      <div className="a2a-login-card-text">
                        {isProviderLogin ? '在供应商网站授权后，内置网关会将凭证加密保存到本机账号池，无需手动粘贴 Token。' : selectedPreset.id === 'openrouter'
                          ? '内置标准 OpenRouter OAuth2 PKCE：新标签页确认授权后自动回调本地 8787 换取 API Key 入池，零外部依赖。'
                          : selectedPreset.id === 'github-copilot'
                            ? '内置官方 GitHub OAuth 设备码登录：获取 8 位验证码并在 GitHub 确认后，自动换取 Copilot 推理令牌直连（无需 Magpie）。'
                            : `点击下方按钮打开 ${selectedPreset.name} 官方控制台，复制 API Key / Token 后粘贴回此处自动加密入池。`}
                      </div>
                    ) : (
                      <div className="a2a-waiting-box">
                        {webUserCode && (
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 10,
                              padding: '10px 12px',
                              borderRadius: 10,
                              background: 'var(--bg-surface)',
                              border: '1px solid var(--border-default)',
                            }}
                          >
                            <div>
                              <div className="a2a-login-card-note">GitHub 设备验证码</div>
                              <div
                                style={{
                                  fontFamily: 'var(--font-mono)',
                                  fontSize: 20,
                                  fontWeight: 700,
                                  letterSpacing: 2,
                                }}
                              >
                                {webUserCode}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="codex-btn"
                              onClick={() => handleCopyCode(webUserCode)}
                            >
                              复制验证码
                            </button>
                          </div>
                        )}

                        <div className="a2a-waiting-row">
                          <span className="a2a-dot" style={{ background: 'var(--color-accent)' }} />
                          <span>{webHint || '等待浏览器完成登录授权…'}</span>
                        </div>

                        {webAuthUrl && (
                          <div>
                            <a
                              href={webAuthUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="a2a-link-btn"
                            >
                              重新打开授权网页 ↗
                            </a>
                          </div>
                        )}

                        {(webEngine === 'openrouter-pkce' || webEngine === 'portal-token') && (
                          <div className="a2a-field">
                            <label className="a2a-field-label">
                              {webEngine === 'openrouter-pkce'
                                ? '未自动回跳？可手动粘贴回调 URL 或 API Key：'
                                : '将官网获取的 API Key / Token 粘贴到此处：'}
                            </label>
                            <div style={{ display: 'flex', gap: 8 }}>
                              <input
                                type="text"
                                className="codex-input"
                                style={{ flex: 1 }}
                                value={webCallbackInput}
                                onChange={(e) => setWebCallbackInput(e.target.value)}
                                placeholder="粘贴 API Key / Token / 回调 URL..."
                              />
                              <button
                                type="button"
                                className="codex-btn codex-btn-primary"
                                disabled={webSubmittingCb}
                                onClick={handleSubmitWebCallback}
                              >
                                {webSubmittingCb ? '提交中…' : '保存入池'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Method 3: Local CLI Auto-Scan + Credential File Import */}
              {method === 'file' && (
                <form id="a2a-import-form" onSubmit={handleImportFileSubmit} className="a2a-login-section">
                  {localCreds.length > 0 && (
                    <div className="a2a-login-card">
                      <div className="a2a-login-section-label">检测到本机 CLI 凭证（一键加密导入）</div>
                      {localCreds.map((c) => (
                        <div
                          key={c.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 10,
                            padding: '8px 10px',
                            borderRadius: 8,
                            background: 'var(--bg-surface)',
                            border: '1px solid var(--border-subtle)',
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{c.label}</div>
                            <div
                              className="a2a-login-card-note"
                              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            >
                              {c.maskedToken || '已检测'} · {c.filePath}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="codex-btn codex-btn-primary"
                            disabled={importingLocalId === c.id}
                            onClick={() => handleImportLocal(c.id)}
                          >
                            {importingLocalId === c.id ? '导入中…' : '一键导入'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {scanningLocal && (
                    <div className="a2a-login-card-note">
                      正在扫描本机 ~/.claude / ~/.codex / ~/.gemini / Copilot 凭证…
                    </div>
                  )}

                  <div className="a2a-login-card">
                    <div className="a2a-login-card-note">
                      支持导入 JSON（<code>~/.codex/auth.json</code>、<code>~/.claude/.credentials.json</code>、<code>~/.gemini/oauth_creds.json</code>、Copilot <code>apps.json</code>）、<code>.env</code> 或原始 Token。
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".json,.txt,.env,.key"
                      style={{ display: 'none' }}
                      onChange={(e) => handleFileChosen(e.target.files?.[0] ?? null)}
                    />
                    <div
                      className="a2a-dropzone"
                      onClick={() => fileInputRef.current?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        handleFileChosen(e.dataTransfer.files?.[0] ?? null);
                      }}
                    >
                      <strong style={{ fontSize: 13 }}>
                        {credFileName ? `已选择：${credFileName}` : '点击选择凭证文件，或拖拽到此处'}
                      </strong>
                      <span className="a2a-login-card-note">
                        自动提取 Token / Endpoint，AES-256-GCM 加密存本地 SQLite
                      </span>
                    </div>

                    <div className="a2a-field">
                      <label className="a2a-field-label">或直接粘贴 JSON / .env / Token 内容</label>
                      <textarea
                        rows={3}
                        className="codex-input"
                        style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
                        value={credContent}
                        onChange={(e) => setCredContent(e.target.value)}
                        placeholder='{"apiKey":"sk-..."} 或 OPENAI_API_KEY=sk-...'
                      />
                    </div>
                  </div>
                </form>
              )}

              {error && (
                <div
                  style={{
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: 'var(--color-danger-soft, #fef2f2)',
                    color: 'var(--color-danger, #dc2626)',
                    fontSize: 12.5,
                  }}
                >
                  {error}
                </div>
              )}
            </div>

            <div className="a2a-login-footer">
              <span className="a2a-login-footer-hint">
                {method === 'web'
                  ? webFlowId
                    ? '授权完成后将自动入池并刷新模型列表'
                    : isProviderLogin ? '由内置网关完成，无需外部服务' : isNativeOAuth
                      ? '单进程内置 OAuth，无需任何外部网关服务'
                      : '将在新标签页打开官网控制台'
                  : method === 'file'
                    ? '凭证仅在本机加密存储，绝不上传第三方'
                    : '添加后即可同时用于 Agent 对话与本地反代网关'}
              </span>

              <div style={{ display: 'flex', gap: 8 }}>
                {method === 'web' && (
                  <button
                    type="button"
                    className="codex-btn codex-btn-primary"
                    disabled={webStarting}
                    onClick={() => webFlowId && webAuthUrl ? window.open(webAuthUrl, '_blank', 'noopener,noreferrer') : void handleStartWebLogin()}
                  >
                    {webStarting ? '正在启动…' : webFlowId ? '重新打开网页' : '打开网页登录'}
                  </button>
                )}
                {method === 'file' && (
                  <button
                    type="submit"
                    form="a2a-import-form"
                    className="codex-btn codex-btn-primary"
                    disabled={submitting}
                  >
                    {submitting ? '导入中…' : '解析并导入账号'}
                  </button>
                )}
                {method === 'manual' && (
                  <button
                    type="submit"
                    form="a2a-manual-form"
                    className="codex-btn codex-btn-primary"
                    disabled={submitting}
                  >
                    {submitting ? '保存中…' : '保存并同步模型'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
