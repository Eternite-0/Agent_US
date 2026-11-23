import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { createIntelligenceServices } from '../src/intelligence-services.js';
import { v1Routes } from '../src/v1-routes.js';
import { BENCHMARK_ID } from '../src/evaluation/service.js';
import { rmDirSafe } from './fixtures.js';

const waitTurnDone = (directAgent, _sessionId, turnId, timeoutMs = 10_000) =>
  directAgent.waitForTurnTerminal(turnId, { timeoutMs });

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
  }
  async *stream(opts) {
    yield* this.handler(opts);
  }
}

function initGitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Project\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@agent-us.invalid'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Agent_US Test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir, stdio: 'ignore' });
}

test('explicit autonomous goal routes through Planner, Validator, Swarm, TeamOptimizer, ChildAgent, and Verifier while leaving normal chat untouched', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-auto-entry-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-auto-entry-work-'));
  initGitRepo(workDir);

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'custom-openai',
    label: 'Test Pool',
    endpoint: 'https://api.example.invalid/v1',
    credential: 'sk-test-autonomous-entry',
    models: ['model-coder', 'reviewer-model'],
  });
  pool.setDefaultModel('model-coder');

  const adapter = new ScriptedAdapter(async function* (opts) {
    const messages = opts.messages ?? [];
    const sysText = messages.find((m) => m.role === 'system')?.content?.[0]?.text ?? '';
    const userTexts = messages.filter((m) => m.role === 'user').map((m) => m.content?.[0]?.text ?? '').join('\n');
    const lastRole = messages.at(-1)?.role;

    if (sysText.includes('Decompose the engineering goal')) {
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          nodes: [
            {
              nodeKey: 'research-step',
              taskType: 'research',
              objective: 'Inspect README before editing',
              acceptance: 'Identify repository entry',
              dependencies: [],
              isolatedWorktree: false,
              priority: 20,
            },
            {
              nodeKey: 'implement-step',
              taskType: 'implementation',
              objective: 'Write src/feature.js in isolated worktree',
              acceptance: 'src/feature.js created',
              dependencies: ['research-step'],
              isolatedWorktree: true,
              priority: 10,
            },
            {
              nodeKey: 'verify-step',
              taskType: 'verification',
              objective: 'Verify implementation artifact',
              acceptance: 'Artifact verified',
              dependencies: ['implement-step'],
              isolatedWorktree: false,
              priority: 5,
            },
          ],
        }),
      };
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 18 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (userTexts.includes('Write src/feature.js') && lastRole !== 'tool') {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-auto-write',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'src/feature.js', content: 'export const ready = true;\n' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    if (userTexts.includes('Verify implementation artifact') && lastRole !== 'tool') {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-auto-read-art',
          name: 'read_swarm_artifact',
          arguments: JSON.stringify({ nodeKey: 'implement-step', path: 'src/feature.js' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    yield { type: 'text-delta', index: 0, text: `OK:${userTexts.slice(-40)}` };
    yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const directAgent = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });
  const intelligence = createIntelligenceServices({ store, directAgent });
  directAgent.attachIntelligenceServices(intelligence);

  const app = Fastify();
  v1Routes(app, { store, providers: { models: [] }, pool, directAgent, intelligence });
  await app.ready();

  t.after(async () => {
    await intelligence.evaluation.close({ timeoutMs: 500 });
    await app.close();
    await directAgent.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  // 1. Ordinary direct chat MUST keep direct semantics and create zero swarm runs
  const chatSession = directAgent.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
  const chatRes = await app.inject({
    method: 'POST',
    url: `/v1/sessions/${chatSession.id}/turns`,
    payload: { input: 'Just answer a quick question without creating a swarm' },
  });
  assert.equal(chatRes.statusCode, 200);
  const doneChat = await waitTurnDone(directAgent, chatSession.id, chatRes.json().turn.id);
  assert.equal(doneChat.state, 'completed');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM swarm_runs').get().n, 0);

  // 2. Explicit autonomous goal entry executes full Planner -> Swarm -> Artifact -> Verifier flow
  const autoRes = await app.inject({
    method: 'POST',
    url: '/v1/autonomous/runs',
    payload: {
      goal: 'Implement feature module and verify artifact',
      workspaceRoot: workDir,
      permissionMode: 'auto-safe',
      maxConcurrency: 2,
      budget: { maxTotalTokens: 20_000, maxSteps: 20 },
      wait: true,
    },
  });
  assert.equal(autoRes.statusCode, 201);
  const autoBody = autoRes.json();
  assert.equal(autoBody.status, 'completed');
  assert.ok(autoBody.plan);
  assert.deepEqual(autoBody.plan.tasks.map((tItem) => tItem.taskKey), [
    'research-step',
    'implement-step',
    'verify-step',
  ]);
  const run = directAgent.swarmOrchestrator.getRun(autoBody.runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.nodes.find((n) => n.nodeKey === 'research-step').permissionMode, 'read-only');
  const implNode = run.nodes.find((n) => n.nodeKey === 'implement-step');
  assert.equal(implNode.isolationMode, 'worktree');
  assert.ok(implNode.latestArtifactId);
  assert.equal(autoBody.budgetLedger.reservedSteps, 0);
  assert.equal(autoBody.budgetLedger.reservedTokens, 0);
});

test('planned swarm enforces permission inheritance, dynamic model replacement, and artifact retention', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-auto-replan-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-auto-replan-work-'));
  initGitRepo(workDir);

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'custom-openai',
    label: 'Multi Model',
    endpoint: 'https://api.example.invalid/v1',
    credential: 'sk-test-model-switch',
    models: ['model-a', 'model-b'],
  });
  pool.setDefaultModel('model-a');

  let modelAFails = 0;
  const adapter = new ScriptedAdapter(async function* (opts) {
    const messages = opts.messages ?? [];
    const userTexts = messages.filter((m) => m.role === 'user').map((m) => m.content?.[0]?.text ?? '').join('\n');
    const lastRole = messages.at(-1)?.role;

    if (userTexts.includes('Step 1 worktree') && lastRole !== 'tool') {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-step1',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'src/step1.js', content: 'export const s1 = 1;\n' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    if (userTexts.includes('Step 2 replannable') && opts.model === 'model-a') {
      modelAFails++;
      throw Object.assign(new Error('model-a transient failure'), { code: 'PROVIDER_TIMEOUT', retryable: false });
    }

    yield { type: 'text-delta', index: 0, text: `Done on ${opts.model}` };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const directAgent = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });
  const intelligence = createIntelligenceServices({ store, directAgent });
  directAgent.attachIntelligenceServices(intelligence);

  const app = Fastify();
  v1Routes(app, { store, providers: { models: [] }, pool, directAgent, intelligence });
  await app.ready();

  t.after(async () => {
    await intelligence.evaluation.close({ timeoutMs: 500 });
    await app.close();
    await directAgent.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  // Escalation from readonly session to full plan MUST be rejected
  const roSession = directAgent.createSession({ workspaceRoot: workDir, permissionMode: 'read-only' });
  const escalated = await app.inject({
    method: 'POST',
    url: '/v1/plans/execute',
    payload: {
      sessionId: roSession.id,
      plan: {
        planVersion: 1,
        goal: 'Attempt permission escalation',
        permissionMode: 'full',
        tasks: [
          { taskKey: 'escalate', objective: 'Try full', acceptance: 'blocked', taskType: 'implementation', permissionMode: 'full' },
        ],
      },
    },
  });
  assert.equal(escalated.statusCode, 400);
  assert.equal(escalated.json().code, 'PLANNER_PERMISSION_ESCALATION');

  // Valid plan: step1 produces durable artifact, step2 switches model on failure while retaining step1 artifact
  const rwSession = directAgent.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
  const execRes = await app.inject({
    method: 'POST',
    url: '/v1/plans/execute',
    payload: {
      sessionId: rwSession.id,
      maxReplans: 3,
      plan: {
        planVersion: 1,
        goal: 'Retain artifact across model switch replan',
        permissionMode: 'auto-safe',
        budget: { maxSteps: 20, maxTotalTokens: 20_000 },
        tasks: [
          {
            taskKey: 'step1',
            objective: 'Step 1 worktree artifact',
            acceptance: 'Artifact created',
            taskType: 'implementation',
            permissionMode: 'auto-safe',
            budget: { maxSteps: 6 },
            metadata: { isolatedWorktree: true },
          },
          {
            taskKey: 'step2',
            objective: 'Step 2 replannable readonly',
            acceptance: 'Switches model on failure',
            taskType: 'research',
            permissionMode: 'readonly',
            dependencies: ['step1'],
            budget: { maxSteps: 6 },
          },
        ],
      },
    },
  });
  assert.equal(execRes.statusCode, 202);
  const settled = await directAgent.swarmOrchestrator.waitForRun(execRes.json().runId, { timeoutMs: 12_000 });
  assert.equal(settled.status, 'completed');
  assert.ok(modelAFails >= 1);
  const replans = directAgent.swarmOrchestrator.listReplans(execRes.json().runId);
  assert.ok(replans.some((r) => r.strategy === 'switch_model'));

  const step1Node = settled.nodes.find((n) => n.nodeKey === 'step1');
  const step2Node = settled.nodes.find((n) => n.nodeKey === 'step2');
  assert.equal(step2Node.permissionMode, 'read-only');
  assert.equal(step2Node.model, 'model-b');
  assert.ok(step1Node.latestArtifactId);
  assert.equal(directAgent.artifactManager.verifyArtifact(step1Node.latestArtifactId).ok, true);
});

