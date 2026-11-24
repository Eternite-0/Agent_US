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
  ready: new Set(['pending', 'queued', 'running', 'failed', 'cancelled']),
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
  reconciling: new Set(['ready', 'queued', 'running', 'failed', 'cancelled']),
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

const ALLOWED_NODE_PATCH_COLS = new Set([
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
  'budgetJson',
  'isolationMode',
  'worktreePath',
]);

const ALLOWED_RUN_PATCH_COLS = new Set([
  'planVersion',
  'currentPhase',
  'replanCount',
  'usageJson',
  'budgetJson',
  'verdictJson',
  'errorCode',
  'errorMessage',
  'finishedAt',
]);

function attachChangedFlag(row, changed, casRejected = false) {
  if (row && typeof row === 'object') {
    Object.defineProperty(row, 'changed', {
      value: Boolean(changed),
      enumerable: false,
      configurable: true,
    });
    if (casRejected) {
      Object.defineProperty(row, 'casRejected', {
        value: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      Object.defineProperty(row, 'casRejected', {
        value: false,
        enumerable: false,
        configurable: true,
      });
    }
  }
  return row;
}

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
    expectedPlanVersion = undefined,
    emitEvent = true,
  } = {},
) {
  const { updated, changed } = store.tx(() => {
    const row = store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(nodeId);
    if (!row) {
      throw new RuntimeError('SWARM_NODE_NOT_FOUND', { detail: { nodeId } });
    }
    assertLeaseInTx(leaseGuard, { runId: row.runId, nodeId: row.id, bindingOwnership });
    const from = row.status;
    const definedEntries = Object.entries(patch ?? {}).filter(([, v]) => v !== undefined);
    const validEntries = definedEntries.filter(([k]) => ALLOWED_NODE_PATCH_COLS.has(k));

    if (from === toStatus) {
      // Strictly protect terminal states (completed/failed/cancelled) from metadata overwrites
      if (isTerminalNodeState(from)) {
        if (definedEntries.length > 0) {
          throw new RuntimeError('INVALID_SWARM_TRANSITION', {
            message: `Cannot overwrite metadata on terminal swarm_node state (${from})`,
            detail: { nodeId, nodeKey: row.nodeKey, from, toStatus },
          });
        }
        return { updated: row, changed: false };
      }
      if (validEntries.length === 0 && expectedPlanVersion === undefined) {
        return { updated: row, changed: false };
      }
    } else {
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
    }

    const now = Date.now();
    const fields = ['status=?', 'updatedAt=?'];
    const values = [toStatus, now];
    for (const [k, v] of validEntries) {
      fields.push(`${k}=?`);
      values.push(v);
    }

    const where = ['id=?', 'status=?'];
    values.push(nodeId, from);
    if (isTerminalNodeState(toStatus)) {
      where.push("status NOT IN ('completed','failed','cancelled')");
    }
    if (expectedPlanVersion !== undefined) {
      where.push('planVersion=?');
      values.push(Number(expectedPlanVersion));
    }

    const res = store.db
      .prepare(`UPDATE swarm_nodes SET ${fields.join(', ')} WHERE ${where.join(' AND ')}`)
      .run(...values);
    if (!res.changes) {
      throw new RuntimeError('INVALID_SWARM_TRANSITION', {
        message: `Concurrent swarm_node modification blocked for ${nodeId}`,
        detail: {
          nodeId,
          from,
          toStatus,
          ...(expectedPlanVersion !== undefined ? { expectedPlanVersion, casConflict: true } : {}),
        },
      });
    }
    return {
      updated: store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(nodeId),
      changed: true,
    };
  });

  if (changed && emitEvent && sessionId && eventRouter) {
    try {
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
    } catch {
      // best-effort event emission after committed node transition
    }
  }
  return attachChangedFlag(updated, changed);
}

