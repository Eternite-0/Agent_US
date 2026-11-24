import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveBackendClient } from '../src/api/client.ts';

const client = () => new LiveBackendClient({ baseUrl: 'http://127.0.0.1:8787', token: '' });

test('legacy backends cannot receive a destructive request through the new controls', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push([init.method, new URL(url).pathname]);
    return Response.json({ message: 'Not found' }, { status: 404 });
  });
  const api = client();
  assert.equal(api.supportsSafeDeletion, false);
  const [project] = await api.listProjects();
  assert.equal(api.supportsSafeDeletion, false);
  await assert.rejects(api.deleteProject(project));
  await assert.rejects(api.deleteArchivedTask('old-chat'));
  assert.deepEqual(requests, [['GET', '/v1/workspace/project']]);
});

test('a compatible backend receives versioned project deletes and archive-only chat deletes', async (t) => {
  const requests = [];
  const project = { id: 'workspace', version: 4, workspaceRoot: '/workspace', name: 'workspace' };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: new URL(url), method: init.method, body: init.body && JSON.parse(init.body) });
    return Response.json(init.method === 'GET' ? { project } : { deleted: true });
  });
  const api = client();
  assert.deepEqual(await api.listProjects(), [project]);
  assert.equal(api.supportsSafeDeletion, true);
  await api.deleteProject(project);
  await api.deleteArchivedTask('archived-chat');
  assert.equal(requests[1].method, 'DELETE');
  assert.equal(requests[1].url.pathname, '/v1/workspace/project');
  assert.deepEqual(requests[1].body, { workspaceRoot: '/workspace', version: 4 });
  assert.equal(requests[2].method, 'DELETE');
  assert.equal(requests[2].url.pathname, '/v1/sessions/archived-chat');
  assert.equal(requests[2].url.searchParams.get('archived'), 'true');
});
