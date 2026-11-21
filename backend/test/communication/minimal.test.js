import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunicationBus, CommunicationValidationError, MemoryCommunicationAdapter, StoreCommunicationAdapter } from '../../src/communication/index.js';
import { Store } from '../../src/store.js';

function harness(start = 1_000) {
  let now = start;
  const adapter = new MemoryCommunicationAdapter();
  const bus = new CommunicationBus({ adapter, clock: () => now, defaultTtlMs: 100, defaultMaxAttempts: 3, visibilityTimeoutMs: 10, retryDelayMs: 5 });
  return { adapter, bus, advance(ms) { now += ms; } };
}
const artifact = { version: 1, artifacts: [{ uri: 'artifact://run-1/node-a/1', sha256: 'a'.repeat(64) }] };

test('message schema validates envelope and artifact URI+sha256 manifest', async () => {
  const { bus } = harness();
  const sent = await bus.send({ conversationId: 'c1', runId: 'r1', fromAgentId: 'parent', toAgentId: 'child', kind: 'task.start', idempotencyKey: 'k1', payload: { text: 'work' }, artifactManifest: artifact });
  assert.equal(sent.status, 'created');
  assert.equal(sent.message.artifactManifest.artifacts[0].sha256, 'a'.repeat(64));
  await assert.rejects(() => bus.send({ conversationId: 'c1', fromAgentId: 'a', toAgentId: 'b', kind: 'bad Kind', payload: {} }), (err) => err instanceof CommunicationValidationError && err.code === 'INVALID_ENVELOPE');
  await assert.rejects(() => bus.send({ conversationId: 'c1', fromAgentId: 'a', toAgentId: 'b', payload: {}, artifactManifest: { version: 1, artifacts: [{ uri: 'https://example.test/a', sha256: 'a'.repeat(64) }] } }), (err) => err.code === 'INVALID_ARTIFACT_URI');
  await assert.rejects(() => bus.send({ conversationId: 'c1', fromAgentId: 'a', toAgentId: 'b', payload: {}, artifactManifest: { version: 1, artifacts: [{ uri: 'artifact://x/a', sha256: 'bad' }] } }), (err) => err.code === 'INVALID_ARTIFACT_SHA256');
});

test('idempotent send replays identical envelope and conflicts require reviewer', async () => {
  const { bus } = harness();
  const input = { conversationId: 'c1', fromAgentId: 'a', toAgentId: 'b', kind: 'note', idempotencyKey: 'same', payload: { n: 1 } };
  const first = await bus.send(input);
  const replay = await bus.send(input);
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.message.messageId, first.message.messageId);
  const conflict = await bus.send({ ...input, payload: { n: 2 } });
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.conflict.decision, 'reviewer-needed');
  const resolved = await bus.resolveConflict(conflict.conflict.conflictId, 'accept-new-after-manual-review', 'reviewer-1');
  assert.equal(resolved.status, 'resolved');
});

test('receive/ack is at-least-once, retry is bounded, and dead letters after max attempts', async () => {
  const { bus, advance } = harness();
  await bus.send({ conversationId: 'c1', fromAgentId: 'a', toAgentId: 'b', idempotencyKey: 'retry-1', payload: {} });
  const first = await bus.receive('b');
  assert.equal(first.attempts, 1);
  assert.match(first.deliveryToken, /^[0-9a-f-]{36}$/);
  await assert.rejects(() => bus.ack(first.messageId, 'b', 'stale-worker-token'), (err) => err.code === 'DELIVERY_TOKEN_MISMATCH');
  advance(11);
  const second = await bus.receive('b');
  assert.equal(second.messageId, first.messageId);
  assert.equal(second.attempts, 2);
  await bus.retry(second.messageId, 'b', { deliveryToken: second.deliveryToken, delayMs: 5, error: 'temporary' });
  assert.equal(await bus.receive('b'), null);
  advance(5);
  const third = await bus.receive('b');
  assert.equal(third.attempts, 3);
  await bus.retry(third.messageId, 'b', { deliveryToken: third.deliveryToken, error: 'final' });
  assert.equal((await bus.get(third.messageId)).status, 'dead_letter');
  await assert.rejects(() => bus.ack(third.messageId, 'wrong-agent'), (err) => err.code === 'ACK_RECIPIENT_MISMATCH');
});

test('store communication claims are fenced and atomically exclusive', async () => {
  const store = new Store(':memory:');
  const bus = new CommunicationBus({ adapter: new StoreCommunicationAdapter({ store }), clock: () => 2_000, defaultTtlMs: 10_000, visibilityTimeoutMs: 50 });
  try {
    const sent = await bus.send({ conversationId: 'store-c1', runId: 'store-r1', fromAgentId: 'a', toAgentId: 'b', idempotencyKey: 'store-1', payload: { task: 'one' } });
    const claims = await Promise.all([bus.receive('b'), bus.receive('b')]);
    const delivered = claims.filter(Boolean);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].messageId, sent.message.messageId);
    assert.match(delivered[0].deliveryToken, /^[0-9a-f-]{36}$/);
    await assert.rejects(() => bus.ack(sent.message.messageId, 'b', 'old-worker'), (err) => err.code === 'DELIVERY_TOKEN_MISMATCH');
    const acked = await bus.ack(delivered[0].messageId, 'b', delivered[0].deliveryToken);
    assert.equal(acked.status, 'acked');
  } finally {
    store.close();
  }
});

test('expiry, cancellation, parent-child links, and per-stream order are enforced', async () => {
  const { bus, advance } = harness();
  const parent = await bus.send({ conversationId: 'c1', runId: 'r1', fromAgentId: 'parent', toAgentId: 'child', idempotencyKey: 'p', payload: {} });
  const child = await bus.send({ conversationId: 'c1', runId: 'r1', fromAgentId: 'child', toAgentId: 'reviewer', parentMessageId: parent.message.messageId, parentAgentId: 'parent', idempotencyKey: 'child', payload: {} });
  const first = await bus.receive('child');
  assert.equal(first.messageId, parent.message.messageId);
  const later = await bus.send({ conversationId: 'c1', runId: 'r1', fromAgentId: 'child', toAgentId: 'reviewer', idempotencyKey: 'later', payload: {} });
  assert.equal((await bus.receive('reviewer')).messageId, child.message.messageId);
  assert.equal((await bus.cancel(later.message.messageId, 'child')).status, 'cancelled');
  advance(101);
  await bus.sweep();
  assert.equal((await bus.get(parent.message.messageId)).status, 'expired');
  await assert.rejects(() => bus.send({ conversationId: 'c1', runId: 'r1', fromAgentId: 'x', toAgentId: 'y', parentMessageId: 'missing', parentAgentId: 'p', payload: {} }), (err) => err.code === 'PARENT_LINK_NOT_FOUND');
});
