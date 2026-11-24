import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { sha256Hex } from './integrity.js';
import {
  isProtectedPathSegment,
  normalizeProtectedSegment,
  resolveConfinedPath,
  sanitizeChildEnv,
} from './tools/sandbox.js';

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const stateKeyFor = (rel) => (CASE_INSENSITIVE_FS ? String(rel).toLowerCase() : String(rel));

// ---- 1. Codex 4-Tier Progressive Fuzzy Sequence Matcher (seek_sequence.rs) ----

function normaliseUnicode(s) {
  return String(s)
    .trim()
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

export function seekSequenceFuzzy(lines, pattern, start = 0, eof = false) {
  if (!pattern.length) return { index: start, tier: 'exact' };
  if (pattern.length > lines.length) return null;

  const searchStart =
    eof && lines.length >= pattern.length
      ? Math.max(lines.length - pattern.length, start)
      : start;
  const maxStart = lines.length - pattern.length;

  const tiers = [
    ['exact', (a, b) => a === b],
    ['rstrip', (a, b) => a.trimEnd() === b.trimEnd()],
    ['trim', (a, b) => a.trim() === b.trim()],
    ['unicode', (a, b) => normaliseUnicode(a) === normaliseUnicode(b)],
  ];

  for (const [tier, cmp] of tiers) {
    const matches = [];
    for (let i = searchStart; i <= maxStart; i++) {
      let ok = true;
      for (let p = 0; p < pattern.length; p++) {
        if (!cmp(lines[i + p], pattern[p])) {
          ok = false;
          break;
        }
      }
      if (ok) matches.push(i);
    }
    if (matches.length > 0) {
      return { index: matches[0], count: matches.length, matches, tier };
    }
  }
  return null;
}

function seekSequenceNear(lines, pattern, preferredIndex, minStart = 0, eof = false) {
  const hit = seekSequenceFuzzy(lines, pattern, minStart, eof);
  if (!hit) return null;
  if (preferredIndex === null || preferredIndex === undefined || !hit.matches?.length || hit.matches.length === 1) {
    return hit;
  }
  let best = hit.matches[0];
  let bestDist = Math.abs(best - preferredIndex);
  for (const candidate of hit.matches) {
    const dist = Math.abs(candidate - preferredIndex);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return { ...hit, index: best };
}

/**
 * Upgrades single-file edit_file with Codex 4-tier progressive matching while
 * preserving original file CRLF/LF line endings and reporting ambiguity safely.
 */
export function applyFuzzyEdit(beforeText, targetText, replacementText, { replaceAll = false } = {}) {
  const useCrlf = beforeText.includes('\r\n');
  const normBefore = beforeText.replace(/\r\n/g, '\n');
  const normTarget = targetText.replace(/\r\n/g, '\n');
  const normReplacement = replacementText.replace(/\r\n/g, '\n');

  // Tier 0: Exact substring match (fast path & handles inline partial-line edits)
  let exactCount = 0;
  let idx = 0;
  while ((idx = normBefore.indexOf(normTarget, idx)) !== -1) {
    exactCount++;
    idx += normTarget.length;
  }
  if (exactCount > 0) {
    if (exactCount > 1 && !replaceAll) {
      return {
        ok: false,
        code: 'AMBIGUOUS',
        count: exactCount,
        error: `找到 ${exactCount} 处匹配；请补充更多上下文使其唯一，或设置 replaceAll: true。`,
      };
    }
    let after = replaceAll
      ? normBefore.split(normTarget).join(normReplacement)
      : normBefore.replace(normTarget, normReplacement);
    if (useCrlf) after = after.replace(/\n/g, '\r\n');
    return {
      ok: true,
      after,
      tier: 'exact',
      replacedCount: replaceAll ? exactCount : 1,
    };
  }

  // Tier 1-3: Line-based Codex 4-tier fuzzy matching
  const fileLines = normBefore.split('\n');
  const targetLines = normTarget.split('\n');
  const replLines = normReplacement.split('\n');
  const found = seekSequenceFuzzy(fileLines, targetLines, 0, false);
  if (!found) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      count: 0,
      error: '未找到匹配的 target 片段（已尝试精确/去尾空格/去缩进/Unicode 归一化匹配），请先 read_file 核对准确内容。',
    };
  }
  if (found.count > 1 && !replaceAll) {
    return {
      ok: false,
      code: 'AMBIGUOUS',
      count: found.count,
      error: `模糊匹配 (${found.tier}) 命中 ${found.count} 处；请提供更多上下文行使其唯一，或设置 replaceAll: true。`,
    };
  }

  const nextLines = [...fileLines];
  const positions = replaceAll ? [...found.matches].reverse() : [found.index];
  for (const pos of positions) {
    nextLines.splice(pos, targetLines.length, ...replLines);
  }
  let after = nextLines.join('\n');
  if (useCrlf) after = after.replace(/\n/g, '\r\n');
  return {
    ok: true,
    after,
    tier: found.tier,
    replacedCount: positions.length,
  };
}

// ---- 2. Multi-Format Atomic `apply_patch` Parser, Lock, Validation & Diff Echo ----

export function parseCodexPatch(patchText) {
  const rawLines = String(patchText ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');

  const start = rawLines.findIndex((l) => l.trim() === '*** Begin Patch');
  const end = rawLines.findLastIndex((l) => l.trim() === '*** End Patch');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('补丁格式无效：必须由 `*** Begin Patch` 开始并以 `*** End Patch` 结束');
  }

  const lines = rawLines.slice(start + 1, end);
  const hunks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const added = [];
      while (i < lines.length && !lines[i].trim().startsWith('*** ')) {
        const l = lines[i];
        if (!l.startsWith('+')) {
          throw new Error(`Add File (${path}) 中所有内容行必须以 '+' 开头: ${l}`);
        }
        added.push(l.slice(1));
        i++;
      }
      hunks.push({ type: 'add', path, content: added.join('\n') });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      hunks.push({ type: 'delete', path });
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      i++;
      let moveTo = null;
      if (i < lines.length && lines[i].trim().startsWith('*** Move to: ')) {
        moveTo = lines[i].trim().slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks = [];
      let curChunk = null;
      const flushChunk = () => {
        if (curChunk && (curChunk.oldLines.length || curChunk.newLines.length)) {
          chunks.push(curChunk);
        }
        curChunk = null;
      };
      while (i < lines.length) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (
          trimmed.startsWith('*** Add File:') ||
          trimmed.startsWith('*** Delete File:') ||
          trimmed.startsWith('*** Update File:')
        ) {
          break;
        }
        if (trimmed === '*** End of File') {
          if (curChunk) curChunk.eof = true;
          i++;
          continue;
        }
        if (trimmed === '@@' || trimmed.startsWith('@@ ')) {
          flushChunk();
          curChunk = {
            context: trimmed.startsWith('@@ ') ? trimmed.slice(3).trim() : null,
            oldLines: [],
            newLines: [],
            eof: false,
          };
          i++;
          continue;
        }
        if (!curChunk) {
          curChunk = { context: null, oldLines: [], newLines: [], eof: false };
        }
        if (raw.startsWith('+')) {
          curChunk.newLines.push(raw.slice(1));
        } else if (raw.startsWith('-')) {
          curChunk.oldLines.push(raw.slice(1));
        } else if (raw.startsWith(' ')) {
          curChunk.oldLines.push(raw.slice(1));
          curChunk.newLines.push(raw.slice(1));
        } else if (raw === '') {
          curChunk.oldLines.push('');
          curChunk.newLines.push('');
        } else {
          throw new Error(`Update File (${path}) 存在无法识别的补丁行前缀: ${raw.slice(0, 60)}`);
        }
        i++;
      }
      flushChunk();
      hunks.push({ type: 'update', path, moveTo, chunks });
    } else {
      throw new Error(`未知补丁指令: ${line}`);
    }
  }

  if (!hunks.length) throw new Error('补丁中不包含任何文件改动');
  return hunks;
}

function unquoteDiffPath(raw) {
  let p = String(raw ?? '').split('\t')[0].trim();
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    p = p
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return p;
}

function normalizeUnifiedHeaderPair(oldRaw, newRaw, { hasGitHeader = false } = {}) {
  const oldP = unquoteDiffPath(oldRaw);
  const newP = unquoteDiffPath(newRaw);
  const oldNull = oldP === '/dev/null' || oldP === 'dev/null';
  const newNull = newP === '/dev/null' || newP === 'dev/null';

  const shouldStripPrefix =
    hasGitHeader ||
    ((oldNull || oldP.startsWith('a/')) && (newNull || newP.startsWith('b/')));

  const clean = (p, prefix) => {
    if (!p || p === '/dev/null' || p === 'dev/null') return null;
    if (shouldStripPrefix && p.startsWith(prefix)) return p.slice(prefix.length);
    return p;
  };

  return {
    oldPath: oldNull ? null : clean(oldP, 'a/'),
    newPath: newNull ? null : clean(newP, 'b/'),
  };
}

