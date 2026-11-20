import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Fault, id as uuid } from './store.js';
import { maskSecret } from './pool.js';

const LOGIN_TTL_MS = 10 * 60 * 1000;
const GITHUB_COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';

// Official consoles / portals for direct API key / token retrieval
export const OFFICIAL_PORTAL_URLS = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  gemini: 'https://aistudio.google.com/app/apikey',
  openrouter: 'https://openrouter.ai/settings/keys',
  siliconflow: 'https://cloud.siliconflow.cn/account/ak',
  kimi: 'https://platform.moonshot.cn/console/api-keys',
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
  'glm-coding': 'https://z.ai/manage-apikey/apikey-list',
  qwen: 'https://bailian.console.aliyun.com/?apiKey=1',
  minimax: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  'minimax-cn': 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  groq: 'https://console.groq.com/keys',
  xai: 'https://console.x.ai/',
  volcengine: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  huggingface: 'https://huggingface.co/settings/tokens',
  nvidia: 'https://build.nvidia.com/',
  sensenova: 'https://console.sensecore.cn/',
  'xiaomi-mimo': 'https://platform.xiaomimimo.com/',
  'github-copilot': 'https://github.com/login/device',
  'claude-code': 'https://console.anthropic.com/settings/keys',
  'openai-codex': 'https://platform.openai.com/api-keys',
  'gemini-cli': 'https://aistudio.google.com/app/apikey',
  'opencode-go': 'https://opencode.ai/',
  'opencode-zen': 'https://opencode.ai/',
};

function stripV1(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
}

function extractTokenFromObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  const preferredKeys = [
    'oauth_token',
    'apiKey',
    'api_key',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'GEMINI_API_KEY',
    'OPENROUTER_API_KEY',
    'accessToken',
    'access_token',
    'token',
    'sessionToken',
    'session_token',
    'credential',
    'secret',
    'key',
  ];
  for (const k of preferredKeys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length >= 6) {
      return { token: v.trim(), sourceKey: k };
    }
  }
  const nestedContainers = [
    'tokens',
    'claudeAiOauth',
    'oauth',
    'auth',
    'credentials',
    'credential',
    'account',
    'data',
  ];
  for (const c of nestedContainers) {
    if (obj[c] && typeof obj[c] === 'object') {
      const hit = extractTokenFromObject(obj[c], depth + 1);
      if (hit) return hit;
    }
  }
  if (Array.isArray(obj.accounts) && obj.accounts.length > 0) {
    const hit = extractTokenFromObject(obj.accounts[0], depth + 1);
    if (hit) return hit;
  }
  if (Array.isArray(obj) && obj.length > 0) {
    const hit = extractTokenFromObject(obj[0], depth + 1);
    if (hit) return hit;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const hit = extractTokenFromObject(v, depth + 1);
      if (hit) return { token: hit.token, sourceKey: `${k}.${hit.sourceKey}` };
    }
  }
  return null;
}

