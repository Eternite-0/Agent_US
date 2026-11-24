import { expect, test } from '@playwright/test';
import { composer, screenshot, transcript } from '../e2e/thread.mjs';
import { join } from 'node:path';
import { FIXED_TIME } from '../e2e/sse-server.mjs';

const markdown = [
  '# Workspace audit', '',
  'The migration maintains **backwards compatibility** and saves the result in `src/config.ts`.', '',
  '> Keep the default small, and only increase it after measurement.', '',
  '| Check | Result |', '| --- | --- |', '| TypeScript | Passed |', '| Browser | Verified |', '',
  '```typescript', 'export const version = 2;', '```', '',
  '![Sample output chart](/visual-thread-image.svg)', '',
  'Review the patch in the workspace before delivery.',
].join('\n').replace('/visual-thread-image.svg', `http://127.0.0.1:${process.env.E2E_VISUAL_PORT ?? '4183'}/visual-thread-image.svg`);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="340" height="104"><rect width="340" height="104" fill="#eaf1fa"/><path d="M20 81h300M35 63l62 3 64-21 72 3 66-28" fill="none" stroke="#2874bb" stroke-width="3"/></svg>';
const verdict = { verdict: 'pass', accepted: true, verificationMode: 'independent', evidenceCount: 2, reasons: ['Release checks passed.'], reviewerVerdicts: [
  { nodeKey: 'patch-review', nodeStatus: 'completed', status: 'accepted', summary: 'Patch and test output agree.', reviewerModel: 'fixture-reviewer', evidenceRefs: ['npm-check'], findings: [] },
] };
const swarm = { id: 'review-run', sessionId: 'swarm-visual', goal: 'Review release readiness', status: 'completed', currentPhase: 'delivery',
  usage: { completedNodes: 2, steps: 6, totalTokens: 2048 }, verdict, createdAt: FIXED_TIME, updatedAt: FIXED_TIME + 5_000,
  nodes: [
    { id: 'analyze-node', nodeKey: 'analyze', agentProfileId: 'researcher', status: 'completed', objective: 'Read configuration', dependencies: [], attempts: 1 },
    { id: 'review-node', nodeKey: 'patch-review', agentProfileId: 'reviewer', status: 'completed', objective: 'Verify the patch', dependencies: ['analyze'], attempts: 1 },
  ] };
const toolWork = [
  ['read_file', { path: 'src/auth/session.ts' }, 'export function refreshSession() { /* … */ }'],
  ['grep', { pattern: 'refreshToken', path: 'src/auth' }, 'src/auth/session.ts:24: refreshToken'],
  ['bash', { command: 'git status --short' }, ' M src/auth/session.ts\n M test/auth-session.test.ts'],
  ['apply_patch', { path: 'src/auth/session.ts' }, 'Updated src/auth/session.ts'],
  ['bash', { command: 'npm run test:auth' }, Array.from({ length: 32 }, (_, i) => `✓ auth/session.test.ts · scenario ${String(i + 1).padStart(2, '0')}: session lifecycle verified`).join('\n')],
];
const cache = { promptCache: { windowHours: 24, global: {
  status: 'available', hitRate: 0.75, coverage: 1, requests: 8, measuredRequests: 8,
  missingRequests: 0, unsupportedRequests: 0, cacheReadTokens: 12_000,
  cacheWriteTokens: 2_000, uncachedInputTokens: 4_000, cacheEligibleInputTokens: 16_000,
} } };
const sessions = {
  'direct-visual': { title: 'Session refresh', prompt: 'Check how the app handles an expired session and run the auth tests.', state: 'completed' },
  'unverified-visual': { title: 'Unverified result', prompt: 'Verify the workspace changes.', state: 'completed' },
  'tools-visual': { title: 'Auth workspace changes', prompt: 'Trace the expired-session path, make the smallest fix, and run the focused tests.', state: 'completed' },
  'markdown-visual': { title: 'Workspace audit', prompt: 'Review the configuration, include the diff and notes', state: 'completed' },
  'approval-visual': { title: 'Pending verification approval', prompt: 'Verify the migration using the test runner', state: 'running' },
  'swarm-visual': { title: 'Release readiness', prompt: '/swarm Review release readiness', state: 'completed' },
};

