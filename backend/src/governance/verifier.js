import { existsSync } from 'node:fs';
import { posix as posixPath, resolve } from 'node:path';
import { verifyTurn } from '../verifier.js';
import { resolveConfinedPath } from '../tools/sandbox.js';
import { RUNTIME_EVENTS } from '../kernel/events.js';
import {
  classifyMutationPath,
  extractFailureFingerprint,
  extractMutatedFilesFromToolCall,
  isVerificationCommand,
  safeParseToolArgs,
} from '../kernel/execution-reasoning.js';
import { buildPlainTextPassVerdict } from '../kernel/verdict.js';
import { classifyJobOwnership } from '../durable/lease-guard.js';
import { validateEvidenceManifest } from '../evaluation/schemas.js';
import { listWorkspaceChangedFiles } from '../evaluation/fixtures.js';

const PASS_CLAIM_RE =
  /(?:全部|所有|tests?|suites?|checks?|build|lint|typecheck|npm run check).*?(?:pass(?:ed|es)?|通过|成功|0\s*(?:fail(?:ure)?s?|errors?))|(?:验证通过|测试通过|构建成功|编译通过|0\s*(?:failures|errors))/i;

const POST_EDIT_FILE_MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch']);

const GENERIC_TARGET_DIRS = new Set([
  '.',
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'src',
  'lib',
  'pkg',
  'packages',
  'app',
  'apps',
]);

const GENERIC_TARGET_STEMS = new Set([
  'test',
  'tests',
  'spec',
  'specs',
  'index',
  'main',
  '__init__',
  'conftest',
  'setup',
  'mod',
  'lib',
]);

const GENERIC_APP_LABELS = new Set([
  '.',
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'src',
  'lib',
  'pkg',
  'packages',
  'app',
  'apps',
  'django',
  'contrib',
]);

const VALUE_TAKING_TEST_FLAGS = new Set([
  '-k',
  '-m',
  '-c',
  '-o',
  '-n',
  '-w',
  '-p',
  '-t',
  '-s',
  '--tb',
  '--maxfail',
  '--rootdir',
  '--confcutdir',
  '--junitxml',
  '--cov',
  '--cov-report',
  '--durations',
  '--ignore',
  '--deselect',
  '--test-name-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-shard',
  '--test-concurrency',
  '--test-timeout',
  '--testnamepattern',
  '--testpathpattern',
  '--config',
  '--reporter',
  '--env',
  '--package',
  '--test',
  '--bin',
  '--example',
  '--features',
  '--manifest-path',
  '--pattern',
  '--start-directory',
  '--top-level-directory',
  '--project',
  '--outdir',
  '--rootdir',
  '--target',
  '--module',
  '--filter',
  '-run',
]);

const FILTER_TEST_FLAGS = new Set([
  '-k',
  '-t',
  '--test-name-pattern',
  '--testnamepattern',
  '--testpathpattern',
  '--filter',
  '-run',
]);

const TEST_SUBJECT_EXT_RE = /\.(?:[cm]?[jt]sx?|py|go|rs)$/i;

function stripTestAffixes(stem) {
  let s = String(stem ?? '');
  if (!s) return '';
  s = s.replace(/\.(?:test|spec)$/i, '');
  s = s.replace(/^test_+/i, '');
  s = s.replace(/_+test$/i, '');
  return s;
}

function addTargetTokens(targetStr, { targets, dirs, stems, appLabels }) {
  const clean = String(targetStr ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean || clean === '.' || clean === './...') return;
  targets.add(clean);

  const isFileLike = TEST_SUBJECT_EXT_RE.test(clean);
  const parts = clean.split('/').filter(Boolean);
  if (parts.length === 0) return;

  if (isFileLike) {
    if (parts.length > 1) {
      const parentDir = parts.slice(0, -1).join('/');
      if (parentDir && !GENERIC_TARGET_DIRS.has(parentDir)) {
        dirs.add(parentDir);
      }
      // Also record nested sub-dirs under tests/ (e.g. tests/queries/sub -> tests/queries)
      if (parts.length >= 3 && ['test', 'tests', '__tests__', 'spec', 'specs'].includes(parts[0])) {
        dirs.add(`${parts[0]}/${parts[1]}`);
      }
    }
    const base = parts[parts.length - 1];
    const noExt = base.replace(TEST_SUBJECT_EXT_RE, '');
    const subject = stripTestAffixes(noExt);
    if (noExt && !GENERIC_TARGET_STEMS.has(noExt.toLowerCase())) stems.add(noExt);
    if (subject && !GENERIC_TARGET_STEMS.has(subject.toLowerCase())) stems.add(subject);
  } else {
    if (!GENERIC_TARGET_DIRS.has(clean)) {
      dirs.add(clean);
    }
    const last = parts[parts.length - 1];
    const subject = stripTestAffixes(last);
    if (last && !GENERIC_TARGET_STEMS.has(last.toLowerCase())) stems.add(last);
    if (subject && !GENERIC_TARGET_STEMS.has(subject.toLowerCase())) stems.add(subject);
  }

  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    const prev = i > 0 ? parts[i - 1] : null;
    if (i === parts.length - 1 && isFileLike) continue;
    if (['test', 'tests', '__tests__', 'spec', 'specs'].includes(seg)) {
      if (prev && !GENERIC_APP_LABELS.has(prev.toLowerCase())) appLabels.add(prev);
      continue;
    }
    if (!GENERIC_APP_LABELS.has(seg.toLowerCase())) {
      appLabels.add(seg);
    }
  }
}

export function extractVerificationTargets(command, cwd = '.', workspaceRoot = null) {
  const empty = {
    runner: null,
    isBroadSuite: false,
    targets: [],
    dirs: [],
    stems: [],
    appLabels: [],
    filters: [],
  };
  if (typeof command !== 'string' || !command.trim()) return empty;

  const rawTokens = tokenizeShellArgs(command);
  let idx = 0;
  while (idx < rawTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawTokens[idx])) {
    idx += 1;
  }
  const tokens = rawTokens.slice(idx);
  if (!tokens.length) return empty;

  const prog = tokens[0].split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase() ?? '';
  let runner = prog;
  let argStart = 1;

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(prog)) {
    const sub = tokens[1]?.toLowerCase() ?? '';
    argStart = sub === 'run' ? 3 : 2;
    runner = prog;
  } else if (prog === 'npx') {
    const sub = tokens[1]?.toLowerCase() ?? '';
    runner = sub || 'npx';
    argStart = 2;
  } else if (prog === 'node') {
    const sub = tokens[1]?.toLowerCase() ?? '';
    runner = sub === '--check' ? 'node_check' : 'node_test';
    argStart = 2;
  } else if (prog === 'python' || prog === 'python3') {
    if (tokens[1] === '-m' && tokens[2]) {
      runner = tokens[2].toLowerCase();
      argStart = 3;
    }
  } else if (prog === 'cargo' || prog === 'go') {
    runner = prog;
    argStart = 2;
  }

  let cwdPrefix = stripContainerOrWorkspacePrefix(cwd || '.', workspaceRoot)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (
    !cwdPrefix ||
    cwdPrefix === '.' ||
    cwdPrefix === '..' ||
    cwdPrefix.startsWith('../') ||
    cwdPrefix.startsWith('/') ||
    /^[A-Za-z]:/.test(cwdPrefix)
  ) {
    cwdPrefix = '';
  }

  const targets = new Set();
  const dirs = new Set();
  const stems = new Set();
  const appLabels = new Set();
  const filters = new Set();
  let sawDoubleDash = false;
  let sawRootMarker = false;

  const rest = tokens.slice(argStart);
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (!sawDoubleDash) {
      if (tok === '--') {
        sawDoubleDash = true;
        continue;
      }
      if (i === 0 && (runner === 'vitest' || runner === 'jest') && tok === 'run') {
        continue;
      }
      if (tok.startsWith('-')) {
        const eqIdx = tok.indexOf('=');
        const flagName = (eqIdx >= 0 ? tok.slice(0, eqIdx) : tok).toLowerCase();
        const flagVal = eqIdx >= 0 ? tok.slice(eqIdx + 1) : null;

        if (flagVal !== null) {
          if (FILTER_TEST_FLAGS.has(flagName)) filters.add(flagVal);
          if (['--test', '-p', '--package', '--testpathpattern'].includes(flagName)) {
            addTargetTokens(flagVal, { targets, dirs, stems, appLabels });
          }
          continue;
        }
        if (VALUE_TAKING_TEST_FLAGS.has(flagName)) {
          const nextVal = i + 1 < rest.length ? rest[i + 1] : null;
          if (nextVal !== null) {
            if (FILTER_TEST_FLAGS.has(flagName)) filters.add(nextVal);
            if (['--test', '-p', '--package', '--testpathpattern'].includes(flagName)) {
              addTargetTokens(nextVal, { targets, dirs, stems, appLabels });
            }
            i += 1;
          }
          continue;
        }
        continue;
      }
    }

    const beforeNodeId = tok.split('::')[0].trim();
    if (!beforeNodeId) continue;
    if (beforeNodeId === '.' || beforeNodeId === './' || beforeNodeId === './...') {
      if (cwdPrefix) {
        addTargetTokens(cwdPrefix, { targets, dirs, stems, appLabels });
      } else {
        sawRootMarker = true;
      }
      continue;
    }

    // Dotted python module / unittest target (e.g. auth_tests.tests.LoginTest)
    const looksLikeDottedPython =
      !beforeNodeId.includes('/') &&
      !beforeNodeId.includes('\\') &&
      beforeNodeId.includes('.') &&
      !TEST_SUBJECT_EXT_RE.test(beforeNodeId) &&
      !/^\d+(?:\.\d+)*$/.test(beforeNodeId) &&
      !beforeNodeId.startsWith('.');

    if (looksLikeDottedPython) {
      const dottedParts = beforeNodeId.split('.').filter(Boolean);
      const asPath = dottedParts.join('/');
      const joined = cwdPrefix ? posixPath.normalize(`${cwdPrefix}/${asPath}`) : asPath;
      addTargetTokens(joined, { targets, dirs, stems, appLabels });
      if (dottedParts[0] && !GENERIC_APP_LABELS.has(dottedParts[0].toLowerCase())) {
        appLabels.add(dottedParts[0]);
      }
      continue;
    }

    const stripped = stripContainerOrWorkspacePrefix(beforeNodeId, workspaceRoot);
    let norm = stripped.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    const hadPrefix = stripped !== beforeNodeId;
    if (
      cwdPrefix &&
      !hadPrefix &&
      !beforeNodeId.startsWith('/') &&
      !/^[A-Za-z]:/.test(beforeNodeId)
    ) {
      norm = posixPath.normalize(`${cwdPrefix}/${norm}`);
    } else {
      norm = posixPath.normalize(norm);
    }
    if (norm === '.' || norm === './...') {
      sawRootMarker = true;
      continue;
    }
    if (norm === '..' || norm.startsWith('../')) continue;
    norm = norm.replace(/^\.\//, '').replace(/\/...$/, '');
    addTargetTokens(norm, { targets, dirs, stems, appLabels });
  }

  const isBroadSuite =
    (targets.size === 0 && filters.size === 0) ||
    (sawRootMarker && targets.size === 0 && filters.size === 0);

  return {
    runner,
    isBroadSuite,
    targets: [...targets],
    dirs: [...dirs],
    stems: [...stems],
    appLabels: [...appLabels],
    filters: [...filters],
  };
}

