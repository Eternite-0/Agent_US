import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import esbuild from 'esbuild';
const require = createRequire(import.meta.url);
import {
  buildDiffPresentation,
  computeDiff,
  encodeUtf8Base64,
  extractDiffHunks,
  foldDiffLines,
  foldSplitDiffRows,
  isReducedMotionPreferred,
  scrollIntoViewSafe,
  stepHunkIndex,
} from '../src/utils/diff.ts';
import {
  collectBundleDiagnostics,
  parseDiagnosticsForDisplay,
  resolveMatchingFilePath,
} from '../src/utils/diagnostics.ts';
import {
  extractTurnAciTelemetry,
  formatAciAblationLatexFallback,
  normalizeAciAblationSummary,
} from '../src/utils/aciTelemetry.ts';
import { LiveBackendClient } from '../src/api/client.ts';
import { createThreadInteraction } from '../src/utils/threadInteraction.ts';

async function compileTsxModule(entryRelPath) {
  const outDir = await mkdtemp(join(tmpdir(), 'agent-us-ux26-'));
  const outfile = join(outDir, 'bundle.mjs');
  const entryPath = new URL(`../${entryRelPath}`, import.meta.url);
  const absEntry = decodeURIComponent(entryPath.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  await esbuild.build({
    entryPoints: [absEntry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    plugins: [
      {
        name: 'resolve-react-and-stub-css',
        setup(build) {
          build.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({
            path: pathToFileURL(require.resolve(args.path)).href,
            external: true,
          }));
          build.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'stub-css' }));
          build.onLoad({ filter: /.*/, namespace: 'stub-css' }, () => ({ contents: '', loader: 'js' }));
        },
      },
    ],
  });
  const mod = await import(pathToFileURL(outfile).href);
  return {
    mod,
    cleanup: () => rm(outDir, { recursive: true, force: true }),
  };
}

test('foldDiffLines & foldSplitDiffRows fold > 6 unchanged context lines and support expand + revealLine', () => {
  const beforeLines = Array.from({ length: 20 }, (_, i) => `const line_${i + 1} = ${i + 1};`);
  const afterLines = [...beforeLines];
  afterLines[1] = 'const line_2 = 200;';
  afterLines[17] = 'const line_18 = 1800;';

  const { lines } = computeDiff(beforeLines.join('\n'), afterLines.join('\n'));
  const folded = foldDiffLines(lines);
  const foldEntries = folded.filter((e) => e.kind === 'fold');
  assert.equal(foldEntries.length, 1);
  // Lines 3..17 are 15 unchanged context lines: keep 3 leading + 3 trailing => fold 9 lines
  assert.equal(foldEntries[0].count, 9);

  // Expanding by fold id restores all lines
  const expanded = foldDiffLines(lines, new Set([foldEntries[0].id]));
  assert.equal(expanded.filter((e) => e.kind === 'fold').length, 0);
  assert.equal(expanded.length, lines.length);

  // revealLine inside the folded range auto-expands it
  const revealed = foldDiffLines(lines, new Set(), { revealLine: 10 });
  assert.equal(revealed.filter((e) => e.kind === 'fold').length, 0);

  // Boundary: <= 6 unchanged context lines stay unfolded
  const shortBefore = Array.from({ length: 10 }, (_, i) => `x${i + 1}`).join('\n');
  const shortAfter = shortBefore.replace('x2', 'x2_new').replace('x9', 'x9_new');
  const shortDiff = computeDiff(shortBefore, shortAfter);
  assert.equal(foldDiffLines(shortDiff.lines).filter((e) => e.kind === 'fold').length, 0);

  // Split diff rows fold identically
  const { splitRows } = buildDiffPresentation(lines);
  const foldedSplit = foldSplitDiffRows(splitRows);
  assert.equal(foldedSplit.filter((e) => e.kind === 'fold').length, 1);
  assert.equal(foldedSplit.filter((e) => e.kind === 'fold')[0].count, 9);
});

