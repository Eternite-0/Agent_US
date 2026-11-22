import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { opendir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { redactSecrets, sanitize } from './envelope.js';
import {
  PROTECTED_BASENAMES,
  normalizeProtectedSegment,
  sanitizeChildEnv,
} from './tools/sandbox.js';

const execFileAsync = promisify(execFile);

const PROTECTED_ROOTS = ['../../upstream/', '../var/'].map((rel) =>
  resolve(fileURLToPath(new URL(rel, import.meta.url))),
);

const ALWAYS_SKIP_DIRS = new Set([
  '.git',
  '.agent-us',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'upstream',
  'var',
  '.turbo',
  '.parcel-cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'out',
]);

const SENSITIVE_FILE_EXT_RE = /\.(?:pem|key|pfx|p12|crt|der|sqlite(?:3)?|sqlite-wal|sqlite-shm)$/i;
const SENSITIVE_BASENAMES = new Set(['.npmrc', '.pypirc', '.netrc', 'id_rsa', 'id_ed25519']);

const CODE_EXTENSIONS = new Map([
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.jsx', 'javascript'],
  ['.ts', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.py', 'python'],
  ['.pyw', 'python'],
  ['.rs', 'rust'],
  ['.go', 'go'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.rb', 'ruby'],
  ['.php', 'php'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cpp', 'cpp'],
  ['.cc', 'cpp'],
  ['.hpp', 'cpp'],
  ['.cs', 'csharp'],
  ['.svelte', 'svelte'],
  ['.vue', 'vue'],
]);

const JS_TS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'where', 'what',
  'which', 'have', 'has', 'been', 'will', 'would', 'should', 'could', 'about', 'after',
  'before', 'between', 'under', 'over', 'some', 'more', 'most', 'only', 'also', 'such',
  'than', 'then', 'them', 'they', 'their', 'there', 'here', 'each', 'other', 'does',
  'make', 'made', 'need', 'needs', 'file', 'files', 'code', 'issue', 'bug', 'fix',
  'add', 'update', 'change', 'modify', 'check', 'run', 'using', 'used', 'use', 'work',
  'works', 'working', 'error', 'fail', 'failing', 'failed', 'support', 'new', 'existing',
]);

const MAX_READ_BYTES_PER_FILE = 128 * 1024;
const DEFAULT_MAX_BYTES = 12000;
const DEFAULT_MAX_FILES = 120;
const DEFAULT_SUMMARY_MAX_BYTES = 8000;

function toPosix(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

function isOutsideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../');
}

function assertSafeWorkspaceRoot(workspaceRoot) {
  const abs = resolve(String(workspaceRoot || '.'));
  if (PROTECTED_ROOTS.some((pr) => !isOutsideRoot(pr, abs))) {
    throw new Error(`Access to protected directory is prohibited: ${abs}`);
  }
  if (!existsSync(abs)) {
    throw new Error(`Workspace root does not exist: ${abs}`);
  }
  const st = statSync(abs);
  if (!st.isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${abs}`);
  }
  const real = realpathSync(abs);
  if (PROTECTED_ROOTS.some((pr) => !isOutsideRoot(pr, real))) {
    throw new Error(`Access to protected directory is prohibited: ${real}`);
  }
  return { absRoot: abs, realRoot: real };
}

function isSecretFileName(name) {
  const raw = String(name ?? '');
  const norm = normalizeProtectedSegment(raw);
  if (!norm) return true;
  if (norm === '.git' || PROTECTED_BASENAMES.has(norm) || SENSITIVE_BASENAMES.has(norm)) {
    return true;
  }
  if (/^\.env(?:$|[._-])/i.test(norm)) return true;
  if (SENSITIVE_FILE_EXT_RE.test(norm)) return true;
  return false;
}

function isAlwaysSkippedDir(name) {
  const norm = normalizeProtectedSegment(name);
  return ALWAYS_SKIP_DIRS.has(norm) || PROTECTED_BASENAMES.has(norm) || /^\.env(?:$|[._-])/i.test(norm);
}

function isProbablyBinary(buf) {
  const len = Math.min(buf.length, 4096);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function utf8Truncate(text, maxBytes) {
  const str = String(text ?? '');
  const limit = Math.max(0, Math.trunc(Number(maxBytes) || 0));
  if (limit === 0) return '';
  if (Buffer.byteLength(str, 'utf8') <= limit) return str;

  // Binary search UTF-16 index whose UTF-8 byte length <= limit
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(str.slice(0, mid), 'utf8') <= limit) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  // Avoid splitting surrogate pairs
  if (lo > 0) {
    const code = str.charCodeAt(lo - 1);
    if (code >= 0xd800 && code <= 0xdbff) lo -= 1;
  }
  return str.slice(0, lo);
}

// ---- .gitignore Support ----

function globPatternToRegex(pattern, { anchored }) {
  let i = 0;
  let rx = anchored ? '^' : '(?:^|/)';
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          rx += '(?:.*/)?';
          i += 3;
          continue;
        }
        rx += '.*';
        i += 2;
        continue;
      }
      rx += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      rx += '[^/]';
      i += 1;
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end !== -1) {
        let cls = pattern.slice(i + 1, end);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        rx += `[${cls}]`;
        i = end + 1;
      } else {
        rx += '\\[';
        i += 1;
      }
    } else if ('^$+?.()|{}'.includes(ch)) {
      rx += `\\${ch}`;
      i += 1;
    } else {
      rx += ch;
      i += 1;
    }
  }
  rx += '(?:/.*)?$';
  return new RegExp(rx);
}

function parseGitignoreContent(content, baseRel = '') {
  const rules = [];
  const lines = String(content ?? '').split(/\r?\n/);
  for (let rawLine of lines) {
    // Strip unescaped trailing whitespace
    rawLine = rawLine.replace(/(?<!\\)[ \t]+$/, '');
    if (!rawLine || (rawLine.startsWith('#') && !rawLine.startsWith('\\#'))) continue;

    let negated = false;
    if (rawLine.startsWith('!')) {
      negated = true;
      rawLine = rawLine.slice(1);
    } else if (rawLine.startsWith('\\!') || rawLine.startsWith('\\#')) {
      rawLine = rawLine.slice(1);
    }
    if (!rawLine) continue;

    let dirOnly = false;
    if (rawLine.endsWith('/')) {
      dirOnly = true;
      rawLine = rawLine.replace(/\/+$/, '');
    }
    if (!rawLine) continue;

    let anchored = false;
    if (rawLine.startsWith('/')) {
      anchored = true;
      rawLine = rawLine.replace(/^\/+/, '');
    } else if (rawLine.includes('/')) {
      anchored = true;
    }
    if (!rawLine) continue;

    try {
      const regex = globPatternToRegex(rawLine, { anchored });
      rules.push({ baseRel, negated, dirOnly, anchored, regex });
    } catch {
      // Skip malformed ignore line
    }
  }
  return rules;
}

function isIgnoredByRules(relPath, isDir, rules) {
  let ignored = false;
  for (const rule of rules) {
    let subRel = relPath;
    if (rule.baseRel) {
      if (relPath === rule.baseRel) continue;
      if (!relPath.startsWith(`${rule.baseRel}/`)) continue;
      subRel = relPath.slice(rule.baseRel.length + 1);
    }
    if (rule.dirOnly && !isDir) continue;
    const target = rule.anchored ? subRel : basename(subRel);
    if (rule.regex.test(subRel) || (!rule.anchored && rule.regex.test(target))) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

// ---- Bounded Repository Scanner ----

function buildTreeLines(files, dirs, maxLines = 80) {
  const rootNode = { dirs: new Map(), files: [] };

  const ensureDir = (parts) => {
    let node = rootNode;
    for (const part of parts) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    return node;
  };

  for (const d of dirs) {
    ensureDir(d.split('/').filter(Boolean));
  }
  for (const f of files) {
    const parts = f.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;
    ensureDir(parts).files.push(fileName);
  }

  const lines = [];
  const walkNode = (node, depth) => {
    const indent = '  '.repeat(depth);
    const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
    for (const dirName of dirNames) {
      if (lines.length >= maxLines) return;
      lines.push(`${indent}${dirName}/`);
      walkNode(node.dirs.get(dirName), depth + 1);
    }
    const fileNames = [...node.files].sort((a, b) => a.localeCompare(b));
    for (const fileName of fileNames) {
      if (lines.length >= maxLines) return;
      lines.push(`${indent}${fileName}`);
    }
  };
  walkNode(rootNode, 0);
  if (lines.length >= maxLines) {
    lines[maxLines - 1] = '... (tree truncated)';
  }
  return lines;
}

async function scanWorkspace(realRoot, { maxFiles }) {
  const files = [];
  const allDirs = [];
  const topLevelDirs = [];
  const rulesByDir = new Map([['', []]]);
  const queue = [{ dir: realRoot, rel: '', depth: 0 }];
  const maxDirs = Math.max(250, maxFiles * 4);
  let visitedDirs = 0;

  while (queue.length > 0 && files.length < maxFiles && visitedDirs < maxDirs) {
    const current = queue.shift();
    visitedDirs += 1;

    let canonicalDir;
    try {
      canonicalDir = await realpath(current.dir);
    } catch {
      continue;
    }
    if (isOutsideRoot(realRoot, canonicalDir) || canonicalDir !== current.dir) continue;

    let entries;
    try {
      const dirHandle = await opendir(canonicalDir);
      entries = [];
      for await (const ent of dirHandle) {
        entries.push(ent);
      }
    } catch {
      continue;
    }

    // Inherit parent gitignore rules + local .gitignore
    const parentRules = rulesByDir.get(current.rel) ?? [];
    let localRules = parentRules;
    const hasGitignore = entries.some(
      (e) => e.name === '.gitignore' && e.isFile() && !e.isSymbolicLink(),
    );
    if (hasGitignore) {
      try {
        const giFull = join(canonicalDir, '.gitignore');
        const giLstat = lstatSync(giFull);
        if (!giLstat.isSymbolicLink() && giLstat.size <= 128 * 1024) {
          const giText = await readFile(giFull, 'utf8');
          const parsed = parseGitignoreContent(giText, current.rel);
          if (parsed.length) localRules = [...parentRules, ...parsed];
        }
      } catch {
        // Ignore unreadable .gitignore
      }
    }

    const MANIFEST_NAMES = new Set([
      'package.json',
      'pyproject.toml',
      'requirements.txt',
      'requirements-dev.txt',
      'dev-requirements.txt',
      'Cargo.toml',
      'go.mod',
      'tsconfig.json',
      'pnpm-workspace.yaml',
    ]);
    entries.sort((a, b) => {
      const am = MANIFEST_NAMES.has(a.name) ? 0 : 1;
      const bm = MANIFEST_NAMES.has(b.name) ? 0 : 1;
      return am - bm || a.name.localeCompare(b.name);
    });

    const childDirs = [];
    const childFiles = [];

    for (const ent of entries) {
      const name = ent.name;
      if (!name || /[\u0000-\u001f\u007f]/u.test(name)) continue;
      if (ent.isSymbolicLink()) continue;

      const rel = current.rel ? `${current.rel}/${name}` : name;
      const full = join(canonicalDir, name);

      if (ent.isDirectory()) {
        if (isAlwaysSkippedDir(name)) continue;
        if (isIgnoredByRules(rel, true, localRules)) continue;
        // Double-check symlink/junction via lstat
        try {
          if (lstatSync(full).isSymbolicLink()) continue;
        } catch {
          continue;
        }
        childDirs.push({ dir: full, rel, name, depth: current.depth + 1 });
      } else if (ent.isFile()) {
        if (isSecretFileName(name)) continue;
        if (name === '.gitignore') continue;
        if (isIgnoredByRules(rel, false, localRules)) continue;
        childFiles.push({ full, rel, name });
      }
    }

    for (const f of childFiles) {
      if (files.length >= maxFiles) break;
      files.push(f);
    }

    for (const d of childDirs) {
      if (current.depth === 0) topLevelDirs.push(d.name);
      allDirs.push(d.rel);
      rulesByDir.set(d.rel, localRules);
      if (queue.length + visitedDirs < maxDirs) {
        queue.push({ dir: d.dir, rel: d.rel, depth: d.depth });
      }
    }
  }

  return {
    files,
    topLevelDirs: topLevelDirs.sort((a, b) => a.localeCompare(b)),
    allDirs,
  };
}

// ---- Git Metadata ----

async function runGit(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    timeout: 4000,
    env: sanitizeChildEnv(process.env),
  });
  return stdout.trim();
}

async function collectGitMetadata(realRoot) {
  const fallback = {
    isGitRepo: false,
    branch: null,
    headSha: null,
    dirty: false,
    recentCommits: [],
  };

  try {
    const inside = await runGit(realRoot, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') return fallback;
  } catch {
    return fallback;
  }

  const [branchRes, headRes, statusRes, logRes] = await Promise.allSettled([
    runGit(realRoot, ['symbolic-ref', '--short', 'HEAD']).catch(() =>
      runGit(realRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ),
    runGit(realRoot, ['rev-parse', 'HEAD']),
    runGit(realRoot, ['status', '--porcelain']),
    runGit(realRoot, ['log', '-n', '8', '--pretty=format:%s']),
  ]);

  const branch =
    branchRes.status === 'fulfilled' && branchRes.value ? branchRes.value : null;
  const headSha =
    headRes.status === 'fulfilled' && headRes.value ? headRes.value : null;
  const dirty =
    statusRes.status === 'fulfilled' ? Boolean(statusRes.value) : false;
  const recentCommits =
    logRes.status === 'fulfilled' && logRes.value
      ? logRes.value
          .split(/\r?\n/)
          .map((line) => sanitize(redactSecrets(line.trim())))
          .filter(Boolean)
          .slice(0, 8)
      : [];

  return {
    isGitRepo: true,
    branch,
    headSha,
    dirty,
    recentCommits,
  };
}

// ---- Manifest & Project Inference ----

function stripTomlComments(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => {
      let inSingle = false;
      let inDouble = false;
      let escaped = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inDouble) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inDouble = false;
        } else if (inSingle) {
          if (ch === "'") inSingle = false;
        } else if (ch === '"') {
          inDouble = true;
        } else if (ch === "'") {
          inSingle = true;
        } else if (ch === '#') {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

function normalizeDepName(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .split(/[\s[<>=!~;@]/)[0]
    .trim();
  return cleaned || null;
}

function parsePyprojectToml(rawText) {
  const text = stripTomlComments(rawText);
  const result = {
    name: null,
    dependencies: [],
    devDependencies: [],
    hasPoetry: false,
    hasUv: false,
    hasPytest: false,
    hasRuff: false,
    hasMypy: false,
    hasBuildSystem: false,
  };

  let section = '';
  let collectingArrayKey = null;
  let arrayBuf = '';

  const flushArray = () => {
    if (!collectingArrayKey) return;
    const items = [...arrayBuf.matchAll(/['"]([^'"]+)['"]/g)].map((m) => normalizeDepName(m[1])).filter(Boolean);
    if (collectingArrayKey === 'project.dependencies') {
      result.dependencies.push(...items);
    } else if (collectingArrayKey === 'optional-dev') {
      result.devDependencies.push(...items);
    }
    collectingArrayKey = null;
    arrayBuf = '';
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (collectingArrayKey) {
      arrayBuf += `\n${trimmed}`;
      if (trimmed.includes(']')) flushArray();
      continue;
    }

    const secMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (secMatch) {
      section = secMatch[1].trim().toLowerCase();
      if (section.startsWith('tool.poetry')) result.hasPoetry = true;
      if (section.startsWith('tool.uv')) result.hasUv = true;
      if (section.startsWith('tool.pytest')) result.hasPytest = true;
      if (section.startsWith('tool.ruff')) result.hasRuff = true;
      if (section.startsWith('tool.mypy')) result.hasMypy = true;
      if (section === 'build-system') result.hasBuildSystem = true;
      continue;
    }

    const kvMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!kvMatch) continue;
    const key = kvMatch[1].trim();
    const val = kvMatch[2].trim();

    if ((section === 'project' || section === 'tool.poetry') && key === 'name' && !result.name) {
      const m = /^['"]([^'"]+)['"]/.exec(val);
      if (m) result.name = m[1].trim();
    } else if (section === 'project' && key === 'dependencies') {
      if (val.startsWith('[')) {
        if (val.includes(']')) {
          const items = [...val.matchAll(/['"]([^'"]+)['"]/g)].map((m) => normalizeDepName(m[1])).filter(Boolean);
          result.dependencies.push(...items);
        } else {
          collectingArrayKey = 'project.dependencies';
          arrayBuf = val;
        }
      }
    } else if (section === 'project.optional-dependencies') {
      const targetList = /^(?:dev|test|tests|lint|typing)$/i.test(key) ? result.devDependencies : result.dependencies;
      if (val.startsWith('[')) {
        if (val.includes(']')) {
          const items = [...val.matchAll(/['"]([^'"]+)['"]/g)].map((m) => normalizeDepName(m[1])).filter(Boolean);
          targetList.push(...items);
        } else {
          collectingArrayKey = 'optional-dev';
          arrayBuf = val;
        }
      }
    } else if (section === 'tool.poetry.dependencies' && key.toLowerCase() !== 'python') {
      result.dependencies.push(key);
    } else if (section === 'tool.poetry.dev-dependencies' || /^tool\.poetry\.group\.(?:dev|test)\.dependencies$/.test(section)) {
      result.devDependencies.push(key);
    }
  }
  flushArray();
  return result;
}

function parseRequirementsTxt(rawText) {
  const deps = [];
  for (const rawLine of String(rawText ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const dep = normalizeDepName(line);
    if (dep) deps.push(dep);
  }
  return deps;
}

function parseCargoToml(rawText) {
  const text = stripTomlComments(rawText);
  const result = { name: null, dependencies: [], devDependencies: [] };
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const secMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (secMatch) {
      section = secMatch[1].trim().toLowerCase();
      continue;
    }
    const kvMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!kvMatch) continue;
    const key = kvMatch[1].trim();
    const val = kvMatch[2].trim();
    if (section === 'package' && key === 'name' && !result.name) {
      const m = /^['"]([^'"]+)['"]/.exec(val);
      if (m) result.name = m[1].trim();
    } else if (section === 'dependencies') {
      result.dependencies.push(key);
    } else if (section === 'dev-dependencies') {
      result.devDependencies.push(key);
    }
  }
  return result;
}

function parseGoMod(rawText) {
  let moduleName = null;
  const dependencies = [];
  let inRequireBlock = false;
  for (const rawLine of String(rawText ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const modMatch = /^module\s+(\S+)/.exec(line);
    if (modMatch) {
      moduleName = modMatch[1].trim();
      continue;
    }
    if (/^require\s*\($/.test(line)) {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock) {
      if (line === ')') {
        inRequireBlock = false;
        continue;
      }
      const pkg = line.split(/\s+/)[0];
      if (pkg) dependencies.push(pkg);
      continue;
    }
    const singleReq = /^require\s+(\S+)/.exec(line);
    if (singleReq) {
      dependencies.push(singleReq[1]);
    }
  }
  return { moduleName, dependencies };
}

function extractPackageJsonExports(exportsField, pkgDirRel, out = []) {
  if (!exportsField) return out;
  if (typeof exportsField === 'string') {
    const norm = posix.normalize(pkgDirRel ? posix.join(pkgDirRel, exportsField) : exportsField);
    if (!norm.includes('*') && !norm.startsWith('..')) out.push(norm.replace(/^\.\//, ''));
    return out;
  }
  if (typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    for (const val of Object.values(exportsField)) {
      extractPackageJsonExports(val, pkgDirRel, out);
    }
  }
  return out;
}

function resolveWorkspacePatterns(realRoot, patterns, existingFileSet) {
  const discovered = [];
  for (const rawPat of patterns) {
    const pat = toPosix(String(rawPat ?? '')).replace(/^\/+|\/+$/g, '');
    if (!pat || pat.startsWith('!')) continue;
    const rxText = pat
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*\\\*/g, '.*')
      .replace(/\\\*/g, '[^/]+');
    const rx = new RegExp(`^${rxText}/package\\.json$`);
    for (const f of existingFileSet) {
      if (rx.test(f)) discovered.push(f);
    }
    // Also probe exact directory directly in case maxFiles cut off deep workspace manifests
    if (!pat.includes('*')) {
      const relPkg = `${pat}/package.json`;
      if (!existingFileSet.has(relPkg) && existsSync(join(realRoot, relPkg))) {
        discovered.push(relPkg);
      }
    }
  }
  return [...new Set(discovered)];
}

async function safeReadUtf8(fullPath, maxBytes = MAX_READ_BYTES_PER_FILE) {
  try {
    const lst = lstatSync(fullPath);
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
    const st = await stat(fullPath);
    if (st.size > maxBytes * 4) {
      // Read bounded slice for oversized files
      const buf = await readFile(fullPath);
      if (isProbablyBinary(buf)) return null;
      return buf.subarray(0, maxBytes).toString('utf8');
    }
    const buf = await readFile(fullPath);
    if (isProbablyBinary(buf)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function classifyPackageScripts(scripts, pm, { prefixDir = '' } = {}) {
  const testCommands = [];
  const buildCommands = [];
  const lintCommands = [];
  const runPrefix = pm === 'yarn' ? 'yarn' : pm === 'pnpm' ? 'pnpm run' : pm === 'bun' ? 'bun run' : `${pm || 'npm'} run`;
  const testRun = pm === 'yarn' ? 'yarn test' : pm === 'pnpm' ? 'pnpm test' : pm === 'bun' ? 'bun test' : `${pm || 'npm'} test`;
  const wrapDir = (cmd) => (prefixDir ? `cd ${prefixDir} && ${cmd}` : cmd);

  for (const [name, body] of Object.entries(scripts ?? {})) {
    const bodyStr = String(body ?? '').trim();
    if (!bodyStr || /no test specified/i.test(bodyStr)) continue;

    if (name === 'test' || /^test(?::|$)/i.test(name) || /^(?:e2e|spec)$/i.test(name)) {
      const cmd = name === 'test' ? testRun : `${runPrefix} ${name}`;
      testCommands.push(wrapDir(cmd));
      if (name === 'test' && /^node\s+--test\b/.test(bodyStr)) {
        testCommands.push(wrapDir(bodyStr));
      }
    } else if (/^(?:build|compile|bundle|typecheck|tsc)(?::|$)/i.test(name)) {
      buildCommands.push(wrapDir(`${runPrefix} ${name}`));
    } else if (/^(?:lint|format|fmt|prettier|eslint|biome)(?::|$)/i.test(name)) {
      lintCommands.push(wrapDir(`${runPrefix} ${name}`));
    } else if (/^check(?::|$)/i.test(name)) {
      if (/\btsc\b|\bbuild\b/.test(bodyStr)) {
        buildCommands.push(wrapDir(`${runPrefix} ${name}`));
      }
      if (/\beslint\b|\bprettier\b|\bbiome\b|\blint\b|check\.js/.test(bodyStr)) {
        lintCommands.push(wrapDir(`${runPrefix} ${name}`));
      }
    }
  }

  return { testCommands, buildCommands, lintCommands };
}

async function analyzeProjectManifests(realRoot, files, { sourceFiles, testFiles }) {
  const fileSet = new Set(files.map((f) => f.rel));
  const manifests = [];
  const scripts = {};
  const testCommands = [];
  const buildCommands = [];
  const lintCommands = [];
  const depSet = new Set();
  const devDepSet = new Set();
  const declaredEntries = [];
  let name = null;
  let packageManager = null;
  let goModuleName = null;

  // Detect lockfiles / packageManager at root
  const hasFile = (rel) => fileSet.has(rel) || existsSync(join(realRoot, rel));

  if (hasFile('pnpm-lock.yaml') || hasFile('pnpm-workspace.yaml')) packageManager = 'pnpm';
  else if (hasFile('yarn.lock')) packageManager = 'yarn';
  else if (hasFile('bun.lockb') || hasFile('bun.lock')) packageManager = 'bun';
  else if (hasFile('package-lock.json')) packageManager = 'npm';

  const manifestCandidates = files
    .map((f) => f.rel)
    .filter((rel) => {
      const base = basename(rel);
      return [
        'package.json',
        'pyproject.toml',
        'requirements.txt',
        'requirements-dev.txt',
        'dev-requirements.txt',
        'Cargo.toml',
        'go.mod',
      ].includes(base);
    })
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  // Read root package.json first if it exists
  const pkgJsonPaths = manifestCandidates.filter((r) => basename(r) === 'package.json');
  const rootPkgRaw = fileSet.has('package.json')
    ? await safeReadUtf8(join(realRoot, 'package.json'))
    : null;
  let rootPkg = null;
  if (rootPkgRaw !== null) {
    try {
      rootPkg = JSON.parse(rootPkgRaw);
    } catch {
      rootPkg = null;
    }
  }

  if (rootPkg && typeof rootPkg === 'object') {
    manifests.push('package.json');
    if (typeof rootPkg.name === 'string' && rootPkg.name.trim()) {
      name = rootPkg.name.trim();
    }
    if (typeof rootPkg.packageManager === 'string') {
      const pmName = rootPkg.packageManager.split('@')[0].trim().toLowerCase();
      if (pmName) packageManager = pmName;
    }
    if (!packageManager) packageManager = 'npm';

    for (const d of Object.keys(rootPkg.dependencies ?? {})) depSet.add(d);
    for (const d of Object.keys(rootPkg.devDependencies ?? {})) devDepSet.add(d);
    if (rootPkg.scripts && typeof rootPkg.scripts === 'object') {
      for (const [k, v] of Object.entries(rootPkg.scripts)) {
        if (typeof v === 'string') scripts[k] = redactSecrets(v);
      }
      const cls = classifyPackageScripts(rootPkg.scripts, packageManager);
      testCommands.push(...cls.testCommands);
      buildCommands.push(...cls.buildCommands);
      lintCommands.push(...cls.lintCommands);
    }
    if (typeof rootPkg.main === 'string') {
      declaredEntries.push(rootPkg.main.replace(/^\.\//, ''));
    }
    if (typeof rootPkg.module === 'string') {
      declaredEntries.push(rootPkg.module.replace(/^\.\//, ''));
    }
    if (typeof rootPkg.bin === 'string') {
      declaredEntries.push(rootPkg.bin.replace(/^\.\//, ''));
    } else if (rootPkg.bin && typeof rootPkg.bin === 'object') {
      for (const b of Object.values(rootPkg.bin)) {
        if (typeof b === 'string') declaredEntries.push(b.replace(/^\.\//, ''));
      }
    }
    extractPackageJsonExports(rootPkg.exports, '', declaredEntries);

    const wsRaw = Array.isArray(rootPkg.workspaces)
      ? rootPkg.workspaces
      : Array.isArray(rootPkg.workspaces?.packages)
        ? rootPkg.workspaces.packages
        : [];
    if (wsRaw.length) {
      for (const wsPkg of resolveWorkspacePatterns(realRoot, wsRaw, fileSet)) {
        if (!pkgJsonPaths.includes(wsPkg)) pkgJsonPaths.push(wsPkg);
      }
    }
  }

  // Sub-package package.json files (workspaces or nested packages like backend/frontend)
  for (const rel of pkgJsonPaths) {
    if (rel === 'package.json') continue;
    const raw = await safeReadUtf8(join(realRoot, rel));
    if (!raw) continue;
    let pkg;
    try {
      pkg = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!pkg || typeof pkg !== 'object') continue;
    manifests.push(rel);
    if (!packageManager) packageManager = 'npm';
    const pkgDir = posix.dirname(rel);
    for (const d of Object.keys(pkg.dependencies ?? {})) depSet.add(d);
    for (const d of Object.keys(pkg.devDependencies ?? {})) devDepSet.add(d);
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      for (const [k, v] of Object.entries(pkg.scripts)) {
        if (typeof v === 'string') {
          scripts[`${pkgDir}:${k}`] = redactSecrets(v);
        }
      }
      const cls = classifyPackageScripts(pkg.scripts, packageManager, { prefixDir: pkgDir });
      testCommands.push(...cls.testCommands);
      buildCommands.push(...cls.buildCommands);
      lintCommands.push(...cls.lintCommands);
    }
    if (typeof pkg.main === 'string') {
      declaredEntries.push(posix.join(pkgDir, pkg.main).replace(/^\.\//, ''));
    }
    if (typeof pkg.bin === 'string') {
      declaredEntries.push(posix.join(pkgDir, pkg.bin).replace(/^\.\//, ''));
    } else if (pkg.bin && typeof pkg.bin === 'object') {
      for (const b of Object.values(pkg.bin)) {
        if (typeof b === 'string') declaredEntries.push(posix.join(pkgDir, b).replace(/^\.\//, ''));
      }
    }
    extractPackageJsonExports(pkg.exports, pkgDir, declaredEntries);
  }

  // Python manifests
  let pyInfo = null;
  for (const rel of manifestCandidates.filter((r) => basename(r) === 'pyproject.toml')) {
    const raw = await safeReadUtf8(join(realRoot, rel));
    if (!raw) continue;
    manifests.push(rel);
    const parsed = parsePyprojectToml(raw);
    pyInfo = pyInfo ?? parsed;
    if (!name && parsed.name) name = parsed.name;
    for (const d of parsed.dependencies) depSet.add(d);
    for (const d of parsed.devDependencies) devDepSet.add(d);
    if (!packageManager) {
      if (hasFile('uv.lock') || parsed.hasUv) packageManager = 'uv';
      else if (hasFile('poetry.lock') || parsed.hasPoetry) packageManager = 'poetry';
      else packageManager = 'pip';
    }
  }

  for (const rel of manifestCandidates.filter((r) =>
    ['requirements.txt', 'requirements-dev.txt', 'dev-requirements.txt'].includes(basename(r)),
  )) {
    const raw = await safeReadUtf8(join(realRoot, rel));
    if (!raw) continue;
    manifests.push(rel);
    const deps = parseRequirementsTxt(raw);
    const target = basename(rel).includes('dev') ? devDepSet : depSet;
    for (const d of deps) target.add(d);
    if (!packageManager) packageManager = 'pip';
  }

  // Rust manifests
  for (const rel of manifestCandidates.filter((r) => basename(r) === 'Cargo.toml')) {
    const raw = await safeReadUtf8(join(realRoot, rel));
    if (!raw) continue;
    manifests.push(rel);
    const parsed = parseCargoToml(raw);
    if (!name && parsed.name) name = parsed.name;
    for (const d of parsed.dependencies) depSet.add(d);
    for (const d of parsed.devDependencies) devDepSet.add(d);
    if (!packageManager) packageManager = 'cargo';
    const pkgDir = posix.dirname(rel);
    const wrap = (cmd) => (pkgDir && pkgDir !== '.' ? `cd ${pkgDir} && ${cmd}` : cmd);
    testCommands.push(wrap('cargo test'));
    buildCommands.push(wrap('cargo build'));
    lintCommands.push(wrap('cargo clippy'));
  }

  // Go manifests
  for (const rel of manifestCandidates.filter((r) => basename(r) === 'go.mod')) {
    const raw = await safeReadUtf8(join(realRoot, rel));
    if (!raw) continue;
    manifests.push(rel);
    const parsed = parseGoMod(raw);
    if (!goModuleName && parsed.moduleName) goModuleName = parsed.moduleName;
    if (!name && parsed.moduleName) name = parsed.moduleName.split('/').at(-1) || parsed.moduleName;
    for (const d of parsed.dependencies) depSet.add(d);
    if (!packageManager) packageManager = 'go';
    const pkgDir = posix.dirname(rel);
    const wrap = (cmd) => (pkgDir && pkgDir !== '.' ? `cd ${pkgDir} && ${cmd}` : cmd);
    testCommands.push(wrap('go test ./...'));
    buildCommands.push(wrap('go build ./...'));
    lintCommands.push(wrap('go vet ./...'));
  }

  // Fallback command inference for JS/TS and Python repos without explicit scripts
  const allDeps = new Set([...depSet, ...devDepSet]);
  const hasJsTsTests = testFiles.some((f) => JS_TS_EXTENSIONS.has(extname(f).toLowerCase()));
  const hasPyFiles =
    manifests.some((m) => m.endsWith('pyproject.toml') || m.endsWith('requirements.txt')) ||
    sourceFiles.some((f) => f.endsWith('.py')) ||
    testFiles.some((f) => f.endsWith('.py'));

  if (hasJsTsTests && testCommands.length === 0) {
    if (allDeps.has('vitest') || hasFile('vitest.config.ts') || hasFile('vitest.config.js')) {
      testCommands.push('npx vitest run');
    } else if (allDeps.has('jest') || hasFile('jest.config.js') || hasFile('jest.config.ts')) {
      testCommands.push('npx jest');
    } else if (allDeps.has('mocha')) {
      testCommands.push('npx mocha');
    } else {
      testCommands.push('node --test');
    }
  }

  if (hasFile('tsconfig.json') && !buildCommands.some((c) => c.includes('tsc') || c.includes('build') || c.includes('check'))) {
    buildCommands.push('npx tsc --noEmit');
  }

  if (hasPyFiles) {
    const pyPrefix =
      packageManager === 'uv'
        ? 'uv run '
        : packageManager === 'poetry'
          ? 'poetry run '
          : '';
    const hasPyTests =
      pyInfo?.hasPytest ||
      allDeps.has('pytest') ||
      hasFile('pytest.ini') ||
      testFiles.some((f) => f.endsWith('.py'));
    if (hasPyTests && !testCommands.some((c) => c.includes('pytest'))) {
      if (allDeps.has('pytest') || pyInfo?.hasPytest || hasFile('pytest.ini')) {
        testCommands.push(`${pyPrefix}pytest`);
      } else {
        testCommands.push('python -m unittest');
      }
    }
    if (pyInfo?.hasRuff || allDeps.has('ruff')) {
      lintCommands.push(`${pyPrefix}ruff check .`);
    } else if (allDeps.has('flake8')) {
      lintCommands.push(`${pyPrefix}flake8`);
    }
    if (pyInfo?.hasMypy || allDeps.has('mypy')) {
      buildCommands.push(`${pyPrefix}mypy .`);
    }
  }

  // Language detection weighted by source/test file frequency + manifests
  const langCounts = new Map();
  const bumpLang = (lang, weight = 1) => {
    langCounts.set(lang, (langCounts.get(lang) ?? 0) + weight);
  };
  for (const f of [...sourceFiles, ...testFiles]) {
    const lang = CODE_EXTENSIONS.get(extname(f).toLowerCase());
    if (lang) bumpLang(lang, 1);
  }
  if (manifests.some((m) => m.endsWith('package.json')) && !langCounts.has('javascript') && !langCounts.has('typescript')) {
    bumpLang('javascript', 1);
  }
  if (hasFile('tsconfig.json')) bumpLang('typescript', 1);
  if (manifests.some((m) => m.endsWith('pyproject.toml') || m.endsWith('requirements.txt'))) bumpLang('python', 1);
  if (manifests.some((m) => m.endsWith('Cargo.toml'))) bumpLang('rust', 1);
  if (manifests.some((m) => m.endsWith('go.mod'))) bumpLang('go', 1);

  const languages = [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lang]) => lang);

  return {
    project: {
      name: name || basename(realRoot),
      languages,
      packageManager,
      manifests: [...new Set(manifests)],
      scripts,
      testCommands: [...new Set(testCommands)],
      buildCommands: [...new Set(buildCommands)],
      lintCommands: [...new Set(lintCommands)],
      dependencies: [...depSet].sort((a, b) => a.localeCompare(b)),
      devDependencies: [...devDepSet].sort((a, b) => a.localeCompare(b)),
    },
    declaredEntries: [...new Set(declaredEntries)],
    goModuleName,
  };
}

// ---- Structure Classification ----

function isTestFilePath(relPath) {
  const norm = toPosix(relPath);
  if (/(?:^|\/)(?:tests?|__tests__|specs?)\//i.test(norm)) return true;
  const base = posix.basename(norm);
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true;
  if (/^(?:test_.*\.py|.*_test\.py)$/i.test(base)) return true;
  if (/_test\.go$/i.test(base)) return true;
  if (/_test\.rs$/i.test(base)) return true;
  return false;
}

function isConventionalEntryPoint(relPath) {
  const norm = toPosix(relPath);
  if (/^(?:main|index|app|server|cli)\.[cm]?[jt]sx?$/i.test(norm)) return true;
  if (/(?:^|\/)src\/(?:main|index|app|server|cli|mod|lib)\.[cm]?[jt]sx?$/i.test(norm)) return true;
  if (/(?:^|\/)bin\/[^/]+$/i.test(norm)) return true;
  if (/(?:^|\/)(?:main|app|cli|__main__|manage|wsgi|asgi)\.py$/i.test(norm)) return true;
  if (/(?:^|\/)src\/(?:main|lib)\.rs$/i.test(norm)) return true;
  if (/^(?:cmd\/[^/]+\/)?main\.go$/i.test(norm)) return true;
  return false;
}

// ---- Call Graph & Static Symbol Extraction ----

function stripCommentsPreserveStrings(source) {
  const src = String(source ?? '');
  let out = '';
  let i = 0;
  let state = 'code'; // code | single | double | template | line-comment | block-comment
  let escaped = false;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (state === 'line-comment') {
      if (ch === '\n') {
        state = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
      } else {
        out += ch === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }

    if (state === 'single' || state === 'double' || state === 'template') {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (
        (state === 'single' && ch === "'") ||
        (state === 'double' && ch === '"') ||
        (state === 'template' && ch === '`')
      ) {
        state = 'code';
      }
      i += 1;
      continue;
    }

    // state === 'code'
    if (ch === '/' && next === '/') {
      state = 'line-comment';
      out += '  ';
      i += 2;
    } else if (ch === '/' && next === '*') {
      state = 'block-comment';
      out += '  ';
      i += 2;
    } else {
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      out += ch;
      i += 1;
    }
  }
  return out;
}

