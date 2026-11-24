import { estimateTokens } from '../context.js';
import { redactSecrets, sanitize } from '../envelope.js';
import { mergeUsageSnapshot } from '../observability/prompt-cache.js';
import { getLearnedGuidelines, sanitizeGuidelineText } from './aci-engine.js';

export const ACI_CONFIG_KEY = 'aci.config';

export const DEFAULT_SUPERVISOR_TIMEOUT_MS = 8000;
export const DEFAULT_SUPERVISOR_BREAKER_THRESHOLD = 2;
export const DEFAULT_SUPERVISOR_BREAKER_COOLDOWN_MS = 60_000;

export const DEFAULT_ACI_SUPERVISOR_CONFIG = Object.freeze({
  enabled: true,
  mode: 'auto',
  model: null,
  maxBudgetRatio: 0.72,
  epochWatermarks: [0.6, 0.82],
  maxOutputTokens: 1200,
  timeoutMs: DEFAULT_SUPERVISOR_TIMEOUT_MS,
  admissionEnabled: true,
  dtocMinPromptTokens: 24000,
});

const FAST_TIER_RE = /(?:^|[-_./\s])(?:flash|lite|nano|micro|instant|fast)(?:$|[-_./\s0-9])/i;
const LIGHT_TIER_RE = /(?:^|[-_./\s])(?:mini|haiku|small|turbo|air|quick)(?:$|[-_./\s0-9])/i;
const HEAVY_TIER_RE = /(?:^|[-_./\s])(?:opus|pro|max|ultra|reasoner|thinking|r1|heavy|xhigh)(?:$|[-_./\s0-9])/i;
const UTILITY_MODEL_RE = /(?:^|[-_./\s])(?:embed|embedding|whisper|tts|dall|flux|image|rerank|moderation)(?:$|[-_./\s0-9])/i;

const VALID_ADMISSION_DECISIONS = new Set([
  'DIRECT',
  'SUPPORTING',
  'DEFER',
  'DUPLICATE',
  'IRRELEVANT',
]);

const SUPERVISOR_SYSTEM_PROMPT = [
  'You are a strictly read-only Context Supervisor for Adaptive Context Intelligence (ACI).',
  'You have ZERO tool privileges, cannot execute commands, cannot edit files, and cannot approve actions.',
  'Given candidate context items, query intent, and error summaries, return ONLY a compact JSON object with keys:',
  '  keepRefs: string[] (candidate IDs to keep verbatim)',
  '  compressRefs: string[] (candidate IDs safe to compress into reversible ACI-REF stubs)',
  '  expandSuggestions: string[] (candidate IDs recommended for deeper expansion)',
  '  contractHints: string[] (short architectural/interface contract reminders)',
  '  summary: string (concise read-only context guidance, <= 600 chars)',
  'Only cite candidate IDs explicitly listed in the prompt. Output valid JSON only.',
].join('\n');

const ADMISSION_SUPERVISOR_SYSTEM_PROMPT = [
  'You are a strictly read-only Pre-Injection Context Admission Supervisor for Adaptive Context Intelligence (ACI).',
  'You have ZERO tool privileges, cannot execute commands, cannot edit files, and cannot approve actions.',
  'Classify each ambiguous candidate output into one of:',
  '  DIRECT (keep verbatim), SUPPORTING (focused hunks + outline), DEFER (imports + symbol line map + restore ref), DUPLICATE (unchanged duplicate stub), IRRELEVANT (1-line stub).',
  'Never drop prompt-cited, error-trace, active-mutation, or genuine auth/permission/persistence/contract/hidden_acceptance files as IRRELEVANT.',
  'For large (>2600 chars) multi-section active/config/contract files, prefer SUPPORTING (with key focusSymbols) or DEFER over DIRECT unless every line is immediately required; reserve IRRELEVANT strictly for unrelated/legacy/archived/sample decoys.',
  'Reject legacy/deprecated/archive/changelog/fixture/sample/mock-data decoys unless explicitly targeted.',
  'Return ONLY valid JSON with shape:',
  '  { "decisions": [{ "id": string, "decision": "DIRECT"|"SUPPORTING"|"DEFER"|"DUPLICATE"|"IRRELEVANT", "focusSymbols": string[], "reason": string }], "contractHints": string[] }',
  'Only cite candidate IDs explicitly listed in the prompt.',
].join('\n');

function isHealthyRouteList(routes, now = Date.now()) {
  if (!Array.isArray(routes) || routes.length === 0) return false;
  return routes.some(
    (r) =>
      r &&
      Number(r.cooldownUntil || 0) <= now &&
      r.status !== 'disabled' &&
      r.status !== 'invalid',
  );
}

