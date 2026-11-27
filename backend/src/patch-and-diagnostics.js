import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const PY_AST_CHECK_SCRIPT = [
  'import ast, json, sys',
  'src = sys.stdin.buffer.read()',
  'fn = sys.argv[1] if len(sys.argv) > 1 else "<string>"',
  'try:',
  '    ast.parse(src, filename=fn)',
  'except (SyntaxError, ValueError) as e:',
  '    print(json.dumps({"type": type(e).__name__, "line": getattr(e, "lineno", None) or 1, "column": getattr(e, "offset", None) or 1, "message": getattr(e, "msg", None) or str(e)}))',
  '    sys.exit(1)',
].join('\n');

function pythonSyntaxErrorCode(errType) {
  if (errType === 'IndentationError') return 'INDENTATION_ERROR';
  if (errType === 'TabError') return 'TAB_ERROR';
  return 'SYNTAX_ERROR';
}

/**
 * Validates JS/MJS/CJS/JSON/Python syntax purely from in-memory content before touching disk.
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

  if (ext === '.py') {
    const py = resolvePythonRunner();
    if (!py) return { ok: true };
    const res = spawnSync(
      py.command,
      [...py.prefixArgs, '-I', '-c', PY_AST_CHECK_SCRIPT, relPath || '<string>'],
      {
        input: text,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: 3000,
        env: sanitizeChildEnv(process.env),
      },
    );
    if (!res.error && res.status === 0) return { ok: true };
    const stdoutTrim = String(res.stdout ?? '').trim();
    if (stdoutTrim.startsWith('{')) {
      try {
        const info = JSON.parse(stdoutTrim);
        const errType = String(info.type || 'SyntaxError');
        return {
          ok: false,
          file: relPath,
          line: Math.max(1, Math.trunc(Number(info.line) || 1)),
          column: Math.max(1, Math.trunc(Number(info.column) || 1)),
          code: pythonSyntaxErrorCode(errType),
          message: `${errType}: ${String(info.message || 'invalid syntax')}`,
        };
      } catch {
        // fall through to text parser
      }
    }
    const combined = `${res.stderr ?? ''}\n${res.stdout ?? ''}`.trim();
    const lineM = /line\s+(\d+)/i.exec(combined);
    const errM = /((?:IndentationError|TabError|SyntaxError|ValueError):[^\n]+)/.exec(combined);
    const errType = errM ? errM[1].split(':')[0].trim() : 'SyntaxError';
    return {
      ok: false,
      file: relPath,
      line: lineM ? Math.max(1, Math.trunc(Number(lineM[1]) || 1)) : 1,
      column: 1,
      code: pythonSyntaxErrorCode(errType),
      message: errM
        ? errM[1].trim()
        : combined.slice(0, 320) || String(res.error?.message ?? 'SyntaxError: invalid syntax'),
    };
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
    if (ext === '.json' || ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.py') {
      const content = readFileSync(fullPath, 'utf8');
      const res = validateCodeSyntax(relPath || fullPath, content, { fullPath });
      if (!res.ok) {
        return {
          ok: false,
          summary: `\n[自动语法诊断 · ${relPath}]\n${res.file}:${res.line}:${res.column}: ${res.message}`.slice(0, 800),
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

function realpathNativeSafe(targetPath) {
  const abs = resolve(targetPath);
  const realFn = realpathSync.native ?? realpathSync;
  try {
    return realFn(abs);
  } catch {
    let cur = abs;
    while (!existsSync(cur)) {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      cur = parent;
    }
    try {
      const realAnc = realFn(cur);
      const suffix = relative(cur, abs);
      return suffix ? resolve(realAnc, suffix) : realAnc;
    } catch {
      return abs;
    }
  }
}

export function normalizeDiagnosticFile(rawFile, workspaceRoot, baseDir = null) {
  const raw = String(rawFile ?? '').trim();
  let s = raw;
  if (/^file:\/\//i.test(raw)) {
    try {
      s = fileURLToPath(raw);
    } catch {
      const stripped = raw.replace(/^file:\/\//i, '');
      try {
        s = decodeURIComponent(stripped);
      } catch {
        s = stripped;
      }
    }
  }
  const isUnc = /^\\\\[^\\]/.test(s) || /^\/\/[^/]/.test(s);
  if (!isUnc) {
    s = s.replace(/\\\\/g, '\\').replace(/\/{2,}/g, '/');
  }
  if (/^\/[A-Za-z]:/.test(s)) {
    s = s.slice(1);
  }
  if (workspaceRoot && s) {
    try {
      const root = resolve(workspaceRoot);
      const anchor = baseDir ? resolve(baseDir) : root;
      const abs = isAbsolute(s) ? resolve(s) : resolve(anchor, s);
      let rel = relative(root, abs).replace(/\\/g, '/');
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        const realRoot = realpathNativeSafe(root);
        const realAbs = realpathNativeSafe(abs);
        rel = relative(realRoot, realAbs).replace(/\\/g, '/');
      }
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
    } catch {
      // keep cleaned string
    }
  }
  const normalized = s.replace(/\\/g, '/').replace(/^\.\//, '');
  return isUnc ? normalized : normalized.replace(/\/{2,}/g, '/');
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

function extractStackLocation(line) {
  const s = String(line ?? '');
  const patterns = [
    /\(((?:file:\/\/\/?)?[^()\r\n]+?\.[cm]?[jt]sx?):(\d+)(?::(\d+))?\)/i,
    /((?:file:\/\/\/?|[A-Za-z]:[\\/]|[\w./\\-]+)[^():\s\r\n]*?\.[cm]?[jt]sx?):(\d+)(?::(\d+))?/i,
  ];
  for (const rx of patterns) {
    const m = rx.exec(s);
    if (!m) continue;
    const raw = m[1];
    if (
      !raw ||
      raw.startsWith('node:') ||
      /(?:^|[\\/])node_modules(?:[\\/]|$)/i.test(raw)
    ) {
      continue;
    }
    return {
      file: raw,
      line: Math.max(1, Math.trunc(Number(m[2]) || 1)),
      column: Math.max(1, Math.trunc(Number(m[3]) || 1)),
    };
  }
  return null;
}

function normalizeParsedValue(raw, { yamlStyle = false } = {}) {
  if (raw === undefined || raw === null) return undefined;
  let s = String(raw).trim();
  if (!yamlStyle) {
    s = s.replace(/,\s*$/, '').trim();
  }
  s = s.replace(/\s*\r?\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    const inner = s.slice(1, -1);
    s = yamlStyle
      ? inner.replace(/''/g, "'")
      : inner.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  } else if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') s = parsed;
    } catch {
      s = s.slice(1, -1);
    }
  }
  return s.slice(0, 240);
}

function isPythonStdlibOrRunnerFrame(rawFile, workspaceRoot = null, baseDir = null) {
  const raw = String(rawFile ?? '').trim();
  if (!raw || /^<[^>]+>$/.test(raw)) return true;
  const norm = raw.replace(/\\/g, '/');
  if (
    /(?:^|\/)(?:site-packages|dist-packages|_pytest|pluggy)(?:\/|$)/i.test(norm) ||
    /(?:^|\/)(?:\.?venv|virtualenv)(?:\/|$)/i.test(norm) ||
    /^[A-Za-z]:\/[^/]*Python[^/]*\/Lib\//i.test(norm) ||
    /\/lib\/python\d+(?:\.\d+)?\//i.test(norm) ||
    /(?:^|\/)Lib\/(?:unittest|importlib|ast\.py|runpy\.py)/i.test(norm)
  ) {
    return true;
  }
  if (workspaceRoot) {
    try {
      const root = resolve(workspaceRoot);
      const anchor = baseDir ? resolve(baseDir) : root;
      const abs = isAbsolute(raw) ? resolve(raw) : resolve(anchor, raw);
      const rel = relative(root, abs);
      if (rel.startsWith('..') || isAbsolute(rel)) return true;
    } catch {
      // keep heuristic
    }
  }
  return false;
}

/**
 * Parses and deduplicates noisy compiler/linter/test-runner output (hundreds/thousands of lines)
 * into bounded structured diagnostics, failing tests, and compression statistics.
 */
