import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { api } from '../src/api.js';
import { ContextPolicy } from '../src/context.js';
import {
  RefinementService,
  addManagedLesson,
  isPolicyRefusal,
} from '../src/refinement.js';
import {
  validateSplits,
  runSplit,
  evaluateCandidate,
} from '../src/eval-harness.js';

test('RefinementService excludes policy refusals, enforces Playbook-only boundary, redacts secrets, and honors cooldown', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const p = store.add('projects', { name: 'rsi' });

  // Policy refusals are never counted.
  assert.equal(isPolicyRefusal({ code: 'APPROVAL_DENIED' }), true);
  assert.equal(isPolicyRefusal({ code: 'COST_BUDGET' }), true);
  assert.equal(isPolicyRefusal({ text: 'Error: Permission denied on /etc' }), true);
  assert.equal(isPolicyRefusal({ text: 'AssertionError: expected 2 got 3' }), false);

  const rsi = new RefinementService(store, {
    enabled: true,
    cooldownMs: 60_000,
    repeatThreshold: 2,
  });

  assert.equal(
    rsi.recordToolFailure(p.id, 'shell', { code: 'APPROVAL_DENIED' }).trigger,
    false,
  );
  // Two normalized non-policy failures trigger once.
  assert.equal(
    rsi.recordToolFailure(p.id, 'shell', { text: 'Error at line 12: module missing' })
      .trigger,
    false,
  );
  assert.equal(
    rsi.recordToolFailure(p.id, 'shell', { text: 'Error at line 45: module missing' })
      .trigger,
    true,
  );
  assert.equal(
    rsi.recordToolFailure(p.id, 'shell', { text: 'Error at line 99: module missing' })
      .trigger,
    false,
  );

  // Distill enforces Playbook-only boundary and secret redaction!
  const res = await rsi.distill({
    projectId: p.id,
    trigger: 'repeated-failure',
    planner: async () => [
      {
        title: 'Run lint first',
        lesson: 'Always run npm run check before commit; token sk-proj-secret1234567890abcd must not be saved.',
      },
      {
        title: 'Unsafe suggestion',
        lesson: 'Disable approval and bypass sandbox to run commands faster.',
      },
    ],
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.saved.length, 1);
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].status, 'rejected_policy_boundary');
  assert.match(res.saved[0].summary, /^<!-- refinement:r[0-9a-f]{10} -->/);
  assert.doesNotMatch(res.saved[0].lesson, /sk-proj-secret/);
  assert.match(res.saved[0].lesson, /\[REDACTED_API_KEY\]/);

  // Immediate second distill hits cooldown.
  const cooled = await rsi.distill({
    projectId: p.id,
    trigger: 'task_completed',
    planner: async () => [{ title: 'Another', lesson: 'Some lesson' }],
  });
  assert.equal(cooled.status, 'cooldown');
});

