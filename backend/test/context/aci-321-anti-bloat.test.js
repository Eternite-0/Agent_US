import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmDirSafe } from '../fixtures.js';
import { Store } from '../../src/store.js';
import { AccountPool } from '../../src/pool.js';
import { measureRequestComposition } from '../../src/context.js';
import {
  ContextEvidenceLedger,
  ReversibleContextStore,
} from '../../src/context/aci-store.js';
import {
  ADMISSION_DECISIONS,
  DEFAULT_MIN_SUPERVISOR_BATCH_CHARS,
  DEFAULT_WORKING_SET_READ_MAX_CHARS,
  PreInjectionAdmissionController,
} from '../../src/context/aci-admission.js';
import { ContextSupervisor } from '../../src/context/supervisor.js';
import {
  ACIEngine,
  CACHE_AWARE_V31_DTOC_POLICY,
  DEFAULT_V31_MIN_PROMPT_TOKENS,
} from '../../src/context/aci-engine.js';

function wrapUntrusted(seq, toolName, body) {
  const id = `feedface000011112222333344445555-tool-${toolName}-${seq}`;
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

test('3.2.1 B1: 42k working-set read, <=400-line slice exemption, decoy non-exemption, and slice DUPLICATE precedence', async () => {
  assert.equal(DEFAULT_WORKING_SET_READ_MAX_CHARS, 42000);
  const storeDir = mkdtempSync(join(tmpdir(), 'aci321-b1-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();
    const ctrl = new PreInjectionAdmissionController({ aciStore, ledger });

    // 1) 38,000-char read_file -> DIRECT (explicit_read_working_set)
    const ws38k = Array.from({ length: 380 }, (_, i) => `export function fn_${i}(v) { return v + ${i} + "${'x'.repeat(55)}"; }`).join('\n');
    assert.ok(ws38k.length > 30000 && ws38k.length <= 42000, `Expected 30k..42k, got ${ws38k.length}`);

    // 2) 400-line slice (>42k chars) -> DIRECT (narrow_line_slice)
    const slice400Body = Array.from({ length: 400 }, (_, i) => `${i + 1}: export const row_${i} = "${'y'.repeat(100)}";`).join('\n');
    const slice400Output = `File: src/huge_table.js (lines 1-400 of 1200)\n${slice400Body}`;
    assert.ok(slice400Output.length > 42000, `Expected >42k to ensure narrow_line_slice exemption is exercised, got ${slice400Output.length}`);

    // 3) 401-line slice (>42k chars) -> NOT narrow_line_slice
    const slice401Body = Array.from({ length: 401 }, (_, i) => `${i + 1}: export const bigRow_${i} = "${'z'.repeat(100)}";`).join('\n');
    const slice401Output = `File: src/huge_other.js (lines 1-401 of 1200)\n${slice401Body}`;
    assert.ok(slice401Output.length > 42000);

    // 4) Decoy narrow slice -> NOT exempted by isNarrowSlice
    const decoySliceBody = Array.from({ length: 80 }, (_, i) => `${i + 1}: export function legacyFn_${i}() { return ${i}; }`).join('\n');
    const decoySliceOutput = `File: src/legacy/old_mod.js (lines 1-80 of 200)\n${decoySliceBody}`;
    assert.ok(decoySliceOutput.length > 1400);

    const res1 = await ctrl.admitBatch(
      [
        {
          tc: { id: 'ws38', name: 'read_file', arguments: JSON.stringify({ path: 'src/ws38.js' }) },
          parsedArgs: { path: 'src/ws38.js' },
          output: wrapUntrusted(1, 'read_file', ws38k),
          isError: false,
        },
        {
          tc: { id: 's400', name: 'read_file', arguments: JSON.stringify({ path: 'src/huge_table.js', startLine: 1, endLine: 400 }) },
          parsedArgs: { path: 'src/huge_table.js', startLine: 1, endLine: 400 },
          output: wrapUntrusted(2, 'read_file', slice400Output),
          isError: false,
        },
        {
          tc: { id: 's401', name: 'read_file', arguments: JSON.stringify({ path: 'src/huge_other.js', startLine: 1, endLine: 401 }) },
          parsedArgs: { path: 'src/huge_other.js', startLine: 1, endLine: 401 },
          output: wrapUntrusted(3, 'read_file', slice401Output),
          isError: false,
        },
        {
          tc: { id: 'sdec', name: 'read_file', arguments: JSON.stringify({ path: 'src/legacy/old_mod.js', startLine: 1, endLine: 80 }) },
          parsedArgs: { path: 'src/legacy/old_mod.js', startLine: 1, endLine: 80 },
          output: wrapUntrusted(4, 'read_file', decoySliceOutput),
          isError: false,
        },
      ],
      { query: 'Inspect src/ws38.js and huge_table.js', step: 1 },
    );

    const byId1 = Object.fromEntries(res1.admittedItems.map((it) => [it.tc.id, it]));
    assert.equal(byId1.ws38.admission.decision, ADMISSION_DECISIONS.DIRECT);
    assert.equal(byId1.ws38.admission.reason, 'explicit_read_working_set');

    assert.equal(byId1.s400.admission.decision, ADMISSION_DECISIONS.DIRECT);
    assert.equal(byId1.s400.admission.reason, 'narrow_line_slice');

    assert.notEqual(byId1.s401.admission.decision, ADMISSION_DECISIONS.DIRECT);
    assert.notEqual(byId1.sdec.admission.decision, ADMISSION_DECISIONS.DIRECT);

    // 5) Repeated read of unchanged 400-line slice -> DUPLICATE before isNarrowSlice!
    // Also verify cumulative mutatedFiles on another file does not wipe unrelated hashes.
    const res2 = await ctrl.admitBatch(
      [
        {
          tc: { id: 's400_dup', name: 'read_file', arguments: JSON.stringify({ path: 'src/huge_table.js', startLine: 1, endLine: 400 }) },
          parsedArgs: { path: 'src/huge_table.js', startLine: 1, endLine: 400 },
          output: wrapUntrusted(5, 'read_file', slice400Output),
          isError: false,
        },
      ],
      { query: 'Inspect huge_table.js', step: 2, mutatedFiles: ['src/unrelated_edited.js'] },
    );
    assert.equal(res2.admittedItems[0].admission.decision, ADMISSION_DECISIONS.DUPLICATE);
    assert.match(res2.admittedItems[0].admittedOutput, /prior step=1/);

    // 6) Edit src/huge_table.js -> re-reading same slice is DIRECT (narrow_line_slice) again
    const res3 = await ctrl.admitBatch(
      [
        {
          tc: { id: 'e_ht', name: 'edit_file', arguments: JSON.stringify({ path: 'src/huge_table.js' }) },
          parsedArgs: { path: 'src/huge_table.js' },
          output: 'Edited src/huge_table.js',
          isError: false,
        },
        {
          tc: { id: 's400_after', name: 'read_file', arguments: JSON.stringify({ path: 'src/huge_table.js', startLine: 1, endLine: 400 }) },
          parsedArgs: { path: 'src/huge_table.js', startLine: 1, endLine: 400 },
          output: wrapUntrusted(6, 'read_file', slice400Output.replace('row_0', 'row_0_updated')),
          isError: false,
        },
      ],
      { query: 'Inspect huge_table.js', step: 3, mutatedFiles: ['src/unrelated_edited.js', 'src/huge_table.js'] },
    );
    assert.equal(res3.admittedItems[1].admission.decision, ADMISSION_DECISIONS.DIRECT);
    assert.equal(res3.admittedItems[1].admission.reason, 'narrow_line_slice');

    // 7) Step 4: repeating edited slice (with cumulative mutatedFiles still containing huge_table.js!) -> DUPLICATE!
    const res4 = await ctrl.admitBatch(
      [
        {
          tc: { id: 's400_after_dup', name: 'read_file', arguments: JSON.stringify({ path: 'src/huge_table.js', startLine: 1, endLine: 400 }) },
          parsedArgs: { path: 'src/huge_table.js', startLine: 1, endLine: 400 },
          output: wrapUntrusted(7, 'read_file', slice400Output.replace('row_0', 'row_0_updated')),
          isError: false,
        },
      ],
      { query: 'Inspect huge_table.js', step: 4, mutatedFiles: ['src/unrelated_edited.js', 'src/huge_table.js'] },
    );
    assert.equal(res4.admittedItems[0].admission.decision, ADMISSION_DECISIONS.DUPLICATE);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('3.2.1 B2: isErr scoped strictly to EXEC_ERROR_TOOLS, and grep/glob DUPLICATE dedup + mutation invalidation', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'aci321-b2-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const aciStore = new ReversibleContextStore(store);
    const ctrl = new PreInjectionAdmissionController({ aciStore });

    // Source/search content containing ERROR, AssertionError, Traceback must NOT trigger isErr!
    const readWithErrorWords =
      'def test_errors():\n    # Traceback (most recent call last)\n    raise AssertionError("boom")\n' +
      Array.from({ length: 120 }, (_, i) => `export const errCode_${i} = "Error: code_${i}";`).join('\n');
    assert.ok(readWithErrorWords.length > 2600);

    const grepResult = Array.from(
      { length: 45 },
      (_, i) => `src/errors/handler_${i % 4}.js:${i + 1}: throw new AssertionError("ERROR: invalid token ${i}");`,
    ).join('\n');
    assert.ok(grepResult.length > 2400 && grepResult.length <= 4500);

    const globResult = Array.from(
      { length: 90 },
      (_, i) => `src/module_${i % 6}/error_handler_${i}.js`,
    ).join('\n');
    assert.ok(globResult.length > 2400 && globResult.length <= 4500);

    const res1 = await ctrl.admitBatch(
      [
        {
          tc: { id: 'r_errwords', name: 'read_file', arguments: JSON.stringify({ path: 'src/unrelated/errors_catalog.js' }) },
          parsedArgs: { path: 'src/unrelated/errors_catalog.js' },
          output: wrapUntrusted(1, 'read_file', readWithErrorWords),
          isError: false,
        },
        {
          tc: { id: 'g1', name: 'grep', arguments: JSON.stringify({ query: 'AssertionError', path: 'src/errors' }) },
          parsedArgs: { query: 'AssertionError', path: 'src/errors' },
          output: wrapUntrusted(2, 'grep', grepResult),
          isError: false,
        },
        {
          tc: { id: 'gl1', name: 'glob', arguments: JSON.stringify({ pattern: 'src/**/error_*.js' }) },
          parsedArgs: { pattern: 'src/**/error_*.js' },
          output: wrapUntrusted(3, 'glob', globResult),
          isError: false,
        },
      ],
      { query: 'Check handler_0 AssertionError', step: 1 },
    );

    const byId1 = Object.fromEntries(res1.admittedItems.map((it) => [it.tc.id, it]));
    assert.notEqual(byId1.r_errwords.admission.reason, 'error_output');
    assert.notEqual(byId1.g1.admission.reason, 'error_output');
    assert.notEqual(byId1.gl1.admission.reason, 'error_output');
    assert.notEqual(byId1.g1.admission.decision, ADMISSION_DECISIONS.DUPLICATE);

    // Repeat identical grep (and read_file) -> DUPLICATE!
    const res2 = await ctrl.admitBatch(
      [
        {
          tc: { id: 'r_errwords_dup', name: 'read_file', arguments: JSON.stringify({ path: 'src/unrelated/errors_catalog.js' }) },
          parsedArgs: { path: 'src/unrelated/errors_catalog.js' },
          output: wrapUntrusted(4, 'read_file', readWithErrorWords),
          isError: false,
        },
        {
          tc: { id: 'g1_dup', name: 'grep', arguments: JSON.stringify({ path: 'src/errors', query: 'AssertionError' }) },
          parsedArgs: { path: 'src/errors', query: 'AssertionError' },
          output: wrapUntrusted(5, 'grep', grepResult),
          isError: false,
        },
        // Different grep query on same path must NOT collide with g1
        {
          tc: { id: 'g_diff', name: 'grep', arguments: JSON.stringify({ query: 'TypeError', path: 'src/errors' }) },
          parsedArgs: { query: 'TypeError', path: 'src/errors' },
          output: wrapUntrusted(6, 'grep', grepResult.replace(/AssertionError/g, 'TypeError')),
          isError: false,
        },
      ],
      { query: 'Check handler_0 AssertionError', step: 2 },
    );

    const byId2 = Object.fromEntries(res2.admittedItems.map((it) => [it.tc.id, it]));
    assert.equal(byId2.r_errwords_dup.admission.decision, ADMISSION_DECISIONS.DUPLICATE);
    assert.equal(byId2.g1_dup.admission.decision, ADMISSION_DECISIONS.DUPLICATE);
    assert.notEqual(byId2.g_diff.admission.decision, ADMISSION_DECISIONS.DUPLICATE);

    // File mutation clears __probe__:* hashes so identical grep re-runs fresh
    const res3 = await ctrl.admitBatch(
      [
        {
          tc: { id: 'e_any', name: 'edit_file', arguments: JSON.stringify({ path: 'src/errors/handler_0.js' }) },
          parsedArgs: { path: 'src/errors/handler_0.js' },
          output: 'Edited src/errors/handler_0.js',
          isError: false,
        },
        {
          tc: { id: 'g1_post_edit', name: 'grep', arguments: JSON.stringify({ query: 'AssertionError', path: 'src/errors' }) },
          parsedArgs: { query: 'AssertionError', path: 'src/errors' },
          output: wrapUntrusted(7, 'grep', grepResult),
          isError: false,
        },
      ],
      { query: 'Check handler_0 AssertionError', step: 3 },
    );
    assert.notEqual(res3.admittedItems[1].admission.decision, ADMISSION_DECISIONS.DUPLICATE);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('3.2.1 B3: oversized bash / run_diagnostics (>6000 chars) renders <=3200-char fidelity summary preserving tracebacks, head/tail, and lossless restore', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'aci321-b3-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const aciStore = new ReversibleContextStore(store);
    const ctrl = new PreInjectionAdmissionController({ aciStore });

    const pytestLog = [
      '============================= test session starts ==============================',
      'platform linux -- Python 3.11.6, pytest-8.1.1',
      ...Array.from({ length: 25 }, (_, i) => `collecting item ${i}: tests/unit/test_case_${i}.py`),
      ...Array.from({ length: 140 }, (_, i) => `tests/unit/test_ok_${i}.py . [ ${Math.min(99, i)}% ] ok verbose padding payload ${'p'.repeat(45)}`),
      '=================================== FAILURES ===================================',
      '___________________________ test_discount_cap_order ____________________________',
      'Traceback (most recent call last):',
      '  File "src/pricing/calculator.py", line 42, in compute_total',
      '    assert discounted <= max_cap',
      'AssertionError: expected <= 50 but got 65',
      ...Array.from({ length: 35 }, (_, i) => `summary tail line ${i}: collected 141 items, 1 failed`),
      '=========================== short test summary info ============================',
      'FAILED tests/test_pricing.py::test_discount_cap_order - AssertionError: expected <= 50',
      'exitCode: 1',
    ].join('\n');
    assert.ok(pytestLog.length > 6000);

    const passingBuildLog = [
      'Compiling 240 modules...',
      ...Array.from({ length: 180 }, (_, i) => `build step ${i}: compiled module_${i}.js (${'m'.repeat(30)})`),
      'All 240 modules built cleanly.',
      'exitCode: 0',
    ].join('\n');
    assert.ok(passingBuildLog.length > 6000);

    const res = await ctrl.admitBatch(
      [
        {
          tc: { id: 'b_fail', name: 'bash', arguments: JSON.stringify({ command: 'pytest -v' }) },
          parsedArgs: { command: 'pytest -v' },
          output: wrapUntrusted(1, 'bash', pytestLog),
          isError: true,
        },
        {
          tc: { id: 'd_pass', name: 'run_diagnostics', arguments: JSON.stringify({ kind: 'build' }) },
          parsedArgs: { kind: 'build' },
          output: passingBuildLog,
          isError: false,
        },
      ],
      { query: 'Fix test_discount_cap_order failure', step: 1 },
    );

    const byId = Object.fromEntries(res.admittedItems.map((it) => [it.tc.id, it]));
    for (const key of ['b_fail', 'd_pass']) {
      const item = byId[key];
      assert.equal(item.admission.decision, ADMISSION_DECISIONS.SUPPORTING);
      assert.equal(item.admission.reason, 'oversized_exec_log_fidelity_summary');
      assert.ok(item.admittedOutput.length <= 3200, `${key} exceeded 3200 chars: ${item.admittedOutput.length}`);
      assert.match(item.admittedOutput, /^\[ACI-REF artifact:\/\/[0-9a-f]{64}/);
      assert.ok(item.admittedOutput.includes('[expand_context 可按行无损展开]'));
    }

    assert.match(byId.b_fail.admittedOutput, /<untrusted id=/);
    assert.match(byId.b_fail.admittedOutput, /test session starts/);
    assert.match(byId.b_fail.admittedOutput, /Traceback \(most recent call last\)/);
    assert.match(byId.b_fail.admittedOutput, /AssertionError/);
    assert.match(byId.b_fail.admittedOutput, /FAILED tests\/test_pricing\.py/);

    const restored = aciStore.restoreVerified(byId.b_fail.admission.uri);
    assert.equal(restored.verified, true);
    assert.equal(restored.content, pytestLog);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('3.2.1 B4: oversized grep and glob (>4500 chars) emit <=2800-char clustered summary with counts, top matches, and lossless restore', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'aci321-b4-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const aciStore = new ReversibleContextStore(store);
    const ctrl = new PreInjectionAdmissionController({ aciStore });

    const bigGrep = [
      ...Array.from({ length: 45 }, (_, i) => `src/core/router.py:${i + 10}: def route_handler_${i}(req): return dispatch(req)`),
      ...Array.from({ length: 30 }, (_, i) => `src/auth/tokens.py:${i + 20}: def verify_token_${i}(tok): return parse(tok)`),
      ...Array.from({ length: 20 }, (_, i) => `tests/test_router.py:${i + 5}: assert route_handler_${i}(sample) is not None`),
    ].join('\n');
    assert.ok(bigGrep.length > 4500);

    const bigGlob = [
      '找到 150 个匹配文件:',
      ...Array.from({ length: 90 }, (_, i) => `src/services/billing/invoice_worker_${i}.py`),
      ...Array.from({ length: 60 }, (_, i) => `tests/unit/billing/test_invoice_worker_${i}.py`),
    ].join('\n');
    assert.ok(bigGlob.length > 4500);

    const res = await ctrl.admitBatch(
      [
        {
          tc: { id: 'g_big', name: 'grep', arguments: JSON.stringify({ query: 'route_handler' }) },
          parsedArgs: { query: 'route_handler' },
          output: wrapUntrusted(1, 'grep', bigGrep),
          isError: false,
        },
        {
          tc: { id: 'gl_big', name: 'glob', arguments: JSON.stringify({ pattern: '**/*.py' }) },
          parsedArgs: { pattern: '**/*.py' },
          output: bigGlob,
          isError: false,
        },
      ],
      { query: 'Inspect routing', step: 1 },
    );

    const byId = Object.fromEntries(res.admittedItems.map((it) => [it.tc.id, it]));
    assert.equal(byId.g_big.admission.decision, ADMISSION_DECISIONS.SUPPORTING);
    assert.equal(byId.g_big.admission.reason, 'oversized_search_clustered_summary');
    assert.ok(byId.g_big.admittedOutput.length <= 2800, `grep summary was ${byId.g_big.admittedOutput.length}`);
    assert.match(byId.g_big.admittedOutput, /^\[ACI-REF artifact:\/\/[0-9a-f]{64}/);
    assert.match(byId.g_big.admittedOutput, /src\/core\/router\.py \(45 hits\)/);
    assert.match(byId.g_big.admittedOutput, /src\/auth\/tokens\.py \(30 hits\)/);

    assert.equal(byId.gl_big.admission.decision, ADMISSION_DECISIONS.SUPPORTING);
    assert.equal(byId.gl_big.admission.reason, 'oversized_search_clustered_summary');
    assert.ok(byId.gl_big.admittedOutput.length <= 2800, `glob summary was ${byId.gl_big.admittedOutput.length}`);
    assert.match(byId.gl_big.admittedOutput, /^\[ACI-REF artifact:\/\/[0-9a-f]{64}/);
    assert.match(byId.gl_big.admittedOutput, /src\/services \(90 files\)/);

    const restoredGrep = aciStore.restoreVerified(byId.g_big.admission.uri);
    assert.equal(restoredGrep.verified, true);
    assert.equal(restoredGrep.content, bigGrep);

    // Repeating identical oversized grep -> DUPLICATE!
    const resDup = await ctrl.admitBatch(
      [
        {
          tc: { id: 'g_big_dup', name: 'grep', arguments: JSON.stringify({ query: 'route_handler' }) },
          parsedArgs: { query: 'route_handler' },
          output: wrapUntrusted(2, 'grep', bigGrep),
          isError: false,
        },
      ],
      { query: 'Inspect routing', step: 2 },
    );
    assert.equal(resDup.admittedItems[0].admission.decision, ADMISSION_DECISIONS.DUPLICATE);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('3.2.1 Supervisor auto-skip (reasoning/v4/mainModel) and minSupervisorBatchChars=16000 gating', async () => {
  assert.equal(DEFAULT_MIN_SUPERVISOR_BATCH_CHARS, 16000);
  const storeDir = mkdtempSync(join(tmpdir(), 'aci321-sup-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const pool = new AccountPool(store, { root: storeDir });
    pool.createAccount({
      preset: 'deepseek',
      label: 'DS',
      credential: 'sk-test-321-sup',
      models: ['deepseek-v4', 'deepseek-reasoner', 'deepseek-chat'],
    });
    pool.setDefaultModel('deepseek-v4');

    let supCalls = 0;
    const sup = new ContextSupervisor({
      store,
      pool,
      adapter: {
        async *stream() {
          supCalls += 1;
          yield { type: 'text-delta', text: JSON.stringify({ decisions: [], contractHints: [] }) };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      },
    });

    // 1) deepseek-v4 auto-skips in auto mode
    const rV4 = sup.resolveModel(null, { mainModel: 'deepseek-v4' });
    assert.equal(rV4.active, false);
    assert.equal(rV4.effectiveModel, null);
    assert.equal(rV4.rationale, 'auto_skip_same_or_reasoning_model_deterministic');

    // 2) deepseek-reasoner auto-skips even without mainModel
    pool.setDefaultModel('deepseek-reasoner');
    const rReasoner = sup.resolveModel();
    assert.equal(rReasoner.active, false);
    assert.equal(rReasoner.rationale, 'auto_skip_same_or_reasoning_model_deterministic');

    // 3) Same mainModel auto-skips even for deepseek-chat
    pool.setDefaultModel('deepseek-chat');
    const rSameMain = sup.resolveModel({ mainModel: 'deepseek-chat' });
    assert.equal(rSameMain.active, false);
    assert.equal(rSameMain.rationale, 'auto_skip_same_or_reasoning_model_deterministic');

    // 4) Adding gpt-4o-mini picks gpt-4o-mini when mainModel is deepseek-chat
    pool.addManualModel({ upstreamModel: 'gpt-4o-mini' });
    const rFast = sup.resolveModel(null, { mainModel: 'deepseek-chat' });
    assert.equal(rFast.active, true);
    assert.equal(rFast.effectiveModel, 'gpt-4o-mini');

    // 5) minSupervisorBatchChars = 16000 gates ambiguousQueue in default/full_aci mode
    const aciStore = new ReversibleContextStore(store);
    const ctrl = new PreInjectionAdmissionController({ aciStore });
    const mediumRead = Array.from({ length: 120 }, (_, i) => `export function sec_${i}(x) { return x + ${i}; }`).join('\n'); // ~6k chars (<16k)
    const decoyRead = '// DO NOT EDIT - ARCHIVED DECOY\n' + Array.from({ length: 100 }, (_, i) => `export function old_${i}() { return ${i}; }`).join('\n');
    assert.ok(mediumRead.length > 2600 && mediumRead.length < 16000);
    assert.ok(decoyRead.length < 10000);

    // Notice read_file <= 42k is explicit_read_working_set unless decoy or >42k;
    // use workingSetReadMaxChars: 42000 with >42k or decoy conflict, OR explicit huge 43k read + small ambiguous decoy!
    const huge43kA = Array.from({ length: 440 }, (_, i) => `export function modA_${i}(v) { return v + "${'a'.repeat(65)}"; }`).join('\n');
    assert.ok(huge43kA.length > 42000);

    // Batch with ~6k ambiguous decoy (<16k) -> skips supervisor!
    const smallAmbRes = await ctrl.admitBatch(
      [
        {
          tc: { id: 'dec1', name: 'read_file', arguments: JSON.stringify({ path: 'src/legacy/auth_old.js' }) },
          parsedArgs: { path: 'src/legacy/auth_old.js' },
          output: decoyRead,
          isError: false,
        },
      ],
      { query: 'Check auth_old', step: 1, supervisor: sup, supervisorEnabled: true, mainModel: 'deepseek-chat' },
    );
    assert.equal(supCalls, 0, 'Must skip supervisor when ambiguousQueue chars < 16000');
    assert.equal(smallAmbRes.admittedItems[0].admission.decision, ADMISSION_DECISIONS.IRRELEVANT);

    // Batch with >42k ambiguous file (>=16k) -> invokes supervisor once!
    await ctrl.admitBatch(
      [
        {
          tc: { id: 'huge1', name: 'read_file', arguments: JSON.stringify({ path: 'src/huge_mod.js' }) },
          parsedArgs: { path: 'src/huge_mod.js' },
          output: huge43kA,
          isError: false,
        },
      ],
      { query: 'Check modA_1', step: 2, supervisor: sup, supervisorEnabled: true, mainModel: 'deepseek-chat' },
    );
    assert.equal(supCalls, 1, 'Must invoke supervisor when ambiguousQueue chars >= 16000');
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});

test('3.2.1 cache_aware_v31: adaptive DP k* abolishes default 48k wall while honoring explicit dtocMinPromptTokens opt-in and cache-rate amortization', () => {
  assert.equal(DEFAULT_V31_MIN_PROMPT_TOKENS, 48000);
  const storeDir = mkdtempSync(join(tmpdir(), 'aci321-v31-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();
    const engine = new ACIEngine({
      store,
      aciStore,
      ledger,
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
      maxTotalTokens: 400000,
      contextWindow: 128000,
    });

    const mkBlock = (prefix, lines) =>
      Array.from({ length: lines }, (_, i) => `export function ${prefix}_${i}(v) { return v + ${i} + "${'k'.repeat(50)}"; }`).join('\n');

    // 1) ~40k prompt tokens (<48k): default cache_aware_v31 triggers adaptively (no static 48k wall),
    // while explicit dtocMinPromptTokens=48000 opt-in still enforces append_only_cache_floor_v31.
    const msgs40k = [
      { role: 'user', content: [{ type: 'text', text: 'Update modules' }] },
      ...makeToolStep('h1', 'read_file', { path: 'README.md' }, 'Intro\n'.repeat(20), { step: 1 }),
      ...makeToolStep('c1', 'read_file', { path: 'src/old1.js' }, mkBlock('oldOne', 550), { step: 2 }),
      ...makeToolStep('c2', 'read_file', { path: 'src/old2.js' }, mkBlock('oldTwo', 550), { step: 3 }),
      ...makeToolStep('e1', 'edit_file', { path: 'src/old1.js' }, 'Edited', { step: 5 }),
      ...makeToolStep('r1', 'read_file', { path: 'src/live.js' }, mkBlock('liveMod', 200), { step: 8 }),
    ];
    const tok40k = measureRequestComposition({ messages: msgs40k }).totalTokens;
    assert.ok(tok40k >= 32000 && tok40k < 48000, `Expected 32k..48k tokens, got ${tok40k}`);
    const adaptiveBelow48k = engine.inspectEpoch(msgs40k, { currentStep: 8 });
    assert.equal(adaptiveBelow48k.triggered, true);
    assert.equal(adaptiveBelow48k.reason, CACHE_AWARE_V31_DTOC_POLICY);
    assert.ok(adaptiveBelow48k.optimalSplitIndex >= 0);

    const floorOptInEngine = new ACIEngine({
      store,
      aciStore: new ReversibleContextStore(store),
      ledger: new ContextEvidenceLedger(),
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
      dtocMinPromptTokens: DEFAULT_V31_MIN_PROMPT_TOKENS,
      maxTotalTokens: 400000,
      contextWindow: 128000,
    });
    const floorRes = floorOptInEngine.inspectEpoch(msgs40k, { currentStep: 8 });
    assert.equal(floorRes.triggered, false);
    assert.equal(floorRes.reason, 'append_only_cache_floor_v31');

    // 2) ~54k tokens with ~7.7k candidate savings before huge ~42k shielded suffix:
    // default horizon (4 * 7.7k <= 0.6 * 54k) and hot cache (rho=0.95) abstain;
    // high horizon + cold cache (rho=0) clears 14% adaptive floor & DP inequalities!
    const msgsLowAmort = [
      { role: 'user', content: [{ type: 'text', text: 'Update modules' }] },
      ...makeToolStep('h2', 'read_file', { path: 'README.md' }, 'Intro\n'.repeat(20), { step: 1 }),
      ...makeToolStep('c_small_aged', 'read_file', { path: 'src/small_aged.js' }, mkBlock('smallAged', 290), { step: 2 }), // ~7.7k tok savings (between 14% adaptive floor and 15% H=4 breakeven)
      ...makeToolStep('s_spec', 'read_file', { path: 'SPEC.md' }, '# SPEC\n' + 'Contract rule line.\n'.repeat(8500), { step: 4 }), // huge shielded suffix (~42k tok)
      ...makeToolStep('r_tail', 'read_file', { path: 'src/tail.js' }, mkBlock('tailLive', 120), { step: 9 }),
    ];
    const tokAmort = measureRequestComposition({ messages: msgsLowAmort }).totalTokens;
    assert.ok(tokAmort >= 48000 && tokAmort < 128000 * 0.80, `Expected 48k..102k tokens, got ${tokAmort}`);
    const amortBlocked = engine.inspectEpoch(msgsLowAmort, { currentStep: 9, contractFiles: ['SPEC.md'] });
    assert.ok(amortBlocked.combinedNetSavingsTokens >= 3500, `Expected >= 3500 savings, got ${amortBlocked.combinedNetSavingsTokens}`);
    assert.equal(amortBlocked.netSavingsMet, false);
    assert.equal(amortBlocked.triggered, false);
    assert.equal(amortBlocked.reason, 'insufficient_net_savings');

    const hotCacheBlocked = engine.inspectEpoch(msgsLowAmort, {
      currentStep: 9,
      contractFiles: ['SPEC.md'],
      estHorizon: 8,
      observedCacheHitRate: 0.95,
    });
    assert.equal(hotCacheBlocked.triggered, false);
    assert.equal(hotCacheBlocked.reason, 'insufficient_net_savings');

    const coldCacheAllowed = engine.inspectEpoch(msgsLowAmort, {
      currentStep: 9,
      contractFiles: ['SPEC.md'],
      estHorizon: 8,
      observedCacheHitRate: 0,
    });
    assert.equal(coldCacheAllowed.netSavingsMet, true);
    assert.equal(coldCacheAllowed.triggered, true);
    assert.equal(coldCacheAllowed.reason, CACHE_AWARE_V31_DTOC_POLICY);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }
});
