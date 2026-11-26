import { createHash } from 'node:crypto';
import { estimateTokens } from '../context.js';
import { redactSecrets, sanitize } from '../envelope.js';
import {
  ReversibleContextStore,
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
export const DEFAULT_WORKING_SET_READ_MAX_CHARS = 42000;
export const DEFAULT_PROBE_ADMISSION_MIN_CHARS = 2400;
export const DEFAULT_MAX_SUPERVISOR_ADMISSION_CALLS = 6;
export const DEFAULT_MIN_SUPERVISOR_BATCH_CHARS = 16000;
export const DEFAULT_OVERSIZED_EXEC_MIN_CHARS = 6000;
export const DEFAULT_OVERSIZED_EXEC_MAX_RENDERED_CHARS = 3200;
export const DEFAULT_OVERSIZED_SEARCH_MIN_CHARS = 4500;
export const DEFAULT_OVERSIZED_SEARCH_MAX_RENDERED_CHARS = 2800;

const VALID_DECISIONS = new Set(Object.values(ADMISSION_DECISIONS));
const MUTATION_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch', 'delete_file']);
const EXEC_ERROR_TOOLS = new Set(['bash', 'start_process']);
const READ_ONLY_DEDUP_TOOLS = new Set(['read_file', 'grep', 'glob']);
const NOISY_PROBE_TOOLS = new Set(['grep', 'glob', 'bash', 'start_process']);
const ALWAYS_DIRECT_TOOLS = new Set(['expand_context', 'read_blob']);

const GENERIC_EXEC_ERROR_RE =
  /(?:^exitCode:\s*[1-9]\d*\b|\bexit\s+code[:=\s]+[1-9]\d*\b|\[(?:NON_ZERO_EXIT|TOOL_ERROR)\]|^(?:FILE_NOT_FOUND|EISDIR|参数校验失败|安全策略拦截|文件不存在|读取失败|错误[:：]))/im;

const GENERIC_SALIENT_FAILURE_RE =
  /(?:\b\w*(?:error|exception)\b|\b(?:fail(?:ed|ure)?|fatal|panic|traceback|assert(?:ion)?)\b|^exitCode:\s*[1-9]\d*\b)/i;

const STRUCTURED_JSON_STATUS_RE = /\{[\s\S]*"ok"\s*:\s*(?:true|false)\b/;
const STRUCTURED_JSON_FAILURE_RE = /"ok"\s*:\s*false\b/;

const DECOY_PATH_SEGMENT_RE =
  /(?:^|\/)(?:legacy|archive|v0|v1[-_]compat|backup|old[-_]version|mock[-_]data|storybook)(?:\/|$)/i;

const DECOY_FILENAME_RE = /(?:^|\/)[^/]*[_-]decoy\.[^/]+$/i;

const DECOY_BANNER_LINE_RE =
  /^\s*(?:\/\/|\/\*+|\*|#|<!--|"""|''')?\s*DO NOT EDIT\s*[-—:]\s*ARCHIVED DECOY\b/i;

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
      /\b(?:CREATE\s+TABLE|ALTER\s+TABLE|BEGIN\s+TRANSACTION|COMMIT|ROLLBACK|sqlite|persist|checkpoint|schemaVersion|migration)\b/i,
  },
  contract: {
    pathRe:
      /(?:^|\/)(?:agents\.md|spec\.md|constraints\.md|contract\.[^/]+|openapi\.[^/]+|.*contract.*|.*schema.*|.*interface.*|.*types?\.[^/]+|routes\/[^/]+|api\/[^/]+)$/i,
    contentRe:
      /\b(?:interface\s+[A-Z]\w*|JSONSchema|Evidence\s+Manifest|CONTRACT|precedence|C[1-9]\d*\b)/,
  },
  hidden_acceptance: {
    pathRe:
      /(?:^|\/)(?:tests?|__tests__|acceptance|verify|verifier|spec)\/|[._-](?:test|spec|acceptance)\.[^/]+$/i,
    contentRe:
      /\b(?:assert|expect|acceptanceCriteria|hidden_acceptance|invariant)\b/i,
  },
});

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'where',
  'what', 'which', 'will', 'have', 'been', 'true', 'false', 'null', 'undefined',
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'default',
  'async', 'await', 'class', 'new', 'try', 'catch', 'throw', 'else', 'if',
  'src', 'lib', 'app', 'dist', 'build', 'test', 'tests', 'spec', 'docs', 'file',
  'files', 'code', 'fix', 'add', 'check', 'update', 'edit', 'read', 'write',
  'json', 'yaml', 'yml', 'txt',
]);

export function parseShellExitCode(text) {
  const raw = String(text ?? '');
  const m =
    raw.match(/(?:^|\n)exitCode:\s*(-?\d+)\b/) ??
    raw.match(/\bexit\s+code[:=\s]+(-?\d+)\b/i);
  if (!m) return null;
  const code = Number(m[1]);
  return Number.isInteger(code) ? code : null;
}

