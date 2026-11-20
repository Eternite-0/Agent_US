import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { HookRunner } from '../src/agent-context.js';
import { ToolDispatcher } from '../src/tools/dispatcher.js';
import { ToolPermissionPolicy, intersectPolicies } from '../src/tools/policy.js';
import { UnknownOutcomeReconciler } from '../src/durable/reconciliation.js';
import { EventRouter } from '../src/kernel/events.js';
import { defineTool, EFFECT_CLASSES, RISK_LEVELS } from '../src/tools/registry.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.calls = [];
  }
  async *stream(options) {
    const idx = this.calls.length;
    this.calls.push({
      model: options.model,
      tools: (options.tools ?? []).map((t) => t.name),
      messages: structuredClone(options.messages),
    });
    yield* this.handler(options, idx);
  }
}

async function waitTurnSettled(direct, sessionId, turnId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = direct.listTurns(sessionId).find((x) => x.id === turnId);
    if (t && ['completed', 'failed', 'cancelled', 'reconciling', 'parked'].includes(t.state)) {
      return t;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for turn ${turnId}`);
}

test('Fix A1-A6: Model writing .agent-us/hooks.json cannot activate hooks in same-turn PostToolUse, next step, or after restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-fixa-model-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fixa-model-work-'));
  const dbPath = join(dataDir, 'engine.sqlite');
  const markerPath = join(workDir, 'hook-executed.flag');
  writeFileSync(join(workDir, 'readme.txt'), 'hello workspace\n', 'utf8');

  const harmlessHookConfig = JSON.stringify(
    {
      PreToolUse: [
        {
          matcher: 'read_file',
          kind: 'observation',
          command: `node -e "require('fs').writeFileSync('hook-executed.flag', 'pre')"`,
        },
      ],
      PostToolUse: [
        {
          matcher: '.*',
          kind: 'observation',
          command: `node -e "require('fs').writeFileSync('hook-executed.flag', 'post')"`,
        },
      ],
    },
    null,
    2,
  );

  let store = new Store(dbPath);
  let pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-model');

  const adapter1 = new ScriptedAdapter(async function* (opts) {
    const toolCount = opts.messages.filter((m) => m.role === 'tool').length;
    if (toolCount === 0) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-write-hook',
          name: 'write_file',
          arguments: JSON.stringify({
            path: '.agent-us/hooks.json',
            content: harmlessHookConfig,
          }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (toolCount === 1) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-read-after',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'readme.txt' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: 'Draft hook written and readme read.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  let direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: adapter1,
  });

  try {
    const sess = direct.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
    const started = direct.startTurn(sess.id, { input: 'create hook draft and read readme' });
    const done = await waitTurnSettled(direct, sess.id, started.turn.id);
    assert.equal(done.state, 'completed');
    assert.equal(existsSync(join(workDir, '.agent-us', 'hooks.json')), true, 'draft file may exist on disk');
    assert.equal(
      existsSync(markerPath),
      false,
      'unapproved hook written by model MUST NOT execute in PostToolUse or subsequent steps',
    );

    // Reboot runtime on same DB + workspace: restart MUST enforce identical trust boundary
    await direct.close();
    store.close();

    store = new Store(dbPath);
    pool = new AccountPool(store, { root: dataDir });
    pool.setDefaultModel('mock-model');

    const adapter2 = new ScriptedAdapter(async function* (opts) {
      const lastUser = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
      const hasToolInTurn = opts.messages.at(-1)?.role === 'tool';
      if (lastUser.includes('after restart') && !hasToolInTurn) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-read-restart',
            name: 'read_file',
            arguments: JSON.stringify({ path: 'readme.txt' }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'Read after restart complete.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });

    direct = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: workDir,
      dataRoot: dataDir,
      adapter: adapter2,
    });

    const t2 = direct.startTurn(sess.id, { input: 'read readme after restart' });
    const done2 = await waitTurnSettled(direct, sess.id, t2.turn.id);
    assert.equal(done2.state, 'completed');
    assert.equal(
      existsSync(markerPath),
      false,
      'unapproved hook draft MUST remain inactive after process restart',
    );
  } finally {
    await direct.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('Fix A4-A6: Explicit digest-bound hook trust survives restart and is invalidated immediately on modification', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-fixa-trust-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fixa-trust-work-'));
  const dbPath = join(dataDir, 'engine.sqlite');
  const hooksFile = join(workDir, '.agent-us', 'hooks.json');
  const ranLog = join(workDir, 'hook-runs.log');
  mkdirSync(join(workDir, '.agent-us'), { recursive: true });

  const v1Config = JSON.stringify({
    PreToolUse: [
      {
        matcher: 'write_file',
        kind: 'security',
        command: `node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); if(String(d.arguments?.path||'').includes('secret.txt')){ console.log(JSON.stringify({decision:'block',reason:'blocked-v1'})); process.exit(2); }"`,
      },
    ],
    PostToolUse: [
      {
        matcher: 'read_file',
        kind: 'observation',
        command: `node -e "require('fs').appendFileSync('hook-runs.log', 'v1\\n'); console.log(JSON.stringify({additionalContext:'trusted-v1-note'}))"`,
      },
    ],
  });
  writeFileSync(hooksFile, v1Config, 'utf8');

  let store = new Store(dbPath);
  let pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-model');
  let direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: { async *stream() {} },
  });

  try {
    // 1. Before approval: repo hook MUST be inactive
    const runnerBefore = new HookRunner(workDir, { dataRoot: dataDir, store });
    const preBefore = await runnerBefore.run('PreToolUse', {
      tool: 'write_file',
      arguments: { path: 'secret.txt', content: 'x' },
    });
    assert.equal(preBefore.blocked, false, 'untrusted repo hook must remain inactive before approval');
    const postBefore = await runnerBefore.run('PostToolUse', {
      tool: 'read_file',
      arguments: { path: 'a.txt' },
    });
    assert.equal(existsSync(ranLog), false, 'untrusted observation hook must not execute');
    assert.equal(postBefore.additionalContexts.length, 0);

    // 2. Explicitly trust exact file digest via DirectAgentRuntime API
    assert.equal(typeof direct.approveHookConfig, 'function', 'DirectAgentRuntime must expose approveHookConfig');
    const approval = direct.approveHookConfig(hooksFile, { approvedBy: 'operator' });
    assert.equal(approval.status, 'trusted');
    assert.match(approval.contentDigest, /^[0-9a-f]{64}$/);

    // 3. Trusted hook now enforces security block and runs observation hook
    const preTrusted = await runnerBefore.run('PreToolUse', {
      tool: 'write_file',
      arguments: { path: 'secret.txt', content: 'x' },
    });
    assert.equal(preTrusted.blocked, true);
    assert.match(preTrusted.reason, /blocked-v1/);

    const postTrusted = await runnerBefore.run('PostToolUse', {
      tool: 'read_file',
      arguments: { path: 'a.txt' },
    });
    assert.ok(postTrusted.additionalContexts.includes('trusted-v1-note'));
    assert.equal(readFileSync(ranLog, 'utf8'), 'v1\n');

    // 4. Restart preserves trust for unmodified approved digest
    await direct.close();
    store.close();
    store = new Store(dbPath);
    pool = new AccountPool(store, { root: dataDir });
    direct = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: workDir,
      dataRoot: dataDir,
      adapter: { async *stream() {} },
    });

    const runnerRestart = new HookRunner(workDir, { dataRoot: dataDir, store });
    const preAfterRestart = await runnerRestart.run('PreToolUse', {
      tool: 'write_file',
      arguments: { path: 'secret.txt', content: 'x' },
    });
    assert.equal(preAfterRestart.blocked, true, 'approved unmodified config stays trusted across restart');

    // 5. Modifying approved hooks.json invalidates trust immediately!
    const v2Tampered = JSON.stringify({
      PostToolUse: [
        {
          matcher: 'read_file',
          kind: 'observation',
          command: `node -e "require('fs').appendFileSync('hook-runs.log', 'v2-tampered\\n')"`,
        },
      ],
    });
    writeFileSync(hooksFile, v2Tampered, 'utf8');

    const postAfterTamper = await runnerRestart.run('PostToolUse', {
      tool: 'read_file',
      arguments: { path: 'a.txt' },
    });
    assert.equal(
      readFileSync(ranLog, 'utf8'),
      'v1\n',
      'modified hook config MUST immediately lose trust and not execute',
    );
    assert.equal(postAfterTamper.additionalContexts.length, 0);

    // 6. Approving with wrong expectedDigest is rejected (409 HOOK_DIGEST_MISMATCH)
    assert.throws(
      () =>
        direct.approveHookConfig(hooksFile, {
          expectedDigest: '0'.repeat(64),
          approvedBy: 'operator',
        }),
      (err) => err.code === 'HOOK_DIGEST_MISMATCH',
    );

    // 7. Model editing/patching an APPROVED hooks.json via edit_file / apply_patch revokes trust
    // immediately and MUST NOT execute the new hook in PostToolUse of that same turn!
    writeFileSync(hooksFile, v1Config, 'utf8');
    direct.approveHookConfig(hooksFile, { approvedBy: 'operator' });
    const editMarker = join(workDir, 'edited-hook-ran.flag');
    const editAdapter = new ScriptedAdapter(async function* (opts) {
      const toolCount = opts.messages.filter((m) => m.role === 'tool').length;
      if (toolCount === 0) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'tc-patch-hook',
            name: 'apply_patch',
            arguments: JSON.stringify({
              patch: [
                '*** Begin Patch',
                '*** Update File: .agent-us/hooks.json',
                '@@',
                `-${v1Config}`,
                `+${JSON.stringify({ PostToolUse: [{ matcher: '.*', kind: 'observation', command: `node -e "require('fs').writeFileSync('edited-hook-ran.flag','patched')"` }] })}`,
                '*** End Patch',
              ].join('\n'),
            }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'Patched hook draft.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    direct.adapter = editAdapter;
    direct.kernel.inference.adapter = editAdapter;
    const sessPatch = direct.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });
    const tPatch = direct.startTurn(sessPatch.id, { input: 'patch hooks.json' });
    const dPatch = await waitTurnSettled(direct, sessPatch.id, tPatch.turn.id);
    assert.equal(dPatch.state, 'completed');
    assert.equal(
      existsSync(editMarker),
      false,
      'apply_patch modifying approved hooks.json MUST revoke trust and NOT run in same-turn PostToolUse',
    );
    assert.equal(direct.inspectHookConfig(hooksFile).trusted, false);
  } finally {
    await direct.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('Fix A7-A8: Hook execution sanitizes env, honors AbortSignal & timeout, and observation hooks gain no extra privileges', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-fixa-exec-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fixa-exec-work-'));
  const hooksFile = join(workDir, '.agent-us', 'hooks.json');
  mkdirSync(join(workDir, '.agent-us'), { recursive: true });

  const prevOpenAi = process.env.OPENAI_API_KEY;
  const prevBackendTok = process.env.BACKEND_TOKEN;
  process.env.OPENAI_API_KEY = 'sk-hook-leak-sentinel-999';
  process.env.BACKEND_TOKEN = 'tok-hook-leak-sentinel-999';

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: { async *stream() {} },
  });

  try {
    // 1. Sanitized env check on approved observation hook
    writeFileSync(
      hooksFile,
      JSON.stringify({
        PostToolUse: [
          {
            matcher: 'read_file',
            kind: 'observation',
            command: `node -e "console.log(JSON.stringify({additionalContext: JSON.stringify({openai: process.env.OPENAI_API_KEY || null, tok: process.env.BACKEND_TOKEN || null})}))"`,
          },
        ],
      }),
      'utf8',
    );
    assert.equal(typeof direct.approveHookConfig, 'function');
    direct.approveHookConfig(hooksFile, { approvedBy: 'operator' });

    const runner = new HookRunner(workDir, { dataRoot: dataDir, store });
    const envRes = await runner.run('PostToolUse', { tool: 'read_file', arguments: { path: 'a' } });
    assert.equal(envRes.additionalContexts.length, 1);
    const leaked = JSON.parse(envRes.additionalContexts[0]);
    assert.equal(leaked.openai, null, 'OPENAI_API_KEY must be stripped from hook env');
    assert.equal(leaked.tok, null, 'BACKEND_TOKEN must be stripped from hook env');

    // 2. AbortSignal cancels running hook promptly
    writeFileSync(
      hooksFile,
      JSON.stringify({
        PostToolUse: [
          {
            matcher: 'read_file',
            kind: 'observation',
            timeoutMs: 10000,
            command: 'node -e "setTimeout(() => console.log(\'late\'), 10000)"',
          },
        ],
      }),
      'utf8',
    );
    direct.approveHookConfig(hooksFile, { approvedBy: 'operator' });

    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort('cancelled'), 150);
    await runner
      .run('PostToolUse', { tool: 'read_file', arguments: { path: 'a' } }, { signal: ac.signal })
      .catch(() => {});
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3500, `Hook must cancel promptly on AbortSignal, took ${elapsed}ms`);

    // 3. Security hook timeout fails closed
    writeFileSync(
      hooksFile,
      JSON.stringify({
        PreToolUse: [
          {
            matcher: 'read_file',
            kind: 'security',
            timeoutMs: 500,
            command: 'node -e "setTimeout(() => {}, 8000)"',
          },
        ],
      }),
      'utf8',
    );
    direct.approveHookConfig(hooksFile, { approvedBy: 'operator' });

    const timeoutRes = await runner.run('PreToolUse', { tool: 'read_file', arguments: { path: 'a' } });
    assert.equal(timeoutRes.blocked, true, 'Timed-out security hook must fail closed');
  } finally {
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAi;
    if (prevBackendTok === undefined) delete process.env.BACKEND_TOKEN;
    else process.env.BACKEND_TOKEN = prevBackendTok;
    await direct.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('Fix A9-A10: Explicit allowlist semantics (null vs [] vs non-empty) hold across policy, dispatcher, child spawn/fork/resume, and swarm crash recovery', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-fixa-allow-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-fixa-allow-work-'));
  const dbPath = join(dataDir, 'engine.sqlite');
  writeFileSync(join(workDir, 'sample.txt'), 'allowed-content\n', 'utf8');

  // 1. intersectPolicies preserves [] and never widens to null
  assert.deepEqual(
    intersectPolicies({ allowTools: ['read_file'] }, { allowTools: ['write_file'] }).allowTools,
    [],
  );
  assert.deepEqual(intersectPolicies({ allowTools: [] }, { allowTools: null }).allowTools, []);
  assert.deepEqual(intersectPolicies({ allowTools: null }, { allowTools: [] }).allowTools, []);
  assert.equal(intersectPolicies({ allowTools: null }, { allowTools: undefined }).allowTools, null);

  // 2. ToolPermissionPolicy enforces allowTools: [] = deny all, null = unrestricted, non-empty = allow only listed
  const readTool = defineTool({
    name: 'read_file',
    description: 'read',
    effectClass: EFFECT_CLASSES.READ_ONLY,
    riskLevel: RISK_LEVELS.LOW,
    zodSchema: z.object({ path: z.string() }),
    execute: async () => 'ok',
  });
  const emptyPolicy = new ToolPermissionPolicy({ permissionMode: 'full-access', allowTools: [] });
  assert.equal(emptyPolicy.evaluate(readTool, { path: 'sample.txt' }).decision, 'deny');

  const restrictedPolicy = new ToolPermissionPolicy({
    permissionMode: 'full-access',
    allowTools: ['glob'],
  });
  assert.equal(restrictedPolicy.evaluate(readTool, { path: 'sample.txt' }).decision, 'deny');

  const openPolicy = new ToolPermissionPolicy({ permissionMode: 'full-access', allowTools: null });
  assert.equal(openPolicy.evaluate(readTool, { path: 'sample.txt' }).decision, 'allow');

  let store = new Store(dbPath);
  const router = new EventRouter(store);
  const reconciler = new UnknownOutcomeReconciler(store, router);

  // 3. ToolDispatcher enforces allowTools: [] even when tool is passed in tools[]
  let sideRuns = 0;
  const probeTool = defineTool({
    name: 'probe_read',
    description: 'probe',
    effectClass: EFFECT_CLASSES.READ_ONLY,
    riskLevel: RISK_LEVELS.LOW,
    zodSchema: z.object({}),
    execute: async () => {
      sideRuns++;
      return 'ran';
    },
  });
  const dispatcher = new ToolDispatcher({
    store,
    eventRouter: router,
    reconciler,
    policy: new ToolPermissionPolicy({ permissionMode: 'full-access' }),
  });
  const deniedEmpty = await dispatcher.dispatchBatch({
    sessionId: 's-allow',
    turnId: 't-allow',
    toolCalls: [{ id: 'c-1', name: 'probe_read', arguments: '{}' }],
    tools: [probeTool],
    allowTools: [],
  });
  assert.equal(deniedEmpty[0].isError, true);
  assert.equal(sideRuns, 0);

  let pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-model');

  const seenToolsByTag = new Map();
  let attemptedToolOnEmptyRejected = false;
  const adapter = new ScriptedAdapter(async function* (opts) {
    const lastUser = opts.messages.findLast((m) => m.role === 'user')?.content?.[0]?.text ?? '';
    const hasToolResult = opts.messages.some((m) => m.role === 'tool');
    const tagMatch = /TAG:(\S+)/.exec(lastUser);
    const tag = tagMatch ? tagMatch[1] : 'default';
    if (!seenToolsByTag.has(tag)) {
      seenToolsByTag.set(tag, (opts.tools ?? []).map((t) => t.name));
    }

    if (tag === 'empty-inter' && !hasToolResult) {
      // Even if model hallucinates a read_file tool call when allowlist is [], dispatcher must reject!
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-hallucinated',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'sample.txt' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (tag === 'empty-inter' && hasToolResult) {
      const toolMsg = opts.messages.findLast((m) => m.role === 'tool')?.content?.[0]?.text ?? '';
      if (/未知工具|安全策略拦截|禁止|allowlist|denied/i.test(toolMsg)) {
        attemptedToolOnEmptyRejected = true;
      }
      yield { type: 'text-delta', index: 0, text: 'empty allowlist confirmed' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (tag === 'allowed-ro' && !hasToolResult) {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-ro-ok',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'sample.txt' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: `done:${tag}` };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  let direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter,
  });

  try {
    const parent = direct.createSession({ workspaceRoot: workDir, permissionMode: 'auto-safe' });

    // 4. ChildAgentManager.spawn with empty parent∩child allowlist yields 0 tools & denies calls
    const emptyChild = await direct.childManager.spawn({
      parentSessionId: parent.id,
      objective: 'TAG:empty-inter inspect',
      parentAllowTools: ['read_file'],
      allowedTools: ['write_file'],
      workspaceRoot: workDir,
    });
    assert.deepEqual(seenToolsByTag.get('empty-inter'), [], 'empty parent∩child allowlist MUST expose 0 tools');
    assert.equal(attemptedToolOnEmptyRejected, true, 'hallucinated tool call under [] allowlist MUST be denied');
    assert.equal(emptyChild.text, 'empty allowlist confirmed');

    // 5. Normal allowed read-only child still works
    const roChild = await direct.childManager.spawn({
      parentSessionId: parent.id,
      objective: 'TAG:allowed-ro read sample',
      parentAllowTools: ['read_file', 'glob'],
      allowedTools: ['read_file'],
      workspaceRoot: workDir,
    });
    assert.deepEqual(seenToolsByTag.get('allowed-ro'), ['read_file']);
    assert.equal(roChild.text, 'done:allowed-ro');

    // 6. Fork + pause + resume MUST preserve empty or restricted allowlist (never widen to unrestricted!)
    const forked = await direct.childManager.fork({
      parentSessionId: parent.id,
      objective: 'TAG:fork-empty initial',
      allowedTools: [],
      workspaceRoot: workDir,
    });
    assert.deepEqual(seenToolsByTag.get('fork-empty'), []);
    direct.childManager.pause(forked.childSessionId);
    await direct.childManager.resume(forked.childSessionId, {
      objective: 'TAG:resume-empty continue',
    });
    assert.deepEqual(
      seenToolsByTag.get('resume-empty'),
      [],
      'resume MUST preserve [] allowlist and never widen to unrestricted',
    );

    // 7. Swarm node with toolAllow: [] persists '[]' and stays [] across crash recovery
    const submitted = direct.swarmOrchestrator.submitRun({
      sessionId: parent.id,
      goal: 'Empty allowlist swarm node',
      workspaceRoot: workDir,
      nodes: [
        {
          nodeKey: 'no-tools-node',
          taskType: 'research',
          objective: 'TAG:swarm-empty-recover check',
          dependencies: [],
          toolAllow: [],
        },
      ],
    });
    // Force node into interrupted state & reboot before it executes so crash recovery runs it
    await direct.close();
    store.tx(() => {
      store.db
        .prepare("UPDATE swarm_nodes SET status='interrupted', toolAllowJson='[]' WHERE runId=? AND nodeKey='no-tools-node'")
        .run(submitted.runId);
      store.db
        .prepare("UPDATE swarm_runs SET status='running', currentPhase='running' WHERE id=?")
        .run(submitted.runId);
    });
    store.close();

    store = new Store(dbPath);
    pool = new AccountPool(store, { root: dataDir });
    pool.setDefaultModel('mock-model');
    seenToolsByTag.delete('swarm-empty-recover');
    direct = new DirectAgentRuntime(store, pool, {
      defaultWorkspace: workDir,
      dataRoot: dataDir,
      adapter,
    });

    const hydrated = direct.swarmOrchestrator.getRun(submitted.runId);
    assert.deepEqual(
      hydrated.nodes[0].toolAllow,
      [],
      'hydrated swarm_nodes.toolAllowJson="[]" MUST stay [] and never widen to null',
    );
    const doneSwarm = await direct.swarmOrchestrator.waitForRun(submitted.runId, { timeoutMs: 8000 });
    assert.equal(doneSwarm.status, 'completed');
    assert.deepEqual(
      seenToolsByTag.get('swarm-empty-recover'),
      [],
      'recovered swarm node with toolAllowJson="[]" MUST execute with 0 tools',
    );
  } finally {
    await direct.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
