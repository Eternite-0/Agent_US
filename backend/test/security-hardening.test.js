import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { UnknownOutcomeReconciler } from '../src/durable/reconciliation.js';
import { EventRouter } from '../src/kernel/events.js';
import { HookRunner } from '../src/agent-context.js';
import { HookTrustManager } from '../src/tools/hook-trust.js';
import { ToolDispatcher, computeArgsDigest } from '../src/tools/dispatcher.js';
import { ToolPermissionPolicy } from '../src/tools/policy.js';
import { GitWorktreeIsolator, ISOLATION_MODES } from '../src/tools/sandbox.js';
import { defineTool, EFFECT_CLASSES, RISK_LEVELS } from '../src/tools/registry.js';
import { AgentRuntimeKernel } from '../src/kernel/runtime.js';

test('P8.A1 ToolDispatcher enforces strict Fail-Closed approval gating, permit single-use, digest binding, and consistent receipts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-sec-disp-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const router = new EventRouter(store);
  const reconciler = new UnknownOutcomeReconciler(store, router);
  const dispatcher = new ToolDispatcher({
    store,
    eventRouter: router,
    reconciler,
    policy: new ToolPermissionPolicy({ permissionMode: 'approval' }),
  });

  let sideEffects = 0;
  const mutatingTool = defineTool({
    name: 'deploy_prod',
    description: 'dangerous irreversible tool',
    effectClass: EFFECT_CLASSES.IRREVERSIBLE_SIDE_EFFECT,
    riskLevel: RISK_LEVELS.HIGH,
    replayable: false,
    outward: false,
    zodSchema: z.object({ target: z.string().min(1) }),
    execute: async ({ target }) => {
      sideEffects++;
      return `deployed:${target}`;
    },
  });
  const shellFailTool = defineTool({
    name: 'bash',
    description: 'shell command',
    effectClass: EFFECT_CLASSES.IRREVERSIBLE_SIDE_EFFECT,
    riskLevel: RISK_LEVELS.HIGH,
    replayable: false,
    requiresCommandCheck: true,
    zodSchema: z.object({ command: z.string().min(1) }),
    execute: async () => 'exitCode: 2\nstderr: failed command',
  });
  const tools = [mutatingTool, shellFailTool];

  try {
    // 1. ASK without requestApproval callback -> Fail-Closed
    const noSvc = await dispatcher.dispatchBatch({
      sessionId: 's-sec',
      turnId: 't-1',
      toolCalls: [{ id: 'c1', name: 'deploy_prod', arguments: '{"target":"eu"}' }],
      tools,
      permissionMode: 'approval',
      requestApproval: null,
    });
    assert.equal(noSvc[0].isError, true);
    assert.equal(noSvc[0].receipt.errorCode, 'APPROVAL_SERVICE_UNAVAILABLE');
    assert.equal(sideEffects, 0);

    // 2. ASK + requestApproval throws -> Fail-Closed
    const threw = await dispatcher.dispatchBatch({
      sessionId: 's-sec',
      turnId: 't-1',
      toolCalls: [{ id: 'c2', name: 'deploy_prod', arguments: '{"target":"eu"}' }],
      tools,
      permissionMode: 'approval',
      requestApproval: async () => {
        throw new Error('approval channel disconnected');
      },
    });
    assert.equal(threw[0].isError, true);
    assert.equal(threw[0].receipt.errorCode, 'APPROVAL_ERROR');
    assert.equal(sideEffects, 0);

    // 3. ASK + timeout -> Fail-Closed
    const timedOut = await dispatcher.dispatchBatch({
      sessionId: 's-sec',
      turnId: 't-1',
      toolCalls: [{ id: 'c3', name: 'deploy_prod', arguments: '{"target":"eu"}' }],
      tools,
      permissionMode: 'approval',
      requestApproval: async () => ({ allowed: false, reason: 'timeout' }),
    });
    assert.equal(timedOut[0].isError, true);
    assert.equal(timedOut[0].receipt.errorCode, 'APPROVAL_TIMEOUT');
    assert.equal(sideEffects, 0);

    // 4. ASK + argsDigest mismatch -> Fail-Closed
    const mismatch = await dispatcher.dispatchBatch({
      sessionId: 's-sec',
      turnId: 't-1',
      toolCalls: [{ id: 'c4', name: 'deploy_prod', arguments: '{"target":"eu"}' }],
      tools,
      permissionMode: 'approval',
      requestApproval: async () => ({
        allowed: true,
        approvalId: 'apr-bad',
        argsDigest: computeArgsDigest('deploy_prod', { target: 'us' }),
      }),
    });
    assert.equal(mismatch[0].isError, true);
    assert.equal(mismatch[0].receipt.errorCode, 'APPROVAL_ARGS_MISMATCH');
    assert.equal(sideEffects, 0);

    // 5. CANCELLED before execution -> rejected cleanly without running
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() =>
      dispatcher.dispatchBatch({
        sessionId: 's-sec',
        turnId: 't-1',
        toolCalls: [{ id: 'c5', name: 'deploy_prod', arguments: '{"target":"eu"}' }],
        tools,
        permissionMode: 'approval',
        requestApproval: async () => true,
        signal: ac.signal,
      }),
    );
    assert.equal(sideEffects, 0);

    // 6. Valid approval + matching argsDigest executes once & persists approval binding
    const ok = await dispatcher.dispatchBatch({
      sessionId: 's-sec',
      turnId: 't-1',
      toolCalls: [{ id: 'c6', name: 'deploy_prod', arguments: '{"target":"eu"}' }],
      tools,
      permissionMode: 'approval',
      requestApproval: async ({ argsDigest }) => ({
        allowed: true,
        approvalId: 'apr-ok-6',
        argsDigest,
      }),
    });
    assert.equal(ok[0].isError, false);
    assert.equal(ok[0].output, 'deployed:eu');
    assert.equal(ok[0].receipt.approvalId, 'apr-ok-6');
    assert.equal(ok[0].receipt.approvedArgsDigest, computeArgsDigest('deploy_prod', { target: 'eu' }));
    assert.equal(sideEffects, 1);

    // 7. Consistent receipt on non-zero exitCode output even when execute() did not throw
    const badExit = await dispatcher.dispatchBatch({
      sessionId: 's-sec',
      turnId: 't-1',
      toolCalls: [{ id: 'c7', name: 'bash', arguments: '{"command":"echo hi"}' }],
      tools,
      permissionMode: 'full-access',
    });
    assert.equal(badExit[0].isError, true);
    assert.equal(badExit[0].receipt.status, 'failed');
    assert.equal(badExit[0].receipt.exitCode, 2);
    assert.equal(badExit[0].receipt.errorCode, 'NON_ZERO_EXIT');
  } finally {
    store.close();
    rmDirSafe(dir);
  }
});

