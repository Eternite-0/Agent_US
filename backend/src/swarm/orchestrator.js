import { id as uuid } from '../store.js';
import { BudgetError, RuntimeError } from '../kernel/errors.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import {
  classifyFailureKind,
  resolveSwarmOutcome,
  safeIsolateSideEffect,
} from '../kernel/verdict.js';
import {
  assertLeaseInTx,
  checkLeaseHeld,
  isLeaseLostError,
} from '../durable/lease-guard.js';
import {
  BUDGET_SCOPES,
  TaskTreeBudgetLedger,
  computeEffectiveNodeBudget,
  isBudgetErrorCode,
} from './budget-ledger.js';
import { SWARM_JOB_KINDS, enqueueSwarmJob } from './jobs.js';
import {
  SWARM_NODE_STATES,
  SWARM_RUN_STATES,
  isTerminalNodeState,
  isTerminalRunState,
  transitionSwarmNode,
  transitionSwarmRun,
} from './node-state-machine.js';
import {
  applyReconciliationResolution,
  buildSwarmSummary,
  extractArtifactUris,
  hydrateSwarmRun,
  inspectNodeReconciliation,
  parkNodeAndRunForReconciliation,
  parseJsonSafe,
  parseToolAllowJson,
  recoverInterruptedSwarmRuns,
} from './recovery-helpers.js';

/**
 * Layer 6 Durable Job-Driven AdaptiveSwarmOrchestrator:
 * All execution state is persisted in SQLite (`swarm_runs`, `swarm_nodes`, `runtime_jobs`,
 * `swarm_replans`) and driven by `RecoveryWorker` + `DurableJobQueue`.
 */
export class AdaptiveSwarmOrchestrator {
  constructor({
    store,
    jobQueue,
    checkpointStore = null,
    reconciler = null,
    eventRouter,
    planner,
    router,
    childManager,
    artifactManager = null,
    mailbox,
    evidenceVerifier = null,
    modelFeedback = null,
    replanner = null,
    budgetLedger = null,
  }) {
    this.store = store;
    this.jobQueue = jobQueue;
    this.checkpointStore = checkpointStore;
    this.reconciler = reconciler;
    this.eventRouter = eventRouter;
    this.planner = planner;
    this.router = router;
    this.childManager = childManager;
    this.artifactManager = artifactManager;
    this.mailbox = mailbox;
    this.evidenceVerifier = evidenceVerifier;
    this.modelFeedback = modelFeedback;
    this.replanner = replanner;
    this.budgetLedger = budgetLedger ?? (store ? new TaskTreeBudgetLedger(store) : null);
    if (this.replanner && !this.replanner.budgetLedger) {
      this.replanner.budgetLedger = this.budgetLedger;
    }
    if (this.childManager && !this.childManager.budgetLedger) {
      this.childManager.budgetLedger = this.budgetLedger;
    }
    this.waiters = new Map(); // runId -> Set<fn>
    this.activeControllers = new Map(); // runId -> AbortController
  }

  getRun(runId) {
    const run = this.store.db.prepare('SELECT * FROM swarm_runs WHERE id=?').get(runId);
    if (!run) return null;
    const nodes = this.store.db
      .prepare('SELECT * FROM swarm_nodes WHERE runId=? ORDER BY priority DESC, createdAt ASC')
      .all(runId);
    return hydrateSwarmRun(run, nodes);
  }

  listRuns({ sessionId = null, limit = 50 } = {}) {
    const cap = Math.min(200, Math.max(1, Number(limit || 50)));
    const rows = sessionId
      ? this.store.db
          .prepare('SELECT id FROM swarm_runs WHERE sessionId=? ORDER BY createdAt DESC LIMIT ?')
          .all(sessionId, cap)
      : this.store.db
          .prepare('SELECT id FROM swarm_runs ORDER BY createdAt DESC LIMIT ?')
          .all(cap);
    return rows.map((r) => this.getRun(r.id));
  }

  listReplans(runId) {
    return this.store.db
      .prepare('SELECT * FROM swarm_replans WHERE runId=? ORDER BY version ASC, createdAt ASC')
      .all(runId)
      .map((r) => ({ ...r, diff: parseJsonSafe(r.diffJson, {}) }));
  }

  registerOnWorker(recoveryWorker) {
    if (!recoveryWorker?.registerHandler) return;
    recoveryWorker.registerHandler(SWARM_JOB_KINDS.PLAN, (job, ctx) =>
      this.#handlePlan(job, ctx),
    );
    recoveryWorker.registerHandler(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE, (job, ctx) =>
      this.#handleDependencyResolve(job, ctx),
    );
    recoveryWorker.registerHandler(SWARM_JOB_KINDS.DISPATCH, (job, ctx) =>
      this.#handleDispatch(job, ctx),
    );
    recoveryWorker.registerHandler(SWARM_JOB_KINDS.NODE_EXECUTE, (job, ctx) =>
      this.#handleNodeExecute(job, ctx),
    );
    recoveryWorker.registerHandler(SWARM_JOB_KINDS.AGGREGATE, (job, ctx) =>
      this.#handleAggregate(job, ctx),
    );
    recoveryWorker.registerHandler(SWARM_JOB_KINDS.VERIFY, (job, ctx) =>
      this.#handleVerify(job, ctx),
    );
  }

