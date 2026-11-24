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
  DEFAULT_V31_EVICTION_COOLDOWN_STEPS,
  DEFAULT_V31_MIN_NET_SAVINGS_TOKENS,
  DEFAULT_V31_MIN_PROMPT_TOKENS,
  PHASE_WATERMARK_V25_DTOC_POLICY,
  TRAJECTORY_EVICTION_V26_DTOC_POLICY,
  VALID_DTOC_POLICIES,
  compressMessagesEpoch,
  normalizeDtocPolicy,
  resolveWatermarksForPolicy,
  shouldTriggerAciEpoch,
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

test('v3.1 WP3 constants, policy helpers, and ACIEngine defaults preserve backward compat and 32k floor', () => {
  assert.equal(CACHE_AWARE_V31_DTOC_POLICY, 'cache_aware_v31');
  assert.deepEqual([...CACHE_AWARE_V31_EPOCH_WATERMARKS], [0.78, 0.9]);
  assert.equal(DEFAULT_V31_MIN_PROMPT_TOKENS, 32000);
  assert.equal(DEFAULT_V31_MIN_NET_SAVINGS_TOKENS, 3500);
  assert.equal(DEFAULT_V31_EVICTION_COOLDOWN_STEPS, 6);
  assert.ok(VALID_DTOC_POLICIES.includes(CACHE_AWARE_V31_DTOC_POLICY));
  assert.equal(normalizeDtocPolicy(CACHE_AWARE_V31_DTOC_POLICY), CACHE_AWARE_V31_DTOC_POLICY);
  assert.deepEqual(resolveWatermarksForPolicy(CACHE_AWARE_V31_DTOC_POLICY), [0.78, 0.9]);
  assert.equal(DEFAULT_WORKING_SET_READ_MAX_CHARS, 16000);
  assert.equal(DEFAULT_PROBE_ADMISSION_MIN_CHARS, 2400);

  const v31Engine = new ACIEngine({ dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY });
  assert.equal(v31Engine._explicitDtocMinPromptTokens, undefined);
  assert.equal(v31Engine.dtocMinPromptTokens, 32000);
  assert.equal(v31Engine.minNetSavingsTokens, 3500);
  assert.equal(v31Engine.evictionCooldownSteps, 6);
  assert.equal(v31Engine.workingSetReadMaxChars, 16000);
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

test('v3.1 WP3 (a): <32k append-only cache floor performs 0 mutations across repeated edit/test churn', () => {
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

    // ~18k-22k tokens (< 32,000 floor) with plenty of superseded reads + old failures
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
    assert.ok(tokensBefore > 12000 && tokensBefore < 32000, `Expected 12k..32k tokens, got ${tokensBefore}`);

    const snapshotBefore = JSON.stringify(messages);
    const probe = engine.inspectEpoch(messages, { currentStep: 10, cumulativeUsedTokens: 40000 });
    assert.equal(probe.triggered, false);
    assert.equal(probe.reason, 'append_only_cache_floor_v31');
    assert.equal(probe.dtocMinPromptTokens, 32000);
    assert.equal(probe.invalidatedSuffixTokens, 0);

    const comp = engine.compress(messages, { currentStep: 10, cumulativeUsedTokens: 40000 });
    assert.equal(comp.triggered, false);
    assert.equal(comp.reason, 'append_only_cache_floor_v31');
    assert.equal(comp.compressedCount, 0);
    assert.equal(comp.invalidatedSuffixTokens, 0);
    assert.equal(comp.messages, messages);
    assert.equal(JSON.stringify(comp.messages), snapshotBefore);
    assert.equal(engine.epochState.epochCount, 0);

    // Emergency budget exhaustion (< 2.5 * tokensBefore remaining) can still rescue below 32k once
    const emComp = engine.compress(messages, { currentStep: 10, cumulativeUsedTokens: 140000 });
    assert.equal(emComp.triggered, true);
    assert.equal(emComp.reason, 'emergency_budget');
    assert.ok(emComp.compressedCount >= 2);
    assert.equal(engine.epochState.emergencyUsed, true);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('v3.1 WP3 (b): >=32k amortized batch epoch requires >=3500 net savings, 6-step cooldown, shields active/contract/error/head, and reports invalidatedSuffixTokens', () => {
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

    // 1) Insufficient net savings (< 3500) even when >= 32k tokens -> abstains cleanly
    const hugeShieldedSpec = `# SPEC\n${'Contract requirement line keeping prompt >= 32k.\n'.repeat(2700)}`;
    const smallSuperseded = 'export const smallOld = 1;\n'.repeat(80); // ~2160 chars (~540 tok < 3500)
    const lowSavingsMsgs = [
      { role: 'user', content: [{ type: 'text', text: 'Update SPEC-compliant module' }] },
      ...makeToolStep('ls_head', 'read_file', { path: 'README.md' }, 'Repo readme\n'.repeat(15), { step: 1 }),
      ...makeToolStep('ls_spec', 'read_file', { path: 'SPEC.md' }, hugeShieldedSpec, { step: 2 }),
      ...makeToolStep('ls_old', 'read_file', { path: 'src/small.js' }, smallSuperseded, { step: 3 }),
      ...makeToolStep('ls_edit', 'edit_file', { path: 'src/small.js' }, 'Edited src/small.js', { step: 4 }),
      ...makeToolStep('ls_tail', 'read_file', { path: 'src/tail.js' }, 'export const tail = true;\n'.repeat(20), { step: 8 }),
    ];
    const lowTokens = measureRequestComposition({ messages: lowSavingsMsgs }).totalTokens;
    assert.ok(lowTokens >= 32000, `Expected >= 32k tokens, got ${lowTokens}`);

    const lowRes = engine.compress(lowSavingsMsgs, { currentStep: 8, contractFiles: ['SPEC.md'] });
    assert.equal(lowRes.triggered, false);
    assert.equal(lowRes.reason, 'insufficient_net_savings');
    assert.equal(lowRes.compressedCount, 0);
    assert.ok(lowRes.invalidatedSuffixTokens > 0, 'invalidatedSuffixTokens must be reported');

    // 2) >= 32k with Tier-1 superseded + Tier-2 aged candidates totaling >= 3500 net savings
    const headCode = makeCodeModule('headBoot', 60);
    const specCode = `# Contract\n${'Strict spec invariant rule.\n'.repeat(160)}`;
    const tier1PreMut = makeCodeModule('tier1StaleA', 270);
    const tier1OldErr =
      'exitCode: 1\nAssertionError: old failure\n' +
      Array.from({ length: 140 }, (_, i) => `at oldWorker${i} (src/old.js:${i + 1}:4)`).join('\n');
    const tier2Aged1 = makeCodeModule('tier2AgedModuleOne', 270);
    const tier2Aged2 = makeCodeModule('tier2AgedModuleTwo', 270);
    const recentPostMut = makeCodeModule('recentActive', 110);
    const latestErr =
      'exitCode: 1\nAssertionError: latest unresolved failure\n' +
      Array.from({ length: 40 }, (_, i) => `at curWorker${i} (src/cur.js:${i + 1}:4)`).join('\n');

    const batchMsgs = [
      { role: 'user', content: [{ type: 'text', text: 'Refactor modules and fix tests' }] },
      ...makeToolStep('v_head', 'read_file', { path: 'src/boot.js' }, headCode, { step: 1 }), // index 2 (<3 head prefix)
      ...makeToolStep('v_spec', 'read_file', { path: 'SPEC.md' }, specCode, { step: 2 }), // strict contract
      ...makeToolStep('v_t1_read', 'read_file', { path: 'src/stale.js' }, tier1PreMut, { step: 3 }), // Tier 1 superseded by edit
      ...makeToolStep('v_t1_err', 'run_diagnostics', { kind: 'test' }, tier1OldErr, { isError: true, step: 4 }), // Tier 1 superseded by v_latest_err
      ...makeToolStep('v_t2_a', 'read_file', { path: 'src/aged1.js' }, tier2Aged1, { step: 5 }), // Tier 2 aged
      ...makeToolStep('v_t2_b', 'read_file', { path: 'src/aged2.js' }, tier2Aged2, { step: 6 }), // Tier 2 aged
      ...makeToolStep('v_edit', 'edit_file', { path: 'src/stale.js' }, 'Edited src/stale.js', { step: 8 }), // recent edit (10 - 8 = 2 <= 4)
      ...makeToolStep('v_recent_read', 'read_file', { path: 'src/stale.js' }, recentPostMut, { step: 9 }), // recent active read
      ...makeToolStep('v_latest_err', 'bash', { command: 'node --test' }, latestErr, { isError: true, step: 10 }), // latest unresolved error
    ];

    const batchTokens = measureRequestComposition({ messages: batchMsgs }).totalTokens;
    assert.ok(batchTokens >= 32000, `Expected >= 32k tokens, got ${batchTokens}`);

    const firstCandidateIdx = batchMsgs.findIndex((m) => m.toolCallId === 'v_t1_read');
    const expectedInvalidatedSuffix = measureRequestComposition({
      messages: batchMsgs.slice(firstCandidateIdx + 1),
    }).totalTokens;

    const comp1 = engine.compress(batchMsgs, { currentStep: 10, contractFiles: ['SPEC.md'] });
    assert.equal(comp1.triggered, true);
    assert.equal(comp1.reason, CACHE_AWARE_V31_DTOC_POLICY);
    assert.equal(comp1.epoch, 1);
    assert.equal(comp1.firstCandidateIndex, firstCandidateIdx);
    assert.equal(comp1.invalidatedSuffixTokens, expectedInvalidatedSuffix);
    assert.ok(comp1.netSavingsTokens >= 3500, `Expected >= 3500 savings, got ${comp1.netSavingsTokens}`);
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

    // 3) 6-step cooldown blocks eviction at step 15 (15 - 10 = 5 < 6), even with >= 32k tokens & new stale reads
    const extraAged = makeCodeModule('extraWave', 550);
    const step15Msgs = [
      ...comp1.messages,
      ...makeToolStep('v_extra_read', 'read_file', { path: 'src/extra.js' }, extraAged, { step: 11 }),
      ...makeToolStep('v_extra_edit', 'edit_file', { path: 'src/extra.js' }, 'Edited src/extra.js', { step: 12 }),
      ...makeToolStep('v_extra_tail', 'read_file', { path: 'src/final.js' }, makeCodeModule('finalLive', 450), { step: 15 }),
    ];
    assert.ok(
      measureRequestComposition({ messages: step15Msgs }).totalTokens >= 32000,
      'step15Msgs must exceed 32k floor so cooldown gate is exercised',
    );
    const cooldownBlocked = engine.compress(step15Msgs, { currentStep: 15, contractFiles: ['SPEC.md'] });
    assert.equal(cooldownBlocked.triggered, false);
    assert.equal(cooldownBlocked.reason, 'eviction_cooldown');
    assert.equal(cooldownBlocked.compressedCount, 0);

    // 4) At step 16 (16 - 10 = 6 >= 6), cooldown passes and Epoch 2 fires!
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

test('v3.1 WP4 (c & d): working-set verbatim read_file (<=16k), DUPLICATE repeat, >2400 probe slicing, and unified `${ln}: ` line numbers', async () => {
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
    assert.ok(mod300Output.length > 8000 && mod300Output.length <= 16000, `Expected ~9k+ <=16k chars, got ${mod300Output.length}`);

    const hugeReadBody = makeCodeModule('giantRegistry', 450, 'lookupRegistryRule');
    assert.ok(hugeReadBody.length > 16000, `Expected >16k chars, got ${hugeReadBody.length}`);

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
    assert.equal(byId1.b_large.admission.decision, ADMISSION_DECISIONS.IRRELEVANT);

    // >16k read_file goes through 5-tier admission (SUPPORTING or DEFER) with unified `${ln}: ` line numbers
    assert.ok(
      [ADMISSION_DECISIONS.SUPPORTING, ADMISSION_DECISIONS.DEFER].includes(byId1.r_huge.admission.decision),
      `Expected >16k read_file to be sliced, got ${byId1.r_huge.admission.decision}`,
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
