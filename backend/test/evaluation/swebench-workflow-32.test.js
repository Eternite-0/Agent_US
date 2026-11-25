import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSweBenchCliArgs } from '../../scripts/benchmark-swebench.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'swebench-benchmark.yml');

/**
 * Lightweight zero-dependency YAML structural scanner for GitHub Actions workflow files.
 * Tracks indentation, skips block-scalar bodies (`|` / `>`), and builds nested key paths
 * so unit tests can inspect triggers, inputs, jobs, permissions, and steps without external packages.
 */
function parseWorkflowStructure(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  assert.ok(!yamlText.includes('\t'), 'Workflow YAML must not contain tab characters');

  const topLevelKeys = [];
  const blockScalars = [];
  const sections = new Map();
  const stack = [];
  let inBlockScalar = false;
  let blockParentIndent = -1;
  let blockKeyPath = '';
  let blockLines = [];

  const flushBlockScalar = () => {
    if (!inBlockScalar) return;
    blockScalars.push({ keyPath: blockKeyPath, content: blockLines.join('\n') });
    inBlockScalar = false;
    blockParentIndent = -1;
    blockKeyPath = '';
    blockLines = [];
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const lineNo = idx + 1;

    if (inBlockScalar) {
      if (raw.trim() === '') {
        blockLines.push('');
        continue;
      }
      const indent = raw.match(/^ */)[0].length;
      if (indent > blockParentIndent) {
        blockLines.push(raw.slice(blockParentIndent + 2));
        continue;
      }
      flushBlockScalar();
    }

    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const leadingSpaces = raw.match(/^ */)[0].length;
    assert.equal(
      leadingSpaces % 2,
      0,
      `Line ${lineNo} has odd indentation (${leadingSpaces} spaces): ${raw}`,
    );

    if (trimmed.startsWith('- ')) {
      while (stack.length && stack[stack.length - 1].indent >= leadingSpaces) {
        stack.pop();
      }
      const itemBody = trimmed.slice(2).trim();
      const parentPath = stack.map((s) => s.key).join('.');
      const existing = sections.get(parentPath);
      if (!Array.isArray(existing)) sections.set(parentPath, []);
      sections.get(parentPath).push(itemBody);

      const kvMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(itemBody);
      if (kvMatch) {
        const [, key, val] = kvMatch;
        stack.push({ indent: leadingSpaces + 2, key });
        const fullPath = stack.map((s) => s.key).join('.');
        sections.set(fullPath, val);
        if (val === '|' || val === '|-') {
          inBlockScalar = true;
          blockParentIndent = leadingSpaces + 2;
          blockKeyPath = fullPath;
          blockLines = [];
        }
      }
      continue;
    }

    const kvMatch = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(trimmed);
    if (!kvMatch) continue;
    const [, key, val] = kvMatch;

    while (stack.length && stack[stack.length - 1].indent >= leadingSpaces) {
      stack.pop();
    }
    stack.push({ indent: leadingSpaces, key });
    if (leadingSpaces === 0) topLevelKeys.push(key);

    const fullPath = stack.map((s) => s.key).join('.');
    sections.set(fullPath, val);

    if (val === '|' || val === '|-') {
      inBlockScalar = true;
      blockParentIndent = leadingSpaces;
      blockKeyPath = fullPath;
      blockLines = [];
    }
  }

  flushBlockScalar();
  return { topLevelKeys, sections, blockScalars };
}

function getSliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected marker not found: ${startMarker}`);
  const end = endMarker ? text.indexOf(endMarker, start + startMarker.length) : -1;
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

function extractSeedNodeScript(workflowText) {
  const match = /node --input-type=module <<'EOF'\r?\n([\s\S]*?)\r?\n\s*EOF/.exec(workflowText);
  assert.ok(match, 'Expected inline Node ESM seeding script heredoc in workflow');
  const lines = match[1].split(/\r?\n/);
  const minIndent = lines
    .filter((l) => l.trim().length > 0)
    .reduce((min, l) => Math.min(min, l.match(/^ */)[0].length), Infinity);
  return lines.map((l) => (l.length >= minIndent ? l.slice(minIndent) : l)).join('\n');
}

describe('SWE-bench Cloud Benchmark GitHub Actions Workflow (3.2c)', () => {
  const workflowText = readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');
  const parsed = parseWorkflowStructure(workflowText);
  const tempDirs = [];

  const makeTmp = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('YAML structure, indentation, name, and workflow_dispatch-only trigger', () => {
    assert.deepEqual(parsed.topLevelKeys, ['name', 'on', 'permissions', 'jobs']);
    assert.equal(parsed.sections.get('name'), 'SWE-bench Cloud Benchmark');
    assert.equal(parsed.sections.get('permissions.contents'), 'read');

    const onSection = getSliceBetween(workflowText, '\non:', '\npermissions:');
    assert.ok(onSection.includes('  workflow_dispatch:'), 'Must trigger on workflow_dispatch');
    assert.ok(!/^\s{2}push:/m.test(onSection), 'Must NEVER trigger on push');
    assert.ok(!/^\s{2}pull_request:/m.test(onSection), 'Must NEVER trigger on pull_request');
  });

  test('Defines all 11 workflow_dispatch inputs with expected types, options, and defaults', () => {
    const expectedInputs = {
      subset: { type: 'choice', default: 'paper-50', options: ['paper-50', 'smoke-5'] },
      model: { type: 'string', required: 'true', default: 'deepseek-v4.1-flash' },
      arms: { type: 'string', required: 'true', default: 'raw_full,full_aci' },
      protocol: { type: 'choice', default: 'openai', options: ['openai', 'anthropic'] },
      shards: { type: 'choice', default: "'5'", options: ["'1'", "'2'", "'3'", "'5'", "'10'"] },
      max_steps: { type: 'string', default: "'60'" },
      limit: { type: 'string', required: 'false', default: "''" },
      seed_smoke5: { type: 'boolean', default: 'true' },
      resume: { type: 'boolean', default: 'true' },
      output_subdir: { type: 'string', default: 'swebench-mini50' },
      commit_results: { type: 'boolean', default: 'true' },
    };

    const inputsBlock = getSliceBetween(workflowText, '  workflow_dispatch:\n    inputs:', '\npermissions:');
    const actualInputNames = [...inputsBlock.matchAll(/^      ([a-z0-9_]+):$/gm)].map((m) => m[1]);
    assert.deepEqual(actualInputNames, Object.keys(expectedInputs));
    assert.equal(actualInputNames.length, 11);

    for (const [name, spec] of Object.entries(expectedInputs)) {
      const prefix = `on.workflow_dispatch.inputs.${name}`;
      assert.equal(parsed.sections.get(`${prefix}.type`), spec.type, `${name}.type mismatch`);
      assert.equal(parsed.sections.get(`${prefix}.default`), spec.default, `${name}.default mismatch`);
      if (spec.required !== undefined) {
        assert.equal(
          parsed.sections.get(`${prefix}.required`),
          spec.required,
          `${name}.required mismatch`,
        );
      }
      if (spec.options) {
        assert.deepEqual(
          parsed.sections.get(`${prefix}.options`),
          spec.options,
          `${name}.options mismatch`,
        );
      }
    }
  });

  test('Defines all 3 jobs with exact permissions, dependencies, timeouts, and if: always()', () => {
    const jobNames = ['prepare-matrix', 'run-shard', 'merge-and-publish'];
    for (const job of jobNames) {
      assert.ok(parsed.sections.has(`jobs.${job}`), `Missing job ${job}`);
      assert.equal(parsed.sections.get(`jobs.${job}.runs-on`), 'ubuntu-latest');
    }

    // Job 1: prepare-matrix
    assert.equal(parsed.sections.get('jobs.prepare-matrix.permissions.contents'), 'read');
    assert.equal(
      parsed.sections.get('jobs.prepare-matrix.outputs.matrix'),
      '${{ steps.prep.outputs.matrix }}',
    );
    const prepBlock = getSliceBetween(workflowText, '  prepare-matrix:', '  run-shard:');
    assert.ok(prepBlock.includes('${{ secrets.SWEBENCH_API_KEY }}'));
    assert.ok(prepBlock.includes('::error'));
    assert.ok(prepBlock.includes('Settings -> Secrets and variables -> Actions'));
    assert.ok(prepBlock.includes('^[A-Za-z0-9._-]+$'));
    assert.ok(prepBlock.includes('$GITHUB_OUTPUT'));

    // Job 2: run-shard
    assert.equal(parsed.sections.get('jobs.run-shard.needs'), '[prepare-matrix]');
    assert.equal(parsed.sections.get('jobs.run-shard.timeout-minutes'), '350');
    assert.equal(parsed.sections.get('jobs.run-shard.permissions.contents'), 'read');
    assert.equal(parsed.sections.get('jobs.run-shard.strategy.fail-fast'), 'false');
    assert.equal(
      parsed.sections.get('jobs.run-shard.strategy.matrix.shard'),
      '${{ fromJson(needs.prepare-matrix.outputs.matrix) }}',
    );
    const shardBlock = getSliceBetween(workflowText, '  run-shard:', '  merge-and-publish:');
    assert.ok(
      shardBlock.includes(
        'sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache/CodeQL || true',
      ),
    );
    assert.ok(shardBlock.includes('df -h /'));
    assert.ok(shardBlock.includes('actions/checkout@v4'));
    assert.ok(shardBlock.includes('actions/setup-node@v4'));
    assert.ok(shardBlock.includes("node-version: '24'"));
    assert.ok(shardBlock.includes("cache: 'npm'"));
    assert.ok(shardBlock.includes('cache-dependency-path: backend/package-lock.json'));
    assert.ok(shardBlock.includes('npm --prefix backend ci'));
    assert.ok(shardBlock.includes("HF_HUB_DISABLE_TELEMETRY: '1'"));
    assert.ok(shardBlock.includes('SWEBENCH_API_KEY: ${{ secrets.SWEBENCH_API_KEY }}'));
    assert.ok(shardBlock.includes('SWEBENCH_ENDPOINT: ${{ secrets.SWEBENCH_ENDPOINT }}'));
    assert.ok(shardBlock.includes('SWEBENCH_PROTOCOL: ${{ inputs.protocol }}'));
    assert.ok(shardBlock.includes('actions/upload-artifact@v4'));
    assert.ok(shardBlock.includes('name: swebench-shard-${{ matrix.shard }}'));
    assert.ok(shardBlock.includes('path: /tmp/swebench-out/shard-${{ matrix.shard }}'));
    assert.match(shardBlock, /Upload shard output artifact[\s\S]*if:\s*always\(\)/);

    // Job 3: merge-and-publish
    assert.equal(parsed.sections.get('jobs.merge-and-publish.needs'), '[prepare-matrix, run-shard]');
    assert.equal(
      parsed.sections.get('jobs.merge-and-publish.if'),
      "always() && needs.prepare-matrix.result == 'success'",
    );
    assert.equal(parsed.sections.get('jobs.merge-and-publish.permissions.contents'), 'write');
    const mergeBlock = getSliceBetween(workflowText, '  merge-and-publish:', null);
    assert.ok(mergeBlock.includes('ref: ${{ github.ref_name }}'));
    assert.ok(mergeBlock.includes('actions/download-artifact@v4'));
    assert.ok(mergeBlock.includes('pattern: swebench-shard-*'));
    assert.ok(mergeBlock.includes('path: /tmp/swebench-shards'));
    assert.ok(mergeBlock.includes('$GITHUB_STEP_SUMMARY'));
    assert.ok(mergeBlock.includes('name: swebench-merged-${{ inputs.output_subdir }}'));
    assert.ok(mergeBlock.includes('path: backend/docs/evidence/${{ inputs.output_subdir }}'));
    assert.ok(mergeBlock.includes('if: inputs.commit_results == true'));
    assert.ok(
      mergeBlock.includes('docs(eval): update SWE-bench ${INPUT_SUBSET} results (${INPUT_MODEL}) [skip ci]'),
    );
    assert.ok(mergeBlock.includes('git pull --rebase && git push'));
  });

  test('Never interpolates raw ${{ inputs.* }} inside run: scripts and quotes shell variables', () => {
    const runBlocks = parsed.blockScalars.filter((b) => b.keyPath.endsWith('.run'));
    assert.ok(runBlocks.length >= 6, 'Expected at least 6 run: script blocks across jobs');
    for (const block of runBlocks) {
      assert.ok(
        !/\$\{\{\s*inputs\./.test(block.content),
        `Unsafe raw \${{ inputs.* }} interpolation found inside ${block.keyPath}`,
      );
      assert.ok(
        !/\$\{\{\s*github\.event\.inputs\./.test(block.content),
        `Unsafe raw \${{ github.event.inputs.* }} interpolation found inside ${block.keyPath}`,
      );
      assert.ok(
        !/\$\{\{\s*secrets\./.test(block.content),
        `Unsafe raw \${{ secrets.* }} interpolation found inside ${block.keyPath}`,
      );
    }
  });

  test('CLI flags in run-shard and merge-and-publish align with benchmark-swebench.mjs', () => {
    const shardBlock = getSliceBetween(workflowText, '  run-shard:', '  merge-and-publish:');
    const mergeBlock = getSliceBetween(workflowText, '  merge-and-publish:', null);

    const requiredShardFlags = [
      '--dataset hf:verified-mini',
      '--subset "$INPUT_SUBSET"',
      '--shard "${SHARD_INDEX}/${INPUT_SHARDS}"',
      '--arms "$INPUT_ARMS"',
      '--model "$INPUT_MODEL"',
      '--no-use-app-pool',
      '--docker-preset epoch',
      '--max-steps "$INPUT_MAX_STEPS"',
      '--turn-timeout-ms 900000',
      '--container-memory 3g',
      '--concurrency 1',
      '--cleanup-images',
      '--resume',
      '--evaluate',
      '--output-dir "/tmp/swebench-out/shard-${SHARD_INDEX}"',
      '--limit "$INPUT_LIMIT"',
    ];
    for (const flag of requiredShardFlags) {
      assert.ok(shardBlock.includes(flag), `run-shard missing CLI flag: ${flag}`);
    }

    const requiredMergeFlags = [
      '--dataset hf:verified-mini',
      '--merge-shards "$MERGE_SHARDS_ARG"',
      '--arms "$INPUT_ARMS"',
      '--model "$INPUT_MODEL"',
      '--subset "$INPUT_SUBSET"',
      '--output-dir "$OUT_DIR"',
      '--export-latex',
      '--limit "$INPUT_LIMIT"',
    ];
    for (const flag of requiredMergeFlags) {
      assert.ok(mergeBlock.includes(flag), `merge-and-publish missing CLI flag: ${flag}`);
    }

    const parsedMixed = parseSweBenchCliArgs([
      '--dataset',
      'hf:verified-mini',
      '--arms',
      'raw_full,full_aci,claude_code,codex_cli,mini_swe_agent',
      '--model',
      'deepseek-v4.1-flash',
    ]);
    assert.deepEqual(parsedMixed.arms, [
      'raw_full',
      'full_aci',
      'claude_code',
      'codex_cli',
      'mini_swe_agent',
    ]);

    assert.match(workflowText, /claude_code/);
    assert.match(workflowText, /codex_cli/);
    assert.match(workflowText, /mini_swe_agent/);
    assert.ok(shardBlock.includes('Install external benchmark agent CLIs (on-demand)'));
    assert.ok(shardBlock.includes('@anthropic-ai/claude-code'));
    assert.ok(shardBlock.includes('@openai/codex'));
    assert.ok(shardBlock.includes('mini-swe-agent'));

    // Verify all non-shard flags parse cleanly against parseSweBenchCliArgs in benchmark-swebench.mjs
    const parsedShardNonShardFlags = parseSweBenchCliArgs([
      '--dataset',
      'hf:verified-mini',
      '--subset',
      'paper-50',
      '--arms',
      'raw_full,full_aci',
      '--model',
      'deepseek-v4.1-flash',
      '--no-use-app-pool',
      '--docker-preset',
      'epoch',
      '--max-steps',
      '60',
      '--turn-timeout-ms',
      '900000',
      '--container-memory',
      '3g',
      '--concurrency',
      '1',
      '--cleanup-images',
      '--resume',
      '--evaluate',
      '--output-dir',
      '/tmp/swebench-out/shard-1',
      '--limit',
      '1',
      '--export-latex',
    ]);
    assert.equal(parsedShardNonShardFlags.subset, 'paper-50');
    assert.equal(parsedShardNonShardFlags.useAppPool, false);
    assert.equal(parsedShardNonShardFlags.dockerPreset, 'epoch');
    assert.equal(parsedShardNonShardFlags.cleanupImages, true);
    assert.equal(parsed.sections.get('jobs.run-shard.timeout-minutes'), '350');
    assert.equal(parsedShardNonShardFlags.exportLatex, true);
    assert.equal(parsedShardNonShardFlags.limit, 1);
  });

  test('Inline Node ESM seeding script skips env_error, preserves baseline, and validates output_subdir', () => {
    const seedScript = extractSeedNodeScript(workflowText);
    const tmpRoot = makeTmp('swebench-seed-test-');
    const scriptPath = join(tmpRoot, 'seed.mjs');
    writeFileSync(scriptPath, seedScript, 'utf8');

    const syntaxRes = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' });
    assert.equal(syntaxRes.status, 0, syntaxRes.stderr);

    const evidenceRoot = join(tmpRoot, 'evidence');
    const smokeDir = join(evidenceRoot, 'swebench-smoke5');
    const baselineDir = join(evidenceRoot, 'swebench-mini50');
    mkdirSync(smokeDir, { recursive: true });
    mkdirSync(baselineDir, { recursive: true });

    writeFileSync(
      join(smokeDir, 'telemetry.raw_full.jsonl'),
      [
        JSON.stringify({ instance_id: 'id__1', model: 'deepseek-v4.1-flash', status: 'completed' }),
        JSON.stringify({ instance_id: 'id__2', model: 'deepseek-v4.1-flash', status: 'env_error' }),
        JSON.stringify({ instance_id: 'id__3', model: 'deepseek-v4.1-flash', status: 'failed' }),
      ].join('\n') + '\n',
      'utf8',
    );
    writeFileSync(
      join(smokeDir, 'predictions.raw_full.jsonl'),
      [
        JSON.stringify({ instance_id: 'id__1', model_patch: 'patch1' }),
        JSON.stringify({ instance_id: 'id__2', model_patch: '' }),
        JSON.stringify({ instance_id: 'id__3', model_patch: 'patch3' }),
      ].join('\n') + '\n',
      'utf8',
    );
    writeFileSync(
      join(smokeDir, 'eval.raw_full.jsonl'),
      [
        JSON.stringify({ instance_id: 'id__1', resolved: true }),
        JSON.stringify({ instance_id: 'id__3', resolved: false }),
      ].join('\n') + '\n',
      'utf8',
    );

    // Baseline already has id__3 -> should NOT be overwritten by smoke-5
    writeFileSync(
      join(baselineDir, 'telemetry.raw_full.jsonl'),
      JSON.stringify({ instance_id: 'id__3', model: 'deepseek-v4.1-flash', status: 'completed', source: 'baseline' }) + '\n',
      'utf8',
    );
    writeFileSync(
      join(baselineDir, 'predictions.raw_full.jsonl'),
      JSON.stringify({ instance_id: 'id__3', model_patch: 'baseline_patch3' }) + '\n',
      'utf8',
    );

    const shardOut1 = join(tmpRoot, 'shard-1');
    const runSeed = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SHARD_INDEX: '1',
        INPUT_RESUME: 'true',
        INPUT_SEED_SMOKE5: 'true',
        INPUT_MODEL: 'deepseek-v4.1-flash',
        INPUT_ARMS: 'raw_full',
        INPUT_OUTPUT_SUBDIR: 'swebench-mini50',
        SWEBENCH_SEED_TARGET_DIR: shardOut1,
        SWEBENCH_EVIDENCE_ROOT: evidenceRoot,
      },
    });
    assert.equal(runSeed.status, 0, runSeed.stderr);

    const seededTele = readFileSync(join(shardOut1, 'telemetry.raw_full.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const seededById = new Map(seededTele.map((r) => [r.instance_id, r]));
    assert.equal(seededById.get('id__3')?.source, 'baseline');
    assert.equal(seededById.get('id__1')?.status, 'completed');
    assert.equal(seededById.has('id__2'), false, 'env_error row must not be seeded');
    assert.ok(existsSync(join(shardOut1, 'eval.raw_full.jsonl')));

    // Different model should not merge smoke-5 records
    const shardOut2 = join(tmpRoot, 'shard-2');
    const runOtherModel = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SHARD_INDEX: '2',
        INPUT_RESUME: 'false',
        INPUT_SEED_SMOKE5: 'true',
        INPUT_MODEL: 'deepseek-chat',
        INPUT_ARMS: 'raw_full',
        INPUT_OUTPUT_SUBDIR: 'swebench-mini50',
        SWEBENCH_SEED_TARGET_DIR: shardOut2,
        SWEBENCH_EVIDENCE_ROOT: evidenceRoot,
      },
    });
    assert.equal(runOtherModel.status, 0, runOtherModel.stderr);
    assert.equal(existsSync(join(shardOut2, 'telemetry.raw_full.jsonl')), false);

    // Archive smoke-5 path takes precedence over legacy evidenceRoot/swebench-smoke5 fallback
    const archivedSmokeDir = join(evidenceRoot, 'archive', 'swebench-smoke5');
    mkdirSync(archivedSmokeDir, { recursive: true });
    writeFileSync(
      join(archivedSmokeDir, 'telemetry.raw_full.jsonl'),
      JSON.stringify({ instance_id: 'id__arch1', model: 'deepseek-v4.1-flash', status: 'completed' }) + '\n',
      'utf8',
    );
    writeFileSync(
      join(archivedSmokeDir, 'predictions.raw_full.jsonl'),
      JSON.stringify({ instance_id: 'id__arch1', model_patch: 'archive_patch1' }) + '\n',
      'utf8',
    );
    writeFileSync(
      join(archivedSmokeDir, 'eval.raw_full.jsonl'),
      JSON.stringify({ instance_id: 'id__arch1', resolved: true }) + '\n',
      'utf8',
    );

    const shardOutArchive = join(tmpRoot, 'shard-archive');
    const runArchiveSeed = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SHARD_INDEX: '1',
        INPUT_RESUME: 'false',
        INPUT_SEED_SMOKE5: 'true',
        INPUT_MODEL: 'deepseek-v4.1-flash',
        INPUT_ARMS: 'raw_full',
        INPUT_OUTPUT_SUBDIR: 'swebench-mini50',
        SWEBENCH_SEED_TARGET_DIR: shardOutArchive,
        SWEBENCH_EVIDENCE_ROOT: evidenceRoot,
      },
    });
    assert.equal(runArchiveSeed.status, 0, runArchiveSeed.stderr);
    const archiveTele = readFileSync(join(shardOutArchive, 'telemetry.raw_full.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      archiveTele.map((r) => r.instance_id),
      ['id__arch1'],
      'archive/swebench-smoke5 must be preferred when present',
    );

    // Path traversal output_subdir must fail
    const badRes = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SHARD_INDEX: '1',
        INPUT_RESUME: 'true',
        INPUT_SEED_SMOKE5: 'true',
        INPUT_MODEL: 'deepseek-v4.1-flash',
        INPUT_ARMS: 'raw_full',
        INPUT_OUTPUT_SUBDIR: '../escape',
        SWEBENCH_SEED_TARGET_DIR: shardOut1,
        SWEBENCH_EVIDENCE_ROOT: evidenceRoot,
      },
    });
    assert.notEqual(badRes.status, 0);
  });
});
