import { expect, test } from '@playwright/test';
import { FIXED_TIME } from './sse-server.mjs';
import { atTail, composer, exchanges, geometry, latest, longDelta, offsetInViewport, screenshot, scrollToRead, sendMessage, stableAnchor, transcript, turn } from './thread.mjs';

const baseline = process.env.E2E_CAPTURE_BASELINE === '1';
const assertions = !baseline;
if (baseline && (!process.env.E2E_SCREENSHOT_DIR || !process.env.E2E_FRONTEND_DIR)) {
  throw new Error('Baseline capture requires an archived E2E_FRONTEND_DIR and E2E_SCREENSHOT_DIR');
}
const finalText = 'Durable response: the review is complete.';

async function advance(request, action, extra = {}) {
  const result = await request.post('/__e2e/advance', { data: { action, ...extra } });
  expect(result.ok(), `Fixture action ${action}`).toBe(true);
}

async function openHistory(page, request, count = 8) {
  await page.goto('/#/t/transcript');
  await expect(exchanges(page)).toHaveCount(count);
  await expect.poll(async () => (await (await request.get('/__e2e/streams')).json()).count).toBeGreaterThan(0);
  await atTail(page);
}

async function begin(page, request, prompt) {
  await openHistory(page, request);
  await sendMessage(page, prompt);
  await expect(turn(page, prompt)).toBeVisible();
  await expect(turn(page, prompt).locator('.codex-direct-status').first()).toBeVisible();
}

test.beforeEach(async ({ page, request }) => {
  await page.clock.setFixedTime(new Date(FIXED_TIME + 45_000));
  expect((await request.post('/__e2e/reset')).ok()).toBe(true);
});

test('A — follows live assistant growth at the tail', async ({ page, request }) => {
  await begin(page, request, 'Review the layout while the response streams');
  const initial = await geometry(page);
  await advance(request, 'assistant/delta', { text: longDelta('Streaming checkpoint') });
  await expect(transcript(page).getByText('Streaming checkpoint 20.', { exact: true })).toBeVisible();
  expect((await geometry(page)).fullHeight).toBeGreaterThan(initial.fullHeight + 200);
  if (assertions) {
    await atTail(page);
    await expect(latest(page)).not.toHaveAttribute('data-visible', 'true');
    await expect(composer(page)).toBeInViewport();
  }
  await screenshot(page, 'A-live-tail');
});

test('A — nested tool output stays readable across the live-to-durable handoff', async ({ page, request }) => {
  const prompt = 'Run a workspace diagnostics command';
  await begin(page, request, prompt);
  const exchange = turn(page, prompt);
  await advance(request, 'reasoning/delta', { text: 'Checking the workspace diagnostics.' });
  await expect(exchange.getByText('Checking the workspace diagnostics.', { exact: true })).toBeVisible();
  await advance(request, 'tool/call');
  // A persisted tool call and an ephemeral output both travel via the SSE parser.
  const phase = exchange.locator('details.codex-direct-activity > summary').first();
  await expect(phase).toBeVisible();
  await phase.click();
  const tool = exchange.locator('details.codex-direct-tool > summary').first();
  await expect(tool).toBeVisible();
  await tool.click();
  const output = longDelta('Diagnostic line', 30);
  await advance(request, 'tool/output', { text: output });
  await expect(exchange.locator('pre[aria-label="实时工具输出"]')).toHaveText(output);
  await screenshot(page, 'A-live-tool-output');
  await advance(request, 'tool/result', { text: output });
  if (assertions) {
    await expect(exchange.locator('pre[aria-label="工具输出"]')).toBeVisible();
    await expect(exchange.locator('pre[aria-label="实时工具输出"]')).toHaveCount(0);
    await expect(exchange.locator('details.codex-direct-tool[open]')).toHaveCount(1);
  }
  await advance(request, 'finish', { text: finalText, reason: 'completed' });
  await expect(exchange.getByText(finalText, { exact: true })).toBeVisible();
  if (assertions) await expect(exchange.getByText(finalText, { exact: true })).toHaveCount(1);
  await screenshot(page, 'A-persisted-completion');
});

