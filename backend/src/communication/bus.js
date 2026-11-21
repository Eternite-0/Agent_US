import { validateMessageDraft } from './envelope.js';

const DEFAULT_RETRY_DELAY_MS = 1000;

/** Transport-independent protocol with an injected persistence adapter. */
export class CommunicationBus {
  constructor({ adapter, clock = () => Date.now(), defaultTtlMs, defaultMaxAttempts = 5, visibilityTimeoutMs = 30_000, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = {}) {
    if (!adapter || typeof adapter.append !== 'function' || typeof adapter.claimNext !== 'function') {
      throw new TypeError('CommunicationBus requires an injected persistence adapter');
    }
    this.adapter = adapter;
    this.clock = clock;
    this.options = { defaultTtlMs, defaultMaxAttempts, visibilityTimeoutMs, retryDelayMs };
  }
  async send(input) {
    return this.adapter.append(validateMessageDraft(input, { now: this.clock(), defaultTtlMs: this.options.defaultTtlMs, maxAttempts: this.options.defaultMaxAttempts }));
  }
  async receive(agentId, options = {}) {
    if (typeof agentId !== 'string' || !agentId) throw new TypeError('agentId is required');
    return this.adapter.claimNext({ agentId, runId: options.runId ?? null, now: this.clock(), visibilityTimeoutMs: options.visibilityTimeoutMs ?? this.options.visibilityTimeoutMs });
  }
  async ack(messageId, agentId, deliveryToken = undefined) { return this.adapter.ack({ messageId, agentId, deliveryToken, now: this.clock() }); }
  bindClaimToChildInTx(input) {
    if (typeof this.adapter.bindClaimToChildInTx !== 'function') {
      throw new TypeError('Communication adapter does not support child delivery binding');
    }
    return this.adapter.bindClaimToChildInTx({ ...input, now: input?.now ?? this.clock() });
  }
  async retry(messageId, agentId, { delayMs = this.options.retryDelayMs, error = null, deliveryToken = undefined } = {}) {
    return this.adapter.retry({ messageId, agentId, deliveryToken, now: this.clock(), delayMs: Math.max(0, Math.trunc(Number(delayMs) || 0)), error: error ? String(error) : null });
  }
  async cancel(messageId, actorId) { return this.adapter.cancel({ messageId, actorId, now: this.clock() }); }
  async sweep() { return this.adapter.sweep ? this.adapter.sweep({ now: this.clock() }) : { expired: 0, deadLettered: 0 }; }
  async get(messageId) { return this.adapter.get(messageId); }
  async list(options) { return this.adapter.list(options); }
  async listConflicts(options) { return this.adapter.listConflicts(options); }
  async resolveConflict(conflictId, resolution, reviewerId) {
    if (!reviewerId) throw new TypeError('reviewerId is required');
    return this.adapter.resolveConflict({ conflictId, resolution, reviewerId, now: this.clock() });
  }
}
