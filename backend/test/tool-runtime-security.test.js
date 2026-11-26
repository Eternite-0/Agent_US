import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { createWorkspaceTools } from '../src/workspace-tools.js';
import {
  ToolPermissionPolicy,
  analyzeCommand,
  intersectPolicies,
  safeFetchExternal,
  validateExternalUrl,
} from '../src/tools/policy.js';
import {
  DockerSandboxAdapter,
  HostSandboxAdapter,
  resolveConfinedPath,
  sanitizeChildEnv,
} from '../src/tools/sandbox.js';
import { ToolDispatcher } from '../src/tools/dispatcher.js';
import { UnknownOutcomeReconciler } from '../src/durable/reconciliation.js';
import { EventRouter } from '../src/kernel/events.js';
import { ExecutePermitRegistry } from '../src/permits.js';

test('P3 Tools: Command analyzer blocks POSIX/PowerShell destructive & eval patterns while allowing strict read-only subset', () => {
  assert.equal(analyzeCommand('git status').isReadOnly, true);
  assert.equal(analyzeCommand('git diff --stat').isReadOnly, true);
  assert.equal(analyzeCommand('node -v').isReadOnly, true);

  // Blocked flags / compound / subshell must NOT be classified read-only
  assert.equal(analyzeCommand('git -c core.sshCommand=evil status').isReadOnly, false);
  assert.equal(analyzeCommand('git status && whoami').isReadOnly, false);
  assert.equal(analyzeCommand('echo $(whoami)').isReadOnly, false);
  assert.equal(analyzeCommand('node -e "console.log(1)"').isReadOnly, false);

  // Hard blocks (POSIX + PowerShell)
  assert.ok(analyzeCommand('rm -rf /').hardBlocked);
  assert.ok(analyzeCommand('Invoke-Expression (Get-Content evil.ps1)').hardBlocked);
  assert.ok(analyzeCommand('powershell -EncodedCommand ZQB2AGkAbAA=').hardBlocked);
  assert.ok(analyzeCommand('Remove-Item -Recurse -Force C:\\').hardBlocked);
});

test('P3 Security: SSRF guard blocks private/loopback DNS rebinding, IPv4-mapped IPv6, and 302 redirects to localhost', async () => {
  await assert.rejects(
    () => validateExternalUrl('http://example.com'),
    (err) => err.code === 'URL_PROTOCOL_BLOCKED',
  );
  await assert.rejects(
    () => validateExternalUrl('https://127.0.0.1/secret'),
    (err) => err.code === 'SSRF_BLOCKED',
  );
  await assert.rejects(
    () => validateExternalUrl('https://[::ffff:127.0.0.1]/meta'),
    (err) => err.code === 'SSRF_BLOCKED',
  );

  // DNS rebinding simulation: public hostname resolves to RFC1918 10.0.0.5
  await assert.rejects(
    () =>
      validateExternalUrl('https://rebind.example.com/data', {
        lookupImpl: async () => [{ address: '10.0.0.5', family: 4 }],
      }),
    (err) => err.code === 'SSRF_DNS_BLOCKED',
  );

  // Redirect chain simulation: 302 to 169.254.169.254 metadata endpoint must fail before hop 2
  await assert.rejects(
    () =>
      safeFetchExternal('https://public.example.com/start', {
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async () => ({
          status: 302,
          headers: new Map([['location', 'https://169.254.169.254/latest/meta-data']]),
        }),
      }),
    (err) => err.code === 'SSRF_BLOCKED',
  );
});

test('P3 Sandbox & Policy: Env sanitization, symlink escape guard, capability matrix, and policy ceiling intersection', () => {
  const sanitized = sanitizeChildEnv({
    PATH: '/usr/bin',
    BACKEND_TOKEN: 'secret-token-123456',
    OPENAI_API_KEY: 'sk-secret-123456',
    MY_CUSTOM_SECRET: 'top-secret',
    NODE_ENV: 'test',
  });
  assert.equal(sanitized.PATH, '/usr/bin');
  assert.equal(sanitized.NODE_ENV, 'test');
  assert.equal(sanitized.BACKEND_TOKEN, undefined);
  assert.equal(sanitized.OPENAI_API_KEY, undefined);
  assert.equal(sanitized.MY_CUSTOM_SECRET, undefined);

  const hostCaps = new HostSandboxAdapter().capabilities();
  const dockerCaps = new DockerSandboxAdapter().capabilities();
  assert.equal(hostCaps.mode, 'host');
  assert.equal(hostCaps.networkIsolated, false);
  assert.equal(hostCaps.envSanitized, true);
  assert.equal(dockerCaps.mode, 'container');
  assert.equal(dockerCaps.networkIsolated, true);
  assert.equal(dockerCaps.capDropAll, true);

  // Policy intersection never escalates child above parent
  const ceiled = intersectPolicies(
    { permissionMode: 'auto-safe', denyTools: ['bash'], allowTools: ['read_file', 'glob'] },
    { permissionMode: 'full-access', denyTools: [], allowTools: ['read_file', 'bash'] },
  );
  assert.equal(ceiled.permissionMode, 'auto-safe');
  assert.deepEqual(ceiled.denyTools, ['bash']);
  assert.deepEqual(ceiled.allowTools, ['read_file']);

  // Symlink escape detection (skip gracefully if OS denies symlink creation without privilege)
  const root = mkdtempSync(join(tmpdir(), 'agent-us-sym-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'agent-us-sym-out-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'outside', 'utf8');
    const linkPath = join(root, 'escape');
    let symlinkCreated = false;
    try {
      symlinkSync(outside, linkPath, 'junction');
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      assert.throws(
        () => resolveConfinedPath(root, 'escape/secret.txt'),
        /逃逸|边界/,
      );
    }
    // Core sandbox has zero hardcoded container-path stripping (external paths are rejected)
    assert.throws(
      () => resolveConfinedPath(root, '/testbed/src/app.py'),
      /逃逸|边界|绝对路径|路径/,
    );
  } finally {
    rmDirSafe(root);
    rmDirSafe(outside);
  }
});

