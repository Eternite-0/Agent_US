export type ComposerDraft = {
  text: string;
  files: Record<string, string>;
  mode: 'swarm' | 'goal' | null;
};

export type SavedThreadPosition = {
  top: number;
  following: boolean;
  anchor?: { selector: string; offset: number };
};

export function createComposerDraftStore() {
  const listeners = new Set<() => void>();
  const empty: ComposerDraft = { text: '', files: {}, mode: null };
  let value = empty;
  let lastInjection: object | undefined;
  let sending = false;
  let pendingFileReads = 0;
  return {
    read: () => value,
    isSending: () => sending,
    setSending(pending: boolean) {
      if (sending === pending) return;
      sending = pending;
      listeners.forEach((listener) => listener());
    },
    hasPendingFileReads: () => pendingFileReads > 0,
    startFileRead() {
      pendingFileReads++;
      return () => { pendingFileReads--; };
    },
    consumeInjection(injection: object) {
      if (lastInjection === injection) return false;
      lastInjection = injection;
      return true;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update<K extends keyof ComposerDraft>(key: K, next: ComposerDraft[K] | ((previous: ComposerDraft[K]) => ComposerDraft[K])) {
      const updated = typeof next === 'function' ? next(value[key]) : next;
      if (Object.is(value[key], updated)) return;
      value = { ...value, [key]: updated };
      listeners.forEach((listener) => listener());
    },
    clearIfUnchanged(sent: ComposerDraft) {
      if (sent !== value) return false;
      value = empty;
      listeners.forEach((listener) => listener());
      return true;
    },
  };
}

export type ComposerDraftStore = ReturnType<typeof createComposerDraftStore>;

export function createThreadInteraction() {
  return {
    draft: createComposerDraftStore(),
    disclosures: new Map<string, boolean>(),
    reading: { current: undefined as SavedThreadPosition | undefined },
  };
}

export type ThreadInteraction = ReturnType<typeof createThreadInteraction>;

/** Keep recent reading state without evicting unsent drafts or in-flight attachments. */
export function createThreadInteractionCache(recentLimit = 64) {
  const sessions = new Map<string, ThreadInteraction>();
  return {
    get: (id: string) => sessions.get(id),
    delete: (id: string) => sessions.delete(id),
    visit(id: string, interaction: ThreadInteraction) {
      sessions.delete(id);
      sessions.set(id, interaction);
      if (sessions.size <= recentLimit) return;
      for (const [key, entry] of sessions) {
        const { text, mode, files } = entry.draft.read();
        if (key === id || text || mode || Object.keys(files).length
          || entry.draft.isSending() || entry.draft.hasPendingFileReads()) continue;
        sessions.delete(key);
        if (sessions.size <= recentLimit) break;
      }
    },
  };
}
