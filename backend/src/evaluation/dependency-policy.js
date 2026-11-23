import { basename } from 'node:path';

export const DEPENDENCY_POLICY_MODES = Object.freeze({
  OFFLINE_ONLY: 'offline-only',
  STAGED_PINNED: 'staged-pinned',
});

export const DEFAULT_TRUSTED_REGISTRIES = Object.freeze([
  'https://registry.npmjs.org/',
]);

export const DEFAULT_DEPENDENCY_POLICY = Object.freeze({
  mode: DEPENDENCY_POLICY_MODES.OFFLINE_ONLY,
  allowNetworkInstall: false,
  allowLifecycleScripts: false,
  requirePinnedVersions: true,
  trustedRegistries: DEFAULT_TRUSTED_REGISTRIES,
  requireLockfileIntegrity: false,
});

export class DependencyPolicyError extends Error {
  constructor(message, detail = undefined) {
    super(message);
    this.name = 'DependencyPolicyError';
    this.code = 'E_DEPENDENCY_POLICY_VIOLATION';
    if (detail !== undefined) this.detail = detail;
  }
}

const EXACT_SEMVER_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const REMOTE_SPEC_RE = /^(?:https?:|git\+|git:|ssh:|github:|gitlab:|bitbucket:|file:)/i;

const DEPENDENCY_SECTIONS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
]);

const LIFECYCLE_SCRIPT_NAMES = Object.freeze([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
]);

const COMMAND_WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'exec',
  'nohup',
  'timeout',
  'nice',
  'time',
  'corepack',
]);

const SHELL_BINARIES = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'fish',
  'cmd',
  'powershell',
  'pwsh',
]);

const BLOCKED_SUBCOMMANDS = new Map([
  ['npm', new Set(['install', 'i', 'add', 'ci', 'exec', 'dlx', 'update', 'up', 'upgrade'])],
  ['yarn', new Set(['add', 'install', 'dlx'])],
  ['pnpm', new Set(['add', 'install', 'dlx'])],
  ['bun', new Set(['add', 'install', 'x'])],
  ['pip', new Set(['install'])],
  ['pip3', new Set(['install'])],
  ['cargo', new Set(['install'])],
  ['go', new Set(['install'])],
]);

const VALUE_FLAGS = new Set([
  '-c',
  '-C',
  '--cwd',
  '--prefix',
  '--registry',
  '--cache',
  '--filter',
  '-F',
  '--userconfig',
  '--globalconfig',
  '--index-url',
  '-i',
  '--extra-index-url',
  '--manifest-path',
  '--target',
  '--root',
]);

const PIPE_TO_SHELL_RE =
  /\b(?:curl|wget)\b[^|\r\n]*\|\s*(?:\/\S+\/)?(?:sh|bash|zsh|dash|ksh|ash|fish|pwsh|powershell|node|python3?|perl|ruby)\b/i;

function normalizeRegistryEntry(rawUrl) {
  const input = String(rawUrl ?? '').trim();
  if (!input) {
    throw new DependencyPolicyError('Registry URL must be a non-empty string', { rawUrl });
  }
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new DependencyPolicyError(`Invalid registry URL: ${input}`, { rawUrl });
  }
  if (parsed.protocol !== 'https:') {
    throw new DependencyPolicyError(`Registry URL must use HTTPS: ${input}`, {
      rawUrl,
      protocol: parsed.protocol,
    });
  }
  if (parsed.username || parsed.password) {
    throw new DependencyPolicyError(`Registry URL must not embed credentials: ${input}`, {
      rawUrl,
    });
  }
  if (parsed.search || parsed.hash) {
    throw new DependencyPolicyError(
      `Registry URL must not contain query parameters or fragments: ${input}`,
      { rawUrl },
    );
  }
  const path = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  return `${parsed.origin}${path}`;
}

/**
 * Validates that a registry URL is HTTPS-only, free of embedded credentials,
 * and matches a normalized origin+path in `policy.trustedRegistries`.
 */
export function validateRegistryUrl(rawUrl, policy = DEFAULT_DEPENDENCY_POLICY) {
  const normalized = normalizeRegistryEntry(rawUrl);
  const list = Array.isArray(policy?.trustedRegistries)
    ? policy.trustedRegistries
    : DEFAULT_TRUSTED_REGISTRIES;
  const trustedSet = new Set(list.map((entry) => normalizeRegistryEntry(entry)));
  if (!trustedSet.has(normalized)) {
    throw new DependencyPolicyError(`Untrusted registry URL: ${normalized}`, {
      rawUrl,
      normalized,
      trustedRegistries: [...trustedSet],
    });
  }
  return normalized;
}

