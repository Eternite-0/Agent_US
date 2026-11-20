import React from 'react';
import type { ToastItem } from '../types/backend';

interface ToastHostProps {
  toasts: ToastItem[];
}

export const ToastHost: React.FC<ToastHostProps> = ({ toasts }) => {
  if (!toasts.length) return null;

  return (
    <div className="codex-toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="codex-toast">
          <span
            className="codex-status-dot"
            data-tone={
              t.tone === 'success'
                ? 'live'
                : t.tone === 'warning'
                  ? 'warn'
                  : t.tone === 'danger'
                    ? 'danger'
                    : 'demo'
            }
          />
          <span>{t.message}</span>
          {t.actionLabel && t.onAction && (
            <button
              type="button"
              className="codex-toast-action"
              onClick={t.onAction}
            >
              {t.actionLabel}
            </button>
          )}
        </div>
      ))}
    </div>
  );
};
