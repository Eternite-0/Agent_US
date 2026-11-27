import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmDirSafe } from '../fixtures.js';
import { Store } from '../../src/store.js';
import { measureRequestComposition, pairClosed } from '../../src/context.js';
import {
  ContextEvidenceLedger,
  ReversibleContextStore,
} from '../../src/context/aci-store.js';
import {
  ADMISSION_DECISIONS,
  DEFAULT_PROBE_ADMISSION_MIN_CHARS,
  DEFAULT_WORKING_SET_READ_MAX_CHARS,
  PreInjectionAdmissionController,
  classifyCriticalDomains,
  isDecoyCue,
} from '../../src/context/aci-admission.js';
import {
  ACIEngine,
  CACHE_AWARE_V31_DTOC_POLICY,
  CACHE_AWARE_V31_EPOCH_WATERMARKS,
  DEFAULT_ADAPTIVE_EPOCH_HORIZON,
  DEFAULT_V31_EVICTION_COOLDOWN_STEPS,
  DEFAULT_V31_MIN_NET_SAVINGS_TOKENS,
  DEFAULT_V31_MIN_PROMPT_TOKENS,
  PHASE_WATERMARK_V25_DTOC_POLICY,
  TRAJECTORY_EVICTION_V26_DTOC_POLICY,
  VALID_DTOC_POLICIES,
  compressMessagesEpoch,
  extractEpochAdjudicationCandidates,
  normalizeDtocPolicy,
  resolveWatermarksForPolicy,
  shouldTriggerAciEpoch,
  solveOptimalEpochSplit,
} from '../../src/context/aci-engine.js';

function makeToolStep(stepId, name, args, output, { isError = false, step = undefined } = {}) {
  return [
    {
      role: 'assistant',
      ...(step !== undefined ? { step } : {}),
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
      ...(step !== undefined ? { step } : {}),
      toolCallId: stepId,
      toolName: name,
      isError,
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    },
  ];
}

