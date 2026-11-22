import { createHash } from 'node:crypto';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const COMMIT_SHA_40 = /^[0-9a-f]{40}$/i;
const COMMIT_SHA_ANY = /^[0-9a-f]{40,64}$/i;
const BASELINE_FILE_NAME = 'agent-us-eval-base';
const MIRROR_LOCKS = new Map();

function resolveGitDirSync(workspaceRoot) {
  const raw = execFileSync('git', ['rev-parse', '--git-dir'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return raw ? resolve(workspaceRoot, raw) : resolve(workspaceRoot, '.git');
}

function writeWorkspaceBaselineCommitSync(workspaceRoot, commitSha) {
  const normalized = String(commitSha ?? '').trim().toLowerCase();
  if (!COMMIT_SHA_ANY.test(normalized)) {
    throw new Error(`Invalid baseline commit SHA: ${commitSha}`);
  }
  const gitDir = resolveGitDirSync(workspaceRoot);
  return writeFile(join(gitDir, BASELINE_FILE_NAME), `${normalized}\n`, 'utf8');
}

async function withMirrorLock(mirrorPath, fn) {
  const key = resolve(mirrorPath);
  const previous = MIRROR_LOCKS.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolveGate) => {
    release = resolveGate;
  });
  MIRROR_LOCKS.set(key, previous.then(() => gate, () => gate));
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (MIRROR_LOCKS.get(key) === gate) {
      MIRROR_LOCKS.delete(key);
    }
  }
}

async function runGit(args, { cwd = undefined, timeoutMs = 120_000 } = {}) {
  const { stdout } = await execFile('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function mirrorHasCommit(mirrorPath, commitSha) {
  try {
    const out = await runGit(['-C', mirrorPath, 'cat-file', '-t', commitSha], { timeoutMs: 15_000 });
    return out.trim() === 'commit';
  } catch {
    return false;
  }
}

function normalizeRepoSource(repoUrl) {
  const raw = String(repoUrl ?? '').trim();
  if (!raw || raw.startsWith('-')) {
    throw new TypeError('task.fixture.repoUrl must be a valid non-empty git repository URL or path');
  }
  return raw;
}

function normalizePinnedCommit(commit) {
  const raw = String(commit ?? '').trim().toLowerCase();
  if (!COMMIT_SHA_40.test(raw)) {
    throw new TypeError(`task.fixture.commit must be an exact 40-char hex SHA (got ${String(commit ?? '')})`);
  }
  return raw;
}

function makeMirrorDirName(repoUrl) {
  const tail = repoUrl.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.git$/i, '').replace(/[^a-z0-9._-]+/gi, '-') || 'repo';
  const digest = createHash('sha256').update(repoUrl).digest('hex').slice(0, 16);
  return `${tail.slice(0, 32)}-${digest}.git`;
}

