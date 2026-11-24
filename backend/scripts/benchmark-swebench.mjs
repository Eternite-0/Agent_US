#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { estimateTokens } from '../src/context.js';
import { DirectAgentRuntime } from '../src/direct-agent.js';
import { redactSecrets } from '../src/envelope.js';
import { stableTools } from '../src/observability/prompt-cache.js';
import { AccountPool } from '../src/pool.js';
import { Store } from '../src/store.js';
import {
  BenchmarkSandbox,
  SANDBOX_MODES,
  runHardenedGit,
  runHardenedGitSync,
} from '../src/tools/benchmark-sandbox.js';

export const SWEBENCH_BENCHMARK_ID = 'agent-us-swebench-verified';
export const SWEBENCH_BENCHMARK_VERSION = '1.0.0';
export const DEFAULT_ARMS = Object.freeze(['raw_full', 'full_aci']);
export const VALID_SWEBENCH_ARMS = Object.freeze(
  new Set([
    'raw_full',
    'deterministic_progressive',
    'retrieval_supervisor',
    'full_aci',
    'aci_25',
    'aci_26',
  ]),
);
export const DEFAULT_MAX_STEPS = 60;
export const MAX_ALLOWED_STEPS = 80;
export const CACHE_BLOCK_TOKENS = 64;

const SUPERVISOR_WIRE_MARKER = 'Supervisor for Adaptive Context Intelligence (ACI)';
const TEMP_CACHE_DIR_NAMES = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
]);
const TEMP_CACHE_FILE_RE = /\.(?:pyc|pyo)$/i;
const SAFE_TEST_CMD_RE =
  /^(?:pytest|python(?:\s+-m\s+(?:pytest|unittest))?|git\s+(?:diff|status|log|show)|npm\s+test|node\s+--test)\b/i;

function printSweBenchUsage() {
  console.log(
    [
      'Usage: node backend/scripts/benchmark-swebench.mjs [options]',
      '',
      'Options:',
      '  --dataset <path>           Local .jsonl or .json SWE-bench Verified dataset',
      '  --dry-run                  Run deterministic offline Python bug trajectory with 64-tok KV sim',
      '  --arms <csv>               Comma-separated ACI arms (default: raw_full,full_aci)',
      '  --model <model>            Model alias / name for predictions & inference',
      '  --max-steps <n>            Max agent steps per instance (default: 60, max: 80)',
      '  --output-dir <dir>         Directory for predictions.<arm>.jsonl, telemetry.<arm>.jsonl, summary.md',
      '  --workspace-root <dir>     Base directory containing checked-out target repositories',
      '  --docker-image <pattern>   Optional Docker image pattern (supports {instance_id}, {repo})',
      '  --instance-ids <csv>       Comma-separated subset of instance_id values to run',
      '  --limit <n>                Maximum number of instances to run after filtering',
      '  --concurrency <n>          Concurrent isolated instance workers (default: 1)',
      '  --resume                   Skip instance_ids already present in predictions/telemetry files',
      '  --json                     Print JSON summary to stdout',
      '  --help                     Show this help message',
    ].join('\n'),
  );
}

/**
 * Parses CLI flags for SWE-bench Verified benchmark execution.
 */
export function parseSweBenchCliArgs(argv = process.argv.slice(2)) {
  const opts = {
    dataset: null,
    dryRun: false,
    arms: [...DEFAULT_ARMS],
    model: null,
    maxSteps: DEFAULT_MAX_STEPS,
    outputDir: null,
    workspaceRoot: null,
    dockerImage: null,
    instanceIds: null,
    limit: null,
    concurrency: 1,
    resume: false,
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
    else if (arg === '--resume') opts.resume = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--dataset') opts.dataset = String(nextVal());
    else if (arg.startsWith('--dataset=')) opts.dataset = splitEq('--dataset');
    else if (arg === '--arms') {
      opts.arms = String(nextVal())
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg.startsWith('--arms=')) {
      opts.arms = splitEq('--arms')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg === '--model') opts.model = String(nextVal()).trim();
    else if (arg.startsWith('--model=')) opts.model = splitEq('--model').trim();
    else if (arg === '--max-steps') opts.maxSteps = Number(nextVal());
    else if (arg.startsWith('--max-steps=')) opts.maxSteps = Number(splitEq('--max-steps'));
    else if (arg === '--output-dir') opts.outputDir = String(nextVal());
    else if (arg.startsWith('--output-dir=')) opts.outputDir = splitEq('--output-dir');
    else if (arg === '--workspace-root') opts.workspaceRoot = String(nextVal());
    else if (arg.startsWith('--workspace-root=')) opts.workspaceRoot = splitEq('--workspace-root');
    else if (arg === '--docker-image') opts.dockerImage = String(nextVal());
    else if (arg.startsWith('--docker-image=')) opts.dockerImage = splitEq('--docker-image');
    else if (arg === '--instance-ids') {
      opts.instanceIds = String(nextVal())
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--instance-ids=')) {
      opts.instanceIds = splitEq('--instance-ids')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === '--limit') opts.limit = Number(nextVal());
    else if (arg.startsWith('--limit=')) opts.limit = Number(splitEq('--limit'));
    else if (arg === '--concurrency') opts.concurrency = Number(nextVal());
    else if (arg.startsWith('--concurrency=')) opts.concurrency = Number(splitEq('--concurrency'));
    else throw new Error(`Unknown CLI flag: ${arg}`);
  }

  if (!opts.arms.length || opts.arms.some((arm) => !VALID_SWEBENCH_ARMS.has(arm))) {
    throw new Error(
      `Invalid --arms "${opts.arms.join(',')}"; expected subset of ${[...VALID_SWEBENCH_ARMS].join(',')}`,
    );
  }
  opts.arms = [...new Set(opts.arms)];

  if (!Number.isInteger(opts.maxSteps) || opts.maxSteps < 1) {
    throw new Error('--max-steps must be a positive integer');
  }
  opts.maxSteps = Math.min(MAX_ALLOWED_STEPS, opts.maxSteps);

  if (opts.limit !== null && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 32) {
    throw new Error('--concurrency must be an integer between 1 and 32');
  }
  if (opts.instanceIds && opts.instanceIds.length === 0) {
    opts.instanceIds = null;
  }
  if (!opts.help && !opts.dryRun && !opts.dataset) {
    throw new Error('Provide --dataset <path> or --dry-run');
  }

  return opts;
}

/**
 * Normalizes a raw SWE-bench dataset row into a validated canonical instance object.
 */
export function normalizeSweBenchInstance(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Dataset entry #${index} must be a JSON object`);
  }
  const instanceId = String(raw.instance_id ?? raw.id ?? '').trim();
  const repo = String(raw.repo ?? '').trim();
  const baseCommit = String(raw.base_commit ?? raw.commit ?? '').trim();
  const problemStatement = String(raw.problem_statement ?? raw.prompt ?? '').trim();
  const hintsText = String(raw.hints_text ?? raw.hints ?? '').trim();
  const workspacePath = raw.workspace_path ? String(raw.workspace_path).trim() : null;
  const testCmd = raw.test_cmd ? String(raw.test_cmd).trim() : null;

  if (!instanceId) throw new Error(`Dataset entry #${index} is missing instance_id`);
  if (!problemStatement) throw new Error(`Dataset entry "${instanceId}" is missing problem_statement`);
  if (!repo && !workspacePath) {
    throw new Error(`Dataset entry "${instanceId}" must specify repo or workspace_path`);
  }
  if (!baseCommit) {
    throw new Error(`Dataset entry "${instanceId}" is missing base_commit`);
  }

  return {
    instance_id: instanceId,
    repo,
    base_commit: baseCommit,
    problem_statement: problemStatement,
    hints_text: hintsText,
    workspace_path: workspacePath,
    test_cmd: testCmd,
  };
}

