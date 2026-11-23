export type ComposerMode = 'swarm' | 'goal' | 'plan';

export function resolveComposerDraft(text: string, mode: ComposerMode | null) {
  const trimmed = text.trim();
  const match = /^\/(swarm|goal|目标|plan)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (match) {
    const word = match[1].toLowerCase();
    const requested = word === '目标' ? 'goal' : word as ComposerMode;
    const body = match[2]?.trim();
    if (!body) return { kind: 'activate' as const, mode: requested };
    return requested === 'goal'
      ? { kind: 'goal' as const, body }
      : { kind: 'submit' as const, body: `/${requested} ${body}` };
  }
  if (!trimmed) return { kind: 'empty' as const };
  if (mode === 'goal') return { kind: 'goal' as const, body: trimmed };
  return { kind: 'submit' as const, body: mode ? `/${mode} ${trimmed}` : trimmed };
}
