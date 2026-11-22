import { Fault, id as uuid } from '../store.js';
import { BudgetError } from '../kernel/errors.js';
import { assertLeaseInTx } from '../durable/lease-guard.js';
import { allocatePlanBudgets } from '../planning/budget-estimator.js';
import { BUDGET_SCOPES, estimateRequestInputTokens } from './budget-ledger.js';
import { SWARM_NODE_STATES, isTerminalNodeState, transitionSwarmNode } from './node-state-machine.js';

let repoIntelligenceLoader = null;
async function loadRepoIntelligence() {
  if (!repoIntelligenceLoader) {
    repoIntelligenceLoader = import('../repo-intelligence.js').catch(() => null);
  }
  const mod = await repoIntelligenceLoader;
  if (!mod) {
    // Allow subsequent calls to retry if repo-intelligence.js lands later
    repoIntelligenceLoader = null;
  }
  return mod;
}

export async function analyzeWorkspaceRepository(
  workspaceRoot,
  { issueText = '', maxBytes = 12000, maxFiles = 120 } = {},
) {
  if (!workspaceRoot) return null;
  try {
    const mod = await loadRepoIntelligence();
    if (typeof mod?.analyzeRepository !== 'function') return null;
    return await mod.analyzeRepository(workspaceRoot, { issueText, maxBytes, maxFiles });
  } catch {
    return null;
  }
}

export function toCompactRepoContext(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;
  const relevantFiles = Array.isArray(analysis.callGraph?.relevantFiles)
    ? analysis.callGraph.relevantFiles
        .map((f) => (typeof f === 'string' ? f : f?.path))
        .filter(Boolean)
        .slice(0, 32)
    : Array.isArray(analysis.relevantFiles)
      ? analysis.relevantFiles.map(String).slice(0, 32)
      : [];
  return {
    branch: analysis.git?.branch ?? analysis.branch ?? null,
    headSha: analysis.git?.headSha ?? analysis.headSha ?? null,
    testCommands: Array.isArray(analysis.project?.testCommands)
      ? analysis.project.testCommands.map(String).slice(0, 10)
      : Array.isArray(analysis.testCommands)
        ? analysis.testCommands.map(String).slice(0, 10)
        : [],
    buildCommands: Array.isArray(analysis.project?.buildCommands)
      ? analysis.project.buildCommands.map(String).slice(0, 10)
      : Array.isArray(analysis.buildCommands)
        ? analysis.buildCommands.map(String).slice(0, 10)
        : [],
    entryPoints: Array.isArray(analysis.structure?.entryPoints)
      ? analysis.structure.entryPoints.map(String).slice(0, 16)
      : Array.isArray(analysis.entryPoints)
        ? analysis.entryPoints.map(String).slice(0, 16)
        : [],
    relevantFiles,
    filesScanned: Number(
      analysis.structure?.totalFiles ?? analysis.structure?.filesScanned ?? analysis.filesScanned ?? 0,
    ),
    hasNodeModules: analysis.project?.hasNodeModules ?? analysis.hasNodeModules ?? null,
    summaryText: String(analysis.summaryText ?? '').slice(0, 8000),
  };
}

export function formatRepoContextForPlanner(analysis, extraSummary = '') {
  const parts = [];
  if (extraSummary && String(extraSummary).trim()) {
    parts.push(String(extraSummary).trim());
  }
  if (analysis && typeof analysis === 'object') {
    if (analysis.summaryText && String(analysis.summaryText).trim()) {
      parts.push(String(analysis.summaryText).trim());
    }
    const compact = toCompactRepoContext(analysis);
    const metaLines = [];
    if (compact.branch) metaLines.push(`gitBranch: ${compact.branch}${compact.headSha ? ` (${compact.headSha.slice(0, 10)})` : ''}`);
    if (compact.testCommands.length) metaLines.push(`discoveredTestCommands: ${JSON.stringify(compact.testCommands)}`);
    if (compact.buildCommands.length) metaLines.push(`discoveredBuildCommands: ${JSON.stringify(compact.buildCommands)}`);
    if (compact.entryPoints.length) metaLines.push(`entryPoints: ${JSON.stringify(compact.entryPoints)}`);
    if (compact.relevantFiles.length) metaLines.push(`relevantFiles: ${JSON.stringify(compact.relevantFiles)}`);
    const edges = Array.isArray(analysis.callGraph?.edges) ? analysis.callGraph.edges.slice(0, 20) : [];
    if (edges.length) {
      metaLines.push(
        `callGraphEdges: ${edges.map((e) => `${e.from || e.source} -> ${e.to || e.target}`).join(', ')}`,
      );
    }
    if (metaLines.length) {
      parts.push(`[Repository Intelligence]\n${metaLines.join('\n')}`);
    }
  }
  return parts.join('\n\n').slice(0, 14000);
}

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function tryParseJson(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function scanBalancedJson(text) {
  const src = String(text ?? '');
  const parsed = [];
  for (let i = 0; i < src.length; i += 1) {
    const open = src[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < src.length; j += 1) {
      const ch = src[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          const obj = tryParseJson(src.slice(i, j + 1));
          if (obj) {
            parsed.push(obj);
            i = j;
          }
          break;
        }
      }
    }
  }
  return parsed;
}

