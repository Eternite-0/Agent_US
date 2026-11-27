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
  formatAciRefStub,
} from '../../src/context/aci-store.js';
import {
  ADMISSION_DECISIONS,
  PreInjectionAdmissionController,
  admitToolBatch,
  classifyCriticalDomains,
  isDecoyCue,
} from '../../src/context/aci-admission.js';
import {
  ACIEngine,
  ACON_MAX_GUIDELINES,
  ACON_SETTINGS_KEY,
  DEFAULT_DTOC_POLICY,
  DEFAULT_EPOCH_WATERMARKS,
  compressMessagesEpoch,
  evaluateRetrievalGate,
  expandContext,
  getLearnedGuidelines,
  learnFromFailure,
  refineCandidates,
  selectOffloadableAciCandidates,
  shouldTriggerAciEpoch,
} from '../../src/context/aci-engine.js';
import {
  ContextSupervisor,
  DEFAULT_ACI_SUPERVISOR_CONFIG,
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
    dtocPolicy: 'cumulative',
    epochState: { lastWatermark: -1, epochCount: 0 },
  });
  assert.equal(r0.triggered, false);
  assert.equal(r0.compressedCount, 0);
  assert.equal(r0.messages, baseMsgs);

  // Cross 60% watermark: maxTotalTokens = 3000 -> triggers Epoch 1
  const r1 = compressMessagesEpoch(baseMsgs, {
    aciStore,
    ledger,
    maxTotalTokens: 3000,
    dtocPolicy: 'cumulative',
    epochState: r0.epochState,
  });
  assert.equal(r1.triggered, true);
  assert.equal(r1.epoch, 1);
  assert.equal(r1.watermark, 0.6);
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
    dtocPolicy: 'cumulative',
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

test('Round 2: cumulativeUsedTokens triggers 160k epoch watermarks when single-step prompt stays small and keeps KV prefix warm between epochs', () => {
  const store = new Store(':memory:');
  try {
    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();
    const fillerRead = 'const entry = "module payload chunk";\n'.repeat(65);
    const msgs = [
      { role: 'system', content: [{ type: 'text', text: 'static system prompt' }] },
      { role: 'user', content: [{ type: 'text', text: 'inspect workspace modules' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'src/a.js' }) }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: fillerRead }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'glob', arguments: '{"pattern":"src/*.js"}' }] },
      { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'src/a.js' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c3', name: 'glob', arguments: '{"pattern":"test/*.js"}' }] },
      { role: 'tool', toolCallId: 'c3', content: [{ type: 'text', text: 'test/a.test.js' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c4', name: 'glob', arguments: '{"pattern":"*.json"}' }] },
      { role: 'tool', toolCallId: 'c4', content: [{ type: 'text', text: 'package.json' }] },
    ];
    const engine = new ACIEngine({
      store,
      aciStore,
      ledger,
      maxTotalTokens: 160000,
      contextWindow: 128000,
      dtocPolicy: 'cumulative',
    });

    const lowProbe = engine.inspectEpoch(msgs, { cumulativeUsedTokens: 20000, contextWindow: 128000 });
    assert.equal(lowProbe.triggered, false);

    const crossedProbe = engine.inspectEpoch(msgs, { cumulativeUsedTokens: 97000, contextWindow: 128000 });
    assert.equal(crossedProbe.triggered, true);
    assert.equal(crossedProbe.watermark, 0.6);

    const comp = engine.compress(msgs, { cumulativeUsedTokens: 97000, contextWindow: 128000, compressRefs: ['c1'] });
    assert.equal(comp.triggered, true);
    assert.equal(comp.epoch, 1);
    assert.equal(comp.compressedCount, 1);
    assert.equal(comp.pairClosedValid, true);
    assert.ok(comp.messages[3].content[0].text.startsWith('[ACI-REF artifact://'));

    const betweenProbe = engine.inspectEpoch(comp.messages, { cumulativeUsedTokens: 110000, contextWindow: 128000 });
    assert.equal(betweenProbe.triggered, false);
  } finally {
    store.close();
  }
});

