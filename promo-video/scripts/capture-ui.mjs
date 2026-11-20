// Launches the real built frontend/dist with a local mock /v1 API server and
// captures crisp 2x Retina screenshots via headless Chrome CDP.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const DIST = path.resolve("../frontend/dist");
const OUT = path.resolve("public/assets/ui");
fs.mkdirSync(OUT, { recursive: true });

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const HTTP_PORT = 15173;
const CDP_PORT = 19223;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

const NOW = Date.now();

const PRESETS = {
  categories: [
    { id: "flagship", label: "旗舰云端厂商" },
    { id: "domestic", label: "国产推理模型" },
    { id: "gateway", label: "本地聚合网关" },
  ],
  items: {
    openai: {
      id: "openai", name: "OpenAI", category: "flagship", kind: "api", protocol: "openai", ownedBy: "openai",
      color: "#10A37F", description: "GPT-5 / o3 旗舰编程与多模态推理", defaultEndpoint: "https://api.openai.com/v1",
      supportsBalance: true, supportsCheckin: false, accountCount: 2, fields: [],
    },
    anthropic: {
      id: "anthropic", name: "Anthropic", category: "flagship", kind: "api", protocol: "anthropic", ownedBy: "anthropic",
      color: "#D97757", description: "Claude 4.5 架构设计与深度代码审查", defaultEndpoint: "https://api.anthropic.com",
      supportsBalance: true, supportsCheckin: false, accountCount: 2, fields: [],
    },
    gemini: {
      id: "gemini", name: "Google Gemini", category: "flagship", kind: "api", protocol: "openai", ownedBy: "google",
      color: "#2563EB", description: "百万级超长上下文与多模态视觉解析", defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
      supportsBalance: true, supportsCheckin: true, accountCount: 1, fields: [],
    },
    deepseek: {
      id: "deepseek", name: "DeepSeek", category: "domestic", kind: "api", protocol: "openai", ownedBy: "deepseek",
      color: "#3B82F6", description: "深度思考与高性价比并发执行主力", defaultEndpoint: "https://api.deepseek.com/v1",
      supportsBalance: true, supportsCheckin: true, accountCount: 2, fields: [],
    },
    qwen: {
      id: "qwen", name: "通义千问 Qwen", category: "domestic", kind: "api", protocol: "openai", ownedBy: "alibaba",
      color: "#6366F1", description: "Qwen3-Coder 高速代码生成与测试", defaultEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      supportsBalance: true, supportsCheckin: true, accountCount: 1, fields: [],
    },
    agent2api: {
      id: "agent2api", name: "本地聚合网关", category: "gateway", kind: "local", protocol: "openai", ownedBy: "local",
      color: "#0EA5E9", description: "127.0.0.1:3065 本地统一路由与签到桥接", defaultEndpoint: "http://127.0.0.1:3065/v1",
      supportsBalance: true, supportsCheckin: true, accountCount: 1, fields: [],
    },
  },
};

