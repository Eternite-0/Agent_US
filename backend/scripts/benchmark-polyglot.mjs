#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_POLYGLOT_DRY_RUN_TIMEOUT_MS,
  DEFAULT_POLYGLOT_GRADE_TIMEOUT_MS,
  DEFAULT_POLYGLOT_MAX_STEPS,
  DEFAULT_POLYGLOT_TURN_TIMEOUT_MS,
  MAX_POLYGLOT_STEPS,
  POLYGLOT_DEFAULT_MODEL,
  POLYGLOT_LANGUAGES,
  POLYGLOT_MODES,
  VALID_POLYGLOT_MODES,
  VALID_POLYGLOT_PRESETS,
  aggregatePolyglotResults,
  loadShardResultsFromDir,
  renderPolyglotMarkdownReport,
  runPolyglotBenchmark,
  writePolyglotReportFiles,
} from '../src/evaluation/polyglot-eval.js';

function printPolyglotUsage() {
  console.log(
    [
      'Usage: node backend/scripts/benchmark-polyglot.mjs [options]',
      '',
      'Options:',
      '  --preset <smoke-6|polyglot-36|all>  Stratified benchmark preset (default: smoke-6)',
      '  --modes <csv>                       Comma-separated modes: raw_full,full_aci,claude_code,mini_swe_agent',
      `  --model <model>                     Target model ID (default: ${POLYGLOT_DEFAULT_MODEL})`,
      '  --protocol <openai|anthropic>       Upstream API protocol (auto-inferred if omitted)',
      '  --languages <csv>                   Optional language filter: cpp,go,java,javascript,python,rust',
      '  --limit <n>                         Optional max exercises cap after preset sampling',
      '  --seed <n>                          Deterministic sampling PRNG seed (default: 42)',
      '  --shard-index <n>                   0-based shard index (default: 0)',
      '  --shard-count <n>                   Total number of shards (default: 1)',
      '  --shard <i/n>                       Optional 1-based shard alias (e.g. 1/3 -> index 0, count 3)',
      '  --benchmark-dir <dir>               Pre-cloned Aider-AI/polyglot-benchmark directory',
      '  --output <path>                     Output JSON file or directory (writes JSON + Markdown)',
      `  --max-steps <n>                     Max agent steps per exercise (default: ${DEFAULT_POLYGLOT_MAX_STEPS}, max: ${MAX_POLYGLOT_STEPS})`,
      '  --turn-timeout-ms <ms>              Per-exercise agent timeout in ms',
      '  --grade-timeout-ms <ms>             Per-exercise native build/test timeout in ms',
      '  --use-app-pool                      Clone enabled provider accounts read-only from App Pool',
      '  --no-use-app-pool                   Require explicit API key env var instead of App Pool',
      '  --app-data-dir <dir>                Explicit App data directory containing engine.sqlite',
      '  --dry-run                           Run offline deterministic closed-loop benchmark via SweBenchMeteringProxy',
      '  --aggregate <dir[,dir2,...]>        Merge shard JSON results into unified Markdown + JSON summary report',
      '  --json                              Print JSON report to stdout',
      '  --help, -h                          Show this help message',
      '',
      'Examples:',
      '  # Offline deterministic 6-language smoke dry-run across all 4 modes',
      '  node backend/scripts/benchmark-polyglot.mjs --preset smoke-6 --dry-run',
      '',
      '  # Live sharded 36-exercise 4-way run (shard 0 of 3)',
      '  node backend/scripts/benchmark-polyglot.mjs --preset polyglot-36 --modes raw_full,full_aci,claude_code,mini_swe_agent --model deepseek-v4.1-flash --shard-index 0 --shard-count 3 --output /tmp/polyglot-out/shard-0.json',
      '',
      '  # Aggregate shard outputs into unified summary.json + summary.md',
      '  node backend/scripts/benchmark-polyglot.mjs --aggregate /tmp/polyglot-out --output /tmp/polyglot-report',
    ].join('\n'),
  );
}

/**
 * Parses and validates CLI flags for `benchmark-polyglot.mjs`.
 */
