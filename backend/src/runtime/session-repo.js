import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { Fault, id as uuid } from '../store.js';
import { mintNonce } from '../envelope.js';
import { resolveSafePath } from '../workspace-tools.js';
import { classifyTrafficSource, getTraceContext } from '../observability/trace.js';

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function normalizeSnapshotPath(relPath) {
  const norm = String(relPath || '').replace(/\\/g, '/');
  return CASE_INSENSITIVE_FS ? norm.toLowerCase() : norm;
}

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

function parseAllowlistJson(str) {
  if (str === null || str === undefined || str === '') return null;
  try {
    const parsed = JSON.parse(str);
    if (parsed === null) return null;
    if (Array.isArray(parsed)) return parsed.map(String);
    return [];
  } catch {
    // Fail-closed: corrupted non-null allowlist never widens to unrestricted null
    return [];
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
      toolAllow: parseAllowlistJson(row.toolAllowJson),
      toolDeny: parseJsonSafe(row.toolDenyJson, []),
      trafficSource: row.trafficSource || 'production',
      isSynthetic: Boolean(row.isSynthetic),
    };
  }

  ensureSessionNonce(sessionId) {
    const row = this.getSession(sessionId);
    if (row.nonce) return row.nonce;
    const candidate = mintNonce();
    return this.store.tx(() => {
      this.store.db
        .prepare('UPDATE direct_sessions SET nonce=? WHERE id=? AND nonce IS NULL')
        .run(candidate, sessionId);
      const fresh = this.store.db
        .prepare('SELECT nonce FROM direct_sessions WHERE id=?')
        .get(sessionId);
      return fresh?.nonce || candidate;
    });
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
    toolAllow = null,
    toolDeny = null,
    trafficSource = undefined,
    isSynthetic = undefined,
  } = {}) {
    const sessionId = customId?.trim() || uuid();
    const now = Date.now();
    const resolvedModel = model || this.getDefaultModel() || '';
    const resolvedWs = workspaceRoot
      ? resolve(String(workspaceRoot))
      : this.getWorkspaceRoot();
    const nonce = mintNonce();
    const toolAllowJson = Array.isArray(toolAllow) ? JSON.stringify([...new Set(toolAllow.map(String))]) : null;
    const toolDenyJson = Array.isArray(toolDeny) && toolDeny.length ? JSON.stringify([...new Set(toolDeny.map(String))]) : null;

    const traceCtx = getTraceContext();
    let fallbackSource = traceCtx.trafficSource || 'production';
    let fallbackSynth = traceCtx.isSynthetic;
    if (parentSessionId && trafficSource === undefined && isSynthetic === undefined) {
      const parentRow = this.store.db
        .prepare('SELECT trafficSource, isSynthetic FROM direct_sessions WHERE id=?')
        .get(parentSessionId);
      if (parentRow) {
        fallbackSource = parentRow.trafficSource || fallbackSource;
        fallbackSynth = Boolean(parentRow.isSynthetic);
      }
    }
    const classified = classifyTrafficSource(
      {
        trafficSource: trafficSource !== undefined ? trafficSource : fallbackSource,
        isSynthetic:
          isSynthetic !== undefined
            ? isSynthetic
            : trafficSource !== undefined
              ? undefined
              : fallbackSynth,
      },
      fallbackSource,
    );

    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO direct_sessions(
            id, title, workspaceRoot, model, mode, permissionMode, state, nonce, approvedPrefixes,
            parentSessionId, rootSessionId, agentProfile, budgetJson, toolAllowJson, toolDenyJson,
            trafficSource, isSynthetic, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,'idle',?,'[]',?,?,?,?,?,?,?,?,?,?)`,
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
          toolAllowJson,
          toolDenyJson,
          classified.trafficSource,
          classified.isSynthetic ? 1 : 0,
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

  #collectSessionSubtreeIds(rootId) {
    const ids = [rootId];
    const seen = new Set([rootId]);
    for (let i = 0; i < ids.length; i++) {
      const cur = ids[i];
      const children = this.store.db
        .prepare('SELECT id FROM direct_sessions WHERE parentSessionId=?')
        .all(cur);
      for (const ch of children) {
        if (!seen.has(ch.id)) {
          seen.add(ch.id);
          ids.push(ch.id);
        }
      }
    }
    return ids;
  }

  deleteSession(sessionId) {
    this.getSession(sessionId);
    const allIds = this.#collectSessionSubtreeIds(sessionId);
    for (const sid of allIds) {
      this.onSessionDeleted?.(sid);
    }
    this.store.tx(() => {
      // Delete descendants before parent
      for (const sid of [...allIds].reverse()) {
        this.store.db.prepare('DELETE FROM direct_events WHERE sessionId=?').run(sid);
        this.store.db.prepare('DELETE FROM direct_approvals WHERE sessionId=?').run(sid);
        this.store.db.prepare('DELETE FROM context_compactions WHERE sessionId=?').run(sid);
        this.store.db.prepare('DELETE FROM tool_receipts WHERE sessionId=?').run(sid);
        this.store.db.prepare('DELETE FROM runtime_checkpoints WHERE sessionId=?').run(sid);
        this.store.db.prepare('DELETE FROM runtime_jobs WHERE sessionId=?').run(sid);
        this.store.db
          .prepare('DELETE FROM child_notifications WHERE parentSessionId=? OR childSessionId=?')
          .run(sid, sid);
        this.store.db.prepare('DELETE FROM worktree_leases WHERE sessionId=?').run(sid);
        this.store.db.prepare('DELETE FROM direct_sessions WHERE id=?').run(sid);
      }
    });
    return { id: sessionId, deleted: true, deletedSessionCount: allIds.length };
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
    const snapKey = normalizeSnapshotPath(relPath);
    const existing = this.store.db
      .prepare('SELECT id FROM turn_snapshots WHERE turnId=? AND path=?')
      .get(turnId, snapKey);
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
        .run(uuid(), sessionId, turnId, snapKey, existed ? 1 : 0, beforeSha, Date.now());
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
    const beforeRes = this.onBeforeRewind?.(sessionId);
    if (beforeRes && typeof beforeRes.then === 'function') {
      return beforeRes.then(() => this.#executeRewind(session, { turnId, scope }));
    }
    return this.#executeRewind(session, { turnId, scope });
  }

  #executeRewind(session, { turnId = null, scope = 'both' } = {}) {
    const sessionId = session.id;
    const workspaceRoot = session.workspaceRoot || this.getWorkspaceRoot();
    const turns = this.store.db
      .prepare('SELECT rowid AS _rowid, * FROM direct_turns WHERE sessionId=? ORDER BY createdAt ASC, rowid ASC')
      .all(sessionId);
    if (!turns.length) {
      return { ok: true, restoredFiles: [], removedMessages: 0, scope };
    }

    const targetIdx = turnId ? turns.findIndex((t) => t.id === turnId) : turns.length - 1;
    if (targetIdx < 0) throw new Fault('TURN_NOT_FOUND', 404);
    const targetTurn = turns[targetIdx];

    const affectedTurns = turns.slice(targetIdx).reverse();
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
    let rewoundEv = null;
    const evPayload = {
      sessionId,
      turnId: targetTurn.id,
      scope,
      restoredFiles,
      removedMessages: 0,
    };

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
          this.store.db
            .prepare('DELETE FROM tool_receipts WHERE sessionId=? AND turnId=?')
            .run(sessionId, dropId);
          this.store.db
            .prepare('DELETE FROM runtime_checkpoints WHERE sessionId=? AND turnId=?')
            .run(sessionId, dropId);
          this.store.db
            .prepare('DELETE FROM direct_approvals WHERE sessionId=? AND turnId=?')
            .run(sessionId, dropId);
          this.store.db
            .prepare('DELETE FROM runtime_jobs WHERE sessionId=? AND turnId=?')
            .run(sessionId, dropId);
          this.store.db.prepare('DELETE FROM direct_turns WHERE id=?').run(dropId);
        }
        this.store.db
          .prepare(
            "UPDATE direct_sessions SET state='completed', activeCompactionId=NULL, updatedAt=? WHERE id=?",
          )
          .run(Date.now(), sessionId);
        evPayload.removedMessages = removedMessages;
        if (typeof this.eventRouter?.insertPersistedInTx === 'function') {
          rewoundEv = this.eventRouter.insertPersistedInTx({
            sessionId,
            turnId: targetTurn.id,
            type: 'session/rewound',
            data: evPayload,
            audit: true,
          });
        }
      });
    } else if (scope === 'code') {
      this.store.tx(() => {
        for (const t of affectedTurns) {
          this.store.db
            .prepare('DELETE FROM turn_snapshots WHERE sessionId=? AND turnId=?')
            .run(sessionId, t.id);
        }
        if (typeof this.eventRouter?.insertPersistedInTx === 'function') {
          rewoundEv = this.eventRouter.insertPersistedInTx({
            sessionId,
            turnId: targetTurn.id,
            type: 'session/rewound',
            data: evPayload,
            audit: true,
          });
        }
      });
    }

    if (rewoundEv) {
      this.eventRouter.fanoutPersisted(rewoundEv);
    } else {
      this.eventRouter?.emitPersisted({
        sessionId,
        turnId: targetTurn.id,
        type: 'session/rewound',
        data: evPayload,
        audit: true,
      });
    }

    return {
      ok: true,
      sessionId,
      turnId: targetTurn.id,
      scope,
      restoredFiles,
      removedMessages,
    };
  }

  #buildSyntheticToolFallback(sessionId, turnId, tc) {
    let receipt = null;
    try {
      if (this.store?.db?.isOpen) {
        receipt = this.store.db
          .prepare(
            'SELECT id, status, exitCode, errorCode FROM tool_receipts WHERE sessionId=? AND callId=? ORDER BY createdAt DESC LIMIT 1',
          )
          .get(sessionId, tc.id);
      }
    } catch {
      receipt = null;
    }
    if (receipt) {
      if (receipt.status === 'finished') {
        return `[recovered from tool_receipt ${receipt.id}] Tool "${tc.name}" already finished before interruption (exitCode=${receipt.exitCode ?? 0}).`;
      }
      if (receipt.status === 'failed' || receipt.status === 'rejected_before_effect') {
        return `[recovered from tool_receipt ${receipt.id}] Tool "${tc.name}" did not succeed (${receipt.status}${receipt.errorCode ? `: ${receipt.errorCode}` : ''}).`;
      }
      if (receipt.status === 'outcome_unknown') {
        return `[recovered from tool_receipt ${receipt.id}] Tool "${tc.name}" outcome was unknown at interruption.`;
      }
    }
    return `[interrupted before tool result persisted] Tool "${tc.name}" did not persist its tool result; treat as incomplete and re-verify if needed.`;
  }

  buildConversationMessages(sessionId, { afterSeq = 0 } = {}) {
    const rows = this.store.db
      .prepare('SELECT * FROM direct_messages WHERE sessionId=? AND seq>? ORDER BY seq ASC')
      .all(sessionId, Number(afterSeq || 0));
    const rawMessages = [];
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
        rawMessages.push({
          seq: r.seq,
          turnId: r.turnId,
          role: 'user',
          content: [{ type: 'text', text }, ...imageBlocks],
          ...(Array.isArray(meta?._liveContextTail)
            ? { liveContextTail: meta._liveContextTail }
            : {}),
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
          rawMessages.push({ seq: r.seq, turnId: r.turnId, role: 'assistant', content });
        }
      } else if (r.role === 'tool') {
        rawMessages.push({
          seq: r.seq,
          turnId: r.turnId,
          role: 'tool',
          toolCallId: r.toolCallId,
          content: [{ type: 'text', text: r.content }],
        });
      }
    }

    // Enforce strict assistant(tool-call) -> adjacent tool(toolCallId) adjacency so an
    // interrupted onToolResult DB commit NEVER leaves orphaned tool_calls poisoning future LLM calls.
    const messages = [];
    const consumedToolIndices = new Set();
    for (let i = 0; i < rawMessages.length; i++) {
      if (consumedToolIndices.has(i)) continue;
      const m = rawMessages[i];
      if (m.role === 'tool') {
        // Stray tool result without a preceding assistant tool-call batch -> skip
        continue;
      }
      messages.push(m);
      if (m.role === 'assistant') {
        const toolCallBlocks = (m.content ?? []).filter((b) => b.type === 'tool-call' && b.id);
        if (!toolCallBlocks.length) continue;
        const adjacentTools = new Map();
        let j = i + 1;
        while (j < rawMessages.length && rawMessages[j].role === 'tool') {
          const tm = rawMessages[j];
          if (tm.toolCallId && !adjacentTools.has(tm.toolCallId)) {
            adjacentTools.set(tm.toolCallId, tm);
          }
          consumedToolIndices.add(j);
          j++;
        }
        for (const tc of toolCallBlocks) {
          const existingTool = adjacentTools.get(tc.id);
          if (existingTool) {
            messages.push(existingTool);
          } else {
            // Check if a delayed tool result exists later in history (e.g. out-of-order repair)
            let delayedIdx = -1;
            for (let k = j; k < rawMessages.length; k++) {
              if (!consumedToolIndices.has(k) && rawMessages[k].role === 'tool' && rawMessages[k].toolCallId === tc.id) {
                delayedIdx = k;
                break;
              }
            }
            if (delayedIdx >= 0) {
              consumedToolIndices.add(delayedIdx);
              messages.push(rawMessages[delayedIdx]);
            } else {
              messages.push({
                seq: m.seq,
                turnId: m.turnId,
                role: 'tool',
                toolCallId: tc.id,
                content: [{ type: 'text', text: this.#buildSyntheticToolFallback(sessionId, m.turnId, tc) }],
              });
            }
          }
        }
      }
    }
    return messages;
  }
}