for (const reason of ['completed', 'parked']) {
  test(`file edit summary waits for delivery (${reason})`, async ({ page, request }) => {
    test.skip(baseline, 'Delivery timing is a new regression assertion');
    const prompt = 'Edit the config and run the checks before delivering';
    const path = 'src/config.ts';
    await begin(page, request, prompt);
    const exchange = turn(page, prompt);
    const summary = transcript(page).locator('.codex-file-card');
    const edit = { name: 'edit_file', callId: 'edit-config' };
    await advance(request, 'tool/call', { ...edit, args: { path } });
    await advance(request, 'tool/result', {
      ...edit, text: `Edited ${path}`, change: { path, before: 'export const version = 1;\n', after: 'export const version = 2;\n' },
    });
    // The completed tool row confirms the bundle that includes the edit was rendered.
    const row = exchange.locator('details.codex-direct-tool[data-status="completed"]').filter({ hasText: path });
    await expect(row).toHaveCount(1);
    await expect(summary).toHaveCount(0);
    await advance(request, 'tool/call', { callId: 'test-config', args: { command: 'npm test' } });
    await advance(request, 'tool/result', { callId: 'test-config', text: 'Checks passed' });
    await advance(request, 'assistant/delta', { text: 'The configuration is updated and the checks passed.' });
    await expect(exchange.getByText('The configuration is updated and the checks passed.', { exact: true })).toBeVisible();
    await expect(summary).toHaveCount(0);

    await advance(request, 'finish', { text: finalText, reason });
    const status = exchange.locator('.codex-direct-status');
    await expect(status).toHaveAttribute('data-status', reason === 'completed' ? 'completed' : 'interrupted');
    if (reason === 'completed') {
      await expect(summary).toHaveCount(1);
      await expect(summary.getByText(path, { exact: true })).toBeVisible();
      const reply = exchange.getByText(finalText, { exact: true });
      await expect(reply).toBeVisible();
      expect((await summary.boundingBox()).y).toBeGreaterThan((await reply.boundingBox()).y);
    } else {
      await expect(summary).toHaveCount(0);
    }
  });
}

async function resetHistory(request, count, historyTool = false) {
  expect((await request.post('/__e2e/reset', { data: { count, historyTool } })).ok()).toBe(true);
}

async function revealTool(exchange) {
  const process = exchange.locator('.codex-direct-status button');
  await process.scrollIntoViewIfNeeded();
  await process.click();
  const phase = exchange.locator('details.codex-direct-activity > summary').first();
  await phase.click();
  const tool = exchange.locator('details.codex-direct-tool > summary').first();
  await tool.scrollIntoViewIfNeeded();
  return tool;
}

