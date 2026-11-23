import { isAbsolute, relative, resolve } from 'node:path';
import { sha256Hex } from '../integrity.js';
import { computeArgsDigest } from '../tools/dispatcher.js';
import { scanCommandSyntax } from '../tools/command-analyzer.js';

export const STUCK_PATTERNS = Object.freeze({
  EXACT_REPEAT: 'exact_repeat',
  PING_PONG: 'ping_pong',
  SAME_ERROR_STREAK: 'same_error_streak',
  EDIT_TEST_FAIL_LOOP: 'edit_test_fail_loop',
  ASSISTANT_MONOLOGUE: 'assistant_monologue',
  POLICY_BLOCK_LOOP: 'policy_block_loop',
});

export const READ_TOOLS = Object.freeze(
  new Set([
    'read_file',
    'read_blob',
    'grep',
    'glob',
    'inspect_repository',
    'search_history',
  ]),
);

export const FILE_READ_TOOLS = Object.freeze(new Set(['read_file', 'read_blob']));

export const MUTATING_FILE_TOOLS = Object.freeze(
  new Set(['write_file', 'edit_file', 'apply_patch', 'delete_file']),
);

const VERIFICATION_SCRIPT_RE =
  /^(?:tests?|checks?|lint|build|typecheck)(?::[a-z0-9:_-]+)?$/i;
const TEST_BIN_FAIL_RE =
  /^(?:node|npm|pnpm|yarn|bun|npx|pytest|vitest|jest|cargo|go|python3?)\b.*\b(?:test|tests|spec|check|vitest|jest|pytest|unittest|mocha|ava|tap)\b/i;

