import type {
  DiagnosticEntry,
  FailingTestEntry,
  ParsedDiagnosticsSummary,
  TaskBundle,
} from '../types/backend';

const FILE_LINE_RE =
  /(?:^|[\s(])((?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]+|[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|css|json)):(\d+)(?::(\d+))?(?=$|[\s:)\]-])/g;
const TSC_PAREN_RE = /^(.+?)\((\d+),(\d+)\):\s*(error|warning|info)\s+(TS\d+):\s*(.+)$/i;

function normalizePath(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^file:\/\//i, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function toPosInt(val: unknown): number | undefined {
  const num = Number(val);
  return Number.isInteger(num) && num > 0 ? num : undefined;
}

function parseEmbeddedLocation(raw?: string): { file?: string; line?: number; column?: number } {
  if (!raw) return {};
  const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(raw.trim());
  if (!m) return { file: normalizePath(raw) || undefined };
  return {
    file: normalizePath(m[1]) || undefined,
    line: toPosInt(m[2]),
    column: toPosInt(m[3]),
  };
}

function extractTrailingJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const idx = trimmed.lastIndexOf('\n{');
  const candidate = idx >= 0 ? trimmed.slice(idx + 1).trim() : trimmed.startsWith('{') ? trimmed : '';
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseExpectedActualFromAssertion(text?: string): { expected?: string; actual?: string } {
  const raw = String(text ?? '');
  if (!raw.trim()) return {};
  const expMatch = /(?:^|\||\n)\s*(?:expected|Expected)\s*[:=]\s*([^|\n]+)/i.exec(raw);
  const actMatch = /(?:^|\||\n)\s*(?:actual|Actual|received|Received)\s*[:=]\s*([^|\n]+)/i.exec(raw);
  if (expMatch || actMatch) {
    return {
      ...(expMatch?.[1] ? { expected: expMatch[1].trim() } : {}),
      ...(actMatch?.[1] ? { actual: actMatch[1].trim() } : {}),
    };
  }
  const arrowMatch = /Expected values to be strictly(?: deep-)?equal:\s*(.+?)\s*(?:!==|!=)\s*(.+)$/i.exec(raw);
  if (arrowMatch) {
    return { actual: arrowMatch[1].trim(), expected: arrowMatch[2].trim() };
  }
  return {};
}

export function resolveMatchingFilePath(
  targetPath: string,
  availablePaths: readonly string[],
): string | null {
  const target = normalizePath(targetPath);
  if (!target) return null;
  const exact = availablePaths.find((p) => normalizePath(p) === target);
  if (exact) return exact;
  const suffix = availablePaths.find((p) => {
    const norm = normalizePath(p);
    return target.endsWith(`/${norm}`) || norm.endsWith(`/${target}`);
  });
  return suffix ?? null;
}