async function prepareMirror(repoUrl, expectedCommit, mirrorPath) {
  return withMirrorLock(mirrorPath, async () => {
    if (!existsSync(mirrorPath)) {
      await mkdir(join(mirrorPath, '..'), { recursive: true });
      const stagingPath = `${mirrorPath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await runGit(['clone', '--quiet', '--mirror', '--', repoUrl, stagingPath]);
        await rename(stagingPath, mirrorPath);
      } catch (error) {
        await removeFixtureWorkspace(stagingPath).catch(() => {});
        throw error;
      }
    } else if (!(await mirrorHasCommit(mirrorPath, expectedCommit))) {
      try {
        const currentOrigin = (await runGit(['-C', mirrorPath, 'remote', 'get-url', 'origin'], { timeoutMs: 15_000 })).trim();
        if (currentOrigin !== repoUrl) {
          await runGit(['-C', mirrorPath, 'remote', 'set-url', 'origin', '--', repoUrl], { timeoutMs: 15_000 });
        }
      } catch {
        await runGit(['-C', mirrorPath, 'remote', 'add', 'origin', '--', repoUrl], { timeoutMs: 15_000 }).catch(() => {});
      }
      await runGit(['-C', mirrorPath, 'fetch', '--quiet', '--prune', 'origin']);
    }

    if (!(await mirrorHasCommit(mirrorPath, expectedCommit))) {
      throw new Error(`Pinned commit ${expectedCommit} was not found in repository ${repoUrl}`);
    }
  });
}

function makeWritableRecursive(targetDir) {
  let entries;
  try {
    entries = readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(targetDir, entry.name);
    try {
      if (entry.isDirectory()) {
        chmodSync(full, 0o777);
        makeWritableRecursive(full);
      } else {
        chmodSync(full, 0o666);
      }
    } catch {
      // ignore permission errors on individual entries during best-effort cleanup
    }
  }
}

function resolveConfinedFixtureFile(workspaceRoot, relativePath) {
  const base = resolve(workspaceRoot);
  const relRaw = String(relativePath ?? '').replaceAll('\\', '/');
  if (!relRaw || relRaw.startsWith('/') || relRaw.split('/').includes('.git')) {
    throw new Error(`Unsafe fixture overlay path: ${relativePath}`);
  }
  const target = resolve(base, relRaw);
  const rel = relative(base, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Fixture path escapes workspace: ${relativePath}`);
  }
  return target;
}

export async function createGitRepoWorkspace(task, { cacheDir = null, prefix = 'agent-us-eval-git-', retainOnError = false } = {}) {
  const repoUrl = normalizeRepoSource(task?.fixture?.repoUrl);
  const expectedCommit = normalizePinnedCommit(task?.fixture?.commit);
  const resolvedCacheDir = cacheDir ?? task?.fixture?.cacheDir ?? null;
  let tempCacheRoot = null;
  let workspaceRoot = null;

  try {
    let mirrorPath;
    if (resolvedCacheDir) {
      const cacheBase = resolve(String(resolvedCacheDir));
      await mkdir(cacheBase, { recursive: true });
      mirrorPath = join(cacheBase, makeMirrorDirName(repoUrl));
    } else {
      tempCacheRoot = await mkdtemp(join(tmpdir(), `${prefix}cache-`));
      mirrorPath = join(tempCacheRoot, 'mirror.git');
    }

    await prepareMirror(repoUrl, expectedCommit, mirrorPath);

    workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
    await runGit(['clone', '--quiet', '--no-checkout', '--', mirrorPath, workspaceRoot]);
    await runGit(['-C', workspaceRoot, 'checkout', '--quiet', '--detach', expectedCommit]);

    const actualHead = (await runGit(['-C', workspaceRoot, 'rev-parse', 'HEAD'], { timeoutMs: 15_000 })).trim().toLowerCase();
    if (actualHead !== expectedCommit) {
      throw new Error(`Pinned commit verification failed: expected ${expectedCommit}, got ${actualHead}`);
    }

    await runGit(['-C', workspaceRoot, 'config', 'user.email', 'evaluation@agent-us.invalid'], { timeoutMs: 15_000 });
    await runGit(['-C', workspaceRoot, 'config', 'user.name', 'Agent_US Evaluation'], { timeoutMs: 15_000 });
    await writeWorkspaceBaselineCommitSync(workspaceRoot, expectedCommit);

    if (task?.fixture?.overlayFiles && typeof task.fixture.overlayFiles === 'object') {
      for (const [relativePath, content] of Object.entries(task.fixture.overlayFiles)) {
        const target = resolveConfinedFixtureFile(workspaceRoot, relativePath);
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, String(content), 'utf8');
      }
    }

    if (Array.isArray(task?.fixture?.verifyReadyCommand) && task.fixture.verifyReadyCommand.length > 0) {
      const [cmd, ...args] = task.fixture.verifyReadyCommand.map(String);
      await execFile(cmd, args, { cwd: workspaceRoot, encoding: 'utf8', timeout: 30_000 });
    } else if (task?.fixture?.requirePackageJson) {
      const pkgPath = join(workspaceRoot, 'package.json');
      if (!existsSync(pkgPath)) {
        throw new Error('Offline readiness check failed: package.json is missing');
      }
      JSON.parse(readFileSync(pkgPath, 'utf8'));
    }

    return workspaceRoot;
  } catch (error) {
    if (workspaceRoot) {
      if (retainOnError) retainFixtureWorkspace(workspaceRoot);
      else await removeFixtureWorkspace(workspaceRoot).catch(() => {});
    }
    throw error;
  } finally {
    if (tempCacheRoot) {
      await removeFixtureWorkspace(tempCacheRoot).catch(() => {});
    }
  }
}

