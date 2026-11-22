import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

export async function createFixtureWorkspace(task, { prefix = 'agent-us-eval-' } = {}) {
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
  }
  return workspaceRoot;
}

export async function removeFixtureWorkspace(workspaceRoot) {
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
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
    const out = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    return first || 'HEAD';
  } catch {
    return null;
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
