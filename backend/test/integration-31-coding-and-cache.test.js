import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { measureRequestComposition, pairClosed } from '../src/context.js';
import { stableTools } from '../src/observability/prompt-cache.js';
import {
  ADMISSION_DECISIONS,
  classifyCriticalDomains,
  isDecoyCue,
} from '../src/context/aci-admission.js';
import {
  ACIEngine,
  CACHE_AWARE_V31_DTOC_POLICY,
} from '../src/context/aci-engine.js';
import {
  ContextEvidenceLedger,
  ReversibleContextStore,
} from '../src/context/aci-store.js';
import { tokenizePrefixBlocks64 } from '../scripts/benchmark-swebench.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = resolve(TEST_DIR, '..');
const SWEBENCH_SCRIPT = resolve(BACKEND_DIR, 'scripts', 'benchmark-swebench.mjs');

function runGit(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

async function waitTurnDone(directAgent, sessionId, turnId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const turn = directAgent.listTurns(sessionId).find((t) => t.id === turnId);
    if (turn && ['completed', 'failed', 'cancelled'].includes(turn.state)) return turn;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for turn ${turnId}`);
}

function build300LinePythonCalculator() {
  const sectors = [
    'retail', 'enterprise', 'education', 'healthcare', 'logistics',
    'fintech', 'manufacturing', 'hospitality', 'media', 'telecom',
  ];
  const tiers = ['bronze', 'silver', 'gold', 'platinum'];
  const lines = [
    '"""Tiered order pricing and regional discount calculator."""',
    'from dataclasses import dataclass',
    '',
    '@dataclass(frozen=True)',
    'class OrderLine:',
    '    sku: str',
    '    unit_price_cents: int',
    '    quantity: int',
    '',
  ];

  // Fill lines up to 281 with realistic distinct ~30-char/line Python helpers (~9,000 chars total for 300 lines)
  let ruleIndex = 1;
  while (lines.length < 281) {
    const sec = sectors[ruleIndex % sectors.length];
    const tier = tiers[(ruleIndex * 3) % tiers.length];
    const bp = 100 + (ruleIndex % 17) * 25;
    lines.push(
      `def r_${sec.slice(0, 4)}_${tier.slice(0, 3)}_${ruleIndex}(c: int) -> int:`,
      `    """${sec} ${bp}bp."""`,
      `    return (c * ${bp}) // 10_000`,
      '',
    );
    ruleIndex += 1;
  }

  // Buggy target function reaching 300 lines cleanly (never slice off the return!)
  lines.push(
    'def compute_order_total(',
    '    subtotal_cents: int,',
    '    *,',
    '    is_vip: bool = False,',
    '    promo_pct: float = 0.0,',
    '    max_discount_pct: float = 0.35,',
    ') -> int:',
    '    """Return discounted total in integer cents capped by max_discount_pct."""',
    '    if subtotal_cents < 0:',
    '        raise ValueError("subtotal_cents must be >= 0")',
    '    tier_pct = 0.15 if subtotal_cents >= 20_000 else (0.10 if subtotal_cents >= 10_000 else 0.0)',
    '    vip_pct = 0.10 if is_vip else 0.0',
    '    combined_pct = tier_pct + vip_pct + promo_pct',
    '    effective_pct = combined_pct',
    '    discount_cents = round(subtotal_cents * effective_pct)',
    '    return max(0, subtotal_cents - discount_cents)',
  );

  while (lines.length < 300) {
    lines.push(`# rule-pad-${lines.length + 1}`);
  }
  const result = lines.slice(0, 300).join('\n') + '\n';
  const lineCount = result.trimEnd().split('\n').length;
  assert.equal(lineCount, 300, `Expected exactly 300 lines, got ${lineCount}`);
  assert.ok(result.length >= 6500 && result.length <= 10500, `Expected ~9k chars, got ${result.length}`);
  return result;
}

function buildConftestWithFixtureAndDeprecation() {
  const lines = [
    '"""Shared pytest fixtures for order pricing tests."""',
    'import warnings',
    'import pytest',
    '',
    'warnings.warn("legacy tier alias will be retired in v4", DeprecationWarning)',
    '',
    '@pytest.fixture',
    'def standard_catalog_orders():',
    '    return [',
  ];
  const regions = ['us-east', 'eu-west', 'ap-south', 'ca-central', 'sa-east'];
  for (let i = 1; i <= 18; i += 1) {
    const reg = regions[i % regions.length];
    lines.push(
      `        {"order_id": "ord_${i}", "region": "${reg}", "subtotal_cents": ${5000 + i * 100}, "vip": ${i % 2 === 0 ? 'True' : 'False'}},`,
    );
  }
  lines.push(
    '    ]',
    '',
    '@pytest.fixture',
    'def vip_capped_order():',
    '    return {"subtotal_cents": 20_000, "is_vip": True, "promo_pct": 0.20, "max_discount_pct": 0.35}',
    '',
  );
  const text = lines.join('\n');
  assert.ok(text.length >= 1600 && text.length <= 3500, `Expected ~1.6k-3.5k chars, got ${text.length}`);
  return text;
}

