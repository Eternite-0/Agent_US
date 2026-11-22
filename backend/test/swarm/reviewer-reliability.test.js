import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

import { Store } from '../../src/store.js';
import { AccountPool } from '../../src/pool.js';
import { DirectAgentRuntime } from '../../src/direct-agent.js';
import { TeamOptimizer } from '../../src/swarm/team-optimizer.js';
import { ModelFeedbackTracker } from '../../src/swarm/feedback.js';
import { AgentCapabilityRegistry } from '../../src/swarm/capabilities.js';
import { AdaptiveModelRouter } from '../../src/swarm/router.js';
import {
  MAX_REVIEWER_FORMAT_RETRIES,
  REVIEWER_SCHEMA_VERSION,
  computeReviewerEvidenceDigest,
  parseReviewerOutput,
  validateReviewerExecution,
} from '../../src/swarm/reviewer.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }
  async *stream(options) {
    this.calls.push(structuredClone(options.messages));
    yield* this.handler(options, this.calls.length - 1);
  }
}

function initGitRepo(workDir) {
  mkdirSync(join(workDir, 'src'), { recursive: true });
  writeFileSync(join(workDir, 'src', 'index.js'), 'export const initial = true;\n', 'utf8');
  execFileSync('git', ['init'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: workDir, stdio: 'ignore' });
}

function rmSafe(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore Windows file lock
  }
}

function createTwoModelEnv(handler, t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-rev-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-rev-work-'));
  initGitRepo(workDir);
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'custom-openai',
    label: 'Worker',
    endpoint: 'https://api.example.invalid/v1',
    credential: 'sk-test-worker',
    models: ['worker-a', 'worker-b'],
  });
  pool.createAccount({
    preset: 'custom-openai',
    label: 'Reviewer',
    endpoint: 'https://api.example.invalid/v1',
    credential: 'sk-test-reviewer',
    models: ['reviewer-model'],
  });
  pool.setDefaultModel('worker-a');

  const adapter = new ScriptedAdapter(handler);
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });

  t.after(async () => {
    await direct.close();
    store.close();
    rmSafe(dataDir);
    rmSafe(workDir);
  });

  return { store, pool, direct, adapter, workDir };
}

