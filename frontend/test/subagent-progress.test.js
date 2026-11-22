import assert from 'node:assert/strict';
import test from 'node:test';
import { subagentGroups, subagentOverview, swarmWorkerStatus } from '../src/utils/subagentProgress.ts';

test('only an explicit completed node maps to a finished worker', () => {
  const expected = {
    pending: 'waiting', ready: 'waiting', queued: 'waiting', running: 'running',
    parked: 'parked', interrupted: 'interrupted', reconciling: 'reconciling',
    completed: 'done', failed: 'failed', cancelled: 'cancelled', future_state: 'unknown',
  };
  for (const [nodeStatus, workerStatus] of Object.entries(expected)) {
    assert.equal(swarmWorkerStatus(nodeStatus), workerStatus, nodeStatus);
  }
});

test('summary counts the newest attempt of each assignment and ignores stale versions', () => {
  const worker = (id, assignmentId, attempt, version, status) => ({ id, assignmentId, attempt, version, status });
  const attempts = [
    worker('worker-b', 'build', 2, 3, 'running'),
    worker('worker-a', 'build', 1, 9, 'failed'),
    worker('worker-b', 'build', 2, 1, 'waiting'),
    worker('worker-c', 'lint', 1, 3, 'done'),
    worker('router', null, 1, 2, 'running'),
  ];
  for (const records of [attempts, attempts.toReversed()]) {
    const groups = subagentGroups(records);
    assert.deepEqual(groups.map(({ label, members }) => [label, members.map((w) => w.id)]), [
      ['运行中', ['worker-b']], ['已完成', ['worker-c']],
    ]);
  }
});

test('no child assignments means no progress row, including control-plane-only sessions', () => {
  assert.deepEqual(subagentGroups([]), []);
  assert.deepEqual(subagentGroups([{ assignmentId: null, status: 'running' }]), []);
});


test('compact overview counts only latest assignments and retains previous attempts and runtime events in history', () => {
  const record = (id, assignmentId, attempt, status, version = 1) => ({ id, assignmentId, attempt, status, version });
  const records = [record('retry', 'build', 2, 'running'), record('old', 'build', 1, 'failed'),
    record('lint', 'lint', 1, 'done'), record('broken', 'test', 1, 'failed'), record('infra', null, 1, 'done', 2),
    record('infra', null, 1, 'running')];
  for (const input of [records, records.toReversed()]) {
    const { tasks, history, completed, failed, description } = subagentOverview(input);
    assert.deepEqual(tasks.map(worker => worker.id), ['retry', 'broken', 'lint']);
    assert.equal(completed, 1);
    assert.equal(failed, 1);
    assert.equal(description, '1 运行中 · 1 失败 · 1 已完成');
    assert.deepEqual(history.map(worker => worker.id).sort(), ['infra', 'old']);
    assert.equal(history.find(worker => worker.id === 'infra').status, 'done');
  }
});
