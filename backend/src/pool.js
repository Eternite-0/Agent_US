import { normalizeProviderUsage, observeProviderUsage, openaiPromptCacheKey, stableTools } from './observability/prompt-cache.js';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { nativeProviders, nativeRequest } from './providers/browser-session.js';
import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { Fault, id as uuid } from './store.js';
import { withTraceContext } from './observability/trace.js';
import {
  resolveEffectiveRoute,
  openaiRequestToAnthropic,
  anthropicJsonToOpenai,
  anthropicSseToOpenaiStream,
  anthropicRequestToOpenai,
  openaiJsonToAnthropic,
  openaiSseToAnthropicStream,
} from './gateway-proxy.js';

export const PROVIDER_CATEGORIES = [
  { id: 'all', label: '全部' },
  { id: 'official', label: '官方 API' },
  { id: 'oauth', label: '网页登录 / 订阅' },
  { id: 'custom', label: '本地 / 反代网关' },
];

const OPENAI_FIELDS = [
  { name: 'apiKey', label: 'API Key / 令牌', type: 'string', secret: true, required: true },
  { name: 'endpoint', label: 'API Base URL', type: 'string', secret: false, required: false },
];

const GATEWAY_FIELDS = [
  { name: 'apiKey', label: '网关 Key（可选）', type: 'string', secret: true, required: false },
  { name: 'endpoint', label: '反代 / 网关地址', type: 'string', secret: false, required: true },
];