function parseNamedSpecifiers(clause) {
  const symbols = [];
  const inner = String(clause ?? '').trim();
  if (!inner) return symbols;
  for (const part of inner.split(',')) {
    const cleaned = part.trim().replace(/^type\s+/, '');
    if (!cleaned) continue;
    const asMatch = /^(\S+)\s+as\s+(\S+)$/.exec(cleaned);
    symbols.push(asMatch ? asMatch[2] : cleaned);
  }
  return symbols;
}

function parseJsTsFile(text) {
  const cleaned = stripCommentsPreserveStrings(text);
  const imports = [];
  const exports = new Set();

  // 1. ES import ... from '...'
  const esImportFromRe =
    /(?:^|[;\n\r])\s*import\s+(?:type\s+)?([^;'"`]+?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of cleaned.matchAll(esImportFromRe)) {
    const clause = m[1].trim();
    const spec = m[2].trim();
    const symbols = [];
    const braceMatch = /\{([^}]*)\}/.exec(clause);
    if (braceMatch) symbols.push(...parseNamedSpecifiers(braceMatch[1]));
    const starMatch = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (starMatch) symbols.push(`* as ${starMatch[1]}`);
    const defaultPart = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+\S+/, '').replace(/,/g, '').trim();
    if (defaultPart) symbols.push('default');
    imports.push({ specifier: spec, kind: 'esm-import', symbols });
  }

  // 2. ES side-effect import '...'
  const esSideEffectRe = /(?:^|[;\n\r])\s*import\s+['"]([^'"]+)['"]/g;
  for (const m of cleaned.matchAll(esSideEffectRe)) {
    imports.push({ specifier: m[1].trim(), kind: 'esm-import', symbols: [] });
  }

  // 3. ES re-export ... from '...'
  const esReexportRe =
    /(?:^|[;\n\r])\s*export\s+(?:type\s+)?(\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of cleaned.matchAll(esReexportRe)) {
    const clause = m[1].trim();
    const spec = m[2].trim();
    const starNs = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
    const symbols = starNs
      ? [`* as ${starNs[1]}`]
      : clause.startsWith('*')
        ? ['*']
        : parseNamedSpecifiers(clause.slice(1, -1));
    if (starNs) {
      exports.add(starNs[1]);
    } else {
      for (const sym of symbols) {
        if (sym !== '*') exports.add(sym);
      }
    }
    imports.push({ specifier: spec, kind: 'esm-reexport', symbols });
  }

  // 4. Dynamic import('...')
  const dynImportRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of cleaned.matchAll(dynImportRe)) {
    imports.push({ specifier: m[1].trim(), kind: 'dynamic-import', symbols: [] });
  }

  // 5. CommonJS require('...')
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of cleaned.matchAll(requireRe)) {
    imports.push({ specifier: m[1].trim(), kind: 'cjs-require', symbols: [] });
  }

  // 6. Exported declarations
  const declExportRe =
    /(?:^|[;\n\r])\s*export\s+(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of cleaned.matchAll(declExportRe)) {
    exports.add(m[1]);
  }
  const destructExportRe =
    /(?:^|[;\n\r])\s*export\s+(?:const|let|var)\s+\{([^}]+)\}/g;
  for (const m of cleaned.matchAll(destructExportRe)) {
    for (const sym of parseNamedSpecifiers(m[1])) exports.add(sym);
  }
  const namedExportBlockRe = /(?:^|[;\n\r])\s*export\s+\{([^}]+)\}(?!\s*from\b)/g;
  for (const m of cleaned.matchAll(namedExportBlockRe)) {
    for (const sym of parseNamedSpecifiers(m[1])) exports.add(sym);
  }
  if (/(?:^|[;\n\r])\s*export\s+default\b/.test(cleaned)) {
    exports.add('default');
    const defNamed = /(?:^|[;\n\r])\s*export\s+default\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/.exec(cleaned);
    if (defNamed) exports.add(defNamed[1]);
  }

  // 7. CommonJS exports
  const cjsPropExportRe = /(?:^|[;\n\r])\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g;
  for (const m of cleaned.matchAll(cjsPropExportRe)) {
    exports.add(m[1]);
  }
  const cjsObjExportRe = /(?:^|[;\n\r])\s*module\.exports\s*=\s*\{([\s\S]*?)\}/g;
  for (const m of cleaned.matchAll(cjsObjExportRe)) {
    for (const entry of m[1].split(',')) {
      const idMatch = /^\s*([A-Za-z_$][\w$]*)\s*(?:[:,]|$)/.exec(entry);
      if (idMatch) exports.add(idMatch[1]);
    }
  }
  const cjsDirectExportRe = /(?:^|[;\n\r])\s*module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*[;\n\r]/g;
  for (const m of cleaned.matchAll(cjsDirectExportRe)) {
    exports.add(m[1]);
  }

  return { imports, exports: [...exports] };
}