  submitRun({
    sessionId,
    rootTurnId = null,
    goal,
    workspaceRoot = null,
    parentPermissionMode = 'auto-safe',
    maxConcurrency = 3,
    budget = {},
    nodes = null,
    maxReplans = 2,
  }) {
    const runId = uuid();
    const now = Date.now();
    const strategy = {
      maxConcurrency: Math.min(6, Math.max(1, Number(maxConcurrency || 3))),
      maxReplans: Math.max(0, Number(maxReplans ?? 2)),
    };
    const usageTotals = { inputTokens: 0, outputTokens: 0, steps: 0, completedNodes: 0 };
    const hasExplicitNodes = Array.isArray(nodes) && nodes.length > 0;
    const routedSpecs = hasExplicitNodes ? this.#prepareNodeSpecs(nodes, budget) : [];
    const initialStatus = hasExplicitNodes
      ? SWARM_RUN_STATES.RUNNING
      : SWARM_RUN_STATES.PLANNING;

    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO swarm_runs(
            id, sessionId, rootTurnId, goal, status, strategyJson, budgetJson, usageJson,
            workspaceRoot, permissionMode, planVersion, currentPhase, replanCount, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,0,?,?)`,
        )
        .run(
          runId,
          sessionId,
          rootTurnId,
          goal,
          initialStatus,
          JSON.stringify(strategy),
          JSON.stringify(budget ?? {}),
          JSON.stringify(usageTotals),
          workspaceRoot,
          parentPermissionMode,
          initialStatus,
          now,
          now,
        );
      this.budgetLedger?.ensureLedger({
        treeId: runId,
        rootSessionId: sessionId,
        budget: budget ?? {},
      });
      if (routedSpecs.length) {
        this.#insertNodes(runId, routedSpecs, parentPermissionMode, 1, now);
      }
    });

    this.eventRouter?.emitPersisted({
      sessionId,
      turnId: rootTurnId,
      type: RUNTIME_EVENTS.SWARM_RUN_STARTED,
      data: {
        runId,
        goal,
        nodeCount: routedSpecs.length,
        maxConcurrency: strategy.maxConcurrency,
      },
      audit: true,
    });

    if (hasExplicitNodes) {
      enqueueSwarmJob(this.jobQueue, SWARM_JOB_KINDS.DEPENDENCY_RESOLVE, {
        runId,
        sessionId,
        planVersion: 1,
        epoch: 0,
      });
    } else {
      enqueueSwarmJob(this.jobQueue, SWARM_JOB_KINDS.PLAN, {
        runId,
        sessionId,
        goal,
        planVersion: 1,
      });
    }

    const run = this.getRun(runId);
    return { runId, sessionId, status: run.status, run };
  }

  waitForRun(runId, { timeoutMs = 120_000, signal = undefined } = {}) {
    const initial = this.getRun(runId);
    if (!initial) {
      return Promise.reject(new RuntimeError('SWARM_RUN_NOT_FOUND', { detail: { runId } }));
    }
    if (isTerminalRunState(initial.status)) {
      return Promise.resolve(this.#formatRunResult(initial));
    }

    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const set = this.waiters.get(runId);
        set?.delete(onSettled);
        if (set && !set.size) this.waiters.delete(runId);
      };
      const onSettled = (run) => {
        cleanup();
        resolve(this.#formatRunResult(run));
      };
      const onAbort = () => {
        cleanup();
        const cancelled = this.cancelRun(runId);
        if (cancelled && isTerminalRunState(cancelled.status)) {
          resolve(this.#formatRunResult(cancelled));
        } else {
          reject(new Error('Swarm wait aborted'));
        }
      };

      let set = this.waiters.get(runId);
      if (!set) {
        set = new Set();
        this.waiters.set(runId, set);
      }
      set.add(onSettled);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(new RuntimeError('SWARM_WAIT_TIMEOUT', { detail: { runId, timeoutMs } }));
        }, timeoutMs);
        timer.unref?.();
      }

      const recheck = this.getRun(runId);
      if (recheck && isTerminalRunState(recheck.status)) {
        onSettled(recheck);
      }
    });
  }

  async startRun(opts) {
    const submitted = this.submitRun(opts);
    return this.waitForRun(submitted.runId, { signal: opts.signal });
  }

  resumeRun(runId) {
    const run = this.getRun(runId);
    if (!run) {
      throw new RuntimeError('SWARM_RUN_NOT_FOUND', { status: 404, detail: { runId } });
    }
    if (run.status === SWARM_RUN_STATES.CANCELLED) {
      throw new RuntimeError('SWARM_RUN_CANCELLED', {
        status: 409,
        message: 'Cancelled swarm run cannot be resumed',
        detail: { runId },
      });
    }
    if (run.status === SWARM_RUN_STATES.COMPLETED) return run;

    const replacedKeys = this.#getReplacedNodeKeys(runId);
    if (run.status === SWARM_RUN_STATES.FAILED) {
      transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.RUNNING, {
        allowResume: true,
        patch: { currentPhase: 'running', errorCode: null, errorMessage: null },
      });
    }
    for (const n of run.nodes) {
      if (n.status === SWARM_NODE_STATES.FAILED && !replacedKeys.has(n.nodeKey)) {
        transitionSwarmNode(this.store, this.eventRouter, n.id, SWARM_NODE_STATES.READY, {
          sessionId: run.sessionId,
          rootTurnId: run.rootTurnId,
          allowReplanReset: true,
          patch: { errorCode: null, errorMessage: null },
        });
      } else if (
        n.status === SWARM_NODE_STATES.INTERRUPTED ||
        n.status === SWARM_NODE_STATES.PARKED
      ) {
        transitionSwarmNode(this.store, this.eventRouter, n.id, SWARM_NODE_STATES.READY, {
          sessionId: run.sessionId,
          rootTurnId: run.rootTurnId,
        });
      }
    }

    enqueueSwarmJob(
      this.jobQueue,
      SWARM_JOB_KINDS.DEPENDENCY_RESOLVE,
      {
        runId: run.id,
        sessionId: run.sessionId,
        planVersion: run.planVersion || 1,
        epoch: Date.now(),
      },
      { idempotencyKey: `swarm:resolve:${run.id}:resume:${uuid().slice(0, 8)}` },
    );
    return this.getRun(runId);
  }

  cancelRun(runId) {
    const run = this.getRun(runId);
    if (!run) return null;

    this.activeControllers.get(runId)?.abort('swarm_cancelled');
    for (const n of run.nodes) {
      if (n.childSessionId) this.childManager?.cancel?.(n.childSessionId);
    }

    const now = Date.now();
    this.store.tx(() => {
      this.store.db
        .prepare(
          `UPDATE runtime_jobs SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, updatedAt=?
           WHERE taskId=? AND status IN ('pending','active','reconciling','parked')`,
        )
        .run(now, runId);
    });

    for (const n of run.nodes) {
      if (!isTerminalNodeState(n.status)) {
        transitionSwarmNode(this.store, this.eventRouter, n.id, SWARM_NODE_STATES.CANCELLED, {
          sessionId: run.sessionId,
          rootTurnId: run.rootTurnId,
          patch: { errorCode: n.errorCode || 'NODE_CANCELLED' },
        });
      }
    }
    let transitionedToCancelled = false;
    if (!isTerminalRunState(run.status)) {
      const prevRow = this.store.db.prepare('SELECT status FROM swarm_runs WHERE id=?').get(runId);
      if (prevRow && !isTerminalRunState(prevRow.status)) {
        transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.CANCELLED, {
          patch: { currentPhase: 'cancelled' },
        });
        transitionedToCancelled = true;
      }
    }

    const finalRun = this.getRun(runId);
    if (transitionedToCancelled) {
      this.eventRouter?.emitPersisted({
        sessionId: run.sessionId,
        turnId: run.rootTurnId,
        type: RUNTIME_EVENTS.SWARM_RUN_COMPLETED,
        data: { runId, status: SWARM_RUN_STATES.CANCELLED, usage: finalRun.usage },
        audit: true,
      });
    }
    this.#notifyWaiters(finalRun);
    return finalRun;
  }

  recoverInterruptedRuns() {
    return recoverInterruptedSwarmRuns({
      store: this.store,
      jobQueue: this.jobQueue,
      reconciler: this.reconciler,
      artifactManager: this.artifactManager,
      eventRouter: this.eventRouter,
      budgetLedger: this.budgetLedger,
      getRun: (id) => this.getRun(id),
      cancelRun: (id) => this.cancelRun(id),
    });
  }

  handleReconciliationResolved(result) {
    return applyReconciliationResolution({
      store: this.store,
      jobQueue: this.jobQueue,
      eventRouter: this.eventRouter,
      getRun: (id) => this.getRun(id),
      result,
    });
  }

  closeAll() {
    for (const ctrl of this.activeControllers.values()) {
      ctrl.abort('shutdown');
    }
    this.activeControllers.clear();
    if (this.childManager?.shutdown) {
      this.childManager.shutdown();
    } else {
      this.childManager?.cancelAll?.();
    }
    for (const [runId, set] of this.waiters.entries()) {
      for (const resolve of [...set]) {
        const current = this.store?.db?.isOpen ? this.getRun(runId) : null;
        resolve(current || { id: runId, status: 'interrupted', nodes: [], usage: {} });
      }
    }
    this.waiters.clear();
  }

  // ---- Internal Durable Swarm Job Handlers ----

  async #handlePlan(job, { signal, leaseGuard }) {
    const { runId, goal } = job.payload;
    const run = this.getRun(runId);
    if (!run || isTerminalRunState(run.status)) return;

    if (run.nodes.length === 0) {
      this.budgetLedger?.ensureLedger({
        treeId: runId,
        rootSessionId: run.sessionId,
        budget: run.budget,
        initialUsage: run.usage,
      });
      let planned;
      try {
        planned = await this.planner.decompose({
          goal: goal || run.goal,
          signal,
          budgetLedger: this.budgetLedger,
          treeId: runId,
          sessionId: run.sessionId,
        });
      } catch (err) {
        if (err instanceof BudgetError || err?.category === 'budget' || isBudgetErrorCode(err?.code)) {
          transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.FAILED, {
            patch: {
              currentPhase: SWARM_RUN_STATES.FAILED,
              errorCode: 'BUDGET_EXCEEDED',
              errorMessage: String(err?.message ?? 'Planning blocked by task-tree budget'),
            },
          });
          const settled = this.getRun(runId);
          this.eventRouter?.emitPersisted({
            sessionId: run.sessionId,
            turnId: run.rootTurnId,
            type: RUNTIME_EVENTS.SWARM_RUN_COMPLETED,
            data: { runId, status: SWARM_RUN_STATES.FAILED, usage: settled.usage },
            audit: true,
          });
          this.#notifyWaiters(settled);
          return;
        }
        throw err;
      }
      leaseGuard?.();
      this.planner.validateDag(planned);
      const routedSpecs = this.#prepareNodeSpecs(planned, run.budget);
      const now = Date.now();
      this.store.tx(() => {
        this.#insertNodes(
          runId,
          routedSpecs,
          run.permissionMode || 'auto-safe',
          run.planVersion || 1,
          now,
        );
      });
    }

    const fresh = this.getRun(runId);
    if (
      fresh.status === SWARM_RUN_STATES.PLANNING ||
      fresh.status === SWARM_RUN_STATES.PENDING
    ) {
      transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.RUNNING, {
        patch: { currentPhase: 'running' },
      });
    }
    enqueueSwarmJob(
      this.jobQueue,
      SWARM_JOB_KINDS.DEPENDENCY_RESOLVE,
      {
        runId,
        sessionId: run.sessionId,
        planVersion: fresh.planVersion || 1,
        epoch: Date.now(),
      },
      { idempotencyKey: `swarm:resolve:${runId}:planned:${uuid().slice(0, 8)}` },
    );
  }

  #handleDependencyResolve(job, { leaseGuard } = {}) {
    const { runId } = job.payload;
    assertLeaseInTx(leaseGuard, { runId });
    let run = this.getRun(runId);
    if (!run || isTerminalRunState(run.status)) return;

    const parentSess = this.store.db
      .prepare('SELECT state FROM direct_sessions WHERE id=?')
      .get(run.sessionId);
    if (!parentSess || parentSess.state === 'cancelled') {
      this.cancelRun(runId);
      return;
    }

    const ledgerSnap = this.budgetLedger?.ensureLedger({
      treeId: runId,
      rootSessionId: run.sessionId,
      budget: run.budget,
      initialUsage: run.usage,
    });
    const budgetExhausted = Boolean(
      ledgerSnap?.isPermanentlyExhausted ||
        (ledgerSnap?.isStepExhausted && ledgerSnap.reservedSteps === 0) ||
        (ledgerSnap?.isTokenExhausted && ledgerSnap.reservedTokens === 0),
    );
    if (budgetExhausted) {
      for (const n of run.nodes) {
        if (n.status === SWARM_NODE_STATES.PENDING || n.status === SWARM_NODE_STATES.READY) {
          transitionSwarmNode(this.store, this.eventRouter, n.id, SWARM_NODE_STATES.CANCELLED, {
            sessionId: run.sessionId,
            rootTurnId: run.rootTurnId,
            patch: {
              errorCode: 'BUDGET_EXCEEDED',
              errorMessage: ledgerSnap?.exhaustedReason
                ? `Tree budget reached (${ledgerSnap.exhaustedReason})`
                : 'Tree budget reached',
            },
          });
        }
      }
      run = this.getRun(runId);
    }

    // Propagate upstream failures down the DAG until fixpoint
    let changed = true;
    while (changed) {
      changed = false;
      run = this.getRun(runId);
      const byKey = new Map(run.nodes.map((n) => [n.nodeKey, n]));
      for (const n of run.nodes) {
        if (n.status !== SWARM_NODE_STATES.PENDING && n.status !== SWARM_NODE_STATES.READY) continue;
        const failedDeps = n.dependencies.filter((d) =>
          ['failed', 'cancelled'].includes(byKey.get(d)?.status),
        );
        if (failedDeps.length) {
          changed = true;
          transitionSwarmNode(this.store, this.eventRouter, n.id, SWARM_NODE_STATES.FAILED, {
            sessionId: run.sessionId,
            rootTurnId: run.rootTurnId,
            patch: {
              errorCode: 'DEPENDENCY_FAILED',
              errorMessage: `Blocked by upstream node(s): ${failedDeps.join(', ')}`,
            },
          });
        }
      }
    }

    // Promote dependency-satisfied pending nodes -> ready
    run = this.getRun(runId);
    const byKey = new Map(run.nodes.map((n) => [n.nodeKey, n]));
    for (const n of run.nodes) {
      if (
        n.status === SWARM_NODE_STATES.PENDING &&
        n.dependencies.every((d) => byKey.get(d)?.status === SWARM_NODE_STATES.COMPLETED)
      ) {
        transitionSwarmNode(this.store, this.eventRouter, n.id, SWARM_NODE_STATES.READY, {
          sessionId: run.sessionId,
          rootTurnId: run.rootTurnId,
        });
      }
    }

    run = this.getRun(runId);
    const inFlight = run.nodes.filter(
      (n) => n.status === SWARM_NODE_STATES.QUEUED || n.status === SWARM_NODE_STATES.RUNNING,
    ).length;
    const maxConc = Math.max(1, Number(run.strategy?.maxConcurrency ?? 3));
    const readyNodes = run.nodes.filter((n) => n.status === SWARM_NODE_STATES.READY);
    const liveSnap = this.budgetLedger?.getSnapshot(runId);
    const stepSlots =
      liveSnap && liveSnap.remainingSteps !== null ? liveSnap.remainingSteps : maxConc;
    const dispatchSlots = Math.max(0, Math.min(maxConc - inFlight, stepSlots));
    const picked = readyNodes.slice(0, dispatchSlots);

    if (picked.length > 0) {
      for (const n of picked) {
        transitionSwarmNode(this.store, this.eventRouter, n.id, SWARM_NODE_STATES.QUEUED, {
          sessionId: run.sessionId,
          rootTurnId: run.rootTurnId,
        });
      }
      enqueueSwarmJob(
        this.jobQueue,
        SWARM_JOB_KINDS.DISPATCH,
        {
          runId,
          sessionId: run.sessionId,
          nodeKeys: picked.map((n) => n.nodeKey),
          planVersion: run.planVersion || 1,
        },
        {
          idempotencyKey: `swarm:dispatch:${runId}:v${run.planVersion || 1}:${Date.now()}:${uuid().slice(0, 6)}`,
          parentJobId: job.id,
        },
      );
      return;
    }

    const reconciling = run.nodes.filter((n) => n.status === SWARM_NODE_STATES.RECONCILING);
    const stillActive = run.nodes.some((n) =>
      ['pending', 'ready', 'queued', 'running', 'interrupted', 'parked'].includes(n.status),
    );
    if (stillActive) return;

    if (reconciling.length > 0) {
      if (run.status !== SWARM_RUN_STATES.RECONCILING) {
        transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.RECONCILING, {
          patch: { currentPhase: 'reconciling' },
        });
      }
      return;
    }

    if (run.status === SWARM_RUN_STATES.RECONCILING) {
      transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.RUNNING, {
        patch: { currentPhase: 'running' },
      });
    }
    transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.AGGREGATING, {
      patch: { currentPhase: 'aggregating' },
    });
    enqueueSwarmJob(
      this.jobQueue,
      SWARM_JOB_KINDS.AGGREGATE,
      { runId, sessionId: run.sessionId, planVersion: run.planVersion || 1 },
      {
        idempotencyKey: `swarm:agg:${runId}:v${run.planVersion || 1}:${Date.now()}`,
        parentJobId: job.id,
      },
    );
  }

  #handleDispatch(job, { leaseGuard } = {}) {
    const { runId, nodeKeys } = job.payload;
    assertLeaseInTx(leaseGuard, { runId });
    const run = this.getRun(runId);
    if (!run || isTerminalRunState(run.status)) return;

    const byKey = new Map(run.nodes.map((n) => [n.nodeKey, n]));
    for (const key of nodeKeys) {
      const n = byKey.get(key);
      if (!n || n.status !== SWARM_NODE_STATES.QUEUED) continue;
      enqueueSwarmJob(
        this.jobQueue,
        SWARM_JOB_KINDS.NODE_EXECUTE,
        {
          runId,
          nodeId: n.id,
          nodeKey: n.nodeKey,
          sessionId: run.sessionId,
          planVersion: n.planVersion || run.planVersion || 1,
          attemptSeq: Number(n.attempts ?? 0) + 1,
        },
        { parentJobId: job.id },
      );
    }
  }

  async #handleNodeExecute(job, { signal, leaseGuard, workerId = null }) {
    const { runId, nodeId, nodeKey } = job.payload;
    assertLeaseInTx(leaseGuard, { runId });
    const run = this.getRun(runId);
    const node = run?.nodes.find((n) => n.id === nodeId || n.nodeKey === nodeKey);
    if (!run || !node || isTerminalRunState(run.status) || isTerminalNodeState(node.status)) {
      return;
    }
    if (!['ready', 'queued', 'interrupted', 'running'].includes(node.status)) return;

    // Atomically bind this attempt/fence as the authoritative owner of `swarm_nodes` (even when reclaiming a running node!)
    const nextAttempt = Number(node.attempts ?? 0) + 1;
    if (node.status !== SWARM_NODE_STATES.RUNNING) {
      transitionSwarmNode(this.store, this.eventRouter, node.id, SWARM_NODE_STATES.RUNNING, {
        sessionId: run.sessionId,
        rootTurnId: run.rootTurnId,
        leaseGuard,
        bindingOwnership: true,
        patch: {
          attempts: nextAttempt,
          jobId: job.id,
          activeJobId: job.id,
          activeFence: job.fence ?? null,
          activeAttempt: nextAttempt,
        },
      });
    } else {
      this.store.tx(() => {
        assertLeaseInTx(leaseGuard, { runId, nodeId: node.id, bindingOwnership: true });
        this.store.db
          .prepare(
            `UPDATE swarm_nodes
             SET attempts=?, jobId=?, activeJobId=?, activeFence=?, activeAttempt=?, updatedAt=?
             WHERE id=? AND status='running'`,
          )
          .run(nextAttempt, job.id, job.id, job.fence ?? null, nextAttempt, Date.now(), node.id);
      });
    }

    const nodeGuard =
      leaseGuard?.withContext?.({
        runId,
        nodeId: node.id,
      }) ?? leaseGuard;

    // Fix C9 / D8: Before resuming a node that already has prior child execution history,
    // verify no unresolved unknown side effects or lost unarchived worktree writes exist.
    if (node.childTurnId || node.childSessionId) {
      const preRec = inspectNodeReconciliation(
        this.store,
        this.reconciler,
        this.eventRouter,
        node,
        node.childSessionId,
        node.childTurnId,
        { artifactManager: this.artifactManager },
      );
      if (preRec.needsReconciliation) {
        parkNodeAndRunForReconciliation(this.store, this.eventRouter, run, node, preRec.approvalId);
        return;
      }
    }

    const ctrl = this.#getRunController(runId);
    const combinedSignal = AbortSignal.any([signal, ctrl.signal]);
    const startedAt = Date.now();

    try {
      const byKey = new Map(run.nodes.map((n) => [n.nodeKey, n]));
      const depResults = node.dependencies
        .map((d) => {
          const dn = byKey.get(d);
          return dn?.resultText ? `[前置节点 ${d} 输出]\n${dn.resultText}` : '';
        })
        .filter(Boolean);

      // Fix C6: Collect real verified predecessor artifacts directly from durable registry (never regex-parsed from text)
      const predecessorArtifacts = [];
      if (this.artifactManager && node.dependencies.length) {
        for (const depKey of node.dependencies) {
          const dn = byKey.get(depKey);
          const art = dn?.latestArtifactId
            ? this.artifactManager.getArtifact(dn.latestArtifactId)
            : this.artifactManager.getLatestNodeArtifact(runId, depKey);
          if (art) predecessorArtifacts.push(art);
        }
      }

      const inboxMsgs = this.mailbox
        .drainInbox(node.nodeKey, { runId })
        .map((m) => `[协同消息来自 ${m.fromAgentId}]: ${JSON.stringify(m.payload)}`);
      const fullObjective = [...depResults, ...inboxMsgs, node.objective].join('\n\n');

      const cp = node.childTurnId ? this.checkpointStore?.loadLatest?.(node.childTurnId) : null;
      const treeSnap = this.budgetLedger?.ensureLedger({
        treeId: runId,
        rootSessionId: run.sessionId,
        budget: run.budget,
        initialUsage: run.usage,
      });
      const effectiveNodeBudget = computeEffectiveNodeBudget(node.budget, treeSnap, run.budget);
      const budgetScope = ['review', 'verification'].includes(node.taskType)
        ? BUDGET_SCOPES.REVIEW_VERIFICATION
        : BUDGET_SCOPES.NODE_EXECUTION;
      const parentSessRow = this.store.db
        .prepare('SELECT workspaceRoot, toolAllowJson FROM direct_sessions WHERE id=?')
        .get(run.sessionId);
      const fallbackWorkspace = run.workspaceRoot || parentSessRow?.workspaceRoot;
      const parentAllowTools = parseToolAllowJson(parentSessRow?.toolAllowJson);

      const childRes = await this.childManager.spawn({
        parentSessionId: run.sessionId,
        parentTurnId: run.rootTurnId,
        objective: fullObjective,
        profile: { id: node.agentProfileId },
        model: node.model,
        provider: node.provider || 'pool',
        permissionMode: node.permissionMode || run.permissionMode || 'auto-safe',
        parentPermissionMode: run.permissionMode || 'auto-safe',
        parentAllowTools,
        allowedTools: node.toolAllow,
        budget: effectiveNodeBudget,
        workspaceRoot: fallbackWorkspace,
        isolationMode: node.isolationMode,
        allowIsolationFallback: Boolean(node.allowIsolationFallback),
        runId: run.id,
        nodeId: node.id,
        nodeKey: node.nodeKey,
        attempt: nextAttempt,
        workerId,
        predecessorArtifacts,
        budgetLedger: this.budgetLedger,
        budgetScope,
        existingChildSessionId: node.childSessionId || null,
        resumeTurnId: node.childTurnId || null,
        initialStep: cp?.step ?? 0,
        leaseGuard: nodeGuard,
        signal: combinedSignal,
      });

      assertLeaseInTx(nodeGuard, { runId, nodeId: node.id });
      const recCheck = inspectNodeReconciliation(
        this.store,
        this.reconciler,
        this.eventRouter,
        node,
        childRes.childSessionId,
        childRes.childTurnId,
        { artifactManager: this.artifactManager },
      );
      if (recCheck.needsReconciliation) {
        parkNodeAndRunForReconciliation(this.store, this.eventRouter, run, node, recCheck.approvalId);
        return;
      }

      // Fix C5: Isolated worktree nodes MUST have a registered durable artifact before completing
      if (node.isolationMode === 'worktree' && this.artifactManager && !childRes.artifact?.id) {
        throw new RuntimeError('ARTIFACT_PERSIST_REQUIRED', {
          message: `Isolated worktree node ${node.nodeKey} completed without registered durable artifact`,
          detail: { runId, nodeKey: node.nodeKey },
        });
      }

      const uris = [
        ...new Set([
          ...(childRes.artifact?.uri ? [childRes.artifact.uri] : []),
          ...extractArtifactUris(childRes.text),
        ]),
      ];

      // Fix D5 / D7 / Fix E: Single atomic SQLite commit enforcing fence/attempt ownership for BOTH ledger-synced usage & node completion!
      const committedNode = this.store.tx(() => {
        assertLeaseInTx(nodeGuard, { runId, nodeId: node.id });
        const curNode = this.store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(node.id);
        if (!curNode || curNode.status !== SWARM_NODE_STATES.RUNNING) {
          throw new RuntimeError('LEASE_LOST', {
            message: `Node ${node.id} no longer running (status=${curNode?.status})`,
          });
        }
        if (curNode.activeFence && job.fence && curNode.activeFence !== job.fence) {
          throw new RuntimeError('LEASE_LOST', {
            message: `Node ${node.id} fence superseded before commit`,
          });
        }
        const now = Date.now();
        const curRun = this.store.db.prepare('SELECT status, usageJson FROM swarm_runs WHERE id=?').get(runId);
        const curUsage = parseJsonSafe(curRun?.usageJson, {});
        const ledgerRow = this.budgetLedger
          ? this.store.db.prepare('SELECT * FROM budget_ledgers WHERE treeId=?').get(runId)
          : null;
        const reconciledTotals = ledgerRow
          ? this.store.db
              .prepare(
                `SELECT COALESCE(SUM(actualSteps), 0) AS steps,
                        COALESCE(SUM(actualInputTokens), 0) AS inTok,
                        COALESCE(SUM(actualOutputTokens), 0) AS outTok
                 FROM budget_reservations
                 WHERE treeId=? AND status='reconciled'`,
              )
              .get(runId)
          : null;
        const nextUsage = ledgerRow
          ? {
              inputTokens: Math.max(0, Number(ledgerRow.usedInputTokens ?? 0) - Number(reconciledTotals?.inTok ?? 0)),
              outputTokens: Math.max(0, Number(ledgerRow.usedOutputTokens ?? 0) - Number(reconciledTotals?.outTok ?? 0)),
              steps: Math.max(0, Number(ledgerRow.usedSteps ?? 0) - Number(reconciledTotals?.steps ?? 0)),
              completedNodes: Number(curUsage.completedNodes ?? 0) + 1,
              reservedSteps: Number(ledgerRow.reservedSteps ?? 0),
              reservedTokens: Number(ledgerRow.reservedTokens ?? 0),
              estimationErrorTokens: Number(ledgerRow.estimationErrorTokens ?? 0),
              overageSteps: Number(ledgerRow.overageSteps ?? 0),
              overageTokens: Number(ledgerRow.overageTokens ?? 0),
            }
          : {
              inputTokens: Number(curUsage.inputTokens ?? 0) + Number(childRes.usage?.inputTokens ?? 0),
              outputTokens: Number(curUsage.outputTokens ?? 0) + Number(childRes.usage?.outputTokens ?? 0),
              steps: Number(curUsage.steps ?? 0) + Number(childRes.steps ?? 0),
              completedNodes: Number(curUsage.completedNodes ?? 0) + 1,
            };
        if (curRun && !isTerminalRunState(curRun.status)) {
          this.store.db
            .prepare('UPDATE swarm_runs SET usageJson=?, updatedAt=? WHERE id=? AND status=?')
            .run(JSON.stringify(nextUsage), now, runId, curRun.status);
        }
        this.store.db
          .prepare(
            `UPDATE swarm_nodes
             SET status=?, childSessionId=?, childTurnId=?, resultText=?,
                 artifactUrisJson=?, latestArtifactId=COALESCE(?, latestArtifactId),
                 activeFence=NULL, updatedAt=?
             WHERE id=? AND status='running'`,
          )
          .run(
            SWARM_NODE_STATES.COMPLETED,
            childRes.childSessionId,
            childRes.childTurnId,
            childRes.text,
            JSON.stringify(uris),
            childRes.artifact?.id ?? null,
            now,
            node.id,
          );
        return this.store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(node.id);
      });

      this.eventRouter?.emitPersisted({
        sessionId: run.sessionId,
        turnId: run.rootTurnId,
        type: RUNTIME_EVENTS.SWARM_NODE_UPDATED,
        data: {
          runId: committedNode.runId,
          nodeId: committedNode.id,
          nodeKey: committedNode.nodeKey,
          status: committedNode.status,
          childSessionId: committedNode.childSessionId || undefined,
          artifactUris: uris,
        },
        audit: false,
      });

      safeIsolateSideEffect(() => {
        const receiptStats =
          childRes.childSessionId && childRes.childTurnId && this.store?.db?.isOpen
            ? this.store.db
                .prepare(
                  "SELECT COUNT(*) AS total, SUM(CASE WHEN status='finished' THEN 1 ELSE 0 END) AS ok FROM tool_receipts WHERE sessionId=? AND turnId=?",
                )
                .get(childRes.childSessionId, childRes.childTurnId)
            : null;
        this.modelFeedback?.record?.({
          model: node.model,
          provider: node.provider || 'pool',
          taskType: node.taskType || 'general',
          success: true,
          toolTotal: Number(receiptStats?.total ?? 0),
          toolSuccess: Number(receiptStats?.ok ?? 0),
          verifiedPass: childRes.verifiedPass ?? null,
          latencyMs: Date.now() - startedAt,
          inputTokens: childRes.usage?.inputTokens ?? 0,
          outputTokens: childRes.usage?.outputTokens ?? 0,
          recovered: Boolean(job.reclaimedFromCrash || job.attempts > 1),
        });
      });

      enqueueSwarmJob(
        this.jobQueue,
        SWARM_JOB_KINDS.DEPENDENCY_RESOLVE,
        {
          runId,
          sessionId: run.sessionId,
          planVersion: run.planVersion || 1,
          epoch: Date.now(),
        },
        { idempotencyKey: `swarm:resolve:${runId}:${node.nodeKey}:done:${uuid().slice(0, 8)}` },
      );
    } catch (err) {
      if (signal?.reason === 'shutdown' || ctrl.signal.reason === 'shutdown') {
        return;
      }
      // Fix D6/D7: A stale worker encountering LEASE_LOST (or whose lease was already lost) MUST exit cleanly!
      if (isLeaseLostError(err) || !this.store?.db?.isOpen || !checkLeaseHeld(nodeGuard, { runId, nodeId: node.id })) {
        return;
      }

      const freshRun = this.getRun(runId);
      const freshNode = freshRun?.nodes.find((n) => n.id === node.id);
      if (!freshRun || !freshNode || isTerminalRunState(freshRun.status) || isTerminalNodeState(freshNode.status)) {
        return;
      }

      const recCheck = inspectNodeReconciliation(
        this.store,
        this.reconciler,
        this.eventRouter,
        freshNode,
        freshNode.childSessionId,
        freshNode.childTurnId,
        { artifactManager: this.artifactManager },
      );
      if (recCheck.needsReconciliation || err?.code === 'RECONCILIATION_REQUIRED') {
        parkNodeAndRunForReconciliation(
          this.store,
          this.eventRouter,
          freshRun,
          freshNode,
          recCheck.approvalId,
        );
        return;
      }

      if (err?.code === 'PARENT_CANCELLED' || err?.category === 'cancellation' || combinedSignal.aborted) {
        if (!ctrl.signal.aborted) {
          try {
            transitionSwarmNode(this.store, this.eventRouter, freshNode.id, SWARM_NODE_STATES.CANCELLED, {
              sessionId: freshRun.sessionId,
              rootTurnId: freshRun.rootTurnId,
              leaseGuard: nodeGuard,
              patch: {
                activeFence: null,
                errorCode: err?.code || 'NODE_CANCELLED',
                errorMessage: String(err?.message ?? err),
              },
            });
            enqueueSwarmJob(
              this.jobQueue,
              SWARM_JOB_KINDS.DEPENDENCY_RESOLVE,
              {
                runId,
                sessionId: freshRun.sessionId,
                planVersion: freshRun.planVersion || 1,
                epoch: Date.now(),
              },
              { idempotencyKey: `swarm:resolve:${runId}:${freshNode.nodeKey}:cancel:${uuid().slice(0, 8)}` },
            );
          } catch (txErr) {
            if (isLeaseLostError(txErr)) return;
            throw txErr;
          }
        }
        return;
      }

      const errorCode = String(err?.code || 'NODE_FAILED');
      const errorMessage = String(err?.detail?.message ?? err?.message ?? err);
      safeIsolateSideEffect(() => {
        const receiptStats =
          freshNode.childSessionId && freshNode.childTurnId && this.store?.db?.isOpen
            ? this.store.db
                .prepare(
                  "SELECT COUNT(*) AS total, SUM(CASE WHEN status='finished' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM tool_receipts WHERE sessionId=? AND turnId=?",
                )
                .get(freshNode.childSessionId, freshNode.childTurnId)
            : null;
        const isVerificationFailure = errorCode === 'VERIFICATION_FAILED';
        const failureKind = classifyFailureKind(err, {
          isVerificationFailure,
          hasToolFailure: Number(receiptStats?.failed ?? 0) > 0,
        });
        this.modelFeedback?.record?.({
          model: freshNode.model,
          provider: freshNode.provider || 'pool',
          taskType: freshNode.taskType || 'general',
          success: false,
          toolTotal: Number(receiptStats?.total ?? 0),
          toolSuccess: Number(receiptStats?.ok ?? 0),
          verifiedPass: isVerificationFailure || err?.detail?.verdict?.accepted === false ? false : null,
          failureKind,
          timedOut: failureKind === 'timeout',
          latencyMs: Date.now() - startedAt,
          inputTokens: err?.usage?.inputTokens ?? err?.detail?.usage?.inputTokens ?? 0,
          outputTokens: err?.usage?.outputTokens ?? err?.detail?.usage?.outputTokens ?? 0,
          recovered: Boolean(job.reclaimedFromCrash || job.attempts > 1),
        });
      });

      const replanOut = this.replanner
        ? await this.replanner
            .replan({
              run: freshRun,
              failedNode: freshNode,
              errorCode,
              errorMessage,
              maxReplans: freshRun.strategy?.maxReplans ?? 2,
              budgetLedger: this.budgetLedger,
            })
            .catch(() => ({ replanned: false }))
        : { replanned: false };

      if (!checkLeaseHeld(leaseGuard, { runId })) return;

      if (replanOut?.replanned) {
        enqueueSwarmJob(
          this.jobQueue,
          SWARM_JOB_KINDS.DEPENDENCY_RESOLVE,
          {
            runId,
            sessionId: freshRun.sessionId,
            planVersion: replanOut.version || freshRun.planVersion || 1,
            epoch: Date.now(),
          },
          { idempotencyKey: `swarm:resolve:${runId}:${freshNode.nodeKey}:replan:${uuid().slice(0, 8)}` },
        );
        return;
      }

      try {
        transitionSwarmNode(this.store, this.eventRouter, freshNode.id, SWARM_NODE_STATES.FAILED, {
          sessionId: freshRun.sessionId,
          rootTurnId: freshRun.rootTurnId,
          leaseGuard: nodeGuard,
          patch: { activeFence: null, errorCode, errorMessage },
        });
      } catch (txErr) {
        if (isLeaseLostError(txErr)) return;
        throw txErr;
      }
      enqueueSwarmJob(
        this.jobQueue,
        SWARM_JOB_KINDS.DEPENDENCY_RESOLVE,
        {
          runId,
          sessionId: freshRun.sessionId,
          planVersion: freshRun.planVersion || 1,
          epoch: Date.now(),
        },
        { idempotencyKey: `swarm:resolve:${runId}:${freshNode.nodeKey}:fail:${uuid().slice(0, 8)}` },
      );
    }
  }

  #handleAggregate(job, { leaseGuard } = {}) {
    const { runId } = job.payload;
    assertLeaseInTx(leaseGuard, { runId });
    const run = this.getRun(runId);
    if (!run || isTerminalRunState(run.status)) return;
    transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.VERIFYING, {
      leaseGuard,
      patch: { currentPhase: 'verifying' },
    });
    enqueueSwarmJob(
      this.jobQueue,
      SWARM_JOB_KINDS.VERIFY,
      { runId, sessionId: run.sessionId, planVersion: run.planVersion || 1 },
      {
        idempotencyKey: `swarm:ver:${runId}:v${run.planVersion || 1}:${Date.now()}`,
        parentJobId: job.id,
      },
    );
  }

  #handleVerify(job, { leaseGuard } = {}) {
    const { runId } = job.payload;
    assertLeaseInTx(leaseGuard, { runId });
    const run = this.getRun(runId);
    if (!run || isTerminalRunState(run.status)) return;

    const replacedKeys = this.#getReplacedNodeKeys(runId);
    const summary = buildSwarmSummary(run.nodes);
    const childSessionIds = run.nodes.map((n) => n.childSessionId).filter(Boolean);
    const allSessionIds = [...new Set([run.sessionId, ...childSessionIds].filter(Boolean))];
    const childTurnIds = run.nodes.map((n) => n.childTurnId).filter(Boolean);
    const allTurnIds = [...new Set([run.rootTurnId, ...childTurnIds].filter(Boolean))];

    const verdict = this.evidenceVerifier
      ? this.evidenceVerifier.verify({
          text: summary,
          sessionId: run.sessionId,
          turnId: run.rootTurnId,
          sessionIds: allSessionIds,
          turnIds: allTurnIds.length ? allTurnIds : null,
          workspaceRoot: run.workspaceRoot,
        })
      : { verdict: 'pass', accepted: true, reasons: [] };

    const outcome = resolveSwarmOutcome({
      nodes: run.nodes,
      replacedKeys,
      verdict,
      hasPendingReconciliation: verdict?.verdict === 'block_reconciliation',
    });

    if (outcome.status === SWARM_RUN_STATES.RECONCILING) {
      transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.RECONCILING, {
        leaseGuard,
        patch: {
          currentPhase: 'reconciling',
          verdictJson: JSON.stringify(outcome.verdict),
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
        },
      });
      return;
    }

    const finalStatus =
      outcome.status === SWARM_RUN_STATES.COMPLETED
        ? SWARM_RUN_STATES.COMPLETED
        : SWARM_RUN_STATES.FAILED;

    let didTransition = false;
    const prevRow = this.store.db.prepare('SELECT status FROM swarm_runs WHERE id=?').get(runId);
    if (prevRow && !isTerminalRunState(prevRow.status)) {
      transitionSwarmRun(this.store, runId, finalStatus, {
        leaseGuard,
        patch: {
          currentPhase: finalStatus,
          verdictJson: JSON.stringify(outcome.verdict),
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
        },
      });
      didTransition = true;
    }

    const settled = this.getRun(runId);
    if (didTransition) {
      this.eventRouter?.emitPersisted({
        sessionId: run.sessionId,
        turnId: run.rootTurnId,
        type: RUNTIME_EVENTS.SWARM_RUN_COMPLETED,
        data: {
          runId,
          status: finalStatus,
          usage: settled.usage,
          verdict: outcome.verdict,
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
          ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
        },
        audit: true,
      });
    }
    this.#notifyWaiters(settled);
  }

  #prepareNodeSpecs(rawNodes, budget) {
    const plannedNodes = this.planner.normalizeNodes(rawNodes);
    this.planner.validateDag(plannedNodes);
    return plannedNodes.map((n) => ({
      spec: n,
      selection: this.router.select({
        taskType: n.taskType,
        objective: n.objective,
        requiredTools: Array.isArray(n.toolAllow) ? n.toolAllow : null,
        budget: n.budget ?? budget,
      }),
    }));
  }

  #insertNodes(runId, routedSpecs, parentPermissionMode, planVersion, now) {
    const ins = this.store.db.prepare(
      `INSERT OR IGNORE INTO swarm_nodes(
        id, runId, nodeKey, agentProfileId, model, provider, objective, acceptance,
        dependenciesJson, toolAllowJson, permissionMode, taskType, isolationMode,
        allowIsolationFallback, planVersion, status, priority, budgetJson, createdAt, updatedAt
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`,
    );
    for (const { spec, selection } of routedSpecs) {
      // Never widen an explicit empty allowlist (`[]`) by injecting `read_swarm_artifact`.
      const defaultToolAllow =
        Array.isArray(selection.profile.toolAllow) && selection.profile.toolAllow.length > 0
          ? [...new Set([...selection.profile.toolAllow, 'read_swarm_artifact'])]
          : selection.profile.toolAllow;
      ins.run(
        uuid(),
        runId,
        spec.nodeKey,
        selection.profile.id,
        selection.model,
        selection.provider,
        spec.objective,
        spec.acceptance,
        JSON.stringify(spec.dependencies),
        spec.toolAllow !== null && spec.toolAllow !== undefined
          ? JSON.stringify(spec.toolAllow)
          : JSON.stringify(defaultToolAllow),
        parentPermissionMode,
        spec.taskType || 'research',
        spec.isolationMode || 'shared_readonly',
        spec.allowIsolationFallback ? 1 : 0,
        planVersion,
        spec.priority,
        JSON.stringify(spec.budget ?? {}),
        now,
        now,
      );
    }
  }

  #getReplacedNodeKeys(runId) {
    return new Set(
      this.store.db
        .prepare("SELECT failedNodeKey FROM swarm_replans WHERE runId=? AND strategy='split_subgraph'")
        .all(runId)
        .map((r) => r.failedNodeKey)
        .filter(Boolean),
    );
  }

  #getRunController(runId) {
    let ctrl = this.activeControllers.get(runId);
    if (!ctrl || ctrl.signal.aborted) {
      ctrl = new AbortController();
      this.activeControllers.set(runId, ctrl);
    }
    return ctrl;
  }

  #formatRunResult(run) {
    return {
      runId: run.id,
      status: run.status,
      summary: buildSwarmSummary(run.nodes),
      nodes: run.nodes,
      usage: run.usage,
      verdict: run.verdict,
      planVersion: run.planVersion,
      replanCount: run.replanCount,
      errorCode: run.errorCode ?? null,
      errorMessage: run.errorMessage ?? null,
      budgetLedger: this.budgetLedger?.getSnapshot?.(run.id) ?? null,
    };
  }

  #notifyWaiters(run) {
    this.activeControllers.delete(run.id);
    const set = this.waiters.get(run.id);
    if (!set) return;
    for (const fn of [...set]) fn(run);
  }
}