export const PROVIDER_PRESETS = {
  ...Object.fromEntries([...nativeProviders].map(([id, {name}]) => [id, {
    id, name,
    category: 'oauth', kind: 'gateway', protocol: 'openai', ownedBy: id,
    loginMode: 'web', nativeLogin: true, defaultEndpoint: '', fields: GATEWAY_FIELDS,
    supportsBalance: false, supportsCheckin: false,
  }])),
  // ---- Native Web Login / Subscription & Local CLI Direct Providers (Zero External Gateway!) ----
  'github-copilot': {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    category: 'oauth',
    kind: 'oauth-native',
    protocol: 'openai',
    ownedBy: 'GitHub',
    icon: 'GH',
    color: '#111827',
    description: '内置 GitHub OAuth 设备码网页登录，自动换取 Copilot 短期令牌直连推理（零外部依赖）',
    defaultEndpoint: 'https://api.githubcopilot.com',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    category: 'oauth',
    kind: 'official',
    protocol: 'anthropic',
    ownedBy: 'Anthropic',
    icon: 'CC',
    color: '#d97757',
    description: '支持一键导入本机 ~/.claude/.credentials.json 或填写官方 API Key 直连 Anthropic',
    defaultEndpoint: 'https://api.anthropic.com',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  'openai-codex': {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    category: 'oauth',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'OpenAI',
    icon: 'CX',
    color: '#10a37f',
    description: '支持一键导入本机 ~/.codex/auth.json 或填写 API Key 直连 OpenAI',
    defaultEndpoint: 'https://api.openai.com/v1',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  'gemini-cli': {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    category: 'oauth',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'Google',
    icon: 'GC',
    color: '#4285f4',
    description: '支持导入本机 ~/.gemini/oauth_creds.json 或填写 Gemini API Key 直连',
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  'opencode-go': {
    id: 'opencode-go',
    name: 'OpenCode Go',
    category: 'oauth',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'OpenCode',
    icon: 'OG',
    color: '#0f172a',
    description: 'OpenCode Go 订阅制 Coding 套餐（直连官方端点）',
    defaultEndpoint: 'https://opencode.ai/zen/go/v1',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  'opencode-zen': {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    category: 'oauth',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'OpenCode',
    icon: 'OZ',
    color: '#334155',
    description: 'OpenCode Zen 推理端点（支持免 Key 免费模型或付费 Key 直连）',
    defaultEndpoint: 'https://opencode.ai/inference/v1',
    supportsBalance: false,
    supportsCheckin: false,
    fields: GATEWAY_FIELDS,
  },

  // ---- Official API Templates (100% Direct Self-Contained HTTP) ----
  openai: {
    id: 'openai',
    name: 'OpenAI',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'OpenAI',
    icon: 'OA',
    color: '#10a37f',
    description: 'OpenAI 官方 GPT / o-series API',
    defaultEndpoint: 'https://api.openai.com/v1',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    category: 'official',
    kind: 'official',
    protocol: 'anthropic',
    ownedBy: 'Anthropic',
    icon: 'CL',
    color: '#d97757',
    description: 'Anthropic Claude 官方 Messages API（原生流式 + 工具调用）',
    defaultEndpoint: 'https://api.anthropic.com',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'DeepSeek',
    icon: 'DS',
    color: '#3b82f6',
    description: 'DeepSeek 官方 API（支持余额查询与思考流）',
    defaultEndpoint: 'https://api.deepseek.com/v1',
    supportsBalance: true,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'Google',
    icon: 'GM',
    color: '#4285f4',
    description: 'Google Gemini OpenAI 兼容端点',
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'OpenRouter',
    icon: 'OR',
    color: '#6366f1',
    description: 'OpenRouter 多模型聚合网关（支持余额查询）',
    defaultEndpoint: 'https://openrouter.ai/api/v1',
    supportsBalance: true,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  siliconflow: {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'SiliconFlow',
    icon: 'SF',
    color: '#7c3aed',
    description: '硅基流动国内高速推理 API（支持余额查询）',
    defaultEndpoint: 'https://api.siliconflow.cn/v1',
    supportsBalance: true,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'Moonshot',
    icon: 'KM',
    color: '#0f172a',
    description: '月之暗面 Kimi 官方 API',
    defaultEndpoint: 'https://api.moonshot.cn/v1',
    supportsBalance: true,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  zhipu: {
    id: 'zhipu',
    name: '智谱 BigModel',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'Zhipu',
    icon: 'ZP',
    color: '#2563eb',
    description: '智谱 GLM 系列官方 OpenAI 兼容 API',
    defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  qwen: {
    id: 'qwen',
    name: '通义千问 DashScope',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'Alibaba',
    icon: 'QW',
    color: '#6d28d9',
    description: '阿里云百炼 OpenAI 兼容接口',
    defaultEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'MiniMax',
    icon: 'MM',
    color: '#ec4899',
    description: 'MiniMax 官方 OpenAI 兼容接口',
    defaultEndpoint: 'https://api.minimax.chat/v1',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'Groq',
    icon: 'GQ',
    color: '#ea580c',
    description: 'Groq 超低延迟 LPU 推理 API',
    defaultEndpoint: 'https://api.groq.com/openai/v1',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  xai: {
    id: 'xai',
    name: 'xAI (Grok)',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'xAI',
    icon: 'XA',
    color: '#18181b',
    description: 'xAI Grok 官方接口',
    defaultEndpoint: 'https://api.x.ai/v1',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  volcengine: {
    id: 'volcengine',
    name: '火山方舟 Ark',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'ByteDance',
    icon: 'VA',
    color: '#0284c7',
    description: '字节跳动火山方舟大模型 API',
    defaultEndpoint: 'https://ark.cn-beijing.volces.com/api/v3',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  'glm-coding': {
    id: 'glm-coding',
    name: 'GLM Coding 国际版',
    category: 'official',
    kind: 'official',
    protocol: 'anthropic',
    ownedBy: 'Zhipu',
    icon: 'GL',
    color: '#2563eb',
    description: '智谱国际站 z.ai Coding 套餐（Anthropic / OpenAI 兼容）',
    defaultEndpoint: 'https://api.z.ai/api/anthropic',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  'minimax-cn': {
    id: 'minimax-cn',
    name: 'MiniMax 中国',
    category: 'official',
    kind: 'official',
    protocol: 'anthropic',
    ownedBy: 'MiniMax',
    icon: 'MC',
    color: '#db2777',
    description: 'MiniMax 国内站 (minimaxi.com) Coding 套餐',
    defaultEndpoint: 'https://api.minimaxi.com/anthropic',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  huggingface: {
    id: 'huggingface',
    name: 'HuggingFace',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'HuggingFace',
    icon: 'HF',
    color: '#f59e0b',
    description: 'HuggingFace Inference Providers 统一路由',
    defaultEndpoint: 'https://router.huggingface.co/v1',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'NVIDIA',
    icon: 'NV',
    color: '#65a30d',
    description: 'NVIDIA NIM 托管高速推理 API',
    defaultEndpoint: 'https://integrate.api.nvidia.com/v1',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  sensenova: {
    id: 'sensenova',
    name: '商汤日日新',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'SenseNova',
    icon: 'SN',
    color: '#4f46e5',
    description: '商汤日日新 OpenAI 兼容端点',
    defaultEndpoint: 'https://api.sensenova.cn/compatible-mode/v1',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  'xiaomi-mimo': {
    id: 'xiaomi-mimo',
    name: '小米 MiMo',
    category: 'official',
    kind: 'official',
    protocol: 'openai',
    ownedBy: 'Xiaomi',
    icon: 'XM',
    color: '#f97316',
    description: '小米 MiMo Token Plan 套餐接口',
    defaultEndpoint: 'https://token-plan-sgp.xiaomimimo.com/v1',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },

  // ---- Local Runtimes & Reverse-Proxy Upstreams (本地 / 反代网关) ----
  agent2api: {
    id: 'agent2api',
    name: 'Agent2API（可选上游）',
    category: 'custom',
    kind: 'gateway',
    protocol: 'openai',
    ownedBy: 'Agent2API',
    icon: 'A2',
    color: '#2563eb',
    description: '可选：接入你本机或远程已运行的 Agent2API 兼容上游端点（如 127.0.0.1:3065/v1）',
    defaultEndpoint: 'http://127.0.0.1:3065/v1',
    supportsBalance: true,
    supportsCheckin: true,
    fields: GATEWAY_FIELDS,
  },
  'new-api': {
    id: 'new-api',
    name: 'New API / One API',
    category: 'custom',
    kind: 'gateway',
    protocol: 'openai',
    ownedBy: 'New API',
    icon: 'NA',
    color: '#4f46e5',
    description: '自建 New API / One API 聚合中转站',
    defaultEndpoint: 'http://127.0.0.1:3000/v1',
    supportsBalance: true,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  sub2api: {
    id: 'sub2api',
    name: 'Sub2API',
    category: 'custom',
    kind: 'gateway',
    protocol: 'openai',
    ownedBy: 'Sub2API',
    icon: 'S2',
    color: '#0ea5e9',
    description: '自建 Sub2API 聚合中转站',
    defaultEndpoint: '',
    supportsBalance: false,
    supportsCheckin: false,
    fields: OPENAI_FIELDS,
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    category: 'custom',
    kind: 'local',
    protocol: 'openai',
    ownedBy: 'Ollama',
    icon: 'OL',
    color: '#334155',
    description: '本机 Ollama 模型服务（无需 API Key）',
    defaultEndpoint: 'http://127.0.0.1:11434/v1',
    supportsBalance: false,
    supportsCheckin: false,
    fields: GATEWAY_FIELDS,
  },
  lmstudio: {
    id: 'lmstudio',
    name: 'LM Studio',
    category: 'custom',
    kind: 'local',
    protocol: 'openai',
    ownedBy: 'LM Studio',
    icon: 'LM',
    color: '#7c3aed',
    description: '本机 LM Studio OpenAI 兼容服务',
    defaultEndpoint: 'http://127.0.0.1:1234/v1',
    supportsBalance: false,
    supportsCheckin: false,
    fields: GATEWAY_FIELDS,
  },
  'custom-openai': {
    id: 'custom-openai',
    name: '自定义 OpenAI API',
    category: 'custom',
    kind: 'custom',
    protocol: 'openai',
    ownedBy: 'Custom',
    icon: 'OA',
    color: '#0284c7',
    description: '任意 OpenAI Chat Completions 兼容端点',
    defaultEndpoint: '',
    supportsBalance: false,
    supportsCheckin: false,
    fields: [
      { name: 'endpoint', label: 'Base URL (含 /v1)', type: 'string', secret: false, required: true },
      { name: 'apiKey', label: 'API Key', type: 'string', secret: true, required: false },
    ],
  },
  'custom-anthropic': {
    id: 'custom-anthropic',
    name: '自定义 Anthropic API',
    category: 'custom',
    kind: 'custom',
    protocol: 'anthropic',
    ownedBy: 'Custom',
    icon: 'AN',
    color: '#ea580c',
    description: '任意 Anthropic Messages API 兼容端点',
    defaultEndpoint: '',
    supportsBalance: false,
    supportsCheckin: false,
    fields: [
      { name: 'endpoint', label: 'Base URL', type: 'string', secret: false, required: true },
      { name: 'apiKey', label: 'API Key (x-api-key)', type: 'string', secret: true, required: true },
    ],
  },
};

const LEGACY_PRESET_ALIASES = {
  zcode: 'zcode-cn',
  autoclaw: 'autoclaw-cn',
  modelscope: 'modelscope-cn',
};

const ANTHROPIC_FALLBACK_MODELS = [
  'claude-sonnet-4-5',
  'claude-opus-4-1',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
];

function loadOrCreateMasterKey(root) {
  if (process.env.BACKEND_MASTER_KEY) {
    return createHash('sha256')
      .update(process.env.BACKEND_MASTER_KEY)
      .digest();
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const keyFile = join(root, '.pool-key');
  if (existsSync(keyFile)) {
    const raw = readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  }
  const key = randomBytes(32);
  writeFileSync(keyFile, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  return key;
}

export function maskSecret(plain) {
  if (!plain || typeof plain !== 'string') return null;
  const s = plain.trim();
  if (!s) return null;
  if (s.length <= 8) return `${s.slice(0, 2)}****`;
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

export function validateEndpoint(endpoint) {
  if (!endpoint) return null;
  const trimmed = String(endpoint).trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Fault('INVALID_ENDPOINT', 400, { endpoint: trimmed });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Fault('INVALID_ENDPOINT_PROTOCOL', 400, { endpoint: trimmed });
  }
  if (parsed.username || parsed.password) {
    throw new Fault('INVALID_ENDPOINT_CREDENTIALS', 400);
  }
  return trimmed;
}

export function inferModelProfile(modelId, preset = '') {
  const id = String(modelId).toLowerCase();
  const isReasoning =
    /reasoner|r1|o1|o3|o4|thinking|qwq|deepseek-r|gpt-5|claude-.*(sonnet-4|opus-4|3-7)/.test(
      id,
    );
  const isVision =
    /gpt-4o|gpt-4\.1|gpt-5|claude-3|claude-4|claude-sonnet|claude-opus|gemini|qwen.*vl|glm-4v|vision|pixtral|llava/.test(
      id,
    );
  const isCache =
    /claude|deepseek|gpt-4o|gpt-4\.1|gpt-5|gemini|qwen|kimi/.test(id);
  const isTools = !/embed|whisper|tts|dall-e|moderation|rerank|bge|flux|sdxl|midjourney|image/.test(
    id,
  );
  let contextWindow = 128000;
  let maxOutput = 16384;
  if (/gemini-2|gemini-1\.5/.test(id)) {
    contextWindow = 1000000;
    maxOutput = 65536;
  } else if (/claude/.test(id)) {
    contextWindow = 200000;
    maxOutput = 32768;
  } else if (/gpt-4\.1|gpt-5/.test(id)) {
    contextWindow = 256000;
    maxOutput = 32768;
  } else if (/deepseek/.test(id)) {
    contextWindow = 131072;
    maxOutput = 32768;
  } else if (/kimi|moonshot/.test(id)) {
    contextWindow = 131072;
    maxOutput = 16384;
  } else if (/qwen/.test(id)) {
    contextWindow = 131072;
    maxOutput = 16384;
  } else if (/32k/.test(id)) {
    contextWindow = 32768;
    maxOutput = 8192;
  }
  return {
    provider: preset,
    model: modelId,
    contextWindow,
    maxOutput,
    capabilities: {
      tools: isTools,
      reasoning: isReasoning,
      vision: isVision,
      cache: isCache,
    },
    coding: /coder|sonnet|opus|deepseek|gpt-5|gpt-4\.1|o3|o4|qwen3/.test(id)
      ? 0.9
      : 0.75,
    design: /opus|sonnet|gpt-5|gpt-4o|gemini-2\.5|deepseek/.test(id)
      ? 0.88
      : 0.72,
    math: isReasoning ? 0.92 : 0.72,
    research: 0.8,
    speed: /flash|mini|haiku|fast|lite|groq/.test(id) ? 0.95 : 0.75,
    inputRate: 0,
    outputRate: 0,
  };
}

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function flattenBlocks(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((x) => x && x.type === 'text')
    .map((x) => x.text ?? '')
    .join('\n');
}

function toOpenAiMessages(o) {
  return [
    ...(o.system ? [{ role: 'system', content: o.system }] : []),
    ...o.messages.map((m) => {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const calls = blocks
        .filter((b) => b.type === 'tool-call')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: b.arguments },
        }));
      const images = blocks.filter((b) => b.type === 'image' && b.data);
      const text = flattenBlocks(m.content);
      const content =
        images.length > 0 && m.role === 'user'
          ? [
              ...(text ? [{ type: 'text', text }] : []),
              ...images.map((img) => ({
                type: 'image_url',
                image_url: {
                  url: `data:${img.mimeType || 'image/png'};base64,${img.data}`,
                },
              })),
            ]
          : calls.length && !text
            ? null
            : text;
      return {
        role: m.role,
        content,
        ...(m.role === 'tool' ? { tool_call_id: m.toolCallId } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
      };
    }),
  ];
}

function anthropicThinkingBudget(effort, wireModel) {
  if (!effort || effort === 'low') return 0;
  const id = String(wireModel || '').toLowerCase();
  if (!/claude-.*(3-7|sonnet-4|opus-4|4-)/.test(id)) return 0;
  if (effort === 'max') return 16384;
  if (effort === 'xhigh') return 10240;
  if (effort === 'high') return 6144;
  return 2048;
}

function openAiReasoningEffort(effort, wireModel) {
  if (!effort) return undefined;
  const id = String(wireModel || '').toLowerCase();
  if (!/\b(o1|o3|o4|gpt-5|codex)\b|o[134]-|gpt-5/.test(id)) return undefined;
  if (effort === 'max' || effort === 'xhigh') return 'high';
  if (['low', 'medium', 'high'].includes(effort)) return effort;
  return undefined;
}

function toAnthropicPayload(o, wireModel) {
  let system = o.system ? String(o.system) : '';
  const messages = [];
  for (const m of o.messages) {
    if (m.role === 'system') {
      const s = flattenBlocks(m.content);
      system = system ? `${system}\n\n${s}` : s;
      continue;
    }
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: flattenBlocks(m.content),
      };
      const prev = messages.at(-1);
      if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
        prev.content.push(block);
      } else {
        messages.push({ role: 'user', content: [block] });
      }
      continue;
    }
    const content = [];
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === 'text' && b.text) {
        content.push({ type: 'text', text: b.text });
      } else if (b.type === 'image' && b.data) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: b.mimeType || 'image/png',
            data: b.data,
          },
        });
      } else if (b.type === 'tool-call') {
        let input = {};
        try {
          input = JSON.parse(b.arguments || '{}');
        } catch {
          input = {};
        }
        content.push({
          type: 'tool_use',
          id: b.id,
          name: b.name,
          input,
        });
      }
    }
    if (!content.length) content.push({ type: 'text', text: ' ' });
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const prev = messages.at(-1);
    if (prev && prev.role === role && Array.isArray(prev.content)) {
      prev.content.push(...content);
    } else {
      messages.push({ role, content });
    }
  }

  // The system checkpoint covers the tools too. Cache the current tail for
  // the next step and retain a nearby boundary when a message has many blocks.
  const mark = (block) => { if (block) block.cache_control = { type: 'ephemeral' }; };
  const tail = messages.at(-1)?.content;
  mark(tail?.at(-1));
  if ((tail?.length ?? 0) >= 18) mark(messages.at(-2)?.content?.at(-1));
  const tools = o.tools?.length ? stableTools(o.tools).map(t => ({
    name: t.name, description: t.description ?? '',
    input_schema: t.parameters ?? { type: 'object', properties: {} },
  })) : undefined;
  if (!system) mark(tools?.at(-1));

  const thinkingBudget = anthropicThinkingBudget(o.effort, wireModel);
  const baseMaxTokens = o.maxTokens ?? 4096;
  const maxTokens = thinkingBudget > 0 ? Math.max(baseMaxTokens, thinkingBudget + 4096) : baseMaxTokens;

  return {
    model: wireModel,
    max_tokens: maxTokens,
    stream: true,
    ...(system
      ? {
          system: [
            {
              type: 'text',
              text: system,
              cache_control: { type: 'ephemeral' },
            },
          ],
        }
      : {}),
    messages,
    ...(tools ? { tools } : {}),
    ...(thinkingBudget > 0
      ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } }
      : {}),
  };
}

function classifyError(err) {
  const explicitStatus = Number(
    err?.status ?? err?.statusCode ?? err?.cause?.status ?? err?.cause?.statusCode ?? 0,
  );
  const causeMsg = String(err?.cause?.message ?? '');
  const message = [String(err?.message ?? err ?? 'Unknown upstream error'), causeMsg]
    .filter(Boolean)
    .join(' | ');
  const errCode = String(err?.code ?? err?.cause?.code ?? '');
  const errName = String(err?.name ?? '');
  const status =
    explicitStatus ||
    (/\b(429|500|502|503|504)\b/.exec(message) ? Number(RegExp.$1) : 0);
  const retryAfterRaw =
    err?.headers?.get?.('retry-after') ?? err?.headers?.['retry-after'];
  const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : 0;
  const isRateLimit =
    status === 429 ||
    /rate.?limit|too many requests|quota|insufficient_quota|\b429\b/i.test(message);
  const isAuth =
    status === 401 ||
    status === 403 ||
    /invalid.?api.?key|unauthorized|forbidden|authentication/i.test(message);
  const isTransient =
    status >= 500 ||
    status === 408 ||
    errName === 'APIConnectionError' ||
    errName === 'APIConnectionTimeoutError' ||
    /^(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|EPIPE|ERR_STREAM_PREMATURE_CLOSE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/i.test(
      errCode,
    ) ||
    /timeout|econnreset|econnrefused|epipe|eai_again|socket hang up|premature close|connection error|fetch failed|network|overloaded|internal server error|bad gateway|service unavailable|gateway timeout|\b500\b|\b502\b|\b503\b|\b504\b/i.test(
      message,
    );
  return { status, message, retryAfterSec, isRateLimit, isAuth, isTransient };
}

export class AccountPool {
  constructor(store, { root, legacyProviders = null, metrics = null } = {}) {
    this.store = store;
    this.root = root;
    this.legacyProviders = legacyProviders;
    this.metrics = metrics ?? null;
    this.sessionRefreshes = new Map();
    this.masterKey = loadOrCreateMasterKey(root);
    this.sessionStickiness = new Map(); // sessionKey -> { accountId, at }
    this.cooldownStrikes = new Map(); // accountId -> consecutive 429 count
    this.activeConns = new Map(); // accountId -> live count
    this.copilotTokenCache = new Map(); // accountId -> { token, endpoint, expiresAt }
    this.adapter = new PoolLlmAdapter(this);
  }

  encrypt(plain) {
    if (!plain) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  }

  decrypt(encoded) {
    if (!encoded || typeof encoded !== 'string') return '';
    if (!encoded.startsWith('v1:')) return '';
    const [, ivHex, tagHex, dataHex] = encoded.split(':');
    if (!ivHex || !tagHex || !dataHex) return '';
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.masterKey,
        Buffer.from(ivHex, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      const out = Buffer.concat([
        decipher.update(Buffer.from(dataHex, 'hex')),
        decipher.final(),
      ]);
      return out.toString('utf8');
    } catch {
      return '';
    }
  }

  getPreset(presetId) {
    const resolvedId = LEGACY_PRESET_ALIASES[presetId] ?? presetId;
    return (
      PROVIDER_PRESETS[resolvedId] ?? {
        id: presetId,
        name: presetId,
        category: 'custom',
        kind: 'custom',
        protocol: 'openai',
        ownedBy: presetId,
        icon: String(presetId).slice(0, 2).toUpperCase(),
        color: '#475569',
        description: '自定义提供商',
        defaultEndpoint: '',
        supportsBalance: false,
        supportsCheckin: false,
        fields: OPENAI_FIELDS,
      }
    );
  }

  listPresets() {
    const counts = new Map();
    const rows = this.store.db
      .prepare('SELECT preset, COUNT(*) AS n FROM provider_accounts GROUP BY preset')
      .all();
    for (const r of rows) counts.set(r.preset, r.n);
    const items = {};
    for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
      items[key] = { ...preset, accountCount: counts.get(key) ?? 0 };
    }
    // Also expose any user-created custom presets that aren't in built-ins
    for (const r of rows) {
      if (!items[r.preset]) {
        items[r.preset] = {
          ...this.getPreset(r.preset),
          accountCount: r.n,
        };
      }
    }
    return {
      categories: PROVIDER_CATEGORIES,
      items,
    };
  }

  #getProviderRanks() {
    const map = new Map();
    const rows = this.store.db
      .prepare('SELECT preset, rank FROM provider_priorities ORDER BY rank ASC')
      .all();
    for (const r of rows) map.set(r.preset, r.rank);
    return map;
  }

  #ensureProviderRank(preset) {
    const existing = this.store.db
      .prepare('SELECT rank FROM provider_priorities WHERE preset=?')
      .get(preset);
    if (existing) return existing.rank;
    const maxRow = this.store.db
      .prepare('SELECT COALESCE(MAX(rank), 0) AS maxRank FROM provider_priorities')
      .get();
    const nextRank = (maxRow?.maxRank ?? 0) + 1;
    this.store.db
      .prepare(
        'INSERT OR IGNORE INTO provider_priorities(preset, rank, updatedAt) VALUES(?,?,?)',
      )
      .run(preset, nextRank, Date.now());
    return nextRank;
  }

  #formatAccount(row, ranks, modelCounts) {
    const now = Date.now();
    const presetSpec = this.getPreset(row.preset);
    const cooldownUntil = Number(row.cooldownUntil ?? 0);
    const rateLimited = cooldownUntil > now;
    const effectiveStatus = rateLimited ? 'cooldown' : row.status;
    const models = parseJsonSafe(row.models, []);
    const modelProfiles = parseJsonSafe(row.modelProfiles, {});
    const balance = parseJsonSafe(row.balanceJson, null);
    const headers = parseJsonSafe(row.headers, {});
    const meta = parseJsonSafe(row.meta, {});
    const poolCount = modelCounts.get(row.id) ?? 0;
    return {
      id: row.id,
      preset: row.preset,
      presetName: presetSpec.name,
      category: row.category || presetSpec.category,
      protocol: meta.protocol || presetSpec.protocol,
      label: row.label,
      priority: row.priority,
      providerRank: ranks.get(row.preset) ?? 999,
      enabled: Boolean(row.enabled),
      endpoint: row.endpoint || presetSpec.defaultEndpoint || null,
      proxyUrl: row.proxyUrl || null,
      headers,
      models,
      modelProfiles,
      status: effectiveStatus,
      rateLimited,
      cooldownUntil,
      cooldownRemainingMs: rateLimited ? cooldownUntil - now : 0,
      lastError: row.lastError ?? null,
      lastErrorAt: row.lastErrorAt ?? null,
      lastSuccessAt: row.lastSuccessAt ?? null,
      balance,
      expiresAt: row.expiresAt ?? null,
      activeConns: this.activeConns.get(row.id) ?? 0,
      modelCount: Math.max(poolCount, models.length),
      credential: row.credentialMask ?? null,
      meta,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  listAccounts(filters = {}) {
    const rows = this.store.db
      .prepare('SELECT * FROM provider_accounts ORDER BY priority ASC, createdAt ASC')
      .all();
    const ranks = this.#getProviderRanks();
    const countRows = this.store.db
      .prepare('SELECT accountId, COUNT(*) AS n FROM pool_models GROUP BY accountId')
      .all();
    const modelCounts = new Map(countRows.map((r) => [r.accountId, r.n]));
    let list = rows.map((r) => this.#formatAccount(r, ranks, modelCounts));

    if (filters.preset && filters.preset !== 'all') {
      list = list.filter((a) => a.preset === filters.preset);
    }
    if (filters.enabled !== undefined && filters.enabled !== null) {
      const want =
        filters.enabled === true || filters.enabled === 'true';
      list = list.filter((a) => a.enabled === want);
    }
    if (filters.rateLimited !== undefined && filters.rateLimited !== null) {
      const want =
        filters.rateLimited === true || filters.rateLimited === 'true';
      list = list.filter((a) => a.rateLimited === want);
    }
    if (filters.model) {
      const target = String(filters.model).toLowerCase();
      list = list.filter(
        (a) =>
          !a.models.length ||
          a.models.some((m) => m.toLowerCase().includes(target)),
      );
    }
    if (filters.search) {
      const q = String(filters.search).trim().toLowerCase();
      if (q) {
        list = list.filter(
          (a) =>
            a.label.toLowerCase().includes(q) ||
            a.preset.toLowerCase().includes(q) ||
            a.presetName.toLowerCase().includes(q) ||
            (a.endpoint ?? '').toLowerCase().includes(q),
        );
      }
    }
    list.sort(
      (a, b) =>
        a.providerRank - b.providerRank ||
        a.priority - b.priority ||
        a.createdAt - b.createdAt,
    );
    return list;
  }

  getAccountRaw(accountId) {
    const row = this.store.db
      .prepare('SELECT * FROM provider_accounts WHERE id=?')
      .get(accountId);
    if (!row) throw new Fault('ACCOUNT_NOT_FOUND', 404);
    return row;
  }

  getAccount(accountId) {
    const row = this.getAccountRaw(accountId);
    const ranks = this.#getProviderRanks();
    const cnt =
      this.store.db
        .prepare('SELECT COUNT(*) AS n FROM pool_models WHERE accountId=?')
        .get(accountId)?.n ?? 0;
    return this.#formatAccount(row, ranks, new Map([[accountId, cnt]]));
  }

  createAccount(input, nativeSession = null) {
    const preset = String(input.preset || '').trim();
    if (!preset) throw new Fault('PRESET_REQUIRED', 400);
    const spec = this.getPreset(preset);
    const endpoint = validateEndpoint(input.endpoint ?? spec.defaultEndpoint ?? '');
    const secret = String(
      input.credential ?? input.apiKey ?? input.token ?? input.cookie ?? '',
    ).trim();
    const accountId = input.id?.trim() || uuid();
    const label = String(input.label || '').trim() || `${spec.name} 账号`;
    const priority = Number.isFinite(Number(input.priority))
      ? Math.max(0, Math.floor(Number(input.priority)))
      : 100;
    const enabled = input.enabled === false ? 0 : 1;
    const models = Array.isArray(input.models)
      ? input.models.map((m) => String(m).trim()).filter(Boolean)
      : [];
    const headers =
      input.headers && typeof input.headers === 'object' ? input.headers : {};
    const meta = {
      ...(input.meta && typeof input.meta === 'object' ? input.meta : {}),
      ...(input.protocol ? { protocol: input.protocol } : {}),
    };
    const now = Date.now();
    this.store.tx(() => {
      this.#ensureProviderRank(preset);
      this.store.db
        .prepare(
          `INSERT INTO provider_accounts(
            id, preset, label, category, priority, enabled, endpoint, proxyUrl,
            headers, models, modelProfiles, credentialEnc, credentialMask,
            status, lastError, lastErrorAt, cooldownUntil, lastSuccessAt,
            balanceJson, expiresAt, activeConns, meta, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'unknown',NULL,NULL,0,NULL,NULL,?,0,?,?,?)`,
        )
        .run(
          accountId,
          preset,
          label,
          input.category || spec.category,
          priority,
          enabled,
          endpoint,
          input.proxyUrl ? String(input.proxyUrl).trim() : null,
          JSON.stringify(headers),
          JSON.stringify(models),
          '{}',
          secret ? this.encrypt(secret) : null,
          nativeSession ? '网页登录' : secret ? maskSecret(secret) : null,
          nativeSession?.expiresAt || (input.expiresAt ? Number(input.expiresAt) : null),
          JSON.stringify(meta),
          now,
          now,
        );
      if (nativeSession) {
        this.store.db.prepare('INSERT INTO native_provider_sessions(accountId, encrypted) VALUES(?,?)')
          .run(accountId, this.encrypt(JSON.stringify(nativeSession)));
      }
      // Seed explicit user-entered models into pool_models immediately
      for (const m of models) {
        this.#upsertPoolModelTx(accountId, preset, m, { source: 'manual' });
      }
    });
    return this.getAccount(accountId);
  }

  updateAccount(accountId, patch) {
    const existing = this.getAccountRaw(accountId);
    const now = Date.now();
    const nextLabel =
      patch.label !== undefined ? String(patch.label).trim() || existing.label : existing.label;
    const nextPriority =
      patch.priority !== undefined && Number.isFinite(Number(patch.priority))
        ? Math.max(0, Math.floor(Number(patch.priority)))
        : existing.priority;
    const nextEnabled =
      patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled;
    const nextEndpoint =
      patch.endpoint !== undefined
        ? validateEndpoint(patch.endpoint)
        : existing.endpoint;
    const nextProxy =
      patch.proxyUrl !== undefined
        ? patch.proxyUrl
          ? String(patch.proxyUrl).trim()
          : null
        : existing.proxyUrl;
    const nextHeaders =
      patch.headers !== undefined
        ? JSON.stringify(patch.headers ?? {})
        : existing.headers;
    const nextModels =
      patch.models !== undefined
        ? JSON.stringify(
            Array.isArray(patch.models)
              ? patch.models.map((m) => String(m).trim()).filter(Boolean)
              : [],
          )
        : existing.models;
    const nextExpires =
      patch.expiresAt !== undefined
        ? patch.expiresAt
          ? Number(patch.expiresAt)
          : null
        : existing.expiresAt;
    const secret =
      patch.credential ?? patch.apiKey ?? patch.token ?? patch.cookie;
    const hasNewSecret = typeof secret === 'string' && secret.trim().length > 0;
    const nextCredEnc = hasNewSecret
      ? this.encrypt(secret.trim())
      : existing.credentialEnc;
    const nextCredMask = hasNewSecret
      ? maskSecret(secret.trim())
      : existing.credentialMask;
    const nextCooldown = patch.clearCooldown ? 0 : existing.cooldownUntil;
    const nextStatus = patch.clearCooldown ? 'unknown' : existing.status;

    this.store.tx(() => {
      this.store.db
        .prepare(
          `UPDATE provider_accounts
           SET label=?, priority=?, enabled=?, endpoint=?, proxyUrl=?, headers=?,
               models=?, credentialEnc=?, credentialMask=?, expiresAt=?,
               cooldownUntil=?, status=?, updatedAt=?
           WHERE id=?`,
        )
        .run(
          nextLabel,
          nextPriority,
          nextEnabled,
          nextEndpoint,
          nextProxy,
          nextHeaders,
          nextModels,
          nextCredEnc,
          nextCredMask,
          nextExpires,
          nextCooldown,
          nextStatus,
          now,
          accountId,
        );
      if (Array.isArray(patch.models)) {
        for (const m of patch.models.map((x) => String(x).trim()).filter(Boolean)) {
          this.#upsertPoolModelTx(accountId, existing.preset, m, {
            source: 'manual',
          });
        }
      }
    });
    return this.getAccount(accountId);
  }

  deleteAccount(accountId) {
    this.getAccountRaw(accountId);
    this.store.tx(() => {
      this.store.db
        .prepare('DELETE FROM pool_models WHERE accountId=?')
        .run(accountId);
      this.store.db
        .prepare('DELETE FROM model_mappings WHERE targetAccountId=?')
        .run(accountId);
      this.store.db
        .prepare('DELETE FROM provider_accounts WHERE id=?')
        .run(accountId);
    });
    return { id: accountId, deleted: true };
  }

  batchAccounts({ ids = [], action }) {
    const affected = [];
    this.store.tx(() => {
      for (const accountId of ids) {
        const row = this.store.db
          .prepare('SELECT id FROM provider_accounts WHERE id=?')
          .get(accountId);
        if (!row) continue;
        if (action === 'enable') {
          this.store.db
            .prepare('UPDATE provider_accounts SET enabled=1, updatedAt=? WHERE id=?')
            .run(Date.now(), accountId);
        } else if (action === 'disable') {
          this.store.db
            .prepare('UPDATE provider_accounts SET enabled=0, updatedAt=? WHERE id=?')
            .run(Date.now(), accountId);
        } else if (action === 'clear-cooldown') {
          this.store.db
            .prepare(
              "UPDATE provider_accounts SET cooldownUntil=0, status='unknown', lastError=NULL, updatedAt=? WHERE id=?",
            )
            .run(Date.now(), accountId);
          this.cooldownStrikes.delete(accountId);
        } else if (action === 'delete') {
          this.store.db
            .prepare('DELETE FROM pool_models WHERE accountId=?')
            .run(accountId);
          this.store.db
            .prepare('DELETE FROM model_mappings WHERE targetAccountId=?')
            .run(accountId);
          this.store.db
            .prepare('DELETE FROM provider_accounts WHERE id=?')
            .run(accountId);
        }
        affected.push(accountId);
      }
    });
    return { action, affected, count: affected.length };
  }

  setProviderPriorities(order = []) {
    const now = Date.now();
    this.store.tx(() => {
      let rank = 1;
      for (const preset of order) {
        const p = String(preset || '').trim();
        if (!p) continue;
        this.store.db
          .prepare(
            'INSERT INTO provider_priorities(preset, rank, updatedAt) VALUES(?,?,?) ON CONFLICT(preset) DO UPDATE SET rank=excluded.rank, updatedAt=excluded.updatedAt',
          )
          .run(p, rank++, now);
      }
    });
    return { order };
  }

  async #nativeSession(accountId, provider) {
    const existing = this.sessionRefreshes.get(accountId);
    if (existing) return existing;
    const record = this.store.db.prepare('SELECT encrypted FROM native_provider_sessions WHERE accountId=?').get(accountId);
    if (!record) throw new Error('账号已移除');
    const session = JSON.parse(this.decrypt(record.encrypted));
    if (!session.expiresAt || session.expiresAt > Date.now() + 30000) return session;
    const pending = provider.refresh(provider, session).then(next => this.store.tx(() => {
      const updated = this.store.db.prepare('UPDATE native_provider_sessions SET encrypted=? WHERE accountId=? AND encrypted=?')
        .run(this.encrypt(JSON.stringify(next)), accountId, record.encrypted);
      if (!updated.changes) throw new Error('账号已变更，请重试');
      this.store.db.prepare('UPDATE provider_accounts SET expiresAt=?, updatedAt=? WHERE id=?').run(next.expiresAt || null, Date.now(), accountId);
      return next;
    })).finally(() => this.sessionRefreshes.delete(accountId));
    this.sessionRefreshes.set(accountId, pending);
    return pending;
  }

  #buildUpstreamAuth(row) {
    const provider = nativeProviders.get(row.preset);
    if (provider && this.store.db.prepare('SELECT 1 FROM native_provider_sessions WHERE accountId=?').get(row.id)) {
      return { preset: row.preset, protocol: 'openai', endpoint: provider.endpoint, apiKey: '', customHeaders: {},
        fetch: (input, init) => nativeRequest(provider, () => this.#nativeSession(row.id, provider), input, init) };
    }
    const spec = this.getPreset(row.preset);
    const meta = parseJsonSafe(row.meta, {});
    const protocol = meta.protocol || spec.protocol || 'openai';
    const endpoint = (row.endpoint || spec.defaultEndpoint || '').replace(/\/+$/, '');
    const apiKey = this.decrypt(row.credentialEnc);
    const customHeaders = parseJsonSafe(row.headers, {});
    return { protocol, endpoint, apiKey, customHeaders, preset: row.preset };
  }

  async #fetchUpstreamModels(row) {
    const rawAuth = this.#buildUpstreamAuth(row);
    const { protocol, endpoint, apiKey, customHeaders } =
      await resolveEffectiveRoute(
        { ...rawAuth, accountId: row.id },
        this.copilotTokenCache,
      );
    if (!endpoint) throw new Error('未配置上游 Endpoint 地址');

    if (protocol === 'anthropic') {
      const url = endpoint.endsWith('/v1')
        ? `${endpoint}/models`
        : `${endpoint}/v1/models`;
      const res = await fetch(url, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...customHeaders,
        },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const json = await res.json();
        const data = Array.isArray(json?.data) ? json.data : [];
        const ids = data.map((m) => m.id).filter(Boolean);
        if (ids.length) return ids;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Anthropic 鉴权失败 (HTTP ${res.status})`);
      }
      // Some Anthropic proxies don't implement /v1/models; fall back to standard Claude list
      return [...ANTHROPIC_FALLBACK_MODELS];
    }

    const url = `${endpoint}/models`;
    const headers = {
      Accept: 'application/json',
      ...customHeaders,
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
      headers['x-api-key'] = apiKey;
    }
    const res = await (rawAuth.fetch ?? fetch)(url, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(
        `HTTP ${res.status}${txt ? `: ${txt.slice(0, 160)}` : ''}`,
      );
    }
    const json = await res.json();
    const list = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.models)
        ? json.models
        : Array.isArray(json)
          ? json
          : [];
    return list
      .map((item) => {
        if (typeof item === 'string') return { id: item };
        const id = item?.id || item?.name;
        if (!id) return null;
        const ctx = Number(
          item.max_input_tokens ??
            item.context_window ??
            item.context_length ??
            item.input_token_limit ??
            0,
        );
        const maxOut = Number(
          item.max_output_tokens ??
            item.max_completion_tokens ??
            item.top_provider?.max_completion_tokens ??
            item.output_token_limit ??
            0,
        );
        const mods = Array.isArray(item.input_modalities)
          ? item.input_modalities.map((x) => String(x).toLowerCase())
          : null;
        return {
          id: String(id),
          ownedBy: item.owned_by ? String(item.owned_by).toLowerCase() : undefined,
          displayName: item.name && item.name !== id ? String(item.name) : undefined,
          contextWindow: Number.isFinite(ctx) && ctx > 0 ? ctx : undefined,
          maxOutput: Number.isFinite(maxOut) && maxOut > 0 ? maxOut : undefined,
          vision: mods ? mods.includes('image') || mods.includes('vision') : undefined,
        };
      })
      .filter(Boolean);
  }

  #upsertPoolModelTx(accountId, preset, upstreamModel, opts = {}) {
    const profile = inferModelProfile(upstreamModel, preset);
    const mergedCaps = {
      ...profile.capabilities,
      ...(opts.capabilities ?? {}),
      ...(opts.vision !== undefined ? { vision: Boolean(opts.vision) } : {}),
    };
    const now = Date.now();
    const existing = this.store.db
      .prepare(
        'SELECT id, contextWindow, maxOutput, capabilities, displayName FROM pool_models WHERE accountId=? AND upstreamModel=?',
      )
      .get(accountId, upstreamModel);
    if (existing) {
      this.store.db
        .prepare(
          'UPDATE pool_models SET displayName=?, contextWindow=?, maxOutput=?, capabilities=?, updatedAt=? WHERE id=?',
        )
        .run(
          opts.displayName ?? existing.displayName ?? upstreamModel,
          opts.contextWindow ?? existing.contextWindow ?? profile.contextWindow,
          opts.maxOutput ?? existing.maxOutput ?? profile.maxOutput,
          opts.vision !== undefined || opts.capabilities
            ? JSON.stringify(mergedCaps)
            : existing.capabilities,
          now,
          existing.id,
        );
      return existing.id;
    }
    const modelId = uuid();
    this.store.db
      .prepare(
        `INSERT INTO pool_models(
          id, accountId, preset, upstreamModel, displayName, enabled, visible,
          source, multiplier, contextWindow, maxOutput, capabilities, createdAt, updatedAt
        ) VALUES(?,?,?,?,?,1,1,?,?,?,?,?,?,?)`,
      )
      .run(
        modelId,
        accountId,
        preset,
        upstreamModel,
        opts.displayName ?? upstreamModel,
        opts.source ?? 'remote',
        opts.multiplier ?? 1.0,
        opts.contextWindow ?? profile.contextWindow,
        opts.maxOutput ?? profile.maxOutput,
        JSON.stringify(mergedCaps),
        now,
        now,
      );
    // Ensure a default 1:1 mapping exists for this upstream model
    const mapExists = this.store.db
      .prepare(
        'SELECT id FROM model_mappings WHERE alias=? AND targetPreset=? AND targetModel=?',
      )
      .get(upstreamModel, preset, upstreamModel);
    if (!mapExists) {
      this.store.db
        .prepare(
          `INSERT INTO model_mappings(
            id, alias, targetPreset, targetAccountId, targetModel, enabled, isDefault, priority, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,1,1,100,?,?)`,
        )
        .run(uuid(), upstreamModel, preset, null, upstreamModel, now, now);
    }
    return modelId;
  }

  async testAccount(accountId) {
    return withTraceContext({ trafficSource: 'probe', isSynthetic: true, accountId }, async () => {
      const row = this.getAccountRaw(accountId);
      const started = Date.now();
      try {
        const discovered = await this.#fetchUpstreamModels(row);
        const latencyMs = Date.now() - started;
        const now = Date.now();
        this.store.tx(() => {
          this.store.db
            .prepare(
              "UPDATE provider_accounts SET status='healthy', lastError=NULL, lastErrorAt=NULL, cooldownUntil=0, lastSuccessAt=?, updatedAt=? WHERE id=?",
            )
            .run(now, now, accountId);
        });
        this.cooldownStrikes.delete(accountId);
        return {
          ...this.getAccount(accountId),
          ok: true,
          latencyMs,
          discoveredCount: discovered.length,
        };
      } catch (err) {
        const latencyMs = Date.now() - started;
        const now = Date.now();
        const message = String(err?.message ?? err);
        this.store.tx(() => {
          this.store.db
            .prepare(
              "UPDATE provider_accounts SET status='unhealthy', lastError=?, lastErrorAt=?, updatedAt=? WHERE id=?",
            )
            .run(message.slice(0, 500), now, now, accountId);
        });
        return {
          ...this.getAccount(accountId),
          ok: false,
          latencyMs,
          error: message,
        };
      }
    });
  }

  async syncAccountModels(accountId) {
    const row = this.getAccountRaw(accountId);
    const started = Date.now();
    const rawDiscovered = await this.#fetchUpstreamModels(row);
    const discoveredEntries = rawDiscovered.map((item) =>
      typeof item === 'string' ? { id: item } : item,
    );
    const filterList = parseJsonSafe(row.models, []);
    const presetSpec = this.getPreset(row.preset);
    const channelOwner =
      presetSpec.kind === 'agent-bridge' || presetSpec.kind === 'web-bridge'
        ? String(presetSpec.ownedBy || '').toLowerCase()
        : '';
    const byOwner =
      filterList.length === 0 && channelOwner
        ? discoveredEntries.filter(
            (m) => m.ownedBy && m.ownedBy === channelOwner,
          )
        : [];
    const selected =
      filterList.length > 0
        ? discoveredEntries.filter((m) => filterList.includes(m.id))
        : byOwner.length > 0
          ? byOwner
          : discoveredEntries;
    const finalEntries = selected.length > 0 ? selected : discoveredEntries;
    const finalList = finalEntries.map((m) => m.id);
    const profiles = {};
    const now = Date.now();

    this.store.tx(() => {
      for (const entry of finalEntries.slice(0, 500)) {
        const m = entry.id;
        const inferred = inferModelProfile(m, row.preset);
        profiles[m] = {
          ...inferred,
          ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
          ...(entry.maxOutput ? { maxOutput: entry.maxOutput } : {}),
          ...(entry.vision !== undefined
            ? { capabilities: { ...inferred.capabilities, vision: entry.vision } }
            : {}),
        };
        this.#upsertPoolModelTx(accountId, row.preset, m, {
          source: 'remote',
          displayName: entry.displayName,
          contextWindow: entry.contextWindow,
          maxOutput: entry.maxOutput,
          vision: entry.vision,
        });
      }
      this.store.db
        .prepare(
          "UPDATE provider_accounts SET models=?, modelProfiles=?, status='healthy', lastError=NULL, lastErrorAt=NULL, cooldownUntil=0, lastSuccessAt=?, updatedAt=? WHERE id=?",
        )
        .run(
          JSON.stringify(finalList.slice(0, 500)),
          JSON.stringify(profiles),
          now,
          now,
          accountId,
        );
    });

    // If no defaultModel is chosen yet, pick the first good coding model
    if (!this.store.getSetting('pool.default_model') && finalList.length > 0) {
      this.store.setSetting('pool.default_model', finalList[0]);
    }

    return {
      account: this.getAccount(accountId),
      models: finalList.slice(0, 500).map((m) => profiles[m]),
      latencyMs: Date.now() - started,
    };
  }

  async syncProviderModels(preset = null) {
    const accounts = this.listAccounts({
      ...(preset && preset !== 'all' ? { preset } : {}),
      enabled: true,
    });
    const results = [];
    for (const acc of accounts) {
      try {
        const res = await this.syncAccountModels(acc.id);
        results.push({
          accountId: acc.id,
          preset: acc.preset,
          label: acc.label,
          ok: true,
          count: res.models.length,
          latencyMs: res.latencyMs,
        });
      } catch (err) {
        results.push({
          accountId: acc.id,
          preset: acc.preset,
          label: acc.label,
          ok: false,
          count: 0,
          error: String(err?.message ?? err),
        });
      }
    }
    return {
      syncedAccounts: results.filter((r) => r.ok).length,
      totalAccounts: results.length,
      results,
    };
  }

  async queryAccountBalance(accountId) {
    const row = this.getAccountRaw(accountId);
    const { endpoint, apiKey, customHeaders, preset } =
      this.#buildUpstreamAuth(row);
    const now = Date.now();
    let balance = null;

    try {
      if (preset === 'deepseek') {
        const root = endpoint.replace(/\/v1$/, '');
        const res = await fetch(`${root}/user/balance`, {
          headers: { Authorization: `Bearer ${apiKey}`, ...customHeaders },
          signal: AbortSignal.timeout(6000),
        });
        if (res.ok) {
          const data = await res.json();
          const info = data?.balance_infos?.[0];
          balance = {
            supported: true,
            amount: Number(info?.total_balance ?? 0),
            currency: info?.currency ?? 'CNY',
            unit: info?.currency ?? 'CNY',
            display: `${info?.total_balance ?? '0'} ${info?.currency ?? 'CNY'}`,
            checkedAt: now,
          };
        }
      } else if (preset === 'openrouter') {
        const res = await fetch(`${endpoint}/auth/key`, {
          headers: { Authorization: `Bearer ${apiKey}`, ...customHeaders },
          signal: AbortSignal.timeout(6000),
        });
        if (res.ok) {
          const data = await res.json();
          const rem =
            data?.data?.limit_remaining ??
            (data?.data?.limit != null
              ? data.data.limit - (data.data.usage ?? 0)
              : null);
          balance = {
            supported: true,
            amount: rem,
            currency: 'USD',
            unit: 'USD',
            display:
              rem != null
                ? `$${Number(rem).toFixed(2)}`
                : `已用 $${Number(data?.data?.usage ?? 0).toFixed(2)}`,
            checkedAt: now,
          };
        }
      } else if (preset === 'siliconflow') {
        const res = await fetch(`${endpoint}/user/info`, {
          headers: { Authorization: `Bearer ${apiKey}`, ...customHeaders },
          signal: AbortSignal.timeout(6000),
        });
        if (res.ok) {
          const data = await res.json();
          const total = data?.data?.totalBalance ?? data?.data?.balance;
          balance = {
            supported: true,
            amount: Number(total ?? 0),
            currency: 'CNY',
            unit: 'CNY',
            display: `¥${total ?? '0'}`,
            checkedAt: now,
          };
        }
      } else if (preset === 'kimi') {
        const res = await fetch(`${endpoint}/users/me/balance`, {
          headers: { Authorization: `Bearer ${apiKey}`, ...customHeaders },
          signal: AbortSignal.timeout(6000),
        });
        if (res.ok) {
          const data = await res.json();
          const avail = data?.data?.available_balance;
          balance = {
            supported: true,
            amount: Number(avail ?? 0),
            currency: 'CNY',
            unit: 'CNY',
            display: `¥${Number(avail ?? 0).toFixed(2)}`,
            checkedAt: now,
          };
        }
      } else if (preset === 'agent2api') {
        const root = endpoint.replace(/\/v1$/, '');
        const headers = { Accept: 'application/json', ...customHeaders };
        if (apiKey) {
          headers['x-api-key'] = apiKey;
          headers.Authorization = `Bearer ${apiKey}`;
        }
        const res = await fetch(`${root}/api/accounts`, {
          headers,
          signal: AbortSignal.timeout(6000),
        });
        if (res.ok) {
          const data = await res.json();
          const accs = Array.isArray(data?.accounts)
            ? data.accounts
            : Array.isArray(data)
              ? data
              : [];
          const enabledCount = accs.filter((a) => a.enabled !== false).length;
          balance = {
            supported: true,
            amount: enabledCount,
            unit: '账号',
            display: `${enabledCount}/${accs.length} 个上游账号可用`,
            checkedAt: now,
          };
        }
      }
    } catch (err) {
      balance = {
        supported: false,
        display: '查询失败',
        error: String(err?.message ?? err),
        checkedAt: now,
      };
    }

    if (!balance) {
      balance = {
        supported: false,
        display: '不支持余额接口',
        checkedAt: now,
      };
    }

    this.store.tx(() => {
      this.store.db
        .prepare(
          'UPDATE provider_accounts SET balanceJson=?, updatedAt=? WHERE id=?',
        )
        .run(JSON.stringify(balance), now, accountId);
    });
    return { account: this.getAccount(accountId), balance };
  }

  async queryAllBalances() {
    const accounts = this.listAccounts({ enabled: true });
    const items = [];
    for (const acc of accounts) {
      items.push(await this.queryAccountBalance(acc.id));
    }
    return { items };
  }

  async importLocalAccounts() {
    const created = [];
    const existing = this.listAccounts();
    const knownEndpoints = new Set(
      existing
        .map((a) => (a.endpoint || '').replace(/\/+$/, ''))
        .filter(Boolean),
    );
    const hasEndpoint = (ep) => knownEndpoints.has(ep.replace(/\/+$/, ''));

    // 1. Import from backend/var/config.json + .provider-env.json first (preserves saved API keys!)
    const envFilePath = join(this.root, '.provider-env.json');
    let savedEnv = {};
    if (existsSync(envFilePath)) {
      try {
        savedEnv = JSON.parse(readFileSync(envFilePath, 'utf8')) || {};
      } catch {
        savedEnv = {};
      }
    }
    const cfgPath = join(this.root, 'config.json');
    if (existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        for (const p of cfg.providers ?? []) {
          const ep = String(p.endpoint || '').replace(/\/+$/, '');
          if (!ep || hasEndpoint(ep)) continue;
          const key = p.keyRef ? process.env[p.keyRef] || savedEnv[p.keyRef] || '' : '';
          const models = (cfg.models ?? [])
            .filter((m) => m.provider === p.id)
            .map((m) => m.model);
          const inferredPreset = PROVIDER_PRESETS[p.id]
            ? p.id
            : /:3065(\/|$)/.test(ep)
              ? 'agent2api'
              : 'custom-openai';
          const acc = this.createAccount({
            preset: inferredPreset,
            label: inferredPreset === 'agent2api' ? '本机 Agent2API' : `导入 · ${p.id}`,
            endpoint: ep,
            credential: key || undefined,
            models,
          });
          knownEndpoints.add(ep);
          created.push(acc);
        }
      } catch {
        // ignore invalid local config
      }
    }

    // 2. Auto-detect local runtimes & optional user-run OpenAI-compatible relays
    const probes = [
      {
        preset: 'agent2api',
        label: '本机 Agent2API',
        healthUrl: 'http://127.0.0.1:3065/health',
        endpoint: 'http://127.0.0.1:3065/v1',
      },
      {
        preset: 'ollama',
        label: '本机 Ollama',
        healthUrl: 'http://127.0.0.1:11434/api/tags',
        endpoint: 'http://127.0.0.1:11434/v1',
      },
      {
        preset: 'lmstudio',
        label: '本机 LM Studio',
        healthUrl: 'http://127.0.0.1:1234/v1/models',
        endpoint: 'http://127.0.0.1:1234/v1',
      },
    ];
    for (const p of probes) {
      if (hasEndpoint(p.endpoint)) continue;
      try {
        const res = await fetch(p.healthUrl, {
          signal: AbortSignal.timeout(1200),
        });
        if (res.ok || res.status === 401) {
          const acc = this.createAccount({
            preset: p.preset,
            label: p.label,
            endpoint: p.endpoint,
          });
          knownEndpoints.add(p.endpoint.replace(/\/+$/, ''));
          created.push(acc);
        }
      } catch {
        // not running locally
      }
    }

    return { items: created };
  }

  // ---- Model Management Hub ----

  listPoolModels(filters = {}) {
    const rows = this.store.db
      .prepare(
        `SELECT pm.*, pa.label AS accountLabel, pa.enabled AS accountEnabled, pa.status AS accountStatus
         FROM pool_models pm
         JOIN provider_accounts pa ON pa.id = pm.accountId
         ORDER BY pm.preset ASC, pm.upstreamModel ASC`,
      )
      .all();
    const mappingRows = this.store.db
      .prepare('SELECT * FROM model_mappings ORDER BY priority ASC, alias ASC')
      .all();
    const ranks = this.#getProviderRanks();

    // Group by (preset, upstreamModel) so multi-account same-model collapses neatly like Screenshot 4
    const modelMap = new Map();
    for (const r of rows) {
      const key = `${r.preset}::${r.upstreamModel}`;
      const caps = parseJsonSafe(r.capabilities, {});
      const entry = modelMap.get(key) ?? {
        id: r.id,
        ids: [],
        preset: r.preset,
        presetName: this.getPreset(r.preset).name,
        providerRank: ranks.get(r.preset) ?? 999,
        upstreamModel: r.upstreamModel,
        displayName: r.displayName || r.upstreamModel,
        enabled: false,
        visible: false,
        source: r.source,
        multiplier: r.multiplier,
        contextWindow: r.contextWindow,
        maxOutput: r.maxOutput,
        capabilities: caps,
        accountIds: [],
        activeAccountCount: 0,
        mappings: [],
      };
      entry.ids.push(r.id);
      entry.accountIds.push(r.accountId);
      if (r.enabled) entry.enabled = true;
      if (r.visible) entry.visible = true;
      if (r.accountEnabled) entry.activeAccountCount += 1;
      modelMap.set(key, entry);
    }

    // Attach mappings to matching models & track unmounted mappings
    const unmountedMappings = [];
    for (const m of mappingRows) {
      const mappedObj = {
        id: m.id,
        alias: m.alias,
        targetPreset: m.targetPreset,
        targetAccountId: m.targetAccountId,
        targetModel: m.targetModel,
        enabled: Boolean(m.enabled),
        isDefault: Boolean(m.isDefault),
        priority: m.priority,
      };
      let mounted = false;
      for (const entry of modelMap.values()) {
        if (
          entry.upstreamModel === m.targetModel &&
          (!m.targetPreset || entry.preset === m.targetPreset)
        ) {
          entry.mappings.push(mappedObj);
          mounted = true;
        }
      }
      if (!mounted) unmountedMappings.push(mappedObj);
    }

    // Compute per-provider counts BEFORE filtering
    const providerCounts = new Map();
    for (const entry of modelMap.values()) {
      providerCounts.set(
        entry.preset,
        (providerCounts.get(entry.preset) ?? 0) + 1,
      );
    }
    const providers = [...providerCounts.entries()]
      .map(([preset, count]) => ({
        id: preset,
        name: this.getPreset(preset).name,
        icon: this.getPreset(preset).icon,
        color: this.getPreset(preset).color,
        category: this.getPreset(preset).category,
        rank: ranks.get(preset) ?? 999,
        modelCount: count,
      }))
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

    let items = [...modelMap.values()].sort(
      (a, b) =>
        a.providerRank - b.providerRank ||
        a.preset.localeCompare(b.preset) ||
        a.upstreamModel.localeCompare(b.upstreamModel),
    );

    const totalCount = items.length;
    const enabledCount = items.filter((i) => i.enabled).length;
    const mappedCount = items.filter((i) =>
      i.mappings.some((m) => m.enabled && !m.isDefault),
    ).length;

    if (filters.preset && filters.preset !== 'all') {
      items = items.filter((i) => i.preset === filters.preset);
    }
    if (filters.status === 'enabled') {
      items = items.filter((i) => i.enabled);
    } else if (filters.status === 'disabled') {
      items = items.filter((i) => !i.enabled);
    } else if (filters.status === 'mapped') {
      items = items.filter((i) =>
        i.mappings.some((m) => m.enabled),
      );
    }
    if (filters.visibility === 'visible') {
      items = items.filter((i) => i.visible);
    } else if (filters.visibility === 'hidden') {
      items = items.filter((i) => !i.visible);
    }
    if (filters.search) {
      const q = String(filters.search).trim().toLowerCase();
      if (q) {
        items = items.filter(
          (i) =>
            i.upstreamModel.toLowerCase().includes(q) ||
            i.displayName.toLowerCase().includes(q) ||
            i.presetName.toLowerCase().includes(q) ||
            i.mappings.some((m) => m.alias.toLowerCase().includes(q)),
        );
      }
    }

    return {
      totalCount,
      enabledCount,
      mappedCount,
      defaultModel: this.getDefaultModel(),
      providers,
      items,
      unmountedMappings,
    };
  }

  addManualModel(input) {
    const upstreamModel = String(input.upstreamModel || input.model || '').trim();
    if (!upstreamModel) throw new Fault('MODEL_REQUIRED', 400);
    let accountId = input.accountId;
    let preset = input.preset;
    if (!accountId) {
      const row = this.store.db
        .prepare(
          preset
            ? 'SELECT id, preset FROM provider_accounts WHERE preset=? ORDER BY priority ASC LIMIT 1'
            : 'SELECT id, preset FROM provider_accounts ORDER BY priority ASC LIMIT 1',
        )
        .get(...(preset ? [preset] : []));
      if (!row) throw new Fault('NO_ACCOUNT_FOR_MODEL', 400);
      accountId = row.id;
      preset = row.preset;
    } else {
      const acc = this.getAccountRaw(accountId);
      preset = acc.preset;
    }
    const id = this.store.tx(() =>
      this.#upsertPoolModelTx(accountId, preset, upstreamModel, {
        displayName: input.displayName || upstreamModel,
        source: 'manual',
        multiplier: Number(input.multiplier ?? 1),
        contextWindow: Number(input.contextWindow ?? 128000),
        maxOutput: Number(input.maxOutput ?? 16384),
        capabilities: input.capabilities,
      }),
    );
    return { id, accountId, preset, upstreamModel };
  }

  updatePoolModel(modelId, patch) {
    const row = this.store.db
      .prepare('SELECT * FROM pool_models WHERE id=?')
      .get(modelId);
    if (!row) throw new Fault('MODEL_NOT_FOUND', 404);
    const now = Date.now();
    // Apply across all accounts sharing this preset + upstreamModel when applyGroup is true (default)
    const applyGroup = patch.applyGroup !== false;
    this.store.tx(() => {
      const targets = applyGroup
        ? this.store.db
            .prepare(
              'SELECT * FROM pool_models WHERE preset=? AND upstreamModel=?',
            )
            .all(row.preset, row.upstreamModel)
        : [row];
      for (const t of targets) {
        this.store.db
          .prepare(
            `UPDATE pool_models
             SET enabled=?, visible=?, multiplier=?, contextWindow=?, maxOutput=?, capabilities=?, displayName=?, updatedAt=?
             WHERE id=?`,
          )
          .run(
            patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : t.enabled,
            patch.visible !== undefined ? (patch.visible ? 1 : 0) : t.visible,
            patch.multiplier !== undefined ? Number(patch.multiplier) : t.multiplier,
            patch.contextWindow !== undefined
              ? Number(patch.contextWindow)
              : t.contextWindow,
            patch.maxOutput !== undefined ? Number(patch.maxOutput) : t.maxOutput,
            patch.capabilities !== undefined
              ? JSON.stringify(patch.capabilities)
              : t.capabilities,
            patch.displayName !== undefined
              ? String(patch.displayName)
              : t.displayName,
            now,
            t.id,
          );
      }
    });
    return { id: modelId, updated: true };
  }

  deletePoolModel(modelId) {
    const row = this.store.db
      .prepare('SELECT * FROM pool_models WHERE id=?')
      .get(modelId);
    if (!row) throw new Fault('MODEL_NOT_FOUND', 404);
    this.store.tx(() => {
      this.store.db
        .prepare('DELETE FROM pool_models WHERE preset=? AND upstreamModel=?')
        .run(row.preset, row.upstreamModel);
    });
    return { id: modelId, deleted: true };
  }

  upsertMapping(input) {
    const alias = String(input.alias || '').trim();
    const targetModel = String(input.targetModel || '').trim();
    if (!alias || !targetModel) throw new Fault('INVALID_MAPPING', 400);
    const now = Date.now();
    const mappingId = input.id?.trim() || uuid();
    const enabled = input.enabled === false ? 0 : 1;
    const isDefault = input.isDefault ? 1 : 0;
    const priority = Number.isFinite(Number(input.priority))
      ? Number(input.priority)
      : 100;
    this.store.tx(() => {
      const existing = input.id
        ? this.store.db
            .prepare('SELECT id FROM model_mappings WHERE id=?')
            .get(input.id)
        : null;
      if (existing) {
        this.store.db
          .prepare(
            `UPDATE model_mappings
             SET alias=?, targetPreset=?, targetAccountId=?, targetModel=?, enabled=?, isDefault=?, priority=?, updatedAt=?
             WHERE id=?`,
          )
          .run(
            alias,
            input.targetPreset ?? null,
            input.targetAccountId ?? null,
            targetModel,
            enabled,
            isDefault,
            priority,
            now,
            existing.id,
          );
      } else {
        this.store.db
          .prepare(
            `INSERT INTO model_mappings(
              id, alias, targetPreset, targetAccountId, targetModel, enabled, isDefault, priority, createdAt, updatedAt
            ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            mappingId,
            alias,
            input.targetPreset ?? null,
            input.targetAccountId ?? null,
            targetModel,
            enabled,
            isDefault,
            priority,
            now,
            now,
          );
      }
    });
    return this.store.db
      .prepare('SELECT * FROM model_mappings WHERE id=?')
      .get(mappingId);
  }

  deleteMapping(mappingId) {
    this.store.tx(() => {
      this.store.db
        .prepare('DELETE FROM model_mappings WHERE id=?')
        .run(mappingId);
    });
    return { id: mappingId, deleted: true };
  }

  getDefaultModel() {
    const saved = this.store.getSetting('pool.default_model');
    if (saved) return String(saved);
    const first = this.store.db
      .prepare(
        `SELECT pm.upstreamModel
         FROM pool_models pm
         JOIN provider_accounts pa ON pa.id = pm.accountId
         WHERE pm.enabled=1 AND pm.visible=1 AND pa.enabled=1
         ORDER BY pa.priority ASC, pm.upstreamModel ASC LIMIT 1`,
      )
      .get();
    return first?.upstreamModel || this.legacyProviders?.models?.[0]?.model || '';
  }

  setDefaultModel(model) {
    this.store.setSetting('pool.default_model', String(model || '').trim());
    return { defaultModel: this.getDefaultModel() };
  }

  getModelContextWindow(modelName) {
    const target = String(modelName || this.getDefaultModel() || '').trim();
    if (!target) return 128000;
    const direct = this.store.db
      .prepare(
        'SELECT contextWindow FROM pool_models WHERE upstreamModel=? AND enabled=1 ORDER BY contextWindow DESC LIMIT 1',
      )
      .get(target);
    if (direct?.contextWindow) return Number(direct.contextWindow);
    const mapped = this.store.db
      .prepare(
        `SELECT pm.contextWindow FROM model_mappings mm
         JOIN pool_models pm ON pm.upstreamModel = mm.targetModel
         WHERE mm.alias=? AND mm.enabled=1 AND pm.enabled=1
         ORDER BY mm.priority ASC LIMIT 1`,
      )
      .get(target);
    if (mapped?.contextWindow) return Number(mapped.contextWindow);
    return inferModelProfile(target).contextWindow;
  }

  getModelMaxOutput(modelName) {
    const target = String(modelName || this.getDefaultModel() || '').trim();
    if (!target) return 16384;
    const direct = this.store.db
      .prepare(
        'SELECT maxOutput FROM pool_models WHERE upstreamModel=? AND enabled=1 ORDER BY maxOutput DESC LIMIT 1',
      )
      .get(target);
    if (direct?.maxOutput) return Number(direct.maxOutput);
    const mapped = this.store.db
      .prepare(
        `SELECT pm.maxOutput FROM model_mappings mm
         JOIN pool_models pm ON pm.upstreamModel = mm.targetModel
         WHERE mm.alias=? AND mm.enabled=1 AND pm.enabled=1
         ORDER BY mm.priority ASC LIMIT 1`,
      )
      .get(target);
    if (mapped?.maxOutput) return Number(mapped.maxOutput);
    return inferModelProfile(target).maxOutput ?? 16384;
  }

  // Unified catalog consumed by frontend /v1/models, DirectAgent, and OpenAI clients
  getActiveCatalog() {
    const pool = this.listPoolModels({ status: 'enabled', visibility: 'visible' });
    const aliasMap = new Map();
    const profiles = {};

    for (const item of pool.items) {
      if (item.activeAccountCount <= 0) continue;
      const enabledMappings = item.mappings.filter((m) => m.enabled);
      const aliases = enabledMappings.length
        ? enabledMappings.map((m) => m.alias)
        : [item.upstreamModel];
      for (const alias of aliases) {
        const list = aliasMap.get(alias) ?? [];
        if (
          !list.some(
            (t) => t.provider === item.preset && t.model === item.upstreamModel,
          )
        ) {
          list.push({ provider: item.preset, model: item.upstreamModel });
        }
        aliasMap.set(alias, list);
        if (!profiles[alias]) {
          profiles[alias] = {
            contextWindow: item.contextWindow,
            maxOutput: item.maxOutput,
            capabilities: item.capabilities,
            multiplier: item.multiplier,
          };
        }
      }
    }

    // Merge legacy static config models as fallback
    for (const m of this.legacyProviders?.models ?? []) {
      const list = aliasMap.get(m.model) ?? [];
      if (!list.some((t) => t.provider === m.provider && t.model === m.model)) {
        list.push({ provider: m.provider, model: m.model });
      }
      aliasMap.set(m.model, list);
    }

    const items = [...aliasMap.entries()].map(([alias, targets]) => ({
      alias,
      targets,
    }));
    const defaultModel =
      this.store.getSetting('pool.default_model') || items[0]?.alias || '';

    return {
      defaultModel,
      items,
      profiles,
      // Standard OpenAI /v1/models compatibility array:
      object: 'list',
      data: items.map((i) => ({
        id: i.alias,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: i.targets[0]?.provider ?? 'agent-us',
      })),
    };
  }

  getEngineModels() {
    const catalog = this.getActiveCatalog();
    const list = [];
    for (const item of catalog.items) {
      const first = item.targets[0];
      if (!first) continue;
      const prof = inferModelProfile(first.model, first.provider);
      list.push({
        provider: first.provider,
        model: item.alias,
        design: prof.design,
        coding: prof.coding,
        math: prof.math,
        research: prof.research,
        speed: prof.speed,
        context: prof.contextWindow,
        tools: prof.capabilities.tools,
        inputRate: prof.inputRate,
        outputRate: prof.outputRate,
      });
    }
    return list;
  }

  // ---- Routing, Stickiness, Failover & Cooldown ----

  resolveRoutes(
    requestedModel,
    { provider = null, sessionKey = null, excludeAccountIds = null } = {},
  ) {
    const now = Date.now();
    const reqModel = String(requestedModel || this.getDefaultModel() || '').trim();
    const ranks = this.#getProviderRanks();
    const excludedSet = new Set(
      excludeAccountIds
        ? [...excludeAccountIds].filter(Boolean).map(String)
        : [],
    );

    // 1. Determine candidate (preset, targetAccountId, wireModel) pairs from mappings + pool_models
    const pairs = [];
    const seenPair = new Set();
    const pushPair = (targetPreset, targetAccountId, wireModel, mapPriority = 100) => {
      const k = `${targetPreset ?? '*'}::${targetAccountId ?? '*'}::${wireModel}`;
      if (seenPair.has(k)) return;
      seenPair.add(k);
      pairs.push({ targetPreset, targetAccountId, wireModel, mapPriority });
    };

    // Explicit "preset/model" syntax
    if (reqModel.includes('/')) {
      const slash = reqModel.indexOf('/');
      const maybePreset = reqModel.slice(0, slash);
      const restModel = reqModel.slice(slash + 1);
      const hasPresetAcc = this.store.db
        .prepare('SELECT 1 FROM provider_accounts WHERE preset=? AND enabled=1 LIMIT 1')
        .get(maybePreset);
      if (hasPresetAcc) {
        pushPair(maybePreset, null, restModel, 1);
      }
    }

    // Active alias mappings matching requestedModel
    const mappingRows = this.store.db
      .prepare(
        'SELECT * FROM model_mappings WHERE alias=? AND enabled=1 ORDER BY priority ASC',
      )
      .all(reqModel);
    for (const m of mappingRows) {
      if (provider && m.targetPreset && m.targetPreset !== provider) continue;
      pushPair(m.targetPreset, m.targetAccountId, m.targetModel, m.priority);
    }

    // Direct pool_models match
    const directRows = this.store.db
      .prepare(
        'SELECT DISTINCT preset, accountId, upstreamModel FROM pool_models WHERE upstreamModel=? AND enabled=1',
      )
      .all(reqModel);
    for (const d of directRows) {
      if (provider && d.preset !== provider) continue;
      pushPair(d.preset, d.accountId, d.upstreamModel, 100);
    }

    // Fallback: if model wasn't explicitly synced yet, match enabled accounts for requested provider or any enabled account
    if (pairs.length === 0 && reqModel) {
      const enabledRows = this.store.db
        .prepare(
          provider
            ? 'SELECT id, preset FROM provider_accounts WHERE enabled=1 AND preset=?'
            : 'SELECT id, preset FROM provider_accounts WHERE enabled=1',
        )
        .all(...(provider ? [provider] : []));
      for (const a of enabledRows) {
        pushPair(a.preset, a.id, reqModel, 200);
      }
    }

    // Expand pairs into concrete enabled accounts
    const allEnabled = this.store.db
      .prepare('SELECT * FROM provider_accounts WHERE enabled=1')
      .all();
    const candidates = [];
    const seenRoute = new Set();

    for (const p of pairs) {
      for (const acc of allEnabled) {
        if (excludedSet.has(acc.id)) continue;
        if (p.targetAccountId && acc.id !== p.targetAccountId) continue;
        if (p.targetPreset && acc.preset !== p.targetPreset) continue;
        const routeKey = `${acc.id}::${p.wireModel}`;
        if (seenRoute.has(routeKey)) continue;
        seenRoute.add(routeKey);
        const auth = this.#buildUpstreamAuth(acc);
        if (!auth.endpoint) continue;
        candidates.push({
          source: 'pool',
          accountId: acc.id,
          preset: acc.preset,
          label: acc.label,
          protocol: auth.protocol,
          endpoint: auth.endpoint,
          fetch: auth.fetch,
          apiKey: auth.apiKey,
          customHeaders: auth.customHeaders,
          wireModel: p.wireModel,
          cacheTelemetry: parseJsonSafe(acc.meta, {})?.cacheTelemetry,
          mapPriority: p.mapPriority,
          providerRank: ranks.get(acc.preset) ?? 999,
          accountPriority: acc.priority,
          cooldownUntil: Number(acc.cooldownUntil ?? 0),
          status: acc.status,
          activeConns: this.activeConns.get(acc.id) ?? 0,
        });
      }
    }

    // Sticky session preference (preserves prompt cache hit rate!)
    const sticky = sessionKey ? this.sessionStickiness.get(sessionKey) : null;
    const stickyRoute = sticky && now - sticky.at < 30 * 60 * 1000 ? sticky : null;

    const healthy = candidates.filter((c) => c.cooldownUntil <= now);
    const cooling = candidates.filter((c) => c.cooldownUntil > now);

    const sortHealthy = (a, b) => {
      const stickyRank = (route) =>
        route.status === 'healthy' &&
        route.cooldownUntil <= now &&
        !excludedSet.has(route.accountId) &&
        route.accountId === stickyRoute?.accountId &&
        route.wireModel === stickyRoute?.wireModel
          ? 0
          : 1;
      const aSticky = stickyRank(a);
      const bSticky = stickyRank(b);
      if (aSticky !== bSticky) return aSticky - bSticky;
      return (
        a.providerRank - b.providerRank ||
        a.mapPriority - b.mapPriority ||
        a.accountPriority - b.accountPriority ||
        a.activeConns - b.activeConns
      );
    };
    healthy.sort(sortHealthy);
    cooling.sort((a, b) => a.cooldownUntil - b.cooldownUntil);

    const ordered = [...healthy, ...cooling];

    // Also include legacy static config routes as final fallback
    if (this.legacyProviders?.routes) {
      for (const [pid, route] of this.legacyProviders.routes.entries()) {
        if (provider && pid !== provider) continue;
        const legacyId = `legacy:${pid}`;
        if (excludedSet.has(legacyId)) continue;
        ordered.push({
          source: 'legacy',
          accountId: legacyId,
          preset: pid,
          label: pid,
          protocol: 'openai',
          endpoint: route.endpoint,
          apiKey: route.key,
          customHeaders: {},
          wireModel: reqModel,
          providerRank: 1000,
          accountPriority: 1000,
          cooldownUntil: 0,
          activeConns: 0,
        });
      }
    }

    return ordered;
  }

  markRouteStart(route) {
    if (route.source !== 'pool') return;
    this.activeConns.set(
      route.accountId,
      (this.activeConns.get(route.accountId) ?? 0) + 1,
    );
  }

  markRouteEnd(route) {
    if (route.source !== 'pool') return;
    const next = Math.max(0, (this.activeConns.get(route.accountId) ?? 1) - 1);
    this.activeConns.set(route.accountId, next);
  }

  markRouteSuccess(route, sessionKey = null) {
    if (route.source !== 'pool') return;
    this.cooldownStrikes.delete(route.accountId);
    if (sessionKey) {
      this.sessionStickiness.set(sessionKey, {
        accountId: route.accountId,
        wireModel: route.wireModel,
        at: Date.now(),
      });
    }
    const now = Date.now();
    this.store.tx(() => {
      this.store.db
        .prepare(
          "UPDATE provider_accounts SET status='healthy', cooldownUntil=0, lastError=NULL, lastSuccessAt=?, updatedAt=? WHERE id=?",
        )
        .run(now, now, route.accountId);
    });
  }

  recordAccountFailure(accountId, err) {
    if (!accountId || String(accountId).startsWith('legacy:')) return null;
    return this.markRouteFailure({ source: 'pool', accountId: String(accountId) }, err);
  }

  markRouteFailure(route, err) {
    if (route.source !== 'pool') return;
    const info = classifyError(err);
    const now = Date.now();
    let status = 'unhealthy';
    let cooldownUntil = 0;

    if (info.isRateLimit) {
      const strikes = (this.cooldownStrikes.get(route.accountId) ?? 0) + 1;
      this.cooldownStrikes.set(route.accountId, strikes);
      const backoffSec =
        info.retryAfterSec > 0
          ? Math.min(info.retryAfterSec, 1800)
          : Math.min(30 * Math.pow(2, strikes - 1), 600);
      cooldownUntil = now + backoffSec * 1000;
      status = 'cooldown';
    } else if (info.isTransient) {
      cooldownUntil = now + 30_000;
      status = 'cooldown';
    } else if (info.isAuth) {
      status = 'unhealthy';
    }

    this.store.tx(() => {
      this.store.db
        .prepare(
          'UPDATE provider_accounts SET status=?, cooldownUntil=?, lastError=?, lastErrorAt=?, updatedAt=? WHERE id=?',
        )
        .run(
          status,
          cooldownUntil,
          info.message.slice(0, 500),
          now,
          now,
          route.accountId,
        );
    });
  }

  async testModel({ model, accountId = null, preset = null }) {
    return withTraceContext({ trafficSource: 'probe', isSynthetic: true, model }, async () => {
      const started = Date.now();
      const routes = this.resolveRoutes(model, { provider: preset }).filter(
        (r) => !accountId || r.accountId === accountId,
      );
      if (!routes.length) {
        this.metrics?.record('model_route', {
          model,
          provider: preset ?? null,
          accountId: accountId ?? null,
          attempt: 0,
          ok: false,
          durationMs: Date.now() - started,
          code: 'NO_AVAILABLE_PROVIDER',
          trafficSource: 'probe',
          isSynthetic: true,
          detail: { exhausted: true, probe: true },
        });
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: `找不到模型「${model}」对应的可用启用账号`,
        };
      }
      let lastError = '';
      let attempts = 0;
      for (const r of routes) {
        attempts++;
        try {
          let reply = '';
          for await (const chunk of this.adapter.streamRoute(r, {
            model: r.wireModel,
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'Reply with OK' }] },
            ],
            maxTokens: 16,
            signal: AbortSignal.timeout(15000),
          })) {
            if (chunk.type === 'text-delta') reply += chunk.text;
          }
          this.markRouteSuccess(r);
          this.metrics?.record('model_route', {
            model,
            provider: r.preset,
            accountId: r.accountId,
            attempt: attempts,
            ok: true,
            durationMs: Date.now() - started,
            trafficSource: 'probe',
            isSynthetic: true,
            detail: {
              wireModel: r.wireModel,
              attempts,
              failovers: Math.max(0, attempts - 1),
              primaryOk: attempts === 1,
              probe: true,
            },
          });
          return {
            ok: true,
            latencyMs: Date.now() - started,
            reply: reply.trim() || 'OK',
            accountId: r.accountId,
            provider: r.preset,
            wireModel: r.wireModel,
          };
        } catch (err) {
          lastError = String(err?.message ?? err);
          this.markRouteFailure(r, err);
        }
      }
      this.metrics?.record('model_route', {
        model,
        provider: routes[0]?.preset ?? preset ?? null,
        accountId: routes[0]?.accountId ?? accountId ?? null,
        attempt: attempts,
        ok: false,
        durationMs: Date.now() - started,
        code: 'PROVIDER_UNAVAILABLE',
        trafficSource: 'probe',
        isSynthetic: true,
        detail: { attempts, failovers: Math.max(0, attempts - 1), exhausted: true, probe: true },
      });
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: lastError || '模型测试失败',
      };
    });
  }

  // OpenAI-compatible reverse-proxy gateway (/v1/chat/completions)
  // Supports both direct OpenAI pass-through AND zero-dependency OpenAI -> Anthropic translation.
  async proxyChatCompletion(body, { signal } = {}) {
    const started = Date.now();
    const requestedModel = String(body?.model || this.getDefaultModel());
    const routes = this.resolveRoutes(requestedModel);
    if (!routes.length) {
      this.metrics?.record('model_route', {
        model: requestedModel,
        attempt: 0,
        ok: false,
        durationMs: Date.now() - started,
        code: 'NO_AVAILABLE_PROVIDER',
        detail: { attempts: 0, failovers: 0, exhausted: true, proxy: 'openai' },
      });
      throw new Fault('NO_AVAILABLE_PROVIDER', 503, {
        message: `没有找到模型「${requestedModel}」对应的可用号池账号`,
      });
    }
    let lastErr;
    let lastRoute = null;
    let attempts = 0;
    let failovers = 0;
    let cooldownHits = 0;
    let lastWasRateLimit = false;
    for (const rawRoute of routes) {
      attempts++;
      if (attempts > 1) failovers++;
      if (Number(rawRoute.cooldownUntil || 0) > Date.now()) cooldownHits++;
      lastRoute = rawRoute;
      this.markRouteStart(rawRoute);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.markRouteEnd(rawRoute);
      };
      try {
        const r = await resolveEffectiveRoute(rawRoute, this.copilotTokenCache, {
          signal,
        });
        if (r.protocol === 'anthropic') {
          const url = r.endpoint.endsWith('/v1')
            ? `${r.endpoint}/messages`
            : `${r.endpoint}/v1/messages`;
          const anthPayload = openaiRequestToAnthropic(body, r.wireModel);
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': r.apiKey,
              'anthropic-version': '2023-06-01',
              ...r.customHeaders,
            },
            body: JSON.stringify(anthPayload),
            signal,
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            const err = Object.assign(
              new Error(`Anthropic Upstream HTTP ${res.status}: ${text.slice(0, 300)}`),
              { status: res.status, headers: res.headers },
            );
            const info = classifyError(err);
            lastWasRateLimit = info.isRateLimit;
            if (info.isRateLimit) cooldownHits++;
            this.markRouteFailure(rawRoute, err);
            lastErr = err;
            release();
            continue;
          }
          this.markRouteSuccess(rawRoute);
          this.metrics?.record('model_route', {
            model: requestedModel,
            provider: rawRoute.preset,
            accountId: rawRoute.accountId,
            attempt: attempts,
            ok: true,
            durationMs: Date.now() - started,
            detail: {
              wireModel: r.wireModel,
              attempts,
              failovers,
              primaryOk: failovers === 0,
              cooldownSkipped: cooldownHits,
              proxy: 'openai',
            },
          });
          if (body?.stream && res.body) {
            const translatedStream = anthropicSseToOpenaiStream(
              res.body,
              requestedModel,
            );
            return {
              response: new Response(translatedStream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
              }),
              route: r,
              release,
            };
          }
          const anthJson = await res.json();
          release();
          return {
            response: new Response(
              JSON.stringify(anthropicJsonToOpenai(anthJson, requestedModel)),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
            route: r,
            release,
          };
        }

        const res = await (r.fetch ?? fetch)(`${r.endpoint}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(r.apiKey ? { Authorization: `Bearer ${r.apiKey}` } : {}),
            ...r.customHeaders,
          },
          body: JSON.stringify({ ...body, model: r.wireModel }),
          signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = Object.assign(
            new Error(`Upstream HTTP ${res.status}: ${text.slice(0, 300)}`),
            { status: res.status, headers: res.headers },
          );
          const info = classifyError(err);
          lastWasRateLimit = info.isRateLimit;
          if (info.isRateLimit) cooldownHits++;
          this.markRouteFailure(rawRoute, err);
          lastErr = err;
          release();
          continue;
        }
        this.markRouteSuccess(rawRoute);
        this.metrics?.record('model_route', {
          model: requestedModel,
          provider: rawRoute.preset,
          accountId: rawRoute.accountId,
          attempt: attempts,
          ok: true,
          durationMs: Date.now() - started,
          detail: {
            wireModel: r.wireModel,
            attempts,
            failovers,
            primaryOk: failovers === 0,
            cooldownSkipped: cooldownHits,
            proxy: 'openai',
          },
        });
        if (!body?.stream) release();
        return { response: res, route: r, release };
      } catch (err) {
        release();
        if (signal?.aborted) throw err;
        const info = classifyError(err);
        lastWasRateLimit = info.isRateLimit;
        if (info.isRateLimit) cooldownHits++;
        this.markRouteFailure(rawRoute, err);
        lastErr = err;
      }
    }
    this.metrics?.record('model_route', {
      model: requestedModel,
      provider: lastRoute?.preset ?? null,
      accountId: lastRoute?.accountId ?? null,
      attempt: attempts,
      ok: false,
      durationMs: Date.now() - started,
      code: lastWasRateLimit ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
      detail: {
        attempts,
        failovers,
        exhausted: true,
        cooldownRejected: lastWasRateLimit,
        cooldownSkipped: lastWasRateLimit ? Math.max(0, cooldownHits - 1) : cooldownHits,
        proxy: 'openai',
      },
    });
    throw new Fault('PROVIDER_UNAVAILABLE', 503, {
      message: String(lastErr?.message ?? '所有号池账号均不可用'),
    });
  }

  // Anthropic-compatible reverse-proxy gateway (/v1/messages)
  // Supports both direct Anthropic pass-through AND zero-dependency Anthropic -> OpenAI translation.
  async proxyAnthropicMessages(body, { signal } = {}) {
    const started = Date.now();
    const requestedModel = String(body?.model || this.getDefaultModel());
    const routes = this.resolveRoutes(requestedModel);
    if (!routes.length) {
      this.metrics?.record('model_route', {
        model: requestedModel,
        attempt: 0,
        ok: false,
        durationMs: Date.now() - started,
        code: 'NO_AVAILABLE_PROVIDER',
        detail: { attempts: 0, failovers: 0, exhausted: true, proxy: 'anthropic' },
      });
      throw new Fault('NO_AVAILABLE_PROVIDER', 503, {
        message: `没有找到模型「${requestedModel}」对应的可用号池账号`,
      });
    }
    let lastErr;
    let lastRoute = null;
    let attempts = 0;
    let failovers = 0;
    let cooldownHits = 0;
    let lastWasRateLimit = false;
    for (const rawRoute of routes) {
      attempts++;
      if (attempts > 1) failovers++;
      if (Number(rawRoute.cooldownUntil || 0) > Date.now()) cooldownHits++;
      lastRoute = rawRoute;
      this.markRouteStart(rawRoute);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.markRouteEnd(rawRoute);
      };
      try {
        const r = await resolveEffectiveRoute(rawRoute, this.copilotTokenCache, {
          signal,
        });
        if (r.protocol === 'anthropic') {
          const url = r.endpoint.endsWith('/v1')
            ? `${r.endpoint}/messages`
            : `${r.endpoint}/v1/messages`;
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': r.apiKey,
              'anthropic-version': '2023-06-01',
              ...r.customHeaders,
            },
            body: JSON.stringify({ ...body, model: r.wireModel }),
            signal,
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            const err = Object.assign(
              new Error(`Anthropic Upstream HTTP ${res.status}: ${text.slice(0, 300)}`),
              { status: res.status, headers: res.headers },
            );
            const info = classifyError(err);
            lastWasRateLimit = info.isRateLimit;
            if (info.isRateLimit) cooldownHits++;
            this.markRouteFailure(rawRoute, err);
            lastErr = err;
            release();
            continue;
          }
          this.markRouteSuccess(rawRoute);
          this.metrics?.record('model_route', {
            model: requestedModel,
            provider: rawRoute.preset,
            accountId: rawRoute.accountId,
            attempt: attempts,
            ok: true,
            durationMs: Date.now() - started,
            detail: {
              wireModel: r.wireModel,
              attempts,
              failovers,
              primaryOk: failovers === 0,
              cooldownSkipped: cooldownHits,
              proxy: 'anthropic',
            },
          });
          if (!body?.stream) release();
          return { response: res, route: r, release };
        }

        const oaiPayload = anthropicRequestToOpenai(body, r.wireModel);
        const res = await (r.fetch ?? fetch)(`${r.endpoint}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(r.apiKey ? { Authorization: `Bearer ${r.apiKey}` } : {}),
            ...r.customHeaders,
          },
          body: JSON.stringify(oaiPayload),
          signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = Object.assign(
            new Error(`OpenAI Upstream HTTP ${res.status}: ${text.slice(0, 300)}`),
            { status: res.status, headers: res.headers },
          );
          const info = classifyError(err);
          lastWasRateLimit = info.isRateLimit;
          if (info.isRateLimit) cooldownHits++;
          this.markRouteFailure(rawRoute, err);
          lastErr = err;
          release();
          continue;
        }
        this.markRouteSuccess(rawRoute);
        this.metrics?.record('model_route', {
          model: requestedModel,
          provider: rawRoute.preset,
          accountId: rawRoute.accountId,
          attempt: attempts,
          ok: true,
          durationMs: Date.now() - started,
          detail: {
            wireModel: r.wireModel,
            attempts,
            failovers,
            primaryOk: failovers === 0,
            cooldownSkipped: cooldownHits,
            proxy: 'anthropic',
          },
        });
        if (body?.stream && res.body) {
          const translatedStream = openaiSseToAnthropicStream(
            res.body,
            requestedModel,
          );
          return {
            response: new Response(translatedStream, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
            }),
            route: r,
            release,
          };
        }
        const oaiJson = await res.json();
        release();
        return {
          response: new Response(
            JSON.stringify(openaiJsonToAnthropic(oaiJson, requestedModel)),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
          route: r,
          release,
        };
      } catch (err) {
        release();
        if (signal?.aborted) throw err;
        const info = classifyError(err);
        lastWasRateLimit = info.isRateLimit;
        if (info.isRateLimit) cooldownHits++;
        this.markRouteFailure(rawRoute, err);
        lastErr = err;
      }
    }
    this.metrics?.record('model_route', {
      model: requestedModel,
      provider: lastRoute?.preset ?? null,
      accountId: lastRoute?.accountId ?? null,
      attempt: attempts,
      ok: false,
      durationMs: Date.now() - started,
      code: lastWasRateLimit ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
      detail: {
        attempts,
        failovers,
        exhausted: true,
        cooldownRejected: lastWasRateLimit,
        cooldownSkipped: lastWasRateLimit ? Math.max(0, cooldownHits - 1) : cooldownHits,
        proxy: 'anthropic',
      },
    });
    throw new Fault('PROVIDER_UNAVAILABLE', 503, {
      message: String(lastErr?.message ?? '所有号池账号均不可用'),
    });
  }
}

