import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVIDENCE_MANIFEST_SCHEMA_VERSION,
  EVIDENCE_STATUSES,
  formatEvidenceManifestContract,
  normalizeEvidencePath,
  validateEvidenceManifest,
} from './schemas.js';
import { listWorkspaceChangedFiles } from './fixtures.js';
import { estimateTaskBudget } from '../planning/budget-estimator.js';

const CATEGORY_SPECS = Object.freeze([
  ['code-generation-repair', 8, '代码生成与修复'],
  ['unfamiliar-codebase-analysis', 5, '陌生代码库分析'],
  ['multi-file-refactor', 5, '多文件重构'],
  ['network-research-integration', 4, '网络研究与信息整合'],
  ['data-analysis', 3, '数据分析'],
  ['long-task-recovery', 3, '长任务中断恢复'],
  ['multi-agent-collaboration', 2, '多 Agent 协作'],
]);

function taskPayload(category, index) {
  const id = `${category}-${String(index).padStart(2, '0')}`;
  const value = {
    taskId: id,
    category,
    ordinal: index,
    stable: true,
    source: 'agent-us-evaluation-fixture',
  };
  const files = {
    'evaluation/input.json': JSON.stringify({ taskId: id, expected: value }, null, 2),
  };
  if (category === 'unfamiliar-codebase-analysis') files['src/entry.js'] = 'export const dependency = "local-fixture";\n';
  if (category === 'multi-file-refactor') {
    files['src/a.js'] = 'export const a = 1;\n';
    files['src/b.js'] = 'export const b = 2;\n';
  }
  if (category === 'network-research-integration') files['snapshots/source.json'] = JSON.stringify({ sourceId: id, captured: true }, null, 2);
  if (category === 'data-analysis') files['data/rows.json'] = JSON.stringify([{ value: 1 }, { value: 2 }, { value: 3 }]);
  if (category === 'long-task-recovery') files['checkpoint/state.json'] = JSON.stringify({ checkpoint: id, resumable: true }, null, 2);
  if (category === 'multi-agent-collaboration') files['handoff/manifest.json'] = JSON.stringify({ taskId: id, artifactRefs: [`artifact://${id}/result`] }, null, 2);
  return {
    taskId: id,
    id,
    title: `${CATEGORY_SPECS.find(([key]) => key === category)?.[2] ?? category} #${index}`,
    category,
    ordinal: index,
    stable: true,
    difficulty: index % 3 === 0 ? 'medium' : category === 'long-task-recovery' ? 'hard' : 'easy',
    tags: ['benchmark', 'deterministic', category],
    prompt: `Read the local fixture for ${id} and return the exact JSON metadata record for this task. Do not add commentary.`,
    expected: { output: value },
    fixture: { files, output: value },
    metadata: {
      source: 'local-deterministic',
      externalNetwork: false,
      snapshotVersion: '1.0.0',
      acceptance: ['exact_json_output', 'isolated_workspace', 'no_external_network'],
    },
  };
}

export function createBenchmarkDataset() {
  return CATEGORY_SPECS.flatMap(([category, count]) =>
    Array.from({ length: count }, (_, offset) => taskPayload(category, offset + 1)),
  );
}

export const BENCHMARK_DATASET = Object.freeze(createBenchmarkDataset());
export const BENCHMARK_TASK_COUNT = BENCHMARK_DATASET.length;
export const BENCHMARK_CATEGORY_COUNTS = Object.freeze(
  Object.fromEntries(CATEGORY_SPECS.map(([category, count]) => [category, count])),
);

function readFixtureText(workspaceRoot, relativePath) {
  try { return readFileSync(join(workspaceRoot, relativePath), 'utf8'); } catch { return null; }
}

