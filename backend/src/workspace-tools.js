import {
  ExecutePermitRegistry,
  dispatchWithPermit,
  verifyAndClearPermitProof,
} from './permits.js';
import { PolicyError } from './kernel/errors.js';
import { canonicalizeCommandPrefix } from './patch-and-diagnostics.js';
import { ToolRegistry } from './tools/registry.js';
import { ToolPermissionPolicy } from './tools/policy.js';
import { HostSandboxAdapter, resolveConfinedPath } from './tools/sandbox.js';
import { ToolResultProcessor, computeArgsDigest } from './tools/dispatcher.js';
import { createFsTools } from './tools/builtin/fs-tools.js';
import {
  BackgroundProcessManager,
  createShellTools,
} from './tools/builtin/shell-tools.js';
import { createMetaTools } from './tools/builtin/meta-tools.js';

export { BackgroundProcessManager };

export const WORKSPACE_TOOL_META = Object.freeze({
  read_file: { readOnly: true, risk: 'low', effectClass: 'read_only', replayable: true, outward: false },
  glob: { readOnly: true, risk: 'low', effectClass: 'read_only', replayable: true, outward: false },
  grep: { readOnly: true, risk: 'low', effectClass: 'read_only', replayable: true, outward: false },
  read_blob: { readOnly: true, risk: 'low', effectClass: 'read_only', replayable: true, outward: false },
  web_fetch: { readOnly: true, risk: 'low', effectClass: 'external_network', replayable: true, outward: false },
  search_history: { readOnly: true, risk: 'low', effectClass: 'read_only', replayable: true, outward: false },
  read_process_output: { readOnly: true, risk: 'low', effectClass: 'read_only', replayable: true, outward: false },
  update_plan: { readOnly: true, risk: 'low', effectClass: 'read_only', replayable: true, outward: false },
  spawn_subagent: { readOnly: true, risk: 'low', effectClass: 'read_only', replayable: true, outward: false },
  swarm_orchestrate: { readOnly: false, risk: 'medium', effectClass: 'reversible_write', replayable: false, outward: false },
  send_agent_message: { readOnly: true, risk: 'low', effectClass: 'read_only', replayable: false, outward: false },
  edit_file: { readOnly: false, risk: 'medium', effectClass: 'reversible_write', replayable: true, outward: false },
  write_file: { readOnly: false, risk: 'medium', effectClass: 'reversible_write', replayable: true, outward: false },
  apply_patch: { readOnly: false, risk: 'medium', effectClass: 'reversible_write', replayable: true, outward: false },
  bash: { readOnly: false, risk: 'high', effectClass: 'irreversible_side_effect', replayable: false, outward: false },
  start_process: { readOnly: false, risk: 'high', effectClass: 'irreversible_side_effect', replayable: false, outward: false },
  kill_process: { readOnly: false, risk: 'medium', effectClass: 'irreversible_side_effect', replayable: false, outward: false },
});

export function resolveSafePath(workspaceRoot, rawPath) {
  return resolveConfinedPath(workspaceRoot, rawPath);
}

export function needsApproval(
  toolName,
  args,
  permissionMode = 'auto-safe',
  { approvedPrefixes = [], tainted = false } = {},
) {
  const policy = new ToolPermissionPolicy({ permissionMode });
  const meta = WORKSPACE_TOOL_META[toolName] ?? {
    readOnly: false,
    effectClass: toolName.startsWith('mcp__') ? 'external_network' : 'irreversible_side_effect',
    outward: toolName.startsWith('mcp__'),
    requiresCommandCheck: toolName === 'bash' || toolName === 'start_process',
  };
  const verdict = policy.evaluate(
    {
      name: toolName,
      meta: {
        ...meta,
        requiresCommandCheck: toolName === 'bash' || toolName === 'start_process',
      },
    },
    args ?? {},
    { approvedPrefixes, tainted, permissionMode },
  );
  return verdict.decision !== 'allow';
}

