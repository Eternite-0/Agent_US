// Lightweight zero-dependency reverse-proxy protocol translator & native Copilot token exchange.
// Enables Agent_US (single process on :8787) to route & reverse-proxy both
// OpenAI (/v1/chat/completions) and Anthropic (/v1/messages) traffic across
// heterogeneous upstreams without any external gateway sidecar.

const COPILOT_DEFAULT_HEADERS = {
  'Copilot-Integration-Id': 'vscode-chat',
  'Editor-Version': 'vscode/1.99.0',
  'Editor-Plugin-Version': 'copilot-chat/0.26.0',
  'Openai-Intent': 'conversation-panel',
};

const GITHUB_OAUTH_TOKEN_RE = /^(ghu_|gho_|ghp_|github_pat_)/;

/**
 * Resolves effective upstream endpoint/token/headers for a route.
 * For `github-copilot` accounts storing a GitHub OAuth token (`ghu_`/`gho_`),
 * automatically exchanges and caches the short-lived Copilot bearer token in memory.
 */
export async function resolveEffectiveRoute(route, copilotCache, { signal } = {}) {
  if (
    route.preset !== 'github-copilot' ||
    !route.apiKey ||
    !GITHUB_OAUTH_TOKEN_RE.test(route.apiKey)
  ) {
    return route;
  }

  const cacheKey = route.accountId || route.apiKey.slice(0, 16);
  const now = Date.now();
  const cached = copilotCache?.get(cacheKey);
  if (cached && cached.expiresAt - 60_000 > now) {
    return {
      ...route,
      endpoint: cached.endpoint,
      apiKey: cached.token,
      customHeaders: { ...COPILOT_DEFAULT_HEADERS, ...route.customHeaders },
    };
  }

  const tokenEndpoint =
    process.env.GITHUB_COPILOT_TOKEN_URL ||
    'https://api.github.com/copilot_internal/v2/token';
  const res = await fetch(tokenEndpoint, {
    headers: {
      Accept: 'application/json',
      Authorization: `token ${route.apiKey}`,
      'User-Agent': 'Agent-US/1.0',
      ...COPILOT_DEFAULT_HEADERS,
    },
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`GitHub Copilot token exchange failed (HTTP ${res.status}): ${txt.slice(0, 200)}`),
      { status: res.status },
    );
  }
  const data = await res.json();
  const copilotToken = String(data?.token || '').trim();
  if (!copilotToken) {
    throw new Error('GitHub Copilot token exchange returned empty token');
  }
  const endpoint = String(
    data?.endpoints?.api || route.endpoint || 'https://api.githubcopilot.com',
  ).replace(/\/+$/, '');
  const expiresAt = data?.expires_at
    ? Number(data.expires_at) * 1000
    : now + 25 * 60 * 1000;

  copilotCache?.set(cacheKey, { token: copilotToken, endpoint, expiresAt });
  return {
    ...route,
    endpoint,
    apiKey: copilotToken,
    customHeaders: { ...COPILOT_DEFAULT_HEADERS, ...route.customHeaders },
  };
}

// ============================================================================
// OpenAI Chat Completions  -->  Anthropic Messages
// ============================================================================

function parseDataUrl(url) {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(String(url || ''));
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

function openaiContentToAnthropicBlocks(content) {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: String(part.text) });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: parsed.mediaType,
            data: parsed.data,
          },
        });
      } else {
        blocks.push({
          type: 'image',
          source: { type: 'url', url: String(part.image_url.url) },
        });
      }
    }
  }
  return blocks;
}

export function openaiRequestToAnthropic(body, wireModel) {
  const sysParts = [];
  const messages = [];
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') {
      const txt =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((p) => p?.type === 'text')
                .map((p) => p.text)
                .join('\n')
            : '';
      if (txt) sysParts.push(txt);
      continue;
    }
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id || 'tool_call',
        content:
          typeof m.content === 'string'
            ? m.content
            : JSON.stringify(m.content ?? ''),
      };
      const prev = messages.at(-1);
      if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
        prev.content.push(block);
      } else {
        messages.push({ role: 'user', content: [block] });
      }
      continue;
    }
    const blocks = openaiContentToAnthropicBlocks(m.content);
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: tc.id || `toolu_${Date.now()}`,
          name: tc.function?.name || 'tool',
          input,
        });
      }
    }
    if (!blocks.length) blocks.push({ type: 'text', text: ' ' });
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const prev = messages.at(-1);
    if (prev && prev.role === role && Array.isArray(prev.content)) {
      prev.content.push(...blocks);
    } else {
      messages.push({ role, content: blocks });
    }
  }

  const tools = Array.isArray(body?.tools)
    ? body.tools
        .filter((t) => t?.type === 'function' && t.function?.name)
        .map((t) => ({
          name: t.function.name,
          description: t.function.description || '',
          input_schema: t.function.parameters || { type: 'object', properties: {} },
        }))
    : undefined;

  return {
    model: wireModel,
    max_tokens: Number(body?.max_completion_tokens ?? body?.max_tokens ?? 8192),
    ...(sysParts.length ? { system: sysParts.join('\n\n') } : {}),
    messages,
    ...(tools?.length ? { tools } : {}),
    ...(body?.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body?.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(Array.isArray(body?.stop)
      ? { stop_sequences: body.stop }
      : typeof body?.stop === 'string'
        ? { stop_sequences: [body.stop] }
        : {}),
    stream: Boolean(body?.stream),
  };
}