async function attachVisualFixtures(page) {
  await page.route('**/visual-thread-image.svg', (route) => route.fulfill({ contentType: 'image/svg+xml', body: svg }));
  await page.route('**/v1/**', async (route) => {
    const { pathname: path, searchParams: query } = new URL(route.request().url());
    const [, id, kind] = path.match(/^\/v1\/sessions\/([\w-]+)(?:\/([\w-]+))?$/) ?? [];
    const data = sessions[id];
    let value;
    if (data) {
      const turnId = `${id}-turn`;
      if (!kind) value = { id, title: data.title, state: data.state, createdAt: FIXED_TIME, updatedAt: FIXED_TIME + 2000, model: 'fixture-model' };
      if (kind === 'turns') value = { items: [{ id: turnId, input: data.prompt, state: data.state, createdAt: FIXED_TIME, durationMs: 1900,
        ...(id === 'tools-visual' ? { verdict: { accepted: true, reasons: ['Checks passed.'] }, evidenceCount: 2 } : {}),
        ...(id === 'unverified-visual' ? { verdict: { accepted: false, reasons: ['Some checks failed.'] } } : {}),
      }] };
      if (kind === 'messages') {
        const command = id === 'swarm-visual';
        const rows = [{ seq: 1, ...(command ? { meta: { swarmAction: 'start', runId: swarm.id } } : { turnId }), role: 'user', content: data.prompt }];
        if (id === 'direct-visual' || id === 'tools-visual') {
          let seq = 1;
          if (id === 'tools-visual') for (const [index, [name, args, output]] of toolWork.entries()) {
            const callId = `visual-call-${index}`;
            rows.push({ seq: ++seq, turnId, role: 'assistant', content: '', toolCalls: [{ id: callId, name, arguments: args }] });
            rows.push({ seq: ++seq, turnId, role: 'tool', content: output, toolCallId: callId, toolName: name });
          }
          rows.push({ seq: ++seq, turnId, role: 'assistant', content: 'The app now refreshes the session before retrying a request. If refresh fails, it returns to sign-in without leaving a stale token behind.\n\nThe focused authentication suite passed.' });
        }
        if (id === 'unverified-visual') rows.push({ seq: 2, turnId, role: 'assistant', content: 'Some changes require another review.' });
        if (id === 'markdown-visual') rows.push({ seq: 2, turnId, role: 'assistant', content: markdown });
        value = { items: rows };
      }
      if (kind === 'events') {
        const event = (seq, type, data) => ({ seq, type, at: FIXED_TIME + seq * 100, sessionId: id, data: { turnId, ...data } });
        const items = [event(1, 'turn/started', {})];
        if (id === 'markdown-visual') items.push(
          event(2, 'file/changed', { path: 'src/config.ts', before: 'export const version = 1;\n', after: 'export const version = 2;\nexport const mode = "stable";\n' }),
          event(3, 'tool/result', { name: 'edit_file', callId: 'config-patch', output: 'Edited src/config.ts' }),
        );
        if (data.state === 'completed') items.push(event(4, 'turn/completed', { durationMs: 1900 }));
        value = { items };
      }
      if (kind === 'receipts') value = { items: [] };
    }
    if (path === '/v1/git/status') value = { available: true, branch: 'main', dirty: false, branches: ['main', 'release'] };
    if (path === '/v1/observability/metrics' && query.get('view') === 'prompt-cache') value = cache;
    if (path === '/v1/approvals' && query.get('sessionId') === 'approval-visual') value = { items: [{
      id: 'visual-approval', sessionId: 'approval-visual', turnId: 'approval-visual-turn', callId: 'visual-test',
      status: 'pending', tool: 'bash', arguments: { command: 'npm run test -- --runInBand' }, expiresAt: FIXED_TIME + 120_000,
    }] };
    if (path === '/v1/swarm/runs' && query.get('sessionId') === swarm.sessionId) value = { items: [swarm] };
    if (path === `/v1/swarm/runs/${swarm.id}`) value = swarm;
    if (path === `/v1/swarm/runs/${swarm.id}/delivery`) value = { runId: swarm.id, status: swarm.status, goal: swarm.goal, verdict, reviewerVerdicts: verdict.reviewerVerdicts };
    if (path.startsWith(`/v1/swarm/runs/${swarm.id}/`) && !value) value = { items: [] };
    return value ? route.fulfill({ json: value }) : route.fallback();
  });
}

const navigate = (page, hash) => page.evaluate(h => { location.hash = h; }, hash);

test.beforeEach(async ({ page, request }) => {
  await page.clock.setFixedTime(new Date(FIXED_TIME + 25_000));
  expect((await request.post('/__e2e/reset')).ok()).toBe(true);
  await attachVisualFixtures(page);
});

async function capture(page, info, name) {
  const theme = await page.locator('html').getAttribute('data-theme') ?? 'light';
  // Remove incidental hover from an interaction before recording the surface.
  await page.mouse.move(0, 0);
  await screenshot(page, join(info.project.name, `${name}-${theme}`));
}

async function toggleTheme(page, theme) {
  const html = page.locator('html');
  if (await html.getAttribute('data-theme') !== theme) await page.keyboard.press('Control+Shift+L');
  await expect(html).toHaveAttribute('data-theme', theme);
}

async function openActivity(page) {
  const view = transcript(page);
  const activityStatus = view.locator('.codex-direct-status button');
  if (await activityStatus.getAttribute('aria-expanded') === 'false') await activityStatus.click();
  const groups = await view.locator('details.codex-direct-activity').all();
  for (const group of groups) if (await group.getAttribute('open') === null) await group.locator(':scope > summary').click();
  await expect(view.locator('details.codex-direct-tool > summary').filter({ visible: true })).toHaveCount(5);
  await page.mouse.move(0, 0);
  if (!process.env.E2E_FRONTEND_DIR) await expectFlatSurface(view.locator('details.codex-direct-tool > summary').first(), 0);
}