export async function createFixtureWorkspace(task, options = {}) {
  if (task?.fixture?.repoUrl && task?.fixture?.commit) {
    return createGitRepoWorkspace(task, options);
  }
  const { prefix = 'agent-us-eval-' } = options;
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
  const files = task.fixture?.files ?? {};
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(workspaceRoot, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  if (task.metadata?.requiresGitDiff) {
    execFileSync('git', ['init', '-q'], { cwd: workspaceRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'evaluation@agent-us.invalid'], { cwd: workspaceRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Agent_US Evaluation'], { cwd: workspaceRoot, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: workspaceRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', 'evaluation baseline'], { cwd: workspaceRoot, stdio: 'ignore' });
    const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    await writeWorkspaceBaselineCommitSync(workspaceRoot, headCommit);
  }
  return workspaceRoot;
}

export async function removeFixtureWorkspace(workspaceRoot) {
  if (!workspaceRoot) return;
  try {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES') {
      makeWritableRecursive(workspaceRoot);
      await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
      return;
    }
    throw error;
  }
}

/**
 * Evaluation workspaces are deliberately isolated under the OS temp directory.
 * When a runtime does not confirm that it has stopped after cancellation or a
 * timeout, callers must retain the directory rather than risk deleting files
 * while a late tool call is still using them.
 */
export function retainFixtureWorkspace(workspaceRoot) {
  return workspaceRoot || null;
}

export function getWorkspaceBaselineCommit(workspaceRoot) {
  if (!workspaceRoot) return null;
  try {
    const gitDir = resolveGitDirSync(workspaceRoot);
    const baseFile = join(gitDir, BASELINE_FILE_NAME);
    if (existsSync(baseFile)) {
      const recorded = readFileSync(baseFile, 'utf8').trim().toLowerCase();
      if (COMMIT_SHA_ANY.test(recorded)) {
        const verified = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${recorded}^{commit}`], {
          cwd: workspaceRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim().toLowerCase();
        if (verified === recorded) return verified;
      }
    }
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase();
    return head || null;
  } catch {
    return null;
  }
}

export function verifyWorkspacePinnedBaseline(workspaceRoot, expectedCommit) {
  const normalized = String(expectedCommit ?? '').trim().toLowerCase();
  if (!workspaceRoot || !COMMIT_SHA_40.test(normalized)) {
    return { ok: false, expectedCommit: normalized || null, recordedCommit: null, headCommit: null, reason: 'invalid_expected_commit' };
  }
  try {
    const gitDir = resolveGitDirSync(workspaceRoot);
    const baseFile = join(gitDir, BASELINE_FILE_NAME);
    if (!existsSync(baseFile)) {
      return { ok: false, expectedCommit: normalized, recordedCommit: null, headCommit: null, reason: 'missing_baseline_marker' };
    }
    const recordedCommit = readFileSync(baseFile, 'utf8').trim().toLowerCase();
    if (recordedCommit !== normalized) {
      return { ok: false, expectedCommit: normalized, recordedCommit, headCommit: null, reason: 'baseline_marker_tampered' };
    }
    const objectType = execFileSync('git', ['cat-file', '-t', normalized], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (objectType !== 'commit') {
      return { ok: false, expectedCommit: normalized, recordedCommit, headCommit: null, reason: 'missing_pinned_commit' };
    }
    const headCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase();
    execFileSync('git', ['merge-base', '--is-ancestor', normalized, headCommit], {
      cwd: workspaceRoot,
      stdio: 'ignore',
    });
    return { ok: true, expectedCommit: normalized, recordedCommit, headCommit, reason: null };
  } catch {
    return { ok: false, expectedCommit: normalized, recordedCommit: null, headCommit: null, reason: 'pinned_history_tampered' };
  }
}

export function listWorkspaceChangedFiles(workspaceRoot) {
  if (!workspaceRoot) return [];
  const normalizePath = (value) => String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  try {
    const baseRef = getWorkspaceBaselineCommit(workspaceRoot) || 'HEAD';
    const modified = execFileSync('git', ['diff', '--no-ext-diff', '--name-only', baseRef], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...new Set(`${modified}\n${untracked}`.split(/\r?\n/).map(normalizePath).filter(Boolean))].sort();
  } catch {
    return [];
  }
}

export async function withFixtureWorkspace(task, fn, options = {}) {
  const workspaceRoot = await createFixtureWorkspace(task, options);
  try {
    return await fn(workspaceRoot);
  } finally {
    await removeFixtureWorkspace(workspaceRoot);
  }
}