function minActiveConns(routes) {
  if (!Array.isArray(routes) || routes.length === 0) return 999;
  let min = Infinity;
  for (const r of routes) {
    const c = Number(r?.activeConns ?? 0);
    if (Number.isFinite(c) && c < min) min = c;
  }
  return Number.isFinite(min) ? min : 0;
}

function scoreCatalogEntry(item, profile, routes, defaultModel, now = Date.now()) {
  const alias = String(item?.alias ?? '').trim();
  const firstTarget = Array.isArray(item?.targets) ? item.targets[0] : null;
  const upstreamModel = String(firstTarget?.model ?? '').trim();
  const provider = firstTarget?.provider ? String(firstTarget.provider) : null;
  const label = `${alias} ${upstreamModel}`.toLowerCase();

  const isUtility = UTILITY_MODEL_RE.test(label);
  const healthy = isHealthyRouteList(routes, now);
  const eligible = !isUtility && Boolean(alias);

  let score = 0;
  let hasFastTier = false;
  if (!eligible) {
    score = -1000;
  } else {
    if (FAST_TIER_RE.test(label)) {
      score += 40;
      hasFastTier = true;
    } else if (LIGHT_TIER_RE.test(label)) {
      score += 25;
      hasFastTier = true;
    }
    if (HEAVY_TIER_RE.test(label) || profile?.capabilities?.reasoning === true) {
      score -= 25;
    }
    const multiplier = Number(profile?.multiplier ?? 1);
    if (Number.isFinite(multiplier)) {
      if (multiplier <= 0.5) score += 15;
      else if (multiplier <= 1.0) score += 5;
      else if (multiplier > 2.0) score -= 10;
    }
    const ctxWin = Number(profile?.contextWindow ?? 128000);
    if (ctxWin >= 32000) score += 10;
    else if (ctxWin < 16000) score -= 20;

    if (profile?.capabilities?.cache === true) score += 5;
    if (healthy && minActiveConns(routes) === 0) score += 3;
    if (defaultModel && alias === defaultModel) score += 2;
  }

  return {
    alias,
    provider,
    upstreamModel: upstreamModel || alias,
    contextWindow: Number(profile?.contextWindow ?? 128000),
    maxOutput: Number(profile?.maxOutput ?? 16384),
    multiplier: Number(profile?.multiplier ?? 1),
    capabilities: profile?.capabilities && typeof profile.capabilities === 'object' ? { ...profile.capabilities } : {},
    healthy,
    eligible,
    hasFastTier,
    score,
  };
}

function parseJsonObjectFromText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  } catch {
    // Try fenced or balanced extraction
  }

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    try {
      const fenced = JSON.parse(fenceMatch[1].trim());
      if (fenced && typeof fenced === 'object' && !Array.isArray(fenced)) return fenced;
    } catch {
      // Continue
    }
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const sliced = JSON.parse(raw.slice(start, end + 1));
      if (sliced && typeof sliced === 'object' && !Array.isArray(sliced)) return sliced;
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizeSupervisorConfig(raw = {}) {
  const base = { ...DEFAULT_ACI_SUPERVISOR_CONFIG };
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const enabled = input.enabled !== undefined ? Boolean(input.enabled) : base.enabled;
  const rawMode = String(input.mode ?? base.mode).trim().toLowerCase();
  const mode = rawMode === 'custom' || rawMode === 'off' ? rawMode : 'auto';
  const model =
    typeof input.model === 'string' && input.model.trim()
      ? input.model.trim()
      : null;

  const maxBudgetRatio =
    input.maxBudgetRatio != null && input.maxBudgetRatio !== '' && Number.isFinite(Number(input.maxBudgetRatio))
      ? Math.min(0.98, Math.max(0.1, Number(input.maxBudgetRatio)))
      : base.maxBudgetRatio;

  let epochWatermarks = [...base.epochWatermarks];
  if (Array.isArray(input.epochWatermarks) && input.epochWatermarks.length > 0) {
    const cleaned = [...new Set(input.epochWatermarks.map(Number))]
      .filter((n) => Number.isFinite(n) && n > 0 && n < 1)
      .sort((a, b) => a - b);
    if (cleaned.length > 0) epochWatermarks = cleaned;
  }

  const maxOutputTokens =
    input.maxOutputTokens != null && input.maxOutputTokens !== '' && Number.isFinite(Number(input.maxOutputTokens))
      ? Math.min(8192, Math.max(128, Math.trunc(Number(input.maxOutputTokens))))
      : base.maxOutputTokens;

  const timeoutMs =
    input.timeoutMs != null && input.timeoutMs !== '' && Number.isFinite(Number(input.timeoutMs))
      ? Math.min(60000, Math.max(500, Math.trunc(Number(input.timeoutMs))))
      : base.timeoutMs;

  const admissionEnabled =
    input.admissionEnabled !== undefined ? Boolean(input.admissionEnabled) : base.admissionEnabled;

  const dtocMinPromptTokens =
    input.dtocMinPromptTokens != null &&
    input.dtocMinPromptTokens !== '' &&
    Number.isFinite(Number(input.dtocMinPromptTokens))
      ? Math.min(200000, Math.max(1000, Math.trunc(Number(input.dtocMinPromptTokens))))
      : base.dtocMinPromptTokens;

  return {
    enabled,
    mode,
    model,
    maxBudgetRatio,
    epochWatermarks,
    maxOutputTokens,
    timeoutMs,
    admissionEnabled,
    dtocMinPromptTokens,
  };
}

