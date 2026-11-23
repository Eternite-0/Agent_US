import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

import {
  BenchmarkSandbox,
  DockerBenchmarkSandbox,
  SANDBOX_MODES,
  SANDBOX_TIERS,
  SandboxPolicyError,
  SandboxUnavailableError,
} from '../../src/tools/benchmark-sandbox.js';
import {
  HIDDEN_ENVELOPE_BEGIN,
  HIDDEN_ENVELOPE_END,
  computeWorkspaceArtifactDigest,
} from '../../src/evaluation/hidden-acceptance.js';
import { createDeterministicJudge, enforceDeterministicHardVeto } from '../../src/evaluation/judge.js';
import {
  DEFAULT_DEPENDENCY_POLICY,
  DEPENDENCY_POLICY_MODES,
  DependencyPolicyError,
  prepareDependencies,
  validateDependencyPolicy,
} from '../../src/evaluation/dependency-policy.js';
import {
  OSS_BENCHMARK_ID,
  createOssBenchmarkDataset,
} from '../../src/evaluation/external-benchmark.js';
import { createFixtureWorkspace, removeFixtureWorkspace } from '../../src/evaluation/fixtures.js';
import { EvaluationService } from '../../src/evaluation/service.js';
import { EVIDENCE_MANIFEST_SCHEMA_VERSION } from '../../src/evaluation/schemas.js';
import { DirectAgentRuntime } from '../../src/direct-agent.js';
import { AccountPool } from '../../src/pool.js';
import { Store } from '../../src/store.js';

const SYNTHETIC_SECRETS = Object.freeze({
  OPENAI_API_KEY: 'sk-synthetic-docker-test-0000000000000000',
  ANTHROPIC_API_KEY: 'sk-ant-synthetic-docker-test-0000000000',
  GITHUB_TOKEN: 'ghp_syntheticDockerToken1234567890abcdef',
  NPM_TOKEN: 'npm_syntheticDockerToken1234567890abcdef',
  DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:5432/synthetic_db',
  AGENT_US_SYNTHETIC_SECRET: 'synthetic-agent-us-secret-do-not-leak',
});

async function withSyntheticHostEnv(fn) {
  const prev = new Map();
  for (const [k, v] of Object.entries(SYNTHETIC_SECRETS)) {
    prev.set(k, Object.hasOwn(process.env, k) ? process.env[k] : undefined);
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, oldVal] of prev.entries()) {
      if (oldVal === undefined) delete process.env[k];
      else process.env[k] = oldVal;
    }
  }
}

async function startCanaryServer(host = '127.0.0.1') {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ canary: true }));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, host, resolveListen);
  });
  const addr = server.address();
  return {
    port: addr.port,
    url: `http://${host === '::1' ? '[::1]' : host}:${addr.port}/leak`,
    getHits: () => requests.length,
    close: () => new Promise((res) => server.close(() => res())),
  };
}