function parsePythonFile(text) {
  const imports = [];
  const exports = new Set();
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '');
    const fromMatch = /^\s*from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z0-9_.]+)\s+import\s+(.+)$/.exec(line);
    if (fromMatch) {
      const modSpec = fromMatch[1].trim();
      const syms = fromMatch[2]
        .replace(/[()]/g, '')
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter((s) => s && s !== '*');
      imports.push({ specifier: modSpec, kind: 'python-from', symbols: syms });
      continue;
    }
    const impMatch = /^\s*import\s+([A-Za-z0-9_.,\s]+)$/.exec(line);
    if (impMatch) {
      for (const item of impMatch[1].split(',')) {
        const modSpec = item.trim().split(/\s+as\s+/)[0].trim();
        if (modSpec) imports.push({ specifier: modSpec, kind: 'python-import', symbols: [] });
      }
      continue;
    }
    const defMatch = /^(?:async\s+)?(?:def|class)\s+([A-Za-z][A-Za-z0-9_]*)\b/.exec(line);
    if (defMatch && !defMatch[1].startsWith('_')) {
      exports.add(defMatch[1]);
    }
  }
  return { imports, exports: [...exports] };
}

function parseGoFile(text) {
  const imports = [];
  const exports = new Set();
  let inImportBlock = false;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (/^import\s*\($/.test(line)) {
      inImportBlock = true;
      continue;
    }
    if (inImportBlock) {
      if (line === ')') {
        inImportBlock = false;
        continue;
      }
      const m = /"([^"]+)"/.exec(line);
      if (m) imports.push({ specifier: m[1], kind: 'go-import', symbols: [] });
      continue;
    }
    const singleImp = /^import\s+(?:[A-Za-z_.]+\s+)?"([^"]+)"/.exec(line);
    if (singleImp) {
      imports.push({ specifier: singleImp[1], kind: 'go-import', symbols: [] });
      continue;
    }
    const funcMatch = /^func\s+(?:\([^)]+\)\s+)?([A-Z][A-Za-z0-9_]*)\b/.exec(line);
    if (funcMatch) exports.add(funcMatch[1]);
    const typeMatch = /^type\s+([A-Z][A-Za-z0-9_]*)\b/.exec(line);
    if (typeMatch) exports.add(typeMatch[1]);
  }
  return { imports, exports: [...exports] };
}

