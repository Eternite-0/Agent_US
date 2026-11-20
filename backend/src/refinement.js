import { Fault } from './store.js';
import { sha256Hex } from './integrity.js';
import { redactSecrets, sanitize } from './envelope.js';

export const REFINEMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_LESSONS_PER_RUN = 3;
export const MAX_LESSON_CHARS = 600;
export const DEFAULT_COOLDOWN_MS = 120_000;

/**
 * Policy/permission/budget/cancel refusals must NEVER be turned into learned lessons.
 */
const NEVER_COUNTED_CODE =
  /^(?:APPROVAL_DENIED|APPROVAL_INACTIVE|APPROVAL_PARKED|POLICY_HARD_BLOCKED|COST_BUDGET|STEP_BUDGET|TASK_DEADLINE|LEASE_LOST|RECONCILIATION_ABORTED|E_EXECUTE_PERMIT|UNAUTHORIZED|FORBIDDEN)$/i;

const NEVER_COUNTED_TEXT =
  /permission denied|operation not permitted|access denied|unauthori[sz]ed|forbidden|credential|api[ _-]?key|budget (?:exceeded|exhausted)|quota exceeded/i;

/**
 * Playbook-only boundary guard: lessons may never propose disabling approvals,
 * sandbox isolation, permits, or modifying runtime code/security gates.
 */
const FORBIDDEN_LESSON_RE =
  /(?:disable|bypass|skip|remove)\s+(?:approval|sandbox|permit|cap-drop|network=none|verifier|integrity)|dangerFullAccess|no-new-privileges/i;

function normalizeErrorText(text) {
  return String(text ?? '')
    .split('\n')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d+\b/g, '<n>')
    .trim()
    .slice(0, 200);
}

export function isPolicyRefusal({ code, text } = {}) {
  if (code && NEVER_COUNTED_CODE.test(String(code))) return true;
  if (text && NEVER_COUNTED_TEXT.test(String(text))) return true;
  return false;
}

export function addManagedLesson(
  store,
  {
    projectId,
    taskId = null,
    title,
    lesson,
    evidenceIds = [],
    source = 'refinement',
    ttlMs = REFINEMENT_TTL_MS,
  },
) {
  const cleanTitle = sanitize(redactSecrets(String(title ?? '').trim())).slice(
    0,
    120,
  );
  const cleanBody = sanitize(redactSecrets(String(lesson ?? '').trim())).slice(
    0,
    MAX_LESSON_CHARS,
  );
  if (!cleanBody) {
    return { status: 'rejected_empty' };
  }
  if (FORBIDDEN_LESSON_RE.test(cleanTitle) || FORBIDDEN_LESSON_RE.test(cleanBody)) {
    return { status: 'rejected_policy_boundary' };
  }

  const normalized = `${cleanTitle.toLowerCase()}\n${cleanBody.toLowerCase().replace(/\s+/g, ' ')}`;
  const lessonHash = sha256Hex(normalized);
  const existing = store.list('memory', { projectId, limit: 200 });
  if (existing.some((m) => m.lessonHash === lessonHash && m.status === 'withdrawn')) {
    return { status: 'rejected_withdrawn', lessonHash };
  }
  const duplicate = existing.find(
    (m) =>
      m.lessonHash === lessonHash &&
      m.status !== 'withdrawn' &&
      (!m.expiresAt || m.expiresAt > Date.now()),
  );
  if (duplicate) {
    return { status: 'duplicate', record: duplicate };
  }

  const refinementId = 'r' + lessonHash.slice(0, 10);
  const marked = [
    `<!-- refinement:${refinementId} -->`,
    cleanTitle ? `${cleanTitle}\n${cleanBody}` : cleanBody,
    `<!-- /refinement:${refinementId} -->`,
  ].join('\n');

  const record = store.add(
    'memory',
    {
      refinementId,
      title: cleanTitle || 'Project lesson',
      lesson: cleanBody,
      summary: marked,
      lessonHash,
      source,
      evidenceIds: [...new Set(evidenceIds)].slice(0, 16),
      status: 'active',
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    },
    projectId,
    taskId,
  );
  return { status: 'saved', record };
}

