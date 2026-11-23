import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { compactTwoStage, compact } from '../src/context.js';
import { MultiStageCompactor } from '../src/context/compaction.js';
import { DynamicReplanner, collectFailureEvidence } from '../src/swarm/replan.js';
import { AdaptivePlanner } from '../src/planning/planner.js';
import { AdaptiveReplanner } from '../src/planning/replanner.js';
import { PlannerFeedbackCollector } from '../src/planning/feedback.js';
import { createMetaTools } from '../src/tools/builtin/meta-tools.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }
  async *stream(options) {
    this.calls.push({
      model: options.model,
      maxTokens: options.maxTokens,
      messages: structuredClone(options.messages),
    });
    yield* this.handler(options, this.calls.length - 1);
  }
}

test('1a. compactTwoStage Stage 1 deduplicates superseded read_file results before touching unique outputs and leaves caller unmutated', async () => {
  const repeatedContent = 'const line = "payload";\n'.repeat(220); // ~5.2k chars
  const uniqueBashOut = 'UNIQUE_GREP_MATCH_MARKER\n' + 'z'.repeat(9000) + '\nEND_UNIQUE_MARKER';

  // When under trigger -> stage === 'none', exact same options reference returned (KV cache untouched)
  const smallOpts = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ],
  };
  const noneRes = await compactTwoStage(smallOpts, { contextWindow: 8000, reserveTokens: 2000 });
  assert.equal(noneRes.stage, 'none');
  assert.equal(noneRes.compacted, false);
  assert.equal(noneRes.options, smallOpts);

  // Over trigger with an older read_file('./src\\app.js') superseded by a later read_file('src/app.js')
  const msgs = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'inspect files' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'tc-r1', name: 'read_file', arguments: JSON.stringify({ path: './src\\app.js' }) }],
    },
    { role: 'tool', toolCallId: 'tc-r1', content: [{ type: 'text', text: repeatedContent }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'tc-u1', name: 'bash', arguments: JSON.stringify({ command: 'echo ok' }) }],
    },
    { role: 'tool', toolCallId: 'tc-u1', content: [{ type: 'text', text: uniqueBashOut }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'tc-r2', name: 'read_file', arguments: JSON.stringify({ path: 'src/app.js' }) }],
    },
    { role: 'tool', toolCallId: 'tc-r2', content: [{ type: 'text', text: repeatedContent }] },
    { role: 'user', content: [{ type: 'text', text: 'latest step' }] },
  ];

  // Trigger = 4200 tokens (~16800 chars). Total ~ 5200 + 9000 + 5200 = 19400 chars (~4850 tokens) > 4200.
  // Collapsing tc-r1 (~5200 chars -> ~130 chars) drops total to ~14300 chars (~3600 tokens) <= 4200 WITHOUT touching tc-u1!
  let llmCalls = 0;
  const out = await compactTwoStage(
    { messages: msgs },
    {
      contextWindow: 5600,
      reserveTokens: 1400,
      keepRecentTokens: 1400,
      summarize: async () => {
        llmCalls++;
        return 'summary';
      },
    },
  );
  assert.equal(out.stage, 'prune');
  assert.equal(out.compacted, true);
  assert.equal(llmCalls, 0);
  assert.match(out.options.messages[3].content[0].text, /^\[compacted superseded read_file /);
  assert.equal(out.options.messages[5].content[0].text, uniqueBashOut, 'unique tool output must remain untouched when dedup fits budget');
  assert.equal(out.options.messages[7].content[0].text, repeatedContent, 'latest read_file in recent suffix must stay verbatim');
  assert.equal(msgs[3].content[0].text, repeatedContent, 'caller messages must never be mutated');

  // Overlapping vs disjoint line-range dedup
  const chunkA = 'A_LINE\n'.repeat(300); // ~2100 chars
  const chunkB = 'B_LINE\n'.repeat(300);
  const rangeMsgs = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'read ranges' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'r-overlap', name: 'read_file', arguments: JSON.stringify({ path: 'mod.js', startLine: 10, endLine: 60 }) }],
    },
    { role: 'tool', toolCallId: 'r-overlap', content: [{ type: 'text', text: chunkA }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'r-disjoint', name: 'read_file', arguments: JSON.stringify({ path: 'mod.js', startLine: 200, endLine: 250 }) }],
    },
    { role: 'tool', toolCallId: 'r-disjoint', content: [{ type: 'text', text: chunkB }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'r-later', name: 'read_file', arguments: JSON.stringify({ path: 'mod.js', startLine: 40, endLine: 90 }) }],
    },
    { role: 'tool', toolCallId: 'r-later', content: [{ type: 'text', text: chunkA }] },
    { role: 'user', content: [{ type: 'text', text: 'done' }] },
  ];
  const rangeOut = await compactTwoStage(
    { messages: rangeMsgs },
    { contextWindow: 2400, reserveTokens: 900, keepRecentTokens: 600 },
  );
  assert.equal(rangeOut.stage, 'prune');
  assert.match(rangeOut.options.messages[3].content[0].text, /^\[compacted superseded read_file /);
  assert.equal(rangeOut.options.messages[5].content[0].text, chunkB, 'disjoint line range must NOT be collapsed');
});

