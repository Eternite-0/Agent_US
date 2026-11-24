import { ExecutePermitRegistry, dispatchWithPermit } from '../permits.js';
import { guardToolOutput } from '../context.js';
import { wrapUntrusted, redactSecrets } from '../envelope.js';
import { canonicalJson, sha256Hex } from '../integrity.js';
import { scheduleToolBatch } from '../patch-and-diagnostics.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import { withTraceContext } from '../observability/trace.js';
import { ToolPermissionPolicy } from './policy.js';

export function computeArgsDigest(toolName, args) {
  return sha256Hex(canonicalJson({ tool: String(toolName || ''), args: args ?? {} }));
}

export function isParallelReadTool(tool) {
  const meta = tool?.meta;
  if (!meta?.readOnly || !meta.replayable || meta.outward || meta.effectClass !== 'read_only') return false;
  try {
    return typeof tool.isConcurrencySafe !== 'function' || tool.isConcurrencySafe() === true;
  } catch {
    return false;
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key], seen);
  }
  return Object.freeze(value);
}

/**
 * Normalizes tool output with numeric-line folding, artifact:// spill pointers,
 * and nonce-tagged <untrusted> boundary wrapping.
 */
export class ToolResultProcessor {
  constructor({ store = null, nonce = '', maxChars = 16384, maxLines = 1000 } = {}) {
    this.store = store;
    this.nonce = nonce;
    this.maxChars = maxChars;
    this.maxLines = maxLines;
    this.seq = 0;
  }

  normalize(toolName, rawOutput, { wrap = true } = {}) {
    const guarded = guardToolOutput(toolName, String(rawOutput ?? ''), this.store, {
      maxChars: this.maxChars,
      maxLines: this.maxLines,
    });
    if (!wrap || !this.nonce) return guarded;
    return wrapUntrusted(this.nonce, `tool-${toolName}-${++this.seq}`, guarded);
  }
}

/**
 * Layer 4 Unified Fail-Closed ToolDispatcher.
 * Enforces Zod validation (+ re-validation after Transform hooks), Security/Transform/Observation
 * hooks, mandatory ToolPermissionPolicy evaluation, Fail-Closed approval gating with
 * cryptographic argsDigest + approvalId + ExecutePermit binding, and consistent tool_receipts.
 */
export class ToolDispatcher {
  #effectSeq = 0;

  constructor({
    store = null,
    eventRouter = null,
    reconciler = null,
    policy = null,
    permits = null,
    approvalManager = null,
    getLivePolicy = null,
    reviewApproval = null,
  } = {}) {
    this.store = store;
    this.eventRouter = eventRouter;
    this.reconciler = reconciler;
    this.policy = policy ?? new ToolPermissionPolicy({ permissionMode: 'approval' });
    this.permits = permits ?? new ExecutePermitRegistry();
    this.approvalManager = approvalManager ?? null;
    this.getLivePolicy = typeof getLivePolicy === 'function' ? getLivePolicy : null;
    this.reviewApproval = typeof reviewApproval === 'function' ? reviewApproval : null;
  }

