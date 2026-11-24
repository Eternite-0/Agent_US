import { randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export const SWEBENCH_HF_MINI_DATASET_ID = 'MariusHobbhahn/swe-bench-verified-mini';
export const SWEBENCH_HF_FULL_DATASET_ID = 'princeton-nlp/SWE-bench_Verified';
export const SWEBENCH_HF_DATASET_ID = SWEBENCH_HF_MINI_DATASET_ID;
export const SMOKE5_PREFERRED_REPOS = Object.freeze([
  'psf/requests',
  'pytest-dev/pytest',
  'django/django',
  'sympy/sympy',
  'scikit-learn/scikit-learn',
]);

const VALID_SUBSET_PRESETS = new Set(['smoke-5', 'paper-50']);
const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_HF_ROWS_URL = 'https://datasets-server.huggingface.co/rows';
const MAX_TARGETS_PER_PYTEST_CMD = 60;
const MAX_TARGETS_PER_DJANGO_CMD = 80;
const MAX_TARGETS_PER_SYMPY_CMD = 60;
const MAX_CMD_LENGTH_CHARS = 16_000;
const ANSI_ESCAPE_RE = /\x1B\[[0-9;]*[A-Za-z]/g;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALID_DJANGO_LABEL_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function compareStringsAsc(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function round4(value) {
  return Number((Number(value) || 0).toFixed(4));
}

function dedupePreserveOrder(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const val = String(item ?? '').trim();
    if (!val || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
  }
  return out;
}

function shellQuoteSingle(arg) {
  return `'${String(arg ?? '').replace(/'/g, "'\\''")}'`;
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

/**
 * Returns the default local JSONL cache path for SWE-bench Verified (mini by default).
 */
export function getDefaultSweBenchCachePath(
  repoRoot = DEFAULT_REPO_ROOT,
  fileName = 'swebench_verified_mini.jsonl',
) {
  const root = repoRoot ? resolve(String(repoRoot)) : DEFAULT_REPO_ROOT;
  return join(root, 'backend', 'data', 'benchmarks', String(fileName || 'swebench_verified_mini.jsonl'));
}

function splitUnquotedList(rawText) {
  const parts = [];
  let current = '';
  let bracketDepth = 0;
  let parenDepth = 0;
  let quoteChar = null;

  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    const prev = i > 0 ? rawText[i - 1] : '';

    if (quoteChar) {
      current += ch;
      if (ch === quoteChar && prev !== '\\') {
        quoteChar = null;
      }
      continue;
    }

    if ((ch === '"' || ch === "'") && prev !== '\\') {
      quoteChar = ch;
      current += ch;
      continue;
    }
    if (ch === '[') bracketDepth += 1;
    else if (ch === ']' && bracketDepth > 0) bracketDepth -= 1;
    else if (ch === '(') parenDepth += 1;
    else if (ch === ')' && parenDepth > 0) parenDepth -= 1;

    const atTopLevel = bracketDepth === 0 && parenDepth === 0;
    if (atTopLevel && (ch === ',' || ch === '\n' || ch === '\r')) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

function stripMatchingQuotes(val) {
  const s = String(val ?? '').trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1).trim();
    }
  }
  return s;
}

/**
 * Normalizes SWE-bench `FAIL_TO_PASS` / `PASS_TO_PASS` fields from JSON strings,
 * JS arrays, or comma/newline-delimited lists into deduplicated `string[]`.
 */
export function parseTestTargetList(rawVal) {
  if (rawVal == null) return [];
  if (Array.isArray(rawVal)) {
    return dedupePreserveOrder(rawVal.map((item) => String(item ?? '').trim()));
  }

  const text = String(rawVal).trim();
  if (!text) return [];

  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return dedupePreserveOrder(parsed.map((item) => String(item ?? '').trim()));
      }
    } catch {
      if (text.endsWith(']')) {
        const inner = text.slice(1, -1).trim();
        if (!inner) return [];
        return dedupePreserveOrder(splitUnquotedList(inner).map(stripMatchingQuotes));
      }
    }
  } else if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'string') {
        return parseTestTargetList(parsed);
      }
      if (Array.isArray(parsed)) {
        return dedupePreserveOrder(parsed.map((item) => String(item ?? '').trim()));
      }
    } catch {
      // Fall through to delimiter splitting
    }
  }

  return dedupePreserveOrder(splitUnquotedList(text));
}

/**
 * Normalizes extended SWE-bench evaluation fields (`test_patch`, `FAIL_TO_PASS`,
 * `PASS_TO_PASS`, `version`, `environment_setup_commit`).
 */
export function normalizeSweBenchExtendedFields(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    test_patch:
      typeof src.test_patch === 'string'
        ? src.test_patch
        : src.test_patch != null
          ? String(src.test_patch)
          : '',
    FAIL_TO_PASS: parseTestTargetList(src.FAIL_TO_PASS ?? src.fail_to_pass),
    PASS_TO_PASS: parseTestTargetList(src.PASS_TO_PASS ?? src.pass_to_pass),
    version: src.version != null ? String(src.version).trim() : '',
    environment_setup_commit:
      src.environment_setup_commit != null ? String(src.environment_setup_commit).trim() : '',
  };
}

/**
 * Paginates the HuggingFace Datasets Server HTTP API (defaulting to the 50-instance
 * `MariusHobbhahn/swe-bench-verified-mini` dataset) and atomically writes the
 * normalized dataset as `.jsonl`.
 */
