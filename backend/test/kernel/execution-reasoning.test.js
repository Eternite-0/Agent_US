import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirSafe } from '../fixtures.js';
import { Store } from '../../src/store.js';
import { pairClosed } from '../../src/context.js';
import { BudgetError } from '../../src/kernel/errors.js';
import { AgentRuntimeKernel } from '../../src/kernel/runtime.js';
import { DecisionEngine } from '../../src/kernel/agent-loop.js';
import {
  ExecutionReasoningTracker,
  STUCK_PATTERNS,
  extractFailureFingerprint,
} from '../../src/kernel/execution-reasoning.js';
import { EvidenceVerifier } from '../../src/governance/verifier.js';
import { buildRepairNote, decideRepair } from '../../src/verifier.js';
import { ToolDispatcher } from '../../src/tools/dispatcher.js';
import { createWorkspaceTools } from '../../src/workspace-tools.js';

const tc = (id, name, args = {}) => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

function createTempEnv(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-er-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-er-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  t.after(() => {
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });
  return { dataDir, workDir, store };
}

test('extractFailureFingerprint normalizes errors across volatile paths, timings, and flags', () => {
  const outputA = [
    '✖ slugify trims punctuation (12.45ms)',
    "  AssertionError [ERR_ASSERTION]: Expected 'a--b' to strictly equal 'a-b'",
    '      at slugify (C:\\Users\\dev\\AppData\\Local\\Temp\\run-111\\src\\slug.js:18:11)',
    '      at TestContext.<anonymous> (test/slug.test.js:9:5)',
    'exitCode: 1',
  ].join('\n');

  const outputB = [
    '✖ slugify trims punctuation (48.91ms)',
    "  AssertionError [ERR_ASSERTION]: Expected 'a--b' to strictly equal 'a-b'",
    '      at slugify (/tmp/run-222/src/slug.js:18:11)',
    '      at TestContext.<anonymous> (test/slug.test.js:9:5)',
    'exitCode: 1',
  ].join('\n');

  const fpA = extractFailureFingerprint({
    toolName: 'bash',
    args: { command: 'node --test test/slug.test.js' },
    output: outputA,
    receipt: { exitCode: 1 },
  });
  const fpB = extractFailureFingerprint({
    toolName: 'bash',
    args: { command: 'node --test --test-name-pattern=slugify test/slug.test.js' },
    output: outputB,
    receipt: { exitCode: 1 },
  });

  assert.equal(fpA.errorType, 'AssertionError:ERR_ASSERTION');
  assert.equal(fpA.location, 'src/slug.js:18');
  assert.equal(fpA.failingTarget, 'slugify trims punctuation');
  assert.equal(fpA.exitCode, 1);
  assert.match(fpA.assertionExcerpt, /Expected 'a--b' to strictly equal 'a-b'/);
  assert.equal(fpA.signature, fpB.signature);

  const tsFp = extractFailureFingerprint({
    toolName: 'bash',
    args: { command: 'npx tsc --noEmit' },
    output: "src/api.ts(42,7): error TS2345: Argument of type 'string' is not assignable.",
    receipt: { exitCode: 2 },
  });
  assert.equal(tsFp.errorType, 'TS2345');
  assert.equal(tsFp.location, 'src/api.ts:42');
  assert.equal(tsFp.exitCode, 2);

  const editFp = extractFailureFingerprint({
    toolName: 'edit_file',
    args: { path: 'src/calc.js' },
    output: '未找到匹配的 target 片段（已尝试精确匹配），请先 read_file 核对。',
  });
  assert.equal(editFp.errorType, 'EDIT_TARGET_NOT_FOUND');
  assert.equal(editFp.failingTarget, 'src/calc.js');
});

