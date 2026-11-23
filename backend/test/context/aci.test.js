import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Store } from '../../src/store.js';
import { AccountPool } from '../../src/pool.js';
import { pairClosed } from '../../src/context.js';
import {
  ContextEvidenceLedger,
  ReversibleContextStore,
} from '../../src/context/aci-store.js';
import {
  ACIEngine,
  ACON_MAX_GUIDELINES,
  ACON_SETTINGS_KEY,
  compressMessagesEpoch,
  evaluateRetrievalGate,
  expandContext,
  getLearnedGuidelines,
  learnFromFailure,
  refineCandidates,
} from '../../src/context/aci-engine.js';
import {
  ContextSupervisor,
} from '../../src/context/supervisor.js';
import { registerIntelligenceRoutes } from '../../src/routes/intelligence-routes.js';

function makeTempPool(t, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aci-test-'));
  const store = new Store(join(dir, 'test.sqlite'));
  const pool = new AccountPool(store, { root: dir });
  t.after(() => {
    try {
      if (store?.db?.isOpen) store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return fn({ store, pool, dir });
}

test('ReversibleContextStore guarantees 100% lossless restoration and ContextEvidenceLedger tracks recall', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());

  const aciStore = new ReversibleContextStore(store);
  const ledger = new ContextEvidenceLedger();

  const rawCode = [
    '// 中文注释与 CRLF/LF 混合内容',
    'export class AuthGateway {',
    '  verifyToken(token) {',
    '    if (!token) throw new Error("missing token");',
    '    return token.startsWith("valid_");',
    '  }',
    '}',
    'const special = "line1\\n\\tline2 \\u4e2d\\u6587";',
  ].join('\r\n');

  const ref = aciStore.put(rawCode, {
    toolName: 'read_file',
    path: 'backend/src/auth/gateway.js',
    lineRange: 'L1-8',
    symbolOutline: ['AuthGateway', 'AuthGateway.verifyToken'],
    step: 2,
  });

  assert.ok(ref.refId);
  assert.ok(ref.uri.startsWith('artifact://'));
  assert.equal(ref.sha256.length, 64);
  assert.equal(ref.toolName, 'read_file');
  assert.equal(ref.path, 'backend/src/auth/gateway.js');
  assert.equal(ref.lineRange, 'L1-8');
  assert.deepEqual(ref.symbolOutline, ['AuthGateway', 'AuthGateway.verifyToken']);
  assert.ok(ref.originalTokens > 0);
  assert.ok(ref.stubTokens > 0);
  assert.equal(ref.step, 2);
  assert.equal(ref.restoredCount, 0);
  assert.ok(ref.stubText.includes(`[ACI-REF ${ref.uri}`));
  assert.ok(ref.stubText.includes('call expand_context or read_blob to restore'));

  assert.equal(aciStore.restore(ref.refId), rawCode);
  assert.equal(aciStore.restore(ref.uri), rawCode);
  assert.equal(aciStore.restore(ref.sha256), rawCode);
  assert.equal(aciStore.getRef(ref.refId).restoredCount, 3);

  ledger.recordDiscovered([
    { path: 'backend/src/auth/gateway.js', score: 0.9, step: 1 },
    { path: 'backend/src/routes/login.js', score: 0.8, step: 1 },
    { path: 'backend/src/config/schema.js', score: 0.7, step: 1 },
  ]);
  ledger.recordKept([{ path: 'backend/src/auth/gateway.js', step: 2 }]);
  ledger.recordCompressed([{ path: 'backend/src/routes/login.js', originalTokens: 500, stubTokens: 40, step: 2 }]);
  ledger.recordExpanded([{ path: 'backend/src/routes/login.js', level: 'hunk', step: 3 }]);

  const recall = ledger.computeCriticalContextRecall([
    'backend/src/auth/gateway.js',
    'backend/src/routes/login.js',
    'backend/src/config/schema.js',
  ]);
  assert.equal(recall.total, 3);
  assert.equal(recall.matched.length, 2);
  assert.deepEqual(recall.missing, ['backend/src/config/schema.js']);
  assert.equal(Number(recall.recall.toFixed(4)), Number((2 / 3).toFixed(4)));
  assert.equal(recall.discoveryRecall, 1);
});

test('Repoformer selective-retrieval gating abstains when local context covers symbols and retrieves when uncovered', () => {
  const ledger = new ContextEvidenceLedger();
  const localMsg = {
    role: 'tool',
    path: 'src/math.js',
    content: [
      {
        type: 'text',
        text: 'export function computeInvoiceTotal(items, taxRate) {\n  return items.reduce((s, x) => s + x.price, 0) * (1 + taxRate);\n}',
      },
    ],
  };

  const abstained = evaluateRetrievalGate({
    query: 'computeInvoiceTotal taxRate',
    targetPaths: ['src/math.js'],
    neededSymbols: ['computeInvoiceTotal', 'taxRate'],
    localContextMessages: [localMsg],
    ledger,
  });
  assert.equal(abstained.abstain, true);
  assert.equal(abstained.action, 'abstain');
  assert.equal(ledger.abstained.length, 1);

  const retrieve = evaluateRetrievalGate({
    query: 'verifySignature jwtSecret',
    targetPaths: ['src/auth/jwt.js'],
    neededSymbols: ['verifySignature', 'jwtSecret'],
    localContextMessages: [localMsg],
    errorText: 'TypeError: verifySignature is not a function\n    at authenticate (src/auth/jwt.js:44:12)',
    ledger,
  });
  assert.equal(retrieve.abstain, false);
  assert.equal(retrieve.action, 'retrieve');
  assert.ok(retrieve.uncoveredPaths.includes('src/auth/jwt.js'));
  assert.ok(retrieve.uncoveredSymbols.includes('verifySignature'));
});

test('RepoCoder refinement scores errorTrace/contract/recentEdit/symbolOverlap/recency and progressive expansion works', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());

  const engine = new ACIEngine({ store, ledger: new ContextEvidenceLedger() });
  const targetCode = [
    'import { hashPassword } from "./crypto.js";',
    '',
    'export class UserService {',
    '  async registerUser(email, password) {',
    '    const digest = hashPassword(password);',
    '    return { email, digest };',
    '  }',
    '  async validateSession(sessionId) {',
    '    if (!sessionId) throw new Error("SESSION_REQUIRED");',
    '    return { ok: true, sessionId };',
    '  }',
    '}',
  ].join('\n');

  const ref = engine.aciStore.put(targetCode, {
    toolName: 'read_file',
    path: 'src/services/user-service.js',
    step: 4,
  });

  const refined = refineCandidates(
    [
      {
        path: 'src/utils/formatting.js',
        content: 'export function formatDate(d) { return String(d); }',
        step: 1,
      },
      {
        path: 'src/services/user-service.js',
        content: targetCode,
        step: 4,
      },
      {
        path: 'src/contracts/api-schema.ts',
        content: 'export interface UserDTO { email: string; }',
        step: 3,
      },
    ],
    {
      query: 'fix validateSession failing in UserService',
      testErrors: 'Error: SESSION_REQUIRED\n    at UserService.validateSession (src/services/user-service.js:9:27)',
      recentEdits: ['src/services/user-service.js'],
      contractFiles: ['src/contracts/api-schema.ts'],
      currentStep: 5,
      ledger: engine.ledger,
    },
  );

  assert.equal(refined.candidates[0].path, 'src/services/user-service.js');
  assert.equal(refined.candidates[0].signals.errorTrace, 1);
  assert.equal(refined.candidates[0].signals.recentEdit, 1);
  assert.ok(refined.candidates[0].score > refined.candidates[1].score);
  assert.equal(refined.candidates[1].path, 'src/contracts/api-schema.ts');
  assert.equal(refined.candidates[1].signals.contractFile, 1);

  const outline = engine.expand(ref.refId, { level: 'outline', step: 5 });
  assert.equal(outline.level, 'outline');
  assert.ok(outline.text.includes('UserService'));
  assert.ok(outline.text.includes('validateSession'));

  const hunk = engine.expand(ref.refId, {
    level: 'hunk',
    query: 'SESSION_REQUIRED',
    contextLines: 2,
    step: 6,
  });
  assert.equal(hunk.level, 'hunk');
  assert.ok(hunk.text.includes('validateSession'));
  assert.ok(hunk.text.includes('SESSION_REQUIRED'));

  const verbatim = engine.expand(ref.refId, { level: 'verbatim', step: 7 });
  assert.equal(verbatim.level, 'verbatim');
  assert.equal(verbatim.text, targetCode);
});

