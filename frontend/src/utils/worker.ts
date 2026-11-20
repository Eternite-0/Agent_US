import type { Assignment, EventEnvelope, Worker, WorkerRole } from '../types/backend';

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * Resolve a stable worker key from an event payload with full compatibility:
 * 1. payload.workerId
 * 2. payload.nodeId -> `worker-${nodeId}`
 * 3. payload.workerName
 */
export function resolveWorkerIdFromPayload(payload?: Record<string, unknown> | null): string {
  if (!payload || typeof payload !== 'object') return '';
  const workerId = nonEmptyString(payload.workerId);
  if (workerId) return workerId;
  const nodeId = nonEmptyString(payload.nodeId);
  if (nodeId) return `worker-${nodeId}`;
  const workerName = nonEmptyString(payload.workerName);
  if (workerName) return workerName;
  return '';
}

/**
 * Map a free-form router/backend role string to the legacy typed WorkerRole enum
 * for internal compatibility only; never used as the sole presentation name.
 */
export function normalizeLegacyWorkerRole(raw?: unknown): WorkerRole {
  const lower = nonEmptyString(raw).toLowerCase();
  if (lower.includes('plan') || lower.includes('architect')) return 'Planner';
  if (lower.includes('review') || lower.includes('audit')) return 'Reviewer';
  if (lower.includes('test') || lower.includes('qa') || lower.includes('verif')) return 'Tester';
  if (lower.includes('research') || lower.includes('search') || lower.includes('explore')) return 'Researcher';
  return 'Coder';
}

/**
 * Resolve a Worker object for an event payload, compatible with:
 * 1. payload.workerId
 * 2. nodeId mapped to `worker-${nodeId}` (or matching assignmentId)
 * 3. workerName
 */
export function resolveWorkerForPayload(
  payload: Record<string, unknown> | undefined | null,
  workers: Worker[],
): Worker | undefined {
  if (!payload || typeof payload !== 'object' || !workers.length) return undefined;

  const workerId = nonEmptyString(payload.workerId);
  if (workerId) {
    const byId = workers.find((w) => w.id === workerId);
    if (byId) return byId;
  }

  const nodeId = nonEmptyString(payload.nodeId);
  if (nodeId) {
    const mappedId = `worker-${nodeId}`;
    const byNode = workers.find((w) => w.id === mappedId || w.assignmentId === nodeId);
    if (byNode) return byNode;
  }

  const workerName = nonEmptyString(payload.workerName);
  if (workerName) {
    const byName = workers.find(
      (w) => w.workerName === workerName || w.id === workerName || w.id === `worker-${workerName}`,
    );
    if (byName) return byName;
  }

  return undefined;
}

/** Check whether an event belongs to a specific focused workerId. */
export function eventMatchesWorker(
  event: EventEnvelope,
  focusWorkerId: string,
  workers: Worker[],
): boolean {
  const payload = event.payload ?? {};
  const focused = workers.find((w) => w.id === focusWorkerId);
  const payloadWorkerId = nonEmptyString(payload.workerId);
  if (payloadWorkerId) return payloadWorkerId === focusWorkerId;

  const nodeId = nonEmptyString(payload.nodeId);
  if (nodeId) {
    if (`worker-${nodeId}` === focusWorkerId) return true;
    if (focused?.assignmentId && focused.assignmentId === nodeId) return true;
  }

  const workerName = nonEmptyString(payload.workerName);
  if (workerName) {
    if (workerName === focusWorkerId || `worker-${workerName}` === focusWorkerId) return true;
    if (focused?.workerName && focused.workerName === workerName) return true;
  }

  return false;
}

/**
 * Human-readable display name for a Worker.
 * Separates stable scheduling `workerId` from presentation fields (`workerName`, `workerRole`).
 */
export function getWorkerDisplayName(
  worker?: Worker | null,
  options?: { payload?: Record<string, unknown> | null; assignment?: Assignment | null },
): string {
  const payload = options?.payload ?? undefined;
  const assignment = options?.assignment ?? undefined;
  return (
    nonEmptyString(payload?.workerName)
    || nonEmptyString(worker?.workerName)
    || nonEmptyString(assignment?.workerName)
    || nonEmptyString(payload?.displayName)
    || nonEmptyString(assignment?.key)
    || nonEmptyString(payload?.workerRole)
    || nonEmptyString(worker?.workerRole)
    || nonEmptyString(assignment?.workerRole)
    || nonEmptyString(worker?.role)
    || nonEmptyString(assignment?.role)
    || nonEmptyString(payload?.nodeId)
    || nonEmptyString(payload?.workerId)
    || nonEmptyString(worker?.id)
    || 'Agent'
  );
}

/** Presentation role label for a Worker (prefers router-provided `workerRole`). */
export function getWorkerDisplayRole(
  worker?: Worker | null,
  options?: { payload?: Record<string, unknown> | null; assignment?: Assignment | null },
): string {
  const payload = options?.payload ?? undefined;
  const assignment = options?.assignment ?? undefined;
  return (
    nonEmptyString(payload?.workerRole)
    || nonEmptyString(worker?.workerRole)
    || nonEmptyString(assignment?.workerRole)
    || nonEmptyString(worker?.role)
    || nonEmptyString(assignment?.role)
  );
}

/** Current human-readable activity description for a Worker. */
export function getWorkerActivityLabel(
  worker?: Worker | null,
  payload?: Record<string, unknown> | null,
): string {
  return nonEmptyString(payload?.activityLabel) || nonEmptyString(worker?.activityLabel);
}
