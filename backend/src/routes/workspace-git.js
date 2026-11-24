import { execFile } from 'node:child_process';
import { constants, existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { redactSecrets } from '../envelope.js';
import { Fault } from '../store.js';
import { normalizeProtectedSegment } from '../tools/sandbox.js';

const execFileAsync = promisify(execFile);
const fault = (code, status, message, extra = {}) => new Fault(code, status, { message, ...extra });

const ALLOWED_ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);
const SENSITIVE_FIXED_NAMES = new Set(['.pool-key', '.dev-token', '.provider-env.json']);

const STAGED_SECRET_PATTERNS = [
  { kind: 'private_key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { kind: 'api_key_sk', re: /\bsk-[A-Za-z0-9_-]{12,}\b/ },
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { kind: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{16,}\b/ },
  { kind: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
];

export async function validateWorkspace(path, { writable = false } = {}) {
  if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path)) {
    throw fault('WORKSPACE_PATH_INVALID', 400, '请选择有效的绝对工作区目录。');
  }
  try {
    const root = await realpath(path);
    if (!(await stat(root)).isDirectory()) {
      throw fault('WORKSPACE_NOT_DIRECTORY', 400, '工作区路径不是目录。');
    }
    await access(root, constants.R_OK | constants.X_OK | (writable ? constants.W_OK : 0));
    return root;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
      throw fault('WORKSPACE_NOT_FOUND', 404, '工作区目录不存在或已移动，请重新选择目录。');
    }
    if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) {
      throw fault('WORKSPACE_ACCESS_DENIED', 403, '操作系统未允许后端访问此工作区。请检查目录权限；工具审批不能授予系统目录权限。');
    }
    throw error;
  }
}

export async function runGit(cwd, args) {
  const env = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  // A process launched from a Git hook or other repo must not redirect these commands.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) delete env[key];
  const { stdout, stderr } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd, env, windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim(), raw: stdout };
}

async function git(cwd, args, expectedFailure = () => false) {
  try {
    return await runGit(cwd, args);
  } catch (error) {
    const stderr = error.stderr ?? '';
    if (expectedFailure(error, stderr)) return null;
    if (error.code === 'ENOENT') {
      throw fault('GIT_NOT_INSTALLED', 503, '后端找不到 Git。请安装 Git、确保它在后端的 PATH 中，然后重启应用。');
    }
    if (/dubious ownership|unsafe repository/i.test(stderr)) {
      throw fault('GIT_UNSAFE_OWNERSHIP', 403, 'Git 拒绝访问此仓库：请检查目录所有者和 Git 的信任设置。');
    }
    if (['EPERM', 'EACCES', 'EROFS'].includes(error.code) || /permission denied|operation not permitted|read-only file system|access is denied/i.test(stderr)) {
      throw fault('GIT_ACCESS_DENIED', 403, 'Git 无法访问或写入仓库。请检查操作系统目录权限与仓库文件权限。');
    }
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw fault('GIT_OUTPUT_TOO_LARGE', 413, 'Git 输出过大，请缩小工作区或审查范围后重试。');
    }
    if (error.killed) throw fault('GIT_TIMEOUT', 504, 'Git 操作超时，请稍后重试。');
    throw fault('GIT_OPERATION_FAILED', 409, `Git 操作失败${stderr.trim() ? `：${redactSecrets(stderr.trim()).slice(0, 360)}` : '。'}`);
  }
}

const emptyStatus = { available: false, branch: null, dirty: false, branches: [] };
const emptyChanges = {
  available: false,
  branch: null,
  ahead: 0,
  behind: 0,
  headSha: null,
  clean: true,
  staged: [],
  unstaged: [],
  untracked: [],
  blockedSensitive: [],
};

async function isWorkTree(cwd) {
  const result = await git(cwd, ['rev-parse', '--is-inside-work-tree'],
    (error, stderr) => error.code === 128 && /not a git repository/i.test(stderr));
  if (!result) return false;
  if (result.stdout !== 'true') throw fault('GIT_NOT_WORKTREE', 409, '此目录不是可操作的 Git 工作树。');
  return true;
}

