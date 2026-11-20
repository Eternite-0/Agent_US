import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Store } from './store.js';
import { bundle } from './bundle.js';
import { api } from './api.js';
import { Engine } from './engine.js';
import { Providers, config } from './providers.js';
import { AccountPool } from './pool.js';
import { DirectAgentRuntime } from './direct-agent.js';
import { CheckinService } from './checkin.js';
import { WebLoginService } from './web-login.js';
import { toolset } from './tools.js';
import { ContextPolicy, guardToolOutput } from './context.js';
import { mintNonce, wrapUntrusted } from './envelope.js';
import { JudgmentService } from './judgment.js';
import { RefinementService } from './refinement.js';
import { createDefaultSeams } from './seams.js';

const ROLES = ['Researcher', 'Planner', 'Coder', 'Reviewer', 'Tester'];

class HybridAdapter extends LlmAdapter {
  constructor(pool, legacyProviders) {
    super();
    this.pool = pool;
    this.legacyProviders = legacyProviders;
  }
  async *stream(options) {
    const poolRoutes = this.pool.resolveRoutes(options.model, {
      provider:
        options.provider && options.provider !== 'pool'
          ? options.provider
          : null,
      sessionKey: options.sessionKey ?? null,
    });
    if (poolRoutes.some((r) => r.source === 'pool')) {
      yield* this.pool.adapter.stream(options);
      return;
    }
    yield* this.legacyProviders.adapter.stream(options);
  }
}

export async function service({
  root,
  token,
  configuration = config(),
  skills = join(root, 'skills'),
  seams = undefined,
  workspaceRoot = process.env.AGENT_WORKSPACE || undefined,
}) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const store = new Store(join(root, 'engine.sqlite'));
  let ctx, providers, pool, directAgent, checkin, engine, app;
  try {
    ctx = await bundle(store, '', {
      seams: seams === undefined ? createDefaultSeams(store) : seams,
    });
    providers = new Providers(configuration, store);
    const judgment = new JudgmentService({
      provider: providers.sideModel,
      uses: configuration.judgment ?? {},
      maxAutoReviews: configuration.judgment?.maxAutoReviews ?? 20,
    });
    pool = new AccountPool(store, { root, legacyProviders: providers });
    const defaultWorkspace = workspaceRoot
      ? resolve(workspaceRoot)
      : resolve(dirname(root), '..');
    directAgent = new DirectAgentRuntime(store, pool, {
      defaultWorkspace,
      dataRoot: root,
      judgment,
      staticMcp: configuration.mcp ?? {},
    });
    checkin = new CheckinService(store, pool, { root });
    const webLogin = new WebLoginService(store, pool, { root });
    const hybridAdapter = new HybridAdapter(pool, providers);
    const policy = new ContextPolicy(skills, store);
    const snapshotPin = async (body) => {
      const skillsByRole = {};
      for (const r of ROLES) {
        skillsByRole[r] = await policy.skills(r);
      }
      return {
        seamDigest: ctx.seams.digest,
        approvalMode: body.approvalMode ?? 'manual',
        skillsByRole,
        pinnedAt: Date.now(),
      };
    };
    app = api(ctx.taskEngine, token, providers, {
      snapshotPin,
      pool,
      directAgent,
      checkin,
      webLogin,
    });
    const refinement = new RefinementService(store, {
      enabled: configuration.refinement?.enabled ?? false,
      cooldownMs: configuration.refinement?.cooldownMs ?? 120_000,
    });
    engine = new Engine({
      root,
      store,
      models: providers.models,
      adapter: hybridAdapter,
      judgment,
      verifier: (input) => ctx.seams.verifier.verify(input),
      repairPolicy: (input) => ctx.seams.repair.decide(input),
      onTaskSettled: async ({ task, verdict }) => {
        if (!refinement.enabled || !verdict?.accepted) return;
        const evs = store.list('evidence', { taskId: task.id, limit: 50 });
        await refinement.distill({
          projectId: task.projectId,
          taskId: task.id,
          trigger: 'task_completed',
          evidence: evs,
          verdict,
        });
      },
      prepare: (e) => policy.prepare(e),
      observe: (...args) => policy.observe(...args),
      tools: (e) => {
        let outSeq = 0;
        const nonce = e.nonce ?? (e.nonce = mintNonce());
        return toolset(e, {
          mcp: configuration.mcp,
          runner: (argv, files, opts) => ctx.seams.sandbox.run(argv, files, opts),
          includeReadBlob: true,
          formatOutput: (name, text, db) =>
            wrapUntrusted(
              nonce,
              `tool-${name}-${++outSeq}`,
              guardToolOutput(name, text, db),
            ),
        });
      },
    });
    await providers.start();
    checkin.start();
    engine.start();
    return {
      app,
      store,
      engine,
      policy,
      providers,
      pool,
      directAgent,
      checkin,
      judgment,
      refinement,
      seams: ctx.seams,
      async close() {
        checkin.stop();
        directAgent.close();
        await app.close();
        await engine.stop();
        await providers.stop();
        await ctx.fiber.dispose();
        store.close();
      },
    };
  } catch (e) {
    checkin?.stop();
    directAgent?.close();
    await app?.close();
    await engine?.stop();
    await providers?.stop();
    await ctx?.fiber.dispose();
    store.close();
    throw e;
  }
}
