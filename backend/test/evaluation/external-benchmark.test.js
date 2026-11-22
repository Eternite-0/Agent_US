import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Store } from '../../src/store.js';
import {
  BENCHMARK_ID,
  EvaluationService,
  OSS_BENCHMARK_ID,
  OSS_BENCHMARK_VERSION,
  OSS_DATASET_VERSION,
  REAL_ENGINEERING_BENCHMARK_ID,
  createFixtureWorkspace,
  createGitRepoWorkspace,
  createOssBenchmarkDataset,
  deriveLayeredCapabilities,
  getWorkspaceBaselineCommit,
  listWorkspaceChangedFiles,
  removeFixtureWorkspace,
  summarizeBenchmarkMetrics,
  verifyWorkspacePinnedBaseline,
} from '../../src/evaluation/index.js';
import { EVIDENCE_STATUSES } from '../../src/evaluation/schemas.js';

function writeTreeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

function commitAll(dir, message) {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', message], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim().toLowerCase();
}

function createMultiCommitBareRepo(parentDir, name, commitSequence) {
  const work = join(parentDir, `${name}-work`);
  const bare = join(parentDir, `${name}.git`);
  mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: work, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@agent-us.invalid'], { cwd: work, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Agent_US Test'], { cwd: work, stdio: 'ignore' });

  const shas = [];
  for (const step of commitSequence) {
    writeTreeFiles(work, step.files);
    shas.push(commitAll(work, step.message));
  }

  execFileSync('git', ['clone', '--quiet', '--bare', work, bare], { stdio: 'ignore' });
  rmSync(work, { recursive: true, force: true });
  return { barePath: bare, bareUrl: pathToFileURL(bare).href, shas };
}

function buildEvidenceOutput(task, changedFiles = task.metadata.acceptanceCriteria.requiredChangedFiles, overrides = {}) {
  return {
    output: {
      schemaVersion: '1.0.0',
      taskId: task.id,
      attemptId: 'attempt-1',
      planVersion: 1,
      summary: `Completed ${task.id} on pinned OSS repo.`,
      changedFiles,
      testCommand: task.metadata.acceptanceCriteria.testCommand.join(' '),
      testExitCode: 0,
      testEvidence: [
        {
          command: task.metadata.acceptanceCriteria.testCommand.join(' '),
          exitCode: 0,
        },
      ],
      artifactRefs: [],
      ...overrides,
    },
  };
}

function buildTrustedContext(task, workspaceRoot) {
  return {
    workspaceRoot,
    attemptId: 'attempt-1',
    planVersion: 1,
    toolReceipts: [
      {
        id: `receipt-${task.id}`,
        toolName: 'bash',
        status: 'finished',
        exitCode: 0,
        command: task.metadata.acceptanceCriteria.testCommand.join(' '),
      },
    ],
    trustedVerdict: {
      status: 'pass',
      source: 'trusted_server_verifier',
      evidenceRefs: [`receipt-${task.id}`],
    },
  };
}

