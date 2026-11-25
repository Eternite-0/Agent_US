import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmDirSafe } from '../fixtures.js';
import { Store } from '../../src/store.js';
import { mintNonce } from '../../src/envelope.js';
import { ToolDispatcher, isParallelReadTool } from '../../src/tools/dispatcher.js';
import { ToolPermissionPolicy } from '../../src/tools/policy.js';
import { modelToolCatalog } from '../../src/tools/selection.js';
import { WORKSPACE_TOOL_META, createWorkspaceTools } from '../../src/workspace-tools.js';
import {
  normalizeDiagnosticFile,
  parseAndCompressDiagnosticsOutput,
  resolveTscRunner,
  runDiagnostics,
} from '../../src/patch-and-diagnostics.js';
import { querySymbolGraph } from '../../src/repo-intelligence.js';
import { AgentCapabilityRegistry } from '../../src/swarm/capabilities.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_TSC_JS = resolve(__dirname, '../../node_modules/typescript/bin/tsc');

function createTempWorkspace(t, prefix = 'diag-26-') {
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

function extractDiagJson(text) {
  const start = text.indexOf('{"ok":');
  assert.ok(start !== -1, `Expected JSON payload in:\n${text}`);
  const end = text.lastIndexOf('}');
  return JSON.parse(text.slice(start, end + 1));
}

test('run_diagnostics executes incremental tsc --noEmit --pretty false using nearest tsconfig.json and local .bin/tsc or PATH', async (t) => {
  assert.equal(existsSync(REAL_TSC_JS), true, 'Expected TypeScript compiler in backend/node_modules');

  const { root, put } = createTempWorkspace(t, 'diag-26-tsc-');
  const dataDir = mkdtempSync(join(tmpdir(), 'diag-26-tsc-data-'));
  t.after(() => rmDirSafe(dataDir));

  // Root tsconfig.json (covers root-only file) vs nested nearest tsconfig.json (packages/web/tsconfig.json)
  put(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', noEmit: true },
      include: ['root-only.ts'],
    }),
  );
  put('root-only.ts', 'export const okRoot: number = 1;\n');

  put(
    'packages/web/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'ESNext',
        jsx: 'react-jsx',
        noEmit: true,
      },
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    }),
  );
  put(
    'packages/web/src/Button.tsx',
    [
      'export function renderCount(n: number): string {',
      '  const bad: number = "not-a-number";',
      '  return String(bad + n);',
      '}',
      '',
    ].join('\n'),
  );

  // Install local node_modules/.bin/tsc shim invoking the real TypeScript compiler safely
  const tscUrl = pathToFileURL(REAL_TSC_JS).href;
  put('node_modules/.bin/tsc', `#!/usr/bin/env node\nimport ${JSON.stringify(tscUrl)};\n`);

  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => store.close());
  const tools = createWorkspaceTools({
    workspaceRoot: root,
    store,
    nonce: mintNonce(),
    permissionMode: 'read-only',
  });
  const dispatcher = new ToolDispatcher({
    store,
    policy: new ToolPermissionPolicy({ permissionMode: 'read-only' }),
  });

  // 1. kind='auto' with .tsx target resolves nearest packages/web/tsconfig.json and returns structured source='tsc'
  const [autoRes] = await dispatcher.dispatchBatch({
    sessionId: 's-tsc-1',
    turnId: 't-tsc-1',
    permissionMode: 'read-only',
    tools,
    toolCalls: [
      {
        id: 'tc-tsc-auto',
        name: 'run_diagnostics',
        arguments: JSON.stringify({ kind: 'auto', paths: ['packages/web/src/Button.tsx'] }),
      },
    ],
  });
  assert.equal(autoRes.isError, false);
  const autoPayload = extractDiagJson(autoRes.output);
  assert.equal(autoPayload.ok, false);
  assert.equal(autoPayload.diagnostics.length, 1);
  assert.deepEqual(
    {
      file: autoPayload.diagnostics[0].file,
      line: autoPayload.diagnostics[0].line,
      column: autoPayload.diagnostics[0].column,
      severity: autoPayload.diagnostics[0].severity,
      code: autoPayload.diagnostics[0].code,
      source: autoPayload.diagnostics[0].source,
    },
    {
      file: 'packages/web/src/Button.tsx',
      line: 2,
      column: 9,
      severity: 'error',
      code: 'TS2322',
      source: 'tsc',
    },
  );
  assert.match(autoPayload.diagnostics[0].message, /not assignable/i);

  // 2. PATH resolution works without local node_modules/.bin/tsc and without shell injection
  const pathBinDir = mkdtempSync(join(tmpdir(), 'diag-26-pathbin-'));
  t.after(() => rmDirSafe(pathBinDir));
  const pathTscFile = join(pathBinDir, 'tsc');
  writeFileSync(pathTscFile, `#!/usr/bin/env node\nimport ${JSON.stringify(tscUrl)};\n`, 'utf8');
  const resolvedFromPath = resolveTscRunner([], pathBinDir);
  assert.ok(resolvedFromPath, 'resolveTscRunner should locate tsc via PATH');

  const pathWs = mkdtempSync(join(tmpdir(), 'diag-26-pathws-'));
  t.after(() => rmDirSafe(pathWs));
  writeFileSync(
    join(pathWs, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['bad.ts'] }),
  );
  writeFileSync(join(pathWs, 'bad.ts'), 'export const x: boolean = 123;\n', 'utf8');
  const prevPath = process.env.PATH;
  process.env.PATH = pathBinDir;
  try {
    const pathDiag = runDiagnostics(pathWs, { kind: 'typecheck' });
    assert.equal(pathDiag.ok, false);
    assert.equal(pathDiag.diagnostics.length, 1);
    assert.equal(pathDiag.diagnostics[0].file, 'bad.ts');
    assert.equal(pathDiag.diagnostics[0].code, 'TS2322');
    assert.equal(pathDiag.diagnostics[0].source, 'tsc');
  } finally {
    process.env.PATH = prevPath;
  }

  // 3. Fix Button.tsx -> typecheck passes cleanly
  put(
    'packages/web/src/Button.tsx',
    [
      'export function renderCount(n: number): string {',
      '  const good: number = 42;',
      '  return String(good + n);',
      '}',
      '',
    ].join('\n'),
  );
  const cleanDiag = runDiagnostics(root, {
    kind: 'typecheck',
    paths: ['packages/web/src/Button.tsx'],
  });
  assert.equal(cleanDiag.ok, true);
  assert.deepEqual(cleanDiag.diagnostics, []);
});

