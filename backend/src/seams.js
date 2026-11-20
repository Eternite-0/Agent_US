import { Fault } from './store.js';
import { canonicalJson, sha256Hex } from './integrity.js';
import { decide, reconcile, sandbox } from './tools.js';
import { verifyTurn, decideRepair } from './verifier.js';

export const MANDATORY_SEAMS = Object.freeze([
  'approval',
  'billing',
  'artifacts',
  'sandbox',
  'verifier',
  'repair',
]);

const REQUIRED_METHODS = Object.freeze({
  approval: ['decide', 'reconcile'],
  billing: ['observeUsage'],
  artifacts: ['putBlob', 'getBlob'],
  sandbox: ['run'],
  verifier: ['verify'],
  repair: ['decide'],
});

async function initSeam(name, entry, timeoutMs) {
  if (!entry || typeof entry !== 'object') {
    throw new Fault('E_SEAM_MISSING', 500, { seam: name });
  }
  let impl = entry;
  if (typeof entry.create === 'function') {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      impl = await Promise.race([
        Promise.resolve(entry.create(ac.signal)),
        new Promise((_, reject) => {
          ac.signal.addEventListener(
            'abort',
            () =>
              reject(
                new Fault('E_SEAM_INIT', 500, {
                  seam: name,
                  reason: 'seam factory timeout',
                }),
              ),
            { once: true },
          );
        }),
      ]);
    } catch (err) {
      if (err instanceof Fault) throw err;
      throw new Fault('E_SEAM_INIT', 500, {
        seam: name,
        reason: String(err?.message ?? err),
      });
    } finally {
      clearTimeout(timer);
    }
  }
  const required = REQUIRED_METHODS[name] ?? [];
  for (const fn of required) {
    if (typeof impl?.[fn] !== 'function') {
      throw new Fault('E_SEAM_MISSING', 500, {
        seam: name,
        missingMethod: fn,
      });
    }
  }
  return Object.freeze({
    id: String(entry.id ?? impl.id ?? `builtin.${name}`),
    version: String(entry.version ?? impl.version ?? '1.0.0'),
    impl,
  });
}

/**
 * Fail-closed mandatory seam resolver (Agnes 6-seam subset for Agent_US).
 * Missing, incomplete, or hung seam providers abort startup with E_SEAM_MISSING / E_SEAM_INIT.
 */
export async function resolveSeams(providers, { timeoutMs = 15000 } = {}) {
  if (!providers || typeof providers !== 'object') {
    throw new Fault('E_SEAM_MISSING', 500, { seam: MANDATORY_SEAMS[0] });
  }
  const resolved = {};
  const manifest = {};
  for (const name of MANDATORY_SEAMS) {
    const entry = await initSeam(name, providers[name], timeoutMs);
    resolved[name] = entry.impl;
    manifest[name] = { id: entry.id, version: entry.version };
  }
  const digest = sha256Hex(canonicalJson(manifest));
  return Object.freeze({
    ...resolved,
    manifest: Object.freeze(manifest),
    digest,
  });
}

export function createDefaultSeams(store) {
  return {
    approval: {
      id: 'agent-us.approval',
      version: '1.0.0',
      decide: (approvalId, input) => decide(store, approvalId, input),
      reconcile: (approvalId, input) => reconcile(store, approvalId, input),
    },
    billing: {
      id: 'agent-us.billing',
      version: '1.0.0',
      observeUsage: (usage, task, model, sessionId) =>
        store.add(
          'usage',
          {
            sessionId,
            provider: model.provider,
            model: model.model,
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            estimatedUSD:
              ((usage.inputTokens ?? 0) * model.inputRate +
                (usage.outputTokens ?? 0) * model.outputRate) /
              1e6,
          },
          task.projectId,
          task.id,
        ),
    },
    artifacts: {
      id: 'agent-us.artifacts',
      version: '1.0.0',
      putBlob: (text) => store.putBlob(text),
      getBlob: (uri) => store.getBlob(uri),
    },
    sandbox: {
      id: 'agent-us.docker-codex',
      version: '1.0.0',
      run: (argv, files, opts) => sandbox(argv, files, opts),
    },
    verifier: {
      id: 'agent-us.t0-verifier',
      version: '1.0.0',
      verify: (input) => verifyTurn(input),
    },
    repair: {
      id: 'agent-us.bounded-repair',
      version: '1.0.0',
      decide: (input) => decideRepair(input),
    },
  };
}