test('extractDiffHunks, stepHunkIndex, and scrollIntoViewSafe respect reduced motion', () => {
  const a = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10'].join('\n');
  const b = ['a1', 'b2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'b9', 'a10'].join('\n');
  const { lines } = computeDiff(a, b);
  const hunks = extractDiffHunks(lines);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].newLine, 2);
  assert.equal(hunks[1].newLine, 9);
  assert.equal(stepHunkIndex(0, 1, 2), 1);
  assert.equal(stepHunkIndex(1, 1, 2), 0);
  assert.equal(stepHunkIndex(0, -1, 2), 1);

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  try {
    const calls = [];
    const el = { scrollIntoView(opts) { calls.push(opts); } };
    globalThis.document = { documentElement: { getAttribute: (k) => (k === 'data-reduced-motion' ? 'true' : null) } };
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    assert.equal(isReducedMotionPreferred(), true);
    scrollIntoViewSafe(el, 'center');
    assert.equal(calls.at(-1).behavior, 'auto');

    globalThis.document = { documentElement: { getAttribute: () => 'false' } };
    scrollIntoViewSafe(el, 'center');
    assert.equal(calls.at(-1).behavior, 'smooth');
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});

test('parseDiagnosticsForDisplay extracts run_diagnostics JSON, expected/actual, and file:line(:col) entries', () => {
  const payload = {
    ok: false,
    kind: 'auto',
    diagnostics: [
      { file: 'src/math.ts', line: 14, column: 5, severity: 'error', code: 'TS2322', message: "Type 'string' is not assignable to type 'number'", source: 'tsc' },
      { file: 'test/math.test.js', line: 22, column: 10, severity: 'error', code: 'ERR_ASSERTION', message: 'Expected values to be equal', source: 'node-test', testName: 'adds numbers', expected: '5', actual: '4', operator: 'strictEqual' },
    ],
    failingTests: [
      { name: 'adds numbers', testName: 'adds numbers', file: 'test/math.test.js', line: 22, column: 10, assertion: 'Expected 5, got 4', expected: '5', actual: '4', operator: 'strictEqual' },
    ],
    compression: { rawLines: 320, keptLines: 3, truncatedCount: 317 },
  };
  const output = `[run_diagnostics kind=auto ok=false] tsc(errors), test(fail)\n- src/math.ts:14:5 [error TS2322] Type 'string' is not assignable to type 'number'\n\n${JSON.stringify(payload)}`;
  const parsed = parseDiagnosticsForDisplay('run_diagnostics', output);
  assert.ok(parsed);
  assert.equal(parsed.diagnostics.length, 2);
  assert.equal(parsed.diagnostics[0].file, 'src/math.ts');
  assert.equal(parsed.diagnostics[0].line, 14);
  assert.equal(parsed.failingTests.length, 1);
  assert.equal(parsed.failingTests[0].expected, '5');
  assert.equal(parsed.failingTests[0].actual, '4');
  assert.equal(parsed.failingTests[0].line, 22);

  // Path normalization matching
  assert.equal(resolveMatchingFilePath('./src/math.ts', ['src/math.ts', 'src/other.ts']), 'src/math.ts');
  assert.equal(resolveMatchingFilePath('workspace/repo/src/math.ts', ['src/math.ts']), 'src/math.ts');

  // Failed bash command plain file:line:col extraction
  const bashParsed = parseDiagnosticsForDisplay('bash', 'src/index.ts:8:3: ReferenceError: x is not defined', { status: 'failed' });
  assert.ok(bashParsed);
  assert.equal(bashParsed.diagnostics[0].file, 'src/index.ts');
  assert.equal(bashParsed.diagnostics[0].line, 8);

  // Passing non-diagnostics bash output is untouched
  assert.equal(parseDiagnosticsForDisplay('bash', '✓ auth/session.test.ts · scenario 01: verified', { status: 'completed' }), null);
});

