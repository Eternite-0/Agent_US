import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { Fault, id as uuid } from '../store.js';
import { mintNonce } from '../envelope.js';
import { resolveSafePath } from '../workspace-tools.js';

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Persistence repository for Direct Sessions, Turns, Messages, Nonces,
 * Pre-mutation Snapshots, and Deterministic Rewind.
 */
export class DirectSessionRepo {
  constructor({
    store,
    eventRouter,
    getWorkspaceRoot,
    getDefaultModel,
    onSessionDeleted = null,
    onBeforeRewind = null,
    onReadStateCleared = null,
  }) {
    this.store = store;
    this.eventRouter = eventRouter;
    this.getWorkspaceRoot = getWorkspaceRoot;
    this.getDefaultModel = getDefaultModel;
    this.onSessionDeleted = onSessionDeleted;
    this.onBeforeRewind = onBeforeRewind;
    this.onReadStateCleared = onReadStateCleared;
  }

  hydrateSessionRow(row) {
    if (!row) return null;
    return {
      ...row,
      plan: parseJsonSafe(row.planJson, null),
      approvedPrefixes: parseJsonSafe(row.approvedPrefixes, []),
      budget: parseJsonSafe(row.budgetJson, null),
    };
  }

  ensureSessionNonce(sessionId) {
    const row = this.getSession(sessionId);
    if (row.nonce) return row.nonce;
    const nonce = mintNonce();
    this.store.tx(() => {
      this.store.db
        .prepare('UPDATE direct_sessions SET nonce=? WHERE id=?')
        .run(nonce, sessionId);
    });
    return nonce;
  }

  listSessions({ limit = 200, offset = 0 } = {}) {
    return this.store.db
      .prepare(
        'SELECT * FROM direct_sessions ORDER BY updatedAt DESC, createdAt DESC LIMIT ? OFFSET ?',
      )
      .all(Math.min(500, Math.max(1, Number(limit))), Math.max(0, Number(offset)))
      .map((r) => this.hydrateSessionRow(r));
  }

  getSession(sessionId) {
    const row = this.store.db
      .prepare('SELECT * FROM direct_sessions WHERE id=?')
      .get(sessionId);
    if (!row) throw new Fault('SESSION_NOT_FOUND', 404);
    return this.hydrateSessionRow(row);
  }

