import { checkHardBlockedCommand } from '../tools.js';
import { canonicalizeCommandPrefix } from '../patch-and-diagnostics.js';
import { isProtectedPathSegment, normalizeProtectedSegment } from './sandbox.js';

const SHELL_COMPOUND_RE = /[;&|><`\r\n]|\$\(|@\(|<\(|>\(/;
const DOUBLE_QUOTE_SUBST_RE = /`|\$\(/;
const READONLY_UNSAFE_RAW_RE = /[;&|><`\r\n$]|\$\(|@\(|<\(|>\(/;

const POWERSHELL_HARD_BLOCK_RE =
  /\b(?:invoke-expression|iex|format-volume|clear-disk|stop-computer|restart-computer|bcdedit|diskpart|cipher\s+\/w)\b|(?:^|\s)-(?:enc|encodedcommand)\b|\bremove-item\b[^\n]*-(?:recurse|r)\b[^\n]*(?:[a-z]:\\|\/|~|\$env:)/i;

const GIT_BRANCH_READONLY_FLAGS = new Set([
  '-a',
  '--all',
  '-r',
  '--remotes',
  '-l',
  '--list',
  '--show-current',
  '-v',
  '-vv',
  '--verbose',
  '--no-color',
  '--color',
  '--merged',
  '--no-merged',
  '--contains',
  '--no-contains',
  '--points-at',
  '--sort',
  '--format',
  '--abbrev',
  '--no-abbrev',
]);

const GIT_BRANCH_MUTATING_FLAGS = new Set([
  '-d',
  '-D',
  '--delete',
  '-m',
  '-M',
  '--move',
  '-c',
  '-C',
  '--copy',
  '-f',
  '--force',
  '-u',
  '--set-upstream-to',
  '--unset-upstream',
  '--edit-description',
  '--track',
  '--no-track',
  '--create-reflog',
]);

const GIT_BLOCKED_FLAGS = new Set([
  '-c',
  '-C',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--exec',
  '--exec-path',
  '--upload-pack',
  '--receive-pack',
  '--output',
  '-o',
  '--no-index',
  '--ext-diff',
  '--textconv',
]);

const READONLY_ALLOWLIST = new Map([
  [
    'git',
    {
      subcommands: new Set([
        'status',
        'diff',
        'log',
        'branch',
        'show',
        'rev-parse',
        'describe',
      ]),
      blockedFlags: GIT_BLOCKED_FLAGS,
    },
  ],
  ['pwd', { subcommands: null, blockedFlags: new Set() }],
  ['echo', { subcommands: null, blockedFlags: new Set() }],
  ['which', { subcommands: null, blockedFlags: new Set() }],
  ['where', { subcommands: null, blockedFlags: new Set() }],
  [
    'node',
    {
      subcommands: null,
      allowedExactArgs: new Set(['-v', '--version']),
      blockedFlags: new Set(['-e', '--eval', '-p', '--print', '--require', '-r']),
    },
  ],
  [
    'npm',
    {
      subcommands: new Set(['--version', '-v', 'ls', 'list']),
      blockedFlags: new Set(),
    },
  ],
  ['get-location', { subcommands: null, blockedFlags: new Set() }],
]);

/**
 * Quote-aware shell tokenization and operator inspection across POSIX & PowerShell.
 * Never allows backslash (`\`) to hide shell operators (`;`, `|`, `&`, `>`, `<`, `` ` ``, `$`, newlines)
 * because PowerShell treats `\` as a literal character rather than an escape!
 */
export function scanCommandSyntax(command) {
  const cmd = String(command ?? '');
  let inSingle = false;
  let inDouble = false;
  let hasCompound = false;
  let hasSubstitution = false;
  const tokens = [];
  let cur = '';
  let unquotedBuf = '';

  const flush = () => {
    if (cur.length) {
      tokens.push(cur);
      cur = '';
    }
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        cur += ch;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < cmd.length) {
        const nextCh = cmd[i + 1];
        // Never allow backslash to mask command substitution or newlines
        if (nextCh === '`' || nextCh === '$' || nextCh === '\r' || nextCh === '\n') {
          hasSubstitution = true;
        }
        cur += nextCh;
        i++;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      } else {
        cur += ch;
        if (DOUBLE_QUOTE_SUBST_RE.test(cmd.slice(i, i + 2))) {
          hasSubstitution = true;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      unquotedBuf += ch;
      continue;
    }
    unquotedBuf += ch;
    cur += ch;
  }
  flush();

  if (inSingle || inDouble) hasCompound = true;
  if (SHELL_COMPOUND_RE.test(unquotedBuf)) hasCompound = true;
  if (/`|\$\(|@\(/ .test(unquotedBuf)) hasSubstitution = true;

  return {
    tokens,
    hasCompound,
    hasSubstitution,
    unbalancedQuotes: inSingle || inDouble,
  };
}

function isSafeGitReadOnly(rest) {
  let subIdx = -1;
  let subcmd = null;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    const flag = tok.split('=')[0];
    const lowerFlag = flag.toLowerCase();
    if (
      GIT_BLOCKED_FLAGS.has(flag) ||
      GIT_BLOCKED_FLAGS.has(lowerFlag) ||
      (!tok.startsWith('--') && (tok.startsWith('-c') || tok.startsWith('-C') || tok.startsWith('-o')))
    ) {
      return false;
    }
    if (subIdx === -1 && !tok.startsWith('-')) {
      subIdx = i;
      subcmd = tok.toLowerCase();
    }
  }
  const gitRule = READONLY_ALLOWLIST.get('git');
  if (!subcmd || !gitRule.subcommands.has(subcmd)) return false;

  // For `git branch`, only permit strict read-only listing (no delete/move/copy/create)
  if (subcmd === 'branch') {
    const afterBranch = rest.slice(subIdx + 1);
    for (const tok of afterBranch) {
      const flag = tok.split('=')[0];
      if (GIT_BRANCH_MUTATING_FLAGS.has(flag) || GIT_BRANCH_MUTATING_FLAGS.has(flag.toLowerCase())) {
        return false;
      }
      if (!tok.startsWith('-')) {
        // Positional arg on `git branch <name>` creates a branch!
        return false;
      }
      if (!GIT_BRANCH_READONLY_FLAGS.has(flag) && !GIT_BRANCH_READONLY_FLAGS.has(flag.toLowerCase())) {
        return false;
      }
    }
  }
  return true;
}

const BLOCKED_LONG_TEST_FLAGS = new Set([
  '--eval',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--print',
  '--override-ini',
  '--config-file',
  '--addopts',
  '--input-type',
  '--check',
  '--watch',
  '--userconfig',
  '--globalconfig',
  '--prefix',
  '--script-shell',
  '--shell',
  '--package',
  '--call',
  '--yes',
  '--outdir',
  '--outfile',
]);

const PATH_TAKING_TEST_FLAGS = new Set([
  '--rootdir',
  '--confcutdir',
  '--basetemp',
  '--junitxml',
  '--project',
  '--tsconfig',
]);

const VALUE_TAKING_PYTEST_FLAGS = new Set(['-k', '-m', '--tb', '--maxfail', '--durations', '--color', '--capture']);
const VALUE_TAKING_UNITTEST_FLAGS = new Set(['-k']);
const PATH_TAKING_UNITTEST_FLAGS = new Set(['-s', '-t', '--start-directory', '--top-level-directory']);
const VALUE_TAKING_NODE_FLAGS = new Set([
  '--test-name-pattern',
  '--test-reporter',
  '--test-concurrency',
  '--test-timeout',
]);

function isSafeRelativePath(raw, { allowNodeId = false } = {}) {
  const s = String(raw ?? '').trim();
  if (!s || s.startsWith('-')) return false;
  if (allowNodeId && s.includes('::')) {
    const idx = s.indexOf('::');
    const filePart = s.slice(0, idx);
    const nodePart = s.slice(idx + 2);
    if (!filePart || !nodePart || nodePart.includes('..') || /[\0;&|><`\r\n$%]/.test(nodePart)) {
      return false;
    }
    return isSafeRelativePath(filePart, { allowNodeId: false });
  }
  if (/[\0;&|><`\r\n$%]/.test(s)) return false;
  if (
    s.startsWith('/') ||
    s.startsWith('\\') ||
    s.startsWith('~') ||
    /^[A-Za-z]:/.test(s) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
  ) {
    return false;
  }
  const segs = s.split(/[\\/]/).filter(Boolean);
  if (!segs.length) return false;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const norm = normalizeProtectedSegment(seg);
    if (
      seg === '..' ||
      isProtectedPathSegment(seg) ||
      norm === 'upstream' ||
      (norm === 'var' && i > 0 && normalizeProtectedSegment(segs[i - 1]) === 'backend') ||
      /^\.env(?:$|[._-])/i.test(norm)
    ) {
      return false;
    }
  }
  return true;
}

function isSafePythonReadOnly(rawHead, rest) {
  if (/[\\/]/.test(rawHead)) return false;
  if (rest.length === 1 && (rest[0] === '--version' || rest[0] === '-V')) {
    return true;
  }
  let idx = 0;
  if (rest[0] === '-B') idx = 1;
  if (rest[idx] !== '-m' || rest[idx + 1] !== 'py_compile') return false;
  const targets = rest.slice(idx + 2);
  if (!targets.length) return false;
  return targets.every((t) => isSafeRelativePath(t));
}

function isDangerousTestFlagToken(tok) {
  if (!tok.startsWith('-') || tok === '--') return false;
  const eqIdx = tok.indexOf('=');
  const flagName = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok;
  const lower = flagName.toLowerCase();
  if (BLOCKED_LONG_TEST_FLAGS.has(lower)) return true;
  if (!flagName.startsWith('--')) {
    const shortLetters = flagName.slice(1);
    if (!shortLetters || /[ceprowC]/.test(shortLetters)) return true;
  }
  return false;
}

function isSafePytestArgs(rest) {
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (isDangerousTestFlagToken(tok)) return false;
    const eqIdx = tok.indexOf('=');
    const flagName = (eqIdx >= 0 ? tok.slice(0, eqIdx) : tok).toLowerCase();
    const flagVal = eqIdx >= 0 ? tok.slice(eqIdx + 1) : null;

    if (PATH_TAKING_TEST_FLAGS.has(flagName)) {
      const target = flagVal !== null ? flagVal : rest[++i];
      if (!isSafeRelativePath(target)) return false;
      continue;
    }
    if (VALUE_TAKING_PYTEST_FLAGS.has(flagName)) {
      if (flagVal === null) {
        const nextVal = rest[++i];
        if (!nextVal || nextVal.startsWith('-')) return false;
      }
      continue;
    }
    if (tok.startsWith('-')) continue;
    if (!isSafeRelativePath(tok, { allowNodeId: true })) return false;
  }
  return true;
}

function isSafeUnittestArgs(rest) {
  let startIdx = 0;
  if (rest[0] === 'discover') startIdx = 1;
  for (let i = startIdx; i < rest.length; i++) {
    const tok = rest[i];
    if (isDangerousTestFlagToken(tok)) return false;
    const eqIdx = tok.indexOf('=');
    const flagName = (eqIdx >= 0 ? tok.slice(0, eqIdx) : tok).toLowerCase();
    const flagVal = eqIdx >= 0 ? tok.slice(eqIdx + 1) : null;

    if (PATH_TAKING_UNITTEST_FLAGS.has(flagName) || PATH_TAKING_TEST_FLAGS.has(flagName)) {
      const target = flagVal !== null ? flagVal : rest[++i];
      if (!isSafeRelativePath(target)) return false;
      continue;
    }
    if (VALUE_TAKING_UNITTEST_FLAGS.has(flagName)) {
      if (flagVal === null) {
        const nextVal = rest[++i];
        if (!nextVal || nextVal.startsWith('-')) return false;
      }
      continue;
    }
    if (tok.startsWith('-')) continue;
    if (/[\\/:~]/.test(tok) || tok.includes('..') || tok.endsWith('.py')) {
      if (!isSafeRelativePath(tok)) return false;
    } else if (/^[\0;&|><`\r\n$%]$/.test(tok) || !/^[A-Za-z0-9_.]+$/.test(tok)) {
      return false;
    }
  }
  return true;
}

