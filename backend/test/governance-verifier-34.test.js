import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import {
  EvidenceVerifier,
  extractVerificationTargets,
  isExplicitFileDeleteCommand,
  isFailedVerificationSuperseded,
} from '../src/governance/verifier.js';

function createEnv(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-ver34-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-ver34-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => {
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });
  return { dataDir, workDir, store };
}

test('extractVerificationTargets normalizes container paths, nodeIds, cwd, and broad suites', () => {
  const broadPytest = extractVerificationTargets('pytest -v --tb=short', '.', '/tmp/work');
  assert.equal(broadPytest.isBroadSuite, true);
  assert.equal(broadPytest.runner, 'pytest');

  const broadNpm = extractVerificationTargets('npm test', '.', '/tmp/work');
  assert.equal(broadNpm.isBroadSuite, true);

  const broadNode = extractVerificationTargets('node --test', '.', '/tmp/work');
  assert.equal(broadNode.isBroadSuite, true);

  const filteredPytest = extractVerificationTargets('pytest -k test_login', '.', '/tmp/work');
  assert.equal(filteredPytest.isBroadSuite, false);
  assert.deepEqual(filteredPytest.filters, ['test_login']);

  const djangoNodeId = extractVerificationTargets(
    'pytest /testbed/tests/queries/tests.py::QueryTests::test_subquery',
    '.',
    '/tmp/work',
  );
  assert.equal(djangoNodeId.isBroadSuite, false);
  assert.deepEqual(djangoNodeId.targets, ['tests/queries/tests.py']);
  assert.ok(djangoNodeId.dirs.includes('tests/queries'));
  assert.ok(djangoNodeId.appLabels.includes('queries'));
  assert.ok(!djangoNodeId.stems.includes('tests'));

  const cwdRelative = extractVerificationTargets('pytest test_q.py', '/testbed/tests/queries', '/tmp/work');
  assert.deepEqual(cwdRelative.targets, ['tests/queries/test_q.py']);
  assert.ok(cwdRelative.dirs.includes('tests/queries'));
  assert.ok(cwdRelative.stems.includes('q'));
  assert.ok(cwdRelative.appLabels.includes('queries'));
});

