import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { WebLoginService } from '../src/web-login.js';
const localFetch = globalThis.fetch;
const ok = (data) => Response.json({ code: 0, data });
const sha = (s, encoding = 'hex') =>
  createHash('sha256').update(s).digest(encoding);
const mockSecret = 'fake-only-access-secret';
const sse = (data) =>
  new Response(data, { headers: { 'content-type': 'text/event-stream' } });
const chat = () =>
  Response.json({
    choices: [
      {
        message: { role: 'assistant', content: 'pong' },
        finish_reason: 'stop',
      },
    ],
  });
function setup(t, handle) {
  const root = mkdtempSync(join(tmpdir(), 'native-login-test-'));
  const store = new Store(join(root, 'pool.sqlite')),
    pool = new AccountPool(store, { root });
  const login = new WebLoginService(store, pool, { root });
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const r = new Request(input, init);
    const u = new URL(r.url);
    assert.equal(u.protocol, 'https:');
    assert.equal(r.redirect, 'error');
    const reply = await handle(u, r);
    assert.ok(reply, 'Unexpected vendor request: ' + u.origin + u.pathname);
    return reply;
  });
  t.after(() => {
    login.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, pool, login };
}
function storage(store, id) {
  return store.db
    .prepare('SELECT encrypted FROM native_provider_sessions WHERE accountId=?')
    .get(id)?.encrypted;
}

test('WorkBuddy grants are private, refreshed once, shared by both gateway protocols and direct-agent SDK', async (t) => {
  let refresh = 0,
    chats = 0;
  const { login, store, pool } = setup(t, async (u, r) => {
    assert.equal(u.host, 'copilot.tencent.com');
    switch (u.pathname) {
      case '/v2/plugin/auth/state':
        return ok({
          state: 'test-state',
          authUrl: 'https://www.codebuddy.cn/login',
        });
      case '/v2/plugin/auth/token':
        return ok({
          accessToken: mockSecret,
          refreshToken: 'test-only-refresh',
          expiresAt: Date.now() - 10000,
        });
      case '/v2/plugin/login/account':
        return ok({ uid: 'user-1', name: '示例' });
      case '/v2/plugin/auth/token/refresh':
        refresh++;
        assert.equal(r.headers.get('x-refresh-token'), 'test-only-refresh');
        return ok({ accessToken: mockSecret + '2', expiresIn: 3600 });
      case '/v3/config':
        assert.equal(
          r.headers.get('authorization'),
          'Bearer ' + mockSecret + '2',
        );
        return ok({
          agents: [{ name: 'cli', models: ['cn:model'] }],
          models: [],
        });
      case '/v2/chat/completions': {
        assert.equal(
          r.headers.get('authorization'),
          'Bearer ' + mockSecret + '2',
        );
        chats++;
        const body = await r.json();
        assert.equal(body.model, 'cn:model');
        return body.stream
          ? sse(
              'data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n',
            )
          : chat();
      }
    }
  });
  const flow = await login.startWebLogin({
    preset: 'workbuddy',
    autoSync: false,
  });
  assert.equal(flow.engine, 'provider-native');
  const [a, b] = await Promise.all([
    login.getWebLoginStatus(flow.flowId),
    login.getWebLoginStatus(flow.flowId),
  ]);
  assert.equal(a.status, 'done');
  assert.equal(a.account.id, b.account.id);
  assert.equal(a.account.preset, 'workbuddy');
  assert.ok(!JSON.stringify(a).includes(mockSecret));
  assert.ok(!storage(store, a.account.id).includes(mockSecret));
  assert.equal(pool.getAccountRaw(a.account.id).credentialEnc, null);
  // Editing an ordinary endpoint or custom headers cannot redirect a native credential.
  pool.updateAccount(a.account.id, {
    endpoint: 'https://invalid.example/v1',
    headers: { Authorization: 'spoof' },
  });
  await Promise.all([
    pool.syncAccountModels(a.account.id),
    pool.testAccount(a.account.id),
  ]);
  assert.equal(refresh, 1);
  const body = {
    model: 'cn:model',
    messages: [{ role: 'user', content: 'ping' }],
  };
  assert.equal(
    (await (await pool.proxyChatCompletion(body)).response.json()).choices[0]
      .message.content,
    'pong',
  );
  assert.equal(
    (
      await (
        await pool.proxyAnthropicMessages({ ...body, max_tokens: 12 })
      ).response.json()
    ).content[0].text,
    'pong',
  );
  const route = pool.resolveRoutes('cn:model')[0];
  const frames = await Array.fromAsync(
    pool.adapter.streamRoute(route, { ...body, maxTokens: 12 }),
  );
  assert.ok(JSON.stringify(frames).includes('pong'));
  assert.equal(chats, 3);
  await assert.rejects(route.fetch('https://invalid.example/models'), /原生/);
  pool.deleteAccount(a.account.id);
  assert.equal(storage(store, a.account.id), undefined);
  const manual = pool.createAccount({
    preset: 'workbuddy',
    endpoint: 'https://manual.example/v1',
    credential: 'manual',
    models: ['manual'],
  });
  assert.equal(
    pool.resolveRoutes('manual').find((r) => r.accountId === manual.id)
      .endpoint,
    'https://manual.example/v1',
  );
});

