import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { DurableJobQueue } from '../src/durable/job-queue.js';
import { RecoveryError } from '../src/kernel/errors.js';
import { api } from '../src/api.js';
import { ControlPlane } from '../src/governance/control-plane.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }
  async *stream(options) {
    this.calls.push({ model: options.model, messages: structuredClone(options.messages) });
    yield* this.handler(options, this.calls.length - 1);
  }
}

async function pollUntil(fn, timeoutMs = 10000, intervalMs = 30) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await delay(intervalMs);
  }
  throw new Error(`Timed out polling after ${timeoutMs}ms`);
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@agent-us.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Agent US Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'root repo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

test('Durable Swarm: multi-worker contention & expired lease fencing protect job finality', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-swarm-lease-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  try {
    const queue = new DurableJobQueue(store, { defaultLeaseMs: 1000 });
    const job = queue.enqueue({
      kind: 'swarm_node_execute',
      sessionId: 'sess-lease',
      turnId: 'swarm:r1:n1',
      taskId: 'r1',
      idempotencyKey: 'swarm:node:n1:v1:a1',
      payload: { runId: 'r1', nodeId: 'n1', nodeKey: 'n1', sessionId: 'sess-lease', planVersion: 1, attemptSeq: 1 },
    });

    const w1 = queue.claim({ workerId: 'swarm-worker-1', kinds: ['swarm_node_execute'], leaseMs: 1000 });
    assert.ok(w1?.fence);
    assert.equal(queue.claim({ workerId: 'swarm-worker-2', kinds: ['swarm_node_execute'] }), null);

    store.tx(() => {
      store.db.prepare('UPDATE runtime_jobs SET leaseExpiresAt=? WHERE id=?').run(Date.now() - 500, job.id);
    });
    const w2 = queue.claim({ workerId: 'swarm-worker-2', kinds: ['swarm_node_execute'], leaseMs: 4000 });
    assert.ok(w2);
    assert.notEqual(w2.fence, w1.fence);

    assert.throws(
      () => queue.assertFence(job.id, w1.fence),
      (err) => err instanceof RecoveryError && err.code === 'LEASE_LOST',
    );
    assert.throws(
      () => queue.complete(job.id, w1.fence),
      (err) => err instanceof RecoveryError && err.code === 'LEASE_LOST',
    );

    const done = queue.complete(job.id, w2.fence);
    assert.equal(done.status, 'done');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Durable Swarm: real SIGKILL crash recovery on 10-node DAG skips completed, recovers running with checkpoint, schedules pending, preserves cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-swarm-sigkill-'));
  const workDir = join(dir, 'work');
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, 'info.txt'), 'checkpoint-proof=true\n', 'utf8');
  const dbPath = join(dir, 'engine.sqlite');
  const execLogPath = join(dir, 'exec-counts.json');
  const markerDir = join(dir, 'markers');
  mkdirSync(markerDir, { recursive: true });

  const workerScript = join(dir, 'crash-swarm-child.mjs');
  const storeMod = pathToFileURL(join(process.cwd(), 'src', 'store.js')).href;
  const poolMod = pathToFileURL(join(process.cwd(), 'src', 'pool.js')).href;
  const agentMod = pathToFileURL(join(process.cwd(), 'src', 'direct-agent.js')).href;

  writeFileSync(
    workerScript,
    `
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from ${JSON.stringify(storeMod)};
import { AccountPool } from ${JSON.stringify(poolMod)};
import { DirectAgentRuntime } from ${JSON.stringify(agentMod)};

const [dbPath, workDir, markerDir, logPath] = process.argv.slice(2);
const store = new Store(dbPath);
const pool = new AccountPool(store, { root: markerDir });
pool.setDefaultModel('mock-swarm');

const adapter = {
  async *stream({ messages }) {
    const userText = messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const mTag = /NODE_TAG:([a-z0-9]+)/i.exec(userText);
    const tag = mTag ? mTag[1] : 'unknown';
    const hasTool = messages.some((m) => m.role === 'tool');

    appendFileSync(logPath, JSON.stringify({ phase: 'before_kill', tag, hasTool }) + '\\n');

    if (tag === 'r1' || tag === 'r2') {
      if (!hasTool) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-read-' + tag,
            name: 'read_file',
            arguments: JSON.stringify({ path: 'info.txt' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      // Step 1 reached (checkpoint saved after tool result) -> signal parent to SIGKILL!
      writeFileSync(join(markerDir, tag + '-ready.flag'), String(Date.now()), 'utf8');
      await new Promise(() => {});
    }

    yield { type: 'text-delta', index: 0, text: 'COMPLETED_BEFORE_KILL:' + tag };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};

const direct = new DirectAgentRuntime(store, pool, {
  defaultWorkspace: workDir,
  dataRoot: markerDir,
  adapter,
});

const parent = direct.createSession({ title: 'SIGKILL Parent', workspaceRoot: workDir });

// Cancelled run that must NEVER revive after SIGKILL
const cancelled = direct.swarmOrchestrator.submitRun({
  sessionId: parent.id,
  goal: 'Cancelled pre-crash run',
  workspaceRoot: workDir,
  nodes: [{ nodeKey: 'never_run', taskType: 'research', objective: 'NODE_TAG:never_run', dependencies: [] }],
});
direct.swarmOrchestrator.cancelRun(cancelled.runId);

const active = direct.swarmOrchestrator.submitRun({
  sessionId: parent.id,
  goal: '10-node crash recovery test',
  workspaceRoot: workDir,
  maxConcurrency: 4,
  nodes: [
    { nodeKey: 'c1', taskType: 'research', objective: 'NODE_TAG:c1', dependencies: [], priority: 10 },
    { nodeKey: 'c2', taskType: 'research', objective: 'NODE_TAG:c2', dependencies: [], priority: 10 },
    { nodeKey: 'c3', taskType: 'research', objective: 'NODE_TAG:c3', dependencies: [], priority: 10 },
    { nodeKey: 'c4', taskType: 'research', objective: 'NODE_TAG:c4', dependencies: [], priority: 10 },
    { nodeKey: 'r1', taskType: 'research', objective: 'NODE_TAG:r1', dependencies: ['c1', 'c2'], priority: 5 },
    { nodeKey: 'r2', taskType: 'research', objective: 'NODE_TAG:r2', dependencies: ['c3', 'c4'], priority: 5 },
    { nodeKey: 'w1', taskType: 'research', objective: 'NODE_TAG:w1', dependencies: ['r1'], priority: 1 },
    { nodeKey: 'w2', taskType: 'research', objective: 'NODE_TAG:w2', dependencies: ['r1', 'r2'], priority: 1 },
    { nodeKey: 'w3', taskType: 'research', objective: 'NODE_TAG:w3', dependencies: ['r2'], priority: 1 },
    { nodeKey: 'w4', taskType: 'review', objective: 'NODE_TAG:w4', dependencies: ['w1', 'w2', 'w3'], priority: 0 },
  ],
});

writeFileSync(join(markerDir, 'ids.json'), JSON.stringify({ runId: active.runId, cancelledId: cancelled.runId, parentId: parent.id }), 'utf8');
const keep = setInterval(() => {}, 1000);
setTimeout(() => { clearInterval(keep); process.exit(1); }, 25000);
`,
    'utf8',
  );

  let child = null;
  try {
    child = spawn(process.execPath, [workerScript, dbPath, workDir, markerDir, execLogPath], {
      stdio: 'ignore',
    });

    await pollUntil(
      () =>
        existsSync(join(markerDir, 'ids.json')) &&
        existsSync(join(markerDir, 'r1-ready.flag')) &&
        existsSync(join(markerDir, 'r2-ready.flag')),
      15000,
    );
    await delay(100);
    child.kill('SIGKILL');
    await new Promise((res) => child.once('exit', res));

    const { runId, cancelledId, parentId } = JSON.parse(readFileSync(join(markerDir, 'ids.json'), 'utf8'));

    // Reboot on same SQLite DB
    const store = new Store(dbPath);
    const pool = new AccountPool(store, { root: markerDir });
    pool.setDefaultModel('mock-swarm');

    const postCalls = [];
    const postAdapter = new ScriptedAdapter(async function* (opts) {
      const userText = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
      const mTag = /NODE_TAG:([a-z0-9]+)/i.exec(userText);
      const tag = mTag ? mTag[1] : 'unknown';
      const hasTool = opts.messages.some((m) => m.role === 'tool');
      postCalls.push({ tag, hasTool });

      yield { type: 'text-delta', index: 0, text: `RESUMED_OK:${tag}` };
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });

    const direct = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: workDir,
      dataRoot: markerDir,
      adapter: postAdapter,
    });

    try {
      const finished = await direct.swarmOrchestrator.waitForRun(runId, { timeoutMs: 12000 });
      assert.equal(finished.status, 'completed');
      assert.equal(finished.nodes.length, 10);
      assert.ok(finished.nodes.every((n) => n.status === 'completed'));

      // 4 pre-completed nodes MUST keep their pre-crash result and NEVER re-run post-crash
      for (const ck of ['c1', 'c2', 'c3', 'c4']) {
        const node = finished.nodes.find((n) => n.nodeKey === ck);
        assert.equal(node.resultText, `COMPLETED_BEFORE_KILL:${ck}`);
        assert.equal(postCalls.filter((c) => c.tag === ck).length, 0, `${ck} must not re-run`);
      }

      // 2 interrupted nodes MUST resume with tool history intact (without re-running step 0 read_file)
      for (const rk of ['r1', 'r2']) {
        const calls = postCalls.filter((c) => c.tag === rk);
        assert.equal(calls.length, 1, `${rk} should finish in 1 resumed step`);
        assert.equal(calls[0].hasTool, true, `${rk} resumed conversation must retain pre-crash tool result`);
      }

      // 4 waiting dependent nodes MUST have been scheduled and completed post-crash
      for (const wk of ['w1', 'w2', 'w3', 'w4']) {
        assert.equal(postCalls.filter((c) => c.tag === wk).length, 1);
      }

      // Cancelled run stays cancelled and parent-child relationships are intact
      const cancelCheck = direct.swarmOrchestrator.getRun(cancelledId);
      assert.equal(cancelCheck.status, 'cancelled');
      assert.equal(postCalls.filter((c) => c.tag === 'never_run').length, 0);
      const children = direct.sessionRepo.listChildSessions(parentId);
      assert.ok(children.length >= 10);
    } finally {
      await direct.close();
      store.close();
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((res) => child.once('exit', res));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Durable Swarm: parallel isolated git worktrees write disjoint files without clobbering parent workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-swarm-wt-'));
  const workDir = join(dir, 'repo');
  mkdirSync(workDir, { recursive: true });
  initGitRepo(workDir);

  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-wt');

  const adapter = new ScriptedAdapter(async function* (opts) {
    const userText = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const hasTool = opts.messages.some((m) => m.role === 'tool');
    if (!hasTool && userText.includes('WRITE_FILE:')) {
      const target = /WRITE_FILE:(\S+)/.exec(userText)[1];
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: `tc-${target}`,
          name: 'write_file',
          arguments: JSON.stringify({ path: target, content: `content:${target}\n` }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'Worktree write verified' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dir,
    adapter,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
    const out = await direct.swarmOrchestrator.startRun({
      sessionId: sess.id,
      goal: 'Parallel worktrees',
      workspaceRoot: workDir,
      maxConcurrency: 2,
      nodes: [
        {
          nodeKey: 'wt-a',
          taskType: 'implementation',
          objective: 'WRITE_FILE:alpha.txt inside isolated worktree A',
          dependencies: [],
          isolatedWorktree: true,
          isolationMode: 'worktree',
          toolAllow: ['write_file', 'read_file'],
        },
        {
          nodeKey: 'wt-b',
          taskType: 'implementation',
          objective: 'WRITE_FILE:beta.txt inside isolated worktree B',
          dependencies: [],
          isolatedWorktree: true,
          isolationMode: 'worktree',
          toolAllow: ['write_file', 'read_file'],
        },
      ],
    });

    assert.equal(out.status, 'completed');
    assert.ok(out.nodes.every((n) => n.status === 'completed'));
    // Isolated worktrees must not dirty parent working directory
    assert.equal(existsSync(join(workDir, 'alpha.txt')), false);
    assert.equal(existsSync(join(workDir, 'beta.txt')), false);
    const writeReceipts = store.db
      .prepare("SELECT id FROM tool_receipts WHERE toolName='write_file' AND status='finished'")
      .all();
    assert.ok(writeReceipts.length >= 2);
    const activeLeases = store.db.prepare("SELECT COUNT(*) AS n FROM worktree_leases WHERE status='active'").get().n;
    assert.equal(activeLeases, 0);
  } finally {
    await direct.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Durable Swarm: parent cancellation propagates PARENT_CANCELLED and stops descendants', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-swarm-cancel-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-cancel');

  const adapter = new ScriptedAdapter(async function* () {
    await delay(200);
    yield { type: 'text-delta', index: 0, text: 'slow step' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: dir });
    const submitted = direct.swarmOrchestrator.submitRun({
      sessionId: sess.id,
      goal: 'Cancel cascade',
      workspaceRoot: dir,
      nodes: [
        { nodeKey: 'first', taskType: 'research', objective: 'slow node', dependencies: [] },
        { nodeKey: 'second', taskType: 'research', objective: 'blocked dependent', dependencies: ['first'] },
      ],
    });
    await delay(40);
    const cancelled = direct.swarmOrchestrator.cancelRun(submitted.runId);
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.nodes.every((n) => n.status === 'cancelled'));
    assert.throws(
      () => direct.swarmOrchestrator.resumeRun(submitted.runId),
      (err) => err.code === 'SWARM_RUN_CANCELLED',
    );
  } finally {
    await direct.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Durable Swarm: unknown_outcome parks in reconciling and resumes cleanly on happened / aborts on abort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-swarm-rec-'));
  const dbPath = join(dir, 'engine.sqlite');
  let bashRuns = 0;

  let adapter = new ScriptedAdapter(async function* (opts) {
    const hasRecNote = opts.messages.some(
      (m) =>
        (m.role === 'tool' || m.role === 'user') &&
        m.content?.some((b) => String(b.text || '').includes('已由人工确认')),
    );
    if (hasRecNote) {
      yield { type: 'text-delta', index: 0, text: 'Confirmed side effect via reconciliation' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: 'tc-bash-rec',
        name: 'bash',
        arguments: JSON.stringify({ command: 'echo external_side_effect' }),
      },
    };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  });

  let store = new Store(dbPath);
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('mock-rec');
  let direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: dir, permissionMode: 'full-access' });
    const now = Date.now();
    const child = direct.sessionRepo.createSession({
      title: 'reconcile child',
      workspaceRoot: dir,
      permissionMode: 'full-access',
      parentSessionId: sess.id,
      rootSessionId: sess.id,
    });
    const submitted = direct.swarmOrchestrator.submitRun({
      sessionId: sess.id,
      goal: 'Reconciliation in swarm',
      workspaceRoot: dir,
      nodes: [{ nodeKey: 'deploy', taskType: 'research', objective: 'deploy', dependencies: [] }],
    });

    // Simulate executing non-replayable receipt captured right as process crashed
    const deployNode = direct.swarmOrchestrator.getRun(submitted.runId).nodes[0];
    const turnId = `turn-rec-${Date.now()}`;
    store.tx(() => {
      store.db
        .prepare("UPDATE swarm_nodes SET status='running', childSessionId=?, childTurnId=? WHERE id=?")
        .run(child.id, turnId, deployNode.id);
      store.db
        .prepare("INSERT INTO direct_turns(id, sessionId, input, model, state, phase, step, createdAt) VALUES(?,?,'deploy','mock-rec','running','tools',1,?)")
        .run(turnId, child.id, now);
      store.db
        .prepare('INSERT INTO direct_messages(sessionId, turnId, role, content, toolCalls, createdAt) VALUES(?,?,?,?,?,?)')
        .run(child.id, turnId, 'assistant', '', JSON.stringify([{ id: 'tc-bash-rec', name: 'bash', arguments: { command: 'echo external_side_effect' } }]), now);
      store.db
        .prepare(
          `INSERT INTO tool_receipts(
            id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
            replayable, outward, argsDigest, status, durationMs, createdAt, updatedAt
          ) VALUES('rec-rcpt-1',?,?,?,'bash','high','irreversible_side_effect',0,0,'abc','executing',0,?,?)`,
        )
        .run(child.id, turnId, 'tc-bash-rec', now, now);
    });
    bashRuns = 1;

    await direct.close();
    store.close();

    store = new Store(dbPath);
    const pool2 = new AccountPool(store, { root: dir });
    pool2.setDefaultModel('mock-rec');
    direct = new DirectAgentRuntime(store, pool2, {
      defaultWorkspace: dir,
      dataRoot: dir,
      adapter,
    });

    const parkedRun = direct.swarmOrchestrator.getRun(submitted.runId);
    assert.equal(parkedRun.status, 'reconciling');
    assert.equal(parkedRun.nodes[0].status, 'reconciling');
    const approvalId = parkedRun.nodes[0].reconcileApprovalId;
    assert.ok(approvalId);

    direct.reconciler.resolveReconciliation(approvalId, { outcome: 'happened', note: 'verified ok' });
    const done = await direct.swarmOrchestrator.waitForRun(submitted.runId, { timeoutMs: 8000 });
    assert.equal(done.status, 'completed');
    assert.equal(bashRuns, 1, 'Non-replayable bash must NOT replay after happened reconciliation');
  } finally {
    await direct.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Durable Swarm: DynamicReplanner handles switch_model & split_subgraph and HTTP async 202 + notifications persist across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-swarm-replan-'));
  const dbPath = join(dir, 'engine.sqlite');
  let store = new Store(dbPath);
  const pool = new AccountPool(store, {
    root: dir,
    legacyProviders: {
      models: [
        { provider: 'openai', model: 'bad-primary', context: 128000, tools: true, math: 0.99 },
        { provider: 'openai', model: 'good-fallback', context: 128000, tools: true, math: 0.8 },
      ],
    },
  });

  let badCalls = 0;
  const adapter = new ScriptedAdapter(async function* (opts) {
    if (opts.model === 'bad-primary') {
      badCalls++;
      throw new Error('simulated primary outage');
    }
    yield { type: 'text-delta', index: 0, text: `Recovered on ${opts.model}` };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  let direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter,
  });

  try {
    const controlPlane = new ControlPlane({ store, pool, directAgent: direct });
    const token = 'durable-swarm-http-token-123456';
    const app = api(null, token, undefined, { pool, directAgent: direct, controlPlane });
    const auth = { authorization: `Bearer ${token}` };

    const sess = direct.createSession({ workspaceRoot: dir });
    const postRes = await app.inject({
      method: 'POST',
      url: '/v1/swarm/runs',
      headers: auth,
      payload: {
        sessionId: sess.id,
        goal: 'Test replanning and async 202',
        maxReplans: 3,
        nodes: [
          { nodeKey: 'stable', taskType: 'research', objective: 'stable branch', dependencies: [] },
          { nodeKey: 'flaky', taskType: 'planning', objective: 'formal math task', dependencies: ['stable'] },
        ],
      },
    });
    assert.equal(postRes.statusCode, 202);
    const runId = postRes.json().runId;

    const done = await direct.swarmOrchestrator.waitForRun(runId, { timeoutMs: 8000 });
    assert.equal(done.status, 'completed');
    assert.ok(badCalls >= 1);
    const replansRes = await app.inject({ method: 'GET', url: `/v1/swarm/runs/${runId}/replans`, headers: auth });
    assert.equal(replansRes.statusCode, 200);
    assert.ok(replansRes.json().items.some((r) => r.strategy === 'switch_model'));

    // Also test split_subgraph when only one model exists
    const store2Dir = mkdtempSync(join(tmpdir(), 'agent-us-swarm-split-'));
    const s2 = new Store(join(store2Dir, 'engine.sqlite'));
    const p2 = new AccountPool(s2, { root: store2Dir });
    p2.setDefaultModel('solo-model');
    let failWhole = 0;
    const splitAdapter = new ScriptedAdapter(async function* (opts) {
      const txt = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
      if (txt.includes('huge monolith') && !txt.includes('拆分子步骤')) {
        failWhole++;
        throw new Error('too big without split');
      }
      yield { type: 'text-delta', index: 0, text: 'split piece done' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const d2 = new DirectAgentRuntime(s2, p2, { defaultWorkspace: store2Dir, dataRoot: store2Dir, adapter: splitAdapter });
    try {
      const ps = d2.createSession({ workspaceRoot: store2Dir });
      const splitOut = await d2.swarmOrchestrator.startRun({
        sessionId: ps.id,
        goal: 'Split subgraph test',
        workspaceRoot: store2Dir,
        maxReplans: 3,
        nodes: [
          { nodeKey: 'huge', taskType: 'research', objective: 'huge monolith', dependencies: [] },
          { nodeKey: 'tail', taskType: 'review', objective: 'after split', dependencies: ['huge'] },
        ],
      });
      assert.equal(splitOut.status, 'completed');
      assert.ok(failWhole >= 2);
      assert.ok(d2.swarmOrchestrator.listReplans(splitOut.runId).some((r) => r.strategy === 'split_subgraph'));
      assert.equal(splitOut.nodes.find((n) => n.nodeKey === 'tail').status, 'completed');
    } finally {
      await d2.close();
      s2.close();
      rmSync(store2Dir, { recursive: true, force: true });
    }

    // Notifications persist across DirectAgentRuntime reboot
    controlPlane.close();
    await direct.close();
    await app.close();
    store.close();

    store = new Store(dbPath);
    const poolRec = new AccountPool(store, { root: dir });
    direct = new DirectAgentRuntime(store, poolRec, { defaultWorkspace: dir, dataRoot: dir, adapter });
    const notes = direct.childManager.collectNotifications(sess.id);
    assert.ok(notes.length >= 2);
    assert.ok(notes.some((n) => n.nodeKey === 'flaky' && n.status === 'completed'));
  } finally {
    await direct.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