const UNIFIED_HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s*(.*))?$/;

export function parseUnifiedDiff(patchText) {
  const rawLines = String(patchText ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');

  const hunks = [];
  let i = 0;

  while (i < rawLines.length) {
    let sawGitHeader = false;
    let isNewFile = false;
    let isDeletedFile = false;
    let renameFrom = null;
    let renameTo = null;

    while (i < rawLines.length && !rawLines[i].trim()) i++;
    if (i >= rawLines.length) break;

    if (rawLines[i].startsWith('diff --git ')) {
      sawGitHeader = true;
      i++;
      while (i < rawLines.length) {
        const line = rawLines[i];
        if (line.startsWith('--- ') || line.startsWith('diff --git ')) break;
        if (line.startsWith('new file mode ')) isNewFile = true;
        else if (line.startsWith('deleted file mode ')) isDeletedFile = true;
        else if (line.startsWith('rename from ')) renameFrom = unquoteDiffPath(line.slice('rename from '.length));
        else if (line.startsWith('rename to ')) renameTo = unquoteDiffPath(line.slice('rename to '.length));
        else if (
          line.startsWith('index ') ||
          line.startsWith('old mode ') ||
          line.startsWith('new mode ') ||
          line.startsWith('similarity index ') ||
          line.startsWith('dissimilarity index ') ||
          line.startsWith('copy from ') ||
          line.startsWith('copy to ')
        ) {
          // known git extended header
        } else if (!line.trim()) {
          i++;
          break;
        } else {
          break;
        }
        i++;
      }
    }

    // Pure rename without content hunks
    if (renameFrom && renameTo && (i >= rawLines.length || rawLines[i].startsWith('diff --git ') || !rawLines[i].startsWith('--- '))) {
      hunks.push({ type: 'update', path: renameFrom, moveTo: renameTo, chunks: [] });
      continue;
    }

    if (i >= rawLines.length) break;
    if (rawLines[i].startsWith('diff --git ')) continue;

    if (!rawLines[i].startsWith('--- ')) {
      throw new Error(`Unified diff 格式无效：期望 '--- <path>'，实际为 '${rawLines[i].slice(0, 80)}'`);
    }
    const oldHeader = rawLines[i].slice(4);
    i++;
    if (i >= rawLines.length || !rawLines[i].startsWith('+++ ')) {
      throw new Error('Unified diff 格式无效：缺少对应的 `+++ <path>` 行');
    }
    const newHeader = rawLines[i].slice(4);
    i++;

    const { oldPath, newPath } = normalizeUnifiedHeaderPair(oldHeader, newHeader, {
      hasGitHeader: sawGitHeader,
    });

    const chunks = [];
    let noNewlineOld = false;
    let noNewlineNew = false;

    while (i < rawLines.length) {
      const line = rawLines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      if (line.startsWith('diff --git ')) break;
      if (line.startsWith('--- ') && i + 1 < rawLines.length && rawLines[i + 1].startsWith('+++ ')) {
        break;
      }

      const hMatch = UNIFIED_HUNK_HEADER_RE.exec(line);
      if (!hMatch) {
        throw new Error(`Unified diff 块头无效: ${line.slice(0, 80)}`);
      }
      const oldStart = Number(hMatch[1]);
      const oldCount = hMatch[2] === undefined ? (oldStart === 0 ? 0 : 1) : Number(hMatch[2]);
      const newStart = Number(hMatch[3]);
      const newCount = hMatch[4] === undefined ? (newStart === 0 ? 0 : 1) : Number(hMatch[4]);
      const context = hMatch[5]?.trim() || null;
      i++;

      const chunk = {
        context,
        oldStart,
        oldCount,
        newStart,
        newCount,
        oldLines: [],
        newLines: [],
        eof: false,
        noNewlineOld: false,
        noNewlineNew: false,
      };
      let oldRem = oldCount;
      let newRem = newCount;
      let lastMarker = null;

      while (i < rawLines.length) {
        const raw = rawLines[i];
        if (raw === '\\ No newline at end of file') {
          if (lastMarker === '-') {
            chunk.noNewlineOld = true;
            noNewlineOld = true;
          } else if (lastMarker === '+') {
            chunk.noNewlineNew = true;
            noNewlineNew = true;
          } else if (lastMarker === ' ') {
            chunk.noNewlineOld = true;
            chunk.noNewlineNew = true;
            noNewlineOld = true;
            noNewlineNew = true;
          }
          chunk.eof = true;
          i++;
          continue;
        }

        const countPending = oldRem > 0 || newRem > 0;
        if (!countPending) {
          if (
            raw.startsWith('@@ ') ||
            raw.startsWith('diff --git ') ||
            (raw.startsWith('--- ') && i + 1 < rawLines.length && rawLines[i + 1].startsWith('+++ ')) ||
            raw === ''
          ) {
            break;
          }
        }

        if (raw.startsWith(' ')) {
          chunk.oldLines.push(raw.slice(1));
          chunk.newLines.push(raw.slice(1));
          oldRem--;
          newRem--;
          lastMarker = ' ';
          i++;
        } else if (raw.startsWith('-')) {
          chunk.oldLines.push(raw.slice(1));
          oldRem--;
          lastMarker = '-';
          i++;
        } else if (raw.startsWith('+')) {
          chunk.newLines.push(raw.slice(1));
          newRem--;
          lastMarker = '+';
          i++;
        } else if (raw === '' && oldRem > 0 && newRem > 0) {
          chunk.oldLines.push('');
          chunk.newLines.push('');
          oldRem--;
          newRem--;
          lastMarker = ' ';
          i++;
        } else if (!countPending) {
          break;
        } else {
          throw new Error(`Unified diff (${newPath ?? oldPath}) 存在无法识别的行前缀: ${raw.slice(0, 60)}`);
        }
      }

      chunks.push(chunk);
    }

    if (isNewFile || oldPath === null) {
      if (!newPath) throw new Error('Unified diff 新增文件缺少目标路径');
      const addedLines = [];
      for (const c of chunks) addedLines.push(...c.newLines);
      const content =
        addedLines.length === 0
          ? ''
          : noNewlineNew
            ? addedLines.join('\n')
            : `${addedLines.join('\n')}\n`;
      hunks.push({ type: 'add', path: newPath, content });
    } else if (isDeletedFile || newPath === null) {
      if (!oldPath) throw new Error('Unified diff 删除文件缺少源路径');
      hunks.push({ type: 'delete', path: oldPath });
    } else {
      const moveTo = renameTo || (oldPath !== newPath ? newPath : null);
      hunks.push({
        type: 'update',
        path: renameFrom || oldPath,
        moveTo,
        chunks,
        noNewlineOld,
        noNewlineNew,
      });
    }
  }

  if (!hunks.length) throw new Error('补丁中不包含任何文件改动');
  return hunks;
}

export function detectPatchFormat(patchText) {
  const text = String(patchText ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const hasCodexBegin = lines.some((l) => l.trim() === '*** Begin Patch');
  const hasCodexEnd = lines.some((l) => l.trim() === '*** End Patch');
  if (hasCodexBegin && hasCodexEnd) return 'codex';

  const hasDiffGit = lines.some((l) => l.startsWith('diff --git '));
  const hasUnifiedMinus = lines.some((l) => l.startsWith('--- '));
  const hasUnifiedPlus = lines.some((l) => l.startsWith('+++ '));
  const hasUnifiedHunk = lines.some((l) => UNIFIED_HUNK_HEADER_RE.test(l));
  if ((hasDiffGit && (hasUnifiedMinus || hasUnifiedHunk)) || (hasUnifiedMinus && hasUnifiedPlus)) {
    return 'unified';
  }
  if (hasCodexBegin || hasCodexEnd) return 'codex';
  return 'unknown';
}

export function parsePatch(patchText, { format = 'auto' } = {}) {
  const mode = format === 'codex' || format === 'unified' ? format : detectPatchFormat(patchText);
  if (mode === 'codex') {
    return { format: 'codex', hunks: parseCodexPatch(patchText) };
  }
  if (mode === 'unified') {
    return { format: 'unified', hunks: parseUnifiedDiff(patchText) };
  }
  throw new Error('补丁格式无法识别：请提供 Codex (`*** Begin Patch`...`*** End Patch`) 或标准 unified diff (`---`/`+++`/`@@`) 格式');
}

function findPackageModuleType(fullPath, workspaceRoot) {
  const rootAbs = workspaceRoot ? resolve(workspaceRoot) : null;
  let dir = dirname(resolve(fullPath));
  while (true) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg?.type === 'module' || pkg?.type === 'commonjs') {
          return pkg.type;
        }
      } catch {
        // ignore broken package.json during lookup
      }
      return 'auto';
    }
    if (rootAbs && resolve(dir) === rootAbs) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'auto';
}

