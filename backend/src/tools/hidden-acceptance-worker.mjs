import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const realSend = typeof process.send === 'function' ? process.send.bind(process) : null;
if (!realSend) {
  process.exit(97);
}

// Prevent untrusted code loaded later in this isolate from spoofing IPC frames via process.send.
try {
  Object.defineProperty(process, 'send', {
    value: () => {
      throw new Error('Direct process.send is forbidden inside hidden acceptance worker');
    },
    writable: false,
    configurable: false,
  });
} catch {
  // best effort
}

const init = await new Promise((resolveInit, rejectInit) => {
  const timer = setTimeout(() => rejectInit(new Error('Worker init IPC timeout')), 5000);
  const onMsg = (msg) => {
    if (msg && typeof msg === 'object' && msg.type === 'init') {
      clearTimeout(timer);
      process.removeListener('message', onMsg);
      resolveInit(msg);
    }
  };
  process.on('message', onMsg);
  realSend({ type: 'worker_ready' });
});

const suitePath = String(init.suitePath);
const suiteUrl = pathToFileURL(suitePath).href;

function normalizeFileUrl(url) {
  if (!url || !url.startsWith('file://')) return url;
  const p = fileURLToPath(url);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

const normalizedSuiteFile = normalizeFileUrl(suiteUrl);

const suiteBytes = readFileSync(suitePath);
const actualSuiteSha = createHash('sha256').update(suiteBytes).digest('hex');
if (actualSuiteSha !== init.suiteSha256) {
  realSend({
    type: 'test_end',
    testToken: init.testToken,
    testId: init.targetId,
    testIndex: init.targetIndex,
    testName: init.targetName,
    started: true,
    completed: true,
    passed: false,
    skipped: false,
    todo: false,
    tamperingDetected: true,
    assertionCount: 0,
    reason: 'suite_sha256_mismatch',
    error: 'Hidden suite file digest changed between supervisor check and worker load',
  });
  process.exit(1);
}

let assertionCount = 0;
let skipAttempted = false;
let todoAttempted = false;
const registeredTests = [];
const beforeHooks = [];
const afterHooks = [];
const beforeEachHooks = [];
const afterEachHooks = [];
const suiteStack = [];

const INTERNAL_ASSERT_URL = 'agent-us-hidden:assert';
const INTERNAL_ASSERT_STRICT_URL = 'agent-us-hidden:assert-strict';
const INTERNAL_TEST_URL = 'agent-us-hidden:test';
const INTERNAL_BRIDGE_URL = 'agent-us-hidden:bridge';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? '';
    const isInternalHarness =
      parent === INTERNAL_ASSERT_URL ||
      parent === INTERNAL_ASSERT_STRICT_URL ||
      parent === INTERNAL_TEST_URL;

    if (specifier === INTERNAL_BRIDGE_URL) {
      if (isInternalHarness || parent === import.meta.url) {
        return { url: INTERNAL_BRIDGE_URL, shortCircuit: true };
      }
      const err = new Error(`Module not found: ${specifier}`);
      err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    }

    const fromSuite = normalizeFileUrl(parent) === normalizedSuiteFile;
    if (fromSuite) {
      if (specifier === 'node:assert' || specifier === 'assert') {
        return { url: INTERNAL_ASSERT_URL, shortCircuit: true };
      }
      if (specifier === 'node:assert/strict' || specifier === 'assert/strict') {
        return { url: INTERNAL_ASSERT_STRICT_URL, shortCircuit: true };
      }
      if (specifier === 'node:test' || specifier === 'test') {
        return { url: INTERNAL_TEST_URL, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },

  load(url, context, nextLoad) {
    if (url === INTERNAL_BRIDGE_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
let sealed = false;
let bridgeApi = null;
export function sealBridge(api) {
  if (sealed) throw new Error('Hidden acceptance bridge already sealed');
  sealed = true;
  bridgeApi = Object.freeze({ ...api });
}
export function getBridge() {
  if (!bridgeApi) throw new Error('Hidden acceptance bridge not initialized');
  return bridgeApi;
}
`,
      };
    }

    if (url === INTERNAL_ASSERT_STRICT_URL || url === INTERNAL_ASSERT_URL) {
      const targetMod = url === INTERNAL_ASSERT_STRICT_URL ? 'node:assert/strict' : 'node:assert';
      return {
        format: 'module',
        shortCircuit: true,
        source: `
import orig, { Assert, AssertionError, CallTracker, strict as origStrict } from '${targetMod}';
import { getBridge } from '${INTERNAL_BRIDGE_URL}';

const bridge = getBridge();
const wrapFn = (fn) => function wrappedAssert(...args) {
  bridge.onAssertion();
  return fn.apply(this, args);
};

const deepEqual = wrapFn(orig.deepEqual);
const deepStrictEqual = wrapFn(orig.deepStrictEqual);
const doesNotMatch = wrapFn(orig.doesNotMatch);
const doesNotReject = wrapFn(orig.doesNotReject);
const doesNotThrow = wrapFn(orig.doesNotThrow);
const equal = wrapFn(orig.equal);
const fail = wrapFn(orig.fail);
const ifError = wrapFn(orig.ifError);
const match = wrapFn(orig.match);
const notDeepEqual = wrapFn(orig.notDeepEqual);
const notDeepStrictEqual = wrapFn(orig.notDeepStrictEqual);
const notEqual = wrapFn(orig.notEqual);
const notStrictEqual = wrapFn(orig.notStrictEqual);
const ok = wrapFn(orig.ok);
const partialDeepStrictEqual = wrapFn(orig.partialDeepStrictEqual);
const rejects = wrapFn(orig.rejects);
const strictEqual = wrapFn(orig.strictEqual);
const throws = wrapFn(orig.throws);

const wrappedDefault = wrapFn(orig);
Object.assign(wrappedDefault, {
  Assert,
  AssertionError,
  CallTracker,
  deepEqual,
  deepStrictEqual,
  doesNotMatch,
  doesNotReject,
  doesNotThrow,
  equal,
  fail,
  ifError,
  match,
  notDeepEqual,
  notDeepStrictEqual,
  notEqual,
  notStrictEqual,
  ok,
  partialDeepStrictEqual,
  rejects,
  strictEqual,
  throws,
});
wrappedDefault.strict = ${url === INTERNAL_ASSERT_STRICT_URL ? 'wrappedDefault' : 'Object.assign(wrapFn(origStrict), { Assert, AssertionError, CallTracker, deepEqual: wrapFn(origStrict.deepEqual), deepStrictEqual: wrapFn(origStrict.deepStrictEqual), doesNotMatch: wrapFn(origStrict.doesNotMatch), doesNotReject: wrapFn(origStrict.doesNotReject), doesNotThrow: wrapFn(origStrict.doesNotThrow), equal: wrapFn(origStrict.equal), fail: wrapFn(origStrict.fail), ifError: wrapFn(origStrict.ifError), match: wrapFn(origStrict.match), notDeepEqual: wrapFn(origStrict.notDeepEqual), notDeepStrictEqual: wrapFn(origStrict.notDeepStrictEqual), notEqual: wrapFn(origStrict.notEqual), notStrictEqual: wrapFn(origStrict.notStrictEqual), ok: wrapFn(origStrict.ok), partialDeepStrictEqual: wrapFn(origStrict.partialDeepStrictEqual), rejects: wrapFn(origStrict.rejects), strictEqual: wrapFn(origStrict.strictEqual), throws: wrapFn(origStrict.throws) })'};
if (wrappedDefault.strict !== wrappedDefault) {
  wrappedDefault.strict.strict = wrappedDefault.strict;
  Object.freeze(wrappedDefault.strict);
}
Object.freeze(wrappedDefault);

const strict = wrappedDefault.strict;
export default wrappedDefault;
export {
  Assert,
  AssertionError,
  CallTracker,
  deepEqual,
  deepStrictEqual,
  doesNotMatch,
  doesNotReject,
  doesNotThrow,
  equal,
  fail,
  ifError,
  match,
  notDeepEqual,
  notDeepStrictEqual,
  notEqual,
  notStrictEqual,
  ok,
  partialDeepStrictEqual,
  rejects,
  strict,
  strictEqual,
  throws,
};
`,
      };
    }

    if (url === INTERNAL_TEST_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
import { getBridge } from '${INTERNAL_BRIDGE_URL}';
import wrappedStrict from '${INTERNAL_ASSERT_STRICT_URL}';

const bridge = getBridge();

function parseTestArgs(nameOrFn, optsOrFn, maybeFn) {
  let name = '';
  let opts = {};
  let fn = null;
  if (typeof nameOrFn === 'function') {
    fn = nameOrFn;
    name = fn.name || '<anonymous>';
  } else {
    name = String(nameOrFn ?? '');
    if (typeof optsOrFn === 'function') {
      fn = optsOrFn;
    } else {
      opts = optsOrFn && typeof optsOrFn === 'object' ? optsOrFn : {};
      fn = typeof maybeFn === 'function' ? maybeFn : null;
    }
  }
  return { name, opts, fn };
}

function register(nameOrFn, optsOrFn, maybeFn, modifier = null) {
  const { name, opts, fn } = parseTestArgs(nameOrFn, optsOrFn, maybeFn);
  bridge.registerTest({
    name,
    fn,
    skip: Boolean(opts.skip) || modifier === 'skip',
    todo: Boolean(opts.todo) || modifier === 'todo',
    only: Boolean(opts.only) || modifier === 'only',
    modifier,
  });
}

function test(nameOrFn, optsOrFn, maybeFn) {
  register(nameOrFn, optsOrFn, maybeFn, null);
}
test.skip = (a, b, c) => {
  bridge.onSkipAttempt('skip');
  register(a, b, c, 'skip');
};
test.todo = (a, b, c) => {
  bridge.onTodoAttempt('todo');
  register(a, b, c, 'todo');
};
test.only = (a, b, c) => register(a, b, c, 'only');

const it = (a, b, c) => register(a, b, c, null);
it.skip = test.skip;
it.todo = test.todo;
it.only = test.only;

const describe = (nameOrFn, optsOrFn, maybeFn) => {
  const { name, opts, fn } = parseTestArgs(nameOrFn, optsOrFn, maybeFn);
  if (opts.skip) bridge.onSkipAttempt('describe.skip');
  if (opts.todo) bridge.onTodoAttempt('describe.todo');
  if (typeof fn === 'function') {
    bridge.pushSuite(name);
    try {
      const res = fn();
      if (res && typeof res.then === 'function') {
        throw new Error('Async suite callbacks in describe() are not supported in hidden acceptance');
      }
    } finally {
      bridge.popSuite();
    }
  }
};
describe.skip = (a, b, c) => {
  bridge.onSkipAttempt('describe.skip');
  describe(a, b, c);
};
describe.todo = (a, b, c) => {
  bridge.onTodoAttempt('describe.todo');
  describe(a, b, c);
};

const suite = describe;
const before = (fn) => bridge.addHook('before', fn);
const after = (fn) => bridge.addHook('after', fn);
const beforeEach = (fn) => bridge.addHook('beforeEach', fn);
const afterEach = (fn) => bridge.addHook('afterEach', fn);

test.describe = describe;
test.suite = suite;
test.it = it;
test.before = before;
test.after = after;
test.beforeEach = beforeEach;
test.afterEach = afterEach;
test.assert = wrappedStrict;
test.test = test;

export default test;
export { test, it, describe, suite, before, after, beforeEach, afterEach };
`,
      };
    }

    return nextLoad(url, context);
  },
});