function extractJsonBlock(text) {
  const raw = String(text ?? '').trim();
  const direct = tryParseJson(raw);
  if (direct) return direct;
  const fencedMatches = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fencedMatches.length - 1; i >= 0; i -= 1) {
    const parsed = tryParseJson(fencedMatches[i][1]);
    if (parsed) return parsed;
    const scanned = scanBalancedJson(fencedMatches[i][1]);
    if (scanned.length) return scanned[scanned.length - 1];
  }
  const scanned = scanBalancedJson(raw);
  return scanned.length ? scanned[scanned.length - 1] : null;
}

function sanitizeNodeKey(raw, idx, seen) {
  let base = String(raw || `node-${idx + 1}`)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base || !/^[A-Za-z0-9]/.test(base)) {
    base = `n-${base || idx + 1}`;
  }
  base = base.slice(0, 64);
  let unique = base;
  let suffix = 2;
  while (seen.has(unique)) {
    const tag = `-${suffix++}`;
    unique = `${base.slice(0, 64 - tag.length)}${tag}`;
  }
  seen.add(unique);
  return unique;
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
    const seen = new Set();
    const keyMap = new Map();
    const firstPass = rawNodes.map((n, idx) => {
      const rawKey = String(n.nodeKey || n.key || `node-${idx + 1}`).trim();
      const nodeKey = sanitizeNodeKey(rawKey, idx, seen);
      if (rawKey && !keyMap.has(rawKey)) keyMap.set(rawKey, nodeKey);
      return {
        nodeKey,
        objective: String(n.objective || '').trim() || `Subtask ${idx + 1}`,
        acceptance: String(n.acceptance || 'Provide concrete verified output'),
        taskType: String(n.taskType || 'research'),
        dependencies: Array.isArray(n.dependencies) ? n.dependencies.map(String) : [],
        toolCategories: Array.isArray(n.toolCategories) ? n.toolCategories : [],
        toolAllow: Array.isArray(n.toolAllow) ? n.toolAllow : null,
        permissionMode: n.permissionMode ? String(n.permissionMode) : null,
        isolatedWorktree: Boolean(n.isolatedWorktree),
        isolationMode: n.isolationMode ? String(n.isolationMode) : null,
        allowIsolationFallback: Boolean(n.allowIsolationFallback),
        roleTitle: n.roleTitle ? String(n.roleTitle).trim().slice(0, 120) : null,
        focus: n.focus ? String(n.focus).trim().slice(0, 240) : null,
        ownedPaths: Array.isArray(n.ownedPaths)
          ? [...new Set(n.ownedPaths.map((p) => String(p).trim()).filter(Boolean))].slice(0, 32)
          : [],
        priority: Number(n.priority ?? 0),
        budget: n.budget && typeof n.budget === 'object' ? { ...n.budget } : {},
      };
    });
    return firstPass.map((node) => ({
      ...node,
      dependencies: node.dependencies.map((dep) => {
        const trimmed = String(dep).trim();
        return keyMap.get(trimmed) ?? trimmed;
      }),
    }));
  }

  #applyAdaptiveBudgets(nodes, { budget = {}, store = null, model = null, repoContext = null } = {}) {
    const userBudget = budget && typeof budget === 'object' ? budget : {};
    const allocation = allocatePlanBudgets({ tasks: nodes, userBudget, store, model, repoContext });
    if (!allocation.feasible) {
      throw new BudgetError('BUDGET_INSUFFICIENT', {
        message: allocation.insufficientReason || 'Insufficient user budget for planned DAG',
        detail: allocation,
      });
    }
    const byKey = new Map(allocation.tasks.map((t) => [t.taskKey, t]));
    return nodes.map((node) => {
      const alloc = byKey.get(node.nodeKey);
      const hasExplicitSteps = Number.isFinite(Number(node.budget?.maxSteps ?? node.budget?.maxTotalSteps));
      return {
        ...node,
        budget: {
          ...(node.budget && typeof node.budget === 'object' ? node.budget : {}),
          ...(!hasExplicitSteps && alloc?.allocatedSteps ? { maxSteps: alloc.allocatedSteps } : {}),
          ...(alloc?.finalVerificationReserve != null && node.budget?.finalVerificationReserve == null
            ? { finalVerificationReserve: alloc.finalVerificationReserve }
            : {}),
        },
        ...(alloc?.estimate ? { budgetEstimate: alloc.estimate } : {}),
      };
    });
  }

  async decompose({
    goal,
    workspaceSummary = '',
    workspaceRoot = null,
    repoContext = null,
    maxNodes = 8,
    model = null,
    signal = undefined,
    budget = {},
    store = null,
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
    const effectiveAnalysis =
      repoContext && typeof repoContext === 'object'
        ? repoContext
        : workspaceRoot
          ? await analyzeWorkspaceRepository(workspaceRoot, { issueText: goal, maxBytes: 12000 })
          : null;
    const effectiveSummary = formatRepoContextForPlanner(effectiveAnalysis, workspaceSummary);
    const compactRepoContext = toCompactRepoContext(effectiveAnalysis);

    const attachRepoContext = (nodes) => {
      if (compactRepoContext) {
        Object.defineProperty(nodes, 'repoContext', {
          value: compactRepoContext,
          enumerable: false,
          configurable: true,
        });
      }
      return nodes;
    };

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
                '{"nodes":[{"nodeKey":"branch-a","taskType":"implementation","roleTitle":"API Specialist","focus":"...","ownedPaths":["src/api.js"],"objective":"...","acceptance":"...","dependencies":[],"isolatedWorktree":true,"priority":20}]}. ' +
                'Ground every node in the repository intelligence (entryPoints, relevantFiles, callGraph, discoveredTestCommands, discoveredBuildCommands). ' +
                'When independent modules/files can be built or fixed concurrently, emit multiple parallel "implementation" nodes with disjoint ownedPaths, specialized roleTitle/focus, shared or empty dependencies, and isolatedWorktree:true (no fixed team size limit; scale appropriately within maxNodes). ' +
                'Any test-authoring node whose tests import or execute newly added runtime APIs MUST list the corresponding implementation node(s) in dependencies so its isolated worktree receives those changes via artifact overlay (while independent modules like core code and TypeScript typings stay parallel). ' +
                'For mutating goals, include a downstream "verification" node (isolatedWorktree:true so upstream branch artifacts are overlaid) that executes discovered test/build commands via bash, and include a read-only "review" node (taskType:"review", permissionMode:"readonly", isolatedWorktree:false) when changes are mutating or review is requested. ' +
                `Use alphanumeric nodeKey matching ^[A-Za-z0-9][A-Za-z0-9._-]*$. Keep <= ${maxNodes} nodes. Return JSON only.`,
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: effectiveSummary ? `${goal}\n\nContext:\n${effectiveSummary}` : goal,
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
          requestedMaxOutputTokens: 8192,
          defaultMaxOutputTokens: 8192,
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
          maxTokens: reservation?.constrainedMaxOutputTokens ?? 8192,
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
          return attachRepoContext(
      this.#applyAdaptiveBudgets(normalized, {
        budget,
        store,
        model: picked,
        repoContext: compactRepoContext,
      }),
    );
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
    const testHint = compactRepoContext?.testCommands?.length
      ? `（优先运行已发现命令：${compactRepoContext.testCommands.join(' ; ')}）`
      : '';
    const fileHint = compactRepoContext?.relevantFiles?.length
      ? `（重点文件：${compactRepoContext.relevantFiles.slice(0, 6).join(', ')}）`
      : '';
    const fallback = isMutating
      ? [
          {
            nodeKey: 'analyze',
            taskType: 'research',
            roleTitle: 'Repository Architecture Researcher',
            objective: `调研工作区上下文并定位关键代码边界${fileHint}：${goal}`,
            acceptance: '给出精确文件路径、依赖约束与改动切入点',
            dependencies: [],
            priority: 20,
          },
          {
            nodeKey: 'implement',
            taskType: 'implementation',
            roleTitle: 'Core Implementation Specialist',
            objective: `按调研结论完成模块实现与边界检查${fileHint}：${goal}`,
            acceptance: '完成代码编写并保持最小职责边界',
            dependencies: ['analyze'],
            isolatedWorktree: true,
            allowIsolationFallback: true,
            priority: 10,
          },
          {
            nodeKey: 'verify',
            taskType: 'verification',
            roleTitle: 'Integration & Test Verifier',
            objective: `执行真实检查并汇总交付证据${testHint}：${goal}`,
            acceptance: '验证通过并报告完整证据',
            dependencies: ['implement'],
            isolatedWorktree: true,
            allowIsolationFallback: true,
            priority: 5,
          },
        ]
      : [
          {
            nodeKey: 'investigate',
            taskType: 'research',
            roleTitle: 'Repository Architecture Researcher',
            objective: `只读检索并收集关键事实${fileHint}：${goal}`,
            acceptance: '提供事实与源码位置摘要',
            dependencies: [],
            priority: 10,
          },
          {
            nodeKey: 'synthesize',
            taskType: 'review',
            roleTitle: 'Independent Code Reviewer',
            objective: `复核并归纳最终结论：${goal}`,
            acceptance: '生成准确清晰的总结结论',
            dependencies: ['investigate'],
            priority: 5,
          },
        ];
    const normalized = this.normalizeNodes(fallback);
    this.validateDag(normalized);
    return attachRepoContext(
      this.#applyAdaptiveBudgets(normalized, {
        budget,
        store,
        model: picked,
        repoContext: compactRepoContext,
      }),
    );
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