/**
 * Loads and filters a local `.jsonl` or `.json` SWE-bench Verified dataset.
 */
export function loadSweBenchDataset(datasetPath, { instanceIds = null, limit = null } = {}) {
  const absPath = resolve(String(datasetPath));
  if (!existsSync(absPath)) {
    throw new Error(`Dataset file not found: ${absPath}`);
  }
  const rawText = readFileSync(absPath, 'utf8').trim();
  if (!rawText) return [];

  let rawRows;
  const lower = absPath.toLowerCase();
  if (lower.endsWith('.json') || (!lower.endsWith('.jsonl') && rawText.startsWith('['))) {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      rawRows = parsed;
    } else if (parsed && typeof parsed === 'object') {
      rawRows =
        parsed.instances ??
        parsed.data ??
        parsed.records ??
        (parsed.instance_id || parsed.id ? [parsed] : null);
      if (!Array.isArray(rawRows)) {
        throw new Error(`Unsupported JSON dataset shape in ${absPath}`);
      }
    } else {
      throw new Error(`Unsupported JSON dataset value in ${absPath}`);
    }
  } else {
    rawRows = [];
    const lines = rawText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        rawRows.push(JSON.parse(line));
      } catch (err) {
        throw new Error(`Invalid JSONL at line ${i + 1} in ${absPath}: ${err.message}`);
      }
    }
  }

  let instances = rawRows.map((row, idx) => normalizeSweBenchInstance(row, idx));
  if (Array.isArray(instanceIds) && instanceIds.length > 0) {
    const wanted = new Set(instanceIds.map((id) => String(id).trim()).filter(Boolean));
    instances = instances.filter((inst) => wanted.has(inst.instance_id));
  }
  if (limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0) {
    instances = instances.slice(0, Math.trunc(Number(limit)));
  }
  return instances;
}

/**
 * Formats a SWE-bench instance prompt with problem description, hints, and verification rules.
 */
export function buildSweBenchPrompt(instance) {
  const parts = [
    `Repository: ${instance.repo || 'local'}`,
    `Instance ID: ${instance.instance_id}`,
    `Base Commit: ${instance.base_commit}`,
    '',
    'Problem Statement:',
    instance.problem_statement,
  ];
  if (instance.hints_text) {
    parts.push('', 'Hints:', instance.hints_text);
  }
  if (instance.test_cmd) {
    parts.push('', `Suggested Test Command: ${instance.test_cmd}`);
  }
  parts.push(
    '',
    'Locate the root cause using grep and read_file, apply a minimal targeted fix, run the relevant test suite to confirm all tests pass, and verify the resulting git diff.',
  );
  return parts.join('\n');
}

function runGitSyncChecked(args, cwd) {
  const res = runHardenedGitSync(args, { cwd, allowNetwork: false, timeoutMs: 30_000 });
  if (res.error || res.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd}: ${res.stderr?.trim() || res.error?.message || `exit ${res.exitCode}`}`,
    );
  }
  return res.stdout;
}

async function runGitAsyncChecked(args, cwd) {
  const res = await runHardenedGit(args, { cwd, allowNetwork: false, timeoutMs: 30_000 });
  if (res.timedOut || res.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd}: ${res.stderr?.trim() || `exit ${res.exitCode}`}`,
    );
  }
  return res.stdout;
}

/**
 * Removes temporary Python and pytest cache artifacts without touching `.git`.
 */
export function cleanPythonTestCaches(workspaceRoot) {
  const root = resolve(String(workspaceRoot));
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === '.git' || ent.isSymbolicLink()) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (TEMP_CACHE_DIR_NAMES.has(ent.name)) {
          rmSync(full, { recursive: true, force: true });
        } else {
          walk(full);
        }
      } else if (ent.isFile() && TEMP_CACHE_FILE_RE.test(ent.name)) {
        rmSync(full, { force: true });
      }
    }
  };
  walk(root);
}

/**
 * Cleanly resets a Git worktree back to `baseCommit` and removes untracked artifacts.
 */
export async function resetGitWorktreeToCommit(workspaceRoot, baseCommit) {
  cleanPythonTestCaches(workspaceRoot);
  await runGitAsyncChecked(['reset', '--hard', baseCommit], workspaceRoot);
  await runGitAsyncChecked(['clean', '-fdx'], workspaceRoot);
}

function isCacheArtifactRelPath(relPath) {
  const norm = String(relPath ?? '').replace(/\\/g, '/');
  return (
    /(?:^|\/)(?:__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox)(?:\/|$)/i.test(norm) ||
    TEMP_CACHE_FILE_RE.test(norm) ||
    norm === '.coverage'
  );
}

/**
 * Extracts a clean unified diff against `baseCommit`, ignoring Python/pytest caches.
 */
export async function extractInstanceGitDiff(workspaceRoot, baseCommit = 'HEAD') {
  cleanPythonTestCaches(workspaceRoot);

  const untrackedOut = await runGitAsyncChecked(
    ['ls-files', '--others', '--exclude-standard'],
    workspaceRoot,
  );
  const untracked = untrackedOut
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isCacheArtifactRelPath(line) && !line.startsWith('.agent-us/'));

  if (untracked.length > 0) {
    await runGitAsyncChecked(['add', '-N', '--', ...untracked], workspaceRoot);
  }

  const diffArgs = [
    'diff',
    '--no-ext-diff',
    baseCommit,
    '--',
    '.',
    ':(exclude)__pycache__',
    ':(exclude)**/__pycache__/**',
    ':(exclude).pytest_cache',
    ':(exclude).pytest_cache/**',
    ':(exclude).mypy_cache/**',
    ':(exclude).ruff_cache/**',
    ':(exclude)*.pyc',
    ':(exclude)*.pyo',
  ];
  const rawPatch = await runGitAsyncChecked(diffArgs, workspaceRoot);
  const patch = rawPatch.trim() ? (rawPatch.endsWith('\n') ? rawPatch : `${rawPatch}\n`) : '';

  const nameOnlyOut = await runGitAsyncChecked(
    ['diff', '--no-ext-diff', '--name-only', baseCommit, '--', '.', ':(exclude)**/__pycache__/**', ':(exclude).pytest_cache/**'],
    workspaceRoot,
  );
  const changedFiles = nameOnlyOut
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !isCacheArtifactRelPath(s));

  return { patch, changedFiles };
}

/**
 * Creates an isolated temporary Git repository containing a realistic Python tiered-discount bug.
 */