test('P8.A2 Hooks separate security, transform (with post-transform validation), and observation semantics', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-sec-hook-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-sec-hook-work-'));
  mkdirSync(join(workDir, '.agent-us'), { recursive: true });
  const store = new Store(join(dataDir, 'db.sqlite'));
  const router = new EventRouter(store);
  const reconciler = new UnknownOutcomeReconciler(store, router);
  const dispatcher = new ToolDispatcher({
    store,
    eventRouter: router,
    reconciler,
    policy: new ToolPermissionPolicy({ permissionMode: 'full-access' }),
  });

  let executedCount = 0;
  const writeTool = defineTool({
    name: 'custom_write',
    description: 'custom validated writer',
    effectClass: EFFECT_CLASSES.REVERSIBLE_WRITE,
    riskLevel: RISK_LEVELS.MEDIUM,
    replayable: true,
    zodSchema: z.object({ count: z.number().int().positive() }),
    execute: async ({ count }) => {
      executedCount += count;
      return `wrote:${count}`;
    },
  });

  try {
    const trustManager = new HookTrustManager({ store, eventRouter: router });
    const hooksFile = join(workDir, '.agent-us', 'hooks.json');

    // 1. Security PreToolUse failing with exit code 1 MUST block (Fail-Closed!)
    writeFileSync(
      hooksFile,
      JSON.stringify({
        PreToolUse: [
          { matcher: 'custom_write', kind: 'security', command: 'node -e "process.exit(1)"' },
        ],
      }),
      'utf8',
    );
    trustManager.approveFile(hooksFile, { workspaceRoot: workDir, approvedBy: 'test' });
    const secBlocked = await dispatcher.dispatchBatch({
      sessionId: 's-hk',
      turnId: 't-hk',
      toolCalls: [{ id: 'hk-1', name: 'custom_write', arguments: '{"count":2}' }],
      tools: [writeTool],
      hooks: new HookRunner(workDir, { store, trustManager }),
    });
    assert.equal(secBlocked[0].isError, true);
    assert.equal(secBlocked[0].receipt.errorCode, 'SECURITY_HOOK_BLOCKED');
    assert.equal(executedCount, 0);

    // 2. Transform hook modifying args to invalid schema triggers post-transform Zod rejection
    writeFileSync(
      hooksFile,
      JSON.stringify({
        PreToolUse: [
          {
            matcher: 'custom_write',
            kind: 'transform',
            command: `node -e "console.log(JSON.stringify({ updatedInput: { count: -9 } }))"`,
          },
        ],
      }),
      'utf8',
    );
    trustManager.approveFile(hooksFile, { workspaceRoot: workDir, approvedBy: 'test' });
    const invalidXform = await dispatcher.dispatchBatch({
      sessionId: 's-hk',
      turnId: 't-hk',
      toolCalls: [{ id: 'hk-2', name: 'custom_write', arguments: '{"count":2}' }],
      tools: [writeTool],
      hooks: new HookRunner(workDir, { store, trustManager }),
    });
    assert.equal(invalidXform[0].isError, true);
    assert.equal(invalidXform[0].receipt.errorCode, 'HOOK_TRANSFORM_INVALID_ARGS');
    assert.equal(executedCount, 0);

    // 3. Observation hook failing NEVER blocks and NEVER alters args
    writeFileSync(
      hooksFile,
      JSON.stringify({
        PreToolUse: [
          { matcher: 'custom_write', kind: 'observation', command: 'node -e "process.exit(1)"' },
        ],
      }),
      'utf8',
    );
    trustManager.approveFile(hooksFile, { workspaceRoot: workDir, approvedBy: 'test' });
    const obsPass = await dispatcher.dispatchBatch({
      sessionId: 's-hk',
      turnId: 't-hk',
      toolCalls: [{ id: 'hk-3', name: 'custom_write', arguments: '{"count":3}' }],
      tools: [writeTool],
      hooks: new HookRunner(workDir, { store, trustManager }),
    });
    assert.equal(obsPass[0].isError, false);
    assert.equal(executedCount, 3);
  } finally {
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('P8.A3 Kernel removes insecure dispatcher; Worktree isolation fails closed and cleans orphans', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-sec-wt-data-'));
  const nonGitDir = mkdtempSync(join(tmpdir(), 'agent-us-sec-nongit-'));
  const gitDir = mkdtempSync(join(tmpdir(), 'agent-us-sec-git-'));

  execFileSync('git', ['init'], { cwd: gitDir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitDir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: gitDir, windowsHide: true });
  writeFileSync(join(gitDir, 'README.md'), 'init\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: gitDir, windowsHide: true });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: gitDir, windowsHide: true });

  const store = new Store(join(dataDir, 'db.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-sec');

  // Verify Kernel uses fail-closed dispatcher directly
  const kernel = new AgentRuntimeKernel({ store, adapter: { async *stream() {} } });
  assert.ok(kernel.toolDispatcher instanceof ToolDispatcher);
  kernel.close();

  let writeAttempted = false;
  const mockAdapter = {
    async *stream(options) {
      const hasTool = options.messages.some((m) => m.role === 'tool');
      if (!hasTool && options.tools?.some((t) => t.name === 'write_file')) {
        writeAttempted = true;
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-wt-w',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'leak.txt', content: 'should not reach parent' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'fallback-readonly-complete' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: nonGitDir,
    dataRoot: dataDir,
    adapter: mockAdapter,
  });

  try {
    const parent = direct.createSession({ workspaceRoot: nonGitDir, permissionMode: 'full-access' });

    // 1. Requested worktree isolation in non-git dir MUST fail closed (no silent shared write fallback!)
    await assert.rejects(
      () =>
        direct.childManager.spawn({
          parentSessionId: parent.id,
          objective: '必须隔离写入',
          isolationMode: ISOLATION_MODES.WORKTREE,
          permissionMode: 'auto-safe',
          parentPermissionMode: 'full-access',
          workspaceRoot: nonGitDir,
        }),
      (err) => err.code === 'WORKTREE_ISOLATION_FAILED',
    );
    assert.equal(existsSync(join(nonGitDir, 'leak.txt')), false);
    assert.equal(writeAttempted, false);

    // 2. Explicit fallback clamps child permission strictly to read-only
    const downgraded = await direct.childManager.spawn({
      parentSessionId: parent.id,
      objective: '允许降级但仅只读',
      isolationMode: ISOLATION_MODES.WORKTREE,
      allowIsolationFallback: true,
      permissionMode: 'full-access',
      parentPermissionMode: 'full-access',
      workspaceRoot: nonGitDir,
    });
    assert.equal(downgraded.text, 'fallback-readonly-complete');
    assert.equal(direct.getSession(downgraded.childSessionId).permissionMode, 'read-only');
    assert.equal(existsSync(join(nonGitDir, 'leak.txt')), false);

    // 3. GitWorktreeIsolator real git repo + crash orphan cleanup
    const wt = await direct.worktreeIsolator.acquire(gitDir, {
      ownerId: 'alive-worker',
      sessionId: parent.id,
    });
    writeFileSync(join(wt.path, 'isolated.txt'), 'safe\n', 'utf8');
    assert.equal(existsSync(join(gitDir, 'isolated.txt')), false);
    await wt.release();
    assert.equal(existsSync(wt.path), false);

    // Simulate leaked active worktree left on disk from dead PID
    const leakedPath = join(tmpdir(), `orphan-wt-${Date.now()}`);
    execFileSync('git', ['worktree', 'add', '--detach', leakedPath, 'HEAD'], {
      cwd: gitDir,
      windowsHide: true,
    });
    assert.equal(existsSync(leakedPath), true);
    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO worktree_leases(
            id, ownerId, workspaceRoot, worktreePath, status, createdAt
          ) VALUES('orphan-1','dead-pid-99999',?,?,'active',?)`,
        )
        .run(gitDir, leakedPath, Date.now() - 10000);
    });
    const cleaned = await direct.worktreeIsolator.cleanupOrphans();
    assert.equal(cleaned.cleaned, 1);
    assert.equal(existsSync(leakedPath), false);
    const leaseRow = store.db.prepare("SELECT status FROM worktree_leases WHERE id='orphan-1'").get();
    assert.equal(leaseRow.status, 'orphan_cleaned');
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(nonGitDir);
    rmDirSafe(gitDir);
  }
});
