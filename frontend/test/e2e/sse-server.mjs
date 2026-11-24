import { createServer } from 'node:http';
import { once } from 'node:events';

const items = (items = []) => ({ items });
const sessionPath = /^\/v1\/sessions\/([\w-]+)(?:\/(turns|messages|events|receipts|stream))?$/;
const collectionPaths = new Set([
  '/v1/approvals', '/v1/accounts', '/v1/memory', '/v1/usage', '/v1/schedules', '/v1/swarm/runs', '/v1/workspace/files',
]);
export const FIXED_TIME = Date.UTC(2026, 0, 15, 10, 0, 0);
const initialResponse = (i) => [
  `### Checkpoint ${i}`, '',
  'This is a protocol fixture, served only by the test process. The transcript records a review of the documentation workspace.',
  '', '1. Check the entry point and identify the relevant files.',
  '2. Describe the current behavior and the expected result.',
  '3. Record the result before moving to the next checkpoint.',
  '', `Checkpoint ${i} archived.`,
].join('\n');

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text || '{}');
}

function frame(event) {
  return `${event.seq ? `id: ${event.seq}\n` : ''}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function startFixture(workspaceRoot, token) {
  const sessions = new Map();
  const streams = new Set();
  const gates = new Map();
  const messageReads = new Map();
  let seq = 0;
  function addSession({ id = `session-${sessions.size + 1}`, title = 'Transcript review', model = 'fixture-model' } = {}) {
    const record = { id, title, model, workspaceRoot, createdAt: FIXED_TIME, archivedAt: null, state: 'idle' };
    const session = { record, turns: [], messages: [], events: [] };
    sessions.set(id, session);
    return session;
  }
  function event(session, type, data, ephemeral = false) {
    const sessionId = session.record.id;
    const ev = {
      seq: ephemeral ? 0 : ++seq,
      at: FIXED_TIME + seq * 1000,
      sessionId, type, data: { sessionId, ...data },
      ...(ephemeral ? { ephemeral: true } : {}),
    };
    if (!ephemeral) session.events.push(ev);
    for (const stream of streams) {
      if (!stream.sessionId || stream.sessionId === sessionId) stream.res.write(frame(ev));
    }
  }
  function message(session, turnId, fields) {
    const messageCursor = session.messages.length + 1;
    session.messages.push({ seq: messageCursor, turnId, ...fields });
    return messageCursor;
  }
  function begin(session, input) {
    const id = `${session.record.id}-turn-${session.turns.length + 1}`;
    const turn = { id, input, state: 'running', createdAt: FIXED_TIME + seq * 1000 };
    session.turns.unshift(turn);
    session.record.state = 'running';
    message(session, id, { role: 'user', content: input });
    event(session, 'turn/started', { turnId: id });
    return turn;
  }
  function finish(session, turn, { text = '', reason = 'completed', reasoning = '', legacy = false }) {
    if (text || reasoning) {
      const messageCursor = message(session, turn.id, { role: 'assistant', content: text, reasoning });
      event(session, 'assistant/message', { turnId: turn.id, text, ...(legacy ? {} : { messageCursor }) });
    }
    turn.state = session.record.state = reason;
    event(session, `turn/${reason}`, { turnId: turn.id, durationMs: 12_000 });
  }
  function reset({ count = 8, historyTool = false } = {}) {
    for (const gate of gates.values()) gate.res?.end();
    gates.clear();
    messageReads.clear();
    sessions.clear();
    seq = 0;
    const a = addSession({ id: 'transcript', title: 'Transcript review' });
    for (let i = 1; i <= count; i++) {
      const turn = begin(a, `Review checkpoint ${i}`);
      if (historyTool && i === count - 2) {
        const callId = `history-tool-${i}`;
        const command = 'printf "historical output\\n"';
        const output = Array.from({ length: 52 }, (_, j) => `Historical diagnostic ${j + 1}`).join('\n');
        message(a, turn.id, { role: 'assistant', content: '', toolCalls: [{ id: callId, name: 'bash', arguments: { command } }] });
        message(a, turn.id, { role: 'tool', content: output, toolCallId: callId, toolName: 'bash' });
      }
      finish(a, turn, { text: initialResponse(i) });
    }
    const b = addSession({ id: 'reference', title: 'Reference notes' });
    finish(b, begin(b, 'Summarize the reference notes'), { text: 'Reference session response.' });
  }
  reset();

  const server = createServer(async (req, res) => {
    const { pathname: path, searchParams: query } = new URL(req.url, 'http://127.0.0.1');
    try {
      if (path === '/v1/health') return send(res, 200, { ok: true, status: 'ok', routerReady: true, workspaceRoot });
      // Test controls exist only on this disposable loopback server, not on real Direct.
      if (path === '/__e2e/streams') return send(res, 200, { count: streams.size });
      if (req.method === 'POST' && path === '/__e2e/reset') {
        for (const stream of streams) stream.res.end();
        streams.clear();
        reset(await body(req));
        return send(res, 200, { ok: true });
      }
      if (path === '/__e2e/reads') return send(res, 200, { count: messageReads.get(query.get('id') ?? 'transcript') ?? 0 });
      if (path === '/__e2e/gate' && req.method === 'POST') {
        const { label, id = 'transcript', status = 200 } = await body(req);
        if (gates.has(label)) return send(res, 409, { error: 'Duplicate fixture gate' });
        gates.set(label, { id, status });
        return send(res, 200, { ok: true });
      }
      if (path === '/__e2e/gate' && req.method === 'GET') {
        return send(res, 200, { waiting: Boolean(gates.get(query.get('label'))?.res) });
      }
      if (path === '/__e2e/release' && req.method === 'POST') {
        const { label } = await body(req);
        const gate = gates.get(label);
        if (!gate?.res) return send(res, 409, { error: 'No pending fixture gate' });
        gates.delete(label);
        if (!gate.res.destroyed) send(gate.res, gate.status, gate.status === 200 ? gate.snapshot : { error: { code: 'FIXTURE_DELAYED_FAILURE' } });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/__e2e/advance') {
        const { id = 'transcript', action, text, name = 'bash', callId = 'fixture-tool', reason, args, change, legacy } = await body(req);
        const session = sessions.get(id);
        const turn = session?.turns[0];
        if (!turn || turn.state !== 'running') return send(res, 409, { error: 'No running fixture turn' });
        const turnId = turn.id;
        switch (action) {
          case 'assistant/delta': case 'reasoning/delta':
            event(session, action, { turnId, delta: text }, true); break;
          case 'tool/call': {
            const toolArgs = args ?? { command: 'printf "fixture output\\n"' };
            message(session, turnId, { role: 'assistant', content: '', toolCalls: [{ id: callId, name, arguments: toolArgs }] });
            event(session, action, { turnId, callId, name, arguments: toolArgs }); break;
          }
          case 'tool/output':
            event(session, action, { turnId, callId, name, chunk: text }, true); break;
          case 'tool/result':
            if (change) event(session, 'file/changed', { turnId, callId, ...change });
            message(session, turnId, { role: 'tool', content: text, toolCallId: callId, toolName: name });
            event(session, action, { turnId, callId, name, output: text, isError: false }); break;
          case 'burst':
            for (let step = 0; step < 30; step++) event(session, 'turn/phase_changed', { turnId, phase: 'running', step });
            break;
          case 'finish': finish(session, turn, { text, reason, legacy }); break;
          default: return send(res, 400, { error: 'Unknown fixture action' });
        }
        return send(res, 200, { ok: true });
      }
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: { code: 'UNAUTHORIZED' } });
      const match = sessionPath.exec(path);
      const session = match && sessions.get(match[1]);
      if (match && !session) return send(res, 404, { error: { code: 'NOT_FOUND' } });
      if (req.method === 'GET') {
        if (path === '/v1/stream' || match?.[2] === 'stream') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
          });
          const stream = { res, sessionId: session?.record.id };
          streams.add(stream);
          res.on('close', () => streams.delete(stream));
          res.write(': connected\n\n');
          const after = Number(query.get('after') ?? req.headers['last-event-id'] ?? 0);
          const events = session ? session.events : [...sessions.values()].flatMap((s) => s.events).sort((a, b) => a.seq - b.seq);
          for (const ev of events) if (ev.seq > after) res.write(frame(ev));
          return;
        }
        if (path === '/v1/sessions') return send(res, 200, items([...sessions.values()].map((s) => s.record)));
        if (session) {
          const kind = match[2];
          if (!kind) return send(res, 200, session.record);
          const entries = (session[kind] ?? []).filter((e) => !e.seq || e.seq > Number(query.get('after')));
          const result = items(entries.slice(0, Number(query.get('limit') ?? 200)));
          if (kind === 'messages') {
            const id = session.record.id;
            messageReads.set(id, (messageReads.get(id) ?? 0) + 1);
            const gate = [...gates.values()].find((candidate) => candidate.id === id && !candidate.res);
            if (gate) {
              // Snapshot at request acceptance, *not* when the delayed response is released.
              gate.snapshot = structuredClone(result);
              gate.res = res;
              return;
            }
          }
          return send(res, 200, result);
        }
        if (path === '/v1/models') return send(res, 200, { defaultModel: 'fixture-model', items: [{ alias: 'fixture-model', targets: [{ model: 'fixture-model', provider: 'custom-openai' }] }] });
        if (path === '/v1/observability/metrics') return send(res, 200, {});
        if (path === '/v1/providers/presets') return send(res, 200, { categories: [], items: [] });
        if (path === '/v1/providers/health') return send(res, 200, { routerReady: true, items: [] });
        if (path === '/v1/git/status') return send(res, 200, { isRepo: false, branches: [], changes: [] });
        if (path === '/v1/workspace') return send(res, 200, { workspaceRoot });
        if (collectionPaths.has(path)) return send(res, 200, items());
      }
      if (req.method === 'POST' && path === '/v1/sessions') return send(res, 200, addSession(await body(req)).record);
      if (req.method === 'POST' && match?.[2] === 'turns') {
        const input = (await body(req)).input;
        return send(res, 200, { session: session.record, turn: begin(session, input) });
      }
      return send(res, 404, { error: { code: 'UNHANDLED_FIXTURE_ROUTE' } });
    } catch {
      if (!res.headersSent) send(res, 500, { error: { code: 'FIXTURE_ERROR' } });
      else res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      for (const stream of streams) stream.res.end();
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}
