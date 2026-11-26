import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from '../context.js';
import { ACI_CONFIG_KEY } from '../context/supervisor.js';
import { DirectAgentRuntime } from '../direct-agent.js';
import { redactSecrets } from '../envelope.js';
import { MetricsCollector } from '../observability/metrics.js';
import { AccountPool } from '../pool.js';
import { Store } from '../store.js';
import { analyzeCommand } from '../tools/command-analyzer.js';
import { killProcessTree, sanitizeChildEnv } from '../tools/sandbox.js';
import {
  SweBenchMeteringProxy,
  summarizeCliFailureOutput,
} from './swebench-external-agents.js';
import {
  hasExplicitEnvProviderKey,
  loadAppPoolReadOnly,
  resolveLiveProviderConfig,
  resolveSupervisorExecutionConfig,
} from './swebench-pool.js';

export { SweBenchMeteringProxy };

export const POLYGLOT_BENCHMARK_ID = 'agent-us-aider-polyglot';
export const POLYGLOT_BENCHMARK_VERSION = '1.0.0';
export const POLYGLOT_REPO_URL = 'https://github.com/Aider-AI/polyglot-benchmark.git';
export const POLYGLOT_DEFAULT_MODEL = 'deepseek-v4.1-flash';
export const POLYGLOT_LANGUAGES = Object.freeze([
  'cpp',
  'go',
  'java',
  'javascript',
  'python',
  'rust',
]);
export const POLYGLOT_MODES = Object.freeze([
  'raw_full',
  'full_aci',
  'claude_code',
  'mini_swe_agent',
]);
export const VALID_POLYGLOT_MODES = Object.freeze(new Set(POLYGLOT_MODES));
export const VALID_POLYGLOT_PRESETS = Object.freeze(new Set(['smoke-6', 'polyglot-36', 'all']));
export const DEFAULT_POLYGLOT_MAX_STEPS = 40;
export const MAX_POLYGLOT_STEPS = 80;
export const DEFAULT_POLYGLOT_TURN_TIMEOUT_MS = 600_000;
export const DEFAULT_POLYGLOT_DRY_RUN_TIMEOUT_MS = 60_000;
export const DEFAULT_POLYGLOT_GRADE_TIMEOUT_MS = 180_000;

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PLACEHOLDER_PROXY_KEY = 'sk-polyglot-metering-proxy-placeholder';
const CACHE_BLOCK_TOKENS = 64;

const SKIPPED_COPY_DIR_NAMES = new Set([
  '.meta',
  '.git',
  'build',
  'target',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.gradle',
  'node_modules',
]);

const PROTECTED_HARNESS_FILENAMES = new Set([
  'cmakelists.txt',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradlew',
  'gradlew.bat',
  'pom.xml',
  'mvnw',
  'mvnw.cmd',
  'package.json',
  'package-lock.json',
  'babel.config.json',
  'babel.config.js',
  'babel.config.cjs',
  'jest.config.js',
  'jest.config.cjs',
  'jest.config.mjs',
  'jest.config.json',
  'pyproject.toml',
  'pytest.ini',
  'setup.cfg',
  'conftest.py',
]);