test('1b. compactTwoStage and compact preserve middle error/stack-trace/assertion lines on oversized test/bash outputs', async () => {
  const headLogs = 'exitCode: 1\nstdout:\n' + 'PASS setup/ok_case\n'.repeat(250); // ~4500 chars
  const middleFailure = [
    '✖ test/parser.test.js > parses nested token',
    'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '+ actual - expected',
    "+ 'broken_ast'",
    "- 'valid_ast'",
    '    at parseToken (src/parser.js:142:17)',
    '    at TestContext.<anonymous> (test/parser.test.js:38:5)',
  ].join('\n');
  const tailLogs = '\n' + 'cleanup complete log line\n'.repeat(250); // ~6500 chars
  const bigBashErr = `${headLogs}\n${middleFailure}\n${tailLogs}`;

  const msgs = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'run tests' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'tc-bash', name: 'bash', arguments: JSON.stringify({ command: 'node --test' }) }],
    },
    { role: 'tool', toolCallId: 'tc-bash', content: [{ type: 'text', text: bigBashErr }] },
    { role: 'assistant', content: [{ type: 'text', text: 'investigating' }] },
    { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
  ];

  const out = await compactTwoStage(
    { messages: msgs },
    { contextWindow: 3600, reserveTokens: 1200, keepRecentTokens: 100 },
  );
  assert.equal(out.stage, 'prune');
  const pruned = out.options.messages[3].content[0].text;
  assert.match(pruned, /compacted/);
  assert.match(pruned, /exitCode: 1/);
  assert.match(pruned, /AssertionError \[ERR_ASSERTION\]/);
  assert.match(pruned, /broken_ast/);
  assert.match(pruned, /at parseToken \(src\/parser\.js:142:17\)/);
  assert.ok(pruned.length < bigBashErr.length);

  // Also verify direct compact() fallback preserves error lines
  const directCompacted = compact({ messages: msgs }, 7500);
  const directPruned = directCompacted.messages[3].content[0].text;
  assert.match(directPruned, /AssertionError \[ERR_ASSERTION\]/);
  assert.match(directPruned, /src\/parser\.js:142:17/);
});