/**
 * Returns true strictly for exact pinned semver strings (e.g. `1.2.3`, `1.2.3-rc.1+build.5`).
 */
export function isPinnedSemver(spec) {
  if (typeof spec !== 'string') return false;
  return EXACT_SEMVER_RE.test(spec);
}

/**
 * Validates and normalizes a dependency policy configuration object.
 */
export function validateDependencyPolicy(policy = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new DependencyPolicyError('Dependency policy must be a plain object');
  }
  const mode = policy.mode ?? DEFAULT_DEPENDENCY_POLICY.mode;
  if (!Object.values(DEPENDENCY_POLICY_MODES).includes(mode)) {
    throw new DependencyPolicyError(`Unsupported dependency policy mode: ${String(mode)}`, {
      mode,
    });
  }

  const allowNetworkInstall =
    policy.allowNetworkInstall ?? DEFAULT_DEPENDENCY_POLICY.allowNetworkInstall;
  const allowLifecycleScripts =
    policy.allowLifecycleScripts ?? DEFAULT_DEPENDENCY_POLICY.allowLifecycleScripts;
  const requirePinnedVersions =
    policy.requirePinnedVersions ?? DEFAULT_DEPENDENCY_POLICY.requirePinnedVersions;
  const requireLockfileIntegrity =
    policy.requireLockfileIntegrity ?? DEFAULT_DEPENDENCY_POLICY.requireLockfileIntegrity;

  for (const [key, value] of [
    ['allowNetworkInstall', allowNetworkInstall],
    ['allowLifecycleScripts', allowLifecycleScripts],
    ['requirePinnedVersions', requirePinnedVersions],
    ['requireLockfileIntegrity', requireLockfileIntegrity],
  ]) {
    if (typeof value !== 'boolean') {
      throw new DependencyPolicyError(`Dependency policy field "${key}" must be a boolean`, {
        field: key,
        value,
      });
    }
  }

  if (mode === DEPENDENCY_POLICY_MODES.OFFLINE_ONLY && allowNetworkInstall) {
    throw new DependencyPolicyError(
      'Dependency policy mode "offline-only" cannot enable allowNetworkInstall',
      { mode, allowNetworkInstall },
    );
  }

  const rawRegistries = policy.trustedRegistries ?? DEFAULT_TRUSTED_REGISTRIES;
  if (!Array.isArray(rawRegistries)) {
    throw new DependencyPolicyError('trustedRegistries must be an array of HTTPS URLs');
  }
  const normalizedRegistries = Object.freeze(
    [...new Set(rawRegistries.map((entry) => normalizeRegistryEntry(entry)))],
  );

  return Object.freeze({
    mode,
    allowNetworkInstall,
    allowLifecycleScripts,
    requirePinnedVersions,
    trustedRegistries: normalizedRegistries,
    requireLockfileIntegrity,
  });
}

function collectSectionSpecs(sectionName, obj, prefix = '') {
  const entries = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return entries;
  for (const [key, val] of Object.entries(obj)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (sectionName === 'overrides' && val && typeof val === 'object' && !Array.isArray(val)) {
      entries.push(...collectSectionSpecs(sectionName, val, label));
    } else {
      entries.push({ section: sectionName, name: label, spec: val });
    }
  }
  return entries;
}

/**
 * Validates dependency version pinning and lifecycle scripts inside a parsed package.json object.
 */
