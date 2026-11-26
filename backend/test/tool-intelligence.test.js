import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { scheduleToolBatch } from '../src/patch-and-diagnostics.js';
import { ToolDispatcher, isParallelReadTool } from '../src/tools/dispatcher.js';
import { TurnManager } from '../src/kernel/agent-loop.js';
import { McpLifecycleManager } from '../src/tools/mcp-lifecycle.js';
import { createWorkspaceTools } from '../src/workspace-tools.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { UnknownOutcomeReconciler } from '../src/durable/reconciliation.js';
import { EvidenceVerifier } from '../src/governance/verifier.js';
import { rmDirSafe } from './fixtures.js';

const tc = (id, name, args = {}) => ({ id, name, arguments: JSON.stringify(args) });
const read = { effectClass: 'read_only', readOnly: true, replayable: true, outward: false };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-us-ti-regression-'));
  const store = new Store(join(root, 'engine.sqlite'));
  t.after(() => { store.close(); rmDirSafe(root); });
  const reconciler = new UnknownOutcomeReconciler(store);
  const dispatcher = new ToolDispatcher({ reconciler });
  return { root, store, reconciler, dispatcher };
}

test('read lanes are bounded, failures drain started work, no write crosses a failed barrier', async () => {
  const calls = Array.from({ length: 12 }, (_, index) => index);
  let active = 0;
  let peak = 0;
  const results = await scheduleToolBatch(calls, (i) => i !== 8, async (i) => {
    if (i === 8) assert.equal(active, 0);
    active++;
    peak = Math.max(peak, active);
    await delay(i % 2 ? 1 : 10);
    active--;
    return i;
  });
  assert.deepEqual(results, calls);
  assert.equal(peak, 4);

  const started = [];
  const finished = [];
  const stop = new Error('lease lost');
  await assert.rejects(scheduleToolBatch(calls, (i) => i !== 8, async (i) => {
    started.push(i);
    if (i === 0) throw stop;
    await delay(10);
    finished.push(i);
  }), (err) => err === stop);
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.deepEqual(finished, [1, 2, 3]);
  assert.equal(isParallelReadTool({ meta: read }), true);
  assert.equal(isParallelReadTool({ meta: read, isConcurrencySafe: () => false }), false);
  assert.equal(isParallelReadTool({ meta: { ...read, outward: true }, isConcurrencySafe: () => true }), false);
  assert.equal(isParallelReadTool({ meta: { ...read, replayable: false } }), false);
});

test('byte-identical consecutive calls trigger 6x duplicate reminder without tripping on successful polls', () => {
  const tm = new TurnManager({});
  for (let i = 0; i < 10; i++) assert.equal(tm.recordToolSignature(tc(String(i), 'read_process_output'), false, { processId: 'same' }, true), false);
  for (let i = 0; i < 6; i++) assert.equal(tm.recordToolSignature(tc(String(i), 'glob'), false, { pattern: '*' }), i === 5);
  // Different argument bytes reset the streak; 6 consecutive byte-identical failed calls trigger on the 6th
  assert.equal(tm.recordToolSignature(tc('diff-0', 'read_process_output', { y: 2, x: 1 }), true, { y: 2, x: 1 }, true), false);
  for (let i = 0; i < 5; i++) {
    assert.equal(tm.recordToolSignature(tc(`fail-${i}`, 'read_process_output', { x: 1, y: 2 }), true, { x: 1, y: 2 }, true), false);
  }
  assert.equal(tm.recordToolSignature(tc('fail-5', 'read_process_output', { x: 1, y: 2 }), true, { x: 1, y: 2 }, true), true);
});