export function createDryRunRepository({ baseDir = null } = {}) {
  const repoDir = baseDir
    ? resolve(String(baseDir))
    : mkdtempSync(join(tmpdir(), 'agent-us-swebench-dry-'));
  mkdirSync(join(repoDir, 'src', 'discounts'), { recursive: true });
  mkdirSync(join(repoDir, 'tests'), { recursive: true });
  mkdirSync(join(repoDir, 'docs'), { recursive: true });

  writeFileSync(join(repoDir, 'pyproject.toml'), '[tool.pytest.ini_options]\npythonpath = ["."]\n', 'utf8');
  writeFileSync(join(repoDir, 'src', '__init__.py'), '', 'utf8');
  writeFileSync(join(repoDir, 'src', 'discounts', '__init__.py'), 'from .calculator import OrderLine, calculate_tiered_discount\n', 'utf8');
  writeFileSync(
    join(repoDir, 'src', 'discounts', 'calculator.py'),
    [
      'from dataclasses import dataclass',
      '',
      '',
      '@dataclass(frozen=True)',
      'class OrderLine:',
      '    sku: str',
      '    unit_price_cents: int',
      '    quantity: int',
      '',
      '',
      'def calculate_tiered_discount(',
      '    subtotal_cents: int,',
      '    *,',
      '    is_vip: bool = False,',
      '    promo_pct: float = 0.0,',
      '    max_discount_pct: float = 0.35,',
      ') -> int:',
      '    """Return the discounted order total in integer cents."""',
      '    if subtotal_cents < 0:',
      '        raise ValueError("subtotal_cents must be non-negative")',
      '    if promo_pct < 0 or max_discount_pct < 0:',
      '        raise ValueError("discount percentages must be non-negative")',
      '',
      '    tier_pct = 0.0',
      '    if subtotal_cents >= 20_000:',
      '        tier_pct = 0.15',
      '    elif subtotal_cents >= 10_000:',
      '        tier_pct = 0.10',
      '    elif subtotal_cents >= 5_000:',
      '        tier_pct = 0.05',
      '',
      '    vip_pct = 0.10 if is_vip else 0.0',
      '    combined_pct = tier_pct + vip_pct + promo_pct',
      '    effective_pct = combined_pct',
      '    discount_cents = round(subtotal_cents * effective_pct)',
      '    return max(0, subtotal_cents - discount_cents)',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(repoDir, 'tests', 'test_calculator.py'),
    [
      'import pytest',
      'from src.discounts.calculator import calculate_tiered_discount',
      '',
      '',
      'def test_standard_tier_without_cap_hit():',
      '    assert calculate_tiered_discount(10_000) == 9_000',
      '',
      '',
      'def test_vip_and_promo_respects_max_discount_cap():',
      '    # Tier 15% + VIP 10% + promo 20% = 45%, must cap at max_discount_pct=35%',
      '    assert calculate_tiered_discount(20_000, is_vip=True, promo_pct=0.20, max_discount_pct=0.35) == 13_000',
      '',
      '',
      'def test_negative_inputs_raise():',
      '    with pytest.raises(ValueError):',
      '        calculate_tiered_discount(-1)',
      '',
    ].join('\n'),
    'utf8',
  );

  // Unrelated historical changelog (>2600 chars) marked with explicit archived-decoy banner so full_aci admission demonstrates concrete token reduction.
  const legacySections = Array.from({ length: 32 }, (_, idx) => {
    const rev = idx + 1;
    return `### Legacy Batch v0.${rev}\nArchived regional wholesale tariff snapshot #${rev}: flat rebate matrix row=${rev * 12}bp, region=EMEA-${rev % 4}, sunset=2021-01-01.\n`;
  }).join('\n');
  writeFileSync(
    join(repoDir, 'docs', 'legacy_pricing_changelog.md'),
    `<!-- DO NOT EDIT - ARCHIVED DECOY -->\n# Legacy Pricing Archive\n\nDeprecated historical batch schedule retained for audit reference only.\n\n${legacySections}`,
    'utf8',
  );

  runGitSyncChecked(['init', '-q'], repoDir);
  runGitSyncChecked(['config', 'user.email', 'swebench-dryrun@agent-us.invalid'], repoDir);
  runGitSyncChecked(['config', 'user.name', 'Agent_US SWE-bench DryRun'], repoDir);
  runGitSyncChecked(['config', 'core.autocrlf', 'false'], repoDir);
  runGitSyncChecked(['config', 'core.filemode', 'false'], repoDir);
  runGitSyncChecked(['add', '-A'], repoDir);
  runGitSyncChecked(['commit', '-qm', 'baseline buggy discounts calculator'], repoDir);

  const baseCommit = runGitSyncChecked(['rev-parse', 'HEAD'], repoDir).trim();
  const instance = {
    instance_id: 'dryrun__discounts-calculator-01',
    repo: 'acme/discounts',
    base_commit: baseCommit,
    problem_statement:
      'Fix calculate_tiered_discount in src/discounts/calculator.py so combined tier, VIP, and promo percentages are capped at max_discount_pct.',
    hints_text: 'Check how combined_pct is assigned to effective_pct before computing discount_cents.',
    workspace_path: repoDir,
    test_cmd: 'pytest -q',
  };

  return { repoDir, baseCommit, instance };
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          return extractTextFromContent(item.text ?? item.content ?? '');
        }
        return '';
      })
      .join('\n');
  }
  if (content && typeof content === 'object') {
    return extractTextFromContent(content.text ?? content.content ?? '');
  }
  return '';
}

/**
 * Detects whether a stream request belongs to the read-only ACI ContextSupervisor.
 */
export function isAciSupervisorWireRequest(opts) {
  if (!opts || typeof opts !== 'object') return false;
  if (Array.isArray(opts.tools) && opts.tools.length > 0) return false;
  if (extractTextFromContent(opts.system).includes(SUPERVISOR_WIRE_MARKER)) {
    return true;
  }
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  return messages.some(
    (msg) =>
      (msg?.role === 'system' || msg?.role === 'developer') &&
      extractTextFromContent(msg.content).includes(SUPERVISOR_WIRE_MARKER),
  );
}

/**
 * Splits a canonical wire prefix string into deterministic 64-token prefix blocks
 * using CJK-aware token weights consistent with `estimateTokens()`.
 */
export function tokenizePrefixBlocks64(canonicalPrefix, blockTokens = CACHE_BLOCK_TOKENS) {
  const text = String(canonicalPrefix ?? '');
  if (!text) return { fullBlocks: [], totalTokens: 0 };

  const fullBlocks = [];
  let blockStart = 0;
  let blockWeight = 0;
  let totalWeight = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af);
    const charWeight = isCjk ? 1 / 1.7 : 0.25;
    blockWeight += charWeight;
    totalWeight += charWeight;

    if (blockWeight >= blockTokens) {
      fullBlocks.push(text.slice(blockStart, i + 1));
      blockStart = i + 1;
      blockWeight = 0;
    }
  }

  return {
    fullBlocks,
    totalTokens: Math.max(1, Math.ceil(totalWeight)),
  };
}

function buildCanonicalPrefixString(opts) {
  const toolPart = `TOOLS:${JSON.stringify(stableTools(opts?.tools ?? []))}`;
  const sysPart = opts?.system ? `\nSYSTEM:${JSON.stringify(opts.system)}` : '';
  const msgs = Array.isArray(opts?.messages) ? opts.messages : [];
  const msgPart = msgs.map((m, idx) => `\nMSG[${idx}]:${JSON.stringify(m)}`).join('');
  return `${toolPart}${sysPart}${msgPart}`;
}

function hasToolResultId(messages, callId) {
  return (messages ?? []).some((m) => m?.role === 'tool' && m?.toolCallId === callId);
}

function getToolResultText(messages, callId) {
  const msg = (messages ?? []).find((m) => m?.role === 'tool' && m?.toolCallId === callId);
  return msg ? extractTextFromContent(msg.content) : '';
}

/**
 * Deterministic LlmAdapter implementing a 64-token prefix-block KV cache simulator
 * and the multi-step Python debugging trajectory for `--dry-run`.
 */
export class PrefixBlockCacheSimulatorAdapter extends LlmAdapter {
  constructor({ blockTokens = CACHE_BLOCK_TOKENS } = {}) {
    super();
    this.blockTokens = blockTokens;
    this.cachedChainHashes = new Set();
    this.observations = [];
  }

  resetCache() {
    this.cachedChainHashes.clear();
  }