test('Round 3: default [0.60, 0.82] watermarks, superseded pre-edit read offloading, post-edit protection, and 700/600 char thresholds', () => {
  assert.deepEqual([...DEFAULT_EPOCH_WATERMARKS], [0.6, 0.82]);
  const store = new Store(':memory:');
  try {
    const sup = new ContextSupervisor({ store });
    assert.deepEqual(sup.getConfig().epochWatermarks, [0.6, 0.82]);

    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();
    const preEditRead = 'export function calc(x) { return x + 1; }\n'.repeat(16); // ~672 chars (>= 600)
    const postEditRead = 'export function calc(x) { return x + 2; }\n'.repeat(20); // ~840 chars (>= 700)
    const smallGlob = 'src/calc.js\nsrc/other.js'; // < 700 chars
    const msgs = [
      { role: 'system', content: [{ type: 'text', text: 'static system' }] },
      { role: 'user', content: [{ type: 'text', text: 'fix calc.js' }] },
      // Step 1: pre-edit read of src/calc.js
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c-pre', name: 'read_file', arguments: JSON.stringify({ path: 'src/calc.js' }) }] },
      { role: 'tool', toolCallId: 'c-pre', content: [{ type: 'text', text: preEditRead }] },
      // Step 2: small glob (< 700 chars -> skipped) + write_file rewriting src/calc.js (supersedes c-pre!)
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'c-small', name: 'glob', arguments: '{"pattern":"src/*.js"}' },
          { type: 'tool-call', id: 'c-edit', name: 'write_file', arguments: JSON.stringify({ path: 'src/calc.js', content: 'export function calc(x) { return x + 2; }\n' }) },
        ],
      },
      { role: 'tool', toolCallId: 'c-small', content: [{ type: 'text', text: smallGlob }] },
      { role: 'tool', toolCallId: 'c-edit', content: [{ type: 'text', text: 'wrote src/calc.js' }] },
      // Step 3: post-edit read of src/calc.js + non-error grep
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c-post', name: 'read_file', arguments: JSON.stringify({ path: 'src/calc.js' }) }] },
      { role: 'tool', toolCallId: 'c-post', content: [{ type: 'text', text: postEditRead }] },
    ];
    // At step 3: age of c-pre = 3 - 1 = 2 (>= 2) and superseded (< write_file step 2); c-post is at step 3 (>= 2) -> protected!
    const candidates = selectOffloadableAciCandidates(msgs, { activeMutationTargets: ['src/calc.js'] });
    assert.deepEqual(candidates.map((c) => c.id), ['c-pre']);
    assert.equal(candidates[0].superseded, true);
    assert.ok(candidates[0].chars >= 600);

    const engine = new ACIEngine({
      store,
      aciStore,
      ledger,
      maxTotalTokens: 160000,
      contextWindow: 128000,
      dtocPolicy: 'cumulative',
    });
    const comp = engine.compress(msgs, { cumulativeUsedTokens: 97000, activeMutationTargets: ['src/calc.js'] });
    assert.equal(comp.triggered, true);
    assert.equal(comp.compressedCount, 1);
    assert.equal(comp.pairClosedValid, true);
    assert.ok(comp.messages[3].content[0].text.startsWith('[ACI-REF artifact://'));
    assert.equal(comp.messages[8].content[0].text, postEditRead, 'post-edit read_file must stay verbatim');
    assert.equal(aciStore.restore(comp.compressedRefs[0].uri), preEditRead);
  } finally {
    store.close();
  }
});

test('Stage 4: ReversibleContextStore restoreVerified checks SHA-256, throws ARTIFACT_HASH_MISMATCH on tamper, and ContextEvidenceLedger computes governance metrics', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());

  const aciStore = new ReversibleContextStore(store);
  const ledger = new ContextEvidenceLedger();
  const payload = 'export function verifyJwt(token) {\n  return token.startsWith("valid_");\n}\n';
  const ref = aciStore.put(payload, {
    toolName: 'read_file',
    path: 'src/auth/jwt.js',
    lineRange: 'L1-3',
    symbolOutline: ['verifyJwt@L1'],
    step: 1,
    decision: 'SUPPORTING',
  });

  // Enhanced formatAciRefStub checks
  assert.ok(ref.stubText.includes('SUPPORTING'));
  assert.ok(ref.stubText.includes(ref.uri));
  assert.ok(ref.stubText.includes('src/auth/jwt.js'));
  assert.ok(ref.stubText.includes('L1-3'));
  assert.ok(ref.stubText.includes('verifyJwt@L1'));
  assert.ok(ref.stubText.includes(`~${ref.originalTokens} tok`));
  assert.ok(ref.stubText.includes(`expand_context({ ref: "${ref.uri}", startLine, endLine })`));

  const customStub = formatAciRefStub(ref, { decision: 'DUPLICATE', priorStep: 2 });
  assert.ok(customStub.includes('DUPLICATE'));
  assert.ok(customStub.includes('prior step=2'));

  // findByPathAndHash & findActiveByHash
  assert.equal(aciStore.findByPathAndHash('./src/auth/jwt.js', ref.sha256)?.refId, ref.refId);
  assert.equal(aciStore.findActiveByHash(ref.sha256)?.refId, ref.refId);

  // Valid restoreVerified
  const verified = aciStore.restoreVerified(ref.refId, { expectedSha256: ref.sha256 });
  assert.equal(verified.content, payload);
  assert.equal(verified.sha256, ref.sha256);
  assert.equal(verified.verified, true);
  assert.equal(verified.refId, ref.refId);
  assert.equal(verified.uri, ref.uri);
  assert.equal(verified.path, 'src/auth/jwt.js');
  assert.equal(aciStore.getRef(ref.refId).restoredCount, 1);

  // Wrong expectedSha256 -> ARTIFACT_HASH_MISMATCH without incrementing restoredCount
  assert.throws(
    () => aciStore.restoreVerified(ref.refId, { expectedSha256: '0'.repeat(64) }),
    (err) => err?.code === 'ARTIFACT_HASH_MISMATCH' && err?.status === 500,
  );
  assert.equal(aciStore.getRef(ref.refId).restoredCount, 1);

  // Tamper SQLite blob content -> ARTIFACT_HASH_MISMATCH
  store.db.prepare('UPDATE blobs SET content=? WHERE sha256=?').run('tampered content!', ref.sha256);
  assert.throws(
    () => aciStore.restoreVerified(ref.uri),
    (err) => err?.code === 'ARTIFACT_HASH_MISMATCH' && err?.status === 500,
  );
  assert.equal(aciStore.getRef(ref.refId).restoredCount, 1);

  // invalidatePath clears active hash lookup
  aciStore.invalidatePath('src/auth/jwt.js');
  assert.equal(aciStore.findByPathAndHash('src/auth/jwt.js', ref.sha256), null);

  // ContextEvidenceLedger Stage 4 governance metrics
  ledger.recordAdmission({
    refId: null,
    uri: 'artifact://' + 'a'.repeat(64),
    sha256: 'a'.repeat(64),
    path: 'src/auth/jwt.js',
    toolName: 'read_file',
    decision: 'DIRECT',
    criticalDomains: ['auth'],
    score: 0.95,
    originalTokens: 800,
    injectedTokens: 800,
    step: 1,
    reason: 'prompt_target',
  });
  ledger.recordAdmission({
    refId: 'aci_defer',
    uri: 'artifact://' + 'b'.repeat(64),
    sha256: 'b'.repeat(64),
    path: 'src/persistence/repo.js',
    toolName: 'read_file',
    decision: 'DEFER',
    criticalDomains: ['persistence'],
    score: 0.45,
    originalTokens: 1200,
    injectedTokens: 120,
    step: 1,
    reason: 'deferred_outline',
  });
  ledger.recordAdmission({
    refId: 'aci_noise',
    uri: 'artifact://' + 'c'.repeat(64),
    sha256: 'c'.repeat(64),
    path: 'src/utils/noise.js',
    toolName: 'read_file',
    decision: 'IRRELEVANT',
    criticalDomains: [],
    score: 0,
    originalTokens: 2000,
    injectedTokens: 40,
    step: 1,
    reason: 'zero_signal_noise',
  });
  ledger.recordRecovery({
    refId: 'aci_defer',
    uri: 'artifact://' + 'b'.repeat(64),
    sha256: 'b'.repeat(64),
    path: 'src/persistence/repo.js',
    level: 'hunk',
    verified: true,
    tokensRestored: 300,
    triggeredBy: 'expand_context',
    step: 2,
  });
  ledger.recordSupervisorCall({
    stage: 'admission',
    model: 'fast-test-model',
    candidateCount: 2,
    decisions: [{ id: 'tc1', decision: 'DEFER' }],
    inputTokens: 400,
    outputTokens: 60,
    durationMs: 25,
    ok: true,
    step: 1,
  });
  ledger.recordOutcome({ status: 'completed', verifiedPass: true, steps: 2 });

  const gov = ledger.computeGovernanceMetrics({
    groundTruthCriticalFiles: ['src/auth/jwt.js', 'src/persistence/repo.js'],
    groundTruthRelevantFiles: ['src/auth/jwt.js', 'src/persistence/repo.js'],
    groundTruthNoiseFiles: ['src/utils/noise.js'],
  });
  assert.equal(gov.criticalContextRecall, 1);
  assert.equal(gov.falseNegativeRate, 0);
  assert.equal(gov.contextPrecision, 1);
  assert.ok(gov.usefulTokenRatio > 0.95);
  assert.ok(gov.admissionTokenReduction > 0.7);
  assert.deepEqual(gov.decisionCounts, {
    DIRECT: 1,
    SUPPORTING: 0,
    DEFER: 1,
    DUPLICATE: 0,
    IRRELEVANT: 1,
  });
  assert.equal(gov.supervisorCost.calls, 1);
  assert.equal(gov.supervisorCost.totalTokens, 460);
  assert.equal(gov.recoveryStats.totalRecoveries, 1);
  assert.equal(gov.recoveryStats.hashVerifiedCount, 1);
  assert.equal(ledger.taskOutcome.status, 'completed');
});

