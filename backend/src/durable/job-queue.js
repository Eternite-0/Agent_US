import { id as uuid } from '../store.js';
import { RecoveryError } from '../kernel/errors.js';
import {
  assertJobOwnershipInTx,
  classifyJobOwnership,
  heartbeatWorker,
} from './lease-guard.js';

/**
 * SQLite-backed Durable Job Queue with lease expiration, fencing tokens,
 * idempotency keys, and terminal-state protection against stale workers.
 */
export class DurableJobQueue {
  constructor(store, { defaultLeaseMs = 15000 } = {}) {
    this.store = store;
    this.defaultLeaseMs = Math.max(1000, Number(defaultLeaseMs || 15000));
  }

  enqueue({
    kind,
    sessionId = null,
    turnId = null,
    taskId = null,
    parentJobId = null,
    payload = {},
    idempotencyKey = null,
    maxAttempts = 3,
  }) {
    const job = this.store.tx(() => {
      if (idempotencyKey) {
        const existing = this.store.db
          .prepare('SELECT * FROM runtime_jobs WHERE idempotencyKey=?')
          .get(idempotencyKey);
        if (existing) {
          return {
            ...existing,
            payload: JSON.parse(existing.payload || '{}'),
            deduplicated: true,
          };
        }
      }
      const now = Date.now();
      const jobId = uuid();
      this.store.db
        .prepare(
          `INSERT INTO runtime_jobs(
            id, kind, sessionId, turnId, taskId, parentJobId, payload,
            status, fence, workerId, leaseExpiresAt, attempts, maxAttempts,
            idempotencyKey, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,?,'pending',NULL,NULL,NULL,0,?,?,?,?)`,
        )
        .run(
          jobId,
          kind,
          sessionId,
          turnId,
          taskId,
          parentJobId,
          JSON.stringify(payload ?? {}),
          Math.max(1, Number(maxAttempts || 3)),
          idempotencyKey,
          now,
          now,
        );
      const row = this.store.db
        .prepare('SELECT * FROM runtime_jobs WHERE id=?')
        .get(jobId);
      return {
        ...row,
        payload: JSON.parse(row.payload || '{}'),
        deduplicated: false,
      };
    });
    this.store.notifyJobWake();
    return job;
  }

  hasLiveJobs({ kinds = null } = {}) {
    try {
      const now = Date.now();
      if (Array.isArray(kinds) && kinds.length) {
        const ph = kinds.map(() => '?').join(',');
        return Boolean(
          this.store.db
            .prepare(
              `SELECT 1 FROM runtime_jobs WHERE kind IN (${ph}) AND (status='pending' OR (status='active' AND (leaseExpiresAt IS NULL OR leaseExpiresAt>=?))) LIMIT 1`,
            )
            .get(...kinds, now - 60_000),
        );
      }
      return Boolean(
        this.store.db
          .prepare("SELECT 1 FROM runtime_jobs WHERE status IN ('pending','active') LIMIT 1")
          .get(),
      );
    } catch {
      return false;
    }
  }

