import { randomUUID } from 'node:crypto';
const allowedSites = [
  'tencent.com',
  'qq.com',
  'workbuddy.cn',
  'codebuddy.cn',
  'workbuddy.ai',
  'codebuddy.ai',
];
function authHeaders(s) {
  return {
    Authorization: `Bearer ${s.accessToken}`,
    ...(s.domain && { 'X-Domain': s.domain }),
    ...(s.uid && { 'X-User-Id': s.uid }),
    ...(s.enterpriseId && {
      'X-Enterprise-Id': s.enterpriseId,
      'X-Tenant-Id': s.enterpriseId,
    }),
  };
}
async function api(p, path, { method = 'GET', headers = {}, signal } = {}) {
  const res = await fetch(p.origin + path, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(method === 'POST' && { body: '{}' }),
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  const env = await res.json().catch(() => null);
  if (!res.ok || !env)
    throw Object.assign(new Error(`WorkBuddy HTTP ${res.status}`), {
      status: res.status,
      vendorCode: Number(env?.code),
    });
  if (Number(env.code ?? 0) !== 0)
    throw Object.assign(new Error('WorkBuddy 未授权本次请求'), {
      vendorCode: Number(env.code),
    });
  return env.data;
}
function token(got, previous = {}) {
  if (!got?.accessToken || typeof got.accessToken !== 'string')
    throw new Error('WorkBuddy 未返回访问令牌');
  return {
    ...previous,
    accessToken: got.accessToken,
    refreshToken: got.refreshToken || previous.refreshToken,
    domain: got.domain || previous.domain,
    expiresAt:
      Number(got.expiresAt) ||
      (Number(got.expiresIn) > 0
        ? Date.now() + 1000 * Number(got.expiresIn)
        : 0),
  };
}
export async function startWorkBuddy(p, signal) {
  const initial = await api(p, '/v2/plugin/auth/state?platform=' + p.platform, {
    method: 'POST',
    signal,
    headers: {
      'X-No-Authorization': 'true',
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
      'X-No-Department-Info': 'true',
    },
  });
  const u = new URL(initial.authUrl);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    !allowedSites.some(
      (h) => u.hostname === h || u.hostname.endsWith('.' + h),
    ) ||
    !initial.state
  )
    throw new Error('WorkBuddy 授权地址无效');
  u.searchParams.set('version', '5.9.3');
  u.searchParams.set('loginSessionId', randomUUID());
  const suffix = '?state=' + encodeURIComponent(initial.state);
  let s,
    nextPoll = 0;
  return {
    authUrl: u.href,
    async poll() {
      if (Date.now() < nextPoll) return null;
      nextPoll = Date.now() + 2000;
      try {
        s ??= token(await api(p, '/v2/plugin/auth/token' + suffix, { signal }));
        const who = await api(p, '/v2/plugin/login/account' + suffix, {
          headers: {
            ...authHeaders(s),
            'X-Domain': s.domain || new URL(p.origin).host,
            'X-No-User-Id': 'true',
            'X-No-Enterprise-Id': 'true',
          },
          signal,
        });
        let team = who.enterpriseId || '',
          teamName = who.enterpriseName;
        if (
          !team &&
          who.type &&
          String(who.type).toLowerCase() !== 'personal'
        ) {
          const list = await api(p, '/v2/plugin/accounts', {
            headers: {
              ...authHeaders(s),
              'X-Domain': s.domain || new URL(p.origin).host,
            },
            signal,
          });
          const matches = (list?.accounts || []).filter(
            (a) => a.uid === who.uid && a.type === who.type && a.enterpriseId,
          );
          const selected =
            matches.length === 1
              ? matches[0]
              : matches.find((a) => a.lastLogin);
          if (!selected) throw new Error('无法确定所授权的 WorkBuddy 团队');
          team = selected.enterpriseId;
          teamName = selected.enterpriseName;
        }
        return {
          session: { ...s, uid: who.uid, enterpriseId: team },
          label: [who.nickname || who.name, teamName]
            .filter(Boolean)
            .join(' · '),
        };
      } catch (err) {
        if ([11217, 12151].includes(err.vendorCode)) return null;
        throw err;
      }
    },
  };
}
export async function refreshWorkBuddy(p, s) {
  if (!s.refreshToken) throw new Error('WorkBuddy 授权已过期，请重新登录');
  return token(
    await api(p, '/v2/plugin/auth/token/refresh', {
      method: 'POST',
      headers: {
        'X-Refresh-Token': s.refreshToken,
        'X-Auth-Refresh-Source': 'plugin',
        'X-Domain': s.domain || new URL(p.origin).host,
        ...(s.enterpriseId && {
          'X-Enterprise-Id': s.enterpriseId,
          'X-Tenant-Id': s.enterpriseId,
        }),
      },
    }),
    s,
  );
}
export async function workBuddyRequest(p, s, models, req) {
  const headers = {
    ...authHeaders(s),
    'X-Domain': s.domain || new URL(p.origin).host,
    'X-Product': 'SaaS',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Agent-Type': 'main',
  };
  if (models) {
    const cfg = await api(p, '/v3/config', { headers, signal: req.signal });
    const cli = cfg.agents?.find((a) => a.name === 'cli')?.models;
    const models = Array.isArray(cfg.models) ? cfg.models : [];
    const ids = Array.isArray(cli)
      ? [
          ...cli,
          ...models.map((m) => m.id).filter((id) => id?.startsWith('custom:')),
        ]
      : models
          .filter(
            (m) => m.enabled !== false && (!m.tags || m.tags.includes('chat')),
          )
          .map((m) => m.id);
    const rows = [...new Set(ids)]
      .filter((id) => typeof id === 'string')
      .map((id) => models.find((m) => m.id === id) || { id });
    if (!rows.length) throw new Error('WorkBuddy 未返回当前账号可用的对话模型');
    return Response.json({
      data: rows.map((m) => ({
        id: m.id,
        max_input_tokens: m.maxInputTokens,
        max_output_tokens: m.maxOutputTokens,
      })),
    });
  }
  return fetch(p.endpoint + '/chat/completions', {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'X-Private-Data': 'true',
      'User-Agent': 'Agent_US',
    },
    body: await req.text(),
    signal: req.signal,
    redirect: 'error',
  });
}
