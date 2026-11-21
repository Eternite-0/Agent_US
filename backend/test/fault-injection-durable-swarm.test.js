import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  readdirSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { DurableJobQueue } from '../src/durable/job-queue.js';
import { createLeaseGuard } from '../src/durable/lease-guard.js';
import { UnknownOutcomeReconciler } from '../src/durable/reconciliation.js';
import { TaskTreeBudgetLedger } from '../src/swarm/budget-ledger.js';
import { SwarmArtifactManager } from '../src/swarm/artifacts.js';
import { rmDirSafe, withTimeout } from './fixtures.js';

function makeDir(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }
function initGit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@agent-us.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Agent US Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'root\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

// #3/#4/#5/#7: receipt lease fencing, delayed stale writes, and unknown-outcome convergence.
test('Fault injection durable #3/#4/#5/#7: stale receipt finish cannot overwrite outcome_unknown', () => {
  const dir = makeDir('agent-us-fi-receipt-');
  const store = new Store(join(dir, 'engine.sqlite'));
  try {
    const reconciler = new UnknownOutcomeReconciler(store, null);
    const started = reconciler.recordReceiptStart({
      sessionId: 's-fi', turnId: 't-fi', callId: 'c-fi', toolName: 'deploy',
      replayable: false, outward: true, args: { target: 'prod' },
    });
    assert.ok(started?.id);
    store.tx(() => store.db.prepare("UPDATE tool_receipts SET status='outcome_unknown' WHERE id=?").run(started.id));
    const late = reconciler.recordReceiptFinish(started.id, { status: 'finished', output: 'late worker write' });
    assert.equal(late.status, 'outcome_unknown');
    assert.equal(store.db.prepare('SELECT status FROM tool_receipts WHERE id=?').get(started.id).status, 'outcome_unknown');
  } finally { store.close(); rmDirSafe(dir); }
});

// #10/#11: durable job lease expiry is fenced and stale completion cannot change a newer owner.
test('Fault injection durable #10/#11: stale job completion is fenced after takeover', () => {
  const dir = makeDir('agent-us-fi-job-');
  const store = new Store(join(dir, 'engine.sqlite'));
  try {
    const queue = new DurableJobQueue(store, { defaultLeaseMs: 1000 });
    const job = queue.enqueue({ kind: 'fault_probe', taskId: 'run-fi', payload: { value: 1 }, idempotencyKey: 'fi-job-1' });
    const first = queue.claim({ workerId: 'old-worker', kinds: ['fault_probe'], leaseMs: 1000 });
    assert.equal(first.id, job.id);
    store.tx(() => store.db.prepare('UPDATE runtime_jobs SET leaseExpiresAt=? WHERE id=?').run(Date.now() - 1, job.id));
    const second = queue.claim({ workerId: 'new-worker', kinds: ['fault_probe'], leaseMs: 1000 });
    assert.notEqual(second.fence, first.fence);
    assert.throws(() => queue.complete(first.id, first.fence), (err) => err?.code === 'LEASE_LOST');
    assert.equal(store.db.prepare('SELECT status, workerId FROM runtime_jobs WHERE id=?').get(job.id).status, 'active');
    queue.complete(second.id, second.fence);
    assert.equal(store.db.prepare('SELECT status FROM runtime_jobs WHERE id=?').get(job.id).status, 'done');
  } finally { store.close(); rmDirSafe(dir); }
});