const bridgeModule = await import(INTERNAL_BRIDGE_URL);
bridgeModule.sealBridge({
  onAssertion() {
    assertionCount++;
  },
  onSkipAttempt() {
    skipAttempted = true;
  },
  onTodoAttempt() {
    todoAttempted = true;
  },
  pushSuite(name) {
    suiteStack.push(name);
  },
  popSuite() {
    suiteStack.pop();
  },
  registerTest(entry) {
    if (entry.skip) skipAttempted = true;
    if (entry.todo) todoAttempted = true;
    const prefix = suiteStack.length ? `${suiteStack.join(' > ')} > ` : '';
    registeredTests.push({
      ...entry,
      name: prefix ? `${prefix}${entry.name}` : entry.name,
    });
  },
  addHook(kind, fn) {
    if (typeof fn !== 'function') return;
    if (kind === 'before') beforeHooks.push(fn);
    else if (kind === 'after') afterHooks.push(fn);
    else if (kind === 'beforeEach') beforeEachHooks.push(fn);
    else if (kind === 'afterEach') afterEachHooks.push(fn);
  },
});

const wrappedStrictMod = await import(INTERNAL_ASSERT_STRICT_URL);
const wrappedStrictAssert = wrappedStrictMod.default;

function buildTestContext(pendingSubtests) {
  const ctx = {
    name: init.targetName,
    assert: wrappedStrictAssert,
    diagnostic(msg) {
      process.stderr.write(`# ${String(msg)}\n`);
    },
    skip() {
      skipAttempted = true;
      throw new Error('Test skip is forbidden in hidden acceptance');
    },
    todo() {
      todoAttempted = true;
      throw new Error('Test todo is forbidden in hidden acceptance');
    },
    async test(subName, optsOrFn, maybeFn) {
      let opts = {};
      let fn = null;
      if (typeof optsOrFn === 'function') {
        fn = optsOrFn;
      } else {
        opts = optsOrFn && typeof optsOrFn === 'object' ? optsOrFn : {};
        fn = typeof maybeFn === 'function' ? maybeFn : null;
      }
      if (opts.skip) {
        skipAttempted = true;
        throw new Error(`Subtest "${subName}" skip is forbidden`);
      }
      if (opts.todo) {
        todoAttempted = true;
        throw new Error(`Subtest "${subName}" todo is forbidden`);
      }
      if (typeof fn !== 'function') {
        throw new Error(`Subtest "${subName}" missing callback`);
      }
      const p = Promise.resolve().then(() => fn(buildTestContext(pendingSubtests)));
      pendingSubtests.add(p);
      try {
        await p;
      } finally {
        pendingSubtests.delete(p);
      }
    },
  };
  return Object.freeze(ctx);
}

