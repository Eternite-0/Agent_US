import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import {
  ACIEngine,
  PHASE_WATERMARK_V25_DTOC_POLICY,
  TRAJECTORY_EVICTION_V26_DTOC_POLICY,
  TRAJECTORY_EVICTION_V26_EPOCH_WATERMARKS,
} from '../src/context/aci-engine.js';
import {
  ContextEvidenceLedger,
  ReversibleContextStore,
} from '../src/context/aci-store.js';
import { AgentCapabilityRegistry } from '../src/swarm/capabilities.js';
import { EvaluationService } from '../src/evaluation/service.js';
import { registerIntelligenceRoutes } from '../src/routes/intelligence-routes.js';
import {
  ACI_GOVERNANCE_26_TASK_IDS,
  createAciGovernanceDataset,
} from '../src/evaluation/aci-governance-benchmark.js';
import {
  DockerBenchmarkSandbox,
  SANDBOX_MODES,
} from '../src/tools/benchmark-sandbox.js';
import {
  isAciSupervisorWireRequest,
  mergeSupervisorCostTelemetry,
  parseAciCliArgs,
  probeAciRuntimeCapabilities,
  runAciGovernanceBenchmark,
} from '../scripts/benchmark-aci-governance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_TSC_JS = resolve(__dirname, '../node_modules/typescript/bin/tsc');

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }

  async *stream(options) {
    const idx = this.calls.length;
    this.calls.push({
      model: options.model,
      system: options.system,
      tools: Array.isArray(options.tools) ? options.tools.map((x) => x.name) : [],
      messages: structuredClone(options.messages ?? []),
    });
    yield* this.handler(options, idx);
  }
}

