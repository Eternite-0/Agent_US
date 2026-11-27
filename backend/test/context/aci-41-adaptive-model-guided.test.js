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
import { estimateTokens, measureRequestComposition, pairClosed } from '../../src/context.js';
import {
  ContextEvidenceLedger,
  ReversibleContextStore,
} from '../../src/context/aci-store.js';
import {
  ADMISSION_DECISIONS,
  DEFAULT_ADMISSION_CONTEXT_WINDOW,
  DEFAULT_ERROR_REQUERY_RISK,
  DEFAULT_NORMAL_REQUERY_RISK,
  DEFAULT_REQUERY_FLOOR_RATIO,
  PreInjectionAdmissionController,
  admitToolBatch,
  estimateRemainingHorizon,
  evaluateAdmissionRequeryGate,
} from '../../src/context/aci-admission.js';
import {
  ACIEngine,
  CACHE_AWARE_V31_DTOC_POLICY,
  compressMessagesEpoch,
  expandContext,
  extractEpochAdjudicationCandidates,
  shouldTriggerAciEpoch,
  solveOptimalEpochSplit,
} from '../../src/context/aci-engine.js';
import { ContextSupervisor } from '../../src/context/supervisor.js';

function wrapUntrusted(seq, toolName, body) {
  const id = `a4100000111122223333444455556666-tool-${toolName}-${seq}`;
  return `<untrusted id="${id}" bytes="${Buffer.byteLength(body, 'utf8')}">${body}</untrusted id="${id}">`;
}

function makeToolStep(stepId, name, args, output, { isError = false, step = undefined } = {}) {
  return [
    {
      role: 'assistant',
      ...(step !== undefined ? { step } : {}),
      content: [{ type: 'tool-call', id: stepId, name, arguments: args }],
    },
    {
      role: 'tool',
      ...(step !== undefined ? { step } : {}),
      toolCallId: stepId,
      toolName: name,
      isError,
      content: [{ type: 'text', text: output }],
    },
  ];
}

