import { randomUUID } from 'node:crypto';
import { CommunicationStateError } from './envelope.js';

const TERMINAL = new Set(['acked', 'expired', 'dead_letter', 'cancelled']);
const ACTIVE = new Set(['pending', 'delivered']);
const clone = (value) => structuredClone(value);
const streamKey = (message) => `${message.conversationId}\0${message.runId ?? ''}\0${message.fromAgentId}\0${message.toAgentId}`;

/**
 * Durable communication adapter backed by the existing Store records table.
 * It deliberately avoids a second SQLite schema/version while retaining
 * persisted envelopes, delivery state, idempotency, ordering and conflicts.
 */
export class StoreCommunicationAdapter {
  constructor({ store, kind = 'communication_messages', conflictKind = 'communication_conflicts' } = {}) {
    if (!store || typeof store.add !== 'function' || typeof store.list !== 'function') {
      throw new TypeError('StoreCommunicationAdapter requires Store');
    }
    this.store = store;
    this.kind = kind;
    this.conflictKind = conflictKind;
  }

  #messages() {
    // Protocol decisions must not depend on a bounded API/list page.
    return this.store.db
      .prepare('SELECT id, projectId, taskId, version, body FROM records WHERE kind=? ORDER BY rowid')
      .all(this.kind)
      .map((row) => ({ ...JSON.parse(row.body), id: row.id, projectId: row.projectId, taskId: row.taskId, version: row.version }));
  }

  #conflict({ reason, attempted, existingMessageId = null, details = null, now }) {
    const conflict = {
      conflictId: randomUUID(), reason, decision: 'reviewer-needed', status: 'open',
      attempted: clone(attempted), existingMessageId, details: clone(details), createdAt: now,
    };
    this.store.add(this.conflictKind, conflict, null, null, conflict.conflictId);
    return conflict;
  }

  #save(message, patch) {
    const current = this.store.get(this.kind, message.id);
    const next = this.store.update(this.kind, current, patch);
    return clone(next);
  }

  async append(draft) {
    return this.store.tx(() => {
      const messages = this.#messages();
      const sameKey = messages.find((m) =>
        m.idempotencyKey === draft.idempotencyKey &&
        m.fromAgentId === draft.fromAgentId &&
        m.conversationId === draft.conversationId &&
        (m.runId ?? null) === (draft.runId ?? null),
      );
      if (sameKey) {
        if (sameKey.payloadHash === draft.payloadHash) return { status: 'replayed', message: clone(sameKey) };
        return {
          status: 'conflict',
          conflict: this.#conflict({
            reason: 'IDEMPOTENCY_KEY_REUSED', attempted: draft, existingMessageId: sameKey.messageId,
            details: { existingPayloadHash: sameKey.payloadHash, attemptedPayloadHash: draft.payloadHash }, now: draft.createdAt,
          }),
        };
      }
      if (draft.parentMessageId) {
        const parent = messages.find((message) => message.messageId === draft.parentMessageId);
        if (!parent || parent.toAgentId !== draft.fromAgentId || parent.fromAgentId !== draft.parentAgentId || parent.conversationId !== draft.conversationId || parent.runId !== draft.runId) {
          throw new CommunicationStateError('PARENT_LINK_NOT_FOUND');
        }
      }
      for (const artifact of draft.artifactManifest.artifacts) {
        const previous = messages
          .flatMap((message) => message.artifactManifest?.artifacts ?? [])
          .find((item) => item.uri === artifact.uri);
        if (previous && previous.sha256 !== artifact.sha256) {
          return {
            status: 'conflict',
            conflict: this.#conflict({
              reason: 'ARTIFACT_DIGEST_CONFLICT', attempted: draft,
              details: { uri: artifact.uri, existingSha256: previous.sha256, attemptedSha256: artifact.sha256 }, now: draft.createdAt,
            }),
          };
        }
      }
      const sequence = messages
        .filter((message) => streamKey(message) === streamKey(draft))
        .reduce((max, message) => Math.max(max, Number(message.sequence) || 0), 0) + 1;
      const message = {
        ...clone(draft), messageId: randomUUID(), sequence, status: 'pending', attempts: 0,
        nextAttemptAt: draft.createdAt, deliveredAt: null, ackDeadline: null,
        acknowledgedAt: null, lastError: null,
      };
      this.store.add(this.kind, message, null, null, message.messageId);
      return { status: 'created', message: clone(message) };
    });
  }
  async claimNext({ agentId, now, visibilityTimeoutMs }) {
    const messages = this.#messages();
    for (const message of messages
      .filter((item) => item.toAgentId === agentId && ACTIVE.has(item.status) && item.expiresAt > now && (item.status === 'pending' ? item.nextAttemptAt <= now : item.ackDeadline <= now))
      .sort((a, b) => Number(a.sequence) - Number(b.sequence) || Number(a.createdAt) - Number(b.createdAt) || a.messageId.localeCompare(b.messageId))) {
      const earlier = messages.some((item) => streamKey(item) === streamKey(message) && Number(item.sequence) < Number(message.sequence) && !TERMINAL.has(item.status));
      if (earlier) continue;
      return this.#save(message, {
        status: 'delivered', attempts: Number(message.attempts || 0) + 1,
        deliveredAt: now, ackDeadline: now + visibilityTimeoutMs,
      });
    }
    return null;
  }

  async ack({ messageId, agentId, now }) {
    const message = this.#messages().find((item) => item.messageId === messageId);
    if (!message) return null;
    if (message.toAgentId !== agentId) throw new CommunicationStateError('ACK_RECIPIENT_MISMATCH');
    if (message.status === 'acked') return clone(message);
    if (message.status !== 'delivered') throw new CommunicationStateError('MESSAGE_NOT_DELIVERED');
    return this.#save(message, { status: 'acked', acknowledgedAt: now, ackDeadline: null });
  }

  async retry({ messageId, agentId, now, delayMs, error }) {
    const message = this.#messages().find((item) => item.messageId === messageId);
    if (!message) return null;
    if (message.toAgentId !== agentId) throw new CommunicationStateError('RETRY_RECIPIENT_MISMATCH');
    if (message.status !== 'delivered') throw new CommunicationStateError('MESSAGE_NOT_DELIVERED');
    const exhausted = Number(message.attempts || 0) >= Number(message.maxAttempts || 1);
    return this.#save(message, exhausted
      ? { status: 'dead_letter', lastError: error ?? null, ackDeadline: null }
      : { status: 'pending', lastError: error ?? null, ackDeadline: null, nextAttemptAt: now + delayMs });
  }

  async cancel({ messageId, actorId, now }) {
    const message = this.#messages().find((item) => item.messageId === messageId);
    if (!message) return null;
    if (![message.fromAgentId, message.toAgentId].includes(actorId)) throw new CommunicationStateError('CANCEL_ACTOR_MISMATCH');
    if (TERMINAL.has(message.status)) return clone(message);
    return this.#save(message, { status: 'cancelled', ackDeadline: null, cancelledAt: now, cancelledBy: actorId });
  }

  async sweep({ now }) {
    let expired = 0; let deadLettered = 0;
    for (const message of this.#messages()) {
      if (!ACTIVE.has(message.status)) continue;
      if (Number(message.expiresAt) <= now) { this.#save(message, { status: 'expired', ackDeadline: null }); expired++; }
      else if (message.status === 'delivered' && Number(message.ackDeadline) <= now && Number(message.attempts) >= Number(message.maxAttempts)) {
        this.#save(message, { status: 'dead_letter', ackDeadline: null }); deadLettered++;
      }
    }
    return { expired, deadLettered };
  }

  async get(messageId) {
    const message = this.#messages().find((item) => item.messageId === messageId);
    return message ? clone(message) : null;
  }
  async list({ conversationId = null, runId = null, status = null } = {}) {
    return this.#messages().filter((m) => (!conversationId || m.conversationId === conversationId) && (!runId || m.runId === runId) && (!status || m.status === status)).sort((a, b) => Number(a.sequence) - Number(b.sequence)).map(clone);
  }
  async listConflicts({ status = null } = {}) {
    return this.store.list(this.conflictKind, { limit: 1000 }).filter((conflict) => !status || conflict.status === status).map(clone);
  }
  async resolveConflict({ conflictId, resolution, reviewerId, now }) {
    const conflict = this.store.get(this.conflictKind, conflictId);
    if (conflict.status === 'resolved') return clone(conflict);
    return this.store.update(this.conflictKind, conflict, { status: 'resolved', resolution: String(resolution), reviewerId: String(reviewerId), resolvedAt: now });
  }
}
