import { RuntimeError } from '../kernel/errors.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import { assertLeaseInTx } from '../durable/lease-guard.js';

export const SWARM_NODE_STATES = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  QUEUED: 'queued',
  RUNNING: 'running',
  PARKED: 'parked',
  INTERRUPTED: 'interrupted',
  RECONCILING: 'reconciling',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const SWARM_RUN_STATES = Object.freeze({
  PENDING: 'pending',
  PLANNING: 'planning',
  RUNNING: 'running',
  RECONCILING: 'reconciling',
  AGGREGATING: 'aggregating',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const TERMINAL_NODE = new Set([
  SWARM_NODE_STATES.COMPLETED,
  SWARM_NODE_STATES.FAILED,
  SWARM_NODE_STATES.CANCELLED,
]);

const TERMINAL_RUN = new Set([
  SWARM_RUN_STATES.COMPLETED,
  SWARM_RUN_STATES.FAILED,
  SWARM_RUN_STATES.CANCELLED,
]);

export const NODE_TRANSITIONS = Object.freeze({
  pending: new Set(['ready', 'queued', 'failed', 'cancelled']),
  ready: new Set(['queued', 'running', 'completed', 'failed', 'cancelled']),
  queued: new Set(['ready', 'running', 'interrupted', 'cancelled']),
  running: new Set([
    'parked',
    'interrupted',
    'reconciling',
    'completed',
    'failed',
    'cancelled',
    'ready',
  ]),
  parked: new Set(['ready', 'queued', 'running', 'cancelled', 'failed']),
  interrupted: new Set(['ready', 'queued', 'running', 'reconciling', 'failed', 'cancelled']),
  reconciling: new Set(['ready', 'queued', 'running', 'completed', 'failed', 'cancelled']),
  completed: new Set([]),
  failed: new Set(['pending', 'ready']), // only explicit replanning unlocks a failed node
  cancelled: new Set([]),
});

export const RUN_TRANSITIONS = Object.freeze({
  pending: new Set(['planning', 'running', 'failed', 'cancelled']),
  planning: new Set(['running', 'reconciling', 'aggregating', 'failed', 'cancelled']),
  running: new Set(['reconciling', 'aggregating', 'verifying', 'completed', 'failed', 'cancelled']),
  reconciling: new Set(['running', 'aggregating', 'failed', 'cancelled']),
  aggregating: new Set(['verifying', 'reconciling', 'completed', 'failed', 'cancelled']),
  verifying: new Set(['reconciling', 'completed', 'failed', 'cancelled']),
  completed: new Set([]),
  failed: new Set(['running']), // only explicit resume/replan
  cancelled: new Set([]),
});

export function isTerminalNodeState(status) {
  return TERMINAL_NODE.has(status);
}

export function isTerminalRunState(status) {
  return TERMINAL_RUN.has(status);
}

export function transitionSwarmNode(
  store,
  eventRouter,
  nodeId,
  toStatus,
  {
    sessionId = null,
    rootTurnId = null,
    patch = {},
    allowReplanReset = false,
    leaseGuard = null,
    bindingOwnership = false,
  } = {},
) {
  const updated = store.tx(() => {
    const row = store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(nodeId);
    if (!row) {
      throw new RuntimeError('SWARM_NODE_NOT_FOUND', { detail: { nodeId } });
    }
    assertLeaseInTx(leaseGuard, { runId: row.runId, nodeId: row.id, bindingOwnership });
    const from = row.status;
    if (from === toStatus) return row;

    if (from === 'failed' && !allowReplanReset) {
      throw new RuntimeError('INVALID_SWARM_TRANSITION', {
        message: `Illegal swarm_node transition ${from} -> ${toStatus} without explicit replan reset`,
        detail: { nodeId, from, toStatus },
      });
    }
    const allowed = NODE_TRANSITIONS[from];
    if (!allowed || !allowed.has(toStatus)) {
      throw new RuntimeError('INVALID_SWARM_TRANSITION', {
        message: `Illegal swarm_node transition: ${from} -> ${toStatus}`,
        detail: { nodeId, nodeKey: row.nodeKey, from, toStatus },
      });
    }

    const now = Date.now();
    const fields = ['status=?', 'updatedAt=?'];
    const values = [toStatus, now];
    const allowedPatchCols = new Set([
      'childSessionId',
      'childTurnId',
      'jobId',
      'activeJobId',
      'activeFence',
      'activeAttempt',
      'latestArtifactId',
      'worktreeLeaseId',
      'reconcileApprovalId',
      'model',
      'provider',
      'priority',
      'resultText',
      'artifactUrisJson',
      'errorCode',
      'errorMessage',
      'attempts',
      'dependenciesJson',
      'planVersion',
      'isolationMode',
      'worktreePath',
    ]);
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (!allowedPatchCols.has(k) || v === undefined) continue;
      fields.push(`${k}=?`);
      values.push(v);
    }
    values.push(nodeId, from);
    const res = store.db
      .prepare(`UPDATE swarm_nodes SET ${fields.join(', ')} WHERE id=? AND status=?`)
      .run(...values);
    if (!res.changes) {
      throw new RuntimeError('INVALID_SWARM_TRANSITION', {
        message: `Concurrent swarm_node modification blocked for ${nodeId}`,
        detail: { nodeId, from, toStatus },
      });
    }
    return store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(nodeId);
  });

  if (sessionId && eventRouter) {
    eventRouter.emitPersisted({
      sessionId,
      turnId: rootTurnId,
      type: RUNTIME_EVENTS.SWARM_NODE_UPDATED,
      data: {
        runId: updated.runId,
        nodeId: updated.id,
        nodeKey: updated.nodeKey,
        status: updated.status,
        childSessionId: updated.childSessionId || undefined,
        errorCode: updated.errorCode || undefined,
      },
      audit: false,
    });
  }
  return updated;
}

export function transitionSwarmRun(
  store,
  runId,
  toStatus,
  { patch = {}, allowResume = false, leaseGuard = null } = {},
) {
  return store.tx(() => {
    const row = store.db.prepare('SELECT * FROM swarm_runs WHERE id=?').get(runId);
    if (!row) {
      throw new RuntimeError('SWARM_RUN_NOT_FOUND', { detail: { runId } });
    }
    assertLeaseInTx(leaseGuard, { runId: row.id });
    const from = row.status;
    if (from === toStatus) return row;
    if (from === 'failed' && !allowResume) {
      throw new RuntimeError('INVALID_SWARM_TRANSITION', {
        message: `Illegal swarm_run transition ${from} -> ${toStatus} without explicit resume`,
        detail: { runId, from, toStatus },
      });
    }
    const allowed = RUN_TRANSITIONS[from];
    if (!allowed || !allowed.has(toStatus)) {
      throw new RuntimeError('INVALID_SWARM_TRANSITION', {
        message: `Illegal swarm_run transition: ${from} -> ${toStatus}`,
        detail: { runId, from, toStatus },
      });
    }
    const now = Date.now();
    const fields = ['status=?', 'updatedAt=?'];
    const values = [toStatus, now];
    const allowedCols = new Set([
      'planVersion',
      'currentPhase',
      'replanCount',
      'usageJson',
      'verdictJson',
      'errorCode',
      'errorMessage',
    ]);
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (!allowedCols.has(k) || v === undefined) continue;
      fields.push(`${k}=?`);
      values.push(v);
    }
    values.push(runId, from);
    const res = store.db
      .prepare(`UPDATE swarm_runs SET ${fields.join(', ')} WHERE id=? AND status=?`)
      .run(...values);
    if (!res.changes) {
      throw new RuntimeError('INVALID_SWARM_TRANSITION', {
        message: `Concurrent swarm_run modification blocked for ${runId}`,
      });
    }
    return store.db.prepare('SELECT * FROM swarm_runs WHERE id=?').get(runId);
  });
}
