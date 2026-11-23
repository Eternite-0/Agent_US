import React, { useLayoutEffect, useRef, useState } from 'react';

interface CollapsibleProps {
  open: boolean;
  id?: string;
  className?: string;
  keepMounted?: boolean;
  children: React.ReactNode;
}

/** Animate from the current on-screen size, including when direction reverses mid-transition. */
export const Collapsible: React.FC<CollapsibleProps> = ({ open, id, className = '', keepMounted = false, children }) => {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const previousOpen = useRef(open);
  const [rendered, setRendered] = useState(open);

  useLayoutEffect(() => {
    const el = outerRef.current;
    const inner = innerRef.current;
    if (!el || !inner || previousOpen.current === open) return;
    previousOpen.current = open;
    if (open) setRendered(true);

    const settle = () => {
      el.style.height = open ? 'auto' : '0px';
      el.style.opacity = open ? '1' : '0';
      el.style.overflow = open ? 'visible' : 'hidden';
      if (!open) setRendered(false);
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      settle();
      return;
    }

    const from = el.getBoundingClientRect().height;
    const opacity = window.getComputedStyle(el).opacity;
    el.style.transition = 'none';
    el.style.height = `${from}px`;
    el.style.opacity = opacity;
    el.style.overflow = 'hidden';
    // Commit the starting height before changing the target.
    void el.offsetHeight;
    el.style.removeProperty('transition');

    let fallback: number | undefined;
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== el || event.propertyName !== 'height') return;
      window.clearTimeout(fallback);
      settle();
    };
    el.addEventListener('transitionend', onEnd);
    const frame = requestAnimationFrame(() => {
      const target = open ? inner.scrollHeight : 0;
      if (target === from) {
        settle();
        return;
      }
      el.style.height = `${target}px`;
      el.style.opacity = open ? '1' : '0';
      // Covers display changes when an ancestor gets hidden mid-transition.
      fallback = window.setTimeout(settle, 250);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(fallback);
      el.removeEventListener('transitionend', onEnd);
    };
  }, [open]);

  const initialOpen = useRef(open);
  return (
    <div ref={outerRef} id={id} className={`codex-collapsible ${className}`}
      style={initialOpen.current ? { height: 'auto', opacity: 1, overflow: 'visible' } : { height: 0, opacity: 0, overflow: 'hidden' }}
      inert={!open} aria-hidden={!open}
    >
      <div ref={innerRef}>{(keepMounted || open || rendered) && children}</div>
    </div>
  );
};