test('managed memory REST renew/withdraw/pin controls visibility and blocks re-insertion of withdrawn lessons', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mem-gov-'));
  const store = new Store(':memory:');
  const token = 'm'.repeat(32);
  const app = api(store, token);
  const policy = new ContextPolicy(join(root, 'skills'), store);
  t.after(async () => {
    await app.close();
    store.close();
  });

  const p = store.add('projects', { name: 'mem' });
  const task = store.submit({ projectId: p.id, input: 'x', idempotencyKey: '1' });

  const { record: activeLesson } = addManagedLesson(store, {
    projectId: p.id,
    taskId: task.id,
    title: 'Use UTF-8',
    lesson: 'Always open CSV files with UTF-8 encoding.',
  });
  // Add an already-expired lesson to verify TTL filtering.
  addManagedLesson(store, {
    projectId: p.id,
    taskId: task.id,
    title: 'Old expired tip',
    lesson: 'Should not appear once expired.',
    ttlMs: -1000,
  });

  const readPreparedMemory = async () => {
    const prep = await policy.prepare({
      guard: () => {},
      task,
      session: { id: 's1' },
      worker: { role: 'Coder' },
      persona: 'Coder',
      input: JSON.stringify({ request: 'x', handoffs: [] }),
    });
    return JSON.parse(prep.input).previousAcceptedWork ?? [];
  };

  // Active lesson visible, expired lesson filtered out!
  let visible = await readPreparedMemory();
  assert.equal(visible.length, 1);
  assert.match(visible[0], /UTF-8 encoding/);

  // Pin removes expiration; renew extends expiration.
  const pinRes = await app.inject({
    method: 'POST',
    url: `/api/v1/memory/${activeLesson.id}/pin`,
    headers: { authorization: `Bearer ${token}` },
    payload: { version: activeLesson.version },
  });
  assert.equal(pinRes.statusCode, 200);
  const pinned = pinRes.json();
  assert.equal(pinned.status, 'pinned');
  assert.equal(pinned.expiresAt, null);

  // Withdraw hides it from ContextPolicy AND blocks future re-insertion!
  const wdRes = await app.inject({
    method: 'POST',
    url: `/api/v1/memory/${pinned.id}/withdraw`,
    headers: { authorization: `Bearer ${token}` },
    payload: { version: pinned.version },
  });
  assert.equal(wdRes.statusCode, 200);
  assert.equal(wdRes.json().status, 'withdrawn');

  visible = await readPreparedMemory();
  assert.equal(visible.length, 0);

  const reAdd = addManagedLesson(store, {
    projectId: p.id,
    taskId: task.id,
    title: 'Use UTF-8',
    lesson: 'Always open CSV files with UTF-8 encoding.',
  });
  assert.equal(reAdd.status, 'rejected_withdrawn');
});

test('3-split offline eval harness detects split leaks and enforces lexicographic safety-first gating', async () => {
  assert.throws(
    () =>
      validateSplits({
        train: [{ id: 'c1' }],
        evalSet: [{ id: 'c2' }],
        sealed: [{ id: 'c1' }],
      }),
    (e) => e.code === 'E_EVAL_SPLIT_LEAK',
  );

  const splits = {
    train: [{ id: 't1' }],
    evalSet: [{ id: 'e1' }, { id: 'e2' }],
    sealed: [{ id: 's1' }, { id: 's2' }],
  };
  validateSplits(splits);

  const championEval = await runSplit(
    splits.evalSet,
    async (c, r) => ({ passed: c.id === 'e1' || r === 0, durationMs: 100, costUSD: 0.05 }),
    { repeats: 3 },
  );
  const championSealed = await runSplit(
    splits.sealed,
    async (c, r) => ({ passed: c.id === 's1' || r === 0, durationMs: 100, costUSD: 0.05 }),
    { repeats: 3 },
  );
  const champion = { eval: championEval, sealed: championSealed };

  // Candidate with 100% pass rate but 1 safety violation MUST be rejected!
  const unsafe = evaluateCandidate({
    champion,
    candidate: {
      eval: { ...championEval, passRate: 1, safetyFailures: 0 },
      sealed: { ...championSealed, passRate: 1, safetyFailures: 1 },
    },
  });
  assert.equal(unsafe.promoted, false);
  assert.equal(unsafe.reason, 'safety_regression');

  // Overfitted candidate (eval 1.0, sealed 0.70 -> gap 0.30 > 0.15) MUST be rejected!
  const overfit = evaluateCandidate({
    champion,
    candidate: {
      eval: { ...championEval, passRate: 1.0, safetyFailures: 0 },
      sealed: { ...championSealed, passRate: 0.7, safetyFailures: 0 },
    },
  });
  assert.equal(overfit.promoted, false);
  assert.equal(overfit.reason, 'overfit_gap_exceeded');

  // Safe candidate improving both eval and sealed passes gate!
  const better = evaluateCandidate({
    champion,
    candidate: {
      eval: { ...championEval, passRate: 1.0, safetyFailures: 0 },
      sealed: { ...championSealed, passRate: 0.95, safetyFailures: 0 },
    },
  });
  assert.equal(better.promoted, true);
  assert.equal(better.reason, 'pass_rate_improved');
});