test('run_diagnostics extracts precise node --test AssertionError expected/actual/operator/testName and file:line:col into failingTests and diagnostics', async (t) => {
  const { root, put } = createTempWorkspace(t, 'diag-26-ntest-');
  put('package.json', JSON.stringify({ name: 'ntest-26', type: 'module' }));
  const passingTests = Array.from(
    { length: 24 },
    (_, i) => `test('noise pass ${i}', () => { assert.equal(${i}, ${i}); });`,
  ).join('\n');
  put(
    'test/assertions.test.js',
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      passingTests,
      "test('scalar mismatch', () => {",
      '  assert.equal(10, 20);',
      '});',
      "test('object mismatch', () => {",
      "  assert.deepEqual({ a: 1, b: 'x' }, { a: 1, b: 'y' });",
      '});',
      "test('nested suite', async (t) => {",
      "  await t.test('inner strict match', () => {",
      "    assert.strictEqual('alpha', 'beta');",
      '  });',
      '});',
      '',
    ].join('\n'),
  );

  const res = runDiagnostics(root, { kind: 'test', paths: ['test/assertions.test.js'] });
  assert.equal(res.ok, false);
  assert.equal(res.failingTests.length, 3, 'nested suite parent should not create duplicate failure');
  assert.equal(res.diagnostics.length, 3);
  assert.ok(res.compression.rawLines > 20);
  assert.ok(res.compression.truncatedCount > 10);

  const scalarFail = res.failingTests.find((f) => f.testName === 'scalar mismatch');
  assert.ok(scalarFail);
  assert.equal(scalarFail.name, 'scalar mismatch');
  assert.equal(scalarFail.file, 'test/assertions.test.js');
  assert.equal(scalarFail.line, 28, 'must pinpoint exact assert.equal line, not test() line');
  assert.ok(scalarFail.column > 1);
  assert.equal(scalarFail.actual, '10');
  assert.equal(scalarFail.expected, '20');
  assert.equal(scalarFail.operator, 'strictEqual');
  assert.equal(scalarFail.code, 'ERR_ASSERTION');

  const objFail = res.failingTests.find((f) => f.testName === 'object mismatch');
  assert.ok(objFail);
  assert.equal(objFail.line, 31);
  assert.equal(objFail.operator, 'deepStrictEqual');
  assert.match(String(objFail.actual), /b:\s*'x'/);
  assert.match(String(objFail.expected), /b:\s*'y'/);

  const innerFail = res.failingTests.find((f) => f.testName === 'inner strict match');
  assert.ok(innerFail);
  assert.equal(innerFail.line, 35);
  assert.equal(innerFail.actual, 'alpha');
  assert.equal(innerFail.expected, 'beta');
  assert.equal(innerFail.operator, 'strictEqual');

  for (const d of res.diagnostics) {
    assert.equal(d.source, 'node-test');
    assert.equal(d.file, 'test/assertions.test.js');
    assert.equal(d.severity, 'error');
    assert.equal(d.code, 'ERR_ASSERTION');
    assert.ok(d.testName);
  }
  const scalarDiag = res.diagnostics.find((d) => d.testName === 'scalar mismatch');
  assert.equal(scalarDiag.line, 28);
  assert.equal(scalarDiag.expected, '20');
  assert.equal(scalarDiag.actual, '10');
  assert.equal(scalarDiag.operator, 'strictEqual');

  // TAP reporter output parsing parity
  const tapSample = [
    'TAP version 13',
    '# Subtest: tap scalar check',
    'not ok 1 - tap scalar check',
    '  ---',
    "  location: 'test/tap.test.js:3:1'",
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    4 !== 5',
    "  code: 'ERR_ASSERTION'",
    "  name: 'AssertionError'",
    '  expected: 5',
    '  actual: 4',
    "  operator: 'strictEqual'",
    '  stack: |-',
    '    TestContext.<anonymous> (file:///repo/test/tap.test.js:4:10)',
    '  ...',
    '1..1',
  ].join('\n');
  const parsedTap = parseAndCompressDiagnosticsOutput(tapSample, {
    kind: 'test',
    workspaceRoot: '/repo',
  });
  assert.equal(parsedTap.ok, false);
  assert.equal(parsedTap.failingTests.length, 1);
  assert.equal(parsedTap.failingTests[0].testName, 'tap scalar check');
  assert.equal(parsedTap.failingTests[0].line, 4);
  assert.equal(parsedTap.failingTests[0].column, 10);
  assert.equal(parsedTap.failingTests[0].expected, '5');
  assert.equal(parsedTap.failingTests[0].actual, '4');
  assert.equal(parsedTap.failingTests[0].operator, 'strictEqual');
  assert.equal(parsedTap.diagnostics[0].source, 'node-test');
  assert.equal(parsedTap.diagnostics[0].line, 4);
});