function buildHermeticOssFixtures(root) {
  const nanoidRepo = createMultiCommitBareRepo(root, 'nanoid', [
    {
      message: 'chore: initial package',
      files: {
        'package.json': JSON.stringify({ name: 'nanoid', version: '6.0.2', type: 'module' }, null, 2),
        'url-alphabet/index.js': "export let urlAlphabet = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';\n",
      },
    },
    {
      message: 'feat: core node and browser generators',
      files: {
        'index.js': `import { urlAlphabet } from './url-alphabet/index.js';
export { urlAlphabet };
export function nanoid(size = 21) {
  let id = '';
  let bytes = crypto.getRandomValues(new Uint8Array((size |= 0)));
  if (size < 0) throw new RangeError('Wrong ID size');
  while (size--) id += urlAlphabet[bytes[size] & 63];
  return id;
}
export function customAlphabet(alphabet, defaultSize = 21) {
  return (size = defaultSize) => {
    size |= 0;
    if (size < 0) throw new RangeError('Wrong ID size');
    let id = '';
    let bytes = crypto.getRandomValues(new Uint8Array(size));
    while (size--) id += alphabet[bytes[size] % alphabet.length];
    return id;
  };
}
`,
        'index.browser.js': `import { urlAlphabet } from './url-alphabet/index.js';
export { urlAlphabet };
export function nanoid(size = 21) {
  let id = '';
  let bytes = crypto.getRandomValues(new Uint8Array((size |= 0)));
  if (size < 0) throw new RangeError('Wrong ID size');
  while (size--) id += urlAlphabet[bytes[size] & 63];
  return id;
}
export function customAlphabet(alphabet, defaultSize = 21) {
  return (size = defaultSize) => {
    size |= 0;
    if (size < 0) throw new RangeError('Wrong ID size');
    let id = '';
    let bytes = crypto.getRandomValues(new Uint8Array(size));
    while (size--) id += alphabet[bytes[size] % alphabet.length];
    return id;
  };
}
`,
        'non-secure/index.js': `import { urlAlphabet } from '../url-alphabet/index.js';
export function nanoid(size = 21) {
  let id = '';
  let i = size | 0;
  while (i--) id += urlAlphabet[(Math.random() * 64) | 0];
  return id;
}
`,
      },
    },
    {
      message: 'feat: cli and baseline tests (pinned baseline)',
      files: {
        'bin/nanoid.js': `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { customAlphabet, nanoid } from '../index.js';
function print(msg) { process.stdout.write(msg + '\\n'); }
function error(msg) { process.stderr.write(msg + '\\n'); process.exit(1); }
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  print(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version);
  process.exit(0);
}
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  print('Usage\\n  $ nanoid [options]\\n\\nOptions\\n  -s, --size\\n  -a, --alphabet\\n  -v, --version\\n  -h, --help');
  process.exit(0);
}
let alphabet, size;
for (let i = 2; i < process.argv.length; i++) {
  let arg = process.argv[i];
  if (arg === '--size' || arg === '-s') {
    size = Number(process.argv[++i]);
    if (!Number.isInteger(size) || size <= 0) error('Size must be positive integer');
  } else if (arg === '--alphabet' || arg === '-a') {
    alphabet = process.argv[++i];
  } else error('Unknown argument ' + arg);
}
print(alphabet ? customAlphabet(alphabet, size)() : nanoid(size));
`,
        'test/index.test.js': "import test from 'node:test'; import assert from 'node:assert/strict'; import * as node from '../index.js'; import * as browser from '../index.browser.js'; test('baseline nanoid', () => { assert.equal(node.nanoid(10).length, 10); assert.equal(browser.nanoid(10).length, 10); });\n",
        'test/non-secure.test.js': "import test from 'node:test'; import assert from 'node:assert/strict'; import { nanoid } from '../non-secure/index.js'; test('baseline non-secure', () => { assert.equal(nanoid(8).length, 8); });\n",
        'test/pool.test.js': "import test from 'node:test'; import assert from 'node:assert/strict'; import { nanoid } from '../index.js'; test('baseline pool', () => { assert.equal(nanoid(64).length, 64); });\n",
        'test/bin.test.js': "import test from 'node:test'; import assert from 'node:assert/strict'; import { execFileSync } from 'node:child_process'; test('baseline bin', () => { const out = execFileSync(process.execPath, ['bin/nanoid.js'], { encoding: 'utf8' }); assert.equal(out.trim().length, 21); });\n",
      },
    },
    {
      message: 'docs: unrelated future commit after pinned baseline',
      files: {
        'CHANGELOG.md': '# Future changelog entry\n',
      },
    },
  ]);

  const troughRepo = createMultiCommitBareRepo(root, 'trough', [
    {
      message: 'chore: init trough',
      files: {
        'package.json': JSON.stringify({ name: 'trough', version: '2.2.0', type: 'module', exports: './index.js' }, null, 2),
      },
    },
    {
      message: 'feat: pipeline implementation',
      files: {
        'index.js': "export { trough, wrap } from './lib/index.js';\n",
        'lib/index.js': `export function trough() {
  const fns = [];
  const pipeline = { run, use };
  return pipeline;
  function run(...values) {
    let middlewareIndex = -1;
    const callback = values.pop();
    if (typeof callback !== 'function') throw new TypeError('Expected function as last argument');
    next(null, ...values);
    function next(error, ...output) {
      const fn = fns[++middlewareIndex];
      let index = -1;
      if (error) { callback(error); return; }
      while (++index < values.length) {
        if (output[index] === null || output[index] === undefined) output[index] = values[index];
      }
      values = output;
      if (fn) wrap(fn, next)(...output);
      else callback(null, ...output);
    }
  }
  function use(fn) {
    if (typeof fn !== 'function') throw new TypeError('Expected fn to be a function');
    fns.push(fn);
    return pipeline;
  }
}
export function wrap(middleware, callback) {
  let called = false;
  return function wrapped(...parameters) {
    const fnExpectsCallback = middleware.length > parameters.length;
    if (fnExpectsCallback) parameters.push(done);
    let result;
    try { result = middleware.apply(this, parameters); } catch (err) {
      if (fnExpectsCallback && called) throw err;
      return done(err);
    }
    if (!fnExpectsCallback) {
      if (result && typeof result.then === 'function') result.then((v) => done(null, v), done);
      else if (result instanceof Error) done(result);
      else done(null, result);
    }
  };
  function done(err, ...out) {
    if (!called) { called = true; callback(err, ...out); }
  }
}
`,
      },
    },
    {
      message: 'test: baseline trough tests (pinned baseline)',
      files: {
        'test.js': `import assert from 'node:assert/strict';
import test from 'node:test';
import { trough } from 'trough';
test('exports', async () => {
  assert.deepEqual(Object.keys(await import('trough')).sort(), ['trough', 'wrap']);
});
test('baseline run', async () => {
  let out;
  trough().use((v) => v + '1').run('a', (e, v) => { assert.ifError(e); out = v; });
  assert.equal(out, 'a1');
});
`,
      },
    },
    {
      message: 'docs: newer commit after pin',
      files: { 'README.md': '# trough\n' },
    },
  ]);

  const contentTypeRepo = createMultiCommitBareRepo(root, 'fast-content-type-parse', [
    {
      message: 'chore: init package',
      files: {
        'package.json': JSON.stringify({ name: 'fast-content-type-parse', version: '3.0.0', type: 'commonjs' }, null, 2),
      },
    },
    {
      message: 'feat: parse and safeParse',
      files: {
        'index.js': `'use strict';
const NullObject = function NullObject() {};
NullObject.prototype = Object.create(null);
const defaultContentType = Object.freeze({ type: '', parameters: Object.freeze(new NullObject()) });
const TCHAR_RE = /^[!#$%&'*+\\-.^_\\\`|~0-9a-zA-Z]+$/;
function parse(header) {
  if (typeof header !== 'string') throw new TypeError('argument header is required and must be a string');
  const trimmed = header.trim();
  const semi = trimmed.indexOf(';');
  const typePart = (semi === -1 ? trimmed : trimmed.slice(0, semi)).trim();
  const slash = typePart.indexOf('/');
  if (slash <= 0 || slash === typePart.length - 1 || typePart.indexOf('/', slash + 1) !== -1) throw new TypeError('invalid media type');
  const main = typePart.slice(0, slash);
  const sub = typePart.slice(slash + 1);
  if (!TCHAR_RE.test(main) || !TCHAR_RE.test(sub)) throw new TypeError('invalid media type');
  const parameters = new NullObject();
  if (semi !== -1) {
    let i = semi + 1;
    while (i < trimmed.length) {
      while (i < trimmed.length && (trimmed[i] === ' ' || trimmed[i] === '\\t' || trimmed[i] === ';')) i++;
      if (i >= trimmed.length) break;
      const eq = trimmed.indexOf('=', i);
      if (eq === -1) throw new TypeError('invalid parameter format');
      const k = trimmed.slice(i, eq).toLowerCase();
      if (!TCHAR_RE.test(k)) throw new TypeError('invalid parameter format');
      i = eq + 1;
      let v = '';
      if (trimmed[i] === '"') {
        i++;
        while (i < trimmed.length && trimmed[i] !== '"') {
          if (trimmed[i] === '\\\\' && i + 1 < trimmed.length) { v += trimmed[++i]; i++; }
          else { v += trimmed[i++]; }
        }
        if (trimmed[i] !== '"') throw new TypeError('invalid parameter format');
        i++;
      } else {
        const end = trimmed.indexOf(';', i);
        const rawEnd = end === -1 ? trimmed.length : end;
        v = trimmed.slice(i, rawEnd).trim();
        if (!TCHAR_RE.test(v)) throw new TypeError('invalid parameter format');
        i = rawEnd;
      }
      if (parameters[k] === undefined) parameters[k] = v;
    }
  }
  return { type: typePart.toLowerCase(), parameters };
}
function safeParse(header) { try { return parse(header); } catch { return defaultContentType; } }
module.exports.default = { parse, safeParse };
module.exports.parse = parse;
module.exports.safeParse = safeParse;
module.exports.defaultContentType = defaultContentType;
`,
      },
    },
    {
      message: 'test: baseline content-type tests (pinned baseline)',
      files: {
        'test/index.test.js': `'use strict';
const { test } = require('node:test');
const { parse, safeParse } = require('..');
test('baseline parse and safeParse', (t) => {
  const parsed = parse('Text/HTML; Charset="UTF-8"');
  t.assert.equal(parsed.type, 'text/html');
  t.assert.equal(parsed.parameters.charset, 'UTF-8');
  t.assert.equal(safeParse('bad').type, '');
});
`,
      },
    },
    {
      message: 'docs: post-pin commit',
      files: { 'README.md': '# fast-content-type-parse\n' },
    },
  ]);

  const nanoeventsRepo = createMultiCommitBareRepo(root, 'nanoevents', [
    {
      message: 'chore: init nanoevents',
      files: {
        'package.json': JSON.stringify({ name: 'nanoevents', version: '9.1.0', type: 'module', types: './index.d.ts' }, null, 2),
      },
    },
    {
      message: 'feat: emitter implementation',
      files: {
        'index.js': `export let createNanoEvents = () => ({
  emit(event, ...args) {
    for (let callbacks = this.events[event] || [], i = 0, length = callbacks.length; i < length; i++) {
      callbacks[i](...args);
    }
  },
  events: {},
  on(event, cb) {
    (this.events[event] ||= []).push(cb);
    return () => {
      this.events[event] = this.events[event]?.filter((i) => cb !== i);
    };
  },
});
`,
        'index.d.ts': `export interface Emitter<Events = any> {
  emit(event: string, ...args: any[]): void;
  events: Record<string, any[]>;
  on(event: string, cb: (...args: any[]) => void): () => void;
}
export function createNanoEvents(): Emitter;
`,
      },
    },
    {
      message: 'test: baseline nanoevents ts tests (pinned baseline)',
      files: {
        'test/index.test.ts': `import { deepStrictEqual, equal } from 'node:assert';
import { test } from 'node:test';
import { createNanoEvents } from '../index.js';
test('baseline emitter', () => {
  const ee = createNanoEvents();
  deepStrictEqual(ee.events, {});
  let count = 0;
  const off = ee.on('tick', (n: number) => { count += n; });
  ee.emit('tick', 2);
  off();
  ee.emit('tick', 3);
  equal(count, 2);
});
test('replaces events object', () => {
  const ee1 = createNanoEvents();
  const ee2 = createNanoEvents();
  let calls = 0;
  ee2.on('x', () => { calls += 1; });
  ee1.events = ee2.events;
  ee1.emit('x');
  equal(calls, 1);
});
`,
      },
    },
    {
      message: 'docs: post-pin readme',
      files: { 'README.md': '# nanoevents\n' },
    },
  ]);

  return {
    nanoidRepo,
    troughRepo,
    contentTypeRepo,
    nanoeventsRepo,
    overrides: {
      'oss-nanoid-batch-cli-01': { repoUrl: nanoidRepo.barePath, commit: nanoidRepo.shas[2] },
      'oss-trough-pipeline-01': { repoUrl: troughRepo.barePath, commit: troughRepo.shas[2] },
      'oss-content-type-format-01': { repoUrl: contentTypeRepo.barePath, commit: contentTypeRepo.shas[2] },
      'oss-nanoevents-hardening-01': { repoUrl: nanoeventsRepo.barePath, commit: nanoeventsRepo.shas[2] },
    },
  };
}