export class PoolLlmAdapter extends LlmAdapter {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  async *stream(o) {
    const started = Date.now();
    const routes = this.pool.resolveRoutes(o.model, {
      provider: o.provider && o.provider !== 'pool' ? o.provider : null,
      sessionKey: o.sessionKey ?? null,
      excludeAccountIds: o.excludeAccountIds ?? null,
    });
    if (!routes.length) {
      this.pool.metrics?.record('model_route', {
        model: o.model,
        provider: o.provider && o.provider !== 'pool' ? o.provider : null,
        attempt: 0,
        ok: false,
        durationMs: Date.now() - started,
        code: 'NO_AVAILABLE_PROVIDER',
        detail: { attempts: 0, failovers: 0, exhausted: true },
      });
      throw new Fault('PROVIDER_UNAVAILABLE', 503, {
        message: `没有为模型「${o.model}」配置可用的启用账号，请前往「设置 → 账号号池」添加账号并获取模型。`,
        exhausted: true,
      });
    }
    const maxFailovers = Math.max(0, Number(o.maxFailoverAttempts ?? 3));
    let yielded = false;
    let lastErr = null;
    let lastRoute = null;
    let attempts = 0;
    let failovers = 0;
    let cooldownHits = 0;
    let lastWasRateLimit = false;
    let lastStatusCode = null;
    let pendingFailover = null;
    const triedAccountIds = [];
    for (const r of routes) {
      if (attempts >= 1 && failovers >= maxFailovers) break;
      attempts++;
      if (attempts > 1) failovers++;
      if (Number(r.cooldownUntil || 0) > Date.now()) {
        cooldownHits++;
      }
      if (pendingFailover) {
        yield {
          type: 'route-failover',
          failover: {
            attempt: pendingFailover.attempt,
            statusCode: pendingFailover.statusCode,
            fromAccountId: pendingFailover.fromAccountId,
            toAccountId: r.accountId,
            reason: pendingFailover.reason,
          },
        };
        pendingFailover = null;
      }
      triedAccountIds.push(r.accountId);
      lastRoute = r;
      let routeEmitted = false;
      this.pool.markRouteStart(r);
      try {
        for await (const chunk of this.streamRoute(r, o)) {
          if (!routeEmitted) {
            routeEmitted = true;
            yield {
              type: 'route',
              route: {
                provider: r.preset,
                accountId: r.accountId,
                wireModel: r.wireModel,
                attempts,
                failovers,
              },
            };
          }
          if (
            chunk.type === 'text-delta' ||
            chunk.type === 'reasoning-delta' ||
            chunk.type === 'tool-call-delta' ||
            (chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
          ) {
            yielded = true;
          }
          yield chunk;
        }
        if (!routeEmitted) {
          routeEmitted = true;
          yield {
            type: 'route',
            route: {
              provider: r.preset,
              accountId: r.accountId,
              wireModel: r.wireModel,
              attempts,
              failovers,
            },
          };
        }
        this.pool.markRouteSuccess(r, o.sessionKey ?? null);
        this.pool.metrics?.record('model_route', {
          model: o.model,
          provider: r.preset,
          accountId: r.accountId,
          attempt: attempts,
          ok: true,
          durationMs: Date.now() - started,
          detail: {
            wireModel: r.wireModel,
            attempts,
            failovers,
            primaryOk: failovers === 0,
            cooldownSkipped: cooldownHits,
          },
        });
        return;
      } catch (err) {
        lastErr = err;
        if (o.signal?.aborted) throw err;
        const errInfo = classifyError(err);
        lastWasRateLimit = errInfo.isRateLimit;
        lastStatusCode = errInfo.status || null;
        if (errInfo.isRateLimit) {
          cooldownHits++;
        }
        this.pool.markRouteFailure(r, err);
        if (yielded) {
          this.pool.metrics?.record('model_route', {
            model: o.model,
            provider: r.preset,
            accountId: r.accountId,
            attempt: attempts,
            ok: false,
            durationMs: Date.now() - started,
            code: 'PROVIDER_STREAM_INTERRUPTED',
            detail: {
              wireModel: r.wireModel,
              attempts,
              failovers,
              cooldownSkipped: cooldownHits,
            },
          });
          throw new Fault('PROVIDER_STREAM_INTERRUPTED', 502, {
            message: String(err?.message ?? err),
          });
        }
        pendingFailover = {
          attempt: failovers + 1,
          statusCode: errInfo.status || null,
          fromAccountId: r.accountId,
          reason: errInfo.message,
        };
      } finally {
        this.pool.markRouteEnd(r);
      }
    }
    this.pool.metrics?.record('model_route', {
      model: o.model,
      provider: lastRoute?.preset ?? null,
      accountId: lastRoute?.accountId ?? null,
      attempt: attempts,
      ok: false,
      durationMs: Date.now() - started,
      code: lastWasRateLimit ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
      detail: {
        attempts,
        failovers,
        exhausted: true,
        cooldownRejected: lastWasRateLimit,
        cooldownSkipped: lastWasRateLimit ? Math.max(0, cooldownHits - 1) : cooldownHits,
      },
    });
    const exhaustedErr = new Fault('PROVIDER_UNAVAILABLE', 503, {
      message: String(lastErr?.message ?? '号池内所有候选账号请求失败'),
      exhausted: true,
      statusCode: lastStatusCode ?? 503,
      accountId: lastRoute?.accountId ?? null,
      triedAccountIds,
    });
    exhaustedErr.cause = lastErr;
    throw exhaustedErr;
  }

