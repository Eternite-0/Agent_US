import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { IconRefresh } from './Icons';
import type {
  AgentBackendClient,
  ContextSupervisorCandidate,
  ContextSupervisorMode,
  ContextSupervisorStatus,
  ContextSupervisorUpdate,
} from '../api/client';

export type {
  ContextSupervisorCandidate,
  ContextSupervisorConfig,
  ContextSupervisorMode,
  ContextSupervisorStatus,
  ContextSupervisorUpdate,
} from '../api/client';

interface AdaptiveContextPanelProps {
  client: AgentBackendClient;
  onToast: (msg: string, tone?: 'default' | 'success' | 'warning' | 'danger') => void;
}

const RATIONALE_LABELS: Record<string, string> = {
  auto_tier_fast_heuristic: '已根据轻量级/低延迟层级启发式动态匹配',
  pool_default_fallback: '当前无轻量级模型，回退至号池默认模型',
  auto_catalog_best_healthy: '已从活跃号池目录选择最优健康模型',
  custom_model_selected: '已使用用户指定的自定义模型',
  no_healthy_route_deterministic_fallback: '号池暂无健康路由，已自动降级为确定性零 LLM 模式',
  custom_model_missing_deterministic_fallback: '未指定自定义模型，已降级为确定性模式',
  custom_model_unavailable_deterministic_fallback: '所选自定义模型当前不可用，已 Fail-Closed 回退至确定性模式',
  supervisor_disabled: '自适应上下文 Supervisor 已停用',
  supervisor_mode_off: 'Supervisor 模式已设为关闭（仅运行确定性 ACI 规则）',
};

function formatRationale(rationale: string): string {
  return RATIONALE_LABELS[rationale] ?? rationale;
}

function formatCandidateOption(candidate: ContextSupervisorCandidate): string {
  const parts = [candidate.alias];
  if (candidate.provider) parts.push(`(${candidate.provider})`);
  if (candidate.recommended) parts.push('· 后端推荐');
  if (!candidate.healthy) parts.push('[冷却/不可用]');
  return parts.join(' ');
}

type RequestIssue = { title: string; detail: string; blocksEditing: boolean };

function requestIssue(error: unknown, action: 'load' | 'save'): RequestIssue {
  if (error instanceof ApiError && error.status === 404) {
    return { title: '当前后端未提供自适应上下文接口', detail: '请更新并重启 Agent_US 后端，或在「连接与端点」确认连接地址，再刷新目录。', blocksEditing: true };
  }
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return { title: '无法访问自适应上下文', detail: '请在「连接与端点」检查后端地址和启动密钥。', blocksEditing: true };
  }
  return action === 'load'
    ? { title: '暂时无法刷新目录', detail: '请检查后端连接后重试。', blocksEditing: true }
    : { title: '未能保存设置', detail: '未确认此次更改，请重试或刷新目录核对设置。', blocksEditing: false };
}

