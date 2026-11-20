import { ExecutePermitRegistry, dispatchWithPermit } from '../permits.js';
import { guardToolOutput } from '../context.js';
import { wrapUntrusted, redactSecrets } from '../envelope.js';
import { scheduleToolBatch } from '../patch-and-diagnostics.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';

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
 * Layer 4 Unified ToolDispatcher.
 * Enforces Zod input validation + 2-strike recovery, Pre/Post hooks, ToolPermissionPolicy,
 * human approval gate, durable tool_receipts, and WeakMap one-shot ExecutePermitRegistry.
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
    this.policy = policy;
    this.permits = permits ?? new ExecutePermitRegistry();
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
    verifierEvents = [],
    permissionMode = null,
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
      async (tc) => {
        signal?.throwIfAborted?.();
        leaseGuard?.();
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

        const tStart = Date.now();
        let output = '';
        let isError = false;
        let receipt = null;

        if (!toolImpl) {
          isError = true;
          output = `错误：未知工具「${tc.name}」。可用工具：${[...toolMap.keys()].join(', ')}`;
        } else if (parseErr) {
          const strikes = (argStrikes.get(tc.name) ?? 0) + 1;
          argStrikes.set(tc.name, strikes);
          isError = true;
          output =
            strikes <= 2
              ? `参数 JSON 解析失败 (${parseErr})。请输出合法的 JSON 参数并重试工具 ${tc.name}。`
              : `参数连续多次格式错误，终止该工具调用。`;
        } else {
          // 1. Zod schema validation (when defined on tool)
          if (typeof toolImpl.validate === 'function') {
            const check = toolImpl.validate(parsedArgs);
            if (!check.success) {
              const strikes = (argStrikes.get(tc.name) ?? 0) + 1;
              argStrikes.set(tc.name, strikes);
              isError = true;
              const issues = check.error.issues
                .slice(0, 5)
                .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
                .join('; ');
              if (this.reconciler && sessionId && turnId) {
                const rej = this.reconciler.recordReceiptStart({
                  sessionId,
                  turnId,
                  callId: tc.id,
                  toolName: tc.name,
                  riskLevel: toolImpl.meta?.riskLevel ?? 'low',
                  effectClass: toolImpl.meta?.effectClass ?? 'read_only',
                  replayable: true,
                  outward: false,
                  args: parsedArgs,
                });
                this.reconciler.recordReceiptFinish(rej.id, {
                  status: 'rejected_before_effect',
                  errorCode: 'INVALID_ARGUMENTS',
                  durationMs: Date.now() - tStart,
                });
              }
              output =
                strikes < 2
                  ? `参数校验失败 (${issues})。请修正参数并重试 ${tc.name}。`
                  : `工具 ${tc.name} 连续参数校验失败，本轮停用。`;
              return { tc, parsedArgs, output, isError, durationMs: Date.now() - tStart, receipt: null };
            }
            parsedArgs = check.data;
          }

          // 2. PreToolUse Hook
          const preHook = hooks
            ? await hooks
                .run('PreToolUse', {
                  sessionId,
                  turnId,
                  tool: tc.name,
                  arguments: parsedArgs,
                })
                .catch(() => ({ blocked: false, updatedInput: null, additionalContexts: [] }))
            : { blocked: false, updatedInput: null, additionalContexts: [] };

          if (preHook.blocked) {
            isError = true;
            output = `PreToolUse Hook 拦截：${preHook.reason}`;
          } else {
            const effectiveArgs = preHook.updatedInput ?? parsedArgs;
            const meta = toolImpl.meta ?? {
              readOnly: false,
              effectClass: 'irreversible_side_effect',
              riskLevel: 'high',
              replayable: false,
              outward: false,
            };

            // 3. ToolPermissionPolicy + Human Approval Gate (skip if tool implements its own internal gate or use central policy when provided)
            let approvalId = null;
            if (this.policy) {
              const policyVerdict = this.policy.evaluate(toolImpl, effectiveArgs, {
                approvedPrefixes: getApprovedPrefixes(),
                tainted,
                permissionMode: permissionMode ?? this.policy.permissionMode,
              });
              if (policyVerdict.decision === 'deny') {
                let rejReceipt = null;
                if (this.reconciler && sessionId && turnId) {
                  const rej = this.reconciler.recordReceiptStart({
                    sessionId,
                    turnId,
                    callId: tc.id,
                    toolName: tc.name,
                    riskLevel: meta.riskLevel,
                    effectClass: meta.effectClass,
                    replayable: meta.replayable,
                    outward: meta.outward,
                    args: effectiveArgs,
                  });
                  rejReceipt = this.reconciler.recordReceiptFinish(rej.id, {
                    status: 'rejected_before_effect',
                    errorCode: 'POLICY_DENIED',
                    durationMs: Date.now() - tStart,
                  });
                }
                return {
                  tc,
                  parsedArgs: effectiveArgs,
                  output: `安全策略拦截：${policyVerdict.reason}`,
                  isError: true,
                  durationMs: Date.now() - tStart,
                  receipt: rejReceipt,
                };
              }
              if (policyVerdict.decision === 'ask' && typeof requestApproval === 'function') {
                const allowed = await requestApproval({
                  tool: tc.name,
                  arguments: {
                    ...effectiveArgs,
                    ...(policyVerdict.commandPrefix ? { commandPrefix: policyVerdict.commandPrefix } : {}),
                  },
                  callId: tc.id,
                  riskLevel: meta.riskLevel,
                  effectClass: meta.effectClass,
                });
                if (!allowed) {
                  isError = true;
                  output = `用户拒绝了 ${tc.name} 操作`;
                  return { tc, parsedArgs: effectiveArgs, output, isError, durationMs: Date.now() - tStart, receipt: null };
                }
                approvalId = `approved-${tc.id}`;
              }
            }

            // 4. Persist executing receipt + issue one-shot WeakMap permit before ANY side effect!
            const effectId = `${turnId || 'turn'}:${tc.name}:${tc.id}:${Date.now()}`;
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
              });
            }

            const binding = {
              owner,
              effectId,
              approvalId,
              evidenceId: receipt?.id ?? effectId,
              callId: tc.id ?? null,
              attempt: 1,
            };
            const permit = this.permits.issue(binding);

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
              output = `执行失败：${String(err?.message ?? err)}`;
            }

            if (receipt && this.reconciler) {
              const exitMatch = /^exitCode:\s*(-?\d+)/m.exec(output);
              const exitCode = exitMatch ? Number(exitMatch[1]) : isError ? 1 : 0;
              receipt = this.reconciler.recordReceiptFinish(receipt.id, {
                status: isError ? 'failed' : 'finished',
                output: redactSecrets(output),
                exitCode,
                durationMs: Date.now() - tStart,
                errorCode: isError ? 'TOOL_EXECUTION_ERROR' : null,
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
                  exitCode,
                },
                audit: false,
              });
            }

            // 5. PostToolUse Hook
            if (hooks) {
              const postHook = await hooks
                .run('PostToolUse', {
                  sessionId,
                  turnId,
                  tool: tc.name,
                  arguments: effectiveArgs,
                  isError,
                  output: output.slice(0, 4000),
                })
                .catch(() => ({ additionalContexts: [] }));
              if (postHook.additionalContexts?.length) {
                output += `\n[PostToolUse Hook]\n${postHook.additionalContexts.join('\n')}`;
              }
            }
          }
        }

        const durationMs = Date.now() - tStart;
        return { tc, parsedArgs, output, isError, durationMs, receipt };
      },
    );
  }
}