function buildTestCalculatorSuite() {
  const lines = [
    'from src.pricing.calculator import compute_order_total',
    '',
    'def test_standard_discount():',
    '    assert compute_order_total(10_000) == 9_000',
    '',
    'def test_vip_and_promo_respects_cap(vip_capped_order):',
    '    # Tier 15% + VIP 10% + promo 20% = 45%, must clamp to max_discount_pct=35%',
    '    assert compute_order_total(**vip_capped_order) == 13_000',
    '',
  ];
  for (let i = 1; i <= 8; i += 1) {
    const subtotal = 10_000 + i * 100;
    const expected = subtotal - Math.round(subtotal * 0.10);
    lines.push(
      `def test_tier_bracket_${i}(standard_catalog_orders):`,
      `    assert len(standard_catalog_orders) >= 10`,
      `    assert compute_order_total(${subtotal}) == ${expected}`,
      '',
    );
  }
  const text = lines.join('\n');
  assert.ok(text.length >= 1000 && text.length <= 2800, `Expected ~1k-2.8k chars, got ${text.length}`);
  return text;
}

function createPrefixBlockCacheTracker(blockTokens = 64) {
  const cachedChainHashes = new Set();
  const history = [];

  const canonicalizeWireBody = (body) => {
    const toolsJson = JSON.stringify(stableTools(body?.tools ?? []));
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    const msgEntries = msgs.map((m, i) => `\nMSG[${i}]:${JSON.stringify(m)}`);
    return {
      toolsJson,
      msgs,
      canonical: `TOOLS:${toolsJson}${msgEntries.join('')}`,
    };
  };

  const evaluateRequest = (body) => {
    const { toolsJson, msgs, canonical } = canonicalizeWireBody(body);
    const { fullBlocks, totalTokens } = tokenizePrefixBlocks64(canonical, blockTokens);

    let prevChain = 'root';
    let matchedBlocks = 0;
    let prefixIntact = true;
    const blockChains = [];
    for (const block of fullBlocks) {
      const chainHash = createHash('sha256').update(`${prevChain}|${block}`, 'utf8').digest('hex');
      blockChains.push(chainHash);
      if (prefixIntact && cachedChainHashes.has(chainHash)) {
        matchedBlocks += 1;
      } else {
        prefixIntact = false;
      }
      prevChain = chainHash;
    }
    for (const ch of blockChains) {
      cachedChainHashes.add(ch);
    }

    let divergedMsgIndex = null;
    if (history.length > 0) {
      const prev = history.at(-1);
      if (prev.toolsJson !== toolsJson) {
        divergedMsgIndex = -1;
      } else {
        for (let i = 0; i < prev.msgs.length; i += 1) {
          if (JSON.stringify(prev.msgs[i]) !== JSON.stringify(msgs[i])) {
            divergedMsgIndex = i;
            break;
          }
        }
      }
    }

    const cacheReadTokens = Math.min(totalTokens, matchedBlocks * blockTokens);
    const hitRate = totalTokens > 0 ? cacheReadTokens / totalTokens : 0;
    const record = {
      stepIndex: history.length + 1,
      model: body?.model,
      toolsJson,
      msgs: structuredClone(msgs),
      inputTokens: totalTokens,
      cacheReadTokens,
      matchedBlocks,
      totalBlocks: fullBlocks.length,
      hitRate,
      divergedMsgIndex,
    };
    history.push(record);
    return record;
  };

  return {
    evaluateRequest,
    getHistory: () => history,
    reset: () => {
      cachedChainHashes.clear();
      history.length = 0;
    },
  };
}