test('MCP pages degrade independently; protocol failure and unknown outcome survive receipts without retry', async (t) => {
  const { root, store, dispatcher } = fixture(t);
  const script = fileURLToPath(new URL('../scripts/fixtures/tool-intelligence-mcp-server.mjs', import.meta.url));
  const server = (mode) => [process.execPath, script, mode];
  const manager = new McpLifecycleManager({ staticMcp: { loop: server('loop'), paged: server('paged'), drop: server('drop') } });
  t.after(() => manager.close());
  const discovered = await manager.discoverTools(root);
  assert.deepEqual(discovered.map((x) => x.fullName), [
    'mcp__paged__read_index', 'mcp__paged__read_log', 'mcp__paged__lookup_index', 'mcp__drop__submit',
  ]);
  assert.equal(manager.getStatus(root).find((s) => s.server === 'loop').status, 'degraded');
  const tools = createWorkspaceTools({ workspaceRoot: root, store, mcpTools: discovered });
  const run = async (calls, requestApproval) => dispatcher.dispatchBatch({
    sessionId: 'mcp', turnId: 'turn', tools, toolCalls: calls, permissionMode: 'approval', requestApproval,
  });
  const allowed = ({ argsDigest }) => ({ allowed: true, argsDigest });
  const [denied] = await run([tc('denied', 'mcp__drop__submit')], () => ({ allowed: false }));
  assert.equal(denied.receipt.status, 'rejected_before_effect');
  assert.equal(denied.receipt.errorCode, 'APPROVAL_DENIED');
  assert.equal(denied.receipt.permitEffectId, null);

  const [log, failure, fallback, unknown] = await run([
    tc('log', 'mcp__paged__read_log'), tc('index', 'mcp__paged__read_index'),
    tc('fallback', 'mcp__paged__lookup_index'), tc('unknown', 'mcp__drop__submit'),
  ], allowed);
  assert.match(log.output, /exitCode: 9/);
  assert.equal(log.receipt.status, 'finished');
  assert.equal(log.receipt.exitCode, 0);
  assert.equal(failure.receipt.status, 'failed');
  assert.equal(failure.receipt.errorCode, 'MCP_TOOL_ERROR');
  assert.match(failure.output, /\[MCP_TOOL_ERROR\]/);
  assert.equal(fallback.receipt.status, 'finished');
  assert.match(fallback.output, /Index schema: 3/);
  assert.equal(unknown.receipt.status, 'outcome_unknown');
  assert.equal(unknown.receipt.exitCode, null);
  assert.equal(unknown.receipt.errorCode, 'MCP_OUTCOME_UNKNOWN');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM tool_receipts WHERE callId='unknown'").get().n, 1);
  assert.equal(new EvidenceVerifier({ store }).verify({ sessionId: 'mcp', turnId: 'turn' }).verdict, 'block_reconciliation');
});

test('EvidenceVerifier records failed shell receipts observationally without post-hoc heuristic closing veto', async (t) => {
  const { root, store, dispatcher } = fixture(t);
  const tools = createWorkspaceTools({ workspaceRoot: root, store, sandbox: {
    async run(command, cwd) {
      const exitCode = command === 'node --test total.test.mjs' && cwd === root && !fixed ? 1 : 0;
      return { exitCode, stdout: `exitCode: ${exitCode === 0 ? 99 : 0}` };
    },
  } });
  let fixed = false;
  const events = [];
  const run = async (...toolCalls) => {
    const items = await dispatcher.dispatchBatch({
      sessionId: 'test', turnId: 'turn', tools, toolCalls, permissionMode: 'full-access',
    });
    for (const item of items) events.push({ type: 'tool/result', data: { receipt: item.receipt, effectiveArgs: item.parsedArgs } });
  };
  const verifier = new EvidenceVerifier({ store });
  const verdict = () => verifier.verify({ sessionId: 'test', turnId: 'turn', workspaceRoot: root, events, text: 'Tests passed.' });
  await run(tc('test', 'bash', { command: 'node --test total.test.mjs' }), tc('status', 'bash', { command: 'git status --short' }));
  const v1 = verdict();
  assert.equal(v1.checks.failedShellReceipts, 1);
  assert.equal(v1.checks.pendingReconciliations, 0);
  assert.equal(v1.accepted, true);
  fixed = true;
  await run(tc('retry', 'bash', { command: 'node --test total.test.mjs', cwd: './', timeoutMs: 35000 }));
  const v2 = verdict();
  assert.equal(v2.checks.failedShellReceipts, 1);
  assert.equal(v2.accepted, true);
});