function applyGoldFix(taskId, workspaceRoot) {
  if (taskId === 'oss-nanoid-batch-cli-01') {
    const batchImpl = `
export function nanoidBatch(count, size = 21) {
  if (!Number.isInteger(count) || count < 0 || count > 10000) {
    throw new RangeError('Wrong batch count');
  }
  if (!Number.isInteger(size) || size < 0) {
    throw new RangeError('Wrong ID size');
  }
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(nanoid(size));
  }
  return out;
}
`;
    for (const file of ['index.js', 'index.browser.js']) {
      const current = readFileSync(join(workspaceRoot, file), 'utf8');
      writeFileSync(join(workspaceRoot, file), current + batchImpl, 'utf8');
    }
    writeFileSync(join(workspaceRoot, 'bin/nanoid.js'), `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { customAlphabet, nanoid, nanoidBatch } from '../index.js';
function print(msg) { process.stdout.write(msg + '\\n'); }
function error(msg) { process.stderr.write(msg + '\\n'); process.exit(1); }
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  print(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version);
  process.exit(0);
}
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  print('Usage\\n  $ nanoid [options]\\n\\nOptions\\n  -s, --size       Generated ID size\\n  -a, --alphabet   Alphabet to use\\n  -c, --count      Number of IDs to generate\\n  -v, --version    Show version number\\n  -h, --help       Show this help');
  process.exit(0);
}
let alphabet, size, count = 1;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const raw = args[i];
  const eq = raw.indexOf('=');
  const flag = eq === -1 ? raw : raw.slice(0, eq);
  const readVal = () => {
    if (eq !== -1) return raw.slice(eq + 1);
    if (i + 1 >= args.length) error('Missing value for ' + flag);
    return args[++i];
  };
  if (flag === '--size' || flag === '-s') {
    const val = readVal();
    if (!val.trim()) error('Size must be positive integer');
    size = Number(val);
    if (!Number.isInteger(size) || size <= 0) error('Size must be positive integer');
  } else if (flag === '--alphabet' || flag === '-a') {
    alphabet = readVal();
    if (!alphabet) error('Alphabet must be non-empty');
  } else if (flag === '--count' || flag === '-c') {
    const val = readVal();
    if (!val.trim()) error('Count must be integer 1..10000');
    count = Number(val);
    if (!Number.isInteger(count) || count < 1 || count > 10000) error('Count must be integer 1..10000');
  } else {
    error('Unknown argument ' + raw);
  }
}
if (alphabet) {
  const gen = customAlphabet(alphabet, size);
  for (let i = 0; i < count; i += 1) print(gen());
} else {
  for (const id of nanoidBatch(count, size)) print(id);
}
`, 'utf8');
    writeFileSync(join(workspaceRoot, 'test/batch.test.js'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { nanoidBatch } from '../index.js';
test('nanoidBatch generates requested count', () => {
  assert.equal(nanoidBatch(3, 8).length, 3);
  assert.throws(() => nanoidBatch(-1), RangeError);
});
`, 'utf8');
    return;
  }

  if (taskId === 'oss-trough-pipeline-01') {
    writeFileSync(join(workspaceRoot, 'lib/index.js'), `export function trough() {
  const fns = [];
  const pipeline = { clone, prepend, run, runAsync, use };
  return pipeline;
  function clone() {
    const copy = trough();
    for (const fn of fns) copy.use(fn);
    return copy;
  }
  function prepend(fn) {
    if (typeof fn !== 'function') throw new TypeError('Expected fn to be a function');
    fns.unshift(fn);
    return pipeline;
  }
  function run(...values) {
    let middlewareIndex = -1;
    const callback = values.pop();
    if (typeof callback !== 'function') throw new TypeError('Expected function as last argument');
    next(null, ...values);
    function next(error, ...output) {
      const fn = fns[++middlewareIndex];
      let index = -1;
      if (error) { callback(error); return; }
      while (++index < values.length) {
        if (output[index] === null || output[index] === undefined) output[index] = values[index];
      }
      values = output;
      if (fn) wrap(fn, next)(...output);
      else callback(null, ...output);
    }
  }
  function runAsync(...values) {
    const arity = values.length;
    return new Promise((resolve, reject) => {
      run(...values, (error, ...output) => {
        if (error) reject(error);
        else if (arity <= 1) resolve(output[0]);
        else resolve(output);
      });
    });
  }
  function use(fn) {
    if (typeof fn !== 'function') throw new TypeError('Expected fn to be a function');
    fns.push(fn);
    return pipeline;
  }
}
export function wrap(middleware, callback) {
  let called = false;
  return function wrapped(...parameters) {
    const fnExpectsCallback = middleware.length > parameters.length;
    if (fnExpectsCallback) parameters.push(done);
    let result;
    try { result = middleware.apply(this, parameters); } catch (err) {
      if (fnExpectsCallback && called) throw err;
      return done(err);
    }
    if (!fnExpectsCallback) {
      if (result && typeof result.then === 'function') result.then((v) => done(null, v), done);
      else if (result instanceof Error) done(result);
      else done(null, result);
    }
  };
  function done(err, ...out) {
    if (!called) { called = true; callback(err, ...out); }
  }
}
`, 'utf8');
    mkdirSync(join(workspaceRoot, 'test'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'test/extensions.test.js'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { trough } from '../index.js';
test('clone, prepend, runAsync', async () => {
  const p = trough().use((x) => x + 1);
  const p2 = p.clone().prepend((x) => x * 2);
  assert.equal(await p.runAsync(3), 4);
  assert.equal(await p2.runAsync(3), 7);
});
`, 'utf8');
    return;
  }

  if (taskId === 'oss-content-type-format-01') {
    const current = readFileSync(join(workspaceRoot, 'index.js'), 'utf8');
    const addition = `
function isValidQuotedCharCode(code) {
  return code === 0x09 || code === 0x20 || code === 0x21 || code === 0x22 || (code >= 0x23 && code <= 0x5b) || code === 0x5c || (code >= 0x5d && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
}
function format(contentType) {
  if (!contentType || typeof contentType !== 'object' || Array.isArray(contentType)) {
    throw new TypeError('contentType must be an object');
  }
  if (typeof contentType.type !== 'string') throw new TypeError('invalid media type');
  const slash = contentType.type.indexOf('/');
  if (slash <= 0 || slash === contentType.type.length - 1 || contentType.type.indexOf('/', slash + 1) !== -1) {
    throw new TypeError('invalid media type');
  }
  const main = contentType.type.slice(0, slash);
  const sub = contentType.type.slice(slash + 1);
  if (!TCHAR_RE.test(main) || !TCHAR_RE.test(sub)) throw new TypeError('invalid media type');
  let out = contentType.type.toLowerCase();
  if (contentType.parameters === undefined) return out;
  if (!contentType.parameters || typeof contentType.parameters !== 'object' || Array.isArray(contentType.parameters)) {
    throw new TypeError('parameters must be an object');
  }
  const seen = new Set();
  for (const rawKey of Object.keys(contentType.parameters)) {
    const key = rawKey.toLowerCase();
    if (!TCHAR_RE.test(key)) throw new TypeError('invalid parameter name');
    if (seen.has(key)) continue;
    seen.add(key);
    const rawVal = contentType.parameters[rawKey];
    if (typeof rawVal !== 'string' && typeof rawVal !== 'number' && typeof rawVal !== 'boolean') {
      throw new TypeError('invalid parameter value');
    }
    const str = String(rawVal);
    for (let i = 0; i < str.length; i += 1) {
      if (!isValidQuotedCharCode(str.charCodeAt(i))) throw new TypeError('invalid parameter value');
    }
    const serialized = str.length > 0 && TCHAR_RE.test(str)
      ? str
      : '"' + str.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"';
    out += '; ' + key + '=' + serialized;
  }
  return out;
}
module.exports.format = format;
module.exports.default.format = format;
`;
    writeFileSync(join(workspaceRoot, 'index.js'), current + addition, 'utf8');
    writeFileSync(join(workspaceRoot, 'test/format.test.js'), `'use strict';
const { test } = require('node:test');
const { format, parse } = require('..');
test('format round-trips', (t) => {
  const header = format({ type: 'Text/HTML', parameters: { Charset: 'utf-8', title: 'hi "you"' } });
  t.assert.deepEqual(parse(header), { type: 'text/html', parameters: Object.assign(Object.create(null), { charset: 'utf-8', title: 'hi "you"' }) });
});
`, 'utf8');
    return;
  }

  if (taskId === 'oss-nanoevents-hardening-01') {
    writeFileSync(join(workspaceRoot, 'index.js'), `const hasOwn = Object.hasOwn;

function ensureList(events, event) {
  if (!hasOwn(events, event)) {
    Object.defineProperty(events, event, {
      value: [],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return events[event];
}

export let createNanoEvents = () => ({
  emit(event, ...args) {
    const callbacks = hasOwn(this.events, event) ? this.events[event] : [];
    for (let i = 0, length = callbacks.length; i < length; i++) {
      callbacks[i](...args);
    }
  },
  events: {},
  on(event, cb) {
    if (typeof cb !== 'function') throw new TypeError('Listener must be a function');
    ensureList(this.events, event).push(cb);
    return () => {
      if (!hasOwn(this.events, event)) return;
      Object.defineProperty(this.events, event, {
        value: this.events[event].filter((i) => cb !== i),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    };
  },
  once(event, cb) {
    if (typeof cb !== 'function') throw new TypeError('Listener must be a function');
    let unbind = () => {};
    const wrapper = (...args) => {
      unbind();
      cb(...args);
    };
    unbind = this.on(event, wrapper);
    return unbind;
  },
  clear(event) {
    if (event === undefined) {
      this.events = {};
      return;
    }
    if (hasOwn(this.events, event)) {
      delete this.events[event];
    }
  },
});
`, 'utf8');
    writeFileSync(join(workspaceRoot, 'index.d.ts'), `export interface Emitter<Events = any> {
  emit(event: string, ...args: any[]): void;
  events: Record<string, any[]>;
  on(event: string, cb: (...args: any[]) => void): () => void;
  once(event: string, cb: (...args: any[]) => void): () => void;
  clear(event?: string): void;
}
export function createNanoEvents(): Emitter;
`, 'utf8');
    writeFileSync(join(workspaceRoot, 'test/hardening.test.ts'), `import { deepStrictEqual, equal, throws } from 'node:assert';
import { test } from 'node:test';
import { createNanoEvents } from '../index.js';
test('prototype safety, once, and clear', () => {
  const ee = createNanoEvents();
  throws(() => ee.on('a', null as any), TypeError);
  let total = 0;
  ee.once('__proto__', (n: number) => { total += n; });
  ee.emit('__proto__', 5);
  ee.emit('__proto__', 5);
  equal(total, 5);
  ee.clear();
  deepStrictEqual(ee.events, {});
});
`, 'utf8');
  }
}

test('multi-commit git repo baseline tracking diffs only against pinned commit and rejects SHA mismatch', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-us-oss-git-test-'));
  const cacheDir = join(root, 'mirror-cache');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const repo = createMultiCommitBareRepo(root, 'sample-lib', [
    { message: 'c1 init', files: { 'README.md': '# v1\n', 'src/a.js': 'export const a = 1;\n' } },
    { message: 'c2 add b', files: { 'src/b.js': 'export const b = 2;\n' } },
    { message: 'c3 pinned baseline', files: { 'src/a.js': 'export const a = 3;\n', 'src/c.js': 'export const c = 3;\n' } },
    { message: 'c4 future commit', files: { 'src/future.js': 'export const future = true;\n' } },
  ]);

  const pinnedSha = repo.shas[2];
  const rootSha = repo.shas[0];
  const futureSha = repo.shas[3];
  assert.notEqual(pinnedSha, rootSha);
  assert.notEqual(pinnedSha, futureSha);

  // Test both file:// URL and local bare path with mirror cacheDir
  const task = {
    id: 'oss-sample-git-test',
    title: 'Sample Git',
    prompt: 'Sample',
    expected: { output: {} },
    fixture: { repoUrl: repo.bareUrl, commit: pinnedSha },
  };

  const ws1 = await createGitRepoWorkspace(task, { cacheDir });
  t.after(() => removeFixtureWorkspace(ws1));

  assert.equal(getWorkspaceBaselineCommit(ws1), pinnedSha);
  assert.equal(existsSync(join(ws1, 'src', 'future.js')), false, 'must checkout pinned commit, not main HEAD');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: ws1, encoding: 'utf8' }).trim(), '');
  assert.deepEqual(listWorkspaceChangedFiles(ws1), [], 'untouched multi-commit workspace must report zero changed files');

  // Modify tracked file & add untracked file -> only those appear
  writeFileSync(join(ws1, 'src', 'a.js'), 'export const a = 99;\n', 'utf8');
  writeFileSync(join(ws1, 'src', 'added.js'), 'export const added = true;\n', 'utf8');
  assert.deepEqual(listWorkspaceChangedFiles(ws1), ['src/a.js', 'src/added.js']);

  // Commit inside workspace -> listWorkspaceChangedFiles still diffs against .git/agent-us-eval-base
  commitAll(ws1, 'agent local commit');
  assert.deepEqual(listWorkspaceChangedFiles(ws1), ['src/a.js', 'src/added.js']);
  assert.equal(verifyWorkspacePinnedBaseline(ws1, pinnedSha).ok, true);

  // Repeat via createFixtureWorkspace with filesystem bare path and cached mirror
  const ws2 = await createFixtureWorkspace(
    { ...task, fixture: { repoUrl: repo.barePath, commit: pinnedSha } },
    { cacheDir },
  );
  t.after(() => removeFixtureWorkspace(ws2));
  assert.equal(getWorkspaceBaselineCommit(ws2), pinnedSha);
  assert.deepEqual(listWorkspaceChangedFiles(ws2), []);

  // Fail closed on missing or invalid commit SHA
  await assert.rejects(
    () => createGitRepoWorkspace({ fixture: { repoUrl: repo.barePath, commit: '0'.repeat(40) } }),
    /not found/i,
  );
  await assert.rejects(
    () => createGitRepoWorkspace({ fixture: { repoUrl: repo.barePath, commit: 'not-a-sha' } }),
    TypeError,
  );
  await assert.rejects(
    () => createGitRepoWorkspace({ fixture: { repoUrl: '--upload-pack=evil', commit: pinnedSha } }),
    TypeError,
  );
});

