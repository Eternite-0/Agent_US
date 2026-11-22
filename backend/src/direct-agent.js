import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
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
  discoverProjectInstructions,
  HookRunner,
} from './agent-context.js';
import {
  BackgroundProcessManager,
  createWorkspaceTools,
} from './workspace-tools.js';
import { McpHub } from './mcp-client.js';
import { ToolDispatcher } from './tools/dispatcher.js';
import { ToolPermissionPolicy, intersectPolicies } from './tools/policy.js';
import { validatePlan } from './planning/validator.js';
import { HookTrustManager } from './tools/hook-trust.js';
import { GitWorktreeIsolator, HostSandboxAdapter } from './tools/sandbox.js';
import { McpLifecycleManager } from './tools/mcp-lifecycle.js';
import { DirectSessionRepo } from './runtime/session-repo.js';
import { DirectApprovalManager } from './runtime/approval-manager.js';
import { ShutdownCoordinator } from './runtime/shutdown.js';
import { ModelFeedbackTracker } from './swarm/feedback.js';
import { TokenBudgetManager } from './context/budget.js';
import { ProjectMemoryService } from './context/memory.js';
import { MultiStageCompactor } from './context/compaction.js';
import { ContextAssembler } from './context/assembler.js';
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

const execFileAsync = promisify(execFile);

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function detectGitBranch(cwd) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, windowsHide: true, timeout: 2500 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
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
      enableHeartbeat = true,
      artifactStoreDir = null,
      metrics = null,
    } = {},
  ) {
    this.store = store;
    this.pool = pool;
    this.adapter = adapter ?? pool.adapter;
    this.judgment = judgment;
    this.metrics = metrics ?? pool?.metrics ?? null;
    this.intelligence = null;
    this.defaultWorkspace = resolve(defaultWorkspace);
    this.dataRoot = dataRoot ? resolve(dataRoot) : null;
    this.closed = false;

    this.jobQueue = new DurableJobQueue(this.store, { defaultLeaseMs: leaseMs });
    this.checkpointStore = new CheckpointStore(this.store);
    this.kernel = new AgentRuntimeKernel({
      store: this.store,
      adapter: this.adapter,
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
      }),
    );

    this.activeTurns = new Map(); // turnId -> { controller, sessionId }
    this.activeSessionTurn = new Map(); // sessionId -> turnId
    this.steeringQueues = new Map(); // sessionId -> string[]
    this.readFileStates = new Map(); // sessionId -> Map(relPath -> { sha256, at })

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
      getLivePolicy: (sessionId) => this.#getLiveSessionPolicy(sessionId),
      requestApproval: (request) => this.approvalManager.requestApproval(request),
      getDefaultModel: () => this.pool.getDefaultModel(),
      getWorkspaceTools: ({ workspaceRoot, sessionId, permissionMode, nonce, getLivePolicy, getApprovedPrefixes, requestApproval, approvalManager, signal }) =>
        createWorkspaceTools({
          workspaceRoot,
          dataRoot: this.dataRoot,
          store: this.store,
          sessionId,
          permissionMode,
          nonce,
          processManager: this.processManager,
          sandbox: this.sandbox,
          getLivePolicy,
          getApprovedPrefixes,
          requestApproval,
          approvalManager,
          onHookConfigMutated: ({ path, toolName }) =>
            this.hookTrust.onConfigMutated({ filePath: path, toolName }),
          signal,
        }),
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
      if (['completed', 'failed', 'cancelled'].includes(row.state)) return row;
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
  createSession(opts) {
    return this.sessionRepo.createSession(opts);
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

  // ---- Mid-Turn Steering Queue ----

  steerSession(sessionId, text) {
    this.getSession(sessionId);
    const clean = String(text ?? '').trim();
    if (!clean) throw new Fault('EMPTY_INPUT', 400);
    const activeTurnId = this.activeSessionTurn.get(sessionId);
    if (!activeTurnId) {
      return { steered: false, ...this.startTurn(sessionId, { input: clean }) };
    }
    const queue = this.steeringQueues.get(sessionId) ?? [];
    queue.push(clean);
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
          clean,
          JSON.stringify({ steering: true }),
          Date.now(),
        );
    });
    this.#emitPersisted(sessionId, activeTurnId, 'turn/steered', {
      sessionId,
      turnId: activeTurnId,
      text: clean,
    });
    return { steered: true, sessionId, turnId: activeTurnId, queued: queue.length };
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
    return {
      permissionMode: hydrated.permissionMode || 'auto-safe',
      allowTools: hydrated.toolAllow ?? undefined,
      denyTools: hydrated.toolDeny?.length ? hydrated.toolDeny : undefined,
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

  // ---- Turn Enqueue & Lifecycle ----

  startTurn(
    sessionId,
    {
      input,
      clientTurnId = null,
      model = null,
      permissionMode = null,
      effort = null,
      maxSteps = 24,
      finalVerificationReserve = null,
      files = null,
      evidenceContract = null,
      trafficSource = undefined,
      isSynthetic = undefined,
    } = {},
  ) {
    const session = this.getSession(sessionId);
    const trimmedInput = String(input ?? '').trim();
    if (!trimmedInput) throw new Fault('EMPTY_INPUT', 400);

    if (this.activeSessionTurn.has(sessionId) && !clientTurnId) {
      const steered = this.steerSession(sessionId, trimmedInput);
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
    const resolvedMaxSteps = Math.min(40, Math.max(1, Number(maxSteps || 24)));
    const jobPayload = {
      sessionId,
      turnId,
      input: trimmedInput,
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
      trafficSource: classifiedTraffic.trafficSource,
      isSynthetic: classifiedTraffic.isSynthetic,
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
          trimmedInput,
          files && Object.keys(files).length ? JSON.stringify({ files }) : null,
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

        try {
          await this.#runTurnLoop({
            sessionId,
            turnId,
            input: payload.input ?? '',
            model: resolvedModel,
            mode: payload.mode ?? session.mode ?? 'direct',
            permissionMode: payload.permissionMode ?? session.permissionMode ?? 'auto-safe',
            effort: payload.effort ?? null,
            workspaceRoot: payload.workspaceRoot ?? session.workspaceRoot ?? this.getWorkspaceRoot(),
            maxSteps: Number(payload.maxSteps ?? 24),
            finalVerificationReserve: payload.finalVerificationReserve ?? null,
            evidenceContract: payload.evidenceContract ?? null,
            initialStep: checkpoint?.step ?? payload.resumedFromStep ?? 0,
            isRecovery: Boolean(job.reclaimedFromCrash || checkpoint?.step > 0 || job.attempts > 1),
            canRetry: job.attempts < job.maxAttempts,
            leaseGuard,
            signal: combinedSignal,
            trafficSource: classifiedTraffic.trafficSource,
            isSynthetic: classifiedTraffic.isSynthetic,
          });
        } catch (err) {
          if (isLeaseLostError(err)) throw err;
          if (this.closed || !this.store.db?.isOpen) return;
          throw err;
        }
      },
    );
  }

  cancelTurn(turnId) {
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
    const row = this.store.db.prepare('SELECT * FROM direct_turns WHERE id=?').get(turnId);
    if (!row) throw new Fault('TURN_NOT_FOUND', 404);
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
          data: { turnId },
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

  async #runSubagentQuery({
    sessionId,
    turnId,
    objective,
    role,
    mode = 'spawn',
    resumeSessionId = null,
    workspaceRoot,
    permissionMode = 'auto-safe',
    model,
    maxSteps = 6,
    isolatedWorktree = false,
    signal,
  }) {
    if (resumeSessionId) {
      const resumed = await this.childManager.resume(resumeSessionId, {
        callerSessionId: sessionId,
        objective,
        model,
        maxSteps,
        signal,
      });
      return resumed.text;
    }

    const selection = this.adaptiveRouter.select({
      taskType: role || 'research',
      objective,
      preferredModel: model,
      maxSteps,
    });
    const childPerm = isolatedWorktree ? 'auto-safe' : 'read-only';
    const allowedTools = isolatedWorktree
      ? ['read_file', 'glob', 'grep', 'edit_file', 'write_file', 'apply_patch', 'read_blob']
      : selection.profile.toolAllow;

    if (mode === 'fork') {
      const forked = await this.childManager.fork({
        parentSessionId: sessionId,
        parentTurnId: turnId,
        objective,
        profile: selection.profile,
        model: selection.model || model,
        permissionMode: childPerm,
        parentPermissionMode: permissionMode,
        allowedTools,
        budget: { maxSteps },
        workspaceRoot,
        isolatedWorktree,
        signal,
      });
      return forked.text;
    }

    const spawned = await this.childManager.spawn({
      parentSessionId: sessionId,
      parentTurnId: turnId,
      objective,
      profile: selection.profile,
      model: selection.model || model,
      permissionMode: childPerm,
      parentPermissionMode: permissionMode,
      allowedTools,
      budget: { maxSteps },
      workspaceRoot,
      isolatedWorktree,
      signal,
    });
    return spawned.text;
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
    initialStep = 0,
    isRecovery = false,
    canRetry = false,
    leaseGuard = null,
    signal,
    trafficSource = 'production',
    isSynthetic = false,
  }) {
    const started = Date.now();
    const nonce = this.sessionRepo.ensureSessionNonce(sessionId);
    const hooks = new HookRunner(workspaceRoot, {
      dataRoot: this.dataRoot,
      store: this.store,
      trustManager: this.hookTrust,
    });
    let totalIn = 0;
    let totalOut = 0;
    let totalCacheRead = 0;
    let steps = initialStep;
    let effectiveModel = model || null;
    let contextWindow = 128_000;
    let actualProvider = 'pool';
    let actualAccountId = null;

    let readFileState = this.readFileStates.get(sessionId);
    if (!readFileState) {
      readFileState = new Map();
      this.readFileStates.set(sessionId, readFileState);
    }

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
        this.mcpManager.discoverTools(workspaceRoot).catch(() => []),
        hooks
          .run('SessionStart', { sessionId, turnId, input }, { signal, permissionMode: effectivePermissionMode })
          .catch(() => ({ blocked: false, additionalContexts: [] })),
      ]);
      const projectInstructions = discoverProjectInstructions(workspaceRoot);
      const { memoryText, skillsText } = discoverMemoryAndSkills(
        workspaceRoot,
        this.store,
        { dataRoot: this.dataRoot },
      );

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
        sandbox: this.sandbox,
        mcpTools,
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
          this.#emitPersisted(sessionId, turnId, 'file/changed', { turnId, sessionId, ...change });
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
        runSubagent: (opts) =>
          this.#runSubagentQuery({
            sessionId,
            turnId,
            ...opts,
            workspaceRoot,
            permissionMode: this.#getLiveSessionPolicy(sessionId)?.permissionMode || effectivePermissionMode,
            model: effectiveModel,
            signal,
          }),
        orchestrateSwarm: async ({ goal, maxConcurrency = 3 }) => {
          const out = await this.swarmOrchestrator.startRun({
            sessionId,
            rootTurnId: turnId,
            goal,
            workspaceRoot,
            parentPermissionMode:
              this.#getLiveSessionPolicy(sessionId)?.permissionMode || effectivePermissionMode,
            maxConcurrency,
            signal,
          });
          return out.summary;
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
        projectId: currentSession.projectId ?? workspaceRoot,
        memoryTokenBudget: 1000,
        legacyMemoryText: memoryText,
        skillsText,
        planState: currentSession.plan,
        hookContexts: startHook.additionalContexts ?? [],
      });

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
      contextWindow = this.pool.getModelContextWindow(effectiveModel) || 128_000;
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
        messages: assembled.messages,
        tools,
        hooks,
        permissionMode: livePolicy?.permissionMode || effectivePermissionMode,
        allowTools: livePolicy?.allowTools,
        denyTools: livePolicy?.denyTools,
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
          maxOutputTokens: sessionBudget?.maxOutputTokens ?? 4096,
        },
        budgetLedger: directBudgetLedger,
        budgetContext: directBudgetContext,
        signal,
        contextManager: {
          prepareRequest: (opts) =>
            this.compactor.prepareRequest(opts, {
              contextWindow: Math.min(200000, contextWindow),
              sessionId,
              turnId,
              summarize: (oldMsgs) =>
                this.#summarizeHistoryWithLlm(oldMsgs, effectiveModel, signal),
            }),
        },
        drainSteering: () => {
          const queued = this.steeringQueues.get(sessionId);
          return queued?.length ? queued.splice(0) : [];
        },
        onAssistantMessage: ({ text, reasoning, toolCalls }) => {
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
        onToolResult: ({ tc, output, isError, durationMs }) => {
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
                excerpt(output, 32000),
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
      steps = loopResult.steps;
      actualProvider = loopResult.route?.provider || 'pool';
      actualAccountId = loopResult.route?.accountId ?? null;
      const finalAssistantText = loopResult.text || '';
      const finalVerdict = loopResult.verdict ?? null;
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
              error: errorMessage,
              code: errorCode,
              verdict: finalVerdict,
              evidenceCount: Number(evidenceCount || 0),
              durationMs,
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
          if (!isSynthetic && this.intelligence?.memory?.recordExecutionCandidates) {
          safeIsolateSideEffect(() =>
            this.intelligence.memory.recordExecutionCandidates({
              projectId: currentSession.projectId ?? workspaceRoot,
              source: 'direct_turn',
              sourceTaskId: turnId,
              sessionId,
              turnId,
              goal: input,
              summary: finalAssistantText,
              verdict: finalVerdict,
              evidenceCount: Number(evidenceCount || 0),
              isSynthetic: Boolean(isSynthetic),
            }),
          );
        }

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
            durationMs,
            verdict: finalVerdict,
            evidenceCount: Number(evidenceCount || 0),
            text: excerpt(finalAssistantText, 4000),
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
            durationMs,
            evidenceCount: Number(evidenceCount || 0),
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

        if (!isSynthetic && this.intelligence?.memory?.recordExecutionCandidates) {
          safeIsolateSideEffect(() =>
            this.intelligence.memory.recordExecutionCandidates({
              projectId: currentSession.projectId ?? workspaceRoot,
              source: 'direct_turn',
              sourceTaskId: turnId,
              sessionId,
              turnId,
              goal: input,
              summary: finalAssistantText,
              verdict: finalVerdict,
              evidenceCount: Number(evidenceCount || 0),
              isSynthetic: Boolean(isSynthetic),
            }),
          );
        }

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

      // Recover partial token usage & route metadata attached by AgentLoop/InferenceEngine
      const errUsage = classified.usage || err?.usage || err?.partialUsage || null;
      if (errUsage) {
        totalIn = Math.max(totalIn, Number(errUsage.inputTokens ?? 0));
        totalOut = Math.max(totalOut, Number(errUsage.outputTokens ?? 0));
        totalCacheRead = Math.max(totalCacheRead, Number(errUsage.cacheReadTokens ?? 0));
      }
      const errRoute = classified.route || err?.route || null;
      if (errRoute?.provider) actualProvider = errRoute.provider;
      if (errRoute?.accountId) actualAccountId = errRoute.accountId;

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

      // Fix D6 / D7 / P0-1: NEVER swallow LEASE_LOST before RecoveryWorker.#runJob sees it!
      if (isLeaseLostError(classified)) {
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
      if (!checkLeaseHeld(leaseGuard, { sessionId, turnId })) {
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
      const isCancelled = signal.aborted || classified.category === 'cancellation';
      const message = String(classified?.detail?.message ?? classified?.message ?? err);
      const nextState = isCancelled ? 'cancelled' : 'failed';

      const currentTurn = this.store.db
        .prepare('SELECT state, phase, step FROM direct_turns WHERE id=?')
        .get(turnId);
      if (!currentTurn || ['completed', 'failed', 'cancelled'].includes(currentTurn.state)) {
        return;
      }

      if (!isCancelled && canRetry && classified.retryable) {
        throw classified;
      }

      const totalTokens = totalIn + totalOut;
      let outbox = null;
      try {
        outbox = this.store.tx(() => {
          assertLeaseInTx(leaseGuard, { sessionId, turnId });
          const res = this.store.db
            .prepare(
              "UPDATE direct_turns SET state=?, phase=?, error=?, inputTokens=?, outputTokens=?, durationMs=?, finishedAt=?, activeFence=NULL WHERE id=? AND state NOT IN ('completed','failed','cancelled')",
            )
            .run(
              nextState,
              nextState,
              isCancelled ? null : message.slice(0, 1000),
              totalIn,
              totalOut,
              durationMs,
              finishedAt,
              turnId,
            );
          if ((res.changes ?? 0) === 0) return null;
          this.store.db
            .prepare(
              "UPDATE direct_sessions SET state=?, updatedAt=? WHERE id=? AND state NOT IN ('cancelled','completed')",
            )
            .run(nextState, finishedAt, sessionId);
          if (totalTokens > 0 && effectiveModel) {
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
            status: nextState,
            error: isCancelled ? null : message.slice(0, 1000),
            finishedAt,
          });
          const phaseEv = this.eventRouter.insertPersistedInTx({
            sessionId,
            turnId,
            type: RUNTIME_EVENTS.TURN_PHASE_CHANGED,
            data: {
              from: classified.deferredPhaseTransition?.from || currentTurn.phase || 'running',
              to: nextState,
              step: classified.steps ?? steps,
              reason: classified.code || nextState,
            },
            audit: false,
            at: finishedAt,
          });
          const termEv = this.eventRouter.insertPersistedInTx({
            sessionId,
            turnId,
            type: isCancelled ? RUNTIME_EVENTS.TURN_CANCELLED : RUNTIME_EVENTS.TURN_FAILED,
            data: isCancelled
              ? { turnId, sessionId, inputTokens: totalIn, outputTokens: totalOut, durationMs }
              : {
                  turnId,
                  sessionId,
                  model: effectiveModel,
                  provider: actualProvider,
                  inputTokens: totalIn,
                  outputTokens: totalOut,
                  error: message,
                  code: classified.code,
                  durationMs,
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
        this.eventRouter.fanoutPersisted(outbox.phaseEv);
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
      this.activeTurns.delete(turnId);
      if (this.activeSessionTurn.get(sessionId) === turnId) {
        this.activeSessionTurn.delete(sessionId);
      }
    }
  }
}
