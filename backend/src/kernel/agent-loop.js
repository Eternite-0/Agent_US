import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { sha256Hex } from '../integrity.js';
import { computeArgsDigest } from '../tools/dispatcher.js';
import { compactTwoStage, excerpt } from '../context.js';
import { verifyTurn, buildRepairNote } from '../verifier.js';
import { BudgetError, RecoveryError, classifyError } from './errors.js';
import { RUNTIME_EVENTS } from './events.js';
import {
  ExecutionReasoningTracker,
  MUTATING_FILE_TOOLS,
  STUCK_PATTERNS,
} from './execution-reasoning.js';
import { TURN_PHASES, TurnStateMachine } from './state-machine.js';
import {
  evaluateContractReadiness,
  extractTaskContract,
} from './contract-reasoning.js';
import { resolveTurnOutcome } from './verdict.js';
import { checkLeaseHeld, isLeaseLostError } from '../durable/lease-guard.js';
import { selectOffloadableAciCandidates } from '../context/aci-engine.js';
import {
  BUDGET_SCOPES,
  estimateRequestInputTokens,
  normalizeBudgetLimit,
} from '../swarm/budget-ledger.js';

function normalizeAciPath(p) {
  return String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function collectBaselineSourceFallback(workspaceRoot, maxFiles = 40) {
  const results = [];
  const skipDirs = new Set(['.git', 'node_modules', 'upstream', 'var']);
  const walk = (dir) => {
    if (results.length >= maxFiles) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (results.length >= maxFiles) return;
      if (skipDirs.has(ent.name)) continue;
      const full = join(dir, ent.name);
      const rel = relative(workspaceRoot, full).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        if (!/^backend\/var(?:\/|$)/i.test(rel)) walk(full);
      } else if (ent.isFile()) {
        if (/^(?:src|lib|bin)\//i.test(rel) || /^(?:SPEC|CONSTRAINTS)\.md$/i.test(rel)) {
          results.push(rel);
        }
      }
    }
  };
  walk(resolve(String(workspaceRoot)));
  return results;
}

function resolveBaselineCriticalFiles(workspaceRoot, candidateCriticalFiles = []) {
  const candidates = Array.isArray(candidateCriticalFiles)
    ? candidateCriticalFiles.map((f) => String(f ?? '').trim()).filter(Boolean)
    : [];
  if (!candidates.length || !workspaceRoot || !existsSync(resolve(String(workspaceRoot)))) {
    return candidates;
  }
  const existing = candidates.filter((rel) => {
    try {
      return existsSync(resolve(String(workspaceRoot), rel));
    } catch {
      return false;
    }
  });
  if (existing.length > 0) return existing;
  return collectBaselineSourceFallback(workspaceRoot);
}

