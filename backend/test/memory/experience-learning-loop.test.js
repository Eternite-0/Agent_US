import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Store } from '../../src/store.js';
import { AccountPool } from '../../src/pool.js';
import { DirectAgentRuntime } from '../../src/direct-agent.js';
import { ExperienceMemoryService } from '../../src/memory/index.js';
import { EvaluationService, summarizeReasoningMetrics } from '../../src/evaluation/service.js';
import { MetricsCollector } from '../../src/observability/metrics.js';
import { BENCHMARK_DATASET } from '../../src/evaluation/dataset.js';
import { rmDirSafe } from '../fixtures.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }
  async *stream(options) {
    const idx = this.calls.length;
    this.calls.push(options);
    yield* this.handler(options, idx);
  }
}

async function waitTurnDone(directAgent, sessionId, turnId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const turn = directAgent.listTurns(sessionId).find((item) => item.id === turnId);
    if (turn && ['completed', 'failed', 'cancelled'].includes(turn.state)) return turn;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for turn ${turnId}`);
}

async function waitRunDone(evaluation, runId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = evaluation.getRun(runId);
    if (run && ['completed', 'failed', 'cancelled', 'timeout'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for evaluation run ${runId}`);
}

function addEvalRun(store, {
  id,
  projectId = 'project-a',
  status = 'completed',
  synthetic = true,
  taskId = 'task-1',
  taskPassed = true,
  score = { total: 1, passed: 1, failed: 0, cancelled: 0, timedOut: 0 },
} = {}) {
  store.add('evaluation_runs', {
    id,
    projectId,
    status,
    synthetic,
    score,
    results: [{
      taskId,
      status: taskPassed ? 'passed' : 'failed',
      passed: taskPassed,
      evidenceRef: `evaluation:${id}:${taskId}`,
    }],
  }, null, null, id);
}