function listBenchContainers() {
  const res = spawnSync('docker', ['ps', '-a', '--filter', 'name=agent-us-bench-', '--format', '{{.Names}}'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    shell: false,
  });
  if (res.status !== 0) return [];
  return res.status === 0
    ? String(res.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : [];
}

function buildHermeticOssMirrors(mirrorRoot) {
  const makeMirror = (slug, files, msg) => {
    const work = join(mirrorRoot, `${slug}-src`);
    const bare = join(mirrorRoot, `${slug}.git`);
    mkdirSync(work, { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(work, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
    }
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    };
    spawnSync('git', ['init', '-q', '--initial-branch=main'], { cwd: work, env });
    spawnSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: work, env });
    spawnSync('git', ['config', 'user.name', 'Fixture'], { cwd: work, env });
    spawnSync('git', ['add', '--all'], { cwd: work, env });
    spawnSync('git', ['commit', '-qm', msg], { cwd: work, env });
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: work, env, encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['clone', '--bare', '--quiet', work, bare], { env });
    return { repoUrl: bare, commit: head };
  };

  const pkgFiles = {
    'oss-nanoid-batch-cli-01': [
      'nanoid',
      {
        'package.json': JSON.stringify({ name: 'nanoid', version: '5.1.6', type: 'module', bin: { nanoid: './bin/nanoid.js' } }, null, 2),
        'url-alphabet/index.js': "export const urlAlphabet = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWXYZ_GQZbfghjklqvwyzrict';\n",
        'index.js': "import { randomBytes } from 'node:crypto';\nimport { urlAlphabet } from './url-alphabet/index.js';\nexport { urlAlphabet };\nexport function nanoid(size = 21) {\n  const bytes = randomBytes(size);\n  let id = '';\n  for (let i = 0; i < size; i++) id += urlAlphabet[bytes[i] % urlAlphabet.length];\n  return id;\n}\n",
        'index.browser.js': "import { randomBytes } from 'node:crypto';\nimport { urlAlphabet } from './url-alphabet/index.js';\nexport { urlAlphabet };\nexport function nanoid(size = 21) {\n  const bytes = randomBytes(size);\n  let id = '';\n  for (let i = 0; i < size; i++) id += urlAlphabet[bytes[i] % urlAlphabet.length];\n  return id;\n}\n",
        'bin/nanoid.js': "#!/usr/bin/env node\nimport { nanoid } from '../index.js';\nprocess.stdout.write(nanoid() + '\\n');\n",
        'test/index.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { nanoid } from '../index.js';\ntest('baseline', () => assert.equal(nanoid().length, 21));\n",
        'test/non-secure.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('non-secure ok', () => assert.ok(true));\n",
        'test/pool.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('pool ok', () => assert.ok(true));\n",
        'test/bin.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('bin ok', () => assert.ok(true));\n",
      },
      'baseline nanoid',
    ],
    'oss-trough-pipeline-01': [
      'trough',
      {
        'package.json': JSON.stringify({ name: 'trough', version: '2.2.0', type: 'module', exports: './index.js' }, null, 2),
        'index.js': "export { trough, wrap } from './lib/index.js';\n",
        'lib/index.js': [
          'export function wrap(fn, callback) {',
          '  let called = false;',
          '  return function wrapped(...args) {',
          '    const done = (err, ...out) => { if (!called) { called = true; callback(err, ...out); } };',
          '    const maybeAsync = fn.length > args.length;',
          '    try {',
          '      const res = maybeAsync ? fn(...args, done) : fn(...args);',
          '      if (res && typeof res.then === "function") res.then((v) => done(null, v), (e) => done(e));',
          '      else if (res instanceof Error) done(res);',
          '      else if (!maybeAsync) done(null, res);',
          '    } catch (e) { done(e); }',
          '  };',
          '}',
          'export function trough() {',
          '  const fns = [];',
          '  const pipeline = {',
          '    use(fn) { if (typeof fn !== "function") throw new TypeError("Expected function"); fns.push(fn); return pipeline; },',
          '    run(...values) {',
          '      const cb = values.pop();',
          '      let idx = -1;',
          '      function next(err, ...out) {',
          '        const args = out.length ? out : values;',
          '        if (err) return cb(err);',
          '        const fn = fns[++idx];',
          '        if (!fn) return cb(null, ...args);',
          '        wrap(fn, (e, ...nextOut) => { if (e) return cb(e); next(null, ...(nextOut.map((v, i) => v === undefined ? args[i] : v))); })(...args);',
          '      }',
          '      next(null, ...values);',
          '    }',
          '  };',
          '  return pipeline;',
          '}',
        ].join('\n'),
        'test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { trough } from './index.js';\ntest('trough baseline', async () => { await new Promise((r) => trough().use((x) => x + 1).run(1, (e, v) => { assert.ifError(e); assert.equal(v, 2); r(); })); });\n",
      },
      'baseline trough',
    ],
    'oss-content-type-format-01': [
      'fast-content-type-parse',
      {
        'package.json': JSON.stringify({ name: 'fast-content-type-parse', version: '3.0.0', main: 'index.js' }, null, 2),
        'index.js': [
          "'use strict';",
          'const defaultContentType = Object.freeze({ type: "", parameters: Object.create(null) });',
          'function parse(header) {',
          '  if (typeof header !== "string") return defaultContentType;',
          '  const parts = header.split(";").map((s) => s.trim()).filter(Boolean);',
          '  const type = (parts.shift() || "").toLowerCase();',
          '  const parameters = Object.create(null);',
          '  for (const part of parts) {',
          '    const eq = part.indexOf("=");',
          '    if (eq === -1) continue;',
          '    const k = part.slice(0, eq).trim().toLowerCase();',
          '    let v = part.slice(eq + 1).trim();',
          '    if (v.startsWith("\\"") && v.endsWith("\\"")) v = v.slice(1, -1).replace(/\\\\(.)/g, "$1");',
          '    parameters[k] = v;',
          '  }',
          '  return { type, parameters };',
          '}',
          'module.exports = { parse, defaultContentType };',
          'module.exports.default = module.exports;',
        ].join('\n'),
        'test/index.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nconst { parse } = req('../index.js');\ntest('parse baseline', () => assert.equal(parse('Text/HTML').type, 'text/html'));\n",
      },
      'baseline content-type',
    ],
    'oss-nanoevents-hardening-01': [
      'nanoevents',
      {
        'package.json': JSON.stringify({ name: 'nanoevents', version: '9.1.0', type: 'module', types: 'index.d.ts' }, null, 2),
        'index.js': [
          'export const createNanoEvents = () => ({',
          '  events: {},',
          '  emit(event, ...args) {',
          '    const callbacks = this.events[event] || [];',
          '    for (let i = 0; i < callbacks.length; i++) callbacks[i](...args);',
          '  },',
          '  on(event, cb) {',
          '    (this.events[event] ||= []).push(cb);',
          '    return () => { this.events[event] = this.events[event]?.filter((i) => cb !== i); };',
          '  }',
          '});',
        ].join('\n'),
        'index.d.ts': 'export interface Emitter<Events = Record<string, any>> { events: any; on<K extends keyof Events>(event: K, cb: any): () => void; emit<K extends keyof Events>(event: K, ...args: any[]): void; }\nexport function createNanoEvents(): Emitter;\n',
        'test/index.test.ts': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createNanoEvents } from '../index.js';\ntest('baseline', () => { const ee = createNanoEvents(); let x = 0; ee.on('a', (n) => { x += n; }); ee.emit('a', 3); assert.equal(x, 3); });\n",
      },
      'baseline nanoevents',
    ],
  };

  return Object.fromEntries(
    Object.entries(pkgFiles).map(([taskId, [slug, files, msg]]) => [taskId, makeMirror(slug, files, msg)]),
  );
}

