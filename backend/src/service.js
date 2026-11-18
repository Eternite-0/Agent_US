import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from './store.js';
import { bundle } from './bundle.js';
import { api } from './api.js';
import { Engine } from './engine.js';
import { Providers, config } from './providers.js';
import { toolset } from './tools.js';
import { ContextPolicy } from './context.js';
export async function service({
  root,
  token,
  configuration = config(),
  skills = join(root, 'skills'),
}) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const store = new Store(join(root, 'engine.sqlite'));
  let ctx, providers, engine, app;
  try {
    ctx = await bundle(store);
    providers = new Providers(configuration, store);
    app = api(ctx.taskEngine, token, providers);
    const policy = new ContextPolicy(skills, store);
    engine = new Engine({
      root,
      store,
      models: providers.models,
      adapter: providers.adapter,
      prepare: (e) => policy.prepare(e),
      observe: (...args) => policy.observe(...args),
      tools: (e) => toolset(e, { mcp: configuration.mcp }),
    });
    await providers.start();
    engine.start();
    return {
      app,
      store,
      engine,
      policy,
      providers,
      async close() {
        await app.close();
        await engine.stop();
        await providers.stop();
        await ctx.fiber.dispose();
        store.close();
      },
    };
  } catch (e) {
    await app?.close();
    await engine?.stop();
    await providers?.stop();
    await ctx?.fiber.dispose();
    store.close();
    throw e;
  }
}
