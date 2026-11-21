import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { AdaptiveSwarmOrchestrator } from '../src/swarm/orchestrator.js';
import { SWARM_JOB_KINDS } from '../src/swarm/jobs.js';
import { TeamOptimizer } from '../src/swarm/team-optimizer.js';

function createQueue() {
  const jobs = [];
  let sequence = 0;
  return {
    jobs,
    enqueue(job) {
      const queued = { ...job, id: job.id ?? `test-job-${++sequence}` };
      jobs.push(queued);
      return queued;
    },
  };
}

function createPlanner() {
  return {
    normalizeNodes(nodes) {
      return nodes.map((node) => ({
        ...node,
        taskType: node.taskType ?? 'implementation',
        dependencies: node.dependencies ?? [],
        acceptance: node.acceptance ?? 'node completes successfully',
        toolAllow: node.toolAllow ?? [],
        budget: node.budget ?? {},
        priority: node.priority ?? 0,
      }));
    },
    validateDag() {},
  };
}

function createRouter(candidates) {
  return {
    modelRegistry: { list: () => candidates.map((candidate) => ({ ...candidate })) },
    select() {
      return {
        model: 'router-default-model',
        provider: 'router-default-provider',
        profile: {
          id: 'router-default-profile',
          toolAllow: [],
        },
      };
    },
  };
}

function createBudgetLedger() {
  return {
    ensureLedger() {
      return { remainingSteps: null };
    },
    getSnapshot() {
      return { remainingSteps: null };
    },
  };
}

function createSession(store, id) {
  const now = Date.now();
  store.db
    .prepare(
      `INSERT INTO direct_sessions(
        id, title, mode, permissionMode, state, createdAt, updatedAt
      ) VALUES(?,?,?,?,?,?,?)`,
    )
    .run(id, 'team optimizer dispatch regression', 'direct', 'auto-safe', 'idle', now, now);
}

test('TeamOptimizer selections become durable model/provider assignments during swarm dispatch', async () => {
  const store = new Store(':memory:');
  const queue = createQueue();
  const sessionId = 'session-team-dispatch';
  createSession(store, sessionId);

  const candidates = [
    {
      id: 'model-coding-specialist',
      model: 'model-coding-specialist',
      provider: 'provider-coding',
      healthy: true,
      capabilities: { coding: 0.98, reasoning: 0.8, speed: 0.7 },
      historyScore: 0.9,
      estimatedTokens: 10,
    },
    {
      id: 'model-generalist',
      model: 'model-generalist',
      provider: 'provider-general',
      healthy: true,
      capabilities: { coding: 0.72, reasoning: 0.75, speed: 0.8 },
      historyScore: 0.6,
      estimatedTokens: 10,
    },
  ];

  const orchestrator = new AdaptiveSwarmOrchestrator({
    store,
    jobQueue: queue,
    planner: createPlanner(),
    router: createRouter(candidates),
    teamOptimizer: new TeamOptimizer({ teamSize: 2, defaultMaxConcurrency: 2 }),
    budgetLedger: createBudgetLedger(),
  });
  const handlers = new Map();
  orchestrator.registerOnWorker({
    registerHandler(kind, handler) {
      handlers.set(kind, handler);
    },
  });

  try {
    const submitted = orchestrator.submitRun({
      sessionId,
      goal: 'dispatch independent implementation nodes',
      maxConcurrency: 2,
      nodes: [
        {
          nodeKey: 'implementation-a',
          taskType: 'implementation',
          objective: 'implement the first independent change',
          budget: { requiredCapabilities: { coding: 1 } },
        },
        {
          nodeKey: 'implementation-b',
          taskType: 'implementation',
          objective: 'implement the second independent change',
          budget: { requiredCapabilities: { coding: 1 } },
        },
      ],
    });

    const dependencyJob = queue.jobs.find((job) => job.kind === SWARM_JOB_KINDS.DEPENDENCY_RESOLVE);
    assert.ok(dependencyJob, 'submitRun must enqueue the durable dependency resolver');
    await handlers.get(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE)(dependencyJob, {});

    const afterSelection = orchestrator.getRun(submitted.runId);
    assert.equal(afterSelection.status, 'running');
    assert.deepEqual(
      afterSelection.nodes.map((node) => node.status),
      ['queued', 'queued'],
      'ready nodes must be queued by the actual dispatch selection path',
    );
    assert.deepEqual(
      afterSelection.nodes.map((node) => ({ model: node.model, provider: node.provider })),
      [
        { model: 'model-coding-specialist', provider: 'provider-coding' },
        { model: 'model-generalist', provider: 'provider-general' },
      ],
      'TeamOptimizer-selected candidates must be persisted on dispatched swarm nodes',
    );

    const teamSelections = queue.jobs.filter((job) => job.kind === SWARM_JOB_KINDS.DISPATCH);
    assert.equal(teamSelections.length, 1, 'the selected nodes must flow through one durable dispatch job');
    await handlers.get(SWARM_JOB_KINDS.DISPATCH)(teamSelections[0], {});

    const nodeJobs = queue.jobs.filter((job) => job.kind === SWARM_JOB_KINDS.NODE_EXECUTE);
    assert.deepEqual(
      nodeJobs.map((job) => job.payload.nodeKey).sort(),
      ['implementation-a', 'implementation-b'],
      'durable node-execute jobs must be created for the selected assignments',
    );
    assert.deepEqual(
      orchestrator.getRun(submitted.runId).nodes.map((node) => ({ model: node.model, provider: node.provider })),
      [
        { model: 'model-coding-specialist', provider: 'provider-coding' },
        { model: 'model-generalist', provider: 'provider-general' },
      ],
    );
  } finally {
    store.close();
  }
});

test('single-node dispatch keeps the optimizer-selected model/provider instead of router defaults', async () => {
  const store = new Store(':memory:');
  const queue = createQueue();
  const sessionId = 'session-single-dispatch';
  createSession(store, sessionId);
  const selected = {
    id: 'measured-model',
    model: 'measured-model',
    provider: 'measured-provider',
    healthy: true,
    capabilities: { coding: 0.95, reasoning: 0.95 },
    historyScore: 0.95,
    estimatedTokens: 10,
  };
  const orchestrator = new AdaptiveSwarmOrchestrator({
    store,
    jobQueue: queue,
    planner: createPlanner(),
    router: createRouter([selected]),
    teamOptimizer: new TeamOptimizer(),
    budgetLedger: createBudgetLedger(),
  });
  const handlers = new Map();
  orchestrator.registerOnWorker({ registerHandler: (kind, handler) => handlers.set(kind, handler) });

  try {
    const submitted = orchestrator.submitRun({
      sessionId,
      goal: 'dispatch one simple implementation node',
      nodes: [{
        nodeKey: 'simple-node',
        taskType: 'implementation',
        objective: 'make one change',
        budget: { requiredCapabilities: { coding: 1 } },
      }],
    });
    const dependencyJob = queue.jobs.find((job) => job.kind === SWARM_JOB_KINDS.DEPENDENCY_RESOLVE);
    await handlers.get(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE)(dependencyJob, {});
    const node = orchestrator.getRun(submitted.runId).nodes[0];
    assert.equal(node.status, 'queued');
    assert.equal(node.model, 'measured-model');
    assert.equal(node.provider, 'measured-provider');
  } finally {
    store.close();
  }
});