function isSafeNodeOrNpmTestArgs(rest) {
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--') continue;
    if (isDangerousTestFlagToken(tok)) return false;
    const eqIdx = tok.indexOf('=');
    const flagName = (eqIdx >= 0 ? tok.slice(0, eqIdx) : tok).toLowerCase();
    const flagVal = eqIdx >= 0 ? tok.slice(eqIdx + 1) : null;

    if (PATH_TAKING_TEST_FLAGS.has(flagName)) {
      const target = flagVal !== null ? flagVal : rest[++i];
      if (!isSafeRelativePath(target)) return false;
      continue;
    }
    if (VALUE_TAKING_NODE_FLAGS.has(flagName)) {
      if (flagVal === null) {
        const nextVal = rest[++i];
        if (!nextVal || nextVal.startsWith('-')) return false;
      }
      continue;
    }
    if (tok.startsWith('-')) continue;
    if (!isSafeRelativePath(tok)) return false;
  }
  return true;
}

function isSafeNpxTscArgs(rest) {
  if (rest[0] !== 'tsc') return false;
  const tscArgs = rest.slice(1);
  if (!tscArgs.includes('--noEmit')) return false;
  for (let i = 0; i < tscArgs.length; i++) {
    const tok = tscArgs[i];
    if (isDangerousTestFlagToken(tok)) return false;
    const eqIdx = tok.indexOf('=');
    const flagName = (eqIdx >= 0 ? tok.slice(0, eqIdx) : tok).toLowerCase();
    const flagVal = eqIdx >= 0 ? tok.slice(eqIdx + 1) : null;

    if (flagName === '--project') {
      const target = flagVal !== null ? flagVal : tscArgs[++i];
      if (!isSafeRelativePath(target)) return false;
      continue;
    }
    if (flagName === '--pretty') {
      if (flagVal === null) {
        const val = tscArgs[++i];
        if (val !== 'false' && val !== 'true') return false;
      }
      continue;
    }
    if (PATH_TAKING_TEST_FLAGS.has(flagName)) {
      const target = flagVal !== null ? flagVal : tscArgs[++i];
      if (!isSafeRelativePath(target)) return false;
      continue;
    }
    if (tok.startsWith('-')) {
      if (!['--noemit', '--incremental', '--skiplibcheck', '--strict'].includes(flagName)) {
        return false;
      }
      continue;
    }
    if (!isSafeRelativePath(tok)) return false;
  }
  return true;
}

