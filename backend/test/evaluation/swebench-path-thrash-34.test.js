import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rmDirSafe } from '../fixtures.js';
import {
  DEFAULT_CONTAINER_WORKDIR,
  SweBenchDockerAdapter,
  isAuthorizedSweBenchCommand,
  normalizeContainerWorkdir,
} from '../../src/evaluation/swebench-docker.js';
import { resolveConfinedPath } from '../../src/tools/sandbox.js';
import { createWorkspaceTools } from '../../src/workspace-tools.js';
import { buildSweBenchPrompt } from '../../scripts/benchmark-swebench.mjs';

function createImmediateFakeSpawn(exitCode = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('close', null);
  };
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from('ok\n', 'utf8'));
    child.emit('close', exitCode);
  });
  return child;
}

describe('SWE-bench Container Adapter containerWorkdir Mapping & Prompt Guidance', () => {
  const tempDirs = [];
  const makeTmp = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of tempDirs) {
      rmDirSafe(dir);
    }
  });

  test('1. normalizeContainerWorkdir validates safe absolute POSIX paths and defaults to /testbed', () => {
    assert.equal(DEFAULT_CONTAINER_WORKDIR, '/testbed');
    assert.equal(normalizeContainerWorkdir(), '/testbed');
    assert.equal(normalizeContainerWorkdir(''), '/testbed');
    assert.equal(normalizeContainerWorkdir('/testbed/'), '/testbed');
    assert.equal(normalizeContainerWorkdir('/workspace'), '/workspace');
    assert.equal(normalizeContainerWorkdir('/app/repo/'), '/app/repo');
    assert.equal(normalizeContainerWorkdir('/app/sub/../repo'), '/app/repo');

    assert.throws(() => normalizeContainerWorkdir('/'), /must not be root/);
    assert.throws(() => normalizeContainerWorkdir('relative/dir'), /safe absolute POSIX path/);
    assert.throws(() => normalizeContainerWorkdir('/bad path'), /safe absolute POSIX path/);
    assert.throws(() => normalizeContainerWorkdir('/bad;rm'), /safe absolute POSIX path/);
  });

  test('2. SweBenchDockerAdapter.mapContainerPathToHost translates default /testbed & custom containerWorkdir paths safely', () => {
    const ws = makeTmp('adapter-path-map-ws-');
    const outside = makeTmp('adapter-path-map-out-');
    mkdirSync(join(ws, 'django', 'db'), { recursive: true });
    mkdirSync(join(ws, '.git'), { recursive: true });
    writeFileSync(join(ws, 'django', 'db', 'models.py'), 'class Model: pass\n', 'utf8');
    writeFileSync(join(ws, 'django', 'models.py'), 'class RootModel: pass\n', 'utf8');
    writeFileSync(join(ws, '.git', 'config'), '[core]\n', 'utf8');
    writeFileSync(join(ws, '.dev-token'), 'secret\n', 'utf8');
    writeFileSync(join(outside, 'file.py'), 'outside\n', 'utf8');

    const defaultAdapter = new SweBenchDockerAdapter({
      image: 'local/testbed:latest',
      workspaceRoot: ws,
      pull: 'never',
    });
    assert.equal(defaultAdapter.containerWorkdir, '/testbed');
    assert.equal(defaultAdapter.capabilities().containerWorkdir, '/testbed');

    // Positive container -> host translation (default /testbed)
    assert.deepEqual(defaultAdapter.mapContainerPathToHost('/testbed'), {
      full: resolve(ws),
      rel: '.',
    });
    assert.deepEqual(defaultAdapter.mapContainerPathToHost('/testbed/'), {
      full: resolve(ws),
      rel: '.',
    });
    assert.deepEqual(defaultAdapter.mapContainerPathToHost('/testbed/django/db/models.py'), {
      full: resolve(ws, 'django', 'db', 'models.py'),
      rel: 'django/db/models.py',
    });
    assert.deepEqual(defaultAdapter.mapContainerPathToHost('\\testbed\\django\\db\\models.py'), {
      full: resolve(ws, 'django', 'db', 'models.py'),
      rel: 'django/db/models.py',
    });
    assert.deepEqual(defaultAdapter.mapContainerPathToHost('/testbed/django/db/../models.py'), {
      full: resolve(ws, 'django', 'models.py'),
      rel: 'django/models.py',
    });
    assert.deepEqual(defaultAdapter.mapContainerPathToHost('django/db/models.py'), {
      full: resolve(ws, 'django', 'db', 'models.py'),
      rel: 'django/db/models.py',
    });

    // Negative confinement checks: traversal, wrong prefix, protected files, outside host path
    assert.throws(() => defaultAdapter.mapContainerPathToHost(''), /must not be empty/);
    assert.throws(() => defaultAdapter.mapContainerPathToHost('/testbed/../outside/file.py'), /escapes workspaceRoot/);
    assert.throws(() => defaultAdapter.mapContainerPathToHost('/testbed/a/../../outside/file.py'), /escapes workspaceRoot/);
    assert.throws(() => defaultAdapter.mapContainerPathToHost('/testbed2/django/db/models.py'), /超出当前工作区边界/);
    assert.throws(() => defaultAdapter.mapContainerPathToHost('/testbed/.git/config'), /\.git/);
    assert.throws(() => defaultAdapter.mapContainerPathToHost('/testbed/.dev-token'), /受保护的密钥文件/);
    assert.throws(() => defaultAdapter.mapContainerPathToHost(join(outside, 'file.py')), /超出当前工作区边界/);

    // Symlink escape via containerWorkdir prefix must be rejected
    const linkPath = join(ws, 'escape-link');
    let symlinkCreated = false;
    try {
      symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      assert.throws(
        () => defaultAdapter.mapContainerPathToHost('/testbed/escape-link/file.py'),
        /符号链接路径逃逸出当前工作区边界/,
      );
    }

    // Custom containerWorkdir adapter translates ONLY its own configured mount point
    const customAdapter = new SweBenchDockerAdapter({
      image: 'local/custom:latest',
      workspaceRoot: ws,
      containerWorkdir: '/workspace/repo',
      pull: 'never',
    });
    assert.equal(customAdapter.containerWorkdir, '/workspace/repo');
    assert.equal(customAdapter.capabilities().containerWorkdir, '/workspace/repo');
    assert.deepEqual(customAdapter.mapContainerPathToHost('/workspace/repo/django/db/models.py'), {
      full: resolve(ws, 'django', 'db', 'models.py'),
      rel: 'django/db/models.py',
    });
    assert.throws(
      () => customAdapter.mapContainerPathToHost('/testbed/django/db/models.py'),
      /超出当前工作区边界/,
    );
  });

  test('3. SweBenchDockerAdapter.mapHostCwdToContainer supports configurable containerWorkdir while blocking escapes', () => {
    const ws = makeTmp('docker-cwd-34-ws-');
    const outside = makeTmp('docker-cwd-34-out-');
    mkdirSync(join(ws, 'tests', 'unit'), { recursive: true });

    const adapter = new SweBenchDockerAdapter({
      image: 'local/testbed:latest',
      workspaceRoot: ws,
      pull: 'never',
    });

    // Default /testbed virtual path mappings
    assert.equal(adapter.mapHostCwdToContainer('/testbed'), '/testbed');
    assert.equal(adapter.mapHostCwdToContainer('/testbed/'), '/testbed');
    assert.equal(adapter.mapHostCwdToContainer('/testbed/tests/unit'), '/testbed/tests/unit');
    assert.equal(adapter.mapHostCwdToContainer('/testbed/tests/unit/'), '/testbed/tests/unit');
    assert.equal(adapter.mapHostCwdToContainer('/testbed/a/../tests/unit'), '/testbed/tests/unit');
    assert.equal(adapter.mapHostCwdToContainer('/testbed/./tests/..'), '/testbed');
    assert.equal(adapter.mapHostCwdToContainer('testbed'), '/testbed');
    assert.equal(adapter.mapHostCwdToContainer('./testbed'), '/testbed');

    // When a real 'testbed' subdirectory exists, preserve '/testbed/testbed'
    const wsWithSub = makeTmp('docker-cwd-34-sub-');
    mkdirSync(join(wsWithSub, 'testbed'), { recursive: true });
    const adapterWithSub = new SweBenchDockerAdapter({
      image: 'local/testbed:latest',
      workspaceRoot: wsWithSub,
      pull: 'never',
    });
    assert.equal(adapterWithSub.mapHostCwdToContainer('testbed'), '/testbed/testbed');
    assert.equal(adapterWithSub.mapHostCwdToContainer('./testbed'), '/testbed/testbed');

    // Custom containerWorkdir mappings
    const customAdapter = new SweBenchDockerAdapter({
      image: 'local/custom:latest',
      workspaceRoot: ws,
      containerWorkdir: '/workspace',
      pull: 'never',
    });
    assert.equal(customAdapter.mapHostCwdToContainer(ws), '/workspace');
    assert.equal(customAdapter.mapHostCwdToContainer('tests/unit'), '/workspace/tests/unit');
    assert.equal(customAdapter.mapHostCwdToContainer('/workspace/tests/unit'), '/workspace/tests/unit');
    assert.equal(customAdapter.mapHostCwdToContainer('workspace'), '/workspace');
    assert.throws(() => customAdapter.mapHostCwdToContainer('/testbed/tests/unit'), /escapes workspaceRoot/);

    // Negative confinement checks
    assert.throws(() => adapter.mapHostCwdToContainer('/testbed/../outside'), /escapes workspaceRoot/);
    assert.throws(() => adapter.mapHostCwdToContainer('/testbed/a/../../outside'), /escapes workspaceRoot/);
    assert.throws(() => adapter.mapHostCwdToContainer('/etc'), /escapes workspaceRoot/);

    const linkPath = join(ws, 'escape-link');
    let symlinkCreated = false;
    try {
      symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      assert.throws(() => adapter.mapHostCwdToContainer('/testbed/escape-link'), /escapes workspaceRoot/);
    }
  });

  test('4. SweBenchDockerAdapter mounts, executes, authorizes safe.directory, and repairs permissions using custom containerWorkdir', async () => {
    const ws = makeTmp('docker-custom-workdir-');
    mkdirSync(join(ws, 'src'), { recursive: true });
    const execFileCalls = [];
    const spawnCalls = [];

    const adapter = new SweBenchDockerAdapter({
      image: 'local/custom-env:latest',
      workspaceRoot: ws,
      containerWorkdir: '/workspace',
      pull: 'never',
      platform: 'linux',
      getuid: () => 1000,
      getgid: () => 1000,
      execFileImpl: async (_bin, args) => {
        execFileCalls.push(args);
        if (args[0] === 'image') return { stdout: '[{}]', stderr: '' };
        if (args[0] === 'run') return { stdout: 'cid-custom-1\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      spawnImpl: (_bin, args) => {
        spawnCalls.push(args);
        return createImmediateFakeSpawn(0);
      },
    });

    assert.equal(
      isAuthorizedSweBenchCommand('git config --global --add safe.directory /workspace', {
        containerMode: true,
        containerWorkdir: '/workspace',
      }),
      true,
    );
    assert.equal(
      isAuthorizedSweBenchCommand('git config --global --add safe.directory /testbed', {
        containerMode: true,
        containerWorkdir: '/workspace',
      }),
      false,
    );

    const res = await adapter.run('pytest -q', '/workspace/src');
    assert.equal(res.exitCode, 0);

    const runCall = execFileCalls.find((a) => a[0] === 'run');
    assert.ok(runCall);
    assert.ok(
      runCall.includes(`${realpathSync(ws)}:/workspace:rw`) || runCall.includes(`${ws}:/workspace:rw`),
    );
    assert.ok(runCall.includes('GIT_CONFIG_VALUE_0=/workspace'));
    assert.ok(
      execFileCalls.some(
        (a) => a[0] === 'exec' && a.includes('git config --global --add safe.directory /workspace 2>/dev/null || true'),
      ),
    );
    assert.deepEqual(spawnCalls[0], ['exec', '-w', '/workspace/src', 'cid-custom-1', 'bash', '-c', 'pytest -q']);

    await adapter.destroy();
    assert.ok(
      execFileCalls.some(
        (a) =>
          a[0] === 'exec' &&
          a.includes('chown -R 1000:1000 /workspace 2>/dev/null || chmod -R a+rwX /workspace 2>/dev/null || true'),
      ),
    );
  });

  test('5. buildSweBenchPrompt provides workspace-relative path & cleanup guidance in containerMode', () => {
    const instance = {
      instance_id: 'django__django-11099',
      repo: 'django/django',
      base_commit: 'abc1234',
      problem_statement: 'Fix username validator',
      test_cmd: './tests/runtests.py auth_tests',
    };

    const containerPrompt = buildSweBenchPrompt(instance, { containerMode: true });
    assert.match(containerPrompt, /workspace root/i);
    assert.match(containerPrompt, /\/testbed/);
    assert.match(containerPrompt, /workspace-relative paths/i);
    assert.match(containerPrompt, /read_file/);
    assert.match(containerPrompt, /edit_file/);
    assert.match(containerPrompt, /apply_patch/);
    assert.match(containerPrompt, /grep/);
    assert.match(containerPrompt, /glob/);
    assert.match(containerPrompt, /bash/);
    assert.match(containerPrompt, /reproduction scripts/i);
    assert.match(containerPrompt, /git diff/);

    const customPrompt = buildSweBenchPrompt(instance, {
      containerMode: true,
      containerWorkdir: '/workspace',
    });
    assert.match(customPrompt, /\/workspace/);
    assert.doesNotMatch(customPrompt, /\/testbed/);

    const localPrompt = buildSweBenchPrompt(instance, { containerMode: false });
    assert.doesNotMatch(localPrompt, /\/testbed/);
  });

  test('6. core sandbox.js rejects /testbed while createWorkspaceTools delegates container paths to adapter.mapContainerPathToHost', async () => {
    const ws = makeTmp('adapter-tools-hook-ws-');
    mkdirSync(join(ws, 'django', 'db'), { recursive: true });
    writeFileSync(join(ws, 'django', 'db', 'models.py'), 'class Model:\n    pass\n', 'utf8');

    // Core sandbox.js must remain 100% container-agnostic (zero /testbed hardcoding)
    assert.throws(
      () => resolveConfinedPath(ws, '/testbed/django/db/models.py'),
      /超出当前工作区边界/,
    );

    // Workspace tools mounted with SweBenchDockerAdapter translate containerWorkdir cleanly
    const defaultAdapter = new SweBenchDockerAdapter({
      image: 'local/testbed:latest',
      workspaceRoot: ws,
      pull: 'never',
    });
    const tools = createWorkspaceTools({
      workspaceRoot: ws,
      permissionMode: 'full-access',
      sandbox: defaultAdapter,
    });
    const readTool = tools.find((t) => t.name === 'read_file');
    assert.ok(readTool, 'read_file must be present in default workspace tools');
    const defaultRead = await readTool.execute({ path: '/testbed/django/db/models.py' }, {});
    assert.match(String(defaultRead), /class Model:/);

    const customAdapter = new SweBenchDockerAdapter({
      image: 'local/custom:latest',
      workspaceRoot: ws,
      containerWorkdir: '/workspace/repo',
      pull: 'never',
    });
    const customTools = createWorkspaceTools({
      workspaceRoot: ws,
      permissionMode: 'full-access',
      sandbox: customAdapter,
    });
    const customReadTool = customTools.find((t) => t.name === 'read_file');
    const customRead = await customReadTool.execute({ path: '/workspace/repo/django/db/models.py' }, {});
    assert.match(String(customRead), /class Model:/);
    await assert.rejects(
      () => customReadTool.execute({ path: '/testbed/django/db/models.py' }, {}),
      /超出当前工作区边界/,
    );
  });
});
