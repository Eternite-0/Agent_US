import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import type { SavedThreadPosition } from '../utils/threadInteraction';

const FOLLOW_DISTANCE = 96;
const TAIL_EPSILON = 4;
const ANCHOR_SELECTOR = [
  '[data-scroll-anchor]', '[data-anchor-key]', 'summary',
  '.codex-markdown > *', '.codex-assistant-turn', '.codex-user-bubble',
].join(',');

type Anchor = { node: Element; offset: number; selector?: string };
type ReadingPosition = {
  top: number;
  following: boolean;
  disclosure?: { tailTrigger?: Element };
  anchor?: Anchor;
};

function metrics(view: HTMLElement) {
  const extent = Math.max(0, view.scrollHeight - view.clientHeight);
  // Safari can report a negative scrollTop during a rubber-band gesture.
  const top = Math.max(0, Math.min(extent, view.scrollTop));
  return { top, extent };
}

function upperEdge(view: HTMLElement) {
  return view.getBoundingClientRect().top + view.clientTop;
}

function anchorFor(node: Element, view: HTMLElement): Anchor {
  const stableNode = node.closest('[data-scroll-anchor], [data-anchor-key]');
  const attribute = stableNode?.hasAttribute('data-scroll-anchor') ? 'data-scroll-anchor' : 'data-anchor-key';
  const key = stableNode?.getAttribute(attribute);
  // For prose inside a stable message, retain the paragraph offset as well as
  // the turn ID. Never retain DOM nodes beyond the mounted transcript.
  const path: string[] = [];
  for (let child: Element | null = node; child && child !== stableNode && key; child = child.parentElement) {
    const parent = child.parentElement;
    if (!parent) break;
    path.unshift(` > ${child.localName}:nth-child(${Array.prototype.indexOf.call(parent.children, child) + 1})`);
  }
  return {
    node,
    offset: node.getBoundingClientRect().top - upperEdge(view),
    selector: key ? `[${attribute}="${CSS.escape(key)}"]${path.join('')}` : undefined,
  };
}