function parseNodeCheckError(stderr, fallbackMsg = 'SyntaxError') {
  const clean = String(stderr ?? '').replace(/\r\n/g, '\n').trim();
  const lineMatch = /\[stdin\]:(\d+)/.exec(clean) ?? /:(\d+)\n/.exec(clean);
  const msgMatch = /((?:SyntaxError|ReferenceError|TypeError|Error):[^\n]+)/.exec(clean);
  return {
    line: lineMatch ? Number(lineMatch[1]) : 1,
    column: 1,
    message: msgMatch ? msgMatch[1].trim() : clean.slice(0, 400) || fallbackMsg,
  };
}

function lineColFromOffset(text, offset) {
  const safeOffset = Math.max(0, Math.min(text.length, Number(offset) || 0));
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < safeOffset; i++) {
    if (text[i] === '\n') {
      line++;
      lastNl = i;
    }
  }
  return { line, column: safeOffset - lastNl };
}

/**
 * Validates JS/MJS/CJS/JSON syntax purely from in-memory content before touching disk.
 */
export function validateCodeSyntax(relPath, content, { workspaceRoot = null, fullPath = null } = {}) {
  const ext = extname(relPath).toLowerCase();
  const text = String(content ?? '');

  if (ext === '.json') {
    try {
      JSON.parse(text);
      return { ok: true };
    } catch (err) {
      const msg = String(err?.message ?? err);
      const lcMatch = /line\s+(\d+)\s+column\s+(\d+)/i.exec(msg);
      const posMatch = /position\s+(\d+)/i.exec(msg);
      let line = 1;
      let column = 1;
      if (lcMatch) {
        line = Number(lcMatch[1]);
        column = Number(lcMatch[2]);
      } else if (posMatch) {
        const lc = lineColFromOffset(text, Number(posMatch[1]));
        line = lc.line;
        column = lc.column;
      }
      return {
        ok: false,
        file: relPath,
        line,
        column,
        code: 'JSON_PARSE_ERROR',
        message: msg,
      };
    }
  }

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const runCheck = (inputType) =>
      spawnSync(process.execPath, [`--input-type=${inputType}`, '--check'], {
        input: text,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
      });

    let mode = 'auto';
    if (ext === '.mjs') mode = 'module';
    else if (ext === '.cjs') mode = 'commonjs';
    else if (fullPath || workspaceRoot) {
      mode = findPackageModuleType(fullPath || resolve(workspaceRoot, relPath), workspaceRoot);
    }

    if (mode === 'module' || mode === 'commonjs') {
      const res = runCheck(mode);
      if (res.status === 0) return { ok: true };
      const parsed = parseNodeCheckError(res.stderr || res.stdout);
      return {
        ok: false,
        file: relPath,
        line: parsed.line,
        column: parsed.column,
        code: 'SYNTAX_ERROR',
        message: parsed.message,
      };
    }

    const cjsRes = runCheck('commonjs');
    if (cjsRes.status === 0) return { ok: true };
    const cjsErr = String(cjsRes.stderr || cjsRes.stdout || '');
    const esmHint =
      /Cannot use import statement outside a module|Unexpected token 'export'|Cannot use 'import\.meta' outside a module/i.test(
        cjsErr,
      );
    if (esmHint) {
      const esmRes = runCheck('module');
      if (esmRes.status === 0) return { ok: true };
      const parsed = parseNodeCheckError(esmRes.stderr || esmRes.stdout);
      return {
        ok: false,
        file: relPath,
        line: parsed.line,
        column: parsed.column,
        code: 'SYNTAX_ERROR',
        message: parsed.message,
      };
    }
    const parsed = parseNodeCheckError(cjsErr);
    return {
      ok: false,
      file: relPath,
      line: parsed.line,
      column: parsed.column,
      code: 'SYNTAX_ERROR',
      message: parsed.message,
    };
  }

  return { ok: true };
}

function splitLinesForDiff(text) {
  if (text === null || text === undefined || text === '') return [];
  const norm = String(text).replace(/\r\n/g, '\n');
  const parts = norm.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

/**
 * Computes a standard unified diff + addition/deletion counts + bounded compact hunks.
 */
export function computeUnifiedDiff(
  relPath,
  beforeText,
  afterText,
  { action = 'updated', oldPath = null, contextLines = 3, maxDiffLines = 120 } = {},
) {
  const fromLabel = beforeText === null ? '/dev/null' : `a/${oldPath || relPath}`;
  const toLabel = afterText === null ? '/dev/null' : `b/${relPath}`;
  const header = [`--- ${fromLabel}`, `+++ ${toLabel}`];

  if (beforeText === null && afterText !== null) {
    const bLines = splitLinesForDiff(afterText);
    const additions = bLines.length;
    const body = bLines.map((l) => `+${l}`);
    const hunkHeader = `@@ -0,0 +1,${additions} @@`;
    const allDiffLines = [...header, hunkHeader, ...body];
    const bounded =
      allDiffLines.length > maxDiffLines
        ? [...allDiffLines.slice(0, maxDiffLines), `... (${allDiffLines.length - maxDiffLines} more diff lines omitted)`]
        : allDiffLines;
    const compactHunks =
      body.length > 40
        ? [hunkHeader, ...body.slice(0, 40), `... (+${body.length - 40} more lines)`].join('\n')
        : [hunkHeader, ...body].join('\n');
    return {
      action: action || 'added',
      additions,
      deletions: 0,
      unifiedDiff: bounded.join('\n'),
      hunksText: compactHunks,
    };
  }

  if (beforeText !== null && afterText === null) {
    const aLines = splitLinesForDiff(beforeText);
    const deletions = aLines.length;
    const body = aLines.map((l) => `-${l}`);
    const hunkHeader = `@@ -1,${deletions} +0,0 @@`;
    const allDiffLines = [...header, hunkHeader, ...body];
    const bounded =
      allDiffLines.length > maxDiffLines
        ? [...allDiffLines.slice(0, maxDiffLines), `... (${allDiffLines.length - maxDiffLines} more diff lines omitted)`]
        : allDiffLines;
    const compactHunks =
      body.length > 40
        ? [hunkHeader, ...body.slice(0, 40), `... (-${body.length - 40} more lines)`].join('\n')
        : [hunkHeader, ...body].join('\n');
    return {
      action: action || 'deleted',
      additions: 0,
      deletions,
      unifiedDiff: bounded.join('\n'),
      hunksText: compactHunks,
    };
  }

  const a = splitLinesForDiff(beforeText ?? '');
  const b = splitLinesForDiff(afterText ?? '');
  const m = a.length;
  const n = b.length;

  const ops = [];
  let additions = 0;
  let deletions = 0;

  if (m * n > 250000) {
    // Prefix/suffix trim + O(N) fallback on huge files
    let prefix = 0;
    while (prefix < m && prefix < n && a[prefix] === b[prefix]) {
      ops.push({ kind: ' ', oldLine: prefix + 1, newLine: prefix + 1, text: a[prefix] });
      prefix++;
    }
    let suffix = 0;
    while (m - 1 - suffix >= prefix && n - 1 - suffix >= prefix && a[m - 1 - suffix] === b[n - 1 - suffix]) {
      suffix++;
    }
    for (let i = prefix; i < m - suffix; i++) {
      ops.push({ kind: '-', oldLine: i + 1, newLine: null, text: a[i] });
      deletions++;
    }
    for (let j = prefix; j < n - suffix; j++) {
      ops.push({ kind: '+', oldLine: null, newLine: j + 1, text: b[j] });
      additions++;
    }
    for (let s = suffix; s > 0; s--) {
      const i = m - s;
      const j = n - s;
      ops.push({ kind: ' ', oldLine: i + 1, newLine: j + 1, text: a[i] });
    }
  } else {
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (a[i] === b[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) {
        ops.push({ kind: ' ', oldLine: i + 1, newLine: j + 1, text: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ kind: '-', oldLine: i + 1, newLine: null, text: a[i] });
        deletions++;
        i++;
      } else {
        ops.push({ kind: '+', oldLine: null, newLine: j + 1, text: b[j] });
        additions++;
        j++;
      }
    }
    while (i < m) {
      ops.push({ kind: '-', oldLine: i + 1, newLine: null, text: a[i] });
      deletions++;
      i++;
    }
    while (j < n) {
      ops.push({ kind: '+', oldLine: null, newLine: j + 1, text: b[j] });
      additions++;
      j++;
    }
  }

  // Group into unified hunks with `contextLines` surrounding context
  const changeIndices = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].kind !== ' ') changeIndices.push(idx);
  }
  if (!changeIndices.length) {
    return {
      action,
      additions: 0,
      deletions: 0,
      unifiedDiff: header.join('\n'),
      hunksText: '',
    };
  }

  const windows = [];
  for (const idx of changeIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(ops.length - 1, idx + contextLines);
    if (windows.length && start <= windows[windows.length - 1].end + 1) {
      windows[windows.length - 1].end = Math.max(windows[windows.length - 1].end, end);
    } else {
      windows.push({ start, end });
    }
  }

  const hunkBlocks = [];
  for (const w of windows) {
    const slice = ops.slice(w.start, w.end + 1);
    const oldLinesInHunk = slice.filter((o) => o.kind !== '+');
    const newLinesInHunk = slice.filter((o) => o.kind !== '-');
    const oldStart = oldLinesInHunk.length
      ? oldLinesInHunk[0].oldLine
      : (slice.find((o) => o.newLine !== null)?.newLine ?? 1) - 1;
    const newStart = newLinesInHunk.length
      ? newLinesInHunk[0].newLine
      : (slice.find((o) => o.oldLine !== null)?.oldLine ?? 1) - 1;
    const hunkHeader = `@@ -${Math.max(0, oldStart)},${oldLinesInHunk.length} +${Math.max(0, newStart)},${newLinesInHunk.length} @@`;
    hunkBlocks.push(hunkHeader, ...slice.map((o) => `${o.kind}${o.text}`));
  }

  const allDiffLines = [...header, ...hunkBlocks];
  const bounded =
    allDiffLines.length > maxDiffLines
      ? [...allDiffLines.slice(0, maxDiffLines), `... (${allDiffLines.length - maxDiffLines} more diff lines omitted)`]
      : allDiffLines;
  const compactHunks =
    hunkBlocks.length > 60
      ? [...hunkBlocks.slice(0, 60), `... (${hunkBlocks.length - 60} more hunk lines omitted)`].join('\n')
      : hunkBlocks.join('\n');

  return {
    action,
    additions,
    deletions,
    unifiedDiff: bounded.join('\n'),
    hunksText: compactHunks,
  };
}

