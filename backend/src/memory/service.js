import { createHash } from 'node:crypto';
import { redactSecrets, sanitize } from '../envelope.js';
import { id as uuid } from '../store.js';
import {
  ensureMemorySchema,
  getMemoryDb,
  MEMORY_STATUSES,
  MEMORY_TYPES,
} from './schema.js';

const DEFAULT_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CONTENT_CHARS = 8_000;
const MAX_TAGS = 16;
const MAX_TOKEN_BUDGET = 100_000;

function nowValue(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function cleanText(value, max = MAX_CONTENT_CHARS) {
  return sanitize(redactSecrets(String(value ?? '')))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeText(value) {
  return cleanText(value).toLocaleLowerCase().normalize('NFKC');
}

function hashText(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function sanitizeMetadata(value, seen = new WeakSet(), depth = 0) {
  if (depth > 8) return '[metadata-depth-limited]';
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return typeof value === 'string' ? cleanText(value, 1_000) : value;
  }
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[metadata-cycle]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeMetadata(item, seen, depth + 1)).filter((item) => item !== undefined);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    const safe = sanitizeMetadata(item, seen, depth + 1);
    if (safe !== undefined) out[cleanText(key, 100)] = safe;
  }
  seen.delete(value);
  return out;
}

function asTags(tags) {
  const values = Array.isArray(tags) ? tags : [];
  return [...new Set(values.map((tag) => cleanText(tag, 64).toLowerCase()).filter(Boolean))].slice(0, MAX_TAGS);
}

function estimateTokens(text) {
  const value = String(text ?? '');
  return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 4));
}

function tokenSet(text) {
  return new Set(
    normalizeText(text)
      .split(/[^a-z0-9_\u4e00-\u9fff]+/i)
      .filter(Boolean),
  );
}

function overlap(query, content, tags) {
  const q = tokenSet(query);
  if (!q.size) return 0;
  const haystack = new Set([...tokenSet(content), ...tags]);
  let hit = 0;
  for (const token of q) if (haystack.has(token)) hit += 1;
  return hit / q.size;
}

function rowToMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    key: row.memoryKey,
    content: row.content,
    normalizedContent: row.normalizedContent,
    contentHash: row.contentHash,
    memoryClass: row.memoryClass ?? null,
    scopeType: row.scopeType ?? null,
    scopeId: row.scopeId ?? null,
    sourceArtifact: row.sourceArtifact ?? null,
    verificationEvidence: parseJson(row.verificationEvidence, null),
    tags: parseJson(row.tags, []),
    confidence: Number(row.confidence),
    verified: Boolean(row.verified),
    status: row.status,
    source: row.source,
    tokenEstimate: Number(row.tokenEstimate || 0),
    positiveFeedback: Number(row.positiveFeedback || 0),
    negativeFeedback: Number(row.negativeFeedback || 0),
    invalidReason: row.invalidReason ?? null,
    metadata: parseJson(row.metadata, {}),
    supersedesId: row.supersedesId ?? null,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    lastAccessedAt: row.lastAccessedAt == null ? null : Number(row.lastAccessedAt),
    expiresAt: row.expiresAt == null ? null : Number(row.expiresAt),
  };
}

function tx(store, fn) {
  if (typeof store?.tx === 'function') return store.tx(fn);
  const db = getMemoryDb(store);
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  }
}

function assertProject(projectId) {
  const id = cleanText(projectId, 200);
  if (!id) throw new TypeError('projectId is required');
  return id;
}

export class ExperienceMemoryService {
  constructor({ store, clock = Date.now, halfLifeMs = DEFAULT_HALF_LIFE_MS, projectId = null } = {}) {
    this.store = store;
    this.db = ensureMemorySchema(store);
    this.clock = clock;
    this.halfLifeMs = Math.max(1, Number(halfLifeMs) || DEFAULT_HALF_LIFE_MS);
    this.projectId = projectId == null ? null : assertProject(projectId);
  }

