import { sha256Hex } from '../integrity.js';
import { excerpt } from '../context.js';
import { verifyTurn, buildRepairNote } from '../verifier.js';
import { BudgetError, RecoveryError, classifyError } from './errors.js';
import { RUNTIME_EVENTS } from './events.js';
import { TURN_PHASES, TurnStateMachine } from './state-machine.js';
import { resolveTurnOutcome } from './verdict.js';
import { checkLeaseHeld, isLeaseLostError } from '../durable/lease-guard.js';
import {
  BUDGET_SCOPES,
  estimateRequestInputTokens,
  normalizeBudgetLimit,
} from '../swarm/budget-ledger.js';

/**
 * Default DecisionEngine handles premature-stop detection, verification gate,
 * repair loop policy, and thrashing circuit-breaker checks.
 */
export class DecisionEngine {
  constructor({ judgment = null, verifier = null, maxRepairRounds = 1 } = {}) {
    this.judgment = judgment;
    this.verifier = verifier ?? verifyTurn;
    this.maxRepairRounds = maxRepairRounds;
  }

  async shouldContinueOnIdle({
    input,
    stepText,
    steps,
    maxSteps,
    stopContinuedOnce,
    repairedOnce,
    repairRound,
    verifierEvents,
    node,
    execution,
    sessionId = null,
    turnId = null,
    workspaceRoot = null,
    signal,
  }) {
    if (
      this.judgment &&
      typeof this.judgment.detectPrematureStop === 'function' &&
      !stopContinuedOnce &&
      stepText &&
      steps < maxSteps
    ) {
      const check = await this.judgment
        .detectPrematureStop({
          requestText: input,
          replyText: stepText,
          hasTools: false,
          alreadyContinued: stopContinuedOnce,
          signal,
        })
        .catch(() => null);
      if (check?.shouldContinue && check.note) {
        return {
          action: 'continue_stop',
          note: check.note,
          meta: { prob: check.prob, cached: !!check.cached },
        };
      }
    }

    if (this.verifier) {
      const verdict = await Promise.resolve(
        this.verifier({
          events: verifierEvents,
          text: stepText,
          node,
          execution,
          sessionId,
          turnId,
          workspaceRoot,
        }),
      );
      if (verdict && verdict.verdict === 'block_reconciliation') {
        return { action: 'reconcile', verdict };
      }
      if (verdict && (verdict.verdict !== 'pass' || verdict.accepted === false)) {
        if (repairRound < this.maxRepairRounds && steps < maxSteps) {
          return {
            action: 'repair',
            verdict,
            note: buildRepairNote(verdict),
          };
        }
        return { action: 'fail', verdict };
      }
      return { action: 'complete', verdict };
    }

    return { action: 'complete', verdict: null };
  }
}

/**
 * TurnManager tracks per-turn usage, steering drain, thrashing detection, and checkpoint persistence.
 */
export class TurnManager {
  constructor({
    store = null,
    eventRouter,
    checkpointStore = null,
    sessionId,
    turnId,
    leaseGuard = null,
  }) {
    this.store = store;
    this.eventRouter = eventRouter;
    this.checkpointStore = checkpointStore;
    this.sessionId = sessionId;
    this.turnId = turnId;
    this.leaseGuard = leaseGuard;
    this.totalIn = 0;
    this.totalOut = 0;
    this.totalCacheRead = 0;
    this.totalCacheWrite = 0;
    this.recentCallSigs = [];
    this.thrashWarned = false;
  }

  addUsage(usage) {
    this.totalIn += Number(usage?.inputTokens ?? 0);
    this.totalOut += Number(usage?.outputTokens ?? 0);
    this.totalCacheRead += Number(usage?.cacheReadTokens ?? 0);
    this.totalCacheWrite += Number(usage?.cacheWriteTokens ?? 0);
  }

  recordToolSignature(tc, isError) {
    const sig = sha256Hex(`${tc.name}::${tc.arguments}::${isError}`);
    this.recentCallSigs.push(sig);
    if (this.recentCallSigs.length > 6) this.recentCallSigs.shift();
    return this.recentCallSigs.filter((s) => s === sig).length >= 3;
  }

  saveCheckpoint({ step, phase, state }) {
    if (!this.checkpointStore || !this.sessionId || !this.turnId) return null;
    return this.checkpointStore.save({
      sessionId: this.sessionId,
      turnId: this.turnId,
      step,
      phase,
      state,
      leaseGuard: this.leaseGuard,
    });
  }
}

