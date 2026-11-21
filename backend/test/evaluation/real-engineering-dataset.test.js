import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createRealEngineeringDataset, REAL_ENGINEERING_DATASET } from '../../src/evaluation/dataset.js';
import { createFixtureWorkspace, removeFixtureWorkspace } from '../../src/evaluation/fixtures.js';

const evidenceFor = (task) => ({
  output: {
    changedFiles: task.metadata.acceptanceCriteria.requiredChangedFiles,
    testCommand: task.metadata.acceptanceCriteria.testCommand,
    testExitCode: 0,
    independentVerdict: true,
  },
});

async function withTask(task, fn) {
  const workspaceRoot = await createFixtureWorkspace(task);
  try { return await fn(workspaceRoot); } finally { await removeFixtureWorkspace(workspaceRoot); }
}

test('real engineering dataset has ten stable task-specific definitions', () => {
  assert.equal(REAL_ENGINEERING_DATASET.length, 10);
  assert.deepEqual(REAL_ENGINEERING_DATASET.map((task) => task.id), [
    'real-multi-file-feature-01',
    'real-bug-fix-01',
    'real-codebase-analysis-01',
    'real-refactor-01',
    'real-tests-01',
    'real-api-compat-01',
    'real-security-audit-01',
    'real-data-processing-01',
    'real-recovery-01',
    'real-multi-agent-01',
  ]);
  for (const task of REAL_ENGINEERING_DATASET) {
    assert.equal(task.metadata.synthetic, true);
    assert.equal(task.metadata.externalNetwork, false);
    assert.equal(task.metadata.requiresGitDiff, true);
    assert.ok(task.fixture.files['README.md']);
    assert.ok(task.metadata.acceptanceCriteria.testFiles.length > 0);
    assert.ok(task.metadata.acceptanceCriteria.requiredChangedFiles.length > 0);
    assert.equal(typeof task.judge, 'function');
  }
});

test('task-specific judges reject an untouched workspace and incomplete evidence', async () => {
  const task = createRealEngineeringDataset()[0];
  await withTask(task, async (workspaceRoot) => {
    const judgment = await task.judge({ task, output: evidenceFor(task), context: { workspaceRoot } });
    assert.equal(judgment.passed, false);
    assert.equal(judgment.deterministic, true);
    assert.equal(judgment.evidence.checks.changedFiles, false);
  });
});

test('feature judge requires the requested implementation and documentation, not only a diff', async () => {
  const task = createRealEngineeringDataset()[0];
  await withTask(task, async (workspaceRoot) => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(`${workspaceRoot}/src/catalog.js`, "export function formatProduct(product) { return `${product.name}: ${product.priceCents}`; }\nexport function summarizeCatalog(items) { return { count: items.length, totalCents: items.reduce((sum, item) => sum + item.priceCents, 0), labels: items.map((item) => item.name) }; }\n");
    await fs.writeFile(`${workspaceRoot}/README.md`, '# Catalog fixture\n\nsummarizeCatalog returns count and totalCents.\n');
    const judgment = await task.judge({ task, output: evidenceFor(task), context: { workspaceRoot } });
    assert.equal(judgment.passed, true);
    assert.equal(judgment.evidence.checks.documentation, true);
  });
});

