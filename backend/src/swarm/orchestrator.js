import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  transitionNodeTerminalCas,
  transitionRunTerminalCas,
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
import { intersectPolicies } from '../tools/policy.js';
import {
  analyzeWorkspaceRepository,
  detectSiblingWritePathConflicts,
  toCompactRepoContext,
} from './planner.js';
import { buildSharedAciDigest, compactAciMetricsForSharing } from './mailbox.js';
import { buildDeadlineDegradationSummary, remainingRunMs } from './run-deadline.js';
import { TeamOptimizer } from './team-optimizer.js';
import {
  MAX_REVIEWER_FORMAT_RETRIES,
  buildReviewerFormatRepairPrompt,
  buildReviewerPromptConstraints,
  evaluateReviewerHardGate,
  parseReviewerOutput,
  validateReviewerExecution,
} from './reviewer.js';

export { detectSiblingWritePathConflicts, buildSharedAciDigest };

function workspaceHasTests(workspaceRoot) {
  if (!workspaceRoot || !existsSync(workspaceRoot)) return false;
  try {
    const pkgPath = join(workspaceRoot, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = parseJsonSafe(readFileSync(pkgPath, 'utf8'), null);
      const testScript = String(pkg?.scripts?.test ?? '').trim();
      if (testScript && !/no test specified/i.test(testScript)) return true;
    }
    for (const marker of ['pytest.ini', 'pyproject.toml', 'Cargo.toml', 'go.mod']) {
      if (existsSync(join(workspaceRoot, marker))) {
        if (marker !== 'pyproject.toml') return true;
        const py = readFileSync(join(workspaceRoot, marker), 'utf8');
        if (/pytest|test/i.test(py)) return true;
      }
    }
    const checkDir = (dir, depth = 0) => {
      if (depth > 2) return false;
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
        if (e.isDirectory()) {
          if (e.name === 'test' || e.name === 'tests' || e.name === '__tests__') return true;
          if (checkDir(join(dir, e.name), depth + 1)) return true;
        } else if (/\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go)$|^test_.*\.py$/i.test(e.name)) {
          return true;
        }
      }
      return false;
    };
    return checkDir(workspaceRoot, 0);
  } catch {
    return false;
  }
}

function normalizePlannerPermission(mode) {
  const m = String(mode || 'auto-safe').trim();
  if (m === 'readonly' || m === 'read-only' || m === 'approval') return 'readonly';
  if (m === 'full' || m === 'full-access') return 'full';
  return 'auto-safe';
}

function normalizeRuntimePermission(mode) {
  const m = String(mode || 'auto-safe').trim();
  if (m === 'readonly' || m === 'read-only') return 'read-only';
  if (m === 'full' || m === 'full-access') return 'full-access';
  return m;
}

