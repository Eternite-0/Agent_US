import { z } from 'zod';

export const PERMISSION_LEVELS = Object.freeze({
  readonly: 0,
  'auto-safe': 1,
  full: 2,
});

const stringList = z.array(z.string().trim().min(1).max(128)).max(64);

export const sideEffectSchema = z.object({
  effectKey: z.string().trim().min(1).max(128),
  kind: z.enum(['read', 'write', 'network', 'process', 'external']).default('write'),
  replayable: z.boolean().default(false),
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
}).strict().superRefine((effect, ctx) => {
  if (!effect.replayable && !effect.idempotencyKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'non-replayable side effects require an idempotencyKey',
    });
  }
});

export const budgetSchema = z.object({
  maxInputTokens: z.number().int().nonnegative().optional(),
  maxOutputTokens: z.number().int().nonnegative().optional(),
  maxSteps: z.number().int().positive().optional(),
  maxTotalTokens: z.number().int().positive().optional(),
  maxCostUsd: z.number().finite().nonnegative().optional(),
}).strict();

export const acceptanceSchema = z.union([
  z.string().trim().min(1).max(2000),
  z.object({
    description: z.string().trim().min(1).max(2000),
    requiredEvidence: stringList.default([]),
    minConfidence: z.number().min(0).max(1).optional(),
  }).strict(),
]);

export const taskSchema = z.object({
  taskKey: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  objective: z.string().trim().min(1).max(4000),
  acceptance: acceptanceSchema,
  taskType: z.string().trim().min(1).max(64).default('general'),
  dependencies: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
  permissionMode: z.enum(['readonly', 'auto-safe', 'full']).default('auto-safe'),
  toolAllow: stringList.nullable().default(null),
  budget: budgetSchema.default({}),
  sideEffects: z.array(sideEffectSchema).max(64).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const planSchema = z.object({
  planVersion: z.number().int().positive(),
  goal: z.string().trim().min(1).max(8000),
  permissionMode: z.enum(['readonly', 'auto-safe', 'full']).default('auto-safe'),
  budget: budgetSchema.default({}),
  tasks: z.array(taskSchema).min(1).max(256),
  acceptance: acceptanceSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const feedbackSchema = z.object({
  taskKey: z.string().trim().min(1).max(64),
  status: z.enum(['completed', 'failed', 'cancelled', 'blocked']),
  success: z.boolean(),
  verified: z.boolean().nullable().default(null),
  notes: z.string().max(4000).default(''),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  latencyMs: z.number().int().nonnegative().default(0),
  effectsApplied: z.array(z.string().trim().min(1).max(128)).max(128).default([]),
  evidence: stringList.default([]),
  planVersion: z.number().int().positive().optional(),
  replanAttempt: z.boolean().optional(),
  isReplan: z.boolean().optional(),
  replanStrategy: z.string().trim().min(1).max(128).optional(),
  strategy: z.string().trim().min(1).max(128).optional(),
  recoveredAfterReplan: z.boolean().optional(),
  recovered: z.boolean().optional(),
  avoidedRepeatFailure: z.boolean().optional(),
  degenerateReplanBlocked: z.boolean().optional(),
  priorFailureTaskKey: z.string().trim().min(1).max(64).optional(),
  failureSignature: z.string().trim().min(1).max(256).optional(),
}).strict();

export function parseSchema(schema, value, code = 'PLANNER_SCHEMA_INVALID') {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const error = new Error(code);
    error.code = code;
    error.status = 400;
    error.issues = parsed.error.issues;
    throw error;
  }
  return parsed.data;
}
