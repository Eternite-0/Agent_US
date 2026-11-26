import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rmDirSafe } from '../fixtures.js';
import { sha256Hex } from '../../src/integrity.js';
import { mintNonce } from '../../src/envelope.js';
import { Store } from '../../src/store.js';
import { ToolDispatcher } from '../../src/tools/dispatcher.js';
import { ToolPermissionPolicy } from '../../src/tools/policy.js';
import { modelToolCatalog } from '../../src/tools/selection.js';
import { WORKSPACE_TOOL_META, createWorkspaceTools, resolveSafePath } from '../../src/workspace-tools.js';
import {
  applyCodexPatch,
  detectPatchFormat,
  parseAndCompressDiagnosticsOutput,
  parsePatch,
  runDiagnostics,
} from '../../src/patch-and-diagnostics.js';
import {
  analyzeRepository,
  findCrossFileReferences,
  findRelatedTests,
} from '../../src/repo-intelligence.js';
import {
  findCrossFileReferences as findCrossFileRefsFromSymbols,
  findRelatedTests as findRelatedTestsFromSymbols,
} from '../../src/repo-symbols.js';

function createTempWorkspace(t, prefix = 'coding-prim-25-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmDirSafe(root));
  const put = (rel, content) => {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
    return full;
  };
  return { root, put };
}

test('apply_patch transparently accepts standard unified diff (add, update, multi-hunk, delete, move) and Codex format', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'patch-unified-'));
  try {
    writeFileSync(
      join(workDir, 'calc.js'),
      [
        'export function add(a, b) {',
        '-- old comment',
        '  return a + b;',
        '}',
        '',
        'export function sub(a, b) {',
        '  return a - b + 1;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(join(workDir, 'legacy.js'), 'export const oldVal = 1;\n', 'utf8');
    writeFileSync(join(workDir, 'rename_me.js'), 'export const moved = true;\n', 'utf8');

    const unified = [
      'diff --git a/calc.js b/calc.js',
      'index 1111111..2222222 100644',
      '--- a/calc.js',
      '+++ b/calc.js',
      '@@ -1,4 +1,5 @@',
      ' export function add(a, b) {',
      '--- old comment',
      '+  // sum two numbers',
      '+  const out = a + b;',
      '-  return a + b;',
      '+  return out;',
      ' }',
      '@@ -6,3 +7,3 @@',
      ' export function sub(a, b) {',
      '-  return a - b + 1;',
      '+  return a - b;',
      ' }',
      '--- /dev/null',
      '+++ b/src/created.js',
      '@@ -0,0 +1,2 @@',
      '+export const created = 1;',
      '+export const ok = true;',
      '--- a/legacy.js',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-export const oldVal = 1;',
      'diff --git a/rename_me.js b/src/renamed.js',
      'similarity index 100%',
      'rename from rename_me.js',
      'rename to src/renamed.js',
      '--- a/rename_me.js',
      '+++ b/src/renamed.js',
      '@@ -1,1 +1,1 @@',
      '-export const moved = true;',
      '+export const moved = "yes";',
    ].join('\n');

    assert.equal(detectPatchFormat(unified), 'unified');
    assert.equal(parsePatch(unified).format, 'unified');

    const changes = [];
    const touched = applyCodexPatch(unified, {
      workspaceRoot: workDir,
      resolveSafePath,
      onFileChanged: (ch) => changes.push(ch),
    });

    assert.equal(touched.length, 4);
    assert.equal(
      readFileSync(join(workDir, 'calc.js'), 'utf8'),
      [
        'export function add(a, b) {',
        '  // sum two numbers',
        '  const out = a + b;',
        '  return out;',
        '}',
        '',
        'export function sub(a, b) {',
        '  return a - b;',
        '}',
        '',
      ].join('\n'),
    );
    assert.equal(
      readFileSync(join(workDir, 'src/created.js'), 'utf8'),
      'export const created = 1;\nexport const ok = true;\n',
    );
    assert.equal(existsSync(join(workDir, 'legacy.js')), false);
    assert.equal(existsSync(join(workDir, 'rename_me.js')), false);
    assert.equal(readFileSync(join(workDir, 'src/renamed.js'), 'utf8'), 'export const moved = "yes";\n');

    // Backward-compatible & additive FileChange payload assertions
    const calcChange = changes.find((c) => c.path === 'calc.js');
    assert.ok(calcChange);
    assert.equal(calcChange.action, 'updated');
    assert.equal(typeof calcChange.before, 'string');
    assert.equal(typeof calcChange.after, 'string');
    assert.equal(calcChange.additions, 4);
    assert.equal(calcChange.deletions, 3);
    assert.match(calcChange.unifiedDiff, /^--- a\/calc\.js/m);
    assert.match(calcChange.unifiedDiff, /^\+\+\+ b\/calc\.js/m);
    assert.equal(calcChange.sha256After, sha256Hex(readFileSync(join(workDir, 'calc.js'), 'utf8')));

    const delChange = changes.find((c) => c.path === 'legacy.js');
    assert.equal(delChange?.action, 'deleted');
    assert.equal(delChange?.after, null);
    assert.equal(delChange?.sha256After, null);
    assert.equal(delChange?.deletions, 1);

    // Explicit format mismatch must throw cleanly
    assert.throws(() => parsePatch(unified, { format: 'codex' }), /补丁格式无效/);

    // Explicit Codex format + CRLF preservation + No-newline unified diff handling
    writeFileSync(join(workDir, 'crlf.js'), 'export const c = 1;\r\nexport const d = 2;\r\n', 'utf8');
    applyCodexPatch(
      [
        '*** Begin Patch',
        '*** Update File: crlf.js',
        '@@',
        '-export const c = 1;',
        '+export const c = 10;',
        '*** End Patch',
      ].join('\n'),
      { workspaceRoot: workDir, resolveSafePath, format: 'codex' },
    );
    assert.equal(readFileSync(join(workDir, 'crlf.js'), 'utf8'), 'export const c = 10;\r\nexport const d = 2;\r\n');

    applyCodexPatch(
      [
        '--- /dev/null',
        '+++ b/no_nl.txt',
        '@@ -0,0 +1,1 @@',
        '+single line without trailing newline',
        '\\ No newline at end of file',
      ].join('\n'),
      { workspaceRoot: workDir, resolveSafePath, format: 'unified' },
    );
    assert.equal(readFileSync(join(workDir, 'no_nl.txt'), 'utf8'), 'single line without trailing newline');
  } finally {
    rmDirSafe(workDir);
  }
});

