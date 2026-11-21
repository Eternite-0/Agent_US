import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { CapabilityProfileRegistry } from '../../src/swarm/capability-registry.js';

function addEvaluationRun(store, {
  id,
  projectId = 'project-a',
  status = 'completed',
  synthetic = true,
  score = { total: 1, passed: 1, failed: 0, cancelled: 0, timedOut: 0 },
  results = [{ taskId: 'task-1', status: 'passed', passed: true, artifactId: 'artifact://task-1' }],
} = {}) {
  store.add('evaluation_runs', {
    id,
    projectId,
    status,
    synthetic,
    score,
    results,
  }, null, null, id);
}

test('measured capability cannot be written through the generic API or without evaluation evidence', () => {
  const store = new Store(':memory:');
  try {
    const registry = new CapabilityProfileRegistry({ store });
    registry.registerDeclared({ id: 'model-a', capabilities: { coding: 0.8 } });

    assert.throws(
      () => registry.recordMeasured({ id: 'model-a', sampleCount: 10, capabilities: { coding: 1 } }),
      /recordMeasuredFromEvaluation/,
    );
    assert.throws(
      () => registry.recordMeasuredFromEvaluation({ id: 'model-a', capabilities: { coding: 1 } }, { evidenceRefs: ['artifact://fake'] }),
      /evaluationRunId and evidenceRefs/,
    );
    assert.throws(
      () => registry.recordMeasuredFromEvaluation({ id: 'model-a', capabilities: { coding: 1 } }, { evaluationRunId: 'missing-run', evidenceRefs: ['artifact://fake'] }),
      /persisted completed evaluation run/,
    );
    assert.equal(registry.getMeasured('model-a'), null);

    const persisted = store.list('capability_profiles', { limit: 100 }).find((row) => row.id === 'model-a');
    assert.ok(persisted);
    assert.equal(persisted.profile.measured, null);
  } finally {
    store.close();
  }
});

test('measured capability rejects non-synthetic, incomplete, and unrelated evaluation evidence', () => {
  const store = new Store(':memory:');
  try {
    const registry = new CapabilityProfileRegistry({ store });
    registry.registerDeclared({ id: 'model-a', capabilities: { coding: 0.8 } });
    addEvaluationRun(store, { id: 'eval-running', status: 'running' });
    addEvaluationRun(store, { id: 'eval-real', synthetic: false });
    addEvaluationRun(store, { id: 'eval-no-results', results: [] });
    addEvaluationRun(store, { id: 'eval-other-project', projectId: 'project-b' });

    for (const evaluationRunId of ['eval-running', 'eval-real', 'eval-no-results']) {
      assert.throws(
        () => registry.recordMeasuredFromEvaluation(
          { id: 'model-a', capabilities: { coding: 0.9 } },
          { evaluationRunId, evidenceRefs: ['artifact://task-1'] },
        ),
        /persisted completed evaluation run|evaluation results from the run/,
        `run ${evaluationRunId} must not produce a measurement`,
      );
    }

    assert.throws(
      () => registry.recordMeasuredFromEvaluation(
        { id: 'model-a', capabilities: { coding: 0.9 } },
        { evaluationRunId: 'eval-other-project', evidenceRefs: ['artifact://unknown'] },
      ),
      /evaluation results from the run/,
    );
    assert.equal(registry.getMeasured('model-a'), null);
  } finally {
    store.close();
  }
});

test('startup restore does not synthesize measured capability from declared-only persisted state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-us-capability-negative-'));
  const dbPath = join(dir, 'capability.sqlite');
  let store;
  try {
    store = new Store(dbPath);
    const first = new CapabilityProfileRegistry({ store });
    first.registerDeclared({ id: 'declared-only', capabilities: { coding: 0.95 } });
    assert.equal(first.getMeasured('declared-only'), null);
    store.close();
    store = new Store(dbPath);

    const reopened = new CapabilityProfileRegistry({ store });
    assert.equal(reopened.getDeclared('declared-only').capabilities.coding, 0.95);
    assert.equal(reopened.getMeasured('declared-only'), null);
    assert.equal(reopened.getEffectiveCapability('declared-only').effective.empiricalScore, null);
  } finally {
    if (store?.db?.isOpen) store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test('startup restore preserves only a measurement backed by a persisted evaluation result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-us-capability-backed-'));
  const dbPath = join(dir, 'capability.sqlite');
  let store;
  try {
    store = new Store(dbPath);
    const first = new CapabilityProfileRegistry({ store });
    first.registerDeclared({ id: 'measured-model', capabilities: { coding: 0.8 } });
    addEvaluationRun(store, { id: 'eval-backed' });
    first.recordMeasuredFromEvaluation(
      { id: 'measured-model', capabilities: { coding: 0.6 } },
      { evaluationRunId: 'eval-backed', evidenceRefs: ['artifact://task-1'] },
    );
    store.close();
    store = new Store(dbPath);

    const reopened = new CapabilityProfileRegistry({ store });
    const measured = reopened.getMeasured('measured-model');
    assert.equal(measured.evaluation.evaluationRunId, 'eval-backed');
    assert.deepEqual(measured.evidenceRefs, ['artifact://task-1']);
  } finally {
    if (store?.db?.isOpen) store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