export class ContextSupervisor {
  constructor({
    store = null,
    pool = null,
    adapter = null,
    breakerThreshold = DEFAULT_SUPERVISOR_BREAKER_THRESHOLD,
    breakerCooldownMs = DEFAULT_SUPERVISOR_BREAKER_COOLDOWN_MS,
    nowFn = Date.now,
  } = {}) {
    this.store = store;
    this.pool = pool;
    this.adapter = adapter ?? pool?.adapter ?? null;
    this._breakerThreshold = Math.max(1, Math.trunc(Number(breakerThreshold ?? DEFAULT_SUPERVISOR_BREAKER_THRESHOLD)));
    this._breakerCooldownMs = Math.max(100, Math.trunc(Number(breakerCooldownMs ?? DEFAULT_SUPERVISOR_BREAKER_COOLDOWN_MS)));
    this._now = typeof nowFn === 'function' ? nowFn : Date.now;
    this._timeoutStreak = 0;
    this._circuitOpenedUntil = 0;
  }

  isCircuitOpen(now = this._now()) {
    if (this._circuitOpenedUntil <= 0) return false;
    if (now >= this._circuitOpenedUntil) {
      this._circuitOpenedUntil = 0;
      this._timeoutStreak = 0;
      return false;
    }
    return true;
  }