function buildPlannerBudget(budget = {}) {
  if (!budget || typeof budget !== 'object') return {};
  const out = {};
  for (const key of ['maxInputTokens', 'maxOutputTokens', 'maxSteps', 'maxTotalTokens', 'maxCostUsd']) {
    if (budget[key] !== undefined && Number.isFinite(Number(budget[key]))) {
      out[key] = Number(budget[key]);
    }
  }
  return out;
}

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
    experienceMemory = null,
    communicationVisibilityTimeoutMs = 30_000,
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
    this.experienceMemory = experienceMemory;
    this.communicationVisibilityTimeoutMs = Math.max(50, Number(communicationVisibilityTimeoutMs || 30_000));
    this.budgetLedger = budgetLedger ?? (store ? new TaskTreeBudgetLedger(store) : null);
    if (this.replanner && !this.replanner.budgetLedger) {
      this.replanner.budgetLedger = this.budgetLedger;
    }
    if (this.childManager && !this.childManager.budgetLedger) {
      this.childManager.budgetLedger = this.budgetLedger;
    }
    this.deadlineTimers = new Map();
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
    const register = (kind, handle) => recoveryWorker.registerHandler(kind, (job, ctx) => {
      if (this.#armRunDeadline(job.payload.runId)) return handle.call(this, job, ctx);
    });
    register(SWARM_JOB_KINDS.PLAN, this.#handlePlan);
    register(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE, this.#handleDependencyResolve);
    register(SWARM_JOB_KINDS.DISPATCH, this.#handleDispatch);
    register(SWARM_JOB_KINDS.NODE_EXECUTE, this.#handleNodeExecute);
    register(SWARM_JOB_KINDS.AGGREGATE, this.#handleAggregate);
    register(SWARM_JOB_KINDS.VERIFY, this.#handleVerify);
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
    repoContext = null,
  }) {
    const runId = uuid();
    const now = Date.now();
    const initialPlanVersion = Number.isInteger(Number(planVersion)) && Number(planVersion) > 0
      ? Number(planVersion)
      : 1;
    const persistedPlan = plan ? structuredClone(plan) : null;
    const resolvedRepoContext = repoContext
      ? toCompactRepoContext(repoContext)
      : toCompactRepoContext(persistedPlan?.metadata?.repoContext ?? null);
    const strategy = {
      maxConcurrency: Math.min(8, Math.max(1, Number(maxConcurrency || 3))),
      maxReplans: Math.max(0, Number(maxReplans ?? 2)),
      ...(persistedPlan ? { plan: persistedPlan } : {}),
      ...(resolvedRepoContext ? { repoContext: resolvedRepoContext } : {}),
    };
    const usageTotals = { inputTokens: 0, outputTokens: 0, steps: 0, completedNodes: 0 };
    const hasExplicitNodes = Array.isArray(nodes) && nodes.length > 0;
    const routedSpecs = hasExplicitNodes ? this.#prepareNodeSpecs(nodes, budget) : [];
    if (routedSpecs?.writeConflictResolution) {
      strategy.writeConflictResolution = routedSpecs.writeConflictResolution;
    }
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

    if (!this.#armRunDeadline(runId)) {
      const run = this.getRun(runId);
      return { runId, sessionId, status: run.status, run };
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
        planVersion: initialPlanVersion,
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
    const parentRuntimePerm = normalizeRuntimePermission(parentPermissionMode);
    const validated = validatePlan(plan, {
      permissionCeiling: normalizePlannerPermission(parentRuntimePerm),
    });
    const effectiveRunPerm = intersectPolicies(
      { permissionMode: parentRuntimePerm },
      { permissionMode: normalizeRuntimePermission(validated.permissionMode) },
    ).permissionMode;
    const nodes = validated.tasks.map((task) => ({
      nodeKey: task.taskKey,
      objective: task.objective,
      acceptance:
        typeof task.acceptance === 'string'
          ? task.acceptance
          : `${task.acceptance.description} (required evidence: ${task.acceptance.requiredEvidence.join(', ')})`,
      taskType: task.taskType,
      dependencies: task.dependencies,
      permissionMode: normalizeRuntimePermission(task.permissionMode),
      toolAllow: task.toolAllow,
      budget: {
        ...task.budget,
        ...(task.metadata?.finalVerificationReserve != null ? { finalVerificationReserve: task.metadata.finalVerificationReserve } : {}),
        ...(task.metadata?.roleTitle || task.metadata?.focus || Array.isArray(task.metadata?.ownedPaths)
          ? {
              roleMetadata: {
                ...(task.metadata?.roleTitle ? { roleTitle: String(task.metadata.roleTitle) } : {}),
                ...(task.metadata?.focus ? { focus: String(task.metadata.focus) } : {}),
                ...(Array.isArray(task.metadata?.ownedPaths) ? { ownedPaths: task.metadata.ownedPaths } : {}),
              },
            }
          : {}),
      },
      ...(task.metadata?.roleTitle ? { roleTitle: String(task.metadata.roleTitle) } : {}),
      ...(task.metadata?.focus ? { focus: String(task.metadata.focus) } : {}),
      ...(Array.isArray(task.metadata?.ownedPaths) ? { ownedPaths: task.metadata.ownedPaths } : {}),
      ...(Array.isArray(task.metadata?.writePaths) ? { writePaths: task.metadata.writePaths } : {}),
      ...(Array.isArray(task.metadata?.targetFiles) ? { targetFiles: task.metadata.targetFiles } : {}),
      ...(Array.isArray(task.metadata?.files) ? { files: task.metadata.files } : {}),
      isolatedWorktree: Boolean(task.metadata?.isolatedWorktree),
      isolationMode:
        task.metadata?.isolationMode ??
        (task.metadata?.isolatedWorktree ? 'worktree' : null),
      allowIsolationFallback: Boolean(task.metadata?.allowIsolationFallback),
      priority: Number.isFinite(Number(task.metadata?.priority)) ? Number(task.metadata.priority) : 0,
    }));
    const planRepoContext = toCompactRepoContext(
      validated.metadata?.repoContext ?? plan?.metadata?.repoContext ?? null,
    );
    return this.submitRun({
      sessionId,
      rootTurnId,
      goal: validated.goal,
      workspaceRoot,
      parentPermissionMode: effectiveRunPerm,
      maxConcurrency,
      budget: budget ?? validated.budget,
      nodes,
      maxReplans,
      trafficSource,
      isSynthetic,
      planVersion: validated.planVersion,
      plan: validated,
      repoContext: planRepoContext,
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
      if (signal?.aborted) return onAbort();
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
    if (!this.#armRunDeadline(runId)) return this.getRun(runId);

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

  cancelRun(runId, { deadlineExpired = false } = {}) {
    if (!this.#dbOpen()) return null;
    const preRun = this.getRun(runId);
    if (!preRun) return null;

    const now = Date.now();
    const cancelledNodes = [];
    const { transitionedToCancelled, childSessionIds } = this.store.tx(() => {
      const curRun = this.getRun(runId);
      if (!curRun || isTerminalRunState(curRun.status)) return { transitionedToCancelled: false, childSessionIds: [] };

      this.store.db
        .prepare(
          `UPDATE runtime_jobs SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, updatedAt=?
           WHERE taskId=? AND status IN ('pending','active','reconciling','parked')`,
        )
        .run(now, runId);

      const childIds = [];
      for (const n of curRun.nodes) {
        if (!isTerminalNodeState(n.status)) {
          if (n.childSessionId) childIds.push(n.childSessionId);
          const upd = transitionNodeTerminalCas(this.store, null, n.id, SWARM_NODE_STATES.CANCELLED, {
            emitEvent: false,
            patch: { activeFence: null, activeJobId: null, errorCode: deadlineExpired ? 'BUDGET_DURATION_EXCEEDED' : n.errorCode || 'NODE_CANCELLED' },
          });
          if (upd.changed) cancelledNodes.push(upd);
        }
      }

      // Persist before post-commit abort delivery so recovery sees the same terminal state.
      for (const id of childIds) this.childManager?.persistTreeCancellationInTx?.(id, now);
      this.budgetLedger?.reconcileAfterRestart?.({ treeId: runId, reason: 'RUN_CANCELLED' });

      let degradationVerdictJson;
      if (deadlineExpired) {
        const refreshedRun = this.getRun(runId);
        const replacedKeys = this.#getReplacedNodeKeys(runId);
        const activeNodes = (refreshedRun?.nodes ?? []).filter((n) => !replacedKeys.has(n.nodeKey));
        const allArtifacts = this.artifactManager?.listRunArtifacts?.(runId) ?? [];
        const verifiedArtifacts = [];
        for (const art of allArtifacts) {
          if (!art || art.status === 'superseded' || replacedKeys.has(art.nodeKey)) continue;
          let ok = true;
          if (this.artifactManager?.verifyArtifact) {
            try {
              ok = Boolean(this.artifactManager.verifyArtifact(art.id).ok);
            } catch {
              ok = false;
            }
          }
          if (ok) verifiedArtifacts.push(art);
        }
        const degradation = buildDeadlineDegradationSummary({
          run: refreshedRun ?? curRun,
          activeNodes,
          verifiedArtifacts,
          cancelledNodeKeys: cancelledNodes.map((c) => c.nodeKey),
          reason: 'BUDGET_DURATION_EXCEEDED',
        });
        degradationVerdictJson = JSON.stringify({
          verdict: 'fail',
          accepted: false,
          evidenceRequired: true,
          verificationMode: 'deadline_graceful_degradation',
          degradedTimeout: true,
          partialDelivery: degradation.partialDelivery,
          reasons: ['BUDGET_DURATION_EXCEEDED'],
          completedNodes: degradation.completedNodeKeys,
          cancelledNodes: degradation.cancelledNodeKeys,
          preservedArtifacts: degradation.preservedArtifacts,
          preservedArtifactCount: degradation.preservedArtifactCount,
          summary: degradation.summary,
        });
      }

      let didCancelRun = false;
      if (!isTerminalRunState(curRun.status)) {
        const updRun = transitionRunTerminalCas(this.store, runId, SWARM_RUN_STATES.CANCELLED, {
          patch: {
            currentPhase: 'cancelled',
            finishedAt: now,
            ...(deadlineExpired
              ? {
                  errorCode: 'BUDGET_DURATION_EXCEEDED',
                  errorMessage: 'Run wall-clock budget expired',
                  verdictJson: degradationVerdictJson,
                }
              : {}),
          },
        });
        didCancelRun = Boolean(updRun.changed);
      }
      return { transitionedToCancelled: didCancelRun, childSessionIds: childIds };
    });

    this.store.afterCommit(() => {
      if (!transitionedToCancelled) return;
      this.activeControllers.get(runId)?.abort('swarm_cancelled');
      for (const cid of childSessionIds) this.childManager?.abortChildTree?.(cid);
      this.#notifyWaiters(this.getRun(runId));
    });

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
          data: {
            runId,
            status: SWARM_RUN_STATES.CANCELLED,
            usage: finalRun.usage,
            ...(deadlineExpired && finalRun?.verdict?.degradedTimeout
              ? {
                  degradedTimeout: true,
                  preservedArtifacts: finalRun.verdict.preservedArtifacts ?? [],
                  partialDeliverySummary: finalRun.verdict.summary ?? null,
                  verdict: finalRun.verdict,
                }
              : {}),
          },
          audit: true,
        });
      } catch {
        // best-effort event emit
      }
    }
    return finalRun;
  }

  recoverInterruptedRuns() {
    if (this.#dbOpen()) {
      for (const row of this.store.db.prepare("SELECT id FROM swarm_runs WHERE status NOT IN ('failed','completed','cancelled')").all()) {
        this.#armRunDeadline(row.id);
      }
    }
    return recoverInterruptedSwarmRuns({
      store: this.store,
      jobQueue: this.jobQueue,
      reconciler: this.reconciler,
      artifactManager: this.artifactManager,
      eventRouter: this.eventRouter,
      budgetLedger: this.budgetLedger,
      getRun: (id) => this.getRun(id),
      cancelRun: (id, opts) => this.cancelRun(id, opts),
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
    for (const timer of this.deadlineTimers.values()) clearTimeout(timer);
    this.deadlineTimers.clear();
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

      let planned = null;
      let routedSpecs = null;
      let validatedPlan = null;
      let compactRepoContext = run.strategy?.repoContext ?? null;
      if (run.nodes.length === 0) {
        const runSignal = this.#getRunController(runId).signal;
        signal = signal ? AbortSignal.any([signal, runSignal]) : runSignal;
        this.budgetLedger?.ensureLedger({
          treeId: runId,
          rootSessionId: run.sessionId,
          budget: run.budget,
          initialUsage: run.usage,
          trafficSource: run.trafficSource || 'production',
          isSynthetic: run.isSynthetic ? 1 : 0,
        });
        const analyzedRepo =
          !compactRepoContext && run.workspaceRoot
            ? await analyzeWorkspaceRepository(run.workspaceRoot, {
                issueText: goal || run.goal,
              })
            : null;
        if (!compactRepoContext && analyzedRepo) {
          compactRepoContext = toCompactRepoContext(analyzedRepo);
        }
        try {
          signal.throwIfAborted();
          planned = await this.planner.decompose({
            goal: goal || run.goal,
            workspaceRoot: run.workspaceRoot,
            repoContext: analyzedRepo ?? compactRepoContext ?? undefined,
            signal,
            budget: run.budget,
            store: this.store,
            budgetLedger: this.budgetLedger,
            treeId: runId,
            sessionId: run.sessionId,
            leaseGuard,
          });
        } catch (err) {
          if (isLeaseLostError(err)) throw err;
          if (
            err instanceof BudgetError ||
            err?.category === 'budget' ||
            isBudgetErrorCode(err?.code) ||
            err?.code === 'BUDGET_INSUFFICIENT' ||
            err?.code === 'WRITE_PATH_CONFLICT'
          ) {
            const isConflict = err?.code === 'WRITE_PATH_CONFLICT';
            const errorCode = isConflict
              ? 'WRITE_PATH_CONFLICT'
              : (err?.code === 'BUDGET_INSUFFICIENT' ? 'BUDGET_INSUFFICIENT' : 'BUDGET_EXCEEDED');
            const conflictDetail = isConflict ? (err?.detail ?? null) : null;
            const failedRun = transitionRunTerminalCas(this.store, runId, SWARM_RUN_STATES.FAILED, {
              leaseGuard,
              patch: {
                currentPhase: SWARM_RUN_STATES.FAILED,
                errorCode,
                errorMessage: String(err?.message ?? (isConflict ? 'Sibling write-path conflict blocked run' : 'Planning blocked by task-tree budget')),
                ...(conflictDetail
                  ? {
                      strategyJson: JSON.stringify({
                        ...(run.strategy ?? {}),
                        writeConflictResolution: conflictDetail,
                      }),
                      verdictJson: JSON.stringify({
                        accepted: false,
                        verdict: 'fail',
                        reasons: ['write_path_conflict'],
                        writeConflictResolution: conflictDetail,
                      }),
                    }
                  : {}),
              },
            });
            const settled = this.getRun(runId);
            if (failedRun.changed) {
              try {
                this.eventRouter?.emitPersisted({
                  sessionId: run.sessionId,
                  turnId: run.rootTurnId,
                  type: RUNTIME_EVENTS.SWARM_RUN_COMPLETED,
                  data: {
                    runId,
                    status: SWARM_RUN_STATES.FAILED,
                    usage: settled.usage,
                    ...(conflictDetail ? { writeConflictResolution: conflictDetail } : {}),
                  },
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
        signal.throwIfAborted();
        if (!compactRepoContext && planned?.repoContext) {
          compactRepoContext = toCompactRepoContext(planned.repoContext);
        }
        this.planner.validateDag(planned);
        routedSpecs = this.#prepareNodeSpecs(planned, run.budget);
        const conflictResolution =
          routedSpecs?.writeConflictResolution ?? planned?.writeConflictResolution ?? null;
        const planPermission = normalizePlannerPermission(run.permissionMode || 'auto-safe');
        validatedPlan = validatePlan(
          {
            planVersion: Number(run.planVersion || 1),
            goal: String(goal || run.goal || '').trim() || 'Autonomous goal',
            permissionMode: planPermission,
            budget: buildPlannerBudget(run.budget),
            tasks: routedSpecs.map(({ spec: n }) => ({
              taskKey: n.nodeKey,
              objective: n.objective,
              acceptance: n.acceptance,
              taskType: n.taskType || 'research',
              dependencies: Array.isArray(n.dependencies) ? n.dependencies : [],
              permissionMode:
                n.taskType === 'review' || n.taskType === 'research' ? 'readonly' : planPermission,
              toolAllow: Array.isArray(n.toolAllow) ? n.toolAllow : null,
              budget: buildPlannerBudget(n.budget),
              sideEffects: [],
              metadata: {
                priority: Number(n.priority ?? 0),
                isolatedWorktree: Boolean(n.isolatedWorktree),
                ...(n.isolationMode ? { isolationMode: n.isolationMode } : {}),
                allowIsolationFallback: Boolean(n.allowIsolationFallback),
                ...(n.roleTitle ? { roleTitle: n.roleTitle } : {}),
                ...(n.focus ? { focus: n.focus } : {}),
                ...(Array.isArray(n.budget?.ownedPaths) && n.budget.ownedPaths.length > 0 ? { ownedPaths: n.budget.ownedPaths } : {}),
                ...(Array.isArray(n.budget?.writePaths) && n.budget.writePaths.length > 0 ? { writePaths: n.budget.writePaths } : {}),
                ...(Array.isArray(n.budget?.targetFiles) && n.budget.targetFiles.length > 0 ? { targetFiles: n.budget.targetFiles } : {}),
                ...(Array.isArray(n.budget?.files) && n.budget.files.length > 0 ? { files: n.budget.files } : {}),
                ...(n.budget?.finalVerificationReserve != null ? { finalVerificationReserve: n.budget.finalVerificationReserve } : {}),
                ...(n.budget?.budgetBreakdown ? { budgetBreakdown: n.budget.budgetBreakdown } : {}),
              },
            })),
            metadata: {
              ...(compactRepoContext ? { repoContext: compactRepoContext } : {}),
              ...(conflictResolution ? { writeConflictResolution: conflictResolution } : {}),
              ...(planned.length === 1 ? { teamRationale: planned.teamRationale || 'One workstream covers the objective and its acceptance check.' } : {}),
            },
          },
          { permissionCeiling: planPermission },
        );
      }

      const { shouldResolve, effectivePlanVersion } = this.store.tx(() => {
        assertLeaseInTx(leaseGuard, { runId });
        const fresh = this.getRun(runId);
        if (!fresh || isTerminalRunState(fresh.status)) {
          return { shouldResolve: false, effectivePlanVersion: fresh?.planVersion || 1 };
        }
        const conflictResolution =
          routedSpecs?.writeConflictResolution ?? planned?.writeConflictResolution ?? null;
        if (
          (validatedPlan && !fresh.plan) ||
          (compactRepoContext && !fresh.strategy?.repoContext) ||
          (conflictResolution && !fresh.strategy?.writeConflictResolution)
        ) {
          const nextStrategy = {
            ...(fresh.strategy ?? {}),
            ...(validatedPlan && !fresh.plan ? { plan: validatedPlan } : {}),
            ...(compactRepoContext ? { repoContext: compactRepoContext } : {}),
            ...(conflictResolution ? { writeConflictResolution: conflictResolution } : {}),
          };
          this.store.db
            .prepare('UPDATE swarm_runs SET strategyJson=?, updatedAt=? WHERE id=?')
            .run(JSON.stringify(nextStrategy), Date.now(), runId);
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
              const upd = transitionNodeTerminalCas(this.store, null, n.id, SWARM_NODE_STATES.CANCELLED, {
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
            const reviewerMetadata = parseJsonSafe(n.budgetJson, {})?.reviewerMetadata;
            const isAutoReviewer = n.taskType === 'review' && reviewerMetadata?.autoMaterialized === true;
            const failedDeps = n.dependencies.filter((d) =>
              ['failed', 'cancelled'].includes(byKey.get(d)?.status),
            );
            if (failedDeps.length && !isAutoReviewer) {
              changed = true;
              const allBudgetFailed = failedDeps.every((d) =>
                isBudgetErrorCode(byKey.get(d)?.errorCode),
              );
              const upd = allBudgetFailed
                ? transitionNodeTerminalCas(this.store, null, n.id, SWARM_NODE_STATES.CANCELLED, {
                    emitEvent: false,
                    leaseGuard,
                    patch: {
                      errorCode: 'BUDGET_EXCEEDED',
                      errorMessage: `Blocked by budget-exhausted upstream node(s): ${failedDeps.join(', ')}`,
                    },
                  })
                : transitionNodeTerminalCas(this.store, null, n.id, SWARM_NODE_STATES.FAILED, {
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

        // Preflight sibling write-path conflicts before promoting nodes to READY / parallel dispatch
        run = this.getRun(runId);
        const activeConflictCandidates = [];
        const originalDepsByKey = new Map();
        for (const n of run.nodes) {
          if (['completed', 'failed', 'cancelled'].includes(n.status)) continue;
          const parsedBudget = parseJsonSafe(n.budgetJson, {});
          if (parsedBudget?.replacedByNodeKey) continue;
          originalDepsByKey.set(n.nodeKey, Array.isArray(n.dependencies) ? n.dependencies : []);
          const statusRank =
            n.status === SWARM_NODE_STATES.RUNNING || n.status === SWARM_NODE_STATES.QUEUED
              ? 1_000_000
              : (n.status === SWARM_NODE_STATES.READY ? 10_000 : 0);
          activeConflictCandidates.push({
            id: n.id,
            nodeKey: n.nodeKey,
            taskType: n.taskType,
            priority: statusRank + Number(parsedBudget?.priority ?? 0),
            dependencies: Array.isArray(n.dependencies) ? [...n.dependencies] : [],
            ownedPaths: parsedBudget?.ownedPaths,
            writePaths: parsedBudget?.writePaths,
            targetFiles: parsedBudget?.targetFiles,
            files: parsedBudget?.files,
          });
        }
        if (activeConflictCandidates.length > 1) {
          const conflictPolicy = run.budget?.conflictPolicy ?? 'serialize';
          const preflight = detectSiblingWritePathConflicts(activeConflictCandidates, {
            conflictPolicy,
          });
          if (preflight.blocked) {
            const conflictedKeys = new Set(
              preflight.conflicts.flatMap((c) => [c.nodes?.[0], c.nodes?.[1]]).filter(Boolean),
            );
            for (const n of run.nodes) {
              if (!conflictedKeys.has(n.nodeKey)) continue;
              if (n.status !== SWARM_NODE_STATES.PENDING && n.status !== SWARM_NODE_STATES.READY) continue;
              const upd = transitionNodeTerminalCas(this.store, null, n.id, SWARM_NODE_STATES.FAILED, {
                emitEvent: false,
                leaseGuard,
                patch: {
                  errorCode: 'WRITE_PATH_CONFLICT',
                  errorMessage: preflight.message,
                },
              });
              if (upd.changed) postEvents.push(upd);
            }
            const nextStrategy = {
              ...(run.strategy ?? {}),
              writeConflictResolution: preflight.writeConflictResolution,
            };
            const failedRun = transitionRunTerminalCas(this.store, runId, SWARM_RUN_STATES.FAILED, {
              leaseGuard,
              patch: {
                currentPhase: SWARM_RUN_STATES.FAILED,
                errorCode: 'WRITE_PATH_CONFLICT',
                errorMessage: preflight.message,
                strategyJson: JSON.stringify(nextStrategy),
                verdictJson: JSON.stringify({
                  accepted: false,
                  verdict: 'fail',
                  reasons: ['write_path_conflict'],
                  writeConflictResolution: preflight.writeConflictResolution,
                }),
              },
            });
            return {
              action: 'blocked_conflict',
              runFailed: failedRun.changed,
              writeConflictResolution: preflight.writeConflictResolution,
            };
          }
          if (preflight.addedEdges.length > 0) {
            const nowMs = Date.now();
            const updateNodeStmt = this.store.db.prepare(
              'UPDATE swarm_nodes SET dependenciesJson=?, budgetJson=?, updatedAt=? WHERE id=?',
            );
            for (const updatedSpec of preflight.nodes) {
              const prevDeps = originalDepsByKey.get(updatedSpec.nodeKey) ?? [];
              const nextDeps = Array.isArray(updatedSpec.dependencies) ? updatedSpec.dependencies : prevDeps;
              const existingRow = run.nodes.find((rn) => rn.nodeKey === updatedSpec.nodeKey);
              if (!existingRow) continue;
              if (
                nextDeps.length !== prevDeps.length ||
                updatedSpec.writeConflictResolution
              ) {
                const parsedBudget = parseJsonSafe(existingRow.budgetJson, {});
                const nextBudget = {
                  ...parsedBudget,
                  ...(updatedSpec.writeConflictResolution
                    ? { writeConflictResolution: updatedSpec.writeConflictResolution }
                    : {}),
                };
                updateNodeStmt.run(
                  JSON.stringify(nextDeps),
                  JSON.stringify(nextBudget),
                  nowMs,
                  existingRow.id,
                );
              }
            }
            const nextStrategy = {
              ...(run.strategy ?? {}),
              writeConflictResolution: preflight.writeConflictResolution,
            };
            this.store.db
              .prepare('UPDATE swarm_runs SET strategyJson=?, updatedAt=? WHERE id=?')
              .run(JSON.stringify(nextStrategy), nowMs, runId);
          }
        }

        // Promote dependency-satisfied pending nodes -> ready, and demote any invalidly READY node with unsatisfied deps -> pending
        run = this.getRun(runId);
        const byKey = new Map(run.nodes.map((n) => [n.nodeKey, n]));
        for (const n of run.nodes) {
          const reviewerMetadata = parseJsonSafe(n.budgetJson, {})?.reviewerMetadata;
          const isAutoReviewer = n.taskType === 'review' && reviewerMetadata?.autoMaterialized === true;
          const allDepsCompleted = n.dependencies.every(
            (d) => byKey.get(d)?.status === SWARM_NODE_STATES.COMPLETED,
          );
          const allDepsSettled = n.dependencies.every((d) => {
            const status = byKey.get(d)?.status;
            return ['completed', 'failed', 'cancelled'].includes(status);
          });
          const dependenciesReady = isAutoReviewer ? allDepsSettled : allDepsCompleted;
          if (n.status === SWARM_NODE_STATES.PENDING && dependenciesReady) {
            const upd = transitionSwarmNode(this.store, null, n.id, SWARM_NODE_STATES.READY, {
              emitEvent: false,
              leaseGuard,
            });
            if (upd.changed) postEvents.push(upd);
          } else if (n.status === SWARM_NODE_STATES.READY && !dependenciesReady) {
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
        // A queued child has not reserved its first inference yet. Do not spend
        // the same finite budget on another wave during a duplicate resolve.
        const bounded = liveSnap?.remainingTokens != null || liveSnap?.remainingSteps != null || run.budget?.maxCost != null;
        const dispatchSlots = bounded && inFlight ? 0 : Math.max(0, Math.min(maxConc - inFlight, stepSlots));
        const picked = readyNodes.slice(0, dispatchSlots);

        if (picked.length > 0) {
          const candidates = (this.router?.modelRegistry?.list?.() ?? []).map((candidate) => {
            const effective = this.capabilityRegistry?.getEffectiveCapability?.(candidate.model ?? candidate.id);
            return effective?.measured
              ? {
                  ...candidate,
                  capabilities: effective.effective,
                  effectiveCapabilities: effective.effective,
                  capabilityEvidence: effective.measured,
                }
              : candidate;
          });
          const budgetSnapshot = liveSnap ?? null;
          const taskRequirements = picked.reduce((acc, node) => {
            const parsed = parseJsonSafe(node.budgetJson, {});
            const required = parsed.requiredCapabilities ?? parsed.capabilityWeights ?? {};
            for (const [dimension, weight] of Object.entries(required)) {
              acc[dimension] = Math.max(Number(acc[dimension] ?? 0), Number(weight) || 0);
            }
            return acc;
          }, {});
          const workstreamRoles = picked.map((node) => {
            const parsed = parseJsonSafe(node.budgetJson, {});
            return parsed.roleMetadata
              ? { nodeKey: node.nodeKey, taskType: node.taskType, ...parsed.roleMetadata }
              : { nodeKey: node.nodeKey, taskType: node.taskType };
          });
          const team = this.teamOptimizer.optimize({
            task: {
              taskType: picked.length > 1 ? 'implementation' : picked[0].taskType,
              complexity: picked.length > 1 ? 'complex' : 'simple',
              independentWorkstreams: picked.length,
              requiredCapabilities: taskRequirements,
              workstreamRoles,
              requiresIndependentVerification: picked.some((n) => n.taskType === 'verification'),
              artifactRisk: picked.some((n) => n.isolationMode === 'worktree') ? 'high' : undefined,
            },
            candidates,
            budget: run.budget,
            budgetSnapshot,
            maxConcurrency: Math.min(maxConc, picked.length),
            reviewerAvailable: picked.some((n) => n.taskType === 'verification' || n.isolationMode === 'worktree' || n.taskType === 'review'),
          });
          const dispatchCount = team.mode === 'team'
            ? team.members.length
            : team.parallelBudgetAllowed !== false && !team.budgetDowngraded
              ? team.parallelSlots ?? picked.length
              : 1;
          const batch = picked.slice(0, dispatchCount);
          const reviewerNode = this.#materializeReviewerNode({
            run,
            team,
            picked: batch,
            candidates,
            budgetSnapshot,
            now: Date.now(),
          });
          if (reviewerNode) postEvents.push({ ...reviewerNode, runId, changed: true });
          const queuedKeys = [];
          for (const [index, n] of batch.entries()) {
            const selectedMember = team.members?.[index] ?? team.members?.[0];
            const nodeBudget = parseJsonSafe(n.budgetJson, {});
            const isMaterializedReviewer = nodeBudget?.reviewerMetadata?.autoMaterialized === true;
            if (
              selectedMember &&
              !isMaterializedReviewer &&
              Number(n.attempts ?? 0) === 0 &&
              Number(n.planVersion ?? 1) <= 1
            ) {
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
              reviewer: team.reviewer
                ? {
                    id: team.reviewer.id,
                    nodeKey: reviewerNode?.nodeKey ?? null,
                    materialized: Boolean(reviewerNode),
                  }
                : null,
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
            if (typeof this.mailbox?.receive === 'function' && typeof this.mailbox?.ack === 'function') {
              const pendingClaim = await this.mailbox.receive(node.nodeKey, {
                runId,
                visibilityTimeoutMs: this.communicationVisibilityTimeoutMs,
              });
              if (pendingClaim?.messageId) {
                const agentId = pendingClaim.toAgentId || node.nodeKey;
                if (pendingClaim.deliveryBinding?.childTurnId === node.childTurnId) {
                  await this.mailbox.ack(pendingClaim.messageId, agentId, pendingClaim.deliveryToken);
                } else {
                  await this.mailbox.retry?.(pendingClaim.messageId, agentId, {
                    delayMs: 0,
                    deliveryToken: pendingClaim.deliveryToken,
                  });
                }
              }
            }
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
            const converged = transitionNodeTerminalCas(this.store, this.eventRouter, node.id, SWARM_NODE_STATES.COMPLETED, {
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
            const convergedRow = this.store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(node.id) ?? node;
            await this.#publishHandoffsAndDrainInbox(convergedRow, runId, uris);
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

        // Collect all transitive non-superseded upstream artifacts in topological order for worktree overlay
        const dependenciesByNodeKey = Object.fromEntries(
          run.nodes.map((n) => [n.nodeKey, Array.isArray(n.dependencies) ? n.dependencies : []]),
        );
        const visitedAncestors = new Set();
        const orderedAncestors = [];
        const visitAncestor = (depKey) => {
          if (!depKey || visitedAncestors.has(depKey) || replacedKeysAtStart.has(depKey)) return;
          visitedAncestors.add(depKey);
          const dn = byKey.get(depKey);
          if (dn && Array.isArray(dn.dependencies)) {
            for (const parentKey of dn.dependencies) {
              visitAncestor(parentKey);
            }
          }
          orderedAncestors.push(depKey);
        };
        for (const depKey of node.dependencies) {
          visitAncestor(depKey);
        }

        const predecessorArtifacts = [];
        if (this.artifactManager && orderedAncestors.length > 0) {
          for (const depKey of orderedAncestors) {
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
          ? await this.mailbox.receive(node.nodeKey, {
              runId,
              visibilityTimeoutMs: this.communicationVisibilityTimeoutMs,
            })
          : null;
        const existingBinding = claimedMessage?.deliveryBinding ?? null;
        const bindingMatchesNode =
          existingBinding &&
          existingBinding.runId === run.id &&
          (existingBinding.nodeId == null || existingBinding.nodeId === node.id);
        const effectiveChildSessionId =
          node.childSessionId || (bindingMatchesNode ? existingBinding.childSessionId : null);
        const effectiveChildTurnId =
          node.childTurnId || (bindingMatchesNode ? existingBinding.childTurnId : null);

        if (!node.childTurnId && effectiveChildTurnId) {
          const boundTurn = this.store.db
            .prepare('SELECT id, state FROM direct_turns WHERE id=?')
            .get(effectiveChildTurnId);
          if (boundTurn?.state === 'completed') {
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
              if (claimedMessage?.messageId && this.mailbox?.ack) {
                await this.mailbox.ack(
                  claimedMessage.messageId,
                  claimedMessage.toAgentId || node.nodeKey,
                  claimedMessage.deliveryToken,
                );
              }
              const lastMsg = this.store.db
                .prepare(
                  "SELECT content FROM direct_messages WHERE turnId=? AND role='assistant' ORDER BY seq DESC LIMIT 1",
                )
                .get(effectiveChildTurnId);
              const resultText = node.resultText || lastMsg?.content || '';
              const uris = [
                ...new Set([
                  ...(verifiedArt?.uri ? [verifiedArt.uri] : []),
                  ...extractArtifactUris(resultText),
                ]),
              ];
              const converged = transitionNodeTerminalCas(this.store, this.eventRouter, node.id, SWARM_NODE_STATES.COMPLETED, {
                sessionId: run.sessionId,
                rootTurnId: run.rootTurnId,
                leaseGuard: nodeGuard,
                patch: {
                  childSessionId: effectiveChildSessionId,
                  childTurnId: effectiveChildTurnId,
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
              const convergedRow = this.store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(node.id) ?? node;
              await this.#publishHandoffsAndDrainInbox(convergedRow, runId, uris);
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

        const alreadyBoundToTurn = Boolean(
          existingBinding?.childTurnId &&
          effectiveChildTurnId &&
          existingBinding.childTurnId === effectiveChildTurnId,
        );
        const ackMailboxIds = peekedInbox.map((m) => m.id);
        const inboxMsgs = [
          ...peekedInbox.map((m) => `[协同消息来自 ${m.fromAgentId}]: ${JSON.stringify(m.payload)}`),
          ...(claimedMessage && !alreadyBoundToTurn
            ? [`[统一协同消息来自 ${claimedMessage.fromAgentId}]: ${JSON.stringify(claimedMessage.payload)}`]
            : []),
        ];
        const upstreamAciEntries = [];
        const seenAciNodes = new Set();
        const addUpstreamAci = (key, aciMetrics) => {
          if (!aciMetrics || typeof aciMetrics !== 'object') return;
          const k = String(key || '').trim();
          if (k && seenAciNodes.has(k)) return;
          if (k) seenAciNodes.add(k);
          upstreamAciEntries.push({ nodeKey: k || undefined, aciMetrics });
        };
        for (const depKey of orderedAncestors) {
          const dn = byKey.get(depKey);
          if (!dn || dn.status !== SWARM_NODE_STATES.COMPLETED) continue;
          const dnBudget = parseJsonSafe(dn.budgetJson, {});
          addUpstreamAci(depKey, dnBudget?.aciMetrics);
        }
        for (const rn of run.nodes) {
          if (
            rn.nodeKey === node.nodeKey ||
            rn.status !== SWARM_NODE_STATES.COMPLETED ||
            replacedKeysAtStart.has(rn.nodeKey)
          ) {
            continue;
          }
          const rnBudget = parseJsonSafe(rn.budgetJson, {});
          addUpstreamAci(rn.nodeKey, rnBudget?.aciMetrics);
        }
        for (const msg of peekedInbox) {
          addUpstreamAci(msg?.fromAgentId, msg?.payload?.aciMetrics);
        }
        if (claimedMessage && !alreadyBoundToTurn && claimedMessage?.payload?.aciMetrics) {
          addUpstreamAci(claimedMessage.fromAgentId, claimedMessage.payload.aciMetrics);
        }
        let sharedAciDigest = buildSharedAciDigest(upstreamAciEntries, { maxChars: 1600 });
        if (!sharedAciDigest) {
          const fallbackDigest =
            peekedInbox.find((m) => typeof m?.payload?.sharedAciDigest === 'string' && m.payload.sharedAciDigest.trim())
              ?.payload?.sharedAciDigest ||
            (claimedMessage &&
            !alreadyBoundToTurn &&
            typeof claimedMessage?.payload?.sharedAciDigest === 'string' &&
            claimedMessage.payload.sharedAciDigest.trim()
              ? claimedMessage.payload.sharedAciDigest
              : '');
          if (fallbackDigest) {
            const trimmed = fallbackDigest.trim();
            const withHdr = trimmed.startsWith('[Shared Swarm ACI Digest]')
              ? trimmed
              : `[Shared Swarm ACI Digest]\n${trimmed}`;
            sharedAciDigest = withHdr.length <= 1600 ? withHdr : `${withHdr.slice(0, 1597)}...`;
          }
        }
        let fullObjective = [
          ...depResults,
          ...inboxMsgs,
          ...(sharedAciDigest ? [sharedAciDigest] : []),
          node.objective,
        ].join('\n\n');
        const reviewerEvidence = this.#buildReviewerEvidenceContext({ run, node, byKey });
        if (reviewerEvidence) {
          fullObjective = [
            fullObjective,
            '[独立 Reviewer 执行约束]',
            '你是独立 Reviewer。不得把前置 Agent 的自然语言结论当作事实；必须使用 read_swarm_artifact 检查提供的持久化产物，并依据下面的 durable receipt/verdict/evidence 清单形成审查结论。Reviewer 只读，不得修改工作区。',
            buildReviewerPromptConstraints(reviewerEvidence),
            '[Durable evidence manifest]',
            JSON.stringify(reviewerEvidence),
          ].join('\n\n');
        }

        const parsedNodeMetaBudget = parseJsonSafe(node.budgetJson, {});
        const roleMetadata = parsedNodeMetaBudget?.roleMetadata ?? null;
        const repoContext = run.strategy?.repoContext ?? null;
        const repoCmds = repoContext?.testCommands ?? [];
        if (repoContext && node.taskType !== 'review') {
          const ctxParts = [];
          const summary = String(repoContext.summaryText || '').trim();
          if (summary) {
            ctxParts.push(summary.slice(0, 3200));
          } else if (repoCmds.length > 0 && (node.taskType === 'verification' || node.taskType === 'implementation')) {
            ctxParts.push(`Verification Commands: ${repoCmds.join(' ; ')}`);
          }
          if (repoContext.hasNodeModules === false) {
            const ownedHint =
              Array.isArray(roleMetadata?.ownedPaths) && roleMetadata.ownedPaths.length > 0
                ? ` Stay strictly focused on your assigned ownedPaths (${roleMetadata.ownedPaths.join(', ')}) and avoid broad repo sweeps.`
                : '';
            ctxParts.push(
              `Environment Note: local node_modules/ is not installed in this checkout; devDependency CLIs and npm scripts that invoke them (tsc, tsd, eslint, prettier, jest, vitest, npm run check:type:*) are unavailable locally — validate changes using built-in Node runtime checks (e.g., node --test <file>, node --check) or careful static inspection, and never retry missing devDependencies or failing npm type/lint scripts.${ownedHint}`,
            );
          }
          if (ctxParts.length > 0) {
            fullObjective = `${fullObjective}\n\n[Repository Intelligence Context]\n${ctxParts.join('\n\n')}`;
          }
        }

        const cp = effectiveChildTurnId ? this.checkpointStore?.loadLatest?.(effectiveChildTurnId) : null;
        const treeSnap = this.budgetLedger?.ensureLedger({
          treeId: runId,
          rootSessionId: run.sessionId,
          budget: run.budget,
          initialUsage: run.usage,
          trafficSource: run.trafficSource || 'production',
          isSynthetic: run.isSynthetic ? 1 : 0,
        });
        const effectiveNodeBudget = computeEffectiveNodeBudget(node.budget, treeSnap, { ...run.budget, maxDurationMs: remainingRunMs(run) });
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
          profile: { id: node.agentProfileId, ...(roleMetadata ?? {}) },
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
          planVersion: Number(node.planVersion || run.planVersion || 1),
          evidenceContract: node.evidenceContract ?? null,
          workerId,
          predecessorArtifacts,
          dependenciesByNodeKey,
          rehydrateFromArtifactId,
          ackMailboxIds,
          claimedCommunicationMessage: claimedMessage,
          budgetLedger: this.budgetLedger,
          budgetScope,
          existingChildSessionId: effectiveChildSessionId,
          resumeTurnId: effectiveChildTurnId,
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

        let finalChildResult = childRes;
        const parsedNodeBudget = parseJsonSafe(node.budgetJson, {});

        // Inspect real shell/test command outcome for verification nodes before committing completion
        let latestVerifySummary = null;
        if (node.taskType === 'verification') {
          latestVerifySummary = this.#inspectVerificationShellOutcome(
            childRes.childSessionId,
            childRes.childTurnId,
            childRes.text,
            childRes.verifiedPass,
          );
          if (latestVerifySummary && latestVerifySummary.status === 'failed') {
            throw new RuntimeError('VERIFICATION_FAILED', {
              message: `Verification node ${node.nodeKey} failed${latestVerifySummary.command ? ` (${latestVerifySummary.command})` : ''} with exitCode=${latestVerifySummary.exitCode}`,
              usage: childRes.usage,
              steps: childRes.steps,
              detail: {
                verificationResult: latestVerifySummary,
                failureDiagnostics: [
                  latestVerifySummary.command ? `Command: ${latestVerifySummary.command}` : null,
                  `Exit code: ${latestVerifySummary.exitCode}`,
                  latestVerifySummary.summary ? `Output:\n${latestVerifySummary.summary}` : null,
                ]
                  .filter(Boolean)
                  .join('\n'),
                verdict: { accepted: false, verdict: 'fail' },
              },
            });
          }
        }

        const hasShellReceiptsForReview = (reviewerEvidence?.receipts ?? []).some((r) =>
          ['bash', 'run_command', 'shell'].includes(String(r?.toolName ?? '').toLowerCase()),
        );
        const hasTestsConfigured =
          (run.strategy?.repoContext?.testCommands?.length ?? 0) > 0 ||
          workspaceHasTests(fallbackWorkspace);
        const hasVerificationSourceNode = (reviewerEvidence?.sourceNodes ?? []).some(
          (sn) => sn?.verificationResult != null || (sn?.taskType === 'verification' && hasTestsConfigured),
        );
        const runHasDownstreamVerification = (run.nodes ?? []).some(
          (rn) =>
            !replacedKeysAtStart.has(rn.nodeKey) &&
            rn.taskType === 'verification' &&
            !(reviewerEvidence?.sourceNodes ?? []).some((sn) => sn.nodeKey === rn.nodeKey),
        );
        const buildReviewerGateOpts = (candidateText) => {
          const claimsTestsText =
            /\btests?\s+(?:pass|passed|passing|succeed(?:ed)?)\b|\ball\s+tests\b|\bnpm\s+test\b|\bnode\s+--test\b/i.test(
              String(candidateText ?? ''),
            );
          const reqTest =
            run.budget?.requireTestExecution !== undefined
              ? Boolean(run.budget.requireTestExecution)
              : Boolean(
                  run.budget?.reviewerHardGate ||
                  run.budget?.hardGate ||
                  hasShellReceiptsForReview ||
                  hasVerificationSourceNode ||
                  claimsTestsText ||
                  (hasTestsConfigured && !runHasDownstreamVerification),
                );
          return {
            workspaceRoot: fallbackWorkspace,
            artifactManager: this.artifactManager,
            ...(run.budget?.hardGate !== undefined || run.budget?.reviewerHardGate !== undefined
              ? { hardGate: Boolean(run.budget?.hardGate ?? run.budget?.reviewerHardGate) }
              : {}),
            ...(run.budget?.requireGitDiff !== undefined
              ? { requireGitDiff: Boolean(run.budget.requireGitDiff) }
              : {}),
            ...(run.budget?.claimedMutations !== undefined
              ? { claimedMutations: Boolean(run.budget.claimedMutations) }
              : {}),
            requireTestExecution: reqTest,
          };
        };

        const strictReviewerRequired = Boolean(
          node.taskType === 'review' &&
          reviewerEvidence &&
          (
            (parsedNodeBudget?.reviewerMetadata?.autoMaterialized === true &&
              childRes.childSessionId &&
              childRes.childTurnId) ||
            parsedNodeBudget?.strictReviewerSchema === true ||
            run.budget?.strictReviewerSchema === true
          ),
        );
        let reviewerValidation = null;
        let reviewerFormatRetriesUsed = 0;
        let trackedReviewerResult = childRes;
        if (strictReviewerRequired) {
          const trackedTurnIds = new Set([childRes.childTurnId].filter(Boolean));
          const readReviewerReceipts = () => {
            if (!childRes.childSessionId || !this.store?.db?.isOpen) return [];
            const ids = [...trackedTurnIds];
            if (ids.length > 0) {
              return this.store.db
                .prepare(
                  `SELECT id, sessionId, turnId, callId, toolName, status, exitCode, outputDigest, errorCode, createdAt, updatedAt
                   FROM tool_receipts
                   WHERE sessionId=? AND turnId IN (${ids.map(() => '?').join(',')})
                   ORDER BY createdAt ASC`,
                )
                .all(childRes.childSessionId, ...ids);
            }
            return this.store.db
              .prepare(
                `SELECT id, sessionId, turnId, callId, toolName, status, exitCode, outputDigest, errorCode, createdAt, updatedAt
                 FROM tool_receipts
                 WHERE sessionId=?
                 ORDER BY createdAt ASC`,
              )
              .all(childRes.childSessionId);
          };

          const originalRawText = String(childRes.text ?? '');
          let receipts = readReviewerReceipts();
          reviewerValidation = validateReviewerExecution({
            rawText: originalRawText,
            reviewerEvidence,
            toolReceipts: receipts,
            originalRawText: null,
            ...buildReviewerGateOpts(originalRawText),
          });

          while (
            !reviewerValidation.valid &&
            reviewerValidation.code === 'REVIEWER_OUTPUT_MALFORMED' &&
            reviewerFormatRetriesUsed < MAX_REVIEWER_FORMAT_RETRIES &&
            typeof this.childManager?.resume === 'function' &&
            childRes.childSessionId
          ) {
            reviewerFormatRetriesUsed++;
            const repairPrompt = buildReviewerFormatRepairPrompt({
              originalRawText,
              errors: reviewerValidation.errors,
              reviewerEvidence,
            });
            const repaired = await this.childManager.resume(childRes.childSessionId, {
              objective: repairPrompt,
              model: node.model,
              maxSteps: 1,
              signal: combinedSignal,
              runId: run.id,
              nodeId: node.id,
              nodeKey: node.nodeKey,
              budgetLedger: this.budgetLedger,
              budgetScope: BUDGET_SCOPES.REVIEW_VERIFICATION,
              leaseGuard: nodeGuard,
              permissionMode: 'read-only',
              allowedTools: Array.isArray(node.toolAllow) ? node.toolAllow : undefined,
            });
            if (repaired?.childTurnId) trackedTurnIds.add(repaired.childTurnId);
            trackedReviewerResult = {
              ...repaired,
              text: String(repaired?.text ?? ''),
              childSessionId: repaired?.childSessionId || childRes.childSessionId,
              childTurnId: repaired?.childTurnId || childRes.childTurnId,
              usage: {
                inputTokens:
                  Number(trackedReviewerResult?.usage?.inputTokens ?? 0) +
                  Number(repaired?.usage?.inputTokens ?? 0),
                outputTokens:
                  Number(trackedReviewerResult?.usage?.outputTokens ?? 0) +
                  Number(repaired?.usage?.outputTokens ?? 0),
              },
              steps:
                Number(trackedReviewerResult?.steps ?? 0) +
                Number(repaired?.steps ?? 0),
            };
            receipts = readReviewerReceipts();
            reviewerValidation = validateReviewerExecution({
              rawText: trackedReviewerResult.text,
              reviewerEvidence,
              toolReceipts: receipts,
              originalRawText,
              ...buildReviewerGateOpts(trackedReviewerResult.text),
            });
          }

          if (!reviewerValidation.valid && reviewerValidation.code !== 'REVIEWER_HARD_GATE_FAILED') {
            throw new RuntimeError(reviewerValidation.code || 'REVIEWER_OUTPUT_MALFORMED', {
              message: `Reviewer node ${node.nodeKey} failed validation (${reviewerValidation.code}): ${reviewerValidation.errors.join('; ')}`,
              usage: trackedReviewerResult?.usage ?? childRes.usage,
              detail: {
                reviewerValidation,
                formatRetriesUsed: reviewerFormatRetriesUsed,
                verdict: { accepted: false, verdict: 'fail' },
              },
            });
          }

          finalChildResult = {
            ...trackedReviewerResult,
            text: reviewerValidation.rawJsonText || trackedReviewerResult.text,
            verifiedPass:
              reviewerValidation.code === 'REVIEWER_HARD_GATE_FAILED'
                ? false
                : reviewerValidation.status === 'pass',
          };
        }

        let nonStrictReviewerVerdict = null;
        if (node.taskType === 'review' && !strictReviewerRequired) {
          const parsedReview = parseReviewerOutput(finalChildResult.text);
          if (parsedReview?.valid && parsedReview.normalized) {
            const hardGate = reviewerEvidence
              ? evaluateReviewerHardGate({
                  parsedVerdict: parsedReview.normalized,
                  reviewerEvidence,
                  ...buildReviewerGateOpts(finalChildResult.text),
                })
              : null;
            const downgradedByHardGate = Boolean(
              hardGate && !hardGate.hardGatePassed && parsedReview.status === 'pass',
            );
            const effectiveStatus = downgradedByHardGate
              ? hardGate.verdict
              : parsedReview.normalized.verdict;
            if (downgradedByHardGate) {
              finalChildResult = {
                ...finalChildResult,
                verifiedPass: false,
              };
            }
            nonStrictReviewerVerdict = {
              schemaVersion: parsedReview.normalized.schemaVersion ?? 1,
              status: effectiveStatus,
              ...(downgradedByHardGate ? { downgradedFrom: 'pass', hardGateRejected: true } : {}),
              summary: parsedReview.normalized.summary ?? '',
              checkedArtifacts: parsedReview.normalized.checkedArtifacts ?? [],
              evidenceRefs: parsedReview.normalized.evidenceRefs ?? [],
              findings: parsedReview.normalized.findings ?? [],
              ...(hardGate ? { reviewerVerification: hardGate } : {}),
              reviewerModel: node.model,
              validatedAt: Date.now(),
            };
          } else if (
            reviewerEvidence &&
            (run.budget?.hardGate === true ||
              run.budget?.reviewerHardGate === true ||
              run.budget?.requireGitDiff === true ||
              run.budget?.requireTestExecution === true)
          ) {
            const hardGate = evaluateReviewerHardGate({
              parsedVerdict: {
                verdict: finalChildResult.verifiedPass === false ? 'fail' : 'pass',
                summary: String(finalChildResult.text ?? ''),
              },
              reviewerEvidence,
              ...buildReviewerGateOpts(finalChildResult.text),
            });
            if (!hardGate.hardGatePassed) {
              finalChildResult = {
                ...finalChildResult,
                verifiedPass: false,
              };
              nonStrictReviewerVerdict = {
                schemaVersion: 1,
                status: hardGate.verdict,
                downgradedFrom: 'pass',
                hardGateRejected: true,
                summary: String(finalChildResult.text ?? '').slice(0, 500),
                checkedArtifacts: [],
                evidenceRefs: [],
                findings: [],
                reviewerVerification: hardGate,
                reviewerModel: node.model,
                validatedAt: Date.now(),
              };
            }
          }
        }

        const uris = [
          ...new Set([
            ...(finalChildResult.artifact?.uri ? [finalChildResult.artifact.uri] : []),
            ...extractArtifactUris(finalChildResult.text),
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
                inputTokens: Number(curUsage.inputTokens ?? 0) + Number(finalChildResult.usage?.inputTokens ?? 0),
                outputTokens: Number(curUsage.outputTokens ?? 0) + Number(finalChildResult.usage?.outputTokens ?? 0),
                steps: Number(curUsage.steps ?? 0) + Number(finalChildResult.steps ?? 0),
                completedNodes: Number(curUsage.completedNodes ?? 0) + 1,
              };
          const parsedCurBudget = parseJsonSafe(curNode.budgetJson, {});
          const baseBudgetObj =
            parsedCurBudget && typeof parsedCurBudget === 'object' && !Array.isArray(parsedCurBudget)
              ? parsedCurBudget
              : {};
          const resolvedReviewVerdict =
            reviewerValidation && reviewerValidation.verdict
              ? {
                  schemaVersion: reviewerValidation.verdict.schemaVersion,
                  status: reviewerValidation.status,
                  ...(reviewerValidation.code === 'REVIEWER_HARD_GATE_FAILED'
                    ? { downgradedFrom: 'pass', hardGateRejected: true }
                    : {}),
                  summary: reviewerValidation.verdict.summary,
                  evidenceDigest: reviewerValidation.evidenceDigest,
                  checkedArtifacts: reviewerValidation.verdict.checkedArtifacts,
                  evidenceRefs: reviewerValidation.verdict.evidenceRefs,
                  findings: reviewerValidation.verdict.findings,
                  ...(reviewerValidation.reviewerVerification
                    ? { reviewerVerification: reviewerValidation.reviewerVerification }
                    : {}),
                  formatRetriesUsed: reviewerFormatRetriesUsed,
                  readArtifactCount: reviewerValidation.readArtifactCount,
                  reviewerModel: node.model,
                  validatedAt: now,
                }
              : nonStrictReviewerVerdict;
          const compactChildAci = compactAciMetricsForSharing(
            finalChildResult?.aciMetrics ?? finalChildResult?.reasoningMetrics?.aciMetrics ?? null,
          );
          const mergedBudgetObj = { ...baseBudgetObj };
          if (resolvedReviewVerdict) {
            mergedBudgetObj.reviewerVerdict = resolvedReviewVerdict;
          }
          if (latestVerifySummary) {
            mergedBudgetObj.verificationResult = latestVerifySummary;
          }
          if (compactChildAci) {
            mergedBudgetObj.aciMetrics = compactChildAci;
          }
          const mergedBudgetJson =
            resolvedReviewVerdict || latestVerifySummary || compactChildAci
              ? JSON.stringify(mergedBudgetObj)
              : curNode.budgetJson;
          this.store.db
            .prepare(
              `UPDATE swarm_runs
               SET usageJson=?, updatedAt=?
               WHERE id=? AND status=? AND status NOT IN ('completed','failed','cancelled')`,
            )
            .run(JSON.stringify(nextUsage), now, runId, curRun.status);
          const upd = this.store.db
            .prepare(
              `UPDATE swarm_nodes
               SET status=?, childSessionId=?, childTurnId=?, resultText=?,
                   artifactUrisJson=?, latestArtifactId=COALESCE(?, latestArtifactId),
                   budgetJson=?,
                   activeFence=NULL, activeJobId=NULL, updatedAt=?
               WHERE id=? AND status='running' AND status NOT IN ('completed','failed','cancelled')`,
            )
            .run(
              SWARM_NODE_STATES.COMPLETED,
              finalChildResult.childSessionId,
              finalChildResult.childTurnId,
              finalChildResult.text,
              JSON.stringify(uris),
              finalChildResult.artifact?.id ?? null,
              mergedBudgetJson,
              now,
              node.id,
            );
          if (!upd.changes) {
            throw new RecoveryError('LEASE_LOST', {
              message: `Concurrent node completion blocked for ${node.id}`,
            });
          }
          return {
            row: this.store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(node.id),
            resolvedReviewVerdict,
          };
        });
        const committedRow = committedNode.row;
        const committedHardGateVerdict = committedNode.resolvedReviewVerdict?.reviewerVerification ?? null;

        try {
          this.eventRouter?.emitPersisted({
            sessionId: run.sessionId,
            turnId: run.rootTurnId,
            type: RUNTIME_EVENTS.SWARM_NODE_UPDATED,
            data: {
              runId: committedRow.runId,
              nodeId: committedRow.id,
              nodeKey: committedRow.nodeKey,
              status: committedRow.status,
              childSessionId: committedRow.childSessionId || undefined,
              artifactUris: uris,
              ...(committedHardGateVerdict ? { reviewerVerification: committedHardGateVerdict } : {}),
            },
            audit: false,
          });
        } catch {
          // non-fatal event emit
        }

        safeIsolateSideEffect(() => {
          const receiptStats =
            finalChildResult.childSessionId && finalChildResult.childTurnId && this.store?.db?.isOpen
              ? this.store.db
                  .prepare(
                    "SELECT COUNT(*) AS total, SUM(CASE WHEN status='finished' THEN 1 ELSE 0 END) AS ok FROM tool_receipts WHERE sessionId=? AND turnId=?",
                  )
                  .get(finalChildResult.childSessionId, finalChildResult.childTurnId)
              : null;
          this.modelFeedback?.record?.({
            model: node.model,
            provider: node.provider || 'pool',
            taskType: node.taskType || 'general',
            success: true,
            toolTotal: Number(receiptStats?.total ?? 0),
            toolSuccess: Number(receiptStats?.ok ?? 0),
            verifiedPass: finalChildResult.verifiedPass ?? null,
            latencyMs: Date.now() - startedAt,
            inputTokens: finalChildResult.usage?.inputTokens ?? 0,
            outputTokens: finalChildResult.usage?.outputTokens ?? 0,
            recovered: Boolean(job.reclaimedFromCrash || job.attempts > 1),
            trafficSource: run.trafficSource || 'production',
            isSynthetic: run.isSynthetic ? 1 : 0,
          });
        });

        await this.#publishHandoffsAndDrainInbox(committedRow, runId, uris);

        const committedBudgetObj = parseJsonSafe(committedRow.budgetJson, {});
        const committedReviewVerdict = committedBudgetObj?.reviewerVerdict ?? null;
        if (
          node.taskType === 'review' &&
          !committedReviewVerdict?.hardGateRejected &&
          (committedReviewVerdict?.status === 'fail' ||
            committedReviewVerdict?.status === 'needs_revision') &&
          this.replanner?.replanRepairAndReverify
        ) {
          const liveRunForRepair = this.getRun(runId);
          if (liveRunForRepair && !isTerminalRunState(liveRunForRepair.status)) {
            const runLevelGuard =
              leaseGuard?.withContext?.({ runId, nodeId: null, nodeAttempt: null }) ?? leaseGuard;
            let revReplan = { replanned: false };
            try {
              revReplan = await this.replanner.replanRepairAndReverify({
                run: liveRunForRepair,
                triggerNode: committedRow,
                errorCode:
                  committedReviewVerdict.status === 'needs_revision'
                    ? 'REVIEW_NEEDS_REVISION'
                    : 'REVIEW_FAILED',
                errorMessage:
                  committedReviewVerdict.summary ||
                  `Reviewer ${committedNode.nodeKey} returned ${committedReviewVerdict.status}`,
                failureDiagnostics: committedReviewVerdict.summary || '',
                reviewerFindings: committedReviewVerdict.findings ?? [],
                testCommands: liveRunForRepair.strategy?.repoContext?.testCommands ?? [],
                maxReplans: liveRunForRepair.strategy?.maxReplans ?? 2,
                budgetLedger: this.budgetLedger,
                leaseGuard: runLevelGuard,
              });
            } catch (revErr) {
              if (isLeaseLostError(revErr)) throw revErr;
              revReplan = { replanned: false };
            }
            if (revReplan?.replanned) {
              if (!checkLeaseHeld(runLevelGuard, { runId, nodeId: null })) {
                throw new RecoveryError('LEASE_LOST', {
                  message: `Lease lost after review repair replan for ${node.nodeKey}`,
                });
              }
              enqueueSwarmJob(
                this.jobQueue,
                SWARM_JOB_KINDS.DEPENDENCY_RESOLVE,
                {
                  runId,
                  sessionId: run.sessionId,
                  planVersion: revReplan.version || liveRunForRepair.planVersion || 1,
                  epoch: Date.now(),
                },
                {
                  idempotencyKey: `swarm:resolve:${runId}:${node.nodeKey}:revrepair:${uuid().slice(0, 8)}`,
                },
              );
              return;
            }
          }
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
            transitionNodeTerminalCas(this.store, this.eventRouter, freshNode.id, SWARM_NODE_STATES.CANCELLED, {
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
          const isVerificationFailure =
            errorCode === 'VERIFICATION_FAILED' || errorCode.startsWith('REVIEWER_');
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
        if (this.replanner && !errorCode.startsWith('REVIEWER_')) {
          try {
            replanOut = await this.replanner.replan({
              run: freshRun,
              failedNode: freshNode,
              errorCode,
              errorMessage,
              maxReplans: freshRun.strategy?.maxReplans ?? 2,
              budgetLedger: this.budgetLedger,
              leaseGuard: nodeGuard,
              ...(errorCode === 'VERIFICATION_FAILED'
                ? {
                    repairContext: {
                      failureDiagnostics: err?.detail?.failureDiagnostics ?? errorMessage,
                      testCommands: freshRun.strategy?.repoContext?.testCommands ?? [],
                      wantVerification: true,
                    },
                  }
                : {}),
            });
          } catch (replanErr) {
            if (isLeaseLostError(replanErr)) throw replanErr;
            replanOut = { replanned: false };
          }
        }

        if (replanOut?.replanned) {
          // A successful split/repair deliberately terminalizes the superseded node. Verify
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

        const failedExtraBudget = err?.detail?.verificationResult
          ? JSON.stringify({
              ...parseJsonSafe(freshNode.budgetJson, {}),
              verificationResult: err.detail.verificationResult,
            })
          : undefined;
        transitionNodeTerminalCas(this.store, this.eventRouter, freshNode.id, SWARM_NODE_STATES.FAILED, {
          sessionId: freshRun.sessionId,
          rootTurnId: freshRun.rootTurnId,
          leaseGuard: nodeGuard,
          patch: {
            activeFence: null,
            activeJobId: null,
            errorCode,
            errorMessage,
            ...(failedExtraBudget ? { budgetJson: failedExtraBudget } : {}),
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

      const reviewerVerdicts = activeNodes
        .filter((n) => n.taskType === 'review')
        .map((n) => {
          const budgetObj = parseJsonSafe(n.budgetJson, {});
          return budgetObj?.reviewerVerdict
            ? { nodeKey: n.nodeKey, nodeStatus: n.status, ...budgetObj.reviewerVerdict }
            : null;
        })
        .filter(Boolean);

      if (verdict && reviewerVerdicts.length > 0) {
        verdict.reviewerVerdicts = reviewerVerdicts;
        const primaryReviewerVerification =
          reviewerVerdicts.find((rv) => rv.reviewerVerification?.hardGatePassed === false)?.reviewerVerification ??
          reviewerVerdicts.find((rv) => rv.reviewerVerification)?.reviewerVerification ??
          null;
        if (primaryReviewerVerification) {
          verdict.reviewerVerification = primaryReviewerVerification;
        }
        const rejectedReviews = reviewerVerdicts.filter(
          (rv) => rv.status === 'fail' || rv.status === 'needs_revision',
        );
        const hardGateFailedReviews = reviewerVerdicts.filter(
          (rv) => rv.reviewerVerification?.hardGatePassed === false,
        );
        if (rejectedReviews.length > 0 || hardGateFailedReviews.length > 0) {
          verdict.accepted = false;
          verdict.verdict = 'fail';
          verdict.reasons = [
            ...new Set([
              ...(Array.isArray(verdict.reasons) ? verdict.reasons : []),
              ...(rejectedReviews.length > 0 ? ['independent_reviewer_rejected'] : []),
              ...(hardGateFailedReviews.length > 0 ? ['reviewer_hard_gate_failed'] : []),
            ]),
          ];
        } else if (reviewerVerdicts.every((rv) => rv.status === 'pass')) {
          verdict.independentReviewerVerdict = {
            status: 'pass',
            source: 'independent_reviewer',
            reviewerModels: [...new Set(reviewerVerdicts.map((rv) => rv.reviewerModel).filter(Boolean))],
            evidenceRefs: [...new Set(reviewerVerdicts.flatMap((rv) => rv.evidenceRefs ?? []))],
            evidenceDigests: reviewerVerdicts.map((rv) => rv.evidenceDigest).filter(Boolean),
            ...(primaryReviewerVerification ? { reviewerVerification: primaryReviewerVerification } : {}),
          };
        }
      }

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
        const updated = transitionRunTerminalCas(this.store, runId, finalStatus, {
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
        if (finalStatus === SWARM_RUN_STATES.COMPLETED && this.experienceMemory && !run.isSynthetic) {
          const artifactUris = [
            ...new Set(activeNodes.flatMap((n) => (Array.isArray(n.artifactUris) ? n.artifactUris : []))),
          ];
          const projectId = run.workspaceRoot || run.sessionId;
          safeIsolateSideEffect(() =>
            this.experienceMemory.recordExecutionCandidates({
              projectId,
              source: 'swarm_run',
              sourceTaskId: runId,
              sessionId: run.sessionId,
              turnId: run.rootTurnId,
              runId,
              goal: run.goal,
              summary,
              verdict: outcome.verdict,
              evidenceCount: Number(outcome.verdict?.evidenceCount ?? 0),
              artifactUris,
              isSynthetic: Boolean(run.isSynthetic),
            }),
          );
        }
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
              ...(outcome.verdict?.reviewerVerification
                ? { reviewerVerification: outcome.verdict.reviewerVerification }
                : {}),
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

  #materializeReviewerNode({ run, team, picked, candidates, budgetSnapshot = null, now }) {
    if (!run || team?.mode !== 'team' || !team.reviewer?.required || !Array.isArray(picked) || picked.length === 0) {
      return null;
    }

    const sourceNodeKeys = [...new Set(picked.map((node) => String(node.nodeKey)).filter(Boolean))].sort();
    if (
      sourceNodeKeys.length === 0 ||
      picked.some((node) => parseJsonSafe(node.budgetJson, {})?.reviewerMetadata?.autoMaterialized === true)
    ) {
      return null;
    }

    if (
      budgetSnapshot &&
      budgetSnapshot.remainingSteps !== null &&
      budgetSnapshot.remainingSteps <= picked.length
    ) {
      return null;
    }

    const replacedKeys = this.#getReplacedNodeKeys(run.id);
    const existingPlannedReview = (run.nodes ?? []).find(
      (n) =>
        !replacedKeys.has(n.nodeKey) &&
        n.taskType === 'review' &&
        Array.isArray(n.dependencies) &&
        sourceNodeKeys.every((key) => n.dependencies.includes(key)),
    );
    if (existingPlannedReview) {
      return null;
    }

    const reviewerCandidate = candidates.find(
      (candidate) => candidate.id === team.reviewer.id || candidate.model === team.reviewer.id,
    );
    if (!reviewerCandidate) {
      throw new RuntimeError('INVALID_REVIEWER_SELECTION', {
        message: `TeamOptimizer selected unavailable reviewer candidate ${team.reviewer.id}`,
        detail: { runId: run.id, reviewerId: team.reviewer.id, sourceNodeKeys },
      });
    }

    const planVersion = Number(run.planVersion || 1);
    const digest = createHash('sha256')
      .update(`${run.id}:v${planVersion}:${sourceNodeKeys.join('|')}`)
      .digest('hex')
      .slice(0, 20);
    const nodeKey = `reviewer:${planVersion}:${digest}`;
    const existing = this.store.db
      .prepare('SELECT * FROM swarm_nodes WHERE runId=? AND nodeKey=?')
      .get(run.id, nodeKey);
    if (existing) return existing;

    const objective = [
      '独立审查前置 Swarm 节点的实际产物、工具 receipt 和验证证据。',
      `前置节点: ${sourceNodeKeys.join(', ')}`,
      '不得修改代码或覆盖前置节点证据；如证据不足或存在冲突，必须明确报告并拒绝无证据通过。',
    ].join('\n');
    const acceptance =
      '独立读取所有可用前置 artifact，并核对 durable tool receipts / verifier evidence；输出包含 evidenceRefs 的审查结论。';
    const reviewSelection = this.router?.select?.({
      taskType: 'review',
      objective,
      requiredTools: ['read_file', 'glob', 'grep', 'read_blob', 'read_swarm_artifact'],
      budget: run.budget ?? {},
      preferredModel: reviewerCandidate.model ?? reviewerCandidate.id,
      readOnly: true,
    });
    const profile = reviewSelection?.profile ?? {};
    const toolAllow = [
      ...(Array.isArray(profile.toolAllow) ? profile.toolAllow : []),
      'read_file',
      'glob',
      'grep',
      'read_blob',
      'read_swarm_artifact',
    ];
    const maxSteps = Number.isFinite(Number(run.budget?.maxReviewerSteps))
      ? Math.max(1, Math.min(8, Math.floor(Number(run.budget.maxReviewerSteps))))
      : 8;
    const reviewerBudget = {
      maxSteps,
      ...(Number.isFinite(Number(run.budget?.maxReviewerTokens))
        ? { maxTokens: Math.max(1, Math.floor(Number(run.budget.maxReviewerTokens))) }
        : {}),
      requiredCapabilities: { reasoning: 1, research: 1 },
      reviewerMetadata: {
        autoMaterialized: true,
        candidateId: reviewerCandidate.id,
        sourceNodeKeys,
        reason: team.reviewer.reason ?? 'independent evidence/conclusion review',
        evidencePolicy: team.evidencePolicy ?? null,
      },
    };

    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO swarm_nodes(
          id, runId, nodeKey, agentProfileId, model, provider, objective, acceptance,
          dependenciesJson, toolAllowJson, permissionMode, taskType, isolationMode,
          allowIsolationFallback, planVersion, status, priority, budgetJson, createdAt, updatedAt
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`,
      )
      .run(
        uuid(),
        run.id,
        nodeKey,
        profile.id ?? 'dynamic:review',
        reviewerCandidate.model ?? reviewerCandidate.id,
        reviewerCandidate.provider ?? reviewSelection?.provider ?? 'pool',
        objective,
        acceptance,
        JSON.stringify(sourceNodeKeys),
        JSON.stringify([...new Set(toolAllow.map(String))]),
        'read-only',
        'review',
        'shared_readonly',
        0,
        planVersion,
        100,
        JSON.stringify(reviewerBudget),
        now,
        now,
      );

    return this.store.db
      .prepare('SELECT * FROM swarm_nodes WHERE runId=? AND nodeKey=?')
      .get(run.id, nodeKey);
  }

  #buildReviewerEvidenceContext({ run, node, byKey }) {
    if (!node || node.taskType !== 'review') return null;
    const budget = parseJsonSafe(node.budgetJson, {});
    const metadata = budget?.reviewerMetadata;
    const rawSourceKeys = Array.isArray(metadata?.sourceNodeKeys) && metadata.sourceNodeKeys.length > 0
      ? metadata.sourceNodeKeys
      : Array.isArray(node.dependencies)
        ? node.dependencies
        : [];
    const visited = new Set();
    const sourceNodeKeys = [];
    const visit = (key, isDirect = false) => {
      const k = String(key || '').trim();
      if (!k || visited.has(k)) return;
      const target = byKey.get(k);
      if (!target) return;
      if (!isDirect && target.status === SWARM_NODE_STATES.SUPERSEDED) return;
      visited.add(k);
      if (Array.isArray(target.dependencies)) {
        for (const dep of target.dependencies) {
          visit(dep, false);
        }
      }
      sourceNodeKeys.push(k);
    };
    for (const k of rawSourceKeys) visit(k, true);
    if (sourceNodeKeys.length === 0) return null;

    const sourceNodes = sourceNodeKeys.map((key) => byKey.get(key)).filter(Boolean);
    const sourceNodeIds = sourceNodes.map((source) => source.id).filter(Boolean);
    const childSessionIds = sourceNodes.map((source) => source.childSessionId).filter(Boolean);
    const childTurnIds = sourceNodes.map((source) => source.childTurnId).filter(Boolean);

    const artifactRows = sourceNodeIds.length
      ? this.store.db
          .prepare(
            `SELECT id, uri, nodeId, nodeKey, childSessionId, childTurnId, attempt,
                    bundleSha256, status, createdAt, updatedAt
             FROM swarm_artifacts
             WHERE runId=? AND nodeId IN (${sourceNodeIds.map(() => '?').join(',')})
             ORDER BY createdAt ASC, attempt ASC`,
          )
          .all(run.id, ...sourceNodeIds)
      : [];
    const verifiedArtifacts = artifactRows
      .filter((artifact) => artifact.status !== 'superseded')
      .map((artifact) => {
        let verified = null;
        try {
          verified = this.artifactManager?.verifyArtifact?.(artifact.id) ?? null;
        } catch (error) {
          verified = { ok: false, errors: [String(error?.message ?? error)] };
        }
        const artObj = verified?.artifact ?? this.artifactManager?.getArtifact?.(artifact.id) ?? null;
        return {
          ...artifact,
          verified: verified?.ok === true,
          verificationErrors: verified?.ok === true ? [] : (verified?.errors ?? ['artifact verifier unavailable']),
          files: Array.isArray(artObj?.files) ? artObj.files : null,
          fileCount: artObj?.fileCount ?? (Array.isArray(artObj?.files) ? artObj.files.length : null),
          storagePath: artObj?.storagePath ?? null,
        };
      });

    let receiptRows = [];
    if (childTurnIds.length > 0) {
      const sessionClause = childSessionIds.length
        ? ` AND sessionId IN (${childSessionIds.map(() => '?').join(',')})`
        : '';
      receiptRows = this.store.db
        .prepare(
          `SELECT id, sessionId, turnId, callId, toolName, status, exitCode,
                  outputDigest, errorCode, createdAt, updatedAt
           FROM tool_receipts
           WHERE turnId IN (${childTurnIds.map(() => '?').join(',')})${sessionClause}
           ORDER BY createdAt DESC
           LIMIT 500`,
        )
        .all(...childTurnIds, ...childSessionIds)
        .reverse();
    } else if (childSessionIds.length > 0) {
      receiptRows = this.store.db
        .prepare(
          `SELECT id, sessionId, turnId, callId, toolName, status, exitCode,
                  outputDigest, errorCode, createdAt, updatedAt
           FROM tool_receipts
           WHERE sessionId IN (${childSessionIds.map(() => '?').join(',')})
           ORDER BY createdAt DESC
           LIMIT 500`,
        )
        .all(...childSessionIds)
        .reverse();
    }

    const verdictRows = childTurnIds.length
      ? this.store.db
          .prepare(
            `SELECT id, sessionId, state, verdictJson, evidenceCount, createdAt, finishedAt
             FROM direct_turns
             WHERE id IN (${childTurnIds.map(() => '?').join(',')})
             ORDER BY createdAt ASC`,
          )
          .all(...childTurnIds)
      : [];

    return {
      runId: run.id,
      reviewerNodeKey: node.nodeKey,
      sourceNodes: sourceNodes.map((source) => {
        const sb = parseJsonSafe(source.budgetJson, {});
        const vr = sb?.verificationResult;
        return {
          nodeId: source.id,
          nodeKey: source.nodeKey,
          taskType: source.taskType ?? null,
          isolationMode: source.isolationMode ?? null,
          status: source.status,
          childSessionId: source.childSessionId ?? null,
          childTurnId: source.childTurnId ?? null,
          artifactUris: parseJsonSafe(source.artifactUrisJson, []),
          ...(vr ? { verificationResult: { status: vr.status ?? null, exitCode: vr.exitCode ?? null } } : {}),
        };
      }),
      artifacts: verifiedArtifacts.map((artifact) => ({
        artifactId: artifact.id,
        uri: artifact.uri,
        nodeKey: artifact.nodeKey,
        attempt: artifact.attempt,
        bundleSha256: artifact.bundleSha256,
        status: artifact.status,
        verified: artifact.verified,
        verificationErrors: artifact.verificationErrors,
        ...(artifact.fileCount != null ? { fileCount: artifact.fileCount } : {}),
      })),
      verificationResults: sourceNodes
        .map((source) => {
          const vr = parseJsonSafe(source.budgetJson, {})?.verificationResult;
          return vr ? { nodeKey: source.nodeKey, status: vr.status ?? null, exitCode: vr.exitCode ?? null } : null;
        })
        .filter(Boolean),
      receipts: receiptRows.map((receipt) => ({
        receiptId: receipt.id,
        sessionId: receipt.sessionId,
        turnId: receipt.turnId,
        callId: receipt.callId,
        toolName: receipt.toolName,
        status: receipt.status,
        exitCode: receipt.exitCode,
        outputDigest: receipt.outputDigest,
        errorCode: receipt.errorCode,
      })),
      turnVerdicts: verdictRows.map((turn) => ({
        turnId: turn.id,
        sessionId: turn.sessionId,
        state: turn.state,
        verdict: parseJsonSafe(turn.verdictJson, null),
        evidenceCount: Number(turn.evidenceCount ?? 0),
      })),
    };
  }

  #prepareNodeSpecs(rawNodes, budget) {
    const plannedNodes = this.planner.normalizeNodes(rawNodes);
    this.planner.validateDag(plannedNodes);
    const conflictPolicy = budget?.conflictPolicy ?? 'serialize';
    const preflight = detectSiblingWritePathConflicts(plannedNodes, { conflictPolicy });
    if (preflight.blocked) {
      throw new RuntimeError('WRITE_PATH_CONFLICT', {
        status: 409,
        message: preflight.message,
        detail: preflight.writeConflictResolution,
      });
    }
    const resolvedNodes = preflight.nodes;
    const nonReviewSelections = new Map();
    const synthesizeNodeProfile = (n, baseProfile) => {
      if (!this.router?.agentRegistry?.synthesizeProfile) return baseProfile;
      const strictReadOnly = n.taskType === 'review' || n.taskType === 'research';
      const isWorktree =
        !strictReadOnly &&
        (n.isolationMode === 'worktree' || Boolean(n.isolatedWorktree));
      return this.router.agentRegistry.synthesizeProfile({
        taskType: n.taskType,
        objective: n.objective,
        requiredTools: Array.isArray(n.toolAllow) ? n.toolAllow : null,
        isolationMode: strictReadOnly
          ? 'shared_readonly'
          : n.isolationMode || (isWorktree ? 'worktree' : 'shared_readonly'),
        isolatedWorktree: isWorktree,
        roleTitle: n.roleTitle,
        focus: n.focus,
        ownedPaths: n.ownedPaths,
        readOnly: strictReadOnly ? true : undefined,
      });
    };
    for (const n of resolvedNodes) {
      if (n.taskType === 'review') continue;
      const sel = this.router.select({
        taskType: n.taskType,
        objective: n.objective,
        requiredTools: Array.isArray(n.toolAllow) ? n.toolAllow : null,
        budget: n.budget ?? budget,
      });
      nonReviewSelections.set(n.nodeKey, {
        ...sel,
        profile: synthesizeNodeProfile(n, sel.profile),
      });
    }
    const workerModels = [...new Set([...nonReviewSelections.values()].map((s) => s?.model).filter(Boolean))];
    const highRiskRun = resolvedNodes.some(
      (n) =>
        n.isolatedWorktree ||
        n.isolationMode === 'worktree' ||
        n.taskType === 'verification' ||
        /security|audit|review/i.test(String(n.objective ?? '')),
    );
    const specs = resolvedNodes.map((n) => {
      let selection = nonReviewSelections.get(n.nodeKey);
      if (!selection) {
        const revSel = this.router.select({
          taskType: n.taskType,
          objective: n.objective,
          requiredTools: Array.isArray(n.toolAllow) ? n.toolAllow : null,
          budget: n.budget ?? budget,
          ...(n.taskType === 'review' && highRiskRun && workerModels.length > 0
            ? { excludeModels: workerModels }
            : {}),
        });
        selection = {
          ...revSel,
          profile: synthesizeNodeProfile(n, revSel.profile),
        };
      }
      const nextBudget = { ...(n.budget ?? {}) };
      if (Array.isArray(n.ownedPaths) && n.ownedPaths.length > 0 && !nextBudget.ownedPaths) {
        nextBudget.ownedPaths = n.ownedPaths;
      }
      if (Array.isArray(n.writePaths) && n.writePaths.length > 0 && !nextBudget.writePaths) {
        nextBudget.writePaths = n.writePaths;
      }
      if (Array.isArray(n.targetFiles) && n.targetFiles.length > 0 && !nextBudget.targetFiles) {
        nextBudget.targetFiles = n.targetFiles;
      }
      if (Array.isArray(n.files) && n.files.length > 0 && !nextBudget.files) {
        nextBudget.files = n.files;
      }
      if (n.writeConflictResolution && !nextBudget.writeConflictResolution) {
        nextBudget.writeConflictResolution = n.writeConflictResolution;
      }
      if (
        !nextBudget.roleMetadata &&
        (n.roleTitle || n.focus || (Array.isArray(n.ownedPaths) && n.ownedPaths.length > 0))
      ) {
        nextBudget.roleMetadata = {
          ...(n.roleTitle ? { roleTitle: n.roleTitle } : {}),
          ...(n.focus ? { focus: n.focus } : {}),
          ...(Array.isArray(n.ownedPaths) && n.ownedPaths.length > 0 ? { ownedPaths: n.ownedPaths } : {}),
        };
      } else if (!nextBudget.roleMetadata && selection.profile?.roleTitle) {
        nextBudget.roleMetadata = {
          roleTitle: selection.profile.roleTitle,
          ...(selection.profile.focus ? { focus: selection.profile.focus } : {}),
          ...(Array.isArray(selection.profile.ownedPaths) && selection.profile.ownedPaths.length > 0
            ? { ownedPaths: selection.profile.ownedPaths }
            : {}),
        };
      }
      return {
        spec: { ...n, budget: nextBudget },
        selection,
      };
    });
    if (preflight.writeConflictResolution?.hasConflicts) {
      Object.defineProperty(specs, 'writeConflictResolution', {
        value: preflight.writeConflictResolution,
        enumerable: false,
      });
    }
    return specs;
  }

  #insertNodes(runId, routedSpecs, parentPermissionMode, planVersion, now) {
    const ins = this.store.db.prepare(
      `INSERT OR IGNORE INTO swarm_nodes(
        id, runId, nodeKey, agentProfileId, model, provider, objective, acceptance,
        dependenciesJson, toolAllowJson, permissionMode, taskType, isolationMode,
        allowIsolationFallback, planVersion, status, priority, budgetJson, createdAt, updatedAt
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`,
    );
    const parentRuntimePerm = normalizeRuntimePermission(parentPermissionMode || 'auto-safe');
    const MUTATING_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch', 'bash', 'start_process', 'kill_process']);
    for (const { spec, selection } of routedSpecs) {
      const isReadOnlyTask = spec.taskType === 'review' || spec.taskType === 'research';
      const isolationMode = isReadOnlyTask
        ? 'shared_readonly'
        : spec.isolationMode || (spec.isolatedWorktree ? 'worktree' : 'shared_readonly');
      const strictNonMutating = isReadOnlyTask || isolationMode === 'shared_readonly';

      // Never widen an explicit empty allowlist (`[]`) by injecting `read_swarm_artifact`.
      const defaultToolAllow =
        Array.isArray(selection.profile.toolAllow) && selection.profile.toolAllow.length > 0
          ? [...new Set([...selection.profile.toolAllow, 'read_swarm_artifact'])]
          : selection.profile.toolAllow;
      const requestedToolAllow =
        spec.toolAllow !== null && spec.toolAllow !== undefined
          ? spec.toolAllow
          : defaultToolAllow;
      const effectiveToolAllow =
        strictNonMutating && Array.isArray(requestedToolAllow)
          ? requestedToolAllow.filter((t) => !MUTATING_TOOLS.has(t))
          : requestedToolAllow;

      const requestedPerm = strictNonMutating
        ? 'read-only'
        : spec.permissionMode
          ? normalizeRuntimePermission(spec.permissionMode)
          : parentRuntimePerm;
      const effectiveNodePerm = intersectPolicies(
        { permissionMode: parentRuntimePerm },
        { permissionMode: requestedPerm },
      ).permissionMode;
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
        JSON.stringify(effectiveToolAllow),
        effectiveNodePerm,
        spec.taskType || 'research',
        isolationMode,
        spec.allowIsolationFallback ? 1 : 0,
        planVersion,
        spec.priority,
        JSON.stringify(spec.budget ?? {}),
        now,
        now,
      );
    }
  }

  async #publishHandoffsAndDrainInbox(committedNode, runId, uris = []) {
    if (!committedNode) return;
    if (typeof this.mailbox?.receive === 'function' && typeof this.mailbox?.ack === 'function') {
      try {
        for (let i = 0; i < 16; i += 1) {
          const extra = await this.mailbox.receive(committedNode.nodeKey, {
            runId,
            visibilityTimeoutMs: this.communicationVisibilityTimeoutMs,
          });
          if (!extra?.messageId) break;
          if (extra.kind === 'handoff') {
            await this.mailbox.ack(
              extra.messageId,
              extra.toAgentId || committedNode.nodeKey,
              extra.deliveryToken,
            );
          } else {
            await this.mailbox.retry?.(
              extra.messageId,
              extra.toAgentId || committedNode.nodeKey,
              { delayMs: 0 },
            );
            break;
          }
        }
      } catch {
        // best-effort post-completion handoff drain
      }
    }

    if (typeof this.mailbox?.send === 'function' && this.store?.db?.isOpen) {
      try {
        const committedBudget = parseJsonSafe(committedNode.budgetJson, {});
        const nodeAciMetrics = committedBudget?.aciMetrics ?? null;
        const sharedAciDigest = nodeAciMetrics
          ? buildSharedAciDigest([{ nodeKey: committedNode.nodeKey, aciMetrics: nodeAciMetrics }], {
              maxChars: 1600,
            })
          : '';
        const candidates = this.store.db
          .prepare('SELECT id, nodeKey, status, dependenciesJson FROM swarm_nodes WHERE runId=?')
          .all(runId);
        for (const downstream of candidates) {
          if (isTerminalNodeState(downstream.status)) continue;
          const deps = parseJsonSafe(downstream.dependenciesJson, []);
          if (!Array.isArray(deps) || !deps.includes(committedNode.nodeKey)) continue;
          await this.mailbox.send({
            conversationId: `swarm:${runId}`,
            runId,
            fromAgentId: committedNode.nodeKey,
            toAgentId: downstream.nodeKey,
            kind: 'handoff',
            idempotencyKey: `swarm:handoff:${runId}:v${Number(committedNode.planVersion || 1)}:${committedNode.nodeKey}:${downstream.nodeKey}`,
            payload: {
              fromNodeKey: committedNode.nodeKey,
              toNodeKey: downstream.nodeKey,
              status: 'completed',
              artifactId: committedNode.latestArtifactId ?? null,
              artifactUris: uris,
              summary: String(committedNode.resultText || '').slice(0, 800),
              ...(nodeAciMetrics ? { aciMetrics: nodeAciMetrics } : {}),
              ...(sharedAciDigest ? { sharedAciDigest } : {}),
            },
          });
        }
      } catch {
        // non-fatal handoff publication
      }
    }
  }

  #getReplacedNodeKeys(runId) {
    const rows = this.store.db
      .prepare(
        "SELECT failedNodeKey, strategy, diffJson FROM swarm_replans WHERE runId=? AND strategy IN ('split_subgraph', 'repair_and_reverify')",
      )
      .all(runId);
    const set = new Set();
    for (const r of rows) {
      if (r.strategy === 'split_subgraph') {
        if (r.failedNodeKey) set.add(r.failedNodeKey);
      } else if (r.strategy === 'repair_and_reverify') {
        const diff = parseJsonSafe(r.diffJson, {});
        if (Array.isArray(diff.supersededNodeKeys)) {
          for (const k of diff.supersededNodeKeys) {
            if (k) set.add(k);
          }
        } else if (r.failedNodeKey) {
          set.add(r.failedNodeKey);
        }
      }
    }
    return set;
  }

  #armRunDeadline(runId) {
    if (!this.#dbOpen()) return false;
    const row = this.store.db.prepare(
      "SELECT status, createdAt, json_extract(budgetJson, '$.maxDurationMs') AS maxDurationMs FROM swarm_runs WHERE id=?",
    ).get(runId);
    if (!row || isTerminalRunState(row.status)) return false;
    const remaining = remainingRunMs(row);
    if (remaining === null) return true;
    if (remaining === 0) {
      this.cancelRun(runId, { deadlineExpired: true });
      return false;
    }
    if (!this.deadlineTimers.has(runId)) {
      const timer = setTimeout(() => {
        this.deadlineTimers.delete(runId);
        this.#armRunDeadline(runId);
      }, Math.min(remaining, 2 ** 31 - 1));
      timer.unref?.();
      this.deadlineTimers.set(runId, timer);
    }
    return true;
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
      teamRationale: run.strategy?.plan?.metadata?.teamRationale ?? null,
      nodes: run.nodes,
      usage: run.usage,
      verdict: run.verdict,
      planVersion: run.planVersion,
      replanCount: run.replanCount,
      errorCode: run.errorCode ?? null,
      errorMessage: run.errorMessage ?? null,
      budgetLedger: this.budgetLedger?.getSnapshot?.(run.id) ?? null,
      ...(run.strategy?.writeConflictResolution
        ? { writeConflictResolution: run.strategy.writeConflictResolution }
        : {}),
      ...(run.verdict?.reviewerVerification
        ? { reviewerVerification: run.verdict.reviewerVerification }
        : {}),
      ...(run.verdict?.degradedTimeout
        ? {
            degradedTimeout: true,
            preservedArtifacts: run.verdict.preservedArtifacts ?? [],
            partialDeliverySummary: run.verdict.summary ?? null,
          }
        : {}),
    };
  }

  #notifyWaiters(run) {
    clearTimeout(this.deadlineTimers.get(run.id));
    this.deadlineTimers.delete(run.id);
    this.activeControllers.delete(run.id);
    const set = this.waiters.get(run.id);
    if (!set) return;
    for (const fn of [...set]) fn(run);
  }

  #inspectVerificationShellOutcome(
    childSessionId,
    childTurnId,
    resultText = '',
    explicitVerifiedPass = null,
  ) {
    if (childSessionId && this.store?.db?.isOpen) {
      const shellReceipts = this.store.db
        .prepare(
          `SELECT id, callId, toolName, status, exitCode, errorCode, createdAt, updatedAt
           FROM tool_receipts
           WHERE sessionId=? AND (? IS NULL OR turnId=?) AND toolName IN ('bash', 'start_process')
           ORDER BY createdAt ASC`,
        )
        .all(childSessionId, childTurnId ?? null, childTurnId ?? null);
      if (shellReceipts.length > 0) {
        const toolMsgs = this.store.db
          .prepare(
            `SELECT toolCallId, content
             FROM direct_messages
             WHERE sessionId=? AND (? IS NULL OR turnId=?) AND role='tool'
             ORDER BY seq ASC`,
          )
          .all(childSessionId, childTurnId ?? null, childTurnId ?? null);
        const msgByCallId = new Map(toolMsgs.map((m) => [m.toolCallId, m.content]));

        const assistantMsgs = this.store.db
          .prepare(
            `SELECT toolCalls
             FROM direct_messages
             WHERE sessionId=? AND (? IS NULL OR turnId=?) AND role='assistant' AND toolCalls IS NOT NULL
             ORDER BY seq ASC`,
          )
          .all(childSessionId, childTurnId ?? null, childTurnId ?? null);
        const cmdByCallId = new Map();
        for (const am of assistantMsgs) {
          const tcs = parseJsonSafe(am.toolCalls, []);
          for (const tc of tcs) {
            if (!tc?.id) continue;
            const args =
              typeof tc.arguments === 'string'
                ? parseJsonSafe(tc.arguments, {})
                : (tc.arguments || {});
            if (args?.command) cmdByCallId.set(tc.id, String(args.command));
          }
        }

        const latest = shellReceipts.at(-1);
        const rawOut = String(msgByCallId.get(latest.callId) ?? '');
        const unwrappedOut = rawOut.replace(/^<untrusted\b[^>]*>/, '').replace(/<\/untrusted>\s*$/, '');
        const parsedOut = parseJsonSafe(unwrappedOut, null);
        const cmd = cmdByCallId.get(latest.callId) || parsedOut?.command || null;
        const exitCode =
          latest.exitCode !== null && latest.exitCode !== undefined
            ? Number(latest.exitCode)
            : latest.status === 'failed'
              ? 1
              : 0;
        const summary = String(
          (parsedOut && (parsedOut.stderr || parsedOut.stdout || parsedOut.output || parsedOut.error)) ||
            unwrappedOut ||
            resultText ||
            '',
        ).slice(0, 1500);
        return {
          command: cmd,
          exitCode,
          status: exitCode === 0 && latest.status === 'finished' ? 'passed' : 'failed',
          summary,
        };
      }
    }

    if (explicitVerifiedPass === false) {
      return {
        command: null,
        exitCode: 1,
        status: 'failed',
        summary: String(resultText || 'Verification failed').slice(0, 1200),
      };
    }
    return null;
  }

  /**
   * Assemble unified delivery package for inspection by UI / API callers.
   */
  buildRunDeliveryPackage(runId) {
    const run = this.getRun(runId);
    if (!run) return null;

    const replacedKeys = this.#dbOpen() ? this.#getReplacedNodeKeys(runId) : new Set();
    const activeNodes = (run.nodes ?? []).filter((n) => !replacedKeys.has(n.nodeKey));
    const dependenciesByNodeKey = Object.fromEntries(
      (run.nodes ?? []).map((n) => [n.nodeKey, Array.isArray(n.dependencies) ? n.dependencies : []]),
    );

    const allArtifacts = this.artifactManager?.listRunArtifacts?.(runId) ?? [];
    const activeArtifacts = allArtifacts.filter(
      (a) => a && a.status !== 'superseded' && !replacedKeys.has(a.nodeKey),
    );
    const analysis =
      this.artifactManager && typeof this.artifactManager.analyzeRunArtifacts === 'function'
        ? this.artifactManager.analyzeRunArtifacts(activeArtifacts, {
            dependenciesByNodeKey,
            workspaceRoot: run.workspaceRoot,
          })
        : {
            verifiedArtifacts: activeArtifacts,
            changedFiles: [],
            conflicts: [],
            verificationErrors: [],
            unifiedDiffPreview: '',
          };

    const conflicts = [...(analysis.conflicts || [])];
    for (const errItem of analysis.verificationErrors || []) {
      conflicts.push({
        path: '<artifact>',
        nodeKeys: errItem.nodeKey ? [errItem.nodeKey] : [],
        reason: `artifact_verification_failed:${(errItem.errors || []).join(';')}`,
      });
    }

    const testResults = activeNodes
      .filter((n) => n.taskType === 'verification')
      .map((n) => {
        const b = parseJsonSafe(n.budgetJson, {});
        const inspected =
          b.verificationResult ??
          this.#inspectVerificationShellOutcome(
            n.childSessionId,
            n.childTurnId,
            n.resultText || n.errorMessage || '',
            n.status === SWARM_NODE_STATES.COMPLETED
              ? true
              : n.status === SWARM_NODE_STATES.FAILED
                ? false
                : null,
          );
        const derivedStatus = inspected?.status
          ? inspected.status
          : n.status === SWARM_NODE_STATES.COMPLETED
            ? 'passed'
            : n.status === SWARM_NODE_STATES.FAILED
              ? 'failed'
              : n.status;
        return {
          nodeKey: n.nodeKey,
          command: inspected?.command ?? null,
          exitCode:
            inspected?.exitCode ??
            (n.status === SWARM_NODE_STATES.COMPLETED
              ? 0
              : n.status === SWARM_NODE_STATES.FAILED
                ? 1
                : null),
          status: derivedStatus,
          summary:
            inspected?.summary ||
            String(n.resultText || n.errorMessage || '').slice(0, 600),
        };
      });

    const reviewerVerdicts = activeNodes
      .filter((n) => n.taskType === 'review')
      .map((n) => {
        const b = parseJsonSafe(n.budgetJson, {});
        const rv = b.reviewerVerdict ?? null;
        return {
          nodeKey: n.nodeKey,
          status: rv?.status ?? (n.status === SWARM_NODE_STATES.FAILED ? 'fail' : n.status),
          summary: rv?.summary ?? String(n.resultText || n.errorMessage || '').slice(0, 500),
          reviewerModel: rv?.reviewerModel ?? n.model ?? null,
          checkedArtifacts: Array.isArray(rv?.checkedArtifacts) ? rv.checkedArtifacts : [],
          evidenceRefs: Array.isArray(rv?.evidenceRefs) ? rv.evidenceRefs : [],
          evidenceDigest: rv?.evidenceDigest ?? null,
          findings: Array.isArray(rv?.findings) ? rv.findings : [],
          reviewerVerification: rv?.reviewerVerification ?? null,
        };
      });

    const verifiedMap = new Map(
      (analysis.verifiedArtifacts || []).map((v) => [v.id, v]),
    );
    const verErrMap = new Map(
      (analysis.verificationErrors || []).map((v) => [v.artifactId, v.errors]),
    );
    const artifacts = activeArtifacts.map((a) => ({
      id: a.id,
      artifactId: a.id,
      uri: a.uri,
      runId: a.runId ?? run.id,
      nodeId: a.nodeId ?? null,
      nodeKey: a.nodeKey,
      ownerId: a.ownerId ?? null,
      attempt: a.attempt,
      status: a.status,
      bundleSha256: a.bundleSha256,
      fileCount: Number(a.fileCount ?? (a.files?.length ?? 0)),
      totalBytes: Number(a.totalBytes ?? 0),
      verified: verifiedMap.has(a.id) && !verErrMap.has(a.id),
      verificationErrors: verErrMap.get(a.id) ?? [],
      files: a.files ?? [],
      appliedAt: a.appliedAt ?? null,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt ?? a.createdAt,
    }));

    const packageReviewerVerification =
      run.verdict?.reviewerVerification ??
      reviewerVerdicts.find((rv) => rv.reviewerVerification?.hardGatePassed === false)?.reviewerVerification ??
      reviewerVerdicts.find((rv) => rv.reviewerVerification)?.reviewerVerification ??
      null;

    return {
      runId: run.id,
      status: run.status,
      goal: run.goal,
      planVersion: Number(run.planVersion || 1),
      repoContext: run.strategy?.repoContext ?? null,
      writeConflictResolution: run.strategy?.writeConflictResolution ?? null,
      changedFiles: (analysis.changedFiles || []).map((f) => ({
        path: f.path,
        changeType: f.changeType,
        previousPath: f.previousPath ?? null,
        sha256: f.sha256 ?? null,
        nodeKey: f.nodeKey,
        artifactId: f.artifactId,
        uri: f.uri,
      })),
      conflicts: conflicts.map((c) => ({
        path: c.path,
        nodeKeys: Array.isArray(c.nodeKeys) ? c.nodeKeys : [],
        reason: c.reason,
      })),
      unifiedDiffPreview: analysis.unifiedDiffPreview || '',
      testResults,
      reviewerVerdicts,
      reviewerVerification: packageReviewerVerification,
      verdict: run.verdict ?? null,
      degradedTimeout: Boolean(run.verdict?.degradedTimeout),
      preservedArtifacts: run.verdict?.preservedArtifacts ?? [],
      usage: {
        steps: Number(run.usage?.steps ?? 0),
        inputTokens: Number(run.usage?.inputTokens ?? 0),
        outputTokens: Number(run.usage?.outputTokens ?? 0),
        completedNodes: Number(
          run.usage?.completedNodes ??
            activeNodes.filter((n) => n.status === SWARM_NODE_STATES.COMPLETED).length,
        ),
        replanCount: Number(run.replanCount ?? 0),
      },
      artifacts,
    };
  }

  /**
   * Guarded, conflict-aware, SHA-256 verified apply-all of a completed swarm run's artifacts.
   * Fails closed on missing approval, read-only permissions, unverified/failed runs,
   * tampered artifacts, or file conflicts; idempotent for already-applied artifacts.
   */
  applyAllRunArtifacts(
    runId,
    {
      approved = false,
      permissionMode = null,
      workspaceRoot = null,
      stopOnConflict = true,
    } = {},
  ) {
    const run = this.getRun(runId);
    if (!run) return null;

    if (approved !== true) {
      return {
        ok: false,
        statusCode: 403,
        status: 'forbidden',
        code: 'APPROVAL_REQUIRED',
        runId,
        appliedArtifacts: [],
        appliedFiles: [],
        conflicts: [],
        errors: ['Explicit approved: true is required to apply swarm run artifacts'],
      };
    }

    const effectivePerm = permissionMode
      ? intersectPolicies(
          { permissionMode: normalizeRuntimePermission(run.permissionMode || 'auto-safe') },
          { permissionMode: normalizeRuntimePermission(permissionMode) },
        ).permissionMode
      : normalizeRuntimePermission(run.permissionMode || 'auto-safe');

    if (effectivePerm === 'read-only') {
      return {
        ok: false,
        statusCode: 403,
        status: 'forbidden',
        code: 'POLICY_DENIED',
        runId,
        appliedArtifacts: [],
        appliedFiles: [],
        conflicts: [],
        errors: ['Cannot apply artifacts to parent workspace in read-only permission mode'],
      };
    }

    const replacedKeys = this.#dbOpen() ? this.#getReplacedNodeKeys(runId) : new Set();
    const activeNodes = (run.nodes ?? []).filter((n) => !replacedKeys.has(n.nodeKey));
    const hasFailedOrIncompleteNode = activeNodes.some(
      (n) => n.status !== SWARM_NODE_STATES.COMPLETED,
    );

    if (
      run.status !== SWARM_RUN_STATES.COMPLETED ||
      run.verdict?.accepted === false ||
      hasFailedOrIncompleteNode
    ) {
      return {
        ok: false,
        statusCode: 409,
        status: 'unverified',
        code: 'RUN_NOT_VERIFIED',
        runId,
        appliedArtifacts: [],
        appliedFiles: [],
        conflicts: [],
        errors: [
          `Run ${runId} is not cleanly verified and completed (status=${run.status}, accepted=${run.verdict?.accepted ?? null})`,
        ],
      };
    }

    if (!this.artifactManager || typeof this.artifactManager.applyAllArtifacts !== 'function') {
      return {
        ok: false,
        statusCode: 409,
        status: 'unavailable',
        code: 'ARTIFACT_MANAGER_UNAVAILABLE',
        runId,
        appliedArtifacts: [],
        appliedFiles: [],
        conflicts: [],
        errors: ['SwarmArtifactManager is not configured'],
      };
    }

    const allArtifacts = this.artifactManager.listRunArtifacts(runId);
    const activeArtifacts = allArtifacts.filter(
      (a) => a && a.status !== 'superseded' && !replacedKeys.has(a.nodeKey),
    );
    const dependenciesByNodeKey = Object.fromEntries(
      (run.nodes ?? []).map((n) => [n.nodeKey, Array.isArray(n.dependencies) ? n.dependencies : []]),
    );

    const res = this.artifactManager.applyAllArtifacts(activeArtifacts, {
      workspaceRoot: workspaceRoot || run.workspaceRoot,
      permissionMode: effectivePerm,
      approved: true,
      stopOnConflict: stopOnConflict !== false,
      dependenciesByNodeKey,
      runId,
    });

    return {
      ok: Boolean(res?.ok),
      statusCode: res?.ok ? 200 : 409,
      status: res?.status || (res?.ok ? 'applied' : 'conflict'),
      runId,
      appliedArtifacts: res?.appliedArtifacts ?? [],
      appliedFiles: res?.appliedFiles ?? [],
      conflicts: res?.conflicts ?? [],
      errors: res?.errors ?? [],
    };
  }
}
