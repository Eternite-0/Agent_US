import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { JudgmentService } from '../src/judgment.js';
import { api } from '../src/api.js';
import {
  applyCodexPatch,
  applyFuzzyEdit,
  canonicalizeCommandPrefix,
  runQuickDiagnostics,
  scheduleToolBatch,
} from '../src/patch-and-diagnostics.js';
import {
  discoverProjectInstructions,
  HookRunner,
} from '../src/agent-context.js';
import { HookTrustManager } from '../src/tools/hook-trust.js';
import { resolveSafePath } from '../src/workspace-tools.js';

class ScriptedAdapter extends LlmAdapter {
  constructor(handlers) {
    super();
    this.handlers = handlers;
    this.calls = [];
  }
  async *stream(options) {
    const idx = this.calls.length;
    this.calls.push(options);
    const fn = this.handlers[idx] ?? this.handlers.at(-1);
    yield* fn(options);
  }
}

async function waitTurnDone(directAgent, sessionId, turnId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = directAgent.listTurns(sessionId).find((x) => x.id === turnId);
    if (t && ['completed', 'failed', 'cancelled'].includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Timed out waiting for turn');
}

test('Codex 4-tier fuzzy edit, atomic apply_patch, command canonicalization, diagnostics, and parallel read scheduler', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-patch-'));
  try {
    // 1. 4-tier fuzzy edit tolerates indentation & Unicode dashes/quotes
    const src = 'function greet() {\n    // hello — “world”\n    return 1;\n}\n';
    const fuzzy = applyFuzzyEdit(src, '// hello - "world"\nreturn 1;', '    // updated\n    return 2;');
    assert.equal(fuzzy.ok, true);
    assert.equal(fuzzy.tier, 'unicode');
    assert.ok(fuzzy.after.includes('return 2;'));

    // 2. Atomic multi-file Codex apply_patch (Add + Update + Delete)
    writeFileSync(join(workDir, 'a.js'), 'const x = 1;\nconsole.log(x);\n', 'utf8');
    writeFileSync(join(workDir, 'obsolete.txt'), 'remove me\n', 'utf8');
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.js',
      '@@',
      '-const x = 1;',
      '+const x = 42;',
      ' console.log(x);',
      '*** Add File: sub/b.js',
      '+export const y = 99;',
      '*** Delete File: obsolete.txt',
      '*** End Patch',
    ].join('\n');
    const touched = applyCodexPatch(patch, { workspaceRoot: workDir, resolveSafePath });
    assert.equal(touched.length, 3);
    assert.equal(readFileSync(join(workDir, 'a.js'), 'utf8'), 'const x = 42;\nconsole.log(x);\n');
    assert.equal(readFileSync(join(workDir, 'sub/b.js'), 'utf8'), 'export const y = 99;');
    assert.equal(existsSync(join(workDir, 'obsolete.txt')), false);

    // 3. Auto-diagnostics detects broken JS syntax immediately
    const brokenPath = join(workDir, 'broken.js');
    writeFileSync(brokenPath, 'function bad( { return 1 }\n', 'utf8');
    const diag = runQuickDiagnostics(brokenPath, 'broken.js');
    assert.equal(diag.ok, false);
    assert.ok(diag.summary.includes('自动语法诊断'));

    // 4. Command canonicalization strips safe wrappers, refuses raw interpreters/shells, and refuses compound/substitution operators
    assert.equal(canonicalizeCommandPrefix('bash -lc "npm test -- --watch"'), 'npm test');
    assert.equal(
      canonicalizeCommandPrefix('node -e "import(\'./math.mjs\').then(m => console.log(m.add(1,2)))"'),
      null,
    );
    assert.equal(canonicalizeCommandPrefix('sh -c "npm test "; whoami; echo "ok"'), null);
    assert.equal(canonicalizeCommandPrefix('npm test && rm -rf build'), null);
    assert.equal(canonicalizeCommandPrefix('node -e "$(whoami)"'), null);
    assert.equal(canonicalizeCommandPrefix('echo hi > out.txt'), null);

    // 5. Parallel read-only batching + sequential write barriers
    const timeline = [];
    const calls = [
      { id: 'r1', readOnly: true },
      { id: 'r2', readOnly: true },
      { id: 'w1', readOnly: false },
      { id: 'r3', readOnly: true },
    ];
    let activeReads = 0;
    let peakConcurrentReads = 0;
    const out = await scheduleToolBatch(
      calls,
      (c) => c.readOnly,
      async (c) => {
        if (c.readOnly) {
          activeReads++;
          peakConcurrentReads = Math.max(peakConcurrentReads, activeReads);
        }
        timeline.push(`start:${c.id}`);
        await new Promise((r) => setTimeout(r, 35));
        timeline.push(`end:${c.id}`);
        if (c.readOnly) activeReads--;
        return c.id;
      },
    );
    assert.deepEqual(out, ['r1', 'r2', 'w1', 'r3']);
    assert.equal(peakConcurrentReads, 2);
    // Write barrier starts strictly after both reads finish
    assert.ok(timeline.indexOf('start:w1') > timeline.indexOf('end:r1'));
    assert.ok(timeline.indexOf('start:w1') > timeline.indexOf('end:r2'));
    assert.ok(timeline.indexOf('start:r3') > timeline.indexOf('end:w1'));
  } finally {
    rmDirSafe(workDir);
  }
});

