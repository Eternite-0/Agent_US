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
  if (Array.isArray(value)) {
    const arr = value.slice(0, 100).map((item) => sanitizeMetadata(item, seen, depth + 1)).filter((item) => item !== undefined);
    seen.delete(value);
    return arr;
  }
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

function normalizeMemoryPath(filePath, workspaceRoot = null) {
  let raw = String(filePath ?? '').trim().replace(/\\/g, '/');
  if (!raw || raw === '.') return '';
  if (workspaceRoot) {
    const rootNorm = String(workspaceRoot).trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (rootNorm) {
      const cmpRaw = process.platform === 'win32' ? raw.toLowerCase() : raw;
      const cmpRoot = process.platform === 'win32' ? rootNorm.toLowerCase() : rootNorm;
      if (cmpRaw === cmpRoot) return '';
      if (cmpRaw.startsWith(`${cmpRoot}/`)) {
        raw = raw.slice(rootNorm.length + 1);
      }
    }
  }
  raw = raw.replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/^\/+/, '');
  const cleaned = cleanText(raw, 300);
  return cleaned === '.' ? '' : cleaned;
}

function pathBasename(normPath) {
  const idx = normPath.lastIndexOf('/');
  return idx >= 0 ? normPath.slice(idx + 1) : normPath;
}