test('createOssBenchmarkDataset exposes 4 real pinned GitHub OSS repos and strict contracts', () => {
  assert.equal(OSS_BENCHMARK_ID, 'agent-us-oss-benchmark');
  assert.equal(OSS_BENCHMARK_VERSION, '1.0.0');
  assert.equal(OSS_DATASET_VERSION, '1.0.0');

  const tasks = createOssBenchmarkDataset();
  assert.equal(tasks.length, 4);
  const slugs = new Set();
  for (const task of tasks) {
    assert.match(task.fixture.repoUrl, /^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/);
    assert.match(task.fixture.commit, /^[0-9a-f]{40}$/);
    assert.ok(task.fixture.license);
    assert.equal(task.metadata.externalNetwork, false);
    assert.equal(task.metadata.requiresWorkspaceMutation, true);
    assert.equal(task.metadata.requiresGitDiff, true);
    assert.equal(typeof task.judge, 'function');
    assert.match(task.prompt, /Engineering Evidence Manifest v1\.0\.0/);
    slugs.add(task.fixture.repoSlug);
  }
  assert.equal(slugs.size, 4);
});

test('OSS judges accept real compliant fixes and reject broken fixes, tampered tests, tampered git history, and fake manifests', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-us-oss-judges-'));
  const cacheDir = join(root, 'cache');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const fixtures = buildHermeticOssFixtures(root);
  const cachedOverrides = Object.fromEntries(
    Object.entries(fixtures.overrides).map(([id, cfg]) => [id, { ...cfg, cacheDir }]),
  );
  const tasks = createOssBenchmarkDataset({ repoOverrides: cachedOverrides });

  for (const task of tasks) {
    // 1. Real compliant fix -> PASS
    const passWs = await createFixtureWorkspace(task);
    t.after(() => removeFixtureWorkspace(passWs));
    applyGoldFix(task.id, passWs);
    const passRes = await task.judge({
      task,
      output: buildEvidenceOutput(task),
      context: buildTrustedContext(task, passWs),
    });
    assert.equal(passRes.passed, true, `${task.id} expected pass: ${JSON.stringify(passRes.evidence)}`);
    assert.equal(passRes.evidence.checks.historyUntouched, true);
    assert.equal(passRes.evidence.checks.baselineTestsUntampered, true);
    assert.equal(passRes.evidence.checks.baselineTestsPassed, true);
    assert.equal(passRes.evidence.checks.hiddenAcceptancePassed, true);
    assert.equal(passRes.evidence.evidenceCompliant, true);

    // 2. Self-attested / fake manifest -> REJECT
    const fakeManifestRes = await task.judge({
      task,
      output: buildEvidenceOutput(task, task.metadata.acceptanceCriteria.requiredChangedFiles, {
        independentVerdict: { status: 'pass', evidenceRefs: ['forged'] },
      }),
      context: { workspaceRoot: passWs, attemptId: 'attempt-1', planVersion: 1, toolReceipts: [] },
    });
    assert.equal(fakeManifestRes.passed, false);
    assert.equal(fakeManifestRes.evidence.evidenceCompliant, false);
    assert.equal(fakeManifestRes.evidence.manifestStatus, EVIDENCE_STATUSES.INCOMPLETE);

    // 3. Untouched workspace -> REJECT
    const untouchedWs = await createFixtureWorkspace(task);
    t.after(() => removeFixtureWorkspace(untouchedWs));
    const untouchedRes = await task.judge({
      task,
      output: buildEvidenceOutput(task),
      context: buildTrustedContext(task, untouchedWs),
    });
    assert.equal(untouchedRes.passed, false);
    assert.equal(untouchedRes.evidence.checks.changedFiles, false);

    // 4. Tampered git history (reset --hard HEAD~1) -> REJECT
    const resetWs = await createFixtureWorkspace(task);
    t.after(() => removeFixtureWorkspace(resetWs));
    applyGoldFix(task.id, resetWs);
    execFileSync('git', ['reset', '--hard', '-q', 'HEAD~1'], { cwd: resetWs, stdio: 'ignore' });
    const resetRes = await task.judge({
      task,
      output: buildEvidenceOutput(task),
      context: buildTrustedContext(task, resetWs),
    });
    assert.equal(resetRes.passed, false);
    assert.equal(resetRes.evidence.checks.historyUntouched, false);
    assert.equal(resetRes.evidence.failureCategory, 'history_tampered');

    // 5. Tampered baseline marker (.git/agent-us-eval-base) -> REJECT
    const markerWs = await createFixtureWorkspace(task);
    t.after(() => removeFixtureWorkspace(markerWs));
    applyGoldFix(task.id, markerWs);
    const parentSha = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: markerWs, encoding: 'utf8' }).trim();
    writeFileSync(join(markerWs, '.git', 'agent-us-eval-base'), `${parentSha}\n`, 'utf8');
    const markerRes = await task.judge({
      task,
      output: buildEvidenceOutput(task),
      context: buildTrustedContext(task, markerWs),
    });
    assert.equal(markerRes.passed, false);
    assert.equal(markerRes.evidence.checks.historyUntouched, false);
  }

  // 6. Broken implementation -> REJECT by hidden acceptance suite
  const brokenWs = await createFixtureWorkspace(tasks[1]); // trough
  t.after(() => removeFixtureWorkspace(brokenWs));
  applyGoldFix(tasks[1].id, brokenWs);
  const brokenLib = readFileSync(join(brokenWs, 'lib/index.js'), 'utf8').replace(
    /function clone\(\) \{[\s\S]*?\n  \}/,
    'function clone() {\n    return pipeline;\n  }',
  );
  assert.ok(!brokenLib.includes('copy.use'), 'broken fixture mutation must alter clone()');
  writeFileSync(join(brokenWs, 'lib/index.js'), brokenLib, 'utf8');
  const brokenRes = await tasks[1].judge({
    task: tasks[1],
    output: buildEvidenceOutput(tasks[1]),
    context: buildTrustedContext(tasks[1], brokenWs),
  });
  assert.equal(brokenRes.passed, false, JSON.stringify(brokenRes.evidence));
  assert.equal(brokenRes.evidence.checks.hiddenAcceptancePassed, false);

  // 7. Weakened / modified baseline test file -> REJECT
  const tamperedTestWs = await createFixtureWorkspace(tasks[0]); // nanoid
  t.after(() => removeFixtureWorkspace(tamperedTestWs));
  applyGoldFix(tasks[0].id, tamperedTestWs);
  writeFileSync(join(tamperedTestWs, 'test/index.test.js'), "import test from 'node:test'; test('noop', () => {});\n", 'utf8');
  const tamperedTestRes = await tasks[0].judge({
    task: tasks[0],
    output: buildEvidenceOutput(tasks[0], [...tasks[0].metadata.acceptanceCriteria.requiredChangedFiles, 'test/index.test.js']),
    context: buildTrustedContext(tasks[0], tamperedTestWs),
  });
  assert.equal(tamperedTestRes.passed, false);
  assert.equal(tamperedTestRes.evidence.checks.baselineTestsUntampered, false);
  assert.equal(tamperedTestRes.evidence.failureCategory, 'history_tampered');
});