test('all ten judges accept their deterministic gold solutions and reject altered evidence', async () => {
  const tasks = createRealEngineeringDataset();
  const solutions = {
    'real-multi-file-feature-01': {
      'src/catalog.js': "export function formatProduct(product) { return `${product.name}: ${product.priceCents}`; }\nexport function summarizeCatalog(items) { return { count: items.length, totalCents: items.reduce((sum, item) => sum + item.priceCents, 0), labels: items.map((item) => item.name) }; }\n",
      'README.md': '# Catalog\n\nsummarizeCatalog totalCents feature.\n',
    },
    'real-bug-fix-01': { 'src/slug.js': 'export function slugify(value) { return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }\n' },
    'real-codebase-analysis-01': { 'ANALYSIS.md': 'src/main.js imports src/config.js and src/service.js. src/service.js depends on src/store.js. Evidence: source imports show why the entry point reaches the store.\n' },
    'real-refactor-01': {
      'src/normalize.js': 'export function normalizeUser(raw) { return { name: String(raw.name).trim(), email: String(raw.email).trim().toLowerCase() }; }\n',
      'src/parser.js': "import { normalizeUser } from './normalize.js';\nexport function parseUser(raw) { return normalizeUser(raw); }\n",
      'src/formatter.js': "import { normalizeUser } from './normalize.js';\nexport function formatUser(user) { const value = normalizeUser(user); return `${value.name} <${value.email}>`; }\n",
    },
    'real-tests-01': { 'test/cache.edge.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { getOrDefault } from '../src/cache.js';\ntest('edge values', () => { assert.equal(getOrDefault({}, 'missing', undefined), undefined); assert.equal(getOrDefault({ value: null }, 'value', 0), 0); assert.equal(getOrDefault({ value: 0 }, 'value', 3), 3); });\n" },
    'real-api-compat-01': { 'src/profile-api.js': "export function getProfile() { return { id: 'user-1', name: 'Ada', status: 'active' }; }\n" },
    'real-security-audit-01': {
      'src/safe-input.js': 'export function isSafeRedirect(value) { return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !/[\\r\\n]/.test(value); }\n',
      'SECURITY-AUDIT.md': 'Finding: //evil.example is an open redirect and CRLF enables header injection. Reproduction evidence is covered by the test. Remediation rejects both inputs.\n',
    },
    'real-data-processing-01': {
      'src/sales.js': 'export function summarizeSales(rows) { const groups = new Map(); for (const row of rows) { const item = groups.get(row.region) ?? { region: row.region, orderCount: 0, totalCents: 0 }; item.orderCount++; item.totalCents += row.amountCents; groups.set(row.region, item); } const byRegion = [...groups.values()].sort((a, b) => a.region.localeCompare(b.region)); return { orderCount: rows.length, totalCents: rows.reduce((sum, row) => sum + row.amountCents, 0), byRegion }; }\n',
      'scripts/process.js': "import { readFile, mkdir, writeFile } from 'node:fs/promises';\nimport { summarizeSales } from '../src/sales.js';\nconst rows = JSON.parse(await readFile('data/sales.json', 'utf8'));\nawait mkdir('output', { recursive: true });\nawait writeFile('output/summary.json', JSON.stringify(summarizeSales(rows), null, 2) + '\\n');\n",
    },
    'real-recovery-01': {
      'src/recovery.js': `import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
async function state(root) { try { return JSON.parse(await readFile(join(root, 'state.json'), 'utf8')); } catch { return { completed: [] }; } }
async function step(root, name) { const current = await state(root); if (current.completed.includes(name)) return current; await appendFile(join(root, 'effects.log'), name + '\\n'); const next = { completed: [...current.completed, name] }; await writeFile(join(root, 'state.json'), JSON.stringify(next)); return next; }
export async function run(root, { interruptAfter } = {}) { await mkdir(root, { recursive: true }); await step(root, 'prepare'); if (interruptAfter === 'prepare') throw new Error('INTERRUPTED'); await step(root, 'publish'); }
export async function resume(root) { await step(root, 'prepare'); await step(root, 'publish'); }
`,
    },
    'real-multi-agent-01': {
      'src/left.js': 'export function leftFeature(value) { return `left:${value}`; }\n',
      'src/right.js': 'export function rightFeature(value) { return `right:${value}`; }\n',
      'artifacts/manifest.json': '',
      'REVIEW.md': 'Review src/left.js and src/right.js: approved.\n',
    },
  };
  for (const task of tasks) {
    await withTask(task, async (workspaceRoot) => {
      const fs = await import('node:fs/promises');
      for (const [relativePath, content] of Object.entries(solutions[task.id])) {
        if (relativePath === 'artifacts/manifest.json') continue;
        await fs.mkdir(`${workspaceRoot}/${relativePath.split('/').slice(0, -1).join('/')}`, { recursive: true }).catch(() => {});
        await fs.writeFile(`${workspaceRoot}/${relativePath}`, content);
      }
      if (task.id === 'real-multi-agent-01') {
        const { createHash } = await import('node:crypto');
        const left = await fs.readFile(`${workspaceRoot}/src/left.js`, 'utf8');
        const right = await fs.readFile(`${workspaceRoot}/src/right.js`, 'utf8');
        await fs.mkdir(`${workspaceRoot}/artifacts`, { recursive: true });
        await fs.writeFile(`${workspaceRoot}/artifacts/manifest.json`, JSON.stringify({ artifacts: [
          { path: 'src/left.js', sha256: createHash('sha256').update(left).digest('hex') },
          { path: 'src/right.js', sha256: createHash('sha256').update(right).digest('hex') },
        ] }));
      }
      if (task.id === 'real-data-processing-01') {
        await fs.mkdir(`${workspaceRoot}/output`, { recursive: true });
        const { summarizeSales } = await import(pathToFileURL(join(workspaceRoot, 'src', 'sales.js')).href);
        const rows = JSON.parse(await fs.readFile(`${workspaceRoot}/data/sales.json`, 'utf8'));
        await fs.writeFile(`${workspaceRoot}/output/summary.json`, JSON.stringify(summarizeSales(rows), null, 2));
      }
      const taskEvidence = evidenceFor(task);
      if (task.id === 'real-multi-agent-01') taskEvidence.output.changedFiles = [...taskEvidence.output.changedFiles, 'artifacts/manifest.json'];
      const judgment = await task.judge({ task, output: taskEvidence, context: { workspaceRoot } });
      assert.equal(judgment.passed, true, `${task.id}: ${JSON.stringify(judgment.evidence.checks)}`);
      const altered = await task.judge({ task, output: { output: { ...evidenceFor(task).output, testExitCode: 1 } }, context: { workspaceRoot } });
      assert.equal(altered.passed, false, `${task.id} accepted altered evidence`);
    });
  }
});