test('unit: validateReviewerExecution rejects malformed JSON, skipped artifact reads, writes, and repair tampering', () => {
  const evidence = {
    artifacts: [{ artifactId: 'a1', uri: 'swarm-artifact://a1', nodeKey: 'impl', bundleSha256: 'abc', status: 'registered', verified: true }],
    receipts: [{ receiptId: 'r1', turnId: 't1', toolName: 'write_file', status: 'finished', outputDigest: 'd1', exitCode: null }],
    turnVerdicts: [{ turnId: 't1', state: 'completed', verdict: { verdict: 'pass', accepted: true }, evidenceCount: 1 }],
  };
  const digest = computeReviewerEvidenceDigest(evidence);

  assert.equal(parseReviewerOutput('Looks good to me without json').valid, false);

  // Skipped artifact read
  const skippedRead = validateReviewerExecution({
    rawText: JSON.stringify({
      schemaVersion: REVIEWER_SCHEMA_VERSION,
      verdict: 'pass',
      summary: 'Skipped read',
      evidenceDigest: digest,
      checkedArtifacts: ['swarm-artifact://a1'],
      evidenceRefs: ['r1'],
    }),
    reviewerEvidence: evidence,
    toolReceipts: [],
  });
  assert.equal(skippedRead.valid, false);
  assert.equal(skippedRead.code, 'REVIEWER_ARTIFACT_READ_REQUIRED');

  // Fabricated artifact URI
  const readReceipt = [{ id: 'rr1', toolName: 'read_swarm_artifact', status: 'finished' }];
  const fabricated = validateReviewerExecution({
    rawText: JSON.stringify({
      schemaVersion: REVIEWER_SCHEMA_VERSION,
      verdict: 'pass',
      evidenceDigest: digest,
      checkedArtifacts: ['swarm-artifact://forged'],
    }),
    reviewerEvidence: evidence,
    toolReceipts: readReceipt,
  });
  assert.equal(fabricated.valid, false);
  assert.equal(fabricated.code, 'REVIEWER_EVIDENCE_TAMPERED');

  // Mutating tool succeeded
  const mutating = validateReviewerExecution({
    rawText: JSON.stringify({ schemaVersion: REVIEWER_SCHEMA_VERSION, verdict: 'pass', evidenceDigest: digest }),
    reviewerEvidence: evidence,
    toolReceipts: [...readReceipt, { id: 'w1', toolName: 'write_file', status: 'finished' }],
  });
  assert.equal(mutating.valid, false);
  assert.equal(mutating.code, 'REVIEWER_WRITE_POLICY_VIOLATION');

  // Format repair flipped failure verdict to pass
  const flipped = validateReviewerExecution({
    rawText: JSON.stringify({
      schemaVersion: REVIEWER_SCHEMA_VERSION,
      verdict: 'pass',
      evidenceDigest: digest,
      checkedArtifacts: ['swarm-artifact://a1'],
    }),
    reviewerEvidence: evidence,
    toolReceipts: readReceipt,
    originalRawText: 'Rough review: "verdict": "fail" - missing null guard in parser {broken',
  });
  assert.equal(flipped.valid, false);
  assert.equal(flipped.code, 'REVIEWER_EVIDENCE_TAMPERED');

  // Valid fenced output
  const validFenced = validateReviewerExecution({
    rawText: [
      'Here is the schema verdict:',
      '```json',
      JSON.stringify({
        schemaVersion: REVIEWER_SCHEMA_VERSION,
        verdict: 'pass',
        summary: 'Verified artifact and receipts',
        evidenceDigest: digest,
        checkedArtifacts: ['swarm-artifact://a1'],
        evidenceRefs: ['r1'],
        findings: [{ severity: 'info', message: 'clean diff', evidenceRef: 'r1' }],
      }),
      '```',
    ].join('\n'),
    reviewerEvidence: evidence,
    toolReceipts: readReceipt,
  });
  assert.equal(validFenced.valid, true);
  assert.equal(validFenced.status, 'pass');
});

