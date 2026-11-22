export const VERDICT_KINDS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  BLOCK_RECONCILIATION: 'block_reconciliation',
});

export const TERMINAL_STATES = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  RECONCILING: 'reconciling',
  PARKED: 'parked',
});

export function isTerminalState(state) {
  return (
    state === TERMINAL_STATES.COMPLETED ||
    state === TERMINAL_STATES.FAILED ||
    state === TERMINAL_STATES.CANCELLED
  );
}

/**
 * Explicit verdict for plain-text direct conversation where no tool execution or
 * artifact verification was required and no integrity/reconciliation blocker exists.
 */
export function buildPlainTextPassVerdict(checks = {}) {
  return {
    verdict: VERDICT_KINDS.PASS,
    accepted: true,
    evidenceRequired: false,
    verificationMode: 'plain_text_no_tools',
    reasons: [],
    evidenceCount: 0,
    checks: {
      pendingReconciliations: 0,
      failedShellReceipts: 0,
      missingDiskFiles: [],
      ...checks,
    },
  };
}

/**
 * Normalizes any verifier output into a consistent verdict contract across
 * Direct, Child, and Swarm execution paths.
 */
export function normalizeVerdict(
  rawVerdict,
  { evidenceRequired = true, evidenceCount = 0, verificationMode = null } = {},
) {
  if (!rawVerdict || typeof rawVerdict !== 'object') {
    return buildPlainTextPassVerdict();
  }
  const kind =
    rawVerdict.verdict === VERDICT_KINDS.BLOCK_RECONCILIATION
      ? VERDICT_KINDS.BLOCK_RECONCILIATION
      : rawVerdict.verdict === VERDICT_KINDS.PASS && rawVerdict.accepted !== false
        ? VERDICT_KINDS.PASS
        : VERDICT_KINDS.FAIL;
  const effEvidenceRequired =
    rawVerdict.evidenceRequired !== undefined
      ? Boolean(rawVerdict.evidenceRequired)
      : Boolean(evidenceRequired);
  const effMode =
    rawVerdict.verificationMode ??
    verificationMode ??
    (kind === VERDICT_KINDS.BLOCK_RECONCILIATION
      ? 'reconciliation_gate'
      : effEvidenceRequired
        ? 'evidence_checked'
        : 'plain_text_no_tools');

  return {
    ...rawVerdict,
    verdict: kind,
    accepted: kind === VERDICT_KINDS.PASS,
    evidenceRequired: effEvidenceRequired,
    verificationMode: effMode,
    reasons: Array.isArray(rawVerdict.reasons) ? [...rawVerdict.reasons] : [],
    evidenceCount: Number(rawVerdict.evidenceCount ?? evidenceCount ?? 0),
    checks: rawVerdict.checks ?? {},
  };
}

/**
 * Derives the authoritative turn outcome from loop exit reason + final effective verdict.
 * Clearly separates "execution loop ended" from "task verification passed".
 */
