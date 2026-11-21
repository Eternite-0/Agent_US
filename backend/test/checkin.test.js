import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { CheckinService } from '../src/checkin.js';

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('CheckinService Mode A bridges Agent2API protocol and Mode B runs local webhook plugins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-checkin-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  const checkin = new CheckinService(store, pool, { root: dir });

  let checkedIn = false;
  const mockAgent2Api = await startMockServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/api/checkin-center') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          daily: {
            providers: [
              {
                id: 'workbuddy',
                label: 'WorkBuddy 国内版',
                doneCount: checkedIn ? 1 : 0,
                totalCount: 1,
                accounts: [
                  {
                    id: 'wb-1',
                    name: 'acct-1',
                    available: true,
                    checkinAt: checkedIn ? Date.now() : null,
                    checkedInToday: checkedIn,
                    edition: null,
                    streakDays: 3,
                  },
                ],
              },
            ],
            outOfScope: [],
            todayDone: checkedIn ? 1 : 0,
            todayEligible: 1,
          },
          extras: { onboarding: [], plans: [], growth: [] },
          auto: {
            enabled: false,
            lastFiredToday: false,
            running: false,
            providerOptions: [{ id: 'workbuddy', label: 'WorkBuddy 国内版' }],
            schedules: [],
          },
          history: [],
        }),
      );
      return;
    }
    if (req.url === '/api/accounts/checkin' && req.method === 'POST') {
      checkedIn = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ outcome: 'completed', succeeded: 1, total: 1 }));
      return;
    }
    if (req.url?.startsWith('/api/checkin-records')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total: 1, records: [{ ts: Date.now(), provider: 'WorkBuddy 国内版', outcome: 'succeeded' }] }));
      return;
    }
    res.writeHead(404).end();
  });

  const mockWebhook = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, points: 50, msg: '本地插件签到成功' }));
  });

  try {
    // Mode A: Configure Agent2API bridge -> fetch center -> run checkin
    checkin.setBridgeConfig({
      mode: 'bridge',
      baseUrl: mockAgent2Api.baseUrl,
      apiKey: 'a2a-test-key',
    });
    const probe = await checkin.testBridge();
    assert.equal(probe.ok, true);
    assert.equal(probe.providersCount, 1);

    const centerBefore = await checkin.getCenter();
    assert.equal(centerBefore.mode, 'bridge');
    assert.equal(centerBefore.daily.todayDone, 0);

    const runRes = await checkin.runCheckin({});
    assert.equal(runRes.succeeded, 1);
    const centerAfter = await checkin.getCenter();
    assert.equal(centerAfter.daily.todayDone, 1);

    // Mode B: Switch to local standalone + declarative webhook plugin
    checkin.setBridgeConfig({ mode: 'local', baseUrl: '' });
    mkdirSync(join(dir, 'checkin-plugins'), { recursive: true });
    writeFileSync(
      join(dir, 'checkin-plugins', 'custom-openai.json'),
      JSON.stringify({
        providerId: 'custom-openai',
        label: '自定义站点',
        url: `${mockWebhook.baseUrl}/checkin`,
        method: 'POST',
        successPath: 'ok',
        pointsPath: 'points',
        messagePath: 'msg',
      }),
      'utf8',
    );
    pool.createAccount({
      preset: 'custom-openai',
      label: 'My Custom Account',
      endpoint: 'https://api.example.com/v1',
      credential: 'sk-demo-1234',
    });
    const localRun = await checkin.runCheckin({});
    assert.equal(localRun.succeeded, 1);
    const localCenter = await checkin.getCenter();
    assert.equal(localCenter.mode, 'local');
    assert.equal(localCenter.daily.todayDone, 1);
    const recs = await checkin.getRecords({});
    assert.equal(recs.total, 1);
    assert.equal(recs.records[0].points, 50);
  } finally {
    checkin.stop();
    await mockAgent2Api.close();
    await mockWebhook.close();
    store.close();
    rmDirSafe(dir);
  }
});
