import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const BENCH_API_KEY_ENV_VARS = Object.freeze([
  'SWEBENCH_API_KEY',
  'TI_BENCH_KEY',
  'AGENT_US_BENCH_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
]);

const BENCH_ENDPOINT_ENV_VARS = Object.freeze([
  'SWEBENCH_ENDPOINT',
  'TI_BENCH_ENDPOINT',
  'AGENT_US_BENCH_ENDPOINT',
]);

const BENCH_PROTOCOL_ENV_VARS = Object.freeze([
  'SWEBENCH_PROTOCOL',
  'TI_BENCH_PROTOCOL',
  'AGENT_US_BENCH_PROTOCOL',
]);

const BENCH_MODEL_ENV_VARS = Object.freeze([
  'SWEBENCH_MODEL',
  'TI_BENCH_MODEL',
  'AGENT_US_BENCH_MODEL',
]);

const REASONING_MODEL_TOKEN_RE = /(?:^|[-_./\s])(?:reasoner|reasoning|thinking|qwq|r1)(?:$|[-_./\s0-9])/i;
const REASONING_MODEL_PREFIX_RE = /(?:^|\/)(?:o1|o3|o4)(?:$|[-_])/i;
const FAST_TIER_MODEL_RE = /(?:^|[-_./\s])(?:flash|lite|nano|micro|instant|fast|mini|haiku|small|turbo|air|quick|chat)(?:$|[-_./\s0-9])/i;
const HEAVY_NON_REASONING_RE = /(?:^|[-_./\s])(?:opus|ultra|heavy)(?:$|[-_./\s0-9])/i;
const UTILITY_MODEL_RE = /(?:^|[-_./\s])(?:embed|embedding|whisper|tts|dall|flux|image|rerank|moderation)(?:$|[-_./\s0-9])/i;