export function parseAndCompressDiagnosticsOutput(
  rawOutput,
  { kind = 'auto', maxDiagnostics = 25, workspaceRoot = null, baseDir = null, sourceHint = null } = {},
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
  const deferredTestDiagnostics = [];
  const pytestFailLookup = new Map();
  let hasStructuredNodeTestEvidence = false;
  let hasPytestSectionErrorDiag = false;

  const addDiag = (entry) => {
    const file = normalizeDiagnosticFile(entry.file || '.', workspaceRoot, baseDir);
    const line = Math.max(1, Math.trunc(Number(entry.line) || 1));
    const column = Math.max(1, Math.trunc(Number(entry.column) || 1));
    const severity = entry.severity || 'error';
    const code = String(entry.code || 'DIAGNOSTIC').trim();
    const message = String(entry.message || '').trim().slice(0, 320);
    const source = String(entry.source || 'diagnostic').trim();
    if (!message) return;
    const key = `${file}:${line}:${column}:${severity}:${code}:${message}`;
    if (!diagMap.has(key) && diagMap.size < cap) {
      diagMap.set(key, {
        file,
        line,
        column,
        severity,
        code,
        message,
        source,
        ...(entry.testName ? { testName: entry.testName } : {}),
        ...(entry.expected !== undefined ? { expected: entry.expected } : {}),
        ...(entry.actual !== undefined ? { actual: entry.actual } : {}),
        ...(entry.operator !== undefined ? { operator: entry.operator } : {}),
      });
    }
  };

  const addFailingTest = (entry) => {
    const testName = String(entry.testName || entry.name || 'unnamed test').trim().slice(0, 200);
    const file = entry.file ? normalizeDiagnosticFile(entry.file, workspaceRoot, baseDir) : '';
    const line = Math.max(1, Math.trunc(Number(entry.line) || 1));
    const column = Math.max(1, Math.trunc(Number(entry.column) || 1));
    const assertion = String(entry.assertion || 'test failed').trim().slice(0, 320);
    const code = entry.code ? String(entry.code).trim() : null;
    const expected = entry.expected !== undefined ? entry.expected : undefined;
    const actual = entry.actual !== undefined ? entry.actual : undefined;
    const operator = entry.operator !== undefined ? entry.operator : undefined;
    const diagSource = String(entry.source || 'node-test').trim();
    const key = `${testName.toLowerCase()}::${file}`;
    const existing = testMap.get(key) ?? testMap.get(testName.toLowerCase());
    if (existing) {
      if (!existing.file && file) {
        existing.file = file;
        existing.line = line;
        existing.column = column;
      } else if (entry.fromStack && !existing._fromStack && file) {
        existing.file = file;
        existing.line = line;
        existing.column = column;
        existing._fromStack = true;
      }
      if (existing.assertion === 'test failed' && assertion && assertion !== 'test failed') {
        existing.assertion = assertion;
      }
      if (code && !existing.code) existing.code = code;
      if (expected !== undefined && existing.expected === undefined) existing.expected = expected;
      if (actual !== undefined && existing.actual === undefined) existing.actual = actual;
      if (operator !== undefined && existing.operator === undefined) existing.operator = operator;
      return existing;
    }
    if (testMap.size < cap) {
      const record = {
        name: testName,
        testName,
        file,
        line,
        column,
        assertion,
        ...(code ? { code } : {}),
        ...(expected !== undefined ? { expected } : {}),
        ...(actual !== undefined ? { actual } : {}),
        ...(operator !== undefined ? { operator } : {}),
        _fromStack: Boolean(entry.fromStack),
      };
      testMap.set(key, record);
      let deferredDiag = null;
      if (entry.emitDiagnostic) {
        deferredDiag = {
          file: file || '.',
          line,
          column,
          severity: 'error',
          code: code || (operator ? 'ERR_ASSERTION' : 'ERR_TEST_FAILURE'),
          message: `[${testName}] ${assertion}`.slice(0, 320),
          source: diagSource,
          testName,
          ...(expected !== undefined ? { expected } : {}),
          ...(actual !== undefined ? { actual } : {}),
          ...(operator !== undefined ? { operator } : {}),
          _structured: Boolean(entry.hasStructuredEvidence),
        };
        deferredTestDiagnostics.push(deferredDiag);
      }
      return { record, deferredDiag, mapKey: key };
    }
    return null;
  };

  let inSpecFailuresSection = false;
  let pendingDeclLoc = null;
  let pendingTest = null;
  let pendingTap = null;
  let pendingPytest = null;
  let pendingUnittest = null;
  let pytestSection = null;
  const summaryOnlyFails = [];
  let detailedFailureCount = 0;

  const trackFailingTest = (entry) => {
    const beforeSize = testMap.size;
    const beforeDiagLen = deferredTestDiagnostics.length;
    const res = addFailingTest(entry);
    if (res && typeof res === 'object' && 'record' in res) return res;
    if (testMap.size === beforeSize && entry.testName) {
      const file = entry.file ? normalizeDiagnosticFile(entry.file, workspaceRoot, baseDir) : '';
      const key = `${String(entry.testName).toLowerCase()}::${file}`;
      const record = testMap.get(key) ?? testMap.get(String(entry.testName).toLowerCase());
      const deferredDiag =
        deferredTestDiagnostics.length > beforeDiagLen ? deferredTestDiagnostics.at(-1) : null;
      return record ? { record, deferredDiag } : null;
    }
    return null;
  };

  const classifyPythonErrorCode = (headline, isErrorBlock = false) => {
    const h = String(headline ?? '');
    if (/^IndentationError(?::|$)/i.test(h)) return 'INDENTATION_ERROR';
    if (/^TabError(?::|$)/i.test(h)) return 'TAB_ERROR';
    if (/^SyntaxError(?::|$)/i.test(h)) return 'SYNTAX_ERROR';
    if (/^(?:ModuleNotFoundError|ImportError)(?::|$)/i.test(h)) return 'IMPORT_ERROR';
    if (/^(?:assert\b|AssertionError(?::|$))/i.test(h)) return 'ERR_ASSERTION';
    return isErrorBlock ? 'COLLECTION_ERROR' : 'ERR_TEST_FAILURE';
  };

  const flushPendingPytest = () => {
    if (!pendingPytest) return;
    const pp = pendingPytest;
    pendingPytest = null;
    let loc = pp.userLoc ?? pp.fallbackLoc ?? { file: '', line: 1, column: 1 };
    if (!loc.file && /^ERROR\s+collecting\s+(.+)$/i.test(pp.headerName)) {
      const target = /^ERROR\s+collecting\s+(.+)$/i.exec(pp.headerName)?.[1]?.trim();
      if (target && !/^test session$/i.test(target)) {
        loc = { file: target, line: 1, column: 1 };
      }
    }
    const normFile = loc.file ? normalizeDiagnosticFile(loc.file, workspaceRoot, baseDir) : '';
    const headline = pp.errLine || pp.eLines.join(' | ') || pp.headerName || 'pytest failure';
    const code = classifyPythonErrorCode(headline, pp.isErrorBlock);
    const source = sourceHint || 'pytest';
    if (pp.isErrorBlock) {
      hasPytestSectionErrorDiag = true;
      addDiag({
        file: normFile || '.',
        line: loc.line,
        column: loc.column,
        severity: 'error',
        code,
        message: headline,
        source,
      });
      return;
    }
    detailedFailureCount++;
    const initialName = normFile ? `${normFile}::${pp.headerName}` : pp.headerName;
    const tracked = trackFailingTest({
      testName: initialName,
      file: normFile,
      line: loc.line,
      column: loc.column,
      fromStack: true,
      assertion: headline,
      code,
      source,
      emitDiagnostic: true,
      hasStructuredEvidence: true,
    });
    if (tracked?.record) {
      const shortKey = pp.headerName.toLowerCase();
      if (normFile) pytestFailLookup.set(`${normFile}::${shortKey}`, tracked);
      if (!pytestFailLookup.has(shortKey)) pytestFailLookup.set(shortKey, tracked);
    }
  };

  const flushPendingUnittest = () => {
    if (!pendingUnittest) return;
    const pu = pendingUnittest;
    pendingUnittest = null;
    const loc = pu.userLoc ?? pu.fallbackLoc ?? { file: '', line: 1, column: 1 };
    const headline = pu.errLines.at(-1) || `${pu.kind}: ${pu.fullName}`;
    const code = classifyPythonErrorCode(headline, false);
    detailedFailureCount++;
    addFailingTest({
      testName: pu.fullName,
      file: loc.file,
      line: loc.line,
      column: loc.column,
      fromStack: Boolean(pu.userLoc || pu.fallbackLoc),
      assertion: headline,
      code,
      source: sourceHint || 'unittest',
      emitDiagnostic: true,
      hasStructuredEvidence: true,
    });
  };

  const finalizeInspectProp = (pt) => {
    if (!pt || !pt.inspectProp) return;
    const raw = pt.inspectBuf.join('\n');
    const val = normalizeParsedValue(raw, { yamlStyle: false });
    if (pt.inspectProp === 'code' && val) pt.code = val;
    else if (pt.inspectProp === 'operator' && val !== undefined) {
      pt.operator = val;
      pt.hasStructuredEvidence = true;
    } else if (pt.inspectProp === 'actual' && val !== undefined) {
      pt.actual = val;
      pt.hasStructuredEvidence = true;
    } else if (pt.inspectProp === 'expected' && val !== undefined) {
      pt.expected = val;
      pt.hasStructuredEvidence = true;
    }
    pt.inspectProp = null;
    pt.inspectBuf = [];
  };

  const flushPendingTest = () => {
    if (!pendingTest) return;
    finalizeInspectProp(pendingTest);
    const pt = pendingTest;
    pendingTest = null;

    if (!pt.isDetailed) {
      summaryOnlyFails.push({ testName: pt.testName });
      return;
    }

    // Fallback inference for single-line `Expected values to be strictly equal: A !== B`
    const combinedAssertions = pt.assertions.join(' | ');
    if (
      pt.actual === undefined &&
      pt.expected === undefined &&
      /Expected values to be strictly equal/i.test(combinedAssertions)
    ) {
      const cmpM = /(\S+)\s*!==\s*(\S+)/.exec(combinedAssertions);
      if (cmpM) {
        pt.actual = normalizeParsedValue(cmpM[1], { yamlStyle: false });
        pt.expected = normalizeParsedValue(cmpM[2], { yamlStyle: false });
        if (!pt.operator) pt.operator = 'strictEqual';
      }
    }

    detailedFailureCount++;
    const loc = pt.stackLoc ?? pt.declLoc ?? { file: '', line: 1, column: 1 };
    addFailingTest({
      testName: pt.testName,
      file: loc.file,
      line: loc.line,
      column: loc.column,
      fromStack: Boolean(pt.stackLoc),
      assertion: combinedAssertions || 'test failed',
      code: pt.code,
      expected: pt.expected,
      actual: pt.actual,
      operator: pt.operator,
      emitDiagnostic: true,
      hasStructuredEvidence: pt.hasStructuredEvidence || hasStructuredNodeTestEvidence,
    });
  };

  const finalizeTapBlockProp = (tp) => {
    if (!tp || !tp.activeKey) return;
    const raw = tp.blockBuf.join('\n');
    if (tp.activeKey === 'error') {
      const firstLine = tp.blockBuf.map((l) => l.trim()).filter(Boolean).slice(0, 3);
      tp.errorLines.push(...firstLine);
    } else if (tp.activeKey === 'stack') {
      for (const sl of tp.blockBuf) {
        const loc = extractStackLocation(sl);
        if (loc && !tp.stackLoc) {
          tp.stackLoc = loc;
          break;
        }
      }
    } else if (tp.activeKey === 'expected') {
      tp.expected = normalizeParsedValue(raw, { yamlStyle: true });
    } else if (tp.activeKey === 'actual') {
      tp.actual = normalizeParsedValue(raw, { yamlStyle: true });
    }
    tp.activeKey = null;
    tp.blockBuf = [];
    tp.blockIndent = 0;
  };

  const flushPendingTap = () => {
    if (!pendingTap) return;
    finalizeTapBlockProp(pendingTap);
    const tp = pendingTap;
    pendingTap = null;
    if (tp.failureType === 'subtestsFailed' && detailedFailureCount > 0) {
      return;
    }
    detailedFailureCount++;
    const loc = tp.stackLoc ?? tp.declLoc ?? { file: '', line: 1, column: 1 };
    const headline =
      tp.name && tp.errorLines.length
        ? `${tp.name}${tp.code ? ` [${tp.code}]` : ''}: ${tp.errorLines.join(' | ')}`
        : tp.errorLines.join(' | ') || 'test failed';
    addFailingTest({
      testName: tp.testName,
      file: loc.file,
      line: loc.line,
      column: loc.column,
      fromStack: Boolean(tp.stackLoc),
      assertion: headline,
      code: tp.code,
      expected: tp.expected,
      actual: tp.actual,
      operator: tp.operator,
      emitDiagnostic: true,
      hasStructuredEvidence: true,
    });
  };

  const tscParenRe = /^(.+?)\((\d+),(\d+)\):\s*(error|warning|info)\s+(TS\d+):\s*(.+)$/i;
  const tscColonRe = /^(.+?):(\d+):(\d+)\s*-\s*(error|warning|info)\s+(TS\d+):\s*(.+)$/i;
  const genericColonRe = /^((?:[A-Za-z]:)?[^:\r\n]+?):(\d+)(?::(\d+))?:\s*(?:(error|warning|info)\b[:\s]*)?(?:\[([^\]]+)\]\s*)?(.+)$/i;
  const bareLocRe = /^((?:[A-Za-z]:)?[^:\r\n]+?):(\d+)(?::(\d+))?$/;
  const specFailRe = /^\s*(?:✖|×|FAIL)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?m?s\))?$/;
  const tapFailRe = /^\s*not ok\s+\d+\s*-\s*(.+)$/;
  const pytestBannerRe = /^={3,}\s*([A-Za-z ]+?)\s*={3,}$/;
  const pytestBlockHeaderRe = /^_{3,}\s+(.+?)\s+_{3,}$/;
  const pytestFrameRe = /^(.+?\.py):(\d+):\s*(?:in\s+(.+))?$/;
  const pyFileLineRe = /^(?:E\s+)?File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?$/;
  const pytestFailedSummaryRe = /^FAILED\s+(?!\()(.+?)(?:\s+-\s+(.+))?$/;
  const pytestErrorSummaryRe = /^ERROR(?:\s+(?!collecting\b)([^\s].*?))?(?:\s+-\s+(.+))?$/;
  const unittestHeaderRe = /^(FAIL|ERROR):\s+([^\s(]+)\s+\(([^)]+)\)\s*$/;
  const pyExceptionRe =
    /^((?:SyntaxError|IndentationError|TabError|ModuleNotFoundError|ImportError|AssertionError|NameError|TypeError|ValueError|RuntimeError|KeyError|IndexError|AttributeError|ZeroDivisionError|OSError|FileNotFoundError|[A-Z][A-Za-z0-9]*(?:Error|Exception))(?::.*)?)$/;
  let pendingFileLoc = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (pendingTap) {
      if (!pendingTap.inYaml) {
        if (trimmed === '---') {
          pendingTap.inYaml = true;
          continue;
        }
        flushPendingTap();
      } else {
        if (trimmed === '...') {
          flushPendingTap();
          continue;
        }
        const indent = line.length - line.trimStart().length;
        if (pendingTap.activeKey && (indent > pendingTap.blockIndent || !trimmed)) {
          if (trimmed) pendingTap.blockBuf.push(line);
          continue;
        }
        finalizeTapBlockProp(pendingTap);
        const kvM = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(trimmed);
        if (kvM) {
          const [, k, v] = kvM;
          if (v === '|-' || v === '|' || v === '') {
            pendingTap.activeKey = k;
            pendingTap.blockIndent = indent;
            pendingTap.blockBuf = [];
          } else {
            const val = normalizeParsedValue(v, { yamlStyle: true });
            if (k === 'location') {
              const loc = extractStackLocation(val);
              if (loc) pendingTap.declLoc = loc;
            } else if (k === 'failureType') {
              pendingTap.failureType = val;
            } else if (k === 'code') {
              pendingTap.code = val;
            } else if (k === 'name') {
              pendingTap.name = val;
            } else if (k === 'operator') {
              pendingTap.operator = val;
            } else if (k === 'expected') {
              pendingTap.expected = val;
            } else if (k === 'actual') {
              pendingTap.actual = val;
            } else if (k === 'error' && val) {
              pendingTap.errorLines.push(val);
            }
          }
        }
        continue;
      }
    }

    if (!trimmed) continue;

    // 0a. Pytest banners & section transitions
    const bannerM = pytestBannerRe.exec(trimmed);
    if (bannerM) {
      flushPendingTest();
      flushPendingPytest();
      flushPendingUnittest();
      const sec = bannerM[1].trim().toUpperCase();
      pytestSection = sec.includes('SHORT TEST SUMMARY') ? 'SUMMARY' : sec;
      continue;
    }

    if (/^={10,}$/.test(trimmed)) {
      flushPendingTest();
      flushPendingPytest();
      flushPendingUnittest();
      continue;
    }

    // 0b. Unittest block headers (`FAIL: test_x (pkg.Cls.test_x)` / `ERROR: ...`)
    const utM = unittestHeaderRe.exec(trimmed);
    if (utM) {
      flushPendingTest();
      flushPendingPytest();
      flushPendingUnittest();
      pendingUnittest = {
        kind: utM[1],
        methodName: utM[2],
        fullName: utM[3].trim(),
        userLoc: null,
        fallbackLoc: null,
        errLines: [],
      };
      continue;
    }

    // 0c. Pytest block headers (`___ test_name ___` / `___ ERROR collecting ... ___`)
    const pyBlockM = pytestBlockHeaderRe.exec(trimmed);
    if (pyBlockM) {
      flushPendingTest();
      flushPendingPytest();
      flushPendingUnittest();
      const headerName = pyBlockM[1].trim();
      pendingPytest = {
        section: pytestSection,
        headerName,
        isErrorBlock: pytestSection === 'ERRORS' || /^ERROR\b/i.test(headerName),
        userLoc: null,
        fallbackLoc: null,
        eLines: [],
        errLine: null,
      };
      continue;
    }

    if (pendingUnittest) {
      if (/^-{5,}$/.test(trimmed)) {
        if (pendingUnittest.errLines.length > 0 || pendingUnittest.userLoc || pendingUnittest.fallbackLoc) {
          // Could be bottom divider before `Ran N tests`
        }
        continue;
      }
      if (/^Ran\s+\d+\s+tests?\s+in\s+/i.test(trimmed)) {
        flushPendingUnittest();
        continue;
      }
      if (/^Traceback\s+\(most recent call last\):$/i.test(trimmed)) {
        continue;
      }
      const utFileM = pyFileLineRe.exec(trimmed);
      if (utFileM) {
        const rawFile = utFileM[1];
        const lineNo = Math.max(1, Math.trunc(Number(utFileM[2]) || 1));
        if (!isPythonStdlibOrRunnerFrame(rawFile, workspaceRoot, baseDir)) {
          if (!pendingUnittest.userLoc) {
            pendingUnittest.userLoc = { file: rawFile, line: lineNo, column: 1 };
          }
        } else if (!pendingUnittest.fallbackLoc) {
          pendingUnittest.fallbackLoc = { file: rawFile, line: lineNo, column: 1 };
        }
        continue;
      }
      if (pyExceptionRe.test(trimmed)) {
        pendingUnittest.errLines.push(trimmed);
      }
      continue;
    }

    if (pendingPytest) {
      if (
        /^!{3,}\s+Interrupted:/i.test(trimmed) ||
        /^\d+\s+(?:failed|passed|skipped|error|errors|deselected|xfailed|xpassed|warnings?)\b.*in\s+[\d.]+s$/i.test(
          trimmed,
        )
      ) {
        flushPendingPytest();
        continue;
      }
      if (/^Traceback:?$/i.test(trimmed) || /^Hint:\s+/i.test(trimmed)) {
        continue;
      }
      const pyFileM = pyFileLineRe.exec(trimmed);
      if (pyFileM) {
        const rawFile = pyFileM[1];
        const lineNo = Math.max(1, Math.trunc(Number(pyFileM[2]) || 1));
        if (!isPythonStdlibOrRunnerFrame(rawFile, workspaceRoot, baseDir)) {
          if (trimmed.startsWith('E') || !pendingPytest.userLoc) {
            pendingPytest.userLoc = { file: rawFile, line: lineNo, column: 1 };
          }
        } else if (!pendingPytest.fallbackLoc) {
          pendingPytest.fallbackLoc = { file: rawFile, line: lineNo, column: 1 };
        }
        continue;
      }
      const pyFrameM = pytestFrameRe.exec(trimmed);
      if (pyFrameM) {
        const rawFile = pyFrameM[1];
        const lineNo = Math.max(1, Math.trunc(Number(pyFrameM[2]) || 1));
        if (!isPythonStdlibOrRunnerFrame(rawFile, workspaceRoot, baseDir)) {
          if (!pendingPytest.userLoc) {
            pendingPytest.userLoc = { file: rawFile, line: lineNo, column: 1 };
          }
        } else if (!pendingPytest.fallbackLoc) {
          pendingPytest.fallbackLoc = { file: rawFile, line: lineNo, column: 1 };
        }
        continue;
      }
      const eLineM = /^\s*E\s+(.+)$/.exec(line);
      if (eLineM) {
        const inner = eLineM[1].trim();
        if (!inner || /^\^+$/.test(inner)) continue;
        if (pyExceptionRe.test(inner) || /^assert\s+/i.test(inner)) {
          pendingPytest.errLine = inner;
        }
        if (pendingPytest.eLines.length < 3 && !pendingPytest.eLines.includes(inner)) {
          pendingPytest.eLines.push(inner);
        }
        continue;
      }
      if (pyExceptionRe.test(trimmed)) {
        pendingPytest.errLine = trimmed;
        if (pendingPytest.eLines.length < 3) pendingPytest.eLines.push(trimmed);
      }
      continue;
    }

    // 0d. Pytest / Unittest summary & noise lines (before node-test specFailRe & genericColonRe)
    if (
      /^(?:[.FsExX]+(?:\s+\[\s*\d+%\])?|-{5,}|Ran\s+\d+\s+tests?\s+in\s+[\d.]+s|OK|NO TESTS RAN|FAILED\s+\([^)]+\)|!{3,}\s+Interrupted:.*|no tests ran in [\d.]+s|\d+\s+(?:failed|passed|skipped|error|errors|deselected|xfailed|xpassed|warnings?)\b.*in\s+[\d.]+s)$/i.test(
        trimmed,
      )
    ) {
      flushPendingTest();
      continue;
    }

    const ptFailedM = pytestFailedSummaryRe.exec(trimmed);
    if (ptFailedM) {
      flushPendingTest();
      const rawNode = ptFailedM[1].trim();
      const detail = (ptFailedM[2] ?? '').trim();
      const sepIdx = rawNode.indexOf('::');
      const rawFile = sepIdx >= 0 ? rawNode.slice(0, sepIdx) : '';
      const nodePart = sepIdx >= 0 ? rawNode.slice(sepIdx + 2) : rawNode;
      const normFile = rawFile ? normalizeDiagnosticFile(rawFile, workspaceRoot, baseDir) : '';
      const shortNorm = nodePart.replace(/::/g, '.').toLowerCase();
      const hit =
        (normFile ? pytestFailLookup.get(`${normFile}::${shortNorm}`) : null) ??
        pytestFailLookup.get(shortNorm) ??
        (normFile ? pytestFailLookup.get(`${normFile}::${nodePart.toLowerCase()}`) : null);
      if (hit) {
        const finalFile = hit.record.file || normFile;
        const finalName = finalFile ? `${finalFile}::${nodePart}` : rawNode;
        hit.record.name = finalName;
        hit.record.testName = finalName;
        if (!hit.record.file && normFile) hit.record.file = normFile;
        if (detail && hit.record.assertion === 'test failed') {
          hit.record.assertion = detail.slice(0, 320);
        }
        if (hit.deferredDiag) {
          hit.deferredDiag.testName = finalName;
          hit.deferredDiag.file = hit.record.file || '.';
          hit.deferredDiag.message = `[${finalName}] ${hit.record.assertion}`.slice(0, 320);
        }
      } else {
        const finalName = normFile ? `${normFile}::${nodePart}` : rawNode;
        addFailingTest({
          testName: finalName,
          file: normFile,
          line: 1,
          column: 1,
          assertion: detail || 'test failed',
          code: classifyPythonErrorCode(detail, false),
          source: sourceHint || 'pytest',
          emitDiagnostic: true,
          hasStructuredEvidence: true,
        });
      }
      continue;
    }

    if (!trimmed.startsWith('ERROR:')) {
      const ptErrM = pytestErrorSummaryRe.exec(trimmed);
      if (
        ptErrM &&
        (pytestSection === 'SUMMARY' ||
          pytestSection === 'ERRORS' ||
          sourceHint === 'pytest' ||
          /\.py(?:::\S+)?$/i.test((ptErrM[1] ?? '').trim()))
      ) {
        flushPendingTest();
        if (!hasPytestSectionErrorDiag) {
          const rawTarget = (ptErrM[1] ?? '').trim();
          const detail = (ptErrM[2] ?? '').trim();
          const filePart = rawTarget.includes('::') ? rawTarget.split('::')[0] : rawTarget;
          addDiag({
            file: filePart || '.',
            line: 1,
            column: 1,
            severity: 'error',
            code: classifyPythonErrorCode(detail, true),
            message: detail || (rawTarget ? `Collection error in ${rawTarget}` : 'Pytest collection error'),
            source: sourceHint || 'pytest',
          });
        }
        continue;
      }
    }

    if (/^(?:✖|×)\s*failing tests:\s*$/i.test(trimmed)) {
      flushPendingTest();
      inSpecFailuresSection = true;
      hasStructuredNodeTestEvidence = true;
      continue;
    }

    // Ignore passing noise, summary headings & TAP boilerplate
    if (
      /^(?:✔|✓|▶|ok\s+\d+|#\s*(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms|Subtest)|ℹ\s+(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b|TAP version|1\.\.\d+)$/i.test(
        trimmed,
      )
    ) {
      if (pendingTest) flushPendingTest();
      if (/^ℹ\s+(?:tests|fail)\b/i.test(trimmed) || /^TAP version/i.test(trimmed)) {
        hasStructuredNodeTestEvidence = true;
      }
      continue;
    }

    if (/^test at\s+/i.test(trimmed)) {
      flushPendingTest();
      hasStructuredNodeTestEvidence = true;
      const loc = extractStackLocation(trimmed);
      if (loc) pendingDeclLoc = loc;
      continue;
    }

    // 1. Failing test markers
    const specM = specFailRe.exec(line);
    const tapM = !specM ? tapFailRe.exec(line) : null;
    if (tapM) {
      flushPendingTest();
      hasStructuredNodeTestEvidence = true;
      pendingTap = {
        testName: tapM[1].trim(),
        declLoc: null,
        stackLoc: null,
        failureType: '',
        errorLines: [],
        code: null,
        name: null,
        expected: undefined,
        actual: undefined,
        operator: undefined,
        inYaml: false,
        activeKey: null,
        blockIndent: 0,
        blockBuf: [],
      };
      continue;
    }
    if (specM) {
      flushPendingTest();
      const declLoc = pendingDeclLoc;
      pendingDeclLoc = null;
      pendingTest = {
        testName: specM[1].trim(),
        declLoc,
        stackLoc: null,
        assertions: [],
        code: null,
        expected: undefined,
        actual: undefined,
        operator: undefined,
        isDetailed: Boolean(inSpecFailuresSection || declLoc),
        hasStructuredEvidence: Boolean(inSpecFailuresSection || declLoc),
        inInspectObj: false,
        inspectBraceDepth: 0,
        inspectProp: null,
        inspectBuf: [],
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
      } else if (pendingTest.inInspectObj) {
        if (trimmed === '}' && pendingTest.inspectBraceDepth <= 1) {
          finalizeInspectProp(pendingTest);
          pendingTest.inInspectObj = false;
          pendingTest.inspectBraceDepth = 0;
          flushPendingTest();
          continue;
        }
        if (/^\},?$/.test(trimmed) && pendingTest.inspectBraceDepth > 1) {
          pendingTest.inspectBraceDepth--;
          if (pendingTest.inspectProp) {
            pendingTest.inspectBuf.push(trimmed);
          }
          continue;
        }
        const propM =
          pendingTest.inspectBraceDepth === 1
            ? /^(generatedMessage|code|actual|expected|operator|diff|showDiff)\s*:\s*(.*)$/.exec(trimmed)
            : null;
        if (propM) {
          finalizeInspectProp(pendingTest);
          pendingTest.inspectProp = propM[1];
          const propValTrim = propM[2].trim();
          pendingTest.inspectBuf = propValTrim ? [propValTrim] : [];
          if (/^(?:.*[:=,\[])?\s*\{$/.test(propValTrim)) {
            pendingTest.inspectBraceDepth++;
          }
        } else {
          if (/(?:^|[:=,\[])\s*\{$/.test(trimmed)) {
            pendingTest.inspectBraceDepth++;
          }
          if (pendingTest.inspectProp) {
            pendingTest.inspectBuf.push(trimmed);
          }
        }
        continue;
      } else {
        const isErrLine =
          /^(?:AssertionError|Error|TypeError|ReferenceError|SyntaxError|RangeError|Expected|Actual|values|failed|err_|code:|error:|The input did not match|[+-]\s+actual)/i.test(
            trimmed,
          ) ||
          /^[+-]\s+/.test(trimmed) ||
          trimmed.startsWith("'") ||
          /\s!==\s/.test(trimmed);
        const loc = extractStackLocation(trimmed);
        if (loc || isErrLine || /^at\s+/.test(trimmed)) {
          pendingTest.isDetailed = true;
        }
        if (loc && !pendingTest.stackLoc) {
          pendingTest.stackLoc = loc;
        }
        const errCodeM = /\[([A-Z][A-Z0-9_]+)\]/.exec(trimmed);
        if (errCodeM && !pendingTest.code) {
          pendingTest.code = errCodeM[1];
        }
        if (isErrLine && pendingTest.assertions.length < 3) {
          pendingTest.assertions.push(trimmed);
        }
        if (/^at\s+.+\{\s*$/.test(trimmed) || (trimmed === '{' && Boolean(pendingTest.stackLoc))) {
          pendingTest.inInspectObj = true;
          pendingTest.inspectBraceDepth = 1;
        }
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
        source: 'tsc',
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
        source: synNext ? 'syntax' : kind === 'lint' ? 'eslint' : 'diagnostic',
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

    // 4. Fallback for explicit error lines when nothing else matched
    if (/^(?:SyntaxError|TypeError|ReferenceError|Error|ERR_[A-Z0-9_]+)\b/i.test(trimmed) && diagMap.size < cap) {
      addDiag({
        file: pendingFileLoc?.file || '.',
        line: pendingFileLoc?.line || 1,
        column: pendingFileLoc?.column || 1,
        severity: 'error',
        code: /^SyntaxError:/i.test(trimmed) ? 'SYNTAX_ERROR' : 'ERROR',
        message: trimmed,
        source: /^SyntaxError:/i.test(trimmed) ? 'syntax' : 'diagnostic',
      });
      pendingFileLoc = null;
    }
  }
  flushPendingTap();
  flushPendingTest();
  flushPendingPytest();
  flushPendingUnittest();

  if (testMap.size === 0 && summaryOnlyFails.length > 0) {
    for (const sf of summaryOnlyFails) {
      addFailingTest({
        testName: sf.testName,
        file: '',
        line: 1,
        column: 1,
        assertion: 'test failed',
        emitDiagnostic: true,
        hasStructuredEvidence: hasStructuredNodeTestEvidence,
      });
    }
  }

  for (const d of deferredTestDiagnostics) {
    if (kind === 'test' || diagMap.size === 0 || d._structured) {
      addDiag(d);
    }
  }

  const diagnostics = [...diagMap.values()];
  const failingTests = [...testMap.values()].map(({ _fromStack, ...rest }) => rest);
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

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const SAFE_CLI_ARG_RE = /^[^\r\n\0&|;<>^%!"]+$/;

function isNodeShebangScript(filePath) {
  try {
    const head = readFileSync(filePath, 'utf8').slice(0, 160);
    return /^#![^\n]*\bnode\b/i.test(head);
  } catch {
    return false;
  }
}

function isExecutableFile(filePath) {
  try {
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) return false;
    if (process.platform === 'win32') return true;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function makeRunnerFromBinPath(binPath) {
  if (!binPath || !existsSync(binPath)) return null;
  if (isNodeShebangScript(binPath)) {
    return { command: process.execPath, prefixArgs: [binPath], path: binPath };
  }
  if (process.platform === 'win32') {
    const lower = binPath.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      const siblingJs = [
        join(dirname(binPath), 'node_modules', 'typescript', 'bin', 'tsc'),
        join(dirname(binPath), '..', 'typescript', 'bin', 'tsc'),
      ].find((p) => existsSync(p));
      if (siblingJs) {
        return { command: process.execPath, prefixArgs: [siblingJs], path: siblingJs };
      }
      if (!SAFE_CLI_ARG_RE.test(binPath)) return null;
      return {
        command: process.env.ComSpec || 'cmd.exe',
        prefixArgs: ['/d', '/c', binPath],
        path: binPath,
        requiresSafeArgs: true,
      };
    }
    if (lower.endsWith('.exe')) {
      return { command: binPath, prefixArgs: [], path: binPath };
    }
    return null;
  }
  return isExecutableFile(binPath) ? { command: binPath, prefixArgs: [], path: binPath } : null;
}

export function resolveTscRunner(searchDirs = [], pathEnv = process.env.PATH) {
  const checkedDirs = new Set();
  for (const rawDir of searchDirs) {
    if (!rawDir) continue;
    const dir = resolve(rawDir);
    if (checkedDirs.has(dir)) continue;
    checkedDirs.add(dir);

    const directJs = join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
    if (existsSync(directJs)) {
      return { command: process.execPath, prefixArgs: [directJs], path: directJs };
    }
    const localBinCandidates =
      process.platform === 'win32'
        ? [
            join(dir, 'node_modules', '.bin', 'tsc.exe'),
            join(dir, 'node_modules', '.bin', 'tsc'),
            join(dir, 'node_modules', '.bin', 'tsc.cmd'),
          ]
        : [join(dir, 'node_modules', '.bin', 'tsc')];
    for (const cand of localBinCandidates) {
      const runner = makeRunnerFromBinPath(cand);
      if (runner) return runner;
    }
  }

  const pathDirs = String(pathEnv ?? '')
    .split(delimiter)
    .map((d) => d.trim())
    .filter(Boolean);
  for (const binDir of pathDirs) {
    const candidates =
      process.platform === 'win32'
        ? [join(binDir, 'tsc.exe'), join(binDir, 'tsc'), join(binDir, 'tsc.cmd')]
        : [join(binDir, 'tsc')];
    for (const cand of candidates) {
      const runner = makeRunnerFromBinPath(cand);
      if (runner) return runner;
    }
  }
  return null;
}

const pythonRunnerCache = new Map();

/**
 * Resolves and caches a local Python 3 interpreter (`python3`, then `python`)
 * via `--version` with `shell: false` and `windowsHide: true`.
 */
export function resolvePythonRunner(pathEnv = process.env.PATH) {
  const cacheKey = String(pathEnv ?? '');
  if (pythonRunnerCache.has(cacheKey)) {
    return pythonRunnerCache.get(cacheKey);
  }
  const baseEnv = { ...process.env };
  if (pathEnv !== process.env.PATH) {
    delete baseEnv.Path;
    delete baseEnv.PATH;
    baseEnv.PATH = pathEnv ?? '';
  }
  const env = sanitizeChildEnv(baseEnv);
  for (const cmd of ['python3', 'python']) {
    const res = spawnSync(cmd, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 3000,
      env,
    });
    const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
    if (!res.error && res.status === 0 && !/was not found/i.test(output)) {
      const runner = { command: cmd, prefixArgs: [], version: output };
      pythonRunnerCache.set(cacheKey, runner);
      return runner;
    }
  }
  pythonRunnerCache.set(cacheKey, null);
  return null;
}

function walkAncestorsWithinRoot(startDir, root) {
  const dirs = [];
  let dir = resolve(startDir);
  const absRoot = resolve(root);
  while (true) {
    const rel = relative(absRoot, dir);
    if (rel.startsWith('..') || isAbsolute(rel)) break;
    dirs.push(dir);
    if (dir === absRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function findNearestTsconfigProjects(workspaceRoot, targetFiles, normPaths = []) {
  const root = resolve(workspaceRoot);
  const seenTsconfigs = new Set();
  const projects = [];

  const addForStartDir = (startDir) => {
    const ancestors = walkAncestorsWithinRoot(startDir, root);
    for (const dir of ancestors) {
      const tsconfig = join(dir, 'tsconfig.json');
      if (existsSync(tsconfig)) {
        const key = stateKeyFor(tsconfig);
        if (!seenTsconfigs.has(key)) {
          seenTsconfigs.add(key);
          const runnerSearchDirs = walkAncestorsWithinRoot(dir, root);
          projects.push({
            tsconfig,
            projectDir: dir,
            tscRunner: resolveTscRunner(runnerSearchDirs),
          });
        }
        return true;
      }
    }
    return false;
  };

  if (normPaths.length > 0) {
    for (const raw of normPaths) {
      try {
        const confined = resolveConfinedPath(root, raw);
        const startDir =
          existsSync(confined.full) && statSync(confined.full).isDirectory()
            ? confined.full
            : dirname(confined.full);
        addForStartDir(startDir);
      } catch {
        // skip invalid path
      }
    }
    for (const f of targetFiles) {
      addForStartDir(dirname(f.full));
    }
    return projects;
  }

  // Whole-workspace scan: check root tsconfig.json first, then any subdir TS target's nearest tsconfig.json
  if (existsSync(join(root, 'tsconfig.json'))) {
    addForStartDir(root);
  }
  for (const f of targetFiles) {
    if (TS_EXTS.has(extname(f.rel).toLowerCase())) {
      addForStartDir(dirname(f.full));
    }
  }
  return projects;
}

function findPytestStyleTestFunction(files) {
  const topDefRe = /^(?:async\s+)?def\s+(test_[A-Za-z0-9_]*)\s*\(/;
  const indentedDefRe = /^([ \t]+)(?:async\s+)?def\s+(test_[A-Za-z0-9_]*)\s*\((.*)$/;
  const classOrDefRe = /^([ \t]*)(?:class\s+|(?:async\s+)?def\s+)/;

  for (const f of files) {
    let text;
    try {
      text = readFileSync(f.full, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    let blockIndent = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const indentLen = line.length - line.trimStart().length;
      if (blockIndent !== null && indentLen <= blockIndent) {
        blockIndent = null;
      }

      if (topDefRe.test(line)) {
        return { file: f.rel, line: i + 1 };
      }

      if (blockIndent === null) {
        const m = indentedDefRe.exec(line);
        if (m) {
          let paramsHead = m[3];
          if (!paramsHead.trim()) {
            paramsHead = lines.slice(i + 1, i + 5).find((l) => l.trim() && !l.trim().startsWith('#')) || '';
          }
          if (!/^\s*(?:self|cls)\b/.test(paramsHead)) {
            return { file: f.rel, line: i + 1 };
          }
        }
        const blk = classOrDefRe.exec(line);
        if (blk) {
          blockIndent = blk[1].length;
        }
      }
    }
  }
  return null;
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
    const entry = {
      ...d,
      source: d.source || 'diagnostic',
    };
    const key = `${entry.file}:${entry.line}:${entry.column}:${entry.severity}:${entry.code}:${entry.message}`;
    if (!diagKeys.has(key) && allDiagnostics.length < cap) {
      diagKeys.add(key);
      allDiagnostics.push(entry);
    }
  };
  const pushTest = (t) => {
    const key = `${t.testName || t.name}|${t.file}|${t.line || 1}|${t.assertion}`;
    if (!testKeys.has(key) && allFailingTests.length < cap) {
      testKeys.add(key);
      allFailingTests.push(t);
    }
  };

  const PYTHON_PROJECT_MARKERS = [
    'pyproject.toml',
    'pytest.ini',
    'setup.cfg',
    'setup.py',
    'tox.ini',
    'conftest.py',
  ];
  const isJsTestRel = (rel) => /\.(?:test|spec)\.[cm]?js$/i.test(rel);
  const isPyTestRel = (rel) => /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/i.test(rel);
  const isPyTestSupportRel = (rel) => /(?:^|\/)tests?\/(?:__init__|conftest)\.py$/i.test(rel);

  const runSyntax = () => {
    const syntaxExts = new Set(['.js', '.mjs', '.cjs', '.json', '.py']);
    const { files, missing } = collectDiagnosticFiles(root, normPaths, syntaxExts);
    for (const m of missing) {
      totalRawLines++;
      pushDiag({
        file: m,
        line: 1,
        column: 1,
        severity: 'error',
        code: 'ENOENT',
        message: 'File not found',
        source: 'syntax',
      });
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
          source: 'syntax',
        });
      }
    }
    notes.push(`syntax:${files.length} files`);
  };

  const runTypecheck = (precomputedProjects = null) => {
    const projects =
      precomputedProjects ??
      findNearestTsconfigProjects(
        root,
        collectDiagnosticFiles(root, normPaths, null).files,
        normPaths,
      );
    if (!projects.length) {
      notes.push('typecheck:skipped(no tsconfig.json)');
      return;
    }
    const runnable = projects.filter((p) => Boolean(p.tscRunner));
    if (!runnable.length) {
      notes.push('typecheck:skipped(tsc unavailable)');
      return;
    }
    let anyFailed = false;
    for (const { tsconfig, projectDir, tscRunner } of runnable) {
      if (tscRunner.requiresSafeArgs && !SAFE_CLI_ARG_RE.test(tsconfig)) {
        hadFailureExit = true;
        anyFailed = true;
        pushDiag({
          file: relative(root, tsconfig).replace(/\\/g, '/') || 'tsconfig.json',
          line: 1,
          column: 1,
          severity: 'error',
          code: 'UNSAFE_TSCONFIG_PATH',
          message: 'Unsafe characters in tsconfig path blocked before invoking tsc',
          source: 'tsc',
        });
        continue;
      }
      const res = spawnSync(
        tscRunner.command,
        [...tscRunner.prefixArgs, '--noEmit', '--pretty', 'false', '-p', tsconfig],
        {
          cwd: projectDir,
          encoding: 'utf8',
          windowsHide: true,
          shell: false,
          timeout: 25000,
          env: sanitizeChildEnv(process.env),
        },
      );
      const combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
      const parsed = parseAndCompressDiagnosticsOutput(combined, {
        kind: 'typecheck',
        maxDiagnostics: cap,
        workspaceRoot: root,
        baseDir: projectDir,
      });
      totalRawLines += parsed.compression.rawLines;
      for (const d of parsed.diagnostics) pushDiag({ ...d, source: d.source || 'tsc' });
      if (res.status !== 0 && parsed.diagnostics.length === 0) {
        hadFailureExit = true;
        anyFailed = true;
        pushDiag({
          file: relative(root, tsconfig).replace(/\\/g, '/') || 'tsconfig.json',
          line: 1,
          column: 1,
          severity: 'error',
          code: 'TYPECHECK_ERROR',
          message:
            combined.trim().slice(0, 320) ||
            res.error?.message ||
            `tsc exited with status ${res.status}`,
          source: 'tsc',
        });
      } else if (res.status !== 0) {
        anyFailed = true;
      }
    }
    notes.push(`typecheck:${anyFailed ? 'failed' : 'ok'}`);
  };

  const runTests = () => {
    const jsTestExts = new Set(
      normPaths.length > 0 && requestedKind === 'test'
        ? ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']
        : ['.js', '.mjs', '.cjs'],
    );
    const { files: jsFiles } = collectDiagnosticFiles(root, normPaths, jsTestExts);
    const jsTargets = normPaths.length
      ? jsFiles.map((f) => f.rel)
      : jsFiles
          .filter((f) => isJsTestRel(f.rel) || /(?:^|\/)tests?\//i.test(f.rel))
          .map((f) => f.rel);

    const pyCollected = collectDiagnosticFiles(root, normPaths, new Set(['.py']));
    const hasPackageJson = existsSync(join(root, 'package.json'));
    const hasPythonMarker = PYTHON_PROJECT_MARKERS.some((m) => existsSync(join(root, m)));

    const missingChecked = new Set();
    const pyCliTargets = [];
    if (normPaths.length > 0) {
      for (const raw of normPaths) {
        const confined = resolveConfinedPath(root, raw);
        if (!existsSync(confined.full)) {
          const mKey = stateKeyFor(confined.rel);
          if (!missingChecked.has(mKey)) {
            missingChecked.add(mKey);
            totalRawLines++;
            hadFailureExit = true;
            pushDiag({
              file: confined.rel,
              line: 1,
              column: 1,
              severity: 'error',
              code: 'ENOENT',
              message: 'Test file not found',
              source: /\.py$/i.test(confined.rel) ? 'pytest' : 'node-test',
            });
          }
          continue;
        }
        const st = statSync(confined.full);
        if (st.isFile() && extname(confined.rel).toLowerCase() === '.py') {
          pyCliTargets.push({ rel: confined.rel, isDir: false });
        } else if (
          st.isDirectory() &&
          collectDiagnosticFiles(root, [confined.rel], new Set(['.py'])).files.length > 0
        ) {
          pyCliTargets.push({ rel: confined.rel, isDir: true });
        }
      }
    }

    const shouldRunPython =
      normPaths.length > 0
        ? pyCliTargets.length > 0
        : hasPythonMarker ||
          (!hasPackageJson && pyCollected.files.length > 0) ||
          pyCollected.files.some((f) => isPyTestRel(f.rel) || /(?:^|\/)tests?\//i.test(f.rel));

    if (!jsTargets.length && !shouldRunPython) {
      if (missingChecked.size === 0) notes.push('test:none');
      return;
    }

    if (jsTargets.length > 0) {
      const args = ['--test', '--test-reporter=spec'];
      if (testPattern && String(testPattern).trim()) {
        args.push('--test-name-pattern', String(testPattern).trim());
      }
      args.push(...jsTargets);
      const childTestEnv = sanitizeChildEnv(process.env);
      delete childTestEnv.NODE_TEST_CONTEXT;
      delete childTestEnv.NODE_TEST_WORKER_ID;
      const res = spawnSync(process.execPath, args, {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: 30000,
        env: childTestEnv,
      });
      const combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
      const parsed = parseAndCompressDiagnosticsOutput(combined, {
        kind: 'test',
        maxDiagnostics: cap,
        workspaceRoot: root,
        baseDir: root,
        sourceHint: 'node-test',
      });
      totalRawLines += parsed.compression.rawLines;
      for (const d of parsed.diagnostics) pushDiag(d);
      for (const t of parsed.failingTests) pushTest(t);
      if (res.status !== 0 && parsed.failingTests.length === 0 && parsed.diagnostics.length === 0) {
        hadFailureExit = true;
        pushTest({
          name: jsTargets[0] || 'node --test',
          testName: jsTargets[0] || 'node --test',
          file: jsTargets[0] || '',
          line: 1,
          column: 1,
          assertion: combined.trim().slice(0, 320) || `node --test exited with status ${res.status}`,
        });
        pushDiag({
          file: jsTargets[0] || '.',
          line: 1,
          column: 1,
          severity: 'error',
          code: 'ERR_TEST_FAILURE',
          message: combined.trim().slice(0, 320) || `node --test exited with status ${res.status}`,
          source: 'node-test',
          testName: jsTargets[0] || 'node --test',
        });
      }
      notes.push(`test:${jsTargets.length} files (${res.status === 0 ? 'pass' : 'fail'})`);
    }

    if (shouldRunPython) {
      const py = resolvePythonRunner();
      if (!py) {
        hadFailureExit = true;
        pushDiag({
          file: pyCliTargets[0]?.rel || pyCollected.files[0]?.rel || '.',
          line: 1,
          column: 1,
          severity: 'error',
          code: 'PYTHON_UNAVAILABLE',
          message: 'Python interpreter (python3/python) not found for Python test diagnostics',
          source: 'pytest',
        });
        notes.push('py-test:skipped(python unavailable)');
        return;
      }

      const trimmedPattern = testPattern && String(testPattern).trim() ? String(testPattern).trim() : '';
      const pyRelArgs = pyCliTargets.map((t) => t.rel).filter((r) => r && r !== '.' && !r.startsWith('-'));
      const pytestArgs = ['-B', '-m', 'pytest', '-q', '--tb=short'];
      if (trimmedPattern) {
        pytestArgs.push('-k', trimmedPattern);
      }
      pytestArgs.push(...pyRelArgs);

      const pyEnv = {
        ...sanitizeChildEnv(process.env),
        PYTHONDONTWRITEBYTECODE: '1',
      };
      let usedRunner = 'pytest';
      let res = spawnSync(py.command, [...py.prefixArgs, ...pytestArgs], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: 30000,
        env: pyEnv,
      });
      let combined = [res.stdout, res.stderr].filter(Boolean).join('\n');

      if (res.status !== 0 && /No module named ['"]?pytest['"]?/i.test(combined)) {
        usedRunner = 'unittest';
        const runUnittestArgs = (extraArgs) =>
          spawnSync(py.command, [...py.prefixArgs, '-B', '-m', 'unittest', ...extraArgs], {
            cwd: root,
            encoding: 'utf8',
            windowsHide: true,
            shell: false,
            timeout: 30000,
            env: pyEnv,
          });

        if (pyCliTargets.length === 0) {
          const utArgs = ['discover'];
          if (trimmedPattern) utArgs.push('-k', trimmedPattern);
          res = runUnittestArgs(utArgs);
          combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
        } else if (pyCliTargets.every((t) => !t.isDir)) {
          const utArgs = [...pyRelArgs];
          if (trimmedPattern) utArgs.push('-k', trimmedPattern);
          res = runUnittestArgs(utArgs);
          combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
        } else if (pyCliTargets.length === 1 && pyCliTargets[0].isDir) {
          const utArgs = ['discover', '-s', pyCliTargets[0].rel];
          if (trimmedPattern) utArgs.push('-k', trimmedPattern);
          res = runUnittestArgs(utArgs);
          combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
        } else {
          const expandedFiles = pyCollected.files.map((f) => f.rel).filter((r) => !r.startsWith('-'));
          const utArgs = expandedFiles.length ? [...expandedFiles] : ['discover'];
          if (trimmedPattern) utArgs.push('-k', trimmedPattern);
          res = runUnittestArgs(utArgs);
          combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
        }
      }

      const parsed = parseAndCompressDiagnosticsOutput(combined, {
        kind: 'test',
        maxDiagnostics: cap,
        workspaceRoot: root,
        baseDir: root,
        sourceHint: usedRunner,
      });
      totalRawLines += parsed.compression.rawLines;
      for (const d of parsed.diagnostics) pushDiag(d);
      for (const t of parsed.failingTests) pushTest(t);
      let pytestUnavailable = false;
      if (usedRunner === 'unittest' && /\bRan 0 tests\b/i.test(combined)) {
        const explicitPyFileSet = new Set(pyCliTargets.filter((t) => !t.isDir).map((t) => stateKeyFor(t.rel)));
        const candidateTestFiles = pyCollected.files.filter(
          (f) => explicitPyFileSet.has(stateKeyFor(f.rel)) || isPyTestRel(f.rel),
        );
        const match = findPytestStyleTestFunction(candidateTestFiles);
        if (match) {
          pytestUnavailable = true;
          hadFailureExit = true;
          totalRawLines = Math.max(totalRawLines, 1);
          pushDiag({
            file: match.file,
            line: match.line,
            column: 1,
            severity: 'error',
            code: 'PYTEST_UNAVAILABLE',
            message: 'PYTEST_UNAVAILABLE: unittest discovered 0 tests for pytest-style functions',
            source: 'unittest',
            testName: match.file,
          });
        }
      }
      if (!pytestUnavailable && (res.status !== 0 || res.error)) {
        hadFailureExit = true;
        if (parsed.failingTests.length === 0 && parsed.diagnostics.length === 0) {
          const fallbackFile = pyRelArgs[0] || pyCollected.files[0]?.rel || '';
          const msg =
            combined.trim().slice(0, 320) ||
            res.error?.message ||
            `${usedRunner} exited with status ${res.status}`;
          pushTest({
            name: fallbackFile || usedRunner,
            testName: fallbackFile || usedRunner,
            file: fallbackFile,
            line: 1,
            column: 1,
            assertion: msg,
          });
          pushDiag({
            file: fallbackFile || '.',
            line: 1,
            column: 1,
            severity: 'error',
            code: 'ERR_TEST_FAILURE',
            message: msg,
            source: usedRunner,
            testName: fallbackFile || usedRunner,
          });
        }
      }
      const pyCount = pyRelArgs.length || pyCollected.files.length;
      notes.push(
        `py-test(${usedRunner}):${pyCount} targets (${res.status === 0 && !res.error && !pytestUnavailable ? 'pass' : 'fail'})`,
      );
    }
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
          shell: false,
          timeout: 25000,
          env: sanitizeChildEnv(process.env),
        });
        const combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
        const parsed = parseAndCompressDiagnosticsOutput(combined, {
          kind: 'lint',
          maxDiagnostics: cap,
          workspaceRoot: root,
          baseDir: root,
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
    const hasTsTargets =
      files.some((f) => TS_EXTS.has(extname(f.rel).toLowerCase())) ||
      normPaths.some((p) => /\.[cm]?tsx?$/i.test(p.trim()));
    const projects = findNearestTsconfigProjects(root, files, normPaths);
    if (projects.some((p) => Boolean(p.tscRunner))) {
      runTypecheck(projects);
    } else if (hasTsTargets) {
      notes.push(`typecheck:skipped(${projects.length ? 'tsc unavailable' : 'no tsconfig.json'})`);
    }
    const onlyTestsTargeted =
      normPaths.length > 0 &&
      files.length > 0 &&
      files.some((f) => isJsTestRel(f.rel) || isPyTestRel(f.rel)) &&
      files.every((f) => isJsTestRel(f.rel) || isPyTestRel(f.rel) || isPyTestSupportRel(f.rel));
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
    summaryParts.push(`- ${d.file}:${d.line}:${d.column} [${d.severity} ${d.code}${d.source ? ` ${d.source}` : ''}] ${d.message}`);
  }
  for (const t of allFailingTests.slice(0, 5)) {
    const loc = t.file ? ` (${t.file}:${t.line || 1}:${t.column || 1})` : '';
    const cmp =
      t.expected !== undefined || t.actual !== undefined
        ? ` [expected=${t.expected}, actual=${t.actual}${t.operator ? `, op=${t.operator}` : ''}]`
        : '';
    summaryParts.push(`- FAIL ${t.testName || t.name}${loc}${cmp}: ${t.assertion}`);
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
