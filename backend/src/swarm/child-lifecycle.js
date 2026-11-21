import { Fault, id as uuid } from '../store.js';
import { excerpt } from '../context.js';
import { HookRunner } from '../agent-context.js';
import { BudgetError, CancellationError, RecoveryError, RuntimeError } from '../kernel/errors.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import {
  assertLeaseInTx,
  checkLeaseHeld,
  isLeaseLostError,
} from '../durable/lease-guard.js';
import { withTraceContext } from '../observability/trace.js';
import { filterToolsByPolicy, intersectAllowlists, intersectPolicies } from '../tools/policy.js';
import { ISOLATION_MODES } from '../tools/sandbox.js';
import { WORKSPACE_TOOL_META } from '../workspace-tools.js';
import { createSwarmArtifactTools } from './artifacts.js';
import {
  BUDGET_SCOPES,
  TaskTreeBudgetLedger,
  computeEffectiveNodeBudget,
  isBudgetErrorCode,
  minDefinedLimit,
  normalizeBudgetLimit,
  normalizeNodeBudget,
} from './budget-ledger.js';

const MAX_FORK_DEPTH = 2;

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Layer 6 Persistent ChildAgentManager:
 * - Persists `direct_turns` rows + `child_notifications` for crash recovery
 * - Enforces parent->child permission intersection & remaining tree budgets
 * - Enforces Fail-Closed worktree isolation & cleanup on cancel/exit
 * - Injects `parentGuard` into every tool dispatch to block orphan side effects
 */
export class ChildAgentManager {
  constructor({
    store,
    kernel,
    sessionRepo,
    contextAssembler,
    eventRouter,
    worktreeIsolator,
    artifactManager = null,
    jobQueue = null,
    budgetLedger = null,
    hookTrust = null,
    dataRoot = null,
    getWorkspaceTools,
    getDefaultModel,
    getLivePolicy = null,
    requestApproval = null,
    approvalManager = null,
  }) {
    this.store = store;
    this.kernel = kernel;
    this.sessionRepo = sessionRepo;
    this.contextAssembler = contextAssembler;
    this.eventRouter = eventRouter;
    this.worktreeIsolator = worktreeIsolator;
    this.artifactManager = artifactManager;
    this.jobQueue = jobQueue;
    this.budgetLedger = budgetLedger ?? (store ? new TaskTreeBudgetLedger(store) : null);
    this.hookTrust = hookTrust;
    this.dataRoot = dataRoot;
    this.getWorkspaceTools = getWorkspaceTools;
    this.getLivePolicy = getLivePolicy;
    this.requestApproval = requestApproval;
    this.approvalManager = approvalManager;
    this.getDefaultModel = getDefaultModel;
    this.activeChildren = new Map(); // childSessionId -> { controller, parentSessionId, paused, shuttingDown, model }
    this.shuttingDown = false;
  }

