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

export interface ComputedFileDiff {
  path: string;
  added: number;
  deleted: number;
  isNew: boolean;
  isDeleted: boolean;
  beforeText: string;
  afterText: string;
  lines: DiffLine[];
}

export function computeDiff(beforeText: string, afterText: string): {
  lines: DiffLine[];
  added: number;
  deleted: number;
} {
  const a = beforeText ? beforeText.replace(/\r\n/g, '\n').split('\n') : [];
  const b = afterText ? afterText.replace(/\r\n/g, '\n').split('\n') : [];

  // Avoid large line-level LCS tables; still retain unchanged edges on long files.
  if (!a.length || !b.length || a.length * b.length > 250_000) {
    const [prefix, suffix] = matchingEdges(a, b);
    const lines: DiffLine[] = [];
    for (let i = 0; i < prefix; i++) {
      lines.push({ kind: 'context', oldLine: i + 1, newLine: i + 1, text: a[i] });
    }
    for (let i = prefix; i < a.length - suffix; i++) {
      lines.push({ kind: 'del', oldLine: i + 1, newLine: null, text: a[i] });
    }
    for (let j = prefix; j < b.length - suffix; j++) {
      lines.push({ kind: 'add', oldLine: null, newLine: j + 1, text: b[j] });
    }
    for (let i = suffix; i > 0; i--) {
      lines.push({ kind: 'context', oldLine: a.length - i + 1, newLine: b.length - i + 1, text: a[a.length - i] });
    }
    return { lines, added: b.length - prefix - suffix, deleted: a.length - prefix - suffix };
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
  const byPath = new Map<string, { before: string | null; after: string | null }>();

  for (const ch of changesList) {
    const existing = byPath.get(ch.path);
    if (!existing) {
      byPath.set(ch.path, { before: ch.before, after: ch.after });
    } else {
      existing.after = ch.after;
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
        byPath.set(path, { before: base, after: b64 });
      }
    }
  }

  const results: ComputedFileDiff[] = [];
  for (const [path, delta] of byPath.entries()) {
    const beforeText = decodeBase64Utf8(delta.before);
    const afterText = decodeBase64Utf8(delta.after);
    const { lines, added, deleted } = computeDiff(beforeText, afterText);
    results.push({
      path,
      added,
      deleted,
      isNew: delta.before === null && delta.after !== null,
      isDeleted: delta.before !== null && delta.after === null,
      beforeText,
      afterText,
      lines,
    });
  }

  return results;
}

export interface DiffSpan {
  text: string;
  changed: boolean;
}

interface SplitDiffRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

const MAX_ALIGNMENT_CELLS = 256;
const MAX_INLINE_LINE_LENGTH = 1024; // UTF-16 units, checked before grapheme segmentation
const MAX_INLINE_PAIR_CELLS = 16_384;
const MAX_INLINE_FILE_CELLS = 500_000;
const MAX_INLINE_FILE_PAIRS = 512;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function matchingEdges(a: readonly string[], b: readonly string[]): [prefix: number, suffix: number] {
  const minLength = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < minLength && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < minLength - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return [prefix, suffix];
}

interface LineMatch {
  score: number;
  before: DiffSpan[];
  after: DiffSpan[];
}

function compareLine(a: readonly string[], b: readonly string[], budget: { cells: number }): LineMatch | null {
  const [prefix, suffix] = matchingEdges(a, b);
  const m = a.length - prefix - suffix;
  const n = b.length - prefix - suffix;
  const width = n + 1;
  const cells = m && n ? (m + 1) * width : 0;
  if (cells > MAX_INLINE_PAIR_CELLS || cells > budget.cells) return null;
  budget.cells -= cells;
  const dp = new Uint16Array(cells);
  for (let i = m - 1; i >= 0 && n > 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const k = i * width + j;
      dp[k] = a[prefix + i] === b[prefix + j] ? 1 + dp[k + width + 1] : Math.max(dp[k + width], dp[k + 1]);
    }
  }

  const before: DiffSpan[] = [];
  const after: DiffSpan[] = [];
  const append = (spans: DiffSpan[], text: string, changed: boolean) => {
    const last = spans[spans.length - 1];
    if (last?.changed === changed) last.text += text;
    else spans.push({ text, changed });
  };
  const hasContent = (grapheme: string) => /\S/u.test(grapheme);
  let shared = 0;
  let changed = 0;
  const change = (spans: DiffSpan[], text: string) => {
    if (hasContent(text)) changed++;
    append(spans, text, true);
  };
  const keep = (text: string) => {
    if (hasContent(text)) shared++;
    append(before, text, false);
    append(after, text, false);
  };
  for (let k = 0; k < prefix; k++) keep(a[k]);
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    const k = i * width + j;
    if (i < m && j < n && a[prefix + i] === b[prefix + j]) {
      keep(a[prefix + i]);
      i++;
      j++;
    } else if (i < m && (j === n || dp[k + width] >= dp[k + 1])) {
      change(before, a[prefix + i++]);
    } else {
      change(after, b[prefix + j++]);
    }
  }
  for (let k = a.length - suffix; k < a.length; k++) keep(a[k]);

  // Shared indentation alone doesn't make two lines a replacement pair.
  const score = 2 * shared / (2 * shared + changed || 1);
  return shared >= 2 && score >= 0.5 ? { score, before, after } : null;
}

