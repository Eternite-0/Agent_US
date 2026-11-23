export interface PromptCacheStats {
  windowHours: number;
  global: {
    status: 'available' | 'partial' | 'unavailable';
    hitRate: number | null;
    coverage: number | null;
    requests: number;
    measuredRequests: number;
    missingRequests: number;
    unsupportedRequests: number;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    uncachedInputTokens: number | null;
    cacheEligibleInputTokens: number | null;
  };
}

export function cachePercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 1) return '—';
  if (value === 1) return '100%';
  if (value === 0) return '0%';
  if (value < 0.001) return '<0.1%';
  for (let decimals = 1; decimals <= 4; decimals++) {
    const formatted = (value * 100).toFixed(decimals);
    if (Number(formatted) < 100) return `${formatted.replace(/\.0+$/, '')}%`;
  }
  return '<100%';
}

export const cacheRefreshEvent = (type: string) =>
  ['turn/completed', 'turn/failed', 'turn/cancelled', 'turn/parked', 'swarm/run_completed'].includes(type);