test('2. MultiStageCompactor preserves expanded goal, acceptanceCriteria, verificationLedger, falsifiedAttempts, and handles mock stores safely', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-lh-comp-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  try {
    const compactor = new MultiStageCompactor({ store });

    // Defensive handling of null / broken mock stores
    const emptyAnchor = compactor.extractTaskStateAnchor(null);
    assert.equal(emptyAnchor.goal, '');
    assert.deepEqual(emptyAnchor.verificationLedger, []);
    assert.deepEqual(emptyAnchor.falsifiedAttempts, []);

    const brokenCompactor = new MultiStageCompactor({
      store: {
        db: {
          prepare() {
            throw new Error('simulated mock db failure');
          },
        },
      },
    });
    const mockAnchor = brokenCompactor.extractTaskStateAnchor('sess-mock');
    assert.equal(mockAnchor.goal, '');
    assert.deepEqual(mockAnchor.modifiedFiles, []);
    assert.deepEqual(mockAnchor.verificationLedger, []);

    // Real session with >600 char goal, acceptance criteria, constraints, snapshots, failing+passing verification & repeated error signatures
    const now = Date.now();
    const longGoalText =
      'Refactor authentication middleware and token rotation across backend modules. ' +
      'Detail: '.padEnd(760, 'x') +
      '\n必须严格保留旧版兼容端点。\nAcceptance criteria: node --test test/auth.test.js must pass with 0 failures.';
    const sessId = 'sess-lh-anchor';
    const turnId = 'turn-lh-1';

    store.tx(() => {
      store.db
        .prepare(
          `INSERT INTO direct_sessions(id, title, workspaceRoot, planJson, createdAt, updatedAt)
           VALUES(?, 'LH Anchor', ?, ?, ?, ?)`,
        )
        .run(
          sessId,
          dataDir,
          JSON.stringify({
            steps: [{ id: '1', title: 'Fix auth rotation', status: 'in_progress' }],
            hypotheses: [
              { id: 'h1', statement: 'Cache key ignores tenantId', status: 'falsified', evidence: 'Test still failed after adding tenantId' },
            ],
            verificationCriteria: ['npm run check exits 0'],
            blockers: ['Waiting on token expiry fix'],
          }),
          now,
          now,
        );
      store.db
        .prepare(
          `INSERT INTO direct_messages(sessionId, turnId, role, content, createdAt)
           VALUES(?, ?, 'user', ?, ?)`,
        )
        .run(sessId, turnId, longGoalText, now);
      store.db
        .prepare(
          `INSERT INTO direct_messages(sessionId, turnId, role, content, toolCalls, createdAt)
           VALUES(?, ?, 'assistant', '', ?, ?)`,
        )
        .run(
          sessId,
          turnId,
          JSON.stringify([
            { id: 'c-test-1', name: 'bash', arguments: JSON.stringify({ command: 'node --test test/auth.test.js' }) },
            { id: 'c-test-2', name: 'bash', arguments: JSON.stringify({ command: 'node --test test/auth.test.js' }) },
            { id: 'c-check', name: 'bash', arguments: JSON.stringify({ command: 'npm run check' }) },
          ]),
          now + 1,
        );
      store.db
        .prepare(
          `INSERT INTO direct_messages(sessionId, turnId, role, content, toolCallId, toolName, meta, createdAt)
           VALUES(?, ?, 'tool', ?, 'c-test-1', 'bash', ?, ?)`,
        )
        .run(
          sessId,
          turnId,
          'exitCode: 1\nstderr:\nAssertionError: expected token rotation to keep refresh key',
          JSON.stringify({ isError: true }),
          now + 2,
        );
      store.db
        .prepare(
          `INSERT INTO direct_messages(sessionId, turnId, role, content, toolCallId, toolName, meta, createdAt)
           VALUES(?, ?, 'tool', ?, 'c-test-2', 'bash', ?, ?)`,
        )
        .run(
          sessId,
          turnId,
          'exitCode: 1\nstderr:\nAssertionError: expected token rotation to keep refresh key',
          JSON.stringify({ isError: true }),
          now + 3,
        );
      store.db
        .prepare(
          `INSERT INTO direct_messages(sessionId, turnId, role, content, toolCallId, toolName, meta, createdAt)
           VALUES(?, ?, 'tool', ?, 'c-check', 'bash', ?, ?)`,
        )
        .run(
          sessId,
          turnId,
          'exitCode: 0\nstdout:\nAll syntax and type checks passed.',
          JSON.stringify({ isError: false }),
          now + 4,
        );
      store.db
        .prepare(
          `INSERT INTO direct_messages(sessionId, turnId, role, content, createdAt)
           VALUES(?, ?, 'assistant', 'Next step recorded', ?)`,
        )
        .run(sessId, turnId, now + 5);
      store.db
        .prepare(
          `INSERT INTO direct_messages(sessionId, turnId, role, content, createdAt)
           VALUES(?, ?, 'user', 'Verify again', ?)`,
        )
        .run(sessId, turnId, now + 6);
      store.db
        .prepare(
          `INSERT INTO turn_snapshots(id, sessionId, turnId, path, existed, beforeSha256, afterSha256, createdAt)
           VALUES('snap-1', ?, ?, 'src/auth.js', 1, 'a', 'b', ?)`,
        )
        .run(sessId, turnId, now + 7);
    });

    const anchor = compactor.extractTaskStateAnchor(sessId);
    assert.ok(anchor.goal.length > 600 && anchor.goal.length <= 1200);
    assert.ok(anchor.acceptanceCriteria.some((c) => c.includes('npm run check exits 0')));
    assert.ok(anchor.acceptanceCriteria.some((c) => c.includes('node --test test/auth.test.js')));
    assert.ok(anchor.constraints.some((c) => c.includes('必须严格保留旧版兼容端点')));
    assert.deepEqual(anchor.modifiedFiles, [{ path: 'src/auth.js', action: 'modified' }]);

    const authVerify = anchor.verificationLedger.find((v) => v.command === 'node --test test/auth.test.js');
    const checkVerify = anchor.verificationLedger.find((v) => v.command === 'npm run check');
    assert.ok(authVerify);
    assert.equal(authVerify.status, 'fail');
    assert.equal(authVerify.exitCode, 1);
    assert.match(authVerify.failureExcerpt, /AssertionError: expected token rotation/);
    assert.ok(checkVerify);
    assert.equal(checkVerify.status, 'pass');
    assert.equal(checkVerify.exitCode, 0);

    const repeatedSig = anchor.falsifiedAttempts.find((f) => f.tool === 'bash' && f.count === 2);
    assert.ok(repeatedSig, 'repeated failing command signature should be aggregated with count=2');
    assert.equal(repeatedSig.repeated, true);
    assert.ok(anchor.falsifiedAttempts.some((f) => f.tool === 'update_plan' && f.target.includes('tenantId')));

    const formatted = compactor.formatAnchorText('Summary text', anchor);
    assert.match(formatted, /验收标准:/);
    assert.match(formatted, /验证台账:/);
    assert.match(formatted, /\[FAIL exit=1\] node --test test\/auth\.test\.js/);
    assert.match(formatted, /\[PASS exit=0\] npm run check/);
    assert.match(formatted, /repeated 2x/);

    // Compact non-destructively (add one more message to ensure > 6 rows)
    store.db
      .prepare("INSERT INTO direct_messages(sessionId, turnId, role, content, createdAt) VALUES(?, ?, 'assistant', 'final', ?)")
      .run(sessId, turnId, now + 8);
    const compacted = await compactor.compactSession(sessId, { keepRecent: 2 });
    assert.equal(compacted.compacted, true);
    assert.match(compacted.summary, /验证台账:/);
    assert.match(compacted.summary, /已证伪尝试与重复错误:/);
    const active = compactor.getActiveCompaction(sessId);
    assert.equal(active.taskState.verificationLedger.length, 2);
  } finally {
    store.close();
    rmDirSafe(dataDir);
  }
});