function startMockOpenAiSseServer(scriptFn) {
  const tracker = createPrefixBlockCacheTracker(64);
  const mainRequests = [];
  const supervisorRequests = [];

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }

    const sysContent = String(body.messages?.[0]?.content ?? '');
    if (
      (!Array.isArray(body.tools) || body.tools.length === 0) &&
      sysContent.includes('Supervisor for Adaptive Context Intelligence (ACI)')
    ) {
      supervisorRequests.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const payload = JSON.stringify({
        decisions: [],
        keepRefs: [],
        compressRefs: [],
        expandSuggestions: [],
        summary: 'ok',
      });
      res.write(
        `data: ${JSON.stringify({
          id: `sup_${supervisorRequests.length}`,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: payload }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }

    const cacheStats = tracker.evaluateRequest(body);
    const stepNum = mainRequests.length + 1;
    const action = scriptFn(body, stepNum, cacheStats);
    mainRequests.push({ stepNum, body: structuredClone(body), cacheStats, action });

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const sendChunk = (delta, finishReason = null, usage = null) => {
      res.write(
        `data: ${JSON.stringify({
          id: `chatcmpl_31_${stepNum}`,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
      );
    };

    if (action.reasoning) {
      sendChunk({ role: 'assistant', reasoning_content: action.reasoning });
    } else {
      sendChunk({ role: 'assistant' });
    }
    if (Array.isArray(action.toolCalls) && action.toolCalls.length > 0) {
      for (let i = 0; i < action.toolCalls.length; i += 1) {
        const tc = action.toolCalls[i];
        sendChunk({
          tool_calls: [
            {
              index: i,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
              },
            },
          ],
        });
      }
      sendChunk({}, 'tool_calls', {
        prompt_tokens: cacheStats.inputTokens,
        completion_tokens: 48,
        total_tokens: cacheStats.inputTokens + 48,
        prompt_cache_hit_tokens: cacheStats.cacheReadTokens,
        prompt_tokens_details: { cached_tokens: cacheStats.cacheReadTokens },
      });
    } else {
      sendChunk({ content: action.text ?? 'Done.' });
      sendChunk({}, 'stop', {
        prompt_tokens: cacheStats.inputTokens,
        completion_tokens: 42,
        total_tokens: cacheStats.inputTokens + 42,
        prompt_cache_hit_tokens: cacheStats.cacheReadTokens,
        prompt_tokens_details: { cached_tokens: cacheStats.cacheReadTokens },
      });
    }
    res.end('data: [DONE]\n\n');
  });

  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({
        baseUrl: `http://127.0.0.1:${port}`,
        mainRequests,
        supervisorRequests,
        resetTracker: () => {
          tracker.reset();
          mainRequests.length = 0;
          supervisorRequests.length = 0;
        },
        close: () =>
          new Promise((resolveClose) => {
            server.closeAllConnections?.();
            server.close(resolveClose);
          }),
      });
    });
  });
}

