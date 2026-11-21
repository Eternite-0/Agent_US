import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { ISOLATION_MODES } from '../src/tools/sandbox.js';
import { rmDirSafe, withTimeout } from './fixtures.js';

class ChildApprovalAdapter extends LlmAdapter {
  constructor() {
    super();
    this.calls = [];
  }

  async *stream(options) {
    this.calls.push(structuredClone(options.messages));
    if (options.messages.some((message) => message.role === 'tool')) {
      yield { type: 'text-delta', index: 0, text: 'child turn finished' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: 'child-approval-call',
        name: 'bash',
        arguments: JSON.stringify({ command: 'echo child-approved > child-approval.txt' }),
      },
    };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}

async function waitForPendingApproval(direct, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = direct.listApprovals({ status: 'pending' });
    if (pending.length) return pending[0];
    await delay(20);
  }
  throw new Error('Timed out waiting for child approval');
}

async function createRuntime() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-child-approval-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  pool.setDefaultModel('child-approval-model');
  const adapter = new ChildApprovalAdapter();
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dir,
    dataRoot: dir,
    adapter,
  });
  return { dir, store, direct, adapter };
}

async function runChild(env, objective) {
  const parent = env.direct.createSession({
    workspaceRoot: env.dir,
    permissionMode: 'approval',
  });
  const childPromise = env.direct.childManager.spawn({
    parentSessionId: parent.id,
    objective,
    workspaceRoot: env.dir,
    permissionMode: 'approval',
    parentPermissionMode: 'approval',
    isolationMode: ISOLATION_MODES.SHARED_WORKSPACE,
  });
  const pending = await waitForPendingApproval(env.direct);
  const child = env.direct.getSession(pending.sessionId);
  assert.ok(child);
  assert.equal(pending.tool, 'bash');
  assert.equal(pending.sessionId, child.id);
  assert.match(pending.turnId, /^root:/);
  return { parent, childPromise, pending, child };
}

test('ChildAgentManager uses DirectApprovalManager for child tools and consumes approval once', async () => {
  const env = await createRuntime();
  try {
    const { childPromise, pending, child } = await runChild(env, 'request child approval');
    const decision = env.direct.decideApproval(pending.id, { decision: 'allow', scope: 'once' });
    assert.equal(decision.status, 'allowed');
    const result = await withTimeout(childPromise, 5000, 'child approval completion');
    assert.equal(result.status, 'completed');
    const written = readFileSync(join(env.dir, 'child-approval.txt'));
    const writtenText = written.includes(0) ? written.toString('utf16le').replace(/^﻿/, '') : written.toString('utf8');
    assert.equal(writtenText.trim(), 'child-approved');
    const row = env.store.db.prepare('SELECT status, consumedAt FROM direct_approvals WHERE id=?').get(pending.id);
    assert.equal(row.status, 'consumed');
    assert.ok(row.consumedAt > 0);
    const receipt = env.store.db
      .prepare("SELECT status, errorCode FROM tool_receipts WHERE sessionId=? AND turnId=? AND callId=?")
      .get(child.id, pending.turnId, pending.callId);
    assert.equal(receipt.status, 'finished');
    assert.equal(receipt.errorCode, null);
  } finally {
    await env.direct.close();
    env.store.close();
    rmDirSafe(env.dir);
  }
});

test('ChildAgentManager re-reads tightened child policy after approval and blocks the side effect', async () => {
  const env = await createRuntime();
  try {
    const { childPromise, pending, child } = await runChild(env, 'tighten child policy');
    env.direct.updateSession(child.id, { permissionMode: 'read-only' });
    env.direct.decideApproval(pending.id, { decision: 'allow', scope: 'once' });
    const result = await withTimeout(childPromise, 5000, 'tightened child policy completion');
    assert.equal(result.status, 'completed');
    assert.equal(existsSync(join(env.dir, 'child-approval.txt')), false);
    const receipt = env.store.db
      .prepare("SELECT status, errorCode FROM tool_receipts WHERE sessionId=? AND turnId=? AND callId=?")
      .get(child.id, pending.turnId, pending.callId);
    assert.equal(receipt.status, 'rejected_before_effect');
    assert.equal(receipt.errorCode, 'POLICY_TIGHTENED_DENIED');
    const row = env.store.db.prepare('SELECT status FROM direct_approvals WHERE id=?').get(pending.id);
    assert.equal(row.status, 'allowed');
  } finally {
    await env.direct.close();
    env.store.close();
    rmDirSafe(env.dir);
  }
});

