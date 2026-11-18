import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { Plan, select } from '../src/router.js';
import { model, Script } from './fixtures.js';
export const plan = {
  type: 'engineering',
  complexity: 'medium',
  risk: 'low',
  nodes: ['a', 'b', 'c'].map((key, i) => ({
    key,
    role: 'Coder',
    objective: key,
    acceptance: 'deliver result',
    dependencies: i === 2 ? ['a', 'b'] : [],
  })),
};
test('DSH executes a fork/join plan with distinct workers and audited acceptance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dag-'));
  const store = new Store(join(root, 'db'));
  const project = store.add('projects', { name: 'test' });
  const task = store.submit({
    projectId: project.id,
    input: 'test',
    idempotencyKey: '1',
  });
  let running = 0,
    peak = 0,
    joined = false;
  const adapter = new Script(async (o) => {
    const payload = JSON.parse(o.messages.at(-1).content[0].text);
    if (payload.criteria)
      return JSON.stringify({ accepted: true, reason: 'OK' });
    if (!payload.assignment) return JSON.stringify(plan);
    peak = Math.max(peak, ++running);
    await delay(80);
    running--;
    if (payload.assignment.objective === 'c')
      joined = payload.handoffs.length === 2;
    return 'result';
  });
  const engine = new Engine({ store, root, models: [model], adapter });
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  engine.start();
  for (
    let i = 0;
    i < 120 &&
    !['completed', 'failed'].includes(store.get('tasks', task.id).status);
    i++
  )
    await delay(50);
  assert.equal(store.get('tasks', task.id).status, 'completed');
  assert.equal(peak, 2);
  assert.ok(joined);
  assert.equal(store.list('workers').length, 5);
});
test('plan rejects cycles and registry enforces tools/context', () => {
  assert.throws(() => Plan.parse({ ...plan, nodes: [plan.nodes[2]] }));
  assert.throws(() =>
    select([{ ...model, tools: false }], 'Coder', 'simple', 100),
  );
});

// Reject one delivery and confirm that a fresh worker sees the feedback.
test('review rejection triggers bounded rework and preserves the original publication', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rework-'));
  const store = new Store(join(root, 'db'));
  const p = store.add('projects', { name: 'revision' });
  const task = store.submit({
    projectId: p.id,
    input: 'edit',
    idempotencyKey: 'edit',
  });
  let reviews = 0,
    feedback = false,
    attempt = 0;
  const adapter = new Script(async (o) => {
    const data = JSON.parse(o.messages.at(-1).content[0].text);
    if (data.criteria)
      return JSON.stringify({
        accepted: ++reviews > 1,
        reason: reviews === 1 ? 'Clarify the answer' : 'accepted',
      });
    if (!data.assignment)
      return JSON.stringify({ ...plan, nodes: [plan.nodes[0]] });
    if (data.feedback) feedback = data.feedback === 'Clarify the answer';
    if (++attempt === 1) throw Error('temporary');
    return 'answer ' + attempt;
  });
  const engine = new Engine({ store, root, models: [model], adapter });
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  engine.start();
  for (
    let i = 0;
    i < 160 &&
    !['failed', 'completed'].includes(store.get('tasks', task.id).status);
    i++
  )
    await delay(50);
  assert.equal(store.get('tasks', task.id).status, 'completed');
  assert.ok(feedback);
  assert.equal(reviews, 2);
  assert.equal(store.list('artifacts').filter((a) => a.published).length, 1);
  assert.equal(store.list('artifacts').length, 2);
});