function createOptimisticLockError(rel, expectedHash, actualHash, detail = '') {
  const expShort = expectedHash ? String(expectedHash).slice(0, 12) : '<absent>';
  const actShort = actualHash ? String(actualHash).slice(0, 12) : '<absent>';
  const suffix = detail ? ` (${detail})` : '';
  const err = new Error(
    `OPTIMISTIC_LOCK_CONFLICT: ${rel} 哈希冲突，期望 ${expShort}，磁盘实际为 ${actShort}${suffix}；未修改任何文件，请先重新 read_file。`,
  );
  err.code = 'OPTIMISTIC_LOCK_CONFLICT';
  err.path = rel;
  err.expectedSha256 = expectedHash ?? null;
  err.actualSha256 = actualHash ?? null;
  return err;
}

export function applyCodexPatch(
  patchText,
  {
    workspaceRoot,
    resolveSafePath = resolveConfinedPath,
    format = 'auto',
    expectedHashes = null,
    allowSyntaxError = false,
    readFileState = null,
    checkStale = () => {},
    onBeforeMutate = () => {},
    onFileChanged = () => {},
  },
) {
  const { format: detectedFormat, hunks } = parsePatch(patchText, { format });

  // Build normalized expectedHashes map if provided
  const expectedMap = new Map();
  if (expectedHashes && typeof expectedHashes === 'object') {
    for (const [rawPath, rawHash] of Object.entries(expectedHashes)) {
      const resolved = resolveSafePath(workspaceRoot, rawPath);
      const normExpected =
        rawHash === null || rawHash === undefined || String(rawHash).trim() === ''
          ? null
          : String(rawHash).trim().toLowerCase();
      expectedMap.set(stateKeyFor(resolved.rel), {
        rel: resolved.rel,
        full: resolved.full,
        expectedSha256: normExpected,
      });
    }
  }

  const verifiedLockKeys = new Set();
  const assertOptimisticLock = (rel, full) => {
    const key = stateKeyFor(rel);
    if (verifiedLockKeys.has(key)) return;
    verifiedLockKeys.add(key);

    const existed = existsSync(full);
    const actualSha256 = existed ? sha256Hex(readFileSync(full, 'utf8')) : null;

    if (expectedMap.has(key)) {
      const exp = expectedMap.get(key).expectedSha256;
      if (exp !== actualSha256) {
        throw createOptimisticLockError(rel, exp, actualSha256, 'expectedHashes mismatch');
      }
    }

    if (readFileState instanceof Map) {
      const tracked = readFileState.get(key) ?? readFileState.get(rel);
      if (tracked?.sha256) {
        const trackedSha = String(tracked.sha256).toLowerCase();
        if (!existed || actualSha256 !== trackedSha) {
          throw createOptimisticLockError(rel, trackedSha, actualSha256, 'changed since read_file');
        }
      }
    }

    try {
      checkStale(rel, full);
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (msg.includes('OPTIMISTIC_LOCK_CONFLICT')) throw err;
      const wrapped = new Error(`OPTIMISTIC_LOCK_CONFLICT: ${msg}`);
      wrapped.code = 'OPTIMISTIC_LOCK_CONFLICT';
      wrapped.path = rel;
      throw wrapped;
    }
  };

  // Preflight every entry in expectedHashes BEFORE staging or mutating anything
  for (const entry of expectedMap.values()) {
    assertOptimisticLock(entry.rel, entry.full);
  }

  // Phase 1: Atomic preflight & compute all target file contents in memory first!
  const staged = [];

  for (const h of hunks) {
    const resolved = resolveSafePath(workspaceRoot, h.path);
    assertOptimisticLock(resolved.rel, resolved.full);

    if (h.type === 'add') {
      const existed = existsSync(resolved.full);
      const before = existed ? readFileSync(resolved.full, 'utf8') : null;
      staged.push({
        type: 'write',
        rel: resolved.rel,
        full: resolved.full,
        before,
        after: h.content,
      });
    } else if (h.type === 'delete') {
      if (!existsSync(resolved.full)) {
        throw new Error(`无法删除不存在的文件: ${resolved.rel}`);
      }
      const before = readFileSync(resolved.full, 'utf8');
      staged.push({
        type: 'delete',
        rel: resolved.rel,
        full: resolved.full,
        before,
        after: null,
      });
    } else if (h.type === 'update') {
      if (!existsSync(resolved.full)) {
        throw new Error(`无法更新不存在的文件: ${resolved.rel}`);
      }
      const moveTarget = h.moveTo ? resolveSafePath(workspaceRoot, h.moveTo) : null;
      if (moveTarget) {
        assertOptimisticLock(moveTarget.rel, moveTarget.full);
      }

      const before = readFileSync(resolved.full, 'utf8');
      const useCrlf = before.includes('\r\n');
      const normBefore = before.replace(/\r\n/g, '\n');
      let lines = normBefore.split('\n');
      let cursor = 0;
      let hitEof = false;

      for (const ch of h.chunks) {
        if (ch.context && ch.oldStart === undefined) {
          const ctxHit = seekSequenceFuzzy(lines, [ch.context], cursor, false);
          if (ctxHit) cursor = ctxHit.index + 1;
        }
        if (ch.oldLines.length === 0) {
          if (normBefore === '' && ch.newLines.length > 0 && lines.length === 1 && lines[0] === '') {
            lines = [...ch.newLines, ...(ch.noNewlineNew ? [] : [''])];
            cursor = lines.length;
            hitEof = true;
            continue;
          }
          const insertAt =
            ch.oldStart !== undefined
              ? Math.min(lines.length, Math.max(cursor, ch.oldStart))
              : cursor;
          lines.splice(insertAt, 0, ...ch.newLines);
          cursor = insertAt + ch.newLines.length;
          continue;
        }

        const preferredIdx =
          ch.newStart !== undefined && ch.newStart > 0
            ? ch.newStart - 1
            : ch.oldStart !== undefined && ch.oldStart > 0
              ? ch.oldStart - 1
              : null;
        const hit =
          seekSequenceNear(lines, ch.oldLines, preferredIdx, cursor, ch.eof) ??
          seekSequenceNear(lines, ch.oldLines, preferredIdx, 0, ch.eof);
        if (!hit) {
          throw new Error(
            `补丁应用失败 (${resolved.rel})：找不到上下文块「${ch.oldLines[0]?.slice(0, 60) ?? ''}」`,
          );
        }
        const replacedEnd = hit.index + ch.oldLines.length;
        if (replacedEnd >= lines.length - 1) hitEof = true;
        lines.splice(hit.index, ch.oldLines.length, ...ch.newLines);
        cursor = hit.index + ch.newLines.length;
      }

      let after = lines.join('\n');
      if (detectedFormat === 'unified' && hitEof) {
        if (h.noNewlineNew) {
          after = after.replace(/\n$/, '');
        } else if (h.noNewlineOld && !h.noNewlineNew && after && !after.endsWith('\n')) {
          after += '\n';
        }
      }
      if (useCrlf) after = after.replace(/\n/g, '\r\n');

      staged.push({
        type: moveTarget ? 'move' : 'write',
        rel: resolved.rel,
        full: resolved.full,
        moveRel: moveTarget?.rel ?? null,
        moveFull: moveTarget?.full ?? null,
        before,
        after,
      });
    }
  }

  // Phase 1b: Pre-Commit Syntax Validation BEFORE mutating any file on disk!
  if (!allowSyntaxError) {
    for (const op of staged) {
      if (op.type === 'delete') continue;
      const targetRel = op.type === 'move' ? op.moveRel : op.rel;
      const targetFull = op.type === 'move' ? op.moveFull : op.full;
      const check = validateCodeSyntax(targetRel, op.after, {
        workspaceRoot,
        fullPath: targetFull,
      });
      if (!check.ok) {
        const err = new Error(
          `SYNTAX_VALIDATION_ERROR (${check.file}:${check.line}): ${check.message}`,
        );
        err.code = 'SYNTAX_VALIDATION_ERROR';
        err.detail = check;
        throw err;
      }
    }
  }

  // Phase 2: Commit staged writes atomically & capture snapshots/diffs
  const touched = [];
  for (const op of staged) {
    onBeforeMutate(op.rel, op.full);
    if (op.type === 'delete') {
      unlinkSync(op.full);
      const diff = computeUnifiedDiff(op.rel, op.before, null, { action: 'deleted' });
      const payload = {
        path: op.rel,
        before: Buffer.from(op.before, 'utf8').toString('base64'),
        after: null,
        action: 'deleted',
        unifiedDiff: diff.unifiedDiff,
        additions: diff.additions,
        deletions: diff.deletions,
        sha256After: null,
      };
      onFileChanged(payload);
      touched.push({
        path: op.rel,
        action: 'deleted',
        full: op.full,
        additions: diff.additions,
        deletions: diff.deletions,
        sha256After: null,
        unifiedDiff: diff.unifiedDiff,
        compactHunks: diff.hunksText,
      });
    } else if (op.type === 'move') {
      onBeforeMutate(op.moveRel, op.moveFull);
      mkdirSync(dirname(op.moveFull), { recursive: true });
      writeFileSync(op.moveFull, op.after, 'utf8');
      if (op.moveFull !== op.full && existsSync(op.full)) unlinkSync(op.full);
      const sha256After = sha256Hex(op.after);
      const diff = computeUnifiedDiff(op.moveRel, op.before, op.after, {
        action: 'moved',
        oldPath: op.rel,
      });
      onFileChanged({
        path: op.moveRel,
        before: Buffer.from(op.before, 'utf8').toString('base64'),
        after: Buffer.from(op.after, 'utf8').toString('base64'),
        action: 'moved',
        unifiedDiff: diff.unifiedDiff,
        additions: diff.additions,
        deletions: diff.deletions,
        sha256After,
      });
      touched.push({
        path: op.moveRel,
        fromPath: op.rel,
        action: 'moved',
        full: op.moveFull,
        additions: diff.additions,
        deletions: diff.deletions,
        sha256After,
        unifiedDiff: diff.unifiedDiff,
        compactHunks: diff.hunksText,
      });
    } else {
      const action = op.before === null ? 'added' : 'updated';
      mkdirSync(dirname(op.full), { recursive: true });
      writeFileSync(op.full, op.after, 'utf8');
      const sha256After = sha256Hex(op.after);
      const diff = computeUnifiedDiff(op.rel, op.before, op.after, { action });
      onFileChanged({
        path: op.rel,
        before: op.before !== null ? Buffer.from(op.before, 'utf8').toString('base64') : null,
        after: Buffer.from(op.after, 'utf8').toString('base64'),
        action,
        unifiedDiff: diff.unifiedDiff,
        additions: diff.additions,
        deletions: diff.deletions,
        sha256After,
      });
      touched.push({
        path: op.rel,
        action,
        full: op.full,
        additions: diff.additions,
        deletions: diff.deletions,
        sha256After,
        unifiedDiff: diff.unifiedDiff,
        compactHunks: diff.hunksText,
      });
    }
  }
  return touched;
}

