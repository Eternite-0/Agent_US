import { checkHardBlockedCommand } from '../tools.js';
import { canonicalizeCommandPrefix } from '../patch-and-diagnostics.js';

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

/**
 * Analyzes a shell/PowerShell command string for hard-blocks, read-only allowlist eligibility,
 * and safe prefix canonicalization.
 */
export function analyzeCommand(rawCommand) {
  const command = String(rawCommand ?? '').trim();
  if (!command) {
    return {
      hardBlocked: 'empty-command',
      isReadOnly: false,
      commandPrefix: null,
      hasCompound: false,
    };
  }

  const posixBlock = checkHardBlockedCommand(['sh', '-c', command]);
  if (posixBlock) {
    return {
      hardBlocked: posixBlock,
      isReadOnly: false,
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
    const head = syntax.tokens[0].split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    const rule = READONLY_ALLOWLIST.get(head);
    if (rule) {
      const rest = syntax.tokens.slice(1);
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

  return {
    hardBlocked: null,
    isReadOnly,
    commandPrefix,
    hasCompound: syntax.hasCompound || syntax.hasSubstitution,
  };
}