test('ExecutionReasoningTracker detects all 5 stuck patterns, maintains falsified-attempt ledger, and tracks live metrics', () => {
  // 1. exact_repeat (>= 3 identical tool+args+error), ignoring pending polls
  const exactTracker = new ExecutionReasoningTracker();
  for (let i = 0; i < 4; i++) {
    const poll = exactTracker.recordToolResult({
      tc: tc(`p-${i}`, 'read_process_output', { processId: 'proc-1' }),
      output: 'still running...',
      isError: false,
      pending: true,
      step: 1,
    });
    assert.equal(poll.trigger, null);
  }
  const e1 = exactTracker.recordToolResult({
    tc: tc('x1', 'edit_file', { path: 'a.js', target: 'bad', replacement: 'good' }),
    output: '未找到匹配的 target 片段',
    isError: true,
    step: 2,
  });
  const e2 = exactTracker.recordToolResult({
    tc: tc('x2', 'edit_file', { path: 'a.js', target: 'bad', replacement: 'good' }),
    output: '未找到匹配的 target 片段',
    isError: true,
    step: 3,
  });
  const e3 = exactTracker.recordToolResult({
    tc: tc('x3', 'edit_file', { path: 'a.js', target: 'bad', replacement: 'good' }),
    output: '未找到匹配的 target 片段',
    isError: true,
    step: 4,
  });
  assert.equal(e1.trigger, null);
  assert.equal(e2.trigger, null);
  assert.equal(e3.trigger?.pattern, STUCK_PATTERNS.EXACT_REPEAT);
  assert.equal(exactTracker.falsifiedAttempts.length, 3);
  assert.equal(exactTracker.errorFingerprints.length, 1);
  assert.equal(exactTracker.errorFingerprints[0].count, 3);

  // 2. ping_pong (A -> B -> A -> B)
  const pingPongTracker = new ExecutionReasoningTracker();
  pingPongTracker.recordToolResult({ tc: tc('pp1', 'read_file', { path: 'a.js' }), output: 'a', step: 1 });
  pingPongTracker.recordToolResult({ tc: tc('pp2', 'read_file', { path: 'b.js' }), output: 'b', step: 2 });
  pingPongTracker.recordToolResult({ tc: tc('pp3', 'read_file', { path: 'a.js' }), output: 'a', step: 3 });
  const pp4 = pingPongTracker.recordToolResult({ tc: tc('pp4', 'read_file', { path: 'b.js' }), output: 'b', step: 4 });
  assert.equal(pp4.trigger?.pattern, STUCK_PATTERNS.PING_PONG);

  // 3. same_error_streak (>= 3 even when args vary)
  const streakTracker = new ExecutionReasoningTracker();
  const sharedErr = "TypeError: Cannot read properties of undefined (reading 'id')\n  at parse (src/parser.js:22:5)\nexitCode: 1";
  const s1 = streakTracker.recordToolResult({
    tc: tc('se1', 'bash', { command: 'node --test test/p1.test.js' }),
    output: sharedErr,
    isError: true,
    receipt: { exitCode: 1 },
    step: 1,
  });
  const s2 = streakTracker.recordToolResult({
    tc: tc('se2', 'bash', { command: 'node --test test/p2.test.js' }),
    output: sharedErr,
    isError: true,
    receipt: { exitCode: 1 },
    step: 2,
  });
  const s3 = streakTracker.recordToolResult({
    tc: tc('se3', 'bash', { command: 'npm test' }),
    output: sharedErr,
    isError: true,
    receipt: { exitCode: 1 },
    step: 3,
  });
  assert.equal(s1.trigger, null);
  assert.equal(s2.trigger, null);
  assert.equal(s3.trigger?.pattern, STUCK_PATTERNS.SAME_ERROR_STREAK);
  const steering = streakTracker.buildDiagnosticSteeringMessage(s3.trigger);
  assert.match(steering, /\[系统防死循环提示\]/);
  assert.match(steering, /TypeError/);
  assert.match(steering, /src\/parser\.js:22/);
  assert.match(steering, /Falsified Attempts/);

  // 4. edit_test_fail_loop (>= 2 cycles without new read pivot; new read resets)
  const loopTracker = new ExecutionReasoningTracker();
  loopTracker.recordToolResult({ tc: tc('r1', 'read_file', { path: 'src/a.js' }), output: 'code', step: 1 });
  loopTracker.recordToolResult({ tc: tc('m1', 'edit_file', { path: 'src/a.js', target: '1', replacement: '2' }), output: 'ok', step: 2 });
  const lf1 = loopTracker.recordToolResult({
    tc: tc('t1', 'bash', { command: 'node --test test/a.test.js' }),
    output: 'AssertionError: expected 2 === 3 at src/a.js:10',
    isError: true,
    receipt: { exitCode: 1 },
    step: 3,
  });
  assert.equal(lf1.trigger, null);
  // Re-reading the exact same already-read file must NOT reset the loop counter
  loopTracker.recordToolResult({ tc: tc('r1b', 'read_file', { path: 'src/a.js' }), output: 'code', step: 4 });
  loopTracker.recordToolResult({ tc: tc('m2', 'edit_file', { path: 'src/a.js', target: '2', replacement: '4' }), output: 'ok', step: 5 });
  const lf2 = loopTracker.recordToolResult({
    tc: tc('t2', 'bash', { command: 'node --test test/a.test.js' }),
    output: 'AssertionError: expected 4 === 3 at src/a.js:10',
    isError: true,
    receipt: { exitCode: 1 },
    step: 6,
  });
  assert.equal(lf2.trigger?.pattern, STUCK_PATTERNS.EDIT_TEST_FAIL_LOOP);
  assert.ok(loopTracker.falsifiedAttempts.some((a) => a.editedFiles.includes('src/a.js')));

  // Reading a genuinely new root-cause file resets the edit->test fail counter
  loopTracker.recordToolResult({ tc: tc('r2', 'read_file', { path: 'src/root.js' }), output: 'root', step: 7 });
  loopTracker.recordToolResult({ tc: tc('m3', 'edit_file', { path: 'src/root.js', target: 'x', replacement: 'y' }), output: 'ok', step: 8 });
  const lf3 = loopTracker.recordToolResult({
    tc: tc('t3', 'bash', { command: 'node --test test/a.test.js' }),
    output: 'ReferenceError: z is not defined at src/root.js:4',
    isError: true,
    receipt: { exitCode: 1 },
    step: 9,
  });
  assert.equal(lf3.trigger, null);

  // 5. assistant_monologue
  const monoTracker = new ExecutionReasoningTracker();
  assert.equal(monoTracker.recordAssistantTurn({ text: 'Let me think about this.', toolCallCount: 0, step: 1 }), null);
  const mTrig = monoTracker.recordAssistantTurn({ text: 'Let me think   about this.', toolCallCount: 0, step: 2 });
  assert.equal(mTrig?.pattern, STUCK_PATTERNS.ASSISTANT_MONOLOGUE);

  // 6. Clean TDD ledger metrics
  const tdd = new ExecutionReasoningTracker();
  tdd.recordToolResult({ tc: tc('tr1', 'read_file', { path: 'src/calc.js' }), output: 'export ...', step: 1 });
  tdd.recordToolResult({
    tc: tc('tb1', 'bash', { command: 'node --test test/calc.test.js' }),
    output: 'AssertionError: 1 !== 2',
    isError: true,
    receipt: { exitCode: 1 },
    step: 2,
  });
  tdd.recordToolResult({ tc: tc('te1', 'edit_file', { path: 'src/calc.js', target: 'a', replacement: 'b' }), output: 'ok', step: 3 });
  tdd.recordToolResult({
    tc: tc('tb2', 'bash', { command: 'node --test test/calc.test.js' }),
    output: 'pass 1',
    isError: false,
    receipt: { exitCode: 0 },
    step: 4,
  });
  const metrics = tdd.getMetrics({ finalOutcomePassed: true, stopReason: 'completed' });
  assert.deepEqual(metrics.filesRead, ['src/calc.js']);
  assert.deepEqual(metrics.rootCauseFilesReadBeforeEdit, ['src/calc.js']);
  assert.deepEqual(metrics.filesMutated, ['src/calc.js']);
  assert.equal(metrics.reproducedFailureBeforeEdit, true);
  assert.equal(metrics.hasUnverifiedMutationsAfterLastPass, false);
  assert.equal(metrics.ineffectiveActionCount, 0);
  assert.equal(metrics.firstFixSucceeded, true);
  assert.equal(metrics.selfCorrectionRecovered, false);
  assert.equal(metrics.verifications.length, 2);
});