function applyGoldFix(taskId, ws) {
  if (taskId === 'oss-nanoid-batch-cli-01') {
    const batchFn = [
      '',
      'export function nanoidBatch(count, size = 21) {',
      '  if (!Number.isInteger(count) || count < 0 || count > 10000) throw new RangeError("count out of range");',
      '  if (!Number.isInteger(size) || size < 0) throw new RangeError("size out of range");',
      '  const list = [];',
      '  for (let i = 0; i < count; i++) list.push(nanoid(size));',
      '  return list;',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(ws, 'index.js'), readFileSync(join(ws, 'index.js'), 'utf8') + batchFn, 'utf8');
    writeFileSync(join(ws, 'index.browser.js'), readFileSync(join(ws, 'index.browser.js'), 'utf8') + batchFn, 'utf8');
    writeFileSync(
      join(ws, 'bin/nanoid.js'),
      [
        '#!/usr/bin/env node',
        "import { nanoidBatch, urlAlphabet } from '../index.js';",
        'const args = process.argv.slice(2);',
        'if (args.includes("--help") || args.includes("-h")) { process.stdout.write("Usage\\n  $ nanoid [options]\\n  -c, --count <n>\\n"); process.exit(0); }',
        'if (args.includes("--version") || args.includes("-v")) { process.stdout.write("5.1.6\\n"); process.exit(0); }',
        'let count = 1, size = 21, alphabet = urlAlphabet;',
        'const readVal = (flag, next) => {',
        '  if (next === undefined || next === "") { process.stderr.write("Missing value for " + flag + "\\n"); process.exit(1); }',
        '  return next;',
        '};',
        'for (let i = 0; i < args.length; i++) {',
        '  const a = args[i];',
        '  if (a === "-c" || a === "--count") count = readVal(a, args[++i]);',
        '  else if (a.startsWith("--count=")) count = readVal("--count", a.slice(8));',
        '  else if (a === "-s" || a === "--size") size = readVal(a, args[++i]);',
        '  else if (a.startsWith("--size=")) size = readVal("--size", a.slice(7));',
        '  else if (a === "-a" || a === "--alphabet") alphabet = readVal(a, args[++i]);',
        '  else if (a.startsWith("--alphabet=")) alphabet = readVal("--alphabet", a.slice(11));',
        '}',
        'const c = Number(count), s = Number(size);',
        'if (!Number.isInteger(c) || c < 1 || c > 10000 || !Number.isInteger(s) || s < 0 || !alphabet) { process.stderr.write("Invalid options\\n"); process.exit(1); }',
        'if (alphabet === urlAlphabet) { for (const id of nanoidBatch(c, s)) process.stdout.write(id + "\\n"); }',
        'else { for (let k = 0; k < c; k++) { let id = ""; for (let j = 0; j < s; j++) id += alphabet[(k + j) % alphabet.length]; process.stdout.write(id + "\\n"); } }',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(ws, 'test/batch.test.js'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { nanoidBatch } from '../index.js';\ntest('batch', () => assert.equal(nanoidBatch(2, 5).length, 2));\n",
      'utf8',
    );
    return;
  }

  if (taskId === 'oss-trough-pipeline-01') {
    writeFileSync(
      join(ws, 'lib/index.js'),
      [
        'export function wrap(fn, callback) {',
        '  let called = false;',
        '  return function wrapped(...args) {',
        '    const done = (err, ...out) => { if (!called) { called = true; callback(err, ...out); } };',
        '    const maybeAsync = fn.length > args.length;',
        '    try {',
        '      const res = maybeAsync ? fn(...args, done) : fn(...args);',
        '      if (res && typeof res.then === "function") res.then((v) => done(null, v), (e) => done(e));',
        '      else if (res instanceof Error) done(res);',
        '      else if (!maybeAsync) done(null, res);',
        '    } catch (e) { done(e); }',
        '  };',
        '}',
        'function buildPipeline(initial) {',
        '  const fns = [...initial];',
        '  const pipeline = {',
        '    use(fn) { if (typeof fn !== "function") throw new TypeError("Expected function"); fns.push(fn); return pipeline; },',
        '    prepend(fn) { if (typeof fn !== "function") throw new TypeError("Expected function"); fns.unshift(fn); return pipeline; },',
        '    clone() { return buildPipeline(fns); },',
        '    run(...values) {',
        '      const cb = values.pop();',
        '      let idx = -1;',
        '      function next(err, ...out) {',
        '        const args = out.length ? out : values;',
        '        if (err) return cb(err);',
        '        const fn = fns[++idx];',
        '        if (!fn) return cb(null, ...args);',
        '        wrap(fn, (e, ...nextOut) => { if (e) return cb(e); const merged = args.map((v, i) => (i < nextOut.length && nextOut[i] != null) ? nextOut[i] : v); for (let j = args.length; j < nextOut.length; j++) merged.push(nextOut[j]); next(null, ...merged); })(...args);',
        '      }',
        '      next(null, ...values);',
        '    },',
        '    runAsync(...values) {',
        '      return new Promise((resolve, reject) => {',
        '        pipeline.run(...values, (err, ...out) => { if (err) reject(err); else resolve(values.length <= 1 ? out[0] : out); });',
        '      });',
        '    }',
        '  };',
        '  return pipeline;',
        '}',
        'export function trough() { return buildPipeline([]); }',
      ].join('\n'),
      'utf8',
    );
    mkdirSync(join(ws, 'test'), { recursive: true });
    writeFileSync(
      join(ws, 'test/extensions.test.js'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { trough } from '../index.js';\ntest('trough ext', async () => assert.equal(await trough().use((n) => n + 1).runAsync(2), 3));\n",
      'utf8',
    );
    return;
  }

  if (taskId === 'oss-content-type-format-01') {
    const base = readFileSync(join(ws, 'index.js'), 'utf8');
    const impl = [
      '',
      "const TOKEN_RE = /^[!#$%&'*+-.^_`|~0-9A-Za-z]+$/;",
      'const TYPE_RE = /^[!#$%&\'*+-.^_`|~0-9A-Za-z]+\\/[!#$%&\'*+-.^_`|~0-9A-Za-z]+$/;',
      'function format(ct) {',
      '  if (!ct || typeof ct !== "object" || Array.isArray(ct) || typeof ct.type !== "string" || !TYPE_RE.test(ct.type)) throw new TypeError("Invalid Content-Type");',
      '  const out = [ct.type.toLowerCase()];',
      '  if (ct.parameters !== undefined) {',
      '    if (!ct.parameters || typeof ct.parameters !== "object" || Array.isArray(ct.parameters)) throw new TypeError("Invalid parameters");',
      '    const seen = new Set();',
      '    for (const k of Object.keys(ct.parameters)) {',
      '      const lower = k.toLowerCase();',
      '      if (!TOKEN_RE.test(lower)) throw new TypeError("Invalid parameter name");',
      '      if (seen.has(lower)) continue;',
      '      seen.add(lower);',
      '      const raw = ct.parameters[k];',
      '      if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") throw new TypeError("Invalid parameter value");',
      '      const s = String(raw);',
      '      for (let i = 0; i < s.length; i++) {',
      '        const code = s.charCodeAt(i);',
      '        if (code === 10 || code === 13 || code === 127 || code > 255 || (code < 32 && code !== 9)) throw new TypeError("Invalid character");',
      '      }',
      '      out.push(TOKEN_RE.test(s) ? `${lower}=${s}` : `${lower}="${s.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, "\\\\\\"")}"`);',
      '    }',
      '  }',
      '  return out.join("; ");',
      '}',
      'module.exports.format = format;',
      'module.exports.default.format = format;',
    ].join('\n');
    writeFileSync(join(ws, 'index.js'), base + impl, 'utf8');
    writeFileSync(
      join(ws, 'test/format.test.js'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createRequire } from 'node:module';\nconst { format } = createRequire(import.meta.url)('../index.js');\ntest('format', () => assert.equal(format({ type: 'text/plain' }), 'text/plain'));\n",
      'utf8',
    );
    return;
  }

  if (taskId === 'oss-nanoevents-hardening-01') {
    writeFileSync(
      join(ws, 'index.js'),
      [
        'const hasOwn = Object.hasOwn;',
        'export const createNanoEvents = () => ({',
        '  events: {},',
        '  emit(event, ...args) {',
        '    if (!hasOwn(this.events, event)) return;',
        '    const list = [...this.events[event]];',
        '    for (let i = 0; i < list.length; i++) list[i](...args);',
        '  },',
        '  on(event, cb) {',
        '    if (typeof cb !== "function") throw new TypeError("Expected listener function");',
        '    if (!hasOwn(this.events, event)) Object.defineProperty(this.events, event, { value: [], writable: true, enumerable: true, configurable: true });',
        '    this.events[event].push(cb);',
        '    return () => { if (hasOwn(this.events, event)) this.events[event] = this.events[event].filter((fn) => fn !== cb); };',
        '  },',
        '  once(event, cb) {',
        '    if (typeof cb !== "function") throw new TypeError("Expected listener function");',
        '    let done = false;',
        '    const off = this.on(event, (...args) => { if (done) return; done = true; off(); cb(...args); });',
        '    return () => { done = true; off(); };',
        '  },',
        '  clear(event) {',
        '    if (arguments.length === 0) { this.events = {}; return; }',
        '    if (hasOwn(this.events, event)) delete this.events[event];',
        '  }',
        '});',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(ws, 'index.d.ts'),
      'export interface Emitter<Events = Record<string, any>> { events: any; on<K extends keyof Events>(event: K, cb: any): () => void; once<K extends keyof Events>(event: K, cb: any): () => void; emit<K extends keyof Events>(event: K, ...args: any[]): void; clear(event?: keyof Events): void; }\nexport function createNanoEvents(): Emitter;\n',
      'utf8',
    );
    writeFileSync(
      join(ws, 'test/hardening.test.ts'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createNanoEvents } from '../index.js';\ntest('hardening', () => { const ee = createNanoEvents(); let n = 0; ee.once('x', () => n++); ee.emit('x'); ee.emit('x'); assert.equal(n, 1); });\n",
      'utf8',
    );
  }
}

describe('Real Docker Strong OS-Level Benchmark Isolation & Hidden Acceptance Suite', () => {
  let root;

  before(() => {
    const dockerProbe = new DockerBenchmarkSandbox().probe();
    assert.equal(
      dockerProbe.available,
      true,
      `Real Docker sandbox is required for docker-sandbox-acceptance.test.js: ${JSON.stringify(dockerProbe)}`,
    );
    root = mkdtempSync(join(tmpdir(), 'agent-us-dkr-acc-'));
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    assert.deepEqual(listBenchContainers(), [], 'no leftover benchmark containers may remain after tests');
  });

  const makeCase = (name) => {
    const dir = join(root, name);
    const ws = join(dir, 'ws');
    const outside = join(dir, 'outside');
    mkdirSync(ws, { recursive: true });
    mkdirSync(outside, { recursive: true });
    return { dir, ws, outside };
  };

  test('Fail-closed tier enforcement: STRONG/DOCKER/AUTO require Docker and never silently downgrade to node-permission', () => {
    const { ws } = makeCase('fail-closed-tiers');

    const defaultSbx = new BenchmarkSandbox({ workspaceRoot: ws });
    const resolved = defaultSbx.resolveBackend();
    assert.equal(resolved.mode, SANDBOX_MODES.DOCKER);
    assert.equal(resolved.isolationTier, SANDBOX_TIERS.STRONG_OS_ISOLATION);
    assert.equal(resolved.strongOsIsolation, true);
    assert.equal(defaultSbx.capabilities().strongOsIsolation, true);
    assert.equal(defaultSbx.capabilities().ipcNone, true);

    for (const strongMode of [SANDBOX_MODES.STRONG, SANDBOX_MODES.DOCKER, SANDBOX_MODES.AUTO]) {
      const noDocker = new BenchmarkSandbox({
        mode: strongMode,
        workspaceRoot: ws,
        probes: { docker: { available: false, reason: 'sim_missing' }, nodePermission: true },
      });
      assert.throws(
        () => noDocker.resolveBackend(),
        (err) => err instanceof SandboxUnavailableError && err.code === 'E_SANDBOX_UNAVAILABLE',
        `${strongMode} must fail closed when Docker is unavailable`,
      );
    }

    const optOutNode = new BenchmarkSandbox({
      mode: SANDBOX_MODES.NODE_PERMISSION,
      workspaceRoot: ws,
      allowProcessHardeningOnly: false,
      probes: { nodePermission: true },
    });
    assert.throws(
      () => optOutNode.resolveBackend(),
      (err) => err instanceof SandboxUnavailableError && err.code === 'E_SANDBOX_UNAVAILABLE',
    );

    const optInNode = new BenchmarkSandbox({
      mode: SANDBOX_MODES.NODE_PERMISSION,
      workspaceRoot: ws,
      allowProcessHardeningOnly: true,
    });
    const nodeResolved = optInNode.resolveBackend();
    assert.equal(nodeResolved.mode, SANDBOX_MODES.NODE_PERMISSION);
    assert.equal(nodeResolved.isolationTier, SANDBOX_TIERS.PROCESS_HARDENING_ONLY);
    assert.equal(nodeResolved.strongOsIsolation, false);
  });

  test('Hidden acceptance 7 bypass vectors in real Docker: exit(0), SIGTERM, skip/0-assertions, RO tamper, manifest tamper, forged stdout, fake marker', async () => {
    const { ws } = makeCase('hidden-bypass-7');
    const baseSuite = [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { join } from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "const ws = process.env.WORKSPACE_ROOT;",
      "test('case 1', async () => {",
      "  const mod = await import(pathToFileURL(join(ws, 'index.js')).href);",
      "  assert.equal(mod.compute(2, 3), 5);",
      "});",
      "test('case 2', async () => {",
      "  const mod = await import(pathToFileURL(join(ws, 'index.js')).href);",
      "  assert.equal(mod.compute(10, 20), 30);",
      "});",
    ].join('\n');

    const sandbox = new BenchmarkSandbox({ workspaceRoot: ws });

    // Baseline pass in real Docker: multi-test sequential isolated workers
    writeFileSync(join(ws, 'index.js'), 'export const compute = (a, b) => a + b;\n', 'utf8');
    const artifactDigest = computeWorkspaceArtifactDigest(ws);
    const passRes = await sandbox.runHiddenAcceptance({
      workspaceRoot: ws,
      scriptSource: baseSuite,
      taskId: 'sec-bypass-task',
      attemptId: 'att-good',
      artifactDigest,
    });
    assert.equal(passRes.passed, true, `expected pass: ${JSON.stringify(passRes)}`);
    assert.equal(passRes.verified, true);
    assert.equal(passRes.tamperingDetected, false);
    assert.equal(passRes.strongOsIsolation, true);
    assert.equal(passRes.isolationTier, SANDBOX_TIERS.STRONG_OS_ISOLATION);
    assert.equal(passRes.expectedCount, 2);
    assert.equal(passRes.executedCount, 2);
    assert.equal(passRes.passedCount, 2);
    assert.equal(passRes.artifactDigest, artifactDigest);
    assert.match(String(passRes.envelopeDigest), /^[0-9a-f]{64}$/);
    assert.equal(passRes.tests[0].assertionCount, 1);
    assert.equal(passRes.tests[1].assertionCount, 1);

    // Vector 1: process.exit(0) at module import
    writeFileSync(join(ws, 'index.js'), 'process.exit(0); export const compute = () => 5;\n', 'utf8');
    const v1 = await sandbox.runHiddenAcceptance({ workspaceRoot: ws, scriptSource: baseSuite, taskId: 'v1' });
    assert.equal(v1.passed, false);
    assert.equal(v1.verified, false);
    assert.equal(v1.reason, 'premature_exit');
    assert.equal(v1.tests[0].prematureExit, true);

    // Vector 2: Premature worker termination via SIGTERM
    writeFileSync(join(ws, 'index.js'), 'export function compute() { process.kill(process.pid, "SIGTERM"); return 5; }\n', 'utf8');
    const v2 = await sandbox.runHiddenAcceptance({ workspaceRoot: ws, scriptSource: baseSuite, taskId: 'v2' });
    assert.equal(v2.passed, false);
    assert.equal(v2.verified, false);
    assert.equal(v2.tests[0].workerSignal, 'SIGTERM');

    // Vector 3a: Static test.skip / { skip: true } / runtime t.skip()
    await assert.rejects(
      () => sandbox.runHiddenAcceptance({
        workspaceRoot: ws,
        scriptSource: "import test from 'node:test'; import assert from 'node:assert/strict'; test.skip('s', () => assert.ok(true));",
      }),
      (err) => err instanceof SandboxPolicyError && err.code === 'E_SANDBOX_POLICY_VIOLATION',
    );
    const v3SkipRuntime = await sandbox.runHiddenAcceptance({
      workspaceRoot: ws,
      scriptSource: "import test from 'node:test'; import assert from 'node:assert/strict'; test('runtime-skip', (t) => { t.skip('no'); assert.ok(true); });",
    });
    assert.equal(v3SkipRuntime.passed, false);
    assert.equal(v3SkipRuntime.verified, false);

    // Vector 3b: Zero assertions in test body (early return without assert)
    const v3EmptyAssert = await sandbox.runHiddenAcceptance({
      workspaceRoot: ws,
      scriptSource: "import test from 'node:test'; test('empty-assertions', () => { return; });",
    });
    assert.equal(v3EmptyAssert.passed, false);
    assert.equal(v3EmptyAssert.verified, false);
    assert.equal(v3EmptyAssert.reason, 'insufficient_assertions');

    // Vector 4 & 5: Attempt to overwrite read-only hidden test file & manifest.json inside container
    const tamperScript = [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import fs from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "test('ro tamper check', () => {",
      "  const self = fileURLToPath(import.meta.url);",
      "  const dir = dirname(self);",
      "  assert.throws(() => fs.writeFileSync(self, '// pwned'), (e) => e.code === 'EROFS' || e.code === 'EACCES');",
      "  assert.throws(() => fs.writeFileSync(join(dir, 'manifest.json'), '{}'), (e) => e.code === 'EROFS' || e.code === 'EACCES');",
      "  assert.throws(() => fs.writeFileSync(join(process.env.WORKSPACE_ROOT, 'drop.txt'), 'no'), (e) => e.code === 'EROFS' || e.code === 'EACCES');",
      "});",
    ].join('\n');
    const v45 = await sandbox.runHiddenAcceptance({ workspaceRoot: ws, scriptSource: tamperScript, taskId: 'v45' });
    assert.equal(v45.passed, true, `RO tamper check failed: ${JSON.stringify(v45)}`);

    // Vector 6: Forged stdout envelope printed by workspace code
    writeFileSync(
      join(ws, 'index.js'),
      `export const compute = (a, b) => { console.log(${JSON.stringify(HIDDEN_ENVELOPE_BEGIN + '{"payload":{"passed":true},"algorithm":"hmac-sha256","signature":"' + '0'.repeat(64) + '"}' + HIDDEN_ENVELOPE_END)}); return a + b; };\n`,
      'utf8',
    );
    const v6 = await sandbox.runHiddenAcceptance({ workspaceRoot: ws, scriptSource: baseSuite, taskId: 'v6' });
    assert.equal(v6.passed, false);
    assert.equal(v6.verified, false);
    assert.equal(v6.tamperingDetected, true);

    // Vector 7: Fake success markers & TAP output without executing assertions
    writeFileSync(
      join(ws, 'index.js'),
      `import { writeFileSync } from 'node:fs'; writeFileSync('/tmp/.hidden-pass', 'ok'); console.log('TAP version 13\\nok 1 - pass\\n# pass 2'); process.exit(0); export const compute = () => 0;\n`,
      'utf8',
    );
    const v7 = await sandbox.runHiddenAcceptance({ workspaceRoot: ws, scriptSource: baseSuite, taskId: 'v7' });
    assert.equal(v7.passed, false);
    assert.equal(v7.verified, false);
  });

  test('Deterministic hard veto prevents advisory/LLM fallback from overriding failed hidden acceptance', async () => {
    const judge = createDeterministicJudge({
      fallback: async () => ({ passed: true, score: 1, reason: 'llm_says_ship_it' }),
    });
    const fakeTask = {
      id: 'veto-task',
      judge: async () => ({
        passed: false,
        score: 0,
        reason: 'hidden_acceptance_failed',
        evidence: {
          hiddenAcceptancePassed: false,
          hiddenAcceptanceVerified: false,
          hiddenAcceptanceTamperingDetected: true,
          historyUntouched: true,
          baselineTestsUntampered: true,
          sandboxIsolated: true,
          checks: {
            hiddenAcceptancePassed: false,
            hiddenAcceptanceVerified: false,
            hiddenAcceptanceTamperingDetected: true,
          },
        },
      }),
    };
    const verdict = await judge({ task: fakeTask, output: {}, context: {} });
    assert.equal(verdict.passed, false);
    assert.equal(verdict.score, 0);
    assert.equal(verdict.hardVetoed, true);
    assert.ok(verdict.vetoReasons.includes('hidden_acceptance_tampered'));
    assert.ok(verdict.vetoReasons.includes('hidden_acceptance_failed'));
    assert.equal(verdict.advisory.passed, true);

    const directVeto = enforceDeterministicHardVeto({ passed: true, score: 1, evidence: { hiddenAcceptancePassed: false } });
    assert.equal(directVeto.passed, false);
    assert.equal(directVeto.score, 0);
    assert.equal(directVeto.hardVetoed, true);
  });

  test('Real Docker OS isolation: zero host env secrets, outside FS/DB blocked, network=none (IPv4/IPv6/DNS), non-root 65534, Python3, Windows NTFS perms & cleanup', async () => {
    const { dir, ws, outside } = makeCase('os-isolation');
    const outsideDb = join(outside, 'synthetic.sqlite');
    const outsideKey = join(outside, '.pool-key');
    writeFileSync(outsideDb, 'SYNTHETIC_DB_BYTES', 'utf8');
    writeFileSync(outsideKey, 'synthetic-pool-key-material', 'utf8');

    const canaryV4 = await startCanaryServer('127.0.0.1');
    let canaryV6 = null;
    try {
      canaryV6 = await startCanaryServer('::1');
    } catch {
      canaryV6 = null;
    }

    try {
      await withSyntheticHostEnv(async () => {
        writeFileSync(
          join(ws, 'probe.mjs'),
          [
            'import fs from "node:fs";',
            'import net from "node:net";',
            'import dns from "node:dns/promises";',
            'const results = {',
            '  uid: process.getuid ? process.getuid() : null,',
            '  gid: process.getgid ? process.getgid() : null,',
            '  leakedSecrets: [],',
            '  hostDbBlocked: false,',
            '  rootWriteBlocked: false,',
            '  ipv4Blocked: false,',
            '  ipv6Blocked: false,',
            '  gatewayBlocked: false,',
            '  dnsBlocked: false,',
            '};',
            'for (const k of ["OPENAI_API_KEY","ANTHROPIC_API_KEY","GITHUB_TOKEN","NPM_TOKEN","DATABASE_URL","AGENT_US_SYNTHETIC_SECRET"]) {',
            '  if (process.env[k] !== undefined) results.leakedSecrets.push(k);',
            '}',
            'try { fs.readFileSync(process.env.OUTSIDE_DB_PATH); } catch { results.hostDbBlocked = true; }',
            'try { fs.writeFileSync("/root-pwn.txt", "no"); } catch (e) { results.rootWriteBlocked = (e.code === "EROFS" || e.code === "EACCES"); }',
            'try { fs.mkdirSync("subDir"); fs.writeFileSync("subDir/CaseFile.txt", "hello"); fs.unlinkSync("subDir/CaseFile.txt"); fs.rmdirSync("subDir"); results.rwWorkOps = true; } catch { results.rwWorkOps = false; }',
            'try { await fetch(process.env.CANARY_V4, { signal: AbortSignal.timeout(1200) }); } catch { results.ipv4Blocked = true; }',
            'if (process.env.CANARY_V6) { try { await fetch(process.env.CANARY_V6, { signal: AbortSignal.timeout(1200) }); } catch { results.ipv6Blocked = true; } } else { results.ipv6Blocked = true; }',
            'try { await new Promise((res, rej) => { const s = net.connect(Number(process.env.CANARY_PORT), "host.docker.internal", () => { s.destroy(); res(); }); s.setTimeout(1000, () => { s.destroy(); rej(new Error("timeout")); }); s.on("error", rej); }); } catch { results.gatewayBlocked = true; }',
            'try { await dns.lookup("registry.npmjs.org"); } catch { results.dnsBlocked = true; }',
            'process.stdout.write(JSON.stringify(results));',
          ].join('\n'),
          'utf8',
        );

        writeFileSync(
          join(ws, 'test_py.py'),
          [
            'import os, urllib.request, unittest',
            'class PyIsoTest(unittest.TestCase):',
            '    def test_uid_and_offline(self):',
            '        self.assertEqual(os.getuid(), 65534)',
            '        self.assertEqual(os.environ.get("PYTHONDONTWRITEBYTECODE"), "1")',
            '        self.assertEqual(os.environ.get("PIP_NO_INDEX"), "1")',
            '        with self.assertRaises(Exception):',
            '            urllib.request.urlopen(os.environ["CANARY_V4"], timeout=1)',
            'if __name__ == "__main__":',
            '    unittest.main()',
          ].join('\n'),
          'utf8',
        );

        const sandbox = new BenchmarkSandbox({ workspaceRoot: ws });
        const nodeRes = await sandbox.execArgv(['node', 'probe.mjs'], {
          extraEnv: {
            OUTSIDE_DB_PATH: outsideDb,
            CANARY_V4: canaryV4.url,
            CANARY_PORT: String(canaryV4.port),
            ...(canaryV6 ? { CANARY_V6: canaryV6.url } : {}),
          },
        });
        assert.equal(nodeRes.exitCode, 0, `stderr:\n${nodeRes.stderr}`);
        const probe = JSON.parse(nodeRes.stdout);
        assert.equal(probe.uid, 65534);
        assert.equal(probe.gid, 65534);
        assert.deepEqual(probe.leakedSecrets, []);
        assert.equal(probe.hostDbBlocked, true);
        assert.equal(probe.rootWriteBlocked, true);
        assert.equal(probe.rwWorkOps, true);
        assert.equal(probe.ipv4Blocked, true);
        assert.equal(probe.ipv6Blocked, true);
        assert.equal(probe.gatewayBlocked, true);
        assert.equal(probe.dnsBlocked, true);
        assert.equal(canaryV4.getHits(), 0);
        if (canaryV6) assert.equal(canaryV6.getHits(), 0);

        const pyRes = await sandbox.execArgv(['python3', 'test_py.py'], {
          extraEnv: { CANARY_V4: canaryV4.url },
        });
        assert.equal(pyRes.exitCode, 0, `python stderr:\n${pyRes.stderr}`);
        assert.equal(canaryV4.getHits(), 0);

        // Forbidden mount paths rejected before docker invocation
        const dkr = new DockerBenchmarkSandbox();
        const forbiddenRoot = process.platform === 'win32' ? 'C:\\' : '/';
        assert.throws(
          () => dkr.buildDockerRunArgs(['node', '-v'], { workspaceRoot: forbiddenRoot }),
          (err) => err instanceof SandboxPolicyError && err.code === 'E_SANDBOX_PATH_ESCAPE',
        );
        const varPath = join(dir, 'backend', 'var');
        mkdirSync(varPath, { recursive: true });
        assert.throws(
          () => dkr.buildDockerRunArgs(['node', '-v'], { workspaceRoot: varPath }),
          (err) => err instanceof SandboxPolicyError && err.code === 'E_SANDBOX_PATH_ESCAPE',
        );

        // Symlink / NTFS junction escape blocked before container creation
        const escapeLink = join(ws, 'escape-out');
        symlinkSync(outside, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(
          () => sandbox.execArgv(['node', 'probe.mjs']),
          (err) => err instanceof SandboxPolicyError && err.code === 'E_SANDBOX_SYMLINK_ESCAPE',
        );
        rmSync(escapeLink, { recursive: true, force: true });
      });
    } finally {
      await canaryV4.close();
      if (canaryV6) await canaryV6.close();
    }
  });

  test('Real Docker resource limits (pids-limit, memory OOM, cpu/timeout, output cap) and abort container cleanup', async () => {
    const { ws } = makeCase('limits');
    const sandbox = new BenchmarkSandbox({ workspaceRoot: ws, pidsLimit: 16 });

    // 1. pids-limit enforcement
    writeFileSync(
      join(ws, 'pids.mjs'),
      [
        'import { spawn } from "node:child_process";',
        'const children = [];',
        'let sawSpawnFailure = false;',
        'for (let i = 0; i < 32; i++) {',
        '  try {',
        '    const c = spawn("sleep", ["5"], { stdio: "ignore" });',
        '    c.on("error", () => { sawSpawnFailure = true; });',
        '    children.push(c);',
        '  } catch {',
        '    sawSpawnFailure = true;',
        '    break;',
        '  }',
        '}',
        'await new Promise((r) => setTimeout(r, 400));',
        'for (const c of children) { try { c.kill("SIGKILL"); } catch {} }',
        'process.stdout.write(JSON.stringify({ attempted: 32, spawnedCount: children.length, sawSpawnFailure }));',
      ].join('\n'),
      'utf8',
    );
    const pidsRes = await sandbox.execArgv(['node', 'pids.mjs'], { timeoutMs: 10_000 });
    const pidsPayload = pidsRes.stdout ? JSON.parse(pidsRes.stdout) : null;
    assert.ok(
      pidsRes.exitCode !== 0 || (pidsPayload && (pidsPayload.sawSpawnFailure || pidsPayload.spawnedCount < 32)),
      `pids-limit=16 did not bound 32 spawns: exit=${pidsRes.exitCode}, out=${pidsRes.stdout}, err=${pidsRes.stderr}`,
    );
    assert.deepEqual(listBenchContainers(), []);

    // 2. memory=64m / memory-swap=64m OOM enforcement
    const lowMemSandbox = new BenchmarkSandbox({ workspaceRoot: ws, memoryLimitMb: 64 });
    writeFileSync(
      join(ws, 'oom.mjs'),
      [
        'const chunks = [];',
        'for (let i = 0; i < 40; i++) {',
        '  const buf = Buffer.alloc(8 * 1024 * 1024, 1);',
        '  chunks.push(buf);',
        '}',
        'process.stdout.write("SHOULD_NOT_FIT:" + chunks.length);',
      ].join('\n'),
      'utf8',
    );
    const oomRes = await lowMemSandbox.execArgv(['node', 'oom.mjs'], { timeoutMs: 15_000 });
    assert.notEqual(oomRes.exitCode, 0, `expected memory OOM non-zero exit: out=${oomRes.stdout}`);
    assert.deepEqual(listBenchContainers(), []);

    // 3. Timeout cleanup
    writeFileSync(join(ws, 'spin.mjs'), 'while (true) {}', 'utf8');
    const timeoutRes = await sandbox.execArgv(['node', 'spin.mjs'], { timeoutMs: 800, cpuLimitSec: 2 });
    assert.equal(timeoutRes.timedOut || timeoutRes.cpuLimitExceeded || timeoutRes.exitCode !== 0, true);
    assert.deepEqual(listBenchContainers(), []);

    // 4. Output flood cap
    writeFileSync(join(ws, 'flood.mjs'), 'for (let i = 0; i < 4000; i++) process.stdout.write("A".repeat(256));', 'utf8');
    const floodRes = await sandbox.execArgv(['node', 'flood.mjs'], { maxOutputBytes: 4096 });
    assert.equal(floodRes.exitCode, 0);
    assert.equal(floodRes.truncated, true);
    assert.ok(Buffer.byteLength(floodRes.stdout, 'utf8') + Buffer.byteLength(floodRes.stderr, 'utf8') <= 4096);

    // 5. AbortSignal removes container cleanly
    const ac = new AbortController();
    setTimeout(() => ac.abort('test abort'), 400);
    await assert.rejects(
      () => sandbox.execArgv(['node', 'spin.mjs'], { timeoutMs: 15_000, signal: ac.signal }),
      (err) => err instanceof SandboxPolicyError && err.code === 'E_SANDBOX_ABORTED',
    );
    assert.deepEqual(listBenchContainers(), []);
  });

  test('Dependency preparation policy + All 4 pinned OSS benchmarks & DirectAgentRuntime E2E inside real Docker', async () => {
    // 1. Dependency policy unit gate
    assert.throws(
      () =>
        prepareDependencies({
          packageJson: { name: 'bad', dependencies: { foo: '^1.0.0' }, scripts: { postinstall: 'curl evil' } },
          policy: DEFAULT_DEPENDENCY_POLICY,
        }),
      (err) => err instanceof DependencyPolicyError,
    );
    const prepOk = prepareDependencies({
      packageJson: { name: 'ok', dependencies: { nanoid: '5.1.6' } },
      lockfilePresent: true,
      policy: validateDependencyPolicy({ mode: DEPENDENCY_POLICY_MODES.STAGED_PINNED, allowNetworkInstall: true, requireLockfileIntegrity: true }),
    });
    assert.equal(prepOk.ok, true);
    assert.equal(prepOk.postInstallNetworkEnabled, false);
    assert.ok(prepOk.installArgs.includes('--ignore-scripts'));

    // 2. All 4 OSS Benchmarks in REAL Docker
    const { dir } = makeCase('oss-real-docker');
    const mirrorRoot = join(dir, 'mirrors');
    const cacheDir = join(dir, 'cache');
    mkdirSync(mirrorRoot, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    const overrides = buildHermeticOssMirrors(mirrorRoot);
    const cachedOverrides = Object.fromEntries(
      Object.entries(overrides).map(([id, cfg]) => [id, { ...cfg, cacheDir }]),
    );
    const sandbox = new BenchmarkSandbox({ mode: SANDBOX_MODES.STRONG });
    const tasks = createOssBenchmarkDataset({ repoOverrides: cachedOverrides, sandbox });

    for (const task of tasks) {
      const ws = await createFixtureWorkspace(task, { cacheDir, sandbox });
      try {
        applyGoldFix(task.id, ws);
        const testCmdStr = task.metadata.acceptanceCriteria.testCommand.join(' ');
        const output = {
          output: {
            schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
            taskId: task.id,
            attemptId: 'attempt-docker-1',
            planVersion: 1,
            summary: `Docker verified ${task.id}`,
            changedFiles: task.metadata.acceptanceCriteria.requiredChangedFiles,
            testCommand: testCmdStr,
            testExitCode: 0,
            testEvidence: [{ command: testCmdStr, exitCode: 0 }],
            artifactRefs: [],
          },
        };
        const context = {
          workspaceRoot: ws,
          attemptId: 'attempt-docker-1',
          planVersion: 1,
          toolReceipts: [{ id: `rec-${task.id}`, toolName: 'bash', status: 'finished', exitCode: 0, command: testCmdStr }],
          trustedVerdict: { status: 'pass', source: 'trusted_server_verifier', evidenceRefs: [`rec-${task.id}`] },
        };
        const verdict = await task.judge({ task, output, context });
        assert.equal(verdict.passed, true, `${task.id} failed in real Docker: ${JSON.stringify(verdict.evidence)}`);
        assert.equal(verdict.evidence.sandboxBackend, SANDBOX_MODES.DOCKER);
        assert.equal(verdict.evidence.strongOsIsolation, true);
        assert.equal(verdict.evidence.isolationTier, SANDBOX_TIERS.STRONG_OS_ISOLATION);
        assert.equal(verdict.evidence.hiddenAcceptancePassed, true);
        assert.equal(verdict.evidence.hiddenAcceptanceVerified, true);
        assert.equal(verdict.evidence.hiddenAcceptanceTamperingDetected, false);
        assert.match(String(verdict.evidence.hiddenAcceptanceEnvelopeDigest), /^[0-9a-f]{64}$/);
        assert.match(String(verdict.evidence.artifactDigest), /^[0-9a-f]{64}$/);

        // Negative verification in real Docker: injecting process.exit(0) in nanoid must fail hidden acceptance
        if (task.id === 'oss-nanoid-batch-cli-01') {
          writeFileSync(
            join(ws, 'index.js'),
            'process.exit(0);\n' + readFileSync(join(ws, 'index.js'), 'utf8'),
            'utf8',
          );
          const bypassVerdict = await task.judge({ task, output, context });
          assert.equal(bypassVerdict.passed, false);
          assert.equal(bypassVerdict.evidence.hiddenAcceptancePassed, false);
          assert.equal(bypassVerdict.evidence.hiddenAcceptanceVerified, false);
        }
      } finally {
        await removeFixtureWorkspace(ws).catch(() => {});
      }
    }

    // 3. E2E EvaluationService + DirectAgentRuntime on oss-trough-pipeline-01 inside real Docker
    const dataDir = join(dir, 'e2e-data');
    mkdirSync(dataDir, { recursive: true });
    const store = new Store(join(dataDir, 'engine.sqlite'));
    const pool = new AccountPool(store, { root: dataDir });
    pool.setDefaultModel('mock-docker-oss');

    const troughTask = tasks.find((x) => x.id === 'oss-trough-pipeline-01');
    const goldLibContent = [
      'export function wrap(fn, callback) {',
      '  let called = false;',
      '  return function wrapped(...args) {',
      '    const done = (err, ...out) => { if (!called) { called = true; callback(err, ...out); } };',
      '    const maybeAsync = fn.length > args.length;',
      '    try {',
      '      const res = maybeAsync ? fn(...args, done) : fn(...args);',
      '      if (res && typeof res.then === "function") res.then((v) => done(null, v), (e) => done(e));',
      '      else if (res instanceof Error) done(res);',
      '      else if (!maybeAsync) done(null, res);',
      '    } catch (e) { done(e); }',
      '  };',
      '}',
      'function buildPipeline(initial) {',
      '  const fns = [...initial];',
      '  const pipeline = {',
      '    use(fn) { if (typeof fn !== "function") throw new TypeError("Expected function"); fns.push(fn); return pipeline; },',
      '    prepend(fn) { if (typeof fn !== "function") throw new TypeError("Expected function"); fns.unshift(fn); return pipeline; },',
      '    clone() { return buildPipeline(fns); },',
      '    run(...values) {',
      '      const cb = values.pop();',
      '      let idx = -1;',
      '      function next(err, ...out) {',
      '        const args = out.length ? out : values;',
      '        if (err) return cb(err);',
      '        const fn = fns[++idx];',
      '        if (!fn) return cb(null, ...args);',
      '        wrap(fn, (e, ...nextOut) => { if (e) return cb(e); const merged = args.map((v, i) => (i < nextOut.length && nextOut[i] != null) ? nextOut[i] : v); for (let j = args.length; j < nextOut.length; j++) merged.push(nextOut[j]); next(null, ...merged); })(...args);',
      '      }',
      '      next(null, ...values);',
      '    },',
      '    runAsync(...values) {',
      '      return new Promise((resolve, reject) => {',
      '        pipeline.run(...values, (err, ...out) => { if (err) reject(err); else resolve(values.length <= 1 ? out[0] : out); });',
      '      });',
      '    }',
      '  };',
      '  return pipeline;',
      '}',
      'export function trough() { return buildPipeline([]); }',
    ].join('\n');
    const goldTestContent =
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { trough } from '../index.js';\ntest('trough ext', async () => assert.equal(await trough().use((n) => n + 1).runAsync(2), 3));\n";

    class DockerOssAdapter extends LlmAdapter {
      constructor() { super(); this.step = 0; }
      async *stream() {
        this.step++;
        if (this.step === 1) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-write-lib',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'lib/index.js', content: goldLibContent }),
            },
          };
          yield {
            type: 'block-end',
            index: 1,
            block: {
              type: 'tool-call',
              id: 'tc-write-test',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'test/extensions.test.js', content: goldTestContent }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (this.step === 2) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-bash-test',
              name: 'bash',
              arguments: JSON.stringify({ command: 'node --test test.js test/extensions.test.js' }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield {
          type: 'text-delta',
          index: 0,
          text: JSON.stringify({
            schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
            taskId: troughTask.id,
            attemptId: 'attempt-1',
            planVersion: 1,
            summary: 'Implemented clone, prepend, and runAsync',
            changedFiles: troughTask.metadata.acceptanceCriteria.requiredChangedFiles,
            testCommand: 'node --test test.js test/extensions.test.js',
            testExitCode: 0,
            testEvidence: [{ command: 'node --test test.js test/extensions.test.js', exitCode: 0 }],
            artifactRefs: [],
          }),
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }

    const direct = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: dir,
      dataRoot: dataDir,
      adapter: new DockerOssAdapter(),
      enableHeartbeat: false,
    });
    const evalService = new EvaluationService({
      store,
      directAgent: direct,
      ossCacheDir: cacheDir,
      ossRepoOverrides: cachedOverrides,
      sandbox: new BenchmarkSandbox({ mode: SANDBOX_MODES.STRONG }),
      concurrency: 1,
      timeoutMs: 60_000,
    });

    try {
      const started = evalService.start({ benchmarkId: OSS_BENCHMARK_ID, taskIds: ['oss-trough-pipeline-01'], model: 'mock-docker-oss' });
      const deadline = Date.now() + 55_000;
      let done = evalService.getRun(started.id);
      while (Date.now() < deadline && ['queued', 'running'].includes(done?.status)) {
        await new Promise((r) => setTimeout(r, 30));
        done = evalService.getRun(started.id);
      }
      assert.equal(done.status, 'completed', JSON.stringify(done));
      assert.equal(done.score.passed, 1, JSON.stringify(done.results[0]));
      assert.equal(done.results[0].judge.evidence.sandboxBackend, SANDBOX_MODES.DOCKER);
      assert.equal(done.results[0].judge.evidence.strongOsIsolation, true);
      assert.equal(done.results[0].judge.evidence.hiddenAcceptanceVerified, true);
      await evalService.close({ timeoutMs: 1_000 });
    } finally {
      await direct.close();
      store.close();
    }
  });
});
