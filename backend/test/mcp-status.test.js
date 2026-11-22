import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { registerRuntimeRoutes } from '../src/routes/runtime-routes.js';
import { McpLifecycleManager } from '../src/tools/mcp-lifecycle.js';

const workspace = join(tmpdir(), 'agent-us-mcp-default');
const sessionWorkspace = join(tmpdir(), 'agent-us-mcp-session');

test('MCP status reports only the requested workspace without discovery or internal errors', async (t) => {
  const manager = new McpLifecycleManager();
  const primary = { server: 'files', status: 'ready', toolCount: 2, lastCheckedAt: 20 };
  const secondary = { server: 'notes', status: 'degraded', toolCount: 0, lastCheckedAt: 10 };
  manager.health.set(`${workspace}::files`, { ...primary, lastError: 'internal diagnostics' });
  manager.health.set(`${sessionWorkspace}::notes`, { ...secondary, lastError: 'internal diagnostics' });
  manager.discoverTools = () => assert.fail('Reading MCP status must not initiate discovery');
  const app = Fastify();
  t.after(() => app.close());
  registerRuntimeRoutes(app, { directAgent: {
    mcpManager: manager,
    getWorkspaceRoot: () => workspace,
    getSession: (id) => {
      assert.equal(id, 'test-session');
      return { workspaceRoot: sessionWorkspace };
    },
  } });

  const primaryResponse = await app.inject('/v1/runtime/mcp/status');
  assert.equal(primaryResponse.statusCode, 200);
  assert.deepEqual(primaryResponse.json(), { items: [primary] });
  const sessionResponse = await app.inject('/v1/runtime/mcp/status?sessionId=test-session');
  assert.equal(sessionResponse.statusCode, 200);
  assert.deepEqual(sessionResponse.json(), { items: [secondary] });
  const invalidResponse = await app.inject('/v1/runtime/mcp/status?sessionId=');
  assert.equal(invalidResponse.statusCode, 400);
});