test('query_symbol_graph returns definitions with endLine/signature, cross-file callers/importers, related tests, and is wired in policy/selection/swarm', async (t) => {
  const { root, put } = createTempWorkspace(t, 'symgraph-26-');
  const dataDir = mkdtempSync(join(tmpdir(), 'symgraph-26-data-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'symgraph-26-out-'));
  t.after(() => {
    rmDirSafe(dataDir);
    rmDirSafe(outsideDir);
  });

  put('package.json', JSON.stringify({ name: 'symgraph-demo', type: 'module' }));
  put(
    'src/core/pricing.js',
    [
      'export function computeSubtotal(items, taxRate = 0.1) {',
      '  const sum = items.reduce((acc, item) => acc + item.price, 0);',
      '  return Math.round(sum * (1 + taxRate) * 100) / 100;',
      '}',
      '',
    ].join('\n'),
  );
  put('src/core/index.js', "export { computeSubtotal } from './pricing.js';\n");
  put(
    'src/orders/checkout.js',
    [
      "import { computeSubtotal as calcTotal } from '../core/index.js';",
      'export function buildReceipt(items) {',
      '  const total = calcTotal(items, 0.08);',
      '  return { total };',
      '}',
      '',
    ].join('\n'),
  );
  put(
    'src/orders/quote.js',
    [
      "import { computeSubtotal } from '../core/pricing.js';",
      'export function previewQuote(items) {',
      '  return computeSubtotal(items, 0);',
      '}',
      '',
    ].join('\n'),
  );
  put('test/unit/pricing.test.js', '// naming-convention unit test\n');
  put(
    'test/e2e/checkout.test.js',
    "import { buildReceipt } from '../../src/orders/checkout.js';\nconsole.log(buildReceipt([{ price: 10 }]));\n",
  );
  put('.env', 'API_KEY=secret\n');
  writeFileSync(join(outsideDir, 'secret.js'), 'export function leak() {}\n', 'utf8');
  try {
    symlinkSync(outsideDir, join(root, 'escape_sym'), 'junction');
  } catch {
    // ignore if symlinks forbidden
  }

  // 1. Direct repo-intelligence API
  const directGraph = await querySymbolGraph(root, { symbol: 'computeSubtotal' });
  assert.equal(directGraph.ok, true);
  assert.equal(directGraph.definitions.length, 1);
  assert.equal(directGraph.definitions[0].path, 'src/core/pricing.js');
  assert.equal(directGraph.definitions[0].line, 1);
  assert.equal(directGraph.definitions[0].endLine, 4);
  assert.equal(directGraph.definitions[0].kind, 'function');
  assert.match(directGraph.definitions[0].signature, /computeSubtotal\(items/);
  assert.ok(directGraph.callers.some((c) => c.path === 'src/orders/quote.js' && c.crossFile === true));
  assert.ok(directGraph.importers.some((im) => im.from === 'src/orders/checkout.js'));
  assert.ok(directGraph.importers.some((im) => im.from === 'src/orders/quote.js'));
  assert.ok(directGraph.relatedTests.includes('test/unit/pricing.test.js'));
  assert.ok(directGraph.relatedTests.includes('test/e2e/checkout.test.js'));

  // 2. Tool metadata & auto-approval in read-only and auto-review modes
  assert.equal(WORKSPACE_TOOL_META.query_symbol_graph?.readOnly, true);
  assert.equal(WORKSPACE_TOOL_META.query_symbol_graph?.effectClass, 'read_only');
  assert.equal(WORKSPACE_TOOL_META.query_symbol_graph?.risk, 'low');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => store.close());
  const tools = createWorkspaceTools({
    workspaceRoot: root,
    store,
    nonce: mintNonce(),
    permissionMode: 'read-only',
  });
  const symTool = tools.find((tl) => tl.name === 'query_symbol_graph');
  assert.ok(symTool);
  assert.equal(isParallelReadTool(symTool), true);

  for (const mode of ['read-only', 'auto-review']) {
    let approvalAsked = 0;
    const dispatcher = new ToolDispatcher({
      store,
      policy: new ToolPermissionPolicy({ permissionMode: mode }),
    });
    const [res] = await dispatcher.dispatchBatch({
      sessionId: `s-sym-${mode}`,
      turnId: `t-sym-${mode}`,
      permissionMode: mode,
      tools,
      requestApproval: () => {
        approvalAsked++;
        return { allowed: false };
      },
      toolCalls: [
        {
          id: `tc-${mode}`,
          name: 'query_symbol_graph',
          arguments: JSON.stringify({ symbol: 'computeSubtotal' }),
        },
      ],
    });
    assert.equal(approvalAsked, 0, `${mode} mode must auto-approve query_symbol_graph`);
    assert.equal(res.isError, false);
    assert.match(res.output, /\[query_symbol_graph symbol="computeSubtotal"/);
    const parsed = extractDiagJson(res.output);
    assert.equal(parsed.definitions[0].endLine, 4);
    assert.ok(parsed.relatedTests.includes('test/e2e/checkout.test.js'));
  }

  // Path-scoped call with includeCallers=false, includeTests=false
  const pathOnly = await querySymbolGraph(root, {
    path: 'src/orders/checkout.js',
    includeCallers: false,
    includeTests: false,
    maxResults: 5,
  });
  assert.ok(pathOnly.definitions.some((d) => d.name === 'buildReceipt'));
  assert.deepEqual(pathOnly.callers, []);
  assert.deepEqual(pathOnly.importers, []);
  assert.deepEqual(pathOnly.relatedTests, []);

  // Sandbox confinement
  await assert.rejects(() => symTool.execute({ path: '../secret.js' }), /不允许|受保护|边界/);
  await assert.rejects(() => symTool.execute({ path: '.env' }), /不允许|受保护|边界/);

  // 3. selection.js promotion alongside inspect_repository
  const policy = new ToolPermissionPolicy({ permissionMode: 'auto-safe' });
  const catalog = modelToolCatalog(tools, policy, { permissionMode: 'auto-safe' });
  const names = catalog.map((c) => c.name);
  assert.ok(names.includes('query_symbol_graph'));
  assert.ok(names.indexOf('edit_file') < names.indexOf('apply_patch'));
  assert.ok(names.indexOf('apply_patch') < names.indexOf('run_diagnostics'));
  assert.ok(names.indexOf('run_diagnostics') < names.indexOf('query_symbol_graph'));
  assert.ok(names.indexOf('query_symbol_graph') < names.indexOf('write_file'));
  assert.ok(names.indexOf('query_symbol_graph') < names.indexOf('bash'));
  assert.match(catalog.find((c) => c.name === 'bash').description, /query_symbol_graph/);

  // 4. Swarm capabilities wiring (planner / coder / researcher / verifier)
  const capReg = new AgentCapabilityRegistry();
  for (const role of [
    { taskType: 'planning', isolatedWorktree: false },
    { taskType: 'implementation', isolatedWorktree: false },
    { taskType: 'implementation', isolatedWorktree: true },
    { taskType: 'research', isolatedWorktree: false },
    { taskType: 'verification', isolatedWorktree: true },
  ]) {
    const profile = capReg.synthesizeProfile(role);
    assert.ok(
      profile.toolAllow.includes('query_symbol_graph'),
      `${role.taskType} toolAllow must include query_symbol_graph`,
    );
    assert.ok(
      profile.toolCeiling.includes('query_symbol_graph'),
      `${role.taskType} toolCeiling must include query_symbol_graph`,
    );
  }
  const reviewProfile = capReg.synthesizeProfile({ taskType: 'review' });
  assert.ok(reviewProfile.toolCeiling.includes('query_symbol_graph'));
});

test('normalizeDiagnosticFile decodes percent-encoded file URLs (e.g. %7E) and resolves native realpath aliases', (t) => {
  const { root, put } = createTempWorkspace(t, 'diag-26-url-');
  const tildeWs = join(root, 'dir~1');
  const testFile = join(tildeWs, 'test', 'assertions.test.js');
  put('dir~1/test/assertions.test.js', 'export const ok = true;\n');

  const encodedUrl = pathToFileURL(testFile).href.replace('dir~1', 'dir%7E1');
  assert.match(encodedUrl, /dir%7E1/);
  assert.equal(normalizeDiagnosticFile(encodedUrl, tildeWs), 'test/assertions.test.js');

  const nonExistentUrl = pathToFileURL(join(tildeWs, 'test', 'future.test.js')).href.replace('dir~1', 'dir%7E1');
  assert.equal(normalizeDiagnosticFile(nonExistentUrl, tildeWs), 'test/future.test.js');

  // Symlink/junction alias workspaceRoot vs file URL pointing to canonical target
  const aliasWs = join(root, 'alias-ws');
  let aliasCreated = false;
  try {
    symlinkSync(tildeWs, aliasWs, process.platform === 'win32' ? 'junction' : 'dir');
    aliasCreated = true;
  } catch {
    // Skip symlink/junction sub-check if OS forbids it
  }
  if (aliasCreated) {
    assert.equal(normalizeDiagnosticFile(encodedUrl, aliasWs), 'test/assertions.test.js');
  }
});
