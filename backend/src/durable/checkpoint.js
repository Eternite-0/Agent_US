import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { Fault, id as uuid } from '../store.js';
import { assertLeaseInTx } from './lease-guard.js';
import { isProtectedPathSegment, resolveConfinedPath } from '../tools/sandbox.js';

const execFileAsync = promisify(execFile);
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const MAX_BASELINE_FILES = 5000;
const MAX_BASELINE_DIRS = 5000;
const MAX_BASELINE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_REDO_STACK = 10;

const BASELINE_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'upstream',
  'var',
]);

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function normalizeRelPosix(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function pathLookupKey(relPath) {
  const norm = normalizeRelPosix(relPath);
  return CASE_INSENSITIVE_FS ? norm.toLowerCase() : norm;
}

function sha256BufferHex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function isPlainUtf8Buffer(buf) {
  if (buf.includes(0)) return false;
  const text = buf.toString('utf8');
  if (text.startsWith('base64:')) return false;
  return Buffer.from(text, 'utf8').equals(buf);
}

function decodeBlobToBuffer(blobRow, explicitEncoding = null) {
  const content = String(blobRow?.content ?? '');
  if (explicitEncoding === 'base64') {
    const raw = content.startsWith('base64:') ? content.slice(7) : content;
    return Buffer.from(raw, 'base64');
  }
  if (explicitEncoding === 'utf8') {
    return Buffer.from(content, 'utf8');
  }
  if (content.startsWith('base64:')) {
    return Buffer.from(content.slice(7), 'base64');
  }
  return Buffer.from(content, 'utf8');
}

function buildSanitizedGitEnv() {
  const env = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_PREFIX',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
  ]) {
    delete env[key];
  }
  return env;
}

async function execGit(cwd, args, { encoding = 'utf8', maxBuffer = 8 * 1024 * 1024 } = {}) {
  const { stdout, stderr } = await execFileAsync(
    'git',
    ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args],
    {
      cwd,
      env: buildSanitizedGitEnv(),
      windowsHide: true,
      timeout: 8000,
      maxBuffer,
      encoding,
    },
  );
  return { stdout, stderr };
}