async function readOnlyGitOptions(cwd) {
  // Status and worktree diffs can run clean/process filters even when external
  // diff drivers are disabled. Do not run repository commands to get review evidence.
  const filters = await git(cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'],
    (error, stderr) => error.code === 1 && !stderr);
  const keys = new Set(filters?.raw.split('\0').filter(Boolean) ?? []);
  return [...keys].flatMap((key) => ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`]);
}

function isOutsideRel(relPath) {
  if (!relPath) return false;
  if (isAbsolute(relPath)) return true;
  if (relPath === '..' || relPath.startsWith(`..${sep}`) || relPath.startsWith('../') || relPath.startsWith('..\\')) {
    return true;
  }
  return relPath.split(/[\\/]/).includes('..');
}

function stripWinPrefix(p) {
  if (process.platform === 'win32' && typeof p === 'string') {
    if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
    if (p.startsWith('\\\\?\\')) return p.slice(4);
  }
  return p;
}

function canonicalizeAncestors(targetPath) {
  const abs = resolve(targetPath);
  try {
    return realpathSync(abs);
  } catch {
    let cur = abs;
    while (!existsSync(cur)) {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      cur = parent;
    }
    try {
      const realAnc = realpathSync(cur);
      const suffix = relative(cur, abs);
      return suffix ? resolve(realAnc, suffix) : realAnc;
    } catch {
      return abs;
    }
  }
}

export function confineGitPath(workspaceRoot, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) {
    throw fault('GIT_INVALID_PATH', 400, 'Git 文件路径无效。');
  }
  const input = rawPath.trim();
  const root = resolve(workspaceRoot);
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const full = isAbsolute(input) ? resolve(input) : resolve(realRoot, input);
  const rel = relative(realRoot, full);
  if (!rel || isOutsideRel(rel)) {
    throw fault('GIT_INVALID_PATH', 400, `Git 路径超出工作区范围: ${input}`);
  }
  const parts = rel.split(/[\\/]/).filter(Boolean);
  for (const part of parts) {
    if (normalizeProtectedSegment(part) === '.git') {
      throw fault('GIT_INVALID_PATH', 400, `不允许操作 .git 内部路径: ${input}`);
    }
  }

  // Symlink walk inside workspaceRoot so symlinks cannot escape confinement
  let cur = realRoot;
  let hops = 0;
  const queue = [...parts];
  while (queue.length > 0) {
    const seg = queue.shift();
    if (normalizeProtectedSegment(seg) === '.git') {
      throw fault('GIT_INVALID_PATH', 400, `不允许操作 .git 内部路径: ${input}`);
    }
    const next = join(cur, seg);
    let lst;
    try {
      lst = lstatSync(next);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
        break;
      }
      throw err;
    }
    if (lst.isSymbolicLink()) {
      if (++hops > 16) throw fault('GIT_INVALID_PATH', 400, `符号链接层级过深: ${input}`);
      const rawLink = stripWinPrefix(readlinkSync(next));
      const resolvedLink = isAbsolute(rawLink) ? resolve(rawLink) : resolve(dirname(next), rawLink);
      const normalizedLink = join(canonicalizeAncestors(dirname(resolvedLink)), basename(resolvedLink));
      const linkRel = relative(realRoot, normalizedLink);
      if (!linkRel || isOutsideRel(linkRel)) {
        throw fault('GIT_INVALID_PATH', 400, `Git 符号链接路径超出工作区边界: ${input}`);
      }
      const nextParts = linkRel.split(/[\\/]/).filter(Boolean);
      for (const np of nextParts) {
        if (normalizeProtectedSegment(np) === '.git') {
          throw fault('GIT_INVALID_PATH', 400, `不允许操作 .git 内部路径: ${input}`);
        }
      }
      queue.unshift(...nextParts);
      cur = realRoot;
      continue;
    }
    cur = next;
  }

  const normalizedRel = parts.join('/');
  return { rel: normalizedRel, full };
}

export function isSensitiveGitPath(relPath) {
  const norm = String(relPath ?? '').replace(/\\/g, '/').trim();
  if (!norm) return false;
  const segments = norm.split('/').filter(Boolean);
  if (!segments.length) return false;

  for (let i = 0; i < segments.length; i++) {
    const seg = normalizeProtectedSegment(segments[i]);
    if (SENSITIVE_FIXED_NAMES.has(seg)) return true;
    if (i < segments.length - 1 && seg === '.env') return true;
  }

  const base = normalizeProtectedSegment(segments.at(-1));
  if (ALLOWED_ENV_EXAMPLES.has(base)) return false;
  if (base === '.env' || base.startsWith('.env.') || base.startsWith('.env-')) return true;
  if (base.endsWith('.pem') || base.endsWith('.key')) return true;
  if (base.startsWith('id_rsa')) return true;
  return false;
}

export function detectSecretsInDiff(diffText) {
  const kinds = new Set();
  const lines = String(diffText ?? '').split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('+') || line.startsWith('+++ ')) continue;
    const body = line.slice(1);
    for (const pat of STAGED_SECRET_PATTERNS) {
      if (pat.re.test(body)) kinds.add(pat.kind);
    }
  }
  return { detected: kinds.size > 0, kinds: [...kinds] };
}

export async function getGitStatusFor(cwd) {
  if (!(await isWorkTree(cwd))) return emptyStatus;
  const readOptions = await readOnlyGitOptions(cwd);
  const [head, status, refs] = await Promise.all([
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], (error) => error.code === 1),
    git(cwd, [...readOptions, 'status', '--porcelain', '--no-renames']),
    git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']),
  ]);
  const branch = head?.stdout || null;
  const branches = refs.stdout.split(/\r?\n/).filter(Boolean);
  if (branch && !branches.includes(branch)) branches.unshift(branch);
  const uncommittedCount = status.stdout ? status.stdout.split(/\r?\n/).length : 0;
  return { available: true, branch, dirty: uncommittedCount > 0, uncommittedCount, branches };
}

export async function getGitChangesFor(cwd) {
  if (!(await isWorkTree(cwd))) return { ...emptyChanges };
  const realCwd = realpathSync(resolve(cwd));
  const readOptions = await readOnlyGitOptions(realCwd);

  const [topRes, headRes, headShaRes, aheadBehindRes, statusRes] = await Promise.all([
    git(realCwd, ['rev-parse', '--show-toplevel']),
    git(realCwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], (error) => error.code === 1),
    git(realCwd, ['rev-parse', '--verify', 'HEAD'], (error) => error.code === 128),
    git(realCwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], (error) => error.code === 128),
    git(realCwd, [...readOptions, '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);

  const realTop = realpathSync(resolve(topRes.stdout));
  const remapRepoPath = (repoRel) => {
    const clean = String(repoRel || '').replace(/\\/g, '/');
    if (!clean) return null;
    if (realTop === realCwd) return clean;
    const rel = relative(realCwd, resolve(realTop, clean)).replace(/\\/g, '/');
    if (!rel || isOutsideRel(rel)) return null;
    return rel;
  };

  let behind = 0;
  let ahead = 0;
  if (aheadBehindRes?.stdout) {
    const [bStr, aStr] = aheadBehindRes.stdout.split(/\s+/);
    behind = Number(bStr) || 0;
    ahead = Number(aStr) || 0;
  }

  const staged = [];
  const unstaged = [];
  const untracked = [];
  const blockedSet = new Set();

  const records = String(statusRes.raw || '').split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec || rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const rawPath = rec.slice(3);
    let rawOldPath = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      rawOldPath = records[++i] || null;
    }

    const relPath = remapRepoPath(rawPath);
    if (!relPath) continue;
    const oldPath = rawOldPath ? remapRepoPath(rawOldPath) : null;

    if (x === '!' && y === '!') continue;
    if (x === '?' && y === '?') {
      untracked.push({ path: relPath });
      if (isSensitiveGitPath(relPath)) blockedSet.add(relPath);
      continue;
    }

    if (x !== ' ' && x !== '?') {
      staged.push({ path: relPath, status: x, ...(oldPath ? { oldPath } : {}) });
      if (isSensitiveGitPath(relPath)) blockedSet.add(relPath);
    }
    if (y !== ' ' && y !== '?') {
      unstaged.push({ path: relPath, status: y });
      if (isSensitiveGitPath(relPath)) blockedSet.add(relPath);
    }
  }

  const branch = headRes?.stdout || null;
  const headSha = headShaRes?.stdout || null;
  const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;
  return {
    available: true,
    branch,
    ahead,
    behind,
    headSha,
    clean,
    staged,
    unstaged,
    untracked,
    blockedSensitive: [...blockedSet],
  };
}

async function resolveIdentityArgs(cwd) {
  const [nameCfg, emailCfg] = await Promise.all([
    git(cwd, ['config', '--get', 'user.name'], (error) => error.code === 1),
    git(cwd, ['config', '--get', 'user.email'], (error) => error.code === 1),
  ]);
  const args = [];
  if (!nameCfg?.stdout?.trim()) {
    args.push('-c', 'user.name=Agent_US User');
  }
  if (!emailCfg?.stdout?.trim()) {
    args.push('-c', 'user.email=agent-us@local');
  }
  return args;
}

function chunkItems(arr, size = 200) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function stageGitPaths(cwd, { paths = null, all = false } = {}) {
  if (!(await isWorkTree(cwd))) {
    throw fault('GIT_NOT_REPOSITORY', 409, '请先选择或初始化 Git 仓库。');
  }
  if (Array.isArray(paths) && paths.length > 0) {
    const confined = paths.map((p) => confineGitPath(cwd, p).rel);
    const blocked = confined.filter((rel) => isSensitiveGitPath(rel));
    if (blocked.length > 0) {
      throw fault('GIT_SENSITIVE_FILE_BLOCKED', 400, `禁止暂存敏感文件: ${blocked.join(', ')}`, {
        blockedSensitive: blocked,
      });
    }
    for (const chunk of chunkItems(confined)) {
      await git(cwd, ['add', '--', ...chunk]);
    }
  } else if (all === true) {
    const changes = await getGitChangesFor(cwd);
    const candidates = [...new Set([...changes.unstaged.map((c) => c.path), ...changes.untracked.map((c) => c.path)])];
    const safePaths = [];
    const sensitivePaths = [];
    for (const rel of candidates) {
      if (isSensitiveGitPath(rel)) sensitivePaths.push(rel);
      else safePaths.push(rel);
    }
    if (safePaths.length === 0 && sensitivePaths.length > 0) {
      throw fault('GIT_SENSITIVE_FILE_BLOCKED', 400, `禁止暂存敏感文件: ${sensitivePaths.join(', ')}`, {
        blockedSensitive: sensitivePaths,
      });
    }
    for (const chunk of chunkItems(safePaths)) {
      await git(cwd, ['add', '--', ...chunk]);
    }
  } else {
    throw fault('GIT_STAGE_PATHS_REQUIRED', 400, '请指定要暂存的文件路径，或传入 all=true。');
  }

  return { ok: true, ...(await getGitChangesFor(cwd)) };
}

export async function unstageGitPaths(cwd, { paths = null, all = false } = {}) {
  if (!(await isWorkTree(cwd))) {
    throw fault('GIT_NOT_REPOSITORY', 409, '请先选择或初始化 Git 仓库。');
  }
  const hasHead = Boolean(await git(cwd, ['rev-parse', '--verify', 'HEAD'], (error) => error.code === 128));

  if (Array.isArray(paths) && paths.length > 0) {
    const confined = paths.map((p) => confineGitPath(cwd, p).rel);
    for (const chunk of chunkItems(confined)) {
      if (hasHead) {
        await git(cwd, ['reset', '-q', 'HEAD', '--', ...chunk]);
      } else {
        await git(cwd, ['rm', '--cached', '--ignore-unmatch', '-r', '--', ...chunk]);
      }
    }
  } else if (all === true) {
    if (hasHead) {
      await git(cwd, ['reset', '-q', 'HEAD', '--', '.']);
    } else {
      await git(cwd, ['rm', '--cached', '--ignore-unmatch', '-r', '--', '.']);
    }
  } else {
    throw fault('GIT_UNSTAGE_PATHS_REQUIRED', 400, '请指定要取消暂存的文件路径，或传入 all=true。');
  }

  return { ok: true, ...(await getGitChangesFor(cwd)) };
}

export async function commitGitChanges(cwd, { message, paths = null } = {}) {
  if (!(await isWorkTree(cwd))) {
    throw fault('GIT_NOT_REPOSITORY', 409, '请先选择或初始化 Git 仓库。');
  }
  const cleanMsg = typeof message === 'string' ? message.trim() : '';
  if (!cleanMsg) {
    throw fault('GIT_COMMIT_MESSAGE_REQUIRED', 400, '请填写提交说明（commit message）。');
  }

  const readOptions = await readOnlyGitOptions(cwd);
  const hasHead = Boolean(await git(cwd, ['rev-parse', '--verify', 'HEAD'], (error) => error.code === 128));
  const identityArgs = await resolveIdentityArgs(cwd);

  const getStagedNames = async () => {
    const res = await git(cwd, ['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only', '-z']);
    return String(res.raw || '').split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
  };

  if (Array.isArray(paths) && paths.length > 0) {
    const targetPaths = [...new Set(paths.map((p) => confineGitPath(cwd, p).rel))];
    const blocked = targetPaths.filter((rel) => isSensitiveGitPath(rel));
    if (blocked.length > 0) {
      throw fault('GIT_SENSITIVE_FILE_BLOCKED', 400, `禁止提交敏感文件: ${blocked.join(', ')}`, {
        blockedSensitive: blocked,
      });
    }

    const beforeStaged = new Set(await getStagedNames());
    const newlyStaged = targetPaths.filter((p) => !beforeStaged.has(p));

    for (const chunk of chunkItems(targetPaths)) {
      await git(cwd, ['add', '--', ...chunk]);
    }

    const rollbackAutoStaged = async () => {
      if (!newlyStaged.length) return;
      for (const chunk of chunkItems(newlyStaged)) {
        if (hasHead) {
          await git(cwd, ['reset', '-q', 'HEAD', '--', ...chunk], () => true);
        } else {
          await git(cwd, ['rm', '--cached', '--ignore-unmatch', '-r', '--', ...chunk], () => true);
        }
      }
    };

    const diffRes = await git(cwd, [
      ...readOptions, 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', '--', ...targetPaths,
    ]);
    const secretCheck = detectSecretsInDiff(diffRes.raw);
    if (secretCheck.detected) {
      await rollbackAutoStaged();
      throw fault('GIT_SECRET_DETECTED', 400, '检测到待提交变更中包含敏感密钥，已阻止提交。', {
        kinds: secretCheck.kinds,
      });
    }

    const otherStaged = [...beforeStaged].filter((p) => !targetPaths.includes(p));
    if (otherStaged.length > 0 && hasHead) {
      await git(cwd, [...identityArgs, 'commit', '--only', '-m', cleanMsg, '--', ...targetPaths]);
    } else if (otherStaged.length > 0 && !hasHead) {
      for (const chunk of chunkItems(otherStaged)) {
        await git(cwd, ['rm', '--cached', '--ignore-unmatch', '-r', '--', ...chunk]);
      }
      try {
        await git(cwd, [...identityArgs, 'commit', '-m', cleanMsg]);
      } finally {
        for (const chunk of chunkItems(otherStaged)) {
          await git(cwd, ['add', '--', ...chunk], () => true);
        }
      }
    } else {
      await git(cwd, [...identityArgs, 'commit', '-m', cleanMsg]);
    }
  } else {
    const stagedFiles = await getStagedNames();
    if (!stagedFiles.length) {
      throw fault('GIT_NOTHING_TO_COMMIT', 409, '暂存区没有可提交的变更。');
    }
    const blocked = stagedFiles.filter((rel) => isSensitiveGitPath(rel));
    if (blocked.length > 0) {
      throw fault('GIT_SENSITIVE_FILE_BLOCKED', 400, `禁止提交敏感文件: ${blocked.join(', ')}`, {
        blockedSensitive: blocked,
      });
    }
    const diffRes = await git(cwd, [
      ...readOptions, 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '-U0',
    ]);
    const secretCheck = detectSecretsInDiff(diffRes.raw);
    if (secretCheck.detected) {
      throw fault('GIT_SECRET_DETECTED', 400, '检测到暂存变更中包含敏感密钥，已阻止提交。', {
        kinds: secretCheck.kinds,
      });
    }
    await git(cwd, [...identityArgs, 'commit', '-m', cleanMsg]);
  }

  const [headShaRes, branchRes, subjectRes, filesRes, changes] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], (error) => error.code === 1),
    git(cwd, ['log', '-1', '--format=%s', 'HEAD']),
    git(cwd, ['-c', 'core.quotepath=false', 'diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-z', 'HEAD']),
    getGitChangesFor(cwd),
  ]);

  const commitSha = headShaRes.stdout;
  const shortSha = commitSha.slice(0, 7);
  const branch = branchRes?.stdout || null;
  const subject = subjectRes.stdout;
  const filesCommitted = String(filesRes.raw || '').split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'));

  return {
    ok: true,
    commitSha,
    shortSha,
    branch,
    subject,
    filesCommitted,
    changes,
  };
}

export async function mergeGitBranch(cwd, { sourceBranch, noFf = false, message = null } = {}) {
  if (!(await isWorkTree(cwd))) {
    throw fault('GIT_NOT_REPOSITORY', 409, '请先选择或初始化 Git 仓库。');
  }
  const hasHead = Boolean(await git(cwd, ['rev-parse', '--verify', 'HEAD'], (error) => error.code === 128));
  if (!hasHead) {
    throw fault('GIT_UNBORN_HEAD', 409, '当前分支尚未产生任何提交，无法执行合并。');
  }
  await checkBranch(cwd, sourceBranch);
  const ref = await git(cwd, ['show-ref', '--verify', '--hash', `refs/heads/${sourceBranch}`],
    (error, stderr) => error.code === 1 || /not a valid ref/i.test(stderr));
  if (!ref) {
    throw fault('GIT_BRANCH_NOT_FOUND', 404, `找不到本地分支 ${sourceBranch}。`);
  }

  const identityArgs = await resolveIdentityArgs(cwd);
  const cleanMsg = typeof message === 'string' && message.trim() ? message.trim() : null;
  const mergeArgs = [
    ...identityArgs,
    'merge',
    ...(noFf ? ['--no-ff'] : []),
    ...(cleanMsg ? ['-m', cleanMsg] : ['--no-edit']),
    sourceBranch,
  ];

  try {
    await runGit(cwd, mergeArgs);
  } catch (error) {
    const combined = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`;
    const unmergedRes = await git(cwd, ['-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=U', '-z'], () => true);
    let conflicts = String(unmergedRes?.raw ?? '').split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
    if (!conflicts.length && /CONFLICT/i.test(combined)) {
      const parsed = [];
      for (const m of combined.matchAll(/Merge conflict in (.+)/g)) {
        if (m[1]) parsed.push(m[1].trim().replace(/\\/g, '/'));
      }
      conflicts = [...new Set(parsed)];
    }

    if (conflicts.length > 0 || /CONFLICT/i.test(combined)) {
      await git(cwd, ['merge', '--abort'], () => true);
      throw fault('GIT_MERGE_CONFLICT', 409, `合并分支 ${sourceBranch} 发生冲突，已自动中止合并。`, { conflicts });
    }
    const stderr = error?.stderr ?? '';
    throw fault('GIT_OPERATION_FAILED', 409, `Git 合并失败${stderr.trim() ? `：${redactSecrets(stderr.trim()).slice(0, 360)}` : '。'}`);
  }

  const [headShaRes, branchRes, changes] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], (error) => error.code === 1),
    getGitChangesFor(cwd),
  ]);
  const commitSha = headShaRes.stdout;
  return {
    ok: true,
    merged: true,
    sourceBranch,
    targetBranch: branchRes?.stdout || null,
    commitSha,
    shortSha: commitSha.slice(0, 7),
    changes,
  };
}

