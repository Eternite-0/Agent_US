import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { Fault, id as uuid } from '../store.js';
import { canonicalJson } from '../integrity.js';
import { PolicyError } from '../kernel/errors.js';
import { assertLeaseInTx } from '../durable/lease-guard.js';
import { withTraceContext } from '../observability/trace.js';
import { intersectPolicies } from '../tools/policy.js';
import { resolveConfinedPath } from '../tools/sandbox.js';
import { EFFECT_CLASSES, RISK_LEVELS, defineTool } from '../tools/registry.js';

const execFileAsync = promisify(execFile);

export const SWARM_ARTIFACT_HANDOFF_DIR = '.agent-us-handoff';
export const SWARM_ARTIFACT_URI_PREFIX = 'swarm-artifact://';

const MUTATING_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'bash']);

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function isBinaryBuffer(buf) {
  if (!buf || !buf.length) return false;
  const sampleLen = Math.min(buf.length, 8192);
  let suspicious = 0;
  for (let i = 0; i < sampleLen; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / sampleLen > 0.3;
}

function normalizeLineEndingsToLf(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return buf;
  const text = buf.toString('utf8');
  if (!text.includes('\r\n')) return buf;
  return Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8');
}

function matchesBaseContent(parentBuf, baseSha256, binary = false) {
  if (!baseSha256) return true;
  if (sha256Buffer(parentBuf) === baseSha256) return true;
  if (!binary && !isBinaryBuffer(parentBuf)) {
    const lfBuf = normalizeLineEndingsToLf(parentBuf);
    if (lfBuf !== parentBuf && sha256Buffer(lfBuf) === baseSha256) {
      return true;
    }
  }
  return false;
}

function parseGitModeMapNull(rawBuf) {
  const text = Buffer.isBuffer(rawBuf) ? rawBuf.toString('utf8') : String(rawBuf ?? '');
  const map = new Map();
  if (!text) return map;
  for (const record of text.split('\0')) {
    if (!record) continue;
    const tabIdx = record.indexOf('\t');
    if (tabIdx <= 0) continue;
    const header = record.slice(0, tabIdx).trim();
    const path = record.slice(tabIdx + 1);
    const mode = header.split(/\s+/)[0];
    if (mode && path) map.set(path, mode);
  }
  return map;
}

function isCaseOnlyRenamePath(prevFull, nextFull) {
  return prevFull !== nextFull && prevFull.toLowerCase() === nextFull.toLowerCase();
}

function validateSymlinkTargetInsideRoot(workspaceRoot, linkFullPath, targetStr) {
  const linkText = String(targetStr ?? '');
  if (!linkText || isAbsolute(linkText)) {
    throw new PolicyError('POLICY_DENIED', {
      status: 403,
      message: `Refusing to apply symlink with absolute or empty target: ${linkText}`,
    });
  }
  const root = resolve(workspaceRoot);
  const resolvedTarget = resolve(dirname(linkFullPath), linkText);
  const rel = relative(root, resolvedTarget);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new PolicyError('POLICY_DENIED', {
      status: 403,
      message: `Refusing to apply symlink escaping workspace root: ${linkText}`,
    });
  }
}

function normalizePosixRel(relPath) {
  const clean = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  const parts = clean.split('/').filter(Boolean);
  if (!parts.length || parts.includes('..') || parts.includes('.git')) {
    throw new Fault('INVALID_ARTIFACT_PATH', 400, { path: relPath });
  }
  return parts.join('/');
}

function resolveInsideDir(baseDir, relPath) {
  const root = resolve(baseDir);
  const norm = normalizePosixRel(relPath);
  const full = resolve(root, norm);
  const rel = relative(root, full);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Fault('INVALID_ARTIFACT_PATH', 400, { path: relPath });
  }
  return { full, rel: norm };
}

function computeBundleDigest(baseCommit, entries) {
  const normalized = [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((e) => ({
      path: e.path,
      changeType: e.changeType,
      previousPath: e.previousPath ?? null,
      binary: Boolean(e.binary),
      mode: e.mode ?? '100644',
      size: Number(e.size ?? 0),
      baseSha256: e.baseSha256 ?? null,
      sha256: e.sha256 ?? null,
    }));
  return sha256Buffer(
    Buffer.from(canonicalJson({ version: 1, baseCommit: baseCommit ?? null, entries: normalized }), 'utf8'),
  );
}

async function runGitRaw(cwd, args, { env = process.env, encoding = 'utf8', maxBuffer = 64 * 1024 * 1024 } = {}) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env,
    encoding,
    windowsHide: true,
    timeout: 15000,
    maxBuffer,
  });
  return stdout;
}

