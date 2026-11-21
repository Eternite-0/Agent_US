import { Fault, id as uuid } from '../store.js';
import { BudgetError } from '../kernel/errors.js';
import { assertLeaseInTx } from '../durable/lease-guard.js';
import { BUDGET_SCOPES, estimateRequestInputTokens } from './budget-ledger.js';
import { SWARM_NODE_STATES, isTerminalNodeState, transitionSwarmNode } from './node-state-machine.js';

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function extractJsonBlock(text) {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const arrStart = candidate.indexOf('[');
  if (start === -1 && arrStart === -1) return null;
  try {
    return JSON.parse(
      start !== -1 && (arrStart === -1 || start < arrStart)
        ? candidate.slice(start)
        : candidate.slice(arrStart),
    );
  } catch {
    return null;
  }
}

/**
 * Layer 6 DynamicTaskPlanner:
 * - Validates acyclic DAGs using Kahn topological sort
 * - Decomposes complex goals via LLM or deterministic adaptive fallback
 * - Supports live graph mutations: addNode, cancelNode, reprioritizeNode, replanFailedSubgraph
 */
export class DynamicTaskPlanner {
  constructor({ adapter = null, router = null } = {}) {
    this.adapter = adapter;
    this.router = router;
  }

  validateDag(nodes) {
    if (!Array.isArray(nodes) || !nodes.length) {
      throw new Fault('EMPTY_SWARM_DAG', 400);
    }
    const keys = new Set();
    for (const n of nodes) {
      if (!n?.nodeKey) throw new Fault('INVALID_SWARM_NODE', 400);
      if (keys.has(n.nodeKey)) {
        throw new Fault('DUPLICATE_SWARM_NODE', 400, { nodeKey: n.nodeKey });
      }
      keys.add(n.nodeKey);
    }

    const indegree = new Map();
    const adj = new Map();
    for (const n of nodes) {
      indegree.set(n.nodeKey, 0);
      adj.set(n.nodeKey, []);
    }
    for (const n of nodes) {
      for (const dep of n.dependencies ?? []) {
        if (!keys.has(dep)) {
          throw new Fault('UNKNOWN_SWARM_DEPENDENCY', 400, { nodeKey: n.nodeKey, dep });
        }
        adj.get(dep).push(n.nodeKey);
        indegree.set(n.nodeKey, indegree.get(n.nodeKey) + 1);
      }
    }

    const queue = [];
    for (const [k, deg] of indegree.entries()) {
      if (deg === 0) queue.push(k);
    }
    let visited = 0;
    while (queue.length) {
      const cur = queue.shift();
      visited++;
      for (const nxt of adj.get(cur)) {
        indegree.set(nxt, indegree.get(nxt) - 1);
        if (indegree.get(nxt) === 0) queue.push(nxt);
      }
    }
    if (visited !== nodes.length) {
      throw new Fault('SWARM_DAG_CYCLE', 400, {
        message: 'Swarm DAG contains a dependency cycle',
      });
    }
    return true;
  }

  normalizeNodes(rawNodes) {
    return rawNodes.map((n, idx) => ({
      nodeKey: String(n.nodeKey || n.key || `node-${idx + 1}`).slice(0, 64),
      objective: String(n.objective || '').trim() || `Subtask ${idx + 1}`,
      acceptance: String(n.acceptance || 'Provide concrete verified output'),
      taskType: String(n.taskType || 'research'),
      dependencies: Array.isArray(n.dependencies) ? n.dependencies.map(String) : [],
      toolCategories: Array.isArray(n.toolCategories) ? n.toolCategories : [],
      toolAllow: Array.isArray(n.toolAllow) ? n.toolAllow : null,
      isolatedWorktree: Boolean(n.isolatedWorktree),
      isolationMode: n.isolationMode ? String(n.isolationMode) : null,
      allowIsolationFallback: Boolean(n.allowIsolationFallback),
      priority: Number(n.priority ?? 0),
      budget: n.budget && typeof n.budget === 'object' ? { ...n.budget } : {},
    }));
  }

