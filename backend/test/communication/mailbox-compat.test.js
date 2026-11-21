import test from 'node:test';
import assert from 'node:assert/strict';
import { InterAgentMailbox } from '../../src/swarm/mailbox.js';
import { Store } from '../../src/store.js';

function openMailbox() {
  const store = new Store(':memory:');
  return { store, mailbox: new InterAgentMailbox({ store }) };
}

test('InterAgentMailbox bridges conversation messages to CommunicationBus with idempotency', async () => {
  const { store, mailbox } = openMailbox();
  try {
    const input = {
      conversationId: 'compat-conversation', runId: 'compat-run', fromAgentId: 'parent', toAgentId: 'child',
      kind: 'task_assignment', idempotencyKey: 'compat-message-1', payload: { task: 'inspect artifact' },
    };
    const first = await mailbox.send(input);
    const replay = await mailbox.send(input);
    assert.equal(first.status, 'created');
    assert.equal(replay.status, 'replayed');
    assert.equal(replay.message.messageId, first.message.messageId);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM agent_messages').get().count, 0);
    const received = await mailbox.receive('child');
    assert.equal(received.messageId, first.message.messageId);
    assert.match(received.deliveryToken, /^[0-9a-f-]{36}$/);
    assert.equal((await mailbox.ack(received.messageId, 'child', received.deliveryToken)).status, 'acked');
  } finally { store.close(); }
});

test('CommunicationBus claims are mutually exclusive and delivery tokens fence ACKs', async () => {
  const { store, mailbox } = openMailbox();
  try {
    const sent = await mailbox.send({ conversationId: 'claim-conversation', runId: 'claim-run', fromAgentId: 'sender', toAgentId: 'worker', kind: 'task_update', idempotencyKey: 'claim-message-1', payload: { value: 1 } });
    const claims = await Promise.all([mailbox.receive('worker'), mailbox.receive('worker')]);
    const claimed = claims.filter(Boolean);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].messageId, sent.message.messageId);
    await assert.rejects(() => mailbox.ack(claimed[0].messageId, 'worker', 'stale-token'), (error) => error.code === 'DELIVERY_TOKEN_MISMATCH');
    assert.equal((await mailbox.ack(claimed[0].messageId, 'worker', claimed[0].deliveryToken)).status, 'acked');
    assert.equal(await mailbox.receive('worker'), null);
  } finally { store.close(); }
});

test('CommunicationBus retry is bounded and dead-letters after maxAttempts', async () => {
  const { store, mailbox } = openMailbox();
  try {
    const sent = await mailbox.send({ conversationId: 'retry-conversation', runId: 'retry-run', fromAgentId: 'sender', toAgentId: 'worker', kind: 'task_update', idempotencyKey: 'retry-message-1', maxAttempts: 2, payload: { value: 2 } });
    const first = await mailbox.receive('worker');
    assert.equal(first.messageId, sent.message.messageId);
    assert.equal((await mailbox.retry(first.messageId, 'worker', { deliveryToken: first.deliveryToken, delayMs: 0, error: 'temporary failure' })).status, 'pending');
    const second = await mailbox.receive('worker');
    assert.equal(second.attempts, 2);
    const deadLettered = await mailbox.retry(second.messageId, 'worker', { deliveryToken: second.deliveryToken, error: 'permanent failure' });
    assert.equal(deadLettered.status, 'dead_letter');
    assert.equal((await mailbox.getMessage(second.messageId)).lastError, 'permanent failure');
  } finally { store.close(); }
});

test('InterAgentMailbox keeps the legacy agent_messages API compatible without conversationId', () => {
  const { store, mailbox } = openMailbox();
  try {
    const sent = mailbox.send({ runId: 'legacy-run', sessionId: 'legacy-session', fromAgentId: 'parent', toAgentId: 'child', kind: 'note', payload: 'legacy payload' });
    assert.equal(sent.status, 'queued');
    assert.equal(mailbox.peekInbox('child', { runId: 'legacy-run' }).length, 1);
    const delivered = mailbox.drainInbox('child', { runId: 'legacy-run' });
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].payload, { text: 'legacy payload' });
    assert.equal(mailbox.drainInbox('child', { runId: 'legacy-run' }).length, 0);
  } finally { store.close(); }
});