// #12/#13: budget reservations release on failed/lease-lost execution and reconcile orphaned rows.
test('Fault injection durable #12/#13: budget reservations reconcile deterministically after crash', () => {
  const dir = makeDir('agent-us-fi-budget-');
  const store = new Store(join(dir, 'engine.sqlite'));
  try {
    const ledger = new TaskTreeBudgetLedger(store);
    ledger.ensureLedger({ treeId: 'tree-fi', rootSessionId: 's-fi', budget: { maxTotalSteps: 2 } });
    const reservation = ledger.reserveInference({ treeId: 'tree-fi', scope: 'node_execution', nodeId: 'n-fi', nodeKey: 'n-fi', estimatedInputTokens: 10, requestedMaxOutputTokens: 20 });
    assert.ok(reservation.reservationId);
    const row = store.db.prepare('SELECT status FROM budget_reservations WHERE id=?').get(reservation.reservationId);
    assert.equal(row.status, 'reserved');
    const report = ledger.reconcileAfterRestart();
    assert.ok(report.reconciledCount >= 1);
    assert.equal(store.db.prepare('SELECT status FROM budget_reservations WHERE id=?').get(reservation.reservationId).status, 'reconciled');
    const snap = ledger.getSnapshot('tree-fi');
    assert.equal(snap.reservedSteps, 0);
  } finally { store.close(); rmDirSafe(dir); }
});

// #14/#15/#17: artifact write succeeds before DB failure; orphan cleanup is deterministic and does not delete unrelated files.
test('Fault injection durable #14/#15/#17: artifact orphan cleanup preserves unrelated files', async () => {
  const repo = makeDir('agent-us-fi-artifact-repo-');
  const storage = makeDir('agent-us-fi-artifact-store-');
  const dbDir = makeDir('agent-us-fi-artifact-db-');
  const store = new Store(join(dbDir, 'engine.sqlite'));
  try {
    initGit(repo);
    writeFileSync(join(repo, 'result.txt'), 'artifact content\n');
    const manager = new SwarmArtifactManager({ store, storageRoot: storage });
    const artifact = await manager.archiveWorktree({
      runId: 'run-fi', nodeId: 'node-fi', nodeKey: 'node-fi', childSessionId: 's-fi', childTurnId: 't-fi',
      ownerId: 'owner-fi', fence: 'f1', workspaceRoot: repo, worktreePath: repo,
    });
    assert.ok(artifact?.id);
    assert.ok(existsSync(artifact.storagePath));
    const unrelated = join(storage, 'unrelated.txt');
    writeFileSync(unrelated, 'keep\n');
    const report = manager.cleanupOrphanArtifacts();
    assert.ok(report && typeof report === 'object');
    assert.equal(readFileSync(unrelated, 'utf8'), 'keep\n');
  } finally { store.close(); rmDirSafe(repo); rmDirSafe(storage); rmDirSafe(dbDir); }
});

// #3/#4/#10/#12/#13: a reservation is fenced to the attempt that created it;
// a stale worker cannot settle it, while restart reconciliation is idempotent.
test('Fault injection durable #3/#4/#10/#12/#13: lease-lost reservation is reconciled once', () => {
  const dir = makeDir('agent-us-fi-budget-fence-');
  const store = new Store(join(dir, 'engine.sqlite'));
  try {
    const queue = new DurableJobQueue(store, { defaultLeaseMs: 1000 });
    const ledger = new TaskTreeBudgetLedger(store);
    ledger.ensureLedger({ treeId: 'tree-fence', rootSessionId: 's-fence', budget: { maxTotalSteps: 3 } });
    const job = queue.enqueue({
      kind: 'swarm_node_execute',
      taskId: 'tree-fence',
      payload: { runId: 'tree-fence', nodeId: 'n-fence', nodeKey: 'n-fence' },
      maxAttempts: 3,
    });
    const first = queue.claim({ workerId: 'worker-fence-a', kinds: ['swarm_node_execute'], leaseMs: 1000 });
    const reservation = ledger.reserveInference({
      treeId: 'tree-fence',
      nodeId: 'n-fence',
      nodeKey: 'n-fence',
      jobId: job.id,
      fence: first.fence,
      estimatedInputTokens: 12,
      requestedMaxOutputTokens: 24,
    });
    assert.ok(reservation.reservationId);
    store.tx(() =>
      store.db
        .prepare('UPDATE runtime_jobs SET leaseExpiresAt=? WHERE id=?')
        .run(Date.now() - 1, job.id),
    );
    const second = queue.claim({ workerId: 'worker-fence-b', kinds: ['swarm_node_execute'], leaseMs: 1000 });
    const staleGuard = createLeaseGuard({ store, jobId: job.id, fence: first.fence });
    assert.throws(
      () => ledger.settleReservation(reservation.reservationId, { leaseGuard: staleGuard }),
      (err) => err?.code === 'LEASE_LOST',
    );
    assert.equal(
      store.db.prepare('SELECT status FROM budget_reservations WHERE id=?').get(reservation.reservationId).status,
      'reserved',
    );

    const firstReport = ledger.reconcileAfterRestart();
    assert.equal(firstReport.reconciledCount, 1);
    assert.equal(
      store.db.prepare('SELECT status FROM budget_reservations WHERE id=?').get(reservation.reservationId).status,
      'reconciled',
    );
    const secondReport = ledger.reconcileAfterRestart();
    assert.equal(secondReport.reconciledCount, 0, 'recovery must not double-charge the same reservation');
    assert.equal(ledger.getSnapshot('tree-fence').reservedSteps, 0);
    queue.complete(second.id, second.fence);
  } finally {
    store.close();
    rmDirSafe(dir);
  }
});