const LANGUAGE_TEST_PATH_RES = Object.freeze({
  cpp: [
    /(?:^|\/)test(?:s)?\//i,
    /(?:^|\/).*_test\.(?:cpp|cc|cxx|hpp|h)$/i,
    /(?:^|\/)test_.*\.(?:cpp|cc|cxx|hpp|h)$/i,
  ],
  go: [/(?:^|\/).*_test\.go$/i],
  java: [
    /(?:^|\/)src\/test\//i,
    /(?:^|\/).*Test\.java$/,
  ],
  javascript: [
    /(?:^|\/)__tests__\//i,
    /(?:^|\/)tests?\//i,
    /(?:^|\/).*\.(?:spec|test)\.(?:js|mjs|cjs|ts)$/i,
  ],
  python: [
    /(?:^|\/)tests?\//i,
    /(?:^|\/).*_test\.py$/i,
    /(?:^|\/)test_.*\.py$/i,
    /(?:^|\/)conftest\.py$/i,
  ],
  rust: [/(?:^|\/)tests\//i, /(?:^|\/).*_test\.rs$/i],
});

const LANGUAGE_SOLUTION_EXTS = Object.freeze({
  cpp: new Set(['.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh']),
  go: new Set(['.go']),
  java: new Set(['.java']),
  javascript: new Set(['.js', '.mjs', '.cjs', '.ts']),
  python: new Set(['.py']),
  rust: new Set(['.rs']),
});

function compareAsc(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function round4(val) {
  return Number((Number(val) || 0).toFixed(4));
}

function toPosixRelPath(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function dedupeStrings(items) {
  const seen = new Set();
  const out = [];
  for (const item of items ?? []) {
    const clean = toPosixRelPath(item);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function safeRmDir(targetPath) {
  if (!targetPath) return;
  try {
    rmSync(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Best-effort cleanup
  }
}

function writeTextAtomic(targetPath, content) {
  const absPath = resolve(String(targetPath));
  mkdirSync(dirname(absPath), { recursive: true });
  const tmpPath = join(
    dirname(absPath),
    `.${basename(absPath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, absPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
  return absPath;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function createMulberry32(seed) {
  let state = Number(seed) >>> 0;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeedString(seed, label) {
  const digest = createHash('sha256')
    .update(`${seed}:${label}`, 'utf8')
    .digest();
  return digest.readUInt32LE(0);
}

function isDirSync(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFileSync(p) {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function walkRelativeFiles(rootDir, { skipDirs = SKIPPED_COPY_DIR_NAMES } = {}) {
  const results = [];
  const absRoot = resolve(String(rootDir));

  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => compareAsc(a.name, b.name));
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        walk(full);
      } else if (ent.isFile()) {
        const rel = toPosixRelPath(relative(absRoot, full));
        if (rel) results.push(rel);
      }
    }
  };

  walk(absRoot);
  return results;
}

function isTestPathForLanguage(relPath, language) {
  const norm = toPosixRelPath(relPath);
  const res = LANGUAGE_TEST_PATH_RES[language] ?? [];
  return res.some((re) => re.test(norm));
}

function isProtectedHarnessPath(relPath) {
  const norm = toPosixRelPath(relPath);
  const lowerBase = basename(norm).toLowerCase();
  if (PROTECTED_HARNESS_FILENAMES.has(lowerBase)) return true;
  if (norm.startsWith('gradle/') || norm.startsWith('.mvn/')) return true;
  return false;
}

/**
 * Returns the default local cache directory for `Aider-AI/polyglot-benchmark`.
 */
export function getDefaultPolyglotCacheDir(repoRoot = DEFAULT_REPO_ROOT) {
  const root = repoRoot ? resolve(String(repoRoot)) : DEFAULT_REPO_ROOT;
  return join(root, 'backend', 'data', 'benchmarks', 'polyglot-benchmark');
}

function hasAnyLanguageDir(dirPath) {
  if (!isDirSync(dirPath)) return false;
  return POLYGLOT_LANGUAGES.some((lang) => isDirSync(join(dirPath, lang)));
}

/**
 * Resolves a local `polyglot-benchmark` directory or performs an automatic shallow
 * `git clone --depth 1` from `https://github.com/Aider-AI/polyglot-benchmark.git`.
 */
export async function ensurePolyglotBenchmarkRepo({
  benchmarkDir = null,
  repoUrl = POLYGLOT_REPO_URL,
  env = process.env,
  allowClone = true,
  gitRunner = null,
  timeoutMs = 180_000,
} = {}) {
  const rawExplicit = String(benchmarkDir ?? '').trim();
  const envDir = String(env?.POLYGLOT_BENCHMARK_DIR ?? env?.AIDER_POLYGLOT_DIR ?? '').trim();
  const targetDir = resolve(rawExplicit || envDir || getDefaultPolyglotCacheDir());

  if (hasAnyLanguageDir(targetDir)) {
    return { repoDir: targetDir, cloned: false };
  }

  if (!allowClone) {
    throw new Error(
      `Polyglot benchmark directory not found or empty at ${targetDir}. Pass --benchmark-dir <dir>, set POLYGLOT_BENCHMARK_DIR, or enable auto-clone.`,
    );
  }

  mkdirSync(dirname(targetDir), { recursive: true });
  if (existsSync(targetDir)) {
    const entries = readdirSync(targetDir);
    if (entries.length > 0 && !hasAnyLanguageDir(targetDir)) {
      throw new Error(
        `Target directory ${targetDir} already exists and does not look like polyglot-benchmark.`,
      );
    }
  }

  const cloneArgs = ['clone', '--depth', '1', '--single-branch', String(repoUrl), targetDir];
  if (typeof gitRunner === 'function') {
    const res = await gitRunner(cloneArgs, { timeoutMs });
    if (res && res.exitCode !== 0) {
      throw new Error(
        `Failed to clone ${repoUrl} into ${targetDir}: ${res.stderr || `exit ${res.exitCode}`}`,
      );
    }
    return { repoDir: targetDir, cloned: true };
  }

  const run = await runSubprocessWithTimeout({
    bin: 'git',
    args: cloneArgs,
    cwd: dirname(targetDir),
    env,
    timeoutMs,
  });
  if (run.timedOut || run.exitCode !== 0) {
    throw new Error(
      `Failed to clone ${repoUrl} into ${targetDir}: ${summarizeCliFailureOutput(run.stderr, run.stdout, 500) || `exit ${run.exitCode}`}`,
    );
  }

  if (!hasAnyLanguageDir(targetDir)) {
    throw new Error(`Cloned ${repoUrl} into ${targetDir}, but no recognized language directories were found.`);
  }
  return { repoDir: targetDir, cloned: true };
}

function readExerciseInstructions(exerciseDir, slug) {
  const candidates = [
    join(exerciseDir, '.docs', 'instructions.md'),
    join(exerciseDir, 'README.md'),
    join(exerciseDir, 'instructions.md'),
  ];
  const parts = [];
  for (const cand of candidates) {
    if (isFileSync(cand)) {
      const content = readFileSync(cand, 'utf8').trim();
      if (content) {
        parts.push(content);
        break;
      }
    }
  }
  const appendPath = join(exerciseDir, '.docs', 'instructions.append.md');
  if (isFileSync(appendPath)) {
    const extra = readFileSync(appendPath, 'utf8').trim();
    if (extra) parts.push(extra);
  }
  if (parts.length === 0) {
    return `Solve the "${slug}" exercise so that all unit tests pass.`;
  }
  return parts.join('\n\n');
}

function readMetaConfig(exerciseDir) {
  const cfgPath = join(exerciseDir, '.meta', 'config.json');
  if (!isFileSync(cfgPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function discoverExerciseDirMap(languageRootDir) {
  const practiceDir = join(languageRootDir, 'exercises', 'practice');
  const containerDir = isDirSync(practiceDir) ? practiceDir : languageRootDir;
  if (!isDirSync(containerDir)) return [];

  const entries = readdirSync(containerDir, { withFileTypes: true })
    .filter((ent) => ent.isDirectory())
    .map((ent) => ent.name)
    .filter(
      (name) =>
        !name.startsWith('.') &&
        name !== 'node_modules' &&
        name !== 'target' &&
        name !== 'build' &&
        name !== 'exercises',
    )
    .sort(compareAsc);

  return entries.map((slug) => ({
    slug,
    exerciseDir: join(containerDir, slug),
  }));
}

/**
 * Loads all Aider Polyglot exercises from `benchmarkDir` across the requested languages.
 * Supports both official `<lang>/exercises/practice/<slug>` and flat `<lang>/<slug>` layouts.
 */
export function loadPolyglotExercises(
  benchmarkDir,
  { languages = POLYGLOT_LANGUAGES } = {},
) {
  const absRoot = resolve(String(benchmarkDir));
  if (!isDirSync(absRoot)) {
    throw new Error(`Polyglot benchmark directory does not exist: ${absRoot}`);
  }

  const requestedLangs = (Array.isArray(languages) ? languages : [languages])
    .map((l) => String(l ?? '').trim().toLowerCase())
    .filter(Boolean);
  const langOrder = requestedLangs.length > 0 ? requestedLangs : [...POLYGLOT_LANGUAGES];
  for (const lang of langOrder) {
    if (!POLYGLOT_LANGUAGES.includes(lang)) {
      throw new Error(
        `Unsupported Polyglot language "${lang}"; expected subset of ${POLYGLOT_LANGUAGES.join(', ')}`,
      );
    }
  }

  const exercises = [];
  for (const lang of POLYGLOT_LANGUAGES) {
    if (!langOrder.includes(lang)) continue;
    const languageRootDir = join(absRoot, lang);
    if (!isDirSync(languageRootDir)) continue;

    const dirs = discoverExerciseDirMap(languageRootDir);
    for (const { slug, exerciseDir } of dirs) {
      const metaConfig = readMetaConfig(exerciseDir);
      const filesMeta =
        metaConfig?.files && typeof metaConfig.files === 'object' ? metaConfig.files : {};

      const hiddenSet = new Set(
        dedupeStrings([
          ...(Array.isArray(filesMeta.example) ? filesMeta.example : []),
          ...(Array.isArray(filesMeta.exemplar) ? filesMeta.exemplar : []),
        ]),
      );

      const allPristineFiles = walkRelativeFiles(exerciseDir).filter(
        (rel) => !rel.startsWith('.meta/') && !hiddenSet.has(rel),
      );
      const existingPristineSet = new Set(allPristineFiles);

      let solutionFiles = dedupeStrings(
        Array.isArray(filesMeta.solution) ? filesMeta.solution : [],
      ).filter((rel) => existingPristineSet.has(rel) || !rel.startsWith('.meta/'));

      const metaTests = dedupeStrings(
        Array.isArray(filesMeta.test) ? filesMeta.test : [],
      ).filter((rel) => existingPristineSet.has(rel));

      const metaEditor = dedupeStrings(
        Array.isArray(filesMeta.editor) ? filesMeta.editor : [],
      ).filter((rel) => existingPristineSet.has(rel));

      const metaInvalidator = dedupeStrings(
        Array.isArray(filesMeta.invalidator) ? filesMeta.invalidator : [],
      ).filter((rel) => existingPristineSet.has(rel));

      const solutionSet = new Set(solutionFiles);

      // Infer test files via language patterns in addition to `.meta/config.json`
      const heuristicTests = allPristineFiles.filter(
        (rel) => !solutionSet.has(rel) && isTestPathForLanguage(rel, lang),
      );
      const testFiles = dedupeStrings([...metaTests, ...heuristicTests]);
      const testSet = new Set(testFiles);

      if (solutionFiles.length === 0) {
        const exts = LANGUAGE_SOLUTION_EXTS[lang] ?? new Set();
        solutionFiles = allPristineFiles.filter(
          (rel) =>
            !testSet.has(rel) &&
            !isProtectedHarnessPath(rel) &&
            !rel.startsWith('.docs/') &&
            exts.has(extname(rel).toLowerCase()),
        );
        for (const s of solutionFiles) solutionSet.add(s);
      }

      const harnessFiles = allPristineFiles.filter(
        (rel) => !solutionSet.has(rel) && isProtectedHarnessPath(rel),
      );

      const protectedFiles = dedupeStrings([
        ...testFiles,
        ...metaEditor.filter((rel) => !solutionSet.has(rel)),
        ...metaInvalidator.filter((rel) => !solutionSet.has(rel)),
        ...harnessFiles,
      ]);

      const instructions = readExerciseInstructions(exerciseDir, slug);
      let starterBytes = 0;
      for (const rel of solutionFiles) {
        const full = join(exerciseDir, rel);
        if (isFileSync(full)) {
          starterBytes += statSync(full).size;
        }
      }
      let testBytes = 0;
      for (const rel of testFiles) {
        const full = join(exerciseDir, rel);
        if (isFileSync(full)) {
          testBytes += statSync(full).size;
        }
      }

      const complexityScore = instructions.length + starterBytes + Math.round(testBytes * 0.5);

      exercises.push({
        id: `${lang}/${slug}`,
        language: lang,
        slug,
        title: String(metaConfig?.title || slug),
        blurb: String(metaConfig?.blurb || ''),
        exerciseDir,
        languageRootDir,
        instructions,
        solutionFiles,
        testFiles,
        protectedFiles,
        hiddenFiles: [...hiddenSet].sort(compareAsc),
        pristineFiles: allPristineFiles,
        complexityScore,
        metaConfig,
      });
    }
  }

  return exercises;
}

function sampleLanguageStratified(sortedPool, quota, seed, language) {
  const n = sortedPool.length;
  if (n === 0 || quota <= 0) return [];
  if (quota >= n) return [...sortedPool];

  const rng = createMulberry32(hashSeedString(seed, language));
  if (quota === 1) {
    // Pick deterministically from the middle complexity stratum for representative smoke coverage.
    const start = Math.floor(n / 3);
    const end = Math.max(start + 1, Math.ceil((2 * n) / 3));
    const idx = start + Math.floor(rng() * (end - start));
    return [sortedPool[Math.min(n - 1, idx)]];
  }

  const picked = [];
  for (let stratum = 0; stratum < quota; stratum++) {
    const start = Math.floor((stratum * n) / quota);
    const end = Math.max(start + 1, Math.floor(((stratum + 1) * n) / quota));
    const idx = start + Math.floor(rng() * (end - start));
    picked.push(sortedPool[Math.min(n - 1, idx)]);
  }
  return picked;
}

/**
 * Deterministically samples a stratified subset of Polyglot exercises.
 * - `smoke-6`: 1 exercise per language (total = 6 across all 6 languages)
 * - `polyglot-36`: 6 exercises per language (total = 36 across all 6 languages)
 * - `all`: all loaded exercises across requested languages
 *
 * Uses Latin-square round-robin interleaving across languages so modulo sharding
 * (e.g. 2 or 3 shards) balances heavy compiled languages evenly across every shard.
 */
export function selectPolyglotSubset(
  exercises,
  { preset = 'smoke-6', languages = null, limit = null, seed = 42 } = {},
) {
  if (!Array.isArray(exercises)) {
    throw new Error('selectPolyglotSubset expects an array of exercises');
  }
  const normPreset = String(preset || 'smoke-6').trim().toLowerCase();
  if (!VALID_POLYGLOT_PRESETS.has(normPreset)) {
    throw new Error(
      `Invalid Polyglot preset "${preset}"; expected "smoke-6", "polyglot-36", or "all"`,
    );
  }
  const normalizedSeed = Number.isFinite(Number(seed)) ? Math.trunc(Number(seed)) : 42;

  let activeLangs = [...POLYGLOT_LANGUAGES];
  if (Array.isArray(languages) && languages.length > 0) {
    const wanted = languages.map((l) => String(l).trim().toLowerCase()).filter(Boolean);
    for (const lang of wanted) {
      if (!POLYGLOT_LANGUAGES.includes(lang)) {
        throw new Error(
          `Unsupported Polyglot language "${lang}"; expected subset of ${POLYGLOT_LANGUAGES.join(', ')}`,
        );
      }
    }
    activeLangs = POLYGLOT_LANGUAGES.filter((l) => wanted.includes(l));
  }

  const byLang = new Map();
  for (const lang of activeLangs) byLang.set(lang, []);
  for (const ex of exercises) {
    const lang = String(ex?.language ?? '').trim().toLowerCase();
    if (!byLang.has(lang)) continue;
    byLang.get(lang).push(ex);
  }

  const sampledByLang = new Map();
  for (const lang of activeLangs) {
    const pool = [...byLang.get(lang)].sort(
      (a, b) =>
        (Number(a?.complexityScore ?? 0) || 0) - (Number(b?.complexityScore ?? 0) || 0) ||
        compareAsc(a?.slug, b?.slug) ||
        compareAsc(a?.id, b?.id),
    );
    if (normPreset === 'smoke-6') {
      sampledByLang.set(lang, sampleLanguageStratified(pool, 1, normalizedSeed, lang));
    } else if (normPreset === 'polyglot-36') {
      sampledByLang.set(lang, sampleLanguageStratified(pool, 6, normalizedSeed, lang));
    } else {
      sampledByLang.set(lang, pool);
    }
  }

  const presentLangs = activeLangs.filter((lang) => (sampledByLang.get(lang)?.length ?? 0) > 0);
  const maxPerLang = presentLangs.reduce(
    (max, lang) => Math.max(max, sampledByLang.get(lang).length),
    0,
  );

  // Latin-square rotated interleaving balances all 6 languages cleanly across 2 or 3 shards.
  const interleaved = [];
  for (let round = 0; round < maxPerLang; round++) {
    const shift = presentLangs.length > 0 ? round % presentLangs.length : 0;
    for (let offset = 0; offset < presentLangs.length; offset++) {
      const lang = presentLangs[(offset + shift) % presentLangs.length];
      const bucket = sampledByLang.get(lang);
      if (round < bucket.length) {
        interleaved.push(bucket[round]);
      }
    }
  }

  const finalExercises =
    limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0
      ? interleaved.slice(0, Math.trunc(Number(limit)))
      : interleaved;

  const languageDistribution = {};
  for (const lang of POLYGLOT_LANGUAGES) {
    const count = finalExercises.filter((ex) => ex.language === lang).length;
    if (count > 0) languageDistribution[lang] = count;
  }

  return {
    preset: normPreset,
    seed: normalizedSeed,
    exercises: finalExercises,
    exerciseIds: finalExercises.map((ex) => ex.id),
    languageDistribution,
  };
}

/**
 * Slices an ordered exercise list into a 0-based shard (`0 <= shardIndex < shardCount`).
 */
export function slicePolyglotShard(
  exercises,
  { shardIndex = 0, shardCount = 1 } = {},
) {
  const list = Array.isArray(exercises) ? exercises : [];
  const total = Number(shardCount);
  const idx = Number(shardIndex);
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`Invalid shardCount "${shardCount}": must be an integer >= 1`);
  }
  if (!Number.isInteger(idx) || idx < 0 || idx >= total) {
    throw new Error(
      `Invalid shardIndex "${shardIndex}" for shardCount=${total}: expected integer in [0, ${total - 1}]`,
    );
  }
  if (total === 1) return [...list];
  return list.filter((_, i) => i % total === idx);
}

function copyExerciseEntryFiltered(srcDir, dstDir, relPrefix, hiddenSet) {
  mkdirSync(dstDir, { recursive: true });
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue;
    const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
    const normRel = toPosixRelPath(rel);
    const srcPath = join(srcDir, ent.name);
    const dstPath = join(dstDir, ent.name);
    if (ent.isDirectory()) {
      if (SKIPPED_COPY_DIR_NAMES.has(ent.name)) continue;
      copyExerciseEntryFiltered(srcPath, dstPath, normRel, hiddenSet);
    } else if (ent.isFile()) {
      if (hiddenSet.has(normRel)) continue;
      copyFileSync(srcPath, dstPath);
      try {
        const mode = statSync(srcPath).mode;
        chmodSync(dstPath, mode);
      } catch {
        // Best-effort mode preservation
      }
    }
  }
}

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function pathEntryExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function shouldUnlockTestFile(relPath, language, testFileSet = null) {
  const norm = toPosixRelPath(relPath);
  if (!norm) return false;
  const lang = String(language ?? '').trim().toLowerCase();
  const inTestSet = Boolean(testFileSet?.has(norm));
  const isTest = inTestSet || isTestPathForLanguage(norm, lang);
  if (!isTest) return false;
  if (lang === 'java') {
    return /\.java$/i.test(norm);
  }
  if (lang === 'javascript') {
    return (
      /\.(?:spec|test)\.(?:js|mjs|cjs|ts)$/i.test(norm) ||
      (inTestSet && /\.(?:js|mjs|cjs|ts)$/i.test(norm))
    );
  }
  return false;
}

/**
 * Unlocks disabled Exercism/Aider Polyglot test cases so both agent self-testing
 * and final grading execute the full test suite:
 * - Java: strips `@Disabled` / `@Disabled("...")` annotations while preserving imports
 * - JavaScript: replaces `xtest(` with `test(`
 */
export function unlockPolyglotTestContent(content, language) {
  const text = String(content ?? '');
  const lang = String(language ?? '').trim().toLowerCase();
  if (lang === 'java') {
    return text.replace(/@Disabled\b(?:\([^)]*\))?\s*\r?\n?/g, '');
  }
  if (lang === 'javascript') {
    return text.replace(/\bxtest\s*\(/g, 'test(');
  }
  return text;
}

function unlockWorkspaceTestFiles(exercise, workspaceRoot) {
  const lang = String(exercise?.language ?? '').trim().toLowerCase();
  if (lang !== 'java' && lang !== 'javascript') return [];
  const absWs = resolve(String(workspaceRoot));
  const solutionSet = new Set(dedupeStrings(exercise?.solutionFiles ?? []));
  const testFileSet = new Set(dedupeStrings(exercise?.testFiles ?? []));
  const candidates = dedupeStrings([
    ...testFileSet,
    ...walkRelativeFiles(absWs),
  ]);
  const unlockedFiles = [];
  for (const rel of candidates) {
    if (solutionSet.has(rel)) continue;
    if (!shouldUnlockTestFile(rel, lang, testFileSet)) continue;
    const fullPath = join(absWs, rel);
    if (!isFileSync(fullPath)) continue;
    const original = readFileSync(fullPath, 'utf8');
    const unlocked = unlockPolyglotTestContent(original, lang);
    if (unlocked !== original) {
      writeFileSync(fullPath, unlocked, 'utf8');
      unlockedFiles.push(rel);
    }
  }
  return unlockedFiles;
}

/**
 * Creates an isolated per-task workspace directory copied from the pristine benchmark snapshot,
 * strictly omitting `.meta/` and reference example/exemplar solutions so the agent cannot cheat,
 * unlocking Exercism disabled Java/JS tests, and symlinking shared JS dependencies when configured.
 */
export function preparePolyglotWorkspace(
  exercise,
  { workspaceBaseDir = null, sharedJsNodeModulesDir = null } = {},
) {
  if (!exercise?.exerciseDir || !isDirSync(exercise.exerciseDir)) {
    throw new Error(`Invalid exercise directory for ${exercise?.id ?? 'unknown'}`);
  }
  const base = workspaceBaseDir ? resolve(String(workspaceBaseDir)) : tmpdir();
  mkdirSync(base, { recursive: true });
  const workspaceRoot = mkdtempSync(join(base, `agent-us-polyglot-${exercise.language}-`));
  const hiddenSet = new Set(dedupeStrings(exercise.hiddenFiles ?? []));

  copyExerciseEntryFiltered(exercise.exerciseDir, workspaceRoot, '', hiddenSet);
  const unlockedTestFiles = unlockWorkspaceTestFiles(exercise, workspaceRoot);

  let linkedNodeModules = null;
  let linkedPackageLock = null;
  if (exercise.language === 'javascript') {
    const wsNodeModules = join(workspaceRoot, 'node_modules');
    const wsPackageLock = join(workspaceRoot, 'package-lock.json');
    if (!pathEntryExists(wsNodeModules)) {
      const rawCandidates = [
        join(exercise.exerciseDir, 'node_modules'),
        sharedJsNodeModulesDir ? resolve(String(sharedJsNodeModulesDir)) : null,
        exercise.languageRootDir ? join(exercise.languageRootDir, 'node_modules') : null,
        exercise.languageRootDir ? join(dirname(exercise.languageRootDir), 'node_modules') : null,
      ].filter(Boolean);
      for (const rawCand of rawCandidates) {
        const cand =
          basename(rawCand).toLowerCase() !== 'node_modules' && isDirSync(join(rawCand, 'node_modules'))
            ? join(rawCand, 'node_modules')
            : rawCand;
        if (!isDirSync(cand)) continue;
        try {
          symlinkSync(
            cand,
            wsNodeModules,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
          linkedNodeModules = cand;
        } catch {
          // Clean fallback: resolvePolyglotGradePlan still exposes `cand` via NODE_PATH / PATH.
          linkedNodeModules = cand;
        }
        const srcPackageLock = join(dirname(cand), 'package-lock.json');
        if (isFileSync(srcPackageLock) && !pathEntryExists(wsPackageLock)) {
          try {
            symlinkSync(srcPackageLock, wsPackageLock, 'file');
            linkedPackageLock = srcPackageLock;
          } catch {
            try {
              copyFileSync(srcPackageLock, wsPackageLock);
              linkedPackageLock = srcPackageLock;
            } catch {
              // Best-effort lockfile fallback
            }
          }
        }
        break;
      }
    }
  }

  return {
    workspaceRoot,
    pristineSnapshotDir: exercise.exerciseDir,
    linkedNodeModules,
    linkedPackageLock,
    unlockedTestFiles,
    cleanup: () => safeRmDir(workspaceRoot),
  };
}

/**
 * Anti-cheating test integrity guard: forcefully restores ALL original exercise test files
 * and read-only harness/config files from the clean pristine benchmark snapshot into
 * `workspaceRoot` BEFORE running grading tests (re-applying official Java/JS test unlocking),
 * preserves shared `node_modules` symlinks, and deletes any rogue test files or `.meta/`.
 */
export function restoreProtectedTestFiles(exercise, workspaceRoot) {
  if (!exercise?.exerciseDir || !isDirSync(exercise.exerciseDir)) {
    throw new Error(`Missing pristine snapshot directory for ${exercise?.id ?? 'unknown'}`);
  }
  const absWs = resolve(String(workspaceRoot));
  const absPristine = resolve(String(exercise.exerciseDir));

  const solutionSet = new Set(dedupeStrings(exercise.solutionFiles ?? []));
  const pristineFiles = walkRelativeFiles(absPristine).filter(
    (rel) => !rel.startsWith('.meta/') && !new Set(exercise.hiddenFiles ?? []).has(rel),
  );
  const pristineSet = new Set(pristineFiles);

  const protectedList = dedupeStrings([
    ...(exercise.protectedFiles ?? []),
    ...(exercise.testFiles ?? []),
    ...pristineFiles.filter(
      (rel) =>
        !solutionSet.has(rel) &&
        (isTestPathForLanguage(rel, exercise.language) || isProtectedHarnessPath(rel)),
    ),
  ]).filter((rel) => !solutionSet.has(rel) && pristineSet.has(rel));

  const testFileSet = new Set(
    dedupeStrings([
      ...(exercise.testFiles ?? []),
      ...protectedList.filter((rel) => isTestPathForLanguage(rel, exercise.language)),
    ]),
  );

  const restoredFiles = [];
  const tamperedFiles = [];
  const unlockedTestFiles = [];

  for (const rel of protectedList) {
    const srcPath = join(absPristine, rel);
    const dstPath = join(absWs, rel);
    if (!isFileSync(srcPath)) continue;

    const unlockNeeded = shouldUnlockTestFile(rel, exercise.language, testFileSet);
    let expectedUnlockedBuf = null;
    if (unlockNeeded) {
      const rawText = readFileSync(srcPath, 'utf8');
      const unlockedText = unlockPolyglotTestContent(rawText, exercise.language);
      expectedUnlockedBuf = Buffer.from(unlockedText, 'utf8');
      if (unlockedText !== rawText) {
        unlockedTestFiles.push(rel);
      }
    }

    let modifiedOrMissing = false;
    const dstIsSymlink = pathEntryExists(dstPath) && lstatSync(dstPath).isSymbolicLink();
    if (dstIsSymlink || !isFileSync(dstPath)) {
      modifiedOrMissing = true;
    } else {
      try {
        const expectedHash = expectedUnlockedBuf
          ? sha256Buffer(expectedUnlockedBuf)
          : sha256File(srcPath);
        if (expectedHash !== sha256File(dstPath)) {
          modifiedOrMissing = true;
        }
      } catch {
        modifiedOrMissing = true;
      }
    }

    mkdirSync(dirname(dstPath), { recursive: true });
    if (dstIsSymlink) {
      rmSync(dstPath, { force: true });
    }
    if (expectedUnlockedBuf) {
      writeFileSync(dstPath, expectedUnlockedBuf);
    } else {
      copyFileSync(srcPath, dstPath);
    }
    try {
      chmodSync(dstPath, statSync(srcPath).mode);
    } catch {
      // Best-effort mode restore
    }
    restoredFiles.push(rel);
    if (modifiedOrMissing) {
      tamperedFiles.push(rel);
    }
  }

  // Remove any `.meta/` created inside workspace
  const rogueMetaDir = join(absWs, '.meta');
  const removedRogueTestFiles = [];
  if (existsSync(rogueMetaDir)) {
    safeRmDir(rogueMetaDir);
    removedRogueTestFiles.push('.meta');
  }

  // Remove newly injected rogue test files that did not exist in pristine snapshot
  const currentWsFiles = walkRelativeFiles(absWs);
  for (const rel of currentWsFiles) {
    if (solutionSet.has(rel) || pristineSet.has(rel)) continue;
    if (isTestPathForLanguage(rel, exercise.language)) {
      try {
        rmSync(join(absWs, rel), { force: true });
        removedRogueTestFiles.push(rel);
      } catch {
        // Ignore removal errors
      }
    }
  }

  return {
    restoredCount: restoredFiles.length,
    restoredFiles,
    tamperedFiles,
    removedRogueTestFiles,
    unlockedTestFiles,
    integrityViolation: tamperedFiles.length > 0 || removedRogueTestFiles.length > 0,
  };
}

function resolveExecutableOnPath(binName, env = process.env) {
  const pathVal = String(env?.PATH ?? env?.Path ?? process.env.PATH ?? '');
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of pathVal.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = join(dir, `${binName}${ext}`);
      if (isFileSync(cand)) return cand;
    }
  }
  return null;
}

function readPackageJsonSafe(workspaceRoot) {
  const pkgPath = join(workspaceRoot, 'package.json');
  if (!isFileSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Computes the ordered native build & test commands for an exercise workspace across all 6 languages.
 */
export function resolvePolyglotGradePlan(
  language,
  workspaceRoot,
  { platform = process.platform, env = process.env, sharedJsNodeModulesDir = null } = {},
) {
  const lang = String(language ?? '').trim().toLowerCase();
  const absWs = resolve(String(workspaceRoot));
  const isWin = platform === 'win32';

  if (lang === 'rust') {
    return {
      language: lang,
      steps: [
        {
          label: 'cargo-test',
          bin: 'cargo',
          args: ['test', '--', '--include-ignored'],
          displayCommand: 'cargo test -- --include-ignored',
          envOverrides: {},
        },
      ],
    };
  }

  if (lang === 'go') {
    return {
      language: lang,
      steps: [
        {
          label: 'go-test',
          bin: 'go',
          args: ['test', './...'],
          displayCommand: 'go test ./...',
          envOverrides: {},
        },
      ],
    };
  }

  if (lang === 'java') {
    const hasGradlew = isFileSync(join(absWs, 'gradlew'));
    const hasGradlewBat = isFileSync(join(absWs, 'gradlew.bat'));
    const hasBuildGradle =
      isFileSync(join(absWs, 'build.gradle')) || isFileSync(join(absWs, 'build.gradle.kts'));
    const hasMvnw = isFileSync(join(absWs, 'mvnw'));
    const hasMvnwCmd = isFileSync(join(absWs, 'mvnw.cmd'));
    const hasPomXml = isFileSync(join(absWs, 'pom.xml'));

    if (hasGradlew || hasGradlewBat) {
      if (isWin && hasGradlewBat) {
        return {
          language: lang,
          buildSystem: 'gradlew',
          steps: [
            {
              label: 'gradlew-test',
              bin: join(absWs, 'gradlew.bat'),
              args: ['test', '--rerun-tasks'],
              displayCommand: './gradlew test',
              envOverrides: {},
            },
          ],
        };
      }
      return {
        language: lang,
        buildSystem: 'gradlew',
        steps: [
          {
            label: 'gradlew-test',
            bin: isWin ? 'gradle' : 'sh',
            args: isWin ? ['test', '--rerun-tasks'] : ['./gradlew', 'test', '--rerun-tasks'],
            displayCommand: './gradlew test',
            envOverrides: {},
          },
        ],
      };
    }

    if (hasBuildGradle) {
      return {
        language: lang,
        buildSystem: 'gradle',
        steps: [
          {
            label: 'gradle-test',
            bin: isWin ? 'gradle.bat' : 'gradle',
            args: ['test', '--rerun-tasks'],
            displayCommand: 'gradle test',
            envOverrides: {},
          },
        ],
      };
    }

    if (hasMvnw || hasMvnwCmd) {
      if (isWin && hasMvnwCmd) {
        return {
          language: lang,
          buildSystem: 'mvnw',
          steps: [
            {
              label: 'mvnw-test',
              bin: join(absWs, 'mvnw.cmd'),
              args: ['test'],
              displayCommand: './mvnw test',
              envOverrides: {},
            },
          ],
        };
      }
      return {
        language: lang,
        buildSystem: 'mvnw',
        steps: [
          {
            label: 'mvnw-test',
            bin: isWin ? 'mvn.cmd' : 'sh',
            args: isWin ? ['test'] : ['./mvnw', 'test'],
            displayCommand: './mvnw test',
            envOverrides: {},
          },
        ],
      };
    }

    if (hasPomXml) {
      return {
        language: lang,
        buildSystem: 'maven',
        steps: [
          {
            label: 'mvn-test',
            bin: isWin ? 'mvn.cmd' : 'mvn',
            args: ['test'],
            displayCommand: 'mvn test',
            envOverrides: {},
          },
        ],
      };
    }

    return {
      language: lang,
      buildSystem: 'gradle',
      steps: [
        {
          label: 'gradle-test',
          bin: isWin ? 'gradle.bat' : 'gradle',
          args: ['test'],
          displayCommand: 'gradle test',
          envOverrides: {},
        },
      ],
    };
  }

  if (lang === 'cpp') {
    let hasAddTest = false;
    const cmakePath = join(absWs, 'CMakeLists.txt');
    if (isFileSync(cmakePath)) {
      try {
        const text = readFileSync(cmakePath, 'utf8');
        hasAddTest = /\b(?:enable_testing|add_test)\s*\(/i.test(text);
      } catch {
        hasAddTest = false;
      }
    }
    const ctestArgs = hasAddTest
      ? ['--test-dir', 'build', '--output-on-failure']
      : ['--test-dir', 'build', '--output-on-failure', '--no-tests=ignore'];
    return {
      language: lang,
      steps: [
        {
          label: 'cmake-configure',
          bin: 'cmake',
          args: ['-S', '.', '-B', 'build', '-DEXERCISM_RUN_ALL_TESTS=1'],
          displayCommand: 'cmake -S . -B build -DEXERCISM_RUN_ALL_TESTS=1',
          envOverrides: {},
        },
        {
          label: 'cmake-build',
          bin: 'cmake',
          args: ['--build', 'build'],
          displayCommand: 'cmake --build build',
          envOverrides: {},
        },
        {
          label: 'ctest',
          bin: 'ctest',
          args: ctestArgs,
          displayCommand: 'ctest --test-dir build --output-on-failure',
          envOverrides: {},
        },
      ],
    };
  }

  if (lang === 'javascript') {
    const pkg = readPackageJsonSafe(absWs);
    const testScript = String(pkg?.scripts?.test ?? '').trim();
    const hasRealNpmTest =
      Boolean(testScript) && !/no test specified/i.test(testScript);

    const envOverrides = { CI: 'true' };
    if (sharedJsNodeModulesDir && isDirSync(sharedJsNodeModulesDir)) {
      envOverrides.NODE_PATH = sharedJsNodeModulesDir;
      const binDir = join(sharedJsNodeModulesDir, '.bin');
      if (isDirSync(binDir)) {
        envOverrides.PATH = `${binDir}${delimiter}${String(env?.PATH ?? env?.Path ?? '')}`;
      }
    }

    if (hasRealNpmTest) {
      return {
        language: lang,
        steps: [
          {
            label: 'npm-test',
            bin: isWin ? 'npm.cmd' : 'npm',
            args: ['test'],
            displayCommand: 'npm test',
            envOverrides,
          },
        ],
      };
    }

    const hasJestConfig =
      isFileSync(join(absWs, 'jest.config.js')) ||
      isFileSync(join(absWs, 'jest.config.cjs')) ||
      isFileSync(join(absWs, 'jest.config.json')) ||
      Boolean(pkg?.devDependencies?.jest || pkg?.dependencies?.jest);
    if (hasJestConfig) {
      return {
        language: lang,
        steps: [
          {
            label: 'jest',
            bin: isWin ? 'npx.cmd' : 'npx',
            args: ['--no-install', 'jest'],
            displayCommand: 'jest',
            envOverrides,
          },
        ],
      };
    }

    return {
      language: lang,
      steps: [
        {
          label: 'node-test',
          bin: process.execPath,
          args: ['--test'],
          displayCommand: 'node --test',
          envOverrides,
        },
      ],
    };
  }

  if (lang === 'python') {
    const pytestOnPath = resolveExecutableOnPath('pytest', env);
    if (pytestOnPath) {
      return {
        language: lang,
        steps: [
          {
            label: 'pytest',
            bin: 'pytest',
            args: ['-q'],
            displayCommand: 'pytest',
            envOverrides: { PYTHONDONTWRITEBYTECODE: '1' },
          },
        ],
      };
    }
    const pyBin = resolveExecutableOnPath('python3', env) ? 'python3' : 'python';
    return {
      language: lang,
      steps: [
        {
          label: 'pytest',
          bin: pyBin,
          args: ['-m', 'pytest', '-q'],
          displayCommand: 'pytest',
          envOverrides: { PYTHONDONTWRITEBYTECODE: '1' },
        },
      ],
    };
  }

  throw new Error(`Unsupported Polyglot language for grading: "${language}"`);
}

function quoteWinCmdArg(arg) {
  const s = String(arg ?? '');
  if (!s) return '""';
  if (/^[A-Za-z0-9_./:=,@+-]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function runSubprocessWithTimeout({
  bin,
  args = [],
  cwd,
  env = process.env,
  timeoutMs = 120_000,
  maxCaptureBytes = 256 * 1024,
}) {
  const isScript = /\.(?:mjs|cjs|js)$/i.test(bin);
  let resolvedBin = bin;
  if (!isScript) {
    const hasPathSep = isAbsolute(bin) || bin.includes('/') || bin.includes('\\');
    if (hasPathSep) {
      if (!isFileSync(bin)) {
        return Promise.resolve({
          exitCode: 127,
          signal: null,
          timedOut: false,
          notFound: true,
          stdout: '',
          stderr: `Executable not found: ${bin}`,
        });
      }
    } else {
      const found = resolveExecutableOnPath(bin, env);
      if (!found) {
        return Promise.resolve({
          exitCode: 127,
          signal: null,
          timedOut: false,
          notFound: true,
          stdout: '',
          stderr: `Executable not found on PATH: ${bin}`,
        });
      }
      resolvedBin = found;
    }
  }

  let execBin;
  let execArgs;
  let windowsVerbatimArguments = false;
  if (isScript) {
    execBin = process.execPath;
    execArgs = [bin, ...args];
  } else if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(resolvedBin)) {
    execBin = String(env?.ComSpec || env?.COMSPEC || process.env.ComSpec || 'cmd.exe');
    const innerCmd = [`"${resolvedBin}"`, ...args.map(quoteWinCmdArg)].join(' ');
    execArgs = ['/d', '/s', '/c', `"${innerCmd}"`];
    windowsVerbatimArguments = true;
  } else {
    execBin = resolvedBin;
    execArgs = args;
  }

  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawn(execBin, execArgs, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolveRun({
        exitCode: err?.code === 'ENOENT' ? 127 : 1,
        signal: null,
        timedOut: false,
        notFound: err?.code === 'ENOENT',
        stdout: '',
        stderr: err?.message || String(err),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killProcessTree(child);
    }, Math.max(500, timeoutMs));

    const append = (which, chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      if (which === 'stdout') {
        if (stdout.length < maxCaptureBytes) {
          stdout += text.slice(0, maxCaptureBytes - stdout.length);
        }
      } else if (stderr.length < maxCaptureBytes) {
        stderr += text.slice(0, maxCaptureBytes - stderr.length);
      }
    };

    child.stdout?.on('data', (d) => append('stdout', d));
    child.stderr?.on('data', (d) => append('stderr', d));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        exitCode: err?.code === 'ENOENT' ? 127 : 1,
        signal: null,
        timedOut: false,
        notFound: err?.code === 'ENOENT',
        stdout,
        stderr: stderr ? `${stderr}\n${err.message}` : err.message,
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        exitCode: timedOut ? 124 : code ?? 1,
        signal: signal ?? null,
        timedOut,
        notFound: false,
        stdout,
        stderr,
      });
    });
  });
}

function evaluateDryRunFallbackSolution(exercise, workspaceRoot) {
  const solutionFiles = exercise.solutionFiles ?? [];
  if (solutionFiles.length === 0) return false;
  let sawEditedFile = false;
  for (const rel of solutionFiles) {
    const wsPath = join(workspaceRoot, rel);
    const srcPath = join(exercise.exerciseDir, rel);
    if (!isFileSync(wsPath)) return false;
    const text = readFileSync(wsPath, 'utf8');
    if (/BUG:\s*should/i.test(text)) return false;
    if (isFileSync(srcPath) && sha256File(wsPath) !== sha256File(srcPath)) {
      sawEditedFile = true;
    }
  }
  return sawEditedFile;
}

/**
 * Forcefully restores pristine test/harness files, then executes the native language
 * build & test pipeline in `workspaceRoot`.
 */
export async function gradePolyglotWorkspace(
  exercise,
  workspaceRoot,
  {
    timeoutMs = DEFAULT_POLYGLOT_GRADE_TIMEOUT_MS,
    restoreTests = true,
    dryRunFallbackOnMissingToolchain = false,
    env = process.env,
    sharedJsNodeModulesDir = null,
    commandRunner = null,
  } = {},
) {
  const started = performance.now();
  const integrity = restoreTests
    ? restoreProtectedTestFiles(exercise, workspaceRoot)
    : {
        restoredCount: 0,
        restoredFiles: [],
        tamperedFiles: [],
        removedRogueTestFiles: [],
        integrityViolation: false,
      };

  const plan = resolvePolyglotGradePlan(exercise.language, workspaceRoot, {
    env,
    sharedJsNodeModulesDir,
  });

  const stepResults = [];
  let passed = true;
  let lastExitCode = 0;
  let timedOut = false;
  let gradeError = null;
  let gradeMode = 'native';

  const sanitizedBase = sanitizeChildEnv(env, {
    allowKeys: [
      'PATH',
      'Path',
      'HOME',
      'USERPROFILE',
      'CARGO_HOME',
      'RUSTUP_HOME',
      'GOPATH',
      'GOMODCACHE',
      'GOCACHE',
      'JAVA_HOME',
      'GRADLE_USER_HOME',
      'M2_HOME',
      'NODE_PATH',
      'SystemRoot',
      'COMSPEC',
      'ComSpec',
      'TEMP',
      'TMP',
      'TMPDIR',
    ],
  });
  delete sanitizedBase.NODE_TEST_CONTEXT;

  for (const step of plan.steps) {
    const remainingMs = Math.max(
      1_000,
      Math.round(timeoutMs - (performance.now() - started)),
    );
    const stepEnv = {
      ...sanitizedBase,
      ...(step.envOverrides ?? {}),
    };

    const runRes =
      typeof commandRunner === 'function'
        ? await commandRunner({
            step,
            cwd: workspaceRoot,
            env: stepEnv,
            timeoutMs: remainingMs,
          })
        : await runSubprocessWithTimeout({
            bin: step.bin,
            args: step.args,
            cwd: workspaceRoot,
            env: stepEnv,
            timeoutMs: remainingMs,
          });

    stepResults.push({
      label: step.label,
      command: step.displayCommand,
      exitCode: runRes.exitCode,
      timedOut: Boolean(runRes.timedOut),
      notFound: Boolean(runRes.notFound),
      stdoutTail: String(runRes.stdout ?? '').slice(-2_000),
      stderrTail: String(runRes.stderr ?? '').slice(-2_000),
    });

    if (runRes.notFound && dryRunFallbackOnMissingToolchain) {
      gradeMode = 'dry_run_toolchain_fallback';
      passed = evaluateDryRunFallbackSolution(exercise, workspaceRoot);
      lastExitCode = passed ? 0 : 1;
      gradeError = passed
        ? null
        : `Dry-run fallback verification failed (${step.bin} unavailable on local host)`;
      break;
    }

    if (runRes.timedOut || runRes.exitCode !== 0) {
      passed = false;
      lastExitCode = runRes.exitCode ?? 1;
      timedOut = Boolean(runRes.timedOut);
      gradeError = runRes.timedOut
        ? `${step.displayCommand} timed out after ${timeoutMs}ms`
        : runRes.notFound
          ? `Toolchain binary not found: ${step.bin}`
          : `${step.displayCommand} failed (exit ${lastExitCode}): ${summarizeCliFailureOutput(runRes.stderr, runRes.stdout, 500)}`;
      break;
    }
  }

  const lastStep = stepResults.at(-1) ?? null;
  return {
    passed,
    exitCode: lastExitCode,
    timedOut,
    gradeMode,
    durationMs: Math.max(1, Math.round(performance.now() - started)),
    commands: plan.steps.map((s) => s.displayCommand),
    stepResults,
    stdoutTail: lastStep?.stdoutTail ?? '',
    stderrTail: lastStep?.stderrTail ?? '',
    integrity,
    error: gradeError,
  };
}

/**
 * Formats a clean, language-agnostic Polyglot exercise prompt.
 */
export function buildPolyglotPrompt(exercise, gradePlan = null) {
  const plan =
    gradePlan ??
    resolvePolyglotGradePlan(exercise.language, exercise.exerciseDir);
  const testCommand = plan.steps.map((s) => s.displayCommand).join(' && ');
  const parts = [
    `Exercise: ${exercise.id} (${exercise.language})`,
    '',
    'Instructions:',
    exercise.instructions,
    '',
    `Starter / Solution Files: ${exercise.solutionFiles.length ? exercise.solutionFiles.join(', ') : '(inspect workspace)'}`,
    `Test Files (read-only; restored before grading): ${exercise.testFiles.length ? exercise.testFiles.join(', ') : '(inspect workspace)'}`,
    `Verification Command: ${testCommand}`,
    '',
    'Implement the solution in the starter/solution file(s), run the verification command to confirm all tests pass, and do not modify test or build harness files.',
  ];
  return parts.join('\n');
}

/**
 * Generates an isolated temporary 6-language Polyglot fixture directory matching the
 * official `Aider-AI/polyglot-benchmark` layout (`<lang>/exercises/practice/<slug>/`)
 * with `.meta/config.json`, `.docs/instructions.md`, starter code, and test suites.
 */
export function createPolyglotDryRunFixture({
  baseDir = null,
  exercisesPerLanguage = 1,
} = {}) {
  const count = Math.max(1, Math.trunc(Number(exercisesPerLanguage) || 1));
  const rootDir = baseDir
    ? resolve(String(baseDir))
    : mkdtempSync(join(tmpdir(), 'agent-us-polyglot-fixture-'));
  mkdirSync(rootDir, { recursive: true });

  const writeExFile = (exDir, relPath, content) => {
    const full = join(exDir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  };

  for (let i = 1; i <= count; i++) {
    const idx = String(i).padStart(2, '0');
    const padDesc = `Complexity padding tier ${i}: `.repeat(i * 4);

    // 1. JavaScript (runnable natively via `npm test` -> `node --test`, zero external deps)
    {
      const slug = `adder-js-${idx}`;
      const exDir = join(rootDir, 'javascript', 'exercises', 'practice', slug);
      writeExFile(
        exDir,
        '.docs/instructions.md',
        `# Adder JS ${idx}\n\nFix \`add(a, b)\` in \`adder.js\` so it returns \`a + b\`.\n\n${padDesc}\n`,
      );
      writeExFile(
        exDir,
        '.meta/config.json',
        JSON.stringify(
          {
            title: `Adder JS ${idx}`,
            files: {
              solution: ['adder.js'],
              test: ['adder.spec.js'],
              example: ['.meta/proof.ci.js'],
            },
          },
          null,
          2,
        ),
      );
      writeExFile(
        exDir,
        '.meta/proof.ci.js',
        'export function add(a, b) {\n  return a + b;\n}\n',
      );
      writeExFile(
        exDir,
        'package.json',
        JSON.stringify(
          {
            name: slug,
            version: '1.0.0',
            type: 'module',
            scripts: { test: 'node --test adder.spec.js' },
          },
          null,
          2,
        ),
      );
      writeExFile(
        exDir,
        'adder.js',
        'export function add(a, b) {\n  return a - b; // BUG: should add\n}\n',
      );
      writeExFile(
        exDir,
        'adder.spec.js',
        [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { add } from './adder.js';",
          '',
          "test('adds positive numbers', () => {",
          '  assert.equal(add(2, 3), 5);',
          '  assert.equal(add(10, 25), 35);',
          '});',
          '',
        ].join('\n'),
      );
    }

    // 2. Python (runnable natively via `pytest`)
    {
      const slug = `adder-py-${idx}`;
      const exDir = join(rootDir, 'python', 'exercises', 'practice', slug);
      writeExFile(
        exDir,
        '.docs/instructions.md',
        `# Adder Python ${idx}\n\nFix \`add(a, b)\` in \`adder.py\` so it returns \`a + b\`.\n\n${padDesc}\n`,
      );
      writeExFile(
        exDir,
        '.meta/config.json',
        JSON.stringify(
          {
            title: `Adder Python ${idx}`,
            files: {
              solution: ['adder.py'],
              test: ['adder_test.py'],
              example: ['.meta/example.py'],
            },
          },
          null,
          2,
        ),
      );
      writeExFile(exDir, '.meta/example.py', 'def add(a: int, b: int) -> int:\n    return a + b\n');
      writeExFile(
        exDir,
        'adder.py',
        'def add(a: int, b: int) -> int:\n    return a - b  # BUG: should add\n',
      );
      writeExFile(
        exDir,
        'adder_test.py',
        [
          'from adder import add',
          '',
          'def test_adds_positive_numbers():',
          '    assert add(2, 3) == 5',
          '    assert add(10, 25) == 35',
          '',
        ].join('\n'),
      );
    }

    // 3. Go
    {
      const slug = `adder-go-${idx}`;
      const exDir = join(rootDir, 'go', 'exercises', 'practice', slug);
      writeExFile(
        exDir,
        '.docs/instructions.md',
        `# Adder Go ${idx}\n\nFix \`Add(a, b int) int\` in \`adder.go\` so it returns \`a + b\`.\n\n${padDesc}\n`,
      );
      writeExFile(
        exDir,
        '.meta/config.json',
        JSON.stringify(
          {
            title: `Adder Go ${idx}`,
            files: {
              solution: ['adder.go'],
              test: ['adder_test.go'],
              example: ['.meta/example.go'],
            },
          },
          null,
          2,
        ),
      );
      writeExFile(exDir, '.meta/example.go', 'package adder\n\nfunc Add(a, b int) int { return a + b }\n');
      writeExFile(exDir, 'go.mod', `module example.com/${slug}\n\ngo 1.21\n`);
      writeExFile(
        exDir,
        'adder.go',
        'package adder\n\nfunc Add(a, b int) int {\n\treturn a - b // BUG: should add\n}\n',
      );
      writeExFile(
        exDir,
        'adder_test.go',
        [
          'package adder',
          '',
          'import "testing"',
          '',
          'func TestAdd(t *testing.T) {',
          '\tif got := Add(2, 3); got != 5 {',
          '\t\tt.Fatalf("Add(2, 3) = %d, want 5", got)',
          '\t}',
          '}',
          '',
        ].join('\n'),
      );
    }

    // 4. Rust
    {
      const slug = `adder-rs-${idx}`;
      const exDir = join(rootDir, 'rust', 'exercises', 'practice', slug);
      writeExFile(
        exDir,
        '.docs/instructions.md',
        `# Adder Rust ${idx}\n\nFix \`pub fn add(a: i32, b: i32) -> i32\` in \`src/lib.rs\` so it returns \`a + b\`.\n\n${padDesc}\n`,
      );
      writeExFile(
        exDir,
        '.meta/config.json',
        JSON.stringify(
          {
            title: `Adder Rust ${idx}`,
            files: {
              solution: ['src/lib.rs'],
              test: ['tests/adder.rs'],
              example: ['.meta/example.rs'],
            },
          },
          null,
          2,
        ),
      );
      writeExFile(exDir, '.meta/example.rs', 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n');
      writeExFile(
        exDir,
        'Cargo.toml',
        `[package]\nname = "adder_rs_${idx}"\nversion = "0.1.0"\nedition = "2021"\n`,
      );
      writeExFile(
        exDir,
        'src/lib.rs',
        'pub fn add(a: i32, b: i32) -> i32 {\n    a - b // BUG: should add\n}\n',
      );
      writeExFile(
        exDir,
        'tests/adder.rs',
        [
          `use adder_rs_${idx}::add;`,
          '',
          '#[test]',
          'fn test_add() {',
          '    assert_eq!(add(2, 3), 5);',
          '}',
          '',
        ].join('\n'),
      );
    }

    // 5. Java (Gradle)
    {
      const slug = `adder-java-${idx}`;
      const exDir = join(rootDir, 'java', 'exercises', 'practice', slug);
      writeExFile(
        exDir,
        '.docs/instructions.md',
        `# Adder Java ${idx}\n\nFix \`Adder.add(int a, int b)\` in \`src/main/java/Adder.java\` so it returns \`a + b\`.\n\n${padDesc}\n`,
      );
      writeExFile(
        exDir,
        '.meta/config.json',
        JSON.stringify(
          {
            title: `Adder Java ${idx}`,
            files: {
              solution: ['src/main/java/Adder.java'],
              test: ['src/test/java/AdderTest.java'],
              example: ['.meta/src/reference/java/Adder.java'],
            },
          },
          null,
          2,
        ),
      );
      writeExFile(
        exDir,
        '.meta/src/reference/java/Adder.java',
        'public class Adder { public static int add(int a, int b) { return a + b; } }\n',
      );
      writeExFile(
        exDir,
        'settings.gradle',
        `rootProject.name = '${slug}'\n`,
      );
      writeExFile(
        exDir,
        'build.gradle',
        [
          'def wsDir = project.projectDir',
          "tasks.register('test') {",
          '    doLast {',
          "        def outDir = new File(wsDir, 'build/classes')",
          '        outDir.mkdirs()',
          "        def javaHome = new File(System.getProperty('java.home'))",
          "        def isWin = System.getProperty('os.name').toLowerCase().contains('win')",
          '        def findTool = { String name ->',
          '            def exe = isWin ? "${name}.exe" : name',
          '            def c1 = new File(javaHome, "bin/${exe}")',
          '            if (c1.exists()) return c1.absolutePath',
          '            def c2 = javaHome.parentFile ? new File(javaHome.parentFile, "bin/${exe}") : null',
          '            if (c2 && c2.exists()) return c2.absolutePath',
          '            return name',
          '        }',
          '        def runCmd = { List<String> cmd, String label ->',
          '            def proc = new ProcessBuilder(cmd)',
          '                .directory(wsDir)',
          '                .redirectErrorStream(true)',
          '                .start()',
          "            def out = proc.inputStream.getText('UTF-8')",
          '            def code = proc.waitFor()',
          '            if (out) println(out)',
          '            if (code != 0) {',
          '                throw new org.gradle.api.GradleException("${label} failed with exit code ${code}")',
          '            }',
          '        }',
          "        runCmd([findTool('javac'), '-d', outDir.absolutePath, 'src/main/java/Adder.java', 'src/test/java/AdderTest.java'], 'javac')",
          "        runCmd([findTool('java'), '-cp', outDir.absolutePath, 'AdderTest'], 'AdderTest')",
          '    }',
          '}',
          '',
        ].join('\n'),
      );
      writeExFile(
        exDir,
        'src/main/java/Adder.java',
        'public class Adder {\n    public static int add(int a, int b) {\n        return a - b; // BUG: should add\n    }\n}\n',
      );
      writeExFile(
        exDir,
        'src/test/java/AdderTest.java',
        [
          'public class AdderTest {',
          '    public void testAdd() {',
          '        if (Adder.add(2, 3) != 5) throw new AssertionError("expected 5");',
          '    }',
          '',
          '    public static void main(String[] args) {',
          '        new AdderTest().testAdd();',
          '    }',
          '}',
          '',
        ].join('\n'),
      );
    }

    // 6. C++ (CMake + CTest)
    {
      const slug = `adder-cpp-${idx}`;
      const exDir = join(rootDir, 'cpp', 'exercises', 'practice', slug);
      writeExFile(
        exDir,
        '.docs/instructions.md',
        `# Adder C++ ${idx}\n\nFix \`add(int a, int b)\` in \`adder.cpp\` so it returns \`a + b\`.\n\n${padDesc}\n`,
      );
      writeExFile(
        exDir,
        '.meta/config.json',
        JSON.stringify(
          {
            title: `Adder C++ ${idx}`,
            files: {
              solution: ['adder.cpp'],
              test: ['adder_test.cpp'],
              example: ['.meta/example.cpp'],
            },
          },
          null,
          2,
        ),
      );
      writeExFile(exDir, '.meta/example.cpp', '#include "adder.h"\nint add(int a, int b) { return a + b; }\n');
      writeExFile(
        exDir,
        'CMakeLists.txt',
        [
          'cmake_minimum_required(VERSION 3.16)',
          `project(adder_cpp_${idx} CXX)`,
          'enable_testing()',
          'add_executable(adder_test adder.cpp adder_test.cpp)',
          'add_test(NAME adder_test COMMAND adder_test)',
          '',
        ].join('\n'),
      );
      writeExFile(exDir, 'adder.h', '#pragma once\nint add(int a, int b);\n');
      writeExFile(
        exDir,
        'adder.cpp',
        '#include "adder.h"\nint add(int a, int b) {\n    return a - b; // BUG: should add\n}\n',
      );
      writeExFile(
        exDir,
        'adder_test.cpp',
        [
          '#include "adder.h"',
          '#include <cassert>',
          'int main() {',
          '    assert(add(2, 3) == 5);',
          '    return 0;',
          '}',
          '',
        ].join('\n'),
      );
    }
  }

  return {
    benchmarkDir: rootDir,
    cleanup: () => safeRmDir(rootDir),
  };
}

function tokenizeBlocks64(text, blockTokens = CACHE_BLOCK_TOKENS) {
  const s = String(text ?? '');
  if (!s) return { fullBlocks: [], totalTokens: 1 };
  const fullBlocks = [];
  let start = 0;
  let blockWeight = 0;
  let totalWeight = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af);
    const w = isCjk ? 1 / 1.7 : 0.25;
    blockWeight += w;
    totalWeight += w;
    if (blockWeight >= blockTokens) {
      fullBlocks.push(s.slice(start, i + 1));
      start = i + 1;
      blockWeight = 0;
    }
  }
  return {
    fullBlocks,
    totalTokens: Math.max(1, Math.ceil(totalWeight)),
  };
}

function makeOpenAiSseStream(chunks) {
  const encoder = new TextEncoder();
  const payload = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

function makeAnthropicSseStream(events) {
  const encoder = new TextEncoder();
  const payload = events
    .map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
    .join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

function detectBugFixInText(fileText) {
  if (/return a - b;\s*\/\/ BUG: should add/.test(fileText)) {
    return {
      target: 'return a - b; // BUG: should add',
      replacement: 'return a + b;',
    };
  }
  if (/return a - b\s*# BUG: should add/.test(fileText)) {
    return {
      target: 'return a - b  # BUG: should add',
      replacement: 'return a + b',
    };
  }
  if (/return a - b\s*\/\/ BUG: should add/.test(fileText)) {
    return {
      target: 'return a - b // BUG: should add',
      replacement: 'return a + b',
    };
  }
  if (/a - b\s*\/\/ BUG: should add/.test(fileText)) {
    return {
      target: 'a - b // BUG: should add',
      replacement: 'a + b',
    };
  }
  return null;
}

/**
 * Creates a deterministic offline upstream `fetch` implementation for `SweBenchMeteringProxy`
 * supporting OpenAI `/v1/chat/completions` (streaming & non-streaming) and Anthropic
 * `/v1/messages` (streaming & non-streaming), with realistic 64-token prefix-block KV caching.
 */
export function createDryRunMeteringFetch({ exercise, workspaceRoot, mode = 'full_aci' }) {
  const cachedChainHashes = new Set();
  const primarySolution = exercise?.solutionFiles?.[0] ?? null;
  let callCounter = 0;

  const computeUsage = (rawBodyText, outputText) => {
    const { fullBlocks, totalTokens } = tokenizeBlocks64(rawBodyText);
    let prev = 'root';
    let matchedBlocks = 0;
    let intact = true;
    const chains = [];
    for (const block of fullBlocks) {
      const ch = createHash('sha256').update(`${prev}|${block}`, 'utf8').digest('hex');
      chains.push(ch);
      if (intact && cachedChainHashes.has(ch)) {
        matchedBlocks += 1;
      } else {
        intact = false;
      }
      prev = ch;
    }
    for (const ch of chains) cachedChainHashes.add(ch);
    const cacheRead = Math.min(totalTokens, matchedBlocks * CACHE_BLOCK_TOKENS);
    const outputTokens = Math.max(8, estimateTokens(outputText));
    return {
      inputTokens: totalTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: Math.max(0, totalTokens - cacheRead),
    };
  };

  const chooseNextAction = (body, isAnthropic) => {
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    const hasToolId = (id) => {
      if (isAnthropic) {
        return msgs.some(
          (m) =>
            Array.isArray(m?.content) &&
            m.content.some((b) => b?.type === 'tool_result' && b?.tool_use_id === id),
        );
      }
      return msgs.some((m) => m?.role === 'tool' && m?.tool_call_id === id);
    };

    const toolNames = new Set(
      (Array.isArray(body?.tools) ? body.tools : [])
        .map((t) => String(t?.function?.name ?? t?.name ?? '').trim())
        .filter(Boolean),
    );
    const isBashOnly = toolNames.has('bash') && !toolNames.has('read_file') && !toolNames.has('edit_file');

    if (primarySolution && workspaceRoot) {
      const fullSolPath = join(workspaceRoot, primarySolution);
      const solText = isFileSync(fullSolPath) ? readFileSync(fullSolPath, 'utf8') : '';
      const bugFix = detectBugFixInText(solText);

      if (isBashOnly) {
        const nodeCmd = `${JSON.stringify(process.execPath)} --input-type=commonjs`;
        if (!hasToolId('poly-dry-inspect')) {
          const inspectJs = `console.log(require('fs').readFileSync(${JSON.stringify(primarySolution)},'utf8'))`;
          return {
            toolCalls: [
              {
                id: 'poly-dry-inspect',
                name: 'bash',
                arguments: {
                  command: `${nodeCmd} -e ${JSON.stringify(inspectJs)}`,
                },
              },
            ],
            finalText: '',
          };
        }
        if (bugFix && !hasToolId('poly-dry-edit')) {
          const patchJs = `const fs=require('fs');const p=${JSON.stringify(primarySolution)};const s=fs.readFileSync(p,'utf8').replace(${JSON.stringify(bugFix.target)},${JSON.stringify(bugFix.replacement)});fs.writeFileSync(p,s,'utf8');console.log('patched '+p);`;
          return {
            toolCalls: [
              {
                id: 'poly-dry-edit',
                name: 'bash',
                arguments: { command: `${nodeCmd} -e ${JSON.stringify(patchJs)}` },
              },
            ],
            finalText: '',
          };
        }
        return {
          toolCalls: [],
          finalText: `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\nUpdated ${primarySolution} for ${exercise.id} (${mode}).`,
        };
      }

      if (toolNames.has('read_file') && !hasToolId('poly-dry-read')) {
        return {
          toolCalls: [
            {
              id: 'poly-dry-read',
              name: 'read_file',
              arguments: { path: primarySolution },
            },
          ],
          finalText: '',
        };
      }
      if (bugFix && toolNames.has('edit_file') && !hasToolId('poly-dry-edit')) {
        return {
          toolCalls: [
            {
              id: 'poly-dry-edit',
              name: 'edit_file',
              arguments: {
                path: primarySolution,
                target: bugFix.target,
                replacement: bugFix.replacement,
              },
            },
          ],
          finalText: '',
        };
      }
    }

    return {
      toolCalls: [],
      finalText: `Completed ${exercise?.id ?? 'exercise'} in dry-run mode (${mode}).`,
    };
  };

  return async function dryRunFetch(url, init = {}) {
    callCounter += 1;
    const rawBody = typeof init.body === 'string' ? init.body : '';
    let body = {};
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      body = {};
    }

    const urlStr = String(url ?? '');
    const isAnthropic = /\/messages(?:\?|$)/i.test(urlStr);
    const model = String(body.model || POLYGLOT_DEFAULT_MODEL);
    const wantStream = Boolean(body.stream);
    const action = chooseNextAction(body, isAnthropic);
    const emittedText =
      action.toolCalls.length > 0
        ? JSON.stringify(action.toolCalls)
        : action.finalText;
    const usage = computeUsage(rawBody || JSON.stringify(body), emittedText);

    if (isAnthropic) {
      const contentBlocks =
        action.toolCalls.length > 0
          ? action.toolCalls.map((tc) => ({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            }))
          : [{ type: 'text', text: action.finalText }];
      const stopReason = action.toolCalls.length > 0 ? 'tool_use' : 'end_turn';

      if (wantStream) {
        const events = [
          {
            type: 'message_start',
            message: {
              id: `msg_dry_${callCounter}`,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              usage: {
                input_tokens: usage.inputTokens,
                output_tokens: 1,
                cache_read_input_tokens: usage.cacheReadTokens,
                cache_creation_input_tokens: usage.cacheWriteTokens,
              },
            },
          },
        ];
        contentBlocks.forEach((blk, idx) => {
          if (blk.type === 'tool_use') {
            events.push({
              type: 'content_block_start',
              index: idx,
              content_block: { type: 'tool_use', id: blk.id, name: blk.name, input: {} },
            });
            events.push({
              type: 'content_block_delta',
              index: idx,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(blk.input) },
            });
            events.push({ type: 'content_block_stop', index: idx });
          } else {
            events.push({
              type: 'content_block_start',
              index: idx,
              content_block: { type: 'text', text: '' },
            });
            events.push({
              type: 'content_block_delta',
              index: idx,
              delta: { type: 'text_delta', text: blk.text },
            });
            events.push({ type: 'content_block_stop', index: idx });
          }
        });
        events.push({
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: usage.outputTokens },
        });
        events.push({ type: 'message_stop' });
        return new Response(makeAnthropicSseStream(events), {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        });
      }

      return new Response(
        JSON.stringify({
          id: `msg_dry_${callCounter}`,
          type: 'message',
          role: 'assistant',
          model,
          content: contentBlocks,
          stop_reason: stopReason,
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_read_input_tokens: usage.cacheReadTokens,
            cache_creation_input_tokens: usage.cacheWriteTokens,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // OpenAI Chat Completions format
    const openAiUsage = {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
      prompt_tokens_details: {
        cached_tokens: usage.cacheReadTokens,
      },
    };

    if (wantStream) {
      const id = `chatcmpl_dry_${callCounter}`;
      const created = Math.floor(Date.now() / 1000);
      const chunks = [];
      if (action.toolCalls.length > 0) {
        chunks.push({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: action.toolCalls.map((tc, idx) => ({
                  index: idx,
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                  },
                })),
              },
              finish_reason: null,
            },
          ],
        });
        chunks.push({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        });
      } else {
        chunks.push({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: action.finalText },
              finish_reason: null,
            },
          ],
        });
        chunks.push({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
      }
      chunks.push({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: openAiUsage,
      });

      return new Response(makeOpenAiSseStream(chunks), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    }

    const message =
      action.toolCalls.length > 0
        ? {
            role: 'assistant',
            content: null,
            tool_calls: action.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          }
        : {
            role: 'assistant',
            content: action.finalText,
          };

    return new Response(
      JSON.stringify({
        id: `chatcmpl_dry_${callCounter}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: action.toolCalls.length > 0 ? 'tool_calls' : 'stop',
          },
        ],
        usage: openAiUsage,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

/**
 * Authorizes coding & local build/test tool calls inside isolated Polyglot workspaces.
 */
export function isAuthorizedPolyglotToolCall(toolName, args = {}) {
  const name = String(toolName ?? '').trim();
  if (
    [
      'read_file',
      'edit_file',
      'write_file',
      'apply_patch',
      'glob',
      'grep',
      'expand_context',
    ].includes(name)
  ) {
    return true;
  }
  if (name === 'bash') {
    const cmd = String(args?.command ?? '').trim();
    if (!cmd) return false;
    const analysis = analyzeCommand(cmd);
    if (analysis.hardBlocked) return false;
    if (/(?:^|[\s/\\])\.meta(?:[/\\]|$)/i.test(cmd)) return false;
    return true;
  }
  return false;
}

/**
 * Resolves upstream provider credentials/endpoint/model for Polyglot runs, honoring
 * `POLYGLOT_*` overrides, `SWEBENCH_*` / standard provider env vars, and optional App Pool.
 */
export function resolvePolyglotProviderConfig(opts = {}, runtimeDeps = {}) {
  if (opts?.dryRun) {
    return {
      apiKey: PLACEHOLDER_PROXY_KEY,
      endpoint: 'https://polyglot-dry-run.invalid/v1',
      protocol: String(opts?.protocol || 'openai').trim().toLowerCase() === 'anthropic'
        ? 'anthropic'
        : 'openai',
      model: String(opts?.model || POLYGLOT_DEFAULT_MODEL).trim(),
      customHeaders: null,
      fetchImpl: null,
    };
  }

  const baseEnv = runtimeDeps.env ?? process.env;
  const mergedEnv = {
    ...baseEnv,
    ...(baseEnv.POLYGLOT_API_KEY && !baseEnv.SWEBENCH_API_KEY
      ? { SWEBENCH_API_KEY: baseEnv.POLYGLOT_API_KEY }
      : {}),
    ...(baseEnv.POLYGLOT_ENDPOINT && !baseEnv.SWEBENCH_ENDPOINT
      ? { SWEBENCH_ENDPOINT: baseEnv.POLYGLOT_ENDPOINT }
      : {}),
    ...(baseEnv.POLYGLOT_PROTOCOL && !baseEnv.SWEBENCH_PROTOCOL
      ? { SWEBENCH_PROTOCOL: baseEnv.POLYGLOT_PROTOCOL }
      : {}),
    ...(baseEnv.POLYGLOT_MODEL && !baseEnv.SWEBENCH_MODEL
      ? { SWEBENCH_MODEL: baseEnv.POLYGLOT_MODEL }
      : {}),
  };

  const wantAppPool =
    opts.useAppPool === true ||
    (opts.useAppPool !== false &&
      (Boolean(opts.appDataDir) || !hasExplicitEnvProviderKey(mergedEnv)));

  if (wantAppPool) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'agent-us-polyglot-pool-'));
    const store = new Store(join(tmpDir, 'pool.sqlite'));
    const pool = new AccountPool(store, { root: tmpDir });
    try {
      const cloneFn = runtimeDeps.loadAppPoolReadOnly ?? loadAppPoolReadOnly;
      const cloned = cloneFn({
        appDataDir: opts.appDataDir ?? null,
        explicitDir: opts.appDataDir ?? null,
        targetStore: store,
        targetPool: pool,
        model: opts.model || POLYGLOT_DEFAULT_MODEL,
        env: mergedEnv,
      });
      const resolvedModel =
        String(opts.model || cloned?.defaultModel || POLYGLOT_DEFAULT_MODEL).trim();
      const route = pool.resolveRoutes(resolvedModel)?.[0] ?? null;
      if (!route?.endpoint) {
        const err = new Error(
          `No healthy App Pool route found for Polyglot model "${resolvedModel}". Pass --no-use-app-pool with SWEBENCH_API_KEY/POLYGLOT_API_KEY.`,
        );
        err.isFatalConfigError = true;
        throw err;
      }
      return {
        apiKey: route.apiKey ?? '',
        endpoint: route.endpoint,
        protocol: route.protocol || 'openai',
        model: route.wireModel || resolvedModel,
        customHeaders: route.customHeaders ?? null,
        fetchImpl: route.fetch ?? fetch,
      };
    } finally {
      store.close();
      safeRmDir(tmpDir);
    }
  }

  const live = resolveLiveProviderConfig(
    {
      model: opts.model || POLYGLOT_DEFAULT_MODEL,
      endpoint: opts.endpoint,
      protocol: opts.protocol,
      apiKey: opts.apiKey,
    },
    mergedEnv,
  );
  if (!live.apiKey) {
    const err = new Error(
      'Live Polyglot benchmark requires SWEBENCH_API_KEY / POLYGLOT_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY (or --use-app-pool / --dry-run).',
    );
    err.isFatalConfigError = true;
    throw err;
  }
  return {
    apiKey: live.apiKey,
    endpoint: live.endpoint,
    protocol: live.protocol || 'openai',
    model: String(opts.model || live.model || POLYGLOT_DEFAULT_MODEL).trim(),
    customHeaders: null,
    fetchImpl: fetch,
  };
}

async function runDirectAgentPolyglotMode({
  exercise,
  mode,
  workspaceRoot,
  prompt,
  proxy,
  targetModel,
  protocol,
  maxSteps,
  timeoutMs,
  dryRun,
}) {
  const stateDir = mkdtempSync(join(tmpdir(), `agent-us-polyglot-state-${mode}-`));
  const store = new Store(join(stateDir, 'polyglot.sqlite'));
  const metrics = new MetricsCollector({ store });
  const pool = new AccountPool(store, { root: stateDir, metrics });

  const useAnthropic = protocol === 'anthropic';
  pool.createAccount({
    preset: useAnthropic ? 'custom-anthropic' : 'custom-openai',
    label: `polyglot-proxy-${mode}`,
    credential: PLACEHOLDER_PROXY_KEY,
    protocol: useAnthropic ? 'anthropic' : 'openai',
    endpoint: useAnthropic ? proxy.anthropicBaseUrl : proxy.openaiBaseUrl,
    models: [targetModel],
  });
  pool.setDefaultModel(targetModel);

  const supExec = resolveSupervisorExecutionConfig({
    arm: mode,
    mainModel: targetModel,
    deterministicAdmission: true,
    availableModels: [targetModel],
    targetPool: pool,
  });
  store.setSetting?.(ACI_CONFIG_KEY, {
    enabled: Boolean(supExec.enabled),
    mode: supExec.mode,
    model: supExec.model ?? null,
    admissionEnabled: Boolean(supExec.admissionEnabled),
  });

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workspaceRoot,
    dataRoot: stateDir,
    metrics,
  });

  let unsub = null;
  try {
    const session = direct.createSession({
      title: `Polyglot · ${exercise.id} (${mode})`,
      workspaceRoot,
      model: targetModel,
      permissionMode: 'auto-safe',
      aciProfile: mode,
      budget: { maxSteps },
      isSynthetic: Boolean(dryRun),
    });

    unsub = direct.subscribe(session.id, (evt) => {
      if (evt?.type !== 'approval/requested') return;
      const item = evt.data;
      const allowed = isAuthorizedPolyglotToolCall(item.tool, item.arguments);
      queueMicrotask(() => {
        try {
          direct.decideApproval(item.approvalId, {
            decision: allowed ? 'allow' : 'deny',
            scope: 'once',
            reason: allowed
              ? 'Authorized Polyglot coding/verification tool'
              : 'Denied restricted tool call',
          });
        } catch {
          // Turn may already be closed
        }
      });
    });

    const { turn } = direct.startTurn(session.id, {
      input: prompt,
      model: targetModel,
      permissionMode: 'auto-safe',
      maxSteps,
      aciProfile: mode,
      isSynthetic: Boolean(dryRun),
    });

    const deadline = performance.now() + timeoutMs;
    let turnRow = null;
    while (performance.now() < deadline) {
      turnRow = direct.listTurns(session.id, { limit: 20 }).find((t) => t.id === turn.id);
      if (['completed', 'failed', 'cancelled', 'reconciling'].includes(turnRow?.state)) {
        break;
      }
      await delay(20);
    }

    let timedOut = false;
    if (!['completed', 'failed', 'cancelled', 'reconciling'].includes(turnRow?.state)) {
      timedOut = true;
      direct.cancelTurn(turn.id);
      await direct.waitForTurnTerminal(turn.id, { timeoutMs: 5_000 }).catch(() => {});
      turnRow = direct.listTurns(session.id, { limit: 20 }).find((t) => t.id === turn.id) ?? turnRow;
    } else if (turnRow?.state !== 'reconciling') {
      await direct.waitForTurnTerminal(turn.id, { timeoutMs: 5_000 }).catch(() => {});
    }

    const receiptCount = Number(
      store.db
        .prepare('SELECT COUNT(*) AS n FROM tool_receipts WHERE sessionId=? AND turnId=?')
        .get(session.id, turn.id)?.n ?? 0,
    );

    const status = timedOut
      ? 'failed'
      : turnRow?.state === 'completed'
        ? 'completed'
        : 'failed';
    const error = timedOut
      ? `${mode} timed out after ${timeoutMs}ms`
      : turnRow?.error
        ? redactSecrets(String(turnRow.error))
        : status === 'failed'
          ? `${mode} ended with state=${turnRow?.state ?? 'unknown'}`
          : null;

    return {
      status,
      error,
      toolCallsCount: receiptCount,
    };
  } finally {
    try {
      unsub?.();
      await direct.close();
    } finally {
      store.close();
      safeRmDir(stateDir);
    }
  }
}

function truncateToolOutput(text, maxChars = 16_000) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  const half = Math.floor((maxChars - 120) / 2);
  return `${s.slice(0, half)}\n\n...[truncated ${s.length - maxChars} chars]...\n\n${s.slice(-half)}`;
}

async function execWorkspaceShellCommand(cmd, { workspaceRoot, baseEnv, timeoutMs }) {
  const trimmed = String(cmd ?? '').trim();
  if (!trimmed) return { exitCode: 2, output: 'Error: empty bash command' };
  const analysis = analyzeCommand(trimmed);
  if (analysis.hardBlocked) {
    return { exitCode: 126, output: `Blocked hard-restricted command: ${trimmed}` };
  }
  if (/(?:^|[\s/\\])\.meta(?:[/\\]|$)/i.test(trimmed)) {
    return { exitCode: 126, output: `Blocked restricted .meta access: ${trimmed}` };
  }

  const sanitized = sanitizeChildEnv(baseEnv, {
    allowKeys: [
      'PATH',
      'Path',
      'HOME',
      'USERPROFILE',
      'CARGO_HOME',
      'RUSTUP_HOME',
      'GOPATH',
      'JAVA_HOME',
      'NODE_PATH',
      'SystemRoot',
      'COMSPEC',
      'ComSpec',
      'TEMP',
      'TMP',
      'TMPDIR',
    ],
  });
  delete sanitized.NODE_TEST_CONTEXT;

  return new Promise((resolveCmd) => {
    const child =
      process.platform === 'win32'
        ? spawn(trimmed, [], {
            cwd: workspaceRoot,
            env: sanitized,
            shell: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn('bash', ['-c', trimmed], {
            cwd: workspaceRoot,
            env: sanitized,
            shell: false,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 64 * 1024;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, Math.max(1_000, Math.min(timeoutMs, 120_000)));

    child.stdout?.on('data', (d) => {
      if (stdout.length < cap) stdout += Buffer.from(d).toString('utf8').slice(0, cap - stdout.length);
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < cap) stderr += Buffer.from(d).toString('utf8').slice(0, cap - stderr.length);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveCmd({ exitCode: 1, output: `Command error: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = [stdout, stderr].filter(Boolean).join('\n');
      resolveCmd({
        exitCode: timedOut ? 124 : code ?? 1,
        output: truncateToolOutput(
          timedOut ? `${body}\n[timeout]`.trim() : body || `(exit ${code ?? 1}, no output)`,
        ),
      });
    });
  });
}

async function runDryRunAnthropicAgentLoop({
  workspaceRoot,
  prompt,
  proxy,
  targetModel,
  maxSteps,
  timeoutMs,
  baseEnv,
}) {
  const deadline = performance.now() + timeoutMs;
  const tools = [
    {
      name: 'read_file',
      description: 'Read a file relative to the workspace root.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    {
      name: 'edit_file',
      description: 'Replace target text in a workspace file.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          target: { type: 'string' },
          replacement: { type: 'string' },
        },
        required: ['path', 'target', 'replacement'],
      },
    },
    {
      name: 'bash',
      description: 'Execute a shell command in the workspace.',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  ];

  const messages = [{ role: 'user', content: prompt }];
  let toolCallsCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    const remainingMs = Math.round(deadline - performance.now());
    if (remainingMs <= 0) {
      return {
        status: 'failed',
        toolCallsCount,
        error: `claude_code dry-run timed out after ${timeoutMs}ms`,
      };
    }

    const res = await fetch(`${proxy.anthropicBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': PLACEHOLDER_PROXY_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: targetModel,
        max_tokens: 2048,
        messages,
        tools,
      }),
      signal: AbortSignal.timeout(Math.min(remainingMs, 120_000)),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return {
        status: 'failed',
        toolCallsCount,
        error: `claude_code dry-run HTTP ${res.status}: ${errBody.slice(0, 300)}`,
      };
    }
    const json = await res.json();
    const blocks = Array.isArray(json?.content) ? json.content : [];
    const toolUses = blocks.filter((b) => b?.type === 'tool_use');
    if (toolUses.length === 0) {
      return { status: 'completed', toolCallsCount, error: null };
    }

    messages.push({ role: 'assistant', content: blocks });
    const toolResults = [];
    for (const tu of toolUses) {
      toolCallsCount += 1;
      const input = tu.input && typeof tu.input === 'object' ? tu.input : {};
      let resultText = '';
      if (tu.name === 'read_file') {
        const target = resolve(workspaceRoot, String(input.path ?? ''));
        resultText = isFileSync(target) ? readFileSync(target, 'utf8') : 'File not found';
      } else if (tu.name === 'edit_file') {
        const target = resolve(workspaceRoot, String(input.path ?? ''));
        if (isFileSync(target)) {
          const cur = readFileSync(target, 'utf8');
          const next = cur.replace(String(input.target ?? ''), String(input.replacement ?? ''));
          writeFileSync(target, next, 'utf8');
          resultText = `Edited ${input.path}`;
        } else {
          resultText = 'File not found';
        }
      } else if (tu.name === 'bash') {
        const execRes = await execWorkspaceShellCommand(input.command, {
          workspaceRoot,
          baseEnv,
          timeoutMs: remainingMs,
        });
        resultText = `exitCode: ${execRes.exitCode}\n${execRes.output}`;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: resultText,
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    status: 'failed',
    toolCallsCount,
    error: `claude_code reached maxSteps (${maxSteps})`,
  };
}

async function runClaudeCodePolyglotMode({
  workspaceRoot,
  prompt,
  proxy,
  targetModel,
  maxSteps,
  timeoutMs,
  dryRun,
  runtimeDeps,
  baseEnv,
}) {
  const explicitBin = String(
    runtimeDeps.claudeBin || baseEnv.POLYGLOT_CLAUDE_BIN || baseEnv.SWEBENCH_CLAUDE_BIN || '',
  ).trim();

  if (dryRun && !explicitBin) {
    return runDryRunAnthropicAgentLoop({
      workspaceRoot,
      prompt,
      proxy,
      targetModel,
      maxSteps,
      timeoutMs,
      baseEnv,
    });
  }

  const bin = explicitBin || 'claude';
  const isolatedHome = mkdtempSync(join(tmpdir(), 'agent-us-polyglot-claude-home-'));
  try {
    mkdirSync(join(isolatedHome, '.claude'), { recursive: true });
    writeFileSync(
      join(isolatedHome, '.claude.json'),
      JSON.stringify({ hasCompletedOnboarding: true }),
      'utf8',
    );
    writeFileSync(
      join(isolatedHome, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: {
          allow: ['Bash(*)', 'Read(*)', 'Edit(*)', 'Write(*)', 'MultiEdit(*)', 'Glob(*)', 'Grep(*)'],
        },
      }),
      'utf8',
    );

    const sanitized = sanitizeChildEnv(baseEnv, {
      allowKeys: [
        'PATH',
        'Path',
        'CARGO_HOME',
        'RUSTUP_HOME',
        'GOPATH',
        'JAVA_HOME',
        'NODE_PATH',
        'SystemRoot',
        'COMSPEC',
      ],
    });
    const childEnv = {
      ...sanitized,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, '.config'),
      XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
      XDG_CACHE_HOME: join(isolatedHome, '.cache'),
      ANTHROPIC_BASE_URL: proxy.anthropicBaseUrl,
      ANTHROPIC_API_KEY: PLACEHOLDER_PROXY_KEY,
      ANTHROPIC_MODEL: targetModel,
      ANTHROPIC_SMALL_FAST_MODEL: targetModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: targetModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: targetModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: targetModel,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    };
    delete childEnv.ANTHROPIC_AUTH_TOKEN;

    const args = ['-p', prompt, '--dangerously-skip-permissions', '--max-turns', String(maxSteps)];
    const res = await runSubprocessWithTimeout({
      bin,
      args,
      cwd: workspaceRoot,
      env: childEnv,
      timeoutMs,
    });

    if (res.notFound) {
      return {
        status: 'env_error',
        toolCallsCount: 0,
        error: `External CLI "${bin}" not found. Install via \`npm install -g @anthropic-ai/claude-code\` or set POLYGLOT_CLAUDE_BIN.`,
      };
    }
    return {
      status: res.timedOut ? 'failed' : res.exitCode === 0 ? 'completed' : 'failed',
      toolCallsCount: 0,
      error: res.timedOut
        ? `claude_code timed out after ${timeoutMs}ms`
        : res.exitCode === 0
          ? null
          : `claude_code exited with code ${res.exitCode}: ${summarizeCliFailureOutput(res.stderr, res.stdout, 900)}`,
    };
  } finally {
    safeRmDir(isolatedHome);
  }
}

function extractFencedBash(text) {
  const match = /```(?:bash|sh)\s*\r?\n([\s\S]*?)\r?\n```/i.exec(String(text ?? ''));
  return match ? match[1].trim() : null;
}

async function runBuiltinMiniSwePolyglotLoop({
  workspaceRoot,
  prompt,
  proxy,
  targetModel,
  maxSteps,
  timeoutMs,
  baseEnv,
}) {
  const deadline = performance.now() + timeoutMs;
  const bashToolSpec = [
    {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Execute a single shell command in the exercise working directory.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute.' },
          },
          required: ['command'],
        },
      },
    },
  ];

  const messages = [
    {
      role: 'system',
      content: [
        'You are mini-swe-agent, a minimal autonomous software engineering baseline.',
        'Solve the programming exercise using ONLY the `bash` tool (one command per step).',
        'Inspect files, apply minimal edits to the solution file(s), and run the verification command to confirm all tests pass.',
        'When done, reply without tool calls starting with COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT.',
      ].join(' '),
    },
    { role: 'user', content: prompt },
  ];

  let toolCallsCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    const remainingMs = Math.round(deadline - performance.now());
    if (remainingMs <= 0) {
      return {
        status: 'failed',
        toolCallsCount,
        error: `mini_swe_agent timed out after ${timeoutMs}ms`,
      };
    }

    let res = null;
    let rawText = '';
    let fetchErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(`${proxy.openaiBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${PLACEHOLDER_PROXY_KEY}`,
          },
          body: JSON.stringify({
            model: targetModel,
            messages,
            tools: bashToolSpec,
          }),
          signal: AbortSignal.timeout(Math.min(Math.max(1_000, remainingMs), 180_000)),
        });
        rawText = await res.text();
        fetchErr = null;
        if (res.status >= 500 && attempt === 0 && deadline - performance.now() > 30_000) {
          continue;
        }
        break;
      } catch (err) {
        fetchErr = err;
        res = null;
        if (attempt === 0 && deadline - performance.now() > 30_000) {
          continue;
        }
        break;
      }
    }

    if (fetchErr || !res) {
      return {
        status: 'failed',
        toolCallsCount,
        error: `mini_swe_agent LLM request failed: ${redactSecrets(String(fetchErr?.message || fetchErr || 'unknown')).slice(0, 400)}`,
      };
    }
    if (!res.ok) {
      return {
        status: 'failed',
        toolCallsCount,
        error: `mini_swe_agent LLM HTTP ${res.status}: ${rawText.slice(0, 400)}`,
      };
    }

    let json;
    try {
      json = JSON.parse(rawText);
    } catch {
      return {
        status: 'failed',
        toolCallsCount,
        error: 'mini_swe_agent received non-JSON completion response',
      };
    }

    const msg = json?.choices?.[0]?.message;
    if (!msg) {
      return {
        status: 'failed',
        toolCallsCount,
        error: 'mini_swe_agent response missing choices[0].message',
      };
    }

    const contentStr = typeof msg.content === 'string' ? msg.content : '';
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: contentStr || null,
        tool_calls: toolCalls,
      });
      for (const tc of toolCalls) {
        let cmd = '';
        try {
          const parsedArgs =
            typeof tc?.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc?.function?.arguments ?? {};
          cmd = String(parsedArgs.command ?? '');
        } catch {
          cmd = '';
        }
        toolCallsCount += 1;
        const execRes = await execWorkspaceShellCommand(cmd, {
          workspaceRoot,
          baseEnv,
          timeoutMs: Math.max(1_000, Math.round(deadline - performance.now())),
        });
        messages.push({
          role: 'tool',
          tool_call_id: String(tc.id || `call_${step}`),
          content: `returncode: ${execRes.exitCode}\noutput:\n${execRes.output}`,
        });
      }
      continue;
    }

    const fenced = !contentStr.includes('COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT')
      ? extractFencedBash(contentStr)
      : null;
    if (fenced) {
      messages.push({ role: 'assistant', content: contentStr });
      toolCallsCount += 1;
      const execRes = await execWorkspaceShellCommand(fenced, {
        workspaceRoot,
        baseEnv,
        timeoutMs: Math.max(1_000, Math.round(deadline - performance.now())),
      });
      messages.push({
        role: 'user',
        content: `<returncode>${execRes.exitCode}</returncode>\n<output>\n${execRes.output}\n</output>`,
      });
      continue;
    }

    return { status: 'completed', toolCallsCount, error: null };
  }

  return {
    status: 'failed',
    toolCallsCount,
    error: `mini_swe_agent reached maxSteps (${maxSteps})`,
  };
}

