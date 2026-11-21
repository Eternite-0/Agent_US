import { id as uuid } from '../store.js';
import { BudgetError, RecoveryError, RuntimeError } from '../kernel/errors.js';
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
import { withTraceContext } from '../observability/trace.js';
import { logEvent } from '../observability/logger.js';
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
import { validatePlan } from '../planning/validator.js';
import { TeamOptimizer } from './team-optimizer.js';

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
    metrics = null,
    teamOptimizer = null,
    capabilityRegistry = null,
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
    this.metrics = metrics;
    this.teamOptimizer = teamOptimizer ?? new TeamOptimizer({});
    this.capabilityRegistry = capabilityRegistry;
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

  #dbOpen() {
    return Boolean(this.store?.db?.isOpen);
  }

  getRun(runId) {
    if (!this.#dbOpen() || !runId) return null;
    const run = this.store.db.prepare('SELECT * FROM swarm_runs WHERE id=?').get(runId);
    if (!run) return null;
    const nodes = this.store.db
      .prepare('SELECT * FROM swarm_nodes WHERE runId=? ORDER BY priority DESC, createdAt ASC')
      .all(runId);
    const hydrated = hydrateSwarmRun(run, nodes);
    const persistedPlan = run.planJson
      ? parseJsonSafe(run.planJson, null)
      : hydrated.strategy?.plan ?? null;
    return { ...hydrated, plan: persistedPlan };
  }

  listRuns({ sessionId = null, limit = 50 } = {}) {
    if (!this.#dbOpen()) return [];
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
    if (!this.#dbOpen() || !runId) return [];
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
    trafficSource = 'production',
    isSynthetic = 0,
    planVersion = 1,
    plan = null,
  }) {
    const runId = uuid();
    const now = Date.now();
    const initialPlanVersion = Number.isInteger(Number(planVersion)) && Number(planVersion) > 0
      ? Number(planVersion)
      : 1;
    const persistedPlan = plan ? structuredClone(plan) : null;
    const strategy = {
      maxConcurrency: Math.min(6, Math.max(1, Number(maxConcurrency || 3))),
      maxReplans: Math.max(0, Number(maxReplans ?? 2)),
      ...(persistedPlan ? { plan: persistedPlan } : {}),
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
            workspaceRoot, permissionMode, planVersion, currentPhase, replanCount,
            trafficSource, isSynthetic, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
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
          initialPlanVersion,
          initialStatus,
          String(trafficSource || 'production'),
          isSynthetic ? 1 : 0,
          now,
          now,
        );
      this.budgetLedger?.ensureLedger({
        treeId: runId,
        rootSessionId: sessionId,
        budget: budget ?? {},
        trafficSource: String(trafficSource || 'production'),
        isSynthetic: isSynthetic ? 1 : 0,
      });
      if (routedSpecs.length) {
        this.#insertNodes(runId, routedSpecs, parentPermissionMode, initialPlanVersion, now);
      }
    });

    try {
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
    } catch {
      // best-effort event emit after committed run
    }

    if (hasExplicitNodes) {
      enqueueSwarmJob(this.jobQueue, SWARM_JOB_KINDS.DEPENDENCY_RESOLVE, {
        runId,
        sessionId,
        planVersion: initialPlanVersion,
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

  /**
   * Validate an Adaptive Planner plan and submit it through the existing durable
   * Swarm path. No second execution loop is introduced.
   */
  submitPlannedRun({
    plan,
    sessionId,
    rootTurnId = null,
    workspaceRoot = null,
    parentPermissionMode = 'auto-safe',
    maxConcurrency = 3,
    budget = undefined,
    maxReplans = 2,
    trafficSource = 'production',
    isSynthetic = 0,
  } = {}) {
    const validated = validatePlan(plan, { permissionCeiling: parentPermissionMode });
    const nodes = validated.tasks.map((task) => ({
      nodeKey: task.taskKey,
      objective: task.objective,
      acceptance:
        typeof task.acceptance === 'string'
          ? task.acceptance
          : `${task.acceptance.description} (required evidence: ${task.acceptance.requiredEvidence.join(', ')})`,
      taskType: task.taskType,
      dependencies: task.dependencies,
      toolAllow: task.toolAllow,
      budget: task.budget,
      priority: Number.isFinite(Number(task.metadata?.priority)) ? Number(task.metadata.priority) : 0,
    }));
    return this.submitRun({
      sessionId,
      rootTurnId,
      goal: validated.goal,
      workspaceRoot,
      parentPermissionMode: validated.permissionMode,
      maxConcurrency,
      budget: budget ?? validated.budget,
      nodes,
      maxReplans,
      trafficSource,
      isSynthetic,
      planVersion: validated.planVersion,
      plan: validated,
    });
  }

  submitPlan(options = {}) {
    return this.submitPlannedRun(options);
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
    if (!this.#dbOpen()) {
      throw new RuntimeError('SWARM_RUN_NOT_FOUND', { status: 404, detail: { runId } });
    }
    const postEvents = [];
    const { run, didResume } = this.store.tx(() => {
      const cur = this.getRun(runId);
      if (!cur) {
        throw new RuntimeError('SWARM_RUN_NOT_FOUND', { status: 404, detail: { runId } });
      }
      if (cur.status === SWARM_RUN_STATES.CANCELLED) {
        throw new RuntimeError('SWARM_RUN_CANCELLED', {
          status: 409,
          message: 'Cancelled swarm run cannot be resumed',
          detail: { runId },
        });
      }
      if (cur.status === SWARM_RUN_STATES.COMPLETED) {
        return { run: cur, didResume: false };
      }

      const replacedKeys = this.#getReplacedNodeKeys(runId);
      if (cur.status === SWARM_RUN_STATES.FAILED) {
        transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.RUNNING, {
          allowResume: true,
          patch: { currentPhase: 'running', errorCode: null, errorMessage: null, finishedAt: null },
        });
      }

      // P0-7: Respect DAG dependencies when resetting nodes on resume — nodes with any
      // non-completed dependency MUST reset to PENDING (never READY) so they cannot bypass upstream deps!
      const byKey = new Map(cur.nodes.map((n) => [n.nodeKey, n]));
      for (const n of cur.nodes) {
        const depsCompleted = n.dependencies.every(
          (d) => byKey.get(d)?.status === SWARM_NODE_STATES.COMPLETED,
        );
        const targetState = depsCompleted ? SWARM_NODE_STATES.READY : SWARM_NODE_STATES.PENDING;
        if (n.status === SWARM_NODE_STATES.FAILED && !replacedKeys.has(n.nodeKey)) {
          const upd = transitionSwarmNode(this.store, null, n.id, targetState, {
            emitEvent: false,
            allowReplanReset: true,
            patch: { activeFence: null, activeJobId: null, errorCode: null, errorMessage: null },
          });
          if (upd.changed) postEvents.push(upd);
        } else if (
          n.status === SWARM_NODE_STATES.INTERRUPTED ||
          n.status === SWARM_NODE_STATES.PARKED
        ) {
          // PARKED / INTERRUPTED cannot transition directly to PENDING in state machine; go READY (or demote in resolve)
          const resetTo = SWARM_NODE_STATES.READY;
          let upd = transitionSwarmNode(this.store, null, n.id, resetTo, {
            emitEvent: false,
            patch: { activeFence: null, activeJobId: null },
          });
          if (!depsCompleted) {
            upd = transitionSwarmNode(this.store, null, n.id, SWARM_NODE_STATES.PENDING, {
              emitEvent: false,
            });
          }
          if (upd.changed) postEvents.push(upd);
        }
      }
      return { run: this.getRun(runId), didResume: true };
    });

    if (!didResume) return run;

    for (const upd of postEvents) {
      try {
        this.eventRouter?.emitPersisted({
          sessionId: run.sessionId,
          turnId: run.rootTurnId,
          type: RUNTIME_EVENTS.SWARM_NODE_UPDATED,
          data: {
            runId: upd.runId,
            nodeId: upd.id,
            nodeKey: upd.nodeKey,
            status: upd.status,
            childSessionId: upd.childSessionId || undefined,
          },
          audit: false,
        });
      } catch {
        // best-effort event emit
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
    if (!this.#dbOpen()) return null;
    const preRun = this.getRun(runId);
    if (!preRun) return null;

    const now = Date.now();
    const cancelledNodes = [];
    const { transitionedToCancelled, childSessionIds } = this.store.tx(() => {
      const curRun = this.getRun(runId);
      if (!curRun) return { transitionedToCancelled: false, childSessionIds: [] };

      this.store.db
        .prepare(
          `UPDATE runtime_jobs SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, updatedAt=?
           WHERE taskId=? AND status IN ('pending','active','reconciling','parked')`,
        )
        .run(now, runId);

      const childIds = [];
      for (const n of curRun.nodes) {
        if (n.childSessionId) childIds.push(n.childSessionId);
        if (!isTerminalNodeState(n.status)) {
          const upd = transitionSwarmNode(this.store, null, n.id, SWARM_NODE_STATES.CANCELLED, {
            emitEvent: false,
            patch: { activeFence: null, activeJobId: null, errorCode: n.errorCode || 'NODE_CANCELLED' },
          });
          if (upd.changed) cancelledNodes.push(upd);
        }
      }

      let didCancelRun = false;
      if (!isTerminalRunState(curRun.status)) {
        const updRun = transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.CANCELLED, {
          patch: { currentPhase: 'cancelled', finishedAt: now },
        });
        didCancelRun = Boolean(updRun.changed);
      }
      return { transitionedToCancelled: didCancelRun, childSessionIds: childIds };
    });

    this.activeControllers.get(runId)?.abort('swarm_cancelled');
    for (const cid of childSessionIds) {
      this.childManager?.cancel?.(cid);
    }

    for (const upd of cancelledNodes) {
      try {
        this.eventRouter?.emitPersisted({
          sessionId: preRun.sessionId,
          turnId: preRun.rootTurnId,
          type: RUNTIME_EVENTS.SWARM_NODE_UPDATED,
          data: {
            runId: upd.runId,
            nodeId: upd.id,
            nodeKey: upd.nodeKey,
            status: upd.status,
            childSessionId: upd.childSessionId || undefined,
            errorCode: upd.errorCode || undefined,
          },
          audit: false,
        });
      } catch {
        // best-effort event emit
      }
    }

    const finalRun = this.getRun(runId);
    if (transitionedToCancelled) {
      try {
        this.eventRouter?.emitPersisted({
          sessionId: preRun.sessionId,
          turnId: preRun.rootTurnId,
          type: RUNTIME_EVENTS.SWARM_RUN_COMPLETED,
          data: { runId, status: SWARM_RUN_STATES.CANCELLED, usage: finalRun.usage },
          audit: true,
        });
      } catch {
        // best-effort event emit
      }
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
    const { runId, goal, planVersion: jobPlanVersion } = job.payload;
    if (!this.#dbOpen()) return;
    return withTraceContext({ runId, jobId: job.id }, async () => {
      const run = this.getRun(runId);
      if (!run || isTerminalRunState(run.status)) return;
      if (jobPlanVersion !== undefined && Number(jobPlanVersion) < Number(run.planVersion || 1)) {
        return;
      }

      let routedSpecs = null;
      if (run.nodes.length === 0) {
        this.budgetLedger?.ensureLedger({
          treeId: runId,
          rootSessionId: run.sessionId,
          budget: run.budget,
          initialUsage: run.usage,
          trafficSource: run.trafficSource || 'production',
          isSynthetic: run.isSynthetic ? 1 : 0,
        });
        let planned;
        try {
          planned = await this.planner.decompose({
            goal: goal || run.goal,
            signal,
            budgetLedger: this.budgetLedger,
            treeId: runId,
            sessionId: run.sessionId,
            leaseGuard,
          });
        } catch (err) {
          if (isLeaseLostError(err)) throw err;
          if (err instanceof BudgetError || err?.category === 'budget' || isBudgetErrorCode(err?.code)) {
            const failedRun = transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.FAILED, {
              leaseGuard,
              patch: {
                currentPhase: SWARM_RUN_STATES.FAILED,
                errorCode: 'BUDGET_EXCEEDED',
                errorMessage: String(err?.message ?? 'Planning blocked by task-tree budget'),
              },
            });
            const settled = this.getRun(runId);
            if (failedRun.changed) {
              try {
                this.eventRouter?.emitPersisted({
                  sessionId: run.sessionId,
                  turnId: run.rootTurnId,
                  type: RUNTIME_EVENTS.SWARM_RUN_COMPLETED,
                  data: { runId, status: SWARM_RUN_STATES.FAILED, usage: settled.usage },
                  audit: true,
                });
              } catch {
                // non-fatal event emit
              }
            }
            this.#notifyWaiters(settled);
            return;
          }
          throw err;
        }
        assertLeaseInTx(leaseGuard, { runId });
        this.planner.validateDag(planned);
        routedSpecs = this.#prepareNodeSpecs(planned, run.budget);
      }

      const { shouldResolve, effectivePlanVersion } = this.store.tx(() => {
        assertLeaseInTx(leaseGuard, { runId });
        const fresh = this.getRun(runId);
        if (!fresh || isTerminalRunState(fresh.status)) {
          return { shouldResolve: false, effectivePlanVersion: fresh?.planVersion || 1 };
        }
        if (routedSpecs && fresh.nodes.length === 0) {
          this.#insertNodes(
            runId,
            routedSpecs,
            fresh.permissionMode || 'auto-safe',
            fresh.planVersion || 1,
            Date.now(),
          );
        }
        if (
          fresh.status === SWARM_RUN_STATES.PLANNING ||
          fresh.status === SWARM_RUN_STATES.PENDING
        ) {
          transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.RUNNING, {
            leaseGuard,
            patch: { currentPhase: 'running' },
          });
          return { shouldResolve: true, effectivePlanVersion: fresh.planVersion || 1 };
        }
        return {
          shouldResolve: fresh.status === SWARM_RUN_STATES.RUNNING,
          effectivePlanVersion: fresh.planVersion || 1,
        };
      });

      if (shouldResolve) {
        enqueueSwarmJob(
          this.jobQueue,
          SWARM_JOB_KINDS.DEPENDENCY_RESOLVE,
          {
            runId,
            sessionId: run.sessionId,
            planVersion: effectivePlanVersion,
            epoch: Date.now(),
          },
          { idempotencyKey: `swarm:resolve:${runId}:planned:v${effectivePlanVersion}:${uuid().slice(0, 8)}` },
        );
      }
    });
  }

  #handleDependencyResolve(job, { leaseGuard } = {}) {
    const { runId } = job.payload;
    if (!this.#dbOpen()) return;
    return withTraceContext({ runId, jobId: job.id }, () => {
      const preRun = this.getRun(runId);
      if (!preRun || isTerminalRunState(preRun.status)) return;

      const parentSess = this.store.db
        .prepare('SELECT state FROM direct_sessions WHERE id=?')
        .get(preRun.sessionId);
      if (!parentSess || parentSess.state === 'cancelled') {
        this.cancelRun(runId);
        return;
      }

      const postEvents = [];
      const txResult = this.store.tx(() => {
        assertLeaseInTx(leaseGuard, { runId });
        let run = this.getRun(runId);
        if (!run || isTerminalRunState(run.status)) {
          return { action: 'noop' };
        }

        const ledgerSnap = this.budgetLedger?.ensureLedger({
          treeId: runId,
          rootSessionId: run.sessionId,
          budget: run.budget,
          initialUsage: run.usage,
          trafficSource: run.trafficSource || 'production',
          isSynthetic: run.isSynthetic ? 1 : 0,
        });
        const budgetExhausted = Boolean(
          ledgerSnap?.isPermanentlyExhausted ||
            (ledgerSnap?.isStepExhausted && ledgerSnap.reservedSteps === 0) ||
            (ledgerSnap?.isTokenExhausted && ledgerSnap.reservedTokens === 0),
        );
        if (budgetExhausted) {
          for (const n of run.nodes) {
            if (n.status === SWARM_NODE_STATES.PENDING || n.status === SWARM_NODE_STATES.READY) {
              const upd = transitionSwarmNode(this.store, null, n.id, SWARM_NODE_STATES.CANCELLED, {
                emitEvent: false,
                leaseGuard,
                patch: {
                  errorCode: 'BUDGET_EXCEEDED',
                  errorMessage: ledgerSnap?.exhaustedReason
                    ? `Tree budget reached (${ledgerSnap.exhaustedReason})`
                    : 'Tree budget reached',
                },
              });
              if (upd.changed) postEvents.push(upd);
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
              const allBudgetFailed = failedDeps.every((d) =>
                isBudgetErrorCode(byKey.get(d)?.errorCode),
              );
              const upd = allBudgetFailed
                ? transitionSwarmNode(this.store, null, n.id, SWARM_NODE_STATES.CANCELLED, {
                    emitEvent: false,
                    leaseGuard,
                    patch: {
                      errorCode: 'BUDGET_EXCEEDED',
                      errorMessage: `Blocked by budget-exhausted upstream node(s): ${failedDeps.join(', ')}`,
                    },
                  })
                : transitionSwarmNode(this.store, null, n.id, SWARM_NODE_STATES.FAILED, {
                    emitEvent: false,
                    leaseGuard,
                    patch: {
                      errorCode: 'DEPENDENCY_FAILED',
                      errorMessage: `Blocked by upstream node(s): ${failedDeps.join(', ')}`,
                    },
                  });
              if (upd.changed) postEvents.push(upd);
            }
          }
        }

        // Promote dependency-satisfied pending nodes -> ready, and demote any invalidly READY node with unsatisfied deps -> pending
        run = this.getRun(runId);
        const byKey = new Map(run.nodes.map((n) => [n.nodeKey, n]));
        for (const n of run.nodes) {
          const allDepsCompleted = n.dependencies.every(
            (d) => byKey.get(d)?.status === SWARM_NODE_STATES.COMPLETED,
          );
          if (n.status === SWARM_NODE_STATES.PENDING && allDepsCompleted) {
            const upd = transitionSwarmNode(this.store, null, n.id, SWARM_NODE_STATES.READY, {
              emitEvent: false,
              leaseGuard,
            });
            if (upd.changed) postEvents.push(upd);
          } else if (n.status === SWARM_NODE_STATES.READY && !allDepsCompleted) {
            const upd = transitionSwarmNode(this.store, null, n.id, SWARM_NODE_STATES.PENDING, {
              emitEvent: false,
              leaseGuard,
            });
            if (upd.changed) postEvents.push(upd);
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
          const candidates = (this.router?.modelRegistry?.list?.() ?? []).map((candidate) => {
            const effective = this.capabilityRegistry?.getEffectiveCapability?.(candidate.model ?? candidate.id);
            return effective?.measured
              ? { ...candidate, effectiveCapabilities: effective.effective, capabilityEvidence: effective.measured }
              : candidate;
          });
          const budgetSnapshot = this.budgetLedger?.getSnapshot(runId) ?? null;
          const taskRequirements = picked.reduce((acc, node) => {
            const parsed = parseJsonSafe(node.budgetJson, {});
            const required = parsed.requiredCapabilities ?? parsed.capabilityWeights ?? {};
            for (const [dimension, weight] of Object.entries(required)) {
              acc[dimension] = Math.max(Number(acc[dimension] ?? 0), Number(weight) || 0);
            }
            return acc;
          }, {});
          const team = this.teamOptimizer.optimize({
            task: {
              taskType: picked.length > 1 ? 'implementation' : picked[0].taskType,
              complexity: picked.length > 1 ? 'complex' : 'simple',
              independentWorkstreams: picked.length,
              requiredCapabilities: taskRequirements,
              requiresIndependentVerification: picked.some((n) => n.taskType === 'verification'),
              artifactRisk: picked.some((n) => n.isolationMode === 'worktree') ? 'high' : undefined,
            },
            candidates,
            budget: run.budget,
            budgetSnapshot,
            maxConcurrency: Math.min(maxConc, picked.length),
            reviewerAvailable: picked.some((n) => n.taskType === 'verification'),
          });
          const dispatchCount = team.mode === 'team'
            ? picked.length
            : Math.min(1, picked.length);
          const queuedKeys = [];
          for (const [index, n] of picked.slice(0, dispatchCount).entries()) {
            const selectedMember = team.members?.[index] ?? team.members?.[0];
            if (selectedMember && Number(n.attempts ?? 0) === 0 && Number(n.planVersion ?? 1) <= 1) {
              const candidate = candidates.find((item) => item.model === selectedMember.id || item.id === selectedMember.id);
              if (candidate) {
                this.store.db.prepare('UPDATE swarm_nodes SET model=?, provider=?, updatedAt=? WHERE id=? AND status=?').run(candidate.model ?? candidate.id, candidate.provider ?? 'pool', Date.now(), n.id, SWARM_NODE_STATES.READY);
              }
            }
            const upd = transitionSwarmNode(this.store, null, n.id, SWARM_NODE_STATES.QUEUED, {
              emitEvent: false,
              leaseGuard,
            });
            if (upd.changed) {
              postEvents.push(upd);
              queuedKeys.push(n.nodeKey);
            }
          }
          if (queuedKeys.length > 0) {
            this.metrics?.record?.('swarm_team_selected', {
              runId,
              mode: team.mode,
              memberCount: team.members?.length ?? 0,
              estimatedCost: team.estimatedCost,
              rationale: team.rationale,
              capabilityEvidence: team.members?.map((member) => ({
                id: member.id,
                capabilityScore: member.capabilityScore,
                historyScore: member.historyScore,
              })) ?? [],
              isSynthetic: run.isSynthetic ? 1 : 0,
            });
            return {
              action: 'dispatch',
              sessionId: run.sessionId,
              rootTurnId: run.rootTurnId,
              nodeKeys: queuedKeys,
              planVersion: run.planVersion || 1,
            };
          }
          return { action: 'noop', sessionId: run.sessionId, rootTurnId: run.rootTurnId };
        }

        const reconciling = run.nodes.filter((n) => n.status === SWARM_NODE_STATES.RECONCILING);
        const stillActive = run.nodes.some((n) =>
          ['pending', 'ready', 'queued', 'running', 'interrupted', 'parked'].includes(n.status),
        );
        if (stillActive) {
          return { action: 'noop', sessionId: run.sessionId, rootTurnId: run.rootTurnId };
        }

        if (reconciling.length > 0) {
          if (run.status !== SWARM_RUN_STATES.RECONCILING) {
            transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.RECONCILING, {
              leaseGuard,
              patch: { currentPhase: 'reconciling' },
            });
          }
          return { action: 'noop', sessionId: run.sessionId, rootTurnId: run.rootTurnId };
        }

        if (run.status === SWARM_RUN_STATES.RECONCILING) {
          transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.RUNNING, {
            leaseGuard,
            patch: { currentPhase: 'running' },
          });
        }
        const aggRun = transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.AGGREGATING, {
          leaseGuard,
          patch: { currentPhase: 'aggregating' },
        });
        return {
          action: aggRun.changed ? 'aggregate' : 'noop',
          sessionId: run.sessionId,
          rootTurnId: run.rootTurnId,
          planVersion: run.planVersion || 1,
        };
      });

      for (const upd of postEvents) {
        try {
          this.eventRouter?.emitPersisted({
            sessionId: preRun.sessionId,
            turnId: preRun.rootTurnId,
            type: RUNTIME_EVENTS.SWARM_NODE_UPDATED,
            data: {
              runId: upd.runId,
              nodeId: upd.id,
              nodeKey: upd.nodeKey,
              status: upd.status,
              childSessionId: upd.childSessionId || undefined,
              errorCode: upd.errorCode || undefined,
            },
            audit: false,
          });
        } catch {
          // non-fatal event emit
        }
      }

      if (txResult.action === 'dispatch') {
        enqueueSwarmJob(
          this.jobQueue,
          SWARM_JOB_KINDS.DISPATCH,
          {
            runId,
            sessionId: txResult.sessionId,
            nodeKeys: txResult.nodeKeys,
            planVersion: txResult.planVersion,
          },
          {
            idempotencyKey: `swarm:dispatch:${runId}:v${txResult.planVersion}:${Date.now()}:${uuid().slice(0, 6)}`,
            parentJobId: job.id,
          },
        );
      } else if (txResult.action === 'aggregate') {
        enqueueSwarmJob(
          this.jobQueue,
          SWARM_JOB_KINDS.AGGREGATE,
          { runId, sessionId: txResult.sessionId, planVersion: txResult.planVersion },
          {
            idempotencyKey: `swarm:agg:${runId}:v${txResult.planVersion}:${Date.now()}:${uuid().slice(0, 6)}`,
            parentJobId: job.id,
          },
        );
      }
    });
  }

  #handleDispatch(job, { leaseGuard } = {}) {
    const { runId, nodeKeys, planVersion: jobPlanVersion } = job.payload;
    if (!this.#dbOpen()) return;
    return withTraceContext({ runId, jobId: job.id }, () => {
      const toEnqueue = this.store.tx(() => {
        assertLeaseInTx(leaseGuard, { runId });
        const run = this.getRun(runId);
        if (!run || isTerminalRunState(run.status)) return [];
        const replacedKeys = this.#getReplacedNodeKeys(runId);
        const byKey = new Map(run.nodes.map((n) => [n.nodeKey, n]));
        const items = [];
        for (const key of nodeKeys ?? []) {
          const n = byKey.get(key);
          if (!n || n.status !== SWARM_NODE_STATES.QUEUED) continue;
          if (replacedKeys.has(n.nodeKey)) continue;
          if (jobPlanVersion !== undefined && Number(jobPlanVersion) < Number(n.planVersion || 1)) {
            continue;
          }
          items.push({
            runId,
            nodeId: n.id,
            nodeKey: n.nodeKey,
            sessionId: run.sessionId,
            planVersion: n.planVersion || run.planVersion || 1,
            attemptSeq: Number(n.attempts ?? 0) + 1,
          });
        }
        return items;
      });
      for (const payload of toEnqueue) {
        enqueueSwarmJob(this.jobQueue, SWARM_JOB_KINDS.NODE_EXECUTE, payload, {
          parentJobId: job.id,
        });
      }
    });
  }

  async #handleNodeExecute(job, { signal, leaseGuard, workerId = null }) {
    const { runId, nodeId, nodeKey, planVersion: jobPlanVersion } = job.payload;
    if (!this.#dbOpen()) return;
    return withTraceContext({ runId, nodeId, jobId: job.id, workerId, fence: job.fence }, async () => {
      assertLeaseInTx(leaseGuard, { runId });
      const run = this.getRun(runId);
      const node = run?.nodes.find((n) => n.id === nodeId || n.nodeKey === nodeKey);
      if (!run || !node || isTerminalRunState(run.status) || isTerminalNodeState(node.status)) {
        return;
      }
      if (!['ready', 'queued', 'interrupted', 'running'].includes(node.status)) return;

      // Reject obsolete jobs targeting a replaced or already-replanned node version (Audit check (b))
      const replacedKeysAtStart = this.#getReplacedNodeKeys(runId);
      if (replacedKeysAtStart.has(node.nodeKey)) return;
      if (jobPlanVersion !== undefined && Number(jobPlanVersion) < Number(node.planVersion || 1)) {
        return;
      }

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
          nodeAttempt: nextAttempt,
        }) ?? leaseGuard;

      // P0-6: Reconcile any leaked reservations from a dead/expired prior attempt of THIS node before running nextAttempt
      this.budgetLedger?.reconcileStaleNodeReservations?.({
        treeId: runId,
        nodeId: node.id,
        nodeKey: node.nodeKey,
        activeJobId: job.id,
        activeFence: job.fence ?? null,
      });

      // P0-4: If prior attempt's childTurnId ALREADY committed 'completed' before a crash split,
      // converge swarm_nodes directly to COMPLETED without re-running childManager.spawn()!
      if (node.childTurnId) {
        const prevTurn = this.store.db
          .prepare('SELECT id, state FROM direct_turns WHERE id=?')
          .get(node.childTurnId);
        if (prevTurn?.state === 'completed') {
          let verifiedArt = null;
          if (node.isolationMode === 'worktree' && this.artifactManager) {
            const candidate = node.latestArtifactId
              ? this.artifactManager.getArtifact(node.latestArtifactId)
              : this.artifactManager.getLatestNodeArtifact(runId, node.nodeKey);
            if (candidate && this.artifactManager.verifyArtifact(candidate.id).ok) {
              verifiedArt = candidate;
            }
          }
          if (node.isolationMode !== 'worktree' || !this.artifactManager || verifiedArt) {
            const lastMsg = this.store.db
              .prepare(
                "SELECT content FROM direct_messages WHERE turnId=? AND role='assistant' ORDER BY seq DESC LIMIT 1",
              )
              .get(node.childTurnId);
            const resultText = node.resultText || lastMsg?.content || '';
            const uris = [
              ...new Set([
                ...(verifiedArt?.uri ? [verifiedArt.uri] : []),
                ...extractArtifactUris(resultText),
              ]),
            ];
            const converged = transitionSwarmNode(this.store, this.eventRouter, node.id, SWARM_NODE_STATES.COMPLETED, {
              sessionId: run.sessionId,
              rootTurnId: run.rootTurnId,
              leaseGuard: nodeGuard,
              patch: {
                resultText,
                artifactUrisJson: JSON.stringify(uris),
                latestArtifactId: verifiedArt?.id ?? node.latestArtifactId ?? null,
                activeFence: null,
                activeJobId: null,
              },
            });
            if (converged.changed) {
              this.budgetLedger?.syncRunUsage?.(runId, { incrementCompletedNodes: 1 });
            }
            enqueueSwarmJob(
              this.jobQueue,
              SWARM_JOB_KINDS.DEPENDENCY_RESOLVE,
              {
                runId,
                sessionId: run.sessionId,
                planVersion: run.planVersion || 1,
                epoch: Date.now(),
              },
              { idempotencyKey: `swarm:resolve:${runId}:${node.nodeKey}:converged:${uuid().slice(0, 8)}` },
            );
            return;
          }
        }
      }

      // Fix C9 / D8 / P0-4: Before resuming a node that already has prior child execution history,
      // verify no unresolved unknown side effects or lost unarchived worktree writes exist,
      // and check whether a verified archived artifact should be rehydrated into the new worktree.
      let rehydrateFromArtifactId = null;
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
        if (node.isolationMode === 'worktree' && this.artifactManager) {
          const wtRecState = this.artifactManager.inspectWorktreeRecoveryState(node, {
            childSessionId: node.childSessionId,
            childTurnId: node.childTurnId,
          });
          if (wtRecState.state === 'rehydrate_artifact' && wtRecState.artifact?.id) {
            rehydrateFromArtifactId = wtRecState.artifact.id;
          }
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

        // Fix C6: Collect real verified predecessor artifacts directly from durable registry (excluding superseded)
        const predecessorArtifacts = [];
        if (this.artifactManager && node.dependencies.length) {
          for (const depKey of node.dependencies) {
            const dn = byKey.get(depKey);
            let art = dn?.latestArtifactId
              ? this.artifactManager.getArtifact(dn.latestArtifactId)
              : null;
            if (!art || art.status === 'superseded') {
              art = this.artifactManager.getLatestNodeArtifact(runId, depKey);
            }
            if (art && art.status !== 'superseded') predecessorArtifacts.push(art);
          }
        }

        // P0-9: Peek mailbox without consuming; ack atomically inside child turn-start tx!
        const peekedInbox =
          typeof this.mailbox?.peekInbox === 'function'
            ? this.mailbox.peekInbox(node.nodeKey, { runId })
            : [];
        const claimedMessage = typeof this.mailbox?.receive === 'function'
          ? await this.mailbox.receive(node.nodeKey, { runId, visibilityTimeoutMs: 30_000 })
          : null;
        const ackMailboxIds = peekedInbox.map((m) => m.id);
        const inboxMsgs = [
          ...peekedInbox.map((m) => `[协同消息来自 ${m.fromAgentId}]: ${JSON.stringify(m.payload)}`),
          ...(claimedMessage ? [`[统一协同消息来自 ${claimedMessage.fromAgentId}]: ${JSON.stringify(claimedMessage.payload)}`] : []),
        ];
        const fullObjective = [...depResults, ...inboxMsgs, node.objective].join('\n\n');

        const cp = node.childTurnId ? this.checkpointStore?.loadLatest?.(node.childTurnId) : null;
        const treeSnap = this.budgetLedger?.ensureLedger({
          treeId: runId,
          rootSessionId: run.sessionId,
          budget: run.budget,
          initialUsage: run.usage,
          trafficSource: run.trafficSource || 'production',
          isSynthetic: run.isSynthetic ? 1 : 0,
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
          rehydrateFromArtifactId,
          ackMailboxIds,
          claimedCommunicationMessage: claimedMessage,
          budgetLedger: this.budgetLedger,
          budgetScope,
          existingChildSessionId: node.childSessionId || null,
          resumeTurnId: node.childTurnId || null,
          initialStep: cp?.step ?? 0,
          leaseGuard: nodeGuard,
          signal: combinedSignal,
          trafficSource: run.trafficSource || 'production',
          isSynthetic: run.isSynthetic ? 1 : 0,
        });

        assertLeaseInTx(nodeGuard, { runId, nodeId: node.id });

        // P1-10: If child turn was explicitly paused, park the swarm node rather than marking it COMPLETED!
        if (childRes.status === 'paused') {
          transitionSwarmNode(this.store, this.eventRouter, node.id, SWARM_NODE_STATES.PARKED, {
            sessionId: run.sessionId,
            rootTurnId: run.rootTurnId,
            leaseGuard: nodeGuard,
            patch: {
              childSessionId: childRes.childSessionId,
              childTurnId: childRes.childTurnId,
              activeFence: null,
              activeJobId: null,
            },
          });
          return;
        }

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

        // Fix D5 / D7 / Fix E / Audit(b): Single atomic SQLite commit enforcing fence, attempt, planVersion,
        // non-replaced status, and active run status for BOTH ledger-synced usage & node completion!
        const committedNode = this.store.tx(() => {
          assertLeaseInTx(nodeGuard, { runId, nodeId: node.id });
          const curNode = this.store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(node.id);
          if (!curNode || curNode.status !== SWARM_NODE_STATES.RUNNING) {
            throw new RecoveryError('LEASE_LOST', {
              message: `Node ${node.id} no longer running (status=${curNode?.status})`,
            });
          }
          if (curNode.activeFence && job.fence && curNode.activeFence !== job.fence) {
            throw new RecoveryError('LEASE_LOST', {
              message: `Node ${node.id} fence superseded before commit`,
            });
          }
          if (Number(curNode.planVersion || 1) !== Number(node.planVersion || 1)) {
            throw new RecoveryError('LEASE_LOST', {
              message: `Node ${node.id} was replanned concurrently (planVersion ${node.planVersion} -> ${curNode.planVersion})`,
            });
          }
          if (this.#getReplacedNodeKeys(runId).has(node.nodeKey)) {
            throw new RecoveryError('LEASE_LOST', {
              message: `Node ${node.nodeKey} was replaced by split_subgraph concurrently`,
            });
          }
          const curRun = this.store.db.prepare('SELECT status, usageJson FROM swarm_runs WHERE id=?').get(runId);
          if (!curRun || isTerminalRunState(curRun.status)) {
            throw new RecoveryError('LEASE_LOST', {
              message: `Swarm run ${runId} already terminal (${curRun?.status})`,
            });
          }
          const now = Date.now();
          const curUsage = parseJsonSafe(curRun.usageJson, {});
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
          this.store.db
            .prepare('UPDATE swarm_runs SET usageJson=?, updatedAt=? WHERE id=? AND status=?')
            .run(JSON.stringify(nextUsage), now, runId, curRun.status);
          const upd = this.store.db
            .prepare(
              `UPDATE swarm_nodes
               SET status=?, childSessionId=?, childTurnId=?, resultText=?,
                   artifactUrisJson=?, latestArtifactId=COALESCE(?, latestArtifactId),
                   activeFence=NULL, activeJobId=NULL, updatedAt=?
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
          if (!upd.changes) {
            throw new RecoveryError('LEASE_LOST', {
              message: `Concurrent node completion blocked for ${node.id}`,
            });
          }
          return this.store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(node.id);
        });

        try {
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
        } catch {
          // non-fatal event emit
        }

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
            trafficSource: run.trafficSource || 'production',
            isSynthetic: run.isSynthetic ? 1 : 0,
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
        if (!this.#dbOpen()) {
          return;
        }
        // P0-1 & Fix D6/D7: Rethrow LEASE_LOST instead of swallowing it so RecoveryWorker NEVER calls complete() on an expired job!
        if (isLeaseLostError(err) || !checkLeaseHeld(nodeGuard, { runId, nodeId: node.id })) {
          logEvent('warn', 'swarm.node_lease_lost', {
            runId,
            nodeId: node.id,
            nodeKey: node.nodeKey,
            jobId: job.id,
            fence: job.fence,
          });
          throw isLeaseLostError(err)
            ? err
            : new RecoveryError('LEASE_LOST', {
                message: `Lease lost during swarm node ${node.nodeKey} execution`,
                cause: err,
              });
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
            transitionSwarmNode(this.store, this.eventRouter, freshNode.id, SWARM_NODE_STATES.CANCELLED, {
              sessionId: freshRun.sessionId,
              rootTurnId: freshRun.rootTurnId,
              leaseGuard: nodeGuard,
              patch: {
                activeFence: null,
                activeJobId: null,
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
            trafficSource: freshRun.trafficSource || 'production',
            isSynthetic: freshRun.isSynthetic ? 1 : 0,
          });
        });

        let replanOut = { replanned: false };
        if (this.replanner) {
          try {
            replanOut = await this.replanner.replan({
              run: freshRun,
              failedNode: freshNode,
              errorCode,
              errorMessage,
              maxReplans: freshRun.strategy?.maxReplans ?? 2,
              budgetLedger: this.budgetLedger,
              leaseGuard: nodeGuard,
            });
          } catch (replanErr) {
            if (isLeaseLostError(replanErr)) throw replanErr;
            replanOut = { replanned: false };
          }
        }

        if (replanOut?.replanned) {
          // A successful split deliberately terminalizes the superseded node. Verify
          // only the current job/run fence here; checking the old node again would
          // mistake the committed replan for a lease loss and strand the new DAG.
          if (!checkLeaseHeld(leaseGuard, { runId, nodeId: null })) {
            throw new RecoveryError('LEASE_LOST', {
              message: `Lease lost after replan for ${node.nodeKey}`,
            });
          }
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

        transitionSwarmNode(this.store, this.eventRouter, freshNode.id, SWARM_NODE_STATES.FAILED, {
          sessionId: freshRun.sessionId,
          rootTurnId: freshRun.rootTurnId,
          leaseGuard: nodeGuard,
          patch: { activeFence: null, activeJobId: null, errorCode, errorMessage },
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
          { idempotencyKey: `swarm:resolve:${runId}:${freshNode.nodeKey}:fail:${uuid().slice(0, 8)}` },
        );
      }
    });
  }

  #handleAggregate(job, { leaseGuard } = {}) {
    const { runId, planVersion: jobPlanVersion } = job.payload;
    if (!this.#dbOpen()) return;
    return withTraceContext({ runId, jobId: job.id }, () => {
      assertLeaseInTx(leaseGuard, { runId });
      const run = this.getRun(runId);
      if (!run || isTerminalRunState(run.status)) return;
      if (run.status !== SWARM_RUN_STATES.AGGREGATING) return;
      if (jobPlanVersion !== undefined && Number(jobPlanVersion) < Number(run.planVersion || 1)) {
        return;
      }
      const updated = transitionSwarmRun(this.store, runId, SWARM_RUN_STATES.VERIFYING, {
        leaseGuard,
        patch: { currentPhase: 'verifying' },
      });
      if (!updated.changed) return;
      enqueueSwarmJob(
        this.jobQueue,
        SWARM_JOB_KINDS.VERIFY,
        { runId, sessionId: run.sessionId, planVersion: run.planVersion || 1 },
        {
          idempotencyKey: `swarm:ver:${runId}:v${run.planVersion || 1}:${Date.now()}:${uuid().slice(0, 6)}`,
          parentJobId: job.id,
        },
      );
    });
  }

  #handleVerify(job, { leaseGuard } = {}) {
    const { runId, planVersion: jobPlanVersion } = job.payload;
    if (!this.#dbOpen()) return;
    return withTraceContext({ runId, jobId: job.id }, () => {
      assertLeaseInTx(leaseGuard, { runId });
      const run = this.getRun(runId);
      if (!run || isTerminalRunState(run.status)) return;
      if (run.status !== SWARM_RUN_STATES.VERIFYING) return;
      if (jobPlanVersion !== undefined && Number(jobPlanVersion) < Number(run.planVersion || 1)) {
        return;
      }

      // P0-5: Strictly exclude obsolete/replaced nodes from summary & verification inputs
      const replacedKeys = this.#getReplacedNodeKeys(runId);
      const activeNodes = run.nodes.filter((n) => !replacedKeys.has(n.nodeKey));
      const summary = buildSwarmSummary(activeNodes);
      const childSessionIds = activeNodes.map((n) => n.childSessionId).filter(Boolean);
      const childTurnIds = activeNodes.map((n) => n.childTurnId).filter(Boolean);
      const rootTurn = run.rootTurnId
        ? this.store.db.prepare('SELECT state FROM direct_turns WHERE id=?').get(run.rootTurnId)
        : null;
      const rootTurnActive = rootTurn && ['running', 'reconciling', 'parked'].includes(rootTurn.state);
      const allSessionIds = [...new Set([...(rootTurnActive ? [] : [run.sessionId]), ...childSessionIds].filter(Boolean))];
      const rootTurnIds = rootTurn && !['running', 'reconciling', 'parked'].includes(rootTurn.state)
        ? [run.rootTurnId]
        : [];
      const allTurnIds = [...new Set([...rootTurnIds, ...childTurnIds].filter(Boolean))];

      const verdict = this.evidenceVerifier
        ? this.evidenceVerifier.verify({
            text: summary,
            sessionId: rootTurnActive ? null : run.sessionId,
            turnId: rootTurnActive ? null : run.rootTurnId,
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
        const updated = transitionSwarmRun(this.store, runId, finalStatus, {
          leaseGuard,
          patch: {
            currentPhase: finalStatus,
            verdictJson: JSON.stringify(outcome.verdict),
            errorCode: outcome.errorCode,
            errorMessage: outcome.errorMessage,
          },
        });
        didTransition = Boolean(updated.changed);
      }

      const settled = this.getRun(runId);
      if (didTransition) {
        try {
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
        } catch {
          // non-fatal event emit
        }
      }
      this.#notifyWaiters(settled);
    });
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
    const replacedKeys = this.#dbOpen() ? this.#getReplacedNodeKeys(run.id) : new Set();
    const activeNodes = (run.nodes ?? []).filter((n) => !replacedKeys.has(n.nodeKey));
    return {
      runId: run.id,
      status: run.status,
      summary: buildSwarmSummary(activeNodes),
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