export function applyPatch(patchText, options) {
  return applyCodexPatch(patchText, options);
}

// ---- 3. Codex Command Canonicalization & Approval Prefix Cache ----

const COMPOUND_SHELL_RE = /[;&|><`\r\n]|\$\(|@\(|<\(|>\(/;
const DOUBLE_QUOTE_SUBST_RE = /`|\$\(/;

const DISALLOWED_SESSION_PREFIX_HEADS = new Set([
  'node',
  'python',
  'python3',
  'py',
  'ruby',
  'perl',
  'php',
  'lua',
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'fish',
  'pwsh',
  'powershell',
  'cmd',
  'curl',
  'wget',
  'eval',
  'exec',
  'env',
  'sudo',
  'doas',
]);

/**
 * Checks whether a shell command contains unquoted compound operators (;, &, |, >, <, newline)
 * or command substitution (`...`, $(...)) outside single quotes.
 * Never allows backslash (`\`) outside quotes to hide shell operators (Windows PowerShell treats `\` literally).
 */
function hasCompoundShellOperators(cmd) {
  let inSingle = false;
  let inDouble = false;
  let unquoted = '';
  let doubleInner = '';
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < cmd.length) {
        const nextCh = cmd[i + 1];
        if (nextCh === '`' || nextCh === '$' || nextCh === '\r' || nextCh === '\n') return true;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        if (DOUBLE_QUOTE_SUBST_RE.test(doubleInner)) return true;
        doubleInner = '';
      } else {
        doubleInner += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      doubleInner = '';
      continue;
    }
    unquoted += ch;
  }
  if (inSingle || inDouble) return true;
  return COMPOUND_SHELL_RE.test(unquoted);
}

/**
 * Safely strips a shell wrapper (`bash -lc "..."`, `sh -c '...'`, `pwsh -Command "..."`) ONLY when
 * the entire argument after the flag is a single balanced quoted string with no trailing tokens.
 */
