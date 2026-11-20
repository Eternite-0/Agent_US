import { id as uuid } from '../store.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Layer 6 AdaptiveSwarmOrchestrator:
 * Plans acyclic DAGs, selects capability-matched models/profiles per node,
 * schedules ready nodes concurrently up to maxConcurrency, enforces tree budgets,
 * routes inter-agent mailbox handoffs, and supports live replanning & cancellation.
 */
export class AdaptiveSwarmOrchestrator {
  constructor({ store, eventRouter, planner, router, childManager, mailbox }) {
    this.store = store;
    this.eventRouter = eventRouter;
    this.planner = planner;
    this.router = router;
    this.childManager = childManager;
    this.mailbox = mailbox;
    this.activeRuns = new Map(); // runId -> { controller, cancelled, childSessionIds: Set }
  }

  getRun(runId) {
    const run = this.store.db.prepare('SELECT * FROM swarm_runs WHERE id=?').get(runId);
    if (!run) return null;
    const nodes = this.store.db
      .prepare('SELECT * FROM swarm_nodes WHERE runId=? ORDER BY priority DESC, createdAt ASC')
      .all(runId)
      .map((n) => ({
        ...n,
        dependencies: parseJsonSafe(n.dependenciesJson, []),
        toolAllow: parseJsonSafe(n.toolAllowJson, null),
        budget: parseJsonSafe(n.budgetJson, {}),
        artifactUris: parseJsonSafe(n.artifactUrisJson, []),
      }));
    return {
      ...run,
      strategy: parseJsonSafe(run.strategyJson, {}),
      budget: parseJsonSafe(run.budgetJson, {}),
      usage: parseJsonSafe(run.usageJson, {}),
      verdict: parseJsonSafe(run.verdictJson, null),
      nodes,
    };
  }

  listRuns({ sessionId = null, limit = 50 } = {}) {
    const cap = Math.min(200, Math.max(1, Number(limit || 50)));
    const rows = sessionId
      ? this.store.db
          .prepare('SELECT * FROM swarm_runs WHERE sessionId=? ORDER BY createdAt DESC LIMIT ?')
          .all(sessionId, cap)
      : this.store.db
          .prepare('SELECT * FROM swarm_runs ORDER BY createdAt DESC LIMIT ?')
          .all(cap);
    return rows.map((r) => this.getRun(r.id));
  }

  cancelRun(runId) {
    const active = this.activeRuns.get(runId);
    if (active) {
      active.cancelled = true;
      active.controller.abort('swarm_cancelled');
      for (const cid of active.childSessionIds) {
        this.childManager.cancel(cid);
      }
    }
    const now = Date.now();
    this.store.tx(() => {
      this.store.db
        .prepare("UPDATE swarm_nodes SET status='cancelled', updatedAt=? WHERE runId=? AND status IN ('pending','running')")
        .run(now, runId);
      this.store.db
        .prepare("UPDATE swarm_runs SET status='cancelled', updatedAt=? WHERE id=? AND status='running'")
        .run(now, runId);
    });
    return this.getRun(runId);
  }

