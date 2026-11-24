import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { mintNonce } from '../src/envelope.js';
import { buildStaticSystemPrompt } from '../src/agent-context.js';
import {
  applyCodexPatch,
  parseAndCompressDiagnosticsOutput,
  resolvePythonRunner,
  runDiagnostics,
  runQuickDiagnostics,
  validateCodeSyntax,
} from '../src/patch-and-diagnostics.js';
import { ToolDispatcher } from '../src/tools/dispatcher.js';
import { analyzeCommand, intersectPolicies, ToolPermissionPolicy } from '../src/tools/policy.js';
import { modelToolCatalog } from '../src/tools/selection.js';
import { createWorkspaceTools, resolveSafePath } from '../src/workspace-tools.js';

function createTempWorkspace(t, prefix = 'py-harness-31-') {
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

test('WP5.2 syntax: resolvePythonRunner, validateCodeSyntax, edit_file, write_file, apply_patch, and run_diagnostics catch Python syntax errors', async (t) => {
  const py = resolvePythonRunner();
  assert.ok(py && typeof py.command === 'string', 'Expected Python 3 runner in PATH');
  assert.equal(resolvePythonRunner(), py, 'resolvePythonRunner should return cached entry for same PATH');

  // Direct validateCodeSyntax for valid, SyntaxError, IndentationError, TabError
  assert.equal(validateCodeSyntax('ok.py', 'def add(a, b):\n    return a + b\n').ok, true);

  const syn = validateCodeSyntax('bad_syn.py', 'x = 1\ndef broken(:\n    pass\n');
  assert.equal(syn.ok, false);
  assert.equal(syn.line, 2);
  assert.ok(syn.column >= 1);
  assert.equal(syn.code, 'SYNTAX_ERROR');
  assert.match(syn.message, /SyntaxError:/);

  const indent = validateCodeSyntax('bad_indent.py', 'def f():\npass\n');
  assert.equal(indent.ok, false);
  assert.equal(indent.line, 2);
  assert.equal(indent.code, 'INDENTATION_ERROR');
  assert.match(indent.message, /IndentationError:/);

  const tab = validateCodeSyntax('bad_tab.py', 'def g():\n    x = 1\n\ty = 2\n');
  assert.equal(tab.ok, false);
  assert.equal(tab.line, 3);
  assert.equal(tab.code, 'TAB_ERROR');
  assert.match(tab.message, /TabError:/);

  const { root, put } = createTempWorkspace(t, 'py-syn-31-');
  const dataDir = mkdtempSync(join(tmpdir(), 'py-syn-31-data-'));
  t.after(() => rmDirSafe(dataDir));

  const validCalc = 'def mul(a, b):\n    return a * b\n';
  put('src/calc.py', validCalc);
  put('src/sibling.py', 'VALUE = 1\n');
  put('.env', 'SECRET=123\n');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => store.close());
  const readFileState = new Map();
  const tools = createWorkspaceTools({
    workspaceRoot: root,
    store,
    nonce: mintNonce(),
    readFileState,
    permissionMode: 'auto-safe',
  });
  const dispatcher = new ToolDispatcher({
    store,
    policy: new ToolPermissionPolicy({ permissionMode: 'auto-safe' }),
  });

  // read_file -> edit_file introduces SyntaxError -> caught immediately in tool output
  const [readRes] = await dispatcher.dispatchBatch({
    sessionId: 's-py-syn',
    turnId: 't-1',
    permissionMode: 'auto-safe',
    tools,
    toolCalls: [{ id: 'r-1', name: 'read_file', arguments: JSON.stringify({ path: 'src/calc.py' }) }],
  });
  assert.equal(readRes.isError, false);

  const [badEdit] = await dispatcher.dispatchBatch({
    sessionId: 's-py-syn',
    turnId: 't-2',
    permissionMode: 'auto-safe',
    tools,
    toolCalls: [
      {
        id: 'e-bad',
        name: 'edit_file',
        arguments: JSON.stringify({
          path: 'src/calc.py',
          target: '    return a * b',
          replacement: '    return (a * b',
        }),
      },
    ],
  });
  assert.equal(badEdit.isError, false);
  assert.match(badEdit.output, /自动语法诊断/);
  assert.match(badEdit.output, /src\/calc\.py:2/);
  assert.match(badEdit.output, /SyntaxError/);

  // runDiagnostics kind='syntax' and kind='auto' both report the Python syntax error
  const diagSyn = runDiagnostics(root, { kind: 'syntax', paths: ['src/calc.py'] });
  assert.equal(diagSyn.ok, false);
  assert.equal(diagSyn.diagnostics.length, 1);
  assert.equal(diagSyn.diagnostics[0].file, 'src/calc.py');
  assert.equal(diagSyn.diagnostics[0].line, 2);
  assert.equal(diagSyn.diagnostics[0].source, 'syntax');
  assert.equal(diagSyn.diagnostics[0].code, 'SYNTAX_ERROR');

  const diagAuto = runDiagnostics(root, { kind: 'auto', paths: ['src/calc.py'] });
  assert.equal(diagAuto.ok, false);
  assert.equal(diagAuto.diagnostics[0].source, 'syntax');

  // Fix via edit_file -> clean diagnostic
  const [goodEdit] = await dispatcher.dispatchBatch({
    sessionId: 's-py-syn',
    turnId: 't-3',
    permissionMode: 'auto-safe',
    tools,
    toolCalls: [
      {
        id: 'e-fix',
        name: 'edit_file',
        arguments: JSON.stringify({
          path: 'src/calc.py',
          target: '    return (a * b',
          replacement: '    return a * b',
        }),
      },
    ],
  });
  assert.equal(goodEdit.isError, false);
  assert.doesNotMatch(goodEdit.output, /自动语法诊断/);

  // write_file catches IndentationError immediately
  const [badWrite] = await dispatcher.dispatchBatch({
    sessionId: 's-py-syn',
    turnId: 't-4',
    permissionMode: 'auto-safe',
    tools,
    toolCalls: [
      {
        id: 'w-bad',
        name: 'write_file',
        arguments: JSON.stringify({
          path: 'src/indented.py',
          content: 'def broken():\nx = 1\n',
        }),
      },
    ],
  });
  assert.equal(badWrite.isError, false);
  assert.match(badWrite.output, /自动语法诊断/);
  assert.match(badWrite.output, /IndentationError/);
  assert.equal(runQuickDiagnostics(join(root, 'src/indented.py'), 'src/indented.py').ok, false);

  // apply_patch rejects .py SyntaxError atomically pre-commit without mutating sibling.py
  assert.throws(
    () =>
      applyCodexPatch(
        [
          '--- a/src/sibling.py',
          '+++ b/src/sibling.py',
          '@@ -1,1 +1,1 @@',
          '-VALUE = 1',
          '+VALUE = 2',
          '--- a/src/calc.py',
          '+++ b/src/calc.py',
          '@@ -1,2 +1,2 @@',
          ' def mul(a, b):',
          '-    return a * b',
          '+    return [a * b',
        ].join('\n'),
        { workspaceRoot: root, resolveSafePath },
      ),
    (err) => err.code === 'SYNTAX_VALIDATION_ERROR' && /src\/calc\.py:2/.test(err.message),
  );
  assert.equal(readFileSync(join(root, 'src/sibling.py'), 'utf8'), 'VALUE = 1\n');

  // Confinement guards remain intact
  for (const badPath of ['../outside.py', '.env', '.git/config', 'upstream/a.py', 'backend/var/a.py']) {
    assert.throws(() => runDiagnostics(root, { kind: 'syntax', paths: [badPath] }), /不允许|受保护|边界/);
  }
});