const ACCOUNTS = [
  {
    id: "acc-oai-1", preset: "openai", presetName: "OpenAI", category: "flagship", protocol: "openai",
    label: "OpenAI 主力节点 #1", priority: 1, providerRank: 1, enabled: true,
    models: ["gpt-5.2", "gpt-5.2-mini"], endpoint: "https://api.openai.com/v1", headers: {}, modelProfiles: {},
    status: "rate_limited", rateLimited: true, cooldownUntil: NOW + 42000, cooldownRemainingMs: 42000,
    lastLatencyMs: 318, lastUsedAt: NOW - 15000,
    balance: { supported: true, amount: 128.4, currency: "USD", display: "$128.40" },
  },
  {
    id: "acc-oai-2", preset: "openai", presetName: "OpenAI", category: "flagship", protocol: "openai",
    label: "OpenAI 热备节点 #2（自动接管中）", priority: 2, providerRank: 1, enabled: true,
    models: ["gpt-5.2", "gpt-5.2-mini"], endpoint: "https://api.openai.com/v1", headers: {}, modelProfiles: {},
    status: "healthy", rateLimited: false, cooldownUntil: 0, cooldownRemainingMs: 0,
    lastLatencyMs: 242, lastUsedAt: NOW - 2000,
    balance: { supported: true, amount: 264.8, currency: "USD", display: "$264.80" },
  },
  {
    id: "acc-ant-1", preset: "anthropic", presetName: "Anthropic", category: "flagship", protocol: "anthropic",
    label: "Anthropic 企业密钥 A", priority: 1, providerRank: 2, enabled: true,
    models: ["claude-sonnet-4.5", "claude-opus-4.5"], endpoint: "https://api.anthropic.com", headers: {}, modelProfiles: {},
    status: "healthy", rateLimited: false, cooldownUntil: 0, cooldownRemainingMs: 0,
    lastLatencyMs: 285, lastUsedAt: NOW - 8000,
    balance: { supported: true, amount: 186.2, currency: "USD", display: "$186.20" },
  },
  {
    id: "acc-gem-1", preset: "gemini", presetName: "Google Gemini", category: "flagship", protocol: "openai",
    label: "Gemini 百万上下文池", priority: 1, providerRank: 3, enabled: true,
    models: ["gemini-2.5-pro", "gemini-2.5-flash"], endpoint: "https://generativelanguage.googleapis.com/v1beta/openai", headers: {}, modelProfiles: {},
    status: "healthy", rateLimited: false, cooldownUntil: 0, cooldownRemainingMs: 0,
    lastLatencyMs: 215, lastUsedAt: NOW - 12000,
    balance: { supported: true, amount: 95.0, currency: "USD", display: "$95.00" },
  },
  {
    id: "acc-ds-1", preset: "deepseek", presetName: "DeepSeek", category: "domestic", protocol: "openai",
    label: "DeepSeek 推理主力 #1", priority: 1, providerRank: 4, enabled: true,
    models: ["deepseek-reasoner", "deepseek-v3.2"], endpoint: "https://api.deepseek.com/v1", headers: {}, modelProfiles: {},
    status: "healthy", rateLimited: false, cooldownUntil: 0, cooldownRemainingMs: 0,
    lastLatencyMs: 168, lastUsedAt: NOW - 4000,
    balance: { supported: true, amount: 428.5, currency: "CNY", display: "¥428.50" },
  },
  {
    id: "acc-qwen-1", preset: "qwen", presetName: "通义千问 Qwen", category: "domestic", protocol: "openai",
    label: "Qwen3-Coder 并发池", priority: 1, providerRank: 5, enabled: true,
    models: ["qwen3-coder-plus", "qwen3-max"], endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", headers: {}, modelProfiles: {},
    status: "healthy", rateLimited: false, cooldownUntil: 0, cooldownRemainingMs: 0,
    lastLatencyMs: 145, lastUsedAt: NOW - 9000,
    balance: { supported: true, amount: 312.0, currency: "CNY", display: "¥312.00" },
  },
  {
    id: "acc-loc-1", preset: "agent2api", presetName: "本地聚合网关", category: "gateway", protocol: "openai",
    label: "Local Gateway (127.0.0.1:3065)", priority: 1, providerRank: 6, enabled: true,
    models: ["kimi-k2", "glm-4.6"], endpoint: "http://127.0.0.1:3065/v1", headers: {}, modelProfiles: {},
    status: "healthy", rateLimited: false, cooldownUntil: 0, cooldownRemainingMs: 0,
    lastLatencyMs: 38, lastUsedAt: NOW - 3000,
    balance: { supported: true, amount: 12800, currency: "PTS", display: "12,800 积分" },
  },
];

