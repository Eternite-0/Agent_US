import { expect, test } from '@playwright/test';
import { screenshot, transcript } from '../e2e/thread.mjs';
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
      if (kind === 'turns') value = { items: [{ id: turnId, input: data.prompt, state: data.state, createdAt: FIXED_TIME, durationMs: 1900 }] };
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
  }
});

test('home and Markdown hierarchy in light and dark themes; file diff in Inspector', async ({ page }, info) => {
  await page.goto('/');
  for (const theme of ['light', 'dark']) {
    await toggleTheme(page, theme);
    await expect(page.locator('.codex-home .codex-composer-card')).toBeVisible();
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