/**
 * Unified Phase-Driven AgentLoop (Layer 3 Kernel).
 * Executes all Agent Profiles (default direct session, subagents, swarm nodes, legacy profiles)
 * through a single deterministic loop with state-machine enforcement, steering, budget checks,
 * context compaction, tool batching, verification, and checkpoints.
 */
export class AgentLoop {
  constructor({
    store = null,
    eventRouter,
    inferenceEngine,
    decisionEngine = null,
    checkpointStore = null,
  }) {
    this.store = store;
    this.eventRouter = eventRouter;
    this.inferenceEngine = inferenceEngine;
    this.decisionEngine = decisionEngine ?? new DecisionEngine();
    this.checkpointStore = checkpointStore;
  }

  async run({
    sessionId,
    turnId,
    profile,
    input,
    model,
    provider = 'pool',
    effort = null,
    messages,
    tools = [],
    toolDispatcher,
    contextManager,
    drainSteering = () => [],
    drainMailbox = null,
    hooks = null,
    permissionMode = null,
    allowTools = undefined,
    denyTools = undefined,
    getApprovedPrefixes = () => [],
    requestApproval = null,
    onAssistantMessage = null,
    onToolResult = null,
    leaseGuard = null,
    parentGuard = null,
    budget = {},
    budgetLedger = null,
    budgetContext = null,
    initialStep = 0,
    signal,
    workspaceRoot = null,
    node = null,
    execution = null,
  }) {
    const sm = new TurnStateMachine({
      store: this.store,
      eventRouter: this.eventRouter,
      sessionId,
      turnId,
      initialPhase: TURN_PHASES.INIT,
      initialStep,
      leaseGuard,
    });
    const tm = new TurnManager({
      store: this.store,
      eventRouter: this.eventRouter,
      checkpointStore: this.checkpointStore,
      sessionId,
      turnId,
      leaseGuard,
    });

    const explicitMaxSteps = normalizeBudgetLimit(budget.maxSteps);
    const maxSteps =
      explicitMaxSteps !== null
        ? Math.min(60, explicitMaxSteps)
        : Math.min(60, Math.max(1, Number(profile?.defaultMaxSteps ?? 24)));
    const explicitMaxDuration = normalizeBudgetLimit(budget.maxDurationMs);
    const deadlineAt = explicitMaxDuration !== null ? Date.now() + explicitMaxDuration : null;
    const maxTotalTokens = normalizeBudgetLimit(budget.maxTokens);
    const explicitMaxOutput = normalizeBudgetLimit(budget.maxOutputTokens);
    const baseMaxOutputTokens = explicitMaxOutput !== null ? explicitMaxOutput : 4096;
    const verifierEvents = [];
    const argStrikes = new Map();

    let steps = Number(initialStep || 0);
    let executedStepsThisTurn = 0;
    let stopContinuedOnce = false;
    let repairedOnce = false;
    let repairRound = 0;
    let finalAssistantText = '';
    let finalVerdict = null;
    let stopReason = 'completed';
    let hadToolCalls = false;
    let idleDecisionAction = null;

    try {
      if (explicitMaxSteps === 0) {
        throw new BudgetError('STEP_BUDGET', {
          message: '步骤预算为 0，拒绝执行推理步骤',
          detail: { maxSteps: 0 },
        });
      }
      if (explicitMaxDuration === 0) {
        throw new BudgetError('TASK_DEADLINE', { message: '任务时间预算为 0' });
      }
      if (maxTotalTokens === 0) {
        throw new BudgetError('TOKEN_BUDGET', {
          message: 'Token 预算为 0，拒绝执行推理步骤',
          detail: { maxTokens: 0 },
        });
      }
      if (explicitMaxOutput === 0) {
        throw new BudgetError('TOKEN_BUDGET', {
          message: '输出 Token 预算为 0，拒绝执行推理步骤',
          detail: { maxOutputTokens: 0 },
        });
      }

      tm.saveCheckpoint({
        step: steps,
        phase: sm.phase,
        state: { model, maxSteps, messageCount: messages.length },
      });

      while (steps < maxSteps) {
        signal?.throwIfAborted?.();
        leaseGuard?.();
        if (deadlineAt !== null && Date.now() > deadlineAt) {
          throw new BudgetError('TASK_DEADLINE', { message: '任务执行超出时间预算' });
        }
        if (maxTotalTokens !== null && tm.totalIn + tm.totalOut >= maxTotalTokens) {
          throw new BudgetError('TOKEN_BUDGET', { message: '任务执行超出 Token 预算' });
        }

        steps++;
        sm.transition(TURN_PHASES.CHECKPOINT, { step: steps, persist: profile?.persistTurn !== false });

        // Drain mid-turn steering input and inter-agent mailbox messages at step boundary
        const steers = drainSteering() ?? [];
        for (const steerText of steers) {
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: `[用户实时纠偏指令]\n${steerText}` }],
          });
        }
        if (typeof drainMailbox === 'function') {
          const mailItems = (await drainMailbox()) ?? [];
          for (const mail of mailItems) {
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `[来自子代理 ${mail.fromAgentId} 的消息 (${mail.kind})]\n${
                    typeof mail.payload === 'string' ? mail.payload : JSON.stringify(mail.payload)
                  }`,
                },
              ],
            });
          }
        }

        // Context compaction check (fixes P0 bug where string stage > 0 never fired)
        let requestOptions = {
          provider,
          model,
          sessionKey: sessionId,
          effort,
          messages,
          tools,
          maxTokens: baseMaxOutputTokens,
          signal,
        };
        if (contextManager) {
          sm.transition(TURN_PHASES.COMPACTING, { step: steps, persist: profile?.persistTurn !== false });
          const compacted = await contextManager.prepareRequest(requestOptions, { step: steps });
          requestOptions = compacted.options;
          if (compacted.stage && compacted.stage !== 'none') {
            this.eventRouter.emitPersisted({
              sessionId,
              turnId,
              type: RUNTIME_EVENTS.CONTEXT_COMPACTED,
              data: {
                stage: compacted.stage,
                step: steps,
                tokens: compacted.tokens ?? null,
              },
              audit: false,
            });
          }
        }

        // Pre-inference budget admission, atomic reservation & controllable maxOutputTokens clamping
        const estimatedInputTokens = estimateRequestInputTokens(requestOptions);
        const nodeBudgetCaps = {
          maxSteps: explicitMaxSteps,
          maxTokens: maxTotalTokens,
          maxOutputTokens: explicitMaxOutput,
        };
        let activeReservation = null;
        if (budgetLedger && budgetContext?.treeId) {
          activeReservation = budgetLedger.reserveInference({
            treeId: budgetContext.treeId,
            scope: budgetContext.scope || BUDGET_SCOPES.NODE_EXECUTION,
            nodeId: budgetContext.nodeId || null,
            nodeKey: budgetContext.nodeKey || null,
            sessionId,
            turnId,
            attempt: budgetContext.attempt ?? 1,
            estimatedInputTokens,
            requestedMaxOutputTokens: requestOptions.maxTokens ?? baseMaxOutputTokens,
            nodeBudget: nodeBudgetCaps,
            nodeUsedSteps: executedStepsThisTurn,
            nodeUsedTokens: tm.totalIn + tm.totalOut,
            defaultMaxOutputTokens: baseMaxOutputTokens,
            leaseGuard,
          });
          requestOptions = {
            ...requestOptions,
            maxTokens: activeReservation.constrainedMaxOutputTokens,
          };
        } else if (maxTotalTokens !== null) {
          const localRemaining = Math.max(0, maxTotalTokens - (tm.totalIn + tm.totalOut));
          if (localRemaining <= 0 || estimatedInputTokens >= localRemaining) {
            throw new BudgetError('TOKEN_BUDGET', {
              message: `预估输入 Token (${estimatedInputTokens}) 超出剩余 Token 预算 (${localRemaining})`,
              detail: { estimatedInputTokens, remainingTokens: localRemaining, maxTotalTokens },
            });
          }
          requestOptions = {
            ...requestOptions,
            maxTokens: Math.min(
              requestOptions.maxTokens ?? baseMaxOutputTokens,
              Math.max(1, localRemaining - estimatedInputTokens),
            ),
          };
        }

        // Model inference phase
        sm.transition(TURN_PHASES.INFERENCE, { step: steps, persist: profile?.persistTurn !== false });
        let stepResult;
        try {
          stepResult = await this.inferenceEngine.streamStep({
            ...requestOptions,
            onRetryBudget:
              budgetLedger && budgetContext?.treeId
                ? ({ attempt: retryAttempt, usage: partialUsage, error: retryErr }) => {
                    if (activeReservation?.reservationId) {
                      budgetLedger.settleReservation(activeReservation.reservationId, {
                        status: 'failed',
                        actualSteps: 1,
                        actualInputTokens: partialUsage?.inputTokens ?? 0,
                        actualOutputTokens: partialUsage?.outputTokens ?? 0,
                        errorCode: retryErr?.code || 'TRANSIENT_UPSTREAM_ERROR',
                        leaseGuard,
                      });
                      activeReservation = null;
                    }
                    tm.addUsage(partialUsage);
                    executedStepsThisTurn++;
                    activeReservation = budgetLedger.reserveInference({
                      treeId: budgetContext.treeId,
                      scope: budgetContext.scope || BUDGET_SCOPES.NODE_EXECUTION,
                      nodeId: budgetContext.nodeId || null,
                      nodeKey: budgetContext.nodeKey || null,
                      sessionId,
                      turnId,
                      attempt: (budgetContext.attempt ?? 1) + retryAttempt,
                      estimatedInputTokens,
                      requestedMaxOutputTokens: requestOptions.maxTokens ?? baseMaxOutputTokens,
                      nodeBudget: nodeBudgetCaps,
                      nodeUsedSteps: executedStepsThisTurn,
                      nodeUsedTokens: tm.totalIn + tm.totalOut,
                      defaultMaxOutputTokens: baseMaxOutputTokens,
                      leaseGuard,
                    });
                    return activeReservation.constrainedMaxOutputTokens;
                  }
                : null,
            onTextDelta: (_delta, full) => {
              if (profile?.streamDeltas !== false) {
                this.eventRouter.emitEphemeral({
                  sessionId,
                  turnId,
                  type: RUNTIME_EVENTS.ASSISTANT_DELTA,
                  data: { turnId, sessionId, delta: _delta, text: full },
                });
              }
            },
            onReasoningDelta: (_delta, full) => {
              if (profile?.streamDeltas !== false) {
                this.eventRouter.emitEphemeral({
                  sessionId,
                  turnId,
                  type: RUNTIME_EVENTS.REASONING_DELTA,
                  data: { turnId, sessionId, delta: _delta, text: full },
                });
              }
            },
          });
          executedStepsThisTurn++;
          tm.addUsage(stepResult.usage);
          if (activeReservation?.reservationId) {
            budgetLedger.settleReservation(activeReservation.reservationId, {
              status: 'settled',
              actualSteps: 1,
              actualInputTokens: stepResult.usage?.inputTokens ?? 0,
              actualOutputTokens: stepResult.usage?.outputTokens ?? 0,
              leaseGuard,
            });
            activeReservation = null;
          }
        } catch (infErr) {
          if (infErr?.partialUsage) {
            tm.addUsage(infErr.partialUsage);
          }
          if (activeReservation?.reservationId && checkLeaseHeld(leaseGuard, { sessionId, turnId })) {
            try {
              budgetLedger.settleReservation(activeReservation.reservationId, {
                status: 'failed',
                actualSteps: 1,
                actualInputTokens: infErr?.partialUsage?.inputTokens ?? 0,
                actualOutputTokens: infErr?.partialUsage?.outputTokens ?? 0,
                errorCode: infErr?.code || 'INFERENCE_FAILED',
                leaseGuard,
              });
            } catch (settleErr) {
              if (!isLeaseLostError(settleErr)) throw settleErr;
            }
            activeReservation = null;
          }
          throw infErr;
        }
        signal?.throwIfAborted?.();
        leaseGuard?.();

        if (
          stepResult.text ||
          stepResult.reasoning ||
          stepResult.toolCalls.length > 0
        ) {
          const assistantMsg = {
            role: 'assistant',
            content: [
              ...(stepResult.text ? [{ type: 'text', text: stepResult.text }] : []),
              ...stepResult.toolCalls,
            ],
          };
          messages.push(assistantMsg);
          verifierEvents.push({
            type: 'assistant/message',
            data: { message: assistantMsg },
          });
          if (stepResult.text) {
            finalAssistantText = stepResult.text;
          }
          await onAssistantMessage?.({
            text: stepResult.text,
            reasoning: stepResult.reasoning,
            toolCalls: stepResult.toolCalls,
            step: steps,
          });
          if (stepResult.text && profile?.emitAssistantMessage !== false) {
            this.eventRouter.emitPersisted({
              sessionId,
              turnId,
              type: RUNTIME_EVENTS.ASSISTANT_MESSAGE,
              data: {
                turnId,
                sessionId,
                text: stepResult.text,
                reasoning: stepResult.reasoning || undefined,
                hasToolCalls: stepResult.toolCalls.length > 0,
              },
              audit: false,
            });
          }
        }

        // Idle completion / verification check when model emitted no tool calls
        if (!stepResult.toolCalls.length) {
          if (drainSteering && (steers?.length === 0)) {
            const lateSteers = drainSteering();
            if (lateSteers?.length) {
              for (const s of lateSteers) {
                messages.push({
                  role: 'user',
                  content: [{ type: 'text', text: `[用户实时纠偏指令]\n${s}` }],
                });
              }
              continue;
            }
          }

          verifierEvents.push({
            type: 'turn/end',
            data: { reason: { kind: stepResult.finishReason || 'completed' } },
          });

          sm.transition(TURN_PHASES.VERIFYING, { step: steps, persist: profile?.persistTurn !== false });
          const decision = await this.decisionEngine.shouldContinueOnIdle({
            input,
            stepText: stepResult.text,
            steps,
            maxSteps,
            stopContinuedOnce,
            repairedOnce,
            repairRound,
            verifierEvents,
            node,
            execution,
            sessionId,
            turnId,
            workspaceRoot,
            signal,
          });

          if (decision.action === 'continue_stop') {
            stopContinuedOnce = true;
            messages.push({ role: 'user', content: [{ type: 'text', text: decision.note }] });
            continue;
          }
          if (decision.action === 'repair') {
            repairedOnce = true;
            repairRound++;
            finalVerdict = decision.verdict;
            this.eventRouter.emitPersisted({
              sessionId,
              turnId,
              type: RUNTIME_EVENTS.VERIFIER_REPAIR,
              data: {
                verdict: decision.verdict.verdict,
                reasons: decision.verdict.reasons,
              },
            });
            messages.push({ role: 'user', content: [{ type: 'text', text: decision.note }] });
            continue;
          }
          if (decision.action === 'reconcile') {
            finalVerdict = decision.verdict;
            stopReason = 'block_reconciliation';
            idleDecisionAction = 'reconcile';
            break;
          }
          if (decision.action === 'fail') {
            finalVerdict = decision.verdict;
            stopReason = 'verification_failed';
            idleDecisionAction = 'fail';
            break;
          }
          if (decision.verdict) {
            finalVerdict = decision.verdict;
          }
          stopReason = 'completed';
          idleDecisionAction = 'complete';
          break;
        }

        // Tools dispatch phase
        hadToolCalls = true;
        sm.transition(TURN_PHASES.TOOLS, { step: steps, persist: profile?.persistTurn !== false });
        const executedBatch = await toolDispatcher.dispatchBatch({
          sessionId,
          turnId,
          toolCalls: stepResult.toolCalls,
          tools,
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
          tainted: Boolean(execution?.tainted),
        });

        let detectedThrashing = false;
        for (const item of executedBatch) {
          const { tc, output, isError, durationMs, receipt } = item;
          await onToolResult?.({
            tc,
            output,
            isError,
            durationMs,
            receipt,
            step: steps,
          });
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            content: [{ type: 'text', text: output }],
          });
          verifierEvents.push({
            type: 'tool/result',
            data: {
              name: tc.name,
              isError,
              content: output,
              receipt,
            },
          });
          if (profile?.emitToolEvents !== false) {
            this.eventRouter.emitPersisted({
              sessionId,
              turnId,
              type: RUNTIME_EVENTS.TOOL_RESULT,
              data: {
                turnId,
                sessionId,
                callId: tc.id,
                name: tc.name,
                isError,
                durationMs,
                output: excerpt(output, 4000),
                ...(receipt?.id ? { receiptId: receipt.id } : {}),
              },
              audit: false,
            });
          }
          if (tm.recordToolSignature(tc, isError)) {
            detectedThrashing = true;
          }
        }

        tm.saveCheckpoint({
          step: steps,
          phase: sm.phase,
          state: {
            model,
            steps,
            totalIn: tm.totalIn,
            totalOut: tm.totalOut,
            lastToolCallIds: executedBatch.map((b) => b.tc.id),
          },
        });

        if (detectedThrashing) {
          if (!tm.thrashWarned) {
            tm.thrashWarned = true;
            this.eventRouter.emitPersisted({
              sessionId,
              turnId,
              type: RUNTIME_EVENTS.LOOP_THRASHING_WARNING,
              data: { step: steps },
              audit: false,
            });
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: '[系统防死循环提示] 检测到你连续多次执行相同的失败/重复工具调用。请停止重复相同参数，换一种思路排查，或直接向用户如实汇报当前进展与阻塞点。',
                },
              ],
            });
          } else {
            stopReason = 'thrashing_circuit_break';
            break;
          }
        }
      }

      // If the execution loop ended without a normal idle verification (step budget exhausted
      // or anti-loop thrashing break), STILL run final verification so unknown side effects
      // or failed checks are never skipped to falsely claim completion.
      if (idleDecisionAction === null) {
        if (stopReason !== 'thrashing_circuit_break') {
          stopReason = 'max_steps';
        }
        if (this.decisionEngine?.verifier) {
          if (sm.phase !== TURN_PHASES.VERIFYING && !sm.isTerminal()) {
            sm.transition(TURN_PHASES.VERIFYING, {
              step: steps,
              reason: stopReason,
              persist: profile?.persistTurn !== false,
            });
          }
          const postLoopVerdict = await Promise.resolve(
            this.decisionEngine.verifier({
              events: verifierEvents,
              text: finalAssistantText,
              node,
              execution,
              sessionId,
              turnId,
              workspaceRoot,
            }),
          );
          if (postLoopVerdict) {
            finalVerdict = postLoopVerdict;
            if (postLoopVerdict.verdict === 'block_reconciliation') {
              stopReason = 'block_reconciliation';
            }
          }
        }
      }

      const outcome = resolveTurnOutcome({
        loopStopReason: stopReason,
        verdict: finalVerdict,
        hasPendingReconciliation: finalVerdict?.verdict === 'block_reconciliation',
        evidenceRequired: hadToolCalls || Boolean(finalVerdict?.evidenceRequired),
        evidenceCount: finalVerdict?.evidenceCount ?? 0,
      });

      const targetPhase =
        outcome.phase === 'reconciling'
          ? TURN_PHASES.RECONCILING
          : outcome.phase === 'failed'
            ? TURN_PHASES.FAILED
            : TURN_PHASES.COMPLETED;

      sm.transition(targetPhase, {
        step: steps,
        reason: outcome.errorCode || stopReason,
        persist: profile?.persistTurn !== false,
      });

      return {
        status: outcome.status,
        stopReason,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        text: finalAssistantText,
        steps,
        usage: {
          inputTokens: tm.totalIn,
          outputTokens: tm.totalOut,
          cacheReadTokens: tm.totalCacheRead,
          cacheWriteTokens: tm.totalCacheWrite,
        },
        verdict: outcome.verdict,
        verifiedPass: outcome.verifiedPass,
        failureKind: outcome.failureKind,
        verifierEvents,
        phaseHistory: sm.history,
      };
    } catch (err) {
      const classified = classifyError(err);
      classified.usage = {
        inputTokens: tm.totalIn,
        outputTokens: tm.totalOut,
        cacheReadTokens: tm.totalCacheRead,
        cacheWriteTokens: tm.totalCacheWrite,
      };
      classified.steps = steps;
      // Fix D6: On LEASE_LOST (or if lease was already lost before error), exit cleanly without corrupting turn phase
      if (isLeaseLostError(classified) || !checkLeaseHeld(leaseGuard, { sessionId, turnId })) {
        throw isLeaseLostError(classified)
          ? classified
          : new RecoveryError('LEASE_LOST', {
              message: `Lease lost during turn ${turnId}`,
              cause: err,
            });
      }
      const isCancelled = Boolean(signal?.aborted || classified.category === 'cancellation');
      const targetPhase =
        classified.code === 'APPROVAL_PARKED'
          ? TURN_PHASES.PARKED
          : classified.code === 'RECONCILIATION_REQUIRED'
            ? TURN_PHASES.RECONCILING
            : isCancelled
              ? TURN_PHASES.CANCELLED
              : TURN_PHASES.FAILED;
      try {
        if (!sm.isTerminal()) {
          sm.transition(targetPhase, {
            step: steps,
            reason: classified.code,
            persist: profile?.persistTurn !== false,
          });
        }
      } catch {
        // already terminal or lease lost
      }
      throw classified;
    }
  }
}