test('DirectAgent Wave 1-3: Prompt Cache stability, AGENTS.md, /rewind, approval prefix cache, update_plan, FTS5 search, hooks, vision, effort', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-upg-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-upg-work-'));
  mkdirSync(join(workDir, '.git'), { recursive: true });
  writeFileSync(join(workDir, 'AGENTS.md'), 'Always run npm test before concluding.\n', 'utf8');
  writeFileSync(join(workDir, 'app.js'), 'export const v = 1;\n', 'utf8');

  // Verify AGENTS.md hierarchical discovery
  const docs = discoverProjectInstructions(workDir);
  assert.ok(docs.files.includes('AGENTS.md'));
  assert.ok(docs.text.includes('Always run npm test'));

  // Configure a deterministic PreToolUse hook blocking any write to forbidden.txt
  mkdirSync(join(workDir, '.agent-us'), { recursive: true });
  const hooksFile = join(workDir, '.agent-us', 'hooks.json');
  writeFileSync(
    hooksFile,
    JSON.stringify({
      PreToolUse: [
        {
          matcher: 'write_file',
          command: `node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); if(String(d.arguments?.path||'').includes('forbidden')){ console.log(JSON.stringify({decision:'block',reason:'blocked by policy hook'})); process.exit(2); }"`,
        },
      ],
    }),
    'utf8',
  );
  const hookTrust = new HookTrustManager();
  hookTrust.approveFile(hooksFile, { workspaceRoot: workDir, approvedBy: 'test' });
  const hookCheck = await new HookRunner(workDir, { trustManager: hookTrust }).run('PreToolUse', {
    tool: 'write_file',
    arguments: { path: 'forbidden.txt', content: 'x' },
  });
  assert.equal(hookCheck.blocked, true);
  assert.ok(hookCheck.reason.includes('blocked by policy hook'));

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-claude');

  const scripted = new ScriptedAdapter([
    // Turn 1 step 1: calls update_plan + read_file + write_file (to be rewound!)
    async function* (opts) {
      assert.equal(opts.effort, 'high');
      // Verify multimodal image attachment reached the model as an image block
      const lastUser = opts.messages.findLast((m) => m.role === 'user');
      assert.ok(lastUser.content.some((b) => b.type === 'image' && b.mimeType === 'image/png'));
      // Verify AGENTS.md reached runtime context
      const allText = opts.messages.map((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')).join('\n');
      assert.ok(allText.includes('Always run npm test'));

      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-plan',
          name: 'update_plan',
          arguments: JSON.stringify({
            explanation: '两步完成',
            steps: [
              { id: '1', title: '修改 app.js', status: 'in_progress' },
              { id: '2', title: '新建 extra.js', status: 'pending' },
            ],
          }),
        },
      };
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'tc-edit',
          name: 'edit_file',
          arguments: JSON.stringify({
            path: 'app.js',
            target: 'export const v = 1;',
            replacement: 'export const v = 2;',
          }),
        },
      };
      yield {
        type: 'block-end',
        index: 2,
        block: {
          type: 'tool-call',
          id: 'tc-new',
          name: 'write_file',
          arguments: JSON.stringify({
            path: 'extra.js',
            content: 'export const extra = true;\n',
          }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Turn 1 step 2: done
    async function* () {
      yield { type: 'text-delta', index: 0, text: '已完成 app.js 和 extra.js 修改，关键词 QUASAR_TOKEN_99。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    // Turn 2: verifies static System Prompt is byte-identical across turns (Prompt Cache!)
    async function* (opts) {
      assert.equal(
        opts.messages[0].content[0].text,
        scripted.calls[0].messages[0].content[0].text,
      );
      yield { type: 'text-delta', index: 0, text: '第二轮缓存命中测试通过。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  ]);

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: scripted,
    judgment: new JudgmentService({ provider: null }),
  });
  const token = 'upgrade-test-token-with-24-plus-chars-999';
  const app = api(store, token, { models: [], list: () => [] }, {
    pool,
    directAgent: direct,
  });

  try {
    const headers = { authorization: `Bearer ${token}` };
    const sess = (
      await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers,
        payload: { title: 'Wave Upgrade Test', permissionMode: 'auto-safe' },
      })
    ).json();
    direct.sessionToolConfigs.set(sess.id, { toolModes: { meta: true } });

    // Turn 1 with multimodal image attachment & effort: 'high'
    const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const t1Res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sess.id}/turns`,
      headers,
      payload: {
        input: '帮我更新 app.js 并新建 extra.js',
        effort: 'high',
        files: { 'screenshot.png': png1x1 },
      },
    });
    const t1Id = t1Res.json().turn.id;
    const t1 = await waitTurnDone(direct, sess.id, t1Id);
    assert.equal(t1.state, 'completed');

    // Verify files modified and plan persisted
    assert.equal(readFileSync(join(workDir, 'app.js'), 'utf8'), 'export const v = 2;\n');
    assert.equal(existsSync(join(workDir, 'extra.js')), true);
    const updatedSess = direct.getSession(sess.id);
    assert.equal(updatedSess.plan?.steps?.length, 2);

    // Verify FTS5 cross-session search finds Turn 1 keyword!
    const hits = store.searchDirectHistory('QUASAR_TOKEN_99');
    assert.ok(hits.length >= 1);

    // Turn 2: verifies static System Prompt byte-identity for Prompt Cache!
    const t2Res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sess.id}/turns`,
      headers,
      payload: { input: '继续测试缓存稳定性' },
    });
    const t2 = await waitTurnDone(direct, sess.id, t2Res.json().turn.id);
    assert.equal(t2.state, 'completed');

    // Deterministic `/rewind` of Turn 1 restores app.js back to v=1 AND deletes extra.js!
    const rewindRes = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sess.id}/rewind`,
      headers,
      payload: { turnId: t1Id, scope: 'both' },
    });
    assert.equal(rewindRes.statusCode, 200);
    assert.equal(readFileSync(join(workDir, 'app.js'), 'utf8'), 'export const v = 1;\n');
    assert.equal(existsSync(join(workDir, 'extra.js')), false);
    assert.equal(direct.listMessages(sess.id).length, 0);
  } finally {
    await direct.close();
    await app.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});

test('DirectAgent enforces stale-file guard, session command-prefix approval cache, mid-turn steering, and thrashing circuit breaker', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-guard-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-guard-work-'));
  writeFileSync(join(workDir, 'doc.txt'), 'original content\n', 'utf8');
  writeFileSync(join(workDir, 'cfg.ini'), '[demo]\na = 111\nb = 222\n', 'utf8');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const pool = new AccountPool(store, { root: dataDir });
  pool.setDefaultModel('mock-claude');

  let sawStaleError = false;
  let sawSteerMessage = false;
  let sawThrashWarning = false;

  const scripted = new ScriptedAdapter([
    // Step 1: read doc.txt, then externally mutate doc.txt and try edit_file + run bash (requires approval)
    async function* () {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-r1',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'doc.txt' }),
        },
      };
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'tc-b1',
          name: 'bash',
          arguments: JSON.stringify({ command: 'git config --file cfg.ini --get demo.a' }),
        },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Step 2: bash #1 succeeded via session-prefix approval; now simulate external edit to doc.txt & test stale guard + auto-approved bash #2 + duplicate failing calls
    async function* (opts) {
      const allText = opts.messages
        .map((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'))
        .join('\n');
      if (allText.includes('[用户实时纠偏指令]') && allText.includes('请改用方案B')) {
        sawSteerMessage = true;
      }
      // Externally modify doc.txt behind agent's back!
      writeFileSync(join(workDir, 'doc.txt'), 'externally changed by user\n', 'utf8');
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc-stale',
          name: 'edit_file',
          arguments: JSON.stringify({
            path: 'doc.txt',
            target: 'original content',
            replacement: 'clobbered',
          }),
        },
      };
      // Second `git config` should auto-pass via cached 'git config' session prefix with ZERO new approval!
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'tc-b2',
          name: 'bash',
          arguments: JSON.stringify({ command: 'git config --file cfg.ini --get demo.b' }),
        },
      };
      // Trigger pure byte-level exact duplicate reminder (6 consecutive identical calls, never aborts)
      for (let k = 0; k < 6; k++) {
        yield {
          type: 'block-end',
          index: 2 + k,
          block: {
            type: 'tool-call',
            id: `tc-bad-${k}`,
            name: 'nonexistent_tool',
            arguments: '{}',
          },
        };
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    },
    // Step 3: inspect tool outputs & finish
    async function* (opts) {
      const allText = opts.messages
        .map((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'))
        .join('\n');
      if (allText.includes('防脏写拦截')) sawStaleError = true;
      if (allText.includes('repeated 6 consecutive times')) sawThrashWarning = true;
      assert.ok(allText.includes('222'));
      yield { type: 'text-delta', index: 0, text: '所有安全与效率护栏均已验证。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  ]);

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workDir,
    dataRoot: dataDir,
    adapter: scripted,
    judgment: new JudgmentService({ provider: null }),
  });
  const token = 'guard-test-token-with-24-plus-chars-99999';
  const app = api(store, token, { models: [], list: () => [] }, {
    pool,
    directAgent: direct,
  });

  try {
    const headers = { authorization: `Bearer ${token}` };
    const sess = (
      await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers,
        payload: { title: 'Guards Test', permissionMode: 'auto-safe' },
      })
    ).json();

    const tRes = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sess.id}/turns`,
      headers,
      payload: { input: '执行护栏测试' },
    });
    const turnId = tRes.json().turn.id;

    // Wait for bash #1 approval request
    let pending = [];
    for (let i = 0; i < 600; i++) {
      const aRes = await app.inject({
        method: 'GET',
        url: `/v1/approvals?sessionId=${sess.id}&status=pending`,
        headers,
      });
      pending = aRes.json().items;
      if (pending.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(pending.length, 1);
    assert.equal(pending[0].tool, 'bash');

    // Queue a mid-turn steering message BEFORE approving bash #1!
    const steerRes = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sess.id}/steer`,
      headers,
      payload: { input: '请改用方案B' },
    });
    assert.equal(steerRes.statusCode, 200);
    assert.equal(steerRes.json().steered, true);

    // Approve with scope: 'session' so bash #2 ('node -e ...') runs automatically without prompting!
    await app.inject({
      method: 'POST',
      url: `/v1/approvals/${pending[0].id}/decision`,
      headers,
      payload: { decision: 'allow', scope: 'session' },
    });

    const done = await waitTurnDone(direct, sess.id, turnId, 60_000);
    assert.equal(done.state, 'completed');
    assert.equal(sawStaleError, true);
    assert.equal(sawSteerMessage, true);
    assert.equal(sawThrashWarning, true);
    // Verify doc.txt was NOT clobbered by stale edit
    assert.equal(readFileSync(join(workDir, 'doc.txt'), 'utf8'), 'externally changed by user\n');
  } finally {
    await direct.close();
    await app.close();
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
  }
});
