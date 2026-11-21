import { RUNTIME_EVENTS } from '../kernel/events.js';
import { classifyError } from '../kernel/errors.js';
import { convergeScheduledRunForTurn } from '../governance/scheduler.js';
import { withTraceContext } from '../observability/trace.js';
import { logEvent } from '../observability/logger.js';
import {
  classifyJobOwnership,
  createLeaseGuard,
  createWorkerId,
  isLeaseLostError,
  markWorkerStopped,
  registerWorker,
} from './lease-guard.js';

/**
 * Event-driven, zero-idle-polling Durable RecoveryWorker.
 * Claims leased jobs from `DurableJobQueue`, renews leases with fence checks,
 * distinguishes live joining workers from dead/expired owners, and safely recovers interrupted turns.
 */
export class RecoveryWorker {
  constructor({
    store,
    jobQueue,
    checkpointStore,
    reconciler,
    eventRouter,
    metrics = null,
    handlers = {},
    workerId = null,
    slots = 10,
    leaseMs = 15000,
    enableHeartbeat = true,
  }) {
    this.store = store;
    this.jobQueue = jobQueue;
    this.checkpointStore = checkpointStore;
    this.reconciler = reconciler;
    this.eventRouter = eventRouter;
    this.metrics = metrics ?? null;
    this.handlers = handlers;
    this.workerId = workerId || createWorkerId('worker');
    this.slots = Math.max(1, Number(slots || 10));
    this.leaseMs = Math.max(1000, Number(leaseMs || 15000));
    this.enableHeartbeat = enableHeartbeat !== false;
    this.active = new Map(); // fence -> { abort, done, jobId }
    this.startupHooks = [];
    this.started = false;
    this.stopping = false;
    this.timer = null;
    this.unsubWake = null;
  }

  registerHandler(kind, fn) {
    this.handlers[kind] = fn;
  }

  registerStartupHook(fn) {
    if (typeof fn === 'function') this.startupHooks.push(fn);
  }

