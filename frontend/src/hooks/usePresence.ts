import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** `open` controls interaction; `present` only keeps a closed surface painted. */
export function usePresence<T extends HTMLElement>(
  open: boolean,
  element: RefObject<T | null>,
  onExited?: () => void,
) {
  const [retained, setRetained] = useState(open);
  const notify = useRef(onExited);
  useLayoutEffect(() => { notify.current = onExited; }, [onExited]);

  useLayoutEffect(() => {
    if (open) {
      setRetained(true);
      return;
    }
    if (!retained) return;

    let current = true;
    const finish = () => {
      if (!current) return;
      setRetained(false);
      notify.current?.();
    };
    // Read the actual CSS animation, including reduced motion or a cancelled exit.
    // Only the surface's own animation matters, not looping/interactive descendants.
    const animations = element.current?.getAnimations() ?? [];
    if (!animations.length) finish();
    else void Promise.allSettled(animations.map((animation) => animation.finished)).then(finish);
    return () => { current = false; };
  }, [open, retained, element]);

  return open || retained;
}

/** Freeze visual content on close, even if the owner clears its backing data. */
export function usePresenceSnapshot<T>(open: boolean, value: T): T {
  const lastOpen = useRef(value);
  useLayoutEffect(() => { if (open) lastOpen.current = value; }, [open, value]);
  return open ? value : lastOpen.current;
}