test('extractTurnAciTelemetry returns null when absent and parses 2.6 telemetry when present', () => {
  assert.equal(extractTurnAciTelemetry([
    { seq: 1, timestamp: 1000, type: 'turn/started', projectId: null, taskId: 's1', payload: { turnId: 't1' } },
    { seq: 2, timestamp: 2000, type: 'turn/completed', projectId: null, taskId: 's1', payload: { turnId: 't1', durationMs: 1000 } },
  ]), null);

  const telemetry = extractTurnAciTelemetry([
    {
      seq: 3,
      timestamp: 3000,
      type: 'turn/completed',
      projectId: null,
      taskId: 's1',
      payload: {
        turnId: 't1',
        budgetWatermarks: {
          usedTokens: 48_000,
          maxTokens: 200_000,
          ratio: 0.24,
          projectedTotalTokens: 162_000,
          dtocWatermark: 0.78,
          postTestReserveActive: true,
          supervisorCircuitOpen: false,
        },
        aciTelemetry: {
          aciProfile: 'full_aci',
          dtocPolicy: 'trajectory_eviction_v26',
          decisions: { DIRECT: 4, SUPPORTING: 2, DEFER: 1, DUPLICATE: 1, IRRELEVANT: 3 },
          partialRecoveries: 2,
          fullRecoveries: 1,
          recoveryTokensSaved: 3600,
          supersededEvictions: 3,
          supersededTokensSaved: 5400,
          trajectoryTriggeredEpochs: 1,
          supervisorCircuitOpen: false,
        },
      },
    },
  ], 't1');

  assert.ok(telemetry);
  assert.equal(telemetry.dtocPolicy, 'trajectory_eviction_v26');
  assert.equal(telemetry.admissionDecisions.DIRECT, 4);
  assert.equal(telemetry.admissionDecisions.IRRELEVANT, 3);
  assert.equal(telemetry.partialRecoveries, 2);
  assert.equal(telemetry.fullRecoveries, 1);
  assert.equal(telemetry.recoveryTokensSaved, 3600);
  assert.equal(telemetry.supersededEvictions, 3);
  assert.equal(telemetry.supersededTokensSaved, 5400);
  assert.equal(telemetry.budgetWatermarks?.projectedTotalTokens, 162_000);
  assert.equal(telemetry.budgetWatermarks?.postTestReserveActive, true);
});