async function runMiniSweAgentPolyglotMode({
  workspaceRoot,
  prompt,
  proxy,
  targetModel,
  maxSteps,
  timeoutMs,
  dryRun,
  runtimeDeps,
  baseEnv,
}) {
  const forceBuiltin =
    Boolean(dryRun) ||
    Boolean(runtimeDeps.forceBuiltinMiniSweAgent) ||
    String(baseEnv?.SWEBENCH_MINI_SWE_AGENT_MODE ?? '').trim().toLowerCase() === 'builtin';

  if (!forceBuiltin) {
    const explicitBin = String(
      runtimeDeps.miniSweAgentBin ||
        baseEnv?.POLYGLOT_MINI_SWE_AGENT_BIN ||
        baseEnv?.SWEBENCH_MINI_SWE_AGENT_BIN ||
        '',
    ).trim();
    const externalBin = explicitBin || resolveExecutableOnPath('minisweagent', baseEnv);
    if (externalBin) {
      const isolatedHome = mkdtempSync(join(tmpdir(), 'agent-us-polyglot-mini-home-'));
      try {
        const sanitized = sanitizeChildEnv(baseEnv, {
          allowKeys: ['PATH', 'Path', 'CARGO_HOME', 'RUSTUP_HOME', 'GOPATH', 'JAVA_HOME', 'NODE_PATH'],
        });
        const childEnv = {
          ...sanitized,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          OPENAI_API_KEY: PLACEHOLDER_PROXY_KEY,
          OPENAI_API_BASE: proxy.openaiBaseUrl,
          OPENAI_BASE_URL: proxy.openaiBaseUrl,
          MSWEA_MODEL_NAME: `openai/${targetModel}`,
          MSWEA_COST_TRACKING: 'ignore_errors',
          MSWEA_CONFIGURED: 'true',
        };
        const res = await runSubprocessWithTimeout({
          bin: externalBin,
          args: ['-m', targetModel, '-t', prompt, '-y', '--exit-immediately'],
          cwd: workspaceRoot,
          env: childEnv,
          timeoutMs,
        });
        if (!res.notFound && proxy.getMetrics().steps > 0) {
          return {
            status: res.timedOut ? 'failed' : res.exitCode === 0 ? 'completed' : 'failed',
            toolCallsCount: 0,
            error: res.timedOut
              ? `mini_swe_agent timed out after ${timeoutMs}ms`
              : res.exitCode === 0
                ? null
                : `mini_swe_agent CLI exited with code ${res.exitCode}: ${summarizeCliFailureOutput(res.stderr, res.stdout, 900)}`,
          };
        }
      } finally {
        safeRmDir(isolatedHome);
      }
    }
  }

  return runBuiltinMiniSwePolyglotLoop({
    workspaceRoot,
    prompt,
    proxy,
    targetModel,
    maxSteps,
    timeoutMs,
    baseEnv,
  });
}

