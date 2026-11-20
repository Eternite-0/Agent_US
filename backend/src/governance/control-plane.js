import { AuditLedgerService } from './audit.js';
import { ScheduledTaskRunner } from './scheduler.js';

/**
 * Layer 2 ControlPlane unifying Session/Task governance, Model Routing,
 * Reconciliation Approval Center, Audit Ledger, Swarm Orchestration, and Schedules.
 */
export class ControlPlane {
  constructor({ store, pool, directAgent }) {
    this.store = store;
    this.pool = pool;
    this.directAgent = directAgent;
    this.auditService = new AuditLedgerService(store);
    this.scheduler = new ScheduledTaskRunner({ store, directAgent });
  }

  get swarmOrchestrator() {
    return this.directAgent?.swarmOrchestrator ?? null;
  }

  get childManager() {
    return this.directAgent?.childManager ?? null;
  }

  get modelCapabilities() {
    return this.directAgent?.modelCapabilities ?? null;
  }

  get agentCapabilities() {
    return this.directAgent?.agentCapabilities ?? null;
  }

  get adaptiveRouter() {
    return this.directAgent?.adaptiveRouter ?? null;
  }

  get reconciler() {
    return this.directAgent?.reconciler ?? null;
  }

  get recoveryWorker() {
    return this.directAgent?.recoveryWorker ?? null;
  }

  getOverview() {
    const activeTurns = this.directAgent?.activeTurns?.size ?? 0;
    const pendingApprovals =
      this.store.db
        .prepare("SELECT COUNT(*) AS n FROM direct_approvals WHERE status='pending'")
        .get()?.n ?? 0;
    const pendingReconciliations =
      this.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM direct_approvals WHERE kind='reconciliation' AND status='pending'",
        )
        .get()?.n ?? 0;
    const unknownReceipts =
      this.store.db
        .prepare("SELECT COUNT(*) AS n FROM tool_receipts WHERE status='outcome_unknown'")
        .get()?.n ?? 0;
    const activeSwarmRuns =
      this.store.db
        .prepare("SELECT COUNT(*) AS n FROM swarm_runs WHERE status='running'")
        .get()?.n ?? 0;
    const enabledSchedules =
      this.store.db
        .prepare('SELECT COUNT(*) AS n FROM scheduled_tasks WHERE enabled=1')
        .get()?.n ?? 0;
    const models = this.modelCapabilities?.list?.() ?? [];
    const ledgerMeta = this.store.db.prepare('SELECT lastSeq, verifiedThroughSeq FROM ledger_meta WHERE id=1').get();

    return {
      ok: true,
      activeTurns,
      pendingApprovals,
      pendingReconciliations,
      unknownReceipts,
      activeSwarmRuns,
      enabledSchedules,
      modelCount: models.length,
      ledger: ledgerMeta ?? { lastSeq: 0, verifiedThroughSeq: 0 },
      lastRecovery: this.directAgent?.lastRecoveryReport ?? null,
    };
  }

  close() {
    this.scheduler.stop();
  }
}