test('apply_patch enforces optimistic concurrency lock atomicity via expectedHashes and readFileState', async (t) => {
  const { root, put } = createTempWorkspace(t, 'patch-lock-');
  const dataDir = mkdtempSync(join(tmpdir(), 'patch-lock-data-'));
  t.after(() => rmDirSafe(dataDir));

  const aOrig = 'export const a = 1;\n';
  const bOrig = 'export const b = 1;\n';
  put('a.js', aOrig);
  put('b.js', bOrig);

  // 1. expectedHashes mismatch on second file rejects atomically before touching first file
  let mutatedCount = 0;
  let changedCount = 0;
  assert.throws(
    () =>
      applyCodexPatch(
        [
          '--- a/a.js',
          '+++ b/a.js',
          '@@ -1,1 +1,1 @@',
          '-export const a = 1;',
          '+export const a = 2;',
          '--- a/b.js',
          '+++ b/b.js',
          '@@ -1,1 +1,1 @@',
          '-export const b = 1;',
          '+export const b = 2;',
        ].join('\n'),
        {
          workspaceRoot: root,
          resolveSafePath,
          expectedHashes: {
            'a.js': sha256Hex(aOrig),
            'b.js': '0'.repeat(64),
          },
          onBeforeMutate: () => mutatedCount++,
          onFileChanged: () => changedCount++,
        },
      ),
    (err) => err.code === 'OPTIMISTIC_LOCK_CONFLICT' && /OPTIMISTIC_LOCK_CONFLICT/.test(err.message),
  );
  assert.equal(mutatedCount, 0);
  assert.equal(changedCount, 0);
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), aOrig);
  assert.equal(readFileSync(join(root, 'b.js'), 'utf8'), bOrig);

  // 2. readFileState stale check via workspace tools & ToolDispatcher
  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => store.close());
  const readFileState = new Map();
  const dispatchedChanges = [];
  const tools = createWorkspaceTools({
    workspaceRoot: root,
    store,
    readFileState,
    permissionMode: 'auto-safe',
    toolModes: { patch: true },
    onFileChanged: (c) => dispatchedChanges.push(c),
  });
  const dispatcher = new ToolDispatcher({
    store,
    policy: new ToolPermissionPolicy({ permissionMode: 'auto-safe' }),
  });

  // Read both files first so readFileState tracks hashes
  const reads = await dispatcher.dispatchBatch({
    sessionId: 's-lock',
    turnId: 't-lock-1',
    tools,
    permissionMode: 'auto-safe',
    toolCalls: [
      { id: 'r-a', name: 'read_file', arguments: JSON.stringify({ path: 'a.js' }) },
      { id: 'r-b', name: 'read_file', arguments: JSON.stringify({ path: 'b.js' }) },
    ],
  });
  assert.equal(reads[0].isError, false);
  assert.equal(reads[1].isError, false);

  // Externally mutate b.js behind agent's back
  const bExternal = 'export const b = 999;\n';
  writeFileSync(join(root, 'b.js'), bExternal, 'utf8');

  const [conflictRes] = await dispatcher.dispatchBatch({
    sessionId: 's-lock',
    turnId: 't-lock-2',
    tools,
    permissionMode: 'auto-safe',
    toolCalls: [
      {
        id: 'p-conflict',
        name: 'apply_patch',
        arguments: JSON.stringify({
          patch: [
            '*** Begin Patch',
            '*** Update File: a.js',
            '@@',
            '-export const a = 1;',
            '+export const a = 2;',
            '*** Update File: b.js',
            '@@',
            '-export const b = 1;',
            '+export const b = 2;',
            '*** End Patch',
          ].join('\n'),
        }),
      },
    ],
  });

  assert.equal(conflictRes.isError, true);
  assert.match(conflictRes.output, /OPTIMISTIC_LOCK_CONFLICT/);
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), aOrig, 'a.js must remain untouched on lock conflict');
  assert.equal(readFileSync(join(root, 'b.js'), 'utf8'), bExternal);
  assert.equal(dispatchedChanges.length, 0);

  // Re-read b.js and apply with explicit expectedHashes + inspect compact diff echo
  await dispatcher.dispatchBatch({
    sessionId: 's-lock',
    turnId: 't-lock-3',
    tools,
    permissionMode: 'auto-safe',
    toolCalls: [{ id: 'r-b2', name: 'read_file', arguments: JSON.stringify({ path: 'b.js' }) }],
  });

  const [okRes] = await dispatcher.dispatchBatch({
    sessionId: 's-lock',
    turnId: 't-lock-4',
    tools,
    permissionMode: 'auto-safe',
    toolCalls: [
      {
        id: 'p-ok',
        name: 'apply_patch',
        arguments: JSON.stringify({
          expectedHashes: {
            'a.js': sha256Hex(aOrig),
            'b.js': sha256Hex(bExternal),
          },
          patch: [
            '--- a/a.js',
            '+++ b/a.js',
            '@@ -1,1 +1,1 @@',
            '-export const a = 1;',
            '+export const a = 2;',
            '--- a/b.js',
            '+++ b/b.js',
            '@@ -1,1 +1,1 @@',
            '-export const b = 999;',
            '+export const b = 1000;',
          ].join('\n'),
        }),
      },
    ],
  });

  assert.equal(okRes.isError, false);
  assert.match(okRes.output, /\+1\/-1/);
  assert.match(okRes.output, /sha256:/);
  assert.match(okRes.output, /\+export const a = 2;/);
  assert.equal(dispatchedChanges.length, 2);
  assert.equal(dispatchedChanges[0].sha256After, sha256Hex('export const a = 2;\n'));
});

