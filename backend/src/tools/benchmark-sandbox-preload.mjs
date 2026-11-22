import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const origRealpathNative =
  typeof fs.realpathSync?.native === 'function' ? fs.realpathSync.native : fs.realpathSync;
const origStatSync = fs.statSync;
const origDefineProperty = Object.defineProperty;
const origGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const origObjectKeys = Object.keys;
const origFreeze = Object.freeze;
const origCpuUsage = process.cpuUsage.bind(process);
const origExit = process.exit.bind(process);
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origSetInterval = globalThis.setInterval.bind(globalThis);
const capturedProcessExecPath = process.execPath;
const capturedCwd = process.cwd.bind(process);

// Trigger lazy stdio stream initialization (which internally instantiates net.Socket for fd 0/1/2)
// BEFORE locking node:net.
try {
  void process.stdout;
  void process.stderr;
  void process.stdin;
} catch {
  // ignore if stdio handle is unavailable
}

const rawConfigJson = process.env.AGENT_US_SANDBOX_CONFIG;
delete process.env.AGENT_US_SANDBOX_CONFIG;

if (!rawConfigJson) {
  origStderrWrite('[sandbox] Missing AGENT_US_SANDBOX_CONFIG\n');
  origExit(126);
}

let parsedConfig;
try {
  parsedConfig = JSON.parse(rawConfigJson);
} catch (err) {
  origStderrWrite(`[sandbox] Invalid AGENT_US_SANDBOX_CONFIG: ${err?.message ?? err}\n`);
  origExit(126);
}

function stripWinExtendedPrefix(p) {
  if (process.platform === 'win32' && typeof p === 'string') {
    if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
    if (p.startsWith('\\\\?\\')) return p.slice(4);
  }
  return p;
}