test('Epoch-based DTOC compression triggers only at watermarks or single-step overflow, keeps KV prefix warm, preserves errors/mutations and pairClosed', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());

  const aciStore = new ReversibleContextStore(store);
  const ledger = new ContextEvidenceLedger();

  const fillerRead = 'const line = "payload data chunk";\n'.repeat(65); // > 1200 chars (~500 tokens)
  const failingBash = 'exitCode: 1\nAssertionError: expected 200 to equal 500\n    at test/app.test.js:12:5\n' + 'trace line\n'.repeat(120);
  const mutatedFileRead = 'export function activeEditTarget() {\n  return 42;\n}\n'.repeat(40);

  const buildMessages = () => [
    { role: 'system', content: [{ type: 'text', text: 'static system prompt' }] },
    { role: 'user', content: [{ type: 'text', text: 'fix the failing test' }] },
    // Step 1: large non-error read_file (compressible once age >= 3)
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'src/old-a.js', startLine: 1, endLine: 65 }) }],
    },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: fillerRead }] },
    // Step 2: failing bash test (MUST NEVER be compressed!)
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c2', name: 'bash', arguments: JSON.stringify({ command: 'node --test' }) }],
    },
    { role: 'tool', toolCallId: 'c2', meta: { isError: true }, content: [{ type: 'text', text: failingBash }] },
    // Step 3: read of active mutation target (MUST NEVER be compressed!)
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c3', name: 'read_file', arguments: JSON.stringify({ path: 'src/active.js' }) }],
    },
    { role: 'tool', toolCallId: 'c3', content: [{ type: 'text', text: mutatedFileRead }] },
    // Step 4: edit_file on src/active.js + recent read_file (age < 3)
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', id: 'c4', name: 'edit_file', arguments: JSON.stringify({ path: 'src/active.js' }) },
        { type: 'tool-call', id: 'c5', name: 'grep', arguments: JSON.stringify({ pattern: 'activeEditTarget' }) },
      ],
    },
    { role: 'tool', toolCallId: 'c4', content: [{ type: 'text', text: 'ok' }] },
    { role: 'tool', toolCallId: 'c5', content: [{ type: 'text', text: 'match line\n'.repeat(130) }] },
  ];

  // Below 45% watermark (large maxTotalTokens): must NOT trigger
  const baseMsgs = buildMessages();
  const r0 = compressMessagesEpoch(baseMsgs, {
    aciStore,
    ledger,
    maxTotalTokens: 20000,
    epochState: { lastWatermark: -1, epochCount: 0 },
  });
  assert.equal(r0.triggered, false);
  assert.equal(r0.compressedCount, 0);
  assert.equal(r0.messages, baseMsgs);

  // Cross 45% watermark: maxTotalTokens = 3000 -> triggers Epoch 1
  const r1 = compressMessagesEpoch(baseMsgs, {
    aciStore,
    ledger,
    maxTotalTokens: 3000,
    epochState: r0.epochState,
  });
  assert.equal(r1.triggered, true);
  assert.equal(r1.epoch, 1);
  assert.equal(r1.watermark, 0.45);
  assert.equal(r1.compressedCount, 1);
  assert.equal(r1.pairClosedValid, true);
  assert.equal(pairClosed(r1.messages, 0, r1.messages.length - 1), true);

  // c1 was replaced with reversible ACI-REF stub and restores losslessly
  const c1Text = r1.messages[3].content[0].text;
  assert.ok(c1Text.startsWith('[ACI-REF artifact://'));
  assert.ok(c1Text.includes('src/old-a.js'));
  assert.ok(c1Text.includes('L1-65'));
  assert.ok(c1Text.includes('call expand_context or read_blob to restore'));
  assert.equal(aciStore.restore(r1.compressedRefs[0].uri), fillerRead);

  // Error output (c2) and active mutation target (c3) and recent output (c5) MUST remain verbatim
  assert.equal(r1.messages[5].content[0].text, failingBash);
  assert.equal(r1.messages[7].content[0].text, mutatedFileRead);
  assert.ok(!r1.messages[10].content[0].text.startsWith('[ACI-REF '));

  // Between epochs (between 45% and 70%): append a new small turn; prefix bytes MUST remain byte-identical!
  const step5Msgs = [
    ...r1.messages,
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c6', name: 'glob', arguments: '{"pattern":"*.js"}' }] },
    { role: 'tool', toolCallId: 'c6', content: [{ type: 'text', text: 'src/old-a.js\nsrc/active.js' }] },
  ];
  const prefixBefore = JSON.stringify(r1.messages);
  const rBetween = compressMessagesEpoch(step5Msgs, {
    aciStore,
    ledger,
    maxTotalTokens: 3000,
    epochState: r1.epochState,
  });
  assert.equal(rBetween.triggered, false);
  assert.equal(JSON.stringify(rBetween.messages.slice(0, r1.messages.length)), prefixBefore);

  // Single-step budget overflow (> singleStepBudget) triggers even below 45% total ratio
  const hugeOutput = 'const big = 1;\n'.repeat(1500);
  const overflowMsgs = [
    { role: 'user', content: [{ type: 'text', text: 'read huge file' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'big1', name: 'read_file', arguments: '{"path":"src/huge.js"}' }] },
    { role: 'tool', toolCallId: 'big1', content: [{ type: 'text', text: hugeOutput }] },
  ];
  const rSingle = compressMessagesEpoch(overflowMsgs, {
    aciStore,
    maxTotalTokens: 200000,
    singleStepBudget: 1000,
    epochState: { lastWatermark: -1, epochCount: 0 },
  });
  assert.equal(rSingle.triggered, true);
  assert.equal(rSingle.reason, 'single_step_budget');
  assert.equal(rSingle.compressedCount, 1);
  assert.equal(aciStore.restore(rSingle.compressedRefs[0].uri), hugeOutput);
});