function makeEngineToolStep(stepId, name, args, output, { isError = false, step = undefined } = {}) {
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

test('Integration 3.1(a): 12-step Python coding turn + 64-token prefix KV cache (>=90% overall, >=94% tail), intra-turn reasoning_content, working-set & syntax guards, and Turn 2 byte-identical history', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'int31-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'int31-pyrepo-'));

  mkdirSync(join(workDir, 'src', 'pricing'), { recursive: true });
  mkdirSync(join(workDir, 'src', 'legacy'), { recursive: true });
  mkdirSync(join(workDir, 'tests'), { recursive: true });

  const calcPy = build300LinePythonCalculator();
  const conftestPy = buildConftestWithFixtureAndDeprecation();
  const testCalcPy = buildTestCalculatorSuite();

  writeFileSync(
    join(workDir, 'AGENTS.md'),
    [
      '# Pricing Engine Engineering Guidelines',
      '',
      ...Array.from(
        { length: 235 },
        (_, i) => `- Policy ${i + 1}: Keep integer cent rounding deterministic in src/pricing/calculator.py and verify via pytest.`,
      ),
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(workDir, 'pyproject.toml'), '[tool.pytest.ini_options]\npythonpath = ["."]\ntestpaths = ["tests"]\n', 'utf8');
  writeFileSync(join(workDir, 'src', '__init__.py'), '', 'utf8');
  writeFileSync(join(workDir, 'src', 'pricing', '__init__.py'), 'from .calculator import OrderLine, compute_order_total\n', 'utf8');
  writeFileSync(join(workDir, 'src', 'pricing', 'calculator.py'), calcPy, 'utf8');
  writeFileSync(join(workDir, 'tests', '__init__.py'), '', 'utf8');
  writeFileSync(join(workDir, 'tests', 'conftest.py'), conftestPy, 'utf8');
  writeFileSync(join(workDir, 'tests', 'test_calculator.py'), testCalcPy, 'utf8');
  writeFileSync(join(workDir, 'src', 'legacy', 'archived_v0.py'), 'def legacy_calc(x):\n    return x\n', 'utf8');

  runGit(workDir, ['init', '-q']);
  runGit(workDir, ['config', 'user.email', 'int31@agent-us.invalid']);
  runGit(workDir, ['config', 'user.name', 'Integration 3.1']);
  runGit(workDir, ['config', 'core.autocrlf', 'false']);
  runGit(workDir, ['config', 'core.filemode', 'false']);
  runGit(workDir, ['add', '-A']);
  runGit(workDir, ['commit', '-qm', 'baseline buggy python pricing repo']);

  // Verify surgical decoy classification directly on conftest.py (@pytest.fixture + DeprecationWarning) vs legacy/
  assert.equal(isDecoyCue('tests/conftest.py', conftestPy), false);
  const conftestDomains = classifyCriticalDomains({ path: 'tests/conftest.py', content: conftestPy });
  assert.equal(conftestDomains.isDecoy, false);
  assert.equal(isDecoyCue('src/legacy/archived_v0.py', 'def legacy_calc(x): return x'), true);

  let scenarioPhase = 'session1_turn1';
  let s1t1Step = 0;
  let s1t2Step = 0;
  let s2t1Step = 0;

  const mockServer = await startMockOpenAiSseServer((body, _reqNum) => {
    if (scenarioPhase === 'session1_turn1') {
      s1t1Step += 1;
      if (s1t1Step === 1) {
        return {
          reasoning: 'step-1-thought: locate compute_order_total across workspace',
          toolCalls: [{ id: 'c31_1', name: 'grep', arguments: { query: 'compute_order_total' } }],
        };
      }
      if (s1t1Step === 2) {
        return {
          reasoning: 'step-2-thought: read 300-line calculator.py module verbatim into working set',
          toolCalls: [{ id: 'c31_2', name: 'read_file', arguments: { path: 'src/pricing/calculator.py' } }],
        };
      }
      if (s1t1Step === 3) {
        return {
          reasoning: 'step-3-thought: read tests/conftest.py (@pytest.fixture + DeprecationWarning) and tests/test_calculator.py in batch',
          toolCalls: [
            { id: 'c31_3', name: 'read_file', arguments: { path: 'tests/conftest.py' } },
            { id: 'c31_4', name: 'read_file', arguments: { path: 'tests/test_calculator.py' } },
          ],
        };
      }
      if (s1t1Step === 4) {
        return {
          reasoning: 'step-4-thought: run_diagnostics test mode to confirm failing cap test',
          toolCalls: [{ id: 'c31_5', name: 'run_diagnostics', arguments: { kind: 'test', paths: ['tests/test_calculator.py'] } }],
        };
      }
      if (s1t1Step === 5) {
        return {
          reasoning: 'step-5-thought: apply edit_file (deliberately missing closing paren to test .py syntax gate)',
          toolCalls: [
            {
              id: 'c31_6',
              name: 'edit_file',
              arguments: {
                path: 'src/pricing/calculator.py',
                target: '    effective_pct = combined_pct',
                replacement: '    effective_pct = min(combined_pct, max_discount_pct',
              },
            },
          ],
        };
      }
      if (s1t1Step === 6) {
        return {
          reasoning: 'step-6-thought: inspect syntax diagnostic via run_diagnostics kind=syntax',
          toolCalls: [{ id: 'c31_7', name: 'run_diagnostics', arguments: { kind: 'syntax', paths: ['src/pricing/calculator.py'] } }],
        };
      }
      if (s1t1Step === 7) {
        return {
          reasoning: 'step-7-thought: fix Python SyntaxError in calculator.py via edit_file',
          toolCalls: [
            {
              id: 'c31_8',
              name: 'edit_file',
              arguments: {
                path: 'src/pricing/calculator.py',
                target: '    effective_pct = min(combined_pct, max_discount_pct',
                replacement: '    effective_pct = min(combined_pct, max_discount_pct)',
              },
            },
          ],
        };
      }
      if (s1t1Step === 8) {
        return {
          reasoning: 'step-8-thought: verify pytest passes via run_diagnostics kind=test',
          toolCalls: [{ id: 'c31_9', name: 'run_diagnostics', arguments: { kind: 'test', paths: ['tests/test_calculator.py'] } }],
        };
      }
      if (s1t1Step === 9) {
        return {
          reasoning: 'step-9-thought: run local pytest -q via bash under workspace-write',
          toolCalls: [{ id: 'c31_10', name: 'bash', arguments: { command: 'pytest -q' } }],
        };
      }
      if (s1t1Step === 10) {
        return {
          reasoning: 'step-10-thought: inspect git status via bash read-only command',
          toolCalls: [{ id: 'c31_10b', name: 'bash', arguments: { command: 'git status --short' } }],
        };
      }
      if (s1t1Step === 11) {
        return {
          reasoning: 'step-11-thought: inspect git diff via bash read-only command',
          toolCalls: [{ id: 'c31_11', name: 'bash', arguments: { command: 'git diff' } }],
        };
      }
      return {
        reasoning: 'step-12-thought: all checks green; present concise fix summary',
        text: 'Fixed compute_order_total in src/pricing/calculator.py to cap combined_pct at max_discount_pct; pytest passed.',
      };
    }

    if (scenarioPhase === 'session1_turn2') {
      s1t2Step += 1;
      if (s1t2Step === 1) {
        return {
          reasoning: 't2-step-1: verify package export in __init__.py',
          toolCalls: [{ id: 'c31_t2_1', name: 'read_file', arguments: { path: 'src/pricing/__init__.py' } }],
        };
      }
      return {
        reasoning: 't2-step-2: summarize',
        text: 'Turn 2 confirmed src/pricing/__init__.py exports compute_order_total cleanly.',
      };
    }

    if (scenarioPhase === 'session2_turn1') {
      s2t1Step += 1;
      if (s2t1Step === 1) {
        return {
          toolCalls: [
            { id: 's2_r1', name: 'read_file', arguments: { path: 'src/pricing/calculator.py' } },
            { id: 's2_r2', name: 'read_file', arguments: { path: 'tests/conftest.py' } },
          ],
        };
      }
      if (s2t1Step === 2) {
        return {
          toolCalls: [{ id: 's2_bash', name: 'bash', arguments: { command: 'pytest -q' } }],
        };
      }
      return { text: 'Session 2 Turn 1 complete.' };
    }

    return { text: 'Session 2 Turn 2 verified Turn 1 history cleanly.' };
  });

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.createAccount({
    preset: 'deepseek',
    label: 'Mock DeepSeek 3.1',
    endpoint: `${mockServer.baseUrl}/v1`,
    credential: 'sk-mock-31-integration',
    models: ['deepseek-reasoner', 'deepseek-chat'],
  });
  pool.setDefaultModel('deepseek-reasoner');

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    enableHeartbeat: false,
  });

  const approvalRequestedEvents = [];
  t.after(async () => {
    await direct.close();
    if (store?.db?.isOpen) store.close();
    await mockServer.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  // === Session 1 Turn 1: 12-step Python coding turn with reasoning_content ===
  const sess1 = direct.createSession({
    workspaceRoot: workDir,
    model: 'deepseek-reasoner',
    permissionMode: 'workspace-write',
    aciProfile: 'full_aci',
    aciOptions: { dtocMinPromptTokens: 48000 },
    toolModes: { diagnostics: true },
    budget: { maxSteps: 40 },
  });
  direct.subscribe(sess1.id, (ev) => {
    if (ev?.type === 'approval/requested') approvalRequestedEvents.push(ev.data);
  });

  const t1 = direct.startTurn(sess1.id, {
    input: 'Fix compute_order_total cap bug in src/pricing/calculator.py and verify pytest passes.',
    model: 'deepseek-reasoner',
    isSynthetic: true,
  });
  const done1 = await waitTurnDone(direct, sess1.id, t1.turn.id, 30000);
  assert.equal(done1.state, 'completed', `Turn 1 failed: ${done1.error}`);
  assert.equal(approvalRequestedEvents.length, 0, 'workspace-write must allow pytest -q, git diff, and edit_file without approval prompts');

  const turn1Reqs = mockServer.mainRequests.slice();
  assert.equal(turn1Reqs.length, 12, `Expected 12-step coding trajectory, got ${turn1Reqs.length}`);

  // 1) Working-set verbatim read of 300-line .py & non-decoy conftest.py
  const completedEv1 = JSON.parse(
    store.db.prepare("SELECT data FROM direct_events WHERE turnId=? AND type='turn/completed'").get(t1.turn.id).data,
  );
  const aciMetrics1 = completedEv1.reasoningMetrics?.aciMetrics;
  assert.equal(aciMetrics1.dtocPolicy, CACHE_AWARE_V31_DTOC_POLICY);
  assert.equal(aciMetrics1.epochTransitions, 0, 'Under 48k prompt floor must trigger 0 DTOC epochs');

  const admissions1 = aciMetrics1.ledger?.admissions ?? [];
  const calcAdm = admissions1.find((a) => String(a.path).includes('src/pricing/calculator.py'));
  const confAdm = admissions1.find((a) => String(a.path).includes('tests/conftest.py'));
  assert.ok(calcAdm && confAdm, 'Expected admissions for calculator.py and conftest.py');
  assert.equal(calcAdm.decision, ADMISSION_DECISIONS.DIRECT);
  assert.equal(calcAdm.reason, 'explicit_read_working_set');
  assert.equal(confAdm.decision, ADMISSION_DECISIONS.DIRECT);
  assert.equal(confAdm.reason, 'explicit_read_working_set');

  const lastTurn1Msgs = turn1Reqs.at(-1).body.messages;
  const wireCalcTool = lastTurn1Msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'c31_2')?.content ?? '';
  assert.match(wireCalcTool, /lines 1-30[01] of 30[01]/);
  assert.match(wireCalcTool, /300: # rule-pad-300/);
  assert.equal(wireCalcTool.startsWith('[ACI-REF'), false, '300-line .py must NOT be skeletonized');

  // 2) edit_file omits implicit per-edit syntax subprocesses (language-agnostic fast path); explicit run_diagnostics catches it with line numbers
  const wireBadEditTool = lastTurn1Msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'c31_6')?.content ?? '';
  assert.doesNotMatch(wireBadEditTool, /自动语法诊断/);

  const wireDiagSynTool = lastTurn1Msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'c31_7')?.content ?? '';
  assert.match(wireDiagSynTool, /"ok":false/);
  assert.match(wireDiagSynTool, /"line":295/);
  assert.match(wireDiagSynTool, /"code":"SYNTAX_ERROR"/);

  // Also verify pytest & git diff ran cleanly in steps 10 & 11
  const wirePytestTool = lastTurn1Msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'c31_10')?.content ?? '';
  assert.match(wirePytestTool, /passed/);
  const wireDiffTool = lastTurn1Msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'c31_11')?.content ?? '';
  assert.match(wireDiffTool, /min\(combined_pct, max_discount_pct\)/);

  // 3) Intra-turn reasoning_content continuity & 0 unexpected prefix mutations
  for (let i = 1; i < turn1Reqs.length; i += 1) {
    const reqRec = turn1Reqs[i];
    assert.equal(
      reqRec.cacheStats.divergedMsgIndex,
      null,
      `Step ${i + 1} mutated prior prefix at msg ${reqRec.cacheStats.divergedMsgIndex}`,
    );
    const assistantsWithCalls = reqRec.body.messages.filter(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    assert.equal(assistantsWithCalls.length, i);
    for (let j = 0; j < assistantsWithCalls.length; j += 1) {
      assert.equal(
        assistantsWithCalls[j].reasoning_content,
        turn1Reqs[j].action.reasoning,
        `Intra-turn assistant step ${j + 1} lost reasoning_content on step ${i + 1}`,
      );
    }
  }

  // 4) Real 64-token prefix-block KV cache hit rate across Turn 1 (>= 90% overall, >= 94% tail steps)
  const turn1TotalInput = turn1Reqs.reduce((s, r) => s + r.cacheStats.inputTokens, 0);
  const turn1TotalCacheRead = turn1Reqs.reduce((s, r) => s + r.cacheStats.cacheReadTokens, 0);
  const turn1OverallHitRate = turn1TotalCacheRead / turn1TotalInput;
  const tailReqs = turn1Reqs.slice(5); // Steps 6..12
  const tailHitRates = tailReqs.map((r) => r.cacheStats.hitRate);
  assert.ok(
    turn1OverallHitRate >= 0.90,
    `Expected Turn 1 overall 64-tok KV cache hit rate >= 0.90, got ${(turn1OverallHitRate * 100).toFixed(2)}%`,
  );
  for (let k = 0; k < tailReqs.length; k += 1) {
    assert.ok(
      tailReqs[k].cacheStats.hitRate >= 0.94,
      `Expected tail step ${k + 6} KV cache hit rate >= 0.94, got ${(tailReqs[k].cacheStats.hitRate * 100).toFixed(2)}%`,
    );
  }

  // === Session 1 Turn 2: priorHistory omits old reasoning_content; tool history is 100% byte-identical ===
  scenarioPhase = 'session1_turn2';
  const t2 = direct.startTurn(sess1.id, {
    input: 'Confirm src/pricing/__init__.py export and summarize.',
    model: 'deepseek-reasoner',
    isSynthetic: true,
  });
  const done2 = await waitTurnDone(direct, sess1.id, t2.turn.id, 15000);
  assert.equal(done2.state, 'completed', `Turn 2 failed: ${done2.error}`);

  const turn2Req1 = mockServer.mainRequests[12];
  const turn2Req2 = mockServer.mainRequests[13];
  assert.ok(turn2Req1 && turn2Req2);

  // Every historical assistant message from Turn 1 omits reasoning_content on Turn 2 Step 1
  const turn2Step1Msgs = turn2Req1.body.messages;
  const firstTurn2UserIdx = turn2Step1Msgs.findIndex(
    (m) => m.role === 'user' && String(m.content).includes('Confirm src/pricing/__init__.py'),
  );
  assert.ok(firstTurn2UserIdx > 0);
  for (const histMsg of turn2Step1Msgs.slice(0, firstTurn2UserIdx)) {
    if (histMsg.role === 'assistant') {
      assert.equal('reasoning_content' in histMsg, false, 'Turn 2 priorHistory must omit old reasoning_content');
    }
  }

  // direct_messages & Turn 2 wire tool outputs are 100% byte-identical to Turn 1 promptOutput
  const dbTurn1Tools = store.db
    .prepare("SELECT toolCallId, content FROM direct_messages WHERE sessionId=? AND turnId=? AND role='tool' ORDER BY seq ASC")
    .all(sess1.id, t1.turn.id);
  assert.equal(dbTurn1Tools.length, 12);
  for (const row of dbTurn1Tools) {
    const t1WireTool = lastTurn1Msgs.find((m) => m.role === 'tool' && m.tool_call_id === row.toolCallId);
    const t2WireTool = turn2Step1Msgs.find((m) => m.role === 'tool' && m.tool_call_id === row.toolCallId);
    assert.ok(t1WireTool && t2WireTool, `Missing wire tool ${row.toolCallId}`);
    assert.equal(row.content, t1WireTool.content, `DB direct_messages mismatch for ${row.toolCallId}`);
    assert.equal(t2WireTool.content, t1WireTool.content, `Turn 2 wire tool mismatch for ${row.toolCallId}`);
  }
  assert.ok(turn2Req2.cacheStats.hitRate >= 0.96, `Expected Turn 2 Step 2 >= 96%, got ${(turn2Req2.cacheStats.hitRate * 100).toFixed(2)}%`);

  // === Session 2 (standard non-reasoning coding model): Turn 2 Step 1 achieves >= 90% real 64-tok KV hit rate ===
  mockServer.resetTracker();
  scenarioPhase = 'session2_turn1';
  const sess2 = direct.createSession({
    workspaceRoot: workDir,
    model: 'deepseek-chat',
    permissionMode: 'workspace-write',
    aciProfile: 'full_aci',
  });
  const s2t1 = direct.startTurn(sess2.id, {
    input: 'Inspect calculator.py and conftest.py, then run pytest -q.',
    model: 'deepseek-chat',
    isSynthetic: true,
  });
  assert.equal((await waitTurnDone(direct, sess2.id, s2t1.turn.id, 20000)).state, 'completed');

  scenarioPhase = 'session2_turn2';
  const s2t2 = direct.startTurn(sess2.id, {
    input: 'List the exported symbol name from calculator.py.',
    model: 'deepseek-chat',
    isSynthetic: true,
  });
  assert.equal((await waitTurnDone(direct, sess2.id, s2t2.turn.id, 15000)).state, 'completed');

  const s2Turn2Step1 = mockServer.mainRequests.at(-1);
  assert.equal(s2Turn2Step1.cacheStats.divergedMsgIndex, null, 'Session 2 Turn 2 Step 1 must not mutate Turn 1 prefix');
  assert.ok(
    s2Turn2Step1.cacheStats.hitRate >= 0.90,
    `Expected Turn 2 Step 1 64-tok KV cache hit rate >= 0.90, got ${(s2Turn2Step1.cacheStats.hitRate * 100).toFixed(2)}%`,
  );

  // Record observed metrics cleanly on test context diagnostic
  t.diagnostic(
    `Turn1 overall=${(turn1OverallHitRate * 100).toFixed(2)}%, Turn1 tail=${(Math.min(...tailHitRates) * 100).toFixed(2)}..${(Math.max(...tailHitRates) * 100).toFixed(2)}%, Turn2Step1(non-reasoning)=${(s2Turn2Step1.cacheStats.hitRate * 100).toFixed(2)}%, Session1Turn2Step2=${(turn2Req2.cacheStats.hitRate * 100).toFixed(2)}%`,
  );
});