export function parsePolyglotCliArgs(argv = process.argv.slice(2)) {
  const opts = {
    preset: 'smoke-6',
    modes: [...POLYGLOT_MODES],
    modesExplicit: false,
    model: POLYGLOT_DEFAULT_MODEL,
    protocol: null,
    languages: null,
    limit: null,
    seed: 42,
    shardIndex: 0,
    shardCount: 1,
    benchmarkDir: null,
    output: null,
    maxSteps: DEFAULT_POLYGLOT_MAX_STEPS,
    turnTimeoutMs: null,
    gradeTimeoutMs: DEFAULT_POLYGLOT_GRADE_TIMEOUT_MS,
    useAppPool: null,
    appDataDir: null,
    dryRun: false,
    aggregate: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const nextVal = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    const splitEq = (flag) => arg.slice(flag.length + 1);

    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--use-app-pool') opts.useAppPool = true;
    else if (arg === '--no-use-app-pool') opts.useAppPool = false;
    else if (arg === '--preset') opts.preset = String(nextVal()).trim().toLowerCase();
    else if (arg.startsWith('--preset=')) opts.preset = splitEq('--preset').trim().toLowerCase();
    else if (arg === '--modes') {
      opts.modesExplicit = true;
      opts.modes = String(nextVal())
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg.startsWith('--modes=')) {
      opts.modesExplicit = true;
      opts.modes = splitEq('--modes')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg === '--model') opts.model = String(nextVal()).trim();
    else if (arg.startsWith('--model=')) opts.model = splitEq('--model').trim();
    else if (arg === '--protocol') opts.protocol = String(nextVal()).trim().toLowerCase();
    else if (arg.startsWith('--protocol=')) opts.protocol = splitEq('--protocol').trim().toLowerCase();
    else if (arg === '--languages') {
      opts.languages = String(nextVal())
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg.startsWith('--languages=')) {
      opts.languages = splitEq('--languages')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg === '--limit') opts.limit = Number(nextVal());
    else if (arg.startsWith('--limit=')) opts.limit = Number(splitEq('--limit'));
    else if (arg === '--seed') opts.seed = Number(nextVal());
    else if (arg.startsWith('--seed=')) opts.seed = Number(splitEq('--seed'));
    else if (arg === '--shard-index') opts.shardIndex = Number(nextVal());
    else if (arg.startsWith('--shard-index=')) opts.shardIndex = Number(splitEq('--shard-index'));
    else if (arg === '--shard-count') opts.shardCount = Number(nextVal());
    else if (arg.startsWith('--shard-count=')) opts.shardCount = Number(splitEq('--shard-count'));
    else if (arg === '--shard' || arg.startsWith('--shard=')) {
      const raw = arg === '--shard' ? String(nextVal()) : splitEq('--shard');
      const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(raw);
      if (!m) {
        throw new Error(`Invalid --shard "${raw}"; expected "<1-based-index>/<total>" (e.g. "1/3")`);
      }
      const oneBasedIdx = Number(m[1]);
      const total = Number(m[2]);
      if (oneBasedIdx < 1 || oneBasedIdx > total) {
        throw new Error(`Invalid --shard "${raw}": index must be between 1 and ${total}`);
      }
      opts.shardIndex = oneBasedIdx - 1;
      opts.shardCount = total;
    } else if (arg === '--benchmark-dir') opts.benchmarkDir = String(nextVal()).trim();
    else if (arg.startsWith('--benchmark-dir=')) opts.benchmarkDir = splitEq('--benchmark-dir').trim();
    else if (arg === '--output') opts.output = String(nextVal()).trim();
    else if (arg.startsWith('--output=')) opts.output = splitEq('--output').trim();
    else if (arg === '--max-steps') opts.maxSteps = Number(nextVal());
    else if (arg.startsWith('--max-steps=')) opts.maxSteps = Number(splitEq('--max-steps'));
    else if (arg === '--turn-timeout-ms') opts.turnTimeoutMs = Number(nextVal());
    else if (arg.startsWith('--turn-timeout-ms=')) opts.turnTimeoutMs = Number(splitEq('--turn-timeout-ms'));
    else if (arg === '--grade-timeout-ms') opts.gradeTimeoutMs = Number(nextVal());
    else if (arg.startsWith('--grade-timeout-ms=')) opts.gradeTimeoutMs = Number(splitEq('--grade-timeout-ms'));
    else if (arg === '--app-data-dir') opts.appDataDir = String(nextVal()).trim();
    else if (arg.startsWith('--app-data-dir=')) opts.appDataDir = splitEq('--app-data-dir').trim();
    else if (arg === '--aggregate') {
      opts.aggregate = String(nextVal())
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--aggregate=')) {
      opts.aggregate = splitEq('--aggregate')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      throw new Error(`Unknown CLI flag: ${arg}`);
    }
  }

  if (opts.help) return opts;

  if (!VALID_POLYGLOT_PRESETS.has(opts.preset)) {
    throw new Error(
      `Invalid --preset "${opts.preset}"; expected "smoke-6", "polyglot-36", or "all"`,
    );
  }
  if (!opts.modes.length || opts.modes.some((m) => !VALID_POLYGLOT_MODES.has(m))) {
    throw new Error(
      `Invalid --modes "${opts.modes.join(',')}"; expected subset of ${POLYGLOT_MODES.join(',')}`,
    );
  }
  opts.modes = [...new Set(opts.modes)];

  if (opts.languages) {
    if (opts.languages.length === 0) {
      opts.languages = null;
    } else {
      for (const lang of opts.languages) {
        if (!POLYGLOT_LANGUAGES.includes(lang)) {
          throw new Error(
            `Invalid --languages entry "${lang}"; expected subset of ${POLYGLOT_LANGUAGES.join(',')}`,
          );
        }
      }
      opts.languages = [...new Set(opts.languages)];
    }
  }

  if (opts.protocol !== null && !['openai', 'anthropic'].includes(opts.protocol)) {
    throw new Error(`Invalid --protocol "${opts.protocol}"; expected "openai" or "anthropic"`);
  }
  if (!Number.isInteger(opts.shardCount) || opts.shardCount < 1) {
    throw new Error('--shard-count must be an integer >= 1');
  }
  if (!Number.isInteger(opts.shardIndex) || opts.shardIndex < 0 || opts.shardIndex >= opts.shardCount) {
    throw new Error(
      `--shard-index (${opts.shardIndex}) must be an integer between 0 and ${opts.shardCount - 1}`,
    );
  }
  if (opts.limit !== null && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  if (!Number.isInteger(opts.seed)) {
    throw new Error('--seed must be an integer');
  }
  if (!Number.isInteger(opts.maxSteps) || opts.maxSteps < 1) {
    throw new Error('--max-steps must be a positive integer');
  }
  opts.maxSteps = Math.min(MAX_POLYGLOT_STEPS, opts.maxSteps);

  if (opts.turnTimeoutMs !== null) {
    if (!Number.isFinite(opts.turnTimeoutMs) || opts.turnTimeoutMs < 1) {
      throw new Error('--turn-timeout-ms must be a positive integer');
    }
    opts.turnTimeoutMs = Math.trunc(opts.turnTimeoutMs);
  } else {
    opts.turnTimeoutMs = opts.dryRun
      ? DEFAULT_POLYGLOT_DRY_RUN_TIMEOUT_MS
      : DEFAULT_POLYGLOT_TURN_TIMEOUT_MS;
  }

  if (!Number.isFinite(opts.gradeTimeoutMs) || opts.gradeTimeoutMs < 1) {
    throw new Error('--grade-timeout-ms must be a positive integer');
  }
  opts.gradeTimeoutMs = Math.trunc(opts.gradeTimeoutMs);

  if (opts.aggregate !== null && opts.aggregate.length === 0) {
    throw new Error('--aggregate requires at least one directory or JSON file path');
  }

  return opts;
}

/**
 * Executes the Polyglot CLI workflow (either `--aggregate` merge or benchmark run).
 */
export async function runPolyglotCli(argv = process.argv.slice(2), runtimeDeps = {}) {
  const opts = parsePolyglotCliArgs(argv);
  if (opts.help) {
    printPolyglotUsage();
    return { action: 'help' };
  }

  if (Array.isArray(opts.aggregate) && opts.aggregate.length > 0) {
    const loaded = loadShardResultsFromDir(opts.aggregate);
    const firstMeta = loaded.metaList[0] ?? {};
    const report = aggregatePolyglotResults(loaded.records, {
      modes: opts.modesExplicit ? opts.modes : null,
      languages: opts.languages,
      meta: {
        preset: opts.preset || firstMeta.preset || null,
        model: opts.model || firstMeta.model || POLYGLOT_DEFAULT_MODEL,
        dryRun: Boolean(firstMeta.dryRun),
        shardCount: loaded.sourceFiles.length,
      },
    });
    const outputTarget = opts.output ? resolve(opts.output) : resolve(opts.aggregate[0]);
    const files = writePolyglotReportFiles(report, outputTarget);
    if (opts.json) {
      console.log(JSON.stringify({ action: 'aggregate', sourceFiles: loaded.sourceFiles, files, report }, null, 2));
    } else {
      console.log(renderPolyglotMarkdownReport(report));
      console.error(`[polyglot-eval] Aggregated ${loaded.sourceFiles.length} shard file(s) -> ${files.jsonPath} & ${files.markdownPath}`);
    }
    return { action: 'aggregate', sourceFiles: loaded.sourceFiles, files, report };
  }

  const result = await runPolyglotBenchmark(
    {
      ...opts,
      onRecord: (rec) => {
        if (!opts.json) {
          console.error(
            `[polyglot] mode=${rec.mode} exercise=${rec.exerciseId} status=${rec.status} passed=${rec.passed} steps=${rec.steps} in=${rec.inputTokens} out=${rec.outputTokens} cacheRead=${rec.cacheReadTokens} wall=${rec.wallClockMs}ms`,
          );
        }
      },
    },
    runtimeDeps,
  );

  if (opts.json) {
    console.log(JSON.stringify(result.report, null, 2));
  } else {
    console.log(renderPolyglotMarkdownReport(result.report));
    if (result.outputFiles) {
      console.error(
        `[polyglot-eval] Wrote report -> ${result.outputFiles.jsonPath} & ${result.outputFiles.markdownPath}`,
      );
    }
  }

  return { action: 'run', ...result };
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  runPolyglotCli(process.argv.slice(2)).catch((err) => {
    console.error(`[polyglot-eval] Fatal error: ${err?.message || err}`);
    process.exit(1);
  });
}