export function transitionSwarmRun(
  store,
  runId,
  toStatus,
  {
    patch = {},
    allowResume = false,
    leaseGuard = null,
    expectedPlanVersion = undefined,
    expectedReplanCount = undefined,
  } = {},
) {
  const { updated, changed } = store.tx(() => {
    const row = store.db.prepare('SELECT * FROM swarm_runs WHERE id=?').get(runId);
    if (!row) {
      throw new RuntimeError('SWARM_RUN_NOT_FOUND', { detail: { runId } });
    }
    assertLeaseInTx(leaseGuard, { runId: row.id });
    const from = row.status;
    const definedEntries = Object.entries(patch ?? {}).filter(([, v]) => v !== undefined);
    const validEntries = definedEntries.filter(([k]) => ALLOWED_RUN_PATCH_COLS.has(k));

    if (from === toStatus) {
      // Strictly protect terminal states (completed/failed/cancelled) from metadata overwrites
      if (isTerminalRunState(from)) {
        if (definedEntries.length > 0) {
          throw new RuntimeError('INVALID_SWARM_TRANSITION', {
            message: `Cannot overwrite metadata on terminal swarm_run state (${from})`,
            detail: { runId, from, toStatus },
          });
        }
        return { updated: row, changed: false };
      }
      if (
        validEntries.length === 0 &&
        expectedPlanVersion === undefined &&
        expectedReplanCount === undefined
      ) {
        return { updated: row, changed: false };
      }
    } else {
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
    }

    const now = Date.now();
    const fields = ['status=?', 'updatedAt=?'];
    const values = [toStatus, now];
    let hasFinishedAt = false;
    for (const [k, v] of validEntries) {
      if (k === 'finishedAt') hasFinishedAt = true;
      fields.push(`${k}=?`);
      values.push(v);
    }
    if (isTerminalRunState(toStatus) && !hasFinishedAt) {
      fields.push('finishedAt=COALESCE(finishedAt, ?)');
      values.push(now);
    }

    const where = ['id=?', 'status=?'];
    values.push(runId, from);
    if (isTerminalRunState(toStatus)) {
      where.push("status NOT IN ('completed','failed','cancelled')");
    }
    if (expectedPlanVersion !== undefined) {
      where.push('planVersion=?');
      values.push(Number(expectedPlanVersion));
    }
    if (expectedReplanCount !== undefined) {
      where.push('replanCount=?');
      values.push(Number(expectedReplanCount));
    }

    const res = store.db
      .prepare(`UPDATE swarm_runs SET ${fields.join(', ')} WHERE ${where.join(' AND ')}`)
      .run(...values);
    if (!res.changes) {
      throw new RuntimeError('INVALID_SWARM_TRANSITION', {
        message: `Concurrent swarm_run modification blocked for ${runId}`,
        detail: {
          runId,
          from,
          toStatus,
          ...(expectedPlanVersion !== undefined ? { expectedPlanVersion, casConflict: true } : {}),
          ...(expectedReplanCount !== undefined ? { expectedReplanCount, casConflict: true } : {}),
        },
      });
    }
    return {
      updated: store.db.prepare('SELECT * FROM swarm_runs WHERE id=?').get(runId),
      changed: true,
    };
  });
  return attachChangedFlag(updated, changed);
}

/**
 * Atomic SQLite CAS terminal transition for `swarm_nodes` enforcing
 * `WHERE status NOT IN ('completed','failed','cancelled')` so late/racy
 * timeouts or retries NEVER overwrite an already-terminal node.
 */
export function transitionNodeTerminalCas(
  store,
  eventRouter,
  nodeId,
  toStatus,
  {
    sessionId = null,
    rootTurnId = null,
    patch = {},
    leaseGuard = null,
    bindingOwnership = false,
    expectedPlanVersion = undefined,
    emitEvent = true,
    throwOnTerminal = false,
  } = {},
) {
  if (!isTerminalNodeState(toStatus)) {
    throw new RuntimeError('INVALID_SWARM_TRANSITION', {
      message: `transitionNodeTerminalCas requires a terminal status, got ${toStatus}`,
      detail: { nodeId, toStatus },
    });
  }
  const { updated, changed, casRejected } = store.tx(() => {
    const row = store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(nodeId);
    if (!row) {
      throw new RuntimeError('SWARM_NODE_NOT_FOUND', { detail: { nodeId } });
    }
    assertLeaseInTx(leaseGuard, { runId: row.runId, nodeId: row.id, bindingOwnership });

    if (isTerminalNodeState(row.status)) {
      if (throwOnTerminal) {
        throw new RuntimeError('INVALID_SWARM_TRANSITION', {
          message: `Cannot overwrite terminal swarm_node state (${row.status}) -> ${toStatus}`,
          detail: { nodeId, nodeKey: row.nodeKey, from: row.status, toStatus, casConflict: true },
        });
      }
      return { updated: row, changed: false, casRejected: true };
    }

    const validEntries = Object.entries(patch ?? {}).filter(
      ([k, v]) => v !== undefined && ALLOWED_NODE_PATCH_COLS.has(k),
    );
    const now = Date.now();
    const fields = ['status=?', 'updatedAt=?'];
    const values = [toStatus, now];
    for (const [k, v] of validEntries) {
      fields.push(`${k}=?`);
      values.push(v);
    }

    const where = ['id=?', "status NOT IN ('completed','failed','cancelled')"];
    values.push(nodeId);
    if (expectedPlanVersion !== undefined) {
      where.push('planVersion=?');
      values.push(Number(expectedPlanVersion));
    }

    const res = store.db
      .prepare(`UPDATE swarm_nodes SET ${fields.join(', ')} WHERE ${where.join(' AND ')}`)
      .run(...values);
    const fresh = store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(nodeId);
    if (!res.changes) {
      if (throwOnTerminal) {
        throw new RuntimeError('INVALID_SWARM_TRANSITION', {
          message: `Atomic terminal CAS rejected for swarm_node ${nodeId}`,
          detail: { nodeId, from: fresh?.status ?? row.status, toStatus, casConflict: true },
        });
      }
      return { updated: fresh ?? row, changed: false, casRejected: true };
    }
    return { updated: fresh, changed: true, casRejected: false };
  });

  if (changed && emitEvent && sessionId && eventRouter) {
    try {
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
    } catch {
      // best-effort event emission after committed node transition
    }
  }
  return attachChangedFlag(updated, changed, casRejected);
}