function isSafeLocalTestCommand(syntax, rawCommand) {
  if (
    syntax.hasCompound ||
    syntax.hasSubstitution ||
    syntax.unbalancedQuotes ||
    READONLY_UNSAFE_RAW_RE.test(rawCommand) ||
    !syntax.tokens.length
  ) {
    return false;
  }
  const rawHead = syntax.tokens[0];
  if (/[\\/]/.test(rawHead)) return false;
  const head = rawHead.toLowerCase().replace(/\.exe$/, '');
  const rest = syntax.tokens.slice(1);

  if (head === 'pytest') {
    return isSafePytestArgs(rest);
  }
  if (head === 'python' || head === 'python3') {
    if (rest[0] !== '-m') return false;
    if (rest[1] === 'pytest') return isSafePytestArgs(rest.slice(2));
    if (rest[1] === 'unittest') return isSafeUnittestArgs(rest.slice(2));
    return false;
  }
  if (head === 'node') {
    return rest[0] === '--test' && isSafeNodeOrNpmTestArgs(rest.slice(1));
  }
  if (head === 'npm') {
    if (rest[0] === 'test') return isSafeNodeOrNpmTestArgs(rest.slice(1));
    if (rest[0] === 'run' && rest[1] === 'test') return isSafeNodeOrNpmTestArgs(rest.slice(2));
    return false;
  }
  if (head === 'npx') {
    return isSafeNpxTscArgs(rest);
  }
  return false;
}

