import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { bundle } from '../src/bundle.js';
import { api } from '../src/api.js';
import { ContextPolicy } from '../src/context.js';
import {
  MANDATORY_SEAMS,
  resolveSeams,
  createDefaultSeams,
} from '../src/seams.js';

test('resolveSeams and bundle fail closed when any mandatory seam is missing or times out', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());

  // Missing a required seam -> E_SEAM_MISSING.
  const defaults = createDefaultSeams(store);
  const { sandbox: _omitted, ...incomplete } = defaults;
  await assert.rejects(
    () => resolveSeams(incomplete),
    (e) => e.code === 'E_SEAM_MISSING' && e.detail.seam === 'sandbox',
  );
  await assert.rejects(
    () => bundle(store, '', { seams: incomplete }),
    (e) => e.code === 'E_SEAM_MISSING',
  );

  // Hung async factory -> E_SEAM_INIT.
  await assert.rejects(
    () =>
      resolveSeams(
        {
          ...defaults,
          verifier: {
            id: 'slow',
            version: '1.0.0',
            create: () => new Promise(() => {}),
          },
        },
        { timeoutMs: 40 },
      ),
    (e) => e.code === 'E_SEAM_INIT' && e.detail.seam === 'verifier',
  );

  // Complete default seams succeed and produce a deterministic frozen digest.
  const ctx = await bundle(store);
  t.after(() => ctx.fiber.dispose());
  for (const name of MANDATORY_SEAMS) assert.ok(ctx.seams[name]);
  assert.match(ctx.seams.digest, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(ctx.seams));
});

test('task-level skill pinning isolates in-flight tasks from live SKILL.md edits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pin-skills-'));
  const skillDir = join(root, 'skills', 'guide');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), 'roles: Coder\nRule V1: use strict mode.');

  const store = new Store(':memory:');
  const token = 'p'.repeat(32);
  const policy = new ContextPolicy(join(root, 'skills'), store);
  const app = api(store, token, { models: [], list: () => [] }, {
    snapshotPin: async (body) => ({
      seamDigest: 'test-digest',
      approvalMode: body.approvalMode ?? 'manual',
      skillsByRole: { Coder: await policy.skills('Coder') },
      pinnedAt: Date.now(),
    }),
  });
  t.after(async () => {
    await app.close();
    store.close();
  });

  const post = (url, payload) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/' + url,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  const p = (await post('projects', { name: 'pin' })).json();
  const task1 = (
    await post('tasks', { projectId: p.id, input: 't1', idempotencyKey: 'k1' })
  ).json();

  // Live-edit SKILL.md on disk after task1 was created!
  await writeFile(join(skillDir, 'SKILL.md'), 'roles: Coder\nRule V2: updated workflow.');
  const task2 = (
    await post('tasks', { projectId: p.id, input: 't2', idempotencyKey: 'k2' })
  ).json();

  const prep1 = await policy.prepare({
    guard: () => {},
    task: store.get('tasks', task1.id),
    session: { id: 's1' },
    worker: { role: 'Coder' },
    persona: 'Work as Coder.',
    input: JSON.stringify({ request: 't1', handoffs: [] }),
  });
  const prep2 = await policy.prepare({
    guard: () => {},
    task: store.get('tasks', task2.id),
    session: { id: 's2' },
    worker: { role: 'Coder' },
    persona: 'Work as Coder.',
    input: JSON.stringify({ request: 't2', handoffs: [] }),
  });

  // In-flight task1 stays pinned to Rule V1; new task2 gets Rule V2!
  assert.match(prep1.persona, /Rule V1/);
  assert.doesNotMatch(prep1.persona, /Rule V2/);
  assert.match(prep2.persona, /Rule V2/);
  assert.doesNotMatch(prep2.persona, /Rule V1/);
});