test('EvidenceVerifier enforces STALE_VERIFICATION_AFTER_EDIT and UNRESOLVED_VERIFICATION_FAILURE without pass-claim wording', (t) => {
  const { workDir, store } = createTempEnv(t);
  writeFileSync(join(workDir, 'app.js'), 'export const v = 1;\n', 'utf8');
  writeFileSync(join(workDir, 'patched.js'), 'export const p = 1;\n', 'utf8');

  const verifier = new EvidenceVerifier({ store });

  // 1. Passing verification followed by edit_file / apply_patch without re-testing -> STALE_VERIFICATION_AFTER_EDIT
  const staleRes = verifier.verify({
    workspaceRoot: workDir,
    text: 'Made a quick cleanup after tests passed.',
    events: [
      { type: 'tool/call', data: { callId: 'v1', name: 'bash', arguments: { command: 'node --test test/app.test.js' } } },
      { type: 'tool/result', data: { callId: 'v1', name: 'bash', isError: false, receipt: { callId: 'v1', toolName: 'bash', status: 'finished', exitCode: 0 } } },
      { type: 'tool/call', data: { callId: 'e1', name: 'edit_file', arguments: { path: 'app.js', target: '1', replacement: '2' } } },
      { type: 'tool/result', data: { callId: 'e1', name: 'edit_file', isError: false, receipt: { callId: 'e1', toolName: 'edit_file', status: 'finished', exitCode: 0 } } },
      {
        type: 'tool/call',
        data: {
          callId: 'p1',
          name: 'apply_patch',
          arguments: { patch: '*** Begin Patch\n*** Update File: patched.js\n@@\n-1\n+2\n*** End Patch' },
        },
      },
      { type: 'tool/result', data: { callId: 'p1', name: 'apply_patch', isError: false, receipt: { callId: 'p1', toolName: 'apply_patch', status: 'finished', exitCode: 0 } } },
    ],
  });
  assert.equal(staleRes.accepted, false);
  assert.equal(staleRes.verdict, 'fail');
  assert.equal(staleRes.checks.staleVerificationAfterEdit, true);
  assert.deepEqual(staleRes.checks.mutatedFilesAfterVerification, ['app.js', 'patched.js']);
  assert.ok(staleRes.reasons.some((r) => r.startsWith('STALE_VERIFICATION_AFTER_EDIT:')));

  const staleNote = buildRepairNote(staleRes);
  assert.match(staleNote, /STALE_VERIFICATION_AFTER_EDIT/);
  assert.match(staleNote, /app\.js, patched\.js/);
  assert.match(staleNote, /re-run the verification command/i);

  // 2. Passing verification AFTER the edit clears STALE_VERIFICATION_AFTER_EDIT
  const retestedRes = verifier.verify({
    workspaceRoot: workDir,
    text: 'Edited app.js and re-ran tests.',
    events: [
      { type: 'tool/call', data: { callId: 'v1', name: 'bash', arguments: { command: 'node --test test/app.test.js' } } },
      { type: 'tool/result', data: { callId: 'v1', name: 'bash', isError: false, receipt: { callId: 'v1', toolName: 'bash', status: 'finished', exitCode: 0 } } },
      { type: 'tool/call', data: { callId: 'e1', name: 'edit_file', arguments: { path: 'app.js', target: '1', replacement: '2' } } },
      { type: 'tool/result', data: { callId: 'e1', name: 'edit_file', isError: false, receipt: { callId: 'e1', toolName: 'edit_file', status: 'finished', exitCode: 0 } } },
      { type: 'tool/call', data: { callId: 'v2', name: 'bash', arguments: { command: 'node --test test/app.test.js' } } },
      { type: 'tool/result', data: { callId: 'v2', name: 'bash', isError: false, receipt: { callId: 'v2', toolName: 'bash', status: 'finished', exitCode: 0 } } },
    ],
  });
  assert.equal(retestedRes.accepted, true);
  assert.equal(retestedRes.checks.staleVerificationAfterEdit, false);
  assert.deepEqual(retestedRes.checks.mutatedFilesAfterVerification, []);

  // 3. UNRESOLVED_VERIFICATION_FAILURE fires even when prose avoids PASS_CLAIM_RE
  const unresolvedRes = verifier.verify({
    workspaceRoot: workDir,
    text: 'I updated app.js with my changes.',
    events: [
      { type: 'tool/call', data: { callId: 'e2', name: 'edit_file', arguments: { path: 'app.js', target: '1', replacement: '2' } } },
      { type: 'tool/result', data: { callId: 'e2', name: 'edit_file', isError: false, receipt: { callId: 'e2', toolName: 'edit_file', status: 'finished', exitCode: 0 } } },
      { type: 'tool/call', data: { callId: 'v3', name: 'bash', arguments: { command: 'node --test test/app.test.js' } } },
      {
        type: 'tool/result',
        data: {
          callId: 'v3',
          name: 'bash',
          isError: true,
          content: 'AssertionError: expected 2 to equal 42\n    at app.js:1:1\nexitCode: 1',
          receipt: { callId: 'v3', toolName: 'bash', status: 'failed', exitCode: 1 },
        },
      },
    ],
  });
  assert.equal(unresolvedRes.accepted, false);
  assert.equal(unresolvedRes.verdict, 'fail');
  assert.equal(unresolvedRes.checks.unresolvedVerificationFailure, true);
  assert.ok(unresolvedRes.reasons.some((r) => r.startsWith('UNRESOLVED_VERIFICATION_FAILURE:')));
  assert.ok(!unresolvedRes.reasons.some((r) => r.startsWith('FABRICATED_PASS_CLAIM:')));
  assert.match(unresolvedRes.diagnosticExcerpt, /AssertionError/);

  const unresolvedNote = buildRepairNote(unresolvedRes);
  assert.match(unresolvedNote, /UNRESOLVED_VERIFICATION_FAILURE/);
  assert.match(unresolvedNote, /Diagnostic failure excerpt:/);
  assert.match(unresolvedNote, /root cause/i);

  // 4. Write-only turn with 0 test runs remains accepted (no false failure)
  const writeOnlyRes = verifier.verify({
    workspaceRoot: workDir,
    text: 'Wrote app.js.',
    events: [
      { type: 'tool/call', data: { callId: 'w1', name: 'write_file', arguments: { path: 'app.js', content: 'export const v = 1;\n' } } },
      { type: 'tool/result', data: { callId: 'w1', name: 'write_file', isError: false, receipt: { callId: 'w1', toolName: 'write_file', status: 'finished', exitCode: 0 } } },
    ],
  });
  assert.equal(writeOnlyRes.accepted, true);

  // 5. decideRepair contract preserved
  assert.equal(decideRepair({ round: 1, verdict: unresolvedRes }), 'repair');
  assert.equal(decideRepair({ round: 2, verdict: unresolvedRes }), 'complete');
});

