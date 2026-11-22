import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix as posixPath,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertCommandAllowedByDependencyPolicy,
  DEFAULT_DEPENDENCY_POLICY,
  validateDependencyPolicy,
} from '../evaluation/dependency-policy.js';

export const SANDBOX_MODES = Object.freeze({
  AUTO: 'auto',
  DOCKER: 'docker',
  NODE_PERMISSION: 'node-permission',
});

export const STRICT_ENV_ALLOWLIST_BASE = Object.freeze([
  'PATH',
  ...(process.platform === 'win32'
    ? [
        'SYSTEMROOT',
        'WINDIR',
        'PATHEXT',
        'OS',
        'PROCESSOR_ARCHITECTURE',
        'NUMBER_OF_PROCESSORS',
      ]
    : []),
]);

export class SandboxUnavailableError extends Error {
  constructor(message, detail = undefined) {
    super(message);
    this.name = 'SandboxUnavailableError';
    this.code = 'E_SANDBOX_UNAVAILABLE';
    if (detail !== undefined) this.detail = detail;
  }
}

export class SandboxPolicyError extends Error {
  constructor(message, codeOrDetail = 'E_SANDBOX_POLICY_VIOLATION', detail = undefined) {
    super(message);
    this.name = 'SandboxPolicyError';
    if (typeof codeOrDetail === 'string') {
      this.code = codeOrDetail;
      if (detail !== undefined) this.detail = detail;
    } else if (codeOrDetail && typeof codeOrDetail === 'object') {
      this.code = codeOrDetail.code || 'E_SANDBOX_POLICY_VIOLATION';
      this.detail = codeOrDetail;
    } else {
      this.code = 'E_SANDBOX_POLICY_VIOLATION';
    }
  }
}

const realpathNativeFn =
  typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync;

function stripWinExtendedPrefix(p) {
  if (process.platform === 'win32' && typeof p === 'string') {
    if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
    if (p.startsWith('\\\\?\\')) return p.slice(4);
  }
  return p;
}

function findNearestExistingAncestor(targetPath) {
  let cur = resolve(targetPath);
  while (true) {
    try {
      lstatSync(cur);
      return cur;
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
        return null;
      }
      const parent = dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

/**
 * Canonicalizes a filesystem path via `realpathSync.native`, stripping any
 * Windows `\\?\` prefix and resolving nearest existing ancestors for new paths.
 */
export function nativeRealpath(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new SandboxPolicyError('Path must be a non-empty string', 'E_SANDBOX_PATH_ESCAPE');
  }
  let cur = resolve(targetPath);
  for (let hop = 0; hop < 16; hop++) {
    try {
      return stripWinExtendedPrefix(realpathNativeFn(cur));
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
        throw err;
      }
      let lst = null;
      try {
        lst = lstatSync(cur);
      } catch {
        lst = null;
      }
      if (lst && lst.isSymbolicLink()) {
        const rawTarget = stripWinExtendedPrefix(readlinkSync(cur));
        cur = isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(dirname(cur), rawTarget);
        continue;
      }
      const anc = findNearestExistingAncestor(cur);
      if (!anc) return stripWinExtendedPrefix(cur);
      try {
        const ancLst = lstatSync(anc);
        if (ancLst.isSymbolicLink()) {
          const rawTarget = stripWinExtendedPrefix(readlinkSync(anc));
          const resolvedAnc = isAbsolute(rawTarget)
            ? resolve(rawTarget)
            : resolve(dirname(anc), rawTarget);
          const suffix = relative(anc, cur);
          cur = suffix ? resolve(resolvedAnc, suffix) : resolvedAnc;
          continue;
        }
        const realAnc = stripWinExtendedPrefix(realpathNativeFn(anc));
        const suffix = relative(anc, cur);
        return stripWinExtendedPrefix(suffix ? join(realAnc, suffix) : realAnc);
      } catch {
        return stripWinExtendedPrefix(cur);
      }
    }
  }
  throw new SandboxPolicyError(`Symlink resolution exceeded depth limit: ${targetPath}`, 'E_SANDBOX_SYMLINK_ESCAPE');
}

function normalizeForComparison(canonicalPath) {
  let normalized = stripWinExtendedPrefix(String(canonicalPath));
  if (process.platform === 'win32') {
    if (!/^[a-z]:\\$/i.test(normalized) && !/^\\\\[^\\]+\\[^\\]+\\?$/i.test(normalized)) {
      normalized = normalized.replace(/[\\/]+$/, '');
    }
    return normalized.toLowerCase();
  }
  if (normalized !== '/') {
    normalized = normalized.replace(/\/+$/, '');
  }
  return normalized;
}

/**
 * Checks whether `candidatePath` resides inside `rootPath` after native realpath
 * canonicalization (case-insensitive on `win32`).
 */
export function isPathInsideRoot(rootPath, candidatePath, { allowEqual = true } = {}) {
  const realRoot = normalizeForComparison(nativeRealpath(rootPath));
  const realCandidate = normalizeForComparison(nativeRealpath(candidatePath));
  if (realCandidate === realRoot) return Boolean(allowEqual);
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  return realCandidate.startsWith(prefix);
}

const PRELOAD_FILE_PATH = nativeRealpath(
  fileURLToPath(new URL('./benchmark-sandbox-preload.mjs', import.meta.url)),
);
const PRELOAD_FILE_URL = pathToFileURL(PRELOAD_FILE_PATH).href;

const FORBIDDEN_EXTRA_ENV_KEYS = new Set([
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
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_PARAMETERS',
  'GIT_EXTERNAL_DIFF',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SSLKEYLOGFILE',
  'AGENT_US_SANDBOX_CONFIG',
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
  'GIT_ALLOW_PROTOCOL',
]);

const SENSITIVE_ENV_KEY_RE =
  /(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|AUTH|COOKIE|BEARER|SIGNING_KEY)/i;

const SENSITIVE_ENV_PREFIX_RE =
  /^(?:AWS_|GCP_|GOOGLE_|AZURE_|OPENAI_|ANTHROPIC_|DEEPSEEK_|GITHUB_|GH_|NPM_|PYPI_|DOCKER_|KUBE|SSH_)/i;

const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /sk-ant-[A-Za-z0-9_-]{12,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  /^Bearer\s+[A-Za-z0-9._-]{16,}$/i,
  /npm_[A-Za-z0-9]{20,}/,
];

function lookupEnvCaseInsensitive(sourceEnv, targetKey) {
  if (!sourceEnv || typeof sourceEnv !== 'object') return undefined;
  if (sourceEnv[targetKey] !== undefined) return sourceEnv[targetKey];
  if (process.platform !== 'win32') return undefined;
  const upper = targetKey.toUpperCase();
  for (const [k, v] of Object.entries(sourceEnv)) {
    if (k.toUpperCase() === upper && v !== undefined) return v;
  }
  return undefined;
}

function validateExtraEnv(extraEnv) {
  if (!extraEnv || typeof extraEnv !== 'object' || Array.isArray(extraEnv)) {
    throw new SandboxPolicyError('extraEnv must be a plain object', 'E_SANDBOX_ENV_VIOLATION');
  }
  const validated = {};
  for (const [rawKey, rawVal] of Object.entries(extraEnv)) {
    if (rawVal === undefined || rawVal === null) continue;
    const key = String(rawKey);
    const upper = key.toUpperCase();
    if (!key || key.includes('\0') || key.includes('=') || /[\r\n]/.test(key)) {
      throw new SandboxPolicyError(`Invalid env key "${key}"`, 'E_SANDBOX_ENV_VIOLATION');
    }
    if (
      FORBIDDEN_EXTRA_ENV_KEYS.has(upper) ||
      upper.startsWith('NPM_CONFIG_') ||
      upper.startsWith('LD_') ||
      upper.startsWith('DYLD_') ||
      SENSITIVE_ENV_KEY_RE.test(key) ||
      SENSITIVE_ENV_PREFIX_RE.test(key)
    ) {
      throw new SandboxPolicyError(
        `Forbidden or sensitive env key in sandbox extraEnv: "${key}"`,
        'E_SANDBOX_ENV_VIOLATION',
        { key },
      );
    }
    const val = String(rawVal);
    if (val.includes('\0') || /[\r\n]/.test(val)) {
      throw new SandboxPolicyError(
        `Invalid control characters in sandbox extraEnv value for "${key}"`,
        'E_SANDBOX_ENV_VIOLATION',
        { key },
      );
    }
    if (SECRET_VALUE_PATTERNS.some((re) => re.test(val))) {
      throw new SandboxPolicyError(
        `Potential secret value detected in sandbox extraEnv for "${key}"`,
        'E_SANDBOX_ENV_VIOLATION',
        { key },
      );
    }
    validated[key] = val;
  }
  return validated;
}

/**
 * Constructs a strict sandbox environment from `{}` (never spreading `process.env`).
 */
