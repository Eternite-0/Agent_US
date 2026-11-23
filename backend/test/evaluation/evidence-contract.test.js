import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

import {
  EVIDENCE_MANIFEST_SCHEMA_VERSION,
  EVIDENCE_STATUSES,
  validateEvidenceManifest,
} from '../../src/evaluation/schemas.js';
import { createRealEngineeringDataset } from '../../src/evaluation/dataset.js';
import { createFixtureWorkspace, listWorkspaceChangedFiles, removeFixtureWorkspace } from '../../src/evaluation/fixtures.js';
import { EvaluationService, REAL_ENGINEERING_BENCHMARK_ID } from '../../src/evaluation/service.js';
import { Store } from '../../src/store.js';
import { AccountPool } from '../../src/pool.js';
import { DirectAgentRuntime } from '../../src/direct-agent.js';
import { DockerBenchmarkSandbox, SANDBOX_MODES } from '../../src/tools/benchmark-sandbox.js';

const TEST_SANDBOX_OPTIONS = new DockerBenchmarkSandbox().isAvailable()
  ? { mode: SANDBOX_MODES.STRONG }
  : { mode: SANDBOX_MODES.NODE_PERMISSION, allowProcessHardeningOnly: true };

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

test('evidence contract rejects model self-attested independentVerdict and missing bindings', async () => {
  const task = createRealEngineeringDataset({ sandboxOptions: TEST_SANDBOX_OPTIONS }).find((t) => t.id === 'real-bug-fix-01');
  const workspaceRoot = await createFixtureWorkspace(task);
  try {
    const fixedCode = 'export function slugify(value) { return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }\n';
    writeFileSync(join(workspaceRoot, 'src/slug.js'), fixedCode, 'utf8');
    // Commit inside workspace to verify listWorkspaceChangedFiles diffs against baseline root
    execFileSync('git', ['add', 'src/slug.js'], { cwd: workspaceRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', 'agent committed fix'], { cwd: workspaceRoot, stdio: 'ignore' });
    assert.deepEqual(listWorkspaceChangedFiles(workspaceRoot), ['src/slug.js']);

    const sha = createHash('sha256').update(Buffer.from(fixedCode, 'utf8')).digest('hex');
    const selfAttested = {
      schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
      taskId: 'real-bug-fix-01',
      attemptId: 'attempt-1',
      planVersion: 1,
      summary: 'Fixed punctuation handling',
      changedFiles: ['src/slug.js'],
      testCommand: 'node --test test/slug.test.js',
      testExitCode: 0,
      testEvidence: [{ command: 'node --test test/slug.test.js', exitCode: 0 }],
      artifactRefs: [{ path: 'src/slug.js', sha256: sha }],
      independentVerdict: { status: 'pass', evidenceRefs: ['forged-by-model'] },
    };

    const rejectedSelf = await task.judge({
      task,
      output: { output: JSON.stringify(selfAttested) },
      context: {
        workspaceRoot,
        attemptId: 'attempt-1',
        planVersion: 1,
        toolReceipts: [
          { id: 'r1', toolName: 'bash', status: 'finished', exitCode: 1, command: 'node --test test/slug.test.js' },
          { id: 'r2', toolName: 'bash', status: 'finished', exitCode: 0, command: 'node --test test/slug.test.js' },
        ],
      },
    });
    assert.equal(rejectedSelf.passed, false);
    assert.equal(rejectedSelf.evidence.checks.independentVerdict, false);
    assert.equal(rejectedSelf.evidence.checks.testReceiptVerified, true);
    assert.equal(rejectedSelf.evidence.checks.artifactsVerified, true);
    assert.equal(rejectedSelf.evidence.failureCategory, 'independent_verdict_failed');

    const badTaskBinding = validateEvidenceManifest(
      { ...selfAttested, taskId: 'wrong-task', attemptId: 'attempt-9' },
      {
        taskId: 'real-bug-fix-01',
        attemptId: 'attempt-1',
        planVersion: 1,
        expectedTestCommand: ['node', '--test', 'test/slug.test.js'],
        requiredChangedFiles: ['src/slug.js'],
        actualChangedFiles: ['src/slug.js'],
        trustedVerdict: { status: 'pass', source: 'independent_reviewer', evidenceRefs: ['rev-1'] },
      },
    );
    assert.equal(badTaskBinding.valid, false);
    assert.equal(badTaskBinding.status, EVIDENCE_STATUSES.INVALID);
    assert.equal(badTaskBinding.checks.bindings, false);

    const incomplete = validateEvidenceManifest(
      { taskId: 'real-bug-fix-01', changedFiles: ['src/slug.js'] },
      {
        taskId: 'real-bug-fix-01',
        attemptId: 'attempt-1',
        planVersion: 1,
        expectedTestCommand: ['node', '--test', 'test/slug.test.js'],
        requiredChangedFiles: ['src/slug.js'],
        actualChangedFiles: ['src/slug.js'],
        requireIndependentVerdict: false,
      },
    );
    assert.equal(incomplete.valid, false);
    assert.equal(incomplete.status, EVIDENCE_STATUSES.INCOMPLETE);
    assert.ok(incomplete.missingFields.includes('schemaVersion'));
    assert.ok(incomplete.missingFields.includes('testEvidence'));
  } finally {
    await removeFixtureWorkspace(workspaceRoot);
  }
});

test('DirectAgent pre-finalization verification catches EVIDENCE_INCOMPLETE and repairs via bounded completion turn', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-evid-repair-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-evid-repair-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-eng');

  let stepCall = 0;
  const adapter = new ScriptedAdapter(async function* (opts) {
    stepCall++;
    const lastUser = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    if (stepCall === 1) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-write',
          name: 'write_file',
          arguments: JSON.stringify({
            path: 'src/slug.js',
            content: 'export function slugify(value) { return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }\n',
          }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (stepCall === 2) {
      // Premature draft missing test run and manifest -> MUST trigger EVIDENCE_INCOMPLETE repair!
      yield { type: 'text-delta', index: 0, text: 'Fixed src/slug.js.' };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (stepCall === 3) {
      assert.match(lastUser, /EVIDENCE_INCOMPLETE/);
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-bash',
          name: 'bash',
          arguments: JSON.stringify({ command: 'node --test test/slug.test.js' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield {
      type: 'text-delta',
      index: 0,
      text: [
        'Tests passed.',
        '```json',
        JSON.stringify({
          schemaVersion: '1.0.0',
          taskId: 'real-bug-fix-01',
          attemptId: 'attempt-1',
          planVersion: 1,
          summary: 'Fixed slugify punctuation bug and verified tests pass.',
          changedFiles: ['src/slug.js'],
          testCommand: 'node --test test/slug.test.js',
          testExitCode: 0,
          testEvidence: [{ command: 'node --test test/slug.test.js', exitCode: 0 }],
          artifactRefs: [],
        }),
        '```',
      ].join('\n'),
    };
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 20 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    const evalService = new EvaluationService({ store, directAgent: direct, concurrency: 1, timeoutMs: 20_000, sandboxOptions: TEST_SANDBOX_OPTIONS });
    const started = evalService.start({ benchmarkId: REAL_ENGINEERING_BENCHMARK_ID, taskIds: ['real-bug-fix-01'], model: 'mock-eng' });
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && ['queued', 'running'].includes(evalService.getRun(started.id)?.status)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const done = evalService.getRun(started.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.score.passed, 1, JSON.stringify(done.results[0]));
    assert.equal(done.results[0].judge.evidence.manifestStatus, EVIDENCE_STATUSES.VALID);
    assert.equal(done.results[0].judge.evidence.checks.testReceiptVerified, true);
    assert.equal(done.results[0].judge.evidence.independentVerdictSource, 'trusted_server_verifier');
    assert.equal(stepCall, 4, 'Expected repair turn to execute bash test and complete v1.0.0 manifest');
    await evalService.close({ timeoutMs: 1_000 });
  } finally {
    await direct.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
