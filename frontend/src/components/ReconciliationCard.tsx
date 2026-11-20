import React from 'react';
import type { Approval } from '../types/backend';
import { IconShieldAlert } from './Icons';

interface ReconciliationCardProps {
  approval: Approval;
  busy?: boolean;
  onResolve: (
    approval: Approval,
    outcome: 'happened' | 'not_applied' | 'abort',
  ) => void;
}

export const ReconciliationCard: React.FC<ReconciliationCardProps> = ({
  approval,
  busy = false,
  onResolve,
}) => {
  const argsSummary = JSON.stringify(approval.action ?? {});

  return (
    <div
      className="codex-approval-card"
      data-status={approval.status}
      style={{ borderColor: 'var(--color-warning)' }}
    >
      <div className="codex-approval-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <IconShieldAlert size={16} style={{ color: 'var(--color-warning)', flex: 'none' }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-default)' }}>
              外部副作用状态未知 — 需人工核对 ({approval.tool})
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>
              进程在不可重放操作执行期间中断。系统已暂停自动重试，请核对真实结果后选择处理方式：
            </div>
          </div>
        </div>
        {approval.receiptId && (
          <span className="codex-status-chip" data-tone="warning">
            回执 {approval.receiptId.slice(0, 8)}
          </span>
        )}
      </div>

      {argsSummary && argsSummary !== '{}' && (
        <pre
          className="a2a-tool-output"
          style={{ marginTop: 8, maxHeight: 110, fontSize: 11.5 }}
        >
          {argsSummary}
        </pre>
      )}

      {approval.status === 'pending' ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            marginTop: 10,
            justifyContent: 'flex-end',
          }}
        >
          <button
            type="button"
            className="codex-toolbar-btn"
            data-variant="outline"
            disabled={busy}
            onClick={() => onResolve(approval, 'abort')}
          >
            中止任务 (abort)
          </button>
          <button
            type="button"
            className="codex-toolbar-btn"
            data-variant="outline"
            disabled={busy}
            onClick={() => onResolve(approval, 'not_applied')}
          >
            确认未执行・可重试
          </button>
          <button
            type="button"
            className="codex-toolbar-btn"
            data-variant="primary"
            disabled={busy}
            onClick={() => onResolve(approval, 'happened')}
          >
            确认已发生・继续恢复
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 6 }}>
          已核对：{approval.outcome || approval.status}
        </div>
      )}
    </div>
  );
};