function unwrapSingleQuotedShellWrapper(cmd) {
  const headMatch =
    /^(?:(?:\/[\w/.-]+\/)?(?:sh|bash|zsh|pwsh|powershell(?:\.exe)?))\s+(?:-[a-zA-Z]+\s+)*(?:-c|-lc|-Command)\s+(['"])([\s\S]+)\1$/i.exec(
      cmd,
    );
  if (!headMatch) return cmd;
  const quote = headMatch[1];
  const inner = headMatch[2];
  // Ensure the opening quote is ONLY closed at EOF (rejects `sh -c "npm test "; whoami; echo "ok"`)
  for (let i = 0; i < inner.length; i++) {
    if (quote === '"' && inner[i] === '\\' && i + 1 < inner.length) {
      i++;
      continue;
    }
    if (inner[i] === quote) {
      return null;
    }
  }
  return inner.trim();
}

/**
 * Strips common shell wrappers and produces a canonical command prefix suitable for
 * session-level "Always Allow Prefix" caching (e.g. `npm test`, `git diff`, `pytest`).
 * Returns null for compound/piped/redirected commands, raw interpreters/shells, and dangerous git flags!
 */
export function canonicalizeCommandPrefix(rawCommand) {
  const original = String(rawCommand ?? '').trim();
  if (!original) return null;

  // CRITICAL: Check compound/chaining operators BEFORE stripping any shell wrapper
  if (hasCompoundShellOperators(original)) return null;

  const cmd = unwrapSingleQuotedShellWrapper(original);
  if (!cmd) return null;

  if (hasCompoundShellOperators(cmd)) return null;
  const tokens = cmd.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  const head = tokens[0].split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  if (DISALLOWED_SESSION_PREFIX_HEADS.has(head)) {
    return null;
  }

  // Disallow git global config/exec override flags from session-prefix caching
  if (head === 'git') {
    for (const tok of tokens.slice(1)) {
      const f = tok.split('=')[0];
      const lf = f.toLowerCase();
      if (
        f === '-c' ||
        f === '-C' ||
        (!tok.startsWith('--') && (tok.startsWith('-c') || tok.startsWith('-C'))) ||
        lf === '--config-env' ||
        lf === '--exec-path' ||
        lf === '--git-dir' ||
        lf === '--work-tree' ||
        lf === '--upload-pack' ||
        lf === '--receive-pack'
      ) {
        return null;
      }
    }
  }

  const sub = tokens[1] && !tokens[1].startsWith('-') ? tokens[1].toLowerCase() : null;
  // Two-token prefix for subcommand CLIs (npm test, git commit, cargo build, ...)
  const multiWordHeads = new Set([
    'npm',
    'pnpm',
    'yarn',
    'npx',
    'git',
    'cargo',
    'go',
    'docker',
    'kubectl',
    'uv',
    'pip',
    'poetry',
    'dotnet',
  ]);
  if (multiWordHeads.has(head)) {
    if (!sub) return null;
    if (head === 'npx' || (head === 'npm' && sub === 'exec')) return null;
    return `${head} ${sub}`;
  }
  return head;
}

export function matchesApprovedPrefix(command, approvedPrefixes = []) {
  if (!approvedPrefixes?.length) return false;
  const prefix = canonicalizeCommandPrefix(command);
  if (!prefix) return false;
  return approvedPrefixes.includes(prefix);
}

// ---- 4. Claude Code Fast Post-Edit Diagnostics & Structured `run_diagnostics` ----

export function runQuickDiagnostics(fullPath, relPath) {
  if (!existsSync(fullPath)) return { ok: true, summary: '' };
  const ext = extname(fullPath).toLowerCase();

  try {
    if (ext === '.json' || ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      const content = readFileSync(fullPath, 'utf8');
      const res = validateCodeSyntax(relPath || fullPath, content, { fullPath });
      if (!res.ok) {
        return {
          ok: false,
          summary: `\n[自动语法诊断 · ${relPath}]\n${res.file}:${res.line}: ${res.message}`.slice(0, 800),
        };
      }
      return { ok: true, summary: '' };
    }
  } catch (err) {
    return {
      ok: false,
      summary: `\n[自动语法诊断 · ${relPath}]\n${String(err?.message ?? err).slice(0, 600)}`,
    };
  }
  return { ok: true, summary: '' };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const DIAG_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'upstream',
  'var',
]);

function normalizeDiagnosticFile(rawFile, workspaceRoot) {
  let s = String(rawFile ?? '').trim().replace(/^file:\/\/\/?/i, '');
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(s)) {
    s = s.slice(1);
  }
  if (workspaceRoot && s) {
    try {
      const root = resolve(workspaceRoot);
      const abs = resolve(root, s);
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..')) return rel;
    } catch {
      // keep cleaned string
    }
  }
  return s.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isBlockedDiagnosticsRel(relPath) {
  const normRel = String(relPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  if (
    normRel === 'upstream' ||
    normRel.startsWith('upstream/') ||
    normRel === 'var' ||
    normRel.startsWith('var/') ||
    normRel === 'backend/var' ||
    normRel.startsWith('backend/var/')
  ) {
    return true;
  }
  const parts = String(relPath ?? '').split(/[\\/]/).filter(Boolean);
  return parts.some((seg) => {
    const norm = normalizeProtectedSegment(seg);
    return (
      norm === '.git' ||
      norm === 'upstream' ||
      norm === 'var' ||
      isProtectedPathSegment(seg) ||
      /^\.env(?:$|[._-])/i.test(norm) ||
      /\.(?:pem|key|pfx|p12|crt|der|sqlite(?:3)?|sqlite-wal|sqlite-shm)$/i.test(norm)
    );
  });
}

/**
 * Parses and deduplicates noisy compiler/linter/test-runner output (hundreds/thousands of lines)
 * into bounded structured diagnostics, failing tests, and compression statistics.
 */
export function parseAndCompressDiagnosticsOutput(
  rawOutput,
  { kind = 'auto', maxDiagnostics = 25, workspaceRoot = null } = {},
) {
  const cap = Math.max(1, Math.min(100, Math.trunc(Number(maxDiagnostics) || 25)));
  const cleaned = String(rawOutput ?? '').replace(ANSI_RE, '').replace(/\r\n/g, '\n');
  if (!cleaned.trim()) {
    return {
      ok: true,
      kind,
      diagnostics: [],
      failingTests: [],
      compression: { rawLines: 0, keptLines: 0, truncatedCount: 0 },
    };
  }

  const lines = cleaned.split('\n');
  const rawLines = lines.length;
  const diagMap = new Map();
  const testMap = new Map();

  const addDiag = (entry) => {
    const file = normalizeDiagnosticFile(entry.file || '.', workspaceRoot);
    const line = Math.max(1, Math.trunc(Number(entry.line) || 1));
    const column = Math.max(1, Math.trunc(Number(entry.column) || 1));
    const severity = entry.severity || 'error';
    const code = String(entry.code || 'DIAGNOSTIC').trim();
    const message = String(entry.message || '').trim().slice(0, 320);
    if (!message) return;
    const key = `${file}:${line}:${column}:${severity}:${code}:${message}`;
    if (!diagMap.has(key) && diagMap.size < cap) {
      diagMap.set(key, { file, line, column, severity, code, message });
    }
  };

  const addFailingTest = (entry) => {
    const name = String(entry.name || 'unnamed test').trim().slice(0, 200);
    const file = entry.file ? normalizeDiagnosticFile(entry.file, workspaceRoot) : '';
    const assertion = String(entry.assertion || 'test failed').trim().slice(0, 320);
    const key = name.toLowerCase();
    const existing = testMap.get(key);
    if (existing) {
      if (!existing.file && file) existing.file = file;
      if (existing.assertion === 'test failed' && assertion && assertion !== 'test failed') {
        existing.assertion = assertion;
      }
      return;
    }
    if (testMap.size < cap) {
      testMap.set(key, { name, file, assertion });
    }
  };

  let pendingTest = null;
  const flushPendingTest = () => {
    if (!pendingTest) return;
    addFailingTest({
      name: pendingTest.name,
      file: pendingTest.file,
      assertion: pendingTest.assertions.join(' | ') || 'test failed',
    });
    pendingTest = null;
  };

  const tscParenRe = /^(.+?)\((\d+),(\d+)\):\s*(error|warning|info)\s+(TS\d+):\s*(.+)$/i;
  const tscColonRe = /^(.+?):(\d+):(\d+)\s*-\s*(error|warning|info)\s+(TS\d+):\s*(.+)$/i;
  const genericColonRe = /^((?:[A-Za-z]:)?[^:\r\n]+?):(\d+)(?::(\d+))?:\s*(?:(error|warning|info)\b[:\s]*)?(?:\[([^\]]+)\]\s*)?(.+)$/i;
  const bareLocRe = /^((?:[A-Za-z]:)?[^:\r\n]+?):(\d+)(?::(\d+))?$/;
  const specFailRe = /^\s*(?:✖|×|FAIL)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?m?s\))?$/;
  const tapFailRe = /^\s*not ok\s+\d+\s*-\s*(.+)$/;
  const stackLocRe = /\(?((?:file:\/\/\/|[A-Za-z]:[\\/]|[\w./\\-]+)[^():\s]+\.[cm]?[jt]sx?):(\d+)(?::(\d+))?\)?/;
  let pendingFileLoc = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Ignore passing noise, summary headings & TAP boilerplate
    if (
      /^(?:✔|✓|ok\s+\d+|#\s*(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms|Subtest)|TAP version|1\.\.\d+|---|(?:\.\.\.)$|(?:✖|×)\s*failing tests:\s*$)/i.test(
        trimmed,
      )
    ) {
      if (pendingTest && /^(?:✔|✓|ok\s+\d+|not ok|✖|×|#\s*(?:tests|fail)|\.\.\.$)/i.test(trimmed)) {
        flushPendingTest();
      }
      continue;
    }

    // 1. Failing test markers
    const specM = specFailRe.exec(line);
    const tapM = !specM ? tapFailRe.exec(line) : null;
    if (specM || tapM) {
      flushPendingTest();
      pendingTest = {
        name: (specM ? specM[1] : tapM[1]).trim(),
        file: '',
        assertions: [],
      };
      continue;
    }

    if (pendingTest) {
      const isCompilerOrSummary =
        /^(?:failing tests:|ℹ\s+)/i.test(trimmed) ||
        tscParenRe.test(trimmed) ||
        tscColonRe.test(trimmed);
      if (isCompilerOrSummary) {
        flushPendingTest();
      } else {
        const locM = stackLocRe.exec(trimmed);
        if (locM && !locM[1].startsWith('node:') && !locM[1].includes('node_modules')) {
          if (!pendingTest.file) pendingTest.file = locM[1];
        }
        if (/^(?:AssertionError|Error|TypeError|ReferenceError|SyntaxError|Expected|Actual|values|failed|err_|code:|error:)/i.test(trimmed) || trimmed.startsWith("'")) {
          if (pendingTest.assertions.length < 3) {
            pendingTest.assertions.push(trimmed);
          }
        }
        if (/^at\s+test\s+at\s+/i.test(trimmed) || /^test at\s+/i.test(trimmed)) {
          const tLoc = stackLocRe.exec(trimmed);
          if (tLoc && !pendingTest.file) pendingTest.file = tLoc[1];
        }
        continue;
      }
    }

    if (/^test at\s+/i.test(trimmed)) {
      const locM = stackLocRe.exec(trimmed);
      const nextLine = (lines[i + 1] ?? '').trim();
      const nameM = /^(?:✖|×)\s*(.+?)(?:\s+\(\d+(?:\.\d+)?m?s\))?$/.exec(nextLine);
      if (locM && nameM) {
        pendingTest = {
          name: nameM[1].trim(),
          file: locM[1],
          assertions: [],
        };
        i++;
        continue;
      }
    }

    // 2. TypeScript compiler diagnostics
    const tsM = tscParenRe.exec(trimmed) ?? tscColonRe.exec(trimmed);
    if (tsM) {
      addDiag({
        file: tsM[1],
        line: tsM[2],
        column: tsM[3],
        severity: tsM[4].toLowerCase(),
        code: tsM[5],
        message: tsM[6],
      });
      continue;
    }

    // 3. Generic file:line[:col] diagnostics (ESLint, Node check, Rust/Go/etc.)
    const genM = genericColonRe.exec(trimmed);
    if (
      genM &&
      !/^https?$/i.test(genM[1]) &&
      !genM[1].startsWith('node:') &&
      !/^at\s+/i.test(genM[1]) &&
      !/^\d+$/.test(genM[1]) &&
      /[./\\]/.test(genM[1])
    ) {
      const nextTrimmed = (lines[i + 1] ?? '').trim();
      const synNext = /^((?:SyntaxError|ReferenceError|TypeError|Error):.+)$/.exec(nextTrimmed);
      addDiag({
        file: genM[1],
        line: genM[2],
        column: genM[3] || 1,
        severity: (genM[4] || 'error').toLowerCase(),
        code: genM[5] || (synNext ? 'SYNTAX_ERROR' : 'DIAGNOSTIC'),
        message: synNext ? synNext[1] : genM[6],
      });
      continue;
    }

    // 3b. Bare `file:line[:col]` header (e.g. Node `--check`) before SyntaxError line
    const bareM = bareLocRe.exec(trimmed);
    if (bareM && /[./\\]/.test(bareM[1]) && !bareM[1].startsWith('node:')) {
      pendingFileLoc = {
        file: bareM[1],
        line: bareM[2],
        column: bareM[3] || 1,
      };
      continue;
    }

    // 4. Standalone `test at path:line:col` summary blocks
    if (trimmed.startsWith('test at ')) {
      const locM = stackLocRe.exec(trimmed);
      if (locM) {
        const nextLine = (lines[i + 1] ?? '').trim();
        const nameM = /^(?:✖|×)\s*(.+?)(?:\s+\(\d+(?:\.\d+)?m?s\))?$/.exec(nextLine);
        if (nameM) {
          addFailingTest({
            name: nameM[1],
            file: locM[1],
            assertion: (lines[i + 2] ?? '').trim() || 'test failed',
          });
        }
      }
      continue;
    }

    // 5. Fallback for explicit error lines when nothing else matched
    if (/^(?:SyntaxError|TypeError|ReferenceError|Error|ERR_[A-Z0-9_]+)\b/i.test(trimmed) && diagMap.size < cap) {
      addDiag({
        file: pendingFileLoc?.file || '.',
        line: pendingFileLoc?.line || 1,
        column: pendingFileLoc?.column || 1,
        severity: 'error',
        code: /^SyntaxError:/i.test(trimmed) ? 'SYNTAX_ERROR' : 'ERROR',
        message: trimmed,
      });
      pendingFileLoc = null;
    }
  }
  flushPendingTest();

  const diagnostics = [...diagMap.values()];
  const failingTests = [...testMap.values()];
  const keptLines = diagnostics.length + failingTests.length;
  const truncatedCount = Math.max(0, rawLines - keptLines);

  return {
    ok: diagnostics.filter((d) => d.severity === 'error').length === 0 && failingTests.length === 0,
    kind,
    diagnostics,
    failingTests,
    compression: {
      rawLines,
      keptLines,
      truncatedCount,
    },
  };
}

