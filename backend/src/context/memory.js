import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { id as uuid } from '../store.js';
import { redactSecrets, sanitize } from '../envelope.js';

function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const tokens = new Set();
  for (const w of s.split(/[^a-z0-9_\u4e00-\u9fff]+/i)) {
    if (!w) continue;
    tokens.add(w);
    if (/[\u4e00-\u9fff]/.test(w) && w.length >= 2) {
      for (let i = 0; i < w.length - 1; i++) {
        tokens.add(w.slice(i, i + 2));
      }
    }
  }
  return tokens;
}

function parseJsonSafe(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Layer 5 ProjectMemoryService unifying:
 * - `.agent-us/MEMORY.md` workspace note file
 * - `nexus_memory` (global / workspace / session scopes)
 * - `records` kind='memory' (governed lessons, excluding withdrawn/expired)
 * - FTS5 cross-session history search
 */
export class ProjectMemoryService {
  constructor(store) {
    this.store = store;
  }

  remember({
    scopeType = 'workspace',
    scopeId = 'global',
    key,
    value,
    kind = 'note',
    tags = [],
    confidence = 1.0,
  }) {
    const cleanKey = sanitize(redactSecrets(String(key ?? '').trim())).slice(0, 200);
    const cleanVal = sanitize(redactSecrets(String(value ?? '').trim())).slice(0, 8000);
    if (!cleanKey) throw new Error('Memory key is required');
    const now = Date.now();
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO nexus_memory(
            id, scopeType, scopeId, key, value, kind, tags, confidence, createdAt, updatedAt, lastAccessedAt
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(scopeType, scopeId, key) DO UPDATE SET
            value=excluded.value, kind=excluded.kind, tags=excluded.tags,
            confidence=excluded.confidence, updatedAt=excluded.updatedAt`,
        )
        .run(
          uuid(),
          String(scopeType),
          String(scopeId),
          cleanKey,
          cleanVal,
          String(kind || 'note'),
          JSON.stringify(Array.isArray(tags) ? tags : []),
          Math.min(1, Math.max(0, Number(confidence ?? 1))),
          now,
          now,
          now,
        );
    });
    return { scopeType, scopeId, key: cleanKey, value: cleanVal, kind, updatedAt: now };
  }

  retrieve({
    query = '',
    workspaceRoot = null,
    sessionId = null,
    projectId = null,
    limit = 10,
    maxChars = 4000,
  } = {}) {
    const candidates = [];
    const ws = workspaceRoot ? resolve(workspaceRoot) : null;
    const now = Date.now();

    // 1. Workspace .agent-us/MEMORY.md
    if (ws) {
      const memFile = join(ws, '.agent-us', 'MEMORY.md');
      if (existsSync(memFile)) {
        try {
          const raw = sanitize(redactSecrets(readFileSync(memFile, 'utf8').trim()));
          if (raw) {
            candidates.push({
              id: 'file:MEMORY.md',
              source: 'file',
              scopeType: 'workspace',
              key: '.agent-us/MEMORY.md',
              value: raw.slice(0, 3000),
              confidence: 1.0,
              updatedAt: now,
              pinned: true,
            });
          }
        } catch {
          // ignore unreadable memory file
        }
      }
    }

    // 2. SQLite nexus_memory
    if (this.store?.db) {
      try {
        const rows = this.store.db
          .prepare(
            `SELECT * FROM nexus_memory
             WHERE scopeType='global'
                OR (? IS NOT NULL AND scopeType='workspace' AND scopeId=?)
                OR (? IS NOT NULL AND scopeType='session' AND scopeId=?)
             ORDER BY updatedAt DESC LIMIT 100`,
          )
          .all(ws, ws, sessionId, sessionId);
        for (const r of rows) {
          candidates.push({
            id: r.id,
            source: 'nexus_memory',
            scopeType: r.scopeType,
            key: r.key,
            value: r.value,
            kind: r.kind,
            tags: parseJsonSafe(r.tags, []),
            confidence: r.confidence ?? 1,
            updatedAt: r.updatedAt,
            pinned: r.kind === 'pinned',
          });
        }
      } catch {
        // ignore
      }

      // 3. Governed Refinement lessons (excluding withdrawn & expired)
      try {
        const lessonRows = this.store.db
          .prepare(
            `SELECT id, projectId, body FROM records
             WHERE kind='memory' AND (? IS NULL OR projectId=?)
             ORDER BY rowid DESC LIMIT 50`,
          )
          .all(projectId, projectId);
        for (const lr of lessonRows) {
          const body = parseJsonSafe(lr.body, null);
          if (!body) continue;
          if (body.status === 'withdrawn' || body.status === 'expired') continue;
          if (body.expiresAt && body.expiresAt <= now) continue;
          candidates.push({
            id: lr.id,
            source: 'refinement',
            scopeType: 'project',
            key: body.title || 'Project Lesson',
            value: body.lesson || body.summary || '',
            confidence: body.status === 'pinned' ? 1.0 : 0.9,
            updatedAt: body.createdAt ?? now,
            pinned: body.status === 'pinned',
          });
        }
      } catch {
        // ignore
      }
    }

    const qTokens = tokenize(query);
    const scored = candidates.map((item) => {
      let overlap = 0;
      if (qTokens.size > 0) {
        const itemTokens = tokenize(`${item.key} ${item.value} ${(item.tags || []).join(' ')}`);
        for (const qt of qTokens) {
          if (itemTokens.has(qt)) overlap++;
        }
      }
      const lexical = qTokens.size > 0 ? overlap / qTokens.size : 0.2;
      const ageDays = Math.max(0, (now - (item.updatedAt || now)) / 86_400_000);
      const recency = 1 / (1 + ageDays / 14);
      const pinBoost = item.pinned ? 0.5 : 0;
      const score = lexical * 3 + recency * 0.8 + (item.confidence ?? 1) * 0.5 + pinBoost;
      return { ...item, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, Math.max(1, limit));

    // Touch lastAccessedAt for picked nexus_memory items
    const touchedIds = picked.filter((p) => p.source === 'nexus_memory').map((p) => p.id);
    if (touchedIds.length && this.store?.db) {
      this.store.tx(() => {
        for (const mid of touchedIds) {
          this.store.db
            .prepare('UPDATE nexus_memory SET lastAccessedAt=? WHERE id=?')
            .run(now, mid);
        }
      });
    }

    const lines = [];
    let usedChars = 0;
    for (const p of picked) {
      const line = `- [${p.scopeType}] **${p.key}**: ${String(p.value).slice(0, 500)}`;
      if (usedChars + line.length > maxChars) break;
      lines.push(line);
      usedChars += line.length + 1;
    }

    return {
      items: picked,
      text: lines.join('\n'),
    };
  }
}
