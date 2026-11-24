import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

import { Store } from '../../src/store.js';
import { AccountPool } from '../../src/pool.js';
import { DirectAgentRuntime } from '../../src/direct-agent.js';
import {
  DynamicTaskPlanner,
  detectSiblingWritePathConflicts,
} from '../../src/swarm/planner.js';
import {
  InterAgentMailbox,
  buildSharedAciDigest,
} from '../../src/swarm/mailbox.js';
import {
  SwarmArtifactManager,
  entryPosixMode,
  isExecutableEntry,
  mergeFileThreeWay,
} from '../../src/swarm/artifacts.js';
import {
  SWARM_NODE_STATES,
  SWARM_RUN_STATES,
  transitionNodeTerminalCas,
  transitionRunTerminalCas,
  transitionSwarmNode,
} from '../../src/swarm/node-state-machine.js';
import { recoverInterruptedSwarmRuns } from '../../src/swarm/recovery-helpers.js';
import {
  REVIEWER_SCHEMA_VERSION,
  computeReviewerEvidenceDigest,
  evaluateReviewerHardGate,
  validateReviewerExecution,
} from '../../src/swarm/reviewer.js';

class MockSwarmAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
  }

  async *stream(options) {
    yield* this.handler(options);
  }
}

function rmSafe(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 40 });
  } catch {
    // ignore transient Windows cleanup lock
  }
}

function initGitRepo(workDir, files = {}, executablePaths = []) {
  const execSet = new Set(executablePaths);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(workDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
    if (execSet.has(rel) && process.platform !== 'win32') {
      chmodSync(full, 0o755);
    }
  }
  execFileSync('git', ['init'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'swarm-hardening@example.test'], {
    cwd: workDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Swarm Hardening'], {
    cwd: workDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'core.filemode', 'false'], {
    cwd: workDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['add', '-A'], { cwd: workDir, stdio: 'ignore' });
  for (const rel of execSet) {
    execFileSync('git', ['update-index', '--chmod=+x', rel], {
      cwd: workDir,
      stdio: 'ignore',
    });
  }
  execFileSync('git', ['commit', '-m', 'baseline commit'], {
    cwd: workDir,
    stdio: 'ignore',
  });
}

function createSwarmEnv(
  t,
  {
    workFiles = {},
    executablePaths = [],
    handler = null,
    models = ['coder-model', 'verifier-model', 'reviewer-model'],
    gitInit = true,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'agent-us-swarm25-'));
  const dataDir = join(root, 'data');
  const workDir = join(root, 'work');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  if (gitInit) {
    initGitRepo(workDir, workFiles, executablePaths);
  } else {
    for (const [rel, content] of Object.entries(workFiles)) {
      const full = join(workDir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
  }

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'custom-openai',
    label: 'Swarm25 Test Pool',
    endpoint: 'https://api.example.invalid/v1',
    credential: 'sk-test-swarm25',
    models,
  });
  pool.setDefaultModel(models[0]);

  const adapter = new MockSwarmAdapter(
    handler ??
      (async function* () {
        yield { type: 'text-delta', index: 0, text: 'ok' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }),
  );

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });

  t.after(async () => {
    await direct.close();
    store.close();
    rmSafe(root);
  });

  return { root, store, pool, direct, workDir, dataDir };
}

function buildSubshellNodeTestCmd(relTestPath) {
  return (
    `node -e "const cp=require('node:child_process');` +
    `const e={...process.env};delete e.NODE_TEST_CONTEXT;delete e.NODE_TEST_WORKER_ID;` +
    `const r=cp.spawnSync(process.execPath,['--test','${relTestPath}'],{stdio:'inherit',env:e});` +
    `process.exit(r.status??1);"`
  );
}

test('1a. detectSiblingWritePathConflicts auto-serializes overlapping file and directory write scopes deterministically', () => {
  const planner = new DynamicTaskPlanner({});

  // Disjoint siblings (including similarly prefixed directory boundary src/api vs src/api-v2)
  const clean = detectSiblingWritePathConflicts([
    { nodeKey: 'a', taskType: 'implementation', writePaths: ['src/api'] },
    { nodeKey: 'b', taskType: 'implementation', targetFiles: ['src/api-v2/index.js'] },
  ]);
  assert.equal(clean.hasConflicts, false);
  assert.equal(clean.blocked, false);
  assert.equal(clean.addedEdges.length, 0);

  // Causally ordered siblings sharing a file do not conflict
  const causal = detectSiblingWritePathConflicts([
    { nodeKey: 'a', taskType: 'implementation', files: ['src/shared.js'] },
    { nodeKey: 'b', taskType: 'implementation', dependencies: ['a'], writePaths: ['./src\\shared.js'] },
  ]);
  assert.equal(causal.hasConflicts, false);
  assert.equal(causal.addedEdges.length, 0);

  // Exact file overlap + directory/file overlap across non-causal siblings -> serialize deterministically
  const serialized = detectSiblingWritePathConflicts([
    { nodeKey: 'worker-b', priority: 10, taskType: 'implementation', targetFiles: ['src/core/engine.js'] },
    { nodeKey: 'worker-a', priority: 20, taskType: 'implementation', writePaths: ['src/core'] },
    { nodeKey: 'worker-c', priority: 5, taskType: 'implementation', files: ['./src\\core\\engine.js'] },
  ]);
  assert.equal(serialized.hasConflicts, true);
  assert.equal(serialized.blocked, false);
  assert.equal(serialized.conflictPolicy, 'serialize');
  assert.ok(serialized.addedEdges.length >= 2);
  assert.ok(serialized.conflicts.length >= 2);
  assert.equal(serialized.writeConflictResolution.mode, 'serialize');
  assert.equal(serialized.writeConflictResolution.hasConflicts, true);

  const byKey = new Map(serialized.nodes.map((n) => [n.nodeKey, n]));
  assert.deepEqual(byKey.get('worker-a').dependencies, []);
  assert.ok(byKey.get('worker-b').dependencies.includes('worker-a'));
  assert.ok(byKey.get('worker-c').dependencies.includes('worker-b'));
  assert.equal(byKey.get('worker-b').writeConflictResolution.serializedAfter.includes('worker-a'), true);

  // Resulting DAG passes cycle & dependency validation cleanly
  const validDag = planner.validateDag(serialized.nodes);
  assert.equal(validDag, true);
});