/**
 * Recognizes strict synchronous verification commands (disallowing compound commands
 * and shell command substitution so chained commands cannot mask an earlier failure).
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
        for (const prefix of [
          '*** Add File: ',
          '*** Update File: ',
          '*** Delete File: ',
          '*** Move to: ',
        ]) {
          if (trimmed.startsWith(prefix)) {
            addPath(trimmed.slice(prefix.length));
          }
        }
      }
    }
  }

  return paths;
}

function parseExitCodeFromOutput(output) {
  const text = String(output ?? '');
  const m =
    text.match(/\bexit\s*code\s*[:=]\s*(-?\d+)\b/i) ??
    text.match(/\bexited with code\s+(-?\d+)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

function normalizeLocation(rawFile, line, workspaceRoot = null) {
  let clean = String(rawFile ?? '')
    .replace(/^file:\/\/\//i, '')
    .replace(/^file:\/\//i, '')
    .trim();
  if (!clean) return null;
  // Strip volatile temp directory prefixes so repeated runs in different tempdirs match
  clean = clean.replace(/^[A-Za-z]:[\\/].*?[\\/]Temp[\\/][^\\/]+[\\/]/i, '');
  clean = clean.replace(/^\/tmp\/[^/]+\//i, '');
  const norm = normalizeReasoningPath(clean, workspaceRoot) || clean.replace(/\\/g, '/');
  return line ? `${norm}:${line}` : norm;
}

function extractErrorLocation(text, workspaceRoot = null) {
  const src = String(text ?? '');
  const candidates = [];

  const jsFrameRe =
    /(?:file:\/\/\/)?([A-Za-z]:[\\/][^\s():"']+\.[cm]?[jt]sx?|[^\s():"']+\.[cm]?[jt]sx?):(\d+)(?::\d+)?/g;
  for (const m of src.matchAll(jsFrameRe)) {
    const file = m[1];
    if (file.startsWith('node:') || file.includes('node_modules')) continue;
    candidates.push(normalizeLocation(file, m[2], workspaceRoot));
  }

  const tsRe = /([A-Za-z0-9_./\\-]+\.[cm]?[jt]sx?)\((\d+),\d+\)/g;
  for (const m of src.matchAll(tsRe)) {
    candidates.push(normalizeLocation(m[1], m[2], workspaceRoot));
  }

  const pyGoRsRe = /([A-Za-z0-9_./\\-]+\.(?:py|go|rs)):(\d+)/g;
  for (const m of src.matchAll(pyGoRsRe)) {
    candidates.push(normalizeLocation(m[1], m[2], workspaceRoot));
  }

  return candidates.find(Boolean) ?? null;
}

function extractErrorType(text, exitCode, toolName) {
  const src = String(text ?? '');
  if (src.includes('防脏写拦截')) return 'STALE_FILE_GUARD';
  if (src.includes('未找到匹配的 target 片段') || /\bNOT_FOUND\b/.test(src)) {
    return 'EDIT_TARGET_NOT_FOUND';
  }
  if (src.includes('命中') && src.includes('replaceAll')) {
    return 'EDIT_TARGET_AMBIGUOUS';
  }
  if (src.includes('未知工具') || /unknown tool/i.test(src)) {
    return 'UNKNOWN_TOOL';
  }

  const tsMatch = src.match(/\berror\s+(TS\d+)\b/);
  if (tsMatch) return tsMatch[1];

  const errCodeMatch = src.match(/\[(ERR_[A-Z0-9_]+)\]/);
  const classMatch = src.match(
    /\b(AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|ZeroDivisionError|ValueError|KeyError|AttributeError|ImportError|ModuleNotFoundError|ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|ECONNREFUSED|ETIMEDOUT|Error)\b/,
  );
  if (classMatch) {
    return errCodeMatch ? `${classMatch[1]}:${errCodeMatch[1]}` : classMatch[1];
  }
  if (errCodeMatch) return errCodeMatch[1];

  const bracketCodes = [...src.matchAll(/\[([A-Z][A-Z0-9_]{2,})\]/g)].map((m) => m[1]);
  const specificBracket = bracketCodes.find(
    (c) => !c.startsWith('ERR_') && c !== 'NON_ZERO_EXIT' && c !== 'TOOL_ERROR',
  );
  if (specificBracket) return specificBracket;

  if (toolName === 'bash' || toolName === 'start_process') {
    if (typeof exitCode === 'number' && exitCode !== 0) return `EXIT_${exitCode}`;
  }
  return bracketCodes[0] ?? 'TOOL_ERROR';
}

function extractFailingTarget(text, toolName, args, workspaceRoot) {
  const src = String(text ?? '');
  const tapMatch =
    src.match(/[✖✘]\s+([^\r\n(]+?)(?:\s*\(\d+(?:\.\d+)?m?s\))?\s*$/m) ??
    src.match(/^not ok \d+\s*-\s*([^\r\n]+)/m) ??
    src.match(/^FAILED\s+([^\r\n]+)/m) ??
    src.match(/^FAIL\s+([^\r\n]+)/m);
  if (tapMatch) return tapMatch[1].trim().slice(0, 140);

  if (typeof args?.command === 'string' && args.command.trim()) {
    return args.command.trim().slice(0, 140);
  }
  if (typeof args?.path === 'string' && args.path.trim()) {
    return normalizeReasoningPath(args.path, workspaceRoot) ?? args.path.trim();
  }
  return toolName;
}

function extractAssertionExcerpt(text) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^\[(?:NON_ZERO_EXIT|TOOL_ERROR)\]\s*/i, '').trim())
    .filter((l) => l && !/^exitCode\s*:/i.test(l) && !/^(?:stdout|stderr):?$/i.test(l));

  if (!lines.length) return '';

  const highPriorityRe =
    /(?:AssertionError|TypeError|ReferenceError|SyntaxError|ZeroDivisionError|ValueError|ENOENT|EACCES|error TS\d+|Expected|Received|Actual|\[[A-Z][A-Z0-9_]{2,}\]|未找到|防脏写|未知工具|Fail-Closed|Error:)/i;
  const secondaryPriorityRe = /(?:FAILED|not ok|[✖✘]|fail)/i;

  const chosen =
    lines.find((l) => highPriorityRe.test(l)) ??
    lines.find((l) => secondaryPriorityRe.test(l)) ??
    lines.find((l) => !/^命令退出码\s*\d+$/.test(l)) ??
    lines[0];
  return chosen.slice(0, 180);
}

