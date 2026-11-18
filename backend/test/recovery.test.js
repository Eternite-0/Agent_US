import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { control } from '../src/routes.js';
import { compact, Hooks } from '../src/context.js';
import { model } from './fixtures.js';
test('second connection takes only expired leases and fences the old worker on restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'lease-'));
  const dbPath = join(root, 'state.db');
  const a = new Store(dbPath);
  const p = a.add('projects', { name: 'x' });
  const task = a.submit({ input: 'x', projectId: p.id, idempotencyKey: '1' });
  const e = new Engine({ store: a, root, models: [model] });
  const first = e.claim();
  const worker = a.add(
    'workers',
    { jobId: first.id, status: 'running' },
    p.id,
    task.id,
  );
  const session = a.add(
    'sessions',
    { workerId: worker.id, status: 'running' },
    p.id,
    task.id,
  );
  const b = new Store(dbPath);
  const restarted = new Engine({ store: b, root, models: [model] });
  assert.equal(restarted.claim(), undefined);
  a.db.prepare('UPDATE jobs SET expires=0 WHERE id=?').run(first.id);
  const next = restarted.claim();
  assert.equal(next.attempts, 2);
  assert.notEqual(next.fence, first.fence);
  assert.throws(() => e.guard(first), /LEASE_LOST/);
  assert.equal(b.get('sessions', session.id).status, 'interrupted');
  const paused = control(b, task.id, 'pause', task.version);
  assert.throws(() => restarted.guard(next));
  assert.equal(restarted.claim(), undefined);
  const resumed = control(b, task.id, 'resume', paused.version);
  const third = restarted.claim();
  assert.ok(third);
  assert.equal(resumed.status, 'planning');
  control(b, task.id, 'cancel', resumed.version);
  assert.throws(() => restarted.guard(third));
  a.close();
  b.close();
});
test('compaction keeps tool identity and recent messages; hooks can be detached', () => {
  const data = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'policy' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 't', name: 'read_file', arguments: '{}' },
        ],
      },
      {
        role: 'tool',
        toolCallId: 't',
        content: [{ type: 'text', text: 'long'.repeat(8000) }],
      },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ],
  };
  const view = compact(data, 1800);
  assert.equal(view.messages[2].toolCallId, 't');
  assert.match(view.messages[2].content[0].text, /compacted/);
  assert.equal(view.messages[3].content[0].text, 'continue');
  assert.equal(data.messages[2].content[0].text.length, 32000);
  const hooks = new Hooks();
  let fired = 0;
  const off = hooks.on('usage', () => fired++);
  hooks.emit('usage', {});
  off();
  hooks.emit('usage', {});
  assert.equal(fired, 1);
});
