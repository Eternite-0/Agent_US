import { RuntimeError } from './errors.js';
import { RUNTIME_EVENTS } from './events.js';
import { assertLeaseInTx } from '../durable/lease-guard.js';

export const TURN_PHASES = Object.freeze({
  INIT: 'init',
  CHECKPOINT: 'checkpoint',
  INFERENCE: 'inference',
  TOOLS: 'tools',
  VERIFYING: 'verifying',
  COMPACTING: 'compacting',
  PARKED: 'parked',
  RECONCILING: 'reconciling',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const TERMINAL_PHASES = new Set([
  TURN_PHASES.COMPLETED,
  TURN_PHASES.FAILED,
  TURN_PHASES.CANCELLED,
]);

export const SESSION_STATES = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PARKED: 'parked',
  RECONCILING: 'reconciling',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const TURN_TRANSITIONS = Object.freeze({
  [TURN_PHASES.INIT]: new Set([
    TURN_PHASES.CHECKPOINT,
    TURN_PHASES.COMPACTING,
    TURN_PHASES.INFERENCE,
    TURN_PHASES.VERIFYING,
    TURN_PHASES.PARKED,
    TURN_PHASES.RECONCILING,
    TURN_PHASES.FAILED,
    TURN_PHASES.CANCELLED,
  ]),
  [TURN_PHASES.CHECKPOINT]: new Set([
    TURN_PHASES.CHECKPOINT,
    TURN_PHASES.COMPACTING,
    TURN_PHASES.INFERENCE,
    TURN_PHASES.TOOLS,
    TURN_PHASES.VERIFYING,
    TURN_PHASES.PARKED,
    TURN_PHASES.RECONCILING,
    TURN_PHASES.COMPLETED,
    TURN_PHASES.FAILED,
    TURN_PHASES.CANCELLED,
  ]),
  [TURN_PHASES.COMPACTING]: new Set([
    TURN_PHASES.INFERENCE,
    TURN_PHASES.CHECKPOINT,
    TURN_PHASES.FAILED,
    TURN_PHASES.CANCELLED,
  ]),
  [TURN_PHASES.INFERENCE]: new Set([
    TURN_PHASES.TOOLS,
    TURN_PHASES.VERIFYING,
    TURN_PHASES.CHECKPOINT,
    TURN_PHASES.COMPLETED,
    TURN_PHASES.FAILED,
    TURN_PHASES.CANCELLED,
  ]),
  [TURN_PHASES.TOOLS]: new Set([
    TURN_PHASES.CHECKPOINT,
    TURN_PHASES.COMPACTING,
    TURN_PHASES.INFERENCE,
    TURN_PHASES.VERIFYING,
    TURN_PHASES.PARKED,
    TURN_PHASES.RECONCILING,
    TURN_PHASES.COMPLETED,
    TURN_PHASES.FAILED,
    TURN_PHASES.CANCELLED,
  ]),
  [TURN_PHASES.VERIFYING]: new Set([
    TURN_PHASES.CHECKPOINT,
    TURN_PHASES.INFERENCE,
    TURN_PHASES.COMPLETED,
    TURN_PHASES.FAILED,
    TURN_PHASES.CANCELLED,
    TURN_PHASES.RECONCILING,
  ]),
  [TURN_PHASES.PARKED]: new Set([
    TURN_PHASES.CHECKPOINT,
    TURN_PHASES.TOOLS,
    TURN_PHASES.INFERENCE,
    TURN_PHASES.FAILED,
    TURN_PHASES.CANCELLED,
  ]),
  [TURN_PHASES.RECONCILING]: new Set([
    TURN_PHASES.CHECKPOINT,
    TURN_PHASES.INFERENCE,
    TURN_PHASES.TOOLS,
    TURN_PHASES.FAILED,
    TURN_PHASES.CANCELLED,
  ]),
  [TURN_PHASES.COMPLETED]: new Set(),
  [TURN_PHASES.FAILED]: new Set(),
  [TURN_PHASES.CANCELLED]: new Set(),
});

/**
 * Validated Turn State Machine enforcing monotonic phase transitions and terminal immutability.
 */
export class TurnStateMachine {
  constructor({
    store = null,
    eventRouter = null,
    sessionId,
    turnId,
    initialPhase = TURN_PHASES.INIT,
    initialStep = 0,
    leaseGuard = null,
    deferTerminalPhase = false,
  }) {
    this.store = store;
    this.eventRouter = eventRouter;
    this.sessionId = sessionId;
    this.turnId = turnId;
    this.phase = initialPhase;
    this.step = initialStep;
    this.leaseGuard = leaseGuard;
    this.deferTerminalPhase = Boolean(deferTerminalPhase);
    this.deferredTerminalTransition = null;
    this.history = [{ phase: initialPhase, step: initialStep, at: Date.now() }];
  }

  isTerminal() {
    return TERMINAL_PHASES.has(this.phase);
  }

  transition(
    nextPhase,
    { step = this.step, reason = null, persist = true, defer = false } = {},
  ) {
    if (nextPhase === this.phase && step === this.step) {
      return this.phase;
    }
    const allowed = TURN_TRANSITIONS[this.phase];
    if (!allowed || !allowed.has(nextPhase)) {
      throw new RuntimeError('INVALID_TRANSITION', {
        status: 409,
        message: `Illegal turn phase transition: ${this.phase} -> ${nextPhase}`,
        detail: { from: this.phase, to: nextPhase, turnId: this.turnId },
      });
    }
    const prevPhase = this.phase;
    const shouldDefer =
      Boolean(defer) || (this.deferTerminalPhase && TERMINAL_PHASES.has(nextPhase));

    if (shouldDefer) {
      this.phase = nextPhase;
      this.step = step;
      const rec = { from: prevPhase, to: nextPhase, step, reason, at: Date.now() };
      this.deferredTerminalTransition = rec;
      this.history.push({ phase: nextPhase, step, reason, at: rec.at });
      return this.phase;
    }

    let persistedEv = null;
    if (persist && this.store?.db && this.turnId) {
      this.store.tx(() => {
        assertLeaseInTx(this.leaseGuard, { sessionId: this.sessionId, turnId: this.turnId });
        this.store.db
          .prepare(
            "UPDATE direct_turns SET phase=?, step=? WHERE id=? AND state NOT IN ('completed','failed','cancelled')",
          )
          .run(nextPhase, step, this.turnId);
        if (
          this.eventRouter &&
          this.sessionId &&
          typeof this.eventRouter.insertPersistedInTx === 'function'
        ) {
          persistedEv = this.eventRouter.insertPersistedInTx({
            sessionId: this.sessionId,
            turnId: this.turnId,
            type: RUNTIME_EVENTS.TURN_PHASE_CHANGED,
            data: {
              from: prevPhase,
              to: nextPhase,
              step,
              ...(reason ? { reason } : {}),
            },
            audit: false,
          });
        }
      });
    }

    this.phase = nextPhase;
    this.step = step;
    this.history.push({ phase: nextPhase, step, reason, at: Date.now() });

    if (persistedEv) {
      this.eventRouter.fanoutPersisted(persistedEv);
    } else if (this.eventRouter && this.sessionId) {
      this.eventRouter.emitPersisted({
        sessionId: this.sessionId,
        turnId: this.turnId,
        type: RUNTIME_EVENTS.TURN_PHASE_CHANGED,
        data: {
          from: prevPhase,
          to: nextPhase,
          step,
          ...(reason ? { reason } : {}),
        },
        audit: false,
      });
    }
    return this.phase;
  }
}
