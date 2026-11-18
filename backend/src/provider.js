import OpenAI from 'openai';
import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { Fault } from './store.js';
const flatten = (blocks) =>
  blocks
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');
function messages(o) {
  return [
    ...(o.system ? [{ role: 'system', content: o.system }] : []),
    ...o.messages.map((m) => {
      const calls = m.content
        .filter((b) => b.type === 'tool-call')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: b.arguments },
        }));
      return {
        role: m.role,
        content: flatten(m.content),
        ...(m.role === 'tool' ? { tool_call_id: m.toolCallId } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
      };
    }),
  ];
}
function client(route) {
  return new OpenAI({
    apiKey: route.key,
    baseURL: route.endpoint,
    maxRetries: 0,
    timeout: 60000,
    defaultHeaders: attributionHeaders(),
    fetch: (url, opt) => fetch(url, { ...opt, redirect: 'error' }),
  });
}
export class ChatAdapter extends LlmAdapter {
  constructor(routes, notify = () => {}) {
    super();
    this.routes = routes;
    this.notify = notify;
  }
  async discover(route) {
    const page = await client(route).models.list({
      signal: AbortSignal.timeout(6000),
    });
    return page.data.map((m) => m.id);
  }
  async *stream(o) {
    const routes = this.routes(o.provider, o.model);
    let yielded = false;
    for (const r of routes) {
      try {
        for await (const chunk of this.read(r, o)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (e) {
        if (o.signal?.aborted || yielded)
          throw new Fault('PROVIDER_STREAM_INTERRUPTED', 502);
        this.notify('provider.failed', { provider: r.id });
      }
    }
    throw new Fault('PROVIDER_UNAVAILABLE', 503);
  }
  async *read(r, o) {
    const stream = await client(r).chat.completions.create(
      {
        model: r.wireModel ?? o.model,
        messages: messages(o),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: o.maxTokens,
        ...(o.tools?.length && {
          tools: o.tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
        }),
      },
      { signal: o.signal },
    );
    let text = '',
      reasoning = '',
      finish,
      bytes = 0;
    const blocks = new Map();
    const calls = new Map();
    for await (const frame of stream) {
      if (frame.usage)
        yield {
          type: 'usage',
          usage: {
            inputTokens: frame.usage.prompt_tokens,
            outputTokens: frame.usage.completion_tokens,
          },
        };
      const choice = frame.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      for (const [key, fragment] of [
        ['reasoning', d.reasoning_content],
        ['text', d.content],
      ]) {
        if (!fragment) continue;
        bytes += fragment.length;
        if (!blocks.has(key)) {
          blocks.set(key, blocks.size);
          yield { type: 'block-start', index: blocks.get(key), blockType: key };
        }
        if (key === 'text') text += fragment;
        else reasoning += fragment;
        yield {
          type: key === 'text' ? 'text-delta' : 'reasoning-delta',
          index: blocks.get(key),
          text: fragment,
        };
      }
      for (const call of d.tool_calls ?? []) {
        const key = 'call' + call.index;
        let item = calls.get(key);
        if (!item) {
          if (!call.id) throw Error('invalid tool id');
          item = { type: 'tool-call', id: call.id, name: '', arguments: '' };
          calls.set(key, item);
          blocks.set(key, blocks.size);
          yield {
            type: 'block-start',
            index: blocks.get(key),
            blockType: 'tool-call',
          };
        }
        item.name += call.function?.name ?? '';
        item.arguments += call.function?.arguments ?? '';
        bytes += (call.function?.arguments ?? '').length;
        yield {
          type: 'tool-call-delta',
          index: blocks.get(key),
          id: item.id,
          ...(call.function?.name && { name: call.function.name }),
          argumentsDelta: call.function?.arguments ?? '',
        };
      }
      if (bytes > 262144 || blocks.size > 64) throw Error('stream limit');
      finish = choice.finish_reason ?? finish;
    }
    if (!['stop', 'length', 'tool_calls'].includes(finish))
      throw Error('incomplete stream');
    for (const [key, index] of blocks)
      yield {
        type: 'block-end',
        index,
        block:
          key === 'text'
            ? { type: 'text', text }
            : key === 'reasoning'
              ? { type: 'reasoning', text: reasoning }
              : calls.get(key),
      };
    yield {
      type: 'finish',
      reason: {
        kind:
          finish === 'length'
            ? 'max-tokens'
            : finish === 'tool_calls'
              ? 'tool-calls'
              : 'stop',
      },
    };
  }
}