function makeCodeModule(prefix, lineCount = 200) {
  const words = [
    'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
    'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  ];
  const lines = [`import { helperCore } from './core_${prefix}.js';`];
  for (let i = 1; i <= lineCount; i += 1) {
    const w1 = words[i % words.length];
    const w2 = words[(i * 5 + 3) % words.length];
    lines.push(
      `export function ${prefix}_fn_${i}_${w1}(input, factor = ${(i % 9) + 1}) { return helperCore(input, '${w2}_${i}', factor); }`,
    );
  }
  return lines.join('\n');
}

function assertPrefixByteIdentical(beforeMessages, afterMessages, splitIndex, label = '') {
  assert.ok(
    Number.isInteger(splitIndex) && splitIndex >= 0 && splitIndex <= beforeMessages.length,
    `${label}: invalid splitIndex ${splitIndex}`,
  );
  for (let i = 0; i < splitIndex; i += 1) {
    assert.equal(
      JSON.stringify(afterMessages[i]),
      JSON.stringify(beforeMessages[i]),
      `${label}: prefix message [${i}] (< k*=${splitIndex}) must remain 100% byte-identical`,
    );
  }
}

async function waitForTurnTerminal(directAgent, sessionId, turnId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const turn = directAgent.listTurns(sessionId).find((x) => x.id === turnId);
    if (turn && ['completed', 'failed', 'cancelled'].includes(turn.state)) return turn;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for turn ${turnId}`);
}

// ============================================================================
// SECTION 1: Online Adaptive Admission Gate
// ============================================================================

test('Task 4.1 Section 1A: evaluateAdmissionRequeryGate & estimateRemainingHorizon exact mathematical invariants', () => {
  assert.equal(DEFAULT_ADMISSION_CONTEXT_WINDOW, 128000);
  assert.equal(DEFAULT_NORMAL_REQUERY_RISK, 0.25);
  assert.equal(DEFAULT_ERROR_REQUERY_RISK, 0.65);
  assert.equal(DEFAULT_REQUERY_FLOOR_RATIO, 0.08);

  // Floor case: P_t = 0 -> penaltyBase = floor(128000 * 0.08) = 10240
  // Normal: requeryRisk = 0.25 -> expectedPenalty = 2560
  const floorPass = evaluateAdmissionRequeryGate({
    originalTokens: 1200,
    summaryTokens: 400, // deltaTokens = 800
    currentPromptTokens: 0,
    contextWindow: 128000,
    estHorizon: 4, // expectedGain = 3200 > 2560
    isErrorOutput: false,
  });
  assert.equal(floorPass.deltaTokens, 800);
  assert.equal(floorPass.requeryRisk, 0.25);
  assert.equal(floorPass.penaltyBaseTokens, 10240);
  assert.equal(floorPass.expectedGain, 3200);
  assert.equal(floorPass.expectedPenalty, 2560);
  assert.equal(floorPass.passed, true);

  // Exact equality boundary must FAIL (strict >)
  const exactTie = evaluateAdmissionRequeryGate({
    originalTokens: 1040,
    summaryTokens: 400, // deltaTokens = 640
    currentPromptTokens: 0,
    contextWindow: 128000,
    estHorizon: 4, // 4 * 640 = 2560 === 0.25 * 10240
    isErrorOutput: false,
  });
  assert.equal(exactTie.expectedGain, exactTie.expectedPenalty);
  assert.equal(exactTie.passed, false);

  // High P_t case: P_t = 60000 > floor(10240) -> expectedPenalty = 0.25 * 60000 = 15000
  const highPtBlocked = evaluateAdmissionRequeryGate({
    originalTokens: 2800,
    summaryTokens: 600, // deltaTokens = 2200
    currentPromptTokens: 60000,
    contextWindow: 128000,
    estHorizon: 4, // expectedGain = 8800 <= 15000
    isErrorOutput: false,
  });
  assert.equal(highPtBlocked.penaltyBaseTokens, 60000);
  assert.equal(highPtBlocked.expectedGain, 8800);
  assert.equal(highPtBlocked.expectedPenalty, 15000);
  assert.equal(highPtBlocked.passed, false);

  // Error risk = 0.65 vs normal = 0.25 at identical deltaTokens & P_t
  const normalAt20k = evaluateAdmissionRequeryGate({
    originalTokens: 2800,
    summaryTokens: 600, // delta = 2200
    currentPromptTokens: 20000,
    contextWindow: 128000,
    estHorizon: 4, // expectedGain = 8800
    isErrorOutput: false, // expectedPenalty = 0.25 * 20000 = 5000
  });
  const errorAt20k = evaluateAdmissionRequeryGate({
    originalTokens: 2800,
    summaryTokens: 600,
    currentPromptTokens: 20000,
    contextWindow: 128000,
    estHorizon: 4, // expectedGain = 8800
    isErrorOutput: true, // expectedPenalty = 0.65 * 20000 = 13000
  });
  assert.equal(normalAt20k.requeryRisk, 0.25);
  assert.equal(normalAt20k.passed, true);
  assert.equal(errorAt20k.requeryRisk, 0.65);
  assert.equal(errorAt20k.expectedPenalty, 13000);
  assert.equal(errorAt20k.passed, false);

  // Smooth online horizon estimation adapts to step + unverified edits + unresolved errors
  const hEarly = estimateRemainingHorizon({ currentStep: 0 });
  const hMid = estimateRemainingHorizon({ currentStep: 8 });
  const hLate = estimateRemainingHorizon({ currentStep: 24 });
  const hUnverified = estimateRemainingHorizon({ currentStep: 8, hasUnverifiedEdits: true });
  const hErrors = estimateRemainingHorizon({ currentStep: 8, hasUnresolvedErrors: true });
  const hBoth = estimateRemainingHorizon({
    currentStep: 8,
    hasUnverifiedEdits: true,
    hasUnresolvedErrors: true,
  });
  assert.ok(hEarly > hMid && hMid > hLate && hLate >= 2, `Horizon must taper smoothly: ${hEarly}, ${hMid}, ${hLate}`);
  assert.ok(hUnverified > hMid, 'Unverified edits must increase estimated remaining horizon');
  assert.ok(hErrors > hMid, 'Unresolved errors must increase estimated remaining horizon');
  assert.ok(hBoth > hUnverified && hBoth > hErrors, 'Combined unconverged state must raise horizon further');
});

test('Task 4.1 Section 1B: Exact SHA-256 DUPLICATE deduplicates immediately with 0 info loss regardless of P_t', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'aci41-dup-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();
    const ctrl = new PreInjectionAdmissionController({ aciStore, ledger });

    const fileBody = makeCodeModule('billingEngine', 90);
    const grepBody = Array.from(
      { length: 65 },
      (_, i) => `src/billing/rule_${i % 5}.js:${i + 1}: export const rule_${i} = computeRate(${i});`,
    ).join('\n');
    assert.ok(fileBody.length > 3000 && grepBody.length > 3000);

    // Step 1 at low P_t
    const res1 = await ctrl.admitBatch(
      [
        {
          tc: { id: 'r1', name: 'read_file', arguments: JSON.stringify({ path: 'src/billing/engine.js' }) },
          parsedArgs: { path: 'src/billing/engine.js' },
          output: wrapUntrusted(1, 'read_file', fileBody),
          isError: false,
        },
        {
          tc: { id: 'g1', name: 'grep', arguments: JSON.stringify({ query: 'computeRate', path: 'src/billing' }) },
          parsedArgs: { query: 'computeRate', path: 'src/billing' },
          output: wrapUntrusted(2, 'grep', grepBody),
          isError: false,
        },
      ],
      {
        query: 'Inspect billingEngine and computeRate',
        step: 1,
        currentPromptTokens: 2000,
        contextWindow: 128000,
        estHorizon: 4,
      },
    );
    assert.notEqual(res1.admittedItems[0].admission.decision, ADMISSION_DECISIONS.DUPLICATE);
    assert.notEqual(res1.admittedItems[1].admission.decision, ADMISSION_DECISIONS.DUPLICATE);

    // Step 2 at HUGE P_t = 110,000 where lossy summarization would NEVER clear the requery gate:
    // exact SHA-256 DUPLICATE MUST still deduplicate immediately with zero info loss!
    const res2 = await ctrl.admitBatch(
      [
        {
          tc: { id: 'r1_dup', name: 'read_file', arguments: JSON.stringify({ path: 'src/billing/engine.js' }) },
          parsedArgs: { path: 'src/billing/engine.js' },
          output: wrapUntrusted(3, 'read_file', fileBody),
          isError: false,
        },
        {
          tc: { id: 'g1_dup', name: 'grep', arguments: JSON.stringify({ query: 'computeRate', path: 'src/billing' }) },
          parsedArgs: { query: 'computeRate', path: 'src/billing' },
          output: wrapUntrusted(4, 'grep', grepBody),
          isError: false,
        },
      ],
      {
        query: 'Inspect billingEngine and computeRate',
        step: 2,
        currentPromptTokens: 110000,
        contextWindow: 128000,
        estHorizon: 2,
      },
    );

    const rDup = res2.admittedItems[0];
    const gDup = res2.admittedItems[1];
    assert.equal(rDup.admission.decision, ADMISSION_DECISIONS.DUPLICATE);
    assert.equal(gDup.admission.decision, ADMISSION_DECISIONS.DUPLICATE);
    assert.ok(rDup.admission.tokensSaved > 0);
    assert.ok(gDup.admission.tokensSaved > 0);
    assert.match(rDup.admittedOutput, /prior step=1/);
    assert.match(gDup.admittedOutput, /prior step=1/);

    const restoredFile = aciStore.restoreVerified(rDup.admission.uri);
    assert.equal(restoredFile.verified, true);
    assert.equal(restoredFile.content, fileBody);
    const restoredGrep = aciStore.restoreVerified(gDup.admission.uri);
    assert.equal(restoredGrep.verified, true);
    assert.equal(restoredGrep.content, grepBody);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('Task 4.1 Section 1C: Growing P_t protects medium outputs verbatim as DIRECT (never IRRELEVANT or micro-truncated for non-isDecoy)', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'aci41-pt-scale-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const mediumGrep = Array.from(
      { length: 95 },
      (_, i) => `src/service/worker_${i % 6}.js:${i + 10}: export function handleItem_${i}(ctx) { return dispatch(ctx, ${i}); }`,
    ).join('\n');
    const mediumZeroSignalBash = [
      ...Array.from(
        { length: 130 },
        (_, i) => `worker-status line=${i} ok=true elapsed_ms=${10 + (i % 5)} payload=${'a'.repeat(30)}`,
      ),
      'exitCode: 0',
    ].join('\n');
    const explicitDecoy = [
      '// DO NOT EDIT - ARCHIVED DECOY',
      ...Array.from({ length: 80 }, (_, i) => `export function legacyOld_${i}() { return ${i}; }`),
    ].join('\n');

    assert.ok(mediumGrep.length > 6500 && mediumGrep.length < 15000);
    assert.ok(mediumZeroSignalBash.length > 6500 && mediumZeroSignalBash.length < 15000);

    const wrappedGrep = wrapUntrusted(1, 'grep', mediumGrep);
    const wrappedBash = wrapUntrusted(2, 'bash', mediumZeroSignalBash);

    // 1) Low P_t = 0, estHorizon = 6 -> clears 0.25 * floor(128000 * 0.08) = 2560
    const lowRes = await admitToolBatch(
      [
        {
          tc: { id: 'g_med', name: 'grep', arguments: JSON.stringify({ query: 'handleItem' }) },
          parsedArgs: { query: 'handleItem' },
          output: wrappedGrep,
          isError: false,
        },
        {
          tc: { id: 'b_noise', name: 'bash', arguments: JSON.stringify({ command: 'status-check' }) },
          parsedArgs: { command: 'status-check' },
          output: wrappedBash,
          isError: false,
        },
        {
          tc: { id: 'd_decoy', name: 'read_file', arguments: JSON.stringify({ path: 'src/legacy/old_mod.js' }) },
          parsedArgs: { path: 'src/legacy/old_mod.js' },
          output: explicitDecoy,
          isError: false,
        },
      ],
      {
        aciStore: new ReversibleContextStore(store),
        query: 'Inspect handleItem routing',
        step: 1,
        currentPromptTokens: 0,
        contextWindow: 128000,
        estHorizon: 6,
      },
    );

    const lowById = Object.fromEntries(lowRes.admittedItems.map((it) => [it.tc.id, it]));
    assert.ok(
      [ADMISSION_DECISIONS.SUPPORTING, ADMISSION_DECISIONS.DEFER].includes(lowById.g_med.admission.decision),
      `Low P_t medium grep should summarize, got ${lowById.g_med.admission.decision}`,
    );
    assert.equal(lowById.g_med.admission.requeryGate.passed, true);
    assert.notEqual(
      lowById.b_noise.admission.decision,
      ADMISSION_DECISIONS.IRRELEVANT,
      'Non-isDecoy output MUST NEVER be classified as IRRELEVANT',
    );
    assert.ok(
      [ADMISSION_DECISIONS.SUPPORTING, ADMISSION_DECISIONS.DEFER].includes(lowById.b_noise.admission.decision),
      `Low P_t zero-signal non-decoy burst clearing gate should become SUPPORTING/DEFER, got ${lowById.b_noise.admission.decision}`,
    );
    assert.equal(lowById.d_decoy.admission.isDecoy, true);
    assert.equal(lowById.d_decoy.admission.decision, ADMISSION_DECISIONS.IRRELEVANT);

    // 2) High P_t = 85,000, estHorizon = 4 -> expectedPenalty = 0.25 * 85000 = 21250 >> expectedGain
    // Medium non-decoy outputs MUST stay verbatim DIRECT (zero micro-truncation, never IRRELEVANT!)
    const highRes = await admitToolBatch(
      [
        {
          tc: { id: 'g_med_hi', name: 'grep', arguments: JSON.stringify({ query: 'handleItem' }) },
          parsedArgs: { query: 'handleItem' },
          output: wrappedGrep,
          isError: false,
        },
        {
          tc: { id: 'b_noise_hi', name: 'bash', arguments: JSON.stringify({ command: 'status-check' }) },
          parsedArgs: { command: 'status-check' },
          output: wrappedBash,
          isError: false,
        },
      ],
      {
        aciStore: new ReversibleContextStore(store),
        query: 'Inspect handleItem routing',
        step: 10,
        currentPromptTokens: 85000,
        contextWindow: 128000,
        estHorizon: 4,
      },
    );

    const hiById = Object.fromEntries(highRes.admittedItems.map((it) => [it.tc.id, it]));
    for (const [id, expectedRaw] of [
      ['g_med_hi', wrappedGrep],
      ['b_noise_hi', wrappedBash],
    ]) {
      const item = hiById[id];
      assert.equal(item.admission.decision, ADMISSION_DECISIONS.DIRECT, `${id} must stay DIRECT at high P_t`);
      assert.equal(item.admittedOutput, expectedRaw, `${id} must be verbatim with ZERO micro-truncation`);
      assert.equal(item.admission.requeryGate.passed, false);
      assert.ok(item.admission.expectedGain <= item.admission.expectedPenalty);
      assert.equal(item.admission.currentPromptTokens, 85000);
    }
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('Task 4.1 Section 1D: Error/exception outputs use requeryRisk = 0.65 vs 0.25 for normal probes (same size: normal summarized, error DIRECT)', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'aci41-err-risk-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const commonLines = Array.from(
      { length: 145 },
      (_, i) => `step ${String(i).padStart(3, '0')}: executing verification check case_${i} (${'v'.repeat(42)})`,
    );
    const okBashBody = [...commonLines, 'All 145 checks completed cleanly.', 'exitCode: 0'].join('\n');
    const errBashBody = [
      ...commonLines.slice(0, 140),
      'Traceback (most recent call last):',
      '  File "src/core/calc.py", line 88, in compute_total',
      '    assert result == expected_value',
      'AssertionError: expected 420 but received 415',
      'FAILED 1 check out of 145',
      'exitCode: 1',
    ].join('\n');

    const okTok = estimateTokens(okBashBody);
    const errTok = estimateTokens(errBashBody);
    assert.ok(Math.abs(okTok - errTok) < 150, `Expected comparable sizes, got ok=${okTok}, err=${errTok}`);

    // Choose P_t = 24000, estHorizon = 5:
    // deltaTokens ~ 1800-2300 -> expectedGain ~ 9000-11500
    // Normal penalty: 0.25 * 24000 = 6000  -> expectedGain > 6000  (SUMMARIZED)
    // Error penalty:  0.65 * 24000 = 15600 -> expectedGain <= 15600 (DIRECT verbatim!)
    const wrappedOk = wrapUntrusted(1, 'bash', okBashBody);
    const wrappedErr = wrapUntrusted(2, 'bash', errBashBody);

    const res = await admitToolBatch(
      [
        {
          tc: { id: 'b_ok', name: 'bash', arguments: JSON.stringify({ command: 'run-checks --ok' }) },
          parsedArgs: { command: 'run-checks --ok' },
          output: wrappedOk,
          isError: false,
        },
        {
          tc: { id: 'b_err', name: 'bash', arguments: JSON.stringify({ command: 'run-checks --fail' }) },
          parsedArgs: { command: 'run-checks --fail' },
          output: wrappedErr,
          isError: true,
        },
      ],
      {
        aciStore: new ReversibleContextStore(store),
        query: 'Verify calc output',
        step: 3,
        currentPromptTokens: 24000,
        contextWindow: 128000,
        estHorizon: 5,
      },
    );

    const byId = Object.fromEntries(res.admittedItems.map((it) => [it.tc.id, it]));
    const okItem = byId.b_ok;
    const errItem = byId.b_err;

    assert.equal(okItem.admission.requeryRisk, 0.25);
    assert.equal(okItem.admission.isErrorOutput, false);
    assert.equal(okItem.admission.requeryGate.passed, true);
    assert.ok(
      [ADMISSION_DECISIONS.SUPPORTING, ADMISSION_DECISIONS.DEFER].includes(okItem.admission.decision),
      `Normal probe clearing 0.25 gate must summarize, got ${okItem.admission.decision}`,
    );

    assert.equal(errItem.admission.requeryRisk, 0.65);
    assert.equal(errItem.admission.isErrorOutput, true);
    assert.equal(errItem.admission.requeryGate.passed, false);
    assert.equal(errItem.admission.decision, ADMISSION_DECISIONS.DIRECT);
    assert.equal(errItem.admittedOutput, wrappedErr, 'Error output failing 0.65 gate must be preserved 100% verbatim');
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('Task 4.1 Section 1E: Huge burst outputs clearing the inequality summarize cleanly and expand_context restores exact line ranges losslessly', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'aci41-burst-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();

    const bashLines = Array.from({ length: 700 }, (_, i) => {
      const ln = i + 1;
      if (ln >= 220 && ln <= 235) {
        return `SENTINEL_LOG_LINE_${ln}: exact_diagnostic_value=${ln * 17} status=check_ok`;
      }
      return `verbose_runner_trace line=${ln} module=worker_${ln % 12} details=${'x'.repeat(55)}`;
    });
    bashLines.push('exitCode: 0');
    const hugeBash = bashLines.join('\n');

    const readLines = Array.from({ length: 650 }, (_, i) => {
      const ln = i + 1;
      if (ln >= 310 && ln <= 322) {
        return `export const SENTINEL_CODE_${ln} = { id: ${ln}, token: "exact_val_${ln}" };`;
      }
      return `export function burstHelper_${ln}(a, b) { return (a + b + ${ln}) + "${'k'.repeat(50)}"; }`;
    });
    const hugeRead = readLines.join('\n');

    assert.ok(hugeBash.length > 55000);
    assert.ok(hugeRead.length > 55000);

    const res = await admitToolBatch(
      [
        {
          tc: { id: 'burst_bash', name: 'bash', arguments: JSON.stringify({ command: 'run-full-suite' }) },
          parsedArgs: { command: 'run-full-suite' },
          output: wrapUntrusted(1, 'bash', hugeBash),
          isError: false,
        },
        {
          tc: { id: 'burst_read', name: 'read_file', arguments: JSON.stringify({ path: 'src/giant_table.js' }) },
          parsedArgs: { path: 'src/giant_table.js' },
          output: wrapUntrusted(2, 'read_file', hugeRead),
          isError: false,
        },
      ],
      {
        aciStore,
        ledger,
        query: 'Inspect giant_table and suite output',
        step: 2,
        currentPromptTokens: 25000,
        contextWindow: 128000,
        estHorizon: 6,
      },
    );

    const byId = Object.fromEntries(res.admittedItems.map((it) => [it.tc.id, it]));
    for (const key of ['burst_bash', 'burst_read']) {
      const item = byId[key];
      assert.equal(item.admission.requeryGate.passed, true, `${key} huge burst must pass requery gate`);
      assert.ok(
        [ADMISSION_DECISIONS.SUPPORTING, ADMISSION_DECISIONS.DEFER].includes(item.admission.decision),
        `${key} huge burst must be SUPPORTING or DEFER, got ${item.admission.decision}`,
      );
      assert.match(item.admittedOutput, /^\[ACI-REF artifact:\/\/[0-9a-f]{64}/);
      assert.ok(item.admission.tokensSaved > 5000);
    }

    // Lossless expand_context line-range restoration
    const restoredBashSlice = expandContext(aciStore, byId.burst_bash.admission.uri, {
      startLine: 220,
      endLine: 235,
      ledger,
    });
    assert.equal(restoredBashSlice.verified, true);
    assert.equal(restoredBashSlice.text, bashLines.slice(219, 235).join('\n'));

    const restoredReadSlice = expandContext(aciStore, byId.burst_read.admission.uri, {
      startLine: 310,
      endLine: 322,
      ledger,
    });
    assert.equal(restoredReadSlice.verified, true);
    assert.equal(restoredReadSlice.text, readLines.slice(309, 322).join('\n'));

    const fullVerified = aciStore.restoreVerified(byId.burst_read.admission.uri);
    assert.equal(fullVerified.verified, true);
    assert.equal(fullVerified.content, hugeRead);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

// ============================================================================
// SECTION 2: Cache-Rate Self-Calibrated DP Optimal Split k*
// ============================================================================

test('Task 4.1 Section 2A: DP optimal split k* adapts to observedCacheHitRate (0 vs 0.95) and keeps [0 .. k*-1] 100% byte-identical', () => {
  // 1) Pure DP solver exact formula check
  // Layout: [0] 200, [1] 1600 (cand early: raw=1600, stub=60 -> s=1540), [2] 22000 (shielded),
  //         [3] 7060 (cand late: raw=7060, stub=60 -> s=7000), [4] 1200 (recent tail)
  const msgTokens = [200, 1600, 22000, 7060, 1200];
  const totalP = msgTokens.reduce((a, b) => a + b, 0); // 32060 (< 48000!)
  const candidates = [
    { messageIndex: 1, id: 'c_early', rawTokens: 1600, stubTokens: 60, savings: 1540 },
    { messageIndex: 3, id: 'c_late', rawTokens: 7060, stubTokens: 60, savings: 7000 },
  ];

  const dpCold = solveOptimalEpochSplit({
    messageTokens: msgTokens,
    candidates,
    observedCacheHitRate: 0,
    estHorizon: 6,
    currentPromptTokens: totalP,
  });
  assert.equal(dpCold.triggered, true);
  assert.equal(dpCold.optimalSplitIndex, 1, 'At rho=0 (uncached), DP must compress from earliest candidate k*=1');
  assert.equal(dpCold.candidateSavings, 8540);

  const dpHot = solveOptimalEpochSplit({
    messageTokens: msgTokens,
    candidates,
    observedCacheHitRate: 0.95,
    estHorizon: 6,
    currentPromptTokens: totalP,
  });
  assert.equal(dpHot.triggered, true);
  assert.equal(
    dpHot.optimalSplitIndex,
    3,
    'At rho=0.95 (hot cache), DP must skip early small-gain candidate and split at high-gain tail k*=3',
  );
  assert.equal(dpHot.candidateSavings, 7000);
  // Check exact netCacheAdjustedGain(k*=3) formula:
  // I(3) = (7060 + 1200) - 7000 = 1260
  // gain = 7000 * (1 + max(1, 6 - 1) * (1 - 0.9 * 0.95)) - (0.9 * 0.95) * 1260
  const expectedHotGain = 7000 * (1 + 5 * (1 - 0.9 * 0.95)) - 0.9 * 0.95 * 1260;
  assert.ok(
    Math.abs(dpHot.netCacheAdjustedGain - expectedHotGain) < 1e-2,
    `Expected netCacheAdjustedGain ~ ${expectedHotGain}, got ${dpHot.netCacheAdjustedGain}`,
  );
  assert.ok(dpHot.netCacheAdjustedGain > 0);
  assert.ok(6 * dpHot.candidateSavings > Math.max(totalP * 0.6, dpHot.suffixTokens * 0.95));

  // 2) Full ACIEngine + compressMessagesEpoch on the SAME multi-step trajectory
  const storeDir = mkdtempSync(join(tmpdir(), 'aci41-dp-split-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const earlySmallCode = makeCodeModule('earlySmall', 55); // ~1,600 tok
    const hugeShieldedSpec = `# SPEC\n${'Contract invariant line that stays shielded in middle.\n'.repeat(1850)}`; // ~22k tok
    const lateHighGainCode = makeCodeModule('lateHighGain', 260); // ~7,000+ tok
    const recentTailCode = makeCodeModule('recentLive', 40); // ~1,100 tok

    const trajectory = [
      { role: 'user', content: [{ type: 'text', text: 'Optimize and verify modules' }] },
      ...makeToolStep('h_readme', 'read_file', { path: 'README.md' }, 'Intro\n'.repeat(12), { step: 1 }),
      ...makeToolStep('c_early', 'read_file', { path: 'src/early_small.js' }, earlySmallCode, { step: 2 }),
      ...makeToolStep('s_spec', 'read_file', { path: 'SPEC.md' }, hugeShieldedSpec, { step: 3 }),
      ...makeToolStep('c_late', 'read_file', { path: 'src/late_huge.js' }, lateHighGainCode, { step: 4 }),
      ...makeToolStep('r_live', 'read_file', { path: 'src/live.js' }, recentTailCode, { step: 10 }),
    ];

    const earlyIdx = trajectory.findIndex((m) => m.toolCallId === 'c_early');
    const lateIdx = trajectory.findIndex((m) => m.toolCallId === 'c_late');
    const totalTokens = measureRequestComposition({ messages: trajectory }).totalTokens;
    assert.ok(
      totalTokens > 20000 && totalTokens < 48000,
      `Trajectory must exercise adaptive DP strictly below old 48k wall, got ${totalTokens} tokens`,
    );

    // Hot cache (rho_t = 0.95): skips c_early, splits precisely at k* = lateIdx
    const hotEngine = new ACIEngine({
      store,
      aciStore: new ReversibleContextStore(store),
      ledger: new ContextEvidenceLedger(),
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
      contextWindow: 128000,
    });
    const hotProbe = hotEngine.inspectEpoch(trajectory, {
      currentStep: 10,
      contractFiles: ['SPEC.md'],
      observedCacheHitRate: 0.95,
      estHorizon: 6,
    });
    assert.equal(hotProbe.triggered, true);
    assert.equal(hotProbe.optimalSplitIndex, lateIdx, 'Hot cache (rho=0.95) must split at late high-gain candidate');
    assert.equal(hotProbe.firstCandidateIndex, lateIdx);

    const hotComp = hotEngine.compress(trajectory, {
      currentStep: 10,
      contractFiles: ['SPEC.md'],
      observedCacheHitRate: 0.95,
      estHorizon: 6,
    });
    assert.equal(hotComp.triggered, true);
    assert.equal(hotComp.optimalSplitIndex, lateIdx);
    assert.equal(hotComp.compressedCount, 1, 'Hot cache must compress ONLY c_late');
    assert.equal(pairClosed(hotComp.messages), true);
    assertPrefixByteIdentical(trajectory, hotComp.messages, lateIdx, 'hot-cache');
    assert.ok(
      hotComp.messages[earlyIdx].content[0].text.includes('earlySmall_fn_1_'),
      'Early small-gain candidate (< k*) must remain verbatim',
    );
    assert.ok(
      hotComp.messages[lateIdx].content[0].text.startsWith('[ACI-REF '),
      'Late high-gain candidate (>= k*) must be compressed into reversible ACI-REF stub',
    );

    // Uncached (rho_t = 0): compresses earlier candidate too (k* = earlyIdx < lateIdx!)
    const coldEngine = new ACIEngine({
      store,
      aciStore: new ReversibleContextStore(store),
      ledger: new ContextEvidenceLedger(),
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
      contextWindow: 128000,
    });
    const coldProbe = coldEngine.inspectEpoch(trajectory, {
      currentStep: 10,
      contractFiles: ['SPEC.md'],
      observedCacheHitRate: 0,
      estHorizon: 6,
    });
    assert.equal(coldProbe.triggered, true);
    assert.equal(coldProbe.optimalSplitIndex, earlyIdx, 'Uncached (rho=0) must split earlier at k*=earlyIdx');
    assert.ok(coldProbe.optimalSplitIndex < hotProbe.optimalSplitIndex);

    const coldComp = coldEngine.compress(trajectory, {
      currentStep: 10,
      contractFiles: ['SPEC.md'],
      observedCacheHitRate: 0,
      estHorizon: 6,
    });
    assert.equal(coldComp.triggered, true);
    assert.equal(coldComp.optimalSplitIndex, earlyIdx);
    assert.equal(coldComp.compressedCount, 2, 'Uncached (rho=0) must compress both c_early and c_late');
    assert.equal(pairClosed(coldComp.messages), true);
    assertPrefixByteIdentical(trajectory, coldComp.messages, earlyIdx, 'cold-cache');
    assert.ok(coldComp.messages[earlyIdx].content[0].text.startsWith('[ACI-REF '));
    assert.ok(coldComp.messages[lateIdx].content[0].text.startsWith('[ACI-REF '));
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('Task 4.1 Section 2B: Short low-token tasks naturally abstain (0 triggers, no 48k wall) while medium trajectories <48k trigger across breakeven', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'aci41-breakeven-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    // 1) Short low-token task: fails H_t * S(k*) > Math.max(P_t * 0.6, I(k*) * rho_t) -> 0 triggers
    const shortMsgs = [
      { role: 'user', content: [{ type: 'text', text: 'Quick fix on small module' }] },
      ...makeToolStep('sh_h', 'read_file', { path: 'README.md' }, 'Readme info.\n'.repeat(10), { step: 1 }),
      ...makeToolStep('sh_c1', 'read_file', { path: 'src/tiny.js' }, makeCodeModule('tinyMod', 12), { step: 2 }), // ~350 tok
      ...makeToolStep('sh_live', 'read_file', { path: 'src/app.js' }, makeCodeModule('appMod', 90), { step: 7 }), // ~2500 tok
    ];
    const shortTokens = measureRequestComposition({ messages: shortMsgs }).totalTokens;
    assert.ok(shortTokens < 10000);

    const shortEngine = new ACIEngine({
      store,
      aciStore: new ReversibleContextStore(store),
      ledger: new ContextEvidenceLedger(),
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
      contextWindow: 128000,
    });
    const shortSnapshot = JSON.stringify(shortMsgs);
    const shortProbe = shortEngine.inspectEpoch(shortMsgs, {
      currentStep: 7,
      observedCacheHitRate: 0.5,
      estHorizon: 3,
    });
    assert.equal(shortProbe.triggered, false);
    assert.notEqual(
      shortProbe.reason,
      'append_only_cache_floor_v31',
      'Must abstain via adaptive DP inequality, NOT a hardcoded 48k wall',
    );
    const shortComp = shortEngine.compress(shortMsgs, {
      currentStep: 7,
      observedCacheHitRate: 0.5,
      estHorizon: 3,
    });
    assert.equal(shortComp.triggered, false);
    assert.equal(shortComp.compressedCount, 0);
    assert.equal(JSON.stringify(shortComp.messages), shortSnapshot);

    // 2) Medium trajectory strictly < 48,000 tokens triggers naturally once H_t * S(k*) clears breakeven!
    const medMsgs = [
      { role: 'user', content: [{ type: 'text', text: 'Refactor pricing modules' }] },
      ...makeToolStep('m_h', 'read_file', { path: 'README.md' }, 'Overview\n'.repeat(15), { step: 1 }),
      ...makeToolStep('m_aged1', 'read_file', { path: 'src/aged_a.js' }, makeCodeModule('agedAlpha', 220), { step: 2 }),
      ...makeToolStep('m_aged2', 'read_file', { path: 'src/aged_b.js' }, makeCodeModule('agedBravo', 220), { step: 3 }),
      ...makeToolStep('m_live', 'read_file', { path: 'src/active.js' }, makeCodeModule('activeMod', 60), { step: 9 }),
    ];
    const medTokens = measureRequestComposition({ messages: medMsgs }).totalTokens;
    assert.ok(medTokens > 10000 && medTokens < 48000, `Expected medium <48k tokens, got ${medTokens}`);

    const medEngine = new ACIEngine({
      store,
      aciStore: new ReversibleContextStore(store),
      ledger: new ContextEvidenceLedger(),
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
      contextWindow: 128000,
    });
    const medComp = medEngine.compress(medMsgs, {
      currentStep: 9,
      observedCacheHitRate: 0.5,
      estHorizon: 5,
    });
    assert.equal(medComp.triggered, true, 'Medium trajectory below 48k must trigger naturally across DP breakeven');
    assert.equal(medComp.compressedCount, 2);
    assert.ok(medComp.netSavingsTokens > 4000);
    assertPrefixByteIdentical(medMsgs, medComp.messages, medComp.optimalSplitIndex, 'medium-below-48k');
    assert.equal(pairClosed(medComp.messages), true);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

// ============================================================================
// SECTION 3: Model-Guided Epoch Adjudication (ContextSupervisor + ACIEngine)
// ============================================================================

test('Task 4.1 Section 3A: ContextSupervisor.resolveModel distinguishes stage=admission vs stage=dtoc and evaluateEpoch runs read-only JSON adjudication', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'aci41-sup-stage-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const pool = new AccountPool(store, { root: storeDir });
    pool.createAccount({
      preset: 'deepseek',
      label: 'DS',
      credential: 'sk-test-41-stage',
      models: ['deepseek-v4', 'deepseek-chat'],
    });
    pool.setDefaultModel('deepseek-v4');

    const recordedCalls = [];
    const sup = new ContextSupervisor({
      store,
      pool,
      adapter: {
        async *stream(opts) {
          recordedCalls.push(opts);
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              keepRefs: ['cand_1', 'hallucinated_ref_999'],
              compressRefs: ['cand_2', 'cand_1'],
            }),
          };
          yield { type: 'usage', usage: { inputTokens: 420, outputTokens: 28 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      },
    });

    // 1) stage='admission' skips under AUTO_SKIP_V4_RE & matchesMainModel
    const admV4 = sup.resolveModel(null, { mainModel: 'deepseek-v4', stage: 'admission' });
    assert.equal(admV4.active, false);
    assert.equal(admV4.effectiveModel, null);
    assert.equal(admV4.stage, 'admission');

    pool.setDefaultModel('deepseek-chat');
    const admSameMain = sup.resolveModel(null, { mainModel: 'deepseek-chat', stage: 'admission' });
    assert.equal(admSameMain.active, false);
    assert.equal(admSameMain.effectiveModel, null);

    // admitCandidates must NOT invoke adapter when stage='admission' skips (same mainModel or AUTO_SKIP_V4_RE)
    const admSameCallRes = await sup.admitCandidates({
      query: 'Check module',
      candidates: [{ id: 'c1', path: 'src/a.js', chars: 5000, tokens: 1200 }],
      mainModel: 'deepseek-chat',
    });
    assert.equal(admSameCallRes.usedLlm, false);
    assert.equal(recordedCalls.length, 0);

    pool.setDefaultModel('deepseek-v4');
    const admCallRes = await sup.admitCandidates({
      query: 'Check module',
      candidates: [{ id: 'c1', path: 'src/a.js', chars: 5000, tokens: 1200 }],
      mainModel: 'deepseek-v4',
    });
    assert.equal(admCallRes.usedLlm, false);
    assert.equal(recordedCalls.length, 0);

    // 2) stage='dtoc' lifts BOTH matchesMainModel and AUTO_SKIP_V4_RE and reuses mainModel!
    pool.setDefaultModel('deepseek-v4');
    const dtocV4 = sup.resolveModel(null, { mainModel: 'deepseek-v4', stage: 'dtoc' });
    assert.equal(dtocV4.active, true);
    assert.equal(dtocV4.effectiveModel, 'deepseek-v4');
    assert.equal(dtocV4.stage, 'dtoc');

    pool.setDefaultModel('deepseek-chat');
    const dtocSameMain = sup.resolveModel(null, { mainModel: 'deepseek-chat', stage: 'dtoc' });
    assert.equal(dtocSameMain.active, true);
    assert.equal(dtocSameMain.effectiveModel, 'deepseek-chat');
    assert.equal(dtocSameMain.stage, 'dtoc');

    // 3) evaluateEpoch executes compact read-only (tools: []) call reusing mainModel deepseek-v4,
    // validates IDs, deduplicates overlap (keepRefs wins over compressRefs), and drops hallucinations
    pool.setDefaultModel('deepseek-v4');
    const epochRes = await sup.evaluateEpoch({
      query: 'Preserve pricing rules while folding unrelated helper scans',
      candidates: [
        {
          id: 'cand_1',
          path: 'src/pricing/rules.js',
          toolName: 'read_file',
          tokens: 4500,
          ageSteps: 6,
          symbolOutline: ['computePrice@L12', 'applyDiscount@L44'],
          shortSummary: 'Pricing tier rules',
        },
        {
          id: 'cand_2',
          path: 'src/util/noise_scan.js',
          toolName: 'read_file',
          tokens: 5200,
          ageSteps: 5,
          symbolOutline: ['noiseHelper@L1'],
          shortSummary: 'Unrelated scan output',
        },
      ],
      mainModel: 'deepseek-v4',
    });

    assert.equal(recordedCalls.length, 1);
    assert.equal(recordedCalls[0].model, 'deepseek-v4');
    assert.deepEqual(recordedCalls[0].tools, [], 'DTOC adjudication must enforce strict read-only tools: []');
    assert.ok(
      estimateTokens(recordedCalls[0].messages[0].content[0].text) < 1500,
      'DTOC adjudication payload must stay compact (~1k tokens)',
    );
    assert.equal(epochRes.ok, true);
    assert.equal(epochRes.usedLlm, true);
    assert.equal(epochRes.model, 'deepseek-v4');
    assert.deepEqual(epochRes.keepRefs, ['cand_1']);
    assert.deepEqual(epochRes.compressRefs, ['cand_2']);
    assert.deepEqual(epochRes.rejectedRefs, ['hallucinated_ref_999']);

    // 4) Malformed JSON fails open cleanly to deterministic fallback
    const badJsonSup = new ContextSupervisor({
      store,
      pool,
      adapter: {
        async *stream() {
          yield { type: 'text-delta', text: 'not valid json output' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      },
    });
    const failOpen = await badJsonSup.evaluateEpoch({
      query: 'Check',
      candidates: [{ id: 'cand_1', path: 'src/a.js', tokens: 2000, ageSteps: 5 }],
      mainModel: 'deepseek-v4',
    });
    assert.equal(failOpen.ok, false);
    assert.equal(failOpen.fallback, 'deterministic');
    assert.deepEqual(failOpen.keepRefs, []);
    assert.deepEqual(failOpen.compressRefs, []);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('Task 4.1 Section 3B: Closed-loop evaluateEpoch -> ACIEngine.compress excludes keepRefs, re-solves k*, preserves protected verbatim, and flags pure-superseded epochs', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'aci41-closed-loop-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const pool = new AccountPool(store, { root: storeDir });
    pool.createAccount({
      preset: 'deepseek',
      label: 'DS',
      credential: 'sk-test-41-loop',
      models: ['deepseek-v4'],
    });
    pool.setDefaultModel('deepseek-v4');

    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();
    const engine = new ACIEngine({
      store,
      aciStore,
      ledger,
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
      contextWindow: 128000,
    });

    const agedA = makeCodeModule('criticalKeepMod', 200);
    const agedB = makeCodeModule('evictModBeta', 220);
    const agedC = makeCodeModule('evictModGamma', 220);
    const liveTail = makeCodeModule('liveTailMod', 50);

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Keep criticalKeepMod logic while trimming old scans' }] },
      ...makeToolStep('h1', 'read_file', { path: 'README.md' }, 'Overview\n'.repeat(12), { step: 1 }),
      ...makeToolStep('aged_a', 'read_file', { path: 'src/critical_keep.js' }, agedA, { step: 2 }),
      ...makeToolStep('aged_b', 'read_file', { path: 'src/evict_beta.js' }, agedB, { step: 3 }),
      ...makeToolStep('aged_c', 'read_file', { path: 'src/evict_gamma.js' }, agedC, { step: 4 }),
      ...makeToolStep('live_tail', 'read_file', { path: 'src/live.js' }, liveTail, { step: 10 }),
    ];

    const idxA = messages.findIndex((m) => m.toolCallId === 'aged_a');
    const idxB = messages.findIndex((m) => m.toolCallId === 'aged_b');
    const idxC = messages.findIndex((m) => m.toolCallId === 'aged_c');

    // Step 1: Initial inspectEpoch triggers at k* = idxA and reports active aged candidates
    const initialProbe = engine.inspectEpoch(messages, {
      currentStep: 10,
      observedCacheHitRate: 0.4,
      estHorizon: 5,
    });
    assert.equal(initialProbe.triggered, true);
    assert.equal(initialProbe.optimalSplitIndex, idxA);
    assert.equal(initialProbe.hasAgedCandidates, true);
    assert.ok(initialProbe.agedCandidates.length >= 3);

    // Step 2: Compact adjudication candidate extraction + ContextSupervisor.evaluateEpoch
    const adjCandidates = extractEpochAdjudicationCandidates(messages, {
      aciStore,
      currentStep: 10,
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
    });
    assert.ok(adjCandidates.some((c) => c.id === 'aged_a' && !c.superseded));
    assert.ok(adjCandidates.some((c) => c.id === 'aged_b' && !c.superseded));
    assert.ok(adjCandidates.some((c) => c.id === 'aged_c' && !c.superseded));

    const sup = new ContextSupervisor({
      store,
      pool,
      adapter: {
        async *stream() {
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              keepRefs: ['aged_a'],
              compressRefs: ['aged_b', 'aged_c'],
            }),
          };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      },
    });
    const supRes = await sup.evaluateEpoch({
      query: 'Keep criticalKeepMod logic while trimming old scans',
      candidates: adjCandidates,
      mainModel: 'deepseek-v4',
    });
    assert.equal(supRes.ok, true);
    assert.deepEqual(supRes.keepRefs, ['aged_a']);
    assert.deepEqual(supRes.compressRefs, ['aged_b', 'aged_c']);

    // Step 3: Feed { keepRefs, compressRefs } into ACIEngine.compress -> re-solves k* to idxB!
    const comp = engine.compress(messages, {
      currentStep: 10,
      observedCacheHitRate: 0.4,
      estHorizon: 5,
      keepRefs: supRes.keepRefs,
      compressRefs: supRes.compressRefs,
    });
    assert.equal(comp.triggered, true);
    assert.equal(comp.optimalSplitIndex, idxB, 'Excluding keepRefs=[aged_a] must shift DP optimal k* right to idxB');
    assert.equal(comp.compressedCount, 2);
    assert.equal(pairClosed(comp.messages), true);

    // [0 .. idxB - 1] including model-protected aged_a MUST be 100% byte-identical!
    assertPrefixByteIdentical(messages, comp.messages, idxB, 'model-guided-keepRefs');
    assert.equal(comp.messages[idxA].content[0].text, agedA);

    // Remaining candidates i >= k* (aged_b & aged_c) are losslessly archived
    assert.ok(comp.messages[idxB].content[0].text.startsWith('[ACI-REF '));
    assert.ok(comp.messages[idxC].content[0].text.startsWith('[ACI-REF '));
    const uriB = comp.compressedRefs.find((r) => r.path === 'src/evict_beta.js')?.uri;
    const uriC = comp.compressedRefs.find((r) => r.path === 'src/evict_gamma.js')?.uri;
    assert.ok(uriB && uriC);
    assert.equal(engine.restoreVerified(uriB).content, agedB);
    assert.equal(engine.restoreVerified(uriC).content, agedC);

    // Step 4: Protecting ALL candidates via keepRefs cleanly cancels eviction on re-solve
    const freshEngine = new ACIEngine({
      store,
      aciStore: new ReversibleContextStore(store),
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
      contextWindow: 128000,
    });
    const allKept = freshEngine.compress(messages, {
      currentStep: 10,
      observedCacheHitRate: 0.4,
      estHorizon: 5,
      keepRefs: ['aged_a', 'aged_b', 'aged_c'],
    });
    assert.equal(allKept.triggered, false);
    assert.equal(allKept.compressedCount, 0);

    // Step 5: Pure-superseded epoch reports hasAgedCandidates === false (skips DTOC LLM adjudication)
    const supersededOnlyMsgs = [
      { role: 'user', content: [{ type: 'text', text: 'Edit target file' }] },
      ...makeToolStep('sh1', 'read_file', { path: 'README.md' }, 'Intro\n'.repeat(10), { step: 1 }),
      ...makeToolStep('sup_read', 'read_file', { path: 'src/target.js' }, makeCodeModule('targetPreEdit', 320), { step: 2 }),
      ...makeToolStep('sup_edit', 'edit_file', { path: 'src/target.js' }, 'Edited src/target.js', { step: 3 }),
      ...makeToolStep('sup_reread', 'read_file', { path: 'src/target.js' }, makeCodeModule('targetPostEdit', 45), { step: 4 }),
    ];
    const supEngine = new ACIEngine({
      store,
      aciStore: new ReversibleContextStore(store),
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
      contextWindow: 128000,
    });
    const supProbe = supEngine.inspectEpoch(supersededOnlyMsgs, {
      currentStep: 5,
      observedCacheHitRate: 0.2,
      estHorizon: 5,
    });
    assert.equal(supProbe.triggered, true);
    assert.equal(supProbe.hasAgedCandidates, false, 'Pure-superseded epoch must report hasAgedCandidates=false');
    assert.equal(supProbe.agedCandidates.length, 0);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('Task 4.1 Section 3C: Live DirectAgentRuntime closed loop skips DTOC LLM on pure-superseded epochs and runs stage=dtoc mainModel adjudication on active aged epochs', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aci41-rt-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'aci41-rt-work-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });

  const fileA = makeCodeModule('runtimeAlphaKeep', 240);
  const fileB = makeCodeModule('runtimeBetaCompress', 240);
  const fileC = makeCodeModule('runtimeGammaCompress', 240);
  const fileLive = makeCodeModule('runtimeLiveTail', 40);
  const fileTarget = makeCodeModule('runtimeSupersededTarget', 280);
  writeFileSync(join(workDir, 'README.md'), 'Project readme\n'.repeat(12), 'utf8');
  writeFileSync(join(workDir, 'src', 'alpha.js'), fileA, 'utf8');
  writeFileSync(join(workDir, 'src', 'beta.js'), fileB, 'utf8');
  writeFileSync(join(workDir, 'src', 'gamma.js'), fileC, 'utf8');
  writeFileSync(join(workDir, 'src', 'live.js'), fileLive, 'utf8');
  writeFileSync(join(workDir, 'src', 'target.js'), fileTarget, 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'deepseek',
    label: 'DS',
    credential: 'sk-test-41-e2e',
    models: ['deepseek-v4'],
  });
  pool.setDefaultModel('deepseek-v4');

  let mode = 'superseded';
  let mainStep = 0;
  const dtocSupervisorCalls = [];
  const mainMessageSnapshots = [];

  class ClosedLoopAdapter extends LlmAdapter {
    async *stream(options) {
      const isSupervisor = !Array.isArray(options.tools) || options.tools.length === 0;
      if (isSupervisor) {
        const userText = String(options.messages?.[0]?.content?.[0]?.text ?? '');
        const payload = JSON.parse(userText);
        const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
        const alphaCand = candidates.find((c) => String(c.path || '').includes('alpha.js'));
        const others = candidates.filter((c) => c.id !== alphaCand?.id).map((c) => c.id);
        dtocSupervisorCalls.push({
          model: options.model,
          tools: options.tools,
          candidateIds: candidates.map((c) => c.id),
          keepPicked: alphaCand?.id ?? null,
        });
        yield {
          type: 'text-delta',
          index: 0,
          text: JSON.stringify({
            keepRefs: alphaCand ? [alphaCand.id] : [],
            compressRefs: others,
          }),
        };
        yield { type: 'usage', usage: { inputTokens: 320, outputTokens: 24 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      mainStep += 1;
      mainMessageSnapshots.push(structuredClone(options.messages ?? []));

      const emitTool = (id, name, args, index = 0) => ({
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id,
          name,
          arguments: JSON.stringify(args),
        },
      });

      const emitStep = async function* (tcs) {
        const list = Array.isArray(tcs) ? tcs : tcs ? [tcs] : [];
        if (list.length > 0) {
          for (const tc of list) yield tc;
          yield { type: 'usage', usage: { inputTokens: 8000, outputTokens: 40, cacheReadTokens: 0 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          yield { type: 'text-delta', index: 0, text: 'Completed turn.' };
          yield { type: 'usage', usage: { inputTokens: 8000, outputTokens: 20, cacheReadTokens: 0 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      };

      if (mode === 'superseded') {
        const plan = [
          emitTool('s_h', 'read_file', { path: 'README.md' }),
          emitTool('s_t1', 'read_file', { path: 'src/target.js' }),
          emitTool('s_edit', 'edit_file', {
            path: 'src/target.js',
            target: 'runtimeSupersededTarget_fn_1_',
            replacement: 'runtimeSupersededTarget_fn_1_patched_',
          }),
          emitTool('s_live', 'read_file', { path: 'src/live.js' }),
          null,
        ];
        yield* emitStep(plan[mainStep - 1] ?? null);
        return;
      }

      // mode === 'aged': read alpha, beta, gamma at step 2 so all 3 reach age >= 3 together in Epoch 1
      const agedPlan = [
        emitTool('a_h', 'read_file', { path: 'README.md' }),
        [
          emitTool('a_alpha', 'read_file', { path: 'src/alpha.js' }, 0),
          emitTool('a_beta', 'read_file', { path: 'src/beta.js' }, 1),
          emitTool('a_gamma', 'read_file', { path: 'src/gamma.js' }, 2),
        ],
        emitTool('a_live1', 'read_file', { path: 'src/live.js' }),
        emitTool('a_glob1', 'glob', { pattern: 'src/*.js' }),
        emitTool('a_glob2', 'glob', { pattern: 'README.md' }),
        emitTool('a_glob3', 'glob', { pattern: '*.md' }),
        null,
      ];
      yield* emitStep(agedPlan[mainStep - 1] ?? null);
    }
  }

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: new ClosedLoopAdapter(),
    enableHeartbeat: false,
  });

  t.after(async () => {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  // --- Turn 1: Pure-superseded epoch -> compresses superseded read with 0 DTOC LLM calls ---
  mode = 'superseded';
  mainStep = 0;
  dtocSupervisorCalls.length = 0;
  mainMessageSnapshots.length = 0;

  const supSession = direct.createSession({
    workspaceRoot: workDir,
    permissionMode: 'workspace-write',
    aciProfile: 'full_aci',
  });
  const supTurn = direct.startTurn(supSession.id, {
    input: 'Patch src/target.js',
    model: 'deepseek-v4',
  });
  const supSettled = await waitForTurnTerminal(direct, supSession.id, supTurn.turn.id);
  assert.equal(supSettled.state, 'completed');
  assert.equal(
    dtocSupervisorCalls.length,
    0,
    'Pure-superseded epoch must NOT invoke DTOC LLM adjudication',
  );
  const lastSupMsgs = mainMessageSnapshots.at(-1) ?? [];
  const supTargetMsg = lastSupMsgs.find((m) => m.role === 'tool' && m.toolCallId === 's_t1');
  const supTargetText = supTargetMsg?.content?.find((b) => b.type === 'text')?.text ?? '';
  const editMsgText =
    lastSupMsgs
      .find((m) => m.role === 'tool' && m.toolCallId === 's_edit')
      ?.content?.find((b) => b.type === 'text')?.text ?? '';
  assert.ok(
    supTargetText.startsWith('[ACI-REF '),
    `Superseded read should still be deterministically archived into an ACI-REF stub (found=${Boolean(supTargetMsg)}, s_t1=${supTargetText.slice(0, 120)}, s_edit=${editMsgText.slice(0, 120)}, msgs=${lastSupMsgs.length})`,
  );

  // --- Turn 2: Active aged epoch -> calls stage=dtoc reusing deepseek-v4, preserves alpha.js verbatim, archives beta/gamma ---
  mode = 'aged';
  mainStep = 0;
  dtocSupervisorCalls.length = 0;
  mainMessageSnapshots.length = 0;

  const agedSession = direct.createSession({
    workspaceRoot: workDir,
    permissionMode: 'auto-safe',
    aciProfile: 'full_aci',
  });
  const agedTurn = direct.startTurn(agedSession.id, {
    input: 'Inspect alpha, beta, and gamma modules',
    model: 'deepseek-v4',
  });
  const agedSettled = await waitForTurnTerminal(direct, agedSession.id, agedTurn.turn.id);
  assert.equal(agedSettled.state, 'completed');
  assert.ok(
    dtocSupervisorCalls.length >= 1 && dtocSupervisorCalls.length <= 3,
    `Active aged epoch must invoke DTOC supervisor (1..3 calls), got ${dtocSupervisorCalls.length}`,
  );
  assert.equal(dtocSupervisorCalls[0].model, 'deepseek-v4', 'DTOC adjudication must reuse mainModel deepseek-v4');
  assert.deepEqual(dtocSupervisorCalls[0].tools, []);

  const finalAgedMsgs = mainMessageSnapshots.at(-1) ?? [];
  const textOf = (id) =>
    finalAgedMsgs
      .find((m) => m.role === 'tool' && m.toolCallId === id)
      ?.content?.find((b) => b.type === 'text')?.text ?? '';

  assert.ok(
    textOf('a_alpha').includes('runtimeAlphaKeep_fn_1_'),
    'Model-protected keepRefs candidate (alpha.js) must stay verbatim in subsequent turns',
  );
  assert.ok(
    textOf('a_beta').startsWith('[ACI-REF '),
    'Non-protected aged candidate beta.js (i >= k*) must be compressed into ACI-REF stub',
  );
  assert.ok(
    textOf('a_gamma').startsWith('[ACI-REF '),
    'Non-protected aged candidate gamma.js (i >= k*) must be compressed into ACI-REF stub',
  );
});
