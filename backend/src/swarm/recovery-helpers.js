import { id as uuid } from '../store.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import { classifyJobOwnership } from '../durable/lease-guard.js';
import { SWARM_JOB_KINDS, enqueueSwarmJob } from './jobs.js';
import {
  SWARM_NODE_STATES,
  SWARM_RUN_STATES,
  isTerminalNodeState,
  isTerminalRunState,
  transitionNodeTerminalCas,
  transitionSwarmNode,
  transitionSwarmRun,
} from './node-state-machine.js';
import { isRunDeadlineExpired } from './run-deadline.js';

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

export function parseToolAllowJson(str) {
  if (str === null || str === undefined || str === '') return null;
  try {
    const parsed = JSON.parse(str);
    if (parsed === null) return null;
    if (Array.isArray(parsed)) return parsed.map(String);
    return [];
  } catch {
    // Fail-closed: never widen malformed allowlist to unrestricted null
    return [];
  }
}

export function hydrateSwarmNode(n) {
  return {
    ...n,
    allowIsolationFallback: Boolean(n.allowIsolationFallback),
    dependencies: parseJsonSafe(n.dependenciesJson, []),
    toolAllow: parseToolAllowJson(n.toolAllowJson),
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
 * Checks whether a swarm node has executing/outcome_unknown tool receipts OR lost unarchived worktree writes,
 * creating a pending reconciliation approval if none exists yet.
 */
export function inspectNodeReconciliation(
  store,
  reconciler,
  eventRouter,
  node,
  childSessionId,
  childTurnId,
  { artifactManager = null } = {},
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
  if (unknownRows.length) {
    const first = unknownRows[0];
    const now = Date.now();
    const { approvalId, created } = store.tx(() => {
      const existing = store.db
        .prepare(
          `SELECT id FROM direct_approvals
           WHERE kind='reconciliation' AND status='pending'
             AND ((? IS NOT NULL AND turnId=?) OR sessionId=?)
           LIMIT 1`,
        )
        .get(turnId, turnId, sessId || first.sessionId);
      if (existing) return { approvalId: existing.id, created: false };

      const newId = uuid();
      store.db
        .prepare(
          `INSERT INTO direct_approvals(
            id, sessionId, turnId, callId, tool, arguments, status, kind, receiptId,
            riskLevel, effectClass, expiresAt, createdAt
          ) VALUES(?,?,?,?,?,?,'pending','reconciliation',?,?,?,?,?)`,
        )
        .run(
          newId,
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
      return { approvalId: newId, created: true };
    });

    if (created) {
      try {
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
      } catch {
        // best-effort event emission after committed approval insert
      }
    }

    return { needsReconciliation: true, approvalId };
  }

  // Fix C9: Isolated worktree recovery consistency — never silently resume on clean HEAD if recorded writes were lost
  if (artifactManager && node?.isolationMode === 'worktree') {
    const wtState = artifactManager.inspectWorktreeRecoveryState(node, {
      childSessionId: sessId,
      childTurnId: turnId,
    });
    if (wtState.needsReconciliation) {
      const now = Date.now();
      const firstReceipt = wtState.lostReceipts?.[0] ?? null;
      const { approvalId, created } = store.tx(() => {
        const existing = store.db
          .prepare(
            `SELECT id FROM direct_approvals
             WHERE kind='reconciliation' AND status='pending'
               AND ((? IS NOT NULL AND turnId=?) OR (? IS NOT NULL AND sessionId=?))
             LIMIT 1`,
          )
          .get(turnId, turnId, sessId, sessId);
        if (existing) return { approvalId: existing.id, created: false };
        const newId = uuid();
        store.db
          .prepare(
            `INSERT INTO direct_approvals(
              id, sessionId, turnId, callId, tool, arguments, status, kind, receiptId,
              riskLevel, effectClass, expiresAt, createdAt
            ) VALUES(?,?,?,?,?,?,'pending','reconciliation',?,?,?,?,?)`,
          )
          .run(
            newId,
            sessId || node.runId,
            turnId,
            firstReceipt?.callId || `wt:${node.nodeKey}`,
            'worktree_recovery',
            JSON.stringify({
              reason: 'WORKTREE_STATE_LOST',
              runId: node.runId,
              nodeId: node.id,
              nodeKey: node.nodeKey,
              lostReceiptIds: (wtState.lostReceipts ?? []).map((r) => r.id),
              message:
                '隔离 worktree 中存在已记录的写入回执，但未归档且 worktree 目录在恢复时已丢失；禁止静默从干净 HEAD 继续，请确认重新执行或中止。',
            }),
            firstReceipt?.id || null,
            'high',
            'worktree_state_lost',
            now + 86_400_000,
            now,
          );
        return { approvalId: newId, created: true };
      });
      if (created) {
        try {
          eventRouter?.emitPersisted({
            sessionId: sessId || node.runId,
            turnId,
            type: RUNTIME_EVENTS.RECONCILIATION_REQUIRED,
            data: {
              approvalId,
              reason: 'WORKTREE_STATE_LOST',
              runId: node.runId,
              nodeKey: node.nodeKey,
              lostReceiptIds: (wtState.lostReceipts ?? []).map((r) => r.id),
            },
            audit: true,
          });
        } catch {
          // best-effort event emission
        }
      }
      return { needsReconciliation: true, approvalId, reason: 'WORKTREE_STATE_LOST' };
    }
  }

  return { needsReconciliation: false, approvalId: null };
}

export function parkNodeAndRunForReconciliation(store, eventRouter, run, node, approvalId) {
  transitionSwarmNode(store, eventRouter, node.id, SWARM_NODE_STATES.RECONCILING, {
    sessionId: run.sessionId,
    rootTurnId: run.rootTurnId,
    patch: { reconcileApprovalId: approvalId || null, activeFence: null },
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
  artifactManager = null,
  eventRouter,
  budgetLedger = null,
  getRun,
  cancelRun,
}) {
  const report = {
    recoveredRuns: [],
    recoveredNodes: 0,
    convergedCompletedNodes: 0,
    replayedReconciliations: 0,
    reconcilingNodes: [],
    skippedTerminal: 0,
    timedOutRuns: 0,
    skippedLiveOwners: 0,
    budgetReconciliation: null,
    orphanArtifacts: null,
    errors: [],
  };
  if (!store?.db?.isOpen || !jobQueue) return report;

  if (budgetLedger?.reconcileAfterRestart) {
    report.budgetReconciliation = budgetLedger.reconcileAfterRestart();
  }
  if (artifactManager?.cleanupOrphanArtifacts) {
    try {
      report.orphanArtifacts = artifactManager.cleanupOrphanArtifacts();
    } catch {
      // non-fatal startup cleanup
    }
  }

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
    try {
      const parentSess = store.db
        .prepare('SELECT state FROM direct_sessions WHERE id=?')
        .get(runRow.sessionId);
      if (!parentSess || parentSess.state === 'cancelled') {
        cancelRun(runRow.id);
        report.skippedTerminal++;
        continue;
      }

      const parsedRunBudget = parseJsonSafe(runRow.budgetJson, {});
      if (isRunDeadlineExpired({ ...runRow, budget: parsedRunBudget })) {
        cancelRun(runRow.id, { deadlineExpired: true });
        report.timedOutRuns++;
        report.skippedTerminal++;
        continue;
      }

      const now = Date.now();
      const pendingResolutions = [];
      const postTxEvents = [];

      const runRecovered = store.tx(() => {
        // Re-read fresh run inside transaction to avoid TOCTOU with live workers
        const liveRunRow = store.db.prepare('SELECT * FROM swarm_runs WHERE id=?').get(runRow.id);
        if (!liveRunRow || isTerminalRunState(liveRunRow.status)) return false;

        // Fix D1-D4/D9: Inspect jobs by lease ownership atomically inside tx — NEVER cancel pending or live-owned active jobs!
        const existingJobs = store.db
          .prepare(
            `SELECT * FROM runtime_jobs
             WHERE taskId=? AND status IN ('pending', 'active')
             ORDER BY createdAt ASC`,
          )
          .all(runRow.id);

        const pendingKinds = new Set();
        const liveKinds = new Set();
        const liveNodeIds = new Set();
        const liveNodeKeys = new Set();
        const pendingNodeIds = new Set();
        const pendingNodeKeys = new Set();
        let mutated = false;

        for (const j of existingJobs) {
          const payload = parseJsonSafe(j.payload, {});
          if (j.status === 'pending') {
            pendingKinds.add(j.kind);
            if (j.kind === SWARM_JOB_KINDS.NODE_EXECUTE) {
              if (payload.nodeId) pendingNodeIds.add(payload.nodeId);
              if (payload.nodeKey) pendingNodeKeys.add(payload.nodeKey);
            } else if (j.kind === SWARM_JOB_KINDS.DISPATCH && Array.isArray(payload.nodeKeys)) {
              for (const nk of payload.nodeKeys) pendingNodeKeys.add(nk);
            }
            continue;
          }

          // Active job: classify ownership atomically inside tx
          const ownership = classifyJobOwnership(store, j, { now, markDeadInDb: true });
          if (ownership.liveOwner) {
            liveKinds.add(j.kind);
            report.skippedLiveOwners++;
            if (j.kind === SWARM_JOB_KINDS.NODE_EXECUTE) {
              if (payload.nodeId) liveNodeIds.add(payload.nodeId);
              if (payload.nodeKey) liveNodeKeys.add(payload.nodeKey);
            } else if (j.kind === SWARM_JOB_KINDS.DISPATCH && Array.isArray(payload.nodeKeys)) {
              for (const nk of payload.nodeKeys) liveNodeKeys.add(nk);
            }
            continue;
          }

          if (!ownership.reclaimable) continue;

          if (j.kind === SWARM_JOB_KINDS.NODE_EXECUTE) {
            const res = store.db
              .prepare(
                `UPDATE runtime_jobs
                 SET status='cancelled', fence=NULL, leaseExpiresAt=NULL, errorCode='OWNER_LOST_RECOVERED', updatedAt=?
                 WHERE id=? AND status='active' AND (? IS NULL OR fence=?)`,
              )
              .run(now, j.id, j.fence ?? null, j.fence ?? null);
            if ((res.changes ?? 0) > 0) mutated = true;
          } else {
            const res = store.db
              .prepare(
                `UPDATE runtime_jobs
                 SET status='pending', fence=NULL, leaseExpiresAt=NULL, updatedAt=?
                 WHERE id=? AND status='active' AND (? IS NULL OR fence=?)`,
              )
              .run(now, j.id, j.fence ?? null, j.fence ?? null);
            if ((res.changes ?? 0) > 0) {
              pendingKinds.add(j.kind);
              if (j.kind === SWARM_JOB_KINDS.DISPATCH && Array.isArray(payload.nodeKeys)) {
                for (const nk of payload.nodeKeys) pendingNodeKeys.add(nk);
              }
              mutated = true;
            }
          }
        }

        const hasPendingOrLive = (kind) => pendingKinds.has(kind) || liveKinds.has(kind);
        const run = getRun(runRow.id);
        if (!run) return mutated;

        budgetLedger?.ensureLedger?.({
          treeId: run.id,
          rootSessionId: run.sessionId,
          budget: run.budget,
          initialUsage: run.usage,
          trafficSource: run.trafficSource || 'production',
          isSynthetic: run.isSynthetic ? 1 : 0,
        });

        const planVer = run.planVersion || 1;
        if (run.status === SWARM_RUN_STATES.PENDING || run.status === SWARM_RUN_STATES.PLANNING) {
          if (run.nodes.length === 0) {
            if (!hasPendingOrLive(SWARM_JOB_KINDS.PLAN)) {
              enqueueSwarmJob(
                jobQueue,
                SWARM_JOB_KINDS.PLAN,
                { runId: run.id, sessionId: run.sessionId, goal: run.goal, planVersion: planVer },
                { idempotencyKey: `swarm:plan:${run.id}:v${planVer}:rec:${uuid().slice(0, 8)}` },
              );
              mutated = true;
            }
          } else if (!liveKinds.has(SWARM_JOB_KINDS.PLAN)) {
            transitionSwarmRun(store, run.id, SWARM_RUN_STATES.RUNNING, {
              patch: { currentPhase: 'running' },
            });
            if (!hasPendingOrLive(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE)) {
              enqueueSwarmJob(
                jobQueue,
                SWARM_JOB_KINDS.DEPENDENCY_RESOLVE,
                {
                  runId: run.id,
                  sessionId: run.sessionId,
                  planVersion: planVer,
                  epoch: now,
                },
                { idempotencyKey: `swarm:resolve:${run.id}:v${planVer}:planned_rec:${uuid().slice(0, 8)}` },
              );
              mutated = true;
            }
          }
          return mutated;
        }

        if (run.status === SWARM_RUN_STATES.RUNNING || run.status === SWARM_RUN_STATES.RECONCILING) {
          let recoveredInThisRun = 0;
          for (const n of run.nodes) {
            if (
              isTerminalNodeState(n.status) ||
              n.status === SWARM_NODE_STATES.PENDING ||
              n.status === SWARM_NODE_STATES.READY ||
              n.status === SWARM_NODE_STATES.PARKED
            ) {
              continue;
            }
            if (n.status === SWARM_NODE_STATES.RECONCILING) {
              // P1-1: Auto-replay reconciliation resolution if approval was already decided before crash
              if (n.reconcileApprovalId) {
                const appr = store.db
                  .prepare('SELECT id, sessionId, turnId, status, outcome, reason FROM direct_approvals WHERE id=?')
                  .get(n.reconcileApprovalId);
                if (appr && appr.status !== 'pending' && appr.outcome) {
                  pendingResolutions.push({
                    id: appr.id,
                    sessionId: appr.sessionId,
                    turnId: appr.turnId,
                    outcome: appr.outcome,
                    reason: appr.reason,
                  });
                  mutated = true;
                  continue;
                }
              }
              report.reconcilingNodes.push({ runId: run.id, nodeKey: n.nodeKey, approvalId: n.reconcileApprovalId });
              continue;
            }

            // Skip nodes actively owned by a live worker OR already queued by a pending job
            if (
              liveNodeIds.has(n.id) ||
              liveNodeKeys.has(n.nodeKey) ||
              pendingNodeIds.has(n.id) ||
              pendingNodeKeys.has(n.nodeKey)
            ) {
              continue;
            }

            // P0-4: If childTurnId ALREADY committed 'completed' before crash (between child-turn commit
            // and swarm_node commit), converge directly to COMPLETED instead of re-executing!
            if (n.status === SWARM_NODE_STATES.RUNNING && n.childTurnId) {
              const turnRow = store.db
                .prepare('SELECT id, state FROM direct_turns WHERE id=?')
                .get(n.childTurnId);
              if (turnRow?.state === 'completed') {
                let verifiedArt = null;
                if (n.isolationMode === 'worktree' && artifactManager) {
                  const candidate = n.latestArtifactId
                    ? artifactManager.getArtifact(n.latestArtifactId)
                    : artifactManager.getLatestNodeArtifact(run.id, n.nodeKey);
                  if (candidate) {
                    const v = artifactManager.verifyArtifact(candidate.id);
                    if (v.ok) verifiedArt = candidate;
                  }
                }
                const canConvergeDirectly =
                  n.isolationMode !== 'worktree' || !artifactManager || Boolean(verifiedArt);
                if (canConvergeDirectly) {
                  const lastMsg = store.db
                    .prepare(
                      "SELECT content FROM direct_messages WHERE turnId=? AND role='assistant' ORDER BY seq DESC LIMIT 1",
                    )
                    .get(n.childTurnId);
                  const resultText = n.resultText || lastMsg?.content || '';
                  const uris = [
                    ...new Set([
                      ...(verifiedArt?.uri ? [verifiedArt.uri] : []),
                      ...extractArtifactUris(resultText),
                    ]),
                  ];
                  const updated = transitionNodeTerminalCas(store, null, n.id, SWARM_NODE_STATES.COMPLETED, {
                    emitEvent: false,
                    patch: {
                      resultText,
                      artifactUrisJson: JSON.stringify(uris),
                      latestArtifactId: verifiedArt?.id ?? n.latestArtifactId ?? null,
                      activeFence: null,
                      activeJobId: null,
                    },
                  });
                  if (!updated.changed) continue;
                  postTxEvents.push({
                    sessionId: run.sessionId,
                    turnId: run.rootTurnId,
                    node: updated,
                  });
                  recoveredInThisRun++;
                  report.convergedCompletedNodes++;
                  report.recoveredNodes++;
                  mutated = true;
                  continue;
                }
              }
            }

            const rec = inspectNodeReconciliation(
              store,
              reconciler,
              eventRouter,
              n,
              n.childSessionId,
              n.childTurnId,
              { artifactManager },
            );
            if (rec.needsReconciliation) {
              parkNodeAndRunForReconciliation(store, eventRouter, run, n, rec.approvalId);
              report.reconcilingNodes.push({ runId: run.id, nodeKey: n.nodeKey, approvalId: rec.approvalId });
              mutated = true;
              continue;
            }
            if (n.status === SWARM_NODE_STATES.RUNNING) {
              transitionSwarmNode(store, null, n.id, SWARM_NODE_STATES.INTERRUPTED, {
                emitEvent: false,
                patch: { activeFence: null, activeJobId: null },
              });
            }
            const readyNode = transitionSwarmNode(store, null, n.id, SWARM_NODE_STATES.READY, {
              emitEvent: false,
              patch: { activeFence: null, activeJobId: null },
            });
            postTxEvents.push({
              sessionId: run.sessionId,
              turnId: run.rootTurnId,
              node: readyNode,
            });
            recoveredInThisRun++;
            report.recoveredNodes++;
            mutated = true;
          }

          const freshRun = getRun(run.id);
          const hasReadyOrPendingWork = freshRun?.nodes.some(
            (n) => n.status === SWARM_NODE_STATES.READY || n.status === SWARM_NODE_STATES.PENDING,
          );
          const allTerminal = freshRun?.nodes.every((n) => isTerminalNodeState(n.status));
          const anyLiveOrPendingControl =
            hasPendingOrLive(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE) ||
            hasPendingOrLive(SWARM_JOB_KINDS.DISPATCH);
          const anyLiveNode = liveNodeIds.size > 0 || liveNodeKeys.size > 0;
          const anyPendingNode = pendingNodeIds.size > 0 || pendingNodeKeys.size > 0;

          if (
            !anyLiveOrPendingControl &&
            (recoveredInThisRun > 0 ||
              (freshRun?.status === SWARM_RUN_STATES.RUNNING &&
                !anyLiveNode &&
                !anyPendingNode &&
                (hasReadyOrPendingWork || allTerminal)))
          ) {
            const existingPendingResolve = store.db
              .prepare(
                "SELECT 1 FROM runtime_jobs WHERE taskId=? AND kind=? AND status IN ('pending','active') LIMIT 1",
              )
              .get(run.id, SWARM_JOB_KINDS.DEPENDENCY_RESOLVE);
            if (!existingPendingResolve) {
              enqueueSwarmJob(
                jobQueue,
                SWARM_JOB_KINDS.DEPENDENCY_RESOLVE,
                {
                  runId: run.id,
                  sessionId: run.sessionId,
                  planVersion: planVer,
                  epoch: now,
                },
                { idempotencyKey: `swarm:resolve:${run.id}:v${planVer}:rec:${recoveredInThisRun}:${freshRun?.nodes.filter((x) => isTerminalNodeState(x.status)).length ?? 0}` },
              );
              mutated = true;
            }
          }
          return mutated;
        }

        if (run.status === SWARM_RUN_STATES.AGGREGATING) {
          if (!hasPendingOrLive(SWARM_JOB_KINDS.AGGREGATE)) {
            enqueueSwarmJob(
              jobQueue,
              SWARM_JOB_KINDS.AGGREGATE,
              { runId: run.id, sessionId: run.sessionId, planVersion: planVer },
              { idempotencyKey: `swarm:agg:${run.id}:v${planVer}:rec:${uuid().slice(0, 8)}` },
            );
            mutated = true;
          }
          return mutated;
        }

        if (run.status === SWARM_RUN_STATES.VERIFYING) {
          if (!hasPendingOrLive(SWARM_JOB_KINDS.VERIFY)) {
            enqueueSwarmJob(
              jobQueue,
              SWARM_JOB_KINDS.VERIFY,
              { runId: run.id, sessionId: run.sessionId, planVersion: planVer },
              { idempotencyKey: `swarm:ver:${run.id}:v${planVer}:rec:${uuid().slice(0, 8)}` },
            );
            mutated = true;
          }
          return mutated;
        }

        return mutated;
      });

      for (const ev of postTxEvents) {
        try {
          eventRouter?.emitPersisted({
            sessionId: ev.sessionId,
            turnId: ev.turnId,
            type: RUNTIME_EVENTS.SWARM_NODE_UPDATED,
            data: {
              runId: ev.node.runId,
              nodeId: ev.node.id,
              nodeKey: ev.node.nodeKey,
              status: ev.node.status,
              childSessionId: ev.node.childSessionId || undefined,
              errorCode: ev.node.errorCode || undefined,
            },
            audit: false,
          });
        } catch {
          // best-effort event emission
        }
      }

      for (const res of pendingResolutions) {
        applyReconciliationResolution({
          store,
          jobQueue,
          eventRouter,
          getRun,
          result: res,
        });
        report.replayedReconciliations++;
      }

      if (runRecovered) report.recoveredRuns.push(runRow.id);
    } catch (runErr) {
      report.errors.push({
        runId: runRow.id,
        error: String(runErr?.message ?? runErr),
      });
    }
  }

  return report;
}

export function applyReconciliationResolution({ store, jobQueue, eventRouter, getRun, result }) {
  if (!store?.db?.isOpen || !result) return null;
  const now = Date.now();
  const outcome = store.tx(() => {
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

    const approvalRow = result.id
      ? store.db.prepare('SELECT tool, effectClass FROM direct_approvals WHERE id=?').get(result.id)
      : null;
    const isWorktreeStateLost =
      approvalRow?.effectClass === 'worktree_state_lost' || approvalRow?.tool === 'worktree_recovery';

    store.db
      .prepare(
        `UPDATE runtime_jobs SET status='done', updatedAt=?
         WHERE turnId=? AND status IN ('pending','reconciling','parked')`,
      )
      .run(now, `swarm:${run.id}:${node.nodeKey}`);

    let updatedNode;
    if (result.outcome === 'abort') {
      updatedNode = transitionNodeTerminalCas(store, null, node.id, SWARM_NODE_STATES.FAILED, {
        emitEvent: false,
        patch: {
          reconcileApprovalId: null,
          activeFence: null,
          activeJobId: null,
          errorCode: 'RECONCILIATION_ABORTED',
          errorMessage: result.reason || 'Operator aborted reconciliation',
        },
      });
    } else {
      // Fix C9: If worktree state was lost and operator requests clean re-execution (`not_applied`),
      // clear stale childSessionId/childTurnId so node starts cleanly from HEAD instead of hallucinating lost files.
      const patch =
        isWorktreeStateLost && result.outcome === 'not_applied'
          ? {
              reconcileApprovalId: null,
              activeFence: null,
              activeJobId: null,
              childSessionId: null,
              childTurnId: null,
              worktreeLeaseId: null,
            }
          : { reconcileApprovalId: null, activeFence: null, activeJobId: null };
      updatedNode = transitionSwarmNode(store, null, node.id, SWARM_NODE_STATES.READY, {
        emitEvent: false,
        patch,
      });
    }

    if (run.status === SWARM_RUN_STATES.RECONCILING) {
      transitionSwarmRun(store, run.id, SWARM_RUN_STATES.RUNNING, {
        patch: { currentPhase: 'running' },
      });
    }

    return { run, updatedNode };
  });

  if (!outcome) return null;

  try {
    eventRouter?.emitPersisted({
      sessionId: outcome.run.sessionId,
      turnId: outcome.run.rootTurnId,
      type: RUNTIME_EVENTS.SWARM_NODE_UPDATED,
      data: {
        runId: outcome.updatedNode.runId,
        nodeId: outcome.updatedNode.id,
        nodeKey: outcome.updatedNode.nodeKey,
        status: outcome.updatedNode.status,
        childSessionId: outcome.updatedNode.childSessionId || undefined,
        errorCode: outcome.updatedNode.errorCode || undefined,
      },
      audit: false,
    });
  } catch {
    // best-effort event emission
  }

  enqueueSwarmJob(
    jobQueue,
    SWARM_JOB_KINDS.DEPENDENCY_RESOLVE,
    {
      runId: outcome.run.id,
      sessionId: outcome.run.sessionId,
      planVersion: outcome.run.planVersion || 1,
      epoch: now,
    },
    {
      idempotencyKey: `swarm:resolve:${outcome.run.id}:reconcile:${result.id || uuid().slice(0, 8)}`,
    },
  );

  return getRun(outcome.run.id);
}
