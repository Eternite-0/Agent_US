import React from 'react';
import type { TaskVerdict } from '../types/backend';
import { IconCheck, IconShieldAlert } from './Icons';

interface EvidenceBadgeProps {
  verdict?: TaskVerdict | null;
  evidenceCount?: number;
}

export const EvidenceBadge: React.FC<EvidenceBadgeProps> = ({
  verdict,
  evidenceCount = 0,
}) => {
  if (!verdict && evidenceCount <= 0) return null;

  const blockedReconcile = verdict?.verdict === 'block_reconciliation';
  const failed = verdict && verdict.accepted === false;
  const label = blockedReconcile
    ? '待人工核对'
    : failed
      ? '验证未通过'
      : evidenceCount > 0
        ? `已验证 · ${evidenceCount} 条回执`
        : '已通过验证';

  const tone = blockedReconcile || failed ? 'warning' : 'success';

  return (
    <span
      className="codex-status-chip tabular-nums"
      data-tone={tone}
      title={verdict?.reasons?.join('；') || verdict?.reason || label}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5 }}
    >
      {blockedReconcile || failed ? <IconShieldAlert size={11} /> : <IconCheck size={11} />}
      <span>{label}</span>
    </span>
  );
};