test('apply_patch rejects syntax errors atomically pre-commit across JS/MJS/JSON unless allowSyntaxError is true', (t) => {
  const { root, put } = createTempWorkspace(t, 'patch-syntax-');
  const validOrig = 'export const ok = 1;\n';
  const esmOrig = 'import { ok } from "./valid.js";\nexport function run() {\n  return ok;\n}\n';
  const cfgOrig = '{"port": 3000}\n';
  put('package.json', JSON.stringify({ name: 'syn-test', type: 'module' }));
  put('valid.js', validOrig);
  put('esm.js', esmOrig);
  put('config.json', cfgOrig);

  // 1. Valid file 1 + broken ESM JS file 2 -> rejects atomically, file 1 untouched
  assert.throws(
    () =>
      applyCodexPatch(
        [
          '--- a/valid.js',
          '+++ b/valid.js',
          '@@ -1,1 +1,1 @@',
          '-export const ok = 1;',
          '+export const ok = 2;',
          '--- a/esm.js',
          '+++ b/esm.js',
          '@@ -2,3 +2,3 @@',
          ' export function run() {',
          '-  return ok;',
          '+  return (;',
          ' }',
        ].join('\n'),
        { workspaceRoot: root, resolveSafePath },
      ),
    (err) => err.code === 'SYNTAX_VALIDATION_ERROR' && /esm\.js:3/.test(err.message),
  );
  assert.equal(readFileSync(join(root, 'valid.js'), 'utf8'), validOrig);
  assert.equal(readFileSync(join(root, 'esm.js'), 'utf8'), esmOrig);

  // 2. Valid file 1 + broken JSON file 2 -> rejects atomically
  assert.throws(
    () =>
      applyCodexPatch(
        [
          '*** Begin Patch',
          '*** Update File: valid.js',
          '@@',
          '-export const ok = 1;',
          '+export const ok = 2;',
          '*** Update File: config.json',
          '@@',
          '-{"port": 3000}',
          '+{"port": 3000,}',
          '*** End Patch',
        ].join('\n'),
        { workspaceRoot: root, resolveSafePath },
      ),
    (err) => err.code === 'SYNTAX_VALIDATION_ERROR' && /config\.json:1/.test(err.message),
  );
  assert.equal(readFileSync(join(root, 'valid.js'), 'utf8'), validOrig);
  assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), cfgOrig);

  // 3. Explicit allowSyntaxError: true allows writing
  const touched = applyCodexPatch(
    [
      '--- a/config.json',
      '+++ b/config.json',
      '@@ -1,1 +1,1 @@',
      '-{"port": 3000}',
      '+{"port": 3000,}',
    ].join('\n'),
    { workspaceRoot: root, resolveSafePath, allowSyntaxError: true },
  );
  assert.equal(touched.length, 1);
  assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), '{"port": 3000,}\n');
});

