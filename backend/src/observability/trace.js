import { AsyncLocalStorage } from 'node:async_hooks';

export const TRACE_FIELDS = Object.freeze([
  'traceId',
  'runId',
  'nodeId',
  'sessionId',
  'turnId',
  'jobId',
  'workerId',
  'attempt',
  'fence',
  'model',
  'provider',
  'accountId',
  'toolCallId',
  'artifactId',
  'isSynthetic',
  'trafficSource',
]);

export const TRAFFIC_SOURCES = Object.freeze({
  PRODUCTION: 'production',
  SCHEDULED: 'scheduled',
  SWARM: 'swarm',
  SYNTHETIC: 'synthetic',
  EVAL: 'eval',
  PROBE: 'probe',
  TEST: 'test',
});

export const VALID_TRAFFIC_SOURCES = Object.freeze(new Set(Object.values(TRAFFIC_SOURCES)));
export const SYNTHETIC_SOURCES = Object.freeze(
  new Set([
    TRAFFIC_SOURCES.SYNTHETIC,
    TRAFFIC_SOURCES.EVAL,
    TRAFFIC_SOURCES.PROBE,
    TRAFFIC_SOURCES.TEST,
  ]),
);

const traceStorage = new AsyncLocalStorage();

function parseBooleanFlag(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(clean)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(clean)) return false;
  }
  return null;
}

/**
 * Normalizes trusted server-side source metadata or a raw source string into
 * `{ trafficSource, isSynthetic }`.
 *
 * HTTP headers are intentionally ignored here.  A caller that is crossing an
 * HTTP boundary must establish the source at that boundary; accepting source
 * headers would let an external client move traffic into synthetic/eval
 * buckets and corrupt production KPIs.  The API boundary performs that
 * sanitization before routing, while internal probes use `withTraceContext()`.
 */
export function classifyTrafficSource(headersOrSource, fallback = TRAFFIC_SOURCES.PRODUCTION) {
  const safeFallback = VALID_TRAFFIC_SOURCES.has(String(fallback || '').toLowerCase())
    ? String(fallback).toLowerCase()
    : TRAFFIC_SOURCES.PRODUCTION;

  if (headersOrSource === null || headersOrSource === undefined) {
    return {
      trafficSource: safeFallback,
      isSynthetic: SYNTHETIC_SOURCES.has(safeFallback),
    };
  }

  if (typeof headersOrSource === 'string') {
    const norm = headersOrSource.trim().toLowerCase();
    const trafficSource = VALID_TRAFFIC_SOURCES.has(norm) ? norm : safeFallback;
    return {
      trafficSource,
      isSynthetic: SYNTHETIC_SOURCES.has(trafficSource),
    };
  }

  if (typeof headersOrSource === 'object') {
    // Only explicit server-side fields are trusted.  In particular, do not
    // inspect `headers` (or any x-* aliases) here: request headers are
    // attacker-controlled input, not provenance metadata.
    const rawSource = headersOrSource.trafficSource ?? headersOrSource.source ?? null;
    const rawSynth = headersOrSource.isSynthetic;
    const explicitSynth = parseBooleanFlag(rawSynth);
    const normSource = rawSource ? String(rawSource).trim().toLowerCase() : '';
    let trafficSource = VALID_TRAFFIC_SOURCES.has(normSource) ? normSource : null;

    if (!trafficSource) {
      if (explicitSynth === true) {
        trafficSource = TRAFFIC_SOURCES.SYNTHETIC;
      } else {
        trafficSource = safeFallback;
      }
    }

    const sourceIsSynthetic = SYNTHETIC_SOURCES.has(trafficSource);
    const isSynthetic = sourceIsSynthetic || explicitSynth === true;
    if (isSynthetic && !sourceIsSynthetic) {
      trafficSource = TRAFFIC_SOURCES.SYNTHETIC;
    }

    return { trafficSource, isSynthetic };
  }

  return {
    trafficSource: safeFallback,
    isSynthetic: SYNTHETIC_SOURCES.has(safeFallback),
  };
}

/**
 * Returns the active AsyncLocalStorage execution trace context (or an empty object).
 */
export function getTraceContext() {
  const store = traceStorage.getStore();
  return store ? { ...store } : {};
}

/**
 * Runs `fn` inside a merged AsyncLocalStorage trace context carrying any subset of the
 * 12 canonical execution correlation fields plus traffic classification metadata.
 */
export function withTraceContext(patch, fn) {
  if (typeof fn !== 'function') return undefined;
  const current = traceStorage.getStore() ?? {};
  const next = { ...current };
  if (patch && typeof patch === 'object') {
    for (const field of TRACE_FIELDS) {
      if (patch[field] !== undefined) {
        next[field] = patch[field];
      }
    }
    if (patch.source !== undefined && patch.trafficSource === undefined) {
      next.trafficSource = patch.source;
    }
    if (
      patch.trafficSource !== undefined ||
      patch.source !== undefined ||
      patch.isSynthetic !== undefined
    ) {
      const classified = classifyTrafficSource(
        {
          trafficSource: next.trafficSource,
          isSynthetic: patch.isSynthetic !== undefined ? patch.isSynthetic : undefined,
        },
        current.trafficSource || TRAFFIC_SOURCES.PRODUCTION,
      );
      next.trafficSource = classified.trafficSource;
      next.isSynthetic = classified.isSynthetic;
    }
  }
  return traceStorage.run(next, fn);
}

/**
 * Produces a compact trace object omitting undefined, null, and empty string fields
 * while preserving numeric `attempt` (including 0) and boolean `isSynthetic`.
 */
export function compactTrace(extra = null) {
  const current = traceStorage.getStore() ?? {};
  const merged = extra && typeof extra === 'object' ? { ...current, ...extra } : current;
  const out = {};
  for (const field of TRACE_FIELDS) {
    const val = merged[field];
    if (val === undefined || val === null || val === '') continue;
    if (field === 'attempt') {
      const num = Number(val);
      if (Number.isFinite(num)) out[field] = Math.trunc(num);
      continue;
    }
    if (field === 'isSynthetic') {
      out[field] = Boolean(val);
      continue;
    }
    out[field] = String(val);
  }
  return out;
}