  /**
   * Scans SQLite on startup for interrupted turns/jobs whose lease has expired or whose owner is dead.
   * Never steals or modifies jobs owned by a live worker with a valid lease.
   */
  recoverOnStartup() {
    if (!this.#isDbOpen()) {
      return {
        recoveredTurns: [],
        reconciliationRequired: [],
        skippedTerminal: 0,
        skippedLiveOwners: 0,
      };
    }
    if (typeof this.store.verifyIntegrity === 'function') {
      this.store.verifyIntegrity({ full: false });
    }

    const interruptedTurns = this.store.db
      .prepare("SELECT * FROM direct_turns WHERE state='running' ORDER BY createdAt ASC")
      .all();

    const report = {
      recoveredTurns: [],
      reconciliationRequired: [],
      skippedTerminal: 0,
      skippedLiveOwners: 0,
    };

    for (const turn of interruptedTurns) {
      const ownedBySwarm =
        this.store.db
          .prepare('SELECT id FROM swarm_nodes WHERE childTurnId=? LIMIT 1')
          .get(turn.id) ||
        this.store.db
          .prepare(
            "SELECT id FROM swarm_nodes WHERE childSessionId=? AND status IN ('queued','running','interrupted','reconciling') LIMIT 1",
          )
          .get(turn.sessionId);
      if (ownedBySwarm) {
        continue;
      }

      // Atomic ownership classification + reclaim/reconciliation inside one BEGIN IMMEDIATE tx (fixes P0-3 TOCTOU)
      const outcome = this.store.tx(() => {
        const now = Date.now();
        const liveTurn = this.store.db
          .prepare('SELECT * FROM direct_turns WHERE id=?')
          .get(turn.id);
        if (!liveTurn || liveTurn.state !== 'running') {
          return { action: 'skip' };
        }

        const existingJob = liveTurn.jobId
          ? this.jobQueue.get(liveTurn.jobId)
          : this.store.db
              .prepare('SELECT * FROM runtime_jobs WHERE turnId=? ORDER BY createdAt DESC, rowid DESC LIMIT 1')
              .get(liveTurn.id);

        // Distinguish live owner with valid lease vs expired/dead owner atomically BEFORE inspecting receipts
        let reclaimedActive = false;
        if (existingJob && existingJob.status === 'active') {
          const ownership = classifyJobOwnership(this.store, existingJob, {
            now,
            markDeadInDb: true,
          });
          if (ownership.liveOwner) {
            return { action: 'live_owner' };
          }
          if (!ownership.reclaimable) {
            return { action: 'skip' };
          }

          // Reclaim dead/expired active job atomically matching dead fence + expired/dead-worker condition
          const res = this.store.db
            .prepare(
              `UPDATE runtime_jobs
               SET status='pending', fence=NULL, leaseExpiresAt=NULL, updatedAt=?
               WHERE id=? AND status='active' AND (? IS NULL OR fence=?)
                 AND (
                   leaseExpiresAt IS NULL
                   OR leaseExpiresAt < ?
                   OR workerId IS NULL
                   OR NOT EXISTS (SELECT 1 FROM runtime_workers w WHERE w.workerId=runtime_jobs.workerId AND w.status='active')
                 )`,
            )
            .run(now, existingJob.id, existingJob.fence ?? null, existingJob.fence ?? null, now);
          if (!(res.changes ?? 0)) {
            return { action: 'live_owner' };
          }
          reclaimedActive = true;
        }

        if (existingJob && existingJob.status === 'cancelled') {
          this.store.db
            .prepare(
              "UPDATE direct_turns SET state='cancelled', phase='cancelled', finishedAt=COALESCE(finishedAt, ?), activeFence=NULL WHERE id=? AND state='running'",
            )
            .run(now, liveTurn.id);
          this.store.db
            .prepare(
              "UPDATE direct_sessions SET state='cancelled', updatedAt=? WHERE id=? AND state NOT IN ('completed','cancelled')",
            )
            .run(now, liveTurn.sessionId);
          convergeScheduledRunForTurn(this.store, liveTurn.id, {
            status: 'cancelled',
            finishedAt: now,
          });
          return { action: 'terminal' };
        }

        if (existingJob && existingJob.status === 'failed') {
          const errText = existingJob.errorMessage || existingJob.errorCode || 'JOB_FAILED';
          this.store.db
            .prepare(
              "UPDATE direct_turns SET state='failed', phase='failed', error=COALESCE(error, ?), finishedAt=COALESCE(finishedAt, ?), activeFence=NULL WHERE id=? AND state='running'",
            )
            .run(String(errText).slice(0, 1000), now, liveTurn.id);
          this.store.db
            .prepare(
              "UPDATE direct_sessions SET state='failed', updatedAt=? WHERE id=? AND state NOT IN ('completed','cancelled')",
            )
            .run(now, liveTurn.sessionId);
          convergeScheduledRunForTurn(this.store, liveTurn.id, {
            status: 'failed',
            error: String(errText).slice(0, 1000),
            finishedAt: now,
          });
          return { action: 'terminal' };
        }

        const recCheck = this.reconciler.inspectInterruptedTurn(liveTurn.id, {
          sessionId: liveTurn.sessionId,
        });
        if (recCheck.needsReconciliation) {
          return {
            action: 'reconcile',
            approvalId: recCheck.approvalId,
            receiptIds: recCheck.unknownReceipts.map((r) => r.id),
          };
        }

        const cp = this.checkpointStore.loadLatest(liveTurn.id);
        const resumedFromStep = cp?.step ?? liveTurn.step ?? 0;

        if (!existingJob || existingJob.status === 'done') {
          // Recover orphan running turn (no job row, OR stranded with premature 'done' job)
          const sess = this.store.db
            .prepare('SELECT * FROM direct_sessions WHERE id=?')
            .get(liveTurn.sessionId);
          if (!sess || sess.state === 'cancelled') {
            return { action: 'terminal' };
          }
          const idemKey = existingJob
            ? `turn:${liveTurn.id}:rec:${existingJob.id.slice(0, 8)}`
            : `turn:${liveTurn.id}`;
          const job = this.jobQueue.enqueue({
            kind: 'direct_turn',
            sessionId: liveTurn.sessionId,
            turnId: liveTurn.id,
            idempotencyKey: idemKey,
            payload: {
              sessionId: liveTurn.sessionId,
              turnId: liveTurn.id,
              input: liveTurn.input,
              model: liveTurn.model || sess.model,
              mode: sess.mode || 'direct',
              permissionMode: sess.permissionMode || 'auto-safe',
              workspaceRoot: sess.workspaceRoot,
              resumedFromStep,
            },
          });
          if (!job || job.deduplicated) {
            return { action: 'skip' };
          }
          this.store.db
            .prepare('UPDATE direct_turns SET jobId=?, activeFence=NULL WHERE id=?')
            .run(job.id, liveTurn.id);
          return { action: 'recovered', resumedFromStep, jobId: job.id };
        }

        if (reclaimedActive) {
          return { action: 'recovered', resumedFromStep, jobId: existingJob.id };
        }

        // Already pending / parked / reconciling -> idempotent no-op
        return { action: 'skip' };
      });

      if (outcome.action === 'live_owner') {
        report.skippedLiveOwners++;
        continue;
      }
      if (outcome.action === 'terminal') {
        report.skippedTerminal++;
        continue;
      }
      if (outcome.action === 'reconcile') {
        report.reconciliationRequired.push({
          turnId: turn.id,
          sessionId: turn.sessionId,
          approvalId: outcome.approvalId,
          receiptIds: outcome.receiptIds,
        });
        continue;
      }
      if (outcome.action !== 'recovered') {
        continue;
      }

      report.recoveredTurns.push({
        turnId: turn.id,
        sessionId: turn.sessionId,
        resumedFromStep: outcome.resumedFromStep,
      });

      this.metrics?.record?.('recovery_attempt', {
        sessionId: turn.sessionId,
        turnId: turn.id,
        jobId: outcome.jobId ?? null,
        workerId: this.workerId,
        ok: true,
        code: 'direct_turn_requeued',
      });

      try {
        this.eventRouter?.emitPersisted({
          sessionId: turn.sessionId,
          turnId: turn.id,
          type: RUNTIME_EVENTS.SESSION_RECOVERED,
          data: {
            turnId: turn.id,
            sessionId: turn.sessionId,
            resumedFromStep: outcome.resumedFromStep,
          },
          audit: true,
        });
      } catch {
        // isolate SSE listener failures
      }
    }

    return report;
  }

