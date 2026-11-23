import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { release } from 'node:os';
import { listenForGrant, pkce } from './loopback.js';
import { traeCompletion } from './trae-stream.js';

const clientId = 'ono9krqynydwx5';
const functions = [
  'chat_v3',
  'solo_work_lite',
  'solo_agent',
  'solo_agent_lite',
  'solo_coder',
];
function object(v) {
  if (typeof v === 'object') return v ?? {};
  try {
    return JSON.parse(v) ?? {};
  } catch {
    return {};
  }
}
function expiry(value, token) {
  let t = Number(value) || Date.parse(value);
  if (!t)
    t = object(
      Buffer.from(String(token).split('.')[1] || '', 'base64url').toString(),
    ).exp;
  return (t > 1e12 ? t : t * 1000) || 0;
}
async function post(url, body, headers, signal) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'error',
    signal,
  });
}
function sessionFrom(p, raw, info, base) {
  const token = raw.Token || raw.token || raw.AccessToken || raw.accessToken;
  if (typeof token !== 'string' || !token)
    throw new Error('Trae 未返回有效授权');
  const host = info.Host || '',
    region = info.region || info.Region || info.AIRegion || info.aiRegion || '';
  if (/console\.enterprise\./i.test(host))
    throw new Error('企业席位需要独立的模型路由');
  const api =
    p.us &&
    (host === p.us ||
      host === new URL(p.us).host ||
      /^US(?:$|[-_ ])/i.test(region))
      ? p.us
      : base.api || p.api;
  return {
    ...base,
    api,
    token,
    uid: String(info.UserID || info.userId || base.uid || ''),
    refreshToken:
      raw.RefreshToken ||
      raw.refreshToken ||
      raw.refresh_token ||
      base.refreshToken,
    expiresAt: expiry(
      raw.TokenExpireAt || raw.tokenExpireAt || raw.ExpiresAt || raw.expiresAt,
      token,
    ),
  };
}
async function exchange(p, path, body, base, signal) {
  const res = await post(
    p.auth + path,
    body,
    {},
    signal
      ? AbortSignal.any([AbortSignal.timeout(15000), signal])
      : AbortSignal.timeout(15000),
  );
  if (!res.ok) throw new Error(`Trae 授权 HTTP ${res.status}`);
  const data = await res.json(),
    r = data.Result || data.result || data;
  return sessionFrom(p, r, object(r.UserInfo || r.userInfo), base);
}
export function refreshTrae(p, s, signal) {
  if (!s.refreshToken) throw new Error('请重新登录 Trae');
  return exchange(
    p,
    '/cloudide/api/v3/trae/oauth/ExchangeToken',
    {
      ClientID: clientId,
      RefreshToken: s.refreshToken,
      ClientSecret: '-',
      UserID: '',
    },
    s,
    signal,
  );
}
function callbackCode(q) {
  const keys = [
    'authCode',
    'auth_code',
    'AuthCode',
    'authorization_code',
    'code',
    'AuthCodeToken',
  ];
  for (const k of keys) if (q.get(k)) return q.get(k);
  const roots = ['authCodeInfo', 'auth_code_info', 'AuthCodeInfo'].map((k) =>
    object(q.get(k)),
  );
  while (roots.length) {
    const part = roots.pop();
    for (const k of keys)
      if (typeof part[k] === 'string' && part[k]) return part[k];
    for (const v of Object.values(part))
      if (v && typeof v === 'object') roots.push(v);
  }
}
export async function startTrae(p, signal) {
  const { verifier, challenge } = pkce(),
    trace = randomUUID();
  const device = { deviceId: randomUUID(), machineId: randomUUID() };
  const pub = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  }).publicKey.export({ format: 'pem', type: 'spki' });
  const loop = await listenForGrant({
    path: '/authorize',
    origin: p.web,
    signal,
    async receive(q, callback, req) {
      const info = object(q.get('userInfo')),
        jwt = object(q.get('userJwt'));
      const base = { ...device, sessionId: randomUUID() };
      const code = callbackCode(q);
      let session;
      if (code) {
        session = await exchange(
          p,
          '/trae/api/v3/oauth/ExchangeToken',
          {
            ClientID: clientId,
            AuthCode: code,
            CodeVerifier: verifier,
            IDEVersion: p.version,
            DeviceInfo: {
              DeviceID: device.deviceId,
              MachineID: device.machineId,
              PlatformCode: 'IDE_PC',
              DeviceType: 'PC',
              DeviceName: 'Agent_US',
              DeviceModel: 'Agent_US',
              ClientVersion: p.version,
              DevicePublicKey: pub,
              OSInfo: process.platform,
              OSVersion: release(),
            },
          },
          base,
          signal,
        );
      } else {
        // Legacy pages send a token rather than a PKCE code. Only accept a callback
        // attributable to this region's sign-in page, not an arbitrary navigation.
        const from =
          req.headers.origin ||
          (req.headers.referer && new URL(req.headers.referer).origin);
        if (from !== p.web && q.get('login_trace_id') !== trace)
          throw new Error('无法核对回调来源');
        if (jwt.Token || jwt.token)
          session = sessionFrom(
            p,
            jwt,
            { ...info, Host: q.get('host') || info.Host },
            base,
          );
        else
          session = await refreshTrae(
            p,
            { ...base, refreshToken: q.get('refreshToken') },
            signal,
          );
      }
      return { session, label: info.ScreenName || info.screenName };
    },
  });
  const params = new URLSearchParams({
    login_version: '1',
    auth_from: 'trae',
    login_channel: 'native_ide',
    plugin_version: p.plugin,
    auth_type: 'local',
    client_id: clientId,
    redirect: '0',
    login_trace_id: trace,
    machine_id: device.machineId,
    device_id: device.deviceId,
    x_machine_id: device.machineId,
    x_device_id: device.deviceId,
    x_device_type: process.platform,
    x_os_version: release(),
    x_app_version: p.version,
    x_app_type: 'stable',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    hide_saas_login: 'true',
  });
  return {
    authUrl: `${p.web}/authorization?${params}&auth_callback_url=${loop.callback}`,
    poll: loop.poll,
  };
}
const cache = new Map();
async function catalog(host, headers, signal) {
  const res = await post(
    host + '/api/ide/v1/batch_get_detail_param',
    {
      functions,
      agent_type: '',
      current_config_info: { config_name: '', is_custom_model: false },
      mode_type: 0,
      access_type: 0,
      show_custom_model: false,
    },
    headers,
    signal,
  );
  if (!res.ok) return res;
  const json = await res.json(),
    groups = json.function_configs || json.data?.function_configs;
  const rows = new Map();
  for (const group of groups ?? []) {
    if (!functions.includes(group.function)) continue;
    for (const m of group.config_info_list || []) {
      const id = m.config_name;
      if (
        typeof id !== 'string' ||
        !id ||
        rows.has(id) ||
        m.hidden ||
        m.disabled ||
        m.is_custom_model ||
        m.config_switch === false ||
        m.is_invisible_to_user ||
        (m.usage && m.usage !== 'chat_completion')
      )
        continue;
      const detail =
        m.model_detail_list?.find((d) => d.model_name?.endsWith('__dev')) ??
        m.model_detail_list?.[0];
      rows.set(id, {
        id,
        function: group.function,
        model_name: detail?.model_name || m.model_name,
      });
    }
  }
  if (!rows.size) throw new Error('Trae 未返回可用的对话模型');
  return rows;
}
export async function traeRequest(p, s, models, req) {
  const host = s.api === p.us && p.us ? p.us : p.api;
  const headers = {
    Authorization: `Cloud-IDE-JWT ${s.token}`,
    'x-cloudide-token': s.token,
    'x-ide-token': s.token,
    'x-uid': s.uid,
    'x-device-id': s.deviceId,
    'x-machine-id': s.machineId,
    'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'x-request-id': randomUUID(),
    'x-ide-version': p.version,
  };
  const key = host + '|' + s.sessionId;
  let item = cache.get(key);
  if (models || !item || item.until < Date.now()) {
    const rows = await catalog(host, headers, req.signal);
    if (rows instanceof Response) return rows;
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    item = { rows, until: Date.now() + 300000 };
    cache.set(key, item);
  }
  if (models)
    return Response.json({ data: [...item.rows.keys()].map((id) => ({ id })) });
  const body = await req.json(),
    route = item.rows.get(body.model);
  if (!route) return Response.json({ error: '模型不可用' }, { status: 404 });
  const messages = (body.messages || []).map((m) => ({
    ...m,
    role: m.role === 'developer' ? 'system' : m.role,
    ...(typeof m.content === 'string' && {
      content: [{ type: 'text', text: m.content }],
    }),
    ...(Array.isArray(m.tool_calls) && {
      tool_calls: m.tool_calls.map(({ function: fn, ...call }) => ({
        ...call,
        function_call: fn,
      })),
    }),
  }));
  const payload = {
    ...Object.fromEntries(['tools', 'tool_choice', 'parallel_tool_calls', 'max_tokens', 'stop', 'reasoning_effort', 'temperature', 'top_p']
      .filter(k => body[k] !== undefined).map(k => [k, body[k]])),
    model: route.id,
    messages,
    stream: true,
    config_name: route.id,
    function: route.function,
    model_name: route.model_name,
    request_id: randomUUID(),
    session_id: s.sessionId,
  };
  const res = await post(
    host + '/api/agent/v3/llm_utils_chat',
    payload,
    headers,
    req.signal,
  );
  return res.ok ? traeCompletion(res, body.model, body.stream === true) : res;
}
