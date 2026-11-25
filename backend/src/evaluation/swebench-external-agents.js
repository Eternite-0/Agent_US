import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  posix as posixPath,
  relative,
  resolve,
  sep,
} from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { estimateTokens } from '../context.js';
import { redactSecrets } from '../envelope.js';
import { mergeUsageSnapshot, normalizeProviderUsage } from '../observability/prompt-cache.js';
import { analyzeCommand } from '../tools/command-analyzer.js';
import { killProcessTree, sanitizeChildEnv } from '../tools/sandbox.js';
import {
  ANTI_CHEAT_GIT_SUBCOMMANDS,
  BLOCKED_GIT_FLAGS,
  DEFAULT_TESTBED_PATH,
  PY_CHEAT_GIT_CALL_RE,
  isAuthorizedSweBenchCommand,
  safeRmRf,
} from './swebench-docker.js';

export const EXTERNAL_SWEBENCH_ARMS = Object.freeze(
  new Set(['claude_code', 'codex_cli', 'mini_swe_agent']),
);

export const DEFAULT_TESTBED_SHIM_COMMANDS = Object.freeze([
  'python',
  'python3',
  'pytest',
  'py.test',
  'tox',
  'sphinx-build',
  'pip',
  'pip3',
  'flake8',
]);

const PLACEHOLDER_PROXY_KEY = 'sk-swebench-metering-proxy-placeholder';

const SHIM_DISALLOWED_GIT_SUBCOMMANDS = new Set([
  ...ANTI_CHEAT_GIT_SUBCOMMANDS,
  'log',
  'show',
  'shortlog',
  'blame',
  'rev-list',
  'whatchanged',
  'archive',
  'format-patch',
  'cherry',
  'merge-base',
  'range-diff',
]);

const SHIM_SAFE_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'ls-files',
  'grep',
  'rev-parse',
  'check-ignore',
  'diff-files',
  'diff-index',
]);

const SHIM_SAFE_GIT_CONFIG_KEYS = new Set([
  'core.quotepath',
  'color.ui',
  'core.preloadindex',
  'core.autocrlf',
  'status.showuntrackedfiles',
]);

const SHIM_GIT_CHEAT_ARG_RE =
  /^(?:--all|--branches(?:=.*)?|--tags(?:=.*)?|--remotes(?:=.*)?|--glob(?:=.*)?|--reflog|--indexed-objects)$/i;

const SHIM_DIRECT_GIT_INTERNALS_RE =
  /(?:^|[\\/\s])\.git[\\/]+(?:objects|refs|logs|packed-refs|info|hooks|shallow|fetch_head|orig_head)(?:[\\/]|$)/i;

/**
 * Returns true when an arm identifier represents a third-party external agent baseline.
 */
export function isExternalSweBenchArm(arm) {
  return EXTERNAL_SWEBENCH_ARMS.has(String(arm ?? '').trim().toLowerCase());
}

function round4(value) {
  return Number((Number(value) || 0).toFixed(4));
}

function safeCount(n) {
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function getNativeRealpath(targetPath) {
  const abs = resolve(String(targetPath));
  const fn = realpathSync.native ?? realpathSync;
  try {
    return fn(abs);
  } catch {
    return abs;
  }
}

/**
 * Derives canonical upstream OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`)
 * endpoints from a normalized or raw `SWEBENCH_ENDPOINT` URL.
 */
export function deriveUpstreamEndpoints(rawEndpoint) {
  const raw = String(rawEndpoint ?? '').trim();
  if (!raw) {
    throw new Error('SweBenchMeteringProxy requires a non-empty upstream endpoint URL');
  }

  let cleaned = raw.replace(/\/+$/, '');
  const fullPathSuffixRe = /\/(?:chat\/completions|responses|completions|messages)$/i;
  while (fullPathSuffixRe.test(cleaned)) {
    cleaned = cleaned.replace(fullPathSuffixRe, '').replace(/\/+$/, '');
  }

  let pathname = '';
  let hostname = '';
  try {
    const parsed = new URL(cleaned);
    pathname = parsed.pathname.replace(/\/+$/, '');
    hostname = parsed.hostname.toLowerCase();
  } catch {
    // Keep lexical fallback if a non-standard URL string was supplied
  }

  const openaiBase =
    !pathname && hostname !== 'api.githubcopilot.com'
      ? `${cleaned}/v1`
      : cleaned;
  const openaiChatUrl = `${openaiBase}/chat/completions`;
  const openaiResponsesUrl = `${openaiBase}/responses`;

  const anthropicBase = cleaned.replace(/\/v1$/i, '').replace(/\/+$/, '');
  const anthropicMessagesUrl = `${anthropicBase}/v1/messages`;

  return {
    normalizedBase: cleaned,
    openaiBase,
    openaiChatUrl,
    openaiResponsesUrl,
    anthropicMessagesUrl,
  };
}

function normalizeResponsesUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = safeCount(
    raw.input_tokens ?? raw.prompt_tokens,
  );
  const output = safeCount(
    raw.output_tokens ?? raw.completion_tokens,
  );
  const read = safeCount(
    raw.input_tokens_details?.cached_tokens ??
      raw.prompt_tokens_details?.cached_tokens ??
      raw.prompt_cache_hit_tokens ??
      raw.cache_read_input_tokens,
  );
  const write = safeCount(raw.cache_creation_input_tokens);
  const eligible = read != null && input != null && input >= read ? input : null;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    cacheEligibleInputTokens: eligible,
  };
}

function mergeAnthropicRawUsage(target, incoming) {
  if (!incoming || typeof incoming !== 'object') return target;
  for (const field of [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ]) {
    const val = safeCount(incoming[field]);
    if (val != null) {
      target[field] = Math.max(target[field] ?? 0, val);
    }
  }
  if (incoming.cache_creation && typeof incoming.cache_creation === 'object') {
    const curCc = target.cache_creation && typeof target.cache_creation === 'object'
      ? target.cache_creation
      : {};
    for (const sub of ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']) {
      const val = safeCount(incoming.cache_creation[sub]);
      if (val != null) {
        curCc[sub] = Math.max(curCc[sub] ?? 0, val);
      }
    }
    if (Object.keys(curCc).length > 0) {
      target.cache_creation = curCc;
    }
  }
  return target;
}

function finalizeAnthropicUsage(rawMerged) {
  if (!rawMerged || Object.keys(rawMerged).length === 0) return null;
  const copy = { ...rawMerged };
  const hasCacheRead = safeCount(copy.cache_read_input_tokens) != null;
  const hasCacheWrite =
    safeCount(copy.cache_creation_input_tokens) != null ||
    (copy.cache_creation &&
      (safeCount(copy.cache_creation.ephemeral_5m_input_tokens) != null ||
        safeCount(copy.cache_creation.ephemeral_1h_input_tokens) != null));
  if (hasCacheRead && !hasCacheWrite) {
    // Some OpenAI->Anthropic gateways report cache_read_input_tokens without cache_creation_input_tokens.
    copy.cache_creation_input_tokens = 0;
  }
  return normalizeProviderUsage('anthropic', copy);
}

async function readRequestBodyText(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function buildPassthroughResponseHeaders(upstreamHeaders) {
  const headers = {};
  const blocked = new Set([
    'transfer-encoding',
    'content-length',
    'content-encoding',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'upgrade',
  ]);
  upstreamHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!blocked.has(lower)) {
      headers[key] = value;
    }
  });
  return headers;
}

function extractChatMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
            return String(part.text ?? '');
          }
          return extractChatMessageText(part.text ?? part.content ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    return extractChatMessageText(content.text ?? content.content ?? '');
  }
  return '';
}

function convertResponsesRequestToChatCompletions(body, targetModel) {
  const messages = [];
  if (body?.instructions) {
    messages.push({ role: 'system', content: String(body.instructions) });
  }

  const input = body?.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'function_call') {
        const callId = String(item.call_id || item.id || `fc_${messages.length}`);
        const toolCall = {
          id: callId,
          type: 'function',
          function: {
            name: String(item.name || ''),
            arguments:
              typeof item.arguments === 'string'
                ? item.arguments
                : JSON.stringify(item.arguments ?? {}),
          },
        };
        const prev = messages.at(-1);
        if (prev && prev.role === 'assistant' && Array.isArray(prev.tool_calls)) {
          prev.tool_calls.push(toolCall);
        } else {
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [toolCall],
          });
        }
        continue;
      }
      if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: String(item.call_id || ''),
          content:
            typeof item.output === 'string'
              ? item.output
              : JSON.stringify(item.output ?? ''),
        });
        continue;
      }
      const role = item.role === 'developer' ? 'system' : String(item.role || 'user');
      messages.push({
        role,
        content: extractChatMessageText(item.content ?? item.text ?? ''),
      });
    }
  }

  if (messages.length === 0) {
    messages.push({ role: 'user', content: '' });
  }

  const out = {
    model: targetModel,
    messages,
    stream: false,
  };

  if (Array.isArray(body?.tools) && body.tools.length > 0) {
    const mappedTools = [];
    for (const t of body.tools) {
      if (!t || typeof t !== 'object') continue;
      if (t.type === 'function' && t.function) {
        mappedTools.push({ type: 'function', function: t.function });
      } else if (t.type === 'function' && t.name) {
        mappedTools.push({
          type: 'function',
          function: {
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            ...(t.parameters ? { parameters: t.parameters } : {}),
          },
        });
      }
    }
    if (mappedTools.length > 0) {
      out.tools = mappedTools;
    }
  }

  if (Number.isFinite(Number(body?.max_output_tokens))) {
    out.max_tokens = Math.trunc(Number(body.max_output_tokens));
  }
  if (body?.temperature != null && Number.isFinite(Number(body.temperature))) {
    out.temperature = Number(body.temperature);
  }
  if (body?.top_p != null && Number.isFinite(Number(body.top_p))) {
    out.top_p = Number(body.top_p);
  }
  return out;
}

