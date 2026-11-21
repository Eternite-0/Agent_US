import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Fault, id as uuid } from '../store.js';
import { sha256Hex } from '../integrity.js';

const HOOK_BASENAME_RE = /^hooks(?:\.[^.]+)?\.json$/i;
const MCP_BASENAME_RE = /^mcp(?:\.[^.]+)?\.json$/i;
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function normalizeLexicalPath(filePath) {
  const abs = resolve(String(filePath ?? ''));
  return CASE_INSENSITIVE_FS ? abs.toLowerCase() : abs;
}

function normalizeWorkspaceRootKey(workspaceRoot) {
  if (!workspaceRoot) return null;
  const abs = resolve(String(workspaceRoot));
  let canonical = abs;
  if (existsSync(abs)) {
    try {
      canonical = realpathSync(abs);
    } catch {
      canonical = abs;
    }
  }
  return CASE_INSENSITIVE_FS ? canonical.toLowerCase() : canonical;
}

/**
 * Canonicalizes a hook/MCP config path for deterministic trust matching across platforms
 * (Windows/macOS case-insensitivity, 8.3 short paths) and prevents symlink/junction spoofing.
 */
export function normalizeHookConfigPath(filePath) {
  const abs = resolve(String(filePath ?? ''));
  let canonical = abs;
  if (existsSync(abs)) {
    try {
      canonical = realpathSync(abs);
    } catch {
      canonical = abs;
    }
  } else {
    const parent = dirname(abs);
    if (existsSync(parent)) {
      try {
        canonical = join(realpathSync(parent), basename(abs));
      } catch {
        canonical = abs;
      }
    }
  }
  return CASE_INSENSITIVE_FS ? canonical.toLowerCase() : canonical;
}

/**
 * Computes exact SHA-256 hex digest over raw hook config bytes.
 */
export function computeHookContentDigest(contentOrBuffer) {
  if (Buffer.isBuffer(contentOrBuffer)) {
    return sha256Hex(contentOrBuffer);
  }
  return sha256Hex(Buffer.from(String(contentOrBuffer ?? ''), 'utf8'));
}

function matchesConfigBasename(targetPath, regex, { workspaceRoot = null, dataRoot = null } = {}) {
  const raw = String(targetPath ?? '').trim();
  if (!raw) return false;
  const normRel = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = normRel.split('/').filter(Boolean);
  const fileName = (parts.at(-1) ?? '').split(':')[0].replace(/[. ]+$/, '');
  if (!regex.test(fileName)) return false;

  const lowerParts = parts.map((p) => p.split(':')[0].replace(/[. ]+$/, '').toLowerCase());
  if (lowerParts.includes('.agent-us') || lowerParts.includes('.claude')) {
    return true;
  }

  if (dataRoot) {
    const resolvedTarget = workspaceRoot
      ? resolve(workspaceRoot, raw)
      : resolve(raw);
    const relFromData = relative(resolve(dataRoot), resolvedTarget);
    if (!relFromData.startsWith('..') && !relFromData.includes(sep)) {
      return true;
    }
  }
  return false;
}

/**
 * Detects whether a relative or absolute workspace path refers to an executable hook config file
 * (such as `.agent-us/hooks.json`, `.claude/hooks.json`, or `<dataRoot>/hooks.json`).
 */
export function isHookConfigPath(targetPath, opts = {}) {
  return matchesConfigBasename(targetPath, HOOK_BASENAME_RE, opts);
}

/**
 * Detects whether a relative or absolute workspace path refers to an MCP server config file
 * (such as `.agent-us/mcp.json`, `.claude/mcp.json`, or `<dataRoot>/mcp.json`).
 */
export function isMcpConfigPath(targetPath, opts = {}) {
  return matchesConfigBasename(targetPath, MCP_BASENAME_RE, opts);
}

export function isExecutableConfigPath(targetPath, opts = {}) {
  return isHookConfigPath(targetPath, opts) || isMcpConfigPath(targetPath, opts);
}

