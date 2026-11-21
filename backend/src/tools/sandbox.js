import { execFile, spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { hostname as osHostname, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { id as uuid } from '../store.js';
import { sandbox as dockerSandbox } from '../tools.js';
import {
  assertLeaseInTx,
  checkLeaseHeld,
  classifyJobOwnership,
  getWorkerRecord,
  isPidAlive,
  isWorktreeOwnerLive,
} from '../durable/lease-guard.js';

export const ISOLATION_MODES = Object.freeze({
  WORKTREE: 'worktree',
  SHARED_READONLY: 'shared_readonly',
  SHARED_WORKSPACE: 'shared_workspace',
});

const execFileAsync = promisify(execFile);

export const PROTECTED_BASENAMES = new Set([
  '.pool-key',
  '.dev-token',
  '.provider-env.json',
]);

/**
 * Normalizes a path segment for cross-OS security checks:
 * - Strips NTFS Alternate Data Streams (e.g. `.dev-token::$DATA`)
 * - Strips trailing dots/spaces (Windows NTFS treats `.dev-token.` / `.git ` as `.dev-token` / `.git`)
 * - Lowercases for case-insensitive filesystems (Windows/macOS)
 */
export function normalizeProtectedSegment(segment) {
  const raw = String(segment ?? '');
  const withoutStream = raw.split(':')[0];
  return withoutStream.replace(/[. ]+$/, '').toLowerCase();
}

export function isProtectedPathSegment(segment) {
  const norm = normalizeProtectedSegment(segment);
  return norm === '.git' || PROTECTED_BASENAMES.has(norm);
}

function assertSafeSegments(relPath, input) {
  const parts = relPath ? relPath.split(/[\\/]/).filter(Boolean) : [];
  for (const part of parts) {
    const norm = normalizeProtectedSegment(part);
    if (norm === '.git') {
      throw new Error('不允许直接修改或读取 .git 内部对象目录');
    }
    if (PROTECTED_BASENAMES.has(norm)) {
      throw new Error(`受保护的密钥文件不允许访问: ${part}`);
    }
  }
}

function isOutsideRelative(relPath) {
  if (!relPath) return false;
  if (isAbsolute(relPath)) return true;
  if (
    relPath === '..' ||
    relPath.startsWith(`..${sep}`) ||
    relPath.startsWith('../') ||
    relPath.startsWith('..\\')
  ) {
    return true;
  }
  return relPath.split(/[\\/]/).includes('..');
}

function stripWinExtendedPrefix(p) {
  if (process.platform === 'win32' && typeof p === 'string') {
    if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
    if (p.startsWith('\\\\?\\')) return p.slice(4);
  }
  return p;
}

const SENSITIVE_ENV_KEY_RE =
  /^(?:BACKEND_TOKEN|BACKEND_VAULT|.*_(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)|AWS_.*|OPENAI_.*|ANTHROPIC_.*|DEEPSEEK_.*|GITHUB_TOKEN|NPM_TOKEN|GH_TOKEN)$/i;

/**
 * Strips sensitive host credentials and tokens before launching local child processes.
 */
export function sanitizeChildEnv(sourceEnv = process.env, { allowKeys = [] } = {}) {
  const allow = new Set(allowKeys);
  const out = {};
  for (const [k, v] of Object.entries(sourceEnv ?? {})) {
    if (v === undefined) continue;
    if (!allow.has(k) && SENSITIVE_ENV_KEY_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function findNearestExistingAncestor(targetPath) {
  let cur = resolve(targetPath);
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return cur;
}

function canonicalizeTargetWithAncestors(targetPath) {
  const abs = resolve(targetPath);
  try {
    return realpathSync(abs);
  } catch {
    const anc = findNearestExistingAncestor(abs);
    if (!anc) return abs;
    try {
      const realAnc = realpathSync(anc);
      const suffix = relative(anc, abs);
      return suffix ? resolve(realAnc, suffix) : realAnc;
    } catch {
      return abs;
    }
  }
}

/**
 * Resolves a workspace-confined path and prevents symlink/junction escapes,
 * dangling-symlink writes, intra-workspace symlink bypasses, and cross-OS case/NTFS bypasses.
 */
export function resolveConfinedPath(workspaceRoot, rawPath) {
  const root = resolve(workspaceRoot);
  const input = String(rawPath ?? '').trim();
  if (!input) throw new Error('路径不能为空');
  const full = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const rel = relative(root, full);
  if (isOutsideRelative(rel)) {
    throw new Error(`路径超出当前工作区边界: ${input}`);
  }
  assertSafeSegments(rel, input);

  // Component-by-component lstat + symlink/junction/dangling-symlink confinement walk
  if (existsSync(root)) {
    const realRoot = realpathSync(root);
    const queue = rel ? rel.split(/[\\/]/).filter(Boolean) : [];
    let cur = realRoot;
    let hops = 0;

    while (queue.length > 0) {
      const seg = queue.shift();
      assertSafeSegments(seg, input);
      const next = join(cur, seg);

      let lst = null;
      try {
        lst = lstatSync(next);
      } catch (err) {
        if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
          cur = next;
          while (queue.length > 0) {
            const rem = queue.shift();
            assertSafeSegments(rem, input);
            cur = join(cur, rem);
          }
          break;
        }
        throw err;
      }

      if (lst.isSymbolicLink()) {
        if (++hops > 16) {
          throw new Error(`符号链接层级过深: ${input}`);
        }
        const rawLink = stripWinExtendedPrefix(readlinkSync(next));
        const resolvedLink = isAbsolute(rawLink)
          ? resolve(rawLink)
          : resolve(dirname(next), rawLink);
        const linkParent = dirname(resolvedLink);
        const normalizedLink =
          linkParent === resolvedLink
            ? resolvedLink
            : join(canonicalizeTargetWithAncestors(linkParent), basename(resolvedLink));
        const linkRel = relative(realRoot, normalizedLink);
        if (isOutsideRelative(linkRel)) {
          throw new Error(`符号链接路径逃逸出当前工作区边界: ${input}`);
        }
        assertSafeSegments(linkRel, input);
        const nextParts = linkRel ? linkRel.split(/[\\/]/).filter(Boolean) : [];
        queue.unshift(...nextParts);
        cur = realRoot;
        continue;
      }

      let realNext = next;
      try {
        realNext = realpathSync(next);
      } catch {
        realNext = next;
      }
      const nextRel = relative(realRoot, realNext);
      if (isOutsideRelative(nextRel)) {
        throw new Error(`符号链接路径逃逸出当前工作区边界: ${input}`);
      }
      assertSafeSegments(nextRel, input);
      cur = realNext;
    }

    const finalRealRel = relative(realRoot, cur);
    if (isOutsideRelative(finalRealRel)) {
      throw new Error(`符号链接路径逃逸出当前工作区边界: ${input}`);
    }
    assertSafeSegments(finalRealRel, input);
  }

  return { full, rel: rel.replace(/\\/g, '/') || '.' };
}

/**
 * Terminates a child process and its descendant process tree across Windows & POSIX.
 */
export function killProcessTree(child) {
  if (!child || child.killed) return;
  const pid = child.pid;
  try {
    if (process.platform === 'win32' && pid) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else if (pid) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}

export class HostSandboxAdapter {
  constructor({ allowEnvKeys = [], maxCaptureBytes = 256 * 1024 } = {}) {
    this.allowEnvKeys = allowEnvKeys;
    this.maxCaptureBytes = maxCaptureBytes;
  }

  capabilities() {
    return {
      mode: 'host',
      networkIsolated: false,
      fsRootReadOnly: false,
      capDropAll: false,
      envSanitized: true,
      pathConfined: true,
      symlinkEscapeBlocked: true,
      processTreeKill: true,
    };
  }

  run(command, cwd, { timeoutMs = 30000, signal, onOutput = null } = {}) {
    return new Promise((resolveRun, rejectRun) => {
      const isWin = process.platform === 'win32';
      const bin = isWin ? 'powershell.exe' : 'sh';
      const args = isWin
        ? ['-NoProfile', '-NonInteractive', '-Command', command]
        : ['-c', command];

      const child = spawn(bin, args, {
        cwd,
        windowsHide: true,
        detached: !isWin,
        env: sanitizeChildEnv(process.env, { allowKeys: this.allowEnvKeys }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killProcessTree(child);
        resolveRun({
          exitCode: 124,
          stdout,
          stderr: `${stderr}\n[timeout after ${timeoutMs}ms]`.trim(),
          timedOut: true,
        });
      }, Math.min(Math.max(500, timeoutMs), 120000));

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killProcessTree(child);
        rejectRun(new Error('命令执行已取消'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk) => {
        const str = chunk.toString('utf8');
        if (stdout.length < this.maxCaptureBytes) stdout += str;
        onOutput?.({ stream: 'stdout', chunk: str });
      });
      child.stderr.on('data', (chunk) => {
        const str = chunk.toString('utf8');
        if (stderr.length < this.maxCaptureBytes) stderr += str;
        onOutput?.({ stream: 'stderr', chunk: str });
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        rejectRun(err);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolveRun({
          exitCode: code ?? 0,
          stdout,
          stderr,
          timedOut: false,
        });
      });
    });
  }
}

export class DockerSandboxAdapter {
  constructor({ image = 'agent-us/worker:1' } = {}) {
    this.image = image;
  }

  capabilities() {
    return {
      mode: 'container',
      networkIsolated: true,
      fsRootReadOnly: true,
      capDropAll: true,
      noNewPrivileges: true,
      memoryLimitMb: 256,
      pidsLimit: 64,
      envSanitized: true,
      pathConfined: true,
      symlinkEscapeBlocked: true,
      processTreeKill: true,
    };
  }

  async run(argv, files = {}, { signal, tty = false } = {}) {
    return dockerSandbox(argv, files, { signal, image: this.image, tty });
  }
}

/**
 * Manages temporary isolated Git Worktrees for parallel write agents with
 * fence/attempt ownership binding, dirty-write preservation, and rehydration.
 */
export class GitWorktreeIsolator {
  constructor(store = null) {
    this.store = store;
    this.active = new Map(); // leaseId -> entry
  }

  async #gitStatusExcludingHandoff(wtPath) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['status', '--porcelain', '--', '.', ':(exclude).agent-us-handoff'],
        {
          cwd: wtPath,
          windowsHide: true,
          timeout: 5000,
        },
      );
      return stdout.trim();
    } catch {
      try {
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
          cwd: wtPath,
          windowsHide: true,
          timeout: 5000,
        });
        return stdout
          .split(/\r?\n/)
          .filter((line) => line.trim() && !line.includes('.agent-us-handoff'))
          .join('\n')
          .trim();
      } catch {
        return '';
      }
    }
  }

  #buildHandle({
    leaseId,
    worktreePath,
    workspaceRoot,
    runId = null,
    baseCommit = null,
    baseRef = null,
    jobId = null,
    fence = null,
    attempt = 1,
    rehydrated = false,
  }) {
    const entry = {
      leaseId,
      path: worktreePath,
      workspaceRoot,
      runId,
      baseCommit,
      baseRef,
      jobId,
      fence,
      attempt,
      rehydrated,
      released: false,
      diffSummary: () => this.#gitStatusExcludingHandoff(worktreePath),
      isDirty: async () => Boolean(await this.#gitStatusExcludingHandoff(worktreePath)),
      release: async ({
        archivedArtifactId = null,
        forceDiscard = false,
        preserveDirty = Boolean(runId),
        leaseGuard = null,
      } = {}) => {
        if (entry.released) return { cleaned: false, reason: 'already_released' };
        entry.released = true;
        this.active.delete(leaseId);

        let dbRow = null;
        if (this.store?.db?.isOpen) {
          try {
            dbRow = this.store.db.prepare('SELECT * FROM worktree_leases WHERE id=?').get(leaseId);
          } catch {
            dbRow = null;
          }
        }

        // Fix C10 / D5: Never touch disk if a newer attempt/fence now owns this worktree lease
        if (dbRow) {
          if (dbRow.fence && entry.fence && dbRow.fence !== entry.fence) {
            return { cleaned: false, preserved: true, reason: 'fence_mismatch' };
          }
          if (
            dbRow.attempt !== null &&
            dbRow.attempt !== undefined &&
            entry.attempt !== null &&
            entry.attempt !== undefined &&
            Number(dbRow.attempt) !== Number(entry.attempt)
          ) {
            return { cleaned: false, preserved: true, reason: 'attempt_mismatch' };
          }
          if (dbRow.jobId && entry.jobId && dbRow.jobId !== entry.jobId) {
            return { cleaned: false, preserved: true, reason: 'job_mismatch' };
          }
          if (dbRow.status === 'cleaned' || dbRow.status === 'orphan_cleaned') {
            return { cleaned: false, reason: 'already_cleaned' };
          }
        }

        if (leaseGuard && !forceDiscard && !checkLeaseHeld(leaseGuard, { allowTerminalTurn: true })) {
          return { cleaned: false, preserved: true, reason: 'lease_lost' };
        }

        const isArchived = Boolean(
          archivedArtifactId || dbRow?.artifactId || dbRow?.cleanupState === 'archived',
        );

        // Fix C8: Only delete worktrees that are archived, explicitly discarded, or clean/empty
        if (!isArchived && !forceDiscard && preserveDirty && existsSync(worktreePath)) {
          const dirty = await entry.isDirty();
          if (dirty) {
            if (this.store?.db?.isOpen) {
              try {
                const now = Date.now();
                this.store.tx(() => {
                  this.store.db
                    .prepare(
                      `UPDATE worktree_leases
                       SET status='preserved', cleanupState='preserved', dirtyWrites=1, updatedAt=?
                       WHERE id=? AND (? IS NULL OR fence IS NULL OR fence=?)`,
                    )
                    .run(now, leaseId, entry.fence, entry.fence);
                });
              } catch {
                // ignore if store closing concurrently
              }
            }
            return { cleaned: false, preserved: true, reason: 'unarchived_dirty_preserved' };
          }
        }

        // Re-verify ownership right before deleting directory
        if (this.store?.db?.isOpen) {
          let canDelete = true;
          try {
            canDelete = this.store.tx(() => {
              const latest = this.store.db
                .prepare('SELECT status, fence, attempt, jobId FROM worktree_leases WHERE id=?')
                .get(leaseId);
              if (!latest) return true;
              if (latest.fence && entry.fence && latest.fence !== entry.fence) return false;
              if (
                latest.attempt !== null &&
                latest.attempt !== undefined &&
                entry.attempt !== null &&
                entry.attempt !== undefined &&
                Number(latest.attempt) !== Number(entry.attempt)
              ) {
                return false;
              }
              if (latest.jobId && entry.jobId && latest.jobId !== entry.jobId) return false;
              if (leaseGuard && !forceDiscard) {
                if (!checkLeaseHeld(leaseGuard, { allowTerminalTurn: true })) return false;
              }
              return true;
            });
          } catch {
            canDelete = false;
          }
          if (!canDelete) {
            return { cleaned: false, preserved: true, reason: 'ownership_changed_before_delete' };
          }
        }

        await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: workspaceRoot,
          windowsHide: true,
          timeout: 8000,
        }).catch(() => {});
        await execFileAsync('git', ['worktree', 'prune'], {
          cwd: workspaceRoot,
          windowsHide: true,
          timeout: 5000,
        }).catch(() => {});
        let rmError = null;
        try {
          rmSync(worktreePath, { recursive: true, force: true, maxRetries: 6, retryDelay: 40 });
        } catch (err) {
          rmError = err;
        }
        const stillExists = existsSync(worktreePath);

        if (this.store?.db?.isOpen) {
          try {
            const now = Date.now();
            if (!stillExists) {
              const cleanupState = isArchived
                ? 'archived'
                : forceDiscard
                  ? 'discarded'
                  : 'clean_empty';
              this.store.tx(() => {
                this.store.db
                  .prepare(
                    `UPDATE worktree_leases
                     SET status='cleaned',
                         cleanupState=?,
                         artifactId=COALESCE(?, artifactId),
                         cleanedAt=?,
                         updatedAt=?
                     WHERE id=? AND (? IS NULL OR fence IS NULL OR fence=?)`,
                  )
                  .run(cleanupState, archivedArtifactId, now, now, leaseId, entry.fence, entry.fence);
              });
            } else {
              this.store.tx(() => {
                this.store.db
                  .prepare(
                    `UPDATE worktree_leases
                     SET status='preserved',
                         cleanupState='cleanup_pending',
                         artifactId=COALESCE(?, artifactId),
                         updatedAt=?
                     WHERE id=? AND (? IS NULL OR fence IS NULL OR fence=?)`,
                  )
                  .run(archivedArtifactId, now, leaseId, entry.fence, entry.fence);
              });
            }
          } catch {
            // ignore if store closing concurrently
          }
        }
        if (stillExists) {
          return {
            cleaned: false,
            preserved: true,
            reason: 'rm_failed_pending_cleanup',
            error: rmError ? String(rmError.message ?? rmError) : null,
          };
        }
        return { cleaned: true, preserved: false, reason: isArchived ? 'archived' : 'cleaned' };
      },
    };
    this.active.set(leaseId, entry);
    return entry;
  }

  #isWorkerProcessLive(workerId) {
    if (!workerId || !this.store?.db?.isOpen) return false;
    const worker = getWorkerRecord(this.store, workerId);
    if (!worker) return false;
    if (worker.status === 'stopped' || worker.status === 'dead') return false;
    const host = osHostname();
    if (
      worker.hostname === host &&
      Number(worker.pid) !== Number(process.pid) &&
      !isPidAlive(worker.pid)
    ) {
      return false;
    }
    return worker.status === 'active';
  }

  #isPreviousOwnerPotentiallyLive(candidate) {
    if (!candidate) return false;
    if (candidate.status === 'preserved') return false;
    if (candidate.workerId && this.#isWorkerProcessLive(candidate.workerId)) {
      return true;
    }
    if (candidate.jobId) {
      const job = this.store.db
        .prepare('SELECT * FROM runtime_jobs WHERE id=?')
        .get(candidate.jobId);
      if (job && (!candidate.fence || !job.fence || job.fence === candidate.fence)) {
        if (job.workerId && this.#isWorkerProcessLive(job.workerId)) {
          return true;
        }
        const ownership = classifyJobOwnership(this.store, job, {
          hostname: osHostname(),
          currentPid: process.pid,
          markDeadInDb: true,
        });
        if (ownership.liveOwner) return true;
      }
    }
    return false;
  }

  async #cloneDirtyFilesIntoWorktree(srcWtPath, dstWtPath) {
    if (!existsSync(srcWtPath) || !existsSync(dstWtPath)) return;
    let statusOut = '';
    try {
      const res = await execFileAsync(
        'git',
        ['status', '--porcelain', '-z', '-uall', '--', '.', ':(exclude).agent-us-handoff'],
        { cwd: srcWtPath, windowsHide: true, timeout: 8000 },
      );
      statusOut = res.stdout;
    } catch {
      return;
    }
    if (!statusOut) return;
    const entries = statusOut.split('\0').filter(Boolean);
    for (let i = 0; i < entries.length; i++) {
      const rec = entries[i];
      if (rec.length < 4) continue;
      const xy = rec.slice(0, 2);
      const relPath = rec.slice(3);
      if (!relPath || relPath.startsWith('.agent-us-handoff')) continue;
      if (xy.includes('R') || xy.includes('C')) {
        // Rename/copy has an extra NUL-separated original path next
        const origRel = entries[++i];
        if (origRel && xy.includes('R')) {
          try {
            const dstOrig = resolveConfinedPath(dstWtPath, origRel).full;
            if (existsSync(dstOrig)) unlinkSync(dstOrig);
          } catch {
            // ignore
          }
        }
      }
      let srcFull;
      let dstFull;
      try {
        srcFull = resolveConfinedPath(srcWtPath, relPath).full;
        dstFull = resolveConfinedPath(dstWtPath, relPath).full;
      } catch {
        continue;
      }
      if (xy.includes('D') && !existsSync(srcFull)) {
        if (existsSync(dstFull)) {
          try {
            unlinkSync(dstFull);
          } catch {
            // ignore
          }
        }
        continue;
      }
      if (existsSync(srcFull)) {
        try {
          const st = lstatSync(srcFull);
          if (st.isFile()) {
            mkdirSync(dirname(dstFull), { recursive: true });
            copyFileSync(srcFull, dstFull);
          } else if (st.isDirectory()) {
            const copyDir = (fromDir, toDir) => {
              mkdirSync(toDir, { recursive: true });
              for (const ent of readdirSync(fromDir, { withFileTypes: true })) {
                if (ent.name === '.git' || ent.name === '.agent-us-handoff') continue;
                const s = join(fromDir, ent.name);
                const d = join(toDir, ent.name);
                if (ent.isDirectory()) copyDir(s, d);
                else if (ent.isFile()) copyFileSync(s, d);
              }
            };
            copyDir(srcFull, dstFull);
          }
        } catch {
          // best-effort dirty file clone
        }
      }
    }
  }

  async acquire(
    workspaceRoot,
    {
      prefix = 'agent-us-wt-',
      ownerId = `owner-${process.pid}`,
      workerId = null,
      sessionId = null,
      runId = null,
      nodeKey = null,
      jobId = null,
      fence = null,
      attempt = 1,
      rehydrateExisting = false,
      leaseGuard = null,
    } = {},
  ) {
    // Support legacy positional string arg: acquire(workspaceRoot, 'custom-prefix-')
    if (typeof arguments[1] === 'string') {
      prefix = arguments[1];
    }
    const wsRoot = resolve(workspaceRoot);
    const effectiveFence = fence ?? leaseGuard?.fence ?? null;
    const effectiveJobId = jobId ?? leaseGuard?.jobId ?? null;
    const effectiveWorkerId = workerId ?? leaseGuard?.workerId ?? null;
    const effectiveAttempt = Number(attempt ?? leaseGuard?.attempt ?? 1);

    // Fix C9 / C10 / P0-10: Atomically lookup, verify liveness, and CAS rehydrate inside one store.tx()
    let cloneSourceCandidate = null;
    if (rehydrateExisting && runId && nodeKey && this.store?.db?.isOpen) {
      const rehydratePlan = this.store.tx(() => {
        const candidate = this.store.db
          .prepare(
            `SELECT * FROM worktree_leases
             WHERE runId=? AND nodeKey=? AND status IN ('preserved', 'active')
             ORDER BY COALESCE(updatedAt, createdAt) DESC, createdAt DESC
             LIMIT 1`,
          )
          .get(runId, nodeKey);

        if (
          !candidate ||
          !candidate.worktreePath ||
          !existsSync(candidate.worktreePath) ||
          isWorktreeOwnerLive(this.store, candidate)
        ) {
          return { mode: 'new' };
        }

        assertLeaseInTx(leaseGuard, { runId });
        const now = Date.now();
        const safeInPlace = !this.#isPreviousOwnerPotentiallyLive(candidate);

        if (safeInPlace) {
          const res = this.store.db
            .prepare(
              `UPDATE worktree_leases
               SET ownerId=?, workerId=?, sessionId=?, jobId=?, fence=?, attempt=?,
                   status='active', cleanupState='active', updatedAt=?
               WHERE id=? AND status=? AND COALESCE(fence,'')=?`,
            )
            .run(
              ownerId,
              effectiveWorkerId,
              sessionId,
              effectiveJobId,
              effectiveFence,
              effectiveAttempt,
              now,
              candidate.id,
              candidate.status,
              candidate.fence ?? '',
            );
          if ((res.changes ?? 0) === 1) {
            return { mode: 'in_place', candidate };
          }
          return { mode: 'new' };
        }

        // Expired lease whose OS process may still be alive: atomically supersede old lease
        // so we clone dirty files into a fresh directory instead of sharing a live path!
        const supRes = this.store.db
          .prepare(
            `UPDATE worktree_leases
             SET status='superseded', cleanupState='superseded', updatedAt=?
             WHERE id=? AND status=? AND COALESCE(fence,'')=?`,
          )
          .run(now, candidate.id, candidate.status, candidate.fence ?? '');
        if ((supRes.changes ?? 0) === 1) {
          return { mode: 'clone', candidate };
        }
        return { mode: 'new' };
      });

      if (rehydratePlan.mode === 'in_place') {
        const candidate = rehydratePlan.candidate;
        return this.#buildHandle({
          leaseId: candidate.id,
          worktreePath: candidate.worktreePath,
          workspaceRoot: wsRoot,
          runId,
          baseCommit: candidate.baseCommit || null,
          baseRef: candidate.baseRef || null,
          jobId: effectiveJobId,
          fence: effectiveFence,
          attempt: effectiveAttempt,
          rehydrated: true,
        });
      }
      if (rehydratePlan.mode === 'clone') {
        cloneSourceCandidate = rehydratePlan.candidate;
      }
    }

    const leaseId = uuid();
    const tmpDir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const targetRev = cloneSourceCandidate?.baseCommit || 'HEAD';
      await execFileAsync('git', ['worktree', 'add', '--detach', tmpDir, targetRev], {
        cwd: wsRoot,
        windowsHide: true,
        timeout: 25000,
      });
      if (cloneSourceCandidate?.worktreePath) {
        await this.#cloneDirtyFilesIntoWorktree(cloneSourceCandidate.worktreePath, tmpDir);
      }
      let baseCommit = null;
      let baseRef = null;
      try {
        baseCommit = (
          await execFileAsync('git', ['rev-parse', 'HEAD'], {
            cwd: tmpDir,
            windowsHide: true,
            timeout: 5000,
          })
        ).stdout.trim();
        baseRef = (
          await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: wsRoot,
            windowsHide: true,
            timeout: 5000,
          })
        ).stdout.trim();
      } catch {
        // best-effort metadata
      }
      if (this.store?.db?.isOpen) {
        const now = Date.now();
        this.store.tx(() => {
          assertLeaseInTx(leaseGuard, { runId });
          this.store.db
            .prepare(
              `INSERT INTO worktree_leases(
                id, ownerId, sessionId, runId, nodeKey, workspaceRoot, worktreePath, status,
                jobId, fence, attempt, workerId, baseCommit, baseRef, cleanupState, dirtyWrites,
                createdAt, updatedAt
              ) VALUES(?,?,?,?,?,?,?,'active',?,?,?,?,?,?,'active',0,?,?)`,
            )
            .run(
              leaseId,
              ownerId,
              sessionId,
              runId,
              nodeKey,
              wsRoot,
              tmpDir,
              effectiveJobId,
              effectiveFence,
              effectiveAttempt,
              effectiveWorkerId,
              baseCommit,
              baseRef,
              now,
              now,
            );
        });
      }
      return this.#buildHandle({
        leaseId,
        worktreePath: tmpDir,
        workspaceRoot: wsRoot,
        runId,
        baseCommit,
        baseRef,
        jobId: effectiveJobId,
        fence: effectiveFence,
        attempt: effectiveAttempt,
        rehydrated: Boolean(cloneSourceCandidate),
      });
    } catch (err) {
      if (cloneSourceCandidate && this.store?.db?.isOpen) {
        try {
          const restoreStatus = cloneSourceCandidate.status || 'active';
          const restoreCleanupState = cloneSourceCandidate.cleanupState ?? restoreStatus;
          this.store.tx(() => {
            this.store.db
              .prepare(
                "UPDATE worktree_leases SET status=?, cleanupState=?, updatedAt=? WHERE id=? AND status='superseded'",
              )
              .run(restoreStatus, restoreCleanupState, Date.now(), cloneSourceCandidate.id);
          });
        } catch {
          // ignore restore failure
        }
      }
      await execFileAsync('git', ['worktree', 'remove', '--force', tmpDir], {
        cwd: wsRoot,
        windowsHide: true,
        timeout: 5000,
      }).catch(() => {});
      try {
        rmSync(tmpDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 });
      } catch {
        // ignore
      }
      throw err;
    }
  }

  async cleanupOrphans({ activeOwnerIds = new Set(), forceDiscard = false } = {}) {
    if (!this.store?.db?.isOpen) return { cleaned: 0, preserved: 0, skippedLive: 0, paths: [] };
    const rows = this.store.db
      .prepare("SELECT * FROM worktree_leases WHERE status IN ('active','preserved','superseded') ORDER BY createdAt ASC")
      .all();
    const cleanedPaths = [];
    let preservedCount = 0;
    let skippedLive = 0;

    for (const r of rows) {
      if (
        this.active.has(r.id) ||
        activeOwnerIds.has(r.ownerId) ||
        (r.workerId && activeOwnerIds.has(r.workerId))
      ) {
        skippedLive++;
        continue;
      }

      // Fix D2 / D3 / C10: Never delete a worktree owned by a live worker/job lease!
      if (isWorktreeOwnerLive(this.store, r)) {
        skippedLive++;
        continue;
      }
      if (r.status === 'superseded' && r.workerId && this.#isWorkerProcessLive(r.workerId)) {
        skippedLive++;
        continue;
      }

      // Fix C8 / C9: Preserve unarchived dirty worktrees unless owning run/session was cancelled, superseded, or forceDiscard
      let ownerCancelled = r.status === 'superseded';
      let nodeRecoverable = false;
      if (r.runId) {
        const runRow = this.store.db.prepare('SELECT status FROM swarm_runs WHERE id=?').get(r.runId);
        if (runRow?.status === 'cancelled') ownerCancelled = true;
        if (r.nodeKey) {
          const nodeRow = this.store.db
            .prepare('SELECT status FROM swarm_nodes WHERE runId=? AND nodeKey=?')
            .get(r.runId, r.nodeKey);
          if (nodeRow && !['completed', 'failed', 'cancelled'].includes(nodeRow.status)) {
            nodeRecoverable = true;
          }
          if (nodeRow?.status === 'cancelled') ownerCancelled = true;
        }
      } else if (r.sessionId) {
        const sessRow = this.store.db
          .prepare('SELECT state FROM direct_sessions WHERE id=?')
          .get(r.sessionId);
        if (sessRow?.state === 'cancelled') ownerCancelled = true;
      }

      if (!forceDiscard && !ownerCancelled && !r.artifactId && existsSync(r.worktreePath)) {
        const dirty = Boolean(await this.#gitStatusExcludingHandoff(r.worktreePath));
        if (!this.store?.db?.isOpen) break;
        if (dirty || nodeRecoverable) {
          if (dirty) {
            const now = Date.now();
            try {
              this.store.tx(() => {
                this.store.db
                  .prepare(
                    "UPDATE worktree_leases SET status='preserved', cleanupState='preserved', dirtyWrites=1, updatedAt=? WHERE id=? AND status='active'",
                  )
                  .run(now, r.id);
              });
            } catch {
              // ignore if store closing concurrently
            }
          }
          preservedCount++;
          continue;
        }
      }

      if (existsSync(r.workspaceRoot)) {
        await execFileAsync('git', ['worktree', 'remove', '--force', r.worktreePath], {
          cwd: r.workspaceRoot,
          windowsHide: true,
          timeout: 8000,
        }).catch(() => {});
        await execFileAsync('git', ['worktree', 'prune'], {
          cwd: r.workspaceRoot,
          windowsHide: true,
          timeout: 5000,
        }).catch(() => {});
      }
      try {
        rmSync(r.worktreePath, { recursive: true, force: true, maxRetries: 6, retryDelay: 40 });
      } catch {
        // ignore if locked; verify existence below before marking orphan_cleaned
      }
      if (!this.store?.db?.isOpen) break;
      if (existsSync(r.worktreePath)) {
        preservedCount++;
        continue;
      }
      const now = Date.now();
      try {
        this.store.tx(() => {
          this.store.db
            .prepare(
              "UPDATE worktree_leases SET status='orphan_cleaned', cleanupState='orphan_cleaned', cleanedAt=?, updatedAt=? WHERE id=?",
            )
            .run(now, now, r.id);
        });
      } catch {
        // ignore if store closing concurrently
      }
      cleanedPaths.push(r.worktreePath);
    }
    return { cleaned: cleanedPaths.length, preserved: preservedCount, skippedLive, paths: cleanedPaths };
  }

  async cleanupAll({ preserveDirty = true } = {}) {
    await Promise.allSettled(
      [...this.active.values()].map((e) => e.release({ preserveDirty })),
    );
  }
}
