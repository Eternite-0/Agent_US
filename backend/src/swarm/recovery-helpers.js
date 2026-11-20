import { id as uuid } from '../store.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import { SWARM_JOB_KINDS, enqueueSwarmJob } from './jobs.js';
import {
  SWARM_NODE_STATES,
  SWARM_RUN_STATES,
  isTerminalNodeState,
  isTerminalRunState,
  transitionSwarmNode,
  transitionSwarmRun,
} from './node-state-machine.js';

export function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function extractArtifactUris(text) {
  return [...(String(text || '').match(/artifact:\/\/[0-9a-f]{64}/g) ?? [])];
}

export function buildSwarmSummary(nodes = []) {
  return nodes
    .map(
      (n) =>
        `### [${n.nodeKey}] (${n.status}, model=${n.model || 'default'})\n${n.resultText || n.errorMessage || '(无输出)'}`,
    )
    .join('\n\n');
}

export function hydrateSwarmNode(n) {
  return {
    ...n,
    allowIsolationFallback: Boolean(n.allowIsolationFallback),
    dependencies: parseJsonSafe(n.dependenciesJson, []),
    toolAllow: parseJsonSafe(n.toolAllowJson, null),
    budget: parseJsonSafe(n.budgetJson, {}),
    artifactUris: parseJsonSafe(n.artifactUrisJson, []),
  };
}

export function hydrateSwarmRun(run, nodes) {
  if (!run) return null;
  return {
    ...run,
    strategy: parseJsonSafe(run.strategyJson, {}),
    budget: parseJsonSafe(run.budgetJson, {}),
    usage: parseJsonSafe(run.usageJson, {}),
    verdict: parseJsonSafe(run.verdictJson, null),
    nodes: nodes.map(hydrateSwarmNode),
  };
}

/**
 * Checks whether a swarm node has executing or outcome_unknown tool receipts,
 * creating a pending reconciliation approval if none exists yet.
 */