export function resolveTurnOutcome({
  loopStopReason = 'completed',
  verdict = null,
  hasPendingReconciliation = false,
  evidenceRequired = false,
  evidenceCount = 0,
} = {}) {
  const normalized = verdict
    ? normalizeVerdict(verdict, { evidenceRequired, evidenceCount })
    : evidenceRequired
      ? normalizeVerdict(
          {
            verdict: VERDICT_KINDS.FAIL,
            accepted: false,
            reasons: ['VERIFICATION_MISSING: required final verification did not produce a passing verdict'],
          },
          { evidenceRequired: true, evidenceCount },
        )
      : buildPlainTextPassVerdict();

  if (
    hasPendingReconciliation ||
    normalized.verdict === VERDICT_KINDS.BLOCK_RECONCILIATION ||
    loopStopReason === 'block_reconciliation'
  ) {
    const recVerdict =
      normalized.verdict === VERDICT_KINDS.BLOCK_RECONCILIATION
        ? normalized
        : normalizeVerdict(
            {
              ...normalized,
              verdict: VERDICT_KINDS.BLOCK_RECONCILIATION,
              accepted: false,
              reasons: normalized.reasons.length
                ? normalized.reasons
                : ['存在状态未知的外部副作用 (outcome_unknown)，需人工核对后方可完成'],
            },
            { evidenceRequired: true, evidenceCount, verificationMode: 'reconciliation_gate' },
          );
    return {
      status: TERMINAL_STATES.RECONCILING,
      phase: TERMINAL_STATES.RECONCILING,
      errorCode: 'RECONCILIATION_REQUIRED',
      errorMessage: recVerdict.reasons[0] || 'Reconciliation required before completion',
      verdict: recVerdict,
      verifiedPass: null,
      failureKind: null,
    };
  }

  if (loopStopReason === 'thrashing_circuit_break') {
    const reason = 'LOOP_THRASHING_ABORT: 连续重复相同无效工具调用触发防死循环熔断';
    const failVerdict = normalizeVerdict(
      {
        ...normalized,
        verdict: VERDICT_KINDS.FAIL,
        accepted: false,
        reasons: [...new Set([...normalized.reasons, reason])],
      },
      { evidenceRequired: true, evidenceCount, verificationMode: 'loop_guard' },
    );
    return {
      status: TERMINAL_STATES.FAILED,
      phase: TERMINAL_STATES.FAILED,
      errorCode: 'LOOP_THRASHING_ABORT',
      errorMessage: failVerdict.reasons.join('; '),
      verdict: failVerdict,
      verifiedPass: false,
      failureKind: 'tool_failure',
    };
  }

  if (loopStopReason === 'max_steps') {
    const reason = 'STEP_BUDGET_EXHAUSTED: 达到最大步数上限仍未完成最终交付';
    const failVerdict = normalizeVerdict(
      {
        ...normalized,
        verdict: VERDICT_KINDS.FAIL,
        accepted: false,
        reasons: [...new Set([...normalized.reasons, reason])],
      },
      { evidenceRequired: true, evidenceCount, verificationMode: 'step_budget' },
    );
    return {
      status: TERMINAL_STATES.FAILED,
      phase: TERMINAL_STATES.FAILED,
      errorCode: 'STEP_BUDGET_EXHAUSTED',
      errorMessage: failVerdict.reasons.join('; '),
      verdict: failVerdict,
      verifiedPass: false,
      failureKind: 'budget',
    };
  }

  if (normalized.verdict !== VERDICT_KINDS.PASS || !normalized.accepted) {
    return {
      status: TERMINAL_STATES.FAILED,
      phase: TERMINAL_STATES.FAILED,
      errorCode: normalized.status === 'EVIDENCE_INCOMPLETE' ? 'EVIDENCE_INCOMPLETE' : 'VERIFICATION_FAILED',
      errorMessage:
        normalized.reasons.join('; ') || '任务结果未通过验证门禁（已达到修复上限）',
      verdict: normalized,
      verifiedPass: false,
      failureKind: 'verification_failure',
    };
  }

  // Truthful verification label: only claim verifiedPass=true when evidence-backed verification ran;
  // plain-text 0-tool chats stay null so feedback doesn't inflate verificationPassRate.
  const verifiedPass =
    normalized.evidenceRequired && normalized.verificationMode !== 'plain_text_no_tools'
      ? true
      : null;

  return {
    status: TERMINAL_STATES.COMPLETED,
    phase: TERMINAL_STATES.COMPLETED,
    errorCode: null,
    errorMessage: null,
    verdict: normalized,
    verifiedPass,
    failureKind: null,
  };
}

/**
 * Derives the authoritative terminal/reconciling status for a Swarm run from both
 * active node states AND the actual EvidenceVerifier verdict.
 */
