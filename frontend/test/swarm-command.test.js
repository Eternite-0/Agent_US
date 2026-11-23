import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveBackendClient } from '../src/api/client.ts';
import { groupDirectMessages } from '../src/utils/directMessages.ts';
import { isSwarmCommand, swarmAttachmentError } from '../src/utils/swarmCommand.ts';

const session = { id: 'chat/1', title: 'Existing session' };
const run = { id: 'r1', sessionId: session.id, status: 'running', goal: 'analyze logs', nodes: [], usage: {}, updatedAt: 10 };
const files = { 'notes.txt': 'bm90ZXM=' };

function connection(t, ...responses) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, { method, body }) => {
    calls.push({ path: new URL(url).pathname, method, body: JSON.parse(body) });
    assert.ok(responses.length, 'unexpected request');
    return Response.json(responses.shift());
  });
  return { client: new LiveBackendClient({ mode: 'live', token: '', baseUrl: 'http://localhost:8787' }), calls };
}

test('only explicit commands get command routing and the upload warning', () => {
  for (const input of ['/swarm', '/SWARM status', ' /swarm stop ', '/swarm analyze\nlogs']) {
    assert.equal(isSwarmCommand(input), true);
    assert.match(swarmAttachmentError(input, files), /移除附件/);
    assert.equal(swarmAttachmentError(input, {}), undefined);
  }
  for (const input of ['/swarmish', 'explain /swarm stop', '/plan /swarm task', '/swarm-plan', 'hello']) {
    assert.equal(isSwarmCommand(input), false);
    assert.equal(swarmAttachmentError(input, files), undefined);
  }
});

test('a new chat posts the unchanged command to its session and keeps the hydrated receipt', async (t) => {
  const receipt = { mode: 'swarm', action: 'start', runId: run.id, run, message: 'started' };
  const { client, calls } = connection(t, session, receipt);
  const input = '/swarm analyze\nlogs';
  const result = await client.submitTask({ input, model: 'test', permissionMode: 'auto-safe', effort: 'high', idempotencyKey: 'once' });
  assert.deepEqual(result, { ...receipt, id: session.id });
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [['POST', '/v1/sessions'], ['POST', '/v1/sessions/chat%2F1/turns']]);
  assert.deepEqual(calls[1].body, { input, model: 'test', effort: 'high', permissionMode: 'auto-safe', clientTurnId: 'once' });
});

test('follow-up controls preserve null and terminal receipts and normal turns keep their metadata and files', async (t) => {
  const receipts = ['help', 'status', 'stop'].map((action) => ({ mode: 'swarm', action, message: action, runId: action === 'stop' ? run.id : null, run: action === 'stop' ? { ...run, status: 'cancelled' } : null }));
  const normal = { session, turn: { id: 't1', state: 'running' } };
  const { client, calls } = connection(t, ...receipts, normal, session, normal);
  for (const [index, input] of ['/swarm', '/swarm status', '/swarm stop'].entries()) {
    assert.deepEqual(await client.submitFollowupTurn(session.id, input), { ...receipts[index], id: session.id });
    assert.equal(calls[index].path, '/v1/sessions/chat%2F1/turns');
    assert.equal(calls[index].body.input, input);
  }
  const input = 'explain /swarm';
  const next = await client.submitFollowupTurn(session.id, input, { files, clientTurnId: 'c1' });
  assert.equal(next.code, 't1');
  assert.equal(next.status, 'running');
  assert.deepEqual(calls[3].body, { input, files, clientTurnId: 'c1' });
  const first = await client.submitTask({ input, files, model: 'test', idempotencyKey: 'c2' });
  assert.equal(first.code, 't1');
  assert.deepEqual(calls[5].body.files, files);
});

test('command attachments are rejected before session creation or turn submission', async (t) => {
  const { client, calls } = connection(t);
  await assert.rejects(client.submitTask({ input: '/swarm task', files }), /移除附件/);
  await assert.rejects(client.submitFollowupTurn(session.id, '/swarm stop', { files }), /移除附件/);
  assert.deepEqual(calls, []);
});

test('a receipt interleaved with a busy direct turn stays in its own exchange', () => {
  const exchanges = groupDirectMessages(session.id, '', [
    { cursor: 1, turnId: 't1', type: 'user/message', text: 'ordinary' },
    { cursor: 2, type: 'user/message', text: '/swarm stop', meta: { swarmAction: 'stop', runId: 'r1' } },
    { cursor: 3, type: 'assistant/message', text: 'stopped' },
    { cursor: 4, turnId: 't1', type: 'tool/result', name: 'ls', text: 'file' },
    { cursor: 5, turnId: 't1', type: 'assistant/message', text: 'ordinary answer' },
  ]);
  assert.equal(exchanges[1].swarmRunId, 'r1');
  assert.equal(exchanges[0].swarmRunId, undefined);
  assert.deepEqual(exchanges.map((e) => [e.command, e.assistantTexts.map((m) => m.text), e.tools.length]), [[false, ['ordinary answer'], 1], [true, ['stopped'], 0]]);
});