function buildResponsesObjectFromChatCompletion(chatJson, targetModel, normalizedUsage) {
  const msg = chatJson?.choices?.[0]?.message ?? {};
  const output = [];
  const textContent = typeof msg.content === 'string' ? msg.content : extractChatMessageText(msg.content);
  const msgId = `msg_${Date.now().toString(36)}`;
  if (textContent) {
    output.push({
      id: msgId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: textContent, annotations: [] }],
    });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (let i = 0; i < msg.tool_calls.length; i++) {
      const tc = msg.tool_calls[i];
      const callId = String(tc?.id || `fc_${i}_${Date.now().toString(36)}`);
      output.push({
        id: callId,
        type: 'function_call',
        status: 'completed',
        call_id: callId,
        name: String(tc?.function?.name || ''),
        arguments: String(tc?.function?.arguments ?? '{}'),
      });
    }
  }

  const inTok = normalizedUsage?.inputTokens ?? 0;
  const outTok = normalizedUsage?.outputTokens ?? 0;
  const cachedTok = normalizedUsage?.cacheReadTokens ?? 0;

  return {
    id: String(chatJson?.id || `resp_${Date.now().toString(36)}`),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: targetModel,
    output,
    output_text: textContent || '',
    usage: {
      input_tokens: inTok,
      output_tokens: outTok,
      total_tokens: inTok + outTok,
      input_tokens_details: {
        cached_tokens: cachedTok,
      },
    },
  };
}

/**
 * Local loopback HTTP dual-protocol proxy that locks downstream model names to the target
 * benchmark model and meters non-streaming JSON & streaming SSE token/KV-cache telemetry
 * for external CLI agents (`claude_code`, `codex_cli`, `mini_swe_agent`).
 */
export class SweBenchMeteringProxy {
  constructor({
    targetModel,
    apiKey = '',
    endpoint,
    customHeaders = null,
    requestTimeoutMs = 300_000,
    fetchImpl = fetch,
  } = {}) {
    if (!targetModel || !String(targetModel).trim()) {
      throw new Error('SweBenchMeteringProxy requires targetModel');
    }
    this.targetModel = String(targetModel).trim();
    this.apiKey = String(apiKey ?? '').trim();
    const derived = deriveUpstreamEndpoints(endpoint);
    this.normalizedBase = derived.normalizedBase;
    this.openaiBase = derived.openaiBase;
    this.openaiChatUrl = derived.openaiChatUrl;
    this.openaiResponsesUrl = derived.openaiResponsesUrl;
    this.anthropicMessagesUrl = derived.anthropicMessagesUrl;
    this.customHeaders = customHeaders && typeof customHeaders === 'object' ? { ...customHeaders } : {};
    this.requestTimeoutMs = Math.max(1_000, Number(requestTimeoutMs) || 300_000);
    this.fetchImpl = fetchImpl;

    this.server = null;
    this.port = null;
    this.baseUrl = null;
    this.openaiBaseUrl = null;
    this.anthropicBaseUrl = null;
    this.resetMetrics();
  }

  resetMetrics() {
    this.metrics = {
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheEligibleInputTokens: null,
      cacheReportedRequests: 0,
      requests: [],
    };
  }

  getMetrics() {
    const m = this.metrics;
    const eligible = m.cacheEligibleInputTokens;
    const cacheStatus = eligible != null && eligible > 0 ? 'available' : 'missing';
    const cacheHitRate =
      eligible != null && eligible > 0
        ? round4(Math.min(1, m.cacheReadTokens / eligible))
        : null;
    return {
      steps: m.steps,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      totalTokens: m.inputTokens + m.outputTokens,
      cacheReadTokens: m.cacheReadTokens,
      cacheWriteTokens: m.cacheWriteTokens,
      cacheEligibleInputTokens: eligible,
      cacheReportedRequests: m.cacheReportedRequests,
      cacheStatus,
      cacheHitRate,
      requests: m.requests.map((r) => ({ ...r })),
    };
  }

  #recordRequestMetric({ path, originalModel, statusCode, stream, usage }) {
    this.metrics.steps += 1;
    const inTok = safeCount(usage?.inputTokens) ?? 0;
    const outTok = safeCount(usage?.outputTokens) ?? 0;
    const crTok = safeCount(usage?.cacheReadTokens) ?? 0;
    const cwTok = safeCount(usage?.cacheWriteTokens) ?? 0;
    const eligibleTok = safeCount(usage?.cacheEligibleInputTokens);

    this.metrics.inputTokens += inTok;
    this.metrics.outputTokens += outTok;
    this.metrics.cacheReadTokens += crTok;
    this.metrics.cacheWriteTokens += cwTok;
    if (eligibleTok != null) {
      this.metrics.cacheReportedRequests += 1;
      this.metrics.cacheEligibleInputTokens =
        (this.metrics.cacheEligibleInputTokens ?? 0) + eligibleTok;
    }

