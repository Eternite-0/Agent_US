import React from 'react';

interface AgentAvatarProps {
  seed: string;
  size?: number;
  className?: string;
}

function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Deterministic Codex-style colorful 16x16 floral/geometric subagent identity icons.
 * Matches the real Codex Desktop subagent icons across transcript rows, floating Agent
 * companion card, and the right-hand Subagents split panel.
 */
export const AgentAvatar: React.FC<AgentAvatarProps> = ({ seed, size = 16, className }) => {
  const variant = hashSeed(seed || 'agent') % 8;

  switch (variant) {
    case 0: // Purple blossom
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
          <circle cx="8" cy="4.2" r="2.1" fill="#a855f7" />
          <circle cx="11.3" cy="6.1" r="2.1" fill="#9333ea" />
          <circle cx="11.3" cy="9.9" r="2.1" fill="#a855f7" />
          <circle cx="8" cy="11.8" r="2.1" fill="#9333ea" />
          <circle cx="4.7" cy="9.9" r="2.1" fill="#a855f7" />
          <circle cx="4.7" cy="6.1" r="2.1" fill="#9333ea" />
          <circle cx="8" cy="8" r="1.9" fill="#1e1b4b" />
        </svg>
      );
    case 1: // Warm golden flower
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
          <circle cx="8" cy="4.1" r="2.1" fill="#facc15" />
          <circle cx="11.4" cy="6.1" r="2.1" fill="#eab308" />
          <circle cx="11.4" cy="9.9" r="2.1" fill="#facc15" />
          <circle cx="8" cy="11.9" r="2.1" fill="#eab308" />
          <circle cx="4.6" cy="9.9" r="2.1" fill="#facc15" />
          <circle cx="4.6" cy="6.1" r="2.1" fill="#eab308" />
          <circle cx="8" cy="8" r="2.1" fill="#422006" />
        </svg>
      );
    case 2: // Pink/magenta blossom
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
          <circle cx="8" cy="4.2" r="2.2" fill="#ec4899" />
          <circle cx="11.4" cy="6.2" r="2.2" fill="#db2777" />
          <circle cx="11.4" cy="9.8" r="2.2" fill="#ec4899" />
          <circle cx="8" cy="11.8" r="2.2" fill="#db2777" />
          <circle cx="4.6" cy="9.8" r="2.2" fill="#ec4899" />
          <circle cx="4.6" cy="6.2" r="2.2" fill="#db2777" />
          <circle cx="8" cy="8" r="1.8" fill="#500724" />
        </svg>
      );
    case 3: // Orange pinwheel
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
          <path d="M8 2.2C9.8 2.2 11.2 4.3 9.2 6.8L8 8V2.2Z" fill="#f97316" />
          <path d="M13.8 8C13.8 9.8 11.7 11.2 9.2 9.2L8 8H13.8Z" fill="#fb923c" />
          <path d="M8 13.8C6.2 13.8 4.8 11.7 6.8 9.2L8 8V13.8Z" fill="#f97316" />
          <path d="M2.2 8C2.2 6.2 4.3 4.8 6.8 6.8L8 8H2.2Z" fill="#fb923c" />
          <circle cx="8" cy="8" r="1.5" fill="#431407" />
        </svg>
      );
    case 4: // Sky blue orb
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
          <circle cx="8" cy="8" r="5.6" fill="#38bdf8" />
          <circle cx="6.2" cy="6.2" r="2.2" fill="#7dd3fc" />
          <circle cx="9.6" cy="9.6" r="1.5" fill="#0284c7" />
        </svg>
      );
    case 5: // Cyan hourglass
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
          <path d="M3.5 3h9L8 8l4.5 5h-9L8 8 3.5 3Z" fill="#22d3ee" />
          <path d="M5.2 3h5.6L8 6.2 5.2 3Z" fill="#0891b2" />
        </svg>
      );
    case 6: // Emerald clover
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
          <circle cx="8" cy="4.4" r="2.3" fill="#34d399" />
          <circle cx="11.6" cy="8" r="2.3" fill="#10b981" />
          <circle cx="8" cy="11.6" r="2.3" fill="#34d399" />
          <circle cx="4.4" cy="8" r="2.3" fill="#10b981" />
          <circle cx="8" cy="8" r="1.7" fill="#064e3b" />
        </svg>
      );
    default: // Lavender diamond
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" fill="#c084fc" />
          <path d="M8 3.2v9.6M3.2 8h9.6" stroke="#3b0764" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="8" r="1.7" fill="#f5d0fe" />
        </svg>
      );
  }
};
