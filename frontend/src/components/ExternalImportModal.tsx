import React, { useState } from 'react';
import type { ExternalConfigDetectResult, ExternalConfigItem } from '../types/backend';
import { ComposerDialog } from './ComposerDialog';
import { IconDownload, IconRefresh, IconShieldAlert } from './Icons';

export interface ExternalImportModalProps {
  open: boolean;
  loading: boolean;
  busy: boolean;
  result: ExternalConfigDetectResult | null;
  error?: string;
  onClose: () => void;
  onRefresh: () => void;
  onImport: (itemIds: string[], targetScope: 'auto' | 'user' | 'workspace') => Promise<void>;
  onSkip: () => Promise<void>;
}

const KIND_LABELS: Record<string, string> = {
  rule: '规则',
  command: '命令',
  skill: '技能',
  agent: '代理',
  mcp: 'MCP',
};

function formatBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatProvider(provider: string, scope: string): string {
  const lower = provider.toLowerCase();
  if (lower.includes('claude')) return '~/.claude';
  if (lower.includes('codex')) return '~/.codex';
  if (scope === 'workspace') return '工作区';
  return provider;
}

export const ExternalImportModal: React.FC<ExternalImportModalProps> = ({
  open,
  loading,
  busy,
  result,
  error,
  onClose,
  onRefresh,
  onImport,
  onSkip,
}) => {
  const items: ExternalConfigItem[] = result?.items ?? [];
  const itemsSignature = items.map((item) => item.id).join('\n');
  const [lastSignature, setLastSignature] = useState(itemsSignature);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => items.map((item) => item.id));
  const [targetScope, setTargetScope] = useState<'auto' | 'user' | 'workspace'>('auto');

  if (itemsSignature !== lastSignature) {
    setLastSignature(itemsSignature);
    setSelectedIds(items.map((item) => item.id));
  }

  const selectedSet = new Set(selectedIds);
  const allSelected = items.length > 0 && selectedIds.length === items.length;
  const hasMcp = items.some((item) => item.kind === 'mcp' && selectedSet.has(item.id));
  const counts = result?.counts;

  const toggleItem = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const toggleAll = () => {
    setSelectedIds(allSelected ? [] : items.map((item) => item.id));
  };

  return (
    <ComposerDialog
      open={open}
      title="导入外部配置"
      className="codex-external-import-dialog"
      onClose={onClose}
    >
      <div className="codex-external-import-body">
        <p className="codex-external-import-lead">
          显式选择要迁移到 Agent_US 原生目录的外部配置（~/.claude / ~/.codex / 工作区命令与规则）。
          未授权确认前不会自动激活任何外部配置。
        </p>

        {counts && counts.total > 0 && (
          <div className="codex-external-import-summary">
            <span className="codex-external-import-chip">共 {counts.total} 项</span>
            {counts.rules > 0 && <span className="codex-external-import-chip">规则 {counts.rules}</span>}
            {counts.commands > 0 && <span className="codex-external-import-chip">命令 {counts.commands}</span>}
            {counts.skills > 0 && <span className="codex-external-import-chip">技能 {counts.skills}</span>}
            {counts.agents > 0 && <span className="codex-external-import-chip">代理 {counts.agents}</span>}
            {counts.mcp > 0 && <span className="codex-external-import-chip">MCP {counts.mcp}</span>}
          </div>
        )}

        {error && (
          <div className="codex-external-import-alert" role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <div className="codex-external-import-empty">
            正在扫描本机及工作区外部配置…
          </div>
        ) : items.length === 0 ? (
          <div className="codex-external-import-empty">
            未检测到可导入的外部配置（~/.claude、~/.codex 或工作区 .claude）。
          </div>
        ) : (
          <>
            <div className="codex-external-import-toolbar">
              <button
                type="button"
                className="codex-toolbar-btn"
                onClick={toggleAll}
                disabled={busy}
              >
                {allSelected ? '取消全选' : '全选'}（{selectedIds.length}/{items.length}）
              </button>
              <label className="codex-external-import-scope">
                <span>目标位置</span>
                <select
                  value={targetScope}
                  onChange={(e) => setTargetScope(e.target.value as 'auto' | 'user' | 'workspace')}
                  disabled={busy}
                >
                  <option value="auto">按原作用域自动</option>
                  <option value="user">用户目录 (~/.agent-us)</option>
                  <option value="workspace">当前工作区 (.agent-us)</option>
                </select>
              </label>
            </div>

            <div className="codex-external-import-list" role="group" aria-label="可导入的外部配置项">
              {items.map((item) => {
                const checked = selectedSet.has(item.id);
                const sizeText = formatBytes(item.bytes);
                return (
                  <label
                    key={item.id}
                    className="codex-external-import-item"
                    data-checked={checked ? 'true' : 'false'}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleItem(item.id)}
                      disabled={busy}
                    />
                    <div className="codex-external-import-item-main">
                      <div className="codex-external-import-item-head">
                        <span className="codex-external-import-badge" data-kind={item.kind}>
                          {KIND_LABELS[item.kind] ?? item.kind}
                        </span>
                        <span className="codex-external-import-provider">
                          {formatProvider(item.provider, item.scope)}
                        </span>
                        <strong className="codex-external-import-name">{item.name}</strong>
                        {sizeText && <span className="codex-external-import-size">{sizeText}</span>}
                      </div>
                      <div className="codex-external-import-path">{item.displayPath}</div>
                      {item.summary && (
                        <div className="codex-external-import-item-summary">{item.summary}</div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>

            {hasMcp && (
              <div className="codex-external-import-mcp-note">
                <IconShieldAlert size={13} />
                <span>所选外部 MCP 服务器导入后默认标记为未信任（untrusted），需在设置中单独启用。</span>
              </div>
            )}
          </>
        )}

        <div className="codex-external-import-footer">
          <button
            type="button"
            className="codex-toolbar-btn"
            onClick={onRefresh}
            disabled={busy || loading}
          >
            <IconRefresh size={12} />
            <span>重新扫描</span>
          </button>
          <div className="codex-external-import-actions">
            <button
              type="button"
              className="codex-toolbar-btn"
              onClick={() => void onSkip()}
              disabled={busy}
            >
              暂不导入 / 跳过
            </button>
            <button
              type="button"
              className="codex-toolbar-btn"
              data-variant="primary"
              disabled={busy || loading || selectedIds.length === 0}
              onClick={() => void onImport(selectedIds, targetScope)}
            >
              <IconDownload size={12} />
              <span>{busy ? '导入中…' : `一键导入 (${selectedIds.length})`}</span>
            </button>
          </div>
        </div>
      </div>
    </ComposerDialog>
  );
};
