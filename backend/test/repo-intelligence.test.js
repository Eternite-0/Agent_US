import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirSafe } from './fixtures.js';
import { Store } from '../src/store.js';
import {
  analyzeRepository,
  formatRepositorySummary,
} from '../src/repo-intelligence.js';
import {
  WORKSPACE_TOOL_META,
  createWorkspaceTools,
} from '../src/workspace-tools.js';
import {
  buildRuntimeContextMessage,
  buildStaticSystemPrompt,
} from '../src/agent-context.js';
import { ToolDispatcher } from '../src/tools/dispatcher.js';
import { ToolPermissionPolicy } from '../src/tools/policy.js';
import { mintNonce } from '../src/envelope.js';

function runGitSync(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryCreateSymlink(target, linkPath, type = 'file') {
  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

test('analyzeRepository: inspects multi-module ESM/CJS git repo, call graph, exports, and commands', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-repo-esm-'));
  try {
    mkdirSync(join(workDir, 'src', 'pricing'), { recursive: true });
    mkdirSync(join(workDir, 'src', 'auth'), { recursive: true });
    mkdirSync(join(workDir, 'src', 'legacy'), { recursive: true });
    mkdirSync(join(workDir, 'test'), { recursive: true });

    writeFileSync(
      join(workDir, 'package.json'),
      JSON.stringify(
        {
          name: 'billing-core',
          version: '1.0.0',
          type: 'module',
          main: './src/index.js',
          exports: {
            '.': './src/index.js',
            './pricing': './src/pricing/discount.js',
          },
          bin: { billing: './src/cli.js' },
          scripts: {
            test: 'node --test',
            build: 'tsc -p tsconfig.json',
            lint: 'eslint src',
          },
          dependencies: { zod: '^4.0.0', fastify: '^5.0.0' },
          devDependencies: { typescript: '^5.9.0', eslint: '^9.0.0' },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(join(workDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');

    // Core shared auth token hub (high inboundCount)
    writeFileSync(
      join(workDir, 'src', 'auth', 'token.js'),
      [
        'export function verifyToken(raw) { return Boolean(raw); }',
        'export const TOKEN_TTL_MS = 3600_000;',
      ].join('\n'),
      'utf8',
    );

    // Pricing module importing token + legacy CJS helper (plus commented fake import that must be ignored)
    writeFileSync(
      join(workDir, 'src', 'pricing', 'discount.js'),
      [
        '// import fake from "./nonexistent.js";',
        '/* const nope = require("./ghost.cjs"); */',
        "import { verifyToken } from '../auth/token.js';",
        "import { roundCents } from '../legacy/math.cjs';",
        'export function calculateDiscount(amount, rate) {',
        '  if (!verifyToken("ok")) return 0;',
        '  return roundCents(amount * rate);',
        '}',
      ].join('\n'),
      'utf8',
    );

    // CommonJS module
    writeFileSync(
      join(workDir, 'src', 'legacy', 'math.cjs'),
      [
        'function roundCents(v) { return Math.round(v * 100) / 100; }',
        'module.exports = { roundCents };',
      ].join('\n'),
      'utf8',
    );

    // Entry point + CLI
    writeFileSync(
      join(workDir, 'src', 'index.js'),
      [
        "import { verifyToken } from './auth/token.js';",
        "export { calculateDiscount } from './pricing/discount.js';",
        'export function boot() { return verifyToken("init"); }',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(workDir, 'src', 'cli.js'),
      [
        "import { boot } from './index.js';",
        "const { roundCents } = require('./legacy/math.cjs');",
        'export function main() { return boot() ? roundCents(1.234) : 0; }',
      ].join('\n'),
      'utf8',
    );

    // Tests
    writeFileSync(
      join(workDir, 'test', 'discount.test.js'),
      [
        "import { calculateDiscount } from '../src/pricing/discount.js';",
        "import { verifyToken } from '../src/auth/token.js';",
        'console.log(calculateDiscount(100, 0.1), verifyToken("x"));',
      ].join('\n'),
      'utf8',
    );

    // Initialize real git repo with commits + dirty change
    runGitSync(workDir, ['init']);
    runGitSync(workDir, ['config', 'user.email', 'test@example.com']);
    runGitSync(workDir, ['config', 'user.name', 'Test User']);
    runGitSync(workDir, ['add', '.']);
    runGitSync(workDir, ['commit', '-m', 'feat: initial billing core']);
    writeFileSync(join(workDir, 'README.md'), '# Billing Core\n', 'utf8');

    const analysis = await analyzeRepository(workDir, {
      issueText: 'Fix calculateDiscount precision bug in pricing',
    });

    // Exact top-level contract verification
    assert.ok(typeof analysis.analyzedAt === 'string' && !Number.isNaN(Date.parse(analysis.analyzedAt)));
    assert.equal(analysis.workspaceRoot, workDir);

    // Git metadata
    assert.equal(analysis.git.isGitRepo, true);
    assert.ok(typeof analysis.git.branch === 'string' && analysis.git.branch.length > 0);
    assert.match(analysis.git.headSha, /^[0-9a-f]{40}$/);
    assert.equal(analysis.git.dirty, true);
    assert.deepEqual(analysis.git.recentCommits, ['feat: initial billing core']);

    // Project metadata & commands
    assert.equal(analysis.project.name, 'billing-core');
    assert.equal(analysis.project.packageManager, 'pnpm');
    assert.ok(analysis.project.languages.includes('javascript'));
    assert.ok(analysis.project.manifests.includes('package.json'));
    assert.equal(analysis.project.scripts.test, 'node --test');
    assert.ok(analysis.project.testCommands.includes('pnpm test'));
    assert.ok(analysis.project.testCommands.includes('node --test'));
    assert.ok(analysis.project.buildCommands.includes('pnpm run build'));
    assert.ok(analysis.project.lintCommands.includes('pnpm run lint'));
    assert.deepEqual(analysis.project.dependencies, ['fastify', 'zod']);
    assert.deepEqual(analysis.project.devDependencies, ['eslint', 'typescript']);

    // Structure & entry points
    assert.ok(analysis.structure.topLevelDirs.includes('src'));
    assert.ok(analysis.structure.topLevelDirs.includes('test'));
    assert.ok(analysis.structure.entryPoints.includes('src/index.js'));
    assert.ok(analysis.structure.entryPoints.includes('src/cli.js'));
    assert.ok(analysis.structure.entryPoints.includes('src/pricing/discount.js'));
    assert.ok(analysis.structure.sourceFiles.includes('src/auth/token.js'));
    assert.ok(analysis.structure.testFiles.includes('test/discount.test.js'));
    assert.ok(analysis.structure.treeLines.length > 0);

    // Call graph edges & inbound counts
    assert.ok(
      analysis.callGraph.edges.some(
        (e) =>
          e.from === 'src/pricing/discount.js' &&
          e.to === 'src/auth/token.js' &&
          e.kind === 'esm-import' &&
          e.symbols.includes('verifyToken'),
      ),
    );
    assert.ok(
      analysis.callGraph.edges.some(
        (e) =>
          e.from === 'src/pricing/discount.js' &&
          e.to === 'src/legacy/math.cjs' &&
          e.kind === 'esm-import' &&
          e.symbols.includes('roundCents'),
      ),
    );
    assert.ok(
      analysis.callGraph.edges.some(
        (e) =>
          e.from === 'src/cli.js' &&
          e.to === 'src/legacy/math.cjs' &&
          e.kind === 'cjs-require',
      ),
    );
    assert.ok(
      analysis.callGraph.edges.some(
        (e) =>
          e.from === 'src/index.js' &&
          e.to === 'src/pricing/discount.js' &&
          e.kind === 'esm-reexport',
      ),
    );
    assert.equal(
      analysis.callGraph.edges.some((e) => e.specifier.includes('nonexistent') || e.specifier.includes('ghost')),
      false,
      'commented-out imports must not create edges',
    );

    const tokenMod = analysis.callGraph.modules.find((m) => m.path === 'src/auth/token.js');
    assert.ok(tokenMod);
    assert.equal(tokenMod.inboundCount, 3);
    assert.ok(tokenMod.exports.includes('verifyToken'));
    assert.ok(tokenMod.exports.includes('TOKEN_TTL_MS'));

    const cjsMod = analysis.callGraph.modules.find((m) => m.path === 'src/legacy/math.cjs');
    assert.ok(cjsMod);
    assert.ok(cjsMod.exports.includes('roundCents'));
    assert.equal(cjsMod.inboundCount, 2);

    // Issue keyword relevance + linked test discovery
    assert.equal(analysis.callGraph.relevantFiles[0].path, 'src/pricing/discount.js');
    assert.ok(analysis.callGraph.relevantFiles[0].linkedTests.includes('test/discount.test.js'));
    assert.ok(
      analysis.callGraph.relevantFiles.some(
        (f) => f.path === 'test/discount.test.js' && f.reasons.some((r) => r.startsWith('linked-test:')),
      ),
    );

    // Format summary respects strict UTF-8 maxBytes limit
    assert.ok(analysis.summaryText.includes('billing-core'));
    assert.ok(analysis.summaryText.includes('src/pricing/discount.js'));
    const tight = formatRepositorySummary(analysis, { maxBytes: 320 });
    assert.ok(Buffer.byteLength(tight, 'utf8') <= 320);

    // Without issueText, architectural centrality ranks central hub first
    const baseline = await analyzeRepository(workDir);
    assert.equal(baseline.callGraph.relevantFiles[0].path, 'src/auth/token.js');
    assert.equal(analysis.project.hasNodeModules, false);
    assert.ok(analysis.summaryText.includes('local node_modules/ is not installed'));

    mkdirSync(join(workDir, 'node_modules'), { recursive: true });
    const withNm = await analyzeRepository(workDir);
    assert.equal(withNm.project.hasNodeModules, true);
    assert.equal(withNm.summaryText.includes('local node_modules/ is not installed'), false);
  } finally {
    rmDirSafe(workDir);
  }
});

test('analyzeRepository: detects npm workspaces, Python, Rust, and Go projects with non-git fallback', async () => {
  // 1. Monorepo npm workspaces + Python fallback
  const monoDir = mkdtempSync(join(tmpdir(), 'agent-us-repo-mono-'));
  try {
    mkdirSync(join(monoDir, 'packages', 'api', 'src'), { recursive: true });
    mkdirSync(join(monoDir, 'pyservice', 'app'), { recursive: true });
    mkdirSync(join(monoDir, 'pyservice', 'tests'), { recursive: true });

    writeFileSync(
      join(monoDir, 'package.json'),
      JSON.stringify({
        name: 'polyglot-monorepo',
        private: true,
        workspaces: ['packages/*'],
      }),
      'utf8',
    );
    writeFileSync(
      join(monoDir, 'packages', 'api', 'package.json'),
      JSON.stringify({
        name: '@mono/api',
        main: './src/server.js',
        scripts: { test: 'node --test', build: 'tsc --noEmit' },
        dependencies: { express: '^4.19.0' },
      }),
      'utf8',
    );
    writeFileSync(
      join(monoDir, 'packages', 'api', 'src', 'server.js'),
      'export function startServer() { return true; }\n',
      'utf8',
    );

    writeFileSync(
      join(monoDir, 'pyservice', 'pyproject.toml'),
      [
        '[project]',
        'name = "py-worker"',
        'dependencies = [',
        '  "fastapi>=0.110",',
        '  "pydantic>=2.0"',
        ']',
        '[project.optional-dependencies]',
        'dev = ["pytest>=8.0", "ruff>=0.4"]',
        '[tool.pytest.ini_options]',
        'testpaths = ["tests"]',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(monoDir, 'pyservice', 'app', 'handler.py'),
      'def handle_event(x):\n    return x\n',
      'utf8',
    );
    writeFileSync(
      join(monoDir, 'pyservice', 'tests', 'test_handler.py'),
      'from ..app.handler import handle_event\n\ndef test_ok():\n    assert handle_event(1) == 1\n',
      'utf8',
    );

    const monoRes = await analyzeRepository(monoDir);
    assert.equal(monoRes.git.isGitRepo, false);
    assert.equal(monoRes.git.branch, null);
    assert.equal(monoRes.git.headSha, null);
    assert.equal(monoRes.git.dirty, false);
    assert.deepEqual(monoRes.git.recentCommits, []);

    assert.ok(monoRes.project.manifests.includes('package.json'));
    assert.ok(monoRes.project.manifests.includes('packages/api/package.json'));
    assert.ok(monoRes.project.manifests.includes('pyservice/pyproject.toml'));
    assert.ok(monoRes.project.dependencies.includes('express'));
    assert.ok(monoRes.project.dependencies.includes('fastapi'));
    assert.ok(monoRes.project.devDependencies.includes('pytest'));
    assert.ok(monoRes.project.testCommands.some((c) => c.includes('packages/api') && c.includes('npm test')));
    assert.ok(monoRes.project.testCommands.some((c) => c.includes('pytest')));
    assert.ok(monoRes.project.lintCommands.some((c) => c.includes('ruff')));
    assert.ok(
      monoRes.callGraph.edges.some(
        (e) =>
          e.from === 'pyservice/tests/test_handler.py' &&
          e.to === 'pyservice/app/handler.py',
      ),
    );
  } finally {
    rmDirSafe(monoDir);
  }

  // 2. Rust & Go repositories
  const rustDir = mkdtempSync(join(tmpdir(), 'agent-us-repo-rust-'));
  const goDir = mkdtempSync(join(tmpdir(), 'agent-us-repo-go-'));
  try {
    mkdirSync(join(rustDir, 'src'), { recursive: true });
    writeFileSync(
      join(rustDir, 'Cargo.toml'),
      '[package]\nname = "fast-indexer"\nversion = "0.1.0"\n[dependencies]\nserde = "1.0"\n',
      'utf8',
    );
    writeFileSync(join(rustDir, 'src', 'lib.rs'), 'pub mod engine;\n', 'utf8');
    writeFileSync(join(rustDir, 'src', 'engine.rs'), 'pub fn index_all() {}\n', 'utf8');

    const rustRes = await analyzeRepository(rustDir);
    assert.equal(rustRes.project.name, 'fast-indexer');
    assert.equal(rustRes.project.packageManager, 'cargo');
    assert.ok(rustRes.project.languages.includes('rust'));
    assert.ok(rustRes.project.testCommands.includes('cargo test'));
    assert.ok(rustRes.project.buildCommands.includes('cargo build'));
    assert.ok(rustRes.project.lintCommands.includes('cargo clippy'));
    assert.ok(rustRes.callGraph.edges.some((e) => e.from === 'src/lib.rs' && e.to === 'src/engine.rs'));

    mkdirSync(join(goDir, 'cmd', 'api'), { recursive: true });
    mkdirSync(join(goDir, 'internal', 'auth'), { recursive: true });
    writeFileSync(
      join(goDir, 'go.mod'),
      'module github.com/acme/gateway\n\ngo 1.23\n\nrequire (\n\tgithub.com/stretchr/testify v1.9.0\n)\n',
      'utf8',
    );
    writeFileSync(
      join(goDir, 'cmd', 'api', 'main.go'),
      'package main\nimport "github.com/acme/gateway/internal/auth"\nfunc main() { auth.Verify() }\n',
      'utf8',
    );
    writeFileSync(
      join(goDir, 'internal', 'auth', 'verify.go'),
      'package auth\nfunc Verify() bool { return true }\n',
      'utf8',
    );

    const goRes = await analyzeRepository(goDir);
    assert.equal(goRes.project.name, 'gateway');
    assert.equal(goRes.project.packageManager, 'go');
    assert.ok(goRes.project.languages.includes('go'));
    assert.ok(goRes.project.testCommands.includes('go test ./...'));
    assert.ok(goRes.project.buildCommands.includes('go build ./...'));
    assert.ok(goRes.project.lintCommands.includes('go vet ./...'));
    assert.ok(
      goRes.callGraph.edges.some(
        (e) => e.from === 'cmd/api/main.go' && e.to === 'internal/auth/verify.go',
      ),
    );
  } finally {
    rmDirSafe(rustDir);
    rmDirSafe(goDir);
  }
});

test('analyzeRepository: excludes secrets, .gitignore entries, skipped dirs, symlinks, and enforces maxFiles', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-repo-sec-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'agent-us-repo-out-'));
  try {
    mkdirSync(join(workDir, 'src'), { recursive: true });
    mkdirSync(join(workDir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(workDir, 'dist'), { recursive: true });
    mkdirSync(join(workDir, 'build'), { recursive: true });
    mkdirSync(join(workDir, 'coverage'), { recursive: true });
    mkdirSync(join(workDir, 'upstream'), { recursive: true });
    mkdirSync(join(workDir, 'var'), { recursive: true });
    mkdirSync(join(workDir, '.git'), { recursive: true });
    mkdirSync(join(workDir, 'ignored_dir'), { recursive: true });

    writeFileSync(join(workDir, '.gitignore'), '*.log\nignored_dir/\n*.gen.js\n', 'utf8');
    writeFileSync(join(workDir, 'package.json'), '{"name":"safe-repo"}\n', 'utf8');
    writeFileSync(join(workDir, 'src', 'app.js'), 'export const safeValue = 1;\n', 'utf8');

    // Ignored / secret / protected files with distinct canaries
    writeFileSync(join(workDir, '.env'), 'SECRET_KEY=CANARY_DOTENV\n', 'utf8');
    writeFileSync(join(workDir, '.env.local'), 'SECRET_LOCAL=CANARY_ENV_LOCAL\n', 'utf8');
    writeFileSync(join(workDir, '.pool-key'), 'CANARY_POOL_KEY\n', 'utf8');
    writeFileSync(join(workDir, '.dev-token'), 'CANARY_DEV_TOKEN\n', 'utf8');
    writeFileSync(join(workDir, '.provider-env.json'), '{"token":"CANARY_PROVIDER"}\n', 'utf8');
    writeFileSync(join(workDir, 'private.pem'), 'CANARY_PEM\n', 'utf8');
    writeFileSync(join(workDir, 'data.sqlite'), 'CANARY_SQLITE\n', 'utf8');
    writeFileSync(join(workDir, 'debug.log'), 'CANARY_LOG\n', 'utf8');
    writeFileSync(join(workDir, 'src', 'schema.gen.js'), 'export const CANARY_GEN = 1;\n', 'utf8');
    writeFileSync(join(workDir, 'ignored_dir', 'secret.js'), 'export const CANARY_IGN_DIR = 1;\n', 'utf8');
    writeFileSync(join(workDir, 'node_modules', 'pkg', 'index.js'), 'export const CANARY_NM = 1;\n', 'utf8');
    writeFileSync(join(workDir, 'dist', 'bundle.js'), 'export const CANARY_DIST = 1;\n', 'utf8');
    writeFileSync(join(workDir, 'build', 'out.js'), 'export const CANARY_BUILD = 1;\n', 'utf8');
    writeFileSync(join(workDir, 'coverage', 'cov.js'), 'export const CANARY_COV = 1;\n', 'utf8');
    writeFileSync(join(workDir, 'upstream', 'ref.js'), 'export const CANARY_UPSTREAM = 1;\n', 'utf8');
    writeFileSync(join(workDir, 'var', 'secret.js'), 'export const CANARY_VAR = 1;\n', 'utf8');
    writeFileSync(join(workDir, '.git', 'config'), 'CANARY_GIT_CONFIG\n', 'utf8');

    writeFileSync(join(outsideDir, 'escaped.js'), 'export const CANARY_SYMLINK = 1;\n', 'utf8');
    tryCreateSymlink(outsideDir, join(workDir, 'symlink_escape'), 'junction');

    const analysis = await analyzeRepository(workDir, {
      issueText: 'CANARY_DOTENV CANARY_DEV_TOKEN CANARY_UPSTREAM CANARY_GEN safeValue',
    });

    assert.equal(analysis.structure.totalFiles, 2); // package.json + src/app.js only
    assert.deepEqual(analysis.structure.sourceFiles, ['src/app.js']);
    assert.equal(analysis.structure.topLevelDirs.includes('upstream'), false);
    assert.equal(analysis.structure.topLevelDirs.includes('var'), false);
    assert.equal(analysis.structure.topLevelDirs.includes('node_modules'), false);
    assert.equal(analysis.structure.topLevelDirs.includes('ignored_dir'), false);

    const serialized = JSON.stringify(analysis);
    for (const canary of [
      'CANARY_DOTENV',
      'CANARY_ENV_LOCAL',
      'CANARY_POOL_KEY',
      'CANARY_DEV_TOKEN',
      'CANARY_PROVIDER',
      'CANARY_PEM',
      'CANARY_SQLITE',
      'CANARY_LOG',
      'CANARY_GEN',
      'CANARY_IGN_DIR',
      'CANARY_NM',
      'CANARY_DIST',
      'CANARY_BUILD',
      'CANARY_COV',
      'CANARY_UPSTREAM',
      'CANARY_VAR',
      'CANARY_GIT_CONFIG',
      'CANARY_SYMLINK',
      '.env',
      '.dev-token',
      '.pool-key',
    ]) {
      assert.equal(serialized.includes(canary), false, `Must exclude ${canary}`);
    }

    // maxFiles bounding check
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(workDir, 'src', `mod_${String(i).padStart(2, '0')}.js`), `export const m${i} = ${i};\n`, 'utf8');
    }
    const bounded = await analyzeRepository(workDir, { maxFiles: 6 });
    assert.ok(bounded.structure.totalFiles <= 6);
    assert.ok(bounded.project.manifests.includes('package.json'));
  } finally {
    rmDirSafe(workDir);
    rmDirSafe(outsideDir);
  }
});

test('inspect_repository tool integrates with ToolDispatcher, enforces read-only & sandbox confinement', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-us-tool-ri-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-tool-ri-work-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'agent-us-tool-ri-out-'));
  mkdirSync(join(workDir, 'packages', 'core', 'src'), { recursive: true });
  mkdirSync(join(workDir, '.git'), { recursive: true });
  writeFileSync(join(workDir, '.dev-token'), 'TOP_SECRET_TOKEN\n', 'utf8');
  writeFileSync(join(workDir, '.env'), 'SECRET=123\n', 'utf8');
  writeFileSync(join(workDir, 'package.json'), '{"name":"tool-repo","scripts":{"test":"node --test"}}\n', 'utf8');
  writeFileSync(
    join(workDir, 'packages', 'core', 'src', 'router.js'),
    "import { matchRoute } from './matcher.js';\nexport function route(u) { return matchRoute(u); }\n",
    'utf8',
  );
  writeFileSync(
    join(workDir, 'packages', 'core', 'src', 'matcher.js'),
    'export function matchRoute(u) { return u; }\n',
    'utf8',
  );
  writeFileSync(join(outsideDir, 'outside.txt'), 'OUTSIDE\n', 'utf8');
  tryCreateSymlink(outsideDir, join(workDir, 'junc-out'), 'junction');

  const store = new Store(join(dataDir, 'engine.sqlite'));
  const nonce = mintNonce();
  const dispatcher = new ToolDispatcher({
    store,
    policy: new ToolPermissionPolicy({ permissionMode: 'read-only' }),
  });

  try {
    assert.equal(WORKSPACE_TOOL_META.inspect_repository?.readOnly, true);

    const tools = createWorkspaceTools({
      workspaceRoot: workDir,
      store,
      sessionId: 'sess-ri',
      permissionMode: 'read-only',
      nonce,
    });
    const inspectTool = tools.find((t) => t.name === 'inspect_repository');
    assert.ok(inspectTool, 'inspect_repository must be registered in createWorkspaceTools');
    assert.equal(inspectTool.meta.readOnly, true);

    // 1. Read-only mode executes inspect_repository via ToolDispatcher without approval
    const res = await dispatcher.dispatchBatch({
      sessionId: 'sess-ri',
      turnId: 'turn-ri-1',
      permissionMode: 'read-only',
      tools,
      toolCalls: [
        {
          id: 'tc-1',
          name: 'inspect_repository',
          arguments: JSON.stringify({ focus: 'matchRoute', includeGraph: true, maxFiles: 50 }),
        },
        {
          id: 'tc-2',
          name: 'inspect_repository',
          arguments: JSON.stringify({ focus: 'packages/core', includeGraph: false }),
        },
      ],
    });

    assert.equal(res[0].isError, false);
    assert.ok(res[0].output.includes(`<untrusted id="${nonce}-tool-inspect_repository-`));
    assert.ok(res[0].output.includes('tool-repo'));
    assert.ok(res[0].output.includes('packages/core/src/matcher.js'));
    assert.ok(res[0].output.includes('## Call Graph'));
    assert.equal(res[0].output.includes('TOP_SECRET_TOKEN'), false);

    assert.equal(res[1].isError, false);
    assert.ok(res[1].output.includes('src/router.js'));
    assert.equal(res[1].output.includes('## Call Graph'), false);

    // 2. Sandbox confinement & secret blocks on focus parameter
    for (const badFocus of ['../outside', '.git', '.dev-token', '.env', 'upstream', 'var']) {
      await assert.rejects(
        () => inspectTool.execute({ focus: badFocus }),
        /不允许|受保护|边界|prohibited/,
        `inspect_repository must block focus="${badFocus}"`,
      );
    }
    if (tryCreateSymlink(outsideDir, join(workDir, 'junc-out-2'), 'junction')) {
      await assert.rejects(
        () => inspectTool.execute({ focus: 'junc-out-2' }),
        /逃逸|边界/,
      );
    }
  } finally {
    store.close();
    rmDirSafe(dataDir);
    rmDirSafe(workDir);
    rmDirSafe(outsideDir);
  }
});

test('agent-context: buildStaticSystemPrompt stays byte-identical and buildRuntimeContextMessage accepts optional repoSummary', () => {
  const nonce = mintNonce();
  const s1 = buildStaticSystemPrompt(nonce);
  const s2 = buildStaticSystemPrompt(nonce);
  assert.equal(s1, s2);
  assert.equal(s1.includes('Agent_US'), true);

  // Without repoSummary (default empty): no <repository_intelligence> block emitted
  const baseline = buildRuntimeContextMessage({
    workspaceRoot: '/tmp/ws',
    gitBranch: 'main',
    mode: 'direct',
    permissionMode: 'auto-safe',
  });
  assert.equal(baseline.includes('<repository_intelligence>'), false);

  // With explicit repoSummary: emits <repository_intelligence> in volatile runtime context
  const enriched = buildRuntimeContextMessage({
    workspaceRoot: '/tmp/ws',
    gitBranch: 'main',
    mode: 'direct',
    permissionMode: 'auto-safe',
    repoSummary: '# Repository Intelligence: demo\n- Test: npm test',
  });
  assert.ok(enriched.includes('<repository_intelligence>\n# Repository Intelligence: demo\n- Test: npm test\n</repository_intelligence>'));
});

test('analyzeRepository: handles unborn git repo, requirements.txt, side-effect imports, and namespace re-exports', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agent-us-repo-edge-'));
  try {
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, 'requirements.txt'), 'flask==3.0.0\n# comment\nrequests>=2.31\n', 'utf8');
    writeFileSync(join(workDir, 'requirements-dev.txt'), 'pytest>=8.0\n', 'utf8');
    writeFileSync(join(workDir, 'src', 'setup.js'), 'export const ready = true;\n', 'utf8');
    writeFileSync(join(workDir, 'src', 'helpers.js'), 'export function formatMoney(v) { return String(v); }\n', 'utf8');
    writeFileSync(
      join(workDir, 'src', 'main.js'),
      [
        "import './setup.js'",
        "import { formatMoney } from './helpers.js'",
        "export * as utils from './helpers.js'",
        'export const run = () => formatMoney(10);',
      ].join('\n'),
      'utf8',
    );

    runGitSync(workDir, ['init']);
    const res = await analyzeRepository(workDir);

    assert.equal(res.git.isGitRepo, true);
    assert.ok(typeof res.git.branch === 'string' && res.git.branch.length > 0);
    assert.equal(res.git.headSha, null);
    assert.equal(res.git.dirty, true);
    assert.deepEqual(res.git.recentCommits, []);

    assert.ok(res.project.dependencies.includes('flask'));
    assert.ok(res.project.dependencies.includes('requests'));
    assert.ok(res.project.devDependencies.includes('pytest'));
    assert.ok(res.project.testCommands.includes('pytest'));

    assert.ok(res.callGraph.edges.some((e) => e.from === 'src/main.js' && e.to === 'src/setup.js'));
    assert.ok(res.callGraph.edges.some((e) => e.from === 'src/main.js' && e.to === 'src/helpers.js'));
    const mainMod = res.callGraph.modules.find((m) => m.path === 'src/main.js');
    assert.ok(mainMod?.exports.includes('utils'));
    assert.ok(mainMod?.exports.includes('run'));
  } finally {
    rmDirSafe(workDir);
  }
});

