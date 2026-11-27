import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { ContextSupervisor, ACI_CONFIG_KEY } from '../../src/context/supervisor.js';
import { admitToolBatch } from '../../src/context/aci-admission.js';
import { AccountPool } from '../../src/pool.js';
import { Store } from '../../src/store.js';
import {
  hasExplicitEnvProviderKey,
  isThinkingOrReasoningModel,
  loadAppPoolReadOnly,
  resolveAppDataDir,
  resolveLiveProviderConfig,
  resolveSupervisorExecutionConfig,
} from '../../src/evaluation/swebench-pool.js';

describe('SWE-bench Pool, Provider Inference & Supervisor Decoupling (WP3)', () => {
  const tempDirs = [];
  const makeTmp = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolveAppDataDir respects precedence explicitDir > BACKEND_DATA > backend/data > backend/var', () => {
    const repoRoot = makeTmp('swe-repo-root-');
    const explicitDir = makeTmp('swe-explicit-');
    const envDataDir = makeTmp('swe-env-data-');
    const dataDir = join(repoRoot, 'backend', 'data');
    const varDir = join(repoRoot, 'backend', 'var');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(varDir, { recursive: true });

    // None have engine.sqlite yet -> null when no explicitDir
    assert.equal(resolveAppDataDir(null, { repoRoot, env: {} }), null);

    // Explicit missing directory throws
    assert.throws(
      () => resolveAppDataDir(join(repoRoot, 'does-not-exist'), { repoRoot, env: {} }),
      /does not exist/i,
    );

    // Seed backend/var first -> resolves backend/var
    writeFileSync(join(varDir, 'engine.sqlite'), '', 'utf8');
    assert.equal(resolveAppDataDir(null, { repoRoot, env: {} }), varDir);

    // Seed backend/data -> beats backend/var
    writeFileSync(join(dataDir, 'engine.sqlite'), '', 'utf8');
    assert.equal(resolveAppDataDir(null, { repoRoot, env: {} }), dataDir);

    // BACKEND_DATA without engine.sqlite is skipped in favor of backend/data
    assert.equal(
      resolveAppDataDir(null, { repoRoot, env: { BACKEND_DATA: envDataDir } }),
      dataDir,
    );

    // BACKEND_DATA with engine.sqlite beats backend/data
    writeFileSync(join(envDataDir, 'engine.sqlite'), '', 'utf8');
    assert.equal(
      resolveAppDataDir(null, { repoRoot, env: { BACKEND_DATA: envDataDir } }),
      envDataDir,
    );

    // explicitDir beats everything
    writeFileSync(join(explicitDir, 'engine.sqlite'), '', 'utf8');
    assert.equal(
      resolveAppDataDir(explicitDir, { repoRoot, env: { BACKEND_DATA: envDataDir } }),
      explicitDir,
    );

    // %APPDATA%/agent-us-desktop/backend-var fallback when repo dirs are empty
    const emptyRepoRoot = makeTmp('swe-empty-repo-');
    const appDataBase = makeTmp('swe-appdata-base-');
    const desktopVar = join(appDataBase, 'agent-us-desktop', 'backend-var');
    mkdirSync(desktopVar, { recursive: true });
    writeFileSync(join(desktopVar, 'engine.sqlite'), '', 'utf8');
    assert.equal(
      resolveAppDataDir(null, { repoRoot: emptyRepoRoot, env: { APPDATA: appDataBase } }),
      desktopVar,
    );
  });

  test('loadAppPoolReadOnly clones enabled accounts, native sessions, pool_models, mappings, and default_model read-only', () => {
    const srcDir = makeTmp('swe-src-pool-');
    const dstDir = makeTmp('swe-dst-pool-');

    const srcStore = new Store(join(srcDir, 'engine.sqlite'));
    const srcPool = new AccountPool(srcStore, { root: srcDir });

    const dsAcc = srcPool.createAccount({
      preset: 'deepseek',
      label: 'DeepSeek Primary',
      priority: 10,
      endpoint: 'https://api.deepseek.com/v1',
      credential: 'sk-deepseek-secret-12345',
      models: ['deepseek-reasoner', 'deepseek-chat'],
      headers: { 'X-Team': 'bench' },
      meta: { note: 'primary' },
    });
    const addedChat = srcPool.addManualModel({
      accountId: dsAcc.id,
      upstreamModel: 'deepseek-chat',
      displayName: 'DeepSeek V3 Chat',
      multiplier: 0.25,
      contextWindow: 131072,
      maxOutput: 8192,
      capabilities: { tools: true, reasoning: false, cache: true },
    });
    srcPool.updatePoolModel(addedChat.id, { multiplier: 0.25 });
    srcPool.upsertMapping({
      alias: 'smart-coder',
      targetPreset: 'deepseek',
      targetAccountId: dsAcc.id,
      targetModel: 'deepseek-reasoner',
      priority: 5,
    });

    const nativeAcc = srcPool.createAccount(
      {
        preset: 'github-copilot',
        label: 'Copilot Native',
        priority: 20,
        models: ['gpt-4o'],
      },
      { oauthToken: 'gho_native_token_xyz', expiresAt: Date.now() + 3_600_000 },
    );

    srcPool.createAccount({
      preset: 'openai',
      label: 'Disabled OpenAI',
      enabled: false,
      credential: 'sk-disabled-should-not-clone',
      models: ['gpt-4o-mini'],
    });

    srcPool.setDefaultModel('deepseek-reasoner');
    srcStore.close();
    const srcBytesBefore = readFileSync(join(srcDir, 'engine.sqlite')).length;

    // Target isolated benchmark store & pool (distinct .pool-key!)
    const dstStore = new Store(join(dstDir, 'swebench.sqlite'));
    const dstPool = new AccountPool(dstStore, { root: dstDir });

    try {
      const cloned = loadAppPoolReadOnly({
        explicitDir: srcDir,
        targetStore: dstStore,
        targetPool: dstPool,
      });

      assert.equal(cloned.sourceDataDir, srcDir);
      assert.equal(cloned.accountsCloned, 2);
      assert.ok(cloned.modelsCloned >= 3);
      assert.equal(cloned.defaultModel, 'deepseek-reasoner');
      assert.ok(cloned.availableModels.includes('deepseek-chat'));
      assert.ok(cloned.availableModels.includes('smart-coder'));
      assert.equal(cloned.availableModels.includes('gpt-4o-mini'), false);

      const accounts = dstPool.listAccounts();
      assert.equal(accounts.length, 2);
      assert.equal(accounts.some((a) => a.label === 'Disabled OpenAI'), false);

      const routes = dstPool.resolveRoutes('smart-coder');
      assert.equal(routes.length, 1);
      assert.equal(routes[0].apiKey, 'sk-deepseek-secret-12345');
      assert.equal(routes[0].wireModel, 'deepseek-reasoner');
      assert.equal(routes[0].endpoint, 'https://api.deepseek.com/v1');
      assert.deepEqual(routes[0].customHeaders, { 'X-Team': 'bench' });

      const nativeRow = dstStore.db
        .prepare('SELECT encrypted FROM native_provider_sessions WHERE accountId=?')
        .get(nativeAcc.id);
      assert.ok(nativeRow?.encrypted);
      const decodedNative = JSON.parse(dstPool.decrypt(nativeRow.encrypted));
      assert.equal(decodedNative.oauthToken, 'gho_native_token_xyz');

      const pmChat = dstStore.db
        .prepare('SELECT * FROM pool_models WHERE accountId=? AND upstreamModel=?')
        .get(dsAcc.id, 'deepseek-chat');
      assert.equal(pmChat.displayName, 'DeepSeek V3 Chat');
      assert.equal(pmChat.multiplier, 0.25);

      const srcBytesAfter = readFileSync(join(srcDir, 'engine.sqlite')).length;
      assert.equal(srcBytesAfter, srcBytesBefore);
    } finally {
      dstStore.close();
    }
  });

  test('loadAppPoolReadOnly supports BACKEND_MASTER_KEY decryption and throws actionable error when missing engine.sqlite', () => {
    const emptyDir = makeTmp('swe-empty-pool-');
    const dstDir = makeTmp('swe-dst-empty-');
    const dstStore = new Store(join(dstDir, 'swebench.sqlite'));
    const dstPool = new AccountPool(dstStore, { root: dstDir });

    try {
      assert.throws(
        () =>
          loadAppPoolReadOnly({
            explicitDir: emptyDir,
            targetStore: dstStore,
            targetPool: dstPool,
          }),
        /engine\.sqlite.*Configure an enabled provider account|API key/i,
      );

      // Test BACKEND_MASTER_KEY encrypted source (no .pool-key)
      const masterSrcDir = makeTmp('swe-master-src-');
      const prevMaster = process.env.BACKEND_MASTER_KEY;
      process.env.BACKEND_MASTER_KEY = 'unit-test-master-key-secret';
      try {
        const srcStore = new Store(join(masterSrcDir, 'engine.sqlite'));
        const srcPool = new AccountPool(srcStore, { root: masterSrcDir });
        srcPool.createAccount({
          preset: 'anthropic',
          label: 'Anthropic MasterKey',
          credential: 'sk-ant-master-999',
          models: ['claude-sonnet-4-5'],
        });
        srcStore.close();
      } finally {
        if (prevMaster === undefined) delete process.env.BACKEND_MASTER_KEY;
        else process.env.BACKEND_MASTER_KEY = prevMaster;
      }

      const cloned = loadAppPoolReadOnly({
        explicitDir: masterSrcDir,
        targetStore: dstStore,
        targetPool: dstPool,
        env: { BACKEND_MASTER_KEY: 'unit-test-master-key-secret' },
      });
      assert.equal(cloned.accountsCloned, 1);
      const routes = dstPool.resolveRoutes('claude-sonnet-4-5');
      assert.equal(routes[0].apiKey, 'sk-ant-master-999');
      assert.equal(routes[0].protocol, 'anthropic');
    } finally {
      dstStore.close();
    }
  });

  test('loadAppPoolReadOnly falls back to read-only .provider-env.json when provider_accounts has 0 enabled rows', () => {
    const srcDir = makeTmp('swe-env-fallback-src-');
    const dstDir = makeTmp('swe-env-fallback-dst-');

    // Create empty DB (0 enabled accounts) + .provider-env.json
    const srcStore = new Store(join(srcDir, 'engine.sqlite'));
    const srcPool = new AccountPool(srcStore, { root: srcDir });
    srcPool.createAccount({
      preset: 'openai',
      label: 'Disabled',
      enabled: false,
      credential: 'sk-disabled',
      models: ['gpt-4o'],
    });
    srcStore.close();

    writeFileSync(
      join(srcDir, '.provider-env.json'),
      JSON.stringify({ DEEPSEEK_API_KEY: 'sk-provider-env-deepseek' }),
      'utf8',
    );

    const dstStore = new Store(join(dstDir, 'swebench.sqlite'));
    const dstPool = new AccountPool(dstStore, { root: dstDir });
    try {
      const cloned = loadAppPoolReadOnly({
        explicitDir: srcDir,
        targetStore: dstStore,
        targetPool: dstPool,
        model: 'deepseek-reasoner',
      });
      assert.equal(cloned.accountsCloned, 1);
      assert.equal(cloned.defaultModel, 'deepseek-reasoner');
      assert.ok(cloned.availableModels.includes('deepseek-chat'));
      const routes = dstPool.resolveRoutes('deepseek-reasoner');
      assert.equal(routes.length, 1);
      assert.equal(routes[0].apiKey, 'sk-provider-env-deepseek');
      assert.equal(routes[0].endpoint, 'https://api.deepseek.com/v1');
    } finally {
      dstStore.close();
    }
  });

  test('hasExplicitEnvProviderKey and resolveLiveProviderConfig infer DeepSeek, Anthropic, and OpenAI endpoints cleanly', () => {
    assert.equal(hasExplicitEnvProviderKey({}), false);
    assert.equal(hasExplicitEnvProviderKey({ DEEPSEEK_API_KEY: '  ' }), false);
    assert.equal(hasExplicitEnvProviderKey({ DEEPSEEK_API_KEY: 'sk-ds' }), true);
    assert.equal(hasExplicitEnvProviderKey({ ANTHROPIC_API_KEY: 'sk-ant' }), true);

    // DEEPSEEK_API_KEY -> api.deepseek.com/v1
    const dsCfg = resolveLiveProviderConfig({}, { DEEPSEEK_API_KEY: 'sk-ds-123' });
    assert.equal(dsCfg.apiKey, 'sk-ds-123');
    assert.equal(dsCfg.endpoint, 'https://api.deepseek.com/v1');
    assert.equal(dsCfg.protocol, 'openai');
    assert.equal(dsCfg.model, 'deepseek-chat');

    // SWEBENCH_API_KEY + deepseek-reasoner without OPENAI_API_KEY -> api.deepseek.com/v1
    const dsModelCfg = resolveLiveProviderConfig(
      { model: 'deepseek-reasoner' },
      { SWEBENCH_API_KEY: 'sk-bench-1' },
    );
    assert.equal(dsModelCfg.endpoint, 'https://api.deepseek.com/v1');
    assert.equal(dsModelCfg.model, 'deepseek-reasoner');

    // OPENAI_API_KEY stays on api.openai.com/v1 even if model starts with deepseek- fallback
    const oaCfg = resolveLiveProviderConfig({}, { OPENAI_API_KEY: 'sk-oa-1' });
    assert.equal(oaCfg.endpoint, 'https://api.openai.com/v1');
    assert.equal(oaCfg.protocol, 'openai');

    // ANTHROPIC_API_KEY -> api.anthropic.com + anthropic protocol
    const antCfg = resolveLiveProviderConfig(
      { model: 'claude-sonnet-4-5' },
      { ANTHROPIC_API_KEY: 'sk-ant-1' },
    );
    assert.equal(antCfg.endpoint, 'https://api.anthropic.com');
    assert.equal(antCfg.protocol, 'anthropic');

    // Explicit endpoint overrides inference
    const customCfg = resolveLiveProviderConfig(
      { model: 'deepseek-reasoner' },
      { DEEPSEEK_API_KEY: 'sk-ds', SWEBENCH_ENDPOINT: 'https://proxy.example.com/v1/' },
    );
    assert.equal(customCfg.endpoint, 'https://proxy.example.com/v1');
  });

  test('isThinkingOrReasoningModel and resolveSupervisorExecutionConfig decouple reasoning main models from supervisor LLM calls', async () => {
    assert.equal(isThinkingOrReasoningModel('deepseek-reasoner'), true);
    assert.equal(isThinkingOrReasoningModel('deepseek-r1'), true);
    assert.equal(isThinkingOrReasoningModel('o3-mini'), true);
    assert.equal(isThinkingOrReasoningModel('o4-mini'), true);
    assert.equal(isThinkingOrReasoningModel('claude-3-7-sonnet-thinking'), true);
    assert.equal(isThinkingOrReasoningModel('deepseek-chat'), false);
    assert.equal(isThinkingOrReasoningModel('gpt-4o-mini'), false);

    // raw_full disables supervisor and admission
    assert.deepEqual(
      resolveSupervisorExecutionConfig({ arm: 'raw_full', mainModel: 'deepseek-chat' }),
      { enabled: false, mode: 'off', model: null, admissionEnabled: false, reason: 'raw_full' },
    );

    // deterministic_progressive / --deterministic-admission / --supervisor-model off|deterministic
    for (const args of [
      { arm: 'deterministic_progressive', mainModel: 'deepseek-chat' },
      { arm: 'full_aci', mainModel: 'deepseek-chat', deterministicAdmission: true },
      { arm: 'full_aci', mainModel: 'deepseek-chat', supervisorModel: 'off' },
      { arm: 'full_aci', mainModel: 'deepseek-chat', supervisorModel: 'deterministic' },
    ]) {
      assert.deepEqual(resolveSupervisorExecutionConfig(args), {
        enabled: false,
        mode: 'off',
        model: null,
        admissionEnabled: true,
        reason: 'deterministic',
      });
    }

    // Explicit supervisorModel overrides reasoning fallback
    assert.deepEqual(
      resolveSupervisorExecutionConfig({
        arm: 'full_aci',
        mainModel: 'deepseek-reasoner',
        supervisorModel: 'deepseek-chat',
      }),
      {
        enabled: true,
        mode: 'custom',
        model: 'deepseek-chat',
        admissionEnabled: true,
        reason: 'explicit_supervisor_model',
      },
    );

    // Reasoning mainModel + healthy deepseek-chat in pool -> auto_fast_model
    assert.deepEqual(
      resolveSupervisorExecutionConfig({
        arm: 'full_aci',
        mainModel: 'deepseek-reasoner',
        availableModels: ['deepseek-reasoner', 'deepseek-chat'],
      }),
      {
        enabled: true,
        mode: 'custom',
        model: 'deepseek-chat',
        admissionEnabled: true,
        reason: 'auto_fast_model',
      },
    );

    // Reasoning mainModel with NO healthy non-reasoning model -> deterministic fallback!
    const fallbackCfg = resolveSupervisorExecutionConfig({
      arm: 'full_aci',
      mainModel: 'deepseek-reasoner',
      availableModels: ['deepseek-reasoner'],
    });
    assert.deepEqual(fallbackCfg, {
      enabled: false,
      mode: 'off',
      model: null,
      admissionEnabled: true,
      reason: 'reasoning_main_deterministic_fallback',
    });

    // Verify with real Store, AccountPool, ContextSupervisor, and admitToolOutputCandidates:
    // Never invokes deepseek-reasoner when bound to deterministic fallback!
    const dir = makeTmp('swe-sup-decouple-');
    const store = new Store(join(dir, 'sup.sqlite'));
    const pool = new AccountPool(store, { root: dir });
    try {
      pool.createAccount({
        preset: 'deepseek',
        label: 'DS',
        credential: 'sk-test',
        models: ['deepseek-reasoner'],
      });
      store.setSetting(ACI_CONFIG_KEY, {
        enabled: fallbackCfg.enabled,
        mode: fallbackCfg.mode,
        model: fallbackCfg.model,
        admissionEnabled: fallbackCfg.admissionEnabled,
      });

      const calledModels = [];
      class RecordingAdapter extends LlmAdapter {
        async *stream(opts) {
          calledModels.push(opts.model);
          yield {
            type: 'text-delta',
            index: 0,
            text: JSON.stringify({
              decisions: [{ id: 'c1', decision: 'IRRELEVANT', focusSymbols: [], reason: 'decoy' }],
              contractHints: [],
            }),
          };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }

      const supervisor = new ContextSupervisor({ store, pool, adapter: new RecordingAdapter() });
      const decoyContent =
        '<!-- DO NOT EDIT - ARCHIVED DECOY -->\n' +
        'Legacy discount calculator tariff snapshot line\n'.repeat(120);
      const batchItems = [
        {
          tc: {
            id: 'c1',
            name: 'read_file',
            arguments: JSON.stringify({ path: 'docs/legacy/pricing_changelog.md' }),
          },
          parsedArgs: { path: 'docs/legacy/pricing_changelog.md' },
          output: decoyContent,
          isError: false,
        },
      ];
      const admRes = await admitToolBatch(batchItems, {
        query: 'Fix discount calculator bug',
        supervisor,
        supervisorEnabled: true,
      });

      assert.equal(calledModels.length, 0, 'Must NEVER invoke deepseek-reasoner in admitCandidates');
      assert.ok(admRes.stats.tokensSaved > 0, 'Deterministic admission must still compress decoy context');

      // Now add deepseek-chat and verify explicit/auto_fast_model calls ONLY deepseek-chat
      pool.addManualModel({ upstreamModel: 'deepseek-chat' });
      const fastCfg = resolveSupervisorExecutionConfig({
        arm: 'full_aci',
        mainModel: 'deepseek-reasoner',
        targetPool: pool,
      });
      assert.equal(fastCfg.model, 'deepseek-chat');
      assert.equal(fastCfg.reason, 'auto_fast_model');

      store.setSetting(ACI_CONFIG_KEY, {
        enabled: fastCfg.enabled,
        mode: fastCfg.mode,
        model: fastCfg.model,
        admissionEnabled: fastCfg.admissionEnabled,
      });
      await admitToolBatch(batchItems, {
        query: 'Fix discount calculator bug',
        supervisor,
        supervisorEnabled: true,
      });
      assert.deepEqual(calledModels, ['deepseek-chat']);
    } finally {
      store.close();
    }
  });

  test('Task 4.1.1 Section 1: single-model full_aci enables auto_epoch_main_model — skips stage=admission and activates stage=dtoc end-to-end', async () => {
    const supCfg = resolveSupervisorExecutionConfig({
      arm: 'full_aci',
      mainModel: 'deepseek-v4.1-flash',
    });
    assert.deepEqual(supCfg, {
      enabled: true,
      mode: 'auto',
      model: null,
      admissionEnabled: true,
      reason: 'auto_epoch_main_model',
    });

    // Also applies to non-reasoning single models with explicit availableModels list
    assert.deepEqual(
      resolveSupervisorExecutionConfig({
        arm: 'full_aci',
        mainModel: 'claude-sonnet-4-5',
        availableModels: ['claude-sonnet-4-5'],
      }),
      {
        enabled: true,
        mode: 'auto',
        model: null,
        admissionEnabled: true,
        reason: 'auto_epoch_main_model',
      },
    );

    const dir = makeTmp('swe-sup-dtoc-auto-');
    const store = new Store(join(dir, 'sup-dtoc.sqlite'));
    const pool = new AccountPool(store, { root: dir });
    try {
      pool.createAccount({
        preset: 'deepseek',
        label: 'DS-Single',
        credential: 'sk-test-v41',
        models: ['deepseek-v4.1-flash'],
      });
      pool.setDefaultModel('deepseek-v4.1-flash');

      // Re-resolve against live single-model AccountPool
      const liveCfg = resolveSupervisorExecutionConfig({
        arm: 'full_aci',
        mainModel: 'deepseek-v4.1-flash',
        availableModels: ['deepseek-v4.1-flash'],
        targetPool: pool,
      });
      assert.deepEqual(liveCfg, {
        enabled: true,
        mode: 'auto',
        model: null,
        admissionEnabled: true,
        reason: 'auto_epoch_main_model',
      });

      store.setSetting(ACI_CONFIG_KEY, {
        enabled: liveCfg.enabled,
        mode: liveCfg.mode,
        model: liveCfg.model,
        admissionEnabled: liveCfg.admissionEnabled,
      });

      const recordedCalls = [];
      class RecordingDtocAdapter extends LlmAdapter {
        async *stream(opts) {
          recordedCalls.push({
            model: opts.model,
            tools: opts.tools,
            system: opts.system,
          });
          yield {
            type: 'text-delta',
            index: 0,
            text: JSON.stringify({
              keepRefs: ['ref_active_spec'],
              compressRefs: ['ref_explored_noise'],
            }),
          };
          yield {
            type: 'usage',
            usage: { inputTokens: 420, outputTokens: 28 },
          };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }

      const supervisor = new ContextSupervisor({
        store,
        pool,
        adapter: new RecordingDtocAdapter(),
      });

      // 1) stage='admission' MUST auto-skip (zero per-step LLM latency!)
      const admResolved = supervisor.resolveModel(liveCfg, {
        mainModel: 'deepseek-v4.1-flash',
        stage: 'admission',
      });
      assert.equal(admResolved.stage, 'admission');
      assert.equal(admResolved.active, false);
      assert.equal(admResolved.effectiveModel, null);

      const decoyContent =
        '<!-- DO NOT EDIT - ARCHIVED DECOY -->\n' +
        'Legacy pricing snapshot line\n'.repeat(120);
      const admBatch = await admitToolBatch(
        [
          {
            tc: {
              id: 'c_adm_1',
              name: 'read_file',
              arguments: JSON.stringify({ path: 'docs/legacy/pricing_archive.md' }),
            },
            parsedArgs: { path: 'docs/legacy/pricing_archive.md' },
            output: decoyContent,
            isError: false,
          },
        ],
        {
          query: 'Fix billing calculation edge case',
          supervisor,
          supervisorEnabled: true,
          mainModel: 'deepseek-v4.1-flash',
        },
      );
      assert.equal(
        recordedCalls.length,
        0,
        'stage=admission must NOT invoke single-model mainModel over the wire',
      );
      assert.ok(admBatch.stats.tokensSaved > 0);

      // 2) stage='dtoc' MUST activate reusing mainModel='deepseek-v4.1-flash'
      const dtocResolved = supervisor.resolveModel(liveCfg, {
        mainModel: 'deepseek-v4.1-flash',
        stage: 'dtoc',
      });
      assert.equal(dtocResolved.stage, 'dtoc');
      assert.equal(dtocResolved.active, true);
      assert.equal(dtocResolved.effectiveModel, 'deepseek-v4.1-flash');

      // 3) End-to-end evaluateEpoch triggers read-only (tools: []) model semantic adjudication
      const epochRes = await supervisor.evaluateEpoch({
        query: 'Fix billing calculation edge case in pricing engine',
        mainModel: 'deepseek-v4.1-flash',
        candidates: [
          {
            id: 'ref_active_spec',
            path: 'src/pricing/engine.js',
            toolName: 'read_file',
            tokens: 1800,
            ageSteps: 8,
            symbolOutline: ['calculateDiscount', 'applyTax'],
            shortSummary: 'Core pricing engine specification and active edit target',
          },
          {
            id: 'ref_explored_noise',
            path: 'src/cli/banner.js',
            toolName: 'read_file',
            tokens: 1600,
            ageSteps: 10,
            symbolOutline: ['renderBanner'],
            shortSummary: 'Peripheral CLI banner helper explored earlier',
          },
        ],
      });
      assert.equal(epochRes.ok, true);
      assert.equal(epochRes.usedLlm, true);
      assert.equal(epochRes.stage, 'dtoc');
      assert.equal(epochRes.model, 'deepseek-v4.1-flash');
      assert.deepEqual(epochRes.keepRefs, ['ref_active_spec']);
      assert.deepEqual(epochRes.compressRefs, ['ref_explored_noise']);
      assert.equal(recordedCalls.length, 1);
      assert.equal(recordedCalls[0].model, 'deepseek-v4.1-flash');
      assert.deepEqual(recordedCalls[0].tools, []);
    } finally {
      store.close();
    }
  });
});