test('EvidenceVerifier verification supersession handles pre-edit, CLI error, network error, and target overlap', (t) => {
  const { workDir, store } = createEnv(t);
  writeFileSync(join(workDir, 'calc.py'), 'def add(a, b): return a + b\n', 'utf8');
  writeFileSync(join(workDir, 'SECURITY.md'), '# Security\n', 'utf8');
  const verifier = new EvidenceVerifier({ store });

  // (a) Pre-edit reproduction superseded by post-edit passing verification (different command)
  const preEditRes = verifier.verify({
    workspaceRoot: workDir,
    text: 'All tests passed after fixing calc.py.',
    events: [
      { type: 'tool/call', data: { callId: 'v1', name: 'bash', arguments: { command: 'pytest -k test_add' } } },
      { type: 'tool/result', data: { callId: 'v1', name: 'bash', isError: true, content: 'AssertionError', receipt: { callId: 'v1', status: 'failed', exitCode: 1 } } },
      { type: 'tool/call', data: { callId: 'e1', name: 'edit_file', arguments: { path: 'calc.py', target: 'a + b', replacement: 'a + b' } } },
      { type: 'tool/result', data: { callId: 'e1', name: 'edit_file', isError: false, receipt: { callId: 'e1', status: 'finished', exitCode: 0 } } },
      { type: 'tool/call', data: { callId: 'v2', name: 'bash', arguments: { command: 'pytest tests/test_calc.py' } } },
      { type: 'tool/result', data: { callId: 'v2', name: 'bash', isError: false, content: '1 passed', receipt: { callId: 'v2', status: 'finished', exitCode: 0 } } },
    ],
  });
  assert.equal(preEditRes.accepted, true, preEditRes.reasons.join('; '));
  assert.equal(preEditRes.checks.unresolvedVerificationFailure, false);

  // (b) CLI / path invocation errors (exitCode 2, 4, 126, 127 or error output) superseded by passing run
  for (const [idx, cliCase] of [
    { exitCode: 2, content: 'error: unrecognized arguments: --bogus' },
    { exitCode: 4, content: 'ERROR: file or directory not found' },
    { exitCode: 127, content: 'pytestt: command not found' },
    { exitCode: 1, content: 'chdir to cwd failed: No such file or directory' },
    { exitCode: 1, content: 'Blocked unauthorized cwd' },
    { exitCode: 1, content: '路径超出当前工作区边界' },
  ].entries()) {
    const res = verifier.verify({
      workspaceRoot: workDir,
      text: 'Tests passed.',
      events: [
        { type: 'tool/call', data: { callId: `cli-e-${idx}`, name: 'edit_file', arguments: { path: 'calc.py' } } },
        { type: 'tool/result', data: { callId: `cli-e-${idx}`, name: 'edit_file', isError: false, receipt: { callId: `cli-e-${idx}`, status: 'finished', exitCode: 0 } } },
        { type: 'tool/call', data: { callId: `cli-f-${idx}`, name: 'bash', arguments: { command: 'pytest tests/test_unrelated.py' } } },
        { type: 'tool/result', data: { callId: `cli-f-${idx}`, name: 'bash', isError: true, content: cliCase.content, receipt: { callId: `cli-f-${idx}`, status: 'failed', exitCode: cliCase.exitCode } } },
        { type: 'tool/call', data: { callId: `cli-p-${idx}`, name: 'bash', arguments: { command: 'pytest tests/test_calc.py' } } },
        { type: 'tool/result', data: { callId: `cli-p-${idx}`, name: 'bash', isError: false, content: '1 passed', receipt: { callId: `cli-p-${idx}`, status: 'finished', exitCode: 0 } } },
      ],
    });
    assert.equal(res.accepted, true, `CLI case ${idx} failed: ${res.reasons.join('; ')}`);
  }

  // (c) Offline container network failures superseded by passing run
  for (const [idx, netErr] of [
    'HTTPSConnectionPool(host="pypi.org", port=443): Max retries exceeded',
    'Temporary failure in name resolution',
    "URLError: <urlopen error [Errno -3] Name or service not known>",
    'socket.gaierror: [Errno -2] Name or service not known',
  ].entries()) {
    const res = verifier.verify({
      workspaceRoot: workDir,
      text: 'Verified offline test suite.',
      events: [
        { type: 'tool/call', data: { callId: `net-e-${idx}`, name: 'edit_file', arguments: { path: 'calc.py' } } },
        { type: 'tool/result', data: { callId: `net-e-${idx}`, name: 'edit_file', isError: false, receipt: { callId: `net-e-${idx}`, status: 'finished', exitCode: 0 } } },
        { type: 'tool/call', data: { callId: `net-f-${idx}`, name: 'bash', arguments: { command: 'pytest tests/test_online.py' } } },
        { type: 'tool/result', data: { callId: `net-f-${idx}`, name: 'bash', isError: true, content: netErr, receipt: { callId: `net-f-${idx}`, status: 'failed', exitCode: 1 } } },
        { type: 'tool/call', data: { callId: `net-p-${idx}`, name: 'bash', arguments: { command: 'pytest tests/test_calc.py' } } },
        { type: 'tool/result', data: { callId: `net-p-${idx}`, name: 'bash', isError: false, content: '1 passed', receipt: { callId: `net-p-${idx}`, status: 'finished', exitCode: 0 } } },
      ],
    });
    assert.equal(res.accepted, true, `Network case ${idx} failed: ${res.reasons.join('; ')}`);
  }

  // (d) Target overlap (broad suite, ::Class::method + /testbed/, parent dir/app label, mutated stem) + post-pass doc edit
  const targetCases = [
    {
      failCmd: 'pytest tests/test_calc.py::TestCalc::test_add',
      passCmd: 'pytest',
      failCwd: '.',
      passCwd: '.',
    },
    {
      failCmd: 'pytest /testbed/tests/queries/tests.py::QueryTests::test_q',
      passCmd: 'pytest tests/queries/test_sub.py',
      failCwd: '.',
      passCwd: '.',
    },
    {
      failCmd: 'pytest test_calc.py',
      passCmd: 'pytest /testbed/tests/test_calc.py',
      failCwd: 'tests',
      passCwd: '.',
    },
    {
      failCmd: 'pytest tests/other/test_other.py',
      passCmd: 'pytest tests/test_calc.py', // matches mutated file calc.py
      failCwd: '.',
      passCwd: '.',
    },
  ];
  for (const [idx, tc] of targetCases.entries()) {
    const res = verifier.verify({
      workspaceRoot: workDir,
      text: 'All tests passed.',
      events: [
        { type: 'tool/call', data: { callId: `tgt-e-${idx}`, name: 'edit_file', arguments: { path: 'calc.py' } } },
        { type: 'tool/result', data: { callId: `tgt-e-${idx}`, name: 'edit_file', isError: false, receipt: { callId: `tgt-e-${idx}`, status: 'finished', exitCode: 0 } } },
        { type: 'tool/call', data: { callId: `tgt-f-${idx}`, name: 'bash', arguments: { command: tc.failCmd, cwd: tc.failCwd } } },
        { type: 'tool/result', data: { callId: `tgt-f-${idx}`, name: 'bash', isError: true, content: 'AssertionError', receipt: { callId: `tgt-f-${idx}`, status: 'failed', exitCode: 1 } } },
        { type: 'tool/call', data: { callId: `tgt-p-${idx}`, name: 'bash', arguments: { command: tc.passCmd, cwd: tc.passCwd } } },
        { type: 'tool/result', data: { callId: `tgt-p-${idx}`, name: 'bash', isError: false, content: 'passed', receipt: { callId: `tgt-p-${idx}`, status: 'finished', exitCode: 0 } } },
        { type: 'tool/call', data: { callId: `tgt-doc-${idx}`, name: 'edit_file', arguments: { path: 'SECURITY.md' } } },
        { type: 'tool/result', data: { callId: `tgt-doc-${idx}`, name: 'edit_file', isError: false, receipt: { callId: `tgt-doc-${idx}`, status: 'finished', exitCode: 0 } } },
      ],
    });
    assert.equal(res.accepted, true, `Target case ${idx} failed: ${res.reasons.join('; ')}`);
  }
});