  extract(input, { projectId = this.projectId, source = 'conversation' } = {}) {
    const resolvedProject = assertProject(projectId);
    if (Array.isArray(input)) return input.map((item) => ({ ...item, projectId: item.projectId ?? resolvedProject, source: item.source ?? source }));
    if (input && typeof input === 'object' && Array.isArray(input.candidates)) {
      return this.extract(input.candidates, { projectId: resolvedProject, source });
    }
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      return [{ ...input, projectId: input.projectId ?? resolvedProject, source: input.source ?? source }];
    }
    const text = String(input?.text ?? input ?? '').trim();
    if (!text) return [];
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.map((line) => {
      const match = line.match(/^\[(fact|preference|lesson|decision|constraint|note)\]\s*(.*)$/i);
      const body = match ? match[2] : line.replace(/^remember:\s*/i, '');
      const type = match ? match[1].toLowerCase() : 'note';
      return { projectId: resolvedProject, type, content: body, source };
    });
  }

  normalize(candidate, { projectId = this.projectId, source = 'conversation', trustedVerification = false, verificationEvidence = null, sourceArtifact = null } = {}) {
    const project = assertProject(candidate?.projectId ?? projectId);
    const content = cleanText(candidate?.content ?? candidate?.value ?? candidate?.text);
    const key = cleanText(candidate?.key ?? candidate?.memoryKey ?? '', 200).toLowerCase();
    const type = cleanText(candidate?.type ?? 'note', 32).toLowerCase() || 'note';
    const tags = asTags(candidate?.tags);
    const metadata = candidate?.metadata && typeof candidate.metadata === 'object' ? sanitizeMetadata(candidate.metadata) : {};
    const normalizedContent = normalizeText(content);
    return {
      projectId: project,
      type,
      key,
      content,
      normalizedContent,
      contentHash: hashText(normalizedContent),
      memoryClass: candidate?.memoryClass == null ? null : cleanText(candidate.memoryClass, 64),
      scopeType: candidate?.scopeType == null ? null : cleanText(candidate.scopeType, 64),
      scopeId: candidate?.scopeId == null ? null : cleanText(candidate.scopeId, 256),
      sourceArtifact: trustedVerification ? (sourceArtifact ?? candidate?.sourceArtifact ?? null) : null,
      verificationEvidence: trustedVerification ? sanitizeMetadata(verificationEvidence ?? candidate?.verificationEvidence ?? null) : null,
      tags,
      confidence: Number(candidate?.confidence ?? 0.5),
      verified: Boolean(trustedVerification && candidate?.verified && (verificationEvidence ?? candidate?.verificationEvidence)),
      source: cleanText(candidate?.source ?? source, 80) || 'unknown',
      metadata,
      expiresAt: candidate?.expiresAt == null ? null : Number(candidate.expiresAt),
    };
  }

  validate(candidate) {
    const errors = [];
    if (!candidate || typeof candidate !== 'object') errors.push('candidate must be an object');
    if (!candidate?.projectId) errors.push('projectId is required');
    if (!MEMORY_TYPES.includes(candidate?.type)) errors.push(`type must be one of: ${MEMORY_TYPES.join(', ')}`);
    if (!candidate?.content || candidate.content.length > MAX_CONTENT_CHARS) errors.push('content must be 1..8000 characters');
    if (!candidate?.normalizedContent || !candidate?.contentHash) errors.push('normalized content is required');
    if (!Number.isFinite(candidate?.confidence) || candidate.confidence < 0 || candidate.confidence > 1) errors.push('confidence must be between 0 and 1');
    if (!Number.isFinite(candidate?.expiresAt) && candidate?.expiresAt != null) errors.push('expiresAt must be a timestamp');
    return { valid: errors.length === 0, errors, candidate };
  }

  dedupe(candidates, { projectId = this.projectId } = {}) {
    const project = assertProject(projectId);
    const seen = new Map();
    for (const item of candidates ?? []) {
      if (item.projectId !== project) continue;
      const key = `${item.type}\0${item.key}\0${item.contentHash}`;
      const previous = seen.get(key);
      if (!previous || Number(item.confidence) > Number(previous.confidence) || item.verified) seen.set(key, item);
    }
    return [...seen.values()];
  }

  rank(candidates, { query = '', now = nowValue(this.clock) } = {}) {
    return [...(candidates ?? [])]
      .map((candidate) => {
        const age = Math.max(0, now - Number(candidate.updatedAt ?? now));
        const decay = Math.exp(-age / this.halfLifeMs);
        const feedback = Number(candidate.positiveFeedback || 0) - Number(candidate.negativeFeedback || 0);
        const relevance = overlap(query, candidate.content, candidate.tags ?? []);
        const score = (Number(candidate.confidence) * 0.55 + (candidate.verified ? 0.25 : 0) + Math.max(-0.15, Math.min(0.15, feedback * 0.03)) + relevance * 0.2) * decay;
        return { ...candidate, score, decay, relevance };
      })
      .sort((a, b) => b.score - a.score || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  persist(candidates, { projectId = this.projectId, now = nowValue(this.clock) } = {}) {
    const project = assertProject(projectId);
    const valid = [];
    for (const candidate of candidates ?? []) {
      const checked = this.validate(candidate);
      if (checked.valid && candidate.projectId === project) valid.push(candidate);
    }
    return tx(this.store, () => valid.map((candidate) => this.#persistOne(candidate, now)));
  }

  #persistOne(candidate, now) {
    const existingHash = this.db.prepare(
      `SELECT * FROM experience_memory WHERE projectId=? AND contentHash=? AND status='active' LIMIT 1`,
    ).get(candidate.projectId, candidate.contentHash);
    if (existingHash) {
      const confidence = Math.max(Number(existingHash.confidence), Number(candidate.confidence));
      const verified = existingHash.verified || candidate.verified ? 1 : 0;
      this.db.prepare(
        `UPDATE experience_memory SET confidence=?, verified=?, tags=?, updatedAt=?, source=?, metadata=? WHERE id=?`,
      ).run(confidence, verified, JSON.stringify(candidate.tags), now, candidate.source, JSON.stringify(candidate.metadata), existingHash.id);
      return rowToMemory(this.db.prepare('SELECT * FROM experience_memory WHERE id=?').get(existingHash.id));
    }

    const conflict = candidate.key
      ? this.db.prepare(
        `SELECT * FROM experience_memory WHERE projectId=? AND type=? AND memoryKey=? AND status='active' ORDER BY verified DESC, confidence DESC, updatedAt DESC LIMIT 1`,
      ).get(candidate.projectId, candidate.type, candidate.key)
      : null;
    let status = 'active';
    let invalidReason = null;
    let supersedesId = null;
    if (conflict && conflict.normalizedContent !== candidate.normalizedContent) {
      const incomingScore = Number(candidate.confidence) + (candidate.verified ? 0.5 : 0);
      const currentScore = Number(conflict.confidence) + (conflict.verified ? 0.5 : 0);
      if (incomingScore >= currentScore) {
        this.db.prepare(`UPDATE experience_memory SET status='invalid', invalidReason='superseded', updatedAt=? WHERE id=?`).run(now, conflict.id);
        supersedesId = conflict.id;
      } else {
        status = 'invalid';
        invalidReason = 'conflict';
        supersedesId = conflict.id;
      }
    }
    const id = uuid();
    this.db.prepare(
      `INSERT INTO experience_memory(
        id, projectId, type, memoryKey, content, normalizedContent, contentHash,
        memoryClass, scopeType, scopeId, sourceArtifact, verificationEvidence, tags,
        confidence, verified, status, source, tokenEstimate, metadata, supersedesId,
        invalidReason, createdAt, updatedAt, expiresAt
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, candidate.projectId, candidate.type, candidate.key, candidate.content, candidate.normalizedContent,
      candidate.contentHash, candidate.memoryClass, candidate.scopeType, candidate.scopeId,
      candidate.sourceArtifact, candidate.verificationEvidence ? JSON.stringify(candidate.verificationEvidence) : null,
      JSON.stringify(candidate.tags), Math.max(0, Math.min(1, Number(candidate.confidence))),
      candidate.verified ? 1 : 0, status, candidate.source, estimateTokens(candidate.content), JSON.stringify(candidate.metadata),
      supersedesId, invalidReason, now, now, candidate.expiresAt,
    );
    return rowToMemory(this.db.prepare('SELECT * FROM experience_memory WHERE id=?').get(id));
  }

  remember(input, options = {}) {
    const projectId = assertProject(options.projectId ?? this.projectId);
    const extracted = this.extract(input, { projectId, source: options.source ?? 'conversation' });
    const normalized = extracted.map((candidate) => this.normalize({ ...candidate, ...options, projectId }, { projectId, source: options.source })).filter((candidate) => this.validate(candidate).valid);
    return this.persist(this.dedupe(normalized, { projectId }), { projectId });
  }

  rememberVerified(input, { projectId = this.projectId, source = 'server-verification', verificationEvidence, sourceArtifact = null } = {}) {
    const project = assertProject(projectId);
    if (!verificationEvidence || typeof verificationEvidence !== 'object') throw new TypeError('verificationEvidence is required');
    const extracted = this.extract(input, { projectId: project, source });
    const normalized = extracted.map((candidate) => this.normalize({ ...candidate, projectId: project, verified: true }, {
      projectId: project, source, trustedVerification: true, verificationEvidence, sourceArtifact,
    })).filter((candidate) => this.validate(candidate).valid);
    return this.persist(this.dedupe(normalized, { projectId: project }), { projectId: project });
  }

  verifyWithEvidence({ projectId = this.projectId, id: memoryId, evidence, sourceArtifact = null, now = nowValue(this.clock) } = {}) {
    const project = assertProject(projectId);
    if (!evidence || typeof evidence !== 'object') throw new TypeError('verification evidence is required');
    const row = this.db.prepare('SELECT * FROM experience_memory WHERE id=? AND projectId=?').get(memoryId, project);
    if (!row) return null;
    return tx(this.store, () => {
      this.db.prepare('UPDATE experience_memory SET verified=1, confidence=MAX(confidence, 0.8), verificationEvidence=?, sourceArtifact=?, updatedAt=? WHERE id=? AND projectId=?')
        .run(JSON.stringify(sanitizeMetadata(evidence)), sourceArtifact ? cleanText(sourceArtifact, 500) : row.sourceArtifact ?? null, now, memoryId, project);
      return rowToMemory(this.db.prepare('SELECT * FROM experience_memory WHERE id=? AND projectId=?').get(memoryId, project));
    });
  }
  retrieve({ projectId = this.projectId, query = '', limit = 10, tokenBudget = 1_000, now = nowValue(this.clock), includeInvalid = false } = {}) {
    const project = assertProject(projectId);
    const budget = Math.max(0, Math.min(MAX_TOKEN_BUDGET, Number(tokenBudget) || 0));
    const statuses = includeInvalid ? ['active', 'invalid'] : ['active'];
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM experience_memory WHERE projectId=? AND status IN (${placeholders})`).all(project, ...statuses);
    const ranked = this.rank(rows.map(rowToMemory), { query, now }).filter((item) => !String(query).trim() || item.relevance > 0 || item.verified);
    const picked = [];
    let usedTokens = 0;
    for (const item of ranked) {
      if (picked.length >= Math.max(0, Number(limit) || 0)) break;
      if (item.expiresAt != null && item.expiresAt <= now) {
        this.db.prepare(`UPDATE experience_memory SET status='expired', updatedAt=? WHERE id=? AND status='active'`).run(now, item.id);
        continue;
      }
      if (usedTokens + item.tokenEstimate > budget) continue;
      usedTokens += item.tokenEstimate;
      picked.push({ ...item, score: item.score, lastAccessedAt: now });
    }
    if (picked.length) {
      const ids = picked.map((item) => item.id);
      tx(this.store, () => {
        const stmt = this.db.prepare('UPDATE experience_memory SET lastAccessedAt=? WHERE id=?');
        for (const id of ids) stmt.run(now, id);
      });
    }
    return { items: picked, usedTokens, remainingTokens: budget - usedTokens };
  }

  feedback({ projectId = this.projectId, id: memoryId, action, note = null, now = nowValue(this.clock) } = {}) {
    const project = assertProject(projectId);
    const row = this.db.prepare('SELECT * FROM experience_memory WHERE id=? AND projectId=?').get(memoryId, project);
    if (!row) return null;
    if (!['helpful', 'unhelpful', 'invalidate', 'delete', 'restore'].includes(action)) throw new TypeError('unsupported memory feedback action');
    return tx(this.store, () => {
      if (action === 'helpful') this.db.prepare('UPDATE experience_memory SET positiveFeedback=positiveFeedback+1, confidence=MIN(1, confidence+0.05), updatedAt=? WHERE id=?').run(now, memoryId);
      if (action === 'unhelpful') this.db.prepare('UPDATE experience_memory SET negativeFeedback=negativeFeedback+1, confidence=MAX(0, confidence-0.1), updatedAt=? WHERE id=?').run(now, memoryId);
      if (action === 'invalidate') this.db.prepare(`UPDATE experience_memory SET status='invalid', invalidReason=?, updatedAt=? WHERE id=?`).run(note ? cleanText(note, 200) : 'feedback', now, memoryId);
      if (action === 'delete') this.db.prepare(`UPDATE experience_memory SET status='deleted', invalidReason=?, updatedAt=? WHERE id=?`).run(note ? cleanText(note, 200) : 'deleted_by_user', now, memoryId);
      if (action === 'restore') this.db.prepare(`UPDATE experience_memory SET status='active', invalidReason=NULL, updatedAt=? WHERE id=?`).run(now, memoryId);
      return rowToMemory(this.db.prepare('SELECT * FROM experience_memory WHERE id=?').get(memoryId));
    });
  }

  remove({ projectId = this.projectId, id, reason = 'deleted_by_user', now = nowValue(this.clock) } = {}) {
    return this.feedback({ projectId, id, action: 'delete', note: reason, now });
  }
}

export { DEFAULT_HALF_LIFE_MS, estimateTokens, normalizeText, rowToMemory };