export function validatePackageDependencies(packageJson, policy = DEFAULT_DEPENDENCY_POLICY) {
  const effective = validateDependencyPolicy(policy);
  let pkg = packageJson;
  if (typeof pkg === 'string') {
    try {
      pkg = JSON.parse(pkg);
    } catch (err) {
      throw new DependencyPolicyError('Invalid package.json JSON string', {
        cause: err?.message,
      });
    }
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new DependencyPolicyError('packageJson must be a plain object');
  }

  const violations = [];
  let dependencyCount = 0;

  for (const section of DEPENDENCY_SECTIONS) {
    const sectionObj = pkg[section];
    if (sectionObj === undefined || sectionObj === null) continue;
    if (typeof sectionObj !== 'object' || Array.isArray(sectionObj)) {
      violations.push({
        type: 'invalid_dependency_section',
        section,
        name: section,
        spec: String(sectionObj),
        message: `Section "${section}" must be an object`,
      });
      continue;
    }

    for (const { name, spec } of collectSectionSpecs(section, sectionObj)) {
      dependencyCount++;
      if (typeof spec !== 'string') {
        violations.push({
          type: 'unpinned_dependency',
          section,
          name,
          spec: String(spec),
          message: `Dependency "${name}" in "${section}" must be a pinned semver string`,
        });
        continue;
      }
      if (effective.requirePinnedVersions && !isPinnedSemver(spec)) {
        violations.push({
          type: 'unpinned_dependency',
          section,
          name,
          spec,
          message: `Dependency "${name}" in "${section}" has unpinned or remote spec "${spec}"`,
        });
      } else if (!effective.allowNetworkInstall && REMOTE_SPEC_RE.test(spec.trim())) {
        violations.push({
          type: 'remote_dependency_disallowed',
          section,
          name,
          spec,
          message: `Remote dependency "${name}" in "${section}" ("${spec}") is disallowed offline`,
        });
      }
    }
  }

  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const presentLifecycle = LIFECYCLE_SCRIPT_NAMES.filter(
    (name) => typeof scripts[name] === 'string' && scripts[name].trim().length > 0,
  );
  const hasLifecycleScripts = presentLifecycle.length > 0;

  if (hasLifecycleScripts && !effective.allowLifecycleScripts) {
    for (const scriptName of presentLifecycle) {
      violations.push({
        type: 'lifecycle_script_disallowed',
        section: 'scripts',
        name: scriptName,
        command: scripts[scriptName],
        message: `Lifecycle script "${scriptName}" is disallowed by dependency policy`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    dependencyCount,
    hasLifecycleScripts,
  };
}

function normalizeBinaryName(raw) {
  const base = basename(String(raw ?? '').trim());
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

function tokenizeSimpleShellSegments(command) {
  const segments = [];
  let current = [];
  let token = '';
  let inSingle = false;
  let inDouble = false;

  const flushToken = () => {
    if (token.length > 0) {
      current.push(token);
      token = '';
    }
  };
  const flushSegment = () => {
    flushToken();
    if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else token += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < command.length) {
        token += command[++i];
      } else if (ch === '"') {
        inDouble = false;
      } else {
        token += ch;
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
    if (ch === ';' || ch === '\n' || ch === '\r' || ch === '|') {
      flushSegment();
      if (ch === '|' && command[i + 1] === '|') i++;
      continue;
    }
    if (ch === '&') {
      flushSegment();
      if (command[i + 1] === '&') i++;
      continue;
    }
    if (/\s/.test(ch)) {
      flushToken();
      continue;
    }
    token += ch;
  }
  flushSegment();
  return segments;
}

function checkRegistryFlags(tokens, policy) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('--registry=')) {
      validateRegistryUrl(tok.slice('--registry='.length), policy);
    } else if (tok === '--registry' && i + 1 < tokens.length) {
      validateRegistryUrl(tokens[++i], policy);
    }
  }
}

function inspectTokenSegment(tokens, policy) {
  if (!tokens.length) return;
  let idx = 0;
  while (idx < tokens.length) {
    const candidate = tokens[idx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(candidate)) {
      idx++;
      continue;
    }
    const norm = normalizeBinaryName(candidate);
    if (COMMAND_WRAPPERS.has(norm)) {
      idx++;
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        idx++;
      }
      continue;
    }
    break;
  }
  if (idx >= tokens.length) return;

  const bin = normalizeBinaryName(tokens[idx]);
  const rest = tokens.slice(idx + 1);

  if (SHELL_BINARIES.has(bin)) {
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i].toLowerCase();
      if ((arg === '-c' || arg === '/c' || arg === '-command') && i + 1 < rest.length) {
        assertCommandAllowedByDependencyPolicy(rest[i + 1], policy);
      }
    }
    return;
  }

  if (bin === 'npx' || bin === 'bunx') {
    throw new DependencyPolicyError(
      `Command "${bin}" is blocked by dependency policy (${policy.mode})`,
      { command: tokens.join(' '), binary: bin, mode: policy.mode },
    );
  }

  if (bin === 'python' || bin === 'python3' || bin === 'py') {
    for (let i = 0; i < rest.length - 1; i++) {
      if (rest[i] === '-m' && normalizeBinaryName(rest[i + 1]) === 'pip') {
        inspectTokenSegment(['pip', ...rest.slice(i + 2)], policy);
        return;
      }
    }
    return;
  }

  const blockedSubs = BLOCKED_SUBCOMMANDS.get(bin);
  if (!blockedSubs) return;

  checkRegistryFlags(rest, policy);

  let subcommand = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--') break;
    if (arg.startsWith('-')) {
      const flagKey = arg.split('=')[0];
      if (!arg.includes('=') && VALUE_FLAGS.has(flagKey) && i + 1 < rest.length) {
        i++;
      }
      continue;
    }
    subcommand = arg.toLowerCase();
    break;
  }

  if (!subcommand || !blockedSubs.has(subcommand)) return;

  const isOfflineMode = policy.mode === DEPENDENCY_POLICY_MODES.OFFLINE_ONLY;
  if (isOfflineMode || !policy.allowNetworkInstall) {
    throw new DependencyPolicyError(
      `Package install/exec command "${bin} ${subcommand}" is blocked by dependency policy (${policy.mode})`,
      { command: tokens.join(' '), binary: bin, subcommand, mode: policy.mode },
    );
  }

  if (!policy.allowLifecycleScripts) {
    const hasIgnoreScripts = rest.some((t) => t === '--ignore-scripts');
    const enablesScripts = rest.some(
      (t) => t === '--foreground-scripts' || t === '--ignore-scripts=false',
    );
    if (enablesScripts || ((bin === 'npm' || bin === 'pnpm' || bin === 'yarn') && !hasIgnoreScripts)) {
      throw new DependencyPolicyError(
        `Command "${bin} ${subcommand}" requires --ignore-scripts under dependency policy`,
        { command: tokens.join(' '), binary: bin, subcommand },
      );
    }
  }
}