test('EvidenceVerifier supersession negative cases preserve stale-edit, post-pass failure, and unrelated failure gates', (t) => {
  const { workDir, store } = createEnv(t);
  writeFileSync(join(workDir, 'app.js'), 'export const a = 1;\n', 'utf8');
  const verifier = new EvidenceVerifier({ store });

  // 1. Disjoint post-edit failure must NOT be superseded by unrelated passing test
  const disjointRes = verifier.verify({
    workspaceRoot: workDir,
    text: 'Tests passed.',
    events: [
      { type: 'tool/call', data: { callId: 'e1', name: 'edit_file', arguments: { path: 'app.js' } } },
      { type: 'tool/result', data: { callId: 'e1', name: 'edit_file', isError: false, receipt: { callId: 'e1', status: 'finished', exitCode: 0 } } },
      { type: 'tool/call', data: { callId: 'f1', name: 'bash', arguments: { command: 'node --test test/app.test.js' } } },
      { type: 'tool/result', data: { callId: 'f1', name: 'bash', isError: true, content: 'AssertionError: app', receipt: { callId: 'f1', status: 'failed', exitCode: 1 } } },
      { type: 'tool/call', data: { callId: 'p1', name: 'bash', arguments: { command: 'node --test test/other.test.js' } } },
      { type: 'tool/result', data: { callId: 'p1', name: 'bash', isError: false, content: 'pass 1', receipt: { callId: 'p1', status: 'finished', exitCode: 0 } } },
    ],
  });
  assert.equal(disjointRes.accepted, false);
  assert.equal(disjointRes.checks.unresolvedVerificationFailure, true);
  assert.ok(disjointRes.reasons.some((r) => r.includes('UNRESOLVED_VERIFICATION_FAILURE')));
  assert.ok(disjointRes.reasons.some((r) => r.includes('FABRICATED_PASS_CLAIM')));

  // 2. Syntax-only `node --check app.js` must NOT supersede failing `node --test test/app.test.js`
  const syntaxOnlyRes = verifier.verify({
    workspaceRoot: workDir,
    text: 'Checks passed.',
    events: [
      { type: 'tool/call', data: { callId: 'e2', name: 'edit_file', arguments: { path: 'app.js' } } },
      { type: 'tool/result', data: { callId: 'e2', name: 'edit_file', isError: false, receipt: { callId: 'e2', status: 'finished', exitCode: 0 } } },
      { type: 'tool/call', data: { callId: 'f2', name: 'bash', arguments: { command: 'node --test test/app.test.js' } } },
      { type: 'tool/result', data: { callId: 'f2', name: 'bash', isError: true, content: 'AssertionError', receipt: { callId: 'f2', status: 'failed', exitCode: 1 } } },
      { type: 'tool/call', data: { callId: 'p2', name: 'bash', arguments: { command: 'node --check app.js' } } },
      { type: 'tool/result', data: { callId: 'p2', name: 'bash', isError: false, content: '', receipt: { callId: 'p2', status: 'finished', exitCode: 0 } } },
    ],
  });
  assert.equal(syntaxOnlyRes.accepted, false);
  assert.ok(syntaxOnlyRes.reasons.some((r) => r.includes('UNRESOLVED_VERIFICATION_FAILURE')));

  // 3. Failure AFTER passing verification is NOT superseded
  const failAfterPass = verifier.verify({
    workspaceRoot: workDir,
    text: 'Done.',
    events: [
      { type: 'tool/call', data: { callId: 'e3', name: 'edit_file', arguments: { path: 'app.js' } } },
      { type: 'tool/result', data: { callId: 'e3', name: 'edit_file', isError: false, receipt: { callId: 'e3', status: 'finished', exitCode: 0 } } },
      { type: 'tool/call', data: { callId: 'p3', name: 'bash', arguments: { command: 'node --test' } } },
      { type: 'tool/result', data: { callId: 'p3', name: 'bash', isError: false, receipt: { callId: 'p3', status: 'finished', exitCode: 0 } } },
      { type: 'tool/call', data: { callId: 'f3', name: 'bash', arguments: { command: 'node --test test/app.test.js' } } },
      { type: 'tool/result', data: { callId: 'f3', name: 'bash', isError: true, content: 'AssertionError', receipt: { callId: 'f3', status: 'failed', exitCode: 1 } } },
    ],
  });
  assert.equal(failAfterPass.accepted, false);
  assert.ok(failAfterPass.reasons.some((r) => r.includes('UNRESOLVED_VERIFICATION_FAILURE')));

  // 4. Stale edit after passing verification preserves STALE_VERIFICATION_AFTER_EDIT & earlier failures
  const staleAfterPass = verifier.verify({
    workspaceRoot: workDir,
    text: 'Done.',
    events: [
      { type: 'tool/call', data: { callId: 'f4', name: 'bash', arguments: { command: 'node --test test/app.test.js' } } },
      { type: 'tool/result', data: { callId: 'f4', name: 'bash', isError: true, content: 'AssertionError', receipt: { callId: 'f4', status: 'failed', exitCode: 1 } } },
      { type: 'tool/call', data: { callId: 'p4', name: 'bash', arguments: { command: 'node --test' } } },
      { type: 'tool/result', data: { callId: 'p4', name: 'bash', isError: false, receipt: { callId: 'p4', status: 'finished', exitCode: 0 } } },
      { type: 'tool/call', data: { callId: 'e4', name: 'edit_file', arguments: { path: 'app.js' } } },
      { type: 'tool/result', data: { callId: 'e4', name: 'edit_file', isError: false, receipt: { callId: 'e4', status: 'finished', exitCode: 0 } } },
    ],
  });
  assert.equal(staleAfterPass.accepted, false);
  assert.equal(staleAfterPass.checks.staleVerificationAfterEdit, true);
  assert.ok(staleAfterPass.reasons.some((r) => r.includes('STALE_VERIFICATION_AFTER_EDIT')));

  // 5. Direct helper check: failRun.index >= passRun.index never supersedes
  assert.equal(
    isFailedVerificationSuperseded(
      { index: 3, command: 'pytest', cwd: '.', exitCode: 1, output: '' },
      { index: 2, command: 'pytest', cwd: '.', exitCode: 0, output: '' },
      { lastCodeMutationIndex: 0, allMutatedFiles: ['app.js'], workspaceRoot: workDir },
    ),
    false,
  );
});