async function checkBranch(cwd, branch) {
  if (typeof branch !== 'string' || !branch || branch.length > 255 || branch.startsWith('-') || branch === 'HEAD' || /[\r\n\0]/.test(branch)) {
    throw fault('INVALID_BRANCH_NAME', 400, 'Git 分支名称无效。');
  }
  const result = await git(cwd, ['check-ref-format', `refs/heads/${branch}`], (error) => error.code === 1);
  if (!result) throw fault('INVALID_BRANCH_NAME', 400, 'Git 分支名称无效。');
}

export async function checkoutWorkspaceBranch(cwd, branch, create) {
  await checkBranch(cwd, branch);
  await git(cwd, create ? ['checkout', '-b', branch, '--'] : ['checkout', branch, '--']);
  return getGitStatusFor(cwd);
}

export async function initWorkspaceGit(cwd, branch) {
  if (await isWorkTree(cwd)) return getGitStatusFor(cwd);
  await checkBranch(cwd, branch);
  await validateWorkspace(cwd, { writable: true });
  const result = await git(cwd, ['init', '-b', branch],
    (error, stderr) => error.code === 129 && /unknown switch [`'‘]b['’]|unknown option.*initial-branch/i.test(stderr));
  if (!result) {
    // Git versions predating --initial-branch still support setting the unborn HEAD.
    await git(cwd, ['init']);
    await git(cwd, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  }
  return getGitStatusFor(cwd);
}

const REVIEW_PATHSPEC = [
  '.', ...['.env', '.env.*', '.env-*', '.provider-env.json', '.pool-key', '.dev-token', '*.pem', '*.key', '*.p12', '*.pfx', '*.sqlite*', 'upstream', 'var']
    .map((name) => `:(exclude,glob,icase)**/${name}`),
  ':(exclude,glob,icase)**/upstream/**', ':(exclude,glob,icase)**/var/**',
];

export async function collectReviewEvidence(cwd, baseBranch) {
  if (!(await isWorkTree(cwd))) throw fault('REVIEW_REQUIRES_GIT', 409, '请先选择或创建 Git 仓库。');
  const patchArgs = [...await readOnlyGitOptions(cwd), 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--relative', '--ignore-submodules=all', '--no-renames'];
  const display = [];
  if (baseBranch) {
    await checkBranch(cwd, baseBranch);
    const ref = await git(cwd, ['show-ref', '--verify', '--hash', `refs/heads/${baseBranch}`],
      (error, stderr) => error.code === 1 || /not a valid ref/i.test(stderr));
    if (!ref) throw fault('REVIEW_BRANCH_NOT_FOUND', 404, '此本地分支已不存在，请重新选择审查范围。');
    display.push([`相对于本地分支 ${JSON.stringify(baseBranch)}（${ref.stdout.slice(0, 12)}）`,
      (await git(cwd, [...patchArgs, ref.stdout, '--', ...REVIEW_PATHSPEC])).raw]);
  } else {
    const [staged, unstaged] = await Promise.all([
      git(cwd, [...patchArgs, '--cached', '--', ...REVIEW_PATHSPEC]),
      git(cwd, [...patchArgs, '--', ...REVIEW_PATHSPEC]),
    ]);
    display.push(['暂存区', staged.raw], ['未暂存', unstaged.raw]);
  }
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...REVIEW_PATHSPEC]);
  display.push(['未跟踪文件（如有必要请用只读工具读取）',
    untracked.raw.split('\0').filter(Boolean).map((path) => JSON.stringify(path)).join('\n')]);
  const sections = display.filter(([, body]) => body.trim());
  if (!sections.length) throw fault('REVIEW_NO_CHANGES', 409, '所选范围没有可审查的变更。');
  // These attachments use the existing Direct user-message context path (8,000 chars/file).
  const evidence = redactSecrets(sections.map(([label, body]) => `### ${label}\n${body}`).join('\n\n'));
  const limit = 30_000;
  const truncated = evidence.length > limit;
  const chunks = (evidence.slice(0, limit) + (truncated ? '\n[证据过长，已截断；请说明覆盖限制]' : '')).match(/[\s\S]{1,7500}/gu) ?? [];
  return { truncated, files: Object.fromEntries(chunks.map((chunk, i) => [`review-evidence-${i + 1}.diff`, Buffer.from(chunk).toString('base64')])) };
}