export function parseCredentialContent(rawText, fileName = '') {
  const text = String(rawText ?? '').trim();
  if (!text) throw new Fault('CREDENTIAL_CONTENT_EMPTY', 400);

  // 1. JSON format (Codex auth.json, Claude .credentials.json, Gemini oauth_creds.json, Copilot hosts.json/apps.json, generic JSON)
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const hit = extractTokenFromObject(parsed);
      const rootObj = Array.isArray(parsed)
        ? parsed[0]
        : Array.isArray(parsed?.accounts)
          ? parsed.accounts[0]
          : parsed;
      const endpoint =
        typeof rootObj?.endpoint === 'string'
          ? rootObj.endpoint
          : typeof rootObj?.baseUrl === 'string'
            ? rootObj.baseUrl
            : typeof rootObj?.base_url === 'string'
              ? rootObj.base_url
              : undefined;
      const label =
        typeof rootObj?.label === 'string'
          ? rootObj.label
          : typeof rootObj?.name === 'string'
            ? rootObj.name
            : typeof rootObj?.user === 'string'
              ? rootObj.user
              : typeof rootObj?.email === 'string'
                ? rootObj.email
                : typeof rootObj?.nickname === 'string'
                  ? rootObj.nickname
                  : undefined;
      const detectedPreset =
        typeof rootObj?.preset === 'string'
          ? rootObj.preset
          : typeof rootObj?.provider === 'string'
            ? rootObj.provider
            : undefined;
      if (!hit) {
        throw new Fault('NO_TOKEN_FOUND_IN_FILE', 400, {
          message: 'JSON 文件中未找到可识别的 token / apiKey / accessToken / oauth_token 字段',
        });
      }
      return {
        token: hit.token,
        sourceKey: hit.sourceKey,
        endpoint,
        label,
        detectedPreset,
        format: 'json',
        fileName,
      };
    } catch (err) {
      if (err instanceof Fault) throw err;
    }
  }

  // 2. .env / KEY=VALUE format
  const envLines = text.split(/\r?\n/);
  let envToken = '';
  let envEndpoint = '';
  let envKey = '';
  for (const line of envLines) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) continue;
    const m = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(clean);
    if (!m) continue;
    const k = m[1];
    const v = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (/key|token|secret/i.test(k) && v.length >= 6 && !envToken) {
      envToken = v;
      envKey = k;
    } else if (/base_url|endpoint|api_url/i.test(k) && /^https?:\/\//i.test(v)) {
      envEndpoint = v;
    }
  }
  if (envToken) {
    return {
      token: envToken,
      sourceKey: envKey,
      endpoint: envEndpoint || undefined,
      format: 'env',
      fileName,
    };
  }

  // 3. Raw bearer token
  const cleaned = text.replace(/^Bearer\s+/i, '').trim();
  if (cleaned.length < 6) {
    throw new Fault('INVALID_CREDENTIAL_TEXT', 400, {
      message: '凭证内容过短，请上传 JSON/.env 文件或粘贴有效 Token',
    });
  }
  return {
    token: cleaned,
    sourceKey: 'raw',
    format: 'raw',
    fileName,
  };
}

