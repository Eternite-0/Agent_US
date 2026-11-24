import { expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const transcript = (page) => page.locator('.codex-transcript');
export const latest = (page) => page.getByRole('button', { name: '滚动到底部', includeHidden: true });
export const composer = (page) => page.getByRole('textbox', { name: '消息内容' });
export const exchanges = (page) => transcript(page).locator('.codex-direct-exchange');
export const turn = (page, prompt) => exchanges(page).filter({ has: page.getByText(prompt, { exact: true }) });

export async function geometry(page) {
  return transcript(page).evaluate((el) => ({
    top: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop,
    viewHeight: el.clientHeight, fullHeight: el.scrollHeight,
  }));
}

export async function atTail(page) {
  await expect.poll(async () => (await geometry(page)).gap, { message: 'Transcript follows the latest turn' }).toBeLessThanOrEqual(4);
}

export async function offsetInViewport(node) {
  return node.evaluate((el) => el.getBoundingClientRect().top - el.closest('.codex-transcript').getBoundingClientRect().top);
}

export async function stableAnchor(node, top, tolerance = 8) {
  await expect.poll(async () => Math.abs((await offsetInViewport(node)) - top), { message: 'Reading anchor stays at its viewport offset' }).toBeLessThanOrEqual(tolerance);
}

export async function scrollToRead(page) {
  const view = transcript(page);
  const box = await view.boundingBox();
  if (!box) throw new Error('Transcript is not visible');
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.55);
  await page.mouse.wheel(0, -650);
  await expect.poll(async () => (await geometry(page)).gap).toBeGreaterThan(150);
}

// test harness uses only the UI to submit turns, not a REST state shortcut.
export async function sendMessage(page, text) {
  await composer(page).fill(text);
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && /\/v1\/sessions\/[^/]+\/turns$/.test(new URL(r.url()).pathname));
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const result = await response;
  expect(result.ok(), 'Direct REST turn creation').toBe(true);
  return result.json();
}

export async function screenshot(page, name) {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

export const longDelta = (tag, lines = 20) => Array.from({ length: lines }, (_, i) =>
  `**${tag} ${i + 1}.** Inspect the transcript position and verify the newest response remains readable while the response streams.`).join('\n\n');
