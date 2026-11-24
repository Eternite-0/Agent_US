import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

import { Store } from '../../src/store.js';
import { AccountPool } from '../../src/pool.js';
import { DirectAgentRuntime, buildFileChangedEventData } from '../../src/direct-agent.js';
import { pairClosed } from '../../src/context.js';
import {
  ContextEvidenceLedger,
  ReversibleContextStore,
  buildSharedAciSummary,
} from '../../src/context/aci-store.js';
import {
  ACIEngine,
  DEFAULT_DTOC_POLICY,
  DEFAULT_EPOCH_WATERMARKS,
  PHASE_WATERMARK_V25_DTOC_POLICY,
  PHASE_WATERMARK_V25_EPOCH_WATERMARKS,
  compressMessagesEpoch,
  selectOffloadableAciCandidates,
} from '../../src/context/aci-engine.js';
import {
  ContextSupervisor,
  DEFAULT_ACI_SUPERVISOR_CONFIG,
} from '../../src/context/supervisor.js';
import {
  computeCompletionReserveTokens,
  evaluatePostTestCompletionReserve,
} from '../../src/planning/budget-estimator.js';

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

async function waitUntil(fn, timeoutMs = 15000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

function makeTempEnv(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aci25-test-'));
  const workDir = join(dir, 'repo');
  mkdirSync(join(workDir, 'src'), { recursive: true });
  const store = new Store(join(dir, 'test.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  pool.createAccount({
    preset: 'deepseek',
    apiKey: 'sk-test-placeholder-1234567890',
    models: ['main-test-model', 'fast-test-model'],
  });
  pool.setDefaultModel('main-test-model');
  t.after(() => {
    try {
      if (store?.db?.isOpen) store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return { dir, workDir, store, pool };
}

function bigToolMessages({
  extraOldReadCount = 3,
  charsPerRead = 42000,
  includeContract = true,
  includeRecentEdited = true,
  includeLatestError = true,
} = {}) {
  const msgs = [
    { role: 'system', content: [{ type: 'text', text: 'System invariant rules.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Implement feature X cleanly.' }] },
  ];

  // Step 1-2: old reads (safe candidates)
  for (let i = 0; i < extraOldReadCount; i += 1) {
    const cid = `call_old_${i}`;
    const body = `// old_module_${i}.js\nexport const v${i} = "${'x'.repeat(charsPerRead)}";`;
    msgs.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: cid, name: 'read_file', arguments: JSON.stringify({ path: `src/old_${i}.js` }) }],
    });
    msgs.push({
      role: 'tool',
      toolCallId: cid,
      content: [{ type: 'text', text: body }],
    });
  }

  // Step 3: contract read (must always be shielded)
  if (includeContract) {
    msgs.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_spec', name: 'read_file', arguments: JSON.stringify({ path: 'docs/SPEC.md' }) }],
    });
    msgs.push({
      role: 'tool',
      toolCallId: 'call_spec',
      content: [{ type: 'text', text: `# SPEC\n${'Contract details '.repeat(600)}` }],
    });
  }

  // Step 4: recently edited file (step distance <= 4 at step 7)
  if (includeRecentEdited) {
    msgs.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_recent_read', name: 'read_file', arguments: JSON.stringify({ path: 'src/active.js' }) }],
    });
    msgs.push({
      role: 'tool',
      toolCallId: 'call_recent_read',
      content: [{ type: 'text', text: `// active.js\n${'code '.repeat(1200)}` }],
    });
    msgs.push({
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'call_edit_active',
          name: 'edit_file',
          arguments: JSON.stringify({ path: 'src/active.js', oldText: 'a', newText: 'b' }),
        },
      ],
    });
    msgs.push({
      role: 'tool',
      toolCallId: 'call_edit_active',
      content: [{ type: 'text', text: '{"ok":true,"path":"src/active.js"}' }],
    });
  }

  // Latest failure/error wrapped in <untrusted> (must be shielded)
  if (includeLatestError) {
    msgs.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_err', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) }],
    });
    msgs.push({
      role: 'tool',
      toolCallId: 'call_err',
      content: [
        {
          type: 'text',
          text: `<untrusted tool="bash" call_id="call_err">\nExit code 1\nAssertionError: expected 1 to equal 2\n${'trace '.repeat(800)}\n</untrusted>`,
        },
      ],
    });
  }

  // Trailing recent step so recentKeepSteps (1) doesn't overlap older candidates
  msgs.push({
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call_tail', name: 'read_file', arguments: JSON.stringify({ path: 'src/tail.js' }) }],
  });
  msgs.push({
    role: 'tool',
    toolCallId: 'call_tail',
    content: [{ type: 'text', text: 'export const tail = true;' }],
  });

  return msgs;
}