function extractMutatedTargetSignals(allMutatedFiles, workspaceRoot = null) {
  const stems = new Set();
  const packages = new Set();
  for (const rawFile of allMutatedFiles ?? []) {
    const stripped = stripContainerOrWorkspacePrefix(rawFile, workspaceRoot)
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
    if (!stripped) continue;
    const parts = stripped.split('/').filter(Boolean);
    const base = parts[parts.length - 1] ?? '';
    const noExt = base.replace(TEST_SUBJECT_EXT_RE, '');
    const subject = stripTestAffixes(noExt);
    if (noExt && !GENERIC_TARGET_STEMS.has(noExt.toLowerCase())) stems.add(noExt);
    if (subject && !GENERIC_TARGET_STEMS.has(subject.toLowerCase())) stems.add(subject);
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i];
      if (seg && !GENERIC_APP_LABELS.has(seg.toLowerCase())) {
        packages.add(seg);
      }
    }
  }
  return { stems, packages };
}

const CLI_OR_PATH_ERROR_RE =
  /command not found|no such file or directory|unrecognized arguments|invalid choice|error:\s*argument|超出当前工作区边界|chdir to cwd|Blocked unauthorized/i;

const OFFLINE_NETWORK_ERROR_RE =
  /HTTPSConnectionPool|HTTPConnectionPool|NewConnectionError|MaxRetryError|Temporary failure in name resolution|Network is unreachable|Name or service not known|URLError:\s*<urlopen error|socket\.gaierror/i;

const SYNTAX_OR_LINT_ONLY_RUNNERS = new Set(['node_check', 'tsc', 'eslint']);
const TEST_EXECUTION_RUNNERS = new Set([
  'pytest',
  'unittest',
  'node_test',
  'vitest',
  'jest',
  'cargo',
  'go',
]);

function setsOverlap(a, b) {
  if (!a?.length || !b?.length) return false;
  const bSet = new Set(b);
  return a.some((item) => bSet.has(item));
}

export function isFailedVerificationSuperseded(
  failRun,
  passRun,
  { lastCodeMutationIndex = -1, allMutatedFiles = [], workspaceRoot = null } = {},
) {
  if (!failRun || !passRun) return false;
  if (typeof failRun.index === 'number' && typeof passRun.index === 'number') {
    if (failRun.index >= passRun.index) return false;
  } else {
    return false;
  }
  if (lastCodeMutationIndex >= 0 && passRun.index <= lastCodeMutationIndex) {
    return false;
  }

  // a) Pre-edit reproduction superseded by post-edit passing verification
  if (
    lastCodeMutationIndex >= 0 &&
    failRun.index < lastCodeMutationIndex &&
    passRun.index > lastCodeMutationIndex
  ) {
    return true;
  }

  // b) CLI / path / syntax invocation error
  const failOut = String(failRun.output ?? '');
  if (
    (typeof failRun.exitCode === 'number' && [2, 4, 126, 127].includes(failRun.exitCode)) ||
    CLI_OR_PATH_ERROR_RE.test(failOut)
  ) {
    return true;
  }

  // c) Offline container network failure
  if (OFFLINE_NETWORK_ERROR_RE.test(failOut)) {
    return true;
  }

  // d) Target overlap (broad suite, shared path/stem/dir/appLabel, or mutated package/stem)
  const failTargets = extractVerificationTargets(
    failRun.command,
    failRun.cwd ?? '.',
    workspaceRoot,
  );
  const passTargets = extractVerificationTargets(
    passRun.command,
    passRun.cwd ?? '.',
    workspaceRoot,
  );

  // A syntax-only/lint-only command (e.g. `node --check`) must not supersede a failing test suite.
  if (
    SYNTAX_OR_LINT_ONLY_RUNNERS.has(passTargets.runner) &&
    TEST_EXECUTION_RUNNERS.has(failTargets.runner)
  ) {
    return false;
  }

  if (passTargets.isBroadSuite) return true;
  if (setsOverlap(passTargets.targets, failTargets.targets)) return true;
  for (const pTarget of passTargets.targets) {
    for (const fTarget of failTargets.targets) {
      if (fTarget.startsWith(`${pTarget}/`)) return true;
    }
  }
  if (setsOverlap(passTargets.dirs, failTargets.dirs)) return true;
  if (setsOverlap(passTargets.stems, failTargets.stems)) return true;
  if (setsOverlap(passTargets.appLabels, failTargets.appLabels)) return true;

  const mutatedSignals = extractMutatedTargetSignals(allMutatedFiles, workspaceRoot);
  if (
    passTargets.stems.some((s) => mutatedSignals.stems.has(s)) ||
    passTargets.appLabels.some((a) => mutatedSignals.packages.has(a))
  ) {
    return true;
  }

  return false;
}

function findUnresolvedVerification(
  receipts,
  events,
  workspaceRoot,
  callsById = new Map(),
  supersession = null,
) {
  const resultsByKey = new Map();
  const outputByKey = new Map();
  for (const ev of events) {
    const { receipt, effectiveArgs, callId, content } = ev.data ?? {};
    if (ev.type === 'tool/result') {
      if (effectiveArgs) {
        if (receipt?.id) resultsByKey.set(`id:${receipt.id}`, effectiveArgs);
        const cid = receipt?.callId ?? callId;
        if (cid) resultsByKey.set(`call:${cid}`, effectiveArgs);
      }
      if (typeof content === 'string' && content) {
        if (receipt?.id) outputByKey.set(`id:${receipt.id}`, content);
        const cid = receipt?.callId ?? callId;
        if (cid) outputByKey.set(`call:${cid}`, content);
      }
    }
  }
  const latestByCommand = new Map();
  for (let idx = 0; idx < receipts.length; idx += 1) {
    const receipt = receipts[idx];
    if (receipt.toolName !== 'bash') continue;
    const args =
      (receipt.id ? resultsByKey.get(`id:${receipt.id}`) : null) ??
      (receipt.callId ? resultsByKey.get(`call:${receipt.callId}`) : null) ??
      (receipt.callId ? callsById.get(receipt.callId)?.args : null) ??
      receipt.args ??
      null;
    if (!isVerificationCommand(args?.command)) continue;
    let cwd = args.cwd || '.';
    if (workspaceRoot) {
      try { cwd = resolveWorkspacePath(workspaceRoot, cwd).rel; } catch { /* keep raw cwd */ }
    }
    const command = args.command.trim();
    const output =
      receipt.output ??
      (receipt.id ? outputByKey.get(`id:${receipt.id}`) : null) ??
      (receipt.callId ? outputByKey.get(`call:${receipt.callId}`) : null) ??
      '';
    const key = JSON.stringify([receipt.sessionId ?? null, cwd, command]);
    // Rejections are unsuccessful attempts; they must not turn a failing check green.
    latestByCommand.set(key, {
      receipt,
      command,
      cwd,
      index: typeof receipt.orderedIndex === 'number' ? receipt.orderedIndex : idx,
      exitCode: receipt.exitCode,
      status: receipt.status,
      output,
      callId: receipt.callId ?? null,
    });
  }

  const passRun = supersession?.lastPassingVerification ?? null;
  const canSupersede = Boolean(
    passRun &&
      !supersession?.staleAfterEdit &&
      ((supersession?.lastCodeMutationIndex ?? -1) < 0 ||
        passRun.index > supersession.lastCodeMutationIndex),
  );
  if (canSupersede) {
    for (const [key, entry] of [...latestByCommand.entries()]) {
      const isFailed = entry.receipt.status !== 'finished' || entry.receipt.exitCode !== 0;
      if (!isFailed) continue;
      if (
        entry.index < passRun.index &&
        isFailedVerificationSuperseded(entry, passRun, {
          lastCodeMutationIndex: supersession.lastCodeMutationIndex ?? -1,
          allMutatedFiles: supersession.allMutatedFiles ?? [],
          workspaceRoot,
        })
      ) {
        latestByCommand.delete(key);
      }
    }
  }

  const failed = [...latestByCommand.values()].findLast(
    ({ receipt }) => receipt.status !== 'finished' || receipt.exitCode !== 0,
  );
  return failed ?? null;
}