function mapAnthropicStopReason(reason) {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return 'stop';
}

export function anthropicJsonToOpenai(anth, requestedModel) {
  const blocks = Array.isArray(anth?.content) ? anth.content : [];
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  for (const b of blocks) {
    if (b?.type === 'text') content += b.text || '';
    else if (b?.type === 'thinking') reasoning += b.thinking || '';
    else if (b?.type === 'tool_use') {
      toolCalls.push({
        id: b.id || `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: b.name || '',
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    }
  }
  const promptTokens = anth?.usage?.input_tokens ?? 0;
  const completionTokens = anth?.usage?.output_tokens ?? 0;
  return {
    id: anth?.id ? `chatcmpl-${anth.id}` : `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || anth?.model || 'claude',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || (toolCalls.length ? null : ''),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapAnthropicStopReason(anth?.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export function anthropicSseToOpenaiStream(anthBody, requestedModel) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = requestedModel || 'claude';

  return new ReadableStream({
    async start(controller) {
      const reader = anthBody.getReader();
      let buffer = '';
      let sentRole = false;
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason = 'end_turn';
      const toolIdxByBlock = new Map();
      let nextToolIdx = 0;

      const emit = (payload) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const ensureRole = () => {
        if (sentRole) return;
        sentRole = true;
        emit({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const dataLines = frame
              .split(/\r?\n/)
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim());
            if (!dataLines.length) continue;
            let ev;
            try {
              ev = JSON.parse(dataLines.join('\n'));
            } catch {
              continue;
            }
            if (ev.type === 'message_start') {
              inputTokens = ev.message?.usage?.input_tokens ?? 0;
              ensureRole();
            } else if (ev.type === 'content_block_start') {
              ensureRole();
              const cb = ev.content_block ?? {};
              if (cb.type === 'tool_use') {
                const tIdx = nextToolIdx++;
                toolIdxByBlock.set(ev.index ?? 0, tIdx);
                emit({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: tIdx,
                            id: cb.id || `call_${tIdx}`,
                            type: 'function',
                            function: { name: cb.name || '', arguments: '' },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                });
              }
            } else if (ev.type === 'content_block_delta') {
              ensureRole();
              const d = ev.delta ?? {};
              if (d.type === 'text_delta' && d.text) {
                emit({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: d.text }, finish_reason: null }],
                });
              } else if (d.type === 'thinking_delta' && d.thinking) {
                emit({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [
                    { index: 0, delta: { reasoning_content: d.thinking }, finish_reason: null },
                  ],
                });
              } else if (d.type === 'input_json_delta' && d.partial_json) {
                const tIdx = toolIdxByBlock.get(ev.index ?? 0) ?? 0;
                emit({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          { index: tIdx, function: { arguments: d.partial_json } },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                });
              }
            } else if (ev.type === 'message_delta') {
              if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
              if (ev.usage?.output_tokens !== undefined) {
                outputTokens = ev.usage.output_tokens;
              }
            }
          }
        }
        emit({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: mapAnthropicStopReason(stopReason),
            },
          ],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

// ============================================================================
// Anthropic Messages  -->  OpenAI Chat Completions
// ============================================================================

export function anthropicRequestToOpenai(body, wireModel) {
  const messages = [];
  if (typeof body?.system === 'string' && body.system.trim()) {
    messages.push({ role: 'system', content: body.system });
  } else if (Array.isArray(body?.system)) {
    const sysText = body.system
      .filter((b) => b?.type === 'text' && b.text)
      .map((b) => b.text)
      .join('\n\n');
    if (sysText) messages.push({ role: 'system', content: sysText });
  }

  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.content === 'string') {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    const textParts = [];
    const toolCalls = [];
    const toolResults = [];
    const images = [];

    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && b.text) textParts.push(b.text);
      else if (b.type === 'image' && b.source?.type === 'base64') {
        images.push({
          type: 'image_url',
          image_url: {
            url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}`,
          },
        });
      } else if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id || `call_${toolCalls.length}`,
          type: 'function',
          function: {
            name: b.name || '',
            arguments: JSON.stringify(b.input ?? {}),
          },
        });
      } else if (b.type === 'tool_result') {
        const resContent =
          typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((c) => (c?.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
              : JSON.stringify(b.content ?? '');
        toolResults.push({
          role: 'tool',
          tool_call_id: b.tool_use_id || 'tool_call',
          content: resContent,
        });
      }
    }

    for (const tr of toolResults) messages.push(tr);

    if (textParts.length || images.length || toolCalls.length) {
      const joined = textParts.join('\n');
      const content =
        images.length > 0 && m.role !== 'assistant'
          ? [...(joined ? [{ type: 'text', text: joined }] : []), ...images]
          : toolCalls.length && !joined
            ? null
            : joined;
      messages.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  const tools = Array.isArray(body?.tools)
    ? body.tools
        .filter((t) => t?.name)
        .map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description || '',
            parameters: t.input_schema || { type: 'object', properties: {} },
          },
        }))
    : undefined;

  return {
    model: wireModel,
    messages,
    ...(body?.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
    ...(body?.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body?.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(Array.isArray(body?.stop_sequences) && body.stop_sequences.length
      ? { stop: body.stop_sequences }
      : {}),
    ...(tools?.length ? { tools } : {}),
    stream: Boolean(body?.stream),
    ...(body?.stream ? { stream_options: { include_usage: true } } : {}),
  };
}

function mapOpenaiFinishReason(reason) {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls') return 'tool_use';
  return 'end_turn';
}

export function openaiJsonToAnthropic(oai, requestedModel) {
  const choice = oai?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  if (msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: String(msg.reasoning_content) });
  }
  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id || `toolu_${content.length}`,
        name: tc.function?.name || '',
        input,
      });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: oai?.id ? `msg_${oai.id}` : `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel || oai?.model || 'assistant',
    content,
    stop_reason: mapOpenaiFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: oai?.usage?.prompt_tokens ?? 0,
      output_tokens: oai?.usage?.completion_tokens ?? 0,
    },
  };
}

export function openaiSseToAnthropicStream(oaiBody, requestedModel) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const msgId = `msg_${Date.now()}`;
  const model = requestedModel || 'assistant';

  return new ReadableStream({
    async start(controller) {
      const reader = oaiBody.getReader();
      let buffer = '';
      let started = false;
      let nextBlockIndex = 0;
      let thinkingIndex = null;
      let textIndex = null;
      const toolBlockMap = new Map();
      let finishReason = 'stop';
      let inputTokens = 0;
      let outputTokens = 0;

      const emitEvent = (name, data) => {
        controller.enqueue(
          encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      const ensureStarted = () => {
        if (started) return;
        started = true;
        emitEvent('message_start', {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const dataLines = frame
              .split(/\r?\n/)
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim());
            if (!dataLines.length) continue;
            const joined = dataLines.join('\n');
            if (joined === '[DONE]') continue;
            let chunk;
            try {
              chunk = JSON.parse(joined);
            } catch {
              continue;
            }
            if (chunk.usage) {
              inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
              outputTokens = chunk.usage.completion_tokens ?? outputTokens;
            }
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            const d = choice.delta ?? {};
            const reasoningFrag = d.reasoning_content ?? d.reasoning ?? '';

            if (reasoningFrag) {
              ensureStarted();
              if (thinkingIndex === null) {
                thinkingIndex = nextBlockIndex++;
                emitEvent('content_block_start', {
                  type: 'content_block_start',
                  index: thinkingIndex,
                  content_block: { type: 'thinking', thinking: '' },
                });
              }
              emitEvent('content_block_delta', {
                type: 'content_block_delta',
                index: thinkingIndex,
                delta: { type: 'thinking_delta', thinking: reasoningFrag },
              });
            }

            if (d.content) {
              ensureStarted();
              if (textIndex === null) {
                textIndex = nextBlockIndex++;
                emitEvent('content_block_start', {
                  type: 'content_block_start',
                  index: textIndex,
                  content_block: { type: 'text', text: '' },
                });
              }
              emitEvent('content_block_delta', {
                type: 'content_block_delta',
                index: textIndex,
                delta: { type: 'text_delta', text: d.content },
              });
            }

            for (const tc of d.tool_calls ?? []) {
              ensureStarted();
              const k = tc.index ?? 0;
              let blkIdx = toolBlockMap.get(k);
              if (blkIdx === undefined) {
                blkIdx = nextBlockIndex++;
                toolBlockMap.set(k, blkIdx);
                emitEvent('content_block_start', {
                  type: 'content_block_start',
                  index: blkIdx,
                  content_block: {
                    type: 'tool_use',
                    id: tc.id || `toolu_${k}`,
                    name: tc.function?.name || '',
                    input: {},
                  },
                });
              }
              if (tc.function?.arguments) {
                emitEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: blkIdx,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: tc.function.arguments,
                  },
                });
              }
            }

            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
        }

        ensureStarted();
        for (let i = 0; i < nextBlockIndex; i++) {
          emitEvent('content_block_stop', { type: 'content_block_stop', index: i });
        }
        emitEvent('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: mapOpenaiFinishReason(finishReason),
            stop_sequence: null,
          },
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
        });
        emitEvent('message_stop', { type: 'message_stop' });
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}
