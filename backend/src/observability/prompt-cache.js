import { createHash, randomUUID } from 'node:crypto';

const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : null;
const sumKnown = (...values) => values.some((n) => n != null)
  ? values.reduce((sum, n) => sum + (n ?? 0), 0) : null;

export function normalizeProviderUsage(protocol, raw) {
  if (!raw) return null;
  const anthropic = protocol === 'anthropic';
  const read = count(anthropic ? raw.cache_read_input_tokens :
    raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cache_read_input_tokens);
  const write = count(anthropic ? raw.cache_creation_input_tokens ?? sumKnown(
    count(raw.cache_creation?.ephemeral_5m_input_tokens), count(raw.cache_creation?.ephemeral_1h_input_tokens),
  ) : raw.cache_creation_input_tokens);
  const base = count(anthropic ? raw.input_tokens : raw.prompt_tokens);
  const miss = count(raw.prompt_cache_miss_tokens);
  // Anthropic's input_tokens excludes both cache buckets; OpenAI's includes them.
  const input = anthropic ? (base == null ? null : base + (read ?? 0) + (write ?? 0))
    : base ?? (read != null && miss != null ? read + miss : null);
  const eligible = read != null && input != null && input >= read &&
    (!anthropic || write != null) ? input : null;
  return {
    inputTokens: input,
    outputTokens: count(anthropic ? raw.output_tokens : raw.completion_tokens),
    cacheReadTokens: read,
    cacheWriteTokens: write,
    cacheEligibleInputTokens: eligible,
  };
}

// Streaming providers may send multiple cumulative snapshots, or send input
// and output separately. Never add two snapshots of the same request.
export function mergeUsageSnapshot(current, next) {
  for (const [key, value] of Object.entries(next ?? {})) {
    if (count(value) != null) current[key] = Math.max(current[key] ?? 0, value);
  }
  return current;
}

export async function* observeProviderUsage(stream, { metrics, signal, cacheTelemetry, ...route }) {
  const started = Date.now();
  const usage = {};
  const usageRequestId = randomUUID();
  const persist = (outcome) => {
    const cacheStatus = usage.cacheEligibleInputTokens != null ? 'available'
      : cacheTelemetry === 'unsupported' ? 'unsupported' : 'missing';
    metrics?.record('provider_usage', {
      ...route, id: usageRequestId, at: started,
      ok: outcome === 'streaming' ? null : outcome === 'completed', durationMs: Date.now() - started,
      detail: {
        outcome,
        cacheStatus,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        cacheReadTokens: usage.cacheReadTokens ?? null,
        cacheWriteTokens: usage.cacheWriteTokens ?? null,
        cacheEligibleInputTokens: usage.cacheEligibleInputTokens ?? null,
      },
    });
  };
  let ok = false;
  try {
    for await (const event of stream) {
      if (event.type === 'usage') {
        const previous = { ...usage };
        mergeUsageSnapshot(usage, event.usage);
        // Save reported usage before the next wire read. An abrupt process exit
        // can then leave a partial row, not silently drop already observed tokens.
        if (Object.keys(usage).some(key => usage[key] !== previous[key])) persist('streaming');
        yield { ...event, usageRequestId };
      } else yield event;
    }
    ok = !signal?.aborted;
  } finally {
    persist(ok ? 'completed' : signal?.aborted ? 'cancelled' : 'interrupted');
  }
}

function orderedJson(value) {
  if (Array.isArray(value)) return value.map(orderedJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, orderedJson(value[key])]));
}

export function stableTools(tools = []) {
  return tools.map(t => ({ ...t, parameters: orderedJson(t.parameters) }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export function openaiPromptCacheKey(endpoint, sessionKey) {
  if (!sessionKey) return undefined;
  try {
    if (new URL(endpoint).origin !== 'https://api.openai.com') return undefined;
  } catch { return undefined; }
  return createHash('sha256').update(`agent-us:prompt-cache:v1:${sessionKey}`).digest('hex');
}

export function summarizePromptCache(rows, window) {
  const groups = new Map();
  const global = accumulator();
  for (const row of rows) {
    let detail;
    try { detail = JSON.parse(row.detailJson); } catch { continue; }
    if (!detail) continue;
    add(global, detail);
    for (const [kind, key] of [['provider', row.provider], ['model', row.model]]) {
      if (!key) continue;
      const id = `${kind}:${key}`;
      if (!groups.has(id)) groups.set(id, { kind, key, data: accumulator() });
      add(groups.get(id).data, detail);
    }
  }
  const result = { ...window, global: finish(global), providers: [], models: [] };
  for (const { kind, key, data } of groups.values()) result[`${kind}s`].push({ [kind]: key, ...finish(data) });
  return result;
}

function accumulator() {
  return { requests: 0, measuredRequests: 0, missingRequests: 0, unsupportedRequests: 0,
    inputTokens: 0, outputTokens: 0, cacheEligibleInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: null };
}
function add(a, u) {
  a.requests++;
  a.inputTokens += count(u.inputTokens) ?? 0;
  a.outputTokens += count(u.outputTokens) ?? 0;
  a.cacheWriteTokens = sumKnown(a.cacheWriteTokens, count(u.cacheWriteTokens));
  if (u.cacheStatus === 'available') {
    a.measuredRequests++;
    a.cacheEligibleInputTokens += count(u.cacheEligibleInputTokens) ?? 0;
    a.cacheReadTokens += count(u.cacheReadTokens) ?? 0;
  } else if (u.cacheStatus === 'unsupported') a.unsupportedRequests++;
  else a.missingRequests++;
}
function finish(a) {
  const eligible = a.cacheEligibleInputTokens;
  return {
    ...a,
    cacheReadTokens: a.measuredRequests ? a.cacheReadTokens : null,
    cacheEligibleInputTokens: a.measuredRequests ? eligible : null,
    uncachedInputTokens: a.measuredRequests ? eligible - a.cacheReadTokens : null,
    hitRate: eligible > 0 ? a.cacheReadTokens / eligible : null,
    coverage: a.requests ? a.measuredRequests / a.requests : null,
    status: a.measuredRequests ? (a.measuredRequests === a.requests ? 'available' : 'partial') : 'unavailable',
  };
}
