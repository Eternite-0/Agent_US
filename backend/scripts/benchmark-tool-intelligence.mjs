import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from '../test/fixtures.js';

const source = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const n = Number(process.argv[3] ?? 3);
assert.ok(Number.isInteger(n) && n > 0 && n <= 25);
const moduleAt = (path) => import(pathToFileURL(join(source, 'src', path)).href);
const { Store } = await moduleAt('store.js');
const { AccountPool } = await moduleAt('pool.js');
const { DirectAgentRuntime } = await moduleAt('direct-agent.js');
const { McpLifecycleManager } = await moduleAt('tools/mcp-lifecycle.js');
const { createWorkspaceTools } = await moduleAt('workspace-tools.js');
const { ToolDispatcher } = await moduleAt('tools/dispatcher.js');
const { scheduleToolBatch } = await moduleAt('patch-and-diagnostics.js');
const { UnknownOutcomeReconciler } = await moduleAt('durable/reconciliation.js');
const server = fileURLToPath(new URL('./fixtures/tool-intelligence-mcp-server.mjs', import.meta.url));

const call = (id, name, args = {}) => ({ id, name, arguments: JSON.stringify(args) });
const bash = (id, command) => call(id, 'bash', { command });
const toolOutput = (opts, id) => opts.messages.find((m) => m.toolCallId === id)?.content[0]?.text ?? '';
const json = (filename, data) => writeFileSync(filename, JSON.stringify(data) + '\n');

// Identical model-side decision policy in both runs. This exercises the real
// streaming loop, not provider reasoning quality; validators never trust prose.
class RepairAdapter extends LlmAdapter {
  steps = 0;
  async *stream(opts) {
    this.steps++;
    const repair = opts.messages.some((m) => m.role === 'user' && m.content.some((b) => b.text?.includes('FABRICATED_PASS_CLAIM')));
    let calls;
    if (!toolOutput(opts, 'catalog')) {
      calls = [
        call('catalog', 'glob', { pattern: '*' }),
        call('source', 'read_file', { path: 'total.mjs' }),
        call('test-source', 'read_file', { path: 'total.test.mjs' }),
      ];
    } else if (!toolOutput(opts, 'test-initial')) {
      calls = [bash('test-initial', 'node --test total.test.mjs'), bash('diagnostic', 'git status --short')];
    } else if (repair && !toolOutput(opts, 'test-final')) {
      const sourceText = toolOutput(opts, 'source');
      const testText = toolOutput(opts, 'test-source');
      assert.match(sourceText, /price - fee/);
      assert.match(testText, /total\(100, 7\), 107/);
      assert.match(toolOutput(opts, 'test-initial'), /AssertionError/);
      calls = [
        call('fix', 'edit_file', { path: 'total.mjs', target: 'price - fee', replacement: 'price + fee' }),
        bash('test-final', 'node --test total.test.mjs'),
      ];
    }
    if (calls) {
      for (const [index, tc] of calls.entries()) {
        yield { type: 'block-end', index, block: { type: 'tool-call', ...tc } };
      }
    } else {
      yield { type: 'text-delta', index: 0, text: 'All tests passed.' };
    }
    yield { type: 'finish', reason: { kind: calls ? 'tool-calls' : 'stop' } };
  }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-ti-bench-'));
  const root = join(dir, 'workspace');
  const data = join(dir, 'operator');
  mkdirSync(root);
  mkdirSync(data);
  return { dir, root, data };
}

