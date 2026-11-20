export const CAPABILITY_DIMENSIONS = Object.freeze([
  'coding',
  'reasoning',
  'research',
  'planning',
  'speed',
  'contextCapacity',
  'multimodal',
  'toolCompatibility',
]);

const BASE_CAPABILITIES = Object.freeze({
  research: {
    id: 'research',
    label: '代码库调研与情报检索',
    defaultMaxSteps: 8,
    readOnly: true,
    weights: { coding: 0.4, reasoning: 0.6, research: 1.0, planning: 0.3, speed: 0.7, contextCapacity: 0.8, multimodal: 0.1, toolCompatibility: 0.8 },
    toolAllow: ['read_file', 'glob', 'grep', 'read_blob', 'web_fetch', 'search_history'],
    instruction: '专注于只读代码检索、调用链梳理与事实提取，引用精确文件路径与符号名。',
  },
  implementation: {
    id: 'implementation',
    label: '工程实现与增量修改',
    defaultMaxSteps: 14,
    readOnly: false,
    weights: { coding: 1.0, reasoning: 0.7, research: 0.4, planning: 0.4, speed: 0.5, contextCapacity: 0.6, multimodal: 0.1, toolCompatibility: 1.0 },
    toolAllow: ['read_file', 'glob', 'grep', 'edit_file', 'write_file', 'apply_patch', 'read_blob'],
    instruction: '编写模块化、高内聚的生产级代码修改，保持既有接口与风格一致。',
  },
  verification: {
    id: 'verification',
    label: '测试验证与诊断修复',
    defaultMaxSteps: 10,
    readOnly: false,
    weights: { coding: 0.8, reasoning: 0.8, research: 0.5, planning: 0.3, speed: 0.6, contextCapacity: 0.5, multimodal: 0.1, toolCompatibility: 1.0 },
    toolAllow: ['read_file', 'glob', 'grep', 'bash', 'read_process_output', 'read_blob'],
    instruction: '运行真实测试/编译检查并以可观测退出码与输出作为客观验证证据。',
  },
  planning: {
    id: 'planning',
    label: '架构规划与依赖拆解',
    defaultMaxSteps: 6,
    readOnly: true,
    weights: { coding: 0.25, reasoning: 1.4, research: 0.4, planning: 1.4, speed: 0.15, contextCapacity: 0.35, multimodal: 0.05, toolCompatibility: 0.4 },
    toolAllow: ['read_file', 'glob', 'grep', 'update_plan', 'search_history'],
    instruction: '分析系统边界、状态流与模块依赖，产出无环可执行步骤与清晰验收标准。',
  },
  review: {
    id: 'review',
    label: '安全审计与质量复核',
    defaultMaxSteps: 8,
    readOnly: true,
    weights: { coding: 0.8, reasoning: 0.9, research: 0.7, planning: 0.4, speed: 0.5, contextCapacity: 0.8, multimodal: 0.1, toolCompatibility: 0.7 },
    toolAllow: ['read_file', 'glob', 'grep', 'read_blob'],
    instruction: '独立核对实现边界、回归风险、错误处理与权限安全，禁止直接篡改产物。',
  },
});

export function scoreModelCapabilities(
  modelId,
  { preset = 'pool', profile = null, healthy = true } = {},
) {
  const id = String(modelId || '').toLowerCase();
  const caps = profile?.capabilities ?? {};
  const ctxWin = Number(profile?.contextWindow ?? 128000);
  const multiplier = Number(profile?.multiplier ?? 1.0);

  let coding = 0.72;
  let reasoning = caps.reasoning ? 0.88 : 0.7;
  let research = 0.74;
  let planning = 0.72;
  let speed = 0.65;
  const contextCapacity = Math.min(1, Math.max(0.2, ctxWin / 200000));
  const multimodal =
    caps.vision === true || /gpt-4o|gpt-4\.1|gpt-5|gemini|claude-3|claude-sonnet-4|claude-opus|qwen-vl/i.test(id)
      ? 1.0
      : 0.0;
  const toolCompatibility = caps.tools === false ? 0.15 : 0.95;

  if (/codex|sonnet|opus|deepseek-chat|deepseek-v3|qwen.*coder|gpt-5|gpt-4\.1/i.test(id)) {
    coding = 0.92;
    research = 0.84;
  }
  if (/r1|reasoner|o1|o3|o4|thinking|opus/i.test(id)) {
    reasoning = 0.96;
    planning = 0.92;
    speed = 0.42;
  }
  if (/flash|mini|haiku|nano|lite/i.test(id)) {
    speed = 0.95;
    coding = Math.min(coding, 0.76);
  }
  if (/gemini.*pro|claude|opus|gpt-5/i.test(id)) {
    planning = Math.max(planning, 0.88);
    research = Math.max(research, 0.86);
  }

  return {
    model: modelId,
    provider: preset || 'pool',
    healthy,
    costWeight: Math.max(0.1, multiplier),
    contextWindow: ctxWin,
    maxOutput: Number(profile?.maxOutput ?? 16384),
    capabilities: {
      coding,
      reasoning,
      research,
      planning,
      speed,
      contextCapacity,
      multimodal: multimodal > 0 ? 1 : 0,
      toolCompatibility,
    },
  };
}