    this.metrics.requests.push({
      path,
      originalModel: originalModel ?? null,
      forwardedModel: this.targetModel,
      statusCode,
      stream: Boolean(stream),
      inputTokens: inTok,
      outputTokens: outTok,
      cacheReadTokens: crTok,
      cacheWriteTokens: cwTok,
      cacheEligibleInputTokens: eligibleTok,
    });
  }

  async start() {
    if (this.server) return this;
    this.server = createServer((req, res) => {
      this.#handleHttpRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
        }
        if (!res.writableEnded) {
          res.end(
            JSON.stringify({
              error: {
                type: 'proxy_error',
                message: redactSecrets(String(err?.message || err || 'Upstream proxy error')),
              },
            }),
          );
        }
      });
    });

    await new Promise((resolveStart, rejectStart) => {
      this.server.once('error', rejectStart);
      this.server.listen(0, '127.0.0.1', () => {
        this.server?.off?.('error', rejectStart);
        resolveStart();
      });
    });

    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : null;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.openaiBaseUrl = `${this.baseUrl}/v1`;
    this.anthropicBaseUrl = this.baseUrl;
    return this;
  }

  async stop() {
    const srv = this.server;
    if (!srv) return;
    this.server = null;
    try {
      srv.closeAllConnections?.();
    } catch {
      // Ignore closeAllConnections unsupported errors
    }
    await new Promise((resolveStop) => {
      srv.close(() => resolveStop());
    });
  }

  async #handleHttpRequest(req, res) {
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = urlObj.pathname.replace(/\/+$/, '') || '/';
    const method = String(req.method || 'GET').toUpperCase();

    if (method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: this.targetModel, object: 'model', created: 0, owned_by: 'swebench-proxy' }],
        }),
      );
      return;
    }

    if (method === 'POST' && pathname === '/v1/messages/count_tokens') {
      const rawBody = await readRequestBodyText(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: Math.max(1, estimateTokens(rawBody)) }));
      return;
    }

    if (method === 'POST' && pathname === '/api/event_logging/batch') {
      await readRequestBodyText(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }

    if (method === 'POST' && (pathname === '/v1/messages' || pathname === '/messages')) {
      await this.#forwardAnthropicMessages(req, res, urlObj.search || '');
      return;
    }

    if (
      method === 'POST' &&
      (pathname === '/v1/chat/completions' || pathname === '/chat/completions')
    ) {
      await this.#forwardOpenAiChatCompletions(req, res);
      return;
    }

    if (method === 'POST' && (pathname === '/v1/responses' || pathname === '/responses')) {
      await this.#handleOpenAiResponses(req, res);
      return;
    }

    await readRequestBodyText(req);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'not_found', message: `Unsupported proxy route: ${method} ${pathname}` } }));
  }

  async #forwardAnthropicMessages(req, res, search) {
    const rawBody = await readRequestBodyText(req);
    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON body' } }));
      return;
    }

    const originalModel = body.model ?? null;
    body.model = this.targetModel;

    const upstreamHeaders = {
      'content-type': 'application/json',
      'anthropic-version': String(req.headers['anthropic-version'] || '2023-06-01'),
      ...this.customHeaders,
    };
    if (req.headers['anthropic-beta']) {
      upstreamHeaders['anthropic-beta'] = String(req.headers['anthropic-beta']);
    }
    if (this.apiKey) {
      upstreamHeaders['x-api-key'] = this.apiKey;
      upstreamHeaders.authorization = `Bearer ${this.apiKey}`;
    }

    const targetUrl = search ? `${this.anthropicMessagesUrl}${search}` : this.anthropicMessagesUrl;
    const upstreamRes = await this.fetchImpl(targetUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    const contentType = String(upstreamRes.headers.get('content-type') || '');
    const isSse = contentType.toLowerCase().includes('text/event-stream') && upstreamRes.body;
    const respHeaders = buildPassthroughResponseHeaders(upstreamRes.headers);
    if (!respHeaders['content-type']) {
      respHeaders['content-type'] = isSse ? 'text/event-stream; charset=utf-8' : 'application/json';
    }
    res.writeHead(upstreamRes.status, respHeaders);

    if (isSse) {
      const rawAnthropic = {};
      const decoder = new TextDecoder('utf-8');
      let lineBuf = '';
      const reader = upstreamRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            res.write(Buffer.from(value));
            lineBuf += decoder.decode(value, { stream: true });
            const lines = lineBuf.split(/\r?\n/);
            lineBuf = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const payload = trimmed.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const parsed = JSON.parse(payload);
                if (parsed?.message?.usage) mergeAnthropicRawUsage(rawAnthropic, parsed.message.usage);
                if (parsed?.usage) mergeAnthropicRawUsage(rawAnthropic, parsed.usage);
              } catch {
                // Ignore partial/non-JSON SSE data lines
              }
            }
          }
        }
        lineBuf += decoder.decode();
        if (lineBuf.trim().startsWith('data:')) {
          const payload = lineBuf.trim().slice(5).trim();
          if (payload && payload !== '[DONE]') {
            try {
              const parsed = JSON.parse(payload);
              if (parsed?.message?.usage) mergeAnthropicRawUsage(rawAnthropic, parsed.message.usage);
              if (parsed?.usage) mergeAnthropicRawUsage(rawAnthropic, parsed.usage);
            } catch {
              // Ignore trailing parse issue
            }
          }
        }
      } finally {
        if (!res.writableEnded) res.end();
      }
      this.#recordRequestMetric({
        path: '/v1/messages',
        originalModel,
        statusCode: upstreamRes.status,
        stream: true,
        usage: finalizeAnthropicUsage(rawAnthropic),
      });
      return;
    }

    const text = await upstreamRes.text();
    res.end(text);
    let usage = null;
    try {
      const parsed = JSON.parse(text);
      usage = finalizeAnthropicUsage(parsed?.usage);
    } catch {
      usage = null;
    }
    this.#recordRequestMetric({
      path: '/v1/messages',
      originalModel,
      statusCode: upstreamRes.status,
      stream: false,
      usage,
    });
  }

  async #forwardOpenAiChatCompletions(req, res) {
    const rawBody = await readRequestBodyText(req);
    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON body' } }));
      return;
    }

    const originalModel = body.model ?? null;
    body.model = this.targetModel;
    const injectedIncludeUsage = Boolean(
      body.stream === true && body.stream_options?.include_usage === undefined,
    );
    if (injectedIncludeUsage) {
      body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
    }

    const headers = {
      'content-type': 'application/json',
      ...this.customHeaders,
    };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    let upstreamRes = await this.fetchImpl(this.openaiChatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (upstreamRes.status === 400 && injectedIncludeUsage) {
      const errText = await upstreamRes.text();
      if (/stream_options/i.test(errText)) {
        const retryBody = { ...body };
        if (retryBody.stream_options) {
          const { include_usage: _ignored, ...restStreamOpts } = retryBody.stream_options;
          if (Object.keys(restStreamOpts).length > 0) {
            retryBody.stream_options = restStreamOpts;
          } else {
            delete retryBody.stream_options;
          }
        }
        upstreamRes = await this.fetchImpl(this.openaiChatUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(retryBody),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } else {
        const respHeaders = buildPassthroughResponseHeaders(upstreamRes.headers);
        res.writeHead(upstreamRes.status, respHeaders);
        res.end(errText);
        this.#recordRequestMetric({
          path: '/v1/chat/completions',
          originalModel,
          statusCode: upstreamRes.status,
          stream: Boolean(body.stream),
          usage: null,
        });
        return;
      }
    }

    const contentType = String(upstreamRes.headers.get('content-type') || '');
    const isSse = contentType.toLowerCase().includes('text/event-stream') && upstreamRes.body;
    const respHeaders = buildPassthroughResponseHeaders(upstreamRes.headers);
    if (!respHeaders['content-type']) {
      respHeaders['content-type'] = isSse ? 'text/event-stream; charset=utf-8' : 'application/json';
    }
    res.writeHead(upstreamRes.status, respHeaders);

    if (isSse) {
      const merged = {};
      const decoder = new TextDecoder('utf-8');
      let lineBuf = '';
      const reader = upstreamRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            res.write(Buffer.from(value));
            lineBuf += decoder.decode(value, { stream: true });
            const lines = lineBuf.split(/\r?\n/);
            lineBuf = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const payload = trimmed.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const parsed = JSON.parse(payload);
                if (parsed?.usage) {
                  mergeUsageSnapshot(merged, normalizeProviderUsage('openai', parsed.usage));
                }
              } catch {
                // Ignore partial/non-JSON SSE data lines
              }
            }
          }
        }
        lineBuf += decoder.decode();
        if (lineBuf.trim().startsWith('data:')) {
          const payload = lineBuf.trim().slice(5).trim();
          if (payload && payload !== '[DONE]') {
            try {
              const parsed = JSON.parse(payload);
              if (parsed?.usage) {
                mergeUsageSnapshot(merged, normalizeProviderUsage('openai', parsed.usage));
              }
            } catch {
              // Ignore trailing parse issue
            }
          }
        }
      } finally {
        if (!res.writableEnded) res.end();
      }
      this.#recordRequestMetric({
        path: '/v1/chat/completions',
        originalModel,
        statusCode: upstreamRes.status,
        stream: true,
        usage: Object.keys(merged).length > 0 ? merged : null,
      });
      return;
    }

    const text = await upstreamRes.text();
    res.end(text);
    let usage = null;
    try {
      const parsed = JSON.parse(text);
      usage = normalizeProviderUsage('openai', parsed?.usage);
    } catch {
      usage = null;
    }
    this.#recordRequestMetric({
      path: '/v1/chat/completions',
      originalModel,
      statusCode: upstreamRes.status,
      stream: false,
      usage,
    });
  }

  async #handleOpenAiResponses(req, res) {
    const rawBody = await readRequestBodyText(req);
    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON body' } }));
      return;
    }

    const originalModel = body.model ?? null;
    body.model = this.targetModel;
    const headers = {
      'content-type': 'application/json',
      ...this.customHeaders,
    };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    let upstreamRes;
    try {
      upstreamRes = await this.fetchImpl(this.openaiResponsesUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      upstreamRes = null;
    }

    if (!upstreamRes || upstreamRes.status === 404 || upstreamRes.status === 405) {
      if (upstreamRes) {
        await upstreamRes.text().catch(() => {});
      }
      await this.#handleOpenAiResponsesChatFallback(body, originalModel, headers, res);
      return;
    }

    const contentType = String(upstreamRes.headers.get('content-type') || '');
    const isSse = contentType.toLowerCase().includes('text/event-stream') && upstreamRes.body;
    const respHeaders = buildPassthroughResponseHeaders(upstreamRes.headers);
    if (!respHeaders['content-type']) {
      respHeaders['content-type'] = isSse ? 'text/event-stream; charset=utf-8' : 'application/json';
    }
    res.writeHead(upstreamRes.status, respHeaders);

    if (isSse) {
      const merged = {};
      const decoder = new TextDecoder('utf-8');
      let lineBuf = '';
      const reader = upstreamRes.body.getReader();
      const consumeSseLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try {
          const parsed = JSON.parse(payload);
          const rawUsage = parsed?.response?.usage ?? parsed?.usage;
          if (rawUsage) {
            mergeUsageSnapshot(merged, normalizeResponsesUsage(rawUsage));
          }
        } catch {
          // Ignore partial/non-JSON SSE data lines
        }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            res.write(Buffer.from(value));
            lineBuf += decoder.decode(value, { stream: true });
            const lines = lineBuf.split(/\r?\n/);
            lineBuf = lines.pop() ?? '';
            for (const line of lines) {
              consumeSseLine(line);
            }
          }
        }
        lineBuf += decoder.decode();
        if (lineBuf.trim()) {
          consumeSseLine(lineBuf);
        }
      } finally {
        if (!res.writableEnded) res.end();
      }
      this.#recordRequestMetric({
        path: '/v1/responses',
        originalModel,
        statusCode: upstreamRes.status,
        stream: true,
        usage: Object.keys(merged).length > 0 ? merged : null,
      });
      return;
    }

    const text = await upstreamRes.text();
    res.end(text);
    let usage = null;
    try {
      const parsed = JSON.parse(text);
      usage = normalizeResponsesUsage(parsed?.usage ?? parsed?.response?.usage);
    } catch {
      usage = null;
    }
    this.#recordRequestMetric({
      path: '/v1/responses',
      originalModel,
      statusCode: upstreamRes.status,
      stream: false,
      usage,
    });
  }

  async #handleOpenAiResponsesChatFallback(body, originalModel, headers, res) {
    const wantStream = Boolean(body.stream);
    const chatPayload = convertResponsesRequestToChatCompletions(body, this.targetModel);

    const upstreamRes = await this.fetchImpl(this.openaiChatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(chatPayload),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    const text = await upstreamRes.text();
    if (!upstreamRes.ok) {
      const respHeaders = buildPassthroughResponseHeaders(upstreamRes.headers);
      if (!respHeaders['content-type']) respHeaders['content-type'] = 'application/json';
      res.writeHead(upstreamRes.status, respHeaders);
      res.end(text);
      this.#recordRequestMetric({
        path: '/v1/responses',
        originalModel,
        statusCode: upstreamRes.status,
        stream: wantStream,
        usage: null,
      });
      return;
    }

    let chatJson = {};
    try {
      chatJson = JSON.parse(text);
    } catch {
      chatJson = {};
    }
    const usage = normalizeProviderUsage('openai', chatJson?.usage);
    this.#recordRequestMetric({
      path: '/v1/responses',
      originalModel,
      statusCode: upstreamRes.status,
      stream: wantStream,
      usage,
    });

    const responseObj = buildResponsesObjectFromChatCompletion(chatJson, this.targetModel, usage);
    if (!wantStream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responseObj));
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
    const emitEvent = (eventName, dataObj) => {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify({ type: eventName, ...dataObj })}\n\n`);
    };
    const inProgress = { ...responseObj, status: 'in_progress', output: [], output_text: '' };
    emitEvent('response.created', { response: inProgress });
    emitEvent('response.in_progress', { response: inProgress });
    for (let idx = 0; idx < responseObj.output.length; idx++) {
      const item = responseObj.output[idx];
      if (item.type === 'message') {
        const textVal = item.content?.[0]?.text ?? '';
        emitEvent('response.output_item.added', {
          output_index: idx,
          item: { ...item, status: 'in_progress', content: [] },
        });
        emitEvent('response.content_part.added', {
          item_id: item.id,
          output_index: idx,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
        if (textVal) {
          emitEvent('response.output_text.delta', {
            item_id: item.id,
            output_index: idx,
            content_index: 0,
            delta: textVal,
          });
        }
        emitEvent('response.output_text.done', {
          item_id: item.id,
          output_index: idx,
          content_index: 0,
          text: textVal,
        });
        emitEvent('response.content_part.done', {
          item_id: item.id,
          output_index: idx,
          content_index: 0,
          part: item.content[0],
        });
        emitEvent('response.output_item.done', { output_index: idx, item });
      } else if (item.type === 'function_call') {
        emitEvent('response.output_item.added', {
          output_index: idx,
          item: { ...item, status: 'in_progress', arguments: '' },
        });
        emitEvent('response.function_call_arguments.delta', {
          item_id: item.id,
          output_index: idx,
          delta: item.arguments,
        });
        emitEvent('response.function_call_arguments.done', {
          item_id: item.id,
          output_index: idx,
          arguments: item.arguments,
        });
        emitEvent('response.output_item.done', { output_index: idx, item });
      }
    }
    emitEvent('response.completed', { response: responseObj });
    res.end();
  }
}

/**
 * Maps a host subdirectory `cwd` inside `workspaceRoot` to `/testbed[/rel]` and rewrites
 * host `workspaceRoot` path prefixes appearing in command arguments to `/testbed`.
 */
export function rewriteHostArgsForContainer(args = [], { workspaceRoot, cwd = workspaceRoot } = {}) {
  if (!workspaceRoot || !String(workspaceRoot).trim()) {
    throw new Error('rewriteHostArgsForContainer requires workspaceRoot');
  }
  const absRoot = resolve(String(workspaceRoot));
  const realRoot = getNativeRealpath(absRoot);
  const absCwd = resolve(String(cwd || absRoot));
  const realCwd = getNativeRealpath(absCwd);

  const checkRel = (base, target) => {
    const rel = relative(base, target);
    if (!rel) return '';
    if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel)) {
      return null;
    }
    return rel;
  };

  let rel = checkRel(realRoot, realCwd);
  if (rel === null) rel = checkRel(absRoot, absCwd);
  const posixRel = rel ? rel.split(/[\\/]/).filter(Boolean).join('/') : '';
  const containerCwd = posixRel ? posixPath.join('/testbed', posixRel) : '/testbed';

  const prefixSet = new Set([absRoot, realRoot, absRoot.replace(/\\/g, '/'), realRoot.replace(/\\/g, '/')]);
  const prefixes = [...prefixSet]
    .map((p) => p.replace(/[\\/]+$/, ''))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  const rewriteSingleArg = (rawArg) => {
    let val = String(rawArg ?? '');
    for (const prefix of prefixes) {
      const normalizedVal = process.platform === 'win32' ? val.replace(/\\/g, '/') : val;
      const normalizedPrefix = process.platform === 'win32' ? prefix.replace(/\\/g, '/') : prefix;
      const haystack = process.platform === 'win32' ? normalizedVal.toLowerCase() : normalizedVal;
      const needle = process.platform === 'win32' ? normalizedPrefix.toLowerCase() : normalizedPrefix;

      let out = '';
      let cursor = 0;
      let changed = false;
      while (cursor < normalizedVal.length) {
        const hitIdx = haystack.indexOf(needle, cursor);
        if (hitIdx === -1) {
          out += normalizedVal.slice(cursor);
          break;
        }
        const beforeCh = hitIdx > 0 ? normalizedVal[hitIdx - 1] : '';
        const afterIdx = hitIdx + needle.length;
        const afterCh = afterIdx < normalizedVal.length ? normalizedVal[afterIdx] : '';
        const validBoundaryBefore = hitIdx === 0 || /[\s"'=,:;]/.test(beforeCh);
        const validBoundaryAfter = afterIdx === normalizedVal.length || /[/\\:=,\s"']/.test(afterCh);
        if (!validBoundaryBefore || !validBoundaryAfter) {
          out += normalizedVal.slice(cursor, hitIdx + 1);
          cursor = hitIdx + 1;
          continue;
        }
        out += normalizedVal.slice(cursor, hitIdx);
        out += '/testbed';
        changed = true;
        // Consume optional trailing slashes cleanly and preserve rest of path normalized to POSIX '/'
        let restStart = afterIdx;
        while (restStart < normalizedVal.length && (normalizedVal[restStart] === '/' || normalizedVal[restStart] === '\\')) {
          out += '/';
          restStart++;
        }
        cursor = restStart;
      }
      if (changed) {
        // Normalize remaining path separators inside the argument relative to /testbed
        return out.replace(/\/testbed([/][^\s"':=,]*)?/g, (seg) => seg.replace(/\\/g, '/'));
      }
    }
    return val;
  };

  return {
    containerCwd,
    rewrittenArgs: (Array.isArray(args) ? args : []).map(rewriteSingleArg),
  };
}

function isPathInsideBase(candidatePath, basePath) {
  const realBase = getNativeRealpath(basePath);
  const realCand = getNativeRealpath(candidatePath);
  const rel = relative(realBase, realCand);
  return !(rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel));
}

/**
 * Validates `git` arguments invoked via the external CLI shim directory, enforcing the same
 * anti-cheat guarantees as `isAuthorizedSweBenchCommand` (blocking `log`, `show`, `fetch`,
 * `remote`, `tag`, `branch`, history inspection, and workspace-escaping `-C` / `--git-dir`).
 */
export function validateShimGitArgs(args = [], { workspaceRoot = process.cwd(), cwd = process.cwd() } = {}) {
  const tokens = Array.isArray(args) ? args.map((a) => String(a ?? '')) : [];
  let subcmd = null;
  const subArgs = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const eqIdx = tok.indexOf('=');
    const flag = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok;
    const lowerFlag = flag.toLowerCase();

    if (!subcmd) {
      if (tok === '-C' || flag === '--git-dir' || flag === '--work-tree') {
        if (tok === '-C') {
          const nextDir = tokens[++i];
          if (!nextDir) return { allowed: false, reason: 'Missing path argument for git -C' };
          const resolvedDir = resolve(cwd, nextDir);
          if (!isPathInsideBase(resolvedDir, workspaceRoot)) {
            return { allowed: false, reason: `git -C path escapes workspace: ${nextDir}` };
          }
          continue;
        }
        return { allowed: false, reason: `Blocked git flag: ${flag}` };
      }
      if (!tok.startsWith('--') && tok.startsWith('-C') && tok.length > 2) {
        const inlineDir = tok.slice(2);
        const resolvedDir = resolve(cwd, inlineDir);
        if (!isPathInsideBase(resolvedDir, workspaceRoot)) {
          return { allowed: false, reason: `git -C path escapes workspace: ${inlineDir}` };
        }
        continue;
      }

      if (tok === '-c') {
        const kv = tokens[++i];
        if (!kv) return { allowed: false, reason: 'Missing key=value argument for git -c' };
        const cfgKey = kv.split('=')[0].trim().toLowerCase();
        if (!SHIM_SAFE_GIT_CONFIG_KEYS.has(cfgKey)) {
          return { allowed: false, reason: `Blocked git config override: -c ${cfgKey}` };
        }
        continue;
      }
      if (!tok.startsWith('--') && tok.startsWith('-c') && tok.length > 2) {
        const cfgKey = tok.slice(2).split('=')[0].trim().toLowerCase();
        if (!SHIM_SAFE_GIT_CONFIG_KEYS.has(cfgKey)) {
          return { allowed: false, reason: `Blocked git config override: ${tok}` };
        }
        continue;
      }

      if (
        BLOCKED_GIT_FLAGS.has(flag) ||
        BLOCKED_GIT_FLAGS.has(lowerFlag) ||
        (!tok.startsWith('--') && tok.startsWith('-o'))
      ) {
        return { allowed: false, reason: `Blocked git flag: ${flag}` };
      }

      if (tok.startsWith('-')) {
        if (tok === '--namespace' || tok === '--super-prefix' || tok === '--config-env' || tok === '--exec-path') {
          return { allowed: false, reason: `Blocked git flag: ${flag}` };
        }
        continue;
      }

      subcmd = tok.toLowerCase();
      continue;
    }

    if (
      BLOCKED_GIT_FLAGS.has(flag) ||
      BLOCKED_GIT_FLAGS.has(lowerFlag) ||
      (!tok.startsWith('--') && (tok.startsWith('-c') || tok.startsWith('-C') || tok.startsWith('-o')))
    ) {
      return { allowed: false, reason: `Blocked git flag after subcommand: ${flag}` };
    }
    subArgs.push(tok);
  }

  if (!subcmd) {
    const versionOrHelpOnly = tokens.every((t) =>
      ['--version', '-v', '--help', '-h'].includes(t.toLowerCase()),
    );
    return versionOrHelpOnly
      ? { allowed: true, reason: null }
      : { allowed: false, reason: 'Blocked git invocation without an authorized subcommand' };
  }

  if (SHIM_DISALLOWED_GIT_SUBCOMMANDS.has(subcmd)) {
    return { allowed: false, reason: `Blocked anti-cheat git subcommand: ${subcmd}` };
  }
  if (!SHIM_SAFE_GIT_SUBCOMMANDS.has(subcmd)) {
    return { allowed: false, reason: `Unsupported git subcommand in SWE-bench shim: ${subcmd}` };
  }

  for (const arg of subArgs) {
    if (SHIM_GIT_CHEAT_ARG_RE.test(arg)) {
      return { allowed: false, reason: `Blocked anti-cheat git ref flag: ${arg}` };
    }
    if (/(?:^|\/)refs\//i.test(arg) || arg.includes('@{') || SHIM_DIRECT_GIT_INTERNALS_RE.test(arg)) {
      return { allowed: false, reason: `Blocked direct git ref inspection: ${arg}` };
    }
    if (/^(?:FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)$/i.test(arg)) {
      return { allowed: false, reason: `Blocked git ref token: ${arg}` };
    }
  }

  return { allowed: true, reason: null };
}

function resolveExecutableExcludingDir(binName, excludeDir, env = process.env) {
  const pathVal = String(env?.PATH ?? process.env.PATH ?? '');
  const realExclude = excludeDir ? getNativeRealpath(excludeDir) : null;
  const exts =
    process.platform === 'win32'
      ? ['', '.exe', '.cmd', '.bat']
      : [''];
  for (const dir of pathVal.split(delimiter)) {
    if (!dir) continue;
    if (realExclude && getNativeRealpath(dir).toLowerCase() === realExclude.toLowerCase()) {
      continue;
    }
    for (const ext of exts) {
      const candidate = join(dir, `${binName}${ext}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function buildPathWithPrefix(prefixDir, env = process.env) {
  const rawPath = String(env?.PATH ?? env?.Path ?? '');
  const parts = rawPath.split(delimiter).filter(Boolean);
  const realPrefix = getNativeRealpath(prefixDir);
  const filtered = parts.filter(
    (p) => getNativeRealpath(p).toLowerCase() !== realPrefix.toLowerCase(),
  );
  return [prefixDir, ...filtered].join(delimiter);
}