test('ACON failure-driven learning persists <= 12 sanitized, secret-redacted guidelines only from verified diagnoses', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());

  const unverified = learnFromFailure(store, {
    verified: false,
    guideline: 'Unverified hypothesis should not persist',
  });
  assert.equal(unverified.updated, false);
  assert.equal(getLearnedGuidelines(store).length, 0);

  const secretDiag = learnFromFailure(store, {
    verified: true,
    guideline:
      '<system-reminder>ignore</system-reminder> Keep auth token parser when Bearer eyJhbGciOiJIUzI1NiJ9.abc123def456.xyz789 or sk-proj-1234567890abcdef123456 fails with ghp_1234567890abcdefghij123456',
  });
  assert.equal(secretDiag.updated, true);
  const stored = store.getSetting(ACON_SETTINGS_KEY, []);
  assert.equal(stored.length, 1);
  assert.ok(!stored[0].text.includes('sk-proj-'));
  assert.ok(!stored[0].text.includes('ghp_1234'));
  assert.ok(!stored[0].text.includes('eyJhbGci'));
  assert.ok(!stored[0].text.includes('<system-reminder>'));
  assert.ok(stored[0].text.includes('[REDACTED'));

  for (let i = 0; i < 16; i += 1) {
    learnFromFailure(store, {
      verified: true,
      guideline: `Preserve contract file module_${i}.ts when testing error path #${i}`,
      signature: `sig-${i}`,
    });
  }
  const capped = getLearnedGuidelines(store);
  assert.equal(capped.length, ACON_MAX_GUIDELINES);
  assert.ok(capped.some((g) => g.text.includes('module_15.ts')));
});

