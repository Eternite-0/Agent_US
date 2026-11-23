import { expect, test } from '@playwright/test';
import { atTail, composer, geometry, screenshot, sendMessage, transcript, turn } from '../e2e/thread.mjs';

async function expectClearTail(page, exchange) {
  const reply = exchange.getByText('BROWSER RUNTIME COMPLETE', { exact: true });
  const actions = exchange.locator('..').locator('.a2a-direct-actions').last();
  await atTail(page);
  await expect(reply).toBeInViewport({ ratio: 1 });
  await expect(actions).toBeInViewport({ ratio: 1 });
  const view = await transcript(page).boundingBox();
  const footer = await actions.boundingBox();
  const dock = await page.locator('.codex-thread-composer-dock').boundingBox();
  expect(view.y + view.height, 'Composer starts after the scroll viewport').toBeLessThanOrEqual(dock.y + 1);
  expect(view.y + view.height - footer.y - footer.height, 'Space below the last turn actions').toBeGreaterThanOrEqual(16);
}

// Acceptance A: REST + real DirectAgentRuntime + real terminal + real SSE.
// The two read-only Node scripts run in a temporary workspace, not the repo.
test('an open real terminal command stays mounted through the next command and final history', async ({ page, request, context }) => {
  const sessionResponse = await request.post('/v1/sessions', { data: { title: 'Direct runtime regression' } });
  expect(sessionResponse.ok()).toBe(true);
  const { id } = await sessionResponse.json();
  const stream = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/stream' && response.ok());
  await page.goto(`/#/t/${id}`);
  await stream;
  const cache = page.getByRole('button', { name: /^Prompt Cache/ });
  await expect(cache).toContainText('暂无请求');
  const metricsRoute = '**/v1/observability/metrics?*';
  await page.route(metricsRoute, route => route.fulfill({ json: { averageTokenUsage: { cacheReadRatio: 0.8 } } }));
  await cache.click();
  const cacheDetails = page.getByRole('region', { name: '缓存详情' });
  const refreshCache = cacheDetails.getByRole('button', { name: '刷新缓存数据' });
  await refreshCache.click();
  await expect(cache).toContainText('后端版本过旧');
  await expect(cache).not.toContainText('80%');
  await expect(cacheDetails).toContainText('重新启动后端');
  await page.unroute(metricsRoute);
  await page.keyboard.press('Escape');
  await expect(cacheDetails).toBeHidden();
  await page.getByRole('button', { name: '帮我批准', exact: true }).click();
  await page.getByRole('button', { name: /完全访问权限/ }).click();

  const prompt = 'Run the two isolated browser regression scripts';
  await sendMessage(page, prompt);
  const exchange = turn(page, prompt);
  const rows = exchange.locator('details.codex-direct-tool');
  const first = rows.filter({ has: page.locator('summary', { hasText: 'node run-first.mjs' }) });
  expect((await request.post('/v1/_e2e/gates/0')).ok()).toBe(true);
  const group = exchange.locator('details.codex-direct-activity').filter({ has: page.locator('summary', { hasText: 'node run-first.mjs' }) }).first();
  await expect(group).toBeVisible();
  if (await group.getAttribute('open') === null) await group.locator(':scope > summary').click();
  await first.locator(':scope > summary').click();
  await expect(first).toHaveAttribute('open', '');
  const original = await first.elementHandle();
  await expect(first.locator('pre')).toContainText('RUNTIME-FIRST-OUTPUT');

  await cache.click();
  await refreshCache.click();
  await expect(cache).toContainText('缓存命中 0%');
  await expect(cacheDetails).toContainText('1/1 次请求');
  await page.keyboard.press('Escape');
  expect((await request.post('/v1/_e2e/gates/1')).ok()).toBe(true);
  await expect(exchange.getByText('BROWSER RUNTIME COMPLETE', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(first).toHaveAttribute('open', '');
  await expect(first.locator('pre')).toBeVisible();
  await expect(first.locator('pre')).toContainText('RUNTIME-FIRST-OUTPUT');
  expect(await original.evaluate(node => node.isConnected && node.open)).toBe(true);
  const second = rows.filter({ has: page.locator('summary', { hasText: 'node run-second.mjs' }) });
  const secondGroup = second.locator('xpath=ancestor::details[contains(@class, "codex-direct-activity")][1]');
  if (await secondGroup.getAttribute('open') === null) await secondGroup.locator(':scope > summary').click();
  if (await second.getAttribute('open') === null) await second.locator(':scope > summary').click();
  await expect(second.locator('pre')).toContainText('RUNTIME-SECOND-OUTPUT');
  await expectClearTail(page, exchange);
  await expect(rows.getByText('工具输出', { exact: true })).toHaveCount(0);
  const firstOutput = first.locator('pre[aria-label="工具输出"]');
  await expect(firstOutput).toBeVisible();
  await screenshot(page, 'runtime-two-real-commands');

  // Force overflow and repeat the opening at the tail with a taller dock.
  // Even a clipped footer may report .toBeVisible(), so assert the actual bounds.
  await page.setViewportSize({ width: 780, height: 650 });
  const toggle = second.locator(':scope > summary');
  await toggle.click();
  await expect(second).not.toHaveAttribute('open', '');
  await composer(page).fill('Follow-up draft\n'.repeat(6).trimEnd());
  await expectClearTail(page, exchange);
  const before = await geometry(page);
  await expect(toggle).toBeInViewport({ ratio: 1 });
  await toggle.click();
  await expect(second).toHaveAttribute('open', '');
  await expect.poll(async () => (await geometry(page)).top).toBeGreaterThan(before.top + 8);
  await expect(toggle).toBeInViewport({ ratio: 1 });
  await expectClearTail(page, exchange);
  expect(await original.evaluate(node => node.isConnected && node.open)).toBe(true);
  await screenshot(page, 'runtime-tall-composer');
  await page.keyboard.press('Control+Shift+L');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectClearTail(page, exchange);
  await screenshot(page, 'runtime-tall-composer-dark');

  await page.setViewportSize({ width: 1440, height: 960 });
  await composer(page).fill('');
  // The terminal SSE event refreshes the status without another manual request.
  await expect(cache).toContainText('缓存命中 50%');
  await cache.click();
  await expect(cacheDetails).toContainText('1,500 / 75');
  await expect(cacheDetails).toContainText('3/3 次请求');
  await screenshot(page, 'runtime-prompt-cache');
  await page.route(metricsRoute, route => route.fulfill({ status: 503, json: {} }));
  await refreshCache.click();
  await expect(cache).toContainText('更新失败 · 上次数据');
  await expect(cache).toContainText('缓存命中 50%');
  await page.unroute(metricsRoute);
  await refreshCache.click();
  await expect(cache).toContainText('小时 · 可用');
  await page.keyboard.press('Escape');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await first.getByRole('button', { name: '复制命令' }).click();
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  await expect.poll(clipboard).toBe('node run-first.mjs');
  await first.getByRole('button', { name: '复制输出' }).click();
  await expect.poll(clipboard).toBe(await firstOutput.textContent());
  await original.dispose();
});