test('3. DynamicReplanner collects concrete failure evidence, produces structured JSON diagnosis with safe fallback, and prevents repeating failed strategies', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-lh-replan-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('diag-model');

  const seenPrompts = [];
  const adapter = new ScriptedAdapter(async function* (opts, callIdx) {
    seenPrompts.push(opts.messages.map((m) => m.content.map((b) => b.text).join('\n')).join('\n'));
    if (callIdx === 0) {
      // Model mistakenly suggests retry_same even though retry_same already failed!
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          rootCause: 'Token parser test failed due to edge case in quote escaping',
          failureClass: 'decomposition',
          strategy: 'retry_same',
          nextObjectivePatch: '',
          avoidPatterns: ['Do not ignore quote escaping'],
        }),
      };
    } else {
      // Non-JSON plain text fallback test
      yield { type: 'text-delta', index: 0, text: 'Plain text fallback diagnosis recommending split_subgraph.' };
    }
    yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 20 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: dataDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    const now = Date.now();
    const runId = 'run-diag-evidence';
    const childSessId = 'sess-child-diag';
    const childTurnId = 'turn-child-diag';
    const nodeId = 'node-diag-1';

    store.tx(() => {
      store.db
        .prepare("INSERT INTO direct_sessions(id, title, workspaceRoot, createdAt, updatedAt) VALUES(?, 'parent', ?, ?, ?)")
        .run('sess-parent', dataDir, now, now);
      store.db
        .prepare("INSERT INTO direct_sessions(id, title, workspaceRoot, createdAt, updatedAt) VALUES(?, 'child', ?, ?, ?)")
        .run(childSessId, dataDir, now, now);
      store.db
        .prepare(
          `INSERT INTO swarm_runs(id, sessionId, goal, status, strategyJson, budgetJson, usageJson, planVersion, currentPhase, replanCount, createdAt, updatedAt)
           VALUES(?, 'sess-parent', 'Fix quote escaping bug', 'running', '{"maxReplans":3}', '{}', '{}', 2, 'running', 1, ?, ?)`,
        )
        .run(runId, now, now);
      store.db
        .prepare(
          `INSERT INTO swarm_nodes(id, runId, nodeKey, agentProfileId, childSessionId, childTurnId, model, provider, objective, acceptance, status, errorCode, errorMessage, attempts, planVersion, budgetJson, createdAt, updatedAt)
           VALUES(?, ?, 'fix_parser', 'coder', ?, ?, 'diag-model', 'pool', 'Fix parser escaping', 'npm test passes', 'failed', 'NODE_FAILED', 'AssertionError in parser.js', 1, 2, '{}', ?, ?)`,
        )
        .run(nodeId, runId, childSessId, childTurnId, now, now);
      store.db
        .prepare(
          `INSERT INTO tool_receipts(id, sessionId, turnId, taskId, callId, toolName, riskLevel, effectClass, replayable, outward, argsDigest, status, exitCode, errorCode, createdAt, updatedAt)
           VALUES('rec-1', ?, ?, ?, 'call-bash-1', 'bash', 'high', 'irreversible_side_effect', 0, 0, 'd1', 'failed', 1, 'COMMAND_FAILED', ?, ?)`,
        )
        .run(childSessId, childTurnId, nodeId, now, now);
      store.db
        .prepare(
          `INSERT INTO direct_messages(sessionId, turnId, role, content, toolCallId, toolName, meta, createdAt)
           VALUES(?, ?, 'tool', 'exitCode: 1\nAssertionError: unescaped quote in lexer', 'call-bash-1', 'bash', '{"isError":true}', ?)`,
        )
        .run(childSessId, childTurnId, now);
      store.db
        .prepare(
          `INSERT INTO turn_snapshots(id, sessionId, turnId, path, existed, beforeSha256, afterSha256, createdAt)
           VALUES('snap-d1', ?, ?, 'src/parser.js', 1, 'a', 'b', ?)`,
        )
        .run(childSessId, childTurnId, now);
      store.db
        .prepare(
          `INSERT INTO swarm_replans(id, runId, version, failedNodeKey, strategy, reason, diffJson, createdAt)
           VALUES('rep-prior', ?, 2, 'fix_parser', 'retry_same', 'first attempt failed', '{"nodeKey":"fix_parser"}', ?)`,
        )
        .run(runId, now);
    });

    const replanner = new DynamicReplanner({
      store,
      planner: direct.swarmPlanner,
      router: direct.adaptiveRouter,
      eventRouter: direct.eventRouter,
      adapter,
    });

    const nodeRow = store.db.prepare('SELECT * FROM swarm_nodes WHERE id=?').get(nodeId);
    const runRow = store.db.prepare('SELECT * FROM swarm_runs WHERE id=?').get(runId);

    const evidence = collectFailureEvidence(runId, nodeRow, { store });
    assert.equal(evidence.failedReceipts.length, 1);
    assert.equal(evidence.failedReceipts[0].toolName, 'bash');
    assert.equal(evidence.failedReceipts[0].exitCode, 1);
    assert.ok(evidence.toolExcerpts[0].excerpt.includes('unescaped quote in lexer'));
    assert.deepEqual(evidence.modifiedFiles, ['src/parser.js']);
    assert.deepEqual(evidence.priorStrategies, ['retry_same']);

    const diag1 = await replanner.diagnoseWithModel({
      run: runRow,
      failedNode: nodeRow,
      errorCode: 'NODE_FAILED',
      errorMessage: 'AssertionError in parser.js',
    });
    assert.ok(diag1.text);
    assert.ok(diag1.usage.inputTokens === 30);
    assert.equal(diag1.diagnosis.parsedJson, true);
    assert.equal(diag1.diagnosis.failureClass, 'decomposition');
    assert.equal(diag1.diagnosis.repeatedStrategyAvoided, true, 'must prevent repeating already-failed retry_same unchanged');
    assert.notEqual(diag1.diagnosis.strategy, 'retry_same');
    assert.ok(diag1.diagnosis.avoidPatterns.some((p) => p.includes('Do not ignore quote escaping')));
    assert.match(seenPrompts[0], /unescaped quote in lexer/);
    assert.match(seenPrompts[0], /src\/parser\.js/);
    assert.match(seenPrompts[0], /strategy=retry_same/);

    // Non-JSON safe fallback
    const diagFallback = await replanner.diagnoseWithModel({
      run: runRow,
      failedNode: nodeRow,
      errorCode: 'NODE_FAILED',
      errorMessage: 'Plain failure',
    });
    assert.equal(diagFallback.diagnosis.parsedJson, false);
    assert.equal(diagFallback.diagnosis.strategy, 'split_subgraph');

    // replan() must NOT repeat retry_same because swarm_replans already recorded retry_same
    const replanRes = await replanner.replan({
      run: runRow,
      failedNode: nodeRow,
      errorCode: 'NODE_FAILED',
      errorMessage: 'AssertionError in parser.js',
      maxReplans: 3,
      useModelDiagnosis: true,
    });
    assert.equal(replanRes.replanned, true);
    assert.notEqual(replanRes.strategy, 'retry_same');
    assert.equal(replanRes.strategy, 'split_subgraph');
    assert.ok(replanRes.diff.structuredDiagnosis);
    assert.equal(replanRes.diff.evidenceSummary.failedReceipts, 1);
  } finally {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
  }
});