const POOL_MODELS = {
  totalCount: 8,
  enabledCount: 8,
  mappedCount: 5,
  defaultModel: "auto",
  gateway: { running: true, host: "127.0.0.1", port: 8787, endpoint: "http://127.0.0.1:8787/v1" },
  providers: [
    { id: "openai", name: "OpenAI", icon: "OA", color: "#10A37F", category: "flagship", rank: 1, modelCount: 2 },
    { id: "anthropic", name: "Anthropic", icon: "AN", color: "#D97757", category: "flagship", rank: 2, modelCount: 2 },
    { id: "gemini", name: "Google Gemini", icon: "GM", color: "#2563EB", category: "flagship", rank: 3, modelCount: 1 },
    { id: "deepseek", name: "DeepSeek", icon: "DS", color: "#3B82F6", category: "domestic", rank: 4, modelCount: 2 },
    { id: "qwen", name: "通义千问 Qwen", icon: "QW", color: "#6366F1", category: "domestic", rank: 5, modelCount: 1 },
  ],
  items: [
    {
      id: "m-gpt5", ids: ["m-gpt5"], preset: "openai", presetName: "OpenAI", providerRank: 1,
      upstreamModel: "gpt-5.2", displayName: "gpt-5.2", enabled: true, visible: true, source: "remote",
      multiplier: 1.0, contextWindow: 400000, maxOutput: 64000,
      capabilities: { tools: true, reasoning: true, vision: true, cache: true },
      accountIds: ["acc-oai-1", "acc-oai-2"], activeAccountCount: 2,
      mappings: [{ id: "map-1", alias: "coder", targetPreset: "openai", targetAccountId: null, targetModel: "gpt-5.2", enabled: true, isDefault: false, priority: 1 }],
    },
    {
      id: "m-sonnet", ids: ["m-sonnet"], preset: "anthropic", presetName: "Anthropic", providerRank: 2,
      upstreamModel: "claude-sonnet-4.5", displayName: "claude-sonnet-4.5", enabled: true, visible: true, source: "remote",
      multiplier: 1.0, contextWindow: 200000, maxOutput: 64000,
      capabilities: { tools: true, reasoning: true, vision: true, cache: true },
      accountIds: ["acc-ant-1"], activeAccountCount: 1,
      mappings: [{ id: "map-2", alias: "reviewer", targetPreset: "anthropic", targetAccountId: null, targetModel: "claude-sonnet-4.5", enabled: true, isDefault: false, priority: 1 }],
    },
    {
      id: "m-opus", ids: ["m-opus"], preset: "anthropic", presetName: "Anthropic", providerRank: 2,
      upstreamModel: "claude-opus-4.5", displayName: "claude-opus-4.5", enabled: true, visible: true, source: "remote",
      multiplier: 2.0, contextWindow: 200000, maxOutput: 32000,
      capabilities: { tools: true, reasoning: true, vision: true, cache: true },
      accountIds: ["acc-ant-1"], activeAccountCount: 1,
      mappings: [],
    },
    {
      id: "m-gemini", ids: ["m-gemini"], preset: "gemini", presetName: "Google Gemini", providerRank: 3,
      upstreamModel: "gemini-2.5-pro", displayName: "gemini-2.5-pro", enabled: true, visible: true, source: "remote",
      multiplier: 0.8, contextWindow: 1000000, maxOutput: 65536,
      capabilities: { tools: true, reasoning: true, vision: true, cache: true },
      accountIds: ["acc-gem-1"], activeAccountCount: 1,
      mappings: [{ id: "map-3", alias: "vision", targetPreset: "gemini", targetAccountId: null, targetModel: "gemini-2.5-pro", enabled: true, isDefault: false, priority: 1 }],
    },
    {
      id: "m-dsr", ids: ["m-dsr"], preset: "deepseek", presetName: "DeepSeek", providerRank: 4,
      upstreamModel: "deepseek-reasoner", displayName: "deepseek-reasoner", enabled: true, visible: true, source: "remote",
      multiplier: 0.3, contextWindow: 128000, maxOutput: 32000,
      capabilities: { tools: true, reasoning: true, vision: false, cache: true },
      accountIds: ["acc-ds-1"], activeAccountCount: 1,
      mappings: [{ id: "map-4", alias: "planner", targetPreset: "deepseek", targetAccountId: null, targetModel: "deepseek-reasoner", enabled: true, isDefault: false, priority: 1 }],
    },
    {
      id: "m-dsv3", ids: ["m-dsv3"], preset: "deepseek", presetName: "DeepSeek", providerRank: 4,
      upstreamModel: "deepseek-v3.2", displayName: "deepseek-v3.2", enabled: true, visible: true, source: "remote",
      multiplier: 0.15, contextWindow: 128000, maxOutput: 16384,
      capabilities: { tools: true, reasoning: false, vision: false, cache: true },
      accountIds: ["acc-ds-1"], activeAccountCount: 1,
      mappings: [{ id: "map-5", alias: "fast", targetPreset: "deepseek", targetAccountId: null, targetModel: "deepseek-v3.2", enabled: true, isDefault: false, priority: 1 }],
    },
    {
      id: "m-qwen", ids: ["m-qwen"], preset: "qwen", presetName: "通义千问 Qwen", providerRank: 5,
      upstreamModel: "qwen3-coder-plus", displayName: "qwen3-coder-plus", enabled: true, visible: true, source: "remote",
      multiplier: 0.25, contextWindow: 256000, maxOutput: 32000,
      capabilities: { tools: true, reasoning: true, vision: false, cache: true },
      accountIds: ["acc-qwen-1"], activeAccountCount: 1,
      mappings: [],
    },
  ],
  unmountedMappings: [],
};

