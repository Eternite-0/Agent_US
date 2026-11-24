import type { FileChangeDelta } from '../types/backend';

export function decodeBase64Utf8(b64: string | null | undefined): string {
  if (!b64) return '';
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return b64;
  }
}

export function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface UnifiedDiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ComputedFileDiff {
  path: string;
  added: number;
  deleted: number;
  isNew: boolean;
  isDeleted: boolean;
  action?: string;
  unifiedDiff?: string;
  hunks?: UnifiedDiffHunk[];
  sha256After?: string | null;
  beforeText: string;
  afterText: string;
  lines: DiffLine[];
}

export function parseUnifiedDiff(unifiedDiff: string): {
  hunks: UnifiedDiffHunk[];
  lines: DiffLine[];
  added: number;
  deleted: number;
} {
  const hunks: UnifiedDiffHunk[] = [];
  const lines: DiffLine[] = [];
  let added = 0;
  let deleted = 0;
  let current: UnifiedDiffHunk | null = null;
  let oldLine = 1;
  let newLine = 1;

  for (const rawLine of String(unifiedDiff ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const hunkMatch = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/.exec(rawLine);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      current = {
        header: rawLine,
        oldStart: oldLine,
        oldCount: hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1,
        newStart: newLine,
        newCount: hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith('+++') || rawLine.startsWith('---') || rawLine === '\\ No newline at end of file') {
      continue;
    }
    if (rawLine.startsWith('+')) {
      const dl: DiffLine = { kind: 'add', oldLine: null, newLine: newLine++, text: rawLine.slice(1) };
      current.lines.push(dl);
      lines.push(dl);
      added++;
    } else if (rawLine.startsWith('-')) {
      const dl: DiffLine = { kind: 'del', oldLine: oldLine++, newLine: null, text: rawLine.slice(1) };
      current.lines.push(dl);
      lines.push(dl);
      deleted++;
    } else if (rawLine.startsWith(' ')) {
      const dl: DiffLine = { kind: 'context', oldLine: oldLine++, newLine: newLine++, text: rawLine.slice(1) };
      current.lines.push(dl);
      lines.push(dl);
    }
  }

  return { hunks, lines, added, deleted };
}

export function computeDiff(beforeText: string, afterText: string): {
  lines: DiffLine[];
  added: number;
  deleted: number;
} {
  const a = beforeText ? beforeText.replace(/\r\n/g, '\n').split('\n') : [];
  const b = afterText ? afterText.replace(/\r\n/g, '\n').split('\n') : [];

  // Fallback for very large files to keep UI instant
  if (a.length * b.length > 250000) {
    const lines: DiffLine[] = [];
    a.forEach((text, i) => lines.push({ kind: 'del', oldLine: i + 1, newLine: null, text }));
    b.forEach((text, i) => lines.push({ kind: 'add', oldLine: null, newLine: i + 1, text }));
    return { lines, added: b.length, deleted: a.length };
  }

  const m = a.length;
  const n = b.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  let added = 0;
  let deleted = 0;

  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'context', oldLine: oldNo++, newLine: newNo++, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ kind: 'del', oldLine: oldNo++, newLine: null, text: a[i] });
      deleted++;
      i++;
    } else {
      lines.push({ kind: 'add', oldLine: null, newLine: newNo++, text: b[j] });
      added++;
      j++;
    }
  }
  while (i < m) {
    lines.push({ kind: 'del', oldLine: oldNo++, newLine: null, text: a[i++] });
    deleted++;
  }
  while (j < n) {
    lines.push({ kind: 'add', oldLine: null, newLine: newNo++, text: b[j++] });
    added++;
  }

  return { lines, added, deleted };
}

export function aggregateFileChanges(
  changesList: FileChangeDelta[],
  artifactFiles?: Record<string, string>,
  baselineFiles?: Record<string, string>,
): ComputedFileDiff[] {
  const byPath = new Map<
    string,
    {
      before: string | null;
      after: string | null;
      action?: string;
      unifiedDiff?: string;
      additions?: number;
      deletions?: number;
      sha256After?: string | null;
      deltaCount: number;
    }
  >();

  for (const ch of changesList) {
    const existing = byPath.get(ch.path);
    if (!existing) {
      byPath.set(ch.path, {
        before: ch.before,
        after: ch.after,
        action: ch.action,
        unifiedDiff: ch.unifiedDiff,
        additions: ch.additions,
        deletions: ch.deletions,
        sha256After: ch.sha256After,
        deltaCount: 1,
      });
    } else {
      existing.after = ch.after;
      existing.action = ch.action ?? existing.action;
      existing.unifiedDiff = ch.unifiedDiff ?? existing.unifiedDiff;
      existing.sha256After = ch.sha256After ?? existing.sha256After;
      existing.additions = undefined;
      existing.deletions = undefined;
      existing.deltaCount += 1;
    }
  }

  if (artifactFiles) {
    for (const [path, b64] of Object.entries(artifactFiles)) {
      // Skip internal subagent handoff copies (e.g. inputs/researcher/...)
      if (/^inputs\//i.test(path.replace(/\\/g, '/'))) continue;
      if (!byPath.has(path)) {
        const base = baselineFiles?.[path] ?? null;
        // If identical to original attached input file and no actual edit happened, skip as "edited"
        if (base !== null && base === b64) continue;
        byPath.set(path, { before: base, after: b64, deltaCount: 1 });
      }
    }
  }

  const results: ComputedFileDiff[] = [];
  for (const [path, delta] of byPath.entries()) {
    const beforeText = decodeBase64Utf8(delta.before);
    const afterText = decodeBase64Utf8(delta.after);
    const parsedPatch = delta.unifiedDiff ? parseUnifiedDiff(delta.unifiedDiff) : null;
    const useParsedPatch = Boolean(
      parsedPatch && parsedPatch.hunks.length > 0 && (delta.deltaCount === 1 || (!delta.before && !delta.after)),
    );
    const computed = useParsedPatch
      ? { lines: parsedPatch!.lines, added: parsedPatch!.added, deleted: parsedPatch!.deleted }
      : computeDiff(beforeText, afterText);
    const added = typeof delta.additions === 'number' ? delta.additions : computed.added;
    const deleted = typeof delta.deletions === 'number' ? delta.deletions : computed.deleted;
    results.push({
      path,
      added,
      deleted,
      isNew: delta.action === 'create' || (delta.before === null && delta.after !== null),
      isDeleted: delta.action === 'delete' || (delta.before !== null && delta.after === null),
      ...(delta.action ? { action: delta.action } : {}),
      ...(delta.unifiedDiff ? { unifiedDiff: delta.unifiedDiff } : {}),
      ...(useParsedPatch && parsedPatch ? { hunks: parsedPatch.hunks } : {}),
      ...(delta.sha256After !== undefined ? { sha256After: delta.sha256After } : {}),
      beforeText,
      afterText,
      lines: computed.lines,
    });
  }

  return results;
}
