import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { InterAgentMailbox } from '../src/swarm/mailbox.js';

async function withRuntimeStores(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-us-communication-runtime-'));
  const dbPath = join(dir, 'communication.sqlite');
  const storeA = new Store(dbPath);
  const storeB = new Store(dbPath);
  try {
    return await fn({ storeA, storeB, mailboxA: new InterAgentMailbox({ store: storeA }), mailboxB: new InterAgentMailbox({ store: storeB }) });
  } finally {
    if (storeA?.db?.isOpen) storeA.close();
    if (storeB?.db?.isOpen) storeB.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
}

test('unified CommunicationBus claims a message once across two runtime mailboxes', async () => {
  await withRuntimeStores(async ({ mailboxA, mailboxB }) => {
    const sent = await mailboxA.send({
      conversationId: 'conversation-multi-runtime',
      runId: 'run-multi-runtime',
      fromAgentId: 'parent-agent',
      toAgentId: 'child-agent',
      kind: 'task_assignment',
      idempotencyKey: 'multi-runtime-assignment',
      payload: { task: 'claim exactly once' },
    });
    assert.equal(sent.status, 'created');

    const [claimA, claimB] = await Promise.all([
      mailboxA.receive('child-agent'),
      mailboxB.receive('child-agent'),
    ]);
    const claims = [claimA, claimB].filter(Boolean);
    assert.equal(claims.length, 1, 'only one runtime may hold the active delivery lease');
    assert.equal(claims[0].messageId, sent.message.messageId);
    assert.match(claims[0].deliveryToken, /^[0-9a-f-]{36}$/);

    const winner = claimA ? mailboxA : mailboxB;
    const loser = claimA ? mailboxB : mailboxA;
    const acked = await winner.ack(claims[0].messageId, 'child-agent', claims[0].deliveryToken);
    assert.equal(acked.status, 'acked');
    assert.equal(await loser.receive('child-agent'), null, 'the losing runtime must not receive an acknowledged message');
    assert.equal((await winner.getMessage(claims[0].messageId)).status, 'acked');
  });
});

test('legacy InterAgentMailbox send/drainInbox remains atomically compatible beside the unified bus', async () => {
  await withRuntimeStores(async ({ mailboxA, mailboxB }) => {
    const legacy = mailboxA.send({
      runId: 'legacy-run',
      sessionId: 'legacy-session',
      fromAgentId: 'legacy-parent',
      toAgentId: 'legacy-child',
      kind: 'handoff',
      payload: { compatibility: true },
    });
    assert.equal(legacy.status, 'queued');

    const [claimA, claimB] = [
      mailboxA.drainInbox('legacy-child', { runId: 'legacy-run' }),
      mailboxB.drainInbox('legacy-child', { runId: 'legacy-run' }),
    ];
    const claims = [...claimA, ...claimB];
    assert.equal(claims.length, 1, 'legacy queued messages must remain single-claim across runtimes');
    assert.equal(claims[0].id, legacy.id);
    assert.deepEqual(claims[0].payload, { compatibility: true });

    assert.deepEqual(mailboxA.drainInbox('legacy-child', { runId: 'legacy-run' }), []);
    assert.deepEqual(mailboxB.drainInbox('legacy-child', { runId: 'legacy-run' }), []);
    assert.equal(await mailboxA.receive('legacy-child'), null, 'unified receive must not consume legacy rows implicitly');

    const unified = await mailboxB.send({
      conversationId: 'conversation-legacy-bridge',
      runId: 'legacy-run',
      fromAgentId: 'legacy-child',
      toAgentId: 'legacy-parent',
      kind: 'task_update',
      idempotencyKey: 'legacy-bridge-update',
      payload: { migrated: true },
    });
    const bridged = await mailboxA.claim('legacy-parent');
    assert.equal(bridged.messageId, unified.message.messageId);
    await mailboxA.ack(bridged.messageId, 'legacy-parent', bridged.deliveryToken);
  });
});