test('phase_watermark_v25 DTOC enforces 3 conditions, abstains below 1200 net savings, shields active/contract/error outputs, and keeps adaptive_single_step compat', (t) => {
  assert.equal(DEFAULT_DTOC_POLICY, 'adaptive_single_step');
  assert.equal(PHASE_WATERMARK_V25_DTOC_POLICY, 'phase_watermark_v25');

  const { store } = makeTempEnv(t);
  const aciStore = new ReversibleContextStore(store);
  const ledger = new ContextEvidenceLedger();
  const engine = new ACIEngine({
    store,
    aciStore,
    ledger,
    maxTotalTokens: 128000,
    contextWindow: 128000,
    dtocPolicy: PHASE_WATERMARK_V25_DTOC_POLICY,
    dtocMinPromptTokens: 24000,
  });

  const msgs = bigToolMessages({ extraOldReadCount: 3, charsPerRead: 42000 });

  // 1) Fails Condition (a): early research phase (step 2, verificationCount 0) even with huge single-step prompt
  const earlyProbe = engine.inspectEpoch(msgs, {
    currentStep: 2,
    verificationCount: 0,
    unverifiedSrcMutations: 0,
    cumulativeUsedTokens: 60000,
    contextWindow: 128000,
  });
  assert.equal(earlyProbe.triggered, false);
  assert.equal(earlyProbe.reason, 'phase_gate_active');

  // Step 6 WITH unverifiedSrcMutations = 1 STILL defers
  const unverifiedProbe = engine.inspectEpoch(msgs, {
    currentStep: 6,
    verificationCount: 0,
    unverifiedSrcMutations: 1,
    cumulativeUsedTokens: 60000,
    contextWindow: 128000,
  });
  assert.equal(unverifiedProbe.triggered, false);
  assert.equal(unverifiedProbe.reason, 'phase_gate_active');

  // 2) Passes (a) (verificationCount >= 1) but fails Condition (b): below 28000 single-step prompt AND < 0.65 ratio
  const smallMsgs = bigToolMessages({
    extraOldReadCount: 2,
    charsPerRead: 4000,
    includeContract: false,
    includeRecentEdited: false,
    includeLatestError: false,
  });
  const lowPressureProbe = engine.inspectEpoch(smallMsgs, {
    currentStep: 8,
    verificationCount: 1,
    unverifiedSrcMutations: 0,
    cumulativeUsedTokens: 118000, // huge cumulative ratio would trigger cumulative policy, but single-step is tiny!
    contextWindow: 128000,
  });
  assert.equal(lowPressureProbe.triggered, false);
  assert.equal(lowPressureProbe.reason, 'below_pressure_watermark');

  // 3) Passes (a) & (b) via singleStepRatio >= 0.65 on a smaller window, but fails Condition (c): net savings < 1200 tokens -> abstains cleanly without mutating aciStore!
  const tightWindowEngine = new ACIEngine({
    store,
    aciStore: new ReversibleContextStore(store),
    ledger: new ContextEvidenceLedger(),
    maxTotalTokens: 16000,
    contextWindow: 16000,
    dtocPolicy: PHASE_WATERMARK_V25_DTOC_POLICY,
    dtocMinPromptTokens: 2000,
  });
  const tinySavingsMsgs = [
    { role: 'system', content: [{ type: 'text', text: 'System'.repeat(200) }] },
    { role: 'user', content: [{ type: 'text', text: 'Task '.repeat(5000) }] },
    {
      role: 'assistant',
      step: 1,
      content: [
        { type: 'tool-call', id: 'c_small', name: 'read_file', arguments: '{"path":"src/small.js"}' },
      ],
    },
    {
      role: 'tool',
      step: 1,
      toolCallId: 'c_small',
      content: [{ type: 'text', text: 'x'.repeat(1600) }], // < 1200 tokens net savings after stub overhead
    },
    {
      role: 'assistant',
      step: 6,
      content: [
        { type: 'tool-call', id: 'c_tail', name: 'read_file', arguments: '{"path":"src/tail.js"}' },
      ],
    },
    {
      role: 'tool',
      step: 6,
      toolCallId: 'c_tail',
      content: [{ type: 'text', text: 'y'.repeat(18000) }], // age = 7 - 6 = 1 <= 4 -> recent-shielded while only small candidate is eligible
    },
  ];
  const abstainRes = tightWindowEngine.compress(tinySavingsMsgs, {
    currentStep: 7,
    verificationCount: 1,
    unverifiedSrcMutations: 0,
    contextWindow: 16000,
  });
  assert.equal(abstainRes.triggered, false);
  assert.equal(abstainRes.compressedCount, 0);
  assert.equal(abstainRes.reason, 'insufficient_net_savings');
  assert.equal(abstainRes.messages, tinySavingsMsgs);
  assert.equal(tightWindowEngine.epochState.epochCount, 0);

  // 4) Passes ALL THREE conditions -> triggers, shields SPEC.md + active.js (<=4 steps) + <untrusted> latest error, compresses only old reads!
  const candidates = selectOffloadableAciCandidates(msgs, {
    currentStep: 7,
    dtocPolicy: PHASE_WATERMARK_V25_DTOC_POLICY,
    activeMutationTargets: ['src/active.js'],
  });
  const candidatePaths = candidates.map((c) => c.path);
  assert.ok(candidatePaths.includes('src/old_0.js'));
  assert.ok(candidatePaths.includes('src/old_1.js'));
  assert.equal(candidatePaths.includes('docs/SPEC.md'), false, 'contract SPEC.md must be strictly shielded');
  assert.equal(candidatePaths.includes('src/active.js'), false, 'recently mutated file <=4 steps must be strictly shielded');
  assert.equal(
    candidates.some((c) => c.toolCallId === 'call_err'),
    false,
    'latest wrapped <untrusted> error output must be strictly shielded',
  );

  const compRes = engine.compress(msgs, {
    currentStep: 7,
    verificationCount: 1,
    unverifiedSrcMutations: 0,
    cumulativeUsedTokens: 60000,
    contextWindow: 128000,
    activeMutationTargets: ['src/active.js'],
  });
  assert.equal(compRes.triggered, true);
  assert.equal(compRes.pairClosedValid, true);
  assert.equal(pairClosed(compRes.messages), true);
  assert.ok(compRes.compressedCount >= 2);
  assert.ok(compRes.netSavingsTokens >= 1200);
  // KV prefix unchanged: system and initial user message remain verbatim
  assert.equal(compRes.messages[0].content[0].text, msgs[0].content[0].text);
  assert.equal(compRes.messages[1].content[0].text, msgs[1].content[0].text);
  // Shielded messages preserved verbatim
  const specToolMsg = compRes.messages.find((m) => m.toolCallId === 'call_spec');
  assert.ok(specToolMsg.content[0].text.startsWith('# SPEC'));
  const activeToolMsg = compRes.messages.find((m) => m.toolCallId === 'call_recent_read');
  assert.ok(activeToolMsg.content[0].text.startsWith('// active.js'));
  const errToolMsg = compRes.messages.find((m) => m.toolCallId === 'call_err');
  assert.ok(errToolMsg.content[0].text.includes('AssertionError: expected 1 to equal 2'));

  // 5) Backward compatibility: explicit adaptive_single_step keeps [0.60, 0.82] watermarks while phase_watermark_v25 raises defaults to [0.78, 0.90]
  assert.deepEqual([...DEFAULT_EPOCH_WATERMARKS], [0.6, 0.82]);
  assert.deepEqual([...PHASE_WATERMARK_V25_EPOCH_WATERMARKS], [0.78, 0.9]);
  assert.deepEqual([...engine.watermarks], [0.78, 0.9]);
  const legacyEngine = new ACIEngine({
    store,
    aciStore: new ReversibleContextStore(store),
    ledger: new ContextEvidenceLedger(),
    dtocPolicy: DEFAULT_DTOC_POLICY,
  });
  assert.deepEqual([...legacyEngine.watermarks], [0.6, 0.82]);

  const compatRes = compressMessagesEpoch(msgs, {
    aciStore: new ReversibleContextStore(store),
    ledger: new ContextEvidenceLedger(),
    currentStep: 7,
    dtocPolicy: DEFAULT_DTOC_POLICY,
    dtocMinPromptTokens: 24000,
    cumulativeUsedTokens: 60000,
    contextWindow: 128000,
  });
  assert.equal(compatRes.triggered, true);
  assert.ok(compatRes.compressedCount >= 1);
});