function buildPathWithoutDir(excludeDir, env = process.env) {
  const rawPath = String(env?.PATH ?? env?.Path ?? '');
  const parts = rawPath.split(delimiter).filter(Boolean);
  const realExclude = getNativeRealpath(excludeDir);
  return parts
    .filter((p) => getNativeRealpath(p).toLowerCase() !== realExclude.toLowerCase())
    .join(delimiter);
}

function shellSingleQuotePosix(val) {
  return `'${String(val).replace(/'/g, `'\\''`)}'`;
}

/**
 * Runtime entrypoint executed by wrapper binaries inside `shimBinDir`.
 */
export function runTestbedShimCli(argv = process.argv.slice(2)) {
  const [configPath, cmdName, ...args] = argv;
  if (!configPath || !cmdName) {
    process.stderr.write('[swebench-shim] Invalid shim invocation\n');
    return 2;
  }

  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`[swebench-shim] Failed to load shim config: ${err?.message ?? err}\n`);
    return 2;
  }

  const cleanEnv = {
    ...process.env,
    PATH: buildPathWithoutDir(cfg.shimBinDir, process.env),
  };

  if (cmdName === 'git') {
    const check = validateShimGitArgs(args, {
      workspaceRoot: cfg.workspaceRoot,
      cwd: process.cwd(),
    });
    if (!check.allowed) {
      process.stderr.write(`[swebench-anti-cheat] ${check.reason}\n`);
      return 126;
    }
    const gitBin = cfg.realGitBin || resolveExecutableExcludingDir('git', cfg.shimBinDir, cleanEnv) || 'git';
    const useShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(gitBin);
    const res = spawnSync(gitBin, args, {
      cwd: process.cwd(),
      env: cleanEnv,
      stdio: 'inherit',
      windowsHide: true,
      shell: useShell,
    });
    if (res.error) {
      process.stderr.write(`[swebench-shim] git failed: ${res.error.message}\n`);
      return 127;
    }
    return res.status ?? 1;
  }

  if (cmdName === 'python' || cmdName === 'python3' || /^python3\.\d+$/.test(cmdName)) {
    const cIdx = args.findIndex(
      (t) =>
        (typeof t === 'string' && t.startsWith('-c') && !t.startsWith('--')) ||
        t === '--command' ||
        (typeof t === 'string' && t.startsWith('--command=')),
    );
    if (cIdx >= 0) {
      const tok = String(args[cIdx]);
      const pyCode =
        tok.startsWith('-c') && tok.length > 2
          ? tok.slice(2)
          : tok.startsWith('--command=')
            ? tok.slice('--command='.length)
            : String(args[cIdx + 1] ?? '');
      if (PY_CHEAT_GIT_CALL_RE.test(pyCode)) {
        process.stderr.write('[swebench-anti-cheat] Blocked inline Python git inspection call\n');
        return 126;
      }
    }
  }

  if (cfg.containerId) {
    const { containerCwd, rewrittenArgs } = rewriteHostArgsForContainer(args, {
      workspaceRoot: cfg.workspaceRoot,
      cwd: process.cwd(),
    });
    const dockerBin = cfg.dockerBin || 'docker';
    const dockerArgs = [
      'exec',
      '-w',
      containerCwd,
      '-e',
      `PATH=${DEFAULT_TESTBED_PATH}`,
      '-e',
      'CONDA_DEFAULT_ENV=testbed',
      '-e',
      'CONDA_PREFIX=/opt/miniconda3/envs/testbed',
      '-e',
      'PYTHONDONTWRITEBYTECODE=1',
      cfg.containerId,
      cmdName,
      ...rewrittenArgs,
    ];
    const useShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(dockerBin);
    const res = spawnSync(dockerBin, dockerArgs, {
      cwd: cfg.workspaceRoot,
      env: cleanEnv,
      stdio: 'inherit',
      windowsHide: true,
      shell: useShell,
    });
    if (res.error) {
      process.stderr.write(`[swebench-shim] docker exec failed: ${res.error.message}\n`);
      return 127;
    }
    return res.status ?? 1;
  }

  const hostBin = resolveExecutableExcludingDir(cmdName, cfg.shimBinDir, cleanEnv);
  if (!hostBin) {
    process.stderr.write(`[swebench-shim] Executable not found on host PATH: ${cmdName}\n`);
    return 127;
  }
  const useShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(hostBin);
  const res = spawnSync(hostBin, args, {
    cwd: process.cwd(),
    env: cleanEnv,
    stdio: 'inherit',
    windowsHide: true,
    shell: useShell,
  });
  if (res.error) {
    process.stderr.write(`[swebench-shim] ${cmdName} failed: ${res.error.message}\n`);
    return 127;
  }
  return res.status ?? 1;
}

/**
 * Creates a temporary binary shim directory to prepend to an external agent's `PATH`:
 * - Maps Python/test commands (`python`, `python3`, `pytest`, `py.test`, `tox`, `sphinx-build`,
 *   `pip`, `pip3`, `flake8`) into `docker exec -w /testbed/<rel> <containerId>` inside Conda
 *   `/opt/miniconda3/envs/testbed` when `containerId` is active.
 * - Wraps `git` with strict anti-cheat validation blocking history/ref inspection.
 */
export function createTestbedShimBinDir({
  workspaceRoot,
  containerId = null,
  dockerBin = 'docker',
  realGitBin = null,
  shimCommands = DEFAULT_TESTBED_SHIM_COMMANDS,
  env = process.env,
} = {}) {
  if (!workspaceRoot || !String(workspaceRoot).trim()) {
    throw new Error('createTestbedShimBinDir requires workspaceRoot');
  }
  const absWorkspaceRoot = resolve(String(workspaceRoot));
  const shimBinDir = mkdtempSync(join(tmpdir(), 'agent-us-swe-shim-'));
  const resolvedGit = realGitBin || resolveExecutableExcludingDir('git', shimBinDir, env) || 'git';

  const configPath = join(shimBinDir, '_shim-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      shimBinDir,
      workspaceRoot: absWorkspaceRoot,
      containerId: containerId ? String(containerId).trim() : null,
      dockerBin: String(dockerBin || 'docker').trim(),
      realGitBin: resolvedGit,
    }),
    'utf8',
  );

  const moduleFileUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
  const entryScriptPath = join(shimBinDir, '_swebench-shim.mjs');
  writeFileSync(
    entryScriptPath,
    [
      `import { runTestbedShimCli } from ${JSON.stringify(moduleFileUrl)};`,
      'const code = runTestbedShimCli(process.argv.slice(2));',
      'process.exit(Number.isInteger(code) ? code : 1);',
      '',
    ].join('\n'),
    'utf8',
  );

  const allCommands = [...new Set([...shimCommands, 'git'])];
  for (const cmd of allCommands) {
    const posixWrapper = join(shimBinDir, cmd);
    const posixLine = `exec ${shellSingleQuotePosix(process.execPath)} ${shellSingleQuotePosix(entryScriptPath)} ${shellSingleQuotePosix(configPath)} ${shellSingleQuotePosix(cmd)} "$@"\n`;
    writeFileSync(posixWrapper, `#!/usr/bin/env sh\n${posixLine}`, { encoding: 'utf8', mode: 0o755 });
    try {
      chmodSync(posixWrapper, 0o755);
    } catch {
      // Best-effort chmod on POSIX filesystems
    }

    if (process.platform === 'win32') {
      const cmdWrapper = join(shimBinDir, `${cmd}.cmd`);
      writeFileSync(
        cmdWrapper,
        `@echo off\r\n"${process.execPath}" "${entryScriptPath}" "${configPath}" "${cmd}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
        'utf8',
      );
    }
  }

  return {
    shimBinDir,
    commands: allCommands,
    cleanup: () => safeRmRf(shimBinDir),
  };
}

/**
 * Formats an external-agent SWE-bench task prompt containing the issue description, hints,
 * suggested test command, and container `/testbed` shim instructions.
 */
export function buildExternalSweBenchPrompt(instance, { containerMode = false } = {}) {
  const parts = [
    `Repository: ${instance.repo || 'local'}`,
    `Instance ID: ${instance.instance_id}`,
    `Base Commit: ${instance.base_commit}`,
    '',
    'Problem Statement:',
    instance.problem_statement,
  ];
  if (instance.hints_text) {
    parts.push('', 'Hints:', instance.hints_text);
  }
  if (instance.test_cmd) {
    parts.push('', `Suggested Test Command: ${instance.test_cmd}`);
  }
  parts.push(
    '',
    containerMode
      ? 'Environment Instructions: The repository is checked out in the current working directory (bidirectional mount to container /testbed). `python`, `python3`, `pytest`, `tox`, and `sphinx-build` are pre-shimmed to execute inside the isolated `/opt/miniconda3/envs/testbed` Docker environment. Locate the root cause, apply a minimal targeted fix, run the relevant tests to confirm passing, and leave your changes uncommitted in the working tree for git diff extraction.'
      : 'Environment Instructions: The repository is checked out in the current working directory. Locate the root cause, apply a minimal targeted fix, run the relevant test suite to confirm passing, and leave your changes uncommitted in the working tree for git diff extraction.',
  );
  return parts.join('\n');
}

function normalizeExternalSubprocessInvocation(bin, args) {
  if (/\.(?:mjs|cjs|js)$/i.test(bin)) {
    return { execBin: process.execPath, execArgs: [bin, ...args], useShell: false };
  }
  const useShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(bin);
  return { execBin: bin, execArgs: args, useShell };
}

function spawnExternalCliWithTimeout({
  bin,
  args,
  cwd,
  env,
  timeoutMs,
  maxCaptureBytes = 256 * 1024,
  installHint = '',
}) {
  const { execBin, execArgs, useShell } = normalizeExternalSubprocessInvocation(bin, args);

  return new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawn(execBin, execArgs, {
        cwd,
        env,
        shell: useShell,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (spawnErr) {
      if (spawnErr?.code === 'ENOENT') {
        const err = new Error(
          `External benchmark CLI binary "${bin}" not found.${installHint ? ` ${installHint}` : ''}`,
        );
        err.isFatalConfigError = true;
        rejectRun(err);
        return;
      }
      rejectRun(spawnErr);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killProcessTree(child);
    }, Math.max(500, timeoutMs));

    const append = (which, chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      if (which === 'stdout') {
        if (stdout.length < maxCaptureBytes) {
          stdout += text.slice(0, maxCaptureBytes - stdout.length);
        }
      } else if (stderr.length < maxCaptureBytes) {
        stderr += text.slice(0, maxCaptureBytes - stderr.length);
      }
    };

    child.stdout?.on('data', (d) => append('stdout', d));
    child.stderr?.on('data', (d) => append('stderr', d));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err?.code === 'ENOENT') {
        const fatal = new Error(
          `External benchmark CLI binary "${bin}" not found.${installHint ? ` ${installHint}` : ''}`,
        );
        fatal.isFatalConfigError = true;
        rejectRun(fatal);
        return;
      }
      rejectRun(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        exitCode: timedOut ? 124 : code ?? 1,
        signal: signal ?? null,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function probeHelpTextSync(bin, env) {
  const { execBin, execArgs, useShell } = normalizeExternalSubprocessInvocation(bin, ['--help']);
  try {
    const res = spawnSync(execBin, execArgs, {
      env,
      shell: useShell,
      windowsHide: true,
      timeout: 5_000,
      encoding: 'utf8',
    });
    if (res.error) return { ok: false, text: '' };
    return { ok: true, text: `${res.stdout ?? ''}\n${res.stderr ?? ''}` };
  } catch {
    return { ok: false, text: '' };
  }
}

async function runClaudeCodeArm({
  instance,
  workspaceRoot,
  opts,
  proxy,
  shimBinDir,
  targetModel,
  containerMode,
  timeoutMs,
  runtimeDeps,
  baseEnv,
}) {
  const bin = String(
    runtimeDeps.claudeBin || baseEnv.SWEBENCH_CLAUDE_BIN || 'claude',
  ).trim();
  const isolatedHome = mkdtempSync(join(tmpdir(), 'agent-us-swe-claude-home-'));
  try {
    mkdirSync(join(isolatedHome, '.claude'), { recursive: true });
    writeFileSync(
      join(isolatedHome, '.claude.json'),
      JSON.stringify({ hasCompletedOnboarding: true }),
      'utf8',
    );
    writeFileSync(
      join(isolatedHome, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: {
          allow: ['Bash(*)', 'Read(*)', 'Edit(*)', 'Write(*)', 'MultiEdit(*)', 'Glob(*)', 'Grep(*)'],
        },
      }),
      'utf8',
    );

    const sanitized = sanitizeChildEnv(baseEnv, { allowKeys: ['PATH', 'Path'] });
    const childEnv = {
      ...sanitized,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, '.config'),
      XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
      XDG_CACHE_HOME: join(isolatedHome, '.cache'),
      PATH: buildPathWithPrefix(shimBinDir, baseEnv),
      ANTHROPIC_BASE_URL: proxy.anthropicBaseUrl,
      ANTHROPIC_API_KEY: PLACEHOLDER_PROXY_KEY,
      ANTHROPIC_MODEL: targetModel,
      ANTHROPIC_SMALL_FAST_MODEL: targetModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: targetModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: targetModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: targetModel,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    };
    delete childEnv.ANTHROPIC_AUTH_TOKEN;

    const helpProbe = probeHelpTextSync(bin, childEnv);
    const args = ['-p', buildExternalSweBenchPrompt(instance, { containerMode })];
    if (!helpProbe.ok || helpProbe.text.includes('--dangerously-skip-permissions')) {
      args.push('--dangerously-skip-permissions');
    }
    if (!helpProbe.ok || helpProbe.text.includes('--max-turns')) {
      args.push('--max-turns', String(opts.maxSteps));
    }

    const res = await spawnExternalCliWithTimeout({
      bin,
      args,
      cwd: workspaceRoot,
      env: childEnv,
      timeoutMs,
      installHint: 'Install via `npm install -g @anthropic-ai/claude-code` or set SWEBENCH_CLAUDE_BIN.',
    });
    return {
      status: res.timedOut ? 'failed' : res.exitCode === 0 ? 'completed' : 'failed',
      error: res.timedOut
        ? `claude_code timed out after ${timeoutMs}ms`
        : res.exitCode === 0
          ? null
          : `claude_code exited with code ${res.exitCode}: ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
    };
  } finally {
    safeRmRf(isolatedHome);
  }
}