function aciPathsMatch(a, b) {
  const na = normalizeAciPath(a);
  const nb = normalizeAciPath(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}

function computeActiveCriticalContextRecall({ criticalFiles = [], reasoningTracker, aciStore = null, ledger = null } = {}) {
  const uniqueTruth = [];
  const seen = new Set();
  const rawTruth =
    Array.isArray(criticalFiles) && criticalFiles.length > 0
      ? criticalFiles
      : [...(reasoningTracker?._mutatedSrcSet ?? [])];
  for (const f of rawTruth) {
    const norm = normalizeAciPath(f);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    uniqueTruth.push(String(f));
  }
  if (uniqueTruth.length === 0) return null;

  const filesReadBeforeEdit = reasoningTracker?.rootCauseFilesReadBeforeEdit ?? [];
  const keptPaths = (ledger?.kept ?? []).map((k) => k.path).filter(Boolean);
  const expandedPaths = (ledger?.expanded ?? []).map((e) => e.path).filter(Boolean);
  const recoveredPaths = (ledger?.recoveries ?? [])
    .filter((r) => r.verified !== false)
    .map((r) => r.path)
    .filter(Boolean);
  const admittedActivePaths = (ledger?.admissions ?? [])
    .filter((a) => a.decision === 'DIRECT' || a.decision === 'SUPPORTING')
    .map((a) => a.path)
    .filter(Boolean);
  const admittedStubPaths = (ledger?.admissions ?? [])
    .filter((a) => a.decision === 'DEFER' || a.decision === 'IRRELEVANT')
    .map((a) => a.path)
    .filter(Boolean);
  const compressedPaths = (ledger?.compressed ?? []).map((c) => c.path).filter(Boolean);
  const restoredRefs = (aciStore?.listRefs?.() ?? []).filter((r) => Number(r.restoredCount || 0) > 0);

  let activeHits = 0;
  for (const gt of uniqueTruth) {
    const hasAdmissions = (ledger?.admissions ?? []).length > 0;
    const admittedActive = admittedActivePaths.some((p) => aciPathsMatch(p, gt));
    const admittedOnlyStub = admittedStubPaths.some((p) => aciPathsMatch(p, gt)) && !admittedActive;
    const readOrKept =
      admittedActive ||
      (!admittedOnlyStub && filesReadBeforeEdit.some((p) => aciPathsMatch(p, gt))) ||
      keptPaths.some((p) => aciPathsMatch(p, gt)) ||
      expandedPaths.some((p) => aciPathsMatch(p, gt)) ||
      recoveredPaths.some((p) => aciPathsMatch(p, gt));
    const wasCompressed = compressedPaths.some((p) => aciPathsMatch(p, gt)) || (hasAdmissions && admittedOnlyStub);
    const wasRestored =
      expandedPaths.some((p) => aciPathsMatch(p, gt)) ||
      recoveredPaths.some((p) => aciPathsMatch(p, gt)) ||
      restoredRefs.some((r) => aciPathsMatch(r.path, gt));
    if (readOrKept && (!wasCompressed || wasRestored)) {
      activeHits += 1;
    } else if (wasRestored) {
      activeHits += 1;
    }
  }
  return activeHits / uniqueTruth.length;
}

/**
 * Default DecisionEngine handles premature-stop detection, verification gate,
 * repair loop policy, and thrashing circuit-breaker checks.
 */
export class DecisionEngine {
  constructor({ judgment = null, verifier = null, maxRepairRounds = 1 } = {}) {
    this.judgment = judgment;
    this.verifier = verifier ?? verifyTurn;
    this.maxRepairRounds = maxRepairRounds;
    this._explicitMaxRepairRounds =
      arguments.length > 0 &&
      arguments[0] != null &&
      Object.hasOwn(arguments[0], 'maxRepairRounds') &&
      arguments[0].maxRepairRounds !== undefined;
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
    reasoningState = null,
    contractReadiness = null,
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
          reasoningState,
        }),
      );
      if (verdict && verdict.verdict === 'block_reconciliation') {
        return { action: 'reconcile', verdict };
      }
      if (verdict && (verdict.verdict !== 'pass' || verdict.accepted === false)) {
        const effectiveMaxRepairRounds =
          !this._explicitMaxRepairRounds &&
          (execution?.evidenceContract || execution?.requirePostEditVerification)
            ? Math.max(this.maxRepairRounds, 2)
            : this.maxRepairRounds;
        if (repairRound < effectiveMaxRepairRounds && steps < maxSteps) {
          return {
            action: 'repair',
            verdict,
            note: !node && !execution?.evidenceContract &&
              verdict.reasons?.length === 1 && verdict.reasons[0].startsWith('FABRICATED_PASS_CLAIM:')
              ? `[验证未通过] ${verdict.reasons[0]}\n完成后用自然语言如实汇报执行过的验证和结果。`
              : buildRepairNote(verdict, { reasoningState, contractReadiness }),
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
    this.totalCacheRead = null;
    this.totalCacheWrite = null;
    this.totalCacheEligible = null;
    this.recentCallSigs = [];
    this.thrashWarned = false;
  }

  addUsage(usage) {
    this.totalIn += Number(usage?.inputTokens ?? 0);
    this.totalOut += Number(usage?.outputTokens ?? 0);
    if (usage?.cacheReadTokens != null) {
      this.totalCacheRead = (this.totalCacheRead ?? 0) + usage.cacheReadTokens;
    }
    if (usage?.cacheWriteTokens != null) {
      this.totalCacheWrite = (this.totalCacheWrite ?? 0) + usage.cacheWriteTokens;
    }
    if (usage?.cacheEligibleInputTokens != null) {
      this.totalCacheEligible = (this.totalCacheEligible ?? 0) + usage.cacheEligibleInputTokens;
    }
  }

  recordToolSignature(tc, isError, effectiveArgs, pending = false) {
    // Polling a still-running operation is not a repeated failure or effect.
    // Keep other successful reads in the existing no-progress check.
    let sig = null;
    if (isError || !pending) {
      try {
        sig = computeArgsDigest(tc.name, { args: effectiveArgs ?? tc.arguments, isError });
      } catch {
        // Malformed/unknown tool arguments must not crash the turn's warning path.
        sig = sha256Hex(`${tc.name}::${tc.arguments}::${isError}`);
      }
    }
    this.recentCallSigs.push(sig);
    if (this.recentCallSigs.length > 6) this.recentCallSigs.shift();
    return sig !== null && this.recentCallSigs.filter((s) => s === sig).length >= 3;
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

function isShutdownAbort(signal, err) {
  const reasons = [
    signal?.reason,
    signal?.reason?.message,
    signal?.reason?.detail?.message,
    signal?.reason?.detail?.reason,
    err?.message,
    err?.detail?.message,
    err?.detail?.reason,
    err?.cause?.message,
    err?.cause?.detail?.message,
  ];
  return reasons.some((r) => r === 'shutdown' || r === 'runtime_closed');
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
    getModelTools = null,
    selectionRecoveryHint = null,
    toolDispatcher,
    contextManager,
    drainSteering = () => [],
    drainMailbox = null,
    hooks = null,
    permissionMode = null,
    allowTools = undefined,
    denyTools = undefined,
    getLivePolicy = null,
    getApprovedPrefixes = () => [],
    requestApproval = null,
    approvalManager = null,
    onAssistantMessage = null,
    onToolResult = null,
    leaseGuard = null,
    parentGuard = null,
    deferTerminalPhase = false,
    budget = {},
    budgetLedger = null,
    budgetContext = null,
    initialStep = 0,
    signal,
    workspaceRoot = null,
    node = null,
    execution = null,
    aci = null,
  }) {
    const sm = new TurnStateMachine({
      store: this.store,
      eventRouter: this.eventRouter,
      sessionId,
      turnId,
      initialPhase: TURN_PHASES.INIT,
      initialStep,
      leaseGuard,
      deferTerminalPhase,
    });
    const tm = new TurnManager({
      store: this.store,
      eventRouter: this.eventRouter,
      checkpointStore: this.checkpointStore,
      sessionId,
      turnId,
      leaseGuard,
    });

    if (initialStep > 0 && this.checkpointStore && turnId) {
      const latestCp = this.checkpointStore.loadLatest(turnId);
      if (latestCp?.state) {
        if (Number.isFinite(Number(latestCp.state.totalIn))) {
          tm.totalIn = Math.max(0, Number(latestCp.state.totalIn));
        }
        if (Number.isFinite(Number(latestCp.state.totalOut))) {
          tm.totalOut = Math.max(0, Number(latestCp.state.totalOut));
        }
        if (Number.isFinite(latestCp.state.totalCacheRead)) {
          tm.totalCacheRead = Math.max(0, Number(latestCp.state.totalCacheRead));
        }
        if (Number.isFinite(latestCp.state.totalCacheWrite)) {
          tm.totalCacheWrite = Math.max(0, Number(latestCp.state.totalCacheWrite));
        }
        tm.totalCacheEligible = latestCp.state.totalCacheEligible ?? null;
      }
    }

    const explicitMaxSteps = normalizeBudgetLimit(budget.maxSteps);
    const maxSteps =
      explicitMaxSteps !== null
        ? Math.min(60, explicitMaxSteps)
        : Math.min(60, Math.max(1, Number(profile?.defaultMaxSteps ?? 24)));
    const explicitMaxDuration = normalizeBudgetLimit(budget.maxDurationMs);
    const deadlineAt = explicitMaxDuration !== null ? Date.now() + explicitMaxDuration : null;
    const maxTotalTokens = normalizeBudgetLimit(budget.maxTokens);
    const explicitMaxOutput = normalizeBudgetLimit(budget.maxOutputTokens);
    const baseMaxOutputTokens = explicitMaxOutput !== null ? explicitMaxOutput : 8192;
    const verificationReserve = normalizeBudgetLimit(budget.finalVerificationReserve) ?? 0;
    const verifierEvents = [];
    const argStrikes = new Map();
    const reasoningTracker = new ExecutionReasoningTracker({
      workspaceRoot,
      baselineTestFiles: execution?.baselineTestFiles ?? node?.baselineTestFiles ?? null,
    });
    const aciProfile = aci?.aciProfile ?? 'full_aci';
    const aciAdmissionEnabled =
      Boolean(aci?.engine) &&
      aci?.admissionEnabled !== false &&
      typeof aci?.engine?.admitToolBatch === 'function';
    const aciDtocEnabled = Boolean(aci?.engine) && aci?.dtocEnabled !== false;
    const aciSupervisorEnabled = aci?.supervisorEnabled !== false;
    const aciSupervisorConfigOverride = aci?.supervisorConfigOverride ?? null;
    const resolvedInitialSup = aci?.supervisor
      ? aciSupervisorConfigOverride
        ? aci.supervisor.resolveModel?.(aciSupervisorConfigOverride)
        : {
            config: aci.supervisor.getConfig?.() ?? null,
            effectiveModel: aci.supervisor.resolveModel?.()?.effectiveModel ?? null,
          }
      : null;
    const initialSupCfg = resolvedInitialSup?.config ?? null;
    let dtocSupervisorCalls = 0;
    let aciSupervisorCalls = 0;
    let aciSupervisorMode = !aciSupervisorEnabled
      ? 'off'
      : initialSupCfg
        ? initialSupCfg.enabled
          ? initialSupCfg.mode
          : 'off'
        : null;
    let aciSupervisorModel = !aciSupervisorEnabled
      ? null
      : resolvedInitialSup?.effectiveModel ?? null;
    const rawAciCritical = aci?.criticalFiles ?? execution?.evidenceContract?.requiredChangedFiles ?? [];
    const resolvedAciCriticalFiles = resolveBaselineCriticalFiles(workspaceRoot, rawAciCritical);
    const syncAciMetrics = () => {
      if (!aci?.engine && !aci?.aciStore && !aci?.ledger) return;
      const refs = aci.aciStore?.listRefs?.() ?? [];
      const ledgerSummary = aci.ledger?.summary?.() ?? {
        compressedCount: 0,
        expandedCount: 0,
        totalTokensSaved: 0,
        admissionTokensSaved: 0,
      };
      const admissions = aci.ledger?.admissions ?? [];
      const admissionDecisions = { DIRECT: 0, SUPPORTING: 0, DEFER: 0, DUPLICATE: 0, IRRELEVANT: 0 };
      let admissionOriginalTokens = 0;
      let admissionInjectedTokens = 0;
      let admissionSavedTokens = 0;
      for (const a of admissions) {
        if (a?.decision && Object.hasOwn(admissionDecisions, a.decision)) {
          admissionDecisions[a.decision] += 1;
        }
        admissionOriginalTokens += Number(a?.originalTokens || 0);
        admissionInjectedTokens += Number(a?.injectedTokens || 0);
        admissionSavedTokens += Number(a?.tokensSaved || 0);
      }
      const recoveries = aci.ledger?.recoveries ?? [];
      const hashVerifiedRestores = recoveries.filter((r) => r?.verified).length;
      const refsRestoredCount = refs.reduce((s, r) => s + Number(r.restoredCount || 0), 0);
      const restoredCount = Math.max(refsRestoredCount, recoveries.length);
      const offloadedCount = Math.max(refs.length, Number(ledgerSummary.compressedCount || 0));
      const savedTokens = Number(ledgerSummary.totalTokensSaved || 0);
      const totalAciSavedTokens = savedTokens + admissionSavedTokens;
      const epochTransitions = Number(aci.engine?.epochState?.epochCount || 0);
      const supLog = aci.ledger?.supervisorCalls ?? [];
      const effectiveSupCalls = Math.max(aciSupervisorCalls, supLog.length);
      const supervisorCost = {
        calls: effectiveSupCalls,
        inputTokens: supLog.reduce((s, c) => s + Number(c.inputTokens || 0), 0),
        outputTokens: supLog.reduce((s, c) => s + Number(c.outputTokens || 0), 0),
        totalTokens: supLog.reduce((s, c) => s + Number(c.totalTokens || 0), 0),
        durationMs: supLog.reduce((s, c) => s + Number(c.durationMs || 0), 0),
        fallbackCount: supLog.filter((c) => Boolean(c.fallback)).length,
      };
      const recoveryStats = {
        totalRecoveries: recoveries.length,
        hashVerifiedCount: hashVerifiedRestores,
        tokensRestored: recoveries.reduce((s, r) => s + Number(r.tokensRestored || 0), 0),
      };
      const criticalContextRecall = computeActiveCriticalContextRecall({
        criticalFiles: resolvedAciCriticalFiles,
        reasoningTracker,
        aciStore: aci.aciStore ?? null,
        ledger: aci.ledger ?? null,
      });
      const governance =
        aci.ledger?.computeGovernanceMetrics?.({
          groundTruthCriticalFiles: resolvedAciCriticalFiles,
        }) ?? null;
      reasoningTracker.updateAciMetrics({
        aciProfile,
        admissionEnabled: aciAdmissionEnabled,
        dtocEnabled: aciDtocEnabled,
        dtocPolicy: aci.engine?.dtocPolicy ?? 'adaptive_single_step',
        dtocMinPromptTokens: aci.engine?.dtocMinPromptTokens ?? 24000,
        admissionDecisions,
        admissionOriginalTokens,
        admissionInjectedTokens,
        admissionSavedTokens,
        offloadedCount,
        savedTokens,
        totalAciSavedTokens,
        restoredCount,
        hashVerifiedRestores,
        criticalContextRecall,
        supervisorCalls: effectiveSupCalls,
        supervisorMode: aciSupervisorMode,
        supervisorModel: aciSupervisorModel,
        supervisorCost,
        recoveryStats,
        epochTransitions,
        ledger: {
          summary: ledgerSummary,
          governance,
          admissions: admissions.map((a) => ({
            path: a.path,
            toolName: a.toolName,
            decision: a.decision,
            criticalDomains: a.criticalDomains,
            score: a.score,
            originalTokens: a.originalTokens,
            injectedTokens: a.injectedTokens,
            tokensSaved: a.tokensSaved,
            step: a.step,
            reason: a.reason,
            uri: a.uri,
            sha256: a.sha256,
          })),
          supervisorCalls: supLog,
          recoveries,
        },
      });
    };
    let taskContract = null;
    let lastContractFilesReadCount = -1;
    let lastContractReadiness = null;
    const refreshContractReadiness = () => {
      if (!workspaceRoot) return null;
      const filesRead = reasoningTracker.filesRead;
      if (!taskContract || filesRead.length !== lastContractFilesReadCount) {
        const rawPrompt = String(input ?? '');
        const repoCtxIdx = rawPrompt.search(/\r?\n\r?\n\[Repository Intelligence(?: Context)?\]\r?\n/);
        const contractPrompt = repoCtxIdx >= 0 ? rawPrompt.slice(0, repoCtxIdx) : rawPrompt;
        taskContract = extractTaskContract({ prompt: contractPrompt, workspaceRoot, filesRead });
        lastContractFilesReadCount = filesRead.length;
      }
      lastContractReadiness = evaluateContractReadiness({
        contract: taskContract,
        reasoningState: reasoningTracker.getState(),
        workspaceRoot,
        verifierEvents,
      });
      reasoningTracker.updateContractEvaluation(lastContractReadiness);
      return lastContractReadiness;
    };

    let steps = Number(initialStep || 0);
    let executedStepsThisTurn = 0;
    let stopContinuedOnce = false;
    let verificationReserveAdvised = false;
    let budgetReserveAdvised = false;
    let budgetFinalCallAdvised = false;
    let finalStepAdvised = false;
    let repairedOnce = false;
    let repairRound = 0;
    let monologueWarned = false;
    let policyBlockWarned = false;
    const nonFatalPatternsWarned = new Set();
    let contractCompletionChecked = false;
    let finalAssistantText = '';
    let finalVerdict = null;
    let stopReason = 'completed';
    let hadToolCalls = false;
    let idleDecisionAction = null;
    let lastRoute = null;

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
        let advisedReserveThisStep = false;
        if (
          !verificationReserveAdvised &&
          verificationReserve > 0 &&
          maxSteps > verificationReserve &&
          steps >= maxSteps - verificationReserve
        ) {
          verificationReserveAdvised = true;
          advisedReserveThisStep = true;
          const reserveText = execution?.evidenceContract
            ? `[预算收尾提醒] 距离最大步数上限仅剩最后 ${verificationReserve} 步（最终验证预留）。请停止继续大范围探索，立即运行必需测试验证并在最终回复中输出完整的 Evidence Manifest v1.0.0。`
            : `[预算收尾提醒] 距离最大步数上限仅剩最后 ${verificationReserve} 步。请停止继续大范围探索或重试失败命令，完成当前最小必要修改并直接输出最终交付总结，切勿耗尽步数。`;
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: reserveText,
              },
            ],
          });
        }
        const tokenReserveThreshold =
          maxTotalTokens !== null ? Math.max(38000, Math.floor(maxTotalTokens * 0.26)) : null;
        const remainingTokens =
          maxTotalTokens !== null ? maxTotalTokens - (tm.totalIn + tm.totalOut) : null;
        const remainingDurationMs = deadlineAt !== null ? deadlineAt - Date.now() : null;
        const currentStepEstimatedIn =
          maxTotalTokens !== null
            ? estimateRequestInputTokens({
                provider,
                model,
                sessionKey: sessionId,
                effort,
                messages,
                tools: getModelTools ? getModelTools() : tools,
              })
            : 0;
        const finalManifestReserve = currentStepEstimatedIn + 1800;
        const estTurnCost = Math.max(4000, currentStepEstimatedIn + 1500);
        const approxTurnsLeft =
          remainingTokens !== null ? Math.max(0, Math.floor(remainingTokens / estTurnCost)) : null;
        const hasUnverifiedMutations = reasoningTracker.hasUnverifiedMutationsAfterLastPass;
        const tier2Threshold = Math.max(
          Math.floor(currentStepEstimatedIn * 2.15) + 1500,
          currentStepEstimatedIn + finalManifestReserve,
        );

        if (
          !budgetFinalCallAdvised &&
          maxTotalTokens !== null &&
          remainingTokens !== null &&
          steps >= 4 &&
          !advisedReserveThisStep &&
          remainingTokens > currentStepEstimatedIn &&
          remainingTokens <= tier2Threshold
        ) {
          budgetFinalCallAdvised = true;
          budgetReserveAdvised = true;
          advisedReserveThisStep = true;
          reasoningTracker.markBudgetReserveAdvised();
          reasoningTracker.markBudgetFinalCallAdvised();
          const finalCallWarningText = !hasUnverifiedMutations
            ? execution?.evidenceContract
              ? `[最终预算警告 — 仅剩最后 1 次模型调用] 剩余累计预算（约 ${remainingTokens} tokens）扣除本次上下文（约 ${currentStepEstimatedIn} tokens）后已不足以发起下一轮调用。你已完成修改且无未验证变更，严禁再调用任何工具（否则下步必将触发 TOKEN_BUDGET 失败）！请立即直接输出简洁结论与完整的 Evidence Manifest v1.0.0 JSON。`
              : `[最终预算警告 — 仅剩最后 1 次模型调用] 剩余累计预算（约 ${remainingTokens} tokens）扣除本次上下文（约 ${currentStepEstimatedIn} tokens）后已不足以发起下一轮调用。你已完成修改且无未验证变更，严禁再调用任何工具（否则下步必将触发 TOKEN_BUDGET 失败）！请立即直接输出最终交付总结。`
            : execution?.evidenceContract
              ? `[最终预算警告 — 预算极度紧张] 剩余累计预算（约 ${remainingTokens} tokens）相对于当前单次上下文（约 ${currentStepEstimatedIn} tokens）仅够 1~2 次调用。请立即停止编辑与探索，若尚未运行必需测试请立即仅执行 1 次测试（或若余量不足以再调用则直接基于已有真实回执输出最终总结与 Evidence Manifest v1.0.0 JSON），切勿拆分多余步骤触发 TOKEN_BUDGET。`
              : `[最终预算警告 — 预算极度紧张] 剩余累计预算（约 ${remainingTokens} tokens）相对于当前单次上下文（约 ${currentStepEstimatedIn} tokens）仅够 1~2 次调用。请立即停止编辑与探索，仅在必要时运行 1 次关键验证后立即输出最终交付总结，切勿拆分多余步骤触发 TOKEN_BUDGET。`;
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: finalCallWarningText,
              },
            ],
          });
        }

        if (
          !advisedReserveThisStep &&
          !budgetReserveAdvised &&
          steps >= 4 &&
          ((tokenReserveThreshold !== null &&
            remainingTokens <= Math.max(tokenReserveThreshold, Math.ceil(currentStepEstimatedIn * 3.0))) ||
            (remainingDurationMs !== null && remainingDurationMs <= 35000))
        ) {
          budgetReserveAdvised = true;
          advisedReserveThisStep = true;
          reasoningTracker.markBudgetReserveAdvised();
          const turnsNote =
            remainingTokens !== null
              ? `按每次调用重放当前约 ${currentStepEstimatedIn} tokens 上下文计，累计预算仅剩约 ${Math.max(1, approxTurnsLeft ?? 1)} 次模型调用`
              : `剩余时间约 ${Math.max(0, Math.round((remainingDurationMs ?? 0) / 1000))}s`;
          const budgetWrapUpText = execution?.evidenceContract
            ? `[预算收尾提醒] 当前剩余预算约 ${remainingTokens ?? '未知'} tokens（${turnsNote}） / ${remainingDurationMs !== null ? `${Math.max(0, Math.round(remainingDurationMs / 1000))}s` : '无时间限制'}。请立即停止探索性读取（read_file/grep/glob），严禁将修改拆成多步、调用额外的 update_plan、辅助探测命令或未授权脚本；${hasUnverifiedMutations ? '请立即将剩余最小修改合并并仅运行至多 1 次必需测试验证后，' : '你当前无未验证变更，请勿再执行多余工具调用，直接'}立即输出简洁总结与完整的 Evidence Manifest v1.0.0 JSON。`
            : `[预算收尾提醒] 当前剩余预算约 ${remainingTokens ?? '未知'} tokens（${turnsNote}）。请立即停止探索性读取，严禁将修改拆成多步、调用额外的 update_plan、额外 bash 探测或未授权辅助脚本；${hasUnverifiedMutations ? '仅在必要时运行至多 1 次关键验证后' : ''}立即输出简洁的最终交付总结，切勿耗尽预算。`;
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: budgetWrapUpText,
              },
            ],
          });
        }
        if (!finalStepAdvised && maxSteps >= 12 && steps === maxSteps) {
          finalStepAdvised = true;
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: '[最后一步收尾提醒] 这是你本节点的最后 1 步。请勿再调用任何工具，直接基于已完成的工作与已验证结果输出最终交付总结。',
              },
            ],
          });
        }

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
          tools: getModelTools ? getModelTools() : tools,
          maxTokens: baseMaxOutputTokens,
          signal,
        };
        if (aci?.engine) {
          if (aciDtocEnabled) {
            const cumulativeUsedTokens = tm.totalIn + tm.totalOut;
            const epochContextWindow = aci.engine.contextWindow ?? 128000;
            const epochProbe = aci.engine.inspectEpoch?.(requestOptions.messages, {
              currentStep: steps,
              tools: requestOptions.tools,
              cumulativeUsedTokens,
              contextWindow: epochContextWindow,
            });
            if (epochProbe?.triggered) {
              const activeMutationTargets = [...reasoningTracker.filesMutated];
              const eligibleCandidates = selectOffloadableAciCandidates(requestOptions.messages, {
                currentStep: steps,
                singleStepTriggered: Boolean(epochProbe.singleStepTriggered),
                singleStepBudget: aci.engine.singleStepBudget,
                activeMutationTargets,
              });
              if (eligibleCandidates.length > 0) {
                let keepRefs = [];
                let compressRefs = [];
                const totalEligibleChars = eligibleCandidates.reduce(
                  (sum, c) => sum + (Number(c.chars) || 0),
                  0,
                );
                if (
                  aciSupervisorEnabled &&
                  aci.supervisor &&
                  eligibleCandidates.length >= 2 &&
                  totalEligibleChars >= 2400 &&
                  dtocSupervisorCalls < 2
                ) {
                  const supStatus = aciSupervisorConfigOverride
                    ? aci.supervisor.resolveModel?.(aciSupervisorConfigOverride)?.config
                    : aci.supervisor.getConfig?.() ?? null;
                  if (supStatus) {
                    aciSupervisorMode = supStatus.enabled ? supStatus.mode : 'off';
                  }
                  const lastErrFp = reasoningTracker.errorFingerprints.at(-1)?.summary ?? '';
                  const supRes = await aci.supervisor
                    .supervise({
                      query: input,
                      candidates: eligibleCandidates,
                      errorSummary: lastErrFp,
                      budgetSummary: `${Math.round(epochProbe.ratio * 100)}% (single=${epochProbe.tokensBefore}/${epochContextWindow}, cumulative=${cumulativeUsedTokens + epochProbe.tokensBefore}/${aci.engine.maxTotalTokens})`,
                      learnedGuidelines: aci.engine.getGuidelines?.() ?? [],
                      signal,
                      configOverride: aciSupervisorConfigOverride,
                    })
                    .catch(() => null);
                  if (supRes && !supRes.bypassed) {
                    if (supRes.model) {
                      dtocSupervisorCalls += 1;
                      aciSupervisorCalls += 1;
                      aciSupervisorModel = supRes.model;
                    }
                    aci.ledger?.recordSupervisorCall?.({
                      stage: 'dtoc',
                      model: supRes.model ?? aciSupervisorModel,
                      candidateCount: eligibleCandidates.length,
                      decisions: {
                        keepRefs: supRes.keepRefs ?? [],
                        compressRefs: supRes.compressRefs ?? [],
                      },
                      inputTokens: supRes.inputTokens ?? 0,
                      outputTokens: supRes.outputTokens ?? 0,
                      totalTokens: supRes.totalTokens ?? 0,
                      durationMs: supRes.durationMs ?? 0,
                      ok: supRes.ok !== false,
                      fallback: supRes.fallback ?? null,
                      step: steps,
                    });
                    keepRefs = Array.isArray(supRes.keepRefs) ? supRes.keepRefs : [];
                    compressRefs = Array.isArray(supRes.compressRefs) ? supRes.compressRefs : [];
                  }
                }
                const compResult = aci.engine.compress(requestOptions.messages, {
                  currentStep: steps,
                  tools: requestOptions.tools,
                  cumulativeUsedTokens,
                  contextWindow: epochContextWindow,
                  keepRefs,
                  compressRefs,
                  activeMutationTargets,
                });
                if (compResult?.triggered && compResult.pairClosedValid !== false && Array.isArray(compResult.messages)) {
                  messages = [...compResult.messages];
                  requestOptions = { ...requestOptions, messages };
                  this.eventRouter.emitPersisted({
                    sessionId,
                    turnId,
                    type: RUNTIME_EVENTS.CONTEXT_COMPACTED,
                    data: {
                      stage: 'aci_dtoc',
                      reason: compResult.reason,
                      epoch: compResult.epoch,
                      watermark: compResult.watermark,
                      step: steps,
                      compressedCount: compResult.compressedCount,
                      tokens: {
                        before: compResult.tokensBefore,
                        after: compResult.tokensAfter,
                      },
                      pairClosedValid: compResult.pairClosedValid,
                    },
                    audit: false,
                  });
                }
              }
            }
          }
          syncAciMetrics();
        }
        if (contextManager) {
          sm.transition(TURN_PHASES.COMPACTING, { step: steps, persist: profile?.persistTurn !== false });
          const compacted = await contextManager.prepareRequest(requestOptions, {
            step: steps,
            reasoningState: reasoningTracker.getState(),
          });
          requestOptions = compacted.options;
          if (compacted.stage && compacted.stage !== 'none') {
            if (Array.isArray(requestOptions?.messages)) {
              messages = [...requestOptions.messages];
              requestOptions = { ...requestOptions, messages };
            }
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
        let estimatedInputTokens = estimateRequestInputTokens(requestOptions);
        const nodeBudgetCaps = {
          maxSteps: explicitMaxSteps,
          maxTokens: maxTotalTokens,
          maxOutputTokens: explicitMaxOutput,
        };
        const tryEmergencyBudgetPrune = async (budgetRemaining) => {
          if (!(budgetRemaining > 2000 && estimatedInputTokens >= budgetRemaining)) {
            return false;
          }
          let emergency = null;
          try {
            emergency = await compactTwoStage(requestOptions, {
              contextWindow: Math.max(2048, Math.floor(budgetRemaining * 0.78)),
              reserveTokens: 384,
              keepRecentTokens: Math.max(768, Math.floor(budgetRemaining * 0.35)),
              summarize: null,
            });
          } catch {
            return false;
          }
          if (!emergency?.stage || emergency.stage === 'none') {
            return false;
          }
          let nextOpts = emergency.options;
          let nextEstimated = estimateRequestInputTokens(nextOpts);
          if (nextEstimated >= budgetRemaining && budgetRemaining > 2000) {
            try {
              const tight = await compactTwoStage(requestOptions, {
                contextWindow: Math.max(1024, budgetRemaining - 1800),
                reserveTokens: 256,
                keepRecentTokens: 512,
                summarize: null,
              });
              if (tight?.stage && tight.stage !== 'none') {
                const tightEst = estimateRequestInputTokens(tight.options);
                if (tightEst < nextEstimated) {
                  emergency = tight;
                  nextOpts = tight.options;
                  nextEstimated = tightEst;
                }
              }
            } catch {
              // ignore fallback prune failure
            }
          }
          if (nextEstimated >= estimatedInputTokens) {
            return false;
          }
          requestOptions = nextOpts;
          if (Array.isArray(requestOptions?.messages)) {
            messages = [...requestOptions.messages];
            requestOptions = { ...requestOptions, messages };
          }
          estimatedInputTokens = nextEstimated;
          reasoningTracker.recordBudgetPrune();
          this.eventRouter.emitPersisted({
            sessionId,
            turnId,
            type: RUNTIME_EVENTS.CONTEXT_COMPACTED,
            data: {
              stage: 'budget_prune',
              step: steps,
              tokens: emergency.tokens ?? estimatedInputTokens,
            },
            audit: false,
          });
          return true;
        };

        let activeReservation = null;
        if (budgetLedger && budgetContext?.treeId) {
          const makeReservation = () =>
            budgetLedger.reserveInference({
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
          try {
            activeReservation = makeReservation();
          } catch (reserveErr) {
            if (reserveErr?.code === 'TOKEN_BUDGET') {
              const availList = [
                reserveErr?.detail?.availableTokens,
                reserveErr?.detail?.nodeAvailable,
              ].filter((v) => v != null && Number.isFinite(Number(v)));
              const avail = availList.length > 0 ? Math.min(...availList.map(Number)) : 0;
              const pruned = await tryEmergencyBudgetPrune(avail);
              if (pruned && estimatedInputTokens < avail) {
                activeReservation = makeReservation();
              } else {
                throw reserveErr;
              }
            } else {
              throw reserveErr;
            }
          }
          requestOptions = {
            ...requestOptions,
            maxTokens: activeReservation.constrainedMaxOutputTokens,
          };
        } else if (maxTotalTokens !== null) {
          const localRemaining = Math.max(0, maxTotalTokens - (tm.totalIn + tm.totalOut));
          if (localRemaining > 2000 && estimatedInputTokens >= localRemaining) {
            await tryEmergencyBudgetPrune(localRemaining);
          }
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
                : ({ usage }) => tm.addUsage(usage),
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
          if (stepResult.route) {
            lastRoute = stepResult.route;
          }
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
          if (infErr?.route) {
            lastRoute = infErr.route;
          }
          if (infErr?.partialUsage) {
            tm.addUsage(infErr.partialUsage);
          }
          if (activeReservation?.reservationId && checkLeaseHeld(leaseGuard, { sessionId, turnId })) {
            try {
              if (
                infErr?.abortedBeforeProvider &&
                typeof budgetLedger.releaseReservation === 'function'
              ) {
                budgetLedger.releaseReservation(activeReservation.reservationId, {
                  reason: infErr?.code || 'ABORTED_BEFORE_PROVIDER',
                });
              } else {
                budgetLedger.settleReservation(activeReservation.reservationId, {
                  status: 'failed',
                  actualSteps: 1,
                  actualInputTokens: infErr?.partialUsage?.inputTokens ?? 0,
                  actualOutputTokens: infErr?.partialUsage?.outputTokens ?? 0,
                  errorCode: infErr?.code || 'INFERENCE_FAILED',
                  leaseGuard,
                });
              }
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
          if (drainSteering) {
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

          const monologueTrigger = reasoningTracker.recordAssistantTurn({
            text: stepResult.text,
            toolCallCount: 0,
            step: steps,
          });

          verifierEvents.push({
            type: 'turn/end',
            data: { reason: { kind: stepResult.finishReason || 'completed' } },
          });

          sm.transition(TURN_PHASES.VERIFYING, { step: steps, persist: profile?.persistTurn !== false });
          refreshContractReadiness();
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
            reasoningState: reasoningTracker.getState(),
            contractReadiness: lastContractReadiness,
            signal,
          });

          if (decision.action === 'continue_stop') {
            stopContinuedOnce = true;
            if (monologueTrigger) {
              if (monologueWarned) {
                stopReason = 'thrashing_circuit_break';
                break;
              }
              monologueWarned = true;
              this.eventRouter.emitPersisted({
                sessionId,
                turnId,
                type: RUNTIME_EVENTS.LOOP_THRASHING_WARNING,
                data: {
                  step: steps,
                  pattern: monologueTrigger.pattern,
                  fingerprint: monologueTrigger.fingerprint ?? null,
                  falsifiedAttemptCount: reasoningTracker.falsifiedAttempts.length,
                },
                audit: false,
              });
              messages.push({
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `${decision.note}\n\n${reasoningTracker.buildDiagnosticSteeringMessage(monologueTrigger)}`,
                  },
                ],
              });
              continue;
            }
            messages.push({ role: 'user', content: [{ type: 'text', text: decision.note }] });
            continue;
          }
          if (decision.action === 'repair') {
            repairedOnce = true;
            repairRound++;
            reasoningTracker.recordRepairRound({ step: steps });
            finalVerdict = decision.verdict;
            if (monologueTrigger && monologueWarned) {
              stopReason = 'thrashing_circuit_break';
              break;
            }
            this.eventRouter.emitPersisted({
              sessionId,
              turnId,
              type: RUNTIME_EVENTS.VERIFIER_REPAIR,
              data: {
                verdict: decision.verdict.verdict,
                reasons: decision.verdict.reasons,
              },
            });
            let noteText = decision.note;
            if (monologueTrigger && !monologueWarned) {
              monologueWarned = true;
              this.eventRouter.emitPersisted({
                sessionId,
                turnId,
                type: RUNTIME_EVENTS.LOOP_THRASHING_WARNING,
                data: {
                  step: steps,
                  pattern: monologueTrigger.pattern,
                  fingerprint: monologueTrigger.fingerprint ?? null,
                  falsifiedAttemptCount: reasoningTracker.falsifiedAttempts.length,
                },
                audit: false,
              });
              noteText = `${noteText}\n\n${reasoningTracker.buildDiagnosticSteeringMessage(monologueTrigger)}`;
            }
            messages.push({ role: 'user', content: [{ type: 'text', text: noteText }] });
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
          if (
            hadToolCalls &&
            !contractCompletionChecked &&
            steps < maxSteps &&
            !budgetReserveAdvised &&
            !budgetFinalCallAdvised &&
            (remainingTokens === null || remainingTokens > finalManifestReserve + estTurnCost) &&
            lastContractReadiness?.evaluated &&
            (!lastContractReadiness.ready ||
              lastContractReadiness.gaps?.some((g) => g.kind === 'ordering_precedence_verify'))
          ) {
            const actionableGaps = lastContractReadiness.gaps.filter(
              (g) =>
                g.kind === 'forbidden_mutation' ||
                g.kind === 'invalid_json' ||
                g.kind === 'missing_exports' ||
                g.kind === 'missing_constraint_ids' ||
                g.kind === 'ordering_precedence_verify' ||
                (g.kind === 'missing_deliverables' && reasoningTracker.filesMutated.length > 0),
            );
            if (actionableGaps.length > 0) {
              contractCompletionChecked = true;
              messages.push({
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `${lastContractReadiness.checklistText}\n请仅补齐上述明确缺失的契约交付项并确认验证通过后输出最终回复。`,
                  },
                ],
              });
              continue;
            }
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
        reasoningTracker.recordAssistantTurn({
          text: stepResult.text,
          toolCallCount: stepResult.toolCalls.length,
          step: steps,
        });
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
          getLivePolicy,
          getApprovedPrefixes,
          requestApproval,
          approvalManager,
          tainted: Boolean(execution?.tainted),
        });

        signal?.throwIfAborted?.();
        parentGuard?.();
        leaseGuard?.();

        const preparedBatch = executedBatch.map((item) => {
          const hint = selectionRecoveryHint?.(item, getModelTools);
          const output = hint ? `${item.output}\n${hint}` : item.output;
          return { ...item, output };
        });

        let admittedOutputs = preparedBatch.map((b) => b.output);
        if (aciAdmissionEnabled) {
          const lastErrFp = reasoningTracker.errorFingerprints.at(-1)?.summary ?? '';
          const errorFiles = (reasoningTracker.errorFingerprints ?? [])
            .map((fp) => String(fp.location || '').split(':')[0])
            .filter(Boolean);
          const errorSymbols = (reasoningTracker.errorFingerprints ?? [])
            .flatMap((fp) => [fp.errorType, fp.failingTarget])
            .filter(Boolean);
          const admitResult = await aci.engine.admitToolBatch(preparedBatch, {
            query: input,
            step: steps,
            errorFiles,
            errorSymbols,
            mutatedFiles: [...reasoningTracker.filesMutated],
            errorSummary: lastErrFp,
            contractHints: lastContractReadiness?.missingContractReads ?? [],
            supervisor: aci.supervisor ?? null,
            supervisorEnabled: aciSupervisorEnabled,
            supervisorConfigOverride: aciSupervisorConfigOverride,
            signal,
          });
          if (Array.isArray(admitResult?.admittedItems)) {
            admittedOutputs = admitResult.admittedItems.map(
              (it, idx) => it.admittedOutput ?? preparedBatch[idx].output,
            );
          }
          if (admitResult?.supervisorRes && !admitResult.supervisorRes.bypassed && admitResult.supervisorRes.model) {
            aciSupervisorCalls += 1;
            aciSupervisorModel = admitResult.supervisorRes.model;
          }
          syncAciMetrics();
        }

        let detectedThrashing = false;
        let batchTrigger = null;
        for (let batchIdx = 0; batchIdx < preparedBatch.length; batchIdx += 1) {
          const item = preparedBatch[batchIdx];
          const { tc, isError, durationMs, receipt, output } = item;
          const promptOutput = admittedOutputs[batchIdx] ?? output;
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
            content: [{ type: 'text', text: promptOutput }],
          });
          verifierEvents.push({
            type: 'tool/result',
            data: {
              callId: tc.id,
              name: tc.name,
              isError,
              content: output,
              effectiveArgs: item.parsedArgs,
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
          if (tm.thrashWarned && MUTATING_FILE_TOOLS.has(tc.name) && !isError) {
            tm.recentCallSigs = [];
          }
          const tmRepeat = tm.recordToolSignature(tc, isError, item.parsedArgs, item.pending);
          const reasoningEvent = reasoningTracker.recordToolResult({
            tc,
            args: item.parsedArgs,
            output,
            isError,
            pending: item.pending,
            receipt,
            step: steps,
          });
          if (reasoningEvent?.trigger) {
            detectedThrashing = true;
            batchTrigger = reasoningEvent.trigger;
          } else if (tmRepeat) {
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
            totalCacheRead: tm.totalCacheRead,
            totalCacheWrite: tm.totalCacheWrite,
            totalCacheEligible: tm.totalCacheEligible,
            lastToolCallIds: executedBatch.map((b) => b.tc.id),
          },
        });

        refreshContractReadiness();

        if (detectedThrashing) {
          const isNonFatalPattern =
            batchTrigger?.pattern === STUCK_PATTERNS.POLICY_BLOCK_LOOP ||
            batchTrigger?.pattern === STUCK_PATTERNS.SELF_TEST_CALIBRATION;
          if (isNonFatalPattern) {
            if (!nonFatalPatternsWarned.has(batchTrigger.pattern)) {
              nonFatalPatternsWarned.add(batchTrigger.pattern);
              if (batchTrigger.pattern === STUCK_PATTERNS.POLICY_BLOCK_LOOP) {
                policyBlockWarned = true;
              }
              const steeringText = reasoningTracker.buildDiagnosticSteeringMessage(batchTrigger);
              this.eventRouter.emitPersisted({
                sessionId,
                turnId,
                type: RUNTIME_EVENTS.LOOP_THRASHING_WARNING,
                data: {
                  step: steps,
                  pattern: batchTrigger.pattern,
                  fingerprint: batchTrigger.fingerprint ?? null,
                  falsifiedAttemptCount: reasoningTracker.falsifiedAttempts.length,
                },
                audit: false,
              });
              messages.push({
                role: 'user',
                content: [{ type: 'text', text: steeringText }],
              });
            }
          } else if (
            !tm.thrashWarned &&
            !(
              policyBlockWarned &&
              batchTrigger?.pattern === STUCK_PATTERNS.EXACT_REPEAT &&
              batchTrigger?.isPolicyRejection
            )
          ) {
            tm.thrashWarned = true;
            const steeringText = reasoningTracker.buildDiagnosticSteeringMessage(batchTrigger);
            this.eventRouter.emitPersisted({
              sessionId,
              turnId,
              type: RUNTIME_EVENTS.LOOP_THRASHING_WARNING,
              data: {
                step: steps,
                pattern: batchTrigger?.pattern ?? 'exact_repeat',
                fingerprint: batchTrigger?.fingerprint ?? null,
                falsifiedAttemptCount: reasoningTracker.falsifiedAttempts.length,
              },
              audit: false,
            });
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: steeringText,
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
              reasoningState: reasoningTracker.getState(),
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

      aci?.ledger?.recordOutcome?.({
        status: outcome.status,
        verifiedPass: outcome.verifiedPass,
        stopReason,
        steps,
      });
      syncAciMetrics();
      const reasoningMetrics = reasoningTracker.getMetrics({
        finalOutcomePassed: outcome.status === 'completed' && outcome.verdict?.accepted !== false,
        stopReason,
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
          cacheEligibleInputTokens: tm.totalCacheEligible,
        },
        route: lastRoute,
        verdict: outcome.verdict,
        verifiedPass: outcome.verifiedPass,
        failureKind: outcome.failureKind,
        reasoningMetrics,
        verifierEvents,
        phaseHistory: sm.history,
        deferredPhaseTransition: sm.deferredTerminalTransition ?? null,
      };
    } catch (err) {
      const classified = classifyError(err);
      const catchUsage = {
        inputTokens: tm.totalIn,
        outputTokens: tm.totalOut,
        cacheReadTokens: tm.totalCacheRead,
        cacheWriteTokens: tm.totalCacheWrite,
        cacheEligibleInputTokens: tm.totalCacheEligible,
      };
      aci?.ledger?.recordOutcome?.({
        status: 'failed',
        verifiedPass: false,
        stopReason: classified.code || err?.code || 'aborted',
        steps,
      });
      syncAciMetrics();
      const catchMetrics = reasoningTracker.getMetrics({
        finalOutcomePassed: false,
        stopReason: classified.code || err?.code || 'aborted',
      });
      if (err && typeof err === 'object') {
        err.reasoningMetrics = catchMetrics;
      }
      classified.usage = catchUsage;
      classified.steps = steps;
      classified.route = lastRoute;
      classified.reasoningMetrics = catchMetrics;
      // Fix D6: On LEASE_LOST (or if lease was already lost before error), exit cleanly without corrupting turn phase
      if (isLeaseLostError(classified) || !checkLeaseHeld(leaseGuard, { sessionId, turnId })) {
        const leaseErr = isLeaseLostError(classified)
          ? classified
          : new RecoveryError('LEASE_LOST', {
              message: `Lease lost during turn ${turnId}`,
              cause: err,
            });
        leaseErr.reasoningMetrics = catchMetrics;
        throw leaseErr;
      }
      if (isShutdownAbort(signal, err) || isShutdownAbort(signal, classified)) {
        classified.isShutdown = true;
        throw classified;
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
      classified.deferredPhaseTransition = sm.deferredTerminalTransition ?? null;
      throw classified;
    }
  }
}
