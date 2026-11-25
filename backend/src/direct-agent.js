import { modelToolCatalog, selectionRecoveryHint } from './tools/selection.js';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Fault, id as uuid } from './store.js';
import { excerpt } from './context.js';
import { AgentRuntimeKernel } from './kernel/runtime.js';
import { EvidenceVerifier } from './governance/verifier.js';
import { convergeScheduledRunForTurn } from './governance/scheduler.js';
import { RecoveryError, classifyError } from './kernel/errors.js';
import { RUNTIME_EVENTS } from './kernel/events.js';
import { classifyFailureKind, safeIsolateSideEffect } from './kernel/verdict.js';
import { DurableJobQueue } from './durable/job-queue.js';
import { CheckpointStore } from './durable/checkpoint.js';
import { UnknownOutcomeReconciler } from './durable/reconciliation.js';
import { RecoveryWorker } from './durable/recovery.js';
import {
  assertLeaseInTx,
  checkLeaseHeld,
  isLeaseLostError,
  renewTurnLease,
} from './durable/lease-guard.js';
import {
  classifyTrafficSource,
  getTraceContext,
  withTraceContext,
} from './observability/trace.js';
import { logEvent } from './observability/logger.js';
import { BUDGET_SCOPES } from './swarm/budget-ledger.js';
import {
  discoverMemoryAndSkills,
  discoverNativeCustomizations,
  discoverProjectInstructions,
  expandNativeSlashCommand,
  HookRunner,
  importExternalConfigItems,
  scanExternalConfigs,
} from './agent-context.js';
import {
  BackgroundProcessManager,
  createWorkspaceTools,
} from './workspace-tools.js';
import { McpHub } from './mcp-client.js';
import { ToolDispatcher } from './tools/dispatcher.js';
import { createDirectAutoReviewer } from './tools/auto-approval.js';
import {
  ToolPermissionPolicy,
  filterToolsByPolicy,
  intersectPolicies,
} from './tools/policy.js';
import { validatePlan } from './planning/validator.js';
import { HookTrustManager } from './tools/hook-trust.js';
import { GitWorktreeIsolator, HostSandboxAdapter } from './tools/sandbox.js';
import {
  BenchmarkSandbox,
  isPathInsideRoot,
  runHardenedGit,
} from './tools/benchmark-sandbox.js';
import { McpLifecycleManager } from './tools/mcp-lifecycle.js';
import { DirectSessionRepo } from './runtime/session-repo.js';
import { DirectApprovalManager } from './runtime/approval-manager.js';
import { ShutdownCoordinator } from './runtime/shutdown.js';
import { ModelFeedbackTracker } from './swarm/feedback.js';
import { TokenBudgetManager } from './context/budget.js';
import { ProjectMemoryService } from './context/memory.js';
import { MultiStageCompactor } from './context/compaction.js';
import { ContextAssembler } from './context/assembler.js';
import { ReversibleContextStore, ContextEvidenceLedger } from './context/aci-store.js';
import {
  ACIEngine,
  PHASE_WATERMARK_V25_DTOC_POLICY,
  TRAJECTORY_EVICTION_V26_DTOC_POLICY,
  resolveWatermarksForPolicy,
} from './context/aci-engine.js';
import {
  ACI_CONFIG_KEY,
  ContextSupervisor,
  normalizeSupervisorConfig,
} from './context/supervisor.js';
import {
  AgentCapabilityRegistry,
  ModelCapabilityRegistry,
} from './swarm/capabilities.js';
import { AdaptiveModelRouter } from './swarm/router.js';
import {
  DynamicTaskPlanner,
  analyzeWorkspaceRepository,
  toCompactRepoContext,
} from './swarm/planner.js';
import { InterAgentMailbox } from './swarm/mailbox.js';
import { ChildAgentManager } from './swarm/child-lifecycle.js';
import { DynamicReplanner } from './swarm/replan.js';
import { AdaptiveSwarmOrchestrator } from './swarm/orchestrator.js';
import { SwarmArtifactManager } from './swarm/artifacts.js';

const ONBOARDING_EXTERNAL_KEY = 'onboarding.external.v1';
const CACHE_AWARE_V31_DTOC_POLICY_NAME = 'cache_aware_v31';

function normalizeOnboardingScopeKey(rawPath) {
  const norm = resolve(String(rawPath || process.cwd())).replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? norm.toLowerCase()
    : norm;
}

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function detectGitBranch(cwd) {
  try {
    const res = await runHardenedGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      allowNetwork: false,
      timeoutMs: 2500,
    });
    if (res.timedOut || res.exitCode !== 0) return null;
    return res.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Builds persisted `file/changed` event payload while preserving additive diff metadata
 * (`action`, `unifiedDiff`, `additions`, `deletions`, `sha256After`) when provided.
 */
export function buildFileChangedEventData(sessionId, turnId, change = {}) {
  const c = change && typeof change === 'object' ? change : {};
  return {
    turnId,
    sessionId,
    ...c,
    ...(c.action !== undefined ? { action: c.action } : {}),
    ...(c.unifiedDiff !== undefined ? { unifiedDiff: c.unifiedDiff } : {}),
    ...(c.additions !== undefined ? { additions: c.additions } : {}),
    ...(c.deletions !== undefined ? { deletions: c.deletions } : {}),
    ...(c.sha256After !== undefined ? { sha256After: c.sha256After } : {}),
  };
}

/**
 * DirectAgentRuntime orchestrates interactive & autonomous turns over:
 * - Layer 3: AgentRuntimeKernel + CancellationManager + EventRouter
 * - Layer 4: ToolDispatcher + ToolPermissionPolicy + HostSandboxAdapter + McpLifecycleManager
 * - Layer 5: ContextAssembler + MultiStageCompactor + ProjectMemoryService
 * - Layer 7: DirectSessionRepo + DurableJobQueue + CheckpointStore + RecoveryWorker
 */
export class DirectAgentRuntime {
  constructor(
    store,
    pool,
    {
      defaultWorkspace = process.cwd(),
      dataRoot = null,
      adapter = null,
      judgment = null,
      staticMcp = {},
      workerId = null,
      leaseMs = 15000,
      leaseRenewalIntervalMs = 5000,
      enableHeartbeat = true,
      artifactStoreDir = null,
      metrics = null,
      distillSyntheticTurns = false,
    } = {},
  ) {
    this.store = store;
    this.pool = pool;
    this.adapter = adapter ?? pool.adapter;
    this.judgment = judgment;
    this.metrics = metrics ?? pool?.metrics ?? null;
    this.intelligence = null;
    this.experienceMemory = null;
    this.distillSyntheticTurns = Boolean(distillSyntheticTurns);
    this.defaultWorkspace = resolve(defaultWorkspace);
    this.dataRoot = dataRoot ? resolve(dataRoot) : null;
    this.closed = false;
    this.leaseMs = Math.max(500, Number(leaseMs || 15000));
    this.leaseRenewalIntervalMs = Math.max(50, Number(leaseRenewalIntervalMs ?? 5000));

    this.jobQueue = new DurableJobQueue(this.store, { defaultLeaseMs: leaseMs });
    this.checkpointStore = new CheckpointStore(this.store);
    this.kernel = new AgentRuntimeKernel({
      store: this.store,
      adapter: this.adapter,
      pool: this.pool,
      judgment: this.judgment,
      checkpointStore: this.checkpointStore,
    });
    this.eventRouter = this.kernel.eventRouter;
    this.evidenceVerifier = new EvidenceVerifier({
      store: this.store,
      eventRouter: this.eventRouter,
    });
    this.kernel.setVerifier((args) => this.evidenceVerifier.verify(args));
    this.bus = this.eventRouter.bus;
    this.reconciler = new UnknownOutcomeReconciler(this.store, this.eventRouter);
    this.kernel.reconciler = this.reconciler;

    this.approvalManager = new DirectApprovalManager({
      store: this.store,
      eventRouter: this.eventRouter,
      reconciler: this.reconciler,
    });

    this.toolPolicy = new ToolPermissionPolicy();
    this.sandbox = new HostSandboxAdapter();
    this.hookTrust = new HookTrustManager({
      store: this.store,
      eventRouter: this.eventRouter,
    });
    this.kernel.setToolDispatcher(
      new ToolDispatcher({
        store: this.store,
        eventRouter: this.eventRouter,
        reconciler: this.reconciler,
        policy: this.toolPolicy,
        approvalManager: this.approvalManager,
        reviewApproval: createDirectAutoReviewer(this.judgment),
      }),
    );

    this.activeTurns = new Map(); // turnId -> { controller, sessionId }
    this.activeTurnPromises = new Map(); // turnId -> Promise
    this.activeSessionTurn = new Map(); // sessionId -> turnId
    this.steeringQueues = new Map(); // sessionId -> string[]
    this.readFileStates = new Map(); // sessionId -> Map(relPath -> { sha256, at })
    this.sessionSandboxes = new Map(); // sessionId -> { sandbox, disableWorkspaceHooks, disableWorkspaceMcp, forcedToolDeny }
    this.sessionProjects = new Map(); // sessionId -> projectId override
    this.sessionAciConfigs = new Map(); // sessionId -> { aciProfile, aciOptions }
    this.turnAciStates = new Map(); // turnId -> { sessionId, turnAciLedger, turnReadFiles, turnAciStore }

    this.processManager = new BackgroundProcessManager();
    this.mcpHub = new McpHub({
      dataRoot: this.dataRoot,
      staticMcp,
      trustManager: this.hookTrust,
    });
    this.mcpManager = new McpLifecycleManager({
      dataRoot: this.dataRoot,
      staticMcp,
      hub: this.mcpHub,
      trustManager: this.hookTrust,
    });

    this.budgetManager = new TokenBudgetManager();
    this.memoryService = new ProjectMemoryService(this.store);
    this.compactor = new MultiStageCompactor({
      store: this.store,
      eventRouter: this.eventRouter,
      budgetManager: this.budgetManager,
    });
    this.contextSupervisor = new ContextSupervisor({
      store: this.store,
      pool: this.pool,
      adapter: this.adapter,
    });

    this.recoveryWorker = new RecoveryWorker({
      store: this.store,
      jobQueue: this.jobQueue,
      checkpointStore: this.checkpointStore,
      reconciler: this.reconciler,
      eventRouter: this.eventRouter,
      workerId,
      leaseMs,
      enableHeartbeat,
      handlers: {
        direct_turn: (job, ctx) => this.#executeTurnJob(job, ctx),
      },
    });

    this.sessionRepo = new DirectSessionRepo({
      store: this.store,
      eventRouter: this.eventRouter,
      getWorkspaceRoot: () => this.getWorkspaceRoot(),
      getDefaultModel: () => this.pool.getDefaultModel(),
      onSessionDeleted: (sessionId) => {
        this.recoveryWorker.cancelJobBySession(sessionId);
        for (const [turnId, active] of this.activeTurns.entries()) {
          if (active.sessionId === sessionId) {
            active.controller.abort();
            this.activeTurns.delete(turnId);
          }
        }
        this.activeSessionTurn.delete(sessionId);
        this.steeringQueues.delete(sessionId);
        this.readFileStates.delete(sessionId);
        this.sessionSandboxes.delete(sessionId);
        this.sessionProjects.delete(sessionId);
        this.sessionAciConfigs.delete(sessionId);
        for (const [tid, st] of this.turnAciStates.entries()) {
          if (st?.sessionId === sessionId) this.turnAciStates.delete(tid);
        }
        this.contextAssembler.clearSession(sessionId);
      },
      onBeforeRewind: (sessionId) => {
        const runningTurnId = this.activeSessionTurn.get(sessionId);
        this.contextAssembler.clearSession(sessionId);
        if (runningTurnId) {
          this.cancelTurn(runningTurnId);
          const pendingJobs = [];
          for (const entry of this.recoveryWorker.active.values()) {
            if (entry.sessionId === sessionId && entry.done) {
              pendingJobs.push(entry.done);
            }
          }
          if (pendingJobs.length > 0) {
            return Promise.race([
              Promise.allSettled(pendingJobs),
              new Promise((r) => setTimeout(r, 3000)),
            ]);
          }
        }
      },
      onReadStateCleared: (sessionId) => {
        this.readFileStates.delete(sessionId);
      },
    });

    this.contextAssembler = new ContextAssembler({
      sessionRepo: this.sessionRepo,
      compactor: this.compactor,
      memoryService: this.memoryService,
    });

    // Layer 6: Adaptive Swarm Orchestrator & Dynamic Capability Routing
    this.worktreeIsolator = new GitWorktreeIsolator(this.store);
    this.artifactStoreDir = artifactStoreDir
      ? resolve(artifactStoreDir)
      : this.dataRoot
        ? join(this.dataRoot, 'swarm-artifacts')
        : this.store?.dbPath && this.store.dbPath !== ':memory:'
          ? join(dirname(resolve(this.store.dbPath)), 'swarm-artifacts')
          : join(tmpdir(), 'agent-us-swarm-artifacts');
    this.artifactManager = new SwarmArtifactManager({
      store: this.store,
      storageRoot: this.artifactStoreDir,
    });
    this.modelCapabilities = new ModelCapabilityRegistry(this.pool);
    this.agentCapabilities = new AgentCapabilityRegistry();
    this.modelFeedback = new ModelFeedbackTracker(this.store);
    this.adaptiveRouter = new AdaptiveModelRouter({
      modelRegistry: this.modelCapabilities,
      agentRegistry: this.agentCapabilities,
      pool: this.pool,
      feedbackTracker: this.modelFeedback,
      capabilityRegistry: null,
    });
    this.mailbox = new InterAgentMailbox({ store: this.store, eventRouter: this.eventRouter });
    this.swarmPlanner = new DynamicTaskPlanner({
      adapter: this.adapter,
      router: this.adaptiveRouter,
    });
    this.childManager = new ChildAgentManager({
      store: this.store,
      kernel: this.kernel,
      sessionRepo: this.sessionRepo,
      contextAssembler: this.contextAssembler,
      eventRouter: this.eventRouter,
      worktreeIsolator: this.worktreeIsolator,
      artifactManager: this.artifactManager,
      jobQueue: this.jobQueue,
      hookTrust: this.hookTrust,
      dataRoot: this.dataRoot,
      approvalManager: this.approvalManager,
      communication: this.mailbox.bus,
      resolveSessionSandbox: (sid) => this.#resolveSessionSandboxConfig(sid),
      getLivePolicy: (sessionId) => this.#getLiveSessionPolicy(sessionId),
      requestApproval: (request) => this.approvalManager.requestApproval(request),
      getDefaultModel: () => this.pool.getDefaultModel(),
      getWorkspaceTools: ({ workspaceRoot, sessionId, permissionMode, nonce, getLivePolicy, getApprovedPrefixes, requestApproval, approvalManager, signal }) => {
        const sbxCfg = this.#resolveSessionSandboxConfig(sessionId);
        const toolSandbox = sbxCfg?.sandbox
          ? this.#scopeSandboxForWorkspace(sbxCfg.sandbox, workspaceRoot)
          : this.sandbox;
        return createWorkspaceTools({
          workspaceRoot,
          dataRoot: this.dataRoot,
          store: this.store,
          sessionId,
          permissionMode,
          nonce,
          processManager: this.processManager,
          sandbox: toolSandbox,
          getLivePolicy,
          getApprovedPrefixes,
          requestApproval,
          approvalManager,
          onHookConfigMutated: ({ path, toolName }) =>
            this.hookTrust.onConfigMutated({ filePath: path, toolName }),
          signal,
        });
      },
    });
    this.swarmReplanner = new DynamicReplanner({
      store: this.store,
      planner: this.swarmPlanner,
      router: this.adaptiveRouter,
      eventRouter: this.eventRouter,
    });
    this.swarmOrchestrator = new AdaptiveSwarmOrchestrator({
      store: this.store,
      jobQueue: this.jobQueue,
      checkpointStore: this.checkpointStore,
      reconciler: this.reconciler,
      eventRouter: this.eventRouter,
      planner: this.swarmPlanner,
      router: this.adaptiveRouter,
      childManager: this.childManager,
      artifactManager: this.artifactManager,
      mailbox: this.mailbox,
      evidenceVerifier: this.evidenceVerifier,
      modelFeedback: this.modelFeedback,
      replanner: this.swarmReplanner,
      teamOptimizer: null,
    });

    this.shutdownCoordinator = new ShutdownCoordinator();
    this.shutdownCoordinator.registerSyncHook(() => {
      this.closed = true;
      for (const active of this.activeTurns.values()) {
        active.controller.abort('shutdown');
      }
      this.activeTurns.clear();
      this.activeSessionTurn.clear();
      this.turnAciStates.clear();
      this.recoveryWorker.stopping = true;
      this.recoveryWorker.started = false;
      if (this.recoveryWorker.unsubWake) {
        this.recoveryWorker.unsubWake();
        this.recoveryWorker.unsubWake = null;
      }
      if (this.recoveryWorker.timer) {
        clearInterval(this.recoveryWorker.timer);
        this.recoveryWorker.timer = null;
      }
      this.swarmOrchestrator.closeAll();
      this.kernel.close();
      this.processManager.closeAll();
    });
    this.shutdownCoordinator.registerStage(
      'recovery_worker',
      () => this.recoveryWorker.stop(),
      { order: 20, timeoutMs: 4000 },
    );
    this.shutdownCoordinator.registerStage(
      'worktrees',
      async () => {
        if (this._orphanCleanupPromise) {
          await this._orphanCleanupPromise.catch(() => {});
        }
        if (this.store?.db?.isOpen) await this.worktreeIsolator.cleanupAll({ preserveDirty: true });
      },
      { order: 30, timeoutMs: 4000 },
    );
    this.shutdownCoordinator.registerStage('mcp', () => this.mcpManager.close(), {
      order: 40,
      timeoutMs: 3000,
    });

    this.swarmOrchestrator.registerOnWorker(this.recoveryWorker);
    this.recoveryWorker.registerStartupHook(() => this.swarmOrchestrator.recoverInterruptedRuns());
    this.recoveryWorker.registerStartupHook(() => {
      this._orphanCleanupPromise = this.worktreeIsolator.cleanupOrphans().catch(() => ({
        cleaned: 0,
        preserved: 0,
        skippedLive: 0,
        paths: [],
      }));
    });
    this.reconciler.onResolved((res) => this.swarmOrchestrator.handleReconciliationResolved(res));

    this.lastRecoveryReport = this.recoveryWorker.start({ recover: true });
  }

