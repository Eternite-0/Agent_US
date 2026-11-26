import { isAbsolute, relative, resolve } from 'node:path';
import { scanCommandSyntax } from '../tools/command-analyzer.js';

export const CONSECUTIVE_DUPLICATE_THRESHOLD = 6;
export const DUPLICATE_CALL_REMINDER =
  '[Note] This exact tool call with identical arguments has been repeated 6 consecutive times; inspect the output or try a different approach.';

export const STUCK_PATTERNS = Object.freeze({
  EXACT_REPEAT: 'exact_repeat',
});

export const READ_TOOLS = Object.freeze(
  new Set([
    'read_file',
    'read_blob',
    'expand_context',
    'compute_file_digest',
    'grep',
    'glob',
    'inspect_repository',
    'query_symbol_graph',
    'search_history',
  ]),
);

export const FILE_READ_TOOLS = Object.freeze(new Set(['read_file', 'read_blob']));

export const MUTATING_FILE_TOOLS = Object.freeze(
  new Set(['write_file', 'edit_file', 'apply_patch', 'delete_file']),
);

const VERIFICATION_SCRIPT_RE =
  /^(?:tests?|checks?|lint|build|typecheck)(?::[a-z0-9:_-]+)?$/i;

const DOC_MUTATION_PATH_RE = /(?:^|\/)(?:[^/]+\.(?:md|txt)|license(?:\.[^/]*)?|\.gitignore)$/i;
const TEST_MUTATION_PATH_RE =
  /(?:^|\/)(?:tests?|__tests__)\/|\/?[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i;

/**
 * Recognizes synchronous verification commands (single command, no compound/substitution).
 */
export function isVerificationCommand(command) {
  if (typeof command !== 'string') return false;
  const { tokens, hasCompound, hasSubstitution } = scanCommandSyntax(command);
  if (hasCompound || hasSubstitution || !tokens.length) return false;
  const [program, sub, target] = tokens;
  const bin = program?.replace(/\.exe$/i, '')?.toLowerCase();
  if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn' || bin === 'bun') {
    return sub === 'run'
      ? VERIFICATION_SCRIPT_RE.test(target ?? '')
      : VERIFICATION_SCRIPT_RE.test(sub ?? '');
  }
  if (bin === 'npx') {
    return ['tsc', 'vitest', 'jest', 'eslint', 'pytest'].includes(sub);
  }
  if (bin === 'node') return sub === '--test' || sub === '--check';
  if (bin === 'cargo') return ['test', 'check', 'clippy', 'build'].includes(sub);
  if (bin === 'go') return ['test', 'vet', 'build'].includes(sub);
  if (bin === 'python' || bin === 'python3') {
    return sub === '-m' && ['pytest', 'unittest'].includes(target);
  }
  return ['pytest', 'vitest', 'jest', 'tsc', 'eslint'].includes(bin);
}

/**
 * Normalizes a workspace path to forward-slash workspace-relative form when possible.
 */
export function normalizeReasoningPath(rawPath, workspaceRoot = null) {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  if (workspaceRoot) {
    try {
      const base = resolve(String(workspaceRoot));
      const full = resolve(base, trimmed);
      const rel = relative(base, full);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
        return rel.replace(/\\/g, '/').replace(/^\.\//, '');
      }
      if (rel === '') return '.';
    } catch {
      // fall through to lexical normalization
    }
  }

  return trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function safeParseToolArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object' && !Array.isArray(rawArgs)) return rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Extracts normalized file paths touched by `write_file`, `edit_file`, `apply_patch`, or `delete_file`.
 */
export function extractMutatedFilesFromToolCall(toolName, rawArgs, workspaceRoot = null) {
  const args = safeParseToolArgs(rawArgs);
  const paths = [];
  const addPath = (p) => {
    const norm = normalizeReasoningPath(p, workspaceRoot);
    if (norm && !paths.includes(norm)) paths.push(norm);
  };

  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'delete_file') {
    if (typeof args.path === 'string') addPath(args.path);
    return paths;
  }

  if (toolName === 'apply_patch') {
    if (typeof args.path === 'string') addPath(args.path);
    const patchText =
      typeof args.patch === 'string'
        ? args.patch
        : typeof args.patchText === 'string'
          ? args.patchText
          : typeof args.input === 'string'
            ? args.input
            : '';
    if (patchText) {
      const lines = patchText.replace(/\r\n/g, '\n').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        let matchedPatchHeader = false;
        for (const prefix of [
          '*** Add File: ',
          '*** Update File: ',
          '*** Delete File: ',
          '*** Move to: ',
        ]) {
          if (trimmed.startsWith(prefix)) {
            addPath(trimmed.slice(prefix.length));
            matchedPatchHeader = true;
          }
        }
        if (!matchedPatchHeader) {
          const uniMatch = /^(?:\+\+\+|---)\s+(?:a\/|b\/)?(.+?)(?:\t.*)?$/.exec(trimmed);
          if (uniMatch) {
            const candidate = uniMatch[1].trim();
            if (candidate && candidate !== '/dev/null' && candidate !== 'dev/null') {
              addPath(candidate);
            }
          }
        }
      }
    }
  }

  return paths;
}