/**
 * Executes a single `(exercise, mode)` evaluation trial mounting `SweBenchMeteringProxy`
 * for ALL 4 modes (`raw_full`, `full_aci`, `claude_code`, `mini_swe_agent`), followed by
 * anti-tamper test restoration and native build & test grading.
 */
export async function runPolyglotExerciseMode({
  exercise,
  mode,
  opts = {},
  providerConfig = null,
  runtimeDeps = {},
}) {
  const normMode = String(mode ?? '').trim().toLowerCase();
  if (!VALID_POLYGLOT_MODES.has(normMode)) {
    throw new Error(
      `Unsupported Polyglot mode "${mode}"; expected one of ${POLYGLOT_MODES.join(', ')}`,
    );
  }

  const started = performance.now();
  const dryRun = Boolean(opts.dryRun);
  const maxSteps = Math.max(
    1,
    Math.min(MAX_POLYGLOT_STEPS, Math.trunc(Number(opts.maxSteps ?? DEFAULT_POLYGLOT_MAX_STEPS))),
  );
  const turnTimeoutMs =
    opts.turnTimeoutMs != null && Number.isFinite(Number(opts.turnTimeoutMs)) && Number(opts.turnTimeoutMs) > 0
      ? Math.trunc(Number(opts.turnTimeoutMs))
      : dryRun
        ? DEFAULT_POLYGLOT_DRY_RUN_TIMEOUT_MS
        : DEFAULT_POLYGLOT_TURN_TIMEOUT_MS;
  const gradeTimeoutMs =
    opts.gradeTimeoutMs != null && Number.isFinite(Number(opts.gradeTimeoutMs)) && Number(opts.gradeTimeoutMs) > 0
      ? Math.trunc(Number(opts.gradeTimeoutMs))
      : DEFAULT_POLYGLOT_GRADE_TIMEOUT_MS;

  const baseEnv = runtimeDeps.env ?? process.env;
  const liveCfg = providerConfig ?? resolvePolyglotProviderConfig(opts, runtimeDeps);
  const targetModel = String(opts.model || liveCfg.model || POLYGLOT_DEFAULT_MODEL).trim();

  const wsInfo = preparePolyglotWorkspace(exercise, {
    workspaceBaseDir: opts.workspaceBaseDir ?? null,
    sharedJsNodeModulesDir: opts.sharedJsNodeModulesDir ?? null,
  });

  const gradePlan = resolvePolyglotGradePlan(exercise.language, wsInfo.workspaceRoot, {
    env: baseEnv,
    sharedJsNodeModulesDir: wsInfo.linkedNodeModules,
  });
  const prompt = buildPolyglotPrompt(exercise, gradePlan);

  const fetchImpl =
    runtimeDeps.fetchImpl ??
    (dryRun
      ? createDryRunMeteringFetch({
          exercise,
          workspaceRoot: wsInfo.workspaceRoot,
          mode: normMode,
        })
      : liveCfg.fetchImpl ?? fetch);

  const proxy = new SweBenchMeteringProxy({
    targetModel,
    apiKey: liveCfg.apiKey ?? '',
    endpoint: liveCfg.endpoint,
    customHeaders: liveCfg.customHeaders ?? null,
    requestTimeoutMs: Math.min(turnTimeoutMs, 300_000),
    fetchImpl,
  });

  let agentOutcome = { status: 'failed', error: null, toolCallsCount: 0 };
  let agentDurationMs = 0;
  let proxyMetrics = null;
  let gradeResult = null;

  try {
    await proxy.start();
    const agentStarted = performance.now();

    if (normMode === 'raw_full' || normMode === 'full_aci') {
      agentOutcome = await runDirectAgentPolyglotMode({
        exercise,
        mode: normMode,
        workspaceRoot: wsInfo.workspaceRoot,
        prompt,
        proxy,
        targetModel,
        protocol: liveCfg.protocol || 'openai',
        maxSteps,
        timeoutMs: turnTimeoutMs,
        dryRun,
      });
    } else if (normMode === 'claude_code') {
      agentOutcome = await runClaudeCodePolyglotMode({
        workspaceRoot: wsInfo.workspaceRoot,
        prompt,
        proxy,
        targetModel,
        maxSteps,
        timeoutMs: turnTimeoutMs,
        dryRun,
        runtimeDeps,
        baseEnv,
      });
    } else {
      agentOutcome = await runMiniSweAgentPolyglotMode({
        workspaceRoot: wsInfo.workspaceRoot,
        prompt,
        proxy,
        targetModel,
        maxSteps,
        timeoutMs: turnTimeoutMs,
        dryRun,
        runtimeDeps,
        baseEnv,
      });
    }

    agentDurationMs = Math.max(1, Math.round(performance.now() - agentStarted));
    proxyMetrics = proxy.getMetrics();
    await proxy.stop();

    const gradeFn = runtimeDeps.gradePolyglotWorkspace ?? gradePolyglotWorkspace;
    gradeResult = await gradeFn(exercise, wsInfo.workspaceRoot, {
      timeoutMs: gradeTimeoutMs,
      restoreTests: true,
      dryRunFallbackOnMissingToolchain: dryRun,
      env: baseEnv,
      sharedJsNodeModulesDir: wsInfo.linkedNodeModules,
      commandRunner: runtimeDeps.commandRunner ?? null,
    });
  } catch (err) {
    agentOutcome = {
      status: 'env_error',
      error: redactSecrets(String(err?.message || err || 'Unknown execution error')),
      toolCallsCount: 0,
    };
    proxyMetrics = proxyMetrics ?? proxy.getMetrics();
  } finally {
    await proxy.stop().catch(() => {});
    wsInfo.cleanup();
  }

  const wallClockMs = Math.max(1, Math.round(performance.now() - started));
  const m = proxyMetrics ?? {
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheEligibleInputTokens: null,
    cacheStatus: 'missing',
    cacheHitRate: null,
  };

  return {
    exerciseId: exercise.id,
    language: exercise.language,
    slug: exercise.slug,
    mode: normMode,
    model: targetModel,
    status: String(agentOutcome.status || 'failed'),
    passed: Boolean(gradeResult?.passed),
    gradeMode: gradeResult?.gradeMode ?? 'none',
    gradeExitCode: gradeResult?.exitCode ?? null,
    gradeDurationMs: gradeResult?.durationMs ?? 0,
    gradeCommands: gradeResult?.commands ?? gradePlan.steps.map((s) => s.displayCommand),
    integrityViolation: Boolean(gradeResult?.integrity?.integrityViolation),
    tamperedFiles: gradeResult?.integrity?.tamperedFiles ?? [],
    steps: Number(m.steps ?? 0) || 0,
    toolCallsCount: Number(agentOutcome.toolCallsCount ?? 0) || 0,
    inputTokens: Number(m.inputTokens ?? 0) || 0,
    outputTokens: Number(m.outputTokens ?? 0) || 0,
    totalTokens: Number(m.totalTokens ?? (m.inputTokens ?? 0) + (m.outputTokens ?? 0)) || 0,
    cacheReadTokens: Number(m.cacheReadTokens ?? 0) || 0,
    cacheWriteTokens: Number(m.cacheWriteTokens ?? 0) || 0,
    cacheEligibleInputTokens: m.cacheEligibleInputTokens ?? null,
    cacheStatus: m.cacheStatus ?? 'missing',
    cacheHitRate: m.cacheHitRate ?? null,
    wallClockMs,
    agentDurationMs,
    error: agentOutcome.error ?? null,
    gradeError: gradeResult?.error ?? null,
    timestamp: new Date().toISOString(),
  };
}

