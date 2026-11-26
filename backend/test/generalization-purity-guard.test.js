import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import {
  BackgroundProcessManager,
  DEFAULT_CODING_TOOLS,
  createWorkspaceTools,
} from '../src/workspace-tools.js';
import { ToolPermissionPolicy } from '../src/tools/policy.js';
import { modelToolCatalog } from '../src/tools/selection.js';

const BACKEND_SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

/**
 * Tokens strictly forbidden anywhere in core `backend/src/` (excluding `backend/src/evaluation/`).
 * Every entry is checked case-insensitively across all `.js` and `.mjs` source files.
 */
const BANNED_CORE_TOKENS = Object.freeze([
  '/testbed',
  'swebench',
  'swe_bench',
  'django',
  'sphinx',
  'sympy',
  'polyglot',
  'exercism',
  'benchmarkMode',
  'STALE_VERIFICATION_AFTER_EDIT',
  'FABRICATED_PASS_CLAIM',
  'DISK_FILE_MISSING',
  'LOOP_THRASHING_ABORT',
]);

const CORE_ATOMIC_CODING_TOOLS = Object.freeze([
  'read_file',
  'edit_file',
  'write_file',
  'glob',
  'grep',
  'bash',
]);

const CORE_ATOMIC_SET = new Set(CORE_ATOMIC_CODING_TOOLS);
const FULL_ACI_ALLOWED_SET = new Set([...CORE_ATOMIC_CODING_TOOLS, 'expand_context']);

const FORBIDDEN_DEFAULT_CODING_TOOLS = Object.freeze([
  'inspect_repository',
  'query_symbol_graph',
  'run_diagnostics',
  'compute_file_digest',
  'update_plan',
  'search_history',
  'read_blob',
  'web_fetch',
  'start_process',
  'kill_process',
  'read_process_output',
  'spawn_subagent',
  'swarm_orchestrate',
  'send_agent_message',
]);

function collectCoreSourceFiles(dir, rootDir = dir, out = []) {
  const entries = readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(rootDir, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (relPath === 'evaluation' || relPath.startsWith('evaluation/')) {
        continue;
      }
      collectCoreSourceFiles(fullPath, rootDir, out);
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
      out.push({ fullPath, relPath });
    }
  }
  return out;
}

function scanBannedTokens(files, tokens) {
  const lowered = tokens.map((token) => ({ token, needle: token.toLowerCase() }));
  const violations = [];

  for (const file of files) {
    const content = readFileSync(file.fullPath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      const lineLower = line.toLowerCase();
      for (const { token, needle } of lowered) {
        if (lineLower.includes(needle)) {
          violations.push({
            file: `backend/src/${file.relPath}`,
            line: idx + 1,
            token,
            snippet: line.trim().slice(0, 160),
          });
        }
      }
    }
  }

  return violations;
}

class CaptureToolsAdapter extends LlmAdapter {
  constructor() {
    super();
    this.capturedToolNames = [];
  }

