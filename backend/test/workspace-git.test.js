import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from '../src/api.js';
import { AccountPool } from '../src/pool.js';
import { Store } from '../src/store.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { collectReviewEvidence, getGitStatusFor, initWorkspaceGit, runGit, validateWorkspace } from '../src/routes/workspace-git.js';
import { rmDirSafe } from './fixtures.js';

async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'agent-us-workspace-git-')));
  const workspace = join(temp, 'workspace with spaces');
  const other = join(temp, 'other');
  await Promise.all([mkdir(workspace), mkdir(other)]);
  t.after(() => rmDirSafe(temp));
  return { temp, workspace, other };
}

async function testApi(t, temp, workspace) {
  const store = new Store(join(temp, 'test.sqlite'));
  const providers = { models: [], list: () => [] };
  const pool = new AccountPool(store, { root: temp, legacyProviders: providers });
  const directAgent = new DirectAgentRuntime(store, pool, { defaultWorkspace: workspace, dataRoot: temp });
  const token = randomUUID();
  const app = api(store, token, providers, { pool, directAgent });
  t.after(async () => { await app.close(); await directAgent.close(); store.close(); });
  return (method, url, payload, authorized = true) => app.inject({ method, url, payload, headers: authorized ? { authorization: `Bearer ${token}` } : {} });
}

test('Git returns a real negative status, preserves existing repositories, and reports an unborn branch', async (t) => {
  const { workspace } = await fixture(t);
  assert.equal((await getGitStatusFor(workspace)).available, false);
  const git = await initWorkspaceGit(workspace, 'main');
  assert.equal(git.available, true);
  assert.equal(git.branch, 'main');
  assert.deepEqual(git.branches, ['main']);
  assert.equal((await initWorkspaceGit(workspace, 'different')).branch, 'main');
  await assert.rejects(validateWorkspace('folder-name-only'), { code: 'WORKSPACE_PATH_INVALID' });
  await assert.rejects(validateWorkspace(join(workspace, 'missing')), { code: 'WORKSPACE_NOT_FOUND' });
  const file = join(workspace, 'readme.txt');
  await writeFile(file, 'text');
  await assert.rejects(validateWorkspace(file), { code: 'WORKSPACE_NOT_DIRECTORY' });
});

test('review evidence includes staged, unstaged and new file changes, scoped to the workspace', async (t) => {
  const { workspace } = await fixture(t);
  await initWorkspaceGit(workspace, 'main');
  await runGit(workspace, ['config', 'user.name', 'Fixture']);
  await runGit(workspace, ['config', 'user.email', 'fixture@example.invalid']);
  const sub = join(workspace, 'sub');
  await mkdir(sub);
  await writeFile(join(sub, 'code.txt'), 'original\n');
  await writeFile(join(workspace, 'outside.txt'), 'old\n');
  await runGit(workspace, ['add', '.']);
  await runGit(workspace, ['commit', '-qm', 'Base']);
  await runGit(workspace, ['branch', 'review/base']);
  await assert.rejects(collectReviewEvidence(workspace), { code: 'REVIEW_NO_CHANGES' });
  await writeFile(join(sub, 'code.txt'), 'staged\n');
  await runGit(workspace, ['add', 'sub/code.txt']);
  await writeFile(join(sub, 'code.txt'), 'unstaged\n');
  await writeFile(join(sub, 'new file.txt'), 'new content\n');
  await writeFile(join(sub, '.env'), 'excluded data\n');
  await writeFile(join(workspace, 'outside.txt'), 'must not be reviewed\n');
  const text = (result) => Object.values(result.files).map((content) => Buffer.from(content, 'base64').toString()).join('');
  const staged = text(await collectReviewEvidence(sub));
  assert.match(staged, /\+staged[\s\S]*\+unstaged/);
  assert.match(staged, /new file\.txt/);
  assert.doesNotMatch(staged, /outside\.txt|\b\.env\b/);
  const compared = text(await collectReviewEvidence(sub, 'review/base'));
  assert.match(compared, /review\/base[\s\S]*-original[\s\S]*\+unstaged/);
  await assert.rejects(collectReviewEvidence(sub, 'missing'), { code: 'REVIEW_BRANCH_NOT_FOUND' });
  await writeFile(join(sub, '.gitattributes'), 'code.txt filter=review-fixture\n');
  await runGit(workspace, ['config', 'filter.review-fixture.clean', 'exit 1']);
  await runGit(workspace, ['config', 'filter.review-fixture.required', 'true']);
  assert.match(text(await collectReviewEvidence(sub)), /\+unstaged/);
  assert.equal((await getGitStatusFor(sub)).dirty, true);
});

