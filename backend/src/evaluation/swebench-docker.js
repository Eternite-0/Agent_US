import { execFile, execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, parse, posix as posixPath, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { analyzeCommand, scanCommandSyntax } from '../tools/command-analyzer.js';
import { buildStrictSandboxEnv, runHardenedGit } from '../tools/benchmark-sandbox.js';
import { killProcessTree } from '../tools/sandbox.js';

const execFileAsync = promisify(execFile);

export const SWEBENCH_DOCKER_PRESETS = Object.freeze({
  epoch: 'ghcr.io/epoch-research/swe-bench.eval.x86_64.{instance_id}:latest',
  official: 'swebench/sweb.eval.x86_64.{instance_id}:latest',
});

export const DEFAULT_TESTBED_PATH =
  '/opt/miniconda3/envs/testbed/bin:/opt/miniconda3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const VALID_PULL_POLICIES = new Set(['missing', 'always', 'never']);

export const ANTI_CHEAT_GIT_SUBCOMMANDS = new Set([
  'commit',
  'reset',
  'checkout',
  'switch',
  'restore',
  'revert',
  'rebase',
  'cherry-pick',
  'merge',
  'am',
  'fetch',
  'pull',
  'push',
  'remote',
  'clone',
  'tag',
  'branch',
  'reflog',
  'for-each-ref',
  'show-ref',
  'cat-file',
  'update-ref',
  'fsck',
  'ls-remote',
  'stash',
  'worktree',
  'submodule',
  'bundle',
  'notes',
  'replace',
  'bisect',
  'filter-branch',
  'gc',
  'prune',
  'repack',
  'verify-pack',
  'unpack-objects',
  'symbolic-ref',
  'name-rev',
  'describe',
]);

const SAFE_CONTAINER_GIT_SUBCOMMANDS = new Set([
  'diff',
  'status',
  'show',
  'log',
  'ls-files',
  'grep',
  'blame',
  'shortlog',
  'rev-parse',
  'check-ignore',
]);

const SAFE_HOST_GIT_SUBCOMMANDS = new Set(['diff', 'status', 'show', 'log']);

export const BLOCKED_GIT_FLAGS = new Set([
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

const GIT_PRE_SUBCMD_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--exec-path',
]);

const CONTAINER_BLOCKED_COMMANDS = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'ftp',
  'socat',
  'nmap',
  'docker',
  'podman',
  'ctr',
  'nerdctl',
  'kubectl',
  'mount',
  'umount',
  'chroot',
  'pivot_root',
  'nsenter',
  'unshare',
  'insmod',
  'modprobe',
  'kexec',
  'reboot',
  'shutdown',
  'halt',
  'poweroff',
  'sudo',
  'su',
  'doas',
  'mkfs',
  'fdisk',
  'parted',
  'dd',
  'eval',
]);

const CONTAINER_SAFE_COMMANDS = new Set([
  'pytest',
  'py.test',
  'python',
  'python3',
  'python3.8',
  'python3.9',
  'python3.10',
  'python3.11',
  'python3.12',
  'python3.13',
  'runtests.py',
  'tox',
  'nox',
  'unittest',
  'coverage',
  'sphinx-build',
  'pip',
  'pip3',
  'conda',
  'make',
  'cmake',
  'meson',
  'ninja',
  'cython',
  'flake8',
  'ruff',
  'mypy',
  'pylint',
  'black',
  'isort',
  'git',
  'node',
  'npm',
  'npx',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'find',
  'fd',
  'ls',
  'll',
  'dir',
  'tree',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'nl',
  'sed',
  'awk',
  'gawk',
  'mawk',
  'cut',
  'tr',
  'wc',
  'sort',
  'uniq',
  'comm',
  'join',
  'paste',
  'diff',
  'cmp',
  'xargs',
  'tee',
  'echo',
  'printf',
  'env',
  'printenv',
  'pwd',
  'which',
  'whereis',
  'type',
  'command',
  'realpath',
  'readlink',
  'dirname',
  'basename',
  'stat',
  'file',
  'cd',
  'pushd',
  'popd',
  'mkdir',
  'touch',
  'cp',
  'mv',
  'rm',
  'ln',
  'chmod',
  'patch',
  'true',
  'false',
  'test',
  '[',
  '[[',
  ':',
  'uname',
  'nproc',
  'date',
  'sleep',
  'timeout',
  'time',
  'nice',
  'nohup',
  'export',
  'unset',
  'bash',
  'sh',
]);

const COMMAND_WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'timeout', 'nice', 'time', 'stdbuf']);

const DANGEROUS_ENV_ASSIGN_KEYS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'PYTHONSTARTUP',
  'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_PARAMETERS',
  'GIT_TEMPLATE_DIR',
  'NODE_OPTIONS',
  'NODE_PATH',
]);

export const SAFE_PIP_SUBCOMMANDS = new Set(['list', 'show', 'freeze', 'check', '--version', '-V', 'help', '--help']);
const SAFE_HOST_PYTHON_MODULES = new Set([
  'pytest',
  'unittest',
  'doctest',
  'tox',
  'sphinx',
  'sphinx.cmd.build',
  'py_compile',
]);