export async function fetchSweBenchVerifiedDataset({
  outputPath = undefined,
  datasetId = SWEBENCH_HF_MINI_DATASET_ID,
  fetchImpl = globalThis.fetch,
  pageSize = 100,
  split = 'test',
  config = 'default',
  includeGoldPatch = false,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchSweBenchVerifiedDataset requires a valid fetch implementation');
  }
  const effectivePageSize = Math.trunc(Number(pageSize));
  if (!Number.isFinite(effectivePageSize) || effectivePageSize < 1) {
    throw new Error('pageSize must be a positive integer');
  }

  const effectiveDatasetId = String(datasetId || SWEBENCH_HF_MINI_DATASET_ID).trim();
  const defaultFileName =
    effectiveDatasetId === SWEBENCH_HF_FULL_DATASET_ID
      ? 'swebench_verified.jsonl'
      : 'swebench_verified_mini.jsonl';
  const absOut = resolve(
    String(outputPath || getDefaultSweBenchCachePath(DEFAULT_REPO_ROOT, defaultFileName)),
  );
  const instances = [];
  let offset = 0;
  let numRowsTotal = null;

  while (numRowsTotal === null || offset < numRowsTotal) {
    const url =
      `${DEFAULT_HF_ROWS_URL}?dataset=${encodeURIComponent(effectiveDatasetId)}` +
      `&config=${encodeURIComponent(String(config))}` +
      `&split=${encodeURIComponent(String(split))}` +
      `&offset=${offset}&length=${effectivePageSize}`;

    const res = await fetchImpl(url);
    if (!res || !res.ok) {
      let errDetail = '';
      if (res && typeof res.text === 'function') {
        try {
          errDetail = (await res.text()).slice(0, 240).trim();
        } catch {
          errDetail = '';
        }
      }
      throw new Error(
        `Failed to fetch SWE-bench Verified rows at offset=${offset}: HTTP ${res?.status ?? 'unknown'} ${res?.statusText ?? ''}${errDetail ? ` (${errDetail})` : ''}`.trim(),
      );
    }

    const payload = await res.json();
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.rows)) {
      throw new Error(`Invalid HuggingFace rows response shape at offset=${offset}: missing rows array`);
    }
    if (
      typeof payload.num_rows_total !== 'number' ||
      !Number.isFinite(payload.num_rows_total) ||
      payload.num_rows_total < 0
    ) {
      throw new Error(
        `Invalid HuggingFace rows response shape at offset=${offset}: invalid num_rows_total`,
      );
    }
    numRowsTotal = payload.num_rows_total;

    if (payload.rows.length === 0) {
      if (offset < numRowsTotal) {
        throw new Error(
          `Unexpected empty HuggingFace rows page at offset=${offset} before num_rows_total=${numRowsTotal}`,
        );
      }
      break;
    }

    for (let i = 0; i < payload.rows.length; i++) {
      const entry = payload.rows[i];
      if (!entry || typeof entry !== 'object' || !entry.row || typeof entry.row !== 'object') {
        throw new Error(
          `Invalid HuggingFace row entry at offset=${offset + i}: expected { row } object`,
        );
      }
      const row = entry.row;
      const instanceId = String(row.instance_id ?? '').trim();
      const repo = String(row.repo ?? '').trim();
      const baseCommit = String(row.base_commit ?? '').trim();
      const problemStatement = String(row.problem_statement ?? '').trim();
      const hintsText = String(row.hints_text ?? '').trim();

      if (!instanceId) {
        throw new Error(`HuggingFace row at offset=${offset + i} is missing instance_id`);
      }

      const ext = normalizeSweBenchExtendedFields(row);
      const normalized = {
        instance_id: instanceId,
        repo,
        base_commit: baseCommit,
        problem_statement: problemStatement,
        hints_text: hintsText,
        test_patch: ext.test_patch,
        FAIL_TO_PASS: ext.FAIL_TO_PASS,
        PASS_TO_PASS: ext.PASS_TO_PASS,
        version: ext.version,
        environment_setup_commit: ext.environment_setup_commit,
      };
      if (includeGoldPatch === true && typeof row.patch === 'string') {
        normalized.patch = row.patch;
      }
      instances.push(normalized);
    }

    offset += payload.rows.length;
  }

  const jsonlBody =
    instances.length > 0 ? `${instances.map((item) => JSON.stringify(item)).join('\n')}\n` : '';
  writeTextAtomic(absOut, jsonlBody);

  return {
    outputPath: absOut,
    count: instances.length,
    instances,
  };
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

function shuffleWithRng(items, rng) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Deterministic complexity score used for smoke-5 median picking and paper-50 strata.
 */
export function computeSweBenchComplexityScore(instance) {
  const stmtLen = String(instance?.problem_statement ?? '').length;
  const f2pCount = parseTestTargetList(instance?.FAIL_TO_PASS ?? instance?.fail_to_pass).length;
  const p2pCount = parseTestTargetList(instance?.PASS_TO_PASS ?? instance?.pass_to_pass).length;
  return stmtLen + 120 * (f2pCount + p2pCount);
}

function allocateLargestRemainder(groups, totalQuota, rng = null) {
  const quotas = new Map();
  if (groups.length === 0 || totalQuota <= 0) {
    for (const g of groups) quotas.set(g.key, 0);
    return quotas;
  }

  const totalItems = groups.reduce((sum, g) => sum + g.count, 0);
  if (totalQuota >= totalItems) {
    for (const g of groups) quotas.set(g.key, g.count);
    return quotas;
  }

  const enforceMinOne = totalQuota >= groups.length;
  const ideal = new Map();
  const tieJitter = new Map();
  let assigned = 0;

  for (const g of groups) {
    const q = totalItems > 0 ? totalQuota * (g.count / totalItems) : 0;
    ideal.set(g.key, q);
    tieJitter.set(g.key, rng ? rng() : 0);
    const base = enforceMinOne
      ? Math.min(g.count, Math.max(1, Math.floor(q)))
      : Math.min(g.count, Math.floor(q));
    quotas.set(g.key, base);
    assigned += base;
  }

  while (assigned > totalQuota) {
    const candidates = groups.filter((g) => (quotas.get(g.key) ?? 0) > 1);
    if (candidates.length === 0) break;
    candidates.sort((a, b) => {
      const overA = (quotas.get(a.key) ?? 0) - (ideal.get(a.key) ?? 0);
      const overB = (quotas.get(b.key) ?? 0) - (ideal.get(b.key) ?? 0);
      if (overB !== overA) return overB - overA;
      if (a.count !== b.count) return a.count - b.count;
      return compareStringsAsc(a.key, b.key);
    });
    const pick = candidates[0];
    quotas.set(pick.key, (quotas.get(pick.key) ?? 0) - 1);
    assigned -= 1;
  }

  while (assigned < totalQuota) {
    const candidates = groups.filter((g) => (quotas.get(g.key) ?? 0) < g.count);
    if (candidates.length === 0) break;
    candidates.sort((a, b) => {
      const remA = (ideal.get(a.key) ?? 0) - (quotas.get(a.key) ?? 0);
      const remB = (ideal.get(b.key) ?? 0) - (quotas.get(b.key) ?? 0);
      if (Math.abs(remB - remA) > 1e-12) return remB - remA;
      const jitDiff = (tieJitter.get(b.key) ?? 0) - (tieJitter.get(a.key) ?? 0);
      if (jitDiff !== 0) return jitDiff;
      if (b.count !== a.count) return b.count - a.count;
      return compareStringsAsc(a.key, b.key);
    });
    const pick = candidates[0];
    quotas.set(pick.key, (quotas.get(pick.key) ?? 0) + 1);
    assigned += 1;
  }

  return quotas;
}

function getInstanceTestCount(instance) {
  return (
    parseTestTargetList(instance?.FAIL_TO_PASS ?? instance?.fail_to_pass).length +
    parseTestTargetList(instance?.PASS_TO_PASS ?? instance?.pass_to_pass).length
  );
}

