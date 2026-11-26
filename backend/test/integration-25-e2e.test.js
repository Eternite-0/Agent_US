import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import {
  CACHE_AWARE_V31_DTOC_POLICY,
  PHASE_WATERMARK_V25_DTOC_POLICY,
  PHASE_WATERMARK_V25_EPOCH_WATERMARKS,
} from '../src/context/aci-engine.js';
import {
  ContextEvidenceLedger,
  buildSharedAciSummary,
} from '../src/context/aci-store.js';
import { DEFAULT_ACI_SUPERVISOR_CONFIG } from '../src/context/supervisor.js';
import {
  InterAgentMailbox,
  buildSharedAciDigest,
} from '../src/swarm/mailbox.js';
import {
  SwarmArtifactManager,
  entryPosixMode,
  isExecutableEntry,
  mergeFileThreeWay,
} from '../src/swarm/artifacts.js';
import {
  SWARM_NODE_STATES,
  SWARM_RUN_STATES,
  transitionNodeTerminalCas,
  transitionRunTerminalCas,
} from '../src/swarm/node-state-machine.js';
import {
  REVIEWER_SCHEMA_VERSION,
  computeReviewerEvidenceDigest,
  evaluateReviewerHardGate,
  validateReviewerExecution,
} from '../src/swarm/reviewer.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }

  async *stream(options) {
    const idx = this.calls.length;
    this.calls.push({
      model: options.model,
      tools: Array.isArray(options.tools) ? options.tools.map((x) => x.name) : [],
      messages: structuredClone(options.messages),
    });
    yield* this.handler(options, idx);
  }
}