test('EvidenceVerifier unresolvedShellFailure respects true chronological order across turnReceipts and events', (t) => {
  const { workDir, store } = createEnv(t);
  const verifier = new EvidenceVerifier({ store });
  const now = Date.now();

  store.tx(() => {
    store.db
      .prepare(
        "INSERT INTO direct_sessions(id, title, workspaceRoot, state, createdAt, updatedAt) VALUES('s-ord','o',?,'running',?,?)",
      )
      .run(workDir, now, now);
    // Earlier failed bash receipt in DB
    store.db
      .prepare(
        `INSERT INTO tool_receipts(
          id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
          replayable, outward, argsDigest, status, exitCode, durationMs, createdAt, updatedAt
        ) VALUES('r-old-fail','s-ord','t-ord','c-old-fail','bash','high','irreversible_side_effect',0,0,'abc','failed',1,50,?,?)`,
      )
      .run(now, now);
  });

  // Later passing bash command in live events clears unresolvedShellFailure
  const cleared = verifier.verify({
    sessionId: 's-ord',
    turnId: 't-ord',
    workspaceRoot: workDir,
    text: '构建成功，测试通过。',
    events: [
      { type: 'tool/call', data: { callId: 'c-new-pass', name: 'bash', arguments: { command: 'echo ok' } } },
      { type: 'tool/result', data: { callId: 'c-new-pass', name: 'bash', isError: false, receipt: { callId: 'c-new-pass', status: 'finished', exitCode: 0 } } },
    ],
  });
  assert.equal(cleared.accepted, true, cleared.reasons.join('; '));

  // Earlier passing receipt in DB + later failing bash in events -> STILL fails FABRICATED_PASS_CLAIM
  store.tx(() => {
    store.db.prepare("DELETE FROM tool_receipts WHERE sessionId='s-ord'").run();
    store.db
      .prepare(
        `INSERT INTO tool_receipts(
          id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
          replayable, outward, argsDigest, status, exitCode, durationMs, createdAt, updatedAt
        ) VALUES('r-old-pass','s-ord','t-ord2','c-old-pass','bash','high','irreversible_side_effect',0,0,'abc','finished',0,50,?,?)`,
      )
      .run(now, now);
  });
  const stillFailing = verifier.verify({
    sessionId: 's-ord',
    turnId: 't-ord2',
    workspaceRoot: workDir,
    text: '测试通过。',
    events: [
      { type: 'tool/call', data: { callId: 'c-new-fail', name: 'bash', arguments: { command: 'echo bad' } } },
      { type: 'tool/result', data: { callId: 'c-new-fail', name: 'bash', isError: true, receipt: { callId: 'c-new-fail', status: 'failed', exitCode: 1 } } },
    ],
  });
  assert.equal(stillFailing.accepted, false);
  assert.ok(stillFailing.reasons.some((r) => r.includes('FABRICATED_PASS_CLAIM')));
});

