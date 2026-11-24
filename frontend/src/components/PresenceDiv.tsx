import { useLayoutEffect, useRef, type ComponentPropsWithoutRef, type RefObject } from 'react';
import { usePresence, usePresenceSnapshot } from '../hooks/usePresence';

export function PresenceDiv({ open, elementRef, focusOnOpen, children, ...props }: ComponentPropsWithoutRef<'div'> & {
  open: boolean;
  elementRef?: RefObject<HTMLDivElement | null>;
  focusOnOpen?: string;
}) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = elementRef ?? localRef;
  const present = usePresence(open, ref);
  const content = usePresenceSnapshot(open, children);
  useLayoutEffect(() => {
    if (open && focusOnOpen) ref.current?.querySelector<HTMLElement>(focusOnOpen)?.focus({ preventScroll: true });
  }, [open, ref, focusOnOpen]);
  if (!present) return null;
  return (
    <div {...props} ref={ref} data-presence={open ? 'open' : 'exiting'} inert={!open} aria-hidden={!open || undefined}>
      {content}
    </div>
  );
}
