import { id as uuid } from '../store.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import {
  SWARM_NODE_STATES,
  transitionSwarmNode,
  transitionSwarmRun,
} from './node-state-machine.js';

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

const NON_REPLANABLE_ERRORS = new Set([
  'WORKTREE_ISOLATION_FAILED',
  'POLICY_DENIED',
  'APPROVAL_DENIED',
  'APPROVAL_ARGS_MISMATCH',
  'DEPENDENCY_FAILED',
  'BUDGET_EXCEEDED',
  'RECURSIVE_FORK_BLOCKED',
  'NODE_CANCELLED',
  'PARENT_CANCELLED',
]);

/**
 * Layer 6 DynamicReplanner handles failure diagnosis, model fallback switching,
 * bounded retries, and subgraph splitting without re-running completed nodes.
 */
export class DynamicReplanner {
  constructor({ store, planner, router, eventRouter }) {
    this.store = store;
    this.planner = planner;
    this.router = router;
    this.eventRouter = eventRouter;
  }

  async replan({ run, failedNode, errorCode, errorMessage, maxReplans = 2 }) {
    if ((run.replanCount ?? 0) >= maxReplans) {
      return { replanned: false, strategy: 'none', reason: 'MAX_REPLANS_REACHED' };
    }
    if (NON_REPLANABLE_ERRORS.has(String(errorCode || ''))) {
      return { replanned: false, strategy: 'none', reason: `NON_REPLANABLE:${errorCode}` };
    }

    const nextVersion = Number(run.planVersion ?? 1) + 1;
    const now = Date.now();
    const attempts = Number(failedNode.attempts ?? 1);

    // 1. Transient retry on same model (first failure)
    if (attempts < 2) {
      transitionSwarmNode(this.store, this.eventRouter, failedNode.id, SWARM_NODE_STATES.FAILED, {
        sessionId: run.sessionId,
        rootTurnId: run.rootTurnId,
        patch: { errorCode, errorMessage },
      });
      transitionSwarmNode(this.store, this.eventRouter, failedNode.id, SWARM_NODE_STATES.READY, {
        sessionId: run.sessionId,
        rootTurnId: run.rootTurnId,
        allowReplanReset: true,
        patch: { planVersion: nextVersion, errorCode: null, errorMessage: null },
      });
      return this.#recordReplan({
        run,
        failedNode,
        nextVersion,
        strategy: 'retry_same',
        reason: errorMessage || errorCode || 'transient failure retry',
        diff: { nodeKey: failedNode.nodeKey, attempts },
        now,
      });
    }

    // 2. Switch to an alternate capable model if available
    const allModels = this.router?.modelRegistry?.syncFromPool?.() ?? [];
    const altModel = allModels.find(
      (m) => m.model && m.model !== failedNode.model && m.healthy !== false,
    );
    if (altModel) {
      transitionSwarmNode(this.store, this.eventRouter, failedNode.id, SWARM_NODE_STATES.FAILED, {
        sessionId: run.sessionId,
        rootTurnId: run.rootTurnId,
        patch: { errorCode, errorMessage },
      });
      transitionSwarmNode(this.store, this.eventRouter, failedNode.id, SWARM_NODE_STATES.READY, {
        sessionId: run.sessionId,
        rootTurnId: run.rootTurnId,
        allowReplanReset: true,
        patch: {
          model: altModel.model,
          provider: altModel.provider || 'pool',
          planVersion: nextVersion,
          errorCode: null,
          errorMessage: null,
        },
      });
      return this.#recordReplan({
        run,
        failedNode,
        nextVersion,
        strategy: 'switch_model',
        reason: `Switched model ${failedNode.model} -> ${altModel.model}`,
        diff: { nodeKey: failedNode.nodeKey, fromModel: failedNode.model, toModel: altModel.model },
        now,
      });
    }

    // 3. Split subgraph into two smaller deterministic sub-nodes while preserving completed nodes
    if (!failedNode.nodeKey.includes('__split')) {
      const existingNodes = this.store.db
        .prepare('SELECT id, nodeKey, dependenciesJson, status FROM swarm_nodes WHERE runId=?')
        .all(run.id)
        .map((r) => ({
          id: r.id,
          nodeKey: r.nodeKey,
          status: r.status,
          dependencies: parseJsonSafe(r.dependenciesJson, []),
        }));
      const deps = parseJsonSafe(failedNode.dependenciesJson, []);
      const s1Key = `${failedNode.nodeKey}__split1_v${nextVersion}`.slice(0, 64);
      const s2Key = `${failedNode.nodeKey}__split2_v${nextVersion}`.slice(0, 64);
      const subNodes = [
        {
          nodeKey: s1Key,
          taskType: 'research',
          objective: `[拆分子步骤 1/2] 先只读梳理并准备上下文：${failedNode.objective}`,
          acceptance: '产出缩小范围的具体信息与改动前置条件',
          dependencies: deps,
          priority: Number(failedNode.priority ?? 0) + 2,
          isolationMode: failedNode.isolationMode,
          allowIsolationFallback: Boolean(failedNode.allowIsolationFallback),
        },
        {
          nodeKey: s2Key,
          taskType: failedNode.taskType || 'research',
          objective: `[拆分子步骤 2/2] 基于前置结论完成剩余目标：${failedNode.objective}`,
          acceptance: failedNode.acceptance,
          dependencies: [s1Key],
          priority: Number(failedNode.priority ?? 0) + 1,
          isolationMode: failedNode.isolationMode,
          allowIsolationFallback: Boolean(failedNode.allowIsolationFallback),
        },
      ];

      // Validate DAG including replacement sub-nodes + downstream rewired dependencies
      const simulated = [
        ...existingNodes.map((n) => ({
          nodeKey: n.nodeKey,
          dependencies: n.dependencies.map((d) => (d === failedNode.nodeKey ? s2Key : d)),
        })),
        ...subNodes,
      ];
      this.planner.validateDag(simulated);

      transitionSwarmNode(this.store, this.eventRouter, failedNode.id, SWARM_NODE_STATES.FAILED, {
        sessionId: run.sessionId,
        rootTurnId: run.rootTurnId,
        patch: { errorCode: errorCode || 'REPLANNED', errorMessage },
      });

      this.store.tx(() => {
        const ins = this.store.db.prepare(
          `INSERT INTO swarm_nodes(
            id, runId, nodeKey, agentProfileId, model, provider, objective, acceptance,
            dependenciesJson, toolAllowJson, permissionMode, taskType, isolationMode,
            allowIsolationFallback, planVersion, status, priority, budgetJson, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,'{}',?,?)`,
        );
        for (const sub of subNodes) {
          const sel = this.router.select({ taskType: sub.taskType, objective: sub.objective });
          ins.run(
            uuid(),
            run.id,
            sub.nodeKey,
            sel.profile.id,
            sel.model,
            sel.provider,
            sub.objective,
            sub.acceptance,
            JSON.stringify(sub.dependencies),
            failedNode.toolAllowJson || JSON.stringify(sel.profile.toolAllow),
            failedNode.permissionMode,
            sub.taskType,
            sub.isolationMode || 'shared_readonly',
            sub.allowIsolationFallback ? 1 : 0,
            nextVersion,
            sub.priority,
            now,
            now,
          );
        }
        // Rewire pending downstream dependents to depend on s2Key instead of failedNode
        const updDep = this.store.db.prepare(
          'UPDATE swarm_nodes SET dependenciesJson=?, planVersion=?, updatedAt=? WHERE id=?',
        );
        for (const n of existingNodes) {
          if (n.status === 'pending' && n.dependencies.includes(failedNode.nodeKey)) {
            const nextDeps = n.dependencies.map((d) => (d === failedNode.nodeKey ? s2Key : d));
            updDep.run(JSON.stringify(nextDeps), nextVersion, now, n.id);
          }
        }
      });

      return this.#recordReplan({
        run,
        failedNode,
        nextVersion,
        strategy: 'split_subgraph',
        reason: 'Decomposed failed node into sequential subgraph',
        diff: { failedNodeKey: failedNode.nodeKey, addedNodes: [s1Key, s2Key] },
        now,
      });
    }

    return { replanned: false, strategy: 'none', reason: 'NO_FALLBACK_STRATEGY' };
  }

  #recordReplan({ run, failedNode, nextVersion, strategy, reason, diff, now }) {
    const replanId = uuid();
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO swarm_replans(
            id, runId, version, failedNodeKey, strategy, reason, diffJson, createdAt
          ) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          replanId,
          run.id,
          nextVersion,
          failedNode.nodeKey,
          strategy,
          reason,
          JSON.stringify(diff),
          now,
        );
    });
    transitionSwarmRun(this.store, run.id, run.status, {
      patch: {
        planVersion: nextVersion,
        replanCount: Number(run.replanCount ?? 0) + 1,
      },
    });
    this.eventRouter?.emitPersisted({
      sessionId: run.sessionId,
      turnId: run.rootTurnId,
      type: RUNTIME_EVENTS.SWARM_REPLANNED,
      data: {
        replanId,
        runId: run.id,
        version: nextVersion,
        failedNodeKey: failedNode.nodeKey,
        strategy,
        reason,
        diff,
      },
      audit: true,
    });
    return { replanned: true, replanId, version: nextVersion, strategy, reason, diff };
  }
}