  createSession({
    id: customId = null,
    title = '新对话',
    model = null,
    workspaceRoot = null,
    mode = 'direct',
    permissionMode = 'auto-safe',
    parentSessionId = null,
    rootSessionId = null,
    agentProfile = 'default',
    budget = null,
  } = {}) {
    const sessionId = customId?.trim() || uuid();
    const now = Date.now();
    const resolvedModel = model || this.getDefaultModel() || '';
    const resolvedWs = workspaceRoot
      ? resolve(String(workspaceRoot))
      : this.getWorkspaceRoot();
    const nonce = mintNonce();
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO direct_sessions(
            id, title, workspaceRoot, model, mode, permissionMode, state, nonce, approvedPrefixes,
            parentSessionId, rootSessionId, agentProfile, budgetJson, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,'idle',?,'[]',?,?,?,?,?,?)`,
        )
        .run(
          sessionId,
          String(title || '新对话').slice(0, 200),
          resolvedWs,
          resolvedModel,
          mode || 'direct',
          permissionMode || 'auto-safe',
          nonce,
          parentSessionId,
          rootSessionId ?? (parentSessionId ? null : sessionId),
          agentProfile || 'default',
          budget ? JSON.stringify(budget) : null,
          now,
          now,
        );
    });
    return this.getSession(sessionId);
  }

  updateSession(sessionId, patch = {}) {
    const s = this.getSession(sessionId);
    const now = Date.now();
    this.store.tx(() => {
      this.store.db
        .prepare(
          `UPDATE direct_sessions
           SET title=?, model=?, workspaceRoot=?, mode=?, permissionMode=?, updatedAt=?
           WHERE id=?`,
        )
        .run(
          patch.title !== undefined ? String(patch.title).slice(0, 200) : s.title,
          patch.model !== undefined ? String(patch.model) : s.model,
          patch.workspaceRoot !== undefined
            ? resolve(String(patch.workspaceRoot))
            : s.workspaceRoot,
          patch.mode !== undefined ? String(patch.mode) : s.mode,
          patch.permissionMode !== undefined
            ? String(patch.permissionMode)
            : s.permissionMode,
          now,
          sessionId,
        );
    });
    return this.getSession(sessionId);
  }

  deleteSession(sessionId) {
    this.getSession(sessionId);
    this.onSessionDeleted?.(sessionId);
    this.store.tx(() => {
      this.store.db.prepare('DELETE FROM direct_events WHERE sessionId=?').run(sessionId);
      this.store.db.prepare('DELETE FROM direct_approvals WHERE sessionId=?').run(sessionId);
      this.store.db.prepare('DELETE FROM context_compactions WHERE sessionId=?').run(sessionId);
      this.store.db.prepare('DELETE FROM direct_sessions WHERE id=?').run(sessionId);
    });
    return { id: sessionId, deleted: true };
  }

  listTurns(sessionId, { limit = 50 } = {}) {
    return this.store.db
      .prepare('SELECT * FROM direct_turns WHERE sessionId=? ORDER BY createdAt DESC LIMIT ?')
      .all(sessionId, Math.min(200, Math.max(1, Number(limit))))
      .map((r) => ({
        ...r,
        verdict: parseJsonSafe(r.verdictJson, null),
      }));
  }

  listMessages(sessionId, { after = 0, limit = 200 } = {}) {
    return this.store.db
      .prepare(
        'SELECT * FROM direct_messages WHERE sessionId=? AND seq>? ORDER BY seq ASC LIMIT ?',
      )
      .all(sessionId, Number(after || 0), Math.min(500, Math.max(1, Number(limit))))
      .map((r) => ({
        seq: r.seq,
        sessionId: r.sessionId,
        turnId: r.turnId,
        role: r.role,
        content: r.content,
        reasoning: r.reasoning || undefined,
        toolCalls: parseJsonSafe(r.toolCalls, undefined),
        toolCallId: r.toolCallId || undefined,
        toolName: r.toolName || undefined,
        meta: parseJsonSafe(r.meta, undefined),
        createdAt: r.createdAt,
      }));
  }

  listChildSessions(parentSessionId) {
    return this.store.db
      .prepare('SELECT * FROM direct_sessions WHERE parentSessionId=? ORDER BY createdAt DESC')
      .all(parentSessionId)
      .map((r) => this.hydrateSessionRow(r));
  }

  capturePreMutationSnapshot(sessionId, turnId, relPath, fullPath) {
    const existing = this.store.db
      .prepare('SELECT id FROM turn_snapshots WHERE turnId=? AND path=?')
      .get(turnId, relPath);
    if (existing) return;
    const existed = existsSync(fullPath);
    let beforeSha = null;
    if (existed) {
      const content = readFileSync(fullPath, 'utf8');
      beforeSha = this.store.putBlob(content).sha256;
    }
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT OR IGNORE INTO turn_snapshots(
            id, sessionId, turnId, path, existed, beforeSha256, afterSha256, createdAt
          ) VALUES(?,?,?,?,?,?,NULL,?)`,
        )
        .run(uuid(), sessionId, turnId, relPath, existed ? 1 : 0, beforeSha, Date.now());
    });
  }

  listSnapshots(sessionId) {
    return this.store.db
      .prepare(
        `SELECT ts.*, dt.input AS turnInput, dt.createdAt AS turnCreatedAt
         FROM turn_snapshots ts
         LEFT JOIN direct_turns dt ON dt.id = ts.turnId
         WHERE ts.sessionId=?
         ORDER BY ts.createdAt DESC`,
      )
      .all(sessionId);
  }

  rewindSession(sessionId, { turnId = null, scope = 'both' } = {}) {
    const session = this.getSession(sessionId);
    const workspaceRoot = session.workspaceRoot || this.getWorkspaceRoot();
    const turns = this.store.db
      .prepare('SELECT * FROM direct_turns WHERE sessionId=? ORDER BY createdAt ASC')
      .all(sessionId);
    if (!turns.length) {
      return { ok: true, restoredFiles: [], removedMessages: 0, scope };
    }

    const targetTurn = turnId ? turns.find((t) => t.id === turnId) : turns.at(-1);
    if (!targetTurn) throw new Fault('TURN_NOT_FOUND', 404);

    this.onBeforeRewind?.(sessionId);

    const affectedTurns = turns
      .filter((t) => t.createdAt >= targetTurn.createdAt)
      .reverse();
    const restoredFiles = [];

    if (scope === 'code' || scope === 'both') {
      const seenPaths = new Set();
      for (const t of affectedTurns) {
        const snaps = this.store.db
          .prepare('SELECT * FROM turn_snapshots WHERE turnId=?')
          .all(t.id);
        for (const snap of snaps) {
          const { full, rel } = resolveSafePath(workspaceRoot, snap.path);
          if (snap.existed && snap.beforeSha256) {
            const blob = this.store.getBlob(snap.beforeSha256);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, blob.content, 'utf8');
            seenPaths.add(rel);
          } else if (!snap.existed) {
            if (existsSync(full)) unlinkSync(full);
            seenPaths.add(rel);
          }
        }
      }
      restoredFiles.push(...seenPaths);
      this.onReadStateCleared?.(sessionId);
    }

    let removedMessages = 0;
    if (scope === 'conversation' || scope === 'both') {
      const idsToDrop = affectedTurns.map((t) => t.id);
      this.store.tx(() => {
        for (const dropId of idsToDrop) {
          const delMsg = this.store.db
            .prepare('DELETE FROM direct_messages WHERE sessionId=? AND turnId=?')
            .run(sessionId, dropId);
          removedMessages += delMsg.changes ?? 0;
          this.store.db
            .prepare('DELETE FROM turn_snapshots WHERE sessionId=? AND turnId=?')
            .run(sessionId, dropId);
          this.store.db.prepare('DELETE FROM direct_turns WHERE id=?').run(dropId);
        }
        this.store.db
          .prepare(
            "UPDATE direct_sessions SET state='completed', activeCompactionId=NULL, updatedAt=? WHERE id=?",
          )
          .run(Date.now(), sessionId);
      });
    } else if (scope === 'code') {
      this.store.tx(() => {
        for (const t of affectedTurns) {
          this.store.db
            .prepare('DELETE FROM turn_snapshots WHERE sessionId=? AND turnId=?')
            .run(sessionId, t.id);
        }
      });
    }

    this.eventRouter.emitPersisted({
      sessionId,
      turnId: targetTurn.id,
      type: 'session/rewound',
      data: {
        sessionId,
        turnId: targetTurn.id,
        scope,
        restoredFiles,
        removedMessages,
      },
      audit: true,
    });

    return {
      ok: true,
      sessionId,
      turnId: targetTurn.id,
      scope,
      restoredFiles,
      removedMessages,
    };
  }

  buildConversationMessages(sessionId, { afterSeq = 0 } = {}) {
    const rows = this.store.db
      .prepare('SELECT * FROM direct_messages WHERE sessionId=? AND seq>? ORDER BY seq ASC')
      .all(sessionId, Number(afterSeq || 0));
    const messages = [];
    for (const r of rows) {
      if (r.role === 'user') {
        const meta = parseJsonSafe(r.meta, null);
        let text = r.content;
        const imageBlocks = [];
        if (meta?.files && typeof meta.files === 'object') {
          const textNotes = [];
          for (const [path, b64] of Object.entries(meta.files).slice(0, 10)) {
            const mime = IMAGE_MIME[extname(path).toLowerCase()];
            if (mime && typeof b64 === 'string') {
              imageBlocks.push({ type: 'image', mimeType: mime, data: b64 });
              textNotes.push(`[附带图像: ${path}]`);
            } else {
              try {
                const decoded = Buffer.from(String(b64), 'base64').toString('utf8');
                textNotes.push(`[附带文件: ${path}]\n${decoded.slice(0, 8000)}`);
              } catch {
                textNotes.push(`[附带文件: ${path}]`);
              }
            }
          }
          if (textNotes.length) text += `\n${textNotes.join('\n')}`;
        }
        messages.push({
          seq: r.seq,
          turnId: r.turnId,
          role: 'user',
          content: [{ type: 'text', text }, ...imageBlocks],
        });
      } else if (r.role === 'assistant') {
        const content = [];
        if (r.content) content.push({ type: 'text', text: r.content });
        const toolCalls = parseJsonSafe(r.toolCalls, []);
        for (const tc of toolCalls) {
          content.push({
            type: 'tool-call',
            id: tc.id,
            name: tc.name,
            arguments:
              typeof tc.arguments === 'string'
                ? tc.arguments
                : JSON.stringify(tc.arguments ?? {}),
          });
        }
        if (content.length) {
          messages.push({ seq: r.seq, turnId: r.turnId, role: 'assistant', content });
        }
      } else if (r.role === 'tool') {
        messages.push({
          seq: r.seq,
          turnId: r.turnId,
          role: 'tool',
          toolCallId: r.toolCallId,
          content: [{ type: 'text', text: r.content }],
        });
      }
    }
    return messages;
  }
}
