import { createHash, randomUUID } from 'node:crypto';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const KIND_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const MAX_PAYLOAD_BYTES = 1024 * 1024;

export class CommunicationValidationError extends Error {
  constructor(code, message = code, details = undefined) {
    super(message);
    this.name = 'CommunicationValidationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class CommunicationStateError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'CommunicationStateError';
    this.code = code;
  }
}

function requireId(value, field, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new CommunicationValidationError('INVALID_ENVELOPE', `${field} must be a 1-200 character identifier`);
  }
  return value;
}

function jsonClone(value, field) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('undefined JSON');
    if (Buffer.byteLength(encoded, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new CommunicationValidationError('PAYLOAD_TOO_LARGE', `${field} exceeds 1 MiB`);
    }
    return JSON.parse(encoded);
  } catch (error) {
    if (error instanceof CommunicationValidationError) throw error;
    throw new CommunicationValidationError('INVALID_ENVELOPE', `${field} must be JSON serializable`);
  }
}

function normalizeArtifactManifest(manifest) {
  if (manifest === undefined || manifest === null) return { version: 1, artifacts: [] };
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.version !== 1 || !Array.isArray(manifest.artifacts)) {
    throw new CommunicationValidationError('INVALID_ARTIFACT_MANIFEST', 'artifactManifest must be { version: 1, artifacts: [] }');
  }
  if (manifest.artifacts.length > 100) {
    throw new CommunicationValidationError('INVALID_ARTIFACT_MANIFEST', 'artifactManifest may contain at most 100 artifacts');
  }
  const seen = new Set();
  const artifacts = manifest.artifacts.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new CommunicationValidationError('INVALID_ARTIFACT_MANIFEST', 'Each artifact must be an object');
    }
    const uri = String(item.uri ?? '').trim();
    let parsed;
    try { parsed = new URL(uri); } catch {
      throw new CommunicationValidationError('INVALID_ARTIFACT_URI', `Invalid artifact URI: ${uri}`);
    }
    if (!['swarm-artifact:', 'artifact:'].includes(parsed.protocol) || !parsed.host || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new CommunicationValidationError('INVALID_ARTIFACT_URI', `Artifact URI must be an immutable artifact:// or swarm-artifact:// URI: ${uri}`);
    }
    const sha256 = String(item.sha256 ?? '').toLowerCase();
    if (!SHA256_RE.test(sha256)) {
      throw new CommunicationValidationError('INVALID_ARTIFACT_SHA256', `Artifact ${uri} must have a 64-character SHA-256 digest`);
    }
    if (seen.has(uri)) throw new CommunicationValidationError('INVALID_ARTIFACT_MANIFEST', `Duplicate artifact URI: ${uri}`);
    seen.add(uri);
    return { uri, sha256 };
  }).sort((a, b) => a.uri.localeCompare(b.uri));
  return { version: 1, artifacts };
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function payloadDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Validate and normalize an incoming v1 message draft. Persistence assigns messageId and sequence. */
export function validateMessageDraft(input, { now = Date.now(), defaultTtlMs = 60 * 60 * 1000, maxAttempts = 5 } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CommunicationValidationError('INVALID_ENVELOPE', 'Message envelope must be an object');
  }
  if (input.version !== undefined && input.version !== 1) {
    throw new CommunicationValidationError('UNSUPPORTED_ENVELOPE_VERSION', `Unsupported envelope version: ${input.version}`);
  }
  const conversationId = requireId(input.conversationId, 'conversationId');
  const runId = requireId(input.runId, 'runId', { optional: true });
  const fromAgentId = requireId(input.fromAgentId, 'fromAgentId');
  const toAgentId = requireId(input.toAgentId, 'toAgentId');
  if (fromAgentId === toAgentId) throw new CommunicationValidationError('INVALID_ENVELOPE', 'fromAgentId and toAgentId must differ');
  const parentMessageId = requireId(input.parentMessageId, 'parentMessageId', { optional: true });
  const parentAgentId = requireId(input.parentAgentId, 'parentAgentId', { optional: true });
  if (Boolean(parentMessageId) !== Boolean(parentAgentId)) {
    throw new CommunicationValidationError('INVALID_PARENT_LINK', 'parentMessageId and parentAgentId must be supplied together');
  }
  const kind = String(input.kind ?? 'note');
  if (!KIND_RE.test(kind)) throw new CommunicationValidationError('INVALID_ENVELOPE', 'kind must be a lowercase protocol identifier');
  const idempotencyKey = requireId(input.idempotencyKey ?? randomUUID(), 'idempotencyKey');
  const createdAt = Number.isFinite(Number(input.createdAt)) ? Math.trunc(Number(input.createdAt)) : Math.trunc(now);
  const expiresAt = input.expiresAt === undefined || input.expiresAt === null
    ? createdAt + Math.max(1, Math.trunc(Number(defaultTtlMs) || 1))
    : Math.trunc(Number(input.expiresAt));
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) {
    throw new CommunicationValidationError('INVALID_EXPIRY', 'expiresAt must be later than createdAt');
  }
  const attempts = Math.trunc(Number(input.maxAttempts ?? maxAttempts));
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new CommunicationValidationError('INVALID_MAX_ATTEMPTS', 'maxAttempts must be between 1 and 100');
  }
  const payload = jsonClone(input.payload ?? {}, 'payload');
  const artifactManifest = normalizeArtifactManifest(input.artifactManifest);
  const stableContent = {
    version: 1,
    conversationId,
    runId,
    fromAgentId,
    toAgentId,
    parentMessageId,
    parentAgentId,
    kind,
    payload,
    artifactManifest,
  };
  return {
    ...stableContent,
    idempotencyKey,
    createdAt,
    expiresAt,
    maxAttempts: attempts,
    payloadHash: payloadDigest(stableContent),
  };
}

export function hydrateMessage(row) {
  if (!row) return null;
  const envelope = typeof row.envelopeJson === 'string' ? JSON.parse(row.envelopeJson) : structuredClone(row.envelope);
  return {
    ...envelope,
    status: row.status,
    attempts: Number(row.attempts),
    nextAttemptAt: row.nextAttemptAt === null || row.nextAttemptAt === undefined ? null : Number(row.nextAttemptAt),
    deliveredAt: row.deliveredAt === null || row.deliveredAt === undefined ? null : Number(row.deliveredAt),
    ackDeadline: row.ackDeadline === null || row.ackDeadline === undefined ? null : Number(row.ackDeadline),
    acknowledgedAt: row.acknowledgedAt === null || row.acknowledgedAt === undefined ? null : Number(row.acknowledgedAt),
    lastError: row.lastError ?? null,
  };
}