function getLocalCliCandidates(homeDir = homedir()) {
  const localAppData = process.env.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
  return [
    {
      id: 'github-copilot-apps',
      preset: 'github-copilot',
      label: 'GitHub Copilot (本机 CLI)',
      paths: [
        join(localAppData, 'github-copilot', 'apps.json'),
        join(homeDir, '.config', 'github-copilot', 'apps.json'),
      ],
    },
    {
      id: 'github-copilot-hosts',
      preset: 'github-copilot',
      label: 'GitHub Copilot (hosts.json)',
      paths: [
        join(localAppData, 'github-copilot', 'hosts.json'),
        join(homeDir, '.config', 'github-copilot', 'hosts.json'),
      ],
    },
    {
      id: 'claude-code-local',
      preset: 'claude-code',
      label: 'Claude Code (本机凭证)',
      paths: [join(homeDir, '.claude', '.credentials.json')],
    },
    {
      id: 'openai-codex-local',
      preset: 'openai-codex',
      label: 'OpenAI Codex (本机凭证)',
      paths: [join(homeDir, '.codex', 'auth.json')],
    },
    {
      id: 'gemini-cli-local',
      preset: 'gemini-cli',
      label: 'Gemini CLI (本机凭证)',
      paths: [join(homeDir, '.gemini', 'oauth_creds.json')],
    },
  ];
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCallbackHtml(ok, title, subtitle) {
  const badgeColor = ok ? '#059669' : '#dc2626';
  const icon = ok ? '✓' : '✕';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — Agent_US</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { max-width: 440px; width: 92%; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 28px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08); text-align: center; }
    .icon { width: 48px; height: 48px; border-radius: 999px; background: ${badgeColor}; color: #fff; font-size: 24px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 14px; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { font-size: 13.5px; color: #475569; line-height: 1.6; margin: 0 0 18px; }
    button { border: 1px solid #cbd5e1; background: #0f172a; color: #fff; border-radius: 8px; padding: 8px 18px; font-size: 13px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(subtitle)}</p>
    <button onclick="window.close()">关闭窗口</button>
  </div>
  ${ok ? '<script>setTimeout(() => { try { window.close(); } catch {} }, 1800);</script>' : ''}
</body>
</html>`;
}

export class WebLoginService {
  constructor(store, pool, { root, homeDir = homedir() }) {
    this.store = store;
    this.pool = pool;
    this.root = root;
    this.homeDir = homeDir;
    this.flows = new Map();
  }

  #cleanupExpired() {
    const now = Date.now();
    for (const [id, flow] of this.flows.entries()) {
      if (now - flow.createdAt > LOGIN_TTL_MS * 2) {
        this.flows.delete(id);
      }
    }
  }

  async #finalizePoolAccount({
    preset,
    label,
    endpoint,
    credential,
    meta = {},
    autoSync = true,
  }) {
    const presetSpec = this.pool.getPreset(preset);
    const acc = this.pool.createAccount({
      preset: presetSpec.id,
      label: label || `${presetSpec.name} 账号`,
      endpoint: endpoint || presetSpec.defaultEndpoint || undefined,
      credential: credential || undefined,
      enabled: true,
      meta,
    });
    let syncedModelsCount = 0;
    if (autoSync) {
      try {
        const synced = await this.pool.syncAccountModels(acc.id);
        syncedModelsCount = synced.models?.length ?? 0;
      } catch {
        // Account is saved even if upstream model list isn't immediately reachable
      }
    }
    return {
      account: this.pool.getAccount(acc.id),
      syncedModelsCount,
    };
  }

  /**
   * Self-contained native web login:
   * 1. OpenRouter OAuth2 PKCE (S256) with local 8787 callback
   * 2. GitHub Copilot OAuth Device Flow (direct to github.com, zero external service)
   * 3. Official API console quick-open + paste token
   */
  async startWebLogin({
    preset,
    callbackOrigin = '',
    autoSync = true,
  } = {}) {
    this.#cleanupExpired();
    const presetSpec = this.pool.getPreset(preset);
    const resolvedPreset = presetSpec.id;
    const flowId = uuid();

    // 1. Native OpenRouter OAuth2 PKCE (S256)
    if (resolvedPreset === 'openrouter') {
      const state = randomBytes(16).toString('hex');
      const codeVerifier = randomBytes(32).toString('base64url');
      const codeChallenge = createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
      const origin =
        String(callbackOrigin || '').replace(/\/+$/, '') ||
        'http://127.0.0.1:8787';
      const callbackUrl = `${origin}/v1/auth/oauth/callback?state=${encodeURIComponent(state)}`;
      const authUrl =
        `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callbackUrl)}` +
        `&code_challenge=${encodeURIComponent(codeChallenge)}` +
        `&code_challenge_method=S256`;
      this.flows.set(flowId, {
        flowId,
        engine: 'openrouter-pkce',
        preset: resolvedPreset,
        state,
        codeVerifier,
        authUrl,
        autoSync,
        status: 'pending',
        createdAt: Date.now(),
      });
      return {
        ok: true,
        flowId,
        engine: 'openrouter-pkce',
        preset: resolvedPreset,
        authUrl,
        state,
        instructions:
          '请在新打开的 OpenRouter 授权页点击确认授权，系统将自动接收回调并换取 API Key 加密入池。',
      };
    }

    // 2. Native GitHub Copilot OAuth Device Flow (direct to GitHub, zero external gateway!)
    if (resolvedPreset === 'github-copilot') {
      const deviceUrl =
        process.env.GITHUB_DEVICE_CODE_URL ||
        'https://github.com/login/device/code';
      try {
        const res = await fetch(deviceUrl, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Agent-US/1.0',
          },
          body: JSON.stringify({
            client_id: GITHUB_COPILOT_CLIENT_ID,
            scope: 'read:user',
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.device_code || !data?.user_code) {
          return {
            ok: false,
            engine: 'github-device',
            message:
              data?.error_description ||
              data?.error ||
              `发起 GitHub 设备码登录失败 (HTTP ${res.status})`,
          };
        }
        const verificationUri = String(
          data.verification_uri || 'https://github.com/login/device',
        );
        const intervalSec = Math.max(5, Number(data.interval || 5));
        const expiresIn = Math.max(60, Number(data.expires_in || 900));
        this.flows.set(flowId, {
          flowId,
          engine: 'github-device',
          preset: resolvedPreset,
          deviceCode: String(data.device_code),
          userCode: String(data.user_code),
          authUrl: verificationUri,
          intervalMs: intervalSec * 1000,
          nextPollAt: Date.now() + 2000,
          expiresAt: Date.now() + expiresIn * 1000,
          autoSync,
          status: 'pending',
          createdAt: Date.now(),
        });
        return {
          ok: true,
          flowId,
          engine: 'github-device',
          preset: resolvedPreset,
          authUrl: verificationUri,
          userCode: String(data.user_code),
          verificationUri,
          interval: intervalSec,
          expiresIn,
          instructions: `请在新标签页打开 ${verificationUri} 并输入一次性验证码 ${data.user_code}，授权完成后自动入池（零外部网关）。`,
        };
      } catch (err) {
        return {
          ok: false,
          engine: 'github-device',
          message: `连接 GitHub 设备授权接口失败：${String(err?.message ?? err)}`,
        };
      }
    }

    // 3. Official Web Portal quick-open + paste API Key / Token
    const portalUrl =
      OFFICIAL_PORTAL_URLS[resolvedPreset] ||
      (presetSpec.defaultEndpoint ? stripV1(presetSpec.defaultEndpoint) : '');
    if (!portalUrl) {
      throw new Fault('WEB_LOGIN_UNSUPPORTED', 400, {
        message: `${presetSpec.name} 暂无预设控制台地址，请使用「导入凭证文件」或「API Key / 网关」添加。`,
      });
    }
    this.flows.set(flowId, {
      flowId,
      engine: 'portal-token',
      preset: resolvedPreset,
      authUrl: portalUrl,
      autoSync,
      status: 'pending',
      createdAt: Date.now(),
    });
    return {
      ok: true,
      flowId,
      engine: 'portal-token',
      preset: resolvedPreset,
      authUrl: portalUrl,
      instructions: `已打开 ${presetSpec.name} 官方控制台，完成登录后复制 API Key / Token 粘贴到下方即可自动加密入池。`,
    };
  }

  /**
   * Public OAuth2 redirect callback handler (OpenRouter PKCE).
   * Authenticated by single-use cryptographic `state`.
   */
  async handleOAuthCallback({ state = '', code = '', error = '' } = {}) {
    this.#cleanupExpired();
    const flow = [...this.flows.values()].find(
      (f) => f.engine === 'openrouter-pkce' && f.state === state,
    );
    if (!flow) {
      return {
        ok: false,
        html: renderCallbackHtml(
          false,
          '登录状态已失效或不存在',
          '请返回 Agent_US 重新点击「打开网页登录」。',
        ),
      };
    }
    if (error || !code) {
      flow.status = 'failed';
      flow.error = error || '未收到授权码 (code)';
      return {
        ok: false,
        html: renderCallbackHtml(false, '授权未完成', flow.error),
      };
    }
    try {
      const exchangeUrl =
        process.env.OPENROUTER_AUTH_KEYS_URL ||
        'https://openrouter.ai/api/v1/auth/keys';
      const res = await fetch(exchangeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          code,
          code_verifier: flow.codeVerifier,
          code_challenge_method: 'S256',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.key) {
        throw new Error(
          data?.error?.message || `OpenRouter 换取 Key 失败 (HTTP ${res.status})`,
        );
      }
      const finalized = await this.#finalizePoolAccount({
        preset: 'openrouter',
        label: data.label || 'OpenRouter (网页授权)',
        endpoint: 'https://openrouter.ai/api/v1',
        credential: String(data.key),
        meta: { authSource: 'openrouter-pkce' },
        autoSync: flow.autoSync,
      });
      flow.status = 'done';
      flow.result = finalized;
      return {
        ok: true,
        html: renderCallbackHtml(
          true,
          'OpenRouter 网页授权成功！',
          `已自动加密保存 API Key 并同步 ${finalized.syncedModelsCount} 个模型，现在可以关闭此标签页返回 Agent_US。`,
        ),
      };
    } catch (err) {
      flow.status = 'failed';
      flow.error = String(err?.message ?? err);
      return {
        ok: false,
        html: renderCallbackHtml(false, '换取 API Key 失败', flow.error),
      };
    }
  }

  async getWebLoginStatus(flowId) {
    this.#cleanupExpired();
    const flow = this.flows.get(flowId);
    if (!flow) {
      throw new Fault('LOGIN_FLOW_NOT_FOUND', 404, {
        message: '登录任务不存在或已过期',
      });
    }
    if (flow.status === 'done') return { status: 'done', ...flow.result };
    if (flow.status === 'failed') return { status: 'failed', error: flow.error };
    if (flow.status === 'canceled') return { status: 'canceled' };

    // Poll GitHub Device Flow directly when due
    if (flow.engine === 'github-device') {
      const now = Date.now();
      if (now >= flow.expiresAt) {
        flow.status = 'failed';
        flow.error = 'GitHub 设备码已过期，请重新发起网页登录。';
        return { status: 'failed', error: flow.error };
      }
      if (now < flow.nextPollAt) {
        return {
          status: 'pending',
          userCode: flow.userCode,
          hint: `等待在 GitHub 输入验证码 ${flow.userCode}…`,
        };
      }
      flow.nextPollAt = now + flow.intervalMs;
      const tokenUrl =
        process.env.GITHUB_ACCESS_TOKEN_URL ||
        'https://github.com/login/oauth/access_token';
      try {
        const res = await fetch(tokenUrl, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Agent-US/1.0',
          },
          body: JSON.stringify({
            client_id: GITHUB_COPILOT_CLIENT_ID,
            device_code: flow.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json().catch(() => ({}));
        if (data?.access_token) {
          const finalized = await this.#finalizePoolAccount({
            preset: 'github-copilot',
            label: 'GitHub Copilot (网页授权)',
            endpoint: 'https://api.githubcopilot.com',
            credential: String(data.access_token),
            meta: { authSource: 'github-device' },
            autoSync: flow.autoSync,
          });
          flow.status = 'done';
          flow.result = finalized;
          return { status: 'done', ...finalized };
        }
        if (data?.error === 'slow_down') {
          flow.intervalMs += 5000;
          flow.nextPollAt = Date.now() + flow.intervalMs;
          return {
            status: 'pending',
            userCode: flow.userCode,
            hint: `等待确认设备码 ${flow.userCode}…`,
          };
        }
        if (data?.error === 'authorization_pending') {
          return {
            status: 'pending',
            userCode: flow.userCode,
            hint: `等待在 GitHub 输入验证码 ${flow.userCode}…`,
          };
        }
        if (data?.error) {
          flow.status = 'failed';
          flow.error = data.error_description || data.error;
          return { status: 'failed', error: flow.error };
        }
      } catch (err) {
        return {
          status: 'pending',
          userCode: flow.userCode,
          hint: `正在等待 GitHub 授权响应 (${String(err?.message ?? err).slice(0, 60)})…`,
        };
      }
    }

    return {
      status: 'pending',
      hint:
        flow.engine === 'openrouter-pkce'
          ? '等待 OpenRouter 授权页回调…'
          : '请在打开的官方页面获取 Token / API Key 后粘贴到下方提交。',
    };
  }

  async submitWebLoginCallback(
    flowId,
    { callbackUrl = '', token = '', label = '', endpoint = '' } = {},
  ) {
    this.#cleanupExpired();
    const flow = this.flows.get(flowId);
    if (!flow) {
      throw new Fault('LOGIN_FLOW_NOT_FOUND', 404, {
        message: '登录任务不存在或已过期',
      });
    }

    if (flow.engine === 'openrouter-pkce' && callbackUrl.trim()) {
      try {
        const u = new URL(callbackUrl.trim());
        const code = u.searchParams.get('code') || '';
        const st = u.searchParams.get('state') || flow.state;
        const out = await this.handleOAuthCallback({ state: st, code });
        return { ok: out.ok, status: flow.status, ...(flow.result || {}) };
      } catch (err) {
        throw new Fault('INVALID_CALLBACK_URL', 400, {
          message: `回调 URL 解析失败：${String(err?.message ?? err)}`,
        });
      }
    }

    const raw = (token || callbackUrl || '').trim();
    if (!raw) {
      throw new Fault('MISSING_TOKEN', 400, {
        message: '请粘贴登录获取到的 Token / API Key',
      });
    }
    const parsed = parseCredentialContent(raw);
    const finalized = await this.#finalizePoolAccount({
      preset: flow.preset,
      label: label.trim() || parsed.label || `${this.pool.getPreset(flow.preset).name} (网页登录)`,
      endpoint: endpoint.trim() || parsed.endpoint || undefined,
      credential: parsed.token,
      meta: { authSource: flow.engine },
      autoSync: flow.autoSync,
    });
    flow.status = 'done';
    flow.result = finalized;
    return { ok: true, status: 'done', ...finalized };
  }

  async cancelWebLogin(flowId) {
    const flow = this.flows.get(flowId);
    if (!flow) return { ok: true };
    flow.status = 'canceled';
    return { ok: true };
  }

  /**
   * Read-only scan of standard local CLI credential files.
   * Never returns raw secrets — only masked preview + safe candidate ID.
   */
  scanLocalCredentials() {
    const found = [];
    for (const c of getLocalCliCandidates(this.homeDir)) {
      const hitPath = c.paths.find((p) => existsSync(p));
      if (!hitPath) continue;
      try {
        const raw = readFileSync(hitPath, 'utf8');
        const parsed = parseCredentialContent(raw, hitPath);
        found.push({
          id: c.id,
          preset: c.preset,
          label: parsed.label ? `${c.label} (${parsed.label})` : c.label,
          filePath: hitPath,
          extractedKey: parsed.sourceKey,
          maskedToken: maskSecret(parsed.token),
        });
      } catch {
        // skip unreadable or non-token files
      }
    }
    return { items: found };
  }

  async importLocalCredential({ id: candidateId, autoSync = true } = {}) {
    const target = getLocalCliCandidates(this.homeDir).find(
      (c) => c.id === candidateId,
    );
    if (!target) {
      throw new Fault('LOCAL_CREDENTIAL_NOT_FOUND', 404, {
        message: '未找到对应的本机 CLI 凭证项',
      });
    }
    const hitPath = target.paths.find((p) => existsSync(p));
    if (!hitPath) {
      throw new Fault('LOCAL_CREDENTIAL_FILE_MISSING', 404, {
        message: '本机凭证文件不存在',
      });
    }
    const content = readFileSync(hitPath, 'utf8');
    return this.importCredentialFile({
      preset: target.preset,
      label: target.label,
      fileName: hitPath,
      content,
      autoSync,
    });
  }

  async importCredentialFile({
    preset,
    label = '',
    endpoint = '',
    fileName = '',
    content = '',
    autoSync = true,
  } = {}) {
    const parsed = parseCredentialContent(content, fileName);
    const resolvedPreset = preset || parsed.detectedPreset || 'custom-openai';
    const presetSpec = this.pool.getPreset(resolvedPreset);
    const finalized = await this.#finalizePoolAccount({
      preset: presetSpec.id,
      label:
        label.trim() ||
        parsed.label ||
        `${presetSpec.name}${fileName ? ` (${fileName.split(/[\\/]/).pop()})` : ' (凭证导入)'}`,
      endpoint: endpoint.trim() || parsed.endpoint || undefined,
      credential: parsed.token,
      meta: {
        authSource: 'credential-file',
        credentialFormat: parsed.format,
        credentialField: parsed.sourceKey,
        fileName: fileName ? fileName.split(/[\\/]/).pop() : undefined,
      },
      autoSync,
    });
    return {
      ok: true,
      format: parsed.format,
      extractedKey: parsed.sourceKey,
      ...finalized,
    };
  }
}
