import { id as uuid } from '../store.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import { BudgetError } from '../kernel/errors.js';
import {
  BUDGET_SCOPES,
  estimateRequestInputTokens,
  isBudgetErrorCode,
} from './budget-ledger.js';
import {
  SWARM_NODE_STATES,
  isTerminalRunState,
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
  'TOKEN_BUDGET',
  'STEP_BUDGET',
  'STEP_BUDGET_EXHAUSTED',
  'COST_BUDGET',
  'TASK_DEADLINE',
  'RECURSIVE_FORK_BLOCKED',
  'NODE_CANCELLED',
  'PARENT_CANCELLED',
]);

/**
 * Layer 6 DynamicReplanner handles failure diagnosis, model fallback switching,
 * bounded retries, and subgraph splitting without re-running completed nodes.
 * All planVersion increments, replanCount updates, node mutations, and swarm_replans
 * inserts execute inside a single atomic SQLite transaction with CAS concurrency protection.
 */
export class DynamicReplanner {
  constructor({ store, planner, router, eventRouter, adapter = null, budgetLedger = null }) {
    this.store = store;
    this.planner = planner;
    this.router = router;
    this.eventRouter = eventRouter;
    this.adapter = adapter;
    this.budgetLedger = budgetLedger;
  }

  /**
   * Optional model-backed replanning diagnosis call. Strictly admitted, output-clamped,
   * and settled under `BUDGET_SCOPES.REPLANNING` against the shared task-tree budget ledger.
   */
  async diagnoseWithModel({
    run,
    failedNode,
    errorCode,
    errorMessage,
    model = null,
    budgetLedger = null,
    signal = undefined,
  }) {
    const adapter = this.adapter;
    if (!adapter) return null;
    const picked =
      model || this.router?.select?.({ taskType: 'planning', objective: failedNode?.objective || '' })?.model;
    if (!picked) return null;

    const ledger = budgetLedger ?? this.budgetLedger;
    const messages = [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: 'Diagnose why this swarm node failed and suggest a concise recovery strategy (retry_same, switch_model, or split_subgraph).',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Node: ${failedNode?.nodeKey}\nObjective: ${failedNode?.objective}\nError: ${errorCode}: ${errorMessage}`,
          },
        ],
      },
    ];
    const estimatedInputTokens = estimateRequestInputTokens({ messages });
    let reservation = null;
    if (ledger && run?.id) {
      reservation = ledger.reserveInference({
        treeId: run.id,
        scope: BUDGET_SCOPES.REPLANNING,
        nodeId: failedNode?.id ?? null,
        nodeKey: failedNode?.nodeKey ?? null,
        sessionId: run.sessionId ?? null,
        attempt: Number(failedNode?.attempts ?? 1),
        estimatedInputTokens,
        requestedMaxOutputTokens: 512,
        defaultMaxOutputTokens: 512,
      });
    }

    let text = '';
    const usage = { inputTokens: 0, outputTokens: 0 };
    try {
      for await (const chunk of adapter.stream({
        provider: 'pool',
        model: picked,
        messages,
        maxTokens: reservation?.constrainedMaxOutputTokens ?? 512,
        signal,
      })) {
        if (chunk.type === 'text-delta' && chunk.text) text += chunk.text;
        else if (chunk.type === 'usage' && chunk.usage) {
          usage.inputTokens += Number(chunk.usage.inputTokens ?? 0);
          usage.outputTokens += Number(chunk.usage.outputTokens ?? 0);
        }
      }
      if (reservation?.reservationId) {
        ledger.settleReservation(reservation.reservationId, {
          status: 'settled',
          actualSteps: 1,
          actualInputTokens: usage.inputTokens,
          actualOutputTokens: usage.outputTokens,
        });
      }
      return { text: text.trim(), usage };
    } catch (err) {
      if (reservation?.reservationId) {
        ledger.settleReservation(reservation.reservationId, {
          status: 'failed',
          actualSteps: 1,
          actualInputTokens: usage.inputTokens,
          actualOutputTokens: usage.outputTokens,
          errorCode: err?.code || 'REPLAN_DIAGNOSIS_FAILED',
        });
      }
      throw err;
    }
  }

  async replan({
    run,
    failedNode,
    errorCode,
    errorMessage,
    maxReplans = undefined,
    budgetLedger = null,
    useModelDiagnosis = false,
    signal = undefined,
  }) {
    const codeStr = String(errorCode || '');
    if (NON_REPLANABLE_ERRORS.has(codeStr) || isBudgetErrorCode(codeStr)) {
      return { replanned: false, strategy: 'none', reason: `NON_REPLANABLE:${codeStr}` };
    }

    const activeLedger = budgetLedger ?? this.budgetLedger;
    let diagnosisNote = null;
    if (useModelDiagnosis && this.adapter) {
      try {
        const diag = await this.diagnoseWithModel({
          run,
          failedNode,
          errorCode,
          errorMessage,
          budgetLedger: activeLedger,
          signal,
        });
        diagnosisNote = diag?.text || null;
      } catch (err) {
        if (err instanceof BudgetError || err?.category === 'budget' || isBudgetErrorCode(err?.code)) {
          return {
            replanned: false,
            strategy: 'none',
            reason: 'BUDGET_EXCEEDED',
            errorCode: err.code || 'BUDGET_EXCEEDED',
          };
        }
      }
    }

    const allModels = this.router?.modelRegistry?.syncFromPool?.() ?? [];

    const outcome = this.store.tx(() => {
      const liveRun = this.store.db.prepare('SELECT * FROM swarm_runs WHERE id=?').get(run.id);
      if (!liveRun || isTerminalRunState(liveRun.status)) {
        return { replanned: false, strategy: 'none', reason: 'RUN_NOT_ACTIVE' };
      }

      const liveNode = this.store.db
        .prepare('SELECT * FROM swarm_nodes WHERE id=?')
        .get(failedNode.id);
      if (!liveNode || !['running', 'failed'].includes(liveNode.status)) {
        return { replanned: false, strategy: 'none', reason: 'NODE_NOT_ELIGIBLE' };
      }

      const strategyCfg = parseJsonSafe(liveRun.strategyJson, {});
      const effectiveMaxReplans =
        maxReplans !== undefined
          ? Math.max(0, Number(maxReplans))
          : Math.max(0, Number(strategyCfg.maxReplans ?? 2));
      const currentReplanCount = Number(liveRun.replanCount ?? 0);
      const currentPlanVersion = Number(liveRun.planVersion ?? 1);

      if (currentReplanCount >= effectiveMaxReplans) {
        return {
          replanned: false,
          strategy: 'none',
          reason: 'MAX_REPLANS_REACHED',
          replanCount: currentReplanCount,
          maxReplans: effectiveMaxReplans,
        };
      }

      if (activeLedger) {
        const snap = activeLedger.getSnapshot(liveRun.id);
        if (snap && (snap.isStepExhausted || snap.isPermanentlyExhausted)) {
          return {
            replanned: false,
            strategy: 'none',
            reason: 'BUDGET_EXCEEDED',
            replanCount: currentReplanCount,
            maxReplans: effectiveMaxReplans,
          };
        }
      }

      const alreadySplit = this.store.db
        .prepare(
          "SELECT 1 FROM swarm_replans WHERE runId=? AND failedNodeKey=? AND strategy='split_subgraph' LIMIT 1",
        )
        .get(liveRun.id, liveNode.nodeKey);
      if (alreadySplit) {
        return { replanned: false, strategy: 'none', reason: 'ALREADY_REPLANNED' };
      }

      const nextVersion = currentPlanVersion + 1;
      const nextReplanCount = currentReplanCount + 1;
      const now = Date.now();
      const attempts = Number(liveNode.attempts ?? failedNode.attempts ?? 1);

      let strategy = null;
      let reason = null;
      let diff = null;
      let updatedNode = null;

      // Check whether this model has already failed and been switched away from in this run
      const runSwitches = this.store.db
        .prepare("SELECT failedNodeKey, diffJson FROM swarm_replans WHERE runId=? AND strategy='switch_model'")
        .all(liveRun.id);
      const runKnownFailedModels = new Set();
      const triedModels = new Set([liveNode.model].filter(Boolean));
      for (const r of runSwitches) {
        const d = parseJsonSafe(r.diffJson, {});
        if (d.fromModel) runKnownFailedModels.add(d.fromModel);
        if (r.failedNodeKey === liveNode.nodeKey) {
          if (d.fromModel) triedModels.add(d.fromModel);
          if (d.toModel) triedModels.add(d.toModel);
        }
      }
      const altModel = allModels.find(
        (m) => m.model && !triedModels.has(m.model) && !runKnownFailedModels.has(m.model) && m.healthy !== false,
      ) ?? allModels.find(
        (m) => m.model && !triedModels.has(m.model) && m.healthy !== false,
      );

      // 1. Transient retry on same model (first failure, unless model already failed out in this run)
      if (attempts < 2 && !(liveNode.model && runKnownFailedModels.has(liveNode.model) && altModel)) {
        if (liveNode.status !== SWARM_NODE_STATES.FAILED) {
          transitionSwarmNode(this.store, null, liveNode.id, SWARM_NODE_STATES.FAILED, {
            emitEvent: false,
            patch: { errorCode, errorMessage },
          });
        }
        updatedNode = transitionSwarmNode(this.store, null, liveNode.id, SWARM_NODE_STATES.READY, {
          emitEvent: false,
          allowReplanReset: true,
          patch: { planVersion: nextVersion, errorCode: null, errorMessage: null },
        });
        strategy = 'retry_same';
        reason = errorMessage || errorCode || 'transient failure retry';
        diff = { nodeKey: liveNode.nodeKey, attempts };
      } else {
        // 2. Switch to an alternate untried healthy model if available
        if (altModel) {
          if (liveNode.status !== SWARM_NODE_STATES.FAILED) {
            transitionSwarmNode(this.store, null, liveNode.id, SWARM_NODE_STATES.FAILED, {
              emitEvent: false,
              patch: { errorCode, errorMessage },
            });
          }
          updatedNode = transitionSwarmNode(
            this.store,
            null,
            liveNode.id,
            SWARM_NODE_STATES.READY,
            {
              emitEvent: false,
              allowReplanReset: true,
              patch: {
                model: altModel.model,
                provider: altModel.provider || 'pool',
                planVersion: nextVersion,
                errorCode: null,
                errorMessage: null,
              },
            },
          );
          strategy = 'switch_model';
          reason = `Switched model ${liveNode.model} -> ${altModel.model}`;
          diff = {
            nodeKey: liveNode.nodeKey,
            fromModel: liveNode.model,
            toModel: altModel.model,
          };
        } else if (!liveNode.nodeKey.includes('__split')) {
          // 3. Split subgraph into two smaller deterministic sub-nodes while preserving completed nodes
          const existingNodes = this.store.db
            .prepare('SELECT id, nodeKey, dependenciesJson, status FROM swarm_nodes WHERE runId=?')
            .all(liveRun.id)
            .map((r) => ({
              id: r.id,
              nodeKey: r.nodeKey,
              status: r.status,
              dependencies: parseJsonSafe(r.dependenciesJson, []),
            }));
          const deps = parseJsonSafe(liveNode.dependenciesJson, []);
          const s1Key = `${liveNode.nodeKey}__split1_v${nextVersion}`.slice(0, 64);
          const s2Key = `${liveNode.nodeKey}__split2_v${nextVersion}`.slice(0, 64);
          const subNodes = [
            {
              nodeKey: s1Key,
              taskType: 'research',
              objective: `[拆分子步骤 1/2] 先只读梳理并准备上下文：${liveNode.objective}`,
              acceptance: '产出缩小范围的具体信息与改动前置条件',
              dependencies: deps,
              priority: Number(liveNode.priority ?? 0) + 2,
              isolationMode: liveNode.isolationMode,
              allowIsolationFallback: Boolean(liveNode.allowIsolationFallback),
            },
            {
              nodeKey: s2Key,
              taskType: liveNode.taskType || 'research',
              objective: `[拆分子步骤 2/2] 基于前置结论完成剩余目标：${liveNode.objective}`,
              acceptance: liveNode.acceptance,
              dependencies: [s1Key],
              priority: Number(liveNode.priority ?? 0) + 1,
              isolationMode: liveNode.isolationMode,
              allowIsolationFallback: Boolean(liveNode.allowIsolationFallback),
            },
          ];

          const simulated = [
            ...existingNodes.map((n) => ({
              nodeKey: n.nodeKey,
              dependencies: n.dependencies.map((d) => (d === liveNode.nodeKey ? s2Key : d)),
            })),
            ...subNodes,
          ];
          this.planner.validateDag(simulated);

          if (liveNode.status !== SWARM_NODE_STATES.FAILED) {
            updatedNode = transitionSwarmNode(
              this.store,
              null,
              liveNode.id,
              SWARM_NODE_STATES.FAILED,
              {
                emitEvent: false,
                patch: { errorCode: errorCode || 'REPLANNED', errorMessage },
              },
            );
          } else {
            updatedNode = liveNode;
          }

          const ins = this.store.db.prepare(
            `INSERT INTO swarm_nodes(
              id, runId, nodeKey, agentProfileId, model, provider, objective, acceptance,
              dependenciesJson, toolAllowJson, permissionMode, taskType, isolationMode,
              allowIsolationFallback, planVersion, status, priority, budgetJson, createdAt, updatedAt
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`,
          );
          for (const sub of subNodes) {
            const sel = this.router.select({ taskType: sub.taskType, objective: sub.objective });
            ins.run(
              uuid(),
              liveRun.id,
              sub.nodeKey,
              sel.profile.id,
              sel.model,
              sel.provider,
              sub.objective,
              sub.acceptance,
              JSON.stringify(sub.dependencies),
              liveNode.toolAllowJson !== undefined && liveNode.toolAllowJson !== null
                ? liveNode.toolAllowJson
                : JSON.stringify(sel.profile.toolAllow),
              liveNode.permissionMode,
              sub.taskType,
              sub.isolationMode || 'shared_readonly',
              sub.allowIsolationFallback ? 1 : 0,
              nextVersion,
              sub.priority,
              liveNode.budgetJson || '{}',
              now,
              now,
            );
          }
          const updDep = this.store.db.prepare(
            'UPDATE swarm_nodes SET dependenciesJson=?, planVersion=?, updatedAt=? WHERE id=?',
          );
          for (const n of existingNodes) {
            if (n.status === 'pending' && n.dependencies.includes(liveNode.nodeKey)) {
              const nextDeps = n.dependencies.map((d) => (d === liveNode.nodeKey ? s2Key : d));
              updDep.run(JSON.stringify(nextDeps), nextVersion, now, n.id);
            }
          }
          strategy = 'split_subgraph';
          reason = 'Decomposed failed node into sequential subgraph';
          diff = { failedNodeKey: liveNode.nodeKey, addedNodes: [s1Key, s2Key] };
        }
      }

      if (!strategy) {
        return { replanned: false, strategy: 'none', reason: 'NO_FALLBACK_STRATEGY' };
      }

      if (diagnosisNote) {
        diff = { ...diff, diagnosis: diagnosisNote.slice(0, 500) };
      }

      // Single atomic CAS update of planVersion + replanCount alongside node mutations + swarm_replans row
      transitionSwarmRun(this.store, liveRun.id, liveRun.status, {
        expectedPlanVersion: currentPlanVersion,
        expectedReplanCount: currentReplanCount,
        patch: {
          planVersion: nextVersion,
          replanCount: nextReplanCount,
        },
      });

      const replanId = uuid();
      this.store.db
        .prepare(
          `INSERT INTO swarm_replans(
            id, runId, version, failedNodeKey, strategy, reason, diffJson, createdAt
          ) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          replanId,
          liveRun.id,
          nextVersion,
          liveNode.nodeKey,
          strategy,
          reason,
          JSON.stringify(diff),
          now,
        );

      return {
        replanned: true,
        replanId,
        version: nextVersion,
        replanCount: nextReplanCount,
        strategy,
        reason,
        diff,
        sessionId: liveRun.sessionId,
        rootTurnId: liveRun.rootTurnId,
        updatedNode,
      };
    });