  async startRun({
    sessionId,
    rootTurnId = null,
    goal,
    workspaceRoot,
    parentPermissionMode = 'auto-safe',
    maxConcurrency = 3,
    budget = {},
    nodes = null,
    signal = undefined,
  }) {
    const runId = uuid();
    const now = Date.now();
    const controller = new AbortController();
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const runState = { controller, cancelled: false, childSessionIds: new Set() };
    this.activeRuns.set(runId, runState);

    const plannedNodes = nodes
      ? this.planner.normalizeNodes(nodes)
      : await this.planner.decompose({ goal, signal: combinedSignal });
    this.planner.validateDag(plannedNodes);

    const usageTotals = { inputTokens: 0, outputTokens: 0, steps: 0, completedNodes: 0 };
    const strategy = { maxConcurrency: Math.min(6, Math.max(1, Number(maxConcurrency || 3))) };
    const routedSpecs = plannedNodes.map((n) => {
      const sel = this.router.select({
        taskType: n.taskType,
        objective: n.objective,
        requiredTools: n.toolAllow ?? [],
        budget: n.budget ?? budget,
      });
      return { spec: n, selection: sel };
    });

    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO swarm_runs(
            id, sessionId, rootTurnId, goal, status, strategyJson, budgetJson, usageJson, createdAt, updatedAt
          ) VALUES(?,?,?,?,'running',?,?,?,?,?)`,
        )
        .run(
          runId,
          sessionId,
          rootTurnId,
          goal,
          JSON.stringify(strategy),
          JSON.stringify(budget ?? {}),
          JSON.stringify(usageTotals),
          now,
          now,
        );
      const insNode = this.store.db.prepare(
        `INSERT INTO swarm_nodes(
          id, runId, nodeKey, agentProfileId, model, provider, objective, acceptance,
          dependenciesJson, toolAllowJson, permissionMode, status, priority, budgetJson, createdAt, updatedAt
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`,
      );
      for (const { spec, selection } of routedSpecs) {
        insNode.run(
          uuid(),
          runId,
          spec.nodeKey,
          selection.profile.id,
          selection.model,
          selection.provider,
          spec.objective,
          spec.acceptance,
          JSON.stringify(spec.dependencies),
          spec.toolAllow ? JSON.stringify(spec.toolAllow) : JSON.stringify(selection.profile.toolAllow),
          parentPermissionMode,
          spec.priority,
          JSON.stringify(spec.budget ?? {}),
          now,
          now,
        );
      }
    });

    this.eventRouter?.emitPersisted({
      sessionId,
      turnId: rootTurnId,
      type: RUNTIME_EVENTS.SWARM_RUN_STARTED,
      data: { runId, goal, nodeCount: routedSpecs.length, maxConcurrency: strategy.maxConcurrency },
      audit: true,
    });

    try {
      const inFlight = new Map(); // nodeKey -> Promise
      const specByKey = new Map(routedSpecs.map((r) => [r.spec.nodeKey, r]));

      while (!runState.cancelled && !combinedSignal.aborted) {
        const dbNodes = this.getRun(runId).nodes;
        const byKey = new Map(dbNodes.map((n) => [n.nodeKey, n]));
        const unfinished = dbNodes.filter((n) => n.status === 'pending' || n.status === 'running');
        if (!unfinished.length) break;

        // Enforce tree budget ceiling across all child agents in the run
        const overTokenBudget =
          budget.maxTotalTokens > 0 &&
          usageTotals.inputTokens + usageTotals.outputTokens >= budget.maxTotalTokens;
        const overStepBudget = budget.maxTotalSteps > 0 && usageTotals.steps >= budget.maxTotalSteps;
        if (overTokenBudget || overStepBudget) {
          this.store.tx(() => {
            this.store.db
              .prepare(
                "UPDATE swarm_nodes SET status='cancelled', errorCode='BUDGET_EXCEEDED', errorMessage='Tree budget reached', updatedAt=? WHERE runId=? AND status='pending'",
              )
              .run(Date.now(), runId);
          });
          if (!inFlight.size) break;
          await Promise.race(inFlight.values());
          continue;
        }

        // Propagate upstream failures down the DAG until fixpoint
        let propagated = true;
        while (propagated) {
          propagated = false;
          const curNodes = this.getRun(runId).nodes;
          const curMap = new Map(curNodes.map((n) => [n.nodeKey, n]));
          for (const n of curNodes) {
            if (n.status !== 'pending') continue;
            const failedDeps = n.dependencies.filter((d) =>
              ['failed', 'cancelled'].includes(curMap.get(d)?.status),
            );
            if (failedDeps.length) {
              propagated = true;
              this.store.tx(() => {
                this.store.db
                  .prepare(
                    "UPDATE swarm_nodes SET status='failed', errorCode='DEPENDENCY_FAILED', errorMessage=?, updatedAt=? WHERE id=?",
                  )
                  .run(`Blocked by upstream node(s): ${failedDeps.join(', ')}`, Date.now(), n.id);
              });
              this.eventRouter?.emitPersisted({
                sessionId,
                turnId: rootTurnId,
                type: RUNTIME_EVENTS.SWARM_NODE_UPDATED,
                data: { runId, nodeKey: n.nodeKey, status: 'failed' },
                audit: false,
              });
            }
          }
        }

        const refreshed = this.getRun(runId).nodes;
        const refByKey = new Map(refreshed.map((n) => [n.nodeKey, n]));
        const ready = refreshed.filter(
          (n) =>
            n.status === 'pending' &&
            !inFlight.has(n.nodeKey) &&
            n.dependencies.every((d) => refByKey.get(d)?.status === 'completed'),
        );

        while (ready.length && inFlight.size < strategy.maxConcurrency) {
          const node = ready.shift();
          const meta = specByKey.get(node.nodeKey);
          const depResults = node.dependencies
            .map((d) => {
              const dn = refByKey.get(d);
              return dn?.resultText ? `[前置节点 ${d} 输出]\n${dn.resultText}` : '';
            })
            .filter(Boolean);
          const inboxMsgs = this.mailbox
            .drainInbox(node.nodeKey, { runId })
            .map((m) => `[协同消息来自 ${m.fromAgentId}]: ${JSON.stringify(m.payload)}`);
          const fullObjective = [...depResults, ...inboxMsgs, node.objective].join('\n\n');

          this.store.tx(() => {
            this.store.db
              .prepare("UPDATE swarm_nodes SET status='running', attempts=attempts+1, updatedAt=? WHERE id=?")
              .run(Date.now(), node.id);
          });
          this.eventRouter?.emitPersisted({
            sessionId,
            turnId: rootTurnId,
            type: RUNTIME_EVENTS.SWARM_NODE_UPDATED,
            data: { runId, nodeKey: node.nodeKey, status: 'running', model: node.model },
            audit: false,
          });

          const taskPromise = (async () => {
            try {
              const remainingSteps =
                budget.maxTotalSteps > 0 ? Math.max(1, budget.maxTotalSteps - usageTotals.steps) : undefined;
              const childRes = await this.childManager.spawn({
                parentSessionId: sessionId,
                parentTurnId: rootTurnId,
                objective: fullObjective,
                profile: meta?.selection?.profile ?? { id: node.agentProfileId },
                model: node.model,
                provider: node.provider,
                permissionMode: node.permissionMode,
                parentPermissionMode,
                allowedTools: node.toolAllow,
                budget: {
                  ...node.budget,
                  ...(remainingSteps !== undefined ? { maxSteps: remainingSteps } : {}),
                },
                workspaceRoot,
                isolatedWorktree: Boolean(meta?.spec?.isolatedWorktree),
                signal: combinedSignal,
              });
              runState.childSessionIds.add(childRes.childSessionId);
              usageTotals.inputTokens += childRes.usage?.inputTokens ?? 0;
              usageTotals.outputTokens += childRes.usage?.outputTokens ?? 0;
              usageTotals.steps += childRes.steps ?? 0;
              usageTotals.completedNodes++;

              const uris = [...(childRes.text.match(/artifact:\/\/[0-9a-f]{64}/g) ?? [])];
              this.store.tx(() => {
                this.store.db
                  .prepare(
                    `UPDATE swarm_nodes
                     SET status='completed', childSessionId=?, resultText=?, artifactUrisJson=?, updatedAt=?
                     WHERE id=?`,
                  )
                  .run(childRes.childSessionId, childRes.text, JSON.stringify(uris), Date.now(), node.id);
                this.store.db
                  .prepare('UPDATE swarm_runs SET usageJson=?, updatedAt=? WHERE id=?')
                  .run(JSON.stringify(usageTotals), Date.now(), runId);
              });
              this.eventRouter?.emitPersisted({
                sessionId,
                turnId: rootTurnId,
                type: RUNTIME_EVENTS.SWARM_NODE_UPDATED,
                data: { runId, nodeKey: node.nodeKey, status: 'completed', childSessionId: childRes.childSessionId },
                audit: false,
              });
            } catch (err) {
              this.store.tx(() => {
                this.store.db
                  .prepare(
                    "UPDATE swarm_nodes SET status='failed', errorCode=?, errorMessage=?, updatedAt=? WHERE id=?",
                  )
                  .run(err?.code || 'NODE_FAILED', String(err?.message ?? err), Date.now(), node.id);
              });
              this.eventRouter?.emitPersisted({
                sessionId,
                turnId: rootTurnId,
                type: RUNTIME_EVENTS.SWARM_NODE_UPDATED,
                data: { runId, nodeKey: node.nodeKey, status: 'failed', error: String(err?.message ?? err) },
                audit: false,
              });
            } finally {
              inFlight.delete(node.nodeKey);
            }
          })();

          inFlight.set(node.nodeKey, taskPromise);
        }

        if (inFlight.size) {
          await Promise.race(inFlight.values());
        } else {
          break;
        }
      }

      const finalRun = this.getRun(runId);
      const anyFailed = finalRun.nodes.some((n) => n.status === 'failed');
      const finalStatus =
        runState.cancelled || combinedSignal.aborted ? 'cancelled' : anyFailed ? 'failed' : 'completed';
      const summary = finalRun.nodes
        .map((n) => `### [${n.nodeKey}] (${n.status}, model=${n.model || 'default'})\n${n.resultText || n.errorMessage || '(无输出)'}`)
        .join('\n\n');

      this.store.tx(() => {
        this.store.db
          .prepare('UPDATE swarm_runs SET status=?, usageJson=?, updatedAt=? WHERE id=?')
          .run(finalStatus, JSON.stringify(usageTotals), Date.now(), runId);
      });
      this.eventRouter?.emitPersisted({
        sessionId,
        turnId: rootTurnId,
        type: RUNTIME_EVENTS.SWARM_RUN_COMPLETED,
        data: { runId, status: finalStatus, usage: usageTotals },
        audit: true,
      });

      return { runId, status: finalStatus, summary, nodes: finalRun.nodes, usage: usageTotals };
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  closeAll() {
    for (const runId of [...this.activeRuns.keys()]) {
      this.cancelRun(runId);
    }
    this.childManager?.cancelAll?.();
  }
}