async function runCodexCliArm({
  instance,
  workspaceRoot,
  opts: _opts,
  proxy,
  shimBinDir,
  targetModel,
  containerMode,
  timeoutMs,
  runtimeDeps,
  baseEnv,
}) {
  const bin = String(
    runtimeDeps.codexBin || baseEnv.SWEBENCH_CODEX_BIN || 'codex',
  ).trim();
  let codexHome;
  try {
    codexHome = mkdtempSync(join(homedir(), '.agent-us-codex-home-'));
  } catch {
    codexHome = mkdtempSync(join(tmpdir(), 'agent-us-swe-codex-home-'));
  }
  try {
    const configToml = [
      `model = ${JSON.stringify(targetModel)}`,
      'model_provider = "swebench"',
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      '',
      '[model_providers.swebench]',
      'name = "SWEBench"',
      `base_url = ${JSON.stringify(proxy.openaiBaseUrl)}`,
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
      '',
    ].join('\n');
    writeFileSync(join(codexHome, 'config.toml'), configToml, 'utf8');
    writeFileSync(
      join(codexHome, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: PLACEHOLDER_PROXY_KEY }),
      'utf8',
    );

    const sanitized = sanitizeChildEnv(baseEnv, { allowKeys: ['PATH', 'Path'] });
    const childEnv = {
      ...sanitized,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: PLACEHOLDER_PROXY_KEY,
      OPENAI_BASE_URL: proxy.openaiBaseUrl,
      PATH: buildPathWithPrefix(shimBinDir, baseEnv),
    };

    const prompt = buildExternalSweBenchPrompt(instance, { containerMode });
    const res = await spawnExternalCliWithTimeout({
      bin,
      args: [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '-C',
        workspaceRoot,
        prompt,
      ],
      cwd: workspaceRoot,
      env: childEnv,
      timeoutMs,
      installHint: 'Install via `npm install -g @openai/codex` or set SWEBENCH_CODEX_BIN.',
    });
    return {
      status: res.timedOut ? 'failed' : res.exitCode === 0 ? 'completed' : 'failed',
      error: res.timedOut
        ? `codex_cli timed out after ${timeoutMs}ms`
        : res.exitCode === 0
          ? null
          : `codex_cli exited with code ${res.exitCode}: ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
    };
  } finally {
    safeRmRf(codexHome);
  }
}

function truncateCommandOutputForMini(text, maxChars = 16_000) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  const half = Math.floor((maxChars - 120) / 2);
  return `${s.slice(0, half)}\n\n...[truncated ${s.length - maxChars} chars]...\n\n${s.slice(-half)}`;
}

function extractFencedBashCommand(text) {
  const match = /```(?:bash|sh)\s*\r?\n([\s\S]*?)\r?\n```/i.exec(String(text ?? ''));
  return match ? match[1].trim() : null;
}

export async function runMiniSweAgentCommand({
  command,
  workspaceRoot,
  sessionSandbox,
  shimBinDir,
  baseEnv = process.env,
  customTestCmd = null,
  timeoutMs = 120_000,
}) {
  const cmd = String(command ?? '').trim();
  if (!cmd) {
    return { exitCode: 2, output: 'Error: empty bash command' };
  }

  if (sessionSandbox && typeof sessionSandbox.exec === 'function') {
    try {
      const res = await sessionSandbox.exec(cmd, { timeoutMs });
      const combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
      return {
        exitCode: res.exitCode ?? 1,
        output: truncateCommandOutputForMini(combined || `(exit ${res.exitCode ?? 1}, no output)`),
      };
    } catch (err) {
      const errMsg = redactSecrets(String(err?.message || err || 'Command blocked or failed'));
      const isPolicyBlock = /blocked unauthorized|anti-cheat/i.test(errMsg);
      return {
        exitCode: isPolicyBlock ? 126 : 1,
        output: truncateCommandOutputForMini(errMsg),
      };
    }
  }

  const analysis = analyzeCommand(cmd);
  if (analysis.hardBlocked) {
    return { exitCode: 126, output: `Blocked hard-restricted command: ${cmd}` };
  }
  if (/\.git[\\/]+(?:objects|refs|logs|packed-refs|info|hooks|shallow)/i.test(cmd)) {
    return { exitCode: 126, output: `Blocked anti-cheat .git inspection: ${cmd}` };
  }
  // If user passed an explicit disallowed git subcommand chained with shell syntax, guard via tokenizer if single command,
  // while relying on shimBinDir/git in PATH for chained scripts.
  if (/^\s*git\b/i.test(cmd) && isAuthorizedSweBenchCommand(cmd, { customTestCmd, containerMode: true }) === false) {
    return { exitCode: 126, output: `Blocked unauthorized git command: ${cmd}` };
  }

  const sanitized = sanitizeChildEnv(baseEnv, { allowKeys: ['PATH', 'Path'] });
  const env = {
    ...sanitized,
    PATH: buildPathWithPrefix(shimBinDir, baseEnv),
  };

  return new Promise((resolveCmd) => {
    const shellBin = process.platform === 'win32' ? true : 'bash';
    const child =
      process.platform === 'win32'
        ? spawn(cmd, [], {
            cwd: workspaceRoot,
            env,
            shell: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn(shellBin, ['-c', cmd], {
            cwd: workspaceRoot,
            env,
            shell: false,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 64 * 1024;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, Math.max(1_000, Math.min(timeoutMs, 120_000)));

    child.stdout?.on('data', (d) => {
      if (stdout.length < cap) stdout += Buffer.from(d).toString('utf8').slice(0, cap - stdout.length);
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < cap) stderr += Buffer.from(d).toString('utf8').slice(0, cap - stderr.length);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveCmd({ exitCode: 1, output: `Command execution error: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = [stdout, stderr].filter(Boolean).join('\n');
      resolveCmd({
        exitCode: timedOut ? 124 : code ?? 1,
        output: truncateCommandOutputForMini(
          timedOut ? `${body}\n[timeout]`.trim() : body || `(exit ${code ?? 1}, no output)`,
        ),
      });
    });
  });
}