async function waitTurnDone(directAgent, sessionId, turnId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const turn = directAgent.listTurns(sessionId).find((item) => item.id === turnId);
    if (turn && ['completed', 'failed', 'cancelled'].includes(turn.state)) return turn;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for turn ${turnId}`);
}

function initGitWorkspace(workDir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(workDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  execFileSync('git', ['init'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'e2e26@example.test'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'E2E 2.6 Verifier'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.filemode', 'false'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: workDir, stdio: 'ignore' });
}

function makeLargeModule(prefix, count = 40, targetSymbol = null) {
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
      `export function ${prefix}Helper${i}_${w1}_${w2}(val, factor = ${(i % 7) + 1}) { return String(val ?? '${w3}') + ':${prefix}:${w1}:${w2}' + String(factor); }`,
    );
  }
  if (targetSymbol) {
    lines.push(
      '',
      `export function ${targetSymbol}(amount, tier = 'gold') {`,
      `  const base = Number(amount ?? 0);`,
      `  const rate = tier === 'gold' ? 0.2 : 0.1;`,
      `  return Math.round(base * (1 - rate) * 100) / 100;`,
      `}`,
      '',
    );
  }
  return lines.join('\n');
}

function extractDiagJson(text) {
  const start = String(text ?? '').indexOf('{"ok":');
  assert.ok(start !== -1, `Expected run_diagnostics JSON payload in:\n${text}`);
  const end = String(text ?? '').lastIndexOf('}');
  return JSON.parse(String(text ?? '').slice(start, end + 1));
}

function makeToolStep(stepId, name, args, output, { isError = false } = {}) {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: stepId, name, arguments: args }],
    },
    {
      role: 'tool',
      toolCallId: stepId,
      toolName: name,
      isError,
      content: [{ type: 'text', text: `[TOOL_RESULT name=${name} id=${stepId}]\n${output}` }],
    },
  ];
}

test('E2E 2.6: DirectAgent full_aci (trajectory_eviction_v26) + partial symbol expand_context + run_diagnostics node-test + anti-thrashing + query_symbol_graph + aciTelemetry', async (t) => {
  const caps = await probeAciRuntimeCapabilities();
  assert.equal(caps.capabilities.trajectoryEvictionV26, true);

  const dataDir = mkdtempSync(join(tmpdir(), 'e2e26-rt-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'e2e26-rt-work-'));
  mkdirSync(join(workDir, 'src', 'legacy'), { recursive: true });
  mkdirSync(join(workDir, 'test'), { recursive: true });

  writeFileSync(
    join(workDir, 'package.json'),
    JSON.stringify({ name: 'e2e26-runtime', type: 'module', scripts: { test: 'node --test' } }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(workDir, 'CONSTRAINTS.md'),
    '# Constraints\n- `computeTotal(amount, tier)` in `src/pricing.js` must apply `computeDiscount` and pass `test/pricing.test.js`.\n',
    'utf8',
  );
  writeFileSync(
    join(workDir, 'src', 'rates.js'),
    `// Tiered discount helper module\n${makeLargeModule('discountRate', 42, 'computeDiscount')}`,
    'utf8',
  );
  writeFileSync(
    join(workDir, 'src', 'pricing.js'),
    [
      "import { computeDiscount } from './rates.js';",
      'export function computeTotal(amount, tier = "gold") {',
      '  return computeDiscount(amount, tier) + 100;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(workDir, 'src', 'caller.js'),
    [
      "import { computeTotal } from './pricing.js';",
      'export function formatInvoiceTotal(amount) {',
      '  return computeTotal(amount, "gold");',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(workDir, 'src', 'legacy', 'old_billing_decoy.js'),
    `// Legacy archive decoy unrelated to active invoice pricing\n${makeLargeModule('legacyArchive', 30)}`,
    'utf8',
  );
  writeFileSync(
    join(workDir, 'test', 'pricing.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { formatInvoiceTotal } from '../src/caller.js';",
      "test('invoice total applies gold discount', () => {",
      '  assert.equal(formatInvoiceTotal(100), 80);',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'deepseek',
    apiKey: 'sk-test-e2e26-placeholder',
    models: ['main-model-26'],
  });
  pool.setDefaultModel('main-model-26');

  let step = 0;
  let capturedRatesRef = null;
  let sawExpandPartialHeader = false;
  let sawNodeTestAssertionDiag = false;
  let sawAntiThrashGuidance = false;
  let sawQuerySymbolGraphOutput = false;

  const adapter = new ScriptedAdapter(async function* (options) {
    const sysText = String(options.system ?? '');
    if (sysText.includes('Supervisor for Adaptive Context Intelligence (ACI)')) {
      const promptText = String(options.messages?.at(-1)?.content?.[0]?.text ?? '');
      const decisions = [];
      try {
        const parsed = JSON.parse(promptText);
        for (const c of parsed?.candidates ?? []) {
          const isDecoy = /legacy|decoy/i.test(String(c?.path ?? ''));
          decisions.push({
            id: c.id,
            decision: isDecoy ? 'IRRELEVANT' : 'SUPPORTING',
            focusSymbols: Array.isArray(c?.symbols) ? c.symbols.slice(0, 4) : [],
            reason: isDecoy ? 'Legacy decoy' : 'Active discount table',
          });
        }
      } catch {
        // ignore parse errors
      }
      yield {
        type: 'text-delta',
        text: JSON.stringify({ decisions, keepRefs: [], compressRefs: [], expandSuggestions: [], summary: 'ok' }),
      };
      yield { type: 'usage', usage: { inputTokens: 150, outputTokens: 30 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    step += 1;
    const msgs = options.messages ?? [];
    const toolMsgs = msgs.filter((m) => m.role === 'tool').map((m) => String(m.content?.[0]?.text ?? ''));

    if (step === 1) {
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'e26-r1', name: 'read_file', arguments: JSON.stringify({ path: 'CONSTRAINTS.md' }) },
      };
      yield {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: 'e26-r2', name: 'read_file', arguments: JSON.stringify({ path: 'src/rates.js' }) },
      };
      yield {
        type: 'block-end',
        index: 2,
        block: { type: 'tool-call', id: 'e26-r3', name: 'read_file', arguments: JSON.stringify({ path: 'src/pricing.js' }) },
      };
      yield {
        type: 'block-end',
        index: 3,
        block: { type: 'tool-call', id: 'e26-r4', name: 'read_file', arguments: JSON.stringify({ path: 'src/legacy/old_billing_decoy.js' }) },
      };
      yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    if (step === 2) {
      const ratesMsg = toolMsgs.find((t) => t.includes('src/rates.js') && /artifact:\/\/[0-9a-f]{64}/.test(t)) ?? toolMsgs.join('\n');
      const uriMatch = ratesMsg.match(/artifact:\/\/[0-9a-f]{64}/);
      capturedRatesRef = uriMatch?.[0] ?? null;
      assert.ok(capturedRatesRef, 'Expected src/rates.js to spill to artifact:// uri for partial recovery');
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'e26-exp', name: 'expand_context', arguments: JSON.stringify({ ref: capturedRatesRef, symbol: 'computeDiscount' }) },
      };
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'e26-w1',
          name: 'write_file',
          arguments: JSON.stringify({
            path: 'src/pricing.js',
            content: "import { computeDiscount } from './rates.js';\nexport function computeTotal(amount, tier = 'gold') {\n  return computeDiscount(amount, tier) + 5;\n}\n",
          }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 1400, outputTokens: 70, cacheReadTokens: 600 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    if (step === 3) {
      const expText = msgs.find((m) => m.toolCallId === 'e26-exp')?.content?.[0]?.text ?? '';
      assert.match(expText, /\[expand_context sha256:[0-9a-f]{12} verified=true/);
      assert.match(expText, /\[sliceSha256:[0-9a-f]{12} verified=true mode=symbol\]/);
      assert.match(expText, /export function computeDiscount/);
      sawExpandPartialHeader = true;

      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'e26-d1', name: 'run_diagnostics', arguments: JSON.stringify({ kind: 'test', paths: ['test/pricing.test.js'] }) },
      };
      yield { type: 'usage', usage: { inputTokens: 1500, outputTokens: 40, cacheReadTokens: 800 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    if (step === 4) {
      const diagText = msgs.find((m) => m.toolCallId === 'e26-d1')?.content?.[0]?.text ?? '';
      const diagJson = extractDiagJson(diagText);
      assert.equal(diagJson.ok, false);
      assert.ok(diagJson.failingTests.length >= 1);
      assert.equal(diagJson.failingTests[0].expected, '80');
      assert.equal(diagJson.failingTests[0].actual, '85');
      assert.equal(diagJson.diagnostics[0].source, 'node-test');
      sawNodeTestAssertionDiag = true;

      // Second flawed edit on same file src/pricing.js -> leads to streak >= 2
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'e26-w2',
          name: 'write_file',
          arguments: JSON.stringify({
            path: 'src/pricing.js',
            content: "import { computeDiscount } from './rates.js';\nexport function computeTotal(amount, tier = 'gold') {\n  return computeDiscount(amount, tier) + 1;\n}\n",
          }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 1600, outputTokens: 50, cacheReadTokens: 900 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    if (step === 5) {
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'e26-d2', name: 'run_diagnostics', arguments: JSON.stringify({ kind: 'test', paths: ['test/pricing.test.js'] }) },
      };
      yield { type: 'usage', usage: { inputTokens: 1700, outputTokens: 40, cacheReadTokens: 950 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    if (step === 6) {
      const userTail = msgs.filter((m) => m.role === 'user').map((m) => m.content?.[0]?.text ?? '').join('\n');
      assert.match(userTail, /Anti-Thrashing Self-Diagnosis/);
      assert.match(userTail, /src\/pricing\.js/);
      assert.match(userTail, /CONSTRAINTS\.md/);
      assert.match(userTail, /src\/caller\.js/);
      sawAntiThrashGuidance = true;

      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'e26-qsg', name: 'query_symbol_graph', arguments: JSON.stringify({ symbol: 'computeTotal' }) },
      };
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'e26-w3',
          name: 'write_file',
          arguments: JSON.stringify({
            path: 'src/pricing.js',
            content: "import { computeDiscount } from './rates.js';\nexport function computeTotal(amount, tier = 'gold') {\n  return computeDiscount(amount, tier);\n}\n",
          }),
        },
      };
      yield { type: 'usage', usage: { inputTokens: 1800, outputTokens: 60, cacheReadTokens: 1000 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    if (step === 7) {
      const qsgText = msgs.find((m) => m.toolCallId === 'e26-qsg')?.content?.[0]?.text ?? '';
      assert.match(qsgText, /computeTotal/);
      assert.match(qsgText, /src\/caller\.js/);
      assert.match(qsgText, /test\/pricing\.test\.js/);
      sawQuerySymbolGraphOutput = true;

      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'e26-d3', name: 'run_diagnostics', arguments: JSON.stringify({ kind: 'test', paths: ['test/pricing.test.js'] }) },
      };
      yield { type: 'usage', usage: { inputTokens: 1850, outputTokens: 40, cacheReadTokens: 1100 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    yield { type: 'text-delta', text: 'Fixed computeTotal in src/pricing.js and verified pricing.test.js.' };
    yield { type: 'usage', usage: { inputTokens: 1900, outputTokens: 35, cacheReadTokens: 1200 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    dataRoot: dataDir,
    defaultWorkspace: workDir,
    adapter,
    enableHeartbeat: false,
  });

  const ephemeralAci = [];
  let offSub = null;
  t.after(async () => {
    offSub?.();
    await direct.close();
    if (store?.db?.isOpen) store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  const sess = direct.createSession({
    workspaceRoot: workDir,
    model: 'main-model-26',
    permissionMode: 'full-access',
    aciProfile: 'full_aci',
    budget: { maxSteps: 16, maxTotalTokens: 160000 },
  });
  offSub = direct.subscribe(sess.id, (ev) => {
    if (ev?.type === 'aci/telemetry') ephemeralAci.push(ev.data);
  });

  const { turn } = direct.startTurn(sess.id, {
    input: 'Fix `computeTotal(amount, tier)` in `src/pricing.js` per `CONSTRAINTS.md` and pass `test/pricing.test.js`.',
    model: 'main-model-26',
    aciOptions: { admissionMinChars: 800 },
  });
  const settled = await waitTurnDone(direct, sess.id, turn.id, 12000);
  assert.equal(settled.state, 'completed', `Turn failed: ${settled.error}`);

  assert.equal(sawExpandPartialHeader, true);
  assert.equal(sawNodeTestAssertionDiag, true);
  assert.equal(sawAntiThrashGuidance, true);
  assert.equal(sawQuerySymbolGraphOutput, true);

  // Verify static system prompt invariance across ALL main calls
  const mainCalls = adapter.calls.filter((c) => !String(c.system ?? '').includes('Supervisor'));
  assert.ok(mainCalls.length >= 7);
  for (let i = 1; i < mainCalls.length; i += 1) {
    assert.equal(mainCalls[i].system, mainCalls[0].system, `System prompt drifted on call ${i}`);
  }

  const events = direct.listEvents(sess.id);
  const completedEv = events.find((e) => e.type === 'turn/completed');
  assert.ok(completedEv?.data?.budgetWatermarks);
  assert.ok(completedEv?.data?.aciTelemetry);
  assert.equal(completedEv.data.aciTelemetry.dtocPolicy, TRAJECTORY_EVICTION_V26_DTOC_POLICY);
  assert.equal(completedEv.data.aciTelemetry.antiThrashingTriggered, true);
  assert.ok(completedEv.data.aciTelemetry.partialRecoveries >= 1);
  assert.ok(completedEv.data.aciTelemetry.recoveryTokensSaved > 0);
  assert.ok(completedEv.data.aciTelemetry.decisions.IRRELEVANT >= 1);
  assert.ok(ephemeralAci.length >= 1);

  const thrashEv = events.find((e) => e.type === 'loop/thrashing_warning');
  assert.ok(thrashEv?.data?.antiThrashingTriggered);
  assert.ok(thrashEv?.data?.aciTelemetry);
});

test('E2E 2.6: trajectory_eviction_v26 evicts superseded reads & resolved diagnostics below 28k while keeping aci_25 phase_watermark_v25 compat', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'e2e26-evict-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();
    const engine26 = new ACIEngine({
      store,
      aciStore,
      ledger,
      dtocPolicy: TRAJECTORY_EVICTION_V26_DTOC_POLICY,
      maxTotalTokens: 180000,
      contextWindow: 180000,
    });
    const engine25 = new ACIEngine({
      store,
      aciStore: new ReversibleContextStore(store),
      ledger: new ContextEvidenceLedger(),
      dtocPolicy: PHASE_WATERMARK_V25_DTOC_POLICY,
      maxTotalTokens: 180000,
      contextWindow: 180000,
    });

    assert.deepEqual([...TRAJECTORY_EVICTION_V26_EPOCH_WATERMARKS], [0.78, 0.9]);

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Update pipeline and resolve errors' }] },
      ...makeToolStep('h0', 'read_file', { path: 'README.md' }, 'Intro\n'.repeat(20)),
      ...makeToolStep('c_spec', 'read_file', { path: 'SPEC.md' }, makeLargeModule('specRule', 35)),
      ...makeToolStep('c_stale', 'read_file', { path: 'src/mod.js' }, makeLargeModule('staleMod', 95)),
      ...makeToolStep('c_fail', 'run_diagnostics', { kind: 'test' }, 'exitCode: 1\nAssertionError: bad\n' + 'stack frame line\n'.repeat(55), { isError: true }),
      ...makeToolStep('c_edit', 'edit_file', { path: 'src/mod.js' }, 'Updated src/mod.js'),
      ...makeToolStep('c_fresh', 'read_file', { path: 'src/mod.js' }, makeLargeModule('freshMod', 50)),
      ...makeToolStep('c_pass', 'run_diagnostics', { kind: 'test' }, '{"ok":true,"diagnostics":[]}'),
    ];

    const v25Res = engine25.compress(messages, {
      currentStep: 7,
      maxSteps: 16,
      cumulativeUsedTokens: 15000,
      verificationCount: 2,
      unverifiedSrcMutations: 0,
      contractFiles: ['SPEC.md'],
    });
    assert.equal(v25Res.triggered, false);

    const v26Res = engine26.compress(messages, {
      currentStep: 7,
      maxSteps: 16,
      cumulativeUsedTokens: 15000,
      verificationCount: 2,
      unverifiedSrcMutations: 0,
      contractFiles: ['SPEC.md'],
    });
    assert.equal(v26Res.triggered, true);
    assert.equal(v26Res.supersededTriggered, true);
    assert.ok(v26Res.supersededEvictions >= 2);
    assert.ok(v26Res.supersededTokensSaved >= 700);
    const evictedPaths = new Set(v26Res.compressedRefs.map((r) => r.path));
    assert.equal(evictedPaths.has('SPEC.md'), false);
    assert.equal(evictedPaths.has('README.md'), false);
  } finally {
    store.close();
    rmDirSafe(storeDir);
  }
});

test('E2E 2.6: Swarm capabilities + TypeScript run_diagnostics + bounded conflict_resolution auto-repair gate', async (t) => {
  assert.equal(existsSync(REAL_TSC_JS), true, 'Expected typescript compiler via node_modules junction');

  const registry = new AgentCapabilityRegistry();
  const capsMap = new Map(registry.listCapabilities().map((c) => [c.id, c]));
  for (const role of ['planning', 'implementation', 'research', 'verification']) {
    const cap = capsMap.get(role);
    assert.ok(cap?.toolAllow?.includes('query_symbol_graph'), `${role} must include query_symbol_graph`);
  }

  const root = mkdtempSync(join(tmpdir(), 'e2e26-swarm-cr-'));
  const dataDir = join(root, 'data');
  const workDir = join(root, 'repo');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const baseTs = [
    'export interface FeatureFlags {',
    '  alpha: boolean;',
    '  beta: boolean;',
    '}',
    'export function buildFlags(): FeatureFlags {',
    '  return { alpha: false, beta: false };',
    '}',
    '',
  ].join('\n');
  const branchATs = baseTs.replace('return { alpha: false, beta: false };', 'return { alpha: true, beta: false };');
  const branchBTs = baseTs.replace('return { alpha: false, beta: false };', 'return { alpha: false, beta: true };');
  const resolvedTs = baseTs.replace('return { alpha: false, beta: false };', 'return { alpha: true, beta: true };');

  const testJs = [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "test('both alpha and beta enabled', () => {",
    "  const src = readFileSync(new URL('../src/flags.ts', import.meta.url), 'utf8');",
    '  assert.match(src, /alpha:\\s*true/);',
    '  assert.match(src, /beta:\\s*true/);',
    '});',
    '',
  ].join('\n');

  const tscUrl = pathToFileURL(REAL_TSC_JS).href;
  initGitWorkspace(workDir, {
    'package.json': JSON.stringify({ name: 'e2e26-cr-ts', type: 'module' }, null, 2),
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', noEmit: true }, include: ['src/**/*.ts'] }),
    'node_modules/.bin/tsc': `#!/usr/bin/env node\nimport ${JSON.stringify(tscUrl)};\n`,
    'src/flags.ts': baseTs,
    'test/flags.test.js': testJs,
  });

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({ preset: 'deepseek', apiKey: 'sk-test-e2e26-cr', models: ['coder-model'] });
  pool.setDefaultModel('coder-model');

  const testCmd = `node --test test/flags.test.js`;
  let crDispatched = 0;
  let sawTypecheckDiagPass = false;

  const adapter = new ScriptedAdapter(async function* (opts) {
    const userText = String(opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '');
    const toolCount = opts.messages.filter((m) => m.role === 'tool').length;

    if (userText.includes('[Bounded Merge-Conflict Resolution Step]')) {
      if (toolCount === 0) {
        crDispatched += 1;
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: 'cr-w', name: 'write_file', arguments: JSON.stringify({ path: 'src/flags.ts', content: resolvedTs }) },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (toolCount === 1) {
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: 'cr-tsc', name: 'run_diagnostics', arguments: JSON.stringify({ kind: 'typecheck', paths: ['src/flags.ts'] }) },
        };
        yield {
          type: 'block-end',
          index: 1,
          block: { type: 'tool-call', id: 'cr-test', name: 'bash', arguments: JSON.stringify({ command: testCmd }) },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      const tscMsg = opts.messages.find((m) => m.toolCallId === 'cr-tsc')?.content?.[0]?.text ?? '';
      const tscJson = extractDiagJson(tscMsg);
      assert.equal(tscJson.ok, true);
      sawTypecheckDiagPass = true;
      yield { type: 'text-delta', text: 'Conflict resolved and verified via tsc and node --test.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (toolCount === 0 && userText.includes('ALPHA_FLAG')) {
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'a-w', name: 'write_file', arguments: JSON.stringify({ path: 'src/flags.ts', content: branchATs }) },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (toolCount === 0 && userText.includes('BETA_FLAG')) {
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'b-w', name: 'write_file', arguments: JSON.stringify({ path: 'src/flags.ts', content: branchBTs }) },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    yield { type: 'text-delta', text: 'Done.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  const direct = new DirectAgentRuntime(store, pool, {
    dataRoot: dataDir,
    defaultWorkspace: workDir,
    adapter,
    enableHeartbeat: false,
  });

  t.after(async () => {
    await direct.close();
    if (store?.db?.isOpen) store.close();
    rmDirSafe(root);
  });

  const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'full-access' });
  const runRes = await direct.swarmOrchestrator.startRun({
    sessionId: sess.id,
    goal: 'Merge parallel TypeScript flag updates safely',
    workspaceRoot: workDir,
    parentPermissionMode: 'full-access',
    nodes: [
      { nodeKey: 'worker-a', taskType: 'implementation', objective: 'ALPHA_FLAG', isolationMode: 'worktree' },
      { nodeKey: 'worker-b', taskType: 'implementation', objective: 'BETA_FLAG', isolationMode: 'worktree' },
    ],
  });

  assert.equal(crDispatched, 1);
  assert.equal(sawTypecheckDiagPass, true);
  assert.equal(runRes.status, 'completed');
  assert.deepEqual(runRes.conflictResolution, {
    triggered: true,
    resolved: true,
    files: ['src/flags.ts'],
    hardGatePassed: true,
    testExitCode: 0,
  });
  assert.equal(readFileSync(join(workDir, 'src/flags.ts'), 'utf8'), baseTs);
  const applyRes = direct.swarmOrchestrator.applyAllRunArtifacts(runRes.runId, {
    approved: true,
    permissionMode: 'full-access',
  });
  assert.equal(applyRes.ok, true);
  assert.equal(applyRes.conflicts.length, 0);
  assert.equal(readFileSync(join(workDir, 'src/flags.ts'), 'utf8'), resolvedTs);
});

test('E2E 2.6: wireSup fix + aci26 deterministic archival + GET /v1/evaluations/aci-ablation schema contract', async (t) => {
  // 1. Verify wireSup helper distinguishes real Supervisor calls from compaction/grace tools:[] calls
  assert.equal(
    isAciSupervisorWireRequest({
      tools: [],
      system: 'Static agent system prompt',
      messages: [{ role: 'user', content: 'Summarize session cleanly.' }],
    }),
    false,
  );
  assert.equal(
    isAciSupervisorWireRequest({
      tools: [],
      system: 'You are the read-only Supervisor for Adaptive Context Intelligence (ACI).',
      messages: [{ role: 'user', content: '{}' }],
    }),
    true,
  );
  const zeroArmA = mergeSupervisorCostTelemetry(
    { calls: 2, inputTokens: 400, outputTokens: 80, totalTokens: 480 },
    [{ inputTokens: 100, outputTokens: 20, ms: 10 }],
    3,
    { supervisorEnabled: false },
  );
  assert.equal(zeroArmA.totalTokens, 0);
  assert.equal(zeroArmA.calls, 0);

  // 2. Verify aci26 dataset contains aci-01..aci-07 with calibrated 240k on aci-06 and 220k on aci-07
  assert.equal(ACI_GOVERNANCE_26_TASK_IDS.length, 7);
  const ds26 = createAciGovernanceDataset({ suite: 'aci26' });
  assert.equal(ds26.find((x) => x.id === 'aci-06-swarm-contract-integration')?.resourceBudget?.maxTotalTokens, 240000);
  assert.equal(ds26.find((x) => x.id === 'aci-07-cross-module-evolution')?.resourceBudget?.maxTotalTokens, 220000);

  // 3. Deterministic aci26 archive (aci-05 + aci-07) -> Fastify GET /v1/evaluations/aci-ablation contract
  const dockerAvailable = new DockerBenchmarkSandbox().isAvailable();
  const sandboxMode = dockerAvailable ? SANDBOX_MODES.STRONG : SANDBOX_MODES.NODE_PERMISSION;
  const prevAllow = process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY;
  if (!dockerAvailable) process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY = '1';

  const archiveDir = mkdtempSync(join(tmpdir(), 'e2e26-evidence-'));
  const store = new Store(':memory:');
  const app = Fastify();
  registerIntelligenceRoutes(app, {
    evaluation: new EvaluationService({ store, aciEvidenceDir: archiveDir }),
    aciEvidenceDir: archiveDir,
  });
  await app.ready();

  t.after(async () => {
    if (prevAllow === undefined) delete process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY;
    else process.env.AGENT_US_BENCHMARK_ALLOW_PROCESS_HARDENING_ONLY = prevAllow;
    await app.close();
    store.close();
    rmDirSafe(archiveDir);
  });

  const emptyPayload = (await app.inject({ method: 'GET', url: '/v1/evaluations/aci-ablation' })).json();
  assert.deepEqual(emptyPayload, { available: false });

  const summary = await runAciGovernanceBenchmark({
    ...parseAciCliArgs([
      '--mode', 'deterministic',
      '--suite', 'aci26',
      '--arms', 'A,C,D',
      '--tasks', 'aci-05,aci-07',
      '--repeats', '1',
      '--concurrency', '3',
      '--archive-dir', archiveDir,
      '--archive-prefix', 'aci-26-e2e',
    ]),
    sandbox: sandboxMode,
  });

  assert.equal(summary.suite, 'aci26');
  assert.equal(summary.metrics.byArm.A.supervisorCost.totalTokens, 0);
  assert.equal(summary.metrics.byArm.A.passedTrials, 2);
  assert.equal(summary.metrics.byArm.C.passedTrials, 2);
  assert.equal(summary.metrics.byArm.D.passedTrials, 2);

  const apiRes = await app.inject({ method: 'GET', url: '/v1/evaluations/aci-ablation' });
  assert.equal(apiRes.statusCode, 200);
  const body = apiRes.json();
  assert.equal(body.available, true);
  assert.equal(body.suite, 'aci26');
  assert.deepEqual(body.armOrder, ['A', 'C', 'D']);
  for (const arm of ['A', 'C', 'D']) {
    const row = body.summaryByArm[arm];
    assert.ok(row, `Missing summaryByArm.${arm}`);
    assert.equal(row.passedTrials, 2);
    assert.equal(row.totalTrials, 2);
    assert.equal(typeof row.passRateCI?.rate, 'number');
    assert.equal(typeof row.passRateCI?.lower, 'number');
    assert.equal(typeof row.passRateCI?.upper, 'number');
    assert.equal(typeof row.cacheHitRate, 'number');
    assert.equal(typeof row.supervisorCost?.totalTokens, 'number');
    assert.ok('pairedPassTokenReduction' in row);
    assert.ok('tokensPerCompletedPass' in row);
  }
  assert.equal(body.summaryByArm.A.supervisorCost.totalTokens, 0);
  assert.match(body.latexTable, /\\begin\{table\}/);
  assert.match(body.markdownTable, /Table 3: ACI 2\.6/);
});