test('REST pins roots and permissions to sessions, rejects stale Git mutations, and launches a read-only review', async (t) => {
  const { temp, workspace, other } = await fixture(t);
  const request = await testApi(t, temp, workspace);
  const created = await request('POST', '/v1/sessions', { permissionMode: 'approval' });
  assert.equal(created.statusCode, 200, created.body);
  const session = created.json();
  const uri = `/v1/sessions/${session.id}`;
  assert.equal((await request('PATCH', uri, { permissionMode: 'not-a-mode' })).json().error.code, 'INVALID_PERMISSION_MODE');
  assert.equal((await request('PATCH', uri, { permissionMode: 'full-access' })).json().permissionMode, 'full-access');
  assert.equal((await request('PUT', '/v1/workspace', { workspaceRoot: join(temp, 'missing') })).json().error.code, 'WORKSPACE_NOT_FOUND');
  assert.equal((await request('GET', '/v1/workspace')).json().workspaceRoot, workspace);
  assert.equal((await request('PUT', '/v1/workspace', { workspaceRoot: other })).json().workspaceRoot, other);
  assert.equal((await request('POST', '/v1/git/init', { expectedWorkspaceRoot: workspace })).json().error.code, 'WORKSPACE_CHANGED');
  assert.equal((await getGitStatusFor(other)).available, false);
  const init = await request('POST', '/v1/git/init', { sessionId: session.id, expectedWorkspaceRoot: workspace });
  assert.equal(init.statusCode, 200, init.body);
  assert.equal(init.json().branch, 'main');
  await writeFile(join(workspace, 'review-me.js'), 'export const example = 1;\n');
  assert.equal((await request('POST', '/v1/git/review', { sessionId: session.id }, false)).statusCode, 401);
  const review = await request('POST', '/v1/git/review', { sessionId: session.id, expectedWorkspaceRoot: workspace });
  assert.equal(review.statusCode, 200, review.body);
  const reviewSession = review.json().session;
  assert.notEqual(reviewSession.id, session.id);
  assert.equal(reviewSession.workspaceRoot, workspace);
  assert.equal(reviewSession.permissionMode, 'read-only');
  assert.deepEqual(reviewSession.toolAllow, ['read_file', 'grep', 'glob']);
  const reviewUri = `/v1/sessions/${reviewSession.id}`;
  assert.equal((await request('PATCH', reviewUri, { permissionMode: 'full-access' })).json().error.code, 'REVIEW_READ_ONLY');
  assert.equal((await request('POST', `${reviewUri}/turns`, { input: 'change it', permissionMode: 'full-access' })).json().error.code, 'REVIEW_READ_ONLY');
  assert.equal((await request('POST', `${reviewUri}/steer`, { input: '/swarm change it' })).json().error.code, 'REVIEW_READ_ONLY');
  const source = (await request('GET', uri)).json();
  assert.equal(source.workspaceRoot, workspace);
  assert.equal(source.permissionMode, 'full-access');
  assert.equal((await request('POST', `${uri}/turns`, { input: 'follow-up', clientTurnId: 'stable' })).json().session.permissionMode, 'full-access');
});