async function waitTurnDone(directAgent, sessionId, turnId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const turn = directAgent.listTurns(sessionId).find((item) => item.id === turnId);
    if (turn && ['completed', 'failed', 'cancelled'].includes(turn.state)) return turn;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for turn ${turnId}`);
}

function initGitWorkspace(workDir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(workDir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  execFileSync('git', ['init'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'E2E Verifier'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: workDir, stdio: 'ignore' });
}

test('E2E 2.5: inspect_repository (relatedTo) -> unified-diff apply_patch -> run_diagnostics -> file/changed + budgetWatermarks + phase_watermark_v25', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'e2e25-tools-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'e2e25-tools-work-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  mkdirSync(join(workDir, 'test'), { recursive: true });

  writeFileSync(
    join(workDir, 'package.json'),
    JSON.stringify({ name: 'e2e25-sample', type: 'module', scripts: { test: 'node --test' } }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(workDir, 'src/math.js'),
    'export function multiply(a, b) {\n  return a + b;\n}\n',
    'utf8',
  );
  writeFileSync(
    join(workDir, 'test/math.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { multiply } from '../src/math.js';",
      "test('multiply', () => { assert.equal(multiply(3, 4), 12); });",
    ].join('\n'),
    'utf8',
  );

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'deepseek',
    apiKey: 'sk-test-e2e25-placeholder',
    models: ['test-main-model'],
  });
  pool.setDefaultModel('test-main-model');

  let step = 0;
  const unifiedPatch = [
    '--- a/src/math.js',
    '+++ b/src/math.js',
    '@@ -1,3 +1,3 @@',
    ' export function multiply(a, b) {',
    '-  return a + b;',
    '+  return a * b;',
    ' }',
  ].join('\n');

  const adapter = new ScriptedAdapter(async function* (options) {
    const sysText = String(options.system ?? '');
    if (sysText.includes('Supervisor')) {
      yield { type: 'text-delta', text: JSON.stringify({ decisions: [] }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    step += 1;
    if (step === 1) {
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc-inspect',
          name: 'inspect_repository',
          arguments: JSON.stringify({ relatedTo: ['src/math.js'], includeRelatedTests: true }),
        },
      };
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc-read',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'src/math.js' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (step === 2) {
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc-patch',
          name: 'apply_patch',
          arguments: JSON.stringify({ patch: unifiedPatch }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (step === 3) {
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc-diag',
          name: 'run_diagnostics',
          arguments: JSON.stringify({ kind: 'test', paths: ['test/math.test.js'] }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield {
      type: 'usage',
      usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 600, cacheWriteTokens: 0 },
    };
    yield { type: 'text-delta', text: 'Patched src/math.js via unified diff and verified via run_diagnostics.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    dataRoot: dataDir,
    defaultWorkspace: workDir,
    adapter,
  });

  t.after(async () => {
    await direct.close();
    if (store?.db?.isOpen) store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  const session = direct.createSession({
    workspaceRoot: workDir,
    model: 'test-main-model',
    permissionMode: 'full-access',
    aciProfile: 'full_aci',
    toolModes: { repoIntelligence: true, diagnostics: true },
    includeTools: ['apply_patch'],
    budget: { maxSteps: 8, maxTotalTokens: 120000 },
  });

  const { turn } = direct.startTurn(session.id, {
    input: 'Fix multiply in src/math.js and run diagnostics',
    model: 'test-main-model',
  });
  const finalTurn = await waitTurnDone(direct, session.id, turn.id);
  assert.equal(finalTurn.state, 'completed');

  const events = direct.listEvents(session.id);
  const fileChanged = events.find((e) => e.type === 'file/changed');
  assert.ok(fileChanged, 'expected file/changed persisted event');
  assert.equal(fileChanged.data.path, 'src/math.js');
  assert.equal(fileChanged.data.action, 'updated');
  assert.equal(fileChanged.data.additions, 1);
  assert.equal(fileChanged.data.deletions, 1);
  assert.match(fileChanged.data.unifiedDiff, /@@ -1,3 \+1,3 @@/);
  assert.match(fileChanged.data.sha256After, /^[0-9a-f]{64}$/);

  const turnCompleted = events.find((e) => e.type === 'turn/completed');
  assert.ok(turnCompleted, 'expected turn/completed event');
  assert.equal(turnCompleted.data.reasoningMetrics.aciMetrics.dtocPolicy, CACHE_AWARE_V31_DTOC_POLICY);
  assert.equal(PHASE_WATERMARK_V25_DTOC_POLICY, 'phase_watermark_v25');
  assert.deepEqual(PHASE_WATERMARK_V25_EPOCH_WATERMARKS, [0.78, 0.9]);
  assert.ok(turnCompleted.data.budgetWatermarks, 'expected budgetWatermarks on turn/completed');
  assert.equal(turnCompleted.data.budgetWatermarks.maxTokens, 120000);
  assert.equal(turnCompleted.data.reasoningMetrics.latestVerificationPassed, true);
  assert.equal(turnCompleted.data.reasoningMetrics.hasUnverifiedMutationsAfterLastPass, false);
  assert.ok(turnCompleted.data.reasoningMetrics.filesMutated.includes('src/math.js'));
  assert.ok(turnCompleted.data.reasoningMetrics.verifications.length >= 1);

  const inspectResultEv = events.find(
    (e) => e.type === 'tool/result' && e.data?.name === 'inspect_repository',
  );
  assert.ok(inspectResultEv?.data?.output?.includes('math.test.js'));
  assert.equal(readFileSync(join(workDir, 'src/math.js'), 'utf8').includes('return a * b;'), true);
});

test('E2E 2.5: Supervisor 8s circuit breaker opens after 2 timeouts, retry preserves ContextEvidenceLedger, post-test completion grace avoids TOKEN_BUDGET, and streaming lease renews', async (t) => {
  assert.equal(DEFAULT_ACI_SUPERVISOR_CONFIG.timeoutMs, 8000);

  const dataDir = mkdtempSync(join(tmpdir(), 'e2e25-rt-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'e2e25-rt-work-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  mkdirSync(join(workDir, 'test'), { recursive: true });
  const bigNoise = `// noise file\nexport const table = [\n${Array.from({ length: 160 }, (_, i) => `  "entry_${i}_payload_${'z'.repeat(18)}"`).join(',\n')}\n];\n`;
  writeFileSync(join(workDir, 'src/decoy_a.js'), bigNoise, 'utf8');
  writeFileSync(join(workDir, 'src/decoy_b.js'), bigNoise, 'utf8');
  writeFileSync(join(workDir, 'src/core.js'), 'export function ok() { return true; }\n', 'utf8');
  writeFileSync(
    join(workDir, 'test/core.test.js'),
    "import test from 'node:test'; import assert from 'node:assert/strict'; import { ok } from '../src/core.js'; test('ok', () => assert.equal(ok(), true));\n",
    'utf8',
  );

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'deepseek',
    apiKey: 'sk-test-e2e25-placeholder',
    models: ['main-model', 'fast-model'],
  });
  pool.setDefaultModel('main-model');

  let mainCallCount = 0;
  let supCallCount = 0;
  const adapter = new ScriptedAdapter(async function* (options) {
    const sysText = String(options.system ?? '');
    if (sysText.includes('Supervisor')) {
      supCallCount += 1;
      await new Promise((r) => setTimeout(r, 80));
      const err = new Error('Simulated supervisor timeout');
      err.name = 'AbortError';
      throw err;
    }

    mainCallCount += 1;
    if (mainCallCount === 1) {
      yield {
        type: 'block-end',
        block: { type: 'tool-call', id: 'tc-r1', name: 'read_file', arguments: JSON.stringify({ path: 'src/decoy_a.js' }) },
      };
      yield {
        type: 'block-end',
        block: { type: 'tool-call', id: 'tc-r2', name: 'read_file', arguments: JSON.stringify({ path: 'src/decoy_b.js' }) },
      };
      yield { type: 'usage', usage: { inputTokens: 1800, outputTokens: 200 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (mainCallCount === 2) {
      yield { type: 'text-delta', index: 0, text: 'partial-' };
      const transient = new Error('transient socket reset');
      transient.code = 'ECONNRESET';
      throw transient;
    }
    if (mainCallCount === 3) {
      yield {
        type: 'block-end',
        block: { type: 'tool-call', id: 'tc-v', name: 'run_diagnostics', arguments: JSON.stringify({ kind: 'test', paths: ['test/core.test.js'] }) },
      };
      yield { type: 'usage', usage: { inputTokens: 16200, outputTokens: 200 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    // Step after tests passed when total tokens >= maxTotalTokens (5000): must receive tools=[] grace step
    // and sustain streaming longer than leaseMs (150ms) via periodic lease renewal!
    assert.deepEqual(options.tools, [], 'post-test-pass grace step must constrain tools=[]');
    await new Promise((r) => setTimeout(r, 220));
    yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 60 } };
    yield { type: 'text-delta', text: 'Completed within post-test grace window.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    dataRoot: dataDir,
    defaultWorkspace: workDir,
    adapter,
    leaseMs: 150,
    leaseRenewalIntervalMs: 35,
  });

  t.after(async () => {
    await direct.close();
    if (store?.db?.isOpen) store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  // Exercise supervisor circuit breaker (2 consecutive timeouts -> open circuit, 3rd short-circuits)
  direct.contextSupervisor.saveConfig({ enabled: true, mode: 'custom', model: 'fast-model', timeoutMs: 25 });
  const r1 = await direct.contextSupervisor.admitCandidates({
    candidates: [{ id: 'c1', path: 'src/decoy_a.js', chars: 4000, preview: 'noise' }],
    queryIntent: 'fix core',
  });
  const r2 = await direct.contextSupervisor.admitCandidates({
    candidates: [{ id: 'c2', path: 'src/decoy_b.js', chars: 4000, preview: 'noise' }],
    queryIntent: 'fix core',
  });
  const r3 = await direct.contextSupervisor.admitCandidates({
    candidates: [{ id: 'c3', path: 'src/decoy_a.js', chars: 4000, preview: 'noise' }],
    queryIntent: 'fix core',
  });
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
  assert.equal(r3.ok, false);
  assert.equal(r3.circuitOpen, true);
  assert.equal(r3.durationMs, 0);
  assert.equal(supCallCount, 2, '3rd call must short-circuit with 0 provider invocations');

  // Verify ContextEvidenceLedger.mergeFrom + buildSharedAciSummary
  const l1 = new ContextEvidenceLedger();
  l1.recordAdmission({ path: 'src/core.js', decision: 'DIRECT', originalTokens: 300, injectedTokens: 300 });
  const l2 = new ContextEvidenceLedger();
  l2.recordAdmission({ path: 'src/decoy_a.js', decision: 'IRRELEVANT', originalTokens: 900, injectedTokens: 20 });
  l1.mergeFrom(l2);
  l1.mergeFrom(l2);
  assert.equal(l1.admissions.length, 2);
  assert.ok(buildSharedAciSummary(l1, { maxChars: 600 }).includes('src/core.js'));

  const session = direct.createSession({
    workspaceRoot: workDir,
    model: 'main-model',
    permissionMode: 'full-access',
    aciProfile: 'full_aci',
    toolModes: { diagnostics: true },
    budget: { maxSteps: 10, maxTokens: 18000, maxTotalTokens: 18000 },
  });

  const { turn } = direct.startTurn(session.id, {
    input: 'Inspect and verify core',
    model: 'main-model',
    aciOptions: { admissionMinChars: 1200 },
  });
  const settled = await waitTurnDone(direct, session.id, turn.id);
  assert.equal(settled.state, 'completed', `Expected grace completion, got ${settled.state} (${settled.errorCode}: ${settled.error})`);

  const events = direct.listEvents(session.id);
  const completedEv = events.find((e) => e.type === 'turn/completed');
  assert.ok(completedEv?.data?.budgetWatermarks);
  assert.equal(completedEv.data.budgetWatermarks.supervisorCircuitOpen, true);
  assert.equal(completedEv.data.budgetWatermarks.postTestReserveActive, true);
  // Prior retry readFiles & admissions preserved across automatic retry
  assert.ok(completedEv.data.reasoningMetrics.filesRead.includes('src/decoy_a.js'));
  assert.ok(completedEv.data.reasoningMetrics.filesRead.includes('src/decoy_b.js'));
  const mergedAdmissions = completedEv.data.reasoningMetrics?.aciMetrics?.ledger?.admissions ?? [];
  assert.ok(mergedAdmissions.some((a) => a.path === 'src/decoy_a.js'));

  const workerRow = store.db.prepare('SELECT workerId, heartbeatAt, startedAt FROM runtime_workers LIMIT 1').get();
  assert.ok(workerRow);
  assert.ok(Number(workerRow.heartbeatAt) > Number(workerRow.startedAt), 'streaming heartbeat should have renewed');
});

test('E2E 2.5: Swarm Shared ACI summary + 3-way git merge (disjoint + 0755 + conflict) + terminal CAS + Reviewer hard gate', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'e2e25-swarm-'));
  const dataDir = join(root, 'data');
  const artRoot = join(root, 'artifacts');
  const baseDir = join(root, 'repo');
  const wt1 = join(root, 'wt1');
  const wt2 = join(root, 'wt2');
  const wtVerify = join(root, 'wtVerify');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(artRoot, { recursive: true });

  t.after(() => {
    for (const wt of [wt1, wt2, wtVerify]) {
      try {
        execFileSync('git', ['-C', baseDir, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' });
      } catch {
        // ignore if already removed
      }
    }
    rmDirSafe(root);
  });

  // 1. Shared ACI summary -> Swarm mailbox digest (<= 1600 chars)
  const ledger = new ContextEvidenceLedger();
  ledger.recordAdmission({
    path: 'src/auth.js',
    decision: 'DIRECT',
    criticalDomains: ['auth'],
    originalTokens: 420,
    injectedTokens: 420,
  });
  ledger.recordAdmission({
    path: 'src/legacy_decoy.js',
    decision: 'IRRELEVANT',
    originalTokens: 1200,
    injectedTokens: 30,
  });
  const aciSummary = buildSharedAciSummary(ledger, { maxChars: 1600 });
  const digest = buildSharedAciDigest([{ nodeKey: 'worker-auth', aciMetrics: { ledger: ledger.toJSON() } }]);
  assert.ok(aciSummary.includes('src/auth.js'));
  assert.ok(digest.startsWith('[Shared Swarm ACI Digest]'));
  assert.ok(digest.length <= 1600);
  assert.ok(digest.includes('src/auth.js'));
  assert.ok(digest.includes('src/legacy_decoy.js'));

  const store = new Store(join(dataDir, 'swarm.sqlite'));
  t.after(() => {
    if (store?.db?.isOpen) store.close();
  });
  const mailbox = new InterAgentMailbox({ store });
  await mailbox.send({
    conversationId: 'conv-e2e25',
    fromAgentId: 'worker-auth',
    toAgentId: 'worker-impl',
    kind: 'handoff',
    payload: { text: 'Proceed with implementation', aciMetrics: { ledger: ledger.toJSON() } },
  });
  const msg = await mailbox.receive('worker-impl', {});
  assert.ok(msg?.payload?.sharedAciDigest?.includes('src/auth.js'));

  // 2. Executable-preserving Git 3-way merge: disjoint hunks succeed + 0755 mode preserved; overlap reports conflict
  const baseScript = '#!/bin/sh\nSTEP_A=base_a\necho middle1\necho middle2\necho middle3\nSTEP_B=base_b\n';
  const mergeUnit = mergeFileThreeWay({
    baseBuf: Buffer.from(baseScript, 'utf8'),
    currentBuf: Buffer.from(baseScript.replace('STEP_A=base_a', 'STEP_A=ours_a'), 'utf8'),
    incomingBuf: Buffer.from(baseScript.replace('STEP_B=base_b', 'STEP_B=theirs_b'), 'utf8'),
  });
  assert.equal(mergeUnit.ok, true);
  assert.equal(mergeUnit.conflictCount, 0);
  assert.ok(mergeUnit.mergedBuffer.toString('utf8').includes('STEP_A=ours_a'));
  assert.ok(mergeUnit.mergedBuffer.toString('utf8').includes('STEP_B=theirs_b'));

  initGitWorkspace(baseDir, { 'bin/deploy.sh': baseScript });
  if (process.platform !== 'win32') {
    chmodSync(join(baseDir, 'bin/deploy.sh'), 0o755);
    execFileSync('git', ['-C', baseDir, 'add', 'bin/deploy.sh'], { stdio: 'ignore' });
    execFileSync('git', ['-C', baseDir, 'commit', '-m', 'exec mode'], { stdio: 'ignore' });
  } else {
    execFileSync('git', ['-C', baseDir, 'update-index', '--chmod=+x', 'bin/deploy.sh'], { stdio: 'ignore' });
    execFileSync('git', ['-C', baseDir, 'commit', '-m', 'exec mode'], { stdio: 'ignore' });
  }

  execFileSync('git', ['-C', baseDir, 'worktree', 'add', '--detach', wt1, 'HEAD'], { stdio: 'ignore' });
  execFileSync('git', ['-C', baseDir, 'worktree', 'add', '--detach', wt2, 'HEAD'], { stdio: 'ignore' });
  execFileSync('git', ['-C', baseDir, 'worktree', 'add', '--detach', wtVerify, 'HEAD'], { stdio: 'ignore' });

  const now = Date.now();
  store.db
    .prepare(
      `INSERT INTO swarm_runs(id, sessionId, goal, status, strategyJson, budgetJson, permissionMode, createdAt, updatedAt)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run('run-e2e25', 'sess-e2e25', 'E2E 3-way merge & CAS', 'running', '{}', '{}', 'full-access', now, now);

  writeFileSync(join(wt1, 'bin/deploy.sh'), baseScript.replace('STEP_A=base_a', 'STEP_A=worker1_a'), 'utf8');
  writeFileSync(join(wt2, 'bin/deploy.sh'), baseScript.replace('STEP_B=base_b', 'STEP_B=worker2_b'), 'utf8');
  if (process.platform !== 'win32') {
    chmodSync(join(wt1, 'bin/deploy.sh'), 0o755);
    chmodSync(join(wt2, 'bin/deploy.sh'), 0o755);
  }

  const manager = new SwarmArtifactManager({ store, storageRoot: artRoot });
  const art1 = await manager.archiveWorktree({
    runId: 'run-e2e25',
    nodeId: 'node-w1',
    nodeKey: 'worker-1',
    workspaceRoot: baseDir,
    worktreePath: wt1,
  });
  const art2 = await manager.archiveWorktree({
    runId: 'run-e2e25',
    nodeId: 'node-w2',
    nodeKey: 'worker-2',
    workspaceRoot: baseDir,
    worktreePath: wt2,
  });

  const entry1 = art1.files.find((f) => f.path === 'bin/deploy.sh');
  assert.equal(entry1.mode, '100755');
  assert.equal(isExecutableEntry(entry1), true);
  assert.equal(entryPosixMode(entry1), 0o755);

  const overlayOk = manager.applyArtifactsToWorktree([art1, art2], wtVerify, {
    dependenciesByNodeKey: { 'worker-1': [], 'worker-2': [] },
  });
  assert.equal(overlayOk.ok, true);
  assert.equal(overlayOk.mergeConflicts.length, 0);
  const mergedOut = readFileSync(join(wtVerify, 'bin/deploy.sh'), 'utf8');
  assert.ok(mergedOut.includes('STEP_A=worker1_a'));
  assert.ok(mergedOut.includes('STEP_B=worker2_b'));
  if (process.platform !== 'win32') {
    assert.notEqual(statSync(join(wtVerify, 'bin/deploy.sh')).mode & 0o111, 0);
  }

  // Overlapping conflict check: parent modified same line -> mergeConflicts reported without overwrite
  writeFileSync(join(baseDir, 'bin/deploy.sh'), baseScript.replace('STEP_A=base_a', 'STEP_A=parent_conflict'), 'utf8');
  const conflictApply = manager.applyToParent(art1.id, baseDir, {
    approved: true,
    permissionMode: 'full-access',
  });
  assert.equal(conflictApply.ok, false);
  assert.equal(conflictApply.status, 'conflict');
  assert.equal(conflictApply.mergeConflicts.length, 1);
  assert.ok(readFileSync(join(baseDir, 'bin/deploy.sh'), 'utf8').includes('STEP_A=parent_conflict'));

  // 3. Terminal CAS protection
  store.db
    .prepare(
      `INSERT INTO swarm_nodes(id, runId, nodeKey, agentProfileId, model, provider, objective, acceptance,
         dependenciesJson, toolAllowJson, permissionMode, taskType, isolationMode, status,
         createdAt, updatedAt)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'node-cas-25',
      'run-e2e25',
      'impl-cas',
      'coder',
      'coder-model',
      'pool',
      'Do work',
      'done',
      '[]',
      '["apply_patch"]',
      'full-access',
      'implementation',
      'worktree',
      SWARM_NODE_STATES.RUNNING,
      now,
      now,
    );

  const nodeFirst = transitionNodeTerminalCas(store, null, 'node-cas-25', SWARM_NODE_STATES.COMPLETED, {
    emitEvent: false,
  });
  const nodeLate = transitionNodeTerminalCas(store, null, 'node-cas-25', SWARM_NODE_STATES.FAILED, {
    patch: { errorCode: 'LATE_TIMEOUT' },
    emitEvent: false,
  });
  assert.equal(nodeFirst.changed, true);
  assert.equal(nodeLate.changed, false);
  assert.equal(nodeLate.casRejected, true);

  const runFirst = transitionRunTerminalCas(store, 'run-e2e25', SWARM_RUN_STATES.COMPLETED);
  const runLate = transitionRunTerminalCas(store, 'run-e2e25', SWARM_RUN_STATES.CANCELLED);
  assert.equal(runFirst.changed, true);
  assert.equal(runLate.changed, false);
  assert.equal(runLate.casRejected, true);

  // 4. Reviewer Hard Gate: blocks synthetic pass without git diff or exitCode=0; passes with real diff + exitCode=0
  const evNoDiff = {
    runId: 'run-e2e25',
    reviewerNodeKey: 'rev',
    sourceNodes: [{ nodeKey: 'worker-1', taskType: 'implementation', status: 'completed' }],
    artifacts: [],
    receipts: [{ receiptId: 'rec-1', toolName: 'bash', status: 'finished', exitCode: 0 }],
    turnVerdicts: [],
  };
  const passPayloadNoDiff = JSON.stringify({
    schemaVersion: REVIEWER_SCHEMA_VERSION,
    verdict: 'pass',
    summary: 'Updated bin/deploy.sh and verified.',
    evidenceDigest: computeReviewerEvidenceDigest(evNoDiff),
    checkedArtifacts: [],
    evidenceRefs: ['rec-1'],
    findings: [],
  });
  const blocked = validateReviewerExecution({
    rawText: passPayloadNoDiff,
    reviewerEvidence: evNoDiff,
    workspaceRoot: baseDir,
    gitDiff: { diffFileCount: 0, diffDigest: null, files: [] },
    claimedMutations: true,
    requireTestExecution: true,
  });
  assert.equal(blocked.valid, false);
  assert.equal(blocked.code, 'REVIEWER_HARD_GATE_FAILED');
  assert.equal(blocked.reviewerVerification.hardGatePassed, false);

  const gateFailExit = evaluateReviewerHardGate({
    parsedVerdict: { verdict: 'pass', summary: 'Updated bin/deploy.sh' },
    reviewerEvidence: {
      ...evNoDiff,
      receipts: [{ receiptId: 'rec-fail', toolName: 'bash', status: 'failed', exitCode: 1 }],
    },
    workspaceRoot: baseDir,
  });
  assert.equal(gateFailExit.hardGatePassed, false);
  assert.equal(gateFailExit.verifiedTestExitCode, 1);

  const approved = validateReviewerExecution({
    rawText: passPayloadNoDiff,
    reviewerEvidence: evNoDiff,
    workspaceRoot: baseDir,
  });
  assert.equal(approved.valid, true);
  assert.equal(approved.status, 'pass');
  assert.equal(approved.reviewerVerification.hardGatePassed, true);
  assert.equal(approved.reviewerVerification.verifiedGitDiff, true);
  assert.equal(approved.reviewerVerification.verifiedTestExitCode, 0);
  assert.equal(existsSync(join(wtVerify, 'bin/deploy.sh')), true);
});