export function buildStrictSandboxEnv({
  tmpDir,
  extraEnv = {},
  sourceEnv = process.env,
} = {}) {
  const canonicalTmp = nativeRealpath(tmpDir ?? tmpdir());
  const validatedExtra = validateExtraEnv(extraEnv);
  const env = {};

  for (const allowedKey of STRICT_ENV_ALLOWLIST_BASE) {
    if (process.platform !== 'win32' && allowedKey !== 'PATH') continue;
    const val = lookupEnvCaseInsensitive(sourceEnv, allowedKey);
    if (val !== undefined) {
      env[allowedKey] = String(val);
    }
  }

  env.HOME = canonicalTmp;
  env.USERPROFILE = canonicalTmp;
  env.TMP = canonicalTmp;
  env.TEMP = canonicalTmp;
  env.TMPDIR = canonicalTmp;
  env.APPDATA = join(canonicalTmp, 'appdata');
  env.LOCALAPPDATA = join(canonicalTmp, 'localappdata');
  env.TZ = 'UTC';
  env.LANG = 'C.UTF-8';
  env.LC_ALL = 'C.UTF-8';
  env.NODE_ENV = 'test';
  env.CI = 'true';
  env.NPM_CONFIG_OFFLINE = 'true';
  env.NPM_CONFIG_AUDIT = 'false';
  env.NPM_CONFIG_FUND = 'false';
  env.NPM_CONFIG_IGNORE_SCRIPTS = 'true';
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  env.HTTP_PROXY = 'http://127.0.0.1:0';
  env.HTTPS_PROXY = 'http://127.0.0.1:0';
  env.ALL_PROXY = 'http://127.0.0.1:0';
  env.http_proxy = 'http://127.0.0.1:0';
  env.https_proxy = 'http://127.0.0.1:0';
  env.all_proxy = 'http://127.0.0.1:0';

  for (const [k, v] of Object.entries(validatedExtra)) {
    env[k] = v;
  }
  return env;
}

let cachedEmptyHooksDir = null;
let exitHookRegistered = false;

