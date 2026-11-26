import { mergeUsageSnapshot } from '../observability/prompt-cache.js';
import { setTimeout as delay } from 'node:timers/promises';
import { CancellationError, classifyError, InferenceError } from './errors.js';

/**
 * Unified inference engine wrapping LlmAdapter streaming calls, token accounting,
 * finish reason detection, and safe transient retries (only prior to partial emission).
 */
export class InferenceEngine {
  constructor(
    adapter,
    {
      maxRetries = 3,
      retryDelayMs = 200,
      pool = null,
      trafficSource = null,
      benchmarkRetryBaseMs = 3000,
    } = {},
  ) {
    this.adapter = adapter;
    this.pool = pool ?? adapter?.pool ?? null;
    this.maxRetries = Math.max(0, Number(maxRetries ?? 3));
    this.retryDelayMs = Math.max(25, Number(retryDelayMs ?? 200));
    this.trafficSource = trafficSource ? String(trafficSource).trim().toLowerCase() : null;
    const parsedBenchBase = Number(benchmarkRetryBaseMs ?? 3000);
    this.benchmarkRetryBaseMs = Math.max(1, Number.isFinite(parsedBenchBase) ? parsedBenchBase : 3000);
  }

  async streamStep({
    provider = 'pool',
    model,
    sessionKey = null,
    effort = null,
    messages,
    tools = [],
    maxTokens = 4096,
    signal,
    pool = null,
    excludeAccountIds = null,
    trafficSource = null,
    benchmarkRetryBaseMs = null,
    onTextDelta = null,
    onReasoningDelta = null,
    onRetryBudget = null,
    onRouteFailover = null,
  }) {
    const activePool = pool ?? this.pool ?? this.adapter?.pool ?? null;
    const initialExcludedAccounts = new Set(
      excludeAccountIds
        ? [...excludeAccountIds].filter(Boolean).map(String)
        : [],
    );
    const excludedAccounts = new Set(initialExcludedAccounts);
    const effectiveTrafficSource = String(trafficSource ?? this.trafficSource ?? '')
      .trim()
      .toLowerCase();
    const isBenchmarkMode = effectiveTrafficSource === 'benchmark';
    let attempt = 0;
    let activeMaxTokens = maxTokens;
    for (;;) {
      let text = '';
      let reasoning = '';
      const toolCalls = [];
      let finishReason = 'completed';
      let route = null;
      let usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      };
      const usageByRequest = new Map();
      let emittedAnything = false;
      let providerInvoked = false;
      const resolvedProvider = provider && provider !== 'pool' ? provider : null;
      const preCandidateRoutes =
        activePool && typeof activePool.resolveRoutes === 'function'
          ? activePool.resolveRoutes(model, {
              provider: resolvedProvider,
              sessionKey,
              excludeAccountIds: excludedAccounts.size ? [...excludedAccounts] : null,
            })
          : [];
      const prePrimaryAccountId = preCandidateRoutes[0]?.accountId ?? null;

      try {
        signal?.throwIfAborted?.();
        providerInvoked = true;
        for await (const chunk of this.adapter.stream({
          provider,
          model,
          sessionKey,
          effort,
          messages,
          tools,
          maxTokens: activeMaxTokens,
          signal,
          ...(excludedAccounts.size
            ? { excludeAccountIds: [...excludedAccounts] }
            : {}),
        })) {
          if (chunk.type !== 'usage') signal?.throwIfAborted?.();
          if (chunk.type === 'route-failover' && chunk.failover) {
            if (chunk.failover.fromAccountId) {
              excludedAccounts.add(String(chunk.failover.fromAccountId));
            }
            onRouteFailover?.(chunk.failover);
          } else if (chunk.type === 'route' && chunk.route) {
            route = chunk.route;
          } else if (chunk.type === 'usage' && chunk.usage) {
            const key = chunk.usageRequestId ?? '';
            const previous = usageByRequest.get(key) ?? {};
            const next = mergeUsageSnapshot({ ...previous }, chunk.usage);
            for (const [field, n] of Object.entries(next)) {
              usage[field] = (usage[field] ?? 0) + n - (previous[field] ?? 0);
            }
            usageByRequest.set(key, next);
          } else if (chunk.type === 'reasoning-delta' && chunk.text) {
            emittedAnything = true;
            reasoning += chunk.text;
            onReasoningDelta?.(chunk.text, reasoning);
          } else if (chunk.type === 'text-delta' && chunk.text) {
            emittedAnything = true;
            text += chunk.text;
            onTextDelta?.(chunk.text, text);
          } else if (
            chunk.type === 'block-end' &&
            chunk.block?.type === 'tool-call'
          ) {
            emittedAnything = true;
            toolCalls.push(chunk.block);
          } else if (chunk.type === 'finish' && chunk.reason) {
            finishReason =
              typeof chunk.reason === 'object' && chunk.reason !== null
                ? String(chunk.reason.kind || 'completed')
                : String(chunk.reason);
          }
        }
        signal?.throwIfAborted?.();
        return {
          text,
          reasoning,
          toolCalls,
          finishReason,
          usage,
          route,
        };
      } catch (err) {
        if (signal?.aborted) {
          const reason = signal.reason;
          const reasonMsg =
            reason instanceof Error
              ? (reason.detail?.message ?? reason.message)
              : typeof reason === 'string' && reason
                ? reason
                : String(err?.detail?.message ?? err?.message ?? 'Inference aborted');
          const base = classifyError(err);
          const cancelled =
            base instanceof CancellationError
              ? base
              : new CancellationError('STREAM_ABORTED', {
                  message: reasonMsg,
                  cause: err,
                  detail: reason !== undefined ? { reason: reasonMsg } : undefined,
                });
          cancelled.partialUsage = usage;
          if (route) cancelled.route = route;
          cancelled.abortedBeforeProvider = !providerInvoked;
          throw cancelled;
        }
        const classified = classifyError(err);
        if (Array.isArray(err?.detail?.triedAccountIds)) {
          for (const tid of err.detail.triedAccountIds) {
            if (tid) excludedAccounts.add(String(tid));
          }
        }
        const rawHttpStatus = Number(
          err?.detail?.statusCode ??
            err?.cause?.status ??
            err?.cause?.statusCode ??
            err?.status ??
            err?.statusCode ??
            0,
        );
        const isPermanentClientOrAuthError =
          rawHttpStatus === 400 ||
          rawHttpStatus === 401 ||
          rawHttpStatus === 403 ||
          rawHttpStatus === 404 ||
          rawHttpStatus === 422;
        const poolAlreadyExhausted =
          err?.code === 'PROVIDER_UNAVAILABLE' &&
          err?.detail?.exhausted === true &&
          activePool &&
          typeof activePool.resolveRoutes === 'function' &&
          activePool.resolveRoutes(model, {
            provider: resolvedProvider,
            sessionKey,
            excludeAccountIds: excludedAccounts.size ? [...excludedAccounts] : null,
          }).length === 0;
        const initialExcludesList = initialExcludedAccounts.size
          ? [...initialExcludedAccounts]
          : null;
        let hasTransientPoolRoutes = false;
        if (isBenchmarkMode && !isPermanentClientOrAuthError && activePool) {
          if (typeof activePool.hasTransientCooldownRoutes === 'function') {
            hasTransientPoolRoutes = activePool.hasTransientCooldownRoutes(model, {
              provider: resolvedProvider,
              excludeAccountIds: initialExcludesList,
            });
          } else if (typeof activePool.resolveRoutes === 'function') {
            hasTransientPoolRoutes =
              activePool.resolveRoutes(model, {
                provider: resolvedProvider,
                sessionKey,
                excludeAccountIds: initialExcludesList,
              }).length > 0 &&
              Array.isArray(err?.detail?.triedAccountIds) &&
              err.detail.triedAccountIds.length > 0;
          }
        }
        const canBypassPoolExhaustion =
          isBenchmarkMode &&
          poolAlreadyExhausted &&
          !isPermanentClientOrAuthError &&
          hasTransientPoolRoutes;
        const effectiveMaxRetries =
          isBenchmarkMode && !isPermanentClientOrAuthError
            ? Math.max(this.maxRetries, 5)
            : this.maxRetries;
        if (
          !emittedAnything &&
          (!poolAlreadyExhausted || canBypassPoolExhaustion) &&
          classified.retryable &&
          !(isBenchmarkMode && isPermanentClientOrAuthError) &&
          attempt < effectiveMaxRetries
        ) {
          attempt++;
          const rawStatus = isBenchmarkMode
            ? rawHttpStatus
            : Number(
                err?.status ??
                  err?.statusCode ??
                  err?.cause?.status ??
                  err?.cause?.statusCode ??
                  err?.detail?.statusCode ??
                  0,
              );
          const statusCode =
            rawStatus ||
            (/\b(429|500|502|503|504)\b/.exec(String(err?.message ?? ''))
              ? Number(RegExp.$1)
              : null);
          const fromAccountId =
            route?.accountId ??
            err?.accountId ??
            err?.route?.accountId ??
            err?.detail?.accountId ??
            prePrimaryAccountId ??
            null;
          if (fromAccountId) {
            excludedAccounts.add(String(fromAccountId));
            if (activePool) {
              if (typeof activePool.recordAccountFailure === 'function') {
                activePool.recordAccountFailure(fromAccountId, err?.cause ?? err);
              } else if (typeof activePool.markRouteFailure === 'function') {
                activePool.markRouteFailure(
                  { source: 'pool', accountId: String(fromAccountId) },
                  err?.cause ?? err,
                );
              }
            }
          }
          const nextCandidateRoutes =
            activePool && typeof activePool.resolveRoutes === 'function'
              ? activePool.resolveRoutes(model, {
                  provider: resolvedProvider,
                  sessionKey,
                  excludeAccountIds: excludedAccounts.size ? [...excludedAccounts] : null,
                })
              : [];
          const toAccountId = nextCandidateRoutes[0]?.accountId ?? null;
          onRouteFailover?.({
            attempt,
            statusCode,
            fromAccountId,
            toAccountId,
            reason: classified.message || String(err?.message ?? err),
          });
          if (typeof onRetryBudget === 'function') {
            const nextCap = onRetryBudget({ attempt, usage, error: classified });
            if (typeof nextCap === 'number' && Number.isFinite(nextCap)) {
              activeMaxTokens = nextCap;
            }
          }
          providerInvoked = false;
          const hasDifferentStandby = Boolean(
            toAccountId && fromAccountId && toAccountId !== fromAccountId,
          );
          const hasPostFailureTransientRoutes =
            hasTransientPoolRoutes ||
            canBypassPoolExhaustion ||
            (isBenchmarkMode &&
              nextCandidateRoutes.length === 0 &&
              typeof activePool?.hasTransientCooldownRoutes === 'function' &&
              activePool.hasTransientCooldownRoutes(model, {
                provider: resolvedProvider,
                excludeAccountIds: initialExcludesList,
              }));
          const cyclingSingleOrExhaustedPool =
            isBenchmarkMode &&
            nextCandidateRoutes.length === 0 &&
            hasPostFailureTransientRoutes;
          let backoffMs;
          if (hasDifferentStandby) {
            backoffMs = Math.min(25, this.retryDelayMs);
          } else if (isBenchmarkMode) {
            const parsedStepBase = Number(
              benchmarkRetryBaseMs ?? this.benchmarkRetryBaseMs ?? 3000,
            );
            const baseMs = Math.max(
              1,
              Number.isFinite(parsedStepBase) ? parsedStepBase : 3000,
            );
            const expMs = Math.min(45_000, baseMs * Math.pow(2, attempt - 1));
            const jitterMs =
              baseMs >= 100
                ? Math.floor(
                    Math.random() * Math.min(1000, Math.max(1, Math.floor(expMs * 0.2))),
                  )
                : 0;
            backoffMs = Math.min(45_000, expMs + jitterMs);
          } else {
            backoffMs = this.retryDelayMs * attempt;
          }
          try {
            await delay(backoffMs, undefined, { signal });
          } catch (delayErr) {
            const reason = signal?.reason;
            const reasonMsg =
              reason instanceof Error
                ? reason.message
                : typeof reason === 'string' && reason
                  ? reason
                  : String(delayErr?.message ?? 'Aborted during retry backoff');
            const cancelled = new CancellationError('STREAM_ABORTED', {
              message: reasonMsg,
              cause: delayErr,
              detail: reason !== undefined ? { reason: reasonMsg } : undefined,
            });
            cancelled.partialUsage = {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: null,
              cacheWriteTokens: null,
            };
            cancelled.abortedBeforeProvider = true;
            throw cancelled;
          }
          if (cyclingSingleOrExhaustedPool) {
            const transientIds = [...excludedAccounts].filter(
              (id) => !initialExcludedAccounts.has(id),
            );
            excludedAccounts.clear();
            for (const id of initialExcludedAccounts) {
              excludedAccounts.add(id);
            }
            activePool?.clearTransientCooldowns?.(
              transientIds.length ? transientIds : null,
            );
          }
          continue;
        }
        const outErr =
          classified instanceof InferenceError
            ? classified
            : classified.retryable
              ? new InferenceError('INFERENCE_STREAM_FAILED', {
                  message: classified.message,
                  retryable: true,
                  cause: err,
                })
              : classified;
        outErr.partialUsage = usage;
        if (route) outErr.route = route;
        outErr.abortedBeforeProvider = !providerInvoked;
        throw outErr;
      }
    }
  }
}