test('run_diagnostics compresses 1200-line noisy output, executes syntax/test checks safely, and is promoted in selection.js', async (t) => {
  const { root, put } = createTempWorkspace(t, 'diag-25-');
  const dataDir = mkdtempSync(join(tmpdir(), 'diag-25-data-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'diag-25-out-'));
  t.after(() => {
    rmDirSafe(dataDir);
    rmDirSafe(outsideDir);
  });

  // 1. 1200-line noisy compiler + test + duplicate diagnostic compression
  const noisyLines = [];
  for (let i = 0; i < 950; i++) {
    noisyLines.push(`✔ passing test case #${i} (0.12ms)`);
  }
  for (let i = 0; i < 240; i++) {
    noisyLines.push('src/duplicated.ts(14,5): error TS2322: Type string is not assignable to type number.');
  }
  noisyLines.push('src/other.ts:22:9 - error TS2304: Cannot find name missingVar.');
  noisyLines.push('✖ rejects invalid payload (2.5ms)');
  noisyLines.push('  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 200 !== 400');
  noisyLines.push('  at TestContext.<anonymous> (test/api.test.js:18:5)');
  noisyLines.push('✖ rejects invalid payload (2.5ms)');
  noisyLines.push('  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 200 !== 400');
  noisyLines.push('  at TestContext.<anonymous> (test/api.test.js:18:5)');

  const rawText = noisyLines.join('\n');
  const compressed = parseAndCompressDiagnosticsOutput(rawText, { kind: 'auto', maxDiagnostics: 25 });
  assert.equal(compressed.ok, false);
  assert.ok(compressed.compression.rawLines >= 1190);
  assert.equal(compressed.diagnostics.length, 2, 'duplicate TS diagnostics must be deduplicated');
  assert.equal(compressed.failingTests.length, 1, 'duplicate failing tests must be deduplicated');
  assert.equal(compressed.diagnostics[0].code, 'TS2322');
  assert.equal(compressed.diagnostics[1].code, 'TS2304');
  assert.equal(compressed.failingTests[0].file, 'test/api.test.js');
  assert.ok(compressed.compression.keptLines <= 5);
  assert.ok(compressed.compression.truncatedCount >= 1185);

  // 2. Real workspace syntax + node --test checks via ToolDispatcher in read-only mode
  put('package.json', JSON.stringify({ name: 'diag-demo', type: 'module' }));
  put('src/good.js', 'export const add = (a, b) => a + b;\n');
  put('src/broken.js', 'export function broken( {\n  return 1;\n}\n');
  put(
    'test/sample.test.js',
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/good.js';",
      "test('passing math', () => { assert.equal(add(1, 2), 3); });",
      "test('failing case', () => { assert.equal(add(1, 2), 99); });",
    ].join('\n'),
  );
  put('.env', 'SECRET=TOP_SECRET\n');
  writeFileSync(join(outsideDir, 'secret.js'), 'export const s = 1;\n', 'utf8');
  try {
    symlinkSync(outsideDir, join(root, 'escape_dir'), 'junction');
  } catch {
    // skip symlink test if OS forbids junction/symlink
  }

  assert.equal(WORKSPACE_TOOL_META.run_diagnostics?.readOnly, true);

  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => store.close());
  const nonce = mintNonce();
  const defaultTools = createWorkspaceTools({
    workspaceRoot: root,
    store,
    nonce,
    permissionMode: 'read-only',
  });
  assert.equal(defaultTools.length, 6, `default tools must converge to 6 core primitives, got ${defaultTools.length}`);
  assert.equal(defaultTools.find((tl) => tl.name === 'apply_patch'), undefined);
  assert.equal(defaultTools.find((tl) => tl.name === 'run_diagnostics'), undefined);

  const tools = createWorkspaceTools({
    workspaceRoot: root,
    store,
    nonce,
    permissionMode: 'read-only',
    toolModes: { diagnostics: true, patch: true },
  });
  const dispatcher = new ToolDispatcher({
    store,
    policy: new ToolPermissionPolicy({ permissionMode: 'read-only' }),
  });

  const [synResItem, testResItem] = await dispatcher.dispatchBatch({
    sessionId: 's-diag',
    turnId: 't-diag-1',
    permissionMode: 'read-only',
    tools,
    toolCalls: [
      { id: 'd-syn', name: 'run_diagnostics', arguments: JSON.stringify({ kind: 'syntax', paths: ['src'] }) },
      {
        id: 'd-test',
        name: 'run_diagnostics',
        arguments: JSON.stringify({ kind: 'test', paths: ['test/sample.test.js'], testPattern: 'failing case' }),
      },
    ],
  });

  const extractJson = (text) => {
    const start = text.indexOf('{"ok":');
    assert.ok(start !== -1, `Expected JSON payload in:\n${text}`);
    const end = text.lastIndexOf('}');
    return JSON.parse(text.slice(start, end + 1));
  };

  assert.equal(synResItem.isError, false);
  const synPayload = extractJson(synResItem.output);
  assert.equal(synPayload.ok, false);
  assert.equal(synPayload.diagnostics.length, 1);
  assert.equal(synPayload.diagnostics[0].file, 'src/broken.js');
  assert.equal(synPayload.diagnostics[0].code, 'SYNTAX_ERROR');

  assert.equal(testResItem.isError, false);
  const testPayload = extractJson(testResItem.output);
  assert.equal(testPayload.ok, false);
  assert.equal(testPayload.failingTests.length, 1);
  assert.ok(testPayload.failingTests[0].name.includes('failing case'));
  assert.equal(testPayload.failingTests[0].file, 'test/sample.test.js');

  // Passing test filter via testPattern
  const passRun = runDiagnostics(root, {
    kind: 'test',
    paths: ['test/sample.test.js'],
    testPattern: 'passing math',
  });
  assert.equal(passRun.ok, true);
  assert.equal(passRun.failingTests.length, 0);

  // Sandbox confinement blocks protected paths & outside traversal
  for (const badPath of ['../outside.js', '.env', '.git/config', 'upstream/a.js', 'backend/var/a.js']) {
    assert.throws(() => runDiagnostics(root, { kind: 'syntax', paths: [badPath] }), /不允许|受保护|边界/);
  }

  // Selection catalog promotion: apply_patch before write_file, run_diagnostics before bash
  const policy = new ToolPermissionPolicy({ permissionMode: 'auto-safe' });
  const catalog = modelToolCatalog(tools, policy, { permissionMode: 'auto-safe' });
  const names = catalog.map((c) => c.name);
  assert.ok(names.indexOf('apply_patch') < names.indexOf('write_file'));
  assert.ok(names.indexOf('run_diagnostics') < names.indexOf('bash'));
  const writeDesc = catalog.find((c) => c.name === 'write_file').description;
  const bashDesc = catalog.find((c) => c.name === 'bash').description;
  assert.match(writeDesc, /apply_patch/);
  assert.match(bashDesc, /run_diagnostics/);
});