async function repairTask() {
  const { dir, root, data } = fixture();
  const store = new Store(join(data, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: data });
  const adapter = new RepairAdapter();
  pool.setDefaultModel('fixture-model');
  const direct = new DirectAgentRuntime(store, pool, { defaultWorkspace: root, dataRoot: data, adapter });
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    json(join(root, 'package.json'), { type: 'module', name: 'billing-fixture' });
    writeFileSync(join(root, 'total.mjs'), 'export const total = (price, fee) => price - fee;\n');
    const testSource = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from './total.mjs';\ntest('includes the fee', () => assert.equal(total(100, 7), 107));\n`;
    writeFileSync(join(root, 'total.test.mjs'), testSource);
    const session = direct.createSession({ workspaceRoot: root, permissionMode: 'approval' });
    const start = performance.now();
    const decisions = [];
    // Simulated operator explicitly approves only the fixture's exact requested actions.
    const unsubscribe = direct.subscribe(session.id, (event) => {
      if (event.type !== 'approval/requested') return;
      const item = event.data;
      const args = item.arguments;
      const allow = (item.tool === 'bash' && ['node --test total.test.mjs', 'git status --short'].includes(args?.command)) ||
        (item.tool === 'edit_file' && args?.path === 'total.mjs' && args?.target === 'price - fee' && args?.replacement === 'price + fee');
      decisions.push([item.tool, allow]);
      queueMicrotask(() => direct.decideApproval(item.approvalId, { decision: allow ? 'allow' : 'deny' }));
    });
    const started = direct.startTurn(session.id, { input: 'Fix the incorrect billing total and verify it with the existing test.' });
    let turn;
    while (performance.now() - start < 10000) {
      turn = direct.listTurns(session.id).find((t) => t.id === started.turn.id);
      if (['completed', 'failed', 'cancelled'].includes(turn?.state)) break;
      await delay(10);
    }
    unsubscribe();
    assert.ok(['completed', 'failed', 'cancelled'].includes(turn?.state), 'direct turn must settle');
    const ms = Math.round(performance.now() - start);
    const events = direct.listEvents(session.id, { after: 0, limit: 200 });
    const receipts = store.db.prepare('SELECT callId, toolName, status, exitCode, errorCode FROM tool_receipts WHERE turnId=? ORDER BY rowid').all(turn.id);
    const testUnchanged = readFileSync(join(root, 'total.test.mjs'), 'utf8') === testSource;
    const independentTest = spawnSync(process.execPath, ['--test', 'total.test.mjs'], { cwd: root, timeout: 5000 }).status;
    return {
      accepted: turn.state === 'completed' && turn.verdict?.accepted === true,
      correct: independentTest === 0 && testUnchanged && readFileSync(join(root, 'total.mjs'), 'utf8').includes('price + fee'),
      independentExit: independentTest, ms, inferenceSteps: adapter.steps, approvals: decisions,
      verdicts: events.filter((e) => e.type === 'verifier/verdict').map((e) => ({ verdict: e.data.verdict, reasons: e.data.reasons })),
      receipts,
    };
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dir);
  }
}

async function discoveryTask() {
  const { dir, root, data } = fixture();
  const store = new Store(join(data, 'engine.sqlite'));
  const manager = new McpLifecycleManager({ staticMcp: {
    paged: [process.execPath, server, 'paged'], peer: [process.execPath, server, 'peer'],
    peer2: [process.execPath, server, 'peer'],
  } });
  try {
    const start = performance.now();
    const mcpTools = await manager.discoverTools(root);
    const discoveryMs = Math.round(performance.now() - start);
    const tools = createWorkspaceTools({ workspaceRoot: root, dataRoot: data, store, nonce: '0123456789abcdef0123456789abcdef', mcpTools });
    const dispatcher = new ToolDispatcher({ reconciler: new UnknownOutcomeReconciler(store) });
    const approvals = [];
    const run = async (tc) => (await dispatcher.dispatchBatch({
      sessionId: 'bench-mcp', turnId: 'turn-mcp', toolCalls: [tc], tools, permissionMode: 'approval',
      requestApproval: ({ tool, argsDigest }) => { approvals.push(tool); return { allowed: true, argsDigest }; },
    }))[0];
    const log = await run(call('log', 'mcp__paged__read_log'));
    const first = await run(call('index', 'mcp__paged__read_index'));
    const fallback = first.isError && mcpTools.some((t) => t.fullName === 'mcp__paged__lookup_index')
      ? await run(call('fallback', 'mcp__paged__lookup_index')) : null;
    return {
      correct: log.isError === false && log.receipt?.status === 'finished' &&
        first.isError && first.receipt?.status === 'failed' && first.receipt?.errorCode === 'MCP_TOOL_ERROR' &&
        fallback?.isError === false && fallback?.receipt?.status === 'finished' && /Index schema: 3/.test(fallback.output),
      discoveryMs, names: mcpTools.map((t) => t.fullName), approvals,
      receipts: [log, first, fallback].filter(Boolean).map(({ tc, receipt, isError }) => ({
        callId: tc.id, status: receipt?.status, isError, errorCode: receipt?.errorCode,
      })),
    };
  } finally {
    manager.close();
    store.close();
    rmDirSafe(dir);
  }
}

async function schedulingTask() {
  const { dir, root } = fixture();
  try {
    const names = Array.from({ length: 12 }, (_, i) => `source-${i}.txt`);
    for (const name of names) writeFileSync(join(root, name), 'before');
    const calls = [...names, null, names[0]];
    let active = 0;
    let peak = 0;
    const start = performance.now();
    const results = await scheduleToolBatch(calls, (name) => name !== null, async (name) => {
      if (name === null) {
        assert.equal(active, 0);
        writeFileSync(join(root, names[0]), 'after');
        return 'write';
      }
      active++;
      peak = Math.max(peak, active);
      try {
        // Simulate independent async readers with a small service time plus real file I/O.
        await delay(8);
        return await readFile(join(root, name), 'utf8');
      } finally {
        active--;
      }
    });
    assert.deepEqual(results, [...names.map(() => 'before'), 'write', 'after']);
    return { correct: true, peak, calls: calls.length, ms: Math.round(performance.now() - start) };
  } finally {
    rmDirSafe(dir);
  }
}

const runs = [];
for (let i = 0; i < n; i++) {
  runs.push({ repair: await repairTask(), discovery: await discoveryTask(), scheduling: await schedulingTask() });
}
console.log(JSON.stringify({ source, node: process.version, platform: `${process.platform}/${process.arch}`, runs }, null, 2));
if (process.env.TI_REQUIRE_PASS === '1' && runs.some((run) =>
  !run.repair.accepted || !run.repair.correct || !run.discovery.correct || !run.scheduling.correct)) {
  process.exitCode = 1;
}
