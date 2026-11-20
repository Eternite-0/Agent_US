import { ExecutePermitRegistry, dispatchWithPermit } from '../permits.js';
import { guardToolOutput } from '../context.js';
import { wrapUntrusted, redactSecrets } from '../envelope.js';
import { canonicalJson, sha256Hex } from '../integrity.js';
import { scheduleToolBatch } from '../patch-and-diagnostics.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import { ToolPermissionPolicy } from './policy.js';

export function computeArgsDigest(toolName, args) {
  return sha256Hex(canonicalJson({ tool: String(toolName || ''), args: args ?? {} }));
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
  constructor({
    store = null,
    eventRouter = null,
    reconciler = null,
    policy = null,
    permits = null,
  } = {}) {
    this.store = store;
    this.eventRouter = eventRouter;
    this.reconciler = reconciler;
    this.policy = policy ?? new ToolPermissionPolicy({ permissionMode: 'approval' });
    this.permits = permits ?? new ExecutePermitRegistry();
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
    });
    return this.reconciler.recordReceiptFinish(rej.id, {
      status: 'rejected_before_effect',
      errorCode,
      durationMs: Date.now() - startedAt,
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
    tainted = false,
    emitCallEvent = true,
  }) {
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    const owner = Object.freeze({ sessionId: sessionId || 'kernel', turnId: turnId || 'turn' });

    return scheduleToolBatch(
      toolCalls,
      (tc) => {
        const impl = toolMap.get(tc.name);
        if (typeof impl?.isConcurrencySafe === 'function') {
          try {
            return impl.isConcurrencySafe() === true;
          } catch {
            return false;
          }
        }
        return Boolean(impl?.meta?.readOnly);
      },
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
    tainted,
    emitCallEvent,
  }) {
    const tStart = Date.now();
    signal?.throwIfAborted?.();
    leaseGuard?.();
    parentGuard?.();

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
      this.eventRouter.emitPersisted({
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
      const deniedByAllowlist =
        (Array.isArray(allowTools) && !allowTools.includes(tc.name)) ||
        (Array.isArray(denyTools) && denyTools.includes(tc.name));
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
    const effectivePermMode = permissionMode ?? this.policy.permissionMode;
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
    const hookDigest = preHook.transformApplied
      ? computeArgsDigest(tc.name, effectiveArgs)
      : null;

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
          hookDigest,
          errorCode: 'HOOK_TRANSFORM_INVALID_ARGS',
          startedAt: tStart,
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

    // 3. Re-check cancellation & compute canonical digest after final arg transforms
    signal?.throwIfAborted?.();
    leaseGuard?.();
    parentGuard?.();
    const finalArgsDigest = computeArgsDigest(tc.name, effectiveArgs);

    // 4. Policy Evaluation + Fail-Closed Human Approval Gate
    const policyVerdict = this.policy.evaluate(toolImpl, effectiveArgs, {
      approvedPrefixes: getApprovedPrefixes(),
      tainted,
      permissionMode: effectivePermMode,
      allowTools,
      denyTools,
    });

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
    if (policyVerdict.decision === 'ask') {
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
          typeof decisionRes === 'object' && decisionRes?.reason === 'timeout'
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
        });
        return {
          tc,
          parsedArgs: effectiveArgs,
          output:
            reasonTag === 'APPROVAL_TIMEOUT'
              ? `审批超时，拒绝执行 ${tc.name} 操作`
              : `用户拒绝了 ${tc.name} 操作`,
          isError: true,
          durationMs: Date.now() - tStart,
          receipt,
        };
      }

      const returnedDigest =
        typeof decisionRes === 'object' && decisionRes?.argsDigest ? decisionRes.argsDigest : null;
      const postDigest = computeArgsDigest(tc.name, effectiveArgs);
      if ((returnedDigest && returnedDigest !== finalArgsDigest) || postDigest !== finalArgsDigest) {
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

      approvalId =
        (typeof decisionRes === 'object' && decisionRes?.approvalId) ||
        `approved-${tc.id}`;
      approvedArgsDigest = finalArgsDigest;
    }

    // Final abort/fence/parent check immediately before issuing permit & persisting executing receipt
    signal?.throwIfAborted?.();
    leaseGuard?.();
    parentGuard?.();

    const effectId = `${turnId || 'turn'}:${tc.name}:${tc.id}:${Date.now()}`;
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

    let output = '';
    let isError = false;
    let execErr = null;
    try {
      output = String(
        (await dispatchWithPermit(permit, binding, this.permits, () =>
          toolImpl.execute(effectiveArgs, {
            callId: tc.id,
            signal,
            sessionId,
            turnId,
            permitConsumed: true,
          }),
        )) ?? '',
      );
    } catch (err) {
      isError = true;
      execErr = err;
      output = `执行失败：${String(err?.message ?? err)}`;
    }

    const unwrappedHead = output.replace(/^<untrusted\b[^>]*>/, '');
    const exitMatch = /^exitCode:\s*(-?\d+)/m.exec(unwrappedHead);
    const parsedExit = exitMatch ? Number(exitMatch[1]) : null;
    if (parsedExit !== null && parsedExit !== 0) {
      isError = true;
    }
    const abortedMidFlight = Boolean(signal?.aborted || execErr?.name === 'AbortError');
    const finalStatus =
      abortedMidFlight && (!meta.replayable || meta.outward)
        ? 'outcome_unknown'
        : isError
          ? 'failed'
          : 'finished';
    const finalExitCode = parsedExit ?? (isError ? 1 : 0);

    if (receipt && this.reconciler) {
      receipt = this.reconciler.recordReceiptFinish(receipt.id, {
        status: finalStatus,
        output: redactSecrets(output),
        exitCode: finalExitCode,
        durationMs: Date.now() - tStart,
        errorCode:
          finalStatus === 'outcome_unknown'
            ? 'INTERRUPTED_UNKNOWN_OUTCOME'
            : isError
              ? parsedExit !== null && parsedExit !== 0
                ? 'NON_ZERO_EXIT'
                : 'TOOL_EXECUTION_ERROR'
              : null,
      });
      this.eventRouter?.emitPersisted({
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
          { signal, permissionMode: effectivePermMode },
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
      durationMs: Date.now() - tStart,
      receipt,
    };
  }
}
