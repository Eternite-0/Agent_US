import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, linkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  analyzeRepository,
  findRepositorySymbols,
  traceRepositoryCalls,
  getRelatedRepositoryContext,
} from '../src/repo-intelligence.js';
import { rmDirSafe } from './fixtures.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'repo-index-'));
  t.after(() => rmDirSafe(root));
  const put = (path, content) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  return {
    root,
    put,
    advance: (options) => analyzeRepository(root, { progressive: true, ...options }),
  };
}

test('shared cursor serializes consumers, finishes wide and deep directories, isolates and refreshes snapshots', async (t) => {
  const a = fixture(t),
    b = fixture(t);
  for (let i = 0; i < 10; i++) a.put(`part${i}.js`, `export const part${i} = 1;`);
  a.put('z/deep/last.js', 'export function tailSymbol() {}');
  b.put('other.js', 'export const other = 1;');
  const pages = await Promise.all([
    a.advance({ maxFiles: 3 }),
    a.advance({ maxFiles: 3 }),
    b.advance({ maxFiles: 3 }),
  ]);
  assert.deepEqual(
    pages.map((p) => p.index.indexedFiles),
    [3, 6, 1],
  );
  assert.equal(findRepositorySymbols(pages[0], 'tailSymbol').length, 0);
  const partial = await a.advance({ maxFiles: 3 });
  assert.equal(partial.index.complete, false);
  const done = await a.advance({ maxFiles: 3 });
  assert.deepEqual(done.index, { batchFiles: 2, complete: true, indexedFiles: 11 });
  assert.equal(findRepositorySymbols(done, 'tailSymbol')[0].path, 'z/deep/last.js');
  assert.equal((await a.advance()).index.batchFiles, 0);
  unlinkSync(join(a.root, 'z/deep/last.js'));
  a.put('new.js', 'export function replacement() {}');
  const refreshed = await a.advance({ refresh: true });
  assert.equal(findRepositorySymbols(refreshed, 'tailSymbol').length, 0);
  assert.equal(findRepositorySymbols(refreshed, 'replacement').length, 1);
});

test('symbol search, forward and reverse calls, alias resolution, recursion, methods and linked tests', async (t) => {
  const a = fixture(t);
  a.put('a.ts', "import { middle as mid } from './b.js';\nexport const start = () => mid();");
  a.put('b.ts', "import * as c from './c.js';\nexport function middle() { return c.leaf(); }");
  a.put('c.ts', 'export function leaf() { return leaf(); }');
  a.put(
    'other.ts',
    "export function leaf() {}\nfunction unused() { /* leaf(); */ const s = 'leaf()'; obj.leaf(); }",
  );
  a.put('service.ts', 'export class Service {\n run() { return this.work(); }\n work() {}\n}');
  a.put('test/feature.test.ts', "import { middle } from '../b.js';\nmiddle();");
  a.put('parser.py', 'class Parser:\n    def process(self): pass');
  const opts = { maxFiles: 2, issueText: 'where is middle used?' };
  let result = await a.advance(opts);
  while (!result.index.complete) result = await a.advance(opts);
  assert.equal(findRepositorySymbols(result, 'process')[0].line, 2);
  assert.deepEqual(
    findRepositorySymbols(result, 'leaf').map((s) => s.path),
    ['c.ts', 'other.ts'],
  );
  const leaf = findRepositorySymbols(result, 'leaf', { path: 'c.ts' })[0];
  const middle = findRepositorySymbols(result, 'middle')[0];
  const start = findRepositorySymbols(result, 'start')[0];
  const forward = traceRepositoryCalls(result, 'start').edges;
  assert.deepEqual(
    forward.map((e) => [e.from, e.to, e.depth]),
    [
      [start.id, middle.id, 1],
      [middle.id, leaf.id, 2],
      [leaf.id, leaf.id, 3],
    ],
  );
  assert.equal(traceRepositoryCalls(result, 'start', { maxDepth: 1 }).edges.length, 1);
  assert.equal(traceRepositoryCalls(result, 'start', { limit: 1 }).edges.length, 1);
  assert.deepEqual(
    traceRepositoryCalls(result, leaf.id, { direction: 'callers' }).edges.map((e) => e.from),
    [middle.id, leaf.id, start.id],
  );
  assert.equal(traceRepositoryCalls(result, 'unused').edges.length, 0);
  assert.equal(
    traceRepositoryCalls(result, 'run').edges[0].to,
    findRepositorySymbols(result, 'work')[0].id,
  );
  assert.deepEqual(result.relatedContext.tests, ['test/feature.test.ts']);
  assert.deepEqual(getRelatedRepositoryContext(result, 'middle').files.sort(), [
    'a.ts',
    'b.ts',
    'c.ts',
  ]);
  assert.ok(getRelatedRepositoryContext(result, 'b.ts').files.includes('test/feature.test.ts'));
  assert.match(result.summaryText, /middle -> leaf/);
  const focused = await a.advance({ symbol: 'start' });
  assert.ok(focused.relatedContext.calls.some((edge) => edge.to === leaf.id));
  assert.match(focused.summaryText, /Related Code.*repository excerpts/);
  assert.ok(focused.relatedContext.snippets.some((snippet) =>
    snippet.path === start.path && snippet.text.includes('const start')));
});

