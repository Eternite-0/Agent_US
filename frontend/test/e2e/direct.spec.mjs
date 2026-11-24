import { expect, test } from '@playwright/test';
import { atTail, composer, exchanges, geometry, latest, scrollToRead, sendMessage, transcript, turn } from './thread.mjs';

// These prompts are deliberate workloads, not simulated responses. A provider that
// does not stream long replies or honor tool calls may not exercise this suite.
const initialPrompt = 'DIRECT-E2E-A: Without using tools, write 28 numbered Markdown paragraphs of about 30 words each about organizing a collection of recipes. Use a blank line between each paragraph. End with the marker RECIPE-REVIEW-COMPLETE.';
const followupPrompt = 'DIRECT-E2E-B-C: Without using tools, write 26 numbered Markdown paragraphs of about 30 words each explaining how to catalogue flowers. Use a blank line between each paragraph. End with the marker FLOWER-CATALOGUE-COMPLETE.';
const toolPrompt = "DIRECT-E2E-D: Use a shell command once to print exactly DIRECT-E2E-COMMAND-OUTPUT (printf 'DIRECT-E2E-COMMAND-OUTPUT\\n'). Do not read or write files and do not use the network. Then reply with a single sentence that includes DIRECT-E2E-TOOL-COMPLETE.";

async function makeSession(request, title) {
  const result = await request.post('/v1/sessions', { data: { title, permissionMode: 'auto-safe' } });
  expect(result.ok(), 'Authenticated creation via the Vite-to-Direct proxy').toBe(true);
  return (await result.json()).id;
}

async function completed(request, sessionId, turnId) {
  await expect.poll(async () => {
    const response = await request.get(`/v1/sessions/${sessionId}/turns?limit=1`);
    if (!response.ok()) return 'rest-error';
    const item = (await response.json()).items[0];
    return item?.id === turnId ? item.state : 'waiting for turn';
  }, { timeout: 90_000, message: 'The real Direct turn completed' }).toBe('completed');
}

function watchStream(page) {
  return page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/stream' &&
    response.status() === 200 && response.headers()['content-type']?.includes('text/event-stream'));
}

test('authenticated Direct smoke (real provider)', async ({ page, request }) => {
  const health = await request.get('/v1/health');
  expect(health.ok()).toBe(true);
  expect((await health.json()).routerReady, 'Explicit real provider registered').toBe(true);
  const sessionId = await makeSession(request, 'Direct E2E transcript');
  const foreignSessionId = await makeSession(request, 'Direct E2E separate session');
  const stream = watchStream(page);
  await page.goto(`/#/t/${sessionId}`);
  await stream;

  await test.step('Follow a real streamed reply', async () => {
    const { turn: started } = await sendMessage(page, initialPrompt);
    await expect(turn(page, initialPrompt).locator('.a2a-stream-cursor')).toBeVisible({ timeout: 45_000 });
    await expect.poll(async () => (await geometry(page)).fullHeight - (await geometry(page)).viewHeight, { timeout: 45_000 }).toBeGreaterThan(220);
    await atTail(page);
    await completed(request, sessionId, started.id);
    await expect(turn(page, initialPrompt).getByText(/RECIPE-REVIEW-COMPLETE/)).toBeVisible();
  });

  let followupId;
  await test.step('Scrolling away during a real second reply does not jump', async () => {
    await atTail(page);
    const { turn: started } = await sendMessage(page, followupPrompt);
    followupId = started.id;
    await expect(turn(page, followupPrompt).locator('.a2a-stream-cursor')).toBeVisible({ timeout: 45_000 });
    await scrollToRead(page);
    const detached = await geometry(page);
    await expect(latest(page)).toHaveAttribute('data-visible', 'true');
    await expect.poll(async () => (await geometry(page)).fullHeight, { timeout: 45_000 }).toBeGreaterThan(detached.fullHeight + 80);
    expect(Math.abs((await geometry(page)).top - detached.top)).toBeLessThanOrEqual(12);
    await latest(page).click();
    await atTail(page);
  });

  await test.step('One durable final replaces streaming content', async () => {
    await completed(request, sessionId, followupId);
    const exchange = turn(page, followupPrompt);
    await expect(exchange.getByText(/FLOWER-CATALOGUE-COMPLETE/)).toHaveCount(1);
    await expect(exchange.locator('.a2a-stream-cursor')).toHaveCount(0);
    await atTail(page);
  });

  await test.step('A real command exposes durable, nested tool output', async () => {
    const { turn: started } = await sendMessage(page, toolPrompt);
    await completed(request, sessionId, started.id);
    const exchange = turn(page, toolPrompt);
    await expect(exchange.getByText(/DIRECT-E2E-TOOL-COMPLETE/).last()).toBeVisible();
    const process = exchange.locator('.codex-direct-status button');
    await expect(process).toBeEnabled();
    if (await process.getAttribute('aria-expanded') !== 'true') await process.click();
    const group = exchange.locator('details.codex-direct-activity').filter({ hasText: /命令/ }).first();
    if (await group.getAttribute('open') === null) await group.locator(':scope > summary').click();
    const tool = group.locator('details.codex-direct-tool').first();
    if (await tool.getAttribute('open') === null) await tool.locator(':scope > summary').click();
    await expect(tool.locator('pre[aria-label="工具输出"]')).toContainText('DIRECT-E2E-COMMAND-OUTPUT');
  });

  await test.step('Session switch at a narrow viewport retains a reachable composer', async () => {
    await page.setViewportSize({ width: 780, height: 840 });
    await page.goto(`/#/t/${foreignSessionId}`);
    await expect(transcript(page).getByText(initialPrompt, { exact: true })).toHaveCount(0);
    await expect(composer(page)).toBeInViewport();
    await page.goto(`/#/t/${sessionId}`);
    await expect(exchanges(page)).toHaveCount(3);
    await atTail(page);
    await expect(composer(page)).toBeInViewport();
    const view = await transcript(page).boundingBox();
    const dock = await page.locator('.codex-thread-composer-dock').boundingBox();
    expect(view.y + view.height).toBeLessThanOrEqual(dock.y + 1);
  });
});
