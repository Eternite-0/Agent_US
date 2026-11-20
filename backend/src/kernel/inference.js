import { setTimeout as delay } from 'node:timers/promises';
import { classifyError, InferenceError } from './errors.js';

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
      signal?.throwIfAborted?.();
      let text = '';
      let reasoning = '';
      const toolCalls = [];
      let finishReason = 'completed';
      let usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      let emittedAnything = false;

      try {
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
          signal?.throwIfAborted?.();
          if (chunk.type === 'usage' && chunk.usage) {
            usage.inputTokens += Number(chunk.usage.inputTokens ?? 0);
            usage.outputTokens += Number(chunk.usage.outputTokens ?? 0);
            usage.cacheReadTokens += Number(chunk.usage.cacheReadTokens ?? 0);
            usage.cacheWriteTokens += Number(chunk.usage.cacheWriteTokens ?? 0);
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
            finishReason = String(chunk.reason);
          }
        }
        return {
          text,
          reasoning,
          toolCalls,
          finishReason,
          usage,
        };
      } catch (err) {
        if (signal?.aborted) {
          const cancelled = classifyError(err);
          cancelled.partialUsage = usage;
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
          await delay(this.retryDelayMs * attempt, undefined, { signal });
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
        throw outErr;
      }
    }
  }
}
