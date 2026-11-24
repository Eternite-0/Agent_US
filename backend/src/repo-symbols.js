// Lightweight static evidence. Keep offsets stable while hiding examples in strings,
// templates and comments. Unknown receivers and dynamic imports remain unresolved.
const jsTrivia =
  /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`/g;
const identifier = '[A-Za-z_$][\\w$]*';
const declarations = new RegExp(
  `\\b(function\\s*\\*?|class|interface|enum|type|const|let|var)\\s+(${identifier})`,
  'g',
);
const otherDeclarations = {
  python: /^\s*(?:async\s+)?(def|class)\s+(\w+)/gm,
  rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|trait|enum|type|mod)\s+(\w+)/gm,
  go: /^\s*(func|type)\s+(?:\([^()\n]*\)\s*)?(\w+)/gm,
};

function lineLocator(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let low = 0,
      high = starts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid;
    }
    return { line: low + 1, column: offset - starts[low] + 1 };
  };
}

function importBindings(text, masked) {
  const bindings = new Map();
  for (const { index } of masked.matchAll(/\bimport\s+(?=[\w$*{])/g)) {
    const match = /^import\s+([\w$\s,*{}]+?)\s+from\s*['"]([^'"\n]+)['"]/.exec(
      text.slice(index, index + 4096),
    );
    if (!match) continue;
    const [, clause, specifier] = match;
    const names = /\{([^}]*)\}/.exec(clause)?.[1] ?? '';
    for (const item of names.split(',')) {
      const [name, alias] = item.trim().split(/\s+as\s+/);
      if (/^[\w$]+$/.test(name)) bindings.set(alias ?? name, { name, specifier });
    }
    const namespace = /\*\s+as\s+([\w$]+)/.exec(clause)?.[1];
    if (namespace) bindings.set(namespace, { name: '*', specifier });
    const first = /^([\w$]+)(?:\s*,|\s*$)/.exec(clause)?.[1];
    if (first) bindings.set(first, { name: 'default', specifier });
  }
  return bindings;
}

function compactSignature(text, startOffset, endOffset) {
  const raw = text.slice(Math.max(0, startOffset), Math.max(startOffset, endOffset));
  return raw
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s{:=]+$/, '')
    .trim()
    .slice(0, 160);
}

function lineStartOffset(text, offset) {
  const idx = text.lastIndexOf('\n', Math.max(0, offset - 1));
  return idx === -1 ? 0 : idx + 1;
}

function findNonJsBlockEndLine(text, headerOffset, language, locate) {
  const lines = text.split(/\r?\n/);
  const startLine = locate(headerOffset).line;
  if (language === 'python') {
    const baseLine = lines[startLine - 1] ?? '';
    const baseIndent = baseLine.length - baseLine.trimStart().length;
    let lastLine = startLine;
    for (let idx = startLine; idx < lines.length; idx++) {
      const l = lines[idx];
      if (!l.trim()) continue;
      const indent = l.length - l.trimStart().length;
      if (indent <= baseIndent) break;
      lastLine = idx + 1;
    }
    return lastLine;
  }
  let braceDepth = 0;
  let seenOpen = false;
  for (let i = headerOffset; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      braceDepth++;
      seenOpen = true;
    } else if (ch === '}') {
      if (braceDepth > 0) braceDepth--;
      if (seenOpen && braceDepth === 0) {
        return locate(i).line;
      }
    } else if (!seenOpen && (ch === '\n' || ch === '\r')) {
      // Wait up to next line for opening brace, else single-line decl
      if (locate(i).line > startLine + 1) break;
    }
  }
  return startLine;
}

export function extractRepositorySymbols(path, language, text) {
  const definitions = [],
    calls = [];
  const locate = lineLocator(text);
  const js = language === 'javascript' || language === 'typescript';
  const masked = js ? text.replace(jsTrivia, (token) => token.replace(/[^\r\n]/g, ' ')) : text;
  const pattern = js ? declarations : otherDeclarations[language];
  if (!pattern) return { definitions, calls };
  const add = (name, kind, offset, endLine = null, signature = null) => {
    const { line, column } = locate(offset);
    const symbol = {
      id: `${path}#${line}:${column}`,
      path,
      line,
      endLine: Math.max(line, Number(endLine) || line),
      column,
      name,
      kind,
      signature: signature ?? compactSignature(text, lineStartOffset(text, offset), text.indexOf('\n', offset) === -1 ? text.length : text.indexOf('\n', offset)),
    };
    definitions.push(symbol);
    return symbol;
  };
  const closing = new Map(),
    stack = [];
  if (js)
    for (let i = 0; i < masked.length; i++) {
      if ('({['.includes(masked[i])) stack.push(i);
      else if (')}]'.includes(masked[i]) && stack.length) closing.set(stack.pop(), i);
    }
  const bindings = js ? importBindings(text, masked) : null;
  const bodies = [],
    classes = [];
  for (const m of masked.matchAll(pattern)) {
    const [, kind, name] = m;
    const offset = m.index + m[0].lastIndexOf(name);
    const sigStart = lineStartOffset(text, m.index);
    const symbol = add(name, kind.trim(), offset);
    if (!js) {
      symbol.endLine = findNonJsBlockEndLine(text, offset, language, locate);
      const lineEnd = text.indexOf('\n', offset);
      symbol.signature = compactSignature(
        text,
        sigStart,
        lineEnd === -1 ? text.length : lineEnd,
      );
      continue;
    }
    const end = offset + name.length;
    const rest = masked.slice(end, end + 512);
    let start;
    if (kind === 'class') {
      const head = /^[^;{}]*\{/.exec(rest);
      const open = head && end + head[0].length - 1;
      if (open != null && closing.has(open)) {
        const clsEnd = closing.get(open);
        symbol.endLine = Math.max(symbol.line, locate(clsEnd).line);
        symbol.signature = compactSignature(text, sigStart, open);
        classes.push({ name, open, end: clsEnd });
      }
      continue;
    }
    if (kind.startsWith('function')) {
      const params = /^\s*(?:<[^<>;{}]*>\s*)?\(/.exec(rest);
      const close = params && closing.get(end + params[0].length - 1);
      if (close == null) continue;
      const body = /^\s*(?::[^;{}=]*?)?\{/.exec(masked.slice(close + 1, close + 513));
      if (!body) {
        // Overload signature or declare function without body
        const semi = masked.indexOf(';', close + 1);
        const endOff = semi !== -1 && semi - close < 256 ? semi : close;
        symbol.endLine = Math.max(symbol.line, locate(endOff).line);
        symbol.signature = compactSignature(text, sigStart, endOff + 1);
        continue;
      }
      start = close + body[0].length;
      symbol.signature = compactSignature(text, sigStart, start - 1);
    } else if (kind === 'interface' || kind === 'enum') {
      const head = /^[^;{}]*\{/.exec(rest);
      const open = head && end + head[0].length - 1;
      if (open != null && closing.has(open)) {
        symbol.endLine = Math.max(symbol.line, locate(closing.get(open)).line);
        symbol.signature = compactSignature(text, sigStart, open);
      }
      continue;
    } else if (['const', 'let', 'var', 'type'].includes(kind)) {
      const arrow =
        kind !== 'type'
          ? /^\s*=\s*(?:async\s+)?(?:\([^;{}]*?\)|[\w$]+)\s*(?::[^;{}=]*?)?=>\s*/.exec(rest)
          : null;
      if (!arrow) {
        // Track multi-line const object/array/type statement span
        let scanEnd = end;
        for (let i = end; i < masked.length; i++) {
          if (closing.has(i)) {
            i = closing.get(i);
            scanEnd = i;
            continue;
          }
          if (masked[i] === ';') {
            scanEnd = i;
            break;
          }
          if (masked[i] === '\n' && i > end) {
            const nextTrim = masked.slice(i + 1, i + 40).trimStart();
            if (!/^[|&?:.=]/.test(nextTrim)) {
              scanEnd = i;
              break;
            }
          }
          scanEnd = i;
        }
        symbol.endLine = Math.max(symbol.line, locate(scanEnd).line);
        const firstLineEnd = text.indexOf('\n', offset);
        symbol.signature = compactSignature(
          text,
          sigStart,
          firstLineEnd === -1 ? text.length : Math.min(firstLineEnd, scanEnd + 1),
        );
        continue;
      }
      start = end + arrow[0].length;
      symbol.kind = 'arrow';
      symbol.signature = compactSignature(text, sigStart, start);
    } else continue;
    const finish =
      masked[start] === '{' ? closing.get(start) : start + masked.slice(start).search(/[;\r\n]|$/);
    if (finish != null) {
      symbol.endLine = Math.max(symbol.line, locate(finish).line);
      bodies.push({ start, finish, symbol });
    }
    if (
      /\bexport\s+default\s+(?:async\s+)?$/.test(masked.slice(Math.max(0, m.index - 50), m.index))
    )
      symbol.defaultExport = true;
  }
  // Recognize members at class-body depth only. Skip parameter and method bodies
  // by their matching delimiters, so nested calls cannot become declarations.
  for (const cls of classes) {
    for (let i = cls.open + 1; i < cls.end; i++) {
      if (masked[i] === '(' && closing.has(i)) {
        const close = closing.get(i);
        const member = /([A-Za-z_$][\w$]*)\s*$/.exec(
          masked.slice(Math.max(cls.open + 1, i - 256), i),
        );
        const body = /^\s*(?::[^;{}=]*?)?\{/.exec(masked.slice(close + 1, close + 513));
        if (member && body) {
          const start = close + body[0].length;
          const finish = closing.get(start);
          if (finish != null) {
            const memberOffset = i - member[0].length;
            const symbol = add(
              member[1],
              'method',
              memberOffset,
              locate(finish).line,
              compactSignature(text, lineStartOffset(text, memberOffset), start - 1),
            );
            symbol.owner = cls.name;
            bodies.push({ start, finish, symbol });
            i = finish;
            continue;
          }
        }
      }
      if (closing.has(i)) i = closing.get(i);
    }
  }
  // Track the innermost enclosing declaration in one pass over call sites.
  bodies.sort((a, b) => a.start - b.start);
  const active = [];
  let next = 0;
  for (const m of masked.matchAll(/(?:\b|(?=\$))([\w$]+)(?:\s*\.\s*([\w$]+))?\s*\(/g)) {
    while (next < bodies.length && bodies[next].start <= m.index) {
      const body = bodies[next++];
      while (active.length && active.at(-1).finish < body.start) active.pop();
      active.push(body);
    }
    while (active.length && active.at(-1).finish < m.index) active.pop();
    if (
      !active.length ||
      /(?:\.|\bfunction\s*\*?)\s*$/.test(masked.slice(Math.max(0, m.index - 24), m.index))
    )
      continue;
    const binding = bindings.get(m[1]);
    if (m[1] === 'this' && active.at(-1).symbol.owner && m[2]) {
      calls.push({
        from: active.at(-1).symbol.id,
        name: `${active.at(-1).symbol.owner}.${m[2]}`,
        line: locate(m.index).line,
      });
      continue;
    }
    if (m[2] && binding?.name !== '*') continue;
    calls.push({
      from: active.at(-1).symbol.id,
      name: m[2] ?? binding?.name ?? m[1],
      specifier: binding?.specifier,
      line: locate(m.index).line,
    });
  }
  return { definitions, calls };
}

export function linkRepositoryCalls(records, resolveImport) {
  const symbols = [],
    calls = [],
    byPath = new Map();
  for (const [path, record] of records) {
    const names = new Map();
    for (const symbol of record.definitions ?? []) {
      symbols.push({ ...symbol });
      for (const name of symbol.defaultExport
        ? [symbol.name, 'default']
        : [symbol.owner ? `${symbol.owner}.${symbol.name}` : symbol.name]) {
        names.set(name, names.has(name) ? null : symbol);
      }
    }
    byPath.set(path, names);
  }
  for (const [path, record] of records)
    for (const call of record.calls ?? []) {
      const target = call.specifier ? resolveImport(path, call.specifier) : path;
      const symbol = byPath.get(target)?.get(call.name);
      if (call.specifier && !records.get(target)?.parsed?.exports.includes(call.name)) continue;
      if (symbol && ['function', 'function*', 'arrow', 'method'].includes(symbol.kind))
        calls.push({ from: call.from, to: symbol.id, line: call.line });
    }
  return { symbols, calls };
}

export function findRepositorySymbols(analysis, query, { path, limit = 20 } = {}) {
  const needle = String(query ?? '')
    .trim()
    .toLowerCase();
  if (!needle) return [];
  const score = (s) => (s.id.toLowerCase() === needle || s.name.toLowerCase() === needle ? 0 : 1);
  return (analysis.callGraph?.symbols ?? [])
    .filter(
      (s) =>
        (!path || s.path === path) &&
        (s.name.toLowerCase().includes(needle) || s.id.toLowerCase() === needle),
    )
    .sort(
      (a, b) =>
        score(a) - score(b) ||
        a.path.localeCompare(b.path) ||
        a.line - b.line ||
        a.column - b.column,
    )
    .slice(0, Math.min(100, Math.max(0, Math.trunc(limit) || 0)));
}

// A bounded breadth-first subgraph. Multiple exact matches are returned as roots
// so callers can disambiguate with path or definition id before tracing.
export function traceRepositoryCalls(
  analysis,
  query,
  { path, direction = 'callees', maxDepth = 3, limit = 40 } = {},
) {
  const roots = findRepositorySymbols(analysis, query, { path, limit: 100 }).filter(
    (s) => s.id === query || s.name === query,
  );
  const edges = [],
    seen = new Set(roots.map((s) => s.id)),
    adjacent = new Map();
  const reverse = direction === 'callers';
  for (const call of analysis.callGraph?.calls ?? []) {
    const key = reverse ? call.to : call.from;
    if (!adjacent.has(key)) adjacent.set(key, []);
    adjacent.get(key).push(call);
  }
  const queue = roots.map((s) => ({ id: s.id, depth: 0 }));
  const bound = Math.min(200, Math.max(0, Math.trunc(limit) || 0));
  for (let i = 0; i < queue.length && edges.length < bound; i++) {
    const { id, depth } = queue[i];
    if (depth >= Math.min(12, Math.max(0, Math.trunc(maxDepth) || 0))) continue;
    for (const call of adjacent.get(id) ?? []) {
      edges.push({ ...call, depth: depth + 1 });
      const target = reverse ? call.from : call.to;
      if (!seen.has(target)) {
        seen.add(target);
        queue.push({ id: target, depth: depth + 1 });
      }
      if (edges.length >= bound) break;
    }
  }
  return { roots, edges };
}

function stemWithoutTestMarker(relPath) {
  const base = String(relPath ?? '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  return base
    .replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/, '')
    .replace(/^test_/, '')
    .replace(/_test\.(?:py|go|rs)$/, '')
    .replace(/\.[a-z0-9]+$/, '');
}

function isTestCandidatePath(relPath) {
  const norm = String(relPath ?? '').replace(/\\/g, '/');
  if (/(?:^|\/)(?:tests?|__tests__|specs?)\//i.test(norm)) return true;
  const base = norm.split('/').pop() ?? '';
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true;
  if (/^(?:test_.*\.py|.*_test\.py)$/i.test(base)) return true;
  if (/_test\.(?:go|rs)$/i.test(base)) return true;
  return false;
}

export function findCrossFileReferencesFromAnalysis(analysis, symbolName, { path = null } = {}) {
  const needle = String(symbolName ?? '').trim();
  if (!needle || !analysis?.callGraph) {
    return { symbol: needle, definitions: [], callers: [], importers: [], files: [] };
  }
  const allSymbols = analysis.callGraph.symbols ?? [];
  const byId = new Map(allSymbols.map((s) => [s.id, s]));

  const definitions = allSymbols
    .filter((s) => {
      if (path && s.path !== path) return false;
      const qualified = s.owner ? `${s.owner}.${s.name}` : s.name;
      return s.name === needle || qualified === needle || s.id === needle;
    })
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      path: s.path,
      line: s.line,
      endLine: Math.max(s.line, Number(s.endLine) || s.line),
      column: s.column,
      signature: s.signature ?? '',
      ...(s.owner ? { owner: s.owner } : {}),
    }));

  const defIds = new Set(definitions.map((d) => d.id));
  const defPaths = new Set(definitions.map((d) => d.path));
  const shortNames = new Set(definitions.map((d) => d.name));
  if (!shortNames.size) shortNames.add(needle.includes('.') ? needle.split('.').pop() : needle);

  const callers = [];
  const callerSeen = new Set();
  const callerFiles = new Set();
  for (const call of analysis.callGraph.calls ?? []) {
    if (!defIds.has(call.to)) continue;
    const fromSym = byId.get(call.from);
    const toSym = byId.get(call.to);
    const fromPath = fromSym?.path ?? call.from.slice(0, call.from.lastIndexOf('#'));
    const toPath = toSym?.path ?? call.to.slice(0, call.to.lastIndexOf('#'));
    const key = `${call.from}->${call.to}@${call.line}`;
    if (callerSeen.has(key)) continue;
    callerSeen.add(key);
    callerFiles.add(fromPath);
    callers.push({
      from: call.from,
      fromName: fromSym?.name ?? call.from,
      path: fromPath,
      line: call.line,
      to: call.to,
      toPath,
      crossFile: fromPath !== toPath,
    });
  }

  const edges = analysis.callGraph.edges ?? [];
  const modulesByPath = new Map((analysis.callGraph.modules ?? []).map((m) => [m.path, m]));
  const reachableTargets = new Set(defPaths);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of edges) {
      if (
        e.kind === 'esm-reexport' &&
        reachableTargets.has(e.to) &&
        !reachableTargets.has(e.from) &&
        (e.symbols?.some((s) => shortNames.has(s) || s === '*' || s.startsWith('* as ')) ?? false)
      ) {
        const mod = modulesByPath.get(e.from);
        if (!mod || mod.exports?.some((ex) => shortNames.has(ex)) || e.symbols?.includes('*')) {
          reachableTargets.add(e.from);
          grew = true;
        }
      }
    }
  }

  const importers = [];
  const importerSeen = new Set();
  for (const e of edges) {
    if (!reachableTargets.has(e.to)) continue;
    const syms = e.symbols ?? [];
    const origSyms = e.originalSymbols ?? [];
    const explicitMatch =
      syms.some((s) => shortNames.has(s) || s === '*' || s.startsWith('* as ')) ||
      origSyms.some((s) => shortNames.has(s) || s === '*' || s.startsWith('* as '));
    const implicitMatch =
      syms.length === 0 ||
      callerFiles.has(e.from) ||
      (syms.includes('default') && definitions.some((d) => d.path === e.to));
    if (!explicitMatch && !implicitMatch) continue;
    const key = `${e.from}->${e.to}`;
    if (importerSeen.has(key)) continue;
    importerSeen.add(key);
    importers.push({
      from: e.from,
      to: e.to,
      specifier: e.specifier,
      kind: e.kind,
      symbols: [...syms],
    });
  }

  const files = [
    ...new Set([
      ...definitions.map((d) => d.path),
      ...callers.map((c) => c.path),
      ...importers.map((im) => im.from),
    ]),
  ].sort((a, b) => a.localeCompare(b));

  return { symbol: needle, definitions, callers, importers, files };
}

export function findRelatedTestsFromAnalysis(analysis, filePaths, { maxDepth = 5 } = {}) {
  const rawList = (Array.isArray(filePaths) ? filePaths : [filePaths])
    .map((p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim())
    .filter(Boolean);

  if (!rawList.length || !analysis?.callGraph) {
    return { targetFiles: [], tests: [], details: [] };
  }

  const modules = analysis.callGraph.modules ?? [];
  const edges = analysis.callGraph.edges ?? [];
  const allPaths = [
    ...new Set([
      ...modules.map((m) => m.path),
      ...(analysis.structure?.sourceFiles ?? []),
      ...(analysis.structure?.testFiles ?? []),
    ]),
  ];
  const testSet = new Set([
    ...modules.filter((m) => m.isTest).map((m) => m.path),
    ...(analysis.structure?.testFiles ?? []),
  ]);
  for (const p of allPaths) {
    if (isTestCandidatePath(p)) testSet.add(p);
  }

  const resolveInputPath = (input) => {
    if (allPaths.includes(input)) return input;
    const lower = input.toLowerCase();
    const exactCi = allPaths.find((p) => p.toLowerCase() === lower);
    if (exactCi) return exactCi;
    const suffixMatches = allPaths.filter((p) => p.toLowerCase().endsWith(`/${lower}`));
    if (suffixMatches.length) return suffixMatches.sort((a, b) => a.localeCompare(b))[0];
    return input;
  };

  const targetFiles = [...new Set(rawList.map(resolveInputPath))];
  const reverseImports = new Map();
  for (const e of edges) {
    if (!reverseImports.has(e.to)) reverseImports.set(e.to, new Set());
    reverseImports.get(e.to).add(e.from);
  }

  const testsByStem = new Map();
  for (const t of testSet) {
    const stem = stemWithoutTestMarker(t);
    if (!stem) continue;
    if (!testsByStem.has(stem)) testsByStem.set(stem, []);
    testsByStem.get(stem).push(t);
  }

  const hits = new Map(); // testPath -> { path, reasons: Set, distance, matchedTargets: Set }
  const recordHit = (testPath, reason, distance, target) => {
    if (!hits.has(testPath)) {
      hits.set(testPath, {
        path: testPath,
        reasons: new Set(),
        distance,
        matchedTargets: new Set(),
      });
    }
    const entry = hits.get(testPath);
    entry.reasons.add(reason);
    entry.distance = Math.min(entry.distance, distance);
    entry.matchedTargets.add(target);
  };

  for (const target of targetFiles) {
    if (testSet.has(target)) {
      recordHit(target, 'direct-test', 0, target);
    }

    // 1. Reverse import graph BFS
    const visited = new Set([target]);
    const queue = [{ path: target, depth: 0 }];
    for (let i = 0; i < queue.length; i++) {
      const { path: cur, depth } = queue[i];
      if (depth >= maxDepth) continue;
      for (const importer of reverseImports.get(cur) ?? []) {
        if (testSet.has(importer)) {
          recordHit(
            importer,
            depth === 0 ? 'direct-import' : 'transitive-import',
            depth + 1,
            target,
          );
        }
        if (!visited.has(importer)) {
          visited.add(importer);
          queue.push({ path: importer, depth: depth + 1 });
        }
      }
    }

    // 2. Naming convention match (foo.js -> test/**/foo.test.*, etc.)
    if (!testSet.has(target)) {
      const stems = new Set();
      const ownStem = stemWithoutTestMarker(target);
      if (ownStem && ownStem !== 'index') stems.add(ownStem);
      if (ownStem === 'index') {
        const parts = target.split('/');
        if (parts.length >= 2) {
          stems.add(parts[parts.length - 2].toLowerCase());
        }
      }
      for (const s of stems) {
        for (const cand of testsByStem.get(s) ?? []) {
          recordHit(cand, 'naming-convention', 1, target);
        }
      }
    }
  }

  const details = [...hits.values()]
    .map((h) => ({
      path: h.path,
      reasons: [...h.reasons].sort((a, b) => a.localeCompare(b)),
      distance: h.distance,
      matchedTargets: [...h.matchedTargets].sort((a, b) => a.localeCompare(b)),
    }))
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        b.reasons.length - a.reasons.length ||
        a.path.localeCompare(b.path),
    );

  return {
    targetFiles,
    tests: details.map((d) => d.path),
    details,
  };
}

export function querySymbolGraphFromAnalysis(
  analysis,
  {
    symbol = '',
    path = null,
    includeCallers = true,
    includeTests = true,
    maxResults = 25,
  } = {},
) {
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(maxResults) || 25)));
  const cleanSymbol = String(symbol ?? '').trim();
  const rawPath = path ? String(path).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim() : '';

  if (!analysis?.callGraph) {
    return {
      ok: true,
      query: {
        symbol: cleanSymbol || null,
        path: rawPath || null,
        includeCallers: includeCallers !== false,
        includeTests: includeTests !== false,
        maxResults: limit,
      },
      definitions: [],
      callers: [],
      importers: [],
      relatedTests: [],
      relatedTestDetails: [],
      files: [],
    };
  }

  const modules = analysis.callGraph.modules ?? [];
  const edges = analysis.callGraph.edges ?? [];
  const allSymbols = analysis.callGraph.symbols ?? [];
  const allPaths = [
    ...new Set([
      ...modules.map((m) => m.path),
      ...(analysis.structure?.sourceFiles ?? []),
      ...(analysis.structure?.testFiles ?? []),
    ]),
  ];

  let scopedPaths = null;
  let resolvedPath = rawPath || null;
  if (rawPath) {
    const lower = rawPath.toLowerCase();
    const exactFile =
      allPaths.find((p) => p === rawPath) ??
      allPaths.find((p) => p.toLowerCase() === lower) ??
      null;
    if (exactFile) {
      resolvedPath = exactFile;
      scopedPaths = new Set([exactFile]);
    } else {
      const dirMatches = allPaths.filter(
        (p) => p.toLowerCase().startsWith(`${lower}/`),
      );
      if (dirMatches.length > 0) {
        scopedPaths = new Set(dirMatches);
      } else {
        const suffixMatches = allPaths.filter((p) => p.toLowerCase().endsWith(`/${lower}`));
        if (suffixMatches.length > 0) {
          const picked = suffixMatches.sort((a, b) => a.localeCompare(b))[0];
          resolvedPath = picked;
          scopedPaths = new Set([picked]);
        } else {
          scopedPaths = new Set([rawPath]);
        }
      }
    }
  }

  const defMap = new Map();
  const callerMap = new Map();
  const importerMap = new Map();

  const addRefsResult = (refs) => {
    for (const d of refs.definitions ?? []) {
      if (scopedPaths && !scopedPaths.has(d.path)) continue;
      if (!defMap.has(d.id)) defMap.set(d.id, d);
    }
    if (includeCallers !== false) {
      for (const c of refs.callers ?? []) {
        const key = `${c.from}->${c.to}@${c.line}`;
        if (!callerMap.has(key)) callerMap.set(key, c);
      }
      for (const im of refs.importers ?? []) {
        const key = `${im.from}->${im.to}`;
        if (!importerMap.has(key)) importerMap.set(key, im);
      }
    }
  };

  if (cleanSymbol) {
    const exactRefs = findCrossFileReferencesFromAnalysis(analysis, cleanSymbol, {
      path: scopedPaths?.size === 1 ? [...scopedPaths][0] : null,
    });
    addRefsResult(exactRefs);
    if (defMap.size === 0) {
      const partialMatches = findRepositorySymbols(analysis, cleanSymbol, {
        path: scopedPaths?.size === 1 ? [...scopedPaths][0] : undefined,
        limit: Math.min(limit, 12),
      }).filter((s) => !scopedPaths || scopedPaths.has(s.path));
      const seenNames = new Set();
      for (const sym of partialMatches) {
        if (seenNames.has(sym.name)) continue;
        seenNames.add(sym.name);
        const refs = findCrossFileReferencesFromAnalysis(analysis, sym.name, {
          path: sym.path,
        });
        addRefsResult(refs);
        if (seenNames.size >= 6) break;
      }
    }
  } else if (scopedPaths) {
    const matchingSymbols = allSymbols
      .filter((s) => scopedPaths.has(s.path))
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
    for (const s of matchingSymbols.slice(0, limit)) {
      defMap.set(s.id, {
        id: s.id,
        name: s.name,
        kind: s.kind,
        path: s.path,
        line: s.line,
        endLine: Math.max(s.line, Number(s.endLine) || s.line),
        column: s.column,
        signature: s.signature ?? '',
        ...(s.owner ? { owner: s.owner } : {}),
      });
    }
    if (includeCallers !== false) {
      const modMap = new Map(modules.map((m) => [m.path, m]));
      const seedSymbols = [];
      for (const p of scopedPaths) {
        for (const exp of modMap.get(p)?.exports ?? []) {
          if (exp !== 'default' && !seedSymbols.includes(exp) && seedSymbols.length < 8) {
            seedSymbols.push(exp);
          }
        }
      }
      for (const s of matchingSymbols) {
        if (seedSymbols.length >= 8) break;
        if (!seedSymbols.includes(s.name)) seedSymbols.push(s.name);
      }
      for (const symName of seedSymbols) {
        addRefsResult(
          findCrossFileReferencesFromAnalysis(analysis, symName, {
            path: scopedPaths.size === 1 ? [...scopedPaths][0] : null,
          }),
        );
      }
      for (const e of edges) {
        if (scopedPaths.has(e.to)) {
          const key = `${e.from}->${e.to}`;
          if (!importerMap.has(key)) {
            importerMap.set(key, {
              from: e.from,
              to: e.to,
              specifier: e.specifier,
              kind: e.kind,
              symbols: [...(e.symbols ?? [])],
            });
          }
        }
      }
    }
  }

  const definitions = [...defMap.values()].slice(0, limit);
  const callers = includeCallers !== false ? [...callerMap.values()].slice(0, limit) : [];
  const importers = includeCallers !== false ? [...importerMap.values()].slice(0, limit) : [];

  let relatedTests = [];
  let relatedTestDetails = [];
  if (includeTests !== false) {
    const seedFiles = [
      ...new Set([
        ...(scopedPaths ? [...scopedPaths] : []),
        ...definitions.map((d) => d.path),
      ]),
    ].filter(Boolean);
    if (seedFiles.length > 0) {
      const rel = findRelatedTestsFromAnalysis(analysis, seedFiles);
      relatedTests = rel.tests.slice(0, limit);
      relatedTestDetails = rel.details.slice(0, limit);
    }
  }

  const files = [
    ...new Set([
      ...definitions.map((d) => d.path),
      ...callers.map((c) => c.path),
      ...importers.map((im) => im.from),
      ...relatedTests,
    ]),
  ]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, Math.max(limit * 2, 50));

  return {
    ok: true,
    query: {
      symbol: cleanSymbol || null,
      path: resolvedPath,
      includeCallers: includeCallers !== false,
      includeTests: includeTests !== false,
      maxResults: limit,
    },
    definitions,
    callers,
    importers,
    relatedTests,
    relatedTestDetails,
    files,
  };
}

export function findCrossFileReferences(indexOrRoot, symbolName, options = {}) {
  if (typeof indexOrRoot === 'string') {
    return import('./repo-intelligence.js').then((m) =>
      m.findCrossFileReferences(indexOrRoot, symbolName, options),
    );
  }
  return findCrossFileReferencesFromAnalysis(indexOrRoot, symbolName, options);
}

export function findRelatedTests(indexOrRoot, filePaths, options = {}) {
  if (typeof indexOrRoot === 'string') {
    return import('./repo-intelligence.js').then((m) =>
      m.findRelatedTests(indexOrRoot, filePaths, options),
    );
  }
  return findRelatedTestsFromAnalysis(indexOrRoot, filePaths, options);
}