export function parseDiagnosticsForDisplay(
  toolName: string,
  output?: string,
  opts?: { status?: string },
): ParsedDiagnosticsSummary | null {
  if (!output || !output.trim()) return null;
  const isDiagnosticsTool = toolName === 'run_diagnostics';
  const hasDiagnosticsHeader = /^\[run_diagnostics\b/m.test(output);
  if (!isDiagnosticsTool && !hasDiagnosticsHeader && opts?.status !== 'failed') {
    return null;
  }

  const json = extractTrailingJson(output);
  const diagnostics: DiagnosticEntry[] = [];
  const failingTests: FailingTestEntry[] = [];
  const seenDiag = new Set<string>();
  const seenTest = new Set<string>();

  const pushDiag = (entry: DiagnosticEntry) => {
    const file = normalizePath(entry.file);
    const line = toPosInt(entry.line) ?? 1;
    const column = toPosInt(entry.column);
    if (!file || file === '.' || !entry.message.trim()) return;
    const key = `${file}:${line}:${column ?? 0}:${entry.message.trim()}`;
    if (seenDiag.has(key)) return;
    seenDiag.add(key);
    diagnostics.push({
      file,
      line,
      ...(column ? { column } : {}),
      severity: entry.severity || 'error',
      ...(entry.code ? { code: entry.code } : {}),
      message: entry.message.trim(),
      ...(entry.source ? { source: entry.source } : {}),
      ...(entry.testName ? { testName: entry.testName } : {}),
      ...(entry.expected !== undefined ? { expected: entry.expected } : {}),
      ...(entry.actual !== undefined ? { actual: entry.actual } : {}),
      ...(entry.operator ? { operator: entry.operator } : {}),
    });
  };

  const pushFailingTest = (entry: FailingTestEntry) => {
    const name = String(entry.testName || entry.name || '').trim();
    if (!name) return;
    const embedded = parseEmbeddedLocation(entry.file);
    const file = embedded.file;
    const line = toPosInt(entry.line) ?? embedded.line;
    const column = toPosInt(entry.column) ?? embedded.column;
    const assertion = entry.assertion?.trim();
    const fallbackEA = !entry.expected && !entry.actual ? parseExpectedActualFromAssertion(assertion) : {};
    const expected = entry.expected !== undefined ? String(entry.expected) : fallbackEA.expected;
    const actual = entry.actual !== undefined ? String(entry.actual) : fallbackEA.actual;
    const key = `${name.toLowerCase()}::${file ?? ''}::${line ?? 0}`;
    if (seenTest.has(key)) return;
    seenTest.add(key);
    failingTests.push({
      name,
      ...(entry.testName ? { testName: entry.testName } : {}),
      ...(file ? { file } : {}),
      ...(line ? { line } : {}),
      ...(column ? { column } : {}),
      ...(assertion ? { assertion } : {}),
      ...(expected !== undefined ? { expected } : {}),
      ...(actual !== undefined ? { actual } : {}),
      ...(entry.operator ? { operator: entry.operator } : {}),
    });
  };

  if (json && (Array.isArray(json.diagnostics) || Array.isArray(json.failingTests))) {
    for (const raw of Array.isArray(json.diagnostics) ? json.diagnostics : []) {
      if (!raw || typeof raw !== 'object') continue;
      const d = raw as Record<string, unknown>;
      pushDiag({
        file: String(d.file ?? ''),
        line: toPosInt(d.line) ?? 1,
        column: toPosInt(d.column),
        severity: String(d.severity ?? 'error'),
        code: typeof d.code === 'string' ? d.code : undefined,
        message: String(d.message ?? ''),
        source: typeof d.source === 'string' ? d.source : undefined,
        testName: typeof d.testName === 'string' ? d.testName : undefined,
        expected: d.expected !== undefined && d.expected !== null ? String(d.expected) : undefined,
        actual: d.actual !== undefined && d.actual !== null ? String(d.actual) : undefined,
        operator: typeof d.operator === 'string' ? d.operator : undefined,
      });
    }
    for (const raw of Array.isArray(json.failingTests) ? json.failingTests : []) {
      if (!raw || typeof raw !== 'object') continue;
      const t = raw as Record<string, unknown>;
      pushFailingTest({
        name: String(t.testName ?? t.name ?? ''),
        testName: typeof t.testName === 'string' ? t.testName : undefined,
        file: typeof t.file === 'string' ? t.file : undefined,
        line: toPosInt(t.line),
        column: toPosInt(t.column),
        assertion: typeof t.assertion === 'string' ? t.assertion : undefined,
        expected: t.expected !== undefined && t.expected !== null ? String(t.expected) : undefined,
        actual: t.actual !== undefined && t.actual !== null ? String(t.actual) : undefined,
        operator: typeof t.operator === 'string' ? t.operator : undefined,
      });
    }
  }

  const hasJsonDiagnostics = Boolean(json && Array.isArray(json.diagnostics) && json.diagnostics.length > 0);
  // Also parse plain text `file(line,col): error TS...` and `file:line(:col)` entries
  for (const rawLine of output.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || (trimmed.startsWith('{') && trimmed.endsWith('}'))) continue;
    if (hasJsonDiagnostics && /^-\s+.+?:\d+(?::\d+)?\s+\[[^\]]+\]/.test(trimmed)) continue;
    const tscM = TSC_PAREN_RE.exec(trimmed);
    if (tscM) {
      pushDiag({
        file: tscM[1],
        line: Number(tscM[2]),
        column: Number(tscM[3]),
        severity: tscM[4].toLowerCase(),
        code: tscM[5],
        message: tscM[6],
        source: 'tsc',
      });
      continue;
    }

    FILE_LINE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FILE_LINE_RE.exec(trimmed)) !== null) {
      const candidateFile = normalizePath(m[1]);
      if (!candidateFile || candidateFile.startsWith('node:') || candidateFile.includes('node_modules/')) {
        continue;
      }
      const line = toPosInt(m[2]);
      if (!line) continue;
      const column = toPosInt(m[3]);
      let rest = trimmed.slice(m.index + m[0].length).replace(/^[\s:)-]+/, '').trim();
      let code: string | undefined;
      let severity: string = /\bwarn(?:ing)?\b/i.test(trimmed) ? 'warning' : 'error';
      const tagMatch = /^\[(error|warning|info)\s+([^\]]+)\]\s*(.*)$/i.exec(rest);
      if (tagMatch) {
        severity = tagMatch[1].toLowerCase();
        code = tagMatch[2].trim();
        rest = tagMatch[3].trim();
      }
      const message = rest || trimmed;
      pushDiag({
        file: candidateFile,
        line,
        column,
        severity,
        ...(code ? { code } : {}),
        message,
      });
    }
  }

  if (diagnostics.length === 0 && failingTests.length === 0) {
    return null;
  }

  const compression =
    json?.compression && typeof json.compression === 'object'
      ? {
          rawLines: Number((json.compression as Record<string, unknown>).rawLines ?? 0),
          keptLines: Number((json.compression as Record<string, unknown>).keptLines ?? 0),
          truncatedCount: Number((json.compression as Record<string, unknown>).truncatedCount ?? 0),
        }
      : undefined;

  return {
    ok: typeof json?.ok === 'boolean' ? json.ok : undefined,
    kind: typeof json?.kind === 'string' ? json.kind : undefined,
    diagnostics,
    failingTests,
    ...(compression ? { compression } : {}),
  };
}