  async *stream(options) {
    this.capturedToolNames.push((options.tools ?? []).map((t) => t.name));
    yield { type: 'text-delta', index: 0, text: 'ok' };
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 8 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function waitForTurnTerminal(directAgent, sessionId, turnId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const turn = directAgent.listTurns(sessionId).find((x) => x.id === turnId);
    if (turn && ['completed', 'failed', 'cancelled'].includes(turn.state)) return turn;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for turn ${turnId}`);
}

test('core backend/src (excluding evaluation/) contains zero benchmark or heuristic-interceptor leaks', () => {
  const coreFiles = collectCoreSourceFiles(BACKEND_SRC_DIR);
  assert.ok(
    coreFiles.length > 50,
    `Expected to scan core backend/src files, only found ${coreFiles.length}`,
  );
  assert.equal(
    coreFiles.some((f) => f.relPath === 'evaluation' || f.relPath.startsWith('evaluation/')),
    false,
    'backend/src/evaluation/ must be excluded from core purity scan',
  );

  const violations = scanBannedTokens(coreFiles, BANNED_CORE_TOKENS);
  if (violations.length > 0) {
    const formatted = violations
      .map((v) => `  ${v.file}:${v.line}: [${v.token}] ${v.snippet}`)
      .join('\n');
    assert.fail(
      `Found ${violations.length} purity violation(s) in core backend/src/:\n${formatted}`,
    );
  }
});

test('default createWorkspaceTools() registers strictly 6 language-agnostic atomic tools (<= 7)', (t) => {
  assert.deepEqual([...DEFAULT_CODING_TOOLS], [...CORE_ATOMIC_CODING_TOOLS]);
  assert.ok(DEFAULT_CODING_TOOLS.length <= 7);

  const workspaceRoot = mkdtempSync(join(tmpdir(), 'agent-us-purity-ws-'));
  const store = new Store(':memory:');
  const processManager = new BackgroundProcessManager();
  t.after(() => {
    store.close();
    rmDirSafe(workspaceRoot);
  });

  // Even when optional host callbacks are supplied, default toolProfile ('core') MUST stay <= 7 core tools.
  const registeredTools = createWorkspaceTools({
    workspaceRoot,
    store,
    sessionId: 'purity-guard-core',
    permissionMode: 'auto-safe',
    processManager,
    onPlanUpdated: () => {},
    runSubagent: async () => 'noop',
    orchestrateSwarm: async () => 'noop',
    sendAgentMessage: async () => 'noop',
    resolveContextRef: async () => null,
  });

  const registeredNames = registeredTools.map((tool) => tool.name);

  assert.equal(
    registeredNames.length,
    6,
    `Default createWorkspaceTools() must register strictly 6 core atomic tools, got ${registeredNames.length}: [${registeredNames.join(', ')}]`,
  );
  assert.ok(registeredNames.length <= 7);

  for (const required of CORE_ATOMIC_CODING_TOOLS) {
    assert.ok(
      registeredNames.includes(required),
      `Default tool list missing core primitive "${required}". Registered: [${registeredNames.join(', ')}]`,
    );
  }

  const unexpectedRegistered = registeredNames.filter((name) => !CORE_ATOMIC_SET.has(name));
  assert.deepEqual(
    unexpectedRegistered,
    [],
    `Default createWorkspaceTools() registered non-core tool(s): [${unexpectedRegistered.join(', ')}]`,
  );

  const leakedForbidden = registeredNames.filter(
    (name) =>
      FORBIDDEN_DEFAULT_CODING_TOOLS.includes(name) ||
      name === 'expand_context' ||
      name === 'apply_patch',
  );
  assert.deepEqual(
    leakedForbidden,
    [],
    `Default createWorkspaceTools() leaked advanced tool(s): [${leakedForbidden.join(', ')}]`,
  );

  const policy = new ToolPermissionPolicy({ permissionMode: 'auto-safe' });
  const exposedCatalog = modelToolCatalog(registeredTools, policy, {
    permissionMode: 'auto-safe',
  });
  const exposedNames = exposedCatalog.map((tool) => tool.name);

  assert.equal(exposedNames.length, 6);
  assert.deepEqual(
    exposedNames.filter((name) => !CORE_ATOMIC_SET.has(name)),
    [],
    `Model tool catalog exposed non-core tool(s): [${exposedNames.join(', ')}]`,
  );
});

test('DirectAgentRuntime exposes <= 7 tools in both raw_full (6 core) and full_aci (6 core + expand_context)', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-purity-rt-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-purity-rt-work-'));
  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('purity-mock-model');

  const adapter = new CaptureToolsAdapter();
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
    enableHeartbeat: false,
  });

  t.after(async () => {
    await direct.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  });

  // 1. raw_full coding session: strictly the 6 language-agnostic core primitives (<= 7)
  const rawSession = direct.createSession({
    workspaceRoot: workDir,
    permissionMode: 'auto-safe',
    aciProfile: 'raw_full',
  });
  const rawTurn = direct.startTurn(rawSession.id, {
    input: 'Say hello',
    model: 'purity-mock-model',
  });
  const rawSettled = await waitForTurnTerminal(direct, rawSession.id, rawTurn.turn.id);
  assert.equal(rawSettled.state, 'completed');

  const rawToolNames = adapter.capturedToolNames[0] ?? [];
  assert.equal(
    rawToolNames.length,
    6,
    `raw_full session must expose strictly 6 core tools, got ${rawToolNames.length}: [${rawToolNames.join(', ')}]`,
  );
  assert.ok(rawToolNames.length <= 7);
  assert.deepEqual(
    rawToolNames.filter((name) => !CORE_ATOMIC_SET.has(name)),
    [],
    `raw_full session exposed non-core tool(s): [${rawToolNames.join(', ')}]`,
  );
  assert.equal(rawToolNames.includes('expand_context'), false);

  // 2. full_aci coding session: strictly <= 7 (6 core primitives + single read-only expand_context)
  const aciSession = direct.createSession({
    workspaceRoot: workDir,
    permissionMode: 'auto-safe',
    aciProfile: 'full_aci',
  });
  const aciTurn = direct.startTurn(aciSession.id, {
    input: 'Say hello',
    model: 'purity-mock-model',
  });
  const aciSettled = await waitForTurnTerminal(direct, aciSession.id, aciTurn.turn.id);
  assert.equal(aciSettled.state, 'completed');

  const aciToolNames = adapter.capturedToolNames[1] ?? [];
  assert.equal(
    aciToolNames.length,
    7,
    `full_aci session must expose strictly 7 tools (6 core + expand_context), got ${aciToolNames.length}: [${aciToolNames.join(', ')}]`,
  );
  assert.ok(aciToolNames.length <= 7);
  for (const required of [...CORE_ATOMIC_CODING_TOOLS, 'expand_context']) {
    assert.ok(
      aciToolNames.includes(required),
      `full_aci session missing expected tool "${required}". Exposed: [${aciToolNames.join(', ')}]`,
    );
  }
  assert.deepEqual(
    aciToolNames.filter((name) => !FULL_ACI_ALLOWED_SET.has(name)),
    [],
    `full_aci session exposed disallowed tool(s): [${aciToolNames.join(', ')}]`,
  );
  assert.deepEqual(
    aciToolNames.filter((name) => FORBIDDEN_DEFAULT_CODING_TOOLS.includes(name)),
    [],
    `full_aci session leaked forbidden advanced tool(s): [${aciToolNames.join(', ')}]`,
  );
});
