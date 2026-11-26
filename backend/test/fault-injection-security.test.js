import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { rmDirSafe, withTimeout } from './fixtures.js';
import { Store } from '../src/store.js';
import { EventRouter } from '../src/kernel/events.js';
import { UnknownOutcomeReconciler } from '../src/durable/reconciliation.js';
import { DirectApprovalManager } from '../src/runtime/approval-manager.js';
import { ToolDispatcher, computeArgsDigest } from '../src/tools/dispatcher.js';
import {
  ToolPermissionPolicy,
  analyzeCommand,
  intersectPolicies,
  isPrivateIpAddress,
  validateExternalUrl,
} from '../src/tools/policy.js';
import { defineTool, EFFECT_CLASSES, RISK_LEVELS } from '../src/tools/registry.js';
import { ExecutePermitRegistry } from '../src/permits.js';
import { HookTrustManager, computeHookContentDigest } from '../src/tools/hook-trust.js';
import { HookRunner } from '../src/agent-context.js';
import { McpLifecycleManager } from '../src/tools/mcp-lifecycle.js';
import { GitWorktreeIsolator, resolveConfinedPath } from '../src/tools/sandbox.js';
import { createWorkspaceTools } from '../src/workspace-tools.js';
import { canonicalizeCommandPrefix } from '../src/patch-and-diagnostics.js';
import { getTraceContext } from '../src/observability/trace.js';

