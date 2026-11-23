import { remainingRunMs } from '../swarm/run-deadline.js';
import { hostname as osHostname } from 'node:os';
import { id as uuid } from '../store.js';
import { RecoveryError } from '../kernel/errors.js';

const TERMINAL_TURN_STATES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_NODE_STATES = new Set(['completed', 'failed', 'cancelled']);

export function createWorkerId(prefix = 'worker') {
  return `${prefix}-${osHostname()}-${process.pid}-${uuid().slice(0, 8)}`;
}

export function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  if (num === process.pid) return true;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    if (err?.code === 'EPERM') return true;
    return false;
  }
}

export function registerWorker(
  store,
  { workerId, pid = process.pid, hostname = osHostname() } = {},
) {
  if (!store?.db?.isOpen || !workerId) return null;
  const now = Date.now();
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO runtime_workers(workerId, pid, hostname, status, startedAt, heartbeatAt, stoppedAt)
         VALUES(?,?,?,'active',?,?,NULL)
         ON CONFLICT(workerId) DO UPDATE SET
           pid=excluded.pid,
           hostname=excluded.hostname,
           status='active',
           heartbeatAt=excluded.heartbeatAt,
           stoppedAt=NULL`,
      )
      .run(workerId, Number(pid), String(hostname), now, now);
  });
  return { workerId, pid: Number(pid), hostname: String(hostname), status: 'active', heartbeatAt: now };
}

export function heartbeatWorker(store, workerId) {
  if (!store?.db?.isOpen || !workerId) return false;
  const now = Date.now();
  const res = store.tx(() =>
    store.db
      .prepare("UPDATE runtime_workers SET heartbeatAt=? WHERE workerId=? AND status='active'")
      .run(now, workerId),
  );
  return (res.changes ?? 0) > 0;
}

export function markWorkerStopped(store, workerId) {
  if (!store?.db?.isOpen || !workerId) return false;
  const now = Date.now();
  try {
    const res = store.tx(() =>
      store.db
        .prepare("UPDATE runtime_workers SET status='stopped', stoppedAt=?, heartbeatAt=? WHERE workerId=?")
        .run(now, now, workerId),
    );
    return (res.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

export function getWorkerRecord(store, workerId) {
  if (!store?.db?.isOpen || !workerId) return null;
  try {
    return store.db.prepare('SELECT * FROM runtime_workers WHERE workerId=?').get(workerId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Classifies whether an active job row is owned by a live worker or eligible for crash/expiry takeover.
 * Distinguishes newly joining workers from expired leases or dead OS owners.
 */
export function classifyJobOwnership(
  store,
  jobRow,
  {
    now = Date.now(),
    hostname = osHostname(),
    currentPid = process.pid,
    markDeadInDb = false,
  } = {},
) {
  if (!jobRow) {
    return { reclaimable: false, liveOwner: false, reason: 'missing', ownerWorker: null };
  }
  if (jobRow.status !== 'active') {
    return {
      reclaimable: jobRow.status === 'pending',
      liveOwner: false,
      reason: String(jobRow.status || 'non_active'),
      ownerWorker: null,
    };
  }

  const hasExpiry = jobRow.leaseExpiresAt !== null && jobRow.leaseExpiresAt !== undefined;
  if (hasExpiry && Number(jobRow.leaseExpiresAt) < now) {
    return { reclaimable: true, liveOwner: false, reason: 'lease_expired', ownerWorker: null };
  }

  const ownerWorker = jobRow.workerId ? getWorkerRecord(store, jobRow.workerId) : null;
  if (ownerWorker) {
    if (ownerWorker.status === 'stopped' || ownerWorker.status === 'dead') {
      return {
        reclaimable: true,
        liveOwner: false,
        reason: `owner_${ownerWorker.status}`,
        ownerWorker,
      };
    }
    if (
      ownerWorker.hostname === hostname &&
      Number(ownerWorker.pid) !== Number(currentPid) &&
      !isPidAlive(ownerWorker.pid)
    ) {
      if (markDeadInDb && store?.db?.isOpen) {
        try {
          store.tx(() => {
            store.db
              .prepare("UPDATE runtime_workers SET status='dead', stoppedAt=? WHERE workerId=? AND status='active'")
              .run(now, ownerWorker.workerId);
          });
        } catch {
          // best-effort marker
        }
      }
      return {
        reclaimable: true,
        liveOwner: false,
        reason: 'owner_pid_dead',
        ownerWorker,
      };
    }
    return {
      reclaimable: false,
      liveOwner: true,
      reason: 'lease_valid_live_owner',
      ownerWorker,
    };
  }

  // No runtime_workers row (e.g. direct unit test using DurableJobQueue without RecoveryWorker)
  if (hasExpiry && Number(jobRow.leaseExpiresAt) >= now) {
    return { reclaimable: false, liveOwner: true, reason: 'lease_valid', ownerWorker: null };
  }
  return { reclaimable: true, liveOwner: false, reason: 'orphan_no_lease', ownerWorker: null };
}

/**
 * Checks whether a worktree_leases row belongs to a live active job or active worker process.
 */
export function isWorktreeOwnerLive(
  store,
  leaseRow,
  { now = Date.now(), hostname = osHostname(), currentPid = process.pid } = {},
) {
  if (!store?.db?.isOpen || !leaseRow) return false;

  if (leaseRow.jobId) {
    const job = store.db.prepare('SELECT * FROM runtime_jobs WHERE id=?').get(leaseRow.jobId);
    if (job && job.status === 'active') {
      const ownership = classifyJobOwnership(store, job, { now, hostname, currentPid });
      if (ownership.liveOwner) {
        if (!leaseRow.fence || !job.fence || job.fence === leaseRow.fence) {
          return true;
        }
      }
    }
  }

  if (leaseRow.workerId) {
    const worker = getWorkerRecord(store, leaseRow.workerId);
    if (worker && worker.status === 'active') {
      if (worker.hostname !== hostname || Number(worker.pid) === Number(currentPid) || isPidAlive(worker.pid)) {
        // If no jobId is attached (e.g. direct subagent/worktree outside job queue), alive worker owns it
        if (!leaseRow.jobId) return true;
      }
    }
  }

  return false;
}

export function isLeaseLostError(err) {
  return Boolean(err?.code === 'LEASE_LOST');
}

/**
 * Synchronous transactional fence & terminal-state assertion.
 * MUST be invoked inside `store.tx(...)` for atomic ownership verification at DB commit time.
 */
export function assertJobOwnershipInTx(
  store,
  {
    jobId,
    fence,
    attempt = null,
    nodeAttempt = null,
    sessionId = null,
    turnId = null,
    runId = null,
    nodeId = null,
    allowTerminalSession = false,
    allowTerminalTurn = false,
    bindingOwnership = false,
  } = {},
) {
  if (!store?.db?.isOpen) {
    throw new RecoveryError('LEASE_LOST', {
      message: 'Store closed before commit',
      detail: { jobId },
    });
  }
  const now = Date.now();
  const job = store.db
    .prepare('SELECT id, status, fence, workerId, leaseExpiresAt, attempts, sessionId, turnId, taskId FROM runtime_jobs WHERE id=?')
    .get(jobId);

  if (
    !job ||
    job.status !== 'active' ||
    job.fence !== fence ||
    (job.leaseExpiresAt !== null && job.leaseExpiresAt !== undefined && Number(job.leaseExpiresAt) < now)
  ) {
    throw new RecoveryError('LEASE_LOST', {
      message: `Lease lost for job ${jobId}`,
      detail: { jobId, status: job?.status ?? 'missing', expectedFence: fence, actualFence: job?.fence ?? null },
    });
  }
  if (attempt !== null && attempt !== undefined && Number(job.attempts) !== Number(attempt)) {
    throw new RecoveryError('LEASE_LOST', {
      message: `Superseded job attempt for job ${jobId}: expected ${attempt}, actual ${job.attempts}`,
      detail: { jobId, expectedAttempt: attempt, actualAttempt: job.attempts },
    });
  }

  const effectiveTurnId = turnId ?? (job.turnId && !String(job.turnId).startsWith('swarm:') ? job.turnId : null);
  if (effectiveTurnId && !allowTerminalTurn) {
    const turn = store.db
      .prepare('SELECT state, activeFence FROM direct_turns WHERE id=?')
      .get(effectiveTurnId);
    if (turn) {
      if (TERMINAL_TURN_STATES.has(turn.state)) {
        throw new RecoveryError('LEASE_LOST', {
          message: `Turn ${effectiveTurnId} already reached terminal state ${turn.state}`,
          detail: { jobId, turnId: effectiveTurnId, turnState: turn.state },
        });
      }
      if (!bindingOwnership && turn.activeFence && turn.activeFence !== fence) {
        throw new RecoveryError('LEASE_LOST', {
          message: `Turn ${effectiveTurnId} superseded by newer fence`,
          detail: { jobId, turnId: effectiveTurnId },
        });
      }
    }
  }

  const effectiveSessionId = sessionId ?? job.sessionId ?? null;
  if (effectiveSessionId && !allowTerminalSession) {
    const sess = store.db
      .prepare('SELECT state FROM direct_sessions WHERE id=?')
      .get(effectiveSessionId);
    if (sess && sess.state === 'cancelled') {
      throw new RecoveryError('LEASE_LOST', {
        message: `Session ${effectiveSessionId} is cancelled`,
        detail: { jobId, sessionId: effectiveSessionId, sessionState: sess.state },
      });
    }
  }

  const effectiveRunId = runId ?? job.taskId ?? null;
  if (effectiveRunId) {
    const run = store.db.prepare("SELECT status, createdAt, json_extract(budgetJson, '$.maxDurationMs') AS maxDurationMs FROM swarm_runs WHERE id=?").get(effectiveRunId);
    if (remainingRunMs(run, now) === 0) {
      throw new RecoveryError('LEASE_LOST', { message: 'Swarm deadline elapsed', detail: { jobId, runId: effectiveRunId } });
    }
    if (run && TERMINAL_RUN_STATES.has(run.status)) {
      throw new RecoveryError('LEASE_LOST', {
        message: `Swarm run ${effectiveRunId} already reached terminal state ${run.status}`,
        detail: { jobId, runId: effectiveRunId, runStatus: run.status },
      });
    }
  }

  if (nodeId) {
    const node = store.db
      .prepare('SELECT status, activeFence, activeJobId, activeAttempt FROM swarm_nodes WHERE id=?')
      .get(nodeId);
    if (node) {
      if (TERMINAL_NODE_STATES.has(node.status)) {
        throw new RecoveryError('LEASE_LOST', {
          message: `Swarm node ${nodeId} already reached terminal state ${node.status}`,
          detail: { jobId, nodeId, nodeStatus: node.status },
        });
      }
      if (!bindingOwnership && node.activeFence && node.activeFence !== fence) {
        throw new RecoveryError('LEASE_LOST', {
          message: `Swarm node ${nodeId} superseded by newer fence`,
          detail: { jobId, nodeId },
        });
      }
      if (!bindingOwnership && node.activeJobId && node.activeJobId !== jobId) {
        throw new RecoveryError('LEASE_LOST', {
          message: `Swarm node ${nodeId} superseded by newer job ${node.activeJobId}`,
          detail: { jobId, nodeId, activeJobId: node.activeJobId },
        });
      }
      if (
        !bindingOwnership &&
        nodeAttempt !== null &&
        nodeAttempt !== undefined &&
        Number(node.activeAttempt || 0) > 0 &&
        Number(node.activeAttempt) !== Number(nodeAttempt)
      ) {
        throw new RecoveryError('LEASE_LOST', {
          message: `Swarm node ${nodeId} superseded by newer attempt ${node.activeAttempt} (expected ${nodeAttempt})`,
          detail: { jobId, nodeId, expectedNodeAttempt: nodeAttempt, actualNodeAttempt: node.activeAttempt },
        });
      }
    }
  }

  return true;
}

/**
 * Creates a callable leaseGuard with transactional commit enforcement (`assertInTx`, `runInTx`, `withContext`).
 */
export function createLeaseGuard({
  store,
  jobId,
  fence,
  workerId = null,
  attempt = null,
  nodeAttempt = null,
  sessionId = null,
  turnId = null,
  runId = null,
  nodeId = null,
}) {
  const baseCtx = { jobId, fence, attempt, nodeAttempt, sessionId, turnId, runId, nodeId };

  const assertInTx = (override = {}) =>
    assertJobOwnershipInTx(store, {
      ...baseCtx,
      ...override,
    });

  const guard = (override = {}) => assertInTx(override);
  guard.jobId = jobId;
  guard.fence = fence;
  guard.workerId = workerId;
  guard.attempt = attempt;
  guard.nodeAttempt = nodeAttempt;
  guard.sessionId = sessionId;
  guard.turnId = turnId;
  guard.runId = runId;
  guard.nodeId = nodeId;
  guard.assertInTx = assertInTx;
  guard.runInTx = (fn, override = {}) =>
    store.tx(() => {
      assertInTx(override);
      return fn();
    });
  guard.isHeld = (override = {}) => {
    try {
      assertInTx(override);
      return true;
    } catch (err) {
      if (isLeaseLostError(err)) return false;
      throw err;
    }
  };
  guard.withContext = (extra = {}) =>
    createLeaseGuard({
      store,
      workerId,
      ...baseCtx,
      ...extra,
    });

  return guard;
}

export function assertLeaseInTx(leaseGuard, override = {}) {
  if (!leaseGuard) return true;
  if (typeof leaseGuard.assertInTx === 'function') {
    return leaseGuard.assertInTx(override);
  }
  if (typeof leaseGuard === 'function') {
    return leaseGuard(override);
  }
  return true;
}

export function checkLeaseHeld(leaseGuard, override = {}) {
  if (!leaseGuard) return true;
  try {
    assertLeaseInTx(leaseGuard, override);
    return true;
  } catch (err) {
    if (isLeaseLostError(err)) return false;
    throw err;
  }
}