async function expectFlatSurface(node, maxRadius) {
  await expect(node).toHaveCSS('box-shadow', 'none');
  await expect(node).toHaveCSS('border-inline-start-width', '0px');
  expect(await node.evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeLessThanOrEqual(maxRadius);
}

test('Direct prose and five operations with short and long terminal output', async ({ page }, info) => {
  await page.goto('/#/t/direct-visual');
  for (const theme of ['light', 'dark']) {
    await toggleTheme(page, theme);
    await navigate(page, '/t/direct-visual');
    await expect(transcript(page).getByText('The focused authentication suite passed.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Prompt Cache：缓存命中 75%/ })).toBeVisible();
    await capture(page, info, 'direct');
    await navigate(page, '/t/tools-visual');
    await openActivity(page);
    if (!process.env.E2E_FRONTEND_DIR) await expect(transcript(page).getByText(/^(已验证|已通过验证)/)).toHaveCount(0);
    await capture(page, info, 'five-operations');
    const short = page.locator('details.codex-direct-tool').filter({ hasText: 'git status --short' });
    await short.locator(':scope > summary').click();
    await expect(short.locator('pre')).toBeVisible();
    if (!process.env.E2E_FRONTEND_DIR) {
      await expectFlatSurface(short.locator('.codex-terminal-inset'), 6);
      const composer = page.locator('.codex-composer-card');
      await expect(composer).toHaveCSS('box-shadow', 'none');
      await expect(composer).toHaveCSS('border-top-left-radius', '10px');
      await expect(short.getByRole('button', { name: '复制命令' })).toBeVisible();
      await expect(short.getByRole('button', { name: '复制输出' })).toBeVisible();
      await expect(short.getByText('工具输出', { exact: true })).toHaveCount(0);
      const view = await transcript(page).boundingBox();
      expect(view.y + view.height).toBeLessThanOrEqual((await composer.boundingBox()).y);
    }
    await capture(page, info, 'terminal');
    await short.locator(':scope > summary').click();
    const long = page.locator('details.codex-direct-tool').filter({ hasText: 'npm run test:auth' });
    await long.locator(':scope > summary').click();
    const output = long.locator('pre');
    await expect(output).toBeVisible();
    expect(await output.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(200);
    await output.scrollIntoViewIfNeeded();
    await capture(page, info, 'terminal-long');
    // The same conversation preserves disclosures across theme/navigation changes.
    await long.locator(':scope > summary').click();
    await expect(output).toBeHidden();
  }
});

test('home keeps a single sidebar without evaluations and preserves composer controls', async ({ page }, info) => {
  test.skip(Boolean(process.env.E2E_FRONTEND_DIR), 'Native home controls');
  const sessionsPosted = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/sessions') sessionsPosted.push(request.url());
  });
  await page.goto('/');
  const sidebar = page.getByRole('complementary', { name: '对话历史' });
  const rail = page.locator('.codex-rail');
  const evaluationEntry = /能力评测|评测中心|evaluation/i;
  if (info.project.use.viewport.width <= 820) {
    await expect(rail).toBeVisible();
    await page.getByRole('button', { name: '显示侧边栏', exact: true }).click();
  }
  await expect(rail).toHaveCount(0);
  // The default light sidebar and its title-bar segment use the original neutral chrome.
  const neutralChrome = 'rgb(241, 242, 243)';
  await expect(page.locator('.codex-shell')).toHaveCSS('background-color', neutralChrome);
  await expect.poll(() => page.locator('.codex-topbar').evaluate(el => getComputedStyle(el, '::before').backgroundColor)).toBe(neutralChrome);
  await expect(sidebar.getByRole('button', { name: '已归档', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: '插件', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: evaluationEntry })).toHaveCount(0);
  await page.getByRole('button', { name: '隐藏侧边栏', exact: true }).click();
  await expect(rail).toBeVisible();
  await expect(rail.getByRole('button', { name: evaluationEntry })).toHaveCount(0);
  if (info.project.use.viewport.width > 820) {
    await page.getByRole('button', { name: '显示侧边栏', exact: true }).click();
  }

  const home = page.locator('.codex-home');
  const tray = home.locator('.codex-composer-tray');
  await expect(home.getByRole('heading', { level: 1 })).toContainText('workspace');
  const starters = home.getByRole('group', { name: '开始开发' }).getByRole('button');
  await expect(starters).toHaveCount(4);
  await starters.getByText('探索并理解代码', { exact: true }).click();
  await expect(composer(page)).toHaveValue(/代码结构/);
  await expect(composer(page)).toBeFocused();
  const firstPrompt = await composer(page).inputValue();
  await home.locator('input[type="file"]').setInputFiles({
    name: 'starter-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep my notes'),
  });
  const attachment = home.getByText('starter-notes.txt', { exact: true });
  await expect(attachment).toBeVisible();
  for (const [label, beginning] of [
    ['构建新功能、应用或工具', /^我想在这个项目中构建一个新功能。/],
    ['审查代码并提出修改建议', /^请审查当前代码，/],
    ['修复问题和失败', /^请帮我定位并修复下面的问题。/],
  ]) {
    const previous = await composer(page).inputValue();
    await starters.getByText(label, { exact: true }).click();
    await expect(composer(page)).toHaveValue(beginning);
    expect(await composer(page).inputValue()).not.toContain(previous);
    await expect(attachment).toBeVisible();
  }
  await starters.getByText('探索并理解代码', { exact: true }).click();
  await expect(composer(page)).toHaveValue(firstPrompt);
  await starters.getByText('探索并理解代码', { exact: true }).click();
  await expect(composer(page)).toHaveValue(firstPrompt);
  await home.getByRole('button', { name: '移除 starter-notes.txt' }).click();
  expect(sessionsPosted).toEqual([]);
  await navigate(page, '/tasks');
  await expect(home).toHaveCount(0);
  await navigate(page, '/');
  await expect(composer(page)).toHaveValue('');

  await tray.getByRole('button', { name: /workspace/ }).click();
  await expect(tray.getByPlaceholder('搜索项目')).toBeInViewport();
  await page.keyboard.press('Escape');
  await tray.getByRole('button', { name: '本地', exact: true }).click();
  await expect(tray.getByText('Worker 隔离容器', { exact: true })).toBeInViewport();
  await page.keyboard.press('Escape');
  await tray.getByRole('button', { name: /当前 Git 分支：main/ }).click();
  await expect(tray.getByRole('dialog', { name: '切换或创建 Git 分支' })).toBeInViewport();
  await page.keyboard.press('Escape');

  const model = home.getByRole('button', { name: '模型与推理强度' });
  await expect(model).toContainText('fixture-model');
  await expect(model.locator('svg')).toHaveCount(0);
  await model.press('Enter');
  const slider = home.getByRole('slider', { name: '推理强度' });
  await slider.press('ArrowLeft');
  await expect(slider).toHaveAttribute('aria-valuenow', '2');
  await home.locator('.codex-effort-model-btn').click();
  const option = home.getByRole('button', { name: /^fixture-model/ });
  await option.click();
  await slider.press('Escape');
  await expect(model).toHaveAttribute('aria-expanded', 'false');
  await expect(model).toBeFocused();
  await expect(home.getByRole('button', { name: /Prompt Cache：缓存命中 75%/ })).toBeInViewport();
  await expect(home.locator('.codex-composer-card')).toBeInViewport({ ratio: 1 });
  expect(await home.evaluate(el => el.scrollWidth)).toBe(await home.evaluate(el => el.clientWidth));
});

test('home and Markdown hierarchy in light and dark themes; file diff in Inspector', async ({ page }, info) => {
  await page.goto('/');
  for (const theme of ['light', 'dark']) {
    await toggleTheme(page, theme);
    await expect(page.locator('.codex-home .codex-composer-card')).toBeVisible();
    await expect(page.getByRole('button', { name: /当前 Git 分支：main/ })).toBeVisible();
    await capture(page, info, 'home');
    await navigate(page, '/t/markdown-visual');
    await expect(transcript(page).getByRole('heading', { name: 'Workspace audit' })).toBeVisible();
    await expect(transcript(page).getByRole('table')).toBeVisible();
    await expect(transcript(page).getByRole('img', { name: 'Sample output chart' })).toBeVisible();
    await capture(page, info, 'markdown');
    const files = transcript(page).locator('.codex-file-card');
    if (!process.env.E2E_FRONTEND_DIR) {
      await expectFlatSurface(files, 0);
      await expect(transcript(page).locator('.codex-code-pre')).toBeVisible();
      expect((await files.boundingBox()).y).toBeGreaterThan((await transcript(page).getByText('Review the patch in the workspace before delivery.').boundingBox()).y);
    }
    await files.locator('.codex-file-row-trigger').click();
    await expect(files.locator('.codex-inline-diff-body')).toBeVisible();
    if (!process.env.E2E_FRONTEND_DIR) {
      await expect(files.locator('.codex-diff-changed[data-change="del"]')).toHaveText('1');
      await expect(files.locator('.codex-diff-changed[data-change="add"]')).toHaveText('2');
    }
    await capture(page, info, 'file-inline-diff');
    await files.getByRole('button', { name: '在右侧分屏打开 src/config.ts', exact: true }).click();
    await expect(page.locator('.codex-drawer[data-open="true"]')).toBeVisible();
    if (!process.env.E2E_FRONTEND_DIR) {
      const editor = page.locator('.codex-ide-editor');
      await expect(editor.getByText('export const version = 2;', { exact: true })).toBeVisible();
      const tree = page.locator('.codex-ide-tree');
      await expect(tree.getByRole('textbox', { name: '筛选文件…' })).toBeVisible();
      expect((await editor.boundingBox()).width).toBeGreaterThan((await tree.boundingBox()).width * 1.5);
    }
    await capture(page, info, 'file-diff');
    if (!process.env.E2E_FRONTEND_DIR) {
      const drawer = page.locator('.codex-drawer[data-open="true"]');
      await expect(drawer.getByRole('button', { name: '查看源码', exact: true })).toBeVisible();
      const editor = drawer.getByRole('region', { name: '文件差异' });
      for (const mode of ['双栏', '单栏']) {
        await expect(editor.locator('.codex-diff-changed[data-change="del"]')).toHaveText('1');
        await expect(editor.locator('.codex-diff-changed[data-change="add"]')).toHaveText('2');
        await drawer.getByRole('button', { name: mode, exact: true }).click();
      }
      await drawer.getByRole('button', { name: '查看源码', exact: true }).click();
    }
    await page.getByRole('button', { name: '关闭右侧面板', exact: true }).click();
    await navigate(page, '/');
  }
});

test('approval and Swarm execution with Reviewer evidence', async ({ page }, info) => {
  await page.goto('/#/t/approval-visual');
  for (const theme of ['light', 'dark']) {
    await toggleTheme(page, theme);
    await navigate(page, '/t/approval-visual');
    await expect(transcript(page).locator('.codex-approval-card')).toBeVisible();
    await capture(page, info, 'pending-approval');
    if (!process.env.E2E_FRONTEND_DIR) {
      await navigate(page, '/t/unverified-visual');
      await expect(transcript(page).getByText('验证未通过', { exact: true })).toBeVisible();
    }
    await navigate(page, '/t/swarm-visual');
    const card = page.locator('.swarm-thread-card');
    await expect(card).toBeVisible();
    if (!process.env.E2E_FRONTEND_DIR) {
      await expectFlatSurface(card, 0);
      await expect(card).toContainText('2/2 个节点完成');
      expect((await card.boundingBox()).height).toBeLessThanOrEqual(30);
    }
    await capture(page, info, 'swarm');
    await card.click();
    const result = page.locator('details.autonomous-verdict');
    await expect(result).toBeVisible();
    await result.locator(':scope > summary').click();
    await expect(page.getByText('Patch and test output agree.', { exact: true }).first()).toBeVisible();
    await capture(page, info, 'swarm-reviewer');
    await page.getByRole('button', { name: '关闭右侧面板', exact: true }).click();
  }
});

async function expectSingleFieldFocus(field) {
  const input = field.locator('input');
  await expect(input).toBeFocused();
  if (process.env.E2E_FRONTEND_DIR) return;
  await expect(field).toHaveCSS('outline-style', 'solid');
  await expect(field).toHaveCSS('outline-width', '2px');
  await expect(field).toHaveCSS('box-shadow', 'none');
  await expect(input).toHaveCSS('outline-style', 'none');
}

test('desktop shell, search, settings, capability navigation and scheduling surfaces', async ({ page }, info) => {
  await page.goto('/');
  for (const theme of ['light', 'dark']) {
    await toggleTheme(page, theme);
    await page.keyboard.press('Control+K');
    const search = page.getByRole('dialog', { name: '搜索与快捷操作' });
    await expectSingleFieldFocus(search.locator('.codex-search-top'));
    await capture(page, info, 'global-search');
    await page.keyboard.press('Escape');
    await expect(search).toHaveCount(0);

    await navigate(page, '/settings/appearance');
    await expect(page.getByRole('heading', { name: '外观', exact: true })).toBeVisible();
    await capture(page, info, 'settings-appearance');
    await navigate(page, '/capabilities');
    await expect(page.getByRole('heading', { name: '插件', exact: true })).toBeVisible();
    await capture(page, info, 'capabilities');
    await navigate(page, '/evaluations');
    await expect(page.getByRole('heading', { name: '能力评测', exact: true })).toBeVisible();
    await capture(page, info, 'evaluations');
    await navigate(page, '/tasks');
    if (!process.env.E2E_FRONTEND_DIR) {
      await expect(page.getByRole('heading', { name: '已安排的任务', exact: true })).toBeVisible();
      await capture(page, info, 'scheduled');
    }
    await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: '新建定时任务', exact: true })).toBeVisible();
    await expectSingleFieldFocus(page.locator('.codex-modal-input-box'));
    await capture(page, info, 'schedule-dialog');
    await page.locator('.codex-modal-cancel-btn').click();
    await navigate(page, '/');
  }
});

