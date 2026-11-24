import { expect, test } from '@playwright/test';
import { sendMessage, transcript } from '../e2e/thread.mjs';

test('tool approvals use the selected mode, persist it, and ask only for the non-reviewable command', async ({ page, request }) => {
  const created = await request.post('/v1/sessions', { data: { title: 'Permission menu check', permissionMode: 'approval' } });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  await page.goto(`/#/t/${id}`);

  const manual = page.getByRole('button', { name: '请我批准', exact: true });
  const automatic = page.getByRole('button', { name: '替我审查', exact: true });
  await expect(manual).toBeEnabled();
  await manual.click();
  const menu = page.locator('.codex-perm-popover');
  await expect(menu.getByRole('button', { name: /^请我批准/ })).toBeVisible();
  await expect(menu.getByRole('button', { name: /^完全访问权限/ })).toBeVisible();
  await menu.getByRole('button', { name: /^替我审查/ }).click();
  await expect(automatic).toBeEnabled();
  await page.reload();
  await expect(automatic).toBeEnabled();
  const saved = await request.get(`/v1/sessions/${id}`);
  expect(await saved.json()).toMatchObject({ permissionMode: 'auto-review' });

  // The real Direct runtime runs pwd immediately; an arbitrary Node script
  // must wait for approval even though it follows an auto-reviewed tool call.
  await sendMessage(page, 'Runtime permission menu check');
  const approval = page.locator('.codex-approval-card');
  await expect(approval).toContainText('node run-second.mjs');
  const queue = await request.get(`/v1/approvals?sessionId=${id}&status=pending`);
  const { items: pending } = await queue.json();
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ callId: 'permission-probe-1' });
  const timeline = await request.get(`/v1/sessions/${id}/events`);
  const { items: events } = await timeline.json();
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'tool/approval_reviewed', data: expect.objectContaining({
      callId: 'permission-probe-0', decision: 'allow', source: 'local_policy',
    }) }),
    expect.objectContaining({ type: 'tool/result', data: expect.objectContaining({ callId: 'permission-probe-0' }) }),
  ]));
  await approval.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(transcript(page).getByText('PERMISSION CHECK COMPLETE', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`/#/t/${id}`);
});
