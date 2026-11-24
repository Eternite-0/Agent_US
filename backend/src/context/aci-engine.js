import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { estimateTokens, measureRequestComposition, pairClosed } from '../context.js';
import { redactSecrets, sanitize } from '../envelope.js';
import { classifyMutationPath, isVerificationCommand } from '../kernel/execution-reasoning.js';
import { extractRepositorySymbols } from '../repo-symbols.js';
import {
  ReversibleContextStore,
  formatAciRefStub,
  normalizeContextPath,
} from './aci-store.js';
import {
  DEFAULT_ADMISSION_MIN_CHARS,
  DEFAULT_MAX_SUPERVISOR_ADMISSION_CALLS,
  PreInjectionAdmissionController,
} from './aci-admission.js';

export const DEFAULT_ACI_WEIGHTS = Object.freeze({
  errorTrace: 0.35,
  contractFile: 0.25,
  recentEdit: 0.2,
  symbolOverlap: 0.12,
  recency: 0.08,
});

export const DEFAULT_EPOCH_WATERMARKS = Object.freeze([0.6, 0.82]);
export const PHASE_WATERMARK_V25_EPOCH_WATERMARKS = Object.freeze([0.78, 0.9]);
export const DEFAULT_SINGLE_STEP_BUDGET = 8000;
export const DEFAULT_DTOC_MIN_CHARS = 700;
export const DEFAULT_DTOC_SUPERSEDED_MIN_CHARS = 600;
export const DEFAULT_DTOC_POLICY = 'adaptive_single_step';
export const PHASE_WATERMARK_V25_DTOC_POLICY = 'phase_watermark_v25';
export const VALID_DTOC_POLICIES = Object.freeze([
  DEFAULT_DTOC_POLICY,
  'cumulative',
  PHASE_WATERMARK_V25_DTOC_POLICY,
]);
export const DEFAULT_DTOC_MIN_PROMPT_TOKENS = 24000;
export const DEFAULT_DTOC_PRESSURE_MIN_TOKENS = 28000;
export const DEFAULT_DTOC_PRESSURE_RATIO = 0.65;
export const DEFAULT_DTOC_MIN_NET_SAVINGS_TOKENS = 1200;
export const DEFAULT_DTOC_RECENT_EDIT_SHIELD_STEPS = 4;
export const ACON_SETTINGS_KEY = 'aci.learned_guidelines';
export const ACON_MAX_GUIDELINES = 12;

export function normalizeDtocPolicy(dtocPolicy) {
  if (
    dtocPolicy === 'cumulative' ||
    dtocPolicy === PHASE_WATERMARK_V25_DTOC_POLICY ||
    dtocPolicy === DEFAULT_DTOC_POLICY
  ) {
    return dtocPolicy;
  }
  return DEFAULT_DTOC_POLICY;
}

export function resolveWatermarksForPolicy(dtocPolicy, explicitWatermarks = null) {
  if (Array.isArray(explicitWatermarks) && explicitWatermarks.length > 0) {
    const cleaned = explicitWatermarks
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0 && n < 1);
    if (cleaned.length > 0) return cleaned;
  }
  return normalizeDtocPolicy(dtocPolicy) === PHASE_WATERMARK_V25_DTOC_POLICY
    ? [...PHASE_WATERMARK_V25_EPOCH_WATERMARKS]
    : [...DEFAULT_EPOCH_WATERMARKS];
}

const COMPRESSIBLE_TOOLS = new Set(['read_file', 'glob', 'grep', 'bash']);
const MUTATION_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch', 'delete_file']);

const ERROR_OUTPUT_RE =
  /(?:^exitCode:\s*[1-9]\d*\b|\bexitCode:\s*[1-9]\d*\b|exit\s+code[:=\s]+[1-9]\d*\b|\[(?:NON_ZERO_EXIT|TOOL_ERROR)\]|AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|ERR_ASSERTION|ENOENT|EACCES|ECONNREFUSED|Traceback \(most recent call last\)|\b(?:FAIL|FAILED|FATAL|PANIC)\b|✖\s|×\s|^not ok \d+|^\s*(?:Expected|Actual|Received)\b|^\s+at\s+\S+:\d+:\d+|^\s+File\s+".+",\s+line\s+\d+|\bTS\d{4,5}:|\berror\[E\d+\]|\bError:\s|^(?:FILE_NOT_FOUND|EISDIR|参数校验失败|安全策略拦截|文件不存在|读取失败|错误[:：]))/m;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'where',
  'what', 'which', 'will', 'have', 'been', 'true', 'false', 'null', 'undefined',
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'default',
  'async', 'await', 'class', 'new', 'try', 'catch', 'throw', 'else', 'if',
]);

const CONTRACT_PATH_RE =
  /(?:^|\/)(?:agents\.md|spec\.md|constraints\.md|contract\.json|package\.json|tsconfig(?:\.[^/]+)?\.json|readme\.md|.*contract.*|.*schema.*|.*interface.*|.*types?\.[^/]+|.*\.d\.ts|store\.js|routes\/[^/]+|api\/[^/]+)$/i;

const STRICT_DTOC_CONTRACT_RE =
  /(?:^|\/)(?:spec\.md|contract\.json|constraints\.md|agents\.md)$/i;

export function detectLanguageFromPath(filePath) {
  const ext = extname(String(filePath || '').trim().toLowerCase());
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.jsx') return 'javascript';
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.py') return 'python';
  if (ext === '.rs') return 'rust';
  if (ext === '.go') return 'go';
  return null;
}

function isAciStubText(text) {
  return typeof text === 'string' && (text.startsWith('[ACI-REF ') || text.startsWith('[ACI-SKIP '));
}

function tokenizeIdentifiers(text) {
  const tokens = new Set();
  const matches = String(text ?? '').match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [];
  for (const m of matches) {
    const lower = m.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    tokens.add(m);
  }
  return tokens;
}

