import { z } from 'zod';

export const EFFECT_CLASSES = Object.freeze({
  READ_ONLY: 'read_only',
  REVERSIBLE_WRITE: 'reversible_write',
  IRREVERSIBLE_SIDE_EFFECT: 'irreversible_side_effect',
  EXTERNAL_NETWORK: 'external_network',
});

export const RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const VALID_EFFECTS = new Set(Object.values(EFFECT_CLASSES));
const VALID_RISKS = new Set(Object.values(RISK_LEVELS));

/**
 * Defines and validates a normalized ToolDefinition backed by Zod or JSON Schema.
 */
export function defineTool(spec) {
  if (!spec?.name || typeof spec.name !== 'string') {
    throw new Error('Tool definition requires a non-empty name');
  }
  if (typeof spec.execute !== 'function') {
    throw new Error(`Tool ${spec.name} requires an execute() function`);
  }
  const effectClass =
    spec.effectClass ?? spec.meta?.effectClass ?? EFFECT_CLASSES.IRREVERSIBLE_SIDE_EFFECT;
  const riskLevel = spec.riskLevel ?? spec.meta?.riskLevel ?? RISK_LEVELS.MEDIUM;
  if (!VALID_EFFECTS.has(effectClass)) {
    throw new Error(`Invalid effectClass "${effectClass}" on tool ${spec.name}`);
  }
  if (!VALID_RISKS.has(riskLevel)) {
    throw new Error(`Invalid riskLevel "${riskLevel}" on tool ${spec.name}`);
  }

  const readOnly = Boolean(
    spec.readOnly ?? spec.meta?.readOnly ?? effectClass === EFFECT_CLASSES.READ_ONLY,
  );
  const replayable = Boolean(
    spec.replayable ??
      spec.meta?.replayable ??
      (effectClass === EFFECT_CLASSES.READ_ONLY ||
        effectClass === EFFECT_CLASSES.REVERSIBLE_WRITE),
  );
  const outward = Boolean(
    spec.outward ??
      spec.meta?.outward ??
      (effectClass === EFFECT_CLASSES.EXTERNAL_NETWORK && !readOnly),
  );
  const zodSchema = spec.zodSchema ?? null;
  const parameters = zodSchema
    ? z.toJSONSchema(zodSchema)
    : spec.parameters ?? { type: 'object', properties: {} };

  const meta = Object.freeze({
    readOnly,
    effectClass,
    riskLevel,
    replayable,
    outward,
    timeoutMs: spec.timeoutMs ?? spec.meta?.timeoutMs ?? null,
    requiresCommandCheck: Boolean(
      spec.requiresCommandCheck ?? spec.meta?.requiresCommandCheck,
    ),
  });

  const def = {
    name: spec.name,
    description: String(spec.description ?? spec.name),
    parameters,
    meta,
    isConcurrencySafe:
      typeof spec.isConcurrencySafe === 'function'
        ? spec.isConcurrencySafe
        : () => readOnly,
    validate(raw) {
      if (!zodSchema) return { success: true, data: raw ?? {} };
      return zodSchema.safeParse(raw ?? {});
    },
    execute: spec.execute,
  };
  const existingZodDesc = Object.getOwnPropertyDescriptor(spec, 'zodSchema');
  const serializeZod =
    spec.serializeZodSchema !== undefined
      ? spec.serializeZodSchema !== false
      : existingZodDesc
        ? existingZodDesc.enumerable !== false
        : true;
  Object.defineProperty(def, 'zodSchema', {
    value: zodSchema,
    enumerable: serializeZod,
    configurable: true,
    writable: true,
  });
  return def;
}

/**
 * Layer 4 Tool Registry holding strongly typed tool definitions, schemas,
 * and risk/effect metadata.
 */
export class ToolRegistry {
  #tools = new Map();

  register(spec) {
    const def = defineTool(spec);
    this.#tools.set(def.name, def);
    return def;
  }

  registerMany(specs) {
    for (const s of specs) this.register(s);
    return this;
  }

  get(name) {
    return this.#tools.get(name) ?? null;
  }

  has(name) {
    return this.#tools.has(name);
  }

  list() {
    return [...this.#tools.values()];
  }

  filterByAllowlist(allowlist = null) {
    if (!Array.isArray(allowlist) || allowlist.includes('*')) {
      return this.list();
    }
    const allowed = new Set(allowlist);
    return this.list().filter((t) => allowed.has(t.name));
  }
}