function readFixtureJson(workspaceRoot, relativePath) {
  const text = readFixtureText(workspaceRoot, relativePath);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function runFixtureTests(workspaceRoot, testFiles) {
  try {
    execFileSync(process.execPath, ['--test', ...testFiles], {
      cwd: workspaceRoot,
      stdio: 'ignore',
      timeout: 30_000,
    });
    return 0;
  } catch (error) {
    return Number.isInteger(error?.status) ? error.status : 1;
  }
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function evidenceManifestAccepted(task, output, actualFiles, actualTestExitCode, context = {}) {
  const acceptance = task.metadata.acceptanceCriteria;
  const validation = validateEvidenceManifest(output, {
    taskId: task.id,
    attemptId: context.attemptId ?? output?.attemptId ?? (context.attempt != null ? `attempt-${context.attempt}` : null),
    planVersion: context.planVersion ?? output?.planVersion ?? 1,
    expectedTestCommand: acceptance.testCommand,
    requiredChangedFiles: acceptance.requiredChangedFiles,
    actualChangedFiles: actualFiles,
    actualTestExitCode,
    toolReceipts: context.toolReceipts ?? output?.toolReceipts ?? null,
    workspaceRoot: context.workspaceRoot ?? null,
    artifactVerifier: context.artifactVerifier ?? output?.artifactVerifier ?? null,
    trustedVerdict: context.trustedVerdict ?? output?.trustedVerdict ?? null,
    requireIndependentVerdict: true,
  });
  return validation;
}

function classifyJudgeFailure(specificPassed, actualTestExitCode, validation) {
  if (specificPassed && actualTestExitCode === 0 && validation.valid) return 'none';
  if (!specificPassed || !validation.checks.changedFiles) return 'implementation_failed';
  if (actualTestExitCode !== 0 || !validation.checks.testReceiptVerified) return 'test_failed';
  if (validation.status === EVIDENCE_STATUSES.INCOMPLETE) return 'evidence_incomplete';
  if (!validation.checks.independentVerdict) return 'independent_verdict_failed';
  return 'evidence_invalid';
}

function judgeTask({ task, output, context = {}, taskChecks = () => ({}) }) {
  const workspaceRoot = context.workspaceRoot;
  const acceptance = task.metadata.acceptanceCriteria;
  let actualFiles = listWorkspaceChangedFiles(workspaceRoot);
  const actualTestExitCode = runFixtureTests(workspaceRoot, acceptance.testFiles);
  actualFiles = listWorkspaceChangedFiles(workspaceRoot);
  if (acceptance.requiredChangedFiles.includes('output/summary.json') && existsSync(join(workspaceRoot, 'output/summary.json')) && !actualFiles.includes('output/summary.json')) {
    actualFiles = [...actualFiles, 'output/summary.json'];
  }
  const validation = evidenceManifestAccepted(task, output, actualFiles, actualTestExitCode, context);
  const evidence = validation.manifest ?? {};
  const specificChecks = taskChecks({ workspaceRoot, actualFiles, evidence });
  const specificPassed = Object.values(specificChecks).every(Boolean);
  const checks = { ...validation.checks, ...specificChecks };
  const implementationPassed = specificPassed && Boolean(checks.changedFiles);
  const testsPassed = actualTestExitCode === 0 && Boolean(checks.testReceiptVerified);
  const evidenceCompliant = Boolean(validation.valid);
  const passed = implementationPassed && testsPassed && evidenceCompliant;
  const failureCategory = passed ? 'none' : classifyJudgeFailure(specificPassed, actualTestExitCode, validation);

  return {
    passed,
    score: passed ? 1 : 0,
    deterministic: true,
    reason: passed
      ? 'engineering_acceptance_complete'
      : validation.status === EVIDENCE_STATUSES.INCOMPLETE && implementationPassed && testsPassed
        ? EVIDENCE_STATUSES.INCOMPLETE
        : 'engineering_acceptance_incomplete',
    evidence: {
      taskId: task.id,
      schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
      attemptId: evidence.attemptId ?? context.attemptId ?? null,
      planVersion: evidence.planVersion ?? context.planVersion ?? 1,
      manifestStatus: validation.status,
      missingFields: validation.missingFields,
      errors: validation.errors,
      actualChangedFiles: actualFiles,
      reportedChangedFiles: Array.isArray(evidence.changedFiles) ? evidence.changedFiles.map(normalizeEvidencePath) : [],
      actualTestExitCode,
      reportedTestExitCode: Number.isInteger(evidence.testExitCode) ? evidence.testExitCode : null,
      expectedTestCommand: acceptance.testCommand,
      reportedTestCommand: evidence.testCommand ?? null,
      implementationPassed,
      testsPassed,
      evidenceCompliant,
      independentVerdictSource: validation.independentVerdictSource,
      failureCategory,
      checks,
    },
  };
}

function readmeContains(workspaceRoot, terms) {
  const readme = readFixtureText(workspaceRoot, 'README.md') ?? '';
  return terms.every((term) => readme.toLowerCase().includes(term.toLowerCase()));
}

function featureJudge(args) {
  return judgeTask({
    ...args,
    taskChecks: ({ workspaceRoot }) => ({
      implementation: (readFixtureText(workspaceRoot, 'src/catalog.js') ?? '').includes('summarizeCatalog'),
      documentation: readmeContains(workspaceRoot, ['summarizeCatalog', 'totalCents']),
    }),
  });
}

function bugFixJudge(args) {
  return judgeTask({
    ...args,
    taskChecks: ({ workspaceRoot }) => ({
      implementation: (readFixtureText(workspaceRoot, 'src/slug.js') ?? '').includes('slugify'),
      regressionFixture: readFixtureText(workspaceRoot, 'test/slug.test.js') !== null,
    }),
  });
}

function codebaseAnalysisJudge(args) {
  return judgeTask({
    ...args,
    taskChecks: ({ workspaceRoot }) => {
      const analysis = readFixtureText(workspaceRoot, 'ANALYSIS.md') ?? '';
      return {
        dependencyEvidence: ['src/main.js', 'src/config.js', 'src/service.js', 'src/store.js'].every((term) => analysis.includes(term)),
        conclusionHasEvidence: /depends|imports|dependency/i.test(analysis) && /evidence|because|reason/i.test(analysis),
      };
    },
  });
}

function refactorJudge(args) {
  return judgeTask({
    ...args,
    taskChecks: ({ workspaceRoot }) => ({
      extractedModule: readFixtureText(workspaceRoot, 'src/normalize.js') !== null,
      parserChanged: (readFixtureText(workspaceRoot, 'src/parser.js') ?? '').includes('./normalize.js'),
      formatterChanged: (readFixtureText(workspaceRoot, 'src/formatter.js') ?? '').includes('./normalize.js'),
    }),
  });
}

function testsJudge(args) {
  return judgeTask({
    ...args,
    taskChecks: ({ workspaceRoot }) => {
      const edgeTest = readFixtureText(workspaceRoot, 'test/cache.edge.test.js') ?? '';
      return {
        edgeTestAdded: edgeTest.includes('test('),
        undefinedCovered: /undefined/.test(edgeTest),
        zeroCovered: /\b0\b/.test(edgeTest),
      };
    },
  });
}

function apiCompatibilityJudge(args) {
  return judgeTask({
    ...args,
    taskChecks: ({ workspaceRoot }) => ({
      implementation: /status\s*[:=]\s*[\"']active[\"']/.test(readFixtureText(workspaceRoot, 'src/profile-api.js') ?? ''),
      compatibilityTest: readFixtureText(workspaceRoot, 'test/api-compat.test.js') !== null,
    }),
  });
}

function securityAuditJudge(args) {
  return judgeTask({
    ...args,
    taskChecks: ({ workspaceRoot }) => {
      const report = readFixtureText(workspaceRoot, 'SECURITY-AUDIT.md') ?? '';
      return {
        boundaryHardened: (readFixtureText(workspaceRoot, 'src/safe-input.js') ?? '').includes('isSafeRedirect'),
        findingDocumented: ['//evil.example', 'CRLF', 'remediation'].every((term) => report.toLowerCase().includes(term.toLowerCase())),
        reportHasReproduction: /reproduc|evidence|proof/i.test(report),
      };
    },
  });
}

function dataProcessingJudge(args) {
  return judgeTask({
    ...args,
    taskChecks: ({ workspaceRoot }) => {
      const summary = readFixtureJson(workspaceRoot, 'output/summary.json');
      return {
        implementation: (readFixtureText(workspaceRoot, 'src/sales.js') ?? '').includes('summarizeSales'),
        generatedOutput: summary !== null && summary.totalCents === 4750 && summary.orderCount === 3,
        sortedOutput: Array.isArray(summary?.byRegion) && summary.byRegion.map((row) => row.region).join(',') === 'eu,us',
      };
    },
  });
}

function recoveryJudge(args) {
  return judgeTask({
    ...args,
    taskChecks: ({ workspaceRoot }) => ({
      implementation: (readFixtureText(workspaceRoot, 'src/recovery.js') ?? '').includes('resume'),
      interruptionTest: readFixtureText(workspaceRoot, 'test/recovery.test.js') !== null,
    }),
  });
}

function multiAgentJudge(args) {
  return judgeTask({
    ...args,
    taskChecks: ({ workspaceRoot }) => {
      const manifest = readFixtureJson(workspaceRoot, 'artifacts/manifest.json');
      const review = readFixtureText(workspaceRoot, 'REVIEW.md') ?? '';
      const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
      const hashesValid = artifacts.length === 2 && artifacts.every((artifact) => {
        const content = readFixtureText(workspaceRoot, artifact.path);
        return content !== null && artifact.sha256 === sha256Text(content);
      });
      return {
        leftImplementation: readFixtureText(workspaceRoot, 'src/left.js')?.includes('leftFeature') === true,
        rightImplementation: readFixtureText(workspaceRoot, 'src/right.js')?.includes('rightFeature') === true,
        artifactManifest: hashesValid,
        independentReview: /approved/i.test(review) && /src\/left\.js/.test(review) && /src\/right\.js/.test(review),
      };
    },
  });
}

function acceptanceMetadata({ testFiles, requiredChangedFiles, requiredFiles = requiredChangedFiles, testCommand = ['node', '--test', ...testFiles], checks }) {
  return {
    source: 'agent-us-real-engineering-benchmark',
    adapter: 'direct-agent-runtime',
    synthetic: true,
    externalNetwork: false,
    requiresWorkspaceMutation: true,
    requiresGitDiff: true,
    requiresIndependentVerification: true,
    acceptance: ['workspace_changed', 'task_specific_fixture', 'deterministic_fixture_tests', 'git_diff_captured', 'independent_verdict'],
    verificationStrategy: 'deterministic-fixture-and-git-evidence',
    expectedArtifacts: requiredFiles,
    resourceBudget: { maxSteps: 16, maxDurationMs: 30_000 },
    acceptanceCriteria: {
      requiredFiles,
      requiredChangedFiles,
      testFiles,
      testCommand,
      checks: checks ?? [],
    },
  };
}

const REAL_ENGINEERING_TASKS = Object.freeze([
  {
    id: 'real-multi-file-feature-01',
    title: '多文件功能开发',
    objective: 'Implement a documented catalog summary feature across the local module and keep the supplied deterministic test green.',
    prompt: 'Implement summarizeCatalog in src/catalog.js. It must return { count, totalCents, labels } for the supplied product records, preserve formatProduct, update README.md with the contract, and run node --test test/feature.test.js. Return a JSON evidence manifest with changedFiles, testCommand, testExitCode, and independentVerdict.',
    fixture: { files: {
      'README.md': '# Catalog fixture\n\nThis fixture needs a documented summarizeCatalog feature.\n',
      'src/catalog.js': 'export function formatProduct(product) { return `${product.name}: ${product.priceCents}`; }\n',
      'test/feature.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { formatProduct, summarizeCatalog } from '../src/catalog.js';

test('catalog summary is deterministic and preserves the public formatter', () => {
  assert.equal(formatProduct({ name: 'Alpha', priceCents: 1250 }), 'Alpha: 1250');
  assert.deepEqual(summarizeCatalog([
    { name: 'Alpha', priceCents: 1250 },
    { name: 'Beta', priceCents: 750 },
  ]), { count: 2, totalCents: 2000, labels: ['Alpha', 'Beta'] });
});
`,
    } },
    judge: featureJudge,
    metadata: acceptanceMetadata({ testFiles: ['test/feature.test.js'], requiredChangedFiles: ['src/catalog.js', 'README.md'] }),
  },
  {
    id: 'real-bug-fix-01',
    title: 'Bug 修复',
    objective: 'Fix punctuation and repeated-separator handling in the local slugifier without changing its exported API.',
    prompt: 'Fix src/slug.js so slugify("Hello,   World!") is hello-world, punctuation is removed, and repeated separators collapse. Do not rename the export. Run node --test test/slug.test.js and return the JSON evidence manifest.',
    fixture: { files: {
      'README.md': '# Slug bug fixture\n\nThe slugifier has a reproducible punctuation bug.\n',
      'src/slug.js': 'export function slugify(value) { return String(value).trim().toLowerCase().replace(/\\s+/g, "-"); }\n',
      'test/slug.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.js';

test('slugify removes punctuation and collapses separators', () => {
  assert.equal(slugify('Hello,   World!'), 'hello-world');
  assert.equal(slugify('  Multi---Part  '), 'multi-part');
});
`,
    } },
    judge: bugFixJudge,
    metadata: acceptanceMetadata({ testFiles: ['test/slug.test.js'], requiredChangedFiles: ['src/slug.js'] }),
  },
  {
    id: 'real-codebase-analysis-01',
    title: '陌生代码库分析',
    objective: 'Trace the local entry point and record dependency evidence grounded in source paths rather than README assumptions.',
    prompt: 'Inspect the fixture source graph. Create ANALYSIS.md with a concise dependency explanation grounded in the exact paths src/main.js, src/config.js, src/service.js, and src/store.js. Include why the entry point reaches the store and run node --test test/analysis.test.js. Return the JSON evidence manifest.',
    fixture: { files: {
      'README.md': '# Dependency graph fixture\n\nDo not infer the graph from this README.\n',
      'src/main.js': "import { createService } from './service.js';\nimport { config } from './config.js';\nexport function start() { return createService(config); }\n",
      'src/config.js': 'export const config = { database: "local" };\n',
      'src/service.js': "import { openStore } from './store.js';\nexport function createService(config) { return { config, store: openStore(config.database) }; }\n",
      'src/store.js': 'export function openStore(name) { return { name }; }\n',
      'test/analysis.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('analysis records source-backed dependency evidence', async () => {
  const report = await readFile('ANALYSIS.md', 'utf8');
  for (const path of ['src/main.js', 'src/config.js', 'src/service.js', 'src/store.js']) assert.match(report, new RegExp(path.replaceAll('.', '\\\\.'), 'i'));
  assert.match(report, /depends|imports|dependency/i);
  assert.match(report, /evidence|because|reason/i);
});
`,
    } },
    judge: codebaseAnalysisJudge,
    metadata: acceptanceMetadata({ testFiles: ['test/analysis.test.js'], requiredChangedFiles: ['ANALYSIS.md'] }),
  },
  {
    id: 'real-refactor-01',
    title: '多模块重构',
    objective: 'Extract shared normalization across parser and formatter modules while preserving their public APIs.',
    prompt: 'Refactor src/parser.js and src/formatter.js around a new src/normalize.js module. Preserve parseUser and formatUser behavior, make both modules import normalizeUser, and run node --test test/refactor.test.js. Return the JSON evidence manifest.',
    fixture: { files: {
      'README.md': '# Refactor fixture\n\nParser and formatter currently duplicate normalization logic.\n',
      'src/parser.js': 'export function parseUser(raw) { return { name: String(raw.name).trim(), email: String(raw.email).trim().toLowerCase() }; }\n',
      'src/formatter.js': 'export function formatUser(user) { return `${String(user.name).trim()} <${String(user.email).trim().toLowerCase()}>`; }\n',
      'test/refactor.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUser } from '../src/parser.js';
import { formatUser } from '../src/formatter.js';
import { normalizeUser } from '../src/normalize.js';

test('refactor shares normalization without changing public behavior', () => {
  const raw = { name: ' Ada ', email: ' ADA@EXAMPLE.COM ' };
  assert.deepEqual(parseUser(raw), { name: 'Ada', email: 'ada@example.com' });
  assert.deepEqual(normalizeUser(raw), { name: 'Ada', email: 'ada@example.com' });
  assert.equal(formatUser(raw), 'Ada <ada@example.com>');
});
`,
    } },
    judge: refactorJudge,
    metadata: acceptanceMetadata({ testFiles: ['test/refactor.test.js'], requiredChangedFiles: ['src/parser.js', 'src/formatter.js', 'src/normalize.js'] }),
  },
  {
    id: 'real-tests-01',
    title: '单元测试补充',
    objective: 'Add focused edge-case coverage for a cache helper, including undefined values and the zero value.',
    prompt: 'Add test/cache.edge.test.js without weakening the existing test. Cover undefined, null, and numeric zero behavior of getOrDefault, and run node --test test/cache.test.js test/cache.edge.test.js. Return the JSON evidence manifest.',
    fixture: { files: {
      'README.md': '# Test fixture\n\nAdd edge coverage; production code is intentionally unchanged.\n',
      'src/cache.js': 'export function getOrDefault(cache, key, fallback) { return cache[key] || fallback; }\n',
      'test/cache.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { getOrDefault } from '../src/cache.js';

test('cache returns stored truthy values', () => assert.equal(getOrDefault({ answer: 42 }, 'answer', 0), 42));
`,
    } },
    judge: testsJudge,
    metadata: acceptanceMetadata({ testFiles: ['test/cache.test.js', 'test/cache.edge.test.js'], requiredChangedFiles: ['test/cache.edge.test.js'] }),
  },
  {
    id: 'real-api-compat-01',
    title: 'API 兼容性修改',
    objective: 'Add an explicit status field while preserving the existing profile response fields and API function name.',
    prompt: 'Update src/profile-api.js so getProfile still returns id and name and additionally returns status: active. Add or update test/api-compat.test.js to prove old fields remain compatible, run node --test test/api-compat.test.js, and return the JSON evidence manifest.',
    fixture: { files: {
      'README.md': '# API compatibility fixture\n\nThe id and name response fields are backwards-compatible contract.\n',
      'src/profile-api.js': 'export function getProfile() { return { id: "user-1", name: "Ada" }; }\n',
      'test/api-compat.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { getProfile } from '../src/profile-api.js';

test('profile response preserves old fields and adds status', () => {
  const profile = getProfile();
  assert.equal(profile.id, 'user-1');
  assert.equal(profile.name, 'Ada');
  assert.equal(profile.status, 'active');
  assert.deepEqual(Object.keys(profile).sort(), ['id', 'name', 'status']);
});
`,
    } },
    judge: apiCompatibilityJudge,
    metadata: acceptanceMetadata({ testFiles: ['test/api-compat.test.js'], requiredChangedFiles: ['src/profile-api.js'] }),
  },
  {
    id: 'real-security-audit-01',
    title: '安全审计',
    objective: 'Harden the local redirect input boundary and document a reproducible open-redirect and CRLF finding.',
    prompt: 'Harden src/safe-input.js so isSafeRedirect accepts /docs but rejects //evil.example and CRLF injection. Create SECURITY-AUDIT.md documenting the finding, reproduction evidence, and remediation. Run node --test test/security.test.js and return the JSON evidence manifest.',
    fixture: { files: {
      'README.md': '# Security fixture\n\nAudit the redirect input boundary.\n',
      'src/safe-input.js': 'export function isSafeRedirect(value) { return typeof value === "string" && value.startsWith("/"); }\n',
      'test/security.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeRedirect } from '../src/safe-input.js';

test('redirect boundary rejects external hosts and CRLF', () => {
  assert.equal(isSafeRedirect('/docs'), true);
  assert.equal(isSafeRedirect('//evil.example'), false);
  assert.equal(isSafeRedirect('/docs\\r\\nLocation: https://evil.example'), false);
});
`,
    } },
    judge: securityAuditJudge,
    metadata: acceptanceMetadata({ testFiles: ['test/security.test.js'], requiredChangedFiles: ['src/safe-input.js', 'SECURITY-AUDIT.md'] }),
  },
  {
    id: 'real-data-processing-01',
    title: '数据处理',
    objective: 'Aggregate deterministic sales data by region and produce a sorted JSON summary artifact.',
    prompt: 'Implement summarizeSales in src/sales.js and scripts/process.js. Read data/sales.json, aggregate totalCents and orderCount by region, write output/summary.json with byRegion sorted alphabetically, and run node --test test/data.test.js. Return the JSON evidence manifest.',
    fixture: { files: {
      'README.md': '# Sales processing fixture\n\nThe output is deterministic and must be sorted by region.\n',
      'data/sales.json': JSON.stringify([
        { region: 'us', amountCents: 2500 },
        { region: 'eu', amountCents: 1250 },
        { region: 'us', amountCents: 1000 },
      ], null, 2),
      'src/sales.js': 'export function summarizeSales(rows) { return { orderCount: 0, totalCents: 0, byRegion: [] }; }\n',
      'test/data.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

test('sales processor emits the deterministic summary artifact', async () => {
  execFileSync(process.execPath, ['scripts/process.js'], { stdio: 'ignore' });
  const summary = JSON.parse(await readFile('output/summary.json', 'utf8'));
  assert.deepEqual(summary, {
    orderCount: 3,
    totalCents: 4750,
    byRegion: [
      { region: 'eu', orderCount: 1, totalCents: 1250 },
      { region: 'us', orderCount: 2, totalCents: 3500 },
    ],
  });
});
`,
    } },
    judge: dataProcessingJudge,
    metadata: acceptanceMetadata({ testFiles: ['test/data.test.js'], requiredChangedFiles: ['src/sales.js', 'scripts/process.js', 'output/summary.json'] }),
  },
  {
    id: 'real-recovery-01',
    title: '中断恢复',
    objective: 'Persist idempotent checkpoints so a forced interruption resumes remaining side effects exactly once.',
    prompt: 'Implement src/recovery.js with run(workDir, { interruptAfter }) and resume(workDir). The two steps prepare and publish must be checkpointed, interruption after prepare must be resumable, and repeated resume must not duplicate effects. Run node --test test/recovery.test.js and return the JSON evidence manifest.',
    fixture: { files: {
      'README.md': '# Recovery fixture\n\nA process can stop after prepare and must resume publish without replaying prepare.\n',
      'src/recovery.js': 'export async function run() { throw new Error("not implemented"); }\nexport async function resume() { throw new Error("not implemented"); }\n',
      'test/recovery.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, resume } from '../src/recovery.js';

test('recovery resumes without repeating completed side effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-us-recovery-test-'));
  try {
    await assert.rejects(run(root, { interruptAfter: 'prepare' }), /INTERRUPTED/);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')), { completed: ['prepare'] });
    await resume(root);
    await resume(root);
    assert.equal((await readFile(join(root, 'effects.log'), 'utf8')).trim().split(/\\r?\\n/).filter(Boolean).join(','), 'prepare,publish');
    assert.deepEqual(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')), { completed: ['prepare', 'publish'] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
`,
    } },
    judge: recoveryJudge,
    metadata: acceptanceMetadata({ testFiles: ['test/recovery.test.js'], requiredChangedFiles: ['src/recovery.js'] }),
  },
  {
    id: 'real-multi-agent-01',
    title: '多 Agent 并行开发',
    objective: 'Deliver two independently implemented features with content-addressed artifacts and an independent review manifest.',
    prompt: 'Implement src/left.js exporting leftFeature and src/right.js exporting rightFeature. Produce artifacts/manifest.json with SHA-256 entries for both source files and REVIEW.md that independently reviews both paths and marks the result approved. Run node --test test/multi-agent.test.js and return the JSON evidence manifest.',
    fixture: { files: {
      'README.md': '# Parallel engineering fixture\n\nTwo independent work streams must be handed off as verifiable artifacts.\n',
      'src/left.js': 'export function leftPlaceholder(value) { return value; }\n',
      'src/right.js': 'export function rightPlaceholder(value) { return value; }\n',
      'test/multi-agent.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { leftFeature } from '../src/left.js';
import { rightFeature } from '../src/right.js';

test('parallel artifacts are handed off and independently reviewable', async () => {
  assert.equal(leftFeature('x'), 'left:x');
  assert.equal(rightFeature('x'), 'right:x');
  const manifest = JSON.parse(await readFile('artifacts/manifest.json', 'utf8'));
  assert.equal(manifest.artifacts.length, 2);
  for (const artifact of manifest.artifacts) {
    const content = await readFile(artifact.path, 'utf8');
    assert.equal(artifact.sha256, createHash('sha256').update(content).digest('hex'));
  }
  const review = await readFile('REVIEW.md', 'utf8');
  assert.match(review, /src\\/left\\.js/);
  assert.match(review, /src\\/right\\.js/);
  assert.match(review, /approved/i);
});
`,
    } },
    judge: multiAgentJudge,
    metadata: acceptanceMetadata({ testFiles: ['test/multi-agent.test.js'], requiredChangedFiles: ['src/left.js', 'src/right.js', 'artifacts/manifest.json', 'REVIEW.md'] }),
  },
].map((task) => {
  const fileCount = Object.keys(task.fixture?.files ?? {}).length || 1;
  const expectedArtifacts = task.metadata?.expectedArtifacts ?? [];
  const verificationComplexity = /security-audit|recovery|multi-agent/.test(task.id)
    ? 'high'
    : /refactor|data-processing|multi-file-feature/.test(task.id)
      ? 'medium'
      : 'low';
  const recoveryRequirements = /recovery/.test(task.id);
  const budgetPlan = estimateTaskBudget({
    taskType: task.id,
    fileCount,
    requiredTools: ['read_file', 'write_file', 'edit_file', 'bash'],
    expectedArtifacts,
    verificationComplexity,
    recoveryRequirements,
  });
  const resourceBudget = {
    maxSteps: budgetPlan.maxSteps,
    maxTokens: budgetPlan.estimatedTokens,
    finalVerificationReserve: budgetPlan.finalVerificationReserve,
    maxDurationMs: Math.max(30_000, budgetPlan.maxSteps * 5_000),
    breakdown: {
      planningSteps: budgetPlan.planningSteps,
      researchSteps: budgetPlan.researchSteps,
      implementationSteps: budgetPlan.implementationSteps,
      testingSteps: budgetPlan.testingSteps,
      reviewSteps: budgetPlan.reviewSteps,
      repairReserve: budgetPlan.repairReserve,
      finalVerificationReserve: budgetPlan.finalVerificationReserve,
    },
    suggestedStages: budgetPlan.suggestedStages,
  };
  return {
    ...task,
    prompt: `${task.prompt}\n\n${formatEvidenceManifestContract({
      taskId: task.id,
      attemptId: 'attempt-1',
      planVersion: 1,
      testCommand: task.metadata.acceptanceCriteria.testCommand,
      requiredChangedFiles: task.metadata.acceptanceCriteria.requiredChangedFiles,
    })}`,
    resourceBudget,
    metadata: {
      ...task.metadata,
      resourceBudget,
    },
    category: 'real-software-engineering',
    difficulty: 'hard',
    tags: ['benchmark', 'real-engineering', task.id.replace(/^real-/, '')],
    expected: { output: { taskId: task.id, evidenceRequired: true, schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION } },
  };
}));

export function createRealEngineeringDataset() {
  return REAL_ENGINEERING_TASKS.map((task) => ({
    ...task,
    fixture: { files: { ...task.fixture.files } },
    expected: structuredClone(task.expected),
    metadata: structuredClone(task.metadata),
  }));
}

export const REAL_ENGINEERING_DATASET = REAL_ENGINEERING_TASKS;