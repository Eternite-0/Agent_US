import { EventRouter } from './events.js';
import { CancellationManager } from './cancellation.js';
import { InferenceEngine } from './inference.js';
import { AgentLoop, DecisionEngine } from './agent-loop.js';
import { ToolValidationError } from './errors.js';
import { scheduleToolBatch } from '../patch-and-diagnostics.js';
import { WORKSPACE_TOOL_META } from '../workspace-tools.js';

/**
 * Built-in minimal ToolDispatcher used by Kernel when no P3 ToolDispatcher override is attached yet.
 */
export class DefaultKernelToolDispatcher {
  constructor({ eventRouter, store = null, reconciler = null }) {
    this.eventRouter = eventRouter;
    this.store = store;
    this.reconciler = reconciler;
  }

  async dispatchBatch({
    sessionId,
    turnId,
    toolCalls,
    tools,
    hooks = null,
    argStrikes = new Map(),
    signal,
    leaseGuard = null,
    verifierEvents = [],
    emitCallEvent = true,
  }) {
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    return scheduleToolBatch(
      toolCalls,
      (tc) => {
        const impl = toolMap.get(tc.name);
        if (typeof impl?.isConcurrencySafe === 'function') {
          try {
            return impl.isConcurrencySafe() === true;
          } catch {
            return false;
          }
        }
        return Boolean(impl?.meta?.readOnly ?? WORKSPACE_TOOL_META[tc.name]?.readOnly);
      },
      async (tc) => {
        signal?.throwIfAborted?.();
        leaseGuard?.();
        const toolImpl = toolMap.get(tc.name);
        let parsedArgs = null;
        let parseErr = null;
        try {
          parsedArgs =
            typeof tc.arguments === 'string'
              ? tc.arguments
                ? JSON.parse(tc.arguments)
                : {}
              : tc.arguments ?? {};
        } catch (err) {
          parseErr = String(err?.message ?? err);
        }

        if (emitCallEvent && this.eventRouter && sessionId) {
          this.eventRouter.emitPersisted({
            sessionId,
            turnId,
            type: 'tool/call',
            data: {
              turnId,
              sessionId,
              callId: tc.id,
              name: tc.name,
              arguments: parsedArgs ?? tc.arguments,
            },
            audit: false,
          });
        }
        verifierEvents.push({
          type: 'tool/call',
          data: { callId: tc.id, name: tc.name, arguments: parsedArgs ?? tc.arguments },
        });

        const tStart = Date.now();
        let output = '';
        let isError = false;
        let receipt = null;

        if (!toolImpl) {
          isError = true;
          output = `错误：未知工具「${tc.name}」。可用工具：${[...toolMap.keys()].join(', ')}`;
        } else if (parseErr) {
          const strikes = (argStrikes.get(tc.name) ?? 0) + 1;
          argStrikes.set(tc.name, strikes);
          isError = true;
          output =
            strikes <= 2
              ? `参数 JSON 解析失败 (${parseErr})。请输出合法的 JSON 参数并重试工具 ${tc.name}。`
              : `参数连续多次格式错误，终止该工具调用。`;
        } else {
          const preHook = hooks
            ? await hooks
                .run('PreToolUse', {
                  sessionId,
                  turnId,
                  tool: tc.name,
                  arguments: parsedArgs,
                })
                .catch(() => ({ blocked: false, updatedInput: null, additionalContexts: [] }))
            : { blocked: false, updatedInput: null, additionalContexts: [] };

          if (preHook.blocked) {
            isError = true;
            output = `PreToolUse Hook 拦截：${preHook.reason}`;
          } else {
            const effectiveArgs = preHook.updatedInput ?? parsedArgs;
            const meta = toolImpl.meta ?? WORKSPACE_TOOL_META[tc.name] ?? {};
            const readOnly = Boolean(meta.readOnly);
            const outward = Boolean(meta.outward || tc.name.startsWith('mcp__'));
            const replayable =
              meta.replayable !== undefined
                ? Boolean(meta.replayable)
                : readOnly || ['edit_file', 'write_file', 'apply_patch'].includes(tc.name);
            const effectClass =
              meta.effectClass ??
              (readOnly
                ? 'read_only'
                : outward
                  ? 'external_network'
                  : replayable
                    ? 'reversible_write'
                    : 'irreversible_side_effect');
            const riskLevel = meta.riskLevel ?? (readOnly ? 'low' : 'high');

            if (this.reconciler && sessionId && turnId) {
              receipt = this.reconciler.recordReceiptStart({
                sessionId,
                turnId,
                callId: tc.id,
                toolName: tc.name,
                riskLevel,
                effectClass,
                replayable,
                outward,
                args: effectiveArgs,
              });
            }

            try {
              output = String(
                (await toolImpl.execute(effectiveArgs, {
                  callId: tc.id,
                  signal,
                  sessionId,
                  turnId,
                })) ?? '',
              );
            } catch (err) {
              if (err instanceof ToolValidationError) {
                const strikes = (argStrikes.get(tc.name) ?? 0) + 1;
                argStrikes.set(tc.name, strikes);
              }
              isError = true;
              output = `执行失败：${String(err?.message ?? err)}`;
            }

            if (receipt && this.reconciler) {
              const exitMatch = /^exitCode:\s*(-?\d+)/m.exec(output);
              const exitCode = exitMatch ? Number(exitMatch[1]) : isError ? 1 : 0;
              receipt = this.reconciler.recordReceiptFinish(receipt.id, {
                status: isError ? 'failed' : 'finished',
                output,
                exitCode,
                durationMs: Date.now() - tStart,
                errorCode: isError ? 'TOOL_EXECUTION_ERROR' : null,
              });
              this.eventRouter?.emitPersisted({
                sessionId,
                turnId,
                type: 'tool/receipt',
                data: {
                  receiptId: receipt.id,
                  callId: tc.id,
                  toolName: tc.name,
                  effectClass,
                  riskLevel,
                  replayable,
                  outward,
                  status: receipt.status,
                  exitCode,
                },
                audit: false,
              });
            }

            if (hooks) {
              const postHook = await hooks
                .run('PostToolUse', {
                  sessionId,
                  turnId,
                  tool: tc.name,
                  arguments: effectiveArgs,
                  isError,
                  output: output.slice(0, 4000),
                })
                .catch(() => ({ additionalContexts: [] }));
              if (postHook.additionalContexts?.length) {
                output += `\n[PostToolUse Hook]\n${postHook.additionalContexts.join('\n')}`;
              }
            }
          }
        }

        const durationMs = Date.now() - tStart;
        return { tc, parsedArgs, output, isError, durationMs, receipt };
      },
    );
  }
}

