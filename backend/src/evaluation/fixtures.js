import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function createFixtureWorkspace(task, { prefix = 'agent-us-eval-' } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
  const files = task.fixture?.files ?? {};
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(workspaceRoot, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return workspaceRoot;
}

export async function removeFixtureWorkspace(workspaceRoot) {
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
}

export async function withFixtureWorkspace(task, fn, options = {}) {
  const workspaceRoot = await createFixtureWorkspace(task, options);
  try {
    return await fn(workspaceRoot);
  } finally {
    await removeFixtureWorkspace(workspaceRoot);
  }
}
