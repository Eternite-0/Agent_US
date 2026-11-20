import { Fault, id as uuid } from '../store.js';
import { excerpt } from '../context.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import { intersectPolicies } from '../tools/policy.js';
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
 * Layer 6 ChildAgentManager managing spawn, cache-safe fork, pause, resume,
 * interrupt, cancel cascade, permission-ceiling intersection, and worktree isolation.
 */
export class ChildAgentManager {
  constructor({
    store,
    kernel,
    sessionRepo,
    contextAssembler,
    eventRouter,
    worktreeIsolator,
    getWorkspaceTools,
    getDefaultModel,
  }) {
    this.store = store;
    this.kernel = kernel;
    this.sessionRepo = sessionRepo;
    this.contextAssembler = contextAssembler;
    this.eventRouter = eventRouter;
    this.worktreeIsolator = worktreeIsolator;
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
    budget = {},
    externalSignal = undefined,
    extraUserMessages = [],
    resumeMode = false,
  }) {
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
    };
    this.activeChildren.set(childSessionId, state);

    let wt = null;
    let effectiveRoot = workspaceRoot;
    if (isolatedWorktree && this.worktreeIsolator) {
      try {
        wt = await this.worktreeIsolator.acquire(workspaceRoot);
        effectiveRoot = wt.path;
      } catch {
        // Non-git workspace -> run safely in read-only or parent root
      }
    }

    const turnId = `${parentTurnId || 'root'}:${subId}:${Date.now().toString(36)}`;
    const maxSteps = Math.min(20, Math.max(1, Number(budget.maxSteps ?? profile?.defaultMaxSteps ?? 8)));
    this.eventRouter?.emitPersisted({
      sessionId: parentSessionId,
      turnId: parentTurnId,
      type: RUNTIME_EVENTS.SUBAGENT_STARTED,
      data: {
        subagentId: subId,
        childSessionId,
        role: profile?.name || profile?.id || 'worker',
        model,
        objective,
        isolatedWorktree: Boolean(wt),
      },
      audit: false,
    });

    try {
      this.store.tx(() => {
        this.store.db
          .prepare("UPDATE direct_sessions SET state='running', updatedAt=? WHERE id=?")
          .run(Date.now(), childSessionId);
        if (objective) {
          this.store.db
            .prepare(
              'INSERT INTO direct_messages(sessionId, turnId, role, content, createdAt) VALUES(?,?,?,?,?)',
            )
            .run(childSessionId, turnId, 'user', objective, Date.now());
        }
      });

      const session = this.sessionRepo.getSession(childSessionId);
      const nonce = this.sessionRepo.ensureSessionNonce(childSessionId);
      const tools = this.#resolveTools({
        workspaceRoot: effectiveRoot,
        sessionId: childSessionId,
        policy,
        nonce,
        signal: combinedSignal,
        isolatedWorktree: Boolean(wt),
      });

      const assembled = this.contextAssembler.assemble({
        session,
        turnId,
        nonce,
        profile: session.agentProfile?.startsWith('fork:') ? null : profile,
        workspaceRoot: effectiveRoot,
        mode: 'direct',
        permissionMode: policy.permissionMode,
      });
      if (session.agentProfile?.startsWith('fork:') && profile?.staticSystemInstruction) {
        assembled.messages.splice(-1, 0, {
          role: 'user',
          content: [{ type: 'text', text: `[Fork 子代理分工说明]\n${profile.staticSystemInstruction}` }],
        }, {
          role: 'assistant',
          content: [{ type: 'text', text: '收到分支任务分工说明。' }],
        });
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
        profile: {
          ...kernelProfile,
          persistTurn: false,
          streamDeltas: false,
          emitAssistantMessage: false,
          emitToolEvents: false,
        },
        input: objective,
        model: model || this.getDefaultModel(),
        provider,
        permissionMode: policy.permissionMode,
        messages: assembled.messages,
        tools,
        budget: {
          maxSteps,
          maxOutputTokens: Number(budget.maxOutputTokens ?? 2048),
          maxTokens: budget.maxTokens,
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
      this.store.tx(() => {
        this.store.db
          .prepare('UPDATE direct_sessions SET state=?, updatedAt=? WHERE id=?')
          .run(nextState, Date.now(), childSessionId);
      });

      this.eventRouter?.emitPersisted({
        sessionId: parentSessionId,
        turnId: parentTurnId,
        type: RUNTIME_EVENTS.SUBAGENT_COMPLETED,
        data: {
          subagentId: subId,
          childSessionId,
          role: profile?.name || 'worker',
          summary: excerpt(result.text || '', 500),
          resumeMode,
        },
        audit: false,
      });

      return {
        childSessionId,
        subagentId: subId,
        text: result.text || '',
        usage: result.usage,
        steps: result.steps,
        diffSummary: wt ? await wt.diffSummary() : '',
      };
    } catch (err) {
      const nextState = state.paused ? 'paused' : combinedSignal.aborted ? 'cancelled' : 'failed';
      if (this.store?.db?.isOpen) {
        this.store.tx(() => {
          this.store.db
            .prepare('UPDATE direct_sessions SET state=?, updatedAt=? WHERE id=?')
            .run(nextState, Date.now(), childSessionId);
        });
      }
      this.eventRouter?.emitPersisted({
        sessionId: parentSessionId,
        turnId: parentTurnId,
        type: RUNTIME_EVENTS.SUBAGENT_FAILED,
        data: {
          subagentId: subId,
          childSessionId,
          error: String(err?.message ?? err),
          paused: state.paused,
        },
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
    extraMessages = [],
    signal = undefined,
  }) {
    const parentSess = parentSessionId ? this.sessionRepo.getSession(parentSessionId) : null;
    const effectivePolicy = intersectPolicies(
      { permissionMode: parentPermissionMode || parentSess?.permissionMode || 'auto-safe', allowTools: parentAllowTools, denyTools: parentDenyTools },
      { permissionMode, allowTools: allowedTools },
    );
    const resolvedModel = model || parentSess?.model || this.getDefaultModel();
    const child = this.sessionRepo.createSession({
      title: `子任务: ${String(objective).slice(0, 60)}`,
      model: resolvedModel,
      workspaceRoot: workspaceRoot || parentSess?.workspaceRoot,
      mode: 'direct',
      permissionMode: effectivePolicy.permissionMode,
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
      workspaceRoot: child.workspaceRoot,
      isolatedWorktree,
      budget,
      externalSignal: signal,
      extraUserMessages: extraMessages,
    });
  }

  /**
   * Forks an existing session inheriting its pinned `nonce` and immutable message prefix
   * for zero-waste Prompt Cache reuse. Guards against recursive forks beyond MAX_FORK_DEPTH.
   */
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
    signal = undefined,
  }) {
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

    // Share parent's exact nonce & copy parent's immutable history prefix for Prompt Cache alignment
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
      this.store.tx(() => {
        this.store.db
          .prepare("UPDATE direct_sessions SET state='cancelled', updatedAt=? WHERE id=?")
          .run(Date.now(), childSessionId);
      });
    }
    for (const nested of this.sessionRepo.listChildSessions(childSessionId)) {
      this.cancel(nested.id);
    }
    return this.collect(childSessionId);
  }

  collect(childSessionId) {
    const sess = this.sessionRepo.getSession(childSessionId);
    const lastAssistant = this.store.db
      .prepare(
        "SELECT content, createdAt FROM direct_messages WHERE sessionId=? AND role='assistant' ORDER BY seq DESC LIMIT 1",
      )
      .get(childSessionId);
    return {
      session: sess,
      lastMessage: lastAssistant?.content ?? null,
    };
  }

  cancelAll() {
    for (const id of [...this.activeChildren.keys()]) {
      this.cancel(id);
    }
  }
}