  async *streamRoute(rawRoute, o) {
    const r = await resolveEffectiveRoute(rawRoute, this.pool.copilotTokenCache, {
      signal: o.signal,
    });
    yield* observeProviderUsage(
      r.protocol === 'anthropic' ? this.#streamAnthropic(r, o) : this.#streamOpenAI(r, o),
      { metrics: this.pool.metrics, signal: o.signal, provider: r.preset, accountId: r.accountId,
        model: r.wireModel ?? o.model, sessionId: o.sessionKey ?? undefined, cacheTelemetry: r.cacheTelemetry },
    );
  }

  async *#streamOpenAI(r, o) {
    const sdk = new OpenAI({
      apiKey: r.apiKey || 'no-key',
      baseURL: r.endpoint,
      ...(r.fetch && { fetch: r.fetch }),
      maxRetries: 0,
      timeout: 120000,
      defaultHeaders: { ...attributionHeaders(), ...r.customHeaders },
    });
    const wireModel = r.wireModel ?? o.model;
    const reasoningEffort = openAiReasoningEffort(o.effort, wireModel);
    const cacheKey = openaiPromptCacheKey(r.endpoint, o.sessionKey);
    const stream = await sdk.chat.completions.create(
      {
        model: wireModel,
        messages: toOpenAiMessages(o),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: o.maxTokens,
        ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(o.tools?.length
          ? {
              tools: stableTools(o.tools).map((t) => ({
                type: 'function',
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                },
              })),
            }
          : {}),
      },
      { signal: o.signal },
    );