/**
 * Built-in minimal single-`bash`-tool ReAct loop following official `mini-swe-agent`
 * semantics so `mini_swe_agent` baseline evaluations never break due to PyPI/CLI drift.
 */
async function runBuiltinMiniSweAgentLoop({
  instance,
  workspaceRoot,
  opts,
  proxy,
  shimBinDir,
  sessionSandbox,
  targetModel,
  containerMode,
  timeoutMs,
  baseEnv,
}) {
  const deadline = performance.now() + timeoutMs;
  const maxSteps = Math.max(1, Number(opts?.maxSteps ?? 60));
  const bashToolSpec = [
    {
      type: 'function',
      function: {
        name: 'bash',
        description: containerMode
          ? 'Execute a single shell command inside the /testbed container.'
          : 'Execute a single shell command in the repository working directory.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute.' },
          },
          required: ['command'],
        },
      },
    },
  ];

  const messages = [
    {
      role: 'system',
      content: [
        'You are mini-swe-agent, a minimal autonomous software engineering baseline.',
        'You solve GitHub issues using ONLY the `bash` tool (one command per step).',
        'Inspect code, apply minimal targeted edits, and run the relevant test suite to verify.',
        'When finished and verified, reply without tool calls and begin your final message with COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT.',
      ].join(' '),
    },
    {
      role: 'user',
      content: buildExternalSweBenchPrompt(instance, { containerMode }),
    },
  ];

  let toolCallsCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    const remainingMs = Math.round(deadline - performance.now());
    if (remainingMs <= 0) {
      return {
        status: 'failed',
        toolCallsCount,
        error: `mini_swe_agent timed out after ${timeoutMs}ms`,
      };
    }

    const res = await fetch(`${proxy.openaiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${PLACEHOLDER_PROXY_KEY}`,
      },
      body: JSON.stringify({
        model: targetModel,
        messages,
        tools: bashToolSpec,
      }),
      signal: AbortSignal.timeout(Math.min(remainingMs, 180_000)),
    });

    const rawText = await res.text();
    if (!res.ok) {
      return {
        status: 'failed',
        toolCallsCount,
        error: `mini_swe_agent LLM HTTP ${res.status}: ${rawText.slice(0, 400)}`,
      };
    }

    let json;
    try {
      json = JSON.parse(rawText);
    } catch {
      return {
        status: 'failed',
        toolCallsCount,
        error: `mini_swe_agent received non-JSON completion response`,
      };
    }

    const msg = json?.choices?.[0]?.message;
    if (!msg) {
      return {
        status: 'failed',
        toolCallsCount,
        error: 'mini_swe_agent response missing choices[0].message',
      };
    }

    const contentStr = typeof msg.content === 'string' ? msg.content : extractChatMessageText(msg.content);
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: contentStr || null,
        tool_calls: toolCalls,
      });
      for (const tc of toolCalls) {
        let cmd = '';
        try {
          const parsedArgs =
            typeof tc?.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc?.function?.arguments ?? {};
          cmd = String(parsedArgs.command ?? '');
        } catch {
          cmd = '';
        }
        toolCallsCount += 1;
        const execRes = await runMiniSweAgentCommand({
          command: cmd,
          workspaceRoot,
          sessionSandbox,
          shimBinDir,
          baseEnv,
          customTestCmd: instance.test_cmd,
          timeoutMs: Math.max(1_000, Math.round(deadline - performance.now())),
        });
        messages.push({
          role: 'tool',
          tool_call_id: String(tc.id || `call_${step}`),
          content: `returncode: ${execRes.exitCode}\noutput:\n${execRes.output}`,
        });
      }
      continue;
    }

    const fencedCmd =
      !contentStr.includes('COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT')
        ? extractFencedBashCommand(contentStr)
        : null;
    if (fencedCmd) {
      messages.push({ role: 'assistant', content: contentStr });
      toolCallsCount += 1;
      const execRes = await runMiniSweAgentCommand({
        command: fencedCmd,
        workspaceRoot,
        sessionSandbox,
        shimBinDir,
        baseEnv,
        customTestCmd: instance.test_cmd,
        timeoutMs: Math.max(1_000, Math.round(deadline - performance.now())),
      });
      messages.push({
        role: 'user',
        content: `<returncode>${execRes.exitCode}</returncode>\n<output>\n${execRes.output}\n</output>`,
      });
      continue;
    }

    return {
      status: 'completed',
      toolCallsCount,
      error: null,
    };
  }

  return {
    status: 'failed',
    toolCallsCount,
    error: `mini_swe_agent reached maxSteps (${maxSteps})`,
  };
}