test('desktop navigation restores drafts, reading anchors and disclosures during SSE', async ({ page, request }) => {
  test.skip(baseline, 'Conversation state restoration was not present on the capture baseline');
  await resetHistory(request, 24, true);
  await openHistory(page, request, 24);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    window.workspaceTransitions = 0;
    Element.prototype.animate = function (...args) {
      if (this.classList.contains('codex-workspace-column')) window.workspaceTransitions++;
      return animate.apply(this, args);
    };
  });
  const motionCount = () => page.evaluate(() => window.workspaceTransitions);
  const sidebar = page.getByRole('complementary', { name: '对话历史' });
  const reference = sidebar.getByText('Reference notes', { exact: true });
  const prompt = 'Keep reviewing the workspace in the background';
  await sendMessage(page, prompt);
  const exchange = turn(page, prompt);
  await expect(exchange).toBeVisible();
  await advance(request, 'assistant/delta', { text: 'Background review started.' });
  await expect(exchange.getByText('Background review started.', { exact: true })).toHaveCount(1);
  const history = turn(page, 'Review checkpoint 22');
  const tool = await revealTool(history);
  await tool.click();
  const row = history.locator('details.codex-direct-tool').first();
  await expect(row).toHaveAttribute('open', '');
  const diagnostic = row.getByText('Historical diagnostic 1', { exact: false });
  await expect(diagnostic).toBeVisible();
  await composer(page).fill('Unsaved transcript follow-up');
  await page.locator('.codex-composer-card input[type="file"]').setInputFiles({
    name: 'review-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('private draft attachment'),
  });
  const attachment = page.locator('.codex-composer-attachments').getByText('review-notes.txt', { exact: true });
  await expect(attachment).toBeVisible();
  const anchor = history.locator('details.codex-direct-tool > summary').first();
  await transcript(page).evaluate((view) => {
    const tool = view.querySelector('details.codex-direct-tool[open] > summary');
    view.scrollTop += tool.getBoundingClientRect().top - view.getBoundingClientRect().top - 28;
  });
  await expect.poll(async () => (await geometry(page)).gap).toBeGreaterThan(300);
  const offset = await offsetInViewport(anchor);

  await reference.click();
  await expect(page).toHaveURL(/#\/t\/reference$/);
  await expect(composer(page)).toHaveValue('');
  await expect(attachment).toHaveCount(0);
  await composer(page).fill('Separate reference draft');
  expect(await motionCount()).toBe(1);
  const referenceTranscript = await transcript(page).elementHandle();
  await advance(request, 'assistant/delta', { text: '\n\n' + longDelta('Background review') });
  await expect(composer(page)).toHaveValue('Separate reference draft');
  expect(await referenceTranscript.evaluate((node) => node.isConnected)).toBe(true);
  expect(await motionCount()).toBe(1);

  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page).toHaveURL(/#\/t\/transcript$/);
  await expect(composer(page)).toHaveValue('Unsaved transcript follow-up');
  await expect(attachment).toBeVisible();
  await expect(row).toHaveAttribute('open', '');
  await expect(exchange.getByText('Background review 20.', { exact: true })).toHaveCount(1);
  await stableAnchor(anchor, offset, 8);
  expect(await motionCount()).toBe(2);

  const settledTranscript = await transcript(page).elementHandle();
  const openCommand = await row.elementHandle();
  await advance(request, 'finish', { text: finalText });
  await expect(exchange.getByText(finalText, { exact: true })).toHaveCount(1);
  await expect(exchange.locator('.codex-direct-status')).toHaveAttribute('data-status', 'completed');
  await stableAnchor(anchor, offset, 8);
  expect(await settledTranscript.evaluate((node) => node.isConnected)).toBe(true);
  expect(await openCommand.evaluate((node) => node.isConnected && node.open)).toBe(true);
  expect(await motionCount()).toBe(2);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '前进', exact: true }).click();
  await expect(composer(page)).toHaveValue('Separate reference draft');
  expect(await motionCount()).toBe(2);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(composer(page)).toHaveValue('Unsaved transcript follow-up');
  await stableAnchor(anchor, offset, 8);
});

test('a follow-up accepted after switching threads clears only the sent draft', async ({ page, request }) => {
  test.skip(baseline, 'Conversation state restoration was not present on the capture baseline');
  await openHistory(page, request);
  const accepted = Promise.withResolvers();
  const releaseResponse = Promise.withResolvers();
  let submissions = 0;
  await page.route('**/v1/sessions/transcript/turns', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    submissions++;
    const response = await route.fetch();
    accepted.resolve(response.ok());
    await releaseResponse.promise;
    await route.fulfill({ response });
  });
  const sidebar = page.getByRole('complementary', { name: '对话历史' });
  const send = page.getByRole('button', { name: '发送消息', exact: true });
  const prompt = 'Accept this follow-up without keeping a duplicate draft';
  try {
    await composer(page).fill(prompt);
    await send.click();
    expect(await accepted.promise).toBe(true);
    await sidebar.getByText('Reference notes', { exact: true }).click();
    await expect(composer(page)).toHaveValue('');
    await composer(page).fill('A draft in the other thread');
    await expect(send).toBeEnabled();
    const response = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname === '/v1/sessions/transcript/turns');
    releaseResponse.resolve();
    expect((await response).ok()).toBe(true);
    await expect(composer(page)).toHaveValue('A draft in the other thread');

    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(turn(page, prompt)).toHaveCount(1);
    await expect(composer(page)).toHaveValue('');
    expect(submissions).toBe(1);
    await page.getByRole('button', { name: '前进', exact: true }).click();
    await expect(composer(page)).toHaveValue('A draft in the other thread');
  } finally {
    releaseResponse.resolve();
  }
});

