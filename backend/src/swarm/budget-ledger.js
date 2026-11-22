import { id as uuid } from '../store.js';
import { measureRequestComposition } from '../context.js';
import { BudgetError } from '../kernel/errors.js';
import { assertLeaseInTx, classifyJobOwnership } from '../durable/lease-guard.js';

/**
 * Budget scope contract for Agent_US task-tree accounting.
 * Every budgeted model call across the swarm & subagent task tree MUST reserve
 * and settle through TaskTreeBudgetLedger under one of these scopes:
 *  - `planning`: DynamicTaskPlanner.decompose() DAG generation model calls
 *  - `node_execution`: Worker/subagent AgentLoop inference calls (including failed attempts & retries)
 *  - `review_verification`: Review/verification nodes and model-backed verification/judgment calls
 *  - `replanning`: DynamicReplanner admission & LLM-assisted replanning calls
 *
 * Token budget guarantee boundary (honest engineering contract):
 *  - Pre-inference: Estimates input tokens locally via CJK-aware `measureRequestComposition`,
 *    atomically verifies admission against shared SQLite remaining budget (`BEGIN IMMEDIATE`),
 *    and constrains the controllable `maxOutputTokens` passed to the provider so that
 *    `estimatedInputTokens + constrainedMaxOutputTokens <= availableTreeTokens`.
 *  - Provider billing boundary: External providers use proprietary tokenizers and may bill
 *    hidden system wrappers or server-side reasoning tokens unknown prior to completion.
 *    Consequently, a single admitted call may settle above or below the local pre-estimate.
 *  - Post-inference settlement: Settles against actual provider-reported usage, releases unused
 *    reserved balance immediately back to the tree, persists signed `estimationErrorTokens` and
 *    positive `overageTokens`/`overageSteps`, and blocks all further calls once exhausted.
 */
export const BUDGET_SCOPES = Object.freeze({
  PLANNING: 'planning',
  NODE_EXECUTION: 'node_execution',
  REVIEW_VERIFICATION: 'review_verification',
  REPLANNING: 'replanning',
});

export const BUDGET_ERROR_CODES = Object.freeze(
  new Set([
    'BUDGET_EXCEEDED',
    'TOKEN_BUDGET',
    'STEP_BUDGET',
    'STEP_BUDGET_EXHAUSTED',
    'COST_BUDGET',
    'TASK_DEADLINE',
  ]),
);

export const BUDGET_SCOPE_CONTRACT = Object.freeze({
  scopes: Object.values(BUDGET_SCOPES),
  guaranteeBoundary:
    'Pre-inference input token estimate + atomic SQLite reservation + controllable maxOutputTokens clamp + post-inference actual usage settlement with estimationError/overage tracking (external provider exact billing cannot be known pre-call).',
});

export function isBudgetErrorCode(code) {
  return BUDGET_ERROR_CODES.has(String(code || ''));
}

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Explicit 0 => 0 (exhausted, NEVER unlimited!).
 * null / undefined / '' / NaN => null (unset / unlimited).
 */
