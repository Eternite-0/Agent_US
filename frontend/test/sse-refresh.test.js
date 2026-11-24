import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendRecentEvent,
  createBundleSelector,
  createLatestRequests,
  createRefreshQueue,
  createSseRefreshScheduler,
  EMPTY_BUNDLE_CACHE,
  mergeRecentEvents,
  mergeTaskBundle,
  mergeTaskList,
  threadRootFor,
} from '../src/utils/sseRefresh.ts';

const task = (id, version = 1, fields = {}) => ({ id, version, createdAt: 1, status: 'running', ...fields });
const bundle = (id, version = 1, messages = ['first']) => ({
  task: task(id, version),
  histories: { [id]: messages.map((text, i) => ({ cursor: i + 1, text })) },
  events: [], workers: [], sessions: [], approvals: [], assignments: [], evidence: [], artifacts: [], usage: [],
});
const event = (seq, type = 'turn/started') => ({ seq, type, timestamp: seq, taskId: 'root', projectId: null, payload: {} });
const tickMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('partial or failed task refresh preserves sibling bundles and loaded content', () => {
  const select = createBundleSelector();
  const chain = ['root', 'child'];
  const child = bundle('child', 2);
  const root = bundle('root', 2);
  let cache = mergeTaskBundle(EMPTY_BUNDLE_CACHE, 'child', child);
  assert.deepEqual(select(cache, chain), [], 'child cannot render as the root while root is loading');
  cache = mergeTaskBundle(cache, 'root', root);
  const original = select(cache, chain);
  assert.deepEqual(original, [root, child]);
  assert.equal(mergeTaskBundle(cache, 'child', null), cache);
  assert.equal(mergeTaskBundle(cache, 'root', bundle('root', 1)), cache);
  assert.equal(mergeTaskBundle(cache, 'root', bundle('other', 10)), cache);
  assert.equal(mergeTaskBundle(cache, 'root', structuredClone(root)), cache);
  cache = mergeTaskBundle(cache, 'unrelated', bundle('unrelated'));
  assert.equal(select(cache, chain), original, 'background result is invisible to the active chain');

  cache = mergeTaskBundle(cache, 'child', bundle('child', 2, ['first', 'second']));
  const next = select(cache, chain);
  assert.equal(next[0], root);
  assert.notEqual(next[1], child, 'live snapshots can change without a task version bump');
  assert.equal(next[1].task, child.task);
  assert.equal(next[1].events, child.events);
  assert.equal(next[1].histories.child[0], child.histories.child[0]);
  cache = mergeTaskBundle(cache, 'child', bundle('child', 2, ['first']));
  assert.deepEqual(select(cache, chain)[1].histories.child, child.histories.child, 'rewind can remove content');
});

test('an initial error settles only the requested task and a retry can populate it', () => {
  const failed = mergeTaskBundle(EMPTY_BUNDLE_CACHE, 'root', null);
  assert.equal(failed.get('root'), null);
  assert.equal(failed.has('child'), false);
  assert.equal(mergeTaskBundle(failed, 'root', null), failed);
  const recovered = mergeTaskBundle(failed, 'root', bundle('root'));
  assert.equal(recovered.get('root').task.id, 'root');
});

test('task list protects per-task writes and versions without freezing other tasks or recreating unchanged objects', () => {
  const a = task('a', 3, { createdAt: 3 });
  const b = task('b', 1, { createdAt: 2 });
  const child = task('child', 1, { createdAt: 4 });
  const previous = [child, a, b];
  assert.equal(mergeTaskList(previous, structuredClone(previous), new Set()), previous);
  const merged = mergeTaskList(previous, [
    { ...a, version: 2 }, { ...b, status: 'completed' }, task('archived'),
  ], new Set(['archived', 'child']));
  assert.deepEqual(merged.map((entry) => entry.id), ['child', 'a', 'b']);
  assert.equal(merged[0], child);
  assert.equal(merged[1], a);
  assert.equal(merged[2].status, 'completed');
  assert.deepEqual(mergeTaskList(merged, [a], new Set()), [a], 'a fresh list is authoritative about membership');
});

test('latest-response guard is task-local and also guards failures and local invalidation', async () => {
  const requests = createLatestRequests();
  const old = deferred();
  const newest = deferred();
  let cache = mergeTaskBundle(EMPTY_BUNDLE_CACHE, 'root', bundle('root', 3));
  const initial = cache.get('root');
  const read = async (id, response) => {
    const request = requests.start(id);
    const loaded = await response.catch(() => null);
    if (request.claim()) cache = mergeTaskBundle(cache, id, loaded);
  };
  const p1 = read('root', old.promise);
  const p2 = read('root', newest.promise);
  await read('child', Promise.resolve(bundle('child')));
  newest.reject(new Error('offline'));
  await p2;
  old.resolve(bundle('root', 4));
  await p1;
  assert.equal(cache.get('root'), initial, 'old success cannot resurrect an obsolete snapshot after newer failure');
  assert.equal(cache.get('child').task.id, 'child');
  const pending = requests.start('root');
  requests.invalidate('root');
  assert.equal(pending.claim(), false);
  const current = requests.start('root');
  assert.equal(current.claim(), true);
  assert.equal(current.claim(), false);
});