/** A single source of line pairing and spans for all diff presentations. Context
 * always breaks a hunk. Unmatched or over-budget lines keep their base row tint. */
export function buildDiffPresentation(lines: readonly DiffLine[]) {
  const splitRows: SplitDiffRow[] = [];
  const spansByLine = new Map<DiffLine, readonly DiffSpan[]>();
  const budget = { cells: MAX_INLINE_FILE_CELLS, pairs: MAX_INLINE_FILE_PAIRS };

  for (let index = 0; index < lines.length;) {
    const line = lines[index++];
    if (line.kind === 'context') {
      splitRows.push({ left: line, right: line });
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    const collect = (change: DiffLine) => (change.kind === 'del' ? dels : adds).push(change);
    collect(line);
    while (index < lines.length && lines[index].kind !== 'context') collect(lines[index++]);

    let oldIndex = 0;
    let newIndex = 0;
    const flushUnmatched = (oldEnd: number, newEnd: number) => {
      while (oldIndex < oldEnd || newIndex < newEnd) {
        splitRows.push({ left: oldIndex < oldEnd ? dels[oldIndex++] : null, right: newIndex < newEnd ? adds[newIndex++] : null });
      }
    };
    if (dels.length && adds.length && dels.length * adds.length <= MAX_ALIGNMENT_CELLS && budget.pairs > 0) {
      const width = adds.length + 1;
      const scores = new Float64Array((dels.length + 1) * width);
      const matches = new Map<number, LineMatch>();
      const graphemes = new Map<string, string[]>();
      const tokenize = (text: string) => {
        let tokens = graphemes.get(text);
        if (!tokens) {
          tokens = Array.from(segmenter.segment(text), ({ segment }) => segment);
          graphemes.set(text, tokens);
        }
        return tokens;
      };
      // Order-preserving, similarity-weighted alignment. A leading insert should
      // not move every subsequent replacement off its matching deletion.
      for (let i = dels.length - 1; i >= 0; i--) {
        for (let j = adds.length - 1; j >= 0; j--) {
          const k = i * width + j;
          const a = dels[i].text;
          const b = adds[j].text;
          let match: LineMatch | null = null;
          if (budget.pairs > 0 && a.length && b.length && a.length <= MAX_INLINE_LINE_LENGTH && b.length <= MAX_INLINE_LINE_LENGTH) {
            budget.pairs--;
            match = compareLine(tokenize(a), tokenize(b), budget);
          }
          const skip = Math.max(scores[k + width], scores[k + 1]);
          const take = match ? match.score + scores[k + width + 1] : 0;
          scores[k] = Math.max(skip, take);
          if (match && take >= skip) matches.set(k, match);
        }
      }
      let i = 0;
      let j = 0;
      while (i < dels.length && j < adds.length) {
        const k = i * width + j;
        const match = matches.get(k);
        if (match) {
          flushUnmatched(i, j);
          const left = dels[oldIndex++];
          const right = adds[newIndex++];
          if (match.before.some((span) => span.changed)) spansByLine.set(left, match.before);
          if (match.after.some((span) => span.changed)) spansByLine.set(right, match.after);
          splitRows.push({ left, right });
          i++;
          j++;
        } else if (scores[k + width] >= scores[k + 1]) i++;
        else j++;
      }
    }
    flushUnmatched(dels.length, adds.length);
  }
  return { splitRows, spansByLine };
}
