import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { DirectAgentRuntime } from '../../src/direct-agent.js';
import { AccountPool } from '../../src/pool.js';
import { Store } from '../../src/store.js';
import {
  DEFAULT_TESTBED_PATH,
  SWEBENCH_DOCKER_PRESETS,
  SweBenchDockerAdapter,
  isAuthorizedSweBenchCommand,
  removeDockerImage,
  resolveSweBenchDockerImage,
  scrubAntiCheatGitRefs,
} from '../../src/evaluation/swebench-docker.js';
import {
  SWEBENCH_HF_FULL_DATASET_ID,
  SWEBENCH_HF_MINI_DATASET_ID,
  fetchSweBenchVerifiedDataset,
  getDefaultSweBenchCachePath,
  parseEvalTestResults,
  selectSweBenchSubset,
} from '../../src/evaluation/swebench-dataset-eval.js';
import {
  PrefixBlockCacheSimulatorAdapter,
  buildSweBenchPrompt,
  isAuthorizedBenchmarkToolCall,
  loadCompletedInstanceIds,
  parseSweBenchCliArgs,
  resolveLiveProviderConfig,
  runSweBenchBenchmark,
} from '../../scripts/benchmark-swebench.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = resolve(TEST_DIR, '..', '..');
const SCRIPT_PATH = resolve(BACKEND_DIR, 'scripts', 'benchmark-swebench.mjs');

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

function createMockDockerSpawn() {
  const calls = [];
  const execCommands = [];
  const spawnImpl = (bin, args) => {
    calls.push({ bin, args: [...args] });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };

    queueMicrotask(() => {
      if (args[0] === 'run') {
        child.stdout.end('cid-live-harness-123\n');
        child.emit('close', 0);
      } else if (args[0] === 'exec') {
        const cmd = args.at(-1) ?? '';
        execCommands.push({ args: [...args], cmd });
        child.stdout.end(`1 passed in 0.05s (${cmd})\n`);
        child.emit('close', 0);
      } else {
        child.stdout.end('');
        child.emit('close', 0);
      }
    });
    return child;
  };

  const execFileImpl = (bin, args, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    calls.push({ bin, args: [...args] });
    const stdout =
      args[0] === 'image' && args[1] === 'inspect'
        ? '[{"Id":"sha256:abc"}]'
        : args[0] === 'run' || args[0] === 'rm'
          ? 'cid-live-harness-123\n'
          : '';
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(null, stdout, ''));
      return undefined;
    }
    return Promise.resolve({ stdout, stderr: '' });
  };

  return { calls, execCommands, spawnImpl, execFileImpl };
}

async function startMockOpenAiSseServer(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization ?? null,
      body,
    });

    const spec = await handler(body, requests);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const delta = {};
    if (spec.content) delta.content = spec.content;
    if (spec.toolCalls) {
      delta.tool_calls = spec.toolCalls.map((tc, index) => ({
        index,
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    const chunk1 = {
      id: `chatcmpl-${requests.length}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body?.model ?? 'mock-model',
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    const chunk2 = {
      id: `chatcmpl-${requests.length}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body?.model ?? 'mock-model',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: spec.toolCalls ? 'tool_calls' : 'stop',
        },
      ],
      usage: spec.usage ?? {
        prompt_tokens: 120,
        completion_tokens: 24,
        total_tokens: 144,
        prompt_tokens_details: { cached_tokens: 64 },
      },
    };
    res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
    res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const addr = server.address();
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    requests,
    close: () => new Promise((res) => server.close(res)),
  };
}