test('repo-intelligence incremental symbol cache hits on unchanged files and invalidates on same-size edits', async (t) => {
  const { root, put } = createTempWorkspace(t, 'repo-cache-25-');
  for (let i = 0; i < 8; i++) {
    put(`src/mod${i}.js`, `export function fn${i}(v) { return v + ${i}; }\n`);
  }
  put('src/target.js', 'export function alphaOne() { return 1; }\n');

  const first = await analyzeRepository(root, { progressive: true });
  assert.equal(first.index.complete, true);
  assert.equal(first.index.indexedFiles, 9);
  assert.equal(first.cacheStats.misses, 9);
  assert.equal(first.cacheStats.hits, 0);

  // Re-scan with no edits: 0 files parsed, all 9 reused
  const second = await analyzeRepository(root, { progressive: true });
  assert.equal(second.cacheStats.parsedFiles, 0);
  assert.equal(second.cacheStats.reusedFiles, 9);

  // Same-size edit on ONE file (`alphaOne` -> `omegaTwo`, exact same character length 8!)
  put('src/target.js', 'export function omegaTwo() { return 1; }\n');
  const third = await analyzeRepository(root, { progressive: true });
  assert.equal(third.cacheStats.parsedFiles, 1, 'only the single edited file should be re-parsed');
  assert.equal(third.cacheStats.hits, 8, 'all 8 unchanged files should hit symbol cache');
  assert.equal(third.cacheStats.reusedFiles, 8);
  assert.equal(third.callGraph.symbols.some((s) => s.name === 'alphaOne'), false);
  assert.equal(third.callGraph.symbols.some((s) => s.name === 'omegaTwo'), true);

  // Touching mtime on a single file invalidates only that file
  const mod0Path = join(root, 'src/mod0.js');
  const future = new Date(Date.now() + 10_000);
  utimesSync(mod0Path, future, future);
  const fourth = await analyzeRepository(root, { progressive: true });
  assert.equal(fourth.cacheStats.parsedFiles, 1);
  assert.equal(fourth.cacheStats.hits, 8);

  // Deleting a file evicts it from index and cache
  unlinkSync(join(root, 'src/mod7.js'));
  const fifth = await analyzeRepository(root, { progressive: true });
  assert.equal(fifth.index.indexedFiles, 8);
  assert.equal(fifth.callGraph.symbols.some((s) => s.name === 'fn7'), false);
});

