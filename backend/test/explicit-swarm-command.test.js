import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { api } from '../src/api.js';
import { parseSwarmCommand } from '../src/swarm/command.js';
import { rmDirSafe } from './fixtures.js';

test('exact slash command parses Chinese, English and multiline task text', () => {
  for (const input of [
    '/swarmx',
    '解释 /swarm stop',
    '`/swarm status`',
    '/swarm/status',
    'text\n/swarm',
    null,
  ]) {
    assert.equal(parseSwarmCommand(input), null);
  }
  for (const [input, action, task] of [
    ['/swarm ', 'help', ''],
    [' /SWARM　STATUS ', 'status', ''],
    ['/swarm stop', 'stop', ''],
    ['/swarm stop a leak', 'start', 'stop a leak'],
    ['/swarm 检查代码\n并测试', 'start', '检查代码\n并测试'],
  ])
    assert.deepEqual(parseSwarmCommand(input), { action, task });
});

test('chat ingress persists, deduplicates and scopes a planning run; stale stop cannot cancel its successor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'explicit-swarm-'));
  const store = new Store(join(dir, 'state.db'));
  const pool = new AccountPool(store, { root: dir });
  const direct = new DirectAgentRuntime(store, pool, {
    dataRoot: dir,
    defaultWorkspace: dir,
  });
  const token = 'explicit-command-local-test-token';
  const app = api(
    store,
    token,
    { models: [], list: () => [] },
    { directAgent: direct, pool },
  );
  try {
    // Hold execution at the durable queue boundary so races are deterministic.
    await direct.recoveryWorker.stop();
    const s = direct.createSession({
      permissionMode: 'read-only',
      budget: { maxTotalTokens: 7000 },
    });
    const other = direct.createSession({});
    const post = (input, clientTurnId, sessionId = s.id, opts = {}) =>
      app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/turns`,
        headers: { authorization: `Bearer ${token}` },
        payload: { input, clientTurnId, ...opts },
      });
    const send = async (...args) => {
      const res = await post(...args);
      assert.equal(res.statusCode, 200, res.body);
      return res.json();
    };
    assert.equal((await send('/swarm')).action, 'help');
    assert.equal((await send('/swarm status')).run, null);
    const durableReceipts = [];
    const unsubscribe = direct.subscribe(s.id, (event) => {
      if (event.type === 'swarm/run_started') durableReceipts.push(store.db.prepare(
        'SELECT runId FROM swarm_command_receipts WHERE sessionId=? AND clientTurnId=?',
      ).get(s.id, 'start-1')?.runId);
    });
    const start = await send('/swarm 分析依赖', 'start-1', s.id, {
      permissionMode: 'full-access',
      budget: { maxTotalTokens: 9000, maxSteps: 6 },
    });
    unsubscribe();
    assert.deepEqual(durableReceipts, [start.runId]);
    assert.equal(start.run.status, 'planning');
    assert.equal(start.run.permissionMode, 'read-only');
    assert.equal(start.ledger.maxTotalTokens, 7000);
    assert.equal(start.ledger.maxTotalSteps, 6);
    assert.equal((await send('/swarm 分析依赖', 'start-1')).runId, start.runId);
    assert.equal((await post('/swarm 其他任务', 'start-1')).statusCode, 409);
    assert.equal((await post('/swarm 新任务', 'start-2')).statusCode, 409);
    assert.equal((await post('普通消息', 'direct-1')).statusCode, 409);
    assert.equal((await send('/swarm status', undefined, other.id)).run, null);
    assert.equal((await send('/swarm stop', 'stop-other', other.id)).run, null);
    assert.equal((await send('/swarm status')).run.status, 'planning');
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM direct_turns').get().n,
      0,
    );
    assert.equal(
      store.db
        .prepare('SELECT COUNT(*) AS n FROM runtime_jobs WHERE taskId=?')
        .get(start.runId).n,
      1,
    );
    assert.equal((await send('/swarm stop', 'stop-1')).run.status, 'cancelled');
    assert.equal(
      store.db
        .prepare('SELECT status FROM runtime_jobs WHERE taskId=?')
        .get(start.runId).status,
      'cancelled',
    );
    const successor = await send('/swarm 新任务', 'start-2');
    assert.notEqual(successor.runId, start.runId);
    assert.equal((await send('/swarm stop', 'stop-1')).runId, start.runId);
    assert.equal((await send('/swarm status')).runId, successor.runId);
    assert.equal((await send('/swarm status')).run.status, 'planning');
    assert.equal((await send('/swarm stop', 'stop-2')).run.status, 'cancelled');
    const plain = await send('修改这个文件', 'direct-1');
    assert.ok(plain.turn.id);
    assert.equal((await post('/swarm 继续', 'start-3')).statusCode, 409);
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM swarm_runs').get().n,
      2,
    );
  } finally {
    await direct.close();
    await app.close();
    store.close();
    rmDirSafe(dir);
  }
});

test('slash goals run the durable planner and launch one or multiple real child sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'explicit-swarm-worker-'));
  const workspace = mkdtempSync(join(tmpdir(), 'explicit-workspace-'));
  const store = new Store(join(dir, 'state.db'));
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('scripted');
  const adapter = {
    async *stream({ messages }) {
      const system =
        messages.find((m) => m.role === 'system')?.content?.[0]?.text ?? '';
      const input =
        messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
      let text = 'Completed the requested inspection.';
      if (system.includes('Decompose the engineering goal')) {
        const keys = input.includes('两个独立模块')
          ? ['module-a', 'module-b', 'summarize']
          : ['inspect'];
        text = JSON.stringify({
          nodes: keys.map((key) => ({
            nodeKey: key,
            taskType: 'research',
            objective: `Inspect ${key}`,
            acceptance: `Describe ${key}`,
            dependencies: key === 'summarize' ? keys.slice(0, 2) : [],
          })),
        });
      }
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 12 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workspace,
    dataRoot: dir,
    adapter,
  });
  const token = 'explicit-worker-local-test-token';
  const app = api(
    store,
    token,
    { models: [], list: () => [] },
    { directAgent: direct, pool },
  );
  try {
    const session = direct.createSession({ workspaceRoot: workspace });
    const events = [];
    const unsub = direct.subscribe(session.id, (e) => events.push(e));
    for (const [goal, count] of [
      ['解释一个函数', 1],
      ['分析两个独立模块后汇总', 3],
    ]) {
      const submit = (input) =>
        app.inject({
          method: 'POST',
          url: `/v1/sessions/${session.id}/turns`,
          headers: { authorization: `Bearer ${token}` },
          payload: { input },
        });
      const start = await submit(`/swarm ${goal}`);
      assert.equal(start.statusCode, 200, start.body);
      const { runId } = start.json();
      await direct.swarmOrchestrator.waitForRun(runId, {
        signal: AbortSignal.timeout(18000),
      });
      const { run, ledger } = (await submit('/swarm status')).json();
      assert.equal(run.status, 'completed', run.errorMessage);
      assert.equal(run.id, runId);
      assert.equal(run.nodes.length, count);
      assert.equal(
        new Set(run.nodes.map((n) => n.childSessionId).filter(Boolean)).size,
        count,
      );
      assert.equal(run.plan.tasks.length, count);
      if (count > 1)
        assert.deepEqual(
          run.nodes.find((n) => n.nodeKey === 'summarize').dependencies,
          ['module-a', 'module-b'],
        );
      assert.ok(ledger.usedSteps > 0);
      assert.ok(events.some((e) => e.data?.runId === run.id));
    }
    unsub();
  } finally {
    await direct.close();
    await app.close();
    store.close();
    rmDirSafe(dir);
    rmDirSafe(workspace);
  }
});
