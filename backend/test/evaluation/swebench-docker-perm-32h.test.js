import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { SweBenchDockerAdapter, safeRmRf } from '../../src/evaluation/swebench-docker.js';

describe('SWE-bench Docker cleanup & permission hardening (docker-perm-32h)', () => {
  const tempDirs = [];
  const makeTmp = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('safeRmRf removes existing directory normally and returns true for missing path', () => {
    assert.equal(safeRmRf(''), false);
    assert.equal(safeRmRf('   '), false);
    assert.equal(safeRmRf(null), false);

    const dir = makeTmp('safe-rmrf-normal-');
    const nested = join(dir, 'sub', 'deep');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'file.txt'), 'hello', 'utf8');

    assert.equal(safeRmRf(dir), true);
    assert.equal(existsSync(dir), false);

    const missingPath = join(dir, 'does-not-exist');
    assert.equal(safeRmRf(missingPath), true);
  });

  test('safeRmRf refuses root paths with [CLEANUP-WARN] without deleting', () => {
    const warnings = [];
    const rmCalls = [];
    const rootFromCwd = parse(resolve(process.cwd())).root;

    for (const candidate of ['/', rootFromCwd]) {
      const ok = safeRmRf(candidate, {
        rmSyncImpl: (p) => rmCalls.push(p),
        warn: (msg) => warnings.push(msg),
      });
      assert.equal(ok, false);
    }

    assert.equal(rmCalls.length, 0);
    assert.equal(warnings.length, 2);
    for (const msg of warnings) {
      assert.match(msg, /\[CLEANUP-WARN\]/);
    }
  });

  test('safeRmRf treats ENOENT on rmSyncImpl as success', () => {
    const ok = safeRmRf(join(tmpdir(), 'enoent-mock-dir'), {
      rmSyncImpl: () => {
        const err = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
      },
    });
    assert.equal(ok, true);
  });

  test('safeRmRf recovers from EACCES via top-down chmod 0o777 while skipping symlinks', () => {
    const fakeRoot = resolve(join(tmpdir(), 'mock-eacces-tree'));
    const subDir = join(fakeRoot, 'sub');
    const nestedFile = join(subDir, 'locked.txt');
    const escapeSymlink = join(fakeRoot, 'outside-link');

    const chmodCalls = [];
    const readdirCalls = [];
    let rmAttempts = 0;

    const lstatMap = new Map([
      [fakeRoot, { isSymbolicLink: () => false, isDirectory: () => true }],
      [subDir, { isSymbolicLink: () => false, isDirectory: () => true }],
      [nestedFile, { isSymbolicLink: () => false, isDirectory: () => false }],
      [escapeSymlink, { isSymbolicLink: () => true, isDirectory: () => false }],
    ]);

    const ok = safeRmRf(fakeRoot, {
      platform: 'win32',
      rmSyncImpl: (p, opts) => {
        assert.equal(p, fakeRoot);
        assert.deepEqual(opts, { recursive: true, force: true, maxRetries: 2 });
        rmAttempts++;
        if (rmAttempts === 1) {
          const err = new Error('EACCES: permission denied');
          err.code = 'EACCES';
          throw err;
        }
      },
      lstatSyncImpl: (p) => {
        const stat = lstatMap.get(p);
        if (!stat) {
          throw new Error(`Unexpected lstat path: ${p}`);
        }
        return stat;
      },
      readdirSyncImpl: (p) => {
        readdirCalls.push(p);
        if (p === fakeRoot) return ['outside-link', 'sub'];
        if (p === subDir) return ['locked.txt'];
        return [];
      },
      chmodSyncImpl: (p, mode) => {
        chmodCalls.push([p, mode]);
      },
      warn: () => {
        assert.fail('warn should not be called when chmod retry succeeds');
      },
    });

    assert.equal(ok, true);
    assert.equal(rmAttempts, 2);
    assert.deepEqual(readdirCalls, [fakeRoot, subDir]);
    assert.deepEqual(chmodCalls, [
      [fakeRoot, 0o777],
      [subDir, 0o777],
      [nestedFile, 0o777],
    ]);
    assert.equal(
      chmodCalls.some(([p]) => p === escapeSymlink),
      false,
      'Symlink must never be passed to chmodSyncImpl',
    );
  });

  test('safeRmRf falls back to sudo -n rm -rf -- on Linux when retry fails with permission error', () => {
    const fakeRoot = resolve(join(tmpdir(), 'mock-linux-sudo-rm'));
    const execCalls = [];
    const chmodCalls = [];
    let rmAttempts = 0;

    const ok = safeRmRf(fakeRoot, {
      platform: 'linux',
      rmSyncImpl: () => {
        rmAttempts++;
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      },
      lstatSyncImpl: () => {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
      chmodSyncImpl: (p, mode) => {
        chmodCalls.push([p, mode]);
      },
      execFileSyncImpl: (bin, args, opts) => {
        execCalls.push({ bin, args, opts });
      },
      warn: () => {
        assert.fail('warn should not be called when sudo fallback succeeds');
      },
    });

    assert.equal(ok, true);
    assert.equal(rmAttempts, 2);
    assert.deepEqual(chmodCalls, [[fakeRoot, 0o777]]);
    assert.deepEqual(execCalls, [
      {
        bin: 'sudo',
        args: ['-n', 'rm', '-rf', '--', fakeRoot],
        opts: { stdio: 'ignore', timeout: 15_000 },
      },
    ]);
  });

  test('safeRmRf logs [CLEANUP-WARN] and returns false without throwing when all retries fail', () => {
    const fakeRoot = resolve(join(tmpdir(), 'mock-fail-all'));
    const warnings = [];
    let sudoCalled = false;

    const linuxFail = safeRmRf(fakeRoot, {
      platform: 'linux',
      rmSyncImpl: () => {
        const err = new Error('Permission denied');
        err.code = 'EACCES';
        throw err;
      },
      lstatSyncImpl: () => ({ isSymbolicLink: () => false, isDirectory: () => false }),
      chmodSyncImpl: () => {
        throw new Error('chmod denied');
      },
      execFileSyncImpl: () => {
        sudoCalled = true;
        throw new Error('sudo: a password is required');
      },
      warn: (msg) => warnings.push(msg),
    });

    assert.equal(linuxFail, false);
    assert.equal(sudoCalled, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[CLEANUP-WARN\] Failed to remove temporary path /);
    assert.match(warnings[0], /sudo: a password is required/);

    const winWarnings = [];
    let winSudoCalled = false;
    const winFail = safeRmRf(fakeRoot, {
      platform: 'win32',
      rmSyncImpl: () => {
        const err = new Error('EACCES: locked');
        err.code = 'EACCES';
        throw err;
      },
      lstatSyncImpl: () => ({ isSymbolicLink: () => false, isDirectory: () => false }),
      chmodSyncImpl: () => {},
      execFileSyncImpl: () => {
        winSudoCalled = true;
      },
      warn: (msg) => winWarnings.push(msg),
    });

    assert.equal(winFail, false);
    assert.equal(winSudoCalled, false);
    assert.equal(winWarnings.length, 1);
    assert.match(winWarnings[0], /^\[CLEANUP-WARN\] Failed to remove temporary path /);
  });

  test('SweBenchDockerAdapter.destroy() repairs /testbed ownership strictly before docker rm -f on Linux', async () => {
    const ws = makeTmp('adapter-perm-linux-');
    const calls = [];

    const adapter = new SweBenchDockerAdapter({
      image: 'swe/img:latest',
      workspaceRoot: ws,
      pull: 'never',
      platform: 'linux',
      getuid: () => 1001,
      getgid: () => 1001,
      execFileImpl: async (bin, args, opts) => {
        calls.push({ bin, args, opts });
        if (args[0] === 'image' && args[1] === 'inspect') {
          return { stdout: '[{}]', stderr: '' };
        }
        if (args[0] === 'run') {
          return { stdout: 'cid-linux-perm-1\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    });

    await adapter.start();
    const startCallsCount = calls.length;
    assert.ok(
      calls.some(
        (c) =>
          c.args[0] === 'exec' &&
          c.args.includes('git config --global --add safe.directory /testbed 2>/dev/null || true'),
      ),
      'start() must configure git safe.directory /testbed inside container',
    );
    await adapter.destroy();

    const postStartCalls = calls.slice(startCallsCount);
    assert.equal(postStartCalls.length, 2);
    assert.deepEqual(postStartCalls[0].args, [
      'exec',
      '-u',
      '0',
      'cid-linux-perm-1',
      'sh',
      '-c',
      'chown -R 1001:1001 /testbed 2>/dev/null || chmod -R a+rwX /testbed 2>/dev/null || true',
    ]);
    assert.equal(postStartCalls[0].opts.timeout, 15_000);
    assert.deepEqual(postStartCalls[1].args, ['rm', '-f', 'cid-linux-perm-1']);
    assert.equal(adapter.containerId, null);
  });

  test('SweBenchDockerAdapter.destroy() tolerates chown rejection and skips chown on win32', async () => {
    const wsLinux = makeTmp('adapter-perm-err-');
    const errCalls = [];
    const adapterErr = new SweBenchDockerAdapter({
      image: 'swe/img:latest',
      workspaceRoot: wsLinux,
      pull: 'never',
      platform: 'linux',
      getuid: () => 1002,
      getgid: () => 1002,
      execFileImpl: async (_bin, args) => {
        errCalls.push(args);
        if (args[0] === 'image') return { stdout: '[{}]', stderr: '' };
        if (args[0] === 'run') return { stdout: 'cid-linux-err-2\n', stderr: '' };
        if (args[0] === 'exec') throw new Error('container already exited');
        return { stdout: '', stderr: '' };
      },
    });

    await adapterErr.start();
    const errStartCount = errCalls.length;
    await adapterErr.destroy();
    const afterStartErr = errCalls.slice(errStartCount);
    assert.equal(afterStartErr[0][0], 'exec');
    assert.deepEqual(afterStartErr[1], ['rm', '-f', 'cid-linux-err-2']);

    const wsWin = makeTmp('adapter-perm-win-');
    const winCalls = [];
    const adapterWin = new SweBenchDockerAdapter({
      image: 'swe/img:latest',
      workspaceRoot: wsWin,
      pull: 'never',
      platform: 'win32',
      getuid: () => 1001,
      getgid: () => 1001,
      execFileImpl: async (_bin, args) => {
        winCalls.push(args);
        if (args[0] === 'image') return { stdout: '[{}]', stderr: '' };
        if (args[0] === 'run') return { stdout: 'cid-win-3\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
    });

    await adapterWin.start();
    const winStartCount = winCalls.length;
    await adapterWin.destroy();
    const afterStartWin = winCalls.slice(winStartCount);
    assert.deepEqual(afterStartWin, [['rm', '-f', 'cid-win-3']]);
  });
});
