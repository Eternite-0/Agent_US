import { createHash } from 'node:crypto';
import { estimateTokens } from '../context.js';
import { redactSecrets, sanitize } from '../envelope.js';
import { extractRepositorySymbols } from '../repo-symbols.js';
import {
  formatAciRefStub,
  normalizeContextPath,
} from './aci-store.js';

export const ADMISSION_DECISIONS = Object.freeze({
  DIRECT: 'DIRECT',
  SUPPORTING: 'SUPPORTING',
  DEFER: 'DEFER',
  DUPLICATE: 'DUPLICATE',
  IRRELEVANT: 'IRRELEVANT',
});

export const DEFAULT_ADMISSION_MIN_CHARS = 1400;
export const DEFAULT_MAX_SUPERVISOR_ADMISSION_CALLS = 6;

const VALID_DECISIONS = new Set(Object.values(ADMISSION_DECISIONS));
const MUTATION_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch', 'delete_file']);
const ALWAYS_DIRECT_TOOLS = new Set([
  'compute_file_digest',
  'expand_context',
  'read_blob',
  'update_plan',
  'search_history',
]);

const ERROR_OUTPUT_RE =
  /(?:^exitCode:\s*[1-9]\d*\b|exit\s+code[:=\s]+[1-9]\d*\b|AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|ERR_ASSERTION|ENOENT|EACCES|ECONNREFUSED|Traceback \(most recent call last\)|\b(?:FAIL|FAILED|FATAL|PANIC)\b|✖\s|×\s|^not ok \d+|^\s*(?:Expected|Actual|Received)\b|^\s+at\s+\S+:\d+:\d+|^\s+File\s+".+",\s+line\s+\d+|\bTS\d{4,5}:|\berror\[E\d+\]|\bError:\s|^(?:FILE_NOT_FOUND|EISDIR|参数校验失败|安全策略拦截|文件不存在|读取失败|错误[:：]))/m;

const DECOY_CUE_RE =
  /legacy|deprecated|v0|v1-compat|archive|fixture|sample|mock-data|changelog|generated|storybook/i;

