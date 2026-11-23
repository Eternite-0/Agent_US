import type { EventEnvelope, Task, TaskBundle } from '../types/backend';

// API snapshots are JSON-shaped. Share unchanged subtrees, but do not union collections:
// a rewind, completed approval, or deleted file can legitimately remove data.
export function shareSnapshot<T>(previous: T, incoming: T): T {
  if (Object.is(previous, incoming)) return previous;
  if (Array.isArray(previous) && Array.isArray(incoming)) {
    const next = incoming.map((item, i) => shareSnapshot(previous[i], item));
    return next.length === previous.length && next.every((item, i) => Object.is(item, previous[i]))
      ? previous : next as T;
  }
  if (isRecord(previous) && isRecord(incoming)) {
    const keys = Object.keys(incoming);
    let unchanged = keys.length === Object.keys(previous).length;
    const entries = keys.map((key) => {
      const value = shareSnapshot(previous[key], incoming[key]);
      unchanged &&= Object.hasOwn(previous, key) && Object.is(value, previous[key]);
      return [key, value];
    });
    return unchanged ? previous : Object.fromEntries(entries) as T;
  }
  return incoming;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function mergeTask(previous: Task | undefined, incoming: Task): Task {
  if (!previous || previous.id !== incoming.id) return incoming;
  return incoming.version < previous.version ? previous : shareSnapshot(previous, incoming);
}

export function mergeTaskList(previous: Task[], incoming: Task[], protectedIds: ReadonlySet<string>): Task[] {
  const byId = new Map(previous.map((task) => [task.id, task]));
  const next = new Map<string, Task>();
  for (const task of incoming) {
    if (!protectedIds.has(task.id)) next.set(task.id, mergeTask(byId.get(task.id), task));
  }
  for (const id of protectedIds) {
    const current = byId.get(id);
    if (current) next.set(id, current);
  }
  const sorted = [...next.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return sorted.length === previous.length && sorted.every((task, i) => task === previous[i]) ? previous : sorted;
}

// null means an initial load settled without content; a failed refresh never replaces a bundle.
export type BundleCache = ReadonlyMap<string, TaskBundle | null>;
export const EMPTY_BUNDLE_CACHE: BundleCache = new Map();

export function mergeTaskBundle(cache: BundleCache, id: string, incoming: TaskBundle | null): BundleCache {
  const previous = cache.get(id);
  if (incoming && incoming.task.id !== id) incoming = null;
  if (previous && (!incoming || incoming.task.version < previous.task.version)) return cache;
  const next = previous && incoming ? shareSnapshot(previous, incoming) : incoming;
  return previous === next ? cache : new Map(cache).set(id, next);
}

export function threadRootFor(taskId: string, chains: Record<string, string[]>): string {
  if (Object.hasOwn(chains, taskId)) return taskId;
  return Object.entries(chains).find(([, children]) => children.includes(taskId))?.[0] ?? taskId;
}

export function createBundleSelector() {
  let previous: TaskBundle[] = [];
  return (cache: BundleCache, taskIds: readonly string[]): TaskBundle[] => {
    // A child must never become ThreadView's primary bundle while its root is still loading.
    const next = cache.get(taskIds[0]) ? taskIds.flatMap((id) => cache.get(id) ?? []) : [];
    if (next.length !== previous.length || next.some((bundle, i) => bundle !== previous[i])) previous = next;
    return previous;
  };
}

export function createLatestRequests<K>() {
  const pending = new Map<K, object>();
  return {
    start(key: K) {
      const request = {};
      pending.set(key, request);
      const isCurrent = () => pending.get(key) === request;
      return {
        isCurrent,
        // Claim once. A newer request invalidates this one even if the newer one fails.
        claim() {
          if (!isCurrent()) return false;
          pending.delete(key);
          return true;
        },
      };
    },
    invalidate(key: K) {
      pending.delete(key);
    },
  };
}

function sameEvent(a: EventEnvelope, b: EventEnvelope) {
  return b.seq > 0 && a.seq === b.seq && a.type === b.type;
}

export function appendRecentEvent(previous: EventEnvelope[], event: EventEnvelope): EventEnvelope[] {
  if (previous.some((entry) => sameEvent(entry, event))) return previous;
  return [...previous.slice(-119), event];
}

export function mergeRecentEvents(previous: EventEnvelope[], incoming: EventEnvelope[]): EventEnvelope[] {
  if (!incoming.length) return previous;
  // Prefer the previously observed object for a replayed sequence/type. Ephemeral seq=0
  // entries are not cursor duplicates, and the REST backfill only supplies persisted events.
  const seen = new Map<number, Set<string>>();
  const merged = [...previous, ...incoming].filter(({ seq, type }) => {
    if (seq <= 0) return true;
    const types = seen.get(seq) ?? new Set<string>();
    if (types.has(type)) return false;
    types.add(type);
    seen.set(seq, types);
    return true;
  });
  const next = merged.sort((a, b) => (a.seq || Infinity) - (b.seq || Infinity)).slice(-120);
  return next.length === previous.length && next.every((ev, i) => ev === previous[i]) ? previous : next;
}

// One timer across keys; at most one SSE refresh per key in flight, with a trailing
// refresh if more events arrived meanwhile. A slow workspace/task cannot block another task.
export function createRefreshQueue<K>(refresh: (key: K) => Promise<void>, delayMs = 120) {
  const pending = new Set<K>();
  const running = new Set<K>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = () => {
    if (stopped || timer !== undefined || ![...pending].some((key) => !running.has(key))) return;
    timer = setTimeout(() => {
      timer = undefined;
      for (const key of pending) {
        if (running.has(key)) continue;
        pending.delete(key);
        running.add(key);
        void Promise.resolve().then(() => {
          if (!stopped) return refresh(key);
        }).catch(() => {
          // Failed refreshes leave cached content in place; subsequent invalidations can retry.
        }).finally(() => {
          running.delete(key);
          schedule();
        });
      }
    }, delayMs);
  };

  return {
    add(key: K) {
      if (stopped) return;
      pending.add(key);
      schedule();
    },
    stop() {
      stopped = true;
      pending.clear();
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export function createSseRefreshScheduler(
  activeTasks: () => readonly string[],
  refreshWorkspace: () => Promise<void>,
  refreshTask: (id: string) => Promise<void>,
) {
  const workspace = Symbol('workspace');
  const queue = createRefreshQueue<string | typeof workspace>(async (key) => {
    if (key === workspace) await refreshWorkspace();
    else if (activeTasks().includes(key)) await refreshTask(key);
  });
  let hasReportedStatus = false;
  const invalidate = (ids: readonly string[]) => {
    queue.add(workspace);
    for (const id of ids) queue.add(id);
  };
  return {
    event(event: EventEnvelope) {
      const sessionId = typeof event.payload?.sessionId === 'string' ? event.payload.sessionId : '';
      const affected = activeTasks().filter((id) =>
        (!event.taskId && !sessionId) || id === event.taskId || id === sessionId,
      );
      if (event.type !== 'turn/phase_changed' || affected.length) invalidate(affected);
    },
    status(state: 'connected' | 'reconnecting' | 'error') {
      // Bootstrap owns the initial load. A later connection can follow a reported error or
      // a clean EOF with no status notification and no replayed events.
      if (state === 'connected' && hasReportedStatus) invalidate(activeTasks());
      hasReportedStatus = true;
    },
    stop: queue.stop,
  };
}
