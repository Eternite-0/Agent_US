import { z } from 'zod';

export const SWARM_JOB_KINDS = Object.freeze({
  PLAN: 'swarm_plan',
  DEPENDENCY_RESOLVE: 'swarm_dependency_resolve',
  DISPATCH: 'swarm_dispatch',
  NODE_EXECUTE: 'swarm_node_execute',
  AGGREGATE: 'swarm_aggregate',
  VERIFY: 'swarm_verify',
});

export const SWARM_JOB_SCHEMAS = Object.freeze({
  [SWARM_JOB_KINDS.PLAN]: z.object({
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    goal: z.string().min(1),
    planVersion: z.number().int().positive().default(1),
  }),
  [SWARM_JOB_KINDS.DEPENDENCY_RESOLVE]: z.object({
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    planVersion: z.number().int().positive().default(1),
    epoch: z.number().int().nonnegative().default(0),
  }),
  [SWARM_JOB_KINDS.DISPATCH]: z.object({
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    nodeKeys: z.array(z.string().min(1)).default([]),
    planVersion: z.number().int().positive().default(1),
  }),
  [SWARM_JOB_KINDS.NODE_EXECUTE]: z.object({
    runId: z.string().min(1),
    nodeId: z.string().min(1),
    nodeKey: z.string().min(1),
    sessionId: z.string().min(1),
    planVersion: z.number().int().positive().default(1),
    attemptSeq: z.number().int().nonnegative().default(0),
  }),
  [SWARM_JOB_KINDS.AGGREGATE]: z.object({
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    planVersion: z.number().int().positive().default(1),
  }),
  [SWARM_JOB_KINDS.VERIFY]: z.object({
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    planVersion: z.number().int().positive().default(1),
  }),
});

export const SWARM_JOB_RETRY_POLICY = Object.freeze({
  [SWARM_JOB_KINDS.PLAN]: { maxAttempts: 2 },
  [SWARM_JOB_KINDS.DEPENDENCY_RESOLVE]: { maxAttempts: 3 },
  [SWARM_JOB_KINDS.DISPATCH]: { maxAttempts: 3 },
  [SWARM_JOB_KINDS.NODE_EXECUTE]: { maxAttempts: 3 },
  [SWARM_JOB_KINDS.AGGREGATE]: { maxAttempts: 2 },
  [SWARM_JOB_KINDS.VERIFY]: { maxAttempts: 2 },
});

export function swarmJobIdempotencyKey(kind, payload) {
  switch (kind) {
    case SWARM_JOB_KINDS.PLAN:
      return `swarm:plan:${payload.runId}:v${payload.planVersion ?? 1}`;
    case SWARM_JOB_KINDS.DEPENDENCY_RESOLVE:
      return `swarm:resolve:${payload.runId}:v${payload.planVersion ?? 1}:e${payload.epoch ?? 0}`;
    case SWARM_JOB_KINDS.DISPATCH:
      return `swarm:dispatch:${payload.runId}:v${payload.planVersion ?? 1}:${(payload.nodeKeys ?? []).join(',')}`;
    case SWARM_JOB_KINDS.NODE_EXECUTE:
      return `swarm:node:${payload.nodeId}:v${payload.planVersion ?? 1}:a${payload.attemptSeq ?? 0}`;
    case SWARM_JOB_KINDS.AGGREGATE:
      return `swarm:agg:${payload.runId}:v${payload.planVersion ?? 1}`;
    case SWARM_JOB_KINDS.VERIFY:
      return `swarm:ver:${payload.runId}:v${payload.planVersion ?? 1}`;
    default:
      return `swarm:${kind}:${payload.runId}:${Date.now()}`;
  }
}

export function enqueueSwarmJob(
  jobQueue,
  kind,
  rawPayload,
  { idempotencyKey = null, parentJobId = null } = {},
) {
  const schema = SWARM_JOB_SCHEMAS[kind];
  if (!schema) throw new Error(`Unknown swarm job kind: ${kind}`);
  const payload = schema.parse(rawPayload);
  const key = idempotencyKey || swarmJobIdempotencyKey(kind, payload);
  const policy = SWARM_JOB_RETRY_POLICY[kind] ?? { maxAttempts: 3 };
  return jobQueue.enqueue({
    kind,
    sessionId: payload.sessionId,
    turnId: payload.nodeId ? `swarm:${payload.runId}:${payload.nodeKey}` : `swarm:${payload.runId}`,
    taskId: payload.runId,
    parentJobId,
    payload,
    idempotencyKey: key,
    maxAttempts: policy.maxAttempts,
  });
}
