import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommunicationBus, StoreCommunicationAdapter } from '../../src/communication/index.js';
import { InterAgentMailbox } from '../../src/swarm/mailbox.js';
import { Store } from '../../src/store.js';

async function withStores(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-us-comm-binding-'));
  const dbPath = join(dir, 'binding.sqlite');
  const storeA = new Store(dbPath);
  const storeB = new Store(dbPath);
  try {
    return await fn({
      storeA,
      storeB,
      mailboxA: new InterAgentMailbox({ store: storeA }),
      mailboxB: new InterAgentMailbox({ store: storeB }),
    });
  } finally {
    if (storeA?.db?.isOpen) storeA.close();
    if (storeB?.db?.isOpen) storeB.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
}

test('child binding commits with child turn before ACK and is recoverable after a crash window', async () => {
  await withStores(async ({ storeA, storeB, mailboxA, mailboxB }) => {
    let now = 10_000;
    const busA = new CommunicationBus({
      adapter: new StoreCommunicationAdapter({ store: storeA }),
      clock: () => now,
      visibilityTimeoutMs: 10,
      defaultTtlMs: 10_000,
    });
    const busB = new CommunicationBus({
      adapter: new StoreCommunicationAdapter({ store: storeB }),
      clock: () => now,
      visibilityTimeoutMs: 10,
      defaultTtlMs: 10_000,
    });
    mailboxA.setCommunicationBus(busA);
    mailboxB.setCommunicationBus(busB);

    const sent = await mailboxA.send({
      conversationId: 'binding-conversation',
      runId: 'binding-run',
      fromAgentId: 'parent',
      toAgentId: 'child-node',
      kind: 'task_assignment',
      idempotencyKey: 'binding-assignment',
      payload: { objective: 'persist the child turn' },
    });
    const first = await mailboxA.receive('child-node');
    assert.equal(first.messageId, sent.message.messageId);

    // This is the child-turn-start transaction. Deliberately do not ACK after
    // commit: the next line represents a process crash in the ACK window.
    storeA.tx(() => {
      storeA.db.prepare(
        `INSERT INTO direct_sessions(
          id, title, workspaceRoot, model, mode, permissionMode, state, createdAt, updatedAt
        ) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run('child-session-1', 'child', null, 'test-model', 'direct', 'auto-safe', 'running', now, now);
      storeA.db.prepare(
        `INSERT INTO direct_turns(
          id, sessionId, input, model, state, phase, step, activeFence, activeAttempt, trafficSource, isSynthetic, createdAt
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run('child-turn-1', 'child-session-1', 'persisted objective', 'test-model', 'running', 'init', 0, 'fence-1', 1, 'production', 0, now);
      busA.bindClaimToChildInTx({
        messageId: first.messageId,
        agentId: 'child-node',
        deliveryToken: first.deliveryToken,
        runId: 'binding-run',
        nodeId: 'node-1',
        childSessionId: 'child-session-1',
        childTurnId: 'child-turn-1',
        jobId: 'job-1',
        fence: 'fence-1',
        attempt: 1,
        now,
      });
    });

    const committed = await mailboxB.getMessage(first.messageId);
    assert.equal(committed.status, 'delivered');
    assert.deepEqual(committed.deliveryBinding, {
      runId: 'binding-run',
      nodeId: 'node-1',
      childSessionId: 'child-session-1',
      childTurnId: 'child-turn-1',
      jobId: 'job-1',
      fence: 'fence-1',
      attempt: 1,
      boundAt: now,
    });
    assert.equal(storeB.db.prepare('SELECT state FROM direct_turns WHERE id=?').get('child-turn-1').state, 'running');

    now += 11;
    const recovered = await mailboxB.receive('child-node');
    assert.equal(recovered.messageId, first.messageId);
    assert.notEqual(recovered.deliveryToken, first.deliveryToken);
    assert.deepEqual(recovered.deliveryBinding, committed.deliveryBinding);

    await assert.rejects(
      () => mailboxA.ack(first.messageId, 'child-node', first.deliveryToken),
      (error) => error.code === 'DELIVERY_TOKEN_MISMATCH',
    );
    const rebound = storeB.tx(() => busB.bindClaimToChildInTx({
      messageId: recovered.messageId,
      agentId: 'child-node',
      deliveryToken: recovered.deliveryToken,
      runId: 'binding-run',
      nodeId: 'node-1',
      childSessionId: 'child-session-1',
      childTurnId: 'child-turn-1',
      jobId: 'job-2',
      fence: 'fence-2',
      attempt: 2,
      now,
    }));
    assert.equal(rebound.deliveryBinding.childTurnId, 'child-turn-1');
    assert.equal((await mailboxB.ack(recovered.messageId, 'child-node', recovered.deliveryToken)).status, 'acked');
  });
});

test('child binding is idempotent for the same child and rejects a competing child', async () => {
  const store = new Store(':memory:');
  try {
    const bus = new CommunicationBus({ adapter: new StoreCommunicationAdapter({ store }), clock: () => 1_000 });
    const sent = await bus.send({
      conversationId: 'binding-idempotency', runId: 'run-1', fromAgentId: 'parent', toAgentId: 'node',
      idempotencyKey: 'assignment-1', payload: { ok: true },
    });
    const claim = await bus.receive('node');
    const first = store.tx(() => bus.bindClaimToChildInTx({
      messageId: claim.messageId, agentId: 'node', deliveryToken: claim.deliveryToken,
      runId: 'run-1', nodeId: 'node-1', childSessionId: 'session-1', childTurnId: 'turn-1',
      jobId: 'job-1', fence: 'fence-1', attempt: 1, now: 1_000,
    }));
    const replay = store.tx(() => bus.bindClaimToChildInTx({
      messageId: claim.messageId, agentId: 'node', deliveryToken: claim.deliveryToken,
      runId: 'run-1', nodeId: 'node-1', childSessionId: 'session-1', childTurnId: 'turn-1',
      jobId: 'job-2', fence: 'fence-2', attempt: 2, now: 1_001,
    }));
    assert.deepEqual(replay.deliveryBinding, first.deliveryBinding);
    assert.throws(() => store.tx(() => bus.bindClaimToChildInTx({
      messageId: claim.messageId, agentId: 'node', deliveryToken: claim.deliveryToken,
      runId: 'run-1', nodeId: 'node-1', childSessionId: 'session-2', childTurnId: 'turn-2',
      jobId: 'job-3', fence: 'fence-3', attempt: 3, now: 1_002,
    })), (error) => error.code === 'DELIVERY_BINDING_CONFLICT');
  } finally {
    store.close();
  }
});

test('child binding requires the active delivery lease and preserves legacy mailbox delivery', async () => {
  const store = new Store(':memory:');
  const mailbox = new InterAgentMailbox({ store });
  try {
    const bus = new CommunicationBus({ adapter: new StoreCommunicationAdapter({ store }), clock: () => 2_000 });
    const sent = await bus.send({
      conversationId: 'binding-fence', runId: 'run-fence', fromAgentId: 'parent', toAgentId: 'node',
      idempotencyKey: 'assignment-fence', payload: { ok: true },
    });
    const claim = await bus.receive('node');
    assert.throws(() => store.tx(() => bus.bindClaimToChildInTx({
      messageId: claim.messageId, agentId: 'node', deliveryToken: 'stale-token', runId: 'run-fence',
      nodeId: 'node-1', childSessionId: 'session-1', childTurnId: 'turn-1', now: 2_000,
    })), (error) => error.code === 'DELIVERY_TOKEN_MISMATCH');
    assert.throws(() => bus.bindClaimToChildInTx({
      messageId: claim.messageId, agentId: 'node', deliveryToken: claim.deliveryToken, runId: 'run-fence',
      nodeId: 'node-1', childSessionId: 'session-1', childTurnId: 'turn-1', now: 2_000,
    }), (error) => error.code === 'BINDING_REQUIRES_TRANSACTION');

    const legacy = mailbox.send({ runId: 'legacy-run', fromAgentId: 'parent', toAgentId: 'child', kind: 'note', payload: 'legacy' });
    assert.equal(legacy.status, 'queued');
    assert.equal(mailbox.drainInbox('child', { runId: 'legacy-run' }).length, 1);
    assert.equal((await bus.get(sent.message.messageId)).deliveryBinding, null);
  } finally {
    store.close();
  }
});