test('CodeArts PKCE, ES256 proof, verified exact-body HMAC and one-time loopback', async (t) => {
  let auth;
  const { login, pool, store } = setup(t, async (u, r) => {
    if (u.host === 'sts.cn-north-4.myhuaweicloud.com') {
      const params = new URLSearchParams(await r.text());
      assert.equal(
        sha(params.get('code_verifier'), 'base64url'),
        auth.searchParams.get('code_challenge'),
      );
      const [header, claims, sig] = r.headers.get('DPoP').split('.');
      const jwk = JSON.parse(Buffer.from(header, 'base64url')).jwk;
      assert.ok(!jwk.d);
      assert.ok(
        verify(
          'sha256',
          Buffer.from(header + '.' + claims),
          {
            key: createPublicKey({ key: jwk, format: 'jwk' }),
            dsaEncoding: 'ieee-p1363',
          },
          Buffer.from(sig, 'base64url'),
        ),
      );
      return Response.json({
        credentials: {
          access_key_id: 'FAKEAK',
          secret_access_key: mockSecret,
          security_token: 'FAKE_TMP',
          expiration: new Date(Date.now() + 3600000).toISOString(),
        },
        refresh_token: 'FAKE_REFRESH',
      });
    }
    assert.equal(u.host, 'snap-access.cn-north-4.myhuaweicloud.com');
    const body = await r.text(),
      h = r.headers;
    const [, signed, sig] = h
      .get('authorization')
      .match(/Access=FAKEAK,SignedHeaders=([^,]+),Signature=(.*)$/);
    const canonical = [
      r.method,
      u.pathname + '/',
      '',
      ...signed.split(';').map((k) => `${k}:${h.get(k)}`),
      '',
      signed,
      sha(body),
    ].join('\n');
    assert.equal(
      sig,
      createHmac('sha256', mockSecret)
        .update(`SDK-HMAC-SHA256\n${h.get('x-sdk-date')}\n${sha(canonical)}`)
        .digest('hex'),
    );
    if (u.pathname === '/v1/model/builtin')
      return Response.json({ builtinModels: [{ model_id: 'hw-model' }] });
    if (u.pathname === '/api/v2/chat/completions') return chat();
  });
  const flow = await login.startWebLogin({ preset: 'codearts' });
  auth = new URL(flow.authUrl);
  const cb = `http://127.0.0.1:${auth.searchParams.get('port')}/oauth/callback`;
  assert.equal((await login.getWebLoginStatus(flow.flowId)).status, 'pending');
  assert.equal(
    (
      await localFetch(cb + '?secret=x&redirect=https://untrusted.example', {
        redirect: 'manual',
      })
    ).status,
    400,
  );
  assert.equal((await localFetch(cb + '?code=test-only')).status, 200);
  const done = await login.getWebLoginStatus(flow.flowId);
  assert.equal(done.syncedModelsCount, 1);
  assert.ok(!storage(store, done.account.id).includes(mockSecret));
  await assert.rejects(localFetch(cb + '?code=test-only'));
  assert.equal(
    (
      await (
        await pool.proxyChatCompletion({ model: 'hw-model', messages: [] })
      ).response.json()
    ).choices[0].message.content,
    'pong',
  );
});
for (const [preset, web, modelHost] of [
  ['trae-cn', 'www.trae.cn', 'trae-api-cn.mchost.guru'],
  ['trae-global', 'www.trae.ai', 'coreva-normal.trae.ai'],
]) {
  test(`${preset} uses its own authorization, model catalog, JSON and SSE`, async (t) => {
    const { login, pool } = setup(t, async (u, r) => {
      assert.equal(u.host, modelHost);
      assert.equal(
        r.headers.get('authorization'),
        'Cloud-IDE-JWT ' + mockSecret,
      );
      if (u.pathname.endsWith('batch_get_detail_param'))
        return Response.json({
          function_configs: [
            {
              function: 'solo_agent',
              config_info_list: [{ config_name: 'test-model' }],
            },
          ],
        });
      if (u.pathname.endsWith('llm_utils_chat')) {
        const body = await r.json();
        assert.equal(body.function, 'solo_agent');
        return sse(
          'event: output\r\ndata: {"response":"pong"}\r\n\r\nevent: done\ndata: {}\n\n',
        );
      }
    });
    const flow = await login.startWebLogin({ preset }),
      u = new URL(flow.authUrl);
    assert.equal(u.host, web);
    const cb = new URL(u.searchParams.get('auth_callback_url'));
    cb.searchParams.set('userJwt', JSON.stringify({ Token: mockSecret }));
    cb.searchParams.set(
      'userInfo',
      JSON.stringify({ UserID: 'sample', Region: 'US' }),
    );
    assert.equal(
      (await localFetch(cb, { headers: { origin: 'https://other.example' } }))
        .status,
      403,
    );
    assert.equal(
      (await localFetch(cb, { headers: { origin: u.origin } })).status,
      200,
    );
    const done = await login.getWebLoginStatus(flow.flowId);
    assert.equal(done.account.preset, preset);
    assert.equal(done.syncedModelsCount, 1);
    for (const stream of [false, true]) {
      const result = await pool.proxyChatCompletion({
        model: 'test-model',
        messages: [],
        stream,
      });
      const text = await result.response.text();
      result.release();
      assert.ok(text.includes('pong'));
      if (stream) assert.ok(text.includes('[DONE]'));
    }
  });
}
test('cancel, denial and expired timers close listeners without storing credentials', async (t) => {
  const { login, pool } = setup(t, () => {
    throw new Error('unexpected vendor request');
  });
  for (const op of ['cancel', 'deny', 'timeout']) {
    const f = await login.startWebLogin({ preset: 'codearts' });
    const url = `http://127.0.0.1:${new URL(f.authUrl).searchParams.get('port')}/oauth/callback?error=denied`;
    if (op === 'cancel') await login.cancelWebLogin(f.flowId);
    else if (op === 'deny') assert.equal((await localFetch(url)).status, 400);
    else {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const expired = await login.startWebLogin({ preset: 'codearts' });
      t.mock.timers.tick(600001);
      assert.equal(
        (await login.getWebLoginStatus(expired.flowId)).status,
        'canceled',
      );
      t.mock.timers.reset();
      await login.cancelWebLogin(f.flowId);
    }
    assert.equal(
      (await login.getWebLoginStatus(f.flowId)).status,
      op === 'deny' ? 'failed' : 'canceled',
    );
    await assert.rejects(localFetch(url));
  }
  assert.equal(pool.listAccounts().length, 0);
});

