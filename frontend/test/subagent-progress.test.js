import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiError,
  LiveBackendClient,
  collectSwarmReviewerVerdicts,
  extractSwarmTelemetry,
  formatSwarmApplyAllFeedback,
  getSwarmDeliveryApplyState,
  isUnsupportedSwarmEndpointError,
  normalizeSwarmDelivery,
} from '../src/api/client.ts';
import { fmtTokens } from '../src/utils/format.ts';
import { subtaskTitle } from '../src/utils/worker.ts';
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

test('subtask rows follow assignment count even when all assignments share the same capability', () => {
  for (const count of [0, 1, 2, 7]) {
    const workers = Array.from({ length: count }, (_, i) => ({
      id: `w${i}`, assignmentId: `task${i}`, workerRole: 'implementation', status: 'waiting', attempt: 1, version: 1,
    }));
    assert.deepEqual(subagentOverview(workers).tasks.map(worker => worker.assignmentId), workers.map(worker => worker.assignmentId));
  }
});

test('subtask labels use the actual objective and keep legacy names when the objective is absent', () => {
  assert.equal(subtaskTitle('  修复空查询时的分页\r\n保留现有 API。', 'implementation'), '修复空查询时的分页');
  assert.equal(subtaskTitle('补齐索引迁移测试', 'implementation'), '补齐索引迁移测试');
  assert.equal(subtaskTitle('  ', 'index-search'), 'index-search');
  assert.equal(subtaskTitle(undefined, '文档校对'), '文档校对');
});

test('normalizeSwarmDelivery safely handles partial and legacy payloads', () => {
  const normalized = normalizeSwarmDelivery({
    runId: 'run-1',
    status: 'completed',
    goal: 'Fix bug',
    repoContext: { branch: ' main ', testCommands: ['node --test', 'node --test', '  '] },
  });
  assert.equal(normalized.runId, 'run-1');
  assert.deepEqual(normalized.changedFiles, []);
  assert.deepEqual(normalized.conflicts, []);
  assert.deepEqual(normalized.testResults, []);
  assert.deepEqual(normalized.reviewerVerdicts, []);
  assert.deepEqual(normalized.artifacts, []);
  assert.equal(normalized.unifiedDiffPreview, '');
  assert.deepEqual(normalized.repoContext, {
    branch: 'main',
    headSha: null,
    testCommands: ['node --test'],
    buildCommands: [],
    entryPoints: [],
    relevantFiles: [],
    summaryText: null,
  });

  const empty = normalizeSwarmDelivery(null, 'fallback-id');
  assert.equal(empty.runId, 'fallback-id');
  assert.equal(empty.repoContext, null);
});

test('getSwarmDeliveryApplyState gates apply-all on zero conflicts and unapplied non-empty artifacts', () => {
  const archivedArtifact = {
    id: 'art-1', uri: 'artifact://1', runId: 'run-1', nodeId: 'n1', nodeKey: 'impl',
    attempt: 1, ownerId: 'impl', bundleSha256: 'abc', fileCount: 2, totalBytes: 100,
    status: 'archived', files: [{ path: 'src/a.js', status: 'modified' }], appliedAt: null, createdAt: 1, updatedAt: 1,
  };
  const storedNoCountArtifact = {
    id: 'art-1b', uri: 'artifact://1b', runId: 'run-1', nodeId: 'n1b', nodeKey: 'impl-b',
    attempt: 1, ownerId: 'impl-b', bundleSha256: 'def', totalBytes: 50,
    status: 'archived', files: [{ path: 'src/b.js', status: 'added' }], appliedAt: null, createdAt: 1, updatedAt: 1,
  };
  const appliedArtifact = { ...archivedArtifact, id: 'art-2', status: 'applied', appliedAt: 200 };
  const supersededArtifact = { ...archivedArtifact, id: 'art-3', status: 'superseded' };
  const emptyArtifact = { ...archivedArtifact, id: 'art-4', fileCount: 0, files: [] };
  const emptyFilesNoCountArtifact = {
    id: 'art-5', uri: 'artifact://5', runId: 'run-1', nodeId: 'n5', nodeKey: 'verify',
    attempt: 1, ownerId: 'verify', bundleSha256: 'ghi',
    status: 'archived', files: [], appliedAt: null, createdAt: 1, updatedAt: 1,
  };

  const ready = getSwarmDeliveryApplyState(normalizeSwarmDelivery({
    runId: 'run-1',
    artifacts: [archivedArtifact, storedNoCountArtifact, appliedArtifact, supersededArtifact, emptyArtifact, emptyFilesNoCountArtifact],
    conflicts: [],
  }));
  assert.equal(ready.canApplyAll, true);
  assert.equal(ready.allApplied, false);
  assert.equal(ready.unappliedCount, 2);

  const onlyEmpty = getSwarmDeliveryApplyState(normalizeSwarmDelivery({
    runId: 'run-1',
    artifacts: [emptyArtifact, emptyFilesNoCountArtifact],
    conflicts: [],
  }));
  assert.equal(onlyEmpty.canApplyAll, false);
  assert.equal(onlyEmpty.allApplied, false);

  const conflicted = getSwarmDeliveryApplyState(normalizeSwarmDelivery({
    runId: 'run-1',
    artifacts: [archivedArtifact],
    conflicts: [{ path: 'src/a.js', nodeKeys: ['impl-1', 'impl-2'], reason: 'concurrent modification' }],
  }));
  assert.equal(conflicted.hasConflicts, true);
  assert.equal(conflicted.canApplyAll, false);

  const done = getSwarmDeliveryApplyState(normalizeSwarmDelivery({
    runId: 'run-1',
    artifacts: [appliedArtifact],
    conflicts: [],
  }));
  assert.equal(done.canApplyAll, false);
  assert.equal(done.allApplied, true);
});