test('DISK_FILE_MISSING reuses hydrated callsById + turnReceipts without shadowing and preserves strict ordering', (t) => {
  const { workDir, store } = createEnv(t);
  const verifier = new EvidenceVerifier({ store });
  const now = Date.now();

  store.tx(() => {
    store.db
      .prepare(
        "INSERT INTO direct_sessions(id, title, workspaceRoot, state, createdAt, updatedAt) VALUES('s-disk','d',?,'running',?,?)",
      )
      .run(workDir, now, now);
    store.db
      .prepare(
        "INSERT INTO direct_turns(id, sessionId, input, state, createdAt, finishedAt) VALUES('t-disk-1','s-disk','cleanup','completed',?,?)",
      )
      .run(now, now);
    // Hydrated toolCalls in direct_messages (NOT repeated as tool/call in events)
    store.db
      .prepare(
        `INSERT INTO direct_messages(sessionId, turnId, role, content, toolCalls, createdAt)
         VALUES('s-disk','t-disk-1','assistant','',?,?)`,
      )
      .run(
        JSON.stringify([
          { id: 'c-write', name: 'write_file', arguments: JSON.stringify({ path: 'tests/tmp_hydrated.py' }) },
          { id: 'c-del', name: 'bash', arguments: JSON.stringify({ command: 'rm -f tmp_hydrated.py', cwd: '/testbed/tests' }) },
        ]),
        now,
      );
    store.db
      .prepare(
        `INSERT INTO tool_receipts(
          id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
          replayable, outward, argsDigest, status, exitCode, durationMs, createdAt, updatedAt
        ) VALUES('r-w','s-disk','t-disk-1','c-write','write_file','medium','workspace_write',1,0,'w','finished',0,10,?,?),
                ('r-d','s-disk','t-disk-1','c-del','bash','high','irreversible_side_effect',0,0,'d','finished',0,10,?,?)`,
      )
      .run(now, now, now + 10, now + 10);
  });

  // Positive: events only have write_file tool/result (no tool/call, no bash tool/result in events);
  // outer callsById + turnReceipts + cwd must recognize cleanup!
  const hydratedPass = verifier.verify({
    sessionId: 's-disk',
    turnId: 't-disk-1',
    workspaceRoot: workDir,
    text: 'Cleaned up temporary file.',
    events: [
      { type: 'tool/result', data: { callId: 'c-write', name: 'write_file', isError: false, receipt: { id: 'r-w', callId: 'c-write' } } },
    ],
  });
  assert.equal(hydratedPass.accepted, true, hydratedPass.reasons.join('; '));
  assert.deepEqual(hydratedPass.checks.cleanedUpTempFiles, ['tests/tmp_hydrated.py']);

  // Negative: delete_file in turnReceipts BEFORE write_file must STILL fail DISK_FILE_MISSING
  store.tx(() => {
    store.db
      .prepare(
        "INSERT INTO direct_turns(id, sessionId, input, state, createdAt, finishedAt) VALUES('t-disk-2','s-disk','pre-del','completed',?,?)",
      )
      .run(now + 20, now + 20);
    store.db
      .prepare(
        `INSERT INTO direct_messages(sessionId, turnId, role, content, toolCalls, createdAt)
         VALUES('s-disk','t-disk-2','assistant','',?,?)`,
      )
      .run(
        JSON.stringify([
          { id: 'c-del-early', name: 'delete_file', arguments: JSON.stringify({ path: 'tests/tmp_early.py' }) },
          { id: 'c-write-late', name: 'write_file', arguments: JSON.stringify({ path: 'tests/tmp_early.py' }) },
        ]),
        now + 20,
      );
    store.db
      .prepare(
        `INSERT INTO tool_receipts(
          id, sessionId, turnId, callId, toolName, riskLevel, effectClass,
          replayable, outward, argsDigest, status, exitCode, durationMs, createdAt, updatedAt
        ) VALUES('r-de','s-disk','t-disk-2','c-del-early','delete_file','high','workspace_write',0,0,'de','finished',0,10,?,?),
                ('r-wl','s-disk','t-disk-2','c-write-late','write_file','medium','workspace_write',1,0,'wl','finished',0,10,?,?)`,
      )
      .run(now + 20, now + 20, now + 30, now + 30);
  });

  const preWriteDelFail = verifier.verify({
    sessionId: 's-disk',
    turnId: 't-disk-2',
    workspaceRoot: workDir,
    text: 'Done.',
    events: [
      { type: 'tool/result', data: { callId: 'c-write-late', name: 'write_file', isError: false, receipt: { id: 'r-wl', callId: 'c-write-late' } } },
    ],
  });
  assert.equal(preWriteDelFail.accepted, false);
  assert.ok(preWriteDelFail.reasons.some((r) => r.includes('DISK_FILE_MISSING')));
});