function selectSmoke5Subset(instances) {
  const targetCount = Math.min(5, instances.length);
  if (targetCount === 0) return [];

  const byRepo = new Map();
  for (const inst of instances) {
    const repo = String(inst?.repo ?? '').trim() || 'unknown';
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(inst);
  }

  for (const list of byRepo.values()) {
    list.sort(
      (a, b) =>
        getInstanceTestCount(a) - getInstanceTestCount(b) ||
        String(a?.problem_statement ?? '').length - String(b?.problem_statement ?? '').length ||
        compareStringsAsc(a?.instance_id, b?.instance_id),
    );
  }

  const orderedRepos = [
    ...SMOKE5_PREFERRED_REPOS.filter((r) => byRepo.has(r)),
    ...[...byRepo.keys()]
      .filter((r) => !SMOKE5_PREFERRED_REPOS.includes(r))
      .sort(compareStringsAsc),
  ];

  const selected = [];
  const cursors = new Map(orderedRepos.map((repo) => [repo, 0]));
  while (selected.length < targetCount) {
    let progressed = false;
    for (const repo of orderedRepos) {
      if (selected.length >= targetCount) break;
      const list = byRepo.get(repo);
      const idx = cursors.get(repo) ?? 0;
      if (idx < list.length) {
        selected.push(list[idx]);
        cursors.set(repo, idx + 1);
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  return selected;
}

function buildComplexityStrataBins(sortedRepoInstances) {
  const n = sortedRepoInstances.length;
  if (n === 0) return [];
  if (n === 1) return [{ key: 'low', items: sortedRepoInstances }];
  if (n === 2) {
    return [
      { key: 'low', items: [sortedRepoInstances[0]] },
      { key: 'high', items: [sortedRepoInstances[1]] },
    ];
  }
  const cut1 = Math.round(n / 3);
  const cut2 = Math.round((2 * n) / 3);
  return [
    { key: 'low', items: sortedRepoInstances.slice(0, cut1) },
    { key: 'med', items: sortedRepoInstances.slice(cut1, cut2) },
    { key: 'high', items: sortedRepoInstances.slice(cut2) },
  ].filter((bin) => bin.items.length > 0);
}

function selectPaper50Subset(instances, seed) {
  const targetCount = Math.min(50, instances.length);
  if (targetCount === 0) return [];

  const byRepo = new Map();
  for (const inst of instances) {
    const repo = String(inst?.repo ?? '').trim() || 'unknown';
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(inst);
  }

  const sortedRepos = [...byRepo.keys()].sort(compareStringsAsc);
  for (const repo of sortedRepos) {
    byRepo.get(repo).sort(
      (a, b) =>
        computeSweBenchComplexityScore(a) - computeSweBenchComplexityScore(b) ||
        compareStringsAsc(a?.instance_id, b?.instance_id),
    );
  }

  const rng = createMulberry32(seed);
  const repoGroups = sortedRepos.map((repo) => ({
    key: repo,
    count: byRepo.get(repo).length,
  }));
  const repoQuotas = allocateLargestRemainder(repoGroups, targetCount, rng);

  const selected = [];
  for (const repo of sortedRepos) {
    const quota = repoQuotas.get(repo) ?? 0;
    if (quota <= 0) continue;
    const pool = byRepo.get(repo);
    if (quota >= pool.length) {
      selected.push(...pool);
      continue;
    }

    const bins = buildComplexityStrataBins(pool);
    const binGroups = bins.map((b) => ({ key: b.key, count: b.items.length }));
    const binQuotas = allocateLargestRemainder(binGroups, quota, rng);

    for (const bin of bins) {
      const bQuota = binQuotas.get(bin.key) ?? 0;
      if (bQuota <= 0) continue;
      if (bQuota >= bin.items.length) {
        selected.push(...bin.items);
      } else {
        const shuffled = shuffleWithRng(bin.items, rng);
        selected.push(...shuffled.slice(0, bQuota));
      }
    }
  }

  return selected;
}

function buildRepoDistribution(instances) {
  const counts = new Map();
  for (const inst of instances) {
    const repo = String(inst?.repo ?? '').trim() || 'unknown';
    counts.set(repo, (counts.get(repo) ?? 0) + 1);
  }
  const dist = {};
  for (const repo of [...counts.keys()].sort(compareStringsAsc)) {
    dist[repo] = counts.get(repo);
  }
  return dist;
}

/**
 * Deterministically samples a `smoke-5` or `paper-50` subset from SWE-bench instances.
 */
export function selectSweBenchSubset(
  instances,
  { preset, seed = 42, outputDir = null } = {},
) {
  if (!VALID_SUBSET_PRESETS.has(preset)) {
    throw new Error(
      `Invalid SWE-bench subset preset "${preset}"; expected "smoke-5" or "paper-50"`,
    );
  }
  if (!Array.isArray(instances)) {
    throw new Error('selectSweBenchSubset expects an array of instances');
  }

  const normalizedSeed = Number.isFinite(Number(seed)) ? Math.trunc(Number(seed)) : 42;
  const selected =
    preset === 'smoke-5' ? selectSmoke5Subset(instances) : selectPaper50Subset(instances, normalizedSeed);

  const instanceIds = selected.map((inst) => String(inst.instance_id));
  const repoDistribution = buildRepoDistribution(selected);

  let manifestPath = null;
  if (outputDir) {
    const outPath = join(resolve(String(outputDir)), `subset.${preset}.instance_ids.json`);
    const manifest = {
      preset,
      seed: normalizedSeed,
      count: selected.length,
      repoDistribution,
      instanceIds,
      createdAt: new Date().toISOString(),
    };
    manifestPath = writeTextAtomic(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return {
    preset,
    seed: normalizedSeed,
    instances: selected,
    instanceIds,
    repoDistribution,
    manifestPath,
  };
}

function stripParamSuffix(target) {
  return String(target ?? '').replace(/\[[^\]]*\]$/, '').trim();
}

/**
 * Converts unittest (`test_foo (auth_tests.test_forms.LoginTest)`) or pytest-style
 * (`tests/auth_tests/test_forms.py::LoginTest::test_foo`) node IDs into Django
 * `./tests/runtests.py` module/class/method labels.
 */
export function djangoTestNodeToLabel(node) {
  const raw = String(node ?? '').trim();
  if (!raw) return '';

  const unittestMatch = raw.match(/^(.+?)\s+\(([^)]+)\)(?:\s+\([^)]*\))?$/);
  if (unittestMatch) {
    const methodRaw = stripParamSuffix(unittestMatch[1].trim());
    const container = unittestMatch[2].trim();
    if (IDENTIFIER_RE.test(methodRaw)) {
      if (container.endsWith(`.${methodRaw}`)) return container;
      return `${container}.${methodRaw}`;
    }
    return container;
  }

  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.includes('::') || normalized.endsWith('.py') || normalized.includes('/')) {
    const parts = normalized.split('::');
    let filePart = parts[0].trim();
    if (filePart.startsWith('tests/')) {
      filePart = filePart.slice('tests/'.length);
    }
    filePart = filePart.replace(/\/__init__\.py$/, '').replace(/\.py$/, '');
    const modLabel = filePart.split('/').filter(Boolean).join('.');
    const rest = parts
      .slice(1)
      .map((segment) => stripParamSuffix(segment))
      .filter(Boolean);
    return [modLabel, ...rest].filter(Boolean).join('.');
  }

  return stripParamSuffix(raw);
}

function extractSympyTestFile(target) {
  const raw = String(target ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw) return '';

  if (raw.includes('::')) {
    return raw.split('::')[0].trim();
  }
  const unittestMatch = raw.match(/^.+?\s+\(([^)]+)\)$/);
  if (unittestMatch) {
    const dotted = unittestMatch[1].trim();
    const parts = dotted.split('.');
    const pyParts = [];
    for (const seg of parts) {
      pyParts.push(seg);
      if (seg.startsWith('test_')) break;
    }
    if (pyParts.length > 0) {
      return `${pyParts.join('/')}.py`;
    }
  }
  if (raw.endsWith('.py') || raw.includes('/')) {
    return raw;
  }
  return '';
}

function extractDjangoLabelsFromTestPatch(testPatch) {
  const touched = parseDiffTouchedFiles(testPatch);
  const allFiles = dedupePreserveOrder([...touched.existing, ...touched.added]);
  const labels = [];
  for (const filePath of allFiles) {
    const norm = normalizeMatchPath(filePath);
    if (!norm.endsWith('.py') || !norm.startsWith('tests/')) continue;
    const rel = norm.slice('tests/'.length);
    const segments = rel.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    const label = segments.length === 1 ? segments[0].replace(/\.py$/, '') : segments[0];
    if (VALID_DJANGO_LABEL_RE.test(label)) {
      labels.push(label);
    }
  }
  return dedupePreserveOrder(labels);
}

