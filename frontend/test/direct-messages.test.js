import assert from 'node:assert/strict';
import test from 'node:test';
import { directToolOutput, groupDirectMessages, reasoningHeadline } from '../src/utils/directMessages.ts';

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
  assert.deepEqual(exchange.blocks[0].items.map((item) => item.kind), ['reasoning', 'tool', 'tool']);
  assert.deepEqual(exchange.blocks[0].items.slice(1).map((item) => item.callId), ['a', 'b']);
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
  assert.equal(first.items[0].id, saved.items[0].id);
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
  assert.deepEqual(live.map((row) => [row.callId, row.status, row.liveOutput]), [
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


const tools = (exchange) => exchange.blocks.flatMap((block) => block.kind === 'activity' ? block.items.filter((item) => item.kind === 'tool') : []);
const messages = (exchange) => exchange.blocks.filter((block) => block.kind === 'message');

function toolEvent(type, callId, payload = {}, turnId = 't1') {
  return { type, timestamp: 300, payload: { turnId, callId, ...payload } };
}

test('a provisional turn hydrates without remounting when the user record arrives', () => {
  const options = {
    events: [event('turn/started', 1000)], isLive: true,
    liveStream: { turnId: 't1', text: 'Partial answer', reasoning: 'Checking' },
  };
  const [provisional] = groupDirectMessages('s', 'Turn t1', [], options);
  const [hydrated] = groupDirectMessages('s', 'Turn t1', [user(42)], options);
  assert.equal(provisional.key, hydrated.key);
  assert.deepEqual(provisional.blocks.map((block) => block.id), hydrated.blocks.map((block) => block.id));
});

test('live prose and reasoning keep their IDs when persisted, even if the text is finalized differently', () => {
  const history = [user(), answer(6, { text: 'An earlier step.', toolCalls: [call('first')] }), result(8, 'first')];
  const liveStream = { turnId: 't1', text: 'Streaming reply', reasoning: 'Preparing response' };
  const [live] = groupDirectMessages('s', '', history, { liveStream, isLive: true });
  const [complete] = groupDirectMessages('s', '', [...history, answer(19, { text: 'Final reply.', reasoning: liveStream.reasoning })], {
    events: [event('turn/completed', 400)],
  });
  assert.equal(messages(live).at(-1).id, messages(complete).at(-1).id);
  assert.equal(complete.blocks.at(-2).items.at(-1).id, live.blocks.at(-2).items.at(-1).id);
  assert.equal(messages(complete).at(-1).live, undefined);
});

test('a tool retains one ID when history introduces a prose boundary and moves its row', () => {
  const live = { turnId: 't1', callId: 'a', name: 'bash', text: 'live output' };
  const [before] = groupDirectMessages('s', '', [user()], { isLive: true, liveToolOutputs: [live] });
  const [after] = groupDirectMessages('s', '', [user(), answer(2, { text: 'Running diagnostics now.', toolCalls: [call('a')] })], {
    isLive: true, liveToolOutputs: [live], events: [toolEvent('tool/call', 'a', { name: 'bash' })],
  });
  assert.notEqual(before.blocks[0].id, after.blocks[1].id);
  assert.equal(tools(before)[0].id, tools(after)[0].id);
  assert.deepEqual(tools(after).map((row) => [row.callId, row.liveOutput]), [['a', 'live output']]);
  assert.equal(tools(after)[0].args, call('a').arguments);
});

test('persisted tool output wins over SSE replay and an out-of-order call fills missing metadata', () => {
  const history = [user(), result(3, 'a', { name: undefined, text: '', meta: { isError: true } }),
    answer(4, { toolCalls: [call('a')] }), answer(4, { toolCalls: [call('a')] })];
  const [{ blocks }] = groupDirectMessages('s', '', history, {
    isLive: true, events: [toolEvent('tool/result', 'a', { output: 'abbreviated', isError: false })],
    liveToolOutputs: [{ turnId: 't1', callId: 'a', name: 'bash', text: 'stale' }],
  });
  assert.equal(blocks[0].items.length, 1);
  assert.equal(blocks[0].items[0].name, 'bash');
  assert.equal(blocks[0].items[0].args, call('a').arguments);
  assert.equal(blocks[0].items[0].output, '');
  assert.equal(blocks[0].items[0].status, 'failed');
  assert.equal(blocks[0].items[0].liveOutput, undefined);
});

test('tool events can fill the durable result while history refreshes, during a streamed message', () => {
  const [exchange] = groupDirectMessages('s', '', [user(), answer(2, { toolCalls: [call('a'), call('b')] })], {
    isLive: true,
    liveStream: { turnId: 't1', text: 'Drafting my response…', reasoning: '' },
    liveToolOutputs: [{ turnId: 't1', callId: 'b', name: 'bash', text: 'still printing' }],
    events: [toolEvent('tool/result', 'a', { output: 'result', durationMs: 73 })],
  });
  assert.deepEqual(tools(exchange).map((row) => [row.callId, row.status, row.output, row.liveOutput]), [
    ['a', 'completed', 'result', undefined], ['b', 'running', undefined, 'still printing'],
  ]);
  assert.equal(tools(exchange)[0].durationMs, 73);
  assert.equal(messages(exchange)[0].live, true);
});

test('a steering message and an interleaved Swarm command do not duplicate a tool or steal live progress', () => {
  const steer = { ...user(4), text: 'A clarification', meta: { steering: true } };
  const swarm = { swarmAction: 'start', runId: 'swarm-1' };
  const history = [user(), answer(2, { toolCalls: [call('a')] }), steer,
    { cursor: 5, type: 'user/message', text: '/swarm something', meta: swarm },
    { cursor: 6, type: 'assistant/message', text: 'Swarm started', meta: swarm },
    result(7, 'a')];
  const [first, second, command] = groupDirectMessages('s', '', history, {
    isLive: true, liveStream: { turnId: 't1', reasoning: '', text: 'Continuing' },
  });
  assert.notEqual(first.key, second.key);
  assert.deepEqual(tools(first).map((row) => [row.callId, row.status]), [['a', 'completed']]);
  assert.equal(tools(second).length, 0);
  assert.equal(second.active, true);
  assert.equal(messages(second)[0].text, 'Continuing');
  assert.equal(messages(command)[0].text, 'Swarm started');
  assert.equal(command.swarmRunId, swarm.runId);
});

test('equal call IDs in distinct turns never share output, status, or presentation identity', () => {
  const [first, second] = groupDirectMessages('s', '', [user(), answer(2, { toolCalls: [call('same')] }),
    result(3, 'same'), user(4, 't2'), answer(5, { turnId: 't2', toolCalls: [call('same')] })], {
    isLive: true, liveToolOutputs: [{ turnId: 't2', callId: 'same', name: 'bash', text: 'second turn' }],
  });
  assert.notEqual(tools(first)[0].id, tools(second)[0].id);
  assert.equal(tools(first)[0].output, 'output');
  assert.equal(tools(second)[0].liveOutput, 'second turn');
  assert.equal(tools(second)[0].output, undefined);
});

test('a new history turn activates before its start event arrives, without reviving ended turns', () => {
  const [previous, current] = groupDirectMessages('s', '', [user(), user(2, 't2')], {
    isLive: true, events: [event('turn/started', 1000), event('turn/completed', 1800)],
  });
  assert.equal(previous.active, undefined);
  assert.equal(current.active, true);
});

test('a restarted parked turn keeps its identity and resumes its elapsed timer', () => {
  const parked = [event('turn/started', 1000), event('turn/parked', 1800)];
  const [before] = groupDirectMessages('s', '', [user()], { events: parked });
  const [after] = groupDirectMessages('s', '', [user()], {
    isLive: true, events: [...parked, event('turn/started', 9500)],
  });
  assert.equal(before.key, after.key);
  assert.equal(before.timing.end, 'turn/parked');
  assert.equal(after.active, true);
  assert.deepEqual(after.timing, { startedAt: 9500 });
});


test('display unwraps the runtime envelope and separates the shell exit prefix from stdout', () => {
  const body = 'exitCode: 7\nstdout:\nexitCode: 99\nstderr:\nfailed';
  const region = `${'a'.repeat(32)}-tool-bash-1`;
  const output = `[NON_ZERO_EXIT]\n<untrusted id="${region}" bytes="${body.length}">${body}</untrusted id="${region}">`;
  assert.deepEqual(directToolOutput({ name: 'bash', output }), {
    output: '[NON_ZERO_EXIT]\nstdout:\nexitCode: 99\nstderr:\nfailed', exitCode: 7,
  });
  assert.deepEqual(directToolOutput({ name: 'bash', output: 'exitCode: 0' }), { output: '', exitCode: 0 });
  assert.deepEqual(directToolOutput({ name: 'mcp__server__tool', output: 'exitCode: 0' }), { output: 'exitCode: 0', exitCode: undefined });
});

test('structured exit codes are scoped by turn and override the display prefix', () => {
  const [exchange] = groupDirectMessages('s', '', [user(), answer(2, { toolCalls: [call('a')] }),
    result(3, 'a', { text: 'exitCode: 7\nstdout:\nshell result', meta: { isError: true } })], {
    events: [toolEvent('tool/receipt', 'a', { exitCode: 8 }, 't2'), toolEvent('tool/receipt', 'a', { exitCode: 2 })],
  });
  const [tool] = tools(exchange);
  assert.equal(tool.status, 'failed');
  assert.deepEqual(directToolOutput(tool), { output: 'stdout:\nshell result', exitCode: 2 });
});