export function extractSymbolsFromText(filePath, text) {
  const raw = String(text ?? '');
  const path = String(filePath || 'unknown');
  const lang = detectLanguageFromPath(path);
  if (lang) {
    try {
      const extracted = extractRepositorySymbols(path, lang, raw);
      const defs = (extracted.definitions ?? []).map((d) => ({
        name: d.owner ? `${d.owner}.${d.name}` : d.name,
        shortName: d.name,
        kind: d.kind,
        line: d.line,
      }));
      const calls = (extracted.calls ?? []).map((c) => ({
        name: c.name,
        specifier: c.specifier ?? null,
        line: c.line,
      }));
      return {
        definitions: defs,
        calls,
        names: [...new Set(defs.map((d) => d.name))],
      };
    } catch {
      // Fallback below
    }
  }
  const headingNames = [];
  for (const m of raw.matchAll(/^#{1,4}\s+(.+)$/gm)) {
    const h = m[1].trim();
    if (h) headingNames.push(h.slice(0, 60));
  }
  return {
    definitions: headingNames.map((name, i) => ({ name, shortName: name, kind: 'heading', line: i + 1 })),
    calls: [],
    names: [...new Set(headingNames)].slice(0, 12),
  };
}

export function extractErrorFeedbackSignals(errorText) {
  const text = String(errorText ?? '');
  const files = new Set();
  const lines = new Map();
  const symbols = new Set();
  const signatures = [];

  if (!text.trim()) {
    return { files: [], linesByFile: {}, symbols: [], signatures: [] };
  }

  // Stack frames & file:line:col references
  const pathPatterns = [
    /(?:at\s+([A-Za-z_$][\w$.]*)\s+\()?((?:[A-Za-z]:)?[^:\s()"'`]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rs|go|json)):(\d+)(?::\d+)?\)?/g,
    /File\s+"([^"]+)",\s+line\s+(\d+)/g,
    /(?:FAIL|ERROR|Error in)\s+([^\s:]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rs|go))/g,
  ];

  for (const m of text.matchAll(pathPatterns[0])) {
    const fn = m[1];
    const file = m[2];
    const lineNum = Number(m[3]);
    const norm = normalizeContextPath(file);
    if (norm) {
      files.add(norm);
      if (Number.isFinite(lineNum)) {
        const list = lines.get(norm) ?? [];
        list.push(lineNum);
        lines.set(norm, list);
      }
    }
    if (fn) {
      for (const part of fn.split('.')) {
        if (part.length >= 2 && !STOPWORDS.has(part.toLowerCase())) symbols.add(part);
      }
    }
  }
  for (const m of text.matchAll(pathPatterns[1])) {
    const norm = normalizeContextPath(m[1]);
    const lineNum = Number(m[2]);
    if (norm) {
      files.add(norm);
      if (Number.isFinite(lineNum)) {
        const list = lines.get(norm) ?? [];
        list.push(lineNum);
        lines.set(norm, list);
      }
    }
  }
  for (const m of text.matchAll(pathPatterns[2])) {
    const norm = normalizeContextPath(m[1]);
    if (norm) files.add(norm);
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (ERROR_OUTPUT_RE.test(trimmed)) {
      signatures.push(trimmed.slice(0, 180));
      for (const tok of tokenizeIdentifiers(trimmed)) {
        symbols.add(tok);
      }
    }
  }

  const linesByFile = {};
  for (const [k, v] of lines.entries()) {
    linesByFile[k] = [...new Set(v)];
  }

  return {
    files: [...files],
    linesByFile,
    symbols: [...symbols],
    signatures: [...new Set(signatures)].slice(0, 12),
  };
}

function isStrictDtocContractPath(filePath, contractFiles = []) {
  const norm = normalizeContextPath(filePath);
  if (!norm) return false;
  for (const cf of contractFiles ?? []) {
    const ncf = normalizeContextPath(cf);
    if (ncf && (norm === ncf || norm.endsWith(`/${ncf}`) || ncf.endsWith(`/${norm}`))) {
      return true;
    }
  }
  return STRICT_DTOC_CONTRACT_RE.test(norm);
}

function isContractPath(filePath, contractFiles = []) {
  const norm = normalizeContextPath(filePath);
  if (!norm) return false;
  for (const cf of contractFiles ?? []) {
    const ncf = normalizeContextPath(cf);
    if (ncf && (norm === ncf || norm.endsWith(`/${ncf}`) || ncf.endsWith(`/${norm}`))) {
      return true;
    }
  }
  return CONTRACT_PATH_RE.test(norm);
}

function pathMatchesAny(path, pathSet) {
  const norm = normalizeContextPath(path);
  if (!norm) return false;
  for (const other of pathSet) {
    if (!other) continue;
    if (norm === other || norm.endsWith(`/${other}`) || other.endsWith(`/${norm}`)) {
      return true;
    }
  }
  return false;
}

function parseToolArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object') return rawArgs;
  try {
    const parsed = JSON.parse(String(rawArgs));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function extractPathsFromMutationToolCall(name, args) {
  const paths = [];
  const addPath = (raw) => {
    const norm = normalizeContextPath(raw);
    if (norm && !paths.includes(norm)) paths.push(norm);
  };
  if (name === 'apply_patch') {
    const patchText = String(args?.patch ?? args?.patchText ?? args?.input ?? '');
    for (const match of patchText.matchAll(/^\*\*\*\s+(?:Add|Update|Delete|Move to:)\s*(?:File:\s*)?(.+)$/gm)) {
      addPath(match[1]);
    }
    for (const match of patchText.matchAll(/^(?:\+\+\+|---)\s+(?:a\/|b\/)?([^\t\r\n]+)(?:\t.*)?$/gm)) {
      const candidate = String(match[1] ?? '').trim();
      if (candidate && candidate !== '/dev/null' && candidate !== 'dev/null') addPath(candidate);
    }
  } else {
    addPath(args?.path ?? args?.filePath ?? args?.file ?? args?.target_file ?? '');
  }
  return paths;
}

function assignMessageSteps(srcMessages = [], currentStep = undefined) {
  const msgSteps = [];
  let stepCounter = 0;
  for (const m of srcMessages) {
    if (m?.step != null && m.step !== '' && Number.isFinite(Number(m.step))) {
      stepCounter = Math.max(stepCounter, Number(m.step));
      msgSteps.push(Number(m.step));
    } else {
      if (m?.role === 'assistant') stepCounter += 1;
      msgSteps.push(stepCounter);
    }
  }
  const effectiveCurrentStep =
    currentStep != null && currentStep !== '' && Number.isFinite(Number(currentStep))
      ? Number(currentStep)
      : stepCounter;
  return { msgSteps, effectiveCurrentStep };
}

function indexToolCallsAndMutations(srcMessages = [], msgSteps = [], activeMutationTargets = []) {
  const toolCallsById = new Map();
  const activeMutations = new Set();
  const explicitActiveMutations = new Set();
  const lastMutationStepByPath = new Map();

  for (let i = 0; i < srcMessages.length; i += 1) {
    const m = srcMessages[i];
    if (m?.role !== 'assistant') continue;
    const step = msgSteps[i] ?? 0;
    const blocks = [
      ...(Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'tool-call') : []),
      ...(Array.isArray(m.toolCalls) ? m.toolCalls : []),
    ];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      const toolName = String(b.name || '').trim();
      const lower = toolName.toLowerCase();
      const args = parseToolArgs(b.arguments);
      if (b.id && !toolCallsById.has(b.id)) {
        toolCallsById.set(b.id, { name: toolName, args, step });
      }
      if (MUTATION_TOOLS.has(lower)) {
        for (const norm of extractPathsFromMutationToolCall(lower, args)) {
          activeMutations.add(norm);
          const prev = lastMutationStepByPath.get(norm) ?? -1;
          if (step > prev) lastMutationStepByPath.set(norm, step);
        }
      }
    }
  }

  for (const p of activeMutationTargets ?? []) {
    const norm = normalizeContextPath(p);
    if (norm) {
      activeMutations.add(norm);
      explicitActiveMutations.add(norm);
    }
  }

  return { toolCallsById, activeMutations, explicitActiveMutations, lastMutationStepByPath };
}

function findLastMutationStep(rawFilePath, lastMutationStepByPath) {
  const norm = normalizeContextPath(rawFilePath);
  if (!norm || !lastMutationStepByPath?.size) return -1;
  let maxStep = -1;
  for (const [mutPath, mutStep] of lastMutationStepByPath.entries()) {
    if (norm === mutPath || norm.endsWith(`/${mutPath}`) || mutPath.endsWith(`/${norm}`)) {
      if (mutStep > maxStep) maxStep = mutStep;
    }
  }
  return maxStep;
}

function extractMutationPathsFromMessages(messages) {
  const { msgSteps } = assignMessageSteps(messages);
  return indexToolCallsAndMutations(messages, msgSteps).activeMutations;
}

function extractLocalContextCoverage(localContextMessages = [], activeDiff = '', coveredPaths = [], coveredSymbols = []) {
  const paths = new Set();
  const symbols = new Set();

  for (const p of coveredPaths ?? []) {
    const norm = normalizeContextPath(p);
    if (norm) paths.add(norm);
  }
  for (const s of coveredSymbols ?? []) {
    const clean = String(s || '').trim();
    if (clean) symbols.add(clean);
  }

  for (const m of localContextMessages ?? []) {
    if (m?.path) {
      const norm = normalizeContextPath(m.path);
      if (norm) paths.add(norm);
    }
    const text = Array.isArray(m?.content)
      ? m.content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
      : typeof m?.content === 'string'
        ? m.content
        : typeof m?.text === 'string'
          ? m.text
          : '';
    if (!text || isAciStubText(text)) continue;
    if (m?.path) {
      for (const def of extractSymbolsFromText(m.path, text).definitions) {
        symbols.add(def.shortName || def.name);
        symbols.add(def.name);
      }
    }
    for (const tok of tokenizeIdentifiers(text)) {
      symbols.add(tok);
    }
  }

  if (activeDiff) {
    for (const match of String(activeDiff).matchAll(/^(?:---|\+\+\+|diff --git)\s+(?:a\/|b\/)?([^\s]+)/gm)) {
      const norm = normalizeContextPath(match[1]);
      if (norm && norm !== '/dev/null') paths.add(norm);
    }
    for (const tok of tokenizeIdentifiers(activeDiff)) {
      symbols.add(tok);
    }
  }

  return { paths, symbols };
}

/**
 * Repoformer-style selective retrieval gating:
 * abstains when local context / active diff already covers the needed symbols & paths.
 */
export function evaluateRetrievalGate({
  query = '',
  targetPaths = [],
  neededSymbols = [],
  localContextMessages = [],
  activeDiff = '',
  coveredPaths = [],
  coveredSymbols = [],
  errorText = '',
  abstainThreshold = 0.85,
  step = 0,
  ledger = null,
} = {}) {
  const local = extractLocalContextCoverage(localContextMessages, activeDiff, coveredPaths, coveredSymbols);
  const errorSignals = extractErrorFeedbackSignals(errorText);

  const normalizedTargets = [...new Set((targetPaths ?? []).map(normalizeContextPath).filter(Boolean))];
  const uncoveredPaths = normalizedTargets.filter((p) => !pathMatchesAny(p, local.paths));

  // Include failing files from error traces if not covered
  for (const ef of errorSignals.files) {
    if (!pathMatchesAny(ef, local.paths) && !uncoveredPaths.includes(ef)) {
      uncoveredPaths.push(ef);
    }
  }

  const requiredSymbols = new Set();
  for (const s of neededSymbols ?? []) {
    const clean = String(s || '').trim();
    if (clean) requiredSymbols.add(clean);
  }
  for (const tok of tokenizeIdentifiers(query)) {
    requiredSymbols.add(tok);
  }
  for (const s of errorSignals.symbols) {
    requiredSymbols.add(s);
  }

  const localLower = new Set([...local.symbols].map((s) => s.toLowerCase()));
  const uncoveredSymbols = [];
  let coveredCount = 0;
  for (const sym of requiredSymbols) {
    if (local.symbols.has(sym) || localLower.has(sym.toLowerCase())) {
      coveredCount += 1;
    } else {
      uncoveredSymbols.push(sym);
    }
  }

  const symbolCoverage = requiredSymbols.size > 0 ? coveredCount / requiredSymbols.size : 1;
  const pathCoverage = normalizedTargets.length > 0
    ? (normalizedTargets.length - normalizedTargets.filter((p) => !pathMatchesAny(p, local.paths)).length) / normalizedTargets.length
    : 1;
  const coverage = Number(((symbolCoverage * 0.7) + (pathCoverage * 0.3)).toFixed(4));

  const hasErrorUncovered = errorSignals.files.some((f) => !pathMatchesAny(f, local.paths));
  const hasLocalEvidence = local.paths.size > 0 || local.symbols.size > 0;
  const canAbstain =
    hasLocalEvidence &&
    !hasErrorUncovered &&
    uncoveredPaths.length === 0 &&
    symbolCoverage >= abstainThreshold;

  if (canAbstain) {
    const decision = {
      action: 'abstain',
      abstain: true,
      reason: 'local_context_sufficient',
      coverage,
      symbolCoverage,
      pathCoverage,
      uncoveredSymbols: [],
      uncoveredPaths: [],
    };
    ledger?.recordAbstained({ query, reason: decision.reason, coverage, step });
    return decision;
  }

  return {
    action: 'retrieve',
    abstain: false,
    reason: hasErrorUncovered
      ? 'error_trace_uncovered'
      : uncoveredPaths.length > 0
        ? 'uncovered_target_paths'
        : 'uncovered_symbols',
    coverage,
    symbolCoverage,
    pathCoverage,
    uncoveredSymbols,
    uncoveredPaths,
  };
}