/**
 * Analyzes a shell/PowerShell command string for hard-blocks, read-only allowlist eligibility,
 * safe local test classification, and safe prefix canonicalization.
 */
export function analyzeCommand(rawCommand) {
  const command = String(rawCommand ?? '').trim();
  if (!command) {
    return {
      hardBlocked: 'empty-command',
      isReadOnly: false,
      isSafeLocalTest: false,
      commandPrefix: null,
      hasCompound: false,
    };
  }

  const posixBlock = checkHardBlockedCommand(['sh', '-c', command]);
  if (posixBlock) {
    return {
      hardBlocked: posixBlock,
      isReadOnly: false,
      isSafeLocalTest: false,
      commandPrefix: null,
      hasCompound: true,
    };
  }

  // Strip PowerShell inline backtick obfuscation (e.g. I`nvoke-Expression) before matching
  const deobfuscatedPs = command.replace(/`(?!\r?\n)/g, '');
  if (POWERSHELL_HARD_BLOCK_RE.test(command) || POWERSHELL_HARD_BLOCK_RE.test(deobfuscatedPs)) {
    return {
      hardBlocked: 'powershell-destructive-or-eval',
      isReadOnly: false,
      isSafeLocalTest: false,
      commandPrefix: null,
      hasCompound: true,
    };
  }

  const syntax = scanCommandSyntax(command);
  const commandPrefix = canonicalizeCommandPrefix(command);

  let isReadOnly = false;
  if (
    !syntax.hasCompound &&
    !syntax.hasSubstitution &&
    !syntax.unbalancedQuotes &&
    !READONLY_UNSAFE_RAW_RE.test(command) &&
    syntax.tokens.length
  ) {
    const rawHead = syntax.tokens[0];
    const head = rawHead.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    const rest = syntax.tokens.slice(1);
    if (head === 'python' || head === 'python3') {
      isReadOnly = isSafePythonReadOnly(rawHead, rest);
    } else {
      const rule = READONLY_ALLOWLIST.get(head);
      if (rule) {
        if (head === 'git') {
          isReadOnly = isSafeGitReadOnly(rest);
        } else {
          const hasBlockedFlag = rest.some((t) => {
            const flag = t.split('=')[0].toLowerCase();
            return rule.blockedFlags.has(flag);
          });
          if (!hasBlockedFlag) {
            if (rule.allowedExactArgs) {
              isReadOnly = rest.length === 1 && rule.allowedExactArgs.has(rest[0]);
            } else if (rule.subcommands) {
              const firstPositional = rest.find((t) => !t.startsWith('-'))?.toLowerCase();
              isReadOnly = Boolean(firstPositional && rule.subcommands.has(firstPositional));
            } else {
              isReadOnly = true;
            }
          }
        }
      }
    }
  }

  const isSafeLocalTest = isSafeLocalTestCommand(syntax, command);

  return {
    hardBlocked: null,
    isReadOnly,
    isSafeLocalTest,
    commandPrefix,
    hasCompound: syntax.hasCompound || syntax.hasSubstitution,
  };
}