function ensureEmptyHooksDir() {
  if (cachedEmptyHooksDir && existsSync(cachedEmptyHooksDir)) {
    try {
      if (readdirSync(cachedEmptyHooksDir).length === 0) {
        return cachedEmptyHooksDir;
      }
    } catch {
      // recreate below
    }
  }
  cachedEmptyHooksDir = nativeRealpath(
    mkdtempSync(join(tmpdir(), 'agent-us-empty-hooks-')),
  );
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once('exit', () => {
      if (cachedEmptyHooksDir) {
        try {
          rmSync(cachedEmptyHooksDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    });
  }
  return cachedEmptyHooksDir;
}

/**
 * Builds a strict allowlist environment for hardened git execution.
 */
export function buildGitAllowlistEnv({
  tmpDir,
  allowNetwork = false,
  extraEnv = {},
  sourceEnv = process.env,
} = {}) {
  const env = buildStrictSandboxEnv({ tmpDir, extraEnv, sourceEnv });
  if (allowNetwork) {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.ALL_PROXY;
    delete env.http_proxy;
    delete env.https_proxy;
    delete env.all_proxy;
    delete env.NO_PROXY;
    delete env.no_proxy;
    env.GIT_ALLOW_PROTOCOL = 'https:http:file';
  } else {
    env.GIT_ALLOW_PROTOCOL = 'file';
  }
  return env;
}

/**
 * Prepends cross-platform hardened git configuration flags using a dedicated
 * empty hooks directory, disabling fsmonitor and ext:: protocol handlers.
 */
export function getHardenedGitArgs(gitArgs = [], { emptyHooksDir = null } = {}) {
  const args = Array.isArray(gitArgs) ? gitArgs.map((a) => String(a)) : [];
  const hooksDir = emptyHooksDir ? nativeRealpath(emptyHooksDir) : ensureEmptyHooksDir();
  return [
    '-c',
    `core.hooksPath=${hooksDir}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'protocol.ext.allow=never',
    ...args,
  ];
}

const NETWORK_GIT_SUBCOMMANDS = new Set([
  'fetch',
  'pull',
  'push',
  'ls-remote',
  'send-email',
  'request-pull',
]);

const REMOTE_URI_RE = /^(?:https?:\/\/|ssh:\/\/|git:\/\/|ftp:\/\/|ext::|[^/\\@:\s]+@[^/\\:\s]+:)/i;

function findGitSubcommandInfo(gitArgs) {
  let subcommand = null;
  const positionals = [];
  for (let i = 0; i < gitArgs.length; i++) {
    const arg = String(gitArgs[i]);
    if (arg === '--') {
      positionals.push(...gitArgs.slice(i + 1).map(String));
      break;
    }
    if (!subcommand) {
      if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace') {
        i++;
        continue;
      }
      if (arg.startsWith('-')) continue;
      subcommand = arg.toLowerCase();
      continue;
    }
    if (!arg.startsWith('-')) {
      positionals.push(arg);
    }
  }
  return { subcommand, positionals };
}

function assertGitArgsAllowed(gitArgs, { allowNetwork = false } = {}) {
  for (const arg of gitArgs) {
    if (String(arg).toLowerCase().includes('ext::')) {
      throw new SandboxPolicyError(
        'Git ext:: protocol transport is always blocked',
        'E_SANDBOX_NETWORK_BLOCKED',
      );
    }
  }
  if (allowNetwork) return;

  const { subcommand, positionals } = findGitSubcommandInfo(gitArgs);
  if (!subcommand) return;

  if (NETWORK_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new SandboxPolicyError(
      `Network git command "git ${subcommand}" is blocked unless allowNetwork: true`,
      'E_SANDBOX_NETWORK_BLOCKED',
      { subcommand },
    );
  }
  if (subcommand === 'remote' && positionals[0]?.toLowerCase() === 'update') {
    throw new SandboxPolicyError(
      'Network git command "git remote update" is blocked unless allowNetwork: true',
      'E_SANDBOX_NETWORK_BLOCKED',
      { subcommand },
    );
  }
  if (
    subcommand === 'submodule' &&
    ['update', 'add', 'sync'].includes(positionals[0]?.toLowerCase() ?? '')
  ) {
    throw new SandboxPolicyError(
      `Network git command "git submodule ${positionals[0]}" is blocked unless allowNetwork: true`,
      'E_SANDBOX_NETWORK_BLOCKED',
      { subcommand },
    );
  }
  if (subcommand === 'clone') {
    const hasRemoteSource = positionals.some((p) => REMOTE_URI_RE.test(p));
    if (hasRemoteSource) {
      throw new SandboxPolicyError(
        'Remote "git clone" is blocked unless allowNetwork: true',
        'E_SANDBOX_NETWORK_BLOCKED',
        { subcommand },
      );
    }
  }
  if (gitArgs.some((arg) => REMOTE_URI_RE.test(String(arg)))) {
    throw new SandboxPolicyError(
      'Remote URI arguments to git are blocked unless allowNetwork: true',
      'E_SANDBOX_NETWORK_BLOCKED',
    );
  }
}

/**
 * Runs hardened `git` synchronously with allowlisted env and empty hooks path.
 */
export function runHardenedGitSync(
  gitArgs = [],
  {
    cwd,
    tmpDir,
    allowNetwork = false,
    timeoutMs = 30000,
    maxBuffer = 10 * 1024 * 1024,
    extraEnv = {},
    encoding = 'utf8',
    emptyHooksDir = null,
  } = {},
) {
  const args = Array.isArray(gitArgs) ? gitArgs.map((a) => String(a)) : [];
  assertGitArgsAllowed(args, { allowNetwork });
  const hardenedArgs = getHardenedGitArgs(args, { emptyHooksDir });
  const env = buildGitAllowlistEnv({ tmpDir, allowNetwork, extraEnv });
  const res = spawnSync('git', hardenedArgs, {
    cwd,
    env,
    encoding,
    timeout: timeoutMs,
    maxBuffer,
    windowsHide: true,
    shell: false,
  });
  return {
    exitCode: Number.isInteger(res.status) ? res.status : 1,
    stdout: typeof res.stdout === 'string' ? res.stdout : res.stdout?.toString(encoding) ?? '',
    stderr: typeof res.stderr === 'string' ? res.stderr : res.stderr?.toString(encoding) ?? '',
    timedOut: res.error?.code === 'ETIMEDOUT',
    signal: res.signal ?? null,
    error: res.error ?? null,
  };
}

function killChildTree(child) {
  if (!child || child.killed) return;
  const pid = child.pid;
  try {
    if (process.platform === 'win32' && pid) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else if (pid) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}

function spawnCollected({
  command,
  args,
  cwd,
  env,
  timeoutMs = 30000,
  maxOutputBytes = 256 * 1024,
  signal = null,
  onOutput = null,
  onTimeoutOrAbort = null,
}) {
  return new Promise((resolveRun, rejectRun) => {
    const isWin = process.platform === 'win32';
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: !isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let totalBytes = 0;
    let truncated = false;
    let settled = false;

    const appendChunk = (streamName, chunks, chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      const text = buf.toString('utf8');
      onOutput?.({ stream: streamName, chunk: text });
      if (totalBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - totalBytes;
        const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
        chunks.push(slice);
        totalBytes += slice.length;
        if (buf.length > remaining) truncated = true;
      } else {
        truncated = true;
      }
    };

    const effectiveTimeout = Math.max(100, Number(timeoutMs || 30000));
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      killChildTree(child);
      if (onTimeoutOrAbort) {
        await Promise.resolve(onTimeoutOrAbort('timeout')).catch(() => {});
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderrBase = Buffer.concat(stderrChunks).toString('utf8');
      const stderr = `${stderrBase}\n[timeout after ${effectiveTimeout}ms]`.trim();
      resolveRun({
        exitCode: 124,
        stdout,
        stderr,
        timedOut: true,
        truncated,
      });
    }, effectiveTimeout);

    const onAbort = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killChildTree(child);
      if (onTimeoutOrAbort) {
        await Promise.resolve(onTimeoutOrAbort('abort')).catch(() => {});
      }
      rejectRun(new SandboxPolicyError('Sandbox execution aborted', 'E_SANDBOX_ABORTED'));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => appendChunk('stdout', stdoutChunks, chunk));
    child.stderr?.on('data', (chunk) => appendChunk('stderr', stderrChunks, chunk));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      rejectRun(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveRun({
        exitCode: code ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut: false,
        truncated,
      });
    });
  });
}

/**
 * Runs hardened `git` asynchronously with allowlisted env and empty hooks path.
 */
export async function runHardenedGit(
  gitArgs = [],
  {
    cwd,
    tmpDir,
    allowNetwork = false,
    timeoutMs = 30000,
    maxOutputBytes = 10 * 1024 * 1024,
    extraEnv = {},
    signal = null,
    onOutput = null,
    emptyHooksDir = null,
  } = {},
) {
  const args = Array.isArray(gitArgs) ? gitArgs.map((a) => String(a)) : [];
  assertGitArgsAllowed(args, { allowNetwork });
  const hardenedArgs = getHardenedGitArgs(args, { emptyHooksDir });
  const env = buildGitAllowlistEnv({ tmpDir, allowNetwork, extraEnv });
  return spawnCollected({
    command: 'git',
    args: hardenedArgs,
    cwd,
    env,
    timeoutMs,
    maxOutputBytes,
    signal,
    onOutput,
  });
}

function checkSymlinkTargetInside(canonicalRoot, linkPath) {
  let targetCanonical;
  try {
    targetCanonical = nativeRealpath(linkPath);
  } catch (err) {
    throw new SandboxPolicyError(
      `Unresolvable symlink or junction at ${linkPath}: ${err?.message ?? err}`,
      'E_SANDBOX_SYMLINK_ESCAPE',
      { path: linkPath },
    );
  }
  if (!isPathInsideRoot(canonicalRoot, targetCanonical, { allowEqual: true })) {
    throw new SandboxPolicyError(
      `Symlink or junction escape detected: ${linkPath} -> ${targetCanonical}`,
      'E_SANDBOX_SYMLINK_ESCAPE',
      { path: linkPath, target: targetCanonical, workspaceRoot: canonicalRoot },
    );
  }
}

/**
 * Recursively verifies that no symlink or NTFS junction inside `workspaceRoot`
 * (including `.git` itself, while skipping deep `.git/objects`) escapes `workspaceRoot`.
 */
export function assertNoSymlinkEscape(workspaceRoot) {
  const abs = resolve(String(workspaceRoot ?? ''));
  if (!existsSync(abs)) {
    throw new SandboxPolicyError(
      `Workspace root does not exist: ${abs}`,
      'E_SANDBOX_PATH_ESCAPE',
    );
  }
  const canonicalRoot = nativeRealpath(abs);
  const rootStat = statSync(canonicalRoot);
  if (!rootStat.isDirectory()) {
    throw new SandboxPolicyError(
      `Workspace root is not a directory: ${canonicalRoot}`,
      'E_SANDBOX_PATH_ESCAPE',
    );
  }

  const stack = [{ dirPath: canonicalRoot, inGit: false }];
  const visitedDirs = new Set();

  while (stack.length > 0) {
    const { dirPath, inGit } = stack.pop();
    const dirKey = normalizeForComparison(dirPath);
    if (visitedDirs.has(dirKey)) continue;
    visitedDirs.add(dirKey);

    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      throw new SandboxPolicyError(
        `Failed to inspect directory for symlink escapes (${dirPath}): ${err?.message ?? err}`,
        'E_SANDBOX_SYMLINK_ESCAPE',
      );
    }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      let isSym = entry.isSymbolicLink();
      let isDir = entry.isDirectory();
      if (!isSym && !isDir) {
        try {
          const lst = lstatSync(fullPath);
          isSym = lst.isSymbolicLink();
          isDir = lst.isDirectory();
        } catch {
          continue;
        }
      }

      if (isSym) {
        checkSymlinkTargetInside(canonicalRoot, fullPath);
        continue;
      }

      if (isDir) {
        if (inGit && entry.name === 'objects') {
          continue;
        }
        stack.push({
          dirPath: fullPath,
          inGit: inGit || entry.name === '.git',
        });
      }
    }
  }
  return canonicalRoot;
}

function normalizeProbeOutcome(raw, defaultReason) {
  if (typeof raw === 'boolean') {
    return { available: raw, reason: raw ? 'ok' : defaultReason };
  }
  if (raw && typeof raw === 'object') {
    const ok = Boolean(raw.available ?? raw.supported);
    return { available: ok, reason: raw.reason ?? (ok ? 'ok' : defaultReason) };
  }
  return { available: false, reason: defaultReason };
}

function translateHostPathToContainer(hostPath, canonicalWs, readOnlyDirs) {
  const canonicalTarget = nativeRealpath(hostPath);
  if (isPathInsideRoot(canonicalWs, canonicalTarget, { allowEqual: true })) {
    const rel = relative(canonicalWs, canonicalTarget).replace(/\\/g, '/');
    return rel ? posixPath.join('/work', rel) : '/work';
  }
  for (let i = 0; i < readOnlyDirs.length; i++) {
    const roDir = readOnlyDirs[i];
    if (isPathInsideRoot(roDir, canonicalTarget, { allowEqual: true })) {
      const rel = relative(roDir, canonicalTarget).replace(/\\/g, '/');
      const mountBase = `/agent-us-ro/${i}`;
      return rel ? posixPath.join(mountBase, rel) : mountBase;
    }
  }
  return hostPath;
}

const DEFAULT_DOCKER_PROBE_CACHE = new Map();
const DEFAULT_NODE_PERMISSION_PROBE_CACHE = new Map();

/**
 * Docker-based benchmark sandbox enforcing network=none, read-only rootfs,
 * cap-drop=ALL, no-new-privileges, non-root user 65534:65534, pids/memory/cpu limits.
 */
export class DockerBenchmarkSandbox {
  constructor({
    image = process.env.AGENT_US_BENCHMARK_DOCKER_IMAGE || 'agent-us/benchmark:node24',
    pidsLimit = 64,
    memoryLimitMb = 512,
    cpus = 1,
    maxOutputBytes = 256 * 1024,
    probes = null,
  } = {}) {
    this.image = image;
    this.pidsLimit = pidsLimit;
    this.memoryLimitMb = memoryLimitMb;
    this.cpus = cpus;
    this.maxOutputBytes = maxOutputBytes;
    this.probes = probes;
    this._probeCache = null;
  }

  probe() {
    if (this._probeCache) return this._probeCache;
    if (this.probes == null && DEFAULT_DOCKER_PROBE_CACHE.has(this.image)) {
      this._probeCache = DEFAULT_DOCKER_PROBE_CACHE.get(this.image);
      return this._probeCache;
    }

    if (this.probes && ('available' in this.probes || 'supported' in this.probes)) {
      this._probeCache = {
        ...normalizeProbeOutcome(this.probes, 'docker_probe_failed'),
        image: this.image,
      };
      return this._probeCache;
    }

    if (this.probes?.isAvailable) {
      this._probeCache = {
        ...normalizeProbeOutcome(this.probes.isAvailable(), 'docker_probe_failed'),
        image: this.image,
      };
      return this._probeCache;
    }

    let daemonOk = false;
    let daemonReason = 'docker_daemon_unavailable';
    if (this.probes?.dockerInfo) {
      const res = normalizeProbeOutcome(this.probes.dockerInfo(), 'docker_daemon_unavailable');
      daemonOk = res.available;
      daemonReason = res.reason;
    } else {
      const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
        env: buildStrictSandboxEnv({ tmpDir: tmpdir() }),
        windowsHide: true,
        encoding: 'utf8',
        timeout: 3000,
        shell: false,
      });
      daemonOk = info.status === 0;
      if (!daemonOk) {
        daemonReason = info.error?.message || info.stderr?.trim() || 'docker_daemon_unavailable';
      }
    }

    if (!daemonOk) {
      this._probeCache = { available: false, image: this.image, reason: daemonReason };
      if (this.probes == null) {
        DEFAULT_DOCKER_PROBE_CACHE.set(this.image, this._probeCache);
      }
      return this._probeCache;
    }

    let imageOk = false;
    let imageReason = `docker_image_missing:${this.image}`;
    if (this.probes?.dockerImageInspect) {
      const res = normalizeProbeOutcome(
        this.probes.dockerImageInspect(this.image),
        imageReason,
      );
      imageOk = res.available;
      imageReason = res.reason;
    } else {
      const inspect = spawnSync('docker', ['image', 'inspect', this.image], {
        env: buildStrictSandboxEnv({ tmpDir: tmpdir() }),
        windowsHide: true,
        encoding: 'utf8',
        timeout: 3000,
        shell: false,
      });
      imageOk = inspect.status === 0;
      if (!imageOk) {
        imageReason = inspect.error?.message || inspect.stderr?.trim() || imageReason;
      }
    }

    this._probeCache = {
      available: imageOk,
      image: this.image,
      reason: imageOk ? 'ok' : imageReason,
    };
    if (this.probes == null) {
      DEFAULT_DOCKER_PROBE_CACHE.set(this.image, this._probeCache);
    }
    return this._probeCache;
  }

  isAvailable() {
    return Boolean(this.probe().available);
  }

  capabilities() {
    return {
      mode: SANDBOX_MODES.DOCKER,
      networkIsolated: true,
      fsRootReadOnly: true,
      capDropAll: true,
      noNewPrivileges: true,
      nonRootUser: '65534:65534',
      pidsLimit: this.pidsLimit,
      memoryLimitMb: this.memoryLimitMb,
      cpus: this.cpus,
      envSanitized: true,
      pathConfined: true,
      symlinkEscapeBlocked: true,
      processTreeKill: true,
      nodePermissionModel: false,
    };
  }

  buildDockerRunArgs(
    argv,
    {
      workspaceRoot,
      cwd = workspaceRoot,
      workspaceReadOnly = false,
      readOnlyDirs = [],
      memoryLimitMb = this.memoryLimitMb,
      cpus = this.cpus,
      pidsLimit = this.pidsLimit,
      extraEnv = {},
    } = {},
  ) {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new SandboxPolicyError('argv must be a non-empty array', 'E_SANDBOX_COMMAND_BLOCKED');
    }
    const canonicalWs = assertNoSymlinkEscape(workspaceRoot);
    const canonicalCwd = nativeRealpath(cwd ?? canonicalWs);
    if (!isPathInsideRoot(canonicalWs, canonicalCwd, { allowEqual: true })) {
      throw new SandboxPolicyError(
        `Working directory escapes workspaceRoot: ${canonicalCwd}`,
        'E_SANDBOX_PATH_ESCAPE',
      );
    }

    const canonicalRoDirs = readOnlyDirs.map((d) => nativeRealpath(d));
    const containerName = `agent-us-bench-${randomUUID().slice(0, 12)}`;
    const relCwd = relative(canonicalWs, canonicalCwd).replace(/\\/g, '/');
    const containerWorkdir = relCwd ? posixPath.join('/work', relCwd) : '/work';

    const validatedExtra = validateExtraEnv(extraEnv);
    const containerEnv = {
      HOME: '/tmp',
      TMPDIR: '/tmp',
      TMP: '/tmp',
      TEMP: '/tmp',
      TZ: 'UTC',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      NODE_ENV: 'test',
      CI: 'true',
      NPM_CONFIG_OFFLINE: 'true',
      NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_FUND: 'false',
      NPM_CONFIG_IGNORE_SCRIPTS: 'true',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      NO_PROXY: '*',
      HTTP_PROXY: 'http://127.0.0.1:0',
      HTTPS_PROXY: 'http://127.0.0.1:0',
      ALL_PROXY: 'http://127.0.0.1:0',
    };
    for (const [k, v] of Object.entries(validatedExtra)) {
      if (v && isAbsolute(v) && existsSync(v) && isPathInsideRoot(canonicalWs, v, { allowEqual: true })) {
        containerEnv[k] = translateHostPathToContainer(v, canonicalWs, canonicalRoDirs);
      } else {
        containerEnv[k] = v;
      }
    }

    const dockerArgs = [
      'run',
      '--rm',
      '--init',
      '--pull=never',
      '--name',
      containerName,
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--user=65534:65534',
      `--pids-limit=${pidsLimit}`,
      `--memory=${memoryLimitMb}m`,
      `--memory-swap=${memoryLimitMb}m`,
      `--cpus=${cpus}`,
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
      '-v',
      `${canonicalWs}:/work:${workspaceReadOnly ? 'ro' : 'rw'}`,
    ];

    for (let i = 0; i < canonicalRoDirs.length; i++) {
      dockerArgs.push('-v', `${canonicalRoDirs[i]}:/agent-us-ro/${i}:ro`);
    }

    for (const [k, v] of Object.entries(containerEnv)) {
      dockerArgs.push('-e', `${k}=${v}`);
    }

    dockerArgs.push('--workdir', containerWorkdir, this.image);

    const mappedArgv = argv.map((arg, index) => {
      const raw = String(arg);
      if (index === 0) {
        const lower = raw.toLowerCase();
        if (
          raw === process.execPath ||
          lower === 'node' ||
          lower === 'node.exe' ||
          (existsSync(raw) &&
            normalizeForComparison(nativeRealpath(raw)) ===
              normalizeForComparison(nativeRealpath(process.execPath)))
        ) {
          return 'node';
        }
      }
      if (isAbsolute(raw) && existsSync(raw)) {
        return translateHostPathToContainer(raw, canonicalWs, canonicalRoDirs);
      }
      return raw;
    });

    dockerArgs.push(...mappedArgv);
    return { containerName, dockerArgs };
  }

  async execArgv(argv, opts = {}) {
    const probe = this.probe();
    if (!probe.available) {
      throw new SandboxUnavailableError(
        `Docker benchmark sandbox is unavailable (${probe.reason})`,
        probe,
      );
    }
    const {
      timeoutMs = 30000,
      cpuLimitSec = null,
      maxOutputBytes = this.maxOutputBytes,
      signal = null,
      onOutput = null,
    } = opts;
    const { containerName, dockerArgs } = this.buildDockerRunArgs(argv, opts);

    const effectiveTimeoutMs =
      Number.isFinite(cpuLimitSec) && cpuLimitSec > 0
        ? Math.min(timeoutMs, Math.max(1500, Math.ceil(cpuLimitSec * 1000 * 2.5) + 1000))
        : timeoutMs;

    const result = await spawnCollected({
      command: 'docker',
      args: dockerArgs,
      cwd: opts.workspaceRoot,
      env: buildStrictSandboxEnv({ tmpDir: tmpdir() }),
      timeoutMs: effectiveTimeoutMs,
      maxOutputBytes,
      signal,
      onOutput,
      onTimeoutOrAbort: () => {
        spawnSync('docker', ['rm', '-f', containerName], {
          env: buildStrictSandboxEnv({ tmpDir: tmpdir() }),
          windowsHide: true,
          stdio: 'ignore',
          timeout: 5000,
          shell: false,
        });
      },
    });

    return {
      ...result,
      cpuLimitExceeded: Boolean(
        result.exitCode === 137 || /ERR_SANDBOX_CPU_LIMIT/i.test(result.stderr),
      ),
      outputTruncated: Boolean(result.truncated),
      backend: SANDBOX_MODES.DOCKER,
    };
  }
}

const BLOCKED_NODE_FLAGS = new Set([
  '--permission',
  '--allow-fs-read',
  '--allow-fs-write',
  '--allow-child-process',
  '--allow-addons',
  '--allow-wasi',
  '--allow-worker',
  '--import',
  '--loader',
  '--experimental-loader',
  '-r',
  '--require',
  '--env-file',
  '--env-file-if-exists',
  '--inspect',
  '--inspect-brk',
  '--inspect-wait',
  '--cpu-prof',
  '--heap-prof',
]);

const TEST_VALUE_FLAGS = new Set([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-shard',
  '--test-concurrency',
  '--test-timeout',
  '--test-isolation',
]);

function buildInProcessTestRunnerArgs(extraNodeFlags, testFiles, testOpts) {
  const optsParts = ["isolation: 'none'"];
  if (testOpts.only) optsParts.push('only: true');
  if (testOpts.testNamePatterns.length > 0) {
    optsParts.push(`testNamePatterns: ${JSON.stringify(testOpts.testNamePatterns)}`);
  }
  const script = [
    "Promise.all([import('node:test'), import('node:test/reporters')])",
    '.then(([{ run }, { spec }]) => {',
    '  let failed = false;',
    `  const stream = run({ files: ${JSON.stringify(testFiles)}, ${optsParts.join(', ')} });`,
    "  stream.on('test:fail', () => { failed = true; });",
    "  stream.on('error', (err) => { failed = true; console.error(err); process.exitCode = 1; });",
    '  const out = stream.compose(spec);',
    '  out.pipe(process.stdout);',
    "  out.on('end', () => { if (failed) process.exitCode = 1; });",
    '})',
    '.catch((err) => { console.error(err); process.exitCode = 1; });',
  ].join(' ');
  return [...extraNodeFlags, '-e', script];
}

function validateTopLevelNodeArgs(nodeArgs, { canonicalCwd = null } = {}) {
  const sanitized = [];
  let hasTestFlag = false;
  let hasTestIsolation = false;

  for (let i = 0; i < nodeArgs.length; i++) {
    const arg = String(nodeArgs[i]);
    const flagName = arg.split('=')[0];
    if (BLOCKED_NODE_FLAGS.has(flagName)) {
      throw new SandboxPolicyError(
        `Node CLI flag "${flagName}" is blocked by benchmark sandbox`,
        'E_SANDBOX_COMMAND_BLOCKED',
        { flag: flagName },
      );
    }
    if (arg === '--test-isolation' && nodeArgs[i + 1] !== 'none') {
      throw new SandboxPolicyError(
        'Only --test-isolation=none is allowed in node-permission sandbox',
        'E_SANDBOX_COMMAND_BLOCKED',
      );
    }
    if (arg.startsWith('--test-isolation=') && arg !== '--test-isolation=none') {
      throw new SandboxPolicyError(
        `Unsupported ${arg}: only --test-isolation=none is allowed in node-permission sandbox`,
        'E_SANDBOX_COMMAND_BLOCKED',
      );
    }
    if (arg === '--test') hasTestFlag = true;
    if (arg === '--test-isolation=none') hasTestIsolation = true;
    sanitized.push(arg);
  }

  if (hasTestFlag && !hasTestIsolation) {
    const idx = sanitized.indexOf('--test');
    sanitized.splice(idx + 1, 0, '--test-isolation=none');
  }

  if (hasTestFlag && canonicalCwd) {
    const extraNodeFlags = [];
    const testFiles = [];
    const testOpts = { only: false, testNamePatterns: [] };
    let hasExternalTestFile = false;

    for (let i = 0; i < sanitized.length; i++) {
      const arg = sanitized[i];
      if (arg === '--test' || arg === '--test-isolation=none') continue;
      if (arg === '--test-only') {
        testOpts.only = true;
        continue;
      }
      if (arg.startsWith('--test-name-pattern=')) {
        testOpts.testNamePatterns.push(arg.slice('--test-name-pattern='.length));
        continue;
      }
      if (arg === '--test-name-pattern' && i + 1 < sanitized.length) {
        testOpts.testNamePatterns.push(sanitized[++i]);
        continue;
      }
      const flagName = arg.split('=')[0];
      if (arg.startsWith('-')) {
        extraNodeFlags.push(arg);
        if (!arg.includes('=') && TEST_VALUE_FLAGS.has(flagName) && i + 1 < sanitized.length) {
          extraNodeFlags.push(sanitized[++i]);
        }
        continue;
      }
      if (isAbsolute(arg)) {
        const realTarget = nativeRealpath(arg);
        if (isPathInsideRoot(canonicalCwd, realTarget, { allowEqual: true })) {
          sanitized[i] = relative(canonicalCwd, realTarget).replace(/\\/g, '/') || '.';
          testFiles.push(realTarget);
        } else {
          hasExternalTestFile = true;
          testFiles.push(realTarget);
        }
      } else {
        testFiles.push(resolve(canonicalCwd, arg));
      }
    }

    if (hasExternalTestFile) {
      return buildInProcessTestRunnerArgs(extraNodeFlags, testFiles, testOpts);
    }
  }

  return sanitized;
}

/**
 * Node.js `--permission` + `--import` preload benchmark sandbox backend.
 */
export class NodePermissionBenchmarkSandbox {
  constructor({
    nodeExecPath = process.execPath,
    maxOutputBytes = 256 * 1024,
    probes = null,
  } = {}) {
    this.nodeExecPath = nativeRealpath(nodeExecPath);
    this.maxOutputBytes = maxOutputBytes;
    this.probes = probes;
    this._probeCache = null;
  }

  probe() {
    if (this._probeCache) return this._probeCache;
    const nodeCacheKey = normalizeForComparison(this.nodeExecPath);
    if (this.probes == null && DEFAULT_NODE_PERMISSION_PROBE_CACHE.has(nodeCacheKey)) {
      this._probeCache = DEFAULT_NODE_PERMISSION_PROBE_CACHE.get(nodeCacheKey);
      return this._probeCache;
    }

    if (this.probes && ('available' in this.probes || 'supported' in this.probes)) {
      const res = normalizeProbeOutcome(this.probes, 'node_permission_unavailable');
      this._probeCache = {
        available: res.available,
        reason: res.reason,
        prlimitAvailable: false,
      };
      return this._probeCache;
    }

    if (this.probes?.isAvailable) {
      const res = normalizeProbeOutcome(
        this.probes.isAvailable(),
        'node_permission_unavailable',
      );
      const prlimitOk = this.probes?.prlimit
        ? normalizeProbeOutcome(this.probes.prlimit(), 'prlimit_unavailable').available
        : false;
      this._probeCache = {
        available: res.available,
        reason: res.reason,
        prlimitAvailable: prlimitOk,
      };
      return this._probeCache;
    }

    let permAvailable = false;
    let permReason = 'node_permission_unavailable';

    if (this.probes?.permission) {
      const res = normalizeProbeOutcome(
        this.probes.permission(),
        'node_permission_unavailable',
      );
      permAvailable = res.available;
      permReason = res.reason;
    } else {
      const probeTmp = nativeRealpath(mkdtempSync(join(tmpdir(), 'agent-us-probe-')));
      try {
        const probeEnv = buildStrictSandboxEnv({ tmpDir: probeTmp });
        probeEnv.AGENT_US_SANDBOX_CONFIG = JSON.stringify({
          workspaceRoot: probeTmp,
          workspaceReadOnly: true,
          allowWorkspaceNodeCli: false,
          nodeExecPath: this.nodeExecPath,
          cpuLimitMs: null,
          maxChildSpawns: 0,
        });
        const res = spawnSync(
          this.nodeExecPath,
          [
            '--permission',
            '--no-addons',
            `--allow-fs-read=${PRELOAD_FILE_PATH}`,
            `--import=${PRELOAD_FILE_URL}`,
            '-e',
            'process.stdout.write(process.permission ? "ok" : "no")',
          ],
          {
            cwd: probeTmp,
            env: probeEnv,
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
            shell: false,
          },
        );
        permAvailable = res.status === 0 && res.stdout?.trim() === 'ok';
        permReason = permAvailable
          ? 'ok'
          : res.error?.message || res.stderr?.trim() || 'node_permission_probe_failed';
      } finally {
        try {
          rmSync(probeTmp, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }

    let prlimitAvailable = false;
    if (permAvailable && process.platform !== 'win32') {
      if (this.probes?.prlimit) {
        prlimitAvailable = normalizeProbeOutcome(
          this.probes.prlimit(),
          'prlimit_unavailable',
        ).available;
      } else {
        const prRes = spawnSync(
          'prlimit',
          ['--cpu=10', '--', this.nodeExecPath, '-v'],
          {
            env: buildStrictSandboxEnv({ tmpDir: tmpdir() }),
            stdio: 'ignore',
            timeout: 2500,
            shell: false,
          },
        );
        prlimitAvailable = prRes.status === 0;
      }
    }

    this._probeCache = {
      available: permAvailable,
      reason: permReason,
      prlimitAvailable,
    };
    if (this.probes == null) {
      DEFAULT_NODE_PERMISSION_PROBE_CACHE.set(nodeCacheKey, this._probeCache);
    }
    return this._probeCache;
  }

  isAvailable() {
    return Boolean(this.probe().available);
  }

  capabilities() {
    return {
      mode: SANDBOX_MODES.NODE_PERMISSION,
      networkIsolated: true,
      fsRootReadOnly: false,
      fsScopedByPermissionModel: true,
      capDropAll: false,
      noAddons: true,
      envSanitized: true,
      pathConfined: true,
      symlinkEscapeBlocked: true,
      processTreeKill: true,
      nodePermissionModel: true,
    };
  }

  buildInvocation(
    nodeArgs,
    {
      workspaceRoot,
      cwd = workspaceRoot,
      tmpDir,
      workspaceReadOnly = false,
      readOnlyDirs = [],
      readWriteDirs = [],
      allowWorkspaceNodeCli = false,
      maxChildSpawns = 32,
      cpuLimitSec = null,
      memoryLimitMb = 512,
      extraEnv = {},
    },
  ) {
    const canonicalWs = assertNoSymlinkEscape(workspaceRoot);
    const canonicalCwd = nativeRealpath(cwd ?? canonicalWs);
    if (!isPathInsideRoot(canonicalWs, canonicalCwd, { allowEqual: true })) {
      throw new SandboxPolicyError(
        `Working directory escapes workspaceRoot: ${canonicalCwd}`,
        'E_SANDBOX_PATH_ESCAPE',
      );
    }

    const canonicalTmp = nativeRealpath(tmpDir);
    const canonicalRoDirs = readOnlyDirs.map((d) => nativeRealpath(d));
    const canonicalRwDirs = readWriteDirs.map((d) => nativeRealpath(d));

    const readAllowSet = new Set([
      PRELOAD_FILE_PATH,
      canonicalWs,
      canonicalTmp,
      ...canonicalRoDirs,
      ...canonicalRwDirs,
    ]);
    const writeAllowSet = new Set([
      canonicalTmp,
      ...(workspaceReadOnly ? [] : [canonicalWs]),
      ...canonicalRwDirs,
    ]);

    const parentNodeFlags = [
      '--permission',
      '--no-addons',
      `--max-old-space-size=${memoryLimitMb}`,
      ...[...readAllowSet].map((p) => `--allow-fs-read=${p}`),
      ...[...writeAllowSet].map((p) => `--allow-fs-write=${p}`),
      ...(allowWorkspaceNodeCli ? ['--allow-child-process'] : []),
      `--import=${PRELOAD_FILE_URL}`,
    ];

    const strictEnv = buildStrictSandboxEnv({ tmpDir: canonicalTmp, extraEnv });
    const cpuLimitMs =
      Number.isFinite(cpuLimitSec) && cpuLimitSec > 0
        ? Math.round(cpuLimitSec * 1000)
        : null;

    const grandchildReadSet = new Set([PRELOAD_FILE_PATH, canonicalWs, canonicalTmp]);
    const grandchildWriteSet = new Set([
      canonicalTmp,
      ...(workspaceReadOnly ? [] : [canonicalWs]),
    ]);
    const grandchildNodeFlags = allowWorkspaceNodeCli
      ? [
          '--permission',
          '--no-addons',
          `--max-old-space-size=${memoryLimitMb}`,
          ...[...grandchildReadSet].map((p) => `--allow-fs-read=${p}`),
          ...[...grandchildWriteSet].map((p) => `--allow-fs-write=${p}`),
          `--import=${PRELOAD_FILE_URL}`,
        ]
      : [];

    const grandchildConfigJson = allowWorkspaceNodeCli
      ? JSON.stringify({
          workspaceRoot: canonicalWs,
          workspaceReadOnly: Boolean(workspaceReadOnly),
          allowWorkspaceNodeCli: false,
          nodeExecPath: this.nodeExecPath,
          cpuLimitMs,
          maxChildSpawns: 0,
        })
      : undefined;

    const env = {
      ...strictEnv,
      AGENT_US_SANDBOX_CONFIG: JSON.stringify({
        workspaceRoot: canonicalWs,
        workspaceReadOnly: Boolean(workspaceReadOnly),
        allowWorkspaceNodeCli: Boolean(allowWorkspaceNodeCli),
        nodeExecPath: this.nodeExecPath,
        cpuLimitMs,
        maxChildSpawns,
        grandchildNodeFlags,
        grandchildBaseEnv: allowWorkspaceNodeCli ? strictEnv : undefined,
        grandchildConfigJson,
      }),
    };

    const effectiveNodeArgs = validateTopLevelNodeArgs(nodeArgs, { canonicalCwd });
    return {
      canonicalWs,
      canonicalCwd,
      parentNodeFlags,
      effectiveNodeArgs,
      env,
      cpuLimitMs,
    };
  }

  async execNode(nodeArgs = [], opts = {}) {
    const probe = this.probe();
    if (!probe.available) {
      throw new SandboxUnavailableError(
        `Node --permission sandbox is unavailable (${probe.reason})`,
        probe,
      );
    }

    const {
      timeoutMs = 30000,
      cpuLimitSec = null,
      maxOutputBytes = this.maxOutputBytes,
      signal = null,
      onOutput = null,
    } = opts;

    const ephemeralTmp = nativeRealpath(mkdtempSync(join(tmpdir(), 'agent-us-sbx-tmp-')));
    try {
      const {
        canonicalCwd,
        parentNodeFlags,
        effectiveNodeArgs,
        env,
      } = this.buildInvocation(nodeArgs, { ...opts, tmpDir: ephemeralTmp });

      const usePrlimit =
        process.platform !== 'win32' &&
        probe.prlimitAvailable &&
        Number.isFinite(cpuLimitSec) &&
        cpuLimitSec > 0;

      const command = usePrlimit ? 'prlimit' : this.nodeExecPath;
      const args = usePrlimit
        ? [
            `--cpu=${Math.max(1, Math.ceil(cpuLimitSec))}`,
            '--',
            this.nodeExecPath,
            ...parentNodeFlags,
            ...effectiveNodeArgs,
          ]
        : [...parentNodeFlags, ...effectiveNodeArgs];

      const effectiveTimeoutMs =
        Number.isFinite(cpuLimitSec) && cpuLimitSec > 0
          ? Math.min(timeoutMs, Math.max(1500, Math.ceil(cpuLimitSec * 1000 * 2.5) + 1000))
          : timeoutMs;

      const result = await spawnCollected({
        command,
        args,
        cwd: canonicalCwd,
        env,
        timeoutMs: effectiveTimeoutMs,
        maxOutputBytes,
        signal,
        onOutput,
      });

      return {
        ...result,
        cpuLimitExceeded: Boolean(
          result.exitCode === 137 || /ERR_SANDBOX_CPU_LIMIT/i.test(result.stderr),
        ),
        outputTruncated: Boolean(result.truncated),
        backend: SANDBOX_MODES.NODE_PERMISSION,
      };
    } finally {
      try {
        rmSync(ephemeralTmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 });
      } catch {
        // ignore best-effort cleanup
      }
    }
  }

  async execArgv(argv = [], opts = {}) {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new SandboxPolicyError('argv must be a non-empty array', 'E_SANDBOX_COMMAND_BLOCKED');
    }
    return this.execNode(argv.slice(1), opts);
  }
}

const STRICT_SHELL_METACHAR_RE = /[;&|><`\r\n\0]|\$\(|@\(|<\(|>\(/;

function tokenizeStrictCommand(commandString) {
  const raw = String(commandString ?? '');
  if (!raw.trim()) {
    throw new SandboxPolicyError('Command string must not be empty', 'E_SANDBOX_COMMAND_BLOCKED');
  }
  if (/[\r\n\0]/.test(raw)) {
    throw new SandboxPolicyError(
      'Newlines and NUL bytes are blocked in sandbox command strings',
      'E_SANDBOX_COMMAND_BLOCKED',
    );
  }

  const tokens = [];
  let current = '';
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;

  const pushToken = () => {
    if (hasToken) {
      tokens.push(current);
      current = '';
      hasToken = false;
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '`' || (ch === '$' && raw[i + 1] === '(')) {
        throw new SandboxPolicyError(
          'Shell command substitution is blocked in benchmark sandbox',
          'E_SANDBOX_COMMAND_BLOCKED',
        );
      }
      if (ch === '\\' && i + 1 < raw.length) {
        const nextCh = raw[i + 1];
        if (nextCh === '`' || nextCh === '$') {
          throw new SandboxPolicyError(
            'Shell command substitution is blocked in benchmark sandbox',
            'E_SANDBOX_COMMAND_BLOCKED',
          );
        }
        current += nextCh;
        i++;
      } else if (ch === '"') {
        inDouble = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }

    const two = raw.slice(i, i + 2);
    if (
      STRICT_SHELL_METACHAR_RE.test(ch) ||
      two === '&&' ||
      two === '||' ||
      two === '$(' ||
      two === '@(' ||
      two === '<(' ||
      two === '>('
    ) {
      throw new SandboxPolicyError(
        `Shell injection metacharacter "${two === '$(' || two === '&&' || two === '||' ? two : ch}" is blocked in benchmark sandbox`,
        'E_SANDBOX_COMMAND_BLOCKED',
      );
    }

    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    current += ch;
    hasToken = true;
  }

  if (inSingle || inDouble) {
    throw new SandboxPolicyError(
      'Unterminated quote in sandbox command string',
      'E_SANDBOX_COMMAND_BLOCKED',
    );
  }
  pushToken();
  if (tokens.length === 0) {
    throw new SandboxPolicyError('Command string resolved to no tokens', 'E_SANDBOX_COMMAND_BLOCKED');
  }
  return tokens;
}

function normalizeBinForDispatch(rawBin) {
  const base = basename(String(rawBin ?? ''));
  return base.replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
}

const READONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'rev-parse',
  'show',
  'branch',
]);

const GIT_BLOCKED_FLAGS = new Set([
  '-c',
  '-C',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--exec',
  '--exec-path',
  '--upload-pack',
  '--receive-pack',
  '--output',
  '-o',
  '--no-index',
  '--ext-diff',
  '--textconv',
]);

const GIT_BRANCH_MUTATING_FLAGS = new Set([
  '-d',
  '-D',
  '--delete',
  '-m',
  '-M',
  '--move',
  '-c',
  '-C',
  '--copy',
  '-f',
  '--force',
  '-u',
  '--set-upstream-to',
  '--unset-upstream',
  '--edit-description',
  '--track',
  '--no-track',
  '--create-reflog',
]);

function validateReadOnlyGitArgv(gitArgs) {
  let subcommand = null;
  const subArgs = [];

  for (const rawArg of gitArgs) {
    const arg = String(rawArg);
    const flagName = arg.split('=')[0];
    if (GIT_BLOCKED_FLAGS.has(flagName)) {
      throw new SandboxPolicyError(
        `Git flag "${flagName}" is blocked in benchmark sandbox`,
        'E_SANDBOX_COMMAND_BLOCKED',
      );
    }
    if (!subcommand) {
      if (arg.startsWith('-')) {
        throw new SandboxPolicyError(
          `Git pre-subcommand flag "${arg}" is blocked in benchmark sandbox`,
          'E_SANDBOX_COMMAND_BLOCKED',
        );
      }
      subcommand = arg.toLowerCase();
      continue;
    }
    subArgs.push(arg);
  }

  if (!subcommand || !READONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new SandboxPolicyError(
      `Git subcommand "${subcommand ?? ''}" is blocked in benchmark sandbox (read-only subset only)`,
      'E_SANDBOX_COMMAND_BLOCKED',
    );
  }

  if (subcommand === 'branch') {
    for (const arg of subArgs) {
      const flagName = arg.split('=')[0];
      if (GIT_BRANCH_MUTATING_FLAGS.has(flagName)) {
        throw new SandboxPolicyError(
          `Mutating git branch flag "${flagName}" is blocked in benchmark sandbox`,
          'E_SANDBOX_COMMAND_BLOCKED',
        );
      }
      if (!arg.startsWith('-')) {
        throw new SandboxPolicyError(
          'Positional git branch creation/modification arguments are blocked in benchmark sandbox',
          'E_SANDBOX_COMMAND_BLOCKED',
        );
      }
    }
  }
}

function coerceBackendProbes(val) {
  if (val === undefined) return null;
  if (typeof val === 'function') return { isAvailable: val };
  if (typeof val === 'boolean') return { isAvailable: () => val };
  if (val && typeof val === 'object') {
    if ('available' in val || 'supported' in val) {
      return { isAvailable: () => val };
    }
    return { ...val };
  }
  return null;
}

function coerceSubProbe(val) {
  if (typeof val === 'function') return val;
  if (val && typeof val === 'object' && ('available' in val || 'supported' in val)) {
    return () => val;
  }
  return () => Boolean(val);
}

function mergeShorthandProbes(probes) {
  if (!probes || typeof probes !== 'object') {
    return { dockerProbes: null, nodeProbes: null };
  }
  const dockerProbes = coerceBackendProbes(probes.docker);
  let nodeProbes = coerceBackendProbes(probes.nodePermission);

  if (probes.permission !== undefined) {
    nodeProbes = {
      ...(nodeProbes || {}),
      permission: coerceSubProbe(probes.permission),
    };
  }
  if (probes.prlimit !== undefined) {
    nodeProbes = {
      ...(nodeProbes || {}),
      prlimit: coerceSubProbe(probes.prlimit),
    };
  }
  return { dockerProbes, nodeProbes };
}

/**
 * Fail-closed unified benchmark sandbox facade resolving Docker or Node `--permission`.
 * Never falls back to `HostSandboxAdapter` or unsandboxed host execution.
 */
export class BenchmarkSandbox {
  constructor({
    mode = process.env.AGENT_US_BENCHMARK_SANDBOX_MODE || SANDBOX_MODES.AUTO,
    workspaceRoot = null,
    dependencyPolicy = DEFAULT_DEPENDENCY_POLICY,
    dockerSandbox = null,
    nodePermissionSandbox = null,
    dockerOptions = {},
    nodePermissionOptions = {},
    probes = null,
    dockerImage = undefined,
    pidsLimit = undefined,
    allowWorkspaceNodeCli = false,
    timeoutMs = 30000,
    cpuLimitSec = null,
    memoryLimitMb = 512,
    maxOutputBytes = 256 * 1024,
  } = {}) {
    if (!Object.values(SANDBOX_MODES).includes(mode)) {
      throw new SandboxUnavailableError(
        `Unsupported sandbox mode "${String(mode)}": fail-closed policy forbids host fallback`,
        { mode },
      );
    }
    this.mode = mode;
    this.workspaceRoot = workspaceRoot;
    this.dependencyPolicy = validateDependencyPolicy(dependencyPolicy);
    this.allowWorkspaceNodeCli = Boolean(allowWorkspaceNodeCli);
    this.timeoutMs = timeoutMs;
    this.cpuLimitSec = cpuLimitSec;
    this.memoryLimitMb = memoryLimitMb;
    this.maxOutputBytes = maxOutputBytes;

    const { dockerProbes, nodeProbes } = mergeShorthandProbes(probes);
    const mergedDockerOpts = {
      memoryLimitMb,
      maxOutputBytes,
      ...dockerOptions,
      ...(dockerImage !== undefined ? { image: dockerImage } : {}),
      ...(pidsLimit !== undefined ? { pidsLimit } : {}),
      ...(dockerOptions.probes || dockerProbes
        ? { probes: { ...(dockerOptions.probes || {}), ...(dockerProbes || {}) } }
        : {}),
    };
    const mergedNodeOpts = {
      maxOutputBytes,
      ...nodePermissionOptions,
      ...(nodePermissionOptions.probes || nodeProbes
        ? { probes: { ...(nodePermissionOptions.probes || {}), ...(nodeProbes || {}) } }
        : {}),
    };

    this.dockerSandbox = dockerSandbox ?? new DockerBenchmarkSandbox(mergedDockerOpts);
    this.nodePermissionSandbox =
      nodePermissionSandbox ?? new NodePermissionBenchmarkSandbox(mergedNodeOpts);
  }

  #withRunDefaults(opts = {}) {
    return {
      ...opts,
      allowWorkspaceNodeCli: opts.allowWorkspaceNodeCli ?? this.allowWorkspaceNodeCli,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      cpuLimitSec: opts.cpuLimitSec !== undefined ? opts.cpuLimitSec : this.cpuLimitSec,
      memoryLimitMb: opts.memoryLimitMb ?? this.memoryLimitMb,
      maxOutputBytes: opts.maxOutputBytes ?? this.maxOutputBytes,
    };
  }

  resolveBackend() {
    if (this.mode === SANDBOX_MODES.DOCKER) {
      if (this.dockerSandbox.isAvailable()) {
        return { mode: SANDBOX_MODES.DOCKER, backend: this.dockerSandbox };
      }
      throw new SandboxUnavailableError(
        'Docker benchmark sandbox is unavailable (mode locked to "docker")',
        { requestedMode: this.mode, dockerProbe: this.dockerSandbox.probe() },
      );
    }

    if (this.mode === SANDBOX_MODES.NODE_PERMISSION) {
      if (this.nodePermissionSandbox.isAvailable()) {
        return { mode: SANDBOX_MODES.NODE_PERMISSION, backend: this.nodePermissionSandbox };
      }
      throw new SandboxUnavailableError(
        'Node --permission benchmark sandbox is unavailable (mode locked to "node-permission")',
        { requestedMode: this.mode, nodeProbe: this.nodePermissionSandbox.probe() },
      );
    }

    if (this.dockerSandbox.isAvailable()) {
      return { mode: SANDBOX_MODES.DOCKER, backend: this.dockerSandbox };
    }
    if (this.nodePermissionSandbox.isAvailable()) {
      return { mode: SANDBOX_MODES.NODE_PERMISSION, backend: this.nodePermissionSandbox };
    }

    throw new SandboxUnavailableError(
      'No verified benchmark sandbox backend is available (docker and node-permission both unavailable)',
      {
        requestedMode: this.mode,
        dockerProbe: this.dockerSandbox.probe(),
        nodeProbe: this.nodePermissionSandbox.probe(),
      },
    );
  }

  capabilities() {
    const { backend } = this.resolveBackend();
    return backend.capabilities();
  }

  #resolveWorkspaceAndCwd(opts = {}) {
    const rawWs = opts.workspaceRoot ?? this.workspaceRoot;
    if (!rawWs) {
      throw new SandboxPolicyError(
        'workspaceRoot is required for benchmark sandbox execution',
        'E_SANDBOX_PATH_ESCAPE',
      );
    }
    const canonicalWs = assertNoSymlinkEscape(rawWs);
    const rawCwd = opts.cwd ?? canonicalWs;
    const resolvedCwd = isAbsolute(String(rawCwd))
      ? String(rawCwd)
      : resolve(canonicalWs, String(rawCwd));
    if (!existsSync(resolvedCwd)) {
      throw new SandboxPolicyError(
        `Working directory does not exist: ${resolvedCwd}`,
        'E_SANDBOX_PATH_ESCAPE',
      );
    }
    const canonicalCwd = nativeRealpath(resolvedCwd);
    if (!isPathInsideRoot(canonicalWs, canonicalCwd, { allowEqual: true })) {
      throw new SandboxPolicyError(
        `Working directory escapes workspaceRoot: ${canonicalCwd}`,
        'E_SANDBOX_PATH_ESCAPE',
      );
    }
    return { canonicalWs, canonicalCwd };
  }

  #resolveNpmTestArgv(canonicalWs, canonicalCwd, npmArgs, depPolicy) {
    const sub = String(npmArgs[0] ?? '').toLowerCase();
    if (sub !== 'test' && sub !== 't') {
      throw new SandboxPolicyError(
        `npm subcommand "${sub}" is blocked in node-permission benchmark sandbox`,
        'E_SANDBOX_COMMAND_BLOCKED',
      );
    }

    const pkgPath = join(canonicalCwd, 'package.json');
    if (!existsSync(pkgPath)) {
      throw new SandboxPolicyError(
        `package.json not found in ${canonicalCwd}`,
        'E_SANDBOX_COMMAND_BLOCKED',
      );
    }
    const canonicalPkgPath = nativeRealpath(pkgPath);
    if (!isPathInsideRoot(canonicalWs, canonicalPkgPath, { allowEqual: false })) {
      throw new SandboxPolicyError(
        'package.json resolves outside workspaceRoot',
        'E_SANDBOX_SYMLINK_ESCAPE',
      );
    }

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(canonicalPkgPath, 'utf8'));
    } catch (err) {
      throw new SandboxPolicyError(
        `Failed to parse package.json: ${err?.message ?? err}`,
        'E_SANDBOX_COMMAND_BLOCKED',
      );
    }

    const testScript = pkg?.scripts?.test;
    if (typeof testScript !== 'string' || !testScript.trim()) {
      throw new SandboxPolicyError(
        'package.json does not define scripts.test',
        'E_SANDBOX_COMMAND_BLOCKED',
      );
    }

    assertCommandAllowedByDependencyPolicy(testScript, depPolicy);
    const scriptTokens = tokenizeStrictCommand(testScript);
    if (normalizeBinForDispatch(scriptTokens[0]) !== 'node') {
      throw new SandboxPolicyError(
        `scripts.test must invoke node directly in node-permission mode (got "${scriptTokens[0]}")`,
        'E_SANDBOX_COMMAND_BLOCKED',
      );
    }

    const sepIdx = npmArgs.indexOf('--');
    const passthrough = sepIdx >= 0 ? npmArgs.slice(sepIdx + 1) : [];
    const nodeArgv = [...scriptTokens.slice(1), ...passthrough];
    assertCommandAllowedByDependencyPolicy(['node', ...nodeArgv], depPolicy);
    return nodeArgv;
  }

  async execArgv(argv, opts = {}) {
    const effectiveOpts = this.#withRunDefaults(opts);
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new SandboxPolicyError('argv must be a non-empty array', 'E_SANDBOX_COMMAND_BLOCKED');
    }
    const normalizedArgv = argv.map((a) => String(a ?? ''));
    if (normalizedArgv.some((a) => a.includes('\0'))) {
      throw new SandboxPolicyError('NUL byte in argv is blocked', 'E_SANDBOX_COMMAND_BLOCKED');
    }

    const depPolicy = effectiveOpts.dependencyPolicy
      ? validateDependencyPolicy(effectiveOpts.dependencyPolicy)
      : this.dependencyPolicy;
    assertCommandAllowedByDependencyPolicy(normalizedArgv, depPolicy);

    const { canonicalWs, canonicalCwd } = this.#resolveWorkspaceAndCwd(effectiveOpts);
    const { mode, backend } = this.resolveBackend();

    if (mode === SANDBOX_MODES.DOCKER) {
      return backend.execArgv(normalizedArgv, {
        ...effectiveOpts,
        workspaceRoot: canonicalWs,
        cwd: canonicalCwd,
      });
    }

    const rawBin = normalizedArgv[0];
    const binName = normalizeBinForDispatch(rawBin);
    const isNodeBinary =
      binName === 'node' ||
      rawBin === process.execPath ||
      (existsSync(rawBin) &&
        normalizeForComparison(nativeRealpath(rawBin)) ===
          normalizeForComparison(this.nodePermissionSandbox.nodeExecPath));

    if (isNodeBinary) {
      return backend.execNode(normalizedArgv.slice(1), {
        ...effectiveOpts,
        workspaceRoot: canonicalWs,
        cwd: canonicalCwd,
      });
    }

    if (binName === 'npm') {
      const nodeArgs = this.#resolveNpmTestArgv(
        canonicalWs,
        canonicalCwd,
        normalizedArgv.slice(1),
        depPolicy,
      );
      return backend.execNode(nodeArgs, {
        ...effectiveOpts,
        workspaceRoot: canonicalWs,
        cwd: canonicalCwd,
      });
    }

    if (binName === 'git') {
      const gitArgs = normalizedArgv.slice(1);
      validateReadOnlyGitArgv(gitArgs);
      const res = await runHardenedGit(gitArgs, {
        cwd: canonicalCwd,
        allowNetwork: false,
        timeoutMs: effectiveOpts.timeoutMs,
        maxOutputBytes: effectiveOpts.maxOutputBytes,
        extraEnv: effectiveOpts.extraEnv,
        signal: effectiveOpts.signal,
        onOutput: effectiveOpts.onOutput,
      });
      return {
        ...res,
        cpuLimitExceeded: Boolean(
          res.exitCode === 137 || /ERR_SANDBOX_CPU_LIMIT/i.test(res.stderr),
        ),
        outputTruncated: Boolean(res.truncated),
        backend: SANDBOX_MODES.NODE_PERMISSION,
      };
    }

    throw new SandboxPolicyError(
      `Command "${rawBin}" is blocked in node-permission benchmark sandbox`,
      'E_SANDBOX_COMMAND_BLOCKED',
      { argv: normalizedArgv },
    );
  }

  /**
   * Compatible with `createShellTools` (`bash` tool) interface: `run(command, cwd, opts)`.
   */
  async run(commandString, cwd, opts = {}) {
    let effectiveCwd = cwd;
    let rawOpts = opts;
    if (cwd && typeof cwd === 'object' && !Array.isArray(cwd)) {
      rawOpts = cwd;
      effectiveCwd = rawOpts.cwd;
    }
    const effectiveOpts = this.#withRunDefaults(rawOpts);

    const cmd = String(commandString ?? '').trim();
    if (!cmd) {
      throw new SandboxPolicyError('Command string must not be empty', 'E_SANDBOX_COMMAND_BLOCKED');
    }

    const depPolicy = effectiveOpts.dependencyPolicy
      ? validateDependencyPolicy(effectiveOpts.dependencyPolicy)
      : this.dependencyPolicy;
    assertCommandAllowedByDependencyPolicy(cmd, depPolicy);

    const workspaceRoot = effectiveOpts.workspaceRoot ?? this.workspaceRoot ?? effectiveCwd;
    const { canonicalWs, canonicalCwd } = this.#resolveWorkspaceAndCwd({
      ...effectiveOpts,
      workspaceRoot,
      cwd: effectiveCwd ?? workspaceRoot,
    });

    const { mode } = this.resolveBackend();
    if (mode === SANDBOX_MODES.DOCKER) {
      try {
        const tokens = tokenizeStrictCommand(cmd);
        return await this.execArgv(tokens, {
          ...effectiveOpts,
          workspaceRoot: canonicalWs,
          cwd: canonicalCwd,
          dependencyPolicy: depPolicy,
        });
      } catch (err) {
        if (err?.code !== 'E_SANDBOX_COMMAND_BLOCKED') throw err;
        return this.dockerSandbox.execArgv(['sh', '-c', cmd], {
          ...effectiveOpts,
          workspaceRoot: canonicalWs,
          cwd: canonicalCwd,
        });
      }
    }

    const tokens = tokenizeStrictCommand(cmd);
    return this.execArgv(tokens, {
      ...effectiveOpts,
      workspaceRoot: canonicalWs,
      cwd: canonicalCwd,
      dependencyPolicy: depPolicy,
    });
  }

  /**
   * Executes a hidden acceptance test from an ephemeral read-only directory outside
   * `workspaceRoot`, keeping `workspaceRoot` read-only and exposing `WORKSPACE_ROOT`
   * and `AGENT_US_WORKSPACE_ROOT`.
   */
  async runHiddenAcceptance({
    workspaceRoot = this.workspaceRoot,
    scriptSource,
    scriptFilename = 'hidden-acceptance.test.mjs',
    allowWorkspaceNodeCli = this.allowWorkspaceNodeCli,
    timeoutMs = this.timeoutMs,
    cpuLimitSec = this.cpuLimitSec,
    memoryLimitMb = this.memoryLimitMb,
    maxOutputBytes = this.maxOutputBytes,
    extraEnv = {},
    onOutput = null,
    signal = null,
  }) {
    if (typeof scriptSource !== 'string' || !scriptSource.trim()) {
      throw new SandboxPolicyError('scriptSource must be a non-empty string', 'E_SANDBOX_POLICY_VIOLATION');
    }
    const cleanFilename = String(scriptFilename ?? '').trim();
    if (
      !cleanFilename ||
      cleanFilename.includes('/') ||
      cleanFilename.includes('\\') ||
      cleanFilename.includes('..') ||
      !/^[A-Za-z0-9._-]+\.(?:mjs|js|cjs)$/.test(cleanFilename)
    ) {
      throw new SandboxPolicyError(
        `Invalid hidden acceptance scriptFilename: "${scriptFilename}"`,
        'E_SANDBOX_POLICY_VIOLATION',
      );
    }

    const canonicalWs = assertNoSymlinkEscape(workspaceRoot);
    const hiddenDir = nativeRealpath(mkdtempSync(join(tmpdir(), 'agent-us-hidden-acc-')));
    const hiddenFile = join(hiddenDir, cleanFilename);

    try {
      if (isPathInsideRoot(canonicalWs, hiddenDir, { allowEqual: true })) {
        throw new SandboxPolicyError(
          'Ephemeral hidden acceptance directory must reside outside workspaceRoot',
          'E_SANDBOX_PATH_ESCAPE',
        );
      }

      writeFileSync(hiddenFile, scriptSource, 'utf8');
      if (process.platform !== 'win32') {
        chmodSync(hiddenFile, 0o400);
        chmodSync(hiddenDir, 0o500);
      }

      const res = await this.execArgv(['node', '--test', hiddenFile], {
        workspaceRoot: canonicalWs,
        cwd: canonicalWs,
        workspaceReadOnly: true,
        readOnlyDirs: [hiddenDir],
        allowWorkspaceNodeCli: Boolean(allowWorkspaceNodeCli),
        timeoutMs,
        cpuLimitSec,
        memoryLimitMb,
        maxOutputBytes,
        onOutput,
        signal,
        extraEnv: {
          ...extraEnv,
          WORKSPACE_ROOT: canonicalWs,
          AGENT_US_WORKSPACE_ROOT: canonicalWs,
        },
      });

      return {
        passed: res.exitCode === 0 && !res.timedOut,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        timedOut: Boolean(res.timedOut),
        cpuLimitExceeded: Boolean(res.cpuLimitExceeded),
        backend: res.backend,
        truncated: Boolean(res.truncated),
        outputTruncated: Boolean(res.outputTruncated ?? res.truncated),
      };
    } finally {
      if (process.platform !== 'win32') {
        try {
          chmodSync(hiddenDir, 0o700);
        } catch {
          // ignore
        }
        try {
          chmodSync(hiddenFile, 0o600);
        } catch {
          // ignore
        }
      }
      try {
        rmSync(hiddenDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 });
      } catch {
        // ignore best-effort cleanup
      }
    }
  }
}