  #recordSupervisorCallOutcome({ ok = false, timedOut = false } = {}) {
    if (timedOut) {
      this._timeoutStreak += 1;
      if (this._timeoutStreak >= this._breakerThreshold) {
        this._circuitOpenedUntil = this._now() + this._breakerCooldownMs;
      }
      return;
    }
    if (ok) {
      this._timeoutStreak = 0;
      this._circuitOpenedUntil = 0;
    }
  }

  getConfig() {
    if (!this.store || typeof this.store.getSetting !== 'function') {
      return normalizeSupervisorConfig({});
    }
    const saved = this.store.getSetting(ACI_CONFIG_KEY, null);
    return normalizeSupervisorConfig(saved ?? {});
  }

  saveConfig(patch = {}) {
    const current = this.getConfig();
    const merged = normalizeSupervisorConfig({
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {}),
    });
    if (this.store && typeof this.store.setSetting === 'function') {
      this.store.setSetting(ACI_CONFIG_KEY, merged);
    }
    return merged;
  }

  /**
   * Resolves the effective supervisor model dynamically from the user's live
   * AccountPool catalog and route health — with ZERO hardcoded model names.
   */
  resolveModel(configOverride = null) {
    const config = configOverride ? normalizeSupervisorConfig(configOverride) : this.getConfig();
    const now = Date.now();
    const catalog =
      typeof this.pool?.getActiveCatalog === 'function'
        ? this.pool.getActiveCatalog()
        : { defaultModel: '', items: [], profiles: {} };
    const defaultModel = String(
      (typeof this.pool?.getDefaultModel === 'function' ? this.pool.getDefaultModel() : '') ||
        catalog?.defaultModel ||
        '',
    ).trim();

    const rawItems = Array.isArray(catalog?.items) ? catalog.items : [];
    const scored = rawItems.map((item) => {
      const alias = String(item?.alias ?? '').trim();
      const routes =
        alias && typeof this.pool?.resolveRoutes === 'function'
          ? this.pool.resolveRoutes(alias)
          : [];
      const profile = catalog?.profiles?.[alias] ?? {};
      return scoreCatalogEntry(item, profile, routes, defaultModel, now);
    });

    scored.sort((a, b) => {
      if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.alias.localeCompare(b.alias);
    });

    const healthyEligible = scored.filter((c) => c.healthy && c.eligible);
    let recommendedModel = null;
    let recommendedRationale = 'no_healthy_route_deterministic_fallback';

    if (healthyEligible.length > 0) {
      const top = healthyEligible[0];
      const defaultCandidate = defaultModel
        ? healthyEligible.find((c) => c.alias === defaultModel)
        : null;
      if (top.hasFastTier) {
        recommendedModel = top.alias;
        recommendedRationale = 'auto_tier_fast_heuristic';
      } else if (defaultCandidate) {
        recommendedModel = defaultCandidate.alias;
        recommendedRationale = 'pool_default_fallback';
      } else {
        recommendedModel = top.alias;
        recommendedRationale = 'auto_catalog_best_healthy';
      }
    } else if (
      defaultModel &&
      typeof this.pool?.resolveRoutes === 'function' &&
      isHealthyRouteList(this.pool.resolveRoutes(defaultModel), now)
    ) {
      recommendedModel = defaultModel;
      recommendedRationale = 'pool_default_fallback';
    }

    const candidates = scored
      .filter((c) => c.eligible)
      .map((c) => ({
        alias: c.alias,
        provider: c.provider,
        upstreamModel: c.upstreamModel,
        contextWindow: c.contextWindow,
        maxOutput: c.maxOutput,
        multiplier: c.multiplier,
        healthy: c.healthy,
        recommended: Boolean(recommendedModel && c.alias === recommendedModel),
        score: c.score,
        capabilities: c.capabilities,
      }));

    if (!config.enabled || config.mode === 'off') {
      return {
        config,
        active: false,
        effectiveModel: null,
        rationale: !config.enabled ? 'supervisor_disabled' : 'supervisor_mode_off',
        recommendedModel,
        recommendedRationale,
        candidates,
      };
    }

    if (config.mode === 'custom') {
      const selected = config.model;
      if (!selected) {
        return {
          config,
          active: false,
          effectiveModel: null,
          rationale: 'custom_model_missing_deterministic_fallback',
          recommendedModel,
          recommendedRationale,
          candidates,
        };
      }
      const inCatalog = candidates.find(
        (c) => c.alias === selected || c.upstreamModel === selected,
      );
      const customRoutes =
        rawItems.length === 0 && typeof this.pool?.resolveRoutes === 'function'
          ? this.pool.resolveRoutes(selected)
          : [];
      const customHealthy = inCatalog
        ? inCatalog.healthy
        : rawItems.length === 0 && isHealthyRouteList(customRoutes, now);
      if (!customHealthy) {
        return {
          config,
          active: false,
          effectiveModel: null,
          rationale: 'custom_model_unavailable_deterministic_fallback',
          recommendedModel,
          recommendedRationale,
          candidates,
        };
      }
      return {
        config,
        active: true,
        effectiveModel: selected,
        rationale: 'custom_model_selected',
        recommendedModel,
        recommendedRationale,
        candidates,
      };
    }

    // auto mode
    return {
      config,
      active: Boolean(recommendedModel),
      effectiveModel: recommendedModel,
      rationale: recommendedRationale,
      recommendedModel,
      recommendedRationale,
      candidates,
    };
  }

  getStatus() {
    const resolved = this.resolveModel();
    const guidelines = getLearnedGuidelines(this.store);
    const circuitOpen = this.isCircuitOpen();
    return {
      config: resolved.config,
      effectiveModel: resolved.effectiveModel,
      rationale: resolved.rationale,
      recommendedModel: resolved.recommendedModel,
      recommendedRationale: resolved.recommendedRationale,
      active: resolved.active,
      readOnly: true,
      toolsAllowed: [],
      reversibleStore: true,
      candidates: resolved.candidates,
      guidelinesCount: guidelines.length,
      circuitOpen,
      timeoutStreak: this._timeoutStreak,
      circuitOpenedUntil: circuitOpen ? this._circuitOpenedUntil : null,
    };
  }

  async #invokeReadOnlyStream({
    effectiveAdapter,
    model,
    system,
    userPayload,
    maxTokens,
    timeoutMs,
    signal,
  }) {
    const startedAt = Date.now();
    const userText = JSON.stringify(userPayload);
    const timeoutController = new AbortController();
    let timedOut = false;
    let rejectTimeout = null;
    const timeoutPromise = new Promise((_, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      const err = new Error(`ACI supervisor timeout (${timeoutMs}ms)`);
      err.code = 'ETIMEDOUT';
      timeoutController.abort(err);
      rejectTimeout?.(err);
    }, timeoutMs);
    timer.unref?.();
    const onExternalAbort = () => timeoutController.abort(signal?.reason ?? new Error('Aborted'));
    if (signal) {
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let rawOutput = '';
    const usage = { inputTokens: 0, outputTokens: 0 };

    const finalizeUsage = () => {
      const hasReportedIn = usage.inputTokens > 0;
      const hasReportedOut = usage.outputTokens > 0;
      const inputTokens = hasReportedIn
        ? usage.inputTokens
        : estimateTokens(`${system}\n${userText}`);
      const outputTokens = hasReportedOut
        ? usage.outputTokens
        : rawOutput
          ? estimateTokens(rawOutput)
          : 0;
      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimated: !(hasReportedIn && hasReportedOut),
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    };

    let iterator = null;
    try {
      const streamIterable = effectiveAdapter.stream({
        provider: 'pool',
        model,
        system,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: userText }],
          },
        ],
        tools: [], // STRICT READ-ONLY BOUNDARY: zero tool privileges
        maxTokens,
        signal: timeoutController.signal,
      });
      iterator = streamIterable?.[Symbol.asyncIterator]?.();
      if (!iterator) {
        throw new Error('Supervisor adapter stream is not async iterable');
      }

      for (;;) {
        const nextPromise = iterator.next();
        const step = await Promise.race([nextPromise, timeoutPromise]);
        if (step.done) break;
        const chunk = step.value;
        if (timeoutController.signal.aborted) {
          throw new Error(timedOut ? `ACI supervisor timeout (${timeoutMs}ms)` : 'ACI supervisor aborted');
        }
        if (chunk?.type === 'tool-call' || chunk?.block?.type === 'tool-call') {
          throw new Error('Read-only supervisor attempted tool invocation');
        }
        if (chunk?.type === 'usage' && chunk.usage) {
          Object.assign(usage, mergeUsageSnapshot({ ...usage }, chunk.usage));
        } else if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          rawOutput += chunk.text;
        } else if (
          chunk?.type === 'block-end' &&
          chunk?.block?.type === 'text' &&
          !rawOutput &&
          typeof chunk.block.text === 'string'
        ) {
          rawOutput = chunk.block.text;
        }
      }

      return {
        ok: true,
        timedOut: false,
        rawOutput,
        parsed: parseJsonObjectFromText(rawOutput),
        ...finalizeUsage(),
      };
    } catch (error) {
      const msg = String(error?.message || error || 'supervisor_failed');
      const isTimeoutErr =
        timedOut ||
        (!signal?.aborted &&
          (error?.code === 'ETIMEDOUT' ||
            /(?:supervisor\s+timeout|timed?\s*out)/i.test(msg)));
      if (iterator?.return) {
        Promise.resolve(iterator.return()).catch(() => {});
      }
      return {
        ok: false,
        timedOut: isTimeoutErr,
        rawOutput,
        parsed: null,
        error: msg,
        ...finalizeUsage(),
      };
    } finally {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  /**
   * Executes a strictly read-only (`tools: []`) side-model context supervision
   * call, validating every returned ref against known candidate IDs and failing
   * closed to deterministic ACI on timeout, error, or malformed output.
   */
  async supervise({
    query = '',
    candidates = [],
    errorSummary = '',
    budgetSummary = '',
    learnedGuidelines = [],
    signal = null,
    configOverride = null,
  } = {}) {
    const resolved = this.resolveModel(configOverride);
    const config = resolved.config;

    if (!config.enabled || config.mode === 'off') {
      return {
        ok: true,
        bypassed: true,
        usedLlm: false,
        fallback: null,
        model: null,
        rationale: resolved.rationale,
        keepRefs: [],
        compressRefs: [],
        expandSuggestions: [],
        contractHints: [],
        summary: '',
        rejectedRefs: [],
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: 0,
      };
    }

    const effectiveAdapter = this.adapter ?? this.pool?.adapter ?? null;
    if (!resolved.active || !resolved.effectiveModel || typeof effectiveAdapter?.stream !== 'function') {
      return {
        ok: false,
        bypassed: false,
        usedLlm: false,
        fallback: 'deterministic',
        circuitOpen: this.isCircuitOpen(),
        model: resolved.effectiveModel ?? null,
        rationale: !resolved.effectiveModel ? resolved.rationale : 'adapter_unavailable_deterministic_fallback',
        keepRefs: [],
        compressRefs: [],
        expandSuggestions: [],
        contractHints: [],
        summary: '',
        rejectedRefs: [],
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: 0,
      };
    }

    if (this.isCircuitOpen()) {
      return {
        ok: false,
        bypassed: false,
        usedLlm: false,
        fallback: 'deterministic',
        circuitOpen: true,
        model: resolved.effectiveModel,
        rationale: 'supervisor_circuit_open_deterministic_fallback',
        keepRefs: [],
        compressRefs: [],
        expandSuggestions: [],
        contractHints: [],
        summary: '',
        rejectedRefs: [],
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: 0,
      };
    }

    const candidateList = Array.isArray(candidates) ? candidates.slice(0, 60) : [];
    const validIdMap = new Map();
    const promptCandidates = [];

    for (const c of candidateList) {
      if (!c || typeof c !== 'object') continue;
      const canonicalId = String(c.refId ?? c.id ?? c.uri ?? '').trim();
      if (!canonicalId) continue;
      validIdMap.set(canonicalId, canonicalId);
      if (c.uri) validIdMap.set(String(c.uri).trim(), canonicalId);
      promptCandidates.push({
        id: canonicalId,
        path: sanitize(redactSecrets(String(c.path ?? ''))).slice(0, 140),
        score: Number.isFinite(Number(c.score)) ? Number(Number(c.score).toFixed(3)) : 0,
        tokens: Number(c.tokens ?? c.originalTokens ?? 0),
        ageSteps: Number(c.ageSteps ?? 0),
        hasError: Boolean(c.hasError),
        excerpt: sanitize(redactSecrets(String(c.excerpt ?? c.preview ?? ''))).slice(0, 260),
      });
    }

    const guidelinesList = (Array.isArray(learnedGuidelines) ? learnedGuidelines : [])
      .map((g) => sanitizeGuidelineText(typeof g === 'string' ? g : g?.text ?? ''))
      .filter(Boolean)
      .slice(0, 8);

    const userPayload = {
      query: sanitize(redactSecrets(String(query ?? ''))).slice(0, 800),
      errorSummary: sanitize(redactSecrets(String(errorSummary ?? ''))).slice(0, 800),
      budgetSummary: sanitize(redactSecrets(String(budgetSummary ?? ''))).slice(0, 300),
      ...(guidelinesList.length ? { learnedGuidelines: guidelinesList } : {}),
      candidates: promptCandidates,
    };

    const callRes = await this.#invokeReadOnlyStream({
      effectiveAdapter,
      model: resolved.effectiveModel,
      system: SUPERVISOR_SYSTEM_PROMPT,
      userPayload,
      maxTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs,
      signal,
    });
    this.#recordSupervisorCallOutcome({ ok: callRes.ok, timedOut: callRes.timedOut });

    if (!callRes.ok) {
      return {
        ok: false,
        bypassed: false,
        usedLlm: false,
        fallback: 'deterministic',
        circuitOpen: this.isCircuitOpen(),
        timedOut: Boolean(callRes.timedOut),
        model: resolved.effectiveModel,
        rationale: callRes.timedOut
          ? 'supervisor_timeout_deterministic_fallback'
          : 'supervisor_error_deterministic_fallback',
        keepRefs: [],
        compressRefs: [],
        expandSuggestions: [],
        contractHints: [],
        summary: '',
        rejectedRefs: [],
        inputTokens: callRes.inputTokens,
        outputTokens: callRes.outputTokens,
        totalTokens: callRes.totalTokens,
        durationMs: callRes.durationMs,
        error: callRes.error,
      };
    }

    const parsed = callRes.parsed;
    if (!parsed) {
      return {
        ok: false,
        bypassed: false,
        usedLlm: false,
        fallback: 'deterministic',
        model: resolved.effectiveModel,
        rationale: 'invalid_json_deterministic_fallback',
        keepRefs: [],
        compressRefs: [],
        expandSuggestions: [],
        contractHints: [],
        summary: '',
        rejectedRefs: [],
        inputTokens: callRes.inputTokens,
        outputTokens: callRes.outputTokens,
        totalTokens: callRes.totalTokens,
        durationMs: callRes.durationMs,
      };
    }

    const rejectedRefs = [];
    const filterRefs = (arr, excludeSet = null) => {
      if (!Array.isArray(arr)) return [];
      const out = [];
      const seen = new Set();
      for (const item of arr) {
        const rawId = String(item ?? '').trim();
        if (!rawId) continue;
        const mapped = validIdMap.get(rawId);
        if (!mapped) {
          rejectedRefs.push(rawId);
          continue;
        }
        if (excludeSet?.has(mapped) || seen.has(mapped)) continue;
        seen.add(mapped);
        out.push(mapped);
        if (out.length >= 20) break;
      }
      return out;
    };

    const keepRefs = filterRefs(parsed.keepRefs);
    const keepSet = new Set(keepRefs);
    const compressRefs = filterRefs(parsed.compressRefs, keepSet);
    const expandSuggestions = filterRefs(parsed.expandSuggestions);

    const contractHints = Array.isArray(parsed.contractHints)
      ? parsed.contractHints
          .map((h) => sanitizeGuidelineText(String(h ?? '')))
          .filter(Boolean)
          .slice(0, 10)
      : [];

    const summary = sanitize(redactSecrets(String(parsed.summary ?? '')))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200);

    return {
      ok: true,
      bypassed: false,
      usedLlm: true,
      fallback: null,
      circuitOpen: false,
      model: resolved.effectiveModel,
      rationale: resolved.rationale,
      keepRefs,
      compressRefs,
      expandSuggestions,
      contractHints,
      summary,
      rejectedRefs,
      inputTokens: callRes.inputTokens,
      outputTokens: callRes.outputTokens,
      totalTokens: callRes.totalTokens,
      durationMs: callRes.durationMs,
      usage: {
        inputTokens: callRes.inputTokens,
        outputTokens: callRes.outputTokens,
        totalTokens: callRes.totalTokens,
      },
    };
  }

  /**
   * Executes a strictly read-only (`tools: []`) batched pre-injection admission
   * decision over ambiguous tool output candidates. Fails closed to deterministic
   * rules on timeout, error, tool-call attempt, or malformed JSON.
   */
  async admitCandidates({
    query = '',
    candidates = [],
    activeContextSummary = '',
    errorSummary = '',
    contractHints = [],
    learnedGuidelines = [],
    signal = null,
    configOverride = null,
  } = {}) {
    const resolved = this.resolveModel(configOverride);
    const config = resolved.config;

    if (!config.enabled || config.mode === 'off') {
      return {
        ok: true,
        bypassed: true,
        usedLlm: false,
        fallback: null,
        model: null,
        rationale: resolved.rationale,
        decisions: [],
        contractHints: [],
        rejectedIds: [],
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: 0,
      };
    }

    const effectiveAdapter = this.adapter ?? this.pool?.adapter ?? null;
    if (!resolved.active || !resolved.effectiveModel || typeof effectiveAdapter?.stream !== 'function') {
      return {
        ok: false,
        bypassed: false,
        usedLlm: false,
        fallback: 'deterministic',
        circuitOpen: this.isCircuitOpen(),
        model: resolved.effectiveModel ?? null,
        rationale: !resolved.effectiveModel ? resolved.rationale : 'adapter_unavailable_deterministic_fallback',
        decisions: [],
        contractHints: [],
        rejectedIds: [],
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: 0,
      };
    }

    if (this.isCircuitOpen()) {
      return {
        ok: false,
        bypassed: false,
        usedLlm: false,
        fallback: 'deterministic',
        circuitOpen: true,
        model: resolved.effectiveModel,
        rationale: 'supervisor_circuit_open_deterministic_fallback',
        decisions: [],
        contractHints: [],
        rejectedIds: [],
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: 0,
      };
    }

    const candidateList = Array.isArray(candidates) ? candidates.slice(0, 30) : [];
    const validIdMap = new Map();
    const promptCandidates = [];

    for (const c of candidateList) {
      if (!c || typeof c !== 'object') continue;
      const canonicalId = String(c.id ?? c.refId ?? c.uri ?? '').trim();
      if (!canonicalId) continue;
      validIdMap.set(canonicalId, canonicalId);
      promptCandidates.push({
        id: canonicalId,
        path: sanitize(redactSecrets(String(c.path ?? ''))).slice(0, 140),
        toolName: String(c.toolName ?? 'tool').slice(0, 40),
        chars: Number(c.chars ?? 0),
        tokens: Number(c.tokens ?? 0),
        score: Number.isFinite(Number(c.score)) ? Number(Number(c.score).toFixed(3)) : 0,
        criticalDomains: Array.isArray(c.criticalDomains) ? c.criticalDomains.slice(0, 5) : [],
        rawDomains: Array.isArray(c.rawDomains) ? c.rawDomains.slice(0, 5) : [],
        isDecoy: Boolean(c.isDecoy),
        promptTarget: Boolean(c.promptTarget),
        errorTarget: Boolean(c.errorTarget),
        mutatedTarget: Boolean(c.mutatedTarget),
        symbols: Array.isArray(c.symbols) ? c.symbols.slice(0, 10).map((s) => sanitize(String(s)).slice(0, 60)) : [],
        excerpt: sanitize(redactSecrets(String(c.excerpt ?? ''))).slice(0, 320),
      });
    }

    const safeHints = (Array.isArray(contractHints) ? contractHints : [])
      .map((h) => sanitizeGuidelineText(String(h ?? '')))
      .filter(Boolean)
      .slice(0, 8);
    const safeGuidelines = (Array.isArray(learnedGuidelines) ? learnedGuidelines : [])
      .map((g) => sanitizeGuidelineText(typeof g === 'string' ? g : g?.text ?? ''))
      .filter(Boolean)
      .slice(0, 8);

    const userPayload = {
      query: sanitize(redactSecrets(String(query ?? ''))).slice(0, 800),
      activeContextSummary: sanitize(redactSecrets(String(activeContextSummary ?? ''))).slice(0, 500),
      errorSummary: sanitize(redactSecrets(String(errorSummary ?? ''))).slice(0, 800),
      ...(safeHints.length ? { contractHints: safeHints } : {}),
      ...(safeGuidelines.length ? { learnedGuidelines: safeGuidelines } : {}),
      candidates: promptCandidates,
    };

    const callRes = await this.#invokeReadOnlyStream({
      effectiveAdapter,
      model: resolved.effectiveModel,
      system: ADMISSION_SUPERVISOR_SYSTEM_PROMPT,
      userPayload,
      maxTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs,
      signal,
    });
    this.#recordSupervisorCallOutcome({ ok: callRes.ok, timedOut: callRes.timedOut });

    if (!callRes.ok) {
      return {
        ok: false,
        bypassed: false,
        usedLlm: false,
        fallback: 'deterministic',
        circuitOpen: this.isCircuitOpen(),
        timedOut: Boolean(callRes.timedOut),
        model: resolved.effectiveModel,
        rationale: callRes.timedOut
          ? 'supervisor_timeout_deterministic_fallback'
          : 'supervisor_error_deterministic_fallback',
        decisions: [],
        contractHints: [],
        rejectedIds: [],
        inputTokens: callRes.inputTokens,
        outputTokens: callRes.outputTokens,
        totalTokens: callRes.totalTokens,
        durationMs: callRes.durationMs,
        error: callRes.error,
      };
    }

    const parsed = callRes.parsed;
    if (!parsed || !Array.isArray(parsed.decisions)) {
      return {
        ok: false,
        bypassed: false,
        usedLlm: false,
        fallback: 'deterministic',
        model: resolved.effectiveModel,
        rationale: 'invalid_json_deterministic_fallback',
        decisions: [],
        contractHints: [],
        rejectedIds: [],
        inputTokens: callRes.inputTokens,
        outputTokens: callRes.outputTokens,
        totalTokens: callRes.totalTokens,
        durationMs: callRes.durationMs,
      };
    }

    const decisions = [];
    const rejectedIds = [];
    const seenIds = new Set();

    for (const entry of parsed.decisions) {
      if (!entry || typeof entry !== 'object') continue;
      const rawId = String(entry.id ?? '').trim();
      const canonicalId = validIdMap.get(rawId);
      if (!canonicalId) {
        if (rawId) rejectedIds.push(rawId);
        continue;
      }
      if (seenIds.has(canonicalId)) continue;
      const rawDec = String(entry.decision ?? '').trim().toUpperCase();
      if (!VALID_ADMISSION_DECISIONS.has(rawDec)) {
        rejectedIds.push(canonicalId);
        continue;
      }
      seenIds.add(canonicalId);
      const focusSymbols = Array.isArray(entry.focusSymbols)
        ? entry.focusSymbols
            .map((s) => sanitize(redactSecrets(String(s ?? ''))).trim().slice(0, 64))
            .filter(Boolean)
            .slice(0, 12)
        : [];
      const reason = sanitize(redactSecrets(String(entry.reason ?? '')))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
      decisions.push({
        id: canonicalId,
        decision: rawDec,
        focusSymbols,
        reason,
      });
    }

    const returnedHints = Array.isArray(parsed.contractHints)
      ? parsed.contractHints
          .map((h) => sanitizeGuidelineText(String(h ?? '')))
          .filter(Boolean)
          .slice(0, 10)
      : [];

    return {
      ok: true,
      bypassed: false,
      usedLlm: true,
      fallback: null,
      circuitOpen: false,
      model: resolved.effectiveModel,
      rationale: resolved.rationale,
      decisions,
      contractHints: returnedHints,
      rejectedIds,
      inputTokens: callRes.inputTokens,
      outputTokens: callRes.outputTokens,
      totalTokens: callRes.totalTokens,
      durationMs: callRes.durationMs,
      usage: {
        inputTokens: callRes.inputTokens,
        outputTokens: callRes.outputTokens,
        totalTokens: callRes.totalTokens,
      },
    };
  }
}
