import assert from 'node:assert/strict';
import test from 'node:test';
import { groupDirectMessages, reasoningHeadline } from '../src/utils/directMessages.ts';

const user = (cursor = 1, turnId = 't1') => ({ cursor, turnId, type: 'user/message', text: `Turn ${turnId}` });
const answer = (cursor, fields = {}) => ({ cursor, turnId: 't1', type: 'assistant/message', ...fields });
const result = (cursor, callId, fields = {}) => ({ cursor, callId, turnId: 't1', type: 'tool/result', name: 'bash', text: 'output', ...fields });
const call = (id, command = 'ls') => ({ id, name: 'bash', arguments: JSON.stringify({ command }) });
const event = (type, timestamp, turnId = 't1') => ({ type, timestamp, payload: { turnId } });

test('adjacent activity is grouped in order and a visible assistant message starts a new phase', () => {
  const [exchange] = groupDirectMessages('s', '', [user(),
    answer(2, { reasoning: 'Checking the repo', toolCalls: [call('a'), call('b')] }),
    result(3, 'b'), result(4, 'a'),
    answer(5, { text: 'I found the project. I will verify it.', toolCalls: [call('c', 'npm run check')] }),
    result(6, 'c', { meta: { isError: true } }),
    answer(7, { reasoning: 'Summarizing the findings', text: 'Verification failed.' }),
  ]);
  assert.deepEqual(exchange.blocks.map((b) => b.kind), ['activity', 'message', 'activity', 'message']);
  assert.deepEqual(exchange.blocks[0].items.map((item) => [item.kind, item.id]), [['reasoning', 's-m-2-reasoning'], ['tool', 'a'], ['tool', 'b']]);
  assert.equal(exchange.blocks[0].items[1].output, 'output');
  assert.equal(exchange.blocks[2].items[0].status, 'failed');
  assert.equal(exchange.blocks[2].items[1].text, 'Summarizing the findings');
  assert.equal(exchange.blocks[3].text, 'Verification failed.');
});

test('the same activity row survives waiting, changing headline and persistence', () => {
  const messages = [user(), answer(2, { text: 'I will check the repository.' })];
  const waiting = groupDirectMessages('s', '', [user()], { isLive: true })[0].blocks[0];
  assert.equal(waiting.waiting, true);
  const liveA = { turnId: 't1', text: '', reasoning: '**Checking remote**' };
  const liveB = { ...liveA, reasoning: '**Checking remote**\n\n**Checking identity**' };
  const phase = (items, liveStream) => groupDirectMessages('s', '', items, { isLive: true, liveStream })[0].blocks[1];
  const first = phase(messages, liveA);
  const second = phase(messages, liveB);
  const saved = phase([...messages, answer(3, { reasoning: liveB.reasoning, toolCalls: [call('a')] })], liveB);
  assert.equal(first.id, second.id);
  assert.equal(first.id, saved.id);
  assert.equal(reasoningHeadline(first.items[0].text), 'Checking remote');
  assert.equal(reasoningHeadline(second.items[0].text), 'Checking identity');
  assert.deepEqual(saved.items.map((item) => item.kind), ['reasoning', 'tool']);
});

test('parallel live tool output attaches to its call, even when another call finishes', () => {
  const items = [user(), answer(2, { toolCalls: [call('a'), call('b'), call('c')] }), result(3, 'a')];
  const live = groupDirectMessages('s', '', items, {
    isLive: true,
    liveToolOutputs: [
      { turnId: 't1', callId: 'a', text: 'stale' },
      { turnId: 't1', callId: 'b', text: 'first stream' },
      { turnId: 't1', callId: 'c', text: 'second stream' },
    ],
    pendingCallIds: new Set(['c']),
  })[0].blocks[0].items;
  assert.deepEqual(live.map((row) => [row.id, row.status, row.liveOutput]), [
    ['a', 'completed', undefined], ['b', 'running', 'first stream'], ['c', 'waiting', 'second stream'],
  ]);
});

test('elapsed time and live progress belong to the correct turn', () => {
  const items = [user(), answer(2, { toolCalls: [call('a')] }), user(3, 't2')];
  const [previous, active] = groupDirectMessages('s', '', items, {
    events: [event('turn/started', 1000), event('turn/cancelled', 2500), event('turn/started', 5100, 't2')],
    liveStream: { turnId: 't2', text: '', reasoning: 'Checking something new' }, isLive: true,
  });
  assert.deepEqual(previous.timing, { startedAt: 1000, end: 'turn/cancelled', durationMs: 1500 });
  assert.equal(previous.blocks[0].items[0].status, 'interrupted');
  assert.equal(active.timing.startedAt, 5100);
  assert.equal(active.blocks[0].items[0].live, true);
});

test('long reasoning becomes a bounded single-line rolling preview', () => {
  const old = 'An earlier thought '.repeat(12);
  assert.match(reasoningHeadline(old + 'new text'), /new text$/);
  assert.ok(reasoningHeadline(old + 'new text').length <= 76);
  assert.equal(reasoningHeadline('First idea\n\n## Checking read_file'), 'Checking read_file');
});