test('settings handle an older Supervisor endpoint, support retry and stay readable at each width', async ({ page }, info) => {
  test.skip(Boolean(process.env.E2E_FRONTEND_DIR), 'New settings behavior');
  const alias = 'workspace:long-model-alias-for-context-supervision-and-model-selection';
  let readStatus = 404;
  let patchStatus = 200;
  let saved = { enabled: true, admissionEnabled: true, mode: 'off', model: null, dtocMinPromptTokens: 24_000,
    epochWatermarks: [.6, .82], maxBudgetRatio: .72, maxOutputTokens: 512, timeoutMs: 5_000 };
  await page.route('**/v1/context/supervisor', async route => {
    const patch = route.request().method() === 'PATCH';
    const status = patch ? patchStatus : readStatus;
    if (status !== 200) return route.fulfill({ status, json: { message: 'Route GET:/v1/context/supervisor not found' } });
    if (patch) saved = { ...saved, ...route.request().postDataJSON() };
    return route.fulfill({ json: {
      config: saved, effectiveModel: null, recommendedModel: alias, readOnly: true, reversibleStore: false,
      rationale: 'supervisor_mode_off', recommendedRationale: 'auto_catalog_best_healthy', guidelinesCount: 0,
      candidates: [{ alias, provider: 'Fixture', healthy: true, recommended: true }],
    } });
  });

  await page.goto('/#/settings/context');
  const settings = page.locator('.codex-settings-page');
  const nav = settings.getByRole('navigation', { name: '设置分类' });
  const search = settings.getByRole('textbox', { name: '搜索设置' });
  const content = settings.locator('.codex-settings-body');
  const refresh = settings.getByRole('button', { name: '刷新目录', exact: true });
  const alert = content.getByRole('alert');
  const toggle = content.getByRole('switch', { name: '启用自适应上下文', exact: true });
  await expect(alert).toContainText('当前后端未提供自适应上下文接口');
  await expect(content).not.toContainText('Route GET');
  await expect(toggle).toHaveCount(0);
  await expect(refresh).toHaveCSS('white-space', 'nowrap');
  await capture(page, info, 'settings-context-unsupported');

  readStatus = 200;
  await refresh.click();
  await expect(toggle).toBeChecked();
  await expect(content.getByRole('combobox', { name: 'Supervisor 候选模型' })).toHaveValue('');
  await expect(content.getByText('未启用', { exact: true })).toBeVisible();
  patchStatus = 503;
  await toggle.click();
  await expect(alert).toContainText('未能保存设置');
  await expect(toggle).toBeChecked();
  patchStatus = 200;
  await toggle.click();
  await expect(toggle).not.toBeChecked();

  readStatus = 503;
  await refresh.click();
  await expect(alert).toContainText('下方为上次读取的状态');
  await expect(toggle).toBeDisabled();
  readStatus = 200;
  await refresh.click();
  await expect(toggle).toBeEnabled();
  const limits = await content.evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth }));
  expect(limits.scrollWidth).toBeLessThanOrEqual(limits.width + 1);
  await expect(settings.locator('.codex-settings-inner')).toHaveCSS('animation-name', 'none');
  await capture(page, info, 'settings-context');
  await toggleTheme(page, 'dark');
  await capture(page, info, 'settings-context');

  await content.evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect(await content.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await search.fill('没有这个分类');
  await expect(nav.getByRole('status')).toHaveText('没有匹配的设置');
  await settings.getByRole('button', { name: '清除设置搜索' }).click();
  await expect(search).toBeFocused();
  await nav.getByRole('button', { name: '外观', exact: true }).click();
  await expect(content.getByRole('heading', { name: '外观', exact: true })).toBeVisible();
  await expect.poll(() => content.evaluate(el => el.scrollTop)).toBe(0);
});