function parseRustFile(text) {
  const cleaned = stripCommentsPreserveStrings(text);
  const imports = [];
  const exports = new Set();

  for (const m of cleaned.matchAll(/(?:^|[;\n\r])\s*(?:pub\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g)) {
    imports.push({ specifier: `mod:${m[1]}`, kind: 'rust-mod', symbols: [m[1]] });
  }
  for (const m of cleaned.matchAll(/(?:^|[;\n\r])\s*(?:pub\s+)?use\s+((?:crate|super|self)(?:::[A-Za-z0-9_]+)+)/g)) {
    imports.push({ specifier: m[1], kind: 'rust-use', symbols: [] });
  }
  for (const m of cleaned.matchAll(/(?:^|[;\n\r])\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    exports.add(m[1]);
  }
  return { imports, exports: [...exports] };
}

function resolveJsTsSpecifier(fromRel, specifier, fileSet) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const fromDir = posix.dirname(fromRel);
  const base = posix.normalize(fromDir === '.' ? specifier : posix.join(fromDir, specifier));
  if (base.startsWith('..')) return null;

  const candidates = [base];
  const ext = posix.extname(base).toLowerCase();
  if (ext) {
    // TypeScript ESM projects frequently import `.js` pointing to `.ts`/`.tsx` source
    if (ext === '.js') candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
    else if (ext === '.jsx') candidates.push(base.slice(0, -4) + '.tsx', base.slice(0, -4) + '.ts');
    else if (ext === '.mjs') candidates.push(base.slice(0, -4) + '.mts');
    else if (ext === '.cjs') candidates.push(base.slice(0, -4) + '.cts');
  } else {
    for (const tryExt of ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.json']) {
      candidates.push(`${base}${tryExt}`);
    }
    for (const idxExt of ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']) {
      candidates.push(`${base}/index${idxExt}`);
    }
  }

  for (const cand of candidates) {
    if (fileSet.has(cand)) return cand;
  }
  return null;
}

function resolvePythonSpecifier(fromRel, specifier, fileSet) {
  const fromDir = posix.dirname(fromRel);
  let targetDir = fromDir === '.' ? '' : fromDir;
  let modPath = specifier;

  if (specifier.startsWith('.')) {
    const dotMatch = /^(\.+)(.*)$/.exec(specifier);
    const upCount = dotMatch[1].length - 1;
    modPath = dotMatch[2];
    for (let i = 0; i < upCount; i++) {
      targetDir = targetDir.includes('/') ? posix.dirname(targetDir) : '';
    }
    const relMod = modPath ? modPath.replace(/\./g, '/') : '';
    const base = targetDir ? (relMod ? posix.join(targetDir, relMod) : targetDir) : relMod;
    for (const cand of [`${base}.py`, `${base}/__init__.py`]) {
      if (fileSet.has(cand)) return cand;
    }
    return null;
  }

  const dotted = specifier.replace(/\./g, '/');
  for (const prefix of ['', 'src/']) {
    const base = `${prefix}${dotted}`;
    if (fileSet.has(`${base}.py`)) return `${base}.py`;
    if (fileSet.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
  }
  return null;
}

function resolveGoSpecifier(specifier, goModuleName, filesByDir) {
  if (!goModuleName) return null;
  if (specifier !== goModuleName && !specifier.startsWith(`${goModuleName}/`)) return null;
  const subDir = specifier === goModuleName ? '' : specifier.slice(goModuleName.length + 1);
  const candidates = filesByDir.get(subDir) ?? [];
  return candidates.find((f) => f.endsWith('.go') && !isTestFilePath(f)) ?? candidates[0] ?? null;
}

function resolveRustSpecifier(fromRel, specifier, fileSet) {
  const fromDir = posix.dirname(fromRel);
  if (specifier.startsWith('mod:')) {
    const modName = specifier.slice(4);
    const base = fromDir === '.' ? modName : `${fromDir}/${modName}`;
    if (fileSet.has(`${base}.rs`)) return `${base}.rs`;
    if (fileSet.has(`${base}/mod.rs`)) return `${base}/mod.rs`;
    return null;
  }
  const parts = specifier.split('::');
  let baseDir = '';
  let idx = 1;
  if (parts[0] === 'crate') {
    baseDir = fromRel.includes('src/') ? fromRel.slice(0, fromRel.indexOf('src/') + 3) : 'src';
  } else if (parts[0] === 'super') {
    baseDir = fromDir === '.' ? '' : posix.dirname(fromDir);
    if (baseDir === '.') baseDir = '';
  } else if (parts[0] === 'self') {
    baseDir = fromDir === '.' ? '' : fromDir;
  } else {
    return null;
  }
  const seg = parts[idx];
  if (!seg) return null;
  const candBase = baseDir ? `${baseDir}/${seg}` : seg;
  if (fileSet.has(`${candBase}.rs`)) return `${candBase}.rs`;
  if (fileSet.has(`${candBase}/mod.rs`)) return `${candBase}/mod.rs`;
  return null;
}

function resolveModuleImport(fromRel, item, { fileSet, goModuleName, filesByDir }) {
  const ext = posix.extname(fromRel).toLowerCase();
  if (JS_TS_EXTENSIONS.has(ext)) {
    return resolveJsTsSpecifier(fromRel, item.specifier, fileSet);
  }
  if (ext === '.py' || ext === '.pyw') {
    return resolvePythonSpecifier(fromRel, item.specifier, fileSet);
  }
  if (ext === '.go') {
    return resolveGoSpecifier(item.specifier, goModuleName, filesByDir);
  }
  if (ext === '.rs') {
    return resolveRustSpecifier(fromRel, item.specifier, fileSet);
  }
  return null;
}

async function buildCallGraph(realRoot, files, { sourceFiles, testFiles, entryPointSet, goModuleName }) {
  const fileSet = new Set(files.map((f) => f.rel));
  const filesByDir = new Map();
  for (const rel of fileSet) {
    const dir = posix.dirname(rel) === '.' ? '' : posix.dirname(rel);
    if (!filesByDir.has(dir)) filesByDir.set(dir, []);
    filesByDir.get(dir).push(rel);
  }

  const codeFiles = [...new Set([...sourceFiles, ...testFiles])];
  const parsedByPath = new Map();
  const textByPath = new Map();

  // Bounded batch read + parse
  const BATCH_SIZE = 16;
  for (let i = 0; i < codeFiles.length; i += BATCH_SIZE) {
    const batch = codeFiles.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (rel) => {
        const text = await safeReadUtf8(join(realRoot, rel));
        if (text === null) return;
        textByPath.set(rel, text);
        const ext = posix.extname(rel).toLowerCase();
        let parsed;
        if (JS_TS_EXTENSIONS.has(ext)) parsed = parseJsTsFile(text);
        else if (ext === '.py' || ext === '.pyw') parsed = parsePythonFile(text);
        else if (ext === '.go') parsed = parseGoFile(text);
        else if (ext === '.rs') parsed = parseRustFile(text);
        else parsed = { imports: [], exports: [] };
        parsedByPath.set(rel, parsed);
      }),
    );
  }

  const edgeMap = new Map();
  const inboundCounts = new Map();
  const outboundCounts = new Map();
  const resolvedImportsByFile = new Map();
  const externalImportsByFile = new Map();

  for (const rel of codeFiles) {
    const parsed = parsedByPath.get(rel);
    if (!parsed) continue;
    const resolvedTargets = new Set();
    const externalSpecs = new Set();

    for (const imp of parsed.imports) {
      const target = resolveModuleImport(rel, imp, { fileSet, goModuleName, filesByDir });
      if (target && target !== rel) {
        resolvedTargets.add(target);
        const edgeKey = `${rel}\0${target}`;
        const existing = edgeMap.get(edgeKey);
        if (existing) {
          for (const sym of imp.symbols) {
            if (!existing.symbols.includes(sym)) existing.symbols.push(sym);
          }
        } else {
          edgeMap.set(edgeKey, {
            from: rel,
            to: target,
            specifier: imp.specifier,
            kind: imp.kind,
            symbols: [...new Set(imp.symbols)],
          });
        }
      } else if (!target && !imp.specifier.startsWith('.')) {
        externalSpecs.add(imp.specifier);
      }
    }

    resolvedImportsByFile.set(rel, [...resolvedTargets]);
    externalImportsByFile.set(rel, [...externalSpecs]);
  }

  const edges = [...edgeMap.values()];
  for (const edge of edges) {
    inboundCounts.set(edge.to, (inboundCounts.get(edge.to) ?? 0) + 1);
    outboundCounts.set(edge.from, (outboundCounts.get(edge.from) ?? 0) + 1);
  }

  const modules = codeFiles.map((rel) => {
    const parsed = parsedByPath.get(rel) ?? { exports: [] };
    return {
      path: rel,
      language: CODE_EXTENSIONS.get(posix.extname(rel).toLowerCase()) || 'unknown',
      isEntryPoint: entryPointSet.has(rel),
      isTest: isTestFilePath(rel),
      exports: parsed.exports,
      imports: resolvedImportsByFile.get(rel) ?? [],
      externalImports: externalImportsByFile.get(rel) ?? [],
      inboundCount: inboundCounts.get(rel) ?? 0,
      outboundCount: outboundCounts.get(rel) ?? 0,
    };
  });

  modules.sort(
    (a, b) =>
      b.inboundCount - a.inboundCount ||
      Number(b.isEntryPoint) - Number(a.isEntryPoint) ||
      a.path.localeCompare(b.path),
  );

  return { edges, modules, textByPath };
}