  get pendingApprovals() {
    return this.approvalManager.pendingApprovals;
  }

  close() {
    return this.shutdownCoordinator.shutdown();
  }

  /** Attach the existing intelligence services without creating a second runtime loop. */
  attachIntelligenceServices(intelligence) {
    if (intelligence !== null && (typeof intelligence !== 'object' || !intelligence)) throw new TypeError('intelligence must be an object or null');
    this.intelligence = intelligence;
    this.experienceMemory = intelligence?.memory ?? null;
    if (intelligence?.memory) {
      this.contextAssembler.experienceMemoryService = intelligence.memory;
      this.swarmOrchestrator.experienceMemory = intelligence.memory;
    }
    if (intelligence?.communication) this.mailbox.setCommunicationBus?.(intelligence.communication);
    if (intelligence?.communication) this.childManager.communication = intelligence.communication;
    if (intelligence?.capabilityRegistry) {
      this.adaptiveRouter.capabilityRegistry = intelligence.capabilityRegistry;
      this.intelligenceCapabilityRegistry = intelligence.capabilityRegistry;
      this.swarmOrchestrator.capabilityRegistry = intelligence.capabilityRegistry;
    }
    if (intelligence?.teamOptimizer) this.swarmOrchestrator.teamOptimizer = intelligence.teamOptimizer;
    return intelligence;
  }

  /** Submit a validated planner plan to the existing durable swarm orchestrator. */
  submitPlannedSwarmRun(options = {}) {
    if (!this.intelligence?.planner) throw new Fault('INTELLIGENCE_UNAVAILABLE', 503);
    return this.swarmOrchestrator.submitPlannedRun(options);
  }

  /**
   * Explicit production autonomous execution entry:
   * decomposes an explicit goal through DynamicTaskPlanner, validates a structured
   * AdaptivePlanner DAG + permission ceiling + budget, and dispatches through Swarm.
   * Ordinary startTurn() direct chats remain unaffected.
   */
  async submitAutonomousGoal({
    goal,
    sessionId = null,
    workspaceRoot = null,
    permissionMode = null,
    maxConcurrency = null,
    budget = {},
    maxReplans = 2,
    maxNodes = 8,
    workspaceSummary = '',
    wait = false,
    trafficSource = 'production',
    isSynthetic = 0,
    signal = undefined,
  } = {}) {
    const cleanGoal = String(goal ?? '').trim();
    if (!cleanGoal) throw new Fault('EMPTY_GOAL', 400, { message: 'Autonomous goal is required' });

    const session = sessionId
      ? this.getSession(String(sessionId))
      : this.createSession({
          title: `[Autonomous] ${cleanGoal.slice(0, 60)}`,
          workspaceRoot: workspaceRoot ?? null,
          permissionMode: permissionMode ?? 'auto-safe',
          trafficSource,
          isSynthetic: Boolean(isSynthetic),
        });

    const effectivePerm = permissionMode
      ? intersectPolicies(
          { permissionMode: session.permissionMode || 'auto-safe' },
          { permissionMode: String(permissionMode) },
        ).permissionMode
      : session.permissionMode || 'auto-safe';
    const effectiveWorkspace = session.workspaceRoot || workspaceRoot || this.getWorkspaceRoot();

    const toPlannerPerm = (mode) => {
      const m = String(mode || 'auto-safe').trim();
      if (m === 'readonly' || m === 'read-only' || m === 'approval') return 'readonly';
      if (m === 'full' || m === 'full-access') return 'full';
      return 'auto-safe';
    };
    const pickPlannerBudget = (raw = {}) => {
      const out = {};
      for (const k of ['maxInputTokens', 'maxOutputTokens', 'maxSteps', 'maxTotalTokens', 'maxCostUsd']) {
        if (raw?.[k] !== undefined && Number.isFinite(Number(raw[k]))) out[k] = Number(raw[k]);
      }
      return out;
    };

    const analyzedRepo = effectiveWorkspace
      ? await analyzeWorkspaceRepository(effectiveWorkspace, { issueText: cleanGoal })
      : null;

    const planPerm = toPlannerPerm(effectivePerm);
    const decomposed = await this.swarmPlanner.decompose({
      goal: cleanGoal,
      workspaceRoot: effectiveWorkspace,
      repoContext: analyzedRepo ?? undefined,
      workspaceSummary,
      maxNodes,
      model: session.model || null,
      budget: pickPlannerBudget(budget),
      store: this.store,
      signal,
    });
    const compactRepoContext = toCompactRepoContext(decomposed?.repoContext ?? analyzedRepo);
    const parallelRootCount = decomposed.filter(
      (n) => !Array.isArray(n.dependencies) || n.dependencies.length === 0,
    ).length;
    const resolvedMaxConcurrency =
      maxConcurrency !== null && maxConcurrency !== undefined
        ? Math.min(8, Math.max(1, Number(maxConcurrency)))
        : Math.min(8, Math.max(3, parallelRootCount, decomposed.length > 2 ? decomposed.length - 1 : 3));

    const draftPlan = {
      planVersion: 1,
      goal: cleanGoal,
      permissionMode: planPerm,
      budget: pickPlannerBudget(budget),
      tasks: decomposed.map((node) => ({
        taskKey: node.nodeKey,
        objective: node.objective,
        acceptance: node.acceptance,
        taskType: node.taskType || 'research',
        dependencies: Array.isArray(node.dependencies) ? node.dependencies : [],
        permissionMode:
          node.taskType === 'review' || node.taskType === 'research' ? 'readonly' : planPerm,
        toolAllow: Array.isArray(node.toolAllow) ? node.toolAllow : null,
        budget: pickPlannerBudget(node.budget),
        sideEffects: [],
        metadata: {
          priority: Number(node.priority ?? 0),
          isolatedWorktree: Boolean(node.isolatedWorktree),
          ...(node.isolationMode ? { isolationMode: node.isolationMode } : {}),
          allowIsolationFallback: Boolean(node.allowIsolationFallback),
          ...(node.roleTitle ? { roleTitle: node.roleTitle } : {}),
          ...(node.focus ? { focus: node.focus } : {}),
          ...(Array.isArray(node.ownedPaths) && node.ownedPaths.length > 0 ? { ownedPaths: node.ownedPaths } : {}),
          ...(node.budget?.finalVerificationReserve != null
            ? { finalVerificationReserve: Number(node.budget.finalVerificationReserve) }
            : {}),
          ...(node.budgetEstimate ? { budgetBreakdown: node.budgetEstimate } : {}),
        },
      })),
      ...(compactRepoContext ? { metadata: { repoContext: compactRepoContext } } : {}),
    };
    const validatedPlan = this.intelligence?.planner
      ? validatePlan(this.intelligence.planner.validate(draftPlan), { permissionCeiling: planPerm })
      : validatePlan(draftPlan, { permissionCeiling: planPerm });

    const submitted = this.swarmOrchestrator.submitPlannedRun({
      plan: validatedPlan,
      sessionId: session.id,
      workspaceRoot: effectiveWorkspace,
      parentPermissionMode: effectivePerm,
      maxConcurrency: resolvedMaxConcurrency,
      budget: budget ?? validatedPlan.budget,
      maxReplans,
      trafficSource,
      isSynthetic,
    });

    if (wait) {
      const settled = await this.swarmOrchestrator.waitForRun(submitted.runId, { signal });
      return { ...settled, sessionId: session.id, plan: validatedPlan };
    }
    return { ...submitted, plan: validatedPlan };
  }