test('workspace destinations preserve the sidebar, with route-only motion and usable library controls', async ({ page }, info) => {
  test.skip(Boolean(process.env.E2E_FRONTEND_DIR), 'New workspace destinations');
  await page.route('**/api/extensions/catalog*', route => route.fulfill({ json: {} }));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    window.workspaceNavigationAnimations = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      if (this.classList.contains('codex-workspace-column')) window.workspaceNavigationAnimations++;
      return animate.apply(this, args);
    };
  });
  await page.goto('/');
  const sidebar = page.getByRole('complementary', { name: '对话历史' });
  if (info.project.use.viewport.width <= 820) {
    await page.getByRole('button', { name: '显示侧边栏', exact: true }).click();
  }
  const archiveButton = sidebar.getByRole('button', { name: '已归档', exact: true });
  const pluginButton = sidebar.getByRole('button', { name: '插件', exact: true });
  const scheduleButton = sidebar.getByRole('button', { name: '定时任务', exact: true });
  await sidebar.evaluate((node) => { window.originalWorkspaceSidebar = node; });
  const expectSidebar = async (active) => {
    await expect(active).toHaveAttribute('aria-current', 'page');
    expect(await sidebar.evaluate(node => window.originalWorkspaceSidebar === node)).toBe(true);
    await expect(page.getByRole('button', { name: '隐藏侧边栏', exact: true })).toBeVisible();
    await expect(page.locator('.codex-settings-nav')).toHaveCount(0);
  };
  const countAnimations = () => page.evaluate(() => window.workspaceNavigationAnimations);
  await archiveButton.click();
  await expect(page).toHaveURL(/#\/archived$/);
  await expect(page.getByRole('heading', { name: '已归档的聊天' })).toBeVisible();
  await expectSidebar(archiveButton);
  expect(await countAnimations()).toBe(1);
  await capture(page, info, 'archived');

  await pluginButton.click();
  await expectSidebar(pluginButton);
  const tabs = page.getByRole('banner').getByRole('navigation', { name: '插件与技能' });
  await expect(tabs.getByRole('button', { name: '插件', exact: true })).toHaveAttribute('aria-current', 'page');
  const list = page.getByRole('region', { name: '插件', exact: true });
  const groups = list.locator('.codex-library-group');
  await expect(groups.first()).toHaveAttribute('aria-label', 'Productivity');
  await expect(groups.nth(1)).toHaveAttribute('aria-label', 'Creativity');
  const firstGrid = groups.first().locator('.codex-custom-grid');
  const tracks = await firstGrid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(tracks).toBe(info.project.use.viewport.width <= 820 ? 1 : 2);
  await list.getByRole('combobox', { name: '筛选插件分类' }).selectOption('Creativity');
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toHaveAttribute('aria-label', 'Creativity');
  await list.getByRole('button', { name: '个人', exact: true }).click();
  await expect(list.getByRole('button', { name: '个人', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await countAnimations()).toBe(2);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByRole('button', { name: '添加自定义 MCP 插件' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '创建', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await tabs.getByRole('button', { name: '技能', exact: true }).click();
  await expect(page).toHaveURL(/#\/capabilities\/skills$/);
  await expect(page.getByRole('heading', { name: '技能', exact: true })).toBeVisible();
  await expectSidebar(pluginButton);
  await capture(page, info, 'skills');
  expect(await countAnimations()).toBe(3);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page).toHaveURL(/#\/capabilities$/);
  await expect(tabs.getByRole('button', { name: '插件', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(await countAnimations()).toBe(4);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await scheduleButton.click();
  await expectSidebar(scheduleButton);
  await expect(page.getByRole('searchbox', { name: '搜索已安排任务' })).toBeVisible();
  await page.getByRole('button', { name: /每日简报/ }).click();
  const create = page.getByRole('dialog', { name: '新建定时任务' });
  await expect(create.getByPlaceholder('任务名称（如：每日代码健康检查）')).toHaveValue('每日简报');
  await expect(create.getByPlaceholder('0 9 * * 1-5')).toHaveValue('0 8 * * 1-5');
  await expect(create.getByPlaceholder('描述每次触发时让 Agent 自动执行的任务…')).not.toHaveValue('');
  await create.getByRole('button', { name: '取消', exact: true }).click();
  expect(await countAnimations()).toBe(4);
});

test('plugin icons use the office artwork and pictograms instead of initials', async ({ page }, info) => {
  test.skip(Boolean(process.env.E2E_FRONTEND_DIR), 'New office artwork');
  await page.goto('/#/capabilities');
  const officePlugins = ['Documents', 'PDF', 'Spreadsheets', 'Presentations'];
  const tile = (name) => page.getByRole('button', { name: `查看 ${name} 插件详情`, exact: true })
    .locator('.codex-custom-icon-tile');
  const expectLoadedArtwork = async (iconTile) => {
    const img = iconTile.locator('img');
    await img.scrollIntoViewIfNeeded();
    await expect(img).toHaveAttribute('src', /^(?:data:image\/svg\+xml[;,]|\/[^?#]*\.svg(?:[?#]|$))/);
    await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
    await expect(iconTile).toHaveText('');
    return img.getAttribute('src');
  };

  const install = page.getByRole('button', { name: '安装 Presentations', exact: true });
  const installed = page.getByRole('button', { name: '已安装 Presentations', exact: true });
  await expect(install).toBeEnabled();
  for (const theme of ['light', 'dark']) {
    await toggleTheme(page, theme);
    const sources = [];
    for (const name of officePlugins) sources.push(await expectLoadedArtwork(tile(name)));
    expect(new Set(sources).size).toBe(officePlugins.length);
    await capture(page, info, 'office-plugin-icons');
    await page.getByRole('button', { name: '查看 Presentations 插件详情', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '配置插件 Presentations' });
    expect(await expectLoadedArtwork(detail.locator('.codex-custom-icon-tile'))).toBe(sources.at(-1));
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
  }

  await install.click();
  await expect(installed).toBeEnabled();
  await installed.click();
  await page.getByRole('dialog', { name: '配置插件 Presentations' })
    .getByRole('button', { name: '卸载插件', exact: true }).click();
  await expect(install).toBeEnabled();

  await page.getByRole('combobox', { name: '筛选插件分类' }).selectOption('Creativity');
  const withoutBrand = tile('Creative Claw');
  await expect(withoutBrand.locator('svg[aria-hidden="true"] path')).toBeVisible();
  await expect(withoutBrand).toHaveText('');
});

test('desktop focus and reduced motion do not alter transcript or inspector state', async ({ page }, info) => {
  test.skip(Boolean(process.env.E2E_FRONTEND_DIR), 'New keyboard and motion behavior');
  test.skip(info.project.name !== '1440x960', 'Keyboard and motion are viewport-independent');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const model = page.getByRole('button', { name: '模型与推理强度', exact: true });
  await model.focus();
  await page.keyboard.press('Enter');
  const slider = page.getByRole('slider', { name: '推理强度' });
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Escape');
  await expect(model).toBeFocused();
  await expect(model).toHaveAttribute('aria-expanded', 'false');
  await model.click();
  await expect(model).toHaveAttribute('aria-expanded', 'true');
  const searchTrigger = page.locator('.codex-sidebar [aria-label="搜索"]').first();
  await searchTrigger.focus();
  await page.keyboard.press('Escape');
  await expect(model).toHaveAttribute('aria-expanded', 'false');
  await expect(searchTrigger).toBeFocused();

  await navigate(page, '/t/markdown-visual');
  const files = transcript(page).locator('.codex-file-card');
  await files.getByRole('button', { name: '在右侧分屏打开 src/config.ts', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: '工作区标签页' });
  const file = tabs.getByRole('tab', { name: 'config.ts' });
  const subagents = tabs.getByRole('tab', { name: '子智能体' });
  await expect(file).toHaveAttribute('aria-selected', 'true');
  await file.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(subagents).toBeFocused();
  await expect(subagents).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(file).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'config.ts' })).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(file).toHaveCount(0);
  await expect(subagents).toBeFocused();
  const addPane = page.getByRole('button', { name: '打开面板标签页', exact: true });
  await addPane.click();
  await page.getByRole('button', { name: 'SSE 事件与版本', exact: true }).click();
  await expect(tabs.getByRole('tab', { name: '事件与版本' })).toHaveAttribute('aria-selected', 'true');
  await addPane.click();
  await page.keyboard.press('Escape');
  await expect(addPane).toBeFocused();
  await expect(addPane).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: '关闭右侧面板', exact: true }).click();

  await navigate(page, '/settings/appearance');
  await page.getByRole('switch', { name: '减弱动效' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
  await navigate(page, '/t/approval-visual');
  await expect(transcript(page).locator('.codex-approval-card')).toBeVisible();
  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: '搜索与快捷操作' })).toHaveCSS('animation-name', 'none');
  await page.keyboard.press('Escape');
  await navigate(page, '/settings/appearance');
  await page.getByRole('switch', { name: '减弱动效' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'false');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: '搜索与快捷操作' })).toHaveCSS('animation-name', 'none');
});


test('terminal disclosure reverses from its live height and settles immediately under Reduce Motion', async ({ page }, info) => {
  test.skip(Boolean(process.env.E2E_FRONTEND_DIR) || info.project.name !== '1440x960', 'New desktop motion contract');
  await page.goto('/#/t/tools-visual');
  await openActivity(page);
  const tool = transcript(page).locator('details.codex-direct-tool').filter({ hasText: 'npm run test:auth' });
  const summary = tool.locator(':scope > summary');
  const panel = tool.locator(':scope > .codex-collapsible');
  await summary.scrollIntoViewIfNeeded();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const frames = await tool.evaluate(async (details) => {
    const trigger = details.querySelector('summary');
    const panel = details.querySelector('.codex-collapsible');
    trigger.click();
    await new Promise(requestAnimationFrame);
    const animation = panel.getAnimations().find(item => item.transitionProperty === 'height');
    if (!animation) throw new Error('No height transition started');
    animation.pause();
    await animation.ready;
    animation.currentTime = 35;
    const height = panel.getBoundingClientRect().height;
    const target = panel.firstElementChild.scrollHeight;
    trigger.click();
    await new Promise(requestAnimationFrame);
    const closing = panel.getAnimations().find(item => item.transitionProperty === 'height');
    const reversed = parseFloat(closing?.effect.getKeyframes()[0].height ?? 'NaN');
    return { height, target, reversed, expanded: trigger.getAttribute('aria-expanded'), inert: panel.inert };
  });
  expect(frames.height).toBeGreaterThan(0);
  expect(frames.height).toBeLessThan(frames.target);
  expect(Math.abs(frames.reversed - frames.height)).toBeLessThan(4);
  expect(frames.expanded).toBe('false');
  expect(frames.inert).toBe(true);
  await expect(panel).toBeHidden();
  expect(await tool.getAttribute('open')).toBeNull();

  await summary.click();
  await expect(tool.locator('pre')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await summary.click();
  await expect(panel).toBeHidden();
  expect(await panel.evaluate(node => node.getAnimations())).toHaveLength(0);
});