// ---- Issue Relevance Ranking & Linked Test Discovery ----

function tokenizeIssueText(issueText) {
  const raw = String(issueText ?? '').trim();
  if (!raw) return { pathHints: [], terms: [] };

  const pathHints = [];
  for (const m of raw.matchAll(/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?:\.[A-Za-z0-9]+)?)/g)) {
    pathHints.push(m[1].toLowerCase());
  }

  // Split camelCase/PascalCase before lowercasing so `AuthService` -> `authservice`, `auth`, `service`
  const expanded = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const rawTokens = expanded.toLowerCase().match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  const termSet = new Set();

  for (const tok of rawTokens) {
    if (STOPWORDS.has(tok)) continue;
    termSet.add(tok);
    for (const sub of tok.split(/[_\-.]+/)) {
      if (sub.length >= 2 && !STOPWORDS.has(sub)) termSet.add(sub);
    }
    if (/[\u4e00-\u9fff]/.test(tok) && tok.length > 2) {
      for (let i = 0; i < tok.length - 1; i++) {
        termSet.add(tok.slice(i, i + 2));
      }
    }
  }

  return { pathHints, terms: [...termSet].slice(0, 40) };
}

function stemWithoutTestMarker(relPath) {
  const base = posix.basename(relPath).toLowerCase();
  return base
    .replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/, '')
    .replace(/^test_/, '')
    .replace(/_test\.(?:py|go|rs)$/, '')
    .replace(/\.[a-z0-9]+$/, '');
}