/**
 * Atomic SQLite CAS terminal transition for `swarm_runs` enforcing
 * `WHERE status NOT IN ('completed','failed','cancelled')` so late/racy
 * timeouts or retries NEVER overwrite an already-terminal run.
 */
export function transitionRunTerminalCas(
  store,
  runId,
  toStatus,
  {
    patch = {},
    leaseGuard = null,
    expectedPlanVersion = undefined,
    expectedReplanCount = undefined,
    throwOnTerminal = false,
  } = {},
) {
  if (!isTerminalRunState(toStatus)) {
    throw new RuntimeError('INVALID_SWARM_TRANSITION', {
      message: `transitionRunTerminalCas requires a terminal status, got ${toStatus}`,
      detail: { runId, toStatus },
    });
  }
  const { updated, changed, casRejected } = store.tx(() => {
    const row = store.db.prepare('SELECT * FROM swarm_runs WHERE id=?').get(runId);
    if (!row) {
      throw new RuntimeError('SWARM_RUN_NOT_FOUND', { detail: { runId } });
    }
    assertLeaseInTx(leaseGuard, { runId: row.id });

    if (isTerminalRunState(row.status)) {
      if (throwOnTerminal) {
        throw new RuntimeError('INVALID_SWARM_TRANSITION', {
          message: `Cannot overwrite terminal swarm_run state (${row.status}) -> ${toStatus}`,
          detail: { runId, from: row.status, toStatus, casConflict: true },
        });
      }
      return { updated: row, changed: false, casRejected: true };
    }

    const validEntries = Object.entries(patch ?? {}).filter(
      ([k, v]) => v !== undefined && ALLOWED_RUN_PATCH_COLS.has(k),
    );
    const now = Date.now();
    const fields = ['status=?', 'updatedAt=?'];
    const values = [toStatus, now];
    let hasFinishedAt = false;
    for (const [k, v] of validEntries) {
      if (k === 'finishedAt') hasFinishedAt = true;
      fields.push(`${k}=?`);
      values.push(v);
    }
    if (!hasFinishedAt) {
      fields.push('finishedAt=COALESCE(finishedAt, ?)');
      values.push(now);
    }

    const where = ['id=?', "status NOT IN ('completed','failed','cancelled')"];
    values.push(runId);
    if (expectedPlanVersion !== undefined) {
      where.push('planVersion=?');
      values.push(Number(expectedPlanVersion));
    }
    if (expectedReplanCount !== undefined) {
      where.push('replanCount=?');
      values.push(Number(expectedReplanCount));
    }

    const res = store.db
      .prepare(`UPDATE swarm_runs SET ${fields.join(', ')} WHERE ${where.join(' AND ')}`)
      .run(...values);
    const fresh = store.db.prepare('SELECT * FROM swarm_runs WHERE id=?').get(runId);
    if (!res.changes) {
      if (throwOnTerminal) {
        throw new RuntimeError('INVALID_SWARM_TRANSITION', {
          message: `Atomic terminal CAS rejected for swarm_run ${runId}`,
          detail: { runId, from: fresh?.status ?? row.status, toStatus, casConflict: true },
        });
      }
      return { updated: fresh ?? row, changed: false, casRejected: true };
    }
    return { updated: fresh, changed: true, casRejected: false };
  });
  return attachChangedFlag(updated, changed, casRejected);
}