const startedAt = Date.now();
let asyncError = null;
process.prependListener('uncaughtException', (err) => {
  if (!asyncError) asyncError = err instanceof Error ? err : new Error(String(err));
});
process.prependListener('unhandledRejection', (reason) => {
  if (!asyncError) asyncError = reason instanceof Error ? reason : new Error(String(reason));
});

realSend({
  type: 'test_start',
  testToken: init.testToken,
  testId: init.targetId,
  testIndex: init.targetIndex,
  testName: init.targetName,
});

try {
  await import(suiteUrl);

  if (skipAttempted || todoAttempted) {
    throw new Error('Skipped or todo test detected in hidden acceptance suite');
  }
  if (Number.isInteger(init.expectedCount) && registeredTests.length !== init.expectedCount) {
    throw new Error(
      `Registered test count mismatch (registered ${registeredTests.length} !== expected ${init.expectedCount})`,
    );
  }
  const target = registeredTests[init.targetIndex];
  if (!target) {
    throw new Error(
      `Expected test[${init.targetIndex}] "${init.targetName}" not registered (registered ${registeredTests.length})`,
    );
  }
  if (target.name !== init.targetName && !target.name.endsWith(` > ${init.targetName}`)) {
    throw new Error(
      `Test name mismatch at index ${init.targetIndex}: expected "${init.targetName}", got "${target.name}"`,
    );
  }
  if (typeof target.fn !== 'function') {
    throw new Error(`Test "${init.targetName}" has no test function`);
  }

  for (const hook of beforeHooks) await hook();
  for (const hook of beforeEachHooks) await hook();

  const pendingSubtests = new Set();
  const ctx = buildTestContext(pendingSubtests);
  let testErr = null;
  try {
    await target.fn(ctx);
    if (pendingSubtests.size > 0) {
      await Promise.all([...pendingSubtests]);
    }
  } catch (err) {
    testErr = err;
  } finally {
    for (const hook of afterEachHooks) {
      try {
        await hook();
      } catch (e) {
        if (!testErr) testErr = e;
      }
    }
    for (const hook of afterHooks) {
      try {
        await hook();
      } catch (e) {
        if (!testErr) testErr = e;
      }
    }
  }

  if (testErr) throw testErr;
  if (asyncError) throw asyncError;
  if (skipAttempted || todoAttempted) {
    throw new Error('Test skip or todo called during hidden acceptance execution');
  }
  const minAssertions = Number.isInteger(init.minAssertions) ? init.minAssertions : 1;
  if (assertionCount < minAssertions) {
    throw new Error(
      `Insufficient assertions in hidden acceptance test "${init.targetName}" (${assertionCount} < ${minAssertions})`,
    );
  }

  realSend({
    type: 'test_end',
    testToken: init.testToken,
    testId: init.targetId,
    testIndex: init.targetIndex,
    testName: init.targetName,
    started: true,
    completed: true,
    passed: true,
    skipped: false,
    todo: false,
    assertionCount,
    durationMs: Date.now() - startedAt,
    registeredTestCount: registeredTests.length,
  });
  process.exit(0);
} catch (err) {
  realSend({
    type: 'test_end',
    testToken: init.testToken,
    testId: init.targetId,
    testIndex: init.targetIndex,
    testName: init.targetName,
    started: true,
    completed: true,
    passed: false,
    skipped: skipAttempted,
    todo: todoAttempted,
    assertionCount,
    durationMs: Date.now() - startedAt,
    reason: skipAttempted
      ? 'skipped_test'
      : todoAttempted
        ? 'todo_test'
        : err?.message?.includes('Registered test count mismatch')
          ? 'registered_test_count_mismatch'
          : err?.message?.includes('Insufficient assertions')
            ? 'insufficient_assertions'
            : 'assertion_failed',
    error: err?.stack ?? err?.message ?? String(err),
  });
  process.stderr.write(`${err?.stack ?? err?.message ?? String(err)}\n`);
  process.exit(1);
}