test('Swarm reviewer repairs malformed JSON once without tampering, reads artifact, and gates final verdict', async (t) => {
  let reviewerTurns = 0;
  const { store, direct } = createTwoModelEnv(async function* (opts) {
    const messages = opts.messages ?? [];
    const sysText = messages.find((m) => m.role === 'system')?.content?.[0]?.text ?? '';
    const userText = messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const lastRole = messages.at(-1)?.role;

    if (userText.includes('[Reviewer Format Repair Required]') || sysText.includes('[Reviewer Format Repair Required]')) {
      const mDigest = /Required evidenceDigest:\s*"([0-9a-f]{64})"/i.exec(userText)
        ?? /evidenceDigest:\s*"([0-9a-f]{64})"/i.exec(messages.map((m) => m.content?.[0]?.text ?? '').join('\n'));
      const digest = mDigest?.[1] ?? '';
      const uriMatch = /"(swarm-artifact:\/\/[^"]+)"/.exec(messages.map((m) => m.content?.[0]?.text ?? '').join('\n'));
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          schemaVersion: REVIEWER_SCHEMA_VERSION,
          verdict: 'pass',
          summary: 'Repaired JSON review after reading worktree artifacts',
          evidenceDigest: digest,
          checkedArtifacts: uriMatch ? [uriMatch[1]] : [],
          evidenceRefs: [],
          findings: [],
        }),
      };
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 18 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (userText.includes('[Durable evidence manifest]')) {
      const manifestMatch = /\[Durable evidence manifest\]\s*\n+([\s\S]+)$/.exec(userText);
      const manifest = manifestMatch ? JSON.parse(manifestMatch[1].trim()) : { artifacts: [] };
      const artUri = manifest.artifacts?.[0]?.uri;
      if (lastRole !== 'tool' && artUri) {
        reviewerTurns++;
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `tc-rev-read-${reviewerTurns}`,
            name: 'read_swarm_artifact',
            arguments: JSON.stringify({ uri: artUri, path: 'src/a.js' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      // First final response is malformed prose-only!
      yield { type: 'text-delta', index: 0, text: 'I checked src/a.js and approve it in plain text {not-json' };
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 12 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (lastRole !== 'tool') {
      const target = userText.includes('WORK_A') ? 'src/a.js' : 'src/b.js';
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: `tc-w-${target}`,
          name: 'write_file',
          arguments: JSON.stringify({ path: target, content: `export const file = '${target}';\n` }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'worker done' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }, t);

  const sess = direct.createSession({ permissionMode: 'auto-safe' });
  const result = await direct.swarmOrchestrator.startRun({
    sessionId: sess.id,
    goal: 'Parallel implementation with reviewer format repair',
    maxConcurrency: 2,
    nodes: [
      { nodeKey: 'impl-a', taskType: 'implementation', objective: 'WORK_A', isolationMode: 'worktree', priority: 10 },
      { nodeKey: 'impl-b', taskType: 'implementation', objective: 'WORK_B', isolationMode: 'worktree', priority: 10 },
    ],
  });

  assert.equal(result.status, 'completed', `Unexpected run status: ${result.errorMessage}`);
  const reviewerNode = result.nodes.find((n) => n.taskType === 'review');
  assert.ok(reviewerNode);
  const parsedBudget = JSON.parse(reviewerNode.budgetJson);
  assert.equal(parsedBudget.reviewerVerdict.status, 'pass');
  assert.equal(parsedBudget.reviewerVerdict.formatRetriesUsed, 1);
  assert.ok(parsedBudget.reviewerVerdict.readArtifactCount >= 1);
  assert.equal(result.verdict.independentReviewerVerdict.status, 'pass');

  const feedbackTracker = new ModelFeedbackTracker(store);
  const revStats = feedbackTracker.getReviewerStats(reviewerNode.model, { includeSynthetic: true });
  assert.equal(revStats.sampleCount, 1);
  assert.equal(revStats.metrics.verificationPassRate, 1);
});

test('Swarm rejects repeatedly malformed reviewer output and honors explicit reviewer fail verdict', async (t) => {
  // Case A: Repeatedly malformed JSON exceeds MAX_REVIEWER_FORMAT_RETRIES and fails the run
  let repairCount = 0;
  const { direct: directA } = createTwoModelEnv(async function* (opts) {
    const messages = opts.messages ?? [];
    const userText = messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const lastRole = messages.at(-1)?.role;

    if (userText.includes('[Reviewer Format Repair Required]')) {
      repairCount++;
      yield { type: 'text-delta', index: 0, text: 'still malformed non-json response' };
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 6 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (userText.includes('[Durable evidence manifest]')) {
      const manifestMatch = /\[Durable evidence manifest\]\s*\n+([\s\S]+)$/.exec(userText);
      const manifest = manifestMatch ? JSON.parse(manifestMatch[1].trim()) : { artifacts: [] };
      const artUri = manifest.artifacts?.[0]?.uri;
      if (lastRole !== 'tool' && artUri) {
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: 'tc-r-a', name: 'read_swarm_artifact', arguments: JSON.stringify({ uri: artUri, path: 'src/a.js' }) },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'not valid json output' };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 6 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (lastRole !== 'tool') {
      const target = userText.includes('WORK_A') ? 'src/a.js' : 'src/b.js';
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: `tc-${target}`, name: 'write_file', arguments: JSON.stringify({ path: target, content: 'export const x = 1;\n' }) },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'done' };
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }, t);

  const sessA = directA.createSession({ permissionMode: 'auto-safe' });
  const failMalformed = await directA.swarmOrchestrator.startRun({
    sessionId: sessA.id,
    goal: 'Malformed reviewer rejection',
    maxConcurrency: 2,
    maxReplans: 0,
    nodes: [
      { nodeKey: 'impl-a', taskType: 'implementation', objective: 'WORK_A', isolationMode: 'worktree' },
      { nodeKey: 'impl-b', taskType: 'implementation', objective: 'WORK_B', isolationMode: 'worktree' },
    ],
  });
  assert.equal(failMalformed.status, 'failed');
  assert.equal(repairCount, MAX_REVIEWER_FORMAT_RETRIES);
  const malNode = failMalformed.nodes.find((n) => n.taskType === 'review');
  assert.equal(malNode.errorCode, 'REVIEWER_OUTPUT_MALFORMED');

  // Case B: Valid JSON reviewer with verdict: "fail" rejects the overall run in #handleVerify
  const { direct: directB } = createTwoModelEnv(async function* (opts) {
    const messages = opts.messages ?? [];
    const userText = messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const lastRole = messages.at(-1)?.role;

    if (userText.includes('[Durable evidence manifest]')) {
      const manifestMatch = /\[Durable evidence manifest\]\s*\n+([\s\S]+)$/.exec(userText);
      const manifest = manifestMatch ? JSON.parse(manifestMatch[1].trim()) : { artifacts: [] };
      const artUri = manifest.artifacts?.[0]?.uri;
      if (lastRole !== 'tool' && artUri) {
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: 'tc-r-b', name: 'read_swarm_artifact', arguments: JSON.stringify({ uri: artUri, path: 'src/a.js' }) },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          schemaVersion: REVIEWER_SCHEMA_VERSION,
          verdict: 'fail',
          summary: 'Missing validation guard in artifact',
          evidenceDigest: computeReviewerEvidenceDigest(manifest),
          checkedArtifacts: artUri ? [artUri] : [],
          findings: [{ severity: 'high', message: 'Missing guard', evidenceRef: artUri || 'manifest' }],
        }),
      };
      yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 15 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (lastRole !== 'tool') {
      const target = userText.includes('WORK_A') ? 'src/a.js' : 'src/b.js';
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: `tc2-${target}`, name: 'write_file', arguments: JSON.stringify({ path: target, content: 'export const y = 2;\n' }) },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'done' };
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }, t);

  const sessB = directB.createSession({ permissionMode: 'auto-safe' });
  const rejectedRun = await directB.swarmOrchestrator.startRun({
    sessionId: sessB.id,
    goal: 'Valid reviewer fail verdict gates swarm outcome',
    maxConcurrency: 2,
    nodes: [
      { nodeKey: 'impl-a', taskType: 'implementation', objective: 'WORK_A', isolationMode: 'worktree' },
      { nodeKey: 'impl-b', taskType: 'implementation', objective: 'WORK_B', isolationMode: 'worktree' },
    ],
  });
  assert.equal(rejectedRun.status, 'failed');
  assert.ok(rejectedRun.verdict?.reasons?.includes('independent_reviewer_rejected'));
});