/**
 * Computes multi-signal relevance score for a single candidate.
 */
export function scoreCandidate(
  candidate,
  {
    errorSignals = { files: [], symbols: [], signatures: [] },
    querySymbols = new Set(),
    contractFiles = [],
    recentEdits = [],
    currentStep = 0,
    weights = DEFAULT_ACI_WEIGHTS,
  } = {},
) {
  const path = String(candidate?.path || '').trim();
  const normPath = normalizeContextPath(path);
  const errorFileSet = new Set((errorSignals.files ?? []).map(normalizeContextPath).filter(Boolean));
  const recentEditSet = new Set((recentEdits ?? []).map(normalizeContextPath).filter(Boolean));

  const candSymbols = new Set();
  for (const s of candidate?.symbols ?? candidate?.symbolOutline ?? []) {
    const clean = String(s || '').trim();
    if (clean) candSymbols.add(clean);
  }
  if (candidate?.content && candSymbols.size === 0) {
    for (const def of extractSymbolsFromText(path, candidate.content).definitions) {
      candSymbols.add(def.shortName || def.name);
      candSymbols.add(def.name);
    }
  }
  const candLower = new Set([...candSymbols].map((s) => s.toLowerCase()));

  // 1. errorTrace signal
  let errorTrace = 0;
  const matchedErrors = [];
  if (normPath && pathMatchesAny(normPath, errorFileSet)) {
    errorTrace = 1;
    matchedErrors.push(`file:${path}`);
  } else {
    for (const es of errorSignals.symbols ?? []) {
      if (candSymbols.has(es) || candLower.has(String(es).toLowerCase())) {
        errorTrace = Math.max(errorTrace, 0.75);
        matchedErrors.push(`symbol:${es}`);
      }
    }
    if (errorTrace === 0 && candidate?.hasError) {
      errorTrace = 0.85;
      matchedErrors.push('candidate:error');
    }
  }

  // 2. contractFile signal
  const contractFile =
    candidate?.isContractFile === true || isContractPath(path, contractFiles) ? 1 : 0;

  // 3. recentEdit signal
  let recentEdit = 0;
  if (candidate?.isRecentEdit === true || (normPath && pathMatchesAny(normPath, recentEditSet))) {
    recentEdit = 1;
  }

  // 4. symbolOverlap signal
  let symbolOverlap = 0;
  const matchedSymbols = [];
  if (querySymbols.size > 0 && candSymbols.size > 0) {
    for (const qs of querySymbols) {
      if (candSymbols.has(qs) || candLower.has(String(qs).toLowerCase())) {
        matchedSymbols.push(qs);
      }
    }
    symbolOverlap = Math.min(1, matchedSymbols.length / Math.max(1, Math.min(querySymbols.size, 4)));
  }

  // 5. recency signal
  const stepVal =
    candidate?.step != null && candidate.step !== '' && Number.isFinite(Number(candidate.step))
      ? Number(candidate.step)
      : currentStep;
  const ageSteps = Math.max(0, Number(currentStep || 0) - stepVal);
  const recency = 1 / (1 + ageSteps / 4);

  const w = { ...DEFAULT_ACI_WEIGHTS, ...(weights ?? {}) };
  const score = Number(
    (
      errorTrace * w.errorTrace +
      contractFile * w.contractFile +
      recentEdit * w.recentEdit +
      symbolOverlap * w.symbolOverlap +
      recency * w.recency
    ).toFixed(6),
  );

  return {
    ...candidate,
    path,
    symbols: [...candSymbols],
    score,
    signals: {
      errorTrace,
      contractFile,
      recentEdit,
      symbolOverlap,
      recency,
    },
    matchedSymbols,
    matchedErrors,
  };
}

/**
 * RepoCoder-style iterative refinement incorporating test errors, stack traces,
 * and `repo-symbols.js` symbol extraction alongside Repoformer gating.
 */
export function refineCandidates(
  candidates = [],
  {
    query = '',
    testErrors = '',
    stackTraces = '',
    activeDiff = '',
    localContextMessages = [],
    coveredPaths = [],
    coveredSymbols = [],
    contractFiles = [],
    recentEdits = [],
    currentStep = 0,
    fileContents = {},
    weights = DEFAULT_ACI_WEIGHTS,
    ledger = null,
  } = {},
) {
  const combinedErrors = [testErrors, stackTraces].filter(Boolean).join('\n');
  const errorSignals = extractErrorFeedbackSignals(combinedErrors);

  const querySymbols = new Set();
  for (const tok of tokenizeIdentifiers(query)) querySymbols.add(tok);
  for (const s of errorSignals.symbols) querySymbols.add(s);

  // Extract symbols & cross-file calls from activeDiff or supplied fileContents
  if (activeDiff) {
    for (const tok of tokenizeIdentifiers(activeDiff)) querySymbols.add(tok);
  }
  const enrichedCandidates = (candidates ?? []).map((cand) => {
    const rawContent = cand.content ?? (cand.path ? fileContents[cand.path] : undefined);
    if (!rawContent) return { ...cand };
    const extracted = extractSymbolsFromText(cand.path, rawContent);
    // Boost querySymbols with callees from failing files
    if (cand.path && errorSignals.files.some((ef) => pathMatchesAny(cand.path, new Set([ef])))) {
      for (const call of extracted.calls) {
        if (call.name) querySymbols.add(call.name);
      }
    }
    const mergedSymbols = [...new Set([...(cand.symbols ?? []), ...extracted.names])];
    return { ...cand, symbols: mergedSymbols };
  });

  const targetPaths = enrichedCandidates.map((c) => c.path).filter(Boolean);
  const gate = evaluateRetrievalGate({
    query,
    targetPaths,
    neededSymbols: [...querySymbols],
    localContextMessages,
    activeDiff,
    coveredPaths,
    coveredSymbols,
    errorText: combinedErrors,
    step: currentStep,
    ledger,
  });

  const scored = enrichedCandidates
    .map((cand) =>
      scoreCandidate(cand, {
        errorSignals,
        querySymbols,
        contractFiles,
        recentEdits,
        currentStep,
        weights,
      }),
    )
    .sort((a, b) => b.score - a.score);

  ledger?.recordDiscovered(
    scored.map((s) => ({
      refId: s.refId ?? null,
      path: s.path,
      score: s.score,
      source: s.source || 'repocoder',
      step: currentStep,
      symbols: s.symbols,
    })),
  );

  return {
    gate,
    candidates: scored,
    errorSignals,
    querySymbols: [...querySymbols],
  };
}