test('AgentLoop steers same_error_streak to bounded self-correction recovery and exposes reasoningMetrics', async (t) => {
  const { workDir, store } = createTempEnv(t);
  writeFileSync(join(workDir, 'bug.js'), 'export function add(a, b) { return a - b; }\n', 'utf8');
  writeFileSync(join(workDir, 'root.js'), 'export const hint = "use +";\n', 'utf8');

  let testFixed = false;
  let stepIdx = 0;
  let sawDiagnosticSteering = false;

  const adapter = {
    async *stream({ messages }) {
      stepIdx += 1;
      const allUserText = messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.content ?? [])
        .map((b) => b.text ?? '')
        .join('\n');

      if (stepIdx <= 3) {
        const callArgs = [
          { command: 'node --test test/a.test.js', timeoutMs: 5000 },
          { command: 'node --test test/a.test.js', timeoutMs: 10000 },
          { command: 'node --test test/a.test.js', cwd: '.' },
        ];
        yield {
          type: 'block-end',
          block: {
            type: 'tool-call',
            id: `tc-fail-${stepIdx}`,
            name: 'bash',
            arguments: JSON.stringify(callArgs[stepIdx - 1]),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }

      if (stepIdx === 4) {
        assert.match(allUserText, /\[系统防死循环提示\]/);
        assert.match(allUserText, /same_error_streak/);
        assert.match(allUserText, /AssertionError/);
        assert.match(allUserText, /Falsified Attempts/);
        sawDiagnosticSteering = true;
        // Heed steering: read root-cause file first
        yield {
          type: 'block-end',
          block: { type: 'tool-call', id: 'tc-read-root', name: 'read_file', arguments: JSON.stringify({ path: 'root.js' }) },
        };
        yield {
          type: 'block-end',
          block: { type: 'tool-call', id: 'tc-read-bug', name: 'read_file', arguments: JSON.stringify({ path: 'bug.js' }) },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }

      if (stepIdx === 5) {
        yield {
          type: 'block-end',
          block: {
            type: 'tool-call',
            id: 'tc-edit-bug',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'bug.js', target: 'a - b', replacement: 'a + b' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }

      if (stepIdx === 6) {
        testFixed = true;
        yield {
          type: 'block-end',
          block: { type: 'tool-call', id: 'tc-pass-test', name: 'bash', arguments: JSON.stringify({ command: 'node --test test/a.test.js' }) },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }

      yield { type: 'text-delta', text: 'Fixed bug.js and verified node --test passed.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const verifier = new EvidenceVerifier({ store });
  const kernel = new AgentRuntimeKernel({
    store,
    adapter,
    verifier: (args) => verifier.verify(args),
    toolDispatcher: new ToolDispatcher({}),
  });
  const tools = createWorkspaceTools({
    workspaceRoot: workDir,
    store,
    permissionMode: 'full-access',
    sandbox: {
      async run() {
        if (!testFixed) {
          return {
            exitCode: 1,
            stderr: 'AssertionError [ERR_ASSERTION]: Expected 3 to equal -1\n    at add (bug.js:1:36)\n',
            stdout: '',
          };
        }
        return { exitCode: 0, stdout: 'pass 1\nfail 0\n', stderr: '' };
      },
    },
  });

  t.after(() => kernel.close());

  const thrashEvents = [];
  kernel.eventRouter.subscribe('sess-er-recover', (ev) => {
    if (ev.type === 'loop/thrashing_warning') thrashEvents.push(ev);
  });

  const res = await kernel.executeTurn({
    sessionId: 'sess-er-recover',
    turnId: 'turn-er-recover',
    profile: { id: 'default', defaultMaxSteps: 12, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Fix bug.js',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix bug.js' }] }],
    tools,
  });

  assert.equal(sawDiagnosticSteering, true);
  assert.equal(res.status, 'completed');
  assert.equal(res.verifiedPass, true);
  assert.equal(thrashEvents.length, 1);
  assert.equal(thrashEvents[0].data.pattern, 'same_error_streak');

  assert.equal(res.reasoningMetrics.thrashWarned, true);
  assert.equal(res.reasoningMetrics.circuitBroken, false);
  assert.equal(res.reasoningMetrics.firstFixSucceeded, false);
  assert.equal(res.reasoningMetrics.selfCorrectionRecovered, true);
  assert.equal(res.reasoningMetrics.hasUnverifiedMutationsAfterLastPass, false);
  assert.deepEqual(res.reasoningMetrics.filesRead, ['root.js', 'bug.js']);
  assert.deepEqual(res.reasoningMetrics.filesMutated, ['bug.js']);
  assert.equal(res.reasoningMetrics.errorFingerprints.length, 1);
  assert.equal(res.reasoningMetrics.errorFingerprints[0].count, 3);
});

test('AgentLoop circuit-breaks when edit_test_fail_loop or ping_pong continues after warning', async (t) => {
  const { workDir, store } = createTempEnv(t);
  writeFileSync(join(workDir, 'calc.js'), 'export const x = 0;\n', 'utf8');

  // Case A: edit_test_fail_loop ignores diagnostic steering -> thrashing_circuit_break
  let cycleStep = 0;
  const loopAdapter = {
    async *stream() {
      cycleStep += 1;
      const isEditStep = cycleStep % 2 === 1;
      if (isEditStep) {
        yield {
          type: 'block-end',
          block: {
            type: 'tool-call',
            id: `tc-e-${cycleStep}`,
            name: 'write_file',
            arguments: JSON.stringify({ path: 'calc.js', content: `export const x = ${cycleStep};\n` }),
          },
        };
      } else {
        yield {
          type: 'block-end',
          block: {
            type: 'tool-call',
            id: `tc-t-${cycleStep}`,
            name: 'bash',
            arguments: JSON.stringify({ command: 'node --test test/calc.test.js' }),
          },
        };
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
  };

  const kernelA = new AgentRuntimeKernel({
    store,
    adapter: loopAdapter,
    toolDispatcher: new ToolDispatcher({}),
  });
  const toolsA = createWorkspaceTools({
    workspaceRoot: workDir,
    store,
    permissionMode: 'full-access',
    sandbox: {
      async run() {
        return { exitCode: 1, stderr: `AssertionError: mismatch #${cycleStep} at calc.js:1`, stdout: '' };
      },
    },
  });
  t.after(() => kernelA.close());

  const resA = await kernelA.executeTurn({
    sessionId: 'sess-loop-break',
    turnId: 'turn-loop-break',
    profile: { id: 'default', defaultMaxSteps: 14, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Fix calc',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix calc' }] }],
    tools: toolsA,
  });

  assert.equal(resA.status, 'failed');
  assert.equal(resA.stopReason, 'thrashing_circuit_break');
  assert.equal(resA.errorCode, 'LOOP_THRASHING_ABORT');
  assert.equal(resA.reasoningMetrics.circuitBroken, true);
  assert.equal(resA.reasoningMetrics.selfCorrectionRecovered, false);
  assert.ok(resA.reasoningMetrics.stuckDetections.some((d) => d.pattern === 'edit_test_fail_loop'));

  // Case B: ping_pong cycle A -> B -> A -> B -> A circuit-breaks cleanly
  let ppStep = 0;
  const ppAdapter = {
    async *stream() {
      ppStep += 1;
      const target = ppStep % 2 === 1 ? 'a.txt' : 'b.txt';
      yield {
        type: 'block-end',
        block: { type: 'tool-call', id: `tc-pp-${ppStep}`, name: 'read_file', arguments: JSON.stringify({ path: target }) },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
  };
  writeFileSync(join(workDir, 'a.txt'), 'A', 'utf8');
  writeFileSync(join(workDir, 'b.txt'), 'B', 'utf8');

  const kernelB = new AgentRuntimeKernel({
    store,
    adapter: ppAdapter,
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => kernelB.close());

  const resB = await kernelB.executeTurn({
    sessionId: 'sess-pp-break',
    turnId: 'turn-pp-break',
    profile: { id: 'default', defaultMaxSteps: 10, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Check files',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Check files' }] }],
    tools: createWorkspaceTools({ workspaceRoot: workDir, store, permissionMode: 'full-access' }),
  });
  assert.equal(resB.status, 'failed');
  assert.equal(resB.stopReason, 'thrashing_circuit_break');
  assert.ok(resB.reasoningMetrics.stuckDetections.some((d) => d.pattern === 'ping_pong'));
});

test('AgentLoop passes reasoningState to verifier, honors conditional maxRepairRounds=2, and recovers via STALE_VERIFICATION_AFTER_EDIT', async (t) => {
  const { workDir, store } = createTempEnv(t);
  writeFileSync(join(workDir, 'mod.js'), 'export const val = 1;\n', 'utf8');

  // Verify DecisionEngine default maxRepairRounds = 1 vs conditional 2
  const de = new DecisionEngine({
    verifier: () => ({ verdict: 'fail', accepted: false, reasons: ['STALE_VERIFICATION_AFTER_EDIT: stale'] }),
  });
  assert.equal(de.maxRepairRounds, 1);
  const round1Default = await de.shouldContinueOnIdle({ repairRound: 1, steps: 1, maxSteps: 10, verifierEvents: [], execution: null });
  assert.equal(round1Default.action, 'fail');
  const round1PostEdit = await de.shouldContinueOnIdle({
    repairRound: 1,
    steps: 1,
    maxSteps: 10,
    verifierEvents: [],
    execution: { requirePostEditVerification: true },
  });
  assert.equal(round1PostEdit.action, 'repair');

  let observedReasoningState = null;
  let stepCount = 0;
  const verifier = new EvidenceVerifier({ store });
  const adapter = {
    async *stream({ messages }) {
      stepCount += 1;
      if (stepCount === 1) {
        // First run passing test
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-v1', name: 'bash', arguments: JSON.stringify({ command: 'node --test test/mod.test.js' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepCount === 2) {
        // Then mutate mod.js WITHOUT re-running tests
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-e1', name: 'edit_file', arguments: JSON.stringify({ path: 'mod.js', target: '1', replacement: '2' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepCount === 3) {
        // Premature idle completion -> must be caught by STALE_VERIFICATION_AFTER_EDIT
        yield { type: 'text-delta', text: 'Updated mod.js.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      if (stepCount === 4) {
        const lastUser = messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
        assert.match(lastUser, /STALE_VERIFICATION_AFTER_EDIT/);
        assert.match(lastUser, /mod\.js/);
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-v2', name: 'bash', arguments: JSON.stringify({ command: 'node --test test/mod.test.js' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', text: 'Re-verified mod.js after edit; tests passed.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const kernel = new AgentRuntimeKernel({
    store,
    adapter,
    verifier: (args) => {
      observedReasoningState = args.reasoningState;
      return verifier.verify(args);
    },
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => kernel.close());

  const res = await kernel.executeTurn({
    sessionId: 'sess-stale-repair',
    turnId: 'turn-stale-repair',
    profile: { id: 'default', defaultMaxSteps: 10, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Update mod.js',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    execution: { requirePostEditVerification: true },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Update mod.js' }] }],
    tools: createWorkspaceTools({
      workspaceRoot: workDir,
      store,
      permissionMode: 'full-access',
      sandbox: {
        async run() {
          return { exitCode: 0, stdout: 'pass 1', stderr: '' };
        },
      },
    }),
  });

  assert.ok(observedReasoningState);
  assert.deepEqual(observedReasoningState.filesMutated, ['mod.js']);
  assert.equal(res.status, 'completed');
  assert.equal(res.verifiedPass, true);
  assert.equal(res.reasoningMetrics.repairRounds, 1);
  assert.equal(res.reasoningMetrics.selfCorrectionRecovered, true);
  assert.equal(res.reasoningMetrics.hasUnverifiedMutationsAfterLastPass, false);
});

test('AgentLoop repairs UNRESOLVED_VERIFICATION_FAILURE without pass-claim wording and circuit-breaks assistant_monologue', async (t) => {
  const { workDir, store } = createTempEnv(t);
  writeFileSync(join(workDir, 'fix.js'), 'export const ans = 0;\n', 'utf8');

  // 1. UNRESOLVED_VERIFICATION_FAILURE repair without pass-claim prose
  let testGreen = false;
  let stepU = 0;
  const verifier = new EvidenceVerifier({ store });
  const repairAdapter = {
    async *stream({ messages }) {
      stepU += 1;
      if (stepU === 1) {
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-u-e1', name: 'edit_file', arguments: JSON.stringify({ path: 'fix.js', target: '0', replacement: '1' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepU === 2) {
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-u-t1', name: 'bash', arguments: JSON.stringify({ command: 'node --test test/fix.test.js' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepU === 3) {
        // Neutral prose avoiding PASS_CLAIM_RE
        yield { type: 'text-delta', text: 'Updated fix.js and ran tests.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      if (stepU === 4) {
        const lastUser = messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
        assert.match(lastUser, /UNRESOLVED_VERIFICATION_FAILURE/);
        assert.match(lastUser, /Diagnostic failure excerpt:/);
        testGreen = true;
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-u-e2', name: 'edit_file', arguments: JSON.stringify({ path: 'fix.js', target: '1', replacement: '42' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (stepU === 5) {
        yield { type: 'block-end', block: { type: 'tool-call', id: 'tc-u-t2', name: 'bash', arguments: JSON.stringify({ command: 'node --test test/fix.test.js' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', text: 'Fixed root cause in fix.js and verified tests pass.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const kernelU = new AgentRuntimeKernel({
    store,
    adapter: repairAdapter,
    verifier: (args) => verifier.verify(args),
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => kernelU.close());

  const resU = await kernelU.executeTurn({
    sessionId: 'sess-unresolved-repair',
    turnId: 'turn-unresolved-repair',
    profile: { id: 'default', defaultMaxSteps: 10, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Fix fix.js',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix fix.js' }] }],
    tools: createWorkspaceTools({
      workspaceRoot: workDir,
      store,
      permissionMode: 'full-access',
      sandbox: {
        async run() {
          return testGreen
            ? { exitCode: 0, stdout: 'pass 1', stderr: '' }
            : { exitCode: 1, stderr: 'AssertionError: expected 1 to equal 42\n  at fix.js:1:20', stdout: '' };
        },
      },
    }),
  });
  assert.equal(resU.status, 'completed');
  assert.equal(resU.reasoningMetrics.repairRounds, 1);
  assert.equal(resU.reasoningMetrics.selfCorrectionRecovered, true);

  // 2. assistant_monologue warning -> circuit break
  const monoKernel = new AgentRuntimeKernel({
    store,
    adapter: {
      async *stream() {
        yield { type: 'text-delta', text: 'I am thinking without invoking any tools.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  });
  monoKernel.decisionEngine = new DecisionEngine({
    maxRepairRounds: 4,
    verifier: () => ({ verdict: 'fail', accepted: false, reasons: ['no_progress:2'] }),
  });
  monoKernel.loop.decisionEngine = monoKernel.decisionEngine;
  t.after(() => monoKernel.close());

  const resMono = await monoKernel.executeTurn({
    sessionId: 'sess-mono-break',
    turnId: 'turn-mono-break',
    profile: { id: 'default', defaultMaxSteps: 8, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Do work',
    model: 'mock',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Do work' }] }],
  });
  assert.equal(resMono.status, 'failed');
  assert.equal(resMono.stopReason, 'thrashing_circuit_break');
  assert.ok(resMono.reasoningMetrics.stuckDetections.some((d) => d.pattern === 'assistant_monologue'));

  // 3. exact_repeat in AgentLoop triggers diagnostic warning then circuit-breaks
  const exactKernel = new AgentRuntimeKernel({
    store,
    adapter: {
      async *stream() {
        yield {
          type: 'block-end',
          block: {
            type: 'tool-call',
            id: `tc-ex-${Math.random().toString(36).slice(2, 6)}`,
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'fix.js', target: 'NO_SUCH_TARGET', replacement: 'x' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      },
    },
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => exactKernel.close());

  const exactRes = await exactKernel.executeTurn({
    sessionId: 'sess-exact-break',
    turnId: 'turn-exact-break',
    profile: { id: 'default', defaultMaxSteps: 8, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Edit fix.js',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Edit fix.js' }] }],
    tools: createWorkspaceTools({ workspaceRoot: workDir, store, permissionMode: 'full-access' }),
  });
  assert.equal(exactRes.status, 'failed');
  assert.equal(exactRes.stopReason, 'thrashing_circuit_break');
  assert.equal(exactRes.reasoningMetrics.circuitBroken, true);
  assert.equal(exactRes.reasoningMetrics.thrashWarned, true);
  assert.ok(exactRes.reasoningMetrics.stuckDetections.some((d) => d.pattern === 'exact_repeat'));
});

test('ExecutionReasoningTracker separates policy/approval rejections, emits POLICY_BLOCK_LOOP steering, and preserves clean firstFixSucceeded/selfCorrectionRecovered', () => {
  // 1. Varied policy rejections (>= 2) do not pollute falsifiedAttempts/errorFingerprints or flip firstFixSucceeded
  const tracker = new ExecutionReasoningTracker();
  const b1 = tracker.recordToolResult({
    tc: tc('pb-1', 'bash', { command: 'ls -la' }),
    output: '[APPROVAL_DENIED] command requires approval',
    isError: true,
    receipt: { status: 'rejected_before_effect', errorCode: 'APPROVAL_DENIED' },
    step: 1,
  });
  const b2 = tracker.recordToolResult({
    tc: tc('pb-2', 'bash', { command: 'git status' }),
    output: '[POLICY_DENIED] command blocked',
    isError: true,
    receipt: { status: 'rejected_before_effect', errorCode: 'POLICY_DENIED' },
    step: 2,
  });
  assert.equal(b1.trigger, null);
  assert.equal(b2.trigger?.pattern, STUCK_PATTERNS.POLICY_BLOCK_LOOP);
  assert.equal(b2.trigger?.nonFatal, true);
  const steer = tracker.buildDiagnosticSteeringMessage(b2.trigger);
  assert.match(steer, /\[策略拦截纠偏提示\]/);
  assert.match(steer, /glob \/ grep \/ read_file/);

  assert.equal(tracker.ineffectiveActionCount, 2);
  assert.equal(tracker._policyBlockCount, 2);
  assert.equal(tracker._nonReproFailureCount, 0);
  assert.equal(tracker.falsifiedAttempts.length, 0);
  assert.equal(tracker.errorFingerprints.length, 0);
  assert.equal(tracker.verifications.length, 0);

  // Even a blocked test command before execution must NOT count as a verification failure
  tracker.recordToolResult({
    tc: tc('pb-3', 'bash', { command: 'node --test test/app.test.js' }),
    output: '[APPROVAL_DENIED] blocked before execution',
    isError: true,
    receipt: { status: 'rejected_before_effect', errorCode: 'APPROVAL_DENIED' },
    step: 3,
  });
  assert.equal(tracker.verifications.length, 0);
  assert.equal(tracker._nonReproFailureCount, 0);

  // Model pivots to read_file -> edit_file -> approved test passes on first edit (ar-06 pattern)
  tracker.recordToolResult({ tc: tc('r1', 'read_file', { path: 'src/app.js' }), output: 'code', step: 4 });
  tracker.recordToolResult({
    tc: tc('e1', 'edit_file', { path: 'src/app.js', target: 'bad', replacement: 'good' }),
    output: 'ok',
    step: 5,
  });
  tracker.recordToolResult({
    tc: tc('v1', 'bash', { command: 'node --test test/app.test.js' }),
    output: 'pass 1',
    isError: false,
    receipt: { status: 'finished', exitCode: 0 },
    step: 6,
  });

  const cleanMetrics = tracker.getMetrics({ finalOutcomePassed: true, stopReason: 'completed' });
  assert.equal(cleanMetrics.firstFixSucceeded, true);
  assert.equal(cleanMetrics.selfCorrectionRecovered, false);
  assert.equal(cleanMetrics.thrashWarned, false);
  assert.equal(cleanMetrics.policyBlockCount, 3);
  assert.equal(cleanMetrics.ineffectiveActionCount, 3);

  // 2. Unverified/failed outcome (ar-01 pattern) must NEVER report selfCorrectionRecovered=true
  const failedTracker = new ExecutionReasoningTracker();
  failedTracker.recordToolResult({
    tc: tc('fb-1', 'bash', { command: 'ls' }),
    output: '[APPROVAL_DENIED]',
    isError: true,
    receipt: { status: 'rejected_before_effect', errorCode: 'APPROVAL_DENIED' },
    step: 1,
  });
  failedTracker.recordRepairRound({ step: 2 });
  const failedMetrics = failedTracker.getMetrics({ finalOutcomePassed: false, stopReason: 'completed' });
  assert.equal(failedMetrics.selfCorrectionRecovered, false);
});

test('AgentLoop steers varied POLICY_BLOCK_LOOP without fatal break, injects token-reserve wrap-up, and emits fast manifest-only repair note', async (t) => {
  const { workDir, store } = createTempEnv(t);
  writeFileSync(join(workDir, 'calc.js'), 'export const add = (a, b) => a - b;\n', 'utf8');

  // 1. Varied policy rejections warn via POLICY_BLOCK_LOOP cleanly and let turn finish
  let policyStep = 0;
  let sawPolicyPivot = false;
  let sawTokenWrapUp = false;
  const seenSystemPrompts = [];
  const policyKernel = new AgentRuntimeKernel({
    store,
    adapter: {
      async *stream({ messages }) {
        policyStep += 1;
        if (messages[0]?.role === 'system') {
          seenSystemPrompts.push(messages[0]?.content?.[0]?.text ?? '');
        }
        const userText = messages
          .filter((m) => m.role === 'user')
          .flatMap((m) => m.content ?? [])
          .map((b) => b.text ?? '')
          .join('\n');

        if (policyStep === 1) {
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: 'tc-p1', name: 'bash', arguments: JSON.stringify({ command: 'node -e "1"' }) },
          };
          yield { type: 'usage', usage: { inputTokens: 6000, outputTokens: 1000 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (policyStep === 2) {
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: 'tc-p2', name: 'bash', arguments: JSON.stringify({ command: 'git status && git diff' }) },
          };
          yield { type: 'usage', usage: { inputTokens: 6000, outputTokens: 1000 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (policyStep === 3) {
          assert.match(userText, /\[策略拦截纠偏提示\]/);
          sawPolicyPivot = true;
          // Even a 3rd DIFFERENT blocked bash command must not fatal circuit-break
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: 'tc-p3', name: 'bash', arguments: JSON.stringify({ command: 'node tools/gen-handoff.mjs' }) },
          };
          yield { type: 'usage', usage: { inputTokens: 6000, outputTokens: 1000 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (policyStep === 4) {
          // Steps >= 4 and remaining tokens (50k - 21k = 29k <= 38k, > 2.15 * 11.2k + 1.5k) injects Tier 1 [预算收尾提醒]
          assert.match(userText, /\[预算收尾提醒\]/);
          sawTokenWrapUp = true;
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: 'tc-r1', name: 'read_file', arguments: JSON.stringify({ path: 'calc.js' }) },
          };
          yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 200 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }

        const wrapUpCount = (userText.match(/\[预算收尾提醒\]/g) || []).length;
        assert.equal(wrapUpCount, 1, 'token-reserve wrap-up advisory must be injected only once');
        yield { type: 'text-delta', text: 'Completed after pivoting to read_file.' };
        yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 100 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => policyKernel.close());

  const staticSysPrompt = 'STATIC_SYS_PROMPT_ROUND3';
  const policyRes = await policyKernel.executeTurn({
    sessionId: 'sess-policy-steer',
    turnId: 'turn-policy-steer',
    profile: { id: 'default', defaultMaxSteps: 10, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Inspect calc.js safely',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'auto-safe',
    requestApproval: async () => ({ allowed: false }),
    budget: { maxSteps: 10, maxTokens: 50_000 },
    messages: [
      { role: 'system', content: [{ type: 'text', text: staticSysPrompt }] },
      { role: 'user', content: [{ type: 'text', text: 'Inspect calc.js safely' }] },
    ],
    tools: createWorkspaceTools({ workspaceRoot: workDir, store, permissionMode: 'auto-safe' }),
  });

  assert.equal(policyRes.status, 'completed');
  assert.equal(sawPolicyPivot, true);
  assert.equal(sawTokenWrapUp, true);
  assert.equal(policyRes.reasoningMetrics.policyBlockCount, 3);
  assert.equal(policyRes.reasoningMetrics.circuitBroken, false);
  assert.ok(seenSystemPrompts.every((p) => p === staticSysPrompt), 'static system prompt must remain byte-identical');

  // 2. Identical blocked bash call repeated >= 3 times after POLICY_BLOCK_LOOP warning STILL circuit-breaks via exact_repeat
  const repeatKernel = new AgentRuntimeKernel({
    store,
    adapter: {
      async *stream() {
        yield {
          type: 'block-end',
          block: { type: 'tool-call', id: `tc-rep-${Math.random().toString(36).slice(2, 6)}`, name: 'bash', arguments: JSON.stringify({ command: 'node -e "1"' }) },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      },
    },
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => repeatKernel.close());

  const repeatRes = await repeatKernel.executeTurn({
    sessionId: 'sess-policy-exact-break',
    turnId: 'turn-policy-exact-break',
    profile: { id: 'default', defaultMaxSteps: 8, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'List files',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'auto-safe',
    requestApproval: async () => ({ allowed: false }),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'List files' }] }],
    tools: createWorkspaceTools({ workspaceRoot: workDir, store, permissionMode: 'auto-safe' }),
  });
  assert.equal(repeatRes.status, 'failed');
  assert.equal(repeatRes.stopReason, 'thrashing_circuit_break');

  // 3. Fast manifest-only repair note when EVIDENCE_INCOMPLETE occurs AFTER edits + passing verification
  const fastTracker = new ExecutionReasoningTracker({ workspaceRoot: workDir });
  fastTracker.recordToolResult({
    tc: tc('fe1', 'edit_file', { path: 'calc.js', target: 'a - b', replacement: 'a + b' }),
    output: 'ok',
    step: 1,
  });
  fastTracker.recordToolResult({
    tc: tc('fv1', 'bash', { command: 'node --test test/calc.test.js' }),
    output: 'pass 1',
    isError: false,
    receipt: { status: 'finished', exitCode: 0 },
    step: 2,
  });
  const engine = new DecisionEngine({
    verifier: () => ({
      verdict: 'fail',
      accepted: false,
      status: 'EVIDENCE_INCOMPLETE',
      reasons: ['EVIDENCE_INCOMPLETE: missing=evidenceManifest'],
      missingFields: ['evidenceManifest'],
      actualChangedFiles: ['calc.js'],
    }),
  });
  const idleDecision = await engine.shouldContinueOnIdle({
    input: 'Fix calc',
    stepText: 'Done!',
    steps: 3,
    maxSteps: 10,
    stopContinuedOnce: false,
    repairedOnce: false,
    repairRound: 0,
    verifierEvents: [],
    execution: { evidenceContract: { taskId: 't1' } },
    reasoningState: fastTracker.getState(),
  });
  assert.equal(idleDecision.action, 'repair');
  assert.match(idleDecision.note, /ALREADY PASSED/i);
  assert.match(idleDecision.note, /node --test test\/calc\.test\.js/);
  assert.match(idleDecision.note, /calc\.js/);
  assert.match(idleDecision.note, /Do NOT invoke any more tools/i);
  assert.match(idleDecision.note, /schemaVersion "1\.0\.0"/);

  // Normal repair note remains untouched when there is an unverified mutation or non-evidence reason
  const fallbackNote = buildRepairNote(
    {
      verdict: 'fail',
      status: 'EVIDENCE_INCOMPLETE',
      reasons: ['EVIDENCE_INCOMPLETE: missing=evidenceManifest'],
    },
    {
      reasoningState: {
        filesMutated: ['calc.js'],
        verifications: [{ command: 'node --test test/calc.test.js', passed: true }],
        hasUnverifiedMutationsAfterLastPass: true,
      },
    },
  );
  assert.match(fallbackNote, /Keep any work you have already verified/);
});

test('AgentLoop triggers early ~26%/38k budget wrap-up with telemetry, saves near-limit turn via zero-LLM Stage-1 budget_prune preserving pairClosed, and throws on genuine exhaustion', async (t) => {
  const { workDir, store } = createTempEnv(t);
  const alphaTag = (n) => [12, 8, 4, 0].map((s) => String.fromCharCode(97 + ((n >> s) & 15))).join('');
  const largeSource = Array.from(
    { length: 240 },
    (_, i) => `export const entry_${alphaTag(i)} = "payload_${alphaTag(i)}_data_segment_abcdefghij";`,
  ).join('\n');
  writeFileSync(join(workDir, 'large.js'), `${largeSource}\n`, 'utf8');
  writeFileSync(join(workDir, 'side.js'), `${largeSource}\n`, 'utf8');

  // Direct tracker unit check for budget telemetry + getState/getMetrics exposure
  const tracker = new ExecutionReasoningTracker({ workspaceRoot: workDir });
  assert.equal(tracker.getState().budgetReserveAdvised, false);
  assert.equal(tracker.getState().budgetFinalCallAdvised, false);
  assert.equal(tracker.getState().budgetPruneCount, 0);
  assert.equal(tracker.getMetrics().budgetReserveAdvised, false);
  assert.equal(tracker.getMetrics().budgetFinalCallAdvised, false);
  assert.equal(tracker.getMetrics().budgetPruneCount, 0);
  tracker.markBudgetReserveAdvised();
  tracker.markBudgetFinalCallAdvised();
  tracker.recordBudgetPrune();
  assert.equal(tracker.getState().budgetReserveAdvised, true);
  assert.equal(tracker.getState().budgetFinalCallAdvised, true);
  assert.equal(tracker.getState().budgetPruneCount, 1);
  assert.equal(tracker.getMetrics().budgetReserveAdvised, true);
  assert.equal(tracker.getMetrics().budgetFinalCallAdvised, true);
  assert.equal(tracker.getMetrics().budgetPruneCount, 1);

  // 1. Turn-aware Tier-1 wrap-up warning (approxTurnsLeft + context cost) + emergency Stage-1 budget_prune saves turn
  const staticSysPrompt = 'STATIC_SYS_PROMPT_ROUND4';
  let stepCall = 0;
  let sawEarlyReserve = false;
  let observedMaxTokensAtPrunedStep = null;
  let observedMessagesAtPrunedStep = null;
  const maxTokens = 160_000;

  const kernel = new AgentRuntimeKernel({
    store,
    adapter: {
      async *stream({ messages, maxTokens: stepMaxOut }) {
        stepCall += 1;
        assert.equal(messages[0]?.content?.[0]?.text, staticSysPrompt);
        const userText = messages
          .filter((m) => m.role === 'user')
          .flatMap((m) => m.content ?? [])
          .map((b) => b.text ?? '')
          .join('\n');

        if (stepCall === 1) {
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: 'tc-r4-1', name: 'read_file', arguments: JSON.stringify({ path: 'large.js' }) },
          };
          yield { type: 'usage', usage: { inputTokens: 40_000, outputTokens: 200 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (stepCall === 2) {
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: 'tc-r4-2', name: 'read_file', arguments: JSON.stringify({ path: 'side.js' }) },
          };
          yield { type: 'usage', usage: { inputTokens: 40_000, outputTokens: 200 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (stepCall === 3) {
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: 'tc-r4-3', name: 'read_file', arguments: JSON.stringify({ path: 'large.js' }) },
          };
          // Total used after step 3: 80,400 + 26,800 = 107,200 => remaining = 52,800 (> ~43k Tier-2, <= ~58k Tier-1!)
          yield { type: 'usage', usage: { inputTokens: 26_400, outputTokens: 400 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (stepCall === 4) {
          assert.match(userText, /\[预算收尾提醒\]/);
          assert.match(userText, /次模型调用/);
          assert.match(userText, /上下文计/);
          assert.match(userText, /update_plan/);
          sawEarlyReserve = true;
          // Burn another chunk so remaining drops to ~18,000 (< 10.9k tools + ~13k accumulated message tokens!)
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: 'tc-r4-4', name: 'read_file', arguments: JSON.stringify({ path: 'large.js' }) },
          };
          yield { type: 'usage', usage: { inputTokens: 34_500, outputTokens: 300 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }

        observedMaxTokensAtPrunedStep = stepMaxOut;
        observedMessagesAtPrunedStep = messages;
        yield { type: 'text-delta', text: 'Completed cleanly after emergency budget_prune.' };
        yield { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 100 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => kernel.close());

  const turnId = 'turn-r4-prune';
  const sessionId = 'sess-r4-prune';
  const emittedEvents = [];
  const unsub = kernel.eventRouter.subscribe(sessionId, (ev) => emittedEvents.push(ev));
  t.after(() => unsub());

  const res = await kernel.executeTurn({
    sessionId,
    turnId,
    profile: { id: 'default', defaultMaxSteps: 10, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Analyze large.js within token budget',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    budget: { maxSteps: 10, maxTokens, maxOutputTokens: 8192 },
    messages: [
      { role: 'system', content: [{ type: 'text', text: staticSysPrompt }] },
      { role: 'user', content: [{ type: 'text', text: 'Analyze large.js within token budget' }] },
    ],
    tools: createWorkspaceTools({ workspaceRoot: workDir, store, permissionMode: 'full-access' }),
  });

  assert.equal(res.status, 'completed');
  assert.equal(sawEarlyReserve, true);
  assert.equal(res.reasoningMetrics.budgetReserveAdvised, true);
  assert.equal(res.reasoningMetrics.budgetPruneCount, 1);
  assert.ok(
    emittedEvents.some((e) => e.type === 'context/compacted' && e.data?.stage === 'budget_prune'),
    'expected context/compacted event with stage=budget_prune',
  );
  assert.ok(observedMessagesAtPrunedStep && pairClosed(observedMessagesAtPrunedStep, 1, observedMessagesAtPrunedStep.length - 1), 'emergency budget prune must preserve pairClosed');
  assert.ok(observedMaxTokensAtPrunedStep > 0 && observedMaxTokensAtPrunedStep <= 18_000, 'maxTokens must remain strictly clamped within remaining maxTotalTokens');

  // 2. Tier-2 [最终预算警告] fires when remainingTokens <= currentStepEstimatedIn * 2.15 + 1500 without mutating tools/system
  const baseTools = createWorkspaceTools({ workspaceRoot: workDir, store, permissionMode: 'full-access' });
  const expectedToolNames = baseTools.map((tool) => tool.name);
  let tier2Step = 0;
  let sawTier2Warning = false;
  const tier2Kernel = new AgentRuntimeKernel({
    store,
    adapter: {
      async *stream({ messages, tools: sentTools }) {
        tier2Step += 1;
        assert.equal(messages[0]?.content?.[0]?.text, staticSysPrompt);
        assert.deepEqual(sentTools.map((tool) => tool.name), expectedToolNames);
        const userText = messages
          .filter((m) => m.role === 'user')
          .flatMap((m) => m.content ?? [])
          .map((b) => b.text ?? '')
          .join('\n');
        if (tier2Step <= 3) {
          yield {
            type: 'block-end',
            block: { type: 'tool-call', id: `tc-t2-${tier2Step}`, name: 'glob', arguments: JSON.stringify({ pattern: '*.js' }) },
          };
          yield { type: 'usage', usage: { inputTokens: 9_000, outputTokens: 300 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        // After 3 steps: used 27,900 out of 50,000 => remaining = 22,100 (<= 2.15 * ~11.2k + 1500 = ~25.5k, > 11.2k!)
        assert.match(userText, /\[最终预算警告 — 仅剩最后 1 次模型调用\]/);
        assert.match(userText, /严禁再调用任何工具/);
        sawTier2Warning = true;
        yield { type: 'text-delta', text: 'Stopped immediately with final summary.' };
        yield { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 100 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => tier2Kernel.close());

  const tier2Res = await tier2Kernel.executeTurn({
    sessionId: 'sess-r5-tier2',
    turnId: 'turn-r5-tier2',
    profile: { id: 'default', defaultMaxSteps: 8, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
    input: 'Check files safely',
    model: 'mock',
    workspaceRoot: workDir,
    permissionMode: 'full-access',
    budget: { maxSteps: 8, maxTokens: 50_000, maxOutputTokens: 4096 },
    messages: [
      { role: 'system', content: [{ type: 'text', text: staticSysPrompt }] },
      { role: 'user', content: [{ type: 'text', text: 'Check files safely' }] },
    ],
    tools: baseTools,
  });
  assert.equal(tier2Res.status, 'completed');
  assert.equal(sawTier2Warning, true);
  assert.equal(tier2Res.reasoningMetrics.budgetReserveAdvised, true);
  assert.equal(tier2Res.reasoningMetrics.budgetFinalCallAdvised, true);
  assert.equal(tier2Res.reasoningMetrics.budgetPruneCount, 0);

  // 3. Genuine budget exhaustion (remaining <= 2000 or unshrinkable prompt) still throws BudgetError('TOKEN_BUDGET')
  const exhaustedKernel = new AgentRuntimeKernel({
    store,
    adapter: {
      async *stream() {
        yield {
          type: 'block-end',
          block: { type: 'tool-call', id: 'tc-exh-1', name: 'read_file', arguments: JSON.stringify({ path: 'large.js' }) },
        };
        yield { type: 'usage', usage: { inputTokens: 3_500, outputTokens: 200 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      },
    },
    toolDispatcher: new ToolDispatcher({}),
  });
  t.after(() => exhaustedKernel.close());

  await assert.rejects(
    () =>
      exhaustedKernel.executeTurn({
        sessionId: 'sess-r4-exhaust',
        turnId: 'turn-r4-exhaust',
        profile: { id: 'default', defaultMaxSteps: 8, streamDeltas: false, emitAssistantMessage: false, emitToolEvents: false, persistTurn: false },
        input: 'Exhaust budget',
        model: 'mock',
        workspaceRoot: workDir,
        permissionMode: 'full-access',
        budget: { maxSteps: 8, maxTokens: 5_000, maxOutputTokens: 1024 },
        messages: [
          { role: 'system', content: [{ type: 'text', text: staticSysPrompt }] },
          { role: 'user', content: [{ type: 'text', text: 'Exhaust budget' }] },
        ],
        tools: createWorkspaceTools({ workspaceRoot: workDir, store, permissionMode: 'full-access' }),
      }),
    (err) => err instanceof BudgetError && err.code === 'TOKEN_BUDGET' && err.reasoningMetrics?.budgetReserveAdvised === false,
  );
});