  start({ recover = true } = {}) {
    if (this.started) return { recoveredTurns: [], reconciliationRequired: [] };
    this.started = true;
    this.stopping = false;
    registerWorker(this.store, { workerId: this.workerId });
    if (!this.unsubWake && typeof this.store.onJobWake === 'function') {
      this.unsubWake = this.store.onJobWake(() => this.wake());
    }
    const report = recover
      ? this.recoverOnStartup()
      : { recoveredTurns: [], reconciliationRequired: [], skippedTerminal: 0, skippedLiveOwners: 0 };
    if (recover && this.startupHooks.length) {
      report.hooks = [];
      for (const hook of this.startupHooks) {
        try {
          const out = hook();
          report.hooks.push(out);
          if (out && typeof out === 'object' && 'recoveredRuns' in out) {
            report.swarm = out;
          }
        } catch (err) {
          logEvent('warn', 'durable.startup_hook_failed', {
            workerId: this.workerId,
            error: String(err?.message ?? err),
          });
        }
      }
    }
    this.wake();
    return report;
  }

  async stop() {
    this.stopping = true;
    this.started = false;
    if (this.unsubWake) {
      this.unsubWake();
      this.unsubWake = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const entry of this.active.values()) {
      entry.abort.abort('shutdown');
    }
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
    markWorkerStopped(this.store, this.workerId);
  }

