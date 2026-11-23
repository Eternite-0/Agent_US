import { mergeUsageSnapshot } from '../observability/prompt-cache.js';
import { setTimeout as delay } from 'node:timers/promises';
import { CancellationError, classifyError, InferenceError } from './errors.js';

/**
 * Unified inference engine wrapping LlmAdapter streaming calls, token accounting,
 * finish reason detection, and safe transient retries (only prior to partial emission).
 */
export class InferenceEngine {
  constructor(adapter, { maxRetries = 1, retryDelayMs = 400 } = {}) {
    this.adapter = adapter;
    this.maxRetries = Math.max(0, Number(maxRetries ?? 1));
    this.retryDelayMs = Math.max(50, Number(retryDelayMs ?? 400));
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
    onTextDelta = null,
    onReasoningDelta = null,
    onRetryBudget = null,
  }) {
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
        })) {
          if (chunk.type !== 'usage') signal?.throwIfAborted?.();
          if (chunk.type === 'route' && chunk.route) {
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
        if (
          !emittedAnything &&
          classified.retryable &&
          attempt < this.maxRetries
        ) {
          attempt++;
          if (typeof onRetryBudget === 'function') {
            const nextCap = onRetryBudget({ attempt, usage, error: classified });
            if (typeof nextCap === 'number' && Number.isFinite(nextCap)) {
              activeMaxTokens = nextCap;
            }
          }
          providerInvoked = false;
          try {
            await delay(this.retryDelayMs * attempt, undefined, { signal });
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