test('findCrossFileReferences, findRelatedTests, and inspect_repository return callers, importers, and tests', async (t) => {
  const { root, put } = createTempWorkspace(t, 'repo-refs-25-');
  const dataDir = mkdtempSync(join(tmpdir(), 'repo-refs-data-'));
  t.after(() => rmDirSafe(dataDir));

  put('package.json', JSON.stringify({ name: 'refs-demo', type: 'module' }));
  put('src/core/math.js', 'export function roundPrice(v) { return Math.round(v * 100) / 100; }\n');
  put('src/core/index.js', "export { roundPrice } from './math.js';\n");
  put(
    'src/billing/checkout.js',
    [
      "import { roundPrice as normalizeMoney } from '../core/index.js';",
      'export function totalOrder(items) {',
      '  return normalizeMoney(items.reduce((s, x) => s + x, 0));',
      '}',
    ].join('\n'),
  );
  put(
    'src/billing/invoice.js',
    [
      "import { roundPrice } from '../core/math.js';",
      'export function formatInvoice(v) { return String(roundPrice(v)); }',
    ].join('\n'),
  );
  put('test/unit/math.test.mjs', '// naming convention match without direct import\n');
  put(
    'test/integration/checkout.test.js',
    "import { totalOrder } from '../../src/billing/checkout.js';\nconsole.log(totalOrder([1.234]));\n",
  );

  // 1. Direct calls from both repo-intelligence.js and repo-symbols.js (root string & analysis object)
  const analysis = await analyzeRepository(root);
  const refsSync = findCrossFileRefsFromSymbols(analysis, 'roundPrice');
  const refsAsync = await findCrossFileReferences(root, 'roundPrice');

  for (const refs of [refsSync, refsAsync]) {
    assert.equal(refs.definitions.length, 1);
    assert.equal(refs.definitions[0].path, 'src/core/math.js');
    assert.ok(refs.callers.some((c) => c.path === 'src/billing/invoice.js' && c.crossFile === true));
    assert.ok(refs.importers.some((im) => im.from === 'src/billing/invoice.js'));
    assert.ok(refs.importers.some((im) => im.from === 'src/billing/checkout.js'));
    assert.ok(refs.files.includes('src/core/math.js'));
    assert.ok(refs.files.includes('src/billing/invoice.js'));
    assert.ok(refs.files.includes('src/billing/checkout.js'));
  }

  // 2. findRelatedTests combines reverse import graph (direct + transitive) and naming conventions
  const relSync = findRelatedTestsFromSymbols(analysis, ['src/core/math.js']);
  const relAsync = await findRelatedTests(root, ['src/core/math.js']);
  for (const rel of [relSync, relAsync]) {
    assert.ok(rel.tests.includes('test/unit/math.test.mjs'), 'should discover naming-convention test');
    assert.ok(
      rel.tests.includes('test/integration/checkout.test.js'),
      'should discover transitive reverse-import test via core/index.js -> billing/checkout.js',
    );
  }

  // 3. inspect_repository exposes relatedTo and includeRelatedTests safely via ToolDispatcher
  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => store.close());
  const tools = createWorkspaceTools({
    workspaceRoot: root,
    store,
    permissionMode: 'read-only',
    toolModes: { repoIntelligence: true },
  });
  const dispatcher = new ToolDispatcher({
    store,
    policy: new ToolPermissionPolicy({ permissionMode: 'read-only' }),
  });

  const [inspectRes] = await dispatcher.dispatchBatch({
    sessionId: 's-refs',
    turnId: 't-refs-1',
    permissionMode: 'read-only',
    tools,
    toolCalls: [
      {
        id: 'ir-1',
        name: 'inspect_repository',
        arguments: JSON.stringify({
          relatedTo: ['src/core/math.js', 'roundPrice'],
          includeRelatedTests: true,
        }),
      },
    ],
  });

  assert.equal(inspectRes.isError, false);
  assert.match(inspectRes.output, /## Cross-File References/);
  assert.match(inspectRes.output, /src\/billing\/invoice\.js/);
  assert.match(inspectRes.output, /## Related Tests/);
  assert.match(inspectRes.output, /test\/unit\/math\.test\.mjs/);
  assert.match(inspectRes.output, /test\/integration\/checkout\.test\.js/);

  const inspectTool = tools.find((tl) => tl.name === 'inspect_repository');
  await assert.rejects(
    () => inspectTool.execute({ relatedTo: ['../secret.js'] }),
    /不允许|受保护|边界/,
  );
  await assert.rejects(
    () => inspectTool.execute({ relatedTo: ['.env'] }),
    /不允许|受保护|边界/,
  );
});