export function manageMemory(store, memoryId, action, { version }) {
  return store.tx(() => {
    const rec = store.get('memory', memoryId);
    if (rec.version !== version) throw new Fault('STALE_VERSION');
    if (action === 'renew') {
      if (rec.status === 'withdrawn') {
        throw new Fault('INVALID_TRANSITION');
      }
      return store.update('memory', rec, {
        status: 'active',
        expiresAt: Date.now() + REFINEMENT_TTL_MS,
      });
    }
    if (action === 'withdraw') {
      return store.update('memory', rec, {
        status: 'withdrawn',
        withdrawnAt: Date.now(),
      });
    }
    if (action === 'pin') {
      if (rec.status === 'withdrawn') {
        throw new Fault('INVALID_TRANSITION');
      }
      return store.update('memory', rec, {
        status: 'pinned',
        expiresAt: null,
      });
    }
    throw new Fault('INVALID_ACTION', 400);
  });
}

/**
 * Tier-1 Governed Task/Project Refinement (disabled by default).
 * Triggers only at quiescent boundaries after accepted deliveries or >= 2 repeated
 * normalized non-policy tool failures, under strict cooldown & data-only Playbook bounds.
 */
export class RefinementService {
  constructor(
    store,
    {
      enabled = false,
      cooldownMs = DEFAULT_COOLDOWN_MS,
      repeatThreshold = 2,
      planner = null,
    } = {},
  ) {
    this.store = store;
    this.enabled = !!enabled;
    this.cooldownMs = cooldownMs;
    this.repeatThreshold = repeatThreshold;
    this.planner = planner;
    this.lastRunAt = new Map();
    this.failureTallies = new Map();
  }

  recordToolFailure(projectId, toolName, { code, text } = {}) {
    if (!this.enabled) return { trigger: false, reason: 'disabled' };
    if (isPolicyRefusal({ code, text })) {
      return { trigger: false, reason: 'policy_refusal_excluded' };
    }
    const norm = normalizeErrorText(text || code);
    if (!norm) return { trigger: false, reason: 'empty_error' };
    const key = `${projectId}\0${toolName}\0${norm}`;
    const entry = this.failureTallies.get(key) ?? { count: 0, offered: false };
    entry.count++;
    this.failureTallies.set(key, entry);
    if (entry.count >= this.repeatThreshold && !entry.offered) {
      entry.offered = true;
      return { trigger: true, key, count: entry.count };
    }
    return { trigger: false, count: entry.count };
  }

  async distill({
    projectId,
    taskId = null,
    trigger = 'task_completed',
    evidence = [],
    verdict = null,
    planner = this.planner,
  }) {
    if (!this.enabled) return { status: 'disabled', saved: [] };
    const now = Date.now();
    const last = this.lastRunAt.get(projectId) ?? 0;
    if (now - last < this.cooldownMs) {
      return {
        status: 'cooldown',
        retryAt: last + this.cooldownMs,
        saved: [],
      };
    }
    if (typeof planner !== 'function') {
      return { status: 'no_planner', saved: [] };
    }
    this.lastRunAt.set(projectId, now);
    const proposals = await planner({
      projectId,
      taskId,
      trigger,
      evidence: evidence.slice(0, 20),
      verdict,
    });
    const list = Array.isArray(proposals)
      ? proposals.slice(0, MAX_LESSONS_PER_RUN)
      : [];
    const saved = [];
    const rejected = [];
    for (const item of list) {
      const res = addManagedLesson(this.store, {
        projectId,
        taskId,
        title: item?.title ?? '',
        lesson: item?.lesson ?? '',
        evidenceIds: item?.evidenceIds ?? evidence.map((e) => e.id).filter(Boolean),
        source: `refinement:${trigger}`,
      });
      if (res.status === 'saved') saved.push(res.record);
      else rejected.push({ title: item?.title, status: res.status });
    }
    this.store.event('refinement.completed', projectId, taskId, {
      trigger,
      savedCount: saved.length,
      rejectedCount: rejected.length,
    });
    return { status: 'ok', saved, rejected };
  }
}
