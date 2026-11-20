import { RUNTIME_EVENTS } from '../kernel/events.js';
import { classifyError } from '../kernel/errors.js';

/**
 * Event-driven, zero-idle-polling Durable RecoveryWorker.
 * Claims leased jobs from `DurableJobQueue`, renews leases with fence checks,
 * and reconciles/resumes interrupted turns on startup.
 */
export class RecoveryWorker {
  constructor({
    store,
    jobQueue,
    checkpointStore,
    reconciler,
    eventRouter,
    handlers = {},
    workerId = `worker-${process.pid}`,
    slots = 10,
    leaseMs = 15000,
  }) {
    this.store = store;
    this.jobQueue = jobQueue;
    this.checkpointStore = checkpointStore;
    this.reconciler = reconciler;
    this.eventRouter = eventRouter;
    this.handlers = handlers;
    this.workerId = workerId;
    this.slots = Math.max(1, Number(slots || 10));
    this.leaseMs = Math.max(2000, Number(leaseMs || 15000));
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
   * Scans SQLite on startup for interrupted turns/jobs after a crash, verifies JCS ledger,
   * routes unknown non-replayable executions to human reconciliation, and re-enqueues safe turns.
   */
  recoverOnStartup() {
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

      const recCheck = this.reconciler.inspectInterruptedTurn(turn.id, {
        sessionId: turn.sessionId,
      });
      if (recCheck.needsReconciliation) {
        report.reconciliationRequired.push({
          turnId: turn.id,
          sessionId: turn.sessionId,
          approvalId: recCheck.approvalId,
          receiptIds: recCheck.unknownReceipts.map((r) => r.id),
        });
        continue;
      }

      const existingJob = turn.jobId
        ? this.jobQueue.get(turn.jobId)
        : this.store.db
            .prepare("SELECT * FROM runtime_jobs WHERE turnId=? ORDER BY createdAt DESC LIMIT 1")
            .get(turn.id);

      const cp = this.checkpointStore.loadLatest(turn.id);

      if (!existingJob) {
        // Recover orphan running turn created without job row
        const sess = this.store.db
          .prepare('SELECT * FROM direct_sessions WHERE id=?')
          .get(turn.sessionId);
        if (!sess || sess.state === 'cancelled') {
          report.skippedTerminal++;
          continue;
        }
        const job = this.jobQueue.enqueue({
          kind: 'direct_turn',
          sessionId: turn.sessionId,
          turnId: turn.id,
          idempotencyKey: `turn:${turn.id}`,
          payload: {
            sessionId: turn.sessionId,
            turnId: turn.id,
            input: turn.input,
            model: turn.model || sess.model,
            mode: sess.mode || 'direct',
            permissionMode: sess.permissionMode || 'auto-safe',
            workspaceRoot: sess.workspaceRoot,
            resumedFromStep: cp?.step ?? turn.step ?? 0,
          },
        });
        this.store.tx(() => {
          this.store.db
            .prepare('UPDATE direct_turns SET jobId=? WHERE id=?')
            .run(job.id, turn.id);
        });
      } else if (existingJob.status === 'active') {
        // Reclaim expired or orphaned active job from dead process immediately on boot
        this.store.tx(() => {
          this.store.db
            .prepare(
              "UPDATE runtime_jobs SET status='pending', fence=NULL, leaseExpiresAt=NULL, updatedAt=? WHERE id=? AND status='active'",
            )
            .run(Date.now(), existingJob.id);
        });
      } else if (existingJob.status === 'pending') {
        // Already queued for execution
      } else {
        continue;
      }

      report.recoveredTurns.push({
        turnId: turn.id,
        sessionId: turn.sessionId,
        resumedFromStep: cp?.step ?? turn.step ?? 0,
      });

      this.eventRouter?.emitPersisted({
        sessionId: turn.sessionId,
        turnId: turn.id,
        type: RUNTIME_EVENTS.SESSION_RECOVERED,
        data: {
          turnId: turn.id,
          sessionId: turn.sessionId,
          resumedFromStep: cp?.step ?? turn.step ?? 0,
        },
        audit: true,
      });
    }

    return report;
  }

  start({ recover = true } = {}) {
    if (this.started) return { recoveredTurns: [], reconciliationRequired: [] };
    this.started = true;
    this.stopping = false;
    if (!this.unsubWake && typeof this.store.onJobWake === 'function') {
      this.unsubWake = this.store.onJobWake(() => this.wake());
    }
    const report = recover
      ? this.recoverOnStartup()
      : { recoveredTurns: [], reconciliationRequired: [], skippedTerminal: 0 };
    if (recover && this.startupHooks.length) {
      report.hooks = [];
      for (const hook of this.startupHooks) {
        try {
          const out = hook();
          report.hooks.push(out);
          if (out && typeof out === 'object' && 'recoveredRuns' in out) {
            report.swarm = out;
          }
        } catch {
          // isolate hook startup failure
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
      entry.abort.abort();
    }
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
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
    if (this.stopping) return;
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

    const heartbeatMs = Math.max(400, Math.floor(this.leaseMs / 4));
    const heartbeat = setInterval(() => {
      if (abort.signal.aborted) return;
      try {
        const ok = this.jobQueue.renewLease(job.id, job.fence, this.leaseMs);
        if (!ok) abort.abort();
      } catch {
        abort.abort();
      }
    }, heartbeatMs);
    heartbeat.unref?.();

    const leaseGuard = () => this.jobQueue.assertFence(job.id, job.fence);

    try {
      await handler(job, {
        signal: abort.signal,
        leaseGuard,
        checkpoint: this.checkpointStore.loadLatest(job.turnId),
      });
      if (this.stopping || !this.#isDbOpen()) return;
      try {
        this.jobQueue.complete(job.id, job.fence);
      } catch {
        // handler may have parked/completed/cancelled the job
      }
    } catch (err) {
      if (this.stopping || !this.#isDbOpen()) return;
      const classified = classifyError(err);
      if (classified.code === 'LEASE_LOST') {
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
      const retryable = Boolean(this.stopping || classified.retryable);
      try {
        this.jobQueue.fail(job.id, job.fence, classified, { retryable });
      } catch {
        // ignore if already fenced/terminal
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}