test('Stage 4: classifyCriticalDomains detects 5 protected domains, suppresses decoys, and admission handles all 5 decisions + batched Supervisor guardrail', async (t) => {
  await makeTempPool(t, async ({ store, pool }) => {
    pool.createAccount({
      preset: 'deepseek',
      apiKey: 'sk-test-placeholder-1234567890',
      models: ['main-model', 'fast-supervisor'],
    });
    pool.setDefaultModel('main-model');

    // 1. Critical domains & decoy cues
    const authRes = classifyCriticalDomains({
      path: 'src/auth/session.js',
      content: 'export function verifyToken(jwt) { return true; }',
    });
    assert.ok(authRes.domains.includes('auth'));
    assert.equal(authRes.isDecoy, false);

    const permRes = classifyCriticalDomains({
      path: 'src/policy/rbac.js',
      content: 'export function checkPermission(role) { return role === "admin"; }',
    });
    assert.ok(permRes.domains.includes('permission'));

    const persistRes = classifyCriticalDomains({
      path: 'src/db/sqlite-store.js',
      content: 'const db = new DatabaseSync(); db.prepare("SELECT 1");',
    });
    assert.ok(persistRes.domains.includes('persistence'));

    const contractRes = classifyCriticalDomains({
      path: 'src/api/routes/users-schema.ts',
      content: 'export interface UserContract { id: string; }',
    });
    assert.ok(contractRes.domains.includes('contract'));

    const hiddenRes = classifyCriticalDomains({
      path: 'test/acceptance/invariants.test.js',
      content: 'assert.equal(1, 1);',
    });
    assert.ok(hiddenRes.domains.includes('hidden_acceptance'));

    assert.equal(isDecoyCue('src/legacy/auth-v0.js', ''), true);
    assert.equal(isDecoyCue('docs/CHANGELOG.md', '# Changelog'), false);
    assert.equal(isDecoyCue('src/notes.js', '// @deprecated v1-compat shim'), false);
    assert.equal(isDecoyCue('src/archived-banner.js', '// DO NOT EDIT - ARCHIVED DECOY\nexport const x = 1;'), true);
    const decoyAuth = classifyCriticalDomains({
      path: 'src/legacy/auth-v0.js',
      content: 'export function verifyToken() { return false; }',
    });
    assert.equal(decoyAuth.isDecoy, true);
    assert.deepEqual(decoyAuth.domains, []);
    assert.ok(decoyAuth.rawDomains.includes('auth'));

    // 2. Admission fast-paths, DUPLICATE with wrapped envelopes, batched Supervisor, and Critical Protection Guardrail
    let supAdmitCalls = 0;
    const adapter = {
      async *stream(opts) {
        assert.deepEqual(opts.tools, [], 'Admission supervisor must run with tools: []');
        supAdmitCalls += 1;
        const payload = JSON.parse(opts.messages[0].content[0].text);
        const decisions = payload.candidates.map((c) => {
          if (c.path.includes('auth/guard.js')) {
            // Attempt malicious/mistaken downgrade of a non-decoy auth critical file to IRRELEVANT -> guardrail must clamp!
            return {
              id: c.id,
              decision: 'IRRELEVANT',
              focusSymbols: ['verifySignature'],
              reason: 'mistaken downgrade attempt',
            };
          }
          if (c.path.includes('legacy/')) {
            return { id: c.id, decision: 'IRRELEVANT', reason: 'legacy decoy' };
          }
          return { id: c.id, decision: 'DEFER', reason: 'large secondary helper' };
        });
        decisions.push({ id: 'hallucinated_id', decision: 'DIRECT', reason: 'ignore' });
        yield {
          type: 'text-delta',
          text: JSON.stringify({ decisions, contractHints: ['Keep auth verifySignature'] }),
        };
        yield { type: 'usage', usage: { inputTokens: 320, outputTokens: 85 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };

    const supervisor = new ContextSupervisor({ store, pool, adapter });
    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();
    const controller = new PreInjectionAdmissionController({ aciStore, ledger, workingSetReadMaxChars: 2600 });

    const authGuardCode =
      Array.from({ length: 120 }, (_, i) => `export function helperAuth${i}(x) { return x + ${i}; }`).join('\n') +
      '\nexport function verifySignature(token) {\n  if (!token) throw new Error("BAD_SIG");\n  return token.startsWith("sig_");\n}\n';
    const largeHelperCode =
      'import { targetEntry } from "./target.js";\n' +
      Array.from({ length: 85 }, (_, i) => `export function utilTask${i}(v) { return targetEntry(v) + ${i}; }`).join('\n');
    const largeNoiseCode = Array.from(
      { length: 80 },
      (_, i) => `export const staticBannerLine${i} = "completely unrelated lorem ipsum payload ${i}";`,
    ).join('\n');
    const legacyDecoyCode =
      '// @deprecated legacy v0 auth shim\n' +
      Array.from({ length: 45 }, (_, i) => `export function legacyAuth${i}() { return ${i}; }`).join('\n');
    const promptTargetCode =
      'export function targetEntry(x) {\n  return x * 2;\n}\n' + '// target padding line for duplicate test\n'.repeat(42);

    const wrapWithSeq = (seq, body) =>
      `<untrusted id="deadbeef000011112222333344445555-tool-read_file-${seq}" bytes="${Buffer.byteLength(body, 'utf8')}">${body}</untrusted id="deadbeef000011112222333344445555-tool-read_file-${seq}">`;

    const batch1 = [
      // Small payload -> fast-path DIRECT (0 supervisor cost)
      {
        tc: { id: 'tc-small', name: 'read_file', arguments: JSON.stringify({ path: 'src/small.js' }) },
        parsedArgs: { path: 'src/small.js' },
        output: 'export const tiny = 1;',
        isError: false,
      },
      // Error output -> fast-path DIRECT
      {
        tc: { id: 'tc-err', name: 'bash', arguments: JSON.stringify({ command: 'node --test' }) },
        parsedArgs: { command: 'node --test' },
        output: 'exitCode: 1\nAssertionError: failed\n' + 'stack\n'.repeat(150),
        isError: true,
      },
      // Narrow slice <= 120 lines -> fast-path DIRECT
      {
        tc: { id: 'tc-slice', name: 'read_file', arguments: JSON.stringify({ path: 'src/sliced.js', startLine: 10, endLine: 50 }) },
        parsedArgs: { path: 'src/sliced.js', startLine: 10, endLine: 50 },
        output: wrapWithSeq(1, `File: src/sliced.js (lines 10-50 of 200)\n${'10: const a = 1;\n'.repeat(90)}`),
        isError: false,
      },
      // Prompt-cited target <= 6000 chars -> fast-path DIRECT
      {
        tc: { id: 'tc-prompt', name: 'read_file', arguments: JSON.stringify({ path: 'src/target.js' }) },
        parsedArgs: { path: 'src/target.js' },
        output: wrapWithSeq(2, promptTargetCode),
        isError: false,
      },
      // Zero-signal noise -> fast-path IRRELEVANT (1-line stub, zero supervisor cost)
      {
        tc: { id: 'tc-noise', name: 'read_file', arguments: JSON.stringify({ path: 'src/unrelated/banner.js' }) },
        parsedArgs: { path: 'src/unrelated/banner.js' },
        output: wrapWithSeq(3, largeNoiseCode),
        isError: false,
      },
      // Ambiguous/large candidates sent in ONE batched supervisor call:
      // 1) Non-decoy auth file -> supervisor tries IRRELEVANT -> Critical Guardrail upgrades to SUPPORTING!
      {
        tc: { id: 'tc-auth', name: 'read_file', arguments: JSON.stringify({ path: 'src/auth/guard.js' }) },
        parsedArgs: { path: 'src/auth/guard.js' },
        output: wrapWithSeq(4, authGuardCode),
        isError: false,
      },
      // 2) Large multi-section helper -> supervisor returns DEFER
      {
        tc: { id: 'tc-helper', name: 'read_file', arguments: JSON.stringify({ path: 'src/utils/helpers.js' }) },
        parsedArgs: { path: 'src/utils/helpers.js' },
        output: wrapWithSeq(5, largeHelperCode),
        isError: false,
      },
      // 3) Legacy auth decoy -> supervisor returns IRRELEVANT
      {
        tc: { id: 'tc-decoy', name: 'read_file', arguments: JSON.stringify({ path: 'src/legacy/auth-v0.js' }) },
        parsedArgs: { path: 'src/legacy/auth-v0.js' },
        output: wrapWithSeq(6, legacyDecoyCode),
        isError: false,
      },
    ];

    const res1 = await controller.admitBatch(batch1, {
      query: 'Fix targetEntry in src/target.js and verifySignature',
      step: 1,
      supervisor,
      supervisorEnabled: true,
    });

    assert.equal(supAdmitCalls, 1, 'Batch with multiple ambiguous candidates must trigger at most 1 Supervisor call');
    const byId = Object.fromEntries(res1.admittedItems.map((it) => [it.tc.id, it]));
    assert.equal(byId['tc-small'].admission.decision, ADMISSION_DECISIONS.DIRECT);
    assert.equal(byId['tc-err'].admission.decision, ADMISSION_DECISIONS.DIRECT);
    assert.equal(byId['tc-slice'].admission.decision, ADMISSION_DECISIONS.DIRECT);
    assert.equal(byId['tc-prompt'].admission.decision, ADMISSION_DECISIONS.DIRECT);
    // Non-decoy zero-signal bursts that clear the requery gate fold reversibly to DEFER (never IRRELEVANT)
    assert.equal(byId['tc-noise'].admission.decision, ADMISSION_DECISIONS.DEFER);
    assert.match(byId['tc-noise'].admittedOutput, /expand_context/);
    assert.ok(byId['tc-noise'].admittedOutput.length < batch1[4].output.length);

    // Critical guardrail protected src/auth/guard.js -> SUPPORTING with verifySignature hunk + outline + artifact://
    assert.equal(byId['tc-auth'].admission.decision, ADMISSION_DECISIONS.SUPPORTING);
    assert.match(byId['tc-auth'].admittedOutput, /verifySignature/);
    assert.match(byId['tc-auth'].admittedOutput, /artifact:\/\//);
    assert.ok(byId['tc-auth'].admittedOutput.length < batch1[5].output.length);

    // DEFER keeps imports + symbol map + expand_context hint
    assert.equal(byId['tc-helper'].admission.decision, ADMISSION_DECISIONS.DEFER);
    assert.match(byId['tc-helper'].admittedOutput, /Imports:/);
    assert.match(byId['tc-helper'].admittedOutput, /Symbols:/);
    assert.match(byId['tc-helper'].admittedOutput, /expand_context/);
    assert.ok(byId['tc-helper'].admittedOutput.length < batch1[6].output.length);

    // Decoy suppressed to IRRELEVANT
    assert.equal(byId['tc-decoy'].admission.decision, ADMISSION_DECISIONS.IRRELEVANT);
    assert.ok(byId['tc-decoy'].admittedOutput.length < batch1[7].output.length);

    // Supervisor cost recorded accurately
    assert.equal(ledger.supervisorCalls.length, 1);
    assert.equal(ledger.supervisorCalls[0].inputTokens, 320);
    assert.equal(ledger.supervisorCalls[0].outputTokens, 85);

    // 3. Re-reading unchanged src/target.js with a DIFFERENT wrapper seq -> DUPLICATE!
    const res2 = await controller.admitBatch(
      [
        {
          tc: { id: 'tc-dup', name: 'read_file', arguments: JSON.stringify({ path: 'src/target.js' }) },
          parsedArgs: { path: 'src/target.js' },
          output: wrapWithSeq(99, promptTargetCode),
          isError: false,
        },
      ],
      { query: 'Fix targetEntry in src/target.js', step: 2, supervisor, supervisorEnabled: true },
    );
    assert.equal(res2.admittedItems[0].admission.decision, ADMISSION_DECISIONS.DUPLICATE);
    assert.match(res2.admittedItems[0].admittedOutput, /prior step=1/);
    assert.ok(res2.admittedItems[0].admittedOutput.length < wrapWithSeq(99, promptTargetCode).length);

    // 4. After edit_file invalidates src/target.js, re-reading is NOT DUPLICATE!
    const res3 = await controller.admitBatch(
      [
        {
          tc: { id: 'tc-edit', name: 'edit_file', arguments: JSON.stringify({ path: 'src/target.js' }) },
          parsedArgs: { path: 'src/target.js' },
          output: '已成功编辑 src/target.js',
          isError: false,
        },
        {
          tc: { id: 'tc-reread', name: 'read_file', arguments: JSON.stringify({ path: 'src/target.js' }) },
          parsedArgs: { path: 'src/target.js' },
          output: wrapWithSeq(105, promptTargetCode.replace('x * 2', 'x * 3')),
          isError: false,
        },
      ],
      { query: 'Fix targetEntry in src/target.js', step: 3, supervisor, supervisorEnabled: true },
    );
    assert.equal(res3.admittedItems[0].admission.decision, ADMISSION_DECISIONS.DIRECT);
    assert.equal(res3.admittedItems[1].admission.decision, ADMISSION_DECISIONS.DIRECT);

    // 5. Supervisor Fail-Closed (malformed JSON + tool-call attempt) falls back deterministically
    const badJsonSup = new ContextSupervisor({
      store,
      pool,
      adapter: {
        async *stream() {
          yield { type: 'text-delta', text: 'not valid json {{{' };
        },
      },
    });
    const badRes = await badJsonSup.admitCandidates({
      query: 'test',
      candidates: [{ id: 'c1', path: 'src/a.js', chars: 2000 }],
    });
    assert.equal(badRes.ok, false);
    assert.equal(badRes.fallback, 'deterministic');
    assert.ok(badRes.inputTokens > 0);

    const toolCallSup = new ContextSupervisor({
      store,
      pool,
      adapter: {
        async *stream() {
          yield { type: 'tool-call', id: 'bad', name: 'bash', arguments: '{}' };
        },
      },
    });
    const toolRes = await toolCallSup.admitCandidates({
      query: 'test',
      candidates: [{ id: 'c1', path: 'src/a.js', chars: 2000 }],
    });
    assert.equal(toolRes.ok, false);
    assert.equal(toolRes.fallback, 'deterministic');
    assert.match(toolRes.error, /tool invocation/i);
  });
});

test('Stage 4: adaptive_single_step DTOC preserves short-task KV cache at tokensBefore ~5k even when cumulativeUsedTokens=100k', () => {
  assert.equal(DEFAULT_DTOC_POLICY, 'adaptive_single_step');
  const store = new Store(':memory:');
  try {
    const fillerRead = 'export const payloadItem = "short task module data";\n'.repeat(65); // ~3500 chars (~900 tok)
    const msgs = [
      { role: 'system', content: [{ type: 'text', text: 'static system prompt' }] },
      { role: 'user', content: [{ type: 'text', text: 'inspect workspace' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'src/a.js' }) }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: fillerRead }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'glob', arguments: '{"pattern":"src/*.js"}' }] },
      { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'src/a.js' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c3', name: 'glob', arguments: '{"pattern":"test/*.js"}' }] },
      { role: 'tool', toolCallId: 'c3', content: [{ type: 'text', text: 'test/a.test.js' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c4', name: 'glob', arguments: '{"pattern":"*.json"}' }] },
      { role: 'tool', toolCallId: 'c4', content: [{ type: 'text', text: 'package.json' }] },
    ];

    const engine = new ACIEngine({
      store,
      maxTotalTokens: 160000,
      contextWindow: 128000,
      dtocMinPromptTokens: 24000,
    });

    // Short task (~1k-5k prompt tokens) with cumulativeUsedTokens=100k MUST NOT trigger DTOC!
    const shortProbe = engine.inspectEpoch(msgs, { cumulativeUsedTokens: 100000 });
    assert.equal(shortProbe.dtocPolicy, 'adaptive_single_step');
    assert.equal(shortProbe.triggered, false);
    assert.equal(shortProbe.watermarkTriggered, false);
    assert.equal(shortProbe.emergencyTriggered, false);

    const shortComp = engine.compress(msgs, { cumulativeUsedTokens: 100000 });
    assert.equal(shortComp.triggered, false);
    assert.equal(shortComp.compressedCount, 0);
    assert.equal(shortComp.messages, msgs);

    // True high single-step pressure (>= min(24000, 0.45*contextWindow) and >= 0.60 * contextWindow) DOES trigger!
    const hugeTool = 'const largeEntry = "long module line";\n'.repeat(2100);
    const heavyMsgs = [
      { role: 'system', content: [{ type: 'text', text: 'static system prompt' }] },
      { role: 'user', content: [{ type: 'text', text: 'analyze huge file' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'big1', name: 'read_file', arguments: JSON.stringify({ path: 'src/huge.js' }) }] },
      { role: 'tool', toolCallId: 'big1', content: [{ type: 'text', text: hugeTool }] },
    ];
    const heavyEngine = new ACIEngine({
      store,
      maxTotalTokens: 200000,
      contextWindow: 32000,
      dtocMinPromptTokens: 24000,
      singleStepBudget: 50000,
    });
    const heavyProbe = heavyEngine.inspectEpoch(heavyMsgs, { cumulativeUsedTokens: 0 });
    assert.ok(heavyProbe.tokensBefore >= 14400);
    assert.equal(heavyProbe.watermarkTriggered, true);
    assert.equal(heavyProbe.triggered, true);

    // Emergency remaining budget branch (>= 12k tokensBefore & remaining <= 2.5 * tokensBefore) triggers!
    const mediumTool = 'export const medItem = "medium chunk data for emergency budget test";\n'.repeat(800);
    const mediumMsgs = [
      { role: 'system', content: [{ type: 'text', text: 'static system prompt' }] },
      { role: 'user', content: [{ type: 'text', text: 'check medium file' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'm1', name: 'read_file', arguments: JSON.stringify({ path: 'src/med.js' }) }] },
      { role: 'tool', toolCallId: 'm1', content: [{ type: 'text', text: mediumTool }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'm2', name: 'glob', arguments: '{"pattern":"*"}' }] },
      { role: 'tool', toolCallId: 'm2', content: [{ type: 'text', text: 'src/med.js' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'm3', name: 'glob', arguments: '{"pattern":"*"}' }] },
      { role: 'tool', toolCallId: 'm3', content: [{ type: 'text', text: 'package.json' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'm4', name: 'glob', arguments: '{"pattern":"*"}' }] },
      { role: 'tool', toolCallId: 'm4', content: [{ type: 'text', text: 'README.md' }] },
    ];
    const emergencyEngine = new ACIEngine({
      store,
      maxTotalTokens: 160000,
      contextWindow: 128000,
      singleStepBudget: 50000,
    });
    const emProbe = emergencyEngine.inspectEpoch(mediumMsgs, { cumulativeUsedTokens: 135000 });
    assert.ok(emProbe.tokensBefore >= 12000);
    assert.equal(emProbe.emergencyTriggered, true);
    assert.equal(emProbe.triggered, true);

    const emComp = emergencyEngine.compress(mediumMsgs, { cumulativeUsedTokens: 135000 });
    assert.equal(emComp.triggered, true);
    assert.equal(emComp.reason, 'emergency_budget');
    assert.equal(emComp.compressedCount, 1);
  } finally {
    store.close();
  }
});

test('Stage 4 calibration: ACI-SKIP stubs, json_key outline + >2600 CONTRACT.json SUPPORTING, mixed grep decoy, one-shot emergencyUsed, and supervisor stream usage dedupe', async (t) => {
  assert.equal(DEFAULT_ACI_SUPERVISOR_CONFIG.timeoutMs, 8000);

  await makeTempPool(t, async ({ store, pool }) => {
    pool.createAccount({
      preset: 'deepseek',
      apiKey: 'sk-test-placeholder-1234567890',
      models: ['main-model', 'calib-flash-model'],
    });
    pool.setDefaultModel('calib-flash-model');

    const aciStore = new ReversibleContextStore(store);
    const ledger = new ContextEvidenceLedger();

    // (a) ACI-SKIP stubs omit expand_context bait on IRRELEVANT & DUPLICATE while preserving ACI-REF on DEFER/SUPPORTING
    const sampleRef = aciStore.put('export const a = 1;\n', {
      path: 'src/noise.js',
      toolName: 'read_file',
      lineRange: 'L1-2',
      symbolOutline: ['a@L1'],
      step: 1,
    });
    const irrStd = formatAciRefStub(sampleRef, { decision: 'IRRELEVANT' });
    const irrCmp = formatAciRefStub(sampleRef, { decision: 'IRRELEVANT', compact: true });
    assert.ok(irrStd.startsWith('[ACI-SKIP '));
    assert.ok(irrCmp.startsWith('[ACI-SKIP '));
    assert.ok(!irrStd.includes('expand_context'));
    assert.ok(!irrCmp.includes('expand_context'));

    const dupStd = formatAciRefStub(sampleRef, { decision: 'DUPLICATE', priorStep: 3 });
    const dupCmp = formatAciRefStub(sampleRef, { decision: 'DUPLICATE', priorStep: 3, compact: true });
    assert.ok(dupStd.startsWith('[ACI-SKIP '));
    assert.ok(dupCmp.startsWith('[ACI-SKIP '));
    assert.ok(dupStd.includes('prior step=3'));
    assert.ok(dupCmp.includes('prior step=3'));
    assert.ok(!dupStd.includes('expand_context'));
    assert.ok(!dupCmp.includes('expand_context'));

    const defStub = formatAciRefStub(sampleRef, { decision: 'DEFER' });
    const supStub = formatAciRefStub(sampleRef, { decision: 'SUPPORTING' });
    assert.ok(defStub.startsWith('[ACI-REF '));
    assert.ok(defStub.includes('expand_context('));
    assert.ok(supStub.startsWith('[ACI-REF '));
    assert.ok(supStub.includes('expand_context('));

    // (b) JSON key outline extraction + >2600 prompt-cited CONTRACT.json enters SUPPORTING with compressed body & verbatim recovery
    // (e) Multiple usage chunks across distinct usageRequestId values must NOT multiply inputTokens
    let observedSupTokens = null;
    const calibAdapter = {
      async *stream(opts) {
        const payload = JSON.parse(opts.messages[0].content[0].text);
        const decisions = payload.candidates.map((c) => ({
          id: c.id,
          // Supervisor attempts IRRELEVANT on CONTRACT.json -> Critical Guardrail clamps to SUPPORTING
          decision: 'IRRELEVANT',
          focusSymbols: ['precedence', 'normalizationRules'],
          reason: 'calibration test',
        }));
        for (let idx = 0; idx < 4; idx += 1) {
          yield {
            type: 'usage',
            usageRequestId: `sup-chunk-${idx}`,
            usage: { inputTokens: 756, outputTokens: 80 + idx * 15 },
          };
        }
        yield { type: 'text-delta', text: JSON.stringify({ decisions, contractHints: [] }) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
    const supervisor = new ContextSupervisor({ store, pool, adapter: calibAdapter });
    const controller = new PreInjectionAdmissionController({ aciStore, ledger, workingSetReadMaxChars: 2600 });

    const contractObj = {
      contractVersion: '2.4.0',
      precedence: ['schema', 'normalizer', 'overrides', 'defaults'],
      normalizationRules: Array.from({ length: 35 }, (_, i) => ({
        ruleId: `rule_${i}`,
        field: `field_${i}`,
        description: `Deterministic normalization step ${i} requiring exact precedence order`,
      })),
    };
    const contractText = JSON.stringify(contractObj, null, 2);
    assert.ok(contractText.length > 2600);
    const shortSpec = '# SPEC\nKeep normalizer precedence.\n' + '- Rule item\n'.repeat(120); // ~1850 chars <= 2600
    assert.ok(shortSpec.length <= 2600);

    const wrap = (seq, body) =>
      `<untrusted id="deadbeef000011112222333344445555-tool-read_file-${seq}" bytes="${Buffer.byteLength(body, 'utf8')}">${body}</untrusted id="deadbeef000011112222333344445555-tool-read_file-${seq}">`;

    const admitRes = await controller.admitBatch(
      [
        {
          tc: { id: 'tc-spec', name: 'read_file', arguments: JSON.stringify({ path: 'SPEC.md' }) },
          parsedArgs: { path: 'SPEC.md' },
          output: wrap(1, shortSpec),
          isError: false,
        },
        {
          tc: { id: 'tc-contract', name: 'read_file', arguments: JSON.stringify({ path: 'CONTRACT.json' }) },
          parsedArgs: { path: 'CONTRACT.json' },
          output: wrap(2, contractText),
          isError: false,
        },
      ],
      { query: 'Update CONTRACT.json precedence per SPEC.md', step: 1, supervisor, supervisorEnabled: true },
    );

    const byId = Object.fromEntries(admitRes.admittedItems.map((it) => [it.tc.id, it]));
    assert.equal(byId['tc-spec'].admission.decision, ADMISSION_DECISIONS.DIRECT);
    assert.equal(byId['tc-contract'].admission.decision, ADMISSION_DECISIONS.SUPPORTING);
    assert.match(byId['tc-contract'].admittedOutput, /\[json_key\]/);
    assert.match(byId['tc-contract'].admittedOutput, /Expand omitted lines: expand_context\(/);
    assert.ok(byId['tc-contract'].admittedOutput.length < wrap(2, contractText).length);

    const uriMatch = byId['tc-contract'].admittedOutput.match(/artifact:\/\/[0-9a-f]{64}/);
    assert.ok(uriMatch);
    const restored = aciStore.restoreVerified(uriMatch[0]);
    assert.equal(restored.verified, true);
    assert.ok(restored.content.includes('"contractVersion": "2.4.0"'));

    observedSupTokens = ledger.supervisorCalls[0];
    assert.equal(observedSupTokens.inputTokens, 756, 'must deduplicate cumulative usage across usageRequestId chunks');
    assert.equal(observedSupTokens.outputTokens, 125);
    assert.equal(observedSupTokens.totalTokens, 881);

    // (c) Mixed active+legacy grep: output must not be marked decoy; pure legacy grep: output is decoy
    assert.equal(
      isDecoyCue(
        'grep:precedence',
        'src/pipeline/normalizer.js:12: const precedence = [];\nsrc/legacy/v0-normalizer.js:4: // @deprecated',
      ),
      false,
    );
    assert.equal(
      isDecoyCue(
        'grep:legacy',
        'src/legacy/v0-normalizer.js:4: // @deprecated\nsrc/v1-compat/shim.js:2: // legacy fallback',
      ),
      true,
    );
    assert.equal(isDecoyCue('glob:**/*.js', '   \n  '), false);

    // (d) One-shot emergencyUsed prevents consecutive-step emergency_budget thrashing,
    // and 0-compressed compressMessagesEpoch preserves epochCount while marking emergencyUsed
    const mediumTool = 'export const medItem = "medium chunk data for emergency budget test";\n'.repeat(800);
    const emergencyMsgs = [
      { role: 'system', content: [{ type: 'text', text: 'static system prompt' }] },
      { role: 'user', content: [{ type: 'text', text: 'check medium file' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'm1', name: 'read_file', arguments: JSON.stringify({ path: 'src/med.js' }) }] },
      { role: 'tool', toolCallId: 'm1', content: [{ type: 'text', text: mediumTool }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'm2', name: 'glob', arguments: '{"pattern":"*"}' }] },
      { role: 'tool', toolCallId: 'm2', content: [{ type: 'text', text: 'src/med.js' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'm3', name: 'glob', arguments: '{"pattern":"*"}' }] },
      { role: 'tool', toolCallId: 'm3', content: [{ type: 'text', text: 'package.json' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'm4', name: 'glob', arguments: '{"pattern":"*"}' }] },
      { role: 'tool', toolCallId: 'm4', content: [{ type: 'text', text: 'README.md' }] },
    ];
    const emEngine = new ACIEngine({
      store,
      maxTotalTokens: 160000,
      contextWindow: 128000,
      singleStepBudget: 50000,
    });
    const comp1 = emEngine.compress(emergencyMsgs, { cumulativeUsedTokens: 135000 });
    assert.equal(comp1.triggered, true);
    assert.equal(comp1.reason, 'emergency_budget');
    assert.equal(comp1.epoch, 1);
    assert.equal(emEngine.epochState.emergencyUsed, true);

    const probe2 = emEngine.inspectEpoch(emergencyMsgs, { cumulativeUsedTokens: 138000 });
    assert.equal(probe2.emergencyTriggered, false);
    assert.equal(probe2.triggered, false);

    // 0-eligible emergency compress leaves epochCount=0 while setting emergencyUsed=true
    const emptyComp = compressMessagesEpoch(emergencyMsgs, {
      aciStore,
      ledger,
      maxTotalTokens: 160000,
      contextWindow: 128000,
      singleStepBudget: 50000,
      cumulativeUsedTokens: 135000,
      minAgeSteps: 99,
      supersededMinAgeSteps: 99,
      epochState: { lastWatermark: -1, epochCount: 0, emergencyUsed: false },
    });
    assert.equal(emptyComp.triggered, true);
    assert.equal(emptyComp.compressedCount, 0);
    assert.equal(emptyComp.epoch, 0);
    assert.equal(emptyComp.epochState.epochCount, 0);
    assert.equal(emptyComp.epochState.emergencyUsed, true);
  });
});
