import { expect, test } from '@playwright/test';
import { composer, transcript } from '../e2e/thread.mjs';

test('Git initialization and review use the current session directory, and review streams actual evidence', async ({ page, request }) => {
  const { workspaceRoot } = await (await request.get('/v1/_e2e/review-workspace')).json();
  const created = await request.post('/v1/sessions', { data: { title: 'Git review regression', workspaceRoot, permissionMode: 'full-access' } });
  expect(created.ok()).toBe(true);
  const session = await created.json();
  await page.goto(`/#/t/${session.id}`);
  await expect(page.getByRole('button', { name: '完全访问', exact: true })).toBeEnabled();
  const initButton = page.getByRole('button', { name: '创建 Git 存储库', exact: true });
  await expect(initButton).toBeEnabled();
  const init = page.waitForResponse(res => new URL(res.url()).pathname === '/v1/git/init');
  await initButton.click();
  const initialized = await init;
  expect(initialized.ok()).toBe(true);
  expect(await initialized.json()).toMatchObject({ available: true, branch: 'main', workspaceRoot: session.workspaceRoot });
  await expect(page.getByRole('button', { name: /^当前 Git 分支：main/ })).toBeVisible();

  const input = composer(page);
  await input.fill('/review');
  await input.press('Enter');
  const dialog = page.getByRole('dialog', { name: '代码审查', exact: true });
  await expect(dialog).toBeVisible();
  const review = page.waitForResponse(res => new URL(res.url()).pathname === '/v1/git/review');
  await dialog.getByRole('button', { name: '开始代码审查', exact: true }).click();
  const started = await review;
  expect(started.ok()).toBe(true);
  const { session: reviewSession } = await started.json();
  expect(reviewSession.id).not.toBe(session.id);
  expect(reviewSession).toMatchObject({ workspaceRoot: session.workspaceRoot, permissionMode: 'read-only' });
  await expect(page).toHaveURL(`/#/t/${reviewSession.id}`);
  await expect(page.getByRole('button', { name: '只读', exact: true })).toBeDisabled();
  await expect(transcript(page).getByText('REVIEW EVIDENCE RECEIVED', { exact: true })).toBeVisible();
  const original = await (await request.get(`/v1/sessions/${session.id}`)).json();
  expect(original.permissionMode).toEqual('full-access');
});

test('an invalid workspace is rejected visibly and does not replace the saved directory', async ({ page, request }) => {
  const { workspaceRoot } = await (await request.get('/v1/workspace')).json();
  await page.goto('/#/settings/general');
  const path = page.getByRole('textbox', { name: '新会话默认工作区' });
  await expect(path).toHaveValue(workspaceRoot);
  await path.fill('folder-name-without-an-absolute-path');
  await page.getByRole('button', { name: '应用目录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('绝对工作区目录');
  await expect(path).toHaveValue('folder-name-without-an-absolute-path');
  expect((await (await request.get('/v1/workspace')).json()).workspaceRoot).toEqual(workspaceRoot);
});
