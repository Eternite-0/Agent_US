import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { model, rmDirSafe } from './fixtures.js';

test(
  'CLI process killed during planning recovers the same task from disk',
  { timeout: 55000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'agent-restart-'));
    const file = join(root, 'config.json');
    const token = 'integration'.repeat(4);
    let hang = true,
      ready;
    const firstRequest = new Promise((resolve) => {
      ready = resolve;
    });
    const server = createServer(async (req, res) => {
      const buf = [];
      for await (const chunk of req) buf.push(chunk);
      if (req.url.endsWith('/models'))
        return res.end(JSON.stringify({ data: [{ id: 'test' }] }));
      if (hang) {
        ready();
        return;
      }
      const payload = JSON.parse(Buffer.concat(buf));
      const prompt = payload.messages[0].content;
      const plan = {
        type: 'text',
        risk: 'low',
        complexity: 'simple',
        nodes: [
          {
            key: 'answer',
            role: 'Researcher',
            objective: 'answer',
            acceptance: 'answer delivered',
            dependencies: [],
          },
        ],
      };
      const response = prompt.includes('You dispatch')
        ? JSON.stringify(plan)
        : prompt.includes('Evaluate the original')
          ? JSON.stringify({ accepted: true, reason: 'verified' })
          : 'ready';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [
              { index: 0, delta: { content: response }, finish_reason: 'stop' },
            ],
          }) +
          '\n\n',
      );
      res.end('data: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const spawned = [];
    const terminateChild = async ({ child, exit, lines }) => {
      try {
        lines?.close();
      } catch {}
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {}
        let timer;
        await Promise.race([
          exit.catch(() => {}),
          new Promise((r) => {
            timer = setTimeout(r, 3000);
            timer.unref?.();
          }),
        ]).finally(() => {
          clearTimeout(timer);
        });
      }
    };
    t.after(async () => {
      for (const proc of spawned) {
        await terminateChild(proc);
      }
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      rmDirSafe(root);
    });
    await writeFile(
      file,
      JSON.stringify({
        providers: [
          {
            id: 'fixture',
            endpoint: `http://127.0.0.1:${server.address().port}/v1`,
            keyRef: 'CRASH_TEST_KEY',
          },
        ],
        models: [model],
      }),
    );
    async function launch() {
      const child = spawn(process.execPath, ['src/main.js'], {
        env: {
          ...process.env,
          PORT: '0',
          BACKEND_DATA: root,
          BACKEND_CONFIG: file,
          BACKEND_TOKEN: token,
          CRASH_TEST_KEY: 'fixture',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exit = once(child, 'exit');
      const lines = createInterface({ input: child.stdout });
      const proc = { child, exit, lines };
      spawned.push(proc);
      const [base] = await Promise.race([
        once(lines, 'line'),
        exit.then(() => {
          throw Error('server failed startup');
        }),
      ]);
      return { base, child, exit, lines };
    }
    const api = async (base, path, body) => {
      const res = await fetch(base + '/api/v1/' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: 'Bearer ' + token,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    try {
      const a = await launch();
      const p = await api(a.base, 'projects', { name: 'restart' });
      const task = await api(a.base, 'tasks', {
        projectId: p.id,
        input: 'answer',
        idempotencyKey: 'recover',
      });
      await firstRequest;
      a.child.kill('SIGKILL');
      await a.exit;
      hang = false;
      const b = await launch();
      let status;
      for (let i = 0; i < 160; i++) {
        status = (await api(b.base, 'tasks/' + task.id)).status;
        if (['failed', 'completed'].includes(status)) break;
        await delay(200);
      }
      assert.equal(status, 'completed');
      const workers = await api(b.base, 'workers?taskId=' + task.id);
      assert.ok(workers.some((w) => w.status === 'interrupted'));
      assert.ok(workers.some((w) => w.attempt === 2 && w.role === 'Planner'));
      assert.equal((await api(b.base, 'artifacts?taskId=' + task.id)).length, 1);
    } finally {
      for (const proc of spawned) {
        await terminateChild(proc);
      }
    }
  },
);