const DIRECT_GIT_INTERNALS_RE =
  /\.git[\\/]+(?:objects|refs|logs|packed-refs|info|hooks|shallow|fetch_head|orig_head)(?:[\\/\s;|&)'"`]|$)/i;
const DIRECT_GIT_DIR_TOKEN_RE = /(?:^|[\s;|&(/\\])\.git(?:[\\/\s;|&)]|$)/i;
const GIT_CHEAT_FLAGS_RE =
  /^(?:--all|--branches(?:=.*)?|--tags(?:=.*)?|--remotes(?:=.*)?|--glob(?:=.*)?|--reflog|--indexed-objects)$/i;
export const PY_CHEAT_GIT_CALL_RE =
  /(?:\.git[\\/]|--all|--branches|--tags|--remotes|--glob|\bgit\s+(?:commit|reset|checkout|switch|restore|revert|rebase|cherry-pick|merge|am|fetch|pull|push|remote|clone|tag|branch|reflog|for-each-ref|show-ref|cat-file|update-ref|fsck)\b|['"]git['"]\s*,\s*['"](?:commit|reset|checkout|switch|restore|revert|rebase|cherry-pick|merge|am|fetch|pull|push|remote|clone|tag|branch|reflog|for-each-ref|show-ref|cat-file|update-ref|fsck)['"])/i;

function stripWinExtendedPrefix(p) {
  if (process.platform === 'win32' && typeof p === 'string') {
    if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
    if (p.startsWith('\\\\?\\')) return p.slice(4);
  }
  return p;
}

function realpathIfExists(targetPath) {
  const abs = resolve(String(targetPath));
  try {
    return stripWinExtendedPrefix(realpathSync(abs));
  } catch {
    return stripWinExtendedPrefix(abs);
  }
}

function chmodTreeTopDown(rootPath, { chmodSyncImpl, readdirSyncImpl, lstatSyncImpl }) {
  let rootIsSymlink = false;
  let chmoddedRoot = false;
  const visit = (entryPath, isRoot) => {
    let stat = null;
    try {
      stat = lstatSyncImpl(entryPath);
    } catch {
      return;
    }
    if (stat?.isSymbolicLink?.()) {
      if (isRoot) rootIsSymlink = true;
      return;
    }
    try {
      chmodSyncImpl(entryPath, 0o777);
      if (isRoot) chmoddedRoot = true;
    } catch {
      // Ignore per-entry chmod errors so sibling entries still get processed.
    }
    if (stat?.isDirectory?.()) {
      let entries = [];
      try {
        entries = readdirSyncImpl(entryPath);
      } catch {
        return;
      }
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : entry?.name;
        if (!name) continue;
        visit(join(entryPath, name), false);
      }
    }
  };
  visit(rootPath, true);
  if (!rootIsSymlink && !chmoddedRoot) {
    try {
      chmodSyncImpl(rootPath, 0o777);
    } catch {
      // Ignore fallback chmod errors on root path.
    }
  }
}

/**
 * Safely removes a directory or file path recursively, recovering from Linux
 * bind-mount permission errors via top-down `chmod 0777` and optional
 * passwordless `sudo -n rm -rf --`, never throwing on cleanup failure.
 */
export function safeRmRf(targetPath, opts = {}) {
  const {
    platform = process.platform,
    rmSyncImpl = rmSync,
    chmodSyncImpl = chmodSync,
    readdirSyncImpl = readdirSync,
    lstatSyncImpl = lstatSync,
    execFileSyncImpl = execFileSync,
    warn = console.warn,
  } = opts ?? {};

  if (!targetPath || !String(targetPath).trim()) {
    return false;
  }

  let resolved = '';
  try {
    resolved = resolve(String(targetPath));
    if (resolved === '/' || parse(resolved).root === resolved) {
      warn(`[CLEANUP-WARN] Refusing to remove root path: ${resolved}`);
      return false;
    }

    if (rmSyncImpl === rmSync && !existsSync(resolved)) {
      return true;
    }

    try {
      rmSyncImpl(resolved, { recursive: true, force: true, maxRetries: 2 });
      return true;
    } catch (err) {
      const msg = String(err?.message || '');
      const code = String(err?.code || '');
      if (code === 'ENOENT') {
        return true;
      }
      const isPermErr =
        ['EACCES', 'EPERM', 'ENOTEMPTY'].includes(code) ||
        /permission denied|EACCES|EPERM/i.test(msg);
      if (!isPermErr) {
        throw err;
      }

      chmodTreeTopDown(resolved, { chmodSyncImpl, readdirSyncImpl, lstatSyncImpl });
      try {
        rmSyncImpl(resolved, { recursive: true, force: true, maxRetries: 2 });
        return true;
      } catch (retryErr) {
        if (String(retryErr?.code || '') === 'ENOENT') {
          return true;
        }
        if (platform !== 'win32') {
          execFileSyncImpl('sudo', ['-n', 'rm', '-rf', '--', resolved], {
            stdio: 'ignore',
            timeout: 15_000,
          });
          return true;
        }
        throw retryErr;
      }
    }
  } catch (outerErr) {
    try {
      warn(
        `[CLEANUP-WARN] Failed to remove temporary path ${resolved || String(targetPath)}: ${String(outerErr?.message || outerErr)}`,
      );
    } catch {
      // Never throw from cleanup warnings.
    }
    return false;
  }
}

function buildDockerClientEnv() {
  const env = buildStrictSandboxEnv({ tmpDir: tmpdir() });
  for (const key of [
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
  ]) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = String(val);
    }
  }
  return env;
}

function validateNonEmptyFlagArg(val, label) {
  const s = String(val ?? '').trim();
  if (!s || /[\r\n\0]/.test(s) || s.startsWith('-')) {
    throw new Error(`Invalid ${label}: "${val}"`);
  }
  return s;
}