  #safeEmit(payload) {
    try {
      this.eventRouter?.emitPersisted?.(payload);
    } catch {
      // Isolate SSE listener errors so tool dispatch & DB commits are never aborted
    }
  }

  #recordPreEffectRejection({
    sessionId,
    turnId,
    callId,
    toolName,
    meta,
    args,
    approvedArgsDigest = null,
    hookDigest = null,
    errorCode,
    startedAt,
    leaseGuard = null,
  }) {
    if (!this.reconciler || !sessionId || !turnId) return null;
    const rej = this.reconciler.recordReceiptStart({
      sessionId,
      turnId,
      callId,
      toolName,
      riskLevel: meta?.riskLevel ?? 'medium',
      effectClass: meta?.effectClass ?? 'irreversible_side_effect',
      replayable: Boolean(meta?.replayable),
      outward: Boolean(meta?.outward),
      args,
      approvedArgsDigest,
      hookDigest,
      leaseGuard,
    });
    return this.reconciler.recordReceiptFinish(rej.id, {
      status: 'rejected_before_effect',
      errorCode,
      durationMs: Date.now() - startedAt,
      leaseGuard,
    });
  }

  async dispatchBatch({
    sessionId,
    turnId,
    toolCalls,
    tools,
    hooks = null,
    argStrikes = new Map(),
    signal,
    leaseGuard = null,
    parentGuard = null,
    verifierEvents = [],
    permissionMode = null,
    allowTools = undefined,
    denyTools = undefined,
    getApprovedPrefixes = () => [],
    requestApproval = null,
    approvalManager = null,
    getLivePolicy = null,
    tainted = false,
    emitCallEvent = true,
  }) {
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    const owner = Object.freeze({ sessionId: sessionId || 'kernel', turnId: turnId || 'turn' });

    return scheduleToolBatch(
      toolCalls,
      (tc) => isParallelReadTool(toolMap.get(tc.name)),
      (tc) =>
        this.#dispatchOne({
          tc,
          toolMap,
          owner,
          sessionId,
          turnId,
          hooks,
          argStrikes,
          signal,
          leaseGuard,
          parentGuard,
          verifierEvents,
          permissionMode,
          allowTools,
          denyTools,
          getApprovedPrefixes,
          requestApproval,
          approvalManager,
          getLivePolicy,
          tainted,
          emitCallEvent,
        }),
    );
  }

  async #dispatchOne({
    tc,
    toolMap,
    owner,
    sessionId,
    turnId,
    hooks,
    argStrikes,
    signal,
    leaseGuard,
    parentGuard,
    verifierEvents,
    permissionMode,
    allowTools,
    denyTools,
    getApprovedPrefixes,
    requestApproval,
    approvalManager,
    getLivePolicy,
    tainted,
    emitCallEvent,
  }) {
    const tStart = Date.now();
    signal?.throwIfAborted?.();
    leaseGuard?.();
    parentGuard?.();

    const effApprovalManager = approvalManager ?? this.approvalManager;
    const effGetLivePolicy =
      typeof getLivePolicy === 'function' ? getLivePolicy : this.getLivePolicy;
    const readLivePolicy = () => {
      const live =
        typeof effGetLivePolicy === 'function'
          ? effGetLivePolicy({ sessionId, turnId, toolName: tc.name })
          : null;
      return {
        permissionMode: live?.permissionMode ?? permissionMode ?? this.policy.permissionMode,
        allowTools: live && 'allowTools' in live ? live.allowTools : allowTools,
        denyTools: live && 'denyTools' in live ? live.denyTools : denyTools,
      };
    };

    const toolImpl = toolMap.get(tc.name);
    let parsedArgs = null;
    let parseErr = null;
    try {
      parsedArgs =
        typeof tc.arguments === 'string'
          ? tc.arguments
            ? JSON.parse(tc.arguments)
            : {}
          : tc.arguments ?? {};
    } catch (err) {
      parseErr = String(err?.message ?? err);
    }

    if (emitCallEvent && this.eventRouter && sessionId) {
      this.#safeEmit({
        sessionId,
        turnId,
        type: RUNTIME_EVENTS.TOOL_CALL,
        data: {
          turnId,
          sessionId,
          callId: tc.id,
          name: tc.name,
          arguments: parsedArgs ?? tc.arguments,
        },
        audit: false,
      });
    }
    verifierEvents.push({
      type: 'tool/call',
      data: { callId: tc.id, name: tc.name, arguments: parsedArgs ?? tc.arguments },
    });

    if (!toolImpl) {
      const liveInit = readLivePolicy();
      const deniedByAllowlist =
        (Array.isArray(liveInit.allowTools) && !liveInit.allowTools.includes(tc.name)) ||
        (Array.isArray(liveInit.denyTools) && liveInit.denyTools.includes(tc.name));
      if (deniedByAllowlist) {
        const receipt = this.#recordPreEffectRejection({
          sessionId,
          turnId,
          callId: tc.id,
          toolName: tc.name,
          meta: { riskLevel: 'medium', effectClass: 'irreversible_side_effect', replayable: false, outward: false },
          args: parsedArgs ?? {},
          errorCode: 'POLICY_DENIED',
          startedAt: tStart,
          leaseGuard,
        });
        return {
          tc,
          parsedArgs,
          output: `安全策略拦截：工具「${tc.name}」不在允许的 allowlist 中`,
          isError: true,
          durationMs: Date.now() - tStart,
          receipt,
        };
      }
      return {
        tc,
        parsedArgs,
        output: `错误：未知工具「${tc.name}」。可用工具：${[...toolMap.keys()].join(', ')}`,
        isError: true,
        durationMs: Date.now() - tStart,
        receipt: null,
      };
    }

    const meta = toolImpl.meta ?? {
      readOnly: false,
      effectClass: 'irreversible_side_effect',
      riskLevel: 'high',
      replayable: false,
      outward: false,
    };

    if (parseErr) {
      const strikes = (argStrikes.get(tc.name) ?? 0) + 1;
      argStrikes.set(tc.name, strikes);
      const receipt = this.#recordPreEffectRejection({
        sessionId,
        turnId,
        callId: tc.id,
        toolName: tc.name,
        meta,
        args: { raw: tc.arguments },
        errorCode: 'INVALID_ARGUMENTS_JSON',
        startedAt: tStart,
        leaseGuard,
      });
      return {
        tc,
        parsedArgs,
        output:
          strikes <= 2
            ? `参数 JSON 解析失败 (${parseErr})。请输出合法的 JSON 参数并重试工具 ${tc.name}。`
            : `参数连续多次格式错误，终止该工具调用。`,
        isError: true,
        durationMs: Date.now() - tStart,
        receipt,
      };
    }

    // 1. Zod schema pre-validation
    if (typeof toolImpl.validate === 'function') {
      const check = toolImpl.validate(parsedArgs);
      if (!check.success) {
        const strikes = (argStrikes.get(tc.name) ?? 0) + 1;
        argStrikes.set(tc.name, strikes);
        const issues = check.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ');
        const receipt = this.#recordPreEffectRejection({
          sessionId,
          turnId,
          callId: tc.id,
          toolName: tc.name,
          meta,
          args: parsedArgs,
          errorCode: 'INVALID_ARGUMENTS',
          startedAt: tStart,
          leaseGuard,
        });
        return {
          tc,
          parsedArgs,
          output:
            strikes < 2
              ? `参数校验失败 (${issues})。请修正参数并重试 ${tc.name}。`
              : `工具 ${tc.name} 连续参数校验失败，本轮停用。`,
          isError: true,
          durationMs: Date.now() - tStart,
          receipt,
        };
      }
      parsedArgs = check.data;
    }

    // 2. PreToolUse Hook (Security / Transform hooks MUST fail-closed on exception or non-zero exit)
    const prePolicy = readLivePolicy();
    const effectivePermMode = prePolicy.permissionMode;
    let preHook = { blocked: false, updatedInput: null, transformApplied: false, additionalContexts: [] };
    if (hooks) {
      try {
        preHook = await hooks.run(
          'PreToolUse',
          {
            sessionId,
            turnId,
            tool: tc.name,
            arguments: parsedArgs,
          },
          { signal, permissionMode: effectivePermMode },
        );
      } catch (hookErr) {
        if (signal?.aborted || hookErr?.name === 'AbortError' || hookErr?.category === 'cancellation') {
          throw hookErr;
        }
        const receipt = this.#recordPreEffectRejection({
          sessionId,
          turnId,
          callId: tc.id,
          toolName: tc.name,
          meta,
          args: parsedArgs,
          errorCode: 'SECURITY_HOOK_ERROR',
          startedAt: tStart,
          leaseGuard,
        });
        return {
          tc,
          parsedArgs,
          output: `PreToolUse 安全 Hook 执行异常（Fail-Closed 阻断）：${String(hookErr?.message ?? hookErr)}`,
          isError: true,
          durationMs: Date.now() - tStart,
          receipt,
        };
      }
    }

    if (preHook.blocked) {
      const receipt = this.#recordPreEffectRejection({
        sessionId,
        turnId,
        callId: tc.id,
        toolName: tc.name,
        meta,
        args: parsedArgs,
        errorCode: 'SECURITY_HOOK_BLOCKED',
        startedAt: tStart,
        leaseGuard,
      });
      return {
        tc,
        parsedArgs,
        output: `PreToolUse Hook 拦截：${preHook.reason}`,
        isError: true,
        durationMs: Date.now() - tStart,
        receipt,
      };
    }

    let effectiveArgs = preHook.transformApplied && preHook.updatedInput ? preHook.updatedInput : parsedArgs;

    // Re-validate schema after Transform hook modifies inputs
    if (preHook.transformApplied && typeof toolImpl.validate === 'function') {
      const recheck = toolImpl.validate(effectiveArgs);
      if (!recheck.success) {
        const issues = recheck.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ');
        const receipt = this.#recordPreEffectRejection({
          sessionId,
          turnId,
          callId: tc.id,
          toolName: tc.name,
          meta,
          args: effectiveArgs,
          hookDigest: computeArgsDigest(tc.name, effectiveArgs),
          errorCode: 'HOOK_TRANSFORM_INVALID_ARGS',
          startedAt: tStart,
          leaseGuard,
        });
        return {
          tc,
          parsedArgs: effectiveArgs,
          output: `Hook 参数变换后校验失败（Fail-Closed 阻断）：${issues}`,
          isError: true,
          durationMs: Date.now() - tStart,
          receipt,
        };
      }
      effectiveArgs = recheck.data;
    }

    // Compute hookDigest AFTER Zod recheck.data so digest matches final normalized execution args
    const hookDigest = preHook.transformApplied
      ? computeArgsDigest(tc.name, effectiveArgs)
      : null;

    // 3. Re-check cancellation & compute canonical digest after final arg transforms
    signal?.throwIfAborted?.();
    leaseGuard?.();
    parentGuard?.();
    const finalArgsDigest = computeArgsDigest(tc.name, effectiveArgs);

    // 4. The hard policy remains authoritative. A reviewer can satisfy only
    // discretionary asks that the existing safe policy would already allow.
    const evaluate = (live, mode = live.permissionMode, approvedPrefixes = getApprovedPrefixes()) =>
      this.policy.evaluate(toolImpl, effectiveArgs, {
        approvedPrefixes,
        tainted,
        permissionMode: mode,
        allowTools: live.allowTools,
        denyTools: live.denyTools,
      });
    const curPolicy = readLivePolicy();
    let policyVerdict = evaluate(curPolicy);
    let autoReview = null;
    let reviewedApproval = false;
    if (policyVerdict.decision === 'ask' && curPolicy.permissionMode === 'auto-review' &&
        this.reviewApproval && !tainted && !meta.outward &&
        evaluate(curPolicy, 'auto-safe', []).decision === 'allow') {
      try {
        autoReview = await this.reviewApproval({
          tool: tc.name,
          args: { command: effectiveArgs.command, cwd: effectiveArgs.cwd },
          signal,
        });
      } catch {
        autoReview = { allow: false, source: 'unavailable' };
      }
      signal?.throwIfAborted?.();
      leaseGuard?.();
      parentGuard?.();
      const live = readLivePolicy();
      policyVerdict = evaluate(live);
      reviewedApproval = autoReview?.allow === true && live.permissionMode === 'auto-review' &&
        policyVerdict.decision === 'ask' && evaluate(live, 'auto-safe', []).decision === 'allow' &&
        computeArgsDigest(tc.name, effectiveArgs) === finalArgsDigest;
    }

    if (policyVerdict.decision === 'deny') {
      const receipt = this.#recordPreEffectRejection({
        sessionId,
        turnId,
        callId: tc.id,
        toolName: tc.name,
        meta,
        args: effectiveArgs,
        hookDigest,
        errorCode: 'POLICY_DENIED',
        startedAt: tStart,
        leaseGuard,
      });
      return {
        tc,
        parsedArgs: effectiveArgs,
        output: `安全策略拦截：${policyVerdict.reason}`,
        isError: true,
        durationMs: Date.now() - tStart,
        receipt,
      };
    }

    let approvalId = null;
    let approvedArgsDigest = null;
    if (autoReview && !reviewedApproval) {
      this.#safeEmit({ sessionId, turnId, type: RUNTIME_EVENTS.TOOL_APPROVAL_REVIEWED,
        data: { callId: tc.id, tool: tc.name, source: autoReview.source, decision: 'deferred' } });
    }
    if (policyVerdict.decision === 'ask' && !reviewedApproval) {
      if (typeof requestApproval !== 'function') {
        const receipt = this.#recordPreEffectRejection({
          sessionId,
          turnId,
          callId: tc.id,
          toolName: tc.name,
          meta,
          args: effectiveArgs,
          hookDigest,
          errorCode: 'APPROVAL_SERVICE_UNAVAILABLE',
          startedAt: tStart,
          leaseGuard,
        });
        return {
          tc,
          parsedArgs: effectiveArgs,
          output: `安全阻断：工具 ${tc.name} 需要人工审批，但未注入审批服务（Fail-Closed）`,
          isError: true,
          durationMs: Date.now() - tStart,
          receipt,
        };
      }

      let decisionRes;
      try {
        decisionRes = await requestApproval({
          tool: tc.name,
          arguments: {
            ...effectiveArgs,
            ...(policyVerdict.commandPrefix ? { commandPrefix: policyVerdict.commandPrefix } : {}),
          },
          callId: tc.id,
          riskLevel: meta.riskLevel,
          effectClass: meta.effectClass,
          argsDigest: finalArgsDigest,
          signal,
        });
      } catch (apprErr) {
        if (signal?.aborted) throw apprErr;
        const receipt = this.#recordPreEffectRejection({
          sessionId,
          turnId,
          callId: tc.id,
          toolName: tc.name,
          meta,
          args: effectiveArgs,
          hookDigest,
          errorCode: 'APPROVAL_ERROR',
          startedAt: tStart,
          leaseGuard,
        });
        return {
          tc,
          parsedArgs: effectiveArgs,
          output: `审批请求异常，拒绝执行（Fail-Closed）：${String(apprErr?.message ?? apprErr)}`,
          isError: true,
          durationMs: Date.now() - tStart,
          receipt,
        };
      }

      signal?.throwIfAborted?.();
      leaseGuard?.();
      parentGuard?.();

      const allowed =
        typeof decisionRes === 'object' && decisionRes !== null
          ? decisionRes.allowed === true
          : decisionRes === true;
      if (!allowed) {
        const reasonTag =
          typeof decisionRes === 'object' && decisionRes?.revoked
            ? 'APPROVAL_REVOKED'
            : typeof decisionRes === 'object' && decisionRes?.reason === 'timeout'
              ? 'APPROVAL_TIMEOUT'
              : 'APPROVAL_DENIED';
        const receipt = this.#recordPreEffectRejection({
          sessionId,
          turnId,
          callId: tc.id,
          toolName: tc.name,
          meta,
          args: effectiveArgs,
          hookDigest,
          errorCode: reasonTag,
          startedAt: tStart,
          leaseGuard,
        });
        return {
          tc,
          parsedArgs: effectiveArgs,
          output:
            reasonTag === 'APPROVAL_TIMEOUT'
              ? `审批超时，拒绝执行 ${tc.name} 操作`
              : reasonTag === 'APPROVAL_REVOKED'
                ? `审批已被撤销，拒绝执行 ${tc.name} 操作`
                : `用户拒绝了 ${tc.name} 操作`,
          isError: true,
          durationMs: Date.now() - tStart,
          receipt,
        };
      }

      // 4a. Strict non-null argsDigest verification (prevents null-bypass & nested arg mutation TOCTOU)
      const returnedDigest =
        typeof decisionRes === 'object' &&
        decisionRes !== null &&
        typeof decisionRes.argsDigest === 'string' &&
        decisionRes.argsDigest.trim().length > 0
          ? decisionRes.argsDigest.trim()
          : null;
      const postDigest = computeArgsDigest(tc.name, effectiveArgs);
      if (!returnedDigest || returnedDigest !== finalArgsDigest || postDigest !== finalArgsDigest) {
        const receipt = this.#recordPreEffectRejection({
          sessionId,
          turnId,
          callId: tc.id,
          toolName: tc.name,
          meta,
          args: effectiveArgs,
          approvedArgsDigest: returnedDigest,
          hookDigest,
          errorCode: 'APPROVAL_ARGS_MISMATCH',
          startedAt: tStart,
          leaseGuard,
        });
        return {
          tc,
          parsedArgs: effectiveArgs,
          output: `安全阻断：实际执行参数摘要与审批签发摘要不一致，拒绝执行 ${tc.name}`,
          isError: true,
          durationMs: Date.now() - tStart,
          receipt,
        };
      }

      // 4b. Re-read live policy & re-evaluate policy after approval wait (catches mid-wait tightening!)
      const postPolicy = readLivePolicy();
      const postVerdict = this.policy.evaluate(toolImpl, effectiveArgs, {
        approvedPrefixes: getApprovedPrefixes(),
        tainted,
        permissionMode: postPolicy.permissionMode,
        allowTools: postPolicy.allowTools,
        denyTools: postPolicy.denyTools,
      });
      if (postVerdict.decision === 'deny') {
        const receipt = this.#recordPreEffectRejection({
          sessionId,
          turnId,
          callId: tc.id,
          toolName: tc.name,
          meta,
          args: effectiveArgs,
          approvedArgsDigest: returnedDigest,
          hookDigest,
          errorCode: 'POLICY_TIGHTENED_DENIED',
          startedAt: tStart,
          leaseGuard,
        });
        return {
          tc,
          parsedArgs: effectiveArgs,
          output: `安全阻断：审批后策略已收紧，拒绝执行 ${tc.name} (${postVerdict.reason})`,
          isError: true,
          durationMs: Date.now() - tStart,
          receipt,
        };
      }

      approvalId =
        (typeof decisionRes === 'object' && decisionRes?.approvalId) ||
        `approved-${tc.id}`;
      approvedArgsDigest = finalArgsDigest;

      // 4c. Atomic DB single-use approval consumption (blocks revoked/expired/replayed approvals)
      if (effApprovalManager && typeof effApprovalManager.consumeApproval === 'function') {
        const consumed = effApprovalManager.consumeApproval(approvalId, {
          expectedArgsDigest: finalArgsDigest,
          sessionId,
          turnId,
        });
        if (!consumed?.ok) {
          const receipt = this.#recordPreEffectRejection({
            sessionId,
            turnId,
            callId: tc.id,
            toolName: tc.name,
            meta,
            args: effectiveArgs,
            approvedArgsDigest: returnedDigest,
            hookDigest,
            errorCode: consumed?.code || 'APPROVAL_REVOKED',
            startedAt: tStart,
            leaseGuard,
          });
          return {
            tc,
            parsedArgs: effectiveArgs,
            output: `安全阻断：审批无效、已消费或已被撤销 (${consumed?.code || 'APPROVAL_REVOKED'}: ${consumed?.reason || ''})`,
            isError: true,
            durationMs: Date.now() - tStart,
            receipt,
          };
        }
      } else if (this.permits.isApprovalUsed?.(approvalId)) {
        const receipt = this.#recordPreEffectRejection({
          sessionId,
          turnId,
          callId: tc.id,
          toolName: tc.name,
          meta,
          args: effectiveArgs,
          approvedArgsDigest: returnedDigest,
          hookDigest,
          errorCode: 'APPROVAL_ALREADY_CONSUMED',
          startedAt: tStart,
          leaseGuard,
        });
        return {
          tc,
          parsedArgs: effectiveArgs,
          output: `安全阻断：审批凭证 ${approvalId} 已被消费，禁止重放执行 ${tc.name}`,
          isError: true,
          durationMs: Date.now() - tStart,
          receipt,
        };
      }
    }

    // Freeze effectiveArgs deeply so nothing can mutate parameters between verification and execute()
    deepFreeze(effectiveArgs);

    // Final abort/fence/parent check immediately before issuing permit & persisting executing receipt
    signal?.throwIfAborted?.();
    leaseGuard?.();
    parentGuard?.();

    const effectId = `${turnId || 'turn'}:${tc.name}:${tc.id}:${Date.now()}:${++this.#effectSeq}`;
    let receipt = null;
    if (this.reconciler && sessionId && turnId) {
      receipt = this.reconciler.recordReceiptStart({
        sessionId,
        turnId,
        callId: tc.id,
        toolName: tc.name,
        riskLevel: meta.riskLevel,
        effectClass: meta.effectClass,
        replayable: meta.replayable,
        outward: meta.outward,
        args: effectiveArgs,
        approvalId,
        permitEffectId: effectId,
        approvedArgsDigest,
        hookDigest,
        leaseGuard,
      });
    }

    const binding = {
      owner,
      effectId,
      approvalId,
      evidenceId: receipt?.id ?? effectId,
      callId: tc.id ?? null,
      argsDigest: finalArgsDigest,
      attempt: 1,
    };
    const permit = this.permits.issue(binding);

    if (reviewedApproval) {
      this.#safeEmit({ sessionId, turnId, type: RUNTIME_EVENTS.TOOL_APPROVAL_REVIEWED,
        data: { callId: tc.id, tool: tc.name, source: autoReview.source, decision: 'allow', argsDigest: finalArgsDigest } });
    }

    let output = '';
    let isError = false;
    let execErr = null;
    let outcome = null;
    try {
      output = String(
        (await withTraceContext({ toolCallId: tc.id, sessionId, turnId }, () =>
          dispatchWithPermit(permit, binding, this.permits, () =>
            toolImpl.execute(effectiveArgs, {
              callId: tc.id,
              signal,
              sessionId,
              turnId,
              tainted,
              approvalId,
              permitProof: permit,
              // Only registered implementations can report facts here; payload text
              // (including shell stdout and MCP content) is never parsed as status.
              reportOutcome: (facts) => { outcome = { ...facts }; },
            }),
          ),
        )) ?? '',
      );
    } catch (err) {
      isError = true;
      execErr = err;
      output = `执行失败：${String(err?.message ?? err)}`;
    }

    const parsedExit = Number.isInteger(outcome?.exitCode) ? outcome.exitCode : null;
    const abortedMidFlight = Boolean(signal?.aborted || execErr?.name === 'AbortError');
    const unknown = (abortedMidFlight || outcome?.outcomeUnknown === true) &&
      (!meta.replayable || meta.outward);
    isError ||= abortedMidFlight || unknown || Boolean(outcome?.errorCode) ||
      (parsedExit !== null && parsedExit !== 0);
    const finalStatus = unknown ? 'outcome_unknown' : isError ? 'failed' : 'finished';
    const finalExitCode = unknown ? null : parsedExit ?? (isError ? 1 : 0);
    const errorCode = unknown
      ? outcome?.errorCode ?? 'INTERRUPTED_UNKNOWN_OUTCOME'
      : isError
        ? outcome?.errorCode ?? (parsedExit !== null && parsedExit !== 0 ? 'NON_ZERO_EXIT' : 'TOOL_EXECUTION_ERROR')
        : null;
    if (outcome && errorCode) {
      output = `[${errorCode}]${unknown ? ' 执行结果未知；需先核对，不要自动重试。' : ''}\n${output}`;
    }

    if (receipt && this.reconciler) {
      receipt = this.reconciler.recordReceiptFinish(receipt.id, {
        status: finalStatus,
        output: redactSecrets(output),
        exitCode: finalExitCode,
        durationMs: Date.now() - tStart,
        errorCode,
        leaseGuard,
      });
      this.#safeEmit({
        sessionId,
        turnId,
        type: RUNTIME_EVENTS.TOOL_RECEIPT,
        data: {
          receiptId: receipt.id,
          callId: tc.id,
          toolName: tc.name,
          effectClass: meta.effectClass,
          riskLevel: meta.riskLevel,
          replayable: meta.replayable,
          outward: meta.outward,
          status: receipt.status,
          exitCode: finalExitCode,
        },
        audit: false,
      });
    }

    if (hooks && !signal?.aborted) {
      const postHook = await hooks
        .run(
          'PostToolUse',
          {
            sessionId,
            turnId,
            tool: tc.name,
            arguments: effectiveArgs,
            isError,
            output: output.slice(0, 4000),
          },
          { signal, permissionMode: readLivePolicy().permissionMode },
        )
        .catch(() => ({ additionalContexts: [], warnings: [] }));
      if (postHook.additionalContexts?.length) {
        output += `\n[PostToolUse Hook]\n${postHook.additionalContexts.join('\n')}`;
      }
    }

    return {
      tc,
      parsedArgs: effectiveArgs,
      output,
      isError,
      pending: !isError && outcome?.pending === true,
      durationMs: Date.now() - tStart,
      receipt,
    };
  }
}
