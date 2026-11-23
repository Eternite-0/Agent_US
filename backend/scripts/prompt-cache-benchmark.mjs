// Run against a dedicated, metered provider account. See the release report.
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { normalizeProviderUsage } from '../src/observability/prompt-cache.js';

const endpointValue = process.env.CACHE_BENCH_ENDPOINT;
const model = process.env.CACHE_BENCH_MODEL;
const key = process.env.CACHE_BENCH_KEY;
if (!endpointValue || !key || !model) throw new Error('Set CACHE_BENCH_ENDPOINT, CACHE_BENCH_MODEL and CACHE_BENCH_KEY');
const endpoint = new URL(endpointValue);
const { service } = await import(pathToFileURL(resolve(process.env.CACHE_BENCH_SOURCE ?? '.', 'backend/src/service.js')).href);
const protocol = process.env.CACHE_BENCH_PROTOCOL === 'anthropic' ? 'anthropic' : 'openai';
const requested = process.argv.slice(2);
const tmp = await mkdtemp(join(tmpdir(), 'agent-cache-bench-'));
let runtime, scenario;
const rows = [];
const originalFetch = globalThis.fetch;
// Capture only numeric usage, from the same wire response on both revisions.
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== endpoint.origin || !/\/(chat\/completions|messages)$/.test(url.pathname)) return originalFetch(input, init);
  const started = performance.now();
  const row = { scenario, status: null, completed: false, durationMs: null, usage: null };
  rows.push(row);
  let response;
  try {
    response = await originalFetch(input, init);
  } catch (err) {
    row.durationMs = Math.round(performance.now() - started);
    throw err;
  }
  row.status = response.status;
  if (!response.ok || !response.body) {
    row.durationMs = Math.round(performance.now() - started);
    return response;
  }
  let buffer = '', usage = {};
  const decoder = new TextDecoder();
  const consume = (text) => {
    const lines = (buffer + text).split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      try {
        const frame = JSON.parse(line.slice(5));
        const next = frame.message?.usage ?? frame.usage;
        if (next) {
          usage = { ...usage, ...next };
          row.usage = normalizeProviderUsage(protocol, usage);
        }
      } catch { /* comments and [DONE] contain no usage */ }
    }
  };
  return new Response(response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) { consume(decoder.decode(chunk, { stream: true })); controller.enqueue(chunk); },
    flush() {
      consume(decoder.decode() + '\n');
      row.completed = true;
      row.durationMs = Math.round(performance.now() - started);
      row.usage = normalizeProviderUsage(protocol, usage);
    },
  })), { status: response.status, headers: response.headers });
};

const corpus = Array.from({ length: 95 }, (_, i) =>
  `Entry ${i}: A small inventory service stores shipment identifiers, regional arrival windows, and warehouse labels. Reviewers verify the recorded values against a quarterly manifest and write discrepancies to a plain text ledger.`).join('\n');