function findMiniSweAgentExternalBin(runtimeDeps, env) {
  if (runtimeDeps.forceBuiltinMiniSweAgent) return null;
  if (String(env?.SWEBENCH_MINI_SWE_AGENT_MODE ?? '').trim().toLowerCase() === 'builtin') {
    return null;
  }
  const explicit = String(runtimeDeps.miniSweAgentBin || env?.SWEBENCH_MINI_SWE_AGENT_BIN || '').trim();
  if (explicit) return explicit;

  const miniswe = resolveExecutableExcludingDir('minisweagent', null, env);
  if (miniswe) return miniswe;

  const mini = resolveExecutableExcludingDir('mini', null, env);
  if (mini) {
    const probe = probeHelpTextSync(mini, env);
    if (probe.ok && /mini-swe-agent|minisweagent|swe-agent/i.test(probe.text)) {
      return mini;
    }
  }
  return null;
}

async function runMiniSweAgentArm({
  instance,
  workspaceRoot,
  opts,
  proxy,
  shimBinDir,
  sessionSandbox,
  targetModel,
  containerMode,
  timeoutMs,
  runtimeDeps,
  baseEnv,
  warnFn,
}) {
  const externalBin = findMiniSweAgentExternalBin(runtimeDeps, baseEnv);
  if (externalBin) {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'agent-us-swe-mini-home-'));
    try {
      const sanitized = sanitizeChildEnv(baseEnv, { allowKeys: ['PATH', 'Path'] });
      const childEnv = {
        ...sanitized,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        PATH: buildPathWithPrefix(shimBinDir, baseEnv),
        OPENAI_API_KEY: PLACEHOLDER_PROXY_KEY,
        OPENAI_API_BASE: proxy.openaiBaseUrl,
        OPENAI_BASE_URL: proxy.openaiBaseUrl,
        MSWEA_MODEL_NAME: `openai/${targetModel}`,
        MSWEA_COST_TRACKING: 'ignore_errors',
        MSWEA_CONFIGURED: 'true',
      };
      const prompt = buildExternalSweBenchPrompt(instance, { containerMode });
      let res = null;
      let launchErr = null;
      try {
        res = await spawnExternalCliWithTimeout({
          bin: externalBin,
          args: ['-m', targetModel, '-t', prompt, '-y', '--exit-immediately'],
          cwd: workspaceRoot,
          env: childEnv,
          timeoutMs,
        });
      } catch (err) {
        launchErr = err;
      }
      if (res && !res.timedOut && res.exitCode === 0 && proxy.getMetrics().steps > 0) {
        return { status: 'completed', toolCallsCount: 0, error: null };
      }
      if (res && proxy.getMetrics().steps > 0) {
        return {
          status: 'failed',
          toolCallsCount: 0,
          error: res.timedOut
            ? `mini_swe_agent timed out after ${timeoutMs}ms`
            : `mini_swe_agent CLI exited with code ${res.exitCode}: ${(res.stderr || res.stdout).trim().slice(0, 400)}`,
        };
      }
      const reason = launchErr
        ? `launch error (${launchErr?.message ?? launchErr})`
        : `exit=${res?.exitCode ?? 'unknown'}`;
      warnFn?.(
        `[MINI-SWE-AGENT] External CLI "${externalBin}" did not complete an LLM step (${reason}); falling back to built-in single-bash ReAct loop.`,
      );
    } finally {
      safeRmRf(isolatedHome);
    }
  }

  return runBuiltinMiniSweAgentLoop({
    instance,
    workspaceRoot,
    opts,
    proxy,
    shimBinDir,
    sessionSandbox,
    targetModel,
    containerMode,
    timeoutMs,
    baseEnv,
  });
}

