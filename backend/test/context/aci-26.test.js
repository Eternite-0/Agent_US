import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from '../fixtures.js';
import { Store } from '../../src/store.js';
import { AccountPool } from '../../src/pool.js';
import { DirectAgentRuntime } from '../../src/direct-agent.js';
import { PreInjectionAdmissionController } from '../../src/context/aci-admission.js';
import {
  ContextEvidenceLedger,
  ReversibleContextStore,
  computeSliceSha256,
} from '../../src/context/aci-store.js';
import {
  ACIEngine,
  EVIDENCE_READ_TOOLS,
  PHASE_WATERMARK_V25_DTOC_POLICY,
  TRAJECTORY_EVICTION_V26_DTOC_POLICY,
  TRAJECTORY_EVICTION_V26_EPOCH_WATERMARKS,
  compressMessagesEpoch,
  expandContext,
  extractBoundedSymbolSpans,
  shouldTriggerAciEpoch,
} from '../../src/context/aci-engine.js';
import {
  ExecutionReasoningTracker,
  READ_TOOLS,
} from '../../src/kernel/execution-reasoning.js';
import { createMetaTools } from '../../src/tools/builtin/meta-tools.js';

function makeBigBlock(prefix, count = 160, extraSymbol = null) {
  const words = [
    'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
    'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
    'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray',
  ];
  const lines = [];
  for (let i = 1; i <= count; i += 1) {
    const w1 = words[i % words.length];
    const w2 = words[(i * 5 + 3) % words.length];
    const w3 = words[(i * 7 + 11) % words.length];
    lines.push(
      `export function ${prefix}Helper${i}_${w1}_${w2}(inputVal, bias = ${(i % 9) + 1}) { return String(inputVal ?? '${w3}') + ':${prefix}:${w1}:${w2}:${w3}' + String(bias); }`,
    );
  }
  if (extraSymbol) {
    lines.push(
      '',
      `export function ${extraSymbol}(order, taxRate = 0.1) {`,
      `  const subtotal = Number(order?.subtotal ?? 0);`,
      `  const tax = Math.round(subtotal * taxRate * 100) / 100;`,
      `  return { subtotal, tax, total: subtotal + tax };`,
      `}`,
      '',
    );
  }
  return lines.join('\n');
}

function makeToolStep(stepId, name, args, output, { isError = false } = {}) {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          id: stepId,
          name,
          arguments: args,
        },
      ],
    },
    {
      role: 'tool',
      toolCallId: stepId,
      toolName: name,
      isError,
      content: [
        {
          type: 'text',
          text: `[TOOL_RESULT name=${name} id=${stepId}]\n${output}`,
        },
      ],
    },
  ];
}

class ScriptedAdapter extends LlmAdapter {
  constructor(handlers) {
    super();
    this.handlers = handlers;
    this.calls = [];
  }
  async *stream(options) {
    const idx = this.calls.length;
    this.calls.push({
      system: options.system,
      messages: structuredClone(options.messages ?? []),
      model: options.model,
    });
    const fn = this.handlers[idx] ?? this.handlers.at(-1);
    yield* fn(options, idx);
  }
}

async function waitTurnDone(runtime, store, sessionId, turnId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastRow = null;
  while (Date.now() < deadline) {
    const row = store.db
      .prepare('SELECT * FROM direct_turns WHERE id=? AND sessionId=?')
      .get(turnId, sessionId);
    lastRow = row ?? lastRow;
    if (row && ['completed', 'failed', 'cancelled'].includes(row.state)) {
      return row;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `Timed out waiting for turn ${turnId} (state=${lastRow?.state}, phase=${lastRow?.phase}, err=${lastRow?.error}, active=${runtime ? 'yes' : 'no'})`,
  );
}

test('v2.6 DTOC policy constants, watermarks, and 2.5 ep=0 vs trajectory_eviction_v26 trigger', () => {
  assert.equal(TRAJECTORY_EVICTION_V26_DTOC_POLICY, 'trajectory_eviction_v26');
  assert.deepEqual([...TRAJECTORY_EVICTION_V26_EPOCH_WATERMARKS], [0.78, 0.9]);

  // Build ~14k single-step conversation with superseded outputs (2.5 keeps ep=0 below 28k!)
  const staleReadText = makeBigBlock('staleModuleA', 150);
  const resolvedFailText = [
    'exitCode: 1',
    'AssertionError: expected 10 to equal 20',
    ...Array.from({ length: 45 }, (_, i) => `at worker${i} (src/mod${i}.js:${i + 1}:5)`),
  ].join('\n');
  const activePostReadText = makeBigBlock('postMutA', 80);

  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Fix src/a.js calculation bug' }] },
    ...makeToolStep('tc_head_read', 'read_file', { path: 'README.md' }, 'Repo intro\n'.repeat(30)),
    ...makeToolStep('tc_stale_read', 'read_file', { path: 'src/a.js' }, staleReadText),
    ...makeToolStep(
      'tc_fail_test_1',
      'bash',
      { command: 'node --test test/a.test.js' },
      resolvedFailText,
      { isError: true },
    ),
    ...makeToolStep('tc_edit_a', 'edit_file', { path: 'src/a.js' }, 'Edited src/a.js'),
    ...makeToolStep('tc_post_read', 'read_file', { path: 'src/a.js' }, activePostReadText),
    ...makeToolStep('tc_pass_test_2', 'bash', { command: 'node --test test/a.test.js' }, 'ok 1 - passed'),
  ];

  // v2.5 fails to trigger (< 28k gate -> ep=0 explain/repro)
  const v25Probe = shouldTriggerAciEpoch(messages, {
    dtocPolicy: PHASE_WATERMARK_V25_DTOC_POLICY,
    contextWindow: 128000,
    maxTotalTokens: 128000,
    currentStep: 6,
    verificationCount: 2,
    unverifiedSrcMutations: 0,
  });
  assert.equal(v25Probe.triggered, false);
  assert.equal(v25Probe.reason, 'below_pressure_watermark');

  // v2.6 detects superseded outputs >= 700 tokens saved and triggers cleanly even below 28k!
  const v26Probe = shouldTriggerAciEpoch(messages, {
    dtocPolicy: TRAJECTORY_EVICTION_V26_DTOC_POLICY,
    contextWindow: 128000,
    maxTotalTokens: 128000,
    currentStep: 6,
    verificationCount: 2,
    unverifiedSrcMutations: 0,
  });
  assert.equal(v26Probe.triggered, true);
  assert.equal(v26Probe.supersededTriggered, true);
  assert.ok(v26Probe.supersededNetSavingsTokens >= 700);
});