test('extractSwarmTelemetry and collectSwarmReviewerVerdicts stay backward compatible', () => {
  const legacyTelemetry = extractSwarmTelemetry({
    id: 'r0', sessionId: 's0', goal: 'old', status: 'completed',
    usage: {}, nodes: [], createdAt: 1, updatedAt: 2,
  });
  assert.equal(legacyTelemetry.hasTelemetry, false);
  assert.equal(legacyTelemetry.branch, null);
  assert.deepEqual(legacyTelemetry.testCommands, []);

  const richRun = {
    id: 'r1',
    sessionId: 's1',
    goal: 'implement feature',
    status: 'completed',
    replanCount: 1,
    usage: { steps: 6, inputTokens: 900, outputTokens: 350 },
    verdict: {
      verdict: 'fail',
      accepted: false,
      reasons: ['independent_reviewer_rejected'],
      reviewerVerdicts: [
        {
          nodeKey: 'review-main',
          status: 'needs_revision',
          reviewerModel: 'gpt-5',
          summary: 'Missing edge check',
          findings: [{ severity: 'high', message: 'Handle empty array', evidenceRef: 'receipt://1' }],
        },
      ],
    },
    nodes: [],
    createdAt: 1,
    updatedAt: 2,
  };
  const delivery = normalizeSwarmDelivery({
    runId: 'r1',
    usage: { steps: 8, inputTokens: 1200, outputTokens: 400 },
    repoContext: { branch: 'feat/demo', headSha: 'abcdef123456', testCommands: ['npm test'] },
  });

  const telemetry = extractSwarmTelemetry(richRun, delivery);
  assert.equal(telemetry.hasTelemetry, true);
  assert.equal(telemetry.steps, 8);
  assert.equal(telemetry.totalTokens, 1600);
  assert.equal(fmtTokens(telemetry.totalTokens), '1.6k');
  assert.equal(telemetry.replanCount, 1);
  assert.equal(telemetry.branch, 'feat/demo');
  assert.deepEqual(telemetry.testCommands, ['npm test']);

  const verdicts = collectSwarmReviewerVerdicts(richRun, delivery);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].findings[0].severity, 'high');
});

test('LiveBackendClient delivery & apply-all endpoints handle payloads and 404/409 gracefully', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/v1/swarm/runs/run%2F1/delivery')) {
      return new Response(JSON.stringify({
        runId: 'run/1',
        status: 'completed',
        goal: 'Ship UI',
        changedFiles: [{ path: 'src/a.ts', changeType: 'modified', nodeKey: 'impl', artifactId: 'a1', uri: 'artifact://a1' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/v1/swarm/runs/run%2F1/artifacts/apply-all')) {
      return new Response(JSON.stringify({
        ok: true,
        status: 'applied',
        runId: 'run/1',
        appliedArtifacts: ['a1'],
        appliedFiles: ['src/a.ts'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/v1/swarm/runs/old-server/delivery')) {
      return new Response(JSON.stringify({ error: { code: 'HTTP_404', message: 'Not Found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      status: 'conflict',
      errors: [{ artifactId: 'a1', errors: ['bundle sha mismatch'] }],
      conflicts: [{ path: 'src/a.ts', nodeKeys: ['impl-1', 'impl-2'], reason: 'src/a.ts modified' }],
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const client = new LiveBackendClient({ mode: 'live', baseUrl: 'http://127.0.0.1:4310', token: 'tok' });
    const ac = new AbortController();
    const delivery = await client.getSwarmDelivery('run/1', ac.signal);
    assert.equal(delivery.changedFiles.length, 1);
    assert.deepEqual(delivery.conflicts, []);
    assert.equal(calls[0].init.signal, ac.signal);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');

    const applyRes = await client.applyAllSwarmArtifacts('run/1', { approved: true });
    assert.equal(applyRes.ok, true);
    assert.deepEqual(JSON.parse(calls[1].init.body), { approved: true });
    assert.deepEqual(formatSwarmApplyAllFeedback(applyRes), {
      text: '已将 1 个产物（1 个文件）应用到父工作区。',
      failed: false,
    });
    const objErrFeedback = formatSwarmApplyAllFeedback({
      ok: false,
      status: 'conflict',
      runId: 'run/1',
      conflicts: [{ path: 'src/a.ts', reason: 'concurrent edit' }],
      errors: [{ artifactId: 'a1', errors: ['sha mismatch'] }],
    });
    assert.equal(objErrFeedback.failed, true);
    assert.equal(objErrFeedback.text.includes('[object Object]'), false);
    assert.equal(objErrFeedback.text.includes('src/a.ts: concurrent edit'), true);
    assert.equal(objErrFeedback.text.includes('a1: sha mismatch'), true);

    await assert.rejects(
      () => client.getSwarmDelivery('old-server'),
      (err) => isUnsupportedSwarmEndpointError(err) === true,
    );
    await assert.rejects(
      () => client.applyAllSwarmArtifacts('conflict-run', { approved: true }),
      (err) => err instanceof ApiError
        && err.status === 409
        && !err.message.includes('[object Object]')
        && err.message.includes('a1: bundle sha mismatch')
        && err.message.includes('src/a.ts: src/a.ts modified'),
    );
    assert.equal(isUnsupportedSwarmEndpointError(new ApiError(404, 'SWARM_RUN_NOT_FOUND')), false);
    assert.equal(isUnsupportedSwarmEndpointError(new ApiError(500, 'INTERNAL')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
