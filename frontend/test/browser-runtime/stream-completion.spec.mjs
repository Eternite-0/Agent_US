import { expect, test } from '@playwright/test';
import { atTail, composer, sendMessage, transcript, turn } from '../e2e/thread.mjs';

test('continuous real runtime output does not reload the document or remount the reply', async ({ page, request }) => {
  const prompt = 'Stream a continuous final answer';
  const create = await request.post('/v1/sessions', { data: { title: 'Streaming completion regression' } });
  expect(create.ok()).toBe(true);
  const { id } = await create.json();
  await page.goto(`/#/t/${id}`);
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const navigations = [];
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  await sendMessage(page, prompt);
  const exchange = turn(page, prompt);
  const reply = exchange.locator('.codex-direct-prose');
  const first = 'The real runtime streams one reply.';
  const second = `${first} It stays visible across chunks.`;
  const final = `${second} Final output.`;
  await expect(reply).toHaveText(first);
  const original = await reply.elementHandle();
  const viewport = await transcript(page).elementHandle();
  await expect(reply.locator('.a2a-stream-cursor')).toBeVisible();

  for (const [gate, expected] of [[2, second], [3, final]]) {
    expect((await request.post(`/v1/_e2e/gates/${gate}`)).ok()).toBe(true);
    await expect(reply).toHaveText(expected);
    expect(await original.evaluate((node) => node.isConnected)).toBe(true);
  }

  let releaseHistory;
  const heldHistory = new Promise((resolve) => { releaseHistory = resolve; });
  let gatedHistory = false;
  await page.route(`**/v1/sessions/${id}/messages?*`, async (route) => {
    gatedHistory = true;
    await heldHistory;
    await route.continue();
  });
  try {
    expect((await request.post('/v1/_e2e/gates/4')).ok()).toBe(true);
    await expect.poll(() => gatedHistory).toBe(true);
    await expect(exchange.locator('.codex-direct-status')).toHaveAttribute('data-status', 'completed');
    await expect(reply).toHaveText(final);
    await expect(reply.locator('.a2a-stream-cursor')).toHaveCount(0);
    expect(await original.evaluate((node) => node.isConnected && !node.closest('[hidden]'))).toBe(true);

    const messages = await (await request.get(`/v1/sessions/${id}/messages`)).json();
    const events = await (await request.get(`/v1/sessions/${id}/events`)).json();
    const row = messages.items.find(({ role }) => role === 'assistant');
    expect(row.content).toBe(final);
    const published = events.items.find(({ type, data }) => type === 'assistant/message' && data.text === final);
    expect(published).toBeDefined();
    // Older runtimes omit the durable cursor; verify it when the server advertises it.
    if (published.data.messageCursor !== undefined) expect(published.data.messageCursor).toBe(row.seq);
  } finally {
    releaseHistory();
  }
  await expect(reply).toHaveCount(1);
  await expect(composer(page)).toBeInViewport();
  await atTail(page);
  expect(await original.evaluate((node) => node.isConnected)).toBe(true);
  expect(await viewport.evaluate((node) => node.isConnected)).toBe(true);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  expect(navigations).toEqual([]);
});