test('DirectAgent distills verified:false lessons, isolates side effects, skips synthetic turns unless enabled, and records reasoningMetrics telemetry', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-exp-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-exp-work-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('exp-model');
  const metrics = new MetricsCollector({ store });
  const memory = new ExperienceMemoryService({ store });

  const adapter = new ScriptedAdapter(async function* (opts) {
    const messages = opts.messages ?? [];
    const lastRole = messages.at(-1)?.role;
    const userMessages = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content?.[0]?.text ?? '')
      .filter((text) => !text.startsWith('workspaceRoot:'));
    const latestUserText = userMessages.at(-1) ?? '';

    if (latestUserText.includes('PLAIN_CHAT')) {
      yield { type: 'text-delta', index: 0, text: 'Hello there, plain response.' };
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 6 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (latestUserText.includes('FIX_AUTH_MODULE') && lastRole !== 'tool') {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-write-auth',
          name: 'write_file',
          arguments: JSON.stringify({
            path: 'src/auth.js',
            content: 'export function verifyToken(t) { return Boolean(t); }\n',
          }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    yield { type: 'text-delta', index: 0, text: 'Updated src/auth.js token guard.' };
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 12 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    metrics,
    enableHeartbeat: false,
  });
  direct.attachIntelligenceServices({ memory });
  assert.equal(direct.experienceMemory, memory);

  t.after(async () => {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  // 1. Plain text chat should not pollute distilled experience lessons
  const session = direct.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });
  const plainTurn = direct.startTurn(session.id, { input: 'PLAIN_CHAT' });
  const plainDone = await waitTurnDone(direct, session.id, plainTurn.turn.id);
  assert.equal(plainDone.state, 'completed');
  assert.equal(memory.retrieve({ projectId: workDir, tokenBudget: 5000 }).items.length, 0);

  // 2. Real Direct turn with file edit distills verified_fix_pattern with verified=false
  const editTurn = direct.startTurn(session.id, { input: 'FIX_AUTH_MODULE' });
  const editDone = await waitTurnDone(direct, session.id, editTurn.turn.id);
  assert.equal(editDone.state, 'completed');

  const retrieved = memory.retrieve({
    projectId: workDir,
    query: 'FIX_AUTH_MODULE',
    targetFiles: ['src/auth.js'],
    tokenBudget: 5000,
  });
  assert.equal(retrieved.items.length, 1);
  assert.equal(retrieved.items[0].type, 'lesson');
  assert.equal(retrieved.items[0].memoryClass, 'verified_fix_pattern');
  assert.equal(retrieved.items[0].verified, false, 'Direct turn must never self-promote verified:true');
  assert.equal(retrieved.items[0].verificationEvidence, null);
  assert.deepEqual(retrieved.items[0].metadata.modifiedFiles, ['src/auth.js']);
  assert.deepEqual(retrieved.items[0].metadata.targetFiles, ['src/auth.js']);

  // 3. Synthetic turns skip distillation by default
  const synthSession = direct.createSession({
    workspaceRoot: join(workDir, 'synth-proj'),
    permissionMode: 'full-access',
    isSynthetic: true,
    trafficSource: 'eval',
  });
  mkdirSync(join(workDir, 'synth-proj', 'src'), { recursive: true });
  const synthTurn1 = direct.startTurn(synthSession.id, { input: 'FIX_AUTH_MODULE' });
  assert.equal((await waitTurnDone(direct, synthSession.id, synthTurn1.turn.id)).state, 'completed');
  assert.equal(
    memory.retrieve({ projectId: join(workDir, 'synth-proj'), tokenBudget: 5000 }).items.length,
    0,
    'synthetic turn must skip distillation unless explicitly enabled',
  );

  // 4. Synthetic turn with explicit distillSyntheticTurns:true + reasoningMetrics distills and records telemetry
  const originalExecuteTurn = direct.kernel.executeTurn.bind(direct.kernel);
  const sampleReasoningMetrics = {
    ineffectiveActionCount: 1,
    firstFixSucceeded: false,
    reproducedFailureBeforeEdit: true,
    selfCorrectionRecovered: true,
    hasUnverifiedMutationsAfterLastPass: false,
    rootCauseFilesReadBeforeEdit: ['src/auth.js'],
    stuckTriggers: ['same_error_streak'],
    errorFingerprints: ['ERR_AUTH_BYPASS'],
  };
  direct.kernel.executeTurn = async (params) => {
    const res = await originalExecuteTurn(params);
    return { ...res, reasoningMetrics: sampleReasoningMetrics };
  };

  const synthTurn2 = direct.startTurn(synthSession.id, {
    input: 'FIX_AUTH_MODULE with explicit synthetic distillation',
    distillSyntheticTurns: true,
  });
  const synthDone2 = await waitTurnDone(direct, synthSession.id, synthTurn2.turn.id);
  assert.equal(synthDone2.state, 'completed');

  const synthMem = memory.retrieve({
    projectId: join(workDir, 'synth-proj'),
    targetFiles: ['src/auth.js'],
    errorSignatures: ['ERR_AUTH_BYPASS'],
    tokenBudget: 5000,
  });
  assert.equal(synthMem.items.length, 1);
  assert.equal(synthMem.items[0].verified, false);
  assert.deepEqual(synthMem.items[0].metadata.reasoningMetrics, sampleReasoningMetrics);
  assert.ok(synthMem.items[0].metadata.errorFingerprints.includes('err_auth_bypass'));

  const completedEv = store.db
    .prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/completed'")
    .get(synthTurn2.turn.id);
  const completedPayload = JSON.parse(completedEv.data);
  assert.deepEqual(completedPayload.reasoningMetrics, sampleReasoningMetrics);

  const metricRow = store.db
    .prepare("SELECT detailJson, isSynthetic FROM runtime_metrics_events WHERE kind='reasoning_metrics' AND turnId=?")
    .get(synthTurn2.turn.id);
  assert.ok(metricRow);
  assert.equal(metricRow.isSynthetic, 1);
  assert.deepEqual(JSON.parse(metricRow.detailJson), sampleReasoningMetrics);

  // 4b. Failing Direct turn distills unverified failure_trap_pattern and records failed reasoningMetrics
  const failTurn = direct.startTurn(session.id, {
    input: 'FIX_AUTH_MODULE_FAIL_BUDGET',
    maxSteps: 1,
  });
  // Trigger write_file via FIX_AUTH_MODULE match in latestUserText so step budget exhausts after step 1
  const failDone = await waitTurnDone(direct, session.id, failTurn.turn.id);
  assert.equal(failDone.state, 'failed');
  const failMem = memory.retrieve({
    projectId: workDir,
    query: 'FIX_AUTH_MODULE_FAIL_BUDGET',
    targetFiles: ['src/auth.js'],
    errorSignatures: ['STEP_BUDGET_EXHAUSTED'],
    tokenBudget: 5000,
  });
  const trapItem = failMem.items.find((item) => item.memoryClass === 'failure_trap_pattern');
  assert.ok(trapItem, 'failing Direct turn must distill failure_trap_pattern');
  assert.equal(trapItem.verified, false);
  assert.ok(trapItem.metadata.errorFingerprints.some((fp) => fp.includes('step_budget_exhausted')));

  // 5. Failing side-effect distillation never blocks turn completion or DB commit
  direct.experienceMemory = {
    distillTurnExperience() {
      throw new Error('simulated memory DB failure');
    },
  };
  const safeTurn = direct.startTurn(session.id, { input: 'FIX_AUTH_MODULE safely' });
  const safeDone = await waitTurnDone(direct, session.id, safeTurn.turn.id);
  assert.equal(safeDone.state, 'completed');
});

test('EvaluationService distills and promotes passing tasks via createTrustedVerifier and stores unverified failure_trap_pattern on failed tasks', async (t) => {
  const store = new Store(':memory:');
  const memory = new ExperienceMemoryService({ store });
  const passTask = BENCHMARK_DATASET[0];
  const failTask = BENCHMARK_DATASET[1];

  const evaluation = new EvaluationService({
    store,
    memory,
    runtimeFactory: async ({ task }) => {
      if (task.id === BENCHMARK_DATASET[2].id) {
        return { output: task.expected.output };
      }
      if (task.id === passTask.id) {
        return {
          output: task.expected.output,
          modifiedFiles: ['src/pass-fix.js'],
          reasoningMetrics: {
            ineffectiveActionCount: 0,
            firstFixSucceeded: true,
            reproducedFailureBeforeEdit: true,
            selfCorrectionRecovered: false,
            hasUnverifiedMutationsAfterLastPass: false,
            rootCauseFilesReadBeforeEdit: ['src/pass-fix.js'],
            errorFingerprints: [],
          },
        };
      }
      return {
        output: { wrong: true },
        modifiedFiles: ['src/broken-attempt.js'],
        reasoningMetrics: {
          ineffectiveActionCount: 2,
          firstFixSucceeded: false,
          reproducedFailureBeforeEdit: false,
          selfCorrectionRecovered: false,
          hasUnverifiedMutationsAfterLastPass: true,
          stuckTriggers: ['edit_test_fail_loop'],
          falsifiedAttempts: [{ reason: 'AssertionError expected 42' }],
          errorFingerprints: ['ERR_BROKEN_OUTPUT'],
        },
      };
    },
    timeoutMs: 2_000,
  });

  t.after(async () => {
    await evaluation.close({ timeoutMs: 500 });
    store.close();
  });

  const run = evaluation.start({
    projectId: 'eval-closed-loop-proj',
    taskIds: [passTask.id, failTask.id],
    concurrency: 1,
  });
  const settled = await waitRunDone(evaluation, run.id);
  assert.equal(settled.status, 'completed');
  assert.equal(settled.score.passed, 1);
  assert.equal(settled.score.failed, 1);

  const items = memory.retrieve({ projectId: 'eval-closed-loop-proj', limit: 20, tokenBudget: 5000 }).items;
  const fixPattern = items.find((i) => i.memoryClass === 'verified_fix_pattern');
  const trapPattern = items.find((i) => i.memoryClass === 'failure_trap_pattern');

  assert.ok(fixPattern, 'passing evaluation task must distill verified_fix_pattern');
  assert.equal(fixPattern.verified, true, 'passing deterministic evaluation task must be promoted via createTrustedVerifier()');
  assert.ok(fixPattern.confidence >= 0.8);
  assert.equal(fixPattern.verificationEvidence.evaluationRunId, run.id);
  assert.equal(fixPattern.verificationEvidence.sourceTaskId, passTask.id);
  assert.equal(fixPattern.verificationEvidence.projectId, 'eval-closed-loop-proj');
  assert.deepEqual(fixPattern.metadata.modifiedFiles, ['src/pass-fix.js']);

  assert.ok(trapPattern, 'failing evaluation task must distill failure_trap_pattern');
  assert.equal(trapPattern.verified, false, 'failed evaluation task must stay unverified');
  assert.equal(trapPattern.verificationEvidence, null);
  assert.ok(trapPattern.metadata.failureCategory);
  assert.notEqual(trapPattern.metadata.failureCategory, 'none');
  assert.ok(trapPattern.metadata.errorFingerprints.includes('err_broken_output'));

  const summary = summarizeReasoningMetrics(settled.results);
  assert.equal(summary.totalResults, 2);
  assert.equal(summary.sampleCount, 2);
  assert.equal(summary.totalIneffectiveActions, 2);
  assert.equal(summary.meanIneffectiveActions, 1);
  assert.equal(summary.firstFixSuccessRate, 0.5);
  assert.equal(summary.reproducedBeforeEditRate, 0.5);
  assert.equal(summary.unverifiedMutationsAfterPassCount, 1);
  assert.equal(summary.totalFalsifiedAttempts, 1);
  assert.deepEqual(summary.stuckTriggerCounts, { edit_test_fail_loop: 1 });
  assert.equal(summary.uniqueErrorFingerprintsCount, 1);

  // Also verify passing evaluation task with no modifiedFiles still distills & promotes
  const noFilesRun = evaluation.start({
    projectId: 'eval-no-files-proj',
    taskIds: [BENCHMARK_DATASET[2].id],
    concurrency: 1,
  });
  const noFilesSettled = await waitRunDone(evaluation, noFilesRun.id);
  assert.equal(noFilesSettled.status, 'completed');
  const noFilesMem = memory.retrieve({ projectId: 'eval-no-files-proj', tokenBudget: 5000 }).items;
  assert.equal(noFilesMem.length, 1);
  assert.equal(noFilesMem[0].verified, true);
  assert.equal(noFilesMem[0].memoryClass, 'verified_fix_pattern');
});

test('distillTurnExperience blocks forged verification and enforces createTrustedVerifier invariants', () => {
  const store = new Store(':memory:');
  try {
    const memory = new ExperienceMemoryService({ store, projectId: 'project-a', clock: () => 2_000_000 });

    // 1. Direct turn verdict forging verified:true cannot set verified=true
    const [directSaved] = memory.distillTurnExperience({
      projectId: 'project-a',
      input: 'Fix cache invalidation',
      summary: 'Updated cache key',
      verdict: { verdict: 'pass', accepted: true, verified: true, verificationEvidence: { sourceTaskId: 'forged', evaluationRunId: 'forged', passed: true } },
      modifiedFiles: ['src/cache.js'],
    });
    assert.equal(directSaved.verified, false);
    assert.equal(directSaved.verificationEvidence, null);

    // 2. Forged evaluationEvidence (missing run, failed run, project mismatch, incomplete score) must throw & never verify
    assert.throws(
      () => memory.distillTurnExperience({
        projectId: 'project-a',
        input: 'Forged eval',
        verdict: { verdict: 'pass', accepted: true },
        modifiedFiles: ['src/cache.js'],
        evaluationEvidence: { sourceTaskId: 'task-1', evaluationRunId: 'missing-run', passed: true },
      }),
      /completed evaluation run/,
    );

    addEvalRun(store, { id: 'run-failed', projectId: 'project-a', status: 'failed', taskPassed: false });
    assert.throws(
      () => memory.distillTurnExperience({
        projectId: 'project-a',
        input: 'Failed eval',
        verdict: { verdict: 'pass', accepted: true },
        modifiedFiles: ['src/cache.js'],
        evaluationEvidence: { sourceTaskId: 'task-1', evaluationRunId: 'run-failed', passed: true },
      }),
      /completed evaluation run/,
    );

    addEvalRun(store, { id: 'run-proj-b', projectId: 'project-b', status: 'completed', taskPassed: true });
    assert.throws(
      () => memory.distillTurnExperience({
        projectId: 'project-a',
        input: 'Cross project eval',
        verdict: { verdict: 'pass', accepted: true },
        modifiedFiles: ['src/cache.js'],
        evaluationEvidence: { projectId: 'project-b', sourceTaskId: 'task-1', evaluationRunId: 'run-proj-b', passed: true },
      }),
      /project does not match/,
    );

    // 3. Valid completed synthetic passing run promotes via createTrustedVerifier()
    addEvalRun(store, { id: 'run-ok', projectId: 'project-a', status: 'completed', synthetic: true, taskId: 'task-ok', taskPassed: true });
    const [promoted] = memory.distillTurnExperience({
      projectId: 'project-a',
      input: 'Fix cache invalidation in eval',
      summary: 'Verified cache key fix',
      verdict: { verdict: 'pass', accepted: true },
      modifiedFiles: ['src/cache.js'],
      evaluationEvidence: {
        sourceTaskId: 'task-ok',
        evaluationRunId: 'run-ok',
        projectId: 'project-a',
        score: { total: 1, passed: 1, failed: 0, cancelled: 0, timedOut: 0 },
        passed: true,
      },
    });
    assert.equal(promoted.verified, true);
    assert.ok(promoted.confidence >= 0.8);
    assert.equal(promoted.verificationEvidence.evaluationRunId, 'run-ok');

    // 4. Direct verifyWithEvidence without private authority remains blocked
    assert.throws(
      () => memory.verifyWithEvidence({
        id: directSaved.id,
        projectId: 'project-a',
        sourceTaskId: 'task-ok',
        evaluationRunId: 'run-ok',
        evidence: { sourceTaskId: 'task-ok', evaluationRunId: 'run-ok', passed: true },
      }),
      /trusted verification context is required/,
    );
  } finally {
    store.close();
  }
});

test('rank and retrieve boost path-affinity and error-signature affinity while preserving 2-arg rank compatibility', () => {
  const store = new Store(':memory:');
  try {
    let now = 5_000_000;
    const memory = new ExperienceMemoryService({ store, projectId: 'project-rank', clock: () => now });

    const [genericHigh] = memory.remember({
      type: 'lesson',
      key: 'generic-high',
      content: 'Retry handle network carefully',
      confidence: 0.9,
      metadata: { modifiedFiles: ['src/network.js'], errorFingerprints: ['etimedout'] },
    });
    const [pathOnly] = memory.distillTurnExperience({
      projectId: 'project-rank',
      input: 'Handle session handler check',
      summary: 'Normalized path check',
      workspaceRoot: 'C:\\repo',
      verdict: { verdict: 'pass', accepted: true },
      modifiedFiles: ['C:\\repo\\src\\auth\\token.js'],
    });
    const [pathAndError] = memory.distillTurnExperience({
      projectId: 'project-rank',
      input: 'Handle session verification',
      verdict: { verdict: 'fail', accepted: false, reasons: ['ERR_JWT_EXPIRED at src/auth/token.js:42'] },
      modifiedFiles: ['src/auth/token.js'],
      error: 'TypeError: ERR_JWT_EXPIRED while parsing token',
      errorCode: 'ERR_JWT_EXPIRED',
    });

    assert.deepEqual(pathOnly.metadata.modifiedFiles, ['src/auth/token.js']);
    assert.ok(pathAndError.metadata.errorFingerprints.includes('err_jwt_expired'));

    // 2-arg compatibility: without targetFiles/errorSignatures, higher confidence genericHigh ranks first
    const baseRanked = memory.rank([genericHigh, pathOnly, pathAndError], { query: 'handle', now });
    assert.equal(baseRanked[0].id, genericHigh.id);
    assert.equal(baseRanked[0].pathAffinity, 0);
    assert.equal(baseRanked[0].errorAffinity, 0);

    // With targetFiles + errorSignatures, pathAndError outranks pathOnly and genericHigh
    const affinityRanked = memory.rank([genericHigh, pathOnly, pathAndError], {
      query: 'handle',
      now,
      targetFiles: ['src/auth/token.js'],
      errorSignatures: ['ERR_JWT_EXPIRED'],
    });
    assert.equal(affinityRanked[0].id, pathAndError.id);
    assert.equal(affinityRanked[1].id, pathOnly.id);
    assert.ok(affinityRanked[0].pathAffinity > 0.9);
    assert.ok(affinityRanked[0].errorAffinity > 0.9);
    assert.ok(affinityRanked[0].score > affinityRanked[1].score);
    assert.ok(affinityRanked[1].score > affinityRanked[2].score);

    const retrieved = memory.retrieve({
      projectId: 'project-rank',
      query: 'unrelated wording',
      targetFiles: ['src/auth/token.js'],
      errorSignatures: ['ERR_JWT_EXPIRED'],
      tokenBudget: 5000,
    });
    assert.equal(retrieved.items[0].id, pathAndError.id);
  } finally {
    store.close();
  }
});

test('distillTurnExperience redacts secrets across inputs, outputs, errors, receipts, and metadata', () => {
  const store = new Store(':memory:');
  try {
    const memory = new ExperienceMemoryService({ store, projectId: 'project-sec' });
    const secrets = [
      'sk-proj-secretValue1234567890abcdef',
      'ghp_1234567890abcdefghij1234567890',
      'Bearer mySecretBearerToken9876543210',
      'superSecretPass1234',
    ];
    const [saved] = memory.distillTurnExperience({
      projectId: 'project-sec',
      input: `Rotate key ${secrets[0]}`,
      summary: `Configured token ${secrets[2]}`,
      error: `Auth failed with api_key=${secrets[3]}`,
      verdict: { verdict: 'fail', accepted: false, reasons: [`Failed ${secrets[1]}`] },
      modifiedFiles: ['src/secrets-config.js'],
      toolReceipts: [{
        toolName: 'bash',
        status: 'failed',
        exitCode: 1,
        command: `curl -H "Authorization: ${secrets[2]}" https://example.invalid`,
        output: `token=${secrets[1]} key=${secrets[0]}`,
      }],
      reasoningMetrics: {
        ineffectiveActionCount: 1,
        errorFingerprints: [`leak:${secrets[0]}`],
      },
    });
    const serialized = JSON.stringify(saved);
    for (const secret of secrets) {
      assert.equal(serialized.includes(secret), false, `Secret ${secret} must be redacted`);
    }
  } finally {
    store.close();
  }
});
