import { expect, test } from '@playwright/test';
import { screenshot, transcript } from '../e2e/thread.mjs';
import { FIXED_TIME } from '../e2e/sse-server.mjs';

const markdown = [
  '# Workspace audit', '',
  'The migration maintains **backwards compatibility** and saves the result in `src/config.ts`.', '',
  '> Keep the default small, and only increase it after measurement.', '',
  '| Check | Result |', '| --- | --- |', '| TypeScript | Passed |', '| Browser | Verified |', '',
  '```typescript', 'export const version = 2;', '```', '',
  '![Sample output chart](/visual-thread-image.svg)', '',
  'Review the patch in the workspace before delivery.',
].join('\n').replace('/visual-thread-image.svg', 'http://127.0.0.1:4183/visual-thread-image.svg');
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
const sessions = {
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

test('home and Markdown hierarchy in light and dark themes; file diff in Inspector', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.codex-home .codex-composer-card')).toBeVisible();
  await screenshot(page, 'visual-home-light');
  await navigate(page, '/t/markdown-visual');
  await expect(transcript(page).getByRole('heading', { name: 'Workspace audit' })).toBeVisible();
  await expect(transcript(page).getByRole('table')).toBeVisible();
  await expect(transcript(page).getByRole('img', { name: 'Sample output chart' })).toBeVisible();
  await screenshot(page, 'visual-markdown-light');
  await transcript(page).locator('.codex-file-card-actions').getByRole('button', { name: '查看变更' }).click();
  await expect(page.locator('.codex-drawer[data-open="true"]')).toBeVisible();
  await screenshot(page, 'visual-file-diff-light');
  await page.getByRole('button', { name: '关闭右侧面板', exact: true }).click();
  await navigate(page, '/settings/appearance');
  await page.locator('select').filter({ has: page.locator('option[value=dark]') }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await navigate(page, '/t/markdown-visual');
  await expect(transcript(page).getByRole('heading', { name: 'Workspace audit' })).toBeVisible();
  await screenshot(page, 'visual-markdown-dark');
  await navigate(page, '/');
  await expect(page.locator('.codex-home .codex-composer-card')).toBeVisible();
  await screenshot(page, 'visual-home-dark');
});

test('approval and Swarm execution with Reviewer evidence', async ({ page }) => {
  await page.goto('/#/t/approval-visual');
  await expect(transcript(page).locator('.codex-approval-card')).toBeVisible();
  await screenshot(page, 'visual-pending-approval');
  await navigate(page, '/t/swarm-visual');
  const card = page.locator('.swarm-thread-card');
  await expect(card).toBeVisible();
  await screenshot(page, 'visual-swarm');
  await card.click();
  const result = page.locator('details.autonomous-verdict');
  await expect(result).toBeVisible();
  await result.locator(':scope > summary').click();
  await expect(page.getByText('Patch and test output agree.', { exact: true }).first()).toBeVisible();
  await screenshot(page, 'visual-swarm-reviewer');
});
