import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { WebLoginService, parseCredentialContent } from '../src/web-login.js';
import { api } from '../src/api.js';

function startMockGitHubOAuthServer() {
  let authorized = false;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const send = (code, payload) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'POST' && req.url === '/login/device/code') {
      return send(200, {
        device_code: 'dev-code-abc',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    }
    if (req.method === 'POST' && req.url === '/login/oauth/access_token') {
      if (!authorized) {
        return send(200, { error: 'authorization_pending' });
      }
      return send(200, {
        access_token: 'ghu_mock_copilot_oauth_token_999',
        token_type: 'bearer',
        scope: 'read:user',
      });
    }
    send(404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        authorize: () => {
          authorized = true;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('Self-contained WebLoginService: GitHub Copilot Device Flow, OpenRouter PKCE, Local CLI auto-scan, and credential file import (zero external gateway)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-weblogin-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'agent-us-home-'));
  const mockGh = await startMockGitHubOAuthServer();

  // Seed fake local CLI credential files
  mkdirSync(join(fakeHome, '.codex'), { recursive: true });
  writeFileSync(
    join(fakeHome, '.codex', 'auth.json'),
    JSON.stringify({
      tokens: { access_token: 'eyJhbGciOiJSUzI1NiJ9.codex_local_token_123' },
      email: 'dev@example.com',
    }),
  );
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  writeFileSync(
    join(fakeHome, '.claude', '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-local-claude-123456' },
    }),
  );

  const prevDeviceUrl = process.env.GITHUB_DEVICE_CODE_URL;
  const prevTokenUrl = process.env.GITHUB_ACCESS_TOKEN_URL;
  process.env.GITHUB_DEVICE_CODE_URL = `${mockGh.baseUrl}/login/device/code`;
  process.env.GITHUB_ACCESS_TOKEN_URL = `${mockGh.baseUrl}/login/oauth/access_token`;

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dataDir,
    dataRoot: dataDir,
  });
  const webLogin = new WebLoginService(store, pool, {
    root: dataDir,
    homeDir: fakeHome,
  });
  const token = 'weblogin-test-token-with-24-plus-chars-001';
  const app = api(store, token, { models: [], list: () => [] }, {
    pool,
    directAgent: direct,
    webLogin,
  });
  const headers = { authorization: `Bearer ${token}` };

  try {
    // 1. Verify streamlined zero-dependency preset catalog (no Magpie :3425 default endpoints!)
    const presets = pool.listPresets();
    assert.ok(presets.items.openai);
    assert.ok(presets.items.anthropic);
    assert.ok(presets.items.deepseek);
    assert.ok(presets.items.openrouter);
    assert.ok(presets.items['github-copilot']);
    assert.ok(presets.items['custom-openai']);
    assert.ok(presets.items['custom-anthropic']);
    for (const p of Object.values(presets.items)) {
      assert.ok(
        !String(p.defaultEndpoint || '').includes(':3425'),
        `Preset ${p.id} must not depend on Magpie :3425`,
      );
    }

    // 2. Native GitHub Copilot Device Flow (zero external service)
    const ghStart = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/web-login/start',
        headers,
        payload: { preset: 'github-copilot', autoSync: false },
      })
    ).json();
    assert.equal(ghStart.ok, true);
    assert.equal(ghStart.engine, 'github-device');
    assert.equal(ghStart.userCode, 'ABCD-1234');
    assert.equal(ghStart.verificationUri, 'https://github.com/login/device');

    // Force immediate poll readiness for unit test speed
    webLogin.flows.get(ghStart.flowId).nextPollAt = 0;
    const ghPending = (
      await app.inject({
        method: 'GET',
        url: `/v1/auth/web-login/${ghStart.flowId}/status`,
        headers,
      })
    ).json();
    assert.equal(ghPending.status, 'pending');

    mockGh.authorize();
    webLogin.flows.get(ghStart.flowId).nextPollAt = 0;
    const ghDone = (
      await app.inject({
        method: 'GET',
        url: `/v1/auth/web-login/${ghStart.flowId}/status`,
        headers,
      })
    ).json();
    assert.equal(ghDone.status, 'done');
    assert.equal(ghDone.account.preset, 'github-copilot');
    assert.ok(ghDone.account.credential.includes('****'));

    // 3. OpenRouter PKCE native web-login builds real S256 authorize URL
    const orStart = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/web-login/start',
        headers,
        payload: { preset: 'openrouter' },
      })
    ).json();
    assert.equal(orStart.ok, true);
    assert.equal(orStart.engine, 'openrouter-pkce');
    assert.ok(orStart.authUrl.startsWith('https://openrouter.ai/auth?callback_url='));
    assert.ok(orStart.authUrl.includes('code_challenge_method=S256'));

    // 4. Local CLI credential auto-scan returns masked previews ONLY (never raw tokens!)
    const scanned = (
      await app.inject({
        method: 'GET',
        url: '/v1/auth/local-credentials',
        headers,
      })
    ).json();
    assert.ok(scanned.items.some((i) => i.id === 'openai-codex-local'));
    assert.ok(scanned.items.some((i) => i.id === 'claude-code-local'));
    assert.ok(!JSON.stringify(scanned).includes('codex_local_token_123'));
    assert.ok(!JSON.stringify(scanned).includes('sk-ant-oat01-local-claude-123456'));

    // 5. One-click import of detected local CLI credential encrypts directly into SQLite
    const imported = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/import-local',
        headers,
        payload: { id: 'claude-code-local', autoSync: false },
      })
    ).json();
    assert.equal(imported.ok, true);
    assert.equal(imported.account.preset, 'claude-code');
    assert.equal(imported.extractedKey, 'accessToken');
    assert.ok(imported.account.credential.includes('****'));

    // 6. Universal credential parser (.env)
    const envParsed = parseCredentialContent(
      'DEEPSEEK_API_KEY="sk-deepseek-test-99999"\nBASE_URL=https://api.deepseek.com/v1\n',
      '.env',
    );
    assert.equal(envParsed.token, 'sk-deepseek-test-99999');
    assert.equal(envParsed.endpoint, 'https://api.deepseek.com/v1');
  } finally {
    if (prevDeviceUrl === undefined) delete process.env.GITHUB_DEVICE_CODE_URL;
    else process.env.GITHUB_DEVICE_CODE_URL = prevDeviceUrl;
    if (prevTokenUrl === undefined) delete process.env.GITHUB_ACCESS_TOKEN_URL;
    else process.env.GITHUB_ACCESS_TOKEN_URL = prevTokenUrl;
    await direct.close();
    await app.close();
    store.close();
    await mockGh.close();
    rmDirSafe(dataDir);
    rmDirSafe(fakeHome);
  }
});