test('v2.6 Superseded Output Eviction evicts stale reads & resolved/old errors, respects cooldown, and protects KV head, contracts, active reads, and latest error', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'agent-us-v26-sup-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();
    const engine = new ACIEngine({
      store,
      aciStore,
      ledger,
      dtocPolicy: TRAJECTORY_EVICTION_V26_DTOC_POLICY,
      maxTotalTokens: 200000,
      contextWindow: 200000,
    });

    const contractText = makeBigBlock('contractSpecRule', 60);
    const staleHeadRead = makeBigBlock('headBootstrap', 55);
    const preMutReadA = makeBigBlock('staleBeforeEditA', 80);
    const oldPartialReadB = makeBigBlock('partialB', 75);
    const newerFullReadB = makeBigBlock('fullB', 80);
    const activePostMutA = makeBigBlock('freshAfterEditA', 65);
    const oldFailDiag = 'exitCode: 1\nTS2304: Cannot find name x\n' + 'diag trace line\n'.repeat(55);
    const latestUnresolvedErr =
      'exitCode: 1\nAssertionError: still failing latest\n' + 'stack frame line\n'.repeat(45);

    // index 0: user; index 1..2: assistant/tool head (index < 3 KV prefix protection!)
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Implement contracts carefully' }] },
      ...makeToolStep('tc_0', 'read_file', { path: 'src/head.js' }, staleHeadRead), // tool msg at index 2 (< 3!)
      ...makeToolStep('tc_1', 'read_file', { path: 'SPEC.md' }, contractText), // contract file protected
      ...makeToolStep('tc_2', 'read_file', { path: 'src/target.js', startLine: 1, endLine: 40 }, oldPartialReadB), // superseded by full read tc_5
      ...makeToolStep('tc_3', 'read_file', { path: 'src/alpha.js' }, preMutReadA), // superseded by edit tc_6 EVEN AT RECENT STEP!
      ...makeToolStep('tc_4', 'run_diagnostics', { kind: 'test' }, oldFailDiag, { isError: true }), // superseded by tc_8
      ...makeToolStep('tc_5', 'read_file', { path: 'src/target.js' }, newerFullReadB), // aged later candidate or active
      ...makeToolStep('tc_6', 'edit_file', { path: 'src/alpha.js' }, 'Patched src/alpha.js'),
      ...makeToolStep('tc_7', 'read_file', { path: 'src/alpha.js' }, activePostMutA), // recent post-mutation read (age=1) -> PROTECTED!
      ...makeToolStep('tc_8', 'bash', { command: 'node --test test/alpha.test.js' }, latestUnresolvedErr, {
        isError: true,
      }), // latest unresolved error -> PROTECTED!
    ];

    const res1 = engine.compress(messages, {
      currentStep: 8,
      maxSteps: 16,
      cumulativeUsedTokens: 1000,
      verificationCount: 2,
      unverifiedSrcMutations: 0,
      contractFiles: ['SPEC.md'],
    });
    assert.equal(res1.triggered, true);
    assert.equal(res1.supersededTriggered, true);
    assert.equal(res1.trajectoryTriggered, false);
    assert.ok(res1.supersededEvictions >= 3, `Expected >=3 superseded evictions, got ${res1.supersededEvictions}`);
    assert.ok(res1.supersededTokensSaved >= 700);

    const compressedIds = new Set(res1.compressedRefs.map((r) => r.path));
    assert.ok(!compressedIds.has('src/head.js'), 'index < 3 head prefix must remain intact');
    assert.ok(!compressedIds.has('SPEC.md'), 'SPEC.md contract must remain protected');
    // Check verbatim preservation of head, contract, active post-mut read, and latest unresolved error in out messages
    const findToolText = (tcId) =>
      res1.messages.find((m) => m.toolCallId === tcId)?.content?.[0]?.text ?? '';
    assert.ok(findToolText('tc_0').includes('headBootstrapHelper1'), 'head prefix (<3) stays verbatim');
    assert.ok(findToolText('tc_1').includes('contractSpecRuleHelper1'), 'contract file stays verbatim');
    assert.ok(findToolText('tc_7').includes('freshAfterEditAHelper1'), 'active post-mutation read stays verbatim');
    assert.ok(
      findToolText('tc_8').includes('AssertionError: still failing latest'),
      'latestErrorIndex stays verbatim',
    );
    // Stale reads & superseded diagnostic error MUST be compressed to stubs
    assert.ok(findToolText('tc_2').startsWith('[ACI-REF '), 'partial read superseded by full read must be evicted');
    assert.ok(findToolText('tc_3').startsWith('[ACI-REF '), 'pre-mutation stale read must be evicted');
    assert.ok(findToolText('tc_4').startsWith('[ACI-REF '), 'older failing run_diagnostics must be evicted');
    // Tier 2 non-superseded read (tc_5) must stay verbatim because trajectoryTriggered=false (onlySuperseded!)
    assert.ok(findToolText('tc_5').includes('fullBHelper1'), 'non-superseded read must be preserved below trajectory threshold');

    // Cooldown check: next step (< 3 steps since lastEvictionStep=8) must NOT trigger even with new stale read
    const msgsAfterCooldownTest = [
      ...res1.messages,
      ...makeToolStep('tc_9', 'read_file', { path: 'src/extra.js' }, makeBigBlock('extraStale', 70)),
      ...makeToolStep('tc_10', 'edit_file', { path: 'src/extra.js' }, 'Edited extra.js'),
    ];
    const cooldownRes = engine.compress(msgsAfterCooldownTest, {
      currentStep: 9,
      maxSteps: 16,
      cumulativeUsedTokens: 12000,
      verificationCount: 2,
    });
    assert.equal(cooldownRes.triggered, false);
    assert.equal(cooldownRes.reason, 'eviction_cooldown');

    // Stage 4 short-task compatibility: ~5k tokens & step < 4 -> epochTransitions = 0
    const shortEngine = new ACIEngine({
      dtocPolicy: TRAJECTORY_EVICTION_V26_DTOC_POLICY,
      maxTotalTokens: 128000,
      contextWindow: 128000,
    });
    const shortRes = shortEngine.compress(
      [
        { role: 'user', content: [{ type: 'text', text: 'Short read task' }] },
        ...makeToolStep('s1', 'read_file', { path: 'src/short.js' }, makeBigBlock('shortFn', 20)),
      ],
      { currentStep: 2, maxSteps: 12, cumulativeUsedTokens: 1200 },
    );
    assert.equal(shortRes.triggered, false);
    assert.equal(shortEngine.epochState.epochCount, 0);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('v2.6 Budget Trajectory Prediction triggers at >= 0.78 * maxTotalTokens after cooldown and evicts Tier 1 superseded before Tier 2 aged reads', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'agent-us-v26-traj-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const ledger = new ContextEvidenceLedger();
    const aciStore = new ReversibleContextStore(store);
    const engine = new ACIEngine({
      store,
      aciStore,
      ledger,
      dtocPolicy: TRAJECTORY_EVICTION_V26_DTOC_POLICY,
      maxTotalTokens: 100000,
      contextWindow: 128000,
    });

    const agedA = makeBigBlock('agedModuleOne', 160);
    const agedB = makeBigBlock('agedModuleTwo', 160);
    const supOld = makeBigBlock('supersededLateInHistory', 100);
    const freshC = makeBigBlock('freshModuleThree', 40);

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Optimize large codebase' }] },
      ...makeToolStep('t0', 'read_file', { path: 'README.md' }, 'Intro\n'.repeat(20)),
      ...makeToolStep('t1', 'read_file', { path: 'src/aged1.js' }, agedA),
      ...makeToolStep('t2', 'read_file', { path: 'src/aged2.js' }, agedB),
      ...makeToolStep('t3', 'bash', { command: 'node --test test/all.test.js' }, 'pass 12/12'),
      ...makeToolStep('t4', 'read_file', { path: 'src/sup.js' }, supOld),
      ...makeToolStep('t5', 'edit_file', { path: 'src/sup.js' }, 'updated src/sup.js'),
      ...makeToolStep('t6', 'read_file', { path: 'src/fresh.js' }, freshC), // active recent (age <= 2)
    ];

    // Pre-edit exploration guard: verificationCount=0 & zero mutations below 72% budget must NOT prematurely evict Tier 2 aged reads
    const preEditEngine = new ACIEngine({
      dtocPolicy: TRAJECTORY_EVICTION_V26_DTOC_POLICY,
      maxTotalTokens: 100000,
      contextWindow: 128000,
    });
    const preEditProbe = preEditEngine.inspectEpoch(
      [
        { role: 'user', content: [{ type: 'text', text: 'Optimize large codebase' }] },
        ...makeToolStep('p0', 'read_file', { path: 'README.md' }, 'Intro\n'.repeat(20)),
        ...makeToolStep('p1', 'read_file', { path: 'src/aged1.js' }, agedA),
        ...makeToolStep('p2', 'read_file', { path: 'src/aged2.js' }, agedB),
      ],
      { currentStep: 7, estRemainingSteps: 5, cumulativeUsedTokens: 55000, verificationCount: 0, unverifiedSrcMutations: 0 },
    );
    assert.equal(preEditProbe.trajectoryTriggered, false, 'Tier 2 must wait until edits/tests or >=72% cumulative');

    // tokensBefore is ~11k–15k (>= 10k). With cumulative=45000 & estRemainingSteps=5 -> projected > 100k >= 78k!
    const res = engine.compress(messages, {
      currentStep: 6,
      estRemainingSteps: 5,
      cumulativeUsedTokens: 45000,
      verificationCount: 1,
      unverifiedSrcMutations: 0,
    });
    assert.equal(res.triggered, true);
    assert.equal(res.trajectoryTriggered, true);
    assert.ok(res.projectedTotalTokens >= 0.78 * 100000);
    assert.ok(res.compressedRefs.length >= 3);
    // Tier 1 superseded MUST be evicted BEFORE Tier 2 aged reads!
    assert.equal(res.compressedRefs[0].superseded, true, 'Tier 1 superseded must come first');
    assert.equal(res.compressedRefs[0].path, 'src/sup.js');
    assert.equal(res.compressedRefs.at(-1).superseded, false, 'Tier 2 aged comes second');
    // Active recent read t6 protected
    assert.ok(
      res.messages.find((m) => m.toolCallId === 't6').content[0].text.includes('freshModuleThreeHelper1'),
    );
    const ledgerSummary = ledger.summary();
    assert.equal(ledgerSummary.trajectoryTriggeredEpochs, 1);
    assert.equal(ledgerSummary.supersededEvictions, 1);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('v2.6 Partial Hash-Verified Recovery: expand_context supports omitted level + symbol/symbols/lines, verifies parent & slice SHA-256, and records partial metrics', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'agent-us-v26-rec-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-v26-rec-ws-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();
    const largeSource = makeBigBlock('paddingNoise', 120, 'calculateInvoiceTotal');
    const ref = aciStore.put(largeSource, {
      toolName: 'read_file',
      path: 'src/billing.js',
      lineRange: 'L1-127',
      step: 1,
      decision: 'DEFER',
    });

    // 1. Omitted level ('verbatim') + single `symbol` alias -> exact bounded symbol span with line numbers + sliceSha256!
    const tools = createMetaTools({
      workspaceRoot: workDir,
      store,
      sessionId: 'sess-v26',
      wrapResult: (_name, text) => text,
      guardFallback: async () => {},
      resolveContextRef: async (rawRef, _opts) => {
        const restored = aciStore.restoreVerified(rawRef);
        return {
          ...restored,
          recordRecovery: (recMeta) => {
            ledger.recordRecovery({
              refId: restored.refId,
              uri: restored.uri,
              sha256: restored.sha256,
              ...recMeta,
              verified: restored.verified,
              triggeredBy: 'expand_context',
            });
          },
        };
      },
    });
    const expandTool = tools.find((t) => t.name === 'expand_context');
    assert.ok(expandTool);

    const symOut = await expandTool.execute({ ref: ref.uri, symbol: 'calculateInvoiceTotal' }, {});
    const headerMatch = symOut.match(
      /^\[expand_context sha256:([a-f0-9]{12}) verified=true ([^\]]+)\] \[sliceSha256:([a-f0-9]{12}) verified=true mode=(symbol|lines|outline|hunk|full)\]\n([\s\S]*)$/,
    );
    assert.ok(headerMatch, `Unexpected header format: ${symOut.slice(0, 200)}`);
    assert.equal(headerMatch[1], ref.sha256.slice(0, 12));
    assert.equal(headerMatch[4], 'symbol');
    assert.equal(headerMatch[3], computeSliceSha256(headerMatch[5]).slice(0, 12));
    assert.ok(headerMatch[5].includes('export function calculateInvoiceTotal'));
    assert.ok(headerMatch[5].includes('L122:'), 'Must include line numbers');
    assert.ok(!headerMatch[5].includes('paddingNoiseHelper1('), 'Must NOT dump entire large file');

    // 2. startLine/endLine with omitted level -> mode=lines + partial recovery
    const linesOut = await expandTool.execute({ ref: ref.uri, startLine: 122, endLine: 126 }, {});
    assert.match(
      linesOut,
      /^\[expand_context sha256:[a-f0-9]{12} verified=true lines 122-126\/\d+\] \[sliceSha256:[a-f0-9]{12} verified=true mode=lines\]/,
    );

    // 3. Python indentation span + +-12 line lexical fallback via extractBoundedSymbolSpans & expandContext
    const pySource = [
      '# header',
      ...Array.from({ length: 20 }, (_, i) => `PADDING_${i} = ${i}`),
      'def compute_tax(amount):',
      '    rate = 0.08',
      '    # nested comment',
      '    return amount * rate',
      '',
      'SPECIAL_RUNTIME_TOKEN = "token_alpha"',
      ...Array.from({ length: 20 }, (_, i) => `TAIL_${i} = ${i}`),
    ].join('\n');
    const pySpan = extractBoundedSymbolSpans('src/tax.py', pySource, ['compute_tax']);
    assert.ok(pySpan.text.includes('def compute_tax(amount):'));
    assert.ok(pySpan.text.includes('return amount * rate'));
    assert.ok(!pySpan.text.includes('TAIL_10'));

    const fallbackSpan = extractBoundedSymbolSpans('src/tax.py', pySource, ['token_alpha'], {
      fallbackRadius: 12,
    });
    assert.ok(fallbackSpan.text.includes('SPECIAL_RUNTIME_TOKEN'));
    assert.ok(fallbackSpan.windows[0].from <= 28 && fallbackSpan.windows[0].to >= 28);

    const directExp = expandContext(aciStore, ref.uri, {
      symbol: 'calculateInvoiceTotal',
      ledger,
      recordRecovery: true,
    });
    assert.equal(directExp.mode, 'symbol');
    assert.equal(directExp.isPartial, true);
    assert.ok(directExp.recoveryTokensSaved === undefined && directExp.tokensSaved > 2000);

    // 4. Verify ledger metrics rollup & mergeFrom idempotence
    ledger.recordAdmission({
      refId: null,
      uri: 'artifact://' + '1'.repeat(64),
      sha256: '1'.repeat(64),
      path: 'src/direct.js',
      decision: 'DIRECT',
      originalTokens: 400,
      injectedTokens: 400,
      tokensSaved: 0,
    });
    ledger.recordAdmission({
      refId: ref.refId,
      uri: ref.uri,
      sha256: ref.sha256,
      path: 'src/billing.js',
      decision: 'DEFER',
      originalTokens: 3200,
      injectedTokens: 60,
      tokensSaved: 3140,
    });

    const summary = ledger.summary();
    assert.equal(summary.partialRecoveries, 3);
    assert.equal(summary.fullRecoveries, 0);
    assert.ok(summary.recoveryTokensSaved > 6000);
    assert.equal(summary.decisions.DIRECT, 1);
    assert.equal(summary.decisions.DEFER, 1);

    const mergedLedger = new ContextEvidenceLedger();
    mergedLedger.mergeFrom(ledger);
    mergedLedger.mergeFrom(ledger); // idempotent!
    assert.equal(mergedLedger.summary().partialRecoveries, 3);
    assert.equal(mergedLedger.summary().decisions.DEFER, 1);

    // 5. Parent blob SHA-256 tamper -> ARTIFACT_HASH_MISMATCH
    store.db.prepare('UPDATE blobs SET content=? WHERE sha256=?').run('corrupted blob!', ref.sha256);
    await assert.rejects(
      () => expandTool.execute({ ref: ref.uri, symbol: 'calculateInvoiceTotal' }, {}),
      (err) => err?.code === 'ARTIFACT_HASH_MISMATCH',
    );
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
    rmDirSafe(workDir);
  }
});

