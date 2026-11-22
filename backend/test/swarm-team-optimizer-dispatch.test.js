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


test('TeamOptimizer reviewer suggestions materialize one durable read-only reviewer node with evidence dependencies', async () => {
  const store = new Store(':memory:');
  const queue = createQueue();
  const sessionId = 'session-reviewer-materialization';
  createSession(store, sessionId);
  const candidates = [
    {
      id: 'worker-a', model: 'worker-a', provider: 'provider-a', healthy: true,
      capabilities: { coding: 0.95, reasoning: 0.7, research: 0.7 }, estimatedTokens: 10,
    },
    {
      id: 'worker-b', model: 'worker-b', provider: 'provider-b', healthy: true,
      capabilities: { coding: 0.9, reasoning: 0.75, research: 0.75 }, estimatedTokens: 10,
    },
    {
      id: 'reviewer-model', model: 'reviewer-model', provider: 'provider-review', role: 'reviewer', healthy: true,
      capabilities: { reasoning: 0.98, research: 0.98, coding: 0.6 }, estimatedTokens: 10,
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
  orchestrator.registerOnWorker({ registerHandler: (kind, handler) => handlers.set(kind, handler) });

  try {
    const submitted = orchestrator.submitRun({
      sessionId,
      goal: 'run independent work and independently review the evidence',
      maxConcurrency: 2,
      nodes: [
        {
          nodeKey: 'implementation-a',
          taskType: 'verification',
          objective: 'produce artifact A',
          budget: { requiredCapabilities: { coding: 1 } },
        },
        {
          nodeKey: 'implementation-b',
          taskType: 'verification',
          objective: 'produce artifact B',
          budget: { requiredCapabilities: { coding: 1 } },
        },
      ],
    });
    const dependencyJob = queue.jobs.find((job) => job.kind === SWARM_JOB_KINDS.DEPENDENCY_RESOLVE);
    await handlers.get(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE)(dependencyJob, {});

    const run = orchestrator.getRun(submitted.runId);
    const reviewer = run.nodes.find((node) => node.taskType === 'review');
    assert.ok(reviewer, 'optimizer reviewer suggestion must be materialized as a durable node');
    assert.equal(reviewer.status, 'pending');
    assert.equal(reviewer.model, 'reviewer-model');
    assert.equal(reviewer.provider, 'provider-review');
    assert.deepEqual(reviewer.dependencies, ['implementation-a', 'implementation-b']);
    assert.deepEqual(reviewer.toolAllow.sort(), ['glob', 'grep', 'read_blob', 'read_file', 'read_swarm_artifact']);
    const reviewBudget = JSON.parse(reviewer.budgetJson);
    assert.equal(reviewBudget.reviewerMetadata.autoMaterialized, true);
    assert.deepEqual(reviewBudget.reviewerMetadata.sourceNodeKeys, ['implementation-a', 'implementation-b']);
    assert.match(reviewer.objective, /独立审查/);

    const sameAgain = await handlers.get(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE)(dependencyJob, {});
    assert.equal(sameAgain, undefined);
    const reviewerRows = store.db
      .prepare("SELECT nodeKey FROM swarm_nodes WHERE runId=? AND taskType='review'")
      .all(submitted.runId);
    assert.equal(reviewerRows.length, 1, 'dependency resolver retries must not duplicate the reviewer node');
  } finally {
    store.close();
  }
});

test('auto-materialized reviewer waits for terminal worker nodes and can review failed evidence without being blocked', async () => {
  const store = new Store(':memory:');
  const queue = createQueue();
  const sessionId = 'session-reviewer-failed-evidence';
  createSession(store, sessionId);
  const candidates = [
    { id: 'worker-a', model: 'worker-a', provider: 'provider-a', healthy: true, capabilities: { coding: 0.95 }, estimatedTokens: 10 },
    { id: 'worker-b', model: 'worker-b', provider: 'provider-b', healthy: true, capabilities: { coding: 0.9 }, estimatedTokens: 10 },
    { id: 'reviewer-model', model: 'reviewer-model', provider: 'provider-review', role: 'reviewer', healthy: true, capabilities: { reasoning: 0.98, research: 0.98 }, estimatedTokens: 10 },
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
  orchestrator.registerOnWorker({ registerHandler: (kind, handler) => handlers.set(kind, handler) });

  try {
    const submitted = orchestrator.submitRun({
      sessionId,
      goal: 'review terminal worker evidence',
      maxConcurrency: 2,
      nodes: [
        { nodeKey: 'implementation-a', taskType: 'verification', objective: 'worker A', budget: { requiredCapabilities: { coding: 1 } } },
        { nodeKey: 'implementation-b', taskType: 'verification', objective: 'worker B', budget: { requiredCapabilities: { coding: 1 } } },
      ],
    });
    const dependencyJob = queue.jobs.find((job) => job.kind === SWARM_JOB_KINDS.DEPENDENCY_RESOLVE);
    await handlers.get(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE)(dependencyJob, {});
    const run = orchestrator.getRun(submitted.runId);
    const reviewer = run.nodes.find((node) => node.taskType === 'review');
    const workerA = run.nodes.find((node) => node.nodeKey === 'implementation-a');
    const workerB = run.nodes.find((node) => node.nodeKey === 'implementation-b');
    assert.ok(reviewer);

    store.db.prepare("UPDATE swarm_nodes SET status='failed', errorCode='WORKER_FAILED' WHERE id=?").run(workerA.id);
    store.db.prepare("UPDATE swarm_nodes SET status='completed', resultText='artifact B' WHERE id=?").run(workerB.id);
    const secondResolve = {
      ...dependencyJob,
      id: 'resolve-after-terminal-workers',
      payload: { ...dependencyJob.payload, epoch: 2 },
    };
    await handlers.get(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE)(secondResolve, {});
    assert.equal(orchestrator.getRun(submitted.runId).nodes.find((node) => node.id === reviewer.id).status, 'queued');
  } finally {
    store.close();
  }
});

test('reviewer evidence context is composed from durable artifact, receipt, and turn verdict rows', async () => {
  const store = new Store(':memory:');
  const queue = createQueue();
  const sessionId = 'session-reviewer-evidence-context';
  createSession(store, sessionId);
  const candidates = [
    { id: 'worker-a', model: 'worker-a', provider: 'provider-a', healthy: true, capabilities: { coding: 0.95 }, estimatedTokens: 10 },
    { id: 'worker-b', model: 'worker-b', provider: 'provider-b', healthy: true, capabilities: { coding: 0.9 }, estimatedTokens: 10 },
    { id: 'reviewer-model', model: 'reviewer-model', provider: 'provider-review', role: 'reviewer', healthy: true, capabilities: { reasoning: 0.98, research: 0.98 }, estimatedTokens: 10 },
  ];
  let spawnRequest = null;
  const childManager = {
    async spawn(options) {
      spawnRequest = options;
      return { status: 'paused', childSessionId: 'review-child', childTurnId: 'review-turn' };
    },
  };
  const orchestrator = new AdaptiveSwarmOrchestrator({
    store,
    jobQueue: queue,
    planner: createPlanner(),
    router: createRouter(candidates),
    teamOptimizer: new TeamOptimizer({ teamSize: 2, defaultMaxConcurrency: 2 }),
    budgetLedger: createBudgetLedger(),
    childManager,
  });
  const handlers = new Map();
  orchestrator.registerOnWorker({ registerHandler: (kind, handler) => handlers.set(kind, handler) });

  try {
    const submitted = orchestrator.submitRun({
      sessionId,
      goal: 'compose evidence context for reviewer',
      maxConcurrency: 2,
      nodes: [
        { nodeKey: 'implementation-a', taskType: 'verification', objective: 'worker A', budget: { requiredCapabilities: { coding: 1 } } },
        { nodeKey: 'implementation-b', taskType: 'verification', objective: 'worker B', budget: { requiredCapabilities: { coding: 1 } } },
      ],
    });
    const dependencyJob = queue.jobs.find((job) => job.kind === SWARM_JOB_KINDS.DEPENDENCY_RESOLVE);
    await handlers.get(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE)(dependencyJob, {});
    let run = orchestrator.getRun(submitted.runId);
    const workerNodes = run.nodes.filter((node) => node.taskType !== 'review');
    const reviewer = run.nodes.find((node) => node.taskType === 'review');
    assert.equal(workerNodes.length, 2);

    createSession(store, 'worker-session-a');
    createSession(store, 'worker-session-b');
    store.db.prepare("UPDATE swarm_nodes SET status='completed', childSessionId='worker-session-a', childTurnId='worker-turn-a', artifactUrisJson='[\\\"swarm-artifact://artifact-a\\\"]' WHERE id=?").run(workerNodes[0].id);
    store.db.prepare("UPDATE swarm_nodes SET status='completed', childSessionId='worker-session-b', childTurnId='worker-turn-b', artifactUrisJson='[\\\"swarm-artifact://artifact-b\\\"]' WHERE id=?").run(workerNodes[1].id);
    store.db.prepare("INSERT INTO direct_turns(id,sessionId,input,state,phase,step,agentProfile,verdictJson,evidenceCount,createdAt,finishedAt) VALUES('worker-turn-a','worker-session-a','a','completed','done',1,'worker','{\"verdict\":\"pass\",\"accepted\":true}',2,1,2)").run();
    store.db.prepare("INSERT INTO direct_turns(id,sessionId,input,state,phase,step,agentProfile,verdictJson,evidenceCount,createdAt,finishedAt) VALUES('worker-turn-b','worker-session-b','b','completed','done',1,'worker','{\"verdict\":\"fail\",\"accepted\":false}',1,1,2)").run();
    store.db.prepare("INSERT INTO tool_receipts(id,sessionId,turnId,callId,toolName,riskLevel,effectClass,replayable,outward,argsDigest,status,createdAt,updatedAt) VALUES('receipt-a','worker-session-a','worker-turn-a','call-a','bash','low','read_only',1,0,'digest-a','finished',1,2)").run();
    store.db.prepare("INSERT INTO tool_receipts(id,sessionId,turnId,callId,toolName,riskLevel,effectClass,replayable,outward,argsDigest,status,createdAt,updatedAt) VALUES('receipt-b','worker-session-b','worker-turn-b','call-b','bash','low','read_only',1,0,'digest-b','failed',1,2)").run();
    store.db.prepare("INSERT INTO swarm_artifacts(id,uri,runId,nodeId,nodeKey,ownerId,workspaceRoot,storagePath,bundleSha256,manifestJson,createdAt,updatedAt) VALUES('artifact-a','swarm-artifact://artifact-a',?,?,'implementation-a','worker-a','D:/workspace','D:/artifact-a','sha-a','{}',1,2)").run(submitted.runId, workerNodes[0].id);
    store.db.prepare("INSERT INTO swarm_artifacts(id,uri,runId,nodeId,nodeKey,ownerId,workspaceRoot,storagePath,bundleSha256,manifestJson,createdAt,updatedAt) VALUES('artifact-b','swarm-artifact://artifact-b',?,?,'implementation-b','worker-b','D:/workspace','D:/artifact-b','sha-b','{}',1,2)").run(submitted.runId, workerNodes[1].id);

    const reviewJob = queue.jobs.find((job) => job.kind === SWARM_JOB_KINDS.NODE_EXECUTE && job.payload.nodeKey === reviewer.nodeKey);
    assert.equal(reviewJob, undefined, 'reviewer is not executable until dependencies settle');
    const secondResolve = { ...dependencyJob, id: 'resolve-reviewer-context', payload: { ...dependencyJob.payload, epoch: 3 } };
    await handlers.get(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE)(secondResolve, {});
    run = orchestrator.getRun(submitted.runId);
    assert.equal(run.nodes.find((node) => node.id === reviewer.id).status, 'queued');
    const dispatchJob = queue.jobs.find((job) => job.kind === SWARM_JOB_KINDS.DISPATCH && job.payload.nodeKeys.includes(reviewer.nodeKey));
    assert.ok(dispatchJob);
    await handlers.get(SWARM_JOB_KINDS.DISPATCH)(dispatchJob, {});
    const reviewerJob = queue.jobs.find((job) => job.kind === SWARM_JOB_KINDS.NODE_EXECUTE && job.payload.nodeKey === reviewer.nodeKey);
    assert.ok(reviewerJob);
    await handlers.get(SWARM_JOB_KINDS.NODE_EXECUTE)(reviewerJob, { signal: new AbortController().signal });
    assert.equal(spawnRequest.model, 'reviewer-model');
    assert.match(spawnRequest.objective, /Durable evidence manifest/);
    assert.match(spawnRequest.objective, /artifact-a/);
    assert.match(spawnRequest.objective, /receipt-b/);
    assert.match(spawnRequest.objective, /worker-turn-b/);
    assert.match(spawnRequest.objective, /read_swarm_artifact/);
    assert.deepEqual(spawnRequest.allowedTools.sort(), ['glob', 'grep', 'read_blob', 'read_file', 'read_swarm_artifact']);
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

test('single-model candidate pool still dispatches parallel ready nodes concurrently when budget allows', async () => {
  const store = new Store(':memory:');
  const queue = createQueue();
  const sessionId = 'session-single-model-parallel';
  createSession(store, sessionId);
  const candidates = [
    {
      id: 'only-model',
      model: 'only-model',
      provider: 'only-provider',
      healthy: true,
      capabilities: { coding: 0.9, reasoning: 0.85 },
      historyScore: 0.8,
      estimatedTokens: 100,
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
  orchestrator.registerOnWorker({ registerHandler: (kind, handler) => handlers.set(kind, handler) });

  try {
    const submitted = orchestrator.submitRun({
      sessionId,
      goal: 'dispatch two parallel branches on a single available model',
      maxConcurrency: 2,
      nodes: [
        { nodeKey: 'branch-a', taskType: 'implementation', objective: 'work A' },
        { nodeKey: 'branch-b', taskType: 'implementation', objective: 'work B' },
      ],
    });
    const dependencyJob = queue.jobs.find((job) => job.kind === SWARM_JOB_KINDS.DEPENDENCY_RESOLVE);
    await handlers.get(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE)(dependencyJob, {});
    const run = orchestrator.getRun(submitted.runId);
    assert.deepEqual(
      run.nodes.map((node) => node.status),
      ['queued', 'queued'],
      'both independent branches must dispatch concurrently when budget allows',
    );
  } finally {
    store.close();
  }
});

test('tight token budget downgrade throttles parallel dispatch to one node at a time', async () => {
  const store = new Store(':memory:');
  const queue = createQueue();
  const sessionId = 'session-budget-throttle';
  createSession(store, sessionId);
  const candidates = [
    { id: 'worker-a', model: 'worker-a', provider: 'p-a', healthy: true, capabilities: { coding: 0.9 }, estimatedTokens: 100 },
    { id: 'worker-b', model: 'worker-b', provider: 'p-b', healthy: true, capabilities: { coding: 0.85 }, estimatedTokens: 100 },
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
  orchestrator.registerOnWorker({ registerHandler: (kind, handler) => handlers.set(kind, handler) });

  try {
    const submitted = orchestrator.submitRun({
      sessionId,
      goal: 'throttle team when token budget only covers one worker',
      maxConcurrency: 2,
      budget: { maxTotalTokens: 120 },
      nodes: [
        { nodeKey: 'branch-a', taskType: 'implementation', objective: 'work A' },
        { nodeKey: 'branch-b', taskType: 'implementation', objective: 'work B' },
      ],
    });
    const dependencyJob = queue.jobs.find((job) => job.kind === SWARM_JOB_KINDS.DEPENDENCY_RESOLVE);
    await handlers.get(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE)(dependencyJob, {});
    const statuses = orchestrator.getRun(submitted.runId).nodes.map((node) => node.status).sort();
    assert.deepEqual(statuses, ['queued', 'ready']);
  } finally {
    store.close();
  }
});

test('auto-materialized reviewer remains ready across repeated resolve passes when an upstream worker failed', async () => {
  const store = new Store(':memory:');
  const queue = createQueue();
  const sessionId = 'session-reviewer-stay-ready';
  createSession(store, sessionId);
  const candidates = [
    { id: 'worker-a', model: 'worker-a', provider: 'p-a', healthy: true, capabilities: { coding: 0.95 }, estimatedTokens: 10 },
    { id: 'worker-b', model: 'worker-b', provider: 'p-b', healthy: true, capabilities: { coding: 0.9 }, estimatedTokens: 10 },
    { id: 'reviewer-model', model: 'reviewer-model', provider: 'p-r', role: 'reviewer', healthy: true, capabilities: { reasoning: 0.98, research: 0.98 }, estimatedTokens: 10 },
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
  orchestrator.registerOnWorker({ registerHandler: (kind, handler) => handlers.set(kind, handler) });

  try {
    const submitted = orchestrator.submitRun({
      sessionId,
      goal: 'keep auto reviewer ready even if one upstream worker failed',
      maxConcurrency: 2,
      nodes: [
        { nodeKey: 'implementation-a', taskType: 'verification', objective: 'worker A', priority: 10 },
        { nodeKey: 'implementation-b', taskType: 'verification', objective: 'worker B', priority: 10 },
        { nodeKey: 'other-worker', taskType: 'research', objective: 'independent busy worker', priority: 1 },
      ],
    });
    const dependencyJob = queue.jobs.find((job) => job.kind === SWARM_JOB_KINDS.DEPENDENCY_RESOLVE);
    await handlers.get(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE)(dependencyJob, {});
    const run = orchestrator.getRun(submitted.runId);
    const reviewer = run.nodes.find((node) => node.taskType === 'review');
    const workerA = run.nodes.find((node) => node.nodeKey === 'implementation-a');
    const workerB = run.nodes.find((node) => node.nodeKey === 'implementation-b');
    const otherWorker = run.nodes.find((node) => node.nodeKey === 'other-worker');

    store.db.prepare("UPDATE swarm_nodes SET status='failed', errorCode='WORKER_FAILED' WHERE id=?").run(workerA.id);
    store.db.prepare("UPDATE swarm_nodes SET status='completed', resultText='ok' WHERE id=?").run(workerB.id);
    // Simulate reviewer already READY while dispatch slots are 0 (other-worker running with maxConcurrency=1)
    store.db.prepare("UPDATE swarm_nodes SET status='ready' WHERE id=?").run(reviewer.id);
    store.db.prepare("UPDATE swarm_runs SET strategyJson=? WHERE id=?").run(
      JSON.stringify({ maxConcurrency: 1, maxReplans: 2 }),
      submitted.runId,
    );
    store.db.prepare("UPDATE swarm_nodes SET status='running' WHERE id=?").run(otherWorker.id);

    await handlers.get(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE)({
      ...dependencyJob,
      id: 'resolve-keep-ready-while-busy',
      payload: { ...dependencyJob.payload, epoch: 8 },
    }, {});
    // Must stay READY rather than being demoted back to PENDING when workerA failed!
    assert.equal(orchestrator.getRun(submitted.runId).nodes.find((n) => n.id === reviewer.id).status, 'ready');

    store.db.prepare("UPDATE swarm_nodes SET status='completed', resultText='ok' WHERE id=?").run(otherWorker.id);
    await handlers.get(SWARM_JOB_KINDS.DEPENDENCY_RESOLVE)({
      ...dependencyJob,
      id: 'resolve-keep-ready',
      payload: { ...dependencyJob.payload, epoch: 9 },
    }, {});
    assert.equal(orchestrator.getRun(submitted.runId).nodes.find((n) => n.id === reviewer.id).status, 'queued');
  } finally {
    store.close();
  }
});