function normalizeForCmp(p) {
  const cleaned = stripWinExtendedPrefix(String(p ?? ''));
  const resolved = path.resolve(cleaned);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function trimTrailingSep(p) {
  if (!p) return p;
  if (process.platform === 'win32') {
    if (/^[a-z]:\\$/i.test(p)) return p;
    return p.replace(/[\\/]+$/, '');
  }
  return p === '/' ? p : p.replace(/\/+$/, '');
}

function isInsideRoot(rootPath, candidatePath, allowEqual = true) {
  const normRoot = trimTrailingSep(normalizeForCmp(rootPath));
  const normCandidate = trimTrailingSep(normalizeForCmp(candidatePath));
  if (!normRoot || !normCandidate) return false;
  if (normCandidate === normRoot) return Boolean(allowEqual);
  const prefix = normRoot.endsWith(path.sep) ? normRoot : `${normRoot}${path.sep}`;
  return normCandidate.startsWith(prefix);
}

function safeRealpath(targetPath) {
  try {
    return stripWinExtendedPrefix(origRealpathNative(String(targetPath)));
  } catch {
    return null;
  }
}

const config = origFreeze({
  workspaceRoot: parsedConfig.workspaceRoot
    ? stripWinExtendedPrefix(String(parsedConfig.workspaceRoot))
    : '',
  workspaceReadOnly: Boolean(parsedConfig.workspaceReadOnly),
  allowWorkspaceNodeCli: Boolean(parsedConfig.allowWorkspaceNodeCli),
  nodeExecPath: parsedConfig.nodeExecPath
    ? stripWinExtendedPrefix(String(parsedConfig.nodeExecPath))
    : stripWinExtendedPrefix(capturedProcessExecPath),
  cpuLimitMs:
    Number.isFinite(parsedConfig.cpuLimitMs) && parsedConfig.cpuLimitMs > 0
      ? Number(parsedConfig.cpuLimitMs)
      : null,
  maxChildSpawns:
    Number.isInteger(parsedConfig.maxChildSpawns) && parsedConfig.maxChildSpawns >= 0
      ? parsedConfig.maxChildSpawns
      : 32,
  grandchildNodeFlags: origFreeze(
    Array.isArray(parsedConfig.grandchildNodeFlags)
      ? parsedConfig.grandchildNodeFlags.map(String)
      : [],
  ),
  grandchildBaseEnv:
    parsedConfig.grandchildBaseEnv && typeof parsedConfig.grandchildBaseEnv === 'object'
      ? origFreeze({ ...parsedConfig.grandchildBaseEnv })
      : origFreeze({}),
  grandchildConfigJson:
    typeof parsedConfig.grandchildConfigJson === 'string'
      ? parsedConfig.grandchildConfigJson
      : '',
});

function makeSandboxError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function makeBlockedStub(code, message) {
  return function sandboxBlockedStub() {
    throw makeSandboxError(code, message);
  };
}

// 1. Lock ALL network built-in modules & global network APIs
let insideAllowedSpawn = false;
const origNetSocket = require('node:net').Socket;

const NETWORK_MODULES = [
  'node:net',
  'node:tls',
  'node:http',
  'node:https',
  'node:http2',
  'node:dgram',
  'node:dns',
  'node:dns/promises',
];

for (const modName of NETWORK_MODULES) {
  const mod = require(modName);
  for (const key of origObjectKeys(mod)) {
    const desc = origGetOwnPropertyDescriptor(mod, key);
    if (!desc || !desc.configurable) continue;
    if (modName === 'node:dns' && key === 'promises') continue;
    if (modName === 'node:net' && key === 'Socket' && config.allowWorkspaceNodeCli) {
      origDefineProperty(mod, key, {
        value: function sandboxedNetSocket(...socketArgs) {
          const opts = socketArgs[0];
          if (
            insideAllowedSpawn &&
            opts &&
            typeof opts === 'object' &&
            ('handle' in opts || 'fd' in opts)
          ) {
            return Reflect.construct(origNetSocket, socketArgs, new.target || origNetSocket);
          }
          throw makeSandboxError(
            'ERR_SANDBOX_NETWORK_BLOCKED',
            'Network API node:net.Socket is blocked in benchmark sandbox',
          );
        },
        writable: false,
        configurable: false,
        enumerable: desc.enumerable,
      });
      continue;
    }
    if (key === 'globalAgent') {
      const blockedAgent = origFreeze({
        createConnection: makeBlockedStub(
          'ERR_SANDBOX_NETWORK_BLOCKED',
          `Network access via ${modName}.globalAgent is blocked in benchmark sandbox`,
        ),
        addRequest: makeBlockedStub(
          'ERR_SANDBOX_NETWORK_BLOCKED',
          `Network access via ${modName}.globalAgent is blocked in benchmark sandbox`,
        ),
        destroy: function noop() {},
      });
      origDefineProperty(mod, key, {
        value: blockedAgent,
        writable: false,
        configurable: false,
        enumerable: desc.enumerable,
      });
      continue;
    }
    let val;
    try {
      val = 'value' in desc ? desc.value : mod[key];
    } catch {
      continue;
    }
    if (typeof val === 'function') {
      origDefineProperty(mod, key, {
        value: makeBlockedStub(
          'ERR_SANDBOX_NETWORK_BLOCKED',
          `Network API ${modName}.${key} is blocked in benchmark sandbox`,
        ),
        writable: false,
        configurable: false,
        enumerable: desc.enumerable,
      });
    }
  }
}

for (const globalName of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
  const desc = origGetOwnPropertyDescriptor(globalThis, globalName);
  if (!desc || desc.configurable) {
    origDefineProperty(globalThis, globalName, {
      value: makeBlockedStub(
        'ERR_SANDBOX_NETWORK_BLOCKED',
        `Global network API "${globalName}" is blocked in benchmark sandbox`,
      ),
      writable: false,
      configurable: false,
      enumerable: desc ? desc.enumerable : true,
    });
  }
}

// 2. Block worker_threads.Worker
const workerThreads = require('node:worker_threads');
const wtWorkerDesc = origGetOwnPropertyDescriptor(workerThreads, 'Worker');
if (!wtWorkerDesc || wtWorkerDesc.configurable) {
  origDefineProperty(workerThreads, 'Worker', {
    value: makeBlockedStub(
      'ERR_SANDBOX_WORKER_BLOCKED',
      'Worker threads are blocked in benchmark sandbox',
    ),
    writable: false,
    configurable: false,
    enumerable: true,
  });
}

// 3. Capture child_process primitives BEFORE wrapping process.binding / process._linkedBinding
const cp = require('node:child_process');
const origSpawn = cp.spawn;
const origSpawnSync = cp.spawnSync;
const origExecFile = cp.execFile;
const origExecFileSync = cp.execFileSync;
const origChildProtoSpawn = cp.ChildProcess?.prototype?.spawn;

// 4. Wrap process.binding, process._linkedBinding, and disable process.dlopen
const origBinding = typeof process.binding === 'function' ? process.binding : null;
const origLinkedBinding =
  typeof process._linkedBinding === 'function' ? process._linkedBinding : null;

const NETWORK_BINDINGS = new Set([
  'tcp_wrap',
  'udp_wrap',
  'cares_wrap',
  'tls_wrap',
  'http_parser',
  'quic',
]);

const BLOCKED_BINDINGS = new Set([
  'pipe_wrap',
  'spawn_sync',
  'process_wrap',
  'worker',
  'inspector',
]);

function checkBindingAllowed(name) {
  const key = String(name ?? '');
  if (NETWORK_BINDINGS.has(key)) {
    throw makeSandboxError(
      'ERR_SANDBOX_NETWORK_BLOCKED',
      `Native network binding "${key}" is blocked in benchmark sandbox`,
    );
  }
  if (BLOCKED_BINDINGS.has(key)) {
    throw makeSandboxError(
      'ERR_SANDBOX_BINDING_BLOCKED',
      `Native binding "${key}" is blocked in benchmark sandbox`,
    );
  }
}

if (origBinding) {
  const wrappedBinding = function binding(name) {
    checkBindingAllowed(name);
    return origBinding.call(process, name);
  };
  origDefineProperty(process, 'binding', {
    value: wrappedBinding,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

if (origLinkedBinding) {
  const wrappedLinkedBinding = function _linkedBinding(name) {
    checkBindingAllowed(name);
    return origLinkedBinding.call(process, name);
  };
  origDefineProperty(process, '_linkedBinding', {
    value: wrappedLinkedBinding,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

origDefineProperty(process, 'dlopen', {
  value: makeBlockedStub(
    'ERR_SANDBOX_BINDING_BLOCKED',
    'Native addon loading via process.dlopen is blocked in benchmark sandbox',
  ),
  writable: false,
  configurable: false,
  enumerable: true,
});

// 5. Lock node:child_process
const FORBIDDEN_GRANDCHILD_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_PATH',
  'NODE_DEBUG',
  'NODE_DEBUG_NATIVE',
  'NODE_REPL_HISTORY',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_DEBUG',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'BASH_ENV',
  'ENV',
  'CDPATH',
  'IFS',
  'PS4',
  'PROMPT_COMMAND',
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMP',
  'TEMP',
  'TMPDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'NO_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'GIT_TERMINAL_PROMPT',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'AGENT_US_SANDBOX_CONFIG',
]);

const SENSITIVE_KEY_RE =
  /(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|AUTH|COOKIE|BEARER)/i;

function buildGrandchildEnv(baseEnv, requestedEnv, grandchildConfigJson) {
  const env = { ...baseEnv };
  if (requestedEnv && typeof requestedEnv === 'object') {
    for (const [k, v] of Object.entries(requestedEnv)) {
      if (v === undefined || v === null) continue;
      const upper = String(k).toUpperCase();
      if (
        FORBIDDEN_GRANDCHILD_ENV_KEYS.has(upper) ||
        upper.startsWith('NPM_CONFIG_') ||
        upper.startsWith('LD_') ||
        upper.startsWith('DYLD_') ||
        SENSITIVE_KEY_RE.test(k)
      ) {
        continue;
      }
      const str = String(v);
      if (str.includes('\0') || str.includes('\r') || str.includes('\n')) continue;
      env[k] = str;
    }
  }
  for (const [k, v] of Object.entries(baseEnv)) {
    env[k] = v;
  }
  env.AGENT_US_SANDBOX_CONFIG = grandchildConfigJson;
  return env;
}

function isAllowedNodeFile(file) {
  if (typeof file !== 'string' || !file) return false;
  if (file === 'node') return true;
  if (process.platform === 'win32' && file.toLowerCase() === 'node.exe') return true;
  const cmpFile = normalizeForCmp(file);
  if (
    cmpFile === normalizeForCmp(config.nodeExecPath) ||
    cmpFile === normalizeForCmp(capturedProcessExecPath)
  ) {
    return true;
  }
  const realFile = safeRealpath(file);
  if (!realFile) return false;
  return normalizeForCmp(realFile) === normalizeForCmp(config.nodeExecPath);
}

let childSpawnCount = 0;

function prepareWorkspaceNodeCliCall(file, args, options) {
  if (!isAllowedNodeFile(file)) {
    throw makeSandboxError(
      'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
      `Spawning non-node executable "${String(file)}" is blocked in benchmark sandbox`,
    );
  }
  if (options !== undefined && options !== null && typeof options !== 'object') {
    throw makeSandboxError(
      'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
      'Invalid child_process options',
    );
  }
  if (options?.shell) {
    throw makeSandboxError(
      'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
      'Shell spawning via child_process is blocked in benchmark sandbox',
    );
  }
  if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== 'string' || !args[0]) {
    throw makeSandboxError(
      'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
      'Only workspace Node CLI script files are allowed in child_process',
    );
  }
  if (args[0].startsWith('-')) {
    throw makeSandboxError(
      'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
      `Node CLI flags such as "${args[0]}" are blocked in child_process`,
    );
  }

  let rawCwd = options?.cwd ?? capturedCwd();
  if (rawCwd instanceof URL) {
    rawCwd = fileURLToPath(rawCwd);
  }
  const canonicalCwd = safeRealpath(String(rawCwd));
  if (!canonicalCwd || !isInsideRoot(config.workspaceRoot, canonicalCwd, true)) {
    throw makeSandboxError(
      'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
      'child_process cwd must remain confined inside workspaceRoot',
    );
  }

  const resolvedArg0 = path.resolve(canonicalCwd, args[0]);
  const canonicalScript = safeRealpath(resolvedArg0);
  if (!canonicalScript) {
    throw makeSandboxError(
      'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
      `Workspace CLI script does not exist or is outside sandbox permissions: ${args[0]}`,
    );
  }
  if (!/\.(?:js|mjs|cjs)$/i.test(canonicalScript)) {
    throw makeSandboxError(
      'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
      `Workspace CLI script must end with .js, .mjs, or .cjs: ${args[0]}`,
    );
  }

  let st;
  try {
    st = origStatSync(canonicalScript);
  } catch {
    st = null;
  }
  if (!st || !st.isFile()) {
    throw makeSandboxError(
      'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
      `Workspace CLI script target is not a regular file: ${args[0]}`,
    );
  }
  if (!isInsideRoot(config.workspaceRoot, canonicalScript, false)) {
    throw makeSandboxError(
      'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
      `Workspace CLI script escapes workspaceRoot: ${args[0]}`,
    );
  }
  const relParts = path.relative(config.workspaceRoot, canonicalScript).split(/[\\/]/);
  if (relParts.some((seg) => seg.toLowerCase() === '.git')) {
    throw makeSandboxError(
      'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
      'Executing scripts inside .git is blocked in benchmark sandbox',
    );
  }

  if (childSpawnCount >= config.maxChildSpawns) {
    throw makeSandboxError(
      'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
      `Exceeded maximum child_process spawn count (${config.maxChildSpawns})`,
    );
  }
  childSpawnCount++;

  const grandchildArgs = [
    ...config.grandchildNodeFlags,
    canonicalScript,
    ...args.slice(1).map((item) => String(item)),
  ];
  const grandchildEnv = buildGrandchildEnv(
    config.grandchildBaseEnv,
    options?.env,
    config.grandchildConfigJson,
  );
  const grandchildOptions = {
    ...(options || {}),
    cwd: canonicalCwd,
    env: grandchildEnv,
    shell: false,
    windowsHide: true,
  };

  return {
    execPath: config.nodeExecPath,
    args: grandchildArgs,
    options: grandchildOptions,
  };
}

function lockCpProp(name, fn) {
  origDefineProperty(cp, name, {
    value: fn,
    writable: false,
    configurable: false,
    enumerable: true,
  });
}

function parseSpawnOverload(file, argsOrOpts, maybeOpts) {
  if (Array.isArray(argsOrOpts)) {
    return { args: argsOrOpts, options: maybeOpts };
  }
  if (argsOrOpts !== undefined && argsOrOpts !== null && typeof argsOrOpts === 'object') {
    return { args: [], options: argsOrOpts };
  }
  if (argsOrOpts === undefined) {
    return { args: [], options: maybeOpts };
  }
  throw makeSandboxError('ERR_SANDBOX_CHILD_PROCESS_BLOCKED', 'Invalid child_process arguments');
}

function parseExecFileOverload(file, argsOrOptsOrCb, optsOrCb, maybeCb) {
  let args = [];
  let options;
  let callback;

  if (typeof argsOrOptsOrCb === 'function') {
    callback = argsOrOptsOrCb;
  } else if (Array.isArray(argsOrOptsOrCb)) {
    args = argsOrOptsOrCb;
    if (typeof optsOrCb === 'function') {
      callback = optsOrCb;
    } else {
      options = optsOrCb;
      if (typeof maybeCb === 'function') callback = maybeCb;
    }
  } else if (argsOrOptsOrCb !== undefined && argsOrOptsOrCb !== null && typeof argsOrOptsOrCb === 'object') {
    options = argsOrOptsOrCb;
    if (typeof optsOrCb === 'function') callback = optsOrCb;
  } else if (argsOrOptsOrCb !== undefined) {
    throw makeSandboxError('ERR_SANDBOX_CHILD_PROCESS_BLOCKED', 'Invalid execFile arguments');
  }

  return { args, options, callback };
}

for (const alwaysBlocked of ['exec', 'execSync', 'fork', '_forkChild']) {
  if (alwaysBlocked in cp) {
    lockCpProp(
      alwaysBlocked,
      makeBlockedStub(
        'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
        `child_process.${alwaysBlocked} is blocked in benchmark sandbox`,
      ),
    );
  }
}

if (!config.allowWorkspaceNodeCli) {
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'ChildProcess']) {
    if (name in cp) {
      lockCpProp(
        name,
        makeBlockedStub(
          'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
          `child_process.${name} is blocked in benchmark sandbox`,
        ),
      );
    }
  }
} else {
  if (typeof origChildProtoSpawn === 'function' && cp.ChildProcess?.prototype) {
    origDefineProperty(cp.ChildProcess.prototype, 'spawn', {
      value: function guardedProtoSpawn(opts) {
        if (!insideAllowedSpawn) {
          throw makeSandboxError(
            'ERR_SANDBOX_CHILD_PROCESS_BLOCKED',
            'Direct ChildProcess.prototype.spawn calls are blocked in benchmark sandbox',
          );
        }
        return origChildProtoSpawn.call(this, opts);
      },
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }

  lockCpProp('spawn', function sandboxedSpawn(file, argsOrOpts, maybeOpts) {
    const { args, options } = parseSpawnOverload(file, argsOrOpts, maybeOpts);
    const prepared = prepareWorkspaceNodeCliCall(file, args, options);
    insideAllowedSpawn = true;
    try {
      return origSpawn(prepared.execPath, prepared.args, prepared.options);
    } finally {
      insideAllowedSpawn = false;
    }
  });

  lockCpProp('spawnSync', function sandboxedSpawnSync(file, argsOrOpts, maybeOpts) {
    const { args, options } = parseSpawnOverload(file, argsOrOpts, maybeOpts);
    const prepared = prepareWorkspaceNodeCliCall(file, args, options);
    return origSpawnSync(prepared.execPath, prepared.args, prepared.options);
  });

  const wrappedExecFile = function sandboxedExecFile(file, argsOrOptsOrCb, optsOrCb, maybeCb) {
    const { args, options, callback } = parseExecFileOverload(
      file,
      argsOrOptsOrCb,
      optsOrCb,
      maybeCb,
    );
    const prepared = prepareWorkspaceNodeCliCall(file, args, options);
    insideAllowedSpawn = true;
    try {
      return callback
        ? origExecFile(prepared.execPath, prepared.args, prepared.options, callback)
        : origExecFile(prepared.execPath, prepared.args, prepared.options);
    } finally {
      insideAllowedSpawn = false;
    }
  };
  origDefineProperty(wrappedExecFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: function promisifiedSandboxedExecFile(file, ...rest) {
      let childRef;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        childRef = wrappedExecFile(file, ...rest, (err, stdout, stderr) => {
          if (err) {
            err.stdout = stdout;
            err.stderr = stderr;
            rejectPromise(err);
          } else {
            resolvePromise({ stdout, stderr });
          }
        });
      });
      promise.child = childRef;
      return promise;
    },
    writable: false,
    configurable: false,
    enumerable: false,
  });
  lockCpProp('execFile', wrappedExecFile);

  lockCpProp('execFileSync', function sandboxedExecFileSync(file, argsOrOpts, maybeOpts) {
    const { args, options } = parseSpawnOverload(file, argsOrOpts, maybeOpts);
    const prepared = prepareWorkspaceNodeCliCall(file, args, options);
    return origExecFileSync(prepared.execPath, prepared.args, prepared.options);
  });
}

syncBuiltinESMExports();

// 6. CPU watchdog interval (.unref() so it never keeps process alive)
if (config.cpuLimitMs !== null) {
  const startUsage = origCpuUsage();
  const intervalMs = Math.min(100, Math.max(25, Math.floor(config.cpuLimitMs / 4)));
  const timer = origSetInterval(() => {
    const cur = origCpuUsage(startUsage);
    const elapsedCpuMs = (cur.user + cur.system) / 1000;
    if (elapsedCpuMs >= config.cpuLimitMs) {
      try {
        origStderrWrite('\n[sandbox] ERR_SANDBOX_CPU_LIMIT\n');
      } catch {
        // ignore write errors during forced exit
      }
      origExit(137);
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}