test('v2.6 Anti-Thrashing Self-Diagnosis Guard triggers at sameFileFailedEditStreak >= 2 even across unrelated reads and names contracts + cross-file callers', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-v26-thrash-'));
  try {
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, 'SPEC.md'), '# Billing Spec\ncalculatePrice must preserve currency rounding.\n');
    writeFileSync(join(workDir, 'CONTRACT.json'), JSON.stringify({ exports: ['calculatePrice'] }));
    writeFileSync(
      join(workDir, 'src', 'pricing.js'),
      'export function calculatePrice(qty, unit) { return qty * unit; }\n',
    );
    writeFileSync(
      join(workDir, 'src', 'checkout.js'),
      'import { calculatePrice } from "./pricing.js";\nexport function checkoutTotal(q, u) { return calculatePrice(q, u); }\n',
    );
    writeFileSync(join(workDir, 'src', 'notes.js'), 'export const notes = "unrelated";\n');

    const tracker = new ExecutionReasoningTracker({ workspaceRoot: workDir });
    tracker.setTaskContract({ contractFiles: ['SPEC.md', 'CONTRACT.json'] });

    // Cycle 1: edit src/pricing.js -> fail verification
    tracker.recordToolResult({
      tc: { id: 'e1', name: 'edit_file' },
      args: { path: 'src/pricing.js' },
      output: 'Edited src/pricing.js',
      isError: false,
      step: 1,
    });
    const v1 = tracker.recordToolResult({
      tc: { id: 't1', name: 'bash' },
      args: { command: 'node --test test/pricing.test.js' },
      output: 'exitCode: 1\nAssertionError: checkoutTotal mismatch',
      isError: true,
      step: 2,
    });
    assert.equal(v1.antiThrashing, null);
    assert.equal(tracker.getState().antiThrashingTriggered, false);

    // Unrelated read between cycles resets _editTestFailCycles, NOT per-file streak!
    tracker.recordToolResult({
      tc: { id: 'r_unrel', name: 'read_file' },
      args: { path: 'src/notes.js' },
      output: 'export const notes = "unrelated";',
      isError: false,
      step: 3,
    });

    // Cycle 2: edit src/pricing.js again -> fail verification again -> streak == 2!
    tracker.recordToolResult({
      tc: { id: 'e2', name: 'edit_file' },
      args: { path: 'src/pricing.js' },
      output: 'Edited src/pricing.js',
      isError: false,
      step: 4,
    });
    const v2 = tracker.recordToolResult({
      tc: { id: 't2', name: 'bash' },
      args: { command: 'node --test test/pricing.test.js' },
      output: 'exitCode: 1\nAssertionError: checkoutTotal mismatch again',
      isError: true,
      step: 5,
    });

    assert.ok(v2.antiThrashing, 'Expected antiThrashing trigger at sameFileFailedEditStreak=2');
    assert.equal(v2.antiThrashing.file, 'src/pricing.js');
    assert.equal(v2.antiThrashing.streak, 2);
    assert.ok(v2.antiThrashing.contracts.includes('SPEC.md'));
    assert.ok(v2.antiThrashing.contracts.includes('CONTRACT.json'));
    assert.ok(v2.antiThrashing.callers.some((c) => c.includes('src/checkout.js')));
    assert.match(v2.antiThrashing.guidance, /src\/pricing\.js/);
    assert.match(v2.antiThrashing.guidance, /SPEC\.md/);
    assert.match(v2.antiThrashing.guidance, /src\/checkout\.js/);
    assert.match(v2.antiThrashing.guidance, /query_symbol_graph/);

    const metricsFail = tracker.getMetrics();
    assert.equal(metricsFail.antiThrashingTriggered, true);
    assert.equal(metricsFail.sameFileFailedEditStreaks['src/pricing.js'], 2);
    assert.equal(metricsFail.aciMetrics.antiThrashingTriggered, true);

    // Passing verification resets active streak counters while keeping historical trigger bit
    tracker.recordToolResult({
      tc: { id: 't3', name: 'bash' },
      args: { command: 'node --test test/pricing.test.js' },
      output: 'ok 1 - all tests passed',
      isError: false,
      step: 6,
    });
    const metricsPass = tracker.getMetrics({ finalOutcomePassed: true });
    assert.equal(metricsPass.antiThrashingTriggered, true);
    assert.deepEqual(metricsPass.sameFileFailedEditStreaks, {});
  } finally {
    rmDirSafe(workDir);
  }
});