function extractTextFromToolMessage(msg) {
  return (msg?.content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function isErrorToolMessage(msg, text) {
  if (msg?.isError === true || msg?.meta?.isError === true) return true;
  const raw = String(text ?? '');
  const m = raw.match(/^<untrusted\s+id="([^"]+)"\s+bytes="\d+">([\s\S]*)<\/untrusted\s+id="\1">$/);
  const inner = m ? m[2] : raw;
  if (/\[run_diagnostics\s+[^\]]*\bok=false\b/i.test(inner)) return true;
  if (ERROR_OUTPUT_RE.test(inner) || ERROR_OUTPUT_RE.test(raw)) return true;
  return false;
}

function findLatestErrorToolMessageIndex(srcMessages = []) {
  for (let i = srcMessages.length - 1; i >= 0; i -= 1) {
    const m = srcMessages[i];
    if (m?.role !== 'tool') continue;
    if (isErrorToolMessage(m, extractTextFromToolMessage(m))) {
      return i;
    }
  }
  return -1;
}

function derivePhaseSignalsFromMessages(srcMessages = [], toolCallsById = new Map(), lastMutationStepByPath = new Map()) {
  let verificationCount = 0;
  let seq = 0;
  let lastPassingVerifSeq = -1;
  const srcMutSeqByPath = new Map();

  for (let i = 0; i < srcMessages.length; i += 1) {
    const m = srcMessages[i];
    if (m?.role !== 'tool') continue;
    seq += 1;
    const tc = m.toolCallId ? toolCallsById.get(m.toolCallId) : null;
    const toolName = String(tc?.name || m.toolName || m.name || '').trim();
    const lowerTool = toolName.toLowerCase();
    const args = tc?.args ?? {};
    const rawText = extractTextFromToolMessage(m);
    const isErr = isErrorToolMessage(m, rawText);

    if (MUTATION_TOOLS.has(lowerTool) && !isErr) {
      for (const p of extractPathsFromMutationToolCall(lowerTool, args)) {
        if (classifyMutationPath(p) === 'src') {
          srcMutSeqByPath.set(p, seq);
        }
      }
    }

    const cmd = typeof args?.command === 'string' ? args.command.trim() : '';
    const isVerif =
      ((lowerTool === 'bash' || lowerTool === 'start_process') && isVerificationCommand(cmd)) ||
      (lowerTool === 'run_diagnostics' && (!args?.kind || args.kind === 'test' || args.kind === 'auto' || args.kind === 'typecheck'));
    if (isVerif) {
      verificationCount += 1;
      if (!isErr) {
        lastPassingVerifSeq = seq;
      }
    }
  }

  if (srcMutSeqByPath.size === 0 && lastMutationStepByPath.size > 0 && lastPassingVerifSeq === -1) {
    for (const mutPath of lastMutationStepByPath.keys()) {
      if (classifyMutationPath(mutPath) === 'src') {
        srcMutSeqByPath.set(mutPath, 1);
      }
    }
  }

  let unverifiedSrcMutations = 0;
  for (const mutSeq of srcMutSeqByPath.values()) {
    if (mutSeq > lastPassingVerifSeq) unverifiedSrcMutations += 1;
  }
  return { verificationCount, unverifiedSrcMutations };
}

function extractToolTargetPath(toolName, args) {
  const lower = String(toolName || '').toLowerCase();
  const filePath = String(
    args?.path ?? args?.filePath ?? args?.file ?? args?.target_file ?? '',
  ).trim();
  if (filePath) return filePath.replace(/\\/g, '/');
  if (lower === 'grep' && args?.pattern) {
    return `grep:${String(args.pattern).slice(0, 60)}`;
  }
  if (lower === 'glob' && args?.pattern) {
    return `glob:${String(args.pattern).slice(0, 60)}`;
  }
  if (lower === 'bash') {
    const cmd = String(args?.command ?? args?.cmd ?? '').trim();
    return cmd ? `bash:${cmd.slice(0, 60)}` : 'bash';
  }
  return lower || 'tool';
}

function extractLineRangeLabel(args, rawText) {
  const start = args?.startLine ?? args?.start_line;
  const end = args?.endLine ?? args?.end_line;
  if (start != null || end != null) {
    const from = Number.isFinite(Number(start)) ? Math.max(1, Number(start)) : 1;
    const to = end != null && Number.isFinite(Number(end)) ? Math.max(from, Number(end)) : 'EOF';
    return `L${from}-${to}`;
  }
  const lineCount = String(rawText ?? '').split(/\r?\n/).length;
  return `L1-${lineCount}`;
}

function normalizeIdSet(values) {
  const set = new Set();
  for (const v of values ?? []) {
    const s = String(v ?? '').trim();
    if (s) set.add(s);
  }
  return set;
}

function sha256HexLocal(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function buildDtocCandidateContext(
  srcMessages,
  {
    currentStep = undefined,
    activeMutationTargets = [],
    keepRefs = [],
    compressRefs = [],
  } = {},
) {
  const { msgSteps, effectiveCurrentStep } = assignMessageSteps(srcMessages, currentStep);
  const {
    toolCallsById,
    activeMutations,
    explicitActiveMutations,
    lastMutationStepByPath,
  } = indexToolCallsAndMutations(srcMessages, msgSteps, activeMutationTargets);
  const latestErrorIndex = findLatestErrorToolMessageIndex(srcMessages);
  const keepSet = normalizeIdSet(keepRefs);
  const preferCompressSet = normalizeIdSet(compressRefs);
  return {
    msgSteps,
    effectiveCurrentStep,
    toolCallsById,
    activeMutations,
    explicitActiveMutations,
    lastMutationStepByPath,
    latestErrorIndex,
    keepSet,
    preferCompressSet,
  };
}

function computeEpochTriggerState(
  messages,
  {
    maxTotalTokens = 128000,
    contextWindow = 128000,
    cumulativeUsedTokens = null,
    watermarks = undefined,
    singleStepBudget = DEFAULT_SINGLE_STEP_BUDGET,
    dtocPolicy = DEFAULT_DTOC_POLICY,
    dtocMinPromptTokens = DEFAULT_DTOC_MIN_PROMPT_TOKENS,
    minNetSavingsTokens = DEFAULT_DTOC_MIN_NET_SAVINGS_TOKENS,
    recentEditShieldSteps = DEFAULT_DTOC_RECENT_EDIT_SHIELD_STEPS,
    epochState = { lastWatermark: -1, epochCount: 0 },
    singleStepTokens = undefined,
    currentStep = undefined,
    verificationCount = undefined,
    unverifiedSrcMutations = undefined,
    minAgeSteps = 3,
    minChars = DEFAULT_DTOC_MIN_CHARS,
    supersededMinAgeSteps = 2,
    supersededMinChars = DEFAULT_DTOC_SUPERSEDED_MIN_CHARS,
    compressibleTools = COMPRESSIBLE_TOOLS,
    keepRefs = [],
    compressRefs = [],
    activeMutationTargets = [],
    contractFiles = [],
    systemPrompt = '',
    tools = [],
  } = {},
) {
  const srcMessages = Array.isArray(messages) ? messages : [];
  const policy = normalizeDtocPolicy(dtocPolicy);
  const minPromptTokens = Math.max(
    1000,
    Number(dtocMinPromptTokens ?? DEFAULT_DTOC_MIN_PROMPT_TOKENS),
  );
  const effectiveMinNetSavings = Math.max(
    0,
    Number(minNetSavingsTokens ?? DEFAULT_DTOC_MIN_NET_SAVINGS_TOKENS),
  );
  const effectiveShieldSteps = Math.max(
    0,
    Number(recentEditShieldSteps ?? DEFAULT_DTOC_RECENT_EDIT_SHIELD_STEPS),
  );
  const sortedWatermarks = [...resolveWatermarksForPolicy(policy, watermarks)]
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0 && n < 1)
    .sort((a, b) => a - b);

  const compBefore = measureRequestComposition({
    system: systemPrompt,
    tools,
    messages: srcMessages,
  });
  const tokensBefore = compBefore.totalTokens;
  const singleStepRatio = contextWindow > 0 ? tokensBefore / contextWindow : 0;
  const hasCumulative =
    cumulativeUsedTokens != null &&
    cumulativeUsedTokens !== '' &&
    Number.isFinite(Number(cumulativeUsedTokens));
  const usedCumulative = hasCumulative ? Math.max(0, Number(cumulativeUsedTokens)) : 0;
  const cumulativeRatio =
    hasCumulative && maxTotalTokens > 0
      ? (usedCumulative + tokensBefore) / maxTotalTokens
      : maxTotalTokens > 0
        ? tokensBefore / maxTotalTokens
        : 0;

  const hasExplicitSingleStep =
    singleStepTokens != null && singleStepTokens !== '' && Number.isFinite(Number(singleStepTokens));
  let measuredSingleStep = hasExplicitSingleStep ? Number(singleStepTokens) : 0;
  if (!hasExplicitSingleStep && srcMessages.length > 0) {
    let tailTokens = 0;
    for (let i = srcMessages.length - 1; i >= 0; i -= 1) {
      const m = srcMessages[i];
      const msgTok = measureRequestComposition({ messages: [m] }).totalTokens;
      if (m?.role === 'tool') {
        measuredSingleStep = Math.max(measuredSingleStep, msgTok);
        tailTokens += msgTok;
      } else if (m?.role === 'assistant') {
        tailTokens += msgTok;
        measuredSingleStep = Math.max(measuredSingleStep, tailTokens);
        break;
      } else {
        measuredSingleStep = Math.max(measuredSingleStep, msgTok);
        break;
      }
    }
  }

  const prevWatermark = Number(epochState?.lastWatermark ?? -1);
  const prevEpochCount = Number(epochState?.epochCount ?? 0);

  if (policy === PHASE_WATERMARK_V25_DTOC_POLICY) {
    const candCtx = buildDtocCandidateContext(srcMessages, {
      currentStep,
      activeMutationTargets,
      keepRefs,
      compressRefs,
    });
    const derivedPhase = derivePhaseSignalsFromMessages(
      srcMessages,
      candCtx.toolCallsById,
      candCtx.lastMutationStepByPath,
    );
    const effectiveVerificationCount =
      verificationCount != null && verificationCount !== '' && Number.isFinite(Number(verificationCount))
        ? Math.max(0, Math.trunc(Number(verificationCount)))
        : derivedPhase.verificationCount;
    const effectiveUnverifiedSrc =
      unverifiedSrcMutations != null &&
      unverifiedSrcMutations !== '' &&
      Number.isFinite(Number(unverifiedSrcMutations))
        ? Math.max(0, Math.trunc(Number(unverifiedSrcMutations)))
        : derivedPhase.unverifiedSrcMutations;

    // (a) Phase gate: past initial research / first verification
    const phasePassed =
      effectiveVerificationCount >= 1 ||
      (candCtx.effectiveCurrentStep >= 6 && effectiveUnverifiedSrc === 0);

    // (b) Genuine single-step prompt pressure
    const pressureMinTokens = Math.max(minPromptTokens, DEFAULT_DTOC_PRESSURE_MIN_TOKENS);
    const pressureTriggered =
      tokensBefore >= pressureMinTokens || singleStepRatio >= DEFAULT_DTOC_PRESSURE_RATIO;

    let highestCrossedWatermark = -1;
    if (pressureTriggered) {
      for (const wm of sortedWatermarks) {
        if (singleStepRatio >= wm) highestCrossedWatermark = wm;
      }
      if (singleStepRatio >= DEFAULT_DTOC_PRESSURE_RATIO) {
        highestCrossedWatermark = Math.max(highestCrossedWatermark, DEFAULT_DTOC_PRESSURE_RATIO);
      } else if (highestCrossedWatermark < 0 && tokensBefore >= pressureMinTokens) {
        highestCrossedWatermark = Number(singleStepRatio.toFixed(4));
      }
    }

    // (c) Estimated net token savings >= minNetSavingsTokens
    let estimatedNetSavingsTokens = 0;
    let eligibleCount = 0;
    if (phasePassed && pressureTriggered) {
      const trialMessages = srcMessages.map((m, idx) => {
        if (m?.role !== 'tool') return m;
        const ev = evaluateToolMessageEligibility(m, {
          index: idx,
          toolCallsById: candCtx.toolCallsById,
          activeMutations: candCtx.activeMutations,
          explicitActiveMutations: candCtx.explicitActiveMutations,
          lastMutationStepByPath: candCtx.lastMutationStepByPath,
          effectiveCurrentStep: candCtx.effectiveCurrentStep,
          fallbackStep: candCtx.msgSteps[idx],
          compressibleTools,
          minAgeSteps,
          minChars,
          supersededMinAgeSteps,
          supersededMinChars,
          singleStepTriggered: false,
          singleStepBudget,
          keepSet: candCtx.keepSet,
          preferCompressSet: candCtx.preferCompressSet,
          dtocPolicy: policy,
          recentEditShieldSteps: effectiveShieldSteps,
          contractFiles,
          latestErrorIndex: candCtx.latestErrorIndex,
        });
        if (!ev.eligible) return m;
        eligibleCount += 1;
        const stubText = formatAciRefStub(
          {
            uri: `artifact://${sha256HexLocal(ev.rawText)}`,
            path: ev.rawFilePath || ev.targetPath,
            lineRange: extractLineRangeLabel(ev.args, ev.rawText),
            symbolOutline: [],
            originalTokens: ev.rawTokens,
            decision: 'DEFER',
          },
          { decision: 'DEFER' },
        );
        const nonTextBlocks = (m.content ?? []).filter((b) => b?.type !== 'text');
        return { ...m, content: [...nonTextBlocks, { type: 'text', text: stubText }] };
      });
      if (eligibleCount > 0) {
        const estAfter = measureRequestComposition({
          system: systemPrompt,
          tools,
          messages: trialMessages,
        }).totalTokens;
        estimatedNetSavingsTokens = Math.max(0, tokensBefore - estAfter);
      }
    }

    const netSavingsMet = eligibleCount > 0 && estimatedNetSavingsTokens >= effectiveMinNetSavings;
    const triggered = phasePassed && pressureTriggered && netSavingsMet;
    const reason = !phasePassed
      ? 'phase_gate_active'
      : !pressureTriggered
        ? 'below_pressure_watermark'
        : !netSavingsMet
          ? 'insufficient_net_savings'
          : PHASE_WATERMARK_V25_DTOC_POLICY;

    return {
      srcMessages,
      dtocPolicy: policy,
      dtocMinPromptTokens: minPromptTokens,
      minNetSavingsTokens: effectiveMinNetSavings,
      recentEditShieldSteps: effectiveShieldSteps,
      tokensBefore,
      singleStepRatio,
      cumulativeRatio,
      ratio: singleStepRatio,
      highestCrossedWatermark,
      measuredSingleStep,
      prevWatermark,
      prevEpochCount,
      watermarkTriggered: triggered && highestCrossedWatermark > prevWatermark,
      singleStepTriggered: false,
      emergencyTriggered: false,
      phasePassed,
      pressureTriggered,
      netSavingsMet,
      estimatedNetSavingsTokens,
      verificationCount: effectiveVerificationCount,
      unverifiedSrcMutations: effectiveUnverifiedSrc,
      currentStep: candCtx.effectiveCurrentStep,
      reason,
      triggered,
    };
  }

  let ratio = singleStepRatio;
  let highestCrossedWatermark = -1;
  let emergencyTriggered = false;

  if (policy === 'cumulative') {
    ratio = Math.max(singleStepRatio, cumulativeRatio);
    for (const wm of sortedWatermarks) {
      if (ratio >= wm) highestCrossedWatermark = wm;
    }
  } else {
    const promptWatermarkGate = Math.min(
      minPromptTokens,
      Math.floor(contextWindow * 0.45),
    );
    if (tokensBefore >= promptWatermarkGate) {
      for (const wm of sortedWatermarks) {
        if (singleStepRatio >= wm) highestCrossedWatermark = wm;
      }
    }
    const emergencyGate = Math.min(12000, Math.floor(contextWindow * 0.2));
    if (
      !epochState?.emergencyUsed &&
      hasCumulative &&
      maxTotalTokens > 0 &&
      tokensBefore >= emergencyGate
    ) {
      const remainingBudget = Math.max(0, maxTotalTokens - usedCumulative);
      if (remainingBudget <= 2.5 * tokensBefore) {
        emergencyTriggered = true;
      }
    }
  }

  const watermarkTriggered = highestCrossedWatermark > prevWatermark;
  const singleStepTriggered = measuredSingleStep > singleStepBudget;
  return {
    srcMessages,
    dtocPolicy: policy,
    dtocMinPromptTokens: minPromptTokens,
    minNetSavingsTokens: effectiveMinNetSavings,
    recentEditShieldSteps: effectiveShieldSteps,
    tokensBefore,
    singleStepRatio,
    cumulativeRatio,
    ratio,
    highestCrossedWatermark,
    measuredSingleStep,
    prevWatermark,
    prevEpochCount,
    watermarkTriggered,
    singleStepTriggered,
    emergencyTriggered,
    triggered: watermarkTriggered || singleStepTriggered || emergencyTriggered,
    reason: watermarkTriggered || singleStepTriggered || emergencyTriggered ? 'triggered' : 'between_epochs',
  };
}

/**
 * Pure read-only check indicating whether an epoch watermark, emergency remaining
 * budget, or single-step budget overflow would trigger DTOC compression.
 */
export function shouldTriggerAciEpoch(messages, options = {}) {
  const state = computeEpochTriggerState(messages, options);
  return {
    triggered: state.triggered,
    reason: state.reason,
    watermarkTriggered: state.watermarkTriggered,
    singleStepTriggered: state.singleStepTriggered,
    emergencyTriggered: state.emergencyTriggered,
    dtocPolicy: state.dtocPolicy,
    dtocMinPromptTokens: state.dtocMinPromptTokens,
    minNetSavingsTokens: state.minNetSavingsTokens,
    singleStepRatio: state.singleStepRatio,
    cumulativeRatio: state.cumulativeRatio,
    ratio: state.ratio,
    tokensBefore: state.tokensBefore,
    singleStepTokens: state.measuredSingleStep,
    watermark: state.highestCrossedWatermark,
    lastWatermark: state.prevWatermark,
    epochCount: state.prevEpochCount,
    ...(state.phasePassed !== undefined ? { phasePassed: state.phasePassed } : {}),
    ...(state.pressureTriggered !== undefined ? { pressureTriggered: state.pressureTriggered } : {}),
    ...(state.netSavingsMet !== undefined ? { netSavingsMet: state.netSavingsMet } : {}),
    ...(state.estimatedNetSavingsTokens !== undefined
      ? { estimatedNetSavingsTokens: state.estimatedNetSavingsTokens }
      : {}),
    ...(state.verificationCount !== undefined ? { verificationCount: state.verificationCount } : {}),
    ...(state.unverifiedSrcMutations !== undefined
      ? { unverifiedSrcMutations: state.unverifiedSrcMutations }
      : {}),
    ...(state.currentStep !== undefined ? { currentStep: state.currentStep } : {}),
  };
}

/**
 * Shared eligibility evaluator used by both `selectOffloadableAciCandidates` and
 * `compressMessagesEpoch` so Supervisor gating and DTOC execution never diverge.
 */
export function evaluateToolMessageEligibility(
  msg,
  {
    index = 0,
    toolCallsById,
    activeMutations,
    explicitActiveMutations = null,
    lastMutationStepByPath,
    effectiveCurrentStep = 0,
    fallbackStep = 0,
    compressibleTools = COMPRESSIBLE_TOOLS,
    minAgeSteps = 3,
    minChars = DEFAULT_DTOC_MIN_CHARS,
    supersededMinAgeSteps = 2,
    supersededMinChars = DEFAULT_DTOC_SUPERSEDED_MIN_CHARS,
    singleStepTriggered = false,
    singleStepBudget = DEFAULT_SINGLE_STEP_BUDGET,
    keepSet = new Set(),
    preferCompressSet = new Set(),
    dtocPolicy = DEFAULT_DTOC_POLICY,
    recentEditShieldSteps = DEFAULT_DTOC_RECENT_EDIT_SHIELD_STEPS,
    contractFiles = [],
    latestErrorIndex = -1,
  } = {},
) {
  if (!msg || msg.role !== 'tool') {
    return { eligible: false, skipReason: 'not_tool' };
  }
  const tc = msg.toolCallId ? toolCallsById?.get(msg.toolCallId) : null;
  const toolName = String(tc?.name || msg.toolName || msg.name || '').trim();
  const lowerTool = toolName.toLowerCase();
  const args = tc?.args ?? {};
  const targetPath = extractToolTargetPath(toolName, args);
  const rawFilePath = String(
    args?.path ?? args?.filePath ?? args?.file ?? args?.target_file ?? '',
  ).trim();

  const textBlocks = (msg.content ?? []).filter(
    (b) => b?.type === 'text' && typeof b.text === 'string',
  );
  const rawText = textBlocks.map((b) => b.text).join('\n');
  if (!rawText || isAciStubText(rawText)) {
    return { eligible: false, skipReason: 'empty_or_stub' };
  }

  const msgStep = tc?.step ?? fallbackStep;
  const age = effectiveCurrentStep - msgStep;
  const rawTokens = estimateTokens(rawText);
  const fallbackMsgId = `tool_msg_${index}`;
  const normRawPath = normalizeContextPath(rawFilePath);
  const normTargetPath = normalizeContextPath(targetPath);

  const isPhaseV25 = normalizeDtocPolicy(dtocPolicy) === PHASE_WATERMARK_V25_DTOC_POLICY;
  const isErr = isErrorToolMessage(msg, rawText) || (isPhaseV25 && latestErrorIndex >= 0 && index === latestErrorIndex);
  const isPinnedKeep =
    (msg.toolCallId && keepSet.has(msg.toolCallId)) ||
    keepSet.has(fallbackMsgId) ||
    (rawFilePath && keepSet.has(rawFilePath)) ||
    (normRawPath && keepSet.has(normRawPath)) ||
    keepSet.has(targetPath) ||
    (normTargetPath && keepSet.has(normTargetPath));

  const isContractShielded =
    isPhaseV25 &&
    ((rawFilePath && isStrictDtocContractPath(rawFilePath, contractFiles)) ||
      (targetPath && isStrictDtocContractPath(targetPath, contractFiles)));

  let isActiveMutation = false;
  let superseded = false;
  if (rawFilePath) {
    const mutStep = findLastMutationStep(rawFilePath, lastMutationStepByPath);
    const inExplicitTargets = explicitActiveMutations && pathMatchesAny(rawFilePath, explicitActiveMutations);
    const mutWithinShieldWindow = mutStep >= 0 && effectiveCurrentStep - mutStep <= recentEditShieldSteps;
    if (isPhaseV25 && (inExplicitTargets || mutWithinShieldWindow)) {
      isActiveMutation = true;
    } else if (lowerTool === 'read_file' && mutStep >= 0) {
      if (msgStep < mutStep) {
        superseded = true;
      } else {
        isActiveMutation = true;
      }
    } else if (pathMatchesAny(rawFilePath, activeMutations)) {
      isActiveMutation = true;
    }
  }

  const isRecentShielded = isPhaseV25 && age <= recentEditShieldSteps;
  const isCompressibleTool = compressibleTools.has(lowerTool);
  const isSingleStepOverflow = singleStepTriggered && rawTokens > singleStepBudget;
  const isPreferred =
    (msg.toolCallId && preferCompressSet.has(msg.toolCallId)) ||
    preferCompressSet.has(fallbackMsgId) ||
    (rawFilePath && preferCompressSet.has(rawFilePath)) ||
    (normRawPath && preferCompressSet.has(normRawPath)) ||
    preferCompressSet.has(targetPath) ||
    (normTargetPath && preferCompressSet.has(normTargetPath));

  const thresholdChars = superseded ? supersededMinChars : minChars;
  const baseAgeThreshold = superseded ? supersededMinAgeSteps : minAgeSteps;
  const thresholdAge = isPhaseV25
    ? Math.max(baseAgeThreshold, recentEditShieldSteps + 1)
    : baseAgeThreshold;
  const meetsSizeAndAge = rawText.length >= thresholdChars && age >= thresholdAge;
  const meetsPreferred = isPreferred && rawText.length >= thresholdChars && age >= (isPhaseV25 ? recentEditShieldSteps + 1 : 1);

  const eligible =
    isCompressibleTool &&
    !isErr &&
    !isActiveMutation &&
    !isContractShielded &&
    !isRecentShielded &&
    !isPinnedKeep &&
    (meetsSizeAndAge || isSingleStepOverflow || meetsPreferred);

  const reason = isErr
    ? 'error_preserved'
    : isActiveMutation
      ? 'active_mutation'
      : isContractShielded
        ? 'contract_preserved'
        : 'recent_or_pinned';

  return {
    eligible,
    reason,
    superseded,
    id: msg.toolCallId || fallbackMsgId,
    toolName,
    args,
    targetPath,
    rawFilePath,
    rawText,
    rawTokens,
    chars: rawText.length,
    msgStep,
    age,
  };
}

/**
 * Returns offloadable tool message candidates aligned identically with `compressMessagesEpoch`.
 */
export function selectOffloadableAciCandidates(
  messages = [],
  {
    compressibleTools = COMPRESSIBLE_TOOLS,
    minAgeSteps = 3,
    minChars = DEFAULT_DTOC_MIN_CHARS,
    supersededMinAgeSteps = 2,
    supersededMinChars = DEFAULT_DTOC_SUPERSEDED_MIN_CHARS,
    currentStep = undefined,
    singleStepTriggered = false,
    singleStepBudget = DEFAULT_SINGLE_STEP_BUDGET,
    keepRefs = [],
    compressRefs = [],
    activeMutationTargets = [],
    dtocPolicy = DEFAULT_DTOC_POLICY,
    recentEditShieldSteps = DEFAULT_DTOC_RECENT_EDIT_SHIELD_STEPS,
    contractFiles = [],
  } = {},
) {
  const srcMessages = Array.isArray(messages) ? messages : [];
  const candCtx = buildDtocCandidateContext(srcMessages, {
    currentStep,
    activeMutationTargets,
    keepRefs,
    compressRefs,
  });
  const candidates = [];

  for (let i = 0; i < srcMessages.length; i += 1) {
    const m = srcMessages[i];
    if (m?.role !== 'tool') continue;
    const ev = evaluateToolMessageEligibility(m, {
      index: i,
      toolCallsById: candCtx.toolCallsById,
      activeMutations: candCtx.activeMutations,
      explicitActiveMutations: candCtx.explicitActiveMutations,
      lastMutationStepByPath: candCtx.lastMutationStepByPath,
      effectiveCurrentStep: candCtx.effectiveCurrentStep,
      fallbackStep: candCtx.msgSteps[i],
      compressibleTools,
      minAgeSteps,
      minChars,
      supersededMinAgeSteps,
      supersededMinChars,
      singleStepTriggered,
      singleStepBudget,
      keepSet: candCtx.keepSet,
      preferCompressSet: candCtx.preferCompressSet,
      dtocPolicy,
      recentEditShieldSteps,
      contractFiles,
      latestErrorIndex: candCtx.latestErrorIndex,
    });
    if (!ev.eligible) continue;
    candidates.push({
      id: ev.id,
      refId: ev.id,
      path: ev.rawFilePath || ev.targetPath,
      toolName: ev.toolName,
      tokens: ev.rawTokens,
      chars: ev.chars,
      ageSteps: ev.age,
      superseded: ev.superseded,
      hasError: false,
      excerpt: ev.rawText.slice(0, 260),
    });
  }
  return candidates;
}

/**
 * Epoch-based DTOC Reversible Compression:
 * Triggers ONLY when crossing budget watermarks (60%, 82% of maxTotalTokens),
 * when a single-step input exceeds `singleStepBudget`, or under `phase_watermark_v25`
 * when phase, prompt pressure, and net savings (>= 1200 tokens) ALL hold.
 * Keeps prefix bytes 100% untouched between epochs so KV Prompt Cache stays warm.
 */
export function compressMessagesEpoch(
  messages,
  {
    aciStore = new ReversibleContextStore(),
    ledger = null,
    maxTotalTokens = 128000,
    contextWindow = 128000,
    cumulativeUsedTokens = null,
    watermarks = undefined,
    singleStepBudget = DEFAULT_SINGLE_STEP_BUDGET,
    dtocPolicy = DEFAULT_DTOC_POLICY,
    dtocMinPromptTokens = DEFAULT_DTOC_MIN_PROMPT_TOKENS,
    minNetSavingsTokens = DEFAULT_DTOC_MIN_NET_SAVINGS_TOKENS,
    recentEditShieldSteps = DEFAULT_DTOC_RECENT_EDIT_SHIELD_STEPS,
    epochState = { lastWatermark: -1, epochCount: 0 },
    minAgeSteps = 3,
    minChars = DEFAULT_DTOC_MIN_CHARS,
    supersededMinAgeSteps = 2,
    supersededMinChars = DEFAULT_DTOC_SUPERSEDED_MIN_CHARS,
    compressibleTools = COMPRESSIBLE_TOOLS,
    currentStep = undefined,
    singleStepTokens = undefined,
    verificationCount = undefined,
    unverifiedSrcMutations = undefined,
    keepRefs = [],
    compressRefs = [],
    activeMutationTargets = [],
    contractFiles = [],
    systemPrompt = '',
    tools = [],
  } = {},
) {
  const trigger = computeEpochTriggerState(messages, {
    maxTotalTokens,
    contextWindow,
    cumulativeUsedTokens,
    watermarks,
    singleStepBudget,
    dtocPolicy,
    dtocMinPromptTokens,
    minNetSavingsTokens,
    recentEditShieldSteps,
    epochState,
    singleStepTokens,
    currentStep,
    verificationCount,
    unverifiedSrcMutations,
    minAgeSteps,
    minChars,
    supersededMinAgeSteps,
    supersededMinChars,
    compressibleTools,
    keepRefs,
    compressRefs,
    activeMutationTargets,
    contractFiles,
    systemPrompt,
    tools,
  });
  const {
    srcMessages,
    tokensBefore,
    ratio,
    highestCrossedWatermark,
    measuredSingleStep,
    prevWatermark,
    prevEpochCount,
    watermarkTriggered,
    singleStepTriggered,
    emergencyTriggered,
  } = trigger;

  if (!trigger.triggered) {
    return {
      triggered: false,
      reason: trigger.reason || 'between_epochs',
      dtocPolicy: trigger.dtocPolicy,
      epoch: prevEpochCount,
      lastWatermark: prevWatermark,
      ratio,
      singleStepTokens: measuredSingleStep,
      tokensBefore,
      tokensAfter: tokensBefore,
      netSavingsTokens: 0,
      minNetSavingsTokens: trigger.minNetSavingsTokens,
      compressedCount: 0,
      compressedRefs: [],
      messages: srcMessages,
      pairClosedValid: pairClosed(srcMessages, 0, Math.max(0, srcMessages.length - 1)),
      epochState: {
        lastWatermark: prevWatermark,
        epochCount: prevEpochCount,
        emergencyUsed: Boolean(epochState?.emergencyUsed),
      },
    };
  }

  const candCtx = buildDtocCandidateContext(srcMessages, {
    currentStep,
    activeMutationTargets,
    keepRefs,
    compressRefs,
  });
  const nextEpoch = prevEpochCount + 1;

  const outMessages = srcMessages.map((m) => ({
    ...m,
    content: Array.isArray(m?.content) ? m.content.map((b) => ({ ...b })) : m?.content,
  }));

  const stagedCompressions = [];
  const keptItems = [];

  for (let i = 0; i < outMessages.length; i += 1) {
    const m = outMessages[i];
    if (m?.role !== 'tool') continue;

    const ev = evaluateToolMessageEligibility(m, {
      index: i,
      toolCallsById: candCtx.toolCallsById,
      activeMutations: candCtx.activeMutations,
      explicitActiveMutations: candCtx.explicitActiveMutations,
      lastMutationStepByPath: candCtx.lastMutationStepByPath,
      effectiveCurrentStep: candCtx.effectiveCurrentStep,
      fallbackStep: candCtx.msgSteps[i],
      compressibleTools,
      minAgeSteps,
      minChars,
      supersededMinAgeSteps,
      supersededMinChars,
      singleStepTriggered,
      singleStepBudget,
      keepSet: candCtx.keepSet,
      preferCompressSet: candCtx.preferCompressSet,
      dtocPolicy: trigger.dtocPolicy,
      recentEditShieldSteps: trigger.recentEditShieldSteps,
      contractFiles,
      latestErrorIndex: candCtx.latestErrorIndex,
    });

    if (ev.skipReason === 'empty_or_stub') continue;

    if (!ev.eligible) {
      if (ev.rawFilePath) {
        keptItems.push({
          refId: m.toolCallId ?? null,
          path: ev.rawFilePath,
          reason: ev.reason,
          tokens: ev.rawTokens,
          step: ev.msgStep,
        });
      }
      continue;
    }

    const extracted = extractSymbolsFromText(ev.rawFilePath || ev.targetPath, ev.rawText);
    const outlineWithLines = extracted.definitions.length
      ? extracted.definitions.slice(0, 12).map((d) => (d.line ? `${d.name}@L${d.line}` : d.name))
      : extracted.names;
    const putMeta = {
      toolName: ev.toolName,
      path: ev.rawFilePath || ev.targetPath,
      lineRange: extractLineRangeLabel(ev.args, ev.rawText),
      symbolOutline: outlineWithLines,
      originalTokens: ev.rawTokens,
      step: ev.msgStep,
      decision: 'DEFER',
    };
    const previewStub = formatAciRefStub(
      {
        uri: `artifact://${sha256HexLocal(ev.rawText)}`,
        ...putMeta,
      },
      putMeta,
    );
    const nonTextBlocks = (m.content ?? []).filter((b) => b?.type !== 'text');
    m.content = [...nonTextBlocks, { type: 'text', text: previewStub }];
    stagedCompressions.push({ msg: m, ev, putMeta, nonTextBlocks });
  }

  const tokensAfterPreview = measureRequestComposition({
    system: systemPrompt,
    tools,
    messages: outMessages,
  }).totalTokens;
  const netSavingsTokens = Math.max(0, tokensBefore - tokensAfterPreview);

  if (
    trigger.dtocPolicy === PHASE_WATERMARK_V25_DTOC_POLICY &&
    (stagedCompressions.length === 0 || netSavingsTokens < trigger.minNetSavingsTokens)
  ) {
    return {
      triggered: false,
      reason: 'insufficient_net_savings',
      dtocPolicy: trigger.dtocPolicy,
      epoch: prevEpochCount,
      lastWatermark: prevWatermark,
      ratio,
      singleStepTokens: measuredSingleStep,
      tokensBefore,
      tokensAfter: tokensBefore,
      netSavingsTokens,
      minNetSavingsTokens: trigger.minNetSavingsTokens,
      compressedCount: 0,
      compressedRefs: [],
      messages: srcMessages,
      pairClosedValid: pairClosed(srcMessages, 0, Math.max(0, srcMessages.length - 1)),
      epochState: {
        lastWatermark: prevWatermark,
        epochCount: prevEpochCount,
        emergencyUsed: Boolean(epochState?.emergencyUsed),
      },
    };
  }

  const compressedRefs = [];
  for (const item of stagedCompressions) {
    const ref = aciStore.put(item.ev.rawText, item.putMeta);
    item.msg.content = [...item.nonTextBlocks, { type: 'text', text: ref.stubText }];
    compressedRefs.push(ref);
    ledger?.recordCompressed({
      refId: ref.refId,
      uri: ref.uri,
      path: ref.path,
      originalTokens: ref.originalTokens,
      stubTokens: ref.stubTokens,
      step: item.ev.msgStep,
      epoch: nextEpoch,
    });
  }

  if (keptItems.length) {
    ledger?.recordKept(keptItems);
  }

  const tokensAfter = measureRequestComposition({
    system: systemPrompt,
    tools,
    messages: outMessages,
  }).totalTokens;

  const effectiveEpochCount = compressedRefs.length > 0 ? nextEpoch : prevEpochCount;
  const nextState = {
    lastWatermark: Math.max(prevWatermark, highestCrossedWatermark),
    epochCount: effectiveEpochCount,
    emergencyUsed: Boolean(epochState?.emergencyUsed || emergencyTriggered),
  };

  return {
    triggered: true,
    reason:
      trigger.dtocPolicy === PHASE_WATERMARK_V25_DTOC_POLICY
        ? PHASE_WATERMARK_V25_DTOC_POLICY
        : watermarkTriggered
          ? 'watermark_crossed'
          : singleStepTriggered
            ? 'single_step_budget'
            : 'emergency_budget',
    dtocPolicy: trigger.dtocPolicy,
    epoch: effectiveEpochCount,
    watermark: highestCrossedWatermark,
    lastWatermark: nextState.lastWatermark,
    ratio,
    singleStepTokens: measuredSingleStep,
    tokensBefore,
    tokensAfter,
    netSavingsTokens: Math.max(0, tokensBefore - tokensAfter),
    minNetSavingsTokens: trigger.minNetSavingsTokens,
    compressedCount: compressedRefs.length,
    compressedRefs,
    messages: outMessages,
    pairClosedValid: pairClosed(outMessages, 0, Math.max(0, outMessages.length - 1)),
    epochState: nextState,
  };
}

/**
 * Progressive Expansion (`outline` -> `hunk` -> `verbatim`) backed by `aciStore`.
 */
export function expandContext(
  aciStore,
  uriOrRefId,
  {
    level = 'outline',
    query = '',
    symbols = [],
    startLine = null,
    endLine = null,
    contextLines = 15,
    maxChars = 6000,
    step = 0,
    expectedSha256 = undefined,
    ledger = null,
  } = {},
) {
  const verified = typeof aciStore.restoreVerified === 'function'
    ? aciStore.restoreVerified(uriOrRefId, { expectedSha256 })
    : { content: aciStore.restore(uriOrRefId), sha256: null, verified: false, refId: null, uri: null, path: '' };
  const raw = verified.content;
  const ref = aciStore.getRef(uriOrRefId);
  const path = verified.path || ref?.path || 'unknown';
  const normalizedLevel =
    level === 'relevant_hunk' ? 'hunk' : level === 'verbatim' || level === 'hunk' ? level : 'outline';

  if (normalizedLevel === 'verbatim') {
    const out = {
      level: 'verbatim',
      refId: ref?.refId ?? null,
      uri: ref?.uri ?? (String(uriOrRefId).startsWith('artifact://') ? uriOrRefId : null),
      path,
      text: raw,
      tokens: estimateTokens(raw),
    };
    ledger?.recordExpanded({ ...out, step });
    return out;
  }

  const allLines = raw.split(/\r?\n/);

  if (normalizedLevel === 'outline') {
    const extracted = extractSymbolsFromText(path, raw);
    const imports = allLines
      .map((line, i) => ({ line, num: i + 1 }))
      .filter((x) => /^\s*(?:import|export\s+.*from|from\s+\S+\s+import|use\s+)/.test(x.line))
      .slice(0, 12)
      .map((x) => `L${x.num}: ${x.line.trim()}`);
    const symbolLines = extracted.definitions
      .slice(0, 40)
      .map((d) => `L${d.line}: [${d.kind}] ${d.name}`);

    const sections = [`[ACI-OUTLINE ${path} | ${allLines.length} lines | ~${estimateTokens(raw)} tok]`];
    if (imports.length) sections.push('Imports:\n' + imports.join('\n'));
    if (symbolLines.length) sections.push('Symbols:\n' + symbolLines.join('\n'));
    if (!imports.length && !symbolLines.length) {
      sections.push(allLines.slice(0, 20).map((l, idx) => `L${idx + 1}: ${l}`).join('\n'));
    }
    const text = sections.join('\n\n').slice(0, maxChars);
    const out = {
      level: 'outline',
      refId: ref?.refId ?? null,
      uri: ref?.uri ?? null,
      path,
      symbols: extracted.names,
      totalLines: allLines.length,
      text,
      tokens: estimateTokens(text),
    };
    ledger?.recordExpanded({ ...out, step });
    return out;
  }

  // 'hunk' mode
  const windows = [];
  const hasStartLine = startLine != null && startLine !== '' && Number.isFinite(Number(startLine));
  const hasEndLine = endLine != null && endLine !== '' && Number.isFinite(Number(endLine));
  if (hasStartLine || hasEndLine) {
    const from = Math.max(1, hasStartLine ? Number(startLine) : 1);
    const to = Math.min(
      allLines.length,
      hasEndLine ? Math.max(from, Number(endLine)) : from + contextLines * 2,
    );
    windows.push({ from, to });
  } else {
    const needles = [
      ...(symbols ?? []).map((s) => String(s || '').trim()).filter(Boolean),
      ...[...tokenizeIdentifiers(query)],
    ];
    const matchLines = [];
    if (needles.length > 0) {
      for (let i = 0; i < allLines.length; i += 1) {
        const lower = allLines[i].toLowerCase();
        if (needles.some((n) => lower.includes(n.toLowerCase()))) {
          matchLines.push(i + 1);
          if (matchLines.length >= 12) break;
        }
      }
    }
    for (const ln of matchLines) {
      const from = Math.max(1, ln - contextLines);
      const to = Math.min(allLines.length, ln + contextLines);
      if (windows.length && from <= windows.at(-1).to + 2) {
        windows.at(-1).to = Math.max(windows.at(-1).to, to);
      } else {
        windows.push({ from, to });
      }
    }
    if (windows.length === 0) {
      windows.push({ from: 1, to: Math.min(allLines.length, Math.max(20, contextLines * 2)) });
    }
  }

  const hunkBlocks = windows.map((w) => {
    const slice = [];
    for (let ln = w.from; ln <= w.to; ln += 1) {
      slice.push(`L${ln}: ${allLines[ln - 1] ?? ''}`);
    }
    return `@@ L${w.from}-${w.to} @@\n${slice.join('\n')}`;
  });
  const text = `[ACI-HUNK ${path}]\n${hunkBlocks.join('\n...\n')}`.slice(0, maxChars);
  const out = {
    level: 'hunk',
    refId: ref?.refId ?? null,
    uri: ref?.uri ?? null,
    path,
    windows,
    text,
    tokens: estimateTokens(text),
  };
  ledger?.recordExpanded({ ...out, step });
  return out;
}

const EXTRA_SECRET_PATTERNS = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /([?&](?:token|key|api_key|apikey|secret|password|auth)=)[^&\s'"`]+/gi,
  /(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)[^\s\r\n'"]+/gi,
];

export function sanitizeGuidelineText(raw) {
  let out = sanitize(redactSecrets(String(raw ?? '')));
  out = out.replace(EXTRA_SECRET_PATTERNS[0], '[REDACTED_JWT]');
  out = out.replace(EXTRA_SECRET_PATTERNS[1], '$1[REDACTED]');
  out = out.replace(EXTRA_SECRET_PATTERNS[2], '$1[REDACTED_TOKEN]');
  return out.replace(/\s+/g, ' ').trim().slice(0, 240);
}

export function getLearnedGuidelines(store) {
  if (!store || typeof store.getSetting !== 'function') return [];
  const raw = store.getSetting(ACON_SETTINGS_KEY, []);
  return Array.isArray(raw) ? raw : [];
}

/**
 * ACON Failure-Driven Context Learning:
 * Persists up to 12 compact, sanitized, secret-redacted natural-language
 * guidelines in `kv_settings` (`aci.learned_guidelines`) from verified diagnoses.
 */
export function learnFromFailure(store, diagnosis = {}) {
  const current = getLearnedGuidelines(store);
  if (!diagnosis || diagnosis.verified !== true) {
    return {
      updated: false,
      reason: 'unverified_diagnosis',
      guidelines: current,
    };
  }

  const rawText =
    diagnosis.guideline ||
    diagnosis.lesson ||
    [
      diagnosis.missingContext ? `Keep ${diagnosis.missingContext}` : '',
      diagnosis.rootCause ? `when diagnosing ${diagnosis.rootCause}` : '',
      diagnosis.resolution ? `(${diagnosis.resolution})` : '',
    ]
      .filter(Boolean)
      .join(' ');

  const text = sanitizeGuidelineText(rawText);
  if (!text) {
    return {
      updated: false,
      reason: 'empty_guideline',
      guidelines: current,
    };
  }

  const signature = sanitizeGuidelineText(
    diagnosis.signature || diagnosis.errorSignature || text.toLowerCase(),
  ).slice(0, 120);
  const category = sanitizeGuidelineText(diagnosis.category || 'context').slice(0, 40) || 'context';
  const now = Date.now();

  const next = current
    .filter((g) => g && typeof g === 'object' && typeof g.text === 'string')
    .map((g) => ({ ...g }));

  const existingIdx = next.findIndex(
    (g) => g.signature === signature || g.text.toLowerCase() === text.toLowerCase(),
  );
  if (existingIdx >= 0) {
    const existing = next[existingIdx];
    next.splice(existingIdx, 1);
    next.push({
      ...existing,
      text,
      category,
      signature,
      count: Number(existing.count ?? 1) + 1,
      updatedAt: now,
    });
  } else {
    next.push({
      id: `acon_${now}_${next.length + 1}`,
      text,
      category,
      signature,
      count: 1,
      updatedAt: now,
    });
  }

  const bounded = next.slice(-ACON_MAX_GUIDELINES);
  if (store && typeof store.setSetting === 'function') {
    store.setSetting(ACON_SETTINGS_KEY, bounded);
  }

  return {
    updated: true,
    guidelines: bounded,
    added: { text, category, signature },
  };
}

export class ACIEngine {
  constructor({
    store = null,
    aciStore = null,
    ledger = null,
    supervisor = null,
    maxTotalTokens = 128000,
    contextWindow = 128000,
    watermarks = undefined,
    singleStepBudget = DEFAULT_SINGLE_STEP_BUDGET,
    dtocPolicy = DEFAULT_DTOC_POLICY,
    dtocMinPromptTokens = DEFAULT_DTOC_MIN_PROMPT_TOKENS,
    minNetSavingsTokens = DEFAULT_DTOC_MIN_NET_SAVINGS_TOKENS,
    recentEditShieldSteps = DEFAULT_DTOC_RECENT_EDIT_SHIELD_STEPS,
    admissionMinChars = DEFAULT_ADMISSION_MIN_CHARS,
    maxSupervisorAdmissionCalls = DEFAULT_MAX_SUPERVISOR_ADMISSION_CALLS,
    weights = DEFAULT_ACI_WEIGHTS,
  } = {}) {
    this.store = store;
    this.aciStore = aciStore ?? new ReversibleContextStore(store);
    this.ledger = ledger;
    this.supervisor = supervisor;
    this.maxTotalTokens = maxTotalTokens;
    this.contextWindow = contextWindow;
    this.dtocPolicy = normalizeDtocPolicy(dtocPolicy);
    this.watermarks = resolveWatermarksForPolicy(this.dtocPolicy, watermarks);
    this.dtocMinPromptTokens = Math.max(
      1000,
      Number(dtocMinPromptTokens ?? DEFAULT_DTOC_MIN_PROMPT_TOKENS),
    );
    this.minNetSavingsTokens = Math.max(
      0,
      Number(minNetSavingsTokens ?? DEFAULT_DTOC_MIN_NET_SAVINGS_TOKENS),
    );
    this.recentEditShieldSteps = Math.max(
      0,
      Number(recentEditShieldSteps ?? DEFAULT_DTOC_RECENT_EDIT_SHIELD_STEPS),
    );
    this.admissionMinChars = Math.max(
      200,
      Number(admissionMinChars ?? DEFAULT_ADMISSION_MIN_CHARS),
    );
    this.maxSupervisorAdmissionCalls = Math.max(
      0,
      Number(maxSupervisorAdmissionCalls ?? DEFAULT_MAX_SUPERVISOR_ADMISSION_CALLS),
    );
    this.weights = { ...DEFAULT_ACI_WEIGHTS, ...weights };
    this.epochState = { lastWatermark: -1, epochCount: 0, emergencyUsed: false };
    this.admissionController = new PreInjectionAdmissionController({
      aciStore: this.aciStore,
      ledger: this.ledger,
      admissionMinChars: this.admissionMinChars,
      maxSupervisorAdmissionCalls: this.maxSupervisorAdmissionCalls,
    });
  }

  evaluateGate(options) {
    return evaluateRetrievalGate({ ledger: this.ledger, ...options });
  }

  refine(candidates, options = {}) {
    return refineCandidates(candidates, {
      weights: this.weights,
      ledger: this.ledger,
      ...options,
    });
  }

  async admitToolBatch(executedBatch, options = {}) {
    return this.admissionController.admitBatch(executedBatch, {
      supervisor: options.supervisor ?? this.supervisor,
      learnedGuidelines: options.learnedGuidelines ?? this.getGuidelines(),
      admissionMinChars: options.admissionMinChars ?? this.admissionMinChars,
      maxSupervisorAdmissionCalls:
        options.maxSupervisorAdmissionCalls ?? this.maxSupervisorAdmissionCalls,
      ...options,
    });
  }

  inspectEpoch(messages, options = {}) {
    return shouldTriggerAciEpoch(messages, {
      maxTotalTokens: this.maxTotalTokens,
      contextWindow: this.contextWindow,
      watermarks: this.watermarks,
      singleStepBudget: this.singleStepBudget,
      dtocPolicy: this.dtocPolicy,
      dtocMinPromptTokens: this.dtocMinPromptTokens,
      minNetSavingsTokens: this.minNetSavingsTokens,
      recentEditShieldSteps: this.recentEditShieldSteps,
      epochState: this.epochState,
      ...options,
    });
  }

  compress(messages, options = {}) {
    const result = compressMessagesEpoch(messages, {
      aciStore: this.aciStore,
      ledger: this.ledger,
      maxTotalTokens: this.maxTotalTokens,
      contextWindow: this.contextWindow,
      watermarks: this.watermarks,
      singleStepBudget: this.singleStepBudget,
      dtocPolicy: this.dtocPolicy,
      dtocMinPromptTokens: this.dtocMinPromptTokens,
      minNetSavingsTokens: this.minNetSavingsTokens,
      recentEditShieldSteps: this.recentEditShieldSteps,
      epochState: this.epochState,
      ...options,
    });
    this.epochState = result.epochState;
    return result;
  }

  expand(uriOrRefId, options = {}) {
    return expandContext(this.aciStore, uriOrRefId, {
      ledger: this.ledger,
      ...options,
    });
  }

  restore(uriOrRefId) {
    return this.aciStore.restore(uriOrRefId);
  }

  restoreVerified(uriOrRefId, options = {}) {
    const res = this.aciStore.restoreVerified(uriOrRefId, {
      expectedSha256: options.expectedSha256,
    });
    if (options.recordLedger !== false) {
      this.ledger?.recordRecovery?.({
        refId: res.refId,
        uri: res.uri,
        sha256: res.sha256,
        path: res.path,
        level: options.level || 'verbatim',
        verified: res.verified,
        tokensRestored: options.tokensRestored ?? estimateTokens(res.content),
        triggeredBy: options.triggeredBy || 'expand_context',
        step: options.step ?? 0,
      });
    }
    return res;
  }

  getGuidelines() {
    return getLearnedGuidelines(this.store);
  }

  learnFromFailure(diagnosis) {
    return learnFromFailure(this.store, diagnosis);
  }
}