test('Integration 3.1(b): cache_aware_v31 >48k amortized batch epoch (>=max(3500, 0.35*suffix) savings + 10-step cooldown + invalidatedSuffixTokens) and benchmark-swebench.mjs --dry-run subprocess', () => {
  // 1. cache_aware_v31 >48k amortized batch epoch verification
  const storeDir = mkdtempSync(join(tmpdir(), 'int31-dtoc-'));
  const store = new Store(join(storeDir, 'engine.sqlite'));
  try {
    const engine = new ACIEngine({
      store,
      aciStore: new ReversibleContextStore(store),
      ledger: new ContextEvidenceLedger(),
      dtocPolicy: CACHE_AWARE_V31_DTOC_POLICY,
      maxTotalTokens: 200000,
      contextWindow: 128000,
    });

    const mkBigPy = (prefix, count) =>
      Array.from(
        { length: count },
        (_, i) => `def ${prefix}_${i}(val, factor=${(i % 9) + 1}):\n    return (val * factor) + ${i + 1}\n`,
      ).join('\n');

    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'Optimize pipeline and verify tests' }] },
      ...makeEngineToolStep('h1', 'read_file', { path: 'README.md' }, 'Project readme\n'.repeat(30), { step: 1 }),
      ...makeEngineToolStep('s1', 'read_file', { path: 'src/stale_mod.py' }, mkBigPy('staleMod', 820), { step: 2 }),
      ...makeEngineToolStep('s2', 'read_file', { path: 'src/aged_a.py' }, mkBigPy('agedAlpha', 820), { step: 3 }),
      ...makeEngineToolStep('s3', 'read_file', { path: 'src/aged_b.py' }, mkBigPy('agedBeta', 820), { step: 4 }),
      ...makeEngineToolStep('e1', 'edit_file', { path: 'src/stale_mod.py' }, 'Edited src/stale_mod.py', { step: 9 }),
      ...makeEngineToolStep('r1', 'read_file', { path: 'src/stale_mod.py' }, mkBigPy('freshMod', 520), { step: 10 }),
      ...makeEngineToolStep('t1', 'run_diagnostics', { kind: 'test' }, 'exitCode: 1\nAssertionError: active test fail\n', {
        isError: true,
        step: 11,
      }),
    ];
    assert.ok(measureRequestComposition({ messages: msgs }).totalTokens >= 48000);

    const epoch1 = engine.compress(msgs, { currentStep: 11 });
    assert.equal(epoch1.triggered, true);
    assert.equal(epoch1.reason, CACHE_AWARE_V31_DTOC_POLICY);
    assert.ok(epoch1.invalidatedSuffixTokens > 0);
    assert.ok(
      epoch1.netSavingsTokens >= Math.max(3500, Math.ceil(epoch1.invalidatedSuffixTokens * 0.35)),
      `Expected >= max(3500, 0.35*suffix) savings, got ${epoch1.netSavingsTokens}`,
    );
    assert.equal(pairClosed(epoch1.messages), true);

    const wave2 = [
      ...epoch1.messages,
      ...makeEngineToolStep('s4', 'read_file', { path: 'src/aged_c.py' }, mkBigPy('agedGamma', 1400), { step: 13 }),
      ...makeEngineToolStep('e2', 'edit_file', { path: 'src/aged_c.py' }, 'Edited src/aged_c.py', { step: 14 }),
      ...makeEngineToolStep('r2', 'read_file', { path: 'src/tail.py' }, mkBigPy('liveTail', 1400), { step: 20 }),
    ];
    assert.ok(measureRequestComposition({ messages: wave2 }).totalTokens >= 48000);

    const blocked = engine.compress(wave2, { currentStep: 20 });
    assert.equal(blocked.triggered, false);
    assert.equal(blocked.reason, 'eviction_cooldown');

    const epoch2 = engine.compress(wave2, { currentStep: 21 });
    assert.equal(epoch2.triggered, true);
    assert.equal(epoch2.epoch, 2);
  } finally {
    store.close?.();
    rmDirSafe(storeDir);
  }

  // 2. Subprocess benchmark-swebench.mjs --dry-run
  const outDir = mkdtempSync(join(tmpdir(), 'int31-swebench-'));
  try {
    const run = spawnSync(
      process.execPath,
      [SWEBENCH_SCRIPT, '--dry-run', '--output-dir', outDir],
      { cwd: BACKEND_DIR, encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(run.status, 0, `benchmark-swebench --dry-run failed: ${run.stderr}\n${run.stdout}`);

    const rawPreds = readFileSync(join(outDir, 'predictions.raw_full.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const aciPreds = readFileSync(join(outDir, 'predictions.full_aci.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(rawPreds.length, 1);
    assert.equal(aciPreds.length, 1);
    assert.match(rawPreds[0].model_patch, /diff --git a\/src\/discounts\/calculator\.py/);
    assert.match(aciPreds[0].model_patch, /effective_pct = min\(combined_pct, max_discount_pct\)/);
    assert.equal(aciPreds[0].model_patch.includes('__pycache__'), false);

    const summaryMd = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(summaryMd, /SWE-bench Verified Benchmark Summary/);
    assert.match(summaryMd, /Real Provider Cache Hit Rate/);
    assert.match(summaryMd, /`raw_full`/);
    assert.match(summaryMd, /`full_aci`/);
    assert.equal(existsSync(join(outDir, 'telemetry.full_aci.jsonl')), true);
  } finally {
    rmDirSafe(outDir);
  }
});
