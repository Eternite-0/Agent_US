import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from '../fixtures.js';
import { DirectAgentRuntime } from '../../src/direct-agent.js';
import { SweBenchDockerAdapter } from '../../src/evaluation/swebench-docker.js';
import { TurnManager } from '../../src/kernel/agent-loop.js';
import {
  ExecutionReasoningTracker,
  STUCK_PATTERNS,
} from '../../src/kernel/execution-reasoning.js';
import { AgentRuntimeKernel } from '../../src/kernel/runtime.js';
import { AccountPool } from '../../src/pool.js';
import { Store } from '../../src/store.js';
import { ToolDispatcher } from '../../src/tools/dispatcher.js';
import { resolveConfinedPath } from '../../src/tools/sandbox.js';
import { createWorkspaceTools } from '../../src/workspace-tools.js';
import { buildSweBenchPrompt } from '../../scripts/benchmark-swebench.mjs';

const tc = (id, name, args = {}) => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

describe('SWE-bench /testbed path remapping, prompt guidance, and benchmark thrash tolerance', () => {
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

  test('1. resolveConfinedPath remaps virtual /testbed paths safely and rejects escapes/protected targets', () => {
    const ws = makeTmp('path-thrash-34-ws-');
    const outside = makeTmp('path-thrash-34-out-');
    mkdirSync(join(ws, 'django', 'db'), { recursive: true });
    mkdirSync(join(ws, '.git'), { recursive: true });
    writeFileSync(join(ws, 'django', 'db', 'models.py'), 'class Model: pass\n', 'utf8');
    writeFileSync(join(ws, 'django', 'models.py'), 'class RootModel: pass\n', 'utf8');
    writeFileSync(join(ws, '.git', 'config'), '[core]\n', 'utf8');
    writeFileSync(join(ws, '.dev-token'), 'secret\n', 'utf8');
    writeFileSync(join(outside, 'file.py'), 'outside\n', 'utf8');

    // Positive remapping cases
    assert.deepEqual(resolveConfinedPath(ws, '/testbed'), {
      full: resolve(ws),
      rel: '.',
    });
    assert.deepEqual(resolveConfinedPath(ws, '/testbed/'), {
      full: resolve(ws),
      rel: '.',
    });
    assert.deepEqual(resolveConfinedPath(ws, '/testbed/django/db/models.py'), {
      full: resolve(ws, 'django', 'db', 'models.py'),
      rel: 'django/db/models.py',
    });
    assert.deepEqual(resolveConfinedPath(ws, '\\testbed\\django\\db\\models.py'), {
      full: resolve(ws, 'django', 'db', 'models.py'),
      rel: 'django/db/models.py',
    });
    assert.deepEqual(resolveConfinedPath(ws, '/testbed/django/db/../models.py'), {
      full: resolve(ws, 'django', 'models.py'),
      rel: 'django/models.py',
    });

    // Negative confinement checks
    assert.throws(() => resolveConfinedPath(ws, '/testbed/../outside/file.py'), /超出当前工作区边界/);
    assert.throws(() => resolveConfinedPath(ws, '/testbed/a/../../outside/file.py'), /超出当前工作区边界/);
    assert.throws(() => resolveConfinedPath(ws, '/testbed2/django/db/models.py'), /超出当前工作区边界/);
    assert.throws(() => resolveConfinedPath(ws, '/testbed/.git/config'), /\.git/);
    assert.throws(() => resolveConfinedPath(ws, '/testbed/.dev-token'), /受保护的密钥文件/);
    assert.throws(() => resolveConfinedPath(ws, join(outside, 'file.py')), /超出当前工作区边界/);

    // Symlink escape via /testbed prefix must still be caught by symlink confinement walk
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
        () => resolveConfinedPath(ws, '/testbed/escape-link/file.py'),
        /符号链接路径逃逸出当前工作区边界/,
      );
    }
  });

  test('2. SweBenchDockerAdapter.mapHostCwdToContainer maps virtual /testbed & testbed cwds while blocking escapes', () => {
    const ws = makeTmp('docker-cwd-34-ws-');
    const outside = makeTmp('docker-cwd-34-out-');
    mkdirSync(join(ws, 'tests', 'unit'), { recursive: true });

    const adapter = new SweBenchDockerAdapter({
      image: 'local/testbed:latest',
      workspaceRoot: ws,
      pull: 'never',
    });

    // Positive /testbed virtual path mappings
    assert.equal(adapter.mapHostCwdToContainer('/testbed'), '/testbed');
    assert.equal(adapter.mapHostCwdToContainer('/testbed/'), '/testbed');
    assert.equal(adapter.mapHostCwdToContainer('/testbed/tests/unit'), '/testbed/tests/unit');
    assert.equal(adapter.mapHostCwdToContainer('/testbed/tests/unit/'), '/testbed/tests/unit');
    assert.equal(adapter.mapHostCwdToContainer('/testbed/a/../tests/unit'), '/testbed/tests/unit');
    assert.equal(adapter.mapHostCwdToContainer('/testbed/./tests/..'), '/testbed');

    // Relative 'testbed' and './testbed' when no testbed subdir exists -> '/testbed'
    assert.equal(adapter.mapHostCwdToContainer('testbed'), '/testbed');
    assert.equal(adapter.mapHostCwdToContainer('./testbed'), '/testbed');

    // When a real 'testbed' subdirectory DOES exist, preserve '/testbed/testbed'
    const wsWithSub = makeTmp('docker-cwd-34-sub-');
    mkdirSync(join(wsWithSub, 'testbed'), { recursive: true });
    const adapterWithSub = new SweBenchDockerAdapter({
      image: 'local/testbed:latest',
      workspaceRoot: wsWithSub,
      pull: 'never',
    });
    assert.equal(adapterWithSub.mapHostCwdToContainer('testbed'), '/testbed/testbed');
    assert.equal(adapterWithSub.mapHostCwdToContainer('./testbed'), '/testbed/testbed');

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

  test('3. buildSweBenchPrompt provides workspace-relative path & cleanup guidance in containerMode', () => {
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
    assert.match(containerPrompt, /django\/\.\.\./);
    assert.match(containerPrompt, /sphinx\/\.\.\./);
    assert.match(containerPrompt, /read_file/);
    assert.match(containerPrompt, /edit_file/);
    assert.match(containerPrompt, /apply_patch/);
    assert.match(containerPrompt, /grep/);
    assert.match(containerPrompt, /glob/);
    assert.match(containerPrompt, /bash/);
    assert.match(containerPrompt, /reproduction scripts/i);
    assert.match(containerPrompt, /git diff/);

    const localPrompt = buildSweBenchPrompt(instance, { containerMode: false });
    assert.doesNotMatch(localPrompt, /\/testbed/);
  });

  test('4a. TurnManager and ExecutionReasoningTracker keep threshold 3 by default and raise to 5 in benchmarkMode', () => {
    // Default TurnManager: window 6, threshold 3
    const tmDefault = new TurnManager({ eventRouter: null, sessionId: 's1', turnId: 't1' });
    assert.equal(tmDefault.recordToolSignature(tc('1', 'read_file', { path: 'a.py' }), false, { path: 'a.py' }), false);
    assert.equal(tmDefault.recordToolSignature(tc('2', 'read_file', { path: 'a.py' }), false, { path: 'a.py' }), false);
    assert.equal(tmDefault.recordToolSignature(tc('3', 'read_file', { path: 'a.py' }), false, { path: 'a.py' }), true);

    // Benchmark TurnManager: window 8, threshold 5
    const tmBench = new TurnManager({
      eventRouter: null,
      sessionId: 's2',
      turnId: 't2',
      benchmarkMode: true,
    });
    for (let i = 1; i <= 4; i++) {
      assert.equal(
        tmBench.recordToolSignature(tc(`b${i}`, 'read_file', { path: 'a.py' }), false, { path: 'a.py' }),
        false,
        `benchmark call #${i} must not trigger`,
      );
    }
    assert.equal(
      tmBench.recordToolSignature(tc('b5', 'read_file', { path: 'a.py' }), false, { path: 'a.py' }),
      true,
      'benchmark call #5 within window 8 must trigger',
    );

    // Window 8 eviction check: 4 repeats + 4 distinct + 1 repeat => window of 8 has 4 matching -> false
    const tmBenchWin = new TurnManager({
      eventRouter: null,
      sessionId: 's3',
      turnId: 't3',
      benchmarkMode: true,
    });
    for (let i = 1; i <= 4; i++) {
      assert.equal(tmBenchWin.recordToolSignature(tc(`w${i}`, 'read_file', { path: 'a.py' }), false, { path: 'a.py' }), false);
    }
    for (let i = 1; i <= 4; i++) {
      assert.equal(tmBenchWin.recordToolSignature(tc(`o${i}`, 'read_file', { path: `other${i}.py` }), false, { path: `other${i}.py` }), false);
    }
    assert.equal(tmBenchWin.recordToolSignature(tc('w5', 'read_file', { path: 'a.py' }), false, { path: 'a.py' }), false);

    // Default ExecutionReasoningTracker: EXACT_REPEAT at 3
    const erDefault = new ExecutionReasoningTracker();
    assert.equal(
      erDefault.recordToolResult({
        tc: tc('d1', 'edit_file', { path: 'x.py', target: 'bad', replacement: 'ok' }),
        output: '未找到匹配的 target 片段',
        isError: true,
        step: 1,
      }).trigger,
      null,
    );
    assert.equal(
      erDefault.recordToolResult({
        tc: tc('d2', 'edit_file', { path: 'x.py', target: 'bad', replacement: 'ok' }),
        output: '未找到匹配的 target 片段',
        isError: true,
        step: 2,
      }).trigger,
      null,
    );
    assert.equal(
      erDefault.recordToolResult({
        tc: tc('d3', 'edit_file', { path: 'x.py', target: 'bad', replacement: 'ok' }),
        output: '未找到匹配的 target 片段',
        isError: true,
        step: 3,
      }).trigger?.pattern,
      STUCK_PATTERNS.EXACT_REPEAT,
    );

    // Benchmark ExecutionReasoningTracker: EXACT_REPEAT at 5
    const erBench = new ExecutionReasoningTracker({ benchmarkMode: true });
    for (let i = 1; i <= 4; i++) {
      const res = erBench.recordToolResult({
        tc: tc(`eb${i}`, 'edit_file', { path: 'x.py', target: 'bad', replacement: 'ok' }),
        output: '未找到匹配的 target 片段',
        isError: true,
        step: i,
      });
      assert.equal(res.trigger, null, `benchmark failing repeat #${i} must not trigger`);
    }
    const er5 = erBench.recordToolResult({
      tc: tc('eb5', 'edit_file', { path: 'x.py', target: 'bad', replacement: 'ok' }),
      output: '未找到匹配的 target 片段',
      isError: true,
      step: 5,
    });
    assert.equal(er5.trigger?.pattern, STUCK_PATTERNS.EXACT_REPEAT);
  });

  test('4b. AgentLoop issues diagnostic steering warning first at 5 repeats in benchmarkMode even after policyBlockWarned, clears sigs, and recovers or circuit-breaks cleanly', async (t) => {
    const dataDir = makeTmp('loop-thrash-34-data-');
    const workDir = makeTmp('loop-thrash-34-work-');
    writeFileSync(join(workDir, 'app.py'), 'def fn():\n    return 1\n', 'utf8');
    const store = new Store(join(dataDir, 'engine.sqlite'));
    t.after(() => store.close());

    // Scenario A: policyBlockWarned set earlier via 2 different blocked bash calls, then 5 identical blocked bash calls:
    // Must NOT break on 3rd or 4th repeat; on 5th repeat must issue diagnostic steering warning first, then recover on read_file!
    let stepIdx = 0;
    let sawSteeringAfter5 = false;
    const kernelA = new AgentRuntimeKernel({
      store,
      adapter: {
        async *stream({ messages }) {
          stepIdx += 1;
          const userTexts = messages
            .filter((m) => m.role === 'user')
            .flatMap((m) => m.content ?? [])
            .map((b) => b.text ?? '')
            .join('\n');

          if (stepIdx === 1) {
            yield {
              type: 'block-end',
              block: { type: 'tool-call', id: 'p1', name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }) },
            };
            yield { type: 'finish', reason: { kind: 'tool-calls' } };
            return;
          }
          if (stepIdx === 2) {
            yield {
              type: 'block-end',
              block: { type: 'tool-call', id: 'p2', name: 'bash', arguments: JSON.stringify({ command: 'pwd' }) },
            };
            yield { type: 'finish', reason: { kind: 'tool-calls' } };
            return;
          }
          // Now 5 identical blocked calls (steps 3..7)
          if (stepIdx >= 3 && stepIdx <= 7) {
            yield {
              type: 'block-end',
              block: {
                type: 'tool-call',
                id: `rep-${stepIdx}`,
                name: 'bash',
                arguments: JSON.stringify({ command: 'node -e "1"' }),
              },
            };
            yield { type: 'finish', reason: { kind: 'tool-calls' } };
            return;
          }
          if (stepIdx === 8) {
            assert.match(userTexts, /\[系统防死循环提示\]/);
            sawSteeringAfter5 = true;
            yield {
              type: 'block-end',
              block: { type: 'tool-call', id: 'r1', name: 'read_file', arguments: JSON.stringify({ path: 'app.py' }) },
            };
            yield { type: 'finish', reason: { kind: 'tool-calls' } };
            return;
          }
          yield { type: 'text-delta', text: 'Recovered after steering.' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      },
      toolDispatcher: new ToolDispatcher({}),
    });
    t.after(() => kernelA.close());

    const resA = await kernelA.executeTurn({
      sessionId: 'sess-bench-steer-first',
      turnId: 'turn-bench-steer-first',
      profile: {
        id: 'default',
        defaultMaxSteps: 15,
        streamDeltas: false,
        emitAssistantMessage: false,
        emitToolEvents: false,
        persistTurn: false,
      },
      input: 'Fix app.py',
      model: 'mock',
      workspaceRoot: workDir,
      trafficSource: 'benchmark',
      permissionMode: 'auto-safe',
      requestApproval: async () => ({ allowed: false }),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix app.py' }] }],
      tools: createWorkspaceTools({ workspaceRoot: workDir, store, permissionMode: 'auto-safe' }),
    });
    assert.equal(resA.status, 'completed');
    assert.equal(sawSteeringAfter5, true);
    assert.equal(resA.reasoningMetrics.thrashWarned, true);
    assert.equal(resA.reasoningMetrics.circuitBroken, false);

    // Scenario B: sandboxProfile: 'benchmark' with non-error identical read_file calls:
    // Warns at 5, clears recentCallSigs, and breaks ONLY after 5 more repeats (10 total)
    let readCount = 0;
    const kernelB = new AgentRuntimeKernel({
      store,
      adapter: {
        async *stream() {
          readCount += 1;
          yield {
            type: 'block-end',
            block: {
              type: 'tool-call',
              id: `rd-${readCount}`,
              name: 'read_file',
              arguments: JSON.stringify({ path: 'app.py' }),
            },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        },
      },
      toolDispatcher: new ToolDispatcher({}),
    });
    t.after(() => kernelB.close());

    const resB = await kernelB.executeTurn({
      sessionId: 'sess-bench-read-break',
      turnId: 'turn-bench-read-break',
      profile: {
        id: 'default',
        defaultMaxSteps: 15,
        streamDeltas: false,
        emitAssistantMessage: false,
        emitToolEvents: false,
        persistTurn: false,
      },
      input: 'Read app.py',
      model: 'mock',
      workspaceRoot: workDir,
      sandboxProfile: 'benchmark',
      permissionMode: 'full-access',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read app.py' }] }],
      tools: createWorkspaceTools({ workspaceRoot: workDir, store, permissionMode: 'full-access' }),
    });
    assert.equal(resB.status, 'failed');
    assert.equal(resB.stopReason, 'thrashing_circuit_break');
    assert.equal(readCount, 10, '5 repeats for warning (with recentCallSigs cleared) + 5 repeats for break');
  });

  test('4c. DirectAgentRuntime propagates trafficSource and sandboxProfile into kernel.executeTurn', async () => {
    const stateDir = makeTmp('direct-prop-34-state-');
    const workDir = makeTmp('direct-prop-34-work-');
    writeFileSync(join(workDir, 'README.md'), '# test\n', 'utf8');
    const store = new Store(join(stateDir, 'engine.sqlite'));
    const pool = new AccountPool(store, { root: stateDir });
    pool.createAccount({
      preset: 'custom-openai',
      label: 'sim',
      credential: 'sk-sim',
      endpoint: 'https://sim.invalid/v1',
      models: ['sim-model'],
    });
    pool.setDefaultModel('sim-model');

    class MockStopAdapter extends LlmAdapter {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: 'Done.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }

    const direct = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: workDir,
      dataRoot: stateDir,
      adapter: new MockStopAdapter(),
    });

    const capturedParams = [];
    const origExecuteTurn = direct.kernel.executeTurn.bind(direct.kernel);
    direct.kernel.executeTurn = async (params) => {
      capturedParams.push(params);
      return origExecuteTurn(params);
    };

    try {
      const dockerAdapter = new SweBenchDockerAdapter({
        image: 'local/testbed:latest',
        workspaceRoot: workDir,
        pull: 'never',
      });
      const session = direct.createSession({
        title: 'bench-prop-check',
        workspaceRoot: workDir,
        model: 'sim-model',
        permissionMode: 'auto-safe',
        sandbox: dockerAdapter,
        sandboxProfile: 'benchmark',
        trafficSource: 'benchmark',
      });
      const { turn } = direct.startTurn(session.id, {
        input: 'Check README',
        model: 'sim-model',
        permissionMode: 'auto-safe',
        trafficSource: 'benchmark',
        maxSteps: 5,
      });
      await direct.waitForTurnTerminal(turn.id, { timeoutMs: 15_000 });
      assert.equal(capturedParams.length, 1);
      assert.equal(capturedParams[0].trafficSource, 'benchmark');
      assert.equal(capturedParams[0].sandboxProfile, 'benchmark');
    } finally {
      await direct.close();
      store.close();
    }
  });
});