function normalizeErrorSignature(raw) {
  const cleaned = cleanText(raw, 240)
    .toLowerCase()
    .replace(/(?:[a-z]:)?\/(?:users|home|var|tmp)\/[^\s:/]+(?:\/[^\s:]+)?\//gi, '<path>/')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .trim();
  return cleaned;
}

function extractErrorTokensFromText(rawText) {
  const text = cleanText(rawText, 600);
  if (!text) return [];
  const tokens = [];
  for (const match of text.matchAll(/\b([A-Z][A-Za-z]*Error|ERR_[A-Z0-9_]+|E_[A-Z0-9_]+|STALE_VERIFICATION_AFTER_EDIT|UNRESOLVED_VERIFICATION_FAILURE|FABRICATED_PASS_CLAIM|EVIDENCE_INCOMPLETE|DISK_FILE_MISSING|STEP_BUDGET_EXHAUSTED|LOOP_THRASHING_ABORT)\b/g)) {
    tokens.push(match[1].toLowerCase());
  }
  for (const match of text.matchAll(/\b([a-z0-9_./-]+\.[cm]?[jt]s:\d+(?::\d+)?)\b/gi)) {
    tokens.push(match[1].replace(/\\/g, '/').toLowerCase());
  }
  return tokens;
}

function collectNormalizedFiles({
  modifiedFiles = [],
  reasoningMetrics = null,
  toolReceipts = [],
  verdict = null,
  workspaceRoot = null,
} = {}) {
  const out = new Set();
  const addPath = (p) => {
    const norm = normalizeMemoryPath(p, workspaceRoot);
    if (norm) out.add(norm);
  };
  for (const p of Array.isArray(modifiedFiles) ? modifiedFiles : []) addPath(p);
  for (const p of Array.isArray(reasoningMetrics?.filesMutated) ? reasoningMetrics.filesMutated : []) {
    addPath(p);
  }
  for (const receipt of Array.isArray(toolReceipts) ? toolReceipts : []) {
    if (!receipt || typeof receipt !== 'object') continue;
    const args = receipt.effectiveArgs ?? receipt.args ?? receipt.arguments ?? null;
    if (receipt.path) addPath(receipt.path);
    if (receipt.file) addPath(receipt.file);
    if (args && typeof args === 'object') {
      if (args.path) addPath(args.path);
      if (args.file_path) addPath(args.file_path);
      if (Array.isArray(args.paths)) for (const p of args.paths) addPath(p);
    }
  }
  for (const missing of Array.isArray(verdict?.checks?.missingDiskFiles) ? verdict.checks.missingDiskFiles : []) {
    addPath(missing);
  }
  return [...out].slice(0, 32);
}

function extractErrorFingerprints({
  verdict = null,
  reasoningMetrics = null,
  toolReceipts = [],
  error = null,
  errorCode = null,
  failureCategory = null,
  summary = '',
  output = '',
} = {}) {
  const out = new Set();
  const addSig = (value) => {
    const sig = normalizeErrorSignature(value);
    if (sig) out.add(sig);
  };
  const addFromText = (text) => {
    const cleaned = cleanText(text, 400);
    if (!cleaned) return;
    for (const tok of extractErrorTokensFromText(cleaned)) addSig(tok);
    addSig(cleaned.slice(0, 180));
  };

  if (failureCategory && String(failureCategory) !== 'none') {
    addSig(failureCategory);
  }
  if (errorCode) {
    addSig(errorCode);
  }
  if (error) {
    addFromText(error);
  }
  if (Array.isArray(verdict?.reasons)) {
    for (const reason of verdict.reasons) addFromText(reason);
  }
  if (reasoningMetrics && typeof reasoningMetrics === 'object') {
    if (Array.isArray(reasoningMetrics.errorFingerprints)) {
      for (const fp of reasoningMetrics.errorFingerprints) {
        if (typeof fp === 'string') {
          addSig(fp);
        } else if (fp && typeof fp === 'object') {
          if (fp.signature) addSig(fp.signature);
          if (fp.errorType) addSig(fp.errorType);
          if (fp.code) addSig(fp.code);
          if (fp.location) addSig(fp.location);
          if (fp.file) addSig(fp.line != null ? `${fp.file}:${fp.line}` : fp.file);
          if (fp.message || fp.excerpt || fp.assertionExcerpt) {
            addFromText(fp.message ?? fp.excerpt ?? fp.assertionExcerpt);
          }
        }
      }
    }
    if (Array.isArray(reasoningMetrics.falsifiedAttempts)) {
      for (const attempt of reasoningMetrics.falsifiedAttempts) {
        if (!attempt || typeof attempt !== 'object') continue;
        if (attempt.errorSignature) addSig(attempt.errorSignature);
        if (attempt.errorCode) addSig(attempt.errorCode);
        if (attempt.location) addSig(attempt.location);
        if (attempt.reason || attempt.error || attempt.hypothesisSummary) {
          addFromText(attempt.reason ?? attempt.error ?? attempt.hypothesisSummary);
        }
      }
    }
  }
  for (const r of Array.isArray(toolReceipts) ? toolReceipts : []) {
    if (!r || typeof r !== 'object') continue;
    const failed = r.status === 'failed' || r.isError === true || (typeof r.exitCode === 'number' && r.exitCode !== 0);
    if (!failed) continue;
    if (r.errorCode) addSig(r.errorCode);
    if (typeof r.exitCode === 'number' && r.exitCode !== 0) addSig(`exit:${r.exitCode}`);
    addFromText(r.error ?? r.stderr ?? r.output ?? r.content ?? '');
  }
  if (out.size === 0 && (verdict?.verdict === 'fail' || verdict?.accepted === false)) {
    addFromText(summary || output);
  }
  return [...out].slice(0, 16);
}

function computePathAffinity(candidate, normTargets) {
  if (!normTargets.length) return 0;
  const metaFiles = [
    ...(Array.isArray(candidate?.metadata?.modifiedFiles) ? candidate.metadata.modifiedFiles : []),
    ...(Array.isArray(candidate?.metadata?.targetFiles) ? candidate.metadata.targetFiles : []),
    ...(Array.isArray(candidate?.metadata?.files) ? candidate.metadata.files : []),
  ].map((p) => normalizeMemoryPath(p)).filter(Boolean);
  const tagFiles = (Array.isArray(candidate?.tags) ? candidate.tags : [])
    .filter((t) => /[/.]/.test(String(t)))
    .map((t) => normalizeMemoryPath(t))
    .filter(Boolean);
  const candFiles = [...new Set([...metaFiles, ...tagFiles])];
  const candLower = candFiles.map((p) => p.toLowerCase());
  const candBases = candLower.map(pathBasename);
  const normContent = normalizeText(candidate?.content ?? '');

  let maxMatch = 0;
  let sumMatch = 0;
  for (const rawTarget of normTargets) {
    const target = rawTarget.toLowerCase();
    const tBase = pathBasename(target);
    let best = 0;
    if (candLower.includes(target)) {
      best = 1.0;
    } else if (candLower.some((cf) => cf.endsWith(`/${target}`) || target.endsWith(`/${cf}`))) {
      best = 0.8;
    } else if (normContent.includes(target)) {
      best = 0.6;
    } else if (tBase.length >= 5 && candBases.includes(tBase)) {
      best = 0.45;
    }
    if (best > maxMatch) maxMatch = best;
    sumMatch += best;
  }
  return Math.min(1, 0.7 * maxMatch + 0.3 * (sumMatch / normTargets.length));
}

function computeErrorAffinity(candidate, normErrorSigs) {
  if (!normErrorSigs.length) return 0;
  const structuredSigs = [
    ...(Array.isArray(candidate?.metadata?.errorFingerprints) ? candidate.metadata.errorFingerprints : []),
    ...(candidate?.metadata?.errorCode ? [candidate.metadata.errorCode] : []),
    ...(candidate?.metadata?.failureCategory && candidate.metadata.failureCategory !== 'none'
      ? [candidate.metadata.failureCategory]
      : []),
    ...(Array.isArray(candidate?.tags) ? candidate.tags : []),
  ].map((s) => normalizeErrorSignature(s)).filter(Boolean);
  const uniqueSigs = [...new Set(structuredSigs)];
  const normContent = normalizeErrorSignature(candidate?.content ?? '');
  const candErrTokens = new Set(uniqueSigs.flatMap((s) => [...tokenSet(s)]));

  let maxMatch = 0;
  let sumMatch = 0;
  for (const sig of normErrorSigs) {
    let best = 0;
    if (uniqueSigs.includes(sig)) {
      best = 1.0;
    } else if (
      (sig.length >= 4 && uniqueSigs.some((cs) => cs.includes(sig) || (cs.length >= 4 && sig.includes(cs)))) ||
      (sig.length >= 4 && normContent.includes(sig))
    ) {
      best = 0.75;
    } else {
      const sTokens = tokenSet(sig);
      if (sTokens.size > 0 && candErrTokens.size > 0) {
        let hits = 0;
        for (const tok of sTokens) if (candErrTokens.has(tok)) hits += 1;
        if (hits > 0) best = 0.55 * (hits / sTokens.size);
      }
    }
    if (best > maxMatch) maxMatch = best;
    sumMatch += best;
  }
  return Math.min(1, 0.7 * maxMatch + 0.3 * (sumMatch / normErrorSigs.length));
}

function buildDistilledLessonCandidate({
  project,
  isFailure,
  resolvedSource,
  scopeType,
  scopeId,
  evalRunId,
  input,
  summary,
  output,
  verdict,
  error,
  errorCode,
  resolvedFailureCategory,
  normalizedFiles,
  errorFingerprints,
  receipts,
  reasoningMetrics,
  workspaceRoot,
  sourceTaskId,
  sessionId,
  turnId,
  runId,
}) {
  const memoryClass = isFailure ? 'failure_trap_pattern' : 'verified_fix_pattern';
  const cleanInput = cleanText(input, 200);
  const cleanOutcome = cleanText(
    summary || output || (Array.isArray(verdict?.reasons) ? verdict.reasons.join('; ') : ''),
    240,
  );
  const cleanErr = cleanText(
    error ||
      (Array.isArray(verdict?.reasons) ? verdict.reasons.join('; ') : '') ||
      errorCode ||
      resolvedFailureCategory ||
      'execution failed',
    240,
  );
  const verifyCommands = [
    ...new Set(
      receipts
        .filter((r) => ['bash', 'start_process'].includes(String(r.toolName ?? r.name ?? '')))
        .map((r) => cleanText(r.command ?? r.effectiveArgs?.command ?? '', 180))
        .filter(Boolean),
    ),
  ].slice(0, 6);

  const filesLabel = normalizedFiles.length ? normalizedFiles.slice(0, 6).join(', ') : 'none';
  const fpLabel = errorFingerprints.slice(0, 3).join(', ');
  const content = isFailure
    ? `[failure_trap_pattern]${cleanInput ? ` Task: ${cleanInput}.` : ''} Category: ${
        resolvedFailureCategory || cleanText(errorCode, 64) || 'failed'
      }. Files: ${filesLabel}. Trap: ${cleanErr}${fpLabel ? `. Fingerprints: ${fpLabel}` : ''}`
    : `[verified_fix_pattern]${cleanInput ? ` Task: ${cleanInput}.` : ''} Files: ${filesLabel}. Outcome: ${
        cleanOutcome || 'Verified fix passed'
      }${reasoningMetrics?.selfCorrectionRecovered && fpLabel ? `. Recovered from: ${fpLabel}` : ''}`;

  const fileTags = normalizedFiles.slice(0, 4).flatMap((f) => {
    const base = pathBasename(f);
    return base && base !== f ? [f, base] : [f];
  });
  const tags = asTags([
    memoryClass,
    resolvedSource,
    ...(resolvedFailureCategory ? [resolvedFailureCategory] : []),
    ...(errorCode ? [errorCode] : []),
    ...(reasoningMetrics?.selfCorrectionRecovered ? ['self-corrected'] : []),
    ...errorFingerprints.slice(0, 4),
    ...fileTags,
  ]);

  const keySeed = `${memoryClass}|${scopeType}|${evalRunId || ''}|${cleanInput}|${normalizedFiles.join(',')}|${
    resolvedFailureCategory || ''
  }|${errorFingerprints.slice(0, 3).join(',')}`;
  const metadata = sanitizeMetadata({
    memoryClass,
    workspaceRoot: workspaceRoot ? String(workspaceRoot).replace(/\\/g, '/') : null,
    modifiedFiles: normalizedFiles,
    targetFiles: normalizedFiles,
    errorFingerprints,
    errorCode: errorCode ? cleanText(errorCode, 80) : null,
    failureCategory: resolvedFailureCategory,
    verdictStatus: verdict?.verdict ? cleanText(verdict.verdict, 64) : null,
    verificationCommands: verifyCommands,
    sourceTaskId: sourceTaskId ? cleanText(sourceTaskId, 200) : null,
    sessionId: sessionId ? cleanText(sessionId, 200) : null,
    turnId: turnId ? cleanText(turnId, 200) : null,
    runId: runId ? cleanText(runId, 200) : null,
    ...(reasoningMetrics && typeof reasoningMetrics === 'object' ? { reasoningMetrics } : {}),
  });

  return {
    projectId: project,
    type: 'lesson',
    key: `${memoryClass}:${hashText(normalizeText(keySeed)).slice(0, 16)}`,
    memoryClass,
    content: cleanText(content, MAX_CONTENT_CHARS),
    tags,
    confidence: isFailure ? (Number(reasoningMetrics?.ineffectiveActionCount || 0) > 0 ? 0.7 : 0.6) : 0.65,
    scopeType,
    scopeId,
    metadata,
  };
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

function assertTrustedEvidence({ projectId, evidence, sourceTaskId = null, evaluationRunId = null } = {}) {
  const project = assertProject(projectId);
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new TypeError('verification evidence is required');
  }
  const taskId = cleanText(sourceTaskId ?? evidence.sourceTaskId ?? evidence.taskId ?? '', 200);
  const runId = cleanText(evaluationRunId ?? evidence.evaluationRunId ?? '', 200);
  if (!taskId || !runId) {
    throw new TypeError('trusted verification requires sourceTaskId and evaluationRunId');
  }
  if (evidence.projectId != null && assertProject(evidence.projectId) !== project) {
    throw new TypeError('verification evidence project does not match memory project');
  }
  const score = evidence.score;
  if (score && typeof score === 'object') {
    const total = Number(score.total);
    const passed = Number(score.passed);
    if (Number(score.failed) > 0 || Number(score.cancelled) > 0 || Number(score.timedOut) > 0 ||
      (Number.isFinite(total) && Number.isFinite(passed) && passed < total)) {
      throw new TypeError('only fully passed evaluation evidence may verify memory');
    }
  }
  return { project, sourceTaskId: taskId, evaluationRunId: runId };
}

export class ExperienceMemoryService {
  #verificationAuthority = Symbol('trusted-memory-verification');
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

  rank(candidates, { query = '', now = nowValue(this.clock), targetFiles = [], errorSignatures = [] } = {}) {
    const normTargets = (Array.isArray(targetFiles) ? targetFiles : [])
      .map((p) => normalizeMemoryPath(p))
      .filter(Boolean);
    const normErrors = (Array.isArray(errorSignatures) ? errorSignatures : [])
      .map((sig) => normalizeErrorSignature(sig))
      .filter(Boolean);
    return [...(candidates ?? [])]
      .map((candidate) => {
        const age = Math.max(0, now - Number(candidate.updatedAt ?? now));
        const decay = Math.exp(-age / this.halfLifeMs);
        const feedback = Number(candidate.positiveFeedback || 0) - Number(candidate.negativeFeedback || 0);
        const relevance = overlap(query, candidate.content, candidate.tags ?? []);
        const pathAffinity = normTargets.length ? computePathAffinity(candidate, normTargets) : 0;
        const errorAffinity = normErrors.length ? computeErrorAffinity(candidate, normErrors) : 0;
        const score =
          (Number(candidate.confidence) * 0.55 +
            (candidate.verified ? 0.25 : 0) +
            Math.max(-0.15, Math.min(0.15, feedback * 0.03)) +
            relevance * 0.2 +
            pathAffinity * 0.22 +
            errorAffinity * 0.28) *
          decay;
        return { ...candidate, score, decay, relevance, pathAffinity, errorAffinity };
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

  extractExecutionCandidates({
    projectId = this.projectId,
    source = 'direct_turn',
    sourceTaskId = null,
    sessionId = null,
    turnId = null,
    runId = null,
    goal = '',
    summary = '',
    verdict = null,
    evidenceCount = 0,
    artifactUris = [],
    isSynthetic = false,
  } = {}) {
    if (!projectId || isSynthetic) return [];
    const resolvedProject = assertProject(projectId);
    const scopeType = runId ? 'swarm_run' : 'direct_turn';
    const scopeId = cleanText(runId || turnId || sourceTaskId || '', 200) || null;
    const cleanUris = [...new Set((Array.isArray(artifactUris) ? artifactUris : []).map((u) => cleanText(u, 500)).filter(Boolean))].slice(0, 20);
    const traceMeta = {
      sourceTaskId: sourceTaskId ? cleanText(sourceTaskId, 200) : null,
      sessionId: sessionId ? cleanText(sessionId, 200) : null,
      turnId: turnId ? cleanText(turnId, 200) : null,
      runId: runId ? cleanText(runId, 200) : null,
      artifactUris: cleanUris,
      evidenceCount: Math.max(0, Number(evidenceCount || 0)),
      verdictStatus: verdict?.verdict ? cleanText(verdict.verdict, 64) : null,
    };

    const lines = String(summary ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const taggedCandidates = [];
    for (const line of lines) {
      const match = line.match(/^\[(fact|preference|lesson|decision|constraint)\]\s*(.+)$/i);
      if (!match) continue;
      const type = match[1].toLowerCase();
      const body = cleanText(match[2], 1200);
      if (!body) continue;
      taggedCandidates.push({
        projectId: resolvedProject,
        type,
        key: `${type}-${hashText(normalizeText(body)).slice(0, 12)}`,
        content: body,
        tags: [source, 'candidate', ...(cleanUris.length ? ['artifact-backed'] : [])],
        confidence: 0.6,
        scopeType,
        scopeId,
        metadata: traceMeta,
      });
    }
    if (taggedCandidates.length > 0) return taggedCandidates;

    const hasEvidence = (verdict?.accepted === true && Number(evidenceCount) > 0) || cleanUris.length > 0;
    const cleanGoal = cleanText(goal, 280);
    const cleanSummary = cleanText(summary, 500);
    if (!hasEvidence || (!cleanGoal && !cleanSummary)) return [];

    const content = cleanGoal && cleanSummary
      ? `[${cleanText(source, 40)}] Goal: ${cleanGoal} -> Outcome: ${cleanSummary}`
      : cleanSummary || cleanGoal;
    return [
      {
        projectId: resolvedProject,
        type: 'lesson',
        key: `exec-${hashText(normalizeText(cleanGoal || cleanSummary)).slice(0, 12)}`,
        content,
        tags: [source, 'candidate', ...(cleanUris.length ? ['artifact-backed'] : [])],
        confidence: 0.6,
        scopeType,
        scopeId,
        metadata: traceMeta,
      },
    ];
  }

  recordExecutionCandidates(execution = {}) {
    if (!execution?.projectId || execution?.isSynthetic) return [];
    const candidates = this.extractExecutionCandidates(execution);
    if (!candidates.length) return [];
    return this.remember(candidates, {
      projectId: execution.projectId,
      source: execution.source || 'execution',
    });
  }

  distillTurnExperience({
    projectId = this.projectId,
    input = '',
    workspaceRoot = null,
    verdict = null,
    reasoningMetrics = null,
    toolReceipts = [],
    modifiedFiles = [],
    evaluationEvidence = null,
    summary = '',
    output = '',
    error = null,
    errorCode = null,
    failureCategory = null,
    source = null,
    sourceTaskId = null,
    sessionId = null,
    turnId = null,
    runId = null,
    sourceArtifact = null,
  } = {}) {
    const project = assertProject(projectId ?? this.projectId ?? workspaceRoot);
    const receipts = Array.isArray(toolReceipts)
      ? toolReceipts.filter((r) => r && typeof r === 'object')
      : [];
    const normalizedFiles = collectNormalizedFiles({
      modifiedFiles,
      reasoningMetrics,
      toolReceipts: receipts,
      verdict,
      workspaceRoot,
    });
    const errorFingerprints = extractErrorFingerprints({
      verdict,
      reasoningMetrics,
      toolReceipts: receipts,
      error,
      errorCode,
      failureCategory,
      summary,
      output,
    });

    const evalFailed =
      evaluationEvidence != null &&
      typeof evaluationEvidence === 'object' &&
      (evaluationEvidence.passed === false ||
        evaluationEvidence.accepted === false ||
        ['failed', 'cancelled', 'timeout', 'fail'].includes(
          String(evaluationEvidence.status ?? '').toLowerCase(),
        ));
    const resolvedFailureCategory =
      failureCategory && String(failureCategory) !== 'none'
        ? cleanText(failureCategory, 80)
        : null;
    const isFailure = Boolean(
      verdict?.verdict === 'fail' ||
        verdict?.accepted === false ||
        verdict?.verdict === 'block_reconciliation' ||
        evalFailed ||
        error ||
        errorCode ||
        resolvedFailureCategory ||
        reasoningMetrics?.circuitBroken === true ||
        (reasoningMetrics?.loopStopReason && reasoningMetrics.loopStopReason !== 'completed'),
    );

    const hasVerifyOrMutateReceipt = receipts.some((r) => {
      const name = String(r.toolName ?? r.name ?? '');
      return ['write_file', 'edit_file', 'apply_patch', 'delete_file', 'bash', 'start_process'].includes(name);
    });
    const hasReasoningSignal = Boolean(
      reasoningMetrics &&
        typeof reasoningMetrics === 'object' &&
        (reasoningMetrics.selfCorrectionRecovered ||
          reasoningMetrics.circuitBroken === true ||
          Number(reasoningMetrics.ineffectiveActionCount || 0) > 0 ||
          (Array.isArray(reasoningMetrics.stuckTriggers) && reasoningMetrics.stuckTriggers.length > 0) ||
          (Array.isArray(reasoningMetrics.stuckDetections) && reasoningMetrics.stuckDetections.length > 0) ||
          errorFingerprints.length > 0),
    );
    const isEvaluationSource = ['evaluation', 'eval'].includes(
      cleanText(source || (evaluationEvidence ? 'evaluation' : ''), 80).toLowerCase(),
    );
    const isPlainText =
      verdict?.verificationMode === 'plain_text_no_tools' &&
      !evaluationEvidence &&
      !isEvaluationSource &&
      !isFailure &&
      normalizedFiles.length === 0 &&
      receipts.length === 0 &&
      !hasReasoningSignal;
    if (isPlainText) return [];
    if (
      !isFailure &&
      !evaluationEvidence &&
      !isEvaluationSource &&
      normalizedFiles.length === 0 &&
      !hasVerifyOrMutateReceipt &&
      !hasReasoningSignal
    ) {
      return [];
    }

    let evalMeta = null;
    if (evaluationEvidence != null) {
      if (typeof evaluationEvidence !== 'object' || Array.isArray(evaluationEvidence)) {
        throw new TypeError('evaluationEvidence must be an object');
      }
      const innerEvidence =
        evaluationEvidence.evidence &&
        typeof evaluationEvidence.evidence === 'object' &&
        !Array.isArray(evaluationEvidence.evidence)
          ? evaluationEvidence.evidence
          : evaluationEvidence;
      const evalSourceTaskId =
        evaluationEvidence.sourceTaskId ??
        evaluationEvidence.taskId ??
        innerEvidence.sourceTaskId ??
        innerEvidence.taskId ??
        sourceTaskId;
      const evalRunId =
        evaluationEvidence.evaluationRunId ??
        evaluationEvidence.runId ??
        innerEvidence.evaluationRunId ??
        innerEvidence.runId ??
        runId;
      const evalProjectId = evaluationEvidence.projectId ?? innerEvidence.projectId ?? project;
      const evalArtifact =
        evaluationEvidence.sourceArtifact ?? innerEvidence.sourceArtifact ?? sourceArtifact ?? null;

      const trusted = assertTrustedEvidence({
        projectId: evalProjectId,
        evidence: innerEvidence,
        sourceTaskId: evalSourceTaskId,
        evaluationRunId: evalRunId,
      });
      if (trusted.project !== project) {
        throw new TypeError('verification evidence project does not match memory project');
      }
      this.#assertTrustedEvaluationRun(trusted);
      if (
        isFailure ||
        innerEvidence.passed === false ||
        innerEvidence.accepted === false ||
        ['failed', 'cancelled', 'timeout', 'fail'].includes(
          String(innerEvidence.status ?? '').toLowerCase(),
        )
      ) {
        throw new TypeError('only fully passed evaluation evidence may verify memory');
      }
      evalMeta = {
        sourceTaskId: trusted.sourceTaskId,
        evaluationRunId: trusted.evaluationRunId,
        evidence: innerEvidence,
        sourceArtifact: evalArtifact,
      };
    }

    const resolvedSource = cleanText(source || (evalMeta ? 'evaluation' : 'direct_turn'), 80) || 'direct_turn';
    const scopeType = evalMeta || isEvaluationSource ? 'evaluation' : runId ? 'swarm_run' : 'direct_turn';
    const scopeId =
      cleanText(evalMeta?.evaluationRunId ?? runId ?? turnId ?? sourceTaskId ?? '', 200) || null;
    const candidate = buildDistilledLessonCandidate({
      project,
      isFailure,
      resolvedSource,
      scopeType,
      scopeId,
      evalRunId: evalMeta?.evaluationRunId ?? runId ?? null,
      input,
      summary,
      output,
      verdict,
      error,
      errorCode,
      resolvedFailureCategory,
      normalizedFiles,
      errorFingerprints,
      receipts,
      reasoningMetrics,
      workspaceRoot,
      sourceTaskId,
      sessionId,
      turnId,
      runId,
    });

    const saved = this.remember([candidate], { projectId: project, source: resolvedSource });
    if (!evalMeta || !saved.length) return saved;

    const verify = this.createTrustedVerifier();
    return saved.map(
      (item) =>
        verify({
          id: item.id,
          projectId: project,
          sourceTaskId: evalMeta.sourceTaskId,
          evaluationRunId: evalMeta.evaluationRunId,
          evidence: evalMeta.evidence,
          sourceArtifact: evalMeta.sourceArtifact,
        }) ?? item,
    );
  }

  remember(input, options = {}) {
    const projectId = assertProject(options.projectId ?? this.projectId);
    const extracted = this.extract(input, { projectId, source: options.source ?? 'conversation' });
    const normalized = extracted.map((candidate) => this.normalize({ ...candidate, ...options, projectId }, { projectId, source: options.source })).filter((candidate) => this.validate(candidate).valid);
    return this.persist(this.dedupe(normalized, { projectId }), { projectId });
  }

  #readPersistedRunProject(persistedRun, evaluationRunId) {
    if (!persistedRun || typeof persistedRun !== "object") return null;
    if (persistedRun.projectId != null) return cleanText(persistedRun.projectId, 200) || null;
    if (persistedRun.evaluationProjectId != null) return cleanText(persistedRun.evaluationProjectId, 200) || null;
    try {
      const row = this.store?.db?.prepare?.("SELECT projectId, body FROM records WHERE kind = ? AND id = ?")
        ?.get("evaluation_runs", evaluationRunId);
      if (!row) return null;
      if (row.projectId != null) return cleanText(row.projectId, 200) || null;
      const body = parseJson(row.body, null);
      const bodyProject = body?.evaluationProjectId ?? body?.projectId ?? null;
      return bodyProject != null ? cleanText(bodyProject, 200) || null : null;
    } catch {
      return null;
    }
  }

  #assertTrustedEvaluationRun(trusted) {
    if (typeof this.store?.get !== "function") return;
    let persistedRun = null;
    try {
      persistedRun = this.store.get("evaluation_runs", trusted.evaluationRunId);
    } catch {
      persistedRun = null;
    }
    const persistedProject = this.#readPersistedRunProject(persistedRun, trusted.evaluationRunId);
    const matchedPassingTask = !Array.isArray(persistedRun?.results)
      ? false
      : persistedRun.results.some(
          (result) =>
            String(result?.taskId ?? "") === trusted.sourceTaskId &&
            result?.status === "passed" &&
            result?.passed === true,
        );
    if (
      !persistedRun ||
      persistedRun.status !== "completed" ||
      persistedRun.synthetic !== true ||
      !persistedProject ||
      assertProject(persistedProject) !== trusted.project ||
      !matchedPassingTask
    ) {
      throw new TypeError("trusted verification requires a completed evaluation run in the same project");
    }
  }

  rememberVerified(input, { projectId = this.projectId, source = 'server-verification', verificationEvidence, sourceArtifact = null } = {}) {
    const trusted = assertTrustedEvidence({ projectId, evidence: verificationEvidence });
    this.#assertTrustedEvaluationRun(trusted);
    const project = trusted.project;
    const normalizedEvidence = sanitizeMetadata({
      ...verificationEvidence,
      projectId: project,
      sourceTaskId: trusted.sourceTaskId,
      evaluationRunId: trusted.evaluationRunId,
    });
    const extracted = this.extract(input, { projectId: project, source });
    const normalized = extracted.map((candidate) => this.normalize({ ...candidate, projectId: project, verified: true }, {
      projectId: project, source, trustedVerification: true, verificationEvidence: normalizedEvidence, sourceArtifact,
    })).filter((candidate) => this.validate(candidate).valid);
    return this.persist(this.dedupe(normalized, { projectId: project }), { projectId: project });
  }

  createTrustedVerifier() {
    const authority = this.#verificationAuthority;
    return (input = {}) => this.verifyWithEvidence({ ...input, authority });
  }

  verifyWithEvidence({ projectId = this.projectId, id: memoryId, evidence, sourceArtifact = null, sourceTaskId = null, evaluationRunId = null, authority = null, now = nowValue(this.clock) } = {}) {
    if (authority !== this.#verificationAuthority) throw new TypeError('trusted verification context is required');
    const trusted = assertTrustedEvidence({ projectId, evidence, sourceTaskId, evaluationRunId });
    this.#assertTrustedEvaluationRun(trusted);
    if (
      evidence?.passed === false ||
      evidence?.accepted === false ||
      ['failed', 'cancelled', 'timeout', 'fail'].includes(String(evidence?.status ?? '').toLowerCase())
    ) {
      throw new TypeError('only fully passed evaluation evidence may verify memory');
    }
    const project = trusted.project;
    const normalizedEvidence = sanitizeMetadata({
      ...evidence,
      projectId: project,
      sourceTaskId: trusted.sourceTaskId,
      evaluationRunId: trusted.evaluationRunId,
      verifiedAt: now,
    });
    const row = this.db.prepare('SELECT * FROM experience_memory WHERE id=? AND projectId=?').get(memoryId, project);
    if (!row) return null;
    return tx(this.store, () => {
      this.db.prepare('UPDATE experience_memory SET verified=1, confidence=MAX(confidence, 0.8), verificationEvidence=?, sourceArtifact=?, updatedAt=? WHERE id=? AND projectId=?')
        .run(JSON.stringify(normalizedEvidence), sourceArtifact ? cleanText(sourceArtifact, 500) : row.sourceArtifact ?? null, now, memoryId, project);
      return rowToMemory(this.db.prepare('SELECT * FROM experience_memory WHERE id=? AND projectId=?').get(memoryId, project));
    });
  }
  retrieve({ projectId = this.projectId, query = '', limit = 10, tokenBudget = 1_000, now = nowValue(this.clock), includeInvalid = false, verifiedOnly = false, targetFiles = [], errorSignatures = [] } = {}) {
    const project = assertProject(projectId);
    const budget = Math.max(0, Math.min(MAX_TOKEN_BUDGET, Number(tokenBudget) || 0));
    const statuses = includeInvalid ? ['active', 'invalid'] : ['active'];
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM experience_memory WHERE projectId=? AND status IN (${placeholders})`).all(project, ...statuses);
    const candidates = rows
      .map(rowToMemory)
      .filter((item) => !verifiedOnly || (
        item.verified === true &&
        item.verificationEvidence != null &&
        typeof item.verificationEvidence === 'object' &&
        Boolean(item.verificationEvidence.evaluationRunId)
      ));
    const ranked = this.rank(candidates, { query, now, targetFiles, errorSignatures })
      .filter((item) => !String(query).trim() || item.relevance > 0 || item.pathAffinity > 0 || item.errorAffinity > 0 || item.verified);
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




