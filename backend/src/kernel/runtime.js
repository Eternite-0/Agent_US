import { EventRouter } from './events.js';
import { CancellationManager } from './cancellation.js';
import { InferenceEngine } from './inference.js';
import { AgentLoop, DecisionEngine } from './agent-loop.js';
import { ToolDispatcher } from '../tools/dispatcher.js';
import { ToolPermissionPolicy } from '../tools/policy.js';

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
    pool = null,
    judgment = null,
    verifier = null,
    checkpointStore = null,
    reconciler = null,
    toolDispatcher = null,
    toolPolicy = null,
    eventRouter = null,
    cancellationManager = null,
    approvalManager = null,
    getLivePolicy = null,
  }) {
    this.store = store;
    this.pool = pool ?? adapter?.pool ?? null;
    this.eventRouter = eventRouter ?? new EventRouter(store);
    this.cancellation = cancellationManager ?? new CancellationManager();
    this.inference = new InferenceEngine(adapter, { pool: this.pool });
    this.checkpointStore = checkpointStore;
    this.reconciler = reconciler;
    this.toolPolicy = toolPolicy ?? new ToolPermissionPolicy({ permissionMode: 'approval' });
    this.toolDispatcher =
      toolDispatcher ??
      new ToolDispatcher({
        store,
        eventRouter: this.eventRouter,
        reconciler: this.reconciler,
        policy: this.toolPolicy,
        approvalManager,
        getLivePolicy,
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
    const externalSignals = [params.signal, params.externalSignal].filter(Boolean);
    const combinedExternal =
      externalSignals.length > 1
        ? AbortSignal.any(externalSignals)
        : (externalSignals[0] ?? null);
    const ownsEpoch = !this.cancellation.getSignal(epochId);
    const signal = this.cancellation.createEpoch(epochId, {
      parentId: params.parentEpochId ?? null,
      externalSignal: combinedExternal,
      timeoutMs: params.budget?.maxDurationMs ?? null,
    });

    try {
      return await this.loop.run({
        ...params,
        pool: params.pool ?? this.pool,
        profile,
        signal,
        toolDispatcher: params.toolDispatcher ?? this.toolDispatcher,
      });
    } finally {
      if (ownsEpoch) {
        this.cancellation.dispose(epochId);
      }
    }
  }

  close() {
    this.cancellation.closeAll();
  }
}