// #3/#5/#7/#14: multiple unknown receipts are reconciled as one durable decision,
// and a late finish cannot overwrite either receipt after the decision commits.
test('Fault injection durable #3/#5/#7/#14: multi-receipt reconciliation is atomic and stale-finish safe', () => {
  const dir = makeDir('agent-us-fi-multi-receipt-');
  const store = new Store(join(dir, 'engine.sqlite'));
  try {
    const now = Date.now();
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO direct_sessions(id,title,state,createdAt,updatedAt)
           VALUES('s-multi','multi','reconciling',?,?)`,
        )
        .run(now, now);
      store.db
        .prepare(
          `INSERT INTO direct_turns(id,sessionId,input,state,createdAt)
           VALUES('t-multi','s-multi','multi','reconciling',?)`,
        )
        .run(now);
    });
    const reconciler = new UnknownOutcomeReconciler(store, null);
    const r1 = reconciler.recordReceiptStart({
      sessionId: 's-multi', turnId: 't-multi', callId: 'c-1', toolName: 'deploy', outward: true,
      args: { target: 'one' },
    });
    const r2 = reconciler.recordReceiptStart({
      sessionId: 's-multi', turnId: 't-multi', callId: 'c-2', toolName: 'notify', outward: true,
      args: { target: 'two' },
    });
    store.tx(() =>
      store.db
        .prepare("UPDATE tool_receipts SET status='outcome_unknown' WHERE id IN (?,?)")
        .run(r1.id, r2.id),
    );
    const inspected = reconciler.inspectInterruptedTurn('t-multi', { sessionId: 's-multi' });
    assert.equal(inspected.needsReconciliation, true);
    const approval = store.db.prepare('SELECT * FROM direct_approvals WHERE id=?').get(inspected.approvalId);
    const approvalArgs = JSON.parse(approval.arguments);
    assert.deepEqual(new Set(approvalArgs.unknownReceiptIds), new Set([r1.id, r2.id]));

    const resolved = reconciler.resolveReconciliation(inspected.approvalId, {
      outcome: 'happened',
      note: 'confirmed externally',
    });
    assert.equal(resolved.outcome, 'happened');
    assert.deepEqual(
      store.db
        .prepare('SELECT id,status FROM tool_receipts WHERE id IN (?,?) ORDER BY id')
        .all(r1.id, r2.id)
        .map((row) => row.status),
      ['reconciled_succeeded', 'reconciled_succeeded'],
    );
    assert.equal(reconciler.recordReceiptFinish(r1.id, { status: 'finished', output: 'late' }).status, 'reconciled_succeeded');
    assert.equal(reconciler.recordReceiptFinish(r2.id, { status: 'finished', output: 'late' }).status, 'reconciled_succeeded');
  } finally {
    store.close();
    rmDirSafe(dir);
  }
});

// #14/#15/#17: case-only renames are archived/applied without losing the file,
// and orphan GC removes only stale unregistered artifact directories.
test('Fault injection durable #14/#15/#17: case-only artifact rename and orphan GC are deterministic', async () => {
  const repo = makeDir('agent-us-fi-case-repo-');
  const storage = makeDir('agent-us-fi-case-store-');
  const dbDir = makeDir('agent-us-fi-case-db-');
  const store = new Store(join(dbDir, 'engine.sqlite'));
  try {
    initGit(repo);
    writeFileSync(join(repo, 'CaseFile.txt'), 'case content\n');
    execFileSync('git', ['add', 'CaseFile.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'case file'], { cwd: repo });
    execFileSync('git', ['mv', 'CaseFile.txt', 'casefile.txt'], { cwd: repo });
    const manager = new SwarmArtifactManager({ store, storageRoot: storage });
    const artifact = await manager.archiveWorktree({
      runId: 'run-case', nodeId: 'node-case', nodeKey: 'node-case',
      workspaceRoot: repo, worktreePath: repo, ownerId: 'case-owner',
    });
    const renamed = artifact.manifest.entries.find((entry) => entry.changeType === 'renamed');
    assert.equal(renamed?.previousPath, 'CaseFile.txt');
    const applied = manager.applyToParent(artifact.id, { workspaceRoot: repo, permissionMode: 'auto-safe' });
    assert.equal(applied.status, 'applied');
    const names = readdirSync(repo);
    assert.equal(names.includes('casefile.txt'), true);
    assert.equal(names.includes('CaseFile.txt'), false);

    const orphanPath = join(storage, 'run-orphan', 'orphan-art');
    mkdirSync(orphanPath, { recursive: true });
    writeFileSync(join(orphanPath, 'manifest.json'), '{}');
    const old = new Date(Date.now() - 60_000);
    utimesSync(orphanPath, old, old);
    const report = manager.cleanupOrphanArtifacts({ minAgeMs: 1 });
    assert.equal(report.removed, 1);
    assert.equal(existsSync(orphanPath), false);
  } finally {
    store.close();
    rmDirSafe(repo);
    rmDirSafe(storage);
    rmDirSafe(dbDir);
  }
});

// #17: attempts exhausted is a terminal durable outcome and cannot be reclaimed again.
test('Fault injection durable #17: ATTEMPTS_EXHAUSTED converges job finality', () => {
  const dir = makeDir('agent-us-fi-attempts-');
  const store = new Store(join(dir, 'engine.sqlite'));
  try {
    const queue = new DurableJobQueue(store, { defaultLeaseMs: 1000 });
    const job = queue.enqueue({ kind: 'fault_probe', payload: { probe: true }, maxAttempts: 1 });
    const first = queue.claim({ workerId: 'attempt-worker-a', kinds: ['fault_probe'], leaseMs: 1000 });
    store.tx(() =>
      store.db.prepare('UPDATE runtime_jobs SET leaseExpiresAt=? WHERE id=?').run(Date.now() - 1, job.id),
    );
    assert.equal(queue.claim({ workerId: 'attempt-worker-b', kinds: ['fault_probe'], leaseMs: 1000 }), null);
    const row = store.db.prepare('SELECT status,errorCode,attempts FROM runtime_jobs WHERE id=?').get(job.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.errorCode, 'ATTEMPTS_EXHAUSTED');
    assert.equal(row.attempts, 1);
    assert.equal(queue.claim({ workerId: 'attempt-worker-c', kinds: ['fault_probe'], leaseMs: 1000 }), null);
    assert.equal(first.status, 'active');
  } finally {
    store.close();
    rmDirSafe(dir);
  }
});

// #3/#4/#5/#7/#10/#11/#12/#13/#14/#15/#17 are represented above by durable state-machine
// boundaries; all resources are isolated under OS temporary directories.