function normalizeLineTemplate(line) {
  return String(line ?? '')
    .trim()
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '<n>')
    .slice(0, 120);
}

/**
 * Pure language-agnostic structural & statistical signal analyzer for any tool output:
 * byte/token length, repeated-line ratio, Shannon char entropy, and shell exitCode.
 */
export function computeTextSignalStats(text) {
  const raw = String(text ?? '');
  const chars = raw.length;
  const bytes = Buffer.byteLength(raw, 'utf8');
  const tokens = estimateTokens(raw);
  const lines = raw ? raw.split(/\r?\n/) : [];
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  const templateCounts = new Map();
  let duplicateLines = 0;
  for (const line of nonEmpty) {
    const tpl = normalizeLineTemplate(line);
    const prev = templateCounts.get(tpl) ?? 0;
    if (prev > 0) duplicateLines += 1;
    templateCounts.set(tpl, prev + 1);
  }
  const repeatedLineRatio =
    nonEmpty.length >= 2 ? Number((duplicateLines / nonEmpty.length).toFixed(4)) : 0;

  let charEntropy = 0;
  const sampleLen = Math.min(chars, 16384);
  if (sampleLen > 0) {
    const freq = new Map();
    for (let i = 0; i < sampleLen; i += 1) {
      const ch = raw.charCodeAt(i);
      freq.set(ch, (freq.get(ch) ?? 0) + 1);
    }
    let h = 0;
    for (const count of freq.values()) {
      const p = count / sampleLen;
      h -= p * Math.log2(p);
    }
    charEntropy = Number(h.toFixed(4));
  }

  return {
    chars,
    bytes,
    tokens,
    lineCount: lines.length,
    nonEmptyLineCount: nonEmpty.length,
    repeatedLineRatio,
    charEntropy,
    exitCode: parseShellExitCode(raw),
  };
}

function sha256Hex(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function stableArgsStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableArgsStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableArgsStringify(value[k])}`)
    .join(',')}}`;
}