test('4. AdaptiveReplanner rejects degenerate no-op replans (409) and PlannerFeedbackCollector tracks summarizeReplanEffectiveness without altering summarize()', () => {
  const planner = new AdaptivePlanner();
  const replanner = new AdaptiveReplanner({ planner });
  const current = planner.createPlan({
    goal: 'Fix parser and verify',
    tasks: [
      { taskKey: 'done', objective: 'Read spec', acceptance: 'Spec read', dependencies: [] },
      { taskKey: 'fix', objective: 'Fix parser bug', acceptance: 'Tests pass', dependencies: ['done'] },
    ],
  });

  // 1) Degenerate no-op replan with same objective & failed strategy -> rejected with 409 PLANNER_DEGENERATE_REPLAN_DENIED
  assert.throws(
    () =>
      replanner.replan(
        current,
        { tasks: current.tasks.map((t) => ({ ...t })) },
        {
          completedTaskKeys: ['done'],
          failedStrategies: [{ taskKey: 'fix', strategy: 'retry_same', objective: 'Fix parser bug' }],
        },
      ),
    (err) => err.code === 'PLANNER_DEGENERATE_REPLAN_DENIED' && err.status === 409,
  );

  // 2) Same objective + changing strategy (proposal.strategy = 'switch_model') -> allowed & completed task remains immutable
  const switched = replanner.replan(
    current,
    { strategy: 'switch_model', tasks: current.tasks.map((t) => ({ ...t })) },
    {
      completedTaskKeys: ['done'],
      failedStrategies: [{ taskKey: 'fix', strategy: 'retry_same', objective: 'Fix parser bug' }],
    },
  );
  assert.equal(switched.planVersion, 2);
  assert.equal(switched.metadata.lastReplanStrategy, 'switch_model');

  // 3) Narrowing objective -> allowed
  const narrowed = replanner.replan(
    switched,
    {
      tasks: switched.tasks.map((t) =>
        t.taskKey === 'fix' ? { ...t, objective: 'Fix quote escaping in src/parser.js only' } : t,
      ),
    },
    {
      completedTaskKeys: ['done'],
      failedStrategies: [{ taskKey: 'fix', strategy: 'switch_model', objective: 'Fix parser bug' }],
    },
  );
  assert.equal(narrowed.planVersion, 3);

  // 4) Splitting failed task into subtasks -> allowed
  const split = replanner.replan(
    current,
    {
      tasks: [
        current.tasks[0],
        { taskKey: 'fix-inspect', objective: 'Reproduce quote bug', acceptance: 'Repro log', dependencies: ['done'] },
        { taskKey: 'fix-patch', objective: 'Patch escaping and test', acceptance: 'Tests pass', dependencies: ['fix-inspect'] },
      ],
    },
    {
      completedTaskKeys: ['done'],
      failedStrategies: [{ taskKey: 'fix', strategy: 'retry_same', objective: 'Fix parser bug' }],
    },
  );
  assert.equal(split.planVersion, 2);
  assert.equal(split.tasks.length, 3);

  // 5) PlannerFeedbackCollector preserves exact 8 keys in summarize() and computes summarizeReplanEffectiveness()
  const collector = new PlannerFeedbackCollector();
  collector.record({
    taskKey: 'fix',
    status: 'failed',
    success: false,
    replanStrategy: 'retry_same',
    failureSignature: 'ERR_QUOTE',
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 200,
  });
  collector.record({
    taskKey: 'fix',
    status: 'blocked',
    success: false,
    degenerateReplanBlocked: true,
    failureSignature: 'ERR_QUOTE',
  });
  collector.record({
    taskKey: 'fix',
    status: 'completed',
    success: true,
    verified: true,
    planVersion: 2,
    replanAttempt: true,
    replanStrategy: 'switch_model',
    recoveredAfterReplan: true,
    failureSignature: 'NONE',
    inputTokens: 80,
    outputTokens: 40,
    latencyMs: 150,
  });

  assert.deepEqual(collector.summarize(), {
    count: 3,
    successCount: 1,
    verifiedCount: 1,
    failedCount: 1,
    cancelledCount: 0,
    inputTokens: 180,
    outputTokens: 90,
    latencyMs: 350,
  });

  const eff = collector.summarizeReplanEffectiveness();
  assert.equal(eff.totalReplanAttempts, 1);
  assert.equal(eff.postReplanRecoveries, 1);
  assert.equal(eff.avoidedRepeatFailures, 2);
  assert.equal(eff.recoveryRate, 1);
  assert.equal(eff.strategies.switch_model, 1);
});