function findLinkedTests(modules, edges) {
  const testSet = new Set(modules.filter((m) => m.isTest).map((m) => m.path));
  const testsByStem = new Map();
  for (const t of testSet) {
    const stem = stemWithoutTestMarker(t);
    if (!stem) continue;
    if (!testsByStem.has(stem)) testsByStem.set(stem, []);
    testsByStem.get(stem).push(t);
  }

  const inboundFromTests = new Map();
  for (const e of edges) {
    if (testSet.has(e.from) && !testSet.has(e.to)) {
      if (!inboundFromTests.has(e.to)) inboundFromTests.set(e.to, new Set());
      inboundFromTests.get(e.to).add(e.from);
    }
  }

  const linkedBySource = new Map();
  for (const mod of modules) {
    if (mod.isTest) continue;
    const linked = new Set(inboundFromTests.get(mod.path) ?? []);
    const srcStem = stemWithoutTestMarker(mod.path);
    for (const cand of testsByStem.get(srcStem) ?? []) {
      linked.add(cand);
    }
    linkedBySource.set(mod.path, [...linked].sort((a, b) => a.localeCompare(b)));
  }
  return linkedBySource;
}

function rankRelevantFiles({ issueText, modules, edges, textByPath }) {
  const { pathHints, terms } = tokenizeIssueText(issueText);
  const hasIssueQuery = pathHints.length > 0 || terms.length > 0;
  const linkedBySource = findLinkedTests(modules, edges);
  const scores = new Map();
  const issueScores = new Map();
  const reasonsByPath = new Map();

  const addReason = (p, reason) => {
    if (!reasonsByPath.has(p)) reasonsByPath.set(p, []);
    const arr = reasonsByPath.get(p);
    if (!arr.includes(reason)) arr.push(reason);
  };

  for (const mod of modules) {
    let issueScore = 0;
    const lowerPath = mod.path.toLowerCase();
    const stem = stemWithoutTestMarker(mod.path);
    const pathSegments = lowerPath.split(/[/_.\-]+/).filter(Boolean);

    if (hasIssueQuery) {
      for (const hint of pathHints) {
        if (lowerPath === hint || lowerPath.endsWith(`/${hint}`)) {
          issueScore += 45;
          addReason(mod.path, `path-match:${hint}`);
        }
      }

      for (const term of terms) {
        if (stem === term) {
          issueScore += 20;
          addReason(mod.path, `name:${term}`);
        } else if (pathSegments.includes(term)) {
          issueScore += 12;
          addReason(mod.path, `path:${term}`);
        } else if (lowerPath.includes(term) && term.length >= 3) {
          issueScore += 6;
          addReason(mod.path, `path:${term}`);
        }

        for (const sym of mod.exports) {
          const symLower = sym.toLowerCase();
          if (symLower === term) {
            issueScore += 16;
            addReason(mod.path, `export:${sym}`);
          } else if (symLower.includes(term) && term.length >= 3) {
            issueScore += 8;
            addReason(mod.path, `export:${sym}`);
          }
        }
      }

      const content = textByPath.get(mod.path);
      if (content) {
        const lowerContent = content.toLowerCase();
        let contentHits = 0;
        for (const term of terms) {
          if (term.length >= 3 && lowerContent.includes(term)) {
            contentHits += 1;
            if (contentHits <= 3) addReason(mod.path, `content:${term}`);
          }
        }
        issueScore += Math.min(18, contentHits * 3);
      }
    }

    let score = issueScore;
    // Architectural centrality (inbound references + entry point role)
    if (mod.inboundCount > 0) {
      const centrality = Math.min(24, mod.inboundCount * 6);
      score += centrality;
      addReason(mod.path, `centrality:inbound=${mod.inboundCount}`);
    }
    if (mod.isEntryPoint) {
      score += 5;
      addReason(mod.path, 'entry-point');
    }

    issueScores.set(mod.path, issueScore);
    scores.set(mod.path, score);
  }

  // Propagate relevance to direct graph neighbors + linked test files (driven by issue match)
  if (hasIssueQuery) {
    for (const edge of edges) {
      const fromIssue = issueScores.get(edge.from) ?? 0;
      const toIssue = issueScores.get(edge.to) ?? 0;
      if (fromIssue >= 18) {
        scores.set(edge.to, (scores.get(edge.to) ?? 0) + 6);
        addReason(edge.to, `imported-by:${edge.from}`);
      }
      if (toIssue >= 18) {
        scores.set(edge.from, (scores.get(edge.from) ?? 0) + 5);
        addReason(edge.from, `imports:${edge.to}`);
      }
    }

    for (const [srcPath, tests] of linkedBySource.entries()) {
      const srcIssue = issueScores.get(srcPath) ?? 0;
      if (srcIssue >= 12) {
        for (const t of tests) {
          scores.set(t, (scores.get(t) ?? 0) + Math.min(16, Math.round(srcIssue * 0.45)));
          addReason(t, `linked-test:${srcPath}`);
        }
      }
    }
  }

  const ranked = modules
    .map((mod) => ({
      path: mod.path,
      score: Math.round((scores.get(mod.path) ?? 0) * 100) / 100,
      reasons: (reasonsByPath.get(mod.path) ?? []).slice(0, 10),
      inboundCount: mod.inboundCount,
      isEntryPoint: mod.isEntryPoint,
      isTest: mod.isTest,
      exports: mod.exports.slice(0, 12),
      linkedTests: linkedBySource.get(mod.path) ?? [],
    }))
    .filter((r) => r.score > 0 || !hasIssueQuery)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.inboundCount - a.inboundCount ||
        Number(a.isTest) - Number(b.isTest) ||
        a.path.localeCompare(b.path),
    );

  return ranked.slice(0, 20);
}