function clipSummaryLine(line, maxLen = 200) {
  const clean = sanitize(String(line ?? ''));
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(8, maxLen - 3))}...`;
}

function wrapAdmittedPayload(headerLine, bodyText, envelope) {
  if (!bodyText) return headerLine;
  if (envelope?.wrapped && envelope?.id) {
    return `${headerLine}\n${rewrapUntrusted(envelope.id, bodyText)}`;
  }
  return `${headerLine}\n${bodyText}`;
}

function fitWrappedSectionBudget(headerLine, buildBody, envelope, maxChars) {
  const wrapperMargin = envelope?.wrapped && envelope?.id
    ? `<untrusted id="${envelope.id}" bytes="999999"></untrusted id="${envelope.id}">`.length + 2
    : 0;
  const maxBodyChars = Math.max(120, maxChars - headerLine.length - wrapperMargin - 4);
  let body = buildBody(maxBodyChars);
  let rendered = wrapAdmittedPayload(headerLine, body, envelope);
  if (rendered.length <= maxChars) {
    return rendered;
  }
  const over = rendered.length - maxChars;
  body = buildBody(Math.max(80, maxBodyChars - over - 16));
  rendered = wrapAdmittedPayload(headerLine, body, envelope);
  if (rendered.length <= maxChars) {
    return rendered;
  }
  // Final hard trim on body lines if needed
  const lines = body.split('\n');
  while (lines.length > 1 && wrapAdmittedPayload(headerLine, lines.join('\n'), envelope).length > maxChars) {
    lines.pop();
  }
  rendered = wrapAdmittedPayload(headerLine, lines.join('\n'), envelope);
  if (rendered.length <= maxChars) {
    return rendered;
  }
  const remaining = Math.max(0, maxChars - headerLine.length - wrapperMargin - 4);
  return wrapAdmittedPayload(headerLine, body.slice(0, remaining), envelope).slice(0, maxChars);
}

/**
 * Renders a bounded high-fidelity summary (<= 3200 chars) for oversized bash /
 * start_process / run_diagnostics outputs while preserving head, failure/traceback
 * context, tail, and lossless line-range restore instructions.
 */
function renderOversizedExecLogSummary({
  ref,
  innerText,
  envelope,
  maxChars = DEFAULT_OVERSIZED_EXEC_MAX_RENDERED_CHARS,
}) {
  const headerLine = `${formatAciRefStub(ref, { decision: ADMISSION_DECISIONS.SUPPORTING })} [expand_context 可按行无损展开]`;
  const rawLines = String(innerText ?? '').split(/\r?\n/);
  const totalLines = rawLines.length;

  const headEnd = Math.min(20, totalLines);
  const headLines = [];
  for (let i = 0; i < headEnd; i += 1) {
    headLines.push(`${i + 1}: ${clipSummaryLine(rawLines[i], 180)}`);
  }

  // Extract rare / non-repetitive salient failure windows using generic statistical frequency + cues
  const templateCounts = new Map();
  for (let i = 0; i < totalLines; i += 1) {
    const trimmed = rawLines[i].trim();
    if (!trimmed) continue;
    const tpl = normalizeLineTemplate(trimmed);
    templateCounts.set(tpl, (templateCounts.get(tpl) ?? 0) + 1);
  }
  const matchWindows = [];
  for (let i = 0; i < totalLines; i += 1) {
    const line = rawLines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    const freq = templateCounts.get(normalizeLineTemplate(trimmed)) ?? 0;
    if (freq > 4) continue;
    if (!GENERIC_SALIENT_FAILURE_RE.test(line)) continue;
    const from = Math.max(0, i - 2);
    const to = Math.min(totalLines - 1, i + 8);
    if (matchWindows.length && from <= matchWindows.at(-1).to + 2) {
      matchWindows.at(-1).to = Math.max(matchWindows.at(-1).to, to);
    } else {
      matchWindows.push({ from, to });
    }
    if (matchWindows.length >= 12) break;
  }

  const tailStart = Math.max(headEnd, totalLines - 30);
  const tailLines = [];
  for (let i = tailStart; i < totalLines; i += 1) {
    tailLines.push(`${i + 1}: ${clipSummaryLine(rawLines[i], 180)}`);
  }

  const footer = `Restore lines: expand_context({ ref: "${ref.uri}", startLine, endLine })`;

  const buildBody = (budget) => {
    const reserveFooter = footer.length + 4;
    const avail = Math.max(80, budget - reserveFooter);

    const headBudget = Math.max(80, Math.floor(avail * 0.25));
    const failBudget = matchWindows.length > 0 ? Math.max(120, Math.floor(avail * 0.42)) : 0;
    const tailBudget = Math.max(100, avail - headBudget - failBudget);

    const takeLinesFront = (linesArr, maxB) => {
      const kept = [];
      let used = 0;
      for (const l of linesArr) {
        if (used + l.length + 1 > maxB) break;
        kept.push(l);
        used += l.length + 1;
      }
      return kept;
    };

    const takeLinesTail = (linesArr, maxB) => {
      const kept = [];
      let used = 0;
      for (let i = linesArr.length - 1; i >= 0; i -= 1) {
        const l = linesArr[i];
        if (used + l.length + 1 > maxB) break;
        kept.unshift(l);
        used += l.length + 1;
      }
      return kept;
    };

    const headKept = takeLinesFront(headLines, headBudget);
    const headSec = headKept.length ? `Head (L1-${headKept.length}):\n${headKept.join('\n')}` : '';

    let failSec = '';
    if (matchWindows.length > 0 && failBudget > 40) {
      const blocks = [];
      let used = 0;
      for (const w of matchWindows) {
        const chunk = [];
        for (let idx = w.from; idx <= w.to; idx += 1) {
          const formatted = `${idx + 1}: ${clipSummaryLine(rawLines[idx], 180)}`;
          if (used + formatted.length + 24 > failBudget) break;
          chunk.push(formatted);
          used += formatted.length + 1;
        }
        if (chunk.length > 0) {
          blocks.push(`@@ L${w.from + 1}-${w.to + 1} @@\n${chunk.join('\n')}`);
          used += 24;
        }
        if (used >= failBudget) break;
      }
      if (blocks.length > 0) {
        failSec = `Failures/Tracebacks:\n${blocks.join('\n...\n')}`;
      }
    }

    const remainingForTail = Math.max(
      tailBudget,
      avail - (headSec ? headSec.length + 2 : 0) - (failSec ? failSec.length + 2 : 0),
    );
    const tailKept = takeLinesTail(tailLines, remainingForTail);
    const tailSec = tailKept.length
      ? `Tail (L${totalLines - tailKept.length + 1}-${totalLines}):\n${tailKept.join('\n')}`
      : '';

    return [headSec, failSec, tailSec, footer].filter(Boolean).join('\n\n');
  };

  const text = fitWrappedSectionBudget(headerLine, buildBody, envelope, maxChars);
  return { text, decision: ADMISSION_DECISIONS.SUPPORTING };
}

/**
 * Renders a file/directory-clustered summary (<= 2800 chars) for oversized grep
 * and glob outputs while preserving artifact:// restore references.
 */
function renderOversizedSearchClusteredSummary({
  ref,
  lowerTool,
  innerText,
  envelope,
  maxChars = DEFAULT_OVERSIZED_SEARCH_MAX_RENDERED_CHARS,
}) {
  const headerLine = formatAciRefStub(ref, { decision: ADMISSION_DECISIONS.SUPPORTING });
  const rawLines = String(innerText ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  const footer = `Restore full results: expand_context({ ref: "${ref.uri}", startLine, endLine })`;

  let overviewTitle = '';
  const countLines = [];
  const sampleLines = [];

  if (lowerTool === 'grep') {
    const byFile = new Map();
    const unmatched = [];
    for (const line of rawLines) {
      const m = line.match(/^((?:[A-Za-z]:)?[^:\r\n]+):(\d+):(.*)$/);
      if (m) {
        const file = m[1].trim();
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file).push({ lineNo: m[2], text: m[3].trim() });
      } else {
        unmatched.push(line);
      }
    }
    if (byFile.size > 0) {
      const sorted = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
      const totalHits = sorted.reduce((s, [, list]) => s + list.length, 0);
      overviewTitle = `Clustered Grep Summary (${sorted.length} files, ${totalHits} hits):`;
      for (const [file, list] of sorted.slice(0, 24)) {
        countLines.push(`- ${clipSummaryLine(file, 120)} (${list.length} hits)`);
      }
      if (sorted.length > 24) {
        countLines.push(`- ... +${sorted.length - 24} more files`);
      }
      for (const [file, list] of sorted.slice(0, 10)) {
        for (const h of list.slice(0, 2)) {
          sampleLines.push(`${clipSummaryLine(file, 90)}:${h.lineNo}: ${clipSummaryLine(h.text, 140)}`);
        }
      }
    } else {
      overviewTitle = `Clustered Grep Summary (${unmatched.length} lines):`;
      for (const l of unmatched.slice(0, 18)) {
        sampleLines.push(clipSummaryLine(l, 160));
      }
    }
  } else {
    // glob
    const contentLines = rawLines.filter((l, idx) => !(idx === 0 && /^找到\s+\d+\s+个匹配文件[:：]?$/.test(l)));
    const byDir = new Map();
    for (const p of contentLines) {
      const clean = p.replace(/\\/g, '/').trim();
      const parts = clean.split('/').filter(Boolean);
      const dir = parts.length <= 1 ? '.' : parts.slice(0, Math.min(2, parts.length - 1)).join('/');
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(clean);
    }
    const sorted = [...byDir.entries()].sort((a, b) => b[1].length - a[1].length);
    overviewTitle = `Clustered Glob Summary (${sorted.length} dirs, ${contentLines.length} files):`;
    for (const [dir, list] of sorted.slice(0, 24)) {
      countLines.push(`- ${clipSummaryLine(dir, 120)} (${list.length} files)`);
    }
    if (sorted.length > 24) {
      countLines.push(`- ... +${sorted.length - 24} more dirs`);
    }
    for (const [, list] of sorted.slice(0, 10)) {
      for (const f of list.slice(0, 2)) {
        sampleLines.push(clipSummaryLine(f, 150));
      }
    }
  }

  const buildBody = (budget) => {
    const avail = Math.max(80, budget - footer.length - overviewTitle.length - 8);
    const countsBudget = Math.max(60, Math.floor(avail * 0.48));
    const keptCounts = [];
    let usedCounts = 0;
    for (const l of countLines) {
      if (usedCounts + l.length + 1 > countsBudget) break;
      keptCounts.push(l);
      usedCounts += l.length + 1;
    }
    const samplesBudget = Math.max(60, avail - usedCounts - 24);
    const keptSamples = [];
    let usedSamples = 0;
    for (const l of sampleLines) {
      if (usedSamples + l.length + 1 > samplesBudget) break;
      keptSamples.push(l);
      usedSamples += l.length + 1;
    }
    const countsSec = keptCounts.length ? `Per-File Counts:\n${keptCounts.join('\n')}` : '';
    const samplesSec = keptSamples.length ? `Top Matches:\n${keptSamples.join('\n')}` : '';
    return [overviewTitle, countsSec, samplesSec, footer].filter(Boolean).join('\n\n');
  };

  const text = fitWrappedSectionBudget(headerLine, buildBody, envelope, maxChars);
  return { text, decision: ADMISSION_DECISIONS.SUPPORTING };
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
    /(?:^|[\s`"'(\[])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s`"'),:\]])/g;
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

