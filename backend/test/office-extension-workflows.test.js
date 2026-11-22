import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleExtensionHubRequest } from '../../desktop/extension-hub.mjs';
import { discoverMemoryAndSkills } from '../src/agent-context.js';
import { rmDirSafe } from './fixtures.js';

async function request(dataDir, method, url, body) {
  const incoming = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url });
  const response = {
    status: 0,
    value: null,
    writeHead(status) { this.status = status; },
    end(value) { this.value = JSON.parse(value); },
  };
  assert.equal(await handleExtensionHubRequest(incoming, response, dataDir), true);
  assert.equal(response.status, 200);
  return response.value;
}

test('office plugins install usable context instructions and uninstall from runtime discovery', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-office-extensions-'));
  const workspace = join(dataDir, 'workspace');
  mkdirSync(workspace);
  t.after(() => rmDirSafe(dataDir));
  const catalog = await request(dataDir, 'GET', '/api/extensions/catalog');
  const office = catalog.plugins.filter(({ id }) => id.startsWith('office-'));
  assert.deepEqual(office.map(({ name }) => name), ['Documents', 'PDF', 'Spreadsheets', 'Presentations']);
  const expected = ['python-docx', 'reportlab', 'openpyxl', 'python-pptx'];
  for (const [index, plugin] of office.entries()) {
    const installed = await request(dataDir, 'POST', '/api/extensions/plugins/install', { plugin: { id: plugin.id } });
    assert.ok(installed.installedPluginIds.includes(plugin.id));
    const { skillsText } = discoverMemoryAndSkills(workspace, null, { dataRoot: dataDir });
    assert.ok(skillsText.includes(`**${plugin.name}** (installed office workflow)`));
    assert.ok(skillsText.includes(expected[index]));
  }
  for (const plugin of office) {
    await request(dataDir, 'POST', '/api/extensions/plugins/uninstall', { id: plugin.id });
    assert.ok(!discoverMemoryAndSkills(workspace, null, { dataRoot: dataDir }).skillsText.includes(`**${plugin.name}**`));
  }
});
