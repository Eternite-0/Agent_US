import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { redactSecrets } from '../envelope.js';
import { Fault } from '../store.js';

const execFileAsync = promisify(execFile);
const fault = (code, status, message) => new Fault(code, status, { message });

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