function parseRawNullDiff(rawBuf) {
  const text = Buffer.isBuffer(rawBuf) ? rawBuf.toString('utf8') : String(rawBuf ?? '');
  if (!text) return [];
  const parts = text.split('\0');
  const parsed = [];
  let i = 0;
  while (i < parts.length) {
    const header = parts[i];
    if (!header) {
      i++;
      continue;
    }
    const m = /^:(\d+)\s+(\d+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([A-Z]\d*)$/.exec(header.trim());
    if (!m) {
      i++;
      continue;
    }
    const [, oldMode, newMode, oldHash, newHash, statusRaw] = m;
    const code = statusRaw[0];
    if (code === 'R' || code === 'C') {
      const prevPath = parts[i + 1];
      const nextPath = parts[i + 2];
      i += 3;
      if (!prevPath || !nextPath) continue;
      parsed.push({
        changeType: code === 'R' ? 'renamed' : 'added',
        previousPath: code === 'R' ? prevPath : null,
        path: nextPath,
        oldMode,
        newMode,
        oldHash,
        newHash,
      });
    } else {
      const filePath = parts[i + 1];
      i += 2;
      if (!filePath) continue;
      const changeType =
        code === 'A'
          ? 'added'
          : code === 'D'
            ? 'deleted'
            : 'modified';
      parsed.push({
        changeType,
        previousPath: null,
        path: filePath,
        oldMode,
        newMode,
        oldHash,
        newHash,
      });
    }
  }
  return parsed;
}

function hydrateArtifactRow(row) {
  if (!row) return null;
  const manifest = parseJsonSafe(row.manifestJson, { version: 1, entries: [] });
  return {
    ...row,
    manifest,
    files: Array.isArray(manifest.entries) ? manifest.entries : [],
    applyResult: parseJsonSafe(row.applyResultJson, null),
  };
}

/**
 * Lightweight durable artifact storage for isolated Git Worktrees.
 * Separates archive, verify, read/handoff, and guarded apply-to-parent actions.
 */
export class SwarmArtifactManager {
  #activeApplies = new Set();

  constructor({ store, storageRoot }) {
    this.store = store;
    this.storageRoot = resolve(storageRoot);
    this.failNextArchive = null; // Deterministic test failpoint
  }

  #ensureStorageRoot() {
    mkdirSync(this.storageRoot, { recursive: true });
  }

  /**
   * Captures all isolated worktree changes (tracked edits, untracked adds, deletions, renames,
   * binary files, file modes) to durable local bundle + SQLite metadata BEFORE worktree cleanup.
   */
  async archiveWorktree({
    runId,
    nodeId,
    nodeKey,
    childSessionId = null,
    childTurnId = null,
    jobId = null,
    attempt = 1,
    ownerId = 'unknown',
    fence = null,
    workspaceRoot,
    worktreePath,
    worktreeLeaseId = null,
    baseCommit = null,
    baseRef = null,
    leaseGuard = null,
  }) {
    if (!runId || !nodeId || !nodeKey || !worktreePath) {
      throw new Fault('INVALID_ARTIFACT_ARCHIVE_ARGS', 400, {
        message: 'runId, nodeId, nodeKey, and worktreePath are required to archive worktree artifacts',
      });
    }
    if (!existsSync(worktreePath)) {
      throw new Fault('WORKTREE_MISSING', 404, {
        message: `Worktree path does not exist for archiving: ${worktreePath}`,
      });
    }

    // Fail-fast lease check before expensive disk work
    assertLeaseInTx(leaseGuard, { runId, nodeId, turnId: childTurnId, sessionId: childSessionId });

    // Deterministic failpoint for testing failure-before-completion semantics (Fix C5)
    if (this.failNextArchive) {
      const injected = this.failNextArchive;
      this.failNextArchive = null;
      throw typeof injected === 'function' ? injected() : injected;
    }

    const artifactId = uuid();
    return withTraceContext(
      { runId, nodeId, artifactId, sessionId: childSessionId, turnId: childTurnId },
      async () => {
        const uri = `${SWARM_ARTIFACT_URI_PREFIX}${runId}/${artifactId}`;
        const safeRunDir = String(runId).replace(/[^a-zA-Z0-9._-]/g, '_');
        const artifactDir = join(this.storageRoot, safeRunDir, artifactId);
        const filesDir = join(artifactDir, 'files');
        const tmpIndex = join(tmpdir(), `agent-us-art-idx-${artifactId}`);

        let committed = false;
        try {
          this.#ensureStorageRoot();
          mkdirSync(filesDir, { recursive: true });

          const resolvedBaseCommit =
            baseCommit ||
            (await runGitRaw(worktreePath, ['rev-parse', 'HEAD'])).trim();
          let resolvedBaseRef = baseRef;
          if (!resolvedBaseRef) {
            try {
              resolvedBaseRef = (await runGitRaw(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
            } catch {
              resolvedBaseRef = 'HEAD';
            }
          }

          // Copy existing worktree index to temp GIT_INDEX_FILE so staged chmods (+x/-x) are preserved
          // without mutating the worktree's real git index.
          let realIndexPath = null;
          try {
            const idxOut = (await runGitRaw(worktreePath, ['rev-parse', '--git-path', 'index'])).trim();
            realIndexPath = isAbsolute(idxOut) ? idxOut : resolve(worktreePath, idxOut);
          } catch {
            realIndexPath = null;
          }
          const gitEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
          const explicitExecPaths = [];
          const explicitNoExecPaths = [];
          if (realIndexPath && existsSync(realIndexPath)) {
            copyFileSync(realIndexPath, tmpIndex);
            // Ubuntu/POSIX core.filemode=true fix: record explicitly staged executable bit overrides
            // before `git add -A` can overwrite them from working-tree stat bits.
            try {
              const [headTreeBuf, stagedBuf] = await Promise.all([
                runGitRaw(worktreePath, ['ls-tree', '-r', '-z', resolvedBaseCommit], {
                  encoding: 'buffer',
                }),
                runGitRaw(worktreePath, ['ls-files', '--stage', '-z'], {
                  env: gitEnv,
                  encoding: 'buffer',
                }),
              ]);
              const headModes = parseGitModeMapNull(headTreeBuf);
              const stagedModes = parseGitModeMapNull(stagedBuf);
              for (const [p, stagedMode] of stagedModes.entries()) {
                if (
                  p === SWARM_ARTIFACT_HANDOFF_DIR ||
                  p.startsWith(`${SWARM_ARTIFACT_HANDOFF_DIR}/`)
                ) {
                  continue;
                }
                const headMode = headModes.get(p);
                if (stagedMode === '100755' && headMode !== '100755') {
                  explicitExecPaths.push(p);
                } else if (stagedMode === '100644' && headMode === '100755') {
                  explicitNoExecPaths.push(p);
                }
              }
            } catch {
              // fallback gracefully if ls-tree/ls-files fails on unborn repo
            }
          } else {
            await runGitRaw(worktreePath, ['read-tree', resolvedBaseCommit], { env: gitEnv });
          }

          // Stage all modifications, untracked files, and deletions into temp index, excluding handoff dir
          await runGitRaw(
            worktreePath,
            ['add', '-A', '--', '.', `:(exclude)${SWARM_ARTIFACT_HANDOFF_DIR}`],
            { env: gitEnv },
          );
          await runGitRaw(
            worktreePath,
            ['rm', '-rf', '--cached', '--ignore-unmatch', SWARM_ARTIFACT_HANDOFF_DIR],
            { env: gitEnv },
          ).catch(() => {});

          // Restore explicitly staged +x / -x mode overrides on files still present in tmpIndex
          if (explicitExecPaths.length > 0 || explicitNoExecPaths.length > 0) {
            let currentIndexedPaths = null;
            try {
              const afterBuf = await runGitRaw(worktreePath, ['ls-files', '-z'], {
                env: gitEnv,
                encoding: 'buffer',
              });
              currentIndexedPaths = new Set(afterBuf.toString('utf8').split('\0').filter(Boolean));
            } catch {
              currentIndexedPaths = null;
            }
            const applyChmodBatch = async (flag, paths) => {
              const alive = currentIndexedPaths
                ? paths.filter((p) => currentIndexedPaths.has(p))
                : paths.filter((p) => existsSync(resolveInsideDir(worktreePath, p).full));
              for (let i = 0; i < alive.length; i += 100) {
                const chunk = alive.slice(i, i + 100);
                await runGitRaw(worktreePath, ['update-index', flag, '--', ...chunk], { env: gitEnv });
              }
            };
            if (explicitExecPaths.length > 0) {
              await applyChmodBatch('--chmod=+x', explicitExecPaths);
            }
            if (explicitNoExecPaths.length > 0) {
              await applyChmodBatch('--chmod=-x', explicitNoExecPaths);
            }
          }

          const rawDiffBuf = await runGitRaw(
            worktreePath,
            ['diff', '--cached', '--raw', '-z', '-M', resolvedBaseCommit],
            { env: gitEnv, encoding: 'buffer' },
          );
          const patchBuf = await runGitRaw(
            worktreePath,
            ['diff', '--cached', '--binary', '-M', resolvedBaseCommit],
            { env: gitEnv, encoding: 'buffer' },
          ).catch(() => Buffer.alloc(0));

          const rawEntries = parseRawNullDiff(rawDiffBuf).filter(
            (e) =>
              !e.path.startsWith(`${SWARM_ARTIFACT_HANDOFF_DIR}/`) &&
              e.path !== SWARM_ARTIFACT_HANDOFF_DIR,
          );

          const entries = [];
          let totalBytes = 0;

          for (const item of rawEntries) {
            const normPath = normalizePosixRel(item.path);
            const normPrev = item.previousPath ? normalizePosixRel(item.previousPath) : null;

            let baseSha256 = null;
            if (item.oldHash && !/^0+$/.test(item.oldHash)) {
              try {
                const baseBlob = await runGitRaw(
                  worktreePath,
                  ['cat-file', 'blob', item.oldHash],
                  { encoding: 'buffer' },
                );
                baseSha256 = sha256Buffer(baseBlob);
              } catch {
                baseSha256 = null;
              }
            }

            if (item.changeType === 'deleted') {
              entries.push({
                path: normPath,
                changeType: 'deleted',
                previousPath: null,
                binary: false,
                mode: item.oldMode || '100644',
                size: 0,
                baseSha256,
                sha256: null,
                contentFile: null,
              });
              continue;
            }

            // Symlink-safe archiving: inspect lstat BEFORE reading so broken or external symlinks
            // never throw ENOENT or silently dereference host files outside the worktree.
            const lexSrc = resolveInsideDir(worktreePath, normPath);
            let lstatInfo = null;
            try {
              lstatInfo = lstatSync(lexSrc.full);
            } catch {
              lstatInfo = null;
            }
            const isSymlink = item.newMode === '120000' || Boolean(lstatInfo?.isSymbolicLink?.());

            let contentBuf;
            let effectiveMode = item.newMode || '100644';
            let binary = false;

            if (isSymlink) {
              const parentRel = dirname(normPath);
              if (parentRel && parentRel !== '.') {
                resolveConfinedPath(worktreePath, parentRel);
              }
              const linkTarget = readlinkSync(lexSrc.full);
              contentBuf = Buffer.from(linkTarget, 'utf8');
              effectiveMode = '120000';
              binary = false;
            } else {
              const src = resolveConfinedPath(worktreePath, normPath);
              contentBuf = readFileSync(src.full);
              binary = isBinaryBuffer(contentBuf);
              if (process.platform !== 'win32') {
                try {
                  const st = statSync(src.full);
                  if ((st.mode & 0o111) !== 0 && effectiveMode === '100644') {
                    effectiveMode = '100755';
                  }
                } catch {
                  // keep git mode
                }
              }
            }

            const contentSha = sha256Buffer(contentBuf);
            const dst = resolveInsideDir(filesDir, normPath);
            mkdirSync(dirname(dst.full), { recursive: true });
            writeFileSync(dst.full, contentBuf);

            totalBytes += contentBuf.length;
            entries.push({
              path: normPath,
              changeType: item.changeType,
              previousPath: normPrev,
              binary,
              mode: effectiveMode,
              size: contentBuf.length,
              baseSha256,
              sha256: contentSha,
              contentFile: `files/${normPath}`,
            });
          }

          entries.sort((a, b) => a.path.localeCompare(b.path));
          const patchFile = 'changes.patch';
          writeFileSync(join(artifactDir, patchFile), patchBuf);

          const bundleSha256 = computeBundleDigest(resolvedBaseCommit, entries);
          const now = Date.now();
          const manifest = {
            version: 1,
            artifactId,
            uri,
            runId,
            nodeId,
            nodeKey,
            childSessionId,
            childTurnId,
            jobId,
            attempt: Number(attempt || 1),
            ownerId: String(ownerId),
            fence: fence ?? leaseGuard?.fence ?? null,
            workspaceRoot: resolve(workspaceRoot),
            baseCommit: resolvedBaseCommit,
            baseRef: resolvedBaseRef,
            bundleSha256,
            patchFile,
            fileCount: entries.length,
            totalBytes,
            createdAt: now,
            entries,
          };

          const manifestTmp = join(artifactDir, 'manifest.json.tmp');
          const manifestPath = join(artifactDir, 'manifest.json');
          writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2), 'utf8');
          renameSync(manifestTmp, manifestPath);

          // Atomic DB registration enforced by leaseGuard INSIDE SQLite transaction (Fix C5 + C10 + D5)
          const effectiveFence = fence ?? leaseGuard?.fence ?? null;
          this.store.tx(() => {
            assertLeaseInTx(leaseGuard, {
              runId,
              nodeId,
              turnId: childTurnId,
              sessionId: childSessionId,
            });
            this.store.db
              .prepare(
                `INSERT INTO swarm_artifacts(
                  id, uri, runId, nodeId, nodeKey, childSessionId, childTurnId, jobId,
                  attempt, ownerId, fence, workspaceRoot, worktreePath, baseCommit, baseRef,
                  storagePath, bundleSha256, manifestJson, fileCount, totalBytes, status,
                  createdAt, updatedAt
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'archived',?,?)`,
              )
              .run(
                artifactId,
                uri,
                runId,
                nodeId,
                nodeKey,
                childSessionId,
                childTurnId,
                jobId ?? leaseGuard?.jobId ?? null,
                Number(attempt || 1),
                String(ownerId),
                effectiveFence,
                resolve(workspaceRoot),
                worktreePath,
                resolvedBaseCommit,
                resolvedBaseRef,
                artifactDir,
                bundleSha256,
                JSON.stringify(manifest),
                entries.length,
                totalBytes,
                now,
                now,
              );
            if (worktreeLeaseId) {
              this.store.db
                .prepare(
                  `UPDATE worktree_leases
                   SET artifactId=?, cleanupState='archived', dirtyWrites=0, updatedAt=?
                   WHERE id=? AND (? IS NULL OR fence IS NULL OR fence=?)`,
                )
                .run(artifactId, now, worktreeLeaseId, effectiveFence, effectiveFence);
            }
          });

          committed = true;
          return this.getArtifact(artifactId);
        } finally {
          try {
            if (existsSync(tmpIndex)) unlinkSync(tmpIndex);
          } catch {
            // ignore temp index cleanup error
          }
          if (!committed) {
            try {
              rmSync(artifactDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
            } catch {
              // ignore cleanup error
            }
          }
        }
      },
    );
  }

  getArtifact(idOrUri) {
    if (!this.store?.db?.isOpen || !idOrUri) return null;
    const key = String(idOrUri);
    const row = key.startsWith(SWARM_ARTIFACT_URI_PREFIX)
      ? this.store.db.prepare('SELECT * FROM swarm_artifacts WHERE uri=?').get(key)
      : this.store.db.prepare('SELECT * FROM swarm_artifacts WHERE id=?').get(key);
    return hydrateArtifactRow(row);
  }

  listArtifacts({ runId = null, nodeKey = null, nodeId = null, excludeSuperseded = false, limit = 200 } = {}) {
    if (!this.store?.db?.isOpen) return [];
    const where = [];
    const params = [];
    if (runId) {
      where.push('runId=?');
      params.push(runId);
    }
    if (nodeKey) {
      where.push('nodeKey=?');
      params.push(nodeKey);
    }
    if (nodeId) {
      where.push('nodeId=?');
      params.push(nodeId);
    }
    if (excludeSuperseded) {
      where.push("status != 'superseded'");
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const cap = Math.min(500, Math.max(1, Number(limit || 200)));
    return this.store.db
      .prepare(`SELECT * FROM swarm_artifacts ${clause} ORDER BY createdAt DESC, attempt DESC, rowid DESC LIMIT ?`)
      .all(...params, cap)
      .map(hydrateArtifactRow);
  }

  getLatestNodeArtifact(runId, nodeKey) {
    if (!this.store?.db?.isOpen || !runId || !nodeKey) return null;
    const row = this.store.db
      .prepare(
        `SELECT * FROM swarm_artifacts
         WHERE runId=? AND nodeKey=? AND status != 'superseded'
         ORDER BY attempt DESC, createdAt DESC, rowid DESC
         LIMIT 1`,
      )
      .get(runId, nodeKey);
    return hydrateArtifactRow(row);
  }

  /**
   * Marks non-applied artifacts for a replanned/superseded node as `'superseded'`
   * so downstream consumers and verification never pick up obsolete attempts.
   */
  supersedeNodeArtifacts(runId, nodeIdOrKey, { leaseGuard = null } = {}) {
    if (!this.store?.db?.isOpen || !runId || !nodeIdOrKey) return 0;
    const now = Date.now();
    return this.store.tx(() => {
      assertLeaseInTx(leaseGuard, { runId });
      const res = this.store.db
        .prepare(
          `UPDATE swarm_artifacts
           SET status='superseded', updatedAt=?
           WHERE runId=? AND (nodeId=? OR nodeKey=?) AND status NOT IN ('applied', 'superseded')`,
        )
        .run(now, runId, String(nodeIdOrKey), String(nodeIdOrKey));
      return Number(res.changes ?? 0);
    });
  }

  /**
   * Reaps orphaned artifact directories written on disk whose SQLite metadata row never committed
   * (e.g., process crash between disk write and SQLite commit).
   */
  cleanupOrphanArtifacts({ minAgeMs = 2000 } = {}) {
    const report = { scanned: 0, removed: 0, skippedRecent: 0, errors: [] };
    if (!this.store?.db?.isOpen || !existsSync(this.storageRoot)) return report;
    const cutoff = Date.now() - Math.max(0, Number(minAgeMs || 0));
    let runDirs = [];
    try {
      runDirs = readdirSync(this.storageRoot, { withFileTypes: true });
    } catch {
      return report;
    }
    const existsStmt = this.store.db.prepare('SELECT 1 FROM swarm_artifacts WHERE id=?');
    for (const runEntry of runDirs) {
      if (!runEntry.isDirectory()) continue;
      const runDirPath = join(this.storageRoot, runEntry.name);
      let artEntries = [];
      try {
        artEntries = readdirSync(runDirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const artEntry of artEntries) {
        if (!artEntry.isDirectory()) continue;
        report.scanned++;
        const artId = artEntry.name;
        const artPath = join(runDirPath, artId);
        if (existsStmt.get(artId)) continue;
        try {
          const st = statSync(artPath);
          if (st.mtimeMs > cutoff) {
            report.skippedRecent++;
            continue;
          }
          rmSync(artPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
          report.removed++;
        } catch (err) {
          report.errors.push({ path: artPath, error: String(err?.message ?? err) });
        }
      }
    }
    return report;
  }

  /**
   * Rehydrates a verified archived artifact's file changes into a fresh worktree directory
   * (used during crash recovery when the original worktree was already cleaned up after archiving).
   */
  rehydrateArtifactToWorktree(idOrUri, targetWorktreePath) {
    const verification = this.verifyArtifact(idOrUri);
    if (!verification.ok) {
      throw new Fault('ARTIFACT_VERIFICATION_FAILED', 422, {
        message: `Cannot rehydrate corrupted artifact ${idOrUri}: ${verification.errors.join('; ')}`,
        errors: verification.errors,
      });
    }
    if (!targetWorktreePath || !existsSync(targetWorktreePath)) {
      throw new Fault('WORKTREE_MISSING', 404, {
        message: `Target worktree path does not exist for rehydration: ${targetWorktreePath}`,
      });
    }
    const artifact = verification.artifact;
    const root = resolve(targetWorktreePath);
    let restoredCount = 0;

    for (const entry of artifact.files) {
      if (entry.changeType === 'deleted') {
        const target = resolveConfinedPath(root, entry.path);
        if (existsSync(target.full)) unlinkSync(target.full);
        restoredCount++;
        continue;
      }
      const readRes = this.readArtifactFile(artifact.id, entry.path);
      const target =
        entry.mode === '120000'
          ? resolveInsideDir(root, entry.path)
          : resolveConfinedPath(root, entry.path);
      const prevTarget = entry.previousPath ? resolveConfinedPath(root, entry.previousPath) : null;
      const caseOnlyRename =
        entry.changeType === 'renamed' && prevTarget && isCaseOnlyRenamePath(prevTarget.full, target.full);

      if (caseOnlyRename && existsSync(prevTarget.full)) {
        const tmpName = join(dirname(target.full), `.agent-us-rehydrate-${uuid()}`);
        renameSync(prevTarget.full, tmpName);
        unlinkSync(tmpName);
      }

      mkdirSync(dirname(target.full), { recursive: true });
      if (entry.mode === '120000') {
        const linkTarget = readRes.buffer.toString('utf8');
        validateSymlinkTargetInsideRoot(root, target.full, linkTarget);
        try {
          if (lstatSync(target.full)) unlinkSync(target.full);
        } catch {
          // ignore if not present
        }
        symlinkSync(linkTarget, target.full);
      } else {
        writeFileSync(target.full, readRes.buffer);
        if (process.platform !== 'win32' && entry.mode === '100755') {
          try {
            chmodSync(target.full, 0o755);
          } catch {
            // ignore
          }
        }
      }
      if (
        entry.changeType === 'renamed' &&
        prevTarget &&
        !caseOnlyRename &&
        prevTarget.full !== target.full &&
        existsSync(prevTarget.full)
      ) {
        unlinkSync(prevTarget.full);
      }
      restoredCount++;
    }

    return {
      ok: true,
      artifactId: artifact.id,
      uri: artifact.uri,
      restoredCount,
    };
  }

  /**
   * Verifies on-disk manifest, every stored file's SHA-256 digest & size, and bundleSha256.
   */
  verifyArtifact(idOrUri) {
    const artifact = this.getArtifact(idOrUri);
    if (!artifact) {
      throw new Fault('ARTIFACT_NOT_FOUND', 404, { idOrUri });
    }
    const errors = [];
    let checkedFiles = 0;

    if (!artifact.storagePath || !existsSync(artifact.storagePath)) {
      errors.push(`Artifact storage path missing: ${artifact.storagePath}`);
      return {
        ok: false,
        artifactId: artifact.id,
        uri: artifact.uri,
        bundleSha256: artifact.bundleSha256,
        fileCount: artifact.fileCount,
        checkedFiles: 0,
        errors,
        artifact,
      };
    }

    const manifestPath = join(artifact.storagePath, 'manifest.json');
    if (!existsSync(manifestPath)) {
      errors.push('manifest.json missing on disk');
      return {
        ok: false,
        artifactId: artifact.id,
        uri: artifact.uri,
        bundleSha256: artifact.bundleSha256,
        fileCount: artifact.fileCount,
        checkedFiles: 0,
        errors,
        artifact,
      };
    }

    let diskManifest = null;
    try {
      diskManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      errors.push(`manifest.json invalid JSON: ${String(err?.message ?? err)}`);
      return {
        ok: false,
        artifactId: artifact.id,
        uri: artifact.uri,
        bundleSha256: artifact.bundleSha256,
        fileCount: artifact.fileCount,
        checkedFiles: 0,
        errors,
        artifact,
      };
    }

    if (diskManifest.artifactId !== artifact.id) {
      errors.push(`Manifest artifactId mismatch: ${diskManifest.artifactId} !== ${artifact.id}`);
    }
    const entries = Array.isArray(diskManifest.entries) ? diskManifest.entries : [];
    const filesDir = join(artifact.storagePath, 'files');

    for (const entry of entries) {
      if (entry.changeType === 'deleted') continue;
      let resolved;
      try {
        resolved = resolveInsideDir(filesDir, entry.path);
      } catch {
        errors.push(`Unsafe path in manifest: ${entry.path}`);
        continue;
      }
      if (!existsSync(resolved.full)) {
        errors.push(`Missing file payload on disk: ${entry.path}`);
        continue;
      }
      const buf = readFileSync(resolved.full);
      const actualSha = sha256Buffer(buf);
      if (actualSha !== entry.sha256) {
        errors.push(`SHA-256 mismatch for ${entry.path}: expected ${entry.sha256}, actual ${actualSha}`);
      }
      if (buf.length !== Number(entry.size ?? 0)) {
        errors.push(`Size mismatch for ${entry.path}: expected ${entry.size}, actual ${buf.length}`);
      }
      checkedFiles++;
    }

    const recomputedBundle = computeBundleDigest(diskManifest.baseCommit ?? artifact.baseCommit, entries);
    if (recomputedBundle !== artifact.bundleSha256 || recomputedBundle !== diskManifest.bundleSha256) {
      errors.push(
        `bundleSha256 mismatch: db=${artifact.bundleSha256}, manifest=${diskManifest.bundleSha256}, computed=${recomputedBundle}`,
      );
    }

    return {
      ok: errors.length === 0,
      artifactId: artifact.id,
      uri: artifact.uri,
      bundleSha256: recomputedBundle,
      fileCount: entries.length,
      checkedFiles,
      errors,
      artifact,
    };
  }

  /**
   * Reads a specific file from an archived artifact with path confinement and SHA-256 verification.
   */
  readArtifactFile(idOrUri, relPath) {
    const artifact = this.getArtifact(idOrUri);
    if (!artifact) {
      throw new Fault('ARTIFACT_NOT_FOUND', 404, { idOrUri });
    }
    const norm = normalizePosixRel(relPath);
    const entry = artifact.files.find((e) => e.path === norm);
    if (!entry) {
      throw new Fault('ARTIFACT_FILE_NOT_FOUND', 404, { artifactId: artifact.id, path: norm });
    }
    if (entry.changeType === 'deleted') {
      return { entry, deleted: true, buffer: null, text: null, base64: null, verified: true };
    }
    const filesDir = join(artifact.storagePath, 'files');
    const resolved = resolveInsideDir(filesDir, norm);
    if (!existsSync(resolved.full)) {
      throw new Fault('ARTIFACT_CORRUPTED', 500, {
        message: `Stored artifact file missing: ${norm}`,
        artifactId: artifact.id,
      });
    }
    const buffer = readFileSync(resolved.full);
    const actualSha = sha256Buffer(buffer);
    if (actualSha !== entry.sha256) {
      throw new Fault('ARTIFACT_CORRUPTED', 500, {
        message: `Artifact file SHA-256 verification failed for ${norm}`,
        artifactId: artifact.id,
        expected: entry.sha256,
        actual: actualSha,
      });
    }
    return {
      entry,
      deleted: false,
      buffer,
      text: entry.binary ? null : buffer.toString('utf8'),
      base64: buffer.toString('base64'),
      verified: true,
    };
  }

  /**
   * Materializes predecessor artifacts into `<targetWorktreeRoot>/.agent-us-handoff/<nodeKey>/...`
   * so successor isolated worktrees can directly read predecessor files without polluting parent workspace.
   */
  materializeToHandoffDir(predecessorArtifacts, targetWorktreeRoot) {
    if (!Array.isArray(predecessorArtifacts) || !predecessorArtifacts.length || !targetWorktreeRoot) {
      return [];
    }
    const handoffRoot = join(resolve(targetWorktreeRoot), SWARM_ARTIFACT_HANDOFF_DIR);
    mkdirSync(handoffRoot, { recursive: true });
    const descriptors = [];

    for (const ref of predecessorArtifacts) {
      const verification = this.verifyArtifact(ref.id || ref.artifactId || ref.uri);
      if (!verification.ok) {
        throw new Fault('ARTIFACT_VERIFICATION_FAILED', 422, {
          message: `Cannot hand off corrupted predecessor artifact ${ref.id || ref.uri}`,
          errors: verification.errors,
        });
      }
      const art = verification.artifact;
      const rawSafeKey = String(art.nodeKey).replace(/[^a-zA-Z0-9._-]/g, '_');
      const safeNodeKey =
        rawSafeKey === String(art.nodeKey)
          ? rawSafeKey
          : `${rawSafeKey}_${sha256Buffer(Buffer.from(String(art.nodeKey), 'utf8')).slice(0, 8)}`;
      const nodeHandoffRel = `${SWARM_ARTIFACT_HANDOFF_DIR}/${safeNodeKey}`;
      const nodeHandoffFull = join(resolve(targetWorktreeRoot), nodeHandoffRel);
      if (existsSync(nodeHandoffFull)) {
        rmSync(nodeHandoffFull, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
      }
      mkdirSync(nodeHandoffFull, { recursive: true });

      const materializedFiles = [];
      for (const entry of art.files) {
        if (entry.changeType === 'deleted') {
          materializedFiles.push({ ...entry, handoffPath: null });
          continue;
        }
        const readRes = this.readArtifactFile(art.id, entry.path);
        const dst = resolveInsideDir(nodeHandoffFull, entry.path);
        mkdirSync(dirname(dst.full), { recursive: true });
        writeFileSync(dst.full, readRes.buffer);
        materializedFiles.push({
          ...entry,
          handoffPath: `${nodeHandoffRel}/${entry.path}`,
        });
      }

      writeFileSync(
        join(nodeHandoffFull, '_manifest.json'),
        JSON.stringify(
          {
            artifactId: art.id,
            uri: art.uri,
            nodeKey: art.nodeKey,
            attempt: art.attempt,
            baseCommit: art.baseCommit,
            bundleSha256: art.bundleSha256,
            files: materializedFiles,
          },
          null,
          2,
        ),
        'utf8',
      );

      descriptors.push({
        artifactId: art.id,
        uri: art.uri,
        nodeKey: art.nodeKey,
        attempt: art.attempt,
        baseCommit: art.baseCommit,
        bundleSha256: art.bundleSha256,
        handoffDir: nodeHandoffRel,
        files: materializedFiles,
      });
    }

    return descriptors;
  }

  /**
   * Formats structured predecessor artifact references for successor execution context.
   */
  formatPredecessorArtifactsContext(descriptors = [], { isolatedWorktree = false } = {}) {
    if (!Array.isArray(descriptors) || !descriptors.length) return '';
    const lines = ['[Predecessor Artifacts (Verified)]'];
    for (const d of descriptors) {
      lines.push(
        `- nodeKey=${d.nodeKey} artifactId=${d.artifactId} uri=${d.uri} attempt=${d.attempt} bundleSha256=${d.bundleSha256}`,
      );
      if (isolatedWorktree && d.handoffDir) {
        lines.push(`  handoffDir: ${d.handoffDir}`);
      }
      if (!d.files?.length) {
        lines.push('  files: (no filesystem changes)');
      } else {
        for (const f of d.files) {
          const hp = isolatedWorktree && f.handoffPath ? ` -> read_file path: ${f.handoffPath}` : '';
          const prev = f.previousPath ? ` (from ${f.previousPath})` : '';
          lines.push(
            `  * [${f.changeType}] ${f.path}${prev} (size=${f.size}, binary=${Boolean(f.binary)}, mode=${f.mode}, sha256=${f.sha256 || 'deleted'})${hp}`,
          );
        }
      }
    }
    if (!isolatedWorktree) {
      lines.push(
        'Use tool `read_swarm_artifact` with `{ nodeKey, path }` or `{ artifactId, path }` to inspect exact verified file contents.',
      );
    }
    return lines.join('\n');
  }

  /**
   * Guarded apply-to-parent action:
   * - Verifies artifact integrity first
   * - Enforces permission policy (`read-only` denied, `approval` requires explicit `approved: true`)
   * - Detects conflicts against `baseSha256` / existing parent files BEFORE mutating ANY file
   * - On conflict: preserves BOTH sides (never overwrites user modifications, keeps artifact intact)
   */
  applyToParent(
    idOrUri,
    {
      workspaceRoot = null,
      permissionMode = null,
      approved = false,
      dryRun = false,
    } = {},
  ) {
    const verification = this.verifyArtifact(idOrUri);
    if (!verification.ok) {
      throw new Fault('ARTIFACT_VERIFICATION_FAILED', 422, {
        message: `Artifact verification failed: ${verification.errors.join('; ')}`,
        errors: verification.errors,
      });
    }
    const artifact = verification.artifact;
    const targetRoot = resolve(workspaceRoot || artifact.workspaceRoot);

    let runPerm = null;
    if (this.store?.db?.isOpen && artifact.runId) {
      const runRow = this.store.db
        .prepare('SELECT permissionMode FROM swarm_runs WHERE id=?')
        .get(artifact.runId);
      runPerm = runRow?.permissionMode || null;
    }
    let effectivePerm;
    if (runPerm && permissionMode) {
      effectivePerm = intersectPolicies(
        { permissionMode: runPerm },
        { permissionMode },
      ).permissionMode;
    } else {
      effectivePerm = runPerm || permissionMode || 'approval';
    }

    if (effectivePerm === 'read-only') {
      throw new PolicyError('POLICY_DENIED', {
        status: 403,
        message: 'Cannot apply artifact to parent workspace in read-only mode',
      });
    }
    if (effectivePerm === 'approval' && !approved) {
      throw new PolicyError('APPROVAL_REQUIRED', {
        status: 403,
        message: 'Applying artifact to parent workspace requires explicit approval',
      });
    }

    const applyLockKey = process.platform === 'win32' ? targetRoot.toLowerCase() : targetRoot;
    if (this.#activeApplies.has(applyLockKey)) {
      throw new Fault('APPLY_IN_PROGRESS', 409, {
        message: `Another applyToParent operation is already in progress for ${targetRoot}`,
        workspaceRoot: targetRoot,
      });
    }
    this.#activeApplies.add(applyLockKey);

    try {
      const conflicts = [];
      const plan = [];
      const skipped = [];

      for (const entry of artifact.files) {
        const target =
          entry.mode === '120000'
            ? resolveInsideDir(targetRoot, entry.path)
            : resolveConfinedPath(targetRoot, entry.path);
        const artifactFilePath =
          entry.changeType === 'deleted'
            ? null
            : resolveInsideDir(join(artifact.storagePath, 'files'), entry.path).full;

        if (entry.changeType === 'added') {
          if (existsSync(target.full)) {
            const parentBuf = readFileSync(target.full);
            const parentSha = sha256Buffer(parentBuf);
            if (parentSha === entry.sha256) {
              skipped.push({ path: entry.path, reason: 'already_identical' });
            } else {
              conflicts.push({
                path: entry.path,
                changeType: entry.changeType,
                reason: 'target_exists_diverged',
                baseSha256: null,
                parentSha256: parentSha,
                artifactSha256: entry.sha256,
                parentPreserved: true,
                artifactPreserved: true,
                artifactFilePath,
              });
            }
          } else {
            plan.push({ entry, target });
          }
        } else if (entry.changeType === 'modified') {
          if (!existsSync(target.full)) {
            conflicts.push({
              path: entry.path,
              changeType: entry.changeType,
              reason: 'target_deleted_in_parent',
              baseSha256: entry.baseSha256,
              parentSha256: null,
              artifactSha256: entry.sha256,
              parentPreserved: true,
              artifactPreserved: true,
              artifactFilePath,
            });
          } else {
            const parentBuf = readFileSync(target.full);
            const parentSha = sha256Buffer(parentBuf);
            const modeMatches =
              process.platform === 'win32' ||
              (((statSync(target.full).mode & 0o111) !== 0) === (entry.mode === '100755'));
            if (parentSha === entry.sha256 && modeMatches) {
              skipped.push({ path: entry.path, reason: 'already_applied' });
            } else if (
              entry.baseSha256 &&
              !matchesBaseContent(parentBuf, entry.baseSha256, Boolean(entry.binary))
            ) {
              conflicts.push({
                path: entry.path,
                changeType: entry.changeType,
                reason: 'parent_modified_concurrently',
                baseSha256: entry.baseSha256,
                parentSha256: parentSha,
                artifactSha256: entry.sha256,
                parentPreserved: true,
                artifactPreserved: true,
                artifactFilePath,
              });
            } else {
              plan.push({ entry, target });
            }
          }
        } else if (entry.changeType === 'deleted') {
          if (!existsSync(target.full)) {
            skipped.push({ path: entry.path, reason: 'already_deleted' });
          } else {
            const parentBuf = readFileSync(target.full);
            const parentSha = sha256Buffer(parentBuf);
            if (
              entry.baseSha256 &&
              !matchesBaseContent(parentBuf, entry.baseSha256, Boolean(entry.binary))
            ) {
              conflicts.push({
                path: entry.path,
                changeType: entry.changeType,
                reason: 'delete_vs_parent_modified',
                baseSha256: entry.baseSha256,
                parentSha256: parentSha,
                artifactSha256: null,
                parentPreserved: true,
                artifactPreserved: true,
                artifactFilePath: null,
              });
            } else {
              plan.push({ entry, target });
            }
          }
        } else if (entry.changeType === 'renamed') {
          const prevTarget = resolveConfinedPath(targetRoot, entry.previousPath);
          const prevExists = existsSync(prevTarget.full);
          const nextExists = existsSync(target.full);
          const caseOnlyRename = isCaseOnlyRenamePath(prevTarget.full, target.full);

          if (
            !prevExists &&
            nextExists &&
            sha256Buffer(readFileSync(target.full)) === entry.sha256
          ) {
            skipped.push({ path: entry.path, reason: 'already_renamed' });
            continue;
          }
          let hasConflict = false;
          let reason = '';
          let parentSha = null;
          if (prevExists) {
            const prevBuf = readFileSync(prevTarget.full);
            const prevSha = sha256Buffer(prevBuf);
            if (
              entry.baseSha256 &&
              !matchesBaseContent(prevBuf, entry.baseSha256, Boolean(entry.binary))
            ) {
              hasConflict = true;
              reason = 'rename_source_modified_concurrently';
              parentSha = prevSha;
            }
          } else {
            hasConflict = true;
            reason = 'rename_source_missing_in_parent';
          }
          if (!hasConflict && !caseOnlyRename && nextExists) {
            const nextSha = sha256Buffer(readFileSync(target.full));
            if (nextSha !== entry.sha256) {
              hasConflict = true;
              reason = 'rename_target_exists_diverged';
              parentSha = nextSha;
            }
          }
          if (hasConflict) {
            conflicts.push({
              path: entry.path,
              previousPath: entry.previousPath,
              changeType: entry.changeType,
              reason,
              baseSha256: entry.baseSha256,
              parentSha256: parentSha,
              artifactSha256: entry.sha256,
              parentPreserved: true,
              artifactPreserved: true,
              artifactFilePath,
            });
          } else {
            plan.push({ entry, target, prevTarget, caseOnlyRename });
          }
        }
      }

      if (conflicts.length > 0) {
        const conflictResult = {
          ok: false,
          status: 'conflict',
          artifactId: artifact.id,
          uri: artifact.uri,
          applied: [],
          skipped,
          conflicts,
        };
        if (this.store?.db?.isOpen) {
          const now = Date.now();
          this.store.tx(() => {
            this.store.db
              .prepare('UPDATE swarm_artifacts SET applyResultJson=?, updatedAt=? WHERE id=?')
              .run(JSON.stringify({ ...conflictResult, at: now }), now, artifact.id);
          });
        }
        return conflictResult;
      }

      if (dryRun) {
        return {
          ok: true,
          status: 'dry_run_clean',
          artifactId: artifact.id,
          uri: artifact.uri,
          applied: plan.map((p) => ({ path: p.entry.path, changeType: p.entry.changeType })),
          skipped,
          conflicts: [],
        };
      }

      // Pre-validate all payloads & snapshot existing target/prev files for atomic rollback on mid-batch I/O error
      const preparedOps = [];
      const snapshots = new Map();
      const captureSnapshot = (filePath) => {
        if (!filePath || snapshots.has(filePath)) return;
        let lst = null;
        try {
          lst = lstatSync(filePath);
        } catch {
          lst = null;
        }
        if (!lst) {
          snapshots.set(filePath, { existed: false });
        } else if (lst.isSymbolicLink()) {
          snapshots.set(filePath, { existed: true, isSymlink: true, linkTarget: readlinkSync(filePath) });
        } else {
          snapshots.set(filePath, {
            existed: true,
            isSymlink: false,
            content: readFileSync(filePath),
            mode: lst.mode,
          });
        }
      };

      for (const op of plan) {
        const { entry, target, prevTarget } = op;
        captureSnapshot(target.full);
        if (prevTarget) captureSnapshot(prevTarget.full);
        if (entry.changeType !== 'deleted') {
          const readRes = this.readArtifactFile(artifact.id, entry.path);
          if (entry.mode === '120000') {
            validateSymlinkTargetInsideRoot(targetRoot, target.full, readRes.buffer.toString('utf8'));
          }
          preparedOps.push({ ...op, readRes });
        } else {
          preparedOps.push({ ...op, readRes: null });
        }
      }

      const applied = [];
      const mutatedPaths = [];
      try {
        for (const op of preparedOps) {
          const { entry, target, prevTarget, caseOnlyRename, readRes } = op;
          if (entry.changeType === 'deleted') {
            if (existsSync(target.full)) {
              mutatedPaths.push(target.full);
              unlinkSync(target.full);
            }
            applied.push({ path: entry.path, changeType: 'deleted' });
          } else {
            if (caseOnlyRename && prevTarget && existsSync(prevTarget.full)) {
              mutatedPaths.push(prevTarget.full);
              const tmpName = join(dirname(target.full), `.agent-us-apply-${uuid()}`);
              renameSync(prevTarget.full, tmpName);
              unlinkSync(tmpName);
            }
            mkdirSync(dirname(target.full), { recursive: true });
            mutatedPaths.push(target.full);
            if (entry.mode === '120000') {
              const linkTarget = readRes.buffer.toString('utf8');
              try {
                if (lstatSync(target.full)) unlinkSync(target.full);
              } catch {
                // ignore
              }
              symlinkSync(linkTarget, target.full);
            } else {
              writeFileSync(target.full, readRes.buffer);
              if (entry.mode === '100755') {
                try {
                  chmodSync(target.full, 0o755);
                } catch {
                  // ignore
                }
              }
            }
            if (
              entry.changeType === 'renamed' &&
              prevTarget &&
              !caseOnlyRename &&
              prevTarget.full !== target.full &&
              existsSync(prevTarget.full)
            ) {
              mutatedPaths.push(prevTarget.full);
              unlinkSync(prevTarget.full);
            }
            applied.push({
              path: entry.path,
              changeType: entry.changeType,
              ...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
              sha256: entry.sha256,
            });
          }
        }
      } catch (applyErr) {
        // Best-effort rollback of already-mutated files in reverse order
        const rolledBack = new Set();
        for (let i = mutatedPaths.length - 1; i >= 0; i--) {
          const fp = mutatedPaths[i];
          if (rolledBack.has(fp)) continue;
          rolledBack.add(fp);
          const snap = snapshots.get(fp);
          if (!snap) continue;
          try {
            if (!snap.existed) {
              if (existsSync(fp)) unlinkSync(fp);
            } else if (snap.isSymlink) {
              try {
                if (lstatSync(fp)) unlinkSync(fp);
              } catch {
                // ignore
              }
              symlinkSync(snap.linkTarget, fp);
            } else {
              mkdirSync(dirname(fp), { recursive: true });
              writeFileSync(fp, snap.content);
              if (process.platform !== 'win32' && snap.mode) {
                try {
                  chmodSync(fp, snap.mode & 0o777);
                } catch {
                  // ignore
                }
              }
            }
          } catch {
            // continue restoring remaining files
          }
        }
        throw applyErr;
      }

      const now = Date.now();
      const result = {
        ok: true,
        status: 'applied',
        artifactId: artifact.id,
        uri: artifact.uri,
        applied,
        skipped,
        conflicts: [],
      };
      if (this.store?.db?.isOpen) {
        this.store.tx(() => {
          this.store.db
            .prepare("UPDATE swarm_artifacts SET status='applied', appliedAt=?, applyResultJson=?, updatedAt=? WHERE id=?")
            .run(now, JSON.stringify({ ...result, at: now }), now, artifact.id);
        });
      }
      return result;
    } finally {
      this.#activeApplies.delete(applyLockKey);
    }
  }

  /**
   * Fix C9: Checks crash recovery consistency for an isolated worktree node.
   * Ensures recovery NEVER silently restarts from clean HEAD pretending recorded writes still exist.
   */
  inspectWorktreeRecoveryState(node, { childSessionId = null, childTurnId = null } = {}) {
    if (!this.store?.db?.isOpen || !node || node.isolationMode !== 'worktree') {
      return { state: 'not_applicable', needsReconciliation: false };
    }
    const turnId = childTurnId || node.childTurnId || null;
    const sessId = childSessionId || node.childSessionId || null;
    if (!turnId && !sessId) {
      return { state: 'clean_start', needsReconciliation: false };
    }

    // 1. Check whether preserved/existing worktree still exists on disk
    const leaseRow = this.store.db
      .prepare(
        `SELECT * FROM worktree_leases
         WHERE runId=? AND nodeKey=? AND status IN ('preserved', 'active')
         ORDER BY COALESCE(updatedAt, createdAt) DESC, createdAt DESC
         LIMIT 1`,
      )
      .get(node.runId, node.nodeKey);
    if (leaseRow && leaseRow.worktreePath && existsSync(leaseRow.worktreePath)) {
      return { state: 'rehydrate_worktree', needsReconciliation: false, leaseRow };
    }

    // 2. Check whether a verified archived artifact already exists for this node
    const latestArt = this.getLatestNodeArtifact(node.runId, node.nodeKey);
    if (latestArt) {
      const check = this.verifyArtifact(latestArt.id);
      if (check.ok) {
        return { state: 'rehydrate_artifact', needsReconciliation: false, artifact: latestArt };
      }
    }

    // 3. Check if durable tool_receipts recorded completed mutating writes in the lost worktree
    const writeReceipts = this.store.db
      .prepare(
        `SELECT id, callId, toolName, effectClass, status
         FROM tool_receipts
         WHERE status='finished'
           AND ((? IS NOT NULL AND turnId=?) OR (? IS NOT NULL AND sessionId=?))
         ORDER BY createdAt ASC`,
      )
      .all(turnId, turnId, sessId, sessId)
      .filter((r) => r.effectClass !== 'read_only' || MUTATING_WRITE_TOOLS.has(r.toolName));

    if (writeReceipts.length > 0) {
      return {
        state: 'worktree_state_lost',
        needsReconciliation: true,
        reason: 'WORKTREE_STATE_LOST',
        lostReceipts: writeReceipts,
      };
    }

    return { state: 'clean_start', needsReconciliation: false };
  }
}

/**
 * Explicit read-only tool allowing successor swarm nodes to inspect verified predecessor artifacts
 * without relying on model summaries or polluting the parent workspace.
 */
export function createSwarmArtifactTools({
  artifactManager,
  runId,
  predecessorArtifacts = [],
  wrapResult = (_name, txt) => txt,
}) {
  if (!artifactManager || !runId) return [];
  const byNodeKey = new Map(predecessorArtifacts.map((a) => [a.nodeKey, a]));

  return [
    defineTool({
      name: 'read_swarm_artifact',
      description:
        '读取同一 Swarm 运行中前置节点的已验证持久化产物清单或指定文件内容（支持按 nodeKey 或 artifactId/uri 读取，自动校验 SHA-256）。',
      effectClass: EFFECT_CLASSES.READ_ONLY,
      riskLevel: RISK_LEVELS.LOW,
      replayable: true,
      outward: false,
      zodSchema: z.object({
        artifactId: z.string().optional().describe('产物 ID 或 swarm-artifact:// URI'),
        nodeKey: z.string().optional().describe('前置节点 nodeKey（如 producer）'),
        path: z.string().optional().describe('产物内的相对文件路径；省略则返回产物文件清单'),
      }),
      async execute(args) {
        let artifact = null;
        if (args.artifactId) {
          artifact = artifactManager.getArtifact(args.artifactId);
        } else if (args.nodeKey) {
          const ref = byNodeKey.get(args.nodeKey);
          artifact = ref
            ? artifactManager.getArtifact(ref.artifactId || ref.id)
            : artifactManager.getLatestNodeArtifact(runId, args.nodeKey);
        } else if (predecessorArtifacts.length === 1) {
          artifact = artifactManager.getArtifact(
            predecessorArtifacts[0].artifactId || predecessorArtifacts[0].id,
          );
        }
        if (!artifact || artifact.runId !== runId) {
          return `未找到对应的 Swarm 产物 (runId=${runId}, nodeKey=${args.nodeKey || ''}, artifactId=${args.artifactId || ''})`;
        }

        if (!args.path) {
          const summary = {
            artifactId: artifact.id,
            uri: artifact.uri,
            nodeKey: artifact.nodeKey,
            attempt: artifact.attempt,
            baseCommit: artifact.baseCommit,
            bundleSha256: artifact.bundleSha256,
            files: artifact.files.map((f) => ({
              path: f.path,
              changeType: f.changeType,
              previousPath: f.previousPath,
              size: f.size,
              binary: f.binary,
              mode: f.mode,
              sha256: f.sha256,
            })),
          };
          return wrapResult('read_swarm_artifact', JSON.stringify(summary, null, 2));
        }

        const fileRes = artifactManager.readArtifactFile(artifact.id, args.path);
        if (fileRes.deleted) {
          return wrapResult('read_swarm_artifact', `File ${args.path} was deleted in artifact ${artifact.id}.`);
        }
        if (fileRes.entry.binary) {
          return wrapResult(
            'read_swarm_artifact',
            `Binary artifact file ${args.path} (${fileRes.entry.size} bytes, sha256=${fileRes.entry.sha256}, base64=${fileRes.base64.slice(0, 4096)})`,
          );
        }
        return wrapResult(
          'read_swarm_artifact',
          `[Swarm Artifact ${artifact.nodeKey}/${args.path} sha256=${fileRes.entry.sha256}]\n${fileRes.text}`,
        );
      },
    }),
  ];
}
