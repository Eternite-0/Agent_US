import { randomUUID } from 'node:crypto';
import { CommunicationStateError, payloadDigest } from './envelope.js';

const TERMINAL = new Set(['acked', 'expired', 'dead_letter', 'cancelled']);
const ACTIVE = new Set(['pending', 'delivered']);

function clone(value) { return structuredClone(value); }
function sortMessages(rows) { return rows.sort((a, b) => a.sequence - b.sequence || a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId)); }
function streamKey(m) { return `${m.conversationId}\0${m.fromAgentId}\0${m.toAgentId}`; }
function conflictRecord({ reason, attempted, existingMessageId = null, details = null, now }) {
  return { conflictId: randomUUID(), reason, decision: 'reviewer-needed', status: 'open', attempted: clone(attempted), existingMessageId, details: clone(details), createdAt: now };
}

/** In-memory adapter for embedding and deterministic tests. Implements the same contract as SqliteCommunicationAdapter. */
export class MemoryCommunicationAdapter {
  #messages = new Map();
  #conflicts = new Map();
  #artifactDigests = new Map();

  async append(draft) {
    const sameKey = [...this.#messages.values()].find((m) => m.idempotencyKey === draft.idempotencyKey && m.fromAgentId === draft.fromAgentId && m.conversationId === draft.conversationId);
    if (sameKey) {
      if (sameKey.payloadHash === draft.payloadHash) return { status: 'replayed', message: clone(sameKey) };
      const conflict = conflictRecord({ reason: 'IDEMPOTENCY_KEY_REUSED', attempted: draft, existingMessageId: sameKey.messageId, details: { existingPayloadHash: sameKey.payloadHash, attemptedPayloadHash: draft.payloadHash }, now: draft.createdAt });
      this.#conflicts.set(conflict.conflictId, conflict);
      return { status: 'conflict', conflict: clone(conflict) };
    }
    if (draft.parentMessageId) {
      const parent = this.#messages.get(draft.parentMessageId);
      if (!parent || parent.toAgentId !== draft.fromAgentId || parent.fromAgentId !== draft.parentAgentId || parent.conversationId !== draft.conversationId || parent.runId !== draft.runId) {
        throw new CommunicationStateError('PARENT_LINK_NOT_FOUND', 'Parent message must be from parentAgentId to this sender in the same conversation and run');
      }
    }
    for (const artifact of draft.artifactManifest.artifacts) {
      const oldDigest = this.#artifactDigests.get(artifact.uri);
      if (oldDigest && oldDigest !== artifact.sha256) {
        const conflict = conflictRecord({ reason: 'ARTIFACT_DIGEST_CONFLICT', attempted: draft, details: { uri: artifact.uri, existingSha256: oldDigest, attemptedSha256: artifact.sha256 }, now: draft.createdAt });
        this.#conflicts.set(conflict.conflictId, conflict);
        return { status: 'conflict', conflict: clone(conflict) };
      }
    }
    const prior = [...this.#messages.values()].filter((m) => streamKey(m) === streamKey(draft));
    const sequence = prior.reduce((max, m) => Math.max(max, m.sequence), 0) + 1;
    const message = {
      ...clone(draft), messageId: randomUUID(), sequence, status: 'pending', attempts: 0,
      nextAttemptAt: draft.createdAt, deliveredAt: null, ackDeadline: null, acknowledgedAt: null, lastError: null,
    };
    this.#messages.set(message.messageId, message);
    for (const artifact of draft.artifactManifest.artifacts) this.#artifactDigests.set(artifact.uri, artifact.sha256);
    return { status: 'created', message: clone(message) };
  }

  async claimNext({ agentId, now, visibilityTimeoutMs }) {
    this.#expireAndExhaust(now);
    const pending = sortMessages([...this.#messages.values()].filter((m) => m.toAgentId === agentId && ACTIVE.has(m.status) && m.expiresAt > now && (m.status === 'pending' ? m.nextAttemptAt <= now : m.ackDeadline <= now)));
    for (const message of pending) {
      const earlier = [...this.#messages.values()].some((m) => streamKey(m) === streamKey(message) && m.sequence < message.sequence && !TERMINAL.has(m.status));
      if (earlier) continue;
      message.status = 'delivered';
      message.attempts++;
      message.deliveredAt = now;
      message.ackDeadline = now + visibilityTimeoutMs;
      return clone(message);
    }
    return null;
  }

  async ack({ messageId, agentId, now }) {
    const message = this.#messages.get(messageId);
    if (!message) return null;
    if (message.toAgentId !== agentId) throw new CommunicationStateError('ACK_RECIPIENT_MISMATCH');
    if (message.status === 'acked') return clone(message);
    if (message.status !== 'delivered') throw new CommunicationStateError('MESSAGE_NOT_DELIVERED');
    message.status = 'acked'; message.acknowledgedAt = now; message.ackDeadline = null;
    return clone(message);
  }

  async retry({ messageId, agentId, now, delayMs, error }) {
    const message = this.#messages.get(messageId);
    if (!message) return null;
    if (message.toAgentId !== agentId) throw new CommunicationStateError('RETRY_RECIPIENT_MISMATCH');
    if (message.status !== 'delivered') throw new CommunicationStateError('MESSAGE_NOT_DELIVERED');
    message.lastError = error ?? null; message.ackDeadline = null;
    if (message.attempts >= message.maxAttempts) message.status = 'dead_letter';
    else { message.status = 'pending'; message.nextAttemptAt = now + delayMs; }
    return clone(message);
  }

  async cancel({ messageId, actorId, now }) {
    const message = this.#messages.get(messageId);
    if (!message) return null;
    if (![message.fromAgentId, message.toAgentId].includes(actorId)) throw new CommunicationStateError('CANCEL_ACTOR_MISMATCH');
    if (TERMINAL.has(message.status)) return clone(message);
    message.status = 'cancelled'; message.ackDeadline = null; message.cancelledAt = now; message.cancelledBy = actorId;
    return clone(message);
  }

  async sweep({ now }) { return this.#expireAndExhaust(now); }
  #expireAndExhaust(now) {
    const report = { expired: 0, deadLettered: 0 };
    for (const m of this.#messages.values()) {
      if (!ACTIVE.has(m.status)) continue;
      if (m.expiresAt <= now) { m.status = 'expired'; m.ackDeadline = null; report.expired++; }
      else if (m.status === 'delivered' && m.ackDeadline <= now && m.attempts >= m.maxAttempts) { m.status = 'dead_letter'; m.ackDeadline = null; report.deadLettered++; }
    }
    return report;
  }
  async get(messageId) { const m = this.#messages.get(messageId); return m ? clone(m) : null; }
  async list({ conversationId = null, runId = null, status = null } = {}) {
    return sortMessages([...this.#messages.values()].filter((m) => (!conversationId || m.conversationId === conversationId) && (!runId || m.runId === runId) && (!status || m.status === status)).map(clone));
  }
  async getConflict(conflictId) { const c = this.#conflicts.get(conflictId); return c ? clone(c) : null; }
  async listConflicts({ status = null } = {}) { return [...this.#conflicts.values()].filter((c) => !status || c.status === status).map(clone); }
  async resolveConflict({ conflictId, resolution, reviewerId, now }) {
    const c = this.#conflicts.get(conflictId);
    if (!c) return null;
    if (c.status === 'resolved') return clone(c);
    c.status = 'resolved'; c.resolution = String(resolution); c.reviewerId = String(reviewerId); c.resolvedAt = now;
    return clone(c);
  }
}