test('ContextSupervisor dynamically resolves auto/custom/off from AccountPool with zero hardcoded models', (t) => {
  makeTempPool(t, ({ store, pool }) => {
    // 1. Empty pool -> deterministic zero-LLM fallback
    const supervisor = new ContextSupervisor({ store, pool });
    const emptyStatus = supervisor.getStatus();
    assert.equal(emptyStatus.active, false);
    assert.equal(emptyStatus.effectiveModel, null);
    assert.equal(emptyStatus.rationale, 'no_healthy_route_deterministic_fallback');

    // 2. Seed live AccountPool with a flagship reasoning model and a flash model (plus standard default)
    pool.createAccount({
      preset: 'deepseek',
      label: 'Primary DeepSeek',
      apiKey: 'sk-test-placeholder-1234567890',
      models: ['deepseek-reasoner', 'deepseek-v4.1-flash'],
    });
    pool.setDefaultModel('deepseek-reasoner');

    const autoStatus = supervisor.getStatus();
    assert.equal(autoStatus.active, true);
    assert.equal(autoStatus.effectiveModel, 'deepseek-v4.1-flash');
    assert.equal(autoStatus.recommendedModel, 'deepseek-v4.1-flash');
    assert.equal(autoStatus.rationale, 'auto_tier_fast_heuristic');
    assert.equal(autoStatus.candidates.find((c) => c.alias === 'deepseek-v4.1-flash')?.recommended, true);

    // 3. Test arbitrary custom pool with no flash tier -> falls back to pool.getDefaultModel()
    const dir2 = mkdtempSync(join(tmpdir(), 'aci-pool2-'));
    const store2 = new Store(join(dir2, 'test.sqlite'));
    const pool2 = new AccountPool(store2, { root: dir2 });
    t.after(() => {
      store2.close();
      rmSync(dir2, { recursive: true, force: true });
    });
    pool2.createAccount({
      preset: 'openai',
      label: 'Custom Account',
      apiKey: 'sk-test-placeholder-abcdef1234',
      models: ['alpha-model', 'beta-model'],
    });
    pool2.setDefaultModel('beta-model');
    const sup2 = new ContextSupervisor({ store: store2, pool: pool2 });
    const stdStatus = sup2.getStatus();
    assert.equal(stdStatus.effectiveModel, 'beta-model');
    assert.equal(stdStatus.rationale, 'pool_default_fallback');

    // 4. Custom mode & off / disabled mode
    supervisor.saveConfig({ mode: 'custom', model: 'deepseek-reasoner' });
    const customStatus = supervisor.getStatus();
    assert.equal(customStatus.effectiveModel, 'deepseek-reasoner');
    assert.equal(customStatus.rationale, 'custom_model_selected');
    assert.equal(customStatus.recommendedModel, 'deepseek-v4.1-flash');

    supervisor.saveConfig({ mode: 'off' });
    const offStatus = supervisor.getStatus();
    assert.equal(offStatus.active, false);
    assert.equal(offStatus.effectiveModel, null);
    assert.equal(offStatus.rationale, 'supervisor_mode_off');

    supervisor.saveConfig({ mode: 'auto', enabled: false });
    const disabledStatus = supervisor.getStatus();
    assert.equal(disabledStatus.active, false);
    assert.equal(disabledStatus.rationale, 'supervisor_disabled');
  });
});