test('B — keyboard navigation and disclosure anchoring in 24 historical turns', async ({ page, request }) => {
  await resetHistory(request, 24, true);
  await openHistory(page, request, 24);
  const view = transcript(page);
  // Modern transcript is keyboard-focusable. The baseline did not expose this contract.
  if (assertions) await view.focus();
  else await view.click({ position: { x: 24, y: 60 } });
  await page.keyboard.press('PageUp');
  if (assertions) await expect.poll(async () => (await geometry(page)).gap).toBeGreaterThan(300);
  else if ((await geometry(page)).gap < 300) await scrollToRead(page);
  const exchange = turn(page, 'Review checkpoint 22');
  const process = exchange.locator('.codex-direct-status button');
  await process.scrollIntoViewIfNeeded();
  const processOffset = await offsetInViewport(process);
  await process.click();
  if (assertions) await stableAnchor(process, processOffset);
  const phase = exchange.locator('details.codex-direct-activity > summary').first();
  await phase.click();
  const tool = exchange.locator('details.codex-direct-tool > summary').first();
  await tool.scrollIntoViewIfNeeded();
  const toolOffset = await offsetInViewport(tool);
  await tool.click();
  await expect(exchange.locator('pre[aria-label="工具输出"]')).toBeVisible();
  if (assertions) {
    await stableAnchor(tool, toolOffset);
    await expect(latest(page)).toHaveAttribute('data-visible', 'true');
  }
  await screenshot(page, 'B-keyboard-historical-disclosure');
  await tool.click();
  if (assertions) {
    await stableAnchor(tool, toolOffset);
    await latest(page).click();
    await atTail(page);
  }
});

async function wheelOver(page, locator, delta) {
  const target = await locator.boundingBox();
  const clip = await transcript(page).boundingBox();
  if (!target || !clip) throw new Error('Nested output is not visible');
  const top = Math.max(target.y, clip.y);
  const bottom = Math.min(target.y + target.height, clip.y + clip.height);
  expect(bottom - top, 'Visible nested wheel target').toBeGreaterThan(8);
  await page.mouse.move(target.x + target.width / 2, (top + bottom) / 2);
  await page.mouse.wheel(0, delta);
}

test('C — nested wheel input chains only at scroll boundaries', async ({ page, request }) => {
  await resetHistory(request, 24, true);
  await openHistory(page, request, 24);
  const exchange = turn(page, 'Review checkpoint 22');
  await (await revealTool(exchange)).click();
  const output = exchange.locator('pre[aria-label="工具输出"]');
  await expect(output).toBeVisible();
  await output.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await screenshot(page, 'C-nested-tool-wheel');
  if (!assertions) return;

  const outputTop = () => output.evaluate((el) => el.scrollTop);
  const nestedMax = await output.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(nestedMax).toBeGreaterThan(180);
  expect((await geometry(page)).gap).toBeGreaterThan(150);
  for (const delta of [7, 120]) {
    const previousOuter = (await geometry(page)).top;
    const previousInner = await outputTop();
    await wheelOver(page, output, delta);
    await expect.poll(outputTop).toBeGreaterThan(previousInner);
    expect(Math.abs((await geometry(page)).top - previousOuter)).toBeLessThanOrEqual(2);
  }
  for (const direction of [1, -1]) {
    const edge = direction > 0 ? nestedMax : 0;
    await output.evaluate((el, top) => { el.scrollTop = top; }, edge);
    for (const delta of [7, 120]) {
      const previous = (await geometry(page)).top;
      await wheelOver(page, output, delta * direction);
      await expect.poll(async () => ((await geometry(page)).top - previous) * direction).toBeGreaterThan(0);
      expect(Math.abs((await outputTop()) - edge)).toBeLessThanOrEqual(2);
    }
  }
});