const specs = {
  plain: ['Reply with one sentence introducing an inventory ledger.', 'What are two advantages of the ledger? Reply concisely.', 'Summarize both answers in one line.'],
  edits: ['Read stock.js, then use edit_file to replace the line export const limit = 10; with export const limit = 12; and verify by rereading it.', 'Use edit_file to replace the line export const limit = 12; in stock.js with export const stockLimit = 15; and verify by rereading it.'],
  long: [`Use this synthetic inventory guide as background:\n${corpus}\nWhat does entry 12 describe?`, 'Based on the same guide, list the fields in entry 38.', 'Compare the descriptions in entries 56 and 90, briefly.'],
  tools: ['Use read_file to read stock.js, notes.txt and labels.txt separately, then summarize the three files.', 'Read labels.txt and stock.js separately again. Report the two values in one sentence.'],
  compact: [`Retain the following inventory context for a follow-up:\n${corpus}\nAnswer in one line.`, 'What is an arrival window? Give a short definition.', 'Which identifier is associated with a shipment?', 'Summarize the roles of the reviewers.', 'Now summarize the inventory process in one short sentence.'],
  swarm: null,
};
for (const name of requested) if (!(name in specs)) throw new Error(`Unknown scenario ${name}`);
const token = randomUUID();
const auth = { authorization: `Bearer ${token}` };
const results = {};
try {
  runtime = await service({ root: join(tmp, 'state'), token, workspaceRoot: tmp,
    configuration: { providers: [], models: [], mcp: {} } });
  runtime.pool.createAccount({ preset: 'workbuddy', label: 'benchmark', endpoint: endpoint.href,
    protocol, credential: key, models: [model] });
  runtime.pool.setDefaultModel(model);
  for (const [name, prompts] of Object.entries(specs)) {
    if (requested.length && !requested.includes(name)) continue;
    scenario = name;
    const workspaceRoot = join(tmp, name);
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, 'stock.js'), 'export const limit = 10;\n');
    await writeFile(join(workspaceRoot, 'notes.txt'), 'warehouse: East\n');
    await writeFile(join(workspaceRoot, 'labels.txt'), 'label: ready\n');
    const session = runtime.directAgent.createSession({ workspaceRoot, model,
      permissionMode: 'auto-safe', trafficSource: 'test', isSynthetic: true });
    const states = [];
    const post = (input, body = {}) => runtime.app.inject({ method: 'POST',
      url: `/v1/sessions/${session.id}/turns`, headers: { ...auth },
      payload: { input, ...body } });
    if (name === 'swarm') {
      const res = await post('/swarm 分别通过独立只读节点检查 stock.js 和 labels.txt，再汇总两个值。不修改文件。',
        { budget: { maxDurationMs: 120000, maxTotalSteps: 12, maxOutputTokens: 2048 } });
      if (res.statusCode === 200) {
        const id = res.json().runId;
        await runtime.directAgent.swarmOrchestrator.waitForRun(id, { timeoutMs: 125000 }).catch(() => null);
        const run = runtime.directAgent.swarmOrchestrator.getRun(id);
        states.push({ state: run.status, nodes: run.nodes.length });
      } else states.push({ http: res.statusCode });
    } else for (const [i, input] of prompts.entries()) {
      if (name === 'compact' && i === prompts.length - 1) {
        const compact = await runtime.app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/compact`, headers: auth });
        states.push({ compactHttp: compact.statusCode,
          active: Boolean(runtime.directAgent.getSession(session.id).activeCompactionId) });
      }
      const res = await post(input, { maxSteps: 6 });
      if (res.statusCode !== 200) { states.push({ http: res.statusCode }); break; }
      const { id } = res.json().turn;
      const started = Date.now();
      let row;
      do {
        if (name === 'edits') {
          const approvals = runtime.store.db.prepare("SELECT id, tool, arguments FROM direct_approvals WHERE turnId=? AND status='pending'").all(id);
          for (const approval of approvals) {
            let args;
            try { args = JSON.parse(approval.arguments); } catch { continue; }
            if (approval.tool !== 'edit_file' || resolve(workspaceRoot, args.path ?? '') !== join(workspaceRoot, 'stock.js')) continue;
            const target = i === 0 ? 'export const limit = 10;' : 'export const limit = 12;';
            const replacement = i === 0 ? 'export const limit = 12;' : 'export const stockLimit = 15;';
            if (args.target?.trim() !== target || args.replacement?.trim() !== replacement) continue;
            runtime.directAgent.decideApproval(approval.id, { decision: 'allow', scope: 'once', reason: 'Exact synthetic fixture edit' });
          }
        }
        await sleep(125);
        row = runtime.store.db.prepare('SELECT state FROM direct_turns WHERE id=?').get(id);
      } while (row?.state === 'running' && Date.now() - started < 95_000);
      if (row?.state === 'running') row = runtime.directAgent.cancelTurn(id);
      states.push({ state: row?.state, toolCalls: runtime.store.db.prepare('SELECT COUNT(*) AS n FROM tool_receipts WHERE turnId=?').get(id).n });
    }
    results[name] = { states, ...(name === 'edits' ? { verifiedFile: /stockLimit\s*=\s*15/.test(await readFile(join(workspaceRoot, 'stock.js'), 'utf8')) } : {}) };
    console.error(`Finished ${name}: ${JSON.stringify(results[name])}`);
  }
} finally {
  if (runtime) await runtime.close();
  await rm(tmp, { recursive: true });
  console.log(JSON.stringify({ model, protocol, results, rows }, null, 2));
  if (Object.values(results).some(r => r.verifiedFile === false || r.states.some(s =>
    s.compactHttp != null ? !(s.compactHttp === 200 && s.active) : s.state !== 'completed'
  ))) process.exitCode = 1;
}
