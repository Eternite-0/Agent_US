import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';

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

// ---- 2. Codex Multi-File Atomic `apply_patch` Parser & Applicator ----

export function parseCodexPatch(patchText) {
  const rawLines = String(patchText ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');

  let start = rawLines.findIndex((l) => l.trim() === '*** Begin Patch');
  let end = rawLines.findLastIndex((l) => l.trim() === '*** End Patch');
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

export function applyCodexPatch(
  patchText,
  { workspaceRoot, resolveSafePath, checkStale = () => {}, onBeforeMutate = () => {}, onFileChanged = () => {} },
) {
  const hunks = parseCodexPatch(patchText);
  // Phase 1: Atomic preflight & compute all target file contents in memory first!
  const staged = [];

  for (const h of hunks) {
    const resolved = resolveSafePath(workspaceRoot, h.path);
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
      checkStale(resolved.rel, resolved.full);
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
      checkStale(resolved.rel, resolved.full);
      const before = readFileSync(resolved.full, 'utf8');
      const useCrlf = before.includes('\r\n');
      const lines = before.replace(/\r\n/g, '\n').split('\n');
      let cursor = 0;

      for (const ch of h.chunks) {
        if (ch.context) {
          const ctxHit = seekSequenceFuzzy(lines, [ch.context], cursor, false);
          if (ctxHit) cursor = ctxHit.index + 1;
        }
        if (ch.oldLines.length === 0) {
          lines.splice(cursor, 0, ...ch.newLines);
          cursor += ch.newLines.length;
          continue;
        }
        const hit =
          seekSequenceFuzzy(lines, ch.oldLines, cursor, ch.eof) ??
          seekSequenceFuzzy(lines, ch.oldLines, 0, ch.eof);
        if (!hit) {
          throw new Error(
            `补丁应用失败 (${resolved.rel})：找不到上下文块「${ch.oldLines[0]?.slice(0, 60) ?? ''}」`,
          );
        }
        lines.splice(hit.index, ch.oldLines.length, ...ch.newLines);
        cursor = hit.index + ch.newLines.length;
      }

      let after = lines.join('\n');
      if (useCrlf) after = after.replace(/\n/g, '\r\n');
      const moveTarget = h.moveTo ? resolveSafePath(workspaceRoot, h.moveTo) : null;
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

  // Phase 2: Commit staged writes atomically & capture snapshots/diffs
  const touched = [];
  for (const op of staged) {
    onBeforeMutate(op.rel, op.full);
    if (op.type === 'delete') {
      unlinkSync(op.full);
      onFileChanged({
        path: op.rel,
        before: Buffer.from(op.before, 'utf8').toString('base64'),
        after: null,
      });
      touched.push({ path: op.rel, action: 'deleted', full: op.full });
    } else if (op.type === 'move') {
      onBeforeMutate(op.moveRel, op.moveFull);
      mkdirSync(dirname(op.moveFull), { recursive: true });
      writeFileSync(op.moveFull, op.after, 'utf8');
      if (op.moveFull !== op.full && existsSync(op.full)) unlinkSync(op.full);
      onFileChanged({
        path: op.moveRel,
        before: Buffer.from(op.before, 'utf8').toString('base64'),
        after: Buffer.from(op.after, 'utf8').toString('base64'),
      });
      touched.push({ path: op.moveRel, action: 'moved', full: op.moveFull });
    } else {
      mkdirSync(dirname(op.full), { recursive: true });
      writeFileSync(op.full, op.after, 'utf8');
      onFileChanged({
        path: op.rel,
        before: op.before !== null ? Buffer.from(op.before, 'utf8').toString('base64') : null,
        after: Buffer.from(op.after, 'utf8').toString('base64'),
      });
      touched.push({
        path: op.rel,
        action: op.before === null ? 'added' : 'updated',
        full: op.full,
      });
    }
  }
  return touched;
}

// ---- 3. Codex Command Canonicalization & Approval Prefix Cache ----

const COMPOUND_SHELL_RE = /[;&|><`\n]|\$\(/;
const DOUBLE_QUOTE_SUBST_RE = /`|\$\(/;

/**
 * Checks whether a shell command contains unquoted compound operators (;, &, |, >, <, newline)
 * or command substitution (`...`, $(...)) outside single quotes.
 * Safe characters like `=>` or `;` inside quoted script arguments (e.g. `node -e "x => x + 1"`)
 * do not falsely trigger compound-operator rejection.
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
    if (ch === '\\' && i + 1 < cmd.length) {
      i += 1;
      continue;
    }
    unquoted += ch;
  }
  if (inSingle || inDouble) return true;
  return COMPOUND_SHELL_RE.test(unquoted);
}

/**
 * Strips common shell wrappers and produces a canonical command prefix suitable for
 * session-level "Always Allow Prefix" caching (e.g. `npm test`, `git diff`, `pytest`).
 * Returns null for compound/piped/redirected commands so unsafe chains are NEVER generalized!
 */
export function canonicalizeCommandPrefix(rawCommand) {
  let cmd = String(rawCommand ?? '').trim();
  if (!cmd) return null;

  // Strip explicit wrapper prefixes like `sh -c "..."`, `bash -lc '...'`, `powershell -Command "..."`
  const wrapper =
    /^(?:(?:\/[\w/.-]+\/)?(?:sh|bash|zsh|pwsh|powershell(?:\.exe)?))\s+(?:-[a-zA-Z]+\s+)*(?:-c|-lc|-Command)\s+(['"])([\s\S]+)\1$/i.exec(
      cmd,
    );
  if (wrapper) cmd = wrapper[2].trim();

  if (hasCompoundShellOperators(cmd)) return null;
  const tokens = cmd.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  const head = tokens[0].split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  const sub = tokens[1] && !tokens[1].startsWith('-') ? tokens[1].toLowerCase() : null;
  // Two-token prefix for subcommand CLIs (npm test, git commit, cargo build, python -m ...)
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
  if (multiWordHeads.has(head) && sub) {
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

// ---- 4. Claude Code Fast Post-Edit Diagnostics Loop ----

export function runQuickDiagnostics(fullPath, relPath) {
  if (!existsSync(fullPath)) return { ok: true, summary: '' };
  const ext = extname(fullPath).toLowerCase();

  try {
    if (ext === '.json') {
      JSON.parse(readFileSync(fullPath, 'utf8'));
      return { ok: true, summary: '' };
    }
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      const res = spawnSync(process.execPath, ['--check', fullPath], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 2500,
      });
      if (res.status !== 0) {
        const msg = (res.stderr || res.stdout || '').trim().slice(0, 800);
        return {
          ok: false,
          summary: `\n[自动语法诊断 · ${relPath}]\n${msg}`,
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

// ---- 5. Agnes + Codex Read-Parallel / Write-Barrier Batch Scheduler ----

/**
 * Executes a turn's tool calls with read-only concurrency and sequential write barriers,
 * returning results in exact original call order!
 */
export async function scheduleToolBatch(calls, isReadOnlyFn, executeOneFn) {
  const results = new Array(calls.length);
  let i = 0;
  while (i < calls.length) {
    if (isReadOnlyFn(calls[i])) {
      const batch = [];
      while (i < calls.length && isReadOnlyFn(calls[i])) {
        batch.push({ index: i, call: calls[i] });
        i++;
      }
      const settled = await Promise.all(
        batch.map(async ({ index, call }) => ({
          index,
          value: await executeOneFn(call),
        })),
      );
      for (const s of settled) results[s.index] = s.value;
    } else {
      results[i] = await executeOneFn(calls[i]);
      i++;
    }
  }
  return results;
}