test('timed-out bash command reports COMMAND_TIMEOUT failure (exitCode 124) without outcomeUnknown or reconciling lock', async (t) => {
  const { root, store, reconciler, dispatcher } = fixture(t);

  // 1. Direct host bash.execute timeout: killProcessTree settles deterministically with COMMAND_TIMEOUT and outcomeUnknown !== true
  const hostTools = createWorkspaceTools({ workspaceRoot: root, store, permissionMode: 'full-access' });
  const bashTool = hostTools.find((x) => x.name === 'bash');
  assert.ok(bashTool);
  const reportedOutcomes = [];
  const rawOut = await bashTool.execute(
    { command: 'node -e "setTimeout(() => {}, 10000)"', timeoutMs: 500 },
    { callId: 'bash-host-to', reportOutcome: (facts) => reportedOutcomes.push(facts) },
  );
  assert.equal(reportedOutcomes.length, 1);
  assert.equal(reportedOutcomes[0].exitCode, 124);
  assert.equal(reportedOutcomes[0].errorCode, 'COMMAND_TIMEOUT');
  assert.notEqual(reportedOutcomes[0].outcomeUnknown, true);
  assert.equal('outcomeUnknown' in reportedOutcomes[0], false);
  assert.match(rawOut, /exitCode: 124/);
  assert.match(rawOut, /\[timeout after 500ms\]/);

  // 2. ToolDispatcher + UnknownOutcomeReconciler + EvidenceVerifier: timed-out bash records failed (never outcome_unknown / block_reconciliation)
  const stubTools = createWorkspaceTools({
    workspaceRoot: root,
    store,
    permissionMode: 'full-access',
    sandbox: {
      async run() {
        return { exitCode: 124, stdout: '', stderr: '[timeout after 500ms]', timedOut: true };
      },
    },
  });
  const [dispatched] = await dispatcher.dispatchBatch({
    sessionId: 'sess-bash-to',
    turnId: 'turn-bash-to',
    tools: stubTools,
    permissionMode: 'full-access',
    toolCalls: [tc('tc-bash-to', 'bash', { command: 'sleep 30', timeoutMs: 500 })],
  });
  assert.equal(dispatched.isError, true);
  assert.match(dispatched.output, /\[COMMAND_TIMEOUT\]/);
  assert.doesNotMatch(dispatched.output, /执行结果未知/);
  assert.equal(dispatched.receipt.status, 'failed');
  assert.equal(dispatched.receipt.exitCode, 124);
  assert.equal(dispatched.receipt.errorCode, 'COMMAND_TIMEOUT');
  assert.equal(reconciler.listReconciliations({ sessionId: 'sess-bash-to', status: 'pending' }).length, 0);

  const verdict = new EvidenceVerifier({ store }).verify({
    sessionId: 'sess-bash-to',
    turnId: 'turn-bash-to',
    workspaceRoot: root,
    text: 'Timed-out command handled.',
    events: [{ type: 'tool/result', data: { receipt: dispatched.receipt, effectiveArgs: dispatched.parsedArgs } }],
  });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.checks.pendingReconciliations, 0);
  assert.equal(verdict.checks.failedShellReceipts, 1);

  // 3. End-to-end DirectAgentRuntime turn: real host bash timeout completes turn without entering reconciling lock
  const rtDir = mkdtempSync(join(tmpdir(), 'agent-us-bash-to-rt-'));
  const rtStore = new Store(join(rtDir, 'engine.sqlite'));
  const pool = new AccountPool(rtStore, { root: rtDir });
  pool.setDefaultModel('mock-coder');
  let step = 0;
  class TimeoutOnceAdapter extends LlmAdapter {
    async *stream() {
      if (step === 0) {
        step = 1;
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'rt-bash-to',
            name: 'bash',
            arguments: JSON.stringify({ command: 'node -e "setTimeout(() => {}, 10000)"', timeoutMs: 500 }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'Handled timed-out command cleanly.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const direct = new DirectAgentRuntime(rtStore, pool, {
    defaultWorkspace: root,
    dataRoot: rtDir,
    adapter: new TimeoutOnceAdapter(),
  });
  t.after(async () => {
    await direct.close();
    rtStore.close();
    rmDirSafe(rtDir);
  });

  const sess = direct.createSession({ workspaceRoot: root, permissionMode: 'full-access' });
  const started = direct.startTurn(sess.id, { input: 'run slow command with 500ms timeout' });
  const deadline = Date.now() + 15_000;
  let finalTurn = null;
  while (Date.now() < deadline) {
    const cur = direct.listTurns(sess.id).find((x) => x.id === started.turn.id);
    if (cur && ['completed', 'failed', 'cancelled', 'reconciling'].includes(cur.state)) {
      finalTurn = cur;
      break;
    }
    await delay(25);
  }
  assert.ok(finalTurn, 'turn must settle');
  assert.equal(finalTurn.state, 'completed', `expected completed, got ${finalTurn.state}`);
  assert.notEqual(direct.getSession(sess.id).state, 'reconciling');
  assert.equal(direct.reconciler.listReconciliations({ sessionId: sess.id, status: 'pending' }).length, 0);
  const dbReceipt = rtStore.db
    .prepare('SELECT status, exitCode, errorCode FROM tool_receipts WHERE sessionId=? AND callId=?')
    .get(sess.id, 'rt-bash-to');
  assert.equal(dbReceipt?.status, 'failed');
  assert.equal(dbReceipt?.exitCode, 124);
  assert.equal(dbReceipt?.errorCode, 'COMMAND_TIMEOUT');
});