function tryCreateSymlink(target, linkPath, type = undefined) {
  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

test('Scenario #8: Pre-execution approval revocation, policy tightening, nested arg mutation, null digest, approval replay, and guardFallback bypass resistance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-us-fi-s8-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fi-s8-work-'));
  const store = new Store(join(dir, 'engine.sqlite'));
  const eventRouter = new EventRouter(store);
  const reconciler = new UnknownOutcomeReconciler(store, eventRouter);
  const approvalManager = new DirectApprovalManager({ store, eventRouter, reconciler });
  const permits = new ExecutePermitRegistry();
  const policy = new ToolPermissionPolicy({ permissionMode: 'approval' });

  let livePolicyState = {
    permissionMode: 'approval',
    allowTools: null,
    denyTools: [],
  };

  const dispatcher = new ToolDispatcher({
    store,
    eventRouter,
    reconciler,
    policy,
    permits,
    approvalManager,
    getLivePolicy: () => ({ ...livePolicyState }),
  });

  let sideEffects = 0;
  let capturedTraceToolCallId = null;
  let capturedFrozenState = null;

  const deployTool = defineTool({
    name: 'deploy_service',
    description: 'mutating deploy with nested config',
    effectClass: EFFECT_CLASSES.IRREVERSIBLE_SIDE_EFFECT,
    riskLevel: RISK_LEVELS.HIGH,
    replayable: false,
    outward: false,
    zodSchema: z.object({
      config: z.object({
        target: z.string().min(1),
        region: z.string().default('us-east'),
      }),
    }),
    execute: async (args) => {
      sideEffects++;
      capturedTraceToolCallId = getTraceContext().toolCallId ?? null;
      capturedFrozenState = {
        rootFrozen: Object.isFrozen(args),
        nestedFrozen: Object.isFrozen(args.config),
      };
      return `deployed:${args.config.target}`;
    },
  });

  try {
    // 8a. User approves, then revokes in DB before execution starts -> MUST reject with APPROVAL_REVOKED & 0 side effects!
    let revokeGateResolve;
    const revokeGate = new Promise((r) => {
      revokeGateResolve = r;
    });
    let createdApprovalId1 = null;

    // Also attach a poisoned SSE listener to confirm decideApproval & revokeApproval isolate SSE failures
    const unsubPoison = eventRouter.subscribe('sess-s8', () => {
      throw new Error('EPIPE simulated broken SSE socket');
    });

    const pRevoke = dispatcher.dispatchBatch({
      sessionId: 'sess-s8',
      turnId: 'turn-s8-a',
      toolCalls: [
        {
          id: 'tc-s8-revoke',
          name: 'deploy_service',
          arguments: JSON.stringify({ config: { target: 'staging' } }),
        },
      ],
      tools: [deployTool],
      requestApproval: async (req) => {
        const decisionPromise = approvalManager.requestApproval({
          sessionId: 'sess-s8',
          turnId: 'turn-s8-a',
          callId: req.callId,
          tool: req.tool,
          args: req.arguments,
          riskLevel: req.riskLevel,
          effectClass: req.effectClass,
          argsDigest: req.argsDigest,
        });
        const pending = approvalManager.listApprovals({ sessionId: 'sess-s8', status: 'pending' });
        createdApprovalId1 = pending[0].id;
        // User clicks Allow (DB commits 'allowed', waiter resolves)
        const decided = approvalManager.decideApproval(createdApprovalId1, {
          decision: 'allow',
          scope: 'once',
        });
        assert.equal(decided.status, 'allowed');
        // Second decideApproval on non-pending approval MUST fail with APPROVAL_INACTIVE
        assert.throws(
          () => approvalManager.decideApproval(createdApprovalId1, { decision: 'deny' }),
          (err) => err.code === 'APPROVAL_INACTIVE',
        );
        const res = await decisionPromise;
        // Pause between approval resolution and execution start while user revokes approval!
        await withTimeout(revokeGate, 5000, 'revokeGate');
        return res;
      },
    });

    // Wait until approval is created & decided 'allowed', then revoke BEFORE dispatch resumes
    while (!createdApprovalId1) await delay(10);
    const revOut = approvalManager.revokeApproval(createdApprovalId1, {
      reason: 'operator_revoked_before_start',
    });
    assert.equal(revOut.ok, true);
    assert.equal(revOut.changed, true);
    assert.equal(revOut.approval.status, 'revoked');
    assert.equal(revOut.approval.revokedReason, 'operator_revoked_before_start');
    revokeGateResolve();

    const [revRes] = await pRevoke;
    assert.equal(revRes.isError, true);
    assert.equal(revRes.receipt.status, 'rejected_before_effect');
    assert.equal(revRes.receipt.errorCode, 'APPROVAL_REVOKED');
    assert.equal(sideEffects, 0);

    const dbRevoked = store.db
      .prepare('SELECT status, consumedAt, revokedAt, revokedReason FROM direct_approvals WHERE id=?')
      .get(createdApprovalId1);
    assert.equal(dbRevoked.status, 'revoked');
    assert.equal(dbRevoked.consumedAt, null);
    assert.ok(dbRevoked.revokedAt > 0);
    assert.equal(dbRevoked.revokedReason, 'operator_revoked_before_start');
    unsubPoison();

    // 8b. Session policy tightens to 'read-only' during approval wait -> MUST reject with POLICY_TIGHTENED_DENIED
    const [tightRes] = await dispatcher.dispatchBatch({
      sessionId: 'sess-s8',
      turnId: 'turn-s8-b',
      toolCalls: [
        {
          id: 'tc-s8-tighten',
          name: 'deploy_service',
          arguments: JSON.stringify({ config: { target: 'staging' } }),
        },
      ],
      tools: [deployTool],
      requestApproval: async (req) => {
        const dp = approvalManager.requestApproval({
          sessionId: 'sess-s8',
          turnId: 'turn-s8-b',
          callId: req.callId,
          tool: req.tool,
          args: req.arguments,
          argsDigest: req.argsDigest,
        });
        const pending = approvalManager.listApprovals({ sessionId: 'sess-s8', status: 'pending' });
        approvalManager.decideApproval(pending[0].id, { decision: 'allow' });
        // Policy tightens to read-only BEFORE tool starts!
        livePolicyState.permissionMode = 'read-only';
        return await dp;
      },
    });
    assert.equal(tightRes.isError, true);
    assert.equal(tightRes.receipt.status, 'rejected_before_effect');
    assert.equal(tightRes.receipt.errorCode, 'POLICY_TIGHTENED_DENIED');
    assert.equal(sideEffects, 0);

    // Restore approval mode & test denyTools tightening
    livePolicyState.permissionMode = 'approval';
    const [denyTightRes] = await dispatcher.dispatchBatch({
      sessionId: 'sess-s8',
      turnId: 'turn-s8-b2',
      toolCalls: [
        {
          id: 'tc-s8-deny-tighten',
          name: 'deploy_service',
          arguments: JSON.stringify({ config: { target: 'staging' } }),
        },
      ],
      tools: [deployTool],
      requestApproval: async (req) => {
        const dp = approvalManager.requestApproval({
          sessionId: 'sess-s8',
          turnId: 'turn-s8-b2',
          callId: req.callId,
          tool: req.tool,
          args: req.arguments,
          argsDigest: req.argsDigest,
        });
        const pending = approvalManager.listApprovals({ sessionId: 'sess-s8', status: 'pending' });
        approvalManager.decideApproval(pending[0].id, { decision: 'allow' });
        livePolicyState.denyTools = ['deploy_service'];
        return await dp;
      },
    });
    assert.equal(denyTightRes.isError, true);
    assert.equal(denyTightRes.receipt.status, 'rejected_before_effect');
    assert.equal(denyTightRes.receipt.errorCode, 'POLICY_TIGHTENED_DENIED');
    assert.equal(sideEffects, 0);
    livePolicyState.denyTools = [];

    // 8c. Nested arg object mutation during approval wait -> MUST reject with APPROVAL_ARGS_MISMATCH
    const [mutRes] = await dispatcher.dispatchBatch({
      sessionId: 'sess-s8',
      turnId: 'turn-s8-c',
      toolCalls: [
        {
          id: 'tc-s8-mutate',
          name: 'deploy_service',
          arguments: JSON.stringify({ config: { target: 'staging' } }),
        },
      ],
      tools: [deployTool],
      requestApproval: async (req) => {
        // Mutate nested object shared with effectiveArgs after digest was computed!
        req.arguments.config.target = 'prod-hijacked';
        return { allowed: true, approvalId: 'apr-mut', argsDigest: req.argsDigest };
      },
    });
    assert.equal(mutRes.isError, true);
    assert.equal(mutRes.receipt.status, 'rejected_before_effect');
    assert.equal(mutRes.receipt.errorCode, 'APPROVAL_ARGS_MISMATCH');
    assert.equal(sideEffects, 0);

    // 8d. Null / missing argsDigest in approval response -> MUST reject (no null bypass!)
    const [nullDigRes] = await dispatcher.dispatchBatch({
      sessionId: 'sess-s8',
      turnId: 'turn-s8-d',
      toolCalls: [
        {
          id: 'tc-s8-null-digest',
          name: 'deploy_service',
          arguments: JSON.stringify({ config: { target: 'staging' } }),
        },
      ],
      tools: [deployTool],
      requestApproval: async () => ({
        allowed: true,
        approvalId: 'apr-null-dig',
        argsDigest: null,
      }),
    });
    assert.equal(nullDigRes.isError, true);
    assert.equal(nullDigRes.receipt.status, 'rejected_before_effect');
    assert.equal(nullDigRes.receipt.errorCode, 'APPROVAL_ARGS_MISMATCH');
    assert.equal(sideEffects, 0);

    // 8e. Legitimate single-use approval executes ONCE, deep-freezes args, sets trace toolCallId,
    // commits status='consumed', and blocks replay of same approvalId!
    let validApprovalId = null;
    let validDigest = null;
    const [okRes] = await dispatcher.dispatchBatch({
      sessionId: 'sess-s8',
      turnId: 'turn-s8-e',
      toolCalls: [
        {
          id: 'tc-s8-ok',
          name: 'deploy_service',
          arguments: JSON.stringify({ config: { target: 'canary' } }),
        },
      ],
      tools: [deployTool],
      requestApproval: async (req) => {
        const dp = approvalManager.requestApproval({
          sessionId: 'sess-s8',
          turnId: 'turn-s8-e',
          callId: req.callId,
          tool: req.tool,
          args: req.arguments,
          argsDigest: req.argsDigest,
        });
        const pending = approvalManager.listApprovals({ sessionId: 'sess-s8', status: 'pending' });
        validApprovalId = pending[0].id;
        validDigest = req.argsDigest;
        approvalManager.decideApproval(validApprovalId, { decision: 'allow' });
        return await dp;
      },
    });
    assert.equal(okRes.isError, false);
    assert.equal(okRes.output, 'deployed:canary');
    assert.equal(sideEffects, 1);
    assert.equal(capturedTraceToolCallId, 'tc-s8-ok');
    assert.deepEqual(capturedFrozenState, { rootFrozen: true, nestedFrozen: true });

    const dbConsumed = store.db
      .prepare('SELECT status, consumedAt FROM direct_approvals WHERE id=?')
      .get(validApprovalId);
    assert.equal(dbConsumed.status, 'consumed');
    assert.ok(dbConsumed.consumedAt > 0);

    // Replay same approvalId on 2nd call -> blocked via DB consumeApproval!
    const [replayRes] = await dispatcher.dispatchBatch({
      sessionId: 'sess-s8',
      turnId: 'turn-s8-e',
      toolCalls: [
        {
          id: 'tc-s8-replay',
          name: 'deploy_service',
          arguments: JSON.stringify({ config: { target: 'canary' } }),
        },
      ],
      tools: [deployTool],
      requestApproval: async () => ({
        allowed: true,
        approvalId: validApprovalId,
        argsDigest: validDigest,
      }),
    });
    assert.equal(replayRes.isError, true);
    assert.equal(replayRes.receipt.status, 'rejected_before_effect');
    assert.equal(replayRes.receipt.errorCode, 'APPROVAL_ALREADY_CONSUMED');
    assert.equal(sideEffects, 1);

    // Replay same approvalId even WITHOUT approvalManager (permit-registry single-use enforcement!)
    const permitOnlyDispatcher = new ToolDispatcher({
      store,
      eventRouter,
      reconciler,
      policy: new ToolPermissionPolicy({ permissionMode: 'approval' }),
    });
    const expectedCanaryDigest = computeArgsDigest('deploy_service', {
      config: { target: 'canary', region: 'us-east' },
    });
    const [p1] = await permitOnlyDispatcher.dispatchBatch({
      sessionId: 'sess-s8',
      turnId: 'turn-s8-f',
      toolCalls: [
        {
          id: 'tc-s8-p1',
          name: 'deploy_service',
          arguments: JSON.stringify({ config: { target: 'canary' } }),
        },
      ],
      tools: [deployTool],
      requestApproval: async () => ({
        allowed: true,
        approvalId: 'apr-permit-single-use',
        argsDigest: expectedCanaryDigest,
      }),
    });
    assert.equal(p1.isError, false);
    assert.equal(sideEffects, 2);

    const [p2] = await permitOnlyDispatcher.dispatchBatch({
      sessionId: 'sess-s8',
      turnId: 'turn-s8-f',
      toolCalls: [
        {
          id: 'tc-s8-p2',
          name: 'deploy_service',
          arguments: JSON.stringify({ config: { target: 'canary' } }),
        },
      ],
      tools: [deployTool],
      requestApproval: async () => ({
        allowed: true,
        approvalId: 'apr-permit-single-use',
        argsDigest: expectedCanaryDigest,
      }),
    });
    assert.equal(p2.isError, true);
    assert.equal(p2.receipt.status, 'rejected_before_effect');
    assert.equal(p2.receipt.errorCode, 'APPROVAL_ALREADY_CONSUMED');
    assert.equal(sideEffects, 2);

    // 8f. guardFallback hard-throws on 'deny' policy & ignores spoofed boolean permitConsumed
    const roTools = createWorkspaceTools({
      workspaceRoot: workDir,
      store,
      sessionId: 'sess-s8',
      permissionMode: 'read-only',
      requestApproval: async () => true,
    });
    const writeTool = roTools.find((t) => t.name === 'write_file');
    await assert.rejects(
      () =>
        writeTool.execute(
          { path: 'should-not-write.txt', content: 'spoofed' },
          { permitConsumed: true },
        ),
      (err) => err.code === 'POLICY_DENIED',
    );
    assert.equal(existsSync(join(workDir, 'should-not-write.txt')), false);

    // 8g. decideApproval on an expired approval commits status='expired' (no tx rollback) and resolves pending waiter
    let expiredAprId = null;
    const expiredWaiter = approvalManager.requestApproval({
      sessionId: 'sess-s8',
      turnId: 'turn-s8-exp',
      callId: 'tc-s8-exp',
      tool: 'deploy_service',
      args: { config: { target: 'expired' } },
      argsDigest: computeArgsDigest('deploy_service', { config: { target: 'expired' } }),
      timeoutMs: 60000,
    });
    const expRowPending = store.db
      .prepare("SELECT id FROM direct_approvals WHERE turnId='turn-s8-exp'")
      .get();
    expiredAprId = expRowPending.id;
    store.tx(() => {
      store.db
        .prepare('UPDATE direct_approvals SET expiresAt=? WHERE id=?')
        .run(Date.now() - 5000, expiredAprId);
    });
    assert.throws(
      () => approvalManager.decideApproval(expiredAprId, { decision: 'allow' }),
      (err) => err.code === 'APPROVAL_EXPIRED' && err.status === 409,
    );
    const expRowAfter = store.db
      .prepare('SELECT status, resolvedAt FROM direct_approvals WHERE id=?')
      .get(expiredAprId);
    assert.equal(expRowAfter.status, 'expired', 'expired status must be committed, not rolled back to pending');
    assert.ok(Number(expRowAfter.resolvedAt) > 0);
    const expiredWaiterResult = await withTimeout(expiredWaiter, 3000, 'expired waiter resolution');
    assert.equal(expiredWaiterResult.allowed, false);
    assert.equal(expiredWaiterResult.expired, true);
  } finally {
    store.close();
    rmDirSafe(dir);
    rmDirSafe(workDir);
  }
});