  simulatePrefixCache(opts) {
    const prefixText = buildCanonicalPrefixString(opts);
    const { fullBlocks, totalTokens } = tokenizePrefixBlocks64(prefixText, this.blockTokens);

    let prevChain = 'root';
    let matchedBlocks = 0;
    let prefixIntact = true;
    const blockChains = [];

    for (const block of fullBlocks) {
      const chainHash = createHash('sha256')
        .update(`${prevChain}|${block}`, 'utf8')
        .digest('hex');
      blockChains.push(chainHash);
      if (prefixIntact && this.cachedChainHashes.has(chainHash)) {
        matchedBlocks += 1;
      } else {
        prefixIntact = false;
      }
      prevChain = chainHash;
    }

    for (const ch of blockChains) {
      this.cachedChainHashes.add(ch);
    }

    const cacheReadTokens = Math.min(totalTokens, matchedBlocks * this.blockTokens);
    const cacheEligibleInputTokens = totalTokens;
    const cacheWriteTokens = Math.max(0, cacheEligibleInputTokens - cacheReadTokens);

    return {
      inputTokens: totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheEligibleInputTokens,
      matchedBlocks,
      totalBlocks: fullBlocks.length,
    };
  }

  async *stream(opts) {
    const cacheUsage = this.simulatePrefixCache(opts);

    if (isAciSupervisorWireRequest(opts)) {
      const userText = extractTextFromContent(opts?.messages?.at(-1)?.content);
      let decisions = [];
      try {
        const parsed = JSON.parse(userText);
        const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
        decisions = candidates.map((c) => {
          const isDecoy = Boolean(c?.isDecoy) || /legacy|changelog|archive/i.test(String(c?.path ?? ''));
          return {
            id: c.id,
            decision: isDecoy ? 'IRRELEVANT' : 'SUPPORTING',
            focusSymbols: Array.isArray(c?.symbols) ? c.symbols.slice(0, 4) : [],
            reason: isDecoy ? 'Exclude unrelated legacy pricing changelog' : 'Active supporting context',
          };
        });
      } catch {
        decisions = [];
      }
      const responseText = JSON.stringify({
        decisions,
        keepRefs: [],
        compressRefs: [],
        expandSuggestions: [],
        contractHints: ['Protect src/discounts/calculator.py and tests/test_calculator.py.'],
        summary: 'Retain active discount calculator context; omit legacy changelog.',
      });
      yield { type: 'text-delta', index: 0, text: responseText };
      yield {
        type: 'usage',
        usage: {
          inputTokens: cacheUsage.inputTokens,
          outputTokens: Math.max(1, estimateTokens(responseText)),
          cacheReadTokens: cacheUsage.cacheReadTokens,
          cacheWriteTokens: cacheUsage.cacheWriteTokens,
          cacheEligibleInputTokens: cacheUsage.cacheEligibleInputTokens,
        },
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    const msgs = Array.isArray(opts?.messages) ? opts.messages : [];
    let toolCalls = null;
    let reasoning = '';
    let finalText = '';

    if (!hasToolResultId(msgs, 'dry-grep')) {
      reasoning = 'Locate calculate_tiered_discount definition and callers using grep.';
      toolCalls = [
        {
          id: 'dry-grep',
          name: 'grep',
          arguments: JSON.stringify({ query: 'calculate_tiered_discount' }),
        },
      ];
    } else if (!hasToolResultId(msgs, 'dry-read-calc')) {
      reasoning = 'Read calculator source, unit tests, and pricing changelog context.';
      toolCalls = [
        {
          id: 'dry-read-calc',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'src/discounts/calculator.py' }),
        },
        {
          id: 'dry-read-test',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'tests/test_calculator.py' }),
        },
        {
          id: 'dry-read-legacy',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'docs/legacy_pricing_changelog.md' }),
        },
      ];
    } else if (!hasToolResultId(msgs, 'dry-edit-calc')) {
      reasoning = 'Cap combined_pct with max_discount_pct in src/discounts/calculator.py.';
      toolCalls = [
        {
          id: 'dry-edit-calc',
          name: 'edit_file',
          arguments: JSON.stringify({
            path: 'src/discounts/calculator.py',
            target: '    effective_pct = combined_pct',
            replacement: '    effective_pct = min(combined_pct, max_discount_pct)',
          }),
        },
      ];
    } else if (!hasToolResultId(msgs, 'dry-pytest')) {
      reasoning = 'Run pytest to verify the discount cap fix.';
      toolCalls = [
        {
          id: 'dry-pytest',
          name: 'bash',
          arguments: JSON.stringify({ command: 'pytest -q' }),
        },
      ];
    } else if (!hasToolResultId(msgs, 'dry-git-diff')) {
      reasoning = 'Inspect git diff to verify minimal clean patch.';
      toolCalls = [
        {
          id: 'dry-git-diff',
          name: 'bash',
          arguments: JSON.stringify({ command: 'git diff' }),
        },
      ];
    } else {
      const pytestOut = getToolResultText(msgs, 'dry-pytest');
      const diffOut = getToolResultText(msgs, 'dry-git-diff');
      reasoning = 'Verification and diff review completed.';
      finalText = [
        'Fixed calculate_tiered_discount in src/discounts/calculator.py to clamp combined_pct at max_discount_pct.',
        `Verification output: ${pytestOut.split(/\r?\n/)[0] || 'exitCode: 0'}`,
        diffOut.includes('calculator.py') ? 'Verified clean git diff on src/discounts/calculator.py.' : '',
      ]
        .filter(Boolean)
        .join(' ');
    }

    if (reasoning) {
      yield { type: 'reasoning-delta', index: 0, text: reasoning };
    }

    let emittedChars = reasoning.length;
    if (toolCalls) {
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        emittedChars += tc.name.length + tc.arguments.length;
        yield {
          type: 'block-end',
          index: i,
          block: { type: 'tool-call', ...tc },
        };
      }
    } else {
      emittedChars += finalText.length;
      yield { type: 'text-delta', index: 0, text: finalText };
    }

    const outputTokens = Math.max(8, Math.ceil(emittedChars / 4));
    this.observations.push({
      step: this.observations.length + 1,
      ...cacheUsage,
      outputTokens,
    });

    yield {
      type: 'usage',
      usage: {
        inputTokens: cacheUsage.inputTokens,
        outputTokens,
        cacheReadTokens: cacheUsage.cacheReadTokens,
        cacheWriteTokens: cacheUsage.cacheWriteTokens,
        cacheEligibleInputTokens: cacheUsage.cacheEligibleInputTokens,
      },
    };
    yield { type: 'finish', reason: { kind: toolCalls ? 'tool-calls' : 'stop' } };
  }
}

/**
 * Formats a SWE-bench official evaluator prediction entry.
 */
export function formatPredictionRecord({ instanceId, modelName, modelPatch }) {
  return {
    instance_id: String(instanceId),
    model_name_or_path: String(modelName),
    model_patch: String(modelPatch ?? ''),
  };
}

function readJsonlRecords(filePath, idField = 'instance_id') {
  const byId = new Map();
  if (!existsSync(filePath)) return byId;
  const raw = readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const id = String(parsed?.[idField] ?? '').trim();
      if (id) byId.set(id, parsed);
    } catch {
      // Ignore truncated trailing line on resume
    }
  }
  return byId;
}

/**
 * Loads already completed `instance_id`s and rows for an arm from existing JSONL outputs.
 */
export function loadCompletedInstanceIds(outputDir, arm) {
  const predPath = join(outputDir, `predictions.${arm}.jsonl`);
  const telePath = join(outputDir, `telemetry.${arm}.jsonl`);
  const predExists = existsSync(predPath);
  const teleExists = existsSync(telePath);
  const predictionsById = readJsonlRecords(predPath, 'instance_id');
  const telemetryById = readJsonlRecords(telePath, 'instance_id');

  const completedIds = new Set();
  if (predExists && teleExists) {
    for (const id of predictionsById.keys()) {
      if (telemetryById.has(id)) completedIds.add(id);
    }
  } else if (predExists) {
    for (const id of predictionsById.keys()) completedIds.add(id);
  } else if (teleExists) {
    for (const id of telemetryById.keys()) completedIds.add(id);
  }

  return { predictionsById, telemetryById, completedIds, predPath, telePath };
}