const goTo = async (page, id) => page.evaluate((sessionId) => { location.hash = `/t/${sessionId}`; }, id);
const messagesPath = (response, status) => new URL(response.url()).pathname === '/v1/sessions/transcript/messages' && response.status() === status;

async function gate(request, label, status) {
  expect((await request.post('/__e2e/gate', { data: { label, status } })).ok()).toBe(true);
}
async function held(request, label) {
  await expect.poll(async () => (await (await request.get(`/__e2e/gate?label=${label}`)).json()).waiting).toBe(true);
}
async function release(request, label) {
  expect((await request.post('/__e2e/release', { data: { label } })).ok()).toBe(true);
}

for (const legacy of [false, true]) {
  test(`D — final reply stays mounted while history is delayed (${legacy ? 'older backend' : 'cursor handoff'})`, async ({ page, request }) => {
    test.skip(baseline, 'Completion handoff is a new regression assertion');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const prompt = 'Keep the transcript mounted as the response finishes';
    await begin(page, request, prompt);
    const exchange = turn(page, prompt);
    const reply = exchange.locator('.codex-direct-prose');
    const streamed = 'The streamed answer never leaves the transcript.';
    await advance(request, 'assistant/delta', { text: streamed });
    await expect(reply).toHaveText(streamed);
    await expect(reply).toHaveCSS('animation-name', 'codex-content-reveal');
    await composer(page).focus();
    await composer(page).fill('Draft to keep while the response finishes');
    const original = await reply.elementHandle();
    const transcriptNode = await transcript(page).elementHandle();
    const composerNode = await composer(page).elementHandle();
    let navigations = 0;
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++; });

    // Force the end event, including finalized text that differs from the
    // last delta, to reach the browser before the history request can return.
    const label = 'completion-history';
    await gate(request, label, 200);
    await advance(request, 'finish', { text: finalText, legacy });
    await held(request, label);
    await expect(reply).toHaveText(finalText);
    await expect(reply.locator('.a2a-stream-cursor')).toHaveCount(0);
    await expect(exchange.locator('.codex-direct-status')).toHaveAttribute('data-status', 'completed');
    expect(await original.evaluate((node) => node.isConnected && !node.closest('[hidden]'))).toBe(true);
    expect(await transcriptNode.evaluate((node) => node.isConnected)).toBe(true);
    expect(await composerNode.evaluate((node) => node === document.activeElement)).toBe(true);
    await expect(composer(page)).toHaveValue('Draft to keep while the response finishes');

    const response = page.waitForResponse((res) => messagesPath(res, 200));
    await release(request, label);
    await (await response).finished();
    await expect(reply).toHaveCount(1);
    await expect(reply).toHaveText(finalText);
    expect(await original.evaluate((node) => node.isConnected)).toBe(true);
    expect(navigations).toBe(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(reply).toHaveCSS('animation-name', 'none');
  });
}