    let text = '';
    let reasoning = '';
    let finish;
    const blocks = new Map();
    const calls = new Map();

    for await (const frame of stream) {
      if (frame.usage) {
        yield {
          type: 'usage',
          usage: normalizeProviderUsage('openai', frame.usage),
        };
      }
      const choice = frame.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      const reasoningFrag = d.reasoning_content ?? d.reasoning ?? '';
      for (const [key, fragment] of [
        ['reasoning', reasoningFrag],
        ['text', d.content],
      ]) {
        if (!fragment) continue;
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
        const key = 'call' + (call.index ?? 0);
        let item = calls.get(key);
        if (!item) {
          item = {
            type: 'tool-call',
            id: call.id || `call_${calls.size}_${Date.now()}`,
            name: '',
            arguments: '',
          };
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
        yield {
          type: 'tool-call-delta',
          index: blocks.get(key),
          id: item.id,
          ...(call.function?.name ? { name: call.function.name } : {}),
          argumentsDelta: call.function?.arguments ?? '',
        };
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const effectiveFinish = finish ?? (calls.size > 0 ? 'tool_calls' : 'stop');
    for (const [key, index] of blocks) {
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
    }
    yield {
      type: 'finish',
      reason: {
        kind:
          effectiveFinish === 'length'
            ? 'max-tokens'
            : effectiveFinish === 'tool_calls'
              ? 'tool-calls'
              : 'stop',
      },
    };
  }

  async *#streamAnthropic(r, o) {
    const url = r.endpoint.endsWith('/v1')
      ? `${r.endpoint}/messages`
      : `${r.endpoint}/v1/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': r.apiKey,
        'anthropic-version': '2023-06-01',
        ...r.customHeaders,
      },
      body: JSON.stringify(toAnthropicPayload(o, r.wireModel ?? o.model)),
      signal: o.signal,
    });
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => '');
      throw Object.assign(
        new Error(`Anthropic HTTP ${res.status}: ${txt.slice(0, 300)}`),
        { status: res.status, headers: res.headers },
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const blocks = new Map();
    let stopReason = 'end_turn';
    let upstreamUsage = {};

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
        if (ev.type === 'error') throw new Fault('PROVIDER_STREAM_INTERRUPTED', 502);
        if (ev.type === 'message_start' && ev.message?.usage) {
          upstreamUsage = ev.message.usage;
          yield { type: 'usage', usage: normalizeProviderUsage('anthropic', upstreamUsage) };
        } else if (ev.type === 'content_block_start') {
          const idx = ev.index ?? blocks.size;
          const cb = ev.content_block ?? {};
          if (cb.type === 'text') {
            blocks.set(idx, { type: 'text', text: cb.text ?? '' });
            yield { type: 'block-start', index: idx, blockType: 'text' };
          } else if (cb.type === 'thinking') {
            blocks.set(idx, { type: 'reasoning', text: cb.thinking ?? '' });
            yield { type: 'block-start', index: idx, blockType: 'reasoning' };
          } else if (cb.type === 'tool_use') {
            blocks.set(idx, {
              type: 'tool-call',
              id: cb.id || `tool_${idx}`,
              name: cb.name || '',
              arguments: '',
            });
            yield { type: 'block-start', index: idx, blockType: 'tool-call' };
          }
        } else if (ev.type === 'content_block_delta') {
          const idx = ev.index ?? 0;
          const blk = blocks.get(idx);
          const d = ev.delta ?? {};
          if (d.type === 'text_delta' && d.text) {
            if (blk) blk.text += d.text;
            yield { type: 'text-delta', index: idx, text: d.text };
          } else if (d.type === 'thinking_delta' && d.thinking) {
            if (blk) blk.text += d.thinking;
            yield { type: 'reasoning-delta', index: idx, text: d.thinking };
          } else if (d.type === 'input_json_delta' && d.partial_json) {
            if (blk) blk.arguments += d.partial_json;
            yield {
              type: 'tool-call-delta',
              index: idx,
              id: blk?.id,
              name: blk?.name,
              argumentsDelta: d.partial_json,
            };
          }
        } else if (ev.type === 'content_block_stop') {
          const idx = ev.index ?? 0;
          const blk = blocks.get(idx);
          if (blk) {
            yield { type: 'block-end', index: idx, block: blk };
          }
        } else if (ev.type === 'message_delta') {
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          if (ev.usage) {
            upstreamUsage = { ...upstreamUsage, ...ev.usage };
            yield { type: 'usage', usage: normalizeProviderUsage('anthropic', upstreamUsage) };
          }
        }
      }
    }

    yield {
      type: 'finish',
      reason: {
        kind:
          stopReason === 'max_tokens'
            ? 'max-tokens'
            : stopReason === 'tool_use'
              ? 'tool-calls'
              : 'stop',
      },
    };
  }
}