  /** Wait for a turn row to become terminal after cancellation or timeout. */
  async waitForTurnTerminal(turnId, { timeoutMs = 30_000, signal } = {}) {
    const id = String(turnId || '');
    if (!id) throw new Fault('TURN_ID_REQUIRED', 400);
    const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 30_000);
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error('wait aborted'), { name: 'AbortError', code: 'E_WAIT_ABORTED' });
      const row = this.store.db?.prepare('SELECT * FROM direct_turns WHERE id=?').get(id);
      if (!row) throw new Fault('TURN_NOT_FOUND', 404);
      if (['completed', 'failed', 'cancelled'].includes(row.state)) {
        const pendingDones = [];
        const activeTurnPromise = this.activeTurnPromises?.get?.(id);
        if (activeTurnPromise) {
          pendingDones.push(activeTurnPromise);
        }
        for (const entry of this.recoveryWorker?.active?.values?.() ?? []) {
          if (entry?.turnId === id && entry?.done && !pendingDones.includes(entry.done)) {
            pendingDones.push(entry.done);
          }
        }
        if (pendingDones.length > 0) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            throw Object.assign(new Error('turn drain timeout'), { code: 'TURN_DRAIN_TIMEOUT' });
          }
          let drained = false;
          await new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
              clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
            };
            const finish = (err = null) => {
              if (settled) return;
              settled = true;
              cleanup();
              if (err) reject(err);
              else resolve();
            };
            const timer = setTimeout(() => finish(null), remainingMs);
            timer.unref?.();
            const onAbort = () =>
              finish(Object.assign(new Error('wait aborted'), { name: 'AbortError', code: 'E_WAIT_ABORTED' }));
            signal?.addEventListener('abort', onAbort, { once: true });
            Promise.allSettled(pendingDones).then(() => {
              drained = true;
              finish(null);
            });
          });
          if (!drained) {
            throw Object.assign(new Error('turn drain timeout'), { code: 'TURN_DRAIN_TIMEOUT' });
          }
          return this.store.db?.prepare('SELECT * FROM direct_turns WHERE id=?').get(id) ?? row;
        }
        return row;
      }
      if (Date.now() >= deadline) throw Object.assign(new Error('turn drain timeout'), { code: 'TURN_DRAIN_TIMEOUT' });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        timer.unref?.();
        const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('wait aborted'), { name: 'AbortError', code: 'E_WAIT_ABORTED' })); };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  getWorkspaceRoot() {
    const saved = this.store.getSetting('workspace.root', null);
    return saved ? resolve(String(saved)) : this.defaultWorkspace;
  }

  setWorkspaceRoot(dirPath) {
    const clean = resolve(String(dirPath || '').trim() || this.defaultWorkspace);
    this.store.setSetting('workspace.root', clean);
    return { workspaceRoot: clean };
  }

  #emitPersisted(sessionId, turnId, type, data, { audit = false } = {}) {
    return this.eventRouter.emitPersisted({ sessionId, turnId, type, data, audit });
  }

  #emitLiveDelta(sessionId, turnId, type, data) {
    return this.eventRouter.emitEphemeral({ sessionId, turnId, type, data });
  }

  subscribe(sessionId, listener) {
    return this.eventRouter.subscribe(sessionId, listener);
  }

  // ---- Delegated Session & Approval APIs ----

  listSessions(opts) {
    return this.sessionRepo.listSessions(opts);
  }
  getSession(sessionId) {
    return this.sessionRepo.getSession(sessionId);
  }
  #resolveSessionSandboxConfig(sessionOrId) {
    if (!sessionOrId) return null;
    const isObj = typeof sessionOrId === 'object';
    const directId = isObj ? sessionOrId.id : String(sessionOrId);
    if (directId && this.sessionSandboxes.has(directId)) {
      return this.sessionSandboxes.get(directId);
    }
    let session = isObj ? sessionOrId : null;
    if (!session && directId && this.store?.db?.isOpen) {
      session =
        this.store.db
          .prepare('SELECT id, parentSessionId, rootSessionId FROM direct_sessions WHERE id=?')
          .get(directId) ?? null;
    }
    if (!session) return null;
    for (const cid of [session.id, session.parentSessionId, session.rootSessionId]) {
      if (cid && this.sessionSandboxes.has(cid)) {
        return this.sessionSandboxes.get(cid);
      }
    }
    let curParentId = session.parentSessionId;
    const seen = new Set([session.id, session.parentSessionId, session.rootSessionId].filter(Boolean));
    let hops = 0;
    while (curParentId && hops++ < 12 && this.store?.db?.isOpen) {
      if (this.sessionSandboxes.has(curParentId)) {
        return this.sessionSandboxes.get(curParentId);
      }
      if (seen.has(curParentId)) break;
      seen.add(curParentId);
      const parentRow = this.store.db
        .prepare('SELECT parentSessionId, rootSessionId FROM direct_sessions WHERE id=?')
        .get(curParentId);
      if (!parentRow) break;
      if (parentRow.rootSessionId && this.sessionSandboxes.has(parentRow.rootSessionId)) {
        return this.sessionSandboxes.get(parentRow.rootSessionId);
      }
      curParentId = parentRow.parentSessionId;
    }
    return null;
  }

  #scopeSandboxForWorkspace(baseSandbox, workspaceRoot) {
    if (!baseSandbox || !workspaceRoot) return baseSandbox;
    if (!(baseSandbox instanceof BenchmarkSandbox)) return baseSandbox;
    if (!baseSandbox.workspaceRoot) return baseSandbox;
    let inside = false;
    try {
      inside = isPathInsideRoot(baseSandbox.workspaceRoot, workspaceRoot, { allowEqual: true });
    } catch {
      inside = resolve(baseSandbox.workspaceRoot) === resolve(workspaceRoot);
    }
    if (inside) return baseSandbox;
    return new BenchmarkSandbox({
      mode: baseSandbox.mode,
      allowProcessHardeningOnly: baseSandbox.allowProcessHardeningOnly,
      workspaceRoot,
      dependencyPolicy: baseSandbox.dependencyPolicy,
      dockerSandbox: baseSandbox.dockerSandbox,
      nodePermissionSandbox: baseSandbox.nodePermissionSandbox,
      allowWorkspaceNodeCli: baseSandbox.allowWorkspaceNodeCli,
      timeoutMs: baseSandbox.timeoutMs,
      cpuLimitSec: baseSandbox.cpuLimitSec,
      memoryLimitMb: baseSandbox.memoryLimitMb,
      maxOutputBytes: baseSandbox.maxOutputBytes,
    });
  }

  #resolveAciTurnConfig(sessionId, turnAciProfile = undefined, turnAciOptions = undefined) {
    const VALID_PROFILES = new Set([
      'raw_full',
      'deterministic_progressive',
      'retrieval_supervisor',
      'full_aci',
      'aci_25',
      'aci_26',
      'aci_31',
    ]);
    const sessionCfg = this.sessionAciConfigs.get(sessionId) ?? {};
    const rawProfile = turnAciProfile ?? sessionCfg.aciProfile ?? 'full_aci';
    const aciProfile = VALID_PROFILES.has(rawProfile) ? rawProfile : 'full_aci';
    const mergedOptions = {
      ...(sessionCfg.aciOptions && typeof sessionCfg.aciOptions === 'object' ? sessionCfg.aciOptions : {}),
      ...(turnAciOptions && typeof turnAciOptions === 'object' ? turnAciOptions : {}),
    };

    const baseSupCfg = this.contextSupervisor.getConfig();
    const supCfg = mergedOptions.supervisorConfigOverride
      ? normalizeSupervisorConfig({
          ...baseSupCfg,
          ...mergedOptions.supervisorConfigOverride,
        })
      : baseSupCfg;

    let admissionEnabled = true;
    let supervisorEnabled = true;
    let dtocEnabled = true;
    let supervisorConfigOverride = supCfg;

    if (aciProfile === 'raw_full') {
      admissionEnabled = false;
      supervisorEnabled = false;
      dtocEnabled = false;
      supervisorConfigOverride = {
        ...supCfg,
        enabled: false,
        mode: 'off',
        admissionEnabled: false,
      };
    } else if (aciProfile === 'deterministic_progressive') {
      admissionEnabled = true;
      supervisorEnabled = false;
      dtocEnabled = false;
      supervisorConfigOverride = {
        ...supCfg,
        enabled: false,
        mode: 'off',
        admissionEnabled: true,
      };
    } else if (aciProfile === 'retrieval_supervisor') {
      admissionEnabled = true;
      dtocEnabled = false;
      const effectiveCfg = mergedOptions.supervisorConfigOverride
        ? supCfg
        : {
            ...supCfg,
            enabled: true,
            mode: supCfg.mode === 'off' ? 'auto' : supCfg.mode,
          };
      supervisorEnabled = Boolean(effectiveCfg.enabled && effectiveCfg.mode !== 'off');
      supervisorConfigOverride = { ...effectiveCfg, admissionEnabled: true };
    } else {
      admissionEnabled =
        mergedOptions.admissionEnabled !== undefined
          ? Boolean(mergedOptions.admissionEnabled)
          : supCfg.admissionEnabled !== false;
      supervisorEnabled = Boolean(supCfg.enabled && supCfg.mode !== 'off');
      dtocEnabled =
        mergedOptions.dtocEnabled !== undefined ? Boolean(mergedOptions.dtocEnabled) : true;
      supervisorConfigOverride = supCfg;
    }

    let dtocPolicy;
    if (
      mergedOptions.dtocPolicy === 'cumulative' ||
      mergedOptions.dtocPolicy === 'adaptive_single_step' ||
      mergedOptions.dtocPolicy === 'phase_watermark_v25' ||
      mergedOptions.dtocPolicy === TRAJECTORY_EVICTION_V26_DTOC_POLICY ||
      mergedOptions.dtocPolicy === CACHE_AWARE_V31_DTOC_POLICY_NAME
    ) {
      dtocPolicy = mergedOptions.dtocPolicy;
    } else if (aciProfile === 'aci_25') {
      dtocPolicy = PHASE_WATERMARK_V25_DTOC_POLICY;
    } else if (aciProfile === 'aci_26') {
      dtocPolicy = TRAJECTORY_EVICTION_V26_DTOC_POLICY;
    } else if (aciProfile === 'full_aci' || aciProfile === 'aci_31') {
      dtocPolicy = CACHE_AWARE_V31_DTOC_POLICY_NAME;
    } else {
      dtocPolicy = 'adaptive_single_step';
    }
    const storedSupRaw =
      this.store && typeof this.store.getSetting === 'function'
        ? this.store.getSetting(ACI_CONFIG_KEY, null)
        : null;
    const explicitV31DtocMinPrompt =
      mergedOptions.dtocMinPromptTokens != null &&
      Number.isFinite(Number(mergedOptions.dtocMinPromptTokens))
        ? Math.max(1000, Math.trunc(Number(mergedOptions.dtocMinPromptTokens)))
        : mergedOptions.supervisorConfigOverride?.dtocMinPromptTokens != null &&
            Number.isFinite(Number(mergedOptions.supervisorConfigOverride.dtocMinPromptTokens))
          ? Math.max(1000, Math.trunc(Number(mergedOptions.supervisorConfigOverride.dtocMinPromptTokens)))
          : storedSupRaw?.dtocMinPromptTokens != null &&
              Number.isFinite(Number(storedSupRaw.dtocMinPromptTokens))
            ? Math.max(1000, Math.trunc(Number(storedSupRaw.dtocMinPromptTokens)))
            : undefined;
    const dtocMinPromptTokens =
      dtocPolicy === CACHE_AWARE_V31_DTOC_POLICY_NAME
        ? explicitV31DtocMinPrompt
        : mergedOptions.dtocMinPromptTokens != null &&
            Number.isFinite(Number(mergedOptions.dtocMinPromptTokens))
          ? Math.max(1000, Math.trunc(Number(mergedOptions.dtocMinPromptTokens)))
          : supCfg.dtocMinPromptTokens;
    const singleStepBudget =
      mergedOptions.singleStepBudget != null && Number.isFinite(Number(mergedOptions.singleStepBudget))
        ? Math.max(500, Math.trunc(Number(mergedOptions.singleStepBudget)))
        : undefined;
    const maxSupervisorAdmissionCalls =
      mergedOptions.maxSupervisorAdmissionCalls != null &&
      Number.isFinite(Number(mergedOptions.maxSupervisorAdmissionCalls))
        ? Math.max(0, Math.trunc(Number(mergedOptions.maxSupervisorAdmissionCalls)))
        : undefined;
    const admissionMinChars =
      mergedOptions.admissionMinChars != null &&
      Number.isFinite(Number(mergedOptions.admissionMinChars))
        ? Math.max(200, Math.trunc(Number(mergedOptions.admissionMinChars)))
        : undefined;
    const rawWorkingSetReadMaxChars =
      mergedOptions.workingSetReadMaxChars !== undefined && mergedOptions.workingSetReadMaxChars !== null
        ? mergedOptions.workingSetReadMaxChars
        : aciProfile === 'aci_26'
          ? 0
          : undefined;
    const workingSetReadMaxChars =
      rawWorkingSetReadMaxChars !== undefined && Number.isFinite(Number(rawWorkingSetReadMaxChars))
        ? Math.max(0, Math.trunc(Number(rawWorkingSetReadMaxChars)))
        : undefined;
    const minNetSavingsTokens =
      mergedOptions.minNetSavingsTokens != null &&
      Number.isFinite(Number(mergedOptions.minNetSavingsTokens))
        ? Math.max(0, Math.trunc(Number(mergedOptions.minNetSavingsTokens)))
        : undefined;
    const evictionCooldownSteps =
      mergedOptions.evictionCooldownSteps != null &&
      Number.isFinite(Number(mergedOptions.evictionCooldownSteps))
        ? Math.max(0, Math.trunc(Number(mergedOptions.evictionCooldownSteps)))
        : undefined;
    const hasCustomWatermarks =
      (dtocPolicy !== PHASE_WATERMARK_V25_DTOC_POLICY &&
        dtocPolicy !== TRAJECTORY_EVICTION_V26_DTOC_POLICY &&
        dtocPolicy !== CACHE_AWARE_V31_DTOC_POLICY_NAME) ||
      (Array.isArray(mergedOptions.watermarks) && mergedOptions.watermarks.length > 0) ||
      (Array.isArray(mergedOptions.epochWatermarks) && mergedOptions.epochWatermarks.length > 0) ||
      (Array.isArray(mergedOptions.supervisorConfigOverride?.epochWatermarks) &&
        mergedOptions.supervisorConfigOverride.epochWatermarks.length > 0) ||
      (Array.isArray(storedSupRaw?.epochWatermarks) && storedSupRaw.epochWatermarks.length > 0);
    const engineWatermarks = hasCustomWatermarks
      ? resolveWatermarksForPolicy(
          dtocPolicy,
          mergedOptions.watermarks ?? mergedOptions.epochWatermarks ?? supCfg.epochWatermarks,
        )
      : resolveWatermarksForPolicy(dtocPolicy);

    return {
      aciProfile,
      admissionEnabled,
      supervisorEnabled,
      dtocEnabled,
      dtocPolicy,
      dtocMinPromptTokens,
      singleStepBudget,
      maxSupervisorAdmissionCalls,
      admissionMinChars,
      workingSetReadMaxChars,
      minNetSavingsTokens,
      evictionCooldownSteps,
      engineWatermarks,
      supervisorConfigOverride,
    };
  }

  createSession(opts = {}) {
    const {
      sandbox = null,
      sandboxProfile = null,
      disableWorkspaceHooks = undefined,
      disableWorkspaceMcp = undefined,
      callerSessionId = null,
      projectId = null,
      aciProfile = undefined,
      aciOptions = undefined,
      ...sessionOpts
    } = opts ?? {};

    const saveSessionAci = (createdSession) => {
      const inheritedAci =
        this.sessionAciConfigs.get(sessionOpts.parentSessionId) ??
        this.sessionAciConfigs.get(sessionOpts.rootSessionId) ??
        this.sessionAciConfigs.get(callerSessionId) ??
        null;
      if (aciProfile !== undefined || aciOptions !== undefined || inheritedAci) {
        this.sessionAciConfigs.set(createdSession.id, {
          aciProfile: aciProfile ?? inheritedAci?.aciProfile,
          aciOptions:
            aciOptions !== undefined
              ? { ...(inheritedAci?.aciOptions ?? {}), ...(aciOptions ?? {}) }
              : inheritedAci?.aciOptions
                ? { ...inheritedAci.aciOptions }
                : undefined,
        });
      }
    };

    const inheritedCfg =
      this.#resolveSessionSandboxConfig(sessionOpts.parentSessionId) ??
      this.#resolveSessionSandboxConfig(sessionOpts.rootSessionId) ??
      this.#resolveSessionSandboxConfig(callerSessionId);

    const activeProfile = sandboxProfile ?? (inheritedCfg ? 'benchmark' : null);
    const useBenchmarkSandbox = Boolean(sandbox || inheritedCfg || activeProfile === 'benchmark');
    if (!useBenchmarkSandbox) {
      const created = this.sessionRepo.createSession(sessionOpts);
      if (projectId && String(projectId).trim()) {
        this.sessionProjects.set(created.id, String(projectId).trim());
      }
      saveSessionAci(created);
      return created;
    }

    const resolvedSandbox =
      sandbox ??
      inheritedCfg?.sandbox ??
      new BenchmarkSandbox({
        workspaceRoot: sessionOpts.workspaceRoot ?? null,
      });
    resolvedSandbox.resolveBackend();

    const forcedToolDeny = ['start_process', 'web_fetch', 'web_search'];
    const mergedToolDeny = [
      ...new Set([
        ...(Array.isArray(sessionOpts.toolDeny) ? sessionOpts.toolDeny.map(String) : []),
        ...forcedToolDeny,
      ]),
    ];

    const created = this.sessionRepo.createSession({
      ...sessionOpts,
      toolDeny: mergedToolDeny,
    });

    if (projectId && String(projectId).trim()) {
      this.sessionProjects.set(created.id, String(projectId).trim());
    }
    saveSessionAci(created);

    this.sessionSandboxes.set(created.id, {
      sandbox: resolvedSandbox,
      disableWorkspaceHooks:
        disableWorkspaceHooks ?? inheritedCfg?.disableWorkspaceHooks ?? true,
      disableWorkspaceMcp:
        disableWorkspaceMcp ?? inheritedCfg?.disableWorkspaceMcp ?? true,
      forcedToolDeny,
    });
    return created;
  }
  updateSession(sessionId, patch) {
    return this.sessionRepo.updateSession(sessionId, patch);
  }
  deleteSession(sessionId) {
    return this.sessionRepo.deleteSession(sessionId);
  }
  listTurns(sessionId, opts) {
    return this.sessionRepo.listTurns(sessionId, opts);
  }
  listMessages(sessionId, opts) {
    return this.sessionRepo.listMessages(sessionId, opts);
  }
  listEvents(sessionId, { after = 0, limit = 300 } = {}) {
    return this.eventRouter.list(sessionId, { after, limit });
  }
  listSnapshots(sessionId) {
    return this.sessionRepo.listSnapshots(sessionId);
  }
  rewindSession(sessionId, opts) {
    return this.sessionRepo.rewindSession(sessionId, opts);
  }
  listApprovals(opts) {
    return this.approvalManager.listApprovals(opts);
  }
  decideApproval(approvalId, opts) {
    return this.approvalManager.decideApproval(approvalId, opts);
  }

  // ---- Explicit Hook Config Trust Boundary APIs ----

  approveHookConfig(filePath = null, opts = {}) {
    const target = filePath || join(this.getWorkspaceRoot(), '.agent-us', 'hooks.json');
    return this.hookTrust.approveFile(target, {
      workspaceRoot: opts.workspaceRoot ?? this.getWorkspaceRoot(),
      ...opts,
    });
  }

  revokeHookConfig(filePath = null, opts = {}) {
    const target = filePath || join(this.getWorkspaceRoot(), '.agent-us', 'hooks.json');
    return this.hookTrust.revokeFile(target, opts);
  }

  inspectHookConfig(filePath = null) {
    const target = filePath || join(this.getWorkspaceRoot(), '.agent-us', 'hooks.json');
    return this.hookTrust.inspectFile(target);
  }

  listHookTrust(opts = {}) {
    return this.hookTrust.listApprovals(opts);
  }

  // ---- Explicit External Config Onboarding & Native Customizations ----

  #readOnboardingExternalState() {
    const raw = this.store?.getSetting?.(ONBOARDING_EXTERNAL_KEY, null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { version: 1, users: {}, workspaces: {} };
    }
    return {
      version: 1,
      users: raw.users && typeof raw.users === 'object' && !Array.isArray(raw.users) ? { ...raw.users } : {},
      workspaces:
        raw.workspaces && typeof raw.workspaces === 'object' && !Array.isArray(raw.workspaces)
          ? { ...raw.workspaces }
          : {},
    };
  }

  #buildOnboardingStateSummary(state, userKey, wsKey, { hasUserItems = false, hasWorkspaceItems = false } = {}) {
    const userEntry = state.users?.[userKey] ?? null;
    const wsEntry = state.workspaces?.[wsKey] ?? null;
    const userHandled = userEntry?.status === 'imported' || userEntry?.status === 'skipped';
    const workspaceHandled = wsEntry?.status === 'imported' || wsEntry?.status === 'skipped';
    const hasUnhandledScope = (hasUserItems && !userHandled) || (hasWorkspaceItems && !workspaceHandled);
    return {
      key: ONBOARDING_EXTERNAL_KEY,
      userScopeKey: userKey,
      workspaceKey: wsKey,
      userStatus: userEntry?.status ?? null,
      workspaceStatus: wsEntry?.status ?? null,
      hasUnhandledScope,
      updatedAt:
        Math.max(Number(userEntry?.updatedAt ?? 0), Number(wsEntry?.updatedAt ?? 0)) || null,
    };
  }

  async detectExternalConfigs({
    workspaceRoot = null,
    homeDir = null,
    force = false,
  } = {}) {
    const resolvedWs = resolve(String(workspaceRoot || this.getWorkspaceRoot()));
    const resolvedHome = resolve(
      String(homeDir || process.env.AGENT_US_TEST_HOMEDIR || homedir()),
    );
    const scan = scanExternalConfigs({
      workspaceRoot: resolvedWs,
      homeDir: resolvedHome,
    });
    const state = this.#readOnboardingExternalState();
    const userKey = normalizeOnboardingScopeKey(scan.homeDir);
    const wsKey = normalizeOnboardingScopeKey(scan.workspaceRoot);
    const hasUserItems = scan.publicItems.some((i) => i.scope === 'user');
    const hasWorkspaceItems = scan.publicItems.some((i) => i.scope === 'workspace');
    const onboardingState = this.#buildOnboardingStateSummary(state, userKey, wsKey, {
      hasUserItems,
      hasWorkspaceItems,
    });
    const promptNeeded =
      scan.publicItems.length > 0 && (Boolean(force) || onboardingState.hasUnhandledScope);

    return {
      promptNeeded,
      onboardingState,
      counts: scan.counts,
      providers: scan.providers,
      items: scan.publicItems,
    };
  }

  async importExternalConfigs({
    workspaceRoot = null,
    homeDir = null,
    action = 'import',
    itemIds = undefined,
    targetScope = 'auto',
    sessionId = null,
  } = {}) {
    const resolvedWs = resolve(String(workspaceRoot || this.getWorkspaceRoot()));
    const resolvedHome = resolve(
      String(homeDir || process.env.AGENT_US_TEST_HOMEDIR || homedir()),
    );
    const scan = scanExternalConfigs({
      workspaceRoot: resolvedWs,
      homeDir: resolvedHome,
    });
    const state = this.#readOnboardingExternalState();
    const userKey = normalizeOnboardingScopeKey(scan.homeDir);
    const wsKey = normalizeOnboardingScopeKey(scan.workspaceRoot);
    const now = Date.now();

    if (action === 'skip') {
      if (state.users[userKey]?.status !== 'imported') {
        state.users[userKey] = { status: 'skipped', updatedAt: now, importedIds: [] };
      }
      if (state.workspaces[wsKey]?.status !== 'imported') {
        state.workspaces[wsKey] = { status: 'skipped', updatedAt: now, importedIds: [] };
      }
      this.store?.setSetting?.(ONBOARDING_EXTERNAL_KEY, state);
      const onboardingState = this.#buildOnboardingStateSummary(state, userKey, wsKey, {
        hasUserItems: scan.publicItems.some((i) => i.scope === 'user'),
        hasWorkspaceItems: scan.publicItems.some((i) => i.scope === 'workspace'),
      });
      return {
        ok: true,
        action: 'skip',
        importedCount: 0,
        onboardingState,
        promptNeeded: false,
      };
    }

    const wantedSet = Array.isArray(itemIds) ? new Set(itemIds.map(String)) : null;
    const selectedRaw = wantedSet
      ? scan.rawItems.filter((item) => wantedSet.has(item.id))
      : scan.rawItems;

    const importedItems = importExternalConfigItems({
      workspaceRoot: scan.workspaceRoot,
      dataRoot: this.dataRoot,
      rawItems: selectedRaw,
      targetScope,
    });

    const userImportedIds = importedItems
      .filter((i) => i.sourceScope === 'user')
      .map((i) => i.id);
    const wsImportedIds = importedItems
      .filter((i) => i.sourceScope === 'workspace')
      .map((i) => i.id);

    state.users[userKey] = {
      status:
        userImportedIds.length > 0 || state.users[userKey]?.status === 'imported'
          ? 'imported'
          : 'skipped',
      updatedAt: now,
      importedIds: [...new Set([...(state.users[userKey]?.importedIds ?? []), ...userImportedIds])],
    };
    state.workspaces[wsKey] = {
      status:
        wsImportedIds.length > 0 || state.workspaces[wsKey]?.status === 'imported'
          ? 'imported'
          : 'skipped',
      updatedAt: now,
      importedIds: [...new Set([...(state.workspaces[wsKey]?.importedIds ?? []), ...wsImportedIds])],
    };
    this.store?.setSetting?.(ONBOARDING_EXTERNAL_KEY, state);

    this.eventRouter?.emitPersisted?.({
      sessionId: sessionId || '__onboarding__',
      turnId: null,
      type: RUNTIME_EVENTS.ONBOARDING_IMPORTED,
      data: {
        workspaceRoot: scan.workspaceRoot,
        action: 'import',
        importedCount: importedItems.length,
        itemIds: importedItems.map((i) => i.id),
        targetScope,
      },
      audit: true,
    });

    const customizations = await this.getWorkspaceCustomizations(scan.workspaceRoot);
    const onboardingState = this.#buildOnboardingStateSummary(state, userKey, wsKey, {
      hasUserItems: scan.publicItems.some((i) => i.scope === 'user'),
      hasWorkspaceItems: scan.publicItems.some((i) => i.scope === 'workspace'),
    });
    return {
      ok: true,
      action: 'import',
      importedCount: importedItems.length,
      importedItems,
      customizations,
      onboardingState,
      promptNeeded: false,
    };
  }

  async getWorkspaceCustomizations(workspaceRoot = null) {
    const resolvedWs = resolve(String(workspaceRoot || this.getWorkspaceRoot()));
    return discoverNativeCustomizations(resolvedWs, {
      dataRoot: this.dataRoot,
      hookTrust: this.hookTrust,
    });
  }

  // ---- Mid-Turn Steering Queue ----

  steerSession(sessionId, text, opts = {}) {
    const session = this.getSession(sessionId);
    const rawClean = String(text ?? '').trim();
    const files =
      opts?.files && typeof opts.files === 'object' && !Array.isArray(opts.files) && Object.keys(opts.files).length
        ? opts.files
        : null;
    if (!rawClean && !files) throw new Fault('EMPTY_INPUT', 400);
    const effectiveRaw = rawClean || '请结合附带文件继续处理。';
    const activeTurnId = this.activeSessionTurn.get(sessionId);
    if (!activeTurnId) {
      return {
        steered: false,
        ...this.startTurn(sessionId, {
          input: effectiveRaw,
          ...(files ? { files } : {}),
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}),
          ...(opts?.effort ? { effort: opts.effort } : {}),
        }),
      };
    }
    const workspaceRoot = session.workspaceRoot || this.getWorkspaceRoot();
    const expanded = expandNativeSlashCommand(workspaceRoot, effectiveRaw, {
      dataRoot: this.dataRoot,
    });
    const finalText = expanded.expandedText || effectiveRaw;
    const queue = this.steeringQueues.get(sessionId) ?? [];
    queue.push({
      text: finalText,
      rawText: effectiveRaw,
      ...(files ? { files } : {}),
    });
    this.steeringQueues.set(sessionId, queue);
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO direct_messages(
            sessionId, turnId, role, content, meta, createdAt
          ) VALUES(?,?,'user',?,?,?)`,
        )
        .run(
          sessionId,
          activeTurnId,
          finalText,
          JSON.stringify({
            steering: true,
            ...(files ? { files } : {}),
            ...(expanded.commandMeta ? { expandedCommand: expanded.commandMeta } : {}),
          }),
          Date.now(),
        );
    });
    this.#emitPersisted(sessionId, activeTurnId, RUNTIME_EVENTS.TURN_STEERED, {
      sessionId,
      turnId: activeTurnId,
      text: finalText,
      ...(finalText !== effectiveRaw ? { rawText: effectiveRaw } : {}),
      ...(files ? { fileCount: Object.keys(files).length } : {}),
    });
    return {
      steered: true,
      sessionId,
      turnId: activeTurnId,
      queued: queue.length,
      text: finalText,
    };
  }

  // ---- Non-Destructive Context Compaction ----

  async #summarizeHistoryWithLlm(messagesToSummarize, model, signal) {
    const transcript = messagesToSummarize
      .map((m) => {
        const txt = Array.isArray(m.content)
          ? m.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
          : '';
        return `[${m.role}]: ${txt.slice(0, 1200)}`;
      })
      .join('\n')
      .slice(0, 16000);
    if (!transcript.trim()) return '';
    let summary = '';
    for await (const chunk of this.adapter.stream({
      provider: 'pool',
      model,
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: '请将以下早期对话与工具执行记录压缩为简洁精准的中文交接摘要，保留关键文件路径、已完成的修改、重要决策与未解决的问题。不超过 600 字。',
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: transcript }] },
      ],
      maxTokens: 1024,
      signal,
    })) {
      if (chunk.type === 'text-delta') summary += chunk.text;
    }
    return summary.trim();
  }

  async compactSession(sessionId) {
    const session = this.getSession(sessionId);
    const model = session.model || this.pool.getDefaultModel();
    const res = await this.compactor.compactSession(sessionId, {
      keepRecent: 4,
      model,
      summarizeFn: (oldMsgs, m, sig) => this.#summarizeHistoryWithLlm(oldMsgs, m, sig),
    });
    if (res.compacted) {
      this.contextAssembler.clearSession(sessionId);
    }
    return res;
  }

  #getLiveSessionPolicy(sessionId) {
    if (!sessionId || !this.store?.db?.isOpen) return null;
    const row = this.store.db
      .prepare(
        'SELECT permissionMode, toolAllowJson, toolDenyJson, approvedPrefixes FROM direct_sessions WHERE id=?',
      )
      .get(sessionId);
    if (!row) return null;
    const hydrated = this.sessionRepo.hydrateSessionRow(row);
    const sbxCfg = this.#resolveSessionSandboxConfig(sessionId);
    const baseDeny = Array.isArray(hydrated.toolDeny) ? hydrated.toolDeny : [];
    const effectiveDeny = sbxCfg?.forcedToolDeny?.length
      ? [...new Set([...baseDeny, ...sbxCfg.forcedToolDeny])]
      : baseDeny;
    return {
      permissionMode: hydrated.permissionMode || 'auto-safe',
      allowTools: hydrated.toolAllow ?? undefined,
      denyTools: effectiveDeny.length ? effectiveDeny : undefined,
      approvedPrefixes: hydrated.approvedPrefixes ?? [],
    };
  }

  #repairOrphanedToolCalls(sessionId, { turnId = null, leaseGuard = null } = {}) {
    if (!sessionId || !this.store?.db?.isOpen) return 0;
    try {
      const rows = this.store.db
        .prepare('SELECT * FROM direct_messages WHERE sessionId=? ORDER BY seq ASC')
        .all(sessionId);
      if (!rows.length) return 0;

      // Only persist direct_messages repairs for the trailing assistant(tool_calls) message
      // (so seq adjacency is strictly preserved; earlier historical orphans are spliced cleanly
      // in-order by DirectSessionRepo.buildConversationMessages).
      let lastAssistantIdx = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].role === 'user') break;
        if (rows[i].role === 'assistant') {
          lastAssistantIdx = i;
          break;
        }
      }
      if (lastAssistantIdx < 0) return 0;
      const lastAssistant = rows[lastAssistantIdx];
      if (turnId && lastAssistant.turnId !== turnId) return 0;
      if (!lastAssistant.toolCalls) return 0;

      let toolCalls = [];
      try {
        toolCalls = JSON.parse(lastAssistant.toolCalls);
      } catch {
        return 0;
      }
      if (!Array.isArray(toolCalls) || !toolCalls.length) return 0;

      const answeredIds = new Set();
      for (let j = lastAssistantIdx + 1; j < rows.length; j++) {
        if (rows[j].role === 'tool' && rows[j].toolCallId) {
          answeredIds.add(rows[j].toolCallId);
        }
      }

      const missing = toolCalls.filter((tc) => tc?.id && !answeredIds.has(tc.id));
      if (!missing.length) return 0;

      let repaired = 0;
      const now = Date.now();
      this.store.tx(() => {
        if (leaseGuard) {
          assertLeaseInTx(leaseGuard, { sessionId, turnId: lastAssistant.turnId });
        }
        for (const tc of missing) {
          const receipt = this.store.db
            .prepare(
              'SELECT id, status, exitCode, errorCode FROM tool_receipts WHERE sessionId=? AND turnId=? AND callId=? ORDER BY createdAt DESC LIMIT 1',
            )
            .get(sessionId, lastAssistant.turnId, tc.id);
          if (receipt?.status === 'outcome_unknown' || receipt?.status === 'executing') {
            continue;
          }
          const isError = receipt ? receipt.status !== 'finished' : true;
          const content = receipt
            ? receipt.status === 'finished'
              ? `[recovered from tool_receipt ${receipt.id}] Tool "${tc.name}" already finished before interruption (exitCode=${receipt.exitCode ?? 0}).`
              : `[recovered from tool_receipt ${receipt.id}] Tool "${tc.name}" did not succeed (${receipt.status}${receipt.errorCode ? `: ${receipt.errorCode}` : ''}).`
            : `[interrupted before tool result persisted] Tool "${tc.name}" was interrupted before its result was recorded; re-verify before assuming success.`;
          this.store.db
            .prepare(
              `INSERT INTO direct_messages(
                sessionId, turnId, role, content, toolCallId, toolName, meta, createdAt
              ) VALUES(?,?,'tool',?,?,?,?,?)`,
            )
            .run(
              sessionId,
              lastAssistant.turnId,
              content,
              tc.id,
              tc.name,
              JSON.stringify({
                isError,
                recoveredFromReceipt: Boolean(receipt),
                receiptId: receipt?.id ?? null,
              }),
              now,
            );
          repaired++;
        }
      });
      return repaired;
    } catch (err) {
      if (isLeaseLostError(err)) throw err;
      return 0;
    }
  }

  #recordModelFeedbackSafely(payload) {
    // Provenance is written atomically with the feedback row. Do not select the
    // latest row by model because concurrent production/evaluation writes could
    // relabel another execution.
    return this.modelFeedback.record(payload);
  }

  #collectTurnExecutionSignals({ verifierEvents = null, modifiedFiles = null, sessionId, turnId } = {}) {
    const files = new Set(modifiedFiles ?? []);
    const toolReceipts = [];
    if (Array.isArray(verifierEvents) && verifierEvents.length > 0) {
      for (const ev of verifierEvents) {
        if (ev?.type !== 'tool/result' || !ev.data) continue;
        const { callId, name, isError, content, effectiveArgs, receipt } = ev.data;
        if (!isError && ['write_file', 'edit_file', 'apply_patch', 'delete_file'].includes(String(name))) {
          if (effectiveArgs?.path) files.add(String(effectiveArgs.path));
          if (effectiveArgs?.file_path) files.add(String(effectiveArgs.file_path));
          if (Array.isArray(effectiveArgs?.paths)) {
            for (const p of effectiveArgs.paths) if (p) files.add(String(p));
          }
        }
        toolReceipts.push({
          id: receipt?.id ?? callId ?? null,
          callId: callId ?? receipt?.callId ?? null,
          toolName: receipt?.toolName ?? name ?? '',
          status: receipt?.status ?? (isError ? 'failed' : 'finished'),
          isError: Boolean(isError),
          exitCode: receipt?.exitCode ?? null,
          errorCode: receipt?.errorCode ?? null,
          command: typeof effectiveArgs?.command === 'string' ? effectiveArgs.command : '',
          path: typeof effectiveArgs?.path === 'string' ? effectiveArgs.path : '',
          output: typeof content === 'string' ? content.slice(0, 600) : '',
        });
      }
    } else if (this.store?.db?.isOpen && sessionId && turnId) {
      try {
        const rows = this.store.db
          .prepare('SELECT id, callId, toolName, status, exitCode, errorCode FROM tool_receipts WHERE sessionId=? AND turnId=? ORDER BY createdAt ASC')
          .all(sessionId, turnId);
        for (const row of rows) {
          toolReceipts.push({ ...row, isError: row.status === 'failed' || (typeof row.exitCode === 'number' && row.exitCode !== 0) });
        }
      } catch {
        // minimal store fallback
      }
    }
    return { toolReceipts, modifiedFiles: [...files] };
  }

  #finalizeTurnExperienceAndTelemetry({
    session,
    projectId = null,
    sessionId,
    turnId,
    workspaceRoot,
    input,
    summary = '',
    verdict = null,
    evidenceCount = 0,
    reasoningMetrics = null,
    verifierEvents = null,
    modifiedFiles = null,
    error = null,
    errorCode = null,
    status = 'completed',
    effectiveModel = null,
    actualProvider = 'pool',
    actualAccountId = null,
    durationMs = 0,
    trafficSource = 'production',
    isSynthetic = false,
    distillSyntheticTurns = false,
  }) {
    if (reasoningMetrics && typeof reasoningMetrics === 'object') {
      safeIsolateSideEffect(() =>
        this.metrics?.record('reasoning_metrics', {
          sessionId,
          turnId,
          model: effectiveModel,
          provider: actualProvider,
          accountId: actualAccountId,
          ok: status === 'completed',
          durationMs,
          code: errorCode ?? null,
          trafficSource,
          isSynthetic: Boolean(isSynthetic),
          detail: reasoningMetrics,
        }),
      );
    }

    const expMemory = this.experienceMemory ?? this.intelligence?.memory ?? null;
    if (!expMemory) return;

    const turnIsSynthetic = Boolean(isSynthetic || session?.isSynthetic);
    const allowSynthetic = Boolean(distillSyntheticTurns || this.distillSyntheticTurns || session?.distillSyntheticTurns);
    if (turnIsSynthetic && !allowSynthetic) return;

    const signals = this.#collectTurnExecutionSignals({ verifierEvents, modifiedFiles, sessionId, turnId });
    let distilledCount = 0;

    if (typeof expMemory.distillTurnExperience === 'function') {
      const distilled = safeIsolateSideEffect(() =>
        expMemory.distillTurnExperience({
          projectId: projectId ?? session?.projectId ?? this.sessionProjects.get(sessionId) ?? workspaceRoot,
          input,
          summary,
          workspaceRoot,
          verdict,
          reasoningMetrics: reasoningMetrics ?? null,
          toolReceipts: signals.toolReceipts,
          modifiedFiles: signals.modifiedFiles,
          evaluationEvidence: null,
          error,
          errorCode,
          source: 'direct_turn',
          sourceTaskId: turnId,
          sessionId,
          turnId,
        }),
      );
      distilledCount = Array.isArray(distilled) ? distilled.length : 0;
    }

    const hasTaggedLines = /^\[(fact|preference|lesson|decision|constraint)\]\s+/im.test(String(summary ?? ''));
    if (!turnIsSynthetic && expMemory.recordExecutionCandidates && (distilledCount === 0 || hasTaggedLines)) {
      safeIsolateSideEffect(() =>
        expMemory.recordExecutionCandidates({
          projectId: projectId ?? session?.projectId ?? this.sessionProjects.get(sessionId) ?? workspaceRoot,
          source: 'direct_turn',
          sourceTaskId: turnId,
          sessionId,
          turnId,
          goal: input,
          summary,
          verdict,
          evidenceCount: Number(evidenceCount || 0),
          isSynthetic: Boolean(turnIsSynthetic),
        }),
      );
    }
  }

  // ---- Turn Enqueue & Lifecycle ----

  startTurn(
    sessionId,
    {
      input,
      clientTurnId = null,
      model = null,
      permissionMode = null,
      effort = null,
      maxSteps = undefined,
      finalVerificationReserve = null,
      files = null,
      evidenceContract = null,
      aciProfile = undefined,
      aciOptions = undefined,
      trafficSource = undefined,
      isSynthetic = undefined,
      distillSyntheticTurns = undefined,
    } = {},
  ) {
    const session = this.getSession(sessionId);
    const trimmedInput = String(input ?? '').trim();
    if (!trimmedInput) throw new Fault('EMPTY_INPUT', 400);

    if (this.activeSessionTurn.has(sessionId) && !clientTurnId) {
      const steered = this.steerSession(sessionId, trimmedInput, { files });
      return {
        steered: true,
        turn: this.store.db.prepare('SELECT * FROM direct_turns WHERE id=?').get(steered.turnId),
        session: this.getSession(sessionId),
      };
    }

    const traceCtx = getTraceContext();
    const classifiedTraffic = classifyTrafficSource(
      {
        trafficSource:
          trafficSource !== undefined
            ? trafficSource
            : (traceCtx.trafficSource ?? session.trafficSource ?? 'production'),
        isSynthetic:
          isSynthetic !== undefined
            ? isSynthetic
            : trafficSource !== undefined
              ? undefined
              : (traceCtx.isSynthetic ?? session.isSynthetic),
      },
      session.trafficSource || 'production',
    );

    const turnId = uuid();
    const jobId = uuid();
    const now = Date.now();
    const resolvedModel =
      (model && String(model).trim()) || session.model || this.pool.getDefaultModel() || '';
    const resolvedPerm = permissionMode || session.permissionMode || 'auto-safe';
    const effectiveMode = trimmedInput.startsWith('/plan ') ? 'plan' : session.mode || 'direct';
    const resolvedWorkspace = session.workspaceRoot || this.getWorkspaceRoot();
    const expandedCmd = expandNativeSlashCommand(resolvedWorkspace, trimmedInput, {
      dataRoot: this.dataRoot,
    });
    const effectiveInput = expandedCmd.expandedText || trimmedInput;
    const sessionAciMaxSteps = this.sessionAciConfigs.get(sessionId)?.aciOptions?.maxSteps;
    const rawMaxSteps =
      maxSteps !== undefined && maxSteps !== null
        ? maxSteps
        : aciOptions?.maxSteps !== undefined && aciOptions?.maxSteps !== null
          ? aciOptions.maxSteps
          : sessionAciMaxSteps;
    const parsedMaxSteps = Number(rawMaxSteps);
    const resolvedMaxSteps =
      Number.isFinite(parsedMaxSteps) && parsedMaxSteps > 0
        ? Math.min(80, Math.max(1, Math.trunc(parsedMaxSteps)))
        : 40;
    const jobPayload = {
      sessionId,
      turnId,
      input: effectiveInput,
      model: resolvedModel,
      mode: effectiveMode,
      permissionMode: resolvedPerm,
      effort: effort || null,
      workspaceRoot: resolvedWorkspace,
      maxSteps: resolvedMaxSteps,
      finalVerificationReserve:
        finalVerificationReserve !== null && Number.isFinite(Number(finalVerificationReserve))
          ? Math.max(0, Math.floor(Number(finalVerificationReserve)))
          : null,
      evidenceContract: evidenceContract && typeof evidenceContract === 'object' ? evidenceContract : null,
      ...(aciProfile !== undefined ? { aciProfile } : {}),
      ...(aciOptions !== undefined && aciOptions && typeof aciOptions === 'object' ? { aciOptions } : {}),
      trafficSource: classifiedTraffic.trafficSource,
      isSynthetic: classifiedTraffic.isSynthetic,
      ...(distillSyntheticTurns !== undefined ? { distillSyntheticTurns: Boolean(distillSyntheticTurns) } : {}),
    };

    const txResult = this.store.tx(() => {
      if (clientTurnId) {
        const existing = this.store.db
          .prepare('SELECT * FROM direct_turns WHERE sessionId=? AND clientTurnId=? LIMIT 1')
          .get(sessionId, clientTurnId);
        if (existing) {
          return { dedup: true, turn: existing };
        }
      }

      if (clientTurnId && this.store.db.prepare('SELECT 1 FROM swarm_command_receipts WHERE sessionId=? AND clientTurnId=?').get(sessionId, clientTurnId)) {
        throw new Fault('IDEMPOTENCY_CONFLICT', 409);
      }
      const activeSwarm = this.store.db.prepare(`SELECT r.id FROM swarm_runs r WHERE r.sessionId=?
        AND r.status NOT IN ('completed','failed','cancelled') AND EXISTS
        (SELECT 1 FROM swarm_command_receipts c WHERE c.sessionId=r.sessionId AND c.runId=r.id) LIMIT 1`).get(sessionId);
      if (activeSwarm) throw new Fault('SWARM_ALREADY_ACTIVE', 409, { runId: activeSwarm.id });
      // Reject concurrent startTurn on an active session (even when a fresh clientTurnId is supplied!)
      const activeMemTurnId = this.activeSessionTurn.get(sessionId) ?? null;
      const activeDbTurn = this.store.db
        .prepare(
          "SELECT id FROM direct_turns WHERE sessionId=? AND state IN ('running','reconciling','parked') LIMIT 1",
        )
        .get(sessionId);
      if (activeMemTurnId || activeDbTurn) {
        throw new Fault('SESSION_BUSY', 409, {
          message: 'Session already has an active turn',
          activeTurnId: activeDbTurn?.id ?? activeMemTurnId,
        });
      }

      const nextTitle =
        session.title === '新对话' || !session.title
          ? trimmedInput.slice(0, 120)
          : session.title;
      this.store.db
        .prepare(
          "UPDATE direct_sessions SET title=?, model=?, permissionMode=?, state='running', updatedAt=? WHERE id=?",
        )
        .run(nextTitle, resolvedModel, resolvedPerm, now, sessionId);
      this.store.db
        .prepare(
          `INSERT INTO direct_turns(
            id, sessionId, clientTurnId, input, model, state, jobId, phase, step,
            trafficSource, isSynthetic, createdAt
          ) VALUES(?,?,?,?,?,'running',?,'init',0,?,?,?)`,
        )
        .run(
          turnId,
          sessionId,
          clientTurnId,
          trimmedInput,
          resolvedModel,
          jobId,
          classifiedTraffic.trafficSource,
          classifiedTraffic.isSynthetic ? 1 : 0,
          now,
        );
      this.store.db
        .prepare(
          `INSERT INTO direct_messages(
            sessionId, turnId, role, content, meta, createdAt
          ) VALUES(?,?,'user',?,?,?)`,
        )
        .run(
          sessionId,
          turnId,
          effectiveInput,
          (files && Object.keys(files).length) || expandedCmd.commandMeta
            ? JSON.stringify({
                ...(files && Object.keys(files).length ? { files } : {}),
                ...(expandedCmd.commandMeta ? { expandedCommand: expandedCmd.commandMeta } : {}),
              })
            : null,
          now,
        );
      this.store.db
        .prepare(
          `INSERT INTO runtime_jobs(
            id, kind, sessionId, turnId, payload, status, attempts, maxAttempts, idempotencyKey, createdAt, updatedAt
          ) VALUES(?,'direct_turn',?,?,?,'pending',0,3,?,?,?)`,
        )
        .run(
          jobId,
          sessionId,
          turnId,
          JSON.stringify(jobPayload),
          clientTurnId ? `turn:${sessionId}:${clientTurnId}` : `turn:${turnId}`,
          now,
          now,
        );
      return { dedup: false, turnId };
    });

    if (txResult.dedup) {
      this.metrics?.record('turn_idem_dedup', {
        sessionId,
        turnId: txResult.turn.id,
        trafficSource: classifiedTraffic.trafficSource,
        isSynthetic: classifiedTraffic.isSynthetic,
        ok: true,
      });
      return { turn: txResult.turn, session: this.getSession(sessionId) };
    }

    const turn = this.store.db.prepare('SELECT * FROM direct_turns WHERE id=?').get(turnId);
    const controller = new AbortController();
    this.activeTurns.set(turnId, { controller, sessionId });
    this.activeSessionTurn.set(sessionId, turnId);
    this.store.notifyJobWake();

    return { turn, session: this.getSession(sessionId) };
  }

  async #executeTurnJob(job, { signal, leaseGuard, checkpoint }) {
    const payload = job.payload ?? {};
    const turnId = job.turnId || payload.turnId;
    const sessionId = job.sessionId || payload.sessionId;
    const existing = this.activeTurns.get(turnId);
    const controller = existing?.controller ?? new AbortController();
    this.activeTurns.set(turnId, { controller, sessionId });
    this.activeSessionTurn.set(sessionId, turnId);
    const combinedSignal = AbortSignal.any([signal, controller.signal]);
    const session = this.store.db.prepare('SELECT * FROM direct_sessions WHERE id=?').get(sessionId);
    if (!session || session.state === 'cancelled') return;

    const turnRow = this.store.db.prepare('SELECT * FROM direct_turns WHERE id=?').get(turnId);
    const resolvedModel = payload.model ?? session.model ?? this.pool.getDefaultModel() ?? '';
    const classifiedTraffic = classifyTrafficSource(
      {
        trafficSource:
          turnRow?.trafficSource ?? payload.trafficSource ?? session.trafficSource ?? 'production',
        isSynthetic:
          turnRow?.isSynthetic !== undefined
            ? Boolean(turnRow.isSynthetic)
            : payload.isSynthetic !== undefined
              ? Boolean(payload.isSynthetic)
              : Boolean(session.isSynthetic),
      },
      session.trafficSource || 'production',
    );

    return withTraceContext(
      {
        sessionId,
        turnId,
        jobId: job.id,
        workerId: this.recoveryWorker.workerId,
        attempt: Number(job.attempts || 1),
        fence: job.fence ?? null,
        model: resolvedModel || null,
        trafficSource: classifiedTraffic.trafficSource,
        isSynthetic: classifiedTraffic.isSynthetic,
      },
      async () => {
        // Atomically bind this worker's fence & attempt onto direct_turns before running
        try {
          this.store.tx(() => {
            assertLeaseInTx(leaseGuard, { sessionId, turnId, bindingOwnership: true });
            this.store.db
              .prepare(
                "UPDATE direct_turns SET activeFence=?, activeAttempt=? WHERE id=? AND state NOT IN ('completed','failed','cancelled')",
              )
              .run(job.fence ?? null, Number(job.attempts || 1), turnId);
          });
        } catch (err) {
          if (isLeaseLostError(err)) {
            this.metrics?.record('lease_lost_fenced', {
              sessionId,
              turnId,
              jobId: job.id,
              fence: job.fence ?? null,
              attempt: Number(job.attempts || 1),
              code: 'LEASE_LOST',
              trafficSource: classifiedTraffic.trafficSource,
              isSynthetic: classifiedTraffic.isSynthetic,
            });
            throw err;
          }
          throw err;
        }

        // Reconcile any executing / outcome_unknown non-replayable tool receipts before resuming
        // (protects dual-runtime takeover via claim() where recoverOnStartup did not run).
        const recCheck = this.reconciler.inspectInterruptedTurn(turnId, { sessionId });
        if (recCheck?.needsReconciliation) {
          throw new RecoveryError('RECONCILIATION_REQUIRED', {
            message:
              '存在状态未知的外部副作用 (outcome_unknown)，需人工核对后方可继续执行',
            detail: {
              turnId,
              sessionId,
              approvalId: recCheck.approvalId ?? null,
              unknownReceiptIds: (recCheck.unknownReceipts ?? []).map((u) => u.id),
            },
          });
        }

        let turnAciState = this.turnAciStates.get(turnId);
        if (!turnAciState) {
          turnAciState = {
            sessionId,
            turnAciLedger: new ContextEvidenceLedger(),
            turnReadFiles: new Set(),
            turnAciStore: new ReversibleContextStore(this.store),
          };
          if (checkpoint?.state?.aciLedger) {
            turnAciState.turnAciLedger.mergeFrom(checkpoint.state.aciLedger);
          }
          if (Array.isArray(checkpoint?.state?.filesRead)) {
            for (const p of checkpoint.state.filesRead) {
              const clean = String(p ?? '').trim();
              if (clean) turnAciState.turnReadFiles.add(clean);
            }
          }
          this.turnAciStates.set(turnId, turnAciState);
        }

        const turnPromise = this.#runTurnLoop({
          sessionId,
          turnId,
          input: payload.input ?? '',
          model: resolvedModel,
          mode: payload.mode ?? session.mode ?? 'direct',
          permissionMode: payload.permissionMode ?? session.permissionMode ?? 'auto-safe',
          effort: payload.effort ?? null,
          workspaceRoot: payload.workspaceRoot ?? session.workspaceRoot ?? this.getWorkspaceRoot(),
          maxSteps: (() => {
            const rawSteps = Number(payload.maxSteps ?? 40);
            return Number.isFinite(rawSteps) && rawSteps > 0
              ? Math.min(80, Math.max(1, Math.trunc(rawSteps)))
              : 40;
          })(),
          finalVerificationReserve: payload.finalVerificationReserve ?? null,
          evidenceContract: payload.evidenceContract ?? null,
          aciProfile: payload.aciProfile,
          aciOptions: payload.aciOptions,
          turnAciLedger: turnAciState.turnAciLedger,
          turnReadFiles: turnAciState.turnReadFiles,
          turnAciStore: turnAciState.turnAciStore,
          initialStep: checkpoint?.step ?? payload.resumedFromStep ?? 0,
          isRecovery: Boolean(job.reclaimedFromCrash || checkpoint?.step > 0 || job.attempts > 1),
          canRetry: job.attempts < job.maxAttempts,
          leaseGuard,
          signal: combinedSignal,
          trafficSource: classifiedTraffic.trafficSource,
          isSynthetic: classifiedTraffic.isSynthetic,
          distillSyntheticTurns: Boolean(payload.distillSyntheticTurns),
        });
        this.activeTurnPromises.set(turnId, turnPromise);
        try {
          await turnPromise;
        } catch (err) {
          if (isLeaseLostError(err)) throw err;
          if (this.closed || !this.store.db?.isOpen) return;
          throw err;
        } finally {
          if (this.activeTurnPromises.get(turnId) === turnPromise) {
            this.activeTurnPromises.delete(turnId);
          }
        }
      },
    );
  }

  cancelTurn(turnId) {
    const row = this.store.db.prepare('SELECT * FROM direct_turns WHERE id=?').get(turnId);
    if (!row) throw new Fault('TURN_NOT_FOUND', 404);
    if (!['running', 'reconciling', 'parked'].includes(row.state)) return row;
    this.recoveryWorker.cancelJobByTurn(turnId);
    this.kernel.cancellation.cancel(turnId, 'user_cancelled');
    const active = this.activeTurns.get(turnId);
    if (active) {
      active.controller.abort('user_cancelled');
      this.activeTurns.delete(turnId);
      if (this.activeSessionTurn.get(active.sessionId) === turnId) {
        this.activeSessionTurn.delete(active.sessionId);
      }
    }
    this.childManager?.cancelDescendants?.(row.sessionId);

    // Cancel any active Swarm runs and swarm_* jobs belonging to this session
    const activeSwarmRuns = this.store.db
      .prepare(
        "SELECT id FROM swarm_runs WHERE sessionId=? AND status IN ('pending','planning','running','reconciling','aggregating','verifying')",
      )
      .all(row.sessionId);
    for (const sr of activeSwarmRuns) {
      try {
        this.swarmOrchestrator?.cancelRun?.(sr.id);
      } catch (err) {
        logEvent('warn', 'direct_agent.cancel_swarm_run_error', {
          turnId,
          sessionId: row.sessionId,
          runId: sr.id,
          error: err,
        });
      }
    }

    if (['running', 'reconciling', 'parked'].includes(row.state)) {
      const now = Date.now();
      const outbox = this.store.tx(() => {
        const res = this.store.db
          .prepare(
            "UPDATE direct_turns SET state='cancelled', phase='cancelled', finishedAt=?, activeFence=NULL WHERE id=? AND state IN ('running','reconciling','parked')",
          )
          .run(now, turnId);
        if ((res.changes ?? 0) === 0) return null;
        this.store.db
          .prepare("UPDATE direct_sessions SET state='cancelled', updatedAt=? WHERE id=?")
          .run(now, row.sessionId);
        this.store.db
          .prepare(
            "UPDATE direct_approvals SET status='expired', resolvedAt=? WHERE turnId=? AND status='pending'",
          )
          .run(now, turnId);
        this.store.db
          .prepare(
            "UPDATE runtime_jobs SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE sessionId=? AND kind LIKE 'swarm_%' AND status IN ('pending','active','reconciling','parked')",
          )
          .run(now, row.sessionId);
        convergeScheduledRunForTurn(this.store, turnId, {
          status: 'cancelled',
          finishedAt: now,
        });
        const phaseEv = this.eventRouter.insertPersistedInTx({
          sessionId: row.sessionId,
          turnId,
          type: RUNTIME_EVENTS.TURN_PHASE_CHANGED,
          data: {
            from: row.phase || 'running',
            to: 'cancelled',
            step: Number(row.step || 0),
            reason: 'user_cancelled',
          },
          audit: false,
          at: now,
        });
        const cancelEv = this.eventRouter.insertPersistedInTx({
          sessionId: row.sessionId,
          turnId,
          type: RUNTIME_EVENTS.TURN_CANCELLED,
          data: {
            turnId,
            sessionId: row.sessionId,
            ...this.metrics?.getTurnProviderUsage?.(turnId),
          },
          audit: false,
          at: now,
        });
        return { phaseEv, cancelEv };
      });
      if (outbox) {
        this.eventRouter.fanoutPersisted(outbox.phaseEv);
        this.eventRouter.fanoutPersisted(outbox.cancelEv);
      }
    }
    return this.store.db.prepare('SELECT * FROM direct_turns WHERE id=?').get(turnId);
  }

  async #runTurnLoop({
    sessionId,
    turnId,
    input,
    model,
    mode,
    permissionMode,
    effort,
    workspaceRoot,
    maxSteps,
    finalVerificationReserve = null,
    evidenceContract = null,
    aciProfile = undefined,
    aciOptions = undefined,
    turnAciLedger = null,
    turnReadFiles = null,
    turnAciStore = null,
    initialStep = 0,
    isRecovery = false,
    canRetry = false,
    leaseGuard = null,
    signal,
    trafficSource = 'production',
    isSynthetic = false,
    distillSyntheticTurns = false,
  }) {
    const started = Date.now();
    const nonce = this.sessionRepo.ensureSessionNonce(sessionId);
    const turnModifiedFiles = new Set();
    let sessionObj = null;
    const sbxCfg = this.#resolveSessionSandboxConfig(sessionId);
    if (sbxCfg?.sandbox) {
      sbxCfg.sandbox.resolveBackend();
    }
    // A Git review is observational: even pre-trusted hooks and external MCP
    // connectors must not start processes or modify the workspace on its behalf.
    const disableWorkspaceHooks = mode === 'review' || Boolean(sbxCfg?.disableWorkspaceHooks);
    const disableWorkspaceMcp = mode === 'review' || Boolean(sbxCfg?.disableWorkspaceMcp);
    const hooks = disableWorkspaceHooks
      ? {
          run: async () => ({
            blocked: false,
            reason: null,
            updatedInput: null,
            transformApplied: false,
            additionalContexts: [],
            warnings: [],
          }),
          hasHooks: () => false,
        }
      : new HookRunner(workspaceRoot, {
          dataRoot: this.dataRoot,
          store: this.store,
          trustManager: this.hookTrust,
        });
    let totalIn = 0;
    let totalOut = 0;
    let totalCacheRead = null;
    let totalCacheWrite = null;
    let totalCacheEligible = null;
    let steps = initialStep;
    let assistantStepCount = initialStep;
    let effectiveModel = model || null;
    let contextWindow = 128_000;
    let actualProvider = 'pool';
    let actualAccountId = null;

    let readFileState = this.readFileStates.get(sessionId);
    if (!readFileState) {
      readFileState = new Map();
      this.readFileStates.set(sessionId, readFileState);
    }

    const aciStore = turnAciStore ?? new ReversibleContextStore(this.store);
    const aciLedger = new ContextEvidenceLedger();
    if (turnAciLedger) {
      aciLedger.mergeFrom(turnAciLedger);
    }
    let leaseRenewalTimer = null;
    let turnFencedOrTerminal = false;

    if (!isRecovery) {
      this.#emitPersisted(sessionId, turnId, 'turn/started', {
        turnId,
        sessionId,
        model,
        mode,
        effort,
        workspaceRoot,
      });
    }

    try {
      if (leaseGuard) {
        const renewalIntervalMs = Math.max(50, Number(this.leaseRenewalIntervalMs || 5000));
        const renewalExtendMs = Math.max(500, Number(this.leaseMs || 15000));
        const leaseOwner = leaseGuard.workerId ?? this.recoveryWorker?.workerId ?? null;
        leaseRenewalTimer = setInterval(() => {
          try {
            renewTurnLease(leaseGuard, {
              sessionId,
              turnId,
              owner: leaseOwner,
              extendMs: renewalExtendMs,
              store: this.store,
            });
          } catch {
            // Keep background heartbeat non-throwing; active lease guards enforce fencing synchronously.
          }
        }, renewalIntervalMs);
        leaseRenewalTimer.unref?.();
      }

      effectiveModel = model || this.pool.getDefaultModel() || null;
      if (!effectiveModel) {
        throw new Fault('NO_MODEL_CONFIGURED', 400, {
          message:
            '尚未配置任何可用模型。请前往「设置 → 账号号池」添加供应商账号并点击「获取模型」，即可无需重启立刻开始对话。',
        });
      }

      // Repair any trailing orphaned assistant(tool_calls) message left by a prior crash on onToolResult
      this.#repairOrphanedToolCalls(sessionId, { turnId, leaseGuard });

      const livePolicyInitial = this.#getLiveSessionPolicy(sessionId);
      const effectivePermissionMode = livePolicyInitial?.permissionMode || permissionMode;

      const [gitBranch, mcpTools, startHook] = await Promise.all([
        detectGitBranch(workspaceRoot),
        disableWorkspaceMcp
          ? Promise.resolve([])
          : this.mcpManager.discoverTools(workspaceRoot).catch(() => []),
        hooks
          .run('SessionStart', { sessionId, turnId, input }, { signal, permissionMode: effectivePermissionMode })
          .catch(() => ({ blocked: false, additionalContexts: [] })),
      ]);
      const projectInstructions = discoverProjectInstructions(workspaceRoot, {
        dataRoot: this.dataRoot,
      });
      const { memoryText, skillsText } = discoverMemoryAndSkills(
        workspaceRoot,
        this.store,
        { dataRoot: this.dataRoot },
      );

      const turnSandbox = sbxCfg?.sandbox
        ? this.#scopeSandboxForWorkspace(sbxCfg.sandbox, workspaceRoot)
        : this.sandbox;

      contextWindow = this.pool.getModelContextWindow(effectiveModel) || 128_000;
      const aciResolved = this.#resolveAciTurnConfig(sessionId, aciProfile, aciOptions);
      const aciEngine = new ACIEngine({
        store: this.store,
        aciStore,
        ledger: aciLedger,
        supervisor: this.contextSupervisor,
        maxTotalTokens: Math.min(200_000, contextWindow),
        contextWindow: Math.min(200_000, contextWindow),
        watermarks: aciResolved.engineWatermarks,
        dtocPolicy: aciResolved.dtocPolicy,
        ...(aciResolved.dtocMinPromptTokens !== undefined
          ? { dtocMinPromptTokens: aciResolved.dtocMinPromptTokens }
          : {}),
        ...(aciResolved.singleStepBudget !== undefined
          ? { singleStepBudget: aciResolved.singleStepBudget }
          : {}),
        ...(aciResolved.admissionMinChars !== undefined
          ? { admissionMinChars: aciResolved.admissionMinChars }
          : {}),
        ...(aciResolved.maxSupervisorAdmissionCalls !== undefined
          ? { maxSupervisorAdmissionCalls: aciResolved.maxSupervisorAdmissionCalls }
          : {}),
        ...(aciResolved.workingSetReadMaxChars !== undefined
          ? { workingSetReadMaxChars: aciResolved.workingSetReadMaxChars }
          : {}),
        ...(aciResolved.minNetSavingsTokens !== undefined
          ? { minNetSavingsTokens: aciResolved.minNetSavingsTokens }
          : {}),
        ...(aciResolved.evictionCooldownSteps !== undefined
          ? { evictionCooldownSteps: aciResolved.evictionCooldownSteps }
          : {}),
      });
      const resolveContextRef = (rawRef, opts = {}) => {
        const clean = String(rawRef ?? '').trim().replace(/^ref:/i, '').replace(/^aci:\/\//i, '');
        if (!clean) return null;
        try {
          const restored = aciEngine.restoreVerified(clean, {
            expectedSha256: opts.expectedSha256,
            recordLedger: false,
          });
          return {
            content: restored.content,
            sha256: restored.sha256,
            verified: restored.verified,
            uri: restored.uri,
            refId: restored.refId,
            path: restored.path,
            recordRecovery: ({
              level = 'verbatim',
              mode = undefined,
              isPartial = undefined,
              fullTokens = undefined,
              tokensRestored = 0,
              tokensSaved = undefined,
              sliceSha256 = undefined,
              path = '',
            } = {}) => {
              aciLedger.recordRecovery({
                refId: restored.refId,
                uri: restored.uri,
                sha256: restored.sha256,
                sliceSha256: sliceSha256 ?? null,
                path: path || restored.path,
                level,
                mode,
                isPartial,
                fullTokens,
                verified: restored.verified,
                tokensRestored,
                tokensSaved,
                triggeredBy: 'expand_context',
                step: 0,
              });
            },
          };
        } catch (err) {
          if (err?.code === 'ARTIFACT_HASH_MISMATCH') {
            throw err;
          }
          return null;
        }
      };

      const tools = createWorkspaceTools({
        workspaceRoot,
        dataRoot: this.dataRoot,
        store: this.store,
        sessionId,
        permissionMode: effectivePermissionMode,
        nonce,
        getLivePolicy: () => this.#getLiveSessionPolicy(sessionId),
        getApprovedPrefixes: () => this.#getLiveSessionPolicy(sessionId)?.approvedPrefixes ?? [],
        readFileState,
        processManager: this.processManager,
        sandbox: turnSandbox,
        mcpTools,
        resolveContextRef,
        signal,
        onHookConfigMutated: ({ path, toolName }) =>
          this.hookTrust.onConfigMutated({ filePath: path, toolName }),
        requestApproval: ({ tool, arguments: args, callId, riskLevel, effectClass, argsDigest }) =>
          this.approvalManager.requestApproval({
            sessionId,
            turnId,
            callId,
            tool,
            args,
            riskLevel,
            effectClass,
            argsDigest,
            signal,
          }),
        approvalManager: this.approvalManager,
        onBeforeMutate: (rel, full) =>
          this.sessionRepo.capturePreMutationSnapshot(sessionId, turnId, rel, full),
        onFileChanged: (change) => {
          if (change?.path) turnModifiedFiles.add(String(change.path));
          this.#emitPersisted(
            sessionId,
            turnId,
            'file/changed',
            buildFileChangedEventData(sessionId, turnId, change),
          );
        },
        onToolOutput: (chunk) => {
          this.#emitLiveDelta(sessionId, turnId, 'tool/output', { turnId, sessionId, ...chunk });
        },
        onPlanUpdated: (plan) => {
          const planEv = this.store.tx(() => {
            this.store.db
              .prepare('UPDATE direct_sessions SET planJson=?, updatedAt=? WHERE id=?')
              .run(JSON.stringify(plan), Date.now(), sessionId);
            return this.eventRouter.insertPersistedInTx({
              sessionId,
              turnId,
              type: RUNTIME_EVENTS.PLAN_UPDATED,
              data: { turnId, sessionId, plan },
              audit: false,
            });
          });
          this.eventRouter.fanoutPersisted(planEv);
        },
        sendAgentMessage: ({ toAgentId, kind = 'note', message, operationId = null }) => {
          if (this.intelligence?.communication) {
            return this.intelligence.communication.send({
              conversationId: sessionId,
              runId: turnId,
              fromAgentId: turnId,
              toAgentId,
              kind,
              idempotencyKey: `${turnId}:${toAgentId}:${kind}:${operationId ?? message?.id ?? message?.sequence ?? '0'}`,
              payload: message,
            });
          }
          return this.mailbox.send({ sessionId, fromAgentId: turnId, toAgentId, kind, payload: message });
        },
      });

      const currentSession = this.getSession(sessionId);
      sessionObj = currentSession;
      const sessionProjectId = currentSession.projectId ?? this.sessionProjects.get(sessionId) ?? workspaceRoot;
      const assembled = this.contextAssembler.assemble({
        session: currentSession,
        turnId,
        nonce,
        profile: this.kernel.getProfile('default'),
        workspaceRoot,
        gitBranch,
        mode,
        permissionMode: currentSession.permissionMode || effectivePermissionMode,
        projectInstructions,
        memoryQuery: input,
        projectId: sessionProjectId,
        memoryTokenBudget: 1000,
        legacyMemoryText: memoryText,
        skillsText,
        planState: currentSession.plan,
        hookContexts: startHook.additionalContexts ?? [],
      });
      const experienceMemoryTelemetry = assembled.experienceMemoryTelemetry ?? null;

      // Attach shared task-tree budget ledger when a ledger exists for this session tree or session has a budget
      const rootSessionId = currentSession.rootSessionId || sessionId;
      let directBudgetLedger = null;
      let directBudgetContext = null;
      const sessionBudget = currentSession.budget ?? null;
      const hasSessionBudget =
        sessionBudget &&
        (sessionBudget.maxTotalSteps !== undefined ||
          sessionBudget.maxSteps !== undefined ||
          sessionBudget.maxTotalTokens !== undefined ||
          sessionBudget.maxTokens !== undefined ||
          sessionBudget.maxOutputTokens !== undefined);
      if (this.childManager?.budgetLedger) {
        const existingLedger = this.childManager.budgetLedger.getSnapshot(rootSessionId);
        if (existingLedger) {
          directBudgetLedger = this.childManager.budgetLedger;
          directBudgetContext = {
            treeId: rootSessionId,
            scope: BUDGET_SCOPES.NODE_EXECUTION,
            attempt: 1,
          };
        } else if (hasSessionBudget) {
          this.childManager.budgetLedger.ensureLedger({
            treeId: rootSessionId,
            rootSessionId,
            budget: sessionBudget,
          });
          directBudgetLedger = this.childManager.budgetLedger;
          directBudgetContext = {
            treeId: rootSessionId,
            scope: BUDGET_SCOPES.NODE_EXECUTION,
            attempt: 1,
          };
        }
      }

      const livePolicy = this.#getLiveSessionPolicy(sessionId);
      const effectiveTurnDenyTools = sbxCfg?.forcedToolDeny?.length
        ? [...new Set([...(livePolicy?.denyTools ?? []), ...sbxCfg.forcedToolDeny])]
        : livePolicy?.denyTools;
      const effectiveTools = sbxCfg?.forcedToolDeny?.length
        ? filterToolsByPolicy(tools, { denyTools: effectiveTurnDenyTools })
        : tools;
      contextWindow = this.pool.getModelContextWindow(effectiveModel) || 128_000;
      const clampedWindow = Math.min(200_000, contextWindow);
      aciEngine.contextWindow = clampedWindow;
      const explicitBudgetTokens = sessionBudget?.maxTokens ?? sessionBudget?.maxTotalTokens ?? null;
      if (explicitBudgetTokens !== null && Number.isFinite(Number(explicitBudgetTokens)) && Number(explicitBudgetTokens) > 0) {
        aciEngine.maxTotalTokens = Math.max(1024, Number(explicitBudgetTokens));
      } else {
        aciEngine.maxTotalTokens =
          aciResolved.dtocPolicy === CACHE_AWARE_V31_DTOC_POLICY_NAME ? null : clampedWindow;
      }
      const defaultMaxOutputTokens = Math.min(
        16384,
        Math.max(4096, Number(this.pool.getModelMaxOutput?.(effectiveModel) || 16384)),
      );
      const loopResult = await this.kernel.executeTurn({
        sessionId,
        turnId,
        profile: 'default',
        input,
        model: effectiveModel,
        provider: 'pool',
        effort,
        workspaceRoot,
        execution: evidenceContract ? { evidenceContract } : null,
        aci: {
          engine: aciEngine,
          aciStore,
          ledger: aciLedger,
          supervisor: this.contextSupervisor,
          mainModel: effectiveModel,
          criticalFiles: evidenceContract?.requiredChangedFiles ?? [],
          priorReadFiles: turnReadFiles ? [...turnReadFiles] : [],
          aciProfile: aciResolved.aciProfile,
          admissionEnabled: aciResolved.admissionEnabled,
          dtocEnabled: aciResolved.dtocEnabled,
          supervisorEnabled: aciResolved.supervisorEnabled,
          supervisorConfigOverride: {
            ...aciResolved.supervisorConfigOverride,
            mainModel: effectiveModel,
          },
        },
        messages: assembled.messages,
        tools: effectiveTools,
        // Presentation only: the dispatcher still authorizes the actual arguments at execution.
        getModelTools: () => modelToolCatalog(effectiveTools, this.toolPolicy,
          this.#getLiveSessionPolicy(sessionId) ?? { permissionMode: 'read-only', allowTools: [] }),
        selectionRecoveryHint,
        hooks,
        permissionMode: livePolicy?.permissionMode || effectivePermissionMode,
        allowTools: livePolicy?.allowTools,
        denyTools: effectiveTurnDenyTools,
        getLivePolicy: () => this.#getLiveSessionPolicy(sessionId),
        getApprovedPrefixes: () => this.#getLiveSessionPolicy(sessionId)?.approvedPrefixes ?? [],
        requestApproval: ({ tool, arguments: args, callId, riskLevel, effectClass, argsDigest }) =>
          this.approvalManager.requestApproval({
            sessionId,
            turnId,
            callId,
            tool,
            args,
            riskLevel,
            effectClass,
            argsDigest,
            signal,
          }),
        initialStep,
        leaseGuard,
        deferTerminalPhase: true,
        budget: {
          maxSteps,
          ...(finalVerificationReserve != null ? { finalVerificationReserve } : {}),
          ...(sessionBudget?.maxTokens !== undefined ? { maxTokens: sessionBudget.maxTokens } : {}),
          ...(sessionBudget?.maxTotalTokens !== undefined && sessionBudget?.maxTokens === undefined
            ? { maxTokens: sessionBudget.maxTotalTokens }
            : {}),
          maxOutputTokens: sessionBudget?.maxOutputTokens ?? defaultMaxOutputTokens,
        },
        budgetLedger: directBudgetLedger,
        budgetContext: directBudgetContext,
        signal,
        contextManager: {
          prepareRequest: (opts, meta) =>
            this.compactor.prepareRequest(opts, {
              contextWindow: Math.min(200000, contextWindow),
              sessionId,
              turnId,
              reasoningState: meta?.reasoningState ?? null,
              summarize: (oldMsgs) =>
                this.#summarizeHistoryWithLlm(oldMsgs, effectiveModel, signal),
            }),
        },
        drainSteering: () => {
          const queued = this.steeringQueues.get(sessionId);
          return queued?.length ? queued.splice(0) : [];
        },
        onAssistantMessage: ({ text, reasoning, toolCalls }) => {
          assistantStepCount += 1;
          this.store.tx(() => {
            assertLeaseInTx(leaseGuard, { sessionId, turnId });
            this.store.db
              .prepare(
                `INSERT INTO direct_messages(
                  sessionId, turnId, role, content, reasoning, toolCalls, createdAt
                ) VALUES(?,?,'assistant',?,?,?,?)`,
              )
              .run(
                sessionId,
                turnId,
                text,
                reasoning || null,
                toolCalls.length ? JSON.stringify(toolCalls) : null,
                Date.now(),
              );
          });
        },
        onToolResult: ({ tc, output, promptOutput, isError, durationMs }) => {
          if (!isError && (tc?.name === 'read_file' || tc?.name === 'read_blob')) {
            try {
              const parsed =
                typeof tc.arguments === 'string'
                  ? JSON.parse(tc.arguments || '{}')
                  : tc.arguments && typeof tc.arguments === 'object'
                    ? tc.arguments
                    : {};
              const readPath = String(parsed.path ?? parsed.filePath ?? parsed.file_path ?? '').trim();
              if (readPath && turnReadFiles instanceof Set) {
                turnReadFiles.add(readPath);
              }
            } catch {
              // ignore malformed tool arguments
            }
          }
          this.store.tx(() => {
            assertLeaseInTx(leaseGuard, { sessionId, turnId });
            this.store.db
              .prepare(
                `INSERT INTO direct_messages(
                  sessionId, turnId, role, content, toolCallId, toolName, meta, createdAt
                ) VALUES(?,?,'tool',?,?,?,?,?)`,
              )
              .run(
                sessionId,
                turnId,
                excerpt(String(promptOutput ?? output ?? ''), 32000),
                tc.id,
                tc.name,
                JSON.stringify({ isError, durationMs }),
                Date.now(),
              );
          });
        },
      });

      totalIn = loopResult.usage.inputTokens;
      totalOut = loopResult.usage.outputTokens;
      totalCacheRead = loopResult.usage.cacheReadTokens;
      totalCacheWrite = loopResult.usage.cacheWriteTokens;
      totalCacheEligible = loopResult.usage.cacheEligibleInputTokens ?? null;
      steps = loopResult.steps;
      actualProvider = loopResult.route?.provider || 'pool';
      actualAccountId = loopResult.route?.accountId ?? null;
      const finalAssistantText = loopResult.text || '';
      const finalVerdict = loopResult.verdict ?? null;
      const reasoningMetrics = loopResult.reasoningMetrics ?? null;
      const budgetWatermarks = loopResult.budgetWatermarks ?? reasoningMetrics?.budgetWatermarks ?? null;
      const aciTelemetry =
        loopResult.aciTelemetry ?? reasoningMetrics?.aciMetrics?.aciTelemetry ?? null;
      if (turnAciLedger) {
        turnAciLedger.mergeFrom(aciLedger);
      }
      if (turnReadFiles instanceof Set && Array.isArray(reasoningMetrics?.filesRead)) {
        for (const p of reasoningMetrics.filesRead) {
          const clean = String(p ?? '').trim();
          if (clean) turnReadFiles.add(clean);
        }
      }
      const evidenceCount =
        finalVerdict?.evidenceCount ??
        this.store.db
          .prepare('SELECT COUNT(*) AS n FROM tool_receipts WHERE sessionId=? AND turnId=?')
          .get(sessionId, turnId)?.n ??
        0;

      const durationMs = Date.now() - started;
      const finishedAt = Date.now();
      const totalTokens = totalIn + totalOut;

      if (this.closed || !this.store.db?.isOpen) return;

      const receiptStats = this.store.db
        .prepare(
          "SELECT COUNT(*) AS total, SUM(CASE WHEN status='finished' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM tool_receipts WHERE sessionId=? AND turnId=?",
        )
        .get(sessionId, turnId);

      // 1. block_reconciliation -> park in recoverable reconciling state (NEVER completed)
      if (loopResult.status === 'reconciling') {
        const recEnsure = this.reconciler.ensurePendingReconciliationForSession(sessionId, {
          turnId,
        });
        const parkedEv = this.store.tx(() => {
          assertLeaseInTx(leaseGuard, { sessionId, turnId });
          const res = this.store.db
            .prepare(
              `UPDATE direct_turns
               SET state='reconciling', phase='reconciling', inputTokens=?, outputTokens=?, durationMs=?,
                   verdictJson=?, evidenceCount=?, activeFence=NULL
               WHERE id=? AND state IN ('running','reconciling','parked')`,
            )
            .run(
              totalIn,
              totalOut,
              durationMs,
              finalVerdict ? JSON.stringify(finalVerdict) : null,
              Number(evidenceCount || 0),
              turnId,
            );
          if ((res.changes ?? 0) === 0) return null;
          this.store.db
            .prepare(
              "UPDATE direct_sessions SET state='reconciling', updatedAt=? WHERE id=? AND state NOT IN ('cancelled','completed')",
            )
            .run(finishedAt, sessionId);
          return this.eventRouter.insertPersistedInTx({
            sessionId,
            turnId,
            type: RUNTIME_EVENTS.TURN_PARKED,
            data: {
              turnId,
              sessionId,
              reason: 'block_reconciliation',
              approvalId: recEnsure.approvalId ?? null,
              verdict: finalVerdict,
            },
            audit: false,
            at: finishedAt,
          });
        });
        if (parkedEv) {
          this.eventRouter.fanoutPersisted(parkedEv);
        }
        throw new RecoveryError('RECONCILIATION_REQUIRED', {
          message:
            loopResult.errorMessage ||
            '存在状态未知的外部副作用 (outcome_unknown)，需人工核对后方可完成',
          detail: {
            turnId,
            sessionId,
            approvalId: recEnsure.approvalId ?? null,
            verdict: finalVerdict,
            alreadyParked: true,
          },
        });
      }

      // 2. Verification failed / step limit exhausted / thrashing break -> atomic terminal failed commit + outbox
      if (loopResult.status === 'failed') {
        const errorMessage = String(
          loopResult.errorMessage || loopResult.errorCode || 'VERIFICATION_FAILED',
        );
        const errorCode = String(loopResult.errorCode || 'VERIFICATION_FAILED');
        const outbox = this.store.tx(() => {
          assertLeaseInTx(leaseGuard, { sessionId, turnId });
          const res = this.store.db
            .prepare(
              `UPDATE direct_turns
               SET state='failed', phase='failed', error=?, inputTokens=?, outputTokens=?, durationMs=?,
                   verdictJson=?, evidenceCount=?, finishedAt=?, activeFence=NULL
               WHERE id=? AND state NOT IN ('completed','failed','cancelled')`,
            )
            .run(
              errorMessage.slice(0, 1000),
              totalIn,
              totalOut,
              durationMs,
              finalVerdict ? JSON.stringify(finalVerdict) : null,
              Number(evidenceCount || 0),
              finishedAt,
              turnId,
            );
          if ((res.changes ?? 0) === 0) return null;
          this.store.db
            .prepare(
              "UPDATE direct_sessions SET state='failed', updatedAt=? WHERE id=? AND state NOT IN ('cancelled','completed')",
            )
            .run(finishedAt, sessionId);
          if (totalTokens > 0) {
            this.store.db
              .prepare(
                `INSERT INTO nexus_usage(
                  sessionId, provider, model, accountId, day, inputTokens, outputTokens, tokens,
                  costUsd, durationMs, trafficSource, isSynthetic, createdAt
                ) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?)`,
              )
              .run(
                sessionId,
                actualProvider,
                effectiveModel,
                actualAccountId,
                todayDateStr(),
                totalIn,
                totalOut,
                totalTokens,
                durationMs,
                trafficSource,
                isSynthetic ? 1 : 0,
                finishedAt,
              );
          }
          convergeScheduledRunForTurn(this.store, turnId, {
            status: 'failed',
            error: errorMessage.slice(0, 1000),
            finishedAt,
          });
          const phaseEv = loopResult.deferredPhaseTransition
            ? this.eventRouter.insertPersistedInTx({
                sessionId,
                turnId,
                type: RUNTIME_EVENTS.TURN_PHASE_CHANGED,
                data: {
                  from: loopResult.deferredPhaseTransition.from,
                  to: 'failed',
                  step: steps,
                  reason: errorCode,
                },
                audit: false,
                at: finishedAt,
              })
            : null;
          const failedEv = this.eventRouter.insertPersistedInTx({
            sessionId,
            turnId,
            type: RUNTIME_EVENTS.TURN_FAILED,
            data: {
              turnId,
              sessionId,
              model: effectiveModel,
              provider: actualProvider,
              ...(actualAccountId ? { accountId: actualAccountId } : {}),
              steps,
              inputTokens: totalIn,
              outputTokens: totalOut,
              cacheReadTokens: totalCacheRead,
              cacheWriteTokens: totalCacheWrite,
              cacheEligibleInputTokens: totalCacheEligible,
              error: errorMessage,
              code: errorCode,
              verdict: finalVerdict,
              evidenceCount: Number(evidenceCount || 0),
              durationMs,
              ...(reasoningMetrics ? { reasoningMetrics } : {}),
              ...(budgetWatermarks ? { budgetWatermarks } : {}),
              ...(aciTelemetry ? { aciTelemetry } : {}),
              ...(experienceMemoryTelemetry ? { experienceMemory: experienceMemoryTelemetry } : {}),
            },
            audit: false,
            at: finishedAt,
          });
          return { phaseEv, failedEv };
        });

        if (outbox) {
          if (outbox.phaseEv) this.eventRouter.fanoutPersisted(outbox.phaseEv);
          this.eventRouter.fanoutPersisted(outbox.failedEv);
          safeIsolateSideEffect(() =>
            this.store.event('direct.turn.failed', null, null, {
              sessionId,
              turnId,
              model: effectiveModel,
              provider: actualProvider,
              steps,
              code: errorCode,
              durationMs,
              ...(reasoningMetrics ? { reasoningMetrics } : {}),
              ...(budgetWatermarks ? { budgetWatermarks } : {}),
              ...(aciTelemetry ? { aciTelemetry } : {}),
            }),
          );
          safeIsolateSideEffect(() =>
            this.#recordModelFeedbackSafely({
              model: effectiveModel,
              provider: actualProvider,
              taskType: mode || 'direct',
              success: false,
              toolTotal: Number(receiptStats?.total ?? 0),
              toolSuccess: Number(receiptStats?.ok ?? 0),
              verifiedPass: loopResult.verifiedPass ?? false,
              failureKind: loopResult.failureKind || 'verification_failure',
              latencyMs: durationMs,
              inputTokens: totalIn,
              outputTokens: totalOut,
              contextWindow,
              recovered: Boolean(isRecovery),
              trafficSource,
              isSynthetic,
            }),
          );
          safeIsolateSideEffect(() =>
            this.#finalizeTurnExperienceAndTelemetry({
              session: currentSession,
              sessionId,
              turnId,
              workspaceRoot,
              input,
              summary: finalAssistantText,
              verdict: finalVerdict,
              evidenceCount,
              reasoningMetrics,
              verifierEvents: loopResult.verifierEvents,
              modifiedFiles: turnModifiedFiles,
              error: errorMessage,
              errorCode,
              status: 'failed',
              effectiveModel,
              actualProvider,
              actualAccountId,
              durationMs,
              trafficSource,
              isSynthetic,
              distillSyntheticTurns,
            }),
          );

        if (isRecovery) {
            safeIsolateSideEffect(() =>
              this.metrics?.record('recovery_attempt', {
                sessionId,
                turnId,
                model: effectiveModel,
                provider: actualProvider,
                accountId: actualAccountId,
                ok: false,
                durationMs,
                code: errorCode,
                trafficSource,
                isSynthetic,
              }),
            );
          }
        }
        await safeIsolateSideEffect(() =>
          hooks.run(
            'Stop',
            { sessionId, turnId, steps, status: 'failed', text: excerpt(finalAssistantText, 1000) },
            { signal, permissionMode: this.#getLiveSessionPolicy(sessionId)?.permissionMode || effectivePermissionMode },
          ),
        );
        return;
      }

      // 3. Verified completion (or explicit plain-text no-tool completion)
      // Atomic terminal commit: direct_turns + direct_sessions + nexus_usage + scheduled_task_runs + outbox events in ONE tx!
      const outbox = this.store.tx(() => {
        assertLeaseInTx(leaseGuard, { sessionId, turnId });
        const res = this.store.db
          .prepare(
            `UPDATE direct_turns
             SET state='completed', phase='completed', inputTokens=?, outputTokens=?, durationMs=?,
                 verdictJson=?, evidenceCount=?, finishedAt=?, activeFence=NULL
             WHERE id=? AND state IN ('running','reconciling','parked')`,
          )
          .run(
            totalIn,
            totalOut,
            durationMs,
            finalVerdict ? JSON.stringify(finalVerdict) : null,
            Number(evidenceCount || 0),
            finishedAt,
            turnId,
          );
        if ((res.changes ?? 0) === 0) return null;
        this.store.db
          .prepare(
            "UPDATE direct_sessions SET state='completed', updatedAt=? WHERE id=? AND state NOT IN ('cancelled','completed')",
          )
          .run(finishedAt, sessionId);
        this.store.db
          .prepare(
            `INSERT INTO nexus_usage(
              sessionId, provider, model, accountId, day, inputTokens, outputTokens, tokens,
              costUsd, durationMs, trafficSource, isSynthetic, createdAt
            ) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?)`,
          )
          .run(
            sessionId,
            actualProvider,
            effectiveModel,
            actualAccountId,
            todayDateStr(),
            totalIn,
            totalOut,
            totalTokens,
            durationMs,
            trafficSource,
            isSynthetic ? 1 : 0,
            finishedAt,
          );
        convergeScheduledRunForTurn(this.store, turnId, {
          status: 'completed',
          finishedAt,
        });
        const phaseEv = loopResult.deferredPhaseTransition
          ? this.eventRouter.insertPersistedInTx({
              sessionId,
              turnId,
              type: RUNTIME_EVENTS.TURN_PHASE_CHANGED,
              data: {
                from: loopResult.deferredPhaseTransition.from,
                to: 'completed',
                step: steps,
                reason: loopResult.stopReason || 'completed',
              },
              audit: false,
              at: finishedAt,
            })
          : null;
        const completedEv = this.eventRouter.insertPersistedInTx({
          sessionId,
          turnId,
          type: RUNTIME_EVENTS.TURN_COMPLETED,
          data: {
            turnId,
            sessionId,
            model: effectiveModel,
            provider: actualProvider,
            ...(actualAccountId ? { accountId: actualAccountId } : {}),
            steps,
            inputTokens: totalIn,
            outputTokens: totalOut,
            cacheReadTokens: totalCacheRead,
            cacheWriteTokens: totalCacheWrite,
            cacheEligibleInputTokens: totalCacheEligible,
            durationMs,
            verdict: finalVerdict,
            evidenceCount: Number(evidenceCount || 0),
            text: excerpt(finalAssistantText, 4000),
            ...(reasoningMetrics ? { reasoningMetrics } : {}),
            ...(budgetWatermarks ? { budgetWatermarks } : {}),
            ...(aciTelemetry ? { aciTelemetry } : {}),
            ...(experienceMemoryTelemetry ? { experienceMemory: experienceMemoryTelemetry } : {}),
          },
          audit: false,
          at: finishedAt,
        });
        return { phaseEv, completedEv };
      });

      if (outbox) {
        if (outbox.phaseEv) this.eventRouter.fanoutPersisted(outbox.phaseEv);
        this.eventRouter.fanoutPersisted(outbox.completedEv);

        safeIsolateSideEffect(() =>
          this.store.event('direct.turn.completed', null, null, {
            sessionId,
            turnId,
            model: effectiveModel,
            provider: actualProvider,
            steps,
            inputTokens: totalIn,
            outputTokens: totalOut,
            cacheReadTokens: totalCacheRead,
            cacheWriteTokens: totalCacheWrite,
            cacheEligibleInputTokens: totalCacheEligible,
            durationMs,
            evidenceCount: Number(evidenceCount || 0),
            ...(reasoningMetrics ? { reasoningMetrics } : {}),
            ...(budgetWatermarks ? { budgetWatermarks } : {}),
            ...(aciTelemetry ? { aciTelemetry } : {}),
            ...(experienceMemoryTelemetry ? { experienceMemory: experienceMemoryTelemetry } : {}),
          }),
        );

        safeIsolateSideEffect(() =>
          this.#recordModelFeedbackSafely({
            model: effectiveModel,
            provider: actualProvider,
            taskType: mode || 'direct',
            success: true,
            toolTotal: Number(receiptStats?.total ?? 0),
            toolSuccess: Number(receiptStats?.ok ?? 0),
            verifiedPass: loopResult.verifiedPass ?? null,
            latencyMs: durationMs,
            inputTokens: totalIn,
            outputTokens: totalOut,
            contextWindow,
            recovered: Boolean(isRecovery),
            trafficSource,
            isSynthetic,
          }),
        );

        safeIsolateSideEffect(() =>
          this.#finalizeTurnExperienceAndTelemetry({
            session: currentSession,
            sessionId,
            turnId,
            workspaceRoot,
            input,
            summary: finalAssistantText,
            verdict: finalVerdict,
            evidenceCount,
            reasoningMetrics,
            verifierEvents: loopResult.verifierEvents,
            modifiedFiles: turnModifiedFiles,
            status: 'completed',
            effectiveModel,
            actualProvider,
            actualAccountId,
            durationMs,
            trafficSource,
            isSynthetic,
            distillSyntheticTurns,
          }),
        );

        if (isRecovery) {
          safeIsolateSideEffect(() =>
            this.metrics?.record('recovery_attempt', {
              sessionId,
              turnId,
              model: effectiveModel,
              provider: actualProvider,
              accountId: actualAccountId,
              ok: true,
              durationMs,
              trafficSource,
              isSynthetic,
            }),
          );
        }
      }

      await safeIsolateSideEffect(() =>
        hooks.run(
          'Stop',
          { sessionId, turnId, steps, status: 'completed', text: excerpt(finalAssistantText, 1000) },
          { signal, permissionMode: this.#getLiveSessionPolicy(sessionId)?.permissionMode || effectivePermissionMode },
        ),
      );
    } catch (err) {
      if (this.closed || !this.store.db?.isOpen) return;
      const classified = classifyError(err);

      // Recover partial token usage & route metadata attached by AgentLoop/InferenceEngine,
      // checkpointStore, and MetricsCollector provider_usage events.
      const errUsage = classified.usage || err?.usage || err?.partialUsage || null;
      if (errUsage) {
        totalIn = Math.max(totalIn, Number(errUsage.inputTokens ?? 0));
        totalOut = Math.max(totalOut, Number(errUsage.outputTokens ?? 0));
        if (errUsage.cacheReadTokens != null) totalCacheRead = Math.max(totalCacheRead ?? 0, errUsage.cacheReadTokens);
        if (errUsage.cacheWriteTokens != null) totalCacheWrite = Math.max(totalCacheWrite ?? 0, errUsage.cacheWriteTokens);
        totalCacheEligible = errUsage.cacheEligibleInputTokens ?? totalCacheEligible;
      }
      const cpSnapshot = this.checkpointStore?.loadLatest?.(turnId) ?? null;
      if (cpSnapshot?.state) {
        totalIn = Math.max(totalIn, Number(cpSnapshot.state.totalIn ?? 0) || 0);
        totalOut = Math.max(totalOut, Number(cpSnapshot.state.totalOut ?? 0) || 0);
        if (cpSnapshot.state.totalCacheRead != null) {
          totalCacheRead = Math.max(totalCacheRead ?? 0, Number(cpSnapshot.state.totalCacheRead) || 0);
        }
        if (cpSnapshot.state.totalCacheWrite != null) {
          totalCacheWrite = Math.max(totalCacheWrite ?? 0, Number(cpSnapshot.state.totalCacheWrite) || 0);
        }
        if (cpSnapshot.state.totalCacheEligible != null) {
          totalCacheEligible = Math.max(totalCacheEligible ?? 0, Number(cpSnapshot.state.totalCacheEligible) || 0);
        }
      }
      const metricsUsage = this.metrics?.getTurnProviderUsage?.(turnId) ?? null;
      if (metricsUsage) {
        totalIn = Math.max(totalIn, Number(metricsUsage.inputTokens ?? 0) || 0);
        totalOut = Math.max(totalOut, Number(metricsUsage.outputTokens ?? 0) || 0);
        if (metricsUsage.cacheReadTokens != null) {
          totalCacheRead = Math.max(totalCacheRead ?? 0, Number(metricsUsage.cacheReadTokens) || 0);
        }
        if (metricsUsage.cacheWriteTokens != null) {
          totalCacheWrite = Math.max(totalCacheWrite ?? 0, Number(metricsUsage.cacheWriteTokens) || 0);
        }
        if (metricsUsage.cacheEligibleInputTokens != null) {
          totalCacheEligible = Math.max(totalCacheEligible ?? 0, Number(metricsUsage.cacheEligibleInputTokens) || 0);
        }
      }
      const errRoute = classified.route || err?.route || null;
      if (errRoute?.provider) actualProvider = errRoute.provider;
      else if (metricsUsage?.provider && (!actualProvider || actualProvider === 'pool')) {
        actualProvider = metricsUsage.provider;
      }
      if (errRoute?.accountId) actualAccountId = errRoute.accountId;
      steps = Math.max(
        steps,
        Number(classified.steps ?? err?.steps ?? 0) || 0,
        Number(cpSnapshot?.step ?? 0) || 0,
        assistantStepCount,
      );

      // Graceful shutdown abort keeps turn recoverable (never marks cancelled/failed)
      if (
        classified.isShutdown ||
        signal?.reason === 'shutdown' ||
        signal?.reason?.message === 'shutdown' ||
        signal?.reason?.detail?.message === 'shutdown' ||
        classified?.detail?.message === 'shutdown' ||
        classified?.detail?.reason === 'shutdown'
      ) {
        return;
      }

      const catchReasoningMetrics = err?.reasoningMetrics ?? classified?.reasoningMetrics ?? null;
      const catchBudgetWatermarks =
        err?.budgetWatermarks ??
        classified?.budgetWatermarks ??
        catchReasoningMetrics?.budgetWatermarks ??
        null;
      const catchAciTelemetry =
        err?.aciTelemetry ??
        classified?.aciTelemetry ??
        catchReasoningMetrics?.aciMetrics?.aciTelemetry ??
        null;
      if (turnAciLedger) {
        turnAciLedger.mergeFrom(aciLedger);
      }
      if (turnReadFiles instanceof Set && Array.isArray(catchReasoningMetrics?.filesRead)) {
        for (const p of catchReasoningMetrics.filesRead) {
          const clean = String(p ?? '').trim();
          if (clean) turnReadFiles.add(clean);
        }
      }

      const preCatchTurn = this.store.db
        .prepare('SELECT state, phase, step FROM direct_turns WHERE id=?')
        .get(turnId);
      const jobCancelled =
        leaseGuard?.jobId &&
        this.store.db.prepare('SELECT status FROM runtime_jobs WHERE id=?').get(leaseGuard.jobId)?.status ===
          'cancelled';
      const isCancelledTurn =
        Boolean(signal?.aborted) &&
        signal?.reason !== 'lease_lost' &&
        preCatchTurn?.state === 'cancelled' &&
        (!leaseGuard?.jobId || jobCancelled);

      // Fix D6 / D7 / P0-1: NEVER swallow LEASE_LOST before RecoveryWorker.#runJob sees it!
      // When cancelTurn() cancelled the job/turn while the loop was unwinding, persist final
      // cancellation telemetry before exiting cleanly.
      if (isLeaseLostError(classified) && !isCancelledTurn) {
        turnFencedOrTerminal = true;
        if (signal?.aborted && catchReasoningMetrics) {
          this.#backfillCancelledReasoningMetrics(turnId, catchReasoningMetrics);
        }
        this.metrics?.record('lease_lost_fenced', {
          sessionId,
          turnId,
          model: effectiveModel,
          provider: actualProvider,
          accountId: actualAccountId,
          code: 'LEASE_LOST',
          trafficSource,
          isSynthetic,
        });
        throw classified;
      }
      if (classified.code === 'RECONCILIATION_REQUIRED' || classified.code === 'APPROVAL_PARKED') {
        throw classified;
      }
      if (!isCancelledTurn && !checkLeaseHeld(leaseGuard, { sessionId, turnId })) {
        turnFencedOrTerminal = true;
        if (signal?.aborted && catchReasoningMetrics) {
          this.#backfillCancelledReasoningMetrics(turnId, catchReasoningMetrics);
        }
        this.metrics?.record('lease_lost_fenced', {
          sessionId,
          turnId,
          model: effectiveModel,
          provider: actualProvider,
          accountId: actualAccountId,
          code: 'LEASE_LOST',
          trafficSource,
          isSynthetic,
        });
        throw new RecoveryError('LEASE_LOST', {
          message: `Lease lost during turn ${turnId}`,
          cause: err,
        });
      }

      const durationMs = Date.now() - started;
      const finishedAt = Date.now();
      const isCancelled = Boolean(signal?.aborted || classified.category === 'cancellation' || isCancelledTurn);
      const message = String(classified?.detail?.message ?? classified?.message ?? err);
      const nextState = isCancelled ? 'cancelled' : 'failed';

      const currentTurn = preCatchTurn;
      if (
        !currentTurn ||
        ['completed', 'failed'].includes(currentTurn.state) ||
        (!isCancelled && currentTurn.state === 'cancelled')
      ) {
        return;
      }

      if (!isCancelled && canRetry && classified.retryable) {
        throw classified;
      }

      const catchSteps = Math.max(
        Number(classified.steps ?? 0) || 0,
        Number(steps || 0),
        Number(currentTurn?.step ?? 0) || 0,
      );
      const totalTokens = totalIn + totalOut;
      let outbox = null;
      try {
        outbox = this.store.tx(() => {
          const txTurn = this.store.db
            .prepare('SELECT state, phase, step, finishedAt FROM direct_turns WHERE id=?')
            .get(turnId);
          if (!txTurn || ['completed', 'failed'].includes(txTurn.state)) return null;
          if (!isCancelled || txTurn.state !== 'cancelled') {
            assertLeaseInTx(leaseGuard, { sessionId, turnId });
          } else if (leaseGuard?.jobId) {
            const txJob = this.store.db
              .prepare('SELECT status, fence FROM runtime_jobs WHERE id=?')
              .get(leaseGuard.jobId);
            if (txJob && txJob.status === 'active' && txJob.fence !== leaseGuard.fence) {
              throw new RecoveryError('LEASE_LOST', {
                message: `Lease lost during cancelled turn ${turnId}`,
                detail: { jobId: leaseGuard.jobId, turnId },
              });
            }
          }

          const res = this.store.db
            .prepare(
              "UPDATE direct_turns SET state=?, phase=?, error=?, step=MAX(COALESCE(step, 0), ?), inputTokens=?, outputTokens=?, durationMs=?, finishedAt=?, activeFence=NULL WHERE id=? AND state NOT IN ('completed','failed','cancelled')",
            )
            .run(
              nextState,
              nextState,
              isCancelled ? null : message.slice(0, 1000),
              catchSteps,
              totalIn,
              totalOut,
              durationMs,
              finishedAt,
              turnId,
            );
          if ((res.changes ?? 0) === 0) {
            if (!isCancelled || txTurn.state !== 'cancelled') return null;
            this.store.db
              .prepare(
                `UPDATE direct_turns
                 SET step = MAX(COALESCE(step, 0), ?),
                     inputTokens = MAX(COALESCE(inputTokens, 0), ?),
                     outputTokens = MAX(COALESCE(outputTokens, 0), ?),
                     durationMs = COALESCE(NULLIF(durationMs, 0), ?),
                     finishedAt = COALESCE(finishedAt, ?),
                     activeFence = NULL
                 WHERE id=? AND state='cancelled'`,
              )
              .run(catchSteps, totalIn, totalOut, durationMs, finishedAt, turnId);
          } else {
            this.store.db
              .prepare(
                "UPDATE direct_sessions SET state=?, updatedAt=? WHERE id=? AND state NOT IN ('cancelled','completed')",
              )
              .run(nextState, finishedAt, sessionId);
          }
          const usageAt = txTurn.finishedAt ?? finishedAt;
          const alreadyHasUsage =
            totalTokens > 0 && effectiveModel
              ? this.store.db
                  .prepare(
                    'SELECT 1 FROM nexus_usage WHERE sessionId=? AND model=? AND inputTokens=? AND outputTokens=? AND createdAt>=? LIMIT 1',
                  )
                  .get(sessionId, effectiveModel, totalIn, totalOut, started)
              : null;
          if (totalTokens > 0 && effectiveModel && !alreadyHasUsage) {
            this.store.db
              .prepare(
                `INSERT INTO nexus_usage(
                  sessionId, provider, model, accountId, day, inputTokens, outputTokens, tokens,
                  costUsd, durationMs, trafficSource, isSynthetic, createdAt
                ) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?)`,
              )
              .run(
                sessionId,
                actualProvider,
                effectiveModel,
                actualAccountId,
                todayDateStr(),
                totalIn,
                totalOut,
                totalTokens,
                durationMs,
                trafficSource,
                isSynthetic ? 1 : 0,
                usageAt,
              );
          }
          if ((res.changes ?? 0) > 0) {
            convergeScheduledRunForTurn(this.store, turnId, {
              status: nextState,
              error: isCancelled ? null : message.slice(0, 1000),
              finishedAt,
            });
          }
          const phaseEv =
            (res.changes ?? 0) > 0
              ? this.eventRouter.insertPersistedInTx({
                  sessionId,
                  turnId,
                  type: RUNTIME_EVENTS.TURN_PHASE_CHANGED,
                  data: {
                    from: classified.deferredPhaseTransition?.from || currentTurn.phase || 'running',
                    to: nextState,
                    step: catchSteps,
                    reason: classified.code || nextState,
                  },
                  audit: false,
                  at: finishedAt,
                })
              : null;
          const termEv = this.eventRouter.insertPersistedInTx({
            sessionId,
            turnId,
            type: isCancelled ? RUNTIME_EVENTS.TURN_CANCELLED : RUNTIME_EVENTS.TURN_FAILED,
            data: isCancelled
              ? {
                  turnId,
                  sessionId,
                  model: effectiveModel,
                  provider: actualProvider,
                  steps: catchSteps,
                  inputTokens: totalIn,
                  outputTokens: totalOut,
                  cacheReadTokens: totalCacheRead,
                  cacheWriteTokens: totalCacheWrite,
                  cacheEligibleInputTokens: totalCacheEligible,
                  durationMs,
                  ...(catchReasoningMetrics ? { reasoningMetrics: catchReasoningMetrics } : {}),
                  ...(catchBudgetWatermarks ? { budgetWatermarks: catchBudgetWatermarks } : {}),
                  ...(catchAciTelemetry ? { aciTelemetry: catchAciTelemetry } : {}),
                }
              : {
                  turnId,
                  sessionId,
                  model: effectiveModel,
                  provider: actualProvider,
                  steps: catchSteps,
                  inputTokens: totalIn,
                  outputTokens: totalOut,
                  cacheReadTokens: totalCacheRead,
                  cacheWriteTokens: totalCacheWrite,
                  cacheEligibleInputTokens: totalCacheEligible,
                  error: message,
                  code: classified.code,
                  durationMs,
                  ...(catchReasoningMetrics ? { reasoningMetrics: catchReasoningMetrics } : {}),
                  ...(catchBudgetWatermarks ? { budgetWatermarks: catchBudgetWatermarks } : {}),
                  ...(catchAciTelemetry ? { aciTelemetry: catchAciTelemetry } : {}),
                },
            audit: false,
            at: finishedAt,
          });
          return { phaseEv, termEv };
        });
      } catch (txErr) {
        if (isLeaseLostError(txErr)) throw txErr;
        throw txErr;
      }

      if (outbox) {
        if (outbox.phaseEv) this.eventRouter.fanoutPersisted(outbox.phaseEv);
        this.eventRouter.fanoutPersisted(outbox.termEv);

        safeIsolateSideEffect(() => {
          if (!effectiveModel) return;
          const receiptStats = this.store.db
            .prepare(
              "SELECT COUNT(*) AS total, SUM(CASE WHEN status='finished' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM tool_receipts WHERE sessionId=? AND turnId=?",
            )
            .get(sessionId, turnId);
          const failureKind = classifyFailureKind(classified, {
            isCancelled,
            hasToolFailure: Number(receiptStats?.failed ?? 0) > 0,
          });
          this.#recordModelFeedbackSafely({
            model: effectiveModel,
            provider: actualProvider,
            taskType: mode || 'direct',
            success: false,
            toolTotal: Number(receiptStats?.total ?? 0),
            toolSuccess: Number(receiptStats?.ok ?? 0),
            verifiedPass: null,
            failureKind,
            cancelled: isCancelled,
            latencyMs: durationMs,
            timedOut: failureKind === 'timeout',
            inputTokens: totalIn,
            outputTokens: totalOut,
            contextWindow,
            recovered: Boolean(isRecovery),
            trafficSource,
            isSynthetic,
          });
        });

        if (!isCancelled) {
          safeIsolateSideEffect(() =>
            this.#finalizeTurnExperienceAndTelemetry({
              session: sessionObj,
              sessionId,
              turnId,
              workspaceRoot,
              input,
              verdict: { verdict: 'fail', accepted: false, reasons: [message] },
              reasoningMetrics: err?.reasoningMetrics ?? classified?.reasoningMetrics ?? null,
              modifiedFiles: turnModifiedFiles,
              error: message,
              errorCode: classified.code ?? null,
              status: 'failed',
              effectiveModel,
              actualProvider,
              actualAccountId,
              durationMs,
              trafficSource,
              isSynthetic,
              distillSyntheticTurns,
            }),
          );
        }

        if (isRecovery && !isCancelled) {
          safeIsolateSideEffect(() =>
            this.metrics?.record('recovery_attempt', {
              sessionId,
              turnId,
              model: effectiveModel,
              provider: actualProvider,
              accountId: actualAccountId,
              ok: false,
              durationMs,
              code: classified.code,
              trafficSource,
              isSynthetic,
            }),
          );
        }
      }
    } finally {
      if (leaseRenewalTimer) {
        clearInterval(leaseRenewalTimer);
        leaseRenewalTimer = null;
      }
      this.activeTurns.delete(turnId);
      if (this.activeSessionTurn.get(sessionId) === turnId) {
        this.activeSessionTurn.delete(sessionId);
      }
      try {
        const turnFinalRow = this.store?.db?.isOpen
          ? this.store.db.prepare('SELECT state FROM direct_turns WHERE id=?').get(turnId)
          : null;
        if (turnFencedOrTerminal || !turnFinalRow || ['completed', 'failed', 'cancelled'].includes(turnFinalRow.state)) {
          this.turnAciStates.delete(turnId);
        }
      } catch {
        // ignore cleanup read errors while DB is closing
      }
    }
  }

  #backfillCancelledReasoningMetrics(turnId, reasoningMetrics) {
    if (!reasoningMetrics || !this.store?.db?.isOpen) return;
    try {
      this.store.tx(() => {
        const turnRow = this.store.db.prepare('SELECT state FROM direct_turns WHERE id=?').get(turnId);
        if (turnRow?.state !== 'cancelled') return;
        const evRow = this.store.db
          .prepare("SELECT seq, data FROM direct_events WHERE turnId=? AND type='turn/cancelled' ORDER BY seq DESC LIMIT 1")
          .get(turnId);
        if (!evRow) return;
        const evData = JSON.parse(evRow.data || '{}');
        if (!evData.reasoningMetrics) {
          evData.reasoningMetrics = reasoningMetrics;
          if (!evData.budgetWatermarks && reasoningMetrics.budgetWatermarks) {
            evData.budgetWatermarks = reasoningMetrics.budgetWatermarks;
          }
          if (!evData.aciTelemetry && reasoningMetrics.aciMetrics?.aciTelemetry) {
            evData.aciTelemetry = reasoningMetrics.aciMetrics.aciTelemetry;
          }
          this.store.db
            .prepare('UPDATE direct_events SET data=? WHERE seq=?')
            .run(JSON.stringify(evData), evRow.seq);
        }
      });
    } catch {
      // Best-effort enrichment when DB is closing after cancellation.
    }
  }
}