function medianOf(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function isBetterRecord(next, prev) {
  const rank = (r) => [
    r?.status !== 'env_error' ? 1 : 0,
    r?.passed === true ? 1 : 0,
    r?.status === 'completed' ? 1 : 0,
    r?.cacheStatus === 'available' ? 1 : 0,
  ];
  const rn = rank(next);
  const rp = rank(prev);
  for (let i = 0; i < rn.length; i++) {
    if (rn[i] !== rp[i]) return rn[i] > rp[i];
  }
  const tn = next?.timestamp ? Date.parse(next.timestamp) : 0;
  const tp = prev?.timestamp ? Date.parse(prev.timestamp) : 0;
  return tn >= tp;
}

/**
 * Loads and flattens Polyglot shard JSON records from one or more directories or JSON files.
 */
export function loadShardResultsFromDir(dirOrFilePaths) {
  const inputs = Array.isArray(dirOrFilePaths) ? dirOrFilePaths : [dirOrFilePaths];
  const jsonFiles = [];

  const collect = (target) => {
    const abs = resolve(String(target));
    if (!existsSync(abs)) return;
    const st = statSync(abs);
    if (st.isFile()) {
      if (abs.toLowerCase().endsWith('.json')) jsonFiles.push(abs);
      return;
    }
    if (!st.isDirectory()) return;
    const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
      compareAsc(a.name, b.name),
    );
    for (const ent of entries) {
      const full = join(abs, ent.name);
      if (ent.isDirectory()) {
        collect(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.json')) {
        const lower = ent.name.toLowerCase();
        if (lower === 'summary.json' || lower === 'aggregate.json') continue;
        jsonFiles.push(full);
      }
    }
  };

  for (const inp of inputs) {
    if (inp) collect(inp);
  }

  const allRecords = [];
  const metaList = [];
  for (const file of [...new Set(jsonFiles)].sort(compareAsc)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) {
        allRecords.push(...parsed);
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.records)) {
        allRecords.push(...parsed.records);
        if (parsed.meta && typeof parsed.meta === 'object') {
          metaList.push(parsed.meta);
        }
      }
    } catch {
      // Ignore non-report JSON files
    }
  }

  return {
    sourceFiles: [...new Set(jsonFiles)].sort(compareAsc),
    records: allRecords,
    metaList,
  };
}