function parseDiffTouchedFiles(diffText) {
  const existing = [];
  const added = [];
  const text = String(diffText ?? '');
  if (!text.trim()) return { existing, added };

  const lines = text.split(/\r?\n/);
  let currentPathA = null;
  let currentPathB = null;
  let sawOldDevNull = false;
  let sawNewFileMode = false;

  const flushBlock = () => {
    const candidate = currentPathB || currentPathA;
    if (candidate && candidate !== '/dev/null' && !candidate.startsWith('..')) {
      if (sawOldDevNull || sawNewFileMode) {
        added.push(candidate);
      } else {
        existing.push(candidate);
      }
    }
    currentPathA = null;
    currentPathB = null;
    sawOldDevNull = false;
    sawNewFileMode = false;
  };

  const cleanDiffPath = (rawPath) => {
    let p = String(rawPath ?? '').trim();
    if (p.startsWith('"') && p.endsWith('"')) {
      p = p.slice(1, -1);
    }
    p = p.replace(/^[ab]\//, '').replace(/\\/g, '/');
    return p;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushBlock();
      const m = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
      if (m) {
        currentPathA = cleanDiffPath(m[1]);
        currentPathB = cleanDiffPath(m[2]);
      }
    } else if (line.startsWith('new file mode ')) {
      sawNewFileMode = true;
    } else if (line.startsWith('--- ')) {
      const p = line.slice(4).trim().split('\t')[0];
      if (p === '/dev/null') {
        sawOldDevNull = true;
      } else {
        currentPathA = cleanDiffPath(p);
      }
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim().split('\t')[0];
      if (p !== '/dev/null') {
        currentPathB = cleanDiffPath(p);
      }
    }
  }
  flushBlock();

  return {
    existing: dedupePreserveOrder(existing),
    added: dedupePreserveOrder(added),
  };
}

function chunkCommands(prefix, targets, maxItemsPerCmd) {
  if (targets.length === 0) return [prefix];

  const commands = [];
  let currentArgs = [];
  let currentLen = prefix.length;

  for (const target of targets) {
    const quoted = shellQuoteSingle(target);
    const nextLen = currentLen + 1 + quoted.length;
    if (
      currentArgs.length > 0 &&
      (currentArgs.length >= maxItemsPerCmd || nextLen > MAX_CMD_LENGTH_CHARS)
    ) {
      commands.push(`${prefix} ${currentArgs.join(' ')}`);
      currentArgs = [];
      currentLen = prefix.length;
    }
    currentArgs.push(quoted);
    currentLen += 1 + quoted.length;
  }

  if (currentArgs.length > 0) {
    commands.push(`${prefix} ${currentArgs.join(' ')}`);
  }
  return commands;
}

/**
 * Builds official framework-specific evaluation commands for a SWE-bench instance.
 */
export function buildSweBenchEvalCommands(instance) {
  const repo = String(instance?.repo ?? '').trim();
  const failToPassTargets = parseTestTargetList(instance?.FAIL_TO_PASS ?? instance?.fail_to_pass);
  const passToPassTargets = parseTestTargetList(instance?.PASS_TO_PASS ?? instance?.pass_to_pass);
  const allTargets = dedupePreserveOrder([...failToPassTargets, ...passToPassTargets]);

  if (repo === 'django/django') {
    const mappedLabels = allTargets.map(djangoTestNodeToLabel).filter(Boolean);
    const validLabels = dedupePreserveOrder(
      mappedLabels.filter((lbl) => VALID_DJANGO_LABEL_RE.test(lbl)),
    );
    const hasInvalidLabels = mappedLabels.some((lbl) => !VALID_DJANGO_LABEL_RE.test(lbl));
    let labels = validLabels;
    if ((hasInvalidLabels || validLabels.length === 0) && instance?.test_patch) {
      const patchLabels = extractDjangoLabelsFromTestPatch(instance.test_patch);
      if (patchLabels.length > 0) {
        const patchRoots = new Set(patchLabels.map((lbl) => lbl.split('.')[0]));
        const extraValid = validLabels.filter((lbl) => !patchRoots.has(lbl.split('.')[0]));
        labels = dedupePreserveOrder([...patchLabels, ...extraValid]);
      }
    }
    if (labels.length === 0) {
      labels = dedupePreserveOrder(mappedLabels);
    }
    const commands = chunkCommands(
      './tests/runtests.py --verbosity 2 --parallel 1',
      labels,
      MAX_TARGETS_PER_DJANGO_CMD,
    );
    return {
      framework: 'django',
      commands,
      failToPassTargets,
      passToPassTargets,
    };
  }

  if (repo === 'sympy/sympy') {
    let files = dedupePreserveOrder(allTargets.map(extractSympyTestFile).filter(Boolean));
    if (files.length === 0 && instance?.test_patch) {
      const touched = parseDiffTouchedFiles(instance.test_patch);
      files = dedupePreserveOrder(
        [...touched.existing, ...touched.added].filter((p) => p.endsWith('.py')),
      );
    }
    if (files.length === 0 && allTargets.length > 0) {
      files = allTargets;
    }
    const commands = chunkCommands(
      "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      files,
      MAX_TARGETS_PER_SYMPY_CMD,
    );
    return {
      framework: 'sympy',
      commands,
      failToPassTargets,
      passToPassTargets,
    };
  }

  const commands = chunkCommands(
    'pytest -rA --tb=short',
    allTargets,
    MAX_TARGETS_PER_PYTEST_CMD,
  );
  return {
    framework: 'pytest',
    commands,
    failToPassTargets,
    passToPassTargets,
  };
}

function extractNodeMethodName(node) {
  const raw = String(node ?? '').trim();
  if (!raw) return '';
  const unittestMatch = raw.match(/^([^\s(]+)(?:\s+\[[^\]]*\])?\s+\(([^)]+)\)(?:\s+\([^)]*\))?$/);
  if (unittestMatch) {
    return stripParamSuffix(unittestMatch[1]);
  }
  if (raw.includes('::')) {
    const tail = raw.split('::').pop() ?? '';
    return stripParamSuffix(tail);
  }
  if (raw.includes('.') && !raw.endsWith('.py')) {
    const tail = raw.split('.').pop() ?? '';
    return stripParamSuffix(tail);
  }
  return stripParamSuffix(raw);
}