/**
 * Asserts that a command string or argv array does not violate the active dependency policy.
 */
export function assertCommandAllowedByDependencyPolicy(
  commandOrArgv,
  policy = DEFAULT_DEPENDENCY_POLICY,
) {
  const effective = validateDependencyPolicy(policy);

  if (Array.isArray(commandOrArgv)) {
    const argv = commandOrArgv.map((item) => String(item ?? ''));
    if (argv.length === 0) return { allowed: true };
    const joined = argv.join(' ');
    if (PIPE_TO_SHELL_RE.test(joined)) {
      throw new DependencyPolicyError(
        'Piping remote download output (curl/wget) into a shell/interpreter is blocked',
        { command: joined },
      );
    }
    inspectTokenSegment(argv, effective);
    return { allowed: true };
  }

  if (typeof commandOrArgv !== 'string') {
    throw new DependencyPolicyError('commandOrArgv must be a string or string array');
  }

  const raw = commandOrArgv.trim();
  if (!raw) return { allowed: true };

  if (PIPE_TO_SHELL_RE.test(raw)) {
    throw new DependencyPolicyError(
      'Piping remote download output (curl/wget) into a shell/interpreter is blocked',
      { command: raw },
    );
  }

  for (const segment of tokenizeSimpleShellSegments(raw)) {
    inspectTokenSegment(segment, effective);
  }
  return { allowed: true };
}

/**
 * Builds hardened npm CLI arguments consistent with the dependency policy.
 */
export function buildSafeInstallArgs(policy = DEFAULT_DEPENDENCY_POLICY) {
  const effective = validateDependencyPolicy(policy);
  const args = [];
  if (
    effective.mode === DEPENDENCY_POLICY_MODES.OFFLINE_ONLY ||
    !effective.allowNetworkInstall
  ) {
    args.push('--offline');
  }
  if (!effective.allowLifecycleScripts) {
    args.push('--ignore-scripts');
  }
  args.push('--no-audit', '--no-fund');
  if (effective.allowNetworkInstall && effective.trustedRegistries.length > 0) {
    const trusted = validateRegistryUrl(effective.trustedRegistries[0], effective);
    args.push(`--registry=${trusted}`);
  }
  return args;
}

/**
 * Controlled dependency preparation & verification stage.
 * Validates exact pinned versions, trusted HTTPS registries, and lockfile presence,
 * and stages/verifies offline installation args without leaking host tokens or enabling
 * lifecycle scripts. During benchmark test execution, network remains disabled.
 */
export function prepareDependencies({
  packageJson,
  lockfilePresent = false,
  cacheDir = null,
  policy = DEFAULT_DEPENDENCY_POLICY,
} = {}) {
  const effective = validateDependencyPolicy(policy);
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    throw new DependencyPolicyError('prepareDependencies requires parsed package.json object');
  }
  const depValidation = validatePackageDependencies(packageJson, effective);
  if (!depValidation.ok) {
    throw new DependencyPolicyError(
      depValidation.violations.map((v) => v.message).join('; '),
      { violations: depValidation.violations },
    );
  }
  if (effective.requireLockfileIntegrity && depValidation.dependencyCount > 0 && !lockfilePresent) {
    throw new DependencyPolicyError(
      'Lockfile is required under requireLockfileIntegrity policy when dependencies are present',
      { dependencyCount: depValidation.dependencyCount },
    );
  }
  const installArgs = buildSafeInstallArgs(effective);
  if (cacheDir) {
    installArgs.push(`--cache=${String(cacheDir)}`);
  }
  return {
    ok: true,
    mode: effective.mode,
    networkRequired: effective.allowNetworkInstall && depValidation.dependencyCount > 0,
    dependencyCount: depValidation.dependencyCount,
    trustedRegistries: [...effective.trustedRegistries],
    installArgs,
    postInstallNetworkEnabled: false,
  };
}
