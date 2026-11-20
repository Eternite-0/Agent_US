import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Fault, id as uuid } from './store.js';
import { compactTwoStage, excerpt } from './context.js';
import { mintNonce } from './envelope.js';
import { sha256Hex } from './integrity.js';
import { verifyTurn, buildRepairNote } from './verifier.js';
import {
  buildRuntimeContextMessage,
  buildStaticSystemPrompt,
  discoverMemoryAndSkills,
  discoverProjectInstructions,
  HookRunner,
} from './agent-context.js';
import {
  canonicalizeCommandPrefix,
  scheduleToolBatch,
} from './patch-and-diagnostics.js';
import {
  BackgroundProcessManager,
  createWorkspaceTools,
  resolveSafePath,
  WORKSPACE_TOOL_META,
} from './workspace-tools.js';
import { McpHub } from './mcp-client.js';

const execFileAsync = promisify(execFile);

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

async function detectGitBranch(cwd) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, windowsHide: true, timeout: 2500 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export class DirectAgentRuntime {
  constructor(
    store,
    pool,
    {
      defaultWorkspace = process.cwd(),
      dataRoot = null,
      adapter = null,
      judgment = null,
      staticMcp = {},
    } = {},
  ) {
    this.store = store;
    this.pool = pool;
    this.adapter = adapter ?? pool.adapter;
    this.judgment = judgment;
    this.defaultWorkspace = resolve(defaultWorkspace);
    this.dataRoot = dataRoot ? resolve(dataRoot) : null;
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(100);
    this.activeTurns = new Map(); // turnId -> { controller, sessionId }
    this.activeSessionTurn = new Map(); // sessionId -> turnId
    this.steeringQueues = new Map(); // sessionId -> string[]
    this.readFileStates = new Map(); // sessionId -> Map(relPath -> { sha256, at })
    this.pendingApprovals = new Map(); // approvalId -> { resolve, reject }
    this.processManager = new BackgroundProcessManager();
    this.mcpHub = new McpHub({ dataRoot: this.dataRoot, staticMcp });
    this.ephemeralSeq = 0;
  }

  close() {
    for (const active of this.activeTurns.values()) {
      active.controller.abort();
    }
    this.activeTurns.clear();
    this.activeSessionTurn.clear();
    this.processManager.closeAll();
    this.mcpHub.close();
  }

  getWorkspaceRoot() {
    const saved = this.store.getSetting('workspace.root', null);
    return saved ? resolve(String(saved)) : this.defaultWorkspace;
  }

  setWorkspaceRoot(dirPath) {
    const clean = resolve(String(dirPath || '').trim() || this.defaultWorkspace);
    this.store.setSetting('workspace.root', clean);
    return { workspaceRoot: clean };
  }

  // ---- Event Publishing (Persistent + Live Ephemeral Deltas) ----

  #emitPersisted(sessionId, turnId, type, data) {
    const at = Date.now();
    const res = this.store.tx(() =>
      this.store.db
        .prepare(
          'INSERT INTO direct_events(sessionId, turnId, type, data, at) VALUES(?,?,?,?,?)',
        )
        .run(sessionId, turnId ?? null, type, JSON.stringify(data ?? {}), at),
    );
    const seq = Number(res.lastInsertRowid);
    const ev = { seq, sessionId, turnId: turnId ?? null, type, data: data ?? {}, at };
    this.bus.emit('event', ev);
    this.bus.emit(`session:${sessionId}`, ev);
    return ev;
  }

  #emitLiveDelta(sessionId, turnId, type, data) {
    const ev = {
      seq: 0,
      ephemeral: true,
      ephemeralId: ++this.ephemeralSeq,
      sessionId,
      turnId,
      type,
      data,
      at: Date.now(),
    };
    this.bus.emit('event', ev);
    this.bus.emit(`session:${sessionId}`, ev);
    return ev;
  }

  subscribe(sessionId, listener) {
    const channel = sessionId ? `session:${sessionId}` : 'event';
    this.bus.on(channel, listener);
    return () => this.bus.off(channel, listener);
  }

  // ---- Session CRUD ----

  #hydrateSessionRow(row) {
    if (!row) return null;
    return {
      ...row,
      plan: parseJsonSafe(row.planJson, null),
      approvedPrefixes: parseJsonSafe(row.approvedPrefixes, []),
    };
  }

  #ensureSessionNonce(sessionId) {
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
      .map((r) => this.#hydrateSessionRow(r));
  }

  getSession(sessionId) {
    const row = this.store.db
      .prepare('SELECT * FROM direct_sessions WHERE id=?')
      .get(sessionId);
    if (!row) throw new Fault('SESSION_NOT_FOUND', 404);
    return this.#hydrateSessionRow(row);
  }

  createSession({
    id: customId = null,
    title = '新对话',
    model = null,
    workspaceRoot = null,
    mode = 'direct',
    permissionMode = 'auto-safe',
  } = {}) {
    const sessionId = customId?.trim() || uuid();
    const now = Date.now();
    const resolvedModel = model || this.pool.getDefaultModel() || '';
    const resolvedWs = workspaceRoot
      ? resolve(String(workspaceRoot))
      : this.getWorkspaceRoot();
    const nonce = mintNonce();
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO direct_sessions(
            id, title, workspaceRoot, model, mode, permissionMode, state, nonce, approvedPrefixes, createdAt, updatedAt
          ) VALUES(?,?,?,?,?,?,'idle',?,'[]',?,?)`,
        )
        .run(
          sessionId,
          String(title || '新对话').slice(0, 200),
          resolvedWs,
          resolvedModel,
          mode || 'direct',
          permissionMode || 'auto-safe',
          nonce,
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
    for (const [turnId, active] of this.activeTurns.entries()) {
      if (active.sessionId === sessionId) {
        active.controller.abort();
        this.activeTurns.delete(turnId);
      }
    }
    this.activeSessionTurn.delete(sessionId);
    this.steeringQueues.delete(sessionId);
    this.readFileStates.delete(sessionId);
    this.store.tx(() => {
      this.store.db
        .prepare('DELETE FROM direct_events WHERE sessionId=?')
        .run(sessionId);
      this.store.db
        .prepare('DELETE FROM direct_approvals WHERE sessionId=?')
        .run(sessionId);
      this.store.db
        .prepare('DELETE FROM direct_sessions WHERE id=?')
        .run(sessionId);
    });
    return { id: sessionId, deleted: true };
  }

  listTurns(sessionId, { limit = 50 } = {}) {
    return this.store.db
      .prepare(
        'SELECT * FROM direct_turns WHERE sessionId=? ORDER BY createdAt DESC LIMIT ?',
      )
      .all(sessionId, Math.min(200, Math.max(1, Number(limit))));
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

  listEvents(sessionId, { after = 0, limit = 300 } = {}) {
    const rows = sessionId
      ? this.store.db
          .prepare(
            'SELECT * FROM direct_events WHERE sessionId=? AND seq>? ORDER BY seq ASC LIMIT ?',
          )
          .all(sessionId, Number(after || 0), Math.min(1000, Math.max(1, Number(limit))))
      : this.store.db
          .prepare(
            'SELECT * FROM direct_events WHERE seq>? ORDER BY seq ASC LIMIT ?',
          )
          .all(Number(after || 0), Math.min(1000, Math.max(1, Number(limit))));
    return rows.map((r) => ({
      seq: r.seq,
      sessionId: r.sessionId,
      turnId: r.turnId,
      type: r.type,
      data: parseJsonSafe(r.data, {}),
      at: r.at,
    }));
  }

  // ---- Per-Turn Deterministic Snapshots & `/rewind` (Claude Code Pattern) ----

  #capturePreMutationSnapshot(sessionId, turnId, relPath, fullPath) {
    const existing = this.store.db
      .prepare('SELECT id FROM turn_snapshots WHERE turnId=? AND path=?')
      .get(turnId, relPath);
    if (existing) return; // Already captured initial pre-turn state for this file!
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
        .run(
          uuid(),
          sessionId,
          turnId,
          relPath,
          existed ? 1 : 0,
          beforeSha,
          Date.now(),
        );
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
      .prepare(
        'SELECT * FROM direct_turns WHERE sessionId=? ORDER BY createdAt ASC',
      )
      .all(sessionId);
    if (!turns.length) {
      return { ok: true, restoredFiles: [], removedMessages: 0, scope };
    }

    const targetTurn = turnId
      ? turns.find((t) => t.id === turnId)
      : turns.at(-1);
    if (!targetTurn) throw new Fault('TURN_NOT_FOUND', 404);

    // Cancel any running turn first
    const runningTurnId = this.activeSessionTurn.get(sessionId);
    if (runningTurnId) this.cancelTurn(runningTurnId);

    const affectedTurns = turns
      .filter((t) => t.createdAt >= targetTurn.createdAt)
      .reverse(); // Undo newest -> oldest!
    const restoredFiles = [];

    if (scope === 'code' || scope === 'both') {
      const seenPaths = new Set();
      for (const t of affectedTurns) {
        const snaps = this.store.db
          .prepare('SELECT * FROM turn_snapshots WHERE turnId=?')
          .all(t.id);
        for (const snap of snaps) {
          // Since we walk newest -> oldest, applying every turn down to targetTurn ends at targetTurn's pre-state
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
      // Clear readFileState so agent re-reads restored files cleanly
      this.readFileStates.delete(sessionId);
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
          this.store.db
            .prepare('DELETE FROM direct_turns WHERE id=?')
            .run(dropId);
        }
        this.store.db
          .prepare(
            "UPDATE direct_sessions SET state='completed', updatedAt=? WHERE id=?",
          )
          .run(Date.now(), sessionId);
      });
    } else if (scope === 'code') {
      // Remove snapshots for code that was restored
      this.store.tx(() => {
        for (const t of affectedTurns) {
          this.store.db
            .prepare('DELETE FROM turn_snapshots WHERE sessionId=? AND turnId=?')
            .run(sessionId, t.id);
        }
      });
    }

    this.#emitPersisted(sessionId, targetTurn.id, 'session/rewound', {
      sessionId,
      turnId: targetTurn.id,
      scope,
      restoredFiles,
      removedMessages,
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

  // ---- Mid-Turn Steering Queue (Codex input_queue.rs) ----

  steerSession(sessionId, text) {
    this.getSession(sessionId);
    const clean = String(text ?? '').trim();
    if (!clean) throw new Fault('EMPTY_INPUT', 400);
    const activeTurnId = this.activeSessionTurn.get(sessionId);
    if (!activeTurnId) {
      // No turn running right now -> seamlessly start a normal turn!
      return { steered: false, ...this.startTurn(sessionId, { input: clean }) };
    }
    const queue = this.steeringQueues.get(sessionId) ?? [];
    queue.push(clean);
    this.steeringQueues.set(sessionId, queue);
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO direct_messages(
            sessionId, turnId, role, content, meta, createdAt
          ) VALUES(?,?,'user',?,?,?)`,
        )
        .run(
          sessionId,
          activeTurnId,
          clean,
          JSON.stringify({ steering: true }),
          Date.now(),
        );
    });
    this.#emitPersisted(sessionId, activeTurnId, 'turn/steered', {
      sessionId,
      turnId: activeTurnId,
      text: clean,
    });
    return { steered: true, sessionId, turnId: activeTurnId, queued: queue.length };
  }

  // ---- Manual / Automatic Context Compaction (`/compact`) ----

  async #summarizeHistoryWithLlm(messagesToSummarize, model, signal) {
    const transcript = messagesToSummarize
      .map((m) => {
        const txt = Array.isArray(m.content)
          ? m.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
          : '';
        return `[${m.role}]: ${txt.slice(0, 1200)}`;
      })
      .join('\n')
      .slice(0, 16000);
    if (!transcript.trim()) return '';
    let summary = '';
    for await (const chunk of this.adapter.stream({
      provider: 'pool',
      model,
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: '请将以下早期对话与工具执行记录压缩为简洁精准的中文交接摘要，保留关键文件路径、已完成的修改、重要决策与未解决的问题。不超过 600 字。',
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: transcript }] },
      ],
      maxTokens: 1024,
      signal,
    })) {
      if (chunk.type === 'text-delta') summary += chunk.text;
    }
    return summary.trim();
  }

  async compactSession(sessionId) {
    const session = this.getSession(sessionId);
    const rows = this.store.db
      .prepare('SELECT * FROM direct_messages WHERE sessionId=? ORDER BY seq ASC')
      .all(sessionId);
    if (rows.length <= 6) {
      return { compacted: false, reason: '消息数量较少，无需压缩', count: rows.length };
    }
    const keepRecent = 4;
    const oldRows = rows.slice(0, rows.length - keepRecent);
    const oldMsgs = oldRows.map((r) => ({
      role: r.role,
      content: [{ type: 'text', text: r.content }],
    }));
    const model = session.model || this.pool.getDefaultModel();
    let summary = '';
    if (model) {
      try {
        summary = await this.#summarizeHistoryWithLlm(
          oldMsgs,
          model,
          AbortSignal.timeout(20000),
        );
      } catch {
        summary = '';
      }
    }
    if (!summary) {
      summary = oldRows
        .filter((r) => r.role === 'user' || r.role === 'assistant')
        .slice(-6)
        .map((r) => `- ${r.role}: ${String(r.content).slice(0, 160)}`)
        .join('\n');
    }
    const maxOldSeq = oldRows.at(-1).seq;
    this.store.tx(() => {
      this.store.db
        .prepare('DELETE FROM direct_messages WHERE sessionId=? AND seq<=?')
        .run(sessionId, maxOldSeq);
      this.store.db
        .prepare(
          `INSERT INTO direct_messages(
            sessionId, turnId, role, content, meta, createdAt
          ) VALUES(?,NULL,'assistant',?,?,?)`,
        )
        .run(
          sessionId,
          `[历史上下文摘要]\n${summary}`,
          JSON.stringify({ compactedSummary: true, compressedCount: oldRows.length }),
          Date.now(),
        );
    });
    this.#emitPersisted(sessionId, null, 'session/compacted', {
      sessionId,
      compressedCount: oldRows.length,
      summaryLength: summary.length,
    });
    return {
      compacted: true,
      compressedCount: oldRows.length,
      summary,
    };
  }

  // ---- Interactive Approvals (with Codex Session Prefix Caching!) ----

  listApprovals({ sessionId = null, status = null, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (sessionId) {
      where.push('sessionId=?');
      params.push(sessionId);
    }
    if (status) {
      where.push('status=?');
      params.push(status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.store.db
      .prepare(
        `SELECT * FROM direct_approvals ${clause} ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(...params, Math.min(500, Math.max(1, Number(limit))))
      .map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        turnId: r.turnId,
        callId: r.callId,
        tool: r.tool,
        arguments: parseJsonSafe(r.arguments, {}),
        status: r.status,
        scope: r.scope,
        reason: r.reason,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
      }));
  }

  decideApproval(approvalId, { decision, scope = 'once', reason = '' } = {}) {
    const row = this.store.db
      .prepare('SELECT * FROM direct_approvals WHERE id=?')
      .get(approvalId);
    if (!row) return null;
    const normalized =
      decision === 'allow' || decision === 'approve' ? 'allowed' : 'denied';
    const now = Date.now();
    const args = parseJsonSafe(row.arguments, {});

    this.store.tx(() => {
      this.store.db
        .prepare(
          'UPDATE direct_approvals SET status=?, scope=?, reason=?, resolvedAt=? WHERE id=?',
        )
        .run(normalized, scope, reason || null, now, approvalId);

      // Codex session-prefix approval caching: remember canonical command prefix for this session!
      if (
        normalized === 'allowed' &&
        (scope === 'session' || scope === 'session-prefix') &&
        (row.tool === 'bash' || row.tool === 'start_process')
      ) {
        const prefix =
          args.commandPrefix || canonicalizeCommandPrefix(args.command);
        if (prefix) {
          const sessRow = this.store.db
            .prepare('SELECT approvedPrefixes FROM direct_sessions WHERE id=?')
            .get(row.sessionId);
          const cur = parseJsonSafe(sessRow?.approvedPrefixes, []);
          if (!cur.includes(prefix)) {
            cur.push(prefix);
            this.store.db
              .prepare(
                'UPDATE direct_sessions SET approvedPrefixes=?, updatedAt=? WHERE id=?',
              )
              .run(JSON.stringify(cur), now, row.sessionId);
          }
        }
      }
    });

    const waiter = this.pendingApprovals.get(approvalId);
    if (waiter) {
      this.pendingApprovals.delete(approvalId);
      waiter.resolve(normalized === 'allowed');
    }
    const updated = {
      id: row.id,
      sessionId: row.sessionId,
      turnId: row.turnId,
      callId: row.callId,
      tool: row.tool,
      arguments: args,
      status: normalized,
      scope,
      reason: reason || null,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      resolvedAt: now,
    };
    this.#emitPersisted(row.sessionId, row.turnId, 'approval/resolved', {
      approvalId: row.id,
      status: normalized,
      scope,
      tool: row.tool,
    });
    return updated;
  }

  #requestApproval({ sessionId, turnId, callId, tool, args, signal }) {
    const approvalId = uuid();
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000;
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO direct_approvals(
            id, sessionId, turnId, callId, tool, arguments, status, expiresAt, createdAt
          ) VALUES(?,?,?,?,?,?,'pending',?,?)`,
        )
        .run(
          approvalId,
          sessionId,
          turnId,
          callId ?? null,
          tool,
          JSON.stringify(args ?? {}),
          expiresAt,
          now,
        );
    });
    this.#emitPersisted(sessionId, turnId, 'approval/requested', {
      approvalId,
      callId,
      tool,
      arguments: args ?? {},
      expiresAt,
    });

    return new Promise((resolveDecision, rejectDecision) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pendingApprovals.delete(approvalId);
      };
      const onAbort = () => {
        cleanup();
        this.store.tx(() => {
          this.store.db
            .prepare(
              "UPDATE direct_approvals SET status='expired', resolvedAt=? WHERE id=? AND status='pending'",
            )
            .run(Date.now(), approvalId);
        });
        rejectDecision(new Error('对话轮次已取消'));
      };
      const timer = setTimeout(() => {
        cleanup();
        this.store.tx(() => {
          this.store.db
            .prepare(
              "UPDATE direct_approvals SET status='expired', resolvedAt=? WHERE id=? AND status='pending'",
            )
            .run(Date.now(), approvalId);
        });
        resolveDecision(false);
      }, 10 * 60 * 1000);

      this.pendingApprovals.set(approvalId, {
        resolve: (allowed) => {
          cleanup();
          resolveDecision(allowed);
        },
        reject: (err) => {
          cleanup();
          rejectDecision(err);
        },
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ---- Turn Execution (Claude Code + Codex + Agnes Direct Streaming Loop) ----

  startTurn(
    sessionId,
    {
      input,
      clientTurnId = null,
      model = null,
      permissionMode = null,
      effort = null,
      maxSteps = 24,
      files = null,
    } = {},
  ) {
    const session = this.getSession(sessionId);
    const trimmedInput = String(input ?? '').trim();
    if (!trimmedInput) throw new Fault('EMPTY_INPUT', 400);

    // If a turn is already actively running on this session, treat as mid-turn steering!
    if (this.activeSessionTurn.has(sessionId) && !clientTurnId) {
      const steered = this.steerSession(sessionId, trimmedInput);
      return {
        steered: true,
        turn: this.store.db
          .prepare('SELECT * FROM direct_turns WHERE id=?')
          .get(steered.turnId),
        session: this.getSession(sessionId),
      };
    }

    if (clientTurnId) {
      const existing = this.store.db
        .prepare(
          'SELECT * FROM direct_turns WHERE sessionId=? AND clientTurnId=? LIMIT 1',
        )
        .get(sessionId, clientTurnId);
      if (existing) return { turn: existing, session };
    }

    const turnId = uuid();
    const now = Date.now();
    const resolvedModel =
      (model && String(model).trim()) ||
      session.model ||
      this.pool.getDefaultModel() ||
      '';
    const resolvedPerm = permissionMode || session.permissionMode || 'auto-safe';
    const isPlanSlash = trimmedInput.startsWith('/plan ');
    const effectiveMode = isPlanSlash ? 'plan' : session.mode || 'direct';

    this.store.tx(() => {
      const nextTitle =
        session.title === '新对话' || !session.title
          ? trimmedInput.slice(0, 120)
          : session.title;
      this.store.db
        .prepare(
          "UPDATE direct_sessions SET title=?, model=?, permissionMode=?, state='running', updatedAt=? WHERE id=?",
        )
        .run(nextTitle, resolvedModel, resolvedPerm, now, sessionId);
      this.store.db
        .prepare(
          `INSERT INTO direct_turns(
            id, sessionId, clientTurnId, input, model, state, createdAt
          ) VALUES(?,?,?,?,?,'running',?)`,
        )
        .run(turnId, sessionId, clientTurnId, trimmedInput, resolvedModel, now);
      this.store.db
        .prepare(
          `INSERT INTO direct_messages(
            sessionId, turnId, role, content, meta, createdAt
          ) VALUES(?,?,'user',?,?,?)`,
        )
        .run(
          sessionId,
          turnId,
          trimmedInput,
          files && Object.keys(files).length ? JSON.stringify({ files }) : null,
          now,
        );
    });

    const turn = this.store.db
      .prepare('SELECT * FROM direct_turns WHERE id=?')
      .get(turnId);
    const controller = new AbortController();
    this.activeTurns.set(turnId, { controller, sessionId });
    this.activeSessionTurn.set(sessionId, turnId);

    void this.#runTurnLoop({
      sessionId,
      turnId,
      input: trimmedInput,
      model: resolvedModel,
      mode: effectiveMode,
      permissionMode: resolvedPerm,
      effort: effort || null,
      workspaceRoot: session.workspaceRoot || this.getWorkspaceRoot(),
      maxSteps: Math.min(40, Math.max(1, Number(maxSteps || 24))),
      signal: controller.signal,
    });

    return { turn, session: this.getSession(sessionId) };
  }

  cancelTurn(turnId) {
    const active = this.activeTurns.get(turnId);
    if (active) {
      active.controller.abort();
      this.activeTurns.delete(turnId);
      if (this.activeSessionTurn.get(active.sessionId) === turnId) {
        this.activeSessionTurn.delete(active.sessionId);
      }
    }
    const row = this.store.db
      .prepare('SELECT * FROM direct_turns WHERE id=?')
      .get(turnId);
    if (!row) throw new Fault('TURN_NOT_FOUND', 404);
    if (row.state === 'running') {
      const now = Date.now();
      this.store.tx(() => {
        this.store.db
          .prepare(
            "UPDATE direct_turns SET state='cancelled', finishedAt=? WHERE id=?",
          )
          .run(now, turnId);
        this.store.db
          .prepare(
            "UPDATE direct_sessions SET state='cancelled', updatedAt=? WHERE id=?",
          )
          .run(now, row.sessionId);
      });
      this.#emitPersisted(row.sessionId, turnId, 'turn/cancelled', { turnId });
    }
    return this.store.db
      .prepare('SELECT * FROM direct_turns WHERE id=?')
      .get(turnId);
  }

  #buildConversationMessages(sessionId) {
    const rows = this.store.db
      .prepare(
        'SELECT * FROM direct_messages WHERE sessionId=? ORDER BY seq ASC',
      )
      .all(sessionId);
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
        if (content.length) messages.push({ role: 'assistant', content });
      } else if (r.role === 'tool') {
        messages.push({
          role: 'tool',
          toolCallId: r.toolCallId,
          content: [{ type: 'text', text: r.content }],
        });
      }
    }
    return messages;
  }

  async #runSubagentQuery({
    sessionId,
    turnId,
    objective,
    role,
    workspaceRoot,
    model,
    maxSteps = 6,
    isolatedWorktree = false,
    signal,
    nonce,
  }) {
    const subId = `sub_${uuid().slice(0, 8)}`;
    this.#emitPersisted(sessionId, turnId, 'subagent/started', {
      subagentId: subId,
      role,
      objective,
      isolatedWorktree,
    });

    let effectiveRoot = workspaceRoot;
    let worktreeTempDir = null;
    if (isolatedWorktree) {
      try {
        const tmp = mkdtempSync(join(tmpdir(), 'agent-us-wt-'));
        await execFileAsync('git', ['worktree', 'add', '--detach', tmp, 'HEAD'], {
          cwd: workspaceRoot,
          windowsHide: true,
          timeout: 8000,
        });
        effectiveRoot = tmp;
        worktreeTempDir = tmp;
      } catch {
        // Not a git repo or worktree unavailable -> fall back to read-only workspace
      }
    }

    try {
      const allTools = createWorkspaceTools({
        workspaceRoot: effectiveRoot,
        store: this.store,
        sessionId,
        permissionMode: worktreeTempDir ? 'auto-safe' : 'approval',
        nonce,
        signal,
      });
      // Read-only unless explicitly isolated inside a disposable Git Worktree
      const tools = worktreeTempDir
        ? allTools.filter((t) =>
            ['read_file', 'glob', 'grep', 'edit_file', 'write_file', 'apply_patch', 'read_blob'].includes(
              t.name,
            ),
          )
        : allTools.filter((t) => WORKSPACE_TOOL_META[t.name]?.readOnly && t.name !== 'spawn_subagent');

      const msgs = [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: `你是独立调研子助手 (${role})，围绕目标高效阅读/搜索工作区代码并返回精炼准确的结构化结论。\n工作区：${effectiveRoot}`,
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: objective }] },
      ];

      let finalReply = '';
      for (let step = 0; step < maxSteps; step++) {
        signal.throwIfAborted();
        let stepText = '';
        const toolCalls = [];
        for await (const chunk of this.adapter.stream({
          provider: 'pool',
          model,
          messages: msgs,
          tools,
          maxTokens: 2048,
          signal,
        })) {
          if (chunk.type === 'text-delta') stepText += chunk.text;
          else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
            toolCalls.push(chunk.block);
          }
        }
        finalReply = stepText;
        if (!toolCalls.length) break;
        msgs.push({
          role: 'assistant',
          content: [
            ...(stepText ? [{ type: 'text', text: stepText }] : []),
            ...toolCalls,
          ],
        });
        const outputs = await scheduleToolBatch(
          toolCalls,
          (tc) => Boolean(WORKSPACE_TOOL_META[tc.name]?.readOnly),
          async (tc) => {
            const impl = tools.find((t) => t.name === tc.name);
            try {
              const parsed = JSON.parse(tc.arguments || '{}');
              return impl
                ? String(await impl.execute(parsed, { callId: tc.id }))
                : `未知子代理工具: ${tc.name}`;
            } catch (err) {
              return `工具执行失败: ${String(err?.message ?? err)}`;
            }
          },
        );
        for (let k = 0; k < toolCalls.length; k++) {
          msgs.push({
            role: 'tool',
            toolCallId: toolCalls[k].id,
            content: [{ type: 'text', text: outputs[k] }],
          });
        }
      }

      this.#emitPersisted(sessionId, turnId, 'subagent/completed', {
        subagentId: subId,
        role,
        summary: excerpt(finalReply, 500),
      });
      return finalReply;
    } finally {
      if (worktreeTempDir) {
        await execFileAsync('git', ['worktree', 'remove', '--force', worktreeTempDir], {
          cwd: workspaceRoot,
          windowsHide: true,
          timeout: 5000,
        }).catch(() => {});
        rmSync(worktreeTempDir, { recursive: true, force: true });
      }
    }
  }

  async #runTurnLoop({
    sessionId,
    turnId,
    input,
    model,
    mode,
    permissionMode,
    effort,
    workspaceRoot,
    maxSteps,
    signal,
  }) {
    const started = Date.now();
    // Session-pinned nonce keeps System Prompt byte-identical across turns (Prompt Cache!)
    const nonce = this.#ensureSessionNonce(sessionId);
    const hooks = new HookRunner(workspaceRoot, { dataRoot: this.dataRoot });
    let totalIn = 0;
    let totalOut = 0;
    let totalCacheRead = 0;
    let steps = 0;
    const argStrikes = new Map();
    const recentCallSigs = []; // Thrashing / Loop Circuit Breaker window
    let thrashWarned = false;
    let stopContinuedOnce = false;
    let repairedOnce = false;

    let readFileState = this.readFileStates.get(sessionId);
    if (!readFileState) {
      readFileState = new Map();
      this.readFileStates.set(sessionId, readFileState);
    }

    this.#emitPersisted(sessionId, turnId, 'turn/started', {
      turnId,
      sessionId,
      model,
      mode,
      effort,
      workspaceRoot,
    });

    try {
      const effectiveModel = model || this.pool.getDefaultModel();
      if (!effectiveModel) {
        throw new Fault('NO_MODEL_CONFIGURED', 400, {
          message:
            '尚未配置任何可用模型。请前往「设置 → 账号号池」添加供应商账号并点击「获取模型」，即可无需重启立刻开始对话。',
        });
      }

      // Discover AGENTS.md/CLAUDE.md, MEMORY.md, Skills, Git branch, MCP tools, and SessionStart hooks concurrently!
      const [gitBranch, mcpTools, startHook] = await Promise.all([
        detectGitBranch(workspaceRoot),
        this.mcpHub.discoverTools(workspaceRoot).catch(() => []),
        hooks
          .run('SessionStart', { sessionId, turnId, input })
          .catch(() => ({ blocked: false, additionalContexts: [] })),
      ]);
      const projectInstructions = discoverProjectInstructions(workspaceRoot);
      const { memoryText, skillsText } = discoverMemoryAndSkills(
        workspaceRoot,
        this.store,
        { dataRoot: this.dataRoot },
      );

      const tools = createWorkspaceTools({
        workspaceRoot,
        store: this.store,
        sessionId,
        permissionMode,
        nonce,
        getApprovedPrefixes: () => this.getSession(sessionId).approvedPrefixes ?? [],
        readFileState,
        processManager: this.processManager,
        mcpTools,
        signal,
        requestApproval: ({ tool, arguments: args, callId }) =>
          this.#requestApproval({
            sessionId,
            turnId,
            callId,
            tool,
            args,
            signal,
          }),
        onBeforeMutate: (rel, full) =>
          this.#capturePreMutationSnapshot(sessionId, turnId, rel, full),
        onFileChanged: (change) => {
          this.#emitPersisted(sessionId, turnId, 'file/changed', {
            turnId,
            sessionId,
            ...change,
          });
        },
        onToolOutput: (chunk) => {
          this.#emitLiveDelta(sessionId, turnId, 'tool/output', {
            turnId,
            sessionId,
            ...chunk,
          });
        },
        onPlanUpdated: (plan) => {
          this.store.tx(() => {
            this.store.db
              .prepare(
                'UPDATE direct_sessions SET planJson=?, updatedAt=? WHERE id=?',
              )
              .run(JSON.stringify(plan), Date.now(), sessionId);
          });
          this.#emitPersisted(sessionId, turnId, 'plan/updated', {
            turnId,
            sessionId,
            plan,
          });
        },
        runSubagent: (opts) =>
          this.#runSubagentQuery({
            sessionId,
            turnId,
            ...opts,
            workspaceRoot,
            model: effectiveModel,
            signal,
            nonce,
          }),
      });

      const toolMap = new Map(tools.map((t) => [t.name, t]));
      const staticSystemPrompt = buildStaticSystemPrompt(nonce);
      const runtimeContextText = buildRuntimeContextMessage({
        workspaceRoot,
        gitBranch,
        mode,
        permissionMode,
        projectInstructions,
        memoryText,
        skillsText,
        planState: this.getSession(sessionId).plan,
        hookContexts: startHook.additionalContexts ?? [],
      });

      const history = this.#buildConversationMessages(sessionId);
      const messages = [
        { role: 'system', content: [{ type: 'text', text: staticSystemPrompt }] },
        // Keep volatile workspace/AGENTS.md/memory context outside the static system block for Prompt Cache stability
        { role: 'user', content: [{ type: 'text', text: runtimeContextText }] },
        { role: 'assistant', content: [{ type: 'text', text: '已了解当前工作区与项目规范。' }] },
        ...history,
      ];

      const contextWindow = this.pool.getModelContextWindow(effectiveModel);
      let finalAssistantText = '';
      const turnEventsForVerifier = [];

      while (steps < maxSteps) {
        signal.throwIfAborted();
        steps++;

        // Drain mid-turn steering messages queued by the user while running!
        const queuedSteers = this.steeringQueues.get(sessionId);
        if (queuedSteers?.length) {
          const drained = queuedSteers.splice(0);
          for (const steerText of drained) {
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `[用户实时纠偏指令]\n${steerText}`,
                },
              ],
            });
          }
        }

        const compacted = await compactTwoStage(
          {
            provider: 'pool',
            model: effectiveModel,
            sessionKey: sessionId,
            effort,
            messages,
            tools,
            maxTokens: 4096,
            signal,
          },
          {
            contextWindow: Math.min(200000, contextWindow),
            summarize: (oldMsgs) =>
              this.#summarizeHistoryWithLlm(oldMsgs, effectiveModel, signal),
          },
        );
        if (compacted.stage > 0) {
          this.#emitPersisted(sessionId, turnId, 'context/compacted', {
            stage: compacted.stage,
            step: steps,
          });
        }

        let stepText = '';
        let stepReasoning = '';
        const stepToolCalls = [];

        for await (const chunk of this.adapter.stream(compacted.options)) {
          signal.throwIfAborted();
          if (chunk.type === 'usage' && chunk.usage) {
            totalIn += Number(chunk.usage.inputTokens ?? 0);
            totalOut += Number(chunk.usage.outputTokens ?? 0);
            totalCacheRead += Number(chunk.usage.cacheReadTokens ?? 0);
          } else if (chunk.type === 'reasoning-delta' && chunk.text) {
            stepReasoning += chunk.text;
            this.#emitLiveDelta(sessionId, turnId, 'reasoning/delta', {
              turnId,
              sessionId,
              delta: chunk.text,
              text: stepReasoning,
            });
          } else if (chunk.type === 'text-delta' && chunk.text) {
            stepText += chunk.text;
            this.#emitLiveDelta(sessionId, turnId, 'assistant/delta', {
              turnId,
              sessionId,
              delta: chunk.text,
              text: stepText,
            });
          } else if (
            chunk.type === 'block-end' &&
            chunk.block?.type === 'tool-call'
          ) {
            stepToolCalls.push(chunk.block);
          }
        }

        if (stepText || stepReasoning || stepToolCalls.length) {
          this.store.tx(() => {
            this.store.db
              .prepare(
                `INSERT INTO direct_messages(
                  sessionId, turnId, role, content, reasoning, toolCalls, createdAt
                ) VALUES(?,?,'assistant',?,?,?,?)`,
              )
              .run(
                sessionId,
                turnId,
                stepText,
                stepReasoning || null,
                stepToolCalls.length ? JSON.stringify(stepToolCalls) : null,
                Date.now(),
              );
          });
          messages.push({
            role: 'assistant',
            content: [
              ...(stepText ? [{ type: 'text', text: stepText }] : []),
              ...stepToolCalls,
            ],
          });
          if (stepText) {
            finalAssistantText = stepText;
            this.#emitPersisted(sessionId, turnId, 'assistant/message', {
              turnId,
              sessionId,
              text: stepText,
              reasoning: stepReasoning || undefined,
              hasToolCalls: stepToolCalls.length > 0,
            });
          }
        }

        // ---- No tool calls: check steering, Agnes premature-stop, & T0 verifier before exiting ----
        if (!stepToolCalls.length) {
          if (this.steeringQueues.get(sessionId)?.length) continue;

          // 1. Optional Agnes System-1 Premature-Stop Guard (max 1 continuation)
          if (
            this.judgment &&
            typeof this.judgment.detectPrematureStop === 'function' &&
            !stopContinuedOnce &&
            stepText &&
            steps < maxSteps
          ) {
            const check = await this.judgment
              .detectPrematureStop({
                requestText: input,
                replyText: stepText,
                hasTools: false,
                alreadyContinued: stopContinuedOnce,
                signal,
              })
              .catch(() => null);
            if (check?.shouldContinue && check.note) {
              stopContinuedOnce = true;
              messages.push({
                role: 'user',
                content: [{ type: 'text', text: check.note }],
              });
              continue;
            }
          }

          // 2. Deterministic Agnes T0 Verifier (only when tools ran in this turn and ended with errors/unverified claims)
          if (
            !repairedOnce &&
            turnEventsForVerifier.length > 0 &&
            stepText &&
            steps < maxSteps
          ) {
            const verdict = verifyTurn({
              events: turnEventsForVerifier,
              text: stepText,
            });
            if (verdict && verdict.verdict !== 'pass') {
              repairedOnce = true;
              this.#emitPersisted(sessionId, turnId, 'verifier/repair', {
                verdict: verdict.verdict,
                reasons: verdict.reasons,
              });
              messages.push({
                role: 'user',
                content: [{ type: 'text', text: buildRepairNote(verdict) }],
              });
              continue;
            }
          }

          break;
        }

        // ---- Execute tool calls via Agnes/Codex Read-Parallel + Write-Barrier Scheduler! ----
        const executedBatch = await scheduleToolBatch(
          stepToolCalls,
          (tc) => Boolean(WORKSPACE_TOOL_META[tc.name]?.readOnly),
          async (tc) => {
            signal.throwIfAborted();
            const toolImpl = toolMap.get(tc.name);
            let parsedArgs = null;
            let parseErr = null;
            try {
              parsedArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
            } catch (err) {
              parseErr = String(err?.message ?? err);
            }

            this.#emitPersisted(sessionId, turnId, 'tool/call', {
              turnId,
              sessionId,
              callId: tc.id,
              name: tc.name,
              arguments: parsedArgs ?? tc.arguments,
            });

            const tStart = Date.now();
            let output = '';
            let isError = false;

            if (!toolImpl) {
              isError = true;
              output = `错误：未知工具「${tc.name}」。可用工具：${[...toolMap.keys()].join(', ')}`;
            } else if (parseErr) {
              const strikes = (argStrikes.get(tc.name) ?? 0) + 1;
              argStrikes.set(tc.name, strikes);
              isError = true;
              output =
                strikes <= 2
                  ? `参数 JSON 解析失败 (${parseErr})。请输出合法的 JSON 参数并重试工具 ${tc.name}。`
                  : `参数连续多次格式错误，终止该工具调用。`;
            } else {
              // Run PreToolUse lifecycle hook
              const preHook = await hooks
                .run('PreToolUse', {
                  sessionId,
                  turnId,
                  tool: tc.name,
                  arguments: parsedArgs,
                })
                .catch(() => ({ blocked: false, updatedInput: null, additionalContexts: [] }));
              if (preHook.blocked) {
                isError = true;
                output = `PreToolUse Hook 拦截：${preHook.reason}`;
              } else {
                const effectiveArgs = preHook.updatedInput ?? parsedArgs;
                try {
                  output = String(
                    (await toolImpl.execute(effectiveArgs, { callId: tc.id })) ?? '',
                  );
                } catch (err) {
                  isError = true;
                  output = `执行失败：${String(err?.message ?? err)}`;
                }
                // Run PostToolUse lifecycle hook
                const postHook = await hooks
                  .run('PostToolUse', {
                    sessionId,
                    turnId,
                    tool: tc.name,
                    arguments: effectiveArgs,
                    isError,
                    output: output.slice(0, 4000),
                  })
                  .catch(() => ({ additionalContexts: [] }));
                if (postHook.additionalContexts?.length) {
                  output += `\n[PostToolUse Hook]\n${postHook.additionalContexts.join('\n')}`;
                }
              }
            }

            const durationMs = Date.now() - tStart;
            return { tc, parsedArgs, output, isError, durationMs };
          },
        );

        // Persist tool results in exact call order + check Thrashing/Loop Circuit Breaker!
        let detectedThrashing = false;
        for (const item of executedBatch) {
          const { tc, output, isError, durationMs } = item;
          this.store.tx(() => {
            this.store.db
              .prepare(
                `INSERT INTO direct_messages(
                  sessionId, turnId, role, content, toolCallId, toolName, meta, createdAt
                ) VALUES(?,?,'tool',?,?,?,?,?)`,
              )
              .run(
                sessionId,
                turnId,
                excerpt(output, 32000),
                tc.id,
                tc.name,
                JSON.stringify({ isError, durationMs }),
                Date.now(),
              );
          });
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            content: [{ type: 'text', text: output }],
          });
          turnEventsForVerifier.push({
            type: 'tool/result',
            data: { name: tc.name, isError, content: output },
          });
          this.#emitPersisted(sessionId, turnId, 'tool/result', {
            turnId,
            sessionId,
            callId: tc.id,
            name: tc.name,
            isError,
            durationMs,
            output: excerpt(output, 4000),
          });

          // Rolling Thrashing / Loop signature check
          const sig = sha256Hex(`${tc.name}::${tc.arguments}::${isError}`);
          recentCallSigs.push(sig);
          if (recentCallSigs.length > 6) recentCallSigs.shift();
          const repeatCount = recentCallSigs.filter((s) => s === sig).length;
          if (repeatCount >= 3) detectedThrashing = true;
        }

        if (detectedThrashing) {
          if (!thrashWarned) {
            thrashWarned = true;
            this.#emitPersisted(sessionId, turnId, 'loop/thrashing_warning', {
              step: steps,
            });
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: '[系统防死循环提示] 检测到你连续多次执行相同的失败/重复工具调用。请停止重复相同参数，换一种思路排查，或直接向用户如实汇报当前进展与阻塞点。',
                },
              ],
            });
          } else {
            // Hard circuit break on 2nd thrashing streak
            break;
          }
        }
      }

      await hooks
        .run('Stop', { sessionId, turnId, steps, text: excerpt(finalAssistantText, 1000) })
        .catch(() => {});

      const durationMs = Date.now() - started;
      const finishedAt = Date.now();
      const totalTokens = totalIn + totalOut;

      this.store.tx(() => {
        this.store.db
          .prepare(
            `UPDATE direct_turns
             SET state='completed', inputTokens=?, outputTokens=?, durationMs=?, finishedAt=?
             WHERE id=?`,
          )
          .run(totalIn, totalOut, durationMs, finishedAt, turnId);
        this.store.db
          .prepare(
            "UPDATE direct_sessions SET state='completed', updatedAt=? WHERE id=?",
          )
          .run(finishedAt, sessionId);
        this.store.db
          .prepare(
            `INSERT INTO nexus_usage(
              sessionId, provider, model, day, inputTokens, outputTokens, tokens, costUsd, durationMs, createdAt
            ) VALUES(?,'pool',?,?,?,?,?,0,?,?)`,
          )
          .run(
            sessionId,
            effectiveModel,
            todayDateStr(),
            totalIn,
            totalOut,
            totalTokens,
            durationMs,
            finishedAt,
          );
      });

      this.store.event('direct.turn.completed', null, null, {
        sessionId,
        turnId,
        model: effectiveModel,
        steps,
        inputTokens: totalIn,
        outputTokens: totalOut,
        cacheReadTokens: totalCacheRead,
        durationMs,
      });

      this.#emitPersisted(sessionId, turnId, 'turn/completed', {
        turnId,
        sessionId,
        model: effectiveModel,
        steps,
        inputTokens: totalIn,
        outputTokens: totalOut,
        cacheReadTokens: totalCacheRead,
        durationMs,
        text: excerpt(finalAssistantText, 4000),
      });
    } catch (err) {
      const durationMs = Date.now() - started;
      const finishedAt = Date.now();
      const isCancelled = signal.aborted;
      const message = String(err?.detail?.message ?? err?.message ?? err);
      const nextState = isCancelled ? 'cancelled' : 'failed';

      this.store.tx(() => {
        this.store.db
          .prepare(
            'UPDATE direct_turns SET state=?, error=?, inputTokens=?, outputTokens=?, durationMs=?, finishedAt=? WHERE id=?',
          )
          .run(
            nextState,
            isCancelled ? null : message.slice(0, 1000),
            totalIn,
            totalOut,
            durationMs,
            finishedAt,
            turnId,
          );
        this.store.db
          .prepare('UPDATE direct_sessions SET state=?, updatedAt=? WHERE id=?')
          .run(nextState, finishedAt, sessionId);
      });

      if (!isCancelled) {
        this.#emitPersisted(sessionId, turnId, 'turn/failed', {
          turnId,
          sessionId,
          error: message,
          durationMs,
        });
      }
    } finally {
      this.activeTurns.delete(turnId);
      if (this.activeSessionTurn.get(sessionId) === turnId) {
        this.activeSessionTurn.delete(sessionId);
      }
    }
  }
}
