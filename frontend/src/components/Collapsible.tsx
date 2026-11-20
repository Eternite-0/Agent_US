import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface CollapsibleProps {
  open: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * Exact Codex Desktop collapse/expand animation:
 * Measures inner wrapper scrollHeight -> animates outer height & opacity -> releases to height: auto.
 * Releases overflow: visible when fully open so nested collapsibles (like inline file diff cards
 * inside tool batches) expand cleanly without ever clipping or freezing at 0px.
 */
export const Collapsible: React.FC<CollapsibleProps> = ({ open, className = '', children }) => {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(open);
  const [height, setHeight] = useState<string | number>(open ? 'auto' : 0);
  const [opacity, setOpacity] = useState<number>(open ? 1 : 0);
  const [settledOpen, setSettledOpen] = useState<boolean>(open);
  const prevOpenRef = useRef(open);

  useEffect(() => {
    if (open) setRendered(true);
  }, [open]);

  useLayoutEffect(() => {
    const el = outerRef.current;
    const inner = innerRef.current;
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (!el || !inner) return;
    if (open === wasOpen && ((open && height === 'auto') || (!open && height === 0))) return;

    if (open) {
      const target = Math.max(inner.scrollHeight, el.scrollHeight);
      if (target <= 0) {
        setHeight('auto');
        setOpacity(1);
        setSettledOpen(true);
        return;
      }
      setSettledOpen(false);
      setHeight(0);
      setOpacity(0);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          const measured = Math.max(innerRef.current?.scrollHeight ?? 0, target);
          setHeight(measured || 'auto');
          setOpacity(1);
        });
      });
      const fallback = window.setTimeout(() => {
        setHeight('auto');
        setOpacity(1);
        setSettledOpen(true);
      }, 210);
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
        window.clearTimeout(fallback);
      };
    } else {
      setSettledOpen(false);
      const current = Math.max(inner.scrollHeight, el.scrollHeight);
      setHeight(current);
      setOpacity(1);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          setHeight(0);
          setOpacity(0);
        });
      });
      const done = window.setTimeout(() => {
        setRendered(false);
      }, 190);
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
        window.clearTimeout(done);
      };
    }
  }, [open, rendered]);

  const handleTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.target !== outerRef.current || e.propertyName !== 'height') return;
    if (open) {
      setHeight('auto');
      setSettledOpen(true);
    } else {
      setRendered(false);
    }
  };

  if (!rendered && !open) return null;

  return (
    <div
      ref={outerRef}
      className={`codex-collapsible ${className}`}
      style={{
        height,
        opacity,
        overflow: settledOpen && height === 'auto' ? 'visible' : 'hidden',
      }}
      aria-hidden={!open}
      onTransitionEnd={handleTransitionEnd}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
};