// ---- Summary Formatter ----

/**
 * Formats a bounded architectural, call-graph, and command summary from `analyzeRepository()`.
 */
export function formatRepositorySummary(
  analysis,
  { maxBytes = DEFAULT_SUMMARY_MAX_BYTES, includeGraph = true } = {},
) {
  const budget = Math.max(64, Math.trunc(Number(maxBytes) || DEFAULT_SUMMARY_MAX_BYTES));
  const git = analysis?.git ?? {};
  const project = analysis?.project ?? {};
  const structure = analysis?.structure ?? {};
  const callGraph = analysis?.callGraph ?? {};

  const blocks = [];

  // 1. Project header
  const headerLines = [
    `# Repository Intelligence: ${sanitize(redactSecrets(String(project.name || 'workspace')))}`,
    `- Root: ${sanitize(String(analysis?.workspaceRoot || '.'))}`,
    `- Languages: ${(project.languages ?? []).join(', ') || 'unknown'} | PackageManager: ${project.packageManager || 'none'}`,
    `- Manifests: ${(project.manifests ?? []).join(', ') || 'none'}`,
  ];
  if (git.isGitRepo) {
    const shaShort = git.headSha ? String(git.headSha).slice(0, 10) : 'unborn';
    headerLines.push(`- Git: branch=${sanitize(git.branch || 'detached')} head=${shaShort} dirty=${Boolean(git.dirty)}`);
    if (Array.isArray(git.recentCommits) && git.recentCommits.length) {
      headerLines.push(`- Recent Commits: ${git.recentCommits.slice(0, 4).map((c) => sanitize(redactSecrets(c))).join(' | ')}`);
    }
  } else {
    headerLines.push('- Git: not a git repository');
  }
  blocks.push(headerLines.join('\n'));

  // 2. Commands
  const cmdLines = ['## Commands'];
  if (project.testCommands?.length) cmdLines.push(`- Test: ${project.testCommands.join(' ; ')}`);
  if (project.buildCommands?.length) cmdLines.push(`- Build: ${project.buildCommands.join(' ; ')}`);
  if (project.lintCommands?.length) cmdLines.push(`- Lint: ${project.lintCommands.join(' ; ')}`);
  if (cmdLines.length === 1) cmdLines.push('- (no test/build/lint commands detected)');
  blocks.push(cmdLines.join('\n'));

  // 3. Structure & Entry Points
  const structLines = [
    '## Structure',
    `- Files scanned: ${structure.totalFiles ?? 0} (source=${structure.sourceFiles?.length ?? 0}, tests=${structure.testFiles?.length ?? 0})`,
    `- Top-level dirs: ${(structure.topLevelDirs ?? []).join(', ') || '(none)'}`,
    `- Entry points: ${(structure.entryPoints ?? []).join(', ') || '(none)'}`,
  ];
  if (Array.isArray(structure.treeLines) && structure.treeLines.length) {
    structLines.push('```text\n' + structure.treeLines.slice(0, 40).join('\n') + '\n```');
  }
  blocks.push(structLines.join('\n'));

  // 4. Relevant files
  if (Array.isArray(callGraph.relevantFiles) && callGraph.relevantFiles.length) {
    const relLines = ['## Relevant & Central Files'];
    for (const rf of callGraph.relevantFiles.slice(0, 12)) {
      const extra = [
        `score=${rf.score}`,
        rf.inboundCount ? `inbound=${rf.inboundCount}` : '',
        rf.linkedTests?.length ? `tests=[${rf.linkedTests.slice(0, 3).join(', ')}]` : '',
        rf.reasons?.length ? `(${rf.reasons.slice(0, 3).join(', ')})` : '',
      ]
        .filter(Boolean)
        .join(' ');
      relLines.push(`- ${rf.path}: ${extra}`);
    }
    blocks.push(relLines.join('\n'));
  }

  // 5. Call Graph edges & module hubs
  if (includeGraph) {
    const graphLines = ['## Call Graph'];
    const hubs = (callGraph.modules ?? []).filter((m) => m.inboundCount > 0 || m.exports?.length).slice(0, 12);
    if (hubs.length) {
      graphLines.push('Modules:');
      for (const m of hubs) {
        const syms = m.exports?.length ? ` exports=[${m.exports.slice(0, 6).join(', ')}]` : '';
        graphLines.push(`- ${m.path} (in=${m.inboundCount}, out=${m.outboundCount})${syms}`);
      }
    }
    if (Array.isArray(callGraph.edges) && callGraph.edges.length) {
      graphLines.push('Edges:');
      for (const e of callGraph.edges.slice(0, 24)) {
        const syms = e.symbols?.length ? ` {${e.symbols.slice(0, 4).join(', ')}}` : '';
        graphLines.push(`- ${e.from} -> ${e.to}${syms}`);
      }
      if (callGraph.edges.length > 24) {
        graphLines.push(`- ... (${callGraph.edges.length - 24} more edges)`);
      }
    } else {
      graphLines.push('- (no internal module import edges extracted)');
    }
    blocks.push(graphLines.join('\n'));
  }

  // Fit strictly within maxBytes
  let assembled = '';
  for (const block of blocks) {
    const candidate = assembled ? `${assembled}\n\n${block}` : block;
    if (Buffer.byteLength(candidate, 'utf8') <= budget) {
      assembled = candidate;
    } else {
      const remaining = budget - Buffer.byteLength(assembled, 'utf8') - (assembled ? 2 : 0);
      if (remaining > 64) {
        const suffix = '\n[... truncated ...]';
        const sliceLimit = Math.max(0, remaining - Buffer.byteLength(suffix, 'utf8'));
        const part = utf8Truncate(block, sliceLimit);
        if (part) assembled = assembled ? `${assembled}\n\n${part}${suffix}` : `${part}${suffix}`;
      }
      break;
    }
  }

  if (!assembled) {
    assembled = utf8Truncate(blocks[0] ?? '', budget);
  }

  const sanitized = sanitize(redactSecrets(assembled));
  return Buffer.byteLength(sanitized, 'utf8') <= budget
    ? sanitized
    : utf8Truncate(sanitized, budget);
}

