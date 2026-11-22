import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

import { Store } from '../../src/store.js';
import { AccountPool } from '../../src/pool.js';
import { DirectAgentRuntime } from '../../src/direct-agent.js';
import { AgentCapabilityRegistry } from '../../src/swarm/capabilities.js';
import { TeamOptimizer } from '../../src/swarm/team-optimizer.js';
import { DynamicTaskPlanner } from '../../src/swarm/planner.js';
import { registerSwarmRoutes } from '../../src/routes/swarm-routes.js';
import {
  REVIEWER_SCHEMA_VERSION,
  computeReviewerEvidenceDigest,
} from '../../src/swarm/reviewer.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }
  async *stream(options) {
    const idx = this.calls.length;
    this.calls.push(structuredClone(options.messages));
    yield* this.handler(options, idx);
  }
}

function rmSafe(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 40 });
  } catch {
    // ignore Windows file lock during cleanup
  }
}

function initGitRepo(workDir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(workDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  execFileSync('git', ['init'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Swarm Test'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init baseline'], { cwd: workDir, stdio: 'ignore' });
}

function createRuntimeEnv(t, { workFiles, handler, models = ['coder-model', 'verifier-model', 'reviewer-model'] }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-gen-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-gen-work-'));
  initGitRepo(workDir, workFiles);
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'custom-openai',
    label: 'Generalist Pool',
    endpoint: 'https://api.example.invalid/v1',
    credential: 'sk-test-gen',
    models,
  });
  pool.setDefaultModel(models[0]);

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

  return { store, pool, direct, adapter, workDir, dataDir };
}

/**
 * Helper command string that runs real `node --test <relPath>` in a subshell while
 * stripping inherited outer `NODE_TEST_CONTEXT` / `NODE_TEST_WORKER_ID` so Node's
 * test runner exits accurately with 0/1 even inside an outer `node --test` run.
 */
function buildRealNodeTestCommand(relTestPath) {
  return (
    `node -e "const cp=require('node:child_process');` +
    `const e={...process.env};delete e.NODE_TEST_CONTEXT;delete e.NODE_TEST_WORKER_ID;` +
    `const r=cp.spawnSync(process.execPath,['--test','${relTestPath}'],{stdio:'inherit',env:e});` +
    `process.exit(r.status??1);"`
  );
}

function getLatestAssistantUserText(opts) {
  const messages = opts.messages ?? [];
  return String(messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '');
}