test('all pages honor nested ignores, forbidden roots, manifest paths, links and byte caps', async (t) => {
  const a = fixture(t),
    outside = fixture(t);
  outside.put('package.json', '{"scripts":{"test":"CANARY"}}');
  a.put(
    'package.json',
    JSON.stringify({
      main: '../escape.js',
      workspaces: ['upstream', 'backend/var', '../escape', 'alias'],
    }),
  );
  const withheld = 'export function PRIVATE_CANARY() {}';
  for (const file of ['upstream/package.json', 'backend/var/package.json'])
    a.put(file, '{"scripts":{"test":"CANARY"}}');
  for (const file of [
    '.aws/config.js',
    '.ssh/key.js',
    '.env.local.js',
    'credentials.json',
    'backend/var/key.js',
    'upstream/src/lib.js',
    'src/ignored.js',
    '.pool-key',
    '.dev-token',
    '.provider-env.json',
  ])
    a.put(file, withheld);
  a.put('src/.gitignore', 'ignored.js\n!../upstream');
  a.put('src/good.js', `export const visible = true;\n${' '.repeat(130 * 1024)}${withheld}`);
  symlinkSync(
    outside.root,
    join(a.root, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  linkSync(join(a.root, '.dev-token'), join(a.root, 'alias.js'));
  for (const rel of ['upstream/src', 'backend/var', '.aws']) {
    await assert.rejects(analyzeRepository(join(a.root, rel)), /protected/i);
  }
  let result;
  do {
    result = await a.advance({ maxFiles: 1, issueText: 'PRIVATE_CANARY' });
    assert.doesNotMatch(
      JSON.stringify(result),
      /CANARY|escape\.js|backend\/var|upstream|\.dev-token|\.pool-key/,
    );
  } while (!result.index.complete);
  assert.equal(findRepositorySymbols(result, 'visible').length, 1);
  assert.deepEqual(result.project.manifests, ['package.json']);
});

test('ordinary progressive reads invalidate prior symbols, calls and linked context after same-size edits, deletions and changes to ignore rules', async (t) => {
  const a = fixture(t);
  a.put('.gitignore', '# initial\n');
  a.put('lib.js', 'export function first() {}');
  a.put('main.js', "import { first } from './lib.js';\nexport function entry() { first(); }");
  const opts = { symbol: 'first' };
  const initial = await a.advance(opts);
  assert.equal(initial.relatedContext.calls.length, 1);
  a.put('lib.js', 'export function fresh() {}');
  const edited = await a.advance(opts);
  assert.deepEqual(edited.relatedContext.symbols, []);
  assert.deepEqual(edited.callGraph.calls, []);
  assert.equal(findRepositorySymbols(edited, 'fresh').length, 1);
  a.put('.gitignore', 'lib.js\n');
  assert.equal(findRepositorySymbols(await a.advance(), 'fresh').length, 0);
  unlinkSync(join(a.root, 'main.js'));
  a.put('added.js', 'export const added = 1;');
  const changed = await a.advance();
  assert.deepEqual(changed.structure.sourceFiles, ['added.js']);
  assert.equal(findRepositorySymbols(changed, 'entry').length, 0);
});

test('replacing a previously indexed file or directory with a link evicts cached results without following it', async (t) => {
  const a = fixture(t),
    b = fixture(t);
  a.put('active.js', 'export function oldFile() {}');
  a.put('nested/item.js', 'export function oldNested() {}');
  b.put('item.js', 'export function outsideScope() {}');
  assert.equal(findRepositorySymbols(await a.advance(), 'old').length, 2);
  unlinkSync(join(a.root, 'active.js'));
  try {
    symlinkSync(join(b.root, 'item.js'), join(a.root, 'active.js'), 'file');
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
    // Windows accounts without symlink privilege can still replace a .js path with a junction.
    symlinkSync(b.root, join(a.root, 'active.js'), 'junction');
  }
  rmDirSafe(join(a.root, 'nested'));
  symlinkSync(b.root, join(a.root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  const current = await a.advance({ issueText: 'oldFile oldNested outsideScope' });
  assert.deepEqual(current.structure.sourceFiles, []);
  assert.deepEqual(current.callGraph.symbols, []);
  assert.deepEqual(current.relatedContext.files, []);
});