const CONTAINER_MOUNT_PREFIXES = ['/testbed', '/work'];

function stripContainerOrWorkspacePrefix(rawPath, workspaceRoot = null) {
  const input = String(rawPath ?? '').trim();
  if (!input) return '';
  const posixInput = input.replace(/\\/g, '/');
  const rootPosix = workspaceRoot
    ? resolve(String(workspaceRoot)).replace(/\\/g, '/').replace(/\/+$/, '')
    : '';

  if (rootPosix) {
    const isWinRoot = /^[A-Za-z]:/.test(rootPosix);
    const cmpInput = isWinRoot ? posixInput.toLowerCase() : posixInput;
    const cmpRoot = isWinRoot ? rootPosix.toLowerCase() : rootPosix;
    if (cmpInput === cmpRoot) return '.';
    if (cmpInput.startsWith(`${cmpRoot}/`)) {
      return posixInput.slice(rootPosix.length + 1).replace(/^\.\//, '') || '.';
    }
  }

  // Normalize POSIX dot segments before matching container prefixes so `/testbed/../outside` never strips `/testbed/`.
  const normPosix = posixPath.normalize(posixInput);
  if (!CONTAINER_MOUNT_PREFIXES.includes(rootPosix)) {
    for (const prefix of CONTAINER_MOUNT_PREFIXES) {
      if (normPosix === prefix) return '.';
      if (normPosix.startsWith(`${prefix}/`)) {
        return normPosix.slice(prefix.length + 1) || '.';
      }
    }
  }

  return input;
}

function resolveWorkspacePath(workspaceRoot, rawPath) {
  const input = String(rawPath ?? '').trim();
  if (!input) throw new Error('路径不能为空');
  try {
    return resolveConfinedPath(workspaceRoot, input);
  } catch (err) {
    const stripped = stripContainerOrWorkspacePrefix(input, workspaceRoot);
    if (stripped !== input) {
      return resolveConfinedPath(workspaceRoot, stripped);
    }
    throw err;
  }
}

const SEGMENT_WRAPPER_PREFIX_RE =
  /^\s*(?:sudo\s+|cmd(?:\.exe)?\s+\/[cq]\s+|powershell(?:\.exe)?\s+(?:-\w+\s+)*)?/i;

const DELETE_SEGMENT_RE =
  /^\s*(?:sudo\s+|cmd(?:\.exe)?\s+\/[cq]\s+|powershell(?:\.exe)?\s+(?:-\w+\s+)*)?(?:rm|rmdir|rd|unlink|del|erase|remove-item|ri|git\s+(?:rm|(?:-C\s+\S+\s+)?clean))\b/i;

const PROGRAMMATIC_DELETE_RE =
  /\b(?:fs\.(?:promises\.)?)?(?:unlink|rm)(?:Sync)?\s*\(|\bos\.(?:remove|unlink|rmdir)\s*\(|\b(?:pathlib\.)?Path\s*\(.*?\)\s*\.unlink\s*\(|\bshutil\.rmtree\s*\(/;

const RECURSIVE_DELETE_RE =
  /\bshutil\.rmtree\s*\(|\bfs\.(?:promises\.)?rm(?:Sync)?\s*\([^)]*recursive\s*:\s*true|^\s*(?:sudo\s+|cmd(?:\.exe)?\s+\/[cq]\s+)?rm\s+.*(?:^|\s)(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)|^\s*(?:powershell(?:\.exe)?\s+(?:-\w+\s+)*)?(?:remove-item|ri)\b.*-recurse\b|^\s*(?:cmd(?:\.exe)?\s+\/[cq]\s+)?(?:rmdir|rd)\b.*\s\/s\b/i;

function safeToolArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object') return rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function tokenizeShellArgs(text) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let hasToken = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
        cur += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(cur);
        cur = '';
        hasToken = false;
      }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(cur);
  return tokens;
}

function splitShellSegments(command) {
  const segments = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        cur += ch + command[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      segments.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      segments.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '\r' || ch === '|' || ch === '{' || ch === '}') {
      segments.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) segments.push(cur);
  return segments;
}

function normalizeWorkspaceRelativeCandidate(
  rawPath,
  { workspaceRoot = null, activeCwd = '.', activeCwdInvalid = false } = {},
) {
  const rawTrimmed = String(rawPath ?? '').trim();
  if (!rawTrimmed) return null;
  const stripped = stripContainerOrWorkspacePrefix(rawTrimmed, workspaceRoot);
  const hadPrefix = stripped !== rawTrimmed;
  const posix = stripped.replace(/\\/g, '/');

  if (!hadPrefix) {
    if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) return null;
    if (activeCwdInvalid) return null;
    const base = activeCwd && activeCwd !== '.' ? activeCwd : '';
    const joined = base ? `${base}/${posix}` : posix;
    const norm = posixPath.normalize(joined).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!norm) return '.';
    if (norm === '..' || norm.startsWith('../') || norm.startsWith('/')) return null;
    if (norm.split('/').includes('..')) return null;
    return norm;
  }

  const norm = posixPath.normalize(posix).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!norm) return '.';
  if (norm === '..' || norm.startsWith('../') || norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) {
    return null;
  }
  if (norm.split('/').includes('..')) return null;
  return norm;
}

function globPatternToRegExp(globPosix) {
  let reStr = '^';
  for (let i = 0; i < globPosix.length; i += 1) {
    const ch = globPosix[i];
    if (ch === '*') {
      if (globPosix[i + 1] === '*') {
        reStr += '.*';
        i += 1;
      } else {
        reStr += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      reStr += '[^/]';
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(ch)) {
      reStr += `\\${ch}`;
    } else {
      reStr += ch;
    }
  }
  reStr += '$';
  return new RegExp(reStr);
}

function tokenizeUnwrappedSegment(trimmed) {
  let unwrapped = trimmed.replace(SEGMENT_WRAPPER_PREFIX_RE, '').trim();
  if (
    unwrapped.length >= 2 &&
    ((unwrapped.startsWith('"') && unwrapped.endsWith('"')) ||
      (unwrapped.startsWith("'") && unwrapped.endsWith("'")))
  ) {
    const inner = unwrapped.slice(1, -1).trim();
    if (inner) unwrapped = inner;
  }
  return tokenizeShellArgs(unwrapped);
}

function parseCdSegment(trimmed, { workspaceRoot = null, activeCwd = '.', activeCwdInvalid = false } = {}) {
  const tokens = tokenizeUnwrappedSegment(trimmed);
  if (!tokens.length) return null;
  const bin = tokens[0].split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase();
  if (bin !== 'cd') return null;

  let dirArg = null;
  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === '--') {
      dirArg = tokens[i + 1] ?? null;
      break;
    }
    if (tok.startsWith('-') && tok.length > 1) continue;
    dirArg = tok;
    break;
  }

  if (!dirArg) {
    return { activeCwd: '.', activeCwdInvalid: true };
  }
  const resolved = normalizeWorkspaceRelativeCandidate(dirArg, {
    workspaceRoot,
    activeCwd,
    activeCwdInvalid,
  });
  if (!resolved) {
    return { activeCwd: '.', activeCwdInvalid: true };
  }
  return { activeCwd: resolved, activeCwdInvalid: false };
}

function consumeGitGlobalFlags(tokens) {
  let i = 1;
  let chdir = null;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const tok = tokens[i];
    if (tok === '-C' && i + 1 < tokens.length) {
      chdir = tokens[i + 1];
      i += 2;
      continue;
    }
    if (tok.startsWith('-C') && tok.length > 2) {
      chdir = tok.slice(2);
      i += 1;
      continue;
    }
    if (
      ['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'].includes(
        tok,
      ) &&
      i + 1 < tokens.length
    ) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return { subIdx: i, chdir };
}