  async decompose({
    goal,
    workspaceSummary = '',
    maxNodes = 6,
    model = null,
    signal = undefined,
    budgetLedger = null,
    treeId = null,
    sessionId = null,
    leaseGuard = null,
  }) {
    if (budgetLedger && treeId && budgetLedger.isExhausted(treeId)) {
      throw new BudgetError('BUDGET_EXCEEDED', {
        message: 'Task-tree budget exhausted before planning',
        detail: { treeId, scope: BUDGET_SCOPES.PLANNING },
      });
    }
    const picked = model || this.router?.select({ taskType: 'planning', objective: goal })?.model;
    if (this.adapter && picked) {
      const messages = [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text:
                'Decompose the engineering goal into an acyclic JSON DAG: ' +
                '{"nodes":[{"nodeKey":"research","taskType":"research","objective":"...","acceptance":"...","dependencies":[],"isolatedWorktree":false,"priority":10}]}. ' +
                `Keep <= ${maxNodes} nodes. Return JSON only.`,
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: workspaceSummary ? `${goal}\n\nContext:\n${workspaceSummary}` : goal,
            },
          ],
        },
      ];
      let reservation = null;
      if (budgetLedger && treeId) {
        reservation = budgetLedger.reserveInference({
          treeId,
          scope: BUDGET_SCOPES.PLANNING,
          sessionId,
          estimatedInputTokens: estimateRequestInputTokens({ messages }),
          requestedMaxOutputTokens: 1200,
          defaultMaxOutputTokens: 1200,
          leaseGuard,
        });
      }
      let txt = '';
      const usage = { inputTokens: 0, outputTokens: 0 };
      try {
        for await (const chunk of this.adapter.stream({
          provider: 'pool',
          model: picked,
          messages,
          maxTokens: reservation?.constrainedMaxOutputTokens ?? 1200,
          signal,
        })) {
          if (chunk.type === 'text-delta') txt += chunk.text;
          else if (chunk.type === 'usage' && chunk.usage) {
            usage.inputTokens += Number(chunk.usage.inputTokens ?? 0);
            usage.outputTokens += Number(chunk.usage.outputTokens ?? 0);
          }
        }
        if (reservation?.reservationId) {
          budgetLedger.settleReservation(reservation.reservationId, {
            status: 'settled',
            actualSteps: 1,
            actualInputTokens: usage.inputTokens,
            actualOutputTokens: usage.outputTokens,
            leaseGuard,
          });
        }
        const parsed = extractJsonBlock(txt);
        const rawList = Array.isArray(parsed) ? parsed : parsed?.nodes;
        if (Array.isArray(rawList) && rawList.length > 0 && rawList.every((x) => x?.objective)) {
          const normalized = this.normalizeNodes(rawList.slice(0, maxNodes));
          this.validateDag(normalized);
          return normalized;
        }
      } catch (err) {
        if (reservation?.reservationId) {
          try {
            budgetLedger.settleReservation(reservation.reservationId, {
              status: 'failed',
              actualSteps: 1,
              actualInputTokens: usage.inputTokens,
              actualOutputTokens: usage.outputTokens,
              errorCode: err?.code || 'PLANNING_FAILED',
              leaseGuard: err?.code === 'LEASE_LOST' ? null : leaseGuard,
            });
          } catch {
            // do not mask LEASE_LOST or primary error
          }
        }
        if (err?.code === 'LEASE_LOST' || err instanceof BudgetError || err?.category === 'budget') {
          throw err;
        }
        // Fall through to deterministic heuristic decomposition
      }
    }

    const isMutating = /implement|edit|write|fix|refactor|create|实现|重构|修改|新增|修复/i.test(
      goal,
    );
    const fallback = isMutating
      ? [
          {
            nodeKey: 'analyze',
            taskType: 'research',
            objective: `调研工作区上下文并定位关键代码边界：${goal}`,
            acceptance: '给出精确文件路径、依赖约束与改动切入点',
            dependencies: [],
            priority: 20,
          },
          {
            nodeKey: 'implement',
            taskType: 'implementation',
            objective: `按调研结论完成模块实现与边界检查：${goal}`,
            acceptance: '完成代码编写并保持最小职责边界',
            dependencies: ['analyze'],
            isolatedWorktree: true,
            allowIsolationFallback: true,
            priority: 10,
          },
          {
            nodeKey: 'verify',
            taskType: 'verification',
            objective: `执行真实检查并汇总交付证据：${goal}`,
            acceptance: '验证通过并报告完整证据',
            dependencies: ['implement'],
            priority: 5,
          },
        ]
      : [
          {
            nodeKey: 'investigate',
            taskType: 'research',
            objective: `只读检索并收集关键事实：${goal}`,
            acceptance: '提供事实与源码位置摘要',
            dependencies: [],
            priority: 10,
          },
          {
            nodeKey: 'synthesize',
            taskType: 'review',
            objective: `复核并归纳最终结论：${goal}`,
            acceptance: '生成准确清晰的总结结论',
            dependencies: ['investigate'],
            priority: 5,
          },
        ];
    const normalized = this.normalizeNodes(fallback);
    this.validateDag(normalized);
    return normalized;
  }

  addNode(store, runId, nodeSpec, { leaseGuard = null } = {}) {
    const normalized = this.normalizeNodes([nodeSpec])[0];
    const now = Date.now();
    const id = uuid();
    const profileId = this.router?.agentRegistry?.synthesizeProfile({
      taskType: normalized.taskType,
      objective: normalized.objective,
    })?.id ?? normalized.taskType;
    return store.tx(() => {
      assertLeaseInTx(leaseGuard, { runId });
      const existing = store.db
        .prepare('SELECT nodeKey, dependenciesJson FROM swarm_nodes WHERE runId=?')
        .all(runId)
        .map((r) => ({
          nodeKey: r.nodeKey,
          dependencies: parseJsonSafe(r.dependenciesJson, []),
        }));
      this.validateDag([...existing, normalized]);
      store.db
        .prepare(
          `INSERT INTO swarm_nodes(
            id, runId, nodeKey, agentProfileId, objective, acceptance, dependenciesJson,
            toolAllowJson, status, priority, budgetJson, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,?,?,'pending',?,'{}',?,?)`,
        )
        .run(
          id,
          runId,
          normalized.nodeKey,
          profileId,
          normalized.objective,
          normalized.acceptance,
          JSON.stringify(normalized.dependencies),
          Array.isArray(normalized.toolAllow) ? JSON.stringify(normalized.toolAllow) : null,
          normalized.priority,
          now,
          now,
        );
      return store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(id);
    });
  }

  cancelNode(
    store,
    runId,
    nodeKey,
    reason = 'cancelled',
    { eventRouter = null, sessionId = null, rootTurnId = null, leaseGuard = null } = {},
  ) {
    const row = store.db
      .prepare('SELECT * FROM swarm_nodes WHERE runId=? AND nodeKey=?')
      .get(runId, nodeKey);
    if (!row) return null;
    if (isTerminalNodeState(row.status)) return row;
    return transitionSwarmNode(store, eventRouter, row.id, SWARM_NODE_STATES.CANCELLED, {
      sessionId,
      rootTurnId,
      leaseGuard,
      emitEvent: Boolean(eventRouter && sessionId),
      patch: {
        errorCode: 'NODE_CANCELLED',
        errorMessage: reason,
      },
    });
  }

  reprioritizeNode(store, runId, nodeKey, priority) {
    store.tx(() => {
      store.db
        .prepare('UPDATE swarm_nodes SET priority=?, updatedAt=? WHERE runId=? AND nodeKey=?')
        .run(Number(priority), Date.now(), runId, nodeKey);
    });
    return store.db
      .prepare('SELECT * FROM swarm_nodes WHERE runId=? AND nodeKey=?')
      .get(runId, nodeKey);
  }

  replanFailedSubgraph(store, runId, failedNodeKey, replacementNodes) {
    const added = [];
    for (const spec of this.normalizeNodes(replacementNodes)) {
      const node = this.addNode(store, runId, {
        ...spec,
        dependencies: spec.dependencies.filter((d) => d !== failedNodeKey),
      });
      added.push(node);
    }
    return added;
  }
}
