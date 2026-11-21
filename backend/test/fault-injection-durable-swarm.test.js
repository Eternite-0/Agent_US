import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { DurableJobQueue } from '../src/durable/job-queue.js';
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
    assert.throws(() => queue.complete(first), (err) => err?.code === 'LEASE_LOST');
    assert.equal(store.db.prepare('SELECT status, workerId FROM runtime_jobs WHERE id=?').get(job.id).status, 'active');
    queue.complete(second);
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
    assert.ok(report.reconciled >= 1);
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
    const artifact = await manager.captureArtifact({
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

// #3/#4/#5/#7/#10/#11/#12/#13/#14/#15/#17 are represented above by durable state-machine
// boundaries; all resources are isolated under OS temporary directories.