// ---- Public Entry Point ----

/**
 * Analyzes repository structure, git state, project manifests/commands, static call graph,
 * and issue-ranked file relevance within strict sandbox and byte/file bounds.
 */
export async function analyzeRepository(
  workspaceRoot,
  { issueText = '', maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES } = {},
) {
  const { absRoot, realRoot } = assertSafeWorkspaceRoot(workspaceRoot);
  const boundedFiles = Math.max(1, Math.min(2000, Math.trunc(Number(maxFiles) || DEFAULT_MAX_FILES)));
  const boundedBytes = Math.max(256, Math.trunc(Number(maxBytes) || DEFAULT_MAX_BYTES));

  const [git, scan] = await Promise.all([
    collectGitMetadata(realRoot),
    scanWorkspace(realRoot, { maxFiles: boundedFiles }),
  ]);

  const sourceFiles = [];
  const testFiles = [];
  for (const f of scan.files) {
    const ext = posix.extname(f.rel).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) continue;
    if (isTestFilePath(f.rel)) testFiles.push(f.rel);
    else sourceFiles.push(f.rel);
  }

  const { project, declaredEntries, goModuleName } = await analyzeProjectManifests(
    realRoot,
    scan.files,
    { sourceFiles, testFiles },
  );

  const fileSet = new Set(scan.files.map((f) => f.rel));
  const entrySet = new Set();
  for (const decl of declaredEntries) {
    if (fileSet.has(decl) || existsSync(join(realRoot, decl))) {
      if (!isSecretFileName(posix.basename(decl))) entrySet.add(decl);
    }
  }
  for (const f of sourceFiles) {
    if (isConventionalEntryPoint(f)) entrySet.add(f);
  }
  const entryPoints = [...entrySet].sort((a, b) => a.localeCompare(b));

  const structure = {
    totalFiles: scan.files.length,
    topLevelDirs: scan.topLevelDirs,
    entryPoints,
    sourceFiles,
    testFiles,
    treeLines: buildTreeLines(
      scan.files.map((f) => f.rel),
      scan.allDirs,
      80,
    ),
  };

  const { edges, modules, textByPath } = await buildCallGraph(realRoot, scan.files, {
    sourceFiles,
    testFiles,
    entryPointSet: entrySet,
    goModuleName,
  });

  const relevantFiles = rankRelevantFiles({
    issueText,
    modules,
    edges,
    textByPath,
  });

  const callGraph = {
    edges,
    modules,
    relevantFiles,
  };

  const analysis = {
    analyzedAt: new Date().toISOString(),
    workspaceRoot: absRoot,
    git,
    project,
    structure,
    callGraph,
    summaryText: '',
  };

  analysis.summaryText = formatRepositorySummary(analysis, {
    maxBytes: Math.min(DEFAULT_SUMMARY_MAX_BYTES, boundedBytes),
    includeGraph: true,
  });

  return analysis;
}