function normalizeMatchPath(val) {
  return String(val ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Parses pytest `-rA`, unittest/Django verbose, and SymPy `bin/test` outputs,
 * then matches `FAIL_TO_PASS` and `PASS_TO_PASS` targets flexibly.
 */
export function parseEvalTestResults(
  output,
  { repo = '', failToPass = [], passToPass = [], exitCode = 0 } = {},
) {
  const failToPassTargets = parseTestTargetList(failToPass);
  const passToPassTargets = parseTestTargetList(passToPass);
  const passedNames = new Set();
  const failedNames = new Set();

  const cleanText = String(output ?? '').replace(ANSI_ESCAPE_RE, '');
  const lines = cleanText.split(/\r?\n/);

  const markPassed = (name) => {
    const n = String(name ?? '').trim();
    if (!n || failedNames.has(n)) return;
    passedNames.add(n);
  };
  const markFailed = (name) => {
    const n = String(name ?? '').trim();
    if (!n) return;
    passedNames.delete(n);
    failedNames.add(n);
  };
  const recordUnittestOutcome = (outcomeRaw, ...names) => {
    const outcome = String(outcomeRaw ?? '').toLowerCase();
    const targets = names.map((n) => String(n ?? '').trim()).filter(Boolean);
    if (outcome === 'ok' || outcome === 'expected failure') {
      for (const t of targets) markPassed(t);
    } else if (outcome === 'fail' || outcome === 'error' || outcome === 'unexpected success') {
      for (const t of targets) markFailed(t);
    }
  };

  let currentSympyFile = null;
  let pendingUnittestNode = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      pendingUnittestNode = null;
      continue;
    }

    // Track current SymPy test file header: `sympy/core/tests/test_expr.py[12]`
    const sympyFileMatch = line.match(/^([A-Za-z0-9_./\\-]+\.py)\[\d+\](?:\s.*)?$/);
    if (sympyFileMatch) {
      currentSympyFile = normalizeMatchPath(sympyFileMatch[1]);
      pendingUnittestNode = null;
      continue;
    }

    // Pytest `-rA` summary lines
    const pytestPassSummary = line.match(/^PASSED\s+(.+)$/);
    if (pytestPassSummary) {
      markPassed(pytestPassSummary[1]);
      pendingUnittestNode = null;
      continue;
    }

    const pytestCollectErr = line.match(/^ERROR\s+(?:collecting|file)\s+(.+)$/);
    if (pytestCollectErr) {
      markFailed(pytestCollectErr[1]);
      pendingUnittestNode = null;
      continue;
    }

    const pytestFailSummary = line.match(/^(?:FAILED|ERROR)\s+(.+?)(?:\s+-\s+.*)?$/);
    if (pytestFailSummary && !line.startsWith('ERROR:')) {
      markFailed(pytestFailSummary[1]);
      pendingUnittestNode = null;
      continue;
    }

    // Pytest `-v` inline status lines
    const pytestVerbose = line.match(
      /^(\S+::.+?)\s+(PASSED|FAILED|ERROR)(?:\s+\[\s*\d+%\])?\s*$/,
    );
    if (pytestVerbose) {
      if (pytestVerbose[2] === 'PASSED') markPassed(pytestVerbose[1]);
      else markFailed(pytestVerbose[1]);
      pendingUnittestNode = null;
      continue;
    }

    // Unittest / Django footer failure lines (`FAIL: test_foo (pkg.mod.Cls)`)
    const unittestFooter = line.match(
      /^(FAIL|ERROR):\s+([^\s(]+)\s+\(([^)]+)\)(?:\s+\([^)]*\))?(?:\s+.*)?$/,
    );
    if (unittestFooter) {
      markFailed(`${unittestFooter[2]} (${unittestFooter[3].trim()})`);
      pendingUnittestNode = null;
      continue;
    }

    // Multiline unittest docstring output (`test_foo (pkg.mod.Cls)` followed by `<doc> ... ok`)
    if (pendingUnittestNode) {
      const docOutcome = line.match(
        /^(.*?)\s*\.\.\.\s+(ok|FAIL|ERROR|expected failure|unexpected success|skipped(?:\s+.*)?)$/i,
      );
      if (docOutcome) {
        recordUnittestOutcome(docOutcome[2], pendingUnittestNode, docOutcome[1]);
        pendingUnittestNode = null;
        continue;
      }
      pendingUnittestNode = null;
    }

    // Unittest / Django single-line verbose output (`test_foo (pkg.mod.Cls) ... ok|FAIL|ERROR`)
    const unittestLine = line.match(
      /^(.+?)\s+\(([^)]+)\)\s+\.\.\.\s+(ok|FAIL|ERROR|expected failure|unexpected success|skipped(?:\s+.*)?)$/i,
    );
    if (unittestLine) {
      const testLabel = `${unittestLine[1].trim()} (${unittestLine[2].trim()})`;
      recordUnittestOutcome(unittestLine[3], testLabel);
      pendingUnittestNode = null;
      continue;
    }

    // Standalone Django/unittest docstring status line (`<docstring> ... ok|FAIL|ERROR`)
    if (repo === 'django/django') {
      const djangoDocLine = line.match(
        /^(.+?)\s+\.\.\.\s+(ok|FAIL|ERROR|expected failure|unexpected success|skipped(?:\s+.*)?)$/i,
      );
      if (djangoDocLine) {
        recordUnittestOutcome(djangoDocLine[2], djangoDocLine[1]);
        pendingUnittestNode = null;
        continue;
      }
    }

    const unittestHeader = line.match(/^([^\s(]+)\s+\(([^)]+)\)$/);
    if (unittestHeader) {
      pendingUnittestNode = `${unittestHeader[1]} (${unittestHeader[2].trim()})`;
      continue;
    }

    // SymPy failure block banner (`_______ sympy/core/tests/test_expr.py:test_foo _______`)
    const sympyFailHeader = line.match(/^_+\s+([^\s:]+\.py):([A-Za-z_][A-Za-z0-9_]*)\s+_+$/);
    if (sympyFailHeader) {
      markFailed(`${normalizeMatchPath(sympyFailHeader[1])}::${sympyFailHeader[2]}`);
      continue;
    }

    // SymPy `bin/test` verbose lines (`test_name ... ok|E|F` / `[OK]` / `[FAIL]`)
    const sympyPassWithDotsOrBrackets = line.match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.{2,}\s*\[?(?:OK|ok)\]?|\s+\[OK\])$/,
    );
    const sympyPassBare = line.match(/^(test_[A-Za-z0-9_]+)\s+ok$/);
    const sympyPass = sympyPassWithDotsOrBrackets ?? sympyPassBare;
    if (sympyPass) {
      const testId = currentSympyFile ? `${currentSympyFile}::${sympyPass[1]}` : sympyPass[1];
      markPassed(testId);
      continue;
    }

    const sympyFailWithDotsOrBrackets = line.match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.{2,}\s*(?:\[FAIL\]|\[ERROR\]|FAIL|ERROR|F|E)|\s+(?:\[FAIL\]|\[ERROR\]))$/,
    );
    const sympyFailBare = line.match(/^(test_[A-Za-z0-9_]+)\s+(?:FAIL|ERROR|F|E)$/);
    const sympyFail = sympyFailWithDotsOrBrackets ?? sympyFailBare;
    if (sympyFail) {
      const testId = currentSympyFile ? `${currentSympyFile}::${sympyFail[1]}` : sympyFail[1];
      markFailed(testId);
      continue;
    }

    if (/^INTERNALERROR>/.test(line)) {
      markFailed(line);
    }
  }

  // Build flexible lookup tables across parsed entries
  const allEntries = [
    ...[...passedNames].map((name) => ({ name, passed: true })),
    ...[...failedNames].map((name) => ({ name, passed: false })),
  ];

  const byNormExact = new Map();
  const byDjangoLabel = new Map();
  const byNoParam = new Map();
  const byMethodName = new Map();
  const distinctBaseByMethod = new Map();

  const pushMap = (map, key, entry) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  };

  for (const entry of allEntries) {
    const norm = normalizeMatchPath(entry.name);
    const noParam = normalizeMatchPath(stripParamSuffix(entry.name));
    const djangoLbl = djangoTestNodeToLabel(entry.name);
    const methodName = extractNodeMethodName(entry.name);

    pushMap(byNormExact, norm, entry);
    pushMap(byDjangoLabel, djangoLbl, entry);
    pushMap(byNoParam, noParam, entry);
    if (methodName) {
      pushMap(byMethodName, methodName, entry);
      if (!distinctBaseByMethod.has(methodName)) {
        distinctBaseByMethod.set(methodName, new Set());
      }
      distinctBaseByMethod.get(methodName).add(noParam || djangoLbl || norm);
    }
  }

  const resolveEntriesOutcome = (entries) => {
    if (!entries || entries.length === 0) return 'missing';
    if (entries.some((e) => !e.passed)) return 'failed';
    if (entries.some((e) => e.passed)) return 'passed';
    return 'missing';
  };

  const matchTarget = (target) => {
    const norm = normalizeMatchPath(target);
    if (!norm) return 'missing';

    // 1. Exact match
    const exactRes = resolveEntriesOutcome(byNormExact.get(norm));
    if (exactRes !== 'missing') return exactRes;

    // 2. Django / unittest canonical label match
    const djangoLbl = djangoTestNodeToLabel(target);
    if (djangoLbl && (repo === 'django/django' || /\([^)]+\)/.test(target) || target.includes('::'))) {
      const djRes = resolveEntriesOutcome(byDjangoLabel.get(djangoLbl));
      if (djRes !== 'missing') return djRes;
    }

    // 3. Stripped `[...]` parameter suffix match
    const noParam = normalizeMatchPath(stripParamSuffix(target));
    const noParamRes = resolveEntriesOutcome(byNoParam.get(noParam));
    if (noParamRes !== 'missing') return noParamRes;

    // 4. File-level target (`tests/test_foo.py`) matching node IDs inside that file
    if (norm.endsWith('.py') && !norm.includes('::')) {
      const fileEntries = allEntries.filter((e) => normalizeMatchPath(e.name).startsWith(`${norm}::`));
      const fileRes = resolveEntriesOutcome(fileEntries);
      if (fileRes !== 'missing') return fileRes;
    }

    // 5. Unique method-name match across parsed test cases
    const methodName = extractNodeMethodName(target);
    if (methodName) {
      const uniqueBases = distinctBaseByMethod.get(methodName);
      if (uniqueBases && uniqueBases.size === 1) {
        const methRes = resolveEntriesOutcome(byMethodName.get(methodName));
        if (methRes !== 'missing') return methRes;
      }
    }

    return 'missing';
  };

  let failToPassPassed = 0;
  for (const t of failToPassTargets) {
    if (matchTarget(t) === 'passed') {
      failToPassPassed += 1;
    }
  }

  let passToPassPassed = 0;
  let passToPassFailed = 0;
  for (const t of passToPassTargets) {
    const outcome = matchTarget(t);
    if (outcome === 'passed') passToPassPassed += 1;
    else if (outcome === 'failed') passToPassFailed += 1;
  }

  const failToPassTotal = failToPassTargets.length;
  const passToPassTotal = passToPassTargets.length;
  const resolved =
    failToPassTotal > 0
      ? failToPassPassed === failToPassTotal &&
        passToPassFailed === 0 &&
        (exitCode === 0 || (passedNames.size > 0 && failedNames.size === 0))
      : exitCode === 0 && failedNames.size === 0;

  return {
    passedNames,
    failedNames,
    failToPassPassed,
    failToPassTotal,
    passToPassPassed,
    passToPassFailed,
    passToPassTotal,
    resolved,
    reason: resolved ? 'resolved' : 'failed_tests',
  };
}