test('1. Predecessor worktree overlay merges disjoint parallel branches onto verification running real node --test and blocks collisions', async (t) => {
  const verifyCmd = buildRealNodeTestCommand('test/integration.test.js');
  const { store, direct, workDir } = createRuntimeEnv(t, {
    workFiles: {
      'package.json': JSON.stringify({ name: 'overlay-fixture', type: 'module' }, null, 2),
      'src/math.js': 'export function add(a, b) { return 0; }\n',
      'src/format.js': 'export function fmt(val) { return String(val); }\n',
      'test/integration.test.js': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { add } from '../src/math.js';",
        "import { fmt } from '../src/format.js';",
        "test('combined modules compute and format', () => {",
        "  assert.equal(fmt(add(2, 3)), 'Result: 5');",
        '});',
      ].join('\n'),
    },
    handler: async function* (opts) {
      const messages = opts.messages ?? [];
      const userText = getLatestAssistantUserText(opts);
      const lastRole = messages.at(-1)?.role;

      if (userText.includes('[Durable evidence manifest]')) {
        const match = /\[Durable evidence manifest\]\s*\n+([\s\S]+)$/.exec(userText);
        const manifest = match ? JSON.parse(match[1].trim()) : { artifacts: [], receipts: [] };
        const firstArt = manifest.artifacts?.[0];
        if (lastRole !== 'tool' && firstArt) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-rev-read',
              name: 'read_swarm_artifact',
              arguments: JSON.stringify({ uri: firstArt.uri, path: 'src/math.js' }),
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
            summary: 'Both branches verified together via integration tests.',
            evidenceDigest: computeReviewerEvidenceDigest(manifest),
            checkedArtifacts: firstArt ? [firstArt.uri] : [],
            evidenceRefs: [manifest.receipts?.[0]?.receiptId || 'verified'],
            findings: [],
          }),
        };
        yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 12 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      if (lastRole !== 'tool') {
        if (userText.includes('WORK_MATH')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-math',
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'src/math.js',
                content: 'export function add(a, b) { return a + b; }\n',
              }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (userText.includes('WORK_FMT')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-fmt',
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'src/format.js',
                content: "export function fmt(val) { return 'Result: ' + val; }\n",
              }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (userText.includes('RUN_INTEGRATION_TEST')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-verify-bash',
              name: 'bash',
              arguments: JSON.stringify({ command: verifyCmd }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
      }

      const toolText = lastRole === 'tool' ? String(messages.at(-1)?.content?.[0]?.text ?? '') : '';
      yield { type: 'text-delta', index: 0, text: `done: ${toolText.slice(0, 120)}` };
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  // Baseline test in parent MUST fail before worktree overlay + apply
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_TEST_CONTEXT;
  delete cleanEnv.NODE_TEST_WORKER_ID;
  const baselineCheck = spawnSync(process.execPath, ['--test', 'test/integration.test.js'], {
    cwd: workDir,
    env: cleanEnv,
    encoding: 'utf8',
  });
  assert.notEqual(baselineCheck.status, 0);

  const sess = direct.createSession({ permissionMode: 'full-access', workspaceRoot: workDir });
  const run = await direct.swarmOrchestrator.startRun({
    sessionId: sess.id,
    goal: 'Implement math + format in parallel worktrees and verify integration',
    workspaceRoot: workDir,
    parentPermissionMode: 'full-access',
    maxConcurrency: 2,
    nodes: [
      { nodeKey: 'impl-math', taskType: 'implementation', objective: 'WORK_MATH', isolationMode: 'worktree' },
      { nodeKey: 'impl-fmt', taskType: 'implementation', objective: 'WORK_FMT', isolationMode: 'worktree' },
      {
        nodeKey: 'verify',
        taskType: 'verification',
        objective: 'RUN_INTEGRATION_TEST',
        dependencies: ['impl-math', 'impl-fmt'],
        isolationMode: 'worktree',
      },
    ],
  });

  assert.equal(run.status, 'completed');
  const verifyNode = run.nodes.find((n) => n.nodeKey === 'verify');
  assert.equal(verifyNode.status, 'completed');

  // Verify real bash execution exited 0 in isolated verification worktree
  const bashReceipt = store.db
    .prepare("SELECT status, exitCode FROM tool_receipts WHERE sessionId=? AND toolName='bash'")
    .get(verifyNode.childSessionId);
  assert.equal(bashReceipt?.status, 'finished');
  assert.equal(bashReceipt?.exitCode, 0);

  // Verification artifact must NOT misattribute upstream overlaid files (src/math.js, src/format.js)
  const verifyArtifact = direct.artifactManager.getLatestNodeArtifact(run.runId, 'verify');
  assert.ok(verifyArtifact);
  const verifyFilePaths = (verifyArtifact.files ?? []).map((f) => f.path);
  assert.equal(verifyFilePaths.includes('src/math.js'), false);
  assert.equal(verifyFilePaths.includes('src/format.js'), false);

  // Parent workspace remains cleanly untouched before apply-all
  assert.match(readFileSync(join(workDir, 'src/math.js'), 'utf8'), /return 0;/);

  // Part B: Cross-branch file collision detection in SwarmArtifactManager & worktree overlay fail-closed
  const collisionRun = await direct.swarmOrchestrator.startRun({
    sessionId: sess.id,
    goal: 'Colliding parallel branches fail closed on downstream worktree',
    workspaceRoot: workDir,
    parentPermissionMode: 'full-access',
    maxConcurrency: 2,
    maxReplans: 0,
    nodes: [
      { nodeKey: 'col-a', taskType: 'implementation', objective: 'WORK_MATH', isolationMode: 'worktree' },
      { nodeKey: 'col-b', taskType: 'implementation', objective: 'WORK_MATH', isolationMode: 'worktree' },
      {
        nodeKey: 'verify-col',
        taskType: 'verification',
        objective: 'RUN_INTEGRATION_TEST',
        dependencies: ['col-a', 'col-b'],
        isolationMode: 'worktree',
      },
    ],
  });
  const colA = direct.artifactManager.getLatestNodeArtifact(collisionRun.runId, 'col-a');
  const colB = direct.artifactManager.getLatestNodeArtifact(collisionRun.runId, 'col-b');
  assert.ok(colA && colB);

  // Tamper check: corrupt stored file bytes on disk -> SHA-256 verification MUST reject before mutating worktree
  const probeWt = mkdtempSync(join(tmpdir(), 'agent-us-overlay-probe-'));
  t.after(() => rmSafe(probeWt));
  const aStoredFile = join(colA.storagePath, colA.files[0].contentFile);
  const origABytes = readFileSync(aStoredFile);
  writeFileSync(aStoredFile, 'tampered artifact content\n', 'utf8');
  assert.throws(
    () => direct.artifactManager.applyArtifactsToWorktree([colA], probeWt),
    /verification failed|ARTIFACT_VERIFICATION_FAILED|sha256/i,
  );
  writeFileSync(aStoredFile, origABytes);

  // Tamper check on second bundle file too
  const bFilePath = join(colB.storagePath, colB.files[0].contentFile);
  const origBBytes = readFileSync(bFilePath);
  writeFileSync(bFilePath, 'export function add(a, b) { return a + b + 99; }\n', 'utf8');
  assert.throws(
    () => direct.artifactManager.applyArtifactsToWorktree([colA, colB], probeWt),
    /verification failed|ARTIFACT_VERIFICATION_FAILED|sha256/i,
  );
  writeFileSync(bFilePath, origBBytes);

  // Real colliding swarm run where two parallel branches modify src/math.js differently
  const realColRun = await createRuntimeEnv(t, {
    workFiles: {
      'src/shared.js': 'export const v = 0;\n',
    },
    handler: async function* (opts) {
      const messages = opts.messages ?? [];
      const userText = getLatestAssistantUserText(opts);
      const lastRole = messages.at(-1)?.role;
      if (lastRole !== 'tool') {
        const val = userText.includes('BRANCH_X') ? 'export const v = 1;\n' : 'export const v = 2;\n';
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `tc-${userText.slice(0, 8)}`,
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/shared.js', content: val }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'done' };
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 6 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  const colSess = realColRun.direct.createSession({ permissionMode: 'full-access' });
  const failedCollision = await realColRun.direct.swarmOrchestrator.startRun({
    sessionId: colSess.id,
    goal: 'Cross-branch conflict',
    workspaceRoot: realColRun.workDir,
    parentPermissionMode: 'full-access',
    maxConcurrency: 2,
    maxReplans: 0,
    nodes: [
      { nodeKey: 'branch-x', taskType: 'implementation', objective: 'BRANCH_X', isolationMode: 'worktree' },
      { nodeKey: 'branch-y', taskType: 'implementation', objective: 'BRANCH_Y', isolationMode: 'worktree' },
      {
        nodeKey: 'merge-verify',
        taskType: 'verification',
        objective: 'Check overlaid result',
        dependencies: ['branch-x', 'branch-y'],
        isolationMode: 'worktree',
      },
    ],
  });
  assert.equal(failedCollision.status, 'failed');
  const failedVerify = failedCollision.nodes.find((n) => n.nodeKey === 'merge-verify');
  assert.equal(failedVerify.errorCode, 'WORKTREE_ARTIFACT_CONFLICT');

  const artX = realColRun.direct.artifactManager.getLatestNodeArtifact(failedCollision.runId, 'branch-x');
  const artY = realColRun.direct.artifactManager.getLatestNodeArtifact(failedCollision.runId, 'branch-y');
  assert.ok(artX && artY);
  mkdirSync(join(probeWt, 'src'), { recursive: true });
  writeFileSync(join(probeWt, 'src/shared.js'), 'export const v = 0;\n', 'utf8');
  const crossCollision = realColRun.direct.artifactManager.applyArtifactsToWorktree(
    [artX, artY],
    probeWt,
    { saveOverlayState: false },
  );
  assert.equal(crossCollision.ok, false);
  assert.equal(crossCollision.conflicts.length, 1);
  assert.equal(crossCollision.conflicts[0].path, 'src/shared.js');
  assert.equal(crossCollision.conflicts[0].reason, 'cross_branch_collision');

  // Verify added, deleted, and renamed artifact overlay cleanly onto downstream worktree
  const adrWorkDir = mkdtempSync(join(tmpdir(), 'agent-us-adr-base-'));
  const adrWtSrc = mkdtempSync(join(tmpdir(), 'agent-us-adr-src-'));
  const adrWtDst = mkdtempSync(join(tmpdir(), 'agent-us-adr-dst-'));
  t.after(() => {
    rmSafe(adrWorkDir);
    rmSafe(adrWtSrc);
    rmSafe(adrWtDst);
  });
  initGitRepo(adrWorkDir, {
    'obsolete.txt': 'remove me\n',
    'legacy.js': 'export const renamedModule = 42;\n',
  });
  const srcFiles = {
    'obsolete.txt': null,
    'legacy.js': null,
    'modern.js': 'export const renamedModule = 42;\n',
    'added.js': 'export const fresh = true;\n',
  };
  execFileSync('git', ['clone', '--quiet', adrWorkDir, adrWtSrc], { stdio: 'ignore' });
  for (const [rel, val] of Object.entries(srcFiles)) {
    const p = join(adrWtSrc, rel);
    if (val === null) rmSync(p, { force: true });
    else writeFileSync(p, val, 'utf8');
  }
  const adrArtifact = await realColRun.direct.artifactManager.archiveWorktree({
    runId: failedCollision.runId,
    nodeId: 'adr-node',
    nodeKey: 'adr-node',
    attempt: 1,
    workspaceRoot: adrWorkDir,
    worktreePath: adrWtSrc,
  });
  assert.ok(adrArtifact);
  execFileSync('git', ['clone', '--quiet', adrWorkDir, adrWtDst], { stdio: 'ignore' });
  const adrOverlay = realColRun.direct.artifactManager.applyArtifactsToWorktree([adrArtifact], adrWtDst, {
    saveOverlayState: true,
  });
  assert.equal(adrOverlay.ok, true);
  assert.equal(existsSync(join(adrWtDst, 'obsolete.txt')), false);
  assert.equal(existsSync(join(adrWtDst, 'legacy.js')), false);
  assert.equal(readFileSync(join(adrWtDst, 'modern.js'), 'utf8'), 'export const renamedModule = 42;\n');
  assert.equal(readFileSync(join(adrWtDst, 'added.js'), 'utf8'), 'export const fresh = true;\n');
});

test('2. Dynamic team scaling (>2 workers), specialized role ceilings, and repository intelligence planner injection', async (t) => {
  // 2A. AgentCapabilityRegistry archetypes & worktree vs read-only ceilings
  const capReg = new AgentCapabilityRegistry();
  assert.deepEqual(
    capReg.listCapabilities().map((c) => c.id).sort(),
    ['implementation', 'planning', 'research', 'review', 'verification'],
  );

  const implWorktreeProfile = capReg.synthesizeProfile({
    taskType: 'implementation',
    isolationMode: 'worktree',
    roleTitle: 'Backend Storage Specialist',
    focus: 'Migrate repository storage layer',
    ownedPaths: ['src/storage.js'],
    requiredTools: ['read_file', 'edit_file', 'bash', 'inspect_repository'],
  });
  assert.equal(implWorktreeProfile.readOnly, false);
  assert.equal(implWorktreeProfile.roleTitle, 'Backend Storage Specialist');
  assert.deepEqual(implWorktreeProfile.ownedPaths, ['src/storage.js']);
  assert.ok(implWorktreeProfile.toolAllow.includes('bash'));
  assert.ok(implWorktreeProfile.toolAllow.includes('inspect_repository'));

  const researchEscalationAttempt = capReg.synthesizeProfile({
    taskType: 'research',
    isolationMode: 'shared_readonly',
    roleTitle: 'Security Researcher',
    requiredTools: ['read_file', 'bash', 'write_file', 'inspect_repository'],
  });
  assert.equal(researchEscalationAttempt.readOnly, true);
  assert.equal(researchEscalationAttempt.toolAllow.includes('bash'), false);
  assert.equal(researchEscalationAttempt.toolAllow.includes('write_file'), false);
  assert.ok(researchEscalationAttempt.toolAllow.includes('inspect_repository'));

  const reviewEscalationAttempt = capReg.synthesizeProfile({
    taskType: 'review',
    isolationMode: 'shared_readonly',
    requiredTools: ['read_file', 'edit_file', 'bash', 'read_swarm_artifact'],
  });
  assert.equal(reviewEscalationAttempt.readOnly, true);
  assert.equal(reviewEscalationAttempt.toolAllow.includes('edit_file'), false);
  assert.equal(reviewEscalationAttempt.toolAllow.includes('bash'), false);

  // 2B. TeamOptimizer dynamic scaling beyond teamSize=2 + explicit opt-out + budget step-down
  const optimizer = new TeamOptimizer();
  const candidates = [
    { id: 'worker-1', capabilities: { coding: 0.92, reasoning: 0.85, research: 0.8, planning: 0.8, speed: 0.8, contextCapacity: 0.8, multimodal: 0.2, toolCompatibility: 0.95 }, costWeight: 1, estimatedTokens: 25 },
    { id: 'worker-2', capabilities: { coding: 0.88, reasoning: 0.84, research: 0.82, planning: 0.78, speed: 0.85, contextCapacity: 0.8, multimodal: 0.2, toolCompatibility: 0.9 }, costWeight: 1, estimatedTokens: 25 },
    { id: 'worker-3', capabilities: { coding: 0.85, reasoning: 0.88, research: 0.86, planning: 0.82, speed: 0.75, contextCapacity: 0.85, multimodal: 0.2, toolCompatibility: 0.9 }, costWeight: 1, estimatedTokens: 25 },
    { id: 'worker-4', capabilities: { coding: 0.82, reasoning: 0.86, research: 0.84, planning: 0.8, speed: 0.9, contextCapacity: 0.8, multimodal: 0.2, toolCompatibility: 0.9 }, costWeight: 1, estimatedTokens: 25 },
    { id: 'auditor-1', role: 'reviewer', capabilities: { coding: 0.7, reasoning: 0.96, research: 0.92, planning: 0.85, speed: 0.7, contextCapacity: 0.9, multimodal: 0.2, toolCompatibility: 0.85 }, costWeight: 1, estimatedTokens: 20 },
  ];

  const scaled4 = optimizer.optimize({
    task: {
      taskType: 'implementation',
      complexity: 'complex',
      independentWorkstreams: 4,
      workstreamRoles: [
        { roleTitle: 'API Specialist' },
        { roleTitle: 'Auth Specialist' },
        { roleTitle: 'DB Specialist' },
        { roleTitle: 'Test Specialist' },
      ],
      requiredCapabilities: { coding: 1, reasoning: 0.5 },
    },
    candidates,
    maxConcurrency: 6,
    reviewerAvailable: true,
    budget: { maxCost: 1000, maxTokens: 500 },
  });
  assert.equal(scaled4.mode, 'team');
  assert.equal(scaled4.members.length, 4);
  assert.equal(scaled4.recommendedTeamSize, 4);
  assert.ok(scaled4.reviewer?.id);

  // Tight step budget scales 4 down to 2 cleanly instead of collapsing to single immediately
  const budgetScaled = optimizer.optimize({
    task: { taskType: 'implementation', complexity: 'complex', independentWorkstreams: 4 },
    candidates,
    maxConcurrency: 6,
    reviewerAvailable: false,
    budgetSnapshot: { remainingSteps: 2 },
  });
  assert.equal(budgetScaled.mode, 'team');
  assert.equal(budgetScaled.members.length, 2);
  assert.equal(budgetScaled.budgetScaledFrom, 4);

  // Explicit { teamSize: 2 } preserves backward-compatible cap
  const legacyFixed = new TeamOptimizer({ teamSize: 2 }).optimize({
    task: { taskType: 'implementation', complexity: 'complex', independentWorkstreams: 4 },
    candidates,
    maxConcurrency: 6,
  });
  assert.equal(legacyFixed.mode, 'team');
  assert.equal(legacyFixed.members.length, 2);

  // 2C. Full autonomous goal -> repoContext prompt injection -> 3 parallel workstreams + verify + review
  const repoAwareCmd = buildRealNodeTestCommand('test/app.test.js');
  let capturedPlannerPrompt = '';
  const { direct, store, workDir } = createRuntimeEnv(t, {
    workFiles: {
      'package.json': JSON.stringify({ name: 'repo-aware', type: 'module', scripts: { test: 'node --test' } }),
      'src/auth.js': 'export const checkAuth = () => false;\n',
      'src/routes.js': 'export const getRoute = () => "/";\n',
      'src/db.js': 'export const getDb = () => null;\n',
      'test/app.test.js': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { checkAuth } from '../src/auth.js';",
        "import { getRoute } from '../src/routes.js';",
        "import { getDb } from '../src/db.js';",
        "test('all 3 subsystems integrate', () => {",
        '  assert.equal(checkAuth(), true);',
        "  assert.equal(getRoute(), '/ok');",
        "  assert.equal(getDb(), 'connected');",
        '});',
      ].join('\n'),
    },
    handler: async function* (opts) {
      const messages = opts.messages ?? [];
      const sysText = String(messages.find((m) => m.role === 'system')?.content?.[0]?.text ?? '');
      const userText = getLatestAssistantUserText(opts);
      const lastRole = messages.at(-1)?.role;

      if (sysText.includes('Decompose the engineering goal') || userText.includes('Decompose goal into')) {
        capturedPlannerPrompt = userText;
        yield {
          type: 'text-delta',
          index: 0,
          text: JSON.stringify({
            nodes: [
              {
                nodeKey: 'auth-work',
                taskType: 'implementation',
                roleTitle: 'Auth Engineer',
                focus: 'Implement token validation in src/auth.js',
                ownedPaths: ['src/auth.js'],
                objective: 'OWN:AUTH Implement checkAuth() returning true',
                acceptance: 'src/auth.js exports passing checkAuth',
                dependencies: [],
                isolatedWorktree: true,
              },
              {
                nodeKey: 'routes-work',
                taskType: 'implementation',
                roleTitle: 'API Router Engineer',
                focus: 'Implement /ok route in src/routes.js',
                ownedPaths: ['src/routes.js'],
                objective: 'OWN:ROUTES Implement getRoute() returning /ok',
                acceptance: 'src/routes.js exports /ok',
                dependencies: [],
                isolatedWorktree: true,
              },
              {
                nodeKey: 'db-work',
                taskType: 'implementation',
                roleTitle: 'Database Engineer',
                focus: 'Implement storage connector in src/db.js',
                ownedPaths: ['src/db.js'],
                objective: 'OWN:DB Implement getDb() returning connected',
                acceptance: 'src/db.js exports connected',
                dependencies: [],
                isolatedWorktree: true,
              },
              {
                nodeKey: 'verify-all',
                taskType: 'verification',
                roleTitle: 'Integration Verifier',
                objective: 'RUN_APP_TESTS Execute integration test suite',
                acceptance: 'node --test exits 0',
                dependencies: ['auth-work', 'routes-work', 'db-work'],
                isolatedWorktree: true,
              },
            ],
          }),
        };
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 30 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

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
              id: 'tc-rev-3',
              name: 'read_swarm_artifact',
              arguments: JSON.stringify({ uri: art.uri, path: 'src/auth.js' }),
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
            summary: 'All 3 subsystems and integration verification passed.',
            evidenceDigest: computeReviewerEvidenceDigest(manifest),
            checkedArtifacts: art ? [art.uri] : [],
            evidenceRefs: [manifest.receipts?.[0]?.receiptId || 'verified'],
            findings: [],
          }),
        };
        yield { type: 'usage', usage: { inputTokens: 14, outputTokens: 12 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      if (lastRole !== 'tool') {
        if (userText.includes('OWN:AUTH')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-auth',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'src/auth.js', content: 'export const checkAuth = () => true;\n' }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (userText.includes('OWN:ROUTES')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-routes',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'src/routes.js', content: "export const getRoute = () => '/ok';\n" }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (userText.includes('OWN:DB')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-db',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'src/db.js', content: "export const getDb = () => 'connected';\n" }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (userText.includes('RUN_APP_TESTS')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-app-verify',
              name: 'bash',
              arguments: JSON.stringify({ command: repoAwareCmd }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
      }

      yield { type: 'text-delta', index: 0, text: 'completed work' };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  // Also test planner.decompose directly with structured repoContext injection
  const plannerDirect = new DynamicTaskPlanner({
    adapter: direct.adapter,
    model: 'coder-model',
  });
  const directNodes = await plannerDirect.decompose({
    goal: 'Wire auth, routes, db subsystems',
    workspaceRoot: workDir,
    model: 'coder-model',
    repoContext: {
      git: { branch: 'main', headSha: 'abc1234567890' },
      project: { testCommands: ['node --test test/app.test.js'] },
      structure: { entryPoints: ['src/auth.js', 'src/routes.js'] },
      callGraph: {
        edges: [{ from: 'test/app.test.js', to: 'src/auth.js' }],
        relevantFiles: [{ path: 'src/auth.js' }, { path: 'src/routes.js' }, { path: 'src/db.js' }],
      },
      summaryText: '3 modules wired into test/app.test.js',
    },
  });
  assert.equal(directNodes.length, 4);
  assert.equal(directNodes[0].roleTitle, 'Auth Engineer');
  assert.deepEqual(directNodes[0].ownedPaths, ['src/auth.js']);
  assert.match(capturedPlannerPrompt, /\[Repository Intelligence\]/);
  assert.match(capturedPlannerPrompt, /node --test test\/app\.test\.js/);
  assert.ok(directNodes.repoContext?.testCommands?.includes('node --test test/app.test.js'));

  // Run full submitAutonomousGoal end-to-end with 3 parallel workers
  const goalRes = await direct.submitAutonomousGoal({
    goal: 'Upgrade auth, routes, and db subsystems and verify integration',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    workspaceSummary: 'discoveredTestCommands: ["node --test test/app.test.js"]',
    wait: true,
  });
  assert.equal(goalRes.status, 'completed');
  const fullRun = direct.swarmOrchestrator.getRun(goalRes.runId);
  assert.ok(fullRun.strategy.maxConcurrency >= 3);
  const authNode = fullRun.nodes.find((n) => n.nodeKey === 'auth-work');
  assert.ok(authNode.toolAllow.includes('bash'));
  assert.ok(authNode.toolAllow.includes('inspect_repository'));
  const reviewNode = fullRun.nodes.find((n) => n.taskType === 'review');
  assert.ok(reviewNode);
  assert.equal(reviewNode.permissionMode, 'read-only');
  assert.equal(reviewNode.isolationMode, 'shared_readonly');
  assert.equal(reviewNode.toolAllow.includes('bash'), false);

  const delivery = direct.swarmOrchestrator.buildRunDeliveryPackage(goalRes.runId);
  assert.equal(delivery.changedFiles.length, 3);
  assert.equal(delivery.testResults[0]?.status, 'passed');
  assert.equal(delivery.reviewerVerdicts[0]?.status, 'pass');
});

test('3a. Failing verification triggers bounded repair_and_reverify without re-running unrelated completed nodes', async (t) => {
  const testCmd = buildRealNodeTestCommand('test/calc.test.js');
  let docsRuns = 0;
  let verifyRuns = 0;

  const { store, direct, workDir } = createRuntimeEnv(t, {
    workFiles: {
      'package.json': JSON.stringify({ name: 'repair-fixture', type: 'module' }),
      'src/calc.js': 'export function multiply(a, b) { return 0; }\n',
      'docs/info.txt': 'v0\n',
      'test/calc.test.js': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { multiply } from '../src/calc.js';",
        "test('multiply computes product', () => {",
        '  assert.equal(multiply(3, 4), 12);',
        '});',
      ].join('\n'),
    },
    handler: async function* (opts) {
      const messages = opts.messages ?? [];
      const userText = getLatestAssistantUserText(opts);
      const lastRole = messages.at(-1)?.role;

      if (userText.includes('[Durable evidence manifest]')) {
        const match = /\[Durable evidence manifest\]\s*\n+([\s\S]+)$/.exec(userText);
        const manifest = match ? JSON.parse(match[1].trim()) : { artifacts: [], receipts: [] };
        const repairArt =
          manifest.artifacts?.find((a) => a.nodeKey?.startsWith('repair')) ?? manifest.artifacts?.[0];
        if (lastRole !== 'tool' && repairArt) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-rev-repair',
              name: 'read_swarm_artifact',
              arguments: JSON.stringify({ uri: repairArt.uri, path: 'src/calc.js' }),
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
            summary: 'Repair fixed multiplication bug cleanly and re-verification passed.',
            evidenceDigest: computeReviewerEvidenceDigest(manifest),
            checkedArtifacts: repairArt ? [repairArt.uri] : [],
            evidenceRefs: [manifest.receipts?.[0]?.receiptId || 'reverified'],
            findings: [],
          }),
        };
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 10 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      if (lastRole !== 'tool') {
        if (userText.includes('[Bounded Repair Cycle')) {
          // Repair node inspects diagnostics and fixes src/calc.js
          assert.match(userText, /VERIFICATION_FAILED|Exit code: 1|12|multiply/i);
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-fix-calc',
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'src/calc.js',
                content: 'export function multiply(a, b) { return a * b; }\n',
              }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (userText.includes('WORK_UNRELATED_DOCS')) {
          docsRuns++;
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-docs',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'docs/info.txt', content: 'v1 documented\n' }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (userText.includes('WORK_BUGGY_CALC')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-bug-calc',
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'src/calc.js',
                content: 'export function multiply(a, b) { return a + b; }\n',
              }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (userText.includes('VERIFY_CALC')) {
          verifyRuns++;
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: `tc-verify-${verifyRuns}`,
              name: 'bash',
              arguments: JSON.stringify({ command: testCmd }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
      }

      const toolText = lastRole === 'tool' ? String(messages.at(-1)?.content?.[0]?.text ?? '') : '';
      yield { type: 'text-delta', index: 0, text: `summary: ${toolText.slice(0, 120)}` };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const sess = direct.createSession({ permissionMode: 'full-access', workspaceRoot: workDir });
  const run = await direct.swarmOrchestrator.startRun({
    sessionId: sess.id,
    goal: 'Fix multiply while preserving unrelated docs branch',
    workspaceRoot: workDir,
    parentPermissionMode: 'full-access',
    maxConcurrency: 2,
    maxReplans: 2,
    nodes: [
      { nodeKey: 'docs-branch', taskType: 'implementation', objective: 'WORK_UNRELATED_DOCS', isolationMode: 'worktree' },
      { nodeKey: 'impl-calc', taskType: 'implementation', objective: 'WORK_BUGGY_CALC', isolationMode: 'worktree' },
      {
        nodeKey: 'verify',
        taskType: 'verification',
        objective: 'VERIFY_CALC',
        dependencies: ['impl-calc'],
        isolationMode: 'worktree',
      },
      {
        nodeKey: 'final-review',
        taskType: 'review',
        objective: 'Review multiply fix and tests',
        dependencies: ['docs-branch', 'impl-calc', 'verify'],
        isolationMode: 'shared_readonly',
      },
    ],
  });

  assert.equal(run.status, 'completed');
  assert.equal(run.replanCount, 1);
  assert.equal(docsRuns, 1, 'unrelated completed docs-branch MUST NOT re-run');
  assert.equal(verifyRuns, 2, 'verify fails once, reverify passes once');

  const replans = direct.swarmOrchestrator.listReplans(run.runId);
  assert.equal(replans.length, 1);
  assert.equal(replans[0].strategy, 'repair_and_reverify');

  const pkg = direct.swarmOrchestrator.buildRunDeliveryPackage(run.runId);
  assert.equal(pkg.testResults.at(-1)?.status, 'passed');
  const calcChange = pkg.changedFiles.find((f) => f.path === 'src/calc.js');
  assert.ok(calcChange);
  assert.ok(calcChange.nodeKey.startsWith('repair__'));
  assert.ok(pkg.changedFiles.some((f) => f.path === 'docs/info.txt' && f.nodeKey === 'docs-branch'));

  // Apply all verified artifacts onto parent workspace and verify real parent test now passes!
  const applyRes = direct.swarmOrchestrator.applyAllRunArtifacts(run.runId, { approved: true });
  assert.equal(applyRes.ok, true);

  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_TEST_CONTEXT;
  delete cleanEnv.NODE_TEST_WORKER_ID;
  const postApplyTest = spawnSync(process.execPath, ['--test', 'test/calc.test.js'], {
    cwd: workDir,
    env: cleanEnv,
    encoding: 'utf8',
  });
  assert.equal(postApplyTest.status, 0);
  assert.equal(readFileSync(join(workDir, 'docs/info.txt'), 'utf8'), 'v1 documented\n');
});

test('3b. Reviewer needs_revision triggers bounded repair_and_reverify and respects maxReplans & TaskTreeBudgetLedger ceilings', async (t) => {
  const testCmd = buildRealNodeTestCommand('test/div.test.js');
  let reviewCount = 0;

  const { direct, workDir } = createRuntimeEnv(t, {
    workFiles: {
      'package.json': JSON.stringify({ name: 'review-repair', type: 'module' }),
      'src/div.js': 'export function safeDiv(a, b) { return a / b; }\n',
      'test/div.test.js': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { safeDiv } from '../src/div.js';",
        "test('safeDiv divides numbers', () => {",
        '  assert.equal(safeDiv(10, 2), 5);',
        '});',
      ].join('\n'),
    },
    handler: async function* (opts) {
      const messages = opts.messages ?? [];
      const userText = getLatestAssistantUserText(opts);
      const lastRole = messages.at(-1)?.role;

      if (userText.includes('[Durable evidence manifest]')) {
        const match = /\[Durable evidence manifest\]\s*\n+([\s\S]+)$/.exec(userText);
        const manifest = match ? JSON.parse(match[1].trim()) : { artifacts: [], receipts: [] };
        const art = manifest.artifacts?.at(-1) ?? manifest.artifacts?.[0];
        if (lastRole !== 'tool' && art) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: `tc-rev-read-${reviewCount}`,
              name: 'read_swarm_artifact',
              arguments: JSON.stringify({ uri: art.uri, path: 'src/div.js' }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        reviewCount++;
        const firstReview = reviewCount === 1;
        yield {
          type: 'text-delta',
          index: 0,
          text: JSON.stringify({
            schemaVersion: REVIEWER_SCHEMA_VERSION,
            verdict: firstReview ? 'needs_revision' : 'pass',
            summary: firstReview
              ? 'Missing zero-divisor guard in safeDiv'
              : 'Zero-divisor guard verified after repair',
            evidenceDigest: computeReviewerEvidenceDigest(manifest),
            checkedArtifacts: art ? [art.uri] : [],
            evidenceRefs: [manifest.receipts?.[0]?.receiptId || 'review'],
            findings: firstReview
              ? [{ severity: 'high', message: 'Handle b === 0 by returning null', evidenceRef: art?.uri || 'src/div.js' }]
              : [],
          }),
        };
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 12 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      if (lastRole !== 'tool') {
        if (userText.includes('[Bounded Repair Cycle')) {
          assert.match(userText, /Handle b === 0/);
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-fix-div',
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'src/div.js',
                content: 'export function safeDiv(a, b) { return b === 0 ? null : a / b; }\n',
              }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (userText.includes('WORK_DIV')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-init-div',
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'src/div.js',
                content: 'export function safeDiv(a, b) { return a / b; }\n',
              }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (userText.includes('VERIFY_DIV') || userText.includes('[Re-Verification Cycle')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-verify-div',
              name: 'bash',
              arguments: JSON.stringify({ command: testCmd }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
      }
      yield { type: 'text-delta', index: 0, text: 'done' };
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 6 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const sess = direct.createSession({ permissionMode: 'full-access', workspaceRoot: workDir });
  const repairedByReview = await direct.swarmOrchestrator.startRun({
    sessionId: sess.id,
    goal: 'Implement safe division and pass reviewer audit',
    workspaceRoot: workDir,
    parentPermissionMode: 'full-access',
    maxConcurrency: 2,
    maxReplans: 2,
    budget: { maxSteps: 60, strictReviewerSchema: true },
    nodes: [
      { nodeKey: 'impl-div', taskType: 'implementation', objective: 'WORK_DIV', isolationMode: 'worktree' },
      {
        nodeKey: 'verify-div',
        taskType: 'verification',
        objective: 'VERIFY_DIV',
        dependencies: ['impl-div'],
        isolationMode: 'worktree',
      },
      {
        nodeKey: 'review-div',
        taskType: 'review',
        objective: 'Audit safeDiv implementation and verification tests',
        dependencies: ['impl-div', 'verify-div'],
        isolationMode: 'shared_readonly',
        budget: { maxSteps: 14, reviewerMetadata: { excludedModels: ['prior-worker-model'] } },
      },
    ],
  });

  assert.equal(repairedByReview.status, 'completed');
  assert.equal(repairedByReview.replanCount, 1);
  assert.equal(reviewCount, 2);
  const pkg = direct.swarmOrchestrator.buildRunDeliveryPackage(repairedByReview.runId);
  assert.equal(pkg.reviewerVerdicts.length, 1);
  assert.equal(pkg.reviewerVerdicts[0].status, 'pass');

  const rerun = direct.swarmOrchestrator.getRun(repairedByReview.runId);
  const rereviewNode = rerun.nodes.find((n) => n.nodeKey.startsWith('rereview__'));
  assert.ok(rereviewNode);
  const rereviewBudget =
    rereviewNode.budget && typeof rereviewNode.budget === 'object'
      ? rereviewNode.budget
      : JSON.parse(rereviewNode.budgetJson || '{}');
  assert.ok(rereviewBudget.maxSteps >= 14 && rereviewBudget.maxSteps <= 30);
  assert.ok(Array.isArray(rereviewBudget.reviewerMetadata?.excludedModels));
  assert.ok(rereviewBudget.reviewerMetadata.excludedModels.includes('prior-worker-model'));

  // Part B: Respect maxReplans=1 and strict TaskTreeBudgetLedger ceiling (never inflate maxSteps)
  const boundedEnv = createRuntimeEnv(t, {
    workFiles: {
      'package.json': JSON.stringify({ name: 'budget-cap', type: 'module' }),
      'src/fail.js': 'export const ok = false;\n',
      'test/fail.test.js': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { ok } from '../src/fail.js';",
        "test('always fails', () => { assert.equal(ok, true); });",
      ].join('\n'),
    },
    handler: async function* (opts) {
      const messages = opts.messages ?? [];
      const userText = getLatestAssistantUserText(opts);
      const lastRole = messages.at(-1)?.role;
      if (lastRole !== 'tool') {
        if (userText.includes('ALWAYS_FAIL_VERIFY') || userText.includes('[Re-Verification Cycle')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-always-fail',
              name: 'bash',
              arguments: JSON.stringify({ command: buildRealNodeTestCommand('test/fail.test.js') }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-noop-write',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/fail.js', content: 'export const ok = false;\n' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'failed check' };
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 6 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const bSess = boundedEnv.direct.createSession({ permissionMode: 'full-access' });
  const cappedByMaxReplans = await boundedEnv.direct.swarmOrchestrator.startRun({
    sessionId: bSess.id,
    goal: 'Bounded maxReplans=1 termination check',
    workspaceRoot: boundedEnv.workDir,
    parentPermissionMode: 'full-access',
    maxReplans: 1,
    nodes: [
      { nodeKey: 'verify-fail', taskType: 'verification', objective: 'ALWAYS_FAIL_VERIFY', isolationMode: 'worktree' },
    ],
  });
  assert.equal(cappedByMaxReplans.status, 'failed');
  assert.equal(cappedByMaxReplans.replanCount, 1);

  // Strict TaskTreeBudgetLedger ceiling: maxSteps = 2 -> verify consumes 2 tool/text steps leaving 0 remainingSteps, blocking replan without inflating budget
  const budgetBlocked = await boundedEnv.direct.swarmOrchestrator.startRun({
    sessionId: bSess.id,
    goal: 'Bounded TaskTreeBudgetLedger blocks repair past budget ceiling',
    workspaceRoot: boundedEnv.workDir,
    parentPermissionMode: 'full-access',
    maxReplans: 3,
    budget: { maxSteps: 2 },
    nodes: [
      { nodeKey: 'verify-budget', taskType: 'verification', objective: 'ALWAYS_FAIL_VERIFY', isolationMode: 'worktree' },
    ],
  });
  assert.equal(budgetBlocked.status, 'failed');
  assert.equal(budgetBlocked.replanCount, 0);
  const ledgerSnap = boundedEnv.direct.swarmOrchestrator.budgetLedger.getSnapshot(budgetBlocked.runId);
  assert.equal(ledgerSnap.maxTotalSteps, 2);
});

test('4. Unified GET /v1/swarm/runs/:id/delivery and fail-closed POST /v1/swarm/runs/:id/artifacts/apply-all HTTP routes', async (t) => {
  const verifyCmd = buildRealNodeTestCommand('test/route.test.js');
  const { store, direct, workDir } = createRuntimeEnv(t, {
    workFiles: {
      'package.json': JSON.stringify({ name: 'http-delivery', type: 'module' }),
      'src/a.js': 'export const a = 0;\n',
      'src/b.js': 'export const b = 0;\n',
      'test/route.test.js': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { a } from '../src/a.js';",
        "import { b } from '../src/b.js';",
        "test('route sum', () => { assert.equal(a + b, 3); });",
      ].join('\n'),
    },
    handler: async function* (opts) {
      const messages = opts.messages ?? [];
      const userText = getLatestAssistantUserText(opts);
      const lastRole = messages.at(-1)?.role;

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
              id: 'tc-rev-http',
              name: 'read_swarm_artifact',
              arguments: JSON.stringify({ uri: art.uri, path: 'src/a.js' }),
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
            summary: 'Both modules verified for delivery.',
            evidenceDigest: computeReviewerEvidenceDigest(manifest),
            checkedArtifacts: art ? [art.uri] : [],
            evidenceRefs: [manifest.receipts?.[0]?.receiptId || 'ok'],
            findings: [{ severity: 'info', message: 'Clean implementation', evidenceRef: art?.uri || 'src/a.js' }],
          }),
        };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      if (lastRole !== 'tool') {
        if (userText.includes('WRITE_A')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-http-a',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'src/a.js', content: 'export const a = 1;\n' }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (userText.includes('WRITE_B')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-http-b',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'src/b.js', content: 'export const b = 2;\n' }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (userText.includes('RUN_ROUTE_TEST')) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-http-test',
              name: 'bash',
              arguments: JSON.stringify({ command: verifyCmd }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
      }
      yield { type: 'text-delta', index: 0, text: 'done' };
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 6 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const app = Fastify();
  registerSwarmRoutes(app, { store, directAgent: direct });
  await app.ready();
  t.after(() => app.close());

  const sess = direct.createSession({ permissionMode: 'full-access', workspaceRoot: workDir });
  const run = await direct.swarmOrchestrator.startRun({
    sessionId: sess.id,
    goal: 'Prepare delivery package',
    workspaceRoot: workDir,
    parentPermissionMode: 'full-access',
    maxConcurrency: 2,
    repoContext: {
      branch: 'main',
      headSha: 'deadbeef1234',
      testCommands: [verifyCmd],
      entryPoints: ['src/a.js', 'src/b.js'],
      relevantFiles: ['src/a.js', 'src/b.js'],
      summaryText: 'Fixture HTTP repo summary',
    },
    nodes: [
      { nodeKey: 'mod-a', taskType: 'implementation', objective: 'WRITE_A', isolationMode: 'worktree' },
      { nodeKey: 'mod-b', taskType: 'implementation', objective: 'WRITE_B', isolationMode: 'worktree' },
      {
        nodeKey: 'verify-http',
        taskType: 'verification',
        objective: 'RUN_ROUTE_TEST',
        dependencies: ['mod-a', 'mod-b'],
        isolationMode: 'worktree',
      },
    ],
  });
  assert.equal(run.status, 'completed');

  // 4A. GET /v1/swarm/runs/:id/delivery contract verification
  const delivRes = await app.inject({ method: 'GET', url: `/v1/swarm/runs/${run.runId}/delivery` });
  assert.equal(delivRes.statusCode, 200);
  const pkg = delivRes.json();
  assert.equal(pkg.runId, run.runId);
  assert.equal(pkg.status, 'completed');
  assert.equal(pkg.goal, 'Prepare delivery package');
  assert.equal(pkg.planVersion, 1);
  assert.equal(pkg.repoContext.summaryText, 'Fixture HTTP repo summary');
  assert.deepEqual(
    pkg.changedFiles.map((f) => f.path).sort(),
    ['src/a.js', 'src/b.js'],
  );
  assert.deepEqual(pkg.conflicts, []);
  assert.match(pkg.unifiedDiffPreview, /src\/a\.js/);
  assert.match(pkg.unifiedDiffPreview, /src\/b\.js/);
  assert.equal(pkg.testResults.length, 1);
  assert.equal(pkg.testResults[0].nodeKey, 'verify-http');
  assert.equal(pkg.testResults[0].exitCode, 0);
  assert.equal(pkg.testResults[0].status, 'passed');
  assert.equal(pkg.reviewerVerdicts.length, 1);
  assert.equal(pkg.reviewerVerdicts[0].status, 'pass');
  assert.equal(pkg.reviewerVerdicts[0].findings.length, 1);
  assert.equal(typeof pkg.usage.steps, 'number');
  assert.equal(typeof pkg.usage.inputTokens, 'number');
  assert.equal(typeof pkg.usage.outputTokens, 'number');
  assert.equal(typeof pkg.usage.completedNodes, 'number');
  assert.equal(pkg.usage.replanCount, 0);
  assert.ok(pkg.artifacts.length >= 2);
  for (const artItem of pkg.artifacts) {
    assert.equal(artItem.runId, run.runId);
    assert.ok('nodeId' in artItem && artItem.nodeId);
    assert.ok('ownerId' in artItem);
    assert.equal(artItem.status, 'archived');
    assert.equal(artItem.appliedAt, null);
    assert.equal(typeof artItem.fileCount, 'number');
    assert.equal(typeof artItem.totalBytes, 'number');
    assert.equal(typeof artItem.updatedAt, 'number');
  }
  const verifyArtPkg = pkg.artifacts.find((a) => a.nodeKey === 'verify-http');
  if (verifyArtPkg) {
    assert.equal(verifyArtPkg.fileCount, 0);
  }

  // 404 check on missing runId
  const missingRes = await app.inject({ method: 'GET', url: '/v1/swarm/runs/nonexistent/delivery' });
  assert.equal(missingRes.statusCode, 404);

  // 4B. POST apply-all MUST fail closed 403 without approved === true
  const unapprovedRes = await app.inject({
    method: 'POST',
    url: `/v1/swarm/runs/${run.runId}/artifacts/apply-all`,
    payload: { approved: false },
  });
  assert.equal(unapprovedRes.statusCode, 403);
  assert.equal(unapprovedRes.json().ok, false);
  assert.match(readFileSync(join(workDir, 'src/a.js'), 'utf8'), /a = 0/);

  // 4C. Parent dirty file conflict MUST fail closed 409 without overwriting parent edit OR applying mod-b half-way!
  writeFileSync(join(workDir, 'src/a.js'), 'export const a = 999; // user local edit\n', 'utf8');
  const conflictApplyRes = await app.inject({
    method: 'POST',
    url: `/v1/swarm/runs/${run.runId}/artifacts/apply-all`,
    payload: { approved: true, stopOnConflict: true },
  });
  assert.equal(conflictApplyRes.statusCode, 409);
  const conflictBody = conflictApplyRes.json();
  assert.equal(conflictBody.ok, false);
  assert.ok(conflictBody.conflicts.some((c) => c.path === 'src/a.js'));
  // Atomic stopOnConflict: src/b.js must NOT have been partially applied!
  assert.match(readFileSync(join(workDir, 'src/b.js'), 'utf8'), /b = 0/);
  assert.match(readFileSync(join(workDir, 'src/a.js'), 'utf8'), /user local edit/);

  // Restore src/a.js back to clean baseline so apply-all succeeds
  writeFileSync(join(workDir, 'src/a.js'), 'export const a = 0;\n', 'utf8');
  const applyOkRes = await app.inject({
    method: 'POST',
    url: `/v1/swarm/runs/${run.runId}/artifacts/apply-all`,
    payload: { approved: true, stopOnConflict: true },
  });
  assert.equal(applyOkRes.statusCode, 200);
  const applyOkBody = applyOkRes.json();
  assert.equal(applyOkBody.ok, true);
  assert.equal(applyOkBody.status, 'applied');
  assert.equal(readFileSync(join(workDir, 'src/a.js'), 'utf8'), 'export const a = 1;\n');
  assert.equal(readFileSync(join(workDir, 'src/b.js'), 'utf8'), 'export const b = 2;\n');

  const postApplyDelivRes = await app.inject({ method: 'GET', url: `/v1/swarm/runs/${run.runId}/delivery` });
  assert.equal(postApplyDelivRes.statusCode, 200);
  const postApplyPkg = postApplyDelivRes.json();
  for (const artItem of postApplyPkg.artifacts) {
    assert.equal(artItem.status, 'applied');
    assert.equal(typeof artItem.appliedAt, 'number');
    assert.ok(artItem.appliedAt > 0);
  }

  // Repeat call MUST be cleanly idempotent (status: 'already_applied')
  const idempotentRes = await app.inject({
    method: 'POST',
    url: `/v1/swarm/runs/${run.runId}/artifacts/apply-all`,
    payload: { approved: true },
  });
  assert.equal(idempotentRes.statusCode, 200);
  assert.equal(idempotentRes.json().ok, true);
  assert.equal(idempotentRes.json().status, 'already_applied');

  // 4D. Unverified / failed run MUST fail closed 409
  const failedSess = direct.createSession({ permissionMode: 'full-access' });
  const failedRun = await direct.swarmOrchestrator.startRun({
    sessionId: failedSess.id,
    goal: 'Failed run apply guard',
    workspaceRoot: workDir,
    parentPermissionMode: 'full-access',
    maxReplans: 0,
    nodes: [
      { nodeKey: 'bad-verify', taskType: 'verification', objective: 'RUN_ROUTE_TEST', isolationMode: 'worktree' },
    ],
  });
  // Force non-zero test in workDir baseline? No, post-apply src/a+b=3 passed, so fail via unverified run directly:
  store.db.prepare("UPDATE swarm_runs SET status='failed' WHERE id=?").run(failedRun.runId);
  const unverifiedApplyRes = await app.inject({
    method: 'POST',
    url: `/v1/swarm/runs/${failedRun.runId}/artifacts/apply-all`,
    payload: { approved: true },
  });
  assert.equal(unverifiedApplyRes.statusCode, 409);
  assert.equal(unverifiedApplyRes.json().ok, false);
});