function parseGitCleanSegment(trimmed) {
  const tokens = tokenizeUnwrappedSegment(trimmed);
  if (!tokens.length) return { isGitClean: false };
  const bin = tokens[0].split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase();
  if (bin !== 'git') return { isGitClean: false };

  const { subIdx: i, chdir } = consumeGitGlobalFlags(tokens);
  if (tokens[i]?.toLowerCase() !== 'clean') return { isGitClean: false };

  let hasForce = false;
  let hasDryRun = false;
  let afterDoubleDash = false;
  const pathspecs = [];
  for (let j = i + 1; j < tokens.length; j += 1) {
    const tok = tokens[j];
    if (!afterDoubleDash) {
      if (tok === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (tok === '--force') {
        hasForce = true;
        continue;
      }
      if (tok === '--dry-run') {
        hasDryRun = true;
        continue;
      }
      if ((tok === '-e' || tok === '--exclude') && j + 1 < tokens.length) {
        j += 1;
        continue;
      }
      if (tok.startsWith('--exclude=')) continue;
      if (tok.startsWith('--')) continue;
      if (tok.startsWith('-') && tok.length > 1) {
        const flags = tok.slice(1);
        if (flags.includes('f')) hasForce = true;
        if (flags.includes('n')) hasDryRun = true;
        continue;
      }
    }
    pathspecs.push(tok);
  }

  return { isGitClean: true, hasForce, hasDryRun, chdir, pathspecs };
}

function matchesGitCleanSegment(
  parsed,
  rel,
  workspaceRoot = null,
  { activeCwd = '.', activeCwdInvalid = false } = {},
) {
  if (!parsed.hasForce || parsed.hasDryRun) return false;
  const relPosix = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!relPosix) return false;

  let baseDir = activeCwd || '.';
  let baseInvalid = activeCwdInvalid;
  if (parsed.chdir) {
    const resolvedChdir = normalizeWorkspaceRelativeCandidate(parsed.chdir, {
      workspaceRoot,
      activeCwd,
      activeCwdInvalid,
    });
    if (!resolvedChdir) return false;
    baseDir = resolvedChdir;
    baseInvalid = false;
  }

  if (parsed.pathspecs.length === 0) {
    if (baseInvalid) return false;
    return baseDir === '.' || relPosix === baseDir || relPosix.startsWith(`${baseDir}/`);
  }

  return matchesDeleteOperands(parsed.pathspecs, relPosix, {
    workspaceRoot,
    activeCwd: baseDir,
    activeCwdInvalid: baseInvalid,
    allowAncestorDir: true,
    allowDot: true,
    allowDirPrefix: true,
  });
}

function parseShellDeleteSegment(trimmed) {
  const tokens = tokenizeUnwrappedSegment(trimmed);
  if (!tokens.length) return { isShellDelete: false };
  const bin = tokens[0].split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase();

  if (bin === 'git') {
    const { subIdx, chdir } = consumeGitGlobalFlags(tokens);
    if (tokens[subIdx]?.toLowerCase() !== 'rm') return { isShellDelete: false };
    let hasDryRun = false;
    let hasCached = false;
    let recursive = false;
    let afterDoubleDash = false;
    const operands = [];
    for (let j = subIdx + 1; j < tokens.length; j += 1) {
      const tok = tokens[j];
      if (!afterDoubleDash) {
        if (tok === '--') {
          afterDoubleDash = true;
          continue;
        }
        if (tok === '--dry-run') {
          hasDryRun = true;
          continue;
        }
        if (tok === '--cached') {
          hasCached = true;
          continue;
        }
        if (tok === '--recursive') {
          recursive = true;
          continue;
        }
        if (tok.startsWith('--')) continue;
        if (tok.startsWith('-') && tok.length > 1) {
          const flags = tok.slice(1);
          if (flags.includes('n')) hasDryRun = true;
          if (flags.includes('r') || flags.includes('R')) recursive = true;
          continue;
        }
      }
      operands.push(tok);
    }
    return {
      isShellDelete: true,
      skip: hasDryRun || hasCached,
      chdir,
      operands,
      allowAncestorDir: recursive,
    };
  }

  const shellDeleteBins = new Set([
    'rm',
    'unlink',
    'del',
    'erase',
    'remove-item',
    'ri',
    'rmdir',
    'rd',
  ]);
  if (!shellDeleteBins.has(bin)) return { isShellDelete: false };

  let recursive = RECURSIVE_DELETE_RE.test(trimmed);
  let hasDryRun = false;
  let afterDoubleDash = false;
  const operands = [];
  const isWinCmd = bin === 'del' || bin === 'erase' || bin === 'rmdir' || bin === 'rd';
  const isPs = bin === 'remove-item' || bin === 'ri';

  for (let j = 1; j < tokens.length; j += 1) {
    const tok = tokens[j];
    if (!afterDoubleDash) {
      if (tok === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (isWinCmd && /^\/[a-zA-Z](?::\S+)?$/.test(tok)) {
        if (tok.toLowerCase() === '/s') recursive = true;
        continue;
      }
      if (isPs && tok.startsWith('-')) {
        const lower = tok.toLowerCase();
        if (lower === '-whatif') {
          hasDryRun = true;
          continue;
        }
        if (lower === '-recurse' || lower === '-r') {
          recursive = true;
          continue;
        }
        if ((lower === '-path' || lower === '-literalpath') && j + 1 < tokens.length) {
          operands.push(tokens[j + 1]);
          j += 1;
          continue;
        }
        if (
          ['-filter', '-include', '-exclude', '-erroraction', '-ea', '-warningaction', '-confirm'].includes(
            lower,
          ) &&
          j + 1 < tokens.length
        ) {
          j += 1;
          continue;
        }
        continue;
      }
      if (!isWinCmd && !isPs && tok.startsWith('-') && tok.length > 1) {
        if (tok === '--recursive' || (!tok.startsWith('--') && /[rR]/.test(tok.slice(1)))) {
          recursive = true;
        }
        continue;
      }
    }
    operands.push(tok);
  }

  return {
    isShellDelete: true,
    skip: hasDryRun,
    chdir: null,
    operands,
    allowAncestorDir: recursive,
  };
}

function parseGitRevertSegment(trimmed) {
  const tokens = tokenizeUnwrappedSegment(trimmed);
  if (!tokens.length) return { isGitRevert: false };
  const bin = tokens[0].split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase();
  if (bin !== 'git') return { isGitRevert: false };

  const { subIdx, chdir } = consumeGitGlobalFlags(tokens);
  const sub = tokens[subIdx]?.toLowerCase();

  if (sub === 'checkout') {
    let sawDoubleDash = false;
    let invalidBranchSwitch = false;
    const preDashArgs = [];
    const postDashArgs = [];

    for (let j = subIdx + 1; j < tokens.length; j += 1) {
      const tok = tokens[j];
      if (sawDoubleDash) {
        postDashArgs.push(tok);
        continue;
      }
      if (tok === '--') {
        sawDoubleDash = true;
        continue;
      }
      if (tok === '-b' || tok === '-B' || tok === '--orphan') {
        invalidBranchSwitch = true;
        break;
      }
      if ((tok === '--conflict' || tok === '--pathspec-from-file') && j + 1 < tokens.length) {
        j += 1;
        continue;
      }
      if (tok.startsWith('--')) continue;
      if (tok.startsWith('-') && tok.length > 1) {
        if (/[bB]/.test(tok.slice(1))) {
          invalidBranchSwitch = true;
          break;
        }
        continue;
      }
      preDashArgs.push(tok);
    }

    if (invalidBranchSwitch) return { isGitRevert: false };
    let pathspecs = [];
    if (sawDoubleDash) {
      pathspecs = postDashArgs;
    } else if (preDashArgs.length === 1 || preDashArgs.length === 2) {
      const candidate = preDashArgs[preDashArgs.length - 1];
      const isUnambiguous =
        candidate === '.' ||
        candidate.includes('/') ||
        candidate.includes('\\') ||
        candidate.startsWith('./') ||
        /\.[A-Za-z][A-Za-z0-9]*$/.test(candidate) ||
        candidate.includes('*') ||
        candidate.includes('?');
      if (isUnambiguous) pathspecs = [candidate];
    }

    return {
      isGitRevert: pathspecs.length > 0,
      chdir,
      pathspecs,
      allowDot: true,
      allowDirPrefix: true,
    };
  }

  if (sub === 'restore') {
    let sawDoubleDash = false;
    let hasStaged = false;
    let hasWorktree = false;
    let hasDryRun = false;
    const pathspecs = [];

    for (let j = subIdx + 1; j < tokens.length; j += 1) {
      const tok = tokens[j];
      if (sawDoubleDash) {
        pathspecs.push(tok);
        continue;
      }
      if (tok === '--') {
        sawDoubleDash = true;
        continue;
      }
      if (tok === '--staged') {
        hasStaged = true;
        continue;
      }
      if (tok === '--worktree') {
        hasWorktree = true;
        continue;
      }
      if (tok === '--dry-run' || tok === '-n') {
        hasDryRun = true;
        continue;
      }
      if (
        ['-s', '--source', '--conflict', '--pathspec-from-file'].includes(tok) &&
        j + 1 < tokens.length
      ) {
        j += 1;
        continue;
      }
      if (
        tok.startsWith('--source=') ||
        tok.startsWith('--conflict=') ||
        tok.startsWith('--pathspec-from-file=')
      ) {
        continue;
      }
      if (tok.startsWith('--')) continue;
      if (tok.startsWith('-') && tok.length > 1) {
        const flags = tok.slice(1);
        if (flags.includes('S')) hasStaged = true;
        if (flags.includes('W')) hasWorktree = true;
        continue;
      }
      pathspecs.push(tok);
    }

    if (hasDryRun || (hasStaged && !hasWorktree) || pathspecs.length === 0) {
      return { isGitRevert: false };
    }

    return {
      isGitRevert: true,
      chdir,
      pathspecs,
      allowDot: true,
      allowDirPrefix: true,
    };
  }

  return { isGitRevert: false };
}

function matchesDeleteOperands(
  operands,
  rel,
  {
    workspaceRoot = null,
    activeCwd = '.',
    activeCwdInvalid = false,
    allowAncestorDir = false,
    allowDot = false,
    allowDirPrefix = false,
  } = {},
) {
  const relPosix = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!relPosix) return false;
  const relParts = relPosix.split('/');

  for (const rawOp of operands) {
    const spec = normalizeWorkspaceRelativeCandidate(rawOp, {
      workspaceRoot,
      activeCwd,
      activeCwdInvalid,
    });
    if (!spec) continue;

    if (spec === '.') {
      if (allowDot || allowAncestorDir) return true;
      continue;
    }

    const hasGlob = spec.includes('*') || spec.includes('?');
    if (!hasGlob) {
      if (relPosix === spec) return true;
      if ((allowAncestorDir || allowDirPrefix) && relPosix.startsWith(`${spec}/`)) {
        return true;
      }
      continue;
    }

    const globRe = globPatternToRegExp(spec);
    if (globRe.test(relPosix)) return true;
    if (allowAncestorDir || allowDirPrefix) {
      for (let len = 1; len < relParts.length; len += 1) {
        const ancestor = relParts.slice(0, len).join('/');
        if (globRe.test(ancestor)) return true;
      }
    }
  }
  return false;
}

