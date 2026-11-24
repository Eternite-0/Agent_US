import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

import { Store } from '../../src/store.js';
import { AccountPool } from '../../src/pool.js';
import { DirectAgentRuntime } from '../../src/direct-agent.js';
import {
  SwarmArtifactManager,
  extractConflictBlocks,
  hasUnresolvedConflictMarkers,
  mergeFileThreeWay,
} from '../../src/swarm/artifacts.js';
import { evaluateConflictResolutionGate } from '../../src/swarm/reviewer.js';

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

function initGitRepo(workDir, files = {}) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(workDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  execFileSync('git', ['init'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'conflict-26@example.test'], {
    cwd: workDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Conflict 26'], {
    cwd: workDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'core.filemode', 'false'], {
    cwd: workDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['add', '-A'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'baseline commit'], {
    cwd: workDir,
    stdio: 'ignore',
  });
}

function createSwarmEnv(t, { workFiles = {}, handler, models = ['coder-model'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-us-cr26-'));
  const dataDir = join(root, 'data');
  const workDir = join(root, 'work');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  initGitRepo(workDir, workFiles);

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'custom-openai',
    label: 'Conflict 26 Pool',
    endpoint: 'https://api.example.invalid/v1',
    credential: 'sk-test-cr26',
    models,
  });
  pool.setDefaultModel(models[0]);

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: new MockSwarmAdapter(handler),
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

const BASE_CONFIG_JS = [
  'export const CONFIG = {',
  '  host: "localhost",',
  '  features: {',
  '    baseFlag: true,',
  '  },',
  '  retries: 2,',
  '};',
  '',
].join('\n');

const BRANCH_A_CONFIG_JS = [
  'export const CONFIG = {',
  '  host: "localhost",',
  '  features: {',
  '    baseFlag: true,',
  '    alphaMode: true,',
  '  },',
  '  retries: 2,',
  '};',
  '',
].join('\n');

const BRANCH_B_CONFIG_JS = [
  'export const CONFIG = {',
  '  host: "localhost",',
  '  features: {',
  '    baseFlag: true,',
  '    betaMode: true,',
  '  },',
  '  retries: 2,',
  '};',
  '',
].join('\n');

const RESOLVED_CONFIG_JS = [
  'export const CONFIG = {',
  '  host: "localhost",',
  '  features: {',
  '    baseFlag: true,',
  '    alphaMode: true,',
  '    betaMode: true,',
  '  },',
  '  retries: 2,',
  '};',
  '',
].join('\n');

const CONFIG_TEST_JS = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { CONFIG } from '../src/config.js';",
  "test('preserves both alphaMode and betaMode', () => {",
  '  assert.equal(CONFIG.features.baseFlag, true);',
  '  assert.equal(CONFIG.features.alphaMode, true);',
  '  assert.equal(CONFIG.features.betaMode, true);',
  '});',
  '',
].join('\n');

test('mergeFileThreeWay and extractConflictBlocks parse structured conflict hunks without clobbering either side', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cr26-blocks-'));
  const workDir = join(root, 'repo');
  const artRoot = join(root, 'artifacts');
  const dataDir = join(root, 'data');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(artRoot, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  t.after(() => rmSafe(root));

  initGitRepo(workDir, { 'src/config.js': BASE_CONFIG_JS });
  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => store.close());
  const manager = new SwarmArtifactManager({ store, storageRoot: artRoot });

  const mergeRes = mergeFileThreeWay({
    currentBuf: Buffer.from(BRANCH_A_CONFIG_JS, 'utf8'),
    baseBuf: Buffer.from(BASE_CONFIG_JS, 'utf8'),
    incomingBuf: Buffer.from(BRANCH_B_CONFIG_JS, 'utf8'),
    labelCurrent: 'branch-a',
    labelBase: 'base',
    labelIncoming: 'branch-b',
  });
  assert.equal(mergeRes.ok, false);
  assert.equal(mergeRes.conflictCount, 1);
  assert.equal(mergeRes.conflictBlocks.length, 1);
  const block = mergeRes.conflictBlocks[0];
  assert.ok(block.startLine >= 1 && block.endLine > block.startLine);
  assert.match(block.ours, /alphaMode: true/);
  assert.match(block.theirs, /betaMode: true/);
  assert.equal(typeof block.base, 'string');
  assert.match(block.rawConflictSlice, /<<<<<<< branch-a[\s\S]*=======[\s\S]*>>>>>>> branch-b/);

  // Diff3 replacement hunk also populates non-empty base section
  const replaceMergeRes = mergeFileThreeWay({
    currentBuf: Buffer.from("export const MODE = 'alpha';\n", 'utf8'),
    baseBuf: Buffer.from("export const MODE = 'base';\n", 'utf8'),
    incomingBuf: Buffer.from("export const MODE = 'beta';\n", 'utf8'),
    labelCurrent: 'ours-branch',
    labelBase: 'ancestor',
    labelIncoming: 'theirs-branch',
  });
  assert.equal(replaceMergeRes.ok, false);
  assert.equal(replaceMergeRes.conflictBlocks.length, 1);
  assert.match(replaceMergeRes.conflictBlocks[0].ours, /'alpha'/);
  assert.match(replaceMergeRes.conflictBlocks[0].base, /'base'/);
  assert.match(replaceMergeRes.conflictBlocks[0].theirs, /'beta'/);

  // Standalone extractConflictBlocks check
  assert.equal(extractConflictBlocks(mergeRes.conflictedBuffer).length, 1);
  assert.equal(hasUnresolvedConflictMarkers(mergeRes.conflictedBuffer), true);
  assert.equal(hasUnresolvedConflictMarkers(RESOLVED_CONFIG_JS), false);

  // analyzeRunArtifacts preserves both sibling artifacts and exposes structured conflictBlocks + siblingNodes
  const wtA = join(root, 'wtA');
  const wtB = join(root, 'wtB');
  execFileSync('git', ['-C', workDir, 'worktree', 'add', '--detach', wtA, 'HEAD'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workDir, 'worktree', 'add', '--detach', wtB, 'HEAD'], { stdio: 'ignore' });

  const runId = 'run-blocks-unit';
  store.db
    .prepare(
      `INSERT INTO swarm_runs(id, sessionId, goal, status, strategyJson, budgetJson, permissionMode, createdAt, updatedAt)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(runId, 'sess-blocks', 'blocks unit', 'running', '{}', '{}', 'full-access', Date.now(), Date.now());

  writeFileSync(join(wtA, 'src/config.js'), BRANCH_A_CONFIG_JS, 'utf8');
  writeFileSync(join(wtB, 'src/config.js'), BRANCH_B_CONFIG_JS, 'utf8');

  const artA = await manager.archiveWorktree({
    runId,
    nodeId: 'n-a',
    nodeKey: 'branch-a',
    workspaceRoot: workDir,
    worktreePath: wtA,
  });
  const artB = await manager.archiveWorktree({
    runId,
    nodeId: 'n-b',
    nodeKey: 'branch-b',
    workspaceRoot: workDir,
    worktreePath: wtB,
  });

  const analysis = manager.analyzeRunArtifacts([artA, artB], {
    dependenciesByNodeKey: { 'branch-a': [], 'branch-b': [] },
    workspaceRoot: workDir,
    nodeGoalsByKey: {
      'branch-a': { goal: 'Add alphaMode flag', summary: 'Enabled alphaMode' },
      'branch-b': { goal: 'Add betaMode flag', summary: 'Enabled betaMode' },
    },
  });
  assert.equal(analysis.mergeConflicts.length, 1);
  assert.equal(analysis.mergeConflicts[0].path, 'src/config.js');
  assert.equal(analysis.mergeConflicts[0].conflictBlocks.length, 1);
  assert.equal(analysis.mergeConflicts[0].siblingNodes.length, 2);
  assert.equal(manager.readArtifactFile(artA.id, 'src/config.js').text, BRANCH_A_CONFIG_JS);
  assert.equal(manager.readArtifactFile(artB.id, 'src/config.js').text, BRANCH_B_CONFIG_JS);

  execFileSync('git', ['-C', workDir, 'worktree', 'remove', '--force', wtA], { stdio: 'ignore' });
  execFileSync('git', ['-C', workDir, 'worktree', 'remove', '--force', wtB], { stdio: 'ignore' });
});

test('E2E Swarm conflict_resolution auto-resolves overlapping sibling edits, verifies zero markers + hard gate, and emits telemetry', async (t) => {
  const testCmd = buildSubshellNodeTestCmd('test/config.test.js');
  const events = [];
  let crInvocationCount = 0;
  let capturedCrPrompt = '';
  let capturedCrToolNames = [];

  const env = createSwarmEnv(t, {
    workFiles: {
      'package.json': JSON.stringify({ name: 'cr-e2e-pass', type: 'module' }),
      'src/config.js': BASE_CONFIG_JS,
      'test/config.test.js': CONFIG_TEST_JS,
    },
    handler: async function* (opts) {
      const userText = String(opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '');
      const lastToolMsg = opts.messages.findLast((m) => m.role === 'tool');
      const toolResultsCount = opts.messages.filter((m) => m.role === 'tool').length;

      if (userText.includes('[Bounded Merge-Conflict Resolution Step]')) {
        crInvocationCount++;
        capturedCrPrompt = userText;
        capturedCrToolNames = (opts.tools ?? []).map((tl) => tl.name);
        if (toolResultsCount === 0) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'cr-write-1',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'src/config.js', content: RESOLVED_CONFIG_JS }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (toolResultsCount === 1) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'cr-bash-1',
              name: 'bash',
              arguments: JSON.stringify({ command: testCmd }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield {
          type: 'text-delta',
          index: 0,
          text: `Resolved src/config.js combining alphaMode and betaMode; test output: ${String(lastToolMsg?.content?.[0]?.text ?? '').slice(0, 120)}`,
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      if (toolResultsCount === 0 && userText.includes('ALPHA_TASK')) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'a-write',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/config.js', content: BRANCH_A_CONFIG_JS }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }

      if (toolResultsCount === 0 && userText.includes('BETA_TASK')) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'b-write',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/config.js', content: BRANCH_B_CONFIG_JS }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }

      yield { type: 'text-delta', index: 0, text: 'Sibling task completed cleanly.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const sess = env.direct.createSession({ permissionMode: 'full-access', workspaceRoot: env.workDir });
  env.direct.eventRouter.subscribe(sess.id, (evt) => events.push(evt));

  const res = await env.direct.swarmOrchestrator.startRun({
    sessionId: sess.id,
    goal: 'Enable both alphaMode and betaMode in src/config.js',
    workspaceRoot: env.workDir,
    parentPermissionMode: 'full-access',
    nodes: [
      {
        nodeKey: 'branch-a',
        taskType: 'implementation',
        objective: 'ALPHA_TASK: Add alphaMode flag to CONFIG.features in src/config.js',
        isolationMode: 'worktree',
      },
      {
        nodeKey: 'branch-b',
        taskType: 'implementation',
        objective: 'BETA_TASK: Add betaMode flag to CONFIG.features in src/config.js',
        isolationMode: 'worktree',
      },
    ],
  });

  assert.equal(res.status, 'completed');
  assert.equal(crInvocationCount >= 1, true);
  assert.match(capturedCrPrompt, /ALPHA_TASK/);
  assert.match(capturedCrPrompt, /BETA_TASK/);
  assert.match(capturedCrPrompt, /<<<<<<< branch-a/);
  assert.match(capturedCrPrompt, />>>>>>> branch-b/);
  assert.ok(capturedCrToolNames.includes('read_file'));
  assert.ok(capturedCrToolNames.includes('apply_patch'));
  assert.ok(capturedCrToolNames.includes('bash'));
  assert.ok(capturedCrToolNames.includes('run_diagnostics'));

  const expectedTelemetry = {
    triggered: true,
    resolved: true,
    files: ['src/config.js'],
    hardGatePassed: true,
    testExitCode: 0,
  };
  assert.deepEqual(res.conflictResolution, expectedTelemetry);
  assert.deepEqual(res.verdict?.conflictResolution, expectedTelemetry);

  const pkg = env.direct.swarmOrchestrator.buildRunDeliveryPackage(res.runId);
  assert.equal(pkg.conflicts.length, 0);
  assert.deepEqual(pkg.conflictResolution, expectedTelemetry);

  const replanEvt = events.find(
    (e) => e.type === 'swarm/replanned' && e.data?.strategy === 'conflict_resolution',
  );
  assert.ok(replanEvt);
  assert.equal(replanEvt.data.conflictResolution.triggered, true);

  const nodeCrEvt = events.find(
    (e) => e.type === 'swarm/node_updated' && e.data?.nodeKey === 'conflict_resolution' && e.data?.conflictResolution,
  );
  assert.deepEqual(nodeCrEvt?.data?.conflictResolution, expectedTelemetry);

  const runDoneEvt = events.find((e) => e.type === 'swarm/run_completed');
  assert.deepEqual(runDoneEvt?.data?.conflictResolution, expectedTelemetry);

  // Parent workspace was untouched until explicit applyAllRunArtifacts, which applies cleanly
  assert.equal(readFileSync(join(env.workDir, 'src/config.js'), 'utf8'), BASE_CONFIG_JS);
  const applyRes = env.direct.swarmOrchestrator.applyAllRunArtifacts(res.runId, {
    approved: true,
    permissionMode: 'full-access',
  });
  assert.equal(applyRes.ok, true);
  assert.equal(applyRes.conflicts.length, 0);
  assert.equal(readFileSync(join(env.workDir, 'src/config.js'), 'utf8'), RESOLVED_CONFIG_JS);
});

test('E2E Swarm downstream WORKTREE_ARTIFACT_CONFLICT triggers conflict_resolution via run_diagnostics and unblocks verification', async (t) => {
  const testCmd = buildSubshellNodeTestCmd('test/config.test.js');
  let crRuns = 0;

  const env = createSwarmEnv(t, {
    workFiles: {
      'package.json': JSON.stringify({ name: 'cr-e2e-fanin', type: 'module' }),
      'src/config.js': BASE_CONFIG_JS,
      'test/config.test.js': CONFIG_TEST_JS,
    },
    handler: async function* (opts) {
      const userText = String(opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '');
      const toolCount = opts.messages.filter((m) => m.role === 'tool').length;

      if (userText.includes('[Bounded Merge-Conflict Resolution Step]')) {
        if (toolCount === 0) {
          crRuns++;
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'cr-fanin-write',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'src/config.js', content: RESOLVED_CONFIG_JS }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (toolCount === 1) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'cr-fanin-diag',
              name: 'run_diagnostics',
              arguments: JSON.stringify({ kind: 'test', paths: ['test/config.test.js'] }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield { type: 'text-delta', index: 0, text: 'Resolved conflict and passed run_diagnostics tests.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      if (userText.includes('FANIN_VERIFY')) {
        if (toolCount === 0) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'v-bash',
              name: 'bash',
              arguments: JSON.stringify({ command: testCmd }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield { type: 'text-delta', index: 0, text: 'Final verification passed.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      if (toolCount === 0 && userText.includes('ALPHA_FANIN')) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'a-w',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/config.js', content: BRANCH_A_CONFIG_JS }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }

      if (toolCount === 0 && userText.includes('BETA_FANIN')) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'b-w',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/config.js', content: BRANCH_B_CONFIG_JS }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }

      yield { type: 'text-delta', index: 0, text: 'Done.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const sess = env.direct.createSession({ permissionMode: 'full-access', workspaceRoot: env.workDir });
  const res = await env.direct.swarmOrchestrator.startRun({
    sessionId: sess.id,
    goal: 'Integrate alpha and beta flags then verify',
    workspaceRoot: env.workDir,
    parentPermissionMode: 'full-access',
    nodes: [
      { nodeKey: 'branch-a', taskType: 'implementation', objective: 'ALPHA_FANIN', isolationMode: 'worktree' },
      { nodeKey: 'branch-b', taskType: 'implementation', objective: 'BETA_FANIN', isolationMode: 'worktree' },
      {
        nodeKey: 'verify-all',
        taskType: 'verification',
        objective: 'FANIN_VERIFY',
        dependencies: ['branch-a', 'branch-b'],
        isolationMode: 'worktree',
      },
    ],
  });

  assert.equal(crRuns, 1, 'must dispatch at most 1 conflict_resolution step');
  assert.equal(res.status, 'completed');
  assert.deepEqual(res.conflictResolution, {
    triggered: true,
    resolved: true,
    files: ['src/config.js'],
    hardGatePassed: true,
    testExitCode: 0,
  });
  const verifyNode = res.nodes.find((n) => n.nodeKey === 'verify-all');
  assert.equal(verifyNode?.status, 'completed');
});

test('Swarm conflict_resolution fails closed cleanly (at most 1 attempt) on remaining markers, failing test, or missing test', async (t) => {
  const testCmd = buildSubshellNodeTestCmd('test/config.test.js');

  const runFailCase = async (mode) => {
    let crSteps = 0;
    const events = [];
    const env = createSwarmEnv(t, {
      workFiles: {
        'package.json': JSON.stringify({ name: `cr-fail-${mode}`, type: 'module' }),
        'src/config.js': BASE_CONFIG_JS,
        'test/config.test.js': CONFIG_TEST_JS,
      },
      handler: async function* (opts) {
        const userText = String(opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '');
        const toolCount = opts.messages.filter((m) => m.role === 'tool').length;

        if (userText.includes('[Bounded Merge-Conflict Resolution Step]')) {
          if (toolCount === 0) {
            crSteps++;
            const badContent =
              mode === 'remaining_markers'
                ? 'export const CONFIG = {\n<<<<<<< branch-a\n  alphaMode: true,\n=======\n  betaMode: true,\n>>>>>>> branch-b\n};\n'
                : mode === 'failing_test'
                  ? BRANCH_A_CONFIG_JS // missing betaMode so test exits 1
                  : RESOLVED_CONFIG_JS; // resolved file but skips running test!
            yield {
              type: 'block-end',
              index: 0,
              block: {
                type: 'tool-call',
                id: `cr-fail-w-${mode}`,
                name: 'write_file',
                arguments: JSON.stringify({ path: 'src/config.js', content: badContent }),
              },
            };
            yield { type: 'finish', reason: { kind: 'tool-calls' } };
            return;
          }
          if (toolCount === 1 && mode !== 'no_test') {
            yield {
              type: 'block-end',
              index: 0,
              block: {
                type: 'tool-call',
                id: `cr-fail-b-${mode}`,
                name: 'bash',
                arguments: JSON.stringify({ command: testCmd }),
              },
            };
            yield { type: 'finish', reason: { kind: 'tool-calls' } };
            return;
          }
          yield { type: 'text-delta', index: 0, text: 'Attempted conflict resolution.' };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }

        if (toolCount === 0 && userText.includes('ALPHA_FAIL')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'af-w',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'src/config.js', content: BRANCH_A_CONFIG_JS }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (toolCount === 0 && userText.includes('BETA_FAIL')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'bf-w',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'src/config.js', content: BRANCH_B_CONFIG_JS }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield { type: 'text-delta', index: 0, text: 'Done.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    });

    const sess = env.direct.createSession({ permissionMode: 'full-access', workspaceRoot: env.workDir });
    env.direct.eventRouter.subscribe(sess.id, (evt) => events.push(evt));

    const res = await env.direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: `Fail closed check (${mode})`,
      workspaceRoot: env.workDir,
      parentPermissionMode: 'full-access',
      nodes: [
        { nodeKey: 'branch-a', taskType: 'implementation', objective: 'ALPHA_FAIL', isolationMode: 'worktree' },
        { nodeKey: 'branch-b', taskType: 'implementation', objective: 'BETA_FAIL', isolationMode: 'worktree' },
      ],
    });
    return { res, crSteps, events, env };
  };

  // Case 1: Remaining conflict markers -> fail closed
  const c1 = await runFailCase('remaining_markers');
  assert.equal(c1.crSteps, 1, 'must allow at most 1 conflict_resolution step');
  assert.equal(c1.res.status, 'failed');
  assert.equal(c1.res.conflictResolution?.triggered, true);
  assert.equal(c1.res.conflictResolution?.resolved, false);
  assert.equal(c1.res.conflictResolution?.hardGatePassed, false);
  assert.deepEqual(c1.res.conflictResolution?.files, ['src/config.js']);
  assert.equal(readFileSync(join(c1.env.workDir, 'src/config.js'), 'utf8'), BASE_CONFIG_JS);

  // Case 2: Failing test (exitCode 1) -> fail closed with testExitCode=1
  const c2 = await runFailCase('failing_test');
  assert.equal(c2.crSteps, 1);
  assert.equal(c2.res.status, 'failed');
  assert.equal(c2.res.conflictResolution?.triggered, true);
  assert.equal(c2.res.conflictResolution?.resolved, false);
  assert.equal(c2.res.conflictResolution?.hardGatePassed, false);
  assert.equal(c2.res.conflictResolution?.testExitCode, 1);

  // Case 3: Missing test execution -> fail closed with testExitCode=null
  const c3 = await runFailCase('no_test');
  assert.equal(c3.crSteps, 1);
  assert.equal(c3.res.status, 'failed');
  assert.equal(c3.res.conflictResolution?.triggered, true);
  assert.equal(c3.res.conflictResolution?.resolved, false);
  assert.equal(c3.res.conflictResolution?.hardGatePassed, false);
  assert.equal(c3.res.conflictResolution?.testExitCode, null);

  // Direct unit check on evaluateConflictResolutionGate
  const directGateFail = evaluateConflictResolutionGate({
    conflictFiles: ['src/config.js'],
    reviewerEvidence: { artifacts: [], receipts: [] },
    gitDiff: { diffFileCount: 1, diffDigest: 'abc', files: ['src/config.js'] },
  });
  assert.equal(directGateFail.hardGatePassed, false);
  assert.equal(directGateFail.resolved, false);
});