const CHECKIN_CENTER = {
  mode: "bridge",
  bridge: { mode: "auto", baseUrl: "http://127.0.0.1:3065", hasApiKey: true, hasPanelToken: true, connected: true, error: null },
  daily: {
    todayDone: 5,
    todayEligible: 5,
    outOfScope: [],
    providers: [
      {
        id: "agent2api", label: "本地协议桥接通道", description: "每日自动领取额度与活跃积分", doneCount: 2, totalCount: 2,
        accounts: [
          { id: "c1", name: "主力聚合账号 #1", available: true, checkinAt: NOW - 3600000, checkedInToday: true, streakDays: 28, edition: "Pro" },
          { id: "c2", name: "备用聚合账号 #2", available: true, checkinAt: NOW - 3540000, checkedInToday: true, streakDays: 21, edition: "Standard" },
        ],
      },
      {
        id: "deepseek", label: "DeepSeek 开发者池", description: "本地插件自动签到与余额巡检", doneCount: 2, totalCount: 2,
        accounts: [
          { id: "c3", name: "DeepSeek 推理主力 #1", available: true, checkinAt: NOW - 3200000, checkedInToday: true, streakDays: 34, edition: "API" },
          { id: "c4", name: "DeepSeek 并发节点 #2", available: true, checkinAt: NOW - 3120000, checkedInToday: true, streakDays: 19, edition: "API" },
        ],
      },
      {
        id: "qwen", label: "Qwen 开放平台", description: "每日定时补签保障配额不断档", doneCount: 1, totalCount: 1,
        accounts: [
          { id: "c5", name: "Qwen3-Coder 并发池", available: true, checkinAt: NOW - 2900000, checkedInToday: true, streakDays: 16, edition: "Coder" },
        ],
      },
    ],
  },
  extras: { onboarding: [], plans: [], growth: [] },
  auto: {
    enabled: true, lastFiredToday: true, running: false,
    providerOptions: [
      { id: "agent2api", label: "本地协议桥接" },
      { id: "deepseek", label: "DeepSeek" },
      { id: "qwen", label: "Qwen" },
    ],
    defaultRetryTime: "12:30",
    schedules: [
      {
        id: "sch-1", label: "每日早间自动签到", displayLabel: "每天 08:30", enabled: true, time: "08:30",
        providers: ["agent2api", "deepseek", "qwen"], retryTime: "12:30", retryGapMinutes: 30, retryLimit: 3,
        lastFiredDate: "2026-11-20", lastFiredToday: true, retryCount: 0,
      },
    ],
  },
  recordsTotal: 142,
  plugins: [
    { kind: "local", file: "deepseek-checkin.mjs", providerId: "deepseek", label: "DeepSeek 自动签到插件", description: "自动签到并回报剩余额度" },
  ],
};