/**
 * Manages the explicit SHA-256 content-bound trust boundary for executable hook configs.
 *
 * Security invariants:
 * - Default-deny: unapproved hook config files on disk remain completely inactive.
 * - Exact content binding: trust is bound to `(canonicalPath, sha256(rawBytes))`.
 *   Any modification to an approved file immediately invalidates its trust.
 * - Identical rules across initial load, runtime edits, and process restarts via SQLite.
 */
export class HookTrustManager {
  constructor({ store = null, eventRouter = null } = {}) {
    this.store = store;
    this.eventRouter = eventRouter;
    this.memoryApprovals = new Map(); // canonicalPath -> { id, configPath, workspaceRoot, contentDigest, status, approvedBy, note, approvedAt, revokedAt, updatedAt }
    this.lexicalAliases = new Map(); // lexicalPath -> Set<canonicalPath> (so deleting a symlinked config still revokes its realpath)
  }

  #rememberAlias(displayPath, configPath) {
    const lexical = normalizeLexicalPath(displayPath);
    let set = this.lexicalAliases.get(lexical);
    if (!set) {
      set = new Set();
      this.lexicalAliases.set(lexical, set);
    }
    set.add(configPath);
  }

  #hasDb() {
    try {
      return Boolean(this.store?.db?.isOpen);
    } catch {
      return false;
    }
  }

  /**
   * Reads a hook/MCP config file (resolving realpath BEFORE reading bytes) and verifies
   * whether its exact raw SHA-256 digest is explicitly trusted.
   */
  verifyFile(filePath, { rawBuffer = null } = {}) {
    const displayPath = resolve(String(filePath ?? ''));
    if (!existsSync(displayPath) && rawBuffer === null) {
      return {
        trusted: false,
        exists: false,
        configPath: normalizeHookConfigPath(displayPath),
        displayPath,
        contentDigest: null,
        reason: 'HOOK_CONFIG_MISSING',
        approvalId: null,
      };
    }

    // Resolve realpath BEFORE reading bytes to prevent symlink swap between read and normalize
    let readTarget = displayPath;
    if (existsSync(displayPath)) {
      try {
        readTarget = realpathSync(displayPath);
      } catch {
        readTarget = displayPath;
      }
    }
    const configPath = normalizeHookConfigPath(readTarget);
    this.#rememberAlias(displayPath, configPath);

    let buf = rawBuffer;
    if (buf === null) {
      try {
        buf = readFileSync(readTarget);
      } catch (err) {
        return {
          trusted: false,
          exists: false,
          configPath,
          displayPath,
          contentDigest: null,
          reason: `HOOK_CONFIG_UNREADABLE:${String(err?.message ?? err)}`,
          approvalId: null,
        };
      }
    }

    const contentDigest = computeHookContentDigest(buf);

    let row = null;
    if (this.#hasDb()) {
      row =
        this.store.db
          .prepare(
            "SELECT * FROM hook_trust_approvals WHERE configPath=? AND contentDigest=? AND status='trusted' LIMIT 1",
          )
          .get(configPath, contentDigest) ?? null;
    } else {
      const mem = this.memoryApprovals.get(configPath);
      if (mem && mem.status === 'trusted' && mem.contentDigest === contentDigest) {
        row = mem;
      }
    }

    if (!row) {
      return {
        trusted: false,
        exists: true,
        configPath,
        displayPath,
        contentDigest,
        reason: 'HOOK_CONFIG_UNTRUSTED',
        approvalId: null,
      };
    }

    return {
      trusted: true,
      exists: true,
      configPath,
      displayPath,
      contentDigest,
      reason: 'trusted',
      approvalId: row.id,
      approvedBy: row.approvedBy ?? null,
      approvedAt: row.approvedAt ?? null,
    };
  }

  inspectFile(filePath) {
    const displayPath = resolve(String(filePath ?? ''));
    if (!existsSync(displayPath)) {
      return {
        exists: false,
        trusted: false,
        status: 'missing',
        displayPath,
        configPath: normalizeHookConfigPath(displayPath),
        contentDigest: null,
        approvalId: null,
      };
    }
    let readTarget = displayPath;
    try {
      readTarget = realpathSync(displayPath);
    } catch {
      readTarget = displayPath;
    }
    const buf = readFileSync(readTarget);
    let validJson = true;
    try {
      const parsed = JSON.parse(buf.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        validJson = false;
      }
    } catch {
      validJson = false;
    }
    const check = this.verifyFile(displayPath, { rawBuffer: buf });
    return {
      exists: true,
      trusted: validJson && check.trusted,
      status: !validJson ? 'invalid_json' : check.trusted ? 'trusted' : 'untrusted',
      displayPath,
      configPath: check.configPath,
      contentDigest: check.contentDigest,
      approvalId: check.approvalId,
      approvedBy: check.approvedBy ?? null,
      approvedAt: check.approvedAt ?? null,
    };
  }

  /**
   * Explicitly trusts the exact content currently on disk at `filePath`.
   * Resolves realpath BEFORE reading bytes, supports strict `requireExpectedDigest`,
   * and revokes any previous trusted digests for the same path.
   */
  approveFile(
    filePath,
    {
      workspaceRoot = null,
      expectedDigest = undefined,
      requireExpectedDigest = false,
      approvedBy = 'user',
      note = '',
    } = {},
  ) {
    const displayPath = resolve(String(filePath ?? ''));
    if (!existsSync(displayPath)) {
      throw new Fault('HOOK_CONFIG_NOT_FOUND', 404, {
        message: `Hook config not found: ${displayPath}`,
      });
    }
    // Resolve realpath BEFORE reading bytes to prevent symlink-swap TOCTOU
    let canonicalTarget = displayPath;
    try {
      canonicalTarget = realpathSync(displayPath);
    } catch {
      canonicalTarget = displayPath;
    }
    const configPath = normalizeHookConfigPath(canonicalTarget);
    const buf = readFileSync(canonicalTarget);
    let parsed;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch (err) {
      throw new Fault('HOOK_CONFIG_INVALID_JSON', 400, {
        message: `Invalid hook config JSON: ${String(err?.message ?? err)}`,
      });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Fault('HOOK_CONFIG_INVALID_JSON', 400, {
        message: 'Hook config root must be a JSON object',
      });
    }

    const contentDigest = computeHookContentDigest(buf);
    const hasExpected = expectedDigest !== undefined && expectedDigest !== null;
    if (requireExpectedDigest && (!hasExpected || String(expectedDigest).trim() === '')) {
      throw new Fault('HOOK_DIGEST_REQUIRED', 400, {
        message: 'expectedDigest is required to approve executable hook/MCP config',
      });
    }
    if (hasExpected && String(expectedDigest).trim().toLowerCase() !== contentDigest) {
      throw new Fault('HOOK_DIGEST_MISMATCH', 409, {
        message: 'Hook config digest changed before approval',
        expectedDigest,
        actualDigest: contentDigest,
      });
    }

    this.#rememberAlias(displayPath, configPath);
    const now = Date.now();
    const recordId = uuid();
    const resolvedWs = workspaceRoot ? resolve(workspaceRoot) : null;

    let saved;
    if (this.#hasDb()) {
      saved = this.store.tx(() => {
        this.store.db
          .prepare(
            "UPDATE hook_trust_approvals SET status='revoked', revokedAt=?, updatedAt=? WHERE configPath=? AND contentDigest!=? AND status='trusted'",
          )
          .run(now, now, configPath, contentDigest);
        this.store.db
          .prepare(
            `INSERT INTO hook_trust_approvals(
              id, configPath, workspaceRoot, contentDigest, status, approvedBy, note, approvedAt, revokedAt, updatedAt
            ) VALUES(?,?,?,?,'trusted',?,?,?,NULL,?)
            ON CONFLICT(configPath, contentDigest) DO UPDATE SET
              workspaceRoot=COALESCE(excluded.workspaceRoot, hook_trust_approvals.workspaceRoot),
              status='trusted',
              approvedBy=excluded.approvedBy,
              note=excluded.note,
              approvedAt=excluded.approvedAt,
              revokedAt=NULL,
              updatedAt=excluded.updatedAt`,
          )
          .run(
            recordId,
            configPath,
            resolvedWs,
            contentDigest,
            String(approvedBy || 'user'),
            note ? String(note).slice(0, 500) : null,
            now,
            now,
          );
        return this.store.db
          .prepare('SELECT * FROM hook_trust_approvals WHERE configPath=? AND contentDigest=?')
          .get(configPath, contentDigest);
      });
    } else {
      saved = {
        id: recordId,
        configPath,
        workspaceRoot: resolvedWs,
        contentDigest,
        status: 'trusted',
        approvedBy: String(approvedBy || 'user'),
        note: note ? String(note).slice(0, 500) : null,
        approvedAt: now,
        revokedAt: null,
        updatedAt: now,
      };
      this.memoryApprovals.set(configPath, saved);
    }

    try {
      this.store?.event?.('security.hook.trusted', null, null, {
        approvalId: saved.id,
        configPath: saved.configPath,
        contentDigest: saved.contentDigest,
        approvedBy: saved.approvedBy,
      });
    } catch {
      // isolate audit log errors
    }

    return saved;
  }

  revokeFile(filePath, { contentDigest = null, reason = 'revoked' } = {}) {
    const configPath = normalizeHookConfigPath(filePath);
    const lexicalPath = normalizeLexicalPath(filePath);
    const candidatePaths = new Set([configPath, lexicalPath]);
    const aliases = this.lexicalAliases.get(lexicalPath);
    if (aliases) {
      for (const a of aliases) candidatePaths.add(a);
    }
    const now = Date.now();
    let revokedCount = 0;

    if (this.#hasDb()) {
      revokedCount = this.store.tx(() => {
        let total = 0;
        for (const p of candidatePaths) {
          const res = contentDigest
            ? this.store.db
                .prepare(
                  "UPDATE hook_trust_approvals SET status='revoked', revokedAt=?, updatedAt=? WHERE configPath=? AND contentDigest=? AND status='trusted'",
                )
                .run(now, now, p, String(contentDigest))
            : this.store.db
                .prepare(
                  "UPDATE hook_trust_approvals SET status='revoked', revokedAt=?, updatedAt=? WHERE configPath=? AND status='trusted'",
                )
                .run(now, now, p);
          total += res.changes ?? 0;
        }
        return total;
      });
    } else {
      for (const p of candidatePaths) {
        const mem = this.memoryApprovals.get(p);
        if (mem && mem.status === 'trusted' && (!contentDigest || mem.contentDigest === contentDigest)) {
          mem.status = 'revoked';
          mem.revokedAt = now;
          mem.updatedAt = now;
          revokedCount++;
        }
      }
    }

    if (revokedCount > 0) {
      try {
        this.store?.event?.('security.hook.revoked', null, null, {
          configPath,
          contentDigest,
          reason,
          revokedCount,
        });
      } catch {
        // isolate audit log errors
      }
    }
    return { configPath, revokedCount };
  }

  /**
   * Invoked whenever a workspace tool creates/edits/deletes a hook or MCP config file.
   * Immediately revokes prior trust so modified or replaced drafts cannot activate silently.
   */
  onConfigMutated({ filePath, toolName = 'workspace_write' } = {}) {
    if (!filePath) return { revokedCount: 0 };
    return this.revokeFile(filePath, { reason: `mutated_by_${toolName}` });
  }

  listApprovals({ workspaceRoot = null, status = null } = {}) {
    const wsKey = workspaceRoot ? normalizeWorkspaceRootKey(workspaceRoot) : null;
    if (!this.#hasDb()) {
      let items = [...this.memoryApprovals.values()];
      if (wsKey) {
        items = items.filter((r) => normalizeWorkspaceRootKey(r.workspaceRoot) === wsKey);
      }
      if (status) items = items.filter((r) => r.status === status);
      return items;
    }
    const where = [];
    const params = [];
    if (status) {
      where.push('status=?');
      params.push(String(status));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.store.db
      .prepare(`SELECT * FROM hook_trust_approvals ${clause} ORDER BY updatedAt DESC LIMIT 500`)
      .all(...params);
    if (!wsKey) return rows.slice(0, 200);
    return rows
      .filter((r) => r.workspaceRoot && normalizeWorkspaceRootKey(r.workspaceRoot) === wsKey)
      .slice(0, 200);
  }
}