test('Scenario #9: Mid-chain hook config modification/revocation TOCTOU, MCP zero-trust + env sanitization + backoff, and digest/realpath approval hardening', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-fi-s9-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fi-s9-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const eventRouter = new EventRouter(store);
  const trustManager = new HookTrustManager({ store, eventRouter });

  const prevOpenAi = process.env.OPENAI_API_KEY;
  const prevBackend = process.env.BACKEND_TOKEN;
  process.env.OPENAI_API_KEY = 'sk-fi-s9-mcp-secret-99999';
  process.env.BACKEND_TOKEN = 'tok-fi-s9-mcp-secret-99999';

  const mcpManager = new McpLifecycleManager({
    dataRoot: dataDir,
    trustManager,
    store,
  });
  const mcpNoTrustManager = new McpLifecycleManager({
    dataRoot: dataDir,
  });

  try {
    mkdirSync(join(workDir, '.agent-us'), { recursive: true });
    const hooksFile = join(workDir, '.agent-us', 'hooks.json');
    const h1StartedFlag = join(workDir, 'h1-started.flag');
    const h1ContinueFlag = join(workDir, 'h1-continue.flag');
    const h2RanFlag = join(workDir, 'h2-ran.flag');

    // Helper script for handler #1: signals started and waits for continue.flag (up to 4s)
    const waitScript = join(workDir, 'hook1-wait.cjs');
    writeFileSync(
      waitScript,
      [
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(h1StartedFlag)}, 'started');`,
        'const deadline = Date.now() + 4000;',
        'const t = setInterval(() => {',
        `  if (fs.existsSync(${JSON.stringify(h1ContinueFlag)}) || Date.now() > deadline) {`,
        '    clearInterval(t);',
        '    process.exit(0);',
        '  }',
        '}, 20);',
      ].join('\n'),
      'utf8',
    );
    const h2Script = join(workDir, 'hook2-touch.cjs');
    writeFileSync(
      h2Script,
      `require('fs').writeFileSync(${JSON.stringify(h2RanFlag)}, 'ran');`,
      'utf8',
    );

    const twoHandlerConfig = JSON.stringify({
      PreToolUse: [
        {
          matcher: 'write_file',
          kind: 'observation',
          timeoutMs: 8000,
          command: `node "${waitScript}"`,
        },
        {
          matcher: 'write_file',
          kind: 'security',
          timeoutMs: 8000,
          command: `node "${h2Script}"`,
        },
      ],
    });
    writeFileSync(hooksFile, twoHandlerConfig, 'utf8');

    // 9a. requireExpectedDigest rejects missing digest, rejects wrong digest, accepts exact digest
    assert.throws(
      () => trustManager.approveFile(hooksFile, { workspaceRoot: workDir, requireExpectedDigest: true }),
      (err) => err.code === 'HOOK_DIGEST_REQUIRED',
    );
    assert.throws(
      () =>
        trustManager.approveFile(hooksFile, {
          workspaceRoot: workDir,
          expectedDigest: '0'.repeat(64),
          requireExpectedDigest: true,
        }),
      (err) => err.code === 'HOOK_DIGEST_MISMATCH',
    );
    const exactDigest = computeHookContentDigest(twoHandlerConfig);
    trustManager.approveFile(hooksFile, {
      workspaceRoot: workDir,
      expectedDigest: exactDigest,
      requireExpectedDigest: true,
      approvedBy: 'operator',
    });

    // 9b. Mid-chain TAMPER: while handler #1 is paused, modify hooks.json on disk -> handler #2 MUST NOT run!
    const runner = new HookRunner(workDir, { dataRoot: dataDir, store, trustManager });
    const runTamperPromise = runner.run('PreToolUse', {
      tool: 'write_file',
      arguments: { path: 'a.txt', content: 'x' },
    });

    await withTimeout(
      (async () => {
        while (!existsSync(h1StartedFlag)) await delay(15);
      })(),
      5000,
      'handler 1 start (tamper)',
    );
    writeFileSync(hooksFile, JSON.stringify({ PreToolUse: [{ matcher: '.*', kind: 'security', command: 'echo evil' }] }), 'utf8');
    writeFileSync(h1ContinueFlag, 'go', 'utf8');

    const tamperRes = await runTamperPromise;
    assert.equal(tamperRes.blocked, true);
    assert.equal(tamperRes.failClosed, true);
    assert.match(tamperRes.reason, /HOOK_CONFIG_MODIFIED_BEFORE_EXEC/);
    assert.equal(existsSync(h2RanFlag), false, 'handler #2 MUST NOT execute after hooks.json modified mid-chain');

    // 9c. Mid-chain REVOKE: re-approve unmodified config, pause handler #1, call revokeFile -> handler #2 MUST NOT run!
    rmSync(h1StartedFlag, { force: true });
    rmSync(h1ContinueFlag, { force: true });
    writeFileSync(hooksFile, twoHandlerConfig, 'utf8');
    trustManager.approveFile(hooksFile, {
      workspaceRoot: workDir,
      expectedDigest: exactDigest,
      requireExpectedDigest: true,
    });

    const runRevokePromise = runner.run('PreToolUse', {
      tool: 'write_file',
      arguments: { path: 'a.txt', content: 'x' },
    });
    await withTimeout(
      (async () => {
        while (!existsSync(h1StartedFlag)) await delay(15);
      })(),
      5000,
      'handler 1 start (revoke)',
    );
    trustManager.revokeFile(hooksFile, { reason: 'operator_revoked_mid_chain' });
    writeFileSync(h1ContinueFlag, 'go', 'utf8');

    const revokeRes = await runRevokePromise;
    assert.equal(revokeRes.blocked, true);
    assert.equal(revokeRes.failClosed, true);
    assert.match(revokeRes.reason, /HOOK_TRUST_REVOKED_BEFORE_EXEC/);
    assert.equal(existsSync(h2RanFlag), false, 'handler #2 MUST NOT execute after trust revoked mid-chain');

    // 9d. Junction/realpath approval & revocation even after link is deleted
    const realCfgDir = join(workDir, 'real-cfg');
    mkdirSync(realCfgDir, { recursive: true });
    const realHookTarget = join(realCfgDir, 'hooks.json');
    writeFileSync(realHookTarget, '{"PostToolUse":[]}', 'utf8');
    const juncDir = join(workDir, 'junc-cfg');
    if (tryCreateSymlink(realCfgDir, juncDir, 'junction')) {
      const viaJunc = join(juncDir, 'hooks.json');
      trustManager.approveFile(viaJunc, { workspaceRoot: workDir, approvedBy: 'op' });
      assert.equal(trustManager.verifyFile(realHookTarget).trusted, true);
      rmSync(juncDir, { recursive: true, force: true });
      // Even after junction is deleted, revoking lexical path revokes the realpath target!
      const rev = trustManager.revokeFile(viaJunc, { reason: 'deleted_link' });
      assert.ok(rev.revokedCount >= 1);
      assert.equal(trustManager.verifyFile(realHookTarget).trusted, false);
    }

    // Case-variant listApprovals matching on Windows/macOS
    if (process.platform === 'win32' || process.platform === 'darwin') {
      trustManager.approveFile(hooksFile, { workspaceRoot: workDir, approvedBy: 'op' });
      const listed = trustManager.listApprovals({ workspaceRoot: workDir.toUpperCase() });
      assert.ok(listed.length >= 1, 'listApprovals must match case-variant workspaceRoot');
    }

    // 9e. Untrusted workspace .agent-us/mcp.json spawns ZERO processes; trusted MCP strips host secrets!
    const mcpSpawnFlag = join(workDir, 'mcp-spawned.flag');
    const mcpEnvDump = join(workDir, 'mcp-env.json');
    const mockMcpScript = join(workDir, 'mock-mcp-server.cjs');
    writeFileSync(
      mockMcpScript,
      [
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(mcpSpawnFlag)}, 'spawned');`,
        `fs.writeFileSync(${JSON.stringify(mcpEnvDump)}, JSON.stringify({ openai: process.env.OPENAI_API_KEY || null, backend: process.env.BACKEND_TOKEN || null }));`,
        "let buf = '';",
        "process.stdin.on('data', (c) => {",
        "  buf += c.toString('utf8');",
        "  const lines = buf.split(/\\r?\\n/);",
        "  buf = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    if (msg.method === 'initialize') {",
        "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } }) + '\\n');",
        "    } else if (msg.method === 'tools/list') {",
        "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'ping tool', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');",
        '    }',
        '  }',
        '});',
      ].join('\n'),
      'utf8',
    );
    const mcpConfigPath = join(workDir, '.agent-us', 'mcp.json');
    const mcpConfigJson = JSON.stringify({
      mcpServers: {
        demo: { command: process.execPath, args: [mockMcpScript] },
      },
    });
    writeFileSync(mcpConfigPath, mcpConfigJson, 'utf8');

    // Untrusted with trustManager -> 0 tools, 0 spawned processes!
    const untrustedTools1 = await mcpManager.discoverTools(workDir);
    assert.equal(untrustedTools1.length, 0);
    assert.equal(existsSync(mcpSpawnFlag), false, 'untrusted workspace mcp.json MUST NOT spawn');

    // Untrusted with NO trustManager -> fail-closed: 0 tools, 0 spawned processes!
    const untrustedTools2 = await mcpNoTrustManager.discoverTools(workDir);
    assert.equal(untrustedTools2.length, 0);
    assert.equal(existsSync(mcpSpawnFlag), false, 'workspace mcp.json without trustManager MUST NOT spawn');

    // Explicitly approve mcp.json SHA-256 -> spawns with sanitized env (zero secret leak!)
    trustManager.approveFile(mcpConfigPath, {
      workspaceRoot: workDir,
      expectedDigest: computeHookContentDigest(mcpConfigJson),
      requireExpectedDigest: true,
    });
    const trustedTools = await mcpManager.discoverTools(workDir);
    assert.equal(trustedTools.length, 1);
    assert.equal(trustedTools[0].fullName, 'mcp__demo__ping');
    assert.equal(existsSync(mcpSpawnFlag), true);
    const dumpedEnv = JSON.parse(readFileSync(mcpEnvDump, 'utf8'));
    assert.equal(dumpedEnv.openai, null, 'OPENAI_API_KEY must be stripped from MCP child env');
    assert.equal(dumpedEnv.backend, null, 'BACKEND_TOKEN must be stripped from MCP child env');

    // Non-existent MCP binary (ENOENT) must NOT crash Node, must mark 'degraded' (not 'ready'), and obey backoff!
    const brokenMcp = new McpLifecycleManager({
      staticMcp: {
        missing_bin: ['__definitely_nonexistent_mcp_binary_xyz_999__', '--stdio'],
      },
    });
    const brokenTools = await brokenMcp.discoverTools(workDir);
    assert.equal(brokenTools.length, 0);
    const status = brokenMcp.getStatus().find((s) => s.server === 'missing_bin');
    assert.equal(status.status, 'degraded', 'failed MCP server must be marked degraded, never ready');
    assert.equal(status.failures, 1);
    // Second call immediately inside backoff window must NOT increment failures (skipped cleanly!)
    await brokenMcp.discoverTools(workDir);
    assert.equal(
      brokenMcp.getStatus().find((s) => s.server === 'missing_bin').failures,
      1,
      'degraded MCP server must respect backoff window',
    );
    brokenMcp.close();
  } finally {
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAi;
    if (prevBackend === undefined) delete process.env.BACKEND_TOKEN;
    else process.env.BACKEND_TOKEN = prevBackend;
    mcpManager.close();
    mcpNoTrustManager.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('Scenario #16: Cross-OS path case sensitivity, dangling/intra-workspace symlinks, grep secret protection, shell analyzer, SSRF IPv6, and worktree live-PID rehydration', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-fi-s16-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fi-s16-work-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'agent-us-fi-s16-out-'));
  const gitDir = mkdtempSync(join(tmpdir(), 'agent-us-fi-s16-git-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const eventRouter = new EventRouter(store);
  const reconciler = new UnknownOutcomeReconciler(store, eventRouter);

  try {
    // 16a. Protected files, case variants, trailing dots/spaces, NTFS ADS, legal `..env`, and grep confinement
    mkdirSync(join(workDir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(workDir, '.git', 'config'), 'SECRET_GIT_CONFIG\n', 'utf8');
    writeFileSync(join(workDir, '.dev-token'), 'SUPER_SECRET_DEV_TOKEN_12345\n', 'utf8');
    writeFileSync(join(workDir, '.pool-key'), 'SUPER_SECRET_POOL_KEY_12345\n', 'utf8');
    writeFileSync(join(workDir, '.provider-env.json'), '{"key":"SECRET_PROVIDER_ENV"}\n', 'utf8');
    writeFileSync(join(workDir, 'readme.txt'), 'NORMAL_PUBLIC_CONTENT\n', 'utf8');
    writeFileSync(join(workDir, 'App.js'), 'export const v = 1;\n', 'utf8');

    for (const blockedPath of [
      '.GIT/config',
      '.Git/hooks/pre-commit',
      '.DEV-TOKEN',
      '.POOL-KEY',
      '.PROVIDER-ENV.JSON',
      '.pool-key.',
      '.dev-token ',
      '.dev-token::$DATA',
      '.git/config::$DATA',
    ]) {
      assert.throws(
        () => resolveConfinedPath(workDir, blockedPath),
        /不允许|受保护|边界/,
        `resolveConfinedPath must block "${blockedPath}"`,
      );
    }

    // Legal filename starting with `..` (e.g. `..env`) MUST be allowed!
    const dotDotEnv = resolveConfinedPath(workDir, '..env');
    assert.equal(dotDotEnv.rel, '..env');

    const readFileState = new Map();
    const tools = createWorkspaceTools({
      workspaceRoot: workDir,
      store,
      sessionId: 'sess-s16',
      permissionMode: 'auto-safe',
      readFileState,
      toolModes: { webFetch: true },
    });
    const readTool = tools.find((t) => t.name === 'read_file');
    const writeTool = tools.find((t) => t.name === 'write_file');
    const editTool = tools.find((t) => t.name === 'edit_file');
    const grepTool = tools.find((t) => t.name === 'grep');

    await writeTool.execute({ path: '..env', content: 'LEGAL_DOTDOT_ENV=1\n' });
    const envRead = await readTool.execute({ path: '..env' });
    assert.match(envRead, /LEGAL_DOTDOT_ENV=1/);

    // grep must NEVER leak .dev-token / .pool-key / .provider-env.json / .git/config
    const grepOut = await grepTool.execute({ query: 'SECRET', path: '.' });
    assert.doesNotMatch(grepOut, /SUPER_SECRET_DEV_TOKEN_12345/);
    assert.doesNotMatch(grepOut, /SUPER_SECRET_POOL_KEY_12345/);
    assert.doesNotMatch(grepOut, /SECRET_PROVIDER_ENV/);
    assert.doesNotMatch(grepOut, /SECRET_GIT_CONFIG/);

    // 16b. Dangling symlink & directory junction escapes blocked
    const juncEscape = join(workDir, 'junc-out');
    if (tryCreateSymlink(outsideDir, juncEscape, 'junction')) {
      assert.throws(
        () => resolveConfinedPath(workDir, 'junc-out/nonexistent-new.txt'),
        /逃逸|边界/,
      );
    }
    const danglingOutsideTarget = join(outsideDir, 'dangling-created.txt');
    const danglingLink = join(workDir, 'dangling.txt');
    if (tryCreateSymlink(danglingOutsideTarget, danglingLink)) {
      assert.throws(
        () => resolveConfinedPath(workDir, 'dangling.txt'),
        /逃逸|边界/,
      );
      await assert.rejects(() =>
        writeTool.execute({ path: 'dangling.txt', content: 'escaped!' }),
      );
      assert.equal(existsSync(danglingOutsideTarget), false, 'dangling symlink write must not create file outside workspace');
    }

    // 16c. Intra-workspace symlink/junction to .git or .dev-token blocked!
    const gitAlias = join(workDir, 'git-alias');
    if (tryCreateSymlink(join(workDir, '.git'), gitAlias, 'junction')) {
      assert.throws(
        () => resolveConfinedPath(workDir, 'git-alias/config'),
        /不允许|\.git/,
      );
    }
    const tokenAlias = join(workDir, 'tok-alias');
    if (tryCreateSymlink(join(workDir, '.dev-token'), tokenAlias)) {
      assert.throws(
        () => resolveConfinedPath(workDir, 'tok-alias'),
        /受保护/,
      );
    }

    // 16d. Case-insensitive stale-write protection on Windows/macOS (and exact-case on Linux)
    await readTool.execute({ path: 'App.js' });
    writeFileSync(join(workDir, 'App.js'), 'export const v = 999;\n', 'utf8');
    const editPathVariant =
      process.platform === 'win32' || process.platform === 'darwin' ? 'app.js' : 'App.js';
    await assert.rejects(
      () =>
        editTool.execute({
          path: editPathVariant,
          target: 'export const v = 1;',
          replacement: 'export const v = 2;',
        }),
      /防脏写拦截/,
    );

    // 16e. Shell command analyzer, hard blocks & session-prefix RCE resistance
    assert.equal(analyzeCommand('echo \\; whoami').isReadOnly, false);
    assert.equal(analyzeCommand('git branch -D main').isReadOnly, false);
    assert.equal(analyzeCommand('git branch -m main evil').isReadOnly, false);
    assert.equal(analyzeCommand('git branch new-branch').isReadOnly, false);
    assert.equal(analyzeCommand('git branch').isReadOnly, true);
    assert.equal(analyzeCommand('git branch --list').isReadOnly, true);
    assert.equal(analyzeCommand('git branch --show-current').isReadOnly, true);
    assert.equal(analyzeCommand('cat ../../.dev-token').isReadOnly, false);
    assert.equal(analyzeCommand('Get-Content ..\\.dev-token').isReadOnly, false);
    assert.equal(analyzeCommand('git diff --no-index /etc/passwd /dev/null').isReadOnly, false);
    assert.equal(analyzeCommand('git -C /outside status').isReadOnly, false);
    assert.equal(analyzeCommand('git --config-env=core.sshCommand=X status').isReadOnly, false);

    assert.ok(analyzeCommand('echo ok\nrm -rf /').hardBlocked);
    assert.ok(analyzeCommand('env FOO=1 rm -rf /').hardBlocked);
    assert.ok(analyzeCommand('rm -rf //').hardBlocked);
    assert.ok(analyzeCommand('rm -rf /./').hardBlocked);
    assert.ok(analyzeCommand('rm -rf "${HOME}"').hardBlocked);
    assert.ok(analyzeCommand('I`nvoke-Expression (Get-Content evil.ps1)').hardBlocked);

    assert.equal(canonicalizeCommandPrefix('sh -c "npm test "; whoami; echo "ok"'), null);
    assert.equal(canonicalizeCommandPrefix('node -e "console.log(1)"'), null);
    assert.equal(canonicalizeCommandPrefix('python -c "import os"'), null);
    assert.equal(canonicalizeCommandPrefix('curl https://evil.com'), null);
    assert.equal(canonicalizeCommandPrefix('git -c core.sshCommand=evil status'), null);
    assert.equal(canonicalizeCommandPrefix('bash -lc "npm test -- --watch"'), 'npm test');

    // 16f. SSRF 128-bit IPv6/IPv4 CIDR checks, unknown permissionMode fail-closed, & web_fetch taint gate
    for (const privIp of [
      'fe81::1',
      'febf::1',
      '0:0:0:0:0:0:0:1',
      '64:ff9b::127.0.0.1',
      '::127.0.0.1',
      '2002:7f00:0001::',
      'ff02::1',
      'fc00::1',
      'fd12:3456::1',
      '224.0.0.1',
      '240.0.0.1',
      '100.64.0.1',
      'fe80::1%eth0',
    ]) {
      assert.equal(isPrivateIpAddress(privIp), true, `${privIp} must be blocked as private/reserved`);
    }
    assert.equal(isPrivateIpAddress('93.184.216.34'), false);
    assert.equal(isPrivateIpAddress('2606:2800:220:1:248:1893:25c8:1946'), false);

    for (const badUrl of [
      'https://[fe81::1]/secret',
      'https://[0:0:0:0:0:0:0:1]/secret',
      'https://[64:ff9b::127.0.0.1]/secret',
    ]) {
      await assert.rejects(
        () => validateExternalUrl(badUrl),
        (err) => err.code === 'SSRF_BLOCKED',
      );
    }
    await assert.rejects(
      () =>
        validateExternalUrl('https://ipv6-rebind.example.com/', {
          lookupImpl: async () => [{ address: 'fe81::1', family: 6 }],
        }),
      (err) => err.code === 'SSRF_DNS_BLOCKED',
    );

    // Bracketed public IPv6 & public IPv4 literals bypass DNS lookup and pin directly
    let literalLookupCalls = 0;
    const publicIpv6Parsed = await validateExternalUrl(
      'https://[2606:2800:220:1:248:1893:25c8:1946]/resource',
      {
        lookupImpl: async () => {
          literalLookupCalls++;
          throw new Error('DNS should not be called for IP literals');
        },
      },
    );
    assert.equal(literalLookupCalls, 0);
    assert.deepEqual(publicIpv6Parsed._resolvedAddresses, [
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    const publicIpv4Parsed = await validateExternalUrl('https://93.184.216.34/resource', {
      lookupImpl: async () => {
        literalLookupCalls++;
        throw new Error('DNS should not be called for IP literals');
      },
    });
    assert.equal(literalLookupCalls, 0);
    assert.deepEqual(publicIpv4Parsed._resolvedAddresses, [
      { address: '93.184.216.34', family: 4 },
    ]);

    assert.equal(
      intersectPolicies({ permissionMode: 'unknown-typo' }, { permissionMode: 'full-access' })
        .permissionMode,
      'read-only',
    );

    const webFetchTool = tools.find((t) => t.name === 'web_fetch');
    await assert.rejects(
      () => webFetchTool.execute({ url: 'https://example.com' }, { tainted: true }),
      (err) => err.code === 'WEB_FETCH_TAINTED_BLOCKED',
    );
    const taintedDispatcher = new ToolDispatcher({
      store,
      eventRouter,
      reconciler,
      policy: new ToolPermissionPolicy({ permissionMode: 'auto-safe' }),
    });
    const [taintedFetchRes] = await taintedDispatcher.dispatchBatch({
      sessionId: 'sess-s16',
      turnId: 'turn-s16-taint',
      tainted: true,
      requestApproval: null,
      toolCalls: [{ id: 'tc-wf', name: 'web_fetch', arguments: '{"url":"https://example.com"}' }],
      tools,
    });
    assert.equal(taintedFetchRes.isError, true);
    assert.equal(taintedFetchRes.receipt.errorCode, 'APPROVAL_SERVICE_UNAVAILABLE');

    // 16g. Worktree P0-10: reclaiming expired lease whose OS PID is STILL alive clones into a fresh dir!
    execFileSync('git', ['init'], { cwd: gitDir, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitDir, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: gitDir, windowsHide: true });
    writeFileSync(join(gitDir, 'base.txt'), 'v1\n', 'utf8');
    execFileSync('git', ['add', 'base.txt'], { cwd: gitDir, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: gitDir, windowsHide: true });

    const isolator = new GitWorktreeIsolator(store);
    const now = Date.now();
    store.tx(() => {
      store.db
        .prepare(
          "INSERT INTO runtime_workers(workerId, pid, hostname, status, startedAt, heartbeatAt) VALUES('w-alive', ?, 'test-host', 'active', ?, ?)",
        )
        .run(process.pid, now, now);
      store.db
        .prepare(
          "INSERT INTO runtime_jobs(id, kind, payload, status, fence, workerId, leaseExpiresAt, attempts, maxAttempts, createdAt, updatedAt) VALUES('j-exp','swarm_node_execute','{}','active','f1','w-alive',?,1,3,?,?)",
        )
        .run(now - 5000, now - 10000, now - 10000);
    });

    const wtA = await isolator.acquire(gitDir, {
      ownerId: 'owner-A',
      workerId: 'w-alive',
      runId: 'run-p010',
      nodeKey: 'node-1',
      jobId: 'j-exp',
      fence: 'f1',
      attempt: 1,
    });
    writeFileSync(join(wtA.path, 'dirty.txt'), 'from-worker-A\n', 'utf8');

    // Simulate a clone failure (invalid baseCommit) -> must restore status='active' (NOT 'preserved')
    // so the subsequent retry STILL clones instead of rehydrating in-place into the live PID's dir!
    const origBaseCommit = store.db
      .prepare('SELECT baseCommit FROM worktree_leases WHERE id=?')
      .get(wtA.leaseId).baseCommit;
    store.tx(() => {
      store.db
        .prepare("UPDATE worktree_leases SET baseCommit='deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' WHERE id=?")
        .run(wtA.leaseId);
    });
    await assert.rejects(() =>
      isolator.acquire(gitDir, {
        ownerId: 'owner-B-fail',
        workerId: 'w-B',
        runId: 'run-p010',
        nodeKey: 'node-1',
        jobId: 'j-B',
        fence: 'f2',
        attempt: 2,
        rehydrateExisting: true,
      }),
    );
    const afterFailedClone = store.db
      .prepare('SELECT status, cleanupState FROM worktree_leases WHERE id=?')
      .get(wtA.leaseId);
    assert.equal(afterFailedClone.status, 'active', 'failed clone must restore prior active status, not preserved');
    assert.equal(afterFailedClone.cleanupState, 'active');
    store.tx(() => {
      store.db
        .prepare('UPDATE worktree_leases SET baseCommit=? WHERE id=?')
        .run(origBaseCommit, wtA.leaseId);
    });

    // Worker B retries reclaiming the expired lease while worker A's PID is STILL alive -> MUST still clone!
    const wtB = await isolator.acquire(gitDir, {
      ownerId: 'owner-B',
      workerId: 'w-B',
      runId: 'run-p010',
      nodeKey: 'node-1',
      jobId: 'j-B',
      fence: 'f2',
      attempt: 2,
      rehydrateExisting: true,
    });
    assert.equal(wtB.rehydrated, true);
    assert.notEqual(wtB.path, wtA.path, 'expired lease with live PID must clone into a fresh worktree directory');
    assert.equal(readFileSync(join(wtB.path, 'dirty.txt'), 'utf8'), 'from-worker-A\n');

    // Stale Worker A modifying its old dir does NOT corrupt Worker B's isolated dir!
    writeFileSync(join(wtA.path, 'dirty.txt'), 'CORRUPTED_BY_STALE_A\n', 'utf8');
    assert.equal(readFileSync(join(wtB.path, 'dirty.txt'), 'utf8'), 'from-worker-A\n');

    await wtA.release({ forceDiscard: true });
    await wtB.release({ forceDiscard: true });
  } finally {
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
    rmDirSafe(outsideDir);
    rmDirSafe(gitDir);
  }
});