export function createWorkspaceTools({
  workspaceRoot,
  dataRoot = null,
  store,
  sessionId = null,
  permissionMode = 'auto-safe',
  nonce = '',
  getLivePolicy = null,
  getApprovedPrefixes = () => [],
  readFileState = new Map(),
  processManager = null,
  sandbox = null,
  mcpTools = [],
  requestApproval = null,
  approvalManager = null,
  onBeforeMutate = () => {},
  onFileChanged = () => {},
  onHookConfigMutated = null,
  onToolOutput = () => {},
  onPlanUpdated = () => {},
  runSubagent = null,
  orchestrateSwarm = null,
  sendAgentMessage = null,
  signal = undefined,
}) {
  const permits = new ExecutePermitRegistry();
  const permitOwner = Object.freeze({ workspaceRoot });
  const bgProcs = processManager ?? new BackgroundProcessManager();
  const hostSandbox = sandbox ?? new HostSandboxAdapter();
  const processor = new ToolResultProcessor({ store, nonce });
  let seq = 0;

  const wrapResult = (name, rawText) => processor.normalize(name, rawText, { wrap: true });

  // Fallback gate & one-shot permit when tool.execute() is called directly outside ToolDispatcher.
  // Never trusts a spoofable boolean flag (`ctx.permitConsumed`); only skips if verified by an
  // authentic one-shot WeakSet permit proof emitted by ExecutePermitRegistry.consume().
  const fallbackPolicy = new ToolPermissionPolicy({ permissionMode });
  const guardFallback = async (toolName, args, ctx) => {
    if (ctx?.permitProof && verifyAndClearPermitProof(ctx.permitProof)) return;
    (ctx?.signal ?? signal)?.throwIfAborted?.();

    const livePolicy =
      typeof getLivePolicy === 'function'
        ? getLivePolicy({ sessionId, toolName })
        : null;
    const livePermissionMode = livePolicy?.permissionMode ?? permissionMode;
    const liveAllowTools = livePolicy && 'allowTools' in livePolicy ? livePolicy.allowTools : undefined;
    const liveDenyTools = livePolicy && 'denyTools' in livePolicy ? livePolicy.denyTools : undefined;
    const livePrefixes =
      typeof getApprovedPrefixes === 'function'
        ? getApprovedPrefixes()
        : livePolicy?.approvedPrefixes ?? [];
    const meta = WORKSPACE_TOOL_META[toolName] ?? {
      readOnly: false,
      effectClass: toolName.startsWith('mcp__') ? 'external_network' : 'irreversible_side_effect',
      outward: toolName.startsWith('mcp__'),
      requiresCommandCheck: toolName === 'bash' || toolName === 'start_process',
    };
    const verdict = fallbackPolicy.evaluate(
      {
        name: toolName,
        meta: {
          ...meta,
          requiresCommandCheck: toolName === 'bash' || toolName === 'start_process',
        },
      },
      args ?? {},
      {
        approvedPrefixes: livePrefixes,
        tainted: Boolean(ctx?.tainted),
        permissionMode: livePermissionMode,
        allowTools: liveAllowTools,
        denyTools: liveDenyTools,
      },
    );

    if (verdict.decision === 'deny') {
      throw new PolicyError('POLICY_DENIED', {
        message: `安全策略拦截：${verdict.reason}`,
      });
    }

    const argsDigest = computeArgsDigest(toolName, args ?? {});
    let approvalId = null;
    if (verdict.decision === 'ask') {
      if (typeof requestApproval !== 'function') {
        throw new Error(`安全拒绝：工具 ${toolName} 需要人工审批，但审批服务不可用`);
      }
      const prefix =
        toolName === 'bash' || toolName === 'start_process'
          ? canonicalizeCommandPrefix(args?.command)
          : null;
      const decision = await requestApproval({
        tool: toolName,
        arguments: { ...args, ...(prefix ? { commandPrefix: prefix } : {}) },
        callId: ctx?.callId,
        argsDigest,
        signal: ctx?.signal ?? signal,
      });
      (ctx?.signal ?? signal)?.throwIfAborted?.();
      const allowed =
        typeof decision === 'object' && decision !== null
          ? decision.allowed === true
          : decision === true;
      if (!allowed) throw new Error(`用户拒绝了 ${toolName} 操作`);
      if (
        typeof decision === 'object' &&
        decision !== null &&
        decision.argsDigest !== undefined &&
        decision.argsDigest !== argsDigest
      ) {
        throw new PolicyError('APPROVAL_ARGS_MISMATCH', {
          message: `安全阻断：实际执行参数摘要与审批签发摘要不一致 (${toolName})`,
        });
      }
      approvalId =
        (typeof decision === 'object' && decision?.approvalId) ||
        `approved-${ctx?.callId || ++seq}`;
      if (approvalManager && typeof approvalManager.consumeApproval === 'function') {
        const consumed = approvalManager.consumeApproval(approvalId, {
          expectedArgsDigest: argsDigest,
          sessionId,
          turnId: ctx?.turnId,
        });
        if (!consumed?.ok) {
          throw new PolicyError(consumed?.code || 'APPROVAL_REVOKED', {
            message: consumed?.reason || `Approval is no longer valid for ${toolName}`,
          });
        }
      }
    }
    const effectId = `${toolName}-${ctx?.callId || 'local'}-${++seq}`;
    const binding = {
      owner: permitOwner,
      effectId,
      evidenceId: `ev-${effectId}`,
      approvalId,
      callId: ctx?.callId ?? null,
      argsDigest,
      attempt: 1,
    };
    const permit = permits.issue(binding);
    await dispatchWithPermit(permit, binding, permits, async () => true);
    verifyAndClearPermitProof(permit);
  };

  const registry = new ToolRegistry();
  registry.registerMany([
    ...createFsTools({
      workspaceRoot,
      dataRoot,
      readFileState,
      wrapResult,
      guardFallback,
      onBeforeMutate,
      onFileChanged,
      onHookConfigMutated,
    }),
    ...createShellTools({
      workspaceRoot,
      bgProcs,
      sandbox: hostSandbox,
      signal,
      wrapResult,
      guardFallback,
      onToolOutput,
    }),
    ...createMetaTools({
      store,
      sessionId,
      mcpTools,
      wrapResult,
      guardFallback,
      onPlanUpdated,
      runSubagent,
      orchestrateSwarm,
      sendAgentMessage,
      signal,
    }),
  ]);

  return registry.list();
}