test('P3 ToolDispatcher: Zod 2-strike auto-recovery, outward MCP human gate, permit binding, and tool_receipts persistence', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-p3-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-p3-work-'));
  writeFileSync(join(workDir, 'hello.txt'), 'alpha\nbeta\n', 'utf8');
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const router = new EventRouter(store);
  const reconciler = new UnknownOutcomeReconciler(store, router);
  const policy = new ToolPermissionPolicy({ permissionMode: 'auto-safe' });
  const permits = new ExecutePermitRegistry();
  const dispatcher = new ToolDispatcher({ store, eventRouter: router, reconciler, policy, permits });

  let mcpExecuted = 0;
  let approvalRequests = 0;
  const tools = createWorkspaceTools({
    workspaceRoot: workDir,
    store,
    sessionId: 's-p3',
    permissionMode: 'auto-safe',
    toolModes: { contextRecall: true },
    mcpTools: [
      {
        fullName: 'mcp__ext__deploy',
        serverName: 'ext',
        toolName: 'deploy',
        description: 'External deploy',
        parameters: { type: 'object', properties: { env: { type: 'string' } } },
        call: async (args) => {
          mcpExecuted++;
          return `deployed:${args?.env ?? 'prod'}`;
        },
      },
    ],
  });

  try {
    const argStrikes = new Map();
    // 1. Zod validation failure twice triggers 2-strike disable & records rejected_before_effect receipt
    const bad1 = await dispatcher.dispatchBatch({
      sessionId: 's-p3',
      turnId: 't-p3',
      toolCalls: [{ id: 'c-bad-1', name: 'read_file', arguments: '{}' }],
      tools,
      argStrikes,
    });
    assert.equal(bad1[0].isError, true);
    assert.ok(bad1[0].output.includes('参数校验失败'));

    const bad2 = await dispatcher.dispatchBatch({
      sessionId: 's-p3',
      turnId: 't-p3',
      toolCalls: [{ id: 'c-bad-2', name: 'read_file', arguments: '{}' }],
      tools,
      argStrikes,
    });
    assert.ok(bad2[0].output.includes('连续参数校验失败'));

    // 2. Outward MCP tool is NEVER auto-approved in auto-safe or even full-access without explicit allow
    const mcpDenied = await dispatcher.dispatchBatch({
      sessionId: 's-p3',
      turnId: 't-p3',
      permissionMode: 'full-access',
      toolCalls: [{ id: 'c-mcp-1', name: 'mcp__ext__deploy', arguments: '{"env":"prod"}' }],
      tools,
      requestApproval: async () => {
        approvalRequests++;
        return false;
      },
    });
    assert.equal(approvalRequests, 1);
    assert.equal(mcpDenied[0].isError, true);
    assert.equal(mcpExecuted, 0);

    // 3. Valid read_file & read_blob (accepting both offset/limit & start/maxChars) persist receipts
    const blob = store.putBlob('0123456789ABCDEF');
    const okBatch = await dispatcher.dispatchBatch({
      sessionId: 's-p3',
      turnId: 't-p3',
      toolCalls: [
        { id: 'c-ok-1', name: 'read_file', arguments: JSON.stringify({ path: 'hello.txt' }) },
        { id: 'c-ok-2', name: 'read_blob', arguments: JSON.stringify({ uri: blob.uri, offset: 4, limit: 6 }) },
      ],
      tools,
    });
    assert.equal(okBatch[0].isError, false);
    assert.ok(okBatch[0].output.includes('alpha'));
    assert.equal(okBatch[1].isError, false);
    assert.ok(okBatch[1].output.includes('456789'));

    const receipts = reconciler.listReceipts({ sessionId: 's-p3', turnId: 't-p3' });
    assert.ok(receipts.some((r) => r.status === 'rejected_before_effect' && r.errorCode === 'INVALID_ARGUMENTS'));
    assert.ok(receipts.some((r) => r.toolName === 'read_file' && r.status === 'finished' && r.effectClass === 'read_only'));
    assert.ok(receipts.some((r) => r.toolName === 'read_blob' && r.status === 'finished'));
  } finally {
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});