test('Post-test-pass one-shot completion grace buffer allows one final text synthesis with tools:[] when budget reaches maxTotalTokens, and blocks a second overspent step', async (t) => {
  const { workDir, store, pool } = makeTempEnv(t);
  mkdirSync(join(workDir, 'test'), { recursive: true });
  writeFileSync(join(workDir, 'src', 'grace.js'), 'export const x = 1;\n', 'utf8');
  writeFileSync(
    join(workDir, 'test', 'grace.test.js'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('grace ok', () => { assert.equal(1, 1); });\n",
    'utf8',
  );

  // Case A: Tests passed & no unverified src mutations at >= maxTokens -> one-shot grace step runs with tools:[] and succeeds
  let sawToolsOnGrace = null;
  const adapterPass = new ScriptedAdapter(async function* (opts, idx) {
    if (idx === 0) {
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc_grace_read',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'src/grace.js' }),
        },
      };
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc_grace_edit',
          name: 'edit_file',
          arguments: JSON.stringify({ path: 'src/grace.js', target: 'x = 1', replacement: 'x = 2' }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 200 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (idx === 1) {
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc_grace_test',
          name: 'bash',
          arguments: JSON.stringify({ command: 'node --test test/grace.test.js' }),
        },
      };
      // Reach exact 10000 / 10000 maxTokens right after passing verification!
      yield { type: 'usage', usage: { inputTokens: 8000, outputTokens: 1000 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    sawToolsOnGrace = opts.tools;
    yield { type: 'text-delta', index: 0, text: 'Final synthesis delivered within one-shot post-pass grace.' };
    yield { type: 'usage', usage: { inputTokens: 400, outputTokens: 80 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const runtimeA = new DirectAgentRuntime(store, pool, {
    adapter: adapterPass,
    defaultWorkspace: workDir,
    dataRoot: workDir,
  });
  try {
    const sessA = runtimeA.createSession({
      model: 'main-test-model',
      workspaceRoot: workDir,
      permissionMode: 'full-access',
      budget: { maxTokens: 10000, maxOutputTokens: 2048 },
    });
    const { turn: turnA } = runtimeA.startTurn(sessA.id, {
      input: 'Edit src/grace.js and verify with test/grace.test.js.',
      aciProfile: 'full_aci',
    });
    const doneA = await waitUntil(() =>
      store.db
        .prepare("SELECT * FROM direct_events WHERE turnId=? AND type='turn/completed' ORDER BY seq DESC LIMIT 1")
        .get(turnA.id),
    );
    const doneData = JSON.parse(doneA.data);
    assert.deepEqual(sawToolsOnGrace, [], 'Grace synthesis step must disable tools via tools: []');
    assert.ok(doneData.text.includes('Final synthesis delivered'));
  } finally {
    await runtimeA.close();
  }

  // Case B: No passing test yet at >= maxTokens -> must still throw TOKEN_BUDGET!
  const adapterFail = new ScriptedAdapter(async function* (opts, idx) {
    if (idx === 0) {
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc_no_test_read',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'src/grace.js' }),
        },
      };
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc_no_test_edit',
          name: 'edit_file',
          arguments: JSON.stringify({ path: 'src/grace.js', target: 'x = 2', replacement: 'x = 3' }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 9000, outputTokens: 1500 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'Should never run.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const runtimeB = new DirectAgentRuntime(store, pool, {
    adapter: adapterFail,
    defaultWorkspace: workDir,
    dataRoot: workDir,
  });
  try {
    const sessB = runtimeB.createSession({
      model: 'main-test-model',
      workspaceRoot: workDir,
      permissionMode: 'full-access',
      budget: { maxTokens: 10000, maxOutputTokens: 2048 },
    });
    const { turn: turnB } = runtimeB.startTurn(sessB.id, {
      input: 'Edit src/grace.js without running tests.',
      aciProfile: 'full_aci',
    });
    const failedB = await waitUntil(() =>
      store.db
        .prepare("SELECT * FROM direct_events WHERE turnId=? AND type='turn/failed' ORDER BY seq DESC LIMIT 1")
        .get(turnB.id),
    );
    assert.equal(JSON.parse(failedB.data).code, 'TOKEN_BUDGET');
  } finally {
    await runtimeB.close();
  }
});

test('ContextEvidenceLedger.mergeFrom is idempotent, toSharedDigest & buildSharedAciSummary respect maxChars, and DirectAgentRuntime mid-turn retry preserves ledger & readFiles', async (t) => {
  // Part A: Unit tests for mergeFrom + toSharedDigest + buildSharedAciSummary
  const ledgerA = new ContextEvidenceLedger();
  ledgerA.recordAdmission({
    callId: 'c1',
    path: 'src/auth.js',
    toolName: 'read_file',
    decision: 'SUPPORTING',
    criticalDomains: ['auth'],
    score: 0.9,
    originalTokens: 1500,
    injectedTokens: 300,
    tokensSaved: 1200,
    step: 1,
    reason: 'admitted',
    refId: 'ref_auth_1',
    uri: 'artifact://ref_auth_1',
    sha256: 'a'.repeat(64),
  });
  ledgerA.recordSupervisorCall({
    stage: 'admission',
    model: 'fast-model',
    candidateCount: 2,
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    durationMs: 22,
    ok: true,
    step: 1,
  });

  const ledgerB = new ContextEvidenceLedger();
  ledgerB.recordAdmission({
    callId: 'c1', // duplicate of ledgerA
    path: 'src/auth.js',
    toolName: 'read_file',
    decision: 'SUPPORTING',
    originalTokens: 1500,
    injectedTokens: 300,
    tokensSaved: 1200,
    step: 1,
    refId: 'ref_auth_1',
    uri: 'artifact://ref_auth_1',
    sha256: 'a'.repeat(64),
  });
  ledgerB.recordCompressed({
    toolCallId: 'c2',
    refId: 'ref_old_2',
    uri: 'artifact://ref_old_2',
    sha256: 'b'.repeat(64),
    path: 'src/legacy.js',
    originalTokens: 4000,
    stubTokens: 80,
    tokensSaved: 3920,
    step: 3,
    epoch: 1,
  });
  ledgerB.recordRecovery({
    refId: 'ref_auth_1',
    uri: 'artifact://ref_auth_1',
    sha256: 'a'.repeat(64),
    path: 'src/auth.js',
    level: 'verbatim',
    verified: true,
    tokensRestored: 1500,
    triggeredBy: 'read_file',
    step: 4,
  });

  ledgerA.mergeFrom(ledgerB);
  assert.equal(ledgerA.admissions.length, 1, 'duplicate admission must be deduplicated');
  assert.equal(ledgerA.compressed.length, 1);
  assert.equal(ledgerA.recoveries.length, 1);
  assert.equal(ledgerA.supervisorCalls.length, 1);
  assert.equal(ledgerA.summary().recoveriesCount, 1);
  assert.equal(ledgerA.computeGovernanceMetrics().recoveryStats.hashVerifiedCount, 1);

  // Merge again -> idempotent
  ledgerA.mergeFrom(ledgerB);
  assert.equal(ledgerA.admissions.length, 1);
  assert.equal(ledgerA.compressed.length, 1);
  assert.equal(ledgerA.recoveries.length, 1);

  const digest = ledgerA.toSharedDigest({ maxChars: 240 });
  assert.ok(digest.length <= 240);
  assert.ok(digest.includes('Shared Swarm ACI Digest') || digest.includes('admission'));
  assert.equal(buildSharedAciSummary(null), '');
  assert.ok(buildSharedAciSummary({ ledger: ledgerA.toJSON() }, { maxChars: 200 }).length <= 200);

  // Part B: DirectAgentRuntime mid-turn automatic retry preserves admissions & filesRead
  const { workDir, store, pool } = makeTempEnv(t);
  writeFileSync(join(workDir, 'src', 'small.js'), 'export const ok = true;\n', 'utf8');
  writeFileSync(
    join(workDir, 'src', 'large_doc.md'),
    Array.from({ length: 120 }, (_, i) => `Section ${i}: unrelated inventory item ${i} ${'data '.repeat(12)}`).join('\n'),
    'utf8',
  );

  let callNum = 0;
  const adapter = new ScriptedAdapter(async function* () {
    callNum += 1;
    if (callNum === 1) {
      // Attempt 1 Step 1: read both files (large_doc triggers ACI admission stub + recorded read; small.js recorded in filesRead)
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc_r_small',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'src/small.js' }),
        },
      };
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc_r_large',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'src/large_doc.md' }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 40 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (callNum === 2) {
      // Attempt 1 Step 2: emit partial text then throw transient reset so InferenceEngine bubbles out to RecoveryWorker retry!
      yield { type: 'text-delta', index: 0, text: 'partial-' };
      const err = new Error('transient socket reset');
      err.code = 'ECONNRESET';
      throw err;
    }
    // Attempt 2: complete directly
    yield { type: 'text-delta', index: 0, text: 'Completed after automatic retry.' };
    yield { type: 'usage', usage: { inputTokens: 140, outputTokens: 25 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const runtime = new DirectAgentRuntime(store, pool, {
    adapter,
    defaultWorkspace: workDir,
    dataRoot: workDir,
  });

  try {
    const session = runtime.createSession({ model: 'main-test-model', workspaceRoot: workDir });
    const { turn } = runtime.startTurn(session.id, {
      input: 'Read src/small.js and summarize without losing context across retry.',
      aciProfile: 'full_aci',
      aciOptions: { admissionMinChars: 1200 },
    });

    const terminalTurn = await waitUntil(() =>
      store.db
        .prepare("SELECT * FROM direct_turns WHERE id=? AND state IN ('completed','failed','cancelled')")
        .get(turn.id),
    );
    assert.equal(terminalTurn.state, 'completed', `Turn ended in ${terminalTurn.state}: ${terminalTurn.error}`);
    const completedEv = store.db
      .prepare("SELECT * FROM direct_events WHERE turnId=? AND type='turn/completed' ORDER BY seq DESC LIMIT 1")
      .get(turn.id);
    assert.ok(completedEv, 'Expected turn/completed event');
    const jobRow = store.db.prepare('SELECT attempts FROM runtime_jobs WHERE turnId=?').get(turn.id);
    assert.ok(jobRow.attempts >= 2, 'RecoveryWorker should have retried mid-turn automatically');
    const data = JSON.parse(completedEv.data);
    const rm = data.reasoningMetrics;
    assert.ok(rm.filesRead.includes('src/small.js'), 'filesRead from attempt 1 must survive retry');
    assert.ok(
      rm.aciMetrics.ledger.admissions.length >= 1,
      'ACI admissions from attempt 1 must survive mid-turn retry',
    );
    assert.equal(rm.aciMetrics.aciProfile, 'full_aci');
    assert.equal(rm.aciMetrics.dtocPolicy, 'phase_watermark_v25');
    assert.ok(data.budgetWatermarks, 'TURN_COMPLETED must carry budgetWatermarks');
  } finally {
    await runtime.close();
  }
});

test('ContextSupervisor defaults to 8s timeout and consecutive-timeout circuit breaker opens for 60s and resets on ok: true', async (t) => {
  assert.equal(DEFAULT_ACI_SUPERVISOR_CONFIG.timeoutMs, 8000);

  const { store, pool } = makeTempEnv(t);
  let mode = 'hang';
  let adapterCalls = 0;
  let fakeNow = 1_700_000_000_000;

  const supAdapter = new ScriptedAdapter(async function* (opts) {
    adapterCalls += 1;
    if (mode === 'hang') {
      await new Promise((_, reject) => {
        if (opts.signal?.aborted) reject(new Error('ABORTED'));
        opts.signal?.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
      });
      return;
    }
    yield {
      type: 'text-delta',
      index: 0,
      text: JSON.stringify({ keepRefs: ['ref1'], compressRefs: [] }),
    };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const sup = new ContextSupervisor({
    store,
    pool,
    adapter: supAdapter,
    breakerThreshold: 2,
    breakerCooldownMs: 60_000,
    nowFn: () => fakeNow,
  });
  const cfgOverride = {
    enabled: true,
    mode: 'custom',
    model: 'fast-test-model',
    timeoutMs: 500,
  };

  const candidates = [
    { refId: 'ref1', toolName: 'read_file', path: 'src/a.js', chars: 5000, summary: 'file a' },
  ];

  // 1st consecutive timeout: streak = 1, circuit still closed
  const r1 = await sup.supervise({ query: 'fix bug', candidates, configOverride: cfgOverride });
  assert.equal(r1.ok, false);
  assert.equal(r1.fallback, 'deterministic');
  assert.equal(r1.timedOut, true);
  assert.equal(r1.circuitOpen, false);
  assert.equal(sup.getStatus().timeoutStreak, 1);
  assert.equal(sup.isCircuitOpen(), false);

  // 2nd consecutive timeout: streak = 2 -> circuit opens for 60_000ms
  const r2 = await sup.supervise({ query: 'fix bug', candidates, configOverride: cfgOverride });
  assert.equal(r2.ok, false);
  assert.equal(r2.timedOut, true);
  assert.equal(r2.circuitOpen, true);
  assert.equal(sup.getStatus().timeoutStreak, 2);
  assert.equal(sup.isCircuitOpen(), true);
  assert.equal(sup.getStatus().circuitOpenedUntil, fakeNow + 60_000);

  // 3rd call while circuit is open: immediately falls back with durationMs === 0 without invoking adapter
  const callsBeforeFastBypass = adapterCalls;
  const r3 = await sup.supervise({ query: 'fix bug', candidates, configOverride: cfgOverride });
  assert.equal(r3.ok, false);
  assert.equal(r3.fallback, 'deterministic');
  assert.equal(r3.circuitOpen, true);
  assert.equal(r3.durationMs, 0);
  assert.equal(adapterCalls, callsBeforeFastBypass, 'adapter must not be called when circuit is open');

  const r3Admit = await sup.admitCandidates({ query: 'fix bug', candidates, configOverride: cfgOverride });
  assert.equal(r3Admit.ok, false);
  assert.equal(r3Admit.fallback, 'deterministic');
  assert.equal(r3Admit.circuitOpen, true);
  assert.equal(r3Admit.durationMs, 0);
  assert.equal(adapterCalls, callsBeforeFastBypass);

  // 60s cooldown elapses + healthy call succeeds -> resets timeoutStreak to 0 & closes circuit
  fakeNow += 60_001;
  mode = 'ok';
  const r4 = await sup.supervise({ query: 'fix bug', candidates, configOverride: cfgOverride });
  assert.equal(r4.ok, true);
  assert.deepEqual(r4.keepRefs, ['ref1']);
  assert.equal(sup.getStatus().timeoutStreak, 0);
  assert.equal(sup.isCircuitOpen(), false);
});

test('Post-test completion reserve gates non-essential tools, runs Stage-1 stale tool prune to avoid TOKEN_BUDGET, emits budgetWatermarks, and preserves onFileChanged diff fields', async (t) => {
  // Part A: pure estimator unit assertions
  assert.equal(
    computeCompletionReserveTokens({ currentStepEstimatedIn: 1000, maxTotalTokens: 100000 }),
    12000,
  );
  assert.equal(
    computeCompletionReserveTokens({ currentStepEstimatedIn: 4000, maxTotalTokens: 20000 }),
    7200,
  );
  assert.equal(
    evaluatePostTestCompletionReserve({
      lastRunTestsPassed: true,
      verificationCount: 1,
      unverifiedSrcMutations: 1,
      usedTokens: 15000,
      maxTotalTokens: 20000,
      currentStepEstimatedIn: 4000,
    }).postTestReserveActive,
    false,
    'must remain inactive while unverifiedSrcMutations > 0',
  );
  assert.equal(
    evaluatePostTestCompletionReserve({
      lastRunTestsPassed: true,
      verificationCount: 1,
      unverifiedSrcMutations: 0,
      usedTokens: 15000,
      maxTotalTokens: 20000,
      currentStepEstimatedIn: 4000,
    }).postTestReserveActive,
    true,
  );

  // Part B: DirectAgentRuntime full loop with edit -> bulky stale read -> passing test -> post-test reserve gating + Stage-1 prune -> clean completion
  const { workDir, store, pool } = makeTempEnv(t);
  mkdirSync(join(workDir, 'test'), { recursive: true });
  writeFileSync(join(workDir, 'src', 'app.js'), 'export const val = 1;\n', 'utf8');
  writeFileSync(
    join(workDir, 'test', 'app.test.js'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('val ok', () => { assert.equal(1 + 1, 2); });\n",
    'utf8',
  );
  writeFileSync(
    join(workDir, 'src', 'stale_big.txt'),
    Array.from({ length: 420 }, (_, i) => `LOG LINE ${i}: informational trace output ${'abcdef12'.repeat(5)}`).join('\n'),
    'utf8',
  );

  const adapter = new ScriptedAdapter(async function* (opts, idx) {
    if (idx === 0) {
      // Step 1: read stale large log file + src/app.js, and edit src/app.js
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc_big_read',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'src/stale_big.txt' }),
        },
      };
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc_app_read',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'src/app.js' }),
        },
      };
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc_edit_app',
          name: 'edit_file',
          arguments: JSON.stringify({
            path: 'src/app.js',
            target: 'export const val = 1;',
            replacement: 'export const val = 2;',
          }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 200 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (idx === 1) {
      // Step 2: run passing node --test -> clears unverifiedSrcMutations & sets lastRunTestsPassed = true
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc_pass_test',
          name: 'bash',
          arguments: JSON.stringify({ command: 'node --test test/app.test.js' }),
        },
      };
      // Consume enough tokens that remaining (~5000) <= completionReserveTokens (~9000) while unpruned prompt > 5000!
      yield { type: 'usage', usage: { inputTokens: 10600, outputTokens: 1000 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (idx === 2) {
      // Step 3: postTestReserveActive is now true! Model attempts optional read_file -> gated!
      yield {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'tc_opt_read',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'src/app.js' }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 400, outputTokens: 100 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    // Step 4: verify gating notice reached model and Stage-1 prune saved enough tokens to answer cleanly!
    const hasGateNotice = opts.messages.some(
      (m) =>
        m.role === 'tool' &&
        Array.isArray(m.content) &&
        String(m.content[0]?.text ?? '').includes('[POST_TEST_RESERVE_GATED]'),
    );
    assert.equal(hasGateNotice, true, 'Model must receive [POST_TEST_RESERVE_GATED] notice');
    yield { type: 'text-delta', index: 0, text: 'All tests passed and delivery is complete.' };
    yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 100 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const runtime = new DirectAgentRuntime(store, pool, {
    adapter,
    defaultWorkspace: workDir,
    dataRoot: workDir,
  });

  try {
    // Budget maxTokens=18000: after step 2 usage = 13000, remaining = 5000 <= reserveTokens (~8500) -> activates postTestReserveActive & Stage-1 stale prune!
    const session = runtime.createSession({
      model: 'main-test-model',
      workspaceRoot: workDir,
      permissionMode: 'full-access',
      budget: { maxTokens: 18000, maxOutputTokens: 2048 },
    });
    const { turn } = runtime.startTurn(session.id, {
      input: 'Edit src/app.js and run test.',
      aciProfile: 'raw_full',
    });

    const terminalTurn = await waitUntil(() =>
      store.db
        .prepare("SELECT * FROM direct_turns WHERE id=? AND state IN ('completed','failed','cancelled')")
        .get(turn.id),
    );
    assert.equal(terminalTurn.state, 'completed', `Turn ended in ${terminalTurn.state}: ${terminalTurn.error}`);
    const completedEv = store.db
      .prepare("SELECT * FROM direct_events WHERE turnId=? AND type='turn/completed' ORDER BY seq DESC LIMIT 1")
      .get(turn.id);
    assert.ok(completedEv, 'Expected turn/completed event');
    const completedData = JSON.parse(completedEv.data);
    assert.ok(completedData.budgetWatermarks, 'turn/completed must expose budgetWatermarks');
    assert.equal(
      completedData.budgetWatermarks.postTestReserveActive,
      true,
      `Expected postTestReserveActive=true, got ${JSON.stringify({
        budgetWatermarks: completedData.budgetWatermarks,
        verifications: completedData.reasoningMetrics?.verifications,
        unverifiedSrc: completedData.reasoningMetrics?.unverifiedSrcMutations,
      })}`,
    );
    assert.equal(completedData.budgetWatermarks.maxTokens, 18000);
    assert.ok(completedData.budgetWatermarks.usedTokens <= 18000);
    assert.ok(completedData.budgetWatermarks.reserveTokens >= 3200);
    assert.ok(completedData.reasoningMetrics.budgetPruneCount >= 1, 'Emergency Stage-1 stale tool prune should have fired');

    // Verify file/changed persisted event & additive diff fields forwarding in DirectAgentRuntime
    const fileChangedRows = store.db
      .prepare("SELECT data FROM direct_events WHERE turnId=? AND type='file/changed'")
      .all(turn.id);
    assert.ok(fileChangedRows.length >= 1);
    const fcData = JSON.parse(fileChangedRows[0].data);
    assert.equal(fcData.path, 'src/app.js');
    assert.ok(Buffer.from(fcData.after, 'base64').toString('utf8').includes('val = 2'));

    const forwarded = buildFileChangedEventData(session.id, turn.id, {
      path: 'src/app.js',
      action: 'updated',
      unifiedDiff: '--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-export const val = 1;\n+export const val = 2;',
      additions: 1,
      deletions: 1,
      sha256After: 'c'.repeat(64),
    });
    assert.equal(forwarded.action, 'updated');
    assert.ok(forwarded.unifiedDiff.includes('+export const val = 2;'));
    assert.equal(forwarded.additions, 1);
    assert.equal(forwarded.deletions, 1);
    assert.equal(forwarded.sha256After, 'c'.repeat(64));

    // Verify optional tool in step 3 emitted gated=true and produced zero extra read_file receipt
    const receipts = store.db
      .prepare('SELECT toolName FROM tool_receipts WHERE turnId=?')
      .all(turn.id);
    assert.equal(receipts.filter((r) => r.toolName === 'read_file').length, 2);
    const toolEvents = store.db
      .prepare("SELECT data FROM direct_events WHERE turnId=? AND type='tool/result'")
      .all(turn.id)
      .map((r) => JSON.parse(r.data));
    assert.ok(
      toolEvents.some((ev) => ev.callId === 'tc_opt_read' && ev.gated === true),
      'gated optional tool should emit tool/result with gated: true',
    );
  } finally {
    await runtime.close();
  }
});