export function normalizeBudgetLimit(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

/**
 * Returns the tighter of two optional limits without ever widening a defined limit
 * (including preserving explicit 0).
 */
export function minDefinedLimit(a, b) {
  const na = normalizeBudgetLimit(a);
  const nb = normalizeBudgetLimit(b);
  if (na === null) return nb;
  if (nb === null) return na;
  return Math.min(na, nb);
}

export function normalizeTreeBudget(raw = {}) {
  if (!raw || typeof raw !== 'object') {
    return {
      maxTotalSteps: null,
      maxTotalTokens: null,
      maxOutputTokens: null,
      maxDurationMs: null,
    };
  }
  return {
    maxTotalSteps: minDefinedLimit(raw.maxTotalSteps, raw.maxSteps),
    maxTotalTokens: minDefinedLimit(raw.maxTotalTokens, raw.maxTokens),
    maxOutputTokens: normalizeBudgetLimit(raw.maxOutputTokens),
    maxDurationMs: normalizeBudgetLimit(raw.maxDurationMs),
  };
}

export function normalizeNodeBudget(raw = {}) {
  if (!raw || typeof raw !== 'object') {
    return {
      maxSteps: null,
      maxTokens: null,
      maxOutputTokens: null,
      maxDurationMs: null,
      finalVerificationReserve: null,
    };
  }
  return {
    maxSteps: minDefinedLimit(raw.maxSteps, raw.maxTotalSteps),
    maxTokens: minDefinedLimit(raw.maxTokens, raw.maxTotalTokens),
    maxOutputTokens: normalizeBudgetLimit(raw.maxOutputTokens),
    maxDurationMs: normalizeBudgetLimit(raw.maxDurationMs),
    finalVerificationReserve: normalizeBudgetLimit(raw.finalVerificationReserve),
  };
}

/**
 * Computes effective per-node caps as `min(nodeCap, treeRemaining)` without ever
 * widening a tighter node cap or turning explicit 0 into unlimited/1.
 */
export function computeEffectiveNodeBudget(nodeBudgetRaw = {}, treeSnapshot = null, treeBudgetRaw = {}) {
  const nb = normalizeNodeBudget(nodeBudgetRaw);
  const tb = normalizeTreeBudget(treeBudgetRaw);
  const treeRemSteps =
    treeSnapshot && treeSnapshot.maxTotalSteps !== null
      ? treeSnapshot.remainingSteps
      : tb.maxTotalSteps;
  const treeRemTokens =
    treeSnapshot && treeSnapshot.maxTotalTokens !== null
      ? treeSnapshot.remainingTokens
      : tb.maxTotalTokens;
  const treeMaxOut =
    treeSnapshot && treeSnapshot.maxOutputTokens !== null
      ? treeSnapshot.maxOutputTokens
      : tb.maxOutputTokens;

  const effMaxSteps = minDefinedLimit(nb.maxSteps, treeRemSteps);
  const effReserve =
    nb.finalVerificationReserve !== null && effMaxSteps !== null
      ? Math.min(nb.finalVerificationReserve, Math.max(0, effMaxSteps - 1))
      : nb.finalVerificationReserve;

  return {
    maxSteps: effMaxSteps,
    maxTokens: minDefinedLimit(nb.maxTokens, treeRemTokens),
    maxOutputTokens: minDefinedLimit(nb.maxOutputTokens, treeMaxOut),
    maxDurationMs: minDefinedLimit(nb.maxDurationMs, tb.maxDurationMs),
    ...(effReserve !== null ? { finalVerificationReserve: effReserve } : {}),
  };
}

export function estimateRequestInputTokens(requestOptions) {
  if (!requestOptions || typeof requestOptions !== 'object') return 0;
  return Math.max(0, Math.ceil(Number(measureRequestComposition(requestOptions)?.totalTokens ?? 0)));
}

function hydrateLedgerRow(row) {
  if (!row) return null;
  const maxTotalSteps = normalizeBudgetLimit(row.maxTotalSteps);
  const maxTotalTokens = normalizeBudgetLimit(row.maxTotalTokens);
  const maxOutputTokens = normalizeBudgetLimit(row.maxOutputTokens);
  const usedSteps = Number(row.usedSteps ?? 0);
  const usedInputTokens = Number(row.usedInputTokens ?? 0);
  const usedOutputTokens = Number(row.usedOutputTokens ?? 0);
  const usedTotalTokens = usedInputTokens + usedOutputTokens;
  const reservedSteps = Number(row.reservedSteps ?? 0);
  const reservedTokens = Number(row.reservedTokens ?? 0);
  const committedSteps = usedSteps + reservedSteps;
  const committedTokens = usedTotalTokens + reservedTokens;
  const remainingSteps =
    maxTotalSteps === null ? null : Math.max(0, maxTotalSteps - committedSteps);
  const remainingTokens =
    maxTotalTokens === null ? null : Math.max(0, maxTotalTokens - committedTokens);
  const isStepExhausted = maxTotalSteps !== null && remainingSteps <= 0;
  const isTokenExhausted =
    (maxTotalTokens !== null && remainingTokens <= 0) ||
    (maxOutputTokens !== null && maxOutputTokens <= 0);
  const isPermanentlyExhausted =
    Boolean(row.exhausted) ||
    (maxTotalSteps !== null && (maxTotalSteps === 0 || usedSteps >= maxTotalSteps)) ||
    (maxTotalTokens !== null && (maxTotalTokens === 0 || usedTotalTokens >= maxTotalTokens)) ||
    (maxOutputTokens !== null && maxOutputTokens === 0);

  return {
    treeId: row.treeId,
    rootSessionId: row.rootSessionId ?? null,
    maxTotalSteps,
    maxTotalTokens,
    maxOutputTokens,
    usedSteps,
    usedInputTokens,
    usedOutputTokens,
    usedTotalTokens,
    reservedSteps,
    reservedTokens,
    committedSteps,
    committedTokens,
    remainingSteps,
    remainingTokens,
    estimationErrorTokens: Number(row.estimationErrorTokens ?? 0),
    overageSteps: Number(row.overageSteps ?? 0),
    overageTokens: Number(row.overageTokens ?? 0),
    exhausted: Boolean(row.exhausted),
    exhaustedReason: row.exhaustedReason ?? null,
    isStepExhausted,
    isTokenExhausted,
    isExhausted: isPermanentlyExhausted || isStepExhausted || isTokenExhausted,
    isPermanentlyExhausted,
    trafficSource: row.trafficSource ?? 'production',
    isSynthetic: Boolean(row.isSynthetic),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Atomic SQLite Task-Tree Budget Ledger.
 * Serializes admission, reservation, settlement, unused-balance release,
 * and restart orphan reconciliation via synchronous `store.tx()` (`BEGIN IMMEDIATE`).
 */
export class TaskTreeBudgetLedger {
  constructor(store) {
    this.store = store;
  }

  #dbReady() {
    return Boolean(this.store?.db?.isOpen);
  }

  ensureLedger({
    treeId,
    rootSessionId = null,
    budget = {},
    initialUsage = null,
    trafficSource = 'production',
    isSynthetic = 0,
  } = {}) {
    if (!treeId || !this.#dbReady()) return null;
    const limits = normalizeTreeBudget(budget);
    return this.store.tx(() => {
      const existing = this.store.db
        .prepare('SELECT * FROM budget_ledgers WHERE treeId=?')
        .get(treeId);
      if (existing) {
        return hydrateLedgerRow(existing);
      }
      const now = Date.now();
      const usedSteps = Math.max(0, Math.floor(Number(initialUsage?.steps ?? 0)));
      const usedInputTokens = Math.max(0, Math.floor(Number(initialUsage?.inputTokens ?? 0)));
      const usedOutputTokens = Math.max(0, Math.floor(Number(initialUsage?.outputTokens ?? 0)));
      const usedTotal = usedInputTokens + usedOutputTokens;
      const overageSteps =
        limits.maxTotalSteps !== null ? Math.max(0, usedSteps - limits.maxTotalSteps) : 0;
      const overageTokens =
        limits.maxTotalTokens !== null ? Math.max(0, usedTotal - limits.maxTotalTokens) : 0;

      let exhausted = 0;
      let exhaustedReason = null;
      if (limits.maxTotalSteps !== null && (limits.maxTotalSteps === 0 || usedSteps >= limits.maxTotalSteps)) {
        exhausted = 1;
        exhaustedReason = 'STEP_BUDGET';
      } else if (
        (limits.maxTotalTokens !== null && (limits.maxTotalTokens === 0 || usedTotal >= limits.maxTotalTokens)) ||
        (limits.maxOutputTokens !== null && limits.maxOutputTokens === 0)
      ) {
        exhausted = 1;
        exhaustedReason = 'TOKEN_BUDGET';
      }

      this.store.db
        .prepare(
          `INSERT INTO budget_ledgers(
            treeId, rootSessionId, maxTotalSteps, maxTotalTokens, maxOutputTokens,
            usedSteps, usedInputTokens, usedOutputTokens,
            reservedSteps, reservedTokens, estimationErrorTokens,
            overageSteps, overageTokens, exhausted, exhaustedReason,
            trafficSource, isSynthetic, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,?,?,0,0,0,?,?,?,?,?,?,?,?)`,
        )
        .run(
          treeId,
          rootSessionId,
          limits.maxTotalSteps,
          limits.maxTotalTokens,
          limits.maxOutputTokens,
          usedSteps,
          usedInputTokens,
          usedOutputTokens,
          overageSteps,
          overageTokens,
          exhausted,
          exhaustedReason,
          String(trafficSource || 'interactive'),
          isSynthetic ? 1 : 0,
          now,
          now,
        );
      return hydrateLedgerRow(
        this.store.db.prepare('SELECT * FROM budget_ledgers WHERE treeId=?').get(treeId),
      );
    });
  }

  getSnapshot(treeId) {
    if (!treeId || !this.#dbReady()) return null;
    const row = this.store.db
      .prepare('SELECT * FROM budget_ledgers WHERE treeId=?')
      .get(treeId);
    return hydrateLedgerRow(row);
  }

  listReservations(treeId, { status = null } = {}) {
    if (!treeId || !this.#dbReady()) return [];
    if (status) {
      return this.store.db
        .prepare('SELECT * FROM budget_reservations WHERE treeId=? AND status=? ORDER BY createdAt ASC')
        .all(treeId, status);
    }
    return this.store.db
      .prepare('SELECT * FROM budget_reservations WHERE treeId=? ORDER BY createdAt ASC')
      .all(treeId);
  }

  isExhausted(treeId) {
    const snap = this.getSnapshot(treeId);
    return Boolean(snap?.isExhausted);
  }

  isPermanentlyExhausted(treeId) {
    const snap = this.getSnapshot(treeId);
    return Boolean(snap?.isPermanentlyExhausted);
  }

  /**
   * Atomically checks admission and reserves 1 step + pre-estimated input tokens +
   * constrained maxOutputTokens against the shared SQLite task-tree budget.
   */
  reserveInference({
    treeId,
    scope = BUDGET_SCOPES.NODE_EXECUTION,
    nodeId = null,
    nodeKey = null,
    sessionId = null,
    turnId = null,
    attempt = 1,
    jobId = null,
    fence = null,
    estimatedInputTokens = 0,
    requestedMaxOutputTokens = null,
    nodeBudget = null,
    nodeUsedSteps = 0,
    nodeUsedTokens = 0,
    defaultMaxOutputTokens = 4096,
    leaseGuard = null,
  }) {
    if (!treeId || !this.#dbReady()) {
      const reqOut = normalizeBudgetLimit(requestedMaxOutputTokens);
      return {
        admitted: true,
        reservationId: null,
        treeId: treeId || null,
        scope,
        estimatedInputTokens: Math.max(0, Math.ceil(Number(estimatedInputTokens || 0))),
        constrainedMaxOutputTokens: reqOut !== null ? reqOut : defaultMaxOutputTokens,
        reservedTotalTokens: 0,
      };
    }

    const nb = normalizeNodeBudget(nodeBudget ?? {});
    const estIn = Math.max(0, Math.ceil(Number(estimatedInputTokens || 0)));
    const reqMaxOut = normalizeBudgetLimit(requestedMaxOutputTokens);
    const now = Date.now();
    const effectiveJobId = jobId ?? leaseGuard?.jobId ?? null;
    const effectiveFence = fence ?? leaseGuard?.fence ?? null;

    const outcome = this.store.tx(() => {
      assertLeaseInTx(leaseGuard);
      const row = this.store.db
        .prepare('SELECT * FROM budget_ledgers WHERE treeId=?')
        .get(treeId);
      if (!row) {
        const effOut = minDefinedLimit(nb.maxOutputTokens, reqMaxOut);
        const finalOut = effOut !== null ? effOut : defaultMaxOutputTokens;
        if (finalOut === 0) {
          return {
            admitted: false,
            errorCode: 'TOKEN_BUDGET',
            message: 'Output token budget is explicitly 0 (exhausted)',
            detail: { treeId, scope, maxOutputTokens: 0 },
          };
        }
        return {
          admitted: true,
          reservationId: null,
          treeId,
          scope,
          estimatedInputTokens: estIn,
          constrainedMaxOutputTokens: finalOut,
          reservedTotalTokens: 0,
        };
      }

      const maxTotalSteps = normalizeBudgetLimit(row.maxTotalSteps);
      const maxTotalTokens = normalizeBudgetLimit(row.maxTotalTokens);
      const treeMaxOutput = normalizeBudgetLimit(row.maxOutputTokens);
      const usedSteps = Number(row.usedSteps ?? 0);
      const usedTokens = Number(row.usedInputTokens ?? 0) + Number(row.usedOutputTokens ?? 0);
      const reservedSteps = Number(row.reservedSteps ?? 0);
      const reservedTokens = Number(row.reservedTokens ?? 0);

      // 1. Per-node step cap check (never widened by tree remaining)
      if (nb.maxSteps !== null && (nb.maxSteps === 0 || Number(nodeUsedSteps || 0) + 1 > nb.maxSteps)) {
        return {
          admitted: false,
          errorCode: 'STEP_BUDGET',
          message: `Node step budget reached (${nodeUsedSteps}/${nb.maxSteps})`,
          detail: { treeId, scope, nodeKey, nodeMaxSteps: nb.maxSteps, nodeUsedSteps },
        };
      }

      // 2. Tree step cap check (atomic admission across parallel nodes)
      if (maxTotalSteps !== null) {
        const committedSteps = usedSteps + reservedSteps;
        if (maxTotalSteps === 0 || committedSteps + 1 > maxTotalSteps) {
          if (maxTotalSteps === 0 || usedSteps >= maxTotalSteps) {
            this.store.db
              .prepare("UPDATE budget_ledgers SET exhausted=1, exhaustedReason='STEP_BUDGET', updatedAt=? WHERE treeId=?")
              .run(now, treeId);
          }
          return {
            admitted: false,
            errorCode: 'STEP_BUDGET',
            message: `Task-tree step budget exhausted (used=${usedSteps}, reserved=${reservedSteps}, limit=${maxTotalSteps})`,
            detail: {
              treeId,
              scope,
              maxTotalSteps,
              usedSteps,
              reservedSteps,
              remainingSteps: Math.max(0, maxTotalSteps - committedSteps),
            },
          };
        }
      }

      // 3. Controllable maxOutputTokens baseline
      let constrainedMaxOutput = minDefinedLimit(
        minDefinedLimit(nb.maxOutputTokens, treeMaxOutput),
        reqMaxOut,
      );
      if (constrainedMaxOutput === null) {
        constrainedMaxOutput = Math.max(1, Math.floor(Number(defaultMaxOutputTokens || 4096)));
      }
      if (constrainedMaxOutput === 0) {
        if (treeMaxOutput === 0) {
          this.store.db
            .prepare("UPDATE budget_ledgers SET exhausted=1, exhaustedReason='TOKEN_BUDGET', updatedAt=? WHERE treeId=?")
            .run(now, treeId);
        }
        return {
          admitted: false,
          errorCode: 'TOKEN_BUDGET',
          message: 'Output token budget is explicitly 0 (exhausted)',
          detail: { treeId, scope, maxOutputTokens: 0 },
        };
      }

      // 4. Tree token cap check + pre-inference input admission + maxOutputTokens clamping
      if (maxTotalTokens !== null) {
        const committedTokens = usedTokens + reservedTokens;
        const availableTokens = Math.max(0, maxTotalTokens - committedTokens);
        if (maxTotalTokens === 0 || availableTokens <= 0) {
          if (maxTotalTokens === 0 || usedTokens >= maxTotalTokens) {
            this.store.db
              .prepare("UPDATE budget_ledgers SET exhausted=1, exhaustedReason='TOKEN_BUDGET', updatedAt=? WHERE treeId=?")
              .run(now, treeId);
          }
          return {
            admitted: false,
            errorCode: 'TOKEN_BUDGET',
            message: `Task-tree token budget exhausted (used=${usedTokens}, reserved=${reservedTokens}, limit=${maxTotalTokens})`,
            detail: { treeId, scope, maxTotalTokens, usedTokens, reservedTokens, availableTokens: 0 },
          };
        }
        if (estIn >= availableTokens) {
          // Reject this oversized prompt without permanently marking the entire tree exhausted
          // so smaller sibling prompts can still consume the remaining tree tokens.
          return {
            admitted: false,
            errorCode: 'TOKEN_BUDGET',
            message: `Pre-inference input estimate (${estIn}) exceeds available task-tree token budget (${availableTokens})`,
            detail: {
              treeId,
              scope,
              estimatedInputTokens: estIn,
              availableTokens,
              maxTotalTokens,
              usedTokens,
              reservedTokens,
            },
          };
        }
        constrainedMaxOutput = Math.min(constrainedMaxOutput, Math.max(1, availableTokens - estIn));
      }

      // 5. Per-node token cap check (never widened by tree remaining)
      if (nb.maxTokens !== null) {
        const nodeAvailable = Math.max(0, nb.maxTokens - Number(nodeUsedTokens || 0));
        if (nb.maxTokens === 0 || nodeAvailable <= 0 || estIn >= nodeAvailable) {
          return {
            admitted: false,
            errorCode: 'TOKEN_BUDGET',
            message: `Node token budget exhausted (estimatedInput=${estIn}, nodeAvailable=${nodeAvailable}, limit=${nb.maxTokens})`,
            detail: { treeId, scope, nodeKey, estimatedInputTokens: estIn, nodeAvailable, nodeMaxTokens: nb.maxTokens },
          };
        }
        constrainedMaxOutput = Math.min(constrainedMaxOutput, Math.max(1, nodeAvailable - estIn));
      }

      const reservationId = uuid();
      const reservedTotalTokens = estIn + constrainedMaxOutput;
      this.store.db
        .prepare(
          `INSERT INTO budget_reservations(
            id, treeId, scope, nodeId, nodeKey, sessionId, turnId, attempt, jobId, fence,
            status, reservedSteps, estimatedInputTokens, reservedOutputTokens, reservedTotalTokens,
            actualSteps, actualInputTokens, actualOutputTokens, estimationErrorTokens, overageTokens,
            createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',1,?,?,?,0,0,0,0,0,?,?)`,
        )
        .run(
          reservationId,
          treeId,
          scope,
          nodeId,
          nodeKey,
          sessionId,
          turnId,
          Math.max(1, Math.floor(Number(attempt || 1))),
          effectiveJobId,
          effectiveFence,
          estIn,
          constrainedMaxOutput,
          reservedTotalTokens,
          now,
          now,
        );

      this.store.db
        .prepare(
          `UPDATE budget_ledgers
           SET reservedSteps = reservedSteps + 1,
               reservedTokens = reservedTokens + ?,
               updatedAt = ?
           WHERE treeId = ?`,
        )
        .run(reservedTotalTokens, now, treeId);

      this.#syncSwarmRunUsageTx(treeId, now);

      return {
        admitted: true,
        reservationId,
        treeId,
        scope,
        estimatedInputTokens: estIn,
        constrainedMaxOutputTokens: constrainedMaxOutput,
        reservedTotalTokens,
      };
    });

    if (!outcome.admitted) {
      throw new BudgetError(outcome.errorCode || 'BUDGET_EXCEEDED', {
        message: outcome.message || 'Budget exceeded',
        detail: outcome.detail,
      });
    }
    return outcome;
  }

  /**
   * Atomically settles a reservation with actual provider usage (or failed-attempt usage),
   * releasing unused reserved balance back to the shared task-tree budget and recording
   * estimationError & overage.
   */
  settleReservation(
    reservationId,
    {
      status = 'settled',
      actualSteps = 1,
      actualInputTokens = 0,
      actualOutputTokens = 0,
      errorCode = null,
      leaseGuard = null,
    } = {},
  ) {
    if (!reservationId || !this.#dbReady()) return null;
    const actSteps = Math.max(0, Math.floor(Number(actualSteps ?? 1)));
    const actIn = Math.max(0, Math.floor(Number(actualInputTokens ?? 0)));
    const actOut = Math.max(0, Math.floor(Number(actualOutputTokens ?? 0)));
    const now = Date.now();

    return this.store.tx(() => {
      assertLeaseInTx(leaseGuard);
      const res = this.store.db
        .prepare('SELECT * FROM budget_reservations WHERE id=?')
        .get(reservationId);
      if (!res || res.status !== 'reserved') {
        return res ? this.getSnapshot(res.treeId) : null;
      }

      const ledger = this.store.db
        .prepare('SELECT * FROM budget_ledgers WHERE treeId=?')
        .get(res.treeId);
      if (!ledger) return null;

      const maxTotalSteps = normalizeBudgetLimit(ledger.maxTotalSteps);
      const maxTotalTokens = normalizeBudgetLimit(ledger.maxTotalTokens);
      const prevUsedTokens =
        Number(ledger.usedInputTokens ?? 0) + Number(ledger.usedOutputTokens ?? 0);
      const prevOverageTokens =
        maxTotalTokens !== null ? Math.max(0, prevUsedTokens - maxTotalTokens) : 0;

      const nextUsedSteps = Number(ledger.usedSteps ?? 0) + actSteps;
      const nextUsedIn = Number(ledger.usedInputTokens ?? 0) + actIn;
      const nextUsedOut = Number(ledger.usedOutputTokens ?? 0) + actOut;
      const nextUsedTokens = nextUsedIn + nextUsedOut;
      const nextReservedSteps = Math.max(0, Number(ledger.reservedSteps ?? 0) - Number(res.reservedSteps ?? 1));
      const nextReservedTokens = Math.max(
        0,
        Number(ledger.reservedTokens ?? 0) - Number(res.reservedTotalTokens ?? 0),
      );

      // Signed input estimation error when provider reported usage (actualInput - estimatedInput)
      const hasReportedUsage = actIn > 0 || actOut > 0;
      const estError = hasReportedUsage ? actIn - Number(res.estimatedInputTokens ?? 0) : 0;
      const nextOverSteps =
        maxTotalSteps !== null ? Math.max(0, nextUsedSteps - maxTotalSteps) : 0;
      const nextOverTokens =
        maxTotalTokens !== null ? Math.max(0, nextUsedTokens - maxTotalTokens) : 0;
      const deltaOverageTokens = Math.max(0, nextOverTokens - prevOverageTokens);

      let exhausted = Number(ledger.exhausted ?? 0);
      let exhaustedReason = ledger.exhaustedReason ?? null;
      if (maxTotalSteps !== null && nextUsedSteps >= maxTotalSteps) {
        exhausted = 1;
        exhaustedReason = exhaustedReason || 'STEP_BUDGET';
      } else if (maxTotalTokens !== null && nextUsedTokens >= maxTotalTokens) {
        exhausted = 1;
        exhaustedReason = exhaustedReason || 'TOKEN_BUDGET';
      }

      const updRes = this.store.db
        .prepare(
          `UPDATE budget_reservations
           SET status=?, actualSteps=?, actualInputTokens=?, actualOutputTokens=?,
               estimationErrorTokens=?, overageTokens=?, errorCode=?, settledAt=?, updatedAt=?
           WHERE id=? AND status='reserved'`,
        )
        .run(
          status,
          actSteps,
          actIn,
          actOut,
          estError,
          deltaOverageTokens,
          errorCode ? String(errorCode) : null,
          now,
          now,
          reservationId,
        );
      if (!updRes.changes) {
        return this.getSnapshot(res.treeId);
      }

      this.store.db
        .prepare(
          `UPDATE budget_ledgers
           SET usedSteps=?, usedInputTokens=?, usedOutputTokens=?,
               reservedSteps=?, reservedTokens=?,
               estimationErrorTokens = estimationErrorTokens + ?,
               overageSteps=?, overageTokens=?,
               exhausted=?, exhaustedReason=?, updatedAt=?
           WHERE treeId=?`,
        )
        .run(
          nextUsedSteps,
          nextUsedIn,
          nextUsedOut,
          nextReservedSteps,
          nextReservedTokens,
          estError,
          nextOverSteps,
          nextOverTokens,
          exhausted,
          exhaustedReason,
          now,
          res.treeId,
        );

      this.#syncSwarmRunUsageTx(res.treeId, now);
      return hydrateLedgerRow(
        this.store.db.prepare('SELECT * FROM budget_ledgers WHERE treeId=?').get(res.treeId),
      );
    });
  }

  /**
   * Releases a reservation that was aborted BEFORE invoking the provider (0 steps/tokens consumed).
   */
  releaseReservation(reservationId, { reason = 'released_before_inference' } = {}) {
    return this.settleReservation(reservationId, {
      status: 'released',
      actualSteps: 0,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      errorCode: reason,
    });
  }

  /**
   * Checks whether an in-flight `'reserved'` row belongs to a live worker with an active,
   * non-expired lease (via Group 2's `classifyJobOwnership` & `runtime_workers`).
   * Protects Runtime A's active reservations when Runtime B joins the shared SQLite DB,
   * while rejecting stale-attempt/fence reservations even if a newer attempt is now live on the same node.
   */
  #isReservationOwnedByLiveWorker(res, now) {
    // 0. Exact (jobId, fence) ownership check when recorded (prevents stale attempt misattribution!)
    if (res.jobId) {
      const boundJob = this.store.db.prepare('SELECT * FROM runtime_jobs WHERE id=?').get(res.jobId);
      if (!boundJob || boundJob.status !== 'active') {
        return false;
      }
      if (
        res.fence !== null &&
        res.fence !== undefined &&
        String(boundJob.fence ?? '') !== String(res.fence)
      ) {
        return false;
      }
      return Boolean(classifyJobOwnership(this.store, boundJob, { now }).liveOwner);
    }

    // 1. Check active job bound directly to swarm_nodes(nodeId / treeId+nodeKey)
    if (res.nodeId || (res.treeId && res.nodeKey)) {
      const nodeRow = res.nodeId
        ? this.store.db
            .prepare('SELECT activeJobId, jobId, activeFence, activeAttempt FROM swarm_nodes WHERE id=?')
            .get(res.nodeId)
        : this.store.db
            .prepare('SELECT activeJobId, jobId, activeFence, activeAttempt FROM swarm_nodes WHERE runId=? AND nodeKey=?')
            .get(res.treeId, res.nodeKey);
      if (
        nodeRow &&
        Number(nodeRow.activeAttempt ?? 0) > 0 &&
        res.attempt &&
        Number(res.attempt) !== Number(nodeRow.activeAttempt)
      ) {
        return false;
      }
      if (
        nodeRow &&
        res.fence !== null &&
        res.fence !== undefined &&
        nodeRow.activeFence !== null &&
        nodeRow.activeFence !== undefined &&
        String(res.fence) !== String(nodeRow.activeFence)
      ) {
        return false;
      }
      const jobId = nodeRow?.activeJobId || nodeRow?.jobId || null;
      if (jobId) {
        const job = this.store.db.prepare('SELECT * FROM runtime_jobs WHERE id=?').get(jobId);
        if (job && job.status === 'active' && classifyJobOwnership(this.store, job, { now }).liveOwner) {
          return true;
        }
      }
    }

    // 2. Check active runtime_jobs matching turnId (or direct_turn sessionId when not node-scoped)
    if (res.turnId) {
      const turnJobs = this.store.db
        .prepare("SELECT * FROM runtime_jobs WHERE status='active' AND turnId=?")
        .all(res.turnId);
      for (const job of turnJobs) {
        if (
          res.fence !== null &&
          res.fence !== undefined &&
          String(job.fence ?? '') !== String(res.fence)
        ) {
          continue;
        }
        if (classifyJobOwnership(this.store, job, { now }).liveOwner) return true;
      }
    }
    if (res.sessionId && !res.nodeId && !res.nodeKey) {
      const sessJobs = this.store.db
        .prepare("SELECT * FROM runtime_jobs WHERE status='active' AND sessionId=?")
        .all(res.sessionId);
      for (const job of sessJobs) {
        if (classifyJobOwnership(this.store, job, { now }).liveOwner) return true;
      }
    }

    // 3. Check active swarm jobs targeting this treeId (matching nodeId/nodeKey when node-scoped)
    if (res.treeId) {
      const treeJobs = this.store.db
        .prepare("SELECT * FROM runtime_jobs WHERE status='active' AND taskId=?")
        .all(res.treeId);
      for (const job of treeJobs) {
        if (!classifyJobOwnership(this.store, job, { now }).liveOwner) continue;
        if (
          res.fence !== null &&
          res.fence !== undefined &&
          String(job.fence ?? '') !== String(res.fence)
        ) {
          continue;
        }
        if (!res.nodeId && !res.nodeKey) return true;
        const payload = parseJsonSafe(job.payload, {});
        if (
          (res.nodeId && payload.nodeId === res.nodeId) ||
          (res.nodeKey && payload.nodeKey === res.nodeKey)
        ) {
          return true;
        }
      }
    }

    return false;
  }

  #reconcileReservationRowTx(res, now, reason) {
    const ledger = this.store.db
      .prepare('SELECT * FROM budget_ledgers WHERE treeId=?')
      .get(res.treeId);
    if (!ledger) return null;

    const actSteps = Math.max(0, Number(res.reservedSteps ?? 1));
    const actIn = Math.max(0, Number(res.estimatedInputTokens ?? 0));
    const actOut = 0;
    const releasedOut = Math.max(0, Number(res.reservedOutputTokens ?? 0));

    const maxTotalSteps = normalizeBudgetLimit(ledger.maxTotalSteps);
    const maxTotalTokens = normalizeBudgetLimit(ledger.maxTotalTokens);
    const nextUsedSteps = Number(ledger.usedSteps ?? 0) + actSteps;
    const nextUsedIn = Number(ledger.usedInputTokens ?? 0) + actIn;
    const nextUsedOut = Number(ledger.usedOutputTokens ?? 0) + actOut;
    const nextUsedTokens = nextUsedIn + nextUsedOut;
    const nextReservedSteps = Math.max(0, Number(ledger.reservedSteps ?? 0) - actSteps);
    const nextReservedTokens = Math.max(
      0,
      Number(ledger.reservedTokens ?? 0) - Number(res.reservedTotalTokens ?? 0),
    );
    const nextOverSteps =
      maxTotalSteps !== null ? Math.max(0, nextUsedSteps - maxTotalSteps) : 0;
    const nextOverTokens =
      maxTotalTokens !== null ? Math.max(0, nextUsedTokens - maxTotalTokens) : 0;

    let exhausted = Number(ledger.exhausted ?? 0);
    let exhaustedReason = ledger.exhaustedReason ?? null;
    if (maxTotalSteps !== null && nextUsedSteps >= maxTotalSteps) {
      exhausted = 1;
      exhaustedReason = exhaustedReason || 'STEP_BUDGET';
    } else if (maxTotalTokens !== null && nextUsedTokens >= maxTotalTokens) {
      exhausted = 1;
      exhaustedReason = exhaustedReason || 'TOKEN_BUDGET';
    }

    const upd = this.store.db
      .prepare(
        `UPDATE budget_reservations
         SET status='reconciled', actualSteps=?, actualInputTokens=?, actualOutputTokens=?,
             errorCode=?, settledAt=?, updatedAt=?
         WHERE id=? AND status='reserved'`,
      )
      .run(actSteps, actIn, actOut, reason, now, now, res.id);
    if (!upd.changes) return null;

    this.store.db
      .prepare(
        `UPDATE budget_ledgers
         SET usedSteps=?, usedInputTokens=?, usedOutputTokens=?,
             reservedSteps=?, reservedTokens=?,
             overageSteps=?, overageTokens=?,
             exhausted=?, exhaustedReason=?, updatedAt=?
         WHERE treeId=?`,
      )
      .run(
        nextUsedSteps,
        nextUsedIn,
        nextUsedOut,
        nextReservedSteps,
        nextReservedTokens,
        nextOverSteps,
        nextOverTokens,
        exhausted,
        exhaustedReason,
        now,
        res.treeId,
      );

    return { actSteps, actIn, releasedOut };
  }

  /**
   * Reconciles any leaked `'reserved'` rows left by a prior attempt/fence of the SAME node
   * right before a new attempt begins executing under `(activeJobId, activeFence)`.
   */
  reconcileStaleNodeReservations({
    treeId,
    nodeId = null,
    nodeKey = null,
    activeJobId = null,
    activeFence = null,
    reason = 'STALE_ATTEMPT_RESERVATION_RECONCILED',
  } = {}) {
    const report = {
      reconciledCount: 0,
      committedOrphanSteps: 0,
      committedOrphanInputTokens: 0,
      releasedOutputTokens: 0,
    };
    if (!treeId || (!nodeId && !nodeKey) || !this.#dbReady()) return report;
    const now = Date.now();
    this.store.tx(() => {
      const rows = nodeId
        ? this.store.db
            .prepare(
              "SELECT * FROM budget_reservations WHERE treeId=? AND nodeId=? AND status='reserved' ORDER BY createdAt ASC",
            )
            .all(treeId, nodeId)
        : this.store.db
            .prepare(
              "SELECT * FROM budget_reservations WHERE treeId=? AND nodeKey=? AND status='reserved' ORDER BY createdAt ASC",
            )
            .all(treeId, nodeKey);
      let touched = false;
      for (const res of rows) {
        const matchesCurrent =
          activeJobId &&
          res.jobId === activeJobId &&
          (activeFence === null ||
            activeFence === undefined ||
            res.fence === null ||
            res.fence === undefined ||
            Number(res.fence) === Number(activeFence));
        if (matchesCurrent) continue;
        const delta = this.#reconcileReservationRowTx(res, now, reason);
        if (delta) {
          touched = true;
          report.reconciledCount++;
          report.committedOrphanSteps += delta.actSteps;
          report.committedOrphanInputTokens += delta.actIn;
          report.releasedOutputTokens += delta.releasedOut;
        }
      }
      if (touched) {
        this.#syncSwarmRunUsageTx(treeId, now);
      }
    });
    return report;
  }

  /**
   * Restart recovery: reconciles stale/orphaned `'reserved'` reservations left by a crashed
   * or expired worker, while strictly skipping reservations owned by live workers with active
   * non-expired leases. Commits each orphan's step + estimated input tokens (preventing silent
   * budget re-granting) while releasing unused reserved output tokens so remaining budget is not leaked.
   */
  reconcileAfterRestart({
    treeId = null,
    reason = 'ORPHANED_RESERVATION_RECONCILED',
    isLiveReservation = null,
  } = {}) {
    const report = {
      reconciledCount: 0,
      skippedLiveCount: 0,
      reconciledTrees: [],
      committedOrphanSteps: 0,
      committedOrphanInputTokens: 0,
      releasedOutputTokens: 0,
    };
    if (!this.#dbReady()) return report;

    const now = Date.now();
    this.store.tx(() => {
      const orphans = treeId
        ? this.store.db
            .prepare("SELECT * FROM budget_reservations WHERE treeId=? AND status='reserved' ORDER BY createdAt ASC")
            .all(treeId)
        : this.store.db
            .prepare("SELECT * FROM budget_reservations WHERE status='reserved' ORDER BY createdAt ASC")
            .all();

      const touchedTrees = new Set();

      for (const res of orphans) {
        const liveOwned =
          typeof isLiveReservation === 'function'
            ? Boolean(isLiveReservation(res, now))
            : this.#isReservationOwnedByLiveWorker(res, now);
        if (liveOwned) {
          report.skippedLiveCount++;
          continue;
        }
        const delta = this.#reconcileReservationRowTx(res, now, reason);
        if (!delta) continue;

        touchedTrees.add(res.treeId);
        report.reconciledCount++;
        report.committedOrphanSteps += delta.actSteps;
        report.committedOrphanInputTokens += delta.actIn;
        report.releasedOutputTokens += delta.releasedOut;
      }

      // Defensive self-heal: clear any nonzero reserved counters that have no active reservations
      const strayLedgers = treeId
        ? this.store.db
            .prepare(
              'SELECT treeId FROM budget_ledgers WHERE treeId=? AND (reservedSteps > 0 OR reservedTokens > 0)',
            )
            .all(treeId)
        : this.store.db
            .prepare('SELECT treeId FROM budget_ledgers WHERE reservedSteps > 0 OR reservedTokens > 0')
            .all();
      for (const row of strayLedgers) {
        const activeCount = this.store.db
          .prepare("SELECT COUNT(*) AS n FROM budget_reservations WHERE treeId=? AND status='reserved'")
          .get(row.treeId)?.n ?? 0;
        if (activeCount === 0) {
          this.store.db
            .prepare('UPDATE budget_ledgers SET reservedSteps=0, reservedTokens=0, updatedAt=? WHERE treeId=?')
            .run(now, row.treeId);
          touchedTrees.add(row.treeId);
        }
      }

      for (const tid of touchedTrees) {
        this.#syncSwarmRunUsageTx(tid, now);
      }
      report.reconciledTrees = [...touchedTrees];
    });

    return report;
  }

  /**
   * Synchronizes ledger totals into `swarm_runs.usageJson` (for non-terminal runs),
   * optionally incrementing `completedNodes`.
   */
  syncRunUsage(runId, { incrementCompletedNodes = 0 } = {}) {
    if (!runId || !this.#dbReady()) return null;
    return this.store.tx(() => this.#syncSwarmRunUsageTx(runId, Date.now(), { incrementCompletedNodes }));
  }

  #syncSwarmRunUsageTx(runId, now, { incrementCompletedNodes = 0 } = {}) {
    const runRow = this.store.db
      .prepare('SELECT id, status, usageJson FROM swarm_runs WHERE id=?')
      .get(runId);
    if (!runRow || ['completed', 'failed', 'cancelled'].includes(runRow.status)) {
      return null;
    }
    const ledger = this.store.db
      .prepare('SELECT * FROM budget_ledgers WHERE treeId=?')
      .get(runId);
    const cur = parseJsonSafe(runRow.usageJson, {});
      const reconciledTotals = this.store.db
        .prepare(
          `SELECT COALESCE(SUM(actualSteps), 0) AS steps,
                  COALESCE(SUM(actualInputTokens), 0) AS inTok,
                  COALESCE(SUM(actualOutputTokens), 0) AS outTok
           FROM budget_reservations
           WHERE treeId=? AND status='reconciled'`,
        )
        .get(runId);
      const orphanSteps = Number(reconciledTotals?.steps ?? 0);
      const orphanIn = Number(reconciledTotals?.inTok ?? 0);
      const orphanOut = Number(reconciledTotals?.outTok ?? 0);
      const nextUsage = {
        inputTokens: ledger
          ? Math.max(0, Number(ledger.usedInputTokens ?? 0) - orphanIn)
          : Number(cur.inputTokens ?? 0),
        outputTokens: ledger
          ? Math.max(0, Number(ledger.usedOutputTokens ?? 0) - orphanOut)
          : Number(cur.outputTokens ?? 0),
        steps: ledger
          ? Math.max(0, Number(ledger.usedSteps ?? 0) - orphanSteps)
          : Number(cur.steps ?? 0),
        completedNodes: Number(cur.completedNodes ?? 0) + Number(incrementCompletedNodes || 0),
        ...(ledger
          ? {
              reservedSteps: Number(ledger.reservedSteps ?? 0),
              reservedTokens: Number(ledger.reservedTokens ?? 0),
              estimationErrorTokens: Number(ledger.estimationErrorTokens ?? 0),
              overageSteps: Number(ledger.overageSteps ?? 0),
              overageTokens: Number(ledger.overageTokens ?? 0),
            }
          : {}),
      };
    this.store.db
      .prepare('UPDATE swarm_runs SET usageJson=?, updatedAt=? WHERE id=? AND status=?')
      .run(JSON.stringify(nextUsage), now, runId, runRow.status);
    return nextUsage;
  }
}