/**
 * Classifies a normalized workspace path into `doc`, `baseline_test`, `self_test`, or `src`.
 */
export function classifyMutationPath(
  rawPath,
  { workspaceRoot = null, baselineTestFiles = [], selfAuthoredTestFiles = [] } = {},
) {
  const norm =
    normalizeReasoningPath(rawPath, workspaceRoot) ??
    String(rawPath ?? '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
  if (!norm) return 'src';
  if (DOC_MUTATION_PATH_RE.test(norm)) return 'doc';
  if (TEST_MUTATION_PATH_RE.test(norm)) {
    const baselineSet =
      baselineTestFiles instanceof Set ? baselineTestFiles : new Set(baselineTestFiles);
    const selfSet =
      selfAuthoredTestFiles instanceof Set ? selfAuthoredTestFiles : new Set(selfAuthoredTestFiles);
    if (selfSet.has(norm)) return 'self_test';
    if (baselineSet.has(norm)) return 'baseline_test';
    return 'self_test';
  }
  return 'src';
}

/**
 * Pure byte-level serialization key for consecutive exact-duplicate tool call detection.
 * Preserves exact tool name and raw JSON-serialized args bytes without heuristic canonicalization.
 */
export function serializeToolCallKey(tc, fallbackArgs = undefined) {
  const name = String(tc?.name ?? '');
  let rawSerialized = '';
  if (typeof tc?.arguments === 'string') {
    rawSerialized = tc.arguments;
  } else if (tc?.arguments !== undefined) {
    try {
      rawSerialized = JSON.stringify(tc.arguments);
    } catch {
      rawSerialized = String(tc.arguments);
    }
  } else if (fallbackArgs !== undefined) {
    try {
      rawSerialized = typeof fallbackArgs === 'string' ? fallbackArgs : JSON.stringify(fallbackArgs);
    } catch {
      rawSerialized = String(fallbackArgs);
    }
  }
  return `${name}\0${rawSerialized}`;
}

/**
 * Ultra-lightweight passive execution observer + pure byte-level exact-duplicate
 * call dedup reminder (6 consecutive byte-identical tool name + JSON args).
 * NEVER aborts, kills sessions, or injects regex-driven error-signature interventions.
 */
export class ExecutionReasoningTracker {
  constructor({ workspaceRoot = null } = {}) {
    this.workspaceRoot = workspaceRoot;
    this.seq = 0;

    // Pure byte-level consecutive duplicate call state
    this._lastExactCallKey = null;
    this._consecutiveExactCount = 0;
    this.duplicateReminderCount = 0;

    // Passive telemetry state
    this.filesRead = [];
    this._filesReadSet = new Set();
    this.filesMutated = [];
    this._filesMutatedSet = new Set();
    this._mutatedSrcSet = new Set();
    this._srcMutationSeqByPath = new Map();
    this._mutatedDocSet = new Set();
    this.rootCauseFilesReadBeforeEdit = [];
    this.verifications = [];

    this._firstMutationSeq = -1;
    this._firstCodeMutationSeq = -1;
    this._lastMutationSeq = -1;
    this._lastCodeMutationSeq = -1;
    this._lastPassingVerificationSeq = -1;

    this.errorFingerprints = [];
    this.falsifiedAttempts = [];
    this.stuckDetections = [];
    this._antiThrashingTriggered = false;
    this._repairRounds = 0;
    this._policyBlockCount = 0;
    this._budgetReserveAdvised = false;
    this._budgetFinalCallAdvised = false;
    this._budgetPruneCount = 0;
    this.ineffectiveActionCount = 0;
    this._aciMetrics = {
      aciProfile: null,
      admissionEnabled: null,
      dtocEnabled: null,
      dtocPolicy: null,
      dtocMinPromptTokens: null,
      decisions: { DIRECT: 0, SUPPORTING: 0, DEFER: 0, DUPLICATE: 0, IRRELEVANT: 0 },
      admissionDecisions: { DIRECT: 0, SUPPORTING: 0, DEFER: 0, DUPLICATE: 0, IRRELEVANT: 0 },
      admissionOriginalTokens: 0,
      admissionInjectedTokens: 0,
      admissionSavedTokens: 0,
      offloadedCount: 0,
      savedTokens: 0,
      totalAciSavedTokens: 0,
      restoredCount: 0,
      hashVerifiedRestores: 0,
      partialRecoveries: 0,
      fullRecoveries: 0,
      recoveryTokensSaved: 0,
      supersededEvictions: 0,
      supersededTokensSaved: 0,
      trajectoryTriggeredEpochs: 0,
      antiThrashingTriggered: false,
      supervisorCircuitOpen: false,
      criticalContextRecall: null,
      supervisorCalls: 0,
      supervisorMode: null,
      supervisorModel: null,
      supervisorCost: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0, fallbackCount: 0 },
      recoveryStats: {
        totalRecoveries: 0,
        hashVerifiedCount: 0,
        tokensRestored: 0,
        partialRecoveries: 0,
        fullRecoveries: 0,
        recoveryTokensSaved: 0,
      },
      epochTransitions: 0,
      ledger: null,
      aciTelemetry: null,
    };
    this._budgetWatermarks = null;
  }

  get hasUnverifiedMutationsAfterLastPass() {
    return this._lastCodeMutationSeq > this._lastPassingVerificationSeq;
  }

  get verificationCount() {
    return this.verifications.length;
  }

  get lastRunTestsPassed() {
    return this.verifications.length > 0 && this.verifications.at(-1)?.passed === true;
  }

  get unverifiedSrcMutations() {
    let count = 0;
    for (const seq of this._srcMutationSeqByPath.values()) {
      if (seq > this._lastPassingVerificationSeq) count += 1;
    }
    return count;
  }

  seedReadFiles(paths = []) {
    for (const rawPath of paths ?? []) {
      const normPath = normalizeReasoningPath(rawPath, this.workspaceRoot);
      if (!normPath) continue;
      if (!this._filesReadSet.has(normPath)) {
        this._filesReadSet.add(normPath);
        this.filesRead.push(normPath);
      }
      if (this._firstCodeMutationSeq === -1 && !this.rootCauseFilesReadBeforeEdit.includes(normPath)) {
        this.rootCauseFilesReadBeforeEdit.push(normPath);
      }
    }
  }

  updateBudgetWatermarks(watermarks = null) {
    if (!watermarks || typeof watermarks !== 'object') {
      this._budgetWatermarks = null;
      return;
    }
    this._budgetWatermarks = {
      usedTokens: Math.max(0, Math.trunc(Number(watermarks.usedTokens ?? 0))),
      maxTokens:
        watermarks.maxTokens != null && Number.isFinite(Number(watermarks.maxTokens))
          ? Math.max(0, Math.trunc(Number(watermarks.maxTokens)))
          : null,
      ratio: Number.isFinite(Number(watermarks.ratio))
        ? Number(Math.max(0, Number(watermarks.ratio)).toFixed(4))
        : 0,
      reserveTokens: Math.max(0, Math.trunc(Number(watermarks.reserveTokens ?? 0))),
      postTestReserveActive: Boolean(watermarks.postTestReserveActive),
      dtocWatermark:
        watermarks.dtocWatermark != null && Number.isFinite(Number(watermarks.dtocWatermark))
          ? Number(Math.max(0, Number(watermarks.dtocWatermark)).toFixed(4))
          : 0,
      supervisorCircuitOpen: Boolean(watermarks.supervisorCircuitOpen),
    };
  }

  updateAciMetrics(patch = null) {
    if (!patch || typeof patch !== 'object') return;
    const numericFields = [
      'dtocMinPromptTokens',
      'admissionOriginalTokens',
      'admissionInjectedTokens',
      'admissionSavedTokens',
      'offloadedCount',
      'savedTokens',
      'totalAciSavedTokens',
      'restoredCount',
      'hashVerifiedRestores',
      'partialRecoveries',
      'fullRecoveries',
      'recoveryTokensSaved',
      'supersededEvictions',
      'supersededTokensSaved',
      'trajectoryTriggeredEpochs',
      'supervisorCalls',
      'epochTransitions',
    ];
    for (const key of numericFields) {
      if (patch[key] != null && Number.isFinite(Number(patch[key]))) {
        this._aciMetrics[key] = Math.max(0, Math.trunc(Number(patch[key])));
      }
    }
    for (const key of ['aciProfile', 'dtocPolicy', 'supervisorMode', 'supervisorModel']) {
      if (patch[key] !== undefined) {
        this._aciMetrics[key] = patch[key] ? String(patch[key]) : null;
      }
    }
    for (const key of ['admissionEnabled', 'dtocEnabled']) {
      if (patch[key] !== undefined) {
        this._aciMetrics[key] = patch[key] === null ? null : Boolean(patch[key]);
      }
    }
    if (patch.supervisorCircuitOpen !== undefined) {
      this._aciMetrics.supervisorCircuitOpen = Boolean(patch.supervisorCircuitOpen);
    }
    if (patch.criticalContextRecall !== undefined) {
      this._aciMetrics.criticalContextRecall =
        patch.criticalContextRecall === null
          ? null
          : Number.isFinite(Number(patch.criticalContextRecall))
            ? Math.max(0, Math.min(1, Number(Number(patch.criticalContextRecall).toFixed(4))))
            : this._aciMetrics.criticalContextRecall;
    }
    for (const key of ['decisions', 'admissionDecisions']) {
      if (patch[key] && typeof patch[key] === 'object') {
        this._aciMetrics[key] = {
          DIRECT: Number(patch[key].DIRECT || 0),
          SUPPORTING: Number(patch[key].SUPPORTING || 0),
          DEFER: Number(patch[key].DEFER || 0),
          DUPLICATE: Number(patch[key].DUPLICATE || 0),
          IRRELEVANT: Number(patch[key].IRRELEVANT || 0),
        };
      }
    }
    if (patch.supervisorCost && typeof patch.supervisorCost === 'object') {
      this._aciMetrics.supervisorCost = {
        calls: Number(patch.supervisorCost.calls || 0),
        inputTokens: Number(patch.supervisorCost.inputTokens || 0),
        outputTokens: Number(patch.supervisorCost.outputTokens || 0),
        totalTokens: Number(patch.supervisorCost.totalTokens || 0),
        durationMs: Number(patch.supervisorCost.durationMs || 0),
        fallbackCount: Number(patch.supervisorCost.fallbackCount || 0),
      };
    }
    if (patch.recoveryStats && typeof patch.recoveryStats === 'object') {
      this._aciMetrics.recoveryStats = {
        totalRecoveries: Number(patch.recoveryStats.totalRecoveries || 0),
        hashVerifiedCount: Number(patch.recoveryStats.hashVerifiedCount || 0),
        tokensRestored: Number(patch.recoveryStats.tokensRestored || 0),
        partialRecoveries: Number(
          patch.recoveryStats.partialRecoveries ?? this._aciMetrics.partialRecoveries ?? 0,
        ),
        fullRecoveries: Number(
          patch.recoveryStats.fullRecoveries ?? this._aciMetrics.fullRecoveries ?? 0,
        ),
        recoveryTokensSaved: Number(
          patch.recoveryStats.recoveryTokensSaved ?? this._aciMetrics.recoveryTokensSaved ?? 0,
        ),
      };
    }
    if (patch.ledger !== undefined) {
      this._aciMetrics.ledger = patch.ledger ? structuredClone(patch.ledger) : null;
    }
    if (patch.aciTelemetry !== undefined) {
      this._aciMetrics.aciTelemetry = patch.aciTelemetry ? structuredClone(patch.aciTelemetry) : null;
    }
  }

  markBudgetReserveAdvised() {
    this._budgetReserveAdvised = true;
  }

  markBudgetFinalCallAdvised() {
    this._budgetFinalCallAdvised = true;
  }

  recordBudgetPrune() {
    this._budgetPruneCount += 1;
    return this._budgetPruneCount;
  }

  recordRepairRound() {
    this._repairRounds += 1;
    return this._repairRounds;
  }

  recordAssistantTurn() {
    this.seq += 1;
    return null;
  }

  recordToolResult({
    tc,
    args = null,
    output = '',
    isError = false,
    pending = false,
    receipt = null,
    step = 0,
  } = {}) {
    const seq = ++this.seq;
    const toolName = tc?.name ?? receipt?.toolName ?? '';
    const parsedArgs = args ?? safeParseToolArgs(tc?.arguments);
    const status = receipt?.status ?? (isError ? 'failed' : 'finished');
    const exitCode = typeof receipt?.exitCode === 'number' ? receipt.exitCode : null;
    const isPolicyRejection =
      status === 'rejected_before_effect' ||
      receipt?.errorCode === 'APPROVAL_DENIED' ||
      receipt?.errorCode === 'POLICY_DENIED';
    const effectiveIsError =
      Boolean(isError) ||
      isPolicyRejection ||
      status === 'failed' ||
      (typeof exitCode === 'number' && exitCode !== 0);

    if (pending && !effectiveIsError) {
      return {
        duplicateReminder: null,
        consecutiveDuplicateCount: 0,
        trigger: null,
        verification: null,
        mutatedFiles: [],
        readFiles: [],
      };
    }

    if (isPolicyRejection) {
      this._policyBlockCount += 1;
    }

    // Pure byte-level exact duplicate call dedup protection:
    // 6 consecutive calls with byte-identical tool name and JSON-serialized args -> append short tail reminder, NEVER abort.
    const exactKey = serializeToolCallKey(tc, parsedArgs);
    if (exactKey === this._lastExactCallKey) {
      this._consecutiveExactCount += 1;
    } else {
      this._lastExactCallKey = exactKey;
      this._consecutiveExactCount = 1;
    }
    const consecutiveDuplicateCount = this._consecutiveExactCount;
    let duplicateReminder = null;
    let trigger = null;
    if (this._consecutiveExactCount >= CONSECUTIVE_DUPLICATE_THRESHOLD) {
      duplicateReminder = DUPLICATE_CALL_REMINDER;
      this.duplicateReminderCount += 1;
      this.ineffectiveActionCount += 1;
      this._consecutiveExactCount = 0;
      this._lastExactCallKey = null;
      trigger = {
        pattern: STUCK_PATTERNS.EXACT_REPEAT,
        step,
        seq,
        toolName,
        count: CONSECUTIVE_DUPLICATE_THRESHOLD,
        summary: `Byte-identical call ${toolName} repeated ${CONSECUTIVE_DUPLICATE_THRESHOLD} consecutive times`,
        warningIssued: true,
      };
      this.stuckDetections.push(trigger);
    }

    // Passive read & mutation observation
    const readFiles = [];
    if (!effectiveIsError && FILE_READ_TOOLS.has(toolName) && typeof parsedArgs.path === 'string') {
      const normPath = normalizeReasoningPath(parsedArgs.path, this.workspaceRoot);
      if (normPath) {
        readFiles.push(normPath);
        if (!this._filesReadSet.has(normPath)) {
          this._filesReadSet.add(normPath);
          this.filesRead.push(normPath);
        }
        if (this._firstCodeMutationSeq === -1 && !this.rootCauseFilesReadBeforeEdit.includes(normPath)) {
          this.rootCauseFilesReadBeforeEdit.push(normPath);
        }
      }
    }

    let mutatedFiles = [];
    if (!effectiveIsError && MUTATING_FILE_TOOLS.has(toolName)) {
      mutatedFiles = extractMutatedFilesFromToolCall(toolName, parsedArgs, this.workspaceRoot);
      if (this._firstMutationSeq === -1) this._firstMutationSeq = seq;
      this._lastMutationSeq = seq;
      let touchesNonDoc = false;
      for (const f of mutatedFiles) {
        if (!this._filesMutatedSet.has(f)) {
          this._filesMutatedSet.add(f);
          this.filesMutated.push(f);
        }
        const kind = classifyMutationPath(f, { workspaceRoot: this.workspaceRoot });
        if (kind === 'doc') {
          this._mutatedDocSet.add(f);
        } else {
          touchesNonDoc = true;
          this._mutatedSrcSet.add(f);
          this._srcMutationSeqByPath.set(f, seq);
        }
      }
      if (touchesNonDoc) {
        if (this._firstCodeMutationSeq === -1) this._firstCodeMutationSeq = seq;
        this._lastCodeMutationSeq = seq;
      }
    }

    let verificationRecord = null;
    const cmd = typeof parsedArgs.command === 'string' ? parsedArgs.command.trim() : '';
    if ((toolName === 'bash' || toolName === 'start_process') && isVerificationCommand(cmd) && !isPolicyRejection) {
      const passed = status === 'finished' && !effectiveIsError;
      verificationRecord = {
        step,
        seq,
        callId: tc?.id ?? receipt?.callId ?? null,
        command: cmd,
        cwd: normalizeReasoningPath(parsedArgs.cwd || '.', this.workspaceRoot) || '.',
        passed,
        exitCode: exitCode ?? (passed ? 0 : 1),
        status,
        afterLastMutation: this._lastMutationSeq > 0 && seq > this._lastMutationSeq,
      };
      this.verifications.push(verificationRecord);
      if (passed) {
        this._lastPassingVerificationSeq = seq;
      }
    } else if (toolName === 'run_diagnostics' && !isPolicyRejection) {
      let diagOk = !effectiveIsError && status === 'finished';
      let diagKind = typeof parsedArgs.kind === 'string' ? parsedArgs.kind : 'auto';
      const rawOut = typeof output === 'string' ? output : '';
      const jsonIdx = rawOut.indexOf('{"ok":');
      if (jsonIdx !== -1) {
        const jsonEnd = rawOut.lastIndexOf('}');
        if (jsonEnd > jsonIdx) {
          try {
            const parsedDiag = JSON.parse(rawOut.slice(jsonIdx, jsonEnd + 1));
            if (typeof parsedDiag?.ok === 'boolean') diagOk = diagOk && parsedDiag.ok;
            if (typeof parsedDiag?.kind === 'string') diagKind = parsedDiag.kind;
          } catch {
            // ignore non-JSON tail
          }
        }
      }
      verificationRecord = {
        step,
        seq,
        callId: tc?.id ?? receipt?.callId ?? null,
        command: `run_diagnostics(${diagKind})`,
        cwd: '.',
        passed: diagOk,
        exitCode: diagOk ? 0 : (exitCode ?? 1),
        status: diagOk ? 'finished' : 'failed',
        afterLastMutation: this._lastMutationSeq > 0 && seq > this._lastMutationSeq,
      };
      this.verifications.push(verificationRecord);
      if (diagOk) {
        this._lastPassingVerificationSeq = seq;
      }
    }

    return {
      duplicateReminder,
      consecutiveDuplicateCount,
      trigger,
      verification: verificationRecord,
      mutatedFiles,
      readFiles,
    };
  }

  getState() {
    return {
      filesRead: [...this.filesRead],
      filesMutated: [...this.filesMutated],
      verifications: this.verifications.map((v) => ({ ...v })),
      hasUnverifiedMutationsAfterLastPass: this.hasUnverifiedMutationsAfterLastPass,
      ineffectiveActionCount: this.ineffectiveActionCount,
      policyBlockCount: this._policyBlockCount,
      budgetReserveAdvised: this._budgetReserveAdvised,
      budgetFinalCallAdvised: this._budgetFinalCallAdvised,
      budgetPruneCount: this._budgetPruneCount,
      rootCauseFilesReadBeforeEdit: [...this.rootCauseFilesReadBeforeEdit],
      errorFingerprints: [],
      falsifiedAttempts: [],
      stuckDetections: this.stuckDetections.map((d) => ({ ...d })),
      duplicateReminderCount: this.duplicateReminderCount,
      repairRounds: this._repairRounds,
      antiThrashingTriggered: false,
      aciMetrics: structuredClone(this._aciMetrics),
      budgetWatermarks: this._budgetWatermarks ? { ...this._budgetWatermarks } : null,
    };
  }

  getMetrics({ finalOutcomePassed = null, stopReason = null } = {}) {
    const codeSeqStart =
      this._firstCodeMutationSeq !== -1 ? this._firstCodeMutationSeq : this._firstMutationSeq;
    const postEditVerifications =
      codeSeqStart === -1 ? [] : this.verifications.filter((v) => v.seq > codeSeqStart);
    let firstFixSucceeded = null;
    if (postEditVerifications.length > 0) {
      firstFixSucceeded =
        postEditVerifications[0].passed === true &&
        !postEditVerifications.some((v) => !v.passed) &&
        this.stuckDetections.length === 0 &&
        this._repairRounds === 0;
    } else if (this.filesMutated.length > 0 && this.stuckDetections.length > 0) {
      firstFixSucceeded = false;
    }
    const reproducedFailureBeforeEdit =
      codeSeqStart === -1
        ? this.verifications.some((v) => !v.passed)
        : this.verifications.some((v) => !v.passed && v.seq < codeSeqStart);
    const latestVerification = this.verifications.at(-1) ?? null;
    const endedGreen =
      stopReason !== 'max_steps' &&
      stopReason !== 'verification_failed' &&
      stopReason !== 'TOKEN_BUDGET' &&
      stopReason !== 'TASK_DEADLINE' &&
      (finalOutcomePassed !== null
        ? Boolean(finalOutcomePassed)
        : Boolean(latestVerification?.passed && !this.hasUnverifiedMutationsAfterLastPass));
    const hadSetback =
      postEditVerifications.some((v) => !v.passed) ||
      this.stuckDetections.length > 0 ||
      this._repairRounds > 0;
    const selfCorrectionRecovered = firstFixSucceeded === true ? false : Boolean(hadSetback && endedGreen);

    return {
      filesRead: [...this.filesRead],
      filesMutated: [...this.filesMutated],
      verifications: this.verifications.map((v) => ({ ...v })),
      reproducedFailureBeforeEdit,
      hasUnverifiedMutationsAfterLastPass: this.hasUnverifiedMutationsAfterLastPass,
      ineffectiveActionCount: this.ineffectiveActionCount,
      policyBlockCount: this._policyBlockCount,
      budgetReserveAdvised: this._budgetReserveAdvised,
      budgetFinalCallAdvised: this._budgetFinalCallAdvised,
      budgetPruneCount: this._budgetPruneCount,
      firstFixSucceeded,
      selfCorrectionRecovered,
      rootCauseFilesReadBeforeEdit: [...this.rootCauseFilesReadBeforeEdit],
      errorFingerprints: [],
      falsifiedAttempts: [],
      stuckDetections: this.stuckDetections.map((d) => ({
        pattern: d.pattern,
        step: d.step,
        seq: d.seq,
        toolName: d.toolName,
        count: d.count,
        summary: d.summary,
        warningIssued: d.warningIssued,
      })),
      duplicateReminderCount: this.duplicateReminderCount,
      repairRounds: this._repairRounds,
      antiThrashingTriggered: false,
      thrashWarned: this.duplicateReminderCount > 0,
      circuitBroken: false,
      endedGreen,
      latestVerificationPassed: latestVerification ? latestVerification.passed : null,
      aciMetrics: structuredClone(this._aciMetrics),
      budgetWatermarks: this._budgetWatermarks ? { ...this._budgetWatermarks } : null,
    };
  }
}
