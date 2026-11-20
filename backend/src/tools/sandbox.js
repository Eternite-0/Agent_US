import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { sandbox as dockerSandbox } from '../tools.js';

const execFileAsync = promisify(execFile);

const PROTECTED_BASENAMES = new Set([
  '.pool-key',
  '.dev-token',
  '.provider-env.json',
]);

const SENSITIVE_ENV_KEY_RE =
  /^(?:BACKEND_TOKEN|BACKEND_VAULT|.*_(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)|AWS_.*|OPENAI_.*|ANTHROPIC_.*|DEEPSEEK_.*|GITHUB_TOKEN|NPM_TOKEN|GH_TOKEN)$/i;

/**
 * Strips sensitive host credentials and tokens before launching local child processes.
 */
export function sanitizeChildEnv(sourceEnv = process.env, { allowKeys = [] } = {}) {
  const allow = new Set(allowKeys);
  const out = {};
  for (const [k, v] of Object.entries(sourceEnv ?? {})) {
    if (v === undefined) continue;
    if (!allow.has(k) && SENSITIVE_ENV_KEY_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function findNearestExistingAncestor(targetPath) {
  let cur = resolve(targetPath);
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return cur;
}

/**
 * Resolves a workspace-confined path and prevents symlink/junction escapes outside workspaceRoot.
 */
export function resolveConfinedPath(workspaceRoot, rawPath) {
  const root = resolve(workspaceRoot);
  const input = String(rawPath ?? '').trim();
  if (!input) throw new Error('路径不能为空');
  const full = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const rel = relative(root, full);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error(`路径超出当前工作区边界: ${input}`);
  }
  const parts = rel ? rel.split(/[\\/]/) : [];
  if (parts.includes('.git')) {
    throw new Error('不允许直接修改或读取 .git 内部对象目录');
  }
  const base = parts.at(-1) ?? '';
  if (PROTECTED_BASENAMES.has(base)) {
    throw new Error(`受保护的密钥文件不允许访问: ${base}`);
  }

  // Symlink / junction escape check
  if (existsSync(root)) {
    const realRoot = realpathSync(root);
    const existing = findNearestExistingAncestor(full);
    if (existing) {
      const realExisting = realpathSync(existing);
      const realRel = relative(realRoot, realExisting);
      if (realRel.startsWith('..') || isAbsolute(realRel) || realRel.split(sep).includes('..')) {
        throw new Error(`符号链接路径逃逸出当前工作区边界: ${input}`);
      }
    }
  }

  return { full, rel: rel.replace(/\\/g, '/') || '.' };
}

/**
 * Terminates a child process and its descendant process tree across Windows & POSIX.
 */
export function killProcessTree(child) {
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
        process.kill(-pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}

export class HostSandboxAdapter {
  constructor({ allowEnvKeys = [], maxCaptureBytes = 256 * 1024 } = {}) {
    this.allowEnvKeys = allowEnvKeys;
    this.maxCaptureBytes = maxCaptureBytes;
  }

  capabilities() {
    return {
      mode: 'host',
      networkIsolated: false,
      fsRootReadOnly: false,
      capDropAll: false,
      envSanitized: true,
      pathConfined: true,
      symlinkEscapeBlocked: true,
      processTreeKill: true,
    };
  }

  run(command, cwd, { timeoutMs = 30000, signal, onOutput = null } = {}) {
    return new Promise((resolveRun, rejectRun) => {
      const isWin = process.platform === 'win32';
      const bin = isWin ? 'powershell.exe' : 'sh';
      const args = isWin
        ? ['-NoProfile', '-NonInteractive', '-Command', command]
        : ['-lc', command];

      const child = spawn(bin, args, {
        cwd,
        windowsHide: true,
        detached: !isWin,
        env: sanitizeChildEnv(process.env, { allowKeys: this.allowEnvKeys }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killProcessTree(child);
        resolveRun({
          exitCode: 124,
          stdout,
          stderr: `${stderr}\n[timeout after ${timeoutMs}ms]`.trim(),
          timedOut: true,
        });
      }, Math.min(Math.max(500, timeoutMs), 120000));

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killProcessTree(child);
        rejectRun(new Error('命令执行已取消'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk) => {
        const str = chunk.toString('utf8');
        if (stdout.length < this.maxCaptureBytes) stdout += str;
        onOutput?.({ stream: 'stdout', chunk: str });
      });
      child.stderr.on('data', (chunk) => {
        const str = chunk.toString('utf8');
        if (stderr.length < this.maxCaptureBytes) stderr += str;
        onOutput?.({ stream: 'stderr', chunk: str });
      });
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
          stdout,
          stderr,
          timedOut: false,
        });
      });
    });
  }
}

export class DockerSandboxAdapter {
  constructor({ image = 'agent-us/worker:1' } = {}) {
    this.image = image;
  }

  capabilities() {
    return {
      mode: 'container',
      networkIsolated: true,
      fsRootReadOnly: true,
      capDropAll: true,
      noNewPrivileges: true,
      memoryLimitMb: 256,
      pidsLimit: 64,
      envSanitized: true,
      pathConfined: true,
      symlinkEscapeBlocked: true,
      processTreeKill: true,
    };
  }

  async run(argv, files = {}, { signal, tty = false } = {}) {
    return dockerSandbox(argv, files, { signal, image: this.image, tty });
  }
}

/**
 * Manages temporary isolated Git Worktrees for parallel write agents.
 */
export class GitWorktreeIsolator {
  constructor() {
    this.active = new Set();
  }

  async acquire(workspaceRoot, prefix = 'agent-us-wt-') {
    const tmpDir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      await execFileAsync('git', ['worktree', 'add', '--detach', tmpDir, 'HEAD'], {
        cwd: workspaceRoot,
        windowsHide: true,
        timeout: 10000,
      });
      const entry = {
        path: tmpDir,
        workspaceRoot,
        released: false,
        async diffSummary() {
          try {
            const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
              cwd: tmpDir,
              windowsHide: true,
              timeout: 5000,
            });
            return stdout.trim();
          } catch {
            return '';
          }
        },
        release: async () => {
          if (entry.released) return;
          entry.released = true;
          this.active.delete(entry);
          await execFileAsync('git', ['worktree', 'remove', '--force', tmpDir], {
            cwd: workspaceRoot,
            windowsHide: true,
            timeout: 8000,
          }).catch(() => {});
          rmSync(tmpDir, { recursive: true, force: true });
        },
      };
      this.active.add(entry);
      return entry;
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }
  }

  async cleanupAll() {
    await Promise.allSettled([...this.active].map((e) => e.release()));
  }
}
