import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ToastItem } from '../types/backend';
import './status-microfeedback.css';

const dotTone = { default: 'demo', success: 'live', warning: 'warn', danger: 'danger' } as const;

function ToastSlot({ toast, exiting, onExited }: {
  toast: ToastItem;
  exiting: boolean;
  onExited: (id: string) => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const focusOrigin = useRef<HTMLElement | null>(null);
  const { id, message, tone, actionLabel, onAction } = toast;

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    if (exiting && slot.contains(document.activeElement)) {
      const origin = focusOrigin.current;
      if (origin?.isConnected && !origin.closest('[inert], [data-toast-exiting="true"]')) {
        origin.focus({ preventScroll: true });
      }
      if (document.activeElement instanceof HTMLElement && slot.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    }
    slot.inert = exiting;
    if (!exiting) {
      slot.removeAttribute('aria-hidden');
      return;
    }
    slot.setAttribute('aria-hidden', 'true');

    // Wait only for the card and its stack slot. Reduced motion yields no transitions;
    // toggling the preference mid-exit cancels them and also releases the slot.
    const animations = [...slot.getAnimations(), ...(cardRef.current?.getAnimations() ?? [])];
    if (!animations.length) {
      onExited(id);
      return;
    }
    let current = true;
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (current) onExited(id);
    });
    return () => { current = false; };
  }, [exiting, id, onExited]);

  return (
    <div ref={slotRef} className="toast-stack-slot" data-toast-exiting={exiting}>
      <div className="toast-stack-content">
        <div ref={cardRef} className="codex-toast">
          <span className="codex-status-dot" data-tone={dotTone[tone ?? 'default']} aria-hidden="true" />
          <span className="toast-stack-message">{message}</span>
          {actionLabel && onAction && (
            <button type="button" className="codex-toast-action" onClick={onAction}
              onFocus={(event) => {
                focusOrigin.current = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
              }}>
              {actionLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ToastHost({ toasts }: { toasts: ToastItem[] }) {
  const [stack, setStack] = useState({ source: toasts, items: toasts });
  const active = new Map(toasts.map((toast) => [toast.id, toast]));

  if (stack.source !== toasts) {
    // The host receives an append-only queue with removals. Keep those removals in their
    // original slots just long enough to fade and collapse, without keeping them actionable.
    const pending = new Map(active);
    const items = stack.items.map((item) => {
      const next = pending.get(item.id);
      pending.delete(item.id);
      return next ?? item;
    });
    setStack({ source: toasts, items: [...items, ...pending.values()] });
  }

  const onExited = useCallback((id: string) => {
    setStack((current) => current.source.some((toast) => toast.id === id)
      ? current
      : { ...current, items: current.items.filter((toast) => toast.id !== id) });
  }, []);

  return (
    <>
      {/* Present before the first toast; only live data (not exit copies or buttons) is announced. */}
      <div className="toast-stack-announcements" role="status" aria-live="polite" aria-atomic="false" aria-relevant="additions text">
        {toasts.map(({ id, message, actionLabel, onAction }) => (
          <div key={id}>{message}{actionLabel && onAction ? ` · ${actionLabel}` : ''}</div>
        ))}
      </div>
      {stack.items.length > 0 && (
        <div className="codex-toast-host toast-stack">
          {stack.items.map((toast) => (
            <ToastSlot key={toast.id} toast={toast} exiting={!active.has(toast.id)} onExited={onExited} />
          ))}
        </div>
      )}
    </>
  );
}