test('WP5.2 test diagnostics: pytest pass/fail, -k filter, auto mode, collection errors, dual JS+Python, and unittest fallback', async (t) => {
  const { root, put } = createTempWorkspace(t, 'py-pytest-31-');
  put('pyproject.toml', '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
  put('src/math_ops.py', 'def add(a, b):\n    return a - b\n');
  put(
    'tests/test_math.py',
    [
      'from src.math_ops import add',
      '',
      'def test_add_fails():',
      '    assert add(2, 3) == 5',
      '',
      'def test_identity_passes():',
      '    assert add(4, 0) == 4',
      '',
    ].join('\n'),
  );

  // 1. pytest catches failure in test mode and auto mode on test file
  for (const mode of ['test', 'auto']) {
    const res = runDiagnostics(root, {
      kind: mode,
      paths: mode === 'auto' ? ['tests/test_math.py'] : [],
    });
    assert.equal(res.ok, false);
    assert.equal(res.failingTests.length, 1);
    assert.match(res.failingTests[0].testName, /test_add_fails/);
    assert.equal(res.failingTests[0].file, 'tests/test_math.py');
    assert.equal(res.failingTests[0].line, 4);
    assert.equal(res.diagnostics.length, 1);
    assert.equal(res.diagnostics[0].source, 'pytest');
    assert.equal(res.diagnostics[0].file, 'tests/test_math.py');
    assert.equal(res.diagnostics[0].line, 4);
  }

  // 2. -k filter isolates passing test
  const filteredPass = runDiagnostics(root, {
    kind: 'test',
    testPattern: 'test_identity_passes',
  });
  assert.equal(filteredPass.ok, true);
  assert.deepEqual(filteredPass.failingTests, []);

  // 3. -k filter matching 0 tests must exit non-zero and NEVER return false-positive ok:true
  const noMatch = runDiagnostics(root, {
    kind: 'test',
    testPattern: 'nonexistent_test_xyz_999',
  });
  assert.equal(noMatch.ok, false);

  // 4. Fix bug -> full pytest passes cleanly
  put('src/math_ops.py', 'def add(a, b):\n    return a + b\n');
  const fullPass = runDiagnostics(root, { kind: 'test' });
  assert.equal(fullPass.ok, true);
  assert.deepEqual(fullPass.diagnostics, []);
  assert.deepEqual(fullPass.failingTests, []);

  // 5. Collection SyntaxError & ImportError never return false-positive ok:true
  const { root: brokenRoot, put: putBroken } = createTempWorkspace(t, 'py-broken-col-');
  putBroken('tests/test_broken_syntax.py', 'def bad_fn(:\n    return 1\n');
  const synCol = runDiagnostics(brokenRoot, { kind: 'test' });
  assert.equal(synCol.ok, false);
  assert.ok(synCol.diagnostics.length >= 1);
  assert.equal(synCol.diagnostics[0].source, 'pytest');
  assert.equal(synCol.diagnostics[0].code, 'SYNTAX_ERROR');
  assert.equal(synCol.diagnostics[0].file, 'tests/test_broken_syntax.py');
  assert.equal(synCol.diagnostics[0].line, 1);

  const { root: impRoot, put: putImp } = createTempWorkspace(t, 'py-imp-col-');
  putImp('tests/test_missing_dep.py', 'import definitely_missing_pkg_31\ndef test_noop():\n    pass\n');
  const impCol = runDiagnostics(impRoot, { kind: 'test' });
  assert.equal(impCol.ok, false);
  assert.ok(impCol.diagnostics.length >= 1);
  assert.equal(impCol.diagnostics[0].source, 'pytest');
  assert.equal(impCol.diagnostics[0].code, 'IMPORT_ERROR');
  assert.equal(impCol.diagnostics[0].file, 'tests/test_missing_dep.py');
  assert.equal(impCol.diagnostics[0].line, 1);

  // 6. Mixed JS + Python repo runs BOTH suites when paths is empty
  const { root: mixedRoot, put: putMixed } = createTempWorkspace(t, 'py-mixed-31-');
  putMixed('package.json', JSON.stringify({ name: 'mixed-31', type: 'module' }));
  putMixed('pyproject.toml', '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
  putMixed(
    'test/js_ok.test.js',
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('js ok', () => assert.equal(1 + 1, 2));\n",
  );
  putMixed('tests/test_py_mix.py', 'def test_py_fail():\n    assert 10 == 20\n');

  const mixedFail = runDiagnostics(mixedRoot, { kind: 'test' });
  assert.equal(mixedFail.ok, false);
  assert.equal(mixedFail.diagnostics[0].source, 'pytest');
  assert.match(mixedFail.failingTests[0].testName, /test_py_fail/);

  putMixed('tests/test_py_mix.py', 'def test_py_pass():\n    assert 10 == 10\n');
  const mixedPass = runDiagnostics(mixedRoot, { kind: 'test' });
  assert.equal(mixedPass.ok, true);

  // 7. unittest fallback when pytest is absent (isolated venv --without-pip)
  const pyRunner = resolvePythonRunner();
  const venvDir = mkdtempSync(join(tmpdir(), 'py-ut-venv-'));
  t.after(() => rmDirSafe(venvDir));
  const venvInit = spawnSync(pyRunner.command, ['-m', 'venv', '--without-pip', venvDir], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 10000,
  });
  assert.equal(venvInit.status, 0, `venv creation failed: ${venvInit.stderr}`);
  const venvBinDir = process.platform === 'win32' ? join(venvDir, 'Scripts') : join(venvDir, 'bin');
  assert.equal(existsSync(join(venvBinDir, process.platform === 'win32' ? 'python.exe' : 'python')), true);

  const { root: utRoot, put: putUt } = createTempWorkspace(t, 'py-ut-ws-');
  putUt(
    'tests/test_ut.py',
    [
      'import unittest',
      'class CalcTests(unittest.TestCase):',
      '    def test_ok(self):',
      '        self.assertEqual(2, 2)',
      '    def test_fail(self):',
      '        self.assertEqual(2, 3)',
      '',
    ].join('\n'),
  );

  const prevPath = process.env.PATH;
  process.env.PATH = venvBinDir;
  try {
    const utRunner = resolvePythonRunner();
    assert.ok(utRunner);
    const utFail = runDiagnostics(utRoot, { kind: 'test', paths: ['tests/test_ut.py'] });
    assert.equal(utFail.ok, false);
    assert.equal(utFail.failingTests.length, 1);
    assert.match(utFail.failingTests[0].testName, /test_fail/);
    assert.equal(utFail.failingTests[0].file, 'tests/test_ut.py');
    assert.equal(utFail.failingTests[0].line, 6);
    assert.equal(utFail.diagnostics[0].source, 'unittest');

    const utFiltered = runDiagnostics(utRoot, {
      kind: 'test',
      paths: ['tests'],
      testPattern: 'test_ok',
    });
    assert.equal(utFiltered.ok, true);

    const { root: pyStyleRoot, put: putPyStyle } = createTempWorkspace(t, 'py-ut-pytest-style-');
    putPyStyle('tests/test_standalone.py', 'def test_standalone():\n    assert True\n');
    const utPyStyleRes = runDiagnostics(pyStyleRoot, { kind: 'test' });
    assert.equal(utPyStyleRes.ok, false);
    const pyUnavailableDiag = utPyStyleRes.diagnostics.find((d) => d.code === 'PYTEST_UNAVAILABLE');
    assert.ok(pyUnavailableDiag, 'expected PYTEST_UNAVAILABLE diagnostic');
    assert.equal(pyUnavailableDiag.code, 'PYTEST_UNAVAILABLE');
    assert.equal(pyUnavailableDiag.source, 'unittest');
    assert.equal(pyUnavailableDiag.file, 'tests/test_standalone.py');
    assert.equal(pyUnavailableDiag.line, 1);
    assert.match(
      pyUnavailableDiag.message,
      /Ran 0 tests|PYTEST_UNAVAILABLE: unittest discovered 0 tests for pytest-style functions/,
    );

    const utFilteredEmpty = runDiagnostics(utRoot, {
      kind: 'test',
      paths: ['tests'],
      testPattern: 'nonexistent_case_xyz',
    });
    assert.equal(
      utFilteredEmpty.diagnostics.some((d) => d.code === 'PYTEST_UNAVAILABLE'),
      false,
      'unittest.TestCase methods must never false-trigger PYTEST_UNAVAILABLE',
    );
  } finally {
    process.env.PATH = prevPath;
  }

  // 8. parseAndCompressDiagnosticsOutput parses raw pytest & unittest snippets directly
  const rawPytest = parseAndCompressDiagnosticsOutput(
    [
      'FAILED pkg/test_api.py::test_status - assert 500 == 200',
      '  File "pkg/test_api.py", line 14',
    ].join('\n'),
    { kind: 'test' },
  );
  assert.equal(rawPytest.ok, false);
  assert.equal(rawPytest.diagnostics[0].source, 'pytest');
  assert.equal(rawPytest.failingTests[0].file, 'pkg/test_api.py');

  const rawUnittest = parseAndCompressDiagnosticsOutput(
    [
      '======================================================================',
      'FAIL: test_sum (tests.test_calc.TestCalc.test_sum)',
      '----------------------------------------------------------------------',
      'Traceback (most recent call last):',
      '  File "tests/test_calc.py", line 9, in test_sum',
      '    self.assertEqual(1, 2)',
      'AssertionError: 1 != 2',
      'Ran 1 test in 0.001s',
    ].join('\n'),
    { kind: 'test' },
  );
  assert.equal(rawUnittest.ok, false);
  assert.equal(rawUnittest.diagnostics[0].source, 'unittest');
  assert.equal(rawUnittest.failingTests[0].file, 'tests/test_calc.py');
  assert.equal(rawUnittest.failingTests[0].line, 9);
});

test('WP6.1 & WP6.2: selection prioritizes edit_file (#0) -> apply_patch (#1) and static prompt keeps 4-phase invariance', async (t) => {
  const { root } = createTempWorkspace(t, 'py-sel-31-');
  const tools = createWorkspaceTools({
    workspaceRoot: root,
    nonce: mintNonce(),
    permissionMode: 'auto-safe',
  });
  const policy = new ToolPermissionPolicy({ permissionMode: 'auto-safe' });
  const catalog = modelToolCatalog(tools, policy, { permissionMode: 'auto-safe' });
  const names = catalog.map((c) => c.name);

  assert.equal(names[0], 'edit_file');
  assert.ok(names.indexOf('edit_file') < names.indexOf('apply_patch'));
  assert.ok(names.indexOf('apply_patch') < names.indexOf('run_diagnostics'));
  assert.ok(names.indexOf('run_diagnostics') < names.indexOf('inspect_repository'));
  assert.ok(names.indexOf('run_diagnostics') < names.indexOf('query_symbol_graph'));
  assert.ok(names.indexOf('query_symbol_graph') < names.indexOf('write_file'));
  assert.ok(names.indexOf('write_file') < names.indexOf('bash'));

  const editDesc = catalog.find((c) => c.name === 'edit_file').description;
  const patchDesc = catalog.find((c) => c.name === 'apply_patch').description;
  const writeDesc = catalog.find((c) => c.name === 'write_file').description;
  assert.match(editDesc, /首选|单文件/);
  assert.match(editDesc, /行号/);
  assert.match(patchDesc, /多文件/);
  assert.match(writeDesc, /edit_file/);
  assert.match(writeDesc, /apply_patch/);

  // 4-phase static prompt invariance & zero dynamic interpolation
  const nonce = mintNonce();
  const promptA = buildStaticSystemPrompt(nonce);
  const promptB = buildStaticSystemPrompt(nonce);
  assert.equal(promptA, promptB);
  assert.match(promptA, /自然语言/);
  assert.match(promptA, /1\.\s*\*\*精准定位\*\*/);
  assert.match(promptA, /2\.\s*\*\*先读后改\*\*/);
  assert.match(promptA, /3\.\s*\*\*最小原子修改\*\*[\s\S]*edit_file/);
  assert.match(promptA, /4\.\s*\*\*测试闭环与根因复盘\*\*[\s\S]*git diff[\s\S]*git status/);
  assert.equal(promptA.includes(root), false);
  assert.doesNotMatch(promptA, /\b20\d{2}-\d{2}-\d{2}T/);

  // Via ToolDispatcher run_diagnostics returns structured JSON
  const dataDir = mkdtempSync(join(tmpdir(), 'py-sel-data-'));
  t.after(() => rmDirSafe(dataDir));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => store.close());
  const dispatcher = new ToolDispatcher({
    store,
    policy: new ToolPermissionPolicy({ permissionMode: 'read-only' }),
  });
  const [diagCall] = await dispatcher.dispatchBatch({
    sessionId: 's-sel',
    turnId: 't-sel',
    permissionMode: 'read-only',
    tools,
    toolCalls: [{ id: 'd1', name: 'run_diagnostics', arguments: JSON.stringify({ kind: 'syntax' }) }],
  });
  assert.equal(diagCall.isError, false);
  assert.equal(extractDiagJson(diagCall.output).ok, true);
});