function normalizeExcerptForSignature(excerpt) {
  return String(excerpt ?? '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<TS>')
    .replace(/\(\s*\d+(?:\.\d+)?\s*(?:ms|s)\s*\)/gi, '(<DUR>)')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/gi, '<DUR>')
    .replace(/callId=[A-Za-z0-9_.-]+/g, 'callId=<ID>')
    .replace(/[A-Za-z]:[\\/].*?[\\/]Temp[\\/][^\\/\s]+/gi, '<TMP>')
    .replace(/\/tmp\/[^/\s]+/gi, '<TMP>')
    .replace(/0x[0-9a-f]{4,}/gi, '<HEX>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

/**
 * Extracts a normalized failure fingerprint from any failed tool execution.
 */
export function extractFailureFingerprint({
  toolName = '',
  args = {},
  output = '',
  receipt = null,
  workspaceRoot = null,
} = {}) {
  const parsedArgs = safeParseToolArgs(args);
  const text = String(output ?? '');
  const exitCode =
    typeof receipt?.exitCode === 'number' ? receipt.exitCode : parseExitCodeFromOutput(text);
  const errorType = extractErrorType(text, exitCode, toolName);
  const location = extractErrorLocation(text, workspaceRoot);
  const failingTarget = extractFailingTarget(text, toolName, parsedArgs, workspaceRoot);
  const assertionExcerpt = extractAssertionExcerpt(text);
  const normExcerpt = normalizeExcerptForSignature(assertionExcerpt);
  const exitPart = exitCode !== null && exitCode !== undefined ? String(exitCode) : '';

  const sigParts = [toolName || 'tool', errorType];
  if (location) sigParts.push(location);
  if (normExcerpt) sigParts.push(normExcerpt);
  else if (failingTarget) sigParts.push(failingTarget);
  if (exitPart) sigParts.push(`exit=${exitPart}`);

  const signature = sigParts.join('|');
  const summaryParts = [errorType];
  if (location) summaryParts.push(`at ${location}`);
  if (assertionExcerpt) summaryParts.push(`"${assertionExcerpt}"`);
  else if (failingTarget) summaryParts.push(`on ${failingTarget}`);
  if (exitPart) summaryParts.push(`(exitCode=${exitPart})`);

  return {
    signature,
    errorType,
    location,
    failingTarget,
    assertionExcerpt,
    exitCode: exitCode ?? null,
    toolName: toolName || null,
    summary: summaryParts.join(' '),
  };
}

function summarizeArgsCompact(toolName, args, workspaceRoot) {
  const parsed = safeParseToolArgs(args);
  if (typeof parsed.command === 'string') return `command=${JSON.stringify(parsed.command.slice(0, 100))}`;
  if (typeof parsed.path === 'string') {
    const norm = normalizeReasoningPath(parsed.path, workspaceRoot) ?? parsed.path;
    return `path=${norm}`;
  }
  if (toolName === 'apply_patch') {
    const files = extractMutatedFilesFromToolCall(toolName, parsed, workspaceRoot);
    return files.length ? `files=${files.join(',')}` : 'patch';
  }
  const str = JSON.stringify(parsed);
  return str.length > 100 ? `${str.slice(0, 97)}...` : str;
}

function computeCanonicalSignature(toolName, args) {
  try {
    return computeArgsDigest(toolName, safeParseToolArgs(args));
  } catch {
    return sha256Hex(`${toolName}::${JSON.stringify(args ?? {})}`);
  }
}

function normalizeAssistantMonologueText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tracks execution reasoning state, multi-pattern stuck detection, normalized failure
 * fingerprints, falsified-attempt ledger, and live mutation-vs-verification evidence.
 */
export class ExecutionReasoningTracker {
  constructor({ workspaceRoot = null } = {}) {
    this.workspaceRoot = workspaceRoot;
    this.seq = 0;

    // Live mutation-vs-verification ledger
    this.filesRead = [];
    this._filesReadSet = new Set();
    this._readSignaturesSinceMutation = new Set();
    this._allReadSignatures = new Set();
    this.filesMutated = [];
    this._filesMutatedSet = new Set();
    this.rootCauseFilesReadBeforeEdit = [];
    this.verifications = [];

    this._firstMutationSeq = -1;
    this._lastMutationSeq = -1;
    this._lastPassingVerificationSeq = -1;
    this._lastEditPendingVerification = null;
    this._reproducedFailureBeforeEdit = false;
    this._sawPreEditReproFailure = false;

    // Failure & falsified attempt tracking
    this.errorFingerprints = [];
    this._fingerprintBySig = new Map();
    this.falsifiedAttempts = [];
    this._consecutiveErrorStreak = { signature: null, count: 0 };
    this._editTestFailCycles = 0;
    this._hasPendingEditInCycle = false;

    // Action history for exact_repeat and ping_pong
    this._actionHistory = [];
    this._consecutiveExactFailedStreak = { key: null, count: 0 };

    // Assistant monologue tracking
    this._lastIdleAssistantText = null;
    this._consecutiveNoToolTurns = 0;
    this._consecutiveIdenticalIdleTurns = 0;
    this._consecutiveEmptyIdleTurns = 0;

    // Stuck detections & recovery state
    this.stuckDetections = [];
    this._warnedPatterns = new Set();
    this._repairRounds = 0;
    this._nonReproFailureCount = 0;
    this._policyBlockCount = 0;
    this._consecutivePolicyBlocks = 0;
    this.ineffectiveActionCount = 0;
  }

  get hasUnverifiedMutationsAfterLastPass() {
    return this._lastMutationSeq > this._lastPassingVerificationSeq;
  }

  recordRepairRound({ step = 0 } = {}) {
    this._repairRounds += 1;
    return this._repairRounds;
  }

  recordAssistantTurn({ text = '', toolCallCount = 0, step = 0 } = {}) {
    const seq = ++this.seq;
    if (toolCallCount > 0) {
      this._consecutiveNoToolTurns = 0;
      this._consecutiveEmptyIdleTurns = 0;
      return null;
    }

    this._consecutiveNoToolTurns += 1;
    const normText = normalizeAssistantMonologueText(text);
    if (!normText) {
      this._consecutiveEmptyIdleTurns += 1;
    } else {
      this._consecutiveEmptyIdleTurns = 0;
    }

    if (normText && this._lastIdleAssistantText === normText) {
      this._consecutiveIdenticalIdleTurns += 1;
    } else {
      this._consecutiveIdenticalIdleTurns = normText ? 1 : 0;
    }
    if (normText) {
      this._lastIdleAssistantText = normText;
    }

    const isIdenticalMonologue = this._consecutiveIdenticalIdleTurns >= 2;
    const isEmptyMonologue = this._consecutiveEmptyIdleTurns >= 2;
    const isExtendedNoToolMonologue = this._consecutiveNoToolTurns >= 3;

    if (isIdenticalMonologue || isEmptyMonologue || isExtendedNoToolMonologue) {
      this.ineffectiveActionCount += 1;
      const reason = isIdenticalMonologue
        ? 'repeated identical assistant reply with no tool execution'
        : isEmptyMonologue
          ? 'repeated empty assistant replies with no tool calls'
          : `${this._consecutiveNoToolTurns} consecutive assistant turns without calling any tools`;
      const detection = {
        pattern: STUCK_PATTERNS.ASSISTANT_MONOLOGUE,
        step,
        seq,
        signature: `monologue:${isIdenticalMonologue ? 'identical' : isEmptyMonologue ? 'empty' : 'no_tools'}`,
        summary: reason,
        fingerprint: this.errorFingerprints.at(-1) ?? null,
        falsifiedAttempts: this.falsifiedAttempts.slice(-5),
        warningIssued: true,
      };
      this.stuckDetections.push(detection);
      return detection;
    }
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
    const exitCode = receipt?.exitCode ?? parseExitCodeFromOutput(output);
    const trimmedOut = String(output ?? '').trim();
    const isPolicyRejection =
      status === 'rejected_before_effect' ||
      receipt?.errorCode === 'APPROVAL_DENIED' ||
      receipt?.errorCode === 'POLICY_DENIED' ||
      /^(?:安全策略拦截：|用户拒绝了\s+.+\s+操作$|审批(?:超时|已被撤销)，拒绝执行\s+|\[(?:APPROVAL_DENIED|POLICY_DENIED)\])/.test(trimmedOut);
    const effectiveIsError =
      Boolean(isError) ||
      isPolicyRejection ||
      status === 'failed' ||
      (typeof exitCode === 'number' && exitCode !== 0);

    // Reset identical-idle assistant tracker when an actual tool runs
    this._lastIdleAssistantText = null;
    this._consecutiveIdenticalIdleTurns = 0;
    this._consecutiveEmptyIdleTurns = 0;

    // Polling a still-running operation is not thrashing or a failure
    if (pending && !effectiveIsError) {
      return { trigger: null, fingerprint: null, verification: null, mutatedFiles: [], readFiles: [] };
    }

    if (isPolicyRejection) {
      this._policyBlockCount += 1;
      this._consecutivePolicyBlocks += 1;
    } else {
      this._consecutivePolicyBlocks = 0;
    }

    const argsSig = computeCanonicalSignature(toolName, parsedArgs);
    let fingerprint = null;
    if (effectiveIsError && !isPolicyRejection) {
      fingerprint = extractFailureFingerprint({
        toolName,
        args: parsedArgs,
        output,
        receipt,
        workspaceRoot: this.workspaceRoot,
      });
      this.#recordFingerprint(fingerprint, step, seq);
    }

    // 1. Track reads and hypothesis pivots
    const readFiles = [];
    let isNewInspectionPivot = false;
    if (!effectiveIsError && READ_TOOLS.has(toolName)) {
      const readSig = `${toolName}:${argsSig}`;
      if (!this._readSignaturesSinceMutation.has(readSig)) {
        this._readSignaturesSinceMutation.add(readSig);
      } else {
        // Re-running the exact same read/search with no edits in between is ineffective
        this.ineffectiveActionCount += 1;
      }

      if (!this._allReadSignatures.has(readSig)) {
        this._allReadSignatures.add(readSig);
        isNewInspectionPivot = true;
      }

      if (FILE_READ_TOOLS.has(toolName) && typeof parsedArgs.path === 'string') {
        const normPath = normalizeReasoningPath(parsedArgs.path, this.workspaceRoot);
        if (normPath) {
          readFiles.push(normPath);
          if (!this._filesReadSet.has(normPath)) {
            this._filesReadSet.add(normPath);
            this.filesRead.push(normPath);
            isNewInspectionPivot = true;
          }
          if (this._firstMutationSeq === -1 && !this.rootCauseFilesReadBeforeEdit.includes(normPath)) {
            this.rootCauseFilesReadBeforeEdit.push(normPath);
          }
        }
      }

      if (isNewInspectionPivot) {
        this._editTestFailCycles = 0;
      }
    }

    // 2. Track file mutations
    let mutatedFiles = [];
    if (!effectiveIsError && MUTATING_FILE_TOOLS.has(toolName)) {
      mutatedFiles = extractMutatedFilesFromToolCall(toolName, parsedArgs, this.workspaceRoot);
      if (this._firstMutationSeq === -1) {
        this._firstMutationSeq = seq;
      }
      this._lastMutationSeq = seq;
      this._hasPendingEditInCycle = true;
      this._readSignaturesSinceMutation.clear();
      this._lastEditPendingVerification = {
        step,
        seq,
        toolName,
        files: [...mutatedFiles],
      };
      for (const f of mutatedFiles) {
        if (!this._filesMutatedSet.has(f)) {
          this._filesMutatedSet.add(f);
          this.filesMutated.push(f);
        }
      }
    }

    // 3. Track verification commands (bash / start_process)
    let verificationRecord = null;
    const cmd = typeof parsedArgs.command === 'string' ? parsedArgs.command.trim() : '';
    const isBashLike = toolName === 'bash' || toolName === 'start_process';
    const isVerifCmd = isBashLike && isVerificationCommand(cmd);
    const isTestFailHint = isBashLike && effectiveIsError && TEST_BIN_FAIL_RE.test(cmd);

    if (isVerifCmd && !isPolicyRejection) {
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
        signature: fingerprint?.signature ?? null,
        afterLastMutation: this._lastMutationSeq > 0 && seq > this._lastMutationSeq,
      };
      this.verifications.push(verificationRecord);

      if (passed) {
        this._lastPassingVerificationSeq = seq;
        this._consecutiveErrorStreak = { signature: null, count: 0 };
        this._editTestFailCycles = 0;
        this._hasPendingEditInCycle = false;
        this._lastEditPendingVerification = null;
      } else {
        this.#recordVerificationFailure();
      }
    } else if (isTestFailHint && !isPolicyRejection) {
      this.#recordVerificationFailure();
    } else if (isPolicyRejection) {
      this.ineffectiveActionCount += 1;
    } else if (effectiveIsError) {
      this.ineffectiveActionCount += 1;
      this._nonReproFailureCount += 1;
    }

    // 4. Record falsified attempt when an action fails (excluding pre-effect policy rejections)
    if (effectiveIsError && !isPolicyRejection && fingerprint) {
      const priorEdit = this._lastEditPendingVerification;
      const hypothesisSummary =
        (isVerifCmd || isTestFailHint) && priorEdit
          ? `Edited ${priorEdit.files.join(', ') || priorEdit.toolName}, then verification (${cmd}) failed with ${fingerprint.summary}`
          : `${toolName}(${summarizeArgsCompact(toolName, parsedArgs, this.workspaceRoot)}) failed with ${fingerprint.summary}`;
      this.falsifiedAttempts.push({
        seq,
        step,
        toolName,
        target: fingerprint.failingTarget,
        argsSummary: summarizeArgsCompact(toolName, parsedArgs, this.workspaceRoot),
        editedFiles: (isVerifCmd || isTestFailHint) && priorEdit ? [...priorEdit.files] : [],
        fingerprint,
        hypothesisSummary,
        at: Date.now(),
      });
      if (this.falsifiedAttempts.length > 30) {
        this.falsifiedAttempts.shift();
      }
    }

    // 5. Update error streak (excluding pre-effect policy rejections)
    if (effectiveIsError && !isPolicyRejection && fingerprint) {
      if (this._consecutiveErrorStreak.signature === fingerprint.signature) {
        this._consecutiveErrorStreak.count += 1;
      } else {
        this._consecutiveErrorStreak = { signature: fingerprint.signature, count: 1 };
      }
    } else if (!effectiveIsError && !READ_TOOLS.has(toolName) && !MUTATING_FILE_TOOLS.has(toolName)) {
      // Non-error, non-read, non-edit command broke the streak if it wasn't a read/edit inspection
      this._consecutiveErrorStreak = { signature: null, count: 0 };
    }

    // 6. Update action history for exact_repeat and ping_pong
    const policyCode = isPolicyRejection ? (receipt?.errorCode ?? status ?? 'rejected') : null;
    const actionKey = `${toolName}:${argsSig}:${
      isPolicyRejection
        ? `policy:${policyCode}`
        : effectiveIsError
          ? `err:${fingerprint?.signature ?? '1'}`
          : 'ok'
    }`;
    this._actionHistory.push({
      seq,
      step,
      toolName,
      argsSig,
      actionKey,
      isError: effectiveIsError,
      isPolicyRejection,
      isMutation: mutatedFiles.length > 0,
      fingerprint,
    });
    if (this._actionHistory.length > 16) {
      this._actionHistory.shift();
    }

    if (effectiveIsError) {
      const exactKey = `${toolName}:${argsSig}:${
        isPolicyRejection ? `policy:${policyCode}` : (fingerprint?.signature ?? 'err')
      }`;
      if (this._consecutiveExactFailedStreak.key === exactKey) {
        this._consecutiveExactFailedStreak.count += 1;
      } else {
        this._consecutiveExactFailedStreak = { key: exactKey, count: 1 };
      }
    } else {
      this._consecutiveExactFailedStreak = { key: null, count: 0 };
    }

    // 7. Evaluate stuck patterns in priority order
    const trigger = this.#evaluateStuckPatterns({
      step,
      seq,
      fingerprint,
      effectiveIsError,
      isPolicyRejection,
    });

    return {
      trigger,
      fingerprint,
      verification: verificationRecord,
      mutatedFiles,
      readFiles,
    };
  }

  #recordVerificationFailure() {
    if (this._firstMutationSeq === -1) {
      this._reproducedFailureBeforeEdit = true;
      if (!this._sawPreEditReproFailure) {
        this._sawPreEditReproFailure = true;
      } else {
        // Re-running a failing test multiple times before any edit is ineffective
        this.ineffectiveActionCount += 1;
        this._nonReproFailureCount += 1;
      }
    } else {
      this.ineffectiveActionCount += 1;
      this._nonReproFailureCount += 1;
    }
    if (this._hasPendingEditInCycle) {
      this._editTestFailCycles += 1;
      this._hasPendingEditInCycle = false;
    }
  }

  #recordFingerprint(fp, step, seq) {
    const existing = this._fingerprintBySig.get(fp.signature);
    if (existing) {
      existing.count += 1;
      existing.lastStep = step;
      existing.lastSeq = seq;
      return;
    }
    const entry = {
      ...fp,
      count: 1,
      firstStep: step,
      lastStep: step,
      firstSeq: seq,
      lastSeq: seq,
    };
    this._fingerprintBySig.set(fp.signature, entry);
    this.errorFingerprints.push(entry);
  }

  #evaluateStuckPatterns({ step, seq, fingerprint, effectiveIsError, isPolicyRejection = false }) {
    let detected = null;

    // Pattern 1: Exact repeat (>= 3 identical tool + args + error calls in recent window or consecutive)
    if (effectiveIsError) {
      const last = this._actionHistory.at(-1);
      const recentExactCount = this._actionHistory
        .slice(-8)
        .filter((a) => a.isError && a.actionKey === last?.actionKey).length;
      if (this._consecutiveExactFailedStreak.count >= 3 || recentExactCount >= 3) {
        detected = {
          pattern: STUCK_PATTERNS.EXACT_REPEAT,
          step,
          seq,
          signature: fingerprint?.signature ?? last?.actionKey ?? 'exact_repeat',
          summary: `Repeated identical failing call ${last?.toolName} (>= 3 times)`,
          ...(isPolicyRejection ? { isPolicyRejection: true } : {}),
        };
      }
    }

    // Pattern 2: Ping-pong alternating cycle (A -> B -> A -> B)
    if (!detected && this._actionHistory.length >= 4) {
      const [a1, b1, a2, b2] = this._actionHistory.slice(-4);
      const aMatch = a1.toolName === a2.toolName && a1.argsSig === a2.argsSig;
      const bMatch = b1.toolName === b2.toolName && b1.argsSig === b2.argsSig;
      const distinct = !(a1.toolName === b1.toolName && a1.argsSig === b1.argsSig);
      if (aMatch && bMatch && distinct) {
        detected = {
          pattern: STUCK_PATTERNS.PING_PONG,
          step,
          seq,
          signature: `ping_pong:${a1.toolName}<->${b1.toolName}`,
          summary: `Alternating cycle detected (${a1.toolName} -> ${b1.toolName} -> ${a2.toolName} -> ${b2.toolName})`,
        };
      }
    }

    // Pattern 3: Edit -> test-fail loop (>= 2 cycles without new read/hypothesis pivot)
    if (!detected && this._editTestFailCycles >= 2) {
      detected = {
        pattern: STUCK_PATTERNS.EDIT_TEST_FAIL_LOOP,
        step,
        seq,
        signature: fingerprint?.signature ?? 'edit_test_fail_loop',
        summary: `${this._editTestFailCycles} consecutive edit -> test-failure cycles without reading new source/root-cause files`,
      };
    }

    // Pattern 4: Normalized same-error-signature streak (>= 3 even when args vary)
    if (!detected && effectiveIsError && !isPolicyRejection && this._consecutiveErrorStreak.count >= 3) {
      detected = {
        pattern: STUCK_PATTERNS.SAME_ERROR_STREAK,
        step,
        seq,
        signature: this._consecutiveErrorStreak.signature,
        summary: `Same normalized error occurred ${this._consecutiveErrorStreak.count} times in a row despite varying arguments`,
      };
    }

    // Pattern 5: Policy/approval rejection loop (>= 2 policy blocks in a turn; non-fatal steering only)
    if (!detected && isPolicyRejection && (this._policyBlockCount >= 2 || this._consecutivePolicyBlocks >= 2)) {
      detected = {
        pattern: STUCK_PATTERNS.POLICY_BLOCK_LOOP,
        step,
        seq,
        signature: `policy_block:${this._policyBlockCount}`,
        summary: `${this._policyBlockCount} tool calls blocked by sandbox/approval policy before execution (consecutive=${this._consecutivePolicyBlocks})`,
        nonFatal: true,
      };
    }

    if (!detected) return null;

    const isPolicyPattern = detected.pattern === STUCK_PATTERNS.POLICY_BLOCK_LOOP;
    const alreadyWarned = isPolicyPattern
      ? this._warnedPatterns.has(STUCK_PATTERNS.POLICY_BLOCK_LOOP)
      : [...this._warnedPatterns].some((p) => p !== STUCK_PATTERNS.POLICY_BLOCK_LOOP);
    this._warnedPatterns.add(detected.pattern);

    const fullDetection = {
      ...detected,
      fingerprint: isPolicyPattern ? null : (fingerprint ?? this.errorFingerprints.at(-1) ?? null),
      falsifiedAttempts: isPolicyPattern ? [] : this.falsifiedAttempts.slice(-5),
      warningIssued: !alreadyWarned,
    };
    this.stuckDetections.push(fullDetection);
    return fullDetection;
  }

  /**
   * Builds a rich diagnostic steering message listing normalized error fingerprint,
   * falsified attempts, and structured root-cause pivot guidance.
   */
  buildDiagnosticSteeringMessage(detection = null) {
    const active = detection ?? this.stuckDetections.at(-1) ?? null;
    if (active?.pattern === STUCK_PATTERNS.POLICY_BLOCK_LOOP) {
      return [
        `[策略拦截纠偏提示] 检测到多次工具调用在执行前被策略/审批拦截 (${active.summary || 'APPROVAL_DENIED / POLICY_DENIED'})，请立即停止尝试被禁止的 bash 命令（如 ls、git、node -e 等）。`,
        '1. 目录浏览、文件检索和代码读取请直接使用内置工具 glob / grep / read_file，切勿通过 bash 执行辅助探测脚本。',
        '2. 代码修改请直接使用 write_file / edit_file / apply_patch，并仅在需要验证时运行题目允许的精确测试命令。',
      ].join('\n');
    }

    const fp = active?.fingerprint ?? this.errorFingerprints.at(-1) ?? null;
    const falsified = (active?.falsifiedAttempts?.length
      ? active.falsifiedAttempts
      : this.falsifiedAttempts.slice(-5)
    ).slice(-5);

    const lines = [
      `[系统防死循环提示] 检测到执行陷入重复停滞模式 (${active?.pattern ?? 'exact_repeat'}): ${active?.summary ?? '连续多次执行相同或无效的失败操作。'}`,
    ];

    if (fp) {
      lines.push(
        `当前归一化错误指纹 (${fp.signature}):`,
        `- 错误类型: ${fp.errorType}${fp.location ? ` | 位置: ${fp.location}` : ''}${fp.exitCode !== null && fp.exitCode !== undefined ? ` | exitCode: ${fp.exitCode}` : ''}`,
        ...(fp.failingTarget ? [`- 失败目标: ${fp.failingTarget}`] : []),
        ...(fp.assertionExcerpt ? [`- 关键报错摘要: ${fp.assertionExcerpt}`] : []),
      );
    }

    if (falsified.length > 0) {
      lines.push('已证伪尝试记录 (Falsified Attempts — 请勿重复相同修改或无效命令):');
      for (const [idx, item] of falsified.entries()) {
        lines.push(`${idx + 1}. [step ${item.step}] ${item.hypothesisSummary}`);
      }
    }

    lines.push(
      '强制根因诊断与纠偏要求 (Root-Cause Evidence Before Editing):',
      '1. 立即停止盲目重试相同命令或在未读取关联代码的情况下继续试探性修改。',
      '2. 在下一次 edit_file/write_file/apply_patch 之前，必须先使用 read_file / grep / inspect_repository 读取报错位置、调用链上游及关联测试代码，获取并引用具体的 file:line 根因证据。',
      '3. 明确陈述与已证伪尝试不同的新假设（解释为何此前尝试未能解决根因），再做最小精确修改并运行验证命令确认通过；若确认无法推进，请如实向用户汇报阻塞点。',
    );

    return lines.join('\n');
  }

  getState() {
    return {
      filesRead: [...this.filesRead],
      filesMutated: [...this.filesMutated],
      verifications: this.verifications.map((v) => ({ ...v })),
      reproducedFailureBeforeEdit: this._reproducedFailureBeforeEdit,
      hasUnverifiedMutationsAfterLastPass: this.hasUnverifiedMutationsAfterLastPass,
      ineffectiveActionCount: this.ineffectiveActionCount,
      policyBlockCount: this._policyBlockCount,
      rootCauseFilesReadBeforeEdit: [...this.rootCauseFilesReadBeforeEdit],
      errorFingerprints: this.errorFingerprints.map((fp) => ({ ...fp })),
      falsifiedAttempts: this.falsifiedAttempts.map((a) => ({ ...a })),
      stuckDetections: this.stuckDetections.map((d) => ({ ...d })),
      repairRounds: this._repairRounds,
    };
  }

  getMetrics({ finalOutcomePassed = null, stopReason = null } = {}) {
    const postEditVerifications =
      this._firstMutationSeq === -1
        ? []
        : this.verifications.filter((v) => v.seq > this._firstMutationSeq);
    const latestVerification = this.verifications.at(-1) ?? null;
    const executionStuckDetections = this.stuckDetections.filter(
      (d) => d.pattern !== STUCK_PATTERNS.POLICY_BLOCK_LOOP,
    );

    let firstFixSucceeded = null;
    if (postEditVerifications.length > 0) {
      firstFixSucceeded =
        postEditVerifications[0].passed === true &&
        !postEditVerifications.some((v) => !v.passed) &&
        executionStuckDetections.length === 0 &&
        this._repairRounds === 0;
    } else if (this.filesMutated.length > 0 && executionStuckDetections.length > 0) {
      firstFixSucceeded = false;
    }

    const hadSetback =
      postEditVerifications.some((v) => !v.passed) ||
      executionStuckDetections.length > 0 ||
      this._repairRounds > 0 ||
      this._nonReproFailureCount > 0;

    const endedGreen =
      stopReason !== 'thrashing_circuit_break' &&
      stopReason !== 'max_steps' &&
      stopReason !== 'verification_failed' &&
      stopReason !== 'TOKEN_BUDGET' &&
      stopReason !== 'TASK_DEADLINE' &&
      (finalOutcomePassed !== null
        ? Boolean(finalOutcomePassed)
        : Boolean(latestVerification?.passed && !this.hasUnverifiedMutationsAfterLastPass));

    let selfCorrectionRecovered = Boolean(hadSetback && endedGreen);
    if (firstFixSucceeded === true) {
      selfCorrectionRecovered = false;
    }

    return {
      filesRead: [...this.filesRead],
      filesMutated: [...this.filesMutated],
      verifications: this.verifications.map((v) => ({ ...v })),
      reproducedFailureBeforeEdit: this._reproducedFailureBeforeEdit,
      hasUnverifiedMutationsAfterLastPass: this.hasUnverifiedMutationsAfterLastPass,
      ineffectiveActionCount: this.ineffectiveActionCount,
      policyBlockCount: this._policyBlockCount,
      firstFixSucceeded,
      selfCorrectionRecovered,
      rootCauseFilesReadBeforeEdit: [...this.rootCauseFilesReadBeforeEdit],
      errorFingerprints: this.errorFingerprints.map((fp) => ({ ...fp })),
      falsifiedAttempts: this.falsifiedAttempts.map((a) => ({ ...a })),
      stuckDetections: this.stuckDetections.map((d) => ({
        pattern: d.pattern,
        step: d.step,
        seq: d.seq,
        signature: d.signature,
        summary: d.summary,
        warningIssued: d.warningIssued,
      })),
      repairRounds: this._repairRounds,
      thrashWarned: [...this._warnedPatterns].some((p) => p !== STUCK_PATTERNS.POLICY_BLOCK_LOOP),
      circuitBroken: stopReason === 'thrashing_circuit_break',
      latestVerificationPassed: latestVerification ? latestVerification.passed : null,
    };
  }
}
