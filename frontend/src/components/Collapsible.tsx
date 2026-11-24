import { useCallback, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';

interface CollapsibleProps {
  open: boolean;
  id?: string;
  className?: string;
  anchor?: string;
  keepMounted?: boolean;
  onClosed?: () => void;
  children: ReactNode;
}

/** Pin the sampled frame before retargeting, so reversed toggles do not jump. */
export function Collapsible({ open, id, className = '', anchor, keepMounted = false, onClosed, children }: CollapsibleProps) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const initial = useRef(open);
  const previous = useRef(open);
  const [present, setPresent] = useState(open);

  useLayoutEffect(() => {
    const el = outer.current;
    const content = inner.current;
    if (!el || !content || previous.current === open) return;
    previous.current = open;
    if (open) setPresent(true);

    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const root = document.documentElement;
    const reduce = () => preference.matches || root.dataset.reducedMotion === 'true';
    let fallback: number | undefined;
    let contentObserver: ResizeObserver | undefined;
    let motionObserver: MutationObserver | undefined;
    const dispose = () => {
      window.clearTimeout(fallback);
      el.removeEventListener('transitionend', finishHeight);
      preference.removeEventListener('change', checkMotion);
      contentObserver?.disconnect();
      motionObserver?.disconnect();
    };
    const settle = () => {
      dispose();
      el.style.transition = 'none';
      el.style.height = open ? 'auto' : '0px';
      el.style.opacity = open ? '1' : '0';
      el.style.overflow = open ? 'visible' : 'hidden';
      if (!open) {
        setPresent(false);
        onClosed?.();
      }
    };
    function checkMotion() { if (reduce()) settle(); }
    function finishHeight(event: TransitionEvent) {
      if (event.target === el && event.propertyName === 'height') settle();
    }

    if (reduce() || !el.getClientRects().length) {
      settle();
      return;
    }
    const from = el.getBoundingClientRect().height;
    const opacity = window.getComputedStyle(el).opacity;
    let target = open ? content.scrollHeight : 0;
    if (Math.abs(from - target) < 1) {
      settle();
      return;
    }
    el.style.transition = 'none';
    el.style.height = `${from}px`;
    el.style.opacity = opacity;
    el.style.overflow = 'hidden';
    void el.offsetHeight;
    el.style.removeProperty('transition');
    el.style.height = `${target}px`;
    el.style.opacity = open ? '1' : '0';
    el.addEventListener('transitionend', finishHeight);
    fallback = window.setTimeout(settle, 220);
    // Output can arrive while the disclosure is opening. Once settled, auto
    // height takes over; SSE itself never starts a new transition.
    if (open) {
      contentObserver = new ResizeObserver(() => {
        const next = content.scrollHeight;
        if (next === target) return;
        target = next;
        el.style.height = `${target}px`;
        window.clearTimeout(fallback);
        fallback = window.setTimeout(settle, 220);
      });
      contentObserver.observe(content);
    }
    preference.addEventListener('change', checkMotion);
    motionObserver = new MutationObserver(checkMotion);
    motionObserver.observe(root, { attributes: true, attributeFilter: ['data-reduced-motion'] });
    return dispose;
  }, [open, onClosed]);

  return (
    <div ref={outer} id={id} data-scroll-anchor={anchor} className={`codex-collapsible ${className}`}
      style={initial.current ? { height: 'auto', opacity: 1, overflow: 'visible' } : { height: 0, opacity: 0, overflow: 'hidden' }}
      hidden={!open && !present} inert={!open} aria-hidden={!open}
    >
      <div ref={inner} className="codex-collapsible-inner">{(keepMounted || open || present) && children}</div>
    </div>
  );
}

/** Keep native summary keyboard semantics and DOM identities. The native open
 * attribute remains during exit so it cannot cut off the collapsing pixels. */
export function AnimatedDetails({ open, panelId, summary, children, ...details }:
  Omit<ComponentPropsWithoutRef<'details'>, 'open' | 'children'> & {
    open: boolean; panelId: string; summary: ReactNode; children: ReactNode;
  }) {
  const [present, setPresent] = useState(open);
  // A reversal before the first opening animation finishes still needs an exit.
  useLayoutEffect(() => { if (open) setPresent(true); }, [open]);
  const close = useCallback(() => setPresent(false), []);
  return (
    <details {...details} open={open || present}>
      {summary}
      <Collapsible open={open} id={panelId} keepMounted onClosed={close}>
        {children}
      </Collapsible>
    </details>
  );
}