/**
 * Executes a single `(instance, externalArm)` trial using `SweBenchMeteringProxy`
 * and host-to-container `/testbed` command shims.
 */
export async function runExternalSweBenchArm({
  arm,
  instance,
  workspaceRoot,
  opts = {},
  liveConfig,
  sessionSandbox = null,
  containerMode = false,
  modelNameForPrediction: _modelNameForPrediction = null,
  runtimeDeps = {},
}) {
  const normArm = String(arm ?? '').trim().toLowerCase();
  if (!isExternalSweBenchArm(normArm)) {
    throw new Error(`Unsupported external SWE-bench arm: ${arm}`);
  }
  if (!liveConfig?.endpoint) {
    const fatal = new Error(`External SWE-bench arm "${normArm}" requires a valid provider endpoint`);
    fatal.isFatalConfigError = true;
    throw fatal;
  }

  const targetModel = String(opts.model || liveConfig.model || 'deepseek-chat').trim();
  const baseEnv = runtimeDeps.env ?? process.env;
  const timeoutMs =
    opts.turnTimeoutMs != null && Number.isFinite(Number(opts.turnTimeoutMs)) && Number(opts.turnTimeoutMs) > 0
      ? Math.trunc(Number(opts.turnTimeoutMs))
      : 900_000;

  const proxy = new SweBenchMeteringProxy({
    targetModel,
    apiKey: liveConfig.apiKey ?? '',
    endpoint: liveConfig.endpoint,
    customHeaders: liveConfig.customHeaders ?? null,
    requestTimeoutMs: Math.min(timeoutMs, 300_000),
    fetchImpl: liveConfig.fetchImpl ?? fetch,
  });

  const started = performance.now();
  let shimInfo = null;
  try {
    await proxy.start();
    shimInfo = createTestbedShimBinDir({
      workspaceRoot,
      containerId: sessionSandbox?.containerId ?? null,
      dockerBin: sessionSandbox?.dockerBin ?? 'docker',
      realGitBin: runtimeDeps.realGitBin ?? null,
      env: baseEnv,
    });

    const driverArgs = {
      instance,
      workspaceRoot,
      opts,
      proxy,
      shimBinDir: shimInfo.shimBinDir,
      sessionSandbox,
      targetModel,
      containerMode,
      timeoutMs,
      runtimeDeps,
      baseEnv,
      warnFn: runtimeDeps.warn ?? console.warn,
    };

    let outcome;
    if (normArm === 'claude_code') {
      outcome = await runClaudeCodeArm(driverArgs);
    } else if (normArm === 'codex_cli') {
      outcome = await runCodexCliArm(driverArgs);
    } else {
      outcome = await runMiniSweAgentArm(driverArgs);
    }

    return {
      status: outcome.status,
      error: outcome.error ?? null,
      toolCallsCount: Number(outcome.toolCallsCount ?? 0) || 0,
      wallClockMs: Math.max(1, Math.round(performance.now() - started)),
      metrics: proxy.getMetrics(),
    };
  } finally {
    shimInfo?.cleanup?.();
    await proxy.stop().catch(() => {});
  }
}