const DECOY_CONTENT_LINE_RE =
  /^\s*(?:\/\/|\/\*|\*|#|<!--)?\s*(?:@deprecated|.*\b(?:legacy|deprecated|v0|v1-compat|archive|fixture|sample|mock-data|changelog|generated|storybook)\b)/i;

const DOMAIN_RULES = Object.freeze({
  auth: {
    pathRe:
      /(?:^|\/|_|-)(?:auth|authn|login|logout|session|token|jwt|oauth|oidc|sso|credential|password|passwd|secret|apikey|api-key|signing|hmac|crypto|security)(?:$|\/|_|-|\.)/i,
    contentRe:
      /\b(?:authenticate|authorize|verifyToken|jwt|bearer|hmac|bcrypt|scrypt|argon2|oauth|sessionSecret|apiKey|passwordHash|timingSafeEqual|csrf|cookie)\b/i,
  },
  permission: {
    pathRe:
      /(?:^|\/|_|-)(?:permission|permissions|perm|policy|policies|rbac|acl|guard|sandbox|approval|capability|scope|role|roles|access)(?:$|\/|_|-|\.)/i,
    contentRe:
      /\b(?:permissionMode|allowTools|denyTools|hasPermission|checkPermission|requireRole|rbac|acl|isAllowed|canAccess|sandbox|confinement|policyDecision|forbidden)\b/i,
  },
  persistence: {
    pathRe:
      /(?:^|\/|_|-)(?:store|db|database|sqlite|sql|migrat|schema|persist|persistence|storage|repo|repository|ledger|checkpoint|snapshot|blob|cache|state|wal)(?:$|\/|_|-|\.)/i,
    contentRe:
      /\b(?:CREATE\s+TABLE|ALTER\s+TABLE|BEGIN\s+TRANSACTION|COMMIT|ROLLBACK|DatabaseSync|prepare\(|sqlite|putBlob|getBlob|persist|checkpoint|schemaVersion|migration)\b/i,
  },
  contract: {
    pathRe:
      /(?:^|\/)(?:agents\.md|spec\.md|constraints\.md|contract\.json|package\.json|tsconfig(?:\.[^/]+)?\.json|openapi\.[^/]+|.*contract.*|.*schema.*|.*interface.*|.*types?\.[^/]+|.*\.d\.ts|routes\/[^/]+|api\/[^/]+)$/i,
    contentRe:
      /\b(?:interface\s+[A-Z]\w*|export\s+type\s+[A-Z]\w*|z\.object\(|JSONSchema|Evidence\s+Manifest|CONTRACT|precedence|C[1-9]\d*\b)/,
  },
  hidden_acceptance: {
    pathRe:
      /(?:^|\/)(?:tests?|__tests__|acceptance|verify|verifier|spec)\/|\.(?:test|spec|acceptance)\.[cm]?[jt]sx?$/i,
    contentRe:
      /\b(?:assert\.|expect\(|describe\(|it\(|test\(|acceptanceCriteria|hidden_acceptance|invariant)\b/i,
  },
});

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'where',
  'what', 'which', 'will', 'have', 'been', 'true', 'false', 'null', 'undefined',
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'default',
  'async', 'await', 'class', 'new', 'try', 'catch', 'throw', 'else', 'if',
  'src', 'lib', 'app', 'dist', 'build', 'test', 'tests', 'spec', 'docs', 'file',
  'files', 'code', 'fix', 'add', 'check', 'update', 'edit', 'read', 'write',
  'mjs', 'cjs', 'jsx', 'tsx', 'json', 'yaml', 'yml', 'txt',
]);

function sha256Hex(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function pathsMatch(a, b) {
  const na = normalizeContextPath(a);
  const nb = normalizeContextPath(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}

function pathMatchesList(path, list = []) {
  if (!path || !Array.isArray(list) || list.length === 0) return false;
  return list.some((item) => pathsMatch(path, item));
}

function tokenizeIdentifiers(text) {
  const tokens = new Set();
  const matches = String(text ?? '').match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [];
  for (const m of matches) {
    if (STOPWORDS.has(m.toLowerCase())) continue;
    tokens.add(m);
  }
  return tokens;
}

function detectLanguageFromPath(filePath) {
  const clean = String(filePath || '').trim().toLowerCase();
  if (/\.(?:js|mjs|cjs|jsx)$/.test(clean)) return 'javascript';
  if (/\.(?:ts|tsx)$/.test(clean)) return 'typescript';
  if (/\.py$/.test(clean)) return 'python';
  if (/\.rs$/.test(clean)) return 'rust';
  if (/\.go$/.test(clean)) return 'go';
  return null;
}

function parseToolArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object' && !Array.isArray(rawArgs)) return rawArgs;
  try {
    const parsed = JSON.parse(String(rawArgs));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function extractPromptFileHints(promptText) {
  const text = String(promptText ?? '');
  const hints = [];
  const seen = new Set();
  const re =
    /(?:^|[\s`"'(\[])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rs|go|json|md|txt|sql|ya?ml))(?=$|[\s`"'),:\]])/g;
  for (const m of text.matchAll(re)) {
    const candidate = String(m[1] || '').trim();
    if (!candidate || candidate.startsWith('http')) continue;
    const norm = normalizeContextPath(candidate);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    hints.push(candidate);
  }
  return hints;
}

function unwrapToolEnvelope(rawOutput) {
  const raw = String(rawOutput ?? '');
  const m = raw.match(
    /^<untrusted\s+id="([^"]+)"\s+bytes="(\d+)">([\s\S]*)<\/untrusted\s+id="\1">$/,
  );
  if (!m) {
    return { wrapped: false, id: null, inner: raw };
  }
  return { wrapped: true, id: m[1], inner: m[3] };
}

function rewrapUntrusted(id, text) {
  const body = sanitize(String(text ?? ''));
  const bytes = Buffer.byteLength(body, 'utf8');
  return `<untrusted id="${id}" bytes="${bytes}">${body}</untrusted id="${id}">`;
}

function parseReadFileBody(innerText) {
  const raw = String(innerText ?? '');
  const m = raw.match(/^File:\s*([^\r\n]+?)\s*\(lines\s+(\d+)-(\d+)\s+of\s+(\d+)\)\r?\n([\s\S]*)$/);
  if (!m) {
    const lines = raw.split(/\r?\n/);
    return {
      hasHeader: false,
      headerPath: null,
      startLine: 1,
      endLine: lines.length,
      totalLines: lines.length,
      lines,
      code: raw,
    };
  }
  const startLine = Math.max(1, Number(m[2]));
  const endLine = Math.max(startLine, Number(m[3]));
  const totalLines = Math.max(endLine, Number(m[4]));
  const rawLines = m[5].split(/\r?\n/);
  const strippedLines = rawLines.map((line) => {
    const lm = line.match(/^\d+:\s?(.*)$/);
    return lm ? lm[1] : line;
  });
  return {
    hasHeader: true,
    headerPath: m[1].trim(),
    startLine,
    endLine,
    totalLines,
    lines: strippedLines,
    code: strippedLines.join('\n'),
  };
}

function extractStructure(filePath, codeText, startLineOffset = 1) {
  const raw = String(codeText ?? '');
  const lang = detectLanguageFromPath(filePath);
  const allLines = raw.split(/\r?\n/);
  const imports = [];
  for (let i = 0; i < allLines.length; i += 1) {
    const line = allLines[i];
    if (/^\s*(?:import\b|export\s+.*from\b|from\s+\S+\s+import\b|use\s+|const\s+.*=\s*require\()/.test(line)) {
      imports.push({ line: startLineOffset + i, text: line.trim().slice(0, 140) });
      if (imports.length >= 16) break;
    }
  }

  let definitions = [];
  let calls = [];
  if (lang) {
    try {
      const extracted = extractRepositorySymbols(filePath || 'unknown', lang, raw);
      definitions = (extracted.definitions ?? []).map((d) => {
        const name = d.owner ? `${d.owner}.${d.name}` : d.name;
        const line = startLineOffset + (Number(d.line || 1) - 1);
        return {
          name,
          shortName: d.name,
          kind: d.kind,
          line,
        };
      });
      calls = (extracted.calls ?? []).map((c) => ({
        name: c.name,
        specifier: c.specifier ?? null,
        line: startLineOffset + (Number(c.line || 1) - 1),
      }));
    } catch {
      // Fallback below
    }
  }

  const isJsonLike =
    String(filePath || '').toLowerCase().endsWith('.json') || /^\s*[\[{]/.test(raw);
  if (definitions.length === 0 && !isJsonLike) {
    for (let i = 0; i < allLines.length; i += 1) {
      const hm = allLines[i].match(/^#{1,4}\s+(.+)$/);
      if (hm?.[1]) {
        definitions.push({
          name: hm[1].trim().slice(0, 60),
          shortName: hm[1].trim().slice(0, 60),
          kind: 'heading',
          line: startLineOffset + i,
        });
      }
    }
  }
  if (definitions.length === 0) {
    for (let i = 0; i < allLines.length; i += 1) {
      const jm = allLines[i].match(/^\s{0,2}"([A-Za-z0-9_$-]{2,50})"\s*:/);
      if (jm?.[1]) {
        definitions.push({
          name: jm[1],
          shortName: jm[1],
          kind: 'json_key',
          line: startLineOffset + i,
        });
        if (definitions.length >= 24) break;
      }
    }
  }

  const symbolLineOutline = definitions
    .slice(0, 16)
    .map((d) => `${d.name}@L${d.line}`);
  const symbolNames = [...new Set(definitions.flatMap((d) => [d.name, d.shortName]).filter(Boolean))];

  return {
    definitions,
    calls,
    imports,
    symbolLineOutline,
    symbolNames,
  };
}

function extractMutationPaths(toolName, args) {
  const lower = String(toolName || '').toLowerCase();
  const out = [];
  if (lower === 'apply_patch') {
    const patchText = String(args?.patch ?? args?.patchText ?? args?.input ?? '');
    for (const m of patchText.matchAll(/^\*\*\*\s+(?:Add|Update|Delete|Move to:)\s*(?:File:\s*)?(.+)$/gm)) {
      const p = String(m[1] || '').trim();
      if (p) out.push(p);
    }
  } else {
    const p = String(args?.path ?? args?.filePath ?? args?.file ?? args?.target_file ?? '').trim();
    if (p) out.push(p);
  }
  return out;
}

function extractTargetPath(toolName, args, parsedRead) {
  const lower = String(toolName || '').toLowerCase();
  const explicit = String(
    args?.path ?? args?.filePath ?? args?.file ?? args?.target_file ?? parsedRead?.headerPath ?? '',
  ).trim();
  if (explicit) return explicit.replace(/\\/g, '/');
  if (lower === 'grep' && args?.pattern) return `grep:${String(args.pattern).slice(0, 60)}`;
  if (lower === 'grep' && args?.query) return `grep:${String(args.query).slice(0, 60)}`;
  if (lower === 'glob' && args?.pattern) return `glob:${String(args.pattern).slice(0, 60)}`;
  if (lower === 'bash') {
    const cmd = String(args?.command ?? args?.cmd ?? '').trim();
    return cmd ? `bash:${cmd.slice(0, 60)}` : 'bash';
  }
  return lower || 'tool';
}

function buildLineRangeLabel(args, parsedRead, innerText) {
  if (parsedRead?.hasHeader) {
    return `L${parsedRead.startLine}-${parsedRead.endLine}`;
  }
  const s = args?.startLine ?? args?.start_line;
  const e = args?.endLine ?? args?.end_line;
  if (s != null || e != null) {
    const from = Number.isFinite(Number(s)) ? Math.max(1, Number(s)) : 1;
    const to = e != null && Number.isFinite(Number(e)) ? Math.max(from, Number(e)) : 'EOF';
    return `L${from}-${to}`;
  }
  const lines = String(innerText ?? '').split(/\r?\n/).length;
  return `L1-${lines}`;
}

/**
 * Detects explicit legacy/archive/changelog/fixture/sample/mock-data decoy cues.
 */
export function isDecoyCue(path = '', content = '') {
  const normPath = String(path || '').replace(/\\/g, '/');
  const headLines = String(content ?? '').split(/\r?\n/).slice(0, 16);
  if (normPath.startsWith('grep:') || normPath.startsWith('glob:')) {
    const nonEmpty = headLines.map((l) => l.trim()).filter(Boolean);
    return (
      nonEmpty.length > 0 &&
      nonEmpty.every((line) => DECOY_CUE_RE.test(line) || DECOY_CONTENT_LINE_RE.test(line))
    );
  }
  if (normPath && DECOY_CUE_RE.test(normPath)) {
    return true;
  }
  for (const line of headLines) {
    if (DECOY_CONTENT_LINE_RE.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Classifies candidates into the 5 protected domains while distinguishing genuine
 * active source/contract paths from unreferenced legacy/archive/sample decoys.
 */
export function classifyCriticalDomains({
  path = '',
  content = '',
  promptFiles = [],
  errorFiles = [],
  mutatedFiles = [],
} = {}) {
  const normPath = normalizeContextPath(path);
  const rawContent = String(content ?? '');
  const matchedPrompt = pathMatchesList(normPath, promptFiles);
  const matchedError = pathMatchesList(normPath, errorFiles);
  const matchedMutated = pathMatchesList(normPath, mutatedFiles);
  const explicitlyTargeted = matchedPrompt || matchedError || matchedMutated;

  const rawDomains = [];
  for (const [domain, rule] of Object.entries(DOMAIN_RULES)) {
    if ((normPath && rule.pathRe.test(normPath)) || (rawContent && rule.contentRe.test(rawContent))) {
      rawDomains.push(domain);
    }
  }

  const decoy = isDecoyCue(normPath, rawContent);
  const suppressedAsDecoy = decoy && !explicitlyTargeted;
  const domains = suppressedAsDecoy ? [] : rawDomains;
  const isCritical = domains.length > 0 || explicitlyTargeted;

  return {
    domains,
    rawDomains,
    isDecoy: decoy,
    suppressedAsDecoy,
    isCritical,
    matchedPrompt,
    matchedError,
    matchedMutated,
  };
}

function buildFocusedHunks({
  lines,
  startLineOffset = 1,
  needles = [],
  definitions = [],
  contextLines = 8,
  maxChars = 2400,
}) {
  const cleanNeedles = [...new Set((needles ?? []).map((n) => String(n || '').trim()).filter((n) => n.length >= 2))];
  const matchIndices = [];

  for (const def of definitions) {
    if (cleanNeedles.some((n) => def.name.toLowerCase().includes(n.toLowerCase()))) {
      const idx = def.line - startLineOffset;
      if (idx >= 0 && idx < lines.length) matchIndices.push(idx);
    }
  }

  if (cleanNeedles.length > 0) {
    for (let i = 0; i < lines.length; i += 1) {
      const lower = lines[i].toLowerCase();
      if (cleanNeedles.some((n) => lower.includes(n.toLowerCase()))) {
        matchIndices.push(i);
        if (matchIndices.length >= 16) break;
      }
    }
  }

  const windows = [];
  const uniqueIdx = [...new Set(matchIndices)].sort((a, b) => a - b);
  for (const idx of uniqueIdx) {
    const from = Math.max(0, idx - contextLines);
    const to = Math.min(lines.length - 1, idx + contextLines);
    if (windows.length && from <= windows.at(-1).to + 2) {
      windows.at(-1).to = Math.max(windows.at(-1).to, to);
    } else {
      windows.push({ from, to });
    }
  }

  if (windows.length === 0) {
    windows.push({ from: 0, to: Math.min(lines.length - 1, Math.max(12, contextLines * 2)) });
  }

  const parts = [];
  let used = 0;
  for (const w of windows) {
    if (used >= maxChars) break;
    const chunk = [];
    for (let i = w.from; i <= w.to; i += 1) {
      const ln = startLineOffset + i;
      const lineStr = `L${ln}: ${lines[i] ?? ''}`;
      if (used + lineStr.length + 1 > maxChars) break;
      chunk.push(lineStr);
      used += lineStr.length + 1;
    }
    if (chunk.length) {
      parts.push(`@@ L${startLineOffset + w.from}-${startLineOffset + w.to} @@\n${chunk.join('\n')}`);
    }
  }
  return parts.join('\n...\n');
}

function renderProgressivePayload({
  decision,
  ref,
  rawOutput,
  envelope,
  parsedRead,
  structure,
  focusSymbols = [],
  priorStep = null,
}) {
  if (decision === ADMISSION_DECISIONS.DIRECT) {
    return { text: rawOutput, decision };
  }

  const originalLen = rawOutput.length;
  const wrapIfNeeded = (headerLine, bodyText) => {
    if (!bodyText) return headerLine;
    if (envelope.wrapped && envelope.id) {
      return `${headerLine}\n${rewrapUntrusted(envelope.id, bodyText)}`;
    }
    return `${headerLine}\n${bodyText}`;
  };

  if (decision === ADMISSION_DECISIONS.DUPLICATE) {
    const standard = formatAciRefStub(ref, {
      decision: ADMISSION_DECISIONS.DUPLICATE,
      priorStep,
    });
    if (standard.length < originalLen) return { text: standard, decision };
    const compact = formatAciRefStub(ref, {
      decision: ADMISSION_DECISIONS.DUPLICATE,
      priorStep,
      compact: true,
    });
    if (compact.length < originalLen) return { text: compact, decision };
    return { text: rawOutput, decision: ADMISSION_DECISIONS.DIRECT };
  }

  if (decision === ADMISSION_DECISIONS.IRRELEVANT) {
    const standard = formatAciRefStub(ref, {
      decision: ADMISSION_DECISIONS.IRRELEVANT,
    });
    if (standard.length < originalLen) return { text: standard, decision };
    const compact = formatAciRefStub(ref, {
      decision: ADMISSION_DECISIONS.IRRELEVANT,
      compact: true,
    });
    if (compact.length < originalLen) return { text: compact, decision };
    return { text: rawOutput, decision: ADMISSION_DECISIONS.DIRECT };
  }

  const lines = parsedRead?.lines ?? String(envelope.inner ?? '').split(/\r?\n/);
  const startLineOffset = parsedRead?.startLine ?? 1;

  if (decision === ADMISSION_DECISIONS.DEFER) {
    const header = formatAciRefStub(ref, { decision: ADMISSION_DECISIONS.DEFER });
    const importSection = structure.imports.length
      ? `Imports:\n${structure.imports.slice(0, 10).map((im) => `L${im.line}: ${im.text}`).join('\n')}`
      : '';
    const symbolMap = structure.definitions.length
      ? `Symbols:\n${structure.definitions.slice(0, 24).map((d) => `L${d.line}: [${d.kind}] ${d.name}`).join('\n')}`
      : `Preview:\n${lines.slice(0, 8).map((l, idx) => `L${startLineOffset + idx}: ${l}`).join('\n')}`;
    const restoreHint = `Restore slice: expand_context({ ref: "${ref.uri}", startLine, endLine })`;
    const body = [importSection, symbolMap, restoreHint].filter(Boolean).join('\n\n');
    const candidate = wrapIfNeeded(header, body);
    if (candidate.length < originalLen) return { text: candidate, decision };

    // Tighter DEFER body if raw output was borderline in size
    const tightBudget = Math.max(80, originalLen - header.length - 80);
    const tightBody = body.slice(0, tightBudget);
    const tightCandidate = wrapIfNeeded(header, tightBody);
    if (tightCandidate.length < originalLen) return { text: tightCandidate, decision };

    if (header.length < originalLen) return { text: header, decision };
    const compact = formatAciRefStub(ref, { decision: ADMISSION_DECISIONS.DEFER, compact: true });
    if (compact.length < originalLen) return { text: compact, decision };
    return { text: rawOutput, decision: ADMISSION_DECISIONS.DIRECT };
  }

  // SUPPORTING
  const header = formatAciRefStub(ref, { decision: ADMISSION_DECISIONS.SUPPORTING });
  const maxBodyBudget = Math.max(
    240,
    Math.min(2000, Math.floor(originalLen * 0.55), originalLen - header.length - 120),
  );
  const restoreFooter = `Expand omitted lines: expand_context({ ref: "${ref.uri}", startLine, endLine })`;
  const outlineLines = structure.definitions
    .slice(0, 20)
    .map((d) => `L${d.line}: [${d.kind}] ${d.name}`);
  const outlineBlock = outlineLines.length ? `Outline:\n${outlineLines.join('\n')}` : '';
  const hunkBudget = Math.max(
    160,
    maxBodyBudget - outlineBlock.length - restoreFooter.length - 80,
  );
  const hunks = buildFocusedHunks({
    lines,
    startLineOffset,
    needles: focusSymbols,
    definitions: structure.definitions,
    contextLines: 6,
    maxChars: hunkBudget,
  });
  const body = [outlineBlock, hunks ? `Focused Hunks:\n${hunks}` : '', restoreFooter]
    .filter(Boolean)
    .join('\n\n');
  const fullRendered = wrapIfNeeded(header, body);
  if (fullRendered.length < originalLen) {
    return { text: fullRendered, decision };
  }

  // Fallback to tighter SUPPORTING or DEFER stub if strictly shorter is needed
  const compactHunks = buildFocusedHunks({
    lines,
    startLineOffset,
    needles: focusSymbols,
    definitions: structure.definitions,
    contextLines: 3,
    maxChars: Math.max(
      120,
      Math.floor((originalLen - header.length - restoreFooter.length - 80) * 0.7),
    ),
  });
  const compactBody = [compactHunks, restoreFooter].filter(Boolean).join('\n\n');
  const compactRendered = wrapIfNeeded(header, compactBody);
  if (compactRendered.length < originalLen) {
    return { text: compactRendered, decision };
  }
  const compactHunkOnly = wrapIfNeeded(header, compactHunks);
  if (compactHunkOnly.length < originalLen) {
    return { text: compactHunkOnly, decision };
  }
  if (header.length < originalLen) {
    return { text: header, decision };
  }
  const compactStub = formatAciRefStub(ref, {
    decision: ADMISSION_DECISIONS.SUPPORTING,
    compact: true,
  });
  if (compactStub.length < originalLen) {
    return { text: compactStub, decision };
  }
  return { text: rawOutput, decision: ADMISSION_DECISIONS.DIRECT };
}

/**
 * PreInjectionAdmissionController governs tool outputs BEFORE pushing them into
 * the main agent conversation, keeping prompt prefixes compact and protecting
 * all critical domain files from false filtering.
 */
export class PreInjectionAdmissionController {
  constructor({
    aciStore,
    ledger = null,
    admissionMinChars = DEFAULT_ADMISSION_MIN_CHARS,
    maxSupervisorAdmissionCalls = DEFAULT_MAX_SUPERVISOR_ADMISSION_CALLS,
  } = {}) {
    this.aciStore = aciStore;
    this.ledger = ledger;
    this.admissionMinChars = Math.max(200, Number(admissionMinChars ?? DEFAULT_ADMISSION_MIN_CHARS));
    this.maxSupervisorAdmissionCalls = Math.max(
      0,
      Number(maxSupervisorAdmissionCalls ?? DEFAULT_MAX_SUPERVISOR_ADMISSION_CALLS),
    );
    this.activeHashesByPath = new Map(); // normPath -> { sha256, step, uri, refId, lineRange }
    this.activeUriByPathStep = new Map(); // `${normPath}@${step}` -> uri
    this.activeSymbols = new Set();
    this.activeImports = new Set();
    this.supervisorAdmissionCalls = 0;
  }

  seedActiveContext({ query = '', errorFiles = [], errorSymbols = [], mutatedFiles = [] } = {}) {
    for (const sym of errorSymbols ?? []) {
      const clean = String(sym || '').trim();
      if (clean) this.activeSymbols.add(clean);
    }
    for (const tok of tokenizeIdentifiers(query)) {
      this.activeSymbols.add(tok);
    }
    for (const mp of mutatedFiles ?? []) {
      const norm = normalizeContextPath(mp);
      if (norm) this.invalidatePath(norm);
    }
    for (const ef of errorFiles ?? []) {
      const norm = normalizeContextPath(ef);
      if (norm) this.activeImports.add(norm);
    }
  }

  invalidatePath(rawPath) {
    const norm = normalizeContextPath(rawPath);
    if (!norm) return;
    for (const key of this.activeHashesByPath.keys()) {
      if (pathsMatch(key, norm)) {
        this.activeHashesByPath.delete(key);
      }
    }
    this.aciStore?.invalidatePath?.(norm);
  }

  #recordSymbolsFromStructure(targetPath, structure) {
    for (const d of structure.definitions ?? []) {
      if (d.shortName) this.activeSymbols.add(d.shortName);
      if (d.name) this.activeSymbols.add(d.name);
    }
    for (const c of structure.calls ?? []) {
      if (c.name) this.activeSymbols.add(c.name);
      if (c.specifier) this.activeImports.add(c.specifier);
    }
    for (const im of structure.imports ?? []) {
      const m = im.text.match(/from\s+['"]([^'"]+)['"]/);
      if (m?.[1]) this.activeImports.add(m[1]);
    }
    if (targetPath) {
      const base = targetPath.split('/').pop()?.replace(/\.[^.]+$/, '');
      if (base && base.length >= 3) this.activeImports.add(base);
    }
  }

  async admitBatch(
    executedBatch = [],
    {
      query = '',
      step = 0,
      promptFiles = null,
      errorFiles = [],
      errorSymbols = [],
      mutatedFiles = [],
      errorSummary = '',
      contractHints = [],
      learnedGuidelines = [],
      supervisor = null,
      supervisorEnabled = true,
      supervisorConfigOverride = null,
      signal = null,
      admissionMinChars = null,
      maxSupervisorAdmissionCalls = null,
    } = {},
  ) {
    const items = Array.isArray(executedBatch) ? executedBatch : [];
    const minChars =
      admissionMinChars != null && Number.isFinite(Number(admissionMinChars))
        ? Math.max(200, Number(admissionMinChars))
        : this.admissionMinChars;
    const maxSupCalls =
      maxSupervisorAdmissionCalls != null && Number.isFinite(Number(maxSupervisorAdmissionCalls))
        ? Math.max(0, Number(maxSupervisorAdmissionCalls))
        : this.maxSupervisorAdmissionCalls;

    const effectivePromptFiles = [
      ...new Set([
        ...(Array.isArray(promptFiles) ? promptFiles : []),
        ...extractPromptFileHints(query),
      ]),
    ];
    const queryTokens = tokenizeIdentifiers(query);
    const errorTokenSet = new Set(
      (errorSymbols ?? []).map((s) => String(s || '').trim()).filter(Boolean),
    );

    this.seedActiveContext({ query, errorFiles, errorSymbols, mutatedFiles });

    // First invalidate any paths mutated in this batch so re-reads in same/later batches aren't stale DUPLICATE
    for (const item of items) {
      const toolName = String(item?.tc?.name || '').toLowerCase();
      if (MUTATION_TOOLS.has(toolName) && !item?.isError) {
        const args = item.parsedArgs ?? parseToolArgs(item.tc?.arguments);
        for (const p of extractMutationPaths(toolName, args)) {
          this.invalidatePath(p);
        }
      }
    }

    const prepared = [];
    const ambiguousQueue = [];

    for (let idx = 0; idx < items.length; idx += 1) {
      const item = items[idx];
      const tc = item?.tc ?? {};
      const toolName = String(tc.name || 'tool').trim();
      const lowerTool = toolName.toLowerCase();
      const args = item?.parsedArgs ?? parseToolArgs(tc.arguments);
      const rawOutput = String(item?.output ?? '');
      const envelope = unwrapToolEnvelope(rawOutput);
      const innerText = envelope.inner;
      const parsedRead = lowerTool === 'read_file' ? parseReadFileBody(innerText) : null;
      const targetPath = extractTargetPath(lowerTool, args, parsedRead);
      const normPath = normalizeContextPath(targetPath);
      const lineRange = buildLineRangeLabel(args, parsedRead, innerText);
      const contentSha256 = sha256Hex(innerText);
      const originalTokens = estimateTokens(rawOutput);

      const isErr = Boolean(item?.isError) || ERROR_OUTPUT_RE.test(innerText);
      const isMutation = MUTATION_TOOLS.has(lowerTool);
      const isAlwaysDirectTool = ALWAYS_DIRECT_TOOLS.has(lowerTool);
      const isNarrowSlice =
        lowerTool === 'read_file' &&
        (args?.startLine != null || args?.endLine != null) &&
        (() => {
          const from = Number(args?.startLine ?? 1);
          const to =
            args?.endLine != null
              ? Number(args.endLine)
              : parsedRead?.endLine ?? from + 399;
          return Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from + 1 <= 120;
        })();

      const structure = extractStructure(
        targetPath,
        parsedRead?.code ?? innerText,
        parsedRead?.startLine ?? 1,
      );
      const domainInfo = classifyCriticalDomains({
        path: targetPath,
        content: parsedRead?.code ?? innerText,
        promptFiles: effectivePromptFiles,
        errorFiles,
        mutatedFiles,
      });

      const promptTarget = domainInfo.matchedPrompt;
      const errorTarget = domainInfo.matchedError;
      const mutatedTarget = domainInfo.matchedMutated;
      const isProtectedCritical =
        promptTarget ||
        errorTarget ||
        mutatedTarget ||
        (!domainInfo.isDecoy && domainInfo.domains.length > 0);

      // Compute symbol & call-chain overlaps
      const candSymbolsLower = new Set(structure.symbolNames.map((s) => s.toLowerCase()));
      const candTokensLower = new Set(
        [...tokenizeIdentifiers(parsedRead?.code ?? innerText)].map((s) => s.toLowerCase()),
      );

      const baseNameLower = (normPath.split('/').pop() || '').replace(/\.[^.]+$/, '').toLowerCase();
      let querySymbolHits = 0;
      const matchedQueryTokens = [];
      for (const qt of queryTokens) {
        const ql = qt.toLowerCase();
        if (
          candSymbolsLower.has(ql) ||
          candTokensLower.has(ql) ||
          (ql.length >= 4 && baseNameLower === ql)
        ) {
          querySymbolHits += 1;
          matchedQueryTokens.push(qt);
        }
      }
      const querySymbolOverlap =
        queryTokens.size > 0 ? Math.min(1, querySymbolHits / Math.min(queryTokens.size, 3)) : 0;

      let errorSymbolHits = 0;
      for (const es of errorTokenSet) {
        const el = es.toLowerCase();
        if (candSymbolsLower.has(el) || candTokensLower.has(el)) {
          errorSymbolHits += 1;
        }
      }

      let callChainHits = 0;
      const matchedCallTokens = [];
      for (const sym of structure.symbolNames) {
        if (this.activeSymbols.has(sym)) {
          callChainHits += 1;
          matchedCallTokens.push(sym);
        }
      }
      for (const call of structure.calls) {
        if (this.activeSymbols.has(call.name)) {
          callChainHits += 1;
          matchedCallTokens.push(call.name);
        }
      }
      for (const im of structure.imports) {
        const m = im.text.match(/from\s+['"]([^'"]+)['"]/);
        const spec = m?.[1] || '';
        const specBase = spec.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
        if (
          (spec && this.activeImports.has(spec)) ||
          (specBase && this.activeImports.has(specBase)) ||
          (normPath && [...this.activeImports].some((ai) => normPath.includes(ai)))
        ) {
          callChainHits += 1;
        }
      }
      const callChainOverlap = Math.min(1, callChainHits / 2);

      const errorSignal = errorTarget ? 1 : errorSymbolHits > 0 ? 0.65 : 0;
      const promptSignal = promptTarget ? 1 : querySymbolOverlap;
      const mutatedSignal = mutatedTarget ? 1 : 0;
      const criticalSignal = !domainInfo.isDecoy && domainInfo.domains.length > 0 ? 1 : 0;
      const decoyPenalty = domainInfo.isDecoy && !promptTarget && !errorTarget && !mutatedTarget ? 0.2 : 0;

      const rawScore =
        errorSignal * 0.30 +
        promptSignal * 0.25 +
        mutatedSignal * 0.20 +
        criticalSignal * 0.15 +
        callChainOverlap * 0.10 -
        decoyPenalty;
      const score = Number(Math.max(0, Math.min(1, rawScore)).toFixed(4));

      const focusSymbols = [
        ...new Set([
          ...matchedQueryTokens,
          ...matchedCallTokens,
          ...errorTokenSet,
        ]),
      ].slice(0, 12);

      const id = String(tc.id || `cand_${step}_${idx}`);
      const ctxRecord = {
        idx,
        id,
        item,
        toolName,
        lowerTool,
        args,
        rawOutput,
        envelope,
        innerText,
        parsedRead,
        targetPath,
        normPath,
        lineRange,
        contentSha256,
        originalTokens,
        structure,
        domainInfo,
        isProtectedCritical,
        promptTarget,
        errorTarget,
        mutatedTarget,
        querySymbolHits,
        errorSymbolHits,
        callChainHits,
        score,
        focusSymbols,
        decision: null,
        reason: '',
        priorStep: null,
      };

      // Deterministic Pre-Screen & Fast-Paths
      if (isErr) {
        ctxRecord.decision = ADMISSION_DECISIONS.DIRECT;
        ctxRecord.reason = 'error_output';
      } else if (isMutation) {
        ctxRecord.decision = ADMISSION_DECISIONS.DIRECT;
        ctxRecord.reason = 'mutation_output';
      } else if (isAlwaysDirectTool) {
        ctxRecord.decision = ADMISSION_DECISIONS.DIRECT;
        ctxRecord.reason = 'always_direct_tool';
      } else if (isNarrowSlice) {
        ctxRecord.decision = ADMISSION_DECISIONS.DIRECT;
        ctxRecord.reason = 'narrow_line_slice';
      } else if (innerText.length <= minChars) {
        ctxRecord.decision = ADMISSION_DECISIONS.DIRECT;
        ctxRecord.reason = 'small_payload_fast_path';
      } else {
        // Check DUPLICATE against activeHashesByPath or aciStore
        const activeMem = normPath ? this.activeHashesByPath.get(normPath) : null;
        const storeMatch =
          !activeMem && normPath
            ? this.aciStore?.findByPathAndHash?.(targetPath, contentSha256)
            : null;
        const dupMatch =
          activeMem && activeMem.sha256 === contentSha256
            ? activeMem
            : storeMatch && storeMatch.sha256 === contentSha256
              ? storeMatch
              : null;

        if (dupMatch) {
          ctxRecord.decision = ADMISSION_DECISIONS.DUPLICATE;
          ctxRecord.priorStep = dupMatch.step ?? 0;
          ctxRecord.reason = `duplicate_unchanged_step_${ctxRecord.priorStep}`;
        } else if (
          (promptTarget && !domainInfo.isDecoy && innerText.length <= 2600) ||
          ((errorTarget || mutatedTarget) && innerText.length <= 6000) ||
          (score > 0.72 && innerText.length <= 2600 && !domainInfo.isDecoy)
        ) {
          ctxRecord.decision = ADMISSION_DECISIONS.DIRECT;
          ctxRecord.reason = 'high_signal_direct';
        } else if (
          score <= 0.14 &&
          domainInfo.domains.length === 0 &&
          !domainInfo.suppressedAsDecoy &&
          callChainHits === 0 &&
          querySymbolHits === 0 &&
          errorSymbolHits === 0 &&
          !promptTarget &&
          !errorTarget &&
          !mutatedTarget
        ) {
          ctxRecord.decision = ADMISSION_DECISIONS.IRRELEVANT;
          ctxRecord.reason = 'zero_signal_noise';
        } else {
          const decoyConflict =
            domainInfo.isDecoy && (domainInfo.rawDomains.length > 0 || querySymbolHits > 0);
          const ambiguousScore = score >= 0.15 && score <= 0.72;
          const largeMultiSection = innerText.length >= 2600;
          if (ambiguousScore || decoyConflict || largeMultiSection) {
            ambiguousQueue.push(ctxRecord);
          } else if (isProtectedCritical || callChainHits > 0 || score >= 0.35) {
            ctxRecord.decision = ADMISSION_DECISIONS.SUPPORTING;
            ctxRecord.reason = 'deterministic_supporting';
          } else {
            ctxRecord.decision = ADMISSION_DECISIONS.DEFER;
            ctxRecord.reason = 'deterministic_defer';
          }
        }
      }

      prepared.push(ctxRecord);
    }

    // Selective Batched Supervisor Call (at most once per tool batch)
    let supervisorRes = null;
    if (
      supervisorEnabled &&
      supervisor &&
      typeof supervisor.admitCandidates === 'function' &&
      ambiguousQueue.length > 0 &&
      this.supervisorAdmissionCalls < maxSupCalls
    ) {
      const resolved = supervisor.resolveModel?.(supervisorConfigOverride);
      if (resolved?.active) {
        const supCandidates = ambiguousQueue.map((c) => ({
          id: c.id,
          path: c.targetPath,
          toolName: c.toolName,
          chars: c.innerText.length,
          tokens: c.originalTokens,
          score: c.score,
          criticalDomains: c.domainInfo.domains,
          rawDomains: c.domainInfo.rawDomains,
          isDecoy: c.domainInfo.isDecoy,
          promptTarget: c.promptTarget,
          errorTarget: c.errorTarget,
          mutatedTarget: c.mutatedTarget,
          symbols: c.structure.symbolLineOutline.slice(0, 10),
          excerpt: (c.parsedRead?.code ?? c.innerText).slice(0, 320),
        }));

        supervisorRes = await supervisor
          .admitCandidates({
            query,
            candidates: supCandidates,
            activeContextSummary: `activeFiles=${this.activeHashesByPath.size}, activeSymbols=${[...this.activeSymbols].slice(0, 12).join(',')}`,
            errorSummary,
            contractHints,
            learnedGuidelines,
            signal,
            configOverride: supervisorConfigOverride,
          })
          .catch((err) => ({
            ok: false,
            bypassed: false,
            usedLlm: false,
            fallback: 'deterministic',
            model: resolved.effectiveModel ?? null,
            decisions: [],
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            durationMs: 0,
            error: String(err?.message || err),
          }));

        if (supervisorRes && !supervisorRes.bypassed) {
          this.supervisorAdmissionCalls += 1;
          this.ledger?.recordSupervisorCall?.({
            stage: 'admission',
            model: supervisorRes.model ?? resolved.effectiveModel ?? null,
            candidateCount: supCandidates.length,
            decisions: supervisorRes.decisions ?? [],
            inputTokens: supervisorRes.inputTokens ?? 0,
            outputTokens: supervisorRes.outputTokens ?? 0,
            totalTokens: supervisorRes.totalTokens ?? 0,
            durationMs: supervisorRes.durationMs ?? 0,
            ok: supervisorRes.ok,
            fallback: supervisorRes.fallback ?? null,
            step,
          });
        }
      }
    }

    const supDecisionMap = new Map();
    if (supervisorRes?.ok && Array.isArray(supervisorRes.decisions)) {
      for (const d of supervisorRes.decisions) {
        if (!d?.id || !VALID_DECISIONS.has(d.decision)) continue;
        supDecisionMap.set(d.id, d);
      }
    }

    // Resolve ambiguous candidates with Supervisor validation + Critical Protection Guardrail
    for (const c of ambiguousQueue) {
      const supPick = supDecisionMap.get(c.id);
      if (supPick) {
        let finalDecision = supPick.decision;
        let reason = supPick.reason || 'supervisor_admission';
        if (Array.isArray(supPick.focusSymbols) && supPick.focusSymbols.length > 0) {
          c.focusSymbols = [...new Set([...supPick.focusSymbols, ...c.focusSymbols])].slice(0, 16);
        }
        // Critical Protection Guardrail: prompt-cited, error-trace, active-mutation, and
        // non-decoy critical-domain files can NEVER be downgraded below SUPPORTING
        if (
          c.isProtectedCritical &&
          (finalDecision === ADMISSION_DECISIONS.IRRELEVANT ||
            finalDecision === ADMISSION_DECISIONS.DEFER ||
            finalDecision === ADMISSION_DECISIONS.DUPLICATE)
        ) {
          finalDecision = ADMISSION_DECISIONS.SUPPORTING;
          reason = 'critical_protection_guardrail';
        }
        c.decision = finalDecision;
        c.reason = reason;
      } else {
        // Deterministic fallback
        if (c.domainInfo.isDecoy && !c.promptTarget && !c.errorTarget && !c.mutatedTarget) {
          c.decision = c.score >= 0.25 ? ADMISSION_DECISIONS.DEFER : ADMISSION_DECISIONS.IRRELEVANT;
          c.reason = 'decoy_suppressed_deterministic';
        } else if (c.isProtectedCritical || c.callChainHits > 0 || c.score >= 0.35) {
          c.decision = ADMISSION_DECISIONS.SUPPORTING;
          c.reason = 'deterministic_supporting_fallback';
        } else {
          c.decision = ADMISSION_DECISIONS.DEFER;
          c.reason = 'deterministic_defer_fallback';
        }
      }
    }

    // Store & progressively render each item
    const admittedItems = [];
    const decisions = [];
    let batchOriginalTokens = 0;
    let batchInjectedTokens = 0;

    for (const c of prepared) {
      let ref = null;
      let renderedText = c.rawOutput;
      let finalDecision = c.decision;

      if (finalDecision === ADMISSION_DECISIONS.DIRECT) {
        const directMeta =
          c.normPath && !c.isMutation && !c.lowerTool.startsWith('bash')
            ? this.aciStore?.registerDirectHash?.(c.innerText, {
                toolName: c.toolName,
                path: c.targetPath,
                lineRange: c.lineRange,
                symbolOutline: c.structure.symbolLineOutline,
                originalTokens: c.originalTokens,
                step,
              })
            : null;
        if (c.normPath && directMeta && !c.args?.startLine && !c.args?.endLine) {
          this.activeHashesByPath.set(c.normPath, {
            sha256: c.contentSha256,
            step,
            uri: directMeta.uri,
            refId: null,
            lineRange: c.lineRange,
          });
          this.activeUriByPathStep.set(`${c.normPath}@${step}`, directMeta.uri);
        }
        this.#recordSymbolsFromStructure(c.targetPath, c.structure);
      } else {
        ref = this.aciStore.put(c.innerText, {
          toolName: c.toolName,
          path: c.targetPath,
          lineRange: c.lineRange,
          symbolOutline: c.structure.symbolLineOutline,
          originalTokens: c.originalTokens,
          step,
          decision: finalDecision,
          priorStep: c.priorStep,
        });
        if (c.normPath) {
          this.activeUriByPathStep.set(`${c.normPath}@${step}`, ref.uri);
          if (finalDecision === ADMISSION_DECISIONS.SUPPORTING && !c.args?.startLine && !c.args?.endLine) {
            this.activeHashesByPath.set(c.normPath, {
              sha256: c.contentSha256,
              step,
              uri: ref.uri,
              refId: ref.refId,
              lineRange: c.lineRange,
            });
            this.#recordSymbolsFromStructure(c.targetPath, c.structure);
          }
        }
        const rendered = renderProgressivePayload({
          decision: finalDecision,
          ref,
          rawOutput: c.rawOutput,
          envelope: c.envelope,
          parsedRead: c.parsedRead,
          structure: c.structure,
          focusSymbols: c.focusSymbols,
          priorStep: c.priorStep,
        });
        renderedText = rendered.text;
        finalDecision = rendered.decision;
      }

      const injectedTokens =
        finalDecision === ADMISSION_DECISIONS.DIRECT
          ? c.originalTokens
          : estimateTokens(renderedText);
      const tokensSaved = Math.max(0, c.originalTokens - injectedTokens);
      batchOriginalTokens += c.originalTokens;
      batchInjectedTokens += injectedTokens;

      this.ledger?.recordDiscovered?.({
        refId: ref?.refId ?? null,
        path: c.targetPath,
        score: c.score,
        source: 'admission',
        step,
        symbols: c.structure.symbolNames.slice(0, 16),
      });
      if (finalDecision === ADMISSION_DECISIONS.DIRECT || finalDecision === ADMISSION_DECISIONS.SUPPORTING) {
        this.ledger?.recordKept?.({
          refId: ref?.refId ?? null,
          path: c.targetPath,
          reason: c.reason,
          tokens: injectedTokens,
          step,
        });
      }
      this.ledger?.recordAdmission?.({
        refId: ref?.refId ?? null,
        uri: ref?.uri ?? (c.normPath ? `artifact://${c.contentSha256}` : null),
        sha256: ref?.sha256 ?? c.contentSha256,
        path: c.targetPath,
        toolName: c.toolName,
        decision: finalDecision,
        criticalDomains: c.domainInfo.domains,
        score: c.score,
        originalTokens: c.originalTokens,
        injectedTokens,
        tokensSaved,
        step,
        reason: c.reason,
      });

      const decisionRecord = {
        id: c.id,
        path: c.targetPath,
        toolName: c.toolName,
        decision: finalDecision,
        criticalDomains: c.domainInfo.domains,
        isDecoy: c.domainInfo.isDecoy,
        score: c.score,
        refId: ref?.refId ?? null,
        uri: ref?.uri ?? `artifact://${c.contentSha256}`,
        sha256: ref?.sha256 ?? c.contentSha256,
        originalTokens: c.originalTokens,
        injectedTokens,
        tokensSaved,
        reason: c.reason,
      };
      decisions.push(decisionRecord);
      admittedItems.push({
        ...c.item,
        admittedOutput: renderedText,
        admission: decisionRecord,
      });
    }

    return {
      admittedItems,
      decisions,
      supervisorRes,
      stats: {
        originalTokens: batchOriginalTokens,
        injectedTokens: batchInjectedTokens,
        tokensSaved: Math.max(0, batchOriginalTokens - batchInjectedTokens),
      },
    };
  }
}

/**
 * Convenience function running pre-injection admission on a batch of tool results.
 */
export async function admitToolBatch(executedBatch, opts = {}) {
  const controller =
    opts.controller ??
    new PreInjectionAdmissionController({
      aciStore: opts.aciStore,
      ledger: opts.ledger ?? null,
      admissionMinChars: opts.admissionMinChars,
      maxSupervisorAdmissionCalls: opts.maxSupervisorAdmissionCalls,
    });
  return controller.admitBatch(executedBatch, opts);
}