test('LiveBackendClient.getAciAblationSummary handles 200 summary, { available: false }, and 404 gracefully', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.match(String(url), /\/v1\/evaluations\/aci-ablation$/);
      return new Response(JSON.stringify({ available: false }), { status: 200 });
    };
    const client = new LiveBackendClient({ baseUrl: 'http://127.0.0.1:9999', token: 'tok' });
    assert.deepEqual(await client.getAciAblationSummary(), { available: false });

    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
    assert.deepEqual(await client.getAciAblationSummary(), { available: false });

    const samplePayload = {
      available: true,
      suite: 'aci26',
      model: 'mock-model',
      armOrder: ['A', 'C', 'D'],
      summaryByArm: {
        A: { arm: 'A', aciProfile: 'raw_full', passedTrials: 5, totalTrials: 14, passRateCI: { rate: 0.3571, lower: 0.1634, upper: 0.6124 }, pairedPassTokenReduction: 0, pairedPassCount: 5, tokensPerCompletedPass: 84000, cacheHitRate: 0.41, supervisorCost: { totalTokens: 0 } },
        C: { arm: 'C', aciProfile: 'retrieval_supervisor', passedTrials: 7, totalTrials: 14, passRateCI: { rate: 0.5, lower: 0.268, upper: 0.732 }, pairedPassTokenReduction: 0.14, pairedPassCount: 4, tokensPerCompletedPass: 68000, cacheHitRate: 0.62, supervisorCost: { totalTokens: 4200 } },
        D: { arm: 'D', aciProfile: 'trajectory_eviction_v26', passedTrials: 11, totalTrials: 14, passRateCI: { rate: 0.7857, lower: 0.5241, upper: 0.9243 }, pairedPassTokenReduction: 0.365, pairedPassCount: 5, tokensPerCompletedPass: 41200, cacheHitRate: 0.81, supervisorCost: { totalTokens: 6100 } },
      },
      latexTable: '\\begin{table}...\n\\end{table}\n',
    };
    globalThis.fetch = async () => new Response(JSON.stringify(samplePayload), { status: 200 });
    const parsed = await client.getAciAblationSummary();
    assert.equal(parsed.available, true);
    assert.deepEqual(parsed.armOrder, ['A', 'C', 'D']);
    assert.equal(parsed.summaryByArm?.D.pairedPassTokenReduction, 0.365);
    assert.equal(parsed.summaryByArm?.A.supervisorCost.totalTokens, 0);

    const normalizedNoTex = normalizeAciAblationSummary({ ...samplePayload, latexTable: undefined });
    const fallbackTex = formatAciAblationLatexFallback(normalizedNoTex);
    assert.match(fallbackTex, /\\begin\{table\}/);
    assert.match(fallbackTex, /36\.5\\% \(n=5\)/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('React SSR renders FileChangeCard context folding, InspectorDrawer diagnostics/hunks, ThreadView ACI telemetry, AdaptiveContextPanel, and EvaluationView A/C/D table', async () => {
  const [fcMod, idMod, tvMod, acpMod, evMod] = await Promise.all([
    compileTsxModule('src/components/FileChangeCard.tsx'),
    compileTsxModule('src/components/InspectorDrawer.tsx'),
    compileTsxModule('src/components/ThreadView.tsx'),
    compileTsxModule('src/components/AdaptiveContextPanel.tsx'),
    compileTsxModule('src/components/EvaluationView.tsx'),
  ]);

  try {
    const before = Array.from({ length: 18 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n');
    const after = before.replace('const v2 = 2;', 'const v2 = 20;').replace('const v17 = 17;', 'const v17 = 170;');
    const { lines } = computeDiff(before, after);
    const diffEntry = {
      path: 'src/sample.ts',
      added: 2,
      deleted: 2,
      isNew: false,
      isDeleted: false,
      beforeText: before,
      afterText: after,
      lines,
      sha256After: '1234567890abcdef',
    };

    const fcHtml = renderToStaticMarkup(
      React.createElement(fcMod.mod.InlineDiff, {
        lines,
      }),
    );
    assert.match(fcHtml, /展开 8 行上下文/);

    const diagJson = JSON.stringify({
      ok: false,
      kind: 'auto',
      diagnostics: [{ file: 'src/sample.ts', line: 2, column: 7, severity: 'error', code: 'TS2322', message: 'Bad type', source: 'tsc' }],
      failingTests: [{ name: 'sample test', testName: 'sample test', file: 'src/sample.ts', line: 17, assertion: 'mismatch', expected: '17', actual: '170' }],
    });
    const bundle = {
      task: {
        id: 'sess-ux26',
        version: 1,
        projectId: 'workspace',
        taskId: null,
        input: 'Check diagnostics and ACI 2.6',
        status: 'completed',
        createdAt: 1700000000000,
      },
      assignments: [],
      workers: [],
      sessions: [{ id: 'sess-ux26', version: 1, projectId: 'workspace', taskId: 'sess-ux26', workerId: 'sess-ux26', assignmentId: 'direct', role: 'Coder', status: 'done' }],
      histories: {
        'sess-ux26': [
          { cursor: 1, sessionId: 'sess-ux26', turnId: 't-26', type: 'user/message', sequence: 1, text: 'Run diagnostics' },
          { cursor: 2, sessionId: 'sess-ux26', turnId: 't-26', type: 'assistant/message', sequence: 2, text: '', toolCalls: [{ id: 'c1', name: 'run_diagnostics', arguments: { paths: ['src/sample.ts'] } }] },
          { cursor: 3, sessionId: 'sess-ux26', turnId: 't-26', type: 'tool/result', sequence: 3, name: 'run_diagnostics', callId: 'c1', text: `[run_diagnostics kind=auto ok=false]\n\n${diagJson}`, meta: { isError: true } },
          { cursor: 4, sessionId: 'sess-ux26', turnId: 't-26', type: 'assistant/message', sequence: 4, text: 'Completed check.' },
        ],
      },
      approvals: [],
      evidence: [
        {
          id: 'c0',
          version: 1,
          projectId: 'workspace',
          taskId: 'sess-ux26',
          status: 'finished',
          tool: 'apply_patch',
          workerId: 'sess-ux26',
          assignmentId: 'direct',
          digest: '1',
          changes: [{ path: 'src/sample.ts', before: encodeUtf8Base64(before), after: encodeUtf8Base64(after) }],
        },
      ],
      artifacts: [],
      usage: [],
      events: [
        { seq: 1, timestamp: 1700000001000, type: 'turn/started', projectId: null, taskId: 'sess-ux26', payload: { turnId: 't-26' } },
        {
          seq: 2,
          timestamp: 1700000002000,
          type: 'turn/completed',
          projectId: null,
          taskId: 'sess-ux26',
          payload: {
            turnId: 't-26',
            durationMs: 1000,
            budgetWatermarks: { usedTokens: 42000, maxTokens: 200000, projectedTotalTokens: 150000, dtocWatermark: 0.78, postTestReserveActive: false, supervisorCircuitOpen: false },
            aciTelemetry: {
              aciProfile: 'full_aci',
              dtocPolicy: 'trajectory_eviction_v26',
              decisions: { DIRECT: 3, SUPPORTING: 2, DEFER: 1, DUPLICATE: 0, IRRELEVANT: 2 },
              partialRecoveries: 2,
              fullRecoveries: 0,
              recoveryTokensSaved: 2400,
              supersededEvictions: 4,
              supersededTokensSaved: 6800,
              supervisorCircuitOpen: false,
            },
          },
        },
      ],
    };

    const collected = collectBundleDiagnostics(bundle);
    assert.equal(collected.diagnostics.length, 1);
    assert.equal(collected.failingTests.length, 1);

    // InspectorDrawer in diff mode shows selected line & diagnostics
    const drawerHtml = renderToStaticMarkup(
      React.createElement(idMod.mod.InspectorDrawer, {
        open: true,
        width: 520,
        tab: 'diff',
        selectedFile: 'src/sample.ts',
        selectedLine: 2,
        selectedSubagentId: null,
        bundle,
        client: {},
        sessionId: 'sess-ux26',
        onResize: () => {},
        onChangeTab: () => {},
        onSelectFile: () => {},
        onSelectSubagent: () => {},
        onClose: () => {},
        onToast: () => {},
      }),
    );
    assert.match(drawerHtml, /src\/sample\.ts:2:7/);
    assert.match(drawerHtml, /预期:/);
    assert.match(drawerHtml, /实际:/);
    assert.match(drawerHtml, /data-selected="true"/);

    // InspectorDrawer in diff mode shows data-active-hunk, Prev/Next hunk buttons, and fold button
    const drawerDiffHtml = renderToStaticMarkup(
      React.createElement(idMod.mod.InspectorDrawer, {
        open: true,
        width: 520,
        tab: 'diff',
        selectedFile: 'src/sample.ts',
        selectedLine: null,
        selectedSubagentId: null,
        bundle,
        client: {},
        sessionId: 'sess-ux26',
        onResize: () => {},
        onChangeTab: () => {},
        onSelectFile: () => {},
        onSelectSubagent: () => {},
        onClose: () => {},
        onToast: () => {},
      }),
    );
    assert.match(drawerDiffHtml, /data-active-hunk="1"/);
    assert.match(drawerDiffHtml, /上一个变更块/);
    assert.match(drawerDiffHtml, /下一个变更块/);
    assert.match(drawerDiffHtml, /展开 8 行上下文/);

    // ThreadView renders ACI 2.6 telemetry when present and omits it when absent
    const tvHtmlWithAci = renderToStaticMarkup(
      React.createElement(tvMod.mod.ThreadView, {
        interaction: createThreadInteraction(),
        bundles: [bundle],
        loading: false,
        codexMode: 'Codex',
        projects: [],
        selectedProject: null,
        models: [],
        selectedModel: 'mock',
        effort: 'medium',
        permissionMode: 'auto-safe',
        mentionFiles: [],
        submitting: false,
        inspectorOpen: false,
        inspectorTab: 'subagents',
        decidingApprovalId: null,
        routerReady: true,
        isLiveBackend: true,
        onSelectProject: () => {},
        onOpenCreateProject: () => {},
        onSelectModel: () => {},
        onChangeEffort: () => {},
        onChangePermission: () => {},
        onSlashCommand: () => {},
        onSubmitGoal: async () => true,
        onSubmitFollowup: async () => true,
        onControlTask: async () => {},
        archiving: false,
        onToggleArchive: () => {},
        onDecideApproval: async () => {},
        onOpenInspector: () => {},
        onOpenSubagent: () => {},
        onToggleInspector: () => {},
        onClearFocusWorker: () => {},
        onFocusWorker: () => {},
        onOpenSettings: () => {},
        onToast: () => {},
      }),
    );
    assert.match(tvHtmlWithAci, /DIRECT 3/);
    assert.match(tvHtmlWithAci, /局部恢复 2 次 · 省 2\.4k tok/);
    assert.match(tvHtmlWithAci, /过期驱逐 4 次 · 省 6\.8k tok/);
    assert.match(tvHtmlWithAci, /Supervisor 正常/);
    assert.match(tvHtmlWithAci, /src\/sample\.ts:2:7/);
    assert.match(tvHtmlWithAci, /预期:/);
    assert.match(tvHtmlWithAci, /实际:/);
    assert.doesNotMatch(tvHtmlWithAci, /已验证|已通过验证/);

    const bundleWithoutAci = {
      ...bundle,
      events: [
        { seq: 1, timestamp: 1700000001000, type: 'turn/started', projectId: null, taskId: 'sess-ux26', payload: { turnId: 't-26' } },
        { seq: 2, timestamp: 1700000002000, type: 'turn/completed', projectId: null, taskId: 'sess-ux26', payload: { turnId: 't-26', durationMs: 1000 } },
      ],
    };
    const tvHtmlNoAci = renderToStaticMarkup(
      React.createElement(tvMod.mod.ThreadView, {
        interaction: createThreadInteraction(),
        bundles: [bundleWithoutAci],
        loading: false,
        codexMode: 'Codex',
        projects: [],
        selectedProject: null,
        models: [],
        selectedModel: 'mock',
        effort: 'medium',
        permissionMode: 'auto-safe',
        mentionFiles: [],
        submitting: false,
        inspectorOpen: false,
        inspectorTab: 'subagents',
        decidingApprovalId: null,
        routerReady: true,
        isLiveBackend: true,
        onSelectProject: () => {},
        onOpenCreateProject: () => {},
        onSelectModel: () => {},
        onChangeEffort: () => {},
        onChangePermission: () => {},
        onSlashCommand: () => {},
        onSubmitGoal: async () => true,
        onSubmitFollowup: async () => true,
        onControlTask: async () => {},
        archiving: false,
        onToggleArchive: () => {},
        onDecideApproval: async () => {},
        onOpenInspector: () => {},
        onOpenSubagent: () => {},
        onToggleInspector: () => {},
        onClearFocusWorker: () => {},
        onFocusWorker: () => {},
        onOpenSettings: () => {},
        onToast: () => {},
      }),
    );
    assert.doesNotMatch(tvHtmlNoAci, /codex-aci-telemetry/);

    // AdaptiveContextPanel renders safely without crashing
    const acpHtml = renderToStaticMarkup(
      React.createElement(acpMod.mod.AdaptiveContextPanel, {
        client: {},
        onToast: () => {},
      }),
    );
    assert.match(acpHtml, /自适应上下文/);

    // EvaluationView renders without crashing when getAciAblationSummary is present
    const evHtml = renderToStaticMarkup(
      React.createElement(evMod.mod.EvaluationView, {
        client: {
          isDemo: false,
          listBenchmarks: async () => [],
          listEvaluationRuns: async () => [],
          getAciAblationSummary: async () => ({ available: false }),
        },
        models: [],
        onToast: () => {},
      }),
    );
    assert.match(evHtml, /ACI A\/C\/D 消融对照/);
  } finally {
    await Promise.all([
      fcMod.cleanup(),
      idMod.cleanup(),
      tvMod.cleanup(),
      acpMod.cleanup(),
      evMod.cleanup(),
    ]);
  }
});