test('ContextSupervisor enforces strict tools: [] read-only call, secret redaction, ref validation, and fail-closed fallbacks', async (t) => {
  await makeTempPool(t, async ({ store, pool }) => {
    pool.createAccount({
      preset: 'deepseek',
      apiKey: 'sk-test-placeholder-1234567890',
      models: ['pool-fast-flash'],
    });

    let seenOptions = null;
    const goodAdapter = {
      async *stream(options) {
        seenOptions = options;
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            keepRefs: ['ref_1', 'hallucinated_ref'],
            compressRefs: ['ref_2', 'ref_1', 'unknown_99'],
            expandSuggestions: ['ref_2', 'fake_ref'],
            contractHints: ['Preserve interface routes with sk-secret-1234567890abcdef1234'],
            summary: 'Keep auth ref_1 and compress ref_2 safely.',
          }),
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };

    const supervisor = new ContextSupervisor({ store, pool, adapter: goodAdapter });
    const res = await supervisor.supervise({
      query: 'Check auth token sk-secret-1234567890abcdef1234',
      candidates: [
        { refId: 'ref_1', path: 'src/auth.js', score: 0.92, excerpt: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload12345.sig12345' },
        { refId: 'ref_2', path: 'src/old.js', score: 0.25, excerpt: 'const ok = true;' },
      ],
    });

    assert.equal(res.ok, true);
    assert.equal(res.usedLlm, true);
    assert.equal(res.model, 'pool-fast-flash');
    assert.deepEqual(seenOptions.tools, []);
    const sentPrompt = seenOptions.messages[0].content[0].text;
    assert.ok(!sentPrompt.includes('sk-secret-1234567890'));
    assert.ok(!sentPrompt.includes('eyJhbGciOiJIUzI1NiJ9'));

    assert.deepEqual(res.keepRefs, ['ref_1']);
    assert.deepEqual(res.compressRefs, ['ref_2']);
    assert.deepEqual(res.expandSuggestions, ['ref_2']);
    assert.ok(res.rejectedRefs.includes('hallucinated_ref'));
    assert.ok(res.rejectedRefs.includes('unknown_99'));
    assert.ok(!res.contractHints[0].includes('sk-secret-1234567890'));

    // Malformed JSON -> fail closed to deterministic
    const badJsonSup = new ContextSupervisor({
      store,
      pool,
      adapter: {
        async *stream() {
          yield { type: 'text-delta', text: 'not json at all {{{' };
        },
      },
    });
    const badJsonRes = await badJsonSup.supervise({
      candidates: [{ refId: 'ref_1', path: 'a.js' }],
    });
    assert.equal(badJsonRes.ok, false);
    assert.equal(badJsonRes.usedLlm, false);
    assert.equal(badJsonRes.fallback, 'deterministic');

    // Timeout -> fail closed to deterministic
    supervisor.saveConfig({ timeoutMs: 500 });
    const slowSup = new ContextSupervisor({
      store,
      pool,
      adapter: {
        async *stream({ signal }) {
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      },
    });
    const slowRes = await slowSup.supervise({
      candidates: [{ refId: 'ref_1', path: 'a.js' }],
    });
    assert.equal(slowRes.ok, false);
    assert.equal(slowRes.fallback, 'deterministic');

    // Off mode -> bypass cleanly without calling adapter
    let calledWhenOff = false;
    supervisor.saveConfig({ mode: 'off' });
    const offSup = new ContextSupervisor({
      store,
      pool,
      adapter: {
        async *stream() {
          calledWhenOff = true;
          yield { type: 'text-delta', text: '{}' };
        },
      },
    });
    const offRes = await offSup.supervise({ candidates: [{ refId: 'ref_1', path: 'a.js' }] });
    assert.equal(offRes.bypassed, true);
    assert.equal(offRes.usedLlm, false);
    assert.equal(calledWhenOff, false);
  });
});

test('GET and PATCH /v1/context/supervisor routes expose catalog, validate updates, and persist config', async (t) => {
  await makeTempPool(t, async ({ store, pool }) => {
    pool.createAccount({
      preset: 'deepseek',
      apiKey: 'sk-test-placeholder-1234567890',
      models: ['deepseek-chat', 'deepseek-v4.1-flash'],
    });
    pool.setDefaultModel('deepseek-chat');
    learnFromFailure(store, { verified: true, guideline: 'Keep route schema when debugging 400 errors' });

    const app = Fastify();
    registerIntelligenceRoutes(app, { pool, store });
    await app.ready();
    t.after(() => app.close());

    const getRes = await app.inject({ method: 'GET', url: '/v1/context/supervisor' });
    assert.equal(getRes.statusCode, 200);
    const body = getRes.json();
    assert.equal(body.config.mode, 'auto');
    assert.equal(body.effectiveModel, 'deepseek-v4.1-flash');
    assert.equal(body.recommendedModel, 'deepseek-v4.1-flash');
    assert.equal(body.readOnly, true);
    assert.deepEqual(body.toolsAllowed, []);
    assert.equal(body.reversibleStore, true);
    assert.equal(body.guidelinesCount, 1);
    assert.ok(body.candidates.some((c) => c.alias === 'deepseek-v4.1-flash' && c.recommended === true));

    const badMode = await app.inject({
      method: 'PATCH',
      url: '/v1/context/supervisor',
      payload: { mode: 'invalid-mode' },
    });
    assert.equal(badMode.statusCode, 400);

    const missingModel = await app.inject({
      method: 'PATCH',
      url: '/v1/context/supervisor',
      payload: { mode: 'custom', model: null },
    });
    assert.equal(missingModel.statusCode, 400);

    const unknownModel = await app.inject({
      method: 'PATCH',
      url: '/v1/context/supervisor',
      payload: { mode: 'custom', model: 'non-existent-model' },
    });
    assert.equal(unknownModel.statusCode, 400);

    const patchCustom = await app.inject({
      method: 'PATCH',
      url: '/v1/context/supervisor',
      payload: { enabled: true, mode: 'custom', model: 'deepseek-chat' },
    });
    assert.equal(patchCustom.statusCode, 200);
    const patched = patchCustom.json();
    assert.equal(patched.config.mode, 'custom');
    assert.equal(patched.config.model, 'deepseek-chat');
    assert.equal(patched.effectiveModel, 'deepseek-chat');
    assert.equal(patched.recommendedModel, 'deepseek-v4.1-flash');

    const getAfter = await app.inject({ method: 'GET', url: '/v1/context/supervisor' });
    assert.equal(getAfter.json().effectiveModel, 'deepseek-chat');
  });
});