function turnAt(turns: NodeListOf<HTMLElement>, edge: number): number {
  let low = 0;
  let high = turns.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (turns[middle].getBoundingClientRect().top <= edge) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function readAnchor(view: HTMLElement, content: HTMLElement, turns: NodeListOf<HTMLElement>) {
  const box = content.getBoundingClientRect();
  const edge = upperEdge(view);
  const inset = Math.min(50, box.width * 0.14);
  // Probe visible blocks first. An anchor on the turn alone is insufficient when
  // a tool expands above the paragraph being read *within* that same turn.
  for (const dy of [8, 28, 56, 92]) {
    if (dy >= view.clientHeight) break;
    let best: Element | undefined;
    for (const x of [box.left + box.width / 2, box.left + inset, box.right - inset]) {
      const node = document.elementFromPoint(x, edge + dy)?.closest(ANCHOR_SELECTOR);
      // A side gutter can hit the exchange wrapper while the center hits a real
      // paragraph. Prefer the innermost element if both cover the same probe.
      if (node && content.contains(node) && (!best || best.contains(node))) best = node;
    }
    if (best) return anchorFor(best, view);
  }
  const node = turns[turnAt(turns, edge + 8)];
  return node ? anchorFor(node, view) : undefined;
}

/** The transcript is the only vertical scroller; the composer is its sibling.
 * Store a viewport-relative DOM anchor before reflows, and reconcile after React
 * commits or a late resize (image, font, disclosure, or composer height change).
 * No wheel/key cancellation and no animated programmatic scroll to fight input.
 */
export function useThreadScroll(threadId: string | undefined, contentVersion: unknown, saved: { current?: SavedThreadPosition }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const turnsRef = useRef<NodeListOf<HTMLElement> | null>(null);
  const positionRef = useRef<ReadingPosition | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const [activeTurnIdx, setActiveTurnIdx] = useState(0);

  const record = useCallback((following: boolean, disclosure?: ReadingPosition['disclosure']) => {
    const view = viewportRef.current;
    const content = contentRef.current;
    const turns = turnsRef.current;
    if (!view || !content || !turns) return;
    const position = metrics(view);
    const anchor = following ? undefined : readAnchor(view, content, turns);
    positionRef.current = {
      top: position.top, following, disclosure,
      anchor,
    };
    saved.current = {
      top: position.top, following,
      anchor: anchor?.selector ? { selector: anchor.selector, offset: anchor.offset } : undefined,
    };
    setShowLatest(position.extent - position.top > (following ? FOLLOW_DISTANCE : TAIL_EPSILON));
    setActiveTurnIdx(turnAt(turns, upperEdge(view) + 100));
  }, [saved]);

  const reconcile = useCallback(() => {
    const view = viewportRef.current;
    if (!view || !turnsRef.current) return;
    const before = positionRef.current;
    if (!before) {
      const remembered = saved.current;
      const savedAnchor = remembered?.anchor;
      const anchor = savedAnchor && view.querySelector(savedAnchor.selector);
      if (!remembered || remembered.following) {
        view.scrollTop = view.scrollHeight;
      } else if (savedAnchor && anchor?.getClientRects().length) {
        view.scrollTop += anchor.getBoundingClientRect().top - upperEdge(view) - savedAnchor.offset;
      } else {
        view.scrollTop = remembered.top;
      }
      record(remembered?.following ?? true);
      return;
    }
    const now = metrics(view);
    // Scroll events can arrive after a layout commit. If the viewport moved
    // independently of our last write (apart from bounds clamping), user wins.
    if (Math.abs(now.top - Math.min(before.top, now.extent)) > 1) {
      record(now.extent - now.top <= FOLLOW_DISTANCE);
      return;
    }
    const tailTrigger = before.disclosure?.tailTrigger;
    if (tailTrigger && view.contains(tailTrigger) && tailTrigger.getClientRects().length) {
      // A detail opened at the tail shouldn't clip the reply/footer. Reveal
      // the new bottom, but never scroll past the control the user just opened.
      const room = Math.max(0, tailTrigger.getBoundingClientRect().top - upperEdge(view) - 8);
      view.scrollTop = Math.min(now.extent, now.top + room);
    } else if (before.following) {
      if (now.extent !== now.top) view.scrollTop = now.extent;
    } else if (before.anchor) {
      const { node, selector, offset } = before.anchor;
      const anchor = view.contains(node) ? node : selector ? view.querySelector(selector) : null;
      if (anchor?.getClientRects().length) {
        const delta = anchor.getBoundingClientRect().top - upperEdge(view) - offset;
        if (Math.abs(delta) >= 1) view.scrollTop += delta;
      }
    }
    // If revealing a tail disclosure couldn't fit, stay with the control
    // rather than jumping away from it on the next stream update.
    const after = metrics(view);
    const resumeDistance = tailTrigger ? TAIL_EPSILON : FOLLOW_DISTANCE;
    record(before.following || Boolean(before.disclosure && after.extent - after.top <= resumeDistance));
  }, [record, saved]);

  useLayoutEffect(() => {
    const view = viewportRef.current;
    const content = contentRef.current;
    positionRef.current = null;
    if (!view || !content) return;
    const observer = new ResizeObserver(reconcile);
    observer.observe(view);
    observer.observe(content);
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const { top, extent } = metrics(view);
        if (positionRef.current && Math.abs(top - positionRef.current.top) <= 1) return;
        record(extent - top <= FOLLOW_DISTANCE);
      });
    };
    view.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      // A navigation click can happen before the scroll listener's RAF runs.
      const { top, extent } = metrics(view);
      if (positionRef.current && Math.abs(top - positionRef.current.top) > 1 && view.isConnected) {
        record(extent - top <= FOLLOW_DISTANCE);
      }
      view.removeEventListener('scroll', onScroll);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [threadId, reconcile, record]);

  useLayoutEffect(() => {
    turnsRef.current = contentRef.current?.querySelectorAll<HTMLElement>('[data-scroll-turn]') ?? null;
  }, [threadId, contentVersion]);

  // Also handles commits whose net height does not change, and local React
  // disclosures without depending on any particular message/evidence count.
  useLayoutEffect(reconcile);

  const jumpToLatest = useCallback(() => {
    const view = viewportRef.current;
    if (!view) return;
    view.scrollTop = view.scrollHeight;
    record(true);
  }, [record]);

  const jumpTo = useCallback((node: HTMLElement) => {
    const view = viewportRef.current;
    if (!view) return;
    view.scrollTop += node.getBoundingClientRect().top - upperEdge(view)
      - Math.max(20, (view.clientHeight - Math.min(node.offsetHeight, view.clientHeight)) / 2);
    record(false);
  }, [record]);

  const holdDisclosure = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const view = viewportRef.current;
    const target = event.target instanceof Element
      ? event.target.closest('summary, button[aria-expanded], [data-scroll-disclosure]') : null;
    if (!view || !target || !view.contains(target)) return;
    const turns = turnsRef.current;
    const lastTurn = turns?.[turns.length - 1];
    const { top, extent } = metrics(view);
    let tailTrigger: Element | undefined;
    if (extent - top <= TAIL_EPSILON && lastTurn && target.closest('[data-scroll-turn]') === lastTurn
      && target.matches('[data-scroll-disclosure]')) {
      const exchange = target.closest('.codex-direct-exchange');
      // A task can contain several exchanges. Opening an older one is still
      // a historical disclosure, even when the transcript is at the bottom.
      if (!exchange || exchange === Array.from(lastTurn.querySelectorAll('.codex-direct-exchange')).at(-1)) tailTrigger = target;
    }
    record(false, { tailTrigger });
  }, [record]);

  const onViewportKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    // The focused transcript has consistent paging on macOS and Windows.
    // Let nested output and controls handle their own keys natively.
    if (event.target !== event.currentTarget || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const view = event.currentTarget;
    const page = Math.max(1, Math.round(view.clientHeight * 0.9));
    const top = event.key === 'Home' ? 0 : event.key === 'End' ? view.scrollHeight
      : event.key === 'PageUp' ? view.scrollTop - page : event.key === 'PageDown' ? view.scrollTop + page : undefined;
    if (top === undefined) return;
    event.preventDefault();
    view.scrollTop = top;
    const next = metrics(view);
    record(next.extent - next.top <= FOLLOW_DISTANCE);
  }, [record]);

  return { viewportRef, contentRef, showLatest, activeTurnIdx, jumpToLatest, jumpTo, holdDisclosure, onViewportKeyDown };
}