test('High-risk reviewer routing selects a distinct healthy model and tracks review stats separately', () => {
  const store = new Store(':memory:');
  try {
    const tracker = new ModelFeedbackTracker(store);
    // model-coder has great coding stats, terrible review stats
    for (let i = 0; i < 4; i++) {
      tracker.record({ model: 'model-coder', taskType: 'implementation', success: true, verifiedPass: true });
      tracker.record({ model: 'model-coder', taskType: 'review', success: false, verifiedPass: false });
      tracker.record({ model: 'model-critic', taskType: 'review', success: true, verifiedPass: true });
    }
    assert.equal(tracker.getReviewerStats('model-coder').metrics.verificationPassRate, 0);
    assert.equal(tracker.getReviewerStats('model-critic').metrics.verificationPassRate, 1);

    const optimizer = new TeamOptimizer({ teamSize: 2, defaultMaxConcurrency: 2 });
    const team = optimizer.optimize({
      task: { taskType: 'security-audit', artifactRisk: 'high', requireDistinctReviewerModel: true, independentWorkstreams: 1 },
      candidates: [
        { id: 'model-coder', model: 'model-coder', healthy: true, capabilities: { coding: 0.98, reasoning: 0.92 }, estimatedTokens: 10 },
        { id: 'model-critic', model: 'model-critic', healthy: true, capabilities: { coding: 0.75, reasoning: 0.96 }, estimatedTokens: 10 },
      ],
      budget: { maxTokens: 1000 },
      reviewerAvailable: true,
    });
    assert.ok(team.reviewer);
    assert.notEqual(team.reviewer.model, team.members[0].id);
    assert.equal(team.reviewer.model, 'model-critic');

    const modelRegistry = {
      syncFromPool: () => [
        {
          model: 'model-coder',
          provider: 'pool',
          healthy: true,
          costWeight: 1,
          contextWindow: 128000,
          capabilities: { coding: 0.99, reasoning: 0.9, research: 0.8, planning: 0.8, speed: 0.8, contextCapacity: 0.8, multimodal: 0, toolCompatibility: 0.9 },
        },
        {
          model: 'model-critic',
          provider: 'pool',
          healthy: true,
          costWeight: 1,
          contextWindow: 128000,
          capabilities: { coding: 0.7, reasoning: 0.95, research: 0.95, planning: 0.9, speed: 0.8, contextCapacity: 0.8, multimodal: 0, toolCompatibility: 0.9 },
        },
      ],
    };
    const router = new AdaptiveModelRouter({
      modelRegistry,
      agentRegistry: new AgentCapabilityRegistry(),
      feedbackTracker: tracker,
    });
    const revPick = router.select({ taskType: 'review', excludeModels: ['model-coder'] });
    assert.equal(revPick.model, 'model-critic');
  } finally {
    store.close();
  }
});