test('5. update_plan supports optional hypotheses, verificationCriteria, and blockers while preserving backward compatibility', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-lh-plan-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  try {
    const savedPlans = [];
    const tools = createMetaTools({
      store,
      sessionId: 'sess-plan',
      wrapResult: (_n, t) => t,
      guardFallback: async () => {},
      onPlanUpdated: (p) => savedPlans.push(p),
    });
    const updatePlan = tools.find((t) => t.name === 'update_plan');
    assert.ok(updatePlan);

    // Backward-compatible call (without new optional fields)
    const r1 = await updatePlan.execute(
      {
        explanation: 'Initial steps',
        steps: [{ id: '1', title: 'Read files', status: 'in_progress' }],
      },
      { callId: 'c1' },
    );
    assert.match(r1, /0\/1/);
    assert.equal('hypotheses' in savedPlans[0], false);
    assert.equal('verificationCriteria' in savedPlans[0], false);
    assert.equal('blockers' in savedPlans[0], false);

    // Enriched call with hypotheses, verificationCriteria, and blockers
    const parsed = updatePlan.zodSchema.safeParse({
      explanation: 'Tracking root cause and blockers',
      steps: [
        { id: '1', title: 'Read files', status: 'completed' },
        { id: '2', title: 'Apply patch', status: 'in_progress' },
      ],
      hypotheses: [
        { id: 'h1', statement: 'Missing cache key normalization', status: 'confirmed', evidence: 'reproduced in unit test' },
        'Secondary timeout hypothesis',
      ],
      verificationCriteria: ['node --test test/long-horizon-reasoning.test.js passes', { description: 'npm run check', status: 'pending' }],
      blockers: [{ id: 'b1', description: 'Needs fixture seed', severity: 'low', resolved: false }],
    });
    assert.equal(parsed.success, true);

    const r2 = await updatePlan.execute(parsed.data, { callId: 'c2' });
    assert.match(r2, /1\/2/);
    assert.equal(savedPlans[1].hypotheses.length, 2);
    assert.equal(savedPlans[1].hypotheses[0].status, 'confirmed');
    assert.equal(savedPlans[1].hypotheses[1], 'Secondary timeout hypothesis');
    assert.equal(savedPlans[1].verificationCriteria.length, 2);
    assert.equal(savedPlans[1].blockers.length, 1);
    assert.equal(savedPlans[1].blockers[0].severity, 'low');
  } finally {
    store.close();
    rmDirSafe(dataDir);
  }
});
