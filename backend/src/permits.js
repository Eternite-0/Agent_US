import { Fault } from './store.js';

/**
 * Definite pre-effect refusal proof: guarantees no container/external side effect started.
 * Only trusted kernel/host validation paths (schema preflight, hard-block policy, unknown MCP)
 * may construct this error.
 */
export class RejectedBeforeEffectError extends Fault {
  constructor(code, { message = code, issues = [], hint = null } = {}) {
    super(code, 400, { effect: 'none', issues, hint });
    this.name = 'RejectedBeforeEffectError';
    this.effect = 'none';
    this.issues = issues;
    this.hint = hint;
    this.message = message;
  }
}

function refused(message) {
  throw new Fault('E_EXECUTE_PERMIT', 403, { message });
}

/**
 * In-process one-shot execution permit registry inspired by Agnes Harness.
 * Permits are frozen, empty opaque objects authenticated via a private WeakMap:
 * they cannot be serialized, cloned, forged, or replayed across dispatches.
 */
export class ExecutePermitRegistry {
  #live = new WeakMap();
  #byEffect = new Map();
  #open = true;

  issue({ owner, effectId, approvalId, evidenceId, callId, attempt = 1 }) {
    if (!this.#open) refused('permit registry is closed');
    if (!owner || typeof owner !== 'object') refused('permit owner is invalid');
    if (!effectId || typeof effectId !== 'string')
      refused('effect id is invalid');
    if (!evidenceId || typeof evidenceId !== 'string')
      refused('evidence id is invalid');
    if (attempt !== 1 && attempt !== 2) refused('execute attempt is invalid');

    const prior = this.#byEffect.get(effectId);
    if (prior) {
      if (prior.owner !== owner || prior.evidenceId !== evidenceId) {
        refused('effect is bound to another owner or evidence record');
      }
      if (prior.livePermit) refused('previous permit remains unconsumed');
      if (attempt !== prior.consumedAttempt + 1) {
        refused('execute attempts must be issued once in strict order');
      }
    } else if (attempt !== 1) {
      refused('first execute attempt must be attempt 1');
    }

    const permit = Object.freeze({});
    const binding = Object.freeze({
      owner,
      effectId,
      approvalId: approvalId ?? null,
      evidenceId,
      callId: callId ?? null,
      attempt,
    });
    this.#live.set(permit, binding);
    if (prior) {
      prior.issuedAttempt = attempt;
      prior.livePermit = permit;
    } else {
      this.#byEffect.set(effectId, {
        owner,
        evidenceId,
        issuedAttempt: attempt,
        consumedAttempt: 0,
        livePermit: permit,
      });
    }
    return permit;
  }

  consume(permit, expected) {
    if (!permit || typeof permit !== 'object') {
      refused('permit is missing or not an object');
    }
    const binding = this.#live.get(permit);
    if (
      !binding ||
      binding.owner !== expected.owner ||
      binding.effectId !== expected.effectId ||
      binding.evidenceId !== expected.evidenceId ||
      binding.approvalId !== (expected.approvalId ?? null) ||
      binding.callId !== (expected.callId ?? null) ||
      binding.attempt !== (expected.attempt ?? 1)
    ) {
      refused('permit is unknown, stale, or bound to another dispatch');
    }

    const state = this.#byEffect.get(binding.effectId);
    if (
      !state ||
      state.livePermit !== permit ||
      state.issuedAttempt !== binding.attempt
    ) {
      refused('permit registry state is inconsistent');
    }

    this.#live.delete(permit);
    state.livePermit = undefined;
    state.consumedAttempt = binding.attempt;
    return binding;
  }

  close() {
    this.#open = false;
    for (const state of this.#byEffect.values()) {
      if (state.livePermit) this.#live.delete(state.livePermit);
    }
    this.#byEffect.clear();
  }
}

export async function dispatchWithPermit(permit, expected, permits, fn) {
  permits.consume(permit, expected);
  return await fn();
}