export function collectBundleDiagnostics(bundle: TaskBundle | null | undefined): {
  diagnostics: DiagnosticEntry[];
  failingTests: FailingTestEntry[];
  readFiles: Map<string, string>;
} {
  const diagnostics: DiagnosticEntry[] = [];
  const failingTests: FailingTestEntry[] = [];
  const readFiles = new Map<string, string>();
  if (!bundle) return { diagnostics, failingTests, readFiles };

  const seenDiag = new Set<string>();
  const seenTest = new Set<string>();
  const merge = (parsed: ParsedDiagnosticsSummary | null) => {
    if (!parsed) return;
    for (const d of parsed.diagnostics) {
      const key = `${d.file}:${d.line}:${d.column ?? 0}:${d.message}`;
      if (!seenDiag.has(key)) {
        seenDiag.add(key);
        diagnostics.push(d);
      }
    }
    for (const t of parsed.failingTests) {
      const key = `${t.name.toLowerCase()}::${t.file ?? ''}::${t.line ?? 0}`;
      if (!seenTest.has(key)) {
        seenTest.add(key);
        failingTests.push(t);
      }
    }
  };

  for (const ev of bundle.evidence ?? []) {
    merge(
      parseDiagnosticsForDisplay(ev.tool, ev.stdout || ev.stderr || '', {
        status: ev.status === 'failed' ? 'failed' : undefined,
      }),
    );
  }

  const callArgsById = new Map<string, { name: string; path?: string }>();
  for (const items of Object.values(bundle.histories ?? {})) {
    for (const item of items) {
      for (const call of item.toolCalls ?? []) {
        let parsedArgs: Record<string, unknown> | null = null;
        if (typeof call.arguments === 'string') {
          try {
            parsedArgs = JSON.parse(call.arguments) as Record<string, unknown>;
          } catch {
            parsedArgs = null;
          }
        } else if (call.arguments && typeof call.arguments === 'object') {
          parsedArgs = call.arguments;
        }
        const path = typeof parsedArgs?.path === 'string' ? parsedArgs.path : undefined;
        callArgsById.set(call.id, { name: call.name, path });
      }
      if (item.type === 'tool/result') {
        const metaErr = Boolean(item.meta?.isError);
        const toolName = item.name || (item.callId ? callArgsById.get(item.callId)?.name : undefined) || '';
        merge(
          parseDiagnosticsForDisplay(toolName, item.text, {
            status: metaErr ? 'failed' : undefined,
          }),
        );
        if (toolName === 'read_file' && item.callId && item.text) {
          const readPath = callArgsById.get(item.callId)?.path;
          if (readPath && !readFiles.has(readPath)) {
            const cleaned = item.text
              .replace(/^<untrusted\b[^>]*>\r?\n?/, '')
              .replace(/\r?\n?<\/untrusted\b[^>]*>\s*$/, '');
            readFiles.set(readPath, cleaned);
          }
        }
      }
    }
  }

  return { diagnostics, failingTests, readFiles };
}
