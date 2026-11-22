import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  BenchmarkSandbox,
  runHardenedGit,
  runHardenedGitSync,
} from '../tools/benchmark-sandbox.js';
import { DEFAULT_DEPENDENCY_POLICY } from './dependency-policy.js';

const COMMIT_SHA_40 = /^[0-9a-f]{40}$/i;
const COMMIT_SHA_ANY = /^[0-9a-f]{40,64}$/i;
const BASELINE_FILE_NAME = 'agent-us-eval-base';
const MIRROR_LOCKS = new Map();

function resolveGitDirSync(workspaceRoot) {
  const res = runHardenedGitSync(['rev-parse', '--git-dir'], {
    cwd: workspaceRoot,
    allowNetwork: false,
  });
  if (res.error || res.exitCode !== 0) {
    throw new Error(res.stderr?.trim() || 'Failed to resolve git directory');
  }
  const raw = res.stdout.trim();
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

async function runGit(args, { cwd = undefined, timeoutMs = 120_000, allowNetwork = false } = {}) {
  const res = await runHardenedGit(args, {
    cwd,
    timeoutMs,
    allowNetwork,
  });
  if (res.timedOut || res.exitCode !== 0) {
    const err = new Error(
      res.stderr?.trim() || `git ${args[0] ?? ''} exited with code ${res.exitCode}`,
    );
    err.exitCode = res.exitCode;
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    throw err;
  }
  return res.stdout;
}

async function mirrorHasCommit(mirrorPath, commitSha) {
  try {
    const out = await runGit(['-C', mirrorPath, 'cat-file', '-t', commitSha], {
      timeoutMs: 15_000,
      allowNetwork: false,
    });
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
  const allowNetwork = /^(?:https?:|ssh:|git:)/i.test(repoUrl);
  return withMirrorLock(mirrorPath, async () => {
    if (!existsSync(mirrorPath)) {
      await mkdir(join(mirrorPath, '..'), { recursive: true });
      const stagingPath = `${mirrorPath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await runGit(['clone', '--quiet', '--mirror', '--', repoUrl, stagingPath], {
          allowNetwork,
        });
        await rename(stagingPath, mirrorPath);
      } catch (error) {
        await removeFixtureWorkspace(stagingPath).catch(() => {});
        throw error;
      }
    } else if (!(await mirrorHasCommit(mirrorPath, expectedCommit))) {
      try {
        const currentOrigin = (
          await runGit(['-C', mirrorPath, 'remote', 'get-url', 'origin'], {
            timeoutMs: 15_000,
            allowNetwork: false,
          })
        ).trim();
        if (currentOrigin !== repoUrl) {
          await runGit(['-C', mirrorPath, 'remote', 'set-url', 'origin', '--', repoUrl], {
            timeoutMs: 15_000,
            allowNetwork: false,
          });
        }
      } catch {
        await runGit(['-C', mirrorPath, 'remote', 'add', 'origin', '--', repoUrl], {
          timeoutMs: 15_000,
          allowNetwork: false,
        }).catch(() => {});
      }
      await runGit(['-C', mirrorPath, 'fetch', '--quiet', '--prune', 'origin'], {
        allowNetwork,
      });
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

export async function createGitRepoWorkspace(
  task,
  {
    cacheDir = null,
    prefix = 'agent-us-eval-git-',
    retainOnError = false,
    sandbox = null,
    sandboxOptions = null,
  } = {},
) {
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
    await runGit(['clone', '--quiet', '--no-checkout', '--', mirrorPath, workspaceRoot], {
      allowNetwork: false,
    });
    await runGit(['-C', workspaceRoot, 'checkout', '--quiet', '--detach', expectedCommit], {
      allowNetwork: false,
    });

    const actualHead = (
      await runGit(['-C', workspaceRoot, 'rev-parse', 'HEAD'], {
        timeoutMs: 15_000,
        allowNetwork: false,
      })
    ).trim().toLowerCase();
    if (actualHead !== expectedCommit) {
      throw new Error(`Pinned commit verification failed: expected ${expectedCommit}, got ${actualHead}`);
    }

    await runGit(['-C', workspaceRoot, 'config', 'user.email', 'evaluation@agent-us.invalid'], {
      timeoutMs: 15_000,
      allowNetwork: false,
    });
    await runGit(['-C', workspaceRoot, 'config', 'user.name', 'Agent_US Evaluation'], {
      timeoutMs: 15_000,
      allowNetwork: false,
    });
    await writeWorkspaceBaselineCommitSync(workspaceRoot, expectedCommit);

    if (task?.fixture?.overlayFiles && typeof task.fixture.overlayFiles === 'object') {
      for (const [relativePath, content] of Object.entries(task.fixture.overlayFiles)) {
        const target = resolveConfinedFixtureFile(workspaceRoot, relativePath);
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, String(content), 'utf8');
      }
    }

    if (Array.isArray(task?.fixture?.verifyReadyCommand) && task.fixture.verifyReadyCommand.length > 0) {
      const activeSandbox = sandbox ?? new BenchmarkSandbox(sandboxOptions ?? {});
      activeSandbox.resolveBackend();
      const readyRes = await activeSandbox.execArgv(
        task.fixture.verifyReadyCommand.map(String),
        {
          workspaceRoot,
          cwd: workspaceRoot,
          allowWorkspaceNodeCli: Boolean(task?.metadata?.sandboxIsolation?.allowWorkspaceNodeCli),
          dependencyPolicy: task?.metadata?.dependencyPolicy ?? DEFAULT_DEPENDENCY_POLICY,
        },
      );
      if (readyRes.timedOut || readyRes.exitCode !== 0) {
        throw new Error(
          readyRes.stderr?.trim() ||
            `Offline readiness check failed with exit code ${readyRes.exitCode}`,
        );
      }
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
    const runInitGit = (args) => {
      const res = runHardenedGitSync(args, { cwd: workspaceRoot, allowNetwork: false });
      if (res.error || res.exitCode !== 0) {
        throw new Error(res.stderr?.trim() || `git ${args[0] ?? ''} failed`);
      }
      return res.stdout;
    };
    runInitGit(['init', '-q']);
    runInitGit(['config', 'user.email', 'evaluation@agent-us.invalid']);
    runInitGit(['config', 'user.name', 'Agent_US Evaluation']);
    runInitGit(['add', '-A']);
    runInitGit(['commit', '-qm', 'evaluation baseline']);
    const headCommit = runInitGit(['rev-parse', 'HEAD']).trim();
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
        const verifiedRes = runHardenedGitSync(
          ['rev-parse', '--verify', '--quiet', `${recorded}^{commit}`],
          { cwd: workspaceRoot, allowNetwork: false },
        );
        const verified =
          !verifiedRes.error && verifiedRes.exitCode === 0
            ? verifiedRes.stdout.trim().toLowerCase()
            : '';
        if (verified === recorded) return verified;
      }
    }
    const headRes = runHardenedGitSync(['rev-parse', '--verify', 'HEAD'], {
      cwd: workspaceRoot,
      allowNetwork: false,
    });
    const head =
      !headRes.error && headRes.exitCode === 0 ? headRes.stdout.trim().toLowerCase() : '';
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
    const typeRes = runHardenedGitSync(['cat-file', '-t', normalized], {
      cwd: workspaceRoot,
      allowNetwork: false,
    });
    if (typeRes.error || typeRes.exitCode !== 0 || typeRes.stdout.trim() !== 'commit') {
      return { ok: false, expectedCommit: normalized, recordedCommit, headCommit: null, reason: 'missing_pinned_commit' };
    }
    const headRes = runHardenedGitSync(['rev-parse', '--verify', 'HEAD'], {
      cwd: workspaceRoot,
      allowNetwork: false,
    });
    if (headRes.error || headRes.exitCode !== 0) {
      return { ok: false, expectedCommit: normalized, recordedCommit: null, headCommit: null, reason: 'pinned_history_tampered' };
    }
    const headCommit = headRes.stdout.trim().toLowerCase();
    const ancRes = runHardenedGitSync(['merge-base', '--is-ancestor', normalized, headCommit], {
      cwd: workspaceRoot,
      allowNetwork: false,
    });
    if (ancRes.error || ancRes.exitCode !== 0) {
      return { ok: false, expectedCommit: normalized, recordedCommit: null, headCommit: null, reason: 'pinned_history_tampered' };
    }
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
    const modRes = runHardenedGitSync(['diff', '--no-ext-diff', '--name-only', baseRef], {
      cwd: workspaceRoot,
      allowNetwork: false,
    });
    if (modRes.error || modRes.exitCode !== 0) return [];
    const untrackedRes = runHardenedGitSync(['ls-files', '--others', '--exclude-standard'], {
      cwd: workspaceRoot,
      allowNetwork: false,
    });
    if (untrackedRes.error || untrackedRes.exitCode !== 0) return [];
    return [
      ...new Set(
        `${modRes.stdout}\n${untrackedRes.stdout}`
          .split(/\r?\n/)
          .map(normalizePath)
          .filter(Boolean),
      ),
    ].sort();
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