const GENERIC_DECL_PATTERNS = [
  { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+|public\s+|private\s+|protected\s+|abstract\s+|final\s+|sealed\s+|static\s+)*(?:class|struct|enum|trait|interface|record|protocol)\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
  { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|inline\s+|virtual\s+|extern\s+|unsafe\s+)*(?:function\*?|fn|def|func|sub|proc)\s+(?:\([^)]*\)\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\(/ },
  { kind: 'function', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/ },
  { kind: 'const', re: /^\s*export\s+(?:const|let|var|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
  { kind: 'function', re: /^\s*(?:public|private|protected|static|inline|virtual|const|constexpr|unsigned|signed|void|bool|int|long|double|float|char|auto|string|String|[A-Z][A-Za-z0-9_<>:*&]+)\s+(?:[A-Za-z0-9_:*&<>]+\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:const\s*)?(?:throws\s+[A-Za-z0-9_,\s]+)?\{/ },
];

const CONTROL_CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'typeof', 'new', 'delete', 'await', 'match',
]);

function extractStructure(filePath, codeText, startLineOffset = 1) {
  const raw = String(codeText ?? '');
  const allLines = raw.split(/\r?\n/);
  const imports = [];
  const definitions = [];
  const calls = [];
  const seenDefs = new Set();
  const isJsonLike =
    String(filePath || '').toLowerCase().endsWith('.json') || /^\s*[\[{]/.test(raw);

  for (let i = 0; i < allLines.length; i += 1) {
    const line = allLines[i];
    const lineNum = startLineOffset + i;
    if (
      imports.length < 16 &&
      /^\s*(?:#include\b|import\b|export\s+.*from\b|from\s+\S+\s+import\b|use\s+|using\s+|package\s+|const\s+.*=\s*require\()/.test(line)
    ) {
      imports.push({ line: lineNum, text: line.trim().slice(0, 140) });
    }
    if (!isJsonLike && definitions.length < 64) {
      for (const pat of GENERIC_DECL_PATTERNS) {
        const m = line.match(pat.re);
        if (m?.[1] && !CONTROL_CALL_KEYWORDS.has(m[1])) {
          const key = `${m[1]}@${lineNum}`;
          if (!seenDefs.has(key)) {
            seenDefs.add(key);
            definitions.push({
              name: m[1],
              shortName: m[1],
              kind: pat.kind,
              line: lineNum,
            });
          }
          break;
        }
      }
    }
    if (calls.length < 64 && !isJsonLike) {
      for (const cm of line.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]{2,})\s*\(/g)) {
        const callee = cm[1];
        if (CONTROL_CALL_KEYWORDS.has(callee) || STOPWORDS.has(callee.toLowerCase())) continue;
        calls.push({ name: callee, specifier: null, line: lineNum });
        if (calls.length >= 64) break;
      }
    }
  }

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
  const pushUnique = (raw) => {
    const p = String(raw || '').trim();
    if (p && !out.includes(p)) out.push(p);
  };
  if (lower === 'apply_patch') {
    const patchText = String(args?.patch ?? args?.patchText ?? args?.input ?? '');
    for (const m of patchText.matchAll(/^\*\*\*\s+(?:Add|Update|Delete|Move to:)\s*(?:File:\s*)?(.+)$/gm)) {
      pushUnique(m[1]);
    }
    for (const m of patchText.matchAll(/^(?:\+\+\+|---)\s+(?:a\/|b\/)?([^\t\r\n]+)(?:\t.*)?$/gm)) {
      const candidate = String(m[1] ?? '').trim();
      if (candidate && candidate !== '/dev/null' && candidate !== 'dev/null') pushUnique(candidate);
    }
  } else {
    pushUnique(args?.path ?? args?.filePath ?? args?.file ?? args?.target_file ?? '');
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

function isDecoyPath(rawPath) {
  const norm = String(rawPath || '').replace(/\\/g, '/').trim();
  if (!norm) return false;
  return DECOY_PATH_SEGMENT_RE.test(norm) || DECOY_FILENAME_RE.test(norm);
}

function extractFirstNonEmptyLine(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length > 0) return line;
  }
  return '';
}

/**
 * Detects explicit legacy/archive/decoy path segments, `[_-]decoy.` filenames,
 * or explicit `DO NOT EDIT - ARCHIVED DECOY` first-line banners.
 */
export function isDecoyCue(path = '', content = '') {
  const normPath = String(path || '').replace(/\\/g, '/');
  if (normPath.startsWith('grep:') || normPath.startsWith('glob:')) {
    const headLines = String(content ?? '').split(/\r?\n/).slice(0, 16);
    const nonEmpty = headLines.map((l) => l.trim()).filter(Boolean);
    if (nonEmpty.length === 0) return false;
    return nonEmpty.every((line) => {
      if (normPath.startsWith('grep:')) {
        const m = line.match(/^(.+?):\d+:(.*)$/);
        if (m) {
          return isDecoyPath(m[1]) || DECOY_BANNER_LINE_RE.test(m[2]);
        }
      }
      return isDecoyPath(line) || DECOY_BANNER_LINE_RE.test(line);
    });
  }
  if (isDecoyPath(normPath)) {
    return true;
  }
  const firstNonEmpty = extractFirstNonEmptyLine(content);
  if (firstNonEmpty && DECOY_BANNER_LINE_RE.test(firstNonEmpty)) {
    return true;
  }
  return false;
}

/**
 * Classifies candidates into the 5 protected domains while distinguishing genuine
 * active source/contract paths from unreferenced legacy/archive decoys.
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
    isDecoy: suppressedAsDecoy,
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
      const lineStr = `${ln}: ${lines[i] ?? ''}`;
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
  reason = '',
  lowerTool = '',
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

  if (reason === 'oversized_exec_log_fidelity_summary') {
    return renderOversizedExecLogSummary({
      ref,
      innerText: envelope?.inner ?? rawOutput,
      envelope,
      maxChars: DEFAULT_OVERSIZED_EXEC_MAX_RENDERED_CHARS,
    });
  }

  if (reason === 'oversized_search_clustered_summary') {
    return renderOversizedSearchClusteredSummary({
      ref,
      lowerTool,
      innerText: envelope?.inner ?? rawOutput,
      envelope,
      maxChars: DEFAULT_OVERSIZED_SEARCH_MAX_RENDERED_CHARS,
    });
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
      ? `Imports:\n${structure.imports.slice(0, 10).map((im) => `${im.line}: ${im.text}`).join('\n')}`
      : '';
    const symbolMap = structure.definitions.length
      ? `Symbols:\n${structure.definitions.slice(0, 24).map((d) => `${d.line}: [${d.kind}] ${d.name}`).join('\n')}`
      : `Preview:\n${lines.slice(0, 8).map((l, idx) => `${startLineOffset + idx}: ${l}`).join('\n')}`;
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
    .map((d) => `${d.line}: [${d.kind}] ${d.name}`);
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
    admissionMinChars = undefined,
    workingSetReadMaxChars = undefined,
    maxSupervisorAdmissionCalls = DEFAULT_MAX_SUPERVISOR_ADMISSION_CALLS,
  } = {}) {
    this.aciStore = aciStore ?? new ReversibleContextStore();
    this.ledger = ledger;
    const hasExplicitMinChars =
      admissionMinChars !== undefined &&
      admissionMinChars !== null &&
      admissionMinChars !== '' &&
      Number.isFinite(Number(admissionMinChars));
    this._explicitAdmissionMinChars = hasExplicitMinChars
      ? Math.max(200, Number(admissionMinChars))
      : undefined;
    this.admissionMinChars = this._explicitAdmissionMinChars ?? DEFAULT_ADMISSION_MIN_CHARS;
    const hasExplicitWorkingSet =
      workingSetReadMaxChars !== undefined &&
      workingSetReadMaxChars !== null &&
      workingSetReadMaxChars !== '' &&
      Number.isFinite(Number(workingSetReadMaxChars));
    this.workingSetReadMaxChars = hasExplicitWorkingSet
      ? Math.max(0, Number(workingSetReadMaxChars))
      : undefined;
    this.maxSupervisorAdmissionCalls = Math.max(
      0,
      Number(maxSupervisorAdmissionCalls ?? DEFAULT_MAX_SUPERVISOR_ADMISSION_CALLS),
    );
    this.activeHashesByPath = new Map(); // normPath / `${normPath}#${lineRange}` / `__probe__:*` -> { sha256, step, uri, refId, lineRange }
    this.activeUriByPathStep = new Map(); // `${normPath}@${step}` -> uri
    this.activeSymbols = new Set();
    this.activeImports = new Set();
    this._mutatedFilesSeen = new Set();
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
      if (norm) {
        if (!this._mutatedFilesSeen.has(norm)) {
          this._mutatedFilesSeen.add(norm);
          this.invalidatePath(norm);
        }
        this.activeImports.add(norm);
      }
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
      if (key.startsWith('__probe__:')) {
        this.activeHashesByPath.delete(key);
        continue;
      }
      const baseKey = key.split('#')[0];
      if (pathsMatch(baseKey, norm)) {
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
      admissionMinChars = undefined,
      workingSetReadMaxChars = undefined,
      maxSupervisorAdmissionCalls = null,
      minSupervisorBatchChars = undefined,
      mainModel = null,
    } = {},
  ) {
    const items = Array.isArray(executedBatch) ? executedBatch : [];
    const hasOptAdmissionMinChars =
      admissionMinChars !== undefined &&
      admissionMinChars !== null &&
      admissionMinChars !== '' &&
      Number.isFinite(Number(admissionMinChars));
    const hasExplicitAdmissionMinChars =
      hasOptAdmissionMinChars || this._explicitAdmissionMinChars !== undefined;
    const minChars = hasOptAdmissionMinChars
      ? Math.max(200, Number(admissionMinChars))
      : this.admissionMinChars;
    const optWorkingSetMax =
      workingSetReadMaxChars !== undefined &&
      workingSetReadMaxChars !== null &&
      workingSetReadMaxChars !== '' &&
      Number.isFinite(Number(workingSetReadMaxChars))
        ? Math.max(0, Number(workingSetReadMaxChars))
        : undefined;
    const effectiveWorkingSetMax =
      optWorkingSetMax ??
      this.workingSetReadMaxChars ??
      (hasExplicitAdmissionMinChars ? 0 : DEFAULT_WORKING_SET_READ_MAX_CHARS);
    const probeMinChars = hasExplicitAdmissionMinChars
      ? minChars
      : DEFAULT_PROBE_ADMISSION_MIN_CHARS;
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

      const textStats = computeTextSignalStats(innerText);
      const isMutation = MUTATION_TOOLS.has(lowerTool);
      const isAlwaysDirectTool = ALWAYS_DIRECT_TOOLS.has(lowerTool);
      const isReadOnlyDedupTool = READ_ONLY_DEDUP_TOOLS.has(lowerTool);
      const isReadProbeTool = lowerTool === 'grep' || lowerTool === 'glob';
      const isStructuredJsonTool = !isReadOnlyDedupTool && STRUCTURED_JSON_STATUS_RE.test(innerText);
      const isStructuredFailure = isStructuredJsonTool && STRUCTURED_JSON_FAILURE_RE.test(innerText);
      const isExecErrorTool = EXEC_ERROR_TOOLS.has(lowerTool) || textStats.exitCode !== null;
      const isErr =
        Boolean(item?.isError) ||
        isStructuredFailure ||
        (isExecErrorTool &&
          ((textStats.exitCode !== null && textStats.exitCode !== 0) ||
            GENERIC_EXEC_ERROR_RE.test(innerText)));

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

      const isDecoy = Boolean(domainInfo.isDecoy || domainInfo.suppressedAsDecoy);
      const sliceStartArg = args?.startLine ?? args?.start_line;
      const sliceEndArg = args?.endLine ?? args?.end_line;
      const isNarrowSlice =
        lowerTool === 'read_file' &&
        !isDecoy &&
        (sliceStartArg != null || sliceEndArg != null) &&
        (() => {
          const from = Number(sliceStartArg ?? 1);
          const to =
            sliceEndArg != null
              ? Number(sliceEndArg)
              : parsedRead?.endLine ?? from + 399;
          return Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from + 1 <= 400;
        })();

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

      const isSliceRead =
        args?.startLine != null ||
        args?.endLine != null ||
        args?.start_line != null ||
        args?.end_line != null;
      const probeKey = isReadProbeTool
        ? `__probe__:${lowerTool}:${stableArgsStringify(args)}`
        : null;

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
        probeKey,
        isReadProbeTool,
        isSliceRead,
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
        textStats,
        focusSymbols,
        decision: null,
        reason: '',
        priorStep: null,
      };

      const isNoisyProbeTool = NOISY_PROBE_TOOLS.has(lowerTool);
      const smallFastPathMaxChars =
        isNoisyProbeTool || isStructuredJsonTool ? probeMinChars : minChars;

      // DUPLICATE check (runs BEFORE isErr for read-only tools, isNarrowSlice, explicit_read_working_set, and oversized compression)
      const sliceKey = !isReadProbeTool && normPath && isSliceRead ? `${normPath}#${lineRange}` : null;
      const activeMem = probeKey
        ? this.activeHashesByPath.get(probeKey)
        : normPath
          ? ((sliceKey && this.activeHashesByPath.get(sliceKey)) ||
              this.activeHashesByPath.get(normPath))
          : null;
      const storeMatch =
        !activeMem && !isReadProbeTool && normPath
          ? this.aciStore?.findByPathAndHash?.(targetPath, contentSha256)
          : null;
      const dupMatch =
        !item?.isError &&
        (isReadOnlyDedupTool || !isErr) &&
        (activeMem && activeMem.sha256 === contentSha256
          ? activeMem
          : storeMatch && storeMatch.sha256 === contentSha256
            ? storeMatch
            : null);

      const isLowEntropyRepetitiveExec =
        isExecErrorTool &&
        !isErr &&
        innerText.length > probeMinChars &&
        (textStats.repeatedLineRatio >= 0.72 || textStats.charEntropy < 2.6);

      // Deterministic Pre-Screen & Fast-Paths
      if (isMutation) {
        ctxRecord.decision = ADMISSION_DECISIONS.DIRECT;
        ctxRecord.reason = 'mutation_output';
      } else if (isExecErrorTool && innerText.length > DEFAULT_OVERSIZED_EXEC_MIN_CHARS) {
        ctxRecord.decision = ADMISSION_DECISIONS.SUPPORTING;
        ctxRecord.reason = 'oversized_exec_log_fidelity_summary';
      } else if (dupMatch && innerText.length > smallFastPathMaxChars) {
        ctxRecord.decision = ADMISSION_DECISIONS.DUPLICATE;
        ctxRecord.priorStep = dupMatch.step ?? 0;
        ctxRecord.reason = `duplicate_unchanged_step_${ctxRecord.priorStep}`;
      } else if (isErr) {
        ctxRecord.decision = ADMISSION_DECISIONS.DIRECT;
        ctxRecord.reason = 'error_output';
      } else if (
        (lowerTool === 'grep' || lowerTool === 'glob') &&
        !item?.isError &&
        innerText.length > DEFAULT_OVERSIZED_SEARCH_MIN_CHARS &&
        !isDecoy
      ) {
        ctxRecord.decision = ADMISSION_DECISIONS.SUPPORTING;
        ctxRecord.reason = 'oversized_search_clustered_summary';
      } else if (isAlwaysDirectTool) {
        ctxRecord.decision = ADMISSION_DECISIONS.DIRECT;
        ctxRecord.reason = 'always_direct_tool';
      } else if (
        isStructuredJsonTool &&
        innerText.length <= DEFAULT_PROBE_ADMISSION_MIN_CHARS
      ) {
        ctxRecord.decision = ADMISSION_DECISIONS.DIRECT;
        ctxRecord.reason = 'compact_structured_output';
      } else if (isNarrowSlice) {
        ctxRecord.decision = ADMISSION_DECISIONS.DIRECT;
        ctxRecord.reason = 'narrow_line_slice';
      } else if (innerText.length <= smallFastPathMaxChars) {
        ctxRecord.decision = ADMISSION_DECISIONS.DIRECT;
        ctxRecord.reason = 'small_payload_fast_path';
      } else if (
        lowerTool === 'read_file' &&
        !isErr &&
        !isDecoy &&
        innerText.length <= effectiveWorkingSetMax
      ) {
        ctxRecord.decision = ADMISSION_DECISIONS.DIRECT;
        ctxRecord.reason = 'explicit_read_working_set';
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
      } else if (isLowEntropyRepetitiveExec) {
        ctxRecord.decision = ADMISSION_DECISIONS.SUPPORTING;
        ctxRecord.reason = 'oversized_exec_log_fidelity_summary';
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

      prepared.push(ctxRecord);
    }

    // Selective Batched Supervisor Call (at most once per tool batch)
    let supervisorRes = null;
    const hasExplicitMinSupBatchChars =
      minSupervisorBatchChars !== undefined &&
      minSupervisorBatchChars !== null &&
      minSupervisorBatchChars !== '' &&
      Number.isFinite(Number(minSupervisorBatchChars));
    if (
      supervisorEnabled &&
      supervisor &&
      typeof supervisor.admitCandidates === 'function' &&
      ambiguousQueue.length > 0 &&
      this.supervisorAdmissionCalls < maxSupCalls
    ) {
      const resolved = supervisor.resolveModel?.(supervisorConfigOverride, { mainModel });
      const effectiveMinSupBatchChars = hasExplicitMinSupBatchChars
        ? Math.max(0, Number(minSupervisorBatchChars))
        : resolved?.config?.mode === 'auto' &&
            effectiveWorkingSetMax >= DEFAULT_WORKING_SET_READ_MAX_CHARS
          ? DEFAULT_MIN_SUPERVISOR_BATCH_CHARS
          : 0;
      const ambiguousQueueChars = ambiguousQueue.reduce((sum, c) => sum + c.innerText.length, 0);
      if (resolved?.active && ambiguousQueueChars >= effectiveMinSupBatchChars) {
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
            mainModel,
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
        if (!c.isMutation && !EXEC_ERROR_TOOLS.has(c.lowerTool)) {
          const directEntry = {
            sha256: c.contentSha256,
            step,
            uri: directMeta?.uri ?? `artifact://${c.contentSha256}`,
            refId: null,
            lineRange: c.lineRange,
          };
          if (c.probeKey) {
            if (!c.item?.isError) {
              this.activeHashesByPath.set(c.probeKey, directEntry);
            }
          } else if (c.normPath) {
            if (!c.isSliceRead) {
              this.activeHashesByPath.set(c.normPath, directEntry);
            } else if (
              c.reason === 'explicit_read_working_set' ||
              c.reason === 'narrow_line_slice' ||
              c.lowerTool === 'read_file'
            ) {
              this.activeHashesByPath.set(`${c.normPath}#${c.lineRange}`, directEntry);
            }
          }
          if (c.normPath) {
            this.activeUriByPathStep.set(`${c.normPath}@${step}`, directEntry.uri);
          }
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
        if (c.probeKey && !c.item?.isError && finalDecision !== ADMISSION_DECISIONS.DUPLICATE) {
          this.activeHashesByPath.set(c.probeKey, {
            sha256: c.contentSha256,
            step,
            uri: ref.uri,
            refId: ref.refId,
            lineRange: c.lineRange,
          });
        }
        if (c.normPath) {
          this.activeUriByPathStep.set(`${c.normPath}@${step}`, ref.uri);
          if (
            !c.probeKey &&
            finalDecision === ADMISSION_DECISIONS.SUPPORTING &&
            !c.args?.startLine &&
            !c.args?.endLine
          ) {
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
          reason: c.reason,
          lowerTool: c.lowerTool,
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
        textStats: c.textStats,
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
      workingSetReadMaxChars: opts.workingSetReadMaxChars,
      maxSupervisorAdmissionCalls: opts.maxSupervisorAdmissionCalls,
    });
  return controller.admitBatch(executedBatch, opts);
}