export function inspectNodeReconciliation(
  store,
  reconciler,
  eventRouter,
  node,
  childSessionId,
  childTurnId,
) {
  if (!store?.db?.isOpen) return { needsReconciliation: false, approvalId: null };
  const turnId = childTurnId || node?.childTurnId || null;
  const sessId = childSessionId || node?.childSessionId || null;

  if (turnId && reconciler?.inspectInterruptedTurn) {
    const recCheck = reconciler.inspectInterruptedTurn(turnId, { sessionId: sessId });
    if (recCheck?.needsReconciliation) {
      return { needsReconciliation: true, approvalId: recCheck.approvalId };
    }
  }

  const unknownRows = store.db
    .prepare(
      `SELECT id, callId, toolName, riskLevel, effectClass, sessionId, turnId
       FROM tool_receipts
       WHERE status='outcome_unknown'
         AND ((? IS NOT NULL AND turnId=?) OR (? IS NOT NULL AND sessionId=?))
       ORDER BY createdAt ASC`,
    )
    .all(turnId, turnId, sessId, sessId);
  if (!unknownRows.length) return { needsReconciliation: false, approvalId: null };

  const first = unknownRows[0];
  const existing = store.db
    .prepare(
      `SELECT id FROM direct_approvals
       WHERE kind='reconciliation' AND status='pending'
         AND ((? IS NOT NULL AND turnId=?) OR sessionId=?)
       LIMIT 1`,
    )
    .get(turnId, turnId, sessId || first.sessionId);
  if (existing) return { needsReconciliation: true, approvalId: existing.id };

  const approvalId = uuid();
  const now = Date.now();
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO direct_approvals(
          id, sessionId, turnId, callId, tool, arguments, status, kind, receiptId,
          riskLevel, effectClass, expiresAt, createdAt
        ) VALUES(?,?,?,?,?,?,'pending','reconciliation',?,?,?,?,?)`,
      )
      .run(
        approvalId,
        sessId || first.sessionId,
        turnId || first.turnId,
        first.callId,
        first.toolName,
        JSON.stringify({
          receiptId: first.id,
          unknownReceiptIds: unknownRows.map((u) => u.id),
          callId: first.callId,
          toolName: first.toolName,
          effectClass: first.effectClass,
          reason: '不可重放或外部工具处于 outcome_unknown 状态，需人工核对确认。',
        }),
        first.id,
        first.riskLevel,
        first.effectClass,
        now + 86_400_000,
        now,
      );
  });

  eventRouter?.emitPersisted({
    sessionId: sessId || first.sessionId,
    turnId: turnId || first.turnId,
    type: RUNTIME_EVENTS.RECONCILIATION_REQUIRED,
    data: {
      approvalId,
      receiptId: first.id,
      unknownReceiptIds: unknownRows.map((u) => u.id),
      tool: first.toolName,
      callId: first.callId,
    },
    audit: true,
  });

  return { needsReconciliation: true, approvalId };
}

export function parkNodeAndRunForReconciliation(store, eventRouter, run, node, approvalId) {
  transitionSwarmNode(store, eventRouter, node.id, SWARM_NODE_STATES.RECONCILING, {
    sessionId: run.sessionId,
    rootTurnId: run.rootTurnId,
    patch: { reconcileApprovalId: approvalId || null },
  });
  const freshRun = store.db.prepare('SELECT status FROM swarm_runs WHERE id=?').get(run.id);
  if (freshRun && !isTerminalRunState(freshRun.status) && freshRun.status !== SWARM_RUN_STATES.RECONCILING) {
    transitionSwarmRun(store, run.id, SWARM_RUN_STATES.RECONCILING, {
      patch: { currentPhase: 'reconciling' },
    });
  }
}

export function recoverInterruptedSwarmRuns({
  store,
  jobQueue,
  reconciler,
  eventRouter,
  getRun,
  cancelRun,
}) {
  const report = {
    recoveredRuns: [],
    recoveredNodes: 0,
    reconcilingNodes: [],
    skippedTerminal: 0,
  };
  if (!store?.db?.isOpen || !jobQueue) return report;

  // Ensure cancelled runs never retain pending/active jobs
  store.tx(() => {
    store.db
      .prepare(
        `UPDATE runtime_jobs SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, updatedAt=?
         WHERE taskId IN (SELECT id FROM swarm_runs WHERE status='cancelled')
           AND status IN ('pending','active','reconciling','parked')`,
      )
      .run(Date.now());
  });

  const rows = store.db
    .prepare(
      `SELECT * FROM swarm_runs
       WHERE status IN ('pending','planning','running','reconciling','aggregating','verifying')
       ORDER BY createdAt ASC`,
    )
    .all();

  for (const runRow of rows) {
    const parentSess = store.db
      .prepare('SELECT state FROM direct_sessions WHERE id=?')
      .get(runRow.sessionId);
    if (!parentSess || parentSess.state === 'cancelled') {
      cancelRun(runRow.id);
      report.skippedTerminal++;
      continue;
    }

    const now = Date.now();
    store.tx(() => {
      store.db
        .prepare(
          `UPDATE runtime_jobs SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, updatedAt=?
           WHERE taskId=? AND status IN ('pending','active')`,
        )
        .run(now, runRow.id);
    });

    const run = getRun(runRow.id);
    if (!run) continue;

    if (run.status === SWARM_RUN_STATES.PENDING || run.status === SWARM_RUN_STATES.PLANNING) {
      if (run.nodes.length === 0) {
        enqueueSwarmJob(
          jobQueue,
          SWARM_JOB_KINDS.PLAN,
          { runId: run.id, sessionId: run.sessionId, goal: run.goal, planVersion: run.planVersion || 1 },
          { idempotencyKey: `swarm:plan:${run.id}:rec:${now}` },
        );
      } else {
        transitionSwarmRun(store, run.id, SWARM_RUN_STATES.RUNNING, {
          patch: { currentPhase: 'running' },
        });
        enqueueSwarmJob(jobQueue, SWARM_JOB_KINDS.DEPENDENCY_RESOLVE, {
          runId: run.id,
          sessionId: run.sessionId,
          planVersion: run.planVersion || 1,
          epoch: now,
        });
      }
      report.recoveredRuns.push(run.id);
      continue;
    }

    if (run.status === SWARM_RUN_STATES.RUNNING || run.status === SWARM_RUN_STATES.RECONCILING) {
      for (const n of run.nodes) {
        if (isTerminalNodeState(n.status) || n.status === SWARM_NODE_STATES.PENDING || n.status === SWARM_NODE_STATES.READY) {
          continue;
        }
        if (n.status === SWARM_NODE_STATES.RECONCILING) {
          report.reconcilingNodes.push({ runId: run.id, nodeKey: n.nodeKey, approvalId: n.reconcileApprovalId });
          continue;
        }
        const rec = inspectNodeReconciliation(
          store,
          reconciler,
          eventRouter,
          n,
          n.childSessionId,
          n.childTurnId,
        );
        if (rec.needsReconciliation) {
          parkNodeAndRunForReconciliation(store, eventRouter, run, n, rec.approvalId);
          report.reconcilingNodes.push({ runId: run.id, nodeKey: n.nodeKey, approvalId: rec.approvalId });
          continue;
        }
        if (n.status === SWARM_NODE_STATES.RUNNING) {
          transitionSwarmNode(store, eventRouter, n.id, SWARM_NODE_STATES.INTERRUPTED, {
            sessionId: run.sessionId,
            rootTurnId: run.rootTurnId,
          });
        }
        transitionSwarmNode(store, eventRouter, n.id, SWARM_NODE_STATES.READY, {
          sessionId: run.sessionId,
          rootTurnId: run.rootTurnId,
        });
        report.recoveredNodes++;
      }

      if (run.status !== SWARM_RUN_STATES.RECONCILING || report.recoveredNodes > 0) {
        enqueueSwarmJob(
          jobQueue,
          SWARM_JOB_KINDS.DEPENDENCY_RESOLVE,
          {
            runId: run.id,
            sessionId: run.sessionId,
            planVersion: run.planVersion || 1,
            epoch: now,
          },
          { idempotencyKey: `swarm:resolve:${run.id}:rec:${uuid().slice(0, 8)}` },
        );
      }
      report.recoveredRuns.push(run.id);
      continue;
    }

    if (run.status === SWARM_RUN_STATES.AGGREGATING) {
      enqueueSwarmJob(
        jobQueue,
        SWARM_JOB_KINDS.AGGREGATE,
        { runId: run.id, sessionId: run.sessionId, planVersion: run.planVersion || 1 },
        { idempotencyKey: `swarm:agg:${run.id}:rec:${now}` },
      );
      report.recoveredRuns.push(run.id);
    } else if (run.status === SWARM_RUN_STATES.VERIFYING) {
      enqueueSwarmJob(
        jobQueue,
        SWARM_JOB_KINDS.VERIFY,
        { runId: run.id, sessionId: run.sessionId, planVersion: run.planVersion || 1 },
        { idempotencyKey: `swarm:ver:${run.id}:rec:${now}` },
      );
      report.recoveredRuns.push(run.id);
    }
  }

  return report;
}

export function applyReconciliationResolution({ store, jobQueue, eventRouter, getRun, result }) {
  if (!store?.db?.isOpen || !result) return null;
  const node = store.db
    .prepare(
      `SELECT * FROM swarm_nodes
       WHERE status='reconciling'
         AND (reconcileApprovalId=? OR (? IS NOT NULL AND childTurnId=?) OR (? IS NOT NULL AND childSessionId=?))
       LIMIT 1`,
    )
    .get(
      result.id,
      result.turnId || null,
      result.turnId || null,
      result.sessionId || null,
      result.sessionId || null,
    );
  if (!node) return null;

  const run = getRun(node.runId);
  if (!run || isTerminalRunState(run.status)) return null;

  const now = Date.now();
  store.tx(() => {
    store.db
      .prepare(
        `UPDATE runtime_jobs SET status='done', updatedAt=?
         WHERE turnId=? AND status IN ('pending','reconciling','parked')`,
      )
      .run(now, `swarm:${run.id}:${node.nodeKey}`);
  });

  if (result.outcome === 'abort') {
    transitionSwarmNode(store, eventRouter, node.id, SWARM_NODE_STATES.FAILED, {
      sessionId: run.sessionId,
      rootTurnId: run.rootTurnId,
      patch: {
        reconcileApprovalId: null,
        errorCode: 'RECONCILIATION_ABORTED',
        errorMessage: result.reason || 'Operator aborted reconciliation',
      },
    });
  } else {
    transitionSwarmNode(store, eventRouter, node.id, SWARM_NODE_STATES.READY, {
      sessionId: run.sessionId,
      rootTurnId: run.rootTurnId,
      patch: { reconcileApprovalId: null },
    });
  }

  if (run.status === SWARM_RUN_STATES.RECONCILING) {
    transitionSwarmRun(store, run.id, SWARM_RUN_STATES.RUNNING, {
      patch: { currentPhase: 'running' },
    });
  }

  enqueueSwarmJob(
    jobQueue,
    SWARM_JOB_KINDS.DEPENDENCY_RESOLVE,
    {
      runId: run.id,
      sessionId: run.sessionId,
      planVersion: run.planVersion || 1,
      epoch: now,
    },
    { idempotencyKey: `swarm:resolve:${run.id}:reconcile:${uuid().slice(0, 8)}` },
  );

  return getRun(run.id);
}