test('D — SSE bursts cannot let delayed or failed old REST overwrite a fresh session', async ({ page, request }) => {
  const prompt = 'Keep this turn while old REST requests finish';
  // Chromium can coalesce concurrent GETs for the same URL before observing
  // `Cache-Control: no-store`. Make the two independent HTTP requests explicit.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await begin(page, request, prompt);
  const reads = async () => (await (await request.get('/__e2e/reads')).json()).count;
  const beforeBurst = await reads();
  await gate(request, 'stale', 200);
  await advance(request, 'burst');
  await held(request, 'stale');
  if (assertions) expect(await reads()).toBeLessThanOrEqual(beforeBurst + 2);

  const reference = transcript(page).getByText('Reference session response.', { exact: true });
  const fresh = turn(page, prompt).getByText(finalText, { exact: true });
  await goTo(page, 'reference');
  await expect(reference).toBeVisible();
  await gate(request, 'fail', 503);
  await goTo(page, 'transcript');
  await held(request, 'fail');
  await advance(request, 'burst');
  await goTo(page, 'reference');
  await expect(reference).toBeVisible();
  await advance(request, 'finish', { text: finalText, reason: 'completed' });
  await goTo(page, 'transcript');
  await expect(fresh).toBeVisible();

  // The fresh snapshot lands first. Deliver the old failure and then the older successful snapshot.
  for (const [label, status] of [['fail', 503], ['stale', 200]]) {
    const response = page.waitForResponse((res) => messagesPath(res, status));
    await release(request, label);
    await (await response).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (assertions) {
      await expect(fresh).toHaveCount(1);
      await expect(reference).toHaveCount(0);
      await expect(exchanges(page)).toHaveCount(9);
    }
  }
  await screenshot(page, 'D-out-of-order-rest');
});

test('E — 100 turns at desktop and narrow widths keep the composer reachable', async ({ page, request }) => {
  await resetHistory(request, 100);
  await openHistory(page, request, 100);
  const first = transcript(page).getByText('Review checkpoint 1', { exact: true });
  const last = transcript(page).getByText('Review checkpoint 100', { exact: true });
  await expect(last).toBeInViewport();
  await screenshot(page, 'E-100-turns-desktop');
  await page.setViewportSize({ width: 780, height: 840 });
  if (assertions) {
    await atTail(page);
    const viewBox = await transcript(page).boundingBox();
    const dockBox = await page.locator('.codex-thread-composer-dock').boundingBox();
    expect(viewBox.y + viewBox.height).toBeLessThanOrEqual(dockBox.y + 1);
    await expect(composer(page)).toBeInViewport();
    await transcript(page).focus();
    await page.keyboard.press('Home');
    await expect(first).toBeInViewport();
    await page.keyboard.press('End');
    await atTail(page);
    await expect(last).toBeInViewport();
    await page.keyboard.press('PageUp');
    await expect.poll(async () => (await geometry(page)).gap).toBeGreaterThan(150);
    await latest(page).click();
    await atTail(page);
    await expect(last).toBeInViewport();
  }
  await screenshot(page, 'E-100-turns-narrow');
});

test('B/E — reading an open historical command in a 100-turn thread survives live growth', async ({ page, request }) => {
  test.skip(baseline, 'New scroll/DOM identity regression; no baseline screenshot required.');
  await resetHistory(request, 100, true);
  await openHistory(page, request, 100);
  const prompt = 'Inspect the next workspace checkpoint while I read the earlier output';
  await sendMessage(page, prompt);
  await expect(exchanges(page)).toHaveCount(101);
  await atTail(page);
  const history = turn(page, 'Review checkpoint 98');
  const title = await revealTool(history);
  await title.click();
  const openOutput = history.locator('pre[aria-label="工具输出"]');
  await expect(openOutput).toBeVisible();
  const anchoredY = await offsetInViewport(title);
  const original = await openOutput.elementHandle();
  await advance(request, 'reasoning/delta', { text: 'Reading the workspace checkpoint.' });
  await advance(request, 'assistant/delta', { text: longDelta('A new checkpoint') });
  await advance(request, 'burst');
  await expect(turn(page, prompt).getByText('A new checkpoint 20.', { exact: true })).toBeAttached();
  await stableAnchor(title, anchoredY);
  await expect(openOutput).toBeVisible();
  expect(await original.evaluate((node) => node.isConnected)).toBe(true);
  await original.dispose();
  await expect(latest(page)).toHaveAttribute('data-visible', 'true');
  await advance(request, 'finish', { text: finalText, reason: 'completed' });
  await expect(turn(page, prompt).getByText(finalText, { exact: true })).toHaveCount(1);
  await stableAnchor(title, anchoredY);
  await expect(openOutput).toBeVisible();
});