function buildTargetPathVariants(targetPosix, workspaceRoot = null) {
  const win = targetPosix.replace(/\//g, '\\');
  const variants = [
    targetPosix,
    win,
    `/testbed/${targetPosix}`,
    `/work/${targetPosix}`,
  ];
  if (workspaceRoot) {
    const rawRootPosix = String(workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    const resolvedRootPosix = resolve(String(workspaceRoot)).replace(/\\/g, '/').replace(/\/+$/, '');
    const resolvedRootWin = resolve(String(workspaceRoot)).replace(/\//g, '\\').replace(/\\+$/, '');
    if (rawRootPosix) variants.push(`${rawRootPosix}/${targetPosix}`);
    if (resolvedRootPosix) variants.push(`${resolvedRootPosix}/${targetPosix}`);
    if (resolvedRootWin) variants.push(`${resolvedRootWin}\\${win}`);
  }
  return [...new Set(variants)];
}

function commandMentionsExactTarget(text, targetPosix, { workspaceRoot = null } = {}) {
  const variants = buildTargetPathVariants(targetPosix, workspaceRoot);
  const prefix = '(?:^|[\\s"\'`=(,;]|\\.[\\\\/])';
  const suffix = '(?=$|[\\s"\'`),;])';
  for (const candidate of variants) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = /^[A-Za-z]:/.test(candidate) ? 'i' : '';
    const re = new RegExp(`${prefix}${escaped}${suffix}`, flags);
    if (re.test(text)) return true;
  }
  return false;
}

function commandMentionsPath(
  text,
  rel,
  { workspaceRoot = null, allowAncestorDir = false, activeCwd = '.', activeCwdInvalid = false } = {},
) {
  const posix = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!posix) return false;
  if (commandMentionsExactTarget(text, posix, { workspaceRoot })) return true;

  if (!activeCwdInvalid && activeCwd && activeCwd !== '.' && posix.startsWith(`${activeCwd}/`)) {
    const cwdRel = posix.slice(activeCwd.length + 1);
    if (commandMentionsExactTarget(text, cwdRel, { workspaceRoot })) return true;
  }

  const prefix = '(?:^|[\\s"\'`=(,;]|\\.[\\\\/])';
  const suffix = '(?=$|[\\s"\'`),;])';
  const slashIdx = posix.lastIndexOf('/');
  if (slashIdx > 0) {
    const dir = posix.slice(0, slashIdx);
    const base = posix.slice(slashIdx + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dirMentioned = text.includes(dir) || text.includes(dir.replace(/\//g, '\\'));
    const baseRe = new RegExp(`${prefix}${base}${suffix}`);
    if (dirMentioned && baseRe.test(text)) return true;

    if (allowAncestorDir) {
      const parts = posix.split('/');
      for (let len = parts.length - 1; len >= 1; len -= 1) {
        const ancestor = parts.slice(0, len).join('/');
        if (commandMentionsExactTarget(text, ancestor, { workspaceRoot })) return true;
      }
    }
  }
  return false;
}

export function isExplicitFileDeleteCommand(
  command,
  rel,
  { workspaceRoot = null, cwd = null } = {},
) {
  if (typeof command !== 'string' || !command.trim()) return false;

  let activeCwd = '.';
  let activeCwdInvalid = false;
  if (cwd) {
    const normalizedCwd = normalizeWorkspaceRelativeCandidate(cwd, {
      workspaceRoot,
      activeCwd: '.',
      activeCwdInvalid: false,
    });
    if (!normalizedCwd) {
      activeCwdInvalid = true;
    } else {
      activeCwd = normalizedCwd;
    }
  }

  const segments = splitShellSegments(command);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;

    const cdUpdate = parseCdSegment(trimmed, { workspaceRoot, activeCwd, activeCwdInvalid });
    if (cdUpdate) {
      activeCwd = cdUpdate.activeCwd;
      activeCwdInvalid = cdUpdate.activeCwdInvalid;
      continue;
    }

    const gitClean = parseGitCleanSegment(trimmed);
    if (gitClean.isGitClean) {
      if (
        matchesGitCleanSegment(gitClean, rel, workspaceRoot, {
          activeCwd,
          activeCwdInvalid,
        })
      ) {
        return true;
      }
      continue;
    }

    const gitRevert = parseGitRevertSegment(trimmed);
    if (gitRevert.isGitRevert) {
      let baseDir = activeCwd;
      let baseInvalid = activeCwdInvalid;
      if (gitRevert.chdir) {
        const resolvedChdir = normalizeWorkspaceRelativeCandidate(gitRevert.chdir, {
          workspaceRoot,
          activeCwd,
          activeCwdInvalid,
        });
        if (!resolvedChdir) continue;
        baseDir = resolvedChdir;
        baseInvalid = false;
      }
      if (
        matchesDeleteOperands(gitRevert.pathspecs, rel, {
          workspaceRoot,
          activeCwd: baseDir,
          activeCwdInvalid: baseInvalid,
          allowDot: gitRevert.allowDot,
          allowDirPrefix: gitRevert.allowDirPrefix,
        })
      ) {
        return true;
      }
      continue;
    }

    const shellDel = parseShellDeleteSegment(trimmed);
    if (shellDel.isShellDelete) {
      if (shellDel.skip) continue;
      let baseDir = activeCwd;
      let baseInvalid = activeCwdInvalid;
      if (shellDel.chdir) {
        const resolvedChdir = normalizeWorkspaceRelativeCandidate(shellDel.chdir, {
          workspaceRoot,
          activeCwd,
          activeCwdInvalid,
        });
        if (!resolvedChdir) continue;
        baseDir = resolvedChdir;
        baseInvalid = false;
      }
      if (
        matchesDeleteOperands(shellDel.operands, rel, {
          workspaceRoot,
          activeCwd: baseDir,
          activeCwdInvalid: baseInvalid,
          allowAncestorDir: shellDel.allowAncestorDir,
        })
      ) {
        return true;
      }
      continue;
    }

    if (PROGRAMMATIC_DELETE_RE.test(trimmed)) {
      const allowAncestorDir = RECURSIVE_DELETE_RE.test(trimmed);
      if (
        commandMentionsPath(trimmed, rel, {
          workspaceRoot,
          allowAncestorDir,
          activeCwd,
          activeCwdInvalid,
        })
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Layer 3/6 EvidenceVerifier & CompletionGate:
 * Prevents hallucinated completion claims by checking durable `tool_receipts`,
 * pending `outcome_unknown` reconciliations, and workspace disk existence.
 */
export class EvidenceVerifier {
  constructor({ store = null, eventRouter = null } = {}) {
    this.store = store;
    this.eventRouter = eventRouter;
  }

  verify({
    events = [],
    text = '',
    node = null,
    execution = null,
    sessionId = null,
    turnId = null,
    sessionIds = null,
    turnIds = null,
    workspaceRoot = null,
    reasoningState = null,
  } = {}) {
    const reasons = [];
    const checks = {
      pendingReconciliations: 0,
      failedShellReceipts: 0,
      missingDiskFiles: [],
    };

    const allSessionIds = [
      ...new Set(
        [sessionId, ...(Array.isArray(sessionIds) ? sessionIds : [])].filter(Boolean),
      ),
    ];
    const allTurnIds = [
      ...new Set(
        [turnId, ...(Array.isArray(turnIds) ? turnIds : [])].filter(Boolean),
      ),
    ];

    let turnReceipts = [];
    if (this.store?.db?.isOpen && allSessionIds.length > 0) {
      const sPh = allSessionIds.map(() => '?').join(',');
      const pendingUnknown = this.store.db
        .prepare(
          `SELECT id, toolName FROM tool_receipts WHERE sessionId IN (${sPh}) AND status='outcome_unknown'`,
        )
        .all(...allSessionIds);
      const pendingAppr = this.store.db
        .prepare(
          `SELECT id, tool FROM direct_approvals WHERE sessionId IN (${sPh}) AND kind='reconciliation' AND status='pending'`,
        )
        .all(...allSessionIds);

      // Also detect stranded/orphaned 'executing' non-replayable/outward receipts (P0-2)
      const executingNonReplay = this.store.db
        .prepare(
          `SELECT id, toolName, turnId, sessionId FROM tool_receipts
           WHERE sessionId IN (${sPh}) AND status='executing' AND (replayable = 0 OR outward = 1)`,
        )
        .all(...allSessionIds);
      const verifiedTurnSet = new Set(allTurnIds);
      const strandedExecuting = [];
      const now = Date.now();
      for (const r of executingNonReplay) {
        // Inside the turn(s) currently at idle/final verification, no tool can legitimately still be executing
        if (r.turnId && verifiedTurnSet.has(r.turnId)) {
          strandedExecuting.push(r);
          continue;
        }
        // For receipts from other turns in the same session, check whether a live owner still holds the job
        let liveOwned = false;
        if (r.turnId) {
          const activeJobs = this.store.db
            .prepare("SELECT * FROM runtime_jobs WHERE turnId=? AND status='active'")
            .all(r.turnId);
          liveOwned = activeJobs.some((j) => classifyJobOwnership(this.store, j, { now }).liveOwner);
        }
        if (!liveOwned) {
          strandedExecuting.push(r);
        }
      }

      checks.pendingReconciliations =
        pendingUnknown.length + pendingAppr.length + strandedExecuting.length;
      if (checks.pendingReconciliations > 0) {
        const blocker = {
          verdict: 'block_reconciliation',
          accepted: false,
          evidenceRequired: true,
          verificationMode: 'reconciliation_gate',
          reasons: [
            `存在 ${checks.pendingReconciliations} 个状态未知或未收敛的外部副作用 (outcome_unknown/executing)，需人工核对后方可完成`,
          ],
          evidenceCount: pendingUnknown.length + strandedExecuting.length,
          checks,
        };
        if (sessionId) this.#emitVerdict(sessionId, turnId, blocker);
        return blocker;
      }

      if (allTurnIds.length > 0) {
        const tPh = allTurnIds.map(() => '?').join(',');
        turnReceipts = this.store.db
          .prepare(
            `SELECT * FROM tool_receipts WHERE sessionId IN (${sPh}) AND turnId IN (${tPh}) ORDER BY createdAt ASC, rowid ASC`,
          )
          .all(...allSessionIds, ...allTurnIds);
      } else {
        turnReceipts = this.store.db
          .prepare(
            `SELECT * FROM tool_receipts WHERE sessionId IN (${sPh}) ORDER BY createdAt ASC, rowid ASC`,
          )
          .all(...allSessionIds);
      }
    }

    // 1. Baseline verifier checks
    const base = verifyTurn({ events, text, node, execution });
    if (base && base.verdict !== 'pass' && Array.isArray(base.reasons)) {
      reasons.push(...base.reasons);
    }

    // Collect tool call arguments from DB messages + live events so verification and mutation
    // timeline checks work identically with or without a live Store/event pair.
    const callsById = new Map();
    const callCommands = new Map();
    if (this.store?.db?.isOpen && allSessionIds.length > 0) {
      try {
        const sPh = allSessionIds.map(() => '?').join(',');
        const msgRows = allTurnIds.length > 0
          ? this.store.db
              .prepare(`SELECT toolCalls FROM direct_messages WHERE sessionId IN (${sPh}) AND turnId IN (${allTurnIds.map(() => '?').join(',')}) AND role='assistant' AND toolCalls IS NOT NULL`)
              .all(...allSessionIds, ...allTurnIds)
          : this.store.db
              .prepare(`SELECT toolCalls FROM direct_messages WHERE sessionId IN (${sPh}) AND role='assistant' AND toolCalls IS NOT NULL`)
              .all(...allSessionIds);
        for (const row of msgRows) {
          try {
            const calls = JSON.parse(row.toolCalls);
            if (!Array.isArray(calls)) continue;
            for (const tc of calls) {
              if (!tc?.id) continue;
              const args = safeParseToolArgs(tc.arguments);
              callsById.set(tc.id, { index: -1, name: tc.name ?? '', args });
              if (typeof args?.command === 'string') callCommands.set(tc.id, args.command);
            }
          } catch {
            // ignore unparseable historical toolCalls
          }
        }
      } catch {
        // table unavailable in minimal store mocks
      }
    }
    for (let idx = 0; idx < events.length; idx += 1) {
      const ev = events[idx];
      if (ev.type === 'tool/call' && ev.data?.callId) {
        const args = safeToolArgs(ev.data?.arguments);
        callsById.set(ev.data.callId, {
          index: idx,
          name: ev.data?.name ?? '',
          args,
        });
        if (typeof args?.command === 'string') {
          callCommands.set(ev.data.callId, args.command);
        }
      }
    }

    const receiptById = new Map();
    const receiptByCallId = new Map();
    const receiptDbIndex = new Map();
    let maxTurnReceiptTs = 0;
    for (let i = 0; i < turnReceipts.length; i += 1) {
      const r = turnReceipts[i];
      if (r.id) receiptById.set(r.id, r);
      if (r.callId) receiptByCallId.set(r.callId, r);
      receiptDbIndex.set(r, i);
      if (typeof r.createdAt === 'number' && r.createdAt > maxTurnReceiptTs) {
        maxTurnReceiptTs = r.createdAt;
      }
    }

    const seenReceiptIds = new Set();
    const seenCallIds = new Set();
    const rawEventRuns = [];
    for (let evIdx = 0; evIdx < events.length; evIdx += 1) {
      const ev = events[evIdx];
      if (ev.type !== 'tool/result') continue;
      const cid = ev.data?.receipt?.callId ?? ev.data?.callId ?? null;
      const callInfo = cid ? callsById.get(cid) : null;
      const dbReceipt =
        (ev.data?.receipt?.id ? receiptById.get(ev.data.receipt.id) : null) ??
        (cid ? receiptByCallId.get(cid) : null);
      const receipt = dbReceipt ?? ev.data?.receipt ?? null;
      if (dbReceipt?.id) seenReceiptIds.add(dbReceipt.id);
      if (cid) seenCallIds.add(cid);

      const toolName = ev.data?.name ?? receipt?.toolName ?? callInfo?.name ?? '';
      const args = ev.data?.effectiveArgs ?? callInfo?.args ?? safeToolArgs(ev.data?.arguments);
      const status = receipt?.status ?? (ev.data?.isError ? 'failed' : 'finished');
      const exitCode =
        receipt?.exitCode !== undefined && receipt?.exitCode !== null
          ? receipt.exitCode
          : ev.data?.isError
            ? 1
            : 0;
      const isError =
        Boolean(ev.data?.isError) ||
        status === 'failed' ||
        status === 'rejected_before_effect' ||
        (typeof exitCode === 'number' && exitCode !== 0);
      const output = typeof ev.data?.content === 'string' ? ev.data.content : '';
      const explicitTs =
        (typeof dbReceipt?.createdAt === 'number' ? dbReceipt.createdAt : null) ??
        (typeof ev.data?.receipt?.createdAt === 'number' ? ev.data.receipt.createdAt : null) ??
        (typeof ev.ts === 'number' ? ev.ts : null) ??
        (typeof ev.createdAt === 'number' ? ev.createdAt : null);
      const dbIdx = dbReceipt ? receiptDbIndex.get(dbReceipt) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      rawEventRuns.push({
        run: {
          toolName,
          args,
          status,
          exitCode,
          isError,
          receipt,
          callId: cid ?? receipt?.callId ?? null,
          output,
          sessionId: receipt?.sessionId ?? sessionId ?? null,
        },
        evIdx,
        explicitTs,
        dbIdx,
      });
    }

    const sortableRuns = [];
    for (let i = 0; i < rawEventRuns.length; i += 1) {
      const item = rawEventRuns[i];
      let ts = item.explicitTs;
      let dbIdx = item.dbIdx;
      let sub = 0;
      if (ts === null) {
        let prevAnchor = null;
        for (let p = i - 1; p >= 0; p -= 1) {
          if (rawEventRuns[p].explicitTs !== null) {
            prevAnchor = rawEventRuns[p];
            break;
          }
        }
        if (prevAnchor) {
          ts = prevAnchor.explicitTs;
          dbIdx = prevAnchor.dbIdx;
          sub = item.evIdx + 1;
        } else {
          let nextAnchor = null;
          for (let n = i + 1; n < rawEventRuns.length; n += 1) {
            if (rawEventRuns[n].explicitTs !== null) {
              nextAnchor = rawEventRuns[n];
              break;
            }
          }
          if (nextAnchor) {
            ts = nextAnchor.explicitTs;
            dbIdx = nextAnchor.dbIdx;
            sub = -100000 + item.evIdx;
          } else {
            ts = maxTurnReceiptTs + 1;
            dbIdx = 0;
            sub = item.evIdx;
          }
        }
      }
      sortableRuns.push({
        run: item.run,
        ts,
        dbIdx,
        sub,
        evIdx: item.evIdx,
      });
    }

    for (let dbIdx = 0; dbIdx < turnReceipts.length; dbIdx += 1) {
      const r = turnReceipts[dbIdx];
      if ((r.id && seenReceiptIds.has(r.id)) || (r.callId && seenCallIds.has(r.callId))) {
        continue;
      }
      const callInfo = r.callId ? callsById.get(r.callId) : null;
      const isError =
        r.status === 'failed' ||
        r.status === 'rejected_before_effect' ||
        (typeof r.exitCode === 'number' && r.exitCode !== 0);
      sortableRuns.push({
        run: {
          toolName: r.toolName,
          args: callInfo?.args ?? {},
          status: r.status,
          exitCode: r.exitCode,
          isError,
          receipt: r,
          callId: r.callId ?? null,
          output: '',
          sessionId: r.sessionId ?? sessionId ?? null,
        },
        ts: typeof r.createdAt === 'number' ? r.createdAt : 0,
        dbIdx,
        sub: 0,
        evIdx: -1,
      });
    }

    sortableRuns.sort(
      (a, b) =>
        a.ts - b.ts ||
        a.dbIdx - b.dbIdx ||
        a.sub - b.sub ||
        a.evIdx - b.evIdx,
    );
    const orderedToolRuns = sortableRuns.map((s) => s.run);

    // 2. Cross-check pass/success claims and post-edit verification against real receipts/timeline
    const effectiveShellReceipts = [];
    for (let idx = 0; idx < orderedToolRuns.length; idx += 1) {
      const run = orderedToolRuns[idx];
      if (!['bash', 'start_process'].includes(run.toolName)) continue;
      effectiveShellReceipts.push({
        id: run.receipt?.id ?? run.callId ?? `event-shell-${effectiveShellReceipts.length}`,
        callId: run.callId ?? run.receipt?.callId ?? `event-shell-${effectiveShellReceipts.length}`,
        sessionId: run.sessionId ?? sessionId ?? 'event-session',
        toolName: run.toolName,
        status: run.status,
        exitCode: run.exitCode,
        args: run.args,
        output: run.output ?? '',
        orderedIndex: idx,
      });
    }

    const failedShells = effectiveShellReceipts.filter(
      (r) =>
        r.status === 'failed' ||
        r.status === 'rejected_before_effect' ||
        (typeof r.exitCode === 'number' && r.exitCode !== 0),
    );
    const latestShell = effectiveShellReceipts.at(-1);
    const unresolvedShellFailure =
      failedShells.length > 0 &&
      (!latestShell ||
        latestShell.status === 'failed' ||
        latestShell.status === 'rejected_before_effect' ||
        (latestShell.exitCode ?? 0) !== 0);
    checks.failedShellReceipts = failedShells.length;

    const allMutatedFiles = [];
    const allMutatedSet = new Set();
    let lastCodeMutationIndex = -1;
    const verificationRuns = [];
    let lastPassingVerification = null;
    let mutatedAfterLastPass = [];
    let mutatedAfterLastPassSet = new Set();
    let mutatedDocAfterLastPass = [];
    let mutatedDocAfterLastPassSet = new Set();
    let verificationRunsCount = 0;
    let latestFailureRun = null;
    const failureRunByCallId = new Map();
    const baselineTestFiles =
      execution?.baselineTestFiles ?? node?.baselineTestFiles ?? [];

    for (let idx = 0; idx < orderedToolRuns.length; idx += 1) {
      const run = orderedToolRuns[idx];
      if (
        POST_EDIT_FILE_MUTATION_TOOLS.has(run.toolName) &&
        !run.isError &&
        run.status !== 'rejected_before_effect' &&
        run.status !== 'outcome_unknown'
      ) {
        const files = extractMutatedFilesFromToolCall(run.toolName, run.args, workspaceRoot);
        let touchedNonDoc = false;
        for (const f of files) {
          if (!allMutatedSet.has(f)) {
            allMutatedSet.add(f);
            allMutatedFiles.push(f);
          }
          const mutKind = classifyMutationPath(f, {
            workspaceRoot,
            baselineTestFiles,
          });
          if (mutKind !== 'doc') touchedNonDoc = true;
          if (lastPassingVerification) {
            if (mutKind === 'doc') {
              if (!mutatedDocAfterLastPassSet.has(f)) {
                mutatedDocAfterLastPassSet.add(f);
                mutatedDocAfterLastPass.push(f);
              }
            } else if (!mutatedAfterLastPassSet.has(f)) {
              mutatedAfterLastPassSet.add(f);
              mutatedAfterLastPass.push(f);
            }
          }
        }
        if (touchedNonDoc) {
          lastCodeMutationIndex = idx;
        }
      } else if (run.toolName === 'bash' && isVerificationCommand(run.args?.command)) {
        verificationRunsCount += 1;
        let cwd = run.args?.cwd || '.';
        if (workspaceRoot) {
          try { cwd = resolveWorkspacePath(workspaceRoot, cwd).rel; } catch { /* keep raw cwd */ }
        }
        const command = run.args.command.trim();
        const passed =
          run.status === 'finished' &&
          !run.isError &&
          (run.exitCode === 0 || run.exitCode === null || run.exitCode === undefined);
        const fingerprint =
          !passed && run.output
            ? extractFailureFingerprint({
                toolName: run.toolName,
                args: run.args,
                output: run.output,
                receipt: run.receipt,
                workspaceRoot,
              })
            : null;
        const vRun = {
          index: idx,
          command,
          cwd,
          passed,
          exitCode: run.exitCode,
          status: run.status,
          output: run.output,
          callId: run.callId,
          receipt: run.receipt,
          fingerprint,
        };
        verificationRuns.push(vRun);
        if (passed) {
          lastPassingVerification = vRun;
          mutatedAfterLastPass = [];
          mutatedAfterLastPassSet = new Set();
          mutatedDocAfterLastPass = [];
          mutatedDocAfterLastPassSet = new Set();
        } else {
          latestFailureRun = vRun;
          if (run.callId) failureRunByCallId.set(run.callId, vRun);
        }
      }
    }

    const staleAfterEdit = Boolean(lastPassingVerification && mutatedAfterLastPass.length > 0);
    const unresolvedEntry = findUnresolvedVerification(
      effectiveShellReceipts,
      events,
      workspaceRoot,
      callsById,
      {
        lastPassingVerification,
        staleAfterEdit,
        lastCodeMutationIndex,
        allMutatedFiles,
        verificationRuns,
      },
    );
    const unresolvedCheck = unresolvedEntry?.receipt ?? null;
    const unresolvedCommand = unresolvedEntry?.command ?? null;
    const hasPassClaim = PASS_CLAIM_RE.test(String(text || ''));
    if (hasPassClaim && (unresolvedCheck || unresolvedShellFailure)) {
      if (unresolvedCheck) {
        reasons.push(
          `FABRICATED_PASS_CLAIM: 验证命令未成功 (callId=${unresolvedCheck.callId}, exitCode=${unresolvedCheck.exitCode ?? 'unknown'})。请修复后在同一目录重跑原验证命令，或如实报告未通过。`,
        );
      } else {
        reasons.push(
          `FABRICATED_PASS_CLAIM: 最近命令执行失败 (exitCode=${latestShell?.exitCode ?? 'non-zero'})，不得声称验证或构建通过`,
        );
      }
    }

    const contract = execution?.evidenceContract ?? node?.evidenceContract ?? null;
    const requirePostEditVerification = Boolean(execution?.requirePostEditVerification);
    checks.mutatedFiles = [...allMutatedFiles];

    checks.staleVerificationAfterEdit = staleAfterEdit;
    checks.mutatedFilesAfterVerification = [...mutatedAfterLastPass];
    checks.mutatedDocFilesAfterVerification = [...mutatedDocAfterLastPass];
    if (staleAfterEdit) {
      checks.lastPassingVerificationCommand = lastPassingVerification.command;
      reasons.push(
        `STALE_VERIFICATION_AFTER_EDIT: 文件 (${mutatedAfterLastPass.join(', ')}) 在上次验证通过 (${lastPassingVerification.command}) 之后被修改，且修改后未重新运行通过的验证命令。`,
      );
    }

    let diagnosticExcerpt = null;
    let failureFingerprint = null;
    const hasActivePostEditGate =
      allMutatedFiles.length > 0 || Boolean(contract) || requirePostEditVerification;
    if (unresolvedCheck && hasActivePostEditGate) {
      const matchingFailure =
        (unresolvedCheck.callId ? failureRunByCallId.get(unresolvedCheck.callId) : null) ??
        latestFailureRun;
      failureFingerprint =
        matchingFailure?.fingerprint ??
        reasoningState?.errorFingerprints?.at(-1) ??
        null;
      diagnosticExcerpt =
        failureFingerprint?.summary ??
        (matchingFailure?.output ? matchingFailure.output.slice(0, 200).trim() : null);
      checks.unresolvedVerificationFailure = true;
      if (unresolvedCommand) checks.unresolvedVerificationCommand = unresolvedCommand;
      if (diagnosticExcerpt) checks.diagnosticExcerpt = diagnosticExcerpt;
      reasons.push(
        `UNRESOLVED_VERIFICATION_FAILURE: 最新验证命令 (${unresolvedCommand || 'verification'}, callId=${unresolvedCheck.callId ?? 'unknown'}, exitCode=${unresolvedCheck.exitCode ?? 'unknown'}) 仍未通过${diagnosticExcerpt ? ` (${diagnosticExcerpt})` : ''}。请先定位根因修复后再重跑验证。`,
      );
    } else {
      checks.unresolvedVerificationFailure = false;
    }

    if (requirePostEditVerification && allMutatedFiles.length > 0 && verificationRunsCount === 0 && !contract) {
      checks.postEditVerificationMissing = true;
      reasons.push(
        `POST_EDIT_VERIFICATION_MISSING: 文件 (${allMutatedFiles.join(', ')}) 已修改，但本轮尚未运行任何验证命令。`,
      );
    }

    // 3. Verify claimed file mutations exist on disk when workspaceRoot is supplied
    if (workspaceRoot && (events.length || turnReceipts.length)) {
      const latestWriteInfo = new Map();
      const resolvedPaths = new Map();
      const deletionEvents = [];

      for (let runIdx = 0; runIdx < orderedToolRuns.length; runIdx += 1) {
        const run = orderedToolRuns[runIdx];
        if (
          run.isError ||
          run.status === 'rejected_before_effect' ||
          run.status === 'outcome_unknown'
        ) {
          continue;
        }
        const call = run.callId ? callsById.get(run.callId) : null;
        const evCallIdx = call && typeof call.index === 'number' && call.index >= 0 ? call.index : -1;

        if (['write_file', 'edit_file'].includes(run.toolName)) {
          const pathArg = run.args?.path;
          if (!pathArg) continue;
          try {
            const { full, rel } = resolveWorkspacePath(workspaceRoot, pathArg);
            resolvedPaths.set(rel, full);
            const prev = latestWriteInfo.get(rel);
            latestWriteInfo.set(rel, {
              runIdx: Math.max(prev?.runIdx ?? -1, runIdx),
              evCallIdx: Math.max(prev?.evCallIdx ?? -1, evCallIdx),
            });
          } catch {
            // Path outside workspace was already blocked before execution
          }
        } else if (['bash', 'delete_file'].includes(run.toolName)) {
          if (typeof run.exitCode === 'number' && run.exitCode !== 0) continue;
          deletionEvents.push({
            runIdx,
            evCallIdx,
            name: run.toolName,
            args: run.args,
          });
        }
      }

      const requiredPaths = new Set();
      for (const reqPath of [
        ...(Array.isArray(node?.requiredFiles) ? node.requiredFiles : []),
        ...(Array.isArray(contract?.requiredChangedFiles) ? contract.requiredChangedFiles : []),
      ]) {
        try {
          const { rel } = resolveWorkspacePath(workspaceRoot, reqPath);
          requiredPaths.add(rel);
        } catch {
          // ignore unresolvable requirement path here
        }
      }

      const cleanedUpFiles = [];
      for (const [rel, full] of resolvedPaths.entries()) {
        if (existsSync(full)) continue;
        const lastWrite = latestWriteInfo.get(rel) ?? { runIdx: -1, evCallIdx: -1 };
        let explicitlyDeleted = false;
        if (!requiredPaths.has(rel)) {
          for (const delEv of deletionEvents) {
            const isAfterWrite =
              delEv.evCallIdx >= 0 && lastWrite.evCallIdx >= 0
                ? delEv.evCallIdx > lastWrite.evCallIdx
                : delEv.runIdx > lastWrite.runIdx;
            if (!isAfterWrite) continue;
            if (delEv.name === 'delete_file' && delEv.args?.path) {
              try {
                if (resolveWorkspacePath(workspaceRoot, delEv.args.path).rel === rel) {
                  explicitlyDeleted = true;
                  break;
                }
              } catch {
                // ignore invalid path
              }
            } else if (
              delEv.name === 'bash' &&
              isExplicitFileDeleteCommand(delEv.args?.command, rel, {
                workspaceRoot,
                cwd: delEv.args?.cwd,
              })
            ) {
              explicitlyDeleted = true;
              break;
            }
          }
        }
        if (explicitlyDeleted) {
          cleanedUpFiles.push(rel);
        } else {
          checks.missingDiskFiles.push(rel);
        }
      }
      if (cleanedUpFiles.length > 0) {
        checks.cleanedUpTempFiles = cleanedUpFiles;
      }
      if (checks.missingDiskFiles.length > 0) {
        reasons.push(
          `DISK_FILE_MISSING: 声明写入的工作区文件在磁盘上不存在: ${checks.missingDiskFiles.join(', ')}`,
        );
      }
    }
    let contractValidation = null;
    if (contract) {
      const receiptsForContract = turnReceipts.length > 0
        ? turnReceipts.map((r) => ({ ...r, command: callCommands.get(r.callId) ?? '' }))
        : events
            .filter((ev) => ev.type === 'tool/result')
            .map((ev) => {
              const cid = ev.data?.callId ?? ev.data?.receipt?.callId ?? null;
              const name = ev.data?.name ?? ev.data?.receipt?.toolName ?? '';
              return {
                id: ev.data?.receipt?.id ?? cid ?? 'event-receipt',
                callId: cid,
                toolName: name,
                status: ev.data?.receipt?.status ?? (ev.data?.isError ? 'failed' : 'finished'),
                exitCode: ev.data?.receipt?.exitCode ?? (ev.data?.isError ? 1 : 0),
                command: (cid ? callCommands.get(cid) : '') ?? '',
              };
            });

      const contractWorkspace = contract.workspaceRoot || workspaceRoot || null;
      const actualChangedFiles = contractWorkspace ? listWorkspaceChangedFiles(contractWorkspace) : undefined;
      contractValidation = validateEvidenceManifest(text, {
        ...contract,
        workspaceRoot: contractWorkspace,
        actualChangedFiles,
        toolReceipts: receiptsForContract,
        requireIndependentVerdict: contract.requireIndependentVerdict === true,
      });
      checks.manifestStatus = contractValidation.status;
      checks.missingFields = contractValidation.missingFields;
      checks.evidenceContract = contractValidation.checks;
      if (!contractValidation.valid) {
        const detail = contractValidation.missingFields.length
          ? `missing=${contractValidation.missingFields.join(',')}`
          : contractValidation.errors.join('; ');
        reasons.push(`${contractValidation.status}: ${detail}`);
      }
    }

    const hasToolActivity =
      events.some((e) => e.type === 'tool/call' || e.type === 'tool/result') ||
      turnReceipts.length > 0 ||
      Boolean(node?.requiredFiles?.length) ||
      Boolean(contract);

    const out =
      reasons.length === 0 && !hasToolActivity
        ? buildPlainTextPassVerdict(checks)
        : {
            verdict: reasons.length ? 'fail' : 'pass',
            ...(contractValidation && !contractValidation.valid ? { status: contractValidation.status, missingFields: contractValidation.missingFields, expectedTestCommand: contract.expectedTestCommand, actualChangedFiles: checks.evidenceContract ? (contract.workspaceRoot || workspaceRoot ? listWorkspaceChangedFiles(contract.workspaceRoot || workspaceRoot) : undefined) : undefined } : {}),
            ...(diagnosticExcerpt ? { diagnosticExcerpt } : {}),
            ...(failureFingerprint ? { failureFingerprint } : {}),
            accepted: reasons.length === 0,
            evidenceRequired: true,
            verificationMode: contract ? 'evidence_contract_checked' : 'evidence_checked',
            reasons,
            evidenceCount: turnReceipts.length,
            checks,
          };
    if (sessionId) this.#emitVerdict(sessionId, turnId, out);
    return out;
  }

  #emitVerdict(sessionId, turnId, verdict) {
    this.eventRouter?.emitPersisted({
      sessionId,
      turnId,
      type: RUNTIME_EVENTS.VERIFIER_VERDICT,
      data: verdict,
      audit: true,
    });
  }
}