export function resolveSwarmOutcome({
  nodes = [],
  replacedKeys = new Set(),
  verdict = null,
  hasPendingReconciliation = false,
} = {}) {
  const activeNodes = nodes.filter((n) => !replacedKeys.has(n.nodeKey));
  const normalized = verdict
    ? normalizeVerdict(verdict, { evidenceRequired: true })
    : normalizeVerdict({ verdict: VERDICT_KINDS.PASS, accepted: true, reasons: [] });

  const reconcilingNodes = activeNodes.filter((n) => n.status === 'reconciling');
  if (
    hasPendingReconciliation ||
    reconcilingNodes.length > 0 ||
    normalized.verdict === VERDICT_KINDS.BLOCK_RECONCILIATION
  ) {
    const recVerdict =
      normalized.verdict === VERDICT_KINDS.BLOCK_RECONCILIATION
        ? normalized
        : normalizeVerdict(
            {
              ...normalized,
              verdict: VERDICT_KINDS.BLOCK_RECONCILIATION,
              accepted: false,
              reasons: [
                ...new Set([
                  ...normalized.reasons,
                  'Swarm run has unresolved unknown-outcome side effects requiring reconciliation',
                ]),
              ],
            },
            { evidenceRequired: true, verificationMode: 'reconciliation_gate' },
          );
    return {
      status: TERMINAL_STATES.RECONCILING,
      errorCode: 'RECONCILIATION_REQUIRED',
      errorMessage: recVerdict.reasons.join('; '),
      verdict: recVerdict,
    };
  }

  const budgetCodes = new Set([
    'BUDGET_EXCEEDED',
    'TOKEN_BUDGET',
    'STEP_BUDGET',
    'STEP_BUDGET_EXHAUSTED',
    'COST_BUDGET',
    'TASK_DEADLINE',
  ]);
  const isBudgetCode = (code) => budgetCodes.has(String(code || ''));
  const budgetNodes = activeNodes.filter((n) => isBudgetCode(n.errorCode));

  const failedNodes = activeNodes.filter((n) => n.status === 'failed');
  if (failedNodes.length > 0) {
    const primaryFailed =
      failedNodes.find((n) => n.errorCode !== 'DEPENDENCY_FAILED') ?? failedNodes[0] ?? null;
    const isBudgetFail =
      budgetNodes.length > 0 && (!primaryFailed || isBudgetCode(primaryFailed.errorCode));
    const errorCode = isBudgetFail
      ? 'BUDGET_EXCEEDED'
      : primaryFailed?.errorCode || 'SWARM_NODE_FAILED';
    const errorMessage = isBudgetFail
      ? primaryFailed?.errorMessage ||
        budgetNodes[0]?.errorMessage ||
        'Task-tree budget exhausted before completion'
      : primaryFailed?.errorMessage || primaryFailed?.errorCode || 'Swarm node failed';
    const reasons = [
      ...normalized.reasons,
      `${errorCode}: ${failedNodes.map((n) => `${n.nodeKey}(${n.errorCode || 'failed'})`).join(', ')}${primaryFailed?.errorMessage ? ` - ${primaryFailed.errorMessage}` : ''}`,
    ];
    const failVerdict = normalizeVerdict(
      { ...normalized, verdict: VERDICT_KINDS.FAIL, accepted: false, reasons: [...new Set(reasons)] },
      { evidenceRequired: true },
    );
    return {
      status: TERMINAL_STATES.FAILED,
      errorCode,
      errorMessage,
      verdict: failVerdict,
    };
  }

  const incompleteNodes = activeNodes.filter((n) => n.status !== 'completed');
  if (incompleteNodes.length > 0) {
    const budgetStopped = incompleteNodes.some((n) => isBudgetCode(n.errorCode));
    const code = budgetStopped ? 'BUDGET_EXCEEDED' : 'SWARM_INCOMPLETE_NODES';
    const reasons = [
      ...normalized.reasons,
      `${code}: incomplete required node(s): ${incompleteNodes.map((n) => `${n.nodeKey}(${n.status})`).join(', ')}`,
    ];
    const failVerdict = normalizeVerdict(
      { ...normalized, verdict: VERDICT_KINDS.FAIL, accepted: false, reasons: [...new Set(reasons)] },
      { evidenceRequired: true },
    );
    return {
      status: TERMINAL_STATES.FAILED,
      errorCode: code,
      errorMessage: incompleteNodes[0]?.errorMessage || failVerdict.reasons.join('; '),
      verdict: failVerdict,
    };
  }

  if (normalized.verdict !== VERDICT_KINDS.PASS || !normalized.accepted) {
    return {
      status: TERMINAL_STATES.FAILED,
      errorCode: 'SWARM_VERIFICATION_FAILED',
      errorMessage: normalized.reasons.join('; ') || 'Swarm verification gate failed',
      verdict: normalized,
    };
  }

  return {
    status: TERMINAL_STATES.COMPLETED,
    errorCode: null,
    errorMessage: null,
    verdict: normalized,
  };
}

/**
 * Classifies a failure into a truthful feedback label category.
 */
export function classifyFailureKind(
  err,
  { isCancelled = false, isVerificationFailure = false, hasToolFailure = false } = {},
) {
  if (isCancelled || err?.category === 'cancellation' || err?.code === 'PARENT_CANCELLED') {
    return 'cancelled';
  }
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? err ?? '');
  if (code === 'TIMEOUT' || code === 'ETIMEDOUT' || /\btimeout\b|timed out/i.test(msg)) {
    return 'timeout';
  }
  if (
    err?.category === 'budget' ||
    code === 'BUDGET_EXCEEDED' ||
    code === 'STEP_BUDGET_EXHAUSTED' ||
    code === 'TOKEN_BUDGET' ||
    code === 'TASK_DEADLINE'
  ) {
    return 'budget';
  }
  if (isVerificationFailure || code === 'VERIFICATION_FAILED' || code === 'SWARM_VERIFICATION_FAILED') {
    return 'verification_failure';
  }
  if (hasToolFailure || err?.category === 'tool' || code === 'LOOP_THRASHING_ABORT') {
    return 'tool_failure';
  }
  return 'task_failure';
}

/**
 * Isolates non-critical side effects (telemetry, model feedback, metrics, audit logs)
 * so they NEVER block terminal DB commits, NEVER block SSE publishing, and NEVER
 * overwrite the original error.
 */
export function safeIsolateSideEffect(fn, onError = null) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.catch((err) => {
        try {
          onError?.(err);
        } catch {
          // double-isolated
        }
        return null;
      });
    }
    return out;
  } catch (err) {
    try {
      onError?.(err);
    } catch {
      // double-isolated
    }
    return null;
  }
}