test('child navigation resolves to the known root without waiting for bundle data', () => {
  const chains = { root: ['child', 'later-child'] };
  for (const id of ['root', 'child', 'later-child']) {
    assert.equal(threadRootFor(id, chains), 'root');
  }
  assert.equal(threadRootFor('fork', chains), 'fork');
  assert.equal(threadRootFor('child', {}), 'child');
  const select = createBundleSelector();
  const cache = mergeTaskBundle(EMPTY_BUNDLE_CACHE, 'root', bundle('root'));
  assert.equal(select(cache, ['root', 'child']), select(cache, ['root']));
});

test('recent events retain seq/type dedup, identity, order and bounded history across replay', () => {
  const persisted = event(20);
  const recent = [event(10), persisted];
  assert.equal(appendRecentEvent(recent, structuredClone(persisted)), recent);
  assert.equal(mergeRecentEvents(recent, [event(20)]), recent);
  const sibling = event(20, 'turn/completed');
  const backfill = mergeRecentEvents([...recent, sibling], [event(15), event(20), event(20, 'turn/completed')]);
  assert.deepEqual(backfill.map((entry) => entry.seq), [10, 15, 20, 20]);
  assert.equal(backfill[2], persisted);
  assert.equal(backfill[3], sibling);
  assert.equal(appendRecentEvent([event(0)], event(0)).length, 2);
  assert.equal(mergeRecentEvents([], Array.from({ length: 130 }, (_, i) => event(i + 1)))[0].seq, 11);
});

test('SSE coalesces bursts, allows unrelated keys through, and trails in-flight invalidations once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const firstWorkspace = deferred();
  const queue = createRefreshQueue(async (key) => {
    calls.push(key);
    if (key === 'workspace' && calls.length === 1) await firstWorkspace.promise;
  });
  queue.add('workspace');
  queue.add('workspace');
  t.mock.timers.tick(119);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  await tickMicrotasks();
  assert.deepEqual(calls, ['workspace']);
  queue.add('workspace');
  queue.add('workspace');
  queue.add('active');
  queue.add('active');
  t.mock.timers.tick(120);
  await tickMicrotasks();
  assert.deepEqual(calls, ['workspace', 'active']);
  firstWorkspace.resolve();
  await tickMicrotasks();
  t.mock.timers.tick(120);
  await tickMicrotasks();
  assert.deepEqual(calls, ['workspace', 'active', 'workspace']);
  queue.stop();
});

test('disposing the old SSE queue cancels timers and in-flight trailing work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const slow = deferred();
  const queue = createRefreshQueue(async (key) => { calls.push(key); await slow.promise; });
  queue.add('running');
  t.mock.timers.tick(120);
  await tickMicrotasks();
  queue.add('running');
  queue.add('pending');
  queue.stop();
  queue.add('late');
  slow.reject(new Error('disconnected'));
  await tickMicrotasks();
  t.mock.timers.tick(240);
  await tickMicrotasks();
  assert.deepEqual(calls, ['running']);
});


test('an SSE reconnect catches up with no replay, and structural events only refresh affected active tasks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let active = ['root', 'child'];
  const calls = [];
  const scheduler = createSseRefreshScheduler(
    () => active,
    async () => { calls.push('workspace'); },
    async (id) => { calls.push(id); },
  );
  const flush = async () => { t.mock.timers.tick(120); await tickMicrotasks(); };
  scheduler.status('connected');
  scheduler.event({ ...event(1, 'turn/phase_changed'), taskId: 'other' });
  await flush();
  assert.deepEqual(calls, []);
  scheduler.event({ ...event(2), taskId: 'other' });
  scheduler.event({ ...event(3), taskId: 'worker', payload: { sessionId: 'child' } });
  await flush();
  assert.deepEqual(calls.splice(0), ['workspace', 'child']);
  scheduler.event(event(4));
  active = ['other'];
  await flush();
  assert.deepEqual(calls.splice(0), ['workspace'], 'ignore queued bundle loads after navigating away');
  scheduler.status('reconnecting');
  await flush();
  assert.deepEqual(calls, []);
  scheduler.status('connected');
  await flush();
  assert.deepEqual(calls.splice(0), ['workspace', 'other']);
  scheduler.status('connected'); // A clean EOF may reconnect without a disconnect notification.
  await flush();
  assert.deepEqual(calls, ['workspace', 'other']);
  scheduler.stop();
});