function buildHeredocGitApplyCommand(patchText) {
  const normalized = String(patchText ?? '').endsWith('\n')
    ? String(patchText)
    : `${String(patchText ?? '')}\n`;
  let delim = `__AGENT_US_PATCH_${randomBytes(12).toString('hex')}__`;
  while (normalized.includes(delim)) {
    delim = `__AGENT_US_PATCH_${randomBytes(12).toString('hex')}__`;
  }
  return `git apply -v - <<'${delim}'\n${normalized}${delim}`;
}

function loadPredictionsInput({ predictions = [], predictionsPath = null }) {
  if (Array.isArray(predictions) && predictions.length > 0) {
    return predictions;
  }
  if (!predictionsPath) {
    return Array.isArray(predictions) ? predictions : [];
  }
  const absPath = resolve(String(predictionsPath));
  if (!existsSync(absPath)) {
    throw new Error(`Predictions file not found: ${absPath}`);
  }
  const raw = readFileSync(absPath, 'utf8').trim();
  if (!raw) return [];
  if (absPath.toLowerCase().endsWith('.json') || raw.startsWith('[')) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected JSON array in predictions file: ${absPath}`);
    }
    return parsed;
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed));
  }
  return out;
}

async function runWithConcurrency(items, concurrency, fn) {
  const out = new Array(items.length);
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function buildUnresolvedEvalRecord(instance, prediction, overrides = {}) {
  const failToPassTargets = parseTestTargetList(instance?.FAIL_TO_PASS ?? instance?.fail_to_pass);
  const passToPassTargets = parseTestTargetList(instance?.PASS_TO_PASS ?? instance?.pass_to_pass);
  return {
    instance_id: instance.instance_id,
    model_name_or_path: String(prediction?.model_name_or_path ?? ''),
    repo: String(instance.repo ?? ''),
    framework: null,
    commands: [],
    exitCode: null,
    resolved: false,
    reason: 'failed_tests',
    failToPassPassed: 0,
    failToPassTotal: failToPassTargets.length,
    passToPassPassed: 0,
    passToPassFailed: 0,
    passToPassTotal: passToPassTargets.length,
    passedTests: [],
    failedTests: [],
    durationMs: 0,
    ...overrides,
  };
}

/**
 * Evaluates SWE-bench predictions in isolated Docker `/testbed` containers
 * by applying `model_patch`, resetting and applying `test_patch`, and running
 * official repo test suites (`FAIL_TO_PASS` + `PASS_TO_PASS`).
 */
export async function evaluateSweBenchPredictions({
  instances,
  predictions = [],
  predictionsPath = null,
  imageResolver = null,
  createDockerSession,
  pull = 'missing',
  memory = '2g',
  memorySwap = undefined,
  cpus = undefined,
  concurrency = 1,
  outputPath = null,
  onInstanceDone = null,
  logger = console,
} = {}) {
  if (!Array.isArray(instances)) {
    throw new Error('evaluateSweBenchPredictions requires an instances array');
  }

  const resolvedMemory = memory === undefined ? '2g' : memory;
  const resolvedMemorySwap =
    memorySwap !== undefined ? memorySwap : resolvedMemory === '2g' ? '2.5g' : undefined;

  const loadedPredictions = loadPredictionsInput({ predictions, predictionsPath });
  const predById = new Map();
  for (const pred of loadedPredictions) {
    const id = String(pred?.instance_id ?? '').trim();
    if (id) predById.set(id, pred);
  }

  const pairs = [];
  for (const inst of instances) {
    const id = String(inst?.instance_id ?? '').trim();
    if (!id || !predById.has(id)) continue;
    pairs.push({ instance: inst, prediction: predById.get(id) });
  }

  const requiresDocker = pairs.some((p) => String(p.prediction?.model_patch ?? '').trim().length > 0);
  if (requiresDocker && typeof createDockerSession !== 'function') {
    throw new Error('evaluateSweBenchPredictions requires createDockerSession for non-empty predictions');
  }

  const results = await runWithConcurrency(pairs, concurrency, async ({ instance, prediction }) => {
    const t0 = performance.now();
    const modelPatch = String(prediction?.model_patch ?? '');
    const image =
      typeof imageResolver === 'function'
        ? imageResolver(instance)
        : typeof imageResolver === 'string'
          ? imageResolver
          : null;

    let session = null;
    let result = null;
    let usedDocker = false;
    try {
      if (!modelPatch.trim()) {
        result = buildUnresolvedEvalRecord(instance, prediction, {
          reason: 'empty_patch',
          durationMs: Math.max(1, Math.round(performance.now() - t0)),
        });
        return result;
      }

      usedDocker = true;
      session = await createDockerSession({
        instance,
        image,
        pull,
        ...(resolvedMemory != null ? { memory: resolvedMemory } : {}),
        ...(resolvedMemorySwap != null ? { memorySwap: resolvedMemorySwap } : {}),
        ...(cpus != null ? { cpus } : {}),
      });

      // 1. Apply model prediction patch cleanly inside /testbed
      const applyModelCmd = buildHeredocGitApplyCommand(modelPatch);
      const modelApplyRes = await session.exec(applyModelCmd, { skipAntiCheatGuard: true });
      if (!modelApplyRes || modelApplyRes.timedOut || modelApplyRes.exitCode !== 0) {
        result = buildUnresolvedEvalRecord(instance, prediction, {
          reason: 'patch_apply_failed',
          exitCode: modelApplyRes?.timedOut ? 124 : modelApplyRes?.exitCode ?? 1,
          durationMs: Math.max(1, Math.round(performance.now() - t0)),
        });
        return result;
      }

      // 2. Reset any files touched by test_patch, then apply official test_patch
      const testPatch = String(instance?.test_patch ?? '');
      if (testPatch.trim()) {
        const touched = parseDiffTouchedFiles(testPatch);
        if (touched.existing.length > 0) {
          const resetCmd = `git checkout -- ${touched.existing.map(shellQuoteSingle).join(' ')}`;
          await session.exec(resetCmd, { skipAntiCheatGuard: true });
        }
        if (touched.added.length > 0) {
          const rmCmd = `rm -f -- ${touched.added.map(shellQuoteSingle).join(' ')}`;
          await session.exec(rmCmd, { skipAntiCheatGuard: true });
        }

        const applyTestCmd = buildHeredocGitApplyCommand(testPatch);
        const testApplyRes = await session.exec(applyTestCmd, { skipAntiCheatGuard: true });
        if (!testApplyRes || testApplyRes.timedOut || testApplyRes.exitCode !== 0) {
          result = buildUnresolvedEvalRecord(instance, prediction, {
            reason: 'test_patch_apply_failed',
            exitCode: testApplyRes?.timedOut ? 124 : testApplyRes?.exitCode ?? 1,
            durationMs: Math.max(1, Math.round(performance.now() - t0)),
          });
          return result;
        }
      }

      // 3. Execute repo-specific evaluation commands and grade FAIL_TO_PASS + PASS_TO_PASS
      const { framework, commands, failToPassTargets, passToPassTargets } =
        buildSweBenchEvalCommands(instance);
      const outputChunks = [];
      let combinedExitCode = 0;

      for (const cmd of commands) {
        const res = await session.exec(cmd, { skipAntiCheatGuard: true });
        if (res?.stdout) outputChunks.push(res.stdout);
        if (res?.stderr) outputChunks.push(res.stderr);
        const code = res?.timedOut ? 124 : Number(res?.exitCode ?? 1);
        if (code !== 0 && combinedExitCode === 0) {
          combinedExitCode = code;
        }
      }

      const combinedOutput = outputChunks.join('\n');
      const parsed = parseEvalTestResults(combinedOutput, {
        repo: instance.repo,
        failToPass: failToPassTargets,
        passToPass: passToPassTargets,
        exitCode: combinedExitCode,
      });

      result = {
        instance_id: instance.instance_id,
        model_name_or_path: String(prediction?.model_name_or_path ?? ''),
        repo: String(instance.repo ?? ''),
        framework,
        commands,
        exitCode: combinedExitCode,
        resolved: parsed.resolved,
        reason: parsed.reason,
        failToPassPassed: parsed.failToPassPassed,
        failToPassTotal: parsed.failToPassTotal,
        passToPassPassed: parsed.passToPassPassed,
        passToPassFailed: parsed.passToPassFailed,
        passToPassTotal: parsed.passToPassTotal,
        passedTests: [...parsed.passedNames],
        failedTests: [...parsed.failedNames],
        durationMs: Math.max(1, Math.round(performance.now() - t0)),
      };
      return result;
    } catch (err) {
      logger?.warn?.(
        `[swebench-eval] Evaluation failed for ${instance.instance_id}: ${err?.message ?? err}`,
      );
      result = buildUnresolvedEvalRecord(instance, prediction, {
        reason: 'eval_error',
        error: err?.message ?? String(err),
        durationMs: Math.max(1, Math.round(performance.now() - t0)),
      });
      return result;
    } finally {
      if (session && typeof session.destroy === 'function') {
        try {
          await session.destroy();
        } catch {
          // Ignore destroy failure
        }
      }
      if (typeof onInstanceDone === 'function') {
        try {
          await onInstanceDone({ instance, image, result, usedDocker });
        } catch (cleanupErr) {
          logger?.warn?.(
            `[swebench-eval] Cleanup callback failed for ${instance.instance_id}: ${cleanupErr?.message ?? cleanupErr}`,
          );
        }
      }
    }
  });

  const evaluatedCount = results.length;
  const resolvedCount = results.filter((r) => r.resolved).length;
  const resolvedRate = evaluatedCount > 0 ? round4(resolvedCount / evaluatedCount) : 0;

  let writtenPath = null;
  if (outputPath) {
    const jsonlBody =
      results.length > 0 ? `${results.map((r) => JSON.stringify(r)).join('\n')}\n` : '';
    writtenPath = writeTextAtomic(outputPath, jsonlBody);
  }

  return {
    totalInstances: instances.length,
    evaluatedCount,
    resolvedCount,
    resolvedRate,
    outputPath: writtenPath,
    results,
  };
}

/**
 * Merges evaluation pass/fail outcomes into per-instance telemetry rows.
 */
export function mergeEvalResultsIntoTelemetry(telemetryRows = [], evalResults = []) {
  const evalList = Array.isArray(evalResults)
    ? evalResults
    : Array.isArray(evalResults?.results)
      ? evalResults.results
      : [];
  const byId = new Map();
  for (const ev of evalList) {
    const id = String(ev?.instance_id ?? '').trim();
    if (id) byId.set(id, ev);
  }

  return (Array.isArray(telemetryRows) ? telemetryRows : []).map((row) => {
    const id = String(row?.instance_id ?? '').trim();
    const ev = byId.get(id);
    if (!ev) return { ...row };
    return {
      ...row,
      resolved: Boolean(ev.resolved),
      evalReason: ev.reason ?? (ev.resolved ? 'resolved' : 'failed_tests'),
      failToPassPassed: Number(ev.failToPassPassed ?? 0) || 0,
      failToPassTotal: Number(ev.failToPassTotal ?? 0) || 0,
      passToPassPassed: Number(ev.passToPassPassed ?? 0) || 0,
      passToPassFailed: Number(ev.passToPassFailed ?? 0) || 0,
      passToPassTotal: Number(ev.passToPassTotal ?? 0) || 0,
      evalDurationMs: ev.durationMs ?? null,
    };
  });
}

function getRowTotalTokens(row) {
  if (row?.totalTokens != null && Number.isFinite(Number(row.totalTokens))) {
    return Number(row.totalTokens);
  }
  return (Number(row?.inputTokens ?? 0) || 0) + (Number(row?.outputTokens ?? 0) || 0);
}

/**
 * Computes per-arm resolution rates, tokens-per-resolved, and paired token reduction
 * over instances resolved by both `arm` and `baselineArm`.
 */
export function computePairedResolutionMetrics(
  arms = [],
  telemetryByArm = {},
  baselineArm = arms[0],
) {
  const baselineRows = Array.isArray(telemetryByArm?.[baselineArm])
    ? telemetryByArm[baselineArm]
    : [];
  const baselineResolvedTokens = new Map();
  for (const row of baselineRows) {
    if (row?.resolved !== true) continue;
    const id = String(row?.instance_id ?? '').trim();
    if (!id) continue;
    baselineResolvedTokens.set(id, getRowTotalTokens(row));
  }

  const out = {};
  for (const arm of arms) {
    const rows = Array.isArray(telemetryByArm?.[arm]) ? telemetryByArm[arm] : [];
    const totalInstances = rows.length;
    let resolvedCount = 0;
    let totalTokens = 0;
    let totalSteps = 0;
    let totalWallClockMs = 0;
    let totalCacheReadTokens = 0;
    let totalCacheEligibleInputTokens = 0;

    const pairedResolvedIds = [];
    let pairedBaseTokens = 0;
    let pairedArmTokens = 0;

    for (const row of rows) {
      const id = String(row?.instance_id ?? '').trim();
      const rowTok = getRowTotalTokens(row);
      const inTok = Number(row?.inputTokens ?? 0) || 0;
      const crTok = Number(row?.cacheReadTokens ?? 0) || 0;
      const rawEligible = row?.cacheEligibleInputTokens;
      const eligibleTok =
        rawEligible != null && Number.isFinite(Number(rawEligible)) && Number(rawEligible) > 0
          ? Number(rawEligible)
          : inTok;

      totalTokens += rowTok;
      totalSteps += Number(row?.steps ?? 0) || 0;
      totalWallClockMs += Number(row?.wallClockMs ?? 0) || 0;
      totalCacheReadTokens += crTok;
      totalCacheEligibleInputTokens += eligibleTok;

      if (row?.resolved === true) {
        resolvedCount += 1;
        if (id && baselineResolvedTokens.has(id)) {
          pairedResolvedIds.push(id);
          pairedBaseTokens += baselineResolvedTokens.get(id);
          pairedArmTokens += rowTok;
        }
      }
    }

    const resolvedRate = totalInstances > 0 ? round4(resolvedCount / totalInstances) : 0;
    const tokensPerResolved = resolvedCount > 0 ? Math.round(totalTokens / resolvedCount) : null;
    const pairedResolvedCount = pairedResolvedIds.length;
    const pairedResolvedTokenReduction =
      arm === baselineArm
        ? pairedResolvedCount > 0
          ? 0
          : null
        : pairedResolvedCount > 0 && pairedBaseTokens > 0
          ? round4((pairedBaseTokens - pairedArmTokens) / pairedBaseTokens)
          : null;

    out[arm] = {
      arm,
      totalInstances,
      resolvedCount,
      resolvedRate,
      totalTokens,
      tokensPerResolved,
      pairedBaselineArm: baselineArm ?? null,
      pairedResolvedCount,
      pairedResolvedIds,
      pairedResolvedTokenReduction,
      meanSteps: totalInstances > 0 ? round4(totalSteps / totalInstances) : 0,
      meanWallClockMs: totalInstances > 0 ? Math.round(totalWallClockMs / totalInstances) : 0,
      cacheHitRate:
        totalCacheEligibleInputTokens > 0
          ? round4(Math.min(1, totalCacheReadTokens / totalCacheEligibleInputTokens))
          : 0,
    };
  }

  return out;
}

function escapeLatex(text) {
  return String(text ?? '')
    .replaceAll('\\', '\\textbackslash{}')
    .replaceAll('&', '\\&')
    .replaceAll('%', '\\%')
    .replaceAll('$', '\\$')
    .replaceAll('#', '\\#')
    .replaceAll('_', '\\_')
    .replaceAll('{', '\\{')
    .replaceAll('}', '\\}');
}

function formatLatexPct(rate) {
  return `${((Number(rate) || 0) * 100).toFixed(2)}\\%`;
}

function formatLatexInt(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '--';
  return String(Math.round(Number(value)));
}

/**
 * Renders a publication-ready LaTeX `booktabs` comparison table (`swebench-paper-table.tex`).
 */
export function renderPaperLatexTable({
  arms = [],
  metricsByArm = {},
  pairedByArm = {},
  meta = {},
} = {}) {
  const effectiveArms =
    Array.isArray(arms) && arms.length > 0 ? arms : Object.keys(metricsByArm ?? {});
  const captionParts = [];
  if (meta?.subset) captionParts.push(`subset=${meta.subset}`);
  if (meta?.model) captionParts.push(`model=${meta.model}`);
  if (meta?.seed != null) captionParts.push(`seed=${meta.seed}`);
  const captionSuffix = captionParts.length > 0 ? ` (${escapeLatex(captionParts.join(', '))})` : '';

  const lines = [
    '% Auto-generated by Agent_US SWE-bench Verified Evaluator',
    '\\begin{table}[htbp]',
    '\\centering',
    `\\caption{SWE-bench Verified Evaluation Comparison${captionSuffix}}`,
    '\\label{tab:swebench-verified-comparison}',
    '\\begin{tabular}{lrrrrrrrr}',
    '\\toprule',
    'Arm & Resolved & Resolve Rate & Cache Hit & Mean Steps & Mean Wall (ms) & Mean Tok & Tok/Resolved & Paired Tok Red \\\\',
    '\\midrule',
  ];

  for (const arm of effectiveArms) {
    const m = metricsByArm?.[arm] ?? {};
    const p = pairedByArm?.[arm] ?? {};
    const totalInstances = Number(p.totalInstances ?? m.totalInstances ?? 0) || 0;
    const resolvedCount = Number(p.resolvedCount ?? m.resolvedCount ?? 0) || 0;
    const resolvedRate =
      p.resolvedRate ?? m.resolvedRate ?? (totalInstances > 0 ? resolvedCount / totalInstances : 0);
    const cacheHitRate = p.cacheHitRate ?? m.cacheHitRate ?? 0;
    const meanSteps = Number(p.meanSteps ?? m.meanSteps ?? 0) || 0;
    const meanWallClockMs = p.meanWallClockMs ?? m.meanWallClockMs ?? 0;
    const totalTokens = p.totalTokens ?? m.totalTokens;
    const meanTok =
      m.meanTokens != null
        ? m.meanTokens
        : totalInstances > 0 && totalTokens != null
          ? Number(totalTokens) / totalInstances
          : null;
    const tokPerResolved = p.tokensPerResolved ?? m.tokensPerResolved ?? null;
    const pairedRed = p.pairedResolvedTokenReduction ?? m.pairedResolvedTokenReduction ?? null;
    const pairedCount = p.pairedResolvedCount ?? m.pairedResolvedCount ?? 0;
    const pairedStr =
      pairedRed === null || pairedRed === undefined
        ? '--'
        : `${formatLatexPct(pairedRed)} (n=${pairedCount})`;

    lines.push(
      `\\texttt{${escapeLatex(arm)}} & ${resolvedCount}/${totalInstances} & ${formatLatexPct(resolvedRate)} & ${formatLatexPct(cacheHitRate)} & ${meanSteps.toFixed(2)} & ${formatLatexInt(meanWallClockMs)} & ${formatLatexInt(meanTok)} & ${formatLatexInt(tokPerResolved)} & ${pairedStr} \\\\`,
    );
  }

  lines.push(
    '\\bottomrule',
    '\\end{tabular}',
    '\\end{table}',
  );

  return `${lines.join('\n')}\n`;
}