test('1b. detectSiblingWritePathConflicts and orchestrator enforce conflictPolicy=block with WRITE_PATH_CONFLICT and runtime serialize', async (t) => {
  const blocked = detectSiblingWritePathConflicts(
    [
      { nodeKey: 'alpha', taskType: 'implementation', writePaths: ['src/mod'] },
      { nodeKey: 'beta', taskType: 'implementation', targetFiles: ['src/mod/item.js'] },
    ],
    { conflictPolicy: 'block' },
  );
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.code, 'WRITE_PATH_CONFLICT');
  assert.equal(blocked.conflicts.length, 1);
  assert.deepEqual(blocked.conflicts[0].nodes, ['alpha', 'beta']);

  const executionOrder = [];
  let inFlightCount = 0;
  let maxConcurrent = 0;

  const { direct, workDir } = createSwarmEnv(t, {
    workFiles: { 'src/shared.js': 'export const init = 1;\n' },
    handler: async function* (opts) {
      const userText = String(opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '');
      if (userText.includes('SLICE_ONE') || userText.includes('SLICE_TWO')) {
        const tag = userText.includes('SLICE_ONE') ? 'one' : 'two';
        inFlightCount += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlightCount);
        executionOrder.push(`start:${tag}`);
        await new Promise((r) => setTimeout(r, 40));
        executionOrder.push(`end:${tag}`);
        inFlightCount -= 1;
      }
      yield { type: 'text-delta', index: 0, text: 'done' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const sess = direct.createSession({ permissionMode: 'full-access', workspaceRoot: workDir });

  // Conflict policy 'block' fails fast with WRITE_PATH_CONFLICT
  await assert.rejects(
    () =>
      direct.swarmOrchestrator.startRun({
        sessionId: sess.id,
        goal: 'Blocked write conflict test',
        workspaceRoot: workDir,
        budget: { conflictPolicy: 'block' },
        nodes: [
          { nodeKey: 's1', taskType: 'implementation', objective: 'SLICE_ONE', writePaths: ['src/shared.js'] },
          { nodeKey: 's2', taskType: 'implementation', objective: 'SLICE_TWO', targetFiles: ['src/shared.js'] },
        ],
      }),
    (err) => err?.code === 'WRITE_PATH_CONFLICT',
  );

  // Default policy serializes overlapping siblings dynamically inside orchestrator
  const serializedRun = await direct.swarmOrchestrator.startRun({
    sessionId: sess.id,
    goal: 'Serialized write conflict test',
    workspaceRoot: workDir,
    maxConcurrency: 2,
    nodes: [
      {
        nodeKey: 's1',
        taskType: 'implementation',
        priority: 20,
        objective: 'SLICE_ONE',
        writePaths: ['src/shared.js'],
      },
      {
        nodeKey: 's2',
        taskType: 'implementation',
        priority: 10,
        objective: 'SLICE_TWO',
        targetFiles: ['src/shared.js'],
      },
    ],
  });

  assert.equal(serializedRun.status, 'completed');
  assert.equal(maxConcurrent, 1, 'Serialized siblings must never overlap in flight');
  assert.deepEqual(executionOrder, ['start:one', 'end:one', 'start:two', 'end:two']);
  const refreshed = direct.swarmOrchestrator.getRun(serializedRun.runId);
  assert.equal(refreshed.strategy?.writeConflictResolution?.mode, 'serialize');
  assert.equal(refreshed.strategy?.writeConflictResolution?.hasConflicts, true);
  const s2Node = refreshed.nodes.find((n) => n.nodeKey === 's2');
  assert.ok(s2Node.dependencies.includes('s1'));
});

test('2. Cross-worker Shared Swarm ACI Digest aggregates upstream metrics bounded <= 1600 chars into mailbox and downstream context', async (t) => {
  // Unit aggregation + decoy filtering + strict <= 1600 bound
  const hugeFiles = Array.from({ length: 120 }, (_, i) => `src/deep/module_${i}_with_long_name_for_budget_test.js`);
  const hugeSymbols = hugeFiles.map((f, i) => `${f}#exportedHandler_${i}`);
  const hugeDecoys = Array.from({ length: 80 }, (_, i) => `vendor/legacy/decoy_${i}_unused_archive.js`);
  const hugeRefs = Array.from({ length: 40 }, (_, i) => ({
    uri: `aci-ref://turn-1/ref-${i}`,
    path: `docs/huge_spec_${i}.md`,
  }));

  const digest = buildSharedAciDigest([
    {
      nodeKey: 'explore-a',
      aciMetrics: {
        admissions: [
          { path: 'src/core/auth.js', decision: 'DIRECT', symbols: ['verifyToken', 'issueSession'] },
          { path: 'src/legacy/decoy_auth.js', decision: 'IRRELEVANT' },
          { path: 'src/core/later_needed.js', decision: 'IRRELEVANT' },
          { path: 'docs/protocol.md', decision: 'DEFER', uri: 'aci-ref://turn-a/protocol' },
        ],
      },
    },
    {
      nodeKey: 'explore-b',
      aciMetrics: {
        admittedCriticalFiles: ['src/core/later_needed.js', ...hugeFiles],
        activeSymbols: hugeSymbols,
        irrelevantDecoyPaths: hugeDecoys,
        deferredRefs: hugeRefs,
      },
    },
  ]);

  assert.ok(digest.startsWith('[Shared Swarm ACI Digest]'));
  assert.ok(digest.length <= 1600, `Expected <= 1600 chars, got ${digest.length}`);
  assert.ok(digest.includes('src/core/auth.js'));
  assert.ok(digest.includes('verifyToken'));
  assert.ok(digest.includes('src/legacy/decoy_auth.js'));
  // A file marked IRRELEVANT by worker A but DIRECT by worker B must NOT stay in decoys
  const decoySection = /IRRELEVANT decoys[^:]*:\s*([^\n]+)/.exec(digest)?.[1] ?? '';
  assert.equal(decoySection.includes('src/core/later_needed.js'), false);

  // Mailbox + Orchestrator end-to-end injection
  const { store, direct, workDir } = createSwarmEnv(t, { gitInit: false });
  const mailbox = new InterAgentMailbox({ store });
  const sess = direct.createSession({ permissionMode: 'full-access', workspaceRoot: workDir });

  // Directly verify InterAgentMailbox.send attaches bounded sharedAciDigest when aciMetrics provided
  await mailbox.send({
    conversationId: 'conv-aci',
    fromAgentId: 'node-up',
    toAgentId: 'node-down',
    kind: 'handoff',
    payload: {
      summary: 'Found core targets',
      aciMetrics: {
        admissions: [
          { path: 'src/target.js', decision: 'DIRECT', symbols: ['computeTax'] },
          { path: 'node_modules_decoy/ignore.js', decision: 'IRRELEVANT' },
          { path: 'docs/tax-rules.md', decision: 'DEFER', refId: 'ref-tax-1' },
        ],
      },
    },
  });
  const receivedMsg = await mailbox.receive('node-down', {});
  assert.ok(receivedMsg?.payload?.sharedAciDigest?.startsWith('[Shared Swarm ACI Digest]'));
  assert.ok(receivedMsg.payload.sharedAciDigest.length <= 1600);
  assert.ok(receivedMsg.payload.sharedAciDigest.includes('src/target.js'));

  // Stub childManager on orchestrator so upstream child turn emits rich aciMetrics
  let capturedDownstreamObjective = '';
  const origSpawn = direct.swarmOrchestrator.childManager.spawn.bind(direct.swarmOrchestrator.childManager);
  direct.swarmOrchestrator.childManager.spawn = async (opts) => {
    if (opts.nodeKey === 'upstream-explore') {
      return {
        childSessionId: sess.id,
        childTurnId: `turn-${opts.nodeKey}`,
        text: 'Discovered auth module structure',
        usage: { inputTokens: 15, outputTokens: 8 },
        steps: 1,
        verifiedPass: null,
        aciMetrics: {
          admissions: [
            { path: 'src/kernel/session.js', decision: 'DIRECT', symbols: ['SessionManager'] },
            { path: 'test/fixtures/noise_decoy.js', decision: 'IRRELEVANT' },
            { path: 'docs/architecture.md', decision: 'DEFER', uri: 'aci-ref://arch-1' },
          ],
        },
      };
    }
    if (opts.nodeKey === 'downstream-implement') {
      capturedDownstreamObjective = opts.objective;
      return {
        childSessionId: sess.id,
        childTurnId: `turn-${opts.nodeKey}`,
        text: 'Applied changes reusing ACI discovery',
        usage: { inputTokens: 12, outputTokens: 6 },
        steps: 1,
        verifiedPass: null,
      };
    }
    return origSpawn(opts);
  };

  const aciRun = await direct.swarmOrchestrator.startRun({
    sessionId: sess.id,
    goal: 'Propagate upstream ACI discoveries downstream',
    workspaceRoot: workDir,
    nodes: [
      {
        nodeKey: 'upstream-explore',
        taskType: 'research',
        objective: 'Explore target files',
        dependencies: [],
      },
      {
        nodeKey: 'downstream-implement',
        taskType: 'research',
        objective: 'Implement based on discoveries',
        dependencies: ['upstream-explore'],
      },
    ],
  });

  assert.equal(aciRun.status, 'completed');
  assert.ok(capturedDownstreamObjective.includes('[Shared Swarm ACI Digest]'));
  assert.ok(capturedDownstreamObjective.includes('src/kernel/session.js'));
  assert.ok(capturedDownstreamObjective.includes('SessionManager'));
  assert.ok(capturedDownstreamObjective.includes('test/fixtures/noise_decoy.js'));
  assert.ok(capturedDownstreamObjective.includes('docs/architecture.md'));

  // Extract digest block alone and verify it respects <= 1600 char bound
  const digestBlockMatch = /\[Shared Swarm ACI Digest\][\s\S]*?(?=\n\nImplement based on discoveries)/.exec(
    capturedDownstreamObjective,
  );
  assert.ok(digestBlockMatch);
  assert.ok(digestBlockMatch[0].length <= 1600);
});

test('3a. Artifacts preserve executable 100755 mode and cleanly 3-way merge disjoint hunks via git merge-file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-us-art3way-'));
  const workDir = join(root, 'repo');
  const artRoot = join(root, 'artifacts');
  const dataDir = join(root, 'data');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(artRoot, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const baseScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '# line 3 header comment',
    'STEP_A=base_a',
    'echo "middle 1"',
    'echo "middle 2"',
    'echo "middle 3"',
    'echo "middle 4"',
    'STEP_B=base_b',
    'echo "done"',
    '',
  ].join('\n');

  initGitRepo(
    workDir,
    {
      'bin/run.sh': baseScript,
      'lib/plain.txt': 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\n',
    },
    ['bin/run.sh'],
  );

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const manager = new SwarmArtifactManager({ store, storageRoot: artRoot });

  // Direct mergeFileThreeWay smoke check
  const topEdit = Buffer.from('A_NEW\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\n', 'utf8');
  const botEdit = Buffer.from('line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nB_NEW\n', 'utf8');
  const baseText = Buffer.from('line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\n', 'utf8');
  const disjointMerge = mergeFileThreeWay({ currentBuf: topEdit, baseBuf: baseText, incomingBuf: botEdit });
  assert.equal(disjointMerge.ok, true);
  assert.equal(disjointMerge.conflictCount, 0);
  assert.equal(
    disjointMerge.mergedBuffer.toString('utf8'),
    'A_NEW\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nB_NEW\n',
  );

  // Two isolated worktrees edit disjoint hunks of BOTH bin/run.sh (100755) and lib/plain.txt (100644)
  const wt1 = join(root, 'wt1');
  const wt2 = join(root, 'wt2');
  const wtVerify = join(root, 'wtVerify');
  execFileSync('git', ['-C', workDir, 'worktree', 'add', '--detach', wt1, 'HEAD'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workDir, 'worktree', 'add', '--detach', wt2, 'HEAD'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workDir, 'worktree', 'add', '--detach', wtVerify, 'HEAD'], { stdio: 'ignore' });

  const runId = 'run-three-way-exec';
  store.db
    .prepare(
      `INSERT INTO swarm_runs(id, sessionId, goal, status, strategyJson, budgetJson, permissionMode, createdAt, updatedAt)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(runId, 'sess-3way', '3-way merge exec', 'running', '{}', '{}', 'full-access', Date.now(), Date.now());

  writeFileSync(join(wt1, 'bin/run.sh'), baseScript.replace('STEP_A=base_a', 'STEP_A=from_worker_1'), 'utf8');
  writeFileSync(
    join(wt1, 'lib/plain.txt'),
    'TOP_BY_W1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\n',
    'utf8',
  );
  if (process.platform !== 'win32') {
    chmodSync(join(wt1, 'bin/run.sh'), 0o755);
  }

  writeFileSync(join(wt2, 'bin/run.sh'), baseScript.replace('STEP_B=base_b', 'STEP_B=from_worker_2'), 'utf8');
  writeFileSync(
    join(wt2, 'lib/plain.txt'),
    'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nBOT_BY_W2\n',
    'utf8',
  );
  if (process.platform !== 'win32') {
    chmodSync(join(wt2, 'bin/run.sh'), 0o755);
  }

  const art1 = await manager.archiveWorktree({
    runId,
    nodeId: 'node-w1',
    nodeKey: 'worker-1',
    workspaceRoot: workDir,
    worktreePath: wt1,
  });
  const art2 = await manager.archiveWorktree({
    runId,
    nodeId: 'node-w2',
    nodeKey: 'worker-2',
    workspaceRoot: workDir,
    worktreePath: wt2,
  });

  const runEntry1 = art1.files.find((f) => f.path === 'bin/run.sh');
  const plainEntry1 = art1.files.find((f) => f.path === 'lib/plain.txt');
  assert.equal(runEntry1.mode, '100755');
  assert.equal(runEntry1.executable, true);
  assert.equal(runEntry1.posixMode, 0o755);
  assert.equal(isExecutableEntry(runEntry1), true);
  assert.equal(entryPosixMode(runEntry1), 0o755);
  assert.equal(plainEntry1.mode, '100644');
  assert.equal(plainEntry1.executable, false);

  // Overlay BOTH sibling artifacts onto verification worktree via Git 3-way merge
  const overlayRes = manager.applyArtifactsToWorktree([art1, art2], wtVerify, {
    dependenciesByNodeKey: { 'worker-1': [], 'worker-2': [] },
  });
  assert.equal(overlayRes.ok, true);
  assert.equal(overlayRes.conflicts.length, 0);
  assert.equal(overlayRes.mergeConflicts.length, 0);

  const mergedScript = readFileSync(join(wtVerify, 'bin/run.sh'), 'utf8');
  assert.ok(mergedScript.includes('STEP_A=from_worker_1'));
  assert.ok(mergedScript.includes('STEP_B=from_worker_2'));
  assert.equal(mergedScript.includes('<<<<<<<'), false);
  const mergedPlain = readFileSync(join(wtVerify, 'lib/plain.txt'), 'utf8');
  assert.ok(mergedPlain.includes('TOP_BY_W1'));
  assert.ok(mergedPlain.includes('BOT_BY_W2'));

  if (process.platform !== 'win32') {
    assert.notEqual(statSync(join(wtVerify, 'bin/run.sh')).mode & 0o111, 0);
    assert.equal(statSync(join(wtVerify, 'lib/plain.txt')).mode & 0o111, 0);
  }

  // Rehydrate single artifact preserves 100755
  const wtRehydrate = join(root, 'wtRehydrate');
  execFileSync('git', ['-C', workDir, 'worktree', 'add', '--detach', wtRehydrate, 'HEAD'], { stdio: 'ignore' });
  const rehydrated = manager.rehydrateArtifactToWorktree(art1.id, wtRehydrate);
  assert.equal(rehydrated.ok, true);
  if (process.platform !== 'win32') {
    assert.notEqual(statSync(join(wtRehydrate, 'bin/run.sh')).mode & 0o111, 0);
  }

  // applyToParent with concurrent disjoint parent edit ALSO succeeds cleanly via git merge-file + preserves 100755
  writeFileSync(join(workDir, 'bin/run.sh'), baseScript.replace('STEP_B=base_b', 'STEP_B=from_parent'), 'utf8');
  const applyRes = manager.applyToParent(art1.id, workDir, {
    approved: true,
    permissionMode: 'full-access',
  });
  assert.equal(applyRes.ok, true);
  assert.equal(applyRes.conflicts.length, 0);
  assert.equal(applyRes.mergeConflicts.length, 0);
  const parentMerged = readFileSync(join(workDir, 'bin/run.sh'), 'utf8');
  assert.ok(parentMerged.includes('STEP_A=from_worker_1'));
  assert.ok(parentMerged.includes('STEP_B=from_parent'));
  if (process.platform !== 'win32') {
    assert.notEqual(statSync(join(workDir, 'bin/run.sh')).mode & 0o111, 0);
  }

  // Cleanup git worktrees before removing root
  for (const wt of [wt1, wt2, wtVerify, wtRehydrate]) {
    execFileSync('git', ['-C', workDir, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' });
  }
  store.close();
  rmSafe(root);
});

test('3b. Git 3-way merge reports mergeConflicts cleanly without clobbering files on overlapping edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-us-artconflict-'));
  const workDir = join(root, 'repo');
  const artRoot = join(root, 'artifacts');
  const dataDir = join(root, 'data');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(artRoot, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const baseFile = 'line1\nline2\ntarget = baseline\nline4\nline5\n';
  initGitRepo(workDir, { 'config.txt': baseFile });

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const manager = new SwarmArtifactManager({ store, storageRoot: artRoot });

  const wtA = join(root, 'wtA');
  const wtB = join(root, 'wtB');
  const wtOverlay = join(root, 'wtOverlay');
  execFileSync('git', ['-C', workDir, 'worktree', 'add', '--detach', wtA, 'HEAD'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workDir, 'worktree', 'add', '--detach', wtB, 'HEAD'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workDir, 'worktree', 'add', '--detach', wtOverlay, 'HEAD'], { stdio: 'ignore' });

  const runId = 'run-three-way-conflict';
  store.db
    .prepare(
      `INSERT INTO swarm_runs(id, sessionId, goal, status, strategyJson, budgetJson, permissionMode, createdAt, updatedAt)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(runId, 'sess-conflict', '3-way conflict', 'running', '{}', '{}', 'full-access', Date.now(), Date.now());

  writeFileSync(join(wtA, 'config.txt'), baseFile.replace('target = baseline', 'target = branchA'), 'utf8');
  writeFileSync(join(wtB, 'config.txt'), baseFile.replace('target = baseline', 'target = branchB'), 'utf8');

  const artA = await manager.archiveWorktree({
    runId,
    nodeId: 'node-ba',
    nodeKey: 'branch-a',
    workspaceRoot: workDir,
    worktreePath: wtA,
  });
  const artB = await manager.archiveWorktree({
    runId,
    nodeId: 'node-bb',
    nodeKey: 'branch-b',
    workspaceRoot: workDir,
    worktreePath: wtB,
  });

  // Overlay overlapping edits onto wtOverlay -> fails closed with mergeConflicts and leaves branchA intact (not overwritten by branchB)
  const overlayConflict = manager.applyArtifactsToWorktree([artA, artB], wtOverlay, {
    dependenciesByNodeKey: { 'branch-a': [], 'branch-b': [] },
  });
  assert.equal(overlayConflict.ok, false);
  assert.ok(overlayConflict.conflicts.length >= 1);
  assert.ok(overlayConflict.mergeConflicts.length >= 1);
  assert.equal(overlayConflict.mergeConflicts[0].mergeConflict, true);
  assert.ok(String(overlayConflict.mergeConflicts[0].conflictMarkers || '').includes('<<<<<<<'));
  // Ensure existing branch-a content in wtOverlay was NOT silently overwritten with branch-b
  assert.equal(
    readFileSync(join(wtOverlay, 'config.txt'), 'utf8'),
    baseFile.replace('target = baseline', 'target = branchA'),
  );

  // applyToParent against overlapping parent edit reports mergeConflicts and leaves parent file untouched!
  const parentEdit = baseFile.replace('target = baseline', 'target = localParent');
  writeFileSync(join(workDir, 'config.txt'), parentEdit, 'utf8');
  const parentConflict = manager.applyToParent(artB.id, workDir, {
    approved: true,
    permissionMode: 'full-access',
  });
  assert.equal(parentConflict.ok, false);
  assert.equal(parentConflict.status, 'conflict');
  assert.ok(parentConflict.mergeConflicts.length >= 1);
  assert.equal(parentConflict.mergeConflicts[0].reason, 'parent_modified_concurrently');
  assert.equal(parentConflict.mergeConflicts[0].mergeConflict, true);
  assert.equal(readFileSync(join(workDir, 'config.txt'), 'utf8'), parentEdit);

  for (const wt of [wtA, wtB, wtOverlay]) {
    execFileSync('git', ['-C', workDir, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' });
  }
  store.close();
  rmSafe(root);
});

test('4. Terminal SQLite CAS rejects late overwrites and deadline expiration preserves verified completed artifacts with degradedTimeout', async (t) => {
  const { store, direct, workDir } = createSwarmEnv(t, {
    workFiles: { 'src/keep.js': 'export const keep = 0;\n' },
  });

  const sess = direct.createSession({ permissionMode: 'full-access', workspaceRoot: workDir });
  const now = Date.now();
  const runId = 'run-cas-degrade';
  const nodeDoneId = 'node-done-1';
  const nodeSlowId = 'node-slow-2';
  const nodeWaitId = 'node-wait-3';

  store.db
    .prepare(
      `INSERT INTO swarm_runs(id, sessionId, goal, status, currentPhase, strategyJson, permissionMode, workspaceRoot, budgetJson, createdAt, updatedAt)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      runId,
      sess.id,
      'CAS and deadline graceful degradation test',
      SWARM_RUN_STATES.RUNNING,
      'running',
      '{}',
      'full-access',
      workDir,
      JSON.stringify({ maxDurationMs: 500 }),
      now - 5000,
      now - 5000,
    );

  // Create real verified artifact for already-completed upstream node
  const wtDone = join(workDir, '..', 'wt-done');
  execFileSync('git', ['-C', workDir, 'worktree', 'add', '--detach', wtDone, 'HEAD'], { stdio: 'ignore' });
  writeFileSync(join(wtDone, 'src/keep.js'), 'export const keep = 42;\n', 'utf8');
  const verifiedArt = await direct.swarmOrchestrator.artifactManager.archiveWorktree({
    runId,
    nodeId: nodeDoneId,
    nodeKey: 'done-impl',
    workspaceRoot: workDir,
    worktreePath: wtDone,
  });
  execFileSync('git', ['-C', workDir, 'worktree', 'remove', '--force', wtDone], { stdio: 'ignore' });

  const insNode = store.db.prepare(
    `INSERT INTO swarm_nodes(id, runId, nodeKey, agentProfileId, model, provider, objective, acceptance,
       dependenciesJson, toolAllowJson, permissionMode, taskType, isolationMode, status,
       resultText, artifactUrisJson, latestArtifactId, createdAt, updatedAt)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insNode.run(
    nodeDoneId,
    runId,
    'done-impl',
    'coder',
    'coder-model',
    'pool',
    'Completed upstream work',
    'done',
    '[]',
    '["write_file"]',
    'full-access',
    'implementation',
    'worktree',
    SWARM_NODE_STATES.COMPLETED,
    'Completed keep.js change',
    JSON.stringify([verifiedArt.uri]),
    verifiedArt.id,
    now - 4000,
    now - 3000,
  );
  insNode.run(
    nodeSlowId,
    runId,
    'slow-impl',
    'coder',
    'coder-model',
    'pool',
    'Still running when deadline fires',
    'done',
    '[]',
    '["write_file"]',
    'full-access',
    'implementation',
    'worktree',
    SWARM_NODE_STATES.RUNNING,
    null,
    '[]',
    null,
    now - 4000,
    now - 3000,
  );
  insNode.run(
    nodeWaitId,
    runId,
    'downstream-verify',
    'verifier',
    'verifier-model',
    'pool',
    'Wait downstream',
    'done',
    '["done-impl","slow-impl"]',
    '["bash"]',
    'full-access',
    'verification',
    'worktree',
    SWARM_NODE_STATES.PENDING,
    null,
    '[]',
    null,
    now - 4000,
    now - 3000,
  );

  // 4a. CAS blocks overwriting already-completed node
  const staleFail = transitionNodeTerminalCas(store, direct.eventRouter, nodeDoneId, SWARM_NODE_STATES.FAILED, {
    patch: { errorCode: 'LATE_TIMEOUT', errorMessage: 'stale timeout tried to fail completed node' },
  });
  assert.equal(staleFail.changed, false);
  assert.equal(staleFail.casRejected, true);
  assert.equal(staleFail.status, SWARM_NODE_STATES.COMPLETED);
  assert.throws(
    () =>
      transitionNodeTerminalCas(store, direct.eventRouter, nodeDoneId, SWARM_NODE_STATES.CANCELLED, {
        throwOnTerminal: true,
      }),
    (err) => err?.code === 'INVALID_SWARM_TRANSITION' && err?.detail?.casConflict === true,
  );

  // Even direct transitionSwarmNode rejects overwriting terminal node
  assert.throws(
    () =>
      transitionSwarmNode(store, null, nodeDoneId, SWARM_NODE_STATES.CANCELLED, {
        patch: { errorCode: 'LATE_CANCEL' },
      }),
    (err) => err?.code === 'INVALID_SWARM_TRANSITION',
  );
  assert.equal(
    store.db.prepare('SELECT status, resultText FROM swarm_nodes WHERE id=?').get(nodeDoneId).status,
    SWARM_NODE_STATES.COMPLETED,
  );

  // 4b. Deadline graceful degradation preserves done-impl + its artifact and cancels unfinished nodes
  const casEvents = [];
  direct.eventRouter.subscribe(sess.id, (evt) => casEvents.push(evt));
  const recoveryOut = recoverInterruptedSwarmRuns({
    store,
    jobQueue: direct.swarmOrchestrator.jobQueue,
    artifactManager: direct.swarmOrchestrator.artifactManager,
    eventRouter: direct.eventRouter,
    getRun: (id) => direct.swarmOrchestrator.getRun(id),
    cancelRun: (id, opts) => direct.swarmOrchestrator.cancelRun(id, opts),
  });
  assert.equal(recoveryOut.timedOutRuns, 1);

  const timeoutEvent = casEvents.find((e) => e.type === 'swarm/run_completed' && e.data?.degradedTimeout);
  assert.equal(timeoutEvent?.data?.degradedTimeout, true);
  assert.equal(timeoutEvent?.data?.preservedArtifacts?.length, 1);
  assert.equal(timeoutEvent?.data?.preservedArtifacts?.[0]?.artifactId, verifiedArt.id);

  const degradedRun = direct.swarmOrchestrator.getRun(runId);
  assert.equal(degradedRun.status, SWARM_RUN_STATES.CANCELLED);
  assert.equal(degradedRun.errorCode, 'BUDGET_DURATION_EXCEEDED');
  assert.equal(degradedRun.verdict?.degradedTimeout, true);
  assert.ok(Array.isArray(degradedRun.verdict?.preservedArtifacts));
  assert.equal(degradedRun.verdict.preservedArtifacts.length, 1);
  assert.equal(degradedRun.verdict.preservedArtifacts[0].artifactId, verifiedArt.id);
  assert.equal(degradedRun.verdict.preservedArtifacts[0].nodeKey, 'done-impl');

  // Verified completed node remains untouched while running/pending became cancelled
  const byKey = new Map(degradedRun.nodes.map((n) => [n.nodeKey, n]));
  assert.equal(byKey.get('done-impl').status, SWARM_NODE_STATES.COMPLETED);
  assert.equal(byKey.get('slow-impl').status, SWARM_NODE_STATES.CANCELLED);
  assert.equal(byKey.get('downstream-verify').status, SWARM_NODE_STATES.CANCELLED);

  // Delivery package exposes degradedTimeout & preservedArtifacts
  const delivery = direct.swarmOrchestrator.buildRunDeliveryPackage(runId);
  assert.equal(delivery.degradedTimeout, true);
  assert.equal(delivery.preservedArtifacts.length, 1);
  assert.equal(delivery.preservedArtifacts[0].uri, verifiedArt.uri);

  // 4c. Atomic run terminal CAS rejects late overwrite of terminal run
  const lateRunOverwrite = transitionRunTerminalCas(store, runId, SWARM_RUN_STATES.COMPLETED, {
    patch: { errorCode: null, verdictJson: JSON.stringify({ verdict: 'pass', accepted: true }) },
  });
  assert.equal(lateRunOverwrite.changed, false);
  assert.equal(lateRunOverwrite.casRejected, true);
  assert.equal(lateRunOverwrite.status, SWARM_RUN_STATES.CANCELLED);
  assert.throws(
    () =>
      transitionRunTerminalCas(store, runId, SWARM_RUN_STATES.FAILED, {
        throwOnTerminal: true,
      }),
    (err) => err?.code === 'INVALID_SWARM_TRANSITION' && err?.detail?.casConflict === true,
  );
  assert.equal(
    store.db.prepare('SELECT errorCode FROM swarm_runs WHERE id=?').get(runId).errorCode,
    'BUDGET_DURATION_EXCEEDED',
  );
});

test('5a. evaluateReviewerHardGate and validateReviewerExecution refuse synthetic pass without real git diff or exitCode===0', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-us-revgate-'));
  const workDir = join(root, 'repo');
  mkdirSync(workDir, { recursive: true });
  initGitRepo(workDir, {
    'package.json': JSON.stringify({ name: 'gate-unit', type: 'module' }),
    'src/app.js': 'export const ok = true;\n',
    'test/app.test.js': 'import test from "node:test"; test("ok", () => {});\n',
  });

  const evidenceBase = {
    runId: 'run-gate-1',
    reviewerNodeKey: 'rev',
    sourceNodes: [{ nodeKey: 'impl', taskType: 'implementation', status: 'completed' }],
    artifacts: [],
    receipts: [{ receiptId: 'rec-bash-1', toolName: 'bash', status: 'finished', exitCode: 0 }],
    turnVerdicts: [],
  };
  const digest = computeReviewerEvidenceDigest(evidenceBase);
  const rawPass = JSON.stringify({
    schemaVersion: REVIEWER_SCHEMA_VERSION,
    verdict: 'pass',
    summary: 'Implemented changes in src/app.js and all tests pass.',
    evidenceDigest: digest,
    checkedArtifacts: [],
    evidenceRefs: ['rec-bash-1'],
    findings: [],
  });

  // 1. Clean repo (0 real git diff) -> hard gate downgrades pass -> fail
  const noDiffValidation = validateReviewerExecution({
    rawText: rawPass,
    reviewerEvidence: evidenceBase,
    toolReceipts: [],
    workspaceRoot: workDir,
    claimedMutations: true,
    requireTestExecution: true,
  });
  assert.equal(noDiffValidation.valid, false);
  assert.equal(noDiffValidation.code, 'REVIEWER_HARD_GATE_FAILED');
  assert.equal(noDiffValidation.status, 'fail');
  assert.equal(noDiffValidation.reviewerVerification.verifiedGitDiff, false);
  assert.equal(noDiffValidation.reviewerVerification.diffFileCount, 0);
  assert.equal(noDiffValidation.reviewerVerification.verifiedTestExitCode, 0);
  assert.equal(noDiffValidation.reviewerVerification.hardGatePassed, false);
  assert.ok(noDiffValidation.reviewerVerification.reasons.includes('MISSING_REAL_GIT_DIFF'));

  // 2. Real git diff exists, but test execution failed (exitCode=1) -> downgraded to fail
  writeFileSync(join(workDir, 'src/app.js'), 'export const ok = false;\nexport const patched = true;\n', 'utf8');
  const failingReceiptEvidence = {
    ...evidenceBase,
    receipts: [{ receiptId: 'rec-bash-fail', toolName: 'bash', status: 'failed', exitCode: 1 }],
  };
  const failingDigest = computeReviewerEvidenceDigest(failingReceiptEvidence);
  const failingTestValidation = validateReviewerExecution({
    rawText: JSON.stringify({
      schemaVersion: REVIEWER_SCHEMA_VERSION,
      verdict: 'pass',
      summary: 'Updated src/app.js cleanly.',
      evidenceDigest: failingDigest,
      checkedArtifacts: [],
      evidenceRefs: ['rec-bash-fail'],
      findings: [],
    }),
    reviewerEvidence: failingReceiptEvidence,
    toolReceipts: [],
    workspaceRoot: workDir,
  });
  assert.equal(failingTestValidation.valid, false);
  assert.equal(failingTestValidation.code, 'REVIEWER_HARD_GATE_FAILED');
  assert.equal(failingTestValidation.status, 'fail');
  assert.equal(failingTestValidation.reviewerVerification.verifiedGitDiff, true);
  assert.ok(failingTestValidation.reviewerVerification.diffFileCount >= 1);
  assert.ok(failingTestValidation.reviewerVerification.diffDigest);
  assert.equal(failingTestValidation.reviewerVerification.verifiedTestExitCode, 1);
  assert.equal(failingTestValidation.reviewerVerification.hardGatePassed, false);
  assert.ok(failingTestValidation.reviewerVerification.reasons.includes('TEST_EXIT_CODE_FAILED:1'));

  // 3. Real git diff exists, NO test execution receipt at all -> downgraded to fail
  const missingTestGate = evaluateReviewerHardGate({
    parsedVerdict: { verdict: 'pass', summary: 'All tests passed after editing src/app.js' },
    reviewerEvidence: { ...evidenceBase, receipts: [] },
    workspaceRoot: workDir,
  });
  assert.equal(missingTestGate.hardGatePassed, false);
  assert.equal(missingTestGate.verdict, 'fail');
  assert.equal(missingTestGate.verifiedTestExitCode, null);
  assert.ok(missingTestGate.reasons.includes('MISSING_VERIFIED_TEST_EXIT_CODE'));

  // 4. Both real git diff (>0 files + digest) AND bash exitCode === 0 -> hardGatePassed: true
  const validValidation = validateReviewerExecution({
    rawText: rawPass,
    reviewerEvidence: evidenceBase,
    toolReceipts: [],
    workspaceRoot: workDir,
  });
  assert.equal(validValidation.valid, true);
  assert.equal(validValidation.status, 'pass');
  assert.equal(validValidation.reviewerVerification.verifiedGitDiff, true);
  assert.ok(validValidation.reviewerVerification.diffFileCount >= 1);
  assert.ok(validValidation.reviewerVerification.diffDigest);
  assert.equal(validValidation.reviewerVerification.verifiedTestExitCode, 0);
  assert.equal(validValidation.reviewerVerification.hardGatePassed, true);

  rmSafe(root);
});

test('5b. End-to-end Orchestrator enforces Reviewer hard gate and exposes reviewerVerification in events and delivery package', async (t) => {
  const testCmd = buildSubshellNodeTestCmd('test/math.test.js');
  const events = [];

  // Case 1: Impl writes NO real changes (0 git diff) while test runs, synthetic reviewer returns 'pass' -> refused & downgraded
  const envNoDiff = createSwarmEnv(t, {
    workFiles: {
      'package.json': JSON.stringify({ name: 'rev-e2e-nodiff', type: 'module' }),
      'src/math.js': 'export const add = (a, b) => a + b;\n',
      'test/math.test.js': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { add } from '../src/math.js';",
        "test('adds', () => { assert.equal(add(1, 2), 3); });",
      ].join('\n'),
    },
    handler: async function* (opts) {
      const userText = String(opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '');
      const lastRole = opts.messages.at(-1)?.role;
      if (userText.includes('[Durable evidence manifest]')) {
        const match = /\[Durable evidence manifest\]\s*\n+([\s\S]+)$/.exec(userText);
        const manifest = match ? JSON.parse(match[1].trim()) : { artifacts: [], receipts: [] };
        const art = manifest.artifacts?.[0];
        if (lastRole !== 'tool' && art) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-read-noop',
              name: 'read_swarm_artifact',
              arguments: JSON.stringify({ uri: art.uri }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield {
          type: 'text-delta',
          index: 0,
          text: JSON.stringify({
            schemaVersion: REVIEWER_SCHEMA_VERSION,
            verdict: 'pass',
            summary: 'Implemented src/math.js updates and verified tests pass.',
            evidenceDigest: computeReviewerEvidenceDigest(manifest),
            checkedArtifacts: art ? [art.uri] : [],
            evidenceRefs: [manifest.receipts?.[0]?.receiptId || 'verified'],
            findings: [],
          }),
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      if (lastRole !== 'tool' && userText.includes('RUN_TEST_ONLY')) {
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: 'tc-bash-1', name: 'bash', arguments: JSON.stringify({ command: testCmd }) },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'No edits written' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const sess1 = envNoDiff.direct.createSession({ permissionMode: 'full-access', workspaceRoot: envNoDiff.workDir });
  envNoDiff.direct.eventRouter.subscribe(sess1.id, (evt) => events.push(evt));

  const failedNoDiffRun = await envNoDiff.direct.swarmOrchestrator.startRun({
    sessionId: sess1.id,
    goal: 'Enforce real git diff on reviewer',
    workspaceRoot: envNoDiff.workDir,
    parentPermissionMode: 'full-access',
    budget: { strictReviewerSchema: true, reviewerHardGate: true },
    nodes: [
      { nodeKey: 'impl-noop', taskType: 'implementation', objective: 'NOOP_IMPL', isolationMode: 'worktree' },
      { nodeKey: 'verify-tests', taskType: 'verification', objective: 'RUN_TEST_ONLY', dependencies: ['impl-noop'], isolationMode: 'worktree' },
      { nodeKey: 'final-review', taskType: 'review', objective: 'Review changes', dependencies: ['impl-noop', 'verify-tests'], isolationMode: 'shared_readonly' },
    ],
  });

  assert.equal(failedNoDiffRun.status, 'failed');
  assert.equal(failedNoDiffRun.verdict?.verdict, 'fail');
  assert.equal(failedNoDiffRun.verdict?.accepted, false);
  assert.equal(failedNoDiffRun.verdict?.reviewerVerification?.verifiedGitDiff, false);
  assert.equal(failedNoDiffRun.verdict?.reviewerVerification?.diffFileCount, 0);
  assert.equal(failedNoDiffRun.verdict?.reviewerVerification?.verifiedTestExitCode, 0);
  assert.equal(failedNoDiffRun.verdict?.reviewerVerification?.hardGatePassed, false);
  assert.ok(failedNoDiffRun.verdict?.reviewerVerification?.reasons?.includes('MISSING_REAL_GIT_DIFF'));

  const pkg1 = envNoDiff.direct.swarmOrchestrator.buildRunDeliveryPackage(failedNoDiffRun.runId);
  assert.equal(pkg1.reviewerVerification?.hardGatePassed, false);
  assert.equal(pkg1.reviewerVerdicts[0]?.status, 'fail');
  assert.equal(pkg1.reviewerVerdicts[0]?.reviewerVerification?.hardGatePassed, false);

  const nodeEvt1 = events.find((e) => e.type === 'swarm/node_updated' && e.data?.reviewerVerification);
  assert.equal(nodeEvt1?.data?.reviewerVerification?.hardGatePassed, false);
  const runEvt1 = events.find((e) => e.type === 'swarm/run_completed' && e.data?.reviewerVerification);
  assert.equal(runEvt1?.data?.reviewerVerification?.hardGatePassed, false);

  // Case 2: Real git diff + passing bash test (exitCode=0) -> hardGatePassed: true and run completes
  const eventsPass = [];
  const envPass = createSwarmEnv(t, {
    workFiles: {
      'package.json': JSON.stringify({ name: 'rev-e2e-pass', type: 'module' }),
      'src/math.js': 'export const add = (a, b) => 0;\n',
      'test/math.test.js': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { add } from '../src/math.js';",
        "test('adds', () => { assert.equal(add(1, 2), 3); });",
      ].join('\n'),
    },
    handler: async function* (opts) {
      const userText = String(opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '');
      const lastRole = opts.messages.at(-1)?.role;
      if (userText.includes('[Durable evidence manifest]')) {
        const match = /\[Durable evidence manifest\]\s*\n+([\s\S]+)$/.exec(userText);
        const manifest = match ? JSON.parse(match[1].trim()) : { artifacts: [], receipts: [] };
        const art = manifest.artifacts?.find((a) => a.nodeKey === 'impl-real');
        if (lastRole !== 'tool' && art) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-read-real',
              name: 'read_swarm_artifact',
              arguments: JSON.stringify({ uri: art.uri, path: 'src/math.js' }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield {
          type: 'text-delta',
          index: 0,
          text: JSON.stringify({
            schemaVersion: REVIEWER_SCHEMA_VERSION,
            verdict: 'pass',
            summary: 'Verified src/math.js fix and test exitCode === 0.',
            evidenceDigest: computeReviewerEvidenceDigest(manifest),
            checkedArtifacts: art ? [art.uri] : [],
            evidenceRefs: [manifest.receipts?.[0]?.receiptId || 'verified'],
            findings: [],
          }),
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      if (lastRole !== 'tool') {
        if (userText.includes('REAL_EDIT')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-write-real',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'src/math.js', content: 'export const add = (a, b) => a + b;\n' }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (userText.includes('RUN_TEST_PASS')) {
          yield {
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call', id: 'tc-bash-pass', name: 'bash', arguments: JSON.stringify({ command: testCmd }) },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
      }
      yield { type: 'text-delta', index: 0, text: 'done' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const sess2 = envPass.direct.createSession({ permissionMode: 'full-access', workspaceRoot: envPass.workDir });
  envPass.direct.eventRouter.subscribe(sess2.id, (evt) => eventsPass.push(evt));

  const passedRun = await envPass.direct.swarmOrchestrator.startRun({
    sessionId: sess2.id,
    goal: 'Pass hard gate with real git diff and passing tests',
    workspaceRoot: envPass.workDir,
    parentPermissionMode: 'full-access',
    budget: { strictReviewerSchema: true, reviewerHardGate: true },
    nodes: [
      { nodeKey: 'impl-real', taskType: 'implementation', objective: 'REAL_EDIT', isolationMode: 'worktree' },
      { nodeKey: 'verify-pass', taskType: 'verification', objective: 'RUN_TEST_PASS', dependencies: ['impl-real'], isolationMode: 'worktree' },
      { nodeKey: 'final-review', taskType: 'review', objective: 'Review real diff and test pass', dependencies: ['impl-real', 'verify-pass'], isolationMode: 'shared_readonly' },
    ],
  });

  assert.equal(passedRun.status, 'completed');
  assert.equal(passedRun.verdict?.verdict, 'pass');
  assert.equal(passedRun.verdict?.accepted, true);
  assert.equal(passedRun.verdict?.reviewerVerification?.verifiedGitDiff, true);
  assert.ok(passedRun.verdict?.reviewerVerification?.diffFileCount >= 1);
  assert.ok(passedRun.verdict?.reviewerVerification?.diffDigest);
  assert.equal(passedRun.verdict?.reviewerVerification?.verifiedTestExitCode, 0);
  assert.equal(passedRun.verdict?.reviewerVerification?.hardGatePassed, true);

  const pkg2 = envPass.direct.swarmOrchestrator.buildRunDeliveryPackage(passedRun.runId);
  assert.equal(pkg2.reviewerVerification?.hardGatePassed, true);
  assert.equal(pkg2.reviewerVerdicts[0]?.reviewerVerification?.hardGatePassed, true);

  const runEvt2 = eventsPass.find((e) => e.type === 'swarm/run_completed' && e.data?.reviewerVerification);
  assert.equal(runEvt2?.data?.reviewerVerification?.hardGatePassed, true);
  assert.equal(runEvt2?.data?.reviewerVerification?.verifiedTestExitCode, 0);
});