  claim({ workerId = `worker-${process.pid}`, kinds = null, leaseMs = this.defaultLeaseMs } = {}) {
    const db = this.store.db;
    return this.store.tx(() => {
      const now = Date.now();
      const kindClause =
        Array.isArray(kinds) && kinds.length
          ? `AND kind IN (${kinds.map(() => '?').join(',')})`
          : '';
      const kindParams = Array.isArray(kinds) && kinds.length ? kinds : [];

      const candidates = db
        .prepare(
          `SELECT * FROM runtime_jobs
           WHERE status IN ('pending', 'active')
           ${kindClause}
           ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END ASC, createdAt ASC, rowid ASC`,
        )
        .all(...kindParams);

      for (const row of candidates) {
        if (row.status === 'active') {
          const ownership = classifyJobOwnership(this.store, row, { now, markDeadInDb: true });
          if (!ownership.reclaimable) {
            continue;
          }
        }

        // Guard: never resurrect cancelled/terminal turns, sessions, swarm runs, or swarm nodes
        if (row.turnId && !String(row.turnId).startsWith('swarm:')) {
          const turn = db
            .prepare('SELECT state FROM direct_turns WHERE id=?')
            .get(row.turnId);
          if (turn && ['completed', 'failed', 'cancelled'].includes(turn.state)) {
            const finalStatus = turn.state === 'completed' ? 'done' : turn.state;
            db.prepare(
              'UPDATE runtime_jobs SET status=?, fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE id=?',
            ).run(finalStatus, now, row.id);
            continue;
          }
        }
        if (row.sessionId) {
          const sess = db
            .prepare('SELECT state FROM direct_sessions WHERE id=?')
            .get(row.sessionId);
          if (sess && sess.state === 'cancelled') {
            db.prepare(
              "UPDATE runtime_jobs SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE id=?",
            ).run(now, row.id);
            continue;
          }
        }
        if (row.taskId) {
          const run = db
            .prepare('SELECT status FROM swarm_runs WHERE id=?')
            .get(row.taskId);
          if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) {
            const finalStatus = run.status === 'completed' ? 'done' : run.status;
            db.prepare(
              'UPDATE runtime_jobs SET status=?, fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE id=?',
            ).run(finalStatus, now, row.id);
            continue;
          }
        }

        let payload = {};
        try {
          payload = JSON.parse(row.payload || '{}');
        } catch {
          payload = {};
        }

        if (row.kind === 'swarm_node_execute' && payload.nodeId) {
          const node = db
            .prepare('SELECT status FROM swarm_nodes WHERE id=?')
            .get(payload.nodeId);
          if (node && ['completed', 'cancelled'].includes(node.status)) {
            const finalStatus = node.status === 'completed' ? 'done' : 'cancelled';
            db.prepare(
              'UPDATE runtime_jobs SET status=?, fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE id=?',
            ).run(finalStatus, now, row.id);
            continue;
          }
        }

        if (row.attempts >= row.maxAttempts) {
          db.prepare(
            "UPDATE runtime_jobs SET status='failed', fence=NULL, leaseExpiresAt=NULL, errorCode='ATTEMPTS_EXHAUSTED', errorMessage='Max attempts exhausted', updatedAt=? WHERE id=?",
          ).run(now, row.id);
          continue;
        }

        const fence = uuid();
        const expires = now + Math.max(1000, Number(leaseMs || this.defaultLeaseMs));
        db.prepare(
          `UPDATE runtime_jobs
           SET status='active', fence=?, workerId=?, leaseExpiresAt=?, attempts=attempts+1, updatedAt=?
           WHERE id=?`,
        ).run(fence, workerId, expires, now, row.id);

        return {
          ...row,
          status: 'active',
          fence,
          workerId,
          leaseExpiresAt: expires,
          attempts: row.attempts + 1,
          reclaimedFromCrash: row.status === 'active',
          payload,
        };
      }
      return null;
    });
  }

  renewLease(jobId, fence, leaseMs = this.defaultLeaseMs) {
    const now = Date.now();
    const expires = now + Math.max(1000, Number(leaseMs || this.defaultLeaseMs));
    const res = this.store.tx(() => {
      const r = this.store.db
        .prepare(
          "UPDATE runtime_jobs SET leaseExpiresAt=?, updatedAt=? WHERE id=? AND fence=? AND status='active'",
        )
        .run(expires, now, jobId, fence);
      if ((r.changes ?? 0) > 0) {
        const row = this.store.db.prepare('SELECT workerId FROM runtime_jobs WHERE id=?').get(jobId);
        if (row?.workerId) heartbeatWorker(this.store, row.workerId);
      }
      return r;
    });
    return (res.changes ?? 0) > 0;
  }

  assertFence(jobId, fence, opts = {}) {
    return assertJobOwnershipInTx(this.store, { jobId, fence, ...opts });
  }

  complete(jobId, fence) {
    return this.store.tx(() => {
      const now = Date.now();
      const res = this.store.db
        .prepare(
          "UPDATE runtime_jobs SET status='done', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE id=? AND fence=? AND status='active'",
        )
        .run(now, jobId, fence);
      if (!res.changes) {
        throw new RecoveryError('LEASE_LOST', {
          message: `Cannot complete job ${jobId}: fence mismatch or non-active status`,
        });
      }
      return this.get(jobId);
    });
  }

  fail(jobId, fence, err, { retryable = false } = {}) {
    return this.store.tx(() => {
      const row = this.store.db
        .prepare('SELECT * FROM runtime_jobs WHERE id=?')
        .get(jobId);
      if (!row || row.status !== 'active' || row.fence !== fence) {
        throw new RecoveryError('LEASE_LOST', {
          message: `Cannot fail job ${jobId}: fence mismatch or terminal status`,
        });
      }
      const now = Date.now();
      const canRetry = Boolean(retryable && row.attempts < row.maxAttempts);
      const nextStatus = canRetry ? 'pending' : 'failed';
      this.store.db
        .prepare(
          `UPDATE runtime_jobs
           SET status=?, fence=NULL, leaseExpiresAt=NULL, errorCode=?, errorMessage=?, updatedAt=?
           WHERE id=? AND fence=? AND status='active'`,
        )
        .run(
          nextStatus,
          String(err?.code || 'JOB_FAILED'),
          String(err?.message || err || '').slice(0, 1000),
          now,
          jobId,
          fence,
        );
      if (canRetry) this.store.notifyJobWake();
      return this.get(jobId);
    });
  }

  park(jobId, fence, { status = 'parked', reason = null } = {}) {
    const allowed = status === 'reconciling' ? 'reconciling' : 'parked';
    return this.store.tx(() => {
      const now = Date.now();
      const res = this.store.db
        .prepare(
          "UPDATE runtime_jobs SET status=?, fence=NULL, leaseExpiresAt=NULL, errorMessage=?, updatedAt=? WHERE id=? AND fence=? AND status='active'",
        )
        .run(allowed, reason ? String(reason).slice(0, 500) : null, now, jobId, fence);
      if (!res.changes) {
        throw new RecoveryError('LEASE_LOST', {
          message: `Cannot park job ${jobId}: fence mismatch or non-active status`,
        });
      }
      return this.get(jobId);
    });
  }

  resumeParked(jobId, payloadPatch = null) {
    const out = this.store.tx(() => {
      const row = this.store.db
        .prepare('SELECT * FROM runtime_jobs WHERE id=?')
        .get(jobId);
      if (!row || !['parked', 'reconciling'].includes(row.status)) {
        return null;
      }
      const nextPayload = payloadPatch
        ? { ...JSON.parse(row.payload || '{}'), ...payloadPatch }
        : JSON.parse(row.payload || '{}');
      this.store.db
        .prepare(
          "UPDATE runtime_jobs SET status='pending', fence=NULL, leaseExpiresAt=NULL, payload=?, updatedAt=? WHERE id=?",
        )
        .run(JSON.stringify(nextPayload), Date.now(), jobId);
      return this.get(jobId);
    });
    if (out) this.store.notifyJobWake();
    return out;
  }

  cancelByTurn(turnId) {
    return this.store.tx(() => {
      const now = Date.now();
      const res = this.store.db
        .prepare(
          "UPDATE runtime_jobs SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE turnId=? AND status IN ('pending','active','parked','reconciling')",
        )
        .run(now, turnId);
      return res.changes ?? 0;
    });
  }

  cancelBySession(sessionId) {
    return this.store.tx(() => {
      const now = Date.now();
      const res = this.store.db
        .prepare(
          "UPDATE runtime_jobs SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE sessionId=? AND status IN ('pending','active','parked','reconciling')",
        )
        .run(now, sessionId);
      return res.changes ?? 0;
    });
  }

  get(jobId) {
    const row = this.store.db
      .prepare('SELECT * FROM runtime_jobs WHERE id=?')
      .get(jobId);
    if (!row) return null;
    return { ...row, payload: JSON.parse(row.payload || '{}') };
  }
}