/**
 * Aggregates Polyglot evaluation records across shards into unified overall and
 * per-language metrics for all comparison modes.
 */
export function aggregatePolyglotResults(
  records = [],
  { modes = null, languages = null, meta = {} } = {},
) {
  const deduped = new Map();
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec !== 'object') continue;
    const mode = String(rec.mode ?? '').trim().toLowerCase();
    const exerciseId = String(rec.exerciseId ?? '').trim();
    if (!mode || !exerciseId) continue;
    const key = `${mode}::${exerciseId}`;
    const prev = deduped.get(key);
    if (!prev || isBetterRecord(rec, prev)) {
      deduped.set(key, { ...rec, mode, exerciseId });
    }
  }

  const cleanRecords = [...deduped.values()].sort(
    (a, b) =>
      compareAsc(a.mode, b.mode) ||
      compareAsc(a.language, b.language) ||
      compareAsc(a.slug, b.slug) ||
      compareAsc(a.exerciseId, b.exerciseId),
  );

  const discoveredModes = [...new Set(cleanRecords.map((r) => r.mode))];
  const orderedModes =
    Array.isArray(modes) && modes.length > 0
      ? [...new Set(modes.map((m) => String(m).trim().toLowerCase()).filter(Boolean))]
      : [
          ...POLYGLOT_MODES.filter((m) => discoveredModes.includes(m)),
          ...discoveredModes.filter((m) => !POLYGLOT_MODES.includes(m)).sort(compareAsc),
        ];

  const discoveredLangs = new Set(cleanRecords.map((r) => String(r.language ?? '').toLowerCase()));
  const orderedLangs =
    Array.isArray(languages) && languages.length > 0
      ? POLYGLOT_LANGUAGES.filter((l) =>
          languages.map((x) => String(x).trim().toLowerCase()).includes(l),
        )
      : POLYGLOT_LANGUAGES.filter((l) => discoveredLangs.size === 0 || discoveredLangs.has(l));

  const summarizeGroup = (rows) => {
    const total = rows.length;
    let completed = 0;
    let passed = 0;
    let envErrors = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalCacheEligibleInputTokens = 0;
    let cacheReportedCount = 0;
    let totalSteps = 0;
    let totalWallClockMs = 0;
    let integrityViolations = 0;
    const latencies = [];

    for (const r of rows) {
      if (r.status === 'completed') completed += 1;
      if (r.status === 'env_error') envErrors += 1;
      if (r.passed === true) passed += 1;
      if (r.integrityViolation === true) integrityViolations += 1;

      const inTok = Number(r.inputTokens ?? 0) || 0;
      const outTok = Number(r.outputTokens ?? 0) || 0;
      const crTok = Number(r.cacheReadTokens ?? 0) || 0;
      const cwTok = Number(r.cacheWriteTokens ?? 0) || 0;
      const elig =
        r.cacheEligibleInputTokens != null &&
        Number.isFinite(Number(r.cacheEligibleInputTokens)) &&
        Number(r.cacheEligibleInputTokens) > 0
          ? Number(r.cacheEligibleInputTokens)
          : (crTok > 0 || cwTok > 0) && inTok > 0
            ? inTok
            : null;

      totalInputTokens += inTok;
      totalOutputTokens += outTok;
      if (elig != null && elig > 0) {
        cacheReportedCount += 1;
        totalCacheReadTokens += crTok;
        totalCacheWriteTokens += cwTok;
        totalCacheEligibleInputTokens += elig;
      }
      totalSteps += Number(r.steps ?? 0) || 0;
      const wc = Number(r.wallClockMs ?? 0) || 0;
      totalWallClockMs += wc;
      latencies.push(wc);
    }

    const totalTokens = totalInputTokens + totalOutputTokens;
    const solveRate = total > 0 ? round4(passed / total) : 0;
    const cacheHitRate =
      totalCacheEligibleInputTokens > 0
        ? round4(Math.min(1, totalCacheReadTokens / totalCacheEligibleInputTokens))
        : null;
    const tokensPerSolved = passed > 0 ? Math.round(totalTokens / passed) : null;

    return {
      totalExercises: total,
      completedExercises: completed,
      passedExercises: passed,
      envErrors,
      solveRate,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      tokensPerSolved,
      totalCacheReadTokens,
      totalCacheWriteTokens,
      totalCacheEligibleInputTokens,
      cacheReportedCount,
      cacheHitRate,
      totalSteps,
      meanSteps: total > 0 ? round4(totalSteps / total) : 0,
      totalWallClockMs,
      meanWallClockMs: total > 0 ? Math.round(totalWallClockMs / total) : 0,
      medianWallClockMs: medianOf(latencies),
      integrityViolations,
    };
  };

  const summaryByMode = {};
  const perLanguageMatrix = {};

  for (const mode of orderedModes) {
    const modeRows = cleanRecords.filter((r) => r.mode === mode);
    const overall = summarizeGroup(modeRows);
    const byLanguage = {};
    for (const lang of orderedLangs) {
      byLanguage[lang] = summarizeGroup(modeRows.filter((r) => r.language === lang));
    }
    summaryByMode[mode] = {
      mode,
      ...overall,
      byLanguage,
    };
  }

  for (const lang of orderedLangs) {
    perLanguageMatrix[lang] = {};
    for (const mode of orderedModes) {
      perLanguageMatrix[lang][mode] = summaryByMode[mode].byLanguage[lang];
    }
  }

  return {
    benchmarkId: POLYGLOT_BENCHMARK_ID,
    version: POLYGLOT_BENCHMARK_VERSION,
    meta: {
      preset: meta.preset ?? null,
      model: meta.model ?? cleanRecords[0]?.model ?? POLYGLOT_DEFAULT_MODEL,
      dryRun: Boolean(meta.dryRun),
      shardIndex: meta.shardIndex ?? null,
      shardCount: meta.shardCount ?? null,
      totalUniqueExercises: new Set(cleanRecords.map((r) => r.exerciseId)).size,
      updatedAt: meta.updatedAt ?? new Date().toISOString(),
    },
    modes: orderedModes,
    languages: orderedLangs,
    summaryByMode,
    perLanguageMatrix,
    records: cleanRecords,
  };
}

