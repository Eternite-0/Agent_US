import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import esbuild from 'esbuild';

import { LiveBackendClient } from '../src/api/client.ts';
import { createThreadInteraction } from '../src/utils/threadInteraction.ts';

const require = createRequire(import.meta.url);

async function compileTsxModule(entryRelPath, { stubPortal = false } = {}) {
  globalThis.__agentUsTestGlobStub ??= () => ({});
  const outDir = await mkdtemp(join(tmpdir(), 'agent-us-wb30-'));
  const outfile = join(outDir, 'bundle.mjs');
  const entryPath = new URL(`../${entryRelPath}`, import.meta.url);
  const absEntry = decodeURIComponent(entryPath.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  await esbuild.build({
    entryPoints: [absEntry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    jsx: 'automatic',
    define: {
      'import.meta.glob': 'globalThis.__agentUsTestGlobStub',
    },
    external: stubPortal
      ? ['react', 'react-dom/server', 'react/jsx-runtime']
      : ['react', 'react-dom', 'react/jsx-runtime'],
    plugins: [
      {
        name: 'resolve-react-and-stub-css',
        setup(build) {
          build.onResolve({ filter: /^react$/ }, () => ({
            path: pathToFileURL(require.resolve('react')).href,
            external: true,
          }));
          build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({
            path: pathToFileURL(require.resolve('react/jsx-runtime')).href,
            external: true,
          }));
          if (stubPortal) {
            build.onResolve({ filter: /^react-dom$/ }, () => ({
              path: 'stub-react-dom',
              namespace: 'stub-react-dom',
            }));
            build.onLoad({ filter: /.*/, namespace: 'stub-react-dom' }, () => ({
              contents: 'export const createPortal = (children) => children;',
              loader: 'js',
            }));
          } else {
            build.onResolve({ filter: /^react-dom(?:\/.*)?$/ }, (args) => ({
              path: pathToFileURL(require.resolve(args.path)).href,
              external: true,
            }));
          }
          build.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'stub-css' }));
          build.onLoad({ filter: /.*/, namespace: 'stub-css' }, () => ({ contents: '', loader: 'js' }));
        },
      },
    ],
  });
  const mod = await import(pathToFileURL(outfile).href);
  return {
    mod,
    cleanup: () => rm(outDir, { recursive: true, force: true }),
  };
}

function makeMockResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('LiveBackendClient 3.0 routes (steer, rewind, redo, git changes/commit, onboarding & error swallowing)', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const reqUrl = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: reqUrl, method, body });

    if (reqUrl.endsWith('/v1/sessions/sess-1/steer') && method === 'POST') {
      return makeMockResponse(200, { steered: true, sessionId: 'sess-1', turnId: 'turn-2', queued: 1 });
    }
    if (reqUrl.endsWith('/v1/sessions/sess-1/rewind') && method === 'POST') {
      return makeMockResponse(200, {
        ok: true,
        sessionId: 'sess-1',
        turnId: 'turn-1',
        scope: 'both',
        restoredFiles: ['src/app.ts'],
        deletedFiles: ['src/extra.ts'],
        removedMessages: 2,
        redoId: 'redo-1',
        durationMs: 14,
      });
    }
    if (reqUrl.endsWith('/v1/sessions/sess-1/rewind/file') && method === 'POST') {
      return makeMockResponse(200, {
        ok: true,
        sessionId: 'sess-1',
        turnId: 'turn-1',
        path: 'src/app.ts',
        action: 'restored',
        redoId: 'redo-file-1',
      });
    }
    if (reqUrl.endsWith('/v1/sessions/sess-1/rewind/redo') && method === 'POST') {
      return makeMockResponse(200, {
        ok: true,
        sessionId: 'sess-1',
        restoredFiles: ['src/app.ts'],
        deletedFiles: [],
        removedMessages: 0,
        redoId: 'redo-1',
      });
    }
    if (reqUrl.includes('/v1/git/changes')) {
      return makeMockResponse(200, {
        available: true,
        branch: 'feat/3.0',
        ahead: 1,
        behind: 0,
        headSha: 'abc1234',
        clean: false,
        staged: [{ path: 'src/staged.ts', status: 'M' }],
        unstaged: [{ path: 'src/dirty.ts', status: 'M' }],
        untracked: [{ path: 'src/new.ts', status: '?' }],
        blockedSensitive: ['.env'],
      });
    }
    if (reqUrl.endsWith('/v1/git/stage') || reqUrl.endsWith('/v1/git/unstage')) {
      return makeMockResponse(200, {
        available: true,
        branch: 'feat/3.0',
        staged: [{ path: 'src/staged.ts', status: 'M' }],
        unstaged: [],
        untracked: [],
      });
    }
    if (reqUrl.endsWith('/v1/git/commit')) {
      return makeMockResponse(200, {
        ok: true,
        commitSha: 'deadbeefcafebabe',
        shortSha: 'deadbee',
        branch: 'feat/3.0',
        subject: 'feat: commit changes',
        filesCommitted: 1,
      });
    }
    if (reqUrl.includes('/v1/onboarding/detect-external')) {
      return makeMockResponse(200, {
        promptNeeded: true,
        counts: { rules: 1, commands: 1, skills: 1, agents: 0, mcp: 1, total: 4 },
        providers: ['~/.claude', '~/.codex'],
        items: [
          {
            id: 'claude:rule:root',
            provider: 'claude',
            scope: 'user',
            kind: 'rule',
            name: 'CLAUDE.md',
            displayPath: '~/.claude/CLAUDE.md',
            bytes: 512,
          },
        ],
      });
    }
    if (reqUrl.endsWith('/v1/onboarding/import-external')) {
      return makeMockResponse(200, {
        ok: true,
        action: 'import',
        importedCount: 1,
        promptNeeded: false,
        customizations: {
          commands: [{ name: 'deploy-check', command: '/deploy-check', description: '检查部署前置条件' }],
          agents: [],
          skills: [{ name: 'repo-audit', description: '仓库架构审查技能' }],
          rules: [],
          mcpServers: [],
        },
      });
    }
    if (reqUrl.includes('/v1/workspace/customizations')) {
      return makeMockResponse(200, {
        commands: [{ name: 'deploy-check', command: '/deploy-check', description: '检查部署前置条件' }],
        agents: [],
        skills: [{ name: 'repo-audit', description: '仓库架构审查技能' }],
        rules: [],
        mcpServers: [],
      });
    }
    return makeMockResponse(404, { error: { code: 'UNHANDLED_FIXTURE_ROUTE' } });
  };

  try {
    const client = new LiveBackendClient({ mode: 'live', baseUrl: 'http://127.0.0.1:8787', token: 'tok' });

    const steerRes = await client.steerSession('sess-1', '改用 Vitest 跑测', { files: { 'a.ts': 'YQ==' } });
    assert.equal(steerRes.steered, true);
    assert.equal(calls.at(-1).body.input, '改用 Vitest 跑测');
    assert.deepEqual(calls.at(-1).body.files, { 'a.ts': 'YQ==' });

    const rwRes = await client.rewindSession('sess-1', { scope: 'both', turnId: 'turn-1' });
    assert.equal(rwRes.redoId, 'redo-1');
    assert.deepEqual(rwRes.restoredFiles, ['src/app.ts']);
    assert.equal(rwRes.removedMessages, 2);

    const fileRw = await client.rewindSessionFile('sess-1', { path: 'src/app.ts', turnId: 'turn-1' });
    assert.equal(fileRw.action, 'restored');

    const redoRes = await client.redoSessionRewind('sess-1', { redoId: 'redo-1' });
    assert.equal(redoRes.ok, true);

    const changes = await client.getGitChanges('sess-1');
    assert.equal(changes.branch, 'feat/3.0');
    assert.deepEqual(changes.blockedSensitive, ['.env']);

    await client.stageGitFiles({ paths: ['src/dirty.ts'], sessionId: 'sess-1' });
    await client.unstageGitFiles({ all: true, sessionId: 'sess-1' });
    const commitRes = await client.commitGitChanges('feat: commit changes', { sessionId: 'sess-1' });
    assert.equal(commitRes.shortSha, 'deadbee');

    const detectRes = await client.detectExternalConfigs({ sessionId: 'sess-1', force: true });
    assert.equal(detectRes.promptNeeded, true);
    assert.ok(calls.some((c) => c.url.includes('/v1/onboarding/detect-external?sessionId=sess-1&force=1')));

    const importRes = await client.importExternalConfigs({
      sessionId: 'sess-1',
      action: 'import',
      itemIds: ['claude:rule:root'],
      targetScope: 'auto',
    });
    assert.equal(importRes.importedCount, 1);
    assert.equal(importRes.customizations.commands[0].command, '/deploy-check');

    const customRes = await client.getWorkspaceCustomizations({ sessionId: 'sess-1' });
    assert.equal(customRes.skills[0].name, 'repo-audit');

    // Passive 404/network error swallowing guarantees zero regressions in Playwright fixture suites
    globalThis.fetch = async () => makeMockResponse(404, { error: { code: 'UNHANDLED_FIXTURE_ROUTE' } });
    assert.equal((await client.detectExternalConfigs({ sessionId: 'sess-404' })).promptNeeded, false);
    assert.equal((await client.detectExternalConfigs({ sessionId: 'sess-404' })).items.length, 0);
    assert.equal((await client.getWorkspaceCustomizations({ sessionId: 'sess-404' })).commands.length, 0);
    assert.equal((await client.getGitChanges('sess-404')).available, false);
    assert.equal((await client.getSessionSnapshots('sess-404')).items.length, 0);

    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    assert.equal((await client.detectExternalConfigs()).promptNeeded, false);
    assert.equal((await client.getWorkspaceCustomizations()).skills.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('slashCommands dynamically injects imported commands and skills without built-in collisions', async () => {
  const scMod = await compileTsxModule('src/components/slashCommands.ts');
  try {
    const { buildDynamicCommandGroup, mergeSlashCommandGroups, findSlashCommand } = scMod.mod;

    assert.ok(findSlashCommand('/commit'));
    assert.equal(findSlashCommand('/commit').inspector, 'git');
    assert.ok(findSlashCommand('/import'));

    const customizations = {
      commands: [
        { name: 'deploy-check', command: '/deploy-check', description: '运行发布前巡检', argumentHint: '<env>' },
        { name: 'commit', command: '/commit', description: 'project commit override' },
        { name: 'disabled-cmd', command: '/disabled-cmd', disabled: true },
      ],
      agents: [],
      skills: [
        { name: 'perf-audit', description: '性能剖析技能', enabled: true },
        { name: 'off-skill', description: 'disabled', enabled: false },
      ],
      rules: [],
      mcpServers: [],
    };
    const customGroup = buildDynamicCommandGroup(customizations);

    assert.ok(customGroup);
    assert.equal(customGroup.label, '项目命令与技能');
    // disabled-cmd & off-skill are filtered out; built-in collision /commit is safely prefixed as /cmd:commit
    assert.equal(customGroup.commands.length, 3);
    assert.equal(customGroup.commands[0].cmd, '/deploy-check');
    assert.equal(customGroup.commands[0].customCommand, true);
    assert.equal(customGroup.commands[1].cmd, '/cmd:commit');
    assert.equal(customGroup.commands[2].cmd, '/perf-audit');
    assert.equal(customGroup.commands[2].submitText, '/perf-audit');

    const mergedGroups = mergeSlashCommandGroups(customizations);
    const dynamicAll = mergedGroups.flatMap((g) => g.commands);
    assert.equal(findSlashCommand('/deploy-check', dynamicAll)?.cmd, '/deploy-check');
    assert.equal(findSlashCommand('/commit', dynamicAll)?.inspector, 'git');
    assert.equal(findSlashCommand('/cmd:commit', dynamicAll)?.customCommand, true);
    assert.equal(findSlashCommand('/perf-audit', dynamicAll)?.submitText, '/perf-audit');
  } finally {
    await scMod.cleanup();
  }
});

test('groupDirectMessages converts turn/steer_injected and turn/route_failover into flat activity notices', async () => {
  const dmMod = await compileTsxModule('src/utils/directMessages.ts');
  try {
    const blocks = dmMod.mod.groupDirectMessages(
      's-1',
      '修复登录验证',
      [{ cursor: 1, turnId: 't-1', type: 'user/message', text: '修复登录验证' }, { cursor: 2, turnId: 't-1', type: 'assistant/message', text: '已完成修复与单测补充。' }],
      {
        events: [
          { seq: 1, timestamp: 1700000001000, type: 'turn/started', projectId: null, taskId: 's-1', payload: { turnId: 't-1', userInput: '修复登录验证' } },
          { seq: 2, timestamp: 1700000002000, type: 'turn/steer_injected', projectId: null, taskId: 's-1', payload: { turnId: 't-1', step: 2, count: 1, texts: ['顺便补一个单测'] } },
          { seq: 3, timestamp: 1700000003000, type: 'turn/route_failover', projectId: null, taskId: 's-1', payload: { turnId: 't-1', attempt: 1, statusCode: 429, fromAccountId: 'acc-1', toAccountId: 'acc-2', reason: 'rate_limited' } },
          { seq: 5, timestamp: 1700000005000, type: 'turn/completed', projectId: null, taskId: 's-1', payload: { turnId: 't-1', durationMs: 4000 } },
        ],
      },
    )[0].blocks;

    const activity = blocks.find((b) => b.kind === 'activity');
    assert.ok(activity);
    assert.equal(activity.items.length, 2);
    assert.equal(activity.items[0].kind, 'notice');
    assert.equal(activity.items[0].tone, 'steer');
    assert.match(activity.items[0].title, /插话引导/);
    assert.match(activity.items[0].detail, /顺便补一个单测/);

    assert.equal(activity.items[1].kind, 'notice');
    assert.equal(activity.items[1].tone, 'failover');
    assert.match(activity.items[1].title, /路由故障转移/);
    assert.match(activity.items[1].title, /429/);
    assert.match(activity.items[1].title, /acc-1 → acc-2/);
  } finally {
    await dmMod.cleanup();
  }
});

test('UI components render 3.0 Rewind/Redo, Live Steer, GitWorkbench, ExternalImportModal & SettingsView cleanly', async () => {
  const [fcMod, tvMod, gwMod, idMod, eimMod, svMod] = await Promise.all([
    compileTsxModule('src/components/FileChangeCard.tsx'),
    compileTsxModule('src/components/ThreadView.tsx'),
    compileTsxModule('src/components/GitWorkbench.tsx'),
    compileTsxModule('src/components/InspectorDrawer.tsx'),
    compileTsxModule('src/components/ExternalImportModal.tsx', { stubPortal: true }),
    compileTsxModule('src/components/SettingsView.tsx'),
  ]);

  const origDoc = globalThis.document;
  try {
    // 1. FileChangeCard renders rewind action cleanly
    const fcHtml = renderToStaticMarkup(
      React.createElement(fcMod.mod.FileChangeCard, {
        files: [
          {
            path: 'src/index.ts',
            added: 4,
            deleted: 1,
            isNew: false,
            isDeleted: false,
            beforeText: 'const x = 1;',
            afterText: 'const x = 2;',
            lines: [{ kind: 'add', oldLine: null, newLine: 1, text: 'const x = 2;' }],
          },
        ],
        onInspectFile: () => {},
        onRewind: async () => {},
      }),
    );
    assert.match(fcHtml, /撤销/);
    assert.doesNotMatch(fcHtml, /已验证|已通过验证/);

    // 2. ThreadView renders running Steer+Stop Composer controls, activity notices, and post-rewind Redo bar
    const runningBundle = {
      task: {
        id: 'sess-run-30',
        projectId: null,
        input: '实现登录校验并运行单测',
        status: 'running',
        mode: 'direct',
        permissionMode: 'auto-safe',
        createdAt: 1700000000000,
        updatedAt: 1700000004000,
        files: {},
      },
      assignments: [],
      workers: [],
      sessions: [
        {
          id: 'sess-run-30',
          taskId: 'sess-run-30',
          assignmentId: 'direct',
          role: 'assistant',
          status: 'running',
          model: 'gpt-5',
          createdAt: 1700000000000,
          updatedAt: 1700000004000,
        },
      ],
      histories: {
        'sess-run-30': [
          { cursor: 1, turnId: 't-1', type: 'user/message', text: '实现登录校验并运行单测' },
        ],
      },
      approvals: [],
      evidence: [],
      artifacts: [],
      usage: [],
      messages: [],
      events: [
        { seq: 1, timestamp: 1700000001000, type: 'turn/started', projectId: null, taskId: 'sess-run-30', payload: { turnId: 't-1', userInput: '实现登录校验并运行单测' } },
        { seq: 2, timestamp: 1700000002000, type: 'turn/steer_injected', projectId: null, taskId: 'sess-run-30', payload: { turnId: 't-1', step: 1, count: 1, texts: ['保留旧 token 兼容'] } },
        { seq: 3, timestamp: 1700000003000, type: 'turn/route_failover', projectId: null, taskId: 'sess-run-30', payload: { turnId: 't-1', attempt: 1, statusCode: 503, fromAccountId: 'a1', toAccountId: 'a2' } },
      ],
    };

    const tvHtml = renderToStaticMarkup(
      React.createElement(tvMod.mod.ThreadView, {
        interaction: createThreadInteraction(),
        bundles: [runningBundle],
        loading: false,
        codexMode: 'Codex',
        projects: [],
        selectedProject: null,
        models: [],
        selectedModel: 'gpt-5',
        effort: 'medium',
        permissionMode: 'auto-safe',
        mentionFiles: [],
        submitting: false,
        inspectorOpen: false,
        inspectorTab: 'subagents',
        decidingApprovalId: null,
        routerReady: true,
        isLiveBackend: true,
        rewindNotice: {
          sessionId: 'sess-run-30',
          scope: 'both',
          restoredCount: 2,
          deletedCount: 1,
          removedMessages: 2,
          redoId: 'redo-99',
        },
        onRedoRewind: async () => {},
        onRewindSession: async () => {},
        onSteerSession: async () => true,
        onSelectProject: () => {},
        onOpenCreateProject: () => {},
        onSelectModel: () => {},
        onChangeEffort: () => {},
        onChangePermission: () => {},
        onSlashCommand: () => {},
        onSubmitGoal: async () => true,
        onSubmitFollowup: async () => true,
        onControlTask: async () => {},
        archiving: false,
        onToggleArchive: () => {},
        onDecideApproval: async () => {},
        onOpenInspector: () => {},
        onOpenSubagent: () => {},
        onToggleInspector: () => {},
        onClearFocusWorker: () => {},
        onFocusWorker: () => {},
        onOpenSettings: () => {},
        onToast: () => {},
      }),
    );

    assert.match(tvHtml, /codex-steer-btn/);
    assert.match(tvHtml, /插话引导/);
    assert.match(tvHtml, /停止/);
    assert.match(tvHtml, /codex-rewind-bar/);
    assert.match(tvHtml, /重做撤销 \(Redo\)/);
    assert.match(tvHtml, /已还原 2 个文件/);
    assert.match(tvHtml, /codex-direct-notice-row/);
    assert.match(tvHtml, /保留旧 token 兼容/);
    assert.match(tvHtml, /路由故障转移 \(503\)/);
    assert.doesNotMatch(tvHtml, /<details[^>]*class="[^"]*codex-direct-tool/);

    // 3. GitWorkbench renders staged, unstaged/untracked, blockedSensitive warning, and commit button
    const gwHtml = renderToStaticMarkup(
      React.createElement(gwMod.mod.GitWorkbench, {
        client: {
          getGitChanges: async () => ({ available: true, branch: 'main', staged: [], unstaged: [], untracked: [] }),
          stageGitFiles: async () => ({ available: true, branch: 'main', staged: [], unstaged: [], untracked: [] }),
          unstageGitFiles: async () => ({ available: true, branch: 'main', staged: [], unstaged: [], untracked: [] }),
          commitGitChanges: async () => ({ ok: true, commitSha: 'abc', shortSha: 'abc', branch: 'main', subject: 'init' }),
        },
        sessionId: 'sess-1',
        initialChanges: {
          available: true,
          branch: 'feat/3.0-wb',
          headSha: '5df4783',
          staged: [{ path: 'frontend/src/App.tsx', status: 'M' }],
          unstaged: [{ path: 'frontend/src/styles/codex.css', status: 'M' }],
          untracked: [{ path: 'frontend/src/components/GitWorkbench.tsx', status: '?' }],
          blockedSensitive: ['.env', 'backend/var/.pool-key'],
        },
        onToast: () => {},
      }),
    );
    assert.match(gwHtml, /Git 暂存与提交工作台/);
    assert.match(gwHtml, /feat\/3\.0-wb/);
    assert.match(gwHtml, /安全守卫已拦截敏感文件/);
    assert.match(gwHtml, /\.env, backend\/var\/\.pool-key/);
    assert.match(gwHtml, /全部取消暂存/);
    assert.match(gwHtml, /全部暂存/);
    assert.match(gwHtml, /frontend\/src\/App\.tsx/);
    assert.match(gwHtml, /frontend\/src\/components\/GitWorkbench\.tsx/);

    // 4. InspectorDrawer renders "还原此文件" in diff view and renders GitWorkbench when tab='git' with null bundle
    const diffInspectorHtml = renderToStaticMarkup(
      React.createElement(idMod.mod.InspectorDrawer, {
        open: true,
        width: 560,
        tab: 'diff',
        selectedFile: 'src/app.ts',
        selectedSubagentId: null,
        projectName: 'Agent_US',
        bundle: {
          ...runningBundle,
          task: { ...runningBundle.task, status: 'completed', files: {} },
          evidence: [
            {
              id: 'ev-1',
              version: 1,
              projectId: 'workspace',
              taskId: 'sess-run-30',
              status: 'finished',
              tool: 'apply_patch',
              workerId: 'sess-run-30',
              assignmentId: 'direct',
              digest: '1',
              changes: [
                {
                  path: 'src/app.ts',
                  before: Buffer.from('export const v = 1;\n', 'utf8').toString('base64'),
                  after: Buffer.from('export const v = 2;\n', 'utf8').toString('base64'),
                },
              ],
            },
          ],
        },
        client: {},
        sessionId: 'sess-run-30',
        onRewindFile: async () => {},
        onResize: () => {},
        onChangeTab: () => {},
        onSelectFile: () => {},
        onSelectSubagent: () => {},
        onClose: () => {},
        onToast: () => {},
      }),
    );
    assert.match(diffInspectorHtml, /还原此文件/);
    assert.doesNotMatch(diffInspectorHtml, />Git 提交</);

    const gitInspectorHtml = renderToStaticMarkup(
      React.createElement(idMod.mod.InspectorDrawer, {
        open: true,
        width: 560,
        tab: 'git',
        selectedFile: null,
        selectedSubagentId: null,
        projectName: 'Agent_US',
        bundle: null,
        client: {},
        sessionId: null,
        initialGitChanges: {
          available: true,
          branch: 'main',
          staged: [],
          unstaged: [{ path: 'README.md', status: 'M' }],
          untracked: [],
        },
        onResize: () => {},
        onChangeTab: () => {},
        onSelectFile: () => {},
        onSelectSubagent: () => {},
        onClose: () => {},
        onToast: () => {},
      }),
    );
    assert.match(gitInspectorHtml, /Git 暂存与提交工作台/);
    assert.match(gitInspectorHtml, /README\.md/);

    // 5. ExternalImportModal renders checkboxes for ~/.claude & ~/.codex, MCP note, skip and one-click import
    globalThis.document = { body: {} };
    const importHtml = renderToStaticMarkup(
      React.createElement(eimMod.mod.ExternalImportModal, {
        open: true,
        loading: false,
        busy: false,
        result: {
          promptNeeded: true,
          counts: { rules: 1, commands: 1, skills: 1, agents: 0, mcp: 1, total: 4 },
          providers: ['claude', 'codex'],
          items: [
            { id: 'c1', provider: 'claude', scope: 'user', kind: 'rule', name: 'CLAUDE.md', displayPath: '~/.claude/CLAUDE.md', bytes: 1200 },
            { id: 'c2', provider: 'codex', scope: 'user', kind: 'skill', name: 'audit-skill', displayPath: '~/.codex/skills/audit/SKILL.md', bytes: 800 },
            { id: 'c3', provider: 'claude', scope: 'workspace', kind: 'mcp', name: 'github-mcp', displayPath: '.claude/mcp.json' },
          ],
        },
        onClose: () => {},
        onRefresh: () => {},
        onImport: async () => {},
        onSkip: async () => {},
      }),
    );
    assert.match(importHtml, /导入外部配置/);
    assert.match(importHtml, /~\/\.claude/);
    assert.match(importHtml, /~\/\.codex/);
    assert.match(importHtml, /untrusted/);
    assert.match(importHtml, /暂不导入 \/ 跳过/);
    assert.match(importHtml, /一键导入 \(3\)/);

    // 6. SettingsView renders "外部配置导入" button in general section
    const settingsHtml = renderToStaticMarkup(
      React.createElement(svMod.mod.SettingsView, {
        client: {},
        section: 'general',
        themeMode: 'light',
        preset: 'codex',
        fontSize: 'default',
        reducedMotion: false,
        permissionMode: 'auto-safe',
        connection: { mode: 'live', baseUrl: 'http://127.0.0.1:8787', token: '' },
        backendHealthy: true,
        models: [],
        providersHealth: null,
        providerPresets: null,
        providerAccounts: [],
        providerAccountsLoading: false,
        onRefreshProviderAccounts: async () => {},
        onCreateProviderAccount: async () => {},
        onUpdateProviderAccount: async () => {},
        onDeleteProviderAccount: async () => {},
        onTestProviderAccount: async () => {},
        onSyncProviderAccount: async () => {},
        onImportLocalProviderAccounts: async () => {},
        onModelsChanged: async () => {},
        approvals: [],
        memory: [],
        usage: [],
        recentEvents: [],
        onChangeSection: () => {},
        onChangeThemeMode: () => {},
        onChangePreset: () => {},
        onChangeFontSize: () => {},
        onChangeReducedMotion: () => {},
        onChangePermissionMode: () => {},
        onUpdateConnection: () => {},
        onTestConnection: async () => {},
        onDecideApproval: async () => {},
        onOpenTask: () => {},
        onOpenExternalImport: () => {},
        customizations: { commands: [{ name: 'check' }], agents: [], skills: [{ name: 'sk' }], rules: [], mcpServers: [] },
        onToast: () => {},
      }),
    );
    assert.match(settingsHtml, /外部配置导入/);
    assert.match(settingsHtml, /当前已激活 1 个命令、1 项技能、0 条规则/);
  } finally {
    globalThis.document = origDoc;
    await Promise.all([
      fcMod.cleanup(),
      tvMod.cleanup(),
      gwMod.cleanup(),
      idMod.cleanup(),
      eimMod.cleanup(),
      svMod.cleanup(),
    ]);
  }
});
