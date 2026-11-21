import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Store } from '../../src/store.js';
import { ExperienceMemoryService } from '../../src/memory/index.js';
import { registerIntelligenceRoutes } from '../../src/routes/intelligence-routes.js';

function addEvaluationRun(store, {
  id,
  projectId = 'project-a',
  status = 'completed',
  synthetic = true,
  score = { total: 1, passed: 1, failed: 0, cancelled: 0, timedOut: 0 },
} = {}) {
  store.add('evaluation_runs', {
    id,
    projectId,
    status,
    synthetic,
    score,
    results: [{
      taskId: 'task-1',
      status: status === 'completed' ? 'passed' : status,
      passed: status === 'completed',
      evidenceRef: `evaluation:${id}:task-1`,
    }],
  }, null, null, id);
}

function createMemory(store, projectId = 'project-a') {
  const memory = new ExperienceMemoryService({ store, projectId, clock: () => 1_700_000_000_000 });
  const [item] = memory.remember({
    projectId,
    type: 'lesson',
    key: 'bounded-retry',
    content: 'Use bounded retries for transient provider failures.',
    confidence: 0.7,
  });
  return { memory, item };
}

test('ordinary memory API cannot promote verified:true into trusted memory', async (t) => {
  const store = new Store(':memory:');
  const memory = new ExperienceMemoryService({ store });
  const app = Fastify();
  registerIntelligenceRoutes(app, { memory });
  await app.ready();
  t.after(async () => { await app.close(); store.close(); });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/memory/experience',
    payload: {
      projectId: 'project-a',
      type: 'lesson',
      key: 'client-claim',
      content: 'Client supplied claim.',
      confidence: 1,
      verified: true,
      verificationEvidence: {
        sourceTaskId: 'client-task',
        evaluationRunId: 'client-run',
        passed: true,
      },
    },
  });

  assert.equal(response.statusCode, 200);
  const [saved] = response.json();
  assert.equal(saved.verified, false);
  assert.equal(saved.verificationEvidence, null);
});

test('ordinary memory feedback cannot use verify action or verified:true', async (t) => {
  const store = new Store(':memory:');
  const { memory, item } = createMemory(store);
  const app = Fastify();
  registerIntelligenceRoutes(app, { memory });
  await app.ready();
  t.after(async () => { await app.close(); store.close(); });

  const verifyAction = await app.inject({
    method: 'POST',
    url: `/v1/memory/experience/${item.id}/feedback`,
    payload: { projectId: 'project-a', action: 'verify' },
  });
  assert.equal(verifyAction.statusCode, 403);
  assert.equal(verifyAction.json().code, 'MEMORY_VERIFICATION_FORBIDDEN');

  const verifiedFlag = await app.inject({
    method: 'POST',
    url: `/v1/memory/experience/${item.id}/feedback`,
    payload: { projectId: 'project-a', action: 'helpful', verified: true },
  });
  assert.equal(verifiedFlag.statusCode, 403);
  assert.equal(verifiedFlag.json().code, 'MEMORY_VERIFICATION_FORBIDDEN');

  const unchanged = memory.retrieve({ projectId: 'project-a', query: 'bounded retries' }).items;
  assert.equal(unchanged.length, 1);
  assert.equal(unchanged[0].verified, false);
});

test('trusted memory verification rejects failed, cancelled, and timed-out evaluation evidence', () => {
  for (const status of ['failed', 'cancelled', 'timeout']) {
    const store = new Store(':memory:');
    try {
      const { memory, item } = createMemory(store);
      addEvaluationRun(store, { id: `run-${status}`, status });
      const verify = memory.createTrustedVerifier();

      assert.throws(
        () => verify({
          id: item.id,
          projectId: 'project-a',
          sourceTaskId: 'task-1',
          evaluationRunId: `run-${status}`,
          evidence: { sourceTaskId: 'task-1', evaluationRunId: `run-${status}`, passed: false },
        }),
        /completed evaluation run/,
        `status ${status} must not verify memory`,
      );
      assert.equal(memory.retrieve({ projectId: 'project-a', query: 'bounded retries' }).items[0].verified, false);
    } finally {
      store.close();
    }
  }
});

test('trusted memory verification rejects incomplete score evidence even when run is completed', () => {
  for (const score of [
    { total: 2, passed: 1, failed: 1 },
    { total: 2, passed: 1, cancelled: 1 },
    { total: 2, passed: 1, timedOut: 1 },
  ]) {
    const store = new Store(':memory:');
    try {
      const { memory, item } = createMemory(store);
      const runId = `run-score-${Object.keys(score).find((key) => key !== 'total' && key !== 'passed')}`;
      addEvaluationRun(store, { id: runId, score: { total: 2, passed: 1, failed: 0, cancelled: 0, timedOut: 0 } });
      const verify = memory.createTrustedVerifier();
      assert.throws(
        () => verify({
          id: item.id,
          projectId: 'project-a',
          sourceTaskId: 'task-1',
          evaluationRunId: runId,
          evidence: { sourceTaskId: 'task-1', evaluationRunId: runId, score },
        }),
        /fully passed evaluation evidence/,
      );
      assert.equal(memory.retrieve({ projectId: 'project-a', query: 'bounded retries' }).items[0].verified, false);
    } finally {
      store.close();
    }
  }
});

test('trusted memory verification rejects project mismatch and missing completed evaluation run', () => {
  const store = new Store(':memory:');
  try {
    const { memory, item } = createMemory(store);
    addEvaluationRun(store, { id: 'run-project-b', projectId: 'project-b' });
    addEvaluationRun(store, { id: 'run-pending', status: 'running' });
    addEvaluationRun(store, { id: 'run-real', synthetic: false });
    const verify = memory.createTrustedVerifier();

    assert.throws(
      () => verify({
        id: item.id,
        projectId: 'project-a',
        sourceTaskId: 'task-1',
        evaluationRunId: 'run-project-b',
        evidence: { projectId: 'project-b', sourceTaskId: 'task-1', evaluationRunId: 'run-project-b', passed: true },
      }),
      /project does not match memory project/,
    );

    for (const evaluationRunId of ['missing-run', 'run-pending', 'run-real']) {
      assert.throws(
        () => verify({
          id: item.id,
          projectId: 'project-a',
          sourceTaskId: 'task-1',
          evaluationRunId,
          evidence: { sourceTaskId: 'task-1', evaluationRunId, passed: true },
        }),
        /NOT_FOUND|completed evaluation run in the same project/,
        `run ${evaluationRunId} must not be trusted`,
      );
    }
    assert.equal(memory.retrieve({ projectId: 'project-a', query: 'bounded retries' }).items[0].verified, false);
  } finally {
    store.close();
  }
});

test('direct verification requires its private trusted authority', () => {
  const store = new Store(':memory:');
  try {
    const { memory, item } = createMemory(store);
    addEvaluationRun(store, { id: 'run-authority' });
    assert.throws(
      () => memory.verifyWithEvidence({
        id: item.id,
        projectId: 'project-a',
        sourceTaskId: 'task-1',
        evaluationRunId: 'run-authority',
        evidence: { sourceTaskId: 'task-1', evaluationRunId: 'run-authority', passed: true },
      }),
      /trusted verification context is required/,
    );
  } finally {
    store.close();
  }
});


