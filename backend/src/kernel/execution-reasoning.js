import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { sha256Hex } from '../integrity.js';
import { computeArgsDigest } from '../tools/dispatcher.js';
import { scanCommandSyntax } from '../tools/command-analyzer.js';

export const STUCK_PATTERNS = Object.freeze({
  EXACT_REPEAT: 'exact_repeat',
  PING_PONG: 'ping_pong',
  SAME_ERROR_STREAK: 'same_error_streak',
  EDIT_TEST_FAIL_LOOP: 'edit_test_fail_loop',
  SELF_TEST_CALIBRATION: 'self_test_calibration',
  ASSISTANT_MONOLOGUE: 'assistant_monologue',
  POLICY_BLOCK_LOOP: 'policy_block_loop',
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

const DOC_MUTATION_PATH_RE = /(?:^|\/)(?:[^/]+\.(?:md|txt)|license(?:\.[^/]*)?|\.gitignore)$/i;
const TEST_MUTATION_PATH_RE =
  /(?:^|\/)(?:tests?|__tests__)\/|\/?[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i;

/**
 * Classifies a normalized workspace path into `doc`, `baseline_test`, `self_test`, or `src`.
 */
export function classifyMutationPath(
  rawPath,
  { workspaceRoot = null, baselineTestFiles = [], selfAuthoredTestFiles = [] } = {},
) {
  const norm = normalizeReasoningPath(rawPath, workspaceRoot) ?? String(rawPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
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

function collectExistingTestPaths(workspaceRoot, maxEntries = 200) {
  const found = new Set();
  if (!workspaceRoot) return found;
  const root = resolve(String(workspaceRoot));
  if (!existsSync(root)) return found;
  const skipDirs = new Set(['node_modules', '.git', 'upstream', 'var', 'dist', 'build', '.next']);
  const stack = [''];
  let visited = 0;
  while (stack.length > 0 && visited < maxEntries) {
    const relDir = stack.pop();
    const absDir = relDir ? join(root, relDir) : root;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= maxEntries) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        stack.push(relDir ? `${relDir}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (TEST_MUTATION_PATH_RE.test(rel)) {
        found.add(rel);
      }
    }
  }
  return found;
}

/**
 * Tracks execution reasoning state, multi-pattern stuck detection, normalized failure
 * fingerprints, falsified-attempt ledger, and live mutation-vs-verification evidence.
 */
export class ExecutionReasoningTracker {
  constructor({ workspaceRoot = null, baselineTestFiles = null } = {}) {
    this.workspaceRoot = workspaceRoot;
    this.seq = 0;
    this._baselineTestFilesSet = Array.isArray(baselineTestFiles)
      ? new Set(
          baselineTestFiles
            .map((p) => normalizeReasoningPath(p, workspaceRoot))
            .filter(Boolean),
        )
      : collectExistingTestPaths(workspaceRoot);
    this._selfAuthoredTestFiles = new Set();

    // Live mutation-vs-verification ledger
    this.filesRead = [];
    this._filesReadSet = new Set();
    this._readSignaturesSinceMutation = new Set();
    this._allReadSignatures = new Set();
    this.filesMutated = [];
    this._filesMutatedSet = new Set();
    this._mutatedSrcSet = new Set();
    this._mutatedDocSet = new Set();
    this._mutatedSelfTestSet = new Set();
    this._mutatedBaselineTestSet = new Set();
    this.rootCauseFilesReadBeforeEdit = [];
    this.verifications = [];

    this._firstMutationSeq = -1;
    this._firstCodeMutationSeq = -1;
    this._lastMutationSeq = -1;
    this._lastCodeMutationSeq = -1;
    this._lastPassingVerificationSeq = -1;
    this._lastEditPendingVerification = null;
    this._reproducedFailureBeforeEdit = false;
    this._sawPreEditReproFailure = false;
    this._rootCauseVerifiedAfterEdit = false;

    this.reproductionEvidence = [];
    this.rootCauseLedger = {
      symptom: null,
      directCause: null,
      rootCause: null,
      preEditFailureSignatures: [],
      resolvedSignatures: [],
      hypotheses: [],
    };
    this._contractComplianceSignals = {
      evaluated: false,
      ready: true,
      gapCount: 0,
      missingDeliverables: [],
      invalidJsonFiles: [],
      missingExportedSymbols: [],
      forbiddenViolations: [],
      missingContractReads: [],
    };

    // Failure & falsified attempt tracking
    this.errorFingerprints = [];
    this._fingerprintBySig = new Map();
    this.falsifiedAttempts = [];
    this._consecutiveErrorStreak = { signature: null, count: 0 };
    this._editTestFailCycles = 0;
    this._selfTestEditCycles = 0;
    this._hasPendingEditInCycle = false;
    this._pendingCycleEditCategories = new Set();
    this._baselineTestFailedInCycle = false;

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
      admissionDecisions: { DIRECT: 0, SUPPORTING: 0, DEFER: 0, DUPLICATE: 0, IRRELEVANT: 0 },
      admissionOriginalTokens: 0,
      admissionInjectedTokens: 0,
      admissionSavedTokens: 0,
      offloadedCount: 0,
      savedTokens: 0,
      totalAciSavedTokens: 0,
      restoredCount: 0,
      hashVerifiedRestores: 0,
      criticalContextRecall: null,
      supervisorCalls: 0,
      supervisorMode: null,
      supervisorModel: null,
      supervisorCost: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0, fallbackCount: 0 },
      recoveryStats: { totalRecoveries: 0, hashVerifiedCount: 0, tokensRestored: 0 },
      epochTransitions: 0,
      ledger: null,
    };
  }

  get hasUnverifiedMutationsAfterLastPass() {
    return this._lastCodeMutationSeq > this._lastPassingVerificationSeq;
  }

  updateAciMetrics(patch = null) {
    if (!patch || typeof patch !== 'object') return;
    if (patch.aciProfile !== undefined) {
      this._aciMetrics.aciProfile = patch.aciProfile ? String(patch.aciProfile) : null;
    }
    if (patch.admissionEnabled !== undefined) {
      this._aciMetrics.admissionEnabled = patch.admissionEnabled === null ? null : Boolean(patch.admissionEnabled);
    }
    if (patch.dtocEnabled !== undefined) {
      this._aciMetrics.dtocEnabled = patch.dtocEnabled === null ? null : Boolean(patch.dtocEnabled);
    }
    if (patch.dtocPolicy !== undefined) {
      this._aciMetrics.dtocPolicy = patch.dtocPolicy ? String(patch.dtocPolicy) : null;
    }
    if (patch.dtocMinPromptTokens !== undefined) {
      this._aciMetrics.dtocMinPromptTokens =
        patch.dtocMinPromptTokens != null && Number.isFinite(Number(patch.dtocMinPromptTokens))
          ? Math.max(0, Math.trunc(Number(patch.dtocMinPromptTokens)))
          : null;
    }
    if (patch.admissionDecisions && typeof patch.admissionDecisions === 'object') {
      this._aciMetrics.admissionDecisions = {
        DIRECT: Number(patch.admissionDecisions.DIRECT || 0),
        SUPPORTING: Number(patch.admissionDecisions.SUPPORTING || 0),
        DEFER: Number(patch.admissionDecisions.DEFER || 0),
        DUPLICATE: Number(patch.admissionDecisions.DUPLICATE || 0),
        IRRELEVANT: Number(patch.admissionDecisions.IRRELEVANT || 0),
      };
    }
    if (patch.admissionOriginalTokens != null && Number.isFinite(Number(patch.admissionOriginalTokens))) {
      this._aciMetrics.admissionOriginalTokens = Math.max(0, Math.trunc(Number(patch.admissionOriginalTokens)));
    }
    if (patch.admissionInjectedTokens != null && Number.isFinite(Number(patch.admissionInjectedTokens))) {
      this._aciMetrics.admissionInjectedTokens = Math.max(0, Math.trunc(Number(patch.admissionInjectedTokens)));
    }
    if (patch.admissionSavedTokens != null && Number.isFinite(Number(patch.admissionSavedTokens))) {
      this._aciMetrics.admissionSavedTokens = Math.max(0, Math.trunc(Number(patch.admissionSavedTokens)));
    }
    if (patch.offloadedCount != null && Number.isFinite(Number(patch.offloadedCount))) {
      this._aciMetrics.offloadedCount = Math.max(0, Math.trunc(Number(patch.offloadedCount)));
    }
    if (patch.savedTokens != null && Number.isFinite(Number(patch.savedTokens))) {
      this._aciMetrics.savedTokens = Math.max(0, Math.trunc(Number(patch.savedTokens)));
    }
    if (patch.totalAciSavedTokens != null && Number.isFinite(Number(patch.totalAciSavedTokens))) {
      this._aciMetrics.totalAciSavedTokens = Math.max(0, Math.trunc(Number(patch.totalAciSavedTokens)));
    }
    if (patch.restoredCount != null && Number.isFinite(Number(patch.restoredCount))) {
      this._aciMetrics.restoredCount = Math.max(0, Math.trunc(Number(patch.restoredCount)));
    }
    if (patch.hashVerifiedRestores != null && Number.isFinite(Number(patch.hashVerifiedRestores))) {
      this._aciMetrics.hashVerifiedRestores = Math.max(0, Math.trunc(Number(patch.hashVerifiedRestores)));
    }
    if (patch.criticalContextRecall !== undefined) {
      if (patch.criticalContextRecall === null) {
        this._aciMetrics.criticalContextRecall = null;
      } else if (Number.isFinite(Number(patch.criticalContextRecall))) {
        this._aciMetrics.criticalContextRecall = Math.max(
          0,
          Math.min(1, Number(Number(patch.criticalContextRecall).toFixed(4))),
        );
      }
    }
    if (patch.supervisorCalls != null && Number.isFinite(Number(patch.supervisorCalls))) {
      this._aciMetrics.supervisorCalls = Math.max(0, Math.trunc(Number(patch.supervisorCalls)));
    }
    if (patch.supervisorMode !== undefined) {
      this._aciMetrics.supervisorMode = patch.supervisorMode ? String(patch.supervisorMode) : null;
    }
    if (patch.supervisorModel !== undefined) {
      this._aciMetrics.supervisorModel = patch.supervisorModel ? String(patch.supervisorModel) : null;
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
      };
    }
    if (patch.epochTransitions != null && Number.isFinite(Number(patch.epochTransitions))) {
      this._aciMetrics.epochTransitions = Math.max(0, Math.trunc(Number(patch.epochTransitions)));
    }
    if (patch.ledger !== undefined) {
      this._aciMetrics.ledger = patch.ledger ? structuredClone(patch.ledger) : null;
    }
  }

  updateContractEvaluation(evalResult = null) {
    if (!evalResult || typeof evalResult !== 'object') return;
    this._contractComplianceSignals = {
      evaluated: Boolean(evalResult.evaluated),
      ready: evalResult.ready ?? true,
      gapCount: Array.isArray(evalResult.gaps) ? evalResult.gaps.length : 0,
      missingDeliverables: [...(evalResult.missingDeliverables ?? [])],
      invalidJsonFiles: [...(evalResult.invalidJsonFiles ?? [])],
      missingExportedSymbols: [...(evalResult.missingExportedSymbols ?? [])],
      forbiddenViolations: [...(evalResult.forbiddenViolations ?? [])],
      missingContractReads: [...(evalResult.missingContractReads ?? [])],
    };
  }

  #buildMutationBreakdown() {
    return {
      src: [...this._mutatedSrcSet],
      doc: [...this._mutatedDocSet],
      selfTest: [...this._mutatedSelfTestSet],
      baselineTest: [...this._mutatedBaselineTestSet],
      postPassDocOnly:
        this._lastPassingVerificationSeq > -1 &&
        this._lastMutationSeq > this._lastPassingVerificationSeq &&
        this._lastCodeMutationSeq <= this._lastPassingVerificationSeq,
    };
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
          if (this._firstCodeMutationSeq === -1 && !this.rootCauseFilesReadBeforeEdit.includes(normPath)) {
            this.rootCauseFilesReadBeforeEdit.push(normPath);
          }
        }
      }

      if (isNewInspectionPivot) {
        this._editTestFailCycles = 0;
        this._selfTestEditCycles = 0;
      }
    }

    if (!effectiveIsError && toolName === 'update_plan' && Array.isArray(parsedArgs.hypotheses)) {
      this.rootCauseLedger.hypotheses = parsedArgs.hypotheses
        .slice(-10)
        .map((h) => (typeof h === 'string' ? h : String(h?.statement ?? h?.title ?? '')))
        .filter(Boolean);
    }

    // 2. Track file mutations (classified into src / doc / self_test / baseline_test)
    let mutatedFiles = [];
    if (!effectiveIsError && MUTATING_FILE_TOOLS.has(toolName)) {
      mutatedFiles = extractMutatedFilesFromToolCall(toolName, parsedArgs, this.workspaceRoot);
      if (this._firstMutationSeq === -1) {
        this._firstMutationSeq = seq;
      }
      this._lastMutationSeq = seq;
      this._readSignaturesSinceMutation.clear();

      let touchesNonDoc = false;
      for (const f of mutatedFiles) {
        if (!this._filesMutatedSet.has(f)) {
          this._filesMutatedSet.add(f);
          this.filesMutated.push(f);
          if (TEST_MUTATION_PATH_RE.test(f) && !this._baselineTestFilesSet.has(f)) {
            this._selfAuthoredTestFiles.add(f);
          }
        }
        const kind = classifyMutationPath(f, {
          workspaceRoot: this.workspaceRoot,
          baselineTestFiles: this._baselineTestFilesSet,
          selfAuthoredTestFiles: this._selfAuthoredTestFiles,
        });
        if (kind === 'doc') this._mutatedDocSet.add(f);
        else if (kind === 'self_test') this._mutatedSelfTestSet.add(f);
        else if (kind === 'baseline_test') this._mutatedBaselineTestSet.add(f);
        else this._mutatedSrcSet.add(f);

        if (kind !== 'doc') {
          touchesNonDoc = true;
          this._pendingCycleEditCategories.add(kind);
        }
      }

      if (touchesNonDoc) {
        if (this._firstCodeMutationSeq === -1) {
          this._firstCodeMutationSeq = seq;
        }
        this._lastCodeMutationSeq = seq;
        this._hasPendingEditInCycle = true;
        this._rootCauseVerifiedAfterEdit = false;
        this._lastEditPendingVerification = {
          step,
          seq,
          toolName,
          files: [...mutatedFiles],
        };
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
        this._selfTestEditCycles = 0;
        this._hasPendingEditInCycle = false;
        this._pendingCycleEditCategories.clear();
        this._baselineTestFailedInCycle = false;
        this._lastEditPendingVerification = null;
        if (this._reproducedFailureBeforeEdit && this._firstCodeMutationSeq > -1 && seq > this._firstCodeMutationSeq) {
          this._rootCauseVerifiedAfterEdit = true;
          this.rootCauseLedger.resolvedSignatures = [...this.rootCauseLedger.preEditFailureSignatures];
          this.rootCauseLedger.rootCause = {
            suspectedFiles: [...this.rootCauseFilesReadBeforeEdit],
            verifiedCommand: cmd,
            resolvedPreEditFailures: this.rootCauseLedger.resolvedSignatures.length,
          };
        }
      } else {
        this.#recordVerificationFailure({ fingerprint, command: cmd, step, seq });
      }
    } else if (isTestFailHint && !isPolicyRejection) {
      this.#recordVerificationFailure({ fingerprint, command: cmd, step, seq });
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

  #recordVerificationFailure({ fingerprint = null, command = '', step = 0, seq = 0 } = {}) {
    if (this._firstCodeMutationSeq === -1) {
      this._reproducedFailureBeforeEdit = true;
      this.reproductionEvidence.push({
        step,
        seq,
        command,
        signature: fingerprint?.signature ?? null,
        location: fingerprint?.location ?? null,
        errorType: fingerprint?.errorType ?? null,
        excerpt: fingerprint?.assertionExcerpt ?? '',
      });
      if (!this.rootCauseLedger.symptom && (fingerprint?.assertionExcerpt || fingerprint?.summary)) {
        this.rootCauseLedger.symptom = fingerprint.assertionExcerpt || fingerprint.summary;
      }
      if (!this.rootCauseLedger.directCause && (fingerprint?.location || fingerprint?.errorType)) {
        this.rootCauseLedger.directCause = [fingerprint.errorType, fingerprint.location]
          .filter(Boolean)
          .join(' @ ');
      }
      if (fingerprint?.signature && !this.rootCauseLedger.preEditFailureSignatures.includes(fingerprint.signature)) {
        this.rootCauseLedger.preEditFailureSignatures.push(fingerprint.signature);
      }
      if (!this._sawPreEditReproFailure) {
        this._sawPreEditReproFailure = true;
      } else {
        // Re-running a failing test multiple times before any edit is ineffective
        this.ineffectiveActionCount += 1;
        this._nonReproFailureCount += 1;
      }
    } else {
      this._rootCauseVerifiedAfterEdit = false;
      this.ineffectiveActionCount += 1;
      this._nonReproFailureCount += 1;
    }

    const locFile = fingerprint?.location ? String(fingerprint.location).split(':')[0] : null;
    const hitBaselineTest = Boolean(
      (locFile && this._baselineTestFilesSet.has(locFile)) ||
        [...this._baselineTestFilesSet].some(
          (bf) => command.includes(bf) && (!this._selfAuthoredTestFiles.size || ![...this._selfAuthoredTestFiles].some((sf) => command.includes(sf))),
        ),
    );
    if (hitBaselineTest) {
      this._baselineTestFailedInCycle = true;
    }

    if (this._hasPendingEditInCycle) {
      const onlySelfTestsEdited =
        this._pendingCycleEditCategories.size > 0 &&
        [...this._pendingCycleEditCategories].every((c) => c === 'self_test');
      if (onlySelfTestsEdited && !this._baselineTestFailedInCycle) {
        this._selfTestEditCycles += 1;
      } else {
        this._selfTestEditCycles = 0;
        this._editTestFailCycles += 1;
      }
      this._hasPendingEditInCycle = false;
      this._pendingCycleEditCategories.clear();
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

    // Pattern 3: Edit -> test-fail loop (>= 2 cycles on src, or >= 4 after self-test calibration tolerance)
    if (!detected && this._selfTestEditCycles >= 2 && this._selfTestEditCycles < 4) {
      detected = {
        pattern: STUCK_PATTERNS.SELF_TEST_CALIBRATION,
        step,
        seq,
        signature: `self_test_calibration:${fingerprint?.signature ?? this._selfTestEditCycles}`,
        summary: `${this._selfTestEditCycles} consecutive self-authored test edits failed verification while source files and baseline tests remained clean`,
        nonFatal: true,
      };
    } else if (!detected && (this._editTestFailCycles >= 2 || this._selfTestEditCycles >= 4)) {
      const cycles = Math.max(this._editTestFailCycles, this._selfTestEditCycles);
      detected = {
        pattern: STUCK_PATTERNS.EDIT_TEST_FAIL_LOOP,
        step,
        seq,
        signature: fingerprint?.signature ?? 'edit_test_fail_loop',
        summary: `${cycles} consecutive edit -> test-failure cycles without reading new source/root-cause files`,
      };
    }

    // Pattern 4: Normalized same-error-signature streak (>= 3 even when args vary; deferred to >= 4 during self-test calibration)
    const streakThreshold = this._selfTestEditCycles >= 1 && this._selfTestEditCycles < 4 ? 4 : 3;
    if (!detected && effectiveIsError && !isPolicyRejection && this._consecutiveErrorStreak.count >= streakThreshold) {
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

    const isNonFatalPattern =
      detected.nonFatal === true ||
      detected.pattern === STUCK_PATTERNS.POLICY_BLOCK_LOOP ||
      detected.pattern === STUCK_PATTERNS.SELF_TEST_CALIBRATION;
    const isPolicyPattern = detected.pattern === STUCK_PATTERNS.POLICY_BLOCK_LOOP;
    const alreadyWarned = isNonFatalPattern
      ? this._warnedPatterns.has(detected.pattern)
      : [...this._warnedPatterns].some(
          (p) => p !== STUCK_PATTERNS.POLICY_BLOCK_LOOP && p !== STUCK_PATTERNS.SELF_TEST_CALIBRATION,
        );
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
        '1. 目录浏览、文件检索和代码读取请直接使用内置工具 glob / grep / read_file（计算文件哈希请用 compute_file_digest），切勿通过 bash 执行辅助探测脚本。',
        '2. 代码修改请直接使用 write_file / edit_file / apply_patch，并仅在需要验证时运行题目允许的精确测试命令。',
      ].join('\n');
    }
    if (active?.pattern === STUCK_PATTERNS.SELF_TEST_CALIBRATION) {
      const fp = active?.fingerprint ?? this.errorFingerprints.at(-1) ?? null;
      return [
        `[自建测试校准提示] 检测到连续仅修改自建测试文件且源码与基线测试保持稳定 (${active.summary})。`,
        ...(fp ? [`当前失败摘要: ${fp.summary}`] : []),
        '1. 请勿反复盲目重写新建测试，立即使用 read_file 核对目标源码模块的实际返回类型/契约（例如空状态返回 null 或特定结构）。',
        '2. 仅依据已核实的源码契约校准你的自建测试断言，并重跑验证命令通过后立即输出最终总结。',
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
      budgetReserveAdvised: this._budgetReserveAdvised,
      budgetFinalCallAdvised: this._budgetFinalCallAdvised,
      budgetPruneCount: this._budgetPruneCount,
      rootCauseFilesReadBeforeEdit: [...this.rootCauseFilesReadBeforeEdit],
      reproductionEvidence: this.reproductionEvidence.map((r) => ({ ...r })),
      rootCauseLedger: {
        ...this.rootCauseLedger,
        preEditFailureSignatures: [...this.rootCauseLedger.preEditFailureSignatures],
        resolvedSignatures: [...this.rootCauseLedger.resolvedSignatures],
        hypotheses: [...this.rootCauseLedger.hypotheses],
      },
      rootCauseVerifiedAfterEdit: this._rootCauseVerifiedAfterEdit,
      rootCauseVerified: this._rootCauseVerifiedAfterEdit,
      mutationBreakdown: this.#buildMutationBreakdown(),
      contractComplianceSignals: { ...this._contractComplianceSignals },
      errorFingerprints: this.errorFingerprints.map((fp) => ({ ...fp })),
      falsifiedAttempts: this.falsifiedAttempts.map((a) => ({ ...a })),
      stuckDetections: this.stuckDetections.map((d) => ({ ...d })),
      repairRounds: this._repairRounds,
      aciMetrics: structuredClone(this._aciMetrics),
    };
  }

  getMetrics({ finalOutcomePassed = null, stopReason = null } = {}) {
    const codeSeqStart = this._firstCodeMutationSeq !== -1 ? this._firstCodeMutationSeq : this._firstMutationSeq;
    const postEditVerifications =
      codeSeqStart === -1
        ? []
        : this.verifications.filter((v) => v.seq > codeSeqStart);
    const latestVerification = this.verifications.at(-1) ?? null;
    const executionStuckDetections = this.stuckDetections.filter(
      (d) =>
        d.pattern !== STUCK_PATTERNS.POLICY_BLOCK_LOOP &&
        d.pattern !== STUCK_PATTERNS.SELF_TEST_CALIBRATION,
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
      budgetReserveAdvised: this._budgetReserveAdvised,
      budgetFinalCallAdvised: this._budgetFinalCallAdvised,
      budgetPruneCount: this._budgetPruneCount,
      firstFixSucceeded,
      selfCorrectionRecovered,
      rootCauseFilesReadBeforeEdit: [...this.rootCauseFilesReadBeforeEdit],
      reproductionEvidence: this.reproductionEvidence.map((r) => ({ ...r })),
      rootCauseLedger: {
        ...this.rootCauseLedger,
        preEditFailureSignatures: [...this.rootCauseLedger.preEditFailureSignatures],
        resolvedSignatures: [...this.rootCauseLedger.resolvedSignatures],
        hypotheses: [...this.rootCauseLedger.hypotheses],
      },
      rootCauseVerifiedAfterEdit: this._rootCauseVerifiedAfterEdit,
      rootCauseVerified: this._rootCauseVerifiedAfterEdit,
      mutationBreakdown: this.#buildMutationBreakdown(),
      contractComplianceSignals: { ...this._contractComplianceSignals },
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
      thrashWarned: [...this._warnedPatterns].some(
        (p) =>
          p !== STUCK_PATTERNS.POLICY_BLOCK_LOOP &&
          p !== STUCK_PATTERNS.SELF_TEST_CALIBRATION,
      ),
      circuitBroken: stopReason === 'thrashing_circuit_break',
      latestVerificationPassed: latestVerification ? latestVerification.passed : null,
      aciMetrics: structuredClone(this._aciMetrics),
    };
  }
}
