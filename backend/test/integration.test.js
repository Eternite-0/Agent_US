import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { service } from '../src/service.js';
import { Config } from '../src/providers.js';
import { model } from './fixtures.js';
const plan = {
  type: 'coding',
  complexity: 'simple',
  risk: 'low',
  nodes: [
    {
      key: 'build',
      role: 'Coder',
      objective: 'Create proof.txt',
      acceptance: 'File contains verified',
      dependencies: [],
      requiredFiles: ['proof.txt'],
    },
  ],
};
test(
  'public API → real Magpie → DSH tool → approval → Codex sandbox → review → durable replay',
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'agent-public-'));
    const skills = join(root, 'skills', 'delivery');
    await mkdir(skills, { recursive: true });
    await writeFile(
      join(skills, 'SKILL.md'),
      'roles: Coder\nRead the acceptance criterion before delivery.',
    );
    let sawSkill = false,
      sawTools = false,
      sawEvidence = false;
    const http = createServer(async (req, res) => {
      const buf = [];
      for await (const chunk of req) buf.push(chunk);
      if (req.url.endsWith('/models')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(
          JSON.stringify({ data: [{ id: 'test', object: 'model' }] }),
        );
      }
      const body = JSON.parse(Buffer.concat(buf));
      const system = body.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n');
      const reviewer = system.includes('Evaluate the original');
      const planner = system.includes('You dispatch');
      let deltas;
      if (reviewer) {
        sawEvidence =
          JSON.stringify(body.messages).includes('proof.txt') &&
          JSON.stringify(body.messages).includes('exitCode');
        deltas = [
          {
            content: JSON.stringify({
              accepted: sawEvidence,
              reason: 'File and tool exit verified',
            }),
          },
        ];
      } else if (planner) deltas = [{ content: JSON.stringify(plan) }];
      else if (body.messages.some((m) => m.role === 'tool'))
        deltas = [{ content: 'Delivered proof.txt.' }];
      else {
        sawTools = body.tools?.some((t) => t.function.name === 'write_file');
        sawSkill = system.includes('Read the acceptance criterion');
        deltas = [
          {
            tool_calls: [
              {
                index: 0,
                id: 'call_file',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: '{"path":"proof.txt",',
                },
              },
            ],
          },
          {
            tool_calls: [
              { index: 0, function: { arguments: '"text":"verified"}' } },
            ],
          },
        ];
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (choices, usage) =>
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'chatcmpl-123',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'test',
              choices,
              usage,
            }) +
            '\n\n',
        );
      for (const delta of deltas)
        send([{ index: 0, delta, finish_reason: null }]);
      send([
        {
          index: 0,
          delta: {},
          finish_reason: deltas[0].tool_calls ? 'tool_calls' : 'stop',
        },
      ]);
      send([], { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
      res.end('data: [DONE]\n\n');
    });
    http.listen(0, '0.0.0.0');
    await once(http, 'listening');
    t.after(() => http.close());
    const port = http.address().port;
    const configuration = Config.parse({
      providers: [
        {
          id: 'fixture',
          endpoint: `http://127.0.0.1:${port}/v1`,
          sidecarEndpoint: `http://host.docker.internal:${port}/v1`,
          keyRef: 'FIXTURE_TEST_KEY',
        },
      ],
      models: [model],
      magpie: true,
    });
    const token = 'xyz'.repeat(16);
    process.env.FIXTURE_TEST_KEY = 'only-test';
    const runtime = await service({ root, token, configuration });
    t.after(async () => {
      await runtime.close();
      delete process.env.FIXTURE_TEST_KEY;
    });
    assert.ok(runtime.providers.ready);
    const base = await runtime.app.listen({ host: '127.0.0.1', port: 0 });
    const headers = {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    };
    const request = async (path, body) => {
      const r = await fetch(base + '/api/v1/' + path, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(r.status, 200);
      return r.json();
    };
    const p = await request('projects', { name: 'public' });
    const task = await request('tasks', {
      projectId: p.id,
      input: 'Create proof.txt containing verified.',
      idempotencyKey: 'public-1',
    });
    let status;
    for (let i = 0; i < 300; i++) {
      const [a] = await request('approvals?taskId=' + task.id);
      if (a?.status === 'pending')
        await request('approvals/' + a.id + '/decision', {
          version: a.version,
          decision: 'approve',
        });
      status = (await request('tasks/' + task.id)).status;
      if (['completed', 'failed'].includes(status)) break;
      await delay(100);
    }
    assert.equal(
      status,
      'completed',
      JSON.stringify(runtime.store.list('sessions')),
    );
    assert.ok(sawSkill);
    assert.ok(sawTools);
    assert.ok(sawEvidence);
    assert.equal(
      runtime.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE type='provider.failed'",
        )
        .get().n,
      0,
    );
    const [artifact] = await request('artifacts?taskId=' + task.id);
    assert.equal(
      Buffer.from(artifact.files['proof.txt'], 'base64').toString(),
      'verified',
    );
    assert.ok((await request('usage')).length);
    assert.equal((await request('memory')).length, 1);
    const events = await request('events?taskId=' + task.id);
    const ac = new AbortController();
    const res = await fetch(base + '/api/v1/events?taskId=' + task.id, {
      headers: {
        Authorization: headers.Authorization,
        Accept: 'text/event-stream',
        'Last-Event-ID': String(events[0].seq),
      },
      signal: ac.signal,
    });
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('data:'))
      text += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    assert.ok(text.includes(`id: ${events[1].seq}\n`));
    const reopened = await service({
      root,
      token,
      configuration: Config.parse({ providers: [], models: [] }),
    });
    try {
      assert.equal(reopened.store.get('tasks', task.id).status, 'completed');
      assert.deepEqual(
        reopened.store.get('artifacts', artifact.id).files,
        artifact.files,
      );
    } finally {
      await reopened.close();
    }
  },
);