    if (!outcome.replanned) return outcome;

    if (outcome.updatedNode && outcome.sessionId && this.eventRouter) {
      this.eventRouter.emitPersisted({
        sessionId: outcome.sessionId,
        turnId: outcome.rootTurnId,
        type: RUNTIME_EVENTS.SWARM_NODE_UPDATED,
        data: {
          runId: run.id,
          nodeId: outcome.updatedNode.id,
          nodeKey: outcome.updatedNode.nodeKey,
          status: outcome.updatedNode.status,
          childSessionId: outcome.updatedNode.childSessionId || undefined,
          errorCode: outcome.updatedNode.errorCode || undefined,
        },
        audit: false,
      });
    }

    this.eventRouter?.emitPersisted({
      sessionId: outcome.sessionId,
      turnId: outcome.rootTurnId,
      type: RUNTIME_EVENTS.SWARM_REPLANNED,
      data: {
        replanId: outcome.replanId,
        runId: run.id,
        version: outcome.version,
        replanCount: outcome.replanCount,
        failedNodeKey: failedNode.nodeKey,
        strategy: outcome.strategy,
        reason: outcome.reason,
        diff: outcome.diff,
      },
      audit: true,
    });

    return {
      replanned: true,
      replanId: outcome.replanId,
      version: outcome.version,
      replanCount: outcome.replanCount,
      strategy: outcome.strategy,
      reason: outcome.reason,
      diff: outcome.diff,
    };
  }
}
