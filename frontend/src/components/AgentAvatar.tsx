import type { ReactNode } from 'react';

const glyphs = {
  implementation: <path d="m5 4.75-3.25 3.25L5 11.25m6-6.5 3.25 3.25L11 11.25m-2-8-2 9.5" />,
  research: <><circle cx="6.75" cy="6.75" r="4.5" /><path d="m10.25 10.25 3.5 3.5" /></>,
  planning: <><rect x="2" y="2" width="6" height="4.5" rx="1.2" /><path d="M5 6.75v4.5h3" /><rect x="8" y="9" width="6" height="4.5" rx="1.2" /></>,
  review: <><path d="M1.4 8s2.5-4.5 6.6-4.5 6.6 4.5 6.6 4.5-2.5 4.5-6.6 4.5S1.4 8 1.4 8Z" /><circle cx="8" cy="8" r="1.8" /></>,
  verification: <><path d="M5.5 2h5m-4 .25v4.2L3 12.1A1.15 1.15 0 0 0 4 14h8a1.15 1.15 0 0 0 1-1.9L9.5 6.45v-4.2M5.2 9h5.6" /></>,
  agent: <><rect x="2" y="4.25" width="12" height="9" rx="3" /><path d="M8 2v2m-2.25 4v1m4.5-1v1" /></>,
} satisfies Record<string, ReactNode>;

// Both direct workers and Swarm profiles refer to these roles. Custom roles get the agent mark.
const roles = new Map<string, keyof typeof glyphs>([
  ['coder', 'implementation'], ['implementation', 'implementation'], ['implementer', 'implementation'],
  ['researcher', 'research'], ['research', 'research'], ['planner', 'planning'], ['planning', 'planning'],
  ['reviewer', 'review'], ['review', 'review'], ['tester', 'verification'], ['verification', 'verification'],
]);

export function AgentAvatar({ role, size = 16 }: { role?: string; size?: number }) {
  const glyph = roles.get(role?.trim().toLowerCase() ?? '') ?? 'agent';
  return <svg data-agent-glyph={glyph} aria-hidden="true" width={size} height={size} viewBox="0 0 16 16"
    fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {glyphs[glyph]}
  </svg>;
}