test('WP6.3: command-analyzer and policy allow Python read-only and safe local tests strictly in workspace-write', () => {
  // 1. Python read-only commands
  for (const cmd of [
    'python --version',
    'python3 -V',
    'python -m py_compile src/app.py',
    'python3 -B -m py_compile src/a.py tests/test_a.py',
  ]) {
    const a = analyzeCommand(cmd);
    assert.equal(a.isReadOnly, true, `Expected isReadOnly=true for: ${cmd}`);
    assert.equal(a.isSafeLocalTest, false, `Expected isSafeLocalTest=false for: ${cmd}`);
  }

  for (const badPyReadOnly of [
    'python -c "print(1)"',
    'python3 -I -c "import os"',
    'python -m http.server',
    'python -m py_compile',
    'python -m py_compile ../secret.py',
    'python3 -m py_compile /etc/passwd',
    'python -m py_compile C:\\secret.py',
    'python -m py_compile .env',
    'python --version && whoami',
    './python --version',
  ]) {
    const a = analyzeCommand(badPyReadOnly);
    assert.equal(a.isReadOnly, false, `Expected isReadOnly=false for: ${badPyReadOnly}`);
  }

  // 2. Safe local test commands
  for (const safeTest of [
    'pytest',
    'pytest -q --tb=short tests/test_calc.py::test_add -k "add or sub"',
    'python -m pytest tests/test_calc.py',
    'python3 -m pytest -q',
    'python -m unittest discover',
    'python3 -m unittest tests/test_calc.py -k test_add',
    'node --test test/unit.test.js',
    'npm test',
    'npm run test',
    'npx tsc --noEmit',
    'npx tsc --noEmit --pretty false',
  ]) {
    const a = analyzeCommand(safeTest);
    assert.equal(a.isSafeLocalTest, true, `Expected isSafeLocalTest=true for: ${safeTest}`);
  }

  // 3. Dangerous flags / path escapes / compound / non-test commands rejected
  for (const unsafeTest of [
    'pytest -c evil.ini',
    'pytest -e "1"',
    'pytest --eval "1"',
    'pytest --require ./evil.js',
    'pytest -rA',
    'pytest --import ./evil.mjs',
    'pytest --loader ./evil.mjs',
    'pytest -p evil_plugin',
    'pytest -o addopts=-s',
    'pytest --override-ini=addopts=-s',
    'pytest --rootdir=..',
    'pytest --rootdir ../outside',
    'pytest ../outside/test_x.py',
    'pytest /tmp/test_x.py',
    'pytest C:\\evil\\test_x.py',
    'pytest && whoami',
    'pytest | tee out.txt',
    'python -m pytest -o addopts=-x',
    'python3 -m unittest -p "test_*.py"',
    'node --test -r ./preload.js',
    'node --test --import ./evil.mjs',
    'node --test --loader ./evil.mjs',
    'node --test -e "process.exit(0)"',
    'node --test ../evil.test.js',
    'npm test -- --require ./evil.js',
    'npm run test -- -e "1"',
    'npm run build',
    'npx tsc',
    'npx tsc --noEmit -p tsconfig.json',
    'npx tsc --noEmit --watch',
    'npx evil-pkg',
    './pytest',
  ]) {
    const a = analyzeCommand(unsafeTest);
    assert.equal(a.isSafeLocalTest, false, `Expected isSafeLocalTest=false for: ${unsafeTest}`);
  }

  // 4. Policy matrix enforcement across all permission modes
  const policy = new ToolPermissionPolicy();
  const bashTool = {
    name: 'bash',
    meta: { requiresCommandCheck: true, riskLevel: 'high', effectClass: 'irreversible_side_effect' },
  };

  // workspace-write allows safe read-only & safe local test when untainted and without cwd
  assert.equal(
    policy.evaluate(bashTool, { command: 'python -m py_compile src/a.py' }, { permissionMode: 'workspace-write' })
      .decision,
    'allow',
  );
  assert.equal(
    policy.evaluate(bashTool, { command: 'pytest tests/test_a.py' }, { permissionMode: 'workspace-write' }).decision,
    'allow',
  );
  assert.equal(
    policy.evaluate(bashTool, { command: 'npx tsc --noEmit' }, { permissionMode: 'workspace-write' }).decision,
    'allow',
  );
  assert.equal(
    policy.evaluate(bashTool, { command: 'npm run test' }, { permissionMode: 'workspace-write' }).decision,
    'allow',
  );

  // Taint, cwd, or dangerous command always fall back to ask in workspace-write
  assert.equal(
    policy.evaluate(
      bashTool,
      { command: 'pytest' },
      { permissionMode: 'workspace-write', tainted: true },
    ).decision,
    'ask',
  );
  assert.equal(
    policy.evaluate(
      bashTool,
      { command: 'pytest', cwd: 'sub' },
      { permissionMode: 'workspace-write' },
    ).decision,
    'ask',
  );
  assert.equal(
    policy.evaluate(
      bashTool,
      { command: 'python -m py_compile src/a.py', cwd: 'sub' },
      { permissionMode: 'workspace-write' },
    ).decision,
    'ask',
  );
  assert.equal(
    policy.evaluate(
      bashTool,
      { command: 'python -c "import os"' },
      { permissionMode: 'workspace-write' },
    ).decision,
    'ask',
  );

  // auto-safe allows read-only (not tainted/cwd) but MUST ask on tests
  assert.equal(
    policy.evaluate(bashTool, { command: 'python3 -B -m py_compile src/a.py' }, { permissionMode: 'auto-safe' })
      .decision,
    'allow',
  );
  assert.equal(
    policy.evaluate(bashTool, { command: 'pytest' }, { permissionMode: 'auto-safe' }).decision,
    'ask',
  );
  assert.equal(
    policy.evaluate(bashTool, { command: 'npm test' }, { permissionMode: 'auto-safe' }).decision,
    'ask',
  );

  // NEVER loosened: read-only, approval, auto-review, intersectPolicies
  assert.equal(
    policy.evaluate(bashTool, { command: 'pytest' }, { permissionMode: 'read-only' }).decision,
    'deny',
  );
  assert.equal(
    policy.evaluate(bashTool, { command: 'python -m py_compile src/a.py' }, { permissionMode: 'read-only' }).decision,
    'ask',
  );
  assert.equal(
    policy.evaluate(bashTool, { command: 'pytest' }, { permissionMode: 'approval' }).decision,
    'ask',
  );
  assert.equal(
    policy.evaluate(bashTool, { command: 'pytest' }, { permissionMode: 'auto-review' }).decision,
    'ask',
  );
  assert.equal(
    policy.evaluate(bashTool, { command: 'python -m py_compile src/a.py' }, { permissionMode: 'auto-review' })
      .decision,
    'ask',
  );
  assert.equal(
    policy.evaluate(bashTool, { command: 'pytest' }, { permissionMode: 'full-access' }).decision,
    'allow',
  );

  assert.equal(
    intersectPolicies({ permissionMode: 'workspace-write' }, { permissionMode: 'auto-review' }).permissionMode,
    'approval',
  );
  assert.equal(
    intersectPolicies({ permissionMode: 'auto-safe' }, { permissionMode: 'workspace-write' }).permissionMode,
    'auto-safe',
  );
  assert.equal(
    intersectPolicies({ permissionMode: 'read-only' }, { permissionMode: 'workspace-write' }).permissionMode,
    'read-only',
  );
});
