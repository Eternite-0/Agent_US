import { id as uuid } from '../store.js';
import { RecoveryError } from '../kernel/errors.js';
import { convergeScheduledRunForTurn } from '../governance/scheduler.js';
import {
  assertJobOwnershipInTx,
  classifyJobOwnership,
  getWorkerRecord,
  heartbeatWorker,
} from './lease-guard.js';

const SWARM_CONTROL_KINDS = new Set([
  'swarm_plan',
  'swarm_dependency_resolve',
  'swarm_dispatch',
  'swarm_aggregate',
  'swarm_verify',
]);

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * SQLite-backed Durable Job Queue with lease expiration, fencing tokens,
 * idempotency keys, and terminal-state protection against stale workers.
 */
export class DurableJobQueue {
  constructor(store, { defaultLeaseMs = 15000, metrics = null } = {}) {
    this.store = store;
    this.defaultLeaseMs = Math.max(1000, Number(defaultLeaseMs || 15000));
    this.metrics = metrics ?? null;
  }

  #dbOpen() {
    try {
      return Boolean(this.store?.db?.isOpen);
    } catch {
      return false;
    }
  }

  #convergeJobFailureTx(row, payload, errCode, errMsg, now) {
    const db = this.store.db;
    const codeStr = String(errCode || 'JOB_FAILED');
    const msgStr = String(errMsg || codeStr).slice(0, 1000);

    if (row.turnId && !String(row.turnId).startsWith('swarm:')) {
      const turnRes = db
        .prepare(
          `UPDATE direct_turns
           SET state='failed', phase='failed', error=COALESCE(error, ?),
               finishedAt=COALESCE(finishedAt, ?), activeFence=NULL
           WHERE id=? AND state NOT IN ('completed','failed','cancelled')`,
        )
        .run(msgStr, now, row.turnId);
      if ((turnRes.changes ?? 0) > 0 && row.sessionId) {
        db.prepare(
          "UPDATE direct_sessions SET state='failed', updatedAt=? WHERE id=? AND state NOT IN ('completed','cancelled')",
        ).run(now, row.sessionId);
      }
      convergeScheduledRunForTurn(this.store, row.turnId, {
        status: 'failed',
        error: msgStr,
        finishedAt: now,
      });
    }

    if (row.kind === 'swarm_node_execute' && payload?.nodeId) {
      const nodeRes = db
        .prepare(
          `UPDATE swarm_nodes
           SET status='failed', errorCode=COALESCE(errorCode, ?), errorMessage=COALESCE(errorMessage, ?),
               activeFence=NULL, activeJobId=NULL, updatedAt=?
           WHERE id=? AND status NOT IN ('completed','failed','cancelled')`,
        )
        .run(codeStr, msgStr, now, payload.nodeId);
      if ((nodeRes.changes ?? 0) > 0 && row.taskId) {
        const runRow = db
          .prepare('SELECT id, sessionId, status, planVersion FROM swarm_runs WHERE id=?')
          .get(row.taskId);
        if (runRow && !['completed', 'failed', 'cancelled'].includes(runRow.status)) {
          const hasResolve = db
            .prepare(
              "SELECT 1 FROM runtime_jobs WHERE taskId=? AND kind='swarm_dependency_resolve' AND status IN ('pending','active') LIMIT 1",
            )
            .get(row.taskId);
          if (!hasResolve) {
            const resolveJobId = uuid();
            const resolvePayload = {
              runId: runRow.id,
              sessionId: runRow.sessionId,
              planVersion: Number(runRow.planVersion || 1),
              epoch: now,
            };
            db.prepare(
              `INSERT OR IGNORE INTO runtime_jobs(
                id, kind, sessionId, turnId, taskId, parentJobId, payload,
                status, fence, workerId, leaseExpiresAt, attempts, maxAttempts,
                idempotencyKey, createdAt, updatedAt
              ) VALUES(?,'swarm_dependency_resolve',?,?,?,NULL,?,'pending',NULL,NULL,NULL,0,3,?,?,?)`,
            ).run(
              resolveJobId,
              runRow.sessionId,
              `swarm:${runRow.id}`,
              runRow.id,
              JSON.stringify(resolvePayload),
              `swarm:resolve:${runRow.id}:exhaust:${row.id.slice(0, 8)}`,
              now,
              now,
            );
            this.store.notifyJobWake();
          }
        }
      }
    } else if (SWARM_CONTROL_KINDS.has(row.kind) && row.taskId) {
      db.prepare(
        `UPDATE swarm_runs
         SET status='failed', currentPhase='failed', errorCode=COALESCE(errorCode, ?),
             errorMessage=COALESCE(errorMessage, ?), finishedAt=COALESCE(finishedAt, ?), updatedAt=?
         WHERE id=? AND status NOT IN ('completed','failed','cancelled')`,
      ).run(codeStr, msgStr, now, now, row.taskId);
    }
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
    if (!this.#dbOpen()) return null;
    const job = this.store.tx(() => {
      if (idempotencyKey) {
        const existing = this.store.db
          .prepare('SELECT * FROM runtime_jobs WHERE idempotencyKey=?')
          .get(idempotencyKey);
        if (existing) {
          return {
            ...existing,
            payload: parseJsonSafe(existing.payload, {}),
            deduplicated: true,
          };
        }
      }
      const now = Date.now();
      // A post-commit swarm event can synchronously cancel the run before a
      // handler enqueues its successor. Serialize admission with cancellation.
      if (taskId && kind.startsWith('swarm_')) {
        const run = this.store.db.prepare('SELECT status FROM swarm_runs WHERE id=?').get(taskId);
        if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) return null;
      }
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
        payload: parseJsonSafe(row.payload, {}),
        deduplicated: false,
      };
    });
    if (!job) return null;
    if (job.deduplicated) {
      this.metrics?.record?.('job_idem_dedup', {
        jobId: job.id,
        sessionId: job.sessionId ?? sessionId,
        turnId: job.turnId && !String(job.turnId).startsWith('swarm:') ? job.turnId : null,
        runId: job.taskId ?? taskId,
        ok: true,
        code: kind,
      });
    }
    this.store.notifyJobWake();
    return job;
  }

  hasLiveJobs({ kinds = null } = {}) {
    if (!this.#dbOpen()) return false;
    try {
      if (Array.isArray(kinds) && kinds.length) {
        const ph = kinds.map(() => '?').join(',');
        return Boolean(
          this.store.db
            .prepare(
              `SELECT 1 FROM runtime_jobs WHERE kind IN (${ph}) AND status IN ('pending','active') LIMIT 1`,
            )
            .get(...kinds),
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
    if (!this.#dbOpen()) return null;
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

        const payload = parseJsonSafe(row.payload, {});

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
          this.#convergeJobFailureTx(row, payload, 'ATTEMPTS_EXHAUSTED', 'Max attempts exhausted', now);
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
    if (!this.#dbOpen()) return false;
    const now = Date.now();
    const expires = now + Math.max(1000, Number(leaseMs || this.defaultLeaseMs));
    const res = this.store.tx(() => {
      const current = this.store.db
        .prepare('SELECT workerId, status, fence, leaseExpiresAt FROM runtime_jobs WHERE id=?')
        .get(jobId);
      if (
        !current ||
        current.status !== 'active' ||
        current.fence !== fence ||
        (current.leaseExpiresAt !== null &&
          current.leaseExpiresAt !== undefined &&
          Number(current.leaseExpiresAt) < now)
      ) {
        return { changes: 0 };
      }
      if (current.workerId) {
        const worker = getWorkerRecord(this.store, current.workerId);
        if (worker && worker.status !== 'active') {
          return { changes: 0 };
        }
      }
      const r = this.store.db
        .prepare(
          `UPDATE runtime_jobs
           SET leaseExpiresAt=?, updatedAt=?
           WHERE id=? AND fence=? AND status='active'
             AND (leaseExpiresAt IS NULL OR leaseExpiresAt >= ?)`,
        )
        .run(expires, now, jobId, fence, now);
      if ((r.changes ?? 0) > 0 && current.workerId) {
        heartbeatWorker(this.store, current.workerId);
      }
      return r;
    });
    return (res.changes ?? 0) > 0;
  }

  assertFence(jobId, fence, opts = {}) {
    return assertJobOwnershipInTx(this.store, { jobId, fence, ...opts });
  }

  complete(jobId, fence) {
    if (!this.#dbOpen()) {
      throw new RecoveryError('LEASE_LOST', {
        message: `Cannot complete job ${jobId}: store closed`,
      });
    }
    return this.store.tx(() => {
      const now = Date.now();
      const res = this.store.db
        .prepare(
          `UPDATE runtime_jobs
           SET status='done', fence=NULL, leaseExpiresAt=NULL, updatedAt=?
           WHERE id=? AND fence=? AND status='active'
             AND (leaseExpiresAt IS NULL OR leaseExpiresAt >= ?)`,
        )
        .run(now, jobId, fence, now);
      if (!res.changes) {
        this.metrics?.record?.('lease_lost_fenced', {
          jobId,
          fence,
          ok: false,
          code: 'COMPLETE_FENCED',
        });
        throw new RecoveryError('LEASE_LOST', {
          message: `Cannot complete job ${jobId}: fence mismatch, expired lease, or non-active status`,
        });
      }
      return this.get(jobId);
    });
  }

  fail(jobId, fence, err, { retryable = false } = {}) {
    if (!this.#dbOpen()) {
      throw new RecoveryError('LEASE_LOST', {
        message: `Cannot fail job ${jobId}: store closed`,
      });
    }
    return this.store.tx(() => {
      const now = Date.now();
      const row = this.store.db
        .prepare('SELECT * FROM runtime_jobs WHERE id=?')
        .get(jobId);
      if (
        !row ||
        row.status !== 'active' ||
        row.fence !== fence ||
        (row.leaseExpiresAt !== null &&
          row.leaseExpiresAt !== undefined &&
          Number(row.leaseExpiresAt) < now)
      ) {
        this.metrics?.record?.('lease_lost_fenced', {
          jobId,
          fence,
          ok: false,
          code: 'FAIL_FENCED',
        });
        throw new RecoveryError('LEASE_LOST', {
          message: `Cannot fail job ${jobId}: fence mismatch, expired lease, or terminal status`,
        });
      }
      const canRetry = Boolean(retryable && row.attempts < row.maxAttempts);
      const nextStatus = canRetry ? 'pending' : 'failed';
      const errCode = String(err?.code || 'JOB_FAILED');
      const errMsg = String(err?.message || err || '').slice(0, 1000);
      const res = this.store.db
        .prepare(
          `UPDATE runtime_jobs
           SET status=?, fence=NULL, leaseExpiresAt=NULL, errorCode=?, errorMessage=?, updatedAt=?
           WHERE id=? AND fence=? AND status='active'
             AND (leaseExpiresAt IS NULL OR leaseExpiresAt >= ?)`,
        )
        .run(nextStatus, errCode, errMsg, now, jobId, fence, now);
      if (!res.changes) {
        this.metrics?.record?.('lease_lost_fenced', {
          jobId,
          fence,
          ok: false,
          code: 'FAIL_FENCED',
        });
        throw new RecoveryError('LEASE_LOST', {
          message: `Cannot fail job ${jobId}: concurrent lease takeover`,
        });
      }
      if (canRetry) {
        this.store.notifyJobWake();
      } else {
        this.#convergeJobFailureTx(row, parseJsonSafe(row.payload, {}), errCode, errMsg, now);
      }
      return this.get(jobId);
    });
  }

  park(jobId, fence, { status = 'parked', reason = null } = {}) {
    if (!this.#dbOpen()) {
      throw new RecoveryError('LEASE_LOST', {
        message: `Cannot park job ${jobId}: store closed`,
      });
    }
    const allowed = status === 'reconciling' ? 'reconciling' : 'parked';
    return this.store.tx(() => {
      const now = Date.now();
      const res = this.store.db
        .prepare(
          `UPDATE runtime_jobs
           SET status=?, fence=NULL, leaseExpiresAt=NULL, errorMessage=?, updatedAt=?
           WHERE id=? AND fence=? AND status='active'
             AND (leaseExpiresAt IS NULL OR leaseExpiresAt >= ?)`,
        )
        .run(allowed, reason ? String(reason).slice(0, 500) : null, now, jobId, fence, now);
      if (!res.changes) {
        this.metrics?.record?.('lease_lost_fenced', {
          jobId,
          fence,
          ok: false,
          code: 'PARK_FENCED',
        });
        throw new RecoveryError('LEASE_LOST', {
          message: `Cannot park job ${jobId}: fence mismatch, expired lease, or non-active status`,
        });
      }
      return this.get(jobId);
    });
  }

  resumeParked(jobId, payloadPatch = null) {
    if (!this.#dbOpen()) return null;
    const out = this.store.tx(() => {
      const row = this.store.db
        .prepare('SELECT * FROM runtime_jobs WHERE id=?')
        .get(jobId);
      if (!row || !['parked', 'reconciling'].includes(row.status)) {
        return null;
      }
      const nextPayload = payloadPatch
        ? { ...parseJsonSafe(row.payload, {}), ...payloadPatch }
        : parseJsonSafe(row.payload, {});
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

  cancelByTask(taskId) {
    if (!this.#dbOpen()) return 0;
    return this.store.tx(() => {
      const now = Date.now();
      const res = this.store.db.prepare(
        "UPDATE runtime_jobs SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE taskId=? AND status IN ('pending','active','parked','reconciling')",
      ).run(now, taskId);
      return res.changes ?? 0;
    });
  }
  cancelByTurn(turnId) {
    if (!this.#dbOpen()) return 0;
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
    if (!this.#dbOpen()) return 0;
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
    if (!this.#dbOpen() || !jobId) return null;
    const row = this.store.db
      .prepare('SELECT * FROM runtime_jobs WHERE id=?')
      .get(jobId);
    if (!row) return null;
    return { ...row, payload: parseJsonSafe(row.payload, {}) };
  }
}