function collectDiagnosticFiles(workspaceRoot, rawPaths, extFilterSet) {
  const root = resolve(workspaceRoot);
  const files = [];
  const seen = new Set();

  const pushFile = (full, rel) => {
    if (isBlockedDiagnosticsRel(rel)) return;
    if (extFilterSet && !extFilterSet.has(extname(rel).toLowerCase())) return;
    const key = stateKeyFor(rel);
    if (!seen.has(key)) {
      seen.add(key);
      files.push({ full, rel });
    }
  };

  const walk = (dir, maxFiles = 500) => {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (files.length >= maxFiles) break;
      if (ent.isSymbolicLink()) continue;
      const lower = ent.name.toLowerCase();
      if (DIAG_SKIP_DIRS.has(lower) || isProtectedPathSegment(ent.name)) continue;
      const full = join(dir, ent.name);
      const rel = relative(root, full).replace(/\\/g, '/');
      if (isBlockedDiagnosticsRel(rel)) continue;
      if (ent.isDirectory()) walk(full, maxFiles);
      else if (ent.isFile()) pushFile(full, rel);
    }
  };

  if (Array.isArray(rawPaths) && rawPaths.length > 0) {
    const missing = [];
    for (const raw of rawPaths) {
      const confined = resolveConfinedPath(root, raw);
      if (isBlockedDiagnosticsRel(confined.rel)) {
        throw new Error(`受保护目录或密钥文件不允许访问: ${raw}`);
      }
      if (!existsSync(confined.full)) {
        missing.push(confined.rel);
        continue;
      }
      const st = statSync(confined.full);
      if (st.isDirectory()) {
        walk(confined.full, 500);
      } else if (st.isFile()) {
        pushFile(confined.full, confined.rel);
      }
    }
    return { files, missing };
  }

  walk(root, 500);
  return { files, missing: [] };
}

function findTsconfigAndTsc(workspaceRoot, targetFiles) {
  const root = resolve(workspaceRoot);
  const candidates = new Set([root]);
  for (const f of targetFiles) {
    let dir = dirname(f.full);
    while (dir.startsWith(root)) {
      candidates.add(dir);
      if (dir === root) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const dir of candidates) {
    const tsconfig = join(dir, 'tsconfig.json');
    const tscBin =
      [join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), join(root, 'node_modules', 'typescript', 'bin', 'tsc')].find(
        (p) => existsSync(p),
      ) ?? null;
    if (existsSync(tsconfig)) {
      return { tsconfig, tscBin, projectDir: dir };
    }
  }
  return { tsconfig: null, tscBin: null, projectDir: root };
}