function fmtPct(rate) {
  if (rate == null || !Number.isFinite(Number(rate))) return 'N/A';
  return `${(Number(rate) * 100).toFixed(2)}%`;
}

/**
 * Renders a unified Markdown summary report for `$GITHUB_STEP_SUMMARY` and `summary.md`.
 */
export function renderPolyglotMarkdownReport(report) {
  const modes = report?.modes ?? [];
  const languages = report?.languages ?? [];
  const meta = report?.meta ?? {};
  const summaryByMode = report?.summaryByMode ?? {};

  const lines = [
    '# Aider Polyglot 6-Language Benchmark Report',
    '',
    `- **Benchmark**: \`${report?.benchmarkId ?? POLYGLOT_BENCHMARK_ID}\` v${report?.version ?? POLYGLOT_BENCHMARK_VERSION}`,
    `- **Preset**: \`${meta.preset ?? 'custom'}\``,
    `- **Model**: \`${meta.model ?? POLYGLOT_DEFAULT_MODEL}\``,
    `- **Modes**: ${modes.map((m) => `\`${m}\``).join(', ')}`,
    `- **Languages**: ${languages.map((l) => `\`${l}\``).join(', ')}`,
    `- **Unique Exercises**: ${meta.totalUniqueExercises ?? 0}`,
    ...(meta.shardCount && meta.shardCount > 1
      ? [`- **Shard**: ${meta.shardIndex ?? 0}/${meta.shardCount}`]
      : []),
    `- **Dry Run**: ${Boolean(meta.dryRun)}`,
    `- **Updated At**: ${meta.updatedAt ?? new Date().toISOString()}`,
    '',
    '## Overall 4-Way Comparison',
    '',
    '| Mode | Solved | Solve Rate | Input Tokens | Output Tokens | Total Tokens | Tokens / Solved | Cache Read Hit Rate | Mean Steps | Mean Latency (ms) | Tamper Violations |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const mode of modes) {
    const m = summaryByMode[mode];
    if (!m) continue;
    const cacheCell =
      m.totalCacheEligibleInputTokens > 0
        ? `${fmtPct(m.cacheHitRate)} (${m.totalCacheReadTokens}/${m.totalCacheEligibleInputTokens})`
        : 'N/A';
    lines.push(
      `| \`${mode}\` | ${m.passedExercises}/${m.totalExercises} | ${fmtPct(m.solveRate)} | ${m.totalInputTokens} | ${m.totalOutputTokens} | ${m.totalTokens} | ${m.tokensPerSolved ?? 'N/A'} | ${cacheCell} | ${m.meanSteps} | ${m.meanWallClockMs} | ${m.integrityViolations} |`,
    );
  }

  lines.push('', '## Per-Language Solve Rate Matrix', '');
  lines.push(`| Language | ${modes.map((m) => `\`${m}\``).join(' | ')} |`);
  lines.push(`| --- | ${modes.map(() => '---:').join(' | ')} |`);

  for (const lang of languages) {
    const cells = modes.map((mode) => {
      const cell = report?.perLanguageMatrix?.[lang]?.[mode];
      if (!cell || cell.totalExercises === 0) return 'N/A';
      return `${cell.passedExercises}/${cell.totalExercises} (${fmtPct(cell.solveRate)})`;
    });
    lines.push(`| \`${lang}\` | ${cells.join(' | ')} |`);
  }

  const overallCells = modes.map((mode) => {
    const m = summaryByMode[mode];
    if (!m || m.totalExercises === 0) return 'N/A';
    return `**${m.passedExercises}/${m.totalExercises} (${fmtPct(m.solveRate)})**`;
  });
  lines.push(`| **Overall** | ${overallCells.join(' | ')} |`);

  lines.push('', '## Per-Exercise Details', '');
  lines.push(
    '| Mode | Exercise | Language | Status | Passed | Steps | Input Tokens | Output Tokens | Cache Hit Rate | Latency (ms) | Tamper Restored |',
  );
  lines.push('| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');

  for (const r of report?.records ?? []) {
    const cacheCell = r.cacheHitRate == null ? 'N/A' : fmtPct(r.cacheHitRate);
    lines.push(
      `| \`${r.mode}\` | \`${r.exerciseId}\` | \`${r.language}\` | ${r.status} | ${r.passed ? 'yes' : 'no'} | ${r.steps} | ${r.inputTokens} | ${r.outputTokens} | ${cacheCell} | ${r.wallClockMs} | ${r.integrityViolation ? 'yes' : 'no'} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Writes unified JSON and Markdown Polyglot report files atomically.
 */
export function writePolyglotReportFiles(report, outputTarget) {
  const absOut = resolve(String(outputTarget));
  let jsonPath;
  let markdownPath;
  if (absOut.toLowerCase().endsWith('.json')) {
    jsonPath = absOut;
    markdownPath = absOut.replace(/\.json$/i, '.md');
  } else {
    mkdirSync(absOut, { recursive: true });
    jsonPath = join(absOut, 'summary.json');
    markdownPath = join(absOut, 'summary.md');
  }

  writeTextAtomic(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeTextAtomic(markdownPath, renderPolyglotMarkdownReport(report));

  return { jsonPath, markdownPath };
}

/**
 * High-level runner orchestrating repository loading, stratified sampling, sharding,
 * 4-way unified-metered execution, native grading, and report generation.
 */
export async function runPolyglotBenchmark(opts = {}, runtimeDeps = {}) {
  const dryRun = Boolean(opts.dryRun);
  const preset = String(opts.preset || 'smoke-6').trim().toLowerCase();
  const modes = (
    Array.isArray(opts.modes) && opts.modes.length > 0 ? opts.modes : [...POLYGLOT_MODES]
  ).map((m) => String(m).trim().toLowerCase());
  for (const m of modes) {
    if (!VALID_POLYGLOT_MODES.has(m)) {
      throw new Error(
        `Invalid mode "${m}"; expected subset of ${POLYGLOT_MODES.join(', ')}`,
      );
    }
  }

  let fixtureHandle = null;
  let benchmarkDir = opts.benchmarkDir ? resolve(String(opts.benchmarkDir)) : null;

  try {
    if (!benchmarkDir) {
      if (dryRun) {
        const perLang = preset === 'polyglot-36' ? 6 : 1;
        fixtureHandle = createPolyglotDryRunFixture({ exercisesPerLanguage: perLang });
        benchmarkDir = fixtureHandle.benchmarkDir;
      } else {
        const ensured = await ensurePolyglotBenchmarkRepo({
          benchmarkDir: null,
          env: runtimeDeps.env ?? process.env,
          allowClone: opts.allowClone !== false,
          gitRunner: runtimeDeps.gitRunner ?? null,
        });
        benchmarkDir = ensured.repoDir;
      }
    }

    const allExercises = loadPolyglotExercises(benchmarkDir, {
      languages: opts.languages ?? POLYGLOT_LANGUAGES,
    });
    const subset = selectPolyglotSubset(allExercises, {
      preset,
      languages: opts.languages ?? null,
      limit: opts.limit ?? null,
      seed: opts.seed ?? 42,
    });

    const shardIndex = Number(opts.shardIndex ?? 0);
    const shardCount = Number(opts.shardCount ?? 1);
    const shardExercises = slicePolyglotShard(subset.exercises, { shardIndex, shardCount });

    const providerConfig =
      opts.providerConfig ?? resolvePolyglotProviderConfig(opts, runtimeDeps);

    const records = [];
    for (const mode of modes) {
      for (const exercise of shardExercises) {
        const rec = await runPolyglotExerciseMode({
          exercise,
          mode,
          opts,
          providerConfig,
          runtimeDeps,
        });
        records.push(rec);
        opts.onRecord?.(rec);
      }
    }

    const report = aggregatePolyglotResults(records, {
      modes,
      languages:
        Array.isArray(opts.languages) && opts.languages.length > 0
          ? opts.languages
          : [...POLYGLOT_LANGUAGES],
      meta: {
        preset,
        model: opts.model || providerConfig.model || POLYGLOT_DEFAULT_MODEL,
        dryRun,
        shardIndex,
        shardCount,
      },
    });

    let outputFiles = null;
    if (opts.output) {
      outputFiles = writePolyglotReportFiles(report, opts.output);
    }

    return {
      benchmarkDir,
      subset,
      shardExercisesCount: shardExercises.length,
      report,
      outputFiles,
    };
  } finally {
    fixtureHandle?.cleanup?.();
  }
}
