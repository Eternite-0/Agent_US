import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Fault, id as uuid } from './store.js';
import { excerpt } from './context.js';
import { AgentRuntimeKernel } from './kernel/runtime.js';
import { EvidenceVerifier } from './governance/verifier.js';
import { classifyError } from './kernel/errors.js';
import { DurableJobQueue } from './durable/job-queue.js';
import { CheckpointStore } from './durable/checkpoint.js';
import { UnknownOutcomeReconciler } from './durable/reconciliation.js';
import { RecoveryWorker } from './durable/recovery.js';
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
import { ToolPermissionPolicy } from './tools/policy.js';
import { GitWorktreeIsolator, HostSandboxAdapter } from './tools/sandbox.js';
import { McpLifecycleManager } from './tools/mcp-lifecycle.js';
import { DirectSessionRepo } from './runtime/session-repo.js';
import { DirectApprovalManager } from './runtime/approval-manager.js';
import { TokenBudgetManager } from './context/budget.js';
import { ProjectMemoryService } from './context/memory.js';
import { MultiStageCompactor } from './context/compaction.js';
import { ContextAssembler } from './context/assembler.js';
import {
  AgentCapabilityRegistry,
  ModelCapabilityRegistry,
} from './swarm/capabilities.js';
import { AdaptiveModelRouter } from './swarm/router.js';
import { DynamicTaskPlanner } from './swarm/planner.js';
import { InterAgentMailbox } from './swarm/mailbox.js';
import { ChildAgentManager } from './swarm/child-lifecycle.js';
import { AdaptiveSwarmOrchestrator } from './swarm/orchestrator.js';

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
    } = {},
  ) {
    this.store = store;
    this.pool = pool;
    this.adapter = adapter ?? pool.adapter;
    this.judgment = judgment;
    this.defaultWorkspace = resolve(defaultWorkspace);
    this.dataRoot = dataRoot ? resolve(dataRoot) : null;
    this.closed = false;

    this.jobQueue = new DurableJobQueue(this.store);
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

    this.toolPolicy = new ToolPermissionPolicy();
    this.sandbox = new HostSandboxAdapter();
    this.kernel.setToolDispatcher(
      new ToolDispatcher({
        store: this.store,
        eventRouter: this.eventRouter,
        reconciler: this.reconciler,
        policy: this.toolPolicy,
      }),
    );

    this.activeTurns = new Map(); // turnId -> { controller, sessionId }
    this.activeSessionTurn = new Map(); // sessionId -> turnId
    this.steeringQueues = new Map(); // sessionId -> string[]
    this.readFileStates = new Map(); // sessionId -> Map(relPath -> { sha256, at })

    this.processManager = new BackgroundProcessManager();
    this.mcpHub = new McpHub({ dataRoot: this.dataRoot, staticMcp });
    this.mcpManager = new McpLifecycleManager({
      dataRoot: this.dataRoot,
      staticMcp,
      hub: this.mcpHub,
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
        if (runningTurnId) this.cancelTurn(runningTurnId);
        this.contextAssembler.clearSession(sessionId);
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

    this.approvalManager = new DirectApprovalManager({
      store: this.store,
      eventRouter: this.eventRouter,
      reconciler: this.reconciler,
    });

    // Layer 6: Adaptive Swarm Orchestrator & Dynamic Capability Routing
    this.worktreeIsolator = new GitWorktreeIsolator();
    this.modelCapabilities = new ModelCapabilityRegistry(this.pool);
    this.agentCapabilities = new AgentCapabilityRegistry();
    this.adaptiveRouter = new AdaptiveModelRouter({
      modelRegistry: this.modelCapabilities,
      agentRegistry: this.agentCapabilities,
      pool: this.pool,
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
      getDefaultModel: () => this.pool.getDefaultModel(),
      getWorkspaceTools: ({ workspaceRoot, sessionId, permissionMode, nonce, signal }) =>
        createWorkspaceTools({
          workspaceRoot,
          store: this.store,
          sessionId,
          permissionMode,
          nonce,
          processManager: this.processManager,
          sandbox: this.sandbox,
          signal,
        }),
    });
    this.swarmOrchestrator = new AdaptiveSwarmOrchestrator({
      store: this.store,
      eventRouter: this.eventRouter,
      planner: this.swarmPlanner,
      router: this.adaptiveRouter,
      childManager: this.childManager,
      mailbox: this.mailbox,
    });

    this.lastRecoveryReport = this.recoveryWorker.start({ recover: true });
  }

  get pendingApprovals() {
    return this.approvalManager.pendingApprovals;
  }

  close() {
    this.closed = true;
    for (const active of this.activeTurns.values()) {
      active.controller.abort();
    }
    this.activeTurns.clear();
    this.activeSessionTurn.clear();
    this.swarmOrchestrator.closeAll();
    void this.worktreeIsolator.cleanupAll();
    void this.recoveryWorker.stop();
    this.kernel.close();
    this.processManager.closeAll();
    this.mcpManager.close();
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
      files = null,
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

    if (clientTurnId) {
      const existing = this.store.db
        .prepare('SELECT * FROM direct_turns WHERE sessionId=? AND clientTurnId=? LIMIT 1')
        .get(sessionId, clientTurnId);
      if (existing) return { turn: existing, session };
    }

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
    };

    this.store.tx(() => {
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
            id, sessionId, clientTurnId, input, model, state, jobId, phase, step, createdAt
          ) VALUES(?,?,?,?,?,'running',?,'init',0,?)`,
        )
        .run(turnId, sessionId, clientTurnId, trimmedInput, resolvedModel, jobId, now);
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
    });

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

    try {
      await this.#runTurnLoop({
        sessionId,
        turnId,
        input: payload.input ?? '',
        model: payload.model ?? session.model ?? this.pool.getDefaultModel() ?? '',
        mode: payload.mode ?? session.mode ?? 'direct',
        permissionMode: payload.permissionMode ?? session.permissionMode ?? 'auto-safe',
        effort: payload.effort ?? null,
        workspaceRoot: payload.workspaceRoot ?? session.workspaceRoot ?? this.getWorkspaceRoot(),
        maxSteps: Number(payload.maxSteps ?? 24),
        initialStep: checkpoint?.step ?? payload.resumedFromStep ?? 0,
        isRecovery: Boolean(job.reclaimedFromCrash || checkpoint?.step > 0 || job.attempts > 1),
        canRetry: job.attempts < job.maxAttempts,
        leaseGuard,
        signal: combinedSignal,
      });
    } catch (err) {
      if (this.closed || !this.store.db?.isOpen) return;
      throw err;
    }
  }

  cancelTurn(turnId) {
    this.recoveryWorker.cancelJobByTurn(turnId);
    this.kernel.cancellation.cancel(turnId, 'user_cancelled');
    const active = this.activeTurns.get(turnId);
    if (active) {
      active.controller.abort();
      this.activeTurns.delete(turnId);
      if (this.activeSessionTurn.get(active.sessionId) === turnId) {
        this.activeSessionTurn.delete(active.sessionId);
      }
    }
    const row = this.store.db.prepare('SELECT * FROM direct_turns WHERE id=?').get(turnId);
    if (!row) throw new Fault('TURN_NOT_FOUND', 404);
    if (['running', 'reconciling', 'parked'].includes(row.state)) {
      const now = Date.now();
      this.store.tx(() => {
        this.store.db
          .prepare("UPDATE direct_turns SET state='cancelled', phase='cancelled', finishedAt=? WHERE id=?")
          .run(now, turnId);
        this.store.db
          .prepare("UPDATE direct_sessions SET state='cancelled', updatedAt=? WHERE id=?")
          .run(now, row.sessionId);
        this.store.db
          .prepare(
            "UPDATE direct_approvals SET status='expired', resolvedAt=? WHERE turnId=? AND status='pending'",
          )
          .run(now, turnId);
      });
      this.#emitPersisted(row.sessionId, turnId, 'turn/cancelled', { turnId });
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
    initialStep = 0,
    isRecovery = false,
    canRetry = false,
    leaseGuard = null,
    signal,
  }) {
    const started = Date.now();
    const nonce = this.sessionRepo.ensureSessionNonce(sessionId);
    const hooks = new HookRunner(workspaceRoot, { dataRoot: this.dataRoot });
    let totalIn = 0;
    let totalOut = 0;
    let totalCacheRead = 0;
    let steps = initialStep;

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
      const effectiveModel = model || this.pool.getDefaultModel();
      if (!effectiveModel) {
        throw new Fault('NO_MODEL_CONFIGURED', 400, {
          message:
            '尚未配置任何可用模型。请前往「设置 → 账号号池」添加供应商账号并点击「获取模型」，即可无需重启立刻开始对话。',
        });
      }

      const [gitBranch, mcpTools, startHook] = await Promise.all([
        detectGitBranch(workspaceRoot),
        this.mcpManager.discoverTools(workspaceRoot).catch(() => []),
        hooks
          .run('SessionStart', { sessionId, turnId, input })
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
        store: this.store,
        sessionId,
        permissionMode,
        nonce,
        getApprovedPrefixes: () => this.getSession(sessionId).approvedPrefixes ?? [],
        readFileState,
        processManager: this.processManager,
        sandbox: this.sandbox,
        mcpTools,
        signal,
        requestApproval: ({ tool, arguments: args, callId }) =>
          this.approvalManager.requestApproval({
            sessionId,
            turnId,
            callId,
            tool,
            args,
            signal,
          }),
        onBeforeMutate: (rel, full) =>
          this.sessionRepo.capturePreMutationSnapshot(sessionId, turnId, rel, full),
        onFileChanged: (change) => {
          this.#emitPersisted(sessionId, turnId, 'file/changed', { turnId, sessionId, ...change });
        },
        onToolOutput: (chunk) => {
          this.#emitLiveDelta(sessionId, turnId, 'tool/output', { turnId, sessionId, ...chunk });
        },
        onPlanUpdated: (plan) => {
          this.store.tx(() => {
            this.store.db
              .prepare('UPDATE direct_sessions SET planJson=?, updatedAt=? WHERE id=?')
              .run(JSON.stringify(plan), Date.now(), sessionId);
          });
          this.#emitPersisted(sessionId, turnId, 'plan/updated', { turnId, sessionId, plan });
        },
        runSubagent: (opts) =>
          this.#runSubagentQuery({
            sessionId,
            turnId,
            ...opts,
            workspaceRoot,
            permissionMode,
            model: effectiveModel,
            signal,
          }),
        orchestrateSwarm: async ({ goal, maxConcurrency = 3 }) => {
          const out = await this.swarmOrchestrator.startRun({
            sessionId,
            rootTurnId: turnId,
            goal,
            workspaceRoot,
            parentPermissionMode: permissionMode,
            maxConcurrency,
            signal,
          });
          return out.summary;
        },
        sendAgentMessage: ({ toAgentId, kind = 'note', message }) =>
          this.mailbox.send({
            sessionId,
            fromAgentId: turnId,
            toAgentId,
            kind,
            payload: message,
          }),
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
        permissionMode,
        projectInstructions,
        memoryQuery: input,
        legacyMemoryText: memoryText,
        skillsText,
        planState: currentSession.plan,
        hookContexts: startHook.additionalContexts ?? [],
      });

      const contextWindow = this.pool.getModelContextWindow(effectiveModel);
      const loopResult = await this.kernel.executeTurn({
        sessionId,
        turnId,
        profile: 'default',
        input,
        model: effectiveModel,
        provider: 'pool',
        effort,
        workspaceRoot,
        messages: assembled.messages,
        tools,
        hooks,
        permissionMode,
        getApprovedPrefixes: () => this.getSession(sessionId).approvedPrefixes ?? [],
        requestApproval: ({ tool, arguments: args, callId }) =>
          this.approvalManager.requestApproval({
            sessionId,
            turnId,
            callId,
            tool,
            args,
            signal,
          }),
        initialStep,
        leaseGuard,
        budget: { maxSteps, maxOutputTokens: 4096 },
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
      const finalAssistantText = loopResult.text || '';
      const finalVerdict = loopResult.verdict ?? null;
      const evidenceCount =
        finalVerdict?.evidenceCount ??
        this.store.db
          .prepare('SELECT COUNT(*) AS n FROM tool_receipts WHERE sessionId=? AND turnId=?')
          .get(sessionId, turnId)?.n ??
        0;

      await hooks
        .run('Stop', { sessionId, turnId, steps, text: excerpt(finalAssistantText, 1000) })
        .catch(() => {});

      const durationMs = Date.now() - started;
      const finishedAt = Date.now();
      const totalTokens = totalIn + totalOut;

      if (this.closed || !this.store.db?.isOpen) return;
      leaseGuard?.();

      this.store.tx(() => {
        this.store.db
          .prepare(
            `UPDATE direct_turns
             SET state='completed', inputTokens=?, outputTokens=?, durationMs=?,
                 verdictJson=?, evidenceCount=?, finishedAt=?
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
        this.store.db
          .prepare(
            "UPDATE direct_sessions SET state='completed', updatedAt=? WHERE id=? AND state!='cancelled'",
          )
          .run(finishedAt, sessionId);
        this.store.db
          .prepare(
            `INSERT INTO nexus_usage(
              sessionId, provider, model, day, inputTokens, outputTokens, tokens, costUsd, durationMs, createdAt
            ) VALUES(?,'pool',?,?,?,?,?,0,?,?)`,
          )
          .run(
            sessionId,
            effectiveModel,
            todayDateStr(),
            totalIn,
            totalOut,
            totalTokens,
            durationMs,
            finishedAt,
          );
      });

      this.store.event('direct.turn.completed', null, null, {
        sessionId,
        turnId,
        model: effectiveModel,
        steps,
        inputTokens: totalIn,
        outputTokens: totalOut,
        cacheReadTokens: totalCacheRead,
        durationMs,
        evidenceCount: Number(evidenceCount || 0),
      });

      this.#emitPersisted(sessionId, turnId, 'turn/completed', {
        turnId,
        sessionId,
        model: effectiveModel,
        steps,
        inputTokens: totalIn,
        outputTokens: totalOut,
        cacheReadTokens: totalCacheRead,
        durationMs,
        verdict: finalVerdict,
        evidenceCount: Number(evidenceCount || 0),
        text: excerpt(finalAssistantText, 4000),
      });
    } catch (err) {
      if (this.closed || !this.store.db?.isOpen) return;
      const classified = classifyError(err);
      if (classified.code === 'LEASE_LOST') return;
      const durationMs = Date.now() - started;
      const finishedAt = Date.now();
      const isCancelled = signal.aborted || classified.category === 'cancellation';
      const message = String(classified?.detail?.message ?? classified?.message ?? err);
      const nextState = isCancelled ? 'cancelled' : 'failed';

      const currentTurn = this.store.db
        .prepare('SELECT state FROM direct_turns WHERE id=?')
        .get(turnId);
      if (!currentTurn || ['completed', 'failed', 'cancelled'].includes(currentTurn.state)) {
        return;
      }

      if (!isCancelled && canRetry && classified.retryable) {
        throw classified;
      }

      this.store.tx(() => {
        this.store.db
          .prepare(
            "UPDATE direct_turns SET state=?, error=?, inputTokens=?, outputTokens=?, durationMs=?, finishedAt=? WHERE id=? AND state NOT IN ('completed','failed','cancelled')",
          )
          .run(
            nextState,
            isCancelled ? null : message.slice(0, 1000),
            totalIn,
            totalOut,
            durationMs,
            finishedAt,
            turnId,
          );
        this.store.db
          .prepare(
            "UPDATE direct_sessions SET state=?, updatedAt=? WHERE id=? AND state!='cancelled'",
          )
          .run(nextState, finishedAt, sessionId);
      });

      if (!isCancelled) {
        this.#emitPersisted(sessionId, turnId, 'turn/failed', {
          turnId,
          sessionId,
          error: message,
          code: classified.code,
          durationMs,
        });
      }
    } finally {
      this.activeTurns.delete(turnId);
      if (this.activeSessionTurn.get(sessionId) === turnId) {
        this.activeSessionTurn.delete(sessionId);
      }
    }
  }
}