test('EvaluationService registers agent-us-oss-benchmark and runs end-to-end offline with metrics', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-us-oss-service-'));
  const cacheDir = join(root, 'cache');
  const store = new Store(':memory:');
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  // Default service exposes all 3 benchmarks without altering existing counts
  const defaultService = new EvaluationService({
    store,
    runtimeFactory: async ({ task }) => ({ output: task.expected.output }),
  });
  const defaultBenchmarks = defaultService.listBenchmarks();
  assert.equal(defaultBenchmarks.find((b) => b.id === BENCHMARK_ID)?.taskCount, 30);
  assert.equal(defaultBenchmarks.find((b) => b.id === REAL_ENGINEERING_BENCHMARK_ID)?.taskCount, 10);
  const ossMeta = defaultBenchmarks.find((b) => b.id === OSS_BENCHMARK_ID);
  assert.equal(ossMeta?.taskCount, 4);
  assert.throws(
    () => defaultService.start({ benchmarkId: OSS_BENCHMARK_ID, taskIds: ['real-bug-fix-01'] }),
    /belong to the selected benchmark/,
  );

  // Offline hermetic end-to-end service execution across all 4 OSS tasks
  const fixtures = buildHermeticOssFixtures(root);
  const service = new EvaluationService({
    store,
    ossCacheDir: cacheDir,
    ossRepoOverrides: fixtures.overrides,
    concurrency: 2,
    timeoutMs: 30_000,
    runtimeFactory: async ({ task, workspaceRoot }) => {
      applyGoldFix(task.id, workspaceRoot);
      const manifest = buildEvidenceOutput(task).output;
      return {
        output: `Completed ${task.id}.\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``,
        toolReceipts: buildTrustedContext(task, workspaceRoot).toolReceipts,
        trustedVerdict: buildTrustedContext(task, workspaceRoot).trustedVerdict,
        stepUsage: { steps: 7 },
        tokenUsage: { inputTokens: 1200, outputTokens: 450, totalTokens: 1650 },
      };
    },
  });
  t.after(async () => {
    await service.close({ timeoutMs: 1_000 });
  });

  const started = service.start({ benchmarkId: OSS_BENCHMARK_ID, model: 'test-oss-model' });
  const deadline = Date.now() + 25_000;
  let finalRun = service.getRun(started.id);
  while (Date.now() < deadline && ['queued', 'running'].includes(finalRun?.status)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    finalRun = service.getRun(started.id);
  }

  assert.equal(finalRun.status, 'completed', JSON.stringify(finalRun));
  assert.equal(finalRun.score.total, 4);
  assert.equal(finalRun.score.passed, 4, JSON.stringify(finalRun.results));
  assert.equal(finalRun.score.passRate, 1);

  const summary = summarizeBenchmarkMetrics(finalRun);
  assert.equal(summary.total, 4);
  assert.equal(summary.fullPassRate, 1);
  assert.equal(summary.implementationPassRate, 1);
  assert.equal(summary.testPassRate, 1);
  assert.equal(summary.evidenceComplianceRate, 1);

  const layered = deriveLayeredCapabilities(finalRun.results, finalRun.score);
  assert.equal(layered.engineering.fullAcceptanceRate, 1);
  assert.equal(layered.engineering.score, 1);
  assert.equal(layered.execution.toolSuccessRate, 1);

  // Confirm mirror cache was populated for offline reuse
  const cachedMirrors = existsSync(cacheDir) ? readdirSync(cacheDir).length : 0;
  assert.equal(cachedMirrors, 4);
});