export const DEFAULT_AGENT_PROFILES = Object.freeze({
  default: {
    id: 'default',
    name: 'Default Direct Agent',
    defaultMaxSteps: 24,
    streamDeltas: true,
    emitAssistantMessage: true,
    emitToolEvents: true,
    persistTurn: true,
  },
  subagent: {
    id: 'subagent',
    name: 'Autonomous Subagent',
    defaultMaxSteps: 6,
    streamDeltas: false,
    emitAssistantMessage: false,
    emitToolEvents: false,
    persistTurn: false,
  },
  swarm_worker: {
    id: 'swarm_worker',
    name: 'Adaptive Swarm Worker',
    defaultMaxSteps: 12,
    streamDeltas: true,
    emitAssistantMessage: true,
    emitToolEvents: true,
    persistTurn: true,
  },
});

/**
 * Layer 3 Agent Runtime Kernel unifying inference, tool dispatching, cancellation,
 * state machine, and multiple Agent Profiles under one execution contract.
 */
export class AgentRuntimeKernel {
  constructor({
    store = null,
    adapter,
    judgment = null,
    verifier = null,
    checkpointStore = null,
    reconciler = null,
    toolDispatcher = null,
    eventRouter = null,
    cancellationManager = null,
  }) {
    this.store = store;
    this.eventRouter = eventRouter ?? new EventRouter(store);
    this.cancellation = cancellationManager ?? new CancellationManager();
    this.inference = new InferenceEngine(adapter);
    this.checkpointStore = checkpointStore;
    this.reconciler = reconciler;
    this.toolDispatcher =
      toolDispatcher ??
      new DefaultKernelToolDispatcher({
        eventRouter: this.eventRouter,
        store,
        reconciler: this.reconciler,
      });
    this.decisionEngine = new DecisionEngine({ judgment, verifier });
    this.loop = new AgentLoop({
      store,
      eventRouter: this.eventRouter,
      inferenceEngine: this.inference,
      decisionEngine: this.decisionEngine,
      checkpointStore: this.checkpointStore,
    });
    this.profiles = new Map(Object.entries(DEFAULT_AGENT_PROFILES));
  }

  registerProfile(profile) {
    if (!profile?.id) throw new Error('AgentProfile must have an id');
    this.profiles.set(profile.id, { ...profile });
    return this.profiles.get(profile.id);
  }

  getProfile(id = 'default') {
    return this.profiles.get(id) ?? this.profiles.get('default');
  }

  listProfiles() {
    return [...this.profiles.values()];
  }

  setToolDispatcher(dispatcher) {
    this.toolDispatcher = dispatcher;
  }

  setVerifier(verifier) {
    this.decisionEngine.verifier = verifier;
  }

  async executeTurn(params) {
    const profile =
      typeof params.profile === 'string'
        ? this.getProfile(params.profile)
        : params.profile ?? this.getProfile('default');

    const epochId = params.turnId || `turn_${Date.now()}`;
    const signal =
      params.signal ??
      this.cancellation.createEpoch(epochId, {
        parentId: params.parentEpochId ?? null,
        externalSignal: params.externalSignal ?? null,
        timeoutMs: params.budget?.maxDurationMs ?? null,
      });

    try {
      return await this.loop.run({
        ...params,
        profile,
        signal,
        toolDispatcher: params.toolDispatcher ?? this.toolDispatcher,
      });
    } finally {
      if (!params.signal) {
        this.cancellation.dispose(epochId);
      }
    }
  }

  close() {
    this.cancellation.closeAll();
  }
}