  #isDescendantOf(childSessionId, ancestorSessionId) {
    if (!childSessionId || !ancestorSessionId || !this.store?.db?.isOpen) return false;
    let cur = childSessionId;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const row = this.store.db
        .prepare('SELECT parentSessionId FROM direct_sessions WHERE id=?')
        .get(cur);
      if (!row?.parentSessionId) return false;
      if (row.parentSessionId === ancestorSessionId) return true;
      cur = row.parentSessionId;
    }
    return false;
  }

  #recordChildUsageInTx({
    sessionId,
    runId,
    provider,
    model,
    inputTokens = 0,
    outputTokens = 0,
    durationMs = 0,
    trafficSource = 'production',
    isSynthetic = 0,
    now,
  }) {
    const inTok = Math.max(0, Number(inputTokens || 0));
    const outTok = Math.max(0, Number(outputTokens || 0));
    const total = inTok + outTok;
    if (total <= 0) return;
    const day = new Date(now).toISOString().slice(0, 10);
    this.store.db
      .prepare(
        `INSERT INTO nexus_usage(
          sessionId, planId, provider, model, accountId, day,
          inputTokens, outputTokens, tokens, costUsd, durationMs,
          trafficSource, isSynthetic, createdAt
        ) VALUES(?,?,?,?,NULL,?,?,?,?,0,?,?,?,?)`,
      )
      .run(
        sessionId,
        runId || null,
        String(provider || 'pool'),
        String(model || ''),
        day,
        inTok,
        outTok,
        total,
        Math.max(0, Math.round(Number(durationMs || 0))),
        String(trafficSource || 'production'),
        isSynthetic ? 1 : 0,
        now,
      );
  }

  #computeDepth(sessionId) {
    let depth = 0;
    let cur = sessionId;
    const visited = new Set();
    while (cur && !visited.has(cur) && depth < 10) {
      visited.add(cur);
      const row = this.store.db
        .prepare('SELECT parentSessionId FROM direct_sessions WHERE id=?')
        .get(cur);
      if (!row?.parentSessionId) break;
      depth++;
      cur = row.parentSessionId;
    }
    return depth;
  }

  #collectDescendantIds(rootSessionId) {
    const out = [];
    const queue = [rootSessionId];
    const seen = new Set([rootSessionId]);
    while (queue.length) {
      const cur = queue.shift();
      const children = this.store.db
        .prepare('SELECT id FROM direct_sessions WHERE parentSessionId=?')
        .all(cur);
      for (const ch of children) {
        if (seen.has(ch.id)) continue;
        seen.add(ch.id);
        out.push(ch.id);
        queue.push(ch.id);
      }
    }
    return out;
  }

  #assertAncestorsActive(sessionId) {
    if (!sessionId || !this.store?.db?.isOpen) return;
    let cur = sessionId;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const row = this.store.db
        .prepare('SELECT state, parentSessionId FROM direct_sessions WHERE id=?')
        .get(cur);
      if (!row) return;
      if (row.state === 'cancelled') {
        throw new CancellationError('PARENT_CANCELLED', {
          message: `Session or ancestor ${cur} has been cancelled`,
        });
      }
      cur = row.parentSessionId;
    }
  }

  #clampChildBudget(parentSessionId, requestedBudget = {}, { runId = null, budgetLedger = null } = {}) {
    const activeLedger = budgetLedger ?? this.budgetLedger;
    const req = normalizeNodeBudget(requestedBudget);
    if (runId && activeLedger) {
      const snap = activeLedger.getSnapshot(runId);
      return {
        effectiveBudget: computeEffectiveNodeBudget(req, snap),
        activeLedger,
        treeId: runId,
      };
    }
    if (!parentSessionId || !this.store?.db?.isOpen) {
      return { effectiveBudget: req, activeLedger: null, treeId: null };
    }
    const parent = this.sessionRepo.getSession(parentSessionId);
    const rootId = parent?.rootSessionId || parentSessionId;
    const rootSess =
      rootId === parentSessionId ? parent : this.sessionRepo.getSession(rootId);
    const rootBudget = rootSess?.budget ?? null;
    const parentBudget = parent?.budget ?? null;
    const treeBudget = {
      maxTotalSteps: minDefinedLimit(
        minDefinedLimit(rootBudget?.maxTotalSteps, rootBudget?.maxSteps),
        minDefinedLimit(parentBudget?.maxTotalSteps, parentBudget?.maxSteps),
      ),
      maxTotalTokens: minDefinedLimit(
        minDefinedLimit(rootBudget?.maxTotalTokens, rootBudget?.maxTokens),
        minDefinedLimit(parentBudget?.maxTotalTokens, parentBudget?.maxTokens),
      ),
      maxOutputTokens: minDefinedLimit(rootBudget?.maxOutputTokens, parentBudget?.maxOutputTokens),
      maxDurationMs: minDefinedLimit(rootBudget?.maxDurationMs, parentBudget?.maxDurationMs),
    };
    const hasTreeLimit =
      treeBudget.maxTotalSteps !== null ||
      treeBudget.maxTotalTokens !== null ||
      treeBudget.maxOutputTokens !== null;
    if (!hasTreeLimit || !activeLedger) {
      return { effectiveBudget: req, activeLedger: null, treeId: null };
    }

    const treeIds = [rootId, ...this.#collectDescendantIds(rootId)];
    const ph = treeIds.map(() => '?').join(',');
    const usedRow = this.store.db
      .prepare(
        `SELECT COALESCE(SUM(inputTokens), 0) AS usedInputTokens,
                COALESCE(SUM(outputTokens), 0) AS usedOutputTokens,
                COALESCE(SUM(step), 0) AS usedSteps
         FROM direct_turns WHERE sessionId IN (${ph})`,
      )
      .get(...treeIds);
    const snap = activeLedger.ensureLedger({
      treeId: rootId,
      rootSessionId: rootId,
      budget: treeBudget,
      initialUsage: {
        steps: usedRow?.usedSteps ?? 0,
        inputTokens: usedRow?.usedInputTokens ?? 0,
        outputTokens: usedRow?.usedOutputTokens ?? 0,
      },
    });
    return {
      effectiveBudget: computeEffectiveNodeBudget(req, snap, treeBudget),
      activeLedger,
      treeId: rootId,
    };
  }

  #resolveTools({
    workspaceRoot,
    sessionId,
    policy,
    nonce,
    signal,
    isolatedWorktree,
    getApprovedPrefixes = () => [],
    requestApproval = null,
    getLivePolicy = null,
    isChild = true,
    extraTools = [],
  }) {
    const allTools = [
      ...this.getWorkspaceTools({
        workspaceRoot,
        sessionId,
        permissionMode: policy.permissionMode,
        nonce,
        getLivePolicy,
        getApprovedPrefixes,
        requestApproval,
        signal,
      }),
      ...extraTools,
    ];
    const denySet = new Set(policy.denyTools ?? []);
    if (isChild) denySet.add('spawn_subagent');

    // Preserve explicit allowlist semantics: null=unrestricted, []=allow NO tools, non-empty=only listed
    let filtered = filterToolsByPolicy(allTools, {
      denyTools: [...denySet],
      allowTools: policy.allowTools,
    });
    if (policy.permissionMode === 'read-only' && !isolatedWorktree) {
      filtered = filtered.filter(
        (t) => Boolean(t.meta?.readOnly ?? WORKSPACE_TOOL_META[t.name]?.readOnly),
      );
    }
    return filtered;
  }

  #persistNotificationInTx({
    parentSessionId,
    childSessionId,
    runId = null,
    nodeKey = null,
    status,
    payload,
    jobId = null,
    fence = null,
    attempt = 0,
  }) {
    if (!parentSessionId || !this.store?.db?.isOpen) return null;
    const notifId = uuid();
    const now = Date.now();
    const idem = `notify:${childSessionId}:${status}:${payload?.turnId || ''}`;
    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO child_notifications(
          id, idempotencyKey, parentSessionId, childSessionId, runId, nodeKey,
          status, payloadJson, delivered, jobId, fence, attempt, createdAt
        ) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?)`,
      )
      .run(
        notifId,
        idem,
        parentSessionId,
        childSessionId,
        runId,
        nodeKey,
        status,
        JSON.stringify(payload ?? {}),
        jobId,
        fence,
        Number(attempt || 0),
        now,
      );
    return this.store.db
      .prepare('SELECT * FROM child_notifications WHERE idempotencyKey=?')
      .get(idem);
  }

  #persistNotification({
    parentSessionId,
    childSessionId,
    runId = null,
    nodeKey = null,
    status,
    payload,
    leaseGuard = null,
    attempt = 0,
  }) {
    if (!parentSessionId || !this.store?.db?.isOpen) return null;
    return this.store.tx(() => {
      assertLeaseInTx(leaseGuard);
      return this.#persistNotificationInTx({
        parentSessionId,
        childSessionId,
        runId,
        nodeKey,
        status,
        payload,
        jobId: leaseGuard?.jobId ?? null,
        fence: leaseGuard?.fence ?? null,
        attempt,
      });
    });
  }

  collectNotifications(parentSessionId, { unreadOnly = true } = {}) {
    if (!this.store?.db?.isOpen) return [];
    const rows = unreadOnly
      ? this.store.db
          .prepare(
            'SELECT * FROM child_notifications WHERE parentSessionId=? AND delivered=0 ORDER BY createdAt ASC',
          )
          .all(parentSessionId)
      : this.store.db
          .prepare(
            'SELECT * FROM child_notifications WHERE parentSessionId=? ORDER BY createdAt ASC',
          )
          .all(parentSessionId);
    return rows.map((r) => ({ ...r, payload: parseJsonSafe(r.payloadJson, {}) }));
  }

  ackNotification(id) {
    this.store.tx(() => {
      this.store.db
        .prepare('UPDATE child_notifications SET delivered=1, deliveredAt=? WHERE id=?')
        .run(Date.now(), id);
    });
  }

  async #runChildTurn({
    parentSessionId,
    parentTurnId = null,
    childSessionId,
    objective,
    profile,
    model,
    provider = 'pool',
    policy,
    workspaceRoot,
    isolatedWorktree = false,
    isolationMode = null,
    allowIsolationFallback = false,
    runId = null,
    nodeId = null,
    nodeKey = null,
    attempt = 1,
    workerId = null,
    predecessorArtifacts = [],
    rehydrateFromArtifactId = null,
    ackMailboxIds = [],
    budget = {},
    budgetLedger = null,
    budgetScope = BUDGET_SCOPES.NODE_EXECUTION,
    leaseGuard = null,
    initialStep = 0,
    resumeTurnId = null,
    externalSignal = undefined,
    extraUserMessages = [],
    resumeMode = false,
    trafficSource = 'production',
    isSynthetic = 0,
  }) {
    const subId = `sub_${childSessionId.slice(0, 8)}`;
    const turnId = resumeTurnId || `${parentTurnId || 'root'}:${subId}:${Date.now().toString(36)}`;
    const turnStartedAt = Date.now();
    return withTraceContext(
      {
        runId,
        nodeId,
        sessionId: childSessionId,
        turnId,
        attempt,
        trafficSource,
        isSynthetic: Boolean(isSynthetic),
      },
      async () => {
        this.#assertAncestorsActive(childSessionId);
        const {
          effectiveBudget,
          activeLedger,
          treeId: budgetTreeId,
        } = this.#clampChildBudget(parentSessionId, budget, { runId, budgetLedger });

        const controller = new AbortController();
        const combinedSignal = externalSignal
          ? AbortSignal.any([externalSignal, controller.signal])
          : controller.signal;
        const state = {
          controller,
          parentSessionId,
          paused: false,
          shuttingDown: false,
          model,
          runId,
          nodeKey,
        };
        this.activeChildren.set(childSessionId, state);

        const requestedMode =
          isolationMode ||
          (isolatedWorktree ? ISOLATION_MODES.WORKTREE : ISOLATION_MODES.SHARED_READONLY);

        const baseLeaseGuard =
          leaseGuard?.withContext?.({
            sessionId: childSessionId,
            runId,
            nodeId,
          }) ?? leaseGuard;

        const readLivePolicy = () => {
          const childLive = this.getLivePolicy?.(childSessionId) ?? null;
          const parentLive =
            parentSessionId && parentSessionId !== childSessionId
              ? this.getLivePolicy?.(parentSessionId) ?? null
              : null;
          let live = intersectPolicies(effectivePolicy, childLive ?? {});
          if (parentLive) live = intersectPolicies(live, parentLive);
          return {
            ...live,
            // Prefix approvals are session-scoped. Never implicitly copy the parent cache.
            approvedPrefixes: Array.isArray(childLive?.approvedPrefixes)
              ? childLive.approvedPrefixes
              : [],
          };
        };
        const readApprovedPrefixes = () => readLivePolicy().approvedPrefixes;
        const childRequestApproval =
          typeof this.requestApproval === 'function'
            ? (req) =>
                this.requestApproval({
                  ...req,
                  sessionId: childSessionId,
                  turnId,
                  signal: combinedSignal,
                })
            : null;

        let wt = null;
        let effectiveRoot = workspaceRoot;
        let effectivePolicy = { ...policy };
        let isIsolated = false;
        let materializedHandoffs = [];
        let archivedArtifact = null;
        let leaseLost = false;
        let explicitCancel = false;
        let shuttingDownTurn = false;

        if (requestedMode === ISOLATION_MODES.WORKTREE) {
          if (!this.worktreeIsolator) {
            if (!allowIsolationFallback) {
              this.activeChildren.delete(childSessionId);
              throw new Fault('WORKTREE_ISOLATION_FAILED', 500, {
                message: 'Worktree isolator unavailable and fallback disabled',
              });
            }
            effectivePolicy = intersectPolicies(effectivePolicy, {
              permissionMode: 'read-only',
              denyTools: ['write_file', 'edit_file', 'apply_patch', 'bash', 'start_process', 'kill_process'],
            });
          } else {
            try {
              wt = await this.worktreeIsolator.acquire(workspaceRoot, {
                ownerId: childSessionId,
                workerId: workerId ?? leaseGuard?.workerId ?? null,
                sessionId: childSessionId,
                runId,
                nodeKey,
                jobId: leaseGuard?.jobId ?? null,
                fence: leaseGuard?.fence ?? null,
                attempt,
                rehydrateExisting: Boolean(runId && nodeKey),
                leaseGuard: baseLeaseGuard,
              });
              // P0-4: If recovery found a verified archived artifact for a cleaned worktree, rehydrate it!
              if (wt && !wt.rehydrated && rehydrateFromArtifactId && this.artifactManager?.rehydrateArtifactToWorktree) {
                this.artifactManager.rehydrateArtifactToWorktree(rehydrateFromArtifactId, wt.path);
              }
              effectiveRoot = wt.path;
              isIsolated = true;
            } catch (wtErr) {
              if (isLeaseLostError(wtErr)) {
                this.activeChildren.delete(childSessionId);
                throw wtErr;
              }
              if (!allowIsolationFallback) {
                this.activeChildren.delete(childSessionId);
                throw new Fault('WORKTREE_ISOLATION_FAILED', 500, {
                  message: `Worktree isolation failed (fail-closed, no implicit fallback): ${String(wtErr?.message ?? wtErr)}`,
                });
              }
              effectivePolicy = intersectPolicies(effectivePolicy, {
                permissionMode: 'read-only',
                denyTools: ['write_file', 'edit_file', 'apply_patch', 'bash', 'start_process', 'kill_process'],
              });
            }
          }
        } else if (requestedMode === ISOLATION_MODES.SHARED_READONLY) {
          effectivePolicy = intersectPolicies(effectivePolicy, { permissionMode: 'read-only' });
        }

        const turnLeaseGuard =
          baseLeaseGuard?.withContext?.({
            sessionId: childSessionId,
            turnId,
            runId,
            nodeId,
          }) ?? baseLeaseGuard;
        const explicitMaxSteps = normalizeBudgetLimit(effectiveBudget.maxSteps);
        const maxSteps =
          explicitMaxSteps !== null
            ? Math.min(20, explicitMaxSteps)
            : Math.min(20, Math.max(1, Number(profile?.defaultMaxSteps ?? 8)));
        const resolvedModel = model || this.getDefaultModel();

        try {
          this.eventRouter?.emitPersisted({
            sessionId: parentSessionId,
            turnId: parentTurnId,
            type: RUNTIME_EVENTS.SUBAGENT_STARTED,
            data: {
              subagentId: subId,
              childSessionId,
              childTurnId: turnId,
              role: profile?.name || profile?.id || 'worker',
              model: resolvedModel,
              objective,
              isolationMode: requestedMode,
              isolatedWorktree: isIsolated,
              rehydratedWorktree: Boolean(wt?.rehydrated || rehydrateFromArtifactId),
            },
            audit: false,
          });
        } catch {
          // non-fatal event emit
        }

        try {
          // Fix C6: Materialize predecessor artifacts into isolated handoff dir & build structured context
          let artifactContext = '';
          if (predecessorArtifacts.length && this.artifactManager) {
            if (isIsolated && wt) {
              materializedHandoffs = this.artifactManager.materializeToHandoffDir(
                predecessorArtifacts,
                wt.path,
              );
              artifactContext = this.artifactManager.formatPredecessorArtifactsContext(
                materializedHandoffs,
                { isolatedWorktree: true },
              );
            } else {
              const descriptors = predecessorArtifacts.map((a) => ({
                artifactId: a.id || a.artifactId,
                uri: a.uri,
                nodeKey: a.nodeKey,
                attempt: a.attempt,
                baseCommit: a.baseCommit,
                bundleSha256: a.bundleSha256,
                files: a.files ?? [],
              }));
              artifactContext = this.artifactManager.formatPredecessorArtifactsContext(descriptors, {
                isolatedWorktree: false,
              });
            }
          }
          const effectiveObjective = artifactContext
            ? `${artifactContext}\n\n${objective}`
            : objective;

          const now = Date.now();
          this.store.tx(() => {
            assertLeaseInTx(baseLeaseGuard, { runId, nodeId, bindingOwnership: true });
            this.#assertAncestorsActive(childSessionId);
            this.store.db
              .prepare(
                "UPDATE direct_sessions SET state='running', permissionMode=?, updatedAt=? WHERE id=? AND state!='cancelled'",
              )
              .run(effectivePolicy.permissionMode, now, childSessionId);
            if (!resumeTurnId) {
              this.store.db
                .prepare(
                  `INSERT OR IGNORE INTO direct_turns(
                    id, sessionId, input, model, state, phase, step, agentProfile,
                    activeFence, activeAttempt, trafficSource, isSynthetic, createdAt
                  ) VALUES(?,?,?,?,'running','init',?,?,?,?,?,?,?)`,
                )
                .run(
                  turnId,
                  childSessionId,
                  String(effectiveObjective || '').slice(0, 2000),
                  resolvedModel,
                  initialStep,
                  profile?.id || 'subagent',
                  turnLeaseGuard?.fence ?? null,
                  Number(attempt || 1),
                  String(trafficSource || 'production'),
                  isSynthetic ? 1 : 0,
                  now,
                );
              if (effectiveObjective) {
                this.store.db
                  .prepare(
                    'INSERT INTO direct_messages(sessionId, turnId, role, content, createdAt) VALUES(?,?,?,?,?)',
                  )
                  .run(childSessionId, turnId, 'user', effectiveObjective, now);
              }
            } else {
              this.store.db
                .prepare(
                  `UPDATE direct_turns
                   SET state='running', phase='checkpoint', activeFence=?, activeAttempt=?
                   WHERE id=? AND state NOT IN ('completed','cancelled')`,
                )
                .run(turnLeaseGuard?.fence ?? null, Number(attempt || 1), turnId);
            }
            if (Array.isArray(ackMailboxIds) && ackMailboxIds.length > 0) {
              const ackStmt = this.store.db.prepare(
                "UPDATE agent_messages SET status='delivered', deliveredAt=? WHERE id=? AND status='queued'",
              );
              for (const mid of ackMailboxIds) {
                if (mid) ackStmt.run(now, String(mid));
              }
            }
            if (runId && nodeKey) {
              this.store.db
                .prepare(
                  `UPDATE swarm_nodes
                   SET childSessionId=?, childTurnId=?, worktreeLeaseId=COALESCE(?, worktreeLeaseId),
                       worktreePath=COALESCE(?, worktreePath), updatedAt=?
                   WHERE runId=? AND nodeKey=? AND status NOT IN ('completed','failed','cancelled')`,
                )
                .run(
                  childSessionId,
                  turnId,
                  wt?.leaseId ?? null,
                  wt?.path ?? null,
                  now,
                  runId,
                  nodeKey,
                );
            }
          });

          const session = this.sessionRepo.getSession(childSessionId);
          const nonce = this.sessionRepo.ensureSessionNonce(childSessionId);
          const extraTools =
            runId && this.artifactManager
              ? createSwarmArtifactTools({
                  artifactManager: this.artifactManager,
                  runId,
                  predecessorArtifacts: isIsolated ? materializedHandoffs : predecessorArtifacts,
                })
              : [];
          const tools = this.#resolveTools({
            workspaceRoot: effectiveRoot,
            sessionId: childSessionId,
            policy: effectivePolicy,
            nonce,
            signal: combinedSignal,
            isolatedWorktree: isIsolated,
            getLivePolicy: readLivePolicy,
            getApprovedPrefixes: readApprovedPrefixes,
            requestApproval: childRequestApproval,
            extraTools,
          });

          const assembled = this.contextAssembler.assemble({
            session,
            turnId,
            nonce,
            profile: session.agentProfile?.startsWith('fork:') ? null : profile,
            workspaceRoot: effectiveRoot,
            mode: 'direct',
            permissionMode: effectivePolicy.permissionMode,
          });
          if (session.agentProfile?.startsWith('fork:') && profile?.staticSystemInstruction) {
            assembled.messages.splice(
              -1,
              0,
              {
                role: 'user',
                content: [{ type: 'text', text: `[Fork 子代理分工说明]\n${profile.staticSystemInstruction}` }],
              },
              {
                role: 'assistant',
                content: [{ type: 'text', text: '收到分支任务分工说明。' }],
              },
            );
          }
          if (extraUserMessages.length) {
            assembled.messages.splice(-1, 0, ...extraUserMessages);
          }

          // Wire parent workspace HookRunner (sharing HookTrustManager) so child/swarm turns NEVER bypass PreToolUse security hooks!
          const hookWorkspaceRoot = workspaceRoot || effectiveRoot;
          const hooks = hookWorkspaceRoot
            ? new HookRunner(hookWorkspaceRoot, {
                dataRoot: this.dataRoot,
                store: this.store,
                trustManager: this.hookTrust,
                eventRouter: this.eventRouter,
              })
            : null;

          const kernelProfile = this.kernel.getProfile('swarm_worker') ?? this.kernel.getProfile('subagent');
          const result = await this.kernel.executeTurn({
            sessionId: childSessionId,
            turnId,
            parentEpochId: parentTurnId,
            externalSignal: combinedSignal,
            workspaceRoot: effectiveRoot,
            hooks,
            leaseGuard: turnLeaseGuard,
            parentGuard: () => this.#assertAncestorsActive(childSessionId),
            initialStep,
            profile: {
              ...kernelProfile,
              persistTurn: true,
              streamDeltas: false,
              emitAssistantMessage: false,
              emitToolEvents: false,
            },
            input: effectiveObjective,
            model: resolvedModel,
            provider,
            permissionMode: effectivePolicy.permissionMode,
            allowTools: effectivePolicy.allowTools,
            denyTools: [...new Set([...(effectivePolicy.denyTools ?? []), 'spawn_subagent'])],
            getLivePolicy: readLivePolicy,
            getApprovedPrefixes: readApprovedPrefixes,
            requestApproval: childRequestApproval,
            approvalManager: this.approvalManager,
            messages: assembled.messages,
            tools,
            budgetLedger: activeLedger,
            budgetContext: budgetTreeId
              ? {
                  treeId: budgetTreeId,
                  scope: budgetScope,
                  nodeId,
                  nodeKey,
                  attempt,
                }
              : null,
            budget: {
              maxSteps,
              maxOutputTokens:
                normalizeBudgetLimit(effectiveBudget.maxOutputTokens) !== null
                  ? normalizeBudgetLimit(effectiveBudget.maxOutputTokens)
                  : 2048,
              ...(normalizeBudgetLimit(effectiveBudget.maxTokens) !== null
                ? { maxTokens: normalizeBudgetLimit(effectiveBudget.maxTokens) }
                : {}),
              ...(normalizeBudgetLimit(effectiveBudget.maxDurationMs) !== null
                ? { maxDurationMs: normalizeBudgetLimit(effectiveBudget.maxDurationMs) }
                : {}),
            },
            onAssistantMessage: ({ text, reasoning, toolCalls }) => {
              this.store.tx(() => {
                assertLeaseInTx(turnLeaseGuard);
                this.#assertAncestorsActive(childSessionId);
                this.store.db
                  .prepare(
                    `INSERT INTO direct_messages(
                      sessionId, turnId, role, content, reasoning, toolCalls, createdAt
                    ) VALUES(?,?,'assistant',?,?,?,?)`,
                  )
                  .run(
                    childSessionId,
                    turnId,
                    text,
                    reasoning || null,
                    toolCalls?.length ? JSON.stringify(toolCalls) : null,
                    Date.now(),
                  );
              });
            },
            onToolResult: ({ tc, output, isError, durationMs }) => {
              this.store.tx(() => {
                assertLeaseInTx(turnLeaseGuard);
                this.#assertAncestorsActive(childSessionId);
                this.store.db
                  .prepare(
                    `INSERT INTO direct_messages(
                      sessionId, turnId, role, content, toolCallId, toolName, meta, createdAt
                    ) VALUES(?,?,'tool',?,?,?,?,?)`,
                  )
                  .run(
                    childSessionId,
                    turnId,
                    excerpt(output, 16000),
                    tc.id,
                    tc.name,
                    JSON.stringify({ isError, durationMs }),
                    Date.now(),
                  );
              });
            },
          });

          if (!state.paused && result.status === 'reconciling') {
            throw new RecoveryError('RECONCILIATION_REQUIRED', {
              message: result.errorMessage || 'Child turn requires reconciliation before completion',
              detail: {
                verdict: result.verdict,
                usage: result.usage,
                steps: result.steps,
              },
            });
          }

          if (!state.paused && result.status === 'failed') {
            const ErrCtor = isBudgetErrorCode(result.errorCode) ? BudgetError : RuntimeError;
            throw new ErrCtor(result.errorCode || 'VERIFICATION_FAILED', {
              message: result.errorMessage || 'Child turn failed verification',
              detail: {
                verdict: result.verdict,
                stopReason: result.stopReason,
                usage: result.usage,
                steps: result.steps,
                verifiedPass: result.verifiedPass,
                failureKind: result.failureKind,
              },
            });
          }

          // Re-verify ancestor liveness before archiving worktree or committing completion!
          if (!state.paused) {
            this.#assertAncestorsActive(childSessionId);
          }

          // Fix C1/C5/C10: Persist & register isolated worktree artifacts BEFORE marking completed!
          const diffSummary = wt ? await wt.diffSummary() : '';
          if (isIsolated && wt && !state.paused && this.artifactManager && runId && nodeKey) {
            archivedArtifact = await this.artifactManager.archiveWorktree({
              runId,
              nodeId: nodeId || nodeKey,
              nodeKey,
              childSessionId,
              childTurnId: turnId,
              jobId: turnLeaseGuard?.jobId ?? null,
              attempt,
              ownerId: childSessionId,
              fence: turnLeaseGuard?.fence ?? null,
              workspaceRoot,
              worktreePath: wt.path,
              worktreeLeaseId: wt.leaseId,
              baseCommit: wt.baseCommit,
              baseRef: wt.baseRef,
              leaseGuard: turnLeaseGuard,
            });
          }

          const nextState = state.paused ? 'paused' : 'completed';
          const finAt = Date.now();
          const verdictJson = result.verdict ? JSON.stringify(result.verdict) : null;
          const evidenceCount = Number(result.verdict?.evidenceCount ?? 0);
          const payload = {
            subagentId: subId,
            childSessionId,
            turnId,
            role: profile?.name || 'worker',
            summary: excerpt(result.text || '', 500),
            text: result.text || '',
            verdict: result.verdict ?? null,
            resumeMode,
            ...(archivedArtifact
              ? { artifactId: archivedArtifact.id, artifactUri: archivedArtifact.uri }
              : {}),
          };

          // Fix D5/D7: Enforce fence/attempt ownership, ancestor liveness & terminal protection atomically inside DB commit
          const committed = this.store.tx(() => {
            assertLeaseInTx(turnLeaseGuard);
            if (!state.paused) {
              this.#assertAncestorsActive(childSessionId);
            }
            const turnRes = this.store.db
              .prepare(
                `UPDATE direct_turns
                 SET state=?, phase=?, inputTokens=?, outputTokens=?, step=?, verdictJson=?, evidenceCount=?, finishedAt=?, activeFence=NULL
                 WHERE id=? AND state NOT IN ('completed','failed','cancelled')`,
              )
              .run(
                nextState,
                nextState,
                result.usage?.inputTokens ?? 0,
                result.usage?.outputTokens ?? 0,
                result.steps ?? 0,
                verdictJson,
                evidenceCount,
                nextState === 'paused' ? null : finAt,
                turnId,
              );
            if ((turnRes.changes ?? 0) === 0) return false;
            this.store.db
              .prepare(
                "UPDATE direct_sessions SET state=?, updatedAt=? WHERE id=? AND state NOT IN ('cancelled','completed')",
              )
              .run(nextState, finAt, childSessionId);
            this.#recordChildUsageInTx({
              sessionId: childSessionId,
              runId,
              provider,
              model: resolvedModel,
              inputTokens: result.usage?.inputTokens ?? 0,
              outputTokens: result.usage?.outputTokens ?? 0,
              durationMs: finAt - turnStartedAt,
              trafficSource,
              isSynthetic,
              now: finAt,
            });
            this.#persistNotificationInTx({
              parentSessionId,
              childSessionId,
              runId,
              nodeKey,
              status: nextState,
              payload,
              jobId: turnLeaseGuard?.jobId ?? null,
              fence: turnLeaseGuard?.fence ?? null,
              attempt,
            });
            return true;
          });

          if (committed) {
            try {
              this.eventRouter?.emitPersisted({
                sessionId: parentSessionId,
                turnId: parentTurnId,
                type: RUNTIME_EVENTS.SUBAGENT_COMPLETED,
                data: payload,
                audit: false,
              });
            } catch {
              // best-effort event emit after commit
            }
          }

          return {
            childSessionId,
            childTurnId: turnId,
            subagentId: subId,
            status: nextState,
            text: result.text || '',
            usage: result.usage,
            steps: result.steps,
            verdict: result.verdict ?? null,
            verifiedPass: result.verifiedPass ?? null,
            diffSummary,
            artifact: archivedArtifact,
          };
        } catch (err) {
          // Graceful runtime shutdown is an interruption, NOT user cancellation or failure — preserve state & dirty worktree!
          const isShutdown = Boolean(
            state.shuttingDown ||
              this.shuttingDown ||
              combinedSignal.reason === 'shutdown' ||
              externalSignal?.reason === 'shutdown' ||
              controller.signal.reason === 'shutdown',
          );
          if (isShutdown) {
            shuttingDownTurn = true;
            throw err;
          }

          // Fix D6: On LEASE_LOST (or if lease was already lost), exit cleanly without corrupting new owner!
          if (isLeaseLostError(err) || !checkLeaseHeld(turnLeaseGuard)) {
            leaseLost = true;
            throw isLeaseLostError(err)
              ? err
              : new RecoveryError('LEASE_LOST', {
                  message: `Lease lost during child turn ${turnId}`,
                  cause: err,
                });
          }

          const nextState = state.paused
            ? 'paused'
            : err?.code === 'RECONCILIATION_REQUIRED'
              ? 'reconciling'
              : combinedSignal.aborted || err?.category === 'cancellation'
                ? 'cancelled'
                : 'failed';
          explicitCancel = nextState === 'cancelled';

          const failPayload = {
            subagentId: subId,
            childSessionId,
            turnId,
            errorCode: err?.code || 'CHILD_FAILED',
            error: String(err?.detail?.message ?? err?.message ?? err),
            verdict: err?.detail?.verdict ?? null,
            paused: state.paused,
          };

          let committed = false;
          if (this.store?.db?.isOpen) {
            const errAt = Date.now();
            const errVerdictJson = err?.detail?.verdict ? JSON.stringify(err.detail.verdict) : null;
            const partialIn = Number(err?.usage?.inputTokens ?? err?.detail?.usage?.inputTokens ?? 0);
            const partialOut = Number(err?.usage?.outputTokens ?? err?.detail?.usage?.outputTokens ?? 0);
            const partialSteps = Number(err?.steps ?? err?.detail?.steps ?? 0);
            try {
              committed = this.store.tx(() => {
                assertLeaseInTx(turnLeaseGuard);
                const turnRes = this.store.db
                  .prepare(
                    `UPDATE direct_turns
                     SET state=?, phase=?, error=?,
                         inputTokens=MAX(inputTokens, ?),
                         outputTokens=MAX(outputTokens, ?),
                         step=MAX(step, ?),
                         verdictJson=COALESCE(?, verdictJson),
                         finishedAt=?, activeFence=NULL
                     WHERE id=? AND state NOT IN ('completed','failed','cancelled')`,
                  )
                  .run(
                    nextState,
                    nextState,
                    String(err?.detail?.message ?? err?.message ?? err).slice(0, 500),
                    partialIn,
                    partialOut,
                    partialSteps,
                    errVerdictJson,
                    nextState === 'reconciling' || nextState === 'paused' ? null : errAt,
                    turnId,
                  );
                if ((turnRes.changes ?? 0) === 0) return false;
                this.store.db
                  .prepare(
                    "UPDATE direct_sessions SET state=?, updatedAt=? WHERE id=? AND state NOT IN ('completed','cancelled')",
                  )
                  .run(nextState, errAt, childSessionId);
                this.#recordChildUsageInTx({
                  sessionId: childSessionId,
                  runId,
                  provider,
                  model: resolvedModel,
                  inputTokens: partialIn,
                  outputTokens: partialOut,
                  durationMs: errAt - turnStartedAt,
                  trafficSource,
                  isSynthetic,
                  now: errAt,
                });
                this.#persistNotificationInTx({
                  parentSessionId,
                  childSessionId,
                  runId,
                  nodeKey,
                  status: nextState,
                  payload: failPayload,
                  jobId: turnLeaseGuard?.jobId ?? null,
                  fence: turnLeaseGuard?.fence ?? null,
                  attempt,
                });
                return true;
              });
            } catch (txErr) {
              if (isLeaseLostError(txErr)) {
                leaseLost = true;
                throw txErr;
              }
              throw txErr;
            }
          }
          if (committed) {
            try {
              this.eventRouter?.emitPersisted({
                sessionId: parentSessionId,
                turnId: parentTurnId,
                type: RUNTIME_EVENTS.SUBAGENT_FAILED,
                data: failPayload,
                audit: false,
              });
            } catch {
              // best-effort event emit
            }
          }
          throw err;
        } finally {
          this.activeChildren.delete(childSessionId);
          if (wt) {
            if (leaseLost) {
              // Stale worker MUST NOT touch disk when lease was lost; detach handle only
              this.worktreeIsolator?.active?.delete?.(wt.leaseId);
            } else {
              // P1-3: Isolate worktree cleanup errors so cleanup failure NEVER masks a committed turn completion!
              try {
                await wt.release({
                  archivedArtifactId: archivedArtifact?.id ?? null,
                  forceDiscard: explicitCancel,
                  preserveDirty: true,
                  leaseGuard: explicitCancel || shuttingDownTurn ? null : baseLeaseGuard,
                });
              } catch {
                // preserved worktree or cleanup error is already tracked in worktree_leases; do not crash caller
              }
            }
          }
        }
      },
    );
  }

  async spawn({
    parentSessionId,
    parentTurnId = null,
    objective,
    profile = null,
    model = null,
    provider = 'pool',
    permissionMode = 'auto-safe',
    parentPermissionMode = 'auto-safe',
    allowedTools = null,
    parentAllowTools = null,
    parentDenyTools = ['spawn_subagent'],
    budget = {},
    workspaceRoot,
    isolatedWorktree = false,
    isolationMode = null,
    allowIsolationFallback = false,
    runId = null,
    nodeId = null,
    nodeKey = null,
    attempt = 1,
    workerId = null,
    predecessorArtifacts = [],
    rehydrateFromArtifactId = null,
    ackMailboxIds = [],
    budgetLedger = null,
    budgetScope = BUDGET_SCOPES.NODE_EXECUTION,
    existingChildSessionId = null,
    resumeTurnId = null,
    initialStep = 0,
    leaseGuard = null,
    extraMessages = [],
    signal = undefined,
    trafficSource = null,
    isSynthetic = undefined,
  }) {
    const parentSess = parentSessionId ? this.sessionRepo.getSession(parentSessionId) : null;
    this.#assertAncestorsActive(parentSessionId);
    const requestedMode =
      isolationMode ||
      (isolatedWorktree ? ISOLATION_MODES.WORKTREE : ISOLATION_MODES.SHARED_READONLY);
    const existingChild = existingChildSessionId
      ? this.sessionRepo.getSession(existingChildSessionId)
      : null;
    const effectiveParentAllow = intersectAllowlists(parentSess?.toolAllow, parentAllowTools);
    const effectiveChildAllow = intersectAllowlists(allowedTools, existingChild?.toolAllow);
    // Always intersect caller-supplied parentPermissionMode with live parentSess.permissionMode so a caller can never widen parent authority
    const effectiveParentMode =
      parentSess?.permissionMode && parentPermissionMode
        ? intersectPolicies(
            { permissionMode: parentSess.permissionMode },
            { permissionMode: parentPermissionMode },
          ).permissionMode
        : parentSess?.permissionMode || parentPermissionMode || 'auto-safe';
    const effectivePolicy = intersectPolicies(
      {
        permissionMode: effectiveParentMode,
        allowTools: effectiveParentAllow,
        denyTools: [...new Set([...(parentSess?.toolDeny ?? []), ...(parentDenyTools ?? [])])],
      },
      {
        permissionMode,
        allowTools: effectiveChildAllow,
        denyTools: existingChild?.toolDeny ?? [],
      },
    );
    const resolvedModel = model || parentSess?.model || this.getDefaultModel();
    const resolvedTrafficSource = trafficSource || parentSess?.trafficSource || 'production';
    const resolvedIsSynthetic =
      isSynthetic !== undefined ? (isSynthetic ? 1 : 0) : parentSess?.isSynthetic ? 1 : 0;
    const child = existingChild
      ? existingChild
      : this.sessionRepo.createSession({
          title: `子任务: ${String(objective).slice(0, 60)}`,
          model: resolvedModel,
          workspaceRoot: workspaceRoot || parentSess?.workspaceRoot,
          mode: 'direct',
          permissionMode:
            requestedMode === ISOLATION_MODES.SHARED_READONLY
              ? 'read-only'
              : effectivePolicy.permissionMode,
          parentSessionId,
          rootSessionId: parentSess?.rootSessionId || parentSessionId,
          agentProfile: profile?.id || 'subagent',
          budget,
          toolAllow: effectivePolicy.allowTools,
          toolDeny: effectivePolicy.denyTools,
        });

    return this.#runChildTurn({
      parentSessionId,
      parentTurnId,
      childSessionId: child.id,
      objective,
      profile,
      model: resolvedModel,
      provider,
      policy: effectivePolicy,
      workspaceRoot: workspaceRoot || child.workspaceRoot,
      isolatedWorktree,
      isolationMode: requestedMode,
      allowIsolationFallback,
      runId,
      nodeId,
      nodeKey,
      attempt,
      workerId,
      predecessorArtifacts,
      rehydrateFromArtifactId,
      ackMailboxIds,
      budget,
      budgetLedger,
      budgetScope,
      leaseGuard,
      initialStep,
      resumeTurnId,
      externalSignal: signal,
      extraUserMessages: extraMessages,
      trafficSource: resolvedTrafficSource,
      isSynthetic: resolvedIsSynthetic,
    });
  }

  async fork({
    parentSessionId,
    parentTurnId = null,
    objective,
    profile = null,
    model = null,
    provider = 'pool',
    permissionMode = 'auto-safe',
    parentPermissionMode = null,
    allowedTools = null,
    parentAllowTools = null,
    budget = {},
    workspaceRoot = null,
    isolatedWorktree = false,
    isolationMode = null,
    allowIsolationFallback = false,
    signal = undefined,
  }) {
    this.#assertAncestorsActive(parentSessionId);
    const depth = this.#computeDepth(parentSessionId);
    if (depth >= MAX_FORK_DEPTH) {
      throw new Fault('RECURSIVE_FORK_BLOCKED', 400, {
        message: `Recursive fork depth ${depth} exceeds limit (${MAX_FORK_DEPTH})`,
      });
    }
    const parentSess = this.sessionRepo.getSession(parentSessionId);
    const parentNonce = this.sessionRepo.ensureSessionNonce(parentSessionId);
    const effectiveParentAllow = intersectAllowlists(parentSess?.toolAllow, parentAllowTools);
    const effectiveParentMode =
      parentSess?.permissionMode && parentPermissionMode
        ? intersectPolicies(
            { permissionMode: parentSess.permissionMode },
            { permissionMode: parentPermissionMode },
          ).permissionMode
        : parentSess?.permissionMode || parentPermissionMode || 'auto-safe';
    const effectivePolicy = intersectPolicies(
      {
        permissionMode: effectiveParentMode,
        allowTools: effectiveParentAllow,
        denyTools: [...new Set([...(parentSess?.toolDeny ?? []), 'spawn_subagent'])],
      },
      { permissionMode, allowTools: allowedTools },
    );
    const resolvedModel = model || parentSess.model || this.getDefaultModel();
    const child = this.sessionRepo.createSession({
      title: `Fork: ${String(objective).slice(0, 60)}`,
      model: resolvedModel,
      workspaceRoot: workspaceRoot || parentSess.workspaceRoot,
      mode: 'direct',
      permissionMode: effectivePolicy.permissionMode,
      parentSessionId,
      rootSessionId: parentSess.rootSessionId || parentSessionId,
      agentProfile: `fork:${profile?.id || 'worker'}`,
      budget,
      toolAllow: effectivePolicy.allowTools,
      toolDeny: effectivePolicy.denyTools,
    });

    const parentMsgs = this.store.db
      .prepare('SELECT turnId, role, content, reasoning, toolCalls, toolCallId, toolName, meta, createdAt FROM direct_messages WHERE sessionId=? ORDER BY seq ASC')
      .all(parentSessionId);
    this.store.tx(() => {
      this.store.db.prepare('UPDATE direct_sessions SET nonce=? WHERE id=?').run(parentNonce, child.id);
      const ins = this.store.db.prepare(
        `INSERT INTO direct_messages(
          sessionId, turnId, role, content, reasoning, toolCalls, toolCallId, toolName, meta, createdAt
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const m of parentMsgs) {
        ins.run(
          child.id,
          m.turnId,
          m.role,
          m.content,
          m.reasoning,
          m.toolCalls,
          m.toolCallId,
          m.toolName,
          m.meta,
          m.createdAt,
        );
      }
    });
    this.contextAssembler.forkTailFrom?.(parentSessionId, child.id);

    return this.#runChildTurn({
      parentSessionId,
      parentTurnId,
      childSessionId: child.id,
      objective,
      profile,
      model: resolvedModel,
      provider,
      policy: effectivePolicy,
      workspaceRoot: child.workspaceRoot,
      isolatedWorktree,
      isolationMode,
      allowIsolationFallback,
      budget,
      externalSignal: signal,
      trafficSource: parentSess?.trafficSource || 'production',
      isSynthetic: parentSess?.isSynthetic ? 1 : 0,
    });
  }

  pause(childSessionId) {
    const active = this.activeChildren.get(childSessionId);
    if (active) {
      active.paused = true;
      active.controller.abort('paused');
    }
    if (this.store?.db?.isOpen) {
      this.store.tx(() => {
        this.store.db
          .prepare(
            "UPDATE direct_sessions SET state='paused', updatedAt=? WHERE id=? AND state != 'cancelled'",
          )
          .run(Date.now(), childSessionId);
      });
    }
    return this.collect(childSessionId);
  }

  async resume(
    childSessionId,
    {
      objective = '继续执行任务',
      model = null,
      maxSteps = 8,
      signal = undefined,
      callerSessionId = null,
    } = {},
  ) {
    const child = this.sessionRepo.getSession(childSessionId);
    if (child.state === 'cancelled') {
      throw new Fault('SESSION_CANCELLED', 409, {
        message: `Cancelled child session ${childSessionId} cannot be resumed`,
      });
    }
    if (callerSessionId && callerSessionId !== childSessionId && !this.#isDescendantOf(childSessionId, callerSessionId)) {
      throw new Fault('FORBIDDEN_CHILD_ACCESS', 403, {
        message: `Session ${callerSessionId} is not an ancestor of child session ${childSessionId}`,
      });
    }
    const parentSess = child.parentSessionId ? this.sessionRepo.getSession(child.parentSessionId) : null;
    this.#assertAncestorsActive(childSessionId);
    const effectivePolicy = intersectPolicies(
      {
        permissionMode: parentSess?.permissionMode || child.permissionMode || 'auto-safe',
        allowTools: parentSess?.toolAllow ?? null,
        denyTools: [...new Set([...(parentSess?.toolDeny ?? []), 'spawn_subagent'])],
      },
      {
        permissionMode: child.permissionMode || 'auto-safe',
        allowTools: child.toolAllow,
        denyTools: child.toolDeny ?? [],
      },
    );
    return this.#runChildTurn({
      parentSessionId: child.parentSessionId || childSessionId,
      parentTurnId: null,
      childSessionId,
      objective,
      profile: { id: child.agentProfile, defaultMaxSteps: maxSteps },
      model: model || child.model || this.getDefaultModel(),
      policy: effectivePolicy,
      workspaceRoot: child.workspaceRoot,
      budget: { ...(parseJsonSafe(child.budgetJson, {}) || {}), maxSteps },
      externalSignal: signal,
      resumeMode: true,
      trafficSource: child.trafficSource || parentSess?.trafficSource || 'production',
      isSynthetic: child.isSynthetic || parentSess?.isSynthetic ? 1 : 0,
    });
  }

  interrupt(childSessionId) {
    return this.pause(childSessionId);
  }

  cancel(childSessionId) {
    const active = this.activeChildren.get(childSessionId);
    if (active) {
      active.paused = false;
      active.controller.abort('cancelled');
    }
    if (this.store?.db?.isOpen) {
      const now = Date.now();
      this.store.tx(() => {
        this.store.db
          .prepare("UPDATE direct_sessions SET state='cancelled', updatedAt=? WHERE id=?")
          .run(now, childSessionId);
        this.store.db
          .prepare(
            "UPDATE direct_turns SET state='cancelled', phase='cancelled', finishedAt=? WHERE sessionId=? AND state IN ('running','reconciling','parked','paused')",
          )
          .run(now, childSessionId);
      });
      this.jobQueue?.cancelBySession?.(childSessionId);
    }
    for (const nested of this.sessionRepo.listChildSessions(childSessionId)) {
      this.cancel(nested.id);
    }
    return this.collect(childSessionId);
  }

  cancelDescendants(parentSessionId) {
    for (const child of this.sessionRepo.listChildSessions(parentSessionId)) {
      this.cancel(child.id);
    }
  }

  collect(childSessionId) {
    const sess = this.sessionRepo.getSession(childSessionId);
    const lastAssistant = this.store.db
      .prepare(
        "SELECT content, createdAt FROM direct_messages WHERE sessionId=? AND role='assistant' ORDER BY seq DESC LIMIT 1",
      )
      .get(childSessionId);
    const turns = this.store.db
      .prepare('SELECT id, state, inputTokens, outputTokens, finishedAt FROM direct_turns WHERE sessionId=? ORDER BY createdAt DESC LIMIT 5')
      .all(childSessionId);
    return {
      session: sess,
      turns,
      lastMessage: lastAssistant?.content ?? null,
    };
  }

  shutdown() {
    this.shuttingDown = true;
    for (const active of this.activeChildren.values()) {
      active.paused = false;
      active.shuttingDown = true;
      active.controller.abort('shutdown');
    }
  }

  cancelAll() {
    for (const id of [...this.activeChildren.keys()]) {
      this.cancel(id);
    }
  }
}
