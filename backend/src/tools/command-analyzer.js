import { checkHardBlockedCommand } from '../tools.js';
import { canonicalizeCommandPrefix } from '../patch-and-diagnostics.js';

const SHELL_COMPOUND_RE = /[;&|><`\r\n]|\$\(|@\(|<\(|>\(/;
const DOUBLE_QUOTE_SUBST_RE = /`|\$\(/;

const POWERSHELL_HARD_BLOCK_RE =
  /\b(?:invoke-expression|iex|format-volume|clear-disk|stop-computer|restart-computer|bcdedit|diskpart|cipher\s+\/w)\b|(?:^|\s)-(?:enc|encodedcommand)\b|\bremove-item\b[^\n]*-(?:recurse|r)\b[^\n]*(?:[a-z]:\\|\/|~|\$env:)/i;

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
      blockedFlags: new Set([
        '-c',
        '--exec',
        '--upload-pack',
        '--receive-pack',
        '--output',
        '-o',
      ]),
    },
  ],
  ['ls', { subcommands: null, blockedFlags: new Set() }],
  ['dir', { subcommands: null, blockedFlags: new Set() }],
  ['pwd', { subcommands: null, blockedFlags: new Set() }],
  ['echo', { subcommands: null, blockedFlags: new Set() }],
  ['cat', { subcommands: null, blockedFlags: new Set() }],
  ['type', { subcommands: null, blockedFlags: new Set() }],
  ['head', { subcommands: null, blockedFlags: new Set() }],
  ['tail', { subcommands: null, blockedFlags: new Set() }],
  ['wc', { subcommands: null, blockedFlags: new Set() }],
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
  ['get-childitem', { subcommands: null, blockedFlags: new Set() }],
  ['get-content', { subcommands: null, blockedFlags: new Set() }],
  ['get-location', { subcommands: null, blockedFlags: new Set() }],
]);

/**
 * Quote-aware shell tokenization and operator inspection across POSIX & PowerShell.
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
        cur += cmd[i + 1];
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
    if (ch === '\\' && i + 1 < cmd.length) {
      cur += cmd[i + 1];
      i++;
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

  if (POWERSHELL_HARD_BLOCK_RE.test(command)) {
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
    syntax.tokens.length
  ) {
    const head = syntax.tokens[0].split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    const rule = READONLY_ALLOWLIST.get(head);
    if (rule) {
      const rest = syntax.tokens.slice(1);
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

  return {
    hardBlocked: null,
    isReadOnly,
    commandPrefix,
    hasCompound: syntax.hasCompound || syntax.hasSubstitution,
  };
}