export function runDiagnostics(
  workspaceRoot,
  { kind = 'auto', paths = [], testPattern = '', maxDiagnostics = 25 } = {},
) {
  const root = resolve(workspaceRoot);
  const requestedKind = ['auto', 'syntax', 'typecheck', 'test', 'lint'].includes(kind) ? kind : 'auto';
  const cap = Math.max(1, Math.min(100, Math.trunc(Number(maxDiagnostics) || 25)));
  const normPaths = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.trim()) : [];

  // Pre-validate every requested path against workspace confinement & blocked secrets
  for (const raw of normPaths) {
    const confined = resolveConfinedPath(root, raw);
    if (isBlockedDiagnosticsRel(confined.rel)) {
      throw new Error(`受保护目录或密钥文件不允许访问: ${raw}`);
    }
  }

  const allDiagnostics = [];
  const allFailingTests = [];
  const diagKeys = new Set();
  const testKeys = new Set();
  let totalRawLines = 0;
  let hadFailureExit = false;
  const notes = [];

  const pushDiag = (d) => {
    const key = `${d.file}:${d.line}:${d.column}:${d.severity}:${d.code}:${d.message}`;
    if (!diagKeys.has(key) && allDiagnostics.length < cap) {
      diagKeys.add(key);
      allDiagnostics.push(d);
    }
  };
  const pushTest = (t) => {
    const key = `${t.name}|${t.file}|${t.assertion}`;
    if (!testKeys.has(key) && allFailingTests.length < cap) {
      testKeys.add(key);
      allFailingTests.push(t);
    }
  };

  const runSyntax = () => {
    const syntaxExts = new Set(['.js', '.mjs', '.cjs', '.json']);
    const { files, missing } = collectDiagnosticFiles(root, normPaths, syntaxExts);
    for (const m of missing) {
      totalRawLines++;
      pushDiag({ file: m, line: 1, column: 1, severity: 'error', code: 'ENOENT', message: 'File not found' });
    }
    for (const f of files) {
      totalRawLines++;
      const res = validateCodeSyntax(f.rel, readFileSync(f.full, 'utf8'), {
        workspaceRoot: root,
        fullPath: f.full,
      });
      if (!res.ok) {
        totalRawLines += 2;
        pushDiag({
          file: res.file,
          line: res.line,
          column: res.column,
          severity: 'error',
          code: res.code,
          message: res.message,
        });
      }
    }
    notes.push(`syntax:${files.length} files`);
  };

  const runTypecheck = () => {
    const { files } = collectDiagnosticFiles(root, normPaths, null);
    const { tsconfig, tscBin, projectDir } = findTsconfigAndTsc(root, files);
    if (!tsconfig || !tscBin) {
      notes.push(`typecheck:skipped(${!tsconfig ? 'no tsconfig.json' : 'tsc unavailable'})`);
      return;
    }
    const res = spawnSync(process.execPath, [tscBin, '--noEmit', '--pretty', 'false', '-p', tsconfig], {
      cwd: projectDir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 25000,
      env: sanitizeChildEnv(process.env),
    });
    const combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
    const parsed = parseAndCompressDiagnosticsOutput(combined, {
      kind: 'typecheck',
      maxDiagnostics: cap,
      workspaceRoot: root,
    });
    totalRawLines += parsed.compression.rawLines;
    for (const d of parsed.diagnostics) pushDiag(d);
    if (res.status !== 0 && parsed.diagnostics.length === 0) {
      hadFailureExit = true;
      pushDiag({
        file: relative(root, tsconfig).replace(/\\/g, '/') || 'tsconfig.json',
        line: 1,
        column: 1,
        severity: 'error',
        code: 'TYPECHECK_ERROR',
        message: combined.trim().slice(0, 320) || `tsc exited with status ${res.status}`,
      });
    }
    notes.push(`typecheck:${res.status === 0 ? 'ok' : 'failed'}`);
  };

  const runTests = () => {
    const testExts = new Set(['.js', '.mjs', '.cjs']);
    const { files, missing } = collectDiagnosticFiles(root, normPaths, testExts);
    for (const m of missing) {
      totalRawLines++;
      pushDiag({ file: m, line: 1, column: 1, severity: 'error', code: 'ENOENT', message: 'Test file not found' });
    }
    const testTargets = normPaths.length
      ? files.map((f) => f.rel)
      : files.filter((f) => /\.(?:test|spec)\.[cm]?js$/i.test(f.rel) || /(?:^|\/)tests?\//i.test(f.rel)).map((f) => f.rel);
    if (!testTargets.length) {
      notes.push('test:none');
      return;
    }
    const args = ['--test', '--test-reporter=spec'];
    if (testPattern && String(testPattern).trim()) {
      args.push('--test-name-pattern', String(testPattern).trim());
    }
    args.push(...testTargets);
    const childTestEnv = sanitizeChildEnv(process.env);
    delete childTestEnv.NODE_TEST_CONTEXT;
    delete childTestEnv.NODE_TEST_WORKER_ID;
    const res = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      env: childTestEnv,
    });
    const combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
    const parsed = parseAndCompressDiagnosticsOutput(combined, {
      kind: 'test',
      maxDiagnostics: cap,
      workspaceRoot: root,
    });
    totalRawLines += parsed.compression.rawLines;
    for (const d of parsed.diagnostics) pushDiag(d);
    for (const t of parsed.failingTests) pushTest(t);
    if (res.status !== 0 && parsed.failingTests.length === 0 && parsed.diagnostics.length === 0) {
      hadFailureExit = true;
      pushTest({
        name: testTargets[0] || 'node --test',
        file: testTargets[0] || '',
        assertion: combined.trim().slice(0, 320) || `node --test exited with status ${res.status}`,
      });
    }
    notes.push(`test:${testTargets.length} files (${res.status === 0 ? 'pass' : 'fail'})`);
  };

  const runLint = () => {
    const eslintBin = join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
    if (existsSync(eslintBin)) {
      const targetArgs = normPaths.length
        ? collectDiagnosticFiles(root, normPaths, null).files.map((f) => f.rel)
        : ['.'];
      if (targetArgs.length) {
        const res = spawnSync(process.execPath, [eslintBin, '--format', 'unix', ...targetArgs], {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 25000,
          env: sanitizeChildEnv(process.env),
        });
        const combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
        const parsed = parseAndCompressDiagnosticsOutput(combined, {
          kind: 'lint',
          maxDiagnostics: cap,
          workspaceRoot: root,
        });
        totalRawLines += parsed.compression.rawLines;
        for (const d of parsed.diagnostics) pushDiag(d);
        if (res.status !== 0 && parsed.diagnostics.length === 0) {
          hadFailureExit = true;
        }
        notes.push(`lint:eslint(${res.status === 0 ? 'ok' : 'issues'})`);
        return;
      }
    }
    runSyntax();
  };

  if (requestedKind === 'syntax') {
    runSyntax();
  } else if (requestedKind === 'typecheck') {
    runTypecheck();
  } else if (requestedKind === 'test') {
    runTests();
  } else if (requestedKind === 'lint') {
    runLint();
  } else {
    runSyntax();
    const { files } = collectDiagnosticFiles(root, normPaths, null);
    const { tsconfig, tscBin } = findTsconfigAndTsc(root, files);
    if (tsconfig && tscBin) {
      runTypecheck();
    }
    const onlyTestsTargeted =
      normPaths.length > 0 &&
      files.length > 0 &&
      files.every((f) => /\.(?:test|spec)\.[cm]?js$/i.test(f.rel));
    if ((testPattern && String(testPattern).trim()) || onlyTestsTargeted) {
      runTests();
    }
  }

  const keptLines = allDiagnostics.length + allFailingTests.length;
  const truncatedCount = Math.max(0, totalRawLines - keptLines);
  const ok =
    !hadFailureExit &&
    allDiagnostics.filter((d) => d.severity === 'error').length === 0 &&
    allFailingTests.length === 0;

  const summaryParts = [
    `[run_diagnostics kind=${requestedKind} ok=${ok}] ${notes.join(', ') || 'checked'} | diagnostics=${allDiagnostics.length} failingTests=${allFailingTests.length} (rawLines=${totalRawLines} -> keptLines=${keptLines}, truncated=${truncatedCount})`,
  ];
  for (const d of allDiagnostics.slice(0, 8)) {
    summaryParts.push(`- ${d.file}:${d.line}:${d.column} [${d.severity} ${d.code}] ${d.message}`);
  }
  for (const t of allFailingTests.slice(0, 5)) {
    summaryParts.push(`- FAIL ${t.name}${t.file ? ` (${t.file})` : ''}: ${t.assertion}`);
  }

  return {
    ok,
    kind: requestedKind,
    diagnostics: allDiagnostics,
    failingTests: allFailingTests,
    compression: {
      rawLines: totalRawLines,
      keptLines,
      truncatedCount,
    },
    summary: summaryParts.join('\n'),
  };
}

// ---- 5. Agnes + Codex Read-Parallel / Write-Barrier Batch Scheduler ----

/**
 * Executes a turn's tool calls with read-only concurrency and sequential write barriers,
 * returning results in exact original call order!
 */
export async function scheduleToolBatch(calls, isReadOnlyFn, executeOneFn) {
  const results = new Array(calls.length);
  const maxParallelReads = 4;
  let i = 0;
  while (i < calls.length) {
    if (!isReadOnlyFn(calls[i])) {
      results[i] = await executeOneFn(calls[i]);
      i++;
      continue;
    }

    let end = i + 1;
    while (end < calls.length && isReadOnlyFn(calls[end])) end++;
    let stopped = false;
    let failure;
    const worker = async () => {
      while (!stopped && i < end) {
        const index = i++;
        try {
          results[index] = await executeOneFn(calls[index]);
        } catch (err) {
          if (!stopped) failure = err;
          stopped = true;
        }
      }
    };
    // A fatal dispatch exception stops admissions, but drain in-flight calls so a
    // turn cannot settle or cross a write barrier with sibling dispatch still active.
    await Promise.all(Array.from({ length: Math.min(maxParallelReads, end - i) }, worker));
    if (stopped) throw failure;
  }
  return results;
}