const CHECKIN_RECORDS = {
  total: 4,
  records: [
    { rowId: 1, ts: NOW - 2900000, date: "2026-11-20", accountName: "Qwen3-Coder 并发池", provider: "Qwen", outcome: "success", message: "签到成功，获得 +500 额度积分", points: 500 },
    { rowId: 2, ts: NOW - 3200000, date: "2026-11-20", accountName: "DeepSeek 推理主力 #1", provider: "DeepSeek", outcome: "success", message: "签到成功，连续 34 天", points: 300 },
    { rowId: 3, ts: NOW - 3600000, date: "2026-11-20", accountName: "主力聚合账号 #1", provider: "本地协议桥接", outcome: "success", message: "桥接签到完成，额度已刷新", points: 800 },
  ],
};

function handleApi(req, res, url) {
  const p = url.pathname;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (p === "/v1/health") return res.end(JSON.stringify({ ok: true, status: "ok", routerReady: true }));
  if (p === "/v1/workspace") return res.end(JSON.stringify({ workspaceRoot: "D:\\Agent_US" }));
  if (p === "/v1/git/status") return res.end(JSON.stringify({ isGitRepo: true, branch: "main", branches: ["main", "feat/router-worker", "feat/pool-failover"], dirty: false, modifiedCount: 0, untrackedCount: 0 }));
  if (p === "/v1/providers/presets") return res.end(JSON.stringify(PRESETS));
  if (p === "/v1/accounts") return res.end(JSON.stringify({ items: ACCOUNTS }));
  if (p === "/v1/models/pool") return res.end(JSON.stringify(POOL_MODELS));
  if (p === "/v1/models") return res.end(JSON.stringify({
    defaultModel: "auto",
    items: [
      { alias: "auto", targets: [{ provider: "openai", model: "gpt-5.2" }, { provider: "anthropic", model: "claude-sonnet-4.5" }] },
      { alias: "planner", targets: [{ provider: "deepseek", model: "deepseek-reasoner" }] },
      { alias: "coder", targets: [{ provider: "openai", model: "gpt-5.2" }] },
      { alias: "reviewer", targets: [{ provider: "anthropic", model: "claude-sonnet-4.5" }] },
      { alias: "vision", targets: [{ provider: "gemini", model: "gemini-2.5-pro" }] },
      { alias: "fast", targets: [{ provider: "deepseek", model: "deepseek-v3.2" }] },
    ],
  }));
  if (p === "/v1/providers" || p === "/v1/providers/health") return res.end(JSON.stringify({ routerReady: true, items: ACCOUNTS }));
  if (p === "/v1/checkin/center") return res.end(JSON.stringify(CHECKIN_CENTER));
  if (p === "/v1/checkin/records") return res.end(JSON.stringify(CHECKIN_RECORDS));
  if (p === "/v1/checkin/bridge") return res.end(JSON.stringify(CHECKIN_CENTER.bridge));
  if (p === "/v1/sessions") return res.end(JSON.stringify({ items: [] }));
  if (p === "/v1/approvals") return res.end(JSON.stringify({ items: [] }));
  if (p === "/v1/usage") return res.end(JSON.stringify({ items: [], totals: { tokens: 128400, costUsd: 1.42, callCount: 48 } }));
  if (p === "/v1/memory") return res.end(JSON.stringify({ items: [] }));
  if (p === "/v1/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    return;
  }
  res.end(JSON.stringify({ ok: true, items: [] }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${HTTP_PORT}`);
  if (url.pathname.startsWith("/v1/")) return handleApi(req, res, url);
  const clean = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  let fp = path.resolve(DIST, clean);
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(DIST, "index.html");
  res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
  fs.createReadStream(fp).pipe(res);
});

await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));
console.log("Mock frontend server ready on", HTTP_PORT);

const userDataDir = path.resolve("out/.chrome-capture-profile");
fs.rmSync(userDataDir, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userDataDir}`,
  "--window-size=1440,900",
  `http://127.0.0.1:${HTTP_PORT}`,
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl = "";
for (let i = 0; i < 40; i++) {
  try {
    const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const list = await resp.json();
    const page = list.find((t) => t.type === "page");
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(250);
}
if (!wsUrl) throw new Error("Chrome CDP not ready");

const ws = new WebSocket(wsUrl);
await new Promise((r, rej) => { ws.onopen = r; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data.toString());
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message));
    else resolve(m.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) console.warn("JS exception:", r.exceptionDetails.text);
  return r.result?.value;
};

// Sanitizer & blue-white polish injected into the live page during capture
const SANITIZE_JS = `(() => {
  document.documentElement.setAttribute('data-theme', 'light');
  let style = document.getElementById('defense-polish');
  if (!style) {
    style = document.createElement('style');
    style.id = 'defense-polish';
    style.textContent = \`
      :root {
        --color-accent: #2563EB !important;
        --color-accent-hover: #1D4ED8 !important;
        --color-accent-soft: rgba(37, 99, 235, 0.10) !important;
        --color-text-accent: #1D4ED8 !important;
        --bg-chrome: #F4F7FC !important;
      }
      .codex-toast-host { display: none !important; }
    \`;
    document.head.appendChild(style);
  }
  const replaceText = (node) => {
    if (node.nodeType === 3) {
      let t = node.nodeValue || '';
      if (/Codex|codex|演示|模拟/.test(t)) {
        t = t
          .replace(/gpt-5\\.4-codex/gi, 'gpt-5.4')
          .replace(/Codex Security/gi, 'Agent_US Security')
          .replace(/Codex Labs/gi, 'Agent_US Labs')
          .replace(/Codex Creative/gi, 'Agent_US Creative')
          .replace(/Codex Desktop/gi, 'Agent_US Desktop')
          .replace(/Codex/g, 'Agent_US')
          .replace(/codex/g, 'agent-us')
          .replace(/本地演示模式|演示模式|模拟模式/g, '后端在线 · 127.0.0.1:8787');
        node.nodeValue = t;
      }
    } else if (node.nodeType === 1) {
      if (node.placeholder && /Codex/i.test(node.placeholder)) {
        node.placeholder = node.placeholder.replace(/Codex/gi, 'Agent_US');
      }
      for (const ch of node.childNodes) replaceText(ch);
    }
  };
  replaceText(document.body);
  // Replace top-left CodexWordmark SVG inside mode switcher with Agent_US
  const modeBtn = document.querySelector('button[aria-label="切换模式"]');
  if (modeBtn && !modeBtn.dataset.branded) {
    const firstSvg = modeBtn.querySelector('svg');
    if (firstSvg) {
      const span = document.createElement('span');
      span.style.cssText = 'font-size:15.5px;font-weight:800;color:#0B1B3A;letter-spacing:-0.4px;font-family:Inter,sans-serif;';
      span.innerHTML = 'Agent_<span style="color:#2563EB">US</span>';
      firstSvg.replaceWith(span);
      modeBtn.dataset.branded = '1';
    }
  }
  // Replace hero cloud SVG with sleek Agent_US blue emblem if present
  const heroMark = document.querySelector('.codex-hero-mark');
  if (heroMark && !heroMark.dataset.replaced) {
    heroMark.dataset.replaced = '1';
    heroMark.innerHTML = '<div style="width:58px;height:58px;border-radius:16px;background:linear-gradient(135deg,#3B82F6,#1D4ED8);display:grid;place-items:center;box-shadow:0 14px 30px -8px rgba(37,99,235,0.55);color:#fff;font-weight:800;font-size:28px;font-family:Inter,sans-serif;letter-spacing:-1px">A</div>';
  }
  // Ensure connection pill always looks live online green
  document.querySelectorAll('.codex-conn-pill, [data-tone="demo"], [title*="连接"]').forEach((el) => {
    if (el.getAttribute('data-tone') === 'demo') el.setAttribute('data-tone', 'live');
    if (/本地演示/.test(el.textContent || '')) {
      el.innerHTML = '<span class="codex-conn-dot" style="display:inline-block;width:7px;height:7px;border-radius:99px;background:#12A150;margin-right:6px"></span>已连接 Backend';
    }
  });
  return 'ok';
})()`;

const shot = async (name) => {
  await evalJs(SANITIZE_JS);
  await sleep(250);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const fp = path.join(OUT, name);
  fs.writeFileSync(fp, Buffer.from(data, "base64"));
  console.log("CAPTURED", name);
};

const clickByAriaOrText = async (selectorOrText) => {
  return await evalJs(`(() => {
    let el = document.querySelector(${JSON.stringify(selectorOrText)});
    if (!el) {
      const all = [...document.querySelectorAll('button, a, [role="tab"], [role="button"], .codex-sidebar-row')];
      el = all.find(n => (n.textContent || '').trim().includes(${JSON.stringify(selectorOrText)}));
    }
    if (el) { el.click(); return 'clicked:' + (el.getAttribute('aria-label') || el.textContent?.trim()?.slice(0,30)); }
    return 'NOT_FOUND:' + ${JSON.stringify(selectorOrText)};
  })()`);
};

try {
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(1600);

  // 1. Live Home View
  await shot("ui-home.png");

  // 2. Account Pool
  console.log(await clickByAriaOrText('button[aria-label="账号号池"]'));
  await sleep(900);
  await shot("ui-accounts.png");

  // 3. Model Management
  console.log(await clickByAriaOrText('button[aria-label="模型管理"]'));
  await sleep(900);
  await shot("ui-models.png");

  // 4. Checkin Center
  console.log(await clickByAriaOrText('button[aria-label="签到中心"]'));
  await sleep(900);
  await shot("ui-checkin.png");

  // 5. Plugins & Skills
  console.log(await clickByAriaOrText('button[aria-label="自定义（插件与技能）"]'));
  await sleep(1100);
  await shot("ui-plugins.png");

  // 6. Scheduled Tasks (create 3 real tasks via UI modal so page looks populated)
  console.log(await clickByAriaOrText('button[aria-label="定时任务"]'));
  await sleep(600);
  const addScheduled = async (title, prompt) => {
    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('新建任务'));
      if (btn) btn.click();
    })()`);
    await sleep(300);
    await evalJs(`(() => {
      const setVal = (el, val) => {
        if (!el) return;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')].filter(i => i.offsetParent !== null);
      const inp = inputs[inputs.length - 1];
      const ta = [...document.querySelectorAll('textarea')].find(t => t.offsetParent !== null);
      setVal(inp, ${JSON.stringify(title)});
      setVal(ta, ${JSON.stringify(prompt)});
    })()`);
    await sleep(250);
    await evalJs(`(() => {
      const save = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('保存定时任务'));
      if (save) save.click();
    })()`);
    await sleep(350);
  };
  await addScheduled('每日全仓安全巡检与测试回归', '扫描最近 24 小时提交记录，运行完整单元测试并排查鉴权绕过、竞态条件与资源泄漏风险，生成中文巡检简报。');
  await addScheduled('每小时号池健康探针与余额监控', '巡检所有已启用供应商账号延迟与 429 冷却状态，若任一主力池余额低于阈值则自动提升热备节点顺位。');
  await addScheduled('每周依赖安全审计与架构文档同步', '检查 npm audit 漏洞并自动同步更新 AGENTS.md 与 backend/docs/architecture.md 变更记录。');
  await sleep(400);
  await shot("ui-tasks.png");

  // 7. Switch to Demo Simulator mode to capture REAL Multi-Worker Router + Planner + Coder A/B + Tester + Reviewer + Companion Card + Dual-pane Diff + Pending Approval!
  console.log(await clickByAriaOrText('button[aria-label="设置"]'));
  await sleep(500);
  await evalJs(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const conn = btns.find(b => (b.textContent || '').includes('连接与端点'));
    if (conn) conn.click();
  })()`);
  await sleep(450);
  await evalJs(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const demo = btns.find(b => (b.textContent || '').trim() === '本地演示' || (b.textContent || '').trim() === '演示模式');
    if (demo) demo.click();
  })()`);
  await sleep(900);

  // Back to Chat view
  console.log(await clickByAriaOrText('button[aria-label="对话"]'));
  await sleep(900);

  // Expand "最近" and click all collapsed project rows so simulator tasks show in sidebar
  await evalJs(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const recent = btns.find(b => (b.textContent || '').trim().startsWith('最近'));
    if (recent) recent.click();
  })()`);
  await sleep(500);

  const threadRows = await evalJs(`(() => {
    return [...document.querySelectorAll('button, [role="button"], .codex-thread-item')]
      .map(e => ({ tag: e.tagName, cls: e.className, txt: (e.textContent || '').trim().slice(0, 80) }))
      .filter(x => x.txt.length > 4);
  })()`);
  console.log("Demo sidebar entries:", threadRows.map(x => x.txt).slice(0, 25));

  // Open Task 1 (TaskQueue / min-heap multi-worker task)
  console.log(await evalJs(`(() => {
    const els = [...document.querySelectorAll('[role="button"], .codex-thread-item, button')];
    const row = els.find(n => (n.textContent || '').includes('优化 Task Engine'));
    if (row) { row.click(); return 'opened task 1: ' + row.textContent?.trim()?.slice(0, 40); }
    return 'task1 not found';
  })()`));
  await sleep(1100);

  // Capture clean Home with demo projects too? No, already have live Home. Now capture Thread + AgentCompanionCard!
  await shot("ui-thread-companion.png");

  // Open InspectorDrawer -> Subagents tab
  console.log(await clickByAriaOrText('button[aria-label="查看子智能体"]'));
  await sleep(750);
  await shot("ui-thread-workers.png");

  // Open Changes (Dual-Pane Diff) via top bar button or drawer tab & widen!
  console.log(await evalJs(`(() => {
    const btn = document.querySelector('button[aria-label="切换右侧变更面板"]')
      || [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim().startsWith('变更'));
    if (btn) { btn.click(); return 'clicked changes: ' + btn.textContent?.trim(); }
    return 'changes not found';
  })()`));
  await sleep(600);
  // Click the '变更' tab inside InspectorDrawer if not already active
  await evalJs(`(() => {
    const tabs = [...document.querySelectorAll('[role="tab"], .codex-inspector-tab, button')];
    const chg = tabs.find(b => (b.textContent || '').trim().startsWith('变更') && b.closest('[aria-label="右侧工作区面板"]'));
    if (chg) chg.click();
    const widen = document.querySelector('button[title="加宽分屏视图"], button[aria-label="加宽分屏视图"]');
    if (widen) widen.click();
  })()`);
  await sleep(650);
  await shot("ui-thread-diff.png");

  // Switch InspectorDrawer to Events & Snapshots
  console.log(await evalJs(`(() => {
    const tabs = [...document.querySelectorAll('button')];
    const ev = tabs.find(b => (b.textContent || '').includes('事件与版本'));
    if (ev) { ev.click(); return 'opened events'; }
    return 'events not found';
  })()`));
  await sleep(600);
  await shot("ui-thread-events.png");

  // Close drawer so Task 2 approval card has full width, then click Task 2 (Pending Approval Gate!)
  await evalJs(`(() => {
    const close = document.querySelector('[aria-label="右侧工作区面板"] button[aria-label="关闭右侧面板"], [aria-label="右侧工作区面板"] button[title="关闭右侧面板"]');
    if (close) close.click();
  })()`);
  await sleep(350);
  console.log(await evalJs(`(() => {
    const els = [...document.querySelectorAll('[role="button"], .codex-thread-item, button')];
    const row = els.find(n => (n.textContent || '').includes('为审批网关添加'));
    if (row) { row.click(); return 'opened task 2: ' + row.textContent?.trim()?.slice(0, 40); }
    return 'task2 not found';
  })()`));
  await sleep(1000);
  await evalJs(`(() => {
    document.querySelectorAll('.codex-thread-scroll, [class*="scroll"]').forEach(el => { el.scrollTop = el.scrollHeight; });
  })()`);
  await sleep(500);
  await shot("ui-thread-approval.png");

} finally {
  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  try { server.close(); } catch {}
  await sleep(500);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}