/**
 * Layer 6 ModelCapabilityRegistry synced live from AccountPool catalog & health state.
 */
export class ModelCapabilityRegistry {
  constructor(pool) {
    this.pool = pool;
    this.entries = new Map();
  }

  syncFromPool() {
    this.entries.clear();
    const accounts =
      typeof this.pool?.listAccounts === 'function'
        ? this.pool.listAccounts({ enabled: true })
        : [];
    const accountByPreset = new Map();
    const now = Date.now();
    for (const acc of accounts) {
      const ok = (!acc.cooldownUntil || acc.cooldownUntil <= now) && acc.status !== 'disabled';
      const cur = accountByPreset.get(acc.preset) ?? false;
      accountByPreset.set(acc.preset, cur || ok);
    }

    const catalog =
      typeof this.pool?.getActiveCatalog === 'function'
        ? this.pool.getActiveCatalog()
        : null;
    if (catalog?.items?.length) {
      for (const item of catalog.items) {
        const alias = item.alias || item.id;
        if (!alias) continue;
        const targets = Array.isArray(item.targets) ? item.targets : [];
        const provider = targets[0]?.provider || 'pool';
        const profile = catalog.profiles?.[alias] ?? null;
        const healthy = targets.length
          ? targets.some((t) => accountByPreset.get(t.provider) ?? true)
          : true;
        this.entries.set(alias, scoreModelCapabilities(alias, { preset: provider, profile, healthy }));
      }
    }

    // Legacy providers compatibility fallback
    for (const m of this.pool?.legacyProviders?.models ?? []) {
      if (!m?.model || this.entries.has(m.model)) continue;
      this.entries.set(
        m.model,
        scoreModelCapabilities(m.model, {
          preset: m.provider || 'pool',
          profile: {
            contextWindow: m.context ?? 128000,
            capabilities: { tools: m.tools !== false, reasoning: (m.math ?? 0) >= 0.85 },
          },
          healthy: true,
        }),
      );
    }

    const def = this.pool?.getDefaultModel?.();
    if (def && !this.entries.has(def)) {
      this.entries.set(
        def,
        scoreModelCapabilities(def, {
          preset: 'pool',
          profile: { contextWindow: this.pool.getModelContextWindow?.(def) ?? 128000 },
          healthy: true,
        }),
      );
    }

    return [...this.entries.values()];
  }

  list() {
    if (!this.entries.size) this.syncFromPool();
    return [...this.entries.values()];
  }

  get(model) {
    if (!this.entries.size) this.syncFromPool();
    return this.entries.get(model) ?? null;
  }
}

/**
 * Layer 6 AgentCapabilityRegistry dynamically synthesizing tailored Agent Profiles
 * from task characteristics rather than forcing fixed worker roles.
 */
export class AgentCapabilityRegistry {
  constructor() {
    this.archetypes = new Map(Object.entries(BASE_CAPABILITIES));
  }

  registerCapability(spec) {
    if (!spec?.id) throw new Error('Capability archetype requires id');
    this.archetypes.set(spec.id, { ...spec });
    return this.archetypes.get(spec.id);
  }

  listCapabilities() {
    return [...this.archetypes.values()];
  }

  synthesizeProfile({
    taskType = '',
    objective = '',
    requiredTools = null,
    readOnly = undefined,
    maxSteps = undefined,
  } = {}) {
    const hint = `${taskType} ${objective}`.toLowerCase();
    let baseKey = 'research';
    if (this.archetypes.has(taskType)) {
      baseKey = taskType;
    } else if (/test|verify|check|build|benchmark|测试|验证|编译|运行/i.test(hint)) {
      baseKey = 'verification';
    } else if (/review|audit|inspect|security|审计|审查|复核/i.test(hint)) {
      baseKey = 'review';
    } else if (/plan|design|architect|decompose|规划|设计|拆解/i.test(hint)) {
      baseKey = 'planning';
    } else if (/implement|edit|write|fix|refactor|create|实现|修改|编写|重构|新增/i.test(hint)) {
      baseKey = 'implementation';
    }

    const base = this.archetypes.get(baseKey);
    const effectiveTools = Array.isArray(requiredTools) && requiredTools.length
      ? [...new Set(requiredTools)]
      : [...base.toolAllow];
    const isReadOnly =
      readOnly !== undefined
        ? Boolean(readOnly)
        : !effectiveTools.some((t) =>
            ['edit_file', 'write_file', 'apply_patch', 'bash', 'start_process', 'kill_process'].includes(t),
          );

    return {
      id: `dynamic:${baseKey}`,
      archetype: baseKey,
      name: base.label,
      readOnly: isReadOnly,
      defaultMaxSteps: maxSteps ?? base.defaultMaxSteps,
      weights: { ...base.weights },
      toolAllow: effectiveTools,
      staticSystemInstruction: base.instruction,
    };
  }
}