function shouldSkipRel(relPosix) {
  const parts = normalizeRelPosix(relPosix).split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (isProtectedPathSegment(part)) return true;
    if (i < parts.length - 1 && BASELINE_SKIP_DIRS.has(part.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function walkWorkspaceEntries(realRoot, { includeFiles = true } = {}) {
  const dirs = [];
  const files = [];

  function walk(dir) {
    if (dirs.length >= MAX_BASELINE_DIRS && (!includeFiles || files.length >= MAX_BASELINE_FILES)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      if (BASELINE_SKIP_DIRS.has(ent.name.toLowerCase()) || isProtectedPathSegment(ent.name)) continue;
      const full = join(dir, ent.name);
      const rel = normalizeRelPosix(relative(realRoot, full));
      if (!rel || rel.startsWith('..')) continue;
      if (ent.isDirectory()) {
        if (dirs.length < MAX_BASELINE_DIRS) dirs.push(rel);
        walk(full);
      } else if (includeFiles && ent.isFile()) {
        if (files.length < MAX_BASELINE_FILES) files.push({ full, rel });
      }
    }
  }

  walk(realRoot);
  return { dirs, files };
}

function parseGitPorcelainZ(raw) {
  const records = String(raw || '').split('\0').filter((s) => s.length > 0);
  const out = [];
  for (const rec of records) {
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const relPath = normalizeRelPosix(rec.slice(3));
    if (relPath) out.push({ xy, path: relPath });
  }
  return out;
}

function pruneEmptyParentDirs(fullFilePath, realRoot, baselineDirKeys = null) {
  let cur = dirname(fullFilePath);
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  while (cur !== realRoot && cur.startsWith(rootPrefix)) {
    const relDir = normalizeRelPosix(relative(realRoot, cur));
    if (!relDir || relDir === '.' || relDir.startsWith('..') || shouldSkipRel(relDir)) break;
    if (baselineDirKeys && baselineDirKeys.has(pathLookupKey(relDir))) break;
    try {
      const entries = readdirSync(cur);
      if (entries.length > 0) break;
      rmdirSync(cur);
      cur = dirname(cur);
    } catch {
      break;
    }
  }
}

/**
 * Durable CheckpointStore backed by SQLite `runtime_checkpoints`.
 * Stores phase/step boundaries and resumable turn state snapshots.
 */
export class CheckpointStore {
  constructor(store) {
    this.store = store;
  }

  save({ sessionId, turnId, step = 0, phase, state = {}, ledgerSeq = 0, leaseGuard = null }) {
    if (!this.store?.db?.isOpen || !sessionId || !turnId) return null;
    const id = uuid();
    const now = Date.now();
    this.store.tx(() => {
      assertLeaseInTx(leaseGuard, { sessionId, turnId });
      this.store.db
        .prepare(
          `INSERT INTO runtime_checkpoints(
            id, sessionId, turnId, step, phase, stateJson, ledgerSeq, createdAt
          ) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          sessionId,
          turnId,
          Number(step || 0),
          String(phase || 'init'),
          JSON.stringify(state ?? {}),
          Number(ledgerSeq || 0),
          now,
        );
    });
    return { id, sessionId, turnId, step, phase, state, ledgerSeq, createdAt: now };
  }

  loadLatest(turnId) {
    if (!this.store?.db?.isOpen || !turnId) return null;
    const row = this.store.db
      .prepare(
        'SELECT * FROM runtime_checkpoints WHERE turnId=? ORDER BY step DESC, createdAt DESC, rowid DESC LIMIT 1',
      )
      .get(turnId);
    if (!row) return null;
    return {
      ...row,
      state: parseJsonSafe(row.stateJson, {}),
    };
  }

  loadLatestForSession(sessionId) {
    if (!this.store?.db?.isOpen || !sessionId) return null;
    const row = this.store.db
      .prepare(
        'SELECT * FROM runtime_checkpoints WHERE sessionId=? ORDER BY createdAt DESC, rowid DESC LIMIT 1',
      )
      .get(sessionId);
    if (!row) return null;
    return {
      ...row,
      state: parseJsonSafe(row.stateJson, {}),
    };
  }

  listByTurn(turnId) {
    if (!this.store?.db?.isOpen || !turnId) return [];
    return this.store.db
      .prepare(
        'SELECT * FROM runtime_checkpoints WHERE turnId=? ORDER BY step ASC, createdAt ASC, rowid ASC',
      )
      .all(turnId)
      .map((r) => ({ ...r, state: parseJsonSafe(r.stateJson, {}) }));
  }
}

/**
 * Coordinates turn_snapshots, direct_events (file/changed), blobs, and fast pre-turn
 * workspace baselines for true instant Rewind, single-file Revert, and <10ms Redo.
 */
export class WorkspaceRewindManager {
  constructor(storeOrOpts, maybeOpts = {}) {
    const isDirectStore =
      storeOrOpts && typeof storeOrOpts === 'object' && 'db' in storeOrOpts && typeof storeOrOpts.tx === 'function';
    const opts = isDirectStore ? { store: storeOrOpts, ...maybeOpts } : (storeOrOpts ?? {});
    this.store = opts.store;
    this.directAgent = opts.directAgent ?? null;
    this.eventRouter = opts.eventRouter ?? this.directAgent?.eventRouter ?? null;
  }

  #baselineKey(sessionId, turnId) {
    return `turn_baseline:${sessionId}:${turnId}`;
  }

  #redoKey(sessionId) {
    return `rewind_redo:${sessionId}`;
  }

  #getSessionOrThrow(sessionId) {
    if (this.directAgent?.getSession) {
      return this.directAgent.getSession(sessionId);
    }
    const row = this.store.db.prepare('SELECT * FROM direct_sessions WHERE id=?').get(sessionId);
    if (!row) throw new Fault('SESSION_NOT_FOUND', 404);
    return row;
  }

  #assertSessionNotRunning(sessionId, session) {
    const activeMem = this.directAgent?.activeSessionTurn?.has(sessionId);
    const activeTurn = this.store.db
      .prepare("SELECT id FROM direct_turns WHERE sessionId=? AND state IN ('running','reconciling','parked') LIMIT 1")
      .get(sessionId);
    if (session?.state === 'running' || activeMem || activeTurn) {
      throw new Fault('SESSION_RUNNING', 409, {
        message: '会话正在运行中，请先停止当前轮次后再执行回退或重做。',
      });
    }
  }

  #putFileBufferBlob(buf) {
    const fileSha256 = sha256BufferHex(buf);
    if (isPlainUtf8Buffer(buf)) {
      const { sha256 } = this.store.putBlob(buf.toString('utf8'));
      return { blobSha256: sha256, encoding: 'utf8', fileSha256 };
    }
    const { sha256 } = this.store.putBlob(`base64:${buf.toString('base64')}`);
    return { blobSha256: sha256, encoding: 'base64', fileSha256 };
  }

  #snapshotDiskFile(fullPath, relPath) {
    if (!existsSync(fullPath)) {
      return { path: relPath, existed: false, fileSha256: null, blobSha256: null, encoding: null, mode: null };
    }
    let lst;
    try {
      lst = lstatSync(fullPath);
    } catch {
      return null;
    }
    if (!lst.isFile() || lst.isSymbolicLink() || lst.size > MAX_BASELINE_FILE_BYTES) {
      return null;
    }
    try {
      const buf = readFileSync(fullPath);
      const { blobSha256, encoding, fileSha256 } = this.#putFileBufferBlob(buf);
      return {
        path: relPath,
        existed: true,
        fileSha256,
        blobSha256,
        encoding,
        mode: lst.mode & 0o777,
        size: lst.size,
      };
    } catch {
      return null;
    }
  }

  #clearRuntimeSessionCaches(sessionId) {
    try {
      this.directAgent?.readFileStates?.delete?.(sessionId);
      this.directAgent?.contextAssembler?.clearSession?.(sessionId);
    } catch {
      // ignore runtime cache cleanup failures
    }
  }

  #emitPersistedEvent(sessionId, turnId, type, data) {
    const router = this.eventRouter ?? this.directAgent?.eventRouter ?? null;
    if (router && typeof router.emitPersisted === 'function') {
      return router.emitPersisted({ sessionId, turnId, type, data, audit: true });
    }
    return null;
  }

  #emitPersistedInTxAndFanout(txWork) {
    const router = this.eventRouter ?? this.directAgent?.eventRouter ?? null;
    let persistedEv = null;
    const result = this.store.tx(() => {
      const out = txWork();
      if (out?.eventSpec && router && typeof router.insertPersistedInTx === 'function') {
        persistedEv = router.insertPersistedInTx(out.eventSpec);
      }
      return out;
    });
    if (persistedEv && router && typeof router.fanoutPersisted === 'function') {
      router.fanoutPersisted(persistedEv);
    } else if (result?.eventSpec && router && typeof router.emitPersisted === 'function') {
      router.emitPersisted(result.eventSpec);
    }
    return result;
  }

  async #detectGitRepoRoot(realRoot) {
    try {
      const top = await execGit(realRoot, ['rev-parse', '--show-toplevel']);
      const topReal = realpathSync(resolve(String(top.stdout || '').trim()));
      return topReal === realRoot ? topReal : null;
    } catch {
      return null;
    }
  }

  async #readGitHeadShaFast(realRoot) {
    try {
      const dotGit = join(realRoot, '.git');
      if (existsSync(dotGit)) {
        const st = lstatSync(dotGit);
        let gitDir = null;
        if (st.isDirectory()) {
          gitDir = dotGit;
        } else if (st.isFile()) {
          const ptr = readFileSync(dotGit, 'utf8').trim();
          const m = /^gitdir:\s*(.+)$/i.exec(ptr);
          if (m) gitDir = resolve(realRoot, m[1].trim());
        }
        if (gitDir && existsSync(join(gitDir, 'HEAD'))) {
          const headRaw = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
          if (/^[0-9a-f]{40}$/i.test(headRaw)) return headRaw.toLowerCase();
          if (headRaw.startsWith('ref:')) {
            const refRel = headRaw.slice(4).trim();
            const directRef = join(gitDir, refRel);
            if (existsSync(directRef)) {
              const sha = readFileSync(directRef, 'utf8').trim();
              if (/^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
            }
            const commonFile = join(gitDir, 'commondir');
            if (existsSync(commonFile)) {
              const commonDir = resolve(gitDir, readFileSync(commonFile, 'utf8').trim());
              const commonRef = join(commonDir, refRel);
              if (existsSync(commonRef)) {
                const sha = readFileSync(commonRef, 'utf8').trim();
                if (/^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
              }
            }
          }
        }
      }
    } catch {
      // fall back to git CLI
    }
    return this.#getGitHeadSha(realRoot);
  }

  async #getGitHeadSha(realRoot) {
    try {
      const res = await execGit(realRoot, ['rev-parse', '--verify', 'HEAD']);
      return String(res.stdout || '').trim() || null;
    } catch {
      return null;
    }
  }

  async #readGitTreeEntry(realRoot, ref, relPath) {
    try {
      const lsRes = await execGit(realRoot, ['ls-tree', '-z', ref, '--', relPath]);
      const raw = String(lsRes.stdout || '').replace(/\0/g, '').trim();
      if (!raw) return null;
      const modePart = raw.split(/\s+/)[0] || '100644';
      const parsedMode = Number.parseInt(modePart.slice(-3), 8);
      const mode = Number.isFinite(parsedMode) ? parsedMode : 0o644;
      const blobRes = await execGit(realRoot, ['cat-file', 'blob', `${ref}:${relPath}`], {
        encoding: 'buffer',
        maxBuffer: MAX_BASELINE_FILE_BYTES + 1024,
      });
      const buf = Buffer.isBuffer(blobRes.stdout)
        ? blobRes.stdout
        : Buffer.from(String(blobRes.stdout ?? ''), 'utf8');
      return { buf, mode };
    } catch {
      return null;
    }
  }

  async scanBaseline(workspaceRoot) {
    if (!workspaceRoot || !existsSync(workspaceRoot)) return null;
    let realRoot;
    try {
      realRoot = realpathSync(resolve(workspaceRoot));
      if (!statSync(realRoot).isDirectory()) return null;
    } catch {
      return null;
    }

    const gitRoot = await this.#detectGitRepoRoot(realRoot);
    if (gitRoot) {
      const { dirs, files: walkedFiles } = walkWorkspaceEntries(realRoot, { includeFiles: true });
      const headSha = await this.#readGitHeadShaFast(realRoot);
      const statusRes = await execGit(realRoot, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--no-renames',
      ]);
      const entries = parseGitPorcelainZ(statusRes.stdout);
      const dirtyFiles = {};
      for (const ent of entries) {
        if (shouldSkipRel(ent.path)) continue;
        let confined;
        try {
          confined = resolveConfinedPath(realRoot, ent.path);
        } catch {
          continue;
        }
        const snap = this.#snapshotDiskFile(confined.full, normalizeRelPosix(confined.rel));
        if (snap) dirtyFiles[pathLookupKey(snap.path)] = snap;
      }
      const fileStats = {};
      const hashSmall = walkedFiles.length <= 200;
      for (const f of walkedFiles) {
        try {
          const lst = lstatSync(f.full);
          if (!lst.isFile() || lst.isSymbolicLink()) continue;
          const entry = {
            path: f.rel,
            size: lst.size,
            mtimeMs: lst.mtimeMs,
            ctimeMs: lst.ctimeMs,
          };
          if (hashSmall && lst.size <= 256 * 1024) {
            entry.sha256 = sha256BufferHex(readFileSync(f.full));
          }
          fileStats[pathLookupKey(f.rel)] = entry;
        } catch {
          // skip unreadable file
        }
      }
      return {
        version: 1,
        workspaceRoot: realRoot,
        isGit: true,
        headSha,
        dirtyFiles,
        fileStats,
        fileStatsTruncated: walkedFiles.length >= MAX_BASELINE_FILES,
        dirs,
        capturedAt: Date.now(),
      };
    }

    const { dirs, files: walkedFiles } = walkWorkspaceEntries(realRoot, { includeFiles: true });
    const files = {};
    for (const f of walkedFiles) {
      try {
        resolveConfinedPath(realRoot, f.rel);
      } catch {
        continue;
      }
      const snap = this.#snapshotDiskFile(f.full, f.rel);
      if (snap) files[pathLookupKey(snap.path)] = snap;
    }
    return {
      version: 1,
      workspaceRoot: realRoot,
      isGit: false,
      headSha: null,
      files,
      dirs,
      capturedAt: Date.now(),
    };
  }

  saveTurnBaseline(sessionId, turnId, workspaceRoot, manifest) {
    if (!this.store?.db?.isOpen || !sessionId || !turnId || !manifest) return null;
    const key = this.#baselineKey(sessionId, turnId);
    const existing = this.store.getSetting(key, null);
    if (existing) return existing;
    const record = {
      sessionId,
      turnId,
      workspaceRoot: manifest.workspaceRoot ?? workspaceRoot,
      ...manifest,
    };
    this.store.setSetting(key, record);
    return record;
  }

  async captureTurnBaseline(sessionId, turnId, workspaceRoot, preScanned = null) {
    if (!sessionId || !turnId || !workspaceRoot) return null;
    const existing = this.store.getSetting(this.#baselineKey(sessionId, turnId), null);
    if (existing) return existing;
    const manifest = preScanned ?? (await this.scanBaseline(workspaceRoot));
    if (!manifest) return null;
    return this.saveTurnBaseline(sessionId, turnId, workspaceRoot, manifest);
  }

  clearRedo(sessionId) {
    if (!this.store?.db?.isOpen || !sessionId) return;
    this.store.tx(() => {
      this.store.db.prepare('DELETE FROM kv_settings WHERE key=?').run(this.#redoKey(sessionId));
    });
  }

  #getRedoState(sessionId) {
    const state = this.store.getSetting(this.#redoKey(sessionId), null);
    if (!state || !Array.isArray(state.entries)) {
      return { latestRedoId: null, entries: [] };
    }
    return {
      latestRedoId: state.latestRedoId ?? state.entries.at(-1)?.id ?? null,
      entries: state.entries,
    };
  }

  #pushRedoEntry(sessionId, entry) {
    const cur = this.#getRedoState(sessionId);
    const entries = [...cur.entries, entry].slice(-MAX_REDO_STACK);
    const nextState = {
      latestRedoId: entry.id,
      entries,
    };
    this.store.setSetting(this.#redoKey(sessionId), nextState);
    return entry.id;
  }

  listSnapshots(sessionId) {
    this.#getSessionOrThrow(sessionId);
    const items = this.store.db
      .prepare(
        `SELECT ts.*, dt.input AS turnInput, dt.createdAt AS turnCreatedAt
         FROM turn_snapshots ts
         LEFT JOIN direct_turns dt ON dt.id = ts.turnId
         WHERE ts.sessionId=?
         ORDER BY ts.createdAt DESC`,
      )
      .all(sessionId);

    const turnRows = this.store.db
      .prepare('SELECT id, input, state, createdAt, finishedAt FROM direct_turns WHERE sessionId=? ORDER BY createdAt DESC, rowid DESC')
      .all(sessionId);
    const eventRows = this.store.db
      .prepare("SELECT turnId, data FROM direct_events WHERE sessionId=? AND type='file/changed' ORDER BY seq ASC")
      .all(sessionId);

    const filesByTurn = new Map();
    for (const snap of items) {
      if (!filesByTurn.has(snap.turnId)) filesByTurn.set(snap.turnId, new Map());
      filesByTurn.get(snap.turnId).set(pathLookupKey(snap.path), {
        path: snap.path,
        existed: Boolean(snap.existed),
        action: snap.existed ? 'updated' : 'added',
        beforeSha256: snap.beforeSha256 ?? null,
      });
    }
    for (const ev of eventRows) {
      if (!ev.turnId) continue;
      const data = parseJsonSafe(ev.data, {});
      if (!data?.path) continue;
      const rel = normalizeRelPosix(data.path);
      if (!filesByTurn.has(ev.turnId)) filesByTurn.set(ev.turnId, new Map());
      const map = filesByTurn.get(ev.turnId);
      if (!map.has(pathLookupKey(rel))) {
        map.set(pathLookupKey(rel), {
          path: rel,
          existed: data.before !== null && data.before !== undefined,
          action: data.action || (data.before == null ? 'added' : 'updated'),
          beforeSha256: null,
        });
      }
    }

    const turns = turnRows.map((t) => ({
      id: t.id,
      turnId: t.id,
      input: t.input,
      state: t.state,
      createdAt: t.createdAt,
      finishedAt: t.finishedAt ?? null,
      hasBaseline: Boolean(this.store.getSetting(this.#baselineKey(sessionId, t.id), null)),
      files: [...(filesByTurn.get(t.id)?.values() ?? [])],
    }));

    const redo = this.#getRedoState(sessionId);
    return {
      items,
      turns,
      canRedo: redo.entries.length > 0,
      latestRedoId: redo.latestRedoId ?? null,
    };
  }

  #collectEarliestPreTurnIntents(sessionId, affectedTurnsAsc) {
    const intents = new Map(); // pathLookupKey -> { path, existed, blobSha256, buffer, encoding, mode }
    const turnIds = affectedTurnsAsc.map((t) => t.id);

    for (const tid of turnIds) {
      const snaps = this.store.db
        .prepare('SELECT * FROM turn_snapshots WHERE sessionId=? AND turnId=? ORDER BY createdAt ASC, rowid ASC')
        .all(sessionId, tid);
      for (const snap of snaps) {
        const key = pathLookupKey(snap.path);
        if (intents.has(key)) continue;
        intents.set(key, {
          path: normalizeRelPosix(snap.path),
          existed: Boolean(snap.existed),
          blobSha256: snap.beforeSha256 ?? null,
          buffer: null,
          encoding: null,
          mode: null,
        });
      }

      const events = this.store.db
        .prepare("SELECT data FROM direct_events WHERE sessionId=? AND turnId=? AND type='file/changed' ORDER BY seq ASC")
        .all(sessionId, tid);
      for (const ev of events) {
        const data = parseJsonSafe(ev.data, {});
        if (!data?.path) continue;
        const rel = normalizeRelPosix(data.path);
        const key = pathLookupKey(rel);
        if (intents.has(key)) continue;
        if (typeof data.before === 'string') {
          const buf = Buffer.from(data.before, 'base64');
          intents.set(key, {
            path: rel,
            existed: true,
            blobSha256: null,
            buffer: buf,
            encoding: null,
            mode: null,
          });
        } else if (data.before === null && (data.action === 'added' || data.action === 'create')) {
          intents.set(key, {
            path: rel,
            existed: false,
            blobSha256: null,
            buffer: null,
            encoding: null,
            mode: null,
          });
        }
      }
    }

    return intents;
  }

  async #augmentIntentsWithBaseline(realRoot, baseline, intents, onlyRel = null) {
    if (!baseline) return;
    const onlyKey = onlyRel ? pathLookupKey(onlyRel) : null;

    const consider = async (rel, baselineEntry) => {
      const key = pathLookupKey(rel);
      if (onlyKey && key !== onlyKey) return;
      if (intents.has(key)) return;
      if (shouldSkipRel(rel)) return;
      let confined;
      try {
        confined = resolveConfinedPath(realRoot, rel);
      } catch {
        return;
      }

      const currentExists = existsSync(confined.full);
      let currentSha = null;
      if (currentExists) {
        try {
          const lst = lstatSync(confined.full);
          if (!lst.isFile() || lst.isSymbolicLink() || lst.size > MAX_BASELINE_FILE_BYTES) return;
          currentSha = sha256BufferHex(readFileSync(confined.full));
        } catch {
          return;
        }
      }

      if (baselineEntry) {
        if (baselineEntry.existed) {
          if (currentExists && currentSha === baselineEntry.fileSha256) {
            // Untouched pre-existing user edit/file -> strictly protected!
            return;
          }
          intents.set(key, {
            path: baselineEntry.path || normalizeRelPosix(confined.rel),
            existed: true,
            blobSha256: baselineEntry.blobSha256,
            buffer: null,
            encoding: baselineEntry.encoding ?? null,
            mode: baselineEntry.mode ?? null,
          });
        } else if (currentExists) {
          intents.set(key, {
            path: baselineEntry.path || normalizeRelPosix(confined.rel),
            existed: false,
            blobSha256: null,
            buffer: null,
            encoding: null,
            mode: null,
          });
        }
        return;
      }

      // Not in baseline dirty/file manifest
      if (baseline.isGit) {
        if (baseline.headSha) {
          const gitEntry = await this.#readGitTreeEntry(realRoot, baseline.headSha, normalizeRelPosix(confined.rel));
          if (gitEntry) {
            const baseSha = sha256BufferHex(gitEntry.buf);
            if (currentExists && currentSha === baseSha) return;
            intents.set(key, {
              path: normalizeRelPosix(confined.rel),
              existed: true,
              blobSha256: null,
              buffer: gitEntry.buf,
              encoding: null,
              mode: gitEntry.mode,
            });
            return;
          }
        }
        if (currentExists) {
          intents.set(key, {
            path: normalizeRelPosix(confined.rel),
            existed: false,
            blobSha256: null,
            buffer: null,
            encoding: null,
            mode: null,
          });
        }
      } else if (currentExists) {
        intents.set(key, {
          path: normalizeRelPosix(confined.rel),
          existed: false,
          blobSha256: null,
          buffer: null,
          encoding: null,
          mode: null,
        });
      }
    };

    if (baseline.isGit) {
      const dirtyMap = baseline.dirtyFiles ?? {};
      if (onlyKey) {
        const dirtyTarget = dirtyMap[onlyKey] ?? null;
        const targetRel = dirtyTarget?.path || baseline.fileStats?.[onlyKey]?.path || onlyRel;
        if (targetRel) {
          await consider(targetRel, dirtyTarget);
        }
        return;
      }

      const curHead = baseline.headSha ? await this.#readGitHeadShaFast(realRoot) : null;
      const headUnchanged = !baseline.headSha || curHead === baseline.headSha;
      if (headUnchanged && baseline.fileStats && !baseline.fileStatsTruncated) {
        const { files: currentWalked } = walkWorkspaceEntries(realRoot, { includeFiles: true });
        const seenKeys = new Set();
        const candidates = [];
        const hashSmall = currentWalked.length <= 200;

        for (const f of currentWalked) {
          const k = pathLookupKey(f.rel);
          seenKeys.add(k);
          if (intents.has(k)) continue;
          const prev = baseline.fileStats[k];
          if (!prev) {
            candidates.push(f.rel);
            continue;
          }
          try {
            const lst = lstatSync(f.full);
            if (prev.sha256 && hashSmall && lst.size <= 256 * 1024) {
              const curSha = sha256BufferHex(readFileSync(f.full));
              if (curSha !== prev.sha256) candidates.push(f.rel);
            } else if (
              lst.size !== prev.size ||
              lst.mtimeMs !== prev.mtimeMs ||
              lst.ctimeMs !== prev.ctimeMs
            ) {
              candidates.push(f.rel);
            }
          } catch {
            candidates.push(f.rel);
          }
        }
        for (const [k, prev] of Object.entries(baseline.fileStats)) {
          if (!seenKeys.has(k) && !intents.has(k) && prev?.path) {
            candidates.push(prev.path);
          }
        }
        for (const [k, entry] of Object.entries(dirtyMap)) {
          if (!seenKeys.has(k) && !intents.has(k) && entry?.path) {
            candidates.push(entry.path);
          }
        }
        for (const rel of candidates) {
          await consider(rel, dirtyMap[pathLookupKey(rel)] ?? null);
        }
        return;
      }

      const candidates = new Set();
      for (const entry of Object.values(dirtyMap)) {
        if (entry?.path) candidates.add(entry.path);
      }
      const statusRes = await execGit(realRoot, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--no-renames',
      ]);
      for (const ent of parseGitPorcelainZ(statusRes.stdout)) {
        candidates.add(ent.path);
      }
      if (baseline.headSha && curHead && curHead !== baseline.headSha) {
        try {
          const diffRes = await execGit(realRoot, ['diff', '--name-only', '-z', baseline.headSha, curHead]);
          for (const p of String(diffRes.stdout || '').split('\0').filter(Boolean)) {
            candidates.add(normalizeRelPosix(p));
          }
        } catch {
          // ignore diff if baseline head unreachable
        }
      }
      for (const rel of candidates) {
        await consider(rel, dirtyMap[pathLookupKey(rel)] ?? null);
      }
    } else {
      const baseFiles = baseline.files ?? {};
      const { files: currentWalked } = walkWorkspaceEntries(realRoot, { includeFiles: true });
      const candidates = new Map();
      for (const entry of Object.values(baseFiles)) {
        if (entry?.path) candidates.set(pathLookupKey(entry.path), entry.path);
      }
      for (const f of currentWalked) {
        const k = pathLookupKey(f.rel);
        if (!candidates.has(k)) candidates.set(k, f.rel);
      }
      for (const [k, rel] of candidates.entries()) {
        await consider(rel, baseFiles[k] ?? null);
      }
    }
  }

  #resolveIntentBuffer(intent) {
    if (!intent.existed) return null;
    if (Buffer.isBuffer(intent.buffer)) return intent.buffer;
    if (intent.blobSha256) {
      const blob = this.store.getBlob(intent.blobSha256);
      return decodeBlobToBuffer(blob, intent.encoding);
    }
    return null;
  }

  #applyFileIntents(realRoot, intents, baselineDirKeys = null) {
    const restoredFiles = [];
    const deletedFiles = [];
    const redoFileOps = [];

    for (const intent of intents.values()) {
      let confined;
      try {
        confined = resolveConfinedPath(realRoot, intent.path);
      } catch {
        continue;
      }
      const rel = normalizeRelPosix(confined.rel);
      const currentExists = existsSync(confined.full);

      if (intent.existed) {
        const targetBuf = this.#resolveIntentBuffer(intent);
        if (!targetBuf) continue;
        const targetSha = sha256BufferHex(targetBuf);

        let currentSha = null;
        let currentSnap = null;
        if (currentExists) {
          currentSnap = this.#snapshotDiskFile(confined.full, rel);
          currentSha = currentSnap?.fileSha256 ?? null;
        }
        if (currentExists && currentSha === targetSha) {
          // Already identical on disk — check mode only if explicitly preserved
          if (intent.mode != null) {
            try {
              const curMode = lstatSync(confined.full).mode & 0o777;
              if (curMode === intent.mode) continue;
            } catch {
              continue;
            }
          } else {
            continue;
          }
        }

        if (currentSnap?.existed) {
          redoFileOps.push({
            path: rel,
            existed: true,
            blobSha256: currentSnap.blobSha256,
            encoding: currentSnap.encoding,
            mode: currentSnap.mode,
          });
        } else {
          redoFileOps.push({
            path: rel,
            existed: false,
            blobSha256: null,
            encoding: null,
            mode: null,
          });
        }

        mkdirSync(dirname(confined.full), { recursive: true });
        writeFileSync(confined.full, targetBuf);
        if (intent.mode != null) {
          try {
            chmodSync(confined.full, intent.mode & 0o777);
          } catch {
            // ignore platform chmod restrictions
          }
        }
        restoredFiles.push(rel);
      } else if (currentExists) {
        const currentSnap = this.#snapshotDiskFile(confined.full, rel);
        if (!currentSnap?.existed) continue;
        redoFileOps.push({
          path: rel,
          existed: true,
          blobSha256: currentSnap.blobSha256,
          encoding: currentSnap.encoding,
          mode: currentSnap.mode,
        });
        unlinkSync(confined.full);
        pruneEmptyParentDirs(confined.full, realRoot, baselineDirKeys);
        deletedFiles.push(rel);
      }
    }

    return { restoredFiles, deletedFiles, redoFileOps };
  }

  #buildDbBackupForTurns(sessionId, turnIds) {
    const placeholders = turnIds.map(() => '?').join(',');
    const turns = this.store.db
      .prepare(`SELECT * FROM direct_turns WHERE sessionId=? AND id IN (${placeholders}) ORDER BY createdAt ASC, rowid ASC`)
      .all(sessionId, ...turnIds);
    const messages = this.store.db
      .prepare(`SELECT * FROM direct_messages WHERE sessionId=? AND turnId IN (${placeholders}) ORDER BY seq ASC`)
      .all(sessionId, ...turnIds);
    const snapshots = this.store.db
      .prepare(`SELECT * FROM turn_snapshots WHERE sessionId=? AND turnId IN (${placeholders}) ORDER BY createdAt ASC, rowid ASC`)
      .all(sessionId, ...turnIds);
    const baselines = {};
    for (const tid of turnIds) {
      const b = this.store.getSetting(this.#baselineKey(sessionId, tid), null);
      if (b) baselines[tid] = b;
    }
    const sessionRow = this.store.db.prepare('SELECT state, activeCompactionId FROM direct_sessions WHERE id=?').get(sessionId);
    return {
      sessionState: sessionRow?.state ?? 'completed',
      activeCompactionId: sessionRow?.activeCompactionId ?? null,
      turns,
      messages,
      snapshots,
      baselines,
    };
  }

  async rewindSession(sessionId, { turnId = null, scope = 'both', paths = null } = {}) {
    const startMs = performance.now();
    if (!['files', 'code', 'both', 'conversation'].includes(scope)) {
      throw new Fault('INVALID_REWIND_SCOPE', 400, { message: `不支持的回退范围: ${scope}` });
    }
    const session = this.#getSessionOrThrow(sessionId);
    this.#assertSessionNotRunning(sessionId, session);

    const rawWorkspace = session.workspaceRoot || this.directAgent?.getWorkspaceRoot?.();
    const realRoot = rawWorkspace && existsSync(rawWorkspace) ? realpathSync(resolve(rawWorkspace)) : null;

    const turns = this.store.db
      .prepare('SELECT rowid AS _rowid, * FROM direct_turns WHERE sessionId=? ORDER BY createdAt ASC, rowid ASC')
      .all(sessionId);

    if (!turns.length) {
      return {
        ok: true,
        sessionId,
        turnId: null,
        scope,
        restoredFiles: [],
        deletedFiles: [],
        removedMessages: 0,
        redoId: null,
        durationMs: Math.round((performance.now() - startMs) * 100) / 100,
      };
    }

    const targetIdx = turnId ? turns.findIndex((t) => t.id === turnId) : turns.length - 1;
    if (targetIdx < 0) throw new Fault('TURN_NOT_FOUND', 404);
    const targetTurn = turns[targetIdx];
    const affectedTurnsAsc = turns.slice(targetIdx);
    const affectedIds = affectedTurnsAsc.map((t) => t.id);

    let pathFilterKeys = null;
    if (Array.isArray(paths) && paths.length > 0) {
      if (!realRoot) throw new Fault('WORKSPACE_NOT_FOUND', 404);
      pathFilterKeys = new Set();
      for (const rawPath of paths) {
        try {
          const confined = resolveConfinedPath(realRoot, rawPath);
          pathFilterKeys.add(pathLookupKey(confined.rel));
        } catch (err) {
          throw new Fault('INVALID_REWIND_PATH', 400, { message: err.message });
        }
      }
    }

    const shouldRestoreFiles = scope === 'files' || scope === 'code' || scope === 'both';
    const shouldTruncateConv = scope === 'conversation' || scope === 'both';

    let restoredFiles = [];
    let deletedFiles = [];
    let redoFileOps = [];

    const baseline = this.store.getSetting(this.#baselineKey(sessionId, targetTurn.id), null);
    const baselineDirKeys = baseline?.dirs ? new Set(baseline.dirs.map(pathLookupKey)) : null;

    if (shouldRestoreFiles && realRoot) {
      const intents = this.#collectEarliestPreTurnIntents(sessionId, affectedTurnsAsc);
      await this.#augmentIntentsWithBaseline(realRoot, baseline, intents);
      if (pathFilterKeys) {
        for (const key of [...intents.keys()]) {
          if (!pathFilterKeys.has(key)) intents.delete(key);
        }
      }
      const applied = this.#applyFileIntents(realRoot, intents, baselineDirKeys);
      restoredFiles = applied.restoredFiles;
      deletedFiles = applied.deletedFiles;
      redoFileOps = applied.redoFileOps;
      this.#clearRuntimeSessionCaches(sessionId);
    } else if (shouldTruncateConv) {
      this.directAgent?.contextAssembler?.clearSession?.(sessionId);
    }

    const dbBackup = shouldTruncateConv ? this.#buildDbBackupForTurns(sessionId, affectedIds) : null;
    const redoId = uuid();
    const redoEntry = {
      id: redoId,
      sessionId,
      turnId: targetTurn.id,
      scope,
      workspaceRoot: realRoot,
      fileOps: redoFileOps,
      dbBackup,
      createdAt: Date.now(),
    };

    let removedMessages = 0;
    const durationMs = Math.round((performance.now() - startMs) * 100) / 100;

    this.#emitPersistedInTxAndFanout(() => {
      if (shouldTruncateConv) {
        for (const dropId of affectedIds) {
          const delMsg = this.store.db
            .prepare('DELETE FROM direct_messages WHERE sessionId=? AND turnId=?')
            .run(sessionId, dropId);
          removedMessages += delMsg.changes ?? 0;
          this.store.db.prepare('DELETE FROM turn_snapshots WHERE sessionId=? AND turnId=?').run(sessionId, dropId);
          this.store.db.prepare('DELETE FROM tool_receipts WHERE sessionId=? AND turnId=?').run(sessionId, dropId);
          this.store.db.prepare('DELETE FROM runtime_checkpoints WHERE sessionId=? AND turnId=?').run(sessionId, dropId);
          this.store.db.prepare('DELETE FROM direct_approvals WHERE sessionId=? AND turnId=?').run(sessionId, dropId);
          this.store.db.prepare('DELETE FROM runtime_jobs WHERE sessionId=? AND turnId=?').run(sessionId, dropId);
          this.store.db.prepare('DELETE FROM kv_settings WHERE key=?').run(this.#baselineKey(sessionId, dropId));
          this.store.db.prepare('DELETE FROM direct_turns WHERE id=?').run(dropId);
        }
        this.store.db
          .prepare("UPDATE direct_sessions SET state='completed', activeCompactionId=NULL, updatedAt=? WHERE id=?")
          .run(Date.now(), sessionId);
      }

      this.#pushRedoEntry(sessionId, redoEntry);

      return {
        eventSpec: {
          sessionId,
          turnId: targetTurn.id,
          type: 'session/rewound',
          data: {
            sessionId,
            turnId: targetTurn.id,
            scope,
            restoredFiles,
            deletedFiles,
            removedMessages,
            redoId,
            durationMs,
          },
          audit: true,
        },
      };
    });

    return {
      ok: true,
      sessionId,
      turnId: targetTurn.id,
      scope,
      restoredFiles,
      deletedFiles,
      removedMessages,
      redoId,
      durationMs: Math.round((performance.now() - startMs) * 100) / 100,
    };
  }

  async rewindFile(sessionId, { path, turnId = null } = {}) {
    const startMs = performance.now();
    if (typeof path !== 'string' || !path.trim()) {
      throw new Fault('INVALID_REWIND_PATH', 400, { message: '必须提供要还原的文件路径。' });
    }
    const session = this.#getSessionOrThrow(sessionId);
    this.#assertSessionNotRunning(sessionId, session);

    const rawWorkspace = session.workspaceRoot || this.directAgent?.getWorkspaceRoot?.();
    if (!rawWorkspace || !existsSync(rawWorkspace)) {
      throw new Fault('WORKSPACE_NOT_FOUND', 404);
    }
    const realRoot = realpathSync(resolve(rawWorkspace));
    let confined;
    try {
      confined = resolveConfinedPath(realRoot, path);
    } catch (err) {
      throw new Fault('INVALID_REWIND_PATH', 400, { message: err.message });
    }
    const rel = normalizeRelPosix(confined.rel);
    const targetKey = pathLookupKey(rel);

    const turns = this.store.db
      .prepare('SELECT rowid AS _rowid, * FROM direct_turns WHERE sessionId=? ORDER BY createdAt ASC, rowid ASC')
      .all(sessionId);
    if (!turns.length) {
      throw new Fault('FILE_SNAPSHOT_NOT_FOUND', 404, { message: `未找到文件 ${rel} 的历史快照。` });
    }

    let targetIdx = -1;
    if (turnId) {
      targetIdx = turns.findIndex((t) => t.id === turnId);
      if (targetIdx < 0) throw new Fault('TURN_NOT_FOUND', 404);
    } else {
      for (let i = turns.length - 1; i >= 0; i--) {
        const tid = turns[i].id;
        const hasSnap = this.store.db
          .prepare('SELECT 1 FROM turn_snapshots WHERE sessionId=? AND turnId=? AND lower(path)=lower(?) LIMIT 1')
          .get(sessionId, tid, rel);
        if (hasSnap) {
          targetIdx = i;
          break;
        }
        const evs = this.store.db
          .prepare("SELECT data FROM direct_events WHERE sessionId=? AND turnId=? AND type='file/changed'")
          .all(sessionId, tid);
        if (evs.some((e) => pathLookupKey(parseJsonSafe(e.data, {})?.path) === targetKey)) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx < 0) targetIdx = turns.length - 1;
    }

    const targetTurn = turns[targetIdx];
    const affectedTurnsAsc = turns.slice(targetIdx);
    const intents = this.#collectEarliestPreTurnIntents(sessionId, affectedTurnsAsc);
    for (const k of [...intents.keys()]) {
      if (k !== targetKey) intents.delete(k);
    }

    const baseline = this.store.getSetting(this.#baselineKey(sessionId, targetTurn.id), null);
    await this.#augmentIntentsWithBaseline(realRoot, baseline, intents, rel);

    const intent = intents.get(targetKey);
    if (!intent) {
      throw new Fault('FILE_SNAPSHOT_NOT_FOUND', 404, { message: `未找到文件 ${rel} 的可还原变更记录。` });
    }

    const baselineDirKeys = baseline?.dirs ? new Set(baseline.dirs.map(pathLookupKey)) : null;
    const singleMap = new Map([[targetKey, intent]]);
    const { restoredFiles, deletedFiles, redoFileOps } = this.#applyFileIntents(realRoot, singleMap, baselineDirKeys);

    if (!restoredFiles.length && !deletedFiles.length) {
      throw new Fault('FILE_ALREADY_AT_TARGET', 409, { message: `文件 ${rel} 已处于目标状态。` });
    }

    const action = deletedFiles.length > 0 ? 'deleted' : 'restored';
    const redoId = uuid();
    const durationMs = Math.round((performance.now() - startMs) * 100) / 100;
    const redoEntry = {
      id: redoId,
      sessionId,
      turnId: targetTurn.id,
      scope: 'file',
      path: rel,
      workspaceRoot: realRoot,
      fileOps: redoFileOps,
      dbBackup: null,
      createdAt: Date.now(),
    };

    this.#clearRuntimeSessionCaches(sessionId);

    this.#emitPersistedInTxAndFanout(() => {
      this.#pushRedoEntry(sessionId, redoEntry);
      return {
        eventSpec: {
          sessionId,
          turnId: targetTurn.id,
          type: 'file/reverted',
          data: {
            sessionId,
            turnId: targetTurn.id,
            path: rel,
            action,
            redoId,
            durationMs,
          },
          audit: true,
        },
      };
    });

    return {
      ok: true,
      sessionId,
      turnId: targetTurn.id,
      path: rel,
      action,
      redoId,
      durationMs: Math.round((performance.now() - startMs) * 100) / 100,
    };
  }

  async redoRewind(sessionId, { redoId = null } = {}) {
    const startMs = performance.now();
    const session = this.#getSessionOrThrow(sessionId);
    this.#assertSessionNotRunning(sessionId, session);

    const redoState = this.#getRedoState(sessionId);
    if (!redoState.entries.length) {
      throw new Fault('REDO_NOT_FOUND', 404, { message: '没有可重做的撤销记录。' });
    }

    const idx = redoId
      ? redoState.entries.findIndex((e) => e.id === redoId)
      : redoState.entries.length - 1;
    if (idx < 0) {
      throw new Fault('REDO_NOT_FOUND', 404, { message: '指定的重做记录不存在或已失效。' });
    }
    const entry = redoState.entries[idx];
    const rawWorkspace = entry.workspaceRoot || session.workspaceRoot || this.directAgent?.getWorkspaceRoot?.();
    const realRoot = rawWorkspace ? realpathSync(resolve(rawWorkspace)) : null;

    const restoredFiles = [];
    const deletedFiles = [];

    if (realRoot && Array.isArray(entry.fileOps)) {
      for (const op of entry.fileOps) {
        let confined;
        try {
          confined = resolveConfinedPath(realRoot, op.path);
        } catch {
          continue;
        }
        const rel = normalizeRelPosix(confined.rel);
        if (op.existed && op.blobSha256) {
          const blob = this.store.getBlob(op.blobSha256);
          const buf = decodeBlobToBuffer(blob, op.encoding ?? null);
          mkdirSync(dirname(confined.full), { recursive: true });
          writeFileSync(confined.full, buf);
          if (op.mode != null) {
            try {
              chmodSync(confined.full, op.mode & 0o777);
            } catch {
              // ignore platform chmod restrictions
            }
          }
          restoredFiles.push(rel);
        } else if (!op.existed && existsSync(confined.full)) {
          unlinkSync(confined.full);
          pruneEmptyParentDirs(confined.full, realRoot, null);
          deletedFiles.push(rel);
        }
      }
    }

    this.#clearRuntimeSessionCaches(sessionId);

    const remaining = [...redoState.entries.slice(0, idx), ...redoState.entries.slice(idx + 1)];
    const nextRedoState = {
      latestRedoId: remaining.at(-1)?.id ?? null,
      entries: remaining,
    };

    const durationMs = Math.round((performance.now() - startMs) * 100) / 100;

    this.#emitPersistedInTxAndFanout(() => {
      if (entry.dbBackup && Array.isArray(entry.dbBackup.turns) && entry.dbBackup.turns.length > 0) {
        const newerTurn = this.store.db
          .prepare('SELECT 1 FROM direct_turns WHERE sessionId=? AND createdAt > ? LIMIT 1')
          .get(sessionId, entry.createdAt);
        if (!newerTurn) {
          const insertTurn = this.store.db.prepare(
            `INSERT OR IGNORE INTO direct_turns(
              id, sessionId, clientTurnId, input, model, state, error, inputTokens, outputTokens, costUsd, durationMs,
              createdAt, finishedAt, jobId, phase, step, agentProfile, verdictJson, evidenceCount, activeFence,
              activeAttempt, trafficSource, isSynthetic
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          );
          for (const t of entry.dbBackup.turns) {
            insertTurn.run(
              t.id,
              t.sessionId,
              t.clientTurnId ?? null,
              t.input,
              t.model ?? null,
              t.state ?? 'completed',
              t.error ?? null,
              t.inputTokens ?? 0,
              t.outputTokens ?? 0,
              t.costUsd ?? 0,
              t.durationMs ?? 0,
              t.createdAt,
              t.finishedAt ?? null,
              t.jobId ?? null,
              t.phase ?? 'completed',
              t.step ?? 0,
              t.agentProfile ?? 'default',
              t.verdictJson ?? null,
              t.evidenceCount ?? 0,
              t.activeFence ?? null,
              t.activeAttempt ?? 0,
              t.trafficSource ?? 'production',
              t.isSynthetic ?? 0,
            );
          }

          const insertMsg = this.store.db.prepare(
            `INSERT OR IGNORE INTO direct_messages(
              seq, sessionId, turnId, role, content, reasoning, toolCalls, toolCallId, toolName, meta, createdAt
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          );
          for (const m of entry.dbBackup.messages ?? []) {
            insertMsg.run(
              m.seq,
              m.sessionId,
              m.turnId ?? null,
              m.role,
              m.content,
              m.reasoning ?? null,
              m.toolCalls ?? null,
              m.toolCallId ?? null,
              m.toolName ?? null,
              m.meta ?? null,
              m.createdAt,
            );
          }

          const insertSnap = this.store.db.prepare(
            `INSERT OR IGNORE INTO turn_snapshots(
              id, sessionId, turnId, path, existed, beforeSha256, afterSha256, createdAt
            ) VALUES(?,?,?,?,?,?,?,?)`,
          );
          for (const s of entry.dbBackup.snapshots ?? []) {
            insertSnap.run(
              s.id,
              s.sessionId,
              s.turnId,
              s.path,
              s.existed,
              s.beforeSha256 ?? null,
              s.afterSha256 ?? null,
              s.createdAt,
            );
          }

          for (const [tid, b] of Object.entries(entry.dbBackup.baselines ?? {})) {
            this.store.db
              .prepare(
                'INSERT INTO kv_settings(key, value, updatedAt) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt',
              )
              .run(this.#baselineKey(sessionId, tid), JSON.stringify(b), Date.now());
          }

          this.store.db
            .prepare('UPDATE direct_sessions SET state=?, activeCompactionId=?, updatedAt=? WHERE id=?')
            .run(entry.dbBackup.sessionState ?? 'completed', entry.dbBackup.activeCompactionId ?? null, Date.now(), sessionId);
        }
      }

      this.store.db
        .prepare(
          'INSERT INTO kv_settings(key, value, updatedAt) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt',
        )
        .run(this.#redoKey(sessionId), JSON.stringify(nextRedoState), Date.now());

      return {
        eventSpec: {
          sessionId,
          turnId: entry.turnId ?? null,
          type: 'session/rewind_redone',
          data: {
            sessionId,
            turnId: entry.turnId ?? null,
            redoId: entry.id,
            restoredFiles,
            deletedFiles,
            durationMs,
          },
          audit: true,
        },
      };
    });

    return {
      ok: true,
      restoredFiles,
      deletedFiles,
      redoId: entry.id,
      durationMs: Math.round((performance.now() - startMs) * 100) / 100,
    };
  }
}