function seedBuggyPythonRepo(repoDir) {
  mkdirSync(join(repoDir, 'src', 'discounts'), { recursive: true });
  mkdirSync(join(repoDir, 'tests'), { recursive: true });
  mkdirSync(join(repoDir, 'docs', 'legacy'), { recursive: true });

  writeFileSync(
    join(repoDir, 'src', 'discounts', '__init__.py'),
    'from .calculator import calculate_tiered_discount\n',
    'utf8',
  );
  writeFileSync(
    join(repoDir, 'src', 'discounts', 'calculator.py'),
    [
      'def calculate_tiered_discount(subtotal_cents: int, max_discount_pct: float = 0.35) -> int:',
      '    combined_pct = 0.45',
      '    effective_pct = combined_pct',
      '    return max(0, subtotal_cents - round(subtotal_cents * effective_pct))',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(repoDir, 'tests', 'test_calculator.py'),
    [
      'from src.discounts.calculator import calculate_tiered_discount',
      '',
      'def test_discount_cap():',
      '    assert calculate_tiered_discount(10_000, max_discount_pct=0.35) == 6_500',
      '',
    ].join('\n'),
    'utf8',
  );
  const decoySections = Array.from({ length: 40 }, (_, idx) => {
    const rev = idx + 1;
    const regions = ['EMEA', 'APAC', 'AMER', 'LATAM', 'NORDIC'];
    const tiers = ['gold', 'silver', 'bronze', 'enterprise', 'partner'];
    return [
      `### Archived Tariff Batch v0.${rev} (${regions[idx % regions.length]})`,
      `Historical ${tiers[idx % tiers.length]} rebate schedule entry for quarterly ledger reconciliation.`,
    ].join('\n');
  }).join('\n\n');
  writeFileSync(
    join(repoDir, 'docs', 'legacy', 'changelog_decoy.md'),
    `<!-- DO NOT EDIT - ARCHIVED DECOY -->\n# Archived Discount Schedule\n\n${decoySections}\n`,
    'utf8',
  );
  const legacySections = Array.from({ length: 35 }, (_, idx) => {
    const rev = idx + 1;
    return `### Legacy Batch v0.${rev}\nArchived regional wholesale discount tariff snapshot #${rev}: flat rebate matrix row=${rev * 12}bp.\n`;
  }).join('\n');
  writeFileSync(
    join(repoDir, 'docs', 'legacy_pricing_changelog.md'),
    `<!-- DO NOT EDIT - ARCHIVED DECOY -->\n# Legacy Pricing Archive\n\n${legacySections}`,
    'utf8',
  );

  runGit(repoDir, ['init', '-q']);
  runGit(repoDir, ['config', 'user.email', 'swe-live@agent-us.invalid']);
  runGit(repoDir, ['config', 'user.name', 'SWE Live Harness']);
  runGit(repoDir, ['config', 'core.autocrlf', 'false']);
  runGit(repoDir, ['config', 'core.filemode', 'false']);
  runGit(repoDir, ['add', '-A']);
  runGit(repoDir, ['commit', '-qm', 'base buggy commit']);
  return runGit(repoDir, ['rev-parse', 'HEAD']);
}

describe('SWE-bench Live Benchmark Harness Integration (3.2)', () => {
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

  test('CLI flags and --help cover --fetch-dataset, --subset, --docker-preset, --use-app-pool, --evaluate, --eval-only, and --export-latex', () => {
    const helpProc = spawnSync(process.execPath, [SCRIPT_PATH, '--help'], {
      cwd: BACKEND_DIR,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(helpProc.status, 0, `--help failed: ${helpProc.stderr}`);
    assert.match(helpProc.stdout, /--fetch-dataset/);
    assert.match(helpProc.stdout, /hf:verified-mini/);
    assert.match(helpProc.stdout, /--cleanup-images/);
    assert.match(helpProc.stdout, /--container-memory 2g/);

    // Optional path handling for --fetch-dataset and --export-latex
    const fetchDefault = parseSweBenchCliArgs(['--fetch-dataset']);
    assert.equal(fetchDefault.fetchDataset, true);
    assert.equal(fetchDefault.fetchDatasetPath, null);
    assert.equal(fetchDefault.cleanupImages, true);
    assert.equal(fetchDefault.containerMemory, '2g');

    const fetchBeforeFlag = parseSweBenchCliArgs([
      '--fetch-dataset',
      '--dataset',
      'hf:verified-mini',
      '--subset',
      'smoke-5',
      '--docker-preset',
      'epoch',
    ]);
    assert.equal(fetchBeforeFlag.fetchDataset, true);
    assert.equal(fetchBeforeFlag.fetchDatasetPath, null);
    assert.equal(fetchBeforeFlag.dataset, 'hf:verified-mini');
    assert.equal(fetchBeforeFlag.subset, 'smoke-5');
    assert.equal(fetchBeforeFlag.dockerPreset, 'epoch');
    assert.equal(fetchBeforeFlag.pull, 'missing');
    assert.equal(fetchBeforeFlag.seed, 42);
    assert.equal(fetchBeforeFlag.cleanupImages, true);
    assert.equal(fetchBeforeFlag.containerMemory, '2g');

    const fullOpts = parseSweBenchCliArgs([
      '--dataset',
      'hf:verified',
      '--fetch-dataset',
      './cache/swe.jsonl',
      '--subset=paper-50',
      '--seed',
      '99',
      '--docker-preset=official',
      '--pull=always',
      '--container-memory',
      '4g',
      '--keep-images',
      '--use-app-pool',
      '--app-data-dir',
      './custom-data',
      '--supervisor-model',
      'deepseek-chat',
      '--deterministic-admission',
      '--evaluate',
      '--export-latex',
      './out/paper.tex',
    ]);
    assert.equal(fullOpts.fetchDatasetPath, './cache/swe.jsonl');
    assert.equal(fullOpts.subset, 'paper-50');
    assert.equal(fullOpts.seed, 99);
    assert.equal(fullOpts.dockerPreset, 'official');
    assert.equal(fullOpts.pull, 'always');
    assert.equal(fullOpts.containerMemory, '4g');
    assert.equal(fullOpts.cleanupImages, false);
    assert.equal(fullOpts.useAppPool, true);
    assert.equal(fullOpts.appDataDir, './custom-data');
    assert.equal(fullOpts.supervisorModel, 'deepseek-chat');
    assert.equal(fullOpts.deterministicAdmission, true);
    assert.equal(fullOpts.evaluate, true);
    assert.equal(fullOpts.exportLatex, true);
    assert.equal(fullOpts.exportLatexPath, './out/paper.tex');

    const cleanupExplicit = parseSweBenchCliArgs(['--dry-run', '--keep-images', '--cleanup-images']);
    assert.equal(cleanupExplicit.cleanupImages, true);

    assert.throws(
      () => parseSweBenchCliArgs(['--dry-run', '--container-memory', 'not-a-size']),
      /Invalid --container-memory/,
    );

    const noPoolOpts = parseSweBenchCliArgs(['--dry-run', '--no-use-app-pool', '--export-latex']);
    assert.equal(noPoolOpts.useAppPool, false);
    assert.equal(noPoolOpts.exportLatex, true);
    assert.equal(noPoolOpts.exportLatexPath, null);

    const evalOnlyOpts = parseSweBenchCliArgs([
      '--eval-only',
      '--predictions',
      './out/predictions.full_aci.jsonl',
      '--dataset',
      'hf:verified',
    ]);
    assert.equal(evalOnlyOpts.evalOnly, true);

    assert.throws(() => parseSweBenchCliArgs([]), /Provide --dataset <path> or --dry-run/);
    assert.throws(() => parseSweBenchCliArgs(['--eval-only']), /--eval-only requires/);
    assert.throws(
      () => parseSweBenchCliArgs(['--dry-run', '--docker-preset', 'bad']),
      /Invalid --docker-preset/,
    );
    assert.throws(
      () => parseSweBenchCliArgs(['--dry-run', '--subset', 'bad']),
      /Invalid --subset/,
    );
    assert.throws(() => parseSweBenchCliArgs(['--dry-run', '--pull', 'bad']), /Invalid --pull/);
  });

  test('WP1/WP2: Docker /testbed mount + PATH, anti-cheat scrub + command guard, toolDeny hides run_diagnostics while keeping .py ast.parse', async () => {
    const repoDir = makeTmp('swe-wp12-repo-');
    const baseCommit = seedBuggyPythonRepo(repoDir);

    // Add future commit branch, tag, and fake remote for anti-cheat scrub test
    runGit(repoDir, ['checkout', '-qb', 'future-fix']);
    writeFileSync(join(repoDir, 'FUTURE.txt'), 'secret future fix\n', 'utf8');
    runGit(repoDir, ['add', 'FUTURE.txt']);
    runGit(repoDir, ['commit', '-qm', 'future solution']);
    runGit(repoDir, ['tag', 'v99-future']);
    runGit(repoDir, ['checkout', '--quiet', '--detach', baseCommit]);
    runGit(repoDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
    runGit(repoDir, ['update-ref', 'refs/remotes/origin/main', 'refs/heads/future-fix']);

    const scrubRes = await scrubAntiCheatGitRefs(repoDir, baseCommit);
    assert.ok(scrubRes.removedRemotes.includes('origin'));
    assert.equal(runGit(repoDir, ['remote']), '');
    assert.equal(runGit(repoDir, ['tag']), '');
    assert.match(runGit(repoDir, ['branch']), /^\* \((?:HEAD detached at [0-9a-f]+|no branch)\)/i);
    assert.throws(() => runGit(repoDir, ['symbolic-ref', '-q', 'HEAD']));
    assert.equal(runGit(repoDir, ['reflog']), '');
    assert.equal(runGit(repoDir, ['rev-parse', 'HEAD']), baseCommit);
    assert.equal(existsSync(join(repoDir, 'FUTURE.txt')), false);

    // Preset resolution & container command guard
    const epochImg = resolveSweBenchDockerImage({
      dockerPreset: 'epoch',
      instance: { instance_id: 'django__django-11179', repo: 'django/django' },
    });
    assert.equal(
      epochImg,
      SWEBENCH_DOCKER_PRESETS.epoch.replace('{instance_id}', 'django__django-11179'),
    );

    assert.equal(
      isAuthorizedSweBenchCommand('DJANGO_SETTINGS_MODULE=tests.sqlite ./tests/runtests.py auth_tests', {
        containerMode: true,
      }),
      true,
    );
    assert.equal(isAuthorizedSweBenchCommand('git log --all -n 5', { containerMode: true }), false);
    assert.equal(isAuthorizedSweBenchCommand('git show-ref', { containerMode: true }), false);
    assert.equal(
      isAuthorizedSweBenchCommand('cat .git/refs/heads/main', { containerMode: true }),
      false,
    );
    assert.equal(
      isAuthorizedSweBenchCommand('pytest -q && git reset --hard HEAD', { containerMode: true }),
      false,
    );
    assert.equal(
      isAuthorizedBenchmarkToolCall('run_diagnostics', {}, { containerMode: true }),
      false,
    );
    assert.equal(
      isAuthorizedBenchmarkToolCall('bash', { command: 'pytest -q' }, { containerMode: true }),
      true,
    );

    // Mock Docker adapter + DirectAgentRuntime toolDeny & .py ast.parse check
    const mockDocker = createMockDockerSpawn();
    const dockerAdapter = new SweBenchDockerAdapter({
      image: epochImg,
      workspaceRoot: repoDir,
      pull: 'missing',
      spawnImpl: mockDocker.spawnImpl,
      execFileImpl: mockDocker.execFileImpl,
    });
    assert.equal(dockerAdapter.mapHostCwdToContainer(repoDir), '/testbed');
    assert.equal(
      dockerAdapter.mapHostCwdToContainer(join(repoDir, 'src', 'discounts')),
      '/testbed/src/discounts',
    );
    assert.throws(() => dockerAdapter.mapHostCwdToContainer(tmpdir()), /escapes/i);

    const stateDir = makeTmp('swe-wp2-state-');
    const store = new Store(join(stateDir, 'state.sqlite'));
    const pool = new AccountPool(store, { root: stateDir });
    pool.createAccount({
      preset: 'custom-openai',
      label: 'sim',
      credential: 'sk-sim',
      endpoint: 'https://sim.invalid/v1',
      models: ['sim-model'],
    });
    pool.setDefaultModel('sim-model');

    const observedToolNames = [];
    let toolStage = 0;
    let syntaxWarningToolOutput = '';
    class ContainerCheckAdapter extends LlmAdapter {
      async *stream(opts) {
        if (Array.isArray(opts.tools) && opts.tools.length > 0) {
          observedToolNames.push(opts.tools.map((t) => t.name));
        }
        const msgs = opts.messages ?? [];
        if (toolStage === 0) {
          toolStage = 1;
          // Attempt broken Python syntax edit to verify ast.parse quick syntax diagnostic still runs!
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-bad-py',
              name: 'edit_file',
              arguments: JSON.stringify({
                path: 'src/discounts/calculator.py',
                target: '    effective_pct = combined_pct',
                replacement: '    effective_pct = (',
              }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (toolStage === 1) {
          toolStage = 2;
          const badOutMsg = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'tc-bad-py');
          syntaxWarningToolOutput = JSON.stringify(badOutMsg?.content ?? '');
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-fix-py',
              name: 'edit_file',
              arguments: JSON.stringify({
                path: 'src/discounts/calculator.py',
                target: '    effective_pct = (',
                replacement: '    effective_pct = min(combined_pct, max_discount_pct)',
              }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (toolStage === 2) {
          toolStage = 3;
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-bash-py',
              name: 'bash',
              arguments: JSON.stringify({ command: 'pytest -q', cwd: 'tests' }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield { type: 'text-delta', index: 0, text: 'Fixed and verified in /testbed.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }

    const direct = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: repoDir,
      dataRoot: stateDir,
      adapter: new ContainerCheckAdapter(),
    });
    try {
      const session = direct.createSession({
        title: 'container-check',
        workspaceRoot: repoDir,
        model: 'sim-model',
        permissionMode: 'auto-safe',
        toolDeny: ['run_diagnostics'],
        sandbox: dockerAdapter,
        sandboxProfile: 'benchmark',
      });
      direct.subscribe(session.id, (evt) => {
        if (evt?.type !== 'approval/requested') return;
        const allowed = isAuthorizedBenchmarkToolCall(evt.data.tool, evt.data.arguments, {
          containerMode: true,
        });
        queueMicrotask(() => {
          try {
            direct.decideApproval(evt.data.approvalId, {
              decision: allowed ? 'allow' : 'deny',
              scope: 'once',
            });
          } catch {
            // ignore
          }
        });
      });

      const prompt = buildSweBenchPrompt(
        {
          instance_id: 'acme__discounts-1',
          repo: 'acme/discounts',
          base_commit: baseCommit,
          problem_statement: 'Fix cap',
        },
        { containerMode: true },
      );
      assert.match(prompt, /\/testbed/);

      const { turn } = direct.startTurn(session.id, {
        input: prompt,
        model: 'sim-model',
        permissionMode: 'auto-safe',
        maxSteps: 10,
      });
      await direct.waitForTurnTerminal(turn.id, { timeoutMs: 30_000 });

      assert.ok(observedToolNames.length > 0);
      for (const names of observedToolNames) {
        assert.equal(
          names.includes('run_diagnostics'),
          false,
          'toolDeny must hide run_diagnostics from model catalog',
        );
      }
      assert.match(
        syntaxWarningToolOutput,
        /SyntaxError|自动语法诊断|invalid syntax|was never closed/i,
        'edit_file must still run .py ast.parse quick syntax check when run_diagnostics is denied',
      );

      const runCall = mockDocker.calls.find((c) => c.args[0] === 'run');
      assert.ok(runCall, 'Docker container must be started');
      assert.ok(runCall.args.includes('--memory=2g'));
      assert.ok(runCall.args.includes('--memory-swap=2.5g'));
      assert.ok(runCall.args.some((a) => a.includes(DEFAULT_TESTBED_PATH)));
      assert.ok(runCall.args.some((a) => a.endsWith(':/testbed:rw')));

      assert.equal(mockDocker.execCommands.length, 1);
      assert.ok(mockDocker.execCommands[0].args.includes('/testbed/tests'));
      assert.equal(mockDocker.execCommands[0].cmd, 'pytest -q');
    } finally {
      await direct.close();
      await dockerAdapter.destroy();
      store.close();
    }

    assert.ok(
      mockDocker.calls.some((c) => c.args[0] === 'rm' && c.args[1] === '-f'),
      'destroy() must run docker rm -f',
    );

    const rmiRes = await removeDockerImage(epochImg, { execFileImpl: mockDocker.execFileImpl });
    assert.equal(rmiRes.image, epochImg);
    assert.ok(mockDocker.calls.some((c) => c.args[0] === 'rmi' && c.args.includes(epochImg)));
  });

  test('WP3 Live Integration: DEEPSEEK_API_KEY endpoint inference, --use-app-pool read-only clone, and deepseek-reasoner supervisor decoupling', async () => {
    // 1. Endpoint inference check
    const dsInferred = resolveLiveProviderConfig({}, { DEEPSEEK_API_KEY: 'sk-ds-inferred' });
    assert.equal(dsInferred.endpoint, 'https://api.deepseek.com/v1');
    assert.equal(dsInferred.model, 'deepseek-chat');

    // 2. Local mock OpenAI SSE server verifying real PoolLlmAdapter -> HTTP wiring
    let stage = 0;
    const mockHttp = await startMockOpenAiSseServer((body) => {
      const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
      if (!hasTools) {
        // ACI Supervisor read-only admission call
        return {
          content: JSON.stringify({
            decisions: [
              {
                id: 'call-decoy',
                decision: 'IRRELEVANT',
                focusSymbols: [],
                reason: 'decoy changelog',
              },
            ],
            contractHints: [],
          }),
        };
      }
      const msgs = body?.messages ?? [];
      if (stage === 0) {
        stage = 1;
        return {
          toolCalls: [
            {
              id: 'call-decoy',
              name: 'read_file',
              arguments: JSON.stringify({ path: 'docs/legacy/changelog_decoy.md' }),
            },
          ],
        };
      }
      if (stage === 1 && msgs.some((m) => m.role === 'tool' && m.tool_call_id === 'call-decoy')) {
        stage = 2;
        return {
          toolCalls: [
            {
              id: 'call-edit',
              name: 'edit_file',
              arguments: JSON.stringify({
                path: 'src/discounts/calculator.py',
                target: '    effective_pct = combined_pct',
                replacement: '    effective_pct = min(combined_pct, max_discount_pct)',
              }),
            },
          ],
        };
      }
      if (stage === 2 && msgs.some((m) => m.role === 'tool' && m.tool_call_id === 'call-edit')) {
        stage = 3;
        return {
          toolCalls: [
            {
              id: 'call-test',
              name: 'bash',
              arguments: JSON.stringify({ command: 'pytest -q' }),
            },
          ],
        };
      }
      return { content: 'Patched calculator cap.' };
    });

    const repoDir = makeTmp('swe-wp3-repo-');
    const baseCommit = seedBuggyPythonRepo(repoDir);
    const datasetPath = join(makeTmp('swe-wp3-ds-'), 'ds.jsonl');
    writeFileSync(
      datasetPath,
      JSON.stringify({
        instance_id: 'acme__discounts-live-1',
        repo: 'acme/discounts',
        base_commit: baseCommit,
        problem_statement: 'Fix discount cap in calculate_tiered_discount in src/discounts/calculator.py.',
      }) + '\n',
      'utf8',
    );

    const appDataDir = makeTmp('swe-wp3-appdata-');
    const appStore = new Store(join(appDataDir, 'engine.sqlite'));
    const appPool = new AccountPool(appStore, { root: appDataDir });
    appPool.createAccount({
      preset: 'deepseek',
      label: 'Test App DeepSeek',
      credential: 'sk-app-pool-live-secret',
      endpoint: mockHttp.baseUrl,
      models: ['deepseek-reasoner'],
    });
    appPool.setDefaultModel('deepseek-reasoner');
    appStore.close();

    const makeStubDockerAdapter = ({ workspaceRoot }) => {
      const adapterObj = {
        isSweBenchContainer: true,
        workspaceRoot,
        start: async () => 'stub-cid',
        run: async () => ({ exitCode: 0, stdout: '1 passed\n', stderr: '', timedOut: false }),
        exec: async () => ({ exitCode: 0, stdout: '1 passed\n', stderr: '', timedOut: false }),
        destroy: async () => {},
        close: async () => {},
      };
      adapterObj.resolveBackend = () => ({
        mode: 'docker',
        tier: 'strong-os-isolation',
        backend: adapterObj,
      });
      return adapterObj;
    };

    try {
      // Scenario A: --use-app-pool with ONLY deepseek-reasoner -> deterministic fallback (ZERO reasoner supervisor calls!)
      const outA = makeTmp('swe-wp3-outA-');
      const resA = await runSweBenchBenchmark(
        {
          dataset: datasetPath,
          arms: ['full_aci'],
          workspaceRoot: repoDir,
          dockerPreset: 'epoch',
          useAppPool: true,
          appDataDir,
          model: 'deepseek-reasoner',
          outputDir: outA,
        },
        {
          createDockerAdapter: makeStubDockerAdapter,
          env: {},
        },
      );
      assert.equal(resA.metricsByArm.full_aci.nonEmptyPatchRate, 1);
      assert.ok(resA.telemetryByArm.full_aci[0].admissionSavedTokens > 0);
      const supervisorReqsA = mockHttp.requests.filter(
        (r) => !Array.isArray(r.body?.tools) || r.body.tools.length === 0,
      );
      assert.equal(
        supervisorReqsA.length,
        0,
        'deepseek-reasoner without fast model must fall back to deterministic admission (0 supervisor LLM calls)',
      );
      const agentReqsA = mockHttp.requests.filter(
        (r) => Array.isArray(r.body?.tools) && r.body.tools.length > 0,
      );
      assert.ok(agentReqsA.length >= 2);
      assert.equal(agentReqsA[0].authorization, 'Bearer sk-app-pool-live-secret');
      assert.equal(agentReqsA[0].body.model, 'deepseek-reasoner');

      // Scenario B: --supervisor-model deepseek-chat with DEEPSEEK_API_KEY env -> supervisor calls use ONLY deepseek-chat!
      mockHttp.requests.length = 0;
      stage = 0;
      const outB = makeTmp('swe-wp3-outB-');
      const resB = await runSweBenchBenchmark(
        {
          dataset: datasetPath,
          arms: ['full_aci'],
          workspaceRoot: repoDir,
          dockerPreset: 'epoch',
          useAppPool: false,
          model: 'deepseek-reasoner',
          supervisorModel: 'deepseek-chat',
          outputDir: outB,
        },
        {
          createDockerAdapter: makeStubDockerAdapter,
          env: {
            DEEPSEEK_API_KEY: 'sk-env-deepseek-live',
            SWEBENCH_ENDPOINT: mockHttp.baseUrl,
          },
        },
      );
      assert.equal(resB.metricsByArm.full_aci.nonEmptyPatchRate, 1);
      const supervisorReqsB = mockHttp.requests.filter(
        (r) => !Array.isArray(r.body?.tools) || r.body.tools.length === 0,
      );
      assert.equal(supervisorReqsB.length, 1);
      assert.equal(supervisorReqsB[0].body.model, 'deepseek-chat');
      assert.equal(supervisorReqsB[0].authorization, 'Bearer sk-env-deepseek-live');
    } finally {
      await mockHttp.close();
    }
  });

  test('WP4/WP5: hf:verified-mini default, outer-instance loop, instant rmi & --keep-images, 2g memory, env_error --resume retry, --evaluate/--eval-only, LaTeX, and --dry-run', async () => {
    assert.equal(SWEBENCH_HF_MINI_DATASET_ID, 'MariusHobbhahn/swe-bench-verified-mini');
    assert.equal(SWEBENCH_HF_FULL_DATASET_ID, 'princeton-nlp/SWE-bench_Verified');
    assert.match(getDefaultSweBenchCachePath(), /swebench_verified_mini\.jsonl$/);

    // 1. Test HuggingFace fetcher + smoke-5 / paper-50 subset reproducibility
    const cacheDir = makeTmp('swe-wp4-cache-');
    const cachePath = join(cacheDir, 'swebench_verified_mini.jsonl');
    const repoTemplates = [
      { repo: 'psf/requests', id: 'psf__requests-101', f2p: ['tests/test_req.py::test_hdr'] },
      { repo: 'pytest-dev/pytest', id: 'pytest-dev__pytest-202', f2p: ['testing/test_p.py::test_x'] },
      { repo: 'django/django', id: 'django__django-303', f2p: ['test_ok (auth_tests.test_forms.LoginTest)'] },
      { repo: 'sympy/sympy', id: 'sympy__sympy-404', f2p: ['sympy/core/tests/test_sym.py::test_s'] },
      { repo: 'scikit-learn/scikit-learn', id: 'scikit-learn__scikit-learn-505', f2p: ['sklearn/tests/test_m.py::test_k'] },
      { repo: 'matplotlib/matplotlib', id: 'matplotlib__matplotlib-606', f2p: ['lib/matplotlib/tests/test_a.py::test_p'] },
    ];
    const seedRepo = makeTmp('swe-wp4-seed-');
    const baseCommit = seedBuggyPythonRepo(seedRepo);

    const hfRows = repoTemplates.map((r, i) => ({
      row: {
        instance_id: r.id,
        repo: r.repo,
        base_commit: baseCommit,
        problem_statement: `Fix bug #${i + 1} in ${r.repo} calculator module.`,
        hints_text: 'Check min() clamp.',
        test_patch: `diff --git a/tests/test_eval_${i}.py b/tests/test_eval_${i}.py\n`,
        FAIL_TO_PASS: JSON.stringify(r.f2p),
        PASS_TO_PASS: JSON.stringify([]),
        version: '1.0',
        environment_setup_commit: baseCommit,
      },
    }));
    const fetched = await fetchSweBenchVerifiedDataset({
      outputPath: cachePath,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ rows: hfRows, num_rows_total: hfRows.length }),
      }),
    });
    assert.equal(fetched.count, 6);
    assert.equal(existsSync(cachePath), true);

    const subA = selectSweBenchSubset(fetched.instances, { preset: 'smoke-5', seed: 42 });
    const subB = selectSweBenchSubset(fetched.instances, { preset: 'smoke-5', seed: 42 });
    assert.deepEqual(subA.instanceIds, subB.instanceIds);
    assert.equal(subA.instances.length, 5);

    const paperA = selectSweBenchSubset(fetched.instances, { preset: 'paper-50', seed: 42 });
    assert.equal(paperA.instances.length, 6);

    // Verify hf:verified-mini (and hf:verified) map to mini ID, while hf:verified-full maps to full ID
    const seenFetchIds = [];
    const miniAliasPath = join(makeTmp('swe-mini-alias-'), 'mini.jsonl');
    const fullAliasPath = join(makeTmp('swe-full-alias-'), 'full.jsonl');
    await runSweBenchBenchmark(
      {
        dataset: 'hf:verified-mini',
        fetchDataset: true,
        fetchDatasetPath: miniAliasPath,
        limit: 1,
        arms: ['raw_full'],
        workspaceRoot: seedRepo,
        outputDir: makeTmp('swe-mini-alias-out-'),
      },
      {
        fetchSweBenchVerifiedDataset: async ({ outputPath, datasetId }) => {
          seenFetchIds.push({ outputPath, datasetId });
          writeFileSync(
            outputPath,
            JSON.stringify({
              instance_id: repoTemplates[0].id,
              repo: repoTemplates[0].repo,
              base_commit: baseCommit,
              problem_statement: 'Fix cap',
            }) + '\n',
            'utf8',
          );
          return { outputPath, count: 1, instances: [] };
        },
        createAdapter: () => new PrefixBlockCacheSimulatorAdapter(),
      },
    );
    await runSweBenchBenchmark(
      {
        dataset: 'hf:verified-full',
        fetchDataset: true,
        fetchDatasetPath: fullAliasPath,
        limit: 1,
        arms: ['raw_full'],
        workspaceRoot: seedRepo,
        outputDir: makeTmp('swe-full-alias-out-'),
      },
      {
        fetchSweBenchVerifiedDataset: async ({ outputPath, datasetId }) => {
          seenFetchIds.push({ outputPath, datasetId });
          writeFileSync(
            outputPath,
            JSON.stringify({
              instance_id: repoTemplates[0].id,
              repo: repoTemplates[0].repo,
              base_commit: baseCommit,
              problem_statement: 'Fix cap',
            }) + '\n',
            'utf8',
          );
          return { outputPath, count: 1, instances: [] };
        },
        createAdapter: () => new PrefixBlockCacheSimulatorAdapter(),
      },
    );
    assert.equal(seenFetchIds[0].datasetId, SWEBENCH_HF_MINI_DATASET_ID);
    assert.equal(seenFetchIds[1].datasetId, SWEBENCH_HF_FULL_DATASET_ID);

    // 2. End-to-end --subset smoke-5 --docker-preset epoch --evaluate --export-latex
    // Verifies outer-instance -> inner-arm -> eval -> instant removeDockerImage order + 2g memory cap
    const outDir = makeTmp('swe-wp5-out-');
    const lifecycleEvents = [];
    const seenAdapterMemories = [];
    const seenEvalMemories = [];
    const makeStubDockerAdapter = ({ workspaceRoot, memory, memorySwap }) => {
      seenAdapterMemories.push({ memory, memorySwap });
      const adapterObj = {
        isSweBenchContainer: true,
        workspaceRoot,
        start: async () => 'stub-cid',
        run: async () => ({ exitCode: 0, stdout: '1 passed\n', stderr: '', timedOut: false }),
        exec: async () => ({ exitCode: 0, stdout: '1 passed\n', stderr: '', timedOut: false }),
        destroy: async () => {},
        close: async () => {},
      };
      adapterObj.resolveBackend = () => ({
        mode: 'docker',
        tier: 'strong-os-isolation',
        backend: adapterObj,
      });
      return adapterObj;
    };

    const runRes = await runSweBenchBenchmark(
      {
        dataset: cachePath,
        subset: 'smoke-5',
        seed: 42,
        arms: ['raw_full', 'full_aci'],
        dockerPreset: 'epoch',
        containerMemory: '2g',
        cleanupImages: true,
        evaluate: true,
        exportLatex: true,
        outputDir: outDir,
      },
      {
        extractTestbedFromImage: async ({ targetDir, image }) => {
          lifecycleEvents.push(`extract:${image}`);
          cpSync(seedRepo, targetDir, { recursive: true });
          return { targetDir, headCommit: baseCommit };
        },
        createDockerAdapter: makeStubDockerAdapter,
        createAdapter: ({ arm, instance }) => {
          lifecycleEvents.push(`run:${instance.instance_id}:${arm}`);
          if (instance.instance_id === 'psf__requests-101') {
            return new PrefixBlockCacheSimulatorAdapter();
          }
          return new (class EmptyAdapter extends LlmAdapter {
            async *stream() {
              yield { type: 'text-delta', index: 0, text: 'No edit.' };
              yield {
                type: 'usage',
                usage: {
                  inputTokens: 100,
                  outputTokens: 10,
                  cacheReadTokens: 0,
                  cacheEligibleInputTokens: 100,
                },
              };
              yield { type: 'finish', reason: { kind: 'stop' } };
            }
          })();
        },
        createDockerSession: async ({ instance, memory, memorySwap }) => {
          seenEvalMemories.push({ memory, memorySwap });
          lifecycleEvents.push(`eval:${instance.instance_id}`);
          return {
            workspaceRoot: '/tmp/eval',
            exec: async (cmd) => {
              if (/\bgit\s+|rm\s+-f/.test(cmd)) {
                return { exitCode: 0, stdout: 'Applied cleanly', stderr: '' };
              }
              if (instance.instance_id === 'psf__requests-101') {
                return {
                  exitCode: 0,
                  stdout: 'PASSED tests/test_req.py::test_hdr\n1 passed in 0.1s\n',
                  stderr: '',
                };
              }
              return { exitCode: 1, stdout: 'FAILED\n', stderr: '' };
            },
            destroy: async () => {},
          };
        },
        removeDockerImage: async (image) => {
          lifecycleEvents.push(`rmi:${image}`);
          return { image, removed: true };
        },
      },
    );

    assert.equal(runRes.instancesCount, 5);
    assert.equal(existsSync(join(outDir, 'eval.raw_full.jsonl')), true);
    assert.equal(existsSync(join(outDir, 'eval.full_aci.jsonl')), true);
    assert.equal(existsSync(runRes.latexPath), true);

    assert.equal(runRes.metricsByArm.raw_full.resolvedInstances, 1);
    assert.equal(runRes.metricsByArm.full_aci.resolvedInstances, 1);
    assert.ok(runRes.pairedByArm.full_aci.pairedResolvedCount === 1);
    assert.ok(
      runRes.pairedByArm.full_aci.pairedResolvedTokenReduction > 0,
      'Expected full_aci pairedResolvedTokenReduction > 0',
    );

    // Verify memory='2g' & memorySwap='2.5g' forwarded everywhere
    assert.ok(seenAdapterMemories.length > 0);
    for (const mem of seenAdapterMemories) {
      assert.equal(mem.memory, '2g');
      assert.equal(mem.memorySwap, '2.5g');
    }
    assert.ok(seenEvalMemories.length > 0);
    for (const mem of seenEvalMemories) {
      assert.equal(mem.memory, '2g');
      assert.equal(mem.memorySwap, '2.5g');
    }

    // Verify outer-instance order: extract -> raw_full -> full_aci -> eval -> rmi per instance before next instance!
    const firstId = subA.instances[0].instance_id;
    const secondId = subA.instances[1].instance_id;
    const firstRawIdx = lifecycleEvents.indexOf(`run:${firstId}:raw_full`);
    const firstAciIdx = lifecycleEvents.indexOf(`run:${firstId}:full_aci`);
    const firstRmiIdx = lifecycleEvents.findIndex((e) => e.startsWith(`rmi:`) && e.includes(firstId));
    const secondRawIdx = lifecycleEvents.indexOf(`run:${secondId}:raw_full`);
    assert.ok(firstRawIdx >= 0 && firstAciIdx > firstRawIdx);
    assert.ok(firstRmiIdx > firstAciIdx && firstRmiIdx < secondRawIdx, 'Must rmi instance 1 before starting instance 2');

    // Verify --keep-images (cleanupImages: false) skips removeDockerImage
    // Also verify dirty Epoch container baseline files (e.g. setup.py/tox.ini) are excluded from model_patch!
    const dirtySeedRepo = makeTmp('swe-wp5-dirtyseed-');
    cpSync(seedRepo, dirtySeedRepo, { recursive: true });
    writeFileSync(join(dirtySeedRepo, 'docs', 'legacy_pricing_changelog.md'), '<!-- DO NOT EDIT - ARCHIVED DECOY -->\n' + readFileSync(join(dirtySeedRepo, 'docs', 'legacy_pricing_changelog.md'), 'utf8'), 'utf8');
    writeFileSync(join(dirtySeedRepo, 'env_pin_setup.py'), '# container env setup pin\n', 'utf8');
    runGit(dirtySeedRepo, ['add', 'env_pin_setup.py']);
    runGit(dirtySeedRepo, ['commit', '-qm', 'add env_pin_setup.py']);
    const dirtyBaseCommit = runGit(dirtySeedRepo, ['rev-parse', 'HEAD']);
    const dirtyDsPath = join(makeTmp('swe-wp5-dirtyds-'), 'ds.jsonl');
    writeFileSync(
      dirtyDsPath,
      JSON.stringify({
        instance_id: 'acme__dirty-container-1',
        repo: 'acme/discounts',
        base_commit: dirtyBaseCommit,
        problem_statement: 'Fix cap.',
      }) + '\n',
      'utf8',
    );
    const keepOut = makeTmp('swe-wp5-keep-');
    const keepRmiCalls = [];
    const keepRes = await runSweBenchBenchmark(
      {
        dataset: dirtyDsPath,
        limit: 1,
        arms: ['raw_full'],
        dockerPreset: 'epoch',
        cleanupImages: false,
        outputDir: keepOut,
      },
      {
        extractTestbedFromImage: async ({ targetDir }) => {
          cpSync(dirtySeedRepo, targetDir, { recursive: true });
          // Simulate pre-existing container setup modification on top of base_commit
          writeFileSync(join(targetDir, 'env_pin_setup.py'), '# container env setup pin == 1.0\n', 'utf8');
          return { targetDir, headCommit: dirtyBaseCommit };
        },
        createDockerAdapter: makeStubDockerAdapter,
        createAdapter: () => new PrefixBlockCacheSimulatorAdapter(),
        removeDockerImage: async (img) => {
          keepRmiCalls.push(img);
          return { image: img, removed: true };
        },
      },
    );
    assert.equal(keepRmiCalls.length, 0, '--keep-images must NOT invoke removeDockerImage');
    const keepPatch = keepRes.predictionsByArm.raw_full[0]?.model_patch ?? '';
    assert.match(keepPatch, /src\/discounts\/calculator\.py/);
    assert.equal(keepPatch.includes('env_pin_setup.py'), false, 'Pre-existing container env baseline edits must not leak into model_patch');

    // Verify reconciling turn (e.g. from timed-out container bash call) settles cleanly without unsettled-await hang
    let reconStage = 0;
    const reconOut = makeTmp('swe-wp5-recon-');
    const reconRes = await runSweBenchBenchmark(
      {
        dataset: dirtyDsPath,
        limit: 1,
        arms: ['raw_full'],
        dockerPreset: 'epoch',
        cleanupImages: false,
        outputDir: reconOut,
      },
      {
        extractTestbedFromImage: async ({ targetDir }) => {
          cpSync(dirtySeedRepo, targetDir, { recursive: true });
          return { targetDir, headCommit: dirtyBaseCommit };
        },
        createDockerAdapter: ({ workspaceRoot }) => {
          const adapterObj = {
            isSweBenchContainer: true,
            workspaceRoot,
            start: async () => 'stub-cid',
            run: async (cmd) => {
              if (cmd.includes('git diff')) {
                return { exitCode: 124, stdout: '', stderr: '[timeout after 500ms]', timedOut: true };
              }
              return { exitCode: 0, stdout: '1 passed\n', stderr: '', timedOut: false };
            },
            exec: async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false }),
            destroy: async () => {},
            close: async () => {},
          };
          adapterObj.resolveBackend = () => ({ mode: 'docker', tier: 'strong-os-isolation', backend: adapterObj });
          return adapterObj;
        },
        createAdapter: () =>
          new (class ReconAdapter extends LlmAdapter {
            async *stream() {
              if (reconStage === 0) {
                reconStage = 1;
                yield {
                  type: 'block-end',
                  index: 0,
                  block: {
                    type: 'tool-call',
                    id: 'rc-edit',
                    name: 'edit_file',
                    arguments: JSON.stringify({
                      path: 'src/discounts/calculator.py',
                      target: '    effective_pct = combined_pct',
                      replacement: '    effective_pct = min(combined_pct, max_discount_pct)',
                    }),
                  },
                };
                yield { type: 'finish', reason: { kind: 'tool-calls' } };
                return;
              }
              if (reconStage === 1) {
                reconStage = 2;
                yield {
                  type: 'block-end',
                  index: 0,
                  block: {
                    type: 'tool-call',
                    id: 'rc-timeout-diff',
                    name: 'bash',
                    arguments: JSON.stringify({ command: 'git diff', timeoutMs: 500 }),
                  },
                };
                yield { type: 'finish', reason: { kind: 'tool-calls' } };
                return;
              }
              if (reconStage === 2) {
                reconStage = 3;
                yield {
                  type: 'block-end',
                  index: 0,
                  block: {
                    type: 'tool-call',
                    id: 'rc-pytest',
                    name: 'bash',
                    arguments: JSON.stringify({ command: 'pytest -q' }),
                  },
                };
                yield { type: 'finish', reason: { kind: 'tool-calls' } };
                return;
              }
              yield { type: 'text-delta', index: 0, text: 'Patched and tested.' };
              yield { type: 'finish', reason: { kind: 'stop' } };
            }
          })(),
      },
    );
    assert.equal(reconRes.telemetryByArm.raw_full[0].status, 'reconciling');
    assert.match(reconRes.predictionsByArm.raw_full[0].model_patch, /src\/discounts\/calculator\.py/);

    // Verify env_error fault tolerance + --resume retry + latest-wins deduplication
    const errOut = makeTmp('swe-wp5-enverr-');
    const errRmiCalls = [];
    let failFirstInstance = true;
    const retriedIds = [];
    const errRun1 = await runSweBenchBenchmark(
      {
        dataset: cachePath,
        limit: 2,
        arms: ['raw_full'],
        dockerPreset: 'epoch',
        cleanupImages: true,
        outputDir: errOut,
      },
      {
        extractTestbedFromImage: async ({ targetDir, image }) => {
          if (failFirstInstance && image.includes(repoTemplates[0].id)) {
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          }
          cpSync(seedRepo, targetDir, { recursive: true });
          return { targetDir, headCommit: baseCommit };
        },
        createDockerAdapter: makeStubDockerAdapter,
        createAdapter: ({ instance }) => {
          retriedIds.push(instance.instance_id);
          return new PrefixBlockCacheSimulatorAdapter();
        },
        removeDockerImage: async (img) => {
          errRmiCalls.push(img);
          return { image: img, removed: true };
        },
      },
    );
    assert.equal(errRun1.telemetryByArm.raw_full.length, 2);
    assert.equal(errRun1.telemetryByArm.raw_full[0].status, 'env_error');
    assert.equal(errRun1.telemetryByArm.raw_full[1].status, 'completed');
    assert.equal(errRmiCalls.length, 2, 'Cleanup must still run after env_error');

    const resumeBefore = loadCompletedInstanceIds(errOut, 'raw_full');
    assert.equal(resumeBefore.completedIds.has(repoTemplates[0].id), false, 'env_error must NOT be treated as completed');
    assert.equal(resumeBefore.completedIds.has(repoTemplates[1].id), true);

    failFirstInstance = false;
    retriedIds.length = 0;
    const errRun2 = await runSweBenchBenchmark(
      {
        dataset: cachePath,
        limit: 2,
        arms: ['raw_full'],
        dockerPreset: 'epoch',
        resume: true,
        outputDir: errOut,
      },
      {
        extractTestbedFromImage: async ({ targetDir }) => {
          cpSync(seedRepo, targetDir, { recursive: true });
          return { targetDir, headCommit: baseCommit };
        },
        createDockerAdapter: makeStubDockerAdapter,
        createAdapter: ({ instance }) => {
          retriedIds.push(instance.instance_id);
          return new PrefixBlockCacheSimulatorAdapter();
        },
        removeDockerImage: async (img) => ({ image: img, removed: true }),
      },
    );
    assert.deepEqual(retriedIds, [repoTemplates[0].id], '--resume must retry ONLY the env_error instance');
    const resumeAfter = loadCompletedInstanceIds(errOut, 'raw_full');
    assert.equal(resumeAfter.completedIds.size, 2);
    assert.equal(errRun2.telemetryByArm.raw_full.length, 2);
    assert.equal(
      errRun2.telemetryByArm.raw_full.every((t) => t.status === 'completed'),
      true,
    );

    const summaryMd = readFileSync(runRes.summaryPath, 'utf8');
    assert.match(summaryMd, /Resolved Rate \(%\)/);
    assert.match(summaryMd, /Tokens \/ Resolved/);
    assert.match(summaryMd, /Paired Resolved Token Reduction/);

    const latexText = readFileSync(runRes.latexPath, 'utf8');
    assert.match(latexText, /\\begin\{tabular\}|raw\\_full|full\\_aci/);

    // 3. Standalone --eval-only on predictions.full_aci.jsonl + per-instance cleanup
    const evalOnlyOut = makeTmp('swe-wp5-evalonly-');
    const evalOnlyRmi = [];
    const evalOnlyRes = await runSweBenchBenchmark(
      {
        evalOnly: true,
        predictions: runRes.predictionsFiles.full_aci,
        dataset: cachePath,
        subset: 'smoke-5',
        seed: 42,
        dockerPreset: 'epoch',
        cleanupImages: true,
        outputDir: evalOnlyOut,
      },
      {
        createDockerSession: async ({ instance }) => ({
          workspaceRoot: '/tmp/eval',
          exec: async (cmd) => {
            if (/\bgit\s+|rm\s+-f/.test(cmd)) {
              return { exitCode: 0, stdout: 'ok', stderr: '' };
            }
            return instance.instance_id === 'psf__requests-101'
              ? { exitCode: 0, stdout: 'PASSED tests/test_req.py::test_hdr\n', stderr: '' }
              : { exitCode: 1, stdout: 'FAILED\n', stderr: '' };
          },
          destroy: async () => {},
        }),
        removeDockerImage: async (img) => {
          evalOnlyRmi.push(img);
          return { image: img, removed: true };
        },
      },
    );
    assert.equal(evalOnlyRes.evalOnly, true);
    assert.equal(evalOnlyRes.metricsByArm.full_aci.resolvedInstances, 1);
    assert.equal(existsSync(join(evalOnlyOut, 'eval.full_aci.jsonl')), true);
    assert.equal(existsSync(evalOnlyRes.latexPath), true);
    assert.ok(evalOnlyRmi.length >= 1, '--eval-only must trigger removeDockerImage per evaluated container');

    // Also verify parseEvalTestResults handles Django & SymPy cleanly
    const djangoParsed = parseEvalTestResults(
      'test_ok (auth_tests.test_forms.LoginTest) ... ok\nRan 1 test in 0.01s\nOK\n',
      {
        repo: 'django/django',
        failToPass: ['test_ok (auth_tests.test_forms.LoginTest)'],
        passToPass: [],
        exitCode: 0,
      },
    );
    assert.equal(djangoParsed.resolved, true);

    // 4. --dry-run remains green with 3.2 updates
    const dryOut = makeTmp('swe-wp5-dry-');
    const dryRes = await runSweBenchBenchmark({
      dryRun: true,
      exportLatex: true,
      outputDir: dryOut,
    });
    assert.equal(dryRes.metricsByArm.full_aci.nonEmptyPatchRate, 1);
    assert.ok(dryRes.metricsByArm.full_aci.admissionTokenReductionRate > 0);
    assert.equal(existsSync(dryRes.latexPath), true);
  });
});