test('Trae exchanges a nested PKCE code only at the configured region, even if callback names another host', async (t) => {
  let url;
  const { login } = setup(t, async (u, r) => {
    assert.equal(u.href, 'https://api.trae.cn/trae/api/v3/oauth/ExchangeToken');
    const b = await r.json();
    assert.equal(b.AuthCode, 'test-code');
    assert.equal(
      sha(b.CodeVerifier, 'base64url'),
      url.searchParams.get('code_challenge'),
    );
    assert.match(b.DeviceInfo.DevicePublicKey, /BEGIN PUBLIC KEY/);
    return Response.json({
      Result: {
        AccessToken: mockSecret,
        RefreshToken: 'fake-refresh',
        ExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    });
  });
  const flow = await login.startWebLogin({ preset: 'trae', autoSync: false });
  url = new URL(flow.authUrl);
  const cb = new URL(url.searchParams.get('auth_callback_url'));
  cb.searchParams.set(
    'authCodeInfo',
    JSON.stringify({ nested: { authCode: 'test-code' } }),
  );
  cb.searchParams.set('loginHost', 'https://invalid.example');
  assert.equal((await localFetch(cb)).status, 200);
  const done = await login.getWebLoginStatus(flow.flowId);
  assert.equal(done.account.preset, 'trae');
  assert.ok(done.account.expiresAt > Date.now());
  assert.ok(!JSON.stringify(done).includes(mockSecret));
});

test('WorkBuddy international keeps the pending state and selected tenant before saving', async (t) => {
  let tokens = 0,
    identities = 0;
  const { login, pool, store } = setup(t, async (u, r) => {
    assert.equal(u.host, 'www.workbuddy.ai');
    if (u.pathname.endsWith('/state')) {
      assert.equal(u.searchParams.get('platform'), 'workbuddy-ai');
      return ok({ state: 's', authUrl: 'https://www.workbuddy.ai/login' });
    }
    if (u.pathname.endsWith('/token'))
      return ++tokens === 1
        ? Response.json({ code: 11217 })
        : ok({ accessToken: mockSecret });
    if (u.pathname.endsWith('/account'))
      return ++identities === 1
        ? Response.json({ code: 12151 })
        : ok({ uid: 'me', type: 'team' });
    if (u.pathname.endsWith('/accounts'))
      return ok({
        accounts: [{ uid: 'me', type: 'team', enterpriseId: 'test-team' }],
      });
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await login.startWebLogin({
    preset: 'workbuddy-intl',
    autoSync: false,
  });
  for (let i = 0; i < 2; i++) {
    assert.equal((await login.getWebLoginStatus(f.flowId)).status, 'pending');
    assert.equal(pool.listAccounts().length, 0);
    t.mock.timers.tick(2500);
  }
  const done = await login.getWebLoginStatus(f.flowId);
  assert.equal(done.account.preset, 'workbuddy-intl');
  assert.equal(
    JSON.parse(pool.decrypt(storage(store, done.account.id))).enterpriseId,
    'test-team',
  );
  assert.equal(tokens, 2);
});