test('isExplicitFileDeleteCommand supports cwd/cd tracking, shell globs, and git checkout/restore (with safety rejections)', (t) => {
  const { workDir } = createEnv(t);

  // 1. cwd + compound cd tracking
  assert.equal(
    isExplicitFileDeleteCommand('rm -f tmp.py', 'tests/tmp.py', { workspaceRoot: workDir, cwd: '/testbed/tests' }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('cd tests && rm -f tmp.py', 'tests/tmp.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('cd /testbed/sub/deep; rm -f tmp.py && cd ..', 'sub/deep/tmp.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('cd tests && rm -f tmp.py', 'src/tmp.py', { workspaceRoot: workDir }),
    false,
  );
  assert.equal(
    isExplicitFileDeleteCommand('cd .. && rm -f tmp.py', 'tmp.py', { workspaceRoot: workDir }),
    false,
  );
  assert.equal(
    isExplicitFileDeleteCommand('rm -f tmp.py', 'tmp.py', { workspaceRoot: workDir, cwd: '/testbed/../outside' }),
    false,
  );

  // 2. Shell glob wildcards (*, ?) across rm/unlink/del/remove-item/ri/rmdir/rd/git rm
  assert.equal(
    isExplicitFileDeleteCommand('rm -f /testbed/tests/test_tmp_*.py', 'tests/test_tmp_env.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('rm -f tests/test_tmp_?.py', 'tests/test_tmp_1.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('rm -f tests/test_tmp_?.py', 'tests/test_tmp_10.py', { workspaceRoot: workDir }),
    false,
  );
  assert.equal(
    isExplicitFileDeleteCommand('rm -f *.py', 'tests/tmp.py', { workspaceRoot: workDir }),
    false,
  );
  assert.equal(
    isExplicitFileDeleteCommand('rm -rf tests/tmp_*', 'tests/tmp_dir/helper.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('rm -f tests/tmp_*', 'tests/tmp_dir/helper.py', { workspaceRoot: workDir }),
    false,
  );
  assert.equal(
    isExplicitFileDeleteCommand('Remove-Item -Force tmp-*.js', 'tmp-check.js', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('del /f /q tmp_?.txt', 'tmp_1.txt', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('rd /s /q tmp_*', 'tmp_dir/file.txt', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('git rm -f tests/tmp_*.py', 'tests/tmp_1.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('git rm --cached tests/tmp_*.py', 'tests/tmp_1.py', { workspaceRoot: workDir }),
    false,
  );
  assert.equal(
    isExplicitFileDeleteCommand('rm -f ../outside/*.py', 'outside/a.py', { workspaceRoot: workDir }),
    false,
  );

  // 3. git checkout & git restore
  assert.equal(
    isExplicitFileDeleteCommand('git checkout -- tests/tmp.py', 'tests/tmp.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('git checkout HEAD -- tests/tmp_*.py', 'tests/tmp_1.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('git checkout -- .', 'tests/tmp.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('git checkout tests/tmp.py', 'tests/tmp.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('git checkout main', 'main', { workspaceRoot: workDir }),
    false,
  );
  assert.equal(
    isExplicitFileDeleteCommand('git checkout -b feature-x', 'feature-x', { workspaceRoot: workDir }),
    false,
  );
  assert.equal(
    isExplicitFileDeleteCommand('git restore tests/tmp.py', 'tests/tmp.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('git restore --worktree tests/tmp_*.py', 'tests/tmp_1.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('git restore --staged tests/tmp.py', 'tests/tmp.py', { workspaceRoot: workDir }),
    false,
  );
  assert.equal(
    isExplicitFileDeleteCommand('git restore -S tests/tmp.py', 'tests/tmp.py', { workspaceRoot: workDir }),
    false,
  );
  assert.equal(
    isExplicitFileDeleteCommand('git restore -SW tests/tmp.py', 'tests/tmp.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('git restore --staged --worktree tests/tmp.py', 'tests/tmp.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('cd tests && git restore .', 'tests/tmp.py', { workspaceRoot: workDir }),
    true,
  );
  assert.equal(
    isExplicitFileDeleteCommand('cd tests && git restore .', 'src/tmp.py', { workspaceRoot: workDir }),
    false,
  );
});