function prepareJsonlFile(filePath, resume) {
  mkdirSync(dirname(filePath), { recursive: true });
  if (!resume || !existsSync(filePath)) {
    writeFileSync(filePath, '', { encoding: 'utf8', mode: 0o600 });
    return;
  }
  const existing = readFileSync(filePath, 'utf8');
  if (existing.length > 0 && !existing.endsWith('\n')) {
    appendFileSync(filePath, '\n', { encoding: 'utf8', mode: 0o600 });
  }
}

function appendJsonlRecord(filePath, record) {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function round4(value) {
  return Number((Number(value) || 0).toFixed(4));
}

/**
 * Aggregates per-arm SWE-bench telemetry and patch statistics.
 */
export function computeArmAggregateMetrics(arm, telemetryRows = [], predictionRows = []) {
  const rows = Array.isArray(telemetryRows) ? telemetryRows : [];
  const predsById = new Map(
    (predictionRows ?? []).map((p) => [String(p?.instance_id ?? ''), p]),
  );

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheEligibleInputTokens = 0;
  let totalSteps = 0;
  let totalWallClockMs = 0;
  let nonEmptyPatches = 0;
  let completedInstances = 0;
  let admissionOriginalTokens = 0;
  let admissionInjectedTokens = 0;
  let admissionSavedTokens = 0;
  let epochTransitions = 0;
  const seenIds = new Set();

  for (const row of rows) {
    const id = String(row?.instance_id ?? '');
    if (id) seenIds.add(id);
    const inTok = Number(row?.inputTokens ?? 0) || 0;
    const outTok = Number(row?.outputTokens ?? 0) || 0;
    const crTok = Number(row?.cacheReadTokens ?? 0) || 0;
    const rawEligible = row?.cacheEligibleInputTokens;
    const eligibleTok =
      rawEligible != null && Number.isFinite(Number(rawEligible)) && Number(rawEligible) > 0
        ? Number(rawEligible)
        : inTok;

    totalInputTokens += inTok;
    totalOutputTokens += outTok;
    totalCacheReadTokens += crTok;
    totalCacheEligibleInputTokens += eligibleTok;
    totalSteps += Number(row?.steps ?? 0) || 0;
    totalWallClockMs += Number(row?.wallClockMs ?? 0) || 0;

    if (row?.status === 'completed') completedInstances += 1;
    const predPatch = predsById.get(id)?.model_patch ?? '';
    const isNonEmpty = Boolean(row?.nonEmptyPatch) || String(predPatch).trim().length > 0;
    if (isNonEmpty) nonEmptyPatches += 1;

    const admOrig = Number(row?.admissionOriginalTokens ?? 0) || 0;
    const admInj = Number(row?.admissionInjectedTokens ?? 0) || 0;
    const admSaved =
      row?.admissionSavedTokens != null
        ? Number(row.admissionSavedTokens) || 0
        : Math.max(0, admOrig - admInj);
    admissionOriginalTokens += admOrig;
    admissionInjectedTokens += admInj;
    admissionSavedTokens += admSaved;
    epochTransitions += Number(row?.epochTransitions ?? 0) || 0;
  }

  let predOnlyCount = 0;
  for (const [id, pred] of predsById.entries()) {
    if (!id || seenIds.has(id)) continue;
    predOnlyCount += 1;
    completedInstances += 1;
    if (String(pred?.model_patch ?? '').trim().length > 0) {
      nonEmptyPatches += 1;
    }
  }

  const count = rows.length + predOnlyCount;
  const cacheHitRate =
    totalCacheEligibleInputTokens > 0
      ? round4(Math.min(1, totalCacheReadTokens / totalCacheEligibleInputTokens))
      : 0;
  const nonEmptyPatchRate = count > 0 ? round4(nonEmptyPatches / count) : 0;
  const admissionTokenReductionRate =
    admissionOriginalTokens > 0
      ? round4(Math.max(0, Math.min(1, admissionSavedTokens / admissionOriginalTokens)))
      : 0;

  return {
    arm,
    totalInstances: count,
    completedInstances,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalCacheReadTokens,
    totalCacheEligibleInputTokens,
    cacheHitRate,
    totalSteps,
    meanSteps: count > 0 ? round4(totalSteps / count) : 0,
    totalWallClockMs,
    meanWallClockMs: count > 0 ? Math.round(totalWallClockMs / count) : 0,
    nonEmptyPatches,
    nonEmptyPatchRate,
    admissionOriginalTokens,
    admissionInjectedTokens,
    admissionSavedTokens,
    admissionTokenReductionRate,
    epochTransitions,
  };
}

function formatPct(rate) {
  return `${((Number(rate) || 0) * 100).toFixed(2)}%`;
}

/**
 * Renders `summary.md` reporting per-arm SWE-bench and ACI telemetry metrics.
 */
export function renderSummaryMarkdown({ arms, metricsByArm, telemetryByArm = {}, meta = {} }) {
  const lines = [
    '# SWE-bench Verified Benchmark Summary',
    '',
    `- **Benchmark**: ${SWEBENCH_BENCHMARK_ID} v${SWEBENCH_BENCHMARK_VERSION}`,
    `- **Mode**: ${meta.dryRun ? 'dry-run (64-token prefix-block KV simulator)' : 'dataset'}`,
    `- **Model**: ${meta.model ?? 'default'}`,
    `- **Max Steps**: ${meta.maxSteps ?? DEFAULT_MAX_STEPS}`,
    `- **Arms**: ${arms.join(', ')}`,
    `- **Resumed**: ${Boolean(meta.resumed)}`,
    `- **Updated At**: ${meta.updatedAt ?? new Date().toISOString()}`,
    '',
    '## Per-Arm Metrics',
    '',
    '| Arm | Instances | Total Input Tokens | Total Output Tokens | Real Provider Cache Hit Rate | Steps (Mean) | Wall-Clock Time (ms) | Non-Empty Patch Rate | ACI Admission Token Reduction Rate | DTOC Epoch Transitions |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const arm of arms) {
    const m = metricsByArm[arm] ?? computeArmAggregateMetrics(arm, [], []);
    lines.push(
      `| \`${arm}\` | ${m.completedInstances}/${m.totalInstances} | ${m.totalInputTokens} | ${m.totalOutputTokens} | ${formatPct(m.cacheHitRate)} (${m.totalCacheReadTokens}/${m.totalCacheEligibleInputTokens}) | ${m.totalSteps} (${m.meanSteps}) | ${m.totalWallClockMs} | ${formatPct(m.nonEmptyPatchRate)} (${m.nonEmptyPatches}/${m.totalInstances}) | ${formatPct(m.admissionTokenReductionRate)} (${m.admissionSavedTokens}/${m.admissionOriginalTokens}) | ${m.epochTransitions} |`,
    );
  }

  lines.push('', '## Instance Telemetry', '');
  lines.push(
    '| Arm | Instance ID | Status | Steps | Input Tokens | Output Tokens | Cache Hit Rate | Wall-Clock (ms) | Non-Empty Patch | Admission Reduction | Epoch Transitions |',
  );
  lines.push(
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |',
  );

  for (const arm of arms) {
    for (const row of telemetryByArm[arm] ?? []) {
      lines.push(
        `| \`${arm}\` | \`${row.instance_id}\` | ${row.status} | ${row.steps} | ${row.inputTokens} | ${row.outputTokens} | ${formatPct(row.cacheHitRate)} | ${row.wallClockMs} | ${row.nonEmptyPatch ? 'yes' : 'no'} | ${formatPct(row.admissionTokenReductionRate)} | ${row.epochTransitions} |`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

function isAuthorizedBenchmarkToolCall(toolName, args, { customTestCmd = null } = {}) {
  const name = String(toolName ?? '').trim();
  if (
    [
      'read_file',
      'grep',
      'glob',
      'expand_context',
      'query_symbol_graph',
      'run_diagnostics',
      'inspect_repository',
      'edit_file',
      'write_file',
      'apply_patch',
    ].includes(name)
  ) {
    return true;
  }
  if (name === 'bash') {
    const cmd = String(args?.command ?? '').trim();
    if (!cmd) return false;
    if (customTestCmd && cmd === String(customTestCmd).trim()) return true;
    return SAFE_TEST_CMD_RE.test(cmd);
  }
  return false;
}

function resolveDockerImageForInstance(pattern, instance) {
  if (!pattern) return null;
  const slug = String(instance.repo || 'repo').replace(/\//g, '__');
  return String(pattern)
    .replace(/\{instance_id\}/g, instance.instance_id)
    .replace(/\{repo\}/g, instance.repo || 'repo')
    .replace(/\{repo_slug\}/g, slug);
}

function resolveSourceWorkspaceForInstance(instance, opts) {
  if (instance.workspace_path) {
    const base = opts.workspaceRoot ? resolve(opts.workspaceRoot) : process.cwd();
    const resolved = isAbsolute(instance.workspace_path)
      ? resolve(instance.workspace_path)
      : resolve(base, instance.workspace_path);
    if (!existsSync(resolved)) {
      throw new Error(`Workspace path not found for ${instance.instance_id}: ${resolved}`);
    }
    return resolved;
  }
  if (!opts.workspaceRoot) {
    throw new Error(
      `Instance "${instance.instance_id}" requires workspace_path or --workspace-root`,
    );
  }
  const root = resolve(opts.workspaceRoot);
  const candidates = [
    join(root, instance.instance_id),
    join(root, String(instance.repo || '').replace(/\//g, '__')),
    ...(instance.repo ? [join(root, ...instance.repo.split('/'))] : []),
    ...(existsSync(join(root, '.git')) ? [root] : []),
  ];
  for (const cand of candidates) {
    if (existsSync(cand) && existsSync(join(cand, '.git'))) {
      return cand;
    }
  }
  throw new Error(
    `Could not resolve git repository for "${instance.instance_id}" under ${root}`,
  );
}

async function createIsolatedTrialWorkspace(sourceRepo, baseCommit) {
  const trialWs = mkdtempSync(join(tmpdir(), 'agent-us-swe-ws-'));
  await runGitAsyncChecked(['clone', '--quiet', '--no-checkout', '--', sourceRepo, trialWs], tmpdir());
  try {
    await runGitAsyncChecked(['checkout', '--quiet', '--detach', baseCommit], trialWs);
  } catch {
    await runGitAsyncChecked(['fetch', '--quiet', sourceRepo, baseCommit], trialWs);
    await runGitAsyncChecked(['checkout', '--quiet', '--detach', baseCommit], trialWs);
  }
  await runGitAsyncChecked(['config', 'user.email', 'swebench@agent-us.invalid'], trialWs);
  await runGitAsyncChecked(['config', 'user.name', 'Agent_US SWE-bench'], trialWs);
  return trialWs;
}

function extractTurnTelemetryRow({
  store,
  turnId,
  sessionId,
  instance,
  arm,
  modelName,
  wallClockMs,
  modelPatch,
  turnRow,
}) {
  const evRow = store.db
    .prepare(
      "SELECT type, data FROM direct_events WHERE sessionId=? AND turnId=? AND type IN ('turn/completed','turn/failed','turn/cancelled') ORDER BY seq DESC LIMIT 1",
    )
    .get(sessionId, turnId);
  let evData = {};
  if (evRow?.data) {
    try {
      evData = JSON.parse(evRow.data);
    } catch {
      evData = {};
    }
  }

  const aciMetrics = evData?.reasoningMetrics?.aciMetrics ?? {};
  const aciTelemetry = evData?.aciTelemetry ?? aciMetrics?.aciTelemetry ?? {};
  const inputTokens = Number(evData?.inputTokens ?? turnRow?.inputTokens ?? 0) || 0;
  const outputTokens = Number(evData?.outputTokens ?? turnRow?.outputTokens ?? 0) || 0;
  const cacheReadTokens = Number(evData?.cacheReadTokens ?? 0) || 0;
  const cacheWriteTokens = Number(evData?.cacheWriteTokens ?? 0) || 0;
  const rawEligible = evData?.cacheEligibleInputTokens;
  const cacheEligibleInputTokens =
    rawEligible != null && Number.isFinite(Number(rawEligible)) && Number(rawEligible) > 0
      ? Number(rawEligible)
      : inputTokens;
  const cacheHitRate =
    cacheEligibleInputTokens > 0
      ? round4(Math.min(1, cacheReadTokens / cacheEligibleInputTokens))
      : 0;

  const admissionOriginalTokens = Number(aciMetrics?.admissionOriginalTokens ?? 0) || 0;
  const admissionInjectedTokens = Number(aciMetrics?.admissionInjectedTokens ?? 0) || 0;
  const admissionSavedTokens =
    aciMetrics?.admissionSavedTokens != null
      ? Number(aciMetrics.admissionSavedTokens) || 0
      : Math.max(0, admissionOriginalTokens - admissionInjectedTokens);
  const admissionTokenReductionRate =
    admissionOriginalTokens > 0
      ? round4(Math.max(0, Math.min(1, admissionSavedTokens / admissionOriginalTokens)))
      : 0;

  const epochTransitions = Number(
    aciTelemetry?.epochTransitions ?? aciMetrics?.epochTransitions ?? 0,
  ) || 0;
  const receiptCount =
    store.db
      .prepare('SELECT COUNT(*) AS n FROM tool_receipts WHERE sessionId=? AND turnId=?')
      .get(sessionId, turnId)?.n ?? 0;

  const nonEmptyPatch = String(modelPatch ?? '').trim().length > 0;
  const status = String(turnRow?.state ?? (evRow?.type === 'turn/completed' ? 'completed' : 'failed'));

  return {
    instance_id: instance.instance_id,
    arm,
    model: modelName,
    status,
    wallClockMs,
    steps: Number(evData?.steps ?? turnRow?.step ?? 0) || 0,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheEligibleInputTokens,
    cacheHitRate,
    nonEmptyPatch,
    patchBytes: Buffer.byteLength(String(modelPatch ?? ''), 'utf8'),
    admissionOriginalTokens,
    admissionInjectedTokens,
    admissionSavedTokens,
    admissionTokenReductionRate,
    epochTransitions,
    aciProfile: aciTelemetry?.aciProfile ?? aciMetrics?.aciProfile ?? arm,
    dtocPolicy: aciTelemetry?.dtocPolicy ?? aciMetrics?.dtocPolicy ?? null,
    admissionDecisions: aciMetrics?.admissionDecisions ?? aciTelemetry?.admissionDecisions ?? null,
    supervisorCost: aciMetrics?.supervisorCost ?? null,
    toolCallsCount: Number(receiptCount) || 0,
    error: turnRow?.error ? redactSecrets(String(turnRow.error)) : null,
    timestamp: new Date().toISOString(),
  };
}

function resolveLiveProviderConfig(opts) {
  const apiKey =
    process.env.SWEBENCH_API_KEY ||
    process.env.TI_BENCH_KEY ||
    process.env.AGENT_US_BENCH_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.OPENAI_API_KEY ||
    '';
  const endpoint =
    process.env.SWEBENCH_ENDPOINT ||
    process.env.TI_BENCH_ENDPOINT ||
    process.env.AGENT_US_BENCH_ENDPOINT ||
    'https://api.openai.com/v1';
  const protocol =
    process.env.SWEBENCH_PROTOCOL ||
    process.env.TI_BENCH_PROTOCOL ||
    'openai';
  const model =
    opts.model ||
    process.env.SWEBENCH_MODEL ||
    process.env.TI_BENCH_MODEL ||
    process.env.AGENT_US_BENCH_MODEL ||
    'deepseek-chat';
  return { apiKey, endpoint, protocol, model };
}

/**
 * Executes a single `(instance, arm)` evaluation turn via `DirectAgentRuntime`.
 */
async function runSweBenchInstanceArm({
  instance,
  arm,
  workspaceRoot,
  opts,
  adapter = null,
  providerConfig = null,
}) {
  const started = performance.now();
  const stateDir = mkdtempSync(join(tmpdir(), `agent-us-swe-state-${arm}-`));
  const store = new Store(join(stateDir, 'swebench.sqlite'));
  const pool = new AccountPool(store, { root: stateDir });

  const resolvedModel =
    opts.model ||
    providerConfig?.model ||
    (opts.dryRun ? `swebench-dry-run-sim` : 'agent-us-swebench');
  const modelNameForPrediction = opts.model
    ? opts.model
    : opts.dryRun
      ? `agent-us-dry-run-${arm}`
      : `agent-us-${arm}`;

  if (adapter || opts.dryRun) {
    pool.createAccount({
      preset: 'custom-openai',
      label: 'swebench-sim',
      credential: 'swebench-sim-key',
      protocol: 'openai',
      endpoint: 'https://swebench-sim.invalid/v1',
      models: [resolvedModel],
    });
    pool.setDefaultModel(resolvedModel);
  } else {
    if (!providerConfig?.apiKey) {
      throw new Error(
        'Live SWE-bench execution requires SWEBENCH_API_KEY, TI_BENCH_KEY, DEEPSEEK_API_KEY, or OPENAI_API_KEY (or use --dry-run)',
      );
    }
    pool.createAccount({
      preset: 'custom-openai',
      label: 'swebench-live',
      credential: providerConfig.apiKey,
      protocol: providerConfig.protocol || 'openai',
      endpoint: providerConfig.endpoint,
      models: [resolvedModel],
    });
    pool.setDefaultModel(resolvedModel);
  }

  if (arm === 'raw_full' || arm === 'deterministic_progressive') {
    store.setSetting?.('aci.config', {
      enabled: false,
      mode: 'off',
      admissionEnabled: arm !== 'raw_full',
    });
  } else {
    store.setSetting?.('aci.config', {
      enabled: true,
      mode: 'auto',
      admissionEnabled: true,
    });
  }

  const effectiveAdapter =
    adapter ?? (opts.dryRun ? new PrefixBlockCacheSimulatorAdapter() : null);

  const direct = new DirectAgentRuntime(store, pool, {
    defaultWorkspace: workspaceRoot,
    dataRoot: stateDir,
    ...(effectiveAdapter ? { adapter: effectiveAdapter } : {}),
  });

  let unsub = null;
  try {
    let sessionSandbox = null;
    if (!opts.dryRun && opts.dockerImage) {
      const dockerImage = resolveDockerImageForInstance(opts.dockerImage, instance);
      sessionSandbox = new BenchmarkSandbox({
        mode: SANDBOX_MODES.DOCKER,
        workspaceRoot,
        dockerImage,
        timeoutMs: 60_000,
      });
    }

    const session = direct.createSession({
      title: `SWE-bench · ${instance.instance_id} (${arm})`,
      workspaceRoot,
      model: resolvedModel,
      permissionMode: 'auto-safe',
      aciProfile: arm,
      budget: { maxSteps: opts.maxSteps },
      ...(sessionSandbox ? { sandbox: sessionSandbox, sandboxProfile: 'benchmark' } : {}),
      trafficSource: 'benchmark',
      isSynthetic: Boolean(opts.dryRun),
    });

    unsub = direct.subscribe(session.id, (evt) => {
      if (evt?.type !== 'approval/requested') return;
      const item = evt.data;
      const allowed = isAuthorizedBenchmarkToolCall(item.tool, item.arguments, {
        customTestCmd: instance.test_cmd,
      });
      queueMicrotask(() => {
        try {
          direct.decideApproval(item.approvalId, {
            decision: allowed ? 'allow' : 'deny',
            scope: 'once',
            reason: allowed
              ? 'Authorized SWE-bench tool execution'
              : 'Denied unauthorized SWE-bench tool execution',
          });
        } catch {
          // Turn may already be closed
        }
      });
    });

    const prompt = buildSweBenchPrompt(instance);
    const { turn } = direct.startTurn(session.id, {
      input: prompt,
      model: resolvedModel,
      permissionMode: 'auto-safe',
      maxSteps: opts.maxSteps,
      aciProfile: arm,
      trafficSource: 'benchmark',
      isSynthetic: Boolean(opts.dryRun),
    });

    const timeoutMs = opts.dryRun ? 60_000 : 600_000;
    const deadline = performance.now() + timeoutMs;
    let turnRow = null;
    while (performance.now() < deadline) {
      turnRow = direct.listTurns(session.id, { limit: 20 }).find((t) => t.id === turn.id);
      if (['completed', 'failed', 'cancelled', 'reconciling'].includes(turnRow?.state)) break;
      await delay(20);
    }
    if (!['completed', 'failed', 'cancelled', 'reconciling'].includes(turnRow?.state)) {
      direct.cancelTurn(turn.id);
      await direct.waitForTurnTerminal(turn.id, { timeoutMs: 5_000 }).catch(() => {});
      turnRow = direct.listTurns(session.id, { limit: 20 }).find((t) => t.id === turn.id) ?? turnRow;
    } else {
      await direct.waitForTurnTerminal(turn.id, { timeoutMs: 5_000 }).catch(() => {});
    }

    const wallClockMs = Math.max(1, Math.round(performance.now() - started));
    const { patch } = await extractInstanceGitDiff(workspaceRoot, instance.base_commit);

    const prediction = formatPredictionRecord({
      instanceId: instance.instance_id,
      modelName: modelNameForPrediction,
      modelPatch: patch,
    });
    const telemetry = extractTurnTelemetryRow({
      store,
      turnId: turn.id,
      sessionId: session.id,
      instance,
      arm,
      modelName: modelNameForPrediction,
      wallClockMs,
      modelPatch: patch,
      turnRow,
    });

    return { prediction, telemetry };
  } finally {
    unsub?.();
    await direct.close();
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
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

/**
 * Executes the SWE-bench Verified benchmark across requested ACI arms and writes
 * `predictions.<arm>.jsonl`, `telemetry.<arm>.jsonl`, and `summary.md`.
 */
export async function runSweBenchBenchmark(rawOpts = {}, runtimeDeps = {}) {
  const opts = {
    dataset: rawOpts.dataset ?? null,
    dryRun: Boolean(rawOpts.dryRun),
    arms: Array.isArray(rawOpts.arms) && rawOpts.arms.length ? [...rawOpts.arms] : [...DEFAULT_ARMS],
    model: rawOpts.model ?? null,
    maxSteps: Math.min(MAX_ALLOWED_STEPS, Math.max(1, Number(rawOpts.maxSteps ?? DEFAULT_MAX_STEPS))),
    outputDir: rawOpts.outputDir ?? null,
    workspaceRoot: rawOpts.workspaceRoot ?? null,
    dockerImage: rawOpts.dockerImage ?? null,
    instanceIds: rawOpts.instanceIds ?? null,
    limit: rawOpts.limit ?? null,
    concurrency: Math.max(1, Number(rawOpts.concurrency ?? 1)),
    resume: Boolean(rawOpts.resume),
  };

  let createdTempOutput = false;
  const outputDir = opts.outputDir
    ? resolve(String(opts.outputDir))
    : opts.dryRun
      ? ((createdTempOutput = true), mkdtempSync(join(tmpdir(), 'agent-us-swebench-out-')))
      : resolve(process.cwd(), 'swebench-results');
  mkdirSync(outputDir, { recursive: true });

  const providerConfig = !opts.dryRun && !runtimeDeps.adapter ? resolveLiveProviderConfig(opts) : null;
  let dryRunRepoDir = null;

  try {
    let instances;
    if (opts.dryRun) {
      const dry = createDryRunRepository();
      dryRunRepoDir = dry.repoDir;
      instances = [dry.instance];
      if (Array.isArray(opts.instanceIds) && opts.instanceIds.length > 0) {
        const wanted = new Set(opts.instanceIds);
        instances = instances.filter((inst) => wanted.has(inst.instance_id));
      }
      if (opts.limit != null && opts.limit > 0) {
        instances = instances.slice(0, opts.limit);
      }
    } else {
      instances = loadSweBenchDataset(opts.dataset, {
        instanceIds: opts.instanceIds,
        limit: opts.limit,
      });
    }

    const predictionsByArm = {};
    const telemetryByArm = {};
    const completedByArm = {};
    const filePathsByArm = {};

    for (const arm of opts.arms) {
      const resumeState = opts.resume
        ? loadCompletedInstanceIds(outputDir, arm)
        : {
            predictionsById: new Map(),
            telemetryById: new Map(),
            completedIds: new Set(),
            predPath: join(outputDir, `predictions.${arm}.jsonl`),
            telePath: join(outputDir, `telemetry.${arm}.jsonl`),
          };

      prepareJsonlFile(resumeState.predPath, opts.resume);
      prepareJsonlFile(resumeState.telePath, opts.resume);

      predictionsByArm[arm] = [...resumeState.predictionsById.values()];
      telemetryByArm[arm] = [...resumeState.telemetryById.values()];
      completedByArm[arm] = resumeState.completedIds;
      filePathsByArm[arm] = { predPath: resumeState.predPath, telePath: resumeState.telePath };
    }

    const summaryPath = join(outputDir, 'summary.md');
    const writeIncrementalSummary = () => {
      const metricsByArm = {};
      for (const arm of opts.arms) {
        metricsByArm[arm] = computeArmAggregateMetrics(
          arm,
          telemetryByArm[arm],
          predictionsByArm[arm],
        );
      }
      const md = renderSummaryMarkdown({
        arms: opts.arms,
        metricsByArm,
        telemetryByArm,
        meta: {
          dryRun: opts.dryRun,
          model: opts.model || providerConfig?.model || (opts.dryRun ? 'swebench-dry-run-sim' : 'default'),
          maxSteps: opts.maxSteps,
          resumed: opts.resume,
          updatedAt: new Date().toISOString(),
        },
      });
      writeFileSync(summaryPath, md, { encoding: 'utf8', mode: 0o600 });
      return metricsByArm;
    };

    const persistResult = (arm, { prediction, telemetry }) => {
      const { predPath, telePath } = filePathsByArm[arm];
      appendJsonlRecord(predPath, prediction);
      appendJsonlRecord(telePath, telemetry);
      predictionsByArm[arm].push(prediction);
      telemetryByArm[arm].push(telemetry);
      writeIncrementalSummary();
    };

    if (opts.dryRun) {
      for (const arm of opts.arms) {
        for (const instance of instances) {
          if (completedByArm[arm].has(instance.instance_id)) continue;
          await resetGitWorktreeToCommit(dryRunRepoDir, instance.base_commit);
          const adapter = runtimeDeps.createAdapter
            ? runtimeDeps.createAdapter({ arm, instance })
            : runtimeDeps.adapter ?? new PrefixBlockCacheSimulatorAdapter();
          const result = await runSweBenchInstanceArm({
            instance,
            arm,
            workspaceRoot: dryRunRepoDir,
            opts,
            adapter,
            providerConfig,
          });
          persistResult(arm, result);
          await resetGitWorktreeToCommit(dryRunRepoDir, instance.base_commit);
        }
      }
    } else {
      const planned = [];
      for (const arm of opts.arms) {
        for (const instance of instances) {
          if (completedByArm[arm].has(instance.instance_id)) continue;
          planned.push({ arm, instance });
        }
      }

      await runWithConcurrency(planned, opts.concurrency, async ({ arm, instance }) => {
        const sourceRepo = resolveSourceWorkspaceForInstance(instance, opts);
        const trialWs = await createIsolatedTrialWorkspace(sourceRepo, instance.base_commit);
        try {
          const adapter = runtimeDeps.createAdapter
            ? runtimeDeps.createAdapter({ arm, instance })
            : runtimeDeps.adapter ?? null;
          const result = await runSweBenchInstanceArm({
            instance,
            arm,
            workspaceRoot: trialWs,
            opts,
            adapter,
            providerConfig,
          });
          persistResult(arm, result);
        } finally {
          rmSync(trialWs, { recursive: true, force: true });
        }
      });
    }

    const metricsByArm = writeIncrementalSummary();

    return {
      benchmarkId: SWEBENCH_BENCHMARK_ID,
      version: SWEBENCH_BENCHMARK_VERSION,
      dryRun: opts.dryRun,
      outputDir,
      temporaryOutputDir: createdTempOutput,
      arms: opts.arms,
      instancesCount: instances.length,
      resumed: opts.resume,
      summaryPath,
      predictionsFiles: Object.fromEntries(opts.arms.map((a) => [a, filePathsByArm[a].predPath])),
      telemetryFiles: Object.fromEntries(opts.arms.map((a) => [a, filePathsByArm[a].telePath])),
      metricsByArm,
      predictionsByArm,
      telemetryByArm,
    };
  } finally {
    if (dryRunRepoDir) {
      rmSync(dryRunRepoDir, { recursive: true, force: true });
    }
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const argvPath = resolve(process.argv[1]);
  const selfPath = resolve(fileURLToPath(import.meta.url));
  return process.platform === 'win32'
    ? argvPath.toLowerCase() === selfPath.toLowerCase()
    : argvPath === selfPath;
})();

if (isMain) {
  const opts = parseSweBenchCliArgs(process.argv.slice(2));
  if (opts.help) {
    printSweBenchUsage();
    process.exit(0);
  }
  const result = await runSweBenchBenchmark(opts);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[${result.benchmarkId} v${result.version}] dryRun=${result.dryRun} instances=${result.instancesCount} outputDir=${result.outputDir}`,
    );
    for (const arm of result.arms) {
      const m = result.metricsByArm[arm];
      console.log(
        `Arm ${arm}: completed=${m.completedInstances}/${m.totalInstances} inTok=${m.totalInputTokens} outTok=${m.totalOutputTokens} cacheHit=${(m.cacheHitRate * 100).toFixed(2)}% steps=${m.totalSteps} ms=${m.totalWallClockMs} patchRate=${(m.nonEmptyPatchRate * 100).toFixed(2)}% admRed=${(m.admissionTokenReductionRate * 100).toFixed(2)}% epochs=${m.epochTransitions}`,
      );
    }
  }
}