function makeCodeModule(prefix, lineCount = 300, focusSymbol = null) {
  const words = [
    'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
    'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  ];
  const lines = ["import { validateOrder } from './orders.js';"];
  for (let i = 1; i <= lineCount; i += 1) {
    const w1 = words[i % words.length];
    const w2 = words[(i * 3 + 5) % words.length];
    lines.push(
      `export function ${prefix}_${i}_${w1}(item, rate = ${(i % 7) + 1}) { return validateOrder(item) ? '${w2}:${i}:' + String(rate) : null; }`,
    );
  }
  if (focusSymbol) {
    lines.push(
      `export function ${focusSymbol}(order) {`,
      `  if (!order || !order.id) throw new Error('ORDER_REQUIRED');`,
      `  return validateOrder(order);`,
      `}`,
    );
  }
  return lines.join('\n');
}

function makeCompactModule(prefix, lineCount = 295, focusSymbol = null) {
  const lines = ["import { v } from './v.js';"];
  for (let i = 1; i <= lineCount; i += 1) {
    lines.push(`export const ${prefix}_${i} = v(${i});`);
  }
  if (focusSymbol) {
    lines.push(
      `export function ${focusSymbol}(o) {`,
      `  if (!o?.id) throw new Error('ORDER_REQUIRED');`,
      `  return v(o.id);`,
      `}`,
    );
  }
  return lines.join('\n');
}

function wrapUntrustedTool(seq, body) {
  return `<untrusted id="cafebabe000011112222333344445555-tool-read_file-${seq}" bytes="${Buffer.byteLength(body, 'utf8')}">${body}</untrusted id="cafebabe000011112222333344445555-tool-read_file-${seq}">`;
}

test('v3.1/4.1 constants, policy helpers, and ACIEngine adaptive defaults abolish 48k hard wall while preserving backward compat', () => {
  assert.equal(CACHE_AWARE_V31_DTOC_POLICY, 'cache_aware_v31');
  assert.deepEqual([...CACHE_AWARE_V31_EPOCH_WATERMARKS], [0.78, 0.9]);
  assert.equal(DEFAULT_V31_MIN_PROMPT_TOKENS, 48000);
  assert.equal(DEFAULT_V31_MIN_NET_SAVINGS_TOKENS, 3500);
  assert.equal(DEFAULT_V31_EVICTION_COOLDOWN_STEPS, 6);
  assert.equal(DEFAULT_ADAPTIVE_EPOCH_HORIZON, 4);
  assert.ok(VALID_DTOC_POLICIES.includes(CACHE_AWARE_V31_DTOC_POLICY));
  assert.equal(normalizeDtocPolicy(CACHE_AWARE_V31_DTOC_POLICY), CACHE_AWARE_V31_DTOC_POLICY);
  assert.deepEqual(resolveWatermarksForPolicy(CACHE_AWARE_V31_DTOC_POLICY), [0.78, 0.9]);
  assert.equal(DEFAULT_WORKING_SET_READ_MAX_CHARS, 42000);
  assert.equal(DEFAULT_PROBE_ADMISSION_MIN_CHARS, 2400);

  // Adaptive cache_aware_v31 defaults abolish hardcoded 48k / 3500 walls unless explicitly configured
  const v31Engine = new ACIEngine({ dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY });
  assert.equal(v31Engine._explicitDtocMinPromptTokens, undefined);
  assert.equal(v31Engine.dtocMinPromptTokens, 0);
  assert.equal(v31Engine.minNetSavingsTokens, 0);
  assert.equal(v31Engine.evictionCooldownSteps, 6);
  assert.equal(v31Engine.workingSetReadMaxChars, 42000);
  assert.deepEqual(v31Engine.watermarks, [0.78, 0.9]);

  // Explicit numeric dtocMinPromptTokens is honored when supplied, while default 24000 stays isolated to legacy policies
  const v31Explicit = new ACIEngine({
    dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
    dtocMinPromptTokens: 24000,
  });
  assert.equal(v31Explicit._explicitDtocMinPromptTokens, 24000);
  assert.equal(v31Explicit.dtocMinPromptTokens, 24000);

  const v26Engine = new ACIEngine({ dtocPolicy: TRAJECTORY_EVICTION_V26_DTOC_POLICY });
  assert.equal(v26Engine.dtocMinPromptTokens, 24000);
  assert.equal(v26Engine.minNetSavingsTokens, 750);

  const v25Engine = new ACIEngine({ dtocPolicy: PHASE_WATERMARK_V25_DTOC_POLICY });
  assert.equal(v25Engine.dtocMinPromptTokens, 24000);
  assert.equal(v25Engine.minNetSavingsTokens, 1200);
});

test('v4.1 adaptive cache-aware DTOC: short low-savings tasks abstain without a 48k wall, sub-48k stale churn triggers adaptively, explicit floor & emergency rescue work', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'aci31-floor-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();
    const engine = new ACIEngine({
      store,
      aciStore,
      ledger,
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
      maxTotalTokens: 160000,
      contextWindow: 128000,
    });

    // 1) Short low-savings task naturally abstains (H_t * S(k) <= max(P_t * 0.6, I(k) * rho)) with ZERO 48k hard wall
    const shortMsgs = [
      { role: 'system', content: [{ type: 'text', text: 'Static system prompt\n'.repeat(180) }] },
      { role: 'user', content: [{ type: 'text', text: 'Fix order pricing and pass all tests' }] },
      ...makeToolStep('s1', 'read_file', { path: 'README.md' }, 'Intro\n'.repeat(40), { step: 1 }),
      ...makeToolStep('s2', 'read_file', { path: 'src/small.js' }, 'export const x = 1;\n'.repeat(30), { step: 2 }),
      ...makeToolStep('s3', 'edit_file', { path: 'src/small.js' }, 'Edited src/small.js', { step: 3 }),
      ...makeToolStep('s4', 'read_file', { path: 'src/live.js' }, makeCodeModule('liveActive', 120), { step: 6 }),
    ];
    const shortSnapshot = JSON.stringify(shortMsgs);
    const shortProbe = engine.inspectEpoch(shortMsgs, {
      currentStep: 7,
      observedCacheHitRate: 0.9,
      estHorizon: 4,
    });
    assert.equal(shortProbe.triggered, false);
    assert.equal(shortProbe.optimalSplitIndex, -1);
    assert.equal(shortProbe.observedCacheHitRate, 0.9);
    assert.equal(shortProbe.estHorizon, 4);

    const shortComp = engine.compress(shortMsgs, {
      currentStep: 7,
      observedCacheHitRate: 0.9,
      estHorizon: 4,
    });
    assert.equal(shortComp.triggered, false);
    assert.equal(shortComp.compressedCount, 0);
    assert.equal(shortComp.messages, shortMsgs);
    assert.equal(JSON.stringify(shortComp.messages), shortSnapshot);
    assert.equal(engine.epochState.epochCount, 0);

    // 2) Sub-48k trajectory with heavy superseded churn triggers adaptively without any 48k hard wall!
    const bigOldRead1 = makeCodeModule('staleChunkA', 180);
    const bigOldRead2 = makeCodeModule('staleChunkB', 180);
    const oldFailDiag =
      'exitCode: 1\nAssertionError: failed v1\n' +
      Array.from({ length: 120 }, (_, i) => `at traceFrame${i} (src/a.js:${i + 1}:3)`).join('\n');

    const messages = [
      { role: 'system', content: [{ type: 'text', text: 'Static system prompt' }] },
      { role: 'user', content: [{ type: 'text', text: 'Fix order pricing and pass all tests' }] },
      ...makeToolStep('t1', 'read_file', { path: 'README.md' }, 'Intro\n'.repeat(40), { step: 1 }),
      ...makeToolStep('t2', 'read_file', { path: 'src/a.js' }, bigOldRead1, { step: 2 }),
      ...makeToolStep('t3', 'run_diagnostics', { kind: 'test' }, oldFailDiag, { isError: true, step: 3 }),
      ...makeToolStep('t4', 'edit_file', { path: 'src/a.js' }, 'Edited src/a.js', { step: 4 }),
      ...makeToolStep('t5', 'read_file', { path: 'src/b.js' }, bigOldRead2, { step: 5 }),
      ...makeToolStep('t6', 'edit_file', { path: 'src/b.js' }, 'Edited src/b.js', { step: 6 }),
      ...makeToolStep('t7', 'read_file', { path: 'src/b.js' }, 'export const b = 2;\n'.repeat(20), { step: 7 }),
      ...makeToolStep('t8', 'run_diagnostics', { kind: 'test' }, '{"ok":true,"diagnostics":[]}', { step: 8 }),
    ];

    const tokensBefore = measureRequestComposition({ messages }).totalTokens;
    assert.ok(tokensBefore > 10000 && tokensBefore < 48000, `Expected 10k..48k tokens, got ${tokensBefore}`);

    const adaptiveProbe = engine.inspectEpoch(messages, {
      currentStep: 10,
      observedCacheHitRate: 0.5,
      estHorizon: 4,
    });
    assert.equal(adaptiveProbe.triggered, true, 'Sub-48k heavy stale trajectory must trigger adaptively');
    assert.equal(adaptiveProbe.reason, CACHE_AWARE_V31_DTOC_POLICY);
    assert.ok(adaptiveProbe.optimalSplitIndex >= 0);
    assert.equal(adaptiveProbe.hasAgedCandidates, false, 'Purely superseded epoch reports hasAgedCandidates=false');
    assert.ok(adaptiveProbe.netCacheAdjustedGain > 0);

    // 3) Explicit caller-configured dtocMinPromptTokens=48000 still enforces opt-in floor & emergency rescue
    const explicitFloorEngine = new ACIEngine({
      store,
      aciStore: new ReversibleContextStore(store),
      ledger: new ContextEvidenceLedger(),
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
      dtocMinPromptTokens: 48000,
      maxTotalTokens: 160000,
      contextWindow: 128000,
    });
    const floorProbe = explicitFloorEngine.inspectEpoch(messages, { currentStep: 10, cumulativeUsedTokens: 40000 });
    assert.equal(floorProbe.triggered, false);
    assert.equal(floorProbe.reason, 'append_only_cache_floor_v31');
    assert.equal(floorProbe.dtocMinPromptTokens, 48000);

    // Emergency budget exhaustion (< 2.5 * tokensBefore remaining) can still rescue below explicit floor once
    const emComp = explicitFloorEngine.compress(messages, { currentStep: 10, cumulativeUsedTokens: 140000 });
    assert.equal(emComp.triggered, true);
    assert.equal(emComp.reason, 'emergency_budget');
    assert.ok(emComp.compressedCount >= 2);
    assert.equal(explicitFloorEngine.epochState.emergencyUsed, true);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('v4.1 cache-rate self-calibrated DP k*: shifts split point under hot cache, preserves [0..k*-1] byte-identically, supports keepRefs re-solve, 6-step cooldown, and shields active/contract/error/head', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'aci31-epoch-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();
    const engine = new ACIEngine({
      store,
      aciStore,
      ledger,
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
      maxTotalTokens: 200000,
      contextWindow: 128000,
    });

    // 1) Insufficient cumulative net savings (H_t * S(k) <= P_t * 0.6) even when >= 48k tokens -> abstains cleanly
    const hugeShieldedSpec = `# SPEC\n${'Contract requirement line keeping prompt >= 48k.\n'.repeat(4300)}`;
    const smallSuperseded = 'export const smallOld = 1;\n'.repeat(80); // ~540 tok
    const lowSavingsMsgs = [
      { role: 'user', content: [{ type: 'text', text: 'Update SPEC-compliant module' }] },
      ...makeToolStep('ls_head', 'read_file', { path: 'README.md' }, 'Repo readme\n'.repeat(15), { step: 1 }),
      ...makeToolStep('ls_spec', 'read_file', { path: 'SPEC.md' }, hugeShieldedSpec, { step: 2 }),
      ...makeToolStep('ls_old', 'read_file', { path: 'src/small.js' }, smallSuperseded, { step: 3 }),
      ...makeToolStep('ls_edit', 'edit_file', { path: 'src/small.js' }, 'Edited src/small.js', { step: 4 }),
      ...makeToolStep('ls_tail', 'read_file', { path: 'src/tail.js' }, 'export const tail = true;\n'.repeat(20), { step: 8 }),
    ];
    const lowTokens = measureRequestComposition({ messages: lowSavingsMsgs }).totalTokens;
    assert.ok(lowTokens >= 48000, `Expected >= 48k tokens, got ${lowTokens}`);

    const lowRes = engine.compress(lowSavingsMsgs, { currentStep: 8, contractFiles: ['SPEC.md'] });
    assert.equal(lowRes.triggered, false);
    assert.equal(lowRes.reason, 'insufficient_net_savings');
    assert.equal(lowRes.compressedCount, 0);
    assert.ok(lowRes.suffixTokens > 0, 'retained suffixTokens must be reported');
    assert.equal(lowRes.invalidatedSuffixTokens, lowRes.suffixTokens);

    // 2) Same trajectory with early small-gain candidate + huge shielded middle + late high-gain tail candidate:
    //    rho=0 picks early split; rho=0.95 shifts k* right to protect hot KV-cache prefix [0..k*-1]!
    const dpSplitMsgs = [
      { role: 'user', content: [{ type: 'text', text: 'Refactor tail module while preserving SPEC' }] },
      ...makeToolStep('dp_head', 'read_file', { path: 'README.md' }, 'Repo readme\n'.repeat(20), { step: 1 }),
      ...makeToolStep('dp_early_small', 'read_file', { path: 'src/early_small.js' }, makeCodeModule('earlySmall', 35), { step: 2 }),
      ...makeToolStep('dp_spec_mid', 'read_file', { path: 'SPEC.md' }, `# SPEC\n${'Active contract invariant line.\n'.repeat(2400)}`, { step: 3 }),
      ...makeToolStep('dp_late_big', 'read_file', { path: 'src/late_big.js' }, makeCodeModule('lateBig', 280), { step: 4 }),
      ...makeToolStep('dp_recent', 'read_file', { path: 'src/recent.js' }, makeCodeModule('recentLive', 40), { step: 9 }),
    ];
    const earlyIdx = dpSplitMsgs.findIndex((m) => m.toolCallId === 'dp_early_small');
    const lateIdx = dpSplitMsgs.findIndex((m) => m.toolCallId === 'dp_late_big');

    const coldProbe = engine.inspectEpoch(dpSplitMsgs, {
      currentStep: 10,
      contractFiles: ['SPEC.md'],
      observedCacheHitRate: 0,
      estHorizon: 6,
    });
    const hotProbe = engine.inspectEpoch(dpSplitMsgs, {
      currentStep: 10,
      contractFiles: ['SPEC.md'],
      observedCacheHitRate: 0.95,
      estHorizon: 6,
    });
    assert.equal(coldProbe.triggered, true);
    assert.equal(hotProbe.triggered, true);
    assert.equal(coldProbe.optimalSplitIndex, earlyIdx, 'Cold cache (rho=0) compresses from early candidate');
    assert.equal(hotProbe.optimalSplitIndex, lateIdx, 'Hot cache (rho=0.95) skips early small-gain candidate to avoid busting huge middle');
    assert.ok(hotProbe.suffixTokens < coldProbe.suffixTokens);
    assert.equal(hotProbe.hasAgedCandidates, true);
    assert.equal(hotProbe.agedCandidates.length, 1);
    assert.equal(hotProbe.agedCandidates[0].ref, 'dp_late_big');

    // Verify byte-identical prefix [0 .. k*-1] under hot-cache split
    const hotEngine = new ACIEngine({
      store,
      aciStore: new ReversibleContextStore(store),
      ledger: new ContextEvidenceLedger(),
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
    });
    const hotComp = hotEngine.compress(dpSplitMsgs, {
      currentStep: 10,
      contractFiles: ['SPEC.md'],
      observedCacheHitRate: 0.95,
      estHorizon: 6,
    });
    assert.equal(hotComp.triggered, true);
    assert.equal(hotComp.optimalSplitIndex, lateIdx);
    assert.equal(hotComp.compressedCount, 1);
    for (let i = 0; i < lateIdx; i += 1) {
      assert.equal(
        JSON.stringify(hotComp.messages[i]),
        JSON.stringify(dpSplitMsgs[i]),
        `Prefix message ${i} (< k*=${lateIdx}) must remain 100% byte-identical`,
      );
    }

    // Verify keepRefs excludes protected candidate and re-solves DP cleanly (cancelling when none remain)
    const keptEngine = new ACIEngine({
      store,
      aciStore: new ReversibleContextStore(store),
      ledger: new ContextEvidenceLedger(),
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
    });
    const keptCancel = keptEngine.compress(dpSplitMsgs, {
      currentStep: 10,
      contractFiles: ['SPEC.md'],
      observedCacheHitRate: 0.95,
      estHorizon: 6,
      keepRefs: new Set(['dp_late_big']),
    });
    assert.equal(keptCancel.triggered, false, 'Protecting the only profitable tail candidate cancels eviction');
    assert.equal(keptCancel.compressedCount, 0);

    // Direct pure solver unit check
    const pureDp = solveOptimalEpochSplit({
      messageTokens: [1000, 1000, 1000, 1000, 1000, 20000, 8000, 2000],
      candidates: [
        { messageIndex: 3, rawTokens: 1000, stubTokens: 60 },
        { messageIndex: 6, rawTokens: 8000, stubTokens: 60 },
      ],
      observedCacheHitRate: 0.95,
      estHorizon: 6,
      currentPromptTokens: 35000,
    });
    assert.equal(pureDp.triggered, true);
    assert.equal(pureDp.optimalSplitIndex, 6);
    assert.equal(pureDp.candidateSavings, 7940);
    assert.equal(pureDp.suffixTokens, 2060);

    // 3) Full batch epoch with Tier-1 superseded + Tier-2 aged candidates, 6-step cooldown, and active/contract/error/head shields
    const headCode = makeCodeModule('headBoot', 60);
    const specCode = `# Contract\n${'Strict spec invariant rule.\n'.repeat(160)}`;
    const tier1PreMut = makeCodeModule('tier1StaleA', 420);
    const tier1OldErr =
      'exitCode: 1\nAssertionError: old failure\n' +
      Array.from({ length: 220 }, (_, i) => `at oldWorker${i} (src/old.js:${i + 1}:4)`).join('\n');
    const tier2Aged1 = makeCodeModule('tier2AgedModuleOne', 420);
    const tier2Aged2 = makeCodeModule('tier2AgedModuleTwo', 420);
    const recentPostMut = makeCodeModule('recentActive', 110);
    const latestErr =
      'exitCode: 1\nAssertionError: latest unresolved failure\n' +
      Array.from({ length: 40 }, (_, i) => `at curWorker${i} (src/cur.js:${i + 1}:4)`).join('\n');

    const batchMsgs = [
      { role: 'user', content: [{ type: 'text', text: 'Refactor modules and fix tests' }] },
      ...makeToolStep('v_head', 'read_file', { path: 'src/boot.js' }, headCode, { step: 1 }), // index 2 (<3 head prefix)
      ...makeToolStep('v_spec', 'read_file', { path: 'SPEC.md' }, specCode, { step: 2 }), // strict contract
      ...makeToolStep('v_t1_read', 'read_file', { path: 'src/stale.js' }, tier1PreMut, { step: 3 }), // Tier 1 superseded by edit
      ...makeToolStep('v_t1_err', 'bash', { command: 'node --test test/old.test.js' }, tier1OldErr, { isError: true, step: 4 }), // Tier 1 superseded by v_latest_err
      ...makeToolStep('v_t2_a', 'read_file', { path: 'src/aged1.js' }, tier2Aged1, { step: 5 }), // Tier 2 aged
      ...makeToolStep('v_t2_b', 'read_file', { path: 'src/aged2.js' }, tier2Aged2, { step: 6 }), // Tier 2 aged
      ...makeToolStep('v_edit', 'edit_file', { path: 'src/stale.js' }, 'Edited src/stale.js', { step: 8 }), // recent edit (10 - 8 = 2 <= 4)
      ...makeToolStep('v_recent_read', 'read_file', { path: 'src/stale.js' }, recentPostMut, { step: 9 }), // recent active read
      ...makeToolStep('v_latest_err', 'bash', { command: 'node --test' }, latestErr, { isError: true, step: 10 }), // latest unresolved error
    ];

    const adjCands = extractEpochAdjudicationCandidates(batchMsgs, {
      currentStep: 10,
      contractFiles: ['SPEC.md'],
    });
    assert.equal(adjCands.length, 4);
    assert.equal(adjCands.filter((c) => c.reason === 'aged').length, 2);

    const firstCandidateIdx = batchMsgs.findIndex((m) => m.toolCallId === 'v_t1_read');
    const comp1 = engine.compress(batchMsgs, { currentStep: 10, contractFiles: ['SPEC.md'] });
    assert.equal(comp1.triggered, true);
    assert.equal(comp1.reason, CACHE_AWARE_V31_DTOC_POLICY);
    assert.equal(comp1.epoch, 1);
    assert.equal(comp1.optimalSplitIndex, firstCandidateIdx);
    assert.equal(comp1.firstCandidateIndex, firstCandidateIdx);
    const expectedRetainedSuffix = measureRequestComposition({
      messages: comp1.messages.slice(firstCandidateIdx),
    }).totalTokens;
    assert.equal(comp1.suffixTokens, expectedRetainedSuffix);
    assert.equal(comp1.invalidatedSuffixTokens, expectedRetainedSuffix);
    assert.ok(comp1.netCacheAdjustedGain > 0);
    assert.equal(comp1.compressedCount, 4, 'Must batch-compress all Tier-1 (2) + Tier-2 (2) candidates in one epoch');
    assert.equal(comp1.supersededEvictions, 2);
    assert.equal(comp1.pairClosedValid, true);
    assert.equal(pairClosed(comp1.messages), true);

    const findText = (id) => comp1.messages.find((m) => m.toolCallId === id)?.content?.[0]?.text ?? '';
    assert.ok(findText('v_t1_read').startsWith('[ACI-REF '));
    assert.ok(findText('v_t1_err').startsWith('[ACI-REF '));
    assert.ok(findText('v_t2_a').startsWith('[ACI-REF '));
    assert.ok(findText('v_t2_b').startsWith('[ACI-REF '));
    // Shielded items stay 100% verbatim
    assert.ok(findText('v_head').includes('headBoot_1_'));
    assert.ok(findText('v_spec').includes('Strict spec invariant rule'));
    assert.ok(findText('v_recent_read').includes('recentActive_1_'));
    assert.ok(findText('v_latest_err').includes('latest unresolved failure'));

    // 4) 6-step cooldown blocks eviction at step 15 (15 - 10 = 5 < 6)
    const extraAged = makeCodeModule('extraWave', 900);
    const step15Msgs = [
      ...comp1.messages,
      ...makeToolStep('v_extra_read', 'read_file', { path: 'src/extra.js' }, extraAged, { step: 11 }),
      ...makeToolStep('v_extra_edit', 'edit_file', { path: 'src/extra.js' }, 'Edited src/extra.js', { step: 12 }),
      ...makeToolStep('v_extra_tail', 'read_file', { path: 'src/final.js' }, makeCodeModule('finalLive', 700), { step: 15 }),
    ];
    const cooldownBlocked = engine.compress(step15Msgs, { currentStep: 15, contractFiles: ['SPEC.md'] });
    assert.equal(cooldownBlocked.triggered, false);
    assert.equal(cooldownBlocked.reason, 'eviction_cooldown');
    assert.equal(cooldownBlocked.compressedCount, 0);

    // 5) At step 16 (16 - 10 = 6 >= 6), cooldown passes and Epoch 2 fires!
    const step16Probe = engine.inspectEpoch(step15Msgs, { currentStep: 16, contractFiles: ['SPEC.md'] });
    assert.equal(step16Probe.cooldownPassed, true);
    assert.equal(step16Probe.stepsSinceLastEviction, 6);
    const epoch2 = engine.compress(step15Msgs, { currentStep: 16, contractFiles: ['SPEC.md'] });
    assert.equal(epoch2.triggered, true);
    assert.equal(epoch2.epoch, 2);
    assert.ok(epoch2.compressedRefs.some((r) => r.path === 'src/extra.js'));

    // Explicit evictionCooldownSteps override is respected
    const customCooldownProbe = shouldTriggerAciEpoch(step15Msgs, {
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
      dtocMinPromptTokens: 1000,
      minNetSavingsTokens: 1000,
      evictionCooldownSteps: 2,
      epochState: { lastWatermark: -1, epochCount: 1, lastEvictionStep: 10 },
      currentStep: 12,
    });
    assert.equal(customCooldownProbe.cooldownPassed, true);
    assert.equal(customCooldownProbe.triggered, true);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('v3.1 WP4 (c & d): working-set verbatim read_file (<=42k), DUPLICATE repeat, >2400 probe slicing, and unified `${ln}: ` line numbers', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'aci31-ws-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();
    const engine = new ACIEngine({
      store,
      aciStore,
      ledger,
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
    });

    const mod300Body = makeCompactModule('orderCalc', 295, 'computeOrderDiscount');
    const mod300Output = `File: src/orders/calc.js (lines 1-300 of 300)\n${mod300Body
      .split('\n')
      .map((line, i) => `${i + 1}: ${line}`)
      .join('\n')}`;
    assert.ok(mod300Output.length > 8000 && mod300Output.length <= 42000, `Expected ~9k+ <=42k chars, got ${mod300Output.length}`);

    const hugeReadBody = makeCodeModule('giantRegistry', 520, 'lookupRegistryRule');
    assert.ok(hugeReadBody.length > 42000, `Expected >42k chars, got ${hugeReadBody.length}`);

    const smallGrepOut = Array.from({ length: 40 }, (_, i) => `src/orders/calc.js:${i + 1}: validateOrder(item)`).join('\n');
    assert.ok(smallGrepOut.length > 1400 && smallGrepOut.length <= 2400, `Expected 1400..2400 chars, got ${smallGrepOut.length}`);

    const largeGrepOut = [
      'import { validateOrder } from "./orders.js";',
      ...Array.from({ length: 65 }, (_, i) => `src/orders/match_${i}.js:${i + 10}: export function computeOrderRule${i}() { return computeOrderDiscount(); }`),
    ].join('\n');
    assert.ok(largeGrepOut.length > 2400, `Expected >2400 chars, got ${largeGrepOut.length}`);

    const largeBashNoise = Array.from(
      { length: 75 },
      (_, i) => `build-cache info step=${i} status=cached checksum=000${i}`,
    ).join('\n');
    assert.ok(largeBashNoise.length > 2400);

    // Step 1: 300-line read_file -> DIRECT (explicit_read_working_set), <=2400 grep -> DIRECT, >2400 grep -> SUPPORTING/DEFER, >2400 bash noise -> IRRELEVANT, >16k read_file -> sliced
    const res1 = await engine.admitToolBatch(
      [
        {
          tc: { id: 'r_ws', name: 'read_file', arguments: JSON.stringify({ path: 'src/orders/calc.js' }) },
          parsedArgs: { path: 'src/orders/calc.js' },
          output: wrapUntrustedTool(1, mod300Output),
          isError: false,
        },
        {
          tc: { id: 'g_small', name: 'grep', arguments: JSON.stringify({ pattern: 'validateOrder' }) },
          parsedArgs: { pattern: 'validateOrder' },
          output: wrapUntrustedTool(2, smallGrepOut),
          isError: false,
        },
        {
          tc: { id: 'g_large', name: 'grep', arguments: JSON.stringify({ pattern: 'computeOrderDiscount' }) },
          parsedArgs: { pattern: 'computeOrderDiscount' },
          output: wrapUntrustedTool(3, largeGrepOut),
          isError: false,
        },
        {
          tc: { id: 'b_large', name: 'bash', arguments: JSON.stringify({ command: 'npm run status' }) },
          parsedArgs: { command: 'npm run status' },
          output: wrapUntrustedTool(4, largeBashNoise),
          isError: false,
        },
        {
          tc: { id: 'r_huge', name: 'read_file', arguments: JSON.stringify({ path: 'src/orders/giant_registry.js' }) },
          parsedArgs: { path: 'src/orders/giant_registry.js' },
          output: wrapUntrustedTool(5, hugeReadBody),
          isError: false,
        },
      ],
      { query: 'Fix computeOrderDiscount and lookupRegistryRule in src/orders/calc.js', step: 1 },
    );

    const byId1 = Object.fromEntries(res1.admittedItems.map((it) => [it.tc.id, it]));
    assert.equal(byId1.r_ws.admission.decision, ADMISSION_DECISIONS.DIRECT);
    assert.equal(byId1.r_ws.admission.reason, 'explicit_read_working_set');
    assert.ok(byId1.r_ws.admittedOutput.includes('computeOrderDiscount'));

    assert.equal(byId1.g_small.admission.decision, ADMISSION_DECISIONS.DIRECT);
    assert.equal(byId1.g_small.admission.reason, 'small_payload_fast_path');

    assert.ok(
      [ADMISSION_DECISIONS.SUPPORTING, ADMISSION_DECISIONS.DEFER].includes(byId1.g_large.admission.decision),
      `Expected >2400 grep to go through slicing admission, got ${byId1.g_large.admission.decision}`,
    );
    // Non-decoy bash output is never dropped as IRRELEVANT (protected DIRECT or reversibly folded SUPPORTING/DEFER)
    assert.notEqual(byId1.b_large.admission.decision, ADMISSION_DECISIONS.IRRELEVANT);
    assert.ok(
      [ADMISSION_DECISIONS.DIRECT, ADMISSION_DECISIONS.SUPPORTING, ADMISSION_DECISIONS.DEFER].includes(
        byId1.b_large.admission.decision,
      ),
      `Expected non-decoy bash output to be DIRECT/SUPPORTING/DEFER, got ${byId1.b_large.admission.decision}`,
    );

    // >42k read_file goes through 5-tier admission (SUPPORTING or DEFER) with unified `${ln}: ` line numbers
    assert.ok(
      [ADMISSION_DECISIONS.SUPPORTING, ADMISSION_DECISIONS.DEFER].includes(byId1.r_huge.admission.decision),
      `Expected >42k read_file to be sliced, got ${byId1.r_huge.admission.decision}`,
    );
    assert.match(byId1.r_huge.admittedOutput, /^\[ACI-REF artifact:\/\/[0-9a-f]{64} \| (?:SUPPORTING|DEFER) \|[^\n]*@L\d+/m);
    assert.match(byId1.r_huge.admittedOutput, /^\d+: /m, 'Sliced output must use `${ln}: ` line prefixes');
    assert.doesNotMatch(byId1.r_huge.admittedOutput, /^L\d+: /m, 'Sliced output must NOT use `L${ln}: ` line prefixes');

    // Also verify explicit DEFER (Imports/Symbols + Preview) & SUPPORTING line formats via PreInjectionAdmissionController
    const lineFormatCtrl = new PreInjectionAdmissionController({
      aciStore: new ReversibleContextStore(store),
      workingSetReadMaxChars: 0,
    });
    const deferCode = [
      "import { formatAmt } from './fmt.js';",
      '// telemetry overview note',
      ...Array.from({ length: 70 }, (_, i) => `export function deferHelper${i}(x) { return formatAmt(x) + ${i}; }`),
    ].join('\n');
    const plainNotes = Array.from({ length: 70 }, (_, i) => `plainNoteEntry_${i} telemetry documentation paragraph line ${i}`).join('\n');
    const deferRes = await lineFormatCtrl.admitBatch(
      [
        {
          tc: { id: 'd_only', name: 'read_file', arguments: JSON.stringify({ path: 'src/defer_mod.js' }) },
          parsedArgs: { path: 'src/defer_mod.js' },
          output: wrapUntrustedTool(6, deferCode),
          isError: false,
        },
        {
          tc: { id: 'd_preview', name: 'read_file', arguments: JSON.stringify({ path: 'docs/notes.txt' }) },
          parsedArgs: { path: 'docs/notes.txt' },
          output: wrapUntrustedTool(7, plainNotes),
          isError: false,
        },
        {
          tc: { id: 's_only', name: 'read_file', arguments: JSON.stringify({ path: 'src/auth/support_mod.js' }) },
          parsedArgs: { path: 'src/auth/support_mod.js' },
          output: wrapUntrustedTool(8, makeCodeModule('verifyTokenHelper', 80, 'verifyToken')),
          isError: false,
        },
      ],
      { query: 'Check verifyToken telemetry', step: 1 },
    );
    const deferItem = deferRes.admittedItems.find((i) => i.tc.id === 'd_only');
    const previewItem = deferRes.admittedItems.find((i) => i.tc.id === 'd_preview');
    const supportItem = deferRes.admittedItems.find((i) => i.tc.id === 's_only');
    assert.equal(deferItem.admission.decision, ADMISSION_DECISIONS.DEFER);
    assert.match(deferItem.admittedOutput, /Imports:\n1: import /);
    assert.match(deferItem.admittedOutput, /Symbols:\n\d+: \[function\] /);
    assert.doesNotMatch(deferItem.admittedOutput, /^L\d+: /m);
    assert.equal(previewItem.admission.decision, ADMISSION_DECISIONS.DEFER);
    assert.match(previewItem.admittedOutput, /Preview:\n1: plainNoteEntry_0/);
    assert.doesNotMatch(previewItem.admittedOutput, /^L\d+: /m);
    assert.equal(supportItem.admission.decision, ADMISSION_DECISIONS.SUPPORTING);
    assert.match(supportItem.admittedOutput, /Outline:\n\d+: \[function\] /);
    assert.match(supportItem.admittedOutput, /Focused Hunks:\n@@ L\d+-\d+ @@\n\d+: /);
    assert.doesNotMatch(supportItem.admittedOutput, /^L\d+: /m);

    // Step 2: Unchanged repeat read_file of src/orders/calc.js (different wrapper id!) -> DUPLICATE at tail!
    const res2 = await engine.admitToolBatch(
      [
        {
          tc: { id: 'r_ws_dup', name: 'read_file', arguments: JSON.stringify({ path: 'src/orders/calc.js' }) },
          parsedArgs: { path: 'src/orders/calc.js' },
          output: wrapUntrustedTool(99, mod300Output),
          isError: false,
        },
      ],
      { query: 'Fix computeOrderDiscount', step: 2 },
    );
    assert.equal(res2.admittedItems[0].admission.decision, ADMISSION_DECISIONS.DUPLICATE);
    assert.match(res2.admittedItems[0].admittedOutput, /prior step=1/);

    // Step 3: Edit invalidates activeHashesByPath -> subsequent read_file becomes DIRECT again
    const res3 = await engine.admitToolBatch(
      [
        {
          tc: { id: 'e_ws', name: 'edit_file', arguments: JSON.stringify({ path: 'src/orders/calc.js' }) },
          parsedArgs: { path: 'src/orders/calc.js' },
          output: '已成功编辑 src/orders/calc.js',
          isError: false,
        },
        {
          tc: { id: 'r_ws_after_edit', name: 'read_file', arguments: JSON.stringify({ path: 'src/orders/calc.js' }) },
          parsedArgs: { path: 'src/orders/calc.js' },
          output: wrapUntrustedTool(100, mod300Output.replace('ORDER_REQUIRED', 'ORDER_ID_MISSING')),
          isError: false,
        },
      ],
      { query: 'Fix computeOrderDiscount', step: 3 },
    );
    assert.equal(res3.admittedItems[1].admission.decision, ADMISSION_DECISIONS.DIRECT);
    assert.equal(res3.admittedItems[1].admission.reason, 'explicit_read_working_set');
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('v3.1 WP5.1 (e): surgical decoy precision preserves @pytest.fixture, tests/fixtures, and DeprecationWarning while rejecting legacy/ and DO NOT EDIT - ARCHIVED DECOY', async () => {
  // Valid active/test/deprecation content MUST NOT be marked as decoy
  assert.equal(
    isDecoyCue('tests/fixtures/auth_fixtures.py', '@pytest.fixture\ndef auth_client():\n    return TestClient()\n'),
    false,
  );
  assert.equal(
    isDecoyCue('src/compat/warnings.py', 'import warnings\n# @deprecated\nwarnings.warn("legacy api", DeprecationWarning)\n'),
    false,
  );
  assert.equal(isDecoyCue('docs/CHANGELOG.md', '# Changelog\n## 3.1.0\n'), false);
  assert.equal(isDecoyCue('src/generated_schema.ts', '// generated sample schema\nexport interface User {}'), false);
  assert.equal(
    isDecoyCue('src/app.py', 'def ok():\n    # DO NOT EDIT - ARCHIVED DECOY mentioned in comment on line 2\n    return 1\n'),
    false,
  );

  // Explicit archive/decoy path segments, [_-]decoy. filenames, and first-non-empty-line banner ARE decoys
  assert.equal(isDecoyCue('src/legacy/auth.py', 'def verify(): pass'), true);
  assert.equal(isDecoyCue('src/archive/old_billing.js', 'export const old = 1;'), true);
  assert.equal(isDecoyCue('src/v0/routes.ts', 'export const v0 = true;'), true);
  assert.equal(isDecoyCue('src/v1_compat/shim.py', 'x = 1'), true);
  assert.equal(isDecoyCue('src/backup/store.js', 'export const b = 1;'), true);
  assert.equal(isDecoyCue('src/old-version/calc.py', 'x = 1'), true);
  assert.equal(isDecoyCue('src/mock_data/users.json', '{}'), true);
  assert.equal(isDecoyCue('src/storybook/Card.tsx', 'export const Card = () => null;'), true);
  assert.equal(isDecoyCue('src/billing_decoy.py', 'def calc(): return 0'), true);
  assert.equal(isDecoyCue('src/billing-decoy.js', 'export const calc = () => 0;'), true);
  assert.equal(
    isDecoyCue('src/active_looking.py', '\n\n# DO NOT EDIT - ARCHIVED DECOY\ndef verify_token():\n    return False\n'),
    true,
  );
  assert.equal(
    isDecoyCue('src/active_looking.js', '// DO NOT EDIT — ARCHIVED DECOY\nexport function verifyToken() { return false; }'),
    true,
  );

  // classifyCriticalDomains never marks promptTarget or errorTarget files as isDecoy
  const promptTargetedLegacy = classifyCriticalDomains({
    path: 'src/legacy/auth.py',
    content: 'def verifyToken(): return True',
    promptFiles: ['src/legacy/auth.py'],
  });
  assert.equal(promptTargetedLegacy.isDecoy, false);
  assert.equal(promptTargetedLegacy.suppressedAsDecoy, false);
  assert.equal(promptTargetedLegacy.matchedPrompt, true);

  const errorTargetedArchive = classifyCriticalDomains({
    path: 'src/archive/runner.py',
    content: '# DO NOT EDIT - ARCHIVED DECOY\ndef run(): pass',
    errorFiles: ['src/archive/runner.py'],
  });
  assert.equal(errorTargetedArchive.isDecoy, false);
  assert.equal(errorTargetedArchive.suppressedAsDecoy, false);
  assert.equal(errorTargetedArchive.matchedError, true);

  // End-to-end admitBatch: pytest fixture reads DIRECT while archived decoy banner is suppressed (never explicit_read_working_set)
  const ctrl = new PreInjectionAdmissionController();
  const fixtureBody =
    'import pytest\n\n@pytest.fixture\ndef session_token():\n    return "tok"\n\n' +
    Array.from({ length: 60 }, (_, i) => `def fixture_helper_${i}():\n    return ${i}\n`).join('\n');
  const bannerDecoyBody =
    '# DO NOT EDIT - ARCHIVED DECOY\n' +
    Array.from({ length: 65 }, (_, i) => `def stale_decoy_fn_${i}():\n    return ${i}\n`).join('\n');

  const admitRes = await ctrl.admitBatch(
    [
      {
        tc: { id: 'f1', name: 'read_file', arguments: JSON.stringify({ path: 'tests/fixtures/conftest.py' }) },
        parsedArgs: { path: 'tests/fixtures/conftest.py' },
        output: fixtureBody,
        isError: false,
      },
      {
        tc: { id: 'd1', name: 'read_file', arguments: JSON.stringify({ path: 'src/pricing_shim.py' }) },
        parsedArgs: { path: 'src/pricing_shim.py' },
        output: bannerDecoyBody,
        isError: false,
      },
    ],
    { query: 'Fix pytest fixture test failure', step: 1 },
  );

  const byId = Object.fromEntries(admitRes.admittedItems.map((it) => [it.tc.id, it]));
  assert.equal(byId.f1.admission.isDecoy, false);
  assert.equal(byId.f1.admission.decision, ADMISSION_DECISIONS.DIRECT);
  assert.equal(byId.f1.admission.reason, 'explicit_read_working_set');

  assert.equal(byId.d1.admission.isDecoy, true);
  assert.equal(byId.d1.admission.decision, ADMISSION_DECISIONS.IRRELEVANT);
});

test('v4.1 ACIEngine.admitToolBatch forwards live trajectory telemetry and default contextWindow to admissionController', async () => {
  const engine = new ACIEngine({
    dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
    contextWindow: 64000,
  });
  let capturedOpts = null;
  engine.admissionController.admitBatch = async (batch, opts) => {
    capturedOpts = opts;
    return { admittedItems: [], decisions: [], supervisorRes: null, stats: { originalTokens: 0, injectedTokens: 0, tokensSaved: 0 } };
  };

  await engine.admitToolBatch([], {
    query: 'test forwarding',
    step: 5,
    currentPromptTokens: 18500,
    hasUnverifiedEdits: true,
    hasUnresolvedErrors: true,
    estHorizon: 7,
  });

  assert.equal(capturedOpts.currentPromptTokens, 18500);
  assert.equal(capturedOpts.currentStep, 5);
  assert.equal(capturedOpts.step, 5);
  assert.equal(capturedOpts.contextWindow, 64000, 'Must default contextWindow to engine.contextWindow');
  assert.equal(capturedOpts.hasUnverifiedEdits, true);
  assert.equal(capturedOpts.hasUnresolvedErrors, true);
  assert.equal(capturedOpts.estHorizon, 7);

  // Explicit contextWindow & currentStep override defaults
  await engine.admitToolBatch([], {
    currentStep: 9,
    contextWindow: 200000,
    currentPromptTokens: 42000,
    hasUnverifiedEdits: false,
    hasUnresolvedErrors: false,
  });
  assert.equal(capturedOpts.currentStep, 9);
  assert.equal(capturedOpts.contextWindow, 200000);
  assert.equal(capturedOpts.currentPromptTokens, 42000);
  assert.equal(capturedOpts.hasUnverifiedEdits, false);
  assert.equal(capturedOpts.hasUnresolvedErrors, false);
});
