import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

// The vendor always streams, including for a non-streaming caller. Decode whole
// SSE events (not network chunks); cancellation propagates to the upstream body.
async function* events(body) {
  let buf = '',
    event = '',
    data = [];
  for await (const piece of body.pipeThrough(new TextDecoderStream())) {
    buf += piece;
    let end;
    while ((end = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, end).replace(/\r$/, '');
      buf = buf.slice(end + 1);
      if (line.startsWith('event:')) {
        if (data.length) yield [event, data.join('\n')];
        data = [];
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      else if (!line) {
        if (data.length || event) yield [event, data.join('\n')];
        event = '';
        data = [];
      }
    }
  }
  if (buf.startsWith('data:')) data.push(buf.slice(5).trimStart());
  if (data.length || event) yield [event, data.join('\n')];
}
async function* chunks(res, model) {
  const base = {
    id: 'chatcmpl-' + randomUUID(),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const chunk = (delta, finish_reason = null) => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason }],
  });
  yield chunk({ role: 'assistant' });
  let tool = false;
  for await (const [event, data] of events(res.body)) {
    let v = data && data !== '[DONE]' ? JSON.parse(data) : {};
    if (typeof v === 'string') v = JSON.parse(v);
    const name = String(event || v.event || v.type || '')
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/-/g, '_')
      .toLowerCase();
    if (name === 'error' || v.error || Number(v.code) > 0)
      throw new Error('Trae 上游返回错误');
    if (
      data === '[DONE]' ||
      ['done', 'response_done', 'stream_done'].includes(name)
    ) {
      const reason =
        v.finish_reason || v.stop_reason || (tool ? 'tool_calls' : 'stop');
      yield chunk(
        {},
        ['max_tokens', 'max_length', 'max_output_tokens'].includes(reason)
          ? 'length'
          : reason,
      );
      return;
    }
    if (name === 'token_usage') {
      yield { ...base, choices: [], usage: v.usage || v };
      continue;
    }
    const d = v.delta || v,
      content = v.response ?? d.content ?? v.text,
      reasoning = d.reasoning_content ?? d.reasoning;
    const raw = d.tool_calls,
      calls =
        raw &&
        (Array.isArray(raw) ? raw : [raw]).map((c, i) => {
          const f = c.function_call || c.function || {};
          return {
            index: c.index ?? i,
            ...(c.id && { id: c.id }),
            type: 'function',
            function: {
              ...(f.name && { name: f.name }),
              arguments:
                typeof f.arguments === 'string'
                  ? f.arguments
                  : f.arguments == null
                    ? ''
                    : JSON.stringify(f.arguments),
            },
          };
        });
    if (calls) tool = true;
    if (content || reasoning || calls)
      yield chunk({
        ...(typeof content === 'string' && { content }),
        ...(reasoning && { reasoning_content: reasoning }),
        ...(calls && { tool_calls: calls }),
      });
  }
  throw new Error('Trae 上游流在完成前断开');
}
export async function traeCompletion(res, model, stream) {
  if (!res.headers.get('content-type')?.includes('event-stream')) {
    await res.body?.cancel();
    throw new Error('Trae 未返回事件流');
  }
  const source = chunks(res, model);
  if (stream) {
    async function* wire() {
      for await (const c of source)
        yield Buffer.from(`data: ${JSON.stringify(c)}\n\n`);
      yield Buffer.from('data: [DONE]\n\n');
    }
    return new Response(Readable.toWeb(Readable.from(wire())), {
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  const message = { role: 'assistant', content: '' },
    calls = [];
  let base, finish, usage;
  for await (const c of source) {
    base = c;
    if (c.usage) usage = c.usage;
    const choice = c.choices[0];
    if (!choice) continue;
    const d = choice.delta;
    message.content += d.content || '';
    if (d.reasoning_content)
      message.reasoning_content =
        (message.reasoning_content || '') + d.reasoning_content;
    for (const delta of d.tool_calls || []) {
      const t = (calls[delta.index] ??= {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      });
      if (delta.id) t.id = delta.id;
      t.function.name += delta.function?.name || '';
      t.function.arguments += delta.function?.arguments || '';
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (calls.length) message.tool_calls = calls;
  return Response.json({
    ...base,
    object: 'chat.completion',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  });
}