async function invokeExecFile(execFileImpl, bin, args, opts = {}) {
  if (!execFileImpl) {
    return execFileAsync(bin, args, opts);
  }
  if (execFileImpl === execFile || execFileImpl.length >= 4) {
    return new Promise((resolveFn, rejectFn) => {
      execFileImpl(bin, args, opts, (err, stdout = '', stderr = '') => {
        if (err) {
          if (err.stdout === undefined) err.stdout = stdout;
          if (err.stderr === undefined) err.stderr = stderr;
          rejectFn(err);
        } else {
          resolveFn({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        }
      });
    });
  }
  const res = await execFileImpl(bin, args, opts);
  if (typeof res === 'string') {
    return { stdout: res, stderr: '' };
  }
  return {
    stdout: String(res?.stdout ?? ''),
    stderr: String(res?.stderr ?? ''),
  };
}

async function execGit(gitRunner, args, cwd, { allowNonZero = false, timeoutMs = 120_000 } = {}) {
  if (!gitRunner) {
    const res = await runHardenedGit(args, {
      cwd,
      allowNetwork: false,
      timeoutMs,
    });
    if (!allowNonZero && (res.timedOut || res.exitCode !== 0)) {
      throw new Error(
        `git ${args.join(' ')} failed in ${cwd}: ${res.stderr?.trim() || (res.timedOut ? 'timeout' : `exit ${res.exitCode}`)}`,
      );
    }
    return {
      exitCode: Number.isInteger(res.exitCode) ? res.exitCode : 1,
      stdout: String(res.stdout ?? ''),
      stderr: String(res.stderr ?? ''),
    };
  }

  try {
    const raw = await gitRunner(args, { cwd });
    const parsed =
      typeof raw === 'string'
        ? { exitCode: 0, stdout: raw, stderr: '' }
        : {
            exitCode: Number.isInteger(raw?.exitCode) ? raw.exitCode : Number.isInteger(raw?.status) ? raw.status : 0,
            stdout: String(raw?.stdout ?? ''),
            stderr: String(raw?.stderr ?? ''),
          };
    if (!allowNonZero && parsed.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${parsed.stderr.trim() || `exit ${parsed.exitCode}`}`);
    }
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT' || !allowNonZero) throw err;
    return {
      exitCode: Number.isInteger(err?.code) ? err.code : Number.isInteger(err?.status) ? err.status : 1,
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? err?.message ?? ''),
    };
  }
}

/**
 * Resolves a Docker image name from an explicit `--docker-image` pattern or a
 * named preset (`epoch` | `official`), substituting `{instance_id}`, `{repo}`,
 * and `{repo_slug}`.
 */
export function resolveSweBenchDockerImage({ dockerImage = null, dockerPreset = null, instance } = {}) {
  let presetPattern = null;
  if (dockerPreset !== null && dockerPreset !== undefined) {
    const key = String(dockerPreset).trim();
    if (!Object.hasOwn(SWEBENCH_DOCKER_PRESETS, key)) {
      throw new Error(
        `Invalid dockerPreset "${dockerPreset}"; expected one of: ${Object.keys(SWEBENCH_DOCKER_PRESETS).join(', ')}`,
      );
    }
    presetPattern = SWEBENCH_DOCKER_PRESETS[key];
  }

  const explicit = dockerImage !== null && dockerImage !== undefined ? String(dockerImage).trim() : '';
  const pattern = explicit || presetPattern;
  if (!pattern) return null;

  const rawInstanceId = String(instance?.instance_id ?? instance?.id ?? '').trim();
  const instanceId = rawInstanceId.toLowerCase();
  const repo = String(instance?.repo ?? '').trim();
  const repoSlug = repo.replace(/\//g, '__');

  if (pattern.includes('{instance_id}') && !instanceId) {
    throw new Error('SWE-bench instance.instance_id is required to resolve Docker image pattern');
  }

  return pattern
    .replace(/\{instance_id\}/g, instanceId)
    .replace(/\{repo\}/g, repo || 'repo')
    .replace(/\{repo_slug\}/g, repoSlug || 'repo');
}

/**
 * Ensures a Docker image is available locally according to `pull` policy
 * (`missing`, `always`, or `never`).
 */
export async function ensureDockerImage(
  image,
  { pull = 'missing', dockerBin = 'docker', execFileImpl = null, pullTimeoutMs = 900_000 } = {},
) {
  const img = validateNonEmptyFlagArg(image, 'Docker image');
  if (!VALID_PULL_POLICIES.has(pull)) {
    throw new Error(`Invalid pull policy "${pull}"; expected one of: missing, always, never`);
  }

  const env = buildDockerClientEnv();
  const effectivePullTimeoutMs = Math.max(900_000, Number(pullTimeoutMs ?? 900_000) || 900_000);
  if (pull === 'always') {
    try {
      await invokeExecFile(execFileImpl, dockerBin, ['pull', img], {
        env,
        windowsHide: true,
        timeout: effectivePullTimeoutMs,
        maxBuffer: 20 * 1024 * 1024,
      });
      return { image: img, pulled: true, present: true };
    } catch (err) {
      throw new Error(
        `Failed to pull Docker image "${img}" (pull=always): ${err?.stderr?.trim() || err?.message || err}`,
      );
    }
  }

  try {
    await invokeExecFile(execFileImpl, dockerBin, ['image', 'inspect', img], {
      env,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { image: img, pulled: false, present: true };
  } catch (inspectErr) {
    if (pull === 'never') {
      throw new Error(
        `Docker image "${img}" is not available locally and pull policy is "never": ${inspectErr?.stderr?.trim() || inspectErr?.message || inspectErr}`,
      );
    }
    if (inspectErr?.code === 'ENOENT') {
      throw new Error(`Docker binary "${dockerBin}" not found: ${inspectErr.message}`);
    }
    try {
      await invokeExecFile(execFileImpl, dockerBin, ['pull', img], {
        env,
        windowsHide: true,
        timeout: effectivePullTimeoutMs,
        maxBuffer: 20 * 1024 * 1024,
      });
      return { image: img, pulled: true, present: true };
    } catch (pullErr) {
      throw new Error(
        `Docker image "${img}" was not found locally and docker pull failed: ${pullErr?.stderr?.trim() || pullErr?.message || pullErr}`,
      );
    }
  }
}

/**
 * Force-removes any leftover containers spawned from `image` and deletes the
 * image itself via `docker rmi -f`, tolerating already-missing images cleanly.
 */
export async function removeDockerImage(
  image,
  { dockerBin = 'docker', execFileImpl = null } = {},
) {
  const img = validateNonEmptyFlagArg(image, 'Docker image');
  const env = buildDockerClientEnv();

  let cids = [];
  try {
    const psRes = await invokeExecFile(
      execFileImpl,
      dockerBin,
      ['ps', '-aq', '--filter', `ancestor=${img}`],
      {
        env,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    cids = String(psRes.stdout ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    cids = [];
  }

  if (cids.length > 0) {
    try {
      await invokeExecFile(execFileImpl, dockerBin, ['rm', '-f', ...cids], {
        env,
        windowsHide: true,
        timeout: 30_000,
      });
    } catch {
      for (const cid of cids) {
        await invokeExecFile(execFileImpl, dockerBin, ['rm', '-f', cid], {
          env,
          windowsHide: true,
          timeout: 15_000,
        }).catch(() => {});
      }
    }
  }

  try {
    await invokeExecFile(execFileImpl, dockerBin, ['rmi', '-f', img], {
      env,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { image: img, removed: true };
  } catch (err) {
    const msg = `${err?.stderr ?? ''} ${err?.message ?? ''}`;
    if (/no such image|not found|does not exist|no such object/i.test(msg)) {
      return { image: img, removed: false };
    }
    throw new Error(
      `Failed to remove Docker image "${img}": ${err?.stderr?.trim() || err?.message || err}`,
    );
  }
}

function commitMatches(headCommit, expectedCommit) {
  const head = String(headCommit ?? '').trim().toLowerCase();
  const expected = String(expectedCommit ?? '').trim().toLowerCase();
  if (!head || !expected) return false;
  if (head === expected) return true;
  if (expected.length >= 4 && head.startsWith(expected)) return true;
  if (head.length >= 4 && expected.startsWith(head)) return true;
  return false;
}

/**
 * Extracts `/testbed` from a SWE-bench Docker image into `targetDir`, cleans up
 * the temporary container in `finally`, normalizes Git settings for Windows/Linux
 * cross-platform diffs, and verifies `HEAD` matches `baseCommit`.
 */
export async function extractTestbedFromImage({
  image,
  targetDir,
  baseCommit = null,
  pull = 'missing',
  dockerBin = 'docker',
  execFileImpl = null,
  gitRunner = null,
} = {}) {
  const img = validateNonEmptyFlagArg(image, 'Docker image');
  if (!targetDir || !String(targetDir).trim()) {
    throw new Error('targetDir is required for extractTestbedFromImage');
  }
  const resolvedTargetDir = resolve(String(targetDir));
  await ensureDockerImage(img, { pull, dockerBin, execFileImpl });

  mkdirSync(resolvedTargetDir, { recursive: true });
  const env = buildDockerClientEnv();
  const createRes = await invokeExecFile(execFileImpl, dockerBin, ['create', '--network=none', img], {
    env,
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const cid = String(createRes.stdout ?? '').trim().split(/\r?\n/)[0]?.trim();
  if (!cid || cid.startsWith('-')) {
    throw new Error(`docker create did not return a valid container ID for image "${img}"`);
  }

  let usedSymlinkFallback = false;
  try {
    try {
      await invokeExecFile(execFileImpl, dockerBin, ['cp', `${cid}:/testbed/.`, resolvedTargetDir], {
        env,
        windowsHide: true,
        timeout: 300_000,
        maxBuffer: 20 * 1024 * 1024,
      });
    } catch (cpErr) {
      const cpErrMsg = `${cpErr?.stderr ?? ''} ${cpErr?.message ?? ''}`;
      if (!/privilege is not held|symbolic link|symlink/i.test(cpErrMsg)) {
        throw cpErr;
      }
      // Windows non-Developer-Mode environments cannot materialize Linux symlinks via `docker cp`.
      // Copy all non-symlink files (including .git and uncommitted env pins), then restore tracked symlinks via `core.symlinks=false`.
      usedSymlinkFallback = true;
      safeRmRf(resolvedTargetDir);
      mkdirSync(resolvedTargetDir, { recursive: true });
      const hostMount = realpathIfExists(resolvedTargetDir);
      try {
        await invokeExecFile(
          execFileImpl,
          dockerBin,
          [
            'run',
            '--rm',
            '--network=none',
            '--entrypoint',
            'sh',
            '-v',
            `${hostMount}:/out:rw`,
            img,
            '-c',
            'cd /testbed && find . -mindepth 1 ! -type l -print0 | tar --no-recursion --null -T - -cf - | tar -C /out -xm --no-same-owner --no-same-permissions -f -',
          ],
          {
            env,
            windowsHide: true,
            timeout: 300_000,
            maxBuffer: 20 * 1024 * 1024,
          },
        );
      } catch {
        safeRmRf(resolvedTargetDir);
        mkdirSync(resolvedTargetDir, { recursive: true });
        await invokeExecFile(
          execFileImpl,
          dockerBin,
          ['cp', `${cid}:/testbed/.git`, join(resolvedTargetDir, '.git')],
          {
            env,
            windowsHide: true,
            timeout: 300_000,
            maxBuffer: 20 * 1024 * 1024,
          },
        );
        await execGit(gitRunner, ['config', 'core.symlinks', 'false'], resolvedTargetDir);
        await execGit(gitRunner, ['checkout', '--force', '--detach', 'HEAD'], resolvedTargetDir);
      }
    }
  } finally {
    await invokeExecFile(execFileImpl, dockerBin, ['rm', '-f', cid], {
      env,
      windowsHide: true,
      timeout: 30_000,
    }).catch(() => {});
  }

  await execGit(gitRunner, ['config', 'core.autocrlf', 'false'], resolvedTargetDir);
  await execGit(gitRunner, ['config', 'core.filemode', 'false'], resolvedTargetDir);
  if (usedSymlinkFallback) {
    await execGit(gitRunner, ['config', 'core.symlinks', 'false'], resolvedTargetDir);
    const lsRes = await execGit(gitRunner, ['ls-files', '-s'], resolvedTargetDir, {
      allowNonZero: true,
    });
    const symlinkPaths = [];
    for (const line of String(lsRes.stdout ?? '').split(/\r?\n/)) {
      const m = line.match(/^120000\s+[0-9a-f]+\s+\d+\t(.+)$/);
      if (m?.[1]) {
        let p = m[1].trim();
        if (p.startsWith('"') && p.endsWith('"')) {
          try {
            p = JSON.parse(p);
          } catch {
            p = p.slice(1, -1);
          }
        }
        if (p) symlinkPaths.push(p);
      }
    }
    for (let i = 0; i < symlinkPaths.length; i += 50) {
      await execGit(
        gitRunner,
        ['checkout', '--force', '--', ...symlinkPaths.slice(i, i + 50)],
        resolvedTargetDir,
        { allowNonZero: true },
      );
    }
  }

  const userNameRes = await execGit(gitRunner, ['config', '--local', '--get', 'user.name'], resolvedTargetDir, {
    allowNonZero: true,
  });
  if (userNameRes.exitCode !== 0 || !userNameRes.stdout.trim()) {
    await execGit(gitRunner, ['config', 'user.name', 'Agent_US SWE-bench'], resolvedTargetDir);
  }
  const userEmailRes = await execGit(gitRunner, ['config', '--local', '--get', 'user.email'], resolvedTargetDir, {
    allowNonZero: true,
  });
  if (userEmailRes.exitCode !== 0 || !userEmailRes.stdout.trim()) {
    await execGit(gitRunner, ['config', 'user.email', 'swebench@agent-us.invalid'], resolvedTargetDir);
  }

  let headCommit = (await execGit(gitRunner, ['rev-parse', 'HEAD'], resolvedTargetDir)).stdout.trim();
  if (baseCommit && String(baseCommit).trim()) {
    const expected = String(baseCommit).trim();
    if (!commitMatches(headCommit, expected)) {
      const coRes = await execGit(gitRunner, ['checkout', '--detach', expected], resolvedTargetDir, {
        allowNonZero: true,
      });
      if (coRes.exitCode !== 0) {
        await execGit(gitRunner, ['reset', '--hard', expected], resolvedTargetDir, { allowNonZero: true });
        await execGit(gitRunner, ['checkout', '--detach', expected], resolvedTargetDir, { allowNonZero: true });
      }
      headCommit = (await execGit(gitRunner, ['rev-parse', 'HEAD'], resolvedTargetDir)).stdout.trim();
      if (!commitMatches(headCommit, expected)) {
        throw new Error(
          `Extracted testbed HEAD (${headCommit || 'unknown'}) does not match expected baseCommit (${expected})`,
        );
      }
    }
  }

  return { targetDir: resolvedTargetDir, headCommit };
}

/**
 * Strips remotes, tags, future/diverged branches, reflogs, and unreachable
 * Git objects from `repoDir` so the agent cannot peek past `baseCommit`.
 */
export async function scrubAntiCheatGitRefs(repoDir, baseCommit, { gitRunner = null } = {}) {
  const dir = resolve(String(repoDir ?? ''));
  const expectedBase = String(baseCommit ?? '').trim();
  if (!expectedBase) {
    throw new Error('baseCommit is required for scrubAntiCheatGitRefs');
  }

  const baseCheck = await execGit(gitRunner, ['rev-parse', '--verify', `${expectedBase}^{commit}`], dir);
  const resolvedBase = baseCheck.stdout.trim() || expectedBase;

  const removedRemotes = [];
  const remotesRes = await execGit(gitRunner, ['remote'], dir, { allowNonZero: true });
  const remotes = remotesRes.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const r of remotes) {
    await execGit(gitRunner, ['remote', 'remove', r], dir);
    removedRemotes.push(r);
  }

  // Detach HEAD at baseCommit BEFORE deleting refs/heads/* so Git does not block deleting the active branch.
  await execGit(gitRunner, ['checkout', '--detach', resolvedBase], dir);

  const refsRes = await execGit(
    gitRunner,
    ['for-each-ref', '--format=%(refname)%09%(objectname)'],
    dir,
  );
  const removedRefs = [];
  for (const line of refsRes.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tabIdx = trimmed.indexOf('\t');
    const refname = (tabIdx >= 0 ? trimmed.slice(0, tabIdx) : trimmed).trim();
    const sha = (tabIdx >= 0 ? trimmed.slice(tabIdx + 1) : '').trim();
    if (!refname || refname === 'HEAD') continue;

    if (
      refname.startsWith('refs/remotes/') ||
      refname.startsWith('refs/tags/') ||
      refname === 'refs/stash' ||
      refname.startsWith('refs/pull/') ||
      refname.startsWith('refs/notes/')
    ) {
      await execGit(gitRunner, ['update-ref', '-d', refname], dir);
      removedRefs.push(refname);
      continue;
    }

    if (refname.startsWith('refs/heads/')) {
      let isAncestor = false;
      if (sha) {
        const ancRes = await execGit(
          gitRunner,
          ['merge-base', '--is-ancestor', sha, resolvedBase],
          dir,
          { allowNonZero: true },
        );
        isAncestor = ancRes.exitCode === 0;
      }
      if (!isAncestor) {
        await execGit(gitRunner, ['update-ref', '-d', refname], dir);
        removedRefs.push(refname);
      }
    }
  }

  await execGit(gitRunner, ['reflog', 'expire', '--expire=all', '--all'], dir, { allowNonZero: true });
  await execGit(gitRunner, ['gc', '--prune=now', '--quiet'], dir, {
    allowNonZero: true,
    timeoutMs: 180_000,
  });

  return { removedRemotes, removedRefs };
}

function extractShellSegmentsAndSubshells(command) {
  const src = String(command ?? '');
  const segments = [];
  const subshells = [];
  let inSingle = false;
  let inDouble = false;
  let hasCompound = false;
  let cur = '';

  const pushSegment = () => {
    const trimmed = cur.trim();
    if (trimmed) segments.push(trimmed);
    cur = '';
  };

  const extractBalancedParen = (startIdx) => {
    let depth = 1;
    let sQuote = false;
    let dQuote = false;
    let j = startIdx;
    while (j < src.length && depth > 0) {
      const ch = src[j];
      if (sQuote) {
        if (ch === "'") sQuote = false;
        j++;
        continue;
      }
      if (dQuote) {
        if (ch === '\\' && j + 1 < src.length) {
          j += 2;
          continue;
        }
        if (ch === '"') dQuote = false;
        j++;
        continue;
      }
      if (ch === "'") sQuote = true;
      else if (ch === '"') dQuote = true;
      else if (ch === '\\' && j + 1 < src.length) {
        j += 2;
        continue;
      } else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      j++;
    }
    if (depth !== 0) return { unbalanced: true, inner: '', endIdx: src.length };
    return { unbalanced: false, inner: src.slice(startIdx, j - 1), endIdx: j };
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < src.length) {
        cur += ch + src[i + 1];
        i++;
        continue;
      }
      if (ch === '$' && src[i + 1] === '(') {
        hasCompound = true;
        const paren = extractBalancedParen(i + 2);
        if (paren.unbalanced) return { unbalanced: true, segments: [], subshells: [], hasCompound: true };
        subshells.push(paren.inner);
        cur += src.slice(i, paren.endIdx);
        i = paren.endIdx - 1;
        continue;
      }
      if (ch === '`') {
        hasCompound = true;
        const endTick = src.indexOf('`', i + 1);
        if (endTick === -1) return { unbalanced: true, segments: [], subshells: [], hasCompound: true };
        subshells.push(src.slice(i + 1, endTick));
        cur += src.slice(i, endTick + 1);
        i = endTick;
        continue;
      }
      if (ch === '"') inDouble = false;
      cur += ch;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      cur += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      cur += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < src.length) {
      cur += ch + src[i + 1];
      i++;
      continue;
    }
    if ((ch === '$' || ch === '<' || ch === '>') && src[i + 1] === '(') {
      hasCompound = true;
      const paren = extractBalancedParen(i + 2);
      if (paren.unbalanced) return { unbalanced: true, segments: [], subshells: [], hasCompound: true };
      subshells.push(paren.inner);
      cur += src.slice(i, paren.endIdx);
      i = paren.endIdx - 1;
      continue;
    }
    if (ch === '`') {
      hasCompound = true;
      const endTick = src.indexOf('`', i + 1);
      if (endTick === -1) return { unbalanced: true, segments: [], subshells: [], hasCompound: true };
      subshells.push(src.slice(i + 1, endTick));
      cur += src.slice(i, endTick + 1);
      i = endTick;
      continue;
    }
    if (ch === '(') {
      hasCompound = true;
      const paren = extractBalancedParen(i + 1);
      if (paren.unbalanced) return { unbalanced: true, segments: [], subshells: [], hasCompound: true };
      subshells.push(paren.inner);
      i = paren.endIdx - 1;
      continue;
    }
    if (ch === '&' && src[i + 1] === '&') {
      hasCompound = true;
      pushSegment();
      i++;
      continue;
    }
    if (ch === '|' && src[i + 1] === '|') {
      hasCompound = true;
      pushSegment();
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') {
      hasCompound = true;
      pushSegment();
      continue;
    }
    if (ch === '>' || ch === '<') {
      hasCompound = true;
    }
    cur += ch;
  }

  if (inSingle || inDouble) {
    return { unbalanced: true, segments: [], subshells: [], hasCompound: true };
  }
  pushSegment();

  const nestedSegments = [];
  for (const sub of subshells) {
    const inner = extractShellSegmentsAndSubshells(sub);
    if (inner.unbalanced) {
      return { unbalanced: true, segments: [], subshells: [], hasCompound: true };
    }
    nestedSegments.push(...inner.segments);
  }

  return {
    unbalanced: false,
    segments: [...segments, ...nestedSegments],
    subshells,
    hasCompound,
  };
}

function stripLeadingEnvVars(segment, { allowSubshellChars = false } = {}) {
  let rest = String(segment ?? '').trimStart();
  const assignments = [];
  while (rest) {
    const eqMatch = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(rest);
    if (!eqMatch) break;
    const key = eqMatch[1];
    let idx = eqMatch[0].length;
    if (idx >= rest.length) return { invalid: true, rest: '', assignments };

    const firstCh = rest[idx];
    let rawVal = '';
    if (firstCh === "'" || firstCh === '"') {
      const quote = firstCh;
      idx++;
      const start = idx;
      while (idx < rest.length) {
        if (quote === '"' && rest[idx] === '\\' && idx + 1 < rest.length) {
          idx += 2;
          continue;
        }
        if (rest[idx] === quote) break;
        idx++;
      }
      if (idx >= rest.length || rest[idx] !== quote) {
        return { invalid: true, rest: '', assignments };
      }
      rawVal = rest.slice(start, idx);
      idx++;
      if (quote === '"' && /\$\(|`/.test(rawVal) && !allowSubshellChars) {
        return { invalid: true, rest: '', assignments };
      }
    } else {
      const start = idx;
      while (idx < rest.length && !/[\s;&|]/.test(rest[idx])) {
        idx++;
      }
      rawVal = rest.slice(start, idx);
      if (/[><`]|(?:\$\()|(?:@\()|(?:<\()|(?:>\()/.test(rawVal) && !allowSubshellChars) {
        return { invalid: true, rest: '', assignments };
      }
    }

    if (!allowSubshellChars && (/\$\(|`|<\(|>\(|\$\{/.test(rawVal) || /[;\n\r]/.test(rawVal))) {
      return { invalid: true, rest: '', assignments };
    }
    if (DANGEROUS_ENV_ASSIGN_KEYS.has(key.toUpperCase())) {
      return { invalid: true, rest: '', assignments };
    }

    if (idx >= rest.length || !/\s/.test(rest[idx])) {
      // Bare assignment without command or malformed trailing token
      return { invalid: true, rest: '', assignments };
    }

    assignments.push({ key, value: rawVal });
    rest = rest.slice(idx).trimStart();
  }

  return { invalid: false, rest, assignments };
}

function unwrapTokens(rawTokens) {
  let idx = 0;
  while (idx < rawTokens.length) {
    const tok = rawTokens[idx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      const key = tok.slice(0, tok.indexOf('=')).toUpperCase();
      if (DANGEROUS_ENV_ASSIGN_KEYS.has(key)) return null;
      idx++;
      continue;
    }
    const base = basename(tok).toLowerCase().replace(/\.exe$/, '');
    if (!COMMAND_WRAPPERS.has(base)) break;
    idx++;
    if (idx >= rawTokens.length) {
      // Standalone `env` (handled by caller when containerMode=true)
      return [tok];
    }
    while (idx < rawTokens.length) {
      const arg = rawTokens[idx];
      if (arg === '--') {
        idx++;
        break;
      }
      if (base === 'env' && (arg === '-u' || arg === '--unset' || arg === '-C' || arg === '--chdir')) {
        idx += 2;
        continue;
      }
      if (base === 'timeout' && (/^-[a-z]+$/i.test(arg) || /^\d/.test(arg))) {
        if (arg === '-k' || arg === '-s' || arg === '--signal' || arg === '--kill-after') {
          idx += 2;
        } else {
          idx++;
        }
        continue;
      }
      if (base === 'nice' && arg === '-n') {
        idx += 2;
        continue;
      }
      if (arg.startsWith('-')) {
        idx++;
        continue;
      }
      if (base === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
        const key = arg.slice(0, arg.indexOf('=')).toUpperCase();
        if (DANGEROUS_ENV_ASSIGN_KEYS.has(key)) return null;
        idx++;
        continue;
      }
      break;
    }
  }
  return rawTokens.slice(idx);
}

function isSafeGitSafeDirectoryConfigArgs(rest) {
  if (!Array.isArray(rest) || rest.length < 3) return false;
  if (String(rest[0] ?? '').toLowerCase() !== 'config') return false;
  let idx = 1;
  if (rest[idx] === '--global') idx++;
  if (rest[idx] === '--add') idx++;
  return (
    idx === rest.length - 2 &&
    rest[idx] === 'safe.directory' &&
    rest[idx + 1] === '/testbed'
  );
}

function isAntiCheatGitArgs(rest) {
  if (isSafeGitSafeDirectoryConfigArgs(rest)) {
    return false;
  }
  let subcmd = null;
  const subArgs = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = String(rest[i] ?? '');
    const flag = tok.split('=')[0];
    const lowerFlag = flag.toLowerCase();
    if (
      BLOCKED_GIT_FLAGS.has(flag) ||
      BLOCKED_GIT_FLAGS.has(lowerFlag) ||
      (!tok.startsWith('--') && (tok.startsWith('-c') || tok.startsWith('-C') || tok.startsWith('-o')))
    ) {
      return true;
    }
    if (!subcmd) {
      if (GIT_PRE_SUBCMD_VALUE_FLAGS.has(flag)) {
        i++;
        continue;
      }
      if (tok.startsWith('-')) continue;
      subcmd = tok.toLowerCase();
      continue;
    }
    subArgs.push(tok);
  }

  if (!subcmd) return false;
  if (ANTI_CHEAT_GIT_SUBCOMMANDS.has(subcmd)) return true;

  for (const arg of subArgs) {
    if (GIT_CHEAT_FLAGS_RE.test(arg)) return true;
    if (/(?:^|\/)refs\//i.test(arg) || arg.includes('@{')) return true;
    if (/^(?:FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)$/i.test(arg)) return true;
  }

  return false;
}

const SHELL_BINARIES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

function hasAntiCheatTextOrSegments(cmdText, depth = 0) {
  if (depth > 4) return true;
  const text = String(cmdText ?? '');
  if (analyzeCommand(text).hardBlocked) return true;
  const dequoted = text.replace(/['"`\\]/g, '');
  if (
    DIRECT_GIT_INTERNALS_RE.test(text) ||
    DIRECT_GIT_INTERNALS_RE.test(dequoted) ||
    DIRECT_GIT_DIR_TOKEN_RE.test(text) ||
    DIRECT_GIT_DIR_TOKEN_RE.test(dequoted)
  ) {
    return true;
  }

  const parsed = extractShellSegmentsAndSubshells(text);
  if (parsed.unbalanced) return true;
  for (const seg of parsed.segments) {
    if (segmentHasAntiCheatViolation(seg, depth + 1)) {
      return true;
    }
  }
  return false;
}

function segmentHasAntiCheatViolation(segment, depth = 0) {
  if (depth > 4) return true;
  const dequoted = segment.replace(/['"`\\]/g, '');
  if (
    DIRECT_GIT_INTERNALS_RE.test(segment) ||
    DIRECT_GIT_INTERNALS_RE.test(dequoted) ||
    DIRECT_GIT_DIR_TOKEN_RE.test(segment) ||
    DIRECT_GIT_DIR_TOKEN_RE.test(dequoted)
  ) {
    return true;
  }

  const syntax = scanCommandSyntax(segment);
  if (!syntax.tokens.length) return false;

  const unwrapped = unwrapTokens(syntax.tokens);
  if (!unwrapped || !unwrapped.length) return true;

  const head = basename(unwrapped[0]).toLowerCase().replace(/\.exe$/, '');
  const rest = unwrapped.slice(1);

  if (head === 'git') {
    return isAntiCheatGitArgs(rest);
  }

  if (SHELL_BINARIES.has(head)) {
    const cIdx = rest.findIndex((t) => t === '-c' || /^-[a-z]*c[a-z]*$/i.test(t));
    if (cIdx >= 0 && rest[cIdx + 1]) {
      return hasAntiCheatTextOrSegments(rest[cIdx + 1], depth + 1);
    }
  }

  if (head === 'python' || head === 'python3' || /^python3\.\d+$/.test(head)) {
    const cIdx = rest.findIndex((t) => (t.startsWith('-c') && !t.startsWith('--')) || t === '--command' || t.startsWith('--command='));
    if (cIdx >= 0) {
      const tok = rest[cIdx];
      const pyCode =
        tok.startsWith('-c') && tok.length > 2
          ? tok.slice(2)
          : tok.startsWith('--command=')
            ? tok.slice('--command='.length)
            : String(rest[cIdx + 1] ?? '');
      if (PY_CHEAT_GIT_CALL_RE.test(pyCode)) {
        return true;
      }
    }
  }

  return false;
}

function isSafeHostPythonCommand(rest) {
  if (!rest.length) return false;
  if (rest.length === 1 && (rest[0] === '--version' || rest[0] === '-V')) return true;

  let i = 0;
  while (i < rest.length) {
    const tok = rest[i];
    if ((tok.startsWith('-c') && !tok.startsWith('--')) || tok === '--command' || tok.startsWith('--command=')) {
      return false;
    }
    if (tok === '-W' || tok === '-X') {
      i += 2;
      continue;
    }
    if (tok === '-m' || (tok.startsWith('-m') && tok.length > 2)) {
      const mod = tok.length > 2 ? tok.slice(2) : rest[i + 1];
      if (!mod) return false;
      if (mod === 'pip') {
        const pipSub = tok.length > 2 ? rest[i + 1] : rest[i + 2];
        return Boolean(pipSub && SAFE_PIP_SUBCOMMANDS.has(pipSub));
      }
      return SAFE_HOST_PYTHON_MODULES.has(mod);
    }
    if (tok.startsWith('-')) {
      i++;
      continue;
    }
    const norm = tok.replace(/\\/g, '/');
    return (
      norm === 'tests/runtests.py' ||
      norm === './tests/runtests.py' ||
      norm === 'runtests.py' ||
      norm === './runtests.py' ||
      norm === 'bin/test' ||
      norm === './bin/test' ||
      /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.py)$/.test(norm) ||
      (norm === 'setup.py' && rest[i + 1] === 'test')
    );
  }
  return false;
}

function isSafeHostTestSegment(segment) {
  const stripped = stripLeadingEnvVars(segment, { allowSubshellChars: false });
  if (stripped.invalid || !stripped.rest) return false;

  const syntax = scanCommandSyntax(stripped.rest);
  if (syntax.hasCompound || syntax.hasSubstitution || syntax.unbalancedQuotes || !syntax.tokens.length) {
    return false;
  }

  const rawHead = syntax.tokens[0];
  const normHead = rawHead.replace(/\\/g, '/');
  const head = basename(normHead).toLowerCase().replace(/\.exe$/, '');
  const rest = syntax.tokens.slice(1);

  if (head === 'pytest' || head === 'py.test' || head === 'tox' || head === 'sphinx-build') {
    return true;
  }
  if (normHead === './tests/runtests.py' || normHead === 'tests/runtests.py' || normHead === './bin/test' || normHead === 'bin/test') {
    return true;
  }
  if (head === 'python' || head === 'python3') {
    return isSafeHostPythonCommand(rest);
  }
  if (head === 'git') {
    const sub = rest.find((t) => !t.startsWith('-'))?.toLowerCase();
    return Boolean(sub && SAFE_HOST_GIT_SUBCOMMANDS.has(sub) && !isAntiCheatGitArgs(rest));
  }
  if (head === 'npm') {
    return rest[0] === 'test' || rest[0] === 't' || (rest[0] === 'run' && rest[1] === 'test');
  }
  if (head === 'node') {
    if (rest[0] !== '--test') return false;
    return !rest.some((t) => {
      const f = t.split('=')[0].toLowerCase();
      return (
        f === '-e' ||
        f === '--eval' ||
        f === '-p' ||
        f === '--print' ||
        f === '-r' ||
        f === '--require' ||
        f === '--import' ||
        f === '--loader' ||
        f === '--experimental-loader'
      );
    });
  }
  return false;
}

function isSafeContainerSegment(segment) {
  const stripped = stripLeadingEnvVars(segment, { allowSubshellChars: true });
  if (stripped.invalid) return false;
  if (!stripped.rest) return false;

  const syntax = scanCommandSyntax(stripped.rest);
  if (syntax.unbalancedQuotes || !syntax.tokens.length) return false;

  const unwrapped = unwrapTokens(syntax.tokens);
  if (!unwrapped || !unwrapped.length) return false;

  const rawHead = unwrapped[0];
  const normHead = rawHead.replace(/\\/g, '/');
  const head = basename(normHead).toLowerCase().replace(/\.exe$/, '');
  const rest = unwrapped.slice(1);

  if (CONTAINER_BLOCKED_COMMANDS.has(head)) return false;

  if (head === 'sh' || head === 'bash') {
    const cIdx = rest.findIndex((t) => t === '-c' || /^-[a-z]*c[a-z]*$/i.test(t));
    if (cIdx < 0 || !rest[cIdx + 1]) return false;
    return isAuthorizedSweBenchCommand(rest[cIdx + 1], { containerMode: true });
  }

  if (head === 'git') {
    if (isSafeGitSafeDirectoryConfigArgs(rest)) return true;
    if (isAntiCheatGitArgs(rest)) return false;
    const sub = rest.find((t) => !t.startsWith('-'))?.toLowerCase();
    if (!sub) return rest.every((t) => t === '--version' || t === '-v' || t === '--help');
    return SAFE_CONTAINER_GIT_SUBCOMMANDS.has(sub);
  }

  if (head === 'pip' || head === 'pip3') {
    return Boolean(rest[0] && SAFE_PIP_SUBCOMMANDS.has(rest[0]));
  }

  if (head === 'python' || head === 'python3' || /^python3\.\d+$/.test(head)) {
    const mIdx = rest.findIndex((t) => t === '-m' || (t.startsWith('-m') && t.length > 2));
    if (mIdx >= 0) {
      const tok = rest[mIdx];
      const mod = tok.length > 2 ? tok.slice(2) : rest[mIdx + 1];
      if (mod === 'pip') {
        const pipSub = tok.length > 2 ? rest[mIdx + 1] : rest[mIdx + 2];
        return Boolean(pipSub && SAFE_PIP_SUBCOMMANDS.has(pipSub));
      }
    }
    return true;
  }

  if (head === 'conda') {
    return ['list', 'info', 'env', '--version', '-V'].includes(rest[0]);
  }

  if (head === 'npm') {
    return ['test', 't', 'run', 'list', 'ls', '--version', '-v'].includes(rest[0]);
  }

  if (
    normHead === './tests/runtests.py' ||
    normHead === 'tests/runtests.py' ||
    normHead === './bin/test' ||
    normHead === 'bin/test' ||
    normHead.endsWith('/runtests.py') ||
    normHead.endsWith('/bin/test')
  ) {
    return true;
  }

  if (head === 'xargs') {
    const target = rest.find((t) => !t.startsWith('-'));
    if (target && CONTAINER_BLOCKED_COMMANDS.has(basename(target).toLowerCase())) {
      return false;
    }
    return true;
  }

  return CONTAINER_SAFE_COMMANDS.has(head);
}

/**
 * Validates whether a command is permitted during SWE-bench execution.
 * Enforces hard-blocks and anti-cheat Git ref/history guards unconditionally
 * across chained segments and subshells, even when `containerMode` is enabled.
 */
export function isAuthorizedSweBenchCommand(
  command,
  { customTestCmd = null, containerMode = false } = {},
) {
  const cmd = String(command ?? '').trim();
  if (!cmd || /[\0]/.test(cmd)) return false;

  const analysis = analyzeCommand(cmd);
  if (analysis.hardBlocked) return false;

  const parsed = extractShellSegmentsAndSubshells(cmd);
  if (parsed.unbalanced || !parsed.segments.length) return false;

  if (hasAntiCheatTextOrSegments(cmd)) {
    return false;
  }

  if (customTestCmd && cmd === String(customTestCmd).trim()) {
    return true;
  }

  if (!containerMode) {
    if (parsed.hasCompound || parsed.segments.length !== 1 || parsed.subshells.length > 0) {
      return false;
    }
    return isSafeHostTestSegment(parsed.segments[0]);
  }

  return parsed.segments.every((seg) => isSafeContainerSegment(seg));
}

/**
 * Isolated per-instance SWE-bench Docker container adapter mounting the host
 * workspace at `/testbed` and enforcing Conda PATH and anti-cheat command guards.
 */
export class SweBenchDockerAdapter {
  constructor({
    image,
    workspaceRoot,
    pull = 'missing',
    network = 'none',
    memory = '2g',
    memorySwap = undefined,
    cpus = '2',
    timeoutMs = 120_000,
    dockerBin = 'docker',
    spawnImpl = null,
    execFileImpl = null,
    customTestCmd = null,
    maxCaptureBytes = 4 * 1024 * 1024,
    platform = null,
    getuid = null,
    getgid = null,
  } = {}) {
    this.image = validateNonEmptyFlagArg(image, 'Docker image');
    if (!workspaceRoot || !String(workspaceRoot).trim()) {
      throw new Error('workspaceRoot is required for SweBenchDockerAdapter');
    }
    if (!VALID_PULL_POLICIES.has(pull)) {
      throw new Error(`Invalid pull policy "${pull}"; expected one of: missing, always, never`);
    }
    this.workspaceRoot = resolve(String(workspaceRoot));
    this.pull = pull;
    this.network = validateNonEmptyFlagArg(network, 'Docker network');
    this.memory = validateNonEmptyFlagArg(memory, 'Docker memory');
    const resolvedMemorySwap =
      memorySwap === undefined
        ? (this.memory.toLowerCase() === '2g' ? '2.5g' : null)
        : memorySwap === null || String(memorySwap).trim() === ''
          ? null
          : validateNonEmptyFlagArg(memorySwap, 'Docker memorySwap');
    this.memorySwap = resolvedMemorySwap;
    this.cpus = validateNonEmptyFlagArg(cpus, 'Docker cpus');
    this.timeoutMs = Math.max(50, Number(timeoutMs ?? 120_000) || 120_000);
    this.dockerBin = String(dockerBin || 'docker').trim();
    this.spawnImpl = spawnImpl;
    this.execFileImpl = execFileImpl;
    this.customTestCmd = customTestCmd;
    this.maxCaptureBytes = Math.max(1024, Number(maxCaptureBytes) || 4 * 1024 * 1024);
    this.platform = platform;
    this.getuid = getuid;
    this.getgid = getgid;

    this.isSweBenchContainer = true;
    this.containerId = null;
    this._startPromise = null;
    this._destroyed = false;
  }

  resolveBackend() {
    return {
      mode: 'docker',
      tier: 'strong-os-isolation',
      backend: this,
    };
  }

  capabilities() {
    return {
      mode: 'docker',
      isolationTier: 'strong-os-isolation',
      strongOsIsolation: true,
      networkIsolated: this.network === 'none',
      pathConfined: true,
      isSweBenchContainer: true,
    };
  }

  mapHostCwdToContainer(cwd = this.workspaceRoot) {
    const raw = cwd == null || String(cwd).trim() === '' ? this.workspaceRoot : String(cwd).trim();
    const rootAbs = resolve(this.workspaceRoot);

    const checkInside = (base, cand) => {
      const rel = relative(base, cand);
      if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel)) {
        throw new Error(`Working directory "${cwd}" escapes workspaceRoot "${this.workspaceRoot}"`);
      }
      return rel;
    };

    const validateInsideWithSymlinks = (targetAbs) => {
      const lexicalRel = checkInside(rootAbs, targetAbs);
      let canonicalRel = lexicalRel;
      if (existsSync(rootAbs)) {
        const realRoot = realpathIfExists(rootAbs);
        let probe = targetAbs;
        const tail = [];
        while (!existsSync(probe)) {
          const parent = resolve(probe, '..');
          if (parent === probe) break;
          tail.unshift(basename(probe));
          probe = parent;
        }
        if (existsSync(probe)) {
          const realBase = realpathIfExists(probe);
          const realTarget = tail.length ? resolve(realBase, ...tail) : realBase;
          canonicalRel = checkInside(realRoot, realTarget);
        }
      }
      return canonicalRel;
    };

    const rawPosix = raw.replace(/\\/g, '/');
    if (rawPosix === '/testbed' || rawPosix.startsWith('/testbed/')) {
      const normPosix = posixPath.normalize(rawPosix).replace(/\/+$/, '') || '/';
      if (normPosix === '/testbed') return '/testbed';
      if (!normPosix.startsWith('/testbed/')) {
        throw new Error(`Working directory "${cwd}" escapes workspaceRoot "${this.workspaceRoot}"`);
      }
      const subRel = normPosix.slice('/testbed/'.length);
      validateInsideWithSymlinks(join(rootAbs, subRel));
      return normPosix;
    }

    const trimmedPosix = rawPosix.replace(/\/+$/, '');
    if ((trimmedPosix === 'testbed' || trimmedPosix === './testbed') && !existsSync(join(rootAbs, 'testbed'))) {
      return '/testbed';
    }

    const targetAbs = isAbsolute(raw) ? resolve(raw) : resolve(rootAbs, raw);
    const canonicalRel = validateInsideWithSymlinks(targetAbs);
    const posixRel = canonicalRel ? canonicalRel.split(/[\\/]/).filter(Boolean).join('/') : '';
    return posixRel ? posixPath.join('/testbed', posixRel) : '/testbed';
  }

  async start() {
    if (this.containerId) return this.containerId;
    if (this._startPromise) return this._startPromise;

    this._destroyed = false;
    this._startPromise = (async () => {
      try {
        await ensureDockerImage(this.image, {
          pull: this.pull,
          dockerBin: this.dockerBin,
          execFileImpl: this.execFileImpl,
        });

        const hostMount = realpathIfExists(this.workspaceRoot);
        const runArgs = [
          'run',
          '-d',
          '--rm',
          `--network=${this.network}`,
          `--memory=${this.memory}`,
          ...(this.memorySwap ? [`--memory-swap=${this.memorySwap}`] : []),
          `--cpus=${this.cpus}`,
          '-v',
          `${hostMount}:/testbed:rw`,
          '-w',
          '/testbed',
          '-e',
          `PATH=${DEFAULT_TESTBED_PATH}`,
          '-e',
          'CONDA_DEFAULT_ENV=testbed',
          '-e',
          'CONDA_PREFIX=/opt/miniconda3/envs/testbed',
          '-e',
          'PYTHONDONTWRITEBYTECODE=1',
          '-e',
          'MPLCONFIGDIR=/tmp/mpl',
          '-e',
          'GIT_TERMINAL_PROMPT=0',
          '-e',
          'GIT_CONFIG_COUNT=1',
          '-e',
          'GIT_CONFIG_KEY_0=safe.directory',
          '-e',
          'GIT_CONFIG_VALUE_0=/testbed',
          this.image,
          'tail',
          '-f',
          '/dev/null',
        ];

        const res = await invokeExecFile(this.execFileImpl, this.dockerBin, runArgs, {
          env: buildDockerClientEnv(),
          windowsHide: true,
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const cid = String(res.stdout ?? '').trim().split(/\r?\n/)[0]?.trim();
        if (!cid || cid.startsWith('-')) {
          throw new Error(`docker run did not return a valid container ID for image "${this.image}"`);
        }

        if (this._destroyed) {
          await invokeExecFile(this.execFileImpl, this.dockerBin, ['rm', '-f', cid], {
            env: buildDockerClientEnv(),
            windowsHide: true,
            timeout: 15_000,
          }).catch(() => {});
          throw new Error('SweBenchDockerAdapter destroyed during start()');
        }

        this.containerId = cid;
        await invokeExecFile(
          this.execFileImpl,
          this.dockerBin,
          [
            'exec',
            cid,
            'sh',
            '-c',
            'git config --global --add safe.directory /testbed 2>/dev/null || true',
          ],
          {
            env: buildDockerClientEnv(),
            windowsHide: true,
            timeout: 15_000,
          },
        ).catch(() => {});
        return cid;
      } finally {
        this._startPromise = null;
      }
    })();

    return this._startPromise;
  }

  async run(command, cwd = this.workspaceRoot, opts = {}) {
    let effectiveCwd = cwd;
    let effectiveOpts = opts;
    if (cwd && typeof cwd === 'object' && !Array.isArray(cwd)) {
      effectiveOpts = cwd;
      effectiveCwd = effectiveOpts.cwd ?? this.workspaceRoot;
    }

    const {
      timeoutMs = this.timeoutMs,
      signal = null,
      onOutput = null,
      skipAntiCheatGuard = false,
    } = effectiveOpts ?? {};

    const cmd = String(command ?? '').trim();
    if (!cmd) {
      throw new Error('Command must not be empty');
    }

    if (
      !skipAntiCheatGuard &&
      !isAuthorizedSweBenchCommand(cmd, { customTestCmd: this.customTestCmd, containerMode: true })
    ) {
      throw new Error(`Blocked unauthorized or anti-cheat SWE-bench command: ${cmd}`);
    }

    const containerCwd = this.mapHostCwdToContainer(effectiveCwd);
    if (signal?.aborted) {
      throw new Error('Command execution aborted');
    }

    const cid = await this.start();
    const spawnFn = this.spawnImpl ?? spawn;
    const isWin = process.platform === 'win32';
    const effectiveTimeoutMs = Math.max(50, Number(timeoutMs ?? this.timeoutMs ?? 120_000));

    return new Promise((resolveRun, rejectRun) => {
      const child = spawnFn(
        this.dockerBin,
        ['exec', '-w', containerCwd, cid, 'bash', '-c', cmd],
        {
          cwd: this.workspaceRoot,
          env: buildDockerClientEnv(),
          windowsHide: true,
          shell: false,
          detached: !isWin && spawnFn === spawn,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      let stdout = '';
      let stderr = '';
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      const terminateChild = () => {
        if (spawnFn === spawn) {
          killProcessTree(child);
        } else {
          try {
            child.kill?.('SIGKILL');
          } catch {
            // ignore
          }
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        terminateChild();
        resolveRun({
          exitCode: 124,
          stdout,
          stderr: `${stderr}\n[timeout after ${effectiveTimeoutMs}ms]`.trim(),
          timedOut: true,
        });
      }, effectiveTimeoutMs);

      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        terminateChild();
        rejectRun(new Error('Command execution aborted'));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      const appendChunk = (streamName, chunk) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
        if (streamName === 'stdout') {
          if (stdout.length < this.maxCaptureBytes) {
            stdout += text.slice(0, this.maxCaptureBytes - stdout.length);
          }
        } else if (stderr.length < this.maxCaptureBytes) {
          stderr += text.slice(0, this.maxCaptureBytes - stderr.length);
        }
        onOutput?.({ stream: streamName, chunk: text });
      };

      child.stdout?.on('data', (chunk) => appendChunk('stdout', chunk));
      child.stderr?.on('data', (chunk) => appendChunk('stderr', chunk));
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectRun(err);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveRun({
          exitCode: code ?? 1,
          stdout,
          stderr,
          timedOut: false,
        });
      });
    });
  }

  async exec(command, opts = {}) {
    return this.run(command, opts?.cwd ?? this.workspaceRoot, opts);
  }

  async repairHostWorkspacePermissions(cidOverride = null) {
    if ((this.platform ?? process.platform) === 'win32') return;
    const getuidFn = this.getuid ?? process.getuid;
    if (typeof getuidFn !== 'function') return;
    const cid = cidOverride ?? this.containerId;
    if (!cid) return;

    try {
      const uid = getuidFn();
      if (!Number.isInteger(uid) || uid < 0) return;
      const getgidFn = this.getgid ?? process.getgid;
      const rawGid = typeof getgidFn === 'function' ? getgidFn() : uid;
      const gid = Number.isInteger(rawGid) && rawGid >= 0 ? rawGid : uid;

      await invokeExecFile(
        this.execFileImpl,
        this.dockerBin,
        [
          'exec',
          '-u',
          '0',
          cid,
          'sh',
          '-c',
          `chown -R ${uid}:${gid} /testbed 2>/dev/null || chmod -R a+rwX /testbed 2>/dev/null || true`,
        ],
        {
          env: buildDockerClientEnv(),
          windowsHide: true,
          timeout: 15_000,
        },
      );
    } catch {
      // Best-effort permission repair; never fail container teardown.
    }
  }

  async destroy() {
    this._destroyed = true;
    if (this._startPromise) {
      await this._startPromise.catch(() => {});
    }
    const cid = this.containerId;
    this.containerId = null;
    if (!cid) return;
    await this.repairHostWorkspacePermissions(cid).catch(() => {});
    await invokeExecFile(this.execFileImpl, this.dockerBin, ['rm', '-f', cid], {
      env: buildDockerClientEnv(),
      windowsHide: true,
      timeout: 30_000,
    }).catch(() => {});
  }

  async close() {
    return this.destroy();
  }
}
