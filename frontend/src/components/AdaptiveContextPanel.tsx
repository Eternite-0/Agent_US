import React, { useCallback, useEffect, useState } from 'react';
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

export const AdaptiveContextPanel: React.FC<AdaptiveContextPanelProps> = ({ client, onToast }) => {
  const [status, setStatus] = useState<ContextSupervisorStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadStatus = useCallback(
    async (signal?: AbortSignal) => {
      if (!client.getContextSupervisor) return;
      setLoading(true);
      setError('');
      try {
        const res = await client.getContextSupervisor(signal);
        if (!signal?.aborted) {
          setStatus(res);
        }
      } catch (err) {
        if (!signal?.aborted) {
          setError(err instanceof Error ? err.message : '加载自适应上下文状态失败');
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    return () => controller.abort();
  }, [loadStatus]);

  const applyPatch = async (patch: ContextSupervisorUpdate, successMsg?: string) => {
    if (!client.updateContextSupervisor) return;
    setSaving(true);
    try {
      const updated = await client.updateContextSupervisor(patch);
      setStatus(updated);
      setError('');
      if (successMsg) onToast(successMsg, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '更新自适应上下文配置失败';
      setError(msg);
      onToast(msg, 'danger');
    } finally {
      setSaving(false);
    }
  };

  if (!client.getContextSupervisor || !client.updateContextSupervisor) {
    return (
      <>
        <div className="codex-settings-heading">
          <div>
            <h1 className="codex-settings-h1">自适应上下文</h1>
            <p className="codex-settings-lede">
              Epoch-based DTOC 可逆压缩、Repoformer 门控与只读 Context Supervisor 策略配置。
            </p>
          </div>
        </div>
        <div className="codex-settings-card">
          <div className="codex-settings-row">
            <div className="codex-settings-row-info">
              <span className="codex-settings-row-label">当前客户端未连接实时后端</span>
              <span className="codex-settings-row-desc">
                切换至「实时后端」模式即可读取号池动态候选模型并管理 Context Supervisor 策略。
              </span>
            </div>
          </div>
        </div>
      </>
    );
  }

  const config = status?.config;
  const candidates = status?.candidates ?? [];
  const effectiveMode: ContextSupervisorMode = config?.mode ?? 'auto';
  const selectedCustomModel =
    config?.model ?? status?.recommendedModel ?? candidates.find((c) => c.healthy)?.alias ?? '';
  const watermarkLabel = (config?.epochWatermarks ?? [0.45, 0.7, 0.85])
    .map((w) => `${Math.round(w * 100)}%`)
    .join(' / ');

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
            结合 Epoch-based DTOC 可逆压缩、Repoformer/RepoCoder 选择性检索与严格只读 Context Supervisor，在保护 KV Prompt Cache 的同时提升长程上下文召回率。
          </p>
        </div>
        <button
          type="button"
          className="codex-toolbar-btn"
          data-variant="outline"
          disabled={loading || saving}
          onClick={() => void loadStatus()}
        >
          {loading ? '刷新中…' : '刷新目录'}
        </button>
      </div>

      {error && (
        <div
          className="codex-settings-card"
          role="alert"
          style={{ marginBottom: 12, borderColor: 'var(--color-danger, #ef4444)' }}
        >
          <div className="codex-settings-row">
            <div className="codex-settings-row-info">
              <span className="codex-settings-row-label" style={{ color: 'var(--color-danger, #ef4444)' }}>
                请求提示
              </span>
              <span className="codex-settings-row-desc">{error}</span>
            </div>
          </div>
        </div>
      )}

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
            aria-checked={Boolean(config?.enabled ?? true)}
            disabled={saving || !status}
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
            <span className="codex-settings-row-label">选型模式</span>
            <span className="codex-settings-row-desc">
              Auto 模式将从您的实时账号池动态优选轻量/低延迟模型；Off 模式仅使用确定性零 LLM 规则。
            </span>
          </div>
          <select
            aria-label="Supervisor 选型模式"
            className="codex-select"
            disabled={saving || !status}
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
              {status
                ? effectiveMode === 'auto'
                  ? `当前生效：${status.effectiveModel ?? '确定性零 LLM 回退'} · ${formatRationale(status.rationale)}`
                  : effectiveMode === 'custom'
                    ? `自定义生效：${status.effectiveModel ?? '不可用（已 Fail-Closed 回退）'} · ${formatRationale(status.rationale)}`
                    : formatRationale(status.rationale)
                : '正在读取实时号池模型列表…'}
            </span>
          </div>
          <select
            aria-label="Supervisor 候选模型"
            className="codex-select"
            style={{ minWidth: 220, maxWidth: 320 }}
            disabled={saving || !status || effectiveMode !== 'custom' || candidates.length === 0}
            value={
              effectiveMode === 'custom'
                ? selectedCustomModel
                : (status?.effectiveModel ?? status?.recommendedModel ?? '')
            }
            onChange={(e) => {
              const model = e.target.value;
              if (!model) return;
              void applyPatch({ mode: 'custom', model }, `已指定 Supervisor 模型：${model}`);
            }}
          >
            {candidates.length === 0 ? (
              <option value="">暂无可用号池模型（确定性零 LLM）</option>
            ) : (
              candidates.map((c) => (
                <option key={c.alias} value={c.alias}>
                  {formatCandidateOption(c)}
                </option>
              ))
            )}
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
          <span className="codex-status-chip" data-tone="success">
            {status?.readOnly !== false ? '只读隔离 (tools: [])' : '受限'}
          </span>
        </div>

        <div className="codex-settings-row">
          <div className="codex-settings-row-info">
            <span className="codex-settings-row-label">可逆上下文存储 (Reversible Context Store)</span>
            <span className="codex-settings-row-desc">
              老旧工具输出压缩为紧凑 <code>[ACI-REF artifact://...]</code> 存根，原文全量落盘 SQLite Blobs，支持逐级展开与 100% 无损恢复；错误栈、失败断言与活跃修改文件永不丢弃。
            </span>
          </div>
          <span className="codex-status-chip" data-tone="success">
            {status?.reversibleStore !== false ? '已启用 · 100% 无损恢复' : '未启用'}
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
            <span className="codex-settings-row-label">ACON 失败经验上下文准则</span>
            <span className="codex-settings-row-desc">
              仅从已验证失败诊断中沉淀脱敏、密文擦除的自然语言上下文规则（上限 12 条）。
            </span>
          </div>
          <span className="codex-status-chip">
            {status ? `${status.guidelinesCount} / 12 条` : '—'}
          </span>
        </div>
      </div>
    </>
  );
};