function parseJsonSafe(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readFirstNonEmptyEnv(env, keys) {
  for (const key of keys) {
    const val = String(env?.[key] ?? '').trim();
    if (val) return { key, value: val };
  }
  return { key: null, value: '' };
}

function isExistingDir(dirPath) {
  try {
    return existsSync(dirPath) && statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readSourceMasterKeys(sourceDataDir, env = process.env) {
  const keys = [];
  const keyFile = join(sourceDataDir, '.pool-key');
  if (existsSync(keyFile)) {
    const raw = readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      keys.push(Buffer.from(raw, 'hex'));
    }
  }
  const masterSecret = String(env?.BACKEND_MASTER_KEY ?? '').trim();
  if (masterSecret) {
    keys.push(createHash('sha256').update(masterSecret).digest());
  }
  return keys;
}

function decryptWithKey(encoded, keyBuf) {
  if (!encoded || typeof encoded !== 'string' || !encoded.startsWith('v1:')) return null;
  const parts = encoded.split(':');
  if (parts.length !== 4) return null;
  const [, ivHex, tagHex, dataHex] = parts;
  if (!ivHex || !tagHex || !dataHex) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const out = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return out.toString('utf8');
  } catch {
    return null;
  }
}

function decryptWithSourceKeys(encoded, sourceKeys, contextLabel = 'credential') {
  if (!encoded) return '';
  if (!Array.isArray(sourceKeys) || sourceKeys.length === 0) {
    throw new Error(
      `Cannot decrypt ${contextLabel}: source .pool-key (64 hex chars) and BACKEND_MASTER_KEY are both missing.`,
    );
  }
  for (const keyBuf of sourceKeys) {
    const plain = decryptWithKey(encoded, keyBuf);
    if (plain !== null) return plain;
  }
  throw new Error(
    `Failed to decrypt ${contextLabel} with source .pool-key / BACKEND_MASTER_KEY.`,
  );
}

function isHealthyRouteList(routes, now = Date.now()) {
  if (!Array.isArray(routes) || routes.length === 0) return false;
  return routes.some(
    (r) =>
      r &&
      Number(r.cooldownUntil || 0) <= now &&
      r.status !== 'disabled' &&
      r.status !== 'invalid',
  );
}

function inferModelFamily(modelId) {
  const id = String(modelId ?? '').trim().toLowerCase();
  if (!id) return null;
  if (id.includes('deepseek')) return 'deepseek';
  if (id.includes('claude')) return 'anthropic';
  if (/^(?:gpt-|chatgpt-|o[134](?:$|[-_]))|\/(?:gpt-|o[134](?:$|[-_]))/.test(id)) return 'openai';
  if (id.includes('gemini')) return 'gemini';
  if (id.includes('qwen')) return 'qwen';
  if (id.includes('kimi') || id.includes('moonshot')) return 'kimi';
  if (id.includes('glm')) return 'zhipu';
  if (id.includes('minimax')) return 'minimax';
  if (id.includes('grok')) return 'xai';
  return null;
}

function isPresetCompatibleWithModel(preset, modelId) {
  const p = String(preset ?? '').trim().toLowerCase();
  const fam = inferModelFamily(modelId);
  if (!p) return false;
  if (
    [
      'openrouter',
      'new-api',
      'sub2api',
      'agent2api',
      'custom-openai',
      'custom-anthropic',
      'siliconflow',
      'huggingface',
      'opencode-go',
      'opencode-zen',
      'ollama',
      'lmstudio',
      'nvidia',
    ].includes(p)
  ) {
    return true;
  }
  if (!fam) return false;
  if (p === 'deepseek') return fam === 'deepseek';
  if (p === 'anthropic' || p === 'claude-code') return fam === 'anthropic';
  if (p === 'openai' || p === 'openai-codex') return fam === 'openai';
  if (p === 'gemini' || p === 'gemini-cli') return fam === 'gemini';
  if (p === 'qwen') return fam === 'qwen';
  if (p === 'kimi') return fam === 'kimi';
  if (p === 'zhipu' || p === 'glm-coding') return fam === 'zhipu';
  if (p === 'minimax' || p === 'minimax-cn') return fam === 'minimax';
  if (p === 'xai') return fam === 'xai';
  return false;
}

function readSourceTablesSet(srcDb) {
  const rows = srcDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all();
  return new Set(rows.map((r) => String(r.name)));
}

/**
 * Resolves the App data directory containing `engine.sqlite` (or `.provider-env.json` fallback).
 * Resolution order: `explicitDir`, `env.BACKEND_DATA`, `<repoRoot>/backend/data`,
 * `<repoRoot>/backend/var`, `%APPDATA%/agent-us-desktop/backend-var`.
 */
export function resolveAppDataDir(
  explicitDir = null,
  { cwd = process.cwd(), repoRoot = DEFAULT_REPO_ROOT, env = process.env } = {},
) {
  const rawExplicit = explicitDir != null ? String(explicitDir).trim() : '';
  if (rawExplicit) {
    const resolved = resolve(cwd, rawExplicit);
    if (!isExistingDir(resolved)) {
      throw new Error(`App data directory does not exist: ${resolved}`);
    }
    return resolved;
  }

  const candidates = [];
  const envData = String(env?.BACKEND_DATA ?? '').trim();
  if (envData) candidates.push(resolve(cwd, envData));
  candidates.push(join(resolve(repoRoot), 'backend', 'data'));
  candidates.push(join(resolve(repoRoot), 'backend', 'var'));
  const appDataEnv = String(env?.APPDATA ?? '').trim();
  if (appDataEnv) {
    candidates.push(join(resolve(cwd, appDataEnv), 'agent-us-desktop', 'backend-var'));
  }

  for (const dir of candidates) {
    if (isExistingDir(dir) && existsSync(join(dir, 'engine.sqlite'))) {
      return dir;
    }
  }
  for (const dir of candidates) {
    if (isExistingDir(dir) && existsSync(join(dir, '.provider-env.json'))) {
      return dir;
    }
  }
  return null;
}

const PROVIDER_ENV_PRESET_MAP = Object.freeze([
  {
    envKey: 'DEEPSEEK_API_KEY',
    preset: 'deepseek',
    label: 'DeepSeek (.provider-env)',
    endpoint: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    envKey: 'OPENAI_API_KEY',
    preset: 'openai',
    label: 'OpenAI (.provider-env)',
    endpoint: 'https://api.openai.com/v1',
    protocol: 'openai',
    models: ['gpt-4o', 'gpt-4o-mini'],
  },
  {
    envKey: 'ANTHROPIC_API_KEY',
    preset: 'anthropic',
    label: 'Anthropic (.provider-env)',
    endpoint: 'https://api.anthropic.com',
    protocol: 'anthropic',
    models: ['claude-sonnet-4-5', 'claude-3-5-haiku-20241022'],
  },
  {
    envKey: 'OPENROUTER_API_KEY',
    preset: 'openrouter',
    label: 'OpenRouter (.provider-env)',
    endpoint: 'https://openrouter.ai/api/v1',
    protocol: 'openai',
    models: [],
  },
  {
    envKey: 'GEMINI_API_KEY',
    preset: 'gemini',
    label: 'Gemini (.provider-env)',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'openai',
    models: ['gemini-2.5-flash'],
  },
  {
    envKey: 'SILICONFLOW_API_KEY',
    preset: 'siliconflow',
    label: 'SiliconFlow (.provider-env)',
    endpoint: 'https://api.siliconflow.cn/v1',
    protocol: 'openai',
    models: [],
  },
  {
    envKey: 'KIMI_API_KEY',
    preset: 'kimi',
    label: 'Kimi (.provider-env)',
    endpoint: 'https://api.moonshot.cn/v1',
    protocol: 'openai',
    models: [],
  },
  {
    envKey: 'ZHIPU_API_KEY',
    preset: 'zhipu',
    label: 'Zhipu (.provider-env)',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    models: [],
  },
  {
    envKey: 'QWEN_API_KEY',
    preset: 'qwen',
    label: 'Qwen (.provider-env)',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai',
    models: [],
  },
  {
    envKey: 'GROQ_API_KEY',
    preset: 'groq',
    label: 'Groq (.provider-env)',
    endpoint: 'https://api.groq.com/openai/v1',
    protocol: 'openai',
    models: [],
  },
  {
    envKey: 'XAI_API_KEY',
    preset: 'xai',
    label: 'xAI (.provider-env)',
    endpoint: 'https://api.x.ai/v1',
    protocol: 'openai',
    models: [],
  },
]);

function cloneFromProviderEnvFallback({
  sourceDataDir,
  targetPool,
  model = null,
  env = process.env,
}) {
  const envFilePath = join(sourceDataDir, '.provider-env.json');
  if (!existsSync(envFilePath)) return [];
  const parsedEnv = parseJsonSafe(readFileSync(envFilePath, 'utf8'), null);
  if (!parsedEnv || typeof parsedEnv !== 'object' || Array.isArray(parsedEnv)) return [];

  const savedEnv = {};
  for (const [k, v] of Object.entries(parsedEnv)) {
    if (typeof v === 'string' && v.trim()) savedEnv[k] = v.trim();
  }
  const cloned = [];
  const seenEndpoints = new Set();

  const cfgPath = join(sourceDataDir, 'config.json');
  if (existsSync(cfgPath)) {
    const cfg = parseJsonSafe(readFileSync(cfgPath, 'utf8'), null);
    for (const p of cfg?.providers ?? []) {
      const ep = String(p?.endpoint ?? '').trim().replace(/\/+$/, '');
      if (!ep || seenEndpoints.has(ep)) continue;
      const key = p.keyRef ? savedEnv[p.keyRef] || String(env?.[p.keyRef] ?? '').trim() : '';
      if (!key) continue;
      const models = (cfg?.models ?? [])
        .filter((m) => m?.provider === p.id && m?.model)
        .map((m) => String(m.model).trim());
      const preset = String(p.id || 'custom-openai');
      const acc = targetPool.createAccount({
        preset,
        label: `env-fallback-${preset}`,
        endpoint: ep,
        credential: key,
        ...(p.protocol ? { protocol: String(p.protocol) } : {}),
        models,
      });
      seenEndpoints.add(ep);
      cloned.push(acc);
    }
  }

  for (const spec of PROVIDER_ENV_PRESET_MAP) {
    const key = savedEnv[spec.envKey];
    if (!key) continue;
    const ep = spec.endpoint.replace(/\/+$/, '');
    if (seenEndpoints.has(ep)) continue;
    const acc = targetPool.createAccount({
      preset: spec.preset,
      label: spec.label,
      endpoint: ep,
      protocol: spec.protocol,
      credential: key,
      models: spec.models,
    });
    seenEndpoints.add(ep);
    cloned.push(acc);
  }

  if (cloned.length === 0) {
    const liveCfg = resolveLiveProviderConfig({ model }, savedEnv);
    if (liveCfg.apiKey) {
      const acc = targetPool.createAccount({
        preset: liveCfg.preset,
        label: 'env-fallback-bench',
        endpoint: liveCfg.endpoint,
        protocol: liveCfg.protocol,
        credential: liveCfg.apiKey,
        models: liveCfg.model ? [liveCfg.model] : [],
      });
      cloned.push(acc);
    }
  }

  return cloned;
}

/**
 * Clones enabled provider accounts, native sessions, pool models, mappings, and
 * `pool.default_model` strictly read-only from the configured App `engine.sqlite`
 * (with read-only `.provider-env.json` fallback when 0 enabled DB accounts exist)
 * into an isolated benchmark `targetStore` / `targetPool`.
 */
export function loadAppPoolReadOnly({
  appDataDir = null,
  explicitDir = null,
  targetStore,
  targetPool,
  model = null,
  supervisorModel = null,
  excludeAccounts = [],
  cwd = process.cwd(),
  repoRoot = DEFAULT_REPO_ROOT,
  env = process.env,
} = {}) {
  if (!targetStore || !targetPool) {
    throw new Error('loadAppPoolReadOnly requires targetStore and targetPool');
  }

  const excludeTokens = (
    Array.isArray(excludeAccounts)
      ? excludeAccounts
      : String(excludeAccounts ?? '').split(',')
  )
    .map((token) => String(token ?? '').trim().toLowerCase())
    .filter(Boolean);

  const requestedDir = explicitDir ?? appDataDir ?? null;
  const sourceDataDir = resolveAppDataDir(requestedDir, { cwd, repoRoot, env });
  const dbPath = sourceDataDir ? join(sourceDataDir, 'engine.sqlite') : null;
  const envFallbackPath = sourceDataDir ? join(sourceDataDir, '.provider-env.json') : null;
  const hasDb = Boolean(dbPath && existsSync(dbPath));
  const hasEnvFallback = Boolean(envFallbackPath && existsSync(envFallbackPath));

  if (!sourceDataDir || (!hasDb && !hasEnvFallback)) {
    throw new Error(
      `No App AccountPool database (engine.sqlite) found${sourceDataDir ? ` in ${sourceDataDir}` : ''}. ` +
        'Configure an enabled provider account in the app, pass --app-data-dir <dir>, or set an API key env var (DEEPSEEK_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, SWEBENCH_API_KEY).',
    );
  }

  let accountsCloned = 0;
  let excludedAccountsCount = 0;
  let modelsCloned = 0;
  let sourceDefaultModel = null;
  const clonedAccountIds = new Set();
  const clonedAccounts = [];

  if (hasDb) {
    const sourceKeys = readSourceMasterKeys(sourceDataDir, env);
    const srcDb = new DatabaseSync(dbPath, { readOnly: true });

    try {
      const tables = readSourceTablesSet(srcDb);
      if (!tables.has('provider_accounts')) {
        throw new Error(
          `App database at ${dbPath} does not contain provider_accounts table. Configure an account or pass an API key env var.`,
        );
      }

      const enabledRows = srcDb
        .prepare('SELECT * FROM provider_accounts WHERE enabled = 1 ORDER BY priority ASC, createdAt ASC')
        .all();

      const hasNativeSessions = tables.has('native_provider_sessions');
      const getNativeStmt = hasNativeSessions
        ? srcDb.prepare('SELECT encrypted FROM native_provider_sessions WHERE accountId = ?')
        : null;

      for (const acc of enabledRows) {
        if (excludeTokens.length > 0) {
          const haystack = [acc.id, acc.preset, acc.label, acc.endpoint].map((v) =>
            String(v ?? '').toLowerCase(),
          );
          if (excludeTokens.some((tok) => haystack.some((field) => field.includes(tok)))) {
            excludedAccountsCount += 1;
            continue;
          }
        }
        const headers = parseJsonSafe(acc.headers, {});
        const models = parseJsonSafe(acc.models, []);
        const meta = parseJsonSafe(acc.meta, {});
        const protocol = meta?.protocol ? String(meta.protocol) : undefined;

        const decryptedSecret = acc.credentialEnc
          ? decryptWithSourceKeys(acc.credentialEnc, sourceKeys, `account "${acc.label || acc.id}"`)
          : '';

        let nativeSession = null;
        if (getNativeStmt) {
          const nativeRow = getNativeStmt.get(acc.id);
          if (nativeRow?.encrypted) {
            const plainNative = decryptWithSourceKeys(
              nativeRow.encrypted,
              sourceKeys,
              `native session for "${acc.label || acc.id}"`,
            );
            nativeSession = parseJsonSafe(plainNative, null);
          }
        }

        const created = targetPool.createAccount(
          {
            id: acc.id,
            preset: acc.preset,
            label: acc.label,
            category: acc.category || undefined,
            priority: acc.priority,
            enabled: true,
            endpoint: acc.endpoint ?? undefined,
            proxyUrl: acc.proxyUrl ?? undefined,
            headers,
            models: Array.isArray(models) ? models : [],
            meta,
            ...(protocol ? { protocol } : {}),
            ...(acc.expiresAt != null ? { expiresAt: acc.expiresAt } : {}),
            ...(decryptedSecret ? { credential: decryptedSecret } : {}),
          },
          nativeSession,
        );

        if (acc.status === 'healthy') {
          targetStore.db
            .prepare("UPDATE provider_accounts SET status='healthy', lastSuccessAt=? WHERE id=?")
            .run(acc.lastSuccessAt ?? Date.now(), created.id);
        }

        clonedAccountIds.add(created.id);
        clonedAccounts.push(created);
        accountsCloned += 1;
      }

      if (enabledRows.length > 0 && accountsCloned === 0 && excludedAccountsCount > 0) {
        throw new Error(
          `All ${excludedAccountsCount} enabled App Pool account(s) matched --exclude-accounts (${excludeTokens.join(', ')}). Remove an exclusion or enable another provider account.`,
        );
      }

      if (tables.has('provider_priorities')) {
        const priorityRows = srcDb
          .prepare('SELECT preset, rank, updatedAt FROM provider_priorities ORDER BY rank ASC')
          .all();
        if (priorityRows.length > 0) {
          targetStore.tx(() => {
            const stmt = targetStore.db.prepare(
              'INSERT OR REPLACE INTO provider_priorities(preset, rank, updatedAt) VALUES(?,?,?)',
            );
            for (const pr of priorityRows) {
              stmt.run(pr.preset, pr.rank, pr.updatedAt ?? Date.now());
            }
          });
        }
      }

      if (tables.has('pool_models') && clonedAccountIds.size > 0) {
        const poolModelRows = srcDb
          .prepare('SELECT * FROM pool_models ORDER BY preset ASC, upstreamModel ASC')
          .all();
        targetStore.tx(() => {
          const upsertStmt = targetStore.db.prepare(
            `INSERT INTO pool_models(
              id, accountId, preset, upstreamModel, displayName, enabled, visible,
              source, multiplier, contextWindow, maxOutput, capabilities, createdAt, updatedAt
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(accountId, upstreamModel) DO UPDATE SET
              displayName = excluded.displayName,
              enabled = excluded.enabled,
              visible = excluded.visible,
              source = excluded.source,
              multiplier = excluded.multiplier,
              contextWindow = excluded.contextWindow,
              maxOutput = excluded.maxOutput,
              capabilities = excluded.capabilities,
              updatedAt = excluded.updatedAt`,
          );
          for (const pm of poolModelRows) {
            if (!clonedAccountIds.has(pm.accountId)) continue;
            upsertStmt.run(
              pm.id,
              pm.accountId,
              pm.preset,
              pm.upstreamModel,
              pm.displayName ?? pm.upstreamModel,
              pm.enabled ?? 1,
              pm.visible ?? 1,
              pm.source ?? 'remote',
              pm.multiplier ?? 1.0,
              pm.contextWindow ?? 128000,
              pm.maxOutput ?? 16384,
              pm.capabilities ?? '{}',
              pm.createdAt ?? Date.now(),
              pm.updatedAt ?? Date.now(),
            );
          }
        });
      }

      if (tables.has('model_mappings')) {
        const mappingRows = srcDb
          .prepare('SELECT * FROM model_mappings ORDER BY priority ASC, alias ASC')
          .all();
        targetStore.tx(() => {
          const findStmt = targetStore.db.prepare(
            `SELECT id FROM model_mappings
             WHERE id = ? OR (alias = ? AND targetPreset IS ? AND targetAccountId IS ? AND targetModel = ?)`,
          );
          const updateStmt = targetStore.db.prepare(
            `UPDATE model_mappings
             SET alias=?, targetPreset=?, targetAccountId=?, targetModel=?, enabled=?, isDefault=?, priority=?, updatedAt=?
             WHERE id=?`,
          );
          const insertStmt = targetStore.db.prepare(
            `INSERT INTO model_mappings(
              id, alias, targetPreset, targetAccountId, targetModel, enabled, isDefault, priority, createdAt, updatedAt
            ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
          );
          for (const mm of mappingRows) {
            if (mm.targetAccountId && !clonedAccountIds.has(mm.targetAccountId)) continue;
            const existing = findStmt.get(
              mm.id,
              mm.alias,
              mm.targetPreset ?? null,
              mm.targetAccountId ?? null,
              mm.targetModel,
            );
            if (existing) {
              updateStmt.run(
                mm.alias,
                mm.targetPreset ?? null,
                mm.targetAccountId ?? null,
                mm.targetModel,
                mm.enabled ?? 1,
                mm.isDefault ?? 0,
                mm.priority ?? 100,
                mm.updatedAt ?? Date.now(),
                existing.id,
              );
            } else {
              insertStmt.run(
                mm.id,
                mm.alias,
                mm.targetPreset ?? null,
                mm.targetAccountId ?? null,
                mm.targetModel,
                mm.enabled ?? 1,
                mm.isDefault ?? 0,
                mm.priority ?? 100,
                mm.createdAt ?? Date.now(),
                mm.updatedAt ?? Date.now(),
              );
            }
          }
        });
      }

      if (tables.has('kv_settings')) {
        const defaultRow = srcDb
          .prepare("SELECT value FROM kv_settings WHERE key = 'pool.default_model'")
          .get();
        if (defaultRow?.value != null) {
          const parsedDefault = parseJsonSafe(defaultRow.value, defaultRow.value);
          const cleanDefault = String(parsedDefault ?? '').trim();
          if (cleanDefault) {
            sourceDefaultModel = cleanDefault;
            targetPool.setDefaultModel(cleanDefault);
          }
        }
      }
    } finally {
      srcDb.close();
    }
  }

  if (accountsCloned === 0 && hasEnvFallback) {
    const envAccounts = cloneFromProviderEnvFallback({
      sourceDataDir,
      targetPool,
      model,
      env,
    });
    for (const acc of envAccounts) {
      clonedAccountIds.add(acc.id);
      clonedAccounts.push(acc);
      accountsCloned += 1;
    }
  }

  const cleanRequestedModel = typeof model === 'string' && model.trim() ? model.trim() : null;
  const cleanSupervisorModel =
    typeof supervisorModel === 'string' &&
    supervisorModel.trim() &&
    !['off', 'deterministic', 'auto'].includes(supervisorModel.trim().toLowerCase())
      ? supervisorModel.trim()
      : null;

  for (const requested of [cleanRequestedModel, cleanSupervisorModel].filter(Boolean)) {
    const catalog = targetPool.getActiveCatalog();
    const inCatalog = catalog.items.some((item) => item.alias === requested);
    if (!inCatalog) {
      const compatible = clonedAccounts.find((acc) => isPresetCompatibleWithModel(acc.preset, requested));
      if (compatible) {
        targetPool.addManualModel({ accountId: compatible.id, upstreamModel: requested });
      }
    }
  }

  if (cleanRequestedModel) {
    targetPool.setDefaultModel(cleanRequestedModel);
  }

  modelsCloned = Number(
    targetStore.db.prepare('SELECT COUNT(*) AS n FROM pool_models WHERE enabled = 1').get()?.n ?? 0,
  );
  const catalog = targetPool.getActiveCatalog();
  const availableModels = catalog.items.map((item) => item.alias);
  const defaultModel = targetPool.getDefaultModel() || sourceDefaultModel || availableModels[0] || null;

  return {
    sourceDataDir,
    accountsCloned,
    excludedAccountsCount,
    modelsCloned,
    defaultModel,
    availableModels,
  };
}

/**
 * Returns true if any supported benchmark or provider API key env var is populated.
 */
export function hasExplicitEnvProviderKey(env = process.env) {
  return BENCH_API_KEY_ENV_VARS.some((k) => String(env?.[k] ?? '').trim().length > 0);
}

/**
 * Resolves live provider key, endpoint, protocol, and default model from CLI options
 * and environment variables with provider-aware endpoint inference.
 */
export function resolveLiveProviderConfig(opts = {}, env = process.env) {
  const explicitKey = String(opts?.apiKey ?? '').trim();
  const envKeyHit = explicitKey
    ? { key: 'opts.apiKey', value: explicitKey }
    : readFirstNonEmptyEnv(env, BENCH_API_KEY_ENV_VARS);
  const apiKey = envKeyHit.value;
  const keySource = envKeyHit.key;

  const hasOpenAiKey = Boolean(String(env?.OPENAI_API_KEY ?? '').trim());
  const hasDeepSeekKey = Boolean(String(env?.DEEPSEEK_API_KEY ?? '').trim());
  const explicitModel = String(opts?.model ?? '').trim();
  const envModelHit = readFirstNonEmptyEnv(env, BENCH_MODEL_ENV_VARS);
  const model =
    explicitModel ||
    envModelHit.value ||
    (apiKey && hasDeepSeekKey && apiKey === String(env?.DEEPSEEK_API_KEY ?? '').trim() && !hasOpenAiKey
      ? 'deepseek-chat'
      : 'deepseek-chat');

  const explicitEndpoint = String(opts?.endpoint ?? '').trim();
  const envEndpointHit = readFirstNonEmptyEnv(env, BENCH_ENDPOINT_ENV_VARS);
  const rawExplicitEndpoint = explicitEndpoint || envEndpointHit.value;

  const explicitProtocol = String(opts?.protocol ?? '').trim().toLowerCase();
  const envProtocolHit = readFirstNonEmptyEnv(env, BENCH_PROTOCOL_ENV_VARS);
  const rawExplicitProtocol = explicitProtocol || envProtocolHit.value.toLowerCase();

  let endpoint = rawExplicitEndpoint.replace(/\/+$/, '');
  let protocol = rawExplicitProtocol;

  if (!endpoint) {
    if (keySource === 'DEEPSEEK_API_KEY') {
      endpoint = 'https://api.deepseek.com/v1';
      if (!protocol) protocol = 'openai';
    } else if (keySource === 'ANTHROPIC_API_KEY' || /^claude-/i.test(model)) {
      endpoint = 'https://api.anthropic.com';
      if (!protocol) protocol = 'anthropic';
    } else if (/^deepseek-/i.test(model) && !hasOpenAiKey) {
      endpoint = 'https://api.deepseek.com/v1';
      if (!protocol) protocol = 'openai';
    } else {
      endpoint = 'https://api.openai.com/v1';
      if (!protocol) protocol = 'openai';
    }
  } else if (!protocol) {
    protocol =
      keySource === 'ANTHROPIC_API_KEY' || /^claude-/i.test(model) || /anthropic\.com/i.test(endpoint)
        ? 'anthropic'
        : 'openai';
  }

  const preset =
    protocol === 'anthropic'
      ? endpoint === 'https://api.anthropic.com'
        ? 'anthropic'
        : 'custom-anthropic'
      : endpoint === 'https://api.deepseek.com/v1'
        ? 'deepseek'
        : endpoint === 'https://api.openai.com/v1'
          ? 'openai'
          : 'custom-openai';

  return {
    apiKey,
    endpoint,
    protocol: protocol || 'openai',
    model,
    preset,
    keySource,
  };
}

/**
 * Returns true for thinking/reasoning models (e.g. deepseek-reasoner, deepseek-v4, r1, o1, o3, o4, thinking, qwq)
 * that must be decoupled from synchronous ACI admission supervisor calls.
 */
export function isThinkingOrReasoningModel(modelId, capabilities = null) {
  if (capabilities && typeof capabilities === 'object' && capabilities.reasoning === true) {
    return true;
  }
  const id = String(modelId ?? '').trim().toLowerCase();
  if (!id) return false;
  return (
    REASONING_MODEL_TOKEN_RE.test(id) ||
    REASONING_MODEL_PREFIX_RE.test(id) ||
    /deepseek-(?:r1|reasoner)/i.test(id) ||
    /\bdeepseek-v4\b/i.test(id)
  );
}

function collectFastSupervisorCandidateModels({ mainModel, availableModels = [], targetPool = null }) {
  const mainFamily = inferModelFamily(mainModel);
  const mainNorm = String(mainModel ?? '').trim().toLowerCase();
  const now = Date.now();
  const candidates = new Map();

  const register = (rawName, healthyHint = true, capabilities = null) => {
    const name = String(rawName ?? '').trim();
    if (!name) return;
    const prev = candidates.get(name);
    if (prev) {
      prev.healthy = prev.healthy && healthyHint;
      if (!prev.capabilities && capabilities) prev.capabilities = capabilities;
      return;
    }
    candidates.set(name, { model: name, healthy: healthyHint, capabilities });
  };

  if (Array.isArray(availableModels)) {
    for (const item of availableModels) {
      if (typeof item === 'string') {
        register(item, true);
      } else if (item && typeof item === 'object') {
        const name = item.alias ?? item.id ?? item.upstreamModel ?? item.model;
        const healthyHint = item.healthy !== false && item.enabled !== false;
        register(name, healthyHint, item.capabilities ?? null);
      }
    }
  }

  if (targetPool && typeof targetPool.getActiveCatalog === 'function') {
    const catalog = targetPool.getActiveCatalog();
    for (const item of catalog?.items ?? []) {
      const alias = String(item?.alias ?? '').trim();
      if (!alias) continue;
      const routes = typeof targetPool.resolveRoutes === 'function' ? targetPool.resolveRoutes(alias) : [];
      const healthy = typeof targetPool.resolveRoutes === 'function' ? isHealthyRouteList(routes, now) : true;
      const caps = catalog?.profiles?.[alias]?.capabilities ?? item?.capabilities ?? null;
      register(alias, healthy, caps);
    }
  }

  const scored = [];
  for (const entry of candidates.values()) {
    const name = entry.model;
    if (!entry.healthy) continue;
    if (mainNorm && name.toLowerCase() === mainNorm) continue;
    if (isThinkingOrReasoningModel(name, entry.capabilities)) continue;
    if (UTILITY_MODEL_RE.test(name)) continue;
    if (HEAVY_NON_REASONING_RE.test(name)) continue;
    if (!FAST_TIER_MODEL_RE.test(name) && !/^deepseek-chat$/i.test(name)) continue;

    if (targetPool && typeof targetPool.resolveRoutes === 'function') {
      const routes = targetPool.resolveRoutes(name);
      if (!isHealthyRouteList(routes, now)) continue;
    }

    let score = 0;
    const fam = inferModelFamily(name);
    if (mainFamily && fam === mainFamily) score += 30;
    if (/^deepseek-chat$/i.test(name)) score += 25;
    if (FAST_TIER_MODEL_RE.test(name)) score += 20;
    scored.push({ model: name, score });
  }

  scored.sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));
  return scored[0]?.model ?? null;
}

/**
 * Computes the ACI ContextSupervisor configuration for a benchmark `(arm, mainModel)` run,
 * enforcing deterministic admission fallback whenever `mainModel` is a slow reasoning/thinking
 * model or no distinct lightweight non-reasoning side model exists in the pool.
 */
export function resolveSupervisorExecutionConfig({
  arm,
  mainModel,
  supervisorModel = null,
  deterministicAdmission = false,
  availableModels = [],
  targetPool = null,
} = {}) {
  const normalizedArm = String(arm ?? '').trim().toLowerCase();
  if (normalizedArm === 'raw_full') {
    return {
      enabled: false,
      mode: 'off',
      model: null,
      admissionEnabled: false,
      reason: 'raw_full',
    };
  }

  const rawSup = typeof supervisorModel === 'string' ? supervisorModel.trim() : '';
  const lowerSup = rawSup.toLowerCase();

  if (
    normalizedArm === 'deterministic_progressive' ||
    Boolean(deterministicAdmission) ||
    lowerSup === 'off' ||
    lowerSup === 'deterministic'
  ) {
    return {
      enabled: false,
      mode: 'off',
      model: null,
      admissionEnabled: true,
      reason: 'deterministic',
    };
  }

  if (rawSup && lowerSup !== 'auto') {
    return {
      enabled: true,
      mode: 'custom',
      model: rawSup,
      admissionEnabled: true,
      reason: 'explicit_supervisor_model',
    };
  }

  const fastModel = collectFastSupervisorCandidateModels({
    mainModel,
    availableModels,
    targetPool,
  });
  if (fastModel) {
    return {
      enabled: true,
      mode: 'custom',
      model: fastModel,
      admissionEnabled: true,
      reason: 'auto_fast_model',
    };
  }

  return {
    enabled: false,
    mode: 'off',
    model: null,
    admissionEnabled: true,
    reason: isThinkingOrReasoningModel(mainModel)
      ? 'reasoning_main_deterministic_fallback'
      : 'no_distinct_fast_model_deterministic_fallback',
  };
}