test('v2.6 Pre-wiring query_symbol_graph + DirectAgentRuntime aci_26/full_aci telemetry, static prompt invariance, and profile compatibility', async () => {
  assert.ok(READ_TOOLS.has('query_symbol_graph'));
  assert.ok(EVIDENCE_READ_TOOLS.has('query_symbol_graph'));

  // Admission ALWAYS_DIRECT bypass for query_symbol_graph even on large output
  const admission = new PreInjectionAdmissionController();
  const largeGraphOut = 'Caller edge\n'.repeat(250);
  const admitRes = await admission.admitBatch(
    [
      {
        tc: { id: 'q1', name: 'query_symbol_graph' },
        parsedArgs: { symbol: 'calculatePrice' },
        output: largeGraphOut,
        isError: false,
      },
    ],
    { step: 1 },
  );
  assert.equal(admitRes.decisions[0].decision, 'DIRECT');
  assert.equal(admitRes.admittedItems[0].admission.decision, 'DIRECT');

  // End-to-end DirectAgentRuntime with aciProfile='aci_26' + mock provider adapter
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-v26-e2e-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-v26-e2e-ws-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-v26');

  writeFileSync(join(workDir, 'SPEC.md'), '# Spec\ncomputeFee(n) returns n * 2\n');
  writeFileSync(
    join(workDir, 'billing_rates.js'),
    `// Related utility reference: computeFee\n${makeBigBlock('billingRate', 16, 'noiseTargetFn')}`,
  );
  writeFileSync(
    join(workDir, 'pricing.js'),
    'export function computeFee(n) { return n; }\n',
  );
  writeFileSync(
    join(workDir, 'caller.js'),
    'import { computeFee } from "./pricing.js";\nexport const runFee = (n) => computeFee(n);\n',
  );
  writeFileSync(join(workDir, 'unrelated.js'), 'export const tag = "v26";\n');
  writeFileSync(
    join(workDir, 'pricing.test.js'),
    'import test from "node:test"; import assert from "node:assert/strict"; import { runFee } from "./caller.js"; test("fee", () => assert.equal(runFee(3), 6));\n',
  );

  let stepIdx = 0;
  let capturedRefUri = null;
  const adapter = new ScriptedAdapter([
    // Step 1: read large related file (DEFER/SUPPORTING -> artifact://) + pricing.js (DIRECT)
    async function* () {
      stepIdx += 1;
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'c1',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'billing_rates.js' }),
        },
      };
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'c1b',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'pricing.js' }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 40 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Step 2: test partial symbol expand_context on DEFER stub; then edit pricing.js cleanly
    async function* (opts) {
      stepIdx += 1;
      const toolTexts = opts.messages
        .filter((m) => m.role === 'tool')
        .map((m) => m.content?.[0]?.text ?? '')
        .join('\n');
      const uriMatch = toolTexts.match(/artifact:\/\/[a-f0-9]{64}/);
      capturedRefUri = uriMatch?.[0] ?? null;
      if (capturedRefUri) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'c_exp',
            name: 'expand_context',
            arguments: JSON.stringify({ ref: capturedRefUri, symbol: 'noiseTargetFn' }),
          },
        };
      }
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'c_edit1',
          name: 'write_file',
          arguments: JSON.stringify({
            path: 'pricing.js',
            content: 'export function computeFee(n) { return n + 1; }\n',
          }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 50 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Step 3: failing test #1
    async function* () {
      stepIdx += 1;
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'c_test1',
          name: 'run_diagnostics',
          arguments: JSON.stringify({ kind: 'test' }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 950, outputTokens: 30 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Step 4: read unrelated.js (to verify streak still catches same-file thrashing!) + edit pricing.js wrongly again
    async function* () {
      stepIdx += 1;
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'c_unrel',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'unrelated.js' }),
        },
      };
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'c_edit2',
          name: 'write_file',
          arguments: JSON.stringify({
            path: 'pricing.js',
            content: 'export function computeFee(n) { return n * 3; }\n',
          }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 45 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Step 5: failing test #2 -> triggers antiThrashingTriggered!
    async function* () {
      stepIdx += 1;
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'c_test2',
          name: 'run_diagnostics',
          arguments: JSON.stringify({ kind: 'test' }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 1050, outputTokens: 30 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Step 6: inspect anti-thrashing tail guidance, call query_symbol_graph, fix pricing.js, and pass test!
    async function* (opts) {
      stepIdx += 1;
      const tailUserText = opts.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content?.[0]?.text ?? '')
        .join('\n');
      assert.match(tailUserText, /Anti-Thrashing Self-Diagnosis/);
      assert.match(tailUserText, /pricing\.js/);
      assert.match(tailUserText, /caller\.js/);
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'c_qsg',
          name: 'query_symbol_graph',
          arguments: JSON.stringify({ symbol: 'computeFee' }),
        },
      };
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'c_edit3',
          name: 'write_file',
          arguments: JSON.stringify({
            path: 'pricing.js',
            content: 'export function computeFee(n) { return n * 2; }\n',
          }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 1100, outputTokens: 50 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Step 7: passing verification
    async function* () {
      stepIdx += 1;
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'c_test3',
          name: 'run_diagnostics',
          arguments: JSON.stringify({ kind: 'test' }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 1150, outputTokens: 25 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Step 8: final summary
    async function* () {
      yield { type: 'text-delta', index: 0, text: 'Fixed computeFee in pricing.js and verified pricing.test.js passes.' };
      yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 25 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  ]);

  const runtime = new DirectAgentRuntime(store, pool, {
    adapter,
    defaultWorkspace: workDir,
    dataRoot: dataDir,
  });

  const ephemeralTelemetry = [];
  let offEph = null;

  try {
    const sess = runtime.createSession({
      model: 'mock-v26',
      workspaceRoot: workDir,
      permissionMode: 'full-access',
    });
    offEph = runtime.subscribe(sess.id, (ev) => {
      if (ev?.type === 'aci/telemetry') ephemeralTelemetry.push(ev.data);
    });
    const { turn } = runtime.startTurn(sess.id, {
      input: 'Fix computeFee in pricing.js per SPEC.md so pricing.test.js passes.',
      aciProfile: 'aci_26',
      aciOptions: { admissionMinChars: 800, maxSteps: 16 },
    });

    const term = await waitTurnDone(runtime, store, sess.id, turn.id, 10000);
    assert.equal(term.state, 'completed', `Turn failed: ${term.error}`);
    assert.ok(stepIdx >= 7);

    // Static System Prompt Invariance across ALL provider calls!
    assert.ok(adapter.calls.length >= 6);
    const baseSystem = adapter.calls[0].system;
    for (let i = 1; i < adapter.calls.length; i += 1) {
      assert.equal(adapter.calls[i].system, baseSystem, `System prompt drifted on call ${i}!`);
    }

    const completedEv = store.db
      .prepare("SELECT * FROM direct_events WHERE turnId=? AND type='turn/completed' ORDER BY seq DESC LIMIT 1")
      .get(turn.id);
    assert.ok(completedEv);
    const data = JSON.parse(completedEv.data);
    assert.ok(data.budgetWatermarks, 'top-level budgetWatermarks preserved');
    assert.ok(data.aciTelemetry, 'aciTelemetry emitted on turn/completed');
    assert.equal(data.aciTelemetry.aciProfile, 'aci_26');
    assert.equal(data.aciTelemetry.dtocPolicy, 'trajectory_eviction_v26');
    assert.equal(data.aciTelemetry.antiThrashingTriggered, true);
    assert.ok(data.aciTelemetry.decisions);
    assert.equal(data.reasoningMetrics.antiThrashingTriggered, true);
    assert.ok(capturedRefUri, 'Expected billing_rates.js to spill to artifact:// uri');
    assert.ok(data.aciTelemetry.partialRecoveries >= 1);

    const thrashWarnEv = store.db
      .prepare("SELECT * FROM direct_events WHERE turnId=? AND type='loop/thrashing_warning' ORDER BY seq ASC LIMIT 1")
      .get(turn.id);
    assert.ok(thrashWarnEv);
    const warnData = JSON.parse(thrashWarnEv.data);
    assert.equal(warnData.antiThrashingTriggered, true);
    assert.ok(warnData.aciTelemetry, 'loop/thrashing_warning carries aciTelemetry');
    assert.ok(ephemeralTelemetry.length >= 1, 'Expected ephemeral aci/telemetry events during turn');

    // Verify full_aci also defaults to trajectory_eviction_v26 on DirectAgentRuntime
    const fullTurn = runtime.startTurn(sess.id, {
      input: 'Confirm tests still pass.',
      aciProfile: 'full_aci',
    });
    // Next handler falls through to final summary
    const term2 = await waitTurnDone(runtime, store, sess.id, fullTurn.turn.id, 6000);
    assert.equal(term2.state, 'completed');
    const comp2 = JSON.parse(
      store.db
        .prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/completed' ORDER BY seq DESC LIMIT 1")
        .get(fullTurn.turn.id).data,
    );
    assert.equal(comp2.aciTelemetry.aciProfile, 'full_aci');
    assert.equal(comp2.aciTelemetry.dtocPolicy, 'trajectory_eviction_v26');
  } finally {
    offEph?.();
    await runtime.close();
    store.close?.();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('v2.6 AgentLoop does not shield taskContract requiredFiles (src/) from superseded eviction while keeping SPEC.md protected', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-v26-reqfiles-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-v26-reqfiles-ws-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-v26');

  mkdirSync(join(workDir, 'src'), { recursive: true });
  mkdirSync(join(workDir, 'test'), { recursive: true });
  const distinctTerms = [
    'tenantIsolationBoundary', 'immutableLedgerSequence', 'auditSignatureCheck', 'quotaGraceWindow',
    'tokenBudgetGuard', 'workspaceCanonicalRoot', 'symlinkEscapeBlocker', 'atomicTempSwapWrite',
    'monotonicEpochCounter', 'supersededReadPruner', 'hashVerifiedSliceExpand', 'contractReadinessGate',
    'antiThrashingDiagnosis', 'symbolCallerGraphIndex', 'threeWayPatchMerger', 'reviewerHardGate',
    'deterministicVerdictRun', 'sandboxNetworkFirewall', 'sessionTurnLeaseFence', 'providerUsageTracker',
    'promptCacheStaticPrefix', 'runtimeContextTailMsg', 'preInjectionAdmission', 'postTestCompletionGrace',
  ];
  const makeDiverseJs = (tag) =>
    distinctTerms
      .map(
        (term, idx) =>
          `export function ${tag}_${term}(ctx, payload) {\n  const note = '${tag}:${term}:' + String(ctx?.mode ?? '${idx}');\n  return { ok: Boolean(payload), note, key: '${term}' };\n}`,
      )
      .join('\n');
  writeFileSync(join(workDir, 'SPEC.md'), `# Contract\n\ncontractConstraintHelper1: enforce strict tenant policy.\n${distinctTerms.map((t) => `- Rule ${t}: preserve deterministic verification before closing turn.`).join('\n')}\n`);
  writeFileSync(join(workDir, 'src', 'helper.js'), `export const helper = true;\n`);
  writeFileSync(join(workDir, 'src', 'policy.js'), `export function checkPolicy(x) { return x > 0; }\n${makeDiverseJs('legacyPolicy')}\n`);
  writeFileSync(
    join(workDir, 'test', 'policy.test.js'),
    'import test from "node:test"; import assert from "node:assert/strict"; import { checkPolicy } from "../src/policy.js"; test("policy", () => assert.equal(checkPolicy(2), true));\n',
  );

  let step5Messages = null;
  const adapter = new ScriptedAdapter([
    // Step 1: read SPEC.md and src/helper.js so later tool msg sits at index >= 3
    async function* () {
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'tc_spec', name: 'read_file', arguments: JSON.stringify({ path: 'SPEC.md' }) },
      };
      yield {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: 'tc_helper', name: 'read_file', arguments: JSON.stringify({ path: 'src/helper.js' }) },
      };
      yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 30 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Step 2: read target implementation file src/policy.js (also in taskContract.requiredFiles!)
    async function* () {
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'tc_policy_read', name: 'read_file', arguments: JSON.stringify({ path: 'src/policy.js' }) },
      };
      yield { type: 'usage', usage: { inputTokens: 1500, outputTokens: 30 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Step 3: mutate src/policy.js -> supersedes tc_policy_read
    async function* () {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc_policy_write',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'src/policy.js', content: 'export function checkPolicy(x) { return Number.isFinite(x) && x > 0; }\n' }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 1600, outputTokens: 30 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Step 4: verify via node --test -> step advances to 4 (DEFAULT_V26_MIN_SUPERSEDED_STEP)
    async function* () {
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'tc_test_pass', name: 'bash', arguments: JSON.stringify({ command: 'node --test test/policy.test.js' }) },
      };
      yield { type: 'usage', usage: { inputTokens: 1700, outputTokens: 30 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Step 5: before model call 5, AgentLoop DTOC should have evicted tc_policy_read while keeping SPEC.md
    async function* (opts) {
      step5Messages = opts.messages;
      yield { type: 'text-delta', index: 0, text: 'Updated src/policy.js per SPEC.md and verified test/policy.test.js.' };
      yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 25 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  ]);

  const runtime = new DirectAgentRuntime(store, pool, {
    adapter,
    defaultWorkspace: workDir,
    dataRoot: dataDir,
  });

  try {
    const sess = runtime.createSession({
      model: 'mock-v26',
      workspaceRoot: workDir,
      permissionMode: 'full-access',
    });
    const { turn } = runtime.startTurn(sess.id, {
      input: 'Update src/policy.js per SPEC.md so test/policy.test.js passes.',
      aciProfile: 'full_aci',
      aciOptions: { admissionMinChars: 5000, maxSteps: 12 },
    });
    const term = await waitTurnDone(runtime, store, sess.id, turn.id, 10000);
    assert.equal(term.state, 'completed');

    const compEv = store.db
      .prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/completed' ORDER BY seq DESC LIMIT 1")
      .get(turn.id);
    assert.ok(compEv);
    const data = JSON.parse(compEv.data);
    assert.ok(
      data.aciTelemetry.supersededEvictions >= 1,
      `Expected src/policy.js stale read to evict (>=1), got ${data.aciTelemetry.supersededEvictions}`,
    );
    assert.ok(data.aciTelemetry.epochTransitions >= 1);

    const findText = (tcId) =>
      step5Messages?.find((m) => m.role === 'tool' && m.toolCallId === tcId)?.content?.[0]?.text ?? '';
    assert.ok(findText('tc_policy_read').startsWith('[ACI-REF '), 'stale src/policy.js read must be evicted');
    assert.ok(findText('tc_spec').includes('contractConstraintHelper1'), 'SPEC.md contract must stay verbatim');
  } finally {
    await runtime.close();
    store.close?.();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});
