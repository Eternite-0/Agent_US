import { Fault, id as uuid } from '../store.js';
import { excerpt } from '../context.js';
import { CancellationError } from '../kernel/errors.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import { intersectPolicies } from '../tools/policy.js';
import { ISOLATION_MODES } from '../tools/sandbox.js';
import { WORKSPACE_TOOL_META } from '../workspace-tools.js';

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
    jobQueue = null,
    getWorkspaceTools,
    getDefaultModel,
  }) {
    this.store = store;
    this.kernel = kernel;
    this.sessionRepo = sessionRepo;
    this.contextAssembler = contextAssembler;
    this.eventRouter = eventRouter;
    this.worktreeIsolator = worktreeIsolator;
    this.jobQueue = jobQueue;
    this.getWorkspaceTools = getWorkspaceTools;
    this.getDefaultModel = getDefaultModel;
    this.activeChildren = new Map(); // childSessionId -> { controller, parentSessionId, paused, model }
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

  #clampChildBudget(parentSessionId, requestedBudget = {}) {
    const out = { ...requestedBudget };
    if (!parentSessionId || !this.store?.db?.isOpen) return out;
    const parent = this.sessionRepo.getSession(parentSessionId);
    const parentBudget = parent?.budget ?? null;
    if (!parentBudget || typeof parentBudget !== 'object') return out;

    const rootId = parent.rootSessionId || parentSessionId;
    const treeIds = [rootId, ...this.#collectDescendantIds(rootId)];
    const ph = treeIds.map(() => '?').join(',');
    const usedRow = this.store.db
      .prepare(
        `SELECT COALESCE(SUM(inputTokens + outputTokens), 0) AS usedTokens,
                COALESCE(SUM(step), 0) AS usedSteps
         FROM direct_turns WHERE sessionId IN (${ph})`,
      )
      .get(...treeIds);

    if (parentBudget.maxTokens > 0) {
      const remaining = Math.max(0, Number(parentBudget.maxTokens) - Number(usedRow?.usedTokens ?? 0));
      out.maxTokens =
        out.maxTokens > 0 ? Math.min(Number(out.maxTokens), remaining) : remaining;
    }
    if (parentBudget.maxSteps > 0) {
      const remainingSteps = Math.max(1, Number(parentBudget.maxSteps) - Number(usedRow?.usedSteps ?? 0));
      out.maxSteps =
        out.maxSteps > 0 ? Math.min(Number(out.maxSteps), remainingSteps) : remainingSteps;
    }
    return out;
  }

  #resolveTools({
    workspaceRoot,
    sessionId,
    policy,
    nonce,
    signal,
    isolatedWorktree,
    isChild = true,
  }) {
    const allTools = this.getWorkspaceTools({
      workspaceRoot,
      sessionId,
      permissionMode: policy.permissionMode,
      nonce,
      signal,
    });
    const denySet = new Set(policy.denyTools ?? []);
    if (isChild) denySet.add('spawn_subagent');

    let filtered = allTools.filter((t) => !denySet.has(t.name));
    if (Array.isArray(policy.allowTools) && policy.allowTools.length) {
      const allowSet = new Set(policy.allowTools);
      filtered = filtered.filter((t) => allowSet.has(t.name));
    }
    if (policy.permissionMode === 'read-only' && !isolatedWorktree) {
      filtered = filtered.filter(
        (t) => Boolean(t.meta?.readOnly ?? WORKSPACE_TOOL_META[t.name]?.readOnly),
      );
    }
    return filtered;
  }

  #persistNotification({ parentSessionId, childSessionId, runId = null, nodeKey = null, status, payload }) {
    if (!parentSessionId || !this.store?.db?.isOpen) return null;
    const notifId = uuid();
    const now = Date.now();
    const idem = `notify:${childSessionId}:${status}:${payload?.turnId || ''}`;
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT OR IGNORE INTO child_notifications(
            id, idempotencyKey, parentSessionId, childSessionId, runId, nodeKey,
            status, payloadJson, delivered, createdAt
          ) VALUES(?,?,?,?,?,?,?,?,0,?)`,
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
          now,
        );
    });
    return this.store.db
      .prepare('SELECT * FROM child_notifications WHERE idempotencyKey=?')
      .get(idem);
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
    nodeKey = null,
    budget = {},
    leaseGuard = null,
    initialStep = 0,
    resumeTurnId = null,
    externalSignal = undefined,
    extraUserMessages = [],
    resumeMode = false,
  }) {
    this.#assertAncestorsActive(parentSessionId);
    const effectiveBudget = this.#clampChildBudget(parentSessionId, budget);

    const subId = `sub_${childSessionId.slice(0, 8)}`;
    const controller = new AbortController();
    const combinedSignal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal;
    const state = {
      controller,
      parentSessionId,
      paused: false,
      model,
      runId,
      nodeKey,
    };
    this.activeChildren.set(childSessionId, state);

    const requestedMode =
      isolationMode ||
      (isolatedWorktree ? ISOLATION_MODES.WORKTREE : ISOLATION_MODES.SHARED_READONLY);

    let wt = null;
    let effectiveRoot = workspaceRoot;
    let effectivePolicy = { ...policy };
    let isIsolated = false;

    if (requestedMode === ISOLATION_MODES.WORKTREE) {
      if (!this.worktreeIsolator) {
        if (!allowIsolationFallback) {
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
            sessionId: childSessionId,
            runId,
            nodeKey,
          });
          effectiveRoot = wt.path;
          isIsolated = true;
        } catch (wtErr) {
          if (!allowIsolationFallback) {
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

    const turnId = resumeTurnId || `${parentTurnId || 'root'}:${subId}:${Date.now().toString(36)}`;
    const maxSteps = Math.min(20, Math.max(1, Number(effectiveBudget.maxSteps ?? profile?.defaultMaxSteps ?? 8)));
    const resolvedModel = model || this.getDefaultModel();

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
      },
      audit: false,
    });

    try {
      const now = Date.now();
      this.store.tx(() => {
        this.store.db
          .prepare("UPDATE direct_sessions SET state='running', permissionMode=?, updatedAt=? WHERE id=?")
          .run(effectivePolicy.permissionMode, now, childSessionId);
        if (!resumeTurnId) {
          this.store.db
            .prepare(
              `INSERT OR IGNORE INTO direct_turns(
                id, sessionId, input, model, state, phase, step, agentProfile, createdAt
              ) VALUES(?,?,?,?,'running','init',?,?,?)`,
            )
            .run(
              turnId,
              childSessionId,
              String(objective || '').slice(0, 2000),
              resolvedModel,
              initialStep,
              profile?.id || 'subagent',
              now,
            );
          if (objective) {
            this.store.db
              .prepare(
                'INSERT INTO direct_messages(sessionId, turnId, role, content, createdAt) VALUES(?,?,?,?,?)',
              )
              .run(childSessionId, turnId, 'user', objective, now);
          }
        } else {
          this.store.db
            .prepare("UPDATE direct_turns SET state='running', phase='checkpoint' WHERE id=?")
            .run(turnId);
        }
        if (runId && nodeKey) {
          this.store.db
            .prepare(
              'UPDATE swarm_nodes SET childSessionId=?, childTurnId=?, updatedAt=? WHERE runId=? AND nodeKey=?',
            )
            .run(childSessionId, turnId, now, runId, nodeKey);
        }
      });

      const session = this.sessionRepo.getSession(childSessionId);
      const nonce = this.sessionRepo.ensureSessionNonce(childSessionId);
      const tools = this.#resolveTools({
        workspaceRoot: effectiveRoot,
        sessionId: childSessionId,
        policy: effectivePolicy,
        nonce,
        signal: combinedSignal,
        isolatedWorktree: isIsolated,
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

      const kernelProfile = this.kernel.getProfile('swarm_worker') ?? this.kernel.getProfile('subagent');
      const result = await this.kernel.executeTurn({
        sessionId: childSessionId,
        turnId,
        parentEpochId: parentTurnId,
        externalSignal: combinedSignal,
        workspaceRoot: effectiveRoot,
        leaseGuard,
        parentGuard: () => this.#assertAncestorsActive(childSessionId),
        initialStep,
        profile: {
          ...kernelProfile,
          persistTurn: true,
          streamDeltas: false,
          emitAssistantMessage: false,
          emitToolEvents: false,
        },
        input: objective,
        model: resolvedModel,
        provider,
        permissionMode: effectivePolicy.permissionMode,
        messages: assembled.messages,
        tools,
        budget: {
          maxSteps,
          maxOutputTokens: Number(effectiveBudget.maxOutputTokens ?? 2048),
          maxTokens: effectiveBudget.maxTokens,
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

      const nextState = state.paused ? 'paused' : 'completed';
      const finAt = Date.now();
      this.store.tx(() => {
        this.store.db
          .prepare('UPDATE direct_sessions SET state=?, updatedAt=? WHERE id=?')
          .run(nextState, finAt, childSessionId);
        this.store.db
          .prepare(
            `UPDATE direct_turns
             SET state=?, inputTokens=?, outputTokens=?, step=?, finishedAt=?
             WHERE id=?`,
          )
          .run(
            nextState,
            result.usage?.inputTokens ?? 0,
            result.usage?.outputTokens ?? 0,
            result.steps ?? 0,
            finAt,
            turnId,
          );
      });

      const payload = {
        subagentId: subId,
        childSessionId,
        turnId,
        role: profile?.name || 'worker',
        summary: excerpt(result.text || '', 500),
        text: result.text || '',
        resumeMode,
      };
      this.#persistNotification({
        parentSessionId,
        childSessionId,
        runId,
        nodeKey,
        status: nextState,
        payload,
      });
      this.eventRouter?.emitPersisted({
        sessionId: parentSessionId,
        turnId: parentTurnId,
        type: RUNTIME_EVENTS.SUBAGENT_COMPLETED,
        data: payload,
        audit: false,
      });

      return {
        childSessionId,
        childTurnId: turnId,
        subagentId: subId,
        text: result.text || '',
        usage: result.usage,
        steps: result.steps,
        diffSummary: wt ? await wt.diffSummary() : '',
      };
    } catch (err) {
      const nextState = state.paused
        ? 'paused'
        : err?.code === 'RECONCILIATION_REQUIRED'
          ? 'reconciling'
          : combinedSignal.aborted || err?.category === 'cancellation'
            ? 'cancelled'
            : 'failed';
      if (this.store?.db?.isOpen) {
        const errAt = Date.now();
        this.store.tx(() => {
          this.store.db
            .prepare('UPDATE direct_sessions SET state=?, updatedAt=? WHERE id=?')
            .run(nextState, errAt, childSessionId);
          this.store.db
            .prepare("UPDATE direct_turns SET state=?, error=?, finishedAt=? WHERE id=? AND state NOT IN ('completed','cancelled')")
            .run(nextState, String(err?.message ?? err).slice(0, 500), errAt, turnId);
        });
      }
      const failPayload = {
        subagentId: subId,
        childSessionId,
        turnId,
        errorCode: err?.code || 'CHILD_FAILED',
        error: String(err?.message ?? err),
        paused: state.paused,
      };
      this.#persistNotification({
        parentSessionId,
        childSessionId,
        runId,
        nodeKey,
        status: nextState,
        payload: failPayload,
      });
      this.eventRouter?.emitPersisted({
        sessionId: parentSessionId,
        turnId: parentTurnId,
        type: RUNTIME_EVENTS.SUBAGENT_FAILED,
        data: failPayload,
        audit: false,
      });
      throw err;
    } finally {
      this.activeChildren.delete(childSessionId);
      if (wt) await wt.release();
    }
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
    nodeKey = null,
    existingChildSessionId = null,
    resumeTurnId = null,
    initialStep = 0,
    leaseGuard = null,
    extraMessages = [],
    signal = undefined,
  }) {
    const parentSess = parentSessionId ? this.sessionRepo.getSession(parentSessionId) : null;
    this.#assertAncestorsActive(parentSessionId);
    const requestedMode =
      isolationMode ||
      (isolatedWorktree ? ISOLATION_MODES.WORKTREE : ISOLATION_MODES.SHARED_READONLY);
    const effectivePolicy = intersectPolicies(
      {
        permissionMode: parentPermissionMode || parentSess?.permissionMode || 'auto-safe',
        allowTools: parentAllowTools,
        denyTools: parentDenyTools,
      },
      { permissionMode, allowTools: allowedTools },
    );
    const resolvedModel = model || parentSess?.model || this.getDefaultModel();
    const child = existingChildSessionId
      ? this.sessionRepo.getSession(existingChildSessionId)
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
      nodeKey,
      budget,
      leaseGuard,
      initialStep,
      resumeTurnId,
      externalSignal: signal,
      extraUserMessages: extraMessages,
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
    const effectivePolicy = intersectPolicies(
      { permissionMode: parentPermissionMode || parentSess.permissionMode || 'auto-safe', denyTools: ['spawn_subagent'] },
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
    });
  }

  pause(childSessionId) {
    const active = this.activeChildren.get(childSessionId);
    if (active) {
      active.paused = true;
      active.controller.abort('paused');
    }
    this.store.tx(() => {
      this.store.db
        .prepare("UPDATE direct_sessions SET state='paused', updatedAt=? WHERE id=?")
        .run(Date.now(), childSessionId);
    });
    return this.collect(childSessionId);
  }

  async resume(childSessionId, { objective = '继续执行任务', model = null, maxSteps = 8, signal = undefined } = {}) {
    const child = this.sessionRepo.getSession(childSessionId);
    const parentSess = child.parentSessionId ? this.sessionRepo.getSession(child.parentSessionId) : null;
    this.#assertAncestorsActive(child.parentSessionId);
    const effectivePolicy = intersectPolicies(
      { permissionMode: parentSess?.permissionMode || child.permissionMode || 'auto-safe', denyTools: ['spawn_subagent'] },
      { permissionMode: child.permissionMode || 'auto-safe' },
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
          .prepare("UPDATE direct_turns SET state='cancelled', phase='cancelled', finishedAt=? WHERE sessionId=? AND state IN ('running','reconciling','parked')")
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
    for (const active of this.activeChildren.values()) {
      active.paused = false;
      active.controller.abort('shutdown');
    }
  }

  cancelAll() {
    for (const id of [...this.activeChildren.keys()]) {
      this.cancel(id);
    }
  }
}
