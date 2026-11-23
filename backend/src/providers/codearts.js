import {
  createHash,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto';
import { pkce, listenForGrant } from './loopback.js';

const portal = 'https://codearts.huaweicloud.com';
const sts = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';
const client = 'codearts-agent';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

async function exchange(s, grant, signal = AbortSignal.timeout(15000)) {
  const { kty, crv, x, y } = s.jwk;
  const proof =
    encode({ alg: 'ES256', typ: 'dpop+jwt', jwk: { kty, crv, x, y } }) +
    '.' +
    encode({
      htm: 'POST',
      htu: sts,
      iat: Math.floor(Date.now() / 1000),
      jti: randomUUID(),
    });
  const signature = sign('sha256', Buffer.from(proof), {
    key: createPrivateKey({ format: 'jwk', key: s.jwk }),
    dsaEncoding: 'ieee-p1363',
  });
  const res = await fetch(sts, {
    method: 'POST',
    headers: { DPoP: proof + '.' + signature.toString('base64url') },
    body: new URLSearchParams({
      client_id: client,
      code_verifier: s.verifier,
      ...grant,
    }),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!res.ok) throw new Error(`CodeArts 授权 HTTP ${res.status}`);
  const t = await res.json(),
    c = t.credentials;
  if (
    !c?.access_key_id ||
    !c.secret_access_key ||
    !c.security_token ||
    !Date.parse(c.expiration)
  )
    throw new Error('华为云临时凭证无效');
  return {
    ...s,
    ak: c.access_key_id,
    sk: c.secret_access_key,
    security: c.security_token,
    expiresAt: Date.parse(c.expiration),
    refreshToken: t.refresh_token || s.refreshToken,
  };
}
export async function startCodeArts(p, signal) {
  const { verifier, challenge } = pkce(),
    ticket = randomUUID();
  const jwk = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  }).privateKey.export({ format: 'jwk' });
  const loop = await listenForGrant({
    path: '/oauth/callback',
    origin: portal,
    signal,
    intermediate(q, res) {
      if (!q.has('secret') || q.has('code')) return false;
      let u;
      try {
        u = new URL(q.get('redirect'));
      } catch {}
      if (
        u &&
        [
          'https://codearts.huaweicloud.com',
          'https://auth.huaweicloud.com',
          'https://console.huaweicloud.com',
        ].includes(u.origin) &&
        !u.username &&
        !u.password
      )
        res.writeHead(307, { Location: u.href }).end();
      else res.writeHead(400).end();
      return true;
    },
    async receive(q, callback) {
      if (
        !q.get('code') ||
        (q.has('ticket_id') && q.get('ticket_id') !== ticket)
      )
        throw new Error('无效授权码');
      return {
        session: await exchange(
          { verifier, jwk, sessionId: randomUUID() },
          {
            grant_type: 'authorization_code',
            code: q.get('code'),
            redirect_uri: callback,
          },
          signal,
        ),
      };
    },
  });
  const query = new URLSearchParams({
    theme: '2',
    locale: 'zh-cn',
    uri_scheme: client,
    client_id: client,
    port: new URL(loop.callback).port,
    code_challenge: challenge,
    code_challenge_method: 'SHA-256',
    ticket_id: ticket,
    'plugin-name': 'snap_AIIDE',
    'plugin-version': '5.2.0',
  });
  return { authUrl: `${portal}/portal/authorize?${query}`, poll: loop.poll };
}
export function refreshCodeArts(p, s) {
  if (!s.refreshToken) throw new Error('请重新登录 CodeArts');
  return exchange(s, {
    grant_type: 'refresh_token',
    refresh_token: s.refreshToken,
  });
}
export async function codeArtsRequest(p, s, models, req) {
  const url = new URL(
    models ? '/v1/model/builtin' : '/api/v2/chat/completions',
    p.endpoint,
  );
  const body = models ? '' : await req.text();
  const date = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const h = {
    host: url.host,
    'x-sdk-date': date,
    'x-sdk-content-sha256': hash(body),
    'x-security-token': s.security,
    'content-type': 'application/json',
  };
  const names = Object.keys(h).sort(),
    list = names.join(';');
  const canonical = [
    req.method,
    url.pathname + '/',
    '',
    ...names.map((k) => `${k}:${h[k]}`),
    '',
    list,
    hash(body),
  ].join('\n');
  const signature = createHmac('sha256', s.sk)
    .update(`SDK-HMAC-SHA256\n${date}\n${hash(canonical)}`)
    .digest('hex');
  const res = await fetch(url, {
    method: req.method,
    headers: {
      ...h,
      Authorization: `SDK-HMAC-SHA256 Access=${s.ak},SignedHeaders=${list},Signature=${signature}`,
      'Agent-Type': 'PromptCenter',
      'X-Language': 'zh-cn',
      'Chat-Id': s.sessionId,
      'Session-Id': s.sessionId,
      'x-ot-session-id': s.sessionId,
      'user-session-id': s.sessionId,
    },
    ...(models ? {} : { body }),
    redirect: 'error',
    signal: req.signal,
  });
  if (!models || !res.ok) return res;
  const catalog = await res.json();
  if (!Array.isArray(catalog.builtinModels))
    throw new Error('CodeArts 模型目录格式无效');
  return Response.json({
    data: catalog.builtinModels
      .filter((m) => typeof m.model_id === 'string')
      .map((m) => ({
        id: m.model_id,
        name: m.model_name,
        context_window: m.context_window,
        max_output_tokens: m.max_tokens,
      })),
  });
}