  #isDbOpen() {
    try {
      return Boolean(this.store?.db?.isOpen);
    } catch {
      return false;
    }
  }

  #hasLiveWork() {
    if (this.active.size > 0) return true;
    const kinds = Object.keys(this.handlers);
    if (!kinds.length) return false;
    return this.jobQueue.hasLiveJobs({ kinds });
  }

  wake() {
    if (this.stopping || !this.started) return;
    this.tick();
    if (!this.timer && this.#hasLiveWork()) {
      this.timer = setInterval(() => this.tick(), 100);
      this.timer.unref?.();
    }
  }

  cancelJobByTurn(turnId) {
    this.jobQueue.cancelByTurn(turnId);
    for (const entry of this.active.values()) {
      if (entry.turnId === turnId) {
        entry.abort.abort();
      }
    }
  }

  cancelJobBySession(sessionId) {
    this.jobQueue.cancelBySession(sessionId);
    for (const entry of this.active.values()) {
      if (entry.sessionId === sessionId) {
        entry.abort.abort();
      }
    }
  }

  tick() {
    if (this.stopping || !this.#isDbOpen()) return;
    const kinds = Object.keys(this.handlers);
    if (kinds.length) {
      while (this.active.size < this.slots) {
        const job = this.jobQueue.claim({
          workerId: this.workerId,
          kinds,
          leaseMs: this.leaseMs,
        });
        if (!job) break;
        const abort = new AbortController();
        const entry = { abort, jobId: job.id, sessionId: job.sessionId, turnId: job.turnId };
        this.active.set(job.fence, entry);
        entry.done = this.#runJob(job, abort).finally(() => {
          this.active.delete(job.fence);
          if (!this.stopping && this.started) this.wake();
        });
      }
    }
    if (this.timer && !this.#hasLiveWork()) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async #runJob(job, abort) {
    const traceTurnId =
      job.turnId && !String(job.turnId).startsWith('swarm:') ? job.turnId : undefined;
    const traceNodeId = job.payload?.nodeId || undefined;

    return withTraceContext(
      {
        jobId: job.id,
        workerId: this.workerId,
        attempt: job.attempts,
        fence: job.fence,
        sessionId: job.sessionId || undefined,
        turnId: traceTurnId,
        runId: job.taskId || undefined,
        nodeId: traceNodeId,
      },
      async () => {
        const handler = this.handlers[job.kind];
        if (typeof handler !== 'function') {
          try {
            this.jobQueue.fail(
              job.id,
              job.fence,
              new Error(`No handler registered for job kind: ${job.kind}`),
              { retryable: false },
            );
          } catch {
            // already fenced
          }
          return;
        }

        let heartbeat = null;
        if (this.enableHeartbeat) {
          const heartbeatMs = Math.max(400, Math.floor(this.leaseMs / 4));
          heartbeat = setInterval(() => {
            if (abort.signal.aborted) return;
            try {
              const ok = this.jobQueue.renewLease(job.id, job.fence, this.leaseMs);
              if (!ok) {
                abort.abort('lease_lost');
              }
            } catch {
              abort.abort('lease_lost');
            }
          }, heartbeatMs);
          heartbeat.unref?.();
        }

        const leaseGuard = createLeaseGuard({
          store: this.store,
          jobId: job.id,
          fence: job.fence,
          workerId: this.workerId,
          attempt: job.attempts,
          sessionId: job.sessionId || null,
          turnId: traceTurnId ?? null,
          runId: job.taskId || null,
          nodeId: traceNodeId ?? null,
        });

        try {
          const out = await handler(job, {
            signal: abort.signal,
            leaseGuard,
            workerId: this.workerId,
            checkpoint: this.checkpointStore.loadLatest(job.turnId),
          });
          if (this.stopping || !this.#isDbOpen()) return;
          if (out?.leaseLost || abort.signal.reason === 'lease_lost') {
            this.metrics?.record?.('lease_lost_fenced', {
              jobId: job.id,
              fence: job.fence,
              workerId: this.workerId,
              ok: false,
              code: 'HANDLER_LEASE_LOST',
            });
            return;
          }
          try {
            this.jobQueue.complete(job.id, job.fence);
            if (job.reclaimedFromCrash) {
              this.metrics?.record?.('recovery_attempt', {
                jobId: job.id,
                workerId: this.workerId,
                attempt: job.attempts,
                ok: true,
                code: job.kind,
              });
            }
          } catch (completeErr) {
            if (isLeaseLostError(completeErr)) {
              logEvent('warn', 'durable.complete_fenced', {
                jobId: job.id,
                kind: job.kind,
                fence: job.fence,
              });
            }
          }
        } catch (err) {
          if (this.stopping || !this.#isDbOpen()) return;
          const classified = classifyError(err);
          if (isLeaseLostError(classified) || abort.signal.reason === 'lease_lost') {
            this.metrics?.record?.('lease_lost_fenced', {
              jobId: job.id,
              fence: job.fence,
              workerId: this.workerId,
              ok: false,
              code: classified.code || 'LEASE_LOST',
            });
            logEvent('warn', 'durable.lease_lost', {
              jobId: job.id,
              kind: job.kind,
              code: classified.code,
            });
            return;
          }
          if (!leaseGuard.isHeld({ allowTerminalTurn: true, allowTerminalSession: true })) {
            return;
          }
          if (classified.code === 'APPROVAL_PARKED') {
            try {
              this.jobQueue.park(job.id, job.fence, {
                status: 'parked',
                reason: classified.message,
              });
            } catch {
              // ignore
            }
            return;
          }
          if (classified.code === 'RECONCILIATION_REQUIRED') {
            try {
              this.jobQueue.park(job.id, job.fence, {
                status: 'reconciling',
                reason: classified.message,
              });
            } catch {
              // ignore
            }
            return;
          }
          if (job.reclaimedFromCrash) {
            this.metrics?.record?.('recovery_attempt', {
              jobId: job.id,
              workerId: this.workerId,
              attempt: job.attempts,
              ok: false,
              code: classified.code || 'JOB_FAILED',
            });
          }
          const retryable = Boolean(this.stopping || classified.retryable);
          try {
            this.jobQueue.fail(job.id, job.fence, classified, { retryable });
          } catch {
            // ignore if already fenced/terminal
          }
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
      },
    );
  }
}
