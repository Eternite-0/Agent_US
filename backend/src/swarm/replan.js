import { id as uuid } from '../store.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import { BudgetError } from '../kernel/errors.js';
import { assertLeaseInTx } from '../durable/lease-guard.js';
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

function safeGet(db, sql, ...params) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    return db.prepare(sql).get(...params) ?? null;
  } catch {
    return null;
  }
}

function safeAll(db, sql, ...params) {
  if (!db || typeof db.prepare !== 'function') return [];
  try {
    const rows = db.prepare(sql).all(...params);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

const VALID_DIAGNOSIS_STRATEGIES = new Set([
  'retry_same',
  'switch_model',
  'split_subgraph',
  'repair_and_reverify',
  'abort',
]);

const VALID_FAILURE_CLASSES = new Set([
  'transient',
  'model_capability',
  'decomposition',
  'verification',
  'environment',
  'permission',
  'unknown',
]);

function extractJsonObject(rawText) {
  const s = String(rawText ?? '').trim();
  if (!s) return null;
  const direct = parseJsonSafe(s, null);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;

  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const parsed = parseJsonSafe(fenced[1].trim(), null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }

  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const parsed = parseJsonSafe(s.slice(firstBrace, lastBrace + 1), null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }
  return null;
}

/**
 * Deterministically gathers concrete execution evidence for a failed swarm node:
 * tool_receipts, node errors/tool excerpts, modified files, and prior swarm_replans rows.
 */
export function collectFailureEvidence(runId, failedNode, { store = null } = {}) {
  const db = store?.db ?? null;
  const nodeKey = failedNode?.nodeKey ?? null;
  const nodeId = failedNode?.id ?? null;

  let liveNode = null;
  if (db && (nodeId || (runId && nodeKey))) {
    liveNode = nodeId
      ? safeGet(db, 'SELECT * FROM swarm_nodes WHERE id=?', nodeId)
      : safeGet(db, 'SELECT * FROM swarm_nodes WHERE runId=? AND nodeKey=?', runId, nodeKey);
  }
  const effectiveNode = liveNode ? { ...failedNode, ...liveNode } : { ...(failedNode ?? {}) };
  const effectiveNodeKey = effectiveNode.nodeKey ?? nodeKey ?? null;
  const effectiveNodeId = effectiveNode.id ?? nodeId ?? null;
  const childSessionId = effectiveNode.childSessionId ?? null;
  const childTurnId = effectiveNode.childTurnId ?? null;

  const runRow = db && runId ? safeGet(db, 'SELECT id, goal, status, planVersion, replanCount FROM swarm_runs WHERE id=?', runId) : null;

  // 1. Collect tool_receipts scoped to childTurnId / childSessionId / nodeId / runId
  let rawReceipts = [];
  if (db) {
    const conditions = [];
    const params = [];
    if (childTurnId) {
      conditions.push('turnId=?');
      params.push(childTurnId);
    }
    if (childSessionId) {
      conditions.push('sessionId=?');
      params.push(childSessionId);
    }
    if (effectiveNodeId) {
      conditions.push('taskId=?');
      params.push(effectiveNodeId);
    }
    if (runId) {
      conditions.push('taskId=?');
      params.push(runId);
    }
    if (conditions.length > 0) {
      rawReceipts = safeAll(
        db,
        `SELECT id, callId, toolName, status, exitCode, errorCode, reconciliationNote, createdAt
         FROM tool_receipts
         WHERE ${conditions.join(' OR ')}
         ORDER BY createdAt DESC LIMIT 30`,
        ...params,
      );
    }
  }
  const toolReceipts = rawReceipts.map((r) => ({
    toolName: r.toolName,
    status: r.status,
    exitCode: r.exitCode ?? null,
    errorCode: r.errorCode ?? null,
    note: r.reconciliationNote ? String(r.reconciliationNote).slice(0, 200) : null,
  }));
  const failedReceipts = toolReceipts.filter(
    (r) =>
      r.status !== 'finished' ||
      (r.exitCode !== null && r.exitCode !== 0) ||
      Boolean(r.errorCode),
  );

  // 2. Collect tool error / failure excerpts from childSessionId direct_messages
  const toolExcerpts = [];
  if (db && childSessionId) {
    const msgRows = childTurnId
      ? safeAll(
          db,
          `SELECT seq, role, toolName, content, meta FROM direct_messages
           WHERE sessionId=? AND turnId=? AND role='tool' ORDER BY seq DESC LIMIT 15`,
          childSessionId,
          childTurnId,
        )
      : safeAll(
          db,
          `SELECT seq, role, toolName, content, meta FROM direct_messages
           WHERE sessionId=? AND role='tool' ORDER BY seq DESC LIMIT 15`,
          childSessionId,
        );
    for (const row of msgRows) {
      const text = String(row.content || '');
      const meta = parseJsonSafe(row.meta, {});
      const isFailure =
        meta?.isError === true ||
        /exitCode:\s*[1-9]|AssertionError|TypeError|Error:|FAIL|ENOENT|ERR_/i.test(text);
      if (isFailure || toolExcerpts.length < 2) {
        toolExcerpts.push({
          toolName: row.toolName || 'tool',
          isError: Boolean(isFailure),
          excerpt: text.slice(0, 400),
        });
      }
      if (toolExcerpts.length >= 5) break;
    }
  }

  // 3. Collect modified files from turn_snapshots & swarm_artifacts
  const modifiedSet = new Set();
  if (Array.isArray(effectiveNode.modifiedFiles)) {
    for (const f of effectiveNode.modifiedFiles) {
      if (typeof f === 'string' && f.trim()) modifiedSet.add(f.trim());
      else if (f?.path) modifiedSet.add(String(f.path).trim());
    }
  }
  if (db && (childTurnId || childSessionId)) {
    const snaps = childTurnId
      ? safeAll(db, 'SELECT DISTINCT path FROM turn_snapshots WHERE turnId=?', childTurnId)
      : safeAll(db, 'SELECT DISTINCT path FROM turn_snapshots WHERE sessionId=?', childSessionId);
    for (const s of snaps) {
      if (s?.path) modifiedSet.add(String(s.path));
    }
  }
  if (db && runId && (effectiveNodeKey || effectiveNodeId)) {
    const artifacts = safeAll(
      db,
      `SELECT manifestJson FROM swarm_artifacts
       WHERE runId=? AND (nodeKey=? OR nodeId=?) ORDER BY attempt DESC LIMIT 5`,
      runId,
      effectiveNodeKey || '',
      effectiveNodeId || '',
    );
    for (const a of artifacts) {
      const manifest = parseJsonSafe(a.manifestJson, {});
      for (const ent of manifest?.entries ?? []) {
        if (ent?.path) modifiedSet.add(String(ent.path));
      }
    }
  }

  // 4. Collect prior swarm_replans rows for failedNode.nodeKey (plus run-wide failed models)
  const priorReplans = [];
  const priorStrategies = [];
  const priorAvoidPatterns = [];
  const priorFailedModels = [];
  if (db && runId) {
    const replanRows = effectiveNodeKey
      ? safeAll(
          db,
          `SELECT id, version, failedNodeKey, strategy, reason, diffJson, createdAt
           FROM swarm_replans WHERE runId=? AND failedNodeKey=? ORDER BY version ASC`,
          runId,
          effectiveNodeKey,
        )
      : [];
    for (const r of replanRows) {
      const diff = parseJsonSafe(r.diffJson, {});
      priorReplans.push({
        version: r.version,
        strategy: r.strategy,
        reason: r.reason ? String(r.reason).slice(0, 240) : '',
        diff,
        createdAt: r.createdAt,
      });
      if (r.strategy && !priorStrategies.includes(r.strategy)) {
        priorStrategies.push(r.strategy);
      }
      const patterns = diff?.structuredDiagnosis?.avoidPatterns ?? diff?.avoidPatterns ?? [];
      if (Array.isArray(patterns)) {
        for (const p of patterns) {
          const s = String(p || '').trim();
          if (s && !priorAvoidPatterns.includes(s)) priorAvoidPatterns.push(s);
        }
      }
    }
    const switchRows = safeAll(
      db,
      "SELECT diffJson FROM swarm_replans WHERE runId=? AND strategy='switch_model'",
      runId,
    );
    for (const r of switchRows) {
      const d = parseJsonSafe(r.diffJson, {});
      if (d?.fromModel && !priorFailedModels.includes(d.fromModel)) {
        priorFailedModels.push(d.fromModel);
      }
    }
  }

  const parsedNodeBudget = parseJsonSafe(effectiveNode.budgetJson, {});
  return {
    runId: runId ?? null,
    runGoal: runRow?.goal ?? null,
    nodeId: effectiveNodeId,
    nodeKey: effectiveNodeKey,
    taskType: effectiveNode.taskType ?? null,
    model: effectiveNode.model ?? null,
    attempts: Number(effectiveNode.attempts ?? 0),
    objective: effectiveNode.objective ? String(effectiveNode.objective).slice(0, 600) : '',
    errorCode: effectiveNode.errorCode ?? null,
    errorMessage: effectiveNode.errorMessage ? String(effectiveNode.errorMessage).slice(0, 800) : null,
    resultExcerpt: effectiveNode.resultText ? String(effectiveNode.resultText).slice(-800) : '',
    verificationResult: parsedNodeBudget?.verificationResult ?? null,
    toolReceipts,
    failedReceipts,
    toolExcerpts,
    modifiedFiles: [...modifiedSet].slice(0, 40),
    priorReplans,
    priorStrategies,
    priorAvoidPatterns,
    priorFailedModels,
  };
}

function parseDiagnosticResponse(rawText, evidence, { errorCode = null, errorMessage = null } = {}) {
  const trimmed = String(rawText ?? '').trim();
  const parsed = extractJsonObject(trimmed);
  const priorSet = new Set(evidence?.priorStrategies ?? []);

  let rootCause = '';
  let failureClass = 'unknown';
  let strategy = null;
  let nextObjectivePatch = '';
  let avoidPatterns = [];
  let parsedJson = false;

  if (parsed) {
    parsedJson = Boolean(parsed.rootCause || parsed.root_cause || parsed.strategy);
    rootCause = String(parsed.rootCause ?? parsed.root_cause ?? '').trim().slice(0, 500);
    const rawClass = String(parsed.failureClass ?? parsed.failure_class ?? 'unknown').trim().toLowerCase();
    failureClass = VALID_FAILURE_CLASSES.has(rawClass) ? rawClass : 'unknown';
    const rawStrat = String(parsed.strategy ?? '').trim().toLowerCase();
    if (VALID_DIAGNOSIS_STRATEGIES.has(rawStrat)) {
      strategy = rawStrat;
    }
    nextObjectivePatch = String(
      parsed.nextObjectivePatch ?? parsed.next_objective_patch ?? parsed.objectivePatch ?? '',
    )
      .trim()
      .slice(0, 600);
    if (Array.isArray(parsed.avoidPatterns ?? parsed.avoid_patterns)) {
      avoidPatterns = (parsed.avoidPatterns ?? parsed.avoid_patterns)
        .map((p) => String(p ?? '').trim().slice(0, 200))
        .filter(Boolean);
    }
  }

  if (!rootCause) {
    rootCause =
      trimmed.slice(0, 300) ||
      String(errorMessage || evidence?.errorMessage || errorCode || evidence?.errorCode || 'Unknown failure').slice(
        0,
        300,
      );
  }
  if (!strategy) {
    const lower = trimmed.toLowerCase();
    if (lower.includes('split_subgraph')) strategy = 'split_subgraph';
    else if (lower.includes('switch_model')) strategy = 'switch_model';
    else if (lower.includes('repair_and_reverify')) strategy = 'repair_and_reverify';
    else if (lower.includes('abort')) strategy = 'abort';
    else strategy = 'retry_same';
  }

  // Prevent repeating an already-failed strategy unchanged
  let repeatedStrategyAvoided = false;
  let replacedStrategy = null;
  const isUnchangedRetry =
    strategy === 'retry_same' &&
    priorSet.has('retry_same') &&
    !nextObjectivePatch;
  const isRepeatedSwitch =
    strategy === 'switch_model' &&
    priorSet.has('switch_model') &&
    evidence?.priorReplans?.some(
      (r) => r.strategy === 'switch_model' && r.diff?.toModel && r.diff.toModel === evidence?.model,
    );
  const isRepeatedSplit = strategy === 'split_subgraph' && priorSet.has('split_subgraph');

  if (
    (priorSet.has(strategy) && strategy !== 'switch_model' && (!nextObjectivePatch || strategy === 'retry_same')) ||
    isUnchangedRetry ||
    isRepeatedSwitch ||
    isRepeatedSplit
  ) {
    repeatedStrategyAvoided = true;
    replacedStrategy = strategy;
    avoidPatterns.push(`Do not repeat already-failed strategy "${strategy}" unchanged`);
    if (strategy === 'retry_same') {
      strategy = !priorSet.has('switch_model')
        ? 'switch_model'
        : !priorSet.has('split_subgraph')
          ? 'split_subgraph'
          : 'abort';
    } else if (strategy === 'switch_model') {
      strategy = !priorSet.has('split_subgraph') ? 'split_subgraph' : 'abort';
    } else {
      strategy = 'abort';
    }
  }

  const mergedAvoid = [...new Set([...(evidence?.priorAvoidPatterns ?? []), ...avoidPatterns])].slice(0, 12);

  return {
    rootCause,
    failureClass,
    strategy,
    nextObjectivePatch,
    avoidPatterns: mergedAvoid,
    repeatedStrategyAvoided,
    ...(replacedStrategy ? { replacedStrategy } : {}),
    parsedJson,
  };
}

const NON_REPLANABLE_ERRORS = new Set([
  'WORKTREE_ISOLATION_FAILED',
  'WORKTREE_ARTIFACT_CONFLICT',
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

const DEFAULT_REPAIR_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'apply_patch',
  'glob',
  'grep',
  'read_blob',
  'inspect_repository',
  'query_symbol_graph',
  'bash',
  'read_swarm_artifact',
];

const DEFAULT_REVERIFY_TOOLS = [
  'read_file',
  'glob',
  'grep',
  'read_blob',
  'bash',
  'start_process',
  'stop_process',
  'inspect_repository',
  'query_symbol_graph',
  'read_swarm_artifact',
];

const DEFAULT_REVIEW_TOOLS = [
  'read_file',
  'glob',
  'grep',
  'read_blob',
  'read_swarm_artifact',
];

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
   * Deterministically gathers runtime evidence (tool_receipts, node errors/excerpts,
   * modified files, and prior swarm_replans) for a failed swarm node.
   */
  collectFailureEvidence(runId, failedNode) {
    return collectFailureEvidence(runId, failedNode, { store: this.store });
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
    leaseGuard = null,
  }) {
    const adapter = this.adapter;
    if (!adapter) return null;
    const picked =
      model ||
      this.router?.select?.({ taskType: 'planning', objective: failedNode?.objective || '' })?.model ||
      failedNode?.model;
    if (!picked) return null;

    const evidence = this.collectFailureEvidence(run?.id, failedNode);
    const effErrorCode = errorCode || evidence.errorCode || 'UNKNOWN';
    const effErrorMessage = errorMessage || evidence.errorMessage || '';

    const evidenceLines = [
      evidence.runGoal ? `Run Goal: ${String(evidence.runGoal).slice(0, 400)}` : '',
      `Node: ${failedNode?.nodeKey ?? evidence.nodeKey} (taskType=${failedNode?.taskType ?? evidence.taskType ?? 'general'}, model=${failedNode?.model ?? evidence.model ?? 'unknown'}, attempts=${failedNode?.attempts ?? evidence.attempts ?? 1})`,
      `Objective: ${failedNode?.objective ?? evidence.objective}`,
      `Error: ${effErrorCode}: ${effErrorMessage}`,
      evidence.failedReceipts.length
        ? `Failed Tool Receipts:\n${evidence.failedReceipts
            .slice(0, 8)
            .map(
              (r) =>
                `- ${r.toolName}: status=${r.status} exit=${r.exitCode ?? '-'} error=${r.errorCode ?? '-'}${r.note ? ` (${r.note})` : ''}`,
            )
            .join('\n')}`
        : evidence.toolReceipts.length
          ? `Tool Receipts (${evidence.toolReceipts.length}): ${evidence.toolReceipts
              .slice(0, 6)
              .map((r) => `${r.toolName}:${r.status}(exit=${r.exitCode ?? '-'})`)
              .join(', ')}`
          : '',
      evidence.toolExcerpts.length
        ? `Tool Error Excerpts:\n${evidence.toolExcerpts
            .slice(0, 4)
            .map((e) => `- [${e.toolName}${e.isError ? ' ERROR' : ''}] ${e.excerpt}`)
            .join('\n')}`
        : '',
      evidence.resultExcerpt ? `Node Result Excerpt:\n${evidence.resultExcerpt.slice(0, 500)}` : '',
      evidence.modifiedFiles.length
        ? `Modified Files: ${evidence.modifiedFiles.slice(0, 15).join(', ')}`
        : '',
      evidence.priorReplans.length
        ? `Prior Replan History for ${failedNode?.nodeKey ?? evidence.nodeKey} (DO NOT repeat an already-failed strategy unchanged):\n${evidence.priorReplans
            .map((r) => `- v${r.version} strategy=${r.strategy} reason=${r.reason}`)
            .join('\n')}`
        : '',
      evidence.priorAvoidPatterns.length
        ? `Known Avoid Patterns:\n- ${evidence.priorAvoidPatterns.join('\n- ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const ledger = budgetLedger ?? this.budgetLedger;
    const messages = [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text:
              'Diagnose why this swarm node failed using the concrete execution evidence and prior replan history. ' +
              'Never repeat an already-failed strategy unchanged. ' +
              'Respond strictly with a JSON object: {"rootCause":"...","failureClass":"transient|model_capability|decomposition|verification|environment|permission","strategy":"retry_same|switch_model|split_subgraph|repair_and_reverify|abort","nextObjectivePatch":"...","avoidPatterns":["..."]}.',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: evidenceLines,
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
        requestedMaxOutputTokens: 2048,
        defaultMaxOutputTokens: 2048,
        leaseGuard,
      });
    }

    let text = '';
    const usage = { inputTokens: 0, outputTokens: 0 };
    try {
      for await (const chunk of adapter.stream({
        provider: 'pool',
        model: picked,
        messages,
        maxTokens: reservation?.constrainedMaxOutputTokens ?? 2048,
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
          leaseGuard,
        });
      }
      const trimmed = text.trim();
      const diagnosis = parseDiagnosticResponse(trimmed, evidence, {
        errorCode: effErrorCode,
        errorMessage: effErrorMessage,
      });
      return { text: trimmed, usage, diagnosis, evidence };
    } catch (err) {
      if (reservation?.reservationId) {
        try {
          ledger.settleReservation(reservation.reservationId, {
            status: 'failed',
            actualSteps: 1,
            actualInputTokens: usage.inputTokens,
            actualOutputTokens: usage.outputTokens,
            errorCode: err?.code || 'REPLAN_DIAGNOSIS_FAILED',
            leaseGuard: err?.code === 'LEASE_LOST' ? null : leaseGuard,
          });
        } catch {
          // ignore settle error when lease already lost
        }
      }
      throw err;
    }
  }

  #collectSupersededKeysInTx(runId) {
    const rows = this.store.db
      .prepare(
        "SELECT failedNodeKey, strategy, diffJson FROM swarm_replans WHERE runId=? AND strategy IN ('split_subgraph', 'repair_and_reverify')",
      )
      .all(runId);
    const superseded = new Set();
    for (const r of rows) {
      if (r.strategy === 'split_subgraph') {
        if (r.failedNodeKey) superseded.add(r.failedNodeKey);
      } else if (r.strategy === 'repair_and_reverify') {
        const diff = parseJsonSafe(r.diffJson, {});
        if (Array.isArray(diff.supersededNodeKeys)) {
          for (const k of diff.supersededNodeKeys) {
            if (k) superseded.add(k);
          }
        } else if (r.failedNodeKey) {
          superseded.add(r.failedNodeKey);
        }
      }
    }
    return superseded;
  }

  #finalizeReplanInTx({
    liveRun,
    nextVersion,
    nextReplanCount,
    currentPlanVersion,
    currentReplanCount,
    failedNodeKey,
    supersedeNodeRefs = [],
    currentJobId = '',
    strategy,
    reason,
    diff,
    updatedNode = null,
    now = Date.now(),
  }) {
    for (const ref of supersedeNodeRefs) {
      const refId = ref?.id ?? null;
      const refKey = ref?.nodeKey ?? null;
      if (refId || refKey) {
        this.store.db
          .prepare(
            `UPDATE swarm_artifacts
             SET status='superseded', updatedAt=?
             WHERE runId=? AND (nodeId=? OR nodeKey=?) AND status NOT IN ('applied', 'superseded')`,
          )
          .run(now, liveRun.id, refId || '', refKey || '');
      }
      if (refKey) {
        this.store.db
          .prepare(
            `UPDATE runtime_jobs
             SET status='cancelled', errorMessage='NODE_REPLANNED', leaseExpiresAt=NULL, updatedAt=?
             WHERE taskId=? AND turnId=? AND id != ?
               AND status IN ('pending','parked','reconciling')`,
          )
          .run(now, liveRun.id, `swarm:${liveRun.id}:${refKey}`, currentJobId);
      }
    }

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
        failedNodeKey,
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
  }

  #emitReplanEvents({ runId, failedNodeKey, outcome }) {
    if (!outcome?.replanned) return;

    if (outcome.updatedNode && outcome.sessionId && this.eventRouter) {
      try {
        this.eventRouter.emitPersisted({
          sessionId: outcome.sessionId,
          turnId: outcome.rootTurnId,
          type: RUNTIME_EVENTS.SWARM_NODE_UPDATED,
          data: {
            runId,
            nodeId: outcome.updatedNode.id,
            nodeKey: outcome.updatedNode.nodeKey,
            status: outcome.updatedNode.status,
            childSessionId: outcome.updatedNode.childSessionId || undefined,
            errorCode: outcome.updatedNode.errorCode || undefined,
          },
          audit: false,
        });
      } catch {
        // best-effort event emission after committed replan
      }
    }

    try {
      this.eventRouter?.emitPersisted({
        sessionId: outcome.sessionId,
        turnId: outcome.rootTurnId,
        type: RUNTIME_EVENTS.SWARM_REPLANNED,
        data: {
          replanId: outcome.replanId,
          runId,
          version: outcome.version,
          replanCount: outcome.replanCount,
          failedNodeKey,
          strategy: outcome.strategy,
          reason: outcome.reason,
          diff: outcome.diff,
        },
        audit: true,
      });
    } catch {
      // best-effort event emission after committed replan
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
    repairContext = null,
    signal = undefined,
    leaseGuard = null,
  }) {
    const codeStr = String(errorCode || '');
    if (NON_REPLANABLE_ERRORS.has(codeStr) || isBudgetErrorCode(codeStr)) {
      return { replanned: false, strategy: 'none', reason: `NON_REPLANABLE:${codeStr}` };
    }

    if (repairContext || codeStr === 'VERIFICATION_FAILED') {
      return this.replanRepairAndReverify({
        run,
        triggerNode: failedNode,
        errorCode: codeStr || 'VERIFICATION_FAILED',
        errorMessage,
        failureDiagnostics: repairContext?.failureDiagnostics ?? errorMessage,
        reviewerFindings: repairContext?.reviewerFindings ?? [],
        testCommands: repairContext?.testCommands ?? [],
        wantVerification: Boolean(repairContext?.wantVerification),
        maxReplans,
        budgetLedger,
        leaseGuard,
      });
    }

    const activeLedger = budgetLedger ?? this.budgetLedger;
    let diagnosisNote = null;
    let diagnosisResult = null;
    if (useModelDiagnosis && this.adapter) {
      try {
        const diag = await this.diagnoseWithModel({
          run,
          failedNode,
          errorCode,
          errorMessage,
          budgetLedger: activeLedger,
          signal,
          leaseGuard,
        });
        diagnosisResult = diag ?? null;
        diagnosisNote = diag?.text || null;
      } catch (err) {
        if (err?.code === 'LEASE_LOST') throw err;
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
      assertLeaseInTx(leaseGuard, { runId: run.id, nodeId: failedNode?.id });
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

      const priorNodeReplans = this.store.db
        .prepare(
          'SELECT version, strategy, reason, diffJson FROM swarm_replans WHERE runId=? AND failedNodeKey=? ORDER BY version ASC',
        )
        .all(liveRun.id, liveNode.nodeKey);
      const priorNodeStrategies = new Set(priorNodeReplans.map((r) => r.strategy));

      if (priorNodeStrategies.has('split_subgraph')) {
        return { replanned: false, strategy: 'none', reason: 'ALREADY_REPLANNED' };
      }

      const structuredDiag = diagnosisResult?.diagnosis ?? null;
      if (structuredDiag?.parsedJson && structuredDiag.strategy === 'abort') {
        return {
          replanned: false,
          strategy: 'none',
          reason: `DIAGNOSIS_ABORT:${String(structuredDiag.rootCause || 'aborted').slice(0, 120)}`,
          diagnosis: structuredDiag,
        };
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

      const resetPatch = {
        activeFence: null,
        activeJobId: null,
        childSessionId: null,
        childTurnId: null,
        worktreeLeaseId: null,
        worktreePath: null,
        latestArtifactId: null,
        artifactUrisJson: '[]',
        resultText: null,
        reconcileApprovalId: null,
        errorCode: null,
        errorMessage: null,
      };

      const diagPatchText = structuredDiag?.nextObjectivePatch
        ? `\n[Diagnosis Guidance] ${structuredDiag.nextObjectivePatch}`
        : '';
      const diagAvoidText = structuredDiag?.avoidPatterns?.length
        ? `\n[Avoid Patterns] ${structuredDiag.avoidPatterns.join('; ')}`
        : '';
      const canRetrySame =
        attempts < 2 &&
        !priorNodeStrategies.has('retry_same') &&
        !(liveNode.model && runKnownFailedModels.has(liveNode.model) && altModel);
      const diagWantsSwitch =
        structuredDiag?.parsedJson && structuredDiag.strategy === 'switch_model' && Boolean(altModel);
      const diagWantsSplit =
        structuredDiag?.parsedJson &&
        structuredDiag.strategy === 'split_subgraph' &&
        !liveNode.nodeKey.includes('__split');

      // 1. Transient retry on same model (first failure, unless model already failed out or diagnosis escalates)
      if (canRetrySame && !diagWantsSwitch && !diagWantsSplit) {
        if (liveNode.status !== SWARM_NODE_STATES.FAILED) {
          transitionSwarmNode(this.store, null, liveNode.id, SWARM_NODE_STATES.FAILED, {
            emitEvent: false,
            patch: { errorCode, errorMessage },
          });
        }
        if (diagPatchText || diagAvoidText) {
          const nextObj = `${liveNode.objective}${diagPatchText}${diagAvoidText}`.slice(0, 4000);
          this.store.db
            .prepare('UPDATE swarm_nodes SET objective=? WHERE id=?')
            .run(nextObj, liveNode.id);
        }
        updatedNode = transitionSwarmNode(this.store, null, liveNode.id, SWARM_NODE_STATES.READY, {
          emitEvent: false,
          allowReplanReset: true,
          patch: { ...resetPatch, planVersion: nextVersion },
        });
        strategy = 'retry_same';
        reason = errorMessage || errorCode || 'transient failure retry';
        diff = { nodeKey: liveNode.nodeKey, attempts };
      } else {
        // 2. Switch to an alternate untried healthy model if available (unless diagnosis explicitly calls for split_subgraph)
        if (altModel && !diagWantsSplit) {
          if (liveNode.status !== SWARM_NODE_STATES.FAILED) {
            transitionSwarmNode(this.store, null, liveNode.id, SWARM_NODE_STATES.FAILED, {
              emitEvent: false,
              patch: { errorCode, errorMessage },
            });
          }
          if (diagPatchText || diagAvoidText) {
            const nextObj = `${liveNode.objective}${diagPatchText}${diagAvoidText}`.slice(0, 4000);
            this.store.db
              .prepare('UPDATE swarm_nodes SET objective=? WHERE id=?')
              .run(nextObj, liveNode.id);
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
                ...resetPatch,
                model: altModel.model,
                provider: altModel.provider || 'pool',
                planVersion: nextVersion,
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
          const snapForSplit = activeLedger ? activeLedger.getSnapshot(liveRun.id) : null;
          if (snapForSplit?.remainingSteps != null && snapForSplit.remainingSteps < 2) {
            return {
              replanned: false,
              strategy: 'none',
              reason: 'BUDGET_INSUFFICIENT_FOR_REPLAN',
              errorCode: 'BUDGET_EXCEEDED',
            };
          }
          const existingNodes = this.store.db
            .prepare('SELECT id, nodeKey, dependenciesJson, status, errorCode FROM swarm_nodes WHERE runId=?')
            .all(liveRun.id)
            .map((r) => ({
              id: r.id,
              nodeKey: r.nodeKey,
              status: r.status,
              errorCode: r.errorCode,
              dependencies: parseJsonSafe(r.dependenciesJson, []),
            }));
          const deps = parseJsonSafe(liveNode.dependenciesJson, []);
          const s1Key = `${liveNode.nodeKey}__split1_v${nextVersion}`.slice(0, 64);
          const s2Key = `${liveNode.nodeKey}__split2_v${nextVersion}`.slice(0, 64);
          const extraSplitGuidance = `${diagPatchText}${diagAvoidText}`;
          const subNodes = [
            {
              nodeKey: s1Key,
              taskType: 'research',
              objective: `[拆分子步骤 1/2] 先只读梳理并准备上下文：${liveNode.objective}${extraSplitGuidance}`.slice(0, 4000),
              acceptance: '产出缩小范围的具体信息与改动前置条件',
              dependencies: deps,
              priority: Number(liveNode.priority ?? 0) + 2,
              isolationMode: liveNode.isolationMode,
              allowIsolationFallback: Boolean(liveNode.allowIsolationFallback),
            },
            {
              nodeKey: s2Key,
              taskType: liveNode.taskType || 'research',
              objective: `[拆分子步骤 2/2] 基于前置结论完成剩余目标：${liveNode.objective}${extraSplitGuidance}`.slice(0, 4000),
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
          const baseNodeBudget = parseJsonSafe(liveNode.budgetJson, {});
          const splitBudgetCap = snapForSplit?.remainingSteps != null
            ? Math.max(1, Math.floor(snapForSplit.remainingSteps / subNodes.length))
            : null;
          for (const sub of subNodes) {
            const sel = this.router.select({
              taskType: sub.taskType,
              objective: sub.objective,
              ...(runKnownFailedModels.size > 0 ? { excludeModels: [...runKnownFailedModels] } : {}),
            });
            const subBudget = { ...baseNodeBudget };
            if (splitBudgetCap !== null) {
              subBudget.maxSteps = subBudget.maxSteps != null
                ? Math.min(Number(subBudget.maxSteps), splitBudgetCap)
                : splitBudgetCap;
            }
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
              JSON.stringify(subBudget),
              now,
              now,
            );
          }
          const updDep = this.store.db.prepare(
            'UPDATE swarm_nodes SET dependenciesJson=?, planVersion=?, updatedAt=? WHERE id=?',
          );
          for (const n of existingNodes) {
            if (!n.dependencies.includes(liveNode.nodeKey)) continue;
            const nextDeps = n.dependencies.map((d) => (d === liveNode.nodeKey ? s2Key : d));
            if (n.status === 'pending') {
              updDep.run(JSON.stringify(nextDeps), nextVersion, now, n.id);
            } else if (n.status === 'failed' && n.errorCode === 'DEPENDENCY_FAILED') {
              // Revive downstream nodes that prematurely failed due to DEPENDENCY_FAILED before split completed
              transitionSwarmNode(this.store, null, n.id, SWARM_NODE_STATES.PENDING, {
                emitEvent: false,
                allowReplanReset: true,
                patch: {
                  dependenciesJson: JSON.stringify(nextDeps),
                  planVersion: nextVersion,
                  errorCode: null,
                  errorMessage: null,
                },
              });
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
      if (structuredDiag) {
        diff = { ...diff, structuredDiagnosis: structuredDiag };
      }
      if (diagnosisResult?.evidence) {
        diff = {
          ...diff,
          evidenceSummary: {
            failedReceipts: diagnosisResult.evidence.failedReceipts.length,
            modifiedFiles: diagnosisResult.evidence.modifiedFiles.slice(0, 10),
            priorStrategies: diagnosisResult.evidence.priorStrategies,
          },
        };
      }

      return this.#finalizeReplanInTx({
        liveRun,
        nextVersion,
        nextReplanCount,
        currentPlanVersion,
        currentReplanCount,
        failedNodeKey: liveNode.nodeKey,
        supersedeNodeRefs: [{ id: liveNode.id, nodeKey: liveNode.nodeKey }],
        currentJobId: leaseGuard?.jobId ?? '',
        strategy,
        reason,
        diff,
        updatedNode,
        now,
      });
    });

    if (!outcome.replanned) return outcome;
    this.#emitReplanEvents({ runId: run.id, failedNodeKey: failedNode.nodeKey, outcome });

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

  /**
   * Bounded test/review failure repair loop (`repair_and_reverify`).
   * Preserves completed unrelated branches, overlays prior artifacts into the
   * repair worktree, and runs targeted repair -> optional re-verify -> re-review
   * strictly within remaining `maxReplans` and `TaskTreeBudgetLedger` headroom.
   */
  async replanRepairAndReverify({
    run,
    triggerNode,
    errorCode = 'VERIFICATION_FAILED',
    errorMessage = '',
    failureDiagnostics = '',
    reviewerFindings = [],
    testCommands = [],
    wantVerification = false,
    maxReplans = undefined,
    budgetLedger = null,
    leaseGuard = null,
  }) {
    const activeLedger = budgetLedger ?? this.budgetLedger;
    const outcome = this.store.tx(() => {
      assertLeaseInTx(leaseGuard, {
        runId: run.id,
        nodeId: triggerNode?.status === 'completed' ? null : triggerNode?.id,
      });
      const liveRun = this.store.db.prepare('SELECT * FROM swarm_runs WHERE id=?').get(run.id);
      if (!liveRun || isTerminalRunState(liveRun.status)) {
        return { replanned: false, strategy: 'none', reason: 'RUN_NOT_ACTIVE' };
      }

      const rawTrigger = this.store.db
        .prepare('SELECT * FROM swarm_nodes WHERE id=?')
        .get(triggerNode?.id);
      if (
        !rawTrigger ||
        !['running', 'failed', 'completed'].includes(rawTrigger.status) ||
        !['verification', 'review'].includes(rawTrigger.taskType)
      ) {
        return { replanned: false, strategy: 'none', reason: 'NODE_NOT_ELIGIBLE' };
      }
      const liveTrigger = {
        ...rawTrigger,
        dependencies: parseJsonSafe(rawTrigger.dependenciesJson, []),
        toolAllow: parseJsonSafe(rawTrigger.toolAllowJson, []),
        budget: parseJsonSafe(rawTrigger.budgetJson, {}),
      };

      const supersededSet = this.#collectSupersededKeysInTx(liveRun.id);
      if (supersededSet.has(liveTrigger.nodeKey)) {
        return { replanned: false, strategy: 'none', reason: 'ALREADY_REPLANNED' };
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

      const snap = activeLedger ? activeLedger.getSnapshot(liveRun.id) : null;
      if (snap && (snap.isStepExhausted || snap.isPermanentlyExhausted)) {
        return {
          replanned: false,
          strategy: 'none',
          reason: 'BUDGET_EXCEEDED',
          replanCount: currentReplanCount,
          maxReplans: effectiveMaxReplans,
        };
      }

      const existingNodes = this.store.db
        .prepare('SELECT * FROM swarm_nodes WHERE runId=? ORDER BY createdAt ASC')
        .all(liveRun.id)
        .map((r) => ({
          ...r,
          dependencies: parseJsonSafe(r.dependenciesJson, []),
          toolAllow: parseJsonSafe(r.toolAllowJson, []),
          budget: parseJsonSafe(r.budgetJson, {}),
        }));
      const byKey = new Map(existingNodes.map((n) => [n.nodeKey, n]));
      const existingKeys = new Set(byKey.keys());

      // Collect non-superseded ancestor cone of liveTrigger so unrelated completed nodes stay untouched
      const ancestorSet = new Set();
      const visitAncestors = (nodeKey) => {
        const node = byKey.get(nodeKey);
        if (!node) return;
        for (const dep of node.dependencies) {
          if (!dep || ancestorSet.has(dep)) continue;
          ancestorSet.add(dep);
          visitAncestors(dep);
        }
      };
      visitAncestors(liveTrigger.nodeKey);

      const activeImplAncestors = [];
      const activeVerifyAncestors = [];
      const repairDeps = [];
      const usedWorkerModels = new Set();

      for (const n of existingNodes) {
        if (n.nodeKey === liveTrigger.nodeKey || supersededSet.has(n.nodeKey)) continue;
        if (n.status === 'cancelled') continue;
        if (['implementation', 'repair'].includes(n.taskType) && n.model) {
          usedWorkerModels.add(n.model);
        }
        if (!ancestorSet.has(n.nodeKey)) continue;
        if (n.taskType === 'verification') {
          activeVerifyAncestors.push(n.nodeKey);
        } else if (n.taskType !== 'review') {
          repairDeps.push(n.nodeKey);
          if (n.taskType === 'implementation') activeImplAncestors.push(n.nodeKey);
        }
      }

      // Check for downstream pending review node waiting on liveTrigger (when triggered by verification)
      const pendingDownstreamReview = existingNodes.find(
        (n) =>
          n.taskType === 'review' &&
          n.status === 'pending' &&
          !supersededSet.has(n.nodeKey) &&
          n.dependencies.includes(liveTrigger.nodeKey),
      );
      const anyActiveVerification = existingNodes.some(
        (n) => n.taskType === 'verification' && !supersededSet.has(n.nodeKey),
      );
      const normalizedTestCommands = Array.isArray(testCommands)
        ? testCommands.map((c) => String(c).trim()).filter(Boolean)
        : [];
      const needReverify = Boolean(
        liveTrigger.taskType === 'verification' ||
          wantVerification ||
          activeVerifyAncestors.length > 0 ||
          (anyActiveVerification && normalizedTestCommands.length > 0),
      );
      const needNewReview = Boolean(
        liveTrigger.taskType === 'review' && !pendingDownstreamReview,
      );

      const neededNodes = 1 + (needReverify ? 1 : 0) + (needNewReview ? 1 : 0);
      if (snap?.remainingSteps != null && snap.remainingSteps < neededNodes) {
        return {
          replanned: false,
          strategy: 'none',
          reason: 'BUDGET_INSUFFICIENT_FOR_REPLAN',
          errorCode: 'BUDGET_EXCEEDED',
          replanCount: currentReplanCount,
          maxReplans: effectiveMaxReplans,
        };
      }

      const nextVersion = currentPlanVersion + 1;
      const nextReplanCount = currentReplanCount + 1;
      const now = Date.now();
      const uniqueKey = (base) => {
        let candidate = String(base).slice(0, 64);
        let idx = 2;
        while (existingKeys.has(candidate)) {
          candidate = `${String(base).slice(0, 58)}_${idx++}`;
        }
        existingKeys.add(candidate);
        return candidate;
      };

      const repairKey = uniqueKey(`repair__v${nextVersion}`);
      const reverifyKey = needReverify ? uniqueKey(`reverify__v${nextVersion}`) : null;
      const rereviewKey = needNewReview ? uniqueKey(`rereview__v${nextVersion}`) : null;
      const terminalReplacementKey = rereviewKey || reverifyKey || repairKey;

      const activeImplNode = existingNodes.find(
        (n) => n.taskType === 'implementation' && !supersededSet.has(n.nodeKey),
      );
      const activeVerifyNode = existingNodes.find(
        (n) => n.taskType === 'verification' && !supersededSet.has(n.nodeKey),
      );

      const execPermissionMode =
        activeImplNode?.permissionMode && activeImplNode.permissionMode !== 'read-only'
          ? activeImplNode.permissionMode
          : strategyCfg.permissionMode && strategyCfg.permissionMode !== 'read-only'
            ? strategyCfg.permissionMode
            : 'auto-safe';
      const verifyPermissionMode =
        activeVerifyNode?.permissionMode && activeVerifyNode.permissionMode !== 'read-only'
          ? activeVerifyNode.permissionMode
          : execPermissionMode;

      const diagLines = [];
      diagLines.push(`Trigger node: ${liveTrigger.nodeKey} (${liveTrigger.taskType})`);
      if (errorCode) diagLines.push(`Error code: ${errorCode}`);
      if (errorMessage) diagLines.push(`Error: ${String(errorMessage).slice(0, 800)}`);
      if (failureDiagnostics) {
        const text =
          typeof failureDiagnostics === 'string'
            ? failureDiagnostics
            : JSON.stringify(failureDiagnostics);
        diagLines.push(`Failure diagnostics:\n${text.slice(0, 2000)}`);
      }
      if (Array.isArray(reviewerFindings) && reviewerFindings.length > 0) {
        diagLines.push(
          'Reviewer findings:\n' +
            reviewerFindings
              .slice(0, 8)
              .map(
                (f, i) =>
                  `${i + 1}. [${f?.severity || 'medium'}] ${f?.message || ''}${f?.evidenceRef ? ` (${f.evidenceRef})` : ''}`,
              )
              .join('\n'),
        );
      }
      if (normalizedTestCommands.length > 0) {
        diagLines.push(`Test commands: ${normalizedTestCommands.join(' ; ')}`);
      }

      const diagBlock = diagLines.join('\n');
      const repairObjective = [
        `[Bounded Repair Cycle v${nextVersion}] Fix the root cause of the verification/review failure on top of overlaid predecessor worktree changes.`,
        `Run goal: ${liveRun.goal}`,
        diagBlock,
        'Modify only the files needed to resolve the concrete failure/findings while preserving passing upstream work. If bash is permitted in this worktree, verify the failing check passes before finishing.',
      ].join('\n\n');

      const implToolAllow =
        Array.isArray(activeImplNode?.toolAllow) && activeImplNode.toolAllow.length > 0
          ? [...new Set([...activeImplNode.toolAllow, 'bash', 'inspect_repository', 'query_symbol_graph', 'read_swarm_artifact'])]
          : [...DEFAULT_REPAIR_TOOLS];

      const perNodeMaxSteps = (defaultSteps) => {
        if (snap?.remainingSteps == null) return defaultSteps;
        const maxAlloc = Math.max(1, snap.remainingSteps - (neededNodes - 1));
        return Math.min(defaultSteps, maxAlloc);
      };

      const baseRepairBudget = activeImplNode?.budget ? { ...activeImplNode.budget } : {};
      delete baseRepairBudget.evidenceContract;
      baseRepairBudget.maxSteps = perNodeMaxSteps(Number(baseRepairBudget.maxSteps || 8));
      baseRepairBudget.roleMetadata = {
        roleTitle: 'Targeted Repair Engineer',
        focus: `Resolve failure from ${liveTrigger.nodeKey}`,
        ownedPaths: [],
      };

      const repairSel = this.router.select({
        taskType: 'implementation',
        objective: repairObjective,
      });

      const addedNodeSpecs = [
        {
          nodeKey: repairKey,
          agentProfileId: repairSel.profile.id,
          model: repairSel.model,
          provider: repairSel.provider,
          objective: repairObjective,
          acceptance: 'Resolve reported failure/findings without regressions in overlaid worktree files',
          dependencies: [...new Set(repairDeps)],
          toolAllow: implToolAllow,
          permissionMode: execPermissionMode,
          taskType: 'implementation',
          isolationMode: activeImplNode?.isolationMode || 'worktree',
          allowIsolationFallback: Boolean(activeImplNode?.allowIsolationFallback),
          priority: Number(liveTrigger.priority ?? 0) + 3,
          budget: baseRepairBudget,
        },
      ];

      if (reverifyKey) {
        const verifyDeps = [...new Set([...repairDeps, repairKey])];
        const verifyObjective = [
          `[Re-Verification Cycle v${nextVersion}] Execute verification against overlaid changes including ${repairKey}.`,
          liveTrigger.taskType === 'verification'
            ? liveTrigger.objective
            : activeVerifyNode?.objective || `Verify fix for: ${liveRun.goal}`,
          normalizedTestCommands.length > 0
            ? `Suggested test commands: ${normalizedTestCommands.join(' ; ')}`
            : '',
          'Confirm all previously failing checks now pass with zero regressions.',
        ]
          .filter(Boolean)
          .join('\n\n');
        const verifyTools =
          Array.isArray(activeVerifyNode?.toolAllow) && activeVerifyNode.toolAllow.length > 0
            ? [...new Set([...activeVerifyNode.toolAllow, 'read_swarm_artifact'])]
            : [...DEFAULT_REVERIFY_TOOLS];
        const verifyBudget = activeVerifyNode?.budget ? { ...activeVerifyNode.budget } : {};
        delete verifyBudget.evidenceContract;
        verifyBudget.maxSteps = perNodeMaxSteps(Number(verifyBudget.maxSteps || 6));
        verifyBudget.roleMetadata = {
          roleTitle: 'Verification Runner',
          focus: `Re-verify after ${repairKey}`,
          ownedPaths: [],
        };
        const verifySel = this.router.select({
          taskType: 'verification',
          objective: verifyObjective,
        });
        addedNodeSpecs.push({
          nodeKey: reverifyKey,
          agentProfileId: verifySel.profile.id,
          model: verifySel.model,
          provider: verifySel.provider,
          objective: verifyObjective,
          acceptance:
            activeVerifyNode?.acceptance ||
            'All verification commands and tests exit 0 on overlaid worktree',
          dependencies: verifyDeps,
          toolAllow: verifyTools,
          permissionMode: verifyPermissionMode,
          taskType: 'verification',
          isolationMode: activeVerifyNode?.isolationMode || 'worktree',
          allowIsolationFallback: Boolean(activeVerifyNode?.allowIsolationFallback),
          priority: Number(liveTrigger.priority ?? 0) + 2,
          budget: verifyBudget,
        });
      }

      const artifactSourceKeys = [
        ...new Set([
          ...existingNodes
            .filter(
              (n) =>
                !supersededSet.has(n.nodeKey) &&
                n.nodeKey !== liveTrigger.nodeKey &&
                ['implementation', 'verification'].includes(n.taskType),
            )
            .map((n) => n.nodeKey),
          repairKey,
          ...(reverifyKey ? [reverifyKey] : []),
        ]),
      ];

      if (rereviewKey) {
        const triggerContract =
          liveTrigger.budget?.reviewerMetadata ?? liveTrigger.budget?.evidenceContract ?? {};
        const prevExcluded = Array.isArray(triggerContract.excludedModels)
          ? triggerContract.excludedModels
          : [];
        const allExcluded = [...new Set([...prevExcluded, ...usedWorkerModels])].filter(Boolean);
        const reviewDeps = [...new Set([...repairDeps, repairKey, ...(reverifyKey ? [reverifyKey] : [])])];
        const reviewSel = this.router.select({
          taskType: 'review',
          objective: liveTrigger.objective || `Re-review after ${repairKey}`,
          ...(allExcluded.length > 0 ? { excludeModels: allExcluded } : {}),
        });
        const triggerSteps = Number(liveTrigger.budget?.maxSteps || 6);
        const desiredReviewSteps =
          triggerSteps >= 12
            ? Math.min(30, triggerSteps + Math.max(6, artifactSourceKeys.length))
            : triggerSteps;
        const reviewBudget = {
          maxSteps: perNodeMaxSteps(desiredReviewSteps),
          strictReviewerSchema: true,
          reviewerMetadata: {
            autoMaterialized: true,
            sourceNodeKeys: artifactSourceKeys,
            excludedModels: allExcluded,
            reason: `re-review after ${repairKey}`,
          },
          roleMetadata: {
            roleTitle: 'Independent Re-Reviewer',
            focus: `Inspect repair ${repairKey} and verify prior findings are resolved`,
            ownedPaths: [],
          },
        };
        addedNodeSpecs.push({
          nodeKey: rereviewKey,
          agentProfileId: reviewSel.profile.id,
          model: reviewSel.model,
          provider: reviewSel.provider,
          objective: [
            `[Re-Review Cycle v${nextVersion}] Re-inspect artifacts and verification evidence after ${repairKey} addressed prior review findings.`,
            `Prioritize inspecting repaired artifacts from ${repairKey} and verification evidence from ${reverifyKey || repairKey} via read_swarm_artifact, and emit the strict JSON verdict promptly without redundant full-repo exploration.`,
            `Original review objective: ${liveTrigger.objective}`,
            diagBlock,
          ].join('\n\n'),
          acceptance:
            liveTrigger.acceptance ||
            'Structured pass verdict after inspecting repaired artifacts',
          dependencies: reviewDeps,
          toolAllow: [...DEFAULT_REVIEW_TOOLS],
          permissionMode: 'read-only',
          taskType: 'review',
          isolationMode: 'shared_readonly',
          allowIsolationFallback: false,
          priority: Number(liveTrigger.priority ?? 0) + 1,
          budget: reviewBudget,
        });
      }

      // Simulate DAG validity before mutating SQLite
      const simulated = [
        ...existingNodes.map((n) => ({
          nodeKey: n.nodeKey,
          dependencies: n.dependencies.map((d) =>
            d === liveTrigger.nodeKey ? terminalReplacementKey : d,
          ),
        })),
        ...addedNodeSpecs.map((n) => ({
          nodeKey: n.nodeKey,
          dependencies: n.dependencies,
        })),
      ];
      this.planner?.validateDag?.(simulated);

      // Mark non-completed trigger node as failed (completed review rows keep their immutable history and are excluded via supersededNodeKeys)
      let updatedNode = null;
      if (liveTrigger.status === SWARM_NODE_STATES.RUNNING || liveTrigger.status === SWARM_NODE_STATES.READY) {
        updatedNode = transitionSwarmNode(
          this.store,
          null,
          liveTrigger.id,
          SWARM_NODE_STATES.FAILED,
          {
            emitEvent: false,
            patch: {
              errorCode: errorCode || 'VERIFICATION_FAILED',
              errorMessage: String(errorMessage || 'Triggered repair_and_reverify').slice(0, 500),
            },
          },
        );
      }

      const ins = this.store.db.prepare(
        `INSERT INTO swarm_nodes(
          id, runId, nodeKey, agentProfileId, model, provider, objective, acceptance,
          dependenciesJson, toolAllowJson, permissionMode, taskType, isolationMode,
          allowIsolationFallback, planVersion, status, priority, budgetJson, createdAt, updatedAt
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`,
      );
      for (const spec of addedNodeSpecs) {
        ins.run(
          uuid(),
          liveRun.id,
          spec.nodeKey,
          spec.agentProfileId,
          spec.model,
          spec.provider,
          spec.objective,
          spec.acceptance,
          JSON.stringify(spec.dependencies),
          JSON.stringify(spec.toolAllow),
          spec.permissionMode,
          spec.taskType,
          spec.isolationMode,
          spec.allowIsolationFallback ? 1 : 0,
          nextVersion,
          spec.priority,
          JSON.stringify(spec.budget),
          now,
          now,
        );
      }

      // Rewire downstream pending nodes (including any pending review node) cleanly
      const updPending = this.store.db.prepare(
        'UPDATE swarm_nodes SET dependenciesJson=?, budgetJson=?, planVersion=?, updatedAt=? WHERE id=?',
      );
      for (const n of existingNodes) {
        if (n.nodeKey === liveTrigger.nodeKey || supersededSet.has(n.nodeKey)) continue;
        if (!n.dependencies.includes(liveTrigger.nodeKey)) continue;
        const nextDeps = [
          ...new Set([
            ...n.dependencies.map((d) =>
              d === liveTrigger.nodeKey ? terminalReplacementKey : d,
            ),
            ...(n.taskType === 'review' ? [repairKey, ...(reverifyKey ? [reverifyKey] : [])] : []),
          ]),
        ];
        const nextBudget = { ...n.budget };
        if (n.taskType === 'review') {
          if (nextBudget.reviewerMetadata) {
            nextBudget.reviewerMetadata = {
              ...nextBudget.reviewerMetadata,
              sourceNodeKeys: artifactSourceKeys,
            };
          }
          if (nextBudget.evidenceContract) {
            nextBudget.evidenceContract = {
              ...nextBudget.evidenceContract,
              sourceNodeKeys: artifactSourceKeys,
            };
          }
        }
        if (n.status === 'pending') {
          updPending.run(
            JSON.stringify(nextDeps),
            JSON.stringify(nextBudget),
            nextVersion,
            now,
            n.id,
          );
        } else if (n.status === 'failed' && n.errorCode === 'DEPENDENCY_FAILED') {
          transitionSwarmNode(this.store, null, n.id, SWARM_NODE_STATES.PENDING, {
            emitEvent: false,
            allowReplanReset: true,
            patch: {
              dependenciesJson: JSON.stringify(nextDeps),
              budgetJson: JSON.stringify(nextBudget),
              planVersion: nextVersion,
              errorCode: null,
              errorMessage: null,
            },
          });
        }
      }

      const addedNodes = addedNodeSpecs.map((s) => s.nodeKey);
      const supersededNodeKeys = [liveTrigger.nodeKey];
      const supersedeArtifactRefs =
        liveTrigger.taskType === 'verification'
          ? [{ id: liveTrigger.id, nodeKey: liveTrigger.nodeKey }]
          : [];
      const reasonText =
        liveTrigger.taskType === 'review'
          ? `Repair and re-review triggered by ${liveTrigger.nodeKey} (${errorCode || 'REVIEW_REJECTED'})`
          : `Repair and re-verification triggered by ${liveTrigger.nodeKey} (${errorCode || 'VERIFICATION_FAILED'})`;

      return this.#finalizeReplanInTx({
        liveRun,
        nextVersion,
        nextReplanCount,
        currentPlanVersion,
        currentReplanCount,
        failedNodeKey: liveTrigger.nodeKey,
        supersedeNodeRefs: supersedeArtifactRefs,
        currentJobId: leaseGuard?.jobId ?? '',
        strategy: 'repair_and_reverify',
        reason: reasonText,
        diff: {
          triggerNodeKey: liveTrigger.nodeKey,
          triggerTaskType: liveTrigger.taskType,
          supersededNodeKeys,
          addedNodes,
          repairNodeKey: repairKey,
          reverifyNodeKey: reverifyKey,
          rereviewNodeKey: rereviewKey,
          preservedNodeKeys: activeImplAncestors,
        },
        updatedNode,
        now,
      });
    });

    if (!outcome.replanned) return outcome;
    this.#emitReplanEvents({ runId: run.id, failedNodeKey: triggerNode.nodeKey, outcome });

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