test('analyzeRepository: handles non-canonical root casing, dot segments, and Windows 8.3 short paths', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'AgentUs Long Segment Repo '));
  try {
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(
      join(workDir, 'package.json'),
      JSON.stringify({ name: 'shortpath-demo', version: '1.0.0', dependencies: { commander: '^14.0.0' } }),
      'utf8',
    );
    writeFileSync(join(workDir, 'src', 'index.js'), 'export const ok = true;\n', 'utf8');

    const unnormalizedRoot = join(workDir, 'src', '..');
    const resDot = await analyzeRepository(unnormalizedRoot);
    assert.equal(resDot.project.name, 'shortpath-demo');
    assert.ok(resDot.project.dependencies.includes('commander'));
    assert.deepEqual(resDot.structure.sourceFiles, ['src/index.js']);

    if (process.platform === 'win32') {
      const lowerDrive = `${workDir.slice(0, 1).toLowerCase()}${workDir.slice(1)}`;
      const resLower = await analyzeRepository(lowerDrive);
      assert.equal(resLower.project.name, 'shortpath-demo');
      assert.deepEqual(resLower.structure.sourceFiles, ['src/index.js']);

      const shortPath = execFileSync(
        'cmd.exe',
        ['/d', '/s', '/c', `for %I in ("${workDir}") do @echo %~sI`],
        { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true },
      )
        .trim()
        .replace(/^"+|"+$/g, '');
      if (shortPath && existsSync(shortPath) && shortPath !== workDir) {
        const resShort = await analyzeRepository(shortPath);
        assert.equal(resShort.project.name, 'shortpath-demo');
        assert.ok(resShort.project.dependencies.includes('commander'));
        assert.deepEqual(resShort.structure.sourceFiles, ['src/index.js']);
      }
    }
  } finally {
    rmDirSafe(workDir);
  }
});