test('Swarm reviewer accepts transitive upstream artifacts in 3-hop DAG while blocking fabricated URIs', async (t) => {
  // 1. Valid transitive ancestor artifact reference passes
  let transitiveManifest = null;
  const { direct: directOk } = createTwoModelEnv(async function* (opts) {
    const messages = opts.messages ?? [];
    const userText = messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const lastRole = messages.at(-1)?.role;

    if (userText.includes('[Durable evidence manifest]')) {
      const manifestMatch = /\[Durable evidence manifest\]\s*\n+([\s\S]+)$/.exec(userText);
      transitiveManifest = manifestMatch ? JSON.parse(manifestMatch[1].trim()) : { artifacts: [] };
      const implArt = transitiveManifest.artifacts?.find((a) => a.nodeKey === 'impl');
      if (lastRole !== 'tool' && implArt) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-rev-trans',
            name: 'read_swarm_artifact',
            arguments: JSON.stringify({ uri: implArt.uri, path: 'src/trans.js' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      const digest = computeReviewerEvidenceDigest(transitiveManifest);
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          schemaVersion: REVIEWER_SCHEMA_VERSION,
          verdict: 'pass',
          summary: 'Verified transitive impl artifact across verification hop',
          evidenceDigest: digest,
          checkedArtifacts: implArt ? [implArt.uri] : [],
          evidenceRefs: [],
          findings: [],
        }),
      };
      yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 12 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (userText.includes('WORK_IMPL') && lastRole !== 'tool') {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-w-trans',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'src/trans.js', content: 'export const trans = 42;\n' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    yield { type: 'text-delta', index: 0, text: 'node ok' };
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }, t);

  const sOk = directOk.createSession({ permissionMode: 'auto-safe' });
  const okRun = await directOk.swarmOrchestrator.startRun({
    sessionId: sOk.id,
    goal: '3-hop transitive reviewer artifact verification',
    maxConcurrency: 2,
    budget: { strictReviewerSchema: true },
    nodes: [
      { nodeKey: 'impl', taskType: 'implementation', objective: 'WORK_IMPL', dependencies: [], isolationMode: 'worktree', priority: 20 },
      { nodeKey: 'verify', taskType: 'verification', objective: 'VERIFY_ONLY', dependencies: ['impl'], isolationMode: 'worktree', priority: 10 },
      { nodeKey: 'review', taskType: 'review', objective: 'REVIEW_TRANSITIVE', dependencies: ['verify'], permissionMode: 'read-only', priority: 5 },
    ],
  });
  assert.equal(okRun.status, 'completed', `Unexpected run status: ${okRun.errorMessage}`);
  const implArt = transitiveManifest?.artifacts?.find((a) => a.nodeKey === 'impl');
  assert.ok(implArt, 'Expected transitive impl artifact inside reviewer evidence manifest');
  const revNode = okRun.nodes.find((n) => n.nodeKey === 'review');
  const revBudget = JSON.parse(revNode.budgetJson);
  assert.equal(revBudget.reviewerVerdict.status, 'pass');
  assert.ok(revBudget.reviewerVerdict.checkedArtifacts.includes(implArt.uri));

  // 2. Fabricated URI still triggers REVIEWER_EVIDENCE_TAMPERED
  const { direct: directBad } = createTwoModelEnv(async function* (opts) {
    const messages = opts.messages ?? [];
    const userText = messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const lastRole = messages.at(-1)?.role;

    if (userText.includes('[Durable evidence manifest]')) {
      const manifestMatch = /\[Durable evidence manifest\]\s*\n+([\s\S]+)$/.exec(userText);
      const manifest = manifestMatch ? JSON.parse(manifestMatch[1].trim()) : { artifacts: [] };
      const implArt2 = manifest.artifacts?.find((a) => a.nodeKey === 'impl');
      if (lastRole !== 'tool' && implArt2) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-rev-bad',
            name: 'read_swarm_artifact',
            arguments: JSON.stringify({ uri: implArt2.uri, path: 'src/trans.js' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      const digest = computeReviewerEvidenceDigest(manifest);
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          schemaVersion: REVIEWER_SCHEMA_VERSION,
          verdict: 'pass',
          summary: 'Citing fabricated artifact URI',
          evidenceDigest: digest,
          checkedArtifacts: ['swarm-artifact://fabricated/nonexistent-id'],
          evidenceRefs: [],
          findings: [],
        }),
      };
      yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 12 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (userText.includes('WORK_IMPL') && lastRole !== 'tool') {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-w-bad',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'src/trans.js', content: 'export const trans = 42;\n' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    yield { type: 'text-delta', index: 0, text: 'node ok' };
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }, t);

  const sBad = directBad.createSession({ permissionMode: 'auto-safe' });
  const badRun = await directBad.swarmOrchestrator.startRun({
    sessionId: sBad.id,
    goal: '3-hop fabricated reviewer artifact rejection',
    maxConcurrency: 2,
    budget: { strictReviewerSchema: true },
    nodes: [
      { nodeKey: 'impl', taskType: 'implementation', objective: 'WORK_IMPL', dependencies: [], isolationMode: 'worktree', priority: 20 },
      { nodeKey: 'verify', taskType: 'verification', objective: 'VERIFY_ONLY', dependencies: ['impl'], isolationMode: 'worktree', priority: 10 },
      { nodeKey: 'review', taskType: 'review', objective: 'REVIEW_FABRICATED', dependencies: ['verify'], permissionMode: 'read-only', priority: 5 },
    ],
  });
  assert.equal(badRun.status, 'failed');
  assert.equal(badRun.errorCode, 'REVIEWER_EVIDENCE_TAMPERED');
});
