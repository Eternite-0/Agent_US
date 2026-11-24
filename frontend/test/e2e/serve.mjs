import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { startFixture } from './sse-server.mjs';

// Do not even let Vite probe the repository's default data directory.
const temp = await mkdtemp(join(tmpdir(), 'agent-us-e2e-service-'));
const data = join(temp, 'data');
const workspace = join(temp, 'workspace');
await Promise.all([mkdir(data), mkdir(workspace)]);
process.env.BACKEND_DATA = data;
process.env.BACKEND_TOKEN = randomBytes(32).toString('hex');
const live = process.env.E2E_MODE === 'direct';
let vite, closeBackend;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await Promise.allSettled([vite?.close(), closeBackend?.()]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void stop().then(() => process.exit(0)); });
}

try {
  let target;
  if (live) {
    const { service } = await import('../../../backend/src/service.js');
    const backend = await service({
      root: data,
      token: process.env.BACKEND_TOKEN,
      workspaceRoot: workspace,
      configuration: { providers: [], models: [] },
    });
    closeBackend = () => backend.close();
    // Bootstrap the explicitly supplied *real* provider via authenticated Direct API.
    const account = await backend.app.inject({
      method: 'POST', url: '/v1/accounts',
      headers: { authorization: `Bearer ${process.env.BACKEND_TOKEN}` },
      payload: {
        preset: 'custom-openai', label: 'Playwright Direct provider',
        endpoint: process.env.E2E_PROVIDER_ENDPOINT, models: [process.env.E2E_PROVIDER_MODEL],
        credential: process.env.E2E_PROVIDER_API_KEY,
      },
    });
    delete process.env.E2E_PROVIDER_API_KEY;
    if (account.statusCode !== 200) throw new Error('provider setup failed');
    target = await backend.app.listen({ host: '127.0.0.1', port: 0 });
    if ((await fetch(`${target}/v1/sessions`)).status !== 401) throw new Error('authentication not enforced');
  } else {
    const fixture = await startFixture(workspace, process.env.BACKEND_TOKEN);
    closeBackend = fixture.close;
    target = fixture.url;
  }
  process.env.BACKEND_URL = target;
  const root = process.env.E2E_FRONTEND_DIR ?? fileURLToPath(new URL('../../', import.meta.url));
  vite = await createServer({
    root,
    mode: 'test',
    server: {
      host: '127.0.0.1', port: Number(process.env.E2E_PORT ?? 4179), strictPort: true,
      ...(live ? {} : { proxy: { '/__e2e': target } }),
    },
  });
  await vite.listen();
} catch (error) {
  // Backend/provider errors may contain request config. Do not log them in live runs.
  console.error(live ? 'Could not start isolated Direct E2E service. Check backend dependencies and provider settings.' : error);
  await stop();
  process.exitCode = 1;
}
