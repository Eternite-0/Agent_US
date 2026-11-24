// The backend, SQLite history, terminal executor and SSE are real. Only the
// upstream model stream is scripted; the real pool records its usage in SQLite.
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { api } from '../../../backend/src/api.js';
import { Store } from '../../../backend/src/store.js';
import { AccountPool } from '../../../backend/src/pool.js';
import { DirectAgentRuntime } from '../../../backend/src/direct-agent.js';
import { MetricsCollector } from '../../../backend/src/observability/metrics.js';

const root = await mkdtemp(join(tmpdir(), 'agent-us-runtime-browser-'));
const workspace = join(root, 'workspace');
const reviewWorkspace = join(root, 'review workspace');
await Promise.all([mkdir(workspace), mkdir(reviewWorkspace)]);
await writeFile(join(reviewWorkspace, 'review-fixture.js'), 'export const example = 1;\n');
const first = 'run-first.mjs';
const second = 'run-second.mjs';
await writeFile(join(workspace, first), 'await new Promise(r => setTimeout(r, 400)); console.log("RUNTIME-FIRST-OUTPUT");');
await writeFile(join(workspace, second), 'console.log("RUNTIME-SECOND-OUTPUT");');

const model = 'browser-scripted-model';
const providers = { models: [{ model, provider: 'test' }], list: () => [] };
const store = new Store(join(root, 'engine.sqlite'));
const metrics = new MetricsCollector({ store });
const pool = new AccountPool(store, { root, legacyProviders: providers, metrics });
const gates = [Promise.withResolvers(), Promise.withResolvers()];
let step = 0;
const upstream = createHttpServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { req.resume(); return res.writeHead(404).end(); }
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const body = JSON.parse(Buffer.concat(buffers).toString('utf8'));
  const messages = JSON.stringify(body.messages);
  if (messages.includes('替我审查未提交的变更')) {
    const content = messages.includes('review-fixture.js') && messages.includes('review-evidence-')
      ? 'REVIEW EVIDENCE RECEIVED' : 'REVIEW EVIDENCE MISSING';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }
  if (messages.includes('Runtime permission menu check')) {
    const progress = body.messages.filter(message => message.role === 'tool').length;
    const delta = progress < 2 ? { tool_calls: [{
      index: 0, id: `permission-probe-${progress}`, type: 'function', function: {
        name: 'bash', arguments: JSON.stringify({ command: progress === 0 ? 'pwd' : `node ${second}` }),
      },
    }] } : { content: 'PERMISSION CHECK COMPLETE' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: progress < 2 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }
  const index = step++;
  if (index < 2) await gates[index].promise;
  const delta = index < 2 ? { tool_calls: [{
    index: 0, id: `real-shell-${index}`, type: 'function', function: {
      name: 'bash', arguments: JSON.stringify({ command: `node ${index === 0 ? first : second}` }),
    },
  }] } : { content: 'BROWSER RUNTIME COMPLETE' };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: index < 2 ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1000, completion_tokens: 10, cache_creation_input_tokens: 25,
      prompt_tokens_details: { cached_tokens: [0, 500, 1000][index] ?? 1000 } },
  })}\n\n`);
  res.end('data: [DONE]\n\n');
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
pool.createAccount({ preset: 'workbuddy', protocol: 'openai', priority: 10,
  credential: 'test-only', endpoint: `http://127.0.0.1:${upstream.address().port}/v1`, models: [model] });
pool.setDefaultModel(model);
const agent = new DirectAgentRuntime(store, pool, { defaultWorkspace: workspace, dataRoot: root, metrics });
const token = randomBytes(32).toString('hex');
const backend = api(store, token, providers, { pool, directAgent: agent });
backend.get('/v1/_e2e/review-workspace', async () => ({ workspaceRoot: reviewWorkspace }));
backend.post('/v1/_e2e/gates/:index', async (request, reply) => {
  const gate = gates[Number(request.params.index)];
  if (!gate) return reply.code(404).send({ ok: false });
  gate.resolve();
  return { ok: true };
});

let vite;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const gate of gates) gate.resolve();
  await Promise.allSettled([vite?.close(), agent.close()]);
  await backend.close();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  store.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(0)); });
try {
  process.env.BACKEND_URL = await backend.listen({ host: '127.0.0.1', port: 0 });
  process.env.BACKEND_TOKEN = token;
  process.env.BACKEND_DATA = root;
  vite = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { host: '127.0.0.1', port: Number(process.env.RUNTIME_BROWSER_PORT ?? 4182), strictPort: true },
  });
  await vite.listen();
} catch {
  console.error('Could not start the isolated Direct runtime browser service. Install frontend and backend dependencies and check port availability.');
  await stop();
  process.exitCode = 1;
}