export const AdaptiveContextPanel: React.FC<AdaptiveContextPanelProps> = ({ client, onToast }) => {
  const supported = Boolean(client.getContextSupervisor && client.updateContextSupervisor);
  const [status, setStatus] = useState<ContextSupervisorStatus | null>(null);
  const [loading, setLoading] = useState(supported);
  const [saving, setSaving] = useState(false);
  const [issue, setIssue] = useState<RequestIssue | null>(null);
  const [dtocMinDraft, setDtocMinDraft] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef(false);

  const loadStatus = useCallback(async (controller: AbortController) => {
    if (!client.getContextSupervisor || pending.current || controller.signal.aborted) return;
    pending.current = true;
    setLoading(true);
    setIssue(null);
    try {
      const res = await client.getContextSupervisor(AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]));
      if (!res?.config || !Array.isArray(res.candidates)) throw new Error('Invalid supervisor status');
      if (controller.signal.aborted) return;
      setStatus(res);
      setDtocMinDraft(String(res.config.dtocMinPromptTokens ?? 24_000));
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && (error.status === 404 || error.status === 401 || error.status === 403)) setStatus(null);
      setIssue(requestIssue(error, 'load'));
    } finally {
      if (!controller.signal.aborted) {
        pending.current = false;
        setLoading(false);
      }
    }
  }, [client]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    pending.current = false;
    setStatus(null);
    setIssue(null);
    setSaving(false);
    setDtocMinDraft('');
    if (supported) void loadStatus(controller);
    return () => controller.abort();
  }, [loadStatus, supported]);

  const applyPatch = async (patch: ContextSupervisorUpdate, successMsg: string) => {
    const signal = lifetime.current?.signal;
    if (!client.updateContextSupervisor || !signal || signal.aborted || pending.current || !status || issue?.blocksEditing) return;
    pending.current = true;
    setSaving(true);
    setIssue(null);
    try {
      const updated = await client.updateContextSupervisor(patch, AbortSignal.any([signal, AbortSignal.timeout(12_000)]));
      if (!updated?.config || !Array.isArray(updated.candidates)) throw new Error('Invalid supervisor status');
      if (signal.aborted) return;
      setStatus(updated);
      setDtocMinDraft(String(updated.config.dtocMinPromptTokens ?? 24_000));
      onToast(successMsg, 'success');
    } catch (error) {
      if (signal.aborted) return;
      const next = requestIssue(error, 'save');
      if (next.blocksEditing) setStatus(null);
      setIssue(next);
    } finally {
      if (!signal.aborted) {
        pending.current = false;
        setSaving(false);
      }
    }
  };

  const config = status?.config;
  const candidates = status?.candidates ?? [];
  const effectiveMode: ContextSupervisorMode = config?.mode ?? 'auto';
  const selectedModel = effectiveMode === 'custom' ? config?.model : status?.effectiveModel;
  const hasSelectedModel = candidates.some((candidate) => candidate.alias === selectedModel);
  const editingDisabled = loading || saving || Boolean(issue?.blocksEditing);
  const watermarkLabel = (config?.epochWatermarks ?? [0.6, 0.82])
    .map((w) => `${Math.round(w * 100)}%`)
    .join(' / ');
  const currentDtocMinTokens = config?.dtocMinPromptTokens ?? 24000;
  const watermarks = status?.budgetWatermarks ?? null;
  const circuitOpen = Boolean(
    status?.supervisorCircuitOpen ?? status?.circuitOpen ?? watermarks?.supervisorCircuitOpen,
  );
  const circuitTimeoutSec =
    Math.round((((config?.circuitTimeoutMs ?? config?.timeoutMs ?? 8000) || 8000) / 1000) * 10) / 10;
  const usedTok = watermarks?.usedTokens;
  const maxTok = watermarks?.maxTokens;
  const dtocWatermarkTok = watermarks?.dtocWatermark;
  const postTestReserveActive = Boolean(watermarks?.postTestReserveActive);
  const parsedDtocMinDraft = Number(dtocMinDraft);
  const dtocMinDraftValid =
    Number.isInteger(parsedDtocMinDraft) && parsedDtocMinDraft >= 1000 && parsedDtocMinDraft <= 200000;
  const dtocMinDirty = dtocMinDraftValid && parsedDtocMinDraft !== currentDtocMinTokens;

  const handleModeChange = (nextMode: ContextSupervisorMode) => {
    if (nextMode === 'custom') {
      const fallbackModel =
        config?.model ||
        status?.recommendedModel ||
        candidates.find((c) => c.healthy)?.alias ||
        candidates[0]?.alias ||
        '';
      if (!fallbackModel) {
        onToast('当前账号池暂无可用候选模型，请先在「账号池 / 模型管理」添加并同步模型。', 'warning');
        return;
      }
      void applyPatch({ mode: 'custom', model: fallbackModel }, `已切换为自定义模型：${fallbackModel}`);
      return;
    }
    void applyPatch(
      { mode: nextMode },
      nextMode === 'auto' ? '已切换为自动选型模式 (Auto)' : '已将 Context Supervisor 设为关闭 (Off)',
    );
  };

  return (
    <>
      <div className="codex-settings-heading">
        <div>
          <h1 className="codex-settings-h1">自适应上下文</h1>
          <p className="codex-settings-lede">
            管理长对话的上下文压缩、工具输出准入，以及只读 Supervisor 的模型选择。
          </p>
        </div>
        {supported && (
          <button
            type="button"
            className="codex-toolbar-btn"
            data-variant="outline"
            disabled={loading || saving}
            onClick={() => { if (lifetime.current) void loadStatus(lifetime.current); }}
          >
            <IconRefresh size={14} />
            {loading ? '刷新中…' : '刷新目录'}
          </button>
        )}
      </div>

      {issue && (
        <div className="codex-settings-notice" data-tone="warning" role="alert">
          <strong>{issue.title}</strong>
          <p>{issue.detail}{status && issue.blocksEditing ? ' 下方为上次读取的状态，暂不可编辑。' : ''}</p>
        </div>
      )}
      {!supported && (
        <div className="codex-settings-notice" role="status">
          <strong>需要实时后端</strong>
          <p>请在「常规」切换至实时后端模式后管理此设置。</p>
        </div>
      )}
      {supported && loading && !status && (
        <div className="codex-settings-notice" role="status">正在读取自适应上下文设置…</div>
      )}
      {status && <div aria-busy={loading || saving}>
        <div className="codex-settings-section-title">Context Supervisor 策略</div>
        <div className="codex-settings-card">
          <div className="codex-settings-row">
            <div className="codex-settings-row-info">
              <span className="codex-settings-row-label">启用自适应上下文 (ACI)</span>
              <span className="codex-settings-row-desc">
                开启后将按预算水位线执行可逆摘要折叠，并允许只读 Supervisor 辅助决策保留/展开建议。
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="启用自适应上下文"
              aria-checked={status.config.enabled}
              disabled={editingDisabled}
              className="codex-switch"
              onClick={() => {
                const next = !(config?.enabled ?? true);
                void applyPatch(
                  { enabled: next },
                  next ? '已开启自适应上下文' : '已关闭自适应上下文',
                );
              }}
            >
              <span className="codex-switch-thumb" />
            </button>
          </div>

          <div className="codex-settings-row">
            <div className="codex-settings-row-info">
              <span className="codex-settings-row-label">启用注入前上下文准入治理 (Pre-Injection Admission)</span>
              <span className="codex-settings-row-desc">
                在工具输出写入主对话前按 DIRECT / SUPPORTING / DEFER / DUPLICATE / IRRELEVANT 渐进分级，保护关键领域并减少噪声注入。
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="启用注入前上下文准入治理"
              aria-checked={Boolean(config?.admissionEnabled ?? true)}
              disabled={editingDisabled}
              className="codex-switch"
              onClick={() => {
                const next = !(config?.admissionEnabled ?? true);
                void applyPatch(
                  { admissionEnabled: next },
                  next ? '已开启注入前准入治理' : '已关闭注入前准入治理',
                );
              }}
            >
              <span className="codex-switch-thumb" />
            </button>
          </div>

          <div className="codex-settings-row">
            <div className="codex-settings-row-info">
              <span className="codex-settings-row-label">选型模式</span>
              <span className="codex-settings-row-desc">
                Auto 模式将从您的实时账号池动态优选轻量/低延迟模型；Off 模式仅使用确定性零 LLM 规则。
              </span>
            </div>
            <select
              aria-label="Supervisor 选型模式"
              className="codex-select"
              disabled={editingDisabled}
              value={effectiveMode}
              onChange={(e) => handleModeChange(e.target.value as ContextSupervisorMode)}
            >
              <option value="auto">Auto（自动优选）</option>
              <option value="custom">Custom（自定义模型）</option>
              <option value="off">Off（仅确定性规则）</option>
            </select>
          </div>

          <div className="codex-settings-row">
            <div className="codex-settings-row-info">
              <span className="codex-settings-row-label">Supervisor 模型（实时号池目录）</span>
              <span className="codex-settings-row-desc">
                {effectiveMode === 'auto'
                    ? `当前生效：${status.effectiveModel ?? '确定性零 LLM 回退'} · ${formatRationale(status.rationale)}`
                    : effectiveMode === 'custom'
                      ? `自定义生效：${status.effectiveModel ?? '不可用（已 Fail-Closed 回退）'} · ${formatRationale(status.rationale)}`
                      : formatRationale(status.rationale)}
              </span>
            </div>
            <select
              aria-label="Supervisor 候选模型"
              className="codex-select"
              disabled={editingDisabled || effectiveMode !== 'custom' || candidates.length === 0}
              value={selectedModel ?? ''}
              onChange={(e) => {
                const model = e.target.value;
                if (!model) return;
                void applyPatch({ mode: 'custom', model }, `已指定 Supervisor 模型：${model}`);
              }}
            >
              {!hasSelectedModel && (
                <option value={selectedModel ?? ''} disabled>
                  {selectedModel ? `${selectedModel}（不在候选目录）`
                    : effectiveMode === 'off' ? '不使用模型'
                      : '未使用模型（仅确定性规则）'}
                </option>
              )}
              {candidates.map((c) => (
                <option key={c.alias} value={c.alias}>{formatCandidateOption(c)}</option>
              ))}
            </select>
          </div>

          {status?.recommendedModel && (
            <div className="codex-settings-row">
              <div className="codex-settings-row-info">
                <span className="codex-settings-row-label">后端推荐模型</span>
                <span className="codex-settings-row-desc">
                  {formatRationale(status.recommendedRationale)}
                </span>
              </div>
              <span className="codex-status-chip" data-tone="success" style={{ fontFamily: 'var(--font-mono)' }}>
                {status.recommendedModel}
              </span>
            </div>
          )}
        </div>

        <div className="codex-settings-section-title">安全边界与可逆存储状态</div>
        <div className="codex-settings-card">
          <div className="codex-settings-row">
            <div className="codex-settings-row-info">
              <span className="codex-settings-row-label">Supervisor 只读安全边界</span>
              <span className="codex-settings-row-desc">
                强制使用 <code>tools: []</code>（零文件写入、零命令执行、零审批权限），仅输出有界 JSON 建议；超时或异常自动 Fail-Closed 回退至确定性 ACI。
              </span>
            </div>
            <span className="codex-status-chip" data-tone={status.readOnly ? 'success' : undefined}>
              {status.readOnly ? '只读隔离 (tools: [])' : '受限'}
            </span>
          </div>

          <div className="codex-settings-row">
            <div className="codex-settings-row-info">
              <span className="codex-settings-row-label">可逆上下文存储 (Reversible Context Store)</span>
              <span className="codex-settings-row-desc">
                老旧工具输出压缩为紧凑 <code>[ACI-REF artifact://...]</code> 存根，原文全量落盘 SQLite Blobs，支持逐级展开与 100% 无损恢复；错误栈、失败断言与活跃修改文件永不丢弃。
              </span>
            </div>
            <span className="codex-status-chip" data-tone={status.reversibleStore ? 'success' : undefined}>
              {status.reversibleStore ? '已启用 · 100% 无损恢复' : '未启用'}
            </span>
          </div>

          <div className="codex-settings-row">
            <div className="codex-settings-row-info">
              <span className="codex-settings-row-label">Epoch 水位线与 KV Cache 保护</span>
              <span className="codex-settings-row-desc">
                仅在跨越水位线阈值或单步输入超限时触发压缩，水位线之间保持前缀字节完全一致以维持 KV Prompt Cache 命中率。
              </span>
            </div>
            <span className="codex-status-chip" style={{ fontFamily: 'var(--font-mono)' }}>
              {watermarkLabel} · 上限 {Math.round((config?.maxBudgetRatio ?? 0.72) * 100)}%
            </span>
          </div>

          <div className="codex-settings-row">
            <div className="codex-settings-row-info">
              <span className="codex-settings-row-label">ACI 2.5 预算水位与完工保留金</span>
              <span className="codex-settings-row-desc">
                {usedTok !== undefined && maxTok !== undefined
                  ? `活跃预算占用 ${usedTok.toLocaleString()} / ${maxTok.toLocaleString()} tokens`
                  : '单步 DTOC 水位门限与验证后收尾保留金（防止长任务写完未交卷时提前耗尽上下文）'}
                {dtocWatermarkTok !== undefined ? ` · 单步 DTOC 水位 ${dtocWatermarkTok.toLocaleString()} tokens` : ''}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
              <span className="codex-status-chip tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
                {usedTok !== undefined && maxTok !== undefined
                  ? `${usedTok.toLocaleString()} / ${maxTok.toLocaleString()}`
                  : `单步水位 ${(dtocWatermarkTok ?? currentDtocMinTokens).toLocaleString()} tok`}
              </span>
              <span className="codex-status-chip" data-tone={postTestReserveActive ? 'warning' : undefined}>
                {postTestReserveActive ? '完工保留金已激活' : '完工保留就绪'}
              </span>
            </div>
          </div>

          <div className="codex-settings-row">
            <div className="codex-settings-row-info">
              <span className="codex-settings-row-label">Supervisor {circuitTimeoutSec}s 熔断器</span>
              <span className="codex-settings-row-desc">
                单次只读 Supervisor 超时超过 {circuitTimeoutSec}s 自动 Fail-Closed 并打开短时熔断，直接回退至确定性 ACI。
              </span>
            </div>
            <span className="codex-status-chip" data-tone={circuitOpen ? 'warning' : 'success'}>
              {circuitOpen ? `熔断已开启 · 回退确定性 (${circuitTimeoutSec}s)` : `正常闭合 (${circuitTimeoutSec}s)`}
            </span>
          </div>

          <div className="codex-settings-row">
            <div className="codex-settings-row-info">
              <span className="codex-settings-row-label">DTOC 最小单步提示词阈值 (tokens)</span>
              <span className="codex-settings-row-desc">
                单步提示词低于此门限时跳过常规 Epoch DTOC 折叠，保护短任务前缀缓存（范围 1,000 – 200,000，默认 24,000）。
              </span>
            </div>
            <div className="codex-settings-actions">
              <input
                type="number"
                aria-label="DTOC 最小单步提示词阈值"
                className="codex-input"
                style={{ width: 112, fontFamily: 'var(--font-mono)' }}
                min={1000}
                max={200000}
                step={1}
                aria-invalid={!dtocMinDraftValid || undefined}
                disabled={editingDisabled}
                value={dtocMinDraft}
                onChange={(e) => setDtocMinDraft(e.target.value)}
              />
              <button
                type="button"
                className="codex-toolbar-btn"
                data-variant="outline"
                disabled={editingDisabled || !dtocMinDirty}
                onClick={() => {
                  if (!dtocMinDraftValid) return;
                  void applyPatch(
                    { dtocMinPromptTokens: parsedDtocMinDraft },
                    `已更新 DTOC 最小单步提示词阈值为 ${parsedDtocMinDraft} tokens`,
                  );
                }}
              >
                应用
              </button>
            </div>
          </div>

          <div className="codex-settings-row">
            <div className="codex-settings-row-info">
              <span className="codex-settings-row-label">ACON 失败经验上下文准则</span>
              <span className="codex-settings-row-desc">
                仅从已验证失败诊断中沉淀脱敏、密文擦除的自然语言上下文规则（上限 12 条）。
              </span>
            </div>
            <span className="codex-status-chip">
              {status.guidelinesCount} / 12 条
            </span>
          </div>
        </div>
      </div>}
    </>
  );
};