test('execution memory candidates are extracted, sanitized, deduplicated, project-isolated, used by ContextAssembler, and only verified via trusted Evaluation', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-auto-mem-data-'));
  const workDirA = mkdtempSync(join(tmpdir(), 'agent-us-auto-mem-projA-'));
  const workDirB = mkdtempSync(join(tmpdir(), 'agent-us-auto-mem-projB-'));
  initGitRepo(workDirA);
  initGitRepo(workDirB);

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mem-model');

  const seenRequests = [];
  const adapter = new ScriptedAdapter(async function* (opts) {
    const messages = opts.messages ?? [];
    seenRequests.push({
      model: opts.model,
      system: messages.find((m) => m.role === 'system')?.content?.[0]?.text ?? '',
      fullText: messages.map((m) => m.content?.map((c) => c.text).join('') ?? '').join('\n'),
    });
    const userText = messages.filter((m) => m.role === 'user').map((m) => m.content?.[0]?.text ?? '').join('\n');
    const lastRole = messages.at(-1)?.role;

    if (userText.includes('EMIT_DIRECT_CANDIDATE')) {
      yield {
        type: 'text-delta',
        index: 0,
        text: '[lesson] Prefer sqlite WAL checkpoints; api_key=sk-projA-topsecret12345678',
      };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (userText.includes('CREATE_WORKTREE_CANDIDATE') && lastRole !== 'tool') {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-mem-wt',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'src/wal.js', content: 'export const wal = true;\n' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    yield { type: 'text-delta', index: 0, text: 'Completed verified task' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const directAgent = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDirA,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });
  const intelligence = createIntelligenceServices({ store, directAgent });
  directAgent.attachIntelligenceServices(intelligence);

  const app = Fastify();
  v1Routes(app, { store, providers: { models: [] }, pool, directAgent, intelligence });
  await app.ready();

  t.after(async () => {
    await intelligence.evaluation.close({ timeoutMs: 500 });
    await app.close();
    await directAgent.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDirA);
    rmDirSafe(workDirB);
  });

  // 1. DirectAgent turn extracts candidate, redacts secrets, deduplicates on repeat, stays unverified
  const sessA = directAgent.createSession({ workspaceRoot: workDirA, permissionMode: 'auto-safe' });
  const t1 = directAgent.startTurn(sessA.id, { input: 'EMIT_DIRECT_CANDIDATE #1' });
  await waitTurnDone(directAgent, sessA.id, t1.turn.id);
  const t2 = directAgent.startTurn(sessA.id, { input: 'EMIT_DIRECT_CANDIDATE #2' });
  await waitTurnDone(directAgent, sessA.id, t2.turn.id);

  const memA = intelligence.memory.retrieve({ projectId: workDirA, query: 'sqlite WAL checkpoints', limit: 10, tokenBudget: 5000 });
  assert.equal(memA.items.length, 1, 'duplicate execution candidate must be deduplicated');
  assert.equal(memA.items[0].verified, false, 'auto-extracted candidate must never be auto-verified');
  assert.equal(memA.items[0].scopeType, 'direct_turn');
  assert.ok(memA.items[0].metadata.sourceTaskId);
  assert.doesNotMatch(memA.items[0].content, /sk-projA-topsecret12345678/);

  // 2. Swarm run in workDirA extracts traceable artifact-backed candidate
  const swarmOut = await directAgent.swarmOrchestrator.startRun({
    sessionId: sessA.id,
    goal: 'Build WAL checkpoint helper',
    workspaceRoot: workDirA,
    nodes: [{ nodeKey: 'impl-wal', taskType: 'implementation', objective: 'CREATE_WORKTREE_CANDIDATE', isolationMode: 'worktree' }],
  });
  assert.equal(swarmOut.status, 'completed');
  const memSwarm = intelligence.memory.retrieve({ projectId: workDirA, query: 'Build WAL checkpoint helper', limit: 10, tokenBudget: 5000 });
  const swarmCandidate = memSwarm.items.find((item) => item.scopeType === 'swarm_run');
  assert.ok(swarmCandidate);
  assert.equal(swarmCandidate.verified, false);
  assert.equal(swarmCandidate.scopeId, swarmOut.runId);
  assert.ok(swarmCandidate.metadata.artifactUris.length >= 1);

  // 3. Ordinary API cannot grant verified
  const forgeRes = await app.inject({
    method: 'POST',
    url: `/v1/memory/experience/${memA.items[0].id}/feedback`,
    payload: { projectId: workDirA, action: 'verify' },
  });
  assert.equal(forgeRes.statusCode, 403);

  // 4. Pre-verification gate: sessA shares prior turn messages, while a fresh ChildAgent does NOT receive unverified memory via ContextAssembler
  const reqIdxBeforeFollowUp = seenRequests.length;
  const tFollow = directAgent.startTurn(sessA.id, { input: 'Apply sqlite WAL checkpoints strategy' });
  await waitTurnDone(directAgent, sessA.id, tFollow.turn.id);
  assert.match(seenRequests[reqIdxBeforeFollowUp].fullText, /Prefer sqlite WAL checkpoints/);

  const reqIdxBeforeChildUnverified = seenRequests.length;
  await directAgent.swarmOrchestrator.startRun({
    sessionId: sessA.id,
    goal: 'Check child context assembly memory before verification',
    workspaceRoot: workDirA,
    nodes: [{ nodeKey: 'reader', taskType: 'research', objective: 'Use sqlite WAL checkpoints in child' }],
  });
  assert.doesNotMatch(seenRequests[reqIdxBeforeChildUnverified].fullText, /Prefer sqlite WAL checkpoints/);

  // 5. Trusted upgrade requires matching projectId + completed synthetic Evaluation + passing sourceTaskId
  store.add('evaluation_runs', {
    id: 'eval-trust-ok',
    projectId: workDirA,
    status: 'completed',
    synthetic: true,
    score: { total: 1, passed: 1, failed: 0, cancelled: 0, timedOut: 0 },
    results: [{ taskId: 'task-real-1', status: 'passed', passed: true }],
  }, null, null, 'eval-trust-ok');
  const verifier = intelligence.memory.createTrustedVerifier();
  assert.throws(
    () => verifier({
      id: memA.items[0].id,
      projectId: workDirA,
      sourceTaskId: 'unrelated-task',
      evaluationRunId: 'eval-trust-ok',
      evidence: { projectId: workDirA, sourceTaskId: 'unrelated-task', evaluationRunId: 'eval-trust-ok' },
    }),
    /completed evaluation run/,
  );
  const upgraded = verifier({
    id: memA.items[0].id,
    projectId: workDirA,
    sourceTaskId: 'task-real-1',
    evaluationRunId: 'eval-trust-ok',
    evidence: { projectId: workDirA, sourceTaskId: 'task-real-1', evaluationRunId: 'eval-trust-ok', score: { total: 1, passed: 1, failed: 0, cancelled: 0, timedOut: 0 } },
  });
  assert.equal(upgraded.verified, true);

  // 6. Post-verification retrieval & Project B isolation: fresh DirectAgent session and ChildAgent in Project A receive verified memory; Project B stays isolated
  const sessA2 = directAgent.createSession({ workspaceRoot: workDirA, permissionMode: 'auto-safe' });
  const reqIdxBeforeA2 = seenRequests.length;
  const tA2 = directAgent.startTurn(sessA2.id, { input: 'Apply sqlite WAL checkpoints strategy' });
  await waitTurnDone(directAgent, sessA2.id, tA2.turn.id);
  assert.match(seenRequests[reqIdxBeforeA2].fullText, /Prefer sqlite WAL checkpoints/);

  const reqIdxBeforeChildVerified = seenRequests.length;
  await directAgent.swarmOrchestrator.startRun({
    sessionId: sessA.id,
    goal: 'Check child context assembly memory after verification',
    workspaceRoot: workDirA,
    nodes: [{ nodeKey: 'reader', taskType: 'research', objective: 'Use sqlite WAL checkpoints in child' }],
  });
  assert.match(seenRequests[reqIdxBeforeChildVerified].fullText, /Prefer sqlite WAL checkpoints/);

  const sessB = directAgent.createSession({ workspaceRoot: workDirB, permissionMode: 'auto-safe' });
  const reqIdxBeforeB = seenRequests.length;
  const tB = directAgent.startTurn(sessB.id, { input: 'Apply sqlite WAL checkpoints strategy' });
  await waitTurnDone(directAgent, sessB.id, tB.turn.id);
  assert.doesNotMatch(seenRequests[reqIdxBeforeB].fullText, /Prefer sqlite WAL checkpoints/, 'Project B must remain isolated from Project A memory');
});

test('measured capability is derived from evaluation results and stays independent of provider account health', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-cap-health-data-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  const account = pool.createAccount({
    preset: 'custom-openai',
    label: 'Health vs Capability',
    endpoint: 'https://api.example.invalid/v1',
    credential: 'sk-test-cap-health',
    models: ['eval-model'],
  });
  pool.setDefaultModel('eval-model');

  let shouldPass = true;
  const services = createIntelligenceServices({ store, providers: { models: [] } });
  const evalService = new (services.evaluation.constructor)({
    store,
    capabilityRegistry: services.capabilityRegistry,
    memory: services.memory,
    runtimeFactory: async ({ task }) => {
      if (shouldPass) return { output: task.expected.output };
      return { output: { wrong: true } };
    },
    timeoutMs: 2_000,
  });

  const { ModelCapabilityRegistry, AgentCapabilityRegistry } = await import('../src/swarm/capabilities.js');
  const { AdaptiveModelRouter } = await import('../src/swarm/router.js');
  const router = new AdaptiveModelRouter({
    modelRegistry: new ModelCapabilityRegistry(pool),
    agentRegistry: new AgentCapabilityRegistry(),
    pool,
    capabilityRegistry: services.capabilityRegistry,
  });

  t.after(async () => {
    await evalService.close({ timeoutMs: 500 });
    await services.evaluation.close({ timeoutMs: 500 });
    store.close();
    rmDirSafe(dataDir);
  });

  services.capabilityRegistry.registerDeclared({
    id: 'eval-model',
    capabilities: { coding: 0.9, reasoning: 0.9, research: 0.9, planning: 0.9 },
  });

  // 1. Passing evaluation writes evaluation-backed measured capability
  const passRun = evalService.start({
    benchmarkId: BENCHMARK_ID,
    taskIds: ['code-generation-repair-01', 'unfamiliar-codebase-analysis-01'],
    model: 'eval-model',
    concurrency: 1,
  });
  for (let i = 0; i < 100; i++) {
    if (evalService.getRun(passRun.id)?.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 15));
  }
  const passMeasured = services.capabilityRegistry.getMeasured('eval-model');
  assert.ok(passMeasured);
  assert.equal(passMeasured.evaluation.evaluationRunId, passRun.id);
  assert.equal(passMeasured.empiricalScore, 1);
  assert.equal(passMeasured.capabilities.coding, 1);

  // 2. Disabling provider account flips providerHealthy to false without erasing measured capability
  pool.updateAccount(account.id, { enabled: false });
  const routeWhenDown = router.select({ taskType: 'implementation' });
  assert.equal(routeWhenDown.explanation.candidates[0].providerHealthy, false);
  assert.equal(services.capabilityRegistry.getMeasured('eval-model').empiricalScore, 1);

  // 3. Re-enabling provider account keeps provider healthy even if an evaluation run scores 0
  pool.updateAccount(account.id, { enabled: true });
  shouldPass = false;
  const failRun = evalService.start({
    benchmarkId: BENCHMARK_ID,
    taskIds: ['code-generation-repair-01'],
    model: 'eval-model',
    concurrency: 1,
  });
  for (let i = 0; i < 100; i++) {
    if (evalService.getRun(failRun.id)?.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 15));
  }
  const failMeasured = services.capabilityRegistry.getMeasured('eval-model');
  assert.equal(failMeasured.evaluation.evaluationRunId, failRun.id);
  assert.equal(failMeasured.empiricalScore, 0);
  assert.equal(failMeasured.capabilities.coding, 0, 'measured capability must not echo declared 0.9 when tasks fail');
  const routeAfterFail = router.select({ taskType: 'implementation' });
  assert.equal(routeAfterFail.explanation.candidates[0].providerHealthy, true);